// The scan itself, against a browser it is handed (Cloudflare Browser Rendering in production, a mock in tests):
// three views in parallel (desktop light, phone light, phone dark), the visual checks and a screenshot in each, then
// the side-effect-free race probe on the desktop page with the GenClass runtime in observe mode, then the same probe
// again in a fresh page with the runtime in guard mode. A hard total budget (45 s by default) bounds all of it; a
// step that does not fit is skipped and says so.
//
// The visual checks are the GenClass runtime's own visual chunk (src/visual.ts), run in each view; with
// WITH_GENCLASS on, the same chunk runs in guard mode with its opt-in fixes, and a second, report-only set of the
// checks re-measures the page with the fixes in place: a finding counts as fixed only when that re-check no longer
// finds it. The fixes are undone before the screenshot and before the race probe.
//
// Every hostname the page requests is checked in DNS before the browser loads it. A scan is thrown away, with nothing
// saved or streamed, when a response is seen to come from a private or reserved address (where the browser reports
// one: in Browser Rendering it connects through a local proxy, so it reports the proxy), when a WebSocket host
// resolves privately, when the page ended up on a site that opted out, or when the person who asked went away.

import { sanitizeFinding, sanitizeStats, type RawFinding } from "./catalog.ts";
import { decideRequest, latencySequence, type Phase, type PolicyContext } from "./policy.ts";
import { probeTargets, runtimeBootstrap, runtimeStateSource } from "./probe.ts";
import { blockedAddress, type Target } from "./target.ts";
import { callSource, FIX_KINDS, installSource, PERIODIC_KINDS, visualKey } from "./visual.ts";

// ------------------------------------------------------------------------------- the browser we drive

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface RequestLike {
  url(): string;
  method(): string;
  resourceType(): string;
  isNavigationRequest(): boolean;
  frame(): unknown;
  postData?(): string | undefined;
  failure?(): { errorText: string } | null;
  continue(overrides?: unknown, priority?: number): Promise<void>;
  abort(errorCode?: string, priority?: number): Promise<void>;
  respond(response: { status: number; headers?: Record<string, string>; contentType?: string; body?: string }, priority?: number): Promise<void>;
  isInterceptResolutionHandled?(): boolean;
}
export interface ResponseLike {
  status(): number;
  url(): string;
  request(): RequestLike;
  /** The address the browser connected to (absent for answers the scanner gave itself or served from memory). */
  remoteAddress?(): { ip?: string; port?: number };
}
export interface PageLike {
  setViewport(v: { width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean }): Promise<void>;
  setUserAgent(ua: string): Promise<void>;
  emulateMediaFeatures(f: { name: string; value: string }[]): Promise<void>;
  setBypassCSP(on: boolean): Promise<void>;
  setRequestInterception(on: boolean): Promise<void>;
  /** Requests go to the network (and through the request checks), never to a service worker. */
  setBypassServiceWorker?(on: boolean): Promise<void>;
  evaluateOnNewDocument(source: string): Promise<unknown>;
  evaluate(source: string): Promise<unknown>;
  on(event: string, handler: (arg: any) => void): unknown;
  goto(url: string, o: { waitUntil: string; timeout: number }): Promise<ResponseLike | null>;
  screenshot(o: Record<string, unknown>): Promise<Uint8Array>;
  /** Puppeteer's frame; its isolatedRealm() (when present) runs the scanner's DOM code apart from the page's scripts. */
  mainFrame(): unknown;
  url(): string;
  mouse: {
    click(x: number, y: number, o?: { count?: number; delay?: number }): Promise<void>;
    move(x: number, y: number): Promise<void>;
    wheel(o: { deltaX?: number; deltaY?: number }): Promise<void>;
  };
  keyboard: { type(text: string, o?: { delay?: number }): Promise<void>; press(key: string): Promise<void> };
  close(): Promise<void>;
}
export interface BrowserLike {
  newPage(): Promise<PageLike>;
  /**
   * A page in a window of its own. In one window only the front tab is visible, and a hidden tab defers the visual
   * checks (they run while the page is visible, as for a visitor) and changes how the runtime holds decisions, so
   * every view gets its own window when the browser offers this.
   */
  newWindowPage?(): Promise<PageLike>;
  version(): Promise<string>;
  close(): Promise<void>;
}

export type HostAnswer = "ok" | "private" | "nxdomain" | "unknown";

/** At most this many distinct hostnames are looked up for one scan; requests to more are not loaded. */
const MAX_HOSTS = 150;
/** Why a request was not loaded when its name has no address (a visitor's browser fails it too). */
const NXDOMAIN = "a host that does not resolve";
/**
 * How long the visual checks run in each view, from the start of the checks: the first pass, two periodic reads 2 s
 * apart (pointer-events and scroll locks are judged over 1 s), and page-blank's window of 3 s plus 2 s.
 */
const VISUAL_MS = 6000;
/** Time the views leave for the race probe and the guard pass after them (the views run in parallel, so all wait). */
const RESERVE_AFTER_VIEWS = 18_000;

/** What the visual checks' collect command returns (visual/scan-entry.js). */
interface Collected {
  ok?: boolean;
  findings?: unknown;
  skipped?: number;
  stats?: { passes?: number; [k: string]: unknown };
}

/** Findings from the page, validated (sanitizeFinding), at most 40. */
const cleanFindings = (v: unknown): RawFinding[] => (Array.isArray(v) ? v.slice(0, 40).map(sanitizeFinding).filter((f): f is RawFinding => f !== null) : []);

/** The answer to a navigation check: allowed, or refused with the code and message the person sees. */
export type NavVerdict = { ok: true } | { ok: false; code: string; message: string };

export interface ScanDeps {
  launch(): Promise<BrowserLike>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** DNS over HTTPS for a hostname the page requests: "ok" (public addresses only), "private", "nxdomain" (no address),
   * or "unknown" (the lookup failed). */
  resolveHost(host: string): Promise<HostAnswer>;
  /**
   * The full check for a main-frame navigation to a URL other than the one asked for (a redirect, or a script that
   * changes location while the page loads): not genclass.dev, not opted out, public in DNS, allowed by robots.txt.
   */
  navigationAllowed(url: string): Promise<NavVerdict>;
  /** Aborted when the person who asked for the scan goes away: the scan stops at once and nothing is saved. */
  signal?: AbortSignal;
  /** A random name for the scanner's page-side functions (tests pass a fixed one). */
  pageName?: string;
  /** The @genclass/runtime script-tag build, or null when it could not be fetched. */
  runtimeSource: Promise<string | null>;
  /** The GenClass visual checks (src/visual-source.ts, built from wave2/visual on CI), or null when not built in. */
  visualSource: string | null;
  /** Run the visual checks in guard mode with the chunk's opt-in fixes, then re-check (WITH_GENCLASS on). */
  visualFixes?: boolean;
  modelBaseUrl: string;
  runtimeVersion: string;
  progress(step: string, detail?: Record<string, unknown>): void;
  budgetMs?: number;
  /** policy.holdBudgetMs for the guard pass. */
  guardHoldMs?: number;
  /** The guard pass's aggressiveness: "balanced" is the runtime's shipped default. */
  guardAggressiveness?: "cautious" | "balanced" | "eager";
  /** policy.thresholds.guard for the guard pass (a gain margin); unset means the model's shipped gates. */
  guardMargin?: number | null;
}

// ------------------------------------------------------------------------------------------ the views

export interface ViewSpec {
  id: "desktop" | "phone" | "phone-dark";
  label: string;
  width: number;
  height: number;
  mobile: boolean;
  scheme: "light" | "dark";
  captureHeight: number;
}

export const VIEWS: ViewSpec[] = [
  { id: "desktop", label: "Desktop, 1366 × 768, light", width: 1366, height: 768, mobile: false, scheme: "light", captureHeight: 2304 },
  { id: "phone", label: "Phone, 390 × 844, light", width: 390, height: 844, mobile: true, scheme: "light", captureHeight: 2532 },
  { id: "phone-dark", label: "Phone, 390 × 844, dark", width: 390, height: 844, mobile: true, scheme: "dark", captureHeight: 2532 },
];

export const UA_TOKEN = "GenClassScan/1.0 (+https://genclass.dev/scan)";
export function userAgent(chromeMajor: string, mobile: boolean): string {
  return mobile
    ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Mobile Safari/537.36 ${UA_TOKEN}`
    : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36 ${UA_TOKEN}`;
}

/**
 * Runs before any page script in every frame of every view:
 * - no service workers (every request goes through the request checks);
 * - no new windows: window.open returns null, and forms and links that would open another window or tab are pointed
 *   at the page itself (a new window is a browser target the request checks do not cover);
 * - WebSocket connections to IP addresses and local names are refused, the hosts of the others are kept for a DNS
 *   check, and messages are held while the probe types and clicks;
 * - Content-Security-Policy violations are recorded as plain data for the visual checks' csp-blocked kind (the checks
 *   start after load, when the browser no longer reports earlier violations).
 * The switch and the host list live in this closure, reached through window[name] (non-writable), not on window.
 */
export function safetyBootstrap(name = "__gcScanSafety"): string {
  return `(function(){
  var held = false, hosts = [], csp = [], J = JSON.stringify;
  var LOCAL = /(^|\\.)(localhost|local|internal|test|example|invalid|onion|arpa|home|lan|corp|intranet|private|localdomain)$/;
  try {
    document.addEventListener("securitypolicyviolation", function (e) {
      if (csp.length < 50) csp.push({ disposition: String(e.disposition || ""), effectiveDirective: String(e.effectiveDirective || ""), violatedDirective: String(e.violatedDirective || ""), blockedURI: String(e.blockedURI || "").slice(0, 300), sourceFile: String(e.sourceFile || "").slice(0, 300) });
    }, true);
  } catch (e) {}
  try { if (navigator.serviceWorker) navigator.serviceWorker.register = function () { return Promise.reject(new Error("Service workers are off while GenClassScan loads this page")); }; } catch (e) {}
  try { window.open = function () { return null; }; } catch (e) {}
  var selfTarget = function (t) { t = String(t || "").trim().toLowerCase(); return t === "" || t === "_self" || t === "_top" || t === "_parent"; };
  var baseTarget = function () { try { var b = document.querySelector("base[target]"); return b ? b.getAttribute("target") : ""; } catch (e) { return ""; } };
  try {
    window.addEventListener("submit", function (e) {
      var f = e.target, s = e.submitter;
      if (s && s.hasAttribute && s.hasAttribute("formtarget") && !selfTarget(s.getAttribute("formtarget"))) s.setAttribute("formtarget", "_self");
      if (f && f.getAttribute && !selfTarget(f.getAttribute("target") || baseTarget())) f.setAttribute("target", "_self");
    }, true);
    window.addEventListener("click", function (e) {
      var t = e.composedPath ? e.composedPath()[0] : e.target;
      var a = t && t.closest ? t.closest("a[href], area[href]") : null;
      if (a && !selfTarget(a.getAttribute("target") || baseTarget())) a.setAttribute("target", "_self");
    }, true);
    var submit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () { if (!selfTarget(this.getAttribute("target") || baseTarget())) this.setAttribute("target", "_self"); return submit.apply(this, arguments); };
  } catch (e) {}
  try {
    var WS = window.WebSocket, send = WS.prototype.send;
    WS.prototype.send = function () { if (held) return; return send.apply(this, arguments); };
    var Scanned = function WebSocket(url, protocols) {
      var h = "";
      try { h = new URL(String(url), location.href).hostname.toLowerCase().replace(/\\.$/, ""); } catch (e) { h = ""; }
      if (!h || h.charAt(0) === "[" || /^[0-9.]+$/.test(h) || LOCAL.test(h)) throw new DOMException("GenClassScan does not open WebSocket connections to IP addresses or local names", "SecurityError");
      if (hosts.indexOf(h) < 0 && hosts.length < 20) hosts.push(h);
      return arguments.length > 1 ? new WS(url, protocols) : new WS(url);
    };
    Scanned.prototype = WS.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) { try { Scanned[k] = WS[k]; } catch (e) {} });
    window.WebSocket = Scanned;
  } catch (e) {}
  try {
    Object.defineProperty(window, ${JSON.stringify(name)}, { writable: false, configurable: false, enumerable: false, value: function (cmd, v) {
      if (cmd === "hold") held = !!v;
      return J({ held: held, wsHosts: hosts, csp: csp });
    } });
  } catch (e) {}
})();`;
}
export const SAFETY_BOOTSTRAP = safetyBootstrap();

// -------------------------------------------------------------------------------------------- results

export interface NetEntry {
  method: string;
  url: string;
  type: string;
  phase: Phase;
  at: number;
  delayMs?: number;
  reason?: string;
  body?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface ViewResult {
  id: ViewSpec["id"];
  label: string;
  width: number;
  height: number;
  ok: boolean;
  status: number | null;
  finalUrl: string;
  ms: number;
  notes: string[];
  findings: RawFinding[];
  checks: {
    viewport?: number[]; viewportMeta?: boolean; docHeight?: number; docWidth?: number; ms?: number;
    passes?: number; elements?: number; partial?: number; abstained?: number; skipped?: number;
  } | null;
  /** What GenClass's visual fixes did in this view (null: they were off, or nothing they fix was found). */
  fixes: VisualFixes | null;
  shot: Uint8Array | null;
  shotHeight: number;
  error?: string;
  /** Requests other than GET the page sent while loading, which the scanner answered itself with a stand-in reply. */
  standIns: { count: number; requests: string[] };
}

/** The with-GenClass pass of one view: what the chunk's fixes did, measured by a report-only re-check. */
export interface VisualFixes {
  /** Fixes the chunk applied in this view (guard mode, visual: { fix: true }). */
  applied: number;
  /** A second, report-only set of the checks ran with the fixes in place. */
  rechecked: boolean;
  /** Findings the re-check no longer found: fixed in the page by GenClass. */
  fixed: { kind: string; selector: string; key: string; how: string }[];
  /** Findings of a kind GenClass can fix that it did not fix in this view, and why. */
  notFixed: { kind: string; selector: string; key: string; why: string }[];
}

export interface ProbeResult {
  mode: "observe" | "guard";
  ran: boolean;
  note?: string;
  model: { state: string; device: string | null; variant: string | null; loadMs: number | null; waitedMs: number; error: string | null; version: string | null };
  runtimeError: string | null;
  holdBudgetMs: number | null;
  visibility: string | null;
  typed: { target: string; values: string[]; requests: number; completionOrder: number[]; outOfOrder: boolean } | null;
  typeSkipped?: string;
  clicked: { target: string; label: string; formMethod: string; sent: number; identical: number; requests: { method: string; path: string }[] } | null;
  clickSkipped?: string;
  detections: {
    id: string; trigger: string; subject: string; diagnosis: string; p: number; action: string; ran: string; executed: boolean; latencyMs: number;
    reason?: string | null; gateKind?: string | null; gain?: number | null; margin?: number | null; mass?: number | null; threshold?: number | null; candidate?: string | null;
  }[];
  acts: { id: string; decisionId: string; action: string; trigger: string; subject: string; ok: boolean; changed: string; late: boolean }[];
  /** How many decisions the runtime made on this page (detections are the ones that diagnosed something). */
  decisions: number;
  /** Stand-in answers the page got for its own requests other than GET while it loaded. */
  loadStandIns: number;
  aborted: number;
  answeredLocally: number;
  ms: number;
}

export interface ScanResult {
  views: ViewResult[];
  probe: ProbeResult | null;
  guard: ProbeResult | null;
  notes: string[];
  ms: { total: number; launch: number; views: number; probe: number; guard: number };
  chrome: string;
  timedOut: boolean;
}

// ------------------------------------------------------------------------------------------ utilities

class Deadline extends Error {}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (ms <= 0) {
      reject(new Deadline(`no time left for ${what}`));
      return;
    }
    const t = setTimeout(() => reject(new Deadline(`${what} took longer than ${Math.round(ms / 100) / 10} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

const pathOf = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`;
  } catch {
    return u.slice(0, 120);
  }
};

const parseJson = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return (v as T) ?? fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** Request bookkeeping for one page: what failed, what was answered locally, aborted or delayed. */
/** Downloads the scanner itself causes (the GenClass runtime, its model, onnxruntime-web): not the page's network. */
const OURS = /^https:\/\/(genclass\.dev\/model\/|cdn\.jsdelivr\.net\/npm\/(@genclass\/runtime@|onnxruntime-web@)|unpkg\.com\/@genclass\/runtime@)/;

class NetLog {
  /** Page requests in flight (not counting the scanner's own downloads). */
  inflight = new Set<object>();
  lastActivity = 0;
  answered: NetEntry[] = [];
  aborted: NetEntry[] = [];
  data: NetEntry[] = [];
  private open = new WeakMap<object, NetEntry>();
  track(req: RequestLike, e: NetEntry): void {
    this.data.push(e);
    this.open.set(req as object, e);
  }
  finish(req: RequestLike, at: number): void {
    const e = this.open.get(req as object);
    if (e) e.finishedAt = at;
    this.settle(req, at);
  }
  start(req: RequestLike, at: number): void {
    if (OURS.test(req.url())) return;
    this.inflight.add(req as object);
    this.lastActivity = at;
  }
  settle(req: RequestLike, at: number): void {
    if (this.inflight.delete(req as object)) this.lastActivity = at;
  }
}

// ------------------------------------------------------------------------------------------- the scan

type Stop = "stop" | "taint" | "cancel";

const DATA_FETCH = new Set(["fetch", "xhr"]);
const cutText = (v: unknown, n: number): string => {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.length > n ? s.slice(0, n) : s;
};
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function runScan(target: Target, deps: ScanDeps): Promise<ScanResult> {
  const t0 = deps.now();
  const budget = deps.budgetMs ?? 45_000;
  const deadline = t0 + budget;
  const left = () => deadline - deps.now();
  const result: ScanResult = {
    views: [],
    probe: null,
    guard: null,
    notes: [],
    ms: { total: 0, launch: 0, views: 0, probe: 0, guard: 0 },
    chrome: "",
    timedOut: false,
  };
  // the scanner's page-side functions live under names the page cannot guess
  const name = deps.pageName ?? `__gcs${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const N = { checks: `${name}c`, safety: `${name}s`, state: `${name}r` };
  const dnsCache = new Map<string, Promise<HostAnswer>>();
  dnsCache.set(target.host, Promise.resolve("ok")); // checked before the browser started
  const dns = (host: string): Promise<HostAnswer> => {
    const h = host.toLowerCase().replace(/\.+$/, "");
    let p = dnsCache.get(h);
    if (!p) {
      if (dnsCache.size >= MAX_HOSTS) return Promise.resolve("unknown");
      p = deps.resolveHost(h).catch(() => "unknown" as const);
      dnsCache.set(h, p);
    }
    return p;
  };
  const navCache = new Map<string, Promise<NavVerdict>>();
  const navOk = (url: string): Promise<NavVerdict> => {
    if (url === target.url) return Promise.resolve({ ok: true });
    let p = navCache.get(url);
    if (!p) {
      p = deps.navigationAllowed(url).catch(() => ({ ok: false, code: "redirect", message: "The page redirected to an address the scanner could not check." }));
      navCache.set(url, p);
    }
    return p;
  };
  /** Set when a response came from a private address: the scan is thrown away. */
  let taint: { url: string; ip: string } | null = null;
  /** Set when the page reached a site it must not load (opted out, robots.txt, genclass.dev) after it had loaded. */
  let discard: { code: string; message: string } | null = null;
  /** The first navigation refused during load: the message a failed view shows. */
  let refusal: { code: string; message: string } | null = null;

  deps.progress("browser");
  let browser: BrowserLike;
  try {
    browser = await withTimeout(deps.launch(), Math.min(12_000, left()), "starting the browser");
  } catch (e) {
    result.ms.launch = result.ms.total = deps.now() - t0;
    throw new ScanError("browser", e instanceof Error ? e.message : String(e));
  }
  result.ms.launch = deps.now() - t0;
  const pages: PageLike[] = [];
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  let stopNow: (why: Stop) => void = () => undefined;
  const stopped = new Promise<Stop>((resolve) => {
    stopNow = resolve;
    hardStop = setTimeout(() => resolve("stop"), Math.max(0, left()));
  });
  const onAbort = () => stopNow("cancel");
  if (deps.signal) {
    if (deps.signal.aborted) stopNow("cancel");
    else deps.signal.addEventListener("abort", onAbort, { once: true });
  }
  const markTaint = (url: string, ip: string) => {
    if (taint) return;
    taint = { url, ip };
    stopNow("taint");
  };

  const work = (async () => {
    const version = await browser.version().catch(() => "");
    result.chrome = version;
    const runtimeSrc = await withTimeout(deps.runtimeSource, Math.min(5000, left()), "loading the GenClass runtime").catch(() => null);
    if (!runtimeSrc) result.notes.push("The GenClass runtime script could not be fetched, so the race probe ran without GenClass.");

    // ------------------------------------------------------------------ views, in parallel
    const tViews = deps.now();
    deps.progress("views");
    const opened = await Promise.all(
      VIEWS.map((spec) =>
        openView(spec, spec.id === "desktop" && runtimeSrc ? { mode: "observe", source: runtimeSrc } : null, spec.id === "desktop").catch(
          (e): { view: ViewResult; page: null; ctx: null; net: null } => ({
            view: failedView(spec, e instanceof Error ? e.message : String(e)),
            page: null,
            ctx: null,
            net: null,
          }),
        ),
      ),
    );
    result.views = opened.map((o) => o.view);
    result.ms.views = deps.now() - tViews;
    if (discard) return;
    if (!result.views.some((v) => v.ok)) {
      const r = refusal as { code: string; message: string } | null; // set inside the request handlers
      if (r) throw new ScanError(r.code, r.message);
      throw new ScanError("load", result.views[0].error || "The page did not load.");
    }

    // ------------------------------------------------------------------ race probe (observe)
    const desk = opened[0];
    if (desk.page && desk.ctx && desk.net && desk.view.ok) {
      const tProbe = deps.now();
      deps.progress("probe");
      result.probe = await probe(desk.page, desk.ctx, desk.net, "observe", runtimeSrc !== null).catch((e) => skippedProbe("observe", e));
      result.ms.probe = deps.now() - tProbe;
      await desk.page.close().catch(() => undefined);
    } else {
      result.notes.push("The race probe did not run: the desktop view did not load.");
    }

    // ------------------------------------------------------------------ the same probe with GenClass guard
    if (runtimeSrc && result.probe && result.probe.ran && !discard) {
      if (left() < 11_000) {
        result.notes.push("The guard pass was skipped: not enough of the 45 s budget was left.");
      } else {
        const tGuard = deps.now();
        deps.progress("guard");
        try {
          const g = await openView(VIEWS[0], { mode: "guard", source: runtimeSrc }, true, true);
          if (g.page && g.ctx && g.net && g.view.ok) {
            const expect = { search: !!result.probe.typed, button: !!result.probe.clicked };
            result.guard = await probe(g.page, g.ctx, g.net, "guard", true, expect).catch((e) => skippedProbe("guard", e));
            await g.page.close().catch(() => undefined);
          } else result.notes.push(`The guard pass did not load the page: ${g.view.error || "unknown error"}.`);
        } catch (e) {
          result.notes.push(`The guard pass stopped: ${e instanceof Error ? e.message : String(e)}.`);
        }
        result.ms.guard = deps.now() - tGuard;
      }
    }
  })();

  let outcome: "done" | Stop;
  try {
    outcome = await Promise.race([work.then(() => "done" as const), stopped]);
    if (outcome !== "done") work.catch(() => undefined);
  } finally {
    clearTimeout(hardStop);
    deps.signal?.removeEventListener("abort", onAbort);
    for (const p of pages) await p.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    result.ms.total = deps.now() - t0;
  }
  // nothing from a scan that touched a private address, reached an opted-out site, or lost its requester is kept
  const t = taint as { url: string; ip: string } | null;
  if (t) {
    console.warn(`scan discarded: ${pathOf(t.url)} answered from ${t.ip}`);
    throw new ScanError("private", "Part of this page was served from a private or reserved network address, so the scanner threw the result away.");
  }
  const d = discard as { code: string; message: string } | null;
  if (d) throw new ScanError(d.code, d.message);
  if (outcome === "cancel") throw new ScanError("cancelled", "The scan was stopped because the page that asked for it closed.");
  if (outcome === "stop") {
    result.timedOut = true;
    result.notes.push(`The scan hit its ${Math.round(budget / 1000)} s budget; steps that had not finished are left out.`);
  }
  for (const v of result.views) if (!v.ok) v.shot = null;
  return result;

  // ======================================================================================== helpers

  function failedView(spec: ViewSpec, error: string): ViewResult {
    return {
      id: spec.id, label: spec.label, width: spec.width, height: spec.height, ok: false, status: null, finalUrl: target.url,
      ms: 0, notes: [], findings: [], checks: null, fixes: null, shot: null, shotHeight: 0, error, standIns: { count: 0, requests: [] },
    };
  }

  function skippedProbe(mode: "observe" | "guard", e: unknown): ProbeResult {
    return {
      mode, ran: false, note: e instanceof Error ? e.message : String(e),
      model: { state: "unknown", device: null, variant: null, loadMs: null, waitedMs: 0, error: null, version: null },
      runtimeError: null, holdBudgetMs: null, visibility: null, typed: null, clicked: null, detections: [], acts: [], decisions: 0, loadStandIns: 0, aborted: 0, answeredLocally: 0, ms: 0,
    };
  }

  /** The scanner's DOM code runs in Puppeteer's isolated world when there is one: the page's scripts cannot see it,
   * replace it or patch the built-ins it uses. Otherwise in the page, under the per-scan names. */
  function evalDom(page: PageLike, src: string): Promise<unknown> {
    const frame = page.mainFrame() as { isolatedRealm?: () => { evaluate(s: string): Promise<unknown> } } | null;
    const realm = frame && typeof frame.isolatedRealm === "function" ? frame.isolatedRealm() : null;
    return realm ? realm.evaluate(src) : page.evaluate(src);
  }

  /** WebSocket hosts the page opened: checked in DNS after the fact; a private answer throws the scan away. */
  async function checkSockets(page: PageLike): Promise<void> {
    const s = parseJson<{ wsHosts?: unknown }>(await page.evaluate(`(() => typeof window[${JSON.stringify(N.safety)}] === "function" ? window[${JSON.stringify(N.safety)}]("read") : "{}")()`).catch(() => "{}"), {});
    const hosts = Array.isArray(s.wsHosts) ? s.wsHosts.filter((h): h is string => typeof h === "string").slice(0, 20) : [];
    for (const h of hosts) if ((await dns(h)) === "private") markTaint(`wss://${h}/`, "a private address (DNS)");
  }

  async function hold(page: PageLike, on: boolean): Promise<void> {
    await page.evaluate(`(() => { const f = window[${JSON.stringify(N.safety)}]; if (typeof f === "function") f("hold", ${on}); })()`).catch(() => undefined);
  }

  async function openView(
    spec: ViewSpec,
    runtime: { mode: "observe" | "guard"; source: string } | null,
    keepOpen: boolean,
    skipChecks = false,
  ): Promise<{ view: ViewResult; page: PageLike | null; ctx: PolicyContext | null; net: NetLog | null }> {
    const tv = deps.now();
    const view = failedView(spec, "");
    delete view.error;
    const page = await withTimeout(browser.newWindowPage ? browser.newWindowPage() : browser.newPage(), Math.min(8000, left()), "opening a tab");
    pages.push(page);
    const net = new NetLog();
    const ctx: PolicyContext = { pageOrigin: "", phase: "load", latency: latencySequence(`${target.url}|${spec.id}`), answerDelayMs: 0 };
    let localN = 0;
    let refused: { code: string; message: string } | null = null;
    let unchecked = 0;
    /** Whether the browser reaches the network through a local proxy (its main document "came from" loopback): then
     * the address of a response is the proxy's and says nothing about the site. Unknown until the document arrives. */
    let proxied: boolean | null = null;
    await page.setViewport({ width: spec.width, height: spec.height, deviceScaleFactor: 1, isMobile: spec.mobile, hasTouch: spec.mobile });
    const major = (/(\d+)\./.exec(result.chrome) || [])[1] || "131";
    await page.setUserAgent(userAgent(major, spec.mobile));
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: spec.scheme }]);
    if (page.setBypassServiceWorker) await page.setBypassServiceWorker(true);
    await page.evaluateOnNewDocument(safetyBootstrap(N.safety));
    if (runtime) {
      await page.setBypassCSP(true);
      await page.evaluateOnNewDocument(
        runtimeBootstrap(
          {
            mode: runtime.mode,
            telemetry: false,
            report: "silent",
            model: { baseUrl: deps.modelBaseUrl, preload: "eager" },
            ...(runtime.mode === "guard" && deps.guardHoldMs
              ? { policy: { holdBudgetMs: deps.guardHoldMs, ...(typeof deps.guardMargin === "number" ? { thresholds: { guard: deps.guardMargin } } : {}) } }
              : {}),
            ...(runtime.mode === "guard" && deps.guardAggressiveness && deps.guardAggressiveness !== "balanced" ? { aggressiveness: deps.guardAggressiveness } : {}),
          },
          runtime.source,
          N.state,
        ),
      );
    }
    page.on("dialog", (d: { dismiss(): Promise<void> }) => void d.dismiss().catch(() => undefined));
    page.on("popup", (p: { close(): Promise<void> } | null) => void p?.close().catch(() => undefined));
    await page.setRequestInterception(true);
    page.on("request", (req: RequestLike) => {
      void (async () => {
        try {
          if (req.isInterceptResolutionHandled?.()) return;
          const facts = {
            url: req.url(),
            method: req.method(),
            resourceType: req.resourceType(),
            isNavigation: req.isNavigationRequest(),
            isMainFrame: req.frame() === page.mainFrame(),
          };
          const verdict = decideRequest(facts, ctx, localN + 1);
          const entry: NetEntry = { method: facts.method.toUpperCase(), url: facts.url, type: facts.resourceType, phase: ctx.phase, at: deps.now() - t0 };
          if (verdict.kind === "abort") {
            net.aborted.push({ ...entry, reason: verdict.reason });
            await req.abort("blockedbyclient");
            return;
          }
          if (verdict.kind === "fulfill") {
            localN++;
            let body: string | undefined;
            try {
              body = req.postData?.()?.slice(0, 2048);
            } catch {
              body = undefined;
            }
            net.answered.push({ ...entry, reason: verdict.reason, body });
            if (verdict.delayMs) await deps.sleep(verdict.delayMs);
            await req.respond({ status: verdict.status, headers: verdict.headers, body: verdict.body });
            return;
          }
          if (verdict.check !== "none") {
            let host = "";
            try {
              host = new URL(facts.url).hostname;
            } catch {
              host = "";
            }
            let why = "";
            if (verdict.check === "navigation") {
              const v = host ? await navOk(facts.url) : ({ ok: false, code: "redirect", message: "The page redirected to an address the scanner does not load." } as NavVerdict);
              if (!v.ok) {
                why = `navigation refused (${v.code})`;
                refused = refused ?? { code: v.code, message: v.message };
              }
            } else {
              const d = host ? await dns(host) : "unknown";
              if (d === "private") why = "a host that resolves to a private address";
              // the browser would have failed this one too: the visual checks see it fail as a visitor's browser would
              else if (d === "nxdomain") why = NXDOMAIN;
              else if (d === "unknown") {
                why = "a host the scanner could not look up";
                unchecked++;
              }
            }
            if (why) {
                net.aborted.push({ ...entry, reason: why });
              await req.abort("blockedbyclient");
              return;
            }
          }
          if (DATA_FETCH.has(facts.resourceType)) net.track(req, { ...entry, delayMs: verdict.delayMs, startedAt: deps.now() - t0 });
          net.start(req, deps.now());
          if (verdict.delayMs) await deps.sleep(verdict.delayMs);
          await req.continue();
        } catch {
          /* the page closed or the request was already handled */
        }
      })();
    });
    page.on("requestfinished", (req: RequestLike) => net.finish(req, deps.now() - t0));
    page.on("requestfailed", (req: RequestLike) => net.settle(req, deps.now()));
    page.on("response", (res: ResponseLike) => {
      try {
        // the browser resolves names itself: where it reports the address it connected to, that must be public too
        const ip = String(res.remoteAddress?.()?.ip || "").replace(/^\[|\]$/g, "");
        const req = res.request();
        if (proxied === null && req.frame() === page.mainFrame() && req.resourceType() === "document" && ip) proxied = blockedAddress(ip) === "loopback";
        if (ip && proxied === false) {
          const blocked = blockedAddress(ip);
          if (blocked && blocked !== "invalid") markTaint(res.url(), ip);
        }
      } catch {
        /* ignore */
      }
    });

    // navigate: 20 s cap, then wait for the network to go quiet (4 s cap)
    const reserve = runtime && runtime.mode === "observe" ? 16_000 : 6_000;
    const navMs = Math.min(20_000, left() - reserve);
    let res: ResponseLike | null = null;
    try {
      res = await page.goto(target.url, { waitUntil: "load", timeout: Math.max(3000, navMs) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const where = page.url();
      if (!/timeout/i.test(msg) || !where || where === "about:blank") {
        const r = refused as { code: string; message: string } | null;
        if (r) refusal = refusal ?? r;
        view.error = r
          ? r.message
          : /ERR_NAME_NOT_RESOLVED/.test(msg)
            ? "The hostname did not resolve."
            : /ERR_BLOCKED_BY_CLIENT/.test(msg)
              ? "The page redirected to an address the scanner does not load."
              : /timeout/i.test(msg)
                ? `The page did not respond within ${Math.round(navMs / 1000)} s.`
                : `The page could not be loaded (${msg.slice(0, 120)}).`;
        view.ms = deps.now() - tv;
        if (!keepOpen) await page.close().catch(() => undefined);
        return { view, page: keepOpen ? page : null, ctx, net };
      }
      view.notes.push(`The page had not finished loading after ${Math.round(navMs / 1000)} s; the checks ran on what had loaded.`);
    }
    view.status = res ? res.status() : null;
    view.finalUrl = page.url();
    try {
      ctx.pageOrigin = new URL(view.finalUrl).origin;
    } catch {
      ctx.pageOrigin = "";
    }
    // where the page ended up must pass the same checks as where it started (every hop was checked on the way)
    try {
      const finalUrl = new URL(view.finalUrl);
      if (finalUrl.hostname !== target.host && /^https?:$/.test(finalUrl.protocol)) {
        const v = await navOk(finalUrl.href);
        if (!v.ok) discard = discard ?? { code: v.code, message: v.message };
      }
    } catch {
      /* about:blank or unparseable: nothing loaded */
    }
    if (view.status !== null && view.status >= 400) view.notes.push(`The page answered HTTP ${view.status}.`);
    // network quiet: no page request in flight for 500 ms (the scanner's own runtime and model downloads do not count)
    {
      const quietBy = deps.now() + Math.max(500, Math.min(4000, left() - reserve));
      while (!(net.inflight.size === 0 && deps.now() - net.lastActivity >= 500) && deps.now() < quietBy) await deps.sleep(100);
      if (net.inflight.size > 0) view.notes.push("The network did not go quiet within 4 s (the page keeps requesting); the checks ran anyway.");
    }
    view.ok = true;
    if (unchecked) view.notes.push(`${unchecked} ${unchecked === 1 ? "request was" : "requests were"} not loaded because the scanner could not look up ${unchecked === 1 ? "its hostname" : "their hostnames"}; the checks ran without them.`);
    view.standIns = standInsOf(net);
    if (view.standIns.count) {
      const n = view.standIns.count;
      view.notes.push(
        `This page sent ${n} ${n === 1 ? "request" : "requests"} other than GET while loading (${view.standIns.requests.join(", ")}). ` +
          `The scanner answered ${n === 1 ? "it" : "them"} itself with a stand-in reply, so content that depends on ${n === 1 ? "it" : "them"} may be missing or wrong in this view.`,
      );
    }
    await checkSockets(page);

    if (!skipChecks && !discard) {
      deps.progress("checks", { view: spec.id });
      try {
        await visualChecks(page, view, net, spec.id === "desktop");
      } catch (e) {
        view.notes.push(`The visual checks did not finish: ${e instanceof Error ? e.message : String(e)}.`);
      }
      // a page without a viewport meta tag lays out wider than the phone (980 px) and is shown zoomed out
      const layoutW = Math.max(1, Math.min(4000, Math.round(Number(view.checks?.viewport?.[0]) || spec.width)));
      if (spec.mobile && view.checks && view.checks.viewportMeta === false && layoutW > spec.width && !view.findings.some((f) => f.kind === "viewport-meta-missing")) {
        view.notes.push(`The page has no viewport meta tag, so a phone shows it zoomed out: laid out ${layoutW} px wide on a ${spec.width} px screen.`);
      }
      view.width = layoutW;
      try {
        const docH = Math.max(spec.height, Number(view.checks?.docHeight) || spec.height);
        const shotH = Math.min(docH, spec.captureHeight);
        const shot = await withTimeout(
          page.screenshot({ type: "jpeg", quality: 62, clip: { x: 0, y: 0, width: layoutW, height: shotH }, captureBeyondViewport: true }),
          Math.min(8000, left() - 2000),
          "the screenshot",
        );
        view.shot = shot;
        view.shotHeight = shotH;
      } catch (e) {
        view.notes.push(`No screenshot: ${e instanceof Error ? e.message : String(e)}.`);
      }
    }
    view.ms = deps.now() - tv;
    if (!keepOpen) {
      await page.close().catch(() => undefined);
      return { view, page: null, ctx: null, net: null };
    }
    return { view, page, ctx, net };
  }

  function standInsOf(net: NetLog): ViewResult["standIns"] {
    const list = net.answered.filter((e) => e.phase === "load" && e.method !== "OPTIONS" && DATA_FETCH.has(e.type));
    return { count: list.length, requests: [...new Set(list.map((e) => `${e.method} ${pathOf(e.url)}`))].slice(0, 3) };
  }

  /** Hosts whose files the scanner itself did not load while the page loaded (a lookup that failed, a private answer,
   * a blocked address): a visual finding about such a file says more about the scanner than about the site. A name
   * with no address at all is not among them: it fails in a visitor's browser too. */
  function scannerSkipped(net: NetLog): string[] {
    const hosts = new Set<string>();
    for (const e of net.aborted) {
      if (e.phase !== "load" || e.reason === NXDOMAIN) continue;
      try {
        hosts.add(new URL(e.url).hostname.toLowerCase());
      } catch {
        /* ignore */
      }
    }
    return [...hosts].slice(0, 100);
  }

  /**
   * The GenClass visual checks in one view (src/visual.ts). Engine "a" runs from network quiet: report-only, or with
   * WITH_GENCLASS on, in guard mode with the chunk's opt-in fixes. The scanner waits for its first pass, presses Tab
   * a few times on the desktop (focus checks), scrolls with the mouse wheel to the end of the page and once more
   * after the first periodic read (scroll locks, controls under fixed bars), and collects at VISUAL_MS with one more
   * pass at the top. When fixes were applied, engine "c" (report-only) re-measures the page with them in place.
   * Stopping "a" undoes every fix, before the screenshot and the race probe.
   */
  async function visualChecks(page: PageLike, view: ViewResult, net: NetLog, desktop: boolean): Promise<void> {
    if (!deps.visualSource) {
      view.notes.push("The visual checks are not built into this copy of the scanner.");
      return;
    }
    const call = async <T>(cmd: string, arg: Record<string, unknown> = {}, ms = 5000): Promise<T> =>
      parseJson<T>(await withTimeout(evalDom(page, callSource(N.checks, cmd, arg)), Math.min(ms, Math.max(500, left() - 1000)), `the visual checks (${cmd})`), {} as T);
    if ((await evalDom(page, installSource(N.checks, deps.visualSource))) !== true) throw new Error("the GenClass visual checks did not install");
    const safety = parseJson<{ csp?: unknown }>(
      await page.evaluate(`(() => typeof window[${JSON.stringify(N.safety)}] === "function" ? window[${JSON.stringify(N.safety)}]("read") : "{}")()`).catch(() => "{}"),
      {},
    );
    const csp = Array.isArray(safety.csp) ? safety.csp.slice(0, 50) : [];
    const skipHosts = scannerSkipped(net);
    const fix = deps.visualFixes === true;
    // what must stay for after the views: the race probe and the guard pass (the views run in parallel, so all wait)
    const reserve = RESERVE_AFTER_VIEWS;
    const started = await call<{ ok?: boolean; error?: string }>("start", { id: "a", mode: fix ? "guard" : "observe", fix, csp });
    if (!started.ok) throw new Error(cutText(started.error || "they did not start", 120));
    try {
      const t0 = deps.now();
      const end = Math.min(t0 + VISUAL_MS, deps.now() + Math.max(0, left() - reserve));
      await interact(page, call, "a", t0, end, desktop);
      while (deps.now() < end) await deps.sleep(Math.min(250, end - deps.now()));
      const top = await call<Record<string, unknown>>("top");
      const a = await call<Collected>("collect", { id: "a", pass: true, passMs: 2500, skipHosts }, 4000);
      view.findings = cleanFindings(a.findings);
      view.checks = sanitizeStats({ ...top, ...(a.stats ?? {}), skipped: a.skipped }) as ViewResult["checks"];
      const st = a.stats ?? {};
      if (Number(st.passes) > 0 && Number(st.partial) >= Number(st.passes)) view.notes.push("The visual checks ran out of their time budget on every pass in this view, so parts of the page were not checked.");
      if (a.skipped) view.notes.push(`${a.skipped} visual ${a.skipped === 1 ? "finding is" : "findings are"} left out: ${a.skipped === 1 ? "it is" : "they are"} about files the scanner did not load (their hosts could not be looked up or were refused).`);
      if (fix) view.fixes = await recheck(page, call, view.findings, skipHosts, reserve);
    } finally {
      await call("stop", { id: "a" }).catch(() => undefined); // undoes every fix this engine applied
    }
  }

  /** Waits for engine `id`'s first pass, then the focus and scroll steps of visualChecks (wheel only for `keys` false). */
  async function interact(page: PageLike, call: <T>(cmd: string, arg?: Record<string, unknown>, ms?: number) => Promise<T>, id: string, t0: number, end: number, keys: boolean): Promise<void> {
    for (;;) {
      const s = await call<{ stats?: { passes?: number } }>("status", { id });
      if ((s.stats?.passes ?? 0) >= 1 || deps.now() >= Math.min(end, t0 + 4000)) break;
      await deps.sleep(250);
    }
    if (keys) {
      for (let i = 0; i < 4 && deps.now() < end - 500; i++) {
        await page.keyboard.press("Tab").catch(() => undefined);
        await deps.sleep(250);
      }
    }
    const pt = await call<{ x?: unknown; y?: unknown }>("point");
    if (typeof pt.x !== "number" || typeof pt.y !== "number") return;
    await page.mouse.move(pt.x, pt.y).catch(() => undefined);
    for (let i = 0; i < 4 && deps.now() < end - 500; i++) {
      if ((await call<{ atEnd?: boolean }>("page")).atEnd) break;
      await page.mouse.wheel({ deltaY: 700 }).catch(() => undefined);
      await deps.sleep(300);
    }
    // after the first periodic read (2 s after the first pass): a scroll attempt while a lock is held is the evidence
    // scroll-lock-stuck needs; up when the page is at its end, down otherwise
    while (deps.now() < Math.min(end - 1500, t0 + 3200)) await deps.sleep(100);
    if (deps.now() < end - 1500) {
      const dy = (await call<{ atEnd?: boolean }>("page")).atEnd ? -400 : 400;
      for (let i = 0; i < 2; i++) {
        await page.mouse.wheel({ deltaY: dy }).catch(() => undefined);
        await deps.sleep(450);
      }
    }
  }

  /**
   * The with-GenClass re-check of one view: a second, report-only engine ("c") measures the page while engine "a"'s
   * fixes are in place. A finding counts as fixed only when "a" applied a fix for it, the fix still holds, and "c"
   * no longer finds it; "c" gets the same periodic reads when a fix was one of the periodic kinds.
   */
  async function recheck(page: PageLike, call: <T>(cmd: string, arg?: Record<string, unknown>, ms?: number) => Promise<T>, found: RawFinding[], skipHosts: string[], reserve: number): Promise<VisualFixes | null> {
    const fixable = found.filter((f) => FIX_KINDS.has(f.kind));
    if (!fixable.length) return null;
    const out: VisualFixes = { applied: fixable.filter((f) => f.detail?.fixApplied === true).length, rechecked: false, fixed: [], notFixed: [] };
    let after = fixable;
    let still: Set<string> | null = null;
    if (out.applied && left() - reserve > 2500) {
      const started = await call<{ ok?: boolean }>("start", { id: "c", mode: "observe", fix: false });
      if (started.ok) {
        try {
          const t0 = deps.now();
          const periodic = fixable.some((f) => f.detail?.fixApplied === true && PERIODIC_KINDS.has(f.kind));
          const end = Math.min(t0 + (periodic ? VISUAL_MS : 1500), deps.now() + Math.max(0, left() - reserve));
          if (periodic) await interact(page, call, "c", t0, end, false);
          while (deps.now() < end) await deps.sleep(Math.min(250, end - deps.now()));
          await call("top");
          const c = await call<Collected>("collect", { id: "c", pass: true, passMs: 2500, skipHosts }, 4000);
          const a = await call<Collected>("collect", { id: "a", skipHosts });
          if (c.ok && (c.stats?.passes ?? 0) >= 1) {
            still = new Set(cleanFindings(c.findings).map(visualKey));
            out.rechecked = true;
          }
          if (a.ok) after = cleanFindings(a.findings).filter((f) => FIX_KINDS.has(f.kind));
        } finally {
          await call("stop", { id: "c" }).catch(() => undefined);
        }
      }
    }
    for (const f of after) {
      const key = visualKey(f);
      const applied = f.detail?.fixApplied === true;
      const css = cutText(f.detail?.fixCss, 160);
      if (applied && still && !still.has(key)) out.fixed.push({ kind: f.kind, selector: f.selector, key, how: `GenClass changed the page: ${css || "its fix for this kind"}. The re-check no longer found it.` });
      else
        out.notFixed.push({
          kind: f.kind,
          selector: f.selector,
          key,
          why: applied
            ? still
              ? "GenClass applied a fix, but the re-check still found the problem."
              : "GenClass applied a fix, but there was no time left to re-check it, so it is not counted."
            : cutText(f.detail?.fixReason, 200) || "GenClass did not apply a fix here.",
        });
    }
    return out;
  }

  async function probe(
    page: PageLike,
    ctx: PolicyContext,
    net: NetLog,
    mode: "observe" | "guard",
    withRuntime: boolean,
    expect: { search: boolean; button: boolean } = { search: false, button: false },
  ): Promise<ProbeResult> {
    const tp = deps.now();
    const out = skippedProbe(mode, "");
    delete out.note;
    out.ran = true;
    type RawState = {
      present?: boolean; error?: unknown; holdBudgetMs?: unknown; visibility?: unknown; decisions?: unknown;
      status?: { state?: unknown; device?: unknown; variant?: unknown; loadMs?: unknown; error?: unknown; version?: unknown } | null;
      detections?: unknown; acts?: unknown;
    };
    const state = async () => parseJson<RawState>(await page.evaluate(runtimeStateSource(N.state)), { present: false, error: "unreadable" });

    // wait for the model, leaving room for the actions (and, in observe, for the guard pass after it)
    if (withRuntime) {
      const reserve = mode === "observe" ? 17_000 : 6_500;
      const waitStart = deps.now();
      let s = await state();
      const settled = new Set(["ready", "error", "skipped", "disabled", "unloaded"]);
      while (s.present && s.status && !settled.has(String(s.status.state)) && left() > reserve) {
        await deps.sleep(400);
        s = await state();
      }
      out.model = {
        state: s.status?.state ? cutText(s.status.state, 40) : s.present ? "unknown" : "absent",
        device: s.status?.device ? cutText(s.status.device, 20) : null,
        variant: s.status?.variant ? cutText(s.status.variant, 20) : null,
        loadMs: numOrNull(s.status?.loadMs),
        waitedMs: deps.now() - waitStart,
        error: s.status?.error ? cutText(s.status.error, 200) : null,
        version: s.status?.version ? cutText(s.status.version, 40) : null,
      };
      out.runtimeError = s.error ? cutText(s.error, 200) : null;
      out.visibility = s.visibility ? cutText(s.visibility, 20) : null;
    } else {
      out.model.state = "absent";
    }

    type Targets = { search: { selector: string; at: { x: number; y: number } } | null; button: { selector: string; label: string; method: string; at: { x: number; y: number } } | null };
    const find = async () => parseJson<Targets>(await evalDom(page, `JSON.stringify((${probeTargets.toString()})({ prepare: true }))`), { search: null, button: null });
    let targets = await find();
    // the guard pass looks for what the observe pass used; a page that hydrates late gets up to 2.5 s to show it
    for (let waited = 0; waited < 2500 && left() > 6000 && ((expect.search && !targets.search) || (expect.button && !targets.button)); waited += 300) {
      await deps.sleep(300);
      targets = await find();
    }

    // 1. type quickly into the first search-like input: "a", "ab", "abc", 80 ms apart
    if (targets.search && left() > 4000) {
      const at = parseJson<{ search: { at: { x: number; y: number } } | null }>(
        await evalDom(page, `JSON.stringify((${probeTargets.toString()})({ scrollTo: "search" }))`),
        { search: null },
      ).search?.at;
      if (at) {
        ctx.phase = "type";
        await hold(page, true);
        const from = net.data.length;
        await page.mouse.click(at.x, at.y);
        await page.keyboard.type("abc", { delay: 80 });
        await deps.sleep(Math.min(2200, Math.max(0, left() - 2500)));
        const reqs = net.data.slice(from).filter((e) => e.phase === "type");
        const finished = reqs.map((e, i) => ({ i: i + 1, f: e.finishedAt ?? Number.POSITIVE_INFINITY })).sort((a, b) => a.f - b.f);
        out.typed = {
          target: cutText(targets.search.selector, 200),
          values: ["a", "ab", "abc"],
          requests: reqs.length,
          completionOrder: finished.filter((x) => Number.isFinite(x.f)).map((x) => x.i),
          outOfOrder: finished.some((x, k) => k > 0 && Number.isFinite(x.f) && x.i < finished[k - 1].i),
        };
      } else out.typeSkipped = "The search box could not be scrolled into view.";
    } else out.typeSkipped = targets.search ? "Skipped: not enough time left." : "No search box on the page.";

    // 2. double-click the most prominent submit button of a form that would POST (answered locally)
    if (targets.button && left() > 3500) {
      const at = parseJson<{ button: { at: { x: number; y: number } } | null }>(
        await evalDom(page, `JSON.stringify((${probeTargets.toString()})({ scrollTo: "button" }))`),
        { button: null },
      ).button?.at;
      if (at) {
        ctx.phase = "click";
        ctx.answerDelayMs = 400;
        await hold(page, true);
        const from = net.answered.length;
        await page.mouse.click(at.x, at.y, { count: 2, delay: 40 });
        await deps.sleep(Math.min(2500, Math.max(0, left() - 1500)));
        const sent = net.answered.slice(from).filter((e) => e.phase === "click" && e.method !== "OPTIONS");
        const groups = new Map<string, number>();
        for (const e of sent) {
          const k = `${e.method} ${e.url} ${e.body ?? ""}`;
          groups.set(k, (groups.get(k) || 0) + 1);
        }
        out.clicked = {
          target: cutText(targets.button.selector, 200),
          label: cutText(targets.button.label, 60),
          formMethod: cutText(targets.button.method, 20),
          sent: sent.length,
          identical: Math.max(0, ...groups.values()),
          requests: sent.slice(0, 6).map((e) => ({ method: e.method, path: pathOf(e.url) })),
        };
      } else out.clickSkipped = "The button could not be scrolled into view.";
    } else out.clickSkipped = targets.button ? "Skipped: not enough time left." : "No form on the page whose submit would POST.";

    ctx.phase = "settle";
    if (withRuntime) {
      const s = await state();
      out.detections = (Array.isArray(s.detections) ? s.detections.slice(0, 50) : []).map(cleanDetection);
      out.acts = (Array.isArray(s.acts) ? s.acts.slice(0, 50) : []).map(cleanAct);
      out.holdBudgetMs = numOrNull(s.holdBudgetMs);
      out.decisions = Math.max(0, Math.round(numOrNull(s.decisions) ?? 0));
    }
    await checkSockets(page);
    out.loadStandIns = standInsOf(net).count;
    out.aborted = net.aborted.filter((e) => e.phase !== "load").length;
    out.answeredLocally = net.answered.length;
    out.ms = deps.now() - tp;
    return out;
  }
}

/** A GenClass detection read back from the page, with only the fields the report uses, cut to size. */
function cleanDetection(v: unknown): ProbeResult["detections"][number] {
  const d = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const opt = (x: unknown, n: number) => (x == null || x === "" ? null : cutText(x, n));
  return {
    id: cutText(d.id, 40), trigger: cutText(d.trigger, 40), subject: cutText(d.subject, 140), diagnosis: cutText(d.diagnosis, 40), p: numOrNull(d.p) ?? 0,
    action: cutText(d.action, 40), ran: cutText(d.ran, 40), executed: d.executed === true, latencyMs: numOrNull(d.latencyMs) ?? 0,
    reason: opt(d.reason, 160), gateKind: opt(d.gateKind, 40), gain: numOrNull(d.gain), margin: numOrNull(d.margin), mass: numOrNull(d.mass), threshold: numOrNull(d.threshold), candidate: opt(d.candidate, 40),
  };
}

/** A GenClass action read back from the page, cut to size. */
function cleanAct(v: unknown): ProbeResult["acts"][number] {
  const a = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    id: cutText(a.id, 40), decisionId: cutText(a.decisionId, 40), action: cutText(a.action, 40), trigger: cutText(a.trigger, 40), subject: cutText(a.subject, 140),
    ok: a.ok === true, changed: cutText(a.changed, 220), late: a.late === true,
  };
}

export class ScanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

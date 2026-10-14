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

import { clsOf, judgeCls, judgeFontSize, judgeImages, judgeLcp, judgeReflow, judgeTapTargets, judgeUnsized, judgeZoom, JUDGE_DPR, pageSideSource, parseShifts, viewportOk, windowScrolls } from "./audits.ts";
import { axeFindings, installAxeSource, parseAxe, runAxeSource, withoutVisualDuplicates } from "./axe.ts";
import { KINDS, sanitizeFinding, sanitizeStats, type RawFinding } from "./catalog.ts";
import { jsNote, judgeReliability, PageLog, type CdpLike } from "./cdp.ts";
import { askJudge, cropOf, JUDGE_MAX_CALLS, JUDGE_TIMEOUT_MS, JudgeBudget, judgeInput, judgeText, NOT_JUDGED, sanitizePage, sanitizeRow, toBase64, type CandidateClass, type Crop, type JudgeClient, type JudgeFacts, type JudgeResult } from "./judge.ts";
import { judgePageSource } from "./judge-page.ts";
import { decideRequest, latencySequence, type Phase, type PolicyContext } from "./policy.ts";
import { probeTargets, runtimeBootstrap, runtimeStateSource } from "./probe.ts";
import { blockedAddress, siteOf, type Target } from "./target.ts";
import { callSource, FIX_KINDS, installSource, PERIODIC_KINDS, visualKey, visualStatus } from "./visual.ts";

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
  /** A DevTools protocol session of the scanner's own for this page (Runtime, Network and Log events). */
  createCDPSession?(): Promise<CdpLike>;
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
/**
 * How long a report-only re-check must have run before its silence about a periodic kind (pointer-events-leak,
 * scroll-lock-stuck) means anything: the chunk reports those only after two periodic reads 2 s apart, judged over 1 s.
 */
const PERIODIC_RECHECK_MS = 4500;
/** Takes focus off whatever has it, so the checks after the Tab presses see the page as it rests. */
export const BLUR_SOURCE = `(() => { try { const a = document.activeElement; if (a && a !== document.body && typeof a.blur === "function") a.blur(); } catch (e) {} return true; })()`;
/** The whole scan's hard budget, in ms (scans/slots.json leases last 60 s: store.ts LEASE_MS). */
export const SCAN_BUDGET_MS = 50_000;
/** At most this long for axe-core in one view. */
const AXE_MS = 9000;
/** Findings kept per view in the report. */
const MAX_VIEW_FINDINGS = 40;
/**
 * At most this long per view to find, measure and crop the elements the model judge is asked about. It runs after
 * the deeper checks, in what they left before the race probe's reserve (RESERVE_AFTER_VIEWS), so it never takes time
 * from axe-core, the audits, the probe or the guard pass; on a slow page it gets less, or nothing.
 */
const JUDGE_PREP_MS = 3500;
/** Below this much time the judge does not start in a view. */
const JUDGE_MIN_MS = 800;

/** What the visual checks' collect command returns (visual/scan-entry.js). */
interface Collected {
  ok?: boolean;
  findings?: unknown;
  /** The identity (visualKey) of every finding the engine reported, not only the first 40 that are serialised. */
  keys?: unknown;
  /** How many findings the engine reported, after the ones about files the scanner refused were left out. */
  total?: unknown;
  skipped?: number;
  stats?: { passes?: number; elapsed?: number; [k: string]: unknown };
}

/** Findings from the page, validated (sanitizeFinding), at most 40. */
const cleanFindings = (v: unknown): RawFinding[] => (Array.isArray(v) ? v.slice(0, MAX_VIEW_FINDINGS).map(sanitizeFinding).filter((f): f is RawFinding => f !== null) : []);

/** Every finding's identity from a collect (its `keys`, cut to the sizes sanitizeFinding keeps), else from its findings. */
function collectedKeys(c: Collected): Set<string> {
  if (Array.isArray(c.keys))
    return new Set(
      c.keys
        .slice(0, 400)
        .filter((k): k is string => typeof k === "string")
        .map((k) => {
          const [kind, selector = "", ...state] = k.split("|");
          return `${kind}|${selector.slice(0, 200)}|${state.join("|").slice(0, 200)}`;
        }),
    );
  return new Set(cleanFindings(c.findings).map(visualKey));
}

/**
 * Sideways scrolling on a phone, measured by the chunk: Chrome widens a phone's layout viewport to the content, so any
 * full-width wrapper that a wide child stretched is as wide as the viewport and trips the chunk's "a width of 100vw with
 * a classic scrollbar" rule (phones have no classic scrollbar), and the cause and CSS it suggests are for the wrong
 * element. When that cause shows, or the layout viewport is wider than the phone, the finding keeps the measured excess
 * and loses the chunk's cause and CSS: the report then gives the kind's own fix.
 */
export function phoneOverflow(f: RawFinding, phoneWidth: number, layoutWidth: number | null): RawFinding {
  if (f.kind !== "page-overflow-x") return f;
  const d = f.detail ?? {};
  const said = [f.measured, d.css, d.cssNote, d.fixText].map((x) => (typeof x === "string" ? x : "")).join(" ");
  if (!/100vw with a classic scrollbar/.test(said) && !(layoutWidth !== null && layoutWidth > phoneWidth)) return f;
  const measured = f.measured.replace(/ \((\d[\d,]* px too wide), [^)]*\)/, " ($1)").replace(/\.?$/, ".");
  return {
    ...f,
    measured: `${measured} On a phone the browser widens the layout to fit the content, so the element that causes it can be inside this one.`,
    detail: { ...d, css: "", cssNote: "", fixText: "" },
  };
}

/** An element the model judge may be asked about, as the page's "find" returned it (src/judge-page.ts), checked. */
export interface JudgeItem {
  i: number;
  cls: CandidateClass;
  key: string;
  kind: string;
  sel: string;
  box: { x: number; y: number; w: number; h: number };
}

const CLASSES = new Set<string>(["finding", "covered", "clipped", "dark-control", "text-bg"]);

/** The page's list of elements to judge, validated, in its order (the measured findings first, then by priority). */
export function judgeItems(v: unknown): JudgeItem[] {
  if (!Array.isArray(v)) return [];
  const out: JudgeItem[] = [];
  for (const x of v.slice(0, 60)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const b = (o.box && typeof o.box === "object" ? o.box : {}) as Record<string, unknown>;
    const box = { x: numOrNull(b.x), y: numOrNull(b.y), w: numOrNull(b.w), h: numOrNull(b.h) };
    if (!Number.isInteger(o.i) || (o.i as number) < 0 || typeof o.cls !== "string" || !CLASSES.has(o.cls)) continue;
    if (box.x === null || box.y === null || box.w === null || box.h === null || box.w < 0 || box.h < 0) continue;
    if (o.cls === "finding" && (typeof o.key !== "string" || !o.key)) continue;
    out.push({
      i: o.i as number,
      cls: o.cls as CandidateClass,
      key: o.cls === "finding" ? cutText(o.key, 600) : "",
      kind: o.cls === "finding" && typeof o.kind === "string" && Object.hasOwn(KINDS, o.kind) ? o.kind : "",
      sel: sanitizeFinding({ kind: "image-broken", selector: o.sel, measured: "" })?.selector ?? "",
      box: box as JudgeItem["box"],
    });
  }
  return out;
}

/**
 * Where each chosen element has to be in view to be measured and cropped: at the top of the page (no scroll) when it
 * is in the first viewport; at the end of the page for a control a fixed bar covers there (control-unreachable says
 * "even at the end of the page"); focused, one at a time, for a focused element under a sticky bar; otherwise scrolled
 * so that the element starts a quarter of the way down the viewport, with the elements below it that fit in the same
 * viewport. Groups come in that order; the elements keep their priority order inside each.
 */
export function scrollGroups(items: readonly JudgeItem[], vh: number): { mode: "top" | "end" | "focus" | "at"; y: number; items: JudgeItem[] }[] {
  const out: { mode: "top" | "end" | "focus" | "at"; y: number; items: JudgeItem[] }[] = [];
  const end = items.filter((x) => x.kind === "control-unreachable");
  const focus = items.filter((x) => x.kind === "focus-obscured");
  const rest = items.filter((x) => x.kind !== "control-unreachable" && x.kind !== "focus-obscured");
  const top = rest.filter((x) => x.box.y < vh && x.box.y + x.box.h > 0);
  if (top.length) out.push({ mode: "top", y: 0, items: top });
  if (end.length) out.push({ mode: "end", y: 0, items: end });
  for (const f of focus) out.push({ mode: "focus", y: 0, items: [f] });
  const below = rest.filter((x) => !top.includes(x)).sort((a, b) => a.box.y - b.box.y);
  while (below.length) {
    const first = below.shift()!;
    const y = Math.max(0, Math.round(first.box.y - vh * 0.25));
    const group = [first];
    while (below.length && below[0].box.y + Math.min(below[0].box.h, vh / 2) <= y + vh) group.push(below.shift()!);
    out.push({ mode: "at", y, items: group });
  }
  return out;
}

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
  /** axe-core (src/axe-source.ts), or null when not built in. */
  axeSource?: string | null;
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
  /** The model judge (Clef on Workers AI, src/judge.ts), or null when it is off or the binding is missing. */
  judge?: JudgeClient | null;
  /** How long one judge call may take (JUDGE_TIMEOUT_MS; tests shorten it). */
  judgeTimeoutMs?: number;
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
 * - Content-Security-Policy violations the browser raised (isTrusted) are recorded as plain data for the visual checks'
 *   csp-blocked kind (the checks start after load, when the browser no longer reports earlier violations).
 * The switch and the host list live in this closure, reached through window[name] (non-writable), not on window.
 */
export function safetyBootstrap(name = "__gcScanSafety"): string {
  return `(function(){
  var held = false, hosts = [], csp = [], J = JSON.stringify;
  var LOCAL = /(^|\\.)(localhost|local|internal|test|example|invalid|onion|arpa|home|lan|corp|intranet|private|localdomain)$/;
  try {
    document.addEventListener("securitypolicyviolation", function (e) {
      if (!e.isTrusted) return; // a page can dispatch its own; only the browser's count
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
  /** axe-core rules and the scanner's own audits in this view (src/axe.ts, src/audits.ts, src/cdp.ts). */
  audits: RawFinding[];
  /** What this view measured, so a category that was not measured is never scored as clean. */
  coverage: ViewCoverage;
  /** Timings and sizes measured in this view (the desktop's LCP, CLS and JavaScript bytes; failed requests not scored). */
  metrics: { lcpMs: number | null; cls: number | null; jsBytes: number | null; whoAsks: number; skippedHosts?: number; env?: number[] };
  /** The elements the model judge was asked about in this view, with its answers (src/judge.ts). */
  judged?: JudgeResult[];
  /** How long finding, measuring and cropping them took in this view (null: the judge did not run here). */
  judgeMs?: number | null;
}

export interface ViewCoverage {
  /** axe-core finished in this view. */
  axe: { ran: boolean; ms: number | null; rules: number; incomplete: number; passes: number; error: string | null };
  /** The phone audits (tap targets, zoom, text size, reflow) ran. */
  phone: boolean;
  /** The browser's own record (errors, requests) was collected. */
  reliability: boolean;
  /** Largest Contentful Paint or layout shifts were read. */
  vitals: boolean;
}

export const emptyCoverage = (): ViewCoverage => ({ axe: { ran: false, ms: null, rules: 0, incomplete: 0, passes: 0, error: null }, phone: false, reliability: false, vitals: false });

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
  /**
   * What the re-check found that engine "a" never reported (for example text that became measurable once a leaked
   * pointer-events: none was removed). Neither score counts these; the report says how many there were.
   */
  uncovered?: { kind: string; key: string }[];
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

/** The model judge over the whole scan: calls, answers, tokens and timings. */
export interface JudgeRun {
  /** The judge was available to this scan (WITH a binding and not switched off). */
  on: boolean;
  calls: number;
  answered: number;
  timeouts: number;
  /** Calls that threw (the model was unavailable) or answered malformed data. */
  failed: number;
  /** Input tokens the answers reported. */
  tokens: number;
  /** Per call, from sending to its answer: median and slowest; and from the first call sent to the last answer. */
  msMedian: number | null;
  msMax: number | null;
  wallMs: number | null;
  /** The time each view spent finding, measuring and cropping. */
  prepMs: Record<string, number>;
}

export interface ScanResult {
  views: ViewResult[];
  probe: ProbeResult | null;
  guard: ProbeResult | null;
  notes: string[];
  ms: { total: number; launch: number; views: number; probe: number; guard: number };
  chrome: string;
  timedOut: boolean;
  judge?: JudgeRun;
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

/** The site (registrable domain, approximately) of a URL, or "" when it has none. */
const siteOfUrl = (u: string): string => {
  try {
    return siteOf(new URL(u).hostname.toLowerCase());
  } catch {
    return "";
  }
};

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
  /**
   * The page's fetch and XHR requests in flight, those the scanner answers itself included: what the visual checks
   * treat as "a request in flight" (the runtime's own count; the bench counted fetch and XHR the same way).
   */
  fetching = new Set<object>();
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
  fetchStart(req: RequestLike): void {
    if (DATA_FETCH.has(req.resourceType()) && !OURS.test(req.url())) this.fetching.add(req as object);
  }
  start(req: RequestLike, at: number): void {
    if (OURS.test(req.url())) return;
    this.inflight.add(req as object);
    this.lastActivity = at;
  }
  settle(req: RequestLike, at: number): void {
    this.fetching.delete(req as object);
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
  const budget = deps.budgetMs ?? SCAN_BUDGET_MS;
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
    judge: { on: !!deps.judge, calls: 0, answered: 0, timeouts: 0, failed: 0, tokens: 0, msMedian: null, msMax: null, wallMs: null, prepMs: {} },
  };
  // the scanner's page-side functions live under names the page cannot guess
  const name = deps.pageName ?? `__gcs${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const N = { checks: `${name}c`, safety: `${name}s`, state: `${name}r`, axe: `${name}x`, judge: `${name}j` };
  // the model judge: one budget of calls for the three views, sent as each view finds its elements; answered later
  const judgeBudget = new JudgeBudget();
  const judgeCalls: Promise<void>[] = [];
  let judgeFirst = 0;
  let judgeLast = 0;
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

    // ------------------------------------------------------------------ the model judge's answers
    // sent while the views ran, so usually all in by now; each call has its own timeout from when it was sent
    if (judgeCalls.length) await withTimeout(Promise.allSettled(judgeCalls), Math.max(0, left() - 300), "the model judge").catch(() => undefined);
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
  result.judge = judgeRun();
  return result;

  // ======================================================================================== helpers

  function failedView(spec: ViewSpec, error: string): ViewResult {
    return {
      id: spec.id, label: spec.label, width: spec.width, height: spec.height, ok: false, status: null, finalUrl: target.url,
      ms: 0, notes: [], findings: [], checks: null, fixes: null, shot: null, shotHeight: 0, error, standIns: { count: 0, requests: [] },
      audits: [], coverage: emptyCoverage(), metrics: { lcpMs: null, cls: null, jsBytes: null, whoAsks: 0 }, judged: [], judgeMs: null,
    };
  }

  /** The judge's run over the scan, from every view's results (answers that came after the scan ended do not count). */
  function judgeRun(): JudgeRun {
    const all = result.views.flatMap((v) => v.judged ?? []);
    const done = all.filter((j) => j.answer || j.error);
    const ms = done.map((j) => j.ms).sort((a, b) => a - b);
    const prepMs: Record<string, number> = {};
    for (const v of result.views) if (v.judgeMs !== null && v.judgeMs !== undefined) prepMs[v.id] = v.judgeMs;
    return {
      on: !!deps.judge,
      calls: all.length,
      answered: all.filter((j) => j.answer).length,
      timeouts: all.filter((j) => j.error === "timeout" || (!j.answer && !j.error)).length,
      failed: all.filter((j) => j.error === "unavailable" || j.error === "malformed").length,
      tokens: all.reduce((t, j) => t + (j.answer?.tokens ?? 0), 0),
      msMedian: ms.length ? ms[Math.floor((ms.length - 1) / 2)] : null,
      msMax: ms.length ? ms[ms.length - 1] : null,
      wallMs: judgeFirst && judgeLast ? judgeLast - judgeFirst : null,
      prepMs,
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
    // the browser's own record of this view (errors, responses, bytes), from a DevTools session of the scanner's own
    let log: PageLog | null = null;
    let cdp: CdpLike | null = null;
    if (page.createCDPSession) {
      try {
        cdp = await withTimeout(page.createCDPSession(), Math.min(4000, left()), "opening a DevTools session");
        if (!spec.mobile) await fitDesktopWindow(cdp, spec);
        if (!skipChecks) {
          const l = new PageLog();
          await withTimeout(l.attach(cdp), Math.min(4000, left()), "turning on the DevTools domains");
          log = l;
        }
      } catch (e) {
        if (!skipChecks) view.notes.push(`The browser's own record of errors and requests could not be read in this view (${cutText(e instanceof Error ? e.message : String(e), 100)}), so reliability was not measured here.`);
      }
    }
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
          net.fetchStart(req);
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
            net.fetching.delete(req as object);
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
              net.fetching.delete(req as object);
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
          net.fetching.delete(req as object);
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
    // 16 s for the load event: what a slower page has not loaded by then is left out, so the checks after it keep their time
    const navMs = Math.min(16_000, left() - reserve);
    let loadTimedOut = false;
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
      loadTimedOut = true;
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
    // network quiet: no page request in flight for 500 ms (the scanner's own runtime and model downloads do not count);
    // after a load that timed out the page is still requesting, so it gets half a second, not 4
    {
      const quietBy = deps.now() + (loadTimedOut ? 500 : Math.max(500, Math.min(4000, left() - reserve)));
      while (!(net.inflight.size === 0 && deps.now() - net.lastActivity >= 500) && deps.now() < quietBy) await deps.sleep(100);
      if (net.inflight.size > 0 && !loadTimedOut) view.notes.push("The network did not go quiet within 4 s (the page keeps requesting); the checks ran anyway.");
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
    if (log && cdp) await log.frame(cdp);
    // timings at network quiet, before the scanner presses a key or scrolls (a page stops reporting LCP at the first
    // input): the desktop's are judged, the light phone's are kept for comparison only
    let vitals: Record<string, unknown> | null = null;
    if (!skipChecks && !discard && (spec.id === "desktop" || spec.id === "phone")) {
      vitals = await withTimeout(evalDom(page, pageSideSource("vitals")), Math.min(3000, Math.max(500, left() - reserve)), "reading the page's timings").then(
        (v) => parseJson<Record<string, unknown> | null>(v, null),
        () => null,
      );
    }

    if (!skipChecks && !discard) {
      deps.progress("checks", { view: spec.id });
      if (runtime)
        view.notes.push("The page's Content-Security-Policy was turned off in this view so the GenClass runtime could load for the race probe, so files the policy blocks are reported from the phone views only.");
      try {
        await visualChecks(page, view, net, spec);
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
      const narrowed = await deeperChecks(page, view, spec, vitals, log, net);
      // the model judge last, in the time the checks above left before the race probe's reserve
      if (deps.judge && view.shot && !discard) await judgeView(page, view, spec, cdp, narrowed);
    }
    log?.stop();
    if (cdp?.detach) await cdp.detach().catch(() => undefined);
    view.ms = deps.now() - tv;
    if (!keepOpen) {
      await page.close().catch(() => undefined);
      return { view, page: null, ctx: null, net: null };
    }
    return { view, page, ctx, net };
  }

  /**
   * The desktop view's window and screen, the size of its viewport. A new headless window is about 780 by 580 px on an
   * 800 by 600 screen (measured in calibration), and the viewport emulation does not change what the page reads from
   * window.outerWidth or screen.width, where a visitor's are never smaller than the viewport; a page that lays itself out
   * from those would be judged in a layout no visitor gets. Phone emulation already reports the phone's size everywhere.
   * Best effort: when the browser refuses, the view runs as before.
   */
  async function fitDesktopWindow(cdp: CdpLike, spec: ViewSpec): Promise<void> {
    try {
      const w = await withTimeout(cdp.send("Browser.getWindowForTarget"), 2000, "reading the window");
      const windowId = (w as { windowId?: unknown } | null)?.windowId;
      if (typeof windowId === "number") await withTimeout(cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: spec.width, height: spec.height } }), 2000, "sizing the window");
    } catch {
      /* the window keeps its size */
    }
    try {
      await withTimeout(
        cdp.send("Emulation.setDeviceMetricsOverride", { width: spec.width, height: spec.height, deviceScaleFactor: 1, mobile: false, screenWidth: spec.width, screenHeight: spec.height }),
        2000,
        "sizing the screen",
      );
    } catch {
      /* the screen keeps its size */
    }
  }

  /**
   * The model judge in one view (src/judge.ts), after the screenshot and before the deeper checks: the visual checks'
   * findings it may judge and the elements the measured checks abstain on (src/judge-page.ts "find"), findings first,
   * as many as this view's share of the scan's calls allows. Each element is measured and cropped from a viewport
   * screenshot with it in view (no scrolling for those at the top of the page), and its call is sent at once, so the
   * answers come in while the rest of the scan runs. It takes at most JUDGE_PREP_MS, and only time the deeper checks
   * after it do not need. Anything that goes wrong leaves this view's findings as measured and says so in its notes.
   */
  async function judgeView(page: PageLike, view: ViewResult, spec: ViewSpec, cdp: CdpLike | null, narrowed: boolean): Promise<void> {
    const client = deps.judge;
    if (!client) return;
    const t0 = deps.now();
    const prep = Math.min(JUDGE_PREP_MS, left() - RESERVE_AFTER_VIEWS - 300);
    if (prep < JUDGE_MIN_MS) {
      judgeBudget.take(spec.id, 0); // its share goes to the views after it
      view.notes.push("The model judge (Clef) was skipped in this view: not enough of the scan's time was left.");
      return;
    }
    const timeLeft = () => t0 + prep - deps.now();
    let chosen = 0;
    let sent = 0;
    const judged = (view.judged ??= []);
    try {
      // the reflow check left the light phone at 320 px: back to the phone's width, as in the screenshot
      if (narrowed) {
        await page.setViewport({ width: spec.width, height: spec.height, deviceScaleFactor: 1, isMobile: spec.mobile, hasTouch: spec.mobile });
        await deps.sleep(450);
      }
      await page.mouse.move(-1, -1).catch(() => undefined);
      await withTimeout(evalDom(page, BLUR_SOURCE), 1000, "clearing focus").catch(() => undefined);
      const targets = view.findings
        .filter((f) => !NOT_JUDGED.has(f.kind) && f.box && f.box.w >= 4 && f.box.h >= 4)
        .slice(0, 20)
        .map((f) => ({ key: visualKey(f), kind: f.kind, selector: f.selector, box: f.box }));

      const found = parseJson<{ ok?: unknown; vh?: unknown; items?: unknown } | null>(
        await withTimeout(
          evalDom(page, judgePageSource("find", { name: N.judge, targets, find: true, dark: spec.scheme === "dark", max: JUDGE_MAX_CALLS - 10, shotW: view.width, shotH: view.shotHeight })),
          Math.min(3000, timeLeft()),
          "finding the elements to judge",
        ),
        null,
      );
      if (!found || found.ok !== true) throw new Error("the page did not answer");
      const items = judgeItems(found.items);
      const take = judgeBudget.take(spec.id, items.length);
      chosen = take;
      for (const g of scrollGroups(items.slice(0, take), numOrNull(found.vh) ?? spec.height)) {
        if (timeLeft() < 400) break;
        const facts = parseJson<{ ok?: unknown; vw?: unknown; vh?: unknown; sx?: unknown; sy?: unknown; page?: unknown; items?: unknown } | null>(
          await withTimeout(
            evalDom(page, judgePageSource("facts", { name: N.judge, idx: g.items.map((x) => x.i), mode: g.mode, y: g.y, vars: g.items.filter((x) => x.kind === "css-var-undefined").map((x) => x.i) })),
            Math.min(2500, timeLeft()),
            "measuring the elements to judge",
          ).catch(() => null),
          null,
        );
        if (!facts || facts.ok !== true || !Array.isArray(facts.items)) continue;
        const vw = numOrNull(facts.vw) ?? spec.width;
        const vh = numOrNull(facts.vh) ?? spec.height;
        const sx = numOrNull(facts.sx) ?? 0;
        const sy = numOrNull(facts.sy) ?? 0;
        const pageRow = sanitizePage(facts.page);
        const jobs: { it: JudgeItem; facts: JudgeFacts; crop: Crop }[] = [];
        for (const raw of facts.items.slice(0, 60) as Record<string, unknown>[]) {
          const it = g.items.find((x) => x.i === raw?.i);
          const el = it ? sanitizeRow(raw.el) : null;
          if (!it || !el) continue;
          const crop = cropOf({ x: Number(el.x), y: Number(el.y), w: Number(el.w), h: Number(el.h) }, vw, vh, sx, sy);
          if (!crop) continue;
          jobs.push({ it, crop, facts: { device: spec.mobile ? "phone" : "desktop", scheme: spec.scheme, page: pageRow, el, anc: sanitizeRow(raw.anc), kids: Math.max(0, Math.round(numOrNull(raw.kids) ?? 0)) } });
        }
        // one crop at a time: Chrome applies the clip of concurrent captures to each other's images (calibration: two
        // crops of one group came back swapped), and each call goes out as soon as its crop is taken
        for (const j of jobs) {
          if (timeLeft() < 150) break;
          const image = await withTimeout(cropShot(page, cdp, j.crop), Math.min(2000, Math.max(400, timeLeft())), "a crop").catch(() => null);
          if (!image) continue;
          const state = judgeText(j.it.cls === "finding", j.facts, j.crop);
          const res: JudgeResult = { id: `${spec.id}-j${judged.length + 1}`, view: spec.id, cls: j.it.cls, key: j.it.key, kind: j.it.kind, selector: j.it.sel, box: j.it.box, crop: j.crop, state, image, answer: null, error: null, ms: 0 };
          judged.push(res);
          sent++;
          if (!judgeFirst) judgeFirst = deps.now();
          judgeCalls.push(
            askJudge(client, judgeInput(state, image), deps.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS, deps.now).then((r) => {
              res.answer = r.answer;
              res.error = r.error;
              res.ms = r.ms;
              judgeLast = deps.now();
            }),
          );
        }
      }
      if (sent < chosen) view.notes.push(`The model judge (Clef) ran out of its time in this view: ${sent} of the ${chosen} elements chosen were sent to it.`);
    } catch (e) {
      view.notes.push(`The model judge (Clef) did not run in this view (${cutText(e instanceof Error ? e.message : String(e), 100)}), so the findings here stand as measured.`);
    } finally {
      judgeBudget.take(spec.id, 0); // when it stopped before taking any, its share goes to the views after it
      await withTimeout(evalDom(page, judgePageSource("restore", { name: N.judge })), 1500, "restoring the page").catch(() => undefined);
      view.judgeMs = deps.now() - t0;
    }
  }

  /** One crop as base64 JPEG: a viewport screenshot of the clip, over the view's own DevTools session when there is one. */
  async function cropShot(page: PageLike, cdp: CdpLike | null, c: Crop): Promise<string | null> {
    const clip = { x: c.x, y: c.y, width: c.w, height: c.h, scale: 1 };
    let data: unknown;
    if (cdp) data = ((await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90, clip, captureBeyondViewport: false, optimizeForSpeed: true })) as { data?: unknown } | null)?.data;
    else {
      const b = await page.screenshot({ type: "jpeg", quality: 90, clip: { x: c.x, y: c.y, width: c.w, height: c.h }, captureBeyondViewport: false, encoding: "base64" });
      data = typeof b === "string" ? b : b instanceof Uint8Array ? toBase64(b) : null;
    }
    return typeof data === "string" && data.length > 8 && data.length < 5_600_000 && /^[A-Za-z0-9+/]+=*$/.test(data.slice(-64)) ? data : null;
  }

  /**
   * axe-core and the scanner's own audits in one view, after the visual checks and the screenshot (src/axe.ts,
   * src/audits.ts, src/cdp.ts). Each step runs only when the time left before the race probe allows it and says so when
   * it does not; a step that did not run leaves its category unmeasured in this view (ViewCoverage). On the light phone
   * the viewport is then narrowed to 360 and 320 px (no reload) for the reflow check, after everything else.
   */
  async function deeperChecks(page: PageLike, view: ViewResult, spec: ViewSpec, vitals: Record<string, unknown> | null, log: PageLog | null, net: NetLog): Promise<boolean> {
    let narrowed = false;
    const room = () => left() - RESERVE_AFTER_VIEWS;
    const out: RawFinding[] = [];
    const phone = spec.id === "phone";
    const word = spec.id === "phone-dark" ? "dark phone" : spec.id;
    const say = (e: unknown) => cutText(e instanceof Error ? e.message : String(e), 120);
    // the visual checks pressed Tab on the desktop and scrolled with the mouse over the page: whatever has focus or sits
    // under the pointer now would be judged in its :focus or :hover style (measured in calibration: a link that loses
    // its underline on hover and focus, reported by axe-core as a link without styling). The pointer leaves the page.
    await page.mouse.move(-1, -1).catch(() => undefined);
    await withTimeout(evalDom(page, BLUR_SOURCE), 1000, "clearing focus").catch(() => undefined);

    // Largest Contentful Paint, layout shifts and unsized images, read at network quiet (judged on the desktop only)
    if (vitals) {
      const lcp = vitals.lcp && typeof vitals.lcp === "object" ? numOrNull((vitals.lcp as Record<string, unknown>).t) : null;
      view.metrics.lcpMs = lcp;
      view.metrics.cls = clsOf(parseShifts(vitals.shifts)).value;
      if (Array.isArray(vitals.env)) view.metrics.env = vitals.env.slice(0, 7).map((x) => Math.round(Number(x) || 0));
      if (spec.id === "desktop") {
        view.coverage.vitals = true;
        const slow = judgeLcp(vitals.lcp);
        if (slow) out.push(slow);
        // the visual checks' own layout-shift finding (above 0.25, with the element) stands for the same shifts
        const cls = view.findings.some((f) => f.kind === "layout-shift") ? null : judgeCls(vitals.shifts);
        if (cls) out.push(cls);
        const unsized = judgeUnsized(vitals.unsized, vitals.shifts, vitals.firstPaint);
        if (unsized) out.push(unsized);
      }
    } else if (spec.id === "desktop") view.notes.push("The page's timings (Largest Contentful Paint, layout shifts) could not be read in this view, so speed was not measured.");

    // axe-core: WCAG 2.2 A and AA rules and best practices
    if (deps.axeSource) {
      const budget = Math.min(AXE_MS, room() - 1500);
      if (budget < 2500) {
        view.coverage.axe.error = "not enough time left";
        view.notes.push("axe-core was skipped in this view: not enough of the scan's time was left.");
      } else {
        try {
          const installed = await withTimeout(evalDom(page, installAxeSource(N.axe, deps.axeSource)), Math.min(5000, budget), "installing axe-core");
          if (installed !== true) throw new Error("axe-core did not install");
          const res = parseAxe(parseJson(await withTimeout(evalDom(page, runAxeSource(N.axe)), budget, "axe-core"), {}));
          if (!res.ok) throw new Error(res.error ?? "axe-core did not run");
          const rules = withoutVisualDuplicates(res.rules, view.findings);
          out.push(...axeFindings(rules));
          view.coverage.axe = { ran: true, ms: res.ms, rules: rules.length, incomplete: res.incomplete, passes: res.passes, error: null };
        } catch (e) {
          view.coverage.axe.error = say(e);
          view.notes.push(`axe-core did not finish in this view (${say(e)}), so its results are left out here.`);
        }
      }
    }

    // the page audits: tap targets, zoom and text size on the light phone; image sizes on the desktop and the light phone
    if (spec.id !== "phone-dark") {
      if (room() < 1500) {
        if (phone) view.notes.push("The phone audits were skipped: not enough of the scan's time was left.");
      } else {
        try {
          const a = parseJson<Record<string, unknown> | null>(await withTimeout(evalDom(page, pageSideSource("audit", { targets: phone, text: phone, images: true })), Math.min(5000, room() - 500), "the page audits"), null);
          if (!a || typeof a !== "object") throw new Error("they returned nothing");
          const vp = typeof a.viewport === "string" ? a.viewport : null;
          if (phone) {
            for (const f of [judgeTapTargets(a.targets), judgeZoom(vp), judgeFontSize(a.text, vp)]) if (f) out.push(f);
            // sideways scrolling at 360 and 320 px: the same page, narrowed (no reload), after every other check
            const overflow390 = view.findings.some((f) => f.kind === "page-overflow-x");
            if (!overflow390 && viewportOk(vp) && room() > 3000) {
              const at = async (w: number): Promise<unknown> => {
                narrowed = true;
                await page.setViewport({ width: w, height: spec.height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
                await deps.sleep(450);
                return parseJson<unknown>(await withTimeout(evalDom(page, pageSideSource("reflow")), 3000, "the reflow check"), null);
              };
              const r360 = await at(360);
              const r320 = room() > 1200 ? await at(320) : null;
              const reflow = judgeReflow(r360, r320, vp, overflow390);
              if (reflow) out.push(reflow);
            }
            view.coverage.phone = true;
          }
          if (log) {
            const img = judgeImages(a.images, (u) => log.bytesOf(u), spec.mobile ? JUDGE_DPR.phone : JUDGE_DPR.desktop, word);
            if (img) out.push(img);
          }
        } catch (e) {
          view.notes.push(`The page audits did not finish in this view (${say(e)}).`);
        }
      }
    }

    // the browser's own record: uncaught errors, console.error, failed same-site requests, mixed content, JavaScript
    if (log) {
      log.stop();
      const rel = judgeReliability(log, view.finalUrl, word);
      out.push(...rel.findings);
      view.coverage.reliability = true;
      view.metrics.whoAsks = rel.whoAsks;
      if (spec.id === "desktop") {
        view.metrics.jsBytes = rel.jsBytes;
        const js = jsNote(rel.jsBytes);
        if (js) out.push(js);
      }
      const skipped = scannerSkipped(net).length;
      if (skipped) view.metrics.skippedHosts = skipped;
    }
    view.audits = out.map(sanitizeFinding).filter((f): f is RawFinding => f !== null);
    return narrowed;
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
   * Stopping "a" undoes every fix, before the screenshot and the race probe. While the checks run, the page's fetch
   * and XHR requests in flight are handed to them every 250 ms ("net"): the chunk does not judge a blank page, a
   * leaked pointer-events: none or a covering layer while a request runs, as in the runtime.
   */
  async function visualChecks(page: PageLike, view: ViewResult, net: NetLog, spec: ViewSpec): Promise<void> {
    if (!deps.visualSource) {
      view.notes.push("The visual checks are not built into this copy of the scanner.");
      return;
    }
    const desktop = spec.id === "desktop";
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
    // the page's requests in flight, as the runtime would count them: sent when the count changes, and once a second
    let sentN = -1;
    let sentAt = 0;
    let sending = false;
    const pushNet = async (): Promise<void> => {
      const n = net.fetching.size;
      if (sending || (n === sentN && deps.now() - sentAt < 1000)) return;
      sending = true;
      try {
        await evalDom(page, callSource(N.checks, "net", { n }));
        sentN = n;
        sentAt = deps.now();
      } catch {
        /* the page closed */
      } finally {
        sending = false;
      }
    };
    await pushNet();
    const pump = setInterval(() => void pushNet(), 250);
    try {
      const started = await call<{ ok?: boolean; error?: string }>("start", { id: "a", mode: fix ? "guard" : "observe", fix, csp });
      if (!started.ok) throw new Error(cutText(started.error || "they did not start", 120));
      try {
        const t0 = deps.now();
        const end = Math.min(t0 + VISUAL_MS, deps.now() + Math.max(0, left() - reserve));
        await interact(page, call, "a", t0, end, desktop);
        while (deps.now() < end) await deps.sleep(Math.min(250, end - deps.now()));
        const top = await call<Record<string, unknown>>("top");
        const a = await call<Collected>("collect", { id: "a", pass: true, passMs: 2500, skipHosts }, 4000);
        view.checks = sanitizeStats({ ...top, ...(a.stats ?? {}), skipped: a.skipped }) as ViewResult["checks"];
        const layoutW = numOrNull(view.checks?.viewport?.[0]);
        view.findings = cleanFindings(a.findings).map((f) => (spec.mobile ? phoneOverflow(f, spec.width, layoutW) : f));
        // a scroll lock blamed on body while html scrolls the window: body's overflow does not reach the viewport then
        if (view.findings.some((f) => f.kind === "scroll-lock-stuck" && f.selector === "body")) {
          const o = parseJson<unknown>(await withTimeout(evalDom(page, pageSideSource("overflow")), 2000, "reading the page's overflow").catch(() => null), null);
          if (windowScrolls(o)) {
            view.findings = view.findings.filter((f) => !(f.kind === "scroll-lock-stuck" && f.selector === "body"));
            const ov = (o ?? {}) as Record<string, unknown>;
            view.notes.push(`The visual checks reported a scroll lock on body, but html has overflow-y: ${cutText(ov.html, 12)}, so the window itself scrolls (CSS overflow propagation); the finding is left out.`);
          }
        }
        const total = numOrNull(a.total) ?? 0;
        if (total > view.findings.length && total > MAX_VIEW_FINDINGS) {
          const more = Math.round(total - view.findings.length);
          view.notes.push(`${more} more visual ${more === 1 ? "finding" : "findings"} in this view ${more === 1 ? "is" : "are"} not in the report, which keeps the first ${MAX_VIEW_FINDINGS} per view.`);
        }
        const st = a.stats ?? {};
        if (Number(st.passes) > 0 && Number(st.partial) >= Number(st.passes)) view.notes.push("The visual checks ran out of their time budget on every pass in this view, so parts of the page were not checked.");
        if (a.skipped) view.notes.push(`${a.skipped} visual ${a.skipped === 1 ? "finding is" : "findings are"} left out: ${a.skipped === 1 ? "it is" : "they are"} about files the scanner did not load (their hosts could not be looked up or were refused).`);
        if (fix) view.fixes = await recheck(page, call, view.findings, collectedKeys(a), skipHosts, reserve);
      } finally {
        clearInterval(pump);
        await call("stop", { id: "a" }).catch(() => undefined); // undoes every fix this engine applied
      }
    } finally {
      clearInterval(pump);
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
   * no longer finds it among everything it reported (not only the first 40). "c" gets the same periodic reads when a
   * fix was one of the periodic kinds, and its silence about a periodic kind counts only when it ran long enough to
   * have seen it (PERIODIC_RECHECK_MS). What "c" found that "a" never reported is kept as `uncovered`.
   */
  async function recheck(
    page: PageLike,
    call: <T>(cmd: string, arg?: Record<string, unknown>, ms?: number) => Promise<T>,
    found: RawFinding[],
    foundKeys: Set<string>,
    skipHosts: string[],
    reserve: number,
  ): Promise<VisualFixes | null> {
    const fixable = found.filter((f) => FIX_KINDS.has(f.kind));
    if (!fixable.length) return null;
    const out: VisualFixes = { applied: fixable.filter((f) => f.detail?.fixApplied === true).length, rechecked: false, fixed: [], notFixed: [], uncovered: [] };
    let after = fixable;
    let still: Set<string> | null = null;
    let periodicSeen = false;
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
            still = collectedKeys(c);
            out.rechecked = true;
            periodicSeen = (numOrNull(c.stats?.elapsed) ?? deps.now() - t0) >= PERIODIC_RECHECK_MS;
            for (const key of still) {
              const kind = key.slice(0, key.indexOf("|"));
              if (!foundKeys.has(key) && Object.hasOwn(KINDS, kind) && out.uncovered!.length < 20) out.uncovered!.push({ kind, key });
            }
          }
          if (a.ok) after = cleanFindings(a.findings).filter((f) => FIX_KINDS.has(f.kind));
        } finally {
          await call("stop", { id: "c" }).catch(() => undefined);
        }
      }
    }
    const fixes = visualStatus().fixes;
    for (const f of after) {
      const key = visualKey(f);
      const applied = f.detail?.fixApplied === true;
      const css = cutText(f.detail?.fixCss, 160);
      const judged = still !== null && (!PERIODIC_KINDS.has(f.kind) || periodicSeen);
      if (applied && judged && !still!.has(key))
        out.fixed.push({ kind: f.kind, selector: f.selector, key, how: `${fixes.charAt(0).toUpperCase()}${fixes.slice(1)} changed the page: ${css || "its fix for this kind"}. The re-check no longer found it.` });
      else
        out.notFixed.push({
          kind: f.kind,
          selector: f.selector,
          key,
          why: applied
            ? judged
              ? "GenClass applied a fix, but the re-check still found the problem."
              : still
                ? "GenClass applied a fix, but the re-check did not run long enough to see this kind again (it needs about 4.5 s), so it is not counted."
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
        // the site's own requests: a click also fires analytics and ad beacons to other sites, and two identical beacons
        // are not a double submit (measured in calibration: two identical ad-tracking POSTs from one double click)
        const site = siteOfUrl(ctx.pageOrigin || target.url);
        const sent = net.answered.slice(from).filter((e) => e.phase === "click" && e.method !== "OPTIONS" && siteOfUrl(e.url) === site);
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

// Page side of the visual bench (docs/runtime/VISUAL.md section 15). Bundled by build.mjs into one IIFE that the
// runner adds with page.addInitScript, so nothing is added to the demos, templates, compat apps or public sites
// (AGENTS.md rule 4). It runs the measured visual checks engine (packages/runtime/src/visual/engine.ts) with a
// harness host instead of a runtime, collects every finding, and plants faults for the recall runs (faults.ts).
//
// Harness code, not runtime code: it may read the real clock and wrap fetch/XHR to count requests in flight (the
// runtime counts them through its own interception). The engine itself still runs on browserClock, as in the runtime.

import { Visual } from "../../packages/runtime/src/visual/engine.js";
import { browserClock } from "../../packages/runtime/src/clock.js";
import { describeElement } from "../../packages/runtime/src/observe/dom-user.js";
import { normalizePath } from "../../packages/runtime/src/util.js";
import { readSheets } from "../../packages/runtime/src/visual/checks/text.js";
import type { CheckFinding, VisualSummary } from "../../packages/runtime/src/types.js";
import type { VisualHost } from "../../packages/runtime/src/visual/host.js";
import { earlyFault, inject, truth, type FaultResult } from "./faults.js";

export interface BenchCfg {
  /** "observe" for report-only loads (public sites); "guard" with fix: true measures runtime fixes. */
  mode: "observe" | "guard";
  fix: boolean;
  /** Faults that must exist before the page renders (page-blank, viewport-meta-missing). */
  early?: string;
  seed?: number;
  /** Start the engine at `load`, or after this many ms at most (a load event held up by a slow request). */
  startCapMs?: number;
}

export interface SerialFinding {
  i: number;
  id: string;
  kind: string;
  severity: string;
  target: string;
  selector: string;
  message: string;
  details: string[];
  measured: Record<string, unknown>;
  threshold: unknown;
  context: unknown;
  suggestion?: unknown;
  count?: number;
  fix: { applied: boolean; css?: string; reason?: string } | null;
  /** The data-bench-fault value of the element or its closest marked ancestor (fault runs), and its instance id. */
  fault: string | null;
  faultId: string | null;
  /** A runtime fix was applied and still holds at collection time (the colour rule is on, the inline lock is gone). */
  fixHeld?: boolean;
  /** html, body or another element. */
  tag: string;
  connected: boolean;
  rect: { x: number; y: number; w: number; h: number } | null;
}

interface Bench {
  cfg: BenchCfg;
  startedAt: number | null;
  error: string | null;
  engine: Visual | null;
  findings: CheckFinding[];
  notes: number;
  audits: number;
  csp: number;
  shifts: { t: number; value: number }[];
  injectedAt: number | null;
  faults: FaultResult[];
  nowTimeouts: number;
  inflight(): number;
  passes(): number;
  summary(): VisualSummary | null;
  now(): Promise<number>;
  serial(): SerialFinding[];
  element(i: number): Element | null;
  inject(kind: string, seed: number, extra?: Record<string, unknown>): FaultResult;
  truth(id: string): { ok: boolean; why: string; value?: number };
  darkSupport(): { supported: boolean | null; signals: string[] };
  rootColors(): Record<string, string>;
  quietPoint(): { x: number; y: number };
  hoverTargets(max: number): { x: number; y: number }[];
  /** Time of one whole stylesheet walk as css-var-undefined does it (the engine runs it in steps of 200 rules). */
  sheetWalk(): { ms: number; rules: number; readable: boolean };
  /** Long tasks (50 ms or more, any cause: the page's own work too) since the engine started. */
  longTasks(): { n: number; maxMs: number };
}

type W = Window & { __GC_BENCH_CFG?: BenchCfg; __gcBench?: Bench };

function boot(): void {
  const w = window as W;
  if (w.top !== w || w.__gcBench) return; // top document only, once
  const cfg: BenchCfg = { mode: "observe", fix: false, startCapMs: 8000, ...(w.__GC_BENCH_CFG ?? {}) };
  if (cfg.early) earlyFault(cfg.early);

  // ----------------------------------------------------------------------------------------- in flight
  let inflight = 0;
  const done = () => void (inflight = Math.max(0, inflight - 1));
  try {
    const of = w.fetch;
    if (typeof of === "function") {
      const wrapped = function (this: unknown, ...a: Parameters<typeof fetch>) {
        inflight++;
        let p: Promise<Response>;
        try {
          p = of.apply(this ?? w, a);
        } catch (e) {
          done();
          throw e;
        }
        p.then(done, done);
        return p;
      };
      w.fetch = wrapped as typeof fetch;
    }
    const XO = typeof XMLHttpRequest === "function" ? XMLHttpRequest.prototype : undefined;
    const send = XO?.send;
    if (XO && send)
      XO.send = function (this: XMLHttpRequest, ...a: Parameters<XMLHttpRequest["send"]>) {
        inflight++;
        let settled = false;
        const end = () => {
          if (settled) return;
          settled = true;
          done();
        };
        this.addEventListener("loadend", end, { once: true });
        try {
          return send.apply(this, a);
        } catch (e) {
          end();
          throw e;
        }
      };
  } catch {
    /* a page that froze its globals: in flight stays 0 and settle relies on DOM quiet */
  }

  // ------------------------------------------------------------------------------- early CSP, layout shifts
  const early: Event[] = [];
  let cspSeen = 0;
  const onCsp = (e: Event) => {
    cspSeen++;
    if (early.length < 50) early.push(e);
  };
  document.addEventListener("securitypolicyviolation", onCsp, true);
  const shifts: { t: number; value: number }[] = [];
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput && shifts.length < 2000) shifts.push({ t: e.startTime, value: e.value });
    });
    po.observe({ type: "layout-shift", buffered: true });
  } catch {
    /* no layout-shift entries */
  }
  const long: { s: number; d: number }[] = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (long.length < 500) long.push({ s: e.startTime, d: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* no longtask entries */
  }

  const B: Bench = {
    cfg,
    startedAt: null,
    error: null,
    engine: null,
    findings: [],
    notes: 0,
    audits: 0,
    get csp() {
      return cspSeen;
    },
    shifts,
    injectedAt: null,
    faults: [],
    inflight: () => inflight,
    passes: () => B.engine?.summary()?.visual.passes ?? 0,
    summary: () => B.engine?.summary()?.visual ?? null,
    now: async () => {
      if (!B.engine) return -1;
      // a pass queues behind the one running; on a page that is never idle that can take long: 20 s at most here
      const t = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 20_000));
      const r = await Promise.race([B.engine.now(), t]);
      if (r === "timeout") {
        B.nowTimeouts++;
        return -2;
      }
      return B.findings.length;
    },
    nowTimeouts: 0,
    serial: () => B.findings.map((f, i) => serial(f, i)),
    element: (i) => B.findings[i]?.element() ?? null,
    inject: (kind, seed, extra) => {
      B.injectedAt ??= performance.now();
      const r = inject(kind, seed, extra ?? {});
      B.faults.push(r);
      return r;
    },
    truth: (id) => truth(id, B),
    darkSupport,
    rootColors,
    quietPoint,
    hoverTargets,
    sheetWalk: () => {
      const t = performance.now();
      const r = readSheets(document);
      return { ms: Math.round((performance.now() - t) * 10) / 10, rules: r ? r.rules : 0, readable: !!r };
    },
    longTasks: () => {
      const after = long.filter((e) => B.startedAt !== null && e.s >= B.startedAt);
      return { n: after.length, maxMs: Math.round(Math.max(0, ...after.map((e) => e.d))) };
    },
  } as Bench;
  w.__gcBench = B;

  const host: VisualHost = {
    clock: browserClock,
    global: w as unknown as Record<string, unknown>,
    seed: `bench-${cfg.seed ?? 0}`,
    mode: () => cfg.mode,
    sampled: () => true,
    active: () => true,
    inflight: () => inflight,
    errors: () => 0,
    describe: describeElement,
    route: () => normalizePath(location.pathname || "/"),
    report: (f) => void B.findings.push(f),
    note: () => void B.notes++,
    audit: () => void B.audits++,
  };

  const start = () => {
    if (B.engine || B.startedAt !== null) return;
    B.startedAt = performance.now();
    document.removeEventListener("securitypolicyviolation", onCsp, true);
    document.addEventListener("securitypolicyviolation", () => void cspSeen++, true);
    try {
      B.engine = new Visual(host, { on: true, fix: cfg.fix, lowEnd: "full", maxConsoleLines: 0 }, early, true);
    } catch (e) {
      B.error = String((e as Error)?.stack ?? e).slice(0, 600);
    }
  };
  if (document.readyState === "complete") setTimeout(start, 0);
  else {
    addEventListener("load", () => setTimeout(start, 0), { once: true });
    setTimeout(start, cfg.startCapMs ?? 8000);
  }
}

function rectOf(el: Element | null): SerialFinding["rect"] {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}

function serial(f: CheckFinding, i: number): SerialFinding {
  let el: Element | null = null;
  try {
    el = f.element();
  } catch {
    el = null;
  }
  const marked = el?.closest?.("[data-bench-fault]") ?? null;
  let fixHeld: boolean | undefined;
  if (f.fix?.applied && el) {
    const s = getComputedStyle(el);
    fixHeld = f.kind === "text-invisible" ? el.hasAttribute("data-genclass-fix") : f.kind === "pointer-events-leak" ? s.pointerEvents !== "none" : !/hidden|clip/.test(s.overflowY);
  }
  return {
    i,
    id: f.id,
    kind: f.kind,
    severity: f.severity,
    target: f.target,
    selector: f.selector,
    message: f.message,
    details: f.details,
    measured: f.measured,
    threshold: f.threshold,
    context: f.context,
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    ...(f.count ? { count: f.count } : {}),
    fix: f.fix ? { applied: f.fix.applied, css: f.fix.css, reason: f.fix.reason } : null,
    fault: marked?.getAttribute("data-bench-fault") ?? null,
    faultId: marked?.getAttribute("data-bench-id") ?? null,
    ...(fixHeld !== undefined ? { fixHeld } : {}),
    tag: el ? el.tagName.toLowerCase() : "none",
    connected: !!el?.isConnected,
    rect: rectOf(el),
  };
}

/** Whether the page has a dark design: a prefers-color-scheme rule or link, a color-scheme meta or root value. */
function darkSupport(): { supported: boolean | null; signals: string[] } {
  const signals: string[] = [];
  let unreadable = 0;
  const meta = document.querySelector('meta[name="color-scheme"]')?.getAttribute("content") ?? "";
  if (/dark/.test(meta)) signals.push("meta color-scheme");
  if (/dark/.test(getComputedStyle(document.documentElement).colorScheme)) signals.push("root color-scheme");
  for (const l of document.querySelectorAll("link[media], source[media]")) if (/prefers-color-scheme:\s*dark/.test(l.getAttribute("media") ?? "")) signals.push("link media");
  let n = 0;
  const walk = (rules: CSSRuleList): boolean => {
    for (const r of rules) {
      if (++n > 20000) return false;
      const cond = (r as CSSMediaRule).conditionText ?? (r as CSSMediaRule).media?.mediaText ?? "";
      if (/prefers-color-scheme:\s*dark/.test(cond)) return true;
      const inner = (r as CSSGroupingRule).cssRules;
      if (inner && walk(inner)) return true;
    }
    return false;
  };
  for (const s of document.styleSheets) {
    try {
      if (walk(s.cssRules)) {
        signals.push("stylesheet rule");
        break;
      }
    } catch {
      unreadable++;
    }
  }
  if (signals.length) return { supported: true, signals };
  return { supported: unreadable ? null : false, signals: unreadable ? [`${unreadable} unreadable stylesheets`] : [] };
}

/** Colours that change when a site has a dark design: the root's, and the painted background and text colour at
 * three points of the viewport (header, centre, lower third). */
function rootColors(): Record<string, string> {
  const h = getComputedStyle(document.documentElement);
  const b = document.body ? getComputedStyle(document.body) : h;
  const out: Record<string, string> = { html: h.backgroundColor, body: b.backgroundColor, color: b.color };
  for (const [k, fy] of [["top", 0.08], ["mid", 0.5], ["low", 0.75]] as const) {
    let el = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight * fy));
    out[`${k}Color`] = el ? getComputedStyle(el).color : "";
    for (; el; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
        out[`${k}Bg`] = c;
        break;
      }
    }
  }
  return out;
}

/** A point over the page itself (not an inner scroller, not a fixed bar), for wheel events. */
function quietPoint(): { x: number; y: number } {
  const W = innerWidth;
  const H = innerHeight;
  for (const fy of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8])
    for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      const x = Math.floor(W * fx);
      const y = Math.floor(H * fy);
      const el = document.elementFromPoint(x, y);
      let inner = false;
      for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
        const s = getComputedStyle(e);
        if ((/auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1) || s.position === "fixed") {
          inner = true;
          break;
        }
      }
      if (!inner) return { x, y };
    }
  return { x: Math.floor(W / 2), y: Math.floor(H / 2) };
}

/** Centres of visible interactive elements in the viewport, for scripted hover. */
function hoverTargets(max: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const el of document.querySelectorAll('a[href], button, summary, [role="button"], [tabindex]:not([tabindex="-1"])')) {
    if (out.length >= max) break;
    if (el.closest("genclass-devtools")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const x = Math.floor(r.left + r.width / 2);
    const y = Math.floor(r.top + r.height / 2);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) continue;
    out.push({ x, y });
  }
  return out;
}

try {
  boot();
} catch (e) {
  (window as W & { __gcBenchError?: string }).__gcBenchError = String(e);
}

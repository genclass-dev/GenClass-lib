// The measured visual checks engine (docs/runtime/VISUAL.md sections 2.3, 7, 8, 9, 11): settle gates, passes in
// idle slices with budgets on the injected Clock, persistence re-checks, incremental re-checks of dirty subtrees,
// the interaction hooks, reports and the fix gate.
//
// Invariants:
// - Reads only, except fix.ts behind the fix gate (guard or heal mode, visual.fix, sampled in, visible tab). In
//   observe mode nothing on the page changes: no attributes, styles, inserted elements, scrolling or focus.
// - Time comes from host.clock and idle callbacks from host.global.requestIdleCallback (AGENTS.md rule 5). Event
//   timestamps the browser hands over (font loadingdone, layout-shift startTime) are compared only with each other.
// - Never throws into the page: every listener and timer body runs in try/catch.
// - Findings reach the runtime only through host.report / host.note / host.audit: never as RtEvents, facts or
//   situations, and they never feed a decision (AGENTS.md rule 2 exception).

import type { CheckFinding, CheckKind, Clock, VisualFixKind, VisualOptions, VisualSummary } from "../types.js";
import type { VisualController, VisualHost } from "./host.js";
import type { Ctx, Draft } from "./draft.js";
import { DIALOG_SEL, fivePoints, Reader, rootInfo, safeMatches, selectorOf, type Win } from "./measure.js";
import { fold, toFinding } from "./report.js";
import { FIX_KINDS, Fixer } from "./fix.js";
import { INVISIBLE_RATIO } from "./math.js";
import * as A from "./checks/assets.js";
import * as T from "./checks/text.js";
import * as L from "./checks/layout.js";
import * as I from "./checks/interact.js";

export const KINDS: CheckKind[] = [
  "image-broken",
  "image-css-broken",
  "media-failed",
  "stylesheet-failed",
  "font-failed",
  "icon-font-failed",
  "csp-blocked",
  "text-invisible",
  "text-template-leak",
  "text-placeholder",
  "text-encoding",
  "css-var-undefined",
  "image-distorted",
  "page-overflow-x",
  "viewport-meta-missing",
  "layout-shift",
  "page-blank",
  "click-blocked",
  "pointer-events-leak",
  "scroll-lock-stuck",
  "control-unreachable",
  "focus-obscured",
  "dialog-covered",
];

/** The near-free kinds: browser-reported facts and interaction hooks. Low-end and sampled-out sessions run only these. */
export const LIGHT = new Set<CheckKind>([
  "image-broken",
  "image-css-broken",
  "media-failed",
  "stylesheet-failed",
  "font-failed",
  "icon-font-failed",
  "csp-blocked",
  "viewport-meta-missing",
  "layout-shift",
  "click-blocked",
  "pointer-events-leak",
  "scroll-lock-stuck",
  "control-unreachable",
  "focus-obscured",
  "dialog-covered",
]);
const COLOUR = new Set<CheckKind>(["text-invisible"]);
const TEXT = new Set<CheckKind>(["text-invisible", "text-template-leak", "text-placeholder", "text-encoding", "page-overflow-x"]);
const LAYOUT = new Set<CheckKind>(["page-overflow-x", "viewport-meta-missing", "control-unreachable", "focus-obscured", "dialog-covered", "click-blocked"]);

export interface Cfg {
  checks: Record<CheckKind, boolean>;
  fix: Set<VisualFixKind>;
  /** visual.ignore as given (hosts for text-placeholder). */
  ignore: string[];
  /** The entries that are valid selectors. */
  ignoreSel: string[];
  budgetMs: number;
  passBudgetMs: number;
  maxElements: number;
  lowEnd: "light" | "full" | "off";
  sample: number;
  maxConsoleLines: number;
}

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * InitOptions.visual (object form) with defaults and clamps (VISUAL.md 7.1). Runtime fixes need `on: true`: "local"
 * (the default, and whatever ?genclass-visual=on turns on) never fixes.
 */
export function resolveCfg(o: VisualOptions, doc: Document | null): Cfg {
  const checks = {} as Record<CheckKind, boolean>;
  for (const k of KINDS) checks[k] = o.checks?.[k] !== false;
  const asked = o.on !== true ? [] : o.fix === true ? FIX_KINDS : Array.isArray(o.fix) ? o.fix.filter((k) => FIX_KINDS.includes(k)) : [];
  const fix = new Set<VisualFixKind>(asked);
  const ignore = (Array.isArray(o.ignore) ? o.ignore : []).filter((s): s is string => typeof s === "string" && !!s.trim()).slice(0, 50);
  const ignoreSel = ignore.filter((s) => {
    try {
      doc?.querySelector(s);
      return !!doc;
    } catch {
      return false;
    }
  });
  return {
    checks,
    fix,
    ignore,
    ignoreSel,
    budgetMs: clamp(num(o.budgetMs, 8), 2, 16),
    passBudgetMs: clamp(num(o.passBudgetMs, 100), 10, 2000),
    maxElements: Math.floor(clamp(num(o.maxElements, 2000), 50, 20000)),
    lowEnd: o.lowEnd === "full" || o.lowEnd === "off" ? o.lowEnd : "light",
    sample: clamp(num(o.sample, 1), 0, 1),
    maxConsoleLines: Math.floor(clamp(num(o.maxConsoleLines, 10), 0, 100)),
  };
}

/** FNV-1a: session sampling is a hash of the session id, never Math.random. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

type Abstain = { all?: string; colour?: string; text?: string; layout?: string };
type Listen = EventTarget & { addEventListener(t: string, fn: (e: Event) => void, o?: AddEventListenerOptions | boolean): void };

export class Visual implements VisualController {
  private readonly win: Win;
  private readonly doc: Document;
  private readonly clock: Clock;
  readonly cfg: Cfg;
  private tier: "full" | "light" = "full";
  private dead = false;
  private readonly stats: Omit<VisualSummary, "checks" | "checksByRoute" | "fixes"> = { passes: 0, elements: 0, ms: 0, maxSliceMs: 0, partial: 0, abstained: 0, unsupported: [], tier: "full" };
  private readonly counts: Partial<Record<CheckKind, number>> = {};
  private readonly byRoute: Record<string, Partial<Record<CheckKind, number>>> = {};
  private readonly reported = new Map<string, CheckFinding>();
  private ids = 0;
  private readonly fixer: Fixer;
  private readonly env: A.AssetEnv;
  private readonly resources = new Map<string, PerformanceResourceTiming>();
  private readonly failedCss: PerformanceResourceTiming[] = [];
  private readonly shifts: L.ShiftEntry[] = [];
  private readonly fontSwaps: number[] = [];
  private readonly rest = new WeakMap<Element, number>();
  private offs: (() => void)[] = [];
  private timers = new Set<unknown>();
  private chain: Promise<unknown> = Promise.resolve();
  private mo: MutationObserver | null = null;
  private dirty = new Set<Element>();
  private fullWanted = false;
  private dirtyTimer: unknown = null;
  private lastMut: number;
  private muts = 0;
  private settledAt: number | null = null;
  private lastFull = -Infinity;
  private budget: { start: number; spent: number };
  private slow = 1;
  private maxEl: number;
  private exempt = false;
  private route: string;
  private lastClick: { overlay: Element; at: number; muts: number; href: string; active: Element | null } | null = null;
  private rootClicks: number[] = [];
  private dragging = false;
  private stateAt = -Infinity;
  private peSince: number | null = null;
  private lockSince: number | null = null;
  private attempts = 0;
  private dialogSeen = new WeakSet<Element>();
  private dialogTries = new WeakMap<Element, number>();
  private dialogTimer: unknown = null;
  private scrollTimer: unknown = null;
  private cssVarSig = "";
  private warned = new Set<string>();

  constructor(
    private readonly host: VisualHost,
    opts: VisualOptions,
    early: Event[] = [],
    auto = true,
  ) {
    this.win = host.global as unknown as Win;
    this.doc = this.win.document;
    this.clock = host.clock;
    this.cfg = resolveCfg(opts, this.doc);
    this.maxEl = this.cfg.maxElements;
    this.lastMut = this.clock.now();
    this.budget = { start: this.clock.now(), spent: 0 };
    this.route = this.safeRoute();
    const PRT = (this.win as unknown as { PerformanceResourceTiming?: { prototype: object } }).PerformanceResourceTiming;
    this.env = {
      entry: (u) => this.entry(u),
      failedCss: () => this.failedCss,
      statusSupported: !!PRT && "responseStatus" in PRT.prototype,
      linkErrors: new WeakSet(),
      csp: [],
      fontsReadyAt: null,
    };
    this.fixer = new Fixer({
      win: this.win,
      clock: this.clock,
      audit: (f) => this.host.audit(f),
      note: (m, f, imp) => this.host.note(m, f, imp),
      warn: (m) => this.warn(m),
      quietly: (fn) => this.quietly(fn),
    });
    for (const e of early) this.onCsp(e as SecurityPolicyViolationEvent);
    if (!this.env.statusSupported) this.stats.unsupported.push("image-css-broken");
    const nav: NonNullable<Win["navigator"]> = this.win.navigator ?? {};
    const lowEndDevice = (nav.deviceMemory ?? 8) <= 2 || (nav.hardwareConcurrency ?? 8) <= 2 || !!nav.connection?.saveData;
    if (lowEndDevice && this.cfg.lowEnd === "off") {
      this.dead = true;
      return;
    }
    if (lowEndDevice && this.cfg.lowEnd === "light") this.tier = "light";
    if (this.cfg.sample < 1 && hash32(host.seed) / 4294967296 >= this.cfg.sample) this.tier = "light";
    this.stats.tier = this.tier;
    if (!this.hasLayout()) {
      // jsdom, happy-dom, hidden iframes: zero findings, nothing installed
      this.dead = true;
      return;
    }
    try {
      this.install();
    } catch {
      /* a missing API: the checks that need it stay quiet */
    }
    if (auto) void this.boot().catch(() => undefined);
  }

  // ------------------------------------------------------------------------------------------- controller

  now(): Promise<CheckFinding[]> {
    if (this.dead) return Promise.resolve([]);
    return this.enqueue(() => this.pass(null, true));
  }

  /** checkPage: wait for fonts and a settled page, then one pass with its re-checks. */
  async once(): Promise<CheckFinding[]> {
    if (this.dead) return [];
    await this.fontsReady();
    await this.settle();
    this.settledAt = this.clock.now();
    return this.now();
  }

  private async fontsReady(): Promise<void> {
    const fonts = (this.doc as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
    await Promise.race([Promise.resolve(fonts?.ready).then(() => undefined, () => undefined), this.sleep(3000)]);
    this.env.fontsReadyAt ??= this.clock.now();
  }

  summary(): { visual: VisualSummary } | null {
    if (!this.stats.passes && !this.ids) return null;
    const byRoute: Record<string, Partial<Record<CheckKind, number>>> = {};
    for (const [r, c] of Object.entries(this.byRoute)) byRoute[r] = { ...c };
    return {
      visual: {
        checks: { ...this.counts },
        checksByRoute: byRoute,
        fixes: { applied: this.fixer.applied, undone: this.fixer.undone },
        ...this.stats,
        unsupported: [...this.stats.unsupported],
        maxSliceMs: Math.round(this.stats.maxSliceMs * 10) / 10,
        ms: Math.round(this.stats.ms * 10) / 10,
      },
    };
  }

  stop(): void {
    if (this.dead) return;
    try {
      this.fixer.undoAll("the runtime stopped");
    } catch {
      /* ignore */
    }
    this.dead = true;
    for (const off of this.offs.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    for (const t of this.timers) this.clock.clearTimeout(t);
    this.timers.clear();
    this.mo?.disconnect();
    this.mo = null;
  }

  // ----------------------------------------------------------------------------------------------- setup

  private hasLayout(): boolean {
    try {
      return this.doc.documentElement.getBoundingClientRect().width > 0 && this.win.innerWidth > 0;
    } catch {
      return false;
    }
  }

  private safeRoute(): string {
    try {
      return this.host.route();
    } catch {
      return "/";
    }
  }

  private warn(m: string): void {
    if (this.warned.has(m)) return;
    this.warned.add(m);
    (this.win as unknown as { console?: Console }).console?.warn?.(`[GenClass] ${m}`);
  }

  private on(t: EventTarget | null | undefined, type: string, fn: (e: Event) => void, opts: AddEventListenerOptions): void {
    if (!t || typeof (t as Listen).addEventListener !== "function") return;
    const safe = (e: Event) => {
      if (this.dead) return;
      try {
        fn(e);
      } catch {
        /* checks never break the page */
      }
    };
    (t as Listen).addEventListener(type, safe, opts);
    this.offs.push(() => t.removeEventListener(type, safe, opts));
  }

  private install(): void {
    const doc = this.doc;
    const win = this.win as unknown as EventTarget;
    const cap = { capture: true, passive: true };
    const pas = { passive: true };
    this.on(doc, "error", (e) => this.onError(e), cap);
    this.on(doc, "load", (e) => this.onLoadEvent(e), cap);
    this.on(doc, "securitypolicyviolation", (e) => this.onCsp(e as SecurityPolicyViolationEvent), cap);
    this.on(doc, "click", (e) => this.onClick(e as MouseEvent), cap);
    this.on(doc, "pointerover", (e) => this.onState(e, "hover"), cap);
    this.on(doc, "focusin", (e) => {
      this.onState(e, "focus");
      this.onFocus(e);
    }, cap);
    this.on(doc, "pointerdown", () => (this.dragging = true), cap);
    this.on(doc, "pointerup", () => (this.dragging = false), cap);
    this.on(doc, "pointercancel", () => (this.dragging = false), cap);
    this.on(doc, "keydown", (e) => this.onKey(e as KeyboardEvent), cap);
    this.on(win, "wheel", (e) => this.onAttempt(e), cap);
    this.on(win, "touchmove", (e) => this.onAttempt(e), cap);
    this.on(win, "scroll", () => this.onScroll(), pas);
    this.on(win, "hashchange", () => this.onAnchor(), pas);
    this.on(win, "popstate", () => this.checkRoute(), pas);
    this.on(win, "resize", () => this.onResize(), pas);
    this.on(win, "pageshow", (e) => {
      if ((e as PageTransitionEvent).persisted) this.requestFull();
    }, pas);
    const fonts = (doc as Document & { fonts?: EventTarget }).fonts;
    this.on(fonts, "loadingdone", (e) => {
      if (this.fontSwaps.length < 200) this.fontSwaps.push(e.timeStamp);
    }, pas);
    const PO = this.win.PerformanceObserver;
    if (typeof PO === "function") {
      const types = (PO as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes ?? [];
      if (types.includes("layout-shift")) {
        try {
          const po = new PO((list) => {
            for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: L.ShiftEntry["sources"] })[]) {
              if (e.hadRecentInput || this.shifts.length >= 500) continue;
              this.shifts.push({ t: e.startTime, value: e.value, sources: [...(e.sources ?? [])].slice(0, 5) });
            }
          });
          po.observe({ type: "layout-shift", buffered: true });
          this.offs.push(() => po.disconnect());
        } catch {
          /* unsupported */
        }
      } else this.stats.unsupported.push("layout-shift");
      if (types.includes("resource")) {
        try {
          const po = new PO((list) => {
            for (const e of list.getEntries() as PerformanceResourceTiming[]) this.addResource(e);
          });
          po.observe({ type: "resource", buffered: true });
          this.offs.push(() => po.disconnect());
        } catch {
          /* unsupported */
        }
      }
    } else this.stats.unsupported.push("layout-shift");
    const MO = this.win.MutationObserver;
    if (typeof MO === "function") {
      this.mo = new MO((recs) => {
        try {
          this.onMutations(recs);
        } catch {
          /* ignore */
        }
      });
      this.mo.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "src", "srcset", "width", "height", "open", "data-genclass-fix"] });
    }
  }

  private addResource(e: PerformanceResourceTiming): void {
    const st = (e as { responseStatus?: number }).responseStatus;
    const failed = typeof st === "number" && st >= 400;
    if (this.resources.size < 2000 || failed) this.resources.set(e.name, e);
    if (failed && e.initiatorType === "css" && this.failedCss.length < 50) {
      try {
        if (new URL(e.name).origin === new URL(this.win.location?.href ?? "").origin) this.failedCss.push(e);
      } catch {
        /* ignore */
      }
    }
  }

  private entry(url: string): PerformanceResourceTiming | undefined {
    const e = this.resources.get(url);
    if (e) return e;
    try {
      const list = this.win.performance?.getEntriesByName(url, "resource") as PerformanceResourceTiming[] | undefined;
      return list && list.length ? list[list.length - 1] : undefined;
    } catch {
      return undefined;
    }
  }

  private async boot(): Promise<void> {
    await this.fontsReady();
    if (this.dead) return;
    await this.settle();
    if (this.dead) return;
    this.settledAt = this.clock.now();
    await this.enqueue(() => this.pass(null));
    this.tick();
    this.scheduleBlank();
    this.later(() => this.unreachable(this.isAtMax()), 0);
  }

  // ------------------------------------------------------------------------------------- timing helpers

  private later(fn: () => void, ms: number): unknown {
    const h = this.clock.setTimeout(() => {
      this.timers.delete(h);
      if (this.dead) return;
      try {
        fn();
      } catch {
        /* ignore */
      }
    }, ms);
    this.timers.add(h);
    return h;
  }

  private cancel(h: unknown): void {
    if (h === null || h === undefined) return;
    this.clock.clearTimeout(h);
    this.timers.delete(h);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => {
      const h = this.clock.setTimeout(() => {
        this.timers.delete(h);
        res();
      }, ms);
      this.timers.add(h);
    });
  }

  private idle(): Promise<{ timeRemaining(): number } | null> {
    return new Promise((res) => {
      const ric = this.win.requestIdleCallback;
      if (typeof ric === "function") {
        try {
          ric.call(this.win, (d) => res(d), { timeout: 1000 });
          return;
        } catch {
          /* fall through */
        }
      }
      const h = this.clock.setTimeout(() => {
        this.timers.delete(h);
        res(null);
      }, 0);
      this.timers.add(h);
    });
  }

  private visibleNow(): boolean {
    return this.doc.visibilityState !== "hidden" && !(this.doc as Document & { prerendering?: boolean }).prerendering;
  }

  private whenVisible(): Promise<void> {
    if (this.visibleNow()) return Promise.resolve();
    return new Promise((res) => {
      const check = () => {
        if (!this.dead && !this.visibleNow()) return;
        this.doc.removeEventListener("visibilitychange", check);
        this.doc.removeEventListener("prerenderingchange", check);
        res();
      };
      this.doc.addEventListener("visibilitychange", check);
      this.doc.addEventListener("prerenderingchange", check);
      this.offs.push(() => {
        this.doc.removeEventListener("visibilitychange", check);
        this.doc.removeEventListener("prerenderingchange", check);
      });
    });
  }

  /** VISUAL.md 2.3: network quiet and DOM quiet for 500 ms (each doubled after a slow read), capped at 10 s. */
  private async settle(): Promise<void> {
    await this.whenVisible();
    const start = this.clock.now();
    let busy = start;
    for (;;) {
      if (this.dead) return;
      const t = this.clock.now();
      if (this.host.inflight() > 0) busy = t;
      if ((t - busy >= 500 * this.slow && t - this.lastMut >= 500 * this.slow) || t - start >= 10_000) return;
      await this.sleep(100);
    }
  }

  private async quietNet(cap: number): Promise<void> {
    const start = this.clock.now();
    while (!this.dead && this.host.inflight() > 0 && this.clock.now() - start < cap) await this.sleep(250);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private overSession(): boolean {
    const now = this.clock.now();
    if (now - this.budget.start >= 600_000) this.budget = { start: now, spent: 0 };
    return this.budget.spent >= 1000;
  }

  /** Run a generator in idle slices of budgetMs until done or the pass budget is spent. */
  private async run(gen: Generator<void>, b: { spent: number; partial: boolean }): Promise<boolean> {
    for (;;) {
      if (this.dead) return false;
      const deadline = await this.idle();
      if (this.dead) return false;
      if (!this.visibleNow()) await this.whenVisible();
      const t0 = this.clock.now();
      let done = false;
      for (;;) {
        const u0 = this.clock.now();
        this.exempt = false;
        let r: IteratorResult<void>;
        try {
          r = gen.next();
        } catch {
          r = { done: true, value: undefined };
        }
        const u = this.clock.now() - u0;
        if (u > 16 && !this.exempt) {
          // one read forced a long layout: end the pass, wait longer next time, measure fewer elements
          this.slow = Math.min(8, this.slow * 2);
          this.maxEl = Math.max(50, Math.floor(this.maxEl / 2));
          this.account(this.clock.now() - t0);
          b.partial = true;
          return false;
        }
        if (r.done) {
          done = true;
          break;
        }
        const elapsed = this.clock.now() - t0;
        if (elapsed >= this.cfg.budgetMs || (deadline && deadline.timeRemaining() <= 0)) break;
      }
      const slice = this.clock.now() - t0;
      this.account(slice);
      b.spent += slice;
      if (done) return true;
      if (b.spent >= this.cfg.passBudgetMs) {
        b.partial = true;
        return false;
      }
    }
  }

  private account(ms: number): void {
    this.stats.ms += ms;
    if (ms > this.stats.maxSliceMs) this.stats.maxSliceMs = ms;
    this.budget.spent += ms;
  }

  // --------------------------------------------------------------------------------------------- context

  private mm(q: string): boolean {
    try {
      return !!this.win.matchMedia?.(q).matches;
    } catch {
      return false;
    }
  }

  /** VISUAL.md 2.2: page conditions under which measurements are not trustworthy. */
  private pageAbstain(): Abstain {
    const html = this.doc.documentElement;
    const o: Abstain = {};
    if (this.mm("print")) o.all = "print";
    if (this.mm("(forced-colors: active)")) o.colour = "forced-colors";
    else if (this.doc.querySelector('meta[name="darkreader"]') || html.hasAttribute("data-darkreader-mode") || html.hasAttribute("data-darkreader-scheme")) o.colour = "dark-reader";
    if (html.classList.contains("translated-ltr") || html.classList.contains("translated-rtl")) o.text = "translated";
    if ((this.win.visualViewport?.scale ?? 1) > 1.01) o.layout = "pinch-zoom";
    return o;
  }

  private scheme(): "light" | "dark" {
    const html = this.doc.documentElement;
    const theme = html.getAttribute("data-theme");
    if (html.classList.contains("dark") || theme === "dark") return "dark";
    if (html.classList.contains("light") || theme === "light") return "light";
    return this.mm("(prefers-color-scheme: dark)") ? "dark" : "light";
  }

  private ctx(r: Reader, ab: Abstain = this.pageAbstain()): Ctx {
    return {
      r,
      win: this.win,
      now: this.clock.now(),
      scheme: this.scheme(),
      describe: (el) => {
        try {
          return this.host.describe(el);
        } catch {
          return el.tagName.toLowerCase();
        }
      },
      sel: (el) => selectorOf(el, this.win).selector,
      abstain: () => {
        this.stats.abstained++;
      },
      on: (k) =>
        this.cfg.checks[k] && (this.tier === "full" || LIGHT.has(k)) && !ab.all && !(ab.colour && COLOUR.has(k)) && !(ab.text && TEXT.has(k)) && !(ab.layout && LAYOUT.has(k)),
      max: this.maxEl,
      ignore: this.cfg.ignore,
    };
  }

  private reader(): Reader {
    return new Reader(this.win, this.cfg.ignoreSel);
  }

  /** The runtime is on for this page: not destroyed, not paused, enabled, the route not off. */
  private live(): boolean {
    return !this.dead && this.host.active() && this.host.mode() !== "off";
  }

  // ------------------------------------------------------------------------------------------------ passes

  private async pass(roots: Element[] | null, manual = false): Promise<CheckFinding[]> {
    if (!this.live()) return [];
    if (!this.visibleNow()) await this.whenVisible();
    const ab = this.pageAbstain();
    if (ab.all) {
      this.stats.abstained++;
      return [];
    }
    if (!manual && roots && this.overSession()) {
      this.stats.stopped = true;
      return [];
    }
    const body = this.doc.body;
    if (!body) return [];
    const full = !roots;
    const rts = roots ?? [body];
    const r = this.reader();
    const ctx = this.ctx(r, ab);
    const drafts: Draft[] = [];
    const scan = T.newScan();
    const env = this.env;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    function* steps(): Generator<void> {
      yield* A.brokenImages(ctx, env, rts, drafts);
      yield* A.failedMedia(ctx, rts, drafts);
      if (full) {
        yield* A.failedStylesheets(ctx, env, drafts);
        yield* A.failedFonts(ctx, env, drafts);
        yield* A.failedIconFonts(ctx, env, drafts);
        yield;
        A.cspBlocked(ctx, env, drafts);
        yield;
        L.viewportMeta(ctx, drafts);
        yield;
        L.layoutShifts(ctx, self.shifts, self.fontSwaps, drafts);
        yield* A.brokenCssImages(ctx, env, drafts);
        yield* L.pageOverflow(ctx, drafts);
        yield* self.cssVars(ctx, drafts);
      }
      yield* L.distortedImages(ctx, rts, drafts);
      const text = ctx.on("text-template-leak") || ctx.on("text-placeholder") || ctx.on("text-encoding");
      if (text || ctx.on("text-invisible")) {
        yield* T.walkText(ctx, rts, scan, 5000, ctx.on("text-invisible"));
        T.placeholderImages(ctx, rts, scan);
        T.patternDrafts(ctx, scan, drafts);
        yield* T.measureContrast(ctx, scan.cands, drafts, self.rest);
      }
      yield;
      self.dialogs(ctx, drafts);
    }
    const b = { spent: 0, partial: false };
    const done = await this.run(steps(), b);
    this.stats.passes++;
    this.stats.elements += r.reads;
    this.stats.abstained += scan.weak;
    if (!done) this.stats.partial++;
    if (full) this.lastFull = this.clock.now();
    return this.confirm(drafts);
  }

  /** Persistence (VISUAL.md 2.3): re-measure the drafts that need it, then report the confirmed ones. */
  private async confirm(drafts: Draft[]): Promise<CheckFinding[]> {
    const out: Draft[] = drafts.filter((d) => !d.recheck);
    const pending = drafts.filter((d) => d.recheck);
    if (pending.length) {
      const wait = Math.max(0, ...pending.map((d) => d.persistMs ?? 0));
      if (wait) await this.sleep(wait * Math.min(2, this.slow));
      if (pending.some((d) => d.quiet)) await this.quietNet(5000);
      if (this.dead || !this.live()) return [];
      const r = this.reader();
      const asyncs: Promise<Draft | null>[] = [];
      function* rechecks(): Generator<void> {
        for (const d of pending) {
          yield;
          const res = d.recheck!(r);
          if (res && typeof (res as Promise<Draft | null>).then === "function") asyncs.push(res as Promise<Draft | null>);
          else if (res) out.push(res as Draft);
        }
      }
      await this.run(rechecks(), { spent: 0, partial: false });
      for (const a of await Promise.all(asyncs.map((p) => p.catch(() => null)))) if (a) out.push(a);
    }
    return this.publish(out);
  }

  private publish(drafts: Draft[]): CheckFinding[] {
    const out: CheckFinding[] = [];
    let printed = 0;
    let quiet = 0;
    let last: CheckFinding | null = null;
    for (const d of fold(drafts)) {
      if (this.dead) break;
      if (!d.text) continue;
      const key = `${d.key}|${this.route}`;
      const known = this.reported.get(key);
      if (known) {
        out.push(known);
        continue;
      }
      const f = this.finding(d);
      if (this.reported.size >= 1000) this.reported.delete(this.reported.keys().next().value as string);
      this.reported.set(key, f);
      this.count(f);
      this.maybeFix(d, f, key);
      const loud = printed < this.cfg.maxConsoleLines;
      if (loud) printed++;
      else quiet++;
      try {
        this.host.report(f, loud);
        if (f.fix?.applied) this.host.note(`[GenClass] Applied a CSS fix for check ${f.id}: ${f.fix.css}. Undo: GenClass.runtime.checks().find(c => c.id === "${f.id}").fix.undo()`, f, true);
      } catch {
        /* reporting never breaks the page */
      }
      last = f;
      out.push(f);
    }
    if (quiet && last) this.host.note(`[GenClass] ${quiet} more measured check${quiet === 1 ? "" : "s"}: GenClass.runtime.checks() or the devtools Checks tab.`, last, false);
    return out;
  }

  private finding(d: Draft): CheckFinding {
    const el = d.el;
    const s = el ? selectorOf(el, this.win) : { selector: "page", structural: false };
    let target = "page";
    if (el) {
      try {
        target = this.host.describe(el);
      } catch {
        target = s.selector;
      }
    }
    return toFinding(d, {
      id: `c${++this.ids}`,
      at: this.clock.now(),
      route: this.route,
      scheme: this.scheme(),
      viewport: { w: this.win.innerWidth, h: this.win.innerHeight },
      coarse: this.mm("(pointer: coarse)"),
      tier: this.tier,
      target,
      selector: s.selector,
      structural: s.structural,
    });
  }

  private count(f: CheckFinding): void {
    this.counts[f.kind] = (this.counts[f.kind] ?? 0) + 1;
    const r = this.route;
    if (!this.byRoute[r] && Object.keys(this.byRoute).length >= 20) return;
    const c = (this.byRoute[r] ??= {});
    c[f.kind] = (c[f.kind] ?? 0) + 1;
  }

  // -------------------------------------------------------------------------------------------------- fixes

  /** VISUAL.md 11.1: why a fix may not run now (null: it may). */
  private fixGate(kind: VisualFixKind, key: string): string | null {
    if (!this.cfg.fix.has(kind)) return "not enabled (visual.fix)";
    const m = this.host.mode();
    if (m !== "guard" && m !== "heal") return `the mode here is ${m}; fixes run only in guard or heal mode`;
    if (!this.host.sampled()) return "this session is sampled out";
    if (!this.visibleNow()) return "the tab is hidden";
    if (!this.host.active()) return "GenClass is paused";
    const ab = this.pageAbstain();
    if (ab.all || (kind === "text-invisible" && ab.colour)) return `the page cannot be measured reliably (${ab.all ?? ab.colour})`;
    if (!this.fixer.allowed(kind, key)) return "fixes of this kind are off for this session or page";
    return null;
  }

  private maybeFix(d: Draft, f: CheckFinding, key: string): void {
    const plan = d.plan;
    if (!plan) return;
    const i = f.details.findIndex((l) => l.startsWith("Runtime fix:"));
    const set = (line: string) => {
      if (i >= 0) f.details[i] = line;
      else f.details.splice(Math.max(0, f.details.length - 2), 0, line);
    };
    const why = this.fixGate(plan.kind, key);
    if (why) {
      if (this.cfg.fix.has(plan.kind)) set(`Runtime fix: not applied (${why}).`);
      return;
    }
    f.fix = this.fixer.apply(plan, f, key, () => this.verifyFix(d));
    set(f.fix.applied ? `Runtime fix: applied (${f.fix.css}). Undo: GenClass.runtime.checks().find(c => c.id === "${f.id}").fix.undo()` : `Runtime fix: not applied (${f.fix.reason}).`);
  }

  /** Re-measure after a fix (VISUAL.md 11.2): the threshold must be cleared, else the fix is undone. */
  private verifyFix(d: Draft): boolean {
    const plan = d.plan!;
    const r = this.reader();
    if (plan.type === "color") {
      const read = T.readContrast(this.ctx(r), r, plan.el, rootInfo(r));
      return !!read && read.v.verdict !== "unknown" && read.v.ratio >= plan.target;
    }
    const s = r.cs(plan.el);
    return plan.kind === "pointer-events-leak" ? s.pointerEvents !== "none" : s.overflowY !== "hidden" && s.overflowY !== "clip";
  }

  /** Mode, enabled, breaker, pause: when fixes are no longer allowed, every fix is undone. */
  gateFixes(): void {
    if (this.dead || !this.fixer.active) return;
    const m = this.host.mode();
    if (m !== "guard" && m !== "heal") this.fixer.undoAll(`the mode is now ${m}`);
    else if (!this.host.active()) this.fixer.undoAll("GenClass was paused");
    else if (!this.host.sampled()) this.fixer.undoAll("this session is sampled out");
  }

  private quietly(fn: () => void): void {
    if (this.mo) this.onMutations(this.mo.takeRecords());
    fn();
    this.mo?.takeRecords();
  }

  // ------------------------------------------------------------------------------------- dirty tracking

  private onMutations(recs: MutationRecord[]): void {
    if (!recs.length) return;
    this.fixer.watch(recs);
    const doc = this.doc;
    let counted = false;
    let dialogs = false;
    for (const m of recs) {
      if (m.type === "attributes" && m.attributeName === "data-genclass-fix") continue;
      const t = m.target;
      const el = t.nodeType === 1 ? (t as Element) : t.parentElement;
      if (!el || el.closest("[data-genclass-ignore]")) continue;
      counted = true;
      if ((el === doc.documentElement || el === doc.body) && m.type === "attributes") {
        if (m.attributeName === "class" || m.attributeName === "style") this.fullWanted = true;
        continue;
      }
      if (m.type === "childList") {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const e = n as Element;
          this.dirty.add(e);
          if (safeMatches(e, DIALOG_SEL) || e.querySelector?.(DIALOG_SEL)) dialogs = true;
        }
        if (m.addedNodes.length && [...m.addedNodes].some((n) => n.nodeType === 3)) this.dirty.add(el);
      } else {
        this.dirty.add(el);
        if (m.type === "attributes" && safeMatches(el, DIALOG_SEL)) dialogs = true;
      }
    }
    if (!counted) return;
    this.muts++;
    this.lastMut = this.clock.now();
    if (this.dirty.size > 200) {
      this.dirty.clear();
      this.fullWanted = true;
    }
    if (dialogs) this.dialogSoon();
    if (this.settledAt !== null) this.scheduleDirty();
  }

  private scheduleDirty(delay = 1000): void {
    this.cancel(this.dirtyTimer);
    this.dirtyTimer = this.later(() => {
      this.dirtyTimer = null;
      this.flushDirty();
    }, delay);
  }

  private requestFull(): void {
    this.fullWanted = true;
    if (this.settledAt !== null) this.scheduleDirty();
  }

  /** VISUAL.md 8 step 6: after 1 s of quiet, re-check only the dirty subtrees; a full pass at most every 30 s. */
  private flushDirty(): void {
    if (!this.live()) return;
    if (this.overSession()) {
      this.stats.stopped = true;
      return;
    }
    const now = this.clock.now();
    if (this.fullWanted) {
      if (now - this.lastFull < 30_000) {
        this.scheduleDirty(30_000 - (now - this.lastFull));
        return;
      }
      this.fullWanted = false;
      this.dirty.clear();
      void this.enqueue(() => this.pass(null));
      return;
    }
    const roots = [...this.dirty].filter((e) => e.isConnected);
    this.dirty.clear();
    if (!roots.length) return;
    const top = roots.filter((e) => !roots.some((o) => o !== e && o.contains(e)));
    if (top.length > 50) {
      this.requestFull();
      return;
    }
    void this.enqueue(() => this.pass(top));
  }

  private checkRoute(): void {
    const r = this.safeRoute();
    if (r === this.route) return;
    this.route = r;
    this.fixer.newPage();
    this.lastClick = null;
    this.requestFull();
    this.scheduleBlank();
  }

  private onResize(): void {
    this.cancel(this.scrollTimer);
    this.scrollTimer = this.later(() => {
      if (!this.live() || !this.settledAt) return;
      void this.enqueue(async () => {
        const r = this.reader();
        const ctx = this.ctx(r);
        const drafts: Draft[] = [];
        const b = { spent: 0, partial: false };
        await this.run(L.pageOverflow(ctx, drafts), b);
        return this.confirm(drafts);
      });
    }, 1000);
  }

  // ------------------------------------------------------------------------------------- asset events

  private onError(e: Event): void {
    const t = e.target as Element | null;
    if (!t || t.nodeType !== 1) return;
    const tag = t.tagName;
    if (tag === "LINK") this.env.linkErrors.add(t);
    if (tag === "IMG" || tag === "VIDEO" || tag === "AUDIO" || tag === "SOURCE") {
      this.dirty.add(tag === "SOURCE" && t.parentElement ? t.parentElement : t);
      if (this.settledAt !== null) this.scheduleDirty();
    }
  }

  private onLoadEvent(e: Event): void {
    const t = e.target as Element | null;
    if (t && t.nodeType === 1 && t.tagName === "IMG" && this.settledAt !== null) {
      this.dirty.add(t);
      this.scheduleDirty();
    }
  }

  private onCsp(e: SecurityPolicyViolationEvent): void {
    if (this.env.csp.length < 200) this.env.csp.push(e);
    const d = e.effectiveDirective || e.violatedDirective || "";
    if (d.startsWith("style-src")) this.fixer.cspBlocked();
    if (this.settledAt !== null && A.cspReportable(e)) this.requestFull();
  }

  // ------------------------------------------------------------------------------------- interactions

  private report(drafts: Draft[]): void {
    if (!drafts.length) return;
    void this.enqueue(() => this.confirm(drafts));
  }

  private onClick(e: MouseEvent): void {
    if (!e.isTrusted || !this.settledAt || !this.live()) return;
    const t = e.target as Element | null;
    if (!t || t.nodeType !== 1 || t.closest("genclass-devtools")) return;
    const now = this.clock.now();
    if (t === this.doc.documentElement || t === this.doc.body) {
      this.rootClicks = [...this.rootClicks.filter((x) => now - x <= 10_000), now];
    }
    if (t.closest('a[href^="#"]')) this.later(() => this.onAnchor(), 400);
    const r = this.reader();
    const ctx = this.ctx(r);
    if (!ctx.on("click-blocked") || e.detail === 0 || this.dragging) {
      this.lastClick = null;
      return;
    }
    const c = I.clickBlockedRead(r, t, e.clientX, e.clientY);
    if (!c || this.doc.querySelector('[aria-busy="true"], [aria-expanded="true"]') || this.host.inflight() > 0) {
      this.lastClick = null;
      return;
    }
    const href = String(this.win.location?.href ?? "");
    const prev = this.lastClick;
    if (prev && prev.overlay === c.overlay && now - prev.at <= 3000 && prev.muts === this.muts && prev.href === href && prev.active === this.doc.activeElement) {
      this.lastClick = null;
      this.report([I.clickBlockedDraft(ctx, c)]);
      return;
    }
    const snap = { overlay: c.overlay, at: now, muts: this.muts, href, active: this.doc.activeElement };
    this.lastClick = snap;
    // the click's own focus change has happened once the event is done: compare against that
    this.later(() => {
      snap.active = this.doc.activeElement;
    }, 0);
  }

  /** text-invisible on hover and focus (VISUAL.md 3.8 States): readable at rest, unreadable in the state. */
  private onState(e: Event, which: "hover" | "focus"): void {
    if (!this.settledAt || !this.live()) return;
    const now = this.clock.now();
    if (now - this.stateAt < 500) return;
    const t = e.target as Element | null;
    if (!t || t.nodeType !== 1) return;
    const ctl = t.closest('a, button, summary, [role="button"], [tabindex]');
    if (!ctl || ctl.closest("genclass-devtools")) return;
    if (which === "focus" && !safeMatches(ctl, ":focus-visible")) return;
    const r0 = this.reader();
    if (!this.ctx(r0).on("text-invisible")) return;
    this.stateAt = now;
    const wait = Math.min(1000, transitionMs(r0.cs(ctl)));
    const state = which === "focus" ? "focus" : (e as PointerEvent).pointerType === "touch" ? "touch" : "hover";
    const holds = () => safeMatches(ctl, which === "hover" ? ":hover" : ":focus-visible");
    const els = [ctl, ...ctl.querySelectorAll("*")].filter((x) => [...x.childNodes].some((n) => n.nodeType === 3 && (n as Text).data.trim())).slice(0, 5);
    const measure = (): { el: Element; read: T.ContrastRead; rest: number }[] => {
      const r = this.reader();
      const ctx = this.ctx(r);
      const rootI = rootInfo(r);
      const out: { el: Element; read: T.ContrastRead; rest: number }[] = [];
      for (const el of els) {
        const rest = this.rest.get(el);
        if (rest === undefined || rest < INVISIBLE_RATIO) continue;
        const read = T.readContrast(ctx, r, el, rootI);
        if (read && read.v.verdict === "low") out.push({ el, read, rest });
      }
      return out;
    };
    this.later(() => {
      if (!holds()) return;
      const first = measure();
      if (!first.length) return;
      this.later(() => {
        if (!holds()) return;
        const again = measure();
        if (!again.length) return;
        const ctx = this.ctx(this.reader());
        this.report(again.map((x) => T.contrastDraft(ctx, x.el, x.read, state, x.rest)));
      }, 250);
    }, wait);
  }

  private onFocus(e: Event): void {
    const t = e.target as Element | null;
    if (!t || t.nodeType !== 1 || !this.settledAt || !safeMatches(t, ":focus-visible")) return;
    this.later(() => this.testObscured(t, "focus"), 150);
  }

  private onAnchor(): void {
    if (!this.settledAt) return;
    const h = this.win.location?.hash ?? "";
    if (!h || h === "#") return;
    let id = h.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* raw */
    }
    let el: Element | null = this.doc.getElementById(id);
    if (!el) return;
    if (el.getBoundingClientRect().height === 0) el = [...el.querySelectorAll("*")].find((x) => x.getBoundingClientRect().height > 0) ?? el;
    const target = el;
    this.later(() => this.testObscured(target, "anchor"), 400);
  }

  private testObscured(t: Element, trigger: "focus" | "anchor"): void {
    if (!this.live() || !t.isConnected) return;
    const r = this.reader();
    const ctx = this.ctx(r);
    if (!ctx.on("focus-obscured") || I.skipFocusTarget(r, t) || !r.visible(t)) return;
    const pts = (rr: Reader) => (trigger === "focus" ? fivePoints(rr.rect(t)) : I.topEdgePoints(rr.rect(t)));
    const o = I.obscuredRead(r, t, pts(r), 3);
    if (!o) return;
    const d = I.obscuredDraft(ctx, t, o, trigger);
    d.persistMs = 400;
    d.recheck = (r2) => {
      const o2 = I.obscuredRead(r2, t, pts(r2), 3);
      return o2 ? I.obscuredDraft(ctx, t, o2, trigger) : null;
    };
    this.report([d]);
  }

  private isAtMax(): boolean {
    const de = this.doc.documentElement;
    return this.win.scrollY + this.win.innerHeight >= de.scrollHeight - 2;
  }

  private onScroll(): void {
    if (!this.settledAt) return;
    this.cancel(this.scrollTimer);
    this.scrollTimer = this.later(() => {
      if (this.isAtMax()) this.unreachable(true);
    }, 500);
  }

  private unreachable(atMax: boolean): void {
    if (!this.live()) return;
    const r = this.reader();
    const ctx = this.ctx(r);
    if (!ctx.on("control-unreachable")) return;
    const drafts: Draft[] = [];
    for (const c of I.controlsInView(r, this.maxEl)) {
      const u = I.unreachableRead(r, c, atMax);
      if (!u) continue;
      const d = I.unreachableDraft(ctx, c, u);
      d.persistMs = 1000;
      d.recheck = (r2) => {
        const u2 = I.unreachableRead(r2, c, this.isAtMax());
        return u2 ? I.unreachableDraft(ctx, c, u2) : null;
      };
      drafts.push(d);
    }
    this.report(drafts);
  }

  private onKey(e: KeyboardEvent): void {
    if (this.lockSince === null || !["PageDown", " ", "ArrowDown", "End", "Spacebar"].includes(e.key)) return;
    const t = e.target as Element | null;
    if (t && t.nodeType === 1 && (safeMatches(t, "input, textarea, select, [contenteditable], [contenteditable] *") || innerScroller(this.reader(), t))) return;
    this.attempt();
  }

  private onAttempt(e: Event): void {
    if (this.lockSince === null) return;
    const t = e.target as Element | null;
    if (t && t.nodeType === 1 && innerScroller(this.reader(), t)) return;
    this.attempt();
  }

  private attempt(): void {
    if (this.lockSince === null) return;
    const y = this.win.scrollY;
    const m = this.muts;
    this.later(() => {
      if (this.win.scrollY === y && this.muts === m) this.attempts++;
    }, 300);
  }

  private tick(): void {
    this.later(() => {
      this.periodic();
      this.tick();
    }, 2000);
  }

  /** VISUAL.md 3.19, 3.20: two computed-style reads every 2 s while visible; route changes; the fix gate. */
  private periodic(): void {
    if (!this.visibleNow()) return;
    this.checkRoute();
    this.gateFixes();
    if (!this.live()) return;
    this.fixer.checkSheet();
    const r = this.reader();
    const ctx = this.ctx(r);
    const l = I.lockRead(r);
    const now = this.clock.now();
    const open = I.openOverlay(r, false);
    if (open && this.fixer.active) this.fixer.dropInline("a dialog or menu opened, so the app owns html and body again");
    if (l.pointer && ctx.on("pointer-events-leak") && !this.dragging && !open) {
      this.peSince ??= now;
      const clicks = this.rootClicks.filter((t) => now - t <= 10_000).length;
      if (now - this.peSince >= 1000 && (l.pointer.inline || clicks > 0)) this.report([I.pointerLeakDraft(ctx, l.pointer, now - this.peSince, clicks)]);
    } else this.peSince = null;
    if (l.scroll && l.tall && ctx.on("scroll-lock-stuck") && !open && !I.openOverlay(r, true)) {
      this.lockSince ??= now;
      if (now - this.lockSince >= 1000 && this.attempts > 0) this.report([I.scrollLockDraft(ctx, l.scroll, this.attempts)]);
    } else {
      this.lockSince = null;
      this.attempts = 0;
    }
  }

  private scheduleBlank(): void {
    this.later(() => void this.blank(), 3000);
  }

  /** VISUAL.md 3.17: settle + 3 s, again 2 s later with nothing in flight (waiting at most 10 s more). */
  private async blank(): Promise<void> {
    if (!this.live()) return;
    const sel = (el: Element) => selectorOf(el, this.win).selector;
    const r = this.reader();
    if (!this.ctx(r).on("page-blank")) return;
    const b = L.blankRead(r, sel);
    if (!b || b.content) return;
    await this.sleep(2000);
    for (let i = 0; i < 10 && this.host.inflight() > 0 && !this.dead; i++) await this.sleep(1000);
    if (this.dead || this.host.inflight() > 0) return;
    const r2 = this.reader();
    const b2 = L.blankRead(r2, sel);
    if (!b2 || b2.content) return;
    const ctx = this.ctx(r2);
    void this.enqueue(() => Promise.resolve(this.publish([L.blankDraft(ctx, b2, this.host.errors())])));
  }

  private dialogSoon(): void {
    if (this.settledAt === null) return;
    this.cancel(this.dialogTimer);
    this.dialogTimer = this.later(() => {
      this.dialogTimer = null;
      if (!this.live()) return;
      void this.enqueue(() => {
        const drafts: Draft[] = [];
        this.dialogs(this.ctx(this.reader()), drafts);
        return this.confirm(drafts);
      });
    }, 300);
  }

  private dialogs(ctx: Ctx, out: Draft[]): void {
    if (!ctx.on("dialog-covered")) return;
    for (const d of this.doc.querySelectorAll(DIALOG_SEL)) if (this.dialogSeen.has(d) && !ctx.r.visible(d)) this.dialogSeen.delete(d);
    for (const dlg of I.dialogsToTest(ctx.r)) {
      if (this.dialogSeen.has(dlg)) continue;
      if (ctx.r.animating(dlg)) {
        const n = (this.dialogTries.get(dlg) ?? 0) + 1;
        this.dialogTries.set(dlg, n);
        if (n <= 5) this.dialogSoon();
        continue;
      }
      this.dialogSeen.add(dlg);
      const read = I.dialogRead(ctx.r, dlg);
      if (!I.dialogReportable(read)) continue;
      const d = I.dialogDraft(ctx, dlg, read);
      d.persistMs = 500;
      d.recheck = (r) => {
        const again = I.dialogRead(r, dlg);
        return I.dialogReportable(again) ? I.dialogDraft(ctx, dlg, again) : null;
      };
      out.push(d);
    }
  }

  private *cssVars(ctx: Ctx, out: Draft[]): Generator<void> {
    if (!ctx.on("css-var-undefined")) return;
    const sig = `${this.doc.styleSheets.length}|${(this.doc as Document & { adoptedStyleSheets?: unknown[] }).adoptedStyleSheets?.length ?? 0}`;
    if (sig === this.cssVarSig) return;
    this.cssVarSig = sig;
    yield;
    this.exempt = true;
    T.cssVarDrafts(ctx, out);
  }
}

/** The longest transition for color or background-color (or all), duration plus delay, in ms. */
export function transitionMs(s: CSSStyleDeclaration): number {
  const props = (s.transitionProperty || "").split(",").map((x) => x.trim());
  const dur = (s.transitionDuration || "0s").split(",").map(toMs);
  const del = (s.transitionDelay || "0s").split(",").map(toMs);
  let max = 0;
  props.forEach((p, i) => {
    if (p === "all" || p === "color" || p === "background-color" || p === "background") max = Math.max(max, (dur[i % dur.length] ?? 0) + (del[i % del.length] ?? 0));
  });
  return max;
}

function toMs(v: string): number {
  const t = v.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return 0;
  return t.endsWith("ms") ? n : n * 1000;
}

/** The target is inside a container that scrolls on its own (scroll attempts there are not about the page). */
export function innerScroller(r: Reader, el: Element): boolean {
  for (let x: Element | null = el; x && x !== r.doc.body && x !== r.doc.documentElement; x = x.parentElement) {
    const s = r.cs(x);
    if (/auto|scroll/.test(s.overflowY) && x.scrollHeight > x.clientHeight + 1) return true;
  }
  return false;
}

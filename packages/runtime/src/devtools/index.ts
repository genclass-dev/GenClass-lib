// @genclass/runtime/devtools: the in-page overlay that shows exactly what GenClass observed and changed.
//
//   import { mountDevtools } from "@genclass/runtime/devtools";
//   const devtools = mountDevtools(GenClass.runtime!, { position: "bottom-right" });
//
// Vanilla DOM in an open shadow root (no framework, no global styles). It only reads the public Runtime API
// (status, mode, interventions, decisions, history, explain, situation, inflight, on) and calls setMode and
// ActionRecord.undo when the developer clicks them. The host element carries `data-genclass-ignore` so the
// runtime's DOM observer does not record clicks inside the overlay as app user actions.

import type {
  ActionRecord,
  Answer,
  CheckFinding,
  Clock,
  Decision,
  EffectiveGates,
  Explanation,
  Learned,
  LearnedFlow,
  Mode,
  ModelStatus,
  Op,
  Report,
  RtEvent,
  Runtime,
  RuntimeEvents,
  Situation,
  StoreInfo,
  TriggerKind,
} from "../types.js";
import { CSS } from "./css.js";
import {
  actTitle,
  ago,
  answerRows,
  clockT,
  dataLines,
  diagP,
  diagTitle,
  diagTone,
  dur,
  eventText,
  groupOf,
  h,
  icon,
  kindLabel,
  linesOf,
  mark,
  mb,
  opDuration,
  opStatus,
  pct,
  repeatKey,
  safeJson,
  setDoc,
  splitReport,
  topFact,
  type Group,
  type IconName,
  type Kid,
} from "./ui.js";

export type DevtoolsPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left";
export type DevtoolsTab = "interventions" | "detections" | "checks" | "activity" | "now" | "expectations";

export interface DevtoolsOptions {
  /** Corner of the viewport. Default "bottom-right". */
  position?: DevtoolsPosition;
  /** Start as the small pill (default true); false opens the panel immediately. */
  collapsed?: boolean;
  /**
   * Default "dark": genclass.dev's black design, whatever the page's or the OS's theme. "light" is the same design on
   * white; "auto" follows prefers-color-scheme (light or dark) live.
   */
  theme?: "auto" | "light" | "dark";
  /** Initially selected view. Default "interventions". */
  tab?: DevtoolsTab;
  /** Alt+Shift+G toggles the panel. Default true. */
  hotkey?: boolean;
  /** Where to attach the overlay host. Default document.body. */
  container?: HTMLElement;
}

export interface DevtoolsHandle {
  open(): void;
  close(): void;
  toggle(): void;
  unmount(): void;
  /** The overlay's host element (its shadow root holds the UI), or null when there is no DOM. */
  readonly element: HTMLElement | null;
}

/** Mount the GenClass devtools overlay for a runtime. Returns a no-op handle when there is no DOM (SSR). */
export function mountDevtools(runtime: Runtime, options: DevtoolsOptions = {}): DevtoolsHandle {
  const doc = options.container?.ownerDocument ?? (globalThis as { document?: Document }).document;
  if (!doc || !runtime) return { open() {}, close() {}, toggle() {}, unmount() {}, element: null };
  return new Devtools(runtime, doc, options).handle;
}

// -------------------------------------------------------------------------------------------- internals

type G = typeof globalThis & {
  requestAnimationFrame?: (fn: () => void) => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
};
const g = globalThis as G;
// Captured at module load so the overlay's own scheduling never goes through instrumented timers.
const rawRaf = g.requestAnimationFrame?.bind(g);
const rawSetTimeout = g.setTimeout?.bind(g);

const TABS: [DevtoolsTab, string][] = [
  ["interventions", "Interventions"],
  ["detections", "Detections"],
  ["checks", "Checks"],
  ["activity", "Activity"],
  ["expectations", "Expectations"],
  ["now", "Now"],
];
const MODES: [Mode, string, string][] = [
  ["observe", "Observe", "Observe (default): never changes execution; reports what GenClass would have done"],
  ["guard", "Guard", "Guard (opt-in): prevents only extremely-high-confidence failures with minimal actions (drop, defer, coalesce, delay)"],
  ["heal", "Heal", "Heal (experimental): broader autonomous recovery (retry, cached responses, rollback, resync)"],
];
const FILTERS: [Group, string][] = [
  ["user", "User"],
  ["op", "Ops"],
  ["state", "State"],
  ["error", "Errors"],
  ["gc", "GenClass"],
  ["other", "Other"],
];
const QLABEL: Record<string, string> = { diagnosis: "Diagnosis", action: "Action" };
// a measured check's kind in words, on its card and in the pill's label (the kind itself stays on the card)
const CHECK_TITLE: Record<string, string> = {
  "text-invisible": "Invisible text",
  "text-low-contrast": "Hard-to-read text",
  "scroll-lock-stuck": "Page cannot scroll",
  "pointer-events-leak": "Page stopped taking clicks",
  "click-blocked": "Clicks blocked by an invisible layer",
  "dialog-covered": "Dialog covered",
  "focus-obscured": "Focused control hidden",
  "ad-heavy": "Ads covering content",
  "page-blank": "Blank page",
};
const qrank = (q: string): number => (q === "diagnosis" ? 0 : q === "action" ? 1 : 2);

const MAX_CARDS = 200;
const MAX_ROWS = 400;
const STATUS = 1;
const MODE = 2;
const LISTS = 4;
const EVENTS = 8;
const ALL = 15;

interface Entry {
  kind: "act" | "det";
  /** Action id (act) or decision id (det). */
  id: string;
  at: number;
  action?: ActionRecord;
  decision?: Decision;
  open: boolean;
  dirty: boolean;
  fresh: boolean;
  /** Repeated identical detections folded into this card. */
  count: number;
  key?: string;
  undone?: boolean;
  undoErr?: string;
  /** Cached explain() result (null: not available). */
  ex?: Explanation | null;
  el?: HTMLElement;
}

interface OpRow {
  el: HTMLElement;
  x: HTMLElement;
  start: number;
}

/** Keep a Map (insertion-ordered) to its newest `max` entries; `drop` sees evicted values. */
function bound<K, V>(m: Map<K, V>, max: number, drop?: (v: V) => void): void {
  for (const [k, v] of m) {
    if (m.size <= max) break;
    m.delete(k);
    drop?.(v);
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let instances = 0;

class Devtools {
  readonly handle: DevtoolsHandle;
  private readonly host: HTMLElement;
  private readonly sr: ShadowRoot;
  private readonly pill: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly st: HTMLElement;
  private readonly stB: HTMLElement;
  private readonly stM: HTMLElement;
  private readonly sbi: HTMLElement;
  private readonly pb: HTMLElement;
  private readonly pbi: HTMLElement;
  private readonly pm: HTMLElement;
  private readonly pcA: HTMLElement;
  private readonly pcD: HTMLElement;
  private readonly pcC: HTMLElement;
  private readonly nA: HTMLElement;
  private readonly nD: HTMLElement;
  private readonly pauseBtn: HTMLElement;
  private readonly pz: HTMLElement;
  private readonly pzT: HTMLElement;
  private readonly modeBtns: HTMLElement[];
  private readonly tabBtns: HTMLElement[];
  private readonly panes: Record<DevtoolsTab, HTMLElement>;
  private readonly listA: HTMLElement;
  private readonly listD: HTMLElement;
  private readonly emptyA: HTMLElement;
  private readonly emptyD: HTMLElement;
  private readonly emptyE: HTMLElement;
  private readonly listC: HTMLElement;
  private readonly emptyC: HTMLElement;
  private readonly nC: HTMLElement;
  /** Measured visual checks (rt.checks(), the "check" event), newest last. */
  private chks = new Map<string, { f: CheckFinding; el?: HTMLElement; dirty: boolean }>();
  private hlBox: HTMLElement | null = null;
  private readonly evs: HTMLElement;
  private readonly nowEl: HTMLElement;
  private readonly expEl: HTMLElement;

  private isOpen = false;
  private tab: DevtoolsTab;
  private paused = false;
  private dead = false;
  private acts = new Map<string, Entry>();
  private dets = new Map<string, Entry>();
  /** decision id -> detection card id (repeats share a card) */
  private detOf = new Map<string, string>();
  private decs = new Map<string, Decision>();
  /** decision id -> action id */
  private actOf = new Map<string, string>();
  /** action or decision id -> the runtime's report sentence */
  private msgs = new Map<string, string>();
  private evq: RtEvent[] = [];
  private rows: HTMLElement[] = [];
  private rowEvents = new WeakMap<HTMLElement, RtEvent[]>();
  /** event seq -> row (the runtime re-emits a typing burst's event as it grows) */
  private rowBySeq = new Map<number, HTMLElement>();
  private opRows = new Map<number, OpRow>();
  /** op id -> short description, to name causes in expanded activity rows */
  private opNames = new Map<number, string>();
  private hide = new Set<Group>();
  private query = "";
  private unseen = 0;
  private offs: (() => void)[] = [];
  private clock: Clock | null = null;
  private lastT = 0;
  private bits = 0;
  private scheduled = false;
  private ticking = false;
  private ticks = 0;
  private scrolledActivity = false;

  constructor(
    private readonly rt: Runtime,
    private readonly doc: Document,
    private readonly o: DevtoolsOptions,
  ) {
    setDoc(doc);
    this.tab = o.tab ?? "interventions";
    const pos = o.position ?? "bottom-right";
    const [vert, horiz] = pos.split("-");

    const host = (this.host = doc.createElement("genclass-devtools"));
    host.setAttribute("data-genclass-devtools", "");
    host.setAttribute("data-genclass-ignore", "");
    host.style.cssText = `all:initial;display:block;position:fixed;z-index:2147483646;${vert}:16px;${horiz}:16px;`;
    const sr = (this.sr = host.attachShadow({ mode: "open" }));
    this.adoptStyles();

    // pill
    this.pill = h(
      "button",
      { class: "pill", type: "button", "aria-expanded": "false", "aria-haspopup": "dialog", "data-part": "pill", onclick: () => this.open(true) },
      mark(),
      h("span", { class: "pn", text: "GenClass" }),
      (this.pm = h("span", { class: "pm" })),
      h("span", { class: "vs" }),
      (this.pcA = h("span", { class: "pc a", title: "Interventions" }, icon("shield"), h("b", { text: "0" }))),
      (this.pcD = h("span", { class: "pc d", title: "Detections" }, icon("eye"), h("b", { text: "0" }))),
      (this.pcC = h("span", { class: "pc c", title: "Measured checks" }, icon("scan"), h("b", { text: "0" }))),
      h("span", { class: "pd" }),
      (this.pb = h("span", { class: "pb", hidden: true }, (this.pbi = h("i")))),
    );
    this.pill.addEventListener("animationend", (e) => {
      if ((e as AnimationEvent).animationName === "ring") this.pill.classList.remove("pa", "pdd", "pck");
    });

    // header
    this.modeBtns = MODES.map(([m, label, tip]) =>
      h(
        "button",
        { type: "button", role: "radio", class: `m-${m}`, "data-mode": m, title: tip, "aria-checked": "false", tabindex: "-1", onclick: () => this.setMode(m, true) },
        h("span", { class: "md" }),
        label,
      ),
    );
    const header = h(
      "div",
      { class: "hd" },
      h("div", { class: "brand" }, mark(), h("span", { class: "bn", text: "GenClass" }), h("span", { class: "bt", text: "runtime" })),
      h("div", { class: "modes", role: "radiogroup", "aria-label": "Mode", onkeydown: (e: KeyboardEvent) => this.modeKey(e) }, this.modeBtns),
      this.aggrSelect(),
      h("button", { class: "ib", type: "button", "aria-label": "Minimize", title: "Minimize (Alt+Shift+G)", "data-part": "minimize", onclick: () => this.close(true) }, icon("min")),
    );
    this.st = h("div", { class: "st", role: "status", "data-part": "status" }, h("span", { class: "dot" }), (this.stB = h("b")), (this.stM = h("span", { class: "sm" })), h("div", { class: "sb" }, (this.sbi = h("i"))));

    // tabs
    this.tabBtns = TABS.map(([id, label]) =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          class: `tab${id === "interventions" ? " ta" : id === "detections" ? " td" : id === "checks" ? " tc" : ""}`,
          id: `gc-t-${id}`,
          "data-tab": id,
          "aria-controls": `gc-p-${id}`,
          "aria-selected": "false",
          tabindex: "-1",
          onclick: () => this.setTab(id, true),
        },
        label,
        id === "interventions" || id === "detections" || id === "checks" ? h("span", { class: "n", text: "0" }) : null,
      ),
    );
    this.nA = this.tabBtns[0].querySelector(".n") as HTMLElement;
    this.nD = this.tabBtns[1].querySelector(".n") as HTMLElement;
    this.nC = this.tabBtns[2].querySelector(".n") as HTMLElement;
    const tabs = h(
      "div",
      { class: "tabs" },
      h("div", { class: "tabs-in", role: "tablist", "aria-label": "GenClass views", onkeydown: (e: KeyboardEvent) => this.tabKey(e) }, this.tabBtns),
      h("span", { class: "sp" }),
      (this.pauseBtn = h("button", { class: "ib", type: "button", "aria-pressed": "false", "aria-label": "Pause feed", title: "Pause feed", "data-part": "pause", onclick: () => this.setPaused(!this.paused) }, icon("pause"))),
      h("button", { class: "ib", type: "button", "aria-label": "Clear feeds", title: "Clear feeds", "data-part": "clear", onclick: () => this.clear() }, icon("clear")),
    );
    this.pz = h("div", { class: "pz", hidden: true }, icon("pause"), (this.pzT = h("span")), h("button", { type: "button", text: "Resume", onclick: () => this.setPaused(false) }));

    // panes
    const pane = (id: DevtoolsTab, ...kids: Kid[]): HTMLElement =>
      h("div", { class: "pane", role: "tabpanel", id: `gc-p-${id}`, "aria-labelledby": `gc-t-${id}`, "data-pane": id, hidden: true }, ...kids);
    this.listA = h("div", { class: "list", role: "feed", "aria-label": "Interventions" });
    this.listD = h("div", { class: "list", role: "feed", "aria-label": "Detections" });
    this.emptyA = h("div", { class: "empty" });
    this.emptyD = empty("eye", "Nothing flagged", "Findings the model reports but GenClass did not act on appear here, with the evidence and what it would have done.");
    this.emptyE = empty("pulse", "Waiting for activity", "User actions, requests, state writes and errors appear here as they happen.");
    this.listC = h("div", { class: "list", role: "feed", "aria-label": "Measured visual checks" });
    this.emptyC = empty(
      "scan",
      "No visual problems measured",
      "Measured checks with fixed thresholds (unreadable text, broken images, sideways scrolling, covered controls, and more) appear here with the CSS change to make. They are measurements, not model findings.",
    );
    this.evs = h("div", { class: "evs", role: "log", "aria-label": "Runtime activity" });
    this.nowEl = h("div", { class: "now" });
    this.expEl = h("div", { class: "now", "data-part": "expectations" });
    this.panes = {
      interventions: pane("interventions", this.listA, this.emptyA),
      detections: pane("detections", this.listD, this.emptyD),
      checks: pane("checks", this.listC, this.emptyC),
      activity: pane("activity", this.filterBar(), this.evs, this.emptyE),
      now: pane("now", this.nowEl),
      expectations: pane("expectations", this.expEl),
    };

    this.panel = h(
      "section",
      { class: "panel", role: "dialog", "aria-label": "GenClass devtools", hidden: true, "data-part": "panel", onkeydown: (e: KeyboardEvent) => this.panelKey(e) },
      header,
      this.st,
      tabs,
      this.pz,
      h("div", { class: "body" }, Object.values(this.panes)),
    );

    const root = h("div", { class: "root", "data-pos": pos }, this.pill, this.panel);
    // "auto" follows the OS setting live; "light"/"dark" are fixed. Black by default, like genclass.dev.
    const theme = o.theme ?? "dark";
    const mql = theme === "auto" ? safe(() => (globalThis as { matchMedia?: (q: string) => MediaQueryList }).matchMedia?.("(prefers-color-scheme: dark)") ?? null, null) : null;
    const applyTheme = (): void => root.setAttribute("data-theme", theme === "auto" ? (mql?.matches ? "dark" : "light") : theme);
    applyTheme();
    if (mql?.addEventListener) {
      mql.addEventListener("change", applyTheme);
      this.offs.push(() => mql.removeEventListener("change", applyTheme));
    }
    sr.appendChild(root);
    (o.container ?? doc.body ?? doc.documentElement).appendChild(host);

    this.subscribe();
    this.backfill();
    if (o.hotkey !== false) {
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.altKey && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && (ev.code === "KeyG" || ev.key === "G" || ev.key === "g")) {
          ev.preventDefault();
          this.toggle(true);
        }
      };
      doc.addEventListener("keydown", onKey, true);
      this.offs.push(() => doc.removeEventListener("keydown", onKey, true));
    }

    this.bits = ALL;
    this.flush();
    if (o.collapsed === false) this.open(false);

    const self = this;
    this.handle = {
      open: () => this.open(false),
      close: () => this.close(false),
      toggle: () => this.toggle(false),
      unmount: () => this.unmount(),
      get element() {
        return self.dead ? null : self.host;
      },
    };
  }

  // ------------------------------------------------------------------------------------------- setup

  private adoptStyles(): void {
    const Sheet = (globalThis as { CSSStyleSheet?: { new (): CSSStyleSheet; prototype: CSSStyleSheet } }).CSSStyleSheet;
    try {
      if (Sheet && "adoptedStyleSheets" in this.sr && typeof Sheet.prototype.replaceSync === "function") {
        const sheet = new Sheet();
        sheet.replaceSync(CSS);
        this.sr.adoptedStyleSheets = [sheet];
        return;
      }
    } catch {
      /* fall back to a <style> element inside the shadow root */
    }
    this.sr.appendChild(h("style", { text: CSS }));
  }

  private subscribe(): void {
    const on = <K extends keyof RuntimeEvents>(type: K, fn: (v: RuntimeEvents[K]) => void): void => {
      try {
        const off = this.rt.on(type, (v) => {
          if (!this.dead) fn(v);
        });
        if (typeof off === "function") this.offs.push(off);
      } catch {
        /* runtime without this event */
      }
    };
    // detections from their decisions: the "detect" event carries possible ones only when the app asked for them
    on("decide", (d) => {
      this.addDecision(d);
      if (d.detection) this.addDet(d, true);
    });
    on("act", (a) => this.addAct(a, true));
    on("report", (r) => this.addReport(r));
    on("event", (e) => this.addEvent(e));
    on("status", () => this.mark(STATUS | MODE)); // setMode() is announced as a status change too
    on("check", (f) => this.addCheck(f, true));
    on("report", (r) => {
      // a fix line (applied, undone, dropped) changes that finding's card
      const c = r.kind === "check" && r.check ? this.chks.get(r.check.id) : undefined;
      if (c) {
        c.dirty = true;
        this.mark(LISTS);
      }
    });
    // The runtime's clock (virtual in tests/sim), for "4s ago" labels and the overlay's own timers.
    try {
      const off = this.rt.use({
        name: `genclass-devtools-${++instances}`,
        setup: (api) => {
          this.clock = api.clock;
        },
      });
      if (typeof off === "function") this.offs.push(off);
    } catch {
      /* no plugin support: fall back to event times */
    }
  }

  private backfill(): void {
    const decs = safe(() => this.rt.decisions(200), [] as Decision[]).slice().sort((a, b) => a.at - b.at);
    for (const d of decs) {
      this.decs.set(d.id, d);
      this.seen(d.at);
    }
    for (const a of safe(() => this.rt.interventions(MAX_CARDS), [] as ActionRecord[]).slice().sort((x, y) => x.at - y.at)) this.addAct(a, false);
    // the tier the runtime recorded with the gates it decided with: the same detections the console and telemetry reported
    for (const d of decs) {
      if (d.detection) this.addDet(d, false);
    }
    for (const e of safe(() => this.rt.history(MAX_ROWS), [] as RtEvent[])) this.addEvent(e);
    const checks = (this.rt as { checks?: (n?: number) => CheckFinding[] }).checks;
    if (typeof checks === "function") for (const f of safe(() => checks.call(this.rt, MAX_CARDS), [] as CheckFinding[])) this.addCheck(f);
    // mounting the overlay means someone is looking: start the measured visual checks when the option is "local"
    safe(() => (this.rt as { vis?: { start(): void } | null }).vis?.start(), undefined);
  }

  private addCheck(f: CheckFinding, live = false): void {
    if (!f || this.chks.has(f.id)) return;
    this.chks.set(f.id, { f, dirty: false });
    bound(this.chks, MAX_CARDS, (c) => c.el?.remove());
    this.mark(LISTS);
    if (live) this.notify("c");
  }

  // -------------------------------------------------------------------------------------- data intake

  private seen(t: number): void {
    if (Number.isFinite(t) && t > this.lastT) this.lastT = t;
  }

  private now(): number {
    const c = this.clock;
    return c ? safe(() => c.now(), this.lastT) : this.lastT;
  }

  private addDecision(d: Decision): void {
    this.decs.set(d.id, d);
    bound(this.decs, 500);
    this.seen(d.at);
    const e = this.dets.get(this.detOf.get(d.id) ?? "") ?? this.acts.get(this.actOf.get(d.id) ?? "");
    if (e) {
      e.decision = d;
      e.dirty = true;
      this.mark(LISTS);
    }
  }

  private addAct(a: ActionRecord, live: boolean): void {
    this.seen(a.at);
    const known = this.acts.get(a.id);
    if (known) {
      known.action = a;
      known.dirty = true;
      return this.mark(LISTS);
    }
    this.acts.set(a.id, { kind: "act", id: a.id, at: a.at, action: a, decision: this.decs.get(a.decisionId), open: false, dirty: false, fresh: live, count: 1 });
    this.actOf.set(a.decisionId, a.id);
    bound(this.acts, MAX_CARDS, (e) => e.el?.remove());
    bound(this.actOf, 1000);
    // A decision that ended up acting moves from Detections to Interventions.
    const detId = this.detOf.get(a.decisionId);
    const det = detId ? this.dets.get(detId) : undefined;
    this.detOf.delete(a.decisionId);
    if (det && det.count > 1) {
      det.count--;
      det.dirty = true;
    } else if (det) {
      det.el?.remove();
      this.dets.delete(det.id);
    }
    if (live) this.notify("a");
    this.mark(LISTS);
  }

  private addDet(d: Decision, live: boolean): void {
    this.decs.set(d.id, d);
    this.seen(d.at);
    // Executed non-passive decisions are interventions (their ActionRecord follows).
    if (this.actOf.has(d.id) || this.detOf.has(d.id) || (d.executed && d.tier !== "passive")) return;
    // Repeats of the same finding within a minute fold into one card (×N), like the console's rate limiting.
    const key = repeatKey(d);
    let same: Entry | undefined;
    for (const x of this.dets.values()) if (x.key === key && d.at - x.at <= 60_000) same = x;
    if (same) {
      same.count++;
      same.decision = d;
      same.at = d.at;
      same.ex = undefined;
      same.fresh = live;
      same.el?.remove();
      same.el = undefined;
      this.dets.delete(same.id);
      this.dets.set(same.id, same); // newest last: rendered on top
      this.detOf.set(d.id, same.id);
    } else {
      this.dets.set(d.id, { kind: "det", id: d.id, at: d.at, decision: d, open: false, dirty: false, fresh: live, count: 1, key });
      this.detOf.set(d.id, d.id);
    }
    bound(this.dets, MAX_CARDS, (e) => e.el?.remove());
    bound(this.detOf, 1000);
    // a possible detection is a secondary card: no pulse, not counted as unseen
    if (live && d.detection !== "possible") this.notify("d");
    this.mark(LISTS);
  }

  private addReport(r: Report): void {
    if (r.kind === "expectation") {
      if (this.isOpen && this.tab === "expectations" && !this.paused) this.renderExpectations();
      return;
    }
    if (r.kind === "status" || !r.message) return;
    const id = r.kind === "intervene" ? r.action?.id ?? (r.decision ? this.actOf.get(r.decision.id) ?? r.decision.id : undefined) : r.decision?.id;
    if (!id) return;
    this.msgs.set(id, r.message);
    bound(this.msgs, 500);
    const e = this.acts.get(id) ?? this.dets.get(this.detOf.get(id) ?? "");
    if (e) {
      e.dirty = true;
      this.mark(LISTS);
    }
  }

  private addEvent(e: RtEvent): void {
    this.seen(e.t);
    // An intervention undone elsewhere (console, app code) shows as undone here too.
    if (e.kind === "action" && e.name === "undo" && typeof e.data?.id === "string") {
      const ent = this.acts.get(e.data.id);
      if (ent && !ent.undone) {
        ent.undone = true;
        ent.dirty = true;
        this.mark(LISTS);
      }
    }
    if (e.op != null && (e.kind === "user" || e.kind === "op.start")) {
      this.opNames.set(e.op, eventText(e));
      bound(this.opNames, 2000);
    }
    this.evq.push(e);
    if (this.evq.length > MAX_ROWS) this.evq.splice(0, this.evq.length - MAX_ROWS);
    this.mark(EVENTS);
  }

  private notify(kind: "a" | "d" | "c"): void {
    if (this.paused) this.unseen++;
    const p = this.pill;
    p.classList.remove("pa", "pdd", "pck");
    void p.offsetWidth; // restart the animation
    p.classList.add(kind === "a" ? "pa" : kind === "d" ? "pdd" : "pck");
  }

  // ------------------------------------------------------------------------------------------ render

  private mark(bits: number): void {
    this.bits |= bits;
    if (this.scheduled || this.dead) return;
    this.scheduled = true;
    const run = (): void => {
      this.scheduled = false;
      this.flush();
    };
    if (rawRaf) rawRaf(run);
    else this.after(16, run);
  }

  private flush(): void {
    if (this.dead) return;
    let b = this.bits;
    this.bits = 0;
    if (b & STATUS) this.renderStatus();
    if (b & MODE) this.renderMode();
    // Lists and activity render only while visible and not paused; their bits stay set until then.
    if (this.isOpen && !this.paused) {
      if (b & LISTS) this.renderList(this.acts, this.listA, this.emptyA);
      if (b & LISTS) this.renderList(this.dets, this.listD, this.emptyD);
      if (b & LISTS) this.renderChecks();
      if (b & EVENTS) this.renderEvents();
      b &= ~(LISTS | EVENTS);
    }
    this.bits |= b & (LISTS | EVENTS);
    this.renderCounts();
  }

  private renderCounts(): void {
    const na = this.acts.size;
    // possible detections (observe's lower tier) are listed as secondary cards, not counted in the badges
    let nd = 0;
    let np = 0;
    for (const e of this.dets.values()) {
      if (e.decision?.detection === "possible") np += e.count;
      else nd += e.count;
    }
    (this.pcA.lastElementChild as HTMLElement).textContent = String(na);
    (this.pcD.lastElementChild as HTMLElement).textContent = String(nd);
    this.pcA.classList.toggle("on", na > 0);
    this.pcD.classList.toggle("on", nd > 0);
    this.nA.textContent = String(na);
    this.nD.textContent = String(nd);
    this.nA.classList.toggle("on", na > 0);
    this.nD.classList.toggle("on", nd > 0);
    this.nD.title = np ? `${nd} likely, ${np} possible` : "";
    // measured checks count in the pill too: a page GenClass fixed on screen must not read "0 · 0"
    const nc = this.chks.size;
    let nf = 0;
    for (const c of this.chks.values()) if (c.f.fix?.applied) nf++;
    (this.pcC.lastElementChild as HTMLElement).textContent = String(nc);
    this.pcC.classList.toggle("on", nc > 0);
    this.pcC.title = nc ? `${nc} measured ${nc === 1 ? "check" : "checks"}, ${nf} fixed on screen` : "Measured checks";
    this.nC.textContent = String(nc);
    this.nC.classList.toggle("on", nc > 0);
    const s = safe(() => this.rt.status.state, "off");
    this.pill.setAttribute("aria-label", `Open GenClass devtools: ${na} interventions, ${nd} detections, ${nc} checks (${nf} fixed), model ${s}`);
    this.pz.hidden = !this.paused;
    this.pzT.textContent = this.unseen ? `Feed paused · ${this.unseen} new` : "Feed paused";
  }

  private renderStatus(): void {
    const s: ModelStatus = safe(() => this.rt.status, { state: "off" } as ModelStatus);
    let title: string;
    let meta: string;
    let prog = -1;
    switch (s.state) {
      case "ready":
        title = "Model ready";
        meta = [s.device === "webgpu" ? "WebGPU" : s.device === "wasm" ? "WASM" : "", s.variant, s.progress?.total ? `${mb(s.progress.total)} MB` : "", s.loadMs != null ? `loaded in ${dur(s.loadMs)}` : ""]
          .filter(Boolean)
          .join(" · ");
        break;
      case "loading": {
        title = "Loading model";
        const p = s.progress;
        prog = p && p.total > 0 ? Math.min(1, p.loaded / p.total) : 0;
        meta = p && p.total > 0 ? `${mb(p.loaded)} / ${mb(p.total)} MB · ${pct(prog)}` : "starting…";
        break;
      }
      case "error":
        title = "Model unavailable";
        meta = `observing only${s.error ? ` · ${s.error}` : ""}`;
        break;
      default:
        title = "No model";
        meta = "observing only · no decisions";
    }
    this.st.className = `st s-${s.state}`;
    this.pill.classList.remove("s-off", "s-loading", "s-ready", "s-error");
    this.pill.classList.add(`s-${s.state}`);
    this.stB.textContent = title;
    this.stM.textContent = meta;
    this.stM.title = [meta, s.model].filter(Boolean).join(" · ");
    this.pb.hidden = prog < 0;
    for (const bar of [this.pbi, this.sbi]) bar.style.width = prog < 0 ? "0" : `${(prog * 100).toFixed(1)}%`;
    this.renderEmpty();
  }

  private mode(): Mode {
    return safe(() => this.rt.mode, "observe" as Mode);
  }

  private renderMode(): void {
    const m = this.mode();
    for (const b of this.modeBtns) {
      const on = b.dataset.mode === m;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    this.pm.textContent = m;
    this.renderEmpty();
  }

  /** Empty Interventions view: explains why nothing happened yet (mode, model state). */
  private renderEmpty(): void {
    const m = this.mode();
    const st = safe(() => this.rt.status.state, "off");
    const [title, text] =
      st === "loading"
        ? ["Model loading", "Until the model is ready GenClass only observes: nothing is held, changed or retried."]
        : st === "off" || st === "error"
          ? ["Observing only", "No model is available, so GenClass records activity but never decides or acts."]
          : m === "observe"
            ? ["No interventions in observe mode", "Observe mode never changes execution. What GenClass would have done appears under Detections."]
            : m === "heal"
              ? ["No interventions yet", "Heal mode may also retry, serve cached responses, roll back or resync, only when the model is confident."]
              : ["No interventions yet", "Guard mode acts only at very high calibrated confidence, with minimal, reversible actions."];
    this.emptyA.replaceChildren(...empty("shield", title, text).childNodes);
  }

  private renderList(m: Map<string, Entry>, list: HTMLElement, emptyEl: HTMLElement): void {
    for (const e of m.values()) {
      if (!e.el) {
        e.el = this.card(e);
        list.prepend(e.el);
      } else if (e.dirty) {
        const old = e.el;
        const focused = this.sr.activeElement;
        const part = focused && old.contains(focused) ? focused.getAttribute("data-act") : null;
        e.el = this.card(e);
        old.replaceWith(e.el);
        if (part) (e.el.querySelector(`[data-act="${part}"]`) as HTMLElement | null)?.focus();
      }
      e.dirty = false;
    }
    emptyEl.hidden = m.size > 0;
  }

  // ------------------------------------------------------------------------------------- measured checks

  private renderChecks(): void {
    for (const c of this.chks.values()) {
      if (!c.el) {
        c.el = this.checkCard(c.f);
        this.listC.prepend(c.el);
      } else if (c.dirty) {
        const old = c.el;
        c.el = this.checkCard(c.f);
        old.replaceWith(c.el);
      }
      c.dirty = false;
    }
    this.emptyC.hidden = this.chks.size > 0;
  }

  /** One finding: kind, target, what was measured against which threshold, the CSS to make, Show and Undo. */
  private checkCard(f: CheckFinding): HTMLElement {
    const line = f.message.replace(/^\[GenClass\] Check \(measured\): /, "");
    const cut = line.indexOf(" Suggested CSS: ");
    const body = cut >= 0 ? line.slice(0, cut) : line;
    const css = f.suggestion ? `${f.suggestion.selector} { ${f.suggestion.css} }` : "";
    const fix = f.fix;
    return h(
      "article",
      { class: `card chk sev-${f.severity}`, "data-id": f.id, "data-kind": f.kind, "aria-label": `${f.kind} on ${f.target}` },
      h("div", { class: "ci" }, icon("scan")),
      h(
        "div",
        { class: "cb" },
        h(
          "div",
          { class: "ch" },
          h("span", { class: "cl", text: CHECK_TITLE[f.kind] ?? f.kind }),
          h("span", { class: "ct", text: f.kind }),
          h("span", { class: "badge", text: "measured", title: "A deterministic measurement against a fixed threshold, not a model finding" }),
          h("time", { class: "ago", "data-at": String(f.at), text: ago(this.now() - f.at), title: `runtime clock ${clockT(f.at)}` }),
        ),
        h("p", { class: "cx", text: body }),
        h(
          "div",
          { class: "chips" },
          h("span", { class: `chip t-${f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "ok"}` }, h("span", { class: "cd" }), h("b", { text: f.severity })),
          h("span", { class: "chip", title: f.threshold.source }, `threshold ${f.threshold.value} ${f.threshold.unit}`),
          f.count && f.count > 1 ? h("span", { class: "chip", text: `${f.count}×` }) : null,
          f.context.state && f.context.state !== "rest" ? h("span", { class: "chip", text: f.context.state }) : null,
        ),
        css ? sec("Suggested CSS", copyBtn(css), h("pre", { class: "code", "data-part": "css", text: css }), f.suggestion?.note ? h("p", { class: "none", text: f.suggestion.note }) : null) : null,
        fix?.applied
          ? h("div", { class: "note chg" }, icon("check"), h("span", { text: `Runtime fix applied: ${fix.css ?? ""}` }))
          : fix?.reason
            ? h("div", { class: "note" }, icon("info"), h("span", { text: `Runtime fix: ${fix.reason}` }))
            : null,
        h(
          "div",
          { class: "cf" },
          h("button", { class: "btn", type: "button", "data-act": "show", title: "Scroll to the element and outline it", onclick: () => this.show(f) }, icon("eye"), "Show"),
          fix?.applied
            ? h("button", { class: "btn u", type: "button", "data-act": "undo", title: "Remove the runtime fix", onclick: () => this.undoFix(f) }, icon("undo"), "Undo")
            : null,
        ),
      ),
    );
  }

  /** Scroll to the finding's element and outline it inside the overlay's own shadow root (nothing is written to the app's DOM). */
  private show(f: CheckFinding): void {
    const el = safe(() => f.element(), null);
    if (!el) return;
    safe(() => el.scrollIntoView({ block: "center" }), undefined);
    this.after(250, () => {
      const r = el.getBoundingClientRect();
      const box = this.hlBox ?? h("div", { class: "hl", "data-part": "highlight" });
      this.hlBox = box;
      Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px`, opacity: "1" });
      (this.sr.querySelector(".root") as HTMLElement | null)?.appendChild(box);
      this.after(1800, () => {
        box.style.opacity = "0";
      });
    });
  }

  private undoFix(f: CheckFinding): void {
    safe(() => f.fix?.undo(), false);
    const c = this.chks.get(f.id);
    if (c) c.dirty = true;
    this.bits |= LISTS;
    this.flush();
  }

  // --------------------------------------------------------------------------------------------- cards

  private card(e: Entry): HTMLElement {
    const a = e.action;
    const d = e.decision ?? (a ? this.decs.get(a.decisionId) : undefined);
    if (d) e.decision = d;
    const isAct = e.kind === "act";
    const trigger = a?.trigger ?? d?.trigger;
    const msg = isAct ? this.msgs.get(e.id) ?? (a ? this.msgs.get(a.decisionId) : undefined) : d ? this.msgs.get(d.id) : undefined;
    let { title, body } = splitReport(msg, a?.changed);
    if (!isAct) title = diagTitle(d?.diagnosis, trigger);
    else if (!title) title = actTitle(a?.action ?? "", d?.diagnosis, trigger, !!a?.late);
    if (!body) body = topFact(d?.facts) || a?.subject || d?.subject || "";
    const evId = `gc-ev-${e.kind}-${e.id}`;
    const dp = d ? diagP(d) : NaN;
    const possible = !isAct && d?.detection === "possible";
    const el = h(
      "article",
      { class: `card ${e.kind}${possible ? " possible" : ""}${e.undone ? " undone" : ""}${e.fresh ? " new" : ""}${e.open ? " open" : ""}`, "data-id": e.id, "aria-label": possible ? `Possible: ${title}` : title },
      h("div", { class: "ci" }, icon(isAct ? "shield" : "eye")),
      h(
        "div",
        { class: "cb" },
        h(
          "div",
          { class: "ch" },
          h("span", { class: "ct", text: title }),
          e.count > 1 ? h("span", { class: "rep", text: `×${e.count}`, title: `${e.count} times within a minute; showing the latest` }) : null,
          h("time", { class: "ago", "data-at": String(e.at), text: ago(this.now() - e.at), title: `runtime clock ${clockT(e.at)}` }),
        ),
        body ? h("p", { class: "cx", text: body }) : null,
        h(
          "div",
          { class: "chips" },
          d?.diagnosis
            ? h("span", { class: `chip t-${diagTone(d.diagnosis)}`, title: `Diagnosis, calibrated probability ${dp.toFixed(2)}` }, h("span", { class: "cd" }), h("b", { text: d.diagnosis }), h("span", { class: "p", text: pct(dp) }))
            : null,
          possible ? h("span", { class: "chip poss", title: "Possible: below the report gate, at or above observe's possible gate (rt.gates().possible)" }, "possible") : null,
          a ? h("span", { class: "chip", title: `Action, ${a.tier} tier` }, h("code", { text: a.action }), h("span", { class: "tier", text: a.tier })) : null,
        ),
        isAct ? this.changedNote(e) : this.wouldNote(d),
        h(
          "div",
          { class: "cf" },
          isAct ? this.undoCtl(e) : null,
          h(
            "button",
            { class: "btn", type: "button", "data-act": "evidence", "aria-expanded": String(e.open), "aria-controls": evId, onclick: () => this.toggleEvidence(e) },
            icon("chev", "i chev"),
            "Evidence",
          ),
        ),
        e.open ? this.evidence(e, evId) : null,
      ),
    );
    e.fresh = false;
    return el;
  }

  private changedNote(e: Entry): Kid {
    const a = e.action;
    if (!a) return null;
    if (!a.ok) return h("div", { class: "note fail" }, icon("alert"), h("span", {}, h("b", { text: "Action failed: " }), a.error ?? "it threw"));
    if (e.undone) return h("div", { class: "note" }, icon("undo"), h("span", {}, h("b", { text: "Reversed: " }), a.changed || a.action));
    return a.changed ? h("div", { class: "note chg" }, icon("check"), h("span", { text: a.changed })) : null;
  }

  private wouldNote(d: Decision | undefined): Kid {
    if (!d || !d.action) return null;
    if (d.tier === "passive")
      return h("div", { class: "note" }, icon("info"), h("span", {}, "The model chose ", h("code", { text: d.action }), ": nothing was changed."));
    // Held back by the mode ("observe mode never changes execution", "guard mode does not allow heal-tier
    // actions") or by policy (threshold, deny, rate limit, hold budget): say which.
    const m = this.mode();
    const byMode = d.reason ? /\bmode\b/.test(d.reason) : !(m === "heal" || (m === "guard" && d.tier === "guard"));
    return h(
      "div",
      { class: "note" },
      icon("info"),
      byMode
        ? h("span", {}, "Would have run ", h("code", { text: d.action }), ` in ${d.tier} mode.`)
        : h("span", {}, `Not acted on: ${d.reason ?? "held back by policy"}. The model chose `, h("code", { text: d.action }), ` (${d.tier}).`),
    );
  }

  private undoCtl(e: Entry): Kid {
    const a = e.action;
    if (e.undone) return h("span", { class: "done", "data-act": "undone" }, icon("check"), "Undone");
    if (!a || typeof a.undo !== "function") return null;
    return [
      h("button", { class: "btn u", type: "button", "data-act": "undo", title: "Reverse what GenClass changed", onclick: () => this.undo(e) }, icon("undo"), "Undo"),
      e.undoErr ? h("span", { class: "err", text: e.undoErr }) : null,
    ];
  }

  private undo(e: Entry): void {
    try {
      e.action?.undo?.();
      e.undone = true;
      e.undoErr = undefined;
    } catch (err) {
      e.undoErr = `Undo failed: ${errText(err)}`;
    }
    e.dirty = true;
    this.bits |= LISTS;
    this.flush();
  }

  private toggleEvidence(e: Entry): void {
    e.open = !e.open;
    e.dirty = true;
    this.bits |= LISTS;
    this.flush();
    if (e.open && e.el) this.reveal(e.el);
  }

  /** Scroll a card so as much of it as fits is visible, top first. */
  private reveal(el: HTMLElement): void {
    const pane = el.closest(".pane") as HTMLElement | null;
    if (!pane) return;
    const pr = pane.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < pr.top + 8 || r.bottom > pr.bottom - 8) pane.scrollTop += Math.min(r.top - pr.top - 10, r.bottom - pr.bottom + 10);
  }

  private explain(e: Entry): Explanation | null {
    const ids = (e.kind === "act" ? [e.id, e.action?.decisionId] : [e.decision?.id, e.id]).filter((x): x is string => !!x);
    for (const id of ids) {
      const ex = safe(() => this.rt.explain(id), null);
      if (ex) return ex;
    }
    return null;
  }

  private evidence(e: Entry, id: string): HTMLElement {
    if (e.ex === undefined) e.ex = this.explain(e);
    const ex = e.ex;
    const d = ex?.decision ?? e.decision;
    const a = e.action ?? ex?.action;
    const facts = ex?.facts ?? d?.facts ?? [];
    const answers: Record<string, Answer> = ex?.answers ?? d?.answers ?? {};
    const qids = Object.keys(answers).sort((x, y) => qrank(x) - qrank(y));
    return h(
      "div",
      { class: "evd", id },
      facts.length ? sec("Facts", null, h("ul", { class: "facts" }, facts.map((f) => h("li", { text: f })))) : null,
      qids.length ? sec("Model answers", null, qids.map((q) => this.answer(q, answers[q], q === "action" ? d?.action : q === "diagnosis" ? d?.diagnosis : undefined))) : null,
      ex?.timeline?.length ? sec("Timeline", null, h("pre", { class: "code", text: ex.timeline.join("\n") })) : null,
      ex?.situationText ? sec("Exact input sent to the model", copyBtn(ex.situationText), h("pre", { class: "code", "data-part": "situation", text: ex.situationText })) : null,
      ex ? null : h("p", { class: "none", text: "The full situation is no longer in the runtime's decision buffer." }),
      d
        ? h(
            "div",
            { class: "meta" },
            h("span", {}, "decision ", h("code", { text: d.id })),
            a ? h("span", {}, "action ", h("code", { text: a.id })) : null,
            h("span", { text: `${d.trigger} · answered in ${dur(d.latencyMs)}` }),
            d.model ? h("span", { text: d.model }) : null,
          )
        : null,
      a && a.tier !== "passive" ? h("div", { class: "meta" }, h("span", {}, "Never run this action: ", h("code", { text: `policy: { deny: ["${a.action}"] }` }))) : null,
    );
  }

  private answer(q: string, ans: Answer, chosen?: string): HTMLElement {
    const rows = answerRows(ans).slice(0, 6);
    const top = chosen && rows.some((r) => r[0] === chosen) ? chosen : rows[0]?.[0];
    return h(
      "div",
      { class: "ans", "data-q": q },
      h("div", { class: "aq", text: QLABEL[q] ?? q }),
      rows.map(([label, p]) => {
        const t = label === top ? " top" : "";
        const fill = h("i");
        fill.style.width = `${(Math.max(0, Math.min(1, p)) * 100).toFixed(1)}%`;
        return [h("span", { class: `bl${t}`, text: label, title: label }), h("span", { class: `bt2${t}` }, fill), h("span", { class: `bp${t}`, text: pct(p) })];
      }),
    );
  }

  // ------------------------------------------------------------------------------------------ activity

  private filterBar(): HTMLElement {
    return h(
      "div",
      { class: "fb", role: "toolbar", "aria-label": "Activity filters" },
      FILTERS.map(([grp, label]) =>
        h(
          "button",
          {
            type: "button",
            class: `f g-${grp}`,
            "data-g": grp,
            "aria-pressed": "true",
            onclick: (ev: Event) => {
              const shown = this.hide.has(grp);
              if (shown) this.hide.delete(grp);
              else this.hide.add(grp);
              (ev.currentTarget as HTMLElement).setAttribute("aria-pressed", String(shown));
              this.applyFilter();
            },
          },
          label,
        ),
      ),
      h("input", {
        class: "q",
        type: "search",
        placeholder: "Filter…",
        "aria-label": "Filter activity",
        oninput: (ev: Event) => {
          this.query = (ev.target as HTMLInputElement).value.trim().toLowerCase();
          this.applyFilter();
        },
      }),
    );
  }

  private visible(el: HTMLElement): boolean {
    return !this.hide.has(el.dataset.g as Group) && (!this.query || (el.textContent ?? "").toLowerCase().includes(this.query));
  }

  private applyFilter(): void {
    for (const r of this.rows) r.hidden = !this.visible(r);
  }

  private renderEvents(): void {
    if (!this.evq.length) return;
    const pane = this.panes.activity;
    const atBottom = !this.scrolledActivity || pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 32;
    const q = this.evq;
    this.evq = [];
    const fresh = this.scrolledActivity && this.tab === "activity";
    const frag = this.doc.createDocumentFragment();
    for (const e of q) {
      const known = this.rowBySeq.get(e.seq);
      if (known) {
        const m = known.querySelector(".m");
        if (m) fillMain(m, e);
        continue;
      }
      const r = this.row(e, fresh);
      if (r) {
        frag.appendChild(r);
        this.rows.push(r);
        this.rowBySeq.set(e.seq, r);
      }
    }
    this.evs.appendChild(frag);
    while (this.rows.length > MAX_ROWS) {
      const r = this.rows.shift() as HTMLElement;
      r.remove();
      for (const ev of this.rowEvents.get(r) ?? []) this.rowBySeq.delete(ev.seq);
      const op = Number(r.dataset.op);
      if (this.opRows.get(op)?.el === r) this.opRows.delete(op);
    }
    this.emptyE.hidden = this.rows.length > 0;
    if (atBottom && this.tab === "activity") pane.scrollTop = pane.scrollHeight;
  }

  private row(e: RtEvent, fresh: boolean): HTMLElement | null {
    if (e.kind === "op.end" && e.op != null) {
      const or = this.opRows.get(e.op);
      if (or) {
        this.endOp(or, e);
        return null;
      }
    }
    const grp = groupOf(e);
    const x = h("span", { class: "x" });
    const el = h(
      "div",
      { class: `ev g-${grp}${fresh ? " fresh" : ""}`, "data-g": grp, "data-op": e.op, role: "listitem", tabindex: "0", "aria-expanded": "false" },
      h("span", { class: "t", text: clockT(e.t) }),
      h("span", { class: "k", text: kindLabel(e) }),
      fillMain(h("span", { class: "m" }), e),
      x,
    );
    this.rowEvents.set(el, [e]);
    el.addEventListener("click", () => this.toggleRow(el));
    el.addEventListener("keydown", (k) => {
      if (k.key === "Enter" || k.key === " ") {
        k.preventDefault();
        this.toggleRow(el);
      }
    });
    if (e.kind === "op.start" && e.op != null) {
      x.appendChild(h("span", { class: "spin", role: "img", "aria-label": "in flight" }));
      this.opRows.set(e.op, { el, x, start: e.t });
    } else if (e.kind === "op.end") {
      this.fillEnd(x, e);
    } else {
      const d = e.data ?? {};
      const held = typeof d.heldMs === "number" ? d.heldMs : typeof d.held === "number" ? d.held : undefined;
      if (held != null) x.textContent = `held ${dur(held)}`;
      else if (e.kind === "decision" && typeof d.confidence === "number") x.textContent = pct(d.confidence);
    }
    el.hidden = !this.visible(el);
    return el;
  }

  private endOp(or: OpRow, e: RtEvent): void {
    this.fillEnd(or.x, e, or.start);
    this.rowEvents.get(or.el)?.push(e);
    this.opRows.delete(e.op as number);
    const m = or.el.querySelector(".m");
    if (m && e.name && !(m.textContent ?? "").startsWith(e.name)) fillMain(m, e);
  }

  private fillEnd(x: HTMLElement, e: RtEvent, start?: number): void {
    const [s, tone] = opStatus(e);
    const ms = opDuration(e, start);
    x.replaceChildren(h("span", { class: tone, text: s }), ms != null ? dur(ms) : "");
  }

  private toggleRow(el: HTMLElement): void {
    const open = !el.classList.contains("open");
    el.classList.toggle("open", open);
    el.setAttribute("aria-expanded", String(open));
    el.querySelector(".evx")?.remove();
    const name = (op: number): string | undefined => this.opNames.get(op);
    if (open) el.appendChild(h("div", { class: "evx", text: (this.rowEvents.get(el) ?? []).map((e) => dataLines(e, name)).join("\n—\n") }));
  }

  // ----------------------------------------------------------------------------------------------- now

  private renderNow(): void {
    if (!this.isOpen || this.tab !== "now" || this.dead) return;
    let sit: Situation | null = null;
    let err = "";
    try {
      sit = this.rt.situation();
    } catch (e) {
      err = errText(e);
    }
    const st = (sit?.state ?? {}) as Record<string, unknown>;
    const ops = safe(() => this.rt.inflight(), null as Op[] | null);
    const now = this.now();
    const facts = sit?.facts?.length ? sit.facts : linesOf(st.facts);
    const inflight = ops
      ? ops.map((op) =>
          h(
            "div",
            { class: "op" },
            h("span", { class: "m", text: `${op.name}${op.detail ? (op.detail.startsWith("?") ? op.detail : ` ${op.detail}`) : ""}`, title: op.name }),
            h("span", { class: "x" }, h("span", { class: "spin" }), `${op.kind} · ${dur(Math.max(0, now - op.start))}`),
          ),
        )
      : linesOf(st.in_flight).filter((l) => l !== "none");
    const block = (lines: string[]): Kid => (lines.length ? h("pre", { class: "code", text: lines.join("\n") }) : h("div", { class: "none", text: "none" }));
    const app = linesOf(st.app).join(" · ");
    this.nowEl.classList.toggle("paused", this.paused);
    this.nowEl.replaceChildren(
      ...([
        h("div", { class: "nh" }, h("span", { class: "live", text: this.paused ? "Paused" : "Live" }), h("span", { text: app || "What GenClass sees right now" }), h("span", { class: "sp" }), sit ? copyBtn(safeJson(sit.state, 2), "Copy state") : null),
        err ? h("div", { class: "note fail" }, icon("alert"), h("span", { text: `situation() failed: ${err}` })) : null,
        sit
          ? h(
              "div",
              { class: "subj" },
              h(
                "div",
                { class: "chips m0" },
                h("span", { class: "chip" }, "trigger ", h("b", { text: sit.trigger })),
                h("span", { class: `chip t-${sit.salient ? "warn" : "ok"}` }, h("span", { class: "cd" }), sit.salient ? "salient: the model would be asked" : "quiet: no model call needed"),
              ),
              h("p", { text: sit.subject || linesOf(st.trigger)[0] || "" }),
            )
          : null,
        sit ? sec("Facts", null, facts.length ? h("ul", { class: "facts" }, facts.map((f) => h("li", { text: f }))) : h("div", { class: "none", text: "No notable facts." })) : null,
        sit ? sec(`In flight${inflight.length ? ` · ${inflight.length}` : ""}`, null, inflight.length ? (ops ? inflight : block(inflight as string[])) : h("div", { class: "none", text: "none" })) : null,
        sit ? sec("Timeline", null, block(linesOf(st.timeline))) : null,
        sit ? sec("State", null, block(linesOf(st.state))) : null,
        sit ? sec("Stats", null, block(linesOf(st.stats).filter((l) => l !== "none"))) : null,
        this.storesSection(),
        sit?.actions?.length
          ? sec("Actions available", null, h("div", { class: "acts" }, sit.actions.map((n, i) => h("span", { class: "chip" }, h("code", { text: n }), i === 0 ? "passive" : null))))
          : null,
        sit ? sec("Gates", null, block(this.gateLines())) : null,
      ].filter(Boolean) as Node[]),
    );
  }

  // ---------------------------------------------------------------------------------------- expectations

  /** One learned flow as display lines: the action, then each step with its support and whether it is expected. */
  private flowLines(f: LearnedFlow): string[] {
    const q = (x: { p50: number; p95: number } | undefined) => (x ? `, within ${dur(x.p95)}` : "");
    const tag = (x: { expected: boolean; missed?: boolean }) => (x.missed ? " · missed: not expected until seen again" : x.expected ? " · expected" : "");
    const out = [`${f.action} on ${f.route}: ${f.n} observation${f.n === 1 ? "" : "s"} (${f.repeats} repeated in a visit), ${f.sessions} session${f.sessions === 1 ? "" : "s"}${f.settleMs ? `, settles in ${dur(f.settleMs.p95)}` : ""}`];
    for (const c of f.children) out.push(`  → ${c.signature} (${c.n}/${f.n}${q(c.delayMs)})${c.protected ? " · protected" : c.expected && !c.expectedOnRepeat ? " · expected the first time in a visit" : tag(c)}`);
    for (const w of f.writes) out.push(`  ✎ ${w.signature} writes ${w.field} (${w.n}/${w.of})${tag(w)}`);
    for (const u of f.followUps) out.push(`  ↳ ${u.then} after ${u.after} (${u.n}/${u.of}${q(u.delayMs)})${tag(u)}`);
    for (const n of f.nav) out.push(`  ⇒ ${n.to} (${n.n}/${f.n})${tag(n)}`);
    return out;
  }

  /** The Expectations view: what GenClass learned about this page's flows, and the steps that did not happen. */
  private renderExpectations(): void {
    if (!this.isOpen || this.tab !== "expectations" || this.dead) return;
    const fn = (this.rt as { learned?: () => Learned }).learned;
    const learned: Learned | null = typeof fn === "function" ? safe(() => fn.call(this.rt), null as Learned | null) : null;
    const now = this.now();
    this.expEl.classList.toggle("paused", this.paused);
    if (!learned) {
      this.expEl.replaceChildren(empty("scan", "Not available", "This runtime does not expose what it learned (rt.learned())."));
      return;
    }
    const devs = [...learned.deviations].reverse().slice(0, 50);
    const flows = learned.flows.slice(0, 40);
    const block = (lines: string[]): Kid => (lines.length ? h("pre", { class: "code", text: lines.join("\n") }) : h("div", { class: "none", text: "none" }));
    this.expEl.replaceChildren(
      ...([
        h("div", { class: "nh" }, h("span", { class: "live", text: this.paused ? "Paused" : "Live" }), h("span", { text: `What GenClass learned about ${learned.route}` }), h("span", { class: "sp" }), h("span", { class: "none", text: `session ${learned.session}` })),
        h("p", { class: "none", text: "Learned from repetition, reported when a usual step does not happen. Reporting only: no model, no action in any mode." }),
        sec(
          `Deviations${devs.length ? ` · ${devs.length}` : ""}`,
          null,
          devs.length
            ? h(
                "ul",
                { class: "facts", "data-part": "deviations" },
                devs.map((e) => h("li", {}, h("time", { class: "ago", "data-at": String(e.at), text: ago(now - e.at), title: `runtime clock ${clockT(e.at)}` }), " ", e.message.replace(/^\s*\[GenClass\]\s*/, ""))),
              )
            : h("div", { class: "none", text: "No usual step has been missed." }),
        ),
        sec(
          `Learned flows${flows.length ? ` · ${flows.length}` : ""}`,
          null,
          flows.length
            ? h("pre", { class: "code", "data-part": "flows", text: flows.flatMap((f) => this.flowLines(f)).join("\n") })
            : learned.expectations === false
              ? h("div", { class: "none", "data-part": "flows-off", text: "Flow expectations are off (opt-in): GenClass.init({ learn: { expectations: true } }) learns what each action usually does." })
              : h("div", { class: "none", text: "Nothing learned yet: a flow is a user action and the requests it starts, seen several times across visits." }),
        ),
        sec(`Learned relations${learned.relations.length ? ` · ${learned.relations.length}` : ""}`, null, block(learned.relations.map((r) => `${r.text} (held at ${r.held} settled points)`))),
      ].filter(Boolean) as Node[]),
    );
  }

  /**
   * Registered and automatically discovered stores: discovered React and Zustand state is observed only (GenClass
   * sees its writes, never holds, drops or reverts them); discovered Redux stores are full adapters.
   */
  private storesSection(): HTMLElement | null {
    const fn = (this.rt as { stores?: () => StoreInfo[] }).stores;
    if (typeof fn !== "function") return null;
    const list = safe(() => fn.call(this.rt), [] as StoreInfo[]);
    const lines = list.map((s) => {
      const how = s.source ? `discovered (${s.source})` : "registered";
      const ctl = s.kind === "observed" ? "observed only" : s.writable ? "controllable" : "controllable writes, no rollback";
      return `${s.name}: ${how}, ${ctl}, ${s.fields} field${s.fields === 1 ? "" : "s"}, ${s.version} write${s.version === 1 ? "" : "s"}`;
    });
    return sec(`Stores${list.length ? ` · ${list.length}` : ""}`, null, lines.length ? h("pre", { class: "code", "data-part": "stores", text: lines.join("\n") }) : h("div", { class: "none", text: "No stores registered or discovered yet." }));
  }

  /** Aggressiveness selector next to the mode switch (cautious / balanced / eager). */
  private aggrSelect(): HTMLElement {
    const rt = this.rt as { aggressiveness?: number; setAggressiveness?: (a: string) => void };
    const sel = h(
      "select",
      { class: "aggr", "data-part": "aggressiveness", "aria-label": "Aggressiveness", title: "How eagerly GenClass acts" },
      ...["cautious", "balanced", "eager"].map((v) => h("option", { value: v, text: v })),
    ) as HTMLSelectElement;
    const cur = typeof rt.aggressiveness === "number" ? rt.aggressiveness : 0.5;
    sel.value = cur <= 0.25 ? "cautious" : cur >= 0.75 ? "eager" : "balanced";
    sel.addEventListener("change", () => safe(() => rt.setAggressiveness?.(sel.value), undefined));
    return sel;
  }

  /** The gate thresholds in force (CORE batch 6): defaults, plus per-trigger values the model ships. */
  private gateLines(): string[] {
    const gates = (this.rt as { gates?: (t?: TriggerKind) => EffectiveGates }).gates;
    if (typeof gates !== "function") return [];
    const what = (g: EffectiveGates) => (g.kind === "gain" ? "margin " : "");
    const fmt = (g: EffectiveGates) => `guard ${what(g)}${g.guard} (${g.source.guard}) · heal ${what(g)}${g.heal} (${g.source.heal}) · report ${g.report} (${g.source.report})`;
    const lines: string[] = [];
    const all = safe(() => gates.call(this.rt), null as EffectiveGates | null);
    if (all) {
      lines.push(`aggressiveness: ${all.level ?? all.aggressiveness} (${all.levelSource === "profiles" ? "model profiles" : "scaled gate"})`);
      lines.push(all.kind === "gain" ? `kind: gain (per-action gain over the passive action, τ ${all.tauGain ?? 1})` : "kind: mass (summed probability of the permitted actions)");
      lines.push(`default: ${fmt(all)}`);
    }
    const by = safe(() => this.rt.status.gate, undefined);
    const kinds = new Set<TriggerKind>([...Object.keys(by?.guard?.byTrigger ?? {}), ...Object.keys(by?.heal?.byTrigger ?? {})] as TriggerKind[]);
    for (const k of kinds) {
      const g = safe(() => gates.call(this.rt, k), null as EffectiveGates | null);
      if (g) lines.push(`${k}: ${fmt(g)}`);
    }
    return lines;
  }

  // ------------------------------------------------------------------------------------------ controls

  private open(user: boolean): void {
    if (this.isOpen || this.dead) return;
    this.isOpen = true;
    this.panel.hidden = false;
    this.pill.hidden = true;
    this.pill.setAttribute("aria-expanded", "true");
    this.bits |= ALL;
    this.flush();
    // with only measured checks so far, open on them rather than on an empty Interventions tab
    if (this.tab === "interventions" && !this.acts.size && !this.dets.size && this.chks.size) this.tab = "checks";
    this.setTab(this.tab, user);
    this.startTicking();
  }

  private close(user: boolean): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.panel.hidden = true;
    this.pill.hidden = false;
    this.pill.setAttribute("aria-expanded", "false");
    if (user) this.pill.focus();
  }

  private toggle(user: boolean): void {
    if (this.isOpen) this.close(user);
    else this.open(user);
  }

  private setTab(t: DevtoolsTab, focus = false): void {
    this.tab = t;
    for (const b of this.tabBtns) {
      const on = b.dataset.tab === t;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const [id, p] of Object.entries(this.panes)) p.hidden = id !== t;
    if (t === "now") this.renderNow();
    if (t === "expectations") this.renderExpectations();
    if (t === "activity") {
      const p = this.panes.activity;
      if (!this.scrolledActivity) {
        p.scrollTop = p.scrollHeight;
        this.scrolledActivity = true;
      }
    }
  }

  private setMode(m: Mode, focus = false): void {
    try {
      this.rt.setMode(m);
    } catch {
      /* the runtime keeps its mode */
    }
    this.renderMode();
    if (focus) this.modeBtns.find((b) => b.dataset.mode === this.mode())?.focus();
    // "Would have run … in guard mode" notes depend on the current mode.
    for (const e of this.dets.values()) e.dirty = true;
    this.mark(LISTS);
  }

  private setPaused(p: boolean): void {
    this.paused = p;
    this.pauseBtn.setAttribute("aria-pressed", String(p));
    this.pauseBtn.setAttribute("aria-label", p ? "Resume feed" : "Pause feed");
    this.pauseBtn.title = p ? "Resume feed" : "Pause feed";
    this.pauseBtn.replaceChildren(icon(p ? "play" : "pause"));
    if (!p) this.unseen = 0;
    this.bits |= LISTS | EVENTS;
    this.flush();
    if (this.tab === "now") this.renderNow();
    if (this.tab === "expectations") this.renderExpectations();
  }

  private clear(): void {
    for (const m of [this.acts, this.dets]) {
      for (const e of m.values()) e.el?.remove();
      m.clear();
    }
    for (const c of this.chks.values()) c.el?.remove();
    this.chks.clear();
    for (const r of this.rows) r.remove();
    this.rows = [];
    this.rowBySeq.clear();
    this.detOf.clear();
    this.opRows.clear();
    this.evq = [];
    this.unseen = 0;
    this.bits |= ALL;
    this.flush();
    this.emptyA.hidden = this.emptyD.hidden = this.emptyE.hidden = this.emptyC.hidden = false;
  }

  private roving(e: KeyboardEvent, items: HTMLElement[], pick: (el: HTMLElement) => void): void {
    const i = items.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    const n = items.length;
    const j =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (i + 1) % n
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? (i - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1;
    if (j < 0) return;
    e.preventDefault();
    pick(items[j]);
  }

  private tabKey(e: KeyboardEvent): void {
    this.roving(e, this.tabBtns, (b) => this.setTab(b.dataset.tab as DevtoolsTab, true));
  }

  private modeKey(e: KeyboardEvent): void {
    this.roving(e, this.modeBtns, (b) => this.setMode(b.dataset.mode as Mode, true));
  }

  private panelKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      this.close(true);
    }
  }

  // --------------------------------------------------------------------------------------------- timing

  private after(ms: number, fn: () => void): void {
    const c = this.clock;
    if (c) c.setTimeout(fn, ms);
    else rawSetTimeout?.(fn, ms);
  }

  /** While open: refresh "Now" every second and the "…ago" labels every 5 s. */
  private startTicking(): void {
    if (this.ticking) return;
    this.ticking = true;
    const tick = (): void => {
      if (this.dead || !this.isOpen) {
        this.ticking = false;
        return;
      }
      this.ticks++;
      if (this.tab === "now" && !this.paused) this.renderNow();
      if (this.tab === "expectations" && !this.paused && this.ticks % 5 === 0) this.renderExpectations();
      if (this.ticks % 5 === 0) {
        const now = this.now();
        for (const t of this.sr.querySelectorAll<HTMLElement>("time.ago")) t.textContent = ago(now - Number(t.dataset.at));
      }
      this.after(1000, tick);
    };
    this.after(1000, tick);
  }

  private unmount(): void {
    if (this.dead) return;
    this.dead = true;
    for (const off of this.offs.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.host.remove();
  }
}

// ------------------------------------------------------------------------------------------------ bits

/** Activity row text plus the op id the runtime's facts refer to ("#12"; "← #12" for the writer of a state event). */
function fillMain(m: Element, e: RtEvent): Element {
  const text = eventText(e);
  const id = e.op == null ? "" : e.kind === "state" ? `← #${e.op}` : `#${e.op}`;
  m.replaceChildren(text, ...(id ? [h("span", { class: "id", text: id })] : []));
  m.setAttribute("title", id ? `${text} (${id})` : text);
  return m;
}

function empty(ic: IconName, title: string, text: string): HTMLElement {
  return h("div", { class: "empty" }, h("div", { class: "ei" }, icon(ic)), h("b", { text: title }), h("span", { text }));
}

function sec(title: string, extra: Kid, ...kids: Kid[]): HTMLElement {
  return h("div", { class: "sec" }, h("h4", {}, title, extra ? [h("span", { class: "sp" }), extra] : null), ...kids);
}

function copyBtn(text: string, label = "Copy"): HTMLElement {
  const b = h("button", { class: "cp", type: "button", title: label, "data-act": "copy" }, icon("copy"), label);
  b.addEventListener("click", () => {
    const done = (ok: boolean): void => {
      b.replaceChildren(icon(ok ? "check" : "alert"), ok ? "Copied" : "Copy failed");
      rawSetTimeout?.(() => b.replaceChildren(icon("copy"), label), 1400);
    };
    const nav = (globalThis as { navigator?: { clipboard?: { writeText(s: string): Promise<void> } } }).navigator;
    if (nav?.clipboard) nav.clipboard.writeText(text).then(() => done(true), () => done(false));
    else done(false);
  });
  return b;
}

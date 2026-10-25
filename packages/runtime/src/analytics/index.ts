// Interaction analytics: the lazy chunk (docs/runtime/ANALYTICS.md). Loaded by src/analytics/start.ts only when the
// app turned analytics on and telemetry runs with the app's token (or a custom endpoint).
//
// Invariants:
// - Read-only on the page and the runtime (AGENTS.md rules 1 to 3): passive listeners, no preventDefault, no DOM
//   writes, in every mode. It never calls rt.user, rt.emit or rt.op and never writes to the event log; nothing it
//   computes reaches a situation, a fact, the gate or the model. It reads route changes from `nav` events
//   (rt.on("event")) and location.pathname, and queues its own telemetry events (TelemetryClient.push).
// - Counts per page view, sent as `interactions` events whose counts are deltas since the view's previous event:
//   page views, engaged time, scroll milestones, and clicks, rage clicks and dead clicks per element key. Never element
//   text, input values, coordinates, the order or timing of clicks, the query string or a visitor id.
// - Element keys come from markup only (keyOf); every part read from an attribute goes through telemetry's DATA_LIKE.
// - Only trusted events count (isTrusted, whatever observe.untrustedEvents says), never those inside
//   [data-genclass-ignore] (the devtools overlay).
// - Times come from the runtime's Clock (rule 5). No timer runs while the visitor is idle: the trailing scroll read
//   and the dead-click check arm one only after an event.
// - One file with no static imports: the script tag loads it by URL (src/cdn/global.ts), so what it shares with the
//   runtime comes in as arguments.

import type { RuntimeImpl } from "../runtime.js";
import type { RtEvent } from "../types.js";
import type { TelemetryClient } from "../telemetry/client.js";

// the version as a build-time constant (tsup.config.ts), not src/version.ts: this chunk has no static imports
declare const __GENCLASS_PKG_VERSION__: string;
const VERSION: string = typeof __GENCLASS_PKG_VERSION__ === "string" ? __GENCLASS_PKG_VERSION__ : "0.0.0";

/** Engaged time counts at most this long after the visitor's last input. */
export const IDLE_MS = 30_000;
/** Scroll depth milestones, in % of the page height reached by the bottom of the viewport. */
export const MILESTONES = [25, 50, 75, 100];
/** A rage click: this many clicks on the same element within RAGE_MS, counted once per burst. */
export const RAGE_CLICKS = 3;
export const RAGE_MS = 1000;
/** A dead click: nothing in the page changed within this long after a click on a link or button. */
export const DEAD_MS = 1000;
/** Distinct element keys per `interactions` event for clicks, and for rage and dead clicks; the rest are "(other)". */
export const MAX_CLICK_KEYS = 50;
export const MAX_FLAG_KEYS = 20;
export const KEY_MAX = 120;
/** Scroll position reads at most this often; other inputs update the engagement anchor at most this often. */
const SCROLL_MS = 250;
const INPUT_MS = 500;

/** The same selector as src/observe/dom-user.ts INTERACTIVE: a click inside a control counts for the control. */
const INTERACTIVE =
  "button,a,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[role=switch],[contenteditable=''],[contenteditable=true]";
/** Links and buttons: the elements a dead click is counted on. */
const DEAD = "a,button,[role=button],[role=link],[role=tab],[role=menuitem],input[type=button],input[type=submit],input[type=reset]";
const LANDMARKS = new Set(["header", "nav", "main", "aside", "footer", "form", "dialog"]);
// From src/visual/measure.ts (the visual chunk; a static import would make this chunk depend on another file).
const GENERATED_ID = /^[:«]|[:»]$|^(headlessui|radix|react-aria|mui|chakra|ember|ext-gen|yui_|j_id|rc_|__next)|^[a-f0-9-]{12,}$|\d{4,}/i;
const UTILITY = /^(text|bg|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min|max|flex|grid|gap|items|justify|rounded|border|shadow|font|leading|tracking|z|top|left|right|bottom|inset|block|inline|hidden|relative|absolute|fixed|sticky|overflow|opacity|transition|duration|ease|space|col|row|order|self|place|cursor|select|pointer|sr|not|dark|hover|focus|md|lg|sm|xl|2xl)(-|:|$)/;
function hashedClass(c: string): boolean {
  if (/^(css|sc|jsx|svelte|emotion|jss|makeStyles|tss)-|\d{3,}/.test(c)) return true;
  const m = /_([A-Za-z0-9-]{5,8})$/.exec(c);
  if (m && (/\d/.test(m[1]) || (/[A-Z]/.test(m[1]) && /[a-z]/.test(m[1])))) return true;
  return /^[a-z]{1,3}[A-Z0-9][A-Za-z0-9]{4,}$/.test(c);
}

type Loc = { href?: string; origin?: string; pathname?: string };
type G = Record<string, unknown> & {
  document?: Document & { prerendering?: boolean };
  location?: Loc;
  addEventListener?: (t: string, fn: (e: Event) => void, o?: AddEventListenerOptions) => void;
  removeEventListener?: (t: string, fn: (e: Event) => void, o?: AddEventListenerOptions) => void;
  getSelection?: () => { isCollapsed?: boolean } | null;
  MutationObserver?: typeof MutationObserver;
  URL?: typeof URL;
};

/** What keyOf needs about the page: the route normaliser (telemetry's) and the page location. */
export interface KeyContext {
  route(path: string): string | undefined;
  loc?: Loc;
  url?: typeof URL;
  data: RegExp;
}

const cut = (s: string): string => (s.length > KEY_MAX ? s.slice(0, KEY_MAX) : s);

/** An attribute value as a key part: no quotes, backslashes or control characters, at most 60 chars; "" when it looks like data. */
function part(v: string | null | undefined, data: RegExp): string {
  // eslint-disable-next-line no-control-regex
  const s = (v ?? "").replace(/["'\\\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return s && !data.test(s) ? s : "";
}

/** A link's target: `="/route"` (with a simple #fragment) on this origin, `^="https://other.site"` elsewhere. */
function hrefPart(raw: string | null, k: KeyContext): string {
  const U = k.url;
  if (!raw || !U) return "";
  let u: URL;
  try {
    u = new U(raw, k.loc?.href ?? "http://invalid/");
  } catch {
    return "";
  }
  if (u.protocol === "mailto:" || u.protocol === "tel:" || u.protocol === "sms:") return `^="${u.protocol}"`;
  if (!/^https?:$/.test(u.protocol)) return ""; // javascript:, data:, blob:
  if (u.origin !== k.loc?.origin) return `^="${u.origin}"`;
  const r = k.route(u.pathname);
  if (!r) return "";
  const frag = /^#[A-Za-z][\w-]{0,40}$/.test(u.hash) && !k.data.test(u.hash) ? u.hash : "";
  return `="${r}${frag}"`;
}

/** Rules 1 to 3 (an app-chosen name, a test id, a stable id), and with `full` rules 4 and 5 (a link's target, classes). */
function nameOf(el: Element, full: boolean, k: KeyContext): string {
  const tag = el.tagName.toLowerCase();
  let v = part(el.getAttribute("data-genclass-name"), k.data);
  if (v) return `[data-genclass-name="${v}"]`;
  v = part(el.getAttribute("data-testid") ?? el.getAttribute("data-test-id"), k.data);
  if (v) return `[data-testid="${v}"]`;
  const id = el.getAttribute("id");
  if (id && !GENERATED_ID.test(id) && (v = part(id, k.data)) && !/\s/.test(v)) return `${tag}#${v}`;
  if (!full) return "";
  if (tag === "a") {
    const h = hrefPart(el.getAttribute("href"), k);
    if (h) return `a[href${h}]`;
  }
  const cls = (el.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter((c) => /^[A-Za-z_-][\w-]*$/.test(c) && c.length <= 40 && !hashedClass(c) && !UTILITY.test(c) && !k.data.test(c))
    .slice(0, 2);
  return cls.length ? `${tag}${cls.map((c) => `.${c}`).join("")}` : "";
}

/**
 * The element key (ANALYTICS.md section 1): `[data-genclass-name="..."]`, `[data-testid="..."]`, `tag#id`,
 * `a[href="/route"]`, `tag.class.class`, else an nth-of-type path of up to 4 levels under the nearest ancestor with a
 * name (rules 1 to 3) or a landmark. Built from markup only, at most KEY_MAX characters.
 */
export function keyOf(el: Element | null | undefined, k: KeyContext): string {
  if (!el?.tagName) return "(page)";
  const tag = el.tagName.toLowerCase();
  if (tag === "html" || tag === "body") return tag;
  const own = nameOf(el, true, k);
  if (own) return cut(own);
  const parts: string[] = [];
  let cur: Element = el;
  for (let depth = 0; depth < 4; depth++) {
    const t = cur.tagName.toLowerCase();
    const p: Element | null = cur.parentElement;
    if (!p) {
      parts.unshift(t);
      break;
    }
    let n = 0;
    let at = 0;
    for (const c of Array.from(p.children)) {
      if (c.tagName === cur.tagName) n++;
      if (c === cur) at = n;
    }
    parts.unshift(n > 1 ? `${t}:nth-of-type(${at})` : t);
    const pt = p.tagName.toLowerCase();
    const anchor = pt === "body" || pt === "html" ? pt : nameOf(p, false, k) || (LANDMARKS.has(pt) ? pt : "");
    if (anchor) {
      parts.unshift(anchor);
      break;
    }
    cur = p;
  }
  return cut(parts.join(" > "));
}

/** The element the visitor acted on: the start of the composed path (inside open shadow roots), then its control. */
function targetOf(e: Event): Element | null {
  let el: Element | null = null;
  try {
    const n = (typeof e.composedPath === "function" ? e.composedPath()[0] : e.target) as (Node & Partial<Element>) | undefined;
    el = n && n.nodeType === 1 ? (n as Element) : (n?.parentElement ?? null);
  } catch {
    return null;
  }
  for (let cur = el, i = 0; cur && i < 32; i++) {
    const hit = cur.closest?.(INTERACTIVE);
    if (hit) return hit;
    const root = cur.getRootNode?.() as (Node & { host?: Element }) | undefined;
    cur = root?.host ?? null;
  }
  return el;
}

function insideIgnored(node: Node | null): boolean {
  let n = node as (Node & { host?: Node }) | null;
  for (let i = 0; n && i < 1000; i++) {
    if (typeof (n as Element).hasAttribute === "function" && (n as Element).hasAttribute("data-genclass-ignore")) return true;
    n = (n.parentNode ?? n.host ?? null) as (Node & { host?: Node }) | null;
  }
  return false;
}

const bump = (m: Map<string, number>, key: string, cap: number) => {
  const k = m.has(key) || m.size < cap ? key : "(other)";
  m.set(k, (m.get(k) ?? 0) + 1);
};

export interface AnalyticsController {
  /** Stop recording and drop the counts not sent yet. */
  stop(): void;
}

export interface AnalyticsChunk {
  startAnalytics(rt: RuntimeImpl, t: TelemetryClient, ignored: (e: Event) => boolean, data: RegExp, version?: string): AnalyticsController;
}

let noticeShown = false;
let mismatchShown = false;
export const ANALYTICS_NOTICE = "[GenClass] Interaction analytics are on (this app turned them on): page views, time on page, scroll depth and clicks per element, never page text.";

/** Interaction analytics first shipped in this runtime. */
export const ANALYTICS_SINCE = "0.3.0-beta.1";

/**
 * The warning when this chunk and the script tag that loaded it are not the same release (a self-hosted dist/ with
 * files of two versions), or null. `version`: the tag's (src/cdn/analytics-loader.ts); the ESM entries pass none,
 * since an app's bundler ships the chunk with the runtime it came with.
 */
export function versionMismatch(version: string | undefined): string | null {
  if (version === undefined || version === VERSION) return null;
  return `[GenClass] analytics: this analytics code is @genclass/runtime ${VERSION} but the script tag that loaded it is ${version}. Serve every file from one version's dist/ (interaction analytics need ${ANALYTICS_SINCE} or later: npm install @genclass/runtime@beta).`;
}

/**
 * Start recording (the stub checked telemetry and the token). `ignored`: dom-user's ignoredEvent; `data`: DATA_LIKE;
 * `version`: the script tag's version (one warning per page when it is not this chunk's; recording still starts).
 */
export function startAnalytics(rt: RuntimeImpl, t: TelemetryClient, ignored: (e: Event) => boolean, data: RegExp, version?: string): AnalyticsController {
  const g = rt.global as G;
  const doc = g.document;
  const mismatch = versionMismatch(version);
  if (mismatch && !mismatchShown) {
    mismatchShown = true;
    try {
      ((g.console as Console | undefined) ?? (globalThis as { console?: Console }).console)?.warn?.(mismatch);
    } catch {
      /* ignore */
    }
  }
  const clock = rt.clock;
  if (t.stopped || !doc || typeof g.addEventListener !== "function") return { stop() {} };
  const k: KeyContext = { route: (p) => t.route(p), loc: g.location, url: g.URL ?? (globalThis as { URL?: typeof URL }).URL, data };

  // the open page view (0: none; the next input opens one) and what it has not sent yet
  let views = 0;
  let view = 0;
  let route: string | undefined;
  let start = false;
  let engaged = 0;
  /** Engaged time is accounted up to `acc`; the visitor counts as engaged until `last` + IDLE_MS. */
  let acc = 0;
  let last = -Infinity;
  let lastInput = -Infinity;
  let visible = doc.visibilityState !== "hidden";
  let gone = false;
  /** Milestones (MILESTONES indexes) reached in this view, and already sent. */
  let reached = 0;
  let sentScroll = 0;
  let lastRead = -Infinity;
  let readTimer: unknown = null;
  const clicks = new Map<string, number>();
  const rage = new Map<string, number>();
  const dead = new Map<string, number>();
  // the rage-click burst on one element: its key, the click times within RAGE_MS, counted already
  let rk = "";
  let rq: number[] = [];
  let rcounted = false;
  // clicks on links and buttons waiting DEAD_MS for a change
  let pend: { id: number; key: string; href?: string; view: number }[] = [];
  let pid = 0;
  let mo: MutationObserver | null = null;
  const timers = new Set<unknown>();

  const here = () => t.route();
  const account = (at: number) => {
    if (view && visible) engaged += Math.max(0, Math.min(at, last + IDLE_MS) - acc);
    acc = Math.max(acc, at);
  };
  const open = (at: number) => {
    view = ++views;
    route = here();
    start = true;
    engaged = 0;
    acc = at;
    last = visible ? at : -Infinity;
    reached = sentScroll = 0;
    clicks.clear();
    rage.clear();
    dead.clear();
  };

  /** Read the scroll position: the milestones the bottom of the viewport reached (2 px slack). */
  const read = () => {
    lastRead = clock.now();
    if (!view) return;
    try {
      const de = doc.documentElement;
      const h = Math.max(de?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
      if (!(h > 0)) return;
      const y = typeof g.scrollY === "number" ? g.scrollY : (de?.scrollTop ?? 0);
      const vh = typeof g.innerHeight === "number" ? g.innerHeight : (de?.clientHeight ?? 0);
      let r = 0;
      while (r < MILESTONES.length && y + vh >= (h * MILESTONES[r]) / 100 - 2) r++;
      if (r > reached) reached = r;
    } catch {
      /* ignore */
    }
  };

  /** Queue this view's `interactions` event if anything changed; `end` closes the view. */
  const emit = (end: boolean, measure = true) => {
    if (!view) return;
    account(clock.now());
    if (measure) read();
    const e: Record<string, unknown> = { t: "interactions", view, route };
    let any = start;
    if (start) e.start = true;
    const ms = Math.round(engaged);
    if (ms > 0) {
      e.engagedMs = ms;
      any = true;
    }
    if (reached > sentScroll) {
      e.scroll = MILESTONES.slice(sentScroll, reached);
      sentScroll = reached;
      any = true;
    }
    for (const [name, m] of [
      ["clicks", clicks],
      ["rage", rage],
      ["dead", dead],
    ] as const) {
      if (!m.size) continue;
      e[name] = Object.fromEntries(m);
      m.clear();
      any = true;
    }
    start = false;
    engaged = 0;
    if (end) {
      e.end = true;
      view = 0;
    }
    if (any) t.push(e);
  };

  /** The view the visitor is on now: open one, or end the current one when the route changed. */
  const ensure = (at: number) => {
    if (!view) open(at);
    else if (here() !== route) {
      emit(true, false);
      open(at);
    }
  };
  const touch = (at: number) => {
    ensure(at);
    account(at);
    last = at;
    lastInput = at;
  };
  const trusted = (e: Event) => e.isTrusted !== false && !ignored(e);

  // pointermove and scroll fire many times a second: the clock comparison comes before the ancestor walk in trusted()
  const onInput = (e: Event) => {
    const at = clock.now();
    if ((at - lastInput >= INPUT_MS || !view) && trusted(e)) touch(at);
  };
  const onScroll = (e: Event) => {
    // the document's own scroll: its target is the document, never inside [data-genclass-ignore]
    if (e.isTrusted === false) return;
    const at = clock.now();
    if (at - lastInput >= INPUT_MS || !view) touch(at);
    if (at - lastRead >= SCROLL_MS) read();
    else if (readTimer === null)
      readTimer = clock.setTimeout(() => {
        readTimer = null;
        read();
      }, SCROLL_MS);
  };

  const deadCheck = (key: string) => {
    const MO = g.MutationObserver;
    const root = doc.documentElement;
    if (!MO || !root) return;
    if (!mo) {
      mo = new MO((recs) => {
        if (recs.some((r) => !insideIgnored(r.target))) {
          pend = [];
          mo?.disconnect();
          mo = null;
        }
      });
      mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    const p = { id: ++pid, key, href: g.location?.href, view };
    pend.push(p);
    const tm = clock.setTimeout(() => {
      timers.delete(tm);
      const i = pend.indexOf(p);
      if (i < 0) return;
      pend.splice(i, 1);
      if (!pend.length) {
        mo?.disconnect();
        mo = null;
      }
      if (!gone && visible && p.view === view && g.location?.href === p.href) bump(dead, p.key, MAX_FLAG_KEYS);
    }, DEAD_MS);
    timers.add(tm);
  };

  const onClick = (ev: Event) => {
    if (!trusted(ev)) return;
    const at = clock.now();
    touch(at);
    const el = targetOf(ev);
    const key = keyOf(el, k);
    bump(clicks, key, MAX_CLICK_KEYS);
    // rage: RAGE_CLICKS on one element within RAGE_MS, once per burst; not while the visitor selects text
    if (key !== rk) {
      rk = key;
      rq = [];
    }
    rq = rq.filter((x) => at - x < RAGE_MS);
    if (!rq.length) rcounted = false;
    rq.push(at);
    if (rq.length >= RAGE_CLICKS && !rcounted) {
      let selecting = false;
      try {
        selecting = g.getSelection?.()?.isCollapsed === false;
      } catch {
        /* ignore */
      }
      if (!selecting) {
        rcounted = true;
        bump(rage, key, MAX_FLAG_KEYS);
      }
    }
    // dead: a plain click on a link or button after which nothing changes (not a new tab, a download or a modified click)
    const m = ev as MouseEvent;
    const ctl = el?.closest?.(DEAD);
    if (!ctl || m.ctrlKey || m.metaKey || m.shiftKey || m.altKey || (typeof m.button === "number" && m.button !== 0)) return;
    if (ctl.tagName.toLowerCase() === "a" && (ctl.hasAttribute("download") || !/^(_self)?$/i.test(ctl.getAttribute("target") ?? ""))) return;
    deadCheck(key);
  };

  const onVisibility = () => {
    const at = clock.now();
    if (doc.visibilityState === "hidden") {
      // the telemetry client's own listener (added first) already queued this view's event through `pre`
      account(at);
      visible = false;
    } else {
      visible = true;
      acc = at;
      if (view) last = at;
      ensure(at);
    }
  };
  const onPageHide = () => {
    gone = true;
  };
  const onPageShow = () => {
    gone = false;
  };
  const onNav = (e: RtEvent) => {
    if (e.kind === "nav" && view && here() !== route) {
      emit(true, false);
      open(clock.now());
    }
  };

  const opts: AddEventListenerOptions = { capture: true, passive: true };
  const listeners: [EventTarget, string, (e: Event) => void, AddEventListenerOptions | undefined][] = [
    [g as unknown as EventTarget, "click", onClick, opts],
    [g as unknown as EventTarget, "pointerdown", onInput, opts],
    [g as unknown as EventTarget, "pointermove", onInput, opts],
    [g as unknown as EventTarget, "keydown", onInput, opts],
    [g as unknown as EventTarget, "wheel", onInput, opts],
    [g as unknown as EventTarget, "touchstart", onInput, opts],
    // the document's own scroll only (a scrolling container's events do not reach the window in the bubble phase)
    [g as unknown as EventTarget, "scroll", onScroll, { passive: true }],
    [doc, "visibilitychange", onVisibility, undefined],
    [g as unknown as EventTarget, "pagehide", onPageHide, undefined],
    [g as unknown as EventTarget, "pageshow", onPageShow, undefined],
  ];
  for (const [target, type, fn, o] of listeners) target.addEventListener(type, fn, o);
  const offNav = rt.on("event", (e) => {
    try {
      onNav(e);
    } catch {
      /* analytics never break the runtime */
    }
  });
  t.pre = (reason) => emit(reason === "pagehide" || reason === "destroy");

  // the first page view: now, or when a prerendered page is shown
  const first = () => open(clock.now());
  const prerendered = doc.prerendering === true;
  if (prerendered) doc.addEventListener("prerenderingchange", first, { once: true });
  else first();

  if (!noticeShown) {
    noticeShown = true;
    try {
      ((g.console as Console | undefined) ?? (globalThis as { console?: Console }).console)?.info?.(ANALYTICS_NOTICE);
    } catch {
      /* ignore */
    }
  }

  let stopped = false;
  const off = () => {
    if (stopped) return;
    stopped = true;
    for (const [target, type, fn, o] of listeners) target.removeEventListener(type, fn, o);
    if (prerendered) doc.removeEventListener("prerenderingchange", first);
    offNav();
    if (t.pre) t.pre = undefined;
    mo?.disconnect();
    mo = null;
    pend = [];
    for (const tm of [...timers, readTimer]) if (tm !== null) clock.clearTimeout(tm);
    timers.clear();
    readTimer = null;
  };
  // runtime destroyed: the telemetry client's teardown (registered first) already sent this view's last event
  rt.addTeardown(off);
  return {
    stop() {
      // consent withdrawn: nothing more is recorded and the counts not sent yet are dropped
      view = 0;
      off();
    },
  };
}

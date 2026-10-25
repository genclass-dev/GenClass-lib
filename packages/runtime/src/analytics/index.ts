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
// - Visits (ANALYTICS.md section 1.2): a view's first event names its visit (a random id kept in localStorage under
//   the app's token, replaced after VISIT_IDLE_MS without a page view or an event, or when a page load comes from
//   another site or a campaign link). The view that opens a visit also says where it came from (the referring host,
//   three utm values without ids), the device class, browser and OS families (buckets, never the user agent) and
//   whether this browser had a visit before (the stored flag). The stored entry is removed by stop(). Its own writes
//   set rt.selfStorage, so the storage observer does not record them. Visit times are wall-clock ms
//   (performance.timeOrigin plus the Clock), read only to compare with the stored time: nothing about them is sent.
// - Navigation paths (ANALYTICS.md section 11): on a view's first event, how it was reached (`nav`) and the previous
//   view of this page load with the ms between (`from`, `fromMs`); once per view, the element key of the first
//   interaction (`first`, `firstMs`); on the page load's last event (pagehide), `exit` and the ordered `path` of its
//   routes (at most PATH_MAX). Never the referrer (the visit's
//   `ref` is its own field), the history entries' keys or ids.
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
/** Routes in a page load's `path`; a longer path ends with "(more)". */
export const PATH_MAX = 10;
/** How a view was reached (ANALYTICS.md section 11.1). */
export type NavType = "load" | "reload" | "back_forward" | "push" | "back" | "forward" | "pop";
/** A visit ends after this long without a page view or an `interactions` event. */
export const VISIT_IDLE_MS = 30 * 60_000;
/** utm_* values and the referring host are cut to these lengths. */
export const UTM_MAX = 40;
export const REF_MAX = 80;
/** The localStorage key of the visit flag: this prefix and the app's token. */
export const VISIT_KEY = "genclass.analytics.";
/** Scroll position reads at most this often; other inputs update the engagement anchor at most this often. */
const SCROLL_MS = 250;
const INPUT_MS = 500;

/** The same selector as src/observe/dom-user.ts INTERACTIVE: a click inside a control counts for the control. */
const INTERACTIVE =
  "button,a,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[role=switch],[contenteditable=''],[contenteditable=true]";
/** Links and buttons: the elements a dead click is counted on. */
const DEAD = "a,button,[role=button],[role=link],[role=tab],[role=menuitem],input[type=button],input[type=submit],input[type=reset]";
/** Form fields: a keyboard user's first interaction is often a focus on one. */
const FIELD = "input,select,textarea,[contenteditable=''],[contenteditable=true]";
/** A focus counts as an interaction when a key was pressed this recently (Tab), not when the page moved focus. */
const FOCUS_KEY_MS = 1000;
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

type Loc = { href?: string; origin?: string; pathname?: string; hostname?: string; search?: string };
type G = Record<string, unknown> & {
  localStorage?: Storage;
  performance?: { timeOrigin?: number };
  navigator?: { userAgent?: string; maxTouchPoints?: number; userAgentData?: { mobile?: boolean } };
  crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
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

/** The device class, browser family and OS family, from the user agent string and its hints. Never the string itself. */
export function deviceOf(ua: string, hint: { mobile?: boolean; touch?: number } = {}): { device: string; browser: string; os: string } {
  const touchMac = /Macintosh/.test(ua) && (hint.touch ?? 0) > 1; // iPadOS asks for desktop sites with a Mac string
  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad|iPod/.test(ua) || touchMac
      ? "iOS"
      : /CrOS/.test(ua)
        ? "ChromeOS"
        : /Android/.test(ua)
          ? "Android"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Linux|X11/.test(ua)
              ? "Linux"
              : "Other";
  const device =
    /iPad|Tablet|PlayBook|Silk/.test(ua) || touchMac || (os === "Android" && !/Mobile/.test(ua))
      ? "tablet"
      : hint.mobile === true || /Mobi|iPhone|iPod|Android/.test(ua)
        ? "mobile"
        : "desktop";
  const browser = /bot|crawl|spider|Headless/i.test(ua)
    ? "Other"
    : /Edg(e|A|iOS)?\//.test(ua)
      ? "Edge"
      : /OPR\/|Opera/.test(ua)
        ? "Opera"
        : /SamsungBrowser/.test(ua)
          ? "Samsung Internet"
          : /Firefox\/|FxiOS/.test(ua)
            ? "Firefox"
            : /CriOS|Chrome\//.test(ua)
              ? "Chrome"
              : /Safari\//.test(ua)
                ? "Safari"
                : "Other";
  return { device, browser, os };
}

/** The referring site as its host ("www." dropped), when it is not this site; "(other)" when the host looks like data. */
export function refHost(referrer: string | undefined, host: string | undefined, U: typeof URL | undefined, data: RegExp): string | undefined {
  if (!referrer || !U) return undefined;
  let h: string;
  try {
    const u = new U(referrer);
    if (!/^(https?|android-app):$/.test(u.protocol)) return undefined;
    h = u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
  if (!h || h === (host ?? "").toLowerCase().replace(/^www\./, "")) return undefined;
  return h.length > REF_MAX || data.test(h) ? "(other)" : h;
}

/** A utm_* value as sent: lower case, letters, digits and . _ + - and spaces, id-like words dropped, at most UTM_MAX. */
export function utmValue(v: string | null | undefined, data: RegExp): string | undefined {
  const s = (v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ._+-]/g, "")
    .replace(/[a-z0-9]+/g, (w) => (/\d{4,}|^[0-9a-f]{8,}$/.test(w) || w.length >= 20 ? "" : w))
    .replace(/([ ._+-])[ ._+-]+/g, "$1")
    .replace(/^[ ._+-]+|[ ._+-]+$/g, "")
    .slice(0, UTM_MAX)
    .replace(/[ ._+-]+$/, "");
  return s && !data.test(s) ? s : undefined;
}

export interface AnalyticsController {
  /** Stop recording and drop the counts not sent yet. */
  stop(): void;
}

export interface AnalyticsChunk {
  startAnalytics(rt: RuntimeImpl, t: TelemetryClient, ignored: (e: Event) => boolean, data: RegExp, version?: string): AnalyticsController;
}

let noticeShown = false;
let mismatchShown = false;
export const ANALYTICS_NOTICE =
  "[GenClass] Interaction analytics are on (this app turned them on): page views and the path between them, visits, time on page, scroll depth, clicks per element, the referring site, campaign and device type, never page text.";

/** Navigation Timing's type for the page load's first view: "load", "reload" or "back_forward". */
export function loadNav(g: { performance?: { getEntriesByType?: (t: string) => { type?: string }[] } }): NavType {
  try {
    const t = g.performance?.getEntriesByType?.("navigation")?.[0]?.type;
    return t === "reload" ? "reload" : t === "back_forward" ? "back_forward" : "load";
  } catch {
    return "load";
  }
}

/** The direction of a history traversal from the Navigation API's entry indexes ("pop" when either is unknown). */
export function popNav(before: number | undefined, after: number | undefined): NavType {
  if (typeof before !== "number" || typeof after !== "number" || before === after) return "pop";
  return after < before ? "back" : "forward";
}

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
  // navigation: how the open view was reached, the previous view of this page load, the first interaction, the path
  let nav: NavType = loadNav(g as Parameters<typeof loadNav>[0]);
  let pendingNav: NavType | null = null;
  let from: string | undefined;
  let fromMs = 0;
  let opened = 0;
  let prevRoute: string | undefined;
  let prevOpened = 0;
  let firstKey = "";
  let firstMs = 0;
  let firstSent = false;
  let lastKey = -Infinity;
  let path: string[] = [];
  const entryIndex = (): number | undefined => {
    try {
      const i = (g.navigation as { currentEntry?: { index?: number } } | undefined)?.currentEntry?.index;
      return typeof i === "number" && i >= 0 ? i : undefined;
    } catch {
      return undefined;
    }
  };
  let navIndex = entryIndex();

  // the visit: its id, whether the next view is this page load's first, and what the view that opened it sends
  const owner = rt as unknown as { selfStorage: boolean };
  const skey = VISIT_KEY + (t.token ?? "endpoint");
  const origin0 = g.performance?.timeOrigin;
  const wall = () => (typeof origin0 === "number" ? origin0 + clock.now() : NaN);
  let visit = "";
  let firstView = true;
  let entry: Record<string, unknown> | null = null;
  const store = (v: string | null) => {
    owner.selfStorage = true;
    try {
      if (v === null) g.localStorage?.removeItem(skey);
      else g.localStorage?.setItem(skey, v);
    } catch {
      /* storage blocked: the visit lasts this page load */
    } finally {
      owner.selfStorage = false;
    }
  };
  const keepVisit = () => {
    const now = wall();
    if (visit && Number.isFinite(now)) store(JSON.stringify({ v: visit, t: Math.round(now), r: 1 }));
  };
  /** Where this page load came from: another site's host and the utm values (only for its first view). */
  const sources = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const ref = refHost(doc.referrer, g.location?.hostname, k.url, data);
    if (ref) out.ref = ref;
    try {
      const q = new URLSearchParams(g.location?.search ?? "");
      const utm: Record<string, string> = {};
      for (const f of ["source", "medium", "campaign"]) {
        const v = utmValue(q.get(`utm_${f}`), data);
        if (v) utm[f] = v;
      }
      if (Object.keys(utm).length) out.utm = utm;
    } catch {
      /* ignore */
    }
    return out;
  };
  /** The visit the view opening now belongs to: the stored one while it is fresh, else a new one (with `entry`). */
  const enter = () => {
    const now = wall();
    const src = firstView ? sources() : {};
    firstView = false;
    let prev: Record<string, unknown> | null = null;
    let readable = true;
    try {
      prev = JSON.parse(g.localStorage?.getItem(skey) ?? "null") as Record<string, unknown> | null;
    } catch {
      readable = false;
    }
    const pv = prev?.v;
    const pt = prev?.t;
    let cont =
      readable && Number.isFinite(now)
        ? typeof pv === "string" && /^[0-9a-f]{16}$/.test(pv) && typeof pt === "number" && Math.abs(now - pt) < VISIT_IDLE_MS
          ? pv
          : ""
        : visit;
    // (a stored time ahead of now, from rounding or a clock set back, counts by its distance); a page load from another
    // site or a campaign link starts a visit, as an idle gap does
    if (src.ref || src.utm) cont = "";
    if (cont) {
      visit = cont;
      entry = null;
    } else {
      visit = "";
      try {
        const b = g.crypto?.getRandomValues?.(new Uint8Array(8));
        if (b) visit = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      } catch {
        /* no visit without a random id */
      }
      const nav = g.navigator;
      entry = visit
        ? {
            entry: true,
            ...src,
            ...deviceOf(String(nav?.userAgent ?? ""), { mobile: nav?.userAgentData?.mobile, touch: nav?.maxTouchPoints }),
            ...(readable ? { returning: !!prev && prev.r === 1 } : {}),
          }
        : null;
    }
    keepVisit();
  };

  const here = () => t.route();
  const account = (at: number) => {
    if (view && visible) engaged += Math.max(0, Math.min(at, last + IDLE_MS) - acc);
    acc = Math.max(acc, at);
  };
  const open = (at: number) => {
    view = ++views;
    route = here();
    start = true;
    // the first view of a page load keeps its load type; later ones were reached by a traversal or a route change
    if (pendingNav) nav = pendingNav;
    else if (prevRoute !== undefined) nav = "push";
    pendingNav = null;
    from = prevRoute;
    fromMs = prevRoute !== undefined ? Math.max(0, Math.round(at - prevOpened)) : 0;
    prevRoute = route;
    prevOpened = opened = at;
    navIndex = entryIndex();
    firstKey = "";
    firstSent = false;
    if (path.length < PATH_MAX) path.push(route ?? "(unknown)");
    else if (path.length === PATH_MAX) path.push("(more)");
    engaged = 0;
    acc = at;
    last = visible ? at : -Infinity;
    reached = sentScroll = 0;
    clicks.clear();
    rage.clear();
    dead.clear();
    enter();
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

  /** Queue this view's `interactions` event if anything changed; `end` closes the view, `exit` the page load. */
  const emit = (end: boolean, measure = true, exit = false) => {
    if (!view) return;
    account(clock.now());
    if (measure) read();
    const e: Record<string, unknown> = { t: "interactions", view, route };
    let any = start;
    if (start) {
      e.start = true;
      e.nav = nav;
      if (from !== undefined) {
        e.from = from;
        e.fromMs = fromMs;
      }
      if (visit) e.visit = visit;
      if (entry) Object.assign(e, entry);
      entry = null;
    }
    if (firstKey && !firstSent) {
      e.first = firstKey;
      e.firstMs = firstMs;
      firstSent = true;
      any = true;
    }
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
    if (exit) {
      // where this page load ended, and the routes it went through; a restore from the back/forward cache starts anew
      e.exit = true;
      e.path = path;
      path = [];
      prevRoute = undefined;
      any = true;
    }
    if (any) {
      t.push(e);
      keepVisit();
    }
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

  /** The view's first interaction: a click, or a focus on a form field right after a key press. */
  const firstAt = (key: string, at: number) => {
    if (firstKey || !view) return;
    firstKey = key;
    firstMs = Math.max(0, Math.round(at - opened));
  };
  const onKey = (e: Event) => {
    if (e.isTrusted !== false) lastKey = clock.now();
    onInput(e);
  };
  const onFocus = (e: Event) => {
    const at = clock.now();
    if (firstKey || at - lastKey > FOCUS_KEY_MS || !trusted(e)) return;
    const el = targetOf(e);
    const field = el?.closest?.(FIELD);
    if (!field) return;
    touch(at);
    firstAt(keyOf(field, k), at);
  };
  const onPop = () => {
    const dir = popNav(navIndex, entryIndex());
    navIndex = entryIndex();
    if (here() !== route) pendingNav = dir;
    // the nav observer's listener ran first and already opened this view as a route change: it was a traversal
    else if (view && start && nav === "push" && clock.now() - opened < 50) nav = dir;
  };

  const onClick = (ev: Event) => {
    if (!trusted(ev)) return;
    const at = clock.now();
    touch(at);
    const el = targetOf(ev);
    const key = keyOf(el, k);
    bump(clicks, key, MAX_CLICK_KEYS);
    firstAt(key, at);
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
  const onPageShow = (e: Event) => {
    gone = false;
    // restored from the back/forward cache: the next view starts a new path, reached by back or forward
    if ((e as PageTransitionEvent).persisted) {
      pendingNav = "back_forward";
      prevRoute = undefined;
    }
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
    [g as unknown as EventTarget, "keydown", onKey, opts],
    [g as unknown as EventTarget, "focusin", onFocus, opts],
    // capture: at the window it runs before the nav observer's own popstate listener
    [g as unknown as EventTarget, "popstate", onPop, { capture: true }],
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
  t.pre = (reason) => emit(reason === "pagehide" || reason === "destroy", true, reason === "pagehide");

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
      // consent withdrawn: nothing more is recorded, the counts not sent yet are dropped and the visit flag removed
      view = 0;
      off();
      store(null);
    },
  };
}

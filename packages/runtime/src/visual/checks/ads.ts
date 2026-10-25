// ad-heavy (docs/runtime/VISUAL.md 3.25): the share of the first screen and of the page that ad slots cover, from
// the names the markup gives them and the boxes they take. adWords, adNamed, adSize, unionArea, adShares and
// adVerdict are pure and unit-tested (test/visual-strange.test.ts).
//
// Thresholds (Coalition for Better Ads, Better Ads Standards, desktop and mobile):
// - AD_PAGE_SHARE 0.3: ad density higher than 30% (mobile), here as the share of the page's area.
// - AD_STICKY_SHARE 0.3: a sticky ad over 30% of the screen (large sticky ads).
// - AD_INTERSTITIAL_SHARE 0.5: a fixed ad over half the screen and on top (prestitials, full-screen scrollovers).
// - AD_FIRST_SHARE 0.5: more than half the first screen is ads.
// - AD_SIZE_PX 2: a cross-site iframe within 2 px of a fixed display ad size is ad-like.
// Reads only: names (id, class, a few ad attributes) without layout, then rects and one hit test per fixed region.

import type { Ctx, Draft } from "../draft.js";
import { named } from "../draft.js";
import { sameSite, type Reader } from "../measure.js";

export const AD_PAGE_SHARE = 0.3;
export const AD_STICKY_SHARE = 0.3;
export const AD_INTERSTITIAL_SHARE = 0.5;
export const AD_FIRST_SHARE = 0.5;
export const AD_SIZE_PX = 2;
/** Names read per pass (no layout), and regions measured. */
const MAX_NAMES = 5000;
/** Ad-like candidates kept for measuring (each costs a visibility read and a rect in one step). */
const MAX_CANDS = 200;
const MAX_REGIONS = 50;
/** A region is at least this big (tracking pixels and collapsed slots are not ad space). */
const MIN_W = 40;
const MIN_H = 20;

/** Words in an id or class name that name an ad slot (VISUAL.md 3.25). */
const AD_WORDS = new Set(["ad", "ads", "advert", "adverts", "advertisement", "advertisements", "advertising", "adslot", "adunit", "adbox", "adsbygoogle", "adsense", "sponsored"]);
/** Attributes the ad tags write (AdSense, Ad Manager, Prebid). */
const AD_ATTRS = ["data-ad-slot", "data-ad-client", "data-ad-unit", "data-ad-unit-path", "data-adunit", "data-google-query-id"];
/** The prefilter: names that may hold an ad word, the ad attributes, and iframes. */
const AD_SEL = `[id*="ad" i], [class*="ad" i], [id*="sponsor" i], [class*="sponsor" i], ${AD_ATTRS.map((a) => `[${a}]`).join(", ")}, iframe`;
/** Fixed display ad sizes (the IAB standard units and the sizes Google AdSense lists). */
export const AD_SIZES: [number, number][] = [
  [300, 250],
  [336, 280],
  [728, 90],
  [970, 90],
  [970, 250],
  [300, 600],
  [160, 600],
  [120, 600],
  [300, 1050],
  [320, 50],
  [320, 100],
  [300, 50],
  [468, 60],
  [250, 250],
  [200, 200],
];

/** The words of a name: split at `-`, `_`, digits, other punctuation and lower-to-upper case changes, lowercased. */
export function adWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** An id, a class list or an attribute set names an ad slot. */
export function adNamed(id: string, classes: string[], attrs: string[] = []): boolean {
  if (attrs.some((a) => AD_ATTRS.includes(a))) return true;
  for (const n of [id, ...classes]) if (n && adWords(n).some((w) => AD_WORDS.has(w))) return true;
  return false;
}

/** A box is a fixed display ad size within AD_SIZE_PX. */
export function adSize(w: number, h: number): boolean {
  return AD_SIZES.some(([aw, ah]) => Math.abs(w - aw) <= AD_SIZE_PX && Math.abs(h - ah) <= AD_SIZE_PX);
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The area of the union of boxes, each clipped to `clip` (coordinate compression; at most MAX_REGIONS boxes). */
export function unionArea(boxes: Box[], clip: Box): number {
  const bs = boxes
    .map((b) => ({ left: Math.max(b.left, clip.left), top: Math.max(b.top, clip.top), right: Math.min(b.right, clip.right), bottom: Math.min(b.bottom, clip.bottom) }))
    .filter((b) => b.right > b.left && b.bottom > b.top);
  if (!bs.length) return 0;
  const xs = [...new Set(bs.flatMap((b) => [b.left, b.right]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    const spans = bs
      .filter((b) => b.left <= x0 && b.right >= x1)
      .map((b) => [b.top, b.bottom] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let s = -Infinity;
    let e = -Infinity;
    for (const [t, bt] of spans) {
      if (t > e) {
        if (e > s) covered += e - s;
        s = t;
        e = bt;
      } else if (bt > e) e = bt;
    }
    if (e > s) covered += e - s;
    area += covered * (x1 - x0);
  }
  return area;
}

/** One ad-like region as measured: its box in document coordinates (fixed: on the screen) and whether it is fixed. */
export interface Region {
  box: Box;
  fixed: boolean;
  /** A fixed region is on top at its centre (elementFromPoint lands inside it). */
  onTop?: boolean;
}

export interface AdShares {
  firstShare: number;
  pageShare: number;
  fixedShare: number;
  /** The largest fixed region that is on top, as a share of the screen. */
  topShare: number;
  count: number;
}

/** VISUAL.md 3.25: the shares of the first screen, the page and the largest fixed region. */
export function adShares(regions: Region[], vw: number, vh: number, pageH: number): AdShares {
  const screen = Math.max(1, vw * vh);
  const page = Math.max(1, vw * Math.max(pageH, vh));
  const flow = regions.filter((r) => !r.fixed).map((r) => r.box);
  const fixed = regions.filter((r) => r.fixed);
  const view: Box = { left: 0, top: 0, right: vw, bottom: vh };
  const firstShare = unionArea([...flow, ...fixed.map((r) => r.box)], view) / screen;
  const fixedAll = unionArea(fixed.map((r) => r.box), view) / screen;
  const inFlow = unionArea(flow, { left: 0, top: 0, right: vw, bottom: Math.max(pageH, vh) }) / page;
  const one = (r: Region) => unionArea([r.box], view) / screen;
  return {
    firstShare,
    pageShare: 1 - (1 - inFlow) * (1 - fixedAll),
    fixedShare: Math.max(0, ...fixed.map(one)),
    topShare: Math.max(0, ...fixed.filter((r) => r.onTop).map(one)),
    count: regions.length,
  };
}

export type AdReason = "interstitial" | "sticky" | "density" | "first-screen";

/** The reason to report, in the order of VISUAL.md 3.25, or null. */
export function adVerdict(s: AdShares): AdReason | null {
  if (!s.count) return null;
  if (s.topShare >= AD_INTERSTITIAL_SHARE) return "interstitial";
  if (s.fixedShare >= AD_STICKY_SHARE) return "sticky";
  if (s.pageShare >= AD_PAGE_SHARE) return "density";
  if (s.firstShare >= AD_FIRST_SHARE) return "first-screen";
  return null;
}

/** Candidates whose names or size make them ad-like (names read without layout, in steps of 50). */
function* adCandidates(ctx: Ctx, out: Element[]): Generator<void> {
  const r = ctx.r;
  const doc = r.doc;
  let list: NodeListOf<Element>;
  try {
    list = doc.querySelectorAll(AD_SEL);
  } catch {
    return;
  }
  const loc = ctx.win.location;
  let n = 0;
  for (const el of list) {
    if (++n > MAX_NAMES || out.length >= MAX_CANDS) break;
    if (n % 50 === 0) yield;
    if (el === doc.documentElement || el === doc.body) continue;
    if (el.tagName === "IFRAME") {
      const src = el.getAttribute("src") ?? "";
      if (/^https?:|^\/\//i.test(src) && !sameSite(src, loc)) out.push(el);
      continue;
    }
    const attrs = AD_ATTRS.filter((a) => el.hasAttribute(a));
    if (adNamed(el.id, [...el.classList], attrs)) out.push(el);
  }
}

/** Measure the candidates: visible regions of at least MIN_W x MIN_H, iframes only at ad sizes, the outermost kept. */
export function measureRegions(r: Reader, cands: Element[]): { el: Element; region: Region }[] {
  const doc = r.doc;
  const vw = r.vw;
  const pageH = Math.max(doc.documentElement.scrollHeight, r.vh);
  const sy = r.win.scrollY;
  const kept: { el: Element; region: Region }[] = [];
  for (const el of cands) {
    if (kept.length >= MAX_REGIONS) break;
    if (kept.some((k) => k.el.contains(el))) continue;
    if (!r.visible(el)) continue;
    const rc = r.rect(el);
    if (rc.width < MIN_W || rc.height < MIN_H) continue;
    if (el.tagName === "IFRAME" && !adSize(rc.width, rc.height)) continue;
    const pin = r.pinned(el);
    const fixed = !!pin && r.cs(pin).position === "fixed";
    // an in-flow wrapper the size of the page is layout, not an ad slot
    if (!fixed && rc.width * rc.height > 0.5 * vw * pageH) continue;
    const box: Box = fixed ? { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom } : { left: rc.left, top: rc.top + sy, right: rc.right, bottom: rc.bottom + sy };
    const region: Region = { box, fixed };
    if (fixed) {
      const hit = r.at(Math.floor((rc.left + rc.right) / 2), Math.floor((rc.top + rc.bottom) / 2));
      region.onTop = !!hit && el.contains(hit);
    }
    // an outer region found later replaces the inner ones it holds
    for (let i = kept.length - 1; i >= 0; i--) if (el.contains(kept[i].el)) kept.splice(i, 1);
    kept.push({ el, region });
  }
  return kept;
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const two = (x: number): number => Math.round(x * 100) / 100;

function adDraft(ctx: Ctx, regions: { el: Element; region: Region }[], s: AdShares, reason: AdReason): Draft {
  const area = (b: Box) => (b.right - b.left) * (b.bottom - b.top);
  const big = regions.reduce((a, b) => (area(b.region.box) > area(a.region.box) ? b : a));
  const what =
    reason === "interstitial"
      ? `an ad (${named(ctx, big.el)}) covers ${pct(s.topShare)} of the screen on top of the page (threshold ${pct(AD_INTERSTITIAL_SHARE)}: an interstitial)`
      : reason === "sticky"
        ? `a fixed ad (${named(ctx, big.el)}) covers ${pct(s.fixedShare)} of the screen (threshold ${pct(AD_STICKY_SHARE)}, Better Ads large sticky ads)`
        : reason === "density"
          ? `ad slots cover ${pct(s.pageShare)} of the page (threshold ${pct(AD_PAGE_SHARE)}, Better Ads ad density)`
          : `ad slots cover ${pct(s.firstShare)} of the first screen (threshold ${pct(AD_FIRST_SHARE)})`;
  const threshold =
    reason === "interstitial" ? AD_INTERSTITIAL_SHARE : reason === "sticky" ? AD_STICKY_SHARE : reason === "density" ? AD_PAGE_SHARE : AD_FIRST_SHARE;
  return {
    kind: "ad-heavy",
    el: big.el,
    els: regions.map((x) => x.el),
    count: regions.length,
    key: `ad-heavy|${reason}`,
    severity: reason === "interstitial" ? "high" : "medium",
    measured: { reason, count: s.count, firstShare: two(s.firstShare), pageShare: two(s.pageShare), fixedShare: two(s.fixedShare) },
    threshold: {
      value: threshold,
      unit: reason === "density" ? "share of the page" : "share of the screen",
      source: "Coalition for Better Ads standards (ad density, large sticky ads, prestitials); ad slots named by id, class or ad attributes, or cross-site iframes at ad sizes (VISUAL.md 3.25)",
    },
    text: `${what}: ${s.count} ad slot${s.count === 1 ? "" : "s"}, ${pct(s.firstShare)} of the first screen and ${pct(s.pageShare)} of the page.`,
    fixText:
      reason === "interstitial"
        ? "do not cover the page with an ad before the content: show it inline, or after the visitor's action with a visible close button"
        : "use fewer or smaller ad units: under 30% of the page on phones, no sticky unit over 30% of the screen, and reserve each slot's space so it does not shift the page",
  };
}

/** VISUAL.md 3.25, on full passes: candidates by name (in steps), the regions, the shares; confirmed 2 s later. */
export function* adHeavy(ctx: Ctx, out: Draft[]): Generator<void> {
  if (!ctx.on("ad-heavy")) return;
  const cands: Element[] = [];
  yield* adCandidates(ctx, cands);
  if (!cands.length) return;
  yield;
  const measure = (r: Reader): { regions: { el: Element; region: Region }[]; s: AdShares; reason: AdReason | null } => {
    const regions = measureRegions(r, cands);
    const s = adShares(
      regions.map((x) => x.region),
      r.vw,
      r.vh,
      r.doc.documentElement.scrollHeight,
    );
    return { regions, s, reason: adVerdict(s) };
  };
  const m = measure(ctx.r);
  const reason = m.reason;
  if (!reason || m.regions.some((x) => ctx.r.animating(x.el))) return;
  const d = adDraft(ctx, m.regions, m.s, reason);
  d.persistMs = 2000;
  d.quiet = true;
  d.recheck = (r) => {
    const again = measure(r);
    return again.reason === reason && !again.regions.some((x) => r.animating(x.el)) ? adDraft(ctx, again.regions, again.s, reason) : null;
  };
  out.push(d);
}

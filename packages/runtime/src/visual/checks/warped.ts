// text-warped (docs/runtime/VISUAL.md 3.26): visible text a reader cannot read as text. Every reason is a measurement
// of boxes (Range line boxes, element rects, computed transform, font-size, letter-spacing, word-spacing) or of code
// points; nothing reads what the text says. parseLinear, chainVerdict, lineOverlap, clipCut, tofuChars and
// spacingVerdict are pure and unit-tested (test/visual-strange.test.ts).
//
// Thresholds:
// - LINE_OVERLAP 0.5: two line boxes overlap by half the smaller one's height (normal line-height from 1.0 leaves at
//   most about 25% overlap of the font's content area), and OVERLAP_X_PX 8 horizontally.
// - CLIP_PX 4 and CLIP_VISIBLE 0.2..0.8: a line cut mid-way by its overflow box.
// - SKEW_DEG 20 (design slants are 8 to 15 degrees), STRETCH 2, a negative determinant for mirrored text.
// - WIDE_EM 0.5 (wider than a space, 0.25 to 0.33 em), TIGHT_EM -0.2 (display headings use -0.02 to -0.05 em).
// - TINY_PX 8 rendered, with a drawn line box under TINY_BOX_PX 10.

import type { Ctx, Draft } from "../draft.js";
import { named, px } from "../draft.js";
import { parseColor } from "../math.js";
import { containsDeep, parentOf, REPLACED, safeMatches, type Reader } from "../measure.js";
import { skipText } from "./text.js";

export const LINE_OVERLAP = 0.5;
export const OVERLAP_X_PX = 8;
export const CLIP_PX = 4;
export const CLIP_VISIBLE_MIN = 0.2;
export const CLIP_VISIBLE_MAX = 0.8;
export const SKEW_DEG = 20;
export const STRETCH = 2;
export const WIDE_EM = 0.5;
export const TIGHT_EM = -0.2;
export const TINY_PX = 8;
export const TINY_BOX_PX = 10;
/** Ancestors read for the transform chain, and for the clipping box. */
const CHAIN = 30;
const CLIP_UP = 3;
/** Line boxes read per text node. */
const LINES = 20;

export type WarpReason = "overlap" | "clipped" | "tofu" | "mirrored" | "skewed" | "spacing" | "tiny";

// ------------------------------------------------------------------------------------------------ transforms

/** A 2 x 2 linear map [a, b, c, d]: x' = a x + c y, y' = b x + d y (CSS matrix() order). */
export type Linear = [number, number, number, number];
export const IDENTITY: Linear = [1, 0, 0, 1];

export function mul(m: Linear, n: Linear): Linear {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3]];
}

function angle(v: string): number | null {
  const m = /^(-?[\d.]+(?:e-?\d+)?)(deg|rad|turn|grad)?$/.exec(v.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2] ?? "deg";
  return u === "deg" ? (n * Math.PI) / 180 : u === "rad" ? n : u === "turn" ? n * 2 * Math.PI : (n * Math.PI) / 200;
}

/**
 * The linear part of computed `transform`, `rotate` and `scale` values (null: not parsed, the element is skipped).
 * matrix3d is projected onto the screen plane (its upper-left 2 x 2, perspective ignored): rotateY(180deg) mirrors.
 */
export function parseLinear(transform: string, rotate = "none", scale = "none"): Linear | null {
  let t: Linear = IDENTITY;
  const tr = (transform || "none").trim();
  if (tr !== "none") {
    const m = /^matrix(3d)?\(([^)]*)\)$/.exec(tr);
    if (!m) return null;
    const v = m[2].split(",").map((x) => parseFloat(x));
    if (v.some((x) => !Number.isFinite(x))) return null;
    if (m[1] ? v.length !== 16 : v.length !== 6) return null;
    t = m[1] ? [v[0], v[1], v[4], v[5]] : [v[0], v[1], v[2], v[3]];
  }
  let r: Linear = IDENTITY;
  const ro = (rotate || "none").trim();
  if (ro !== "none") {
    const p = ro.split(/\s+/);
    const a = angle(p[p.length - 1]);
    if (a === null) return null;
    let ax: [number, number, number] = [0, 0, 1];
    if (p.length === 2) ax = p[0] === "x" ? [1, 0, 0] : p[0] === "y" ? [0, 1, 0] : [0, 0, 1];
    else if (p.length === 4) ax = [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2])];
    const len = Math.hypot(...ax);
    if (!(len > 0)) return null;
    const [x, y, z] = ax.map((q) => q / len);
    const c = Math.cos(a);
    const s = Math.sin(a);
    // the upper-left 2 x 2 of the 3D rotation about (x, y, z)
    r = [c + x * x * (1 - c), y * x * (1 - c) + z * s, x * y * (1 - c) - z * s, c + y * y * (1 - c)];
  }
  let sc: Linear = IDENTITY;
  const sv = (scale || "none").trim();
  if (sv !== "none") {
    const p = sv.split(/\s+/).map((q) => (q.endsWith("%") ? parseFloat(q) / 100 : parseFloat(q)));
    if (!p.length || p.some((q) => !Number.isFinite(q))) return null;
    sc = [p[0], 0, 0, p[1] ?? p[0]];
  }
  // CSS Transforms 2: translate, then rotate, then scale, then transform
  return mul(mul(r, sc), t);
}

export interface ChainVerdict {
  det: number;
  /** Degrees away from a right angle between the mapped axes. */
  skew: number;
  /** The longer mapped axis over the shorter. */
  stretch: number;
  /** sqrt(|det|): how much the text is scaled. */
  scale: number;
  /** No rotation or skew: boxes from getClientRects are the text's own boxes. */
  aligned: boolean;
}

export function chainVerdict(m: Linear): ChainVerdict {
  const [a, b, c, d] = m;
  const det = a * d - b * c;
  const lu = Math.hypot(a, b);
  const lv = Math.hypot(c, d);
  const cos = lu > 0 && lv > 0 ? (a * c + b * d) / (lu * lv) : 0;
  const skew = Math.abs(90 - (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
  const eps = 1e-3;
  return {
    det,
    skew,
    stretch: lu > 0 && lv > 0 ? Math.max(lu, lv) / Math.min(lu, lv) : Infinity,
    scale: Math.sqrt(Math.abs(det)),
    aligned: Math.abs(b) < eps && Math.abs(c) < eps,
  };
}

type Chain = { m: Linear; culprit: Element | null; backface: boolean } | null;
/** Per pass (a Reader lives for one): each element's transform chain and line boxes, read once. */
const chains = new WeakMap<Reader, Map<Element, Chain>>();
const boxesOf = new WeakMap<Reader, Map<Text, Rect[]>>();

/** The transform product from the element up to the root, and the element in it that does the most (cached per pass). */
export function transformChain(r: Reader, el: Element): Chain {
  let c = chains.get(r);
  if (!c) chains.set(r, (c = new Map()));
  if (c.has(el)) return c.get(el) ?? null;
  const v = readChain(r, el);
  c.set(el, v);
  return v;
}

function readChain(r: Reader, el: Element): Chain {
  let m: Linear = IDENTITY;
  let culprit: Element | null = null;
  let worst = 0;
  let backface = false;
  let n = 0;
  for (let x: Element | null = el; x && n < CHAIN; x = parentOf(x), n++) {
    const s = r.cs(x);
    const own = parseLinear(s.transform, (s as CSSStyleDeclaration & { rotate?: string }).rotate, (s as CSSStyleDeclaration & { scale?: string }).scale);
    if (!own) return null;
    if ((s as CSSStyleDeclaration & { backfaceVisibility?: string }).backfaceVisibility === "hidden") backface = true;
    const v = chainVerdict(own);
    const how = (v.det < 0 ? 100 : 0) + v.skew + Math.abs(Math.log(v.stretch || 1)) * 10;
    if (how > worst) {
      worst = how;
      culprit = x;
    }
    m = mul(own, m);
  }
  return { m, culprit, backface };
}

// ------------------------------------------------------------------------------------------------ line boxes

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Vertical overlap over the smaller height, when the boxes also overlap by OVERLAP_X_PX horizontally (else 0). */
export function lineOverlap(a: Rect, b: Rect): number {
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  if (x < OVERLAP_X_PX) return 0;
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const h = Math.min(a.bottom - a.top, b.bottom - b.top);
  return h > 0 && y > 0 ? y / h : 0;
}

/** The largest overlap between two lines of one text node (pairs of its line boxes). */
export function selfOverlap(lines: Rect[]): { f: number; i: number; j: number } {
  let best = { f: 0, i: -1, j: -1 };
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const f = lineOverlap(lines[i], lines[j]);
      if (f > best.f) best = { f, i, j };
    }
  return best;
}

/**
 * How a clipping box cuts a line: "x" when the line runs CLIP_PX past a side edge with CLIP_PX of it inside, "y"
 * when only CLIP_VISIBLE_MIN..CLIP_VISIBLE_MAX of its height is inside, with the px cut off.
 */
export function clipCut(line: Rect, clip: Rect, axes: { x: boolean; y: boolean }): { axis: "x" | "y"; px: number; visible?: number } | null {
  if (axes.x) {
    if (line.right > clip.right + CLIP_PX && line.left < clip.right - CLIP_PX) return { axis: "x", px: line.right - clip.right };
    if (line.left < clip.left - CLIP_PX && line.right > clip.left + CLIP_PX) return { axis: "x", px: clip.left - line.left };
  }
  if (axes.y) {
    const h = line.bottom - line.top;
    if (h <= 0) return null;
    const vis = Math.max(0, Math.min(line.bottom, clip.bottom) - Math.max(line.top, clip.top)) / h;
    if (vis >= CLIP_VISIBLE_MIN && vis <= CLIP_VISIBLE_MAX) return { axis: "y", px: h * (1 - vis), visible: vis };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ code points

const NO_GLYPH = /[\uD800-\uDFFF]|\p{Cn}/gu;

/** Lone surrogates and unassigned code points (noncharacters included): no font draws them. At most 5, as U+XXXX. */
export function tofuChars(text: string): string[] {
  const out: string[] = [];
  for (const m of text.slice(0, 2000).matchAll(NO_GLYPH)) {
    const cp = m[0].codePointAt(0) ?? 0;
    const u = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    if (!out.includes(u)) out.push(u);
    if (out.length >= 5) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ spacing

/** VISUAL.md 3.26 spacing: em values of computed letter-spacing and word-spacing, and the words of the text. */
export function spacingVerdict(o: { letterEm: number; wordEm: number; words: number; letters: number }): "wide" | "tight" | "words" | null {
  if (o.letterEm >= WIDE_EM && o.words >= 2) return "wide";
  if (o.letterEm <= TIGHT_EM && o.letters >= 3) return "tight";
  if (o.wordEm <= TIGHT_EM && o.words >= 2) return "words";
  return null;
}

const em = (v: string, fs: number): number => {
  const n = parseFloat(v);
  return Number.isFinite(n) && fs > 0 ? n / fs : 0;
};

// ------------------------------------------------------------------------------------------------ measuring

function firstText(el: Element): Text | null {
  for (const n of el.childNodes) if (n.nodeType === 3 && (n as Text).data.trim()) return n as Text;
  return null;
}

function lineBoxes(r: Reader, t: Text): Rect[] {
  let c = boxesOf.get(r);
  if (!c) boxesOf.set(r, (c = new Map()));
  let v = c.get(t);
  if (!v) c.set(t, (v = readBoxes(r, t)));
  return v;
}

function readBoxes(r: Reader, t: Text): Rect[] {
  try {
    const range = r.doc.createRange();
    range.selectNodeContents(t);
    r.reads++;
    return [...range.getClientRects()]
      .filter((x) => x.width > 0 && x.height > 0)
      .slice(0, LINES)
      .map((x) => ({ left: x.left, top: x.top, right: x.right, bottom: x.bottom }));
  } catch {
    return [];
  }
}

const lettersOf = (s: string): number => (s.match(/\p{L}/gu) ?? []).length;
const wordsOf = (s: string): number => (s.match(/\p{L}{2,}/gu) ?? []).length;

/** text-overflow: ellipsis on the element or one of its 3 nearest ancestors (the block container that truncates). */
function ellipsis(r: Reader, el: Element): boolean {
  let n = 0;
  for (let x: Element | null = el; x && n <= 3; x = parentOf(x), n++) if (r.cs(x).textOverflow === "ellipsis") return true;
  return false;
}

/** Opaque text colour, no partial opacity: text a reader is meant to see in full. */
function solid(r: Reader, el: Element): boolean {
  const s = r.cs(el);
  const c = parseColor((s as CSSStyleDeclaration & { webkitTextFillColor?: string }).webkitTextFillColor || s.color);
  return !!c && c[3] >= 0.9 && !r.translucent(el);
}

/** The element or a near ancestor scrolls on its own (its overflow is reachable, not cut). */
function scroller(r: Reader, el: Element): boolean {
  let n = 0;
  for (let x: Element | null = el; x && n < 8 && x !== r.doc.body; x = parentOf(x), n++) {
    const s = r.cs(x);
    if (/auto|scroll/.test(s.overflowX + s.overflowY) && (x.scrollWidth > x.clientWidth + 1 || x.scrollHeight > x.clientHeight + 1)) return true;
  }
  return false;
}

/** The nearest ancestor-or-self (CLIP_UP levels) whose overflow hides on some axis: its padding box and axes. */
function clipBox(r: Reader, el: Element): { el: Element; box: Rect; x: boolean; y: boolean } | null {
  let n = 0;
  for (let x: Element | null = el; x && n <= CLIP_UP; x = parentOf(x), n++) {
    if (x === r.doc.body || x === r.doc.documentElement) return null;
    const s = r.cs(x);
    const hx = s.overflowX === "hidden" || s.overflowX === "clip";
    const hy = s.overflowY === "hidden" || s.overflowY === "clip";
    if (!hx && !hy) continue;
    const rc = r.rect(x);
    const bl = parseFloat(s.borderLeftWidth) || 0;
    const br = parseFloat(s.borderRightWidth) || 0;
    const bt = parseFloat(s.borderTopWidth) || 0;
    const bb = parseFloat(s.borderBottomWidth) || 0;
    return { el: x, box: { left: rc.left + bl, top: rc.top + bt, right: rc.right - br, bottom: rc.bottom - bb }, x: hx, y: hy };
  }
  return null;
}

/**
 * The cut is intended: from the element up to its clipping box, an ellipsis, a line clamp or a moving layer (a
 * transform: carousel tracks, marquees); from the element up to 3 levels above the box, a mask (a "read more" fade).
 */
function intendedCut(r: Reader, el: Element, clip: Element): boolean {
  let below = true;
  let above = 0;
  for (let x: Element | null = el; x && above <= 3; x = parentOf(x)) {
    const s = r.cs(x) as CSSStyleDeclaration & { webkitLineClamp?: string; webkitMaskImage?: string; maskImage?: string };
    if ((s.maskImage && s.maskImage !== "none") || (s.webkitMaskImage && s.webkitMaskImage !== "none")) return true;
    if (below) {
      if (s.textOverflow === "ellipsis") return true;
      if (s.webkitLineClamp && s.webkitLineClamp !== "none") return true;
      if (s.transform && s.transform !== "none") return true;
    } else above++;
    if (x === clip) below = false;
  }
  return false;
}

/** What one element measures (null: nothing to report, or skipped). */
export interface WarpRead {
  reason: WarpReason;
  measured: Record<string, number | string | boolean>;
  /** The element the fix is on (the transform's owner, the clipping box), when it is not the text's own. */
  on?: Element;
  text: string;
  css?: string;
  fixText?: string;
}

const two = (x: number): number => Math.round(x * 100) / 100;

/** Text this check never judges: text-invisible's skips (skipText), ruby annotations (they sit over their base). */
function skipWarp(r: Reader, el: Element): boolean {
  return !el.isConnected || skipText(el) || safeMatches(el, "rt, rp, rt *, rp *") || !r.visible(el);
}

/** VISUAL.md 3.26 for one element, the reasons in order: tofu, mirrored, skewed, spacing, tiny, overlap, clipped. */
export function readWarped(ctx: Ctx, r: Reader, el: Element): WarpRead | null {
  if (skipWarp(r, el) || r.animating(el)) return null;
  const t = firstText(el);
  if (!t) return null;
  const data = t.data;
  const s = r.cs(el);
  const fs = parseFloat(s.fontSize) || 0;
  // the description is built only for a finding (it reads the element's text and name)
  const who = () => named(ctx, el);

  const tofu = tofuChars(data);
  if (tofu.length) {
    const lines = lineBoxes(r, t);
    if (lines.length)
      return {
        reason: "tofu",
        measured: { reason: "tofu", codePoints: tofu.join(" "), count: tofu.length },
        text: `${who()} shows ${tofu.length === 1 ? "a character" : `${tofu.length} characters`} no font can draw (${tofu.join(", ")}: ${tofu.some((u) => /^U\+D[89A-F]/.test(u)) ? "half of a surrogate pair, a string cut through an emoji or another character outside the BMP" : "unassigned in Unicode"}); browsers draw them as boxes.`,
        fixText: "cut strings by code point, never by UTF-16 index (Array.from(s).slice(0, n), or Intl.Segmenter for user-perceived characters), and never store or send half a surrogate pair",
      };
  }

  const chain = transformChain(r, el);
  if (!chain) return null;
  const v = chainVerdict(chain.m);
  const by = chain.culprit && chain.culprit !== el ? chain.culprit : null;
  const bySel = () => (chain.culprit ? ctx.sel(chain.culprit) : ctx.sel(el));
  if (v.det < 0 && !chain.backface && lettersOf(data) >= 3)
    return {
      reason: "mirrored",
      on: by ?? undefined,
      measured: { reason: "mirrored", determinant: two(v.det), transformOn: bySel() },
      text: `${who()} is mirrored by a transform${by ? ` on ${bySel()}` : ""} (determinant ${two(v.det)}): the text reads backwards.`,
      css: "transform: none;",
    };
  if ((v.skew > SKEW_DEG || v.stretch >= STRETCH) && lettersOf(data) >= 3)
    return {
      reason: "skewed",
      on: by ?? undefined,
      measured: { reason: "skewed", skewDeg: Math.round(v.skew), stretch: two(v.stretch), transformOn: bySel() },
      text:
        v.skew > SKEW_DEG
          ? `${who()} is skewed ${Math.round(v.skew)}° by a transform${by ? ` on ${bySel()}` : ""} (above ${SKEW_DEG}°).`
          : `${who()} is stretched ${two(v.stretch)}x on one axis by a transform${by ? ` on ${bySel()}` : ""} (${STRETCH}x or more).`,
      css: "transform: none;",
    };

  const sp = spacingVerdict({ letterEm: em(s.letterSpacing, fs), wordEm: em(s.wordSpacing, fs), words: wordsOf(data), letters: lettersOf(data) });
  if (sp)
    return {
      reason: "spacing",
      measured: { reason: "spacing", letterSpacingEm: two(em(s.letterSpacing, fs)), wordSpacingEm: two(em(s.wordSpacing, fs)), fontPx: two(fs) },
      text:
        sp === "wide"
          ? `letter-spacing ${two(em(s.letterSpacing, fs))} em on ${who()} spaces letters wider than a space (${WIDE_EM} em or more), so its words fall apart.`
          : sp === "tight"
            ? `letter-spacing ${two(em(s.letterSpacing, fs))} em on ${who()} runs its letters into each other (${TIGHT_EM} em or less).`
            : `word-spacing ${two(em(s.wordSpacing, fs))} em on ${who()} removes the space between words (${TIGHT_EM} em or less).`,
      css: sp === "words" ? "word-spacing: normal;" : "letter-spacing: 0.1em;",
    };

  const lines = v.aligned ? lineBoxes(r, t) : [];
  const rendered = fs * v.scale;
  if (rendered > 0 && rendered < TINY_PX && lettersOf(data) >= 3 && solid(r, el) && s.pointerEvents !== "none") {
    const h = lines.length ? Math.max(...lines.map((l) => l.bottom - l.top)) : 0;
    if (h > 0 && h < TINY_BOX_PX)
      return {
        reason: "tiny",
        on: v.scale < 0.999 && by ? by : undefined,
        measured: { reason: "tiny", renderedPx: two(rendered), fontPx: two(fs), scale: two(v.scale), lineBoxPx: two(h) },
        text: `${who()} is drawn at ${two(rendered)} px${v.scale < 0.999 ? ` (${two(fs)} px text scaled by ${two(v.scale)}${by ? ` on ${bySel()}` : ""})` : ""}, below ${TINY_PX} px, with a line box ${px(h)} tall.`,
        css: v.scale < 0.999 ? "transform: none;" : "font-size: 12px;",
      };
  }
  if (!lines.length) return null;

  // an ellipsis gives a truncated line two boxes (the whole run and the part shown), one inside the other
  const o = ellipsis(r, el) ? { f: 0, i: -1, j: -1 } : selfOverlap(lines);
  if (o.f >= LINE_OVERLAP) {
    const a = lines[o.i];
    const b = lines[o.j];
    return {
      reason: "overlap",
      measured: { reason: "overlap", overlap: two(o.f), lineBoxPx: two(Math.min(a.bottom - a.top, b.bottom - b.top)), lineHeight: s.lineHeight, fontPx: two(fs) },
      text: `lines of text overlap on ${who()}: one line covers ${Math.round(o.f * 100)}% of the next one's height (line-height ${s.lineHeight} for ${px(fs)} text; threshold ${LINE_OVERLAP * 100}%).`,
      css: "line-height: 1.4;",
    };
  }

  const clip = clipBox(r, el);
  if (clip && clip.box.right - clip.box.left >= 20 && !intendedCut(r, el, clip.el) && !scroller(r, el) && !r.animating(clip.el)) {
    const cut = clipCut(lines[0], clip.box, { x: clip.x, y: clip.y });
    if (cut) {
      const cs = ctx.sel(clip.el);
      return {
        reason: "clipped",
        on: clip.el !== el ? clip.el : undefined,
        measured: { reason: "clipped", axis: cut.axis, cutPx: Math.round(cut.px), ...(cut.visible !== undefined ? { visible: two(cut.visible) } : {}), clipOn: cs },
        text:
          cut.axis === "x"
            ? `${who()} is cut mid-line: ${px(cut.px)} of its first line are hidden past the edge of ${cs} (overflow hidden, no ellipsis).`
            : `${who()} is cut through its first line: ${Math.round((cut.visible ?? 0) * 100)}% of the line's height shows inside ${cs} (overflow hidden).`,
        css: cut.axis === "x" ? "text-overflow: ellipsis;" : "height: auto;",
      };
    }
  }
  return null;
}

function warpDraft(ctx: Ctx, el: Element, w: WarpRead): Draft {
  const target = w.on ?? el;
  const sel = ctx.sel(target);
  return {
    kind: "text-warped",
    el,
    key: `text-warped|${ctx.sel(el)}|${w.reason}`,
    severity: "medium",
    measured: w.measured,
    threshold: thresholdOf(w.reason),
    text: w.text,
    ...(w.css ? { suggestion: { selector: sel, css: w.css, ...(w.reason === "clipped" ? { note: "Or give the box room for its text (remove the fixed width or height)." } : {}) } } : {}),
    ...(w.fixText ? { fixText: w.fixText } : {}),
  };
}

function thresholdOf(reason: WarpReason): Draft["threshold"] {
  const src = "measured line boxes, transforms and spacing; VISUAL.md 3.26";
  switch (reason) {
    case "overlap":
      return { value: LINE_OVERLAP, unit: "of the smaller line box's height", source: src };
    case "clipped":
      return { value: CLIP_PX, unit: "px of a line past its overflow box, or 20 to 80% of its height shown", source: src };
    case "tofu":
      return { value: "lone surrogate or unassigned code point", unit: "code point", source: "Unicode General_Category Cn and Cs: no font has a glyph" };
    case "mirrored":
      return { value: 0, unit: "transform determinant (below: mirrored)", source: src };
    case "skewed":
      return { value: SKEW_DEG, unit: `degrees of skew, or ${STRETCH}x stretch`, source: src };
    case "spacing":
      return { value: WIDE_EM, unit: `em letter-spacing (or ${TIGHT_EM} em and below)`, source: "wider than a space (0.25 to 0.33 em); VISUAL.md 3.26" };
    case "tiny":
      return { value: TINY_PX, unit: "px rendered", source: src };
  }
}

/** Two candidates' first lines overlap and neither hides the other (VISUAL.md 3.26 overlap between elements). */
export function crossOverlap(r: Reader, a: Element, b: Element): { f: number; ra: Rect; rb: Rect } | null {
  if (containsDeep(a, b) || containsDeep(b, a)) return null;
  const ta = firstText(a);
  const tb = firstText(b);
  if (!ta || !tb || lettersOf(ta.data) < 3 || lettersOf(tb.data) < 3) return null;
  const la = lineBoxes(r, ta)[0];
  const lb = lineBoxes(r, tb)[0];
  if (!la || !lb) return null;
  const f = lineOverlap(la, lb);
  if (f < LINE_OVERLAP) return null;
  const fa = parseFloat(r.cs(a).fontSize) || 0;
  const fb = parseFloat(r.cs(b).fontSize) || 0;
  if (!(fa > 0 && fb > 0) || Math.max(fa, fb) > 2 * Math.min(fa, fb)) return null;
  if (r.pinned(a) || r.pinned(b) || !solid(r, a) || !solid(r, b)) return null;
  const x = Math.floor((Math.max(la.left, lb.left) + Math.min(la.right, lb.right)) / 2);
  const y = Math.floor((Math.max(la.top, lb.top) + Math.min(la.bottom, lb.bottom)) / 2);
  const st = r.stack(x, y);
  const ia = st.findIndex((e) => containsDeep(a, e));
  const ib = st.findIndex((e) => containsDeep(b, e));
  if (ia < 0 || ib < 0) return null;
  const [top, low] = ia < ib ? [a, b] : [b, a];
  for (let i = Math.min(ia, ib); i < Math.max(ia, ib); i++) {
    const e = st[i];
    if (containsDeep(low, e) || containsDeep(e, low)) continue;
    if (containsDeep(top, e) && e !== top && !REPLACED.has(e.tagName.toUpperCase())) continue;
    const s = r.cs(e);
    const bg = parseColor(s.backgroundColor);
    if ((bg && bg[3] > 0.5) || (s.backgroundImage && s.backgroundImage !== "none") || REPLACED.has(e.tagName.toUpperCase())) return null;
  }
  return { f, ra: la, rb: lb };
}

function crossDraft(ctx: Ctx, a: Element, b: Element, f: number): Draft {
  return {
    kind: "text-warped",
    el: a,
    key: `text-warped|${ctx.sel(a)}|overlap|${ctx.sel(b)}`,
    severity: "medium",
    measured: { reason: "overlap", overlap: two(f), with: ctx.sel(b) },
    threshold: thresholdOf("overlap"),
    text: `the text of ${named(ctx, a)} overlaps the text of ${named(ctx, b)} by ${Math.round(f * 100)}% of the smaller line's height, with nothing between them (threshold ${LINE_OVERLAP * 100}%).`,
    fixText: "give the positioned element its own space (remove the absolute position or negative margin that moves it over the other text), or put a background behind it",
  };
}

/**
 * VISUAL.md 3.26 over the text candidates (at most 200), one element per step; then the pairwise first-line test,
 * hit-testing only the pairs whose boxes overlap. Drafts are confirmed 1 s later by the same measurement.
 */
export function* measureWarped(ctx: Ctx, cands: Element[], out: Draft[]): Generator<void> {
  if (!ctx.on("text-warped")) return;
  const r = ctx.r;
  const els = cands.slice(0, 200);
  const flagged = new Set<Element>();
  for (const el of els) {
    yield;
    const w = readWarped(ctx, r, el);
    if (!w) continue;
    flagged.add(el);
    const d = warpDraft(ctx, el, w);
    d.persistMs = 1000;
    d.recheck = (r2) => {
      const again = readWarped(ctx, r2, el);
      return again && again.reason === w.reason ? warpDraft(ctx, el, again) : null;
    };
    out.push(d);
  }
  yield;
  // first lines of the elements whose boxes are their own (no rotation or skew), for the pairwise test
  const boxes: { el: Element; box: Rect }[] = [];
  for (const el of els) {
    if (flagged.has(el) || skipWarp(r, el)) continue;
    const t = firstText(el);
    if (!t || lettersOf(t.data) < 3) continue;
    const chain = transformChain(r, el);
    if (!chain || !chainVerdict(chain.m).aligned) continue;
    const l = lineBoxes(r, t)[0];
    if (l) boxes.push({ el, box: l });
  }
  yield;
  let tests = 0;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      if (lineOverlap(boxes[i].box, boxes[j].box) < LINE_OVERLAP) continue;
      if (++tests > 50) return;
      yield;
      const a = boxes[i].el;
      const b = boxes[j].el;
      if (r.animating(a) || r.animating(b)) continue;
      const c = crossOverlap(r, a, b);
      if (!c) continue;
      const d = crossDraft(ctx, a, b, c.f);
      d.persistMs = 1000;
      d.recheck = (r2) => {
        if (r2.animating(a) || r2.animating(b)) return null;
        const again = crossOverlap(r2, a, b);
        return again ? crossDraft(ctx, a, b, again.f) : null;
      };
      out.push(d);
    }
}

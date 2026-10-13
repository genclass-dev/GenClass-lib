// Pure maths for the measured visual checks (docs/runtime/VISUAL.md sections 2.4, 2.5, 3.8, 3.13, 3.14). No DOM,
// no clock, no state: unit-tested on its own (test/visual-math.test.ts).
//
// Thresholds, each a named constant with its source:
// - INVISIBLE_RATIO 1.5: below it text is reported as unreadable (VISUAL.md 3.8; far below WCAG 2.2 AA, which is a
//   design judgement, not breakage).
// - AA_RATIO 4.5 and AA_LARGE_RATIO 3: the targets a suggested colour must reach (WCAG 2.2 SC 1.4.3).
// - LARGE_PX 24 and LARGE_BOLD_PX 18.66 with weight 700: WCAG large text (18 pt, or 14 pt bold, at 96 dpi).
// - DISTORT_RATIO 0.05 and DISTORT_PX 2: image aspect mismatch (Lighthouse image-aspect-ratio uses THRESHOLD_PX 2).
// - OVERFLOW_PX 1: scroll width beyond client width that counts as sideways scrolling (scrollbar rounding).
//
// Colour handling follows CSS Color 4: computed colours come back as rgb(), hsl(), hwb(), lab(), lch(), oklab(),
// oklch() or color(<space> ...) depending on the browser and the authored form. Everything converts to sRGB in 0..255
// (gamut-clipped). A string that does not parse returns null and the check abstains.

/** sRGB channels 0..255 (floats) and alpha 0..1. */
export type RGBA = [number, number, number, number];

export const INVISIBLE_RATIO = 1.5;
export const AA_RATIO = 4.5;
export const AA_LARGE_RATIO = 3;
export const LARGE_PX = 24;
export const LARGE_BOLD_PX = 18.66;
export const DISTORT_RATIO = 0.05;
export const DISTORT_PX = 2;
export const OVERFLOW_PX = 1;
/** UA canvases in dark mode (Chrome, Safari, Firefox): a dark-canvas verdict must hold for all three. */
export const DARK_CANVASES: RGBA[] = [
  [18, 18, 18, 1],
  [30, 30, 30, 1],
  [28, 27, 34, 1],
];
export const WHITE: RGBA = [255, 255, 255, 1];

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** sRGB transfer function, encode (linear 0..1 -> gamma 0..1). */
function encode(c: number): number {
  const a = Math.abs(c);
  return a <= 0.0031308 ? 12.92 * c : Math.sign(c) * (1.055 * a ** (1 / 2.4) - 0.055);
}
/** sRGB transfer function, decode (gamma 0..1 -> linear 0..1); CSS Color 4 uses 0.04045. */
function decode(c: number): number {
  const a = Math.abs(c);
  return a <= 0.04045 ? c / 12.92 : Math.sign(c) * ((a + 0.055) / 1.055) ** 2.4;
}

type M3 = [number, number, number, number, number, number, number, number, number];
function mul(m: M3, v: [number, number, number]): [number, number, number] {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
const XYZ65_TO_LSRGB: M3 = [3.2409699419045226, -1.537383177570094, -0.4986107602930034, -0.9692436362808796, 1.8759675015077202, 0.04155505740717559, 0.05563007969699366, -0.20397695888897652, 1.0569715142428786];
const D50_TO_D65: M3 = [0.955473421488075, -0.02309845494876471, 0.06325924320057072, -0.0283697093338637, 1.0099953980813041, 0.021041441191917323, 0.012314014864481998, -0.020507649298898964, 1.330365926242124];
const LP3_TO_XYZ65: M3 = [0.4865709486482162, 0.26566769316909306, 0.1982172852343625, 0.2289745640697488, 0.6917385218365064, 0.079286914093745, 0, 0.04511338185890264, 1.043944368900976];
const D50_WHITE: [number, number, number] = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

/** Linear sRGB (0..1) -> RGBA 0..255, gamut-clipped. */
function fromLinear(l: [number, number, number], alpha: number): RGBA {
  return [clamp01(encode(l[0])) * 255, clamp01(encode(l[1])) * 255, clamp01(encode(l[2])) * 255, clamp01(alpha)];
}

/** OKLab -> linear sRGB. */
export function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** sRGB 0..255 -> OKLab. */
export function toOklab(c: RGBA): [number, number, number] {
  const r = decode(c[0] / 255);
  const g = decode(c[1] / 255);
  const b = decode(c[2] / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** CIE Lab (D50) -> linear sRGB. */
function labToLinear(L: number, a: number, b: number): [number, number, number] {
  const k = 24389 / 27;
  const e = 216 / 24389;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const xyz50: [number, number, number] = [
    (fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k) * D50_WHITE[0],
    (L > k * e ? fy ** 3 : L / k) * D50_WHITE[1],
    (fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k) * D50_WHITE[2],
  ];
  return mul(XYZ65_TO_LSRGB, mul(D50_TO_D65, xyz50));
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** A hue in degrees from "120", "120deg", "2rad", "0.5turn", "100grad" (NaN when malformed). */
function hue(t: string): number {
  const m = /^(-?[\d.]+(?:e-?\d+)?)(deg|rad|grad|turn)?$/i.exec(t);
  if (!m) return t === "none" ? 0 : NaN;
  const v = Number(m[1]);
  const u = (m[2] ?? "deg").toLowerCase();
  const d = u === "rad" ? (v * 180) / Math.PI : u === "grad" ? v * 0.9 : u === "turn" ? v * 360 : v;
  return ((d % 360) + 360) % 360;
}

/** A number, or a percentage scaled so that 100% = `pct` ("none" = 0; NaN when malformed). */
function num(t: string, pct: number): number {
  if (t === "none") return 0;
  const m = /^(-?[\d.]+(?:e-?\d+)?)(%)?$/i.exec(t);
  if (!m) return NaN;
  const v = Number(m[1]);
  return m[2] ? (v / 100) * pct : v;
}

function hex(s: string): RGBA | null {
  const h = s.slice(1);
  if (!/^[\da-f]+$/i.test(h) || ![3, 4, 6, 8].includes(h.length)) return null;
  const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
}

/**
 * Parse a computed colour string into sRGB 0..255 and alpha. Returns null for anything it does not understand
 * (`currentcolor`, system colours other than the few below, unresolved `color-mix()`, unknown `color()` spaces).
 */
export function parseColor(input: string | null | undefined): RGBA | null {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "transparent") return [0, 0, 0, 0];
  if (s === "white") return [255, 255, 255, 1];
  if (s === "black") return [0, 0, 0, 1];
  if (s[0] === "#") return hex(s);
  const m = /^([a-z-]+)\((.*)\)$/.exec(s);
  if (!m) return null;
  const fn = m[1];
  let body = m[2].trim();
  let space = "";
  if (fn === "color") {
    const sp = /^([a-z0-9-]+)\s+(.*)$/.exec(body);
    if (!sp) return null;
    space = sp[1];
    body = sp[2];
  }
  // channels and alpha: "a, b, c[, d]" (legacy) or "a b c[ / d]" (modern)
  let parts: string[];
  let alphaT: string | undefined;
  if (body.includes(",")) {
    parts = body.split(",").map((x) => x.trim());
    if (parts.length === 4) alphaT = parts.pop();
  } else {
    const [ch, al] = body.split("/").map((x) => x.trim());
    parts = ch.split(/\s+/).filter(Boolean);
    alphaT = al;
  }
  if (parts.length !== 3) return null;
  const alpha = alphaT === undefined ? 1 : num(alphaT, 1);
  if (!Number.isFinite(alpha)) return null;
  let out: RGBA | null = null;
  switch (fn) {
    case "rgb":
    case "rgba": {
      const v = parts.map((p) => num(p, 255));
      out = [v[0], v[1], v[2], clamp01(alpha)];
      out = [Math.min(255, Math.max(0, out[0])), Math.min(255, Math.max(0, out[1])), Math.min(255, Math.max(0, out[2])), out[3]];
      break;
    }
    case "hsl":
    case "hsla": {
      const h = hue(parts[0]);
      const sat = clamp01(num(parts[1], 100) / 100);
      const l = clamp01(num(parts[2], 100) / 100);
      const rgb = hslToRgb(h, sat, l);
      out = [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, clamp01(alpha)];
      break;
    }
    case "hwb": {
      const h = hue(parts[0]);
      const w = clamp01(num(parts[1], 100) / 100);
      const bl = clamp01(num(parts[2], 100) / 100);
      if (w + bl >= 1) {
        const g = w / (w + bl);
        out = [g * 255, g * 255, g * 255, clamp01(alpha)];
        break;
      }
      const rgb = hslToRgb(h, 1, 0.5).map((c) => c * (1 - w - bl) + w);
      out = [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, clamp01(alpha)];
      break;
    }
    case "lab":
      out = fromLinear(labToLinear(num(parts[0], 100), num(parts[1], 125), num(parts[2], 125)), alpha);
      break;
    case "lch": {
      const L = num(parts[0], 100);
      const C = num(parts[1], 150);
      const H = (hue(parts[2]) * Math.PI) / 180;
      out = fromLinear(labToLinear(L, C * Math.cos(H), C * Math.sin(H)), alpha);
      break;
    }
    case "oklab":
      out = fromLinear(oklabToLinear(num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4)), alpha);
      break;
    case "oklch": {
      const L = num(parts[0], 1);
      const C = num(parts[1], 0.4);
      const H = (hue(parts[2]) * Math.PI) / 180;
      out = fromLinear(oklabToLinear(L, C * Math.cos(H), C * Math.sin(H)), alpha);
      break;
    }
    case "color": {
      const v = parts.map((p) => num(p, 1)) as [number, number, number];
      if (space === "srgb") out = [clamp01(v[0]) * 255, clamp01(v[1]) * 255, clamp01(v[2]) * 255, clamp01(alpha)];
      else if (space === "srgb-linear") out = fromLinear(v, alpha);
      else if (space === "display-p3") out = fromLinear(mul(XYZ65_TO_LSRGB, mul(LP3_TO_XYZ65, [decode(v[0]), decode(v[1]), decode(v[2])])), alpha);
      else if (space === "xyz" || space === "xyz-d65") out = fromLinear(mul(XYZ65_TO_LSRGB, v), alpha);
      else if (space === "xyz-d50") out = fromLinear(mul(XYZ65_TO_LSRGB, mul(D50_TO_D65, v)), alpha);
      else return null;
      break;
    }
    default:
      return null;
  }
  return out && out.every((x) => Number.isFinite(x)) ? out : null;
}

/** `top` painted over `bottom` (source-over in sRGB, as browsers blend). */
export function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top[3] + bottom[3] * (1 - top[3]);
  if (a <= 0) return [0, 0, 0, 0];
  const c = (i: number) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
  return [c(0), c(1), c(2), a];
}

/**
 * Composite a stack of layers (topmost first) down to an opaque colour: the layers above the first opaque one are
 * painted over it. Returns null when no layer is opaque (the caller then uses the root or the canvas).
 */
export function composite(layers: RGBA[], base?: RGBA): RGBA | null {
  let i = layers.findIndex((l) => l[3] >= 1);
  let acc: RGBA | null;
  if (i < 0) {
    if (!base) return null;
    acc = base;
    i = layers.length;
  } else acc = layers[i];
  for (let j = i - 1; j >= 0; j--) acc = over(layers[j], acc);
  return acc;
}

/** WCAG 2.2 relative luminance of an sRGB colour (alpha ignored). */
export function luminance(c: RGBA): number {
  const [r, g, b] = [c[0], c[1], c[2]].map((v) => decode(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.2 contrast ratio, truncated to two decimals (as axe-core reports it). */
export function contrast(a: RGBA, b: RGBA): number {
  const la = luminance(a);
  const lb = luminance(b);
  const r = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  return Math.floor(r * 100 + 1e-9) / 100;
}

/** WCAG large text: at least 24 px, or at least 18.66 px at weight 700 or more. */
export function isLargeText(px: number, weight: number): boolean {
  return px >= LARGE_PX || (px >= LARGE_BOLD_PX && weight >= 700);
}

/** The ratio a suggested colour must reach: 4.5:1, or 3:1 for large text. */
export function targetRatio(px: number, weight: number): number {
  return isLargeText(px, weight) ? AA_LARGE_RATIO : AA_RATIO;
}

/** "#rrggbb" for an sRGB colour (rounded). */
export function toHex(c: RGBA): string {
  return `#${[c[0], c[1], c[2]].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** "rgb(r, g, b)" for an sRGB colour (rounded). */
export function toRgb(c: RGBA): string {
  return `rgb(${[c[0], c[1], c[2]].map((v) => Math.round(Math.min(255, Math.max(0, v)))).join(", ")})`;
}

/** OKLCH -> linear sRGB inside the gamut: the chroma is reduced (keeping hue and lightness) until it fits. */
function inGamut(l: number, C: number, H: number): [number, number, number] {
  const at = (c: number) => oklabToLinear(l, c * Math.cos(H), c * Math.sin(H));
  const fits = (v: [number, number, number]) => v.every((x) => x >= -1e-4 && x <= 1 + 1e-4);
  let v = at(C);
  if (fits(v)) return v;
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (fits(at(mid))) lo = mid;
    else hi = mid;
  }
  v = at(lo);
  return v;
}

/**
 * A readable colour for text over `bg`: the same OKLCH hue as `fg` (chroma reduced only where the sRGB gamut needs
 * it) at the lightness closest to fg's that reaches `target` once rounded to 8 bits; else #000000 or #ffffff (one of
 * them always reaches 4.58:1 or more).
 */
export function suggestColor(fg: RGBA, bg: RGBA, target: number): RGBA {
  const [L, a, b] = toOklab(fg);
  const C = Math.hypot(a, b);
  const H = Math.atan2(b, a);
  let best: RGBA | null = null;
  let bestD = Infinity;
  for (let i = 0; i <= 200; i++) {
    const l = i / 200;
    const d = Math.abs(l - L);
    if (d >= bestD) continue;
    const c = fromLinear(inGamut(l, C, H), 1).map((v, k) => (k < 3 ? Math.round(v) : 1)) as RGBA;
    if (contrast(c, bg) >= target) {
      best = c;
      bestD = d;
    }
  }
  if (best) return best;
  return contrast([0, 0, 0, 1], bg) >= contrast(WHITE, bg) ? [0, 0, 0, 1] : WHITE;
}

/** |(w / h) / (nw / nh) - 1|: how far the rendered aspect ratio is from the image's own. */
export function distortion(w: number, h: number, nw: number, nh: number): number {
  if (!(w > 0 && h > 0 && nw > 0 && nh > 0)) return 0;
  return Math.abs(w / h / (nw / nh) - 1);
}

/** Pixels the smaller rendered side differs from what the image's aspect ratio implies for the other side. */
export function distortionPx(w: number, h: number, nw: number, nh: number): number {
  if (!(w > 0 && h > 0 && nw > 0 && nh > 0)) return 0;
  return w <= h ? Math.abs(w - (h * nw) / nh) : Math.abs(h - (w * nh) / nw);
}

/** An image is reported as stretched or squashed (VISUAL.md 3.13). */
export function isDistorted(w: number, h: number, nw: number, nh: number): boolean {
  return w >= 48 && h >= 48 && nw > 5 && nh > 5 && distortion(w, h, nw, nh) > DISTORT_RATIO && distortionPx(w, h, nw, nh) > DISTORT_PX;
}

/** The page scrolls sideways (VISUAL.md 3.14). */
export function overflowsX(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth > clientWidth + OVERFLOW_PX;
}

/** Share of `outer` (w x h) covered by a rect clipped to it, 0..1. */
export function coverage(r: { left: number; top: number; right: number; bottom: number }, w: number, h: number): number {
  if (!(w > 0 && h > 0)) return 0;
  const x = Math.max(0, Math.min(r.right, w) - Math.max(r.left, 0));
  const y = Math.max(0, Math.min(r.bottom, h) - Math.max(r.top, 0));
  return (x * y) / (w * h);
}

/** Layout-shift session windows (web.dev CLS): gap under 1 s, at most 5 s long. Returns each window's score. */
export function shiftWindows(entries: { t: number; value: number }[]): { start: number; end: number; score: number }[] {
  const out: { start: number; end: number; score: number }[] = [];
  let cur: { start: number; end: number; score: number } | null = null;
  for (const e of [...entries].sort((x, y) => x.t - y.t)) {
    if (cur && e.t - cur.end < 1000 && e.t - cur.start < 5000) {
      cur.end = e.t;
      cur.score += e.value;
    } else {
      cur = { start: e.t, end: e.t, score: e.value };
      out.push(cur);
    }
  }
  return out;
}

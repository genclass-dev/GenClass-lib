// Pure maths of the measured visual checks (docs/runtime/VISUAL.md 2.5, 3.13, 3.14, 3.16; src/visual/math.ts):
// colour parsing for every computed form, compositing, WCAG luminance and contrast, large text, the suggested
// colour, image distortion, overflow and layout-shift windows. Every threshold is tested just above and below.
import { describe, expect, it } from "vitest";
import {
  AA_LARGE_RATIO,
  AA_RATIO,
  composite,
  contrast,
  coverage,
  DARK_CANVASES,
  distortion,
  distortionPx,
  INVISIBLE_RATIO,
  isDistorted,
  isLargeText,
  luminance,
  over,
  overflowsX,
  parseColor,
  shiftWindows,
  suggestColor,
  targetRatio,
  toHex,
  toRgb,
  WHITE,
  type RGBA,
} from "../src/visual/math.js";

const round = (c: RGBA | null) => c && [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), Math.round(c[3] * 1000) / 1000];

describe("visual math: colour parsing (VISUAL.md 2.5)", () => {
  it("rgb() and rgba() in legacy and modern syntax, percentages, none", () => {
    expect(round(parseColor("rgb(255, 255, 255)"))).toEqual([255, 255, 255, 1]);
    expect(round(parseColor("rgba(0, 0, 0, 0.5)"))).toEqual([0, 0, 0, 0.5]);
    expect(round(parseColor("rgba(0, 0, 0, 0)"))).toEqual([0, 0, 0, 0]);
    expect(round(parseColor("rgb(10 20 30 / 50%)"))).toEqual([10, 20, 30, 0.5]);
    expect(round(parseColor("rgb(100% 50% 0%)"))).toEqual([255, 128, 0, 1]);
    expect(round(parseColor("rgb(none 0 0)"))).toEqual([0, 0, 0, 1]);
  });

  it("hsl(), hwb(), hex and keywords", () => {
    expect(round(parseColor("hsl(120, 100%, 50%)"))).toEqual([0, 255, 0, 1]);
    expect(round(parseColor("hsl(0 0% 100%)"))).toEqual([255, 255, 255, 1]);
    expect(round(parseColor("hsl(0.5turn 100% 50%)"))).toEqual([0, 255, 255, 1]);
    expect(round(parseColor("hwb(0 0% 0%)"))).toEqual([255, 0, 0, 1]);
    expect(round(parseColor("hwb(0 60% 60%)"))).toEqual([128, 128, 128, 1]);
    expect(round(parseColor("#fff"))).toEqual([255, 255, 255, 1]);
    expect(round(parseColor("#11182780"))).toEqual([17, 24, 39, 0.502]);
    expect(round(parseColor("transparent"))).toEqual([0, 0, 0, 0]);
  });

  it("lab(), lch(), oklab(), oklch() (Tailwind v4 computes to oklch)", () => {
    expect(round(parseColor("lab(54.29 80.82 69.88)"))).toEqual([255, 0, 0, 1]);
    expect(round(parseColor("lch(54.29 106.84 40.85)"))).toEqual([255, 0, 0, 1]);
    expect(round(parseColor("oklab(0.627955 0.224863 0.125846)"))).toEqual([255, 0, 0, 1]);
    expect(round(parseColor("oklch(1 0 0)"))).toEqual([255, 255, 255, 1]);
    expect(round(parseColor("oklch(0 0 0)"))).toEqual([0, 0, 0, 1]);
    expect(round(parseColor("oklch(0.985 0 0)"))).toEqual([250, 250, 250, 1]);
    expect(round(parseColor("oklch(100% 0 0 / 0.5)"))).toEqual([255, 255, 255, 0.5]);
  });

  it("color() spaces: srgb, srgb-linear, display-p3 (gamut-clipped), xyz", () => {
    expect(round(parseColor("color(srgb 0.5 0.5 0.5)"))).toEqual([128, 128, 128, 1]);
    expect(round(parseColor("color(srgb-linear 0.214 0.214 0.214)"))).toEqual([128, 128, 128, 1]);
    expect(round(parseColor("color(display-p3 1 0 0)"))).toEqual([255, 0, 0, 1]);
    expect(round(parseColor("color(xyz-d65 0.9505 1 1.089)"))).toEqual([255, 255, 255, 1]);
  });

  it("anything it does not understand is null, so the check abstains", () => {
    for (const s of ["", "currentcolor", "color-mix(in srgb, red, blue)", "rgb(1, 2)", "color(rec2020 1 0 0)", "hsl(red 1 1)", "#12", "var(--x)"]) expect(parseColor(s), s).toBeNull();
  });
});

describe("visual math: compositing and WCAG contrast (VISUAL.md 2.4, 2.5)", () => {
  it("source-over in sRGB, and a layer stack down to its first opaque layer", () => {
    expect(round(over([0, 0, 0, 0.5], WHITE))).toEqual([128, 128, 128, 1]);
    expect(round(composite([[255, 0, 0, 0.5], [0, 0, 255, 1], [0, 255, 0, 1]]))).toEqual([128, 0, 128, 1]);
    expect(composite([[0, 0, 0, 0.1]])).toBeNull(); // no opaque layer: the caller uses the root or the canvas
    expect(round(composite([[0, 0, 0, 0.5]], WHITE))).toEqual([128, 128, 128, 1]);
    expect(round(composite([[0, 0, 0, 0]], [18, 18, 18, 1]))).toEqual([18, 18, 18, 1]);
  });

  it("luminance uses the 0.04045 constant; ratios are truncated to two decimals", () => {
    expect(luminance(WHITE)).toBeCloseTo(1, 6);
    expect(luminance([0, 0, 0, 1])).toBe(0);
    expect(luminance([10, 10, 10, 1])).toBeCloseTo(10 / 255 / 12.92, 9); // below 0.04045: linear segment
    expect(contrast([0, 0, 0, 1], WHITE)).toBe(21);
    expect(contrast(WHITE, WHITE)).toBe(1);
    expect(contrast(parseColor("#767676")!, WHITE)).toBe(4.54);
    expect(contrast(parseColor("#777777")!, WHITE)).toBe(4.47);
    expect(contrast(parseColor("#fafafa")!, WHITE)).toBe(1.04);
  });

  it("the unreadable threshold is 1.5:1: just below is reported, just above is not", () => {
    expect(INVISIBLE_RATIO).toBe(1.5);
    // #c8c8c8 on white is 1.67; #d6d6d6 1.45
    expect(contrast(parseColor("#c8c8c8")!, WHITE)).toBeGreaterThan(INVISIBLE_RATIO);
    expect(contrast(parseColor("#d6d6d6")!, WHITE)).toBeLessThan(INVISIBLE_RATIO);
  });

  it("large text: 24 px, or 18.66 px at weight 700 (targets 4.5:1 and 3:1)", () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(23.99, 400)).toBe(false);
    expect(isLargeText(18.66, 700)).toBe(true);
    expect(isLargeText(18.65, 700)).toBe(false);
    expect(isLargeText(18.66, 600)).toBe(false);
    expect(targetRatio(16, 400)).toBe(AA_RATIO);
    expect(targetRatio(30, 400)).toBe(AA_LARGE_RATIO);
  });

  it("the suggested colour keeps the hue, reaches the target once rounded, and falls back to black or white", () => {
    const cases: [RGBA, RGBA, number][] = [
      [WHITE, WHITE, 4.5],
      [WHITE, [250, 250, 250, 1], 4.5],
      [parseColor("#3b82f6")!, [37, 99, 235, 1], 4.5],
      [[20, 20, 20, 1], [18, 18, 18, 1], 3],
      [[255, 0, 0, 1], [255, 0, 0, 1], 4.5],
      [[128, 128, 128, 1], [128, 128, 128, 1], 4.5], // mid grey: only black reaches 4.5 (5.32), white gives 3.95
      ...DARK_CANVASES.map((c): [RGBA, RGBA, number] => [c, c, 4.5]),
    ];
    for (const [fg, bg, t] of cases) {
      const s = suggestColor(fg, bg, t);
      expect(contrast(s, bg), `${toHex(fg)} on ${toHex(bg)}`).toBeGreaterThanOrEqual(t);
      expect(s.slice(0, 3).every((v) => Number.isInteger(v) && v >= 0 && v <= 255)).toBe(true);
    }
    expect(toHex(suggestColor(WHITE, [250, 250, 250, 1], 4.5))).toBe("#737373");
    expect(toRgb([115, 115, 115, 1])).toBe("rgb(115, 115, 115)");
  });
});

describe("visual math: geometry (VISUAL.md 3.13, 3.14, 3.16)", () => {
  it("image distortion: above 5% and above 2 px on the smaller side, at least 48 px, natural size above 5 px", () => {
    expect(distortion(300, 300, 600, 300)).toBeCloseTo(0.5);
    expect(distortionPx(300, 300, 600, 300)).toBe(300);
    expect(isDistorted(300, 300, 600, 300)).toBe(true);
    expect(isDistorted(300, 150, 600, 300)).toBe(false); // the file's own ratio
    expect(isDistorted(100, 100, 104, 100)).toBe(false); // 3.8%: under 5%
    expect(isDistorted(100, 100, 106, 100)).toBe(true); // 5.7% and 5.7 px
    expect(isDistorted(1000, 40, 1000, 41.5)).toBe(false); // 3.6%
    expect(isDistorted(47, 47, 94, 47)).toBe(false); // under 48 px
    expect(isDistorted(300, 300, 5, 3)).toBe(false); // natural size 5 px or less
    expect(isDistorted(400, 200, 418, 200)).toBe(false); // 4.3%: under 5%
    expect(isDistorted(400, 100, 404, 100.5)).toBe(false); // 0.5%: tiny
  });

  it("sideways scrolling needs more than 1 px of scroll width beyond the client width", () => {
    expect(overflowsX(1281, 1280)).toBe(false);
    expect(overflowsX(1282, 1280)).toBe(true);
  });

  it("coverage of the viewport, clipped to it", () => {
    expect(coverage({ left: 0, top: 0, right: 1280, bottom: 800 }, 1280, 800)).toBe(1);
    expect(coverage({ left: -100, top: -100, right: 640, bottom: 400 }, 1280, 800)).toBe(0.25);
    expect(coverage({ left: 2000, top: 0, right: 2100, bottom: 10 }, 1280, 800)).toBe(0);
  });

  it("layout-shift session windows: gap under 1 s, at most 5 s", () => {
    const w = shiftWindows([
      { t: 0, value: 0.1 },
      { t: 500, value: 0.2 },
      { t: 2000, value: 0.05 },
      { t: 2500, value: 0.3 },
    ]);
    expect(w.map((x) => Math.round(x.score * 100) / 100)).toEqual([0.3, 0.35]);
    // a window never spans more than 5 s even with gaps under 1 s
    const long = shiftWindows(Array.from({ length: 12 }, (_, i) => ({ t: i * 900, value: 0.05 })));
    expect(long.length).toBe(2);
    expect(long[0].end - long[0].start).toBeLessThan(5000);
  });
});

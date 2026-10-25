// ad-heavy and text-warped (docs/runtime/VISUAL.md 3.24, 3.25) as pure functions: ad names and sizes, the union of
// boxes, the shares and their verdict; transform parsing and composition, line-box overlap, clipping, code points and
// spacing. Each threshold has a case just above and just below it, and clean controls next to the faults.
import { describe, expect, it } from "vitest";
import { AD_FIRST_SHARE, AD_INTERSTITIAL_SHARE, AD_PAGE_SHARE, AD_STICKY_SHARE, adNamed, adShares, adSize, adVerdict, adWords, unionArea, type Region } from "../src/visual/checks/ads.js";
import {
  chainVerdict,
  clipCut,
  IDENTITY,
  LINE_OVERLAP,
  lineOverlap,
  mul,
  parseLinear,
  selfOverlap,
  SKEW_DEG,
  spacingVerdict,
  tofuChars,
  type Linear,
} from "../src/visual/checks/warped.js";

const box = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h });
const near = (m: Linear | null, want: Linear) => {
  expect(m).not.toBeNull();
  m!.forEach((v, i) => expect(v).toBeCloseTo(want[i], 6));
};

describe("ad-heavy: names, sizes, shares (VISUAL.md 3.24)", () => {
  it("splits names into words and matches ad words only as whole words", () => {
    expect(adWords("div-gpt-ad-1234-0")).toEqual(["div", "gpt", "ad"]);
    expect(adWords("google_ads_iframe_/1/x_0")).toEqual(["google", "ads", "iframe", "x"]);
    expect(adWords("headerAdSlot")).toEqual(["header", "ad", "slot"]);
    for (const n of ["ad-slot", "AdBanner", "sidebarAd", "adsbygoogle", "advertisement", "sponsored-post", "top_ads"]) expect(adNamed(n, []), n).toBe(true);
    for (const n of ["header", "shadow", "badge", "add-to-cart", "adaptive", "loading", "heading", "read-more", "iPad", "sponsors", "address"]) expect(adNamed(n, []), n).toBe(false);
    expect(adNamed("", ["card", "ad"])).toBe(true);
    expect(adNamed("", ["card"], ["data-ad-slot"])).toBe(true);
    expect(adNamed("", ["card"], ["data-testid"])).toBe(false);
  });

  it("cross-site iframe sizes within 2 px of a fixed ad size", () => {
    expect(adSize(300, 250)).toBe(true);
    expect(adSize(302, 248)).toBe(true);
    expect(adSize(303, 250)).toBe(false);
    expect(adSize(728, 90)).toBe(true);
    expect(adSize(560, 315)).toBe(false); // a video embed
    expect(adSize(400, 300)).toBe(false); // a map
  });

  it("the union of boxes counts overlaps once and clips to the screen or page", () => {
    expect(unionArea([box(0, 0, 10, 10)], box(0, 0, 100, 100))).toBe(100);
    expect(unionArea([box(0, 0, 10, 10), box(5, 5, 10, 10)], box(0, 0, 100, 100))).toBe(175);
    expect(unionArea([box(0, 0, 10, 10), box(0, 0, 10, 10)], box(0, 0, 100, 100))).toBe(100);
    expect(unionArea([box(-5, -5, 10, 10)], box(0, 0, 100, 100))).toBe(25);
    expect(unionArea([box(200, 200, 10, 10)], box(0, 0, 100, 100))).toBe(0);
    expect(unionArea([], box(0, 0, 100, 100))).toBe(0);
  });

  it("shares of the first screen, the page and the largest fixed region; verdict in order", () => {
    const vw = 1000;
    const vh = 800;
    const flow = (top: number, h: number): Region => ({ box: box(0, top, vw, h), fixed: false });
    // a page 4,000 px tall with 1,190 px of full-width ads: 29.75% (below) and 1,210 px: 30.25% (above)
    const below = adShares([flow(1000, 595), flow(2000, 595)], vw, vh, 4000);
    expect(below.pageShare).toBeCloseTo(0.2975, 4);
    expect(adVerdict(below)).toBeNull();
    const above = adShares([flow(1000, 605), flow(2000, 605)], vw, vh, 4000);
    expect(above.pageShare).toBeGreaterThanOrEqual(AD_PAGE_SHARE);
    expect(adVerdict(above)).toBe("density");
    // first screen: 49% and 51% of it
    expect(adVerdict(adShares([flow(0, 392)], vw, vh, 10_000))).toBeNull();
    const first = adShares([flow(0, 408)], vw, vh, 10_000);
    expect(first.firstShare).toBeGreaterThanOrEqual(AD_FIRST_SHARE);
    expect(adVerdict(first)).toBe("first-screen");
    // a fixed bottom bar: 29% and 31% of the screen
    expect(adVerdict(adShares([{ box: box(0, 568, vw, 232), fixed: true }], vw, vh, 10_000))).toBeNull();
    const sticky = adShares([{ box: box(0, 552, vw, 248), fixed: true }], vw, vh, 10_000);
    expect(sticky.fixedShare).toBeGreaterThanOrEqual(AD_STICKY_SHARE);
    expect(adVerdict(sticky)).toBe("sticky");
    // a fixed region that covers the screen and is on top: an interstitial; under other content: only sticky
    const full = { box: box(0, 0, vw, vh), fixed: true };
    expect(adShares([{ ...full, onTop: true }], vw, vh, 10_000).topShare).toBeGreaterThanOrEqual(AD_INTERSTITIAL_SHARE);
    expect(adVerdict(adShares([{ ...full, onTop: true }], vw, vh, 10_000))).toBe("interstitial");
    expect(adVerdict(adShares([{ ...full, onTop: false }], vw, vh, 10_000))).toBe("sticky");
    // fixed regions cover their share of every screen: a 20% fixed bar plus 15% in-flow ads is 1 - 0.8 x 0.85 = 32%
    const mixed = adShares([{ box: box(0, 640, vw, 160), fixed: true }, flow(2000, 1500)], vw, vh, 10_000);
    expect(mixed.pageShare).toBeCloseTo(0.32, 4);
    expect(adVerdict(mixed)).toBe("density");
    // nothing measured: no verdict
    expect(adVerdict(adShares([], vw, vh, 1000))).toBeNull();
  });

  it("a page shorter than the screen is measured against the screen", () => {
    const s = adShares([{ box: box(0, 0, 300, 250), fixed: false }], 1000, 800, 400);
    expect(s.pageShare).toBeCloseTo(75_000 / 800_000, 6);
  });
});

describe("text-warped: transforms (VISUAL.md 3.25)", () => {
  it("parses matrix(), matrix3d() and the individual rotate and scale properties", () => {
    near(parseLinear("none"), IDENTITY);
    near(parseLinear("matrix(-1, 0, 0, 1, 0, 0)"), [-1, 0, 0, 1]);
    // rotateY(180deg): matrix3d(-1, 0, -1.2e-16, 0, 0, 1, 0, 0, 1.2e-16, 0, -1, 0, 0, 0, 0, 1)
    near(parseLinear("matrix3d(-1, 0, -1.22465e-16, 0, 0, 1, 0, 0, 1.22465e-16, 0, -1, 0, 0, 0, 0, 1)"), [-1, 0, 0, 1]);
    near(parseLinear("none", "none", "-1 1"), [-1, 0, 0, 1]);
    near(parseLinear("none", "none", "50%"), [0.5, 0, 0, 0.5]);
    near(parseLinear("none", "90deg"), [0, 1, -1, 0]);
    near(parseLinear("none", "y 180deg"), [-1, 0, 0, 1]);
    near(parseLinear("none", "0.25turn"), [0, 1, -1, 0]);
    expect(parseLinear("perspective(10px)")).toBeNull();
    expect(parseLinear("matrix(1, 2)")).toBeNull();
    expect(parseLinear("none", "sideways")).toBeNull();
  });

  it("mirrored, skewed, stretched, scaled; pure rotation is aligned only at 0 and 180 but never warped", () => {
    expect(chainVerdict([-1, 0, 0, 1]).det).toBeLessThan(0);
    expect(chainVerdict(mul([-1, 0, 0, 1], [-1, 0, 0, 1])).det).toBeGreaterThan(0); // mirrored twice reads fine
    const skew = (deg: number): Linear => [1, 0, Math.tan((deg * Math.PI) / 180), 1];
    expect(chainVerdict(skew(SKEW_DEG + 1)).skew).toBeGreaterThan(SKEW_DEG);
    expect(chainVerdict(skew(SKEW_DEG - 1)).skew).toBeLessThan(SKEW_DEG);
    expect(chainVerdict(skew(-10)).skew).toBeCloseTo(10, 6); // a design slant
    const rot = chainVerdict([Math.cos(1), Math.sin(1), -Math.sin(1), Math.cos(1)]);
    expect(rot.skew).toBeCloseTo(0, 6);
    expect(rot.stretch).toBeCloseTo(1, 6);
    expect(rot.det).toBeCloseTo(1, 6);
    expect(rot.aligned).toBe(false);
    expect(chainVerdict([2, 0, 0, 1]).stretch).toBe(2);
    expect(chainVerdict([1.9, 0, 0, 1]).stretch).toBeLessThan(2);
    expect(chainVerdict([0.25, 0, 0, 0.25]).scale).toBeCloseTo(0.25, 6);
    expect(chainVerdict(IDENTITY).aligned).toBe(true);
  });
});

describe("text-warped: line boxes, clipping, code points, spacing (VISUAL.md 3.25)", () => {
  it("two lines overlap by half the smaller one's height, and by 8 px horizontally", () => {
    // 20 px tall line boxes 9 px apart: 55% overlap; 11 px apart: 45%
    expect(lineOverlap(box(0, 0, 200, 20), box(0, 9, 200, 20))).toBeGreaterThanOrEqual(LINE_OVERLAP);
    expect(lineOverlap(box(0, 0, 200, 20), box(0, 11, 200, 20))).toBeLessThan(LINE_OVERLAP);
    // the same row: side by side, never overlapping
    expect(lineOverlap(box(0, 0, 100, 20), box(100, 0, 100, 20))).toBe(0);
    expect(lineOverlap(box(0, 0, 100, 20), box(93, 0, 100, 20))).toBe(0); // 7 px: a kerning or italic overhang
    // normal line-height 1.2 on a font whose content area is 1.15 em: no overlap
    expect(lineOverlap(box(0, 0, 300, 18.4), box(0, 19.2, 300, 18.4))).toBe(0);
    const lines = [box(0, 0, 300, 20), box(0, 8, 300, 20), box(0, 16, 120, 20)];
    expect(selfOverlap(lines)).toMatchObject({ i: 0, j: 1 });
    expect(selfOverlap(lines).f).toBeCloseTo(0.6, 6);
    expect(selfOverlap([box(0, 0, 300, 20)]).f).toBe(0);
  });

  it("a line cut mid-way by its overflow box: 4 px past the edge, or 20 to 80% of its height inside", () => {
    const clip = box(0, 0, 100, 30);
    expect(clipCut(box(0, 5, 150, 20), clip, { x: true, y: false })).toMatchObject({ axis: "x", px: 50 });
    expect(clipCut(box(0, 5, 103, 20), clip, { x: true, y: false })).toBeNull(); // 3 px: rounding and overhang
    expect(clipCut(box(0, 5, 105, 20), clip, { x: true, y: false })).toMatchObject({ axis: "x" });
    expect(clipCut(box(110, 5, 50, 20), clip, { x: true, y: false })).toBeNull(); // wholly outside: a carousel's next slide
    expect(clipCut(box(-40, 5, 100, 20), clip, { x: true, y: false })).toMatchObject({ axis: "x", px: 40 }); // right-to-left
    expect(clipCut(box(0, 5, 150, 20), clip, { x: false, y: true })).toBeNull(); // only the axes that hide count
    // vertical: a 20 px line in a 30 px box starting at 20 px shows half of it; at 25 px a quarter; at 14 px 80%
    expect(clipCut(box(0, 20, 80, 20), clip, { x: false, y: true })).toMatchObject({ axis: "y", visible: 0.5 });
    expect(clipCut(box(0, 25, 80, 20), clip, { x: false, y: true })).toMatchObject({ axis: "y", visible: 0.25 });
    expect(clipCut(box(0, 27, 80, 20), clip, { x: false, y: true })).toBeNull(); // 15%: hidden lines of a collapsed box
    expect(clipCut(box(0, 13, 80, 20), clip, { x: false, y: true })).toBeNull(); // 85%: descenders cut
    expect(clipCut(box(0, 5, 80, 20), clip, { x: true, y: true })).toBeNull(); // fits
  });

  it("lone surrogates and unassigned code points; real text, emoji and private-use icons are not tofu", () => {
    expect(tofuChars("Café — naïve 中文 नमस्ते")).toEqual([]);
    expect(tofuChars("Party \u{1F389}\u{1F44D}\u{1F3FD}")).toEqual([]);
    expect(tofuChars(" icon")).toEqual([]); // private use: icon fonts (icon-font-failed's job)
    expect(tofuChars("�")).toEqual([]); // the replacement character is text-encoding's
    expect(tofuChars("Great \ud83d")).toEqual(["U+D83D"]); // an emoji cut in half
    expect(tofuChars("\ude00 x")).toEqual(["U+DE00"]);
    expect(tofuChars("x ͸ y")).toEqual(["U+0378"]); // unassigned
    expect(tofuChars("﷐￿")).toEqual(["U+FDD0", "U+FFFF"]); // noncharacters
    expect(tofuChars("\ud83d\ud83d\ud83d\ud83d\ud83d\ud83d").length).toBe(1);
  });

  it("letter spacing at 0.5 em with two words, -0.2 em, word spacing at -0.2 em; designs below them stay quiet", () => {
    expect(spacingVerdict({ letterEm: 0.5, wordEm: 0, words: 2, letters: 9 })).toBe("wide");
    expect(spacingVerdict({ letterEm: 0.49, wordEm: 0, words: 2, letters: 9 })).toBeNull();
    expect(spacingVerdict({ letterEm: 0.8, wordEm: 0, words: 1, letters: 6 })).toBeNull(); // one spaced-out word: a logo style
    expect(spacingVerdict({ letterEm: 0.2, wordEm: 0, words: 3, letters: 12 })).toBeNull(); // uppercase eyebrow tracking
    expect(spacingVerdict({ letterEm: -0.2, wordEm: 0, words: 1, letters: 5 })).toBe("tight");
    expect(spacingVerdict({ letterEm: -0.05, wordEm: 0, words: 2, letters: 9 })).toBeNull(); // a tight display heading
    expect(spacingVerdict({ letterEm: 0, wordEm: -0.2, words: 2, letters: 9 })).toBe("words");
    expect(spacingVerdict({ letterEm: 0, wordEm: -0.19, words: 2, letters: 9 })).toBeNull();
  });
});

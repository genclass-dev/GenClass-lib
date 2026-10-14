// The page audits' threshold logic, with measured data as fixtures: WCAG 2.5.8 tap targets and its spacing exception,
// zoom (WCAG 1.4.4), text size (Lighthouse, 12 px), reflow at 360 and 320 px (WCAG 1.4.10), oversized images, images
// without dimensions tied to a layout shift, and LCP and CLS against the web.dev thresholds. The page side is checked
// for being valid, self-contained JavaScript.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clsOf, judgeCls, judgeFontSize, judgeImages, judgeLcp, judgeReflow, judgeTapTargets, judgeUnsized, judgeZoom, pageSide, pageSideSource, parseShifts, viewportOk, viewportPairs, windowScrolls,
} from "../src/audits.ts";
import { sanitizeFinding } from "../src/catalog.ts";

const t = (x: number, y: number, w: number, h: number, more: Record<string, unknown> = {}) => ({ sel: `a.t${x}-${y}`, lab: "", x, y, w, h, inline: false, ua: false, p: -1, ...more });

describe("tap targets: WCAG 2.2 SC 2.5.8 Target Size (Minimum)", () => {
  it("passes targets of 24 by 24 px or more, however close", () => {
    assert.equal(judgeTapTargets([t(0, 0, 24, 24), t(24, 0, 24, 24), t(48, 0, 30, 40)]), null);
  });
  it("fails two small targets whose 24 px circles overlap (centres under 24 px apart)", () => {
    const f = judgeTapTargets([t(0, 0, 16, 16, { lab: "One" }), t(20, 0, 16, 16, { lab: "Two" })])!;
    assert.equal(f.kind, "tap-target-small");
    assert.equal(f.detail!.count, 2);
    assert.equal(f.detail!.severity, "serious");
    assert.match(f.measured, /is 16 by 16 px and its centre is 20 px from the centre of a\.t20-0 \("Two"\), another small target \(24 px needed\)/);
    assert.deepEqual(f.box, { x: 0, y: 0, w: 16, h: 16 });
  });
  it("passes small targets that keep the spacing exception (centres 24 px or more apart, no other target in the circle)", () => {
    assert.equal(judgeTapTargets([t(0, 0, 16, 16), t(24, 0, 16, 16)]), null, "centres exactly 24 px apart");
    assert.equal(judgeTapTargets([t(0, 0, 16, 16), t(100, 0, 16, 16), t(0, 100, 200, 40)]), null);
  });
  it("fails a small target when a large target is within 12 px of its centre", () => {
    const f = judgeTapTargets([t(0, 0, 100, 18), t(0, 20, 100, 40)])!;
    assert.equal(f.detail!.count, 1, "only the small one fails");
    assert.match(f.measured, /a\.t0-0 is 100 by 18 px and a\.t0-20 is 11 px from its centre \(12 px needed\)/);
    assert.equal(judgeTapTargets([t(0, 0, 100, 18), t(0, 21, 100, 40)]), null, "12 px away: the circle only touches it");
  });
  it("exempts links inside a sentence and checkboxes at the browser's own size, and does not compare nested targets", () => {
    assert.equal(judgeTapTargets([t(0, 0, 40, 16, { inline: true }), t(42, 0, 40, 16, { inline: true })]), null);
    assert.equal(judgeTapTargets([t(0, 0, 13, 13, { ua: true }), t(15, 0, 13, 13, { ua: true })]), null);
    // a 16 px icon link inside a 40 px button: the same target
    assert.equal(judgeTapTargets([t(0, 0, 40, 40), t(12, 12, 16, 16, { p: 0 })]), null);
    // an exempt neighbour still counts as a target in the circle
    assert.ok(judgeTapTargets([t(0, 0, 16, 16), t(18, 0, 40, 16, { inline: true })]));
  });
  it("reads only what the page measured, and its finding passes the report's sanitiser", () => {
    assert.equal(judgeTapTargets(null), null);
    assert.equal(judgeTapTargets([{ sel: 3, x: "a" }]), null, "a malformed target is a zero box at the origin and fails nothing alone");
    const f = judgeTapTargets([t(0, 0, 16, 16), t(20, 0, 16, 16)])!;
    assert.deepEqual(sanitizeFinding(f), f);
  });
});

describe("zoom: WCAG 2.2 SC 1.4.4 Resize Text", () => {
  it("fails user-scalable=no or 0 and maximum-scale below 2", () => {
    for (const c of ["width=device-width, user-scalable=no", "width=device-width,user-scalable=0", "width=device-width, initial-scale=1, maximum-scale=1", "width=device-width; maximum-scale=1.5"]) {
      const f = judgeZoom(c);
      assert.ok(f, c);
      assert.equal(f!.kind, "zoom-disabled");
      assert.equal(f!.detail!.severity, "serious");
    }
    assert.match(judgeZoom("width=device-width, maximum-scale=1.0")!.measured, /maximum-scale=1\.0 \(below 2/);
  });
  it("passes zoom that reaches 200%, and has nothing to say without a tag", () => {
    for (const c of ["width=device-width, initial-scale=1", "width=device-width, maximum-scale=2", "width=device-width, maximum-scale=5, user-scalable=yes", "width=device-width, maximum-scale=junk"]) assert.equal(judgeZoom(c), null, c);
    assert.equal(judgeZoom(null), null);
  });
  it("reads the tag as Lighthouse does: width or initial-scale makes it a mobile viewport", () => {
    assert.deepEqual(viewportPairs("Width = device-width ; Initial-Scale=1"), { width: "device-width", "initial-scale": "1" });
    assert.equal(viewportOk("width=device-width"), true);
    assert.equal(viewportOk("initial-scale=1"), true);
    assert.equal(viewportOk("user-scalable=no"), false);
    assert.equal(viewportOk(null), false);
  });
});

describe("text size: Lighthouse's 12 px", () => {
  const vp = "width=device-width, initial-scale=1";
  const block = (chars: number, px = 11) => ({ sel: "footer > p.legal", px, chars, x: 0, y: 900, w: 300, h: 40 });
  it("reports a body text block under 12 px as minor while Lighthouse's audit passes", () => {
    const f = judgeFontSize({ total: 2000, small: 240, blocks: [block(240)] }, vp)!;
    assert.equal(f.detail!.severity, "minor");
    assert.match(f.measured, /^12% of the text on the phone view \(240 of 2,000 characters\) is under 12 px\. Largest block: footer > p\.legal, 11 px, 240 characters\.$/);
  });
  it("is moderate when more than 40% of the text is under 12 px (the audit fails)", () => {
    const f = judgeFontSize({ total: 1000, small: 450, blocks: [block(450)] }, vp)!;
    assert.equal(f.detail!.severity, "moderate");
    assert.match(f.measured, /legible-font-size audit \(60% at 12 px or more\) fails/);
  });
  it("ignores short fragments, pages with little text, and pages without a mobile viewport", () => {
    assert.equal(judgeFontSize({ total: 2000, small: 60, blocks: [block(39)] }, vp), null, "a block under 40 characters is a label, not body text");
    assert.equal(judgeFontSize({ total: 150, small: 150, blocks: [block(150)] }, vp), null);
    assert.equal(judgeFontSize({ total: 2000, small: 1500, blocks: [block(1500)] }, null), null, "the viewport finding covers a page laid out 980 px wide");
    assert.equal(judgeFontSize({ total: 2000, small: 0, blocks: [] }, vp), null);
  });
});

describe("reflow: WCAG 2.2 SC 1.4.10 at 360 and 320 px", () => {
  const vp = "width=device-width, initial-scale=1";
  const at = (width: number, sw: number, culprits = [{ sel: "div.pricing", right: sw, w: 340, tag: "div" }], scrollable = true) => ({ width, sw, scrollable, culprits });
  it("is serious when the page scrolls sideways at 360 px, moderate at 320 px only", () => {
    const both = judgeReflow(at(360, 376), at(320, 376), vp, false)!;
    assert.equal(both.detail!.severity, "serious");
    assert.match(both.measured, /^At 360 px the page is 376 px wide \(16 px too wide\); at 320 px the page is 376 px wide \(56 px too wide\)\. Sticking out at 320 px: div\.pricing \(ends at 376 px\)\.$/);
    assert.deepEqual(both.detail!.widths, [360, 320]);
    assert.equal(judgeReflow(at(360, 360), at(320, 344), vp, false)!.detail!.severity, "moderate");
  });
  it("allows a pixel of rounding, and says nothing when the page cannot scroll sideways", () => {
    assert.equal(judgeReflow(at(360, 361), at(320, 321), vp, false), null);
    assert.equal(judgeReflow(at(360, 400, [], false), at(320, 400, [], false), vp, false), null, "overflow-x hidden clips, it does not scroll");
  });
  it("is minor when only tables or preformatted text stick out", () => {
    assert.equal(judgeReflow(at(360, 500, [{ sel: "table.data", right: 500, w: 480, tag: "table" }]), null, vp, false)!.detail!.severity, "minor");
  });
  it("is not judged when the page already scrolls sideways at 390 px or has no mobile viewport", () => {
    assert.equal(judgeReflow(at(360, 700), at(320, 700), vp, true), null);
    assert.equal(judgeReflow(at(360, 980), at(320, 980), null, false), null);
  });
});

describe("oversized images: more than 4 times the pixels at a high-density screen, over 100 KB", () => {
  const img = (natW: number, natH: number, w: number, h: number, src = "https://shop.example.com/hero.jpg") => ({ sel: "img.hero", src, natW, natH, w, h, x: 0, y: 0 });
  const bytes = (n: number, mime = "image/jpeg") => () => ({ bytes: n, mime });
  it("flags a 4000 by 3000 file shown at 400 by 300 on the desktop (25 times what a 2x screen needs)", () => {
    const f = judgeImages([img(4000, 3000, 400, 300)], bytes(1_400_000), 2, "desktop")!;
    assert.equal(f.kind, "image-oversized");
    assert.equal(f.detail!.severity, "moderate", "more than 1 MB in all");
    assert.match(f.measured, /a 4,000 by 3,000 file \(1\.4 MB\) shown at 400 by 300 px, where 800 by 600 is enough/);
  });
  it("is not flagged at 4 times or less, at 100 KB or less, as SVG, or when the size is unknown", () => {
    assert.equal(judgeImages([img(1600, 1200, 400, 300)], bytes(500_000), 2, "desktop"), null, "exactly 4 times at 2x");
    assert.equal(judgeImages([img(4000, 3000, 400, 300)], bytes(100 * 1024), 2, "desktop"), null);
    assert.equal(judgeImages([img(4000, 3000, 400, 300)], bytes(500_000, "image/svg+xml"), 2, "desktop"), null);
    assert.equal(judgeImages([img(4000, 3000, 400, 300, "https://x.example.com/a.svg")], bytes(500_000), 2, "desktop"), null);
    assert.equal(judgeImages([img(4000, 3000, 400, 300)], () => null, 2, "desktop"), null);
  });
  it("judges phones at 3x, counts each file once, and is minor under 1 MB", () => {
    assert.equal(judgeImages([img(2000, 1500, 400, 300)], bytes(300_000), 3, "phone"), null, "2000x1500 over 1200x900 is 2.8 times");
    const f = judgeImages([img(4000, 3000, 400, 300), img(4000, 3000, 400, 300)], bytes(300_000), 3, "phone")!;
    assert.equal(f.detail!.count, 1);
    assert.equal(f.detail!.severity, "minor");
  });
});

describe("Largest Contentful Paint and Cumulative Layout Shift: web.dev thresholds", () => {
  it("LCP: nothing at 2.5 s or less, minor above 2.5 s, moderate above 4 s, and every finding says it was measured in a data center", () => {
    assert.equal(judgeLcp({ t: 2500 }), null);
    assert.equal(judgeLcp(null), null);
    const mid = judgeLcp({ t: 2600, sel: "img.hero" })!;
    assert.equal(mid.detail!.severity, "minor");
    assert.match(mid.measured, /^Largest Contentful Paint at 2\.60 s \(img\.hero\) on the desktop view: needs improvement \(above 2\.5 s\)\. Measured once in Cloudflare's browser in a data center/);
    assert.equal(judgeLcp({ t: 4100 })!.detail!.severity, "moderate");
  });
  it("CLS: session windows with gaps of at most 1 s and 5 s at most each, shifts after input left out", () => {
    const s = (t: number, v: number, input = false) => ({ t, v, input, sources: [] });
    assert.equal(clsOf(parseShifts([s(100, 0.05), s(600, 0.05), s(1100, 0.05)])).value, 0.15, "one window");
    assert.equal(clsOf(parseShifts([s(100, 0.05), s(2200, 0.05)])).value, 0.05, "a gap over 1 s starts a new window");
    assert.equal(clsOf(parseShifts(Array.from({ length: 12 }, (_, i) => s(i * 900, 0.02)))).value, 0.12, "a window ends after 5 s");
    assert.equal(clsOf(parseShifts([s(100, 0.3, true), s(200, 0.01)])).value, 0.01);
    assert.equal(judgeCls([s(100, 0.1)]), null, "0.1 is good");
    assert.equal(judgeCls([s(100, 0.11)])!.detail!.severity, "minor");
    assert.equal(judgeCls([s(100, 0.2), s(300, 0.1)])!.detail!.severity, "moderate");
  });
  it("ties an image without dimensions to the shift it caused, and to nothing else", () => {
    const image = [{ sel: "img.banner", x: 0, y: 100, w: 600, h: 200, end: 1200 }];
    const moved = (t: number, prevY: number, curY: number, x = 0) => [{ t, v: 0.12, input: false, sources: [{ sel: "main > h1", prev: { x, y: prevY, w: 600, h: 40 }, cur: { x, y: curY, w: 600, h: 40 } }] }];
    const f = judgeUnsized(image, moved(1240, 100, 300))!;
    assert.equal(f.kind, "image-unsized-shift");
    assert.equal(f.detail!.severity, "minor", "always minor: the shift size in the scanner's browser is not used");
    assert.match(f.measured, /img\.banner finished loading at 1\.20 s; a shift of 0\.120 at 1\.24 s moved main > h1 down/);
    assert.equal(judgeUnsized(image, moved(900, 100, 300)), null, "a shift before the image arrived");
    assert.equal(judgeUnsized(image, moved(3000, 100, 300)), null, "a shift long after it arrived");
    assert.equal(judgeUnsized(image, moved(1240, 20, 220)), null, "content above the image did not move because of it");
    assert.equal(judgeUnsized(image, moved(1240, 100, 300, 700)), null, "content beside it, not below it");
    assert.equal(judgeUnsized(image, moved(1240, 300, 100)), null, "content that moved up");
    assert.equal(judgeUnsized([{ ...image[0], end: null }], moved(1240, 100, 300)), null, "no load time, no claim");
  });
});

describe("whether the window scrolls: CSS overflow propagation", () => {
  it("lets body's overflow reach the window only when html's is visible, and needs content to scroll to", () => {
    assert.equal(windowScrolls({ html: "scroll", body: "hidden", sh: 9150, ch: 768 }), true, "html scrolls the window; body's hidden stays on body");
    assert.equal(windowScrolls({ html: "auto", body: "hidden", sh: 3000, ch: 768 }), true);
    assert.equal(windowScrolls({ html: "visible", body: "hidden", sh: 9150, ch: 768 }), false, "body's hidden reaches the window: a real lock");
    assert.equal(windowScrolls({ html: "hidden", body: "auto", sh: 9150, ch: 768 }), false);
    assert.equal(windowScrolls({ html: "scroll", body: "hidden", sh: 800, ch: 768 }), false, "nothing to scroll to: body clips its content");
    assert.equal(windowScrolls(null), false);
  });
});

describe("the page side", () => {
  it("is valid JavaScript that uses nothing from outside itself", () => {
    for (const cmd of ["vitals", "audit", "reflow"] as const) assert.doesNotThrow(() => new Function(`return ${pageSideSource(cmd, { targets: true })}`), cmd);
    assert.doesNotMatch(pageSide.toString(), /__name\(|\bimport\(|require\(/);
  });
});

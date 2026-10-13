// The measured visual checks' verdicts as pure functions over fixtures of computed-style strings (docs/runtime/
// VISUAL.md section 3): planted faults and the clean controls next to them (sr-only text, gradient text, text over
// images, shadows, translucent groups, dark canvases), the text patterns, the asset and layout verdicts, and the
// finding format (labelled as measured, never a probability).
import { describe, expect, it } from "vitest";
import { judgeContrast, undefinedVarRefs, type ContrastInput } from "../src/visual/checks/text.js";
import { brokenImageVerdict, cspReportable, familyStatus, firstFamily, iconBroken, mediaVerdict } from "../src/visual/checks/assets.js";
import { overflowReportable, poorWindows, viewportMetaMissing } from "../src/visual/checks/layout.js";
import { dialogReportable } from "../src/visual/checks/interact.js";
import { excerpt, placeholderHost, scanText } from "../src/visual/patterns.js";
import { fold, toFinding } from "../src/visual/report.js";
import { hash32, KINDS, LIGHT, resolveCfg, transitionMs } from "../src/visual/engine.js";
import { hashedClass } from "../src/visual/measure.js";
import type { Draft } from "../src/visual/draft.js";

const light = { html: "rgba(0, 0, 0, 0)", body: "rgba(0, 0, 0, 0)", darkCanvas: false };
const layers = (...bg: (string | [string, string])[]) => bg.map((b) => (typeof b === "string" ? { bg: b } : { bg: b[0], abstain: b[1] }));
const input = (o: Partial<ContrastInput>): ContrastInput => ({ fg: "rgb(17, 24, 39)", fontPx: 16, weight: 400, chains: [layers("rgb(255, 255, 255)")], root: light, ...o });

describe("text-invisible verdict (VISUAL.md 2.4, 3.8)", () => {
  it("white on white, near-white on white, dark on near-black are low; ordinary text is ok", () => {
    expect(judgeContrast(input({ fg: "rgb(255, 255, 255)" }))).toMatchObject({ verdict: "low", ratio: 1 });
    expect(judgeContrast(input({ fg: "rgb(250, 250, 250)" }))).toMatchObject({ verdict: "low", ratio: 1.04 });
    expect(judgeContrast(input({ fg: "rgb(31, 41, 55)", chains: [layers("rgb(17, 24, 39)")] }))).toMatchObject({ verdict: "low" });
    expect(judgeContrast(input({}))).toMatchObject({ verdict: "ok" });
    expect(judgeContrast(input({ fg: "rgb(107, 114, 128)" }))).toMatchObject({ verdict: "ok" }); // muted grey 4.83:1 is not "unreadable"
  });

  it("Tailwind v4 oklch() colours", () => {
    expect(judgeContrast(input({ fg: "oklch(0.985 0 0)", chains: [layers("oklch(1 0 0)")] }))).toMatchObject({ verdict: "low" });
    expect(judgeContrast(input({ fg: "oklch(0.21 0.034 264.665)", chains: [layers("oklch(1 0 0)")] }))).toMatchObject({ verdict: "ok" });
  });

  it("translucent layers composite down to the first opaque one; the canvas is white without dark mode", () => {
    // white text on a 50% black glass over white: grey background, 3.95:1, ok
    expect(judgeContrast(input({ fg: "rgb(255, 255, 255)", chains: [layers("rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)")] }))).toMatchObject({ verdict: "ok" });
    // nothing opaque at all: the white canvas
    expect(judgeContrast(input({ fg: "rgb(255, 255, 255)", chains: [layers("rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)")] }))).toMatchObject({ verdict: "low", canvas: true });
    // translucent text on white composites first
    expect(judgeContrast(input({ fg: "rgba(255, 255, 255, 0.4)" }))).toMatchObject({ verdict: "low", ratio: 1 });
    // fully transparent text counts as 1:1
    expect(judgeContrast(input({ fg: "rgba(0, 0, 0, 0)" }))).toMatchObject({ verdict: "low", ratio: 1, transparent: true });
  });

  it("abstains on images, gradients, replaced elements, filters, blend modes, pseudo layers", () => {
    for (const why of ["background-image", "replaced", "filter", "blend", "pseudo-layer"])
      expect(judgeContrast(input({ fg: "rgb(255, 255, 255)", chains: [layers("rgba(0, 0, 0, 0)", ["rgb(255, 255, 255)", why])] }))).toEqual({ verdict: "unknown", reason: why });
  });

  it("abstains on text-shadow, text-stroke, partial opacity, gradient text and stacked copies", () => {
    expect(judgeContrast(input({ fg: "rgb(255, 255, 255)", shadow: "rgb(0, 0, 0) 0px 0px 3px" }))).toEqual({ verdict: "unknown", reason: "text-shadow" });
    expect(judgeContrast(input({ fg: "rgb(255, 255, 255)", shadow: "none" }))).toMatchObject({ verdict: "low" });
    expect(judgeContrast(input({ fg: "rgb(255, 255, 255)", stroke: 1 }))).toEqual({ verdict: "unknown", reason: "text-stroke" });
    expect(judgeContrast(input({ fg: "rgb(255, 255, 255)", translucent: true }))).toEqual({ verdict: "unknown", reason: "opacity" });
    expect(judgeContrast(input({ fg: "rgba(0, 0, 0, 0)", clipText: true }))).toEqual({ verdict: "unknown", reason: "gradient-text" });
    expect(judgeContrast(input({ fg: "rgba(0, 0, 0, 0)", stackedCopy: true }))).toEqual({ verdict: "unknown", reason: "stacked-copy" });
  });

  it("-webkit-text-fill-color wins over color when set", () => {
    expect(judgeContrast(input({ fg: "rgb(0, 0, 0)", fill: "rgb(255, 255, 255)" }))).toMatchObject({ verdict: "low" });
  });

  it("sample points must agree, and unparsable colours abstain", () => {
    expect(judgeContrast(input({ fg: "rgb(255, 255, 255)", chains: [layers("rgb(255, 255, 255)"), layers("rgb(0, 0, 0)")] }))).toEqual({ verdict: "unknown", reason: "mixed-background" });
    expect(judgeContrast(input({ fg: "rgb(255, 255, 255)", chains: [layers("rgb(255, 255, 255)"), layers("rgb(254, 255, 255)")] }))).toMatchObject({ verdict: "low" });
    expect(judgeContrast(input({ fg: "color-mix(in srgb, red, blue)" }))).toEqual({ verdict: "unknown", reason: "color-unparsed" });
    expect(judgeContrast(input({ chains: [layers("canvas")] }))).toEqual({ verdict: "unknown", reason: "background-unparsed" });
    expect(judgeContrast(input({ chains: [] }))).toEqual({ verdict: "unknown", reason: "no-points" });
  });

  it("a dark canvas: the verdict must hold for the Chrome, Safari and Firefox canvases", () => {
    const dark = { ...light, darkCanvas: true };
    const none = [layers("rgba(0, 0, 0, 0)")];
    expect(judgeContrast(input({ fg: "rgb(20, 20, 20)", chains: none, root: dark }))).toMatchObject({ verdict: "low", canvas: true });
    expect(judgeContrast(input({ fg: "rgb(237, 237, 237)", chains: none, root: dark }))).toMatchObject({ verdict: "ok" });
    // rgb(56, 56, 56): 1.6:1 on #121212 but 1.42:1 on #1e1e1e: depends on the browser, so no verdict
    expect(judgeContrast(input({ fg: "rgb(56, 56, 56)", chains: none, root: dark }))).toEqual({ verdict: "unknown", reason: "dark-canvas-mixed" });
    // an opaque background makes the canvas irrelevant
    expect(judgeContrast(input({ fg: "rgb(56, 56, 56)", chains: [layers("rgb(255, 255, 255)")], root: dark }))).toMatchObject({ verdict: "ok", canvas: false });
  });

  it("the suggestion's target follows large text", () => {
    expect(judgeContrast(input({ fg: "rgb(255, 255, 255)", fontPx: 24 }))).toMatchObject({ large: true, target: 3 });
    expect(judgeContrast(input({ fg: "rgb(255, 255, 255)", fontPx: 18.66, weight: 700 }))).toMatchObject({ large: true, target: 3 });
    expect(judgeContrast(input({ fg: "rgb(255, 255, 255)", fontPx: 18, weight: 700 }))).toMatchObject({ large: false, target: 4.5 });
  });
});

describe("text patterns (VISUAL.md 3.9 to 3.11)", () => {
  const ids = (s: string) => scanText(s).map((x) => x.p.id);
  it("template leaks", () => {
    expect(ids("Customer: [object Object]")).toEqual(["object-object"]);
    expect(ids("Last seen Invalid Date")).toEqual(["invalid-date"]);
    expect(ids("Hello {{ user.name }}")).toEqual(["mustache"]);
    expect(ids("Total ${price}")).toEqual(["template-literal"]);
    expect(ids("{% if user %}")).toEqual(["jinja"]);
    expect(ids("Hi <%= name %>")).toEqual(["erb"]);
    expect(ids("Total: $NaN")).toEqual(["currency-nan"]);
    expect(ids("€ undefined")).toEqual(["currency-nan"]);
    expect(ids("width: undefinedpx")).toEqual(["currency-nan"]); // a unit glued to undefined
    expect(ids("an undefined error")).toEqual([]);
    expect(ids("12 NaN%")).toEqual(["currency-nan"]);
    expect(ids("NaN:NaN")).toEqual(["nan-time"]);
  });
  it("placeholders and encoding", () => {
    expect(ids("Lorem ipsum dolor sit amet")).toEqual(["lorem"]);
    expect(ids("Itâ€™s ready")).toEqual(["mojibake"]);
    expect(ids("cafÃ©")).toEqual(["mojibake"]);
    expect(ids("a � b")).toEqual(["replacement-char"]);
    expect(ids("Fish &amp; chips")).toEqual(["double-escaped"]);
  });
  it("correct text is not a match", () => {
    for (const s of ["Café, crème brûlée, São Paulo, naïve, Ærø", "Price: $0", "The NaN value in JavaScript", "null", "Use {braces} in prose", "Fish & chips", "Totally undefined behaviour", "Loremipsum"]) expect(ids(s), s).toEqual([]);
  });
  it("excerpts and placeholder hosts", () => {
    expect(excerpt("Your order total is $NaN today", 20)).toContain("$NaN");
    expect(placeholderHost("https://placehold.co/300x200.png")).toBe("placehold.co");
    expect(placeholderHost("https://via.placeholder.com/150")).toBe("via.placeholder.com");
    expect(placeholderHost("https://cdn.example.com/a.png")).toBeNull();
    expect(placeholderHost("https://picsum.photos/200", ["picsum.photos"])).toBeNull();
  });
});

describe("asset verdicts (VISUAL.md 3.1 to 3.7)", () => {
  it("image-broken: same-site failures report; cross-site ones only with an HTTP error status", () => {
    expect(brokenImageVerdict({ sameSite: true, hasEntry: true, status: 404, statusSupported: true })).toEqual({ report: true, cause: "HTTP 404" });
    expect(brokenImageVerdict({ sameSite: false, hasEntry: true, status: 500, statusSupported: true }).report).toBe(true);
    expect(brokenImageVerdict({ sameSite: false, hasEntry: true, status: 0, statusSupported: true })).toEqual({ report: false, cause: "status hidden (cross-origin)" });
    expect(brokenImageVerdict({ sameSite: false, hasEntry: false, statusSupported: true }).report).toBe(false); // a blocker or CSP on the visitor's device
    expect(brokenImageVerdict({ sameSite: true, hasEntry: false, statusSupported: true }).cause).toMatch(/blocked before the request/);
    expect(brokenImageVerdict({ sameSite: true, hasEntry: true, statusSupported: false }).cause).toBe("status unknown");
  });

  it("media-failed: error codes 2 to 4 or NETWORK_NO_SOURCE on a visible video or an audio player with controls", () => {
    const v = { networkState: 1, hasSource: true, preloadNone: false, video: true, w: 320, h: 180, controls: true };
    expect(mediaVerdict({ ...v, code: 4 })).toBe(true);
    expect(mediaVerdict({ ...v, code: 1 })).toBe(false); // aborted
    expect(mediaVerdict({ ...v, networkState: 3 })).toBe(true);
    expect(mediaVerdict({ ...v, networkState: 3, preloadNone: true })).toBe(false);
    expect(mediaVerdict({ ...v, code: 4, w: 40 })).toBe(false);
    expect(mediaVerdict({ ...v, code: 4, hasSource: false })).toBe(false);
    expect(mediaVerdict({ ...v, code: 4, video: false, controls: false })).toBe(false);
  });

  it("csp-blocked: enforced style, font, image and media directives, never extension sources", () => {
    expect(cspReportable({ disposition: "enforce", effectiveDirective: "style-src-elem", blockedURI: "inline" })).toBe(true);
    expect(cspReportable({ disposition: "enforce", effectiveDirective: "img-src", blockedURI: "https://cdn.example.com/a.png" })).toBe(true);
    expect(cspReportable({ disposition: "report", effectiveDirective: "img-src", blockedURI: "https://cdn.example.com/a.png" })).toBe(false);
    expect(cspReportable({ disposition: "enforce", effectiveDirective: "script-src-elem", blockedURI: "inline" })).toBe(false);
    expect(cspReportable({ disposition: "enforce", effectiveDirective: "connect-src", blockedURI: "https://api.example.com" })).toBe(false);
    expect(cspReportable({ disposition: "enforce", effectiveDirective: "style-src-elem", blockedURI: "chrome-extension://abc/x.css" })).toBe(false);
    expect(cspReportable({ disposition: "enforce", effectiveDirective: "style-src-attr", blockedURI: "inline", sourceFile: "moz-extension://x/c.js" })).toBe(false);
  });

  it("fonts: the first family, the family's status across faces", () => {
    expect(firstFamily('"Brand Sans", Georgia, serif')).toBe("brand sans");
    const faces = [
      { family: '"Brand Sans"', status: "error" },
      { family: "Icons", status: "loaded" },
      { family: "Icons", status: "error" },
      { family: "Later", status: "unloaded" },
    ];
    expect(familyStatus(faces, "brand sans")).toBe("error");
    expect(familyStatus(faces, "icons")).toBe("loaded"); // one subset loaded: not failed
    expect(familyStatus(faces, "later")).toBe("pending");
    expect(familyStatus(faces, "nope")).toBe("none");
  });

  it("icon fonts: a Private Use Area box or a ligature word wider than 1.6 em", () => {
    expect(iconBroken({ content: '""', text: "", widthPx: 16, fontPx: 16 })).toBe("pua");
    expect(iconBroken({ content: "none", text: "shopping_cart", widthPx: 110, fontPx: 24 })).toBe("ligature");
    expect(iconBroken({ content: "none", text: "home", widthPx: 24, fontPx: 24 })).toBeNull(); // a loaded ligature is about 1 em
    expect(iconBroken({ content: '"→"', text: "", widthPx: 16, fontPx: 16 })).toBeNull();
    expect(iconBroken({ content: "none", text: "Settings", widthPx: 80, fontPx: 16 })).toBeNull(); // a word, not a ligature token
  });
});

describe("layout and interaction verdicts (VISUAL.md 3.12 to 3.23)", () => {
  it("css-var-undefined: no fallback, defined nowhere, Tailwind internals excluded", () => {
    const refs = undefinedVarRefs(
      [
        { selector: ".buy", prop: "background", value: "var(--brand-primary)" },
        { selector: ".ok", prop: "color", value: "var(--fg, #111)" },
        { selector: ".tw", prop: "transform", value: "translate(var(--tw-translate-x), 0)" },
        { selector: ".def", prop: "color", value: "var(--fg)" },
        { selector: ".two", prop: "border", value: "1px solid var( --line )" },
      ],
      new Set(["--fg"]),
    );
    expect(refs).toEqual([
      { name: "--brand-primary", selector: ".buy", prop: "background" },
      { name: "--line", selector: ".two", prop: "border" },
    ]);
  });

  it("page-overflow-x needs more than 1 px and a viewport that does not clip", () => {
    expect(overflowReportable({ scrollWidth: 1624, clientWidth: 1280, clipped: false, rtl: false })).toBe(true);
    expect(overflowReportable({ scrollWidth: 1624, clientWidth: 1280, clipped: true, rtl: false })).toBe(false);
    expect(overflowReportable({ scrollWidth: 1281, clientWidth: 1280, clipped: false, rtl: false })).toBe(false);
  });

  it("viewport-meta-missing: a coarse pointer, a phone-sized screen, no width=device-width, a 980 px layout", () => {
    const p = { coarse: true, screenW: 390, content: null, clientWidth: 980 };
    expect(viewportMetaMissing(p)).toBe(true);
    expect(viewportMetaMissing({ ...p, content: "width=device-width, initial-scale=1" })).toBe(false);
    expect(viewportMetaMissing({ ...p, content: "initial-scale=1" })).toBe(true);
    expect(viewportMetaMissing({ ...p, coarse: false })).toBe(false);
    expect(viewportMetaMissing({ ...p, screenW: 820 })).toBe(false);
    expect(viewportMetaMissing({ ...p, clientWidth: 390 })).toBe(false);
  });

  it("layout-shift: only windows above 0.25 are reported", () => {
    expect(poorWindows([{ t: 0, value: 0.2 }, { t: 3000, value: 0.26 }]).map((w) => w.score)).toEqual([0.26]);
    expect(poorWindows([{ t: 0, value: 0.25 }])).toEqual([]);
  });

  it("dialog-covered: half the points, any control's centre, or controls below a fixed dialog", () => {
    expect(dialogReportable({ total: 10, covered: 5 })).toBe(true);
    expect(dialogReportable({ total: 10, covered: 4 })).toBe(false);
    expect(dialogReportable({ total: 10, covered: 1, child: {} as Element })).toBe(true);
    expect(dialogReportable({ total: 10, covered: 0, below: {} as Element })).toBe(true);
    expect(dialogReportable({ total: 0, covered: 0 })).toBe(false);
  });
});

describe("findings: labelled as measured checks (VISUAL.md 1, 9.1, 9.2)", () => {
  const draft = (o: Partial<Draft> = {}): Draft => ({
    kind: "text-invisible",
    el: null,
    key: "text-invisible|p.a|rest|light",
    severity: "high",
    measured: { ratio: 1, fg: "#ffffff", bg: "#ffffff" },
    threshold: { value: 1.5, unit: ":1 contrast", source: "WCAG 2.2 contrast formula; unreadable-text threshold" },
    text: 'text contrast 1.00:1 on p.a "Hello", below 1.5:1 (WCAG 2.2 contrast formula; unreadable-text threshold).',
    suggestion: { selector: "p.a", css: "color: #737373;" },
    ...o,
  });
  const ctx = { id: "c1", at: 1000, route: "/", scheme: "light" as const, viewport: { w: 1280, h: 800 }, coarse: false, tier: "full" as const, target: 'paragraph "Hello"', selector: "p.a", structural: false };

  it("the console line starts [GenClass] Check (measured): and carries the CSS, never a probability", () => {
    const f = toFinding(draft(), ctx);
    expect(f.source).toBe("check");
    expect(f.message).toBe('[GenClass] Check (measured): text contrast 1.00:1 on p.a "Hello", below 1.5:1 (WCAG 2.2 contrast formula; unreadable-text threshold). Suggested CSS: p.a { color: #737373; }');
    expect(f.message).not.toMatch(/\(\w+, \d\.\d\d\)/);
    expect(f.details.join("\n")).toContain("This is a measured check with a fixed threshold, not a model finding.");
    expect(f.details.join("\n")).toContain('visual: { ignore: ["p.a"] }');
    expect(f.details.join("\n")).not.toContain("Situation sent to the model");
    expect(f.element()).toBeNull();
    expect(f.context).toEqual({ scheme: "light", viewport: { w: 1280, h: 800 }, coarse: false, tier: "full" });
  });

  it("without a CSS fix the line says what to change instead", () => {
    const f = toFinding(draft({ kind: "viewport-meta-missing", suggestion: undefined, fixText: 'add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>' }), ctx);
    expect(f.message).toMatch(/ Fix: add <meta name="viewport"/);
  });

  it("drafts with the same key fold into one finding with every element", () => {
    const a = {} as Element;
    const b = {} as Element;
    const out = fold([draft({ el: a }), draft({ el: b }), draft({ key: "other", el: a })]);
    expect(out.length).toBe(2);
    expect(out[0].els).toEqual([a, b]);
    expect(out[0].folded).toBe(2);
    expect(toFinding(out[0], ctx).message).toContain("(2 elements with this selector)");
  });
});

describe("options and helpers", () => {
  it("23 kinds; the light tier keeps only the near-free ones", () => {
    expect(KINDS.length).toBe(23);
    for (const k of ["text-invisible", "text-template-leak", "css-var-undefined", "image-distorted", "page-overflow-x", "page-blank"] as const) expect(LIGHT.has(k)).toBe(false);
    expect(LIGHT.has("image-broken")).toBe(true);
  });

  it("defaults and clamps; fixes need on: true (never from 'local' or a URL)", () => {
    const d = resolveCfg({}, null);
    expect([d.budgetMs, d.passBudgetMs, d.maxElements, d.lowEnd, d.sample, d.maxConsoleLines]).toEqual([8, 100, 2000, "light", 1, 10]);
    expect([...d.fix]).toEqual([]);
    expect(resolveCfg({ budgetMs: 100, maxElements: 1, sample: 7 }, null)).toMatchObject({ budgetMs: 16, maxElements: 50, sample: 1 });
    expect([...resolveCfg({ on: true, fix: true }, null).fix]).toEqual(["text-invisible", "pointer-events-leak", "scroll-lock-stuck"]);
    expect([...resolveCfg({ on: true, fix: ["scroll-lock-stuck", "nope" as never] }, null).fix]).toEqual(["scroll-lock-stuck"]);
    expect([...resolveCfg({ on: "local", fix: true }, null).fix]).toEqual([]);
    expect([...resolveCfg({ fix: true }, null).fix]).toEqual([]);
    expect(resolveCfg({ checks: { "layout-shift": false } }, null).checks["layout-shift"]).toBe(false);
  });

  it("generated class names are left out of selectors; BEM names stay", () => {
    for (const c of ["Button_primary__a1B2c", "styles__btn___3Hn2c", "css-1x2y3z", "sc-AxjAm", "jsx-123456", "svelte-1abc2de"]) expect(hashedClass(c), c).toBe(true);
    for (const c of ["hero__subtitle", "card_title", "nav-link", "btn-primary", "is-active", "pricing-table"]) expect(hashedClass(c), c).toBe(false);
  });

  it("session sampling hashes the session id (never Math.random)", () => {
    expect(hash32("s1")).toBe(hash32("s1"));
    expect(hash32("s1")).not.toBe(hash32("s2"));
  });

  it("transition time for colour and background", () => {
    expect(transitionMs({ transitionProperty: "color, opacity", transitionDuration: "0.2s, 1s", transitionDelay: "50ms, 0s" } as CSSStyleDeclaration)).toBe(250);
    expect(transitionMs({ transitionProperty: "all", transitionDuration: "300ms", transitionDelay: "0s" } as CSSStyleDeclaration)).toBe(300);
    expect(transitionMs({ transitionProperty: "opacity", transitionDuration: "1s", transitionDelay: "0s" } as CSSStyleDeclaration)).toBe(0);
  });
});

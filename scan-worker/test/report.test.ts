// The report: findings merged across views and grouped by category and rule, numbered in a fixed order, race findings
// from the probe, "fixed" only when the guard re-run or the visual re-check in every view measured it gone, categories
// that were not measured left out of the score, and the top issues. The score's own math is in score.test.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RawFinding } from "../src/catalog.ts";
import { categoryOf, describe as words, KINDS, sanitizeFinding, sanitizeStats, severityOf, suggestFix, VISUAL_KINDS } from "../src/catalog.ts";
import { buildReport, guardSetting, heldBack, JS_NOTE, probeFindings, raceFix, REFUSED_NOTE, subjectNames } from "../src/report.ts";
import { emptyCoverage, type ProbeResult, type ScanResult, type ViewResult, type VisualFixes } from "../src/scan.ts";
import { categoryValue, rulesOf } from "../src/score.ts";
import { normaliseTarget, type Target } from "../src/target.ts";


const target = normaliseTarget("shop.example.com/") as Target;
/** Everything measured: axe-core ran in every view, the phone audits on the phone, the browser's record, the desktop's timings. */
const covered = (id: ViewResult["id"]): ViewResult["coverage"] => ({ ...emptyCoverage(), axe: { ran: true, ms: 120, rules: 0, incomplete: 2, passes: 40, error: null }, phone: id === "phone", reliability: true, vitals: id === "desktop" });
const view = (id: ViewResult["id"], findings: RawFinding[], audits: RawFinding[] = []): ViewResult => ({
  id, label: id, width: id === "desktop" ? 1366 : 390, height: 800, ok: true, status: 200, finalUrl: target.url, ms: 10, notes: [], findings,
  checks: {}, fixes: null, shot: new Uint8Array([1]), shotHeight: 1600, standIns: { count: 0, requests: [] },
  audits, coverage: covered(id), metrics: { lcpMs: id === "desktop" ? 1200 : null, cls: 0.02, jsBytes: id === "desktop" ? 400_000 : null, whoAsks: 0 },
});
const probe = (mode: "observe" | "guard", sent: number, identical: number, acts: ProbeResult["acts"] = [], detections: ProbeResult["detections"] = []): ProbeResult => ({
  mode, ran: true, model: { state: "ready", device: "wasm", variant: "q8", loadMs: 3000, waitedMs: 3000, error: null, version: "x" }, runtimeError: null, holdBudgetMs: 900, visibility: "visible",
  typed: null, clicked: { target: "button.cta", label: "Buy", formMethod: "post", sent, identical, requests: [{ method: "POST", path: "shop.example.com/api/orders" }] },
  detections, acts, decisions: detections.length, loadStandIns: 0, aborted: 0, answeredLocally: sent, ms: 100,
});
const COALESCE = [{ id: "a1", decisionId: "d1", action: "coalesce", trigger: "request", subject: "POST /api/orders (#3)", ok: true, changed: "reused the first response", late: false }];
const DUP_ORDERS = [{ id: "d1", trigger: "request", subject: "POST /api/orders (#3)", diagnosis: "duplicate", p: 0.99, action: "coalesce", ran: "coalesce", executed: true, latencyMs: 200 }];
const contrastF = (sel: string, fixApplied = false): RawFinding => ({
  kind: "text-invisible", selector: sel, box: { x: 10, y: 20, w: 100, h: 18 }, measured: "text contrast 1.10:1 on p.note", detail: { severity: "high", css: `${sel} { color: #767676; }`, fixApplied, state: "" },
});
const fixedIn = (key: string): VisualFixes => ({ applied: 1, rechecked: true, fixed: [{ kind: "text-invisible", selector: "p.note", key, how: "GenClass changed the page: p.note { color: rgb(118, 118, 118); }. The re-check no longer found it." }], notFixed: [] });
const scan = (o: Partial<ScanResult> = {}): ScanResult => ({
  views: [
    view("desktop", [contrastF("p.note"), { kind: "image-broken", selector: "img.hero", box: { x: 0, y: 0, w: 10, h: 10 }, measured: "an image failed to load", detail: { severity: "medium" } }]),
    view("phone", [contrastF("p.note"), { kind: "page-overflow-x", selector: "div.wide", box: { x: 0, y: 0, w: 500, h: 10 }, measured: "the page scrolls sideways", detail: { severity: "high", css: "div.wide { max-width: 100%; }" } }]),
    view("phone-dark", []),
  ],
  probe: probe("observe", 2, 2),
  guard: probe("guard", 1, 1, COALESCE, DUP_ORDERS),
  notes: [],
  ms: { total: 30000, launch: 1000, views: 9000, probe: 6000, guard: 9000 },
  chrome: "HeadlessChrome/131",
  timedOut: false,
  ...o,
});
const ids = { id: "abc123def", key: "0".repeat(32), at: new Date("2026-10-13T12:00:00Z"), runtime: "0.2.1", axe: "4.13.0", guardHoldMs: 900, shotUrl: (v: string) => `/api/scan/shot/${"0".repeat(32)}/abc123def-${v}.jpg` };
/** A category's value from its findings, the way the score computes it. */
const cat = (...fs: [string, "critical" | "serious" | "moderate" | "minor", number?][]) => categoryValue(rulesOf(fs.map(([rule, severity, count]) => ({ category: "visual" as const, rule, severity, count }))));
const mean = (v: Partial<Record<string, number>>, weights: Record<string, number> = { visual: 25, accessibility: 25, phone: 20, reliability: 15, speed: 10, races: 5 }) => {
  const keys = Object.keys(weights);
  return Math.round(keys.reduce((s, k) => s + weights[k] * (v[k] ?? 100), 0) / keys.reduce((s, k) => s + weights[k], 0));
};

describe("buildReport", () => {
  it("merges the same element across views, groups findings by category then rule, and numbers them in that order", () => {
    const r = buildReport(target, ids, scan(), { withGenClass: false });
    assert.deepEqual(r.findings.map((f) => [f.n, f.category, f.kind]), [[1, "visual", "text-invisible"], [2, "visual", "image-broken"], [3, "phone", "page-overflow-x"], [4, "races", "duplicate-submit"]]);
    assert.deepEqual(r.findings[0].views, ["desktop", "phone"]);
    assert.deepEqual(Object.keys(r.findings[0].boxes), ["desktop", "phone"]);
    assert.deepEqual(r.findings.map((f) => f.severity), ["serious", "moderate", "serious", "serious"]);
    assert.equal(r.findings[0].standards[0].label, "WCAG 2.2 SC 1.4.3 Contrast (Minimum), level AA");
    const visual = cat(["text-invisible", "serious"], ["image-broken", "moderate"]);
    assert.equal(r.score.categories.find((c) => c.id === "visual")!.value, Math.round(visual));
    assert.equal(r.score.value, mean({ visual, phone: 85, races: 85 }));
    assert.equal(r.score.value, 91);
    assert.equal(r.views[0].shot, ids.shotUrl("desktop"));
    assert.equal(r.axe, "4.13.0");
    assert.deepEqual(r.notMeasured, {});
    assert.deepEqual([r.metrics.lcpMs, r.metrics.jsBytes, r.metrics.axeIncomplete, r.metrics.axePasses], [1200, 400_000, 2, 40]);
  });
  it("names the top issues by what they cost the overall score, linked to their first finding", () => {
    const r = buildReport(target, ids, scan(), { withGenClass: false });
    assert.deepEqual(r.top.map((t) => [t.rule, t.n]), [["text-invisible", 1], ["page-overflow-x", 3], ["image-broken", 2], ["duplicate-submit", 4]]);
    assert.ok(r.top.every((t, i) => i === 0 || r.top[i - 1].points >= t.points));
    // visual is 79.05 with it and 93 without it: 25 * 13.95 / 100
    assert.deepEqual(r.top.slice(0, 2).map((t) => t.points), [3.49, 3]);
  });
  it("gives the same report for the same scan", () => {
    assert.deepEqual(buildReport(target, ids, scan(), { withGenClass: true }), buildReport(target, ids, scan(), { withGenClass: true }));
  });
  it("hides the with-GenClass score behind the flag, but keeps the measured fix on the finding", () => {
    const off = buildReport(target, ids, scan(), { withGenClass: false });
    assert.equal(off.withGenClass.shown, false);
    assert.equal(off.withGenClass.value, null);
    assert.match(off.withGenClass.note, /switched off/);
    const dup = off.findings.find((f) => f.kind === "duplicate-submit")!;
    assert.match(dup.fixed!.how, /1 sent instead of 2/);
    const on = buildReport(target, ids, scan(), { withGenClass: true });
    assert.equal(on.withGenClass.shown, true);
    assert.equal(on.withGenClass.value, mean({ visual: cat(["text-invisible", "serious"], ["image-broken", "moderate"]), phone: 85 }), "only the fixed race leaves the score");
    assert.equal(on.withGenClass.breakdown!.categories.find((c) => c.id === "races")!.value, 100);
    assert.equal(on.withGenClass.fixed, 1);
  });
  it("counts a visual finding as fixed only when every view it appeared in fixed and re-checked it", () => {
    const key = "text-invisible|p.note|";
    const on = buildReport(target, ids, scan(), { withGenClass: true });
    for (const f of on.findings) if (f.kind !== "duplicate-submit") assert.equal(f.fixed, null, f.kind);
    // p.note is on the desktop and the phone: fixed on the desktop alone is not enough
    const one = scan();
    one.views[0] = { ...one.views[0], findings: [contrastF("p.note", true), ...one.views[0].findings.slice(1)], fixes: fixedIn(key) };
    const r1 = buildReport(target, ids, one, { withGenClass: true });
    const f1 = r1.findings.find((x) => x.kind === "text-invisible")!;
    assert.equal(f1.fixed, null);
    assert.equal(f1.genclass.status, "not-fixed");
    assert.match(f1.genclass.text, /did not run on this view/);
    // fixed and re-checked in both views: fixed, and the with-GenClass score drops its points
    const both = scan();
    both.views[0] = { ...both.views[0], fixes: fixedIn(key) };
    both.views[1] = { ...both.views[1], fixes: fixedIn(key) };
    const r2 = buildReport(target, ids, both, { withGenClass: true });
    const f2 = r2.findings.find((x) => x.kind === "text-invisible")!;
    assert.match(f2.fixed!.how, /re-check no longer found it/);
    assert.equal(f2.genclass.status, "fixed");
    assert.equal(r2.withGenClass.fixed, 2);
    assert.equal(r2.withGenClass.value, mean({ visual: 93, phone: 85 }));
    // a fix the re-check did not confirm says so
    const unconfirmed = scan();
    const nf: VisualFixes = { applied: 1, rechecked: true, fixed: [], notFixed: [{ kind: "text-invisible", selector: "p.note", key, why: "GenClass applied a fix, but the re-check still found the problem." }] };
    unconfirmed.views[0] = { ...unconfirmed.views[0], fixes: nf };
    unconfirmed.views[1] = { ...unconfirmed.views[1], fixes: fixedIn(key) };
    const f3 = buildReport(target, ids, unconfirmed, { withGenClass: true }).findings.find((x) => x.kind === "text-invisible")!;
    assert.equal(f3.fixed, null);
    assert.match(f3.genclass.text, /re-check still found the problem/);
  });
  it("says GenClass reports, and never fixes, the kinds it has no fix for", () => {
    const r = buildReport(target, ids, scan(), { withGenClass: true });
    for (const kind of ["page-overflow-x", "image-broken"]) {
      const f = r.findings.find((x) => x.kind === kind)!;
      assert.equal(f.genclass.status, "reported", kind);
      assert.match(f.genclass.text, /Reported for the developer/);
    }
    assert.equal(r.findings.find((x) => x.kind === "page-overflow-x")!.fix, "div.wide { max-width: 100%; }", "the check's own CSS is the suggested fix");
  });
  it("lists but does not score findings that may come from the scanner's stand-in answers", () => {
    const leak: RawFinding = { kind: "text-template-leak", selector: "span.price", box: { x: 0, y: 0, w: 50, h: 10 }, measured: '"$NaN"', detail: { severity: "high" } };
    const err: RawFinding = { kind: "js-error", selector: "", box: null, measured: "1 uncaught error", detail: { severity: "moderate", count: 1 } };
    const views = (count: number) => [
      { ...view("desktop", [leak, contrastF("p.note")], [err]), standIns: { count, requests: count ? ["POST shop.example.com/graphql"] : [] } },
      { ...view("phone", [leak]), standIns: { count, requests: [] } },
      view("phone-dark", []),
    ];
    const noRaces = { visual: 25, accessibility: 25, phone: 20, reliability: 15, speed: 10 };
    const withStandIns = buildReport(target, ids, scan({ views: views(2), probe: null, guard: null }), { withGenClass: false });
    const f = withStandIns.findings.find((x) => x.kind === "text-template-leak")!;
    assert.match(String(f.unscored), /stand-in answer/);
    assert.match(String(withStandIns.findings.find((x) => x.kind === "js-error")!.unscored), /stand-in answer/, "an error can come from a stand-in answer too");
    assert.equal(withStandIns.score.value, mean({ visual: 85 }, noRaces), "only the contrast finding is scored");
    assert.equal(withStandIns.views[0].standIns, 2);
    assert.equal(withStandIns.notMeasured.races, "The race probe did not run.");
    const without = buildReport(target, ids, scan({ views: views(0), probe: null, guard: null }), { withGenClass: false });
    assert.equal(without.findings.find((x) => x.kind === "text-template-leak")!.unscored, null);
    assert.equal(without.score.value, mean({ visual: cat(["a", "serious"], ["b", "serious"]), reliability: 93 }, noRaces));
    // the same leak also seen in a view that got no stand-in answer is scored
    const mixed = views(1);
    mixed[1] = { ...mixed[1], standIns: { count: 0, requests: [] } };
    assert.equal(buildReport(target, ids, scan({ views: mixed, probe: null, guard: null }), { withGenClass: false }).findings.find((x) => x.kind === "text-template-leak")!.unscored, null);
  });
});

describe("the deeper checks in the report", () => {
  const axe = (count: number, selector: string, summary = "Element has insufficient color contrast of 2.85."): RawFinding => ({
    kind: "axe", selector, box: { x: 0, y: 40, w: 200, h: 20 }, measured: summary,
    detail: { rule: "color-contrast", severity: "serious", impact: "serious", tags: ["wcag2aa", "wcag143"], help: "Elements must meet minimum color contrast ratio thresholds", description: "Ensure the contrast meets WCAG 2 AA.", helpUrl: "https://dequeuniversity.com/rules/axe/4.13/color-contrast?application=axeAPI", count, examples: [selector, ".other"] },
  });
  it("merges one axe-core rule across views into one finding with the most elements any view found", () => {
    const s = scan({ views: [view("desktop", [], [axe(3, ".a")]), view("phone", [], [axe(5, ".b")]), view("phone-dark", [], [axe(5, ".b")])], probe: null, guard: null });
    const r = buildReport(target, ids, s, { withGenClass: false });
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.deepEqual([f.rule, f.source, f.category, f.count, f.views], ["axe:color-contrast", "axe", "accessibility", 5, ["desktop", "phone", "phone-dark"]]);
    assert.equal(f.measured, "Elements: 3 on the desktop, 5 on the phone and 5 on the dark phone. First: Element has insufficient color contrast of 2.85.");
    assert.equal(f.selector, ".b", "the words come from the view that found the most");
    assert.deepEqual(f.examples, [".a", ".other", ".b"]);
    assert.equal(f.guide, "https://dequeuniversity.com/rules/axe/4.13/color-contrast?application=axeAPI");
    assert.equal(f.what, "Elements must meet minimum color contrast ratio thresholds");
    assert.equal(r.score.categories.find((c) => c.id === "accessibility")!.value, Math.round(100 - 15 * (1 + Math.log10(5))));
    assert.equal(f.genclass.status, "reported");
  });
  it("leaves out of the score, and says why, every category the scan did not measure", () => {
    const s = scan();
    for (const v of s.views) v.coverage = { ...emptyCoverage(), reliability: true };
    s.views[0].findings.push({ kind: "focus-obscured", selector: "a.skip", box: null, measured: "focus hidden", detail: { severity: "medium" } });
    const r = buildReport(target, ids, s, { withGenClass: false });
    assert.deepEqual(Object.keys(r.notMeasured).sort(), ["accessibility", "phone", "speed"]);
    assert.equal(r.notMeasured.accessibility, "axe-core did not finish in any view.");
    const a11y = r.score.categories.find((c) => c.id === "accessibility")!;
    assert.deepEqual([a11y.measured, a11y.value], [false, null]);
    assert.match(String(r.findings.find((f) => f.kind === "focus-obscured")!.unscored), /Accessibility was not measured on this scan/);
    assert.match(String(r.findings.find((f) => f.kind === "page-overflow-x")!.unscored), /Phone was not measured/);
    const visual = cat(["text-invisible", "serious"], ["image-broken", "moderate"]);
    assert.equal(r.score.value, mean({ visual, races: 85 }, { visual: 25, reliability: 15, races: 5 }));
  });
  it("treats the JavaScript size as a note, and errors from refused files as not scored", () => {
    const js: RawFinding = { kind: "js-heavy", selector: "", box: null, measured: "1.40 MB of JavaScript", detail: { severity: "minor", count: 1, bytes: 1_400_000 } };
    const err: RawFinding = { kind: "js-error", selector: "", box: null, measured: "TypeError", detail: { severity: "moderate", count: 2 } };
    const s = scan({ views: [view("desktop", [], [js, err]), view("phone", []), view("phone-dark", [])] });
    s.views[0].metrics.skippedHosts = 2;
    const r = buildReport(target, ids, s, { withGenClass: false });
    assert.equal(r.findings.find((f) => f.kind === "js-heavy")!.unscored, JS_NOTE);
    assert.equal(r.findings.find((f) => f.kind === "js-error")!.unscored, REFUSED_NOTE);
    assert.equal(r.score.value, mean({ races: 85 }), "only the double submit is scored");
  });
  it("adds the missing viewport meta tag from a phone view laid out wider than the phone", () => {
    const s = scan();
    s.views[1] = { ...s.views[1], width: 980, checks: { viewportMeta: false, viewport: [980, 2000] } };
    const f = buildReport(target, ids, s, { withGenClass: false }).findings.find((x) => x.kind === "viewport-meta-missing")!;
    assert.match(f.measured, /no viewport meta tag, so a phone lays it out 980 px wide/);
    assert.deepEqual([f.category, f.severity, f.views], ["phone", "serious", ["phone"]]);
  });
  it("puts sideways scrolling seen on the desktop only among the visual bugs", () => {
    assert.equal(categoryOf("page-overflow-x", ["desktop"]), "visual");
    assert.equal(categoryOf("page-overflow-x", ["desktop", "phone-dark"]), "phone");
  });
});

describe("race findings and fixes", () => {
  it("a double click with two identical requests is a finding; one request is not", () => {
    assert.equal(probeFindings(probe("observe", 2, 2)).length, 1);
    assert.equal(probeFindings(probe("observe", 2, 1)).length, 0);
    assert.equal(probeFindings(probe("observe", 1, 1)).length, 0);
  });
  it("GenClass detections become findings, one per diagnosis and subject", () => {
    const d = { id: "d1", trigger: "delivery", subject: "GET /api/search", diagnosis: "stale", p: 0.97, action: "discard", ran: "deliver", executed: false, latencyMs: 120 };
    const f = probeFindings(probe("observe", 0, 0, [], [d, { ...d, id: "d2" }]));
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, "genclass-detection");
  });
  it("fixed only when guard sent fewer (but some), none identical, and GenClass acted on the clicked request", () => {
    const dup = probeFindings(probe("observe", 2, 2))[0];
    assert.ok(raceFix(dup, probe("observe", 2, 2), probe("guard", 1, 1, COALESCE, DUP_ORDERS)));
    assert.equal(raceFix(dup, probe("observe", 2, 2), probe("guard", 1, 1, [], DUP_ORDERS)), null, "fewer requests without a GenClass action is not a GenClass fix");
    assert.equal(raceFix(dup, probe("observe", 2, 2), probe("guard", 2, 2, COALESCE, DUP_ORDERS)), null, "an action that did not change the count is not a fix");
    assert.equal(raceFix(dup, probe("observe", 2, 2), probe("guard", 0, 0, COALESCE, DUP_ORDERS)), null, "nothing sent at all is not a merge");
    assert.equal(raceFix(dup, probe("observe", 2, 2), probe("guard", 1, 1, COALESCE, [])), null, "an action with no decision on record is not tied to the click");
    const elsewhere = [{ ...DUP_ORDERS[0], subject: "GET /api/me (#2)" }];
    assert.equal(raceFix(dup, probe("observe", 2, 2), probe("guard", 1, 1, COALESCE, elsewhere)), null, "an action on another request is not a fix for this one");
    assert.equal(raceFix(dup, probe("observe", 2, 2), null), null);
  });
  it("the guard comparison is marked as GenClass's doing only when that action exists", () => {
    const acted = buildReport(target, ids, scan(), { withGenClass: false });
    assert.equal(acted.probe.guardClick.acted, true);
    assert.match(String(acted.probe.guardClick.how), /1 sent instead of 2/);
    const fewerByItself = buildReport(target, ids, scan({ guard: probe("guard", 1, 1, [], []) }), { withGenClass: false });
    assert.deepEqual(fewerByItself.probe.guardClick, { acted: false, how: null });
  });
  it("matches a GenClass subject to the clicked request by method and path", () => {
    assert.equal(subjectNames("POST /api/orders (#3)", "POST", "shop.example.com/api/orders"), true);
    assert.equal(subjectNames("POST /api/orders?x=1 (#3)", "POST", "shop.example.com/api/orders"), true);
    assert.equal(subjectNames("POST /api/orders/7 (#3)", "POST", "shop.example.com/api/orders"), false);
    assert.equal(subjectNames("GET /api/orders (#3)", "POST", "shop.example.com/api/orders"), false);
  });
  it("a duplicate GET from GenClass counts as minor and says it creates nothing; a duplicate write stays serious", () => {
    const get: RawFinding = { kind: "genclass-detection", selector: "GET /api/me (#2)", measured: "", detail: { diagnosis: "duplicate", subject: "GET /api/me (#2)" } };
    const post: RawFinding = { kind: "genclass-detection", selector: "POST /api/orders (#3)", measured: "", detail: { diagnosis: "duplicate", subject: "POST /api/orders (#3)" } };
    assert.equal(severityOf(get), "minor");
    assert.equal(severityOf(post), "serious");
    assert.doesNotMatch(words(get).why, /duplicate records/);
    assert.match(words(post).why, /duplicate records/);
    assert.match(suggestFix(get), /in-flight request/);
  });
});

describe("data from the page is validated before it is stored or shown", () => {
  it("accepts only the catalog's own kinds", () => {
    for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty", "nope"]) assert.equal(sanitizeFinding({ kind, selector: "x", measured: "y" }), null, kind);
    assert.equal(sanitizeFinding(null), null);
    assert.equal(sanitizeFinding("text-invisible"), null);
    for (const kind of VISUAL_KINDS) assert.ok(sanitizeFinding({ kind, selector: "x", measured: "y" }), kind);
  });
  it("cuts strings and arrays, keeps a numeric box and short primitive details only", () => {
    const f = sanitizeFinding({
      kind: "text-invisible", selector: "p".repeat(5000), measured: "m".repeat(5000), box: { x: 1, y: 2, w: 3, h: "4" },
      detail: { fg: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], bg: [255, 255, 255], sample: "s".repeat(900), nested: { a: 1 }, "bad key": 1, n: Number.NaN, ok: true },
    })!;
    assert.equal(f.selector.length, 200);
    assert.equal(f.measured.length, 240);
    assert.equal(f.box, null, "a box with a non-number is dropped");
    assert.equal((f.detail!.fg as number[]).length, 8);
    assert.equal((f.detail!.sample as string).length, 200);
    assert.deepEqual(Object.keys(f.detail!).sort(), ["bg", "fg", "ok", "sample"]);
  });
  it("keeps only numeric page statistics", () => {
    assert.deepEqual(sanitizeStats({ passes: 2, partial: 0, viewport: [390, 844], viewportMeta: true, docHeight: 1800, visibility: "visible", evil: "<b>x</b>", ms: Number.NaN }), {
      passes: 2, partial: 0, docHeight: 1800, viewport: [390, 844], viewportMeta: true,
    });
  });
});

describe("the guard setting in words", () => {
  it("names the default plainly and a demo setting as one", () => {
    assert.equal(guardSetting("balanced", null, 900), "GenClass in guard mode with its default settings, holding requests for up to 900 ms while it decides");
    assert.match(guardSetting("eager", 0, 900), /demo setting .* \(not the default\)/);
  });
});

describe("the catalog", () => {
  it("maps every visual kind to a category and a severity", () => {
    for (const k of VISUAL_KINDS) {
      assert.ok(KINDS[k], k);
      assert.ok(["visual", "accessibility", "phone", "speed"].includes(KINDS[k].category), k);
      assert.equal(KINDS[k].source, "visual", k);
    }
  });
  it("reads the severity the check measured on the four-level scale, else the kind's", () => {
    assert.equal(severityOf({ kind: "image-broken", selector: "img", measured: "", detail: { severity: "high" } }), "serious");
    assert.equal(severityOf({ kind: "image-broken", selector: "img", measured: "", detail: { severity: "low" } }), "minor");
    assert.equal(severityOf({ kind: "page-blank", selector: "main", measured: "", detail: { severity: "high" } }), "critical", "a blank page is critical");
    assert.equal(severityOf({ kind: "page-blank", selector: "main", measured: "", detail: { severity: "medium" } }), "moderate");
    assert.equal(severityOf({ kind: "tap-target-small", selector: "a", measured: "", detail: { severity: "serious" } }), "serious", "an audit carries its own");
    assert.equal(severityOf({ kind: "tap-target-small", selector: "a", measured: "", detail: { severity: "high" } }), "serious", "not the visual scale");
    assert.equal(severityOf({ kind: "image-broken", selector: "img", measured: "", detail: { severity: "fatal" } }), "moderate");
    assert.equal(severityOf({ kind: "image-broken", selector: "img", measured: "", detail: { severity: "constructor" } }), "moderate");
  });
});

describe("suggested fixes", () => {
  it("are the check's own CSS, its note and its fix text, else a fix for the kind", () => {
    assert.equal(suggestFix({ kind: "text-invisible", selector: "p", measured: "", detail: { css: "p { color: #767676; }", cssNote: "reaches 4.5:1" } }), "p { color: #767676; }\nReaches 4.5:1.");
    assert.equal(suggestFix({ kind: "stylesheet-failed", selector: "link", measured: "", detail: { fixText: "correct the URL" } }), "Correct the URL.");
    assert.match(suggestFix({ kind: "viewport-meta-missing", selector: "html", measured: "" }), /name="viewport"/);
  });
});

describe("guard held back", () => {
  it("says the duplicate was flagged and held back at the default safety margin, with the measured gain", () => {
    const held = [{ id: "d1", trigger: "request", subject: "POST /api/orders (#3)", diagnosis: "duplicate", p: 0.99, action: "none", ran: "none", executed: false, latencyMs: 200, candidate: "coalesce", gain: 2.84, margin: 4 }];
    const dup: RawFinding = { kind: "duplicate-submit", selector: "button.cta", measured: "", detail: {} };
    const text = heldBack(dup, probe("observe", 2, 2), probe("guard", 2, 2, [], held), true)!;
    assert.match(text, /^Flagged, held back at the default safety margin/);
    assert.match(text, /99% sure/);
    assert.match(text, /expected gain of 2\.84 against a margin of 4/);
    assert.equal(heldBack(dup, probe("observe", 2, 2), probe("guard", 1, 1, COALESCE, DUP_ORDERS), true), null, "not when guard acted");
    const r = buildReport(target, ids, scan({ guard: probe("guard", 2, 2, [], held) }), { withGenClass: true });
    assert.match(r.findings.find((f) => f.kind === "duplicate-submit")!.genclass.text, /held back at the default safety margin/);
  });
});

describe("review fixes for the launch: race words", () => {
  const stale = (subject: string) => ({ kind: "genclass-detection" as const, selector: subject, measured: "", detail: { diagnosis: "stale", subject } });
  const discard = (subject: string, id = "x1") => ({ id, decisionId: `d-${id}`, action: "discard", trigger: "delivery", subject, ok: true, changed: "Dropped the late response.", late: false });
  it("counts a late response as fixed only for guard's own recorded action on that same request", () => {
    const g = (acts: ProbeResult["acts"], detections: ProbeResult["detections"] = []) => probe("guard", 0, 0, acts, detections);
    assert.equal(raceFix(stale(""), null, g([discard("")])), null, "never for an unnamed subject");
    assert.equal(raceFix(stale("response to GET /api/search?q=a (#7)"), null, g([discard("response to GET /api/other (#7)")])), null, "not for another request");
    const fixed = raceFix(stale("response to GET /api/search?q=a (#7)"), null, g([discard("response to GET /api/search?q=a (#9)")]));
    assert.ok(fixed, "the same request, numbered apart in the guard page");
    assert.equal(fixed!.how, "GenClass guard ran discard on the response to GET /api/search?q=a (its recorded action: Dropped the late response).");
    const still = [{ id: "d-y", trigger: "delivery", subject: "response to GET /api/search?q=a (#11)", diagnosis: "stale", p: 0.9, action: "none", ran: "none", executed: false, latencyMs: 100 }];
    assert.equal(raceFix(stale("response to GET /api/search?q=a (#7)"), null, g([discard("response to GET /api/search?q=a (#9)")], still)), null, "not while guard left another late response to it alone");
  });
  it("says what the held-back double click sent, from the guard pass's own counts, with the right article", () => {
    const held = (diagnosis: string) => [{ id: "d1", trigger: "request", subject: "POST /api/orders (#3)", diagnosis, p: 0.99, action: "none", ran: "none", executed: false, latencyMs: 200, candidate: "coalesce", gain: 2.84, margin: 4 }];
    const dup: RawFinding = { kind: "duplicate-submit", selector: "button.cta", measured: "", detail: {} };
    const two = heldBack(dup, probe("observe", 2, 2), probe("guard", 2, 2, [], held("duplicate")), true)!;
    assert.match(two, /so it did not act: the page sent 2 identical requests \(the scanner answered them; none reached the site\)\./);
    assert.doesNotMatch(two, /both requests went out/);
    const three = heldBack(dup, probe("observe", 3, 3), probe("guard", 3, 3, [], held("duplicate")), true)!;
    assert.match(three, /the page sent 3 identical requests/);
    const inc: RawFinding = { kind: "genclass-detection", selector: "POST /api/orders (#3)", measured: "", detail: { diagnosis: "inconsistent", subject: "POST /api/orders (#3)" } };
    assert.match(heldBack(inc, probe("observe", 0, 0), probe("guard", 0, 0, [], held("inconsistent")), true)!, /sure this was an inconsistency, but/);
  });
  it("names the re-check in the with-GenClass note only when one ran", () => {
    const none = buildReport(target, ids, scan(), { withGenClass: true });
    assert.doesNotMatch(none.withGenClass.note, /second set of the same checks re-measured/);
    assert.match(none.withGenClass.note, /no re-check ran/);
    const rechecked = buildReport(target, ids, scan({ views: scan().views.map((v) => (v.id === "desktop" ? { ...v, fixes: fixedIn("text-invisible|p.note|") } : v)) }), { withGenClass: true });
    assert.match(rechecked.withGenClass.note, /second set of the same checks re-measured the page/);
    assert.match(rechecked.withGenClass.note, /runtime 0\.2\.1 in guard mode/);
  });
});

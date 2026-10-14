// The score formula (caps per category, deterministic) and the report: findings merged across views, numbered in a
// fixed order, race findings from the probe, and "fixed" only when the guard re-run or the visual re-check in every
// view measured it gone.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RawFinding } from "../src/catalog.ts";
import { describe as words, KINDS, sanitizeFinding, sanitizeStats, severityOf, suggestFix, VISUAL_KINDS } from "../src/catalog.ts";
import { buildReport, guardSetting, heldBack, probeFindings, raceFix, subjectNames } from "../src/report.ts";
import type { ProbeResult, ScanResult, ViewResult, VisualFixes } from "../src/scan.ts";
import { score, SEVERITY_POINTS } from "../src/score.ts";
import { normaliseTarget, type Target } from "../src/target.ts";

describe("score: 100 minus capped, weighted findings", () => {
  it("weights by severity and caps each category at 25", () => {
    assert.equal(score([]).value, 100);
    assert.equal(score([{ category: "readability", severity: "high" }]).value, 100 - SEVERITY_POINTS.high);
    const many = Array.from({ length: 30 }, () => ({ category: "readability" as const, severity: "high" as const }));
    const s = score(many);
    assert.equal(s.value, 75, "one noisy category cannot take more than 25");
    assert.equal(s.categories.find((c) => c.id === "readability")!.raw, 300);
    const all = (["readability", "media", "layout", "interaction"] as const).flatMap((c) => Array.from({ length: 5 }, () => ({ category: c, severity: "high" as const })));
    assert.equal(score(all).value, 0);
    assert.equal(score([{ category: "media", severity: "medium" }, { category: "layout", severity: "low" }]).value, 93);
  });
  it("is the same for the same findings in any order", () => {
    const f = [{ category: "media" as const, severity: "medium" as const }, { category: "layout" as const, severity: "high" as const }, { category: "media" as const, severity: "low" as const }];
    assert.deepEqual(score(f), score([...f].reverse()));
  });
});

const target = normaliseTarget("shop.example.com/") as Target;
const view = (id: ViewResult["id"], findings: RawFinding[]): ViewResult => ({
  id, label: id, width: id === "desktop" ? 1366 : 390, height: 800, ok: true, status: 200, finalUrl: target.url, ms: 10, notes: [], findings,
  checks: {}, fixes: null, shot: new Uint8Array([1]), shotHeight: 1600, standIns: { count: 0, requests: [] },
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
const ids = { id: "abc123def", key: "0".repeat(32), at: new Date("2026-10-13T12:00:00Z"), runtime: "0.2.1", guardHoldMs: 900, shotUrl: (v: string) => `/api/scan/shot/${"0".repeat(32)}/abc123def-${v}.jpg` };

describe("buildReport", () => {
  it("merges the same element across views, numbers findings most serious first", () => {
    const r = buildReport(target, ids, scan(), { withGenClass: false });
    const kinds = r.findings.map((f) => f.kind);
    assert.deepEqual(kinds, ["text-invisible", "page-overflow-x", "duplicate-submit", "image-broken"]);
    assert.deepEqual(r.findings.map((f) => f.n), [1, 2, 3, 4]);
    assert.deepEqual(r.findings[0].views, ["desktop", "phone"]);
    assert.deepEqual(Object.keys(r.findings[0].boxes), ["desktop", "phone"]);
    assert.equal(r.score.value, 100 - 10 - 10 - 10 - 5);
    assert.equal(r.views[0].shot, ids.shotUrl("desktop"));
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
    assert.equal(on.withGenClass.value, on.score.value + 10);
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
    assert.equal(r2.withGenClass.value, r2.score.value + 10 + 10);
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
    const views = (count: number) => [
      { ...view("desktop", [leak, contrastF("p.note")]), standIns: { count, requests: count ? ["POST shop.example.com/graphql"] : [] } },
      { ...view("phone", [leak]), standIns: { count, requests: [] } },
      view("phone-dark", []),
    ];
    const withStandIns = buildReport(target, ids, scan({ views: views(2), probe: null, guard: null }), { withGenClass: false });
    const f = withStandIns.findings.find((x) => x.kind === "text-template-leak")!;
    assert.match(String(f.unscored), /stand-in answer/);
    assert.equal(withStandIns.score.value, 90, "only the contrast finding is scored");
    assert.equal(withStandIns.views[0].standIns, 2);
    const without = buildReport(target, ids, scan({ views: views(0), probe: null, guard: null }), { withGenClass: false });
    assert.equal(without.findings.find((x) => x.kind === "text-template-leak")!.unscored, null);
    assert.equal(without.score.value, 80);
    // the same leak also seen in a view that got no stand-in answer is scored
    const mixed = views(1);
    mixed[1] = { ...mixed[1], standIns: { count: 0, requests: [] } };
    assert.equal(buildReport(target, ids, scan({ views: mixed, probe: null, guard: null }), { withGenClass: false }).findings.find((x) => x.kind === "text-template-leak")!.unscored, null);
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
  it("a duplicate GET from GenClass counts as low and says it creates nothing; a duplicate write stays high", () => {
    const get: RawFinding = { kind: "genclass-detection", selector: "GET /api/me (#2)", measured: "", detail: { diagnosis: "duplicate", subject: "GET /api/me (#2)" } };
    const post: RawFinding = { kind: "genclass-detection", selector: "POST /api/orders (#3)", measured: "", detail: { diagnosis: "duplicate", subject: "POST /api/orders (#3)" } };
    assert.equal(severityOf(get), "low");
    assert.equal(severityOf(post), "high");
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
      assert.ok(["readability", "media", "layout", "interaction"].includes(KINDS[k].category), k);
    }
  });
  it("uses the severity the check measured, else the kind's", () => {
    assert.equal(severityOf({ kind: "image-broken", selector: "img", measured: "", detail: { severity: "high" } }), "high");
    assert.equal(severityOf({ kind: "image-broken", selector: "img", measured: "", detail: { severity: "fatal" } }), "medium");
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

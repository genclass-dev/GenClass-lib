// The score formula (caps per category, deterministic) and the report: findings merged across views, numbered in a
// fixed order, race findings from the probe, and "fixed" only when the guard re-run measured it gone.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RawFinding } from "../src/catalog.ts";
import { contrast, suggestFix } from "../src/catalog.ts";
import { buildReport, probeFindings, raceFix } from "../src/report.ts";
import type { ProbeResult, ScanResult, ViewResult } from "../src/scan.ts";
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
  checks: null, shot: new Uint8Array([1]), shotHeight: 1600,
});
const probe = (mode: "observe" | "guard", sent: number, identical: number, acts: ProbeResult["acts"] = [], detections: ProbeResult["detections"] = []): ProbeResult => ({
  mode, ran: true, model: { state: "ready", device: "wasm", variant: "q8", loadMs: 3000, waitedMs: 3000, error: null, version: "x" }, runtimeError: null, holdBudgetMs: 900, visibility: "visible",
  typed: null, clicked: { target: "button.cta", label: "Buy", formMethod: "post", sent, identical, requests: [{ method: "POST", path: "shop.example.com/api/orders" }] },
  detections, acts, aborted: 0, answeredLocally: sent, ms: 100,
});
const contrastF = (sel: string): RawFinding => ({ kind: "low-contrast", selector: sel, box: { x: 10, y: 20, w: 100, h: 18 }, measured: "Contrast 1.10:1", detail: { fg: [250, 250, 250], bg: [255, 255, 255] } });
const scan = (o: Partial<ScanResult> = {}): ScanResult => ({
  views: [
    view("desktop", [contrastF("p.note"), { kind: "broken-image", selector: "img.hero", box: { x: 0, y: 0, w: 10, h: 10 }, measured: "Failed", detail: { src: "/a.png" } }]),
    view("phone", [contrastF("p.note"), { kind: "horizontal-overflow", selector: "div.wide", box: { x: 0, y: 0, w: 500, h: 10 }, measured: "Page is 500 px", detail: { tag: "div" } }]),
    view("phone-dark", []),
  ],
  probe: probe("observe", 2, 2),
  guard: probe("guard", 1, 1, [{ id: "a1", decisionId: "d1", action: "coalesce", trigger: "request", subject: "POST /api/orders", ok: true, changed: "reused the first response", late: false }]),
  visualFixes: { available: false, fixed: [], rechecked: false },
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
    assert.deepEqual(kinds, ["low-contrast", "horizontal-overflow", "duplicate-submit", "broken-image"]);
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
  it("never counts a visual finding as fixed without a re-check", () => {
    const on = buildReport(target, ids, scan(), { withGenClass: true });
    for (const f of on.findings) if (f.kind !== "duplicate-submit") assert.equal(f.fixed, null, f.kind);
    const claimed = buildReport(target, ids, scan({ visualFixes: { available: true, fixed: [{ kind: "low-contrast", selector: "p.note", how: "recoloured" }], rechecked: false } }), { withGenClass: true });
    assert.equal(claimed.findings.find((f) => f.kind === "low-contrast")!.fixed, null);
    const rechecked = buildReport(target, ids, scan({ visualFixes: { available: true, fixed: [{ kind: "low-contrast", selector: "p.note", how: "recoloured" }], rechecked: true } }), { withGenClass: true });
    assert.equal(rechecked.findings.find((f) => f.kind === "low-contrast")!.fixed!.how, "recoloured");
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
  it("fixed only when guard sent fewer, none identical, and GenClass acted", () => {
    const dup = probeFindings(probe("observe", 2, 2))[0];
    const coalesce = [{ id: "a1", decisionId: "d1", action: "coalesce", trigger: "request", subject: "POST /api/orders", ok: true, changed: "x", late: false }];
    assert.ok(raceFix(dup, probe("observe", 2, 2), probe("guard", 1, 1, coalesce)));
    assert.equal(raceFix(dup, probe("observe", 2, 2), probe("guard", 1, 1, [])), null, "fewer requests without a GenClass action is not a GenClass fix");
    assert.equal(raceFix(dup, probe("observe", 2, 2), probe("guard", 2, 2, coalesce)), null, "an action that did not change the count is not a fix");
    assert.equal(raceFix(dup, probe("observe", 2, 2), null), null);
  });
});

describe("suggested fixes", () => {
  it("the contrast fix itself passes 4.5:1 on the measured background", () => {
    for (const bg of [[255, 255, 255], [18, 18, 18], [14, 31, 77], [240, 69, 28]]) {
      const fix = suggestFix({ kind: "low-contrast", selector: "p", measured: "", detail: { bg } });
      const ink = /color: #([0-9a-f]{6})/.exec(fix)![1];
      const rgb = [0, 2, 4].map((i) => parseInt(ink.slice(i, i + 2), 16));
      assert.ok(contrast(rgb, bg) >= 4.5, `${fix} on ${bg}`);
    }
  });
  it("overflow fixes match the element", () => {
    assert.match(suggestFix({ kind: "horizontal-overflow", selector: "img.x", measured: "", detail: { tag: "img" } }), /max-width: 100%; height: auto/);
    assert.match(suggestFix({ kind: "horizontal-overflow", selector: "pre", measured: "", detail: { tag: "pre" } }), /overflow-x: auto/);
  });
});

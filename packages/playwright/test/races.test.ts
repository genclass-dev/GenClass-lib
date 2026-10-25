// The race-file builder (src/races.ts): what the fixture collected -> a "genclass-races/1" file the reporter's own
// validator accepts, with the signatures the summariser groups on.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRacesFile, opOf, racesFileName, signaturesOf, witnessLine, writeRacesFile } from "../src/races.js";
import { parseRaces, validateRaces } from "../src/schema.js";
import { buildSummary } from "../src/summarize.js";

const detection = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  kind: "detection",
  id: "s1",
  ts: 1,
  sessionId: "x",
  tags: {},
  mode: "observe",
  sampled: true,
  trigger: "delivery",
  diagnosis: "stale",
  p: 0.91,
  detection: "likely",
  evidence: { message: "The response of GET /api/search (#21) arrives after a newer GET /api/search (#23) was answered.", subject: "response to GET /api/search?q=… (#21)" },
  ...over,
});
const overwrote = { kind: "overwrote-newer", t: 1200, subject: "search.results", by: "GET /api/search#1", over: "GET /api/search#4", overKind: "request", gapMs: 260, change: "2 items → 2 items" };
const identical = { kind: "identical-in-flight", t: 900, subject: "POST /api/orders", by: "POST /api/orders#2", over: "POST /api/orders#1", overKind: "request", gapMs: 30 };

describe("races: operations and evidence lines", () => {
  it("opOf keeps the method and path, drops the query, the id and the suffix", () => {
    expect(opOf("response to GET /api/search?q=… (#21)")).toBe("GET /api/search");
    expect(opOf("GET /api/search#3~retry2")).toBe("GET /api/search");
    expect(opOf("POST /api/orders (network error)")).toBe("POST /api/orders");
    expect(opOf("write to cart.items")).toBe("write to cart.items");
    expect(opOf(undefined)).toBe("");
    expect(opOf(`x${"y".repeat(200)}`)).toHaveLength(120);
  });

  it("witnessLine says what happened, in the agent's request keys", () => {
    expect(witnessLine(overwrote)).toBe("The response of GET /api/search#1 wrote search.results over what newer GET /api/search#4 had written 0.26s after GET /api/search#1 started (2 items → 2 items).");
    expect(witnessLine({ ...overwrote, overKind: "user", over: 'type textbox "Title"', change: undefined })).toBe('The response of GET /api/search#1 wrote search.results over what the user (type textbox "Title") had written 0.26s after GET /api/search#1 started.');
    expect(witnessLine(identical)).toBe("POST /api/orders#2 was sent while the identical POST /api/orders#1 was still in flight (0.03s earlier), from a separate user action.");
    expect(witnessLine({ kind: "other", by: "A", over: "B" })).toBe("other:  by A over B");
  });
});

describe("races: signatures and the file", () => {
  it("detections become signatures with the model's confidence; witnesses get trigger witness and confidence 1", () => {
    const sigs = signaturesOf([detection()], [overwrote, identical], 3);
    expect(sigs.map((s) => s.sig)).toEqual(["delivery|stale|GET /api/search", "witness|identical-in-flight|POST /api/orders", "witness|overwrote-newer|GET /api/search"]);
    expect(sigs[0]).toMatchObject({ trigger: "delivery", diagnosis: "stale", op: "GET /api/search", confidence: 0.91, seeds: [3] });
    expect(sigs[0].evidence).toContain("arrives after a newer");
    expect(sigs[2]).toMatchObject({ trigger: "witness", diagnosis: "overwrote-newer", op: "GET /api/search", confidence: 1, seeds: [3] });
  });

  it("drops expected diagnoses, records of other kinds and junk; merges repeats keeping the most confident evidence", () => {
    const sigs = signaturesOf(
      [detection({ diagnosis: "expected" }), detection({ kind: "intervention" }), null, 5, detection({ p: 0.5, evidence: { message: "low", subject: "GET /api/search" } }), detection({ p: 0.95, evidence: { message: "high", subject: "GET /api/search" } }), detection({ p: 2 })],
      [overwrote, overwrote, {}, "x"],
      1,
    );
    expect(sigs).toHaveLength(2);
    expect(sigs[0]).toMatchObject({ sig: "delivery|stale|GET /api/search", confidence: 1, evidence: "The response of GET /api/search (#21) arrives after a newer GET /api/search (#23) was answered." });
    expect(sigs[1].sig).toBe("witness|overwrote-newer|GET /api/search");
  });

  it("buildRacesFile validates against the reporter's schema and carries mode, model, chaos and the seed", () => {
    const file = buildRacesFile({
      test: "search.spec.ts > search > results of the last query",
      seed: 2,
      mode: "observe",
      model: { state: "off", name: "none" },
      chaos: { latencyMs: [0, 600], reorder: true, routes: ["same-origin /api* or JSON responses"] },
      records: [detection()],
      witnesses: [overwrote],
    });
    const r = validateRaces(file);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file).toEqual(file);
    expect(file.model).toEqual({ state: "off", name: "none" });
    expect(file.chaos).toEqual({ latencyMs: [0, 600], reorder: true, routes: ["same-origin /api* or JSON responses"] });
    const s = buildSummary([{ name: "a.json", content: file }]);
    expect(s.tests[0].signatures.map((x) => [x.category, x.sig])).toEqual([
      ["stale", "delivery|stale|GET /api/search"],
      ["witness", "witness|overwrote-newer|GET /api/search"],
    ]);
  });

  it("a page where GenClass never started: model null, no mode, no signatures (still a valid file)", () => {
    const file = buildRacesFile({ test: "t", seed: 1, mode: null, model: null, chaos: null, records: [], witnesses: [] });
    expect(file).toEqual({ schema: "genclass-races/1", test: "t", seed: 1, signatures: [], model: null, chaos: null });
    expect(validateRaces(file).ok).toBe(true);
    expect(buildSummary([{ name: "a.json", content: file }]).tests[0].modelNotReady).toEqual({ files: 1, states: ["not started"] });
  });

  it("racesFileName: a slug of the title, the test id and the seed", () => {
    expect(racesFileName("[chromium] checkout.spec.ts > checkout > places one order", "a1b2-c3d4", 2)).toBe("chromium-checkout-spec-ts-checkout-places-one-order-a1b2-c3d4-s2.json");
    expect(racesFileName("x".repeat(200), "id", 1)).toBe(`${"x".repeat(80)}-id-s1.json`);
    expect(racesFileName("", "../../etc", 1)).toBe("test-etc-s1.json");
  });
});

describe("races: writing", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "genclass-races-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a file the reporter reads, creating the directory", () => {
    const file = buildRacesFile({ test: "t", seed: 4, mode: "observe", model: { state: "off" }, chaos: null, records: [], witnesses: [identical] });
    const path = writeRacesFile(join(dir, "test-results", "genclass"), racesFileName(file.test, "id", 4), file);
    expect(path).toBe(join(dir, "test-results", "genclass", "t-id-s4.json"));
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const r = parseRaces(text);
    expect(r.ok && r.file).toEqual(file);
  });
});

// The report with the fixture's witness signatures (trigger "witness"): their own group, shown only when there are
// any, no confidence on their lines, a footer that says what they are, and no "model not ready" note for a model
// that was off by choice. The model-only report (test/summarize.test.ts, README) is unchanged by all of it.

import { describe, expect, it } from "vitest";
import { CATEGORIES, CATEGORY_TITLES, WITNESS_TRIGGER, buildSummary, categoryOf, summarize } from "../src/summarize.js";
import type { GenClassRacesFile, RaceSignature } from "../src/types.js";
import { FIXTURE_REPORT, fixtureInputs } from "./helpers.js";

const witness = (op: string, seed: number, kind = "overwrote-newer"): RaceSignature => ({
  sig: `witness|${kind}|${op}`,
  trigger: WITNESS_TRIGGER,
  diagnosis: kind,
  op,
  confidence: 1,
  evidence: `The response of ${op}#1 wrote results over what newer ${op}#4 had written 0.26s after ${op}#1 started.`,
  seeds: [seed],
});
const model = (op: string, seed: number): RaceSignature => ({ sig: `delivery|stale|${op}`, trigger: "delivery", diagnosis: "stale", op, confidence: 0.91, evidence: "the model's line", seeds: [seed] });
const fixture = { model: "skip" as const, agent: null, chaosApplied: 4, serviceWorker: false };
const file = (test: string, seed: number, signatures: RaceSignature[], extra: Partial<GenClassRacesFile> = {}): GenClassRacesFile => ({ schema: "genclass-races/1", test, seed, signatures, mode: "observe", model: { state: "off", name: "none" }, fixture, ...extra });

describe("witnesses: grouping", () => {
  it("categoryOf puts trigger witness in its own group whatever the label, and the group is last", () => {
    expect(categoryOf("overwrote-newer", "witness")).toBe("witness");
    expect(categoryOf("stale", "witness")).toBe("witness");
    expect(categoryOf("stale")).toBe("stale");
    expect(categoryOf("overwrote-newer")).toBe("other");
    expect(CATEGORIES[CATEGORIES.length - 1]).toBe("witness");
    expect(CATEGORY_TITLES.witness).toBe("Witnesses (facts measured without the model)");
  });

  it("the model-only report is byte for byte what it was: no witness row, no witness sentence", () => {
    const md = summarize(fixtureInputs(), { sources: ["test-results/genclass"] });
    expect(md).toBe(FIXTURE_REPORT);
    expect(md).not.toContain("Witnesses");
  });
});

describe("witnesses: the report", () => {
  it("a witness-only report: the row, the group, no confidence, reproducible across seeds, the witness footer only", () => {
    const md = summarize([
      { name: "a-1.json", content: file("search.spec.ts > search", 1, [witness("GET /api/search", 1)]) },
      { name: "a-2.json", content: file("search.spec.ts > search", 2, [witness("GET /api/search", 2), witness("POST /api/orders", 2, "identical-in-flight")]) },
      { name: "b-1.json", content: file("quiet.spec.ts > quiet", 1, []) },
    ]);
    expect(md).toContain("**2 signatures** in 1 test, **1 reproducible** (flagged in 2 or more seeds of the same test) · 3 files read · mode observe\n");
    expect(md).toContain("| Other detections | 0 | 0 |\n| Witnesses (facts measured without the model) | 2 | 1 |\n");
    expect(md).toContain("**Witnesses (facts measured without the model)**\n\n- **Reproducible**: 2 of 2 seeds (1, 2) · `GET /api/search` · `witness:overwrote-newer`\n  > The response of GET /api/search#​1 wrote results");
    expect(md).toContain("- 1 of 2 seeds (2) · `POST /api/orders` · `witness:identical-in-flight`\n");
    expect(md).not.toContain("· confidence");
    expect(md).not.toContain("diagnosis by GenClass's on-device model");
    expect(md).toContain('\n---\n\nLines under "Witnesses (facts measured without the model)" are happens-before facts the runtime measured in the page without the model');
    expect(md).toContain("They carry no confidence: a fact is listed when it happened. Reproducible: seen in 2 or more seeds of the same test.");
    // the model was off by choice: no "not ready" note for the quiet test
    expect(md).toContain("- quiet.spec.ts > quiet (1 seed: 1)\n");
    expect(md).not.toContain("not ready");
  });

  it("model detections and witnesses together: both groups, both footer paragraphs, in that order", () => {
    const md = summarize([{ name: "a.json", content: file("t", 1, [witness("GET /api/search", 1), model("GET /api/search", 1)], { model: { state: "ready" } }) }]);
    expect(md).toContain("| Stale responses | 1 | 0 |");
    expect(md).toContain("| Witnesses (facts measured without the model) | 1 | 0 |");
    expect(md.indexOf("**Stale responses**")).toBeLessThan(md.indexOf("**Witnesses (facts measured without the model)**"));
    expect(md).toContain("`delivery:stale` · confidence 0.91\n");
    expect(md).toContain("`witness:overwrote-newer`\n");
    const footer = md.slice(md.lastIndexOf("\n---\n"));
    expect(footer.indexOf("Each line is a diagnosis by GenClass's on-device model")).toBeGreaterThan(0);
    expect(footer.indexOf("Lines under")).toBeGreaterThan(footer.indexOf("Each line is a diagnosis"));
    expect(footer.split("\n\n")).toHaveLength(3);
  });

  it("model notes: a fixture file with model skip gets none; a model-only file with state off still does", () => {
    const s = buildSummary([
      { name: "a.json", content: file("t", 1, []) },
      { name: "b.json", content: file("t", 2, [], { model: { state: "loading" }, fixture: { ...fixture, model: "load" } }) },
      { name: "c.json", content: { schema: "genclass-races/1", test: "u", seed: 1, signatures: [], model: { state: "off" } } },
    ]);
    const [t, u] = [s.tests.find((x) => x.test === "t")!, s.tests.find((x) => x.test === "u")!];
    expect(t.modelNotReady).toEqual({ files: 1, states: ["loading"] });
    expect(u.modelNotReady).toEqual({ files: 1, states: ["off"] });
    expect(s.totals.byCategory.witness).toEqual({ signatures: 0, reproducible: 0 });
  });

  it("notes what the fixture could not do: no agent, a service worker, chaos that held nothing", () => {
    const md = summarize([
      { name: "a.json", content: file("quiet", 1, [], { fixture: { ...fixture, agent: "not-loaded" } }) },
      { name: "b.json", content: file("quiet", 2, [], { fixture: { ...fixture, serviceWorker: true, chaosApplied: 0 } }) },
      { name: "c.json", content: file("flagged", 1, [witness("GET /api/search", 1)], { fixture: { ...fixture, chaosApplied: 0 } }) },
      { name: "d.json", content: file("flagged", 2, [], { fixture: { ...fixture, agent: "not-loaded" } }) },
    ]);
    expect(md).toContain("- quiet (2 seeds: 1, 2; not checked in 2 of 2 files (a service worker controlled the page; witnesses not recorded: not-loaded); chaos held no request in 1 of 2 files)\n");
    expect(md).toContain("Note: in 1 of 2 files for this test nothing was flagged and the fixture could not check the page (witnesses not recorded: not-loaded), so those runs may not have been checked.\n");
    expect(md).toContain("Note: in 1 of 2 files for this test chaos was on but held no request (nothing matched its filter, or a route of the test or a service worker answered first).\n");
  });

  it("maxChars keeps witness lines like any other signature", () => {
    const sigs = Array.from({ length: 150 }, (_, i) => witness(`GET /api/r${i}`, 1));
    const md = summarize([{ name: "big.json", content: file("big", 1, sigs) }], { maxChars: 4000 });
    expect(md.length).toBeLessThanOrEqual(4000);
    expect(md).toContain("**150 signatures** in 1 test");
    expect(md).toContain("_Shortened to fit 4000 characters: ");
    expect(md).toContain("`witness:overwrote-newer`");
  });
});

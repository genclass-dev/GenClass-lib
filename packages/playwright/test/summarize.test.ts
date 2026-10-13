// The summariser: genclass-races/1 files -> markdown, asserted byte for byte on the fixture in test/fixtures/races
// (two tests, two seeds each; one signature flagged in both seeds of its test, one in a single seed).

import { describe, expect, it } from "vitest";
import { buildSummary, categoryOf, escapeMarkdown, summarize, REPORT_MARKER } from "../src/summarize.js";
import type { GenClassRacesFile, RaceSignature } from "../src/types.js";
import { FIXTURE_REPORT, fixtureInputs } from "./helpers.js";

function sig(p: Partial<RaceSignature> & Pick<RaceSignature, "trigger" | "diagnosis" | "op">): RaceSignature {
  return { sig: `${p.trigger}|${p.diagnosis}|${p.op}`, confidence: 0.9, evidence: `evidence for ${p.op}`, seeds: [], ...p };
}

function file(test: string, seed: number, signatures: RaceSignature[], extra: Partial<GenClassRacesFile> = {}): GenClassRacesFile {
  return { schema: "genclass-races/1", test, seed, signatures, shadow: "guard", ...extra };
}

describe("summarize: the fixture (two tests, two seeds)", () => {
  it("renders the exact report", () => {
    expect(summarize(fixtureInputs(), { sources: ["test-results/genclass"] })).toBe(FIXTURE_REPORT);
  });

  it("does not depend on the order the files come in", () => {
    expect(summarize(fixtureInputs().reverse(), { sources: ["test-results/genclass"] })).toBe(FIXTURE_REPORT);
  });

  it("accepts parsed values as well as JSON text", () => {
    const parsed = fixtureInputs().map((f) => ({ name: f.name, content: JSON.parse(f.content as string) as unknown }));
    expect(summarize(parsed, { sources: ["test-results/genclass"] })).toBe(FIXTURE_REPORT);
  });

  it("groups by test and by signature: seeds are merged, the most confident evidence is kept", () => {
    const s = buildSummary(fixtureInputs());
    expect(s.files).toBe(4);
    expect(s.skipped).toEqual([]);
    expect(s.tests.map((t) => [t.test, t.seeds, t.files])).toEqual([
      ["checkout.spec.ts > checkout > places one order", [1, 2], 2],
      ["search.spec.ts > search > shows the results of the last query", [1, 2], 2],
    ]);
    const [checkout, search] = s.tests;
    expect(checkout.signatures).toHaveLength(1);
    expect(checkout.signatures[0]).toMatchObject({ sig: "request|duplicate|POST /api/orders", category: "duplicate", confidence: 0.97, seeds: [1, 2], reproducible: true });
    expect(checkout.signatures[0].evidence).toContain("#15");
    expect(search.signatures[0]).toMatchObject({ sig: "delivery|stale|GET /api/search", category: "stale", seeds: [2], reproducible: false });
    expect(s.totals).toEqual({
      tests: 2,
      testsWithSignatures: 2,
      signatures: 2,
      reproducible: 1,
      byCategory: { duplicate: { signatures: 1, reproducible: 1 }, stale: { signatures: 1, reproducible: 0 }, failing: { signatures: 0, reproducible: 0 }, other: { signatures: 0, reproducible: 0 } },
    });
  });

  it("minSeeds changes what counts as reproducible", () => {
    expect(buildSummary(fixtureInputs(), { minSeeds: 3 }).totals.reproducible).toBe(0);
    expect(buildSummary(fixtureInputs(), { minSeeds: 1 }).totals.reproducible).toBe(2);
    expect(buildSummary(fixtureInputs(), { minSeeds: 0 }).minSeeds).toBe(1);
    expect(buildSummary(fixtureInputs(), { minSeeds: Number.NaN }).minSeeds).toBe(2);
    const md = summarize(fixtureInputs(), { minSeeds: 3 });
    expect(md).toContain("**0 reproducible** (flagged in 3 or more seeds of the same test)");
    expect(md).not.toContain("**Reproducible**");
  });
});

describe("summarize: groups, ordering and the other sections", () => {
  it("puts each diagnosis in its group; expected is not a detection", () => {
    expect(["duplicate", "stale", "failing", "transient", "inconsistent", "overload", "my-plugin-label"].map(categoryOf)).toEqual(["duplicate", "stale", "failing", "other", "other", "other", "other"]);
    const md = summarize([
      {
        name: "a.json",
        content: file("orders > retries", 1, [
          sig({ trigger: "failure", diagnosis: "failing", op: "GET /api/status", confidence: 0.88, evidence: "This is the 3rd GET /api/status failure in a row.", seeds: [1] }),
          sig({ trigger: "failure", diagnosis: "transient", op: "POST /api/orders", confidence: 0.8, seeds: [1] }),
          sig({ trigger: "delivery", diagnosis: "expected", op: "GET /api/items", seeds: [1] }),
        ]),
      },
    ]);
    expect(md).toContain("**Failing endpoints**\n\n- 1 of 1 seed (1) · `GET /api/status` · `failure:failing` · confidence 0.88\n  > This is the 3rd GET /api/status failure in a row.\n");
    expect(md).toContain("**Other detections**\n\n- 1 of 1 seed (1) · `POST /api/orders` · `failure:transient` · confidence 0.80\n");
    expect(md).not.toContain("GET /api/items");
    expect(md).toContain("**2 signatures** in 1 test, **0 reproducible**");
  });

  it("orders tests with reproducible signatures first and lists quiet tests in a collapsed section", () => {
    const md = summarize([
      { name: "1.json", content: file("a quiet test", 1, []) },
      { name: "2.json", content: file("b one seed", 1, [sig({ trigger: "request", diagnosis: "duplicate", op: "POST /b", seeds: [1] })]) },
      { name: "3.json", content: file("c two seeds", 1, [sig({ trigger: "request", diagnosis: "duplicate", op: "POST /c", seeds: [1, 2] })]) },
    ]);
    expect(md.indexOf("### c two seeds")).toBeGreaterThan(0);
    expect(md.indexOf("### c two seeds")).toBeLessThan(md.indexOf("### b one seed"));
    expect(md).not.toContain("### a quiet test");
    expect(md).toContain("<details><summary>1 test with nothing flagged</summary>\n\n- a quiet test (1 seed: 1)\n\n</details>");
  });

  it("uses the file's seed when a signature lists no seeds, and merges duplicates within a file", () => {
    const s = buildSummary([
      { name: "a.json", content: file("t", 7, [sig({ trigger: "request", diagnosis: "duplicate", op: "POST /x", confidence: 0.5 }), sig({ trigger: "request", diagnosis: "duplicate", op: "POST /x", confidence: 0.6, evidence: "second" })]) },
    ]);
    expect(s.tests[0].signatures).toHaveLength(1);
    expect(s.tests[0].signatures[0]).toMatchObject({ seeds: [7], confidence: 0.6, evidence: "second", reproducible: false });
  });

  it("one file per test that lists the seeds of each signature works the same as one file per seed", () => {
    const s = buildSummary([{ name: "a.json", content: file("t", 1, [sig({ trigger: "request", diagnosis: "duplicate", op: "POST /x", seeds: [1, 3] }), sig({ trigger: "delivery", diagnosis: "stale", op: "GET /q", seeds: [2] })]) }]);
    expect(s.tests[0].seeds).toEqual([1, 2, 3]);
    expect(s.tests[0].signatures.map((x) => [x.sig, x.reproducible])).toEqual([
      ["request|duplicate|POST /x", true],
      ["delivery|stale|GET /q", false],
    ]);
  });

  it("says when the model was not ready, and shows mode and chaos when the files carry them", () => {
    const md = summarize([
      { name: "a.json", content: file("t", 1, [sig({ trigger: "request", diagnosis: "duplicate", op: "POST /x", seeds: [1] })], { mode: "observe", model: { state: "ready" }, chaos: { latencyMs: [0, 600], reorder: true, failRate: 0.05 } }) },
      { name: "b.json", content: file("t", 2, [], { mode: "observe", model: { state: "loading" } }) },
      { name: "c.json", content: file("u", 1, [], { mode: "observe", model: null }) },
    ]);
    expect(md).toContain(" · 3 files read · mode observe\n");
    expect(md).toContain("2 seeds (1, 2) · 1 signature · chaos: latency 0–600 ms, reorder, fail rate 0.05\n");
    expect(md).toContain("Note: the model was not ready in 1 of 2 files for this test (loading); those runs could not flag anything.");
    expect(md).toContain("- u (1 seed: 1; model not ready in 1 of 1 file (not started))");
  });

  it("escapes markdown in test names and evidence, and keeps backticks inside code spans", () => {
    const md = summarize([
      { name: "a.json", content: file("form <b>*bold*</b> | x", 1, [sig({ trigger: "request", diagnosis: "duplicate", op: "POST /api/`q`", evidence: "# not a heading: [link](x) _y_ &amp; <img src=x>", seeds: [1] })]) },
    ]);
    expect(md).toContain("### form \\<b>\\*bold\\*\\</b> \\| x\n");
    expect(md).toContain("`` POST /api/`q` ``");
    expect(md).toContain("  > \\# not a heading: \\[link\\](x) \\_y\\_ \\&amp; \\<img src=x>\n");
    expect(escapeMarkdown("1. first")).toBe("1\\. first");
    expect(escapeMarkdown("- item")).toBe("\\- item");
    expect(escapeMarkdown("> quote")).toBe("\\> quote");
    expect(escapeMarkdown("a\n\n  b")).toBe("a b");
  });

  it("cuts long evidence lines", () => {
    const long = "x".repeat(500);
    const md = summarize([{ name: "a.json", content: file("t", 1, [sig({ trigger: "request", diagnosis: "duplicate", op: "POST /x", evidence: long, seeds: [1] })]) }], { maxEvidenceChars: 50 });
    expect(md).toContain(`  > ${"x".repeat(49)}…\n`);
  });

  it("uses the title option", () => {
    expect(summarize([{ name: "a.json", content: file("t", 1, []) }], { title: "Races on PR #12" })).toContain("## Races on PR #12\n");
  });
});

describe("summarize: nothing to report", () => {
  it("no files at all: says where it looked and what it reads", () => {
    expect(summarize([], { sources: ["test-results/genclass"] })).toBe(
      [
        REPORT_MARKER,
        "## GenClass race report",
        "",
        "No GenClass race files were found in `test-results/genclass`. This report reads the files the GenClass Playwright fixture writes (one per test, format `genclass-races/1`): is the fixture installed, and did the tests run?",
        "",
      ].join("\n"),
    );
  });

  it("files with nothing flagged", () => {
    expect(summarize([{ name: "a.json", content: file("t", 1, []) }, { name: "b.json", content: file("t", 2, []) }])).toBe(
      [REPORT_MARKER, "## GenClass race report", "", "**Nothing flagged** in 1 test · 2 files read", "", "<details><summary>1 test with nothing flagged</summary>", "", "- t (2 seeds: 1, 2)", "", "</details>", ""].join("\n"),
    );
  });

  it("only invalid files: lists each with why, and claims nothing else", () => {
    expect(
      summarize(
        [
          { name: "test-results/genclass/old.json", content: '{"format":"genclass-races/1","test":"t","seed":1,"signatures":["request|duplicate|POST /a"]}' },
          { name: "test-results/genclass/next.json", content: '{"schema":"genclass-races/2"}' },
          { name: "test-results/genclass/locked.json", content: null, error: "could not be read (EACCES)" },
        ],
        { sources: ["test-results/genclass"] },
      ),
    ).toBe(
      [
        REPORT_MARKER,
        "## GenClass race report",
        "",
        "**No race file could be read** · 0 files read in `test-results/genclass`, 3 skipped",
        "",
        "### Files skipped (3)",
        "",
        "- `test-results/genclass/locked.json`: `could not be read (EACCES)`",
        '- `test-results/genclass/next.json`: `schema: expected "genclass-races/1", got "genclass-races/2"`',
        '- `test-results/genclass/old.json`: `schema: missing, expected "genclass-races/1" (the file has "format": "genclass-races/1"; the field is named "schema")`',
        "",
      ].join("\n"),
    );
  });

  it("valid and invalid files together: the valid ones are reported, the others listed", () => {
    const md = summarize([...fixtureInputs(), { name: "test-results/genclass/zz.json", content: "{" }], { sources: ["test-results/genclass"] });
    expect(md).toContain("· 4 files read in `test-results/genclass`, 1 skipped\n");
    expect(md).toMatch(/### Files skipped \(1\)\n\n- `test-results\/genclass\/zz\.json`: `not valid JSON \(.+\)`\n/);
  });
});

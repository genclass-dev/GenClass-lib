import { describe, expect, it } from "vitest";
import { normaliseSubject, oneLine, renderMarkdown, summarise, summariseAttachment, type TestInput } from "../src/summarise.js";
import type { DecisionSnapshot, GenClassAttachment, RuntimeSnapshot } from "../src/types.js";

let n = 0;
function decision(p: Partial<DecisionSnapshot> & { diagnosis: string; subject: string }): DecisionSnapshot {
  n++;
  return {
    id: `d${n}`,
    trigger: "delivery",
    at: 1000 + n,
    diagnosisConfidence: 0.9,
    action: "discard",
    confidence: 0.5,
    executed: false,
    ran: "deliver",
    tier: "passive",
    latencyMs: 400,
    facts: [`fact about ${p.subject}`],
    message: `Detected a ${p.diagnosis} on ${p.subject} (${p.diagnosis}, 0.90; ${p.action ?? "discard"} 0.50)`,
    ...p,
  };
}

function runtime(p: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    handle: "GenClass.runtime",
    href: "http://localhost:3000/",
    title: "app",
    mode: "observe",
    status: { state: "ready", model: "genclass-runtime-r17", version: "2.0.0-rc4t", device: "wasm", variant: "q8", effectiveMode: "observe" },
    gates: { kind: "mass", aggressiveness: 0.5, level: "balanced", levelSource: "profiles", report: 0.6, guard: 0.9, heal: 0.8, source: { report: "model", guard: "model", heal: "model" } },
    summary: null,
    audit: [],
    decisions: [],
    interventions: [],
    ...p,
  };
}

function attachment(p: Partial<GenClassAttachment> = {}): GenClassAttachment {
  return {
    schema: 1,
    package: "0.1.0",
    runtimeVersion: "0.2.1",
    test: { title: "t", titlePath: ["demos.spec.ts", "checkout", "double-click Place order"], file: "/repo/e2e/demos.spec.ts", line: 40 },
    options: { mode: "observe", install: "inject", runtime: "local:/x", handle: ["GenClass.runtime", "__genclass"] },
    injected: { ok: true },
    chaos: null,
    modelReadyLines: 1,
    warnings: [],
    runtime: runtime(),
    ...p,
  };
}

function input(att: GenClassAttachment | null, title = "a test", status = "passed"): TestInput {
  return { id: title, title, titlePath: ["spec.ts", title], file: "/repo/e2e/spec.ts", line: 1, status, attachment: att };
}

describe("summarise: one test", () => {
  it("groups detections into findings (race class) and info (the rest), dedupes by normalised subject, keeps the best evidence line", () => {
    const rt = runtime({
      decisions: [
        decision({ diagnosis: "duplicate", subject: "POST /api/orders (#12)", trigger: "request", diagnosisConfidence: 0.97, action: "coalesce" }),
        decision({ diagnosis: "duplicate", subject: "POST /api/orders (#15)", trigger: "request", diagnosisConfidence: 0.91 }),
        decision({ diagnosis: "stale", subject: "GET /api/search?q=… (#6)", diagnosisConfidence: 0.88 }),
        decision({ diagnosis: "expected", subject: "GET /api/items (#3)", diagnosisConfidence: 0.99 }),
        decision({ diagnosis: "stale", subject: "GET /api/search?q=… (#9)", diagnosisConfidence: 0.4 }), // below the report threshold
        decision({ diagnosis: "overload", subject: "GET /api/status (#20)", trigger: "request", diagnosisConfidence: 0.7 }),
        decision({ diagnosis: "failing", subject: "GET /api/status/payments (#21)", trigger: "failure", diagnosisConfidence: 0.8 }),
        decision({ diagnosis: "failing", subject: "GET /api/status/payments (#22)", trigger: "failure", diagnosisConfidence: 0.75 }),
      ],
    });
    const t = summariseAttachment(attachment({ runtime: rt }));
    expect(t.present).toBe(true);
    expect(t.decisions).toBe(8);
    expect(t.unremarkable).toBe(2);
    expect(t.findings.map((f) => [f.diagnosis, f.count, f.confidence])).toEqual([
      ["duplicate", 2, 0.97],
      ["stale", 1, 0.88],
    ]);
    expect(t.findings[0].message).toMatch(/\(duplicate, 0\.90; coalesce 0\.50\)/);
    expect(t.findings[0].subject).toBe("POST /api/orders (#12)");
    expect(t.info.map((f) => [f.diagnosis, f.count])).toEqual([
      ["failing", 2],
      ["overload", 1],
    ]);
    expect(t.failingEndpoints).toEqual([{ subject: "GET /api/status/payments (#21)", key: "GET /api/status/payments (#n)", count: 2, diagnoses: { failing: 2 } }]);
    expect(t.interventions).toEqual([]);
    expect(t.thresholds).toEqual({ report: 0.6, guard: 0.9, heal: 0.8, profile: "balanced" });
    expect(t.model).toMatchObject({ state: "ready", name: "genclass-runtime-r17", version: "2.0.0-rc4t", device: "wasm" });
    expect(oneLine(t)).toBe("GenClass: findings: 2 duplicate submits, 1 stale response · info: 2 failing endpoints, 1 overload · 8 decisions · model ready (wasm)");
  });

  it("without a runtime it says why", () => {
    expect(summariseAttachment(null).absent).toMatch(/fixture did not run/);
    const app = summariseAttachment(attachment({ runtime: null, injected: null, options: { mode: "observe", install: "app", runtime: "cdn", handle: ["__demo.gc", "GenClass.runtime", "__genclass"] } }));
    expect(app.present).toBe(false);
    expect(app.absent).toBe("no runtime at window.__demo.gc, window.GenClass.runtime, window.__genclass");
    const inj = summariseAttachment(attachment({ runtime: null, injected: { ok: false, error: "HTTP 404 for https://cdn/x.js" } }));
    expect(inj.absent).toBe("the runtime could not be injected: HTTP 404 for https://cdn/x.js");
    expect(oneLine(inj)).toMatch(/^GenClass: the runtime could not be injected/);
  });

  it("a model that did not load is a warning, not zero findings", () => {
    const t = summariseAttachment(attachment({ runtime: runtime({ status: { state: "error", error: "model.json: 404" } }) }));
    expect(t.present).toBe(true);
    expect(t.warnings).toEqual(["model error: model.json: 404: no decisions were possible"]);
    const off = summariseAttachment(attachment({ runtime: runtime({ status: { state: "off" }, gates: null }) }));
    expect(off.warnings[0]).toMatch(/^no model/);
  });

  it("without gates, the report threshold comes from the audit entries, and without either every non-expected decision counts", () => {
    const d = [decision({ diagnosis: "stale", subject: "GET /a (#1)", diagnosisConfidence: 0.5 })];
    const fromAudit = summariseAttachment(attachment({ runtime: runtime({ gates: null, decisions: d, audit: [{ gate: { thresholds: { report: 0.7 } } } as never] }) }));
    expect(fromAudit.findings).toEqual([]);
    const none = summariseAttachment(attachment({ runtime: runtime({ gates: null, decisions: d }) }));
    expect(none.findings).toHaveLength(1);
  });

  it("normaliseSubject strips op ids, numbers and hashes", () => {
    expect(normaliseSubject("GET /api/items/42 (#7)")).toBe("GET /api/items/n (#n)");
    expect(normaliseSubject("GET /api/users/0123456789abcdef/orders")).toBe("GET /api/users/n/orders");
    expect(normaliseSubject("  POST   /x  ")).toBe("POST /x");
  });
});

describe("summarise: a run", () => {
  it("totals, modes and the interventions line for observe mode", () => {
    const a = attachment({ runtime: runtime({ decisions: [decision({ diagnosis: "duplicate", subject: "POST /api/orders (#1)", trigger: "request" })] }) });
    const b = attachment({ runtime: runtime({ decisions: [decision({ diagnosis: "expected", subject: "GET /x (#1)" })] }) });
    const s = summarise([input(a, "checkout"), input(b, "search"), input(null, "no fixture")]);
    expect(s.totals).toEqual({ tests: 3, withRuntime: 2, decisions: 2, findings: { duplicate: 1 }, info: {}, failingEndpoints: 0, interventions: 0 });
    expect(s.modes).toEqual({ observe: 2 });
    expect(s.model).toMatchObject({ name: "genclass-runtime-r17", version: "2.0.0-rc4t", device: "wasm", variant: "q8", states: { ready: 2 } });
    expect(s.thresholds).toEqual({ report: 0.6, guard: 0.9, heal: 0.8, profile: "balanced" });
    const md = renderMarkdown(s);
    expect(md).toContain("## GenClass report");
    expect(md).toContain("**Findings: 1 duplicate submit** · Interventions: 0 (observe mode never holds, delays or changes anything)");
    expect(md).toContain("3 tests, 2 with GenClass on the page, 2 decisions · @genclass/runtime 0.2.1 · model genclass-runtime-r17 2.0.0-rc4t (wasm, q8) · report threshold 0.6, guard 0.9 (balanced) · mode observe");
    expect(md).toContain("- **duplicate** 0.90 · `POST /api/orders (#1)`");
    expect(md).toContain("Detected a duplicate on POST /api/orders (#1) (duplicate, 0.90; discard 0.50)");
    expect(md).toContain("Tests with GenClass and no findings (1)");
    expect(md).toContain("GenClass was not on the page (1)");
    expect(md).toContain("the genclass fixture did not run for this test");
    expect(md).toContain("https://github.com/genclass-dev/GenClass-lib/issues");
  });

  it("interventions in guard mode are listed and never called correct or false", () => {
    const rt = runtime({
      mode: "guard",
      status: { state: "ready", effectiveMode: "guard", model: "m", version: "1", device: "wasm" },
      decisions: [decision({ diagnosis: "duplicate", subject: "POST /api/orders (#2)", trigger: "request", executed: true, tier: "guard", action: "coalesce", ran: "coalesce" })],
      interventions: [{ id: "a1", decisionId: "d1", action: "coalesce", tier: "guard", trigger: "request", subject: "POST /api/orders (#2)", at: 5, ok: true, changed: "Answered the second POST /api/orders with the first one's response." }],
    });
    const s = summarise([input(attachment({ runtime: rt }), "checkout")]);
    expect(s.totals.interventions).toBe(1);
    const md = renderMarkdown(s);
    expect(md).toContain("Interventions: 1 (listed per test; this report cannot tell a correct intervention from a wrong one, your test's own assertions can)");
    expect(md).toContain("- **duplicate** 0.90 · `POST /api/orders (#2)` · acted");
    expect(md).toContain("coalesce on `POST /api/orders (#2)`: Answered the second POST /api/orders with the first one's response.");
    expect(md).not.toMatch(/false intervention/i);
    expect(md).not.toContain("observe mode never");
  });

  it("a diagnosis on more than maxSubjectsPerDiagnosis distinct subjects becomes one recurring-pattern note", () => {
    const decisions = Array.from({ length: 10 }, (_, i) => decision({ diagnosis: "stale", subject: `GET /api/thing-${String.fromCharCode(97 + i)} (#${i})` }));
    decisions.push(decision({ diagnosis: "duplicate", subject: "POST /api/orders (#99)", trigger: "request" }));
    const s = summarise([input(attachment({ runtime: runtime({ decisions }) }), "conduit")], { maxSubjectsPerDiagnosis: 8 });
    expect(s.recurring).toEqual([{ diagnosis: "stale", subjects: 10, occurrences: 10, example: expect.stringContaining("Detected a stale") }]);
    expect(s.totals.findings).toEqual({ duplicate: 1 });
    const md = renderMarkdown(s);
    expect(md).toContain("**stale** was flagged on 10 distinct subjects (10 times) in this run");
    expect(md).toContain("**Findings: 1 duplicate submit**");
    const loose = summarise([input(attachment({ runtime: runtime({ decisions }) }), "conduit")], { maxSubjectsPerDiagnosis: 20 });
    expect(loose.recurring).toEqual([]);
    expect(loose.totals.findings).toEqual({ stale: 10, duplicate: 1 });
  });

  it("chaos counters and warnings are printed with the test", () => {
    const att = attachment({
      runtime: runtime({ decisions: [decision({ diagnosis: "stale", subject: "GET /api/search?q=… (#4)" })] }),
      chaos: { matched: 14, delayed: 12, failed: 1, reordered: 2, latencyMs: [50, 800], reorder: true, failRate: 0.05, seed: 1234 },
      warnings: ["the runtime was still busy after 6000 ms (settle.maxMs): late decisions are not in this report"],
    });
    const md = renderMarkdown(summarise([input(att, "search")]));
    expect(md).toContain("Chaos: 12 requests delayed 50–800 ms, 1 answered with an injected failure, 2 responses reordered (seed 1234).");
    expect(md).toContain("- ⚠ the runtime was still busy after 6000 ms");
  });

  it("a run where GenClass was never on the page says so in the headline", () => {
    const md = renderMarkdown(summarise([input(attachment({ runtime: null, injected: { ok: false, error: "HTTP 500 for x" } }), "a")]));
    expect(md).toContain("**GenClass was not on the page in any of the 1 test.**");
    expect(md).toContain("the runtime could not be injected: HTTP 500 for x");
  });
});

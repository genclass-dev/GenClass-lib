// Dashboard reporting (AGENT.md section 4.5): off by default, where it goes, what one event carries and never carries,
// batching, failures swallowed, and the API wrapper that hears replay verdicts and written tests.
import { describe, expect, it } from "vitest";
import { createReporter, reportEvent, reportRoute, reportTarget, REPORT_SCHEMA } from "../src/report.js";
import { reportingApi } from "../src/server.js";
import type { Finding } from "../src/types.js";
import type { Store } from "../src/store.js";

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f3", key: "k", kind: "stale-write", title: 'GET /api/search?q=rea overwrote newer "search.results"', route: "/search?q=rea", count: 2, runs: ["r1"], first: 1, last: 2,
  evidence: { subject: "search.results", by: "GET /api/search#4", secret: "never sent" }, replays: [], ...over,
});

describe("report target", () => {
  it("is off without GENCLASS_REPORT; on takes GENCLASS_DASHBOARD; a link or secret works alone; the sample is never a target", () => {
    expect(reportTarget({})).toBeNull();
    expect(reportTarget({ GENCLASS_DASHBOARD: "https://genclass.dev/dashboard/abcdefghijklmnop" })).toBeNull();
    expect(reportTarget({ GENCLASS_REPORT: "on", GENCLASS_DASHBOARD: "https://genclass.dev/dashboard/abcdefghijklmnop" })).toEqual({ origin: "https://genclass.dev", secret: "abcdefghijklmnop" });
    expect(reportTarget({ GENCLASS_REPORT: "1" })).toBeNull();
    expect(reportTarget({ GENCLASS_REPORT: "https://genclass.dev/dashboard/abcdefghijklmnop" })).toEqual({ origin: "https://genclass.dev", secret: "abcdefghijklmnop" });
    expect(reportTarget({ GENCLASS_REPORT: "abcdefghijklmnop" })).toEqual({ origin: "https://genclass.dev", secret: "abcdefghijklmnop" });
    expect(reportTarget({ GENCLASS_REPORT: "sample" })).toBeNull();
    expect(reportTarget({ GENCLASS_REPORT: "on", GENCLASS_DASHBOARD: "sample" })).toBeNull();
    expect(reportTarget({ GENCLASS_REPORT: "http://evil.example/dashboard/abcdefghijklmnop" })).toBeNull();
  });
});

describe("report events", () => {
  it("carry the id, kind, page path and time only: no title, evidence, query string or snapshot", () => {
    const e = reportEvent("found", finding(), 1000);
    expect(e).toEqual({ t: "found", id: "f3", kind: "stale-write", route: "/search", at: 1000 });
    expect(reportEvent("replay", finding(), 1001, true)).toEqual({ t: "replay", id: "f3", kind: "stale-write", route: "/search", at: 1001, reproduced: true });
    expect(reportRoute("/a/b?x=1#y")).toBe("/a/b");
    expect(reportRoute("javascript:alert(1)")).toBe("/");
    expect(reportRoute("/" + "x".repeat(400))).toHaveLength(200);
    expect(JSON.stringify(e)).not.toMatch(/overwrote|secret|search\.results|q=rea/);
  });

  it("batches to POST <origin>/api/projects/<secret>/agent with the schema, flushes on close, swallows failures and logs once", async () => {
    const calls: { url: string; body: unknown; init: RequestInit }[] = [];
    let fail = false;
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), init });
      if (fail) throw new Error("ECONNREFUSED");
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    let t = 5000;
    const r = createReporter({ origin: "https://genclass.dev", secret: "abcdefghijklmnop" }, { fetch: fetchFn, now: () => t, log: (s) => logs.push(s), flushMs: 10 });
    r.found(finding());
    t = 5001;
    r.replay(finding(), true);
    r.replay(finding(), null); // inconclusive: nothing to report
    r.test(finding({ id: "f4", kind: "duplicate-request", route: "/checkout" }));
    expect(calls).toHaveLength(0); // not sent yet: batched
    await r.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://genclass.dev/api/projects/abcdefghijklmnop/agent");
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(calls[0]!.body).toEqual({ schema: REPORT_SCHEMA, events: [
      { t: "found", id: "f3", kind: "stale-write", route: "/search", at: 5000 },
      { t: "replay", id: "f3", kind: "stale-write", route: "/search", at: 5001, reproduced: true },
      { t: "test", id: "f4", kind: "duplicate-request", route: "/checkout", at: 5001 },
    ] });
    fail = true;
    r.found(finding({ id: "f5" }));
    await r.close();
    r.found(finding({ id: "f6" }));
    await r.close();
    expect(calls).toHaveLength(3);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("dashboard report failed");
  });

  it("the API wrapper reports the last replay verdict and a written test, and changes nothing the agent gets", () => {
    const f = finding();
    const store = { findings: new Map([[f.id, f]]) } as unknown as Store;
    const got: string[] = [];
    const reporter = { target: { origin: "o", secret: "s" }, found: () => got.push("found"), replay: (_f: Finding, v: boolean | null) => got.push(`replay:${v}`), test: () => got.push("test"), flush: async () => {}, close: async () => {} };
    const api = reportingApi((m, p) => (m === "replay.result" ? { finding: f, results: [{ reproduced: true }, { reproduced: false }] } : m === "finding" ? ((p as { id: string }).id === "f3" ? { finding: f, test: "..." } : null) : m === "status" ? { ok: 1 } : null), store, reporter);
    expect(api("replay.result", { id: "f3" })).toEqual({ finding: f, results: [{ reproduced: true }, { reproduced: false }] });
    expect(api("finding", { id: "f3" })).toEqual({ finding: f, test: "..." });
    expect(api("finding", { id: "f404" })).toBeNull();
    expect(api("status", {})).toEqual({ ok: 1 });
    expect(got).toEqual(["replay:false", "test"]);
  });
});

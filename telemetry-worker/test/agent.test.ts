// Agent reports (docs/runtime/AGENT.md section 4.5): POST /api/projects/<secret>/agent stores what a developer's
// coding agent found, replayed and tested; the dashboard's stats carry them; retention drops them with the rest.
import { describe, expect, it } from "vitest";
import { d1 } from "./d1.js";
import { AGENT_MAX_EVENTS, agentReport, agentStats, createProject, normalizeRoute, retention, stats } from "../src/dashboard.js";
import { handle } from "../src/collector.js";

const NOW = new Date("2026-10-25T04:00:00Z");
const ms = (minAgo: number) => NOW.getTime() - minAgo * 60_000;
const bucket = { async put() {} };

describe("agent reports", () => {
  it("normalizes routes the way the dashboard keys them: path only, ids replaced, capped", () => {
    expect(normalizeRoute("/search?q=rea#x")).toBe("/search");
    expect(normalizeRoute("/products/123/edit")).toBe("/products/:id/edit");
    expect(normalizeRoute("/u/ab@example.com")).toBe("/u/:id");
    expect(normalizeRoute("/" + Array(80).fill("ab").join("/"))).toHaveLength(200);
    expect(normalizeRoute("search")).toBeNull();
    expect(normalizeRoute(5)).toBeNull();
  });

  it("stores found, replay and test events per finding; a replay that stops reproducing after one that did proves the fix", async () => {
    const db = d1().api;
    const p = await createProject(db, "shop", NOW);
    const r1 = await agentReport(db, p.token, { schema: "genclass-agent/1", events: [
      { t: "found", id: "f3", kind: "stale-write", route: "/search?q=x", at: ms(300) },
      { t: "replay", id: "f3", kind: "stale-write", route: "/search", at: ms(200), reproduced: true },
      { t: "test", id: "f3", kind: "stale-write", route: "/search", at: ms(150) },
      { t: "found", id: "f7", kind: "duplicate-request", route: "/checkout", at: ms(60) },
      { t: "nope", id: "f8", kind: "error", route: "/x" },           // unknown event
      { t: "found", id: "f9", kind: "sneaky", route: "/x" },         // unknown kind
      { t: "found", id: "finding-1", kind: "error", route: "/x" },   // bad id
      { t: "found", id: "f10", kind: "error", route: "x" },          // bad route
      { t: "found", id: "f11", kind: "error", route: "/x", title: "ignored", evidence: { secret: 1 } },
    ] }, NOW);
    expect(r1).toEqual({ stored: 5 });
    let a = await agentStats(db, p.token, new Date(ms(600)).toISOString());
    const f3 = a.findings.find((f) => f.id === "f3")!;
    expect(f3.route).toBe("/search");
    expect(f3.reproduced).toBe(true);
    expect(f3.tested).not.toBeNull();
    expect(f3.proven).toBeNull();
    expect(a.counts).toEqual({ found: 3, reproduced: 1, tested: 1, proven: 0 });
    expect(a.findings.map((f) => f.id)).toEqual(["f11", "f7", "f3"]); // newest change first
    // after the fix: the replay no longer reproduces it
    await agentReport(db, p.token, { schema: "genclass-agent/1", events: [{ t: "replay", id: "f3", kind: "stale-write", route: "/search", at: ms(10), reproduced: false }] }, NOW);
    a = await agentStats(db, p.token, new Date(ms(600)).toISOString());
    const after = a.findings.find((f) => f.id === "f3")!;
    expect(after.reproduced).toBe(false);
    expect(after.proven).toBe(new Date(ms(10)).toISOString());
    expect(a.counts.proven).toBe(1);
    expect(a.counts.reproduced).toBe(1); // proven counts as reproduced once
    expect(a.last).toBe(after.updated);
    // a first replay that does not reproduce proves nothing
    await agentReport(db, p.token, { schema: "genclass-agent/1", events: [{ t: "replay", id: "f7", kind: "duplicate-request", route: "/checkout", reproduced: false }] }, NOW);
    a = await agentStats(db, p.token, new Date(ms(600)).toISOString());
    expect(a.findings.find((f) => f.id === "f7")!.proven).toBeNull();
    // the stats carry them, within the range
    const st = await stats(db, { ...p, last_event: null, first_event: null, account_id: null, private_link: null } as never, "7d", NOW);
    expect(st.agent.counts.found).toBe(3);
    expect(st.agent.findings.length).toBe(3);
  });

  it("refuses the wrong schema, too many events and non-objects; stores nothing from them", async () => {
    const db = d1().api;
    const p = await createProject(db, "shop", NOW);
    expect(await agentReport(db, p.token, { schema: "nope", events: [] }, NOW)).toEqual({ error: "schema must be genclass-agent/1" });
    expect(await agentReport(db, p.token, [], NOW)).toEqual({ error: "body must be a JSON object" });
    expect(await agentReport(db, p.token, { schema: "genclass-agent/1", events: Array(AGENT_MAX_EVENTS + 1).fill({}) }, NOW)).toEqual({ error: `at most ${AGENT_MAX_EVENTS} events per request` });
    expect((await agentStats(db, p.token, "2000-01-01T00:00:00.000Z")).findings).toEqual([]);
  });

  it("the route: the dashboard's private link authenticates, the sample and unknown secrets 404, bad bodies 400, the limiter 429", async () => {
    const db = d1().api;
    const p = await createProject(db, "shop", NOW);
    const env = { BUCKET: bucket, DB: db } as never;
    const post = (secret: string, body: string, over: Record<string, unknown> = {}) =>
      handle(new Request(`https://genclass.dev/api/projects/${secret}/agent`, { method: "POST", body, headers: { "content-type": "application/json" } }), { ...(env as object), ...over } as never, { now: () => NOW });
    const ok = JSON.stringify({ schema: "genclass-agent/1", events: [{ t: "found", id: "f1", kind: "race", route: "/search" }] });
    let res = await post(p.secret, ok);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: 1 });
    expect((await agentStats(db, p.token, "2000-01-01T00:00:00.000Z")).findings[0]!.kind).toBe("race");
    expect((await post("sample", ok)).status).toBe(404);
    expect((await post("nosuchsecret0000000000000000000", ok)).status).toBe(404);
    expect((await post(p.secret, "{")).status).toBe(400);
    expect((await post(p.secret, JSON.stringify({ schema: "x", events: [] }))).status).toBe(400);
    expect((await handle(new Request(`https://genclass.dev/api/projects/${p.secret}/agent`, { method: "GET" }), env, { now: () => NOW })).status).toBe(405);
    res = await post(p.secret, ok, { SESSION_LIMIT: { async limit() { return { success: false }; } } });
    expect(res.status).toBe(429);
    res = await post(p.secret, "x".repeat(20 * 1024));
    expect(res.status).toBe(413);
  });

  it("retention drops reports older than 90 days with the rest", async () => {
    const db = d1().api;
    const p = await createProject(db, "shop", NOW);
    await agentReport(db, p.token, { schema: "genclass-agent/1", events: [{ t: "found", id: "f1", kind: "error", route: "/a" }] }, new Date(NOW.getTime() - 100 * 86_400_000));
    await agentReport(db, p.token, { schema: "genclass-agent/1", events: [{ t: "found", id: "f2", kind: "error", route: "/b" }] }, NOW);
    await retention(db, NOW);
    const a = await agentStats(db, p.token, "2000-01-01T00:00:00.000Z");
    expect(a.findings.map((f) => f.id)).toEqual(["f2"]);
  });
});

// Agent reports (docs/runtime/AGENT.md section 4.5): POST /api/projects/<secret>/agent stores what a developer's
// coding agent found, read, armed, replayed, tested, explored and cleared (the MCP server's log, mirrored) and the
// stages each finding reached; the dashboard's stats carry them; retention drops them with the rest.
import { describe, expect, it } from "vitest";
import { d1 } from "./d1.js";
import { AGENT_LOG_CAP, AGENT_LOG_SHOWN, AGENT_MAX_EVENTS, agentReport, agentStats, createProject, normalizeRoute, retention, stats } from "../src/dashboard.js";
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

  it("mirrors the log: every step is a row, newest first, and the stages count found, explained, reproduced, fixed, closed, open and round again", async () => {
    const db = d1().api;
    const p = await createProject(db, "shop", NOW);
    const f3 = { id: "f3", kind: "stale-write", route: "/search?q=rea" };
    const r = await agentReport(db, p.token, { schema: "genclass-agent/1", events: [
      { t: "found", ...f3, at: ms(300) },
      { t: "explain", ...f3, at: ms(290) },
      { t: "explain", ...f3, at: ms(289) },                        // read twice: logged twice, explained once
      { t: "armed", ...f3, at: ms(280) },
      { t: "replay", ...f3, at: ms(270), reproduced: true },
      { t: "test", ...f3, at: ms(260) },
      { t: "replay", ...f3, at: ms(200), reproduced: true },       // a fix tried, still there: round again
      { t: "explore", route: "/search?q=x", runs: 8, races: 1, at: ms(150) },
      { t: "explore", runs: 2, races: 0, at: ms(149) },            // no route: fine
      { t: "replay", ...f3, at: ms(100), reproduced: false },      // fix proven; with the test: closed
      { t: "found", id: "f8", kind: "error", route: "/a", at: ms(50) },
      { t: "cleared", what: "runs", at: ms(40) },
      { t: "armed", ...f3 },                                        // no time: received now
      { t: "explore", runs: -1, races: 0 },                         // bad count
      { t: "explore", runs: 1 },                                    // missing count
      { t: "cleared", what: "everything" },                         // bad what
      { t: "replay", ...f3, reproduced: "yes" },                    // verdict not a boolean
      { t: "armed", id: "f3", kind: "stale-write" },                // no route
      { t: "nope", ...f3 },
    ] }, NOW);
    expect(r).toEqual({ stored: 13 });
    const a = await agentStats(db, p.token, new Date(ms(600)).toISOString());
    expect(a.stages).toEqual({ found: 2, explained: 1, reproduced: 1, fixed: 1, closed: 1, open: 1, continued: 1 });
    const f = a.findings.find((x) => x.id === "f3")!;
    expect(f.explained).toBe(new Date(ms(290)).toISOString());
    expect(f.reproducedN).toBe(2);
    expect(f.closed).toBe(true);
    expect(a.findings.find((x) => x.id === "f8")!.closed).toBe(false);
    expect(a.log.map((e) => e.t)).toEqual(["armed", "cleared", "found", "replay", "explore", "explore", "replay", "test", "replay", "armed", "explain", "explain", "found"]);
    expect(a.log[0]!.at).toBe(NOW.toISOString());
    expect(a.log[1]).toEqual({ at: new Date(ms(40)).toISOString(), t: "cleared", id: null, kind: null, route: null, reproduced: null, runs: null, races: null, what: "runs" });
    expect(a.log[3]).toMatchObject({ t: "replay", id: "f3", kind: "stale-write", route: "/search", reproduced: false });
    expect(a.log[4]).toEqual({ at: new Date(ms(149)).toISOString(), t: "explore", id: null, kind: null, route: null, reproduced: null, runs: 2, races: 0, what: null });
    expect(a.log[5]).toMatchObject({ t: "explore", route: "/search", runs: 8, races: 1 });
    expect(JSON.stringify(a)).not.toContain("q=rea");
    expect(a.last).toBe(NOW.toISOString());
    // the stats carry the log and the stages too; a period that starts after the steps has none of them
    const st = await stats(db, { ...p, last_event: null, first_event: null, account_id: null, private_link: null } as never, "7d", NOW);
    expect(st.agent.log.length).toBe(13);
    expect(st.agent.stages.closed).toBe(1);
    const none = await agentStats(db, p.token, new Date(NOW.getTime() + 1000).toISOString());
    expect(none).toEqual({ findings: [], counts: { found: 0, reproduced: 0, tested: 0, proven: 0 }, stages: { found: 0, explained: 0, reproduced: 0, fixed: 0, closed: 0, open: 0, continued: 0 }, log: [], last: null });
  });

  it("keeps the last AGENT_LOG_CAP log rows per app and shows AGENT_LOG_SHOWN; another app's rows are untouched", async () => {
    const { api: db, rows } = d1();
    const p = await createProject(db, "shop", NOW);
    const q = await createProject(db, "other", NOW);
    await agentReport(db, q.token, { schema: "genclass-agent/1", events: [{ t: "found", id: "f1", kind: "error", route: "/q" }] }, NOW);
    const total = AGENT_LOG_CAP + 30;
    for (let i = 0; i < total; i += AGENT_MAX_EVENTS) {
      const events = [];
      for (let j = i; j < Math.min(total, i + AGENT_MAX_EVENTS); j++) events.push({ t: "armed", id: `f${j}`, kind: "error", route: `/p${j}`, at: ms(600) + j * 1000 });
      await agentReport(db, p.token, { schema: "genclass-agent/1", events }, NOW);
    }
    expect(rows("SELECT COUNT(*) AS n FROM agent_log WHERE token = ?", p.token)[0]!.n).toBe(AGENT_LOG_CAP);
    expect(rows("SELECT MIN(finding) AS f FROM agent_log WHERE token = ? AND finding GLOB 'f[0-9][0-9]'", p.token)[0]!.f).toBe("f30"); // the oldest 30 went
    expect(rows("SELECT COUNT(*) AS n FROM agent_log WHERE token = ?", q.token)[0]!.n).toBe(1);
    const a = await agentStats(db, p.token, new Date(ms(700)).toISOString());
    expect(a.log.length).toBe(AGENT_LOG_SHOWN);
    expect(a.log[0]!.id).toBe(`f${total - 1}`);
  });

  it("migration 0011 on a populated database: older agent_reports rows keep their state and count in the stages", async () => {
    const { api: db } = d1({
      before: "0011_agent_log.sql",
      seed: (raw) => {
        raw.exec(`INSERT INTO agent_reports (token, finding, kind, route, found, replayed, reproduced, reproduced_once, tested, proven, updated) VALUES ('gc_t', 'f1', 'race', '/x', '${NOW.toISOString()}', '${NOW.toISOString()}', 0, 1, '${NOW.toISOString()}', '${NOW.toISOString()}', '${NOW.toISOString()}')`);
      },
    });
    const a = await agentStats(db, "gc_t", "2000-01-01T00:00:00.000Z");
    expect(a.findings[0]).toMatchObject({ id: "f1", explained: null, reproducedN: 0, closed: true });
    expect(a.stages).toEqual({ found: 1, explained: 0, reproduced: 1, fixed: 1, closed: 1, open: 0, continued: 0 });
    expect(a.log).toEqual([]);
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
    expect(a.log.map((e) => e.id)).toEqual(["f2"]);
  });
});

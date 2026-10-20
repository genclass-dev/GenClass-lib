// The free summary behind `npx @genclass/runtime stats` (src/summary.ts): its JSON shape, that it reads only the
// existing counters (daily for 7d, hourly for 24h), that it stays smaller than the dashboard, that nothing in it
// depends on a plan (the dashboard is free: `dashboard` is the dashboard's address and `locked: false`, kept for
// older CLIs), who may read it (the link's secret; a browser or CLI session for the account's apps) and its rate
// limits.
import { beforeEach, describe, expect, it } from "vitest";
import { resetTokenCache } from "../src/dashboard.js";
import { sampleStats } from "../src/sample.js";
import { summaryDashboard } from "../src/summary.js";
import { advance, call, cliToken, createApp, now, ORIGIN, refusingLimiter, resetClock, sendBatch, setNow, setPlan, setup, signedIn, T0 } from "./account-helpers.js";
import type { Env } from "../src/collector.js";

beforeEach(() => {
  resetClock();
  resetTokenCache();
});

const SUMMARY_KEYS = ["dashboard", "created", "from", "generated", "lastEvent", "limits", "mode", "name", "ok", "previous", "range", "top", "totals"].sort();

/** An app made from /api/projects (no account): its token and the secret from its private link. */
async function linkApp(env: Env, name = "Acme checkout") {
  const r = await call(env, "POST", "/api/projects", { body: { name }, origin: null });
  expect(r.status).toBe(201);
  const j = (await r.json()) as { token: string; dashboardUrl: string };
  return { token: j.token, secret: j.dashboardUrl.split("/").pop()! };
}

let n = 0;
/** One page load: its session event, a model load, then the given detections (each a decision and its detect). */
function pageLoad(o: { route?: string; mode?: string; loadMs?: number | null; detect?: [string, string][]; possible?: [string, string][] } = {}) {
  const events: Record<string, unknown>[] = [{ t: "session", seq: 0, host: "shop.acme.test", route: o.route ?? "/", effectiveMode: o.mode ?? "observe", model: "onnx" }];
  if (o.loadMs !== null) events.push({ t: "model", seq: 1, state: "ready", device: "webgpu", loadMs: o.loadMs ?? 400 });
  let seq = 2;
  for (const [diagnosis, route] of o.detect ?? []) {
    const id = `d${++n}`;
    events.push({ t: "decision", id, seq: seq++, trigger: "delivery", route, diagnosis, diagnosisConfidence: 0.97, situation: "SECRET PAGE TEXT", effectiveMode: o.mode ?? "observe" });
    events.push({ t: "detect", decision: id, seq: seq++, trigger: "delivery", diagnosis, p: 0.97 });
  }
  for (const [diagnosis, route] of o.possible ?? []) {
    const id = `d${++n}`;
    events.push({ t: "decision", id, seq: seq++, trigger: "delivery", route, diagnosis, diagnosisConfidence: 0.6, effectiveMode: o.mode ?? "observe" });
    events.push({ t: "detect", decision: id, seq: seq++, trigger: "delivery", diagnosis, p: 0.6, tier: "possible" });
  }
  return events;
}
const sid = () => `sid${String(++n).padStart(10, "0")}`;

async function get(env: Env, path: string, o: { cookie?: string; bearer?: string } = {}) {
  const r = await call(env, "GET", path, { ...o, origin: null });
  return { status: r.status, headers: r.headers, json: (await r.json()) as any };
}

describe("summary: GET /api/projects/<secret>/summary", () => {
  it("answers the contract's shape from the existing counters, for an app known by its private link", async () => {
    const { env } = setup();
    const app = await linkApp(env);
    await sendBatch(env, app.token, pageLoad({ route: "/checkout", loadMs: 400, detect: [["duplicate", "/checkout"], ["duplicate", "/checkout"], ["stale", "/cart"]] }), { sid: sid() });
    await sendBatch(env, app.token, pageLoad({ route: "/cart", loadMs: 424, possible: [["slow", "/search"]] }), { sid: sid() });
    await sendBatch(env, app.token, pageLoad({ route: "/account", loadMs: null }), { sid: sid() });

    // the dashboard's stats and the summary are both open to whoever holds the link
    expect((await get(env, `/api/projects/${app.secret}`)).status).toBe(200);
    const r = await get(env, `/api/projects/${app.secret}/summary?range=7d`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(r.json).sort()).toEqual(SUMMARY_KEYS);
    expect(r.json).toEqual({
      ok: true,
      name: "Acme checkout",
      created: T0.toISOString(),
      lastEvent: T0.toISOString(),
      range: "7d",
      from: "2026-10-07T00:00:00.000Z",
      generated: T0.toISOString(),
      // pages that sent data: the three landing pages and /search, where the possible detection's decision was made
      totals: { sessions: 3, detections: 3, possible: 1, acted: 0, pagesAffected: 2, pagesSeen: 4, modelLoadedShare: 0.667, modelLoadMsAvg: 412 },
      previous: { sessions: 0, detections: 0 },
      top: { diagnoses: [{ key: "duplicate", count: 2 }, { key: "stale", count: 1 }], routes: [{ key: "/checkout", count: 2 }, { key: "/cart", count: 1 }] },
      mode: "observe",
      // the dashboard is free: its address, and locked false for CLIs from before 2026-10-20 (no trial fields)
      dashboard: { url: `${ORIGIN}/dashboard/${app.secret}`, locked: false },
      limits: { ranges: ["24h", "7d"], top: 3 },
    });
    expect(Object.keys(r.json.dashboard).sort()).toEqual(["locked", "url"]);
    expect(summaryDashboard("https://x.example/d")).toEqual({ url: "https://x.example/d", locked: false });
    // nothing the dashboard has beyond it, no app token, no page text
    const text = JSON.stringify(r.json);
    for (const s of ["series", "typeSeries", "recent", "breakdowns", "distinct", "trial", app.token, "SECRET PAGE TEXT"]) expect(text).not.toContain(s);
  });

  it("24h reads the hourly counters, 7d the daily ones; any other range is 7d; previous is the period before", async () => {
    const { env } = setup();
    const app = await linkApp(env);
    await sendBatch(env, app.token, pageLoad({ detect: [["stale", "/search"]] }), { sid: sid() });
    advance(25 * 3_600_000);
    await sendBatch(env, app.token, pageLoad({ mode: "guard" }), { sid: sid() });

    const day = (await get(env, `/api/projects/${app.secret}/summary?range=24h`)).json;
    expect(day).toMatchObject({ range: "24h", from: "2026-10-13T14:00:00.000Z", totals: { sessions: 1, detections: 0, pagesAffected: 0, pagesSeen: 1 }, previous: { sessions: 1, detections: 1 }, mode: "guard", top: { diagnoses: [], routes: [] } });
    const week = (await get(env, `/api/projects/${app.secret}/summary`)).json;
    expect(week).toMatchObject({ range: "7d", totals: { sessions: 2, detections: 1 }, previous: { sessions: 0, detections: 0 }, mode: "mixed" });
    for (const r of ["30d", "90d", "1y", "junk"]) expect((await get(env, `/api/projects/${app.secret}/summary?range=${r}`)).json.range).toBe("7d");

    // the daily counters age out of the 7-day window; the week after sees them as the previous period
    advance(7 * 86_400_000);
    const later = (await get(env, `/api/projects/${app.secret}/summary?range=7d`)).json;
    expect(later.totals).toMatchObject({ sessions: 0, detections: 0, modelLoadedShare: null, modelLoadMsAvg: null });
    expect(later.previous).toEqual({ sessions: 2, detections: 1 });
    expect(later.mode).toBeNull();
  });

  it("keeps at most 3 diagnoses and pages, most first (ties by key)", async () => {
    const { env } = setup();
    const app = await linkApp(env);
    const detect: [string, string][] = [
      ["slow", "/a"], ["slow", "/a"], ["slow", "/a"], ["failing", "/b"], ["failing", "/b"], ["conflict", "/c"], ["conflict", "/c"], ["transient", "/d"], ["overload", "/e"],
    ];
    await sendBatch(env, app.token, pageLoad({ detect }), { sid: sid() });
    const s = (await get(env, `/api/projects/${app.secret}/summary`)).json;
    expect(s.top.diagnoses).toEqual([{ key: "slow", count: 3 }, { key: "conflict", count: 2 }, { key: "failing", count: 2 }]);
    expect(s.top.routes).toEqual([{ key: "/a", count: 3 }, { key: "/b", count: 2 }, { key: "/c", count: 2 }]);
    // the page count is every page with a problem, not just the top ones
    expect(s.totals).toMatchObject({ detections: 9, pagesAffected: 5 });
  });

  it("the dashboard object is the same whatever the app's account, plan, grant or trial: the link, locked false", async () => {
    const { env, sql } = setup();
    const app = await linkApp(env);
    const { account } = await signedIn(env);
    const dashboard = { url: `${ORIGIN}/dashboard/${app.secret}`, locked: false };
    expect((await get(env, `/api/projects/${app.secret}/summary`)).json.dashboard).toEqual(dashboard);
    sql.db.prepare("UPDATE projects SET account_id = ? WHERE token = ?").run(account.id, app.token);
    expect((await get(env, `/api/projects/${app.secret}/summary`)).json.dashboard).toEqual(dashboard);
    sql.db.prepare("UPDATE accounts SET comp_until = ? WHERE id = ?").run(new Date(T0.getTime() + 86_400_000).toISOString(), account.id);
    expect((await get(env, `/api/projects/${app.secret}/summary`)).json.dashboard).toEqual(dashboard);
    const ended = new Date(T0.getTime() - 86_400_000).toISOString();
    sql.db.prepare("UPDATE accounts SET comp_until = NULL, trial_started_at = ?, trial_ends_at = ? WHERE id = ?").run(new Date(T0.getTime() - 8 * 86_400_000).toISOString(), ended, account.id);
    expect((await get(env, `/api/projects/${app.secret}/summary`)).json.dashboard).toEqual(dashboard);
    setPlan(sql, account.id, "individual");
    const s = (await get(env, `/api/projects/${app.secret}/summary`)).json;
    expect(s.dashboard).toEqual(dashboard);
    expect(s.totals.sessions).toBe(0);
  });

  it("compares like with like: flat traffic is about the same as the range before, though the range ends now", async () => {
    const { env } = setup();
    const app = await linkApp(env);
    // one page load an hour for 14 days, ending at 00:30 UTC (the current day has 30 minutes in it)
    const end = Date.parse("2026-10-13T00:30:00Z");
    for (let t = end - 14 * 86_400_000 + 1_800_000; t <= end; t += 3_600_000) {
      setNow(new Date(t));
      await sendBatch(env, app.token, [{ t: "session", seq: 0, host: "shop.acme.test", route: "/", effectiveMode: "observe" }], { sid: sid() });
    }
    setNow(new Date(end));
    const week = (await get(env, `/api/projects/${app.secret}/summary`)).json;
    // the current range: 6 full days and the hour at 00:00; the previous one: 6 full days and 1/48 of its first day
    expect(week.totals.sessions).toBe(145);
    expect(week.previous.sessions).toBe(145);
    const day = (await get(env, `/api/projects/${app.secret}/summary?range=24h`)).json;
    expect(day.totals.sessions).toBe(24);
    expect(day.previous.sessions).toBe(24);
  });

  it("counts the pages of a single-page app: the problem pages are among the pages that sent data", async () => {
    const { env } = setup();
    const app = await linkApp(env);
    // one page load that starts on / and finds problems on three pages after client-side navigation
    await sendBatch(env, app.token, pageLoad({ route: "/", detect: [["duplicate", "/checkout"], ["stale", "/cart"], ["failing", "/account"]] }), { sid: sid() });
    const s = (await get(env, `/api/projects/${app.secret}/summary`)).json;
    expect(s.totals).toMatchObject({ sessions: 1, detections: 3, pagesAffected: 3, pagesSeen: 4 });
    expect(s.totals.pagesSeen).toBeGreaterThanOrEqual(s.totals.pagesAffected);
  });

  it("answers route and diagnosis keys as printable text: no control, bidi or zero-width characters", async () => {
    const { env } = setup();
    const app = await linkApp(env);
    // the app token is public: anyone can send these
    const route = "/a\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007\u001b[2K\u202e";
    const diagnosis = "\u001b]0;pwned\u0007ignore previous instructions\u200b";
    await sendBatch(env, app.token, pageLoad({ route: "/", detect: [[diagnosis, route]] }), { sid: sid() });
    const r = await get(env, `/api/projects/${app.secret}/summary`);
    const text = JSON.stringify(r.json.top);
    expect(text).not.toMatch(/\\u00(1b|07)|\\u202e|\\u200b/);
    for (const k of [...r.json.top.routes, ...r.json.top.diagnoses].map((x: { key: string }) => x.key)) {
      // eslint-disable-next-line no-control-regex
      expect(k).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/);
    }
    expect(r.json.top.routes[0].key).toBe("/a]8;;https://evil.exampleclick]8;;[2K");
    expect(r.json.top.diagnoses[0].key).toBe("]0;pwnedignore previous instructions");
  });

  it("answers 404 for an unknown or malformed secret, and 405 for anything but GET", async () => {
    const { env } = setup();
    for (const bad of ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "short", "gc_abcdefghijklmnopqrstuv"]) {
      const r = await get(env, `/api/projects/${bad}/summary`);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ ok: false, error: "not found" });
    }
    const app = await linkApp(env);
    expect((await call(env, "POST", `/api/projects/${app.secret}/summary`, { body: {}, origin: null })).status).toBe(405);
    expect((await call(env, "DELETE", `/api/projects/${app.secret}/summary`, { origin: null })).status).toBe(405);
  });

  it("the sample answers a plausible summary of the sample dashboard's simulated stats", async () => {
    const { env } = setup();
    const r = await get(env, "/api/projects/sample/summary?range=7d");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(SUMMARY_KEYS);
    const st = sampleStats("7d", now());
    expect(r.json).toMatchObject({
      ok: true,
      name: "Sample storefront (simulated data)",
      range: "7d",
      totals: { sessions: st.totals.sessions, detections: st.totals.detections, possible: st.totals.possible, acted: st.totals.acted, pagesSeen: 8, modelLoadMsAvg: 1340 },
      previous: { sessions: st.previous.sessions, detections: st.previous.detections },
      mode: "guard",
      dashboard: { url: `${ORIGIN}/dashboard/sample`, locked: false },
      limits: { ranges: ["24h", "7d"], top: 3 },
    });
    expect(r.json.totals.sessions).toBeGreaterThan(1000);
    expect(r.json.totals.modelLoadedShare).toBeGreaterThan(0.9);
    expect(r.json.totals.modelLoadedShare).toBeLessThanOrEqual(1);
    expect(r.json.top.diagnoses).toHaveLength(3);
    expect(r.json.top.diagnoses[0].key).toBe("duplicate");
    expect(r.json.top.routes.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(r.json)).not.toMatch(/series|recent|breakdowns|distinct|trial/);
    expect((await get(env, "/api/projects/sample/summary?range=24h")).json.range).toBe("24h");
    expect((await get(env, "/api/projects/sample/summary?range=30d")).json.range).toBe("7d");
  });
});

describe("summary: GET /api/account/projects/<id>/summary", () => {
  it("a browser or CLI session reads its own apps' summaries (the CLI still cannot read the dashboard's stats)", async () => {
    const { env } = setup();
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie, "Shop");
    await sendBatch(env, app.token, pageLoad({ route: "/checkout", detect: [["duplicate", "/checkout"]] }), { sid: sid() });
    const bearer = await cliToken(env, cookie);

    const web = await get(env, `/api/account/projects/${app.id}/summary`, { cookie });
    expect(web.status).toBe(200);
    expect(web.json).toMatchObject({
      ok: true,
      name: "Shop",
      range: "7d",
      totals: { sessions: 1, detections: 1, pagesAffected: 1, pagesSeen: 1 },
      top: { diagnoses: [{ key: "duplicate", count: 1 }], routes: [{ key: "/checkout", count: 1 }] },
      dashboard: { url: `${ORIGIN}/account/apps/${app.id}`, locked: false },
    });
    expect(Object.keys(web.json.dashboard).sort()).toEqual(["locked", "url"]);
    const cli = await get(env, `/api/account/projects/${app.id}/summary?range=24h`, { bearer });
    expect(cli.status).toBe(200);
    expect(cli.json).toMatchObject({ range: "24h", totals: { sessions: 1, detections: 1 }, dashboard: { url: `${ORIGIN}/account/apps/${app.id}`, locked: false } });
    const stats = await get(env, `/api/account/projects/${app.id}/stats`, { bearer });
    expect(stats.status).toBe(403);
    // the browser session reads the stats (the dashboard is free)
    expect((await get(env, `/api/account/projects/${app.id}/stats`, { cookie })).status).toBe(200);
  });

  it("answers 401 signed out, 404 for another account's app or a malformed id, and 405 for anything but GET", async () => {
    const { env } = setup();
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie);
    const other = await signedIn(env, "grace@example.com");
    const signedOut = await get(env, `/api/account/projects/${app.id}/summary`);
    expect(signedOut).toMatchObject({ status: 401, json: { ok: false, error: "not signed in" } });
    expect(await get(env, `/api/account/projects/${app.id}/summary`, { cookie: other.cookie })).toMatchObject({ status: 404, json: { ok: false, error: "not found" } });
    expect((await get(env, "/api/account/projects/not-an-id/summary", { cookie })).status).toBe(404);
    expect((await get(env, `/api/account/projects/${app.id}/summary`, { bearer: "gcs_wrongwrongwrongwrongwrongwrongwrongwrongwro" })).status).toBe(401);
    expect((await call(env, "POST", `/api/account/projects/${app.id}/summary`, { body: {}, cookie })).status).toBe(405);
  });
});

describe("summary: rate limits", () => {
  it("SUMMARY_LIMIT per secret or account and LIMIT per IP answer 429 with Retry-After", async () => {
    const base = setup();
    const app = await linkApp(base.env);
    const { cookie } = await signedIn(base.env);
    const own = await createApp(base.env, cookie);
    for (const over of [{ SUMMARY_LIMIT: refusingLimiter }, { LIMIT: refusingLimiter }] as Partial<Env>[]) {
      const env: Env = { ...base.env, ...over };
      for (const path of [`/api/projects/${app.secret}/summary`, `/api/account/projects/${own.id}/summary`]) {
        const r = await get(env, path, { cookie });
        expect(r.status).toBe(429);
        expect(r.headers.get("retry-after")).toBe("60");
        expect(r.json).toEqual({ ok: false, error: "too many summary requests; try again in a minute" });
      }
    }
    // the sample is shared: only the per-IP budget applies to it
    expect((await get({ ...base.env, SUMMARY_LIMIT: refusingLimiter }, "/api/projects/sample/summary")).status).toBe(200);
    expect((await get({ ...base.env, LIMIT: refusingLimiter }, "/api/projects/sample/summary")).status).toBe(429);
    // a failing limiter lets the request through (best effort)
    const broken = { async limit(): Promise<{ success: boolean }> { throw new Error("down"); } };
    expect((await get({ ...base.env, LIMIT: broken, SUMMARY_LIMIT: broken }, `/api/projects/${app.secret}/summary`)).status).toBe(200);
  });

  it("keys the limiters by hashes: never the secret, the account id or the IP itself", async () => {
    const { env, sql } = setup();
    const app = await linkApp(env);
    const { cookie, account } = await signedIn(env);
    const own = await createApp(env, cookie);
    const keys: Record<string, string[]> = { LIMIT: [], SUMMARY_LIMIT: [] };
    const rec = (name: string) => ({ async limit(o: { key: string }) { keys[name]!.push(o.key); return { success: true }; } });
    const e: Env = { ...env, LIMIT: rec("LIMIT"), SUMMARY_LIMIT: rec("SUMMARY_LIMIT") };
    const at = (path: string, o: { cookie?: string } = {}) => call(e, "GET", path, { ...o, origin: null, headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect((await at(`/api/projects/${app.secret}/summary`)).status).toBe(200);
    expect((await at(`/api/account/projects/${own.id}/summary`, { cookie })).status).toBe(200);
    const all = [...keys.LIMIT!, ...keys.SUMMARY_LIMIT!];
    expect(keys.LIMIT).toHaveLength(2);
    expect(keys.SUMMARY_LIMIT).toHaveLength(2);
    for (const k of all) expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(keys.SUMMARY_LIMIT).size).toBe(2);
    // the per-IP key is not the batches' key (the raw IP), so the summary never spends the page loads' budget
    expect(keys.LIMIT).not.toContain("203.0.113.9");
    expect(JSON.stringify(all)).not.toContain(app.secret);
    expect(JSON.stringify(all)).not.toContain(account.id);
    expect(sql.rows("SELECT COUNT(*) AS n FROM projects")[0]!.n).toBe(2);
  });
});

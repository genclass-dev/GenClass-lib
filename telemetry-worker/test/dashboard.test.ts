import { beforeEach, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import worker from "../src/index.js";
import { handle, MAX_PROJECTS_PER_MINUTE, validate, type Env } from "../src/collector.js";
import { aggregate, RECENT_CAP, resetTokenCache, retention, sanitizeName, SESSION_KEEP_MS, sha256Hex, stats, TOKEN_RE, type D1Like, type D1Stmt } from "../src/dashboard.js";
import { sampleStats } from "../src/sample.js";
import { MIGRATIONS } from "./d1.js";

// On the plans as they were before 2026-10-19 (test/fixtures/plans-two-paid.json), where Free has no dashboard, so the
// locked private link stays tested. With the real plans (test/plans.test.ts) every private link opens its dashboard.
vi.mock("../../billing/plans.json", async () => ({ default: (await import("./fixtures/plans-two-paid.json")).default }));

// D1 stand-in backed by node:sqlite running the real migrations (all of them, in order), so the SQL itself is under test.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const MIGRATION = MIGRATIONS;

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION);
  let batches = 0;
  // holdReads(n): the next n reads of page-load state wait for each other, so n batches of one page load all read the
  // same state before any of them writes (what concurrent requests to the worker can do)
  let gate: { n: number; waiting: (() => void)[] } | null = null;
  type Stmt = D1Stmt & { sync(): { results: unknown[] } };
  const stmt = (sql: string, params: unknown[] = []): Stmt => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async <T>() => {
      if (gate && sql.startsWith("SELECT counts FROM sessions")) {
        const g = gate;
        await new Promise<void>((go) => {
          g.waiting.push(go);
          if (g.waiting.length >= g.n) {
            gate = null;
            for (const w of g.waiting) w();
          }
        });
      }
      return (db.prepare(sql).get(...(params as never[])) ?? null) as T | null;
    },
    all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
    run: async () => db.prepare(sql).run(...(params as never[])),
    sync: () => ({ results: db.prepare(sql).all(...(params as never[])) }),
  });
  const api: D1Like = {
    prepare: (sql) => stmt(sql),
    // one transaction, run without yielding (D1 runs a batch as one serialized transaction)
    async batch(stmts) {
      batches++;
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => (s as Stmt).sync());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return {
    api,
    db,
    rows: (sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as Record<string, unknown>[],
    batches: () => batches,
    holdReads: (n: number) => {
      gate = { n, waiting: [] };
    },
  };
}

function setup(limiter?: Env["CREATE_LIMITER"]) {
  const puts: { key: string; body: Uint8Array }[] = [];
  const sql = d1();
  const env: Env = {
    BUCKET: {
      async put(key: string, value: ArrayBuffer | Uint8Array) {
        puts.push({ key, body: value instanceof Uint8Array ? value : new Uint8Array(value) });
      },
    },
    DB: sql.api,
    CREATE_LIMITER: limiter,
  };
  return { env, puts, sql };
}

const NOW = new Date("2026-10-08T12:00:00Z");
let uuidN = 0;
const opts = { now: () => NOW, uuid: () => `u-${++uuidN}` };

async function create(env: Env, body: unknown = { name: "Acme checkout" }, ip = "203.0.113.7") {
  const res = await handle(
    new Request("https://genclass.dev/api/projects", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "cf-connecting-ip": ip } }),
    env,
    opts,
  );
  return { res, json: (await res.json()) as Record<string, string> };
}

function post(body: unknown) {
  const r = new Request("https://genclass-telemetry.example.workers.dev/v1/events", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "text/plain;charset=UTF-8" } });
  Object.defineProperty(r, "cf", { value: { country: "CA", city: "Toronto" } });
  return r;
}

const secretOf = (url: string) => url.split("/").pop()!;

/**
 * On the fixture's plans a private link opens its stats only while the app's account has a plan with the dashboard or
 * GenClass's grant. This puts the app in an account with the grant (accounts.comp_until), so the tests below read the
 * stats through the link as before.
 */
let unlocked = 0;
function unlock(sql: ReturnType<typeof d1>, token: string): void {
  const id = `Comped${String(++unlocked).padStart(16, "0")}`;
  sql.db.prepare("INSERT INTO accounts (id, email, created, comp_until) VALUES (?, ?, ?, '9999-12-31T00:00:00.000Z')").run(id, `owner${unlocked}@example.com`, NOW.toISOString());
  sql.db.prepare("UPDATE projects SET account_id = ? WHERE token = ?").run(id, token);
}

/** A realistic page load, shaped like packages/runtime/src/telemetry/client.ts emits it. */
function pageBatch(token: string | undefined, sid = "3f9c0a1b2c3d4e5f60718293", extra: Record<string, unknown>[] = []) {
  return {
    schema: "genclass-telemetry/1",
    sid,
    sent: 12034,
    runtime: "0.1.0-beta.5",
    model: "2.0.0-rc4t",
    ...(token === undefined ? {} : { token }),
    events: [
      { t: "session", seq: 0, at: 1, runtime: "0.1.0-beta.5", host: "shop.acme.test", route: "/cart/:id", mode: "heal", effectiveMode: "heal", aggressiveness: 0.5, sampled: true, model: "local", modelState: "loading", modelVersion: "2.0.0-rc4t", device: { webgpu: true, cores: 8 }, sample: 1, situation: true },
      { t: "model", seq: 1, at: 900, state: "ready", version: "2.0.0-rc4t", device: "webgpu", loadMs: 840, fromCache: true },
      { t: "decision", seq: 2, at: 1200, id: "d1", trigger: "mutation", route: "/cart/:id", fn: "saveCart", model: "genclass-2", latencyMs: 42, held: true, situation: "SECRET SITUATION TEXT op saveCart", diagnosis: "stale", diagnosisConfidence: 0.97, action: "discard", confidence: 0.95, tier: "guard", ran: "discard", executed: true, acted: true, effectiveMode: "heal" },
      { t: "detect", seq: 3, at: 1201, decision: "d1", trigger: "mutation", diagnosis: "stale", p: 0.97 },
      { t: "action", seq: 4, at: 1202, id: "a1", decision: "d1", action: "discard", tier: "guard", trigger: "mutation", outcome: "applied", reversible: true },
      { t: "decision", seq: 5, at: 2000, id: "d2", trigger: "response", route: "/cart/:id", model: "genclass-2", latencyMs: 180, situation: "more text", diagnosis: "expected", action: "proceed", confidence: 0.99, tier: "passive", ran: "proceed", executed: true, acted: false, effectiveMode: "heal" },
      { t: "model-error", seq: 6, at: 2100, code: "inference_failed", message: "x" },
      { t: "action", seq: 7, at: 3000, id: "a1", decision: "d1", action: "discard", tier: "guard", trigger: "mutation", outcome: "undone" },
      { t: "summary", seq: 8, at: 4000, reason: "hidden", counts: { decisions: 2, failOpen: { "timeout:response": 2 }, modelErrors: { inference_failed: 1 } } },
      ...extra,
    ],
  };
}

beforeEach(() => resetTokenCache());

describe("project creation", () => {
  it("creates a project: token, private dashboard link, only the secret's hash stored", async () => {
    const { env, sql } = setup();
    const { res, json } = await create(env, { name: "  Acme\u0000 checkout\n\u202e " });
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(json.token).toMatch(TOKEN_RE);
    expect(json.dashboardUrl).toMatch(/^https:\/\/genclass\.dev\/dashboard\/[A-Za-z0-9]{32}$/);
    expect(json.name).toBe("Acme checkout");
    expect(json.created).toBe(NOW.toISOString());
    const rows = sql.rows("SELECT * FROM projects");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).toBe(json.token);
    expect(rows[0]!.secret_hash).toBe(await sha256Hex(secretOf(json.dashboardUrl)));
    expect(JSON.stringify(rows)).not.toContain(secretOf(json.dashboardUrl));
  });

  it("names: optional, sanitised, at most 80 chars; bad bodies rejected; CORS preflight", async () => {
    const { env } = setup();
    expect((await create(env, {})).json.name).toBe("Untitled app");
    expect((await create(env, { name: 42 })).json.name).toBe("Untitled app");
    expect([...(await create(env, { name: "x".repeat(200) })).json.name]).toHaveLength(80);
    expect(sanitizeName("<b>hi</b>")).toBe("<b>hi</b>"); // stored as text; pages escape it
    const empty = await handle(new Request("https://genclass.dev/api/projects", { method: "POST" }), env, opts);
    expect(empty.status).toBe(201);
    const bad = await handle(new Request("https://genclass.dev/api/projects", { method: "POST", body: "{nope" }), env, opts);
    expect(bad.status).toBe(400);
    expect((await handle(new Request("https://genclass.dev/api/projects", { method: "POST", body: "[1]" }), env, opts)).status).toBe(400);
    const pre = await handle(new Request("https://genclass.dev/api/projects", { method: "OPTIONS" }), env, opts);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect((await handle(new Request("https://genclass.dev/api/projects"), env, opts)).status).toBe(405);
  });

  it("rate-limits creation per client without passing the IP to the limiter", async () => {
    const keys: string[] = [];
    const counts = new Map<string, number>();
    const { env, sql } = setup({
      async limit({ key }) {
        keys.push(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return { success: counts.get(key)! <= 10 };
      },
    });
    for (let i = 0; i < 10; i++) expect((await create(env)).res.status).toBe(201);
    const r = await create(env);
    expect(r.res.status).toBe(429);
    expect(r.json).toMatchObject({ ok: false });
    expect(r.res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await create(env, {}, "198.51.100.9")).res.status).toBe(201);
    expect(keys.join()).not.toContain("203.0.113.7");
    expect(sql.rows("SELECT COUNT(*) AS n FROM projects")[0]!.n).toBe(11);
  });
  it("has a global ceiling on new projects per minute, independent of the per-client limiter", async () => {
    const { env } = setup();
    for (let i = 0; i < MAX_PROJECTS_PER_MINUTE; i++) expect((await create(env, {}, `198.51.100.${i}`)).res.status).toBe(201);
    expect((await create(env, {}, "192.0.2.1")).res.status).toBe(429);
    const later = await handle(
      new Request("https://genclass.dev/api/projects", { method: "POST", body: "{}" }),
      env,
      { ...opts, now: () => new Date(NOW.getTime() + 61_000) },
    );
    expect(later.status).toBe(201);
  });
});

describe("token on telemetry batches", () => {
  it("validate keeps a well-formed token and drops a malformed one without rejecting the batch", () => {
    const ok = validate(pageBatch("gc_abcdefghijklmnopqrstuv"));
    expect(typeof ok !== "string" && ok.token).toBe("gc_abcdefghijklmnopqrstuv");
    for (const t of ["gc_short", "xx_abcdefghijklmnopqrstuv", "gc_abcdefghijklmnopqrst-v", 7, null]) {
      const b = validate(pageBatch(t as string));
      expect(typeof b).not.toBe("string");
      expect(b).not.toHaveProperty("token");
    }
  });

  it("aggregates a known token's batch for its dashboard (and still stores the raw batch, with the token, in R2)", async () => {
    const { env, puts, sql } = setup();
    const { json } = await create(env);
    const res = await handle(post(pageBatch(json.token)), env, opts);
    expect(res.status).toBe(202);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toMatch(/^events\/dt=2026-10-08\/rt=0\.1\.0-beta\.5\/model=2\.0\.0-rc4t\/u-\d+\.jsonl\.gz$/);
    const line = JSON.parse(gunzipSync(puts[0]!.body).toString("utf8").split("\n")[0]!);
    expect(line).toMatchObject({ sid: "3f9c0a1b2c3d4e5f60718293", token: json.token, country: "CA", event: { t: "session" } });

    // the dashboard store never holds situation text, sid or the secret
    const dump = JSON.stringify([sql.rows("SELECT * FROM daily"), sql.rows("SELECT * FROM hourly"), sql.rows("SELECT * FROM recent"), sql.rows("SELECT * FROM sessions")]);
    expect(dump).not.toMatch(/SECRET SITUATION|more text|3f9c0a1b2c3d4e5f60718293/);
    expect(sql.rows("SELECT last_event FROM projects")[0]!.last_event).toBe(NOW.toISOString());

    // collected without an account; its link shows the stats once the app's account has Pro (here GenClass's grant)
    unlock(sql, json.token);
    const st = await handle(new Request(`https://genclass.dev/api/projects/${secretOf(json.dashboardUrl)}?range=7d`), env, opts);
    expect(st.status).toBe(200);
    expect(st.headers.get("referrer-policy")).toBe("no-referrer");
    const s = (await st.json()) as Record<string, any>;
    expect(s).toMatchObject({ name: "Acme checkout", token: json.token, lastEvent: NOW.toISOString(), range: "7d" });
    expect(s.totals).toMatchObject({ sessions: 1, decisions: 2, detections: 1, acted: 1, executed: 2, model_ready: 1, latencyAvgMs: 111, modelLoadAvgMs: 840, failOpens: 2, modelErrors: 1, interventions: 1 });
    const bd = (m: string) => Object.fromEntries((s.breakdowns[m] ?? []).map((x: any) => [x.key, x.count]));
    expect(bd("detect_diagnosis")).toEqual({ stale: 1 });
    expect(bd("diagnosis")).toEqual({ stale: 1, expected: 1 });
    expect(bd("intervention")).toEqual({ discard: 1 });
    expect(bd("action_outcome")).toEqual({ applied: 1, undone: 1 });
    expect(bd("route")).toEqual({ "/cart/:id": 2 });
    expect(bd("fn")).toEqual({ saveCart: 1 });
    expect(bd("fn_detect")).toEqual({ saveCart: 1 });
    expect(bd("fn_acted")).toEqual({ saveCart: 1 });
    expect(bd("backend")).toEqual({ webgpu: 1 });
    expect(bd("host")).toEqual({ "shop.acme.test": 1 });
    expect(bd("runtime")).toEqual({ "0.1.0-beta.5": 1 });
    expect(bd("model_version")).toEqual({ "2.0.0-rc4t": 1 });
    expect(bd("fail_open")).toEqual({ "timeout:response": 2 });
    expect(bd("model_errors")).toEqual({ inference_failed: 1 });
    expect(bd("latency_bucket")).toEqual({ "<50 ms": 1, "100-250 ms": 1 });
    expect(s.series).toHaveLength(7);
    expect(s.series.at(-1)).toEqual({ bucket: "2026-10-08", sessions: 1, decisions: 2, detections: 1, acted: 1, possible: 0, ix_views: 0, ix_sessions: 0 });
    // the dashboard's type x page view and per-type timeline, and the period before for deltas
    expect(bd("detect_issue")).toEqual({ "stale\t/cart/:id": 1 });
    expect(s.typeSeries).toHaveLength(7);
    expect(s.typeSeries.at(-1)).toEqual({ bucket: "2026-10-08", counts: { stale: 1 } });
    expect(s.typeSeries[0]).toEqual({ bucket: "2026-10-02", counts: {} });
    expect(s.previous).toEqual({ sessions: 0, detections: 0, acted: 0, ix_views: 0, ix_sessions: 0 });
    expect(s.recent).toEqual([
      // the diagnosis confidence (0.97), not p(action) (0.95)
      { t: NOW.toISOString(), route: "/cart/:id", fn: "saveCart", trigger: "mutation", diagnosis: "stale", action: "discard", ran: "discard", confidence: 0.97, mode: "heal", executed: true, acted: true, kind: "detect" },
    ]);
    expect(JSON.stringify(s)).not.toContain("SITUATION");

    // 24 h (hourly) and 30 d windows
    const h = (await (await handle(new Request(`https://genclass.dev/api/projects/${secretOf(json.dashboardUrl)}?range=24h`), env, opts)).json()) as any;
    expect(h.series).toHaveLength(24);
    expect(h.series.at(-1)).toMatchObject({ bucket: "2026-10-08T12", sessions: 1 });
    expect(h.totals.decisions).toBe(2);
    expect(h.typeSeries).toHaveLength(24);
    expect(h.typeSeries.at(-1)).toEqual({ bucket: "2026-10-08T12", counts: { stale: 1 } });
    // a later 7 d window sees this week as the previous period
    const later = (await (await handle(new Request(`https://genclass.dev/api/projects/${secretOf(json.dashboardUrl)}?range=7d`), env, { ...opts, now: () => new Date(NOW.getTime() + 7 * 86_400_000) })).json()) as any;
    expect(later.previous).toEqual({ sessions: 1, detections: 1, acted: 1, ix_views: 0, ix_sessions: 0 });
    expect(later.totals.detections ?? 0).toBe(0);
    const m = (await (await handle(new Request(`https://genclass.dev/api/projects/${secretOf(json.dashboardUrl)}?range=30d`), env, opts)).json()) as any;
    expect(m.series).toHaveLength(30);
  });

  it("counts cumulative summaries once per page load (deltas) and aggregates in one D1 batch", async () => {
    const { env, sql } = setup();
    const { json } = await create(env);
    unlock(sql, json.token);
    await handle(post(pageBatch(json.token)), env, opts);
    const before = sql.batches();
    // the same page later sends a bigger cumulative summary
    await handle(
      post({ ...pageBatch(json.token), events: [{ t: "summary", seq: 20, at: 9000, reason: "pagehide", counts: { failOpen: { "timeout:response": 3, "busy:mutation": 1 }, modelErrors: { inference_failed: 1 } } }] }),
      env,
      opts,
    );
    expect(sql.batches() - before).toBe(1);
    const s = (await (await handle(new Request(`https://genclass.dev/api/projects/${secretOf(json.dashboardUrl)}`), env, opts)).json()) as any;
    expect(s.totals.failOpens).toBe(4);
    expect(s.totals.modelErrors).toBe(1);
  });

  it("caps recent rows per token", async () => {
    const { env, sql } = setup();
    const { json } = await create(env);
    const acted = (i: number) => ({ t: "decision", seq: i, at: i, id: `d${i}`, trigger: "mutation", diagnosis: "stale", action: "discard", ran: "discard", executed: true, acted: true });
    for (let b = 0; b < 6; b++) {
      await handle(post({ ...pageBatch(json.token), events: Array.from({ length: 100 }, (_, i) => acted(b * 100 + i)) }), env, opts);
    }
    expect(sql.rows("SELECT COUNT(*) AS n FROM recent")[0]!.n).toBe(RECENT_CAP);
    expect(sql.rows("SELECT MIN(id) AS lo, MAX(id) AS hi FROM recent")[0]).toEqual({ lo: 101, hi: 600 });
  });

  it("unknown, malformed or missing tokens: stored in R2 exactly as before, nothing aggregated", async () => {
    const { env, puts, sql } = setup();
    await create(env);
    for (const token of ["gc_unknownunknownunknown1", "not-a-token", undefined]) {
      const res = await handle(post(pageBatch(token)), env, opts);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, accepted: 9 });
    }
    expect(puts).toHaveLength(3);
    const first = (i: number) => JSON.parse(gunzipSync(puts[i]!.body).toString("utf8").split("\n")[0]!);
    expect(first(0).token).toBe("gc_unknownunknownunknown1");
    // old clients (no token) and malformed tokens: the exact pre-dashboard record shape
    for (const i of [1, 2]) expect(Object.keys(first(i))).toEqual(["sid", "runtime", "model", "sent", "receivedAt", "country", "event"]);
    expect(sql.rows("SELECT COUNT(*) AS n FROM daily")[0]!.n).toBe(0);
    expect(sql.rows("SELECT COUNT(*) AS n FROM recent")[0]!.n).toBe(0);
  });

  it("a D1 failure never fails ingest", async () => {
    const { env, puts } = setup();
    const { json } = await create(env);
    env.DB = { prepare: () => { throw new Error("d1 down"); }, batch: async () => { throw new Error("d1 down"); } };
    const res = await handle(post(pageBatch(json.token)), env, opts);
    expect(res.status).toBe(202);
    expect(puts).toHaveLength(1);
  });

  it("works without a DB binding (plain collector)", async () => {
    const { env, puts } = setup();
    delete env.DB;
    expect((await handle(post(pageBatch("gc_abcdefghijklmnopqrstuv")), env, opts)).status).toBe(202);
    expect(puts).toHaveLength(1);
  });
});

describe("dashboard pages", () => {
  it("serves the dashboard for a valid secret with strict headers; 404 otherwise", async () => {
    const { env, sql } = setup();
    const { json } = await create(env, { name: "</script><img src=x onerror=alert(1)>" });
    unlock(sql, json.token);
    const res = await handle(new Request(json.dashboardUrl), env, opts);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toMatch(/default-src 'none'; script-src 'nonce-[A-Za-z0-9]{22}'/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const body = await res.text();
    const nonce = /nonce-([A-Za-z0-9]{22})/.exec(csp)![1]!;
    expect(body).toContain(`<script nonce="${nonce}">`);
    expect(body).toContain(json.token);
    expect(body).not.toContain("</script><img");
    expect(body).not.toMatch(/ style="/);
    expect(body).not.toContain(secretOf(json.dashboardUrl));

    for (const bad of ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "short", "../../etc"]) {
      expect((await handle(new Request(`https://genclass.dev/dashboard/${bad}`), env, opts)).status).toBe(404);
      expect((await handle(new Request(`https://genclass.dev/api/projects/${bad}`), env, opts)).status).toBe(404);
    }
    const st = await handle(new Request(`https://genclass.dev/api/projects/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`), env, opts);
    expect(await st.json()).toEqual({ ok: false, error: "not found" });
  });

  it("a private link whose plan has no dashboard opens the locked page, its stats answer 402, and ingest keeps collecting", async () => {
    const { env, sql } = setup();
    const { json } = await create(env, { name: "Old shop" });
    expect((await handle(post(pageBatch(json.token)), env, opts)).status).toBe(202);
    // collected while locked, so a plan starts with recent data
    expect(sql.rows("SELECT COUNT(*) AS n FROM daily WHERE token = ?", json.token)[0]!.n).toBeGreaterThan(0);
    const page = await handle(new Request(json.dashboardUrl), env, opts);
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain("This app's plan has no dashboard.");
    expect(html).toContain("See the plans to open it.");
    expect(html).not.toMatch(/trial/i);
    expect(html).toContain("Old shop");
    expect(html).not.toContain(secretOf(json.dashboardUrl));
    expect(html).not.toContain("/api/projects/");
    expect(html).not.toMatch(/ style="/);
    const st = await handle(new Request(`https://genclass.dev/api/projects/${secretOf(json.dashboardUrl)}?range=7d`), env, opts);
    expect(st.status).toBe(402);
    expect(await st.json()).toEqual({ ok: false, error: "this app's plan has no dashboard; see the plans at https://genclass.dev/account/billing", locked: true });
    // GenClass's grant (or a plan with the dashboard) on the app's account opens both
    unlock(sql, json.token);
    expect(await (await handle(new Request(json.dashboardUrl), env, opts)).text()).not.toContain("This app's plan has no dashboard.");
    expect((await handle(new Request(`https://genclass.dev/api/projects/${secretOf(json.dashboardUrl)}?range=7d`), env, opts)).status).toBe(200);
    // the simulated sample stays open to everyone
    expect((await handle(new Request("https://genclass.dev/api/projects/sample?range=7d"), env, opts)).status).toBe(200);
  });

  it("serves /start, redirects /dashboard, and passes other genclass.dev paths to the site", async () => {
    const { env, sql } = setup();
    const start = await handle(new Request("https://genclass.dev/start"), env, opts);
    expect(start.status).toBe(200);
    const html = await start.text();
    expect(html).toContain("Get a token");
    expect(html).toContain("The dashboard is free.");
    expect(html).not.toMatch(/trial/i);
    expect(html).not.toContain("Free, no account");
    expect(html).toContain('fetch("/api/projects"');
    expect(html).toContain("https://cdn.jsdelivr.net/npm/@genclass/runtime");
    expect((await handle(new Request("https://genclass.dev/dashboard"), env, opts)).headers.get("location")).toBe("/start");
    // the open-source parts with no account: a static page under the same nonce CSP, nothing written
    const TABLES = ["projects", "accounts", "auth_sessions", "challenges", "sessions"];
    const rowsBefore: Record<string, unknown> = Object.fromEntries(TABLES.map((t) => [t, sql.rows(`SELECT COUNT(*) AS n FROM ${t}`)[0]!.n]));
    const oss = await handle(new Request("https://genclass.dev/start/open-source"), env, opts);
    expect(oss.status).toBe(200);
    expect(oss.headers.get("cache-control")).toBe("no-store");
    expect(oss.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[A-Za-z0-9]+'/);
    const ossHtml = await oss.text();
    expect(ossHtml).toContain("GenClass without an account");
    expect(ossHtml).toContain("Copy the prompt for your coding agent");
    expect(ossHtml).not.toContain('fetch("/api/projects"');
    expect((await handle(new Request("https://genclass.dev/start/open-source", { method: "HEAD" }), env, opts)).status).toBe(200);
    for (const t of TABLES) expect(sql.rows(`SELECT COUNT(*) AS n FROM ${t}`)[0]!.n, t).toBe(rowsBefore[t]);
    const seen: string[] = [];
    const passthrough = async (r: Request) => {
      seen.push(new URL(r.url).pathname);
      return new Response("site", { status: 200 });
    };
    expect(await (await handle(new Request("https://genclass.dev/starter-kit"), env, { ...opts, passthrough })).text()).toBe("site");
    expect(seen).toEqual(["/starter-kit"]);
    // /start/open-source answers GET and HEAD only; anything else falls through to the site, as /start does
    expect(await (await handle(new Request("https://genclass.dev/start/open-source", { method: "POST" }), env, { ...opts, passthrough })).text()).toBe("site");
    expect(seen).toEqual(["/starter-kit", "/start/open-source"]);
    // on workers.dev nothing is passed through
    expect((await handle(new Request("https://x.workers.dev/starter-kit"), env, { ...opts, passthrough })).status).toBe(404);
    expect((await handle(new Request("https://genclass.dev/api/nope"), env, { ...opts, passthrough })).status).toBe(404);
  });
});

describe("retention", () => {
  it("deletes daily/recent rows older than 90 days, hourly older than 48 h, summary state older than 2 days", async () => {
    const { env, sql } = setup();
    const { json } = await create(env);
    const db = sql.db;
    const ins = db.prepare("INSERT INTO daily (token, day, metric, key, count) VALUES (?, ?, 'sessions', '', 1)");
    for (const d of ["2026-07-09", "2026-07-10", "2026-10-08"]) ins.run(json.token, d);
    const insH = db.prepare("INSERT INTO hourly (token, hour, metric, key, count) VALUES (?, ?, 'sessions', '', 1)");
    for (const h of ["2026-10-06T11", "2026-10-06T12", "2026-10-08T12"]) insH.run(json.token, h);
    const insR = db.prepare("INSERT INTO recent (token, t, kind) VALUES (?, ?, 'detect')");
    for (const t of ["2026-07-10T11:00:00.000Z", "2026-07-10T13:00:00.000Z"]) insR.run(json.token, t);
    const insS = db.prepare("INSERT INTO sessions (sid_hash, token, day, counts) VALUES (?, ?, ?, '{}')");
    insS.run("a", json.token, "2026-10-05");
    insS.run("b", json.token, "2026-10-06");

    await retention(sql.api, NOW);
    expect(sql.rows("SELECT day FROM daily ORDER BY day").map((r) => r.day)).toEqual(["2026-07-10", "2026-10-08"]);
    expect(sql.rows("SELECT hour FROM hourly ORDER BY hour").map((r) => r.hour)).toEqual(["2026-10-06T12", "2026-10-08T12"]);
    expect(sql.rows("SELECT t FROM recent").map((r) => r.t)).toEqual(["2026-07-10T13:00:00.000Z"]);
    expect(sql.rows("SELECT sid_hash FROM sessions").map((r) => r.sid_hash)).toEqual(["b"]);
    expect(sql.rows("SELECT COUNT(*) AS n FROM projects")[0]!.n).toBe(1);
  });

  it("the scheduled handler runs the sweep", async () => {
    const { env, sql } = setup();
    sql.db.prepare("INSERT INTO daily (token, day, metric, key, count) VALUES ('gc_x', '2020-01-01', 'sessions', '', 1)").run();
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    expect(sql.rows("SELECT COUNT(*) AS n FROM daily")[0]!.n).toBe(0);
  });
});

describe("sample dashboard", () => {
  it("serves a labelled, simulated sample at /dashboard/sample without touching D1", async () => {
    const { env } = setup();
    const page = await handle(new Request("https://genclass.dev/dashboard/sample"), env, opts);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("simulated data");
    expect(html).not.toMatch(/ style="/);
    for (const range of ["24h", "7d", "30d"]) {
      const res = await handle(new Request(`https://genclass.dev/api/projects/sample?range=${range}`), env, opts);
      expect(res.status).toBe(200);
      const s = (await res.json()) as any;
      expect(s.name).toContain("simulated");
      expect(s.typeSeries).toHaveLength(range === "24h" ? 24 : range === "7d" ? 7 : 30);
      expect(s.totals.sessions).toBeGreaterThan(0);
      const issues = (s.breakdowns.detect_issue as { count: number }[]).reduce((a, x) => a + x.count, 0);
      expect(issues).toBe(s.totals.detections);
    }
    const again = (await (await handle(new Request("https://genclass.dev/api/projects/sample?range=7d"), env, opts)).json()) as any;
    const first = (await (await handle(new Request("https://genclass.dev/api/projects/sample?range=7d"), env, opts)).json()) as any;
    expect(again.typeSeries).toEqual(first.typeSeries); // deterministic for the same time
  });
});

// ------------------------------------------------------------------------------------------ exact totals

const SID = "a1b2c3d4e5f6a7b8c9d0e1f2";
const TOK = "gc_abcdefghijklmnopqrstuv";
const PROJ = { token: TOK, name: "t", created: NOW.toISOString(), last_event: null };
type E = Record<string, unknown>;
const batchOf = (events: E[], runtime = "0.3.0-beta.0") => ({ sid: SID, runtime, model: "2.0.0-rc4t", events });
const sess = (): E => ({ t: "session", seq: 0, at: 0, host: "shop.example", route: "/", effectiveMode: "observe" });
const dec = (seq: number, id: string, o: E = {}): E => ({
  t: "decision", seq, at: seq * 10, id, trigger: "delivery", route: "/search", diagnosis: "stale", diagnosisConfidence: 0.95, gates: { report: 0.9, guard: 0.95, heal: 0.9 },
  action: "deliver", confidence: 0.9, ran: "deliver", executed: true, acted: false, effectiveMode: "observe", ...o,
});
const det = (seq: number, id: string, diagnosis = "stale", p = 0.95): E => ({ t: "detect", seq, at: seq * 10, decision: id, trigger: "delivery", diagnosis, p });
const summ = (seq: number, counts: E, extra: E = {}): E => ({ t: "summary", seq, at: seq * 10, reason: "periodic", counts, ...extra });
const statsOf = (sql: ReturnType<typeof d1>) => stats(sql.api, PROJ, "7d", NOW);
const bdOf = (s: Awaited<ReturnType<typeof stats>>, m: string) => Object.fromEntries((s.breakdowns[m] ?? []).map((x) => [x.key, x.count]));
const stateOf = (sql: ReturnType<typeof d1>) => JSON.parse(String(sql.rows("SELECT counts FROM sessions")[0]!.counts));

describe("exact totals from page-load summaries (high-water marks per page load)", () => {
  it("counts cumulative summaries once: a repeated batch, a bigger summary, a late older one, a partial one", async () => {
    const { sql } = setup();
    const first = [
      sess(), dec(1, "d1"), det(2, "d1"), dec(3, "d2", { diagnosis: "expected", diagnosisConfidence: 0.99 }), dec(4, "d3", { trigger: "request", diagnosis: "duplicate" }), det(5, "d3", "duplicate"),
      summ(6, { decisions: 3, acted: 0, detections: 2, byTrigger: { delivery: 2, request: 1 }, byDiagnosis: { stale: 1, expected: 1, duplicate: 1 }, detectionsByDiagnosis: { stale: 1, duplicate: 1 } }),
    ];
    await aggregate(sql.api, TOK, batchOf(first), NOW);
    let s = await statsOf(sql);
    expect(s.totals).toMatchObject({ sessions: 1, decisions: 3, detections: 2 });

    // the same request again: nothing changes, not even the event-only counters or the recent rows
    const recentRows = sql.rows("SELECT COUNT(*) AS n FROM recent")[0]!.n;
    await aggregate(sql.api, TOK, batchOf(first), NOW);
    s = await statsOf(sql);
    expect(s.totals).toMatchObject({ sessions: 1, decisions: 3, detections: 2 });
    expect(bdOf(s, "route")).toEqual({ "/search": 3 });
    expect(sql.rows("SELECT COUNT(*) AS n FROM recent")[0]!.n).toBe(recentRows);

    // a later summary from a client that sent few decision records (sampling, per-page caps): totals follow it
    await aggregate(sql.api, TOK, batchOf([dec(7, "d7"), summ(40, { decisions: 500, acted: 0, detections: 260, byTrigger: { delivery: 380, request: 120 }, byDiagnosis: { stale: 300, expected: 140, duplicate: 60 }, detectionsByDiagnosis: { stale: 200, duplicate: 60 } })]), NOW);
    s = await statsOf(sql);
    expect(s.totals).toMatchObject({ sessions: 1, decisions: 500, detections: 260 });
    expect(bdOf(s, "detect_diagnosis")).toEqual({ stale: 200, duplicate: 60 });
    expect(bdOf(s, "trigger")).toEqual({ delivery: 380, request: 120 });
    expect(bdOf(s, "diagnosis")).toEqual({ stale: 300, expected: 140, duplicate: 60 });
    expect(s.series.at(-1)).toMatchObject({ sessions: 1, decisions: 500, detections: 260 });
    expect(s.typeSeries.at(-1)!.counts).toEqual({ stale: 200, duplicate: 60 });

    // an older summary arriving late and one without some fields never lower or double anything
    await aggregate(sql.api, TOK, batchOf([summ(20, { decisions: 120, detections: 70, detectionsByDiagnosis: { stale: 70 } })]), NOW);
    await aggregate(sql.api, TOK, batchOf([summ(41, { failOpen: { "not-ready:delivery": 2 } })]), NOW);
    s = await statsOf(sql);
    expect(s.totals).toMatchObject({ sessions: 1, decisions: 500, detections: 260, failOpens: 2 });
    // pages and routes come from the records that arrived
    expect(bdOf(s, "route")).toEqual({ "/search": 4 });
    expect(s.totals.detectionsWithPage).toBe(2);
  });

  it("a split flush counts once whichever part is processed first, and when both parts are processed at once", async () => {
    const partA = [sess(), dec(1, "d1"), det(2, "d1"), dec(3, "d2", { diagnosis: "expected", diagnosisConfidence: 0.99 })];
    const partB = [dec(4, "d3"), det(5, "d3"), summ(6, { decisions: 3, acted: 0, detections: 2, byTrigger: { delivery: 3 }, detectionsByDiagnosis: { stale: 2 } })];
    for (const order of ["a,b", "b,a", "concurrent"]) {
      const { sql } = setup();
      if (order === "concurrent") {
        sql.holdReads(2); // both read the page load's state before either writes
        await Promise.all([aggregate(sql.api, TOK, batchOf(partA), NOW), aggregate(sql.api, TOK, batchOf(partB), NOW)]);
      } else {
        for (const part of order === "a,b" ? [partA, partB] : [partB, partA]) await aggregate(sql.api, TOK, batchOf(part), NOW);
      }
      const s = await statsOf(sql);
      expect(s.totals, order).toMatchObject({ sessions: 1, decisions: 3, detections: 2 });
      expect(bdOf(s, "detect_diagnosis"), order).toEqual({ stale: 2 });
      expect(bdOf(s, "trigger"), order).toEqual({ delivery: 3 });
      expect(bdOf(s, "diagnosis"), order).toEqual({ stale: 2, expected: 1 }); // not in this summary: from the events
      expect(bdOf(s, "route"), order).toEqual({ "/search": 3 });
      expect(stateOf(sql).rev, order).toBe(2); // two writes; the concurrent loser read again and retried
    }
  });

  it("before the first summary events count as before; the summary then adds only what is new", async () => {
    const { sql } = setup();
    await aggregate(sql.api, TOK, batchOf([sess(), dec(1, "d1"), det(2, "d1"), dec(3, "d2", { diagnosis: "expected", diagnosisConfidence: 0.99, acted: true })]), NOW);
    let s = await statsOf(sql);
    expect(s.totals).toMatchObject({ sessions: 1, decisions: 2, detections: 1, acted: 1 });
    await aggregate(sql.api, TOK, batchOf([summ(4, { decisions: 5, acted: 1, detections: 1 })]), NOW);
    s = await statsOf(sql);
    expect(s.totals).toMatchObject({ sessions: 1, decisions: 5, detections: 1, acted: 1 });
    // events without a seq (another client) still count, as they did before
    await aggregate(sql.api, TOK, { ...batchOf([{ t: "decision", id: "n1", trigger: "delivery", diagnosis: "stale" }]), sid: "zzzzzzzzzzzzzzzz" }, NOW);
    expect((await statsOf(sql)).totals.decisions).toBe(6);
  });

  it("loss counters come from the summaries: hidden tabs, the decision rate limit, browser drops, unsent records, action limits", async () => {
    const { sql } = setup();
    const s1 = summ(1, { decisions: 10, failOpen: { "not-ready:delivery": 3 }, limits: { perMinute: 2 } }, { runtime: { model: { decisions: 10, dropped: 4, hiddenSkipped: 6 } }, telemetry: { dropped: 1, decisionsSampledOut: 7, decisionsCapped: 0 } });
    const s2 = summ(2, { decisions: 12, failOpen: { "not-ready:delivery": 3, "no-answer:request": 1 }, limits: { perMinute: 2, perSession: 1 } }, { runtime: { model: { decisions: 12, dropped: 5, hiddenSkipped: 9 } }, telemetry: { dropped: 1, decisionsSampledOut: 8, decisionsCapped: 2 } });
    await aggregate(sql.api, TOK, batchOf([sess(), s1]), NOW);
    await aggregate(sql.api, TOK, batchOf([s2]), NOW);
    await aggregate(sql.api, TOK, batchOf([s2]), NOW); // repeated
    const s = await statsOf(sql);
    expect(s.totals).toMatchObject({ sessions: 1, decisions: 12, failOpens: 4, hidden_skipped: 9, model_dropped: 5, telemetry_dropped: 1, records_sampled_out: 8, records_capped: 2, actionLimits: 3 });
    expect(bdOf(s, "fail_open")).toEqual({ "not-ready:delivery": 3, "no-answer:request": 1 });
    expect(bdOf(s, "action_limits")).toEqual({ perMinute: 2, perSession: 1 });
  });

  it("state from the previous worker version, or swept after SESSION_KEEP_MS, sets a baseline instead of recounting", async () => {
    const { sql } = setup();
    const sidHash = (await sha256Hex(`${TOK}:${SID}`)).slice(0, 32);
    sql.db.prepare("INSERT INTO sessions (sid_hash, token, day, counts) VALUES (?, ?, ?, ?)").run(sidHash, TOK, "2026-10-08", JSON.stringify({ failOpen: { "timeout:response": 2 }, modelErrors: {} }));
    await aggregate(sql.api, TOK, batchOf([summ(30, { decisions: 50, detections: 9, failOpen: { "timeout:response": 3 } }), dec(31, "d31"), det(32, "d31")]), NOW);
    let s = await statsOf(sql);
    // the old state had counted 2 fail-opens (1 is new); decisions and detections: only the events after that summary
    expect(s.totals).toMatchObject({ failOpens: 1, decisions: 1, detections: 1 });
    expect(s.totals.sessions ?? 0).toBe(0);
    // from then on the page load counts normally
    await aggregate(sql.api, TOK, batchOf([summ(40, { decisions: 54, detections: 11, failOpen: { "timeout:response": 3 } })]), NOW);
    s = await statsOf(sql);
    expect(s.totals).toMatchObject({ failOpens: 1, decisions: 4, detections: 2 });
    expect(stateOf(sql).base).toBeUndefined();

    // a page load quiet for longer than its state is kept: its next summary is a baseline, later ones count
    const { sql: q } = setup();
    const late = (seq: number, decisions: number) => ({ ...summ(seq, { decisions, detections: 12 }), at: SESSION_KEEP_MS + seq * 1000 });
    await aggregate(q.api, TOK, batchOf([late(900, 80)]), NOW);
    s = await stats(q.api, PROJ, "7d", NOW);
    expect(s.totals.decisions ?? 0).toBe(0);
    expect(s.totals.sessions ?? 0).toBe(0);
    await aggregate(q.api, TOK, batchOf([late(910, 83)]), NOW);
    expect((await stats(q.api, PROJ, "7d", NOW)).totals.decisions).toBe(3);
  });

  it("page-load state stays small: out-of-order ranges are merged (at most 16 kept), and a corrupt row is a baseline", async () => {
    const { sql } = setup();
    for (let i = 0; i < 40; i++) await aggregate(sql.api, TOK, batchOf([dec(1000 - i * 10, `x${i}`)]), NOW);
    const state = stateOf(sql);
    expect(state.seen.length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(state).length).toBeLessThan(2048);
    expect((await statsOf(sql)).totals.decisions).toBe(40);

    sql.db.prepare("UPDATE sessions SET counts = 'not json'").run();
    await aggregate(sql.api, TOK, batchOf([summ(2000, { decisions: 900 }), dec(2001, "y")]), NOW);
    expect((await statsOf(sql)).totals.decisions).toBe(41);
  });
});

const pdet = (seq: number, id: string, diagnosis = "stale", p = 0.8): E => ({ ...det(seq, id, diagnosis, p), tier: "possible" });

describe("possible issues: runtime 0.3.0's lower tier (detect events with tier \"possible\")", () => {
  it("counts them in their own metrics, never as detections, and derives nothing from decision records", async () => {
    const { sql } = setup();
    const events = [
      sess(),
      dec(1, "a", { diagnosisConfidence: 0.8, route: "/a" }), pdet(2, "a"),
      dec(3, "b", { diagnosis: "duplicate", diagnosisConfidence: 0.75, route: "/b", fn: "loadCart" }), pdet(4, "b", "duplicate", 0.75),
      dec(5, "c", { diagnosisConfidence: 0.95 }), det(6, "c"), // likely: no tier, as from every runtime before 0.3.0
      // under the report gate with no detect event (guard or heal, policy.thresholds.report, detect: "likely", an
      // acted decision): the runtime reported nothing, so neither does the dashboard
      dec(7, "d", { diagnosisConfidence: 0.85, route: "/d" }),
      dec(8, "e", { diagnosisConfidence: 0.82, route: "/e", effectiveMode: "guard", acted: true, ran: "discard", tier: "guard", gates: { report: 0.9, source: { report: "policy" } } }),
      { ...det(9, "z", "conflict", 0.95), tier: "likely" }, // any other tier value is a detection; its decision is in another batch
    ];
    await aggregate(sql.api, TOK, batchOf(events), NOW);
    const s = await statsOf(sql);
    expect(s.totals).toMatchObject({ decisions: 5, detections: 2, possible: 2, detectionsWithPage: 1, possibleWithPage: 2 });
    expect(bdOf(s, "possible_diagnosis")).toEqual({ stale: 1, duplicate: 1 });
    expect(bdOf(s, "possible_route")).toEqual({ "/a": 1, "/b": 1 });
    expect(bdOf(s, "possible_issue")).toEqual({ "stale\t/a": 1, "duplicate\t/b": 1 });
    expect(bdOf(s, "possible_fn")).toEqual({ loadCart: 1 });
    expect(bdOf(s, "detect_diagnosis")).toEqual({ stale: 1, conflict: 1 });
    expect(bdOf(s, "detect_route")).toEqual({ "/search": 1 });
    expect(s.series.at(-1)).toMatchObject({ detections: 2, possible: 2 });
    expect(s.typeSeries.at(-1)!.counts).toEqual({ stale: 1, conflict: 1 });
    // recent rows: the two detections and the intervention, no possible ones
    expect(s.recent.map((r) => [r.kind, r.diagnosis])).toEqual(expect.arrayContaining([["detect", "stale"], ["detect", "conflict"], ["acted", "stale"]]));
    expect(s.recent).toHaveLength(3);
  });

  it("one sent before any summary stays out of Problems when the summary counts only likely detections", async () => {
    // observe at balanced (report 0.90): stale at 0.80 is a possible detection; its record and detect event arrive
    // first, the 60 s summary later carries detections 0 and possibleDetections 1
    const { sql } = setup();
    const first = [sess(), dec(1, "d1", { diagnosisConfidence: 0.8 }), pdet(2, "d1")];
    await aggregate(sql.api, TOK, batchOf(first), NOW);
    let s = await statsOf(sql);
    expect(s.totals.detections ?? 0).toBe(0);
    expect(s.totals.possible).toBe(1);
    await aggregate(sql.api, TOK, batchOf([summ(3, { decisions: 1, acted: 0, detections: 0, possibleDetections: 1, byDiagnosis: { stale: 1 }, detectionsByDiagnosis: {} })]), NOW);
    await aggregate(sql.api, TOK, batchOf(first), NOW); // repeated
    s = await statsOf(sql);
    expect(s.totals.detections ?? 0).toBe(0);
    expect(s.totals).toMatchObject({ decisions: 1, possible: 1 });
    expect(bdOf(s, "possible_diagnosis")).toEqual({ stale: 1 });
    expect(bdOf(s, "detect_diagnosis")).toEqual({});
    expect(s.series.at(-1)).toMatchObject({ detections: 0, possible: 1 });
    // a later summary is exact for the tier too (events lost in the browser are counted there)
    await aggregate(sql.api, TOK, batchOf([pdet(20, "d9", "slow"), summ(21, { decisions: 9, detections: 1, possibleDetections: 6, detectionsByDiagnosis: { stale: 1 } })]), NOW);
    s = await statsOf(sql);
    expect(s.totals).toMatchObject({ decisions: 9, detections: 1, possible: 6 });
    expect(bdOf(s, "possible_diagnosis")).toEqual({ stale: 1, slow: 1 }); // by diagnosis: from the events that arrived
  });

  it("one whose decision record came in another batch counts once, without a page, in either order", async () => {
    const partA = [sess(), dec(1, "d1", { diagnosisConfidence: 0.8, route: "/a" })];
    const partB = [pdet(2, "d1"), summ(3, { decisions: 1, detections: 0, possibleDetections: 1 })];
    for (const order of ["a,b", "b,a"]) {
      const { sql } = setup();
      for (const part of order === "a,b" ? [partA, partB] : [partB, partA]) await aggregate(sql.api, TOK, batchOf(part), NOW);
      const s = await statsOf(sql);
      expect(s.totals, order).toMatchObject({ sessions: 1, decisions: 1, possible: 1, possibleWithPage: 0 });
      expect(s.totals.detections ?? 0, order).toBe(0);
      expect(bdOf(s, "possible_diagnosis"), order).toEqual({ stale: 1 });
      expect(bdOf(s, "possible_route"), order).toEqual({});
      expect(s.recent, order).toHaveLength(0);
    }
  });

  it("through the collector: a page batch with a possible, a likely and a tier-less detection", async () => {
    const { env, sql } = setup();
    const { json } = await create(env);
    unlock(sql, json.token);
    const extra = [
      { t: "decision", seq: 9, at: 4100, id: "d3", trigger: "delivery", route: "/cart/:id", model: "genclass-2", latencyMs: 90, diagnosis: "stale", diagnosisConfidence: 0.8, action: "deliver", confidence: 0.9, tier: "passive", ran: "deliver", executed: true, acted: false, effectiveMode: "observe" },
      { t: "detect", seq: 10, at: 4101, decision: "d3", trigger: "delivery", diagnosis: "stale", p: 0.8, tier: "possible" },
      { t: "detect", seq: 11, at: 4102, decision: "d9", trigger: "mutation", diagnosis: "conflict", p: 0.95, tier: "likely" },
    ];
    expect((await handle(post(pageBatch(json.token, undefined, extra)), env, opts)).status).toBe(202);
    const s = (await (await handle(new Request(`https://genclass.dev/api/projects/${secretOf(json.dashboardUrl)}?range=7d`), env, opts)).json()) as Record<string, any>;
    expect(s.totals).toMatchObject({ decisions: 3, detections: 2, possible: 1 });
    expect(s.totals.possible_detections).toBeUndefined(); // one name for the tier: "possible"
    const bd = (m: string) => Object.fromEntries((s.breakdowns[m] ?? []).map((x: any) => [x.key, x.count]));
    expect(bd("detect_diagnosis")).toEqual({ stale: 1, conflict: 1 });
    expect(bd("possible_diagnosis")).toEqual({ stale: 1 });
    expect(bd("possible_issue")).toEqual({ "stale\t/cart/:id": 1 });
    expect(s.series.at(-1)).toMatchObject({ detections: 2, possible: 1 });
    expect(s.recent.filter((r: any) => r.kind === "detect")).toHaveLength(2); // d1 (its decision) and d9 (event only)
  });
});

describe("dashboard counts (display fixes)", () => {
  it("counts every affected page, not only the top 25 a breakdown keeps", async () => {
    const { sql } = setup();
    const events: E[] = [sess()];
    for (let i = 0; i < 30; i++) events.push(dec(1 + 2 * i, `p${i}`, { route: `/page/${i}` }), det(2 + 2 * i, `p${i}`));
    await aggregate(sql.api, TOK, batchOf(events), NOW);
    const s = await statsOf(sql);
    expect(s.breakdowns.detect_route).toHaveLength(25);
    expect(s.distinct.detect_route).toBe(30);
    expect(s.totals).toMatchObject({ detections: 30, detectionsWithPage: 30 });
  });

  it("recent activity shows the diagnosis confidence, also for interventions", async () => {
    const { sql } = setup();
    await aggregate(sql.api, TOK, batchOf([dec(1, "a", { diagnosis: "duplicate", diagnosisConfidence: 0.91, action: "coalesce", confidence: 0.62, ran: "coalesce", acted: true, effectiveMode: "guard", gates: { report: 0.95 } })]), NOW);
    const s = await statsOf(sql);
    expect(s.recent).toMatchObject([{ kind: "acted", diagnosis: "duplicate", confidence: 0.91 }]);
  });

  it("/start and the empty dashboard say local hosts do not send by default and the token needs 0.3.0-beta.0", async () => {
    const { env, sql } = setup();
    const start = await (await handle(new Request("https://genclass.dev/start"), env, opts)).text();
    const { json } = await create(env);
    unlock(sql, json.token);
    const dash = await (await handle(new Request(json.dashboardUrl), env, opts)).text();
    for (const html of [start, dash]) {
      expect(html).toContain("needs @genclass/runtime 0.3.0-beta.0 or later");
      expect(html).toContain("do not send by default, token or not; telemetry: true or a telemetry options object opts them in");
      expect(html).not.toContain("only send data with an explicit token");
      // RUNTIME_ON_NPM unset: the runtime that reads keys is not on npm yet, and the pages say so first
      expect(html).toContain("Not on npm yet.");
    }
    const { env: ready, sql: readySql } = setup();
    ready.RUNTIME_ON_NPM = "0.3.0-beta.0";
    expect(await (await handle(new Request("https://genclass.dev/start"), ready, opts)).text()).not.toContain("Not on npm yet.");
    const made = await create(ready);
    unlock(readySql, made.json.token);
    expect(await (await handle(new Request(made.json.dashboardUrl), ready, opts)).text()).not.toContain("Not on npm yet.");
  });
});

describe("sample dashboard: possible issues", () => {
  it("shows the possible tier too, still simulated, never inside the problem counts", () => {
    const total = (l: { count: number }[] | undefined) => (l ?? []).reduce((a, x) => a + x.count, 0);
    for (const range of ["24h", "7d", "30d"]) {
      const s = sampleStats(range, NOW);
      expect(s.name).toContain("simulated");
      if (range !== "24h") expect(s.totals.possible).toBeGreaterThan(0);
      expect(total(s.breakdowns.possible_issue)).toBe(s.totals.possible);
      expect(total(s.breakdowns.possible_diagnosis)).toBe(s.totals.possible);
      expect(s.series.reduce((a, b) => a + b.possible, 0)).toBe(s.totals.possible);
      expect(total(s.breakdowns.detect_issue)).toBe(s.totals.detections);
      expect(s.series.reduce((a, b) => a + b.detections, 0)).toBe(s.totals.detections);
      expect(s.typeSeries.reduce((a, b) => a + Object.values(b.counts).reduce((x, y) => x + y, 0), 0)).toBe(s.totals.detections);
      expect(s.distinct.detect_route).toBe(s.breakdowns.detect_route!.length);
    }
  });
});

describe("interaction analytics: runtime `interactions` events (docs/runtime/ANALYTICS.md section 3)", () => {
  const ixe = (seq: number, o: E): E => ({ t: "interactions", seq, at: seq * 10, view: 1, route: "/pricing", ...o });

  it("counts page views, engaged time, scroll milestones, clicks, rage and dead clicks per page and element", async () => {
    const { sql } = setup();
    const events = [
      sess(),
      ixe(1, { start: true, engagedMs: 12_000, scroll: [25, 50], clicks: { '[data-genclass-name="pro"]': 3, "a[href=\"/docs\"]": 1 }, rage: { '[data-genclass-name="pro"]': 1 } }),
      ixe(2, { engagedMs: 3_000, scroll: [75], dead: { "button.copy": 2 }, end: true }),
      ixe(3, { view: 2, route: "/docs", start: true, engagedMs: 40_000, scroll: [25, 25, 50, 75, 100, 33], clicks: { "a[href=\"/docs\"]": 1 } }),
    ];
    await aggregate(sql.api, TOK, batchOf(events), NOW);
    const s = await statsOf(sql);
    expect(s.totals).toMatchObject({ ix_views: 2, ix_engaged_ms: 55_000, ix_click: 5, ix_rage: 1, ix_dead: 2 });
    expect(bdOf(s, "ix_views")).toEqual({ "/pricing": 1, "/docs": 1 });
    expect(bdOf(s, "ix_engaged_ms")).toEqual({ "/pricing": 15_000, "/docs": 40_000 });
    expect(bdOf(s, "ix_scroll")).toEqual({ "/pricing\t25": 1, "/pricing\t50": 1, "/pricing\t75": 1, "/docs\t25": 1, "/docs\t50": 1, "/docs\t75": 1, "/docs\t100": 1 });
    expect(bdOf(s, "ix_click")).toEqual({ '/pricing\t[data-genclass-name="pro"]': 3, '/pricing\ta[href="/docs"]': 1, '/docs\ta[href="/docs"]': 1 });
    expect(bdOf(s, "ix_rage")).toEqual({ '/pricing\t[data-genclass-name="pro"]': 1 });
    expect(bdOf(s, "ix_dead")).toEqual({ "/pricing\tbutton.copy": 2 });
    expect(s.series.at(-1)).toMatchObject({ ix_views: 2 });
    // never a diagnostics count
    expect(s.totals.decisions ?? 0).toBe(0);
    expect(s.totals.detections ?? 0).toBe(0);
  });

  it("a repeated batch adds nothing; bad values are ignored; ix counters never crowd out the diagnostics ones", async () => {
    const { sql } = setup();
    const many: Record<string, number> = {};
    for (let i = 0; i < 400; i++) many[`button.b${i}`] = 1;
    const events = [
      sess(),
      dec(1, "d1", { route: "/a" }), det(2, "d1"),
      ixe(3, { start: true, engagedMs: -5, scroll: ["50", 101], clicks: { "": 4, "button.ok": 2, "button.nan": Number.NaN as unknown as number, "button.huge": 1e9 } }),
      ixe(4, { view: 2, route: "/b", start: true, clicks: many }),
    ];
    await aggregate(sql.api, TOK, batchOf(events), NOW);
    await aggregate(sql.api, TOK, batchOf(events), NOW);
    const s = await statsOf(sql);
    expect(s.totals).toMatchObject({ ix_views: 2, detections: 1, decisions: 1 });
    expect(s.totals.ix_engaged_ms ?? 0).toBe(0);
    expect(bdOf(s, "ix_scroll")).toEqual({});
    expect(bdOf(s, "ix_click")["/pricing\tbutton.ok"]).toBe(2);
    expect(Object.keys(bdOf(s, "ix_click")).filter((k) => k.startsWith("/pricing"))).toEqual(["/pricing\tbutton.ok"]);
    // at most 60 keys read per event, at most MAX_IX_COUNTERS distinct ix counters per batch
    expect(s.distinct.ix_click).toBeLessThanOrEqual(61);
    expect(bdOf(s, "detect_route")).toEqual({ "/a": 1 });
  });

  it("through the collector: stored in R2 with the batch (for the export) and counted for the app", async () => {
    const { env, puts, sql } = setup();
    const { json } = await create(env);
    const body = pageBatch(json.token, "3f9c0a1b2c3d4e5f60718299", [{ t: "interactions", seq: 9, at: 5000, view: 1, route: "/cart/:id", start: true, engagedMs: 4000, clicks: { "button#pay": 1 } }]);
    const res = await handle(post(body), env, opts);
    expect(res.status).toBe(202);
    const stored = gunzipSync(puts.at(-1)!.body).toString("utf8");
    expect(stored).toContain('"t":"interactions"');
    const rows = sql.rows("SELECT metric, key, count FROM daily WHERE token = ? AND metric LIKE 'ix_%' ORDER BY metric, key", json.token);
    expect(rows).toEqual(
      expect.arrayContaining([
        { metric: "ix_views", key: "", count: 1 },
        { metric: "ix_views", key: "/cart/:id", count: 1 },
        { metric: "ix_engaged_ms", key: "/cart/:id", count: 4000 },
        { metric: "ix_click", key: "/cart/:id\tbutton#pay", count: 1 },
      ]),
    );
  });

  it("navigation paths (ANALYTICS.md section 11): entries, steps with time, arrivals, first interactions, exits, paths", async () => {
    const { sql } = setup();
    const events = [
      sess(),
      ixe(1, { route: "/", start: true, nav: "load", first: 'a[href="/pricing"]', firstMs: 2_000 }),
      ixe(2, { route: "/", end: true }),
      ixe(3, { view: 2, start: true, nav: "push", from: "/", fromMs: 4_000, first: "button.buy", firstMs: 1_500 }),
      ixe(4, { view: 3, route: "/", start: true, nav: "back", from: "/pricing", fromMs: 9_000, exit: true, end: true, path: ["/", "/pricing", "/"] }),
      // another page load: one view, an unknown nav value, a long path, bad times
      ixe(5, { view: 1, route: "/docs", start: true, nav: "teleport", first: "  ", firstMs: -1, exit: true, path: ["/docs", "/a", "/b", "/c", "/d", "/e", "/f"] }),
      ixe(6, { view: 2, route: "/a", start: true, nav: "push", from: "/docs", fromMs: 1e12 }),
    ];
    await aggregate(sql.api, TOK, batchOf(events), NOW);
    const s = await statsOf(sql);
    expect(s.totals).toMatchObject({ ix_views: 5, ix_entry: 2, ix_exit: 2 });
    expect(bdOf(s, "ix_entry")).toEqual({ "/": 1, "/docs": 1 });
    expect(bdOf(s, "ix_nav")).toEqual({ "/\t/pricing": 1, "/pricing\t/": 1, "/docs\t/a": 1 });
    expect(bdOf(s, "ix_nav_ms")).toEqual({ "/\t/pricing": 4_000, "/pricing\t/": 9_000 });
    expect(bdOf(s, "ix_arrive")).toEqual({ load: 1, push: 2, back: 1, "(other)": 1, "/\tload": 1, "/pricing\tpush": 1, "/\tback": 1, "/docs\t(other)": 1, "/a\tpush": 1 });
    expect(bdOf(s, "ix_first")).toEqual({ '/\ta[href="/pricing"]': 1, "/pricing\tbutton.buy": 1 });
    expect(bdOf(s, "ix_first_n")).toEqual({ "/": 1, "/pricing": 1 });
    expect(bdOf(s, "ix_first_ms")).toEqual({ "/": 2_000, "/pricing": 1_500 });
    expect(bdOf(s, "ix_exit")).toEqual({ "/": 1, "/docs": 1 });
    expect(bdOf(s, "ix_path")).toEqual({ "/ > /pricing > /": 1, "/docs > /a > /b > /c > /d > …": 1 });
  });

  it("the sample dashboard shows simulated interaction analytics too", () => {
    const st = sampleStats("7d", NOW);
    expect(st.totals.ix_views).toBeGreaterThan(0);
    expect(st.breakdowns.ix_click!.length).toBeGreaterThan(0);
    expect(st.series.every((b) => b.ix_views > 0)).toBe(true);
    for (const m of ["ix_entry", "ix_exit", "ix_nav", "ix_nav_ms", "ix_arrive", "ix_first", "ix_path"]) expect(st.breakdowns[m]!.length, m).toBeGreaterThan(0);
  });
});

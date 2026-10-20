import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { resetTokenCache } from "../src/dashboard.js";
import { csvCell, decodeCursor, encodeCursor } from "../src/export.js";
import { resetOwnerCache } from "../src/paid.js";
import { longRetention, planRetention } from "../src/plans.js";
import { call, cliToken, createApp, detection, now, resetClock, sendBatch, setPlan, setup, signedIn } from "./account-helpers.js";

// Export (src/export.ts) and plan-aware retention (src/plans.ts): every event of an owned app as JSONL or CSV from the
// stored R2 batches, free for every app in an account (every plan includes it; an app known only by its private link
// has none), by browser session or export key, never another app's events; the daily sweep keeps what each plan
// allows (a year, for every plan) and never shortens what existing projects had (90 days, for link-only apps).

const LIVE = { STRIPE_SECRET_KEY: "sk_test_fake" };
const DAY = 86_400_000;

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
});

async function proApp(plan = "individual") {
  const t = setup(LIVE);
  const a = await signedIn(t.env);
  setPlan(t.sql, a.account.id, plan);
  const app = await createApp(t.env, a.cookie, "Shop");
  return { ...t, ...a, app };
}

const lines = async (r: Response) => (await r.text()).split("\n").filter(Boolean);

describe("export: GET /api/account/projects/<id>/events", () => {
  it("Free exports too (it is free for every plan); signed-out and command line sessions are refused", async () => {
    const t = await proApp("free");
    await sendBatch(t.env, t.app.token, [{ t: "session", seq: 0, host: "shop.example", route: "/" }]);
    const r = await call(t.env, "GET", `/api/account/projects/${t.app.id}/events`, { cookie: t.cookie });
    expect(r.status).toBe(200);
    expect(await lines(r)).toHaveLength(1);
    expect((await call(t.env, "GET", `/api/account/projects/${t.app.id}/events`, {})).status).toBe(401);
    const bearer = await cliToken(t.env, t.cookie);
    const cli = await call(t.env, "GET", `/api/account/projects/${t.app.id}/events`, { bearer, origin: null });
    expect(cli.status).toBe(403);
    expect(((await cli.json()) as any).error).toMatch(/command line session cannot read the export/);
    // the app's page has the export form and says it is free
    const html = await (await call(t.env, "GET", `/account/apps/${t.app.id}`, { cookie: t.cookie })).text();
    expect(html).toContain('id="exf"');
    expect(html).toContain("Free. Every event GenClass received for this app while it was in this account, kept 1 year");
    expect(html).not.toMatch(/come with pro\b|pro (or|and) custom/i);
  });

  it("JSONL: every event of the app's batches, as the collector stored them; an owned app's batches are kept under export/", async () => {
    const t = await proApp();
    await sendBatch(t.env, t.app.token, [{ t: "session", seq: 0, host: "shop.example", route: "/" }]);
    await sendBatch(t.env, t.app.token, detection("duplicate", "/checkout"), { sid: "dddddddddddd" });
    const idx = t.sql.rows("SELECT token, key, events FROM event_batches ORDER BY key");
    expect(idx).toHaveLength(2);
    for (const r of idx) {
      expect(r.token).toBe(t.app.token);
      expect(String(r.key)).toMatch(new RegExp(`^export/${t.app.token}/dt=2026-10-13/u-\\d+\\.jsonl\\.gz$`));
      expect(t.r2.objects.has(String(r.key))).toBe(true);
    }
    const r = await call(t.env, "GET", `/api/account/projects/${t.app.id}/events?from=2026-10-13&to=2026-10-14`, { cookie: t.cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="genclass-${t.app.id}-2026-10-13-2026-10-14.jsonl"`);
    expect(r.headers.get("x-genclass-next-cursor")).toBeNull();
    const got = (await lines(r)).map((l) => JSON.parse(l));
    expect(got).toHaveLength(3);
    expect(got[0]).toMatchObject({ sid: "cccccccccccc", runtime: "0.3.0", model: "0.2.0", receivedAt: now().toISOString(), token: t.app.token, event: { t: "session", host: "shop.example" } });
    expect(got.map((x) => x.event.t)).toEqual(["session", "decision", "detect"]);
  });

  it("CSV: a header, one row per event, formulas defused; pages of `limit` batches follow the cursor", async () => {
    const t = await proApp();
    await sendBatch(t.env, t.app.token, [{ t: "session", seq: 0, host: "shop.example", route: "=HYPERLINK(\"x\")" }]);
    await sendBatch(t.env, t.app.token, [{ t: "session", seq: 0, host: "shop.example", route: "/b" }], { sid: "dddddddddddd" });
    const p1 = await call(t.env, "GET", `/api/account/projects/${t.app.id}/events?format=csv&limit=1`, { cookie: t.cookie });
    expect(p1.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const cursor = p1.headers.get("x-genclass-next-cursor")!;
    expect(cursor).toBeTruthy();
    expect(p1.headers.get("link")).toBe(`</api/account/projects/${t.app.id}/events?format=csv&limit=1&cursor=${cursor}>; rel="next"`);
    const rows1 = (await p1.text()).split("\r\n").filter(Boolean);
    expect(rows1[0]).toBe("received_at,session,runtime,model,country,type,seq,route,trigger,diagnosis,event");
    expect(rows1[1]).toContain(`"'=HYPERLINK(""x"")"`);
    const p2 = await call(t.env, "GET", `/api/account/projects/${t.app.id}/events?format=csv&limit=1&cursor=${cursor}`, { cookie: t.cookie });
    const rows2 = (await p2.text()).split("\r\n").filter(Boolean);
    expect(rows2).toHaveLength(1);
    expect(rows2[0]).toContain(",/b,");
    expect(p2.headers.get("x-genclass-next-cursor")).toBeNull();
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(decodeCursor(encodeCursor({ received: "2026-10-13T12:00:00.000Z", key: "k" }))).toEqual({ received: "2026-10-13T12:00:00.000Z", key: "k" });
    expect(decodeCursor("!!")).toBe("bad");
  });

  it("export keys: made in the browser, shown once, read only this account's apps, and stop at once when revoked", async () => {
    const t = await proApp();
    await sendBatch(t.env, t.app.token, [{ t: "session", seq: 0 }]);
    const made = await call(t.env, "POST", "/api/account/export-keys", { body: { label: "warehouse" }, cookie: t.cookie });
    expect(made.status).toBe(201);
    const { id, key } = (await made.json()) as any;
    expect(key).toMatch(/^gce_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(t.sql.rows("SELECT * FROM export_keys"))).not.toContain(key);
    const r = await call(t.env, "GET", `/api/account/projects/${t.app.id}/events`, { bearer: key, origin: null });
    expect(r.status).toBe(200);
    expect(await lines(r)).toHaveLength(1);
    expect(t.sql.rows("SELECT last_used FROM export_keys")).toEqual([{ last_used: now().toISOString() }]);
    // another account's app: not found with this key
    const b = await signedIn(t.env, "bob@example.com");
    const bobApp = await createApp(t.env, b.cookie, "Bob's");
    expect((await call(t.env, "GET", `/api/account/projects/${bobApp.id}/events`, { bearer: key, origin: null })).status).toBe(404);
    // listing never shows the key; revoking needs the browser and our Origin
    expect(JSON.stringify(await (await call(t.env, "GET", "/api/account/export-keys", { cookie: t.cookie })).json())).not.toContain(key);
    expect((await call(t.env, "DELETE", `/api/account/export-keys/${id}`, { cookie: t.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(t.env, "DELETE", `/api/account/export-keys/${id}`, { cookie: t.cookie })).status).toBe(204);
    expect((await call(t.env, "GET", `/api/account/projects/${t.app.id}/events`, { bearer: key, origin: null })).status).toBe(401);
    // Free makes one too
    const c = await signedIn(t.env, "cy@example.com");
    expect((await call(t.env, "POST", "/api/account/export-keys", { body: {}, cookie: c.cookie })).status).toBe(201);
  });

  it("never another app's events, even when an index row points at another app's batch", async () => {
    const t = await proApp();
    const other = await createApp(t.env, t.cookie, "Other");
    await sendBatch(t.env, other.token, [{ t: "session", seq: 0, host: "other.example" }]);
    const [row] = t.sql.rows("SELECT key FROM event_batches WHERE token = ?", other.token);
    t.sql.db.prepare("INSERT INTO event_batches (token, received, key, events) VALUES (?, ?, ?, 1)").run(t.app.token, now().toISOString(), String(row!.key));
    const r = await call(t.env, "GET", `/api/account/projects/${t.app.id}/events`, { cookie: t.cookie });
    expect(await lines(r)).toEqual([]);
  });

  it("dates: the window starts no earlier than the plan's history; bad input is a 400", async () => {
    const t = await proApp();
    const q = (s: string) => call(t.env, "GET", `/api/account/projects/${t.app.id}/events?${s}`, { cookie: t.cookie });
    expect((await q("from=2020-01-01")).status).toBe(200);
    expect((await q("from=yesterday")).status).toBe(400);
    expect((await q("from=2026-10-13&to=2026-10-12")).status).toBe(400);
    expect((await q("format=xml")).status).toBe(400);
    expect((await q("limit=201")).status).toBe(400);
    expect((await q("cursor=bad!")).status).toBe(400);
    const html = await (await call(t.env, "GET", `/account/apps/${t.app.id}`, { cookie: t.cookie })).text();
    expect(html).toContain('id="exf"');
    expect(html).toContain(`https://genclass.dev/api/account/projects/${t.app.id}/events?from=2026-10-01&#38;to=2026-10-14&#38;format=jsonl`);
  });

  it("every app in an account is indexed, on any plan; an app without an account costs no D1 row and no copy", async () => {
    const t = await proApp("free");
    const anon = (await (await call(t.env, "POST", "/api/projects", { body: { name: "Anon" }, origin: null })).json()) as any;
    await sendBatch(t.env, anon.token, [{ t: "session", seq: 0 }]);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM event_batches")[0]!.n).toBe(0);
    expect([...t.r2.objects.keys()].some((k) => k.startsWith("export/"))).toBe(false);
    // the Free app: an index row and a copy under export/ (kept a year, Free's history)
    await sendBatch(t.env, t.app.token, [{ t: "session", seq: 0 }]);
    expect(t.sql.rows("SELECT token FROM event_batches")).toEqual([{ token: t.app.token }]);
    expect(String(t.sql.rows("SELECT key FROM event_batches")[0]!.key)).toMatch(new RegExp(`^export/${t.app.token}/`));
    // the export covers what arrived while the app was in the account: the link-only app's batch stays out of it
    const { cookie } = await signedIn(t.env, "late@example.com");
    expect((await call(t.env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, cookie })).status).toBe(200);
    resetOwnerCache();
    await sendBatch(t.env, anon.token, [{ t: "session", seq: 1 }], { sid: "dddddddddddd" });
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM event_batches WHERE token = ?", anon.token)[0]!.n).toBe(1);
    const claimed = ((await (await call(t.env, "GET", "/api/account/projects", { cookie })).json()) as any).projects[0];
    const r = await call(t.env, "GET", `/api/account/projects/${claimed.id}/events`, { cookie });
    expect(r.status).toBe(200);
    expect(await lines(r)).toHaveLength(1);
  });

  it("a plan bought in Stripe's test mode reads as Free under a live key (src/plans.ts inMode): Free's export, Free's year", async () => {
    const t = setup({ STRIPE_SECRET_KEY: "sk_live_fake" });
    const a = await signedIn(t.env);
    setPlan(t.sql, a.account.id, "individual", { stripe_mode: "test" });
    const app = await createApp(t.env, a.cookie);
    await sendBatch(t.env, app.token, [{ t: "session", seq: 0 }]);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM event_batches")[0]!.n).toBe(1);
    expect((await call(t.env, "GET", `/api/account/projects/${app.id}/events`, { cookie: a.cookie })).status).toBe(200);
    expect(await (await call(t.env, "GET", `/account/apps/${app.id}`, { cookie: a.cookie })).text()).toContain("kept 1 year");
    expect(await (await call(t.env, "GET", "/api/billing", { cookie: a.cookie })).json()).toMatchObject({ plan: "free" });
  });
});

describe("retention by plan (the daily sweep)", () => {
  const day = (msAgo: number) => new Date(now().getTime() - msAgo).toISOString().slice(0, 10);
  function seed(sql: ReturnType<typeof setup>["sql"], token: string, ages: number[]) {
    const ins = sql.db.prepare("INSERT INTO daily (token, day, metric, key, count) VALUES (?, ?, 'sessions', '', 1)");
    const rec = sql.db.prepare("INSERT INTO recent (token, t, kind) VALUES (?, ?, 'detect')");
    for (const a of ages) {
      ins.run(token, day(a * DAY));
      rec.run(token, new Date(now().getTime() - a * DAY).toISOString());
    }
  }
  const ages = (sql: ReturnType<typeof setup>["sql"], token: string) =>
    sql.rows("SELECT day FROM daily WHERE token = ? ORDER BY day DESC", token).map((r) => Math.round((Date.parse(now().toISOString().slice(0, 10)) - Date.parse(String(r.day))) / DAY));

  it("keeps 90 days for an app in no account, and a year for every account's apps (every plan: Free, Individual, Enterprise, and after a paid plan ends)", async () => {
    const { env, sql, r2 } = setup(LIVE);
    const free = await signedIn(env, "free@example.com");
    const pro = await signedIn(env, "individual@example.com");
    const custom = await signedIn(env, "enterprise@example.com");
    const lapsed = await signedIn(env, "lapsed@example.com");
    const gone = await signedIn(env, "gone@example.com");
    setPlan(sql, pro.account.id, "individual");
    setPlan(sql, custom.account.id, "enterprise");
    setPlan(sql, lapsed.account.id, "free", { subscription_id: "sub_lapsed0001", subscription_status: "canceled", current_period_end: new Date(now().getTime() - 10 * DAY).toISOString() });
    setPlan(sql, gone.account.id, "free", { subscription_id: "sub_gone000001", subscription_status: "canceled", current_period_end: new Date(now().getTime() - 40 * DAY).toISOString() });
    const apps: Record<string, string> = {};
    for (const [k, a] of Object.entries({ free, pro, custom, lapsed, gone })) apps[k] = (await createApp(env, a.cookie, k)).token;
    const anon = ((await (await call(env, "POST", "/api/projects", { body: { name: "Anon" }, origin: null })).json()) as any).token as string;
    for (const tok of [...Object.values(apps), anon]) seed(sql, tok, [1, 89, 91, 200, 364, 366]);
    // export copies and index rows: 200 days old, for Individual and for the account that lapsed 40 days ago (on
    // Free, which keeps a year like every plan); the free app's 91-day events/ index row is past the 90 days the
    // events/ prefix keeps (R2's own lifecycle rule removes those objects)
    const put = (tok: string, a: number, prefix: string) => {
      const key = prefix === "export" ? `export/${tok}/dt=${day(a * DAY)}/x${a}.jsonl.gz` : `events/dt=${day(a * DAY)}/rt=0.3.0/model=none/${tok}-${a}.jsonl.gz`;
      r2.objects.set(key, gzipSync("{}\n"));
      sql.db.prepare("INSERT INTO event_batches (token, received, key, events) VALUES (?, ?, ?, 1)").run(tok, new Date(now().getTime() - a * DAY).toISOString(), key);
      return key;
    };
    const proCopy = put(apps.pro!, 200, "export");
    const proOld = put(apps.pro!, 370, "export");
    const goneCopy = put(apps.gone!, 200, "export");
    put(apps.free!, 91, "events");
    const freeNew = put(apps.free!, 10, "events");
    sql.db.prepare("INSERT INTO forward_log (project_id, signature, hour) VALUES ('p', 's', ?)").run(new Date(now().getTime() - 3 * 3_600_000).toISOString().slice(0, 13));
    sql.db.prepare("INSERT INTO forward_log (project_id, signature, hour) VALUES ('p', 's', ?)").run(now().toISOString().slice(0, 13));
    sql.db.prepare("INSERT INTO billing_events (id, type, received) VALUES ('evt_old', 't', ?), ('evt_new', 't', ?)").run(new Date(now().getTime() - 31 * DAY).toISOString(), now().toISOString());

    await planRetention(sql.api, now(), r2);

    expect(ages(sql, anon)).toEqual([1, 89]);
    for (const k of ["free", "pro", "custom", "lapsed", "gone"]) expect(ages(sql, apps[k]!), k).toEqual([1, 89, 91, 200, 364]);
    expect(sql.rows("SELECT COUNT(*) AS n FROM recent WHERE token = ?", apps.pro)[0]!.n).toBe(5);
    expect(sql.rows("SELECT COUNT(*) AS n FROM recent WHERE token = ?", apps.free)[0]!.n).toBe(5);
    expect(sql.rows("SELECT COUNT(*) AS n FROM recent WHERE token = ?", anon)[0]!.n).toBe(2);
    // export copies: the 200-day copies stay (a year for every account), the 370-day one goes (from R2 too)
    expect(r2.objects.has(proCopy)).toBe(true);
    expect(r2.objects.has(goneCopy)).toBe(true);
    expect(r2.deleted).toEqual([proOld]);
    expect(sql.rows("SELECT key FROM event_batches ORDER BY key").map((r) => r.key)).toEqual([freeNew, goneCopy, proCopy].sort());
    expect(sql.rows("SELECT COUNT(*) AS n FROM forward_log")[0]!.n).toBe(1);
    expect(sql.rows("SELECT id FROM billing_events")).toEqual([{ id: "evt_new" }]);
  });

  it("an account whose only Stripe record is test-mode reads as Free under a live key or no key (accessOf), and Free keeps a year: the sweep keeps its app a year too", async () => {
    for (const [mode, over] of [
      ["live", { STRIPE_SECRET_KEY: "sk_live_fake" }],
      [null, {}],
    ] as const) {
      resetClock();
      resetTokenCache();
      resetOwnerCache();
      const { env, sql, r2 } = setup(over);
      const a = await signedIn(env, "tested@example.com");
      setPlan(sql, a.account.id, "free", { stripe_mode: "test" });
      const app = (await createApp(env, a.cookie, "Tested")).token;
      const anon = ((await (await call(env, "POST", "/api/projects", { body: { name: "Anon" }, origin: null })).json()) as any).token as string;
      seed(sql, app, [1, 89, 91, 200, 364, 366]);
      seed(sql, anon, [1, 89, 91, 200, 364, 366]);
      // the mode as index.ts passes it (stripeMode(env)): what the dashboard footer and the export page promise
      await planRetention(sql.api, now(), r2, mode);
      expect(ages(sql, app), String(mode)).toEqual([1, 89, 91, 200, 364]);
      expect(sql.rows("SELECT COUNT(*) AS n FROM recent WHERE token = ?", app)[0]!.n, String(mode)).toBe(5);
      expect(ages(sql, anon), String(mode)).toEqual([1, 89]);
    }
  });

  it("the Stripe mode does not decide retention while Free keeps a year: the kept set is every app in an account, under any key", () => {
    const at = now();
    for (const mode of ["live", "test", null, undefined] as const) {
      const l = longRetention(at, mode)!;
      expect(l.tokens, String(mode)).toBe("SELECT p.token FROM projects p WHERE p.account_id IS NOT NULL");
      expect(l.tokens).not.toContain("stripe_mode");
      expect(l.params).toEqual([]);
      expect(l.days).toBe(365);
    }
  });

  it("export copies of an app that left its account go in rounds of 1000, and index rows past 367 days in one statement", async () => {
    const { env, sql, r2 } = setup(LIVE);
    // an app known only by its private link (it left a deleted account with its copies): 90 days, like every such app
    const tok = ((await (await call(env, "POST", "/api/projects", { body: { name: "Left" }, origin: null })).json()) as any).token as string;
    const ins = sql.db.prepare("INSERT INTO event_batches (token, received, key, events) VALUES (?, ?, ?, 1)");
    const keys: string[] = [];
    for (let i = 0; i < 1500; i++) {
      const key = `export/${tok}/dt=2026-05-01/k${String(i).padStart(4, "0")}.jsonl.gz`;
      r2.objects.set(key, gzipSync("{}\n"));
      ins.run(tok, new Date(now().getTime() - 150 * DAY + i).toISOString(), key);
      keys.push(key);
    }
    // and an index row of an events/ batch past 90 days (R2's own lifecycle rule removes that object)
    ins.run(`gc_${"Q".repeat(22)}`, new Date(now().getTime() - 400 * DAY).toISOString(), "events/dt=2025-09-08/x.jsonl.gz");
    const before = sql.batches();
    await planRetention(sql.api, now(), r2);
    expect(sql.rows("SELECT COUNT(*) AS n FROM event_batches")[0]!.n).toBe(0);
    expect(r2.deleted.sort()).toEqual(keys.sort());
    // two rounds (1000 + 500 keys), each one D1 batch, plus the retention batches
    expect(sql.batches() - before).toBeLessThanOrEqual(6);
  });

  it("deleting an account removes its apps' export copies, forwarding settings and export keys", async () => {
    const t = await proApp();
    await sendBatch(t.env, t.app.token, [{ t: "session", seq: 0 }]);
    expect((await call(t.env, "POST", "/api/account/export-keys", { body: {}, cookie: t.cookie })).status).toBe(201);
    t.sql.db.prepare("INSERT INTO integrations (project_id, kind, config, created) VALUES (?, 'slack', 'v1.x.y', ?)").run(t.app.id, now().toISOString());
    const copies = [...t.r2.objects.keys()].filter((k) => k.startsWith("export/"));
    expect(copies).toHaveLength(1);
    expect((await call(t.env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: t.cookie })).status).toBe(204);
    for (const table of ["integrations", "export_keys", "event_batches", "projects"]) expect(t.sql.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n, table).toBe(0);
    expect(t.r2.deleted).toEqual(copies);
  });
});

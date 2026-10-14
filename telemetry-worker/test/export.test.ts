import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { resetTokenCache } from "../src/dashboard.js";
import { csvCell, decodeCursor, encodeCursor } from "../src/export.js";
import { resetOwnerCache } from "../src/paid.js";
import { planRetention } from "../src/plans.js";
import { call, cliToken, createApp, detection, now, resetClock, sendBatch, setPlan, setup, signedIn } from "./account-helpers.js";

// Export (src/export.ts) and plan-aware retention (src/plans.ts): every event of an owned app as JSONL or CSV from the
// stored R2 batches, paid plans only, by browser session or export key, never another app's events; the daily sweep
// keeps what each plan allows and never shortens what existing projects had.

const LIVE = { STRIPE_SECRET_KEY: "sk_test_fake" };
const DAY = 86_400_000;

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
});

async function proApp(plan = "pro") {
  const t = setup(LIVE);
  const a = await signedIn(t.env);
  setPlan(t.sql, a.account.id, plan);
  const app = await createApp(t.env, a.cookie, "Shop");
  return { ...t, ...a, app };
}

const lines = async (r: Response) => (await r.text()).split("\n").filter(Boolean);

describe("export: GET /api/account/projects/<id>/events", () => {
  it("Free is refused with a link to the plans; signed-out and command line sessions are refused", async () => {
    const t = await proApp("free");
    const r = await call(t.env, "GET", `/api/account/projects/${t.app.id}/events`, { cookie: t.cookie });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "export is part of the Pro and Custom plans; see https://genclass.dev/account/billing" });
    expect((await call(t.env, "GET", `/api/account/projects/${t.app.id}/events`, {})).status).toBe(401);
    const bearer = await cliToken(t.env, t.cookie);
    const cli = await call(t.env, "GET", `/api/account/projects/${t.app.id}/events`, { bearer, origin: null });
    expect(cli.status).toBe(403);
    expect(((await cli.json()) as any).error).toMatch(/command line session cannot read the export/);
    const html = await (await call(t.env, "GET", `/account/apps/${t.app.id}`, { cookie: t.cookie })).text();
    expect(html).toContain("On Pro and Custom you can download every event");
    expect(html).not.toContain('id="exf"');
  });

  it("JSONL: every event of the app's batches, as the collector stored them; a Pro app's batches are kept under export/", async () => {
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
    setPlan(t.sql, b.account.id, "pro");
    const bobApp = await createApp(t.env, b.cookie, "Bob's");
    expect((await call(t.env, "GET", `/api/account/projects/${bobApp.id}/events`, { bearer: key, origin: null })).status).toBe(404);
    // listing never shows the key; revoking needs the browser and our Origin
    expect(JSON.stringify(await (await call(t.env, "GET", "/api/account/export-keys", { cookie: t.cookie })).json())).not.toContain(key);
    expect((await call(t.env, "DELETE", `/api/account/export-keys/${id}`, { cookie: t.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(t.env, "DELETE", `/api/account/export-keys/${id}`, { cookie: t.cookie })).status).toBe(204);
    expect((await call(t.env, "GET", `/api/account/projects/${t.app.id}/events`, { bearer: key, origin: null })).status).toBe(401);
    // Free cannot make one
    const c = await signedIn(t.env, "cy@example.com");
    expect((await call(t.env, "POST", "/api/account/export-keys", { body: {}, cookie: c.cookie })).status).toBe(403);
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

  it("an app of a Free account is indexed under events/ only (no copy); an app without an account is not indexed", async () => {
    const t = await proApp("free");
    await sendBatch(t.env, t.app.token, [{ t: "session", seq: 0 }]);
    const anon = (await (await call(t.env, "POST", "/api/projects", { body: { name: "Anon" }, origin: null })).json()) as any;
    await sendBatch(t.env, anon.token, [{ t: "session", seq: 0 }]);
    const keys = t.sql.rows("SELECT key FROM event_batches").map((r) => String(r.key));
    expect(keys).toHaveLength(1);
    expect(t.sql.rows("SELECT token FROM event_batches")).toEqual([{ token: t.app.token }]);
    for (const k of keys) expect(k).toMatch(/^events\/dt=2026-10-13\//);
    expect([...t.r2.objects.keys()].some((k) => k.startsWith("export/"))).toBe(false);
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

  it("keeps 90 days for every project that had it (no account, Free), a year for Pro and Custom, and 30 days of grace after a plan ends", async () => {
    const { env, sql, r2 } = setup(LIVE);
    const free = await signedIn(env, "free@example.com");
    const pro = await signedIn(env, "pro@example.com");
    const custom = await signedIn(env, "custom@example.com");
    const lapsed = await signedIn(env, "lapsed@example.com");
    const gone = await signedIn(env, "gone@example.com");
    setPlan(sql, pro.account.id, "pro");
    setPlan(sql, custom.account.id, "custom");
    setPlan(sql, lapsed.account.id, "free", { subscription_id: "sub_lapsed0001", subscription_status: "canceled", current_period_end: new Date(now().getTime() - 10 * DAY).toISOString() });
    setPlan(sql, gone.account.id, "free", { subscription_id: "sub_gone000001", subscription_status: "canceled", current_period_end: new Date(now().getTime() - 40 * DAY).toISOString() });
    const apps: Record<string, string> = {};
    for (const [k, a] of Object.entries({ free, pro, custom, lapsed, gone })) apps[k] = (await createApp(env, a.cookie, k)).token;
    const anon = ((await (await call(env, "POST", "/api/projects", { body: { name: "Anon" }, origin: null })).json()) as any).token as string;
    for (const tok of [...Object.values(apps), anon]) seed(sql, tok, [1, 89, 91, 200, 364, 366]);
    // export copies and index rows: 200 days old, for Pro and for the account that lapsed 40 days ago
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

    for (const k of ["free", "gone"]) expect(ages(sql, apps[k]!), k).toEqual([1, 89]);
    expect(ages(sql, anon)).toEqual([1, 89]);
    for (const k of ["pro", "custom", "lapsed"]) expect(ages(sql, apps[k]!), k).toEqual([1, 89, 91, 200, 364]);
    expect(sql.rows("SELECT COUNT(*) AS n FROM recent WHERE token = ?", apps.pro)[0]!.n).toBe(5);
    expect(sql.rows("SELECT COUNT(*) AS n FROM recent WHERE token = ?", apps.free)[0]!.n).toBe(2);
    // export copies: Pro's 200-day copy stays, its 370-day one and the lapsed account's go (from R2 too)
    expect(r2.objects.has(proCopy)).toBe(true);
    expect(r2.deleted.sort()).toEqual([goneCopy, proOld].sort());
    expect(sql.rows("SELECT key FROM event_batches ORDER BY key").map((r) => r.key)).toEqual([freeNew, proCopy].sort());
    expect(sql.rows("SELECT COUNT(*) AS n FROM forward_log")[0]!.n).toBe(1);
    expect(sql.rows("SELECT id FROM billing_events")).toEqual([{ id: "evt_new" }]);
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

// Interaction analytics, visits and funnels (docs/runtime/ANALYTICS.md sections 1.2 and 3.1): the view that opens a
// visit adds its source, device, country and new-or-returning counters; every view's route goes into the visit's row;
// stats count entry and exit pages, pages per visit and the app's funnels from those rows; funnels are saved from the
// dashboard (private link or account) and checked; retention drops visits after 90 days.
import { describe, expect, it } from "vitest";
import { d1 } from "./d1.js";
import { call, createApp, setup as acctSetup, signedIn } from "./account-helpers.js";
import { aggregate, cleanFunnels, createProject, funnelGlob, funnelStep, retention, saveFunnels, stats, VISIT_ROUTES } from "../src/dashboard.js";
import { handle } from "../src/collector.js";

const NOW = new Date("2026-10-25T12:00:00Z");
type E = Record<string, unknown>;
const V1 = "0123456789abcdef";
const V2 = "fedcba9876543210";
let seq = 0;
/** A view's first event, as runtime 0.3.0-beta.2 sends it. */
const view = (route: string, visit: string, o: E = {}): E => ({ t: "interactions", seq: ++seq, at: seq * 10, view: seq, route, start: true, visit, ...o });
const entry = (o: E = {}): E => ({ entry: true, device: "mobile", browser: "Safari", os: "iOS", returning: false, ...o });
const batch = (events: E[], sid = "a1b2c3d4e5f6a7b8c9d0e1f2", country: string | null = "DE") => ({ sid, runtime: "0.3.0-beta.2", model: null, events, country });
const bd = (s: Awaited<ReturnType<typeof stats>>, m: string) => Object.fromEntries((s.breakdowns[m] ?? []).map((x) => [x.key, x.count]));

async function app() {
  const sql = d1();
  const p = await createProject(sql.api, "Shop", NOW);
  const proj = { token: p.token, name: p.name, created: p.created, last_event: null } as never;
  return { sql, token: p.token, secret: p.secret, statsOf: (range: "24h" | "7d" | "30d" = "7d") => stats(sql.api, proj, range, NOW) };
}

describe("visits: per-visit counters from the view that opens a visit", () => {
  it("source, utm values, device, browser, OS, country and new or returning, once per visit", async () => {
    const { sql, token, statsOf } = await app();
    await aggregate(sql.api, token, batch([
      view("/", V1, entry({ ref: "google.com", utm: { source: "newsletter", medium: "email", campaign: "autumn-sale" } })),
      view("/pricing", V1),
      view("/docs", V2, entry({ device: "desktop", browser: "Firefox", os: "Linux", returning: true })),
    ]), NOW);
    const s = await statsOf();
    expect(s.totals.ix_sessions).toBe(2);
    expect(s.totals.ix_views).toBe(3);
    expect(bd(s, "ix_ref")).toEqual({ "google.com": 1, "(direct)": 1 });
    expect(bd(s, "ix_utm_source")).toEqual({ newsletter: 1 });
    expect(bd(s, "ix_utm_medium")).toEqual({ email: 1 });
    expect(bd(s, "ix_utm_campaign")).toEqual({ "autumn-sale": 1 });
    expect(bd(s, "ix_device")).toEqual({ mobile: 1, desktop: 1 });
    expect(bd(s, "ix_browser")).toEqual({ Safari: 1, Firefox: 1 });
    expect(bd(s, "ix_os")).toEqual({ iOS: 1, Linux: 1 });
    expect(bd(s, "ix_country")).toEqual({ DE: 2 });
    expect(bd(s, "ix_returning")).toEqual({ new: 1, returning: 1 });
    expect(s.series.at(-1)).toMatchObject({ ix_sessions: 2, ix_views: 3 });
  });

  it("values outside the allowlists are not counted as sent; no visit id, no counters; a repeated batch adds nothing", async () => {
    const { sql, token, statsOf } = await app();
    const events = [
      view("/", V1, entry({ ref: "https://evil.example/path?email=a@b.c", utm: { source: "<script>", medium: 5, campaign: "x".repeat(41) }, device: "fridge", browser: "Netscape 4", os: "BeOS" })),
      view("/b", "not-a-visit-id", entry()),
    ];
    await aggregate(sql.api, token, batch(events, undefined, null), NOW);
    await aggregate(sql.api, token, batch(events, undefined, null), NOW);
    const s = await statsOf();
    expect(s.totals.ix_sessions).toBe(1);
    expect(bd(s, "ix_ref")).toEqual({ "(other)": 1 });
    expect(bd(s, "ix_utm_source")).toEqual({});
    expect(bd(s, "ix_utm_campaign")).toEqual({});
    expect(bd(s, "ix_device")).toEqual({ "(unknown)": 1 });
    expect(bd(s, "ix_browser")).toEqual({ Other: 1 });
    expect(bd(s, "ix_os")).toEqual({ Other: 1 });
    expect(bd(s, "ix_country")).toEqual({ "(unknown)": 1 });
    expect(s.visits).toMatchObject({ sessions: 1, pages: 1 });
    expect(JSON.stringify(sql.rows("SELECT * FROM visits"))).not.toContain(V1); // only a hash of it
  });

  it("through the collector: the country comes from request.cf, never from the batch", async () => {
    const { env, sql } = acctSetup();
    const p = await createProject(sql.api, "Shop", NOW);
    const body = { schema: "genclass-telemetry/1", sid: "cccccccccccc", sent: 1, runtime: "0.3.0-beta.2", model: null, token: p.token, events: [view("/", V1, entry({ country: "FR" }))] };
    const req = new Request("https://genclass.dev/api/v1/events", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "text/plain" } });
    Object.defineProperty(req, "cf", { value: { country: "JP", city: "Osaka" } });
    expect((await handle(req, env, { now: () => NOW })).status).toBe(202);
    expect(sql.rows("SELECT key, count FROM daily WHERE metric = 'ix_country'")).toEqual([{ key: "JP", count: 1 }]);
  });
});

describe("visits: entry and exit pages, pages per visit (the visits table)", () => {
  it("a visit's row spans batches and page loads: entry, exit, page count, routes in order", async () => {
    const { sql, token, statsOf } = await app();
    await aggregate(sql.api, token, batch([view("/", V1, entry()), view("/products/:id", V1)], "s1s1s1s1s1s1"), NOW);
    await aggregate(sql.api, token, batch([view("/cart", V1), view("/checkout", V1)], "s2s2s2s2s2s2"), new Date(NOW.getTime() + 60_000));
    await aggregate(sql.api, token, batch([view("/blog", V2, entry())], "s3s3s3s3s3s3"), NOW);
    expect(sql.rows("SELECT entry, exit, pages, routes FROM visits ORDER BY entry")).toEqual([
      { entry: "/", exit: "/checkout", pages: 4, routes: "\t/\t\t/products/:id\t\t/cart\t\t/checkout\t" },
      { entry: "/blog", exit: "/blog", pages: 1, routes: "\t/blog\t" },
    ]);
    const s = await statsOf();
    expect(s.visits).toEqual({
      sessions: 2,
      pages: 5,
      bounces: 1,
      entry: [{ key: "/", count: 1 }, { key: "/blog", count: 1 }],
      exit: [{ key: "/blog", count: 1 }, { key: "/checkout", count: 1 }],
    });
  });

  it("a visit's routes stop growing at VISIT_ROUTES page views; its page count and exit keep going", async () => {
    const { sql, token } = await app();
    for (let b = 0; b < 3; b++) await aggregate(sql.api, token, batch(Array.from({ length: 30 }, (_, i) => view(`/p${b * 30 + i}`, V1)), `sid${b}sid${b}sid${b}`), NOW);
    const r = sql.rows("SELECT pages, exit, routes FROM visits")[0]!;
    expect(r.pages).toBe(90);
    expect(r.exit).toBe("/p89");
    expect(String(r.routes).split("\t\t").length).toBe(60); // the batch that crossed VISIT_ROUTES still went in whole
    expect(VISIT_ROUTES).toBe(50);
  });
});

describe("funnels (stored per app, counted from the visits' routes)", () => {
  it("steps: routes normalised like the runtime's, a trailing * for a prefix; 5 funnels of 2 to 6 steps", () => {
    expect(funnelStep(" /products/123 ")).toBe("/products/:id");
    expect(funnelStep("/docs/*")).toBe("/docs/*");
    expect(funnelStep("/a*b")).toBeNull();
    expect(funnelStep("pricing")).toBeNull();
    expect(cleanFunnels([{ name: "  Buy  ", steps: ["/", "/checkout?x=1"] }])).toEqual([{ name: "Buy", steps: ["/", "/checkout"] }]);
    expect(cleanFunnels([{ steps: ["/", "/b"] }])).toEqual([{ name: "Funnel 1", steps: ["/", "/b"] }]);
    expect(cleanFunnels([{ steps: ["/"] }])).toEqual({ error: "a funnel has 2 to 6 steps" });
    expect(cleanFunnels([{ steps: Array(7).fill("/") }])).toEqual({ error: "a funnel has 2 to 6 steps" });
    expect(cleanFunnels(Array(6).fill({ steps: ["/", "/b"] }))).toEqual({ error: "at most 5 funnels" });
    expect(cleanFunnels([{ steps: ["/", "nope"] }])).toEqual({ error: "not a page route: nope (a step starts with /)" });
    expect(cleanFunnels("x")).toEqual({ error: "funnels must be an array" });
    expect(funnelGlob(["/", "/docs/*", "/a[1]?"])).toBe("*\t/\t*\t/docs/*\t*\t/a[[]1][?]\t*");
  });

  it("each step counts the visits that reached every step before it in order, retroactively", async () => {
    const { sql, token, statsOf } = await app();
    const visits: [string, string[]][] = [
      ["1111111111111111", ["/", "/products/:id", "/cart", "/checkout"]],
      ["2222222222222222", ["/products/:id", "/", "/cart"]], // the cart after a product, with a step between
      ["3333333333333333", ["/cart", "/products/:id"]], // wrong order: product only
      ["4444444444444444", ["/docs/intro", "/docs/api", "/Pricing"]],
      ["5555555555555555", ["/pricing"]],
    ];
    let n = 0;
    for (const [v, routes] of visits) await aggregate(sql.api, token, batch(routes.map((r, i) => view(r, v, i ? {} : entry())), `sid${++n}sid${n}sid${n}`), NOW);
    await saveFunnels(sql.api, token, [
      { name: "Checkout", steps: ["/products/:id", "/cart", "/checkout"] },
      { name: "Docs", steps: ["/docs/*", "/pricing"] },
    ]);
    const s = await statsOf();
    expect(s.funnels).toEqual([
      { name: "Checkout", steps: ["/products/:id", "/cart", "/checkout"], counts: [3, 2, 1] },
      // GLOB is case-sensitive: /Pricing is not /pricing
      { name: "Docs", steps: ["/docs/*", "/pricing"], counts: [1, 0] },
    ]);
    await saveFunnels(sql.api, token, []);
    expect((await statsOf()).funnels).toEqual([]);
  });

  it("saved from the private link: checked, the whole list replaced; the sample cannot be changed", async () => {
    const { env, sql } = acctSetup();
    const p = await createProject(sql.api, "Shop", NOW);
    const put = (path: string, body: unknown, ct = "application/json") =>
      handle(new Request(`https://genclass.dev${path}`, { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": ct } }), env, { now: () => NOW });
    const ok = await put(`/api/projects/${p.secret}/funnels`, { funnels: [{ name: "Signup", steps: ["/", "/signup", "/welcome"] }] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, funnels: [{ name: "Signup", steps: ["/", "/signup", "/welcome"] }] });
    expect(sql.rows("SELECT funnels FROM projects")[0]!.funnels).toBe('[{"name":"Signup","steps":["/","/signup","/welcome"]}]');
    expect((await put(`/api/projects/${p.secret}/funnels`, { funnels: [{ steps: ["/"] }] })).status).toBe(400);
    expect((await put(`/api/projects/${p.secret}/funnels`, "{}", "text/plain")).status).toBe(415);
    expect((await put(`/api/projects/${p.secret}/funnels`, "x".repeat(5000))).status).toBe(413);
    expect((await put(`/api/projects/${"A".repeat(32)}/funnels`, { funnels: [] })).status).toBe(404);
    expect((await put("/api/projects/sample/funnels", { funnels: [] })).status).toBe(403);
    const get = await handle(new Request(`https://genclass.dev/api/projects/${p.secret}/funnels`), env, { now: () => NOW });
    expect(get.status).toBe(405);
    // the stats carry them
    const st = (await (await handle(new Request(`https://genclass.dev/api/projects/${p.secret}?range=7d`), env, { now: () => NOW })).json()) as { funnels: unknown[] };
    expect(st.funnels).toEqual([{ name: "Signup", steps: ["/", "/signup", "/welcome"], counts: [0, 0, 0] }]);
  });

  it("saved in account mode: the owner's browser session with our Origin; not a CLI session, not another account", async () => {
    const { env } = acctSetup();
    const { cookie } = await signedIn(env);
    const appRow = await createApp(env, cookie);
    const body = { funnels: [{ name: "Trial", steps: ["/pricing", "/signup"] }] };
    expect((await call(env, "PUT", `/api/account/projects/${appRow.id}/funnels`, { body, cookie })).status).toBe(200);
    expect((await call(env, "PUT", `/api/account/projects/${appRow.id}/funnels`, { body, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(env, "PUT", `/api/account/projects/${appRow.id}/funnels`, { body })).status).toBe(401);
    const other = await signedIn(env, "bob@example.com");
    expect((await call(env, "PUT", `/api/account/projects/${appRow.id}/funnels`, { body, cookie: other.cookie })).status).toBe(404);
    const st = (await (await call(env, "GET", `/api/account/projects/${appRow.id}/stats?range=7d`, { cookie })).json()) as { funnels: { name: string }[] };
    expect(st.funnels.map((f) => f.name)).toEqual(["Trial"]);
  });
});

describe("visits: retention", () => {
  it("drops visits that started more than 90 days ago, on every plan", async () => {
    const { sql, token } = await app();
    const ins = sql.db.prepare("INSERT INTO visits (visit_hash, token, started, updated, entry, exit, pages, routes) VALUES (?, ?, ?, ?, '/', '/', 1, '\t/\t')");
    ins.run("old", token, "2026-07-26T11:00:00.000Z", "2026-07-26T11:00:00.000Z");
    ins.run("new", token, "2026-07-27T13:00:00.000Z", "2026-07-27T13:00:00.000Z");
    await retention(sql.api, NOW);
    expect(sql.rows("SELECT visit_hash FROM visits").map((r) => r.visit_hash)).toEqual(["new"]);
  });
});

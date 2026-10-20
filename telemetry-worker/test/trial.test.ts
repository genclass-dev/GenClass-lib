import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { accessOf, longRetention, onSale, TRIAL_PLAN, trialDays, trialDaysLeft } from "../src/plans.js";
import { advance, call, cliToken, createApp, detection, now, ORIGIN, resetClock, sendBatch, setPlan, setup, signedIn } from "./account-helpers.js";

// The dashboard is free (src/plans.ts: every plan has it): a new account's apps are collected and their dashboards
// open at once, with no plan, grant or trial. The trial (src/trial.ts) is of Individual, the hosted closed-loop MCP:
// one per account, no card, no Stripe, and only while billing/plans.json has Individual on sale (it is not, until the
// hosted MCP ships), so today no page shows a trial button and POST /api/billing/trial answers 409. The semantics are
// tested with the plan put on sale for the test. No public copy names the plans of before 2026-10-20, locked
// dashboards or an analytics trial any more.

const DAY = 86_400_000;
const WAS_ON_SALE = TRIAL_PLAN.on_sale;

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
});
afterEach(() => {
  TRIAL_PLAN.on_sale = WAS_ON_SALE;
});

/** billing/plans.json as committed (the hosted MCP has not shipped), or the plan put on sale for a test. */
const sale = (on: boolean) => {
  TRIAL_PLAN.on_sale = on;
  expect(onSale(TRIAL_PLAN)).toBe(on);
};

const trial = (env: Parameters<typeof call>[0], cookie: string, o: { origin?: string | null } = {}) => call(env, "POST", "/api/billing/trial", { body: {}, cookie, ...o });
const text = async (r: Promise<Response> | Response) => (await r).text();

const START = (days = 7) => `Start your ${days}-day free trial`;
/** Copy from before 2026-10-20: the two paid plans of that time by name and price, locked dashboards and the analytics trial. */
const OLD = /trials available|start a trial|come with pro\b|trial for analytics|\bpro\b|\bcustom\b|\$99\b|\b599\b|\blocked\b/i;

describe("the dashboard is free: a new account's apps are collected and their dashboards open at once", () => {
  it("the app's page shows the stats, the Connect panel and the key; its stats answer 200 with a year of ranges; no page offers a trial", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie, "Shop");
    await sendBatch(env, app.token, detection());
    expect(Number(sql.rows("SELECT COUNT(*) AS n FROM daily WHERE token = ?", app.token)[0]!.n)).toBeGreaterThan(0);
    const html = await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }));
    expect(html).toContain(`/api/account/projects/${app.id}/stats`);
    expect(html).toContain("Connect this app");
    expect(html).toContain(app.token);
    expect(html).toContain('data-r="1y"');
    expect(html).toContain('id="exf"');
    expect(html).toContain('data-kind="slack"');
    expect(html).not.toContain('id="trial"');
    expect(html).not.toMatch(OLD);
    expect(html).not.toMatch(/ style="/);
    const st = await call(env, "GET", `/api/account/projects/${app.id}/stats?range=1y`, { cookie });
    expect(st.status).toBe(200);
    expect(((await st.json()) as any).totals.detections).toBe(1);
    // the account page has no plan block (nothing to unlock); the billing page shows Individual as coming next
    const acct = await text(call(env, "GET", "/account", { cookie }));
    expect(acct).not.toContain('<section class="blk" id="plan">');
    expect(acct).not.toContain('id="trial"');
    expect(acct).not.toMatch(OLD);
    const billing = await text(call(env, "GET", "/account/billing", { cookie }));
    expect(billing).not.toContain('id="trial"');
    expect(billing).not.toContain(START());
    expect(billing).toContain('<span class="tag">Coming next</span>');
    expect(billing).toContain("You are on the <b>Free</b> plan: everything GenClass makes, for every app (you have 1 app)");
    expect(billing).toContain("What costs money is running the closed-loop MCP for you: Individual ($20 a month) hosts it on genclass.dev; Enterprise runs it inside your own network.");
    expect(billing).not.toMatch(OLD);
  });

  it("POST /api/billing/trial answers 409 while Individual is not on sale, and writes nothing", async () => {
    sale(false);
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    const r = await trial(env, cookie);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, error: "Individual is not on sale yet" });
    expect(sql.rows("SELECT trial_started_at, trial_ends_at FROM accounts")).toEqual([{ trial_started_at: null, trial_ends_at: null }]);
    // the pricing page's button still lands on the account page, which has no trial to focus
    const page = await text(call(env, "GET", "/account?trial=1", { cookie }));
    expect(page).toContain('"trial":true');
    expect(page).not.toContain('id="trial"');
    expect(await (await call(env, "GET", "/api/billing", { cookie })).json()).toMatchObject({ plan: "free", access: null });
  });
});

describe("trials: one per account, no card, Individual's entitlements while it runs (the plan on sale)", () => {
  beforeEach(() => sale(true));

  it("starts from the browser only (session and our Origin), once; the dashboard says the days left, nowhere else", async () => {
    const { env } = setup();
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie);
    // on sale: the account and billing pages offer it
    const acct = await text(call(env, "GET", "/account?trial=1", { cookie }));
    expect(acct).toContain('<section class="blk" id="plan">');
    expect(acct).toContain(`<button class="btn green" type="button" id="trial"><span>${START()}</span></button>`);
    expect(acct).toContain("if (cfg.trial) trial.focus();");
    expect(await text(call(env, "GET", "/account/billing", { cookie }))).toContain(`<button class="btn green" type="button" id="trial"><span>${START()}</span></button>`);
    expect((await call(env, "POST", "/api/billing/trial", { body: {} })).status).toBe(401);
    expect((await trial(env, cookie, { origin: "https://evil.example" })).status).toBe(403);
    const bearer = await cliToken(env, cookie);
    expect((await call(env, "POST", "/api/billing/trial", { body: {}, bearer, origin: null })).status).toBe(403);
    expect((await call(env, "GET", "/api/billing/trial", { cookie })).status).toBe(405);
    const r = await trial(env, cookie);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, trial: { started: now().toISOString(), ends: new Date(now().getTime() + 7 * DAY).toISOString() } });
    const again = await trial(env, cookie);
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error).toMatch(/already had its trial/);
    // the dashboard (free either way) says the days left
    const html = await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }));
    expect(html).toContain('<p class="trialn" id="trialn">Individual trial: 7 days left. <a href="/account/billing">See plans</a></p>');
    expect(html).toContain('data-r="1y"');
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats?range=1y`, { cookie })).status).toBe(200);
    advance(6 * DAY + 3_600_000);
    expect(await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }))).toContain("Individual trial: last day.");
    // the days left are said in the dashboard only; the account and billing pages no longer offer the trial
    for (const path of ["/account", "/account/billing"]) {
      const page = await text(call(env, "GET", path, { cookie }));
      expect(page, path).not.toMatch(/days? left|last day/i);
      expect(page, path).not.toContain(START());
      expect(page, path).not.toMatch(OLD);
    }
    expect(await text(call(env, "GET", "/account/billing", { cookie }))).toContain("You are on a free trial of <b>Individual</b>.");
    expect(await (await call(env, "GET", "/api/billing", { cookie })).json()).toMatchObject({ plan: "free", access: "trial", can_trial: false, trial_ends_at: new Date(now().getTime() - 6 * DAY - 3_600_000 + 7 * DAY).toISOString() });
  });

  it("lasts TRIAL_DAYS, then Free again for good: the dashboard stays open, no second trial, the plans instead", async () => {
    const { env } = setup({ TRIAL_DAYS: "3" });
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie);
    // every page that offers the trial says its real length
    for (const path of ["/account", "/account/billing"]) expect(await text(call(env, "GET", path, { cookie })), path).toContain(START(3));
    expect(((await (await trial(env, cookie)).json()) as any).trial.ends).toBe(new Date(now().getTime() + 3 * DAY).toISOString());
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie })).status).toBe(200);
    advance(3 * DAY + 1000);
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie })).status).toBe(200);
    const html = await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }));
    expect(html).not.toContain('id="trialn"');
    expect(html).not.toContain('id="trial"');
    expect(html).toContain(`/api/account/projects/${app.id}/stats`);
    expect((await trial(env, cookie)).status).toBe(409);
    const acct = await text(call(env, "GET", "/account", { cookie }));
    expect(acct).not.toContain('<section class="blk" id="plan">');
    expect(acct).not.toContain('id="trial"');
    const billing = await text(call(env, "GET", "/account/billing", { cookie }));
    expect(billing).toContain("Your free trial of Individual has ended.");
    expect(billing).not.toContain('id="trial"');
    expect(await (await call(env, "GET", "/api/billing", { cookie })).json()).toMatchObject({ plan: "free", access: null, can_trial: false });
    for (const [v, days] of [["0", 7], ["61", 7], ["abc", 7], [undefined, 7], ["14", 14], [" 3 ", 3]] as const) expect(trialDays({ BUCKET: { async put() {} }, TRIAL_DAYS: v }), String(v)).toBe(days);
    expect(trialDaysLeft(new Date(now().getTime() + 1).toISOString(), now())).toBe(1);
  });

  it("no plan limits apps (only the abuse cap); the trial forgets the collector's cached plan so its entitlements apply from the next batch", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    const first = await createApp(env, cookie, "a");
    for (const n of ["b", "c", "d", "e"]) await createApp(env, cookie, n);
    expect(((await (await call(env, "GET", "/api/account/projects", { cookie })).json()) as any).projects).toHaveLength(5);
    // Free exports already (one index row per batch of an app in an account)
    await sendBatch(env, first.token, [{ t: "session", seq: 0 }]);
    expect(sql.rows("SELECT token FROM event_batches")).toEqual([{ token: first.token }]);
    expect((await trial(env, cookie)).status).toBe(200);
    await sendBatch(env, first.token, [{ t: "session", seq: 1 }], { sid: "dddddddddddd" });
    expect(sql.rows("SELECT COUNT(*) AS n FROM event_batches")[0]!.n).toBe(2);
    expect((await call(env, "GET", `/api/account/projects/${first.id}/events`, { cookie })).status).toBe(200);
    advance(7 * DAY + 1000);
    resetOwnerCache();
    expect((await call(env, "POST", "/api/account/projects", { body: { name: "f" }, cookie })).status).toBe(201);
    expect((await call(env, "GET", `/api/account/projects/${first.id}/events`, { cookie })).status).toBe(200);
  });

  it("a paid plan wins over the trial; GenClass's own grant (comp_until, set by a D1 update) gives Individual until it ends", async () => {
    const { env, sql } = setup();
    const owner = await signedIn(env, "owner@example.com");
    const app = await createApp(env, owner.cookie);
    sql.db.prepare("UPDATE accounts SET comp_until = ? WHERE id = ?").run(new Date(now().getTime() + 10 * DAY).toISOString(), owner.account.id);
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie: owner.cookie })).status).toBe(200);
    expect(await text(call(env, "GET", `/account/apps/${app.id}`, { cookie: owner.cookie }))).not.toContain('id="trialn"');
    const billing = await text(call(env, "GET", "/account/billing", { cookie: owner.cookie }));
    expect(billing).toContain("You have <b>Individual</b>, set up by GenClass.");
    expect(billing).toContain('<span class="tag">Set up by GenClass</span>');
    expect(((await (await trial(env, owner.cookie)).json()) as any).error).toMatch(/already has Individual/);
    expect(await (await call(env, "GET", "/api/billing", { cookie: owner.cookie })).json()).toMatchObject({ access: "comp", can_trial: false });
    advance(10 * DAY + 1000);
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie: owner.cookie })).status).toBe(200);
    expect(await (await call(env, "GET", "/api/billing", { cookie: owner.cookie })).json()).toMatchObject({ access: null, can_trial: true });
    // the grant used no trial: one is still there
    expect((await trial(env, owner.cookie)).status).toBe(200);

    const payer = await signedIn(env, "payer@example.com");
    setPlan(sql, payer.account.id, "individual");
    const r = await trial(env, payer.cookie);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toMatch(/already has the Individual plan/);
    expect(await text(call(env, "GET", "/account/billing", { cookie: payer.cookie }))).toContain("You are on the <b>Individual</b> plan, set up by GenClass.");
  });

  it("accessOf: the paid plan first, then the grant, then the trial; a test-mode plan does not count under a live key; an old plan id reads as Free", () => {
    const at = new Date("2026-10-15T12:00:00Z");
    const later = "2026-10-20T00:00:00.000Z";
    const earlier = "2026-10-10T00:00:00.000Z";
    const row = (o: Partial<Parameters<typeof accessOf>[0] & object> = {}) => ({ plan: "free", stripe_mode: null, trial_started_at: null, trial_ends_at: null, comp_until: null, ...o });
    expect(accessOf(null, null, at)).toMatchObject({ source: null, trialUsed: false, plan: { id: "free" } });
    expect(accessOf(row(), null, at)).toMatchObject({ source: null, plan: { id: "free" } });
    expect(accessOf(row({ trial_started_at: earlier, trial_ends_at: later }), null, at)).toEqual({ plan: expect.objectContaining({ id: "individual" }), source: "trial", trialEndsAt: later, trialUsed: true });
    expect(accessOf(row({ trial_started_at: earlier, trial_ends_at: earlier }), null, at)).toMatchObject({ source: null, trialUsed: true, plan: { id: "free" } });
    expect(accessOf(row({ comp_until: later, trial_started_at: earlier, trial_ends_at: later }), null, at)).toMatchObject({ source: "comp", plan: { id: "individual" } });
    expect(accessOf(row({ plan: "enterprise", comp_until: later }), "live", at)).toMatchObject({ source: "paid", plan: { id: "enterprise" } });
    expect(accessOf(row({ plan: "individual", stripe_mode: "test" }), "live", at)).toMatchObject({ source: null, plan: { id: "free" } });
    expect(accessOf(row({ plan: "individual", stripe_mode: "test", trial_started_at: earlier, trial_ends_at: later }), "live", at)).toMatchObject({ source: "trial" });
    // the plans of before 2026-10-20 (never sold): Free, and the dashboard is open anyway
    for (const old of ["pro", "custom"]) expect(accessOf(row({ plan: old }), "live", at), old).toMatchObject({ source: null, plan: { id: "free", entitlements: { dashboard: true } } });
  });

  it("retention: every account's apps keep a year (Free's history), whatever the plan, the Stripe mode, a grant or a trial; no parameters", () => {
    const l = longRetention(now(), "live")!;
    expect(l.tokens).toBe("SELECT p.token FROM projects p WHERE p.account_id IS NOT NULL");
    expect(l.params).toEqual([]);
    expect(l.days).toBe(365);
    // the same under a test key, no key, and when the sweep is not told the mode: the mode no longer decides retention
    for (const mode of ["test", null, undefined] as const) expect(longRetention(now(), mode), String(mode)).toEqual(l);
  });
});

describe("private links: the dashboard opens for whoever holds the link, with no account", () => {
  it("POST /api/projects (/start, and the 0.3.0-beta.0 CLI's init) answers as before; its link opens the dashboard and its stats", async () => {
    const { env } = setup();
    const r = await call(env, "POST", "/api/projects", { body: { name: "shop-web" }, origin: null });
    expect(r.status).toBe(201);
    const j = (await r.json()) as any;
    expect(j).toEqual({
      token: expect.stringMatching(/^gc_[A-Za-z0-9]{22}$/),
      dashboardUrl: expect.stringMatching(/^https:\/\/genclass\.dev\/dashboard\/[A-Za-z0-9]{32}$/),
      name: "shop-web",
      created: now().toISOString(),
    });
    const path = new URL(j.dashboardUrl).pathname;
    const secret = path.split("/").pop()!;
    const page = await call(env, "GET", path, { origin: null });
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain("shop-web");
    expect(html).toContain(j.token);
    expect(html).not.toContain(secret);
    // the dashboard itself, not a sign-in page in front of it
    expect(html).toContain(`<title>shop-web | GenClass dashboard</title>`);
    expect(html).not.toContain("sessionStorage");
    expect(html).not.toMatch(OLD);
    // link-only apps keep 90 days; the footer says so
    expect(html).toContain("Data is kept 90 days");
    expect((await call(env, "GET", `/api/projects/${secret}`, { origin: null })).status).toBe(200);
    // once the app is in an account, the same link shows the account's year
    const { cookie } = await signedIn(env);
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { secret }, cookie })).status).toBe(200);
    const claimed = await text(call(env, "GET", path, { origin: null }));
    expect(claimed).toContain("Data is kept 1 year");
    expect((await call(env, "GET", `/api/projects/${secret}`, { origin: null })).status).toBe(200);
  });

  it("GET /account/trial (the pricing page's button) leads to the account page, through sign-up; a GET starts nothing", async () => {
    sale(true);
    const { env, sql } = setup();
    expect((await call(env, "GET", "/account/trial", {})).headers.get("location")).toBe("/signup?next=%2Faccount%3Ftrial%3D1");
    const { cookie } = await signedIn(env);
    expect((await call(env, "GET", "/signup?next=%2Faccount%3Ftrial%3D1", { cookie })).headers.get("location")).toBe("/account?trial=1");
    expect((await call(env, "GET", "/account/trial", { cookie })).headers.get("location")).toBe("/account?trial=1");
    expect(sql.rows("SELECT trial_started_at FROM accounts")).toEqual([{ trial_started_at: null }]);
    const page = await text(call(env, "GET", "/account?trial=1", { cookie }));
    expect(page).toContain('"trial":true');
    expect(page).toContain("if (cfg.trial) trial.focus();");
    expect(page).toContain(`id="trial"><span>${START()}</span>`);
    expect((await trial(env, cookie)).status).toBe(200);
    expect(await text(call(env, "GET", "/account?started=1", { cookie }))).toContain("Your Individual trial has started.");
  });

  it("public pages say the dashboard is free, and nothing about the old plans, locked dashboards or an analytics trial", async () => {
    const { env } = setup();
    const start = await text(call(env, "GET", "/start", {}));
    const signup = await text(call(env, "GET", "/signup", {}));
    const login = await text(call(env, "GET", "/login", {}));
    const { cookie } = await signedIn(env);
    const pages = [start, signup, login, await text(call(env, "GET", "/account", { cookie })), await text(call(env, "GET", "/account/billing", { cookie }))];
    for (const p of pages) {
      expect(p).not.toMatch(OLD);
      expect(p).not.toMatch(/days? left/i);
    }
    expect(start).toContain("The dashboard is free and needs no account.");
    expect(start).toContain("Data is kept for 90 days for an app known only by its\nprivate link, and for 1 year while the app is in a genclass.dev account.");
    for (const p of [signup, login]) expect(p).toContain('<p class="opt">The runtime needs no account. The dashboard is free: the private link shows the stats, and an account keeps your apps in one place.</p>');
  });

  it("one number per side: wrangler.toml TRIAL_DAYS equals billing/plans.json trial_days (the site reads that field)", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const days = /^TRIAL_DAYS = "(\d+)"$/m.exec(toml)?.[1];
    expect(days).toBeDefined();
    const plans = JSON.parse(readFileSync(new URL("../../billing/plans.json", import.meta.url), "utf8"));
    expect(plans.trial_days).toBe(Number(days));
    expect(trialDays({ BUCKET: { async put() {} }, TRIAL_DAYS: days })).toBe(plans.trial_days);
    // the site's build reads that field for the public copy
    expect(readFileSync(new URL("../../site/build.py", import.meta.url), "utf8")).toMatch(/PLANS(\.get\("trial_days"\)|\["trial_days"\])/);
    // the trial is of Individual, a plan sold through Stripe
    expect(plans.plans.find((p: any) => p.id === TRIAL_PLAN.id)).toMatchObject({ sale: "stripe", price_usd_cents: { monthly: 2000 } });
  });
});

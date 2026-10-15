import { beforeEach, describe, expect, it } from "vitest";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { accessOf, longRetention, trialDays, trialDaysLeft } from "../src/plans.js";
import { advance, call, cliToken, createApp, detection, now, ORIGIN, resetClock, sendBatch, setPlan, setup, signedIn } from "./account-helpers.js";

// Dashboards come with Pro (src/plans.ts accountAccess, src/trial.ts): apps of an account without a paid plan,
// GenClass's grant or a trial are collected but their dashboards are locked; one trial per account, no card, no
// Stripe; private links from /start and the 0.3.0-beta.0 CLI's init open a locked page that leads to sign-in, adding the
// app to an account and the trial. Public copy never says how long a trial lasts.

const DAY = 86_400_000;

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
});

const trial = (env: Parameters<typeof call>[0], cookie: string, o: { origin?: string | null } = {}) => call(env, "POST", "/api/billing/trial", { body: {}, cookie, ...o });
const text = async (r: Promise<Response> | Response) => (await r).text();

/** Nothing on a public page says how long a trial lasts ("Trials available"). */
const LENGTH = /\b(7|seven)[- ]days?\b|one[- ]week|week[- ]long|\d+[- ]day trial|trial (lasts|of \d|for \d)/i;

describe("dashboards come with Pro: a new account's apps are collected, and their dashboards locked", () => {
  it("the app's page keeps its key and Connect panel and offers the trial; its stats answer 402; ingest keeps counting", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie, "Shop");
    await sendBatch(env, app.token, detection());
    expect(Number(sql.rows("SELECT COUNT(*) AS n FROM daily WHERE token = ?", app.token)[0]!.n)).toBeGreaterThan(0);
    const html = await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }));
    expect(html).toContain('<h2 id="lock-h">Dashboards come with Pro.</h2>');
    expect(html).toContain("<p>Trials available.</p>");
    expect(html).toContain('<button class="btn green" type="button" id="trial">Start a trial</button>');
    expect(html).toContain("Connect this app");
    expect(html).toContain(app.token);
    expect(html).not.toContain(`/api/account/projects/${app.id}/stats`);
    expect(html).not.toMatch(/ style="/);
    const st = await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie });
    expect(st.status).toBe(402);
    expect(await st.json()).toEqual({ ok: false, error: "dashboards come with Pro (trials available)", locked: true, upgrade_url: `${ORIGIN}/account/billing` });
    const acct = await text(call(env, "GET", "/account", { cookie }));
    expect(acct).toContain('<section class="blk" id="plan">');
    expect(acct).toContain('<h2>Dashboards come with Pro</h2><span class="aside">Trials available</span>');
    expect(acct).toContain('<button class="btn green" type="button" id="trial"><span>Start a trial</span></button>');
    for (const page of [html, acct, await text(call(env, "GET", "/account/billing", { cookie }))]) expect(page).not.toMatch(LENGTH);
  });
});

describe("trials: one per account, no card, Pro's entitlements while it runs", () => {
  it("starts from the browser only (session and our Origin), once; the dashboard opens and says the days left, nowhere else", async () => {
    const { env } = setup();
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie);
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
    // the dashboard opens, with Pro's ranges and the days left
    const html = await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }));
    expect(html).not.toContain("Dashboards come with Pro.");
    expect(html).toContain('<p class="trialn" id="trialn">Pro trial: 7 days left. <a href="/account/billing">See plans</a></p>');
    expect(html).toContain('data-r="1y"');
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats?range=1y`, { cookie })).status).toBe(200);
    advance(6 * DAY + 3_600_000);
    expect(await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }))).toContain("Pro trial: last day.");
    // the account and billing pages never say how long
    for (const path of ["/account", "/account/billing"]) {
      const page = await text(call(env, "GET", path, { cookie }));
      expect(page, path).not.toMatch(/days? left|last day/i);
      expect(page, path).not.toMatch(LENGTH);
      expect(page, path).not.toContain("Dashboards come with Pro");
    }
    expect(await text(call(env, "GET", "/account/billing", { cookie }))).toContain("You are on a <b>Pro</b> trial.");
    expect(await (await call(env, "GET", "/api/billing", { cookie })).json()).toMatchObject({ plan: "free", access: "trial", can_trial: false, trial_ends_at: new Date(now().getTime() - 6 * DAY - 3_600_000 + 7 * DAY).toISOString() });
  });

  it("lasts TRIAL_DAYS, then the dashboard locks again for good: no second trial, the plans instead", async () => {
    const { env } = setup({ TRIAL_DAYS: "3" });
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie);
    expect(((await (await trial(env, cookie)).json()) as any).trial.ends).toBe(new Date(now().getTime() + 3 * DAY).toISOString());
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie })).status).toBe(200);
    advance(3 * DAY + 1000);
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie })).status).toBe(402);
    const html = await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }));
    expect(html).toContain("Dashboards come with Pro.");
    expect(html).toContain("<p>Your trial has ended.</p>");
    expect(html).not.toContain('id="trial"');
    expect(html).toContain('<a class="btn green" href="/account/billing">See plans</a>');
    expect((await trial(env, cookie)).status).toBe(409);
    const acct = await text(call(env, "GET", "/account", { cookie }));
    expect(acct).toContain('<span class="aside">Your trial has ended</span>');
    expect(acct).not.toContain('id="trial"');
    const billing = await text(call(env, "GET", "/account/billing", { cookie }));
    expect(billing).toContain("Your trial has ended.");
    expect(billing).not.toContain('id="trial"');
    for (const [v, days] of [["0", 7], ["61", 7], ["abc", 7], [undefined, 7], ["14", 14], [" 3 ", 3]] as const) expect(trialDays({ BUCKET: { async put() {} }, TRIAL_DAYS: v }), String(v)).toBe(days);
    expect(trialDaysLeft(new Date(now().getTime() + 1).toISOString(), now())).toBe(1);
  });

  it("while it runs: Pro's app limit and export; afterwards Free's limit again, and the apps already there stay", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    const first = await createApp(env, cookie, "a");
    for (const n of ["b", "c"]) await createApp(env, cookie, n);
    const fourth = await call(env, "POST", "/api/account/projects", { body: { name: "d" }, cookie });
    expect(fourth.status).toBe(409);
    expect(((await fourth.json()) as any).error).toMatch(/trials available/);
    await sendBatch(env, first.token, [{ t: "session", seq: 0 }]);
    expect((await trial(env, cookie)).status).toBe(200);
    for (const n of ["d", "e"]) await createApp(env, cookie, n);
    // export starts with the next batch (the trial forgets the collector's cached plan of the account's apps)
    await sendBatch(env, first.token, [{ t: "session", seq: 1 }], { sid: "dddddddddddd" });
    expect(sql.rows("SELECT token FROM event_batches")).toEqual([{ token: first.token }]);
    expect((await call(env, "GET", `/api/account/projects/${first.id}/events`, { cookie })).status).toBe(200);
    advance(7 * DAY + 1000);
    resetOwnerCache();
    expect((await call(env, "POST", "/api/account/projects", { body: { name: "f" }, cookie })).status).toBe(409);
    expect(((await (await call(env, "GET", "/api/account/projects", { cookie })).json()) as any).projects).toHaveLength(5);
    expect((await call(env, "GET", `/api/account/projects/${first.id}/events`, { cookie })).status).toBe(403);
  });

  it("a paid plan wins over the trial; GenClass's own grant (comp_until, set by a D1 update) opens dashboards until it ends", async () => {
    const { env, sql } = setup();
    const owner = await signedIn(env, "owner@example.com");
    const app = await createApp(env, owner.cookie);
    sql.db.prepare("UPDATE accounts SET comp_until = ? WHERE id = ?").run(new Date(now().getTime() + 10 * DAY).toISOString(), owner.account.id);
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie: owner.cookie })).status).toBe(200);
    expect(await text(call(env, "GET", `/account/apps/${app.id}`, { cookie: owner.cookie }))).not.toContain('id="trialn"');
    expect(await text(call(env, "GET", "/account/billing", { cookie: owner.cookie }))).toContain("set up by GenClass");
    expect(((await (await trial(env, owner.cookie)).json()) as any).error).toMatch(/already has Pro/);
    expect(await (await call(env, "GET", "/api/billing", { cookie: owner.cookie })).json()).toMatchObject({ access: "comp", can_trial: false });
    advance(10 * DAY + 1000);
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie: owner.cookie })).status).toBe(402);
    // the grant used no trial: one is still there
    expect((await trial(env, owner.cookie)).status).toBe(200);

    const payer = await signedIn(env, "payer@example.com");
    setPlan(sql, payer.account.id, "pro");
    const r = await trial(env, payer.cookie);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toMatch(/already has the Pro plan/);
  });

  it("accessOf: the paid plan first, then the grant, then the trial; a test-mode plan does not count under a live key", () => {
    const at = new Date("2026-10-15T12:00:00Z");
    const later = "2026-10-20T00:00:00.000Z";
    const earlier = "2026-10-10T00:00:00.000Z";
    const row = (o: Partial<Parameters<typeof accessOf>[0] & object> = {}) => ({ plan: "free", stripe_mode: null, trial_started_at: null, trial_ends_at: null, comp_until: null, ...o });
    expect(accessOf(null, null, at)).toMatchObject({ source: null, trialUsed: false, plan: { id: "free" } });
    expect(accessOf(row(), null, at)).toMatchObject({ source: null, plan: { id: "free" } });
    expect(accessOf(row({ trial_started_at: earlier, trial_ends_at: later }), null, at)).toEqual({ plan: expect.objectContaining({ id: "pro" }), source: "trial", trialEndsAt: later, trialUsed: true });
    expect(accessOf(row({ trial_started_at: earlier, trial_ends_at: earlier }), null, at)).toMatchObject({ source: null, trialUsed: true, plan: { id: "free" } });
    expect(accessOf(row({ comp_until: later, trial_started_at: earlier, trial_ends_at: later }), null, at)).toMatchObject({ source: "comp", plan: { id: "pro" } });
    expect(accessOf(row({ plan: "custom", comp_until: later }), "live", at)).toMatchObject({ source: "paid", plan: { id: "custom" } });
    expect(accessOf(row({ plan: "pro", stripe_mode: "test" }), "live", at)).toMatchObject({ source: null, plan: { id: "free" } });
    expect(accessOf(row({ plan: "pro", stripe_mode: "test", trial_started_at: earlier, trial_ends_at: later }), "live", at)).toMatchObject({ source: "trial" });
  });

  it("retention: the apps of a grant or a running trial keep Pro's history; the Stripe mode stays the last parameter", () => {
    const l = longRetention(now(), "live")!;
    expect(l.tokens).toContain("a.comp_until > ? OR a.trial_ends_at > ? OR ((a.plan IN (");
    expect(l.params.slice(0, 2)).toEqual([now().toISOString(), now().toISOString()]);
    expect(l.params[l.params.length - 1]).toBe("live");
    expect(l.days).toBe(365);
  });
});

describe("private links without Pro: sign in, add the app to the account, start the trial", () => {
  it("POST /api/projects (/start, and the 0.3.0-beta.0 CLI's init) answers as before; its link opens the locked page", async () => {
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
    expect(html).toContain("<h1>Dashboards come with Pro.</h1>");
    expect(html).toContain('<p class="lead">Trials available.</p>');
    expect(html).toContain('<div class="eb">shop-web</div>');
    // no OAuth on this server: sign in or sign up (passkeys), then back here through /account?claim=1
    expect(html).toContain('href="/login?next=%2Faccount%3Fclaim%3D1"');
    expect(html).toContain('href="/signup?next=%2Faccount%3Fclaim%3D1"');
    expect(html).toContain('sessionStorage.setItem("gc.claim", secret)');
    expect(html).not.toContain(secret);
    expect(html).not.toMatch(LENGTH);
    // with Google: Continue with Google first
    const g = setup({ GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "s" });
    const gj = (await (await call(g.env, "POST", "/api/projects", { body: {}, origin: null })).json()) as any;
    const gh = await text(call(g.env, "GET", new URL(gj.dashboardUrl).pathname, { origin: null }));
    expect(gh).toContain('href="/auth/google?next=%2Faccount%3Fclaim%3D1"');
    expect(gh.indexOf("Continue with Google")).toBeLessThan(gh.indexOf("Other ways to sign in"));
  });

  it("signed in: the page adds the app to the account and starts the trial; the link then opens the dashboard", async () => {
    const { env, sql } = setup();
    const anon = (await (await call(env, "POST", "/api/projects", { body: { name: "Old shop" }, origin: null })).json()) as any;
    const path = new URL(anon.dashboardUrl).pathname;
    const secret = path.split("/").pop()!;
    const { cookie, account } = await signedIn(env);
    // back from signing in: /account?claim=1 returns to the link this tab kept
    const back = await text(call(env, "GET", "/account?claim=1", { cookie }));
    expect(back).toContain('"claim":true');
    expect(back).toContain('location.replace("/dashboard/" + s)');
    const html = await text(call(env, "GET", path, { cookie }));
    expect(html).toContain('<button class="btn prov green" id="claim" type="button" data-trial="1"><span>Add to my account and start a trial</span></button>');
    expect(html).toContain('gcPost("/api/account/projects/claim", { secret: secret })');
    // what the button does: /account's claim, then the trial
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { secret }, cookie })).status).toBe(200);
    expect(await text(call(env, "GET", path, { cookie }))).toContain('id="trial"');
    expect((await trial(env, cookie)).status).toBe(200);
    // the link opens the dashboard now, for whoever holds it
    expect(await text(call(env, "GET", path, { origin: null }))).not.toContain("Dashboards come with Pro.");
    expect((await call(env, "GET", `/api/projects/${secret}`, { origin: null })).status).toBe(200);
    expect(sql.rows("SELECT account_id FROM projects WHERE token = ?", anon.token)).toEqual([{ account_id: account.id }]);
  });

  it("another account's app says so; an account whose trial ended can still add an app and is shown the plans", async () => {
    const { env, sql } = setup();
    const anon = (await (await call(env, "POST", "/api/projects", { body: { name: "Old shop" }, origin: null })).json()) as any;
    const path = new URL(anon.dashboardUrl).pathname;
    const ada = await signedIn(env, "ada@example.com");
    const bob = await signedIn(env, "bob@example.com");
    sql.db.prepare("UPDATE accounts SET trial_started_at = ?, trial_ends_at = ? WHERE id = ?").run("2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z", bob.account.id);
    const bobPage = await text(call(env, "GET", path, { cookie: bob.cookie }));
    expect(bobPage).toContain('data-trial="0"><span>Add to my account</span>');
    expect(bobPage).toContain('Your trial has ended. <a href="/account/billing">See plans</a>');
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, cookie: ada.cookie })).status).toBe(200);
    expect(await text(call(env, "GET", path, { cookie: bob.cookie }))).toContain("This app is in another GenClass account.");
    expect(await text(call(env, "GET", path, {}))).toContain("Then add this app to your account.");
  });

  it("GET /account/trial (the pricing page's button) leads to the account's Start a trial, through sign-up; a GET starts nothing", async () => {
    const { env, sql } = setup();
    expect((await call(env, "GET", "/account/trial", {})).headers.get("location")).toBe("/signup?next=%2Faccount%3Ftrial%3D1");
    const { cookie } = await signedIn(env);
    expect((await call(env, "GET", "/signup?next=%2Faccount%3Ftrial%3D1", { cookie })).headers.get("location")).toBe("/account?trial=1");
    expect((await call(env, "GET", "/account/trial", { cookie })).headers.get("location")).toBe("/account?trial=1");
    expect(sql.rows("SELECT trial_started_at FROM accounts")).toEqual([{ trial_started_at: null }]);
    const page = await text(call(env, "GET", "/account?trial=1", { cookie }));
    expect(page).toContain('"trial":true');
    expect(page).toContain("if (cfg.trial) trial.focus();");
    expect((await trial(env, cookie)).status).toBe(200);
    expect(await text(call(env, "GET", "/account?started=1", { cookie }))).toContain("Your Pro trial has started.");
  });

  it("public pages never say how long a trial lasts", async () => {
    const { env } = setup();
    const pages = [await text(call(env, "GET", "/start", {})), await text(call(env, "GET", "/signup", {})), await text(call(env, "GET", "/login", {}))];
    const { cookie } = await signedIn(env);
    pages.push(await text(call(env, "GET", "/account", { cookie })), await text(call(env, "GET", "/account/billing", { cookie })));
    for (const p of pages) {
      expect(p).not.toMatch(LENGTH);
      expect(p).not.toMatch(/days? left/i);
    }
    expect(pages[0]).toContain("Dashboards come with Pro. Trials available.");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { accessOf, longRetention } from "../src/plans.js";
import { call, GENCLASS_PORTAL, now, resetClock, setPlan, setup, signedIn, WEBHOOK_SECRET } from "./account-helpers.js";

// The locked dashboard (src/locked.ts, src/plans.ts accountAccess, GenClass's grant): what an app gets when its plan
// leaves the dashboard out. No plan in billing/plans.json does today, so this runs on the plans as they were before
// 2026-10-19 (test/fixtures/plans-two-paid.json: Free without a dashboard, Pro, Custom, and Pro as the grant's plan).
// A locked private link leads to sign-in, adding the app to an account, and the plans; nothing offers a trial
// (GenClass has none). The real plans, where every link opens its dashboard, are test/plans.test.ts's.
vi.mock("../../billing/plans.json", async () => ({ default: (await import("./fixtures/plans-two-paid.json")).default }));

// a live-mode key: paid plans on sale to everyone (fetch is always the fake Stripe)
const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL };

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
});

const text = async (r: Promise<Response> | Response) => (await r).text();

describe("plans: the paid plan or GenClass's grant, whichever plans.json lists later", () => {
  it("accessOf: Free without either; a test-mode plan does not count under a live key", () => {
    const at = new Date("2026-10-19T12:00:00Z");
    const later = "2026-10-20T00:00:00.000Z";
    const earlier = "2026-10-10T00:00:00.000Z";
    const row = (o: Record<string, unknown> = {}) => ({ plan: "free", stripe_mode: null, comp_until: null, ...o });
    expect(accessOf(null, null, at)).toMatchObject({ source: null, plan: { id: "free" } });
    expect(accessOf(row(), null, at)).toMatchObject({ source: null, plan: { id: "free" } });
    // the fixture's grant gives Pro
    expect(accessOf(row({ comp_until: later }), null, at)).toMatchObject({ source: "comp", plan: { id: "pro" } });
    expect(accessOf(row({ comp_until: earlier }), null, at)).toMatchObject({ source: null, plan: { id: "free" } });
    // Custom is listed after Pro, so it applies over the grant; Pro paid and granted counts as paid
    expect(accessOf(row({ plan: "custom", comp_until: later }), "live", at)).toMatchObject({ source: "paid", plan: { id: "custom" } });
    expect(accessOf(row({ plan: "pro", comp_until: later }), "live", at)).toMatchObject({ source: "paid", plan: { id: "pro" } });
    expect(accessOf(row({ plan: "pro", stripe_mode: "test" }), "live", at)).toMatchObject({ source: null, plan: { id: "free" } });
    expect(accessOf(row({ plan: "pro", stripe_mode: "test", comp_until: later }), "live", at)).toMatchObject({ source: "comp" });
    // the columns of the trial GenClass no longer has change nothing
    expect(accessOf({ ...row(), trial_started_at: earlier, trial_ends_at: later } as never, null, at)).toMatchObject({ source: null, plan: { id: "free" } });
  });

  it("retention: the apps of a grant keep the grant plan's history; the Stripe mode stays the last parameter", () => {
    const l = longRetention(now(), "live")!;
    expect(l.tokens).toContain("a.comp_until > ? OR ((a.plan IN (");
    expect(l.tokens).not.toContain("trial_ends_at");
    expect(l.params[0]).toBe(now().toISOString());
    expect(l.params[l.params.length - 1]).toBe("live");
    expect(l.days).toBe(365);
  });
});

describe("a locked private link: sign in, add the app to the account, see the plans", () => {
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
    expect(html).toContain("<h1>This app's plan has no dashboard.</h1>");
    expect(html).toContain('<p class="lead">See the plans to open it.</p>');
    expect(html).toContain('<div class="eb">shop-web</div>');
    // no OAuth on this server: sign in or sign up (an email and a password), then back here through /account?claim=1
    expect(html).toContain('href="/login?next=%2Faccount%3Fclaim%3D1"');
    expect(html).toContain('href="/signup?next=%2Faccount%3Fclaim%3D1"');
    expect(html).toContain('sessionStorage.setItem("gc.claim", secret)');
    expect(html).not.toContain(secret);
    expect(html).not.toMatch(/trial/i);
    // with Google: Continue with Google first, then Sign in (every other way in is on that page)
    const g = setup({ GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "s" });
    const gj = (await (await call(g.env, "POST", "/api/projects", { body: {}, origin: null })).json()) as any;
    const gh = await text(call(g.env, "GET", new URL(gj.dashboardUrl).pathname, { origin: null }));
    expect(gh).toContain('href="/auth/google?next=%2Faccount%3Fclaim%3D1"');
    expect(gh.indexOf("Continue with Google")).toBeLessThan(gh.indexOf('href="/login?next=%2Faccount%3Fclaim%3D1"'));
  });

  it("signed in: the page adds the app to the account and opens its page; the link opens the dashboard once the account's plan has it", async () => {
    const { env, sql } = setup(LIVE);
    const anon = (await (await call(env, "POST", "/api/projects", { body: { name: "Old shop" }, origin: null })).json()) as any;
    const path = new URL(anon.dashboardUrl).pathname;
    const secret = path.split("/").pop()!;
    const { cookie, account } = await signedIn(env);
    // back from signing in: /account?claim=1 returns to the link this tab kept
    const back = await text(call(env, "GET", "/account?claim=1", { cookie }));
    expect(back).toContain('"claim":true');
    expect(back).toContain('location.replace("/dashboard/" + s)');
    const html = await text(call(env, "GET", path, { cookie }));
    expect(html).toContain('<button class="btn prov green" id="claim" type="button"><span>Add to my account</span></button>');
    expect(html).toContain('<p class="opt"><a href="/account/billing">See plans</a></p>');
    expect(html).toContain('gcPost("/api/account/projects/claim", { secret: secret })');
    expect(html).toContain('location.href = "/account/apps/" + encodeURIComponent(j.project.id);');
    expect(html).not.toContain("/api/billing/trial");
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { secret }, cookie })).status).toBe(200);
    const mine = await text(call(env, "GET", path, { cookie }));
    expect(mine).toContain('<a class="btn green" href="/account/billing">See plans</a>');
    // the app's own page: the key and the Connect panel, the plans, no stats
    const id = String(sql.rows("SELECT id FROM projects WHERE token = ?", anon.token)[0]!.id);
    const app = await text(call(env, "GET", `/account/apps/${id}`, { cookie }));
    expect(app).toContain('<h2 id="lock-h">This app\'s plan has no dashboard.</h2>');
    expect(app).toContain('<div class="acts"><a class="btn green" href="/account/billing">See plans</a></div>');
    expect(app).not.toMatch(/trial/i);
    const locked = await call(env, "GET", `/api/account/projects/${id}/stats`, { cookie });
    expect(locked.status).toBe(402);
    expect(await locked.json()).toEqual({ ok: false, error: "this app's plan has no dashboard; see the plans at https://genclass.dev/account/billing", locked: true, upgrade_url: "https://genclass.dev/account/billing" });
    const acct = await text(call(env, "GET", "/account", { cookie }));
    expect(acct).toContain("<h2>Your plan has no dashboard</h2>");
    // a plan with the dashboard on the account: the link opens it for whoever holds it
    setPlan(sql, account.id, "pro", { subscription_id: "sub_pro0000001", subscription_status: "active", stripe_mode: "live" });
    resetOwnerCache();
    expect(await text(call(env, "GET", path, { origin: null }))).not.toContain("has no dashboard");
    expect((await call(env, "GET", `/api/projects/${secret}`, { origin: null })).status).toBe(200);
    expect((await call(env, "GET", `/api/account/projects/${id}/stats`, { cookie })).status).toBe(200);
    expect(await text(call(env, "GET", "/account", { cookie }))).not.toContain("Your plan has no dashboard");
    expect(sql.rows("SELECT account_id FROM projects WHERE token = ?", anon.token)).toEqual([{ account_id: account.id }]);
  });

  it("another account's app says so; a signed-out visitor is asked to sign in first", async () => {
    const { env } = setup(LIVE);
    const anon = (await (await call(env, "POST", "/api/projects", { body: { name: "Old shop" }, origin: null })).json()) as any;
    const path = new URL(anon.dashboardUrl).pathname;
    const ada = await signedIn(env, "ada@example.com");
    const bob = await signedIn(env, "bob@example.com");
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, cookie: ada.cookie })).status).toBe(200);
    expect(await text(call(env, "GET", path, { cookie: bob.cookie }))).toContain("This app is in another GenClass account.");
    expect(await text(call(env, "GET", path, {}))).toContain("Then add this app to your account.");
  });

  it("GenClass's grant opens the dashboard, as a plan does", async () => {
    const { env, sql } = setup();
    const { cookie, account } = await signedIn(env);
    const r = await call(env, "POST", "/api/account/projects", { body: { name: "a" }, cookie });
    const id = ((await r.json()) as any).project.id as string;
    expect((await call(env, "GET", `/api/account/projects/${id}/stats`, { cookie })).status).toBe(402);
    setPlan(sql, account.id, "free", { comp_until: "9999-12-31T00:00:00.000Z" });
    expect((await call(env, "GET", `/api/account/projects/${id}/stats`, { cookie })).status).toBe(200);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { RETENTION_DAYS, resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { FREE, keepDays, longRetention, PLANS, viewRanges } from "../src/plans.js";
import { resetStripeCache } from "../src/stripe.js";
import { call, createApp, detection, now, resetClock, sendBatch, setPlan, setup, signedIn, WEBHOOK_SECRET, GENCLASS_PORTAL } from "./account-helpers.js";

// Analytics are free: every app's dashboard, interaction analytics included, opens without a plan, a grant, a trial
// or a card, in an account or through its private link, for as many apps as the abuse cap allows, over the 90 days
// every app's data is kept anyway. Pro stays for what costs more to run: a year of history, export and forwarding.
// Nothing the worker serves says a dashboard needs Pro, and no dashboard request answers 402.

const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL };
const DAY = 86_400_000;
const text = async (r: Promise<Response> | Response) => (await r).text();
/** Any wording of the old paywall. */
const PAYWALL = /come with Pro|needs? Pro|dashboard with Pro|trial for analytics|without the dashboard|has no dashboard|\(no dashboard\)|Pick a plan to open it|dashboards? (is |are |stays? )locked/i;

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
});

describe("analytics are free: billing/plans.json", () => {
  it("every plan includes the dashboard and interaction analytics", () => {
    for (const p of PLANS) {
      expect(p.entitlements.dashboard, p.id).toBe(true);
      expect(p.entitlements.analytics, p.id).toBe(true);
    }
  });

  it("Free has no app limit and shows the 90 days every app's data is kept, so it costs no extra retention", () => {
    expect(FREE.limits).toEqual({ apps: null, history_days: RETENTION_DAYS });
    expect(viewRanges(FREE)).toEqual(["24h", "7d", "30d", "90d"]);
    expect(keepDays(FREE)).toBe(RETENTION_DAYS);
    expect(longRetention(now())!.params).not.toContain("free");
  });

  it("Free's features say the dashboard and analytics are in it; no paid plan lists them as its own", () => {
    const free = FREE.features.map((f) => f.text).join("\n");
    expect(free).toMatch(/dashboard/i);
    expect(free).toMatch(/interaction analytics/i);
    expect(FREE.summary).not.toMatch(PAYWALL);
    for (const p of PLANS.filter((x) => x.id !== "free")) {
      for (const f of p.features) expect(f.text, p.id).not.toMatch(/^The dashboard|interaction analytics/i);
    }
  });
});

describe("analytics are free: a Free account's apps", () => {
  it("a new account (no plan, grant, trial or card) opens its app's dashboard and stats, interaction analytics included", async () => {
    const { env } = setup(LIVE);
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie, "Shop");
    await sendBatch(env, app.token, detection());
    const st = await call(env, "GET", `/api/account/projects/${app.id}/stats?range=7d`, { cookie });
    expect(st.status).toBe(200);
    expect(((await st.json()) as any).range).toBe("7d");
    const html = await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }));
    expect(html).toContain(`/api/account/projects/${app.id}/stats`);
    expect(html).toContain("How visitors use this app");
    expect(html).not.toContain('id="lock"');
    expect(html).not.toMatch(PAYWALL);
  });

  it("the range buttons reach 90 days; a longer ask gets 90 days", async () => {
    const { env } = setup(LIVE);
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie);
    const html = await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }));
    expect(html).toContain('data-r="90d"');
    expect(html).not.toContain('data-r="1y"');
    for (const [asked, got] of [["30d", "30d"], ["90d", "90d"], ["1y", "90d"]]) {
      const r = await call(env, "GET", `/api/account/projects/${app.id}/stats?range=${asked}`, { cookie });
      expect(r.status, asked).toBe(200);
      expect(((await r.json()) as any).range, asked).toBe(got);
    }
  });

  it("no app limit: a Free account holds more than 3 apps", async () => {
    const { env } = setup(LIVE);
    const { cookie } = await signedIn(env);
    for (const n of ["a", "b", "c", "d", "e"]) await createApp(env, cookie, n);
  });

  it("the dashboard stays open after a trial ends, after a paid plan lapses, and with no Stripe key at all", async () => {
    for (const over of [LIVE, {}]) {
      const { env, sql } = setup(over);
      const ended = await signedIn(env, "ended@example.com");
      setPlan(sql, ended.account.id, "free", { trial_started_at: new Date(now().getTime() - 30 * DAY).toISOString(), trial_ends_at: new Date(now().getTime() - 23 * DAY).toISOString() });
      const lapsed = await signedIn(env, "lapsed@example.com");
      setPlan(sql, lapsed.account.id, "free", { subscription_id: "sub_l000000001", subscription_status: "canceled", stripe_mode: "live" });
      for (const a of [ended, lapsed]) {
        const app = await createApp(env, a.cookie);
        expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie: a.cookie })).status).toBe(200);
        expect(await text(call(env, "GET", `/account/apps/${app.id}`, { cookie: a.cookie }))).not.toMatch(PAYWALL);
      }
    }
  });
});

describe("analytics are free: private links", () => {
  it("a link from /start or init (no account) opens the dashboard and its stats", async () => {
    const { env } = setup(LIVE);
    const j = (await (await call(env, "POST", "/api/projects", { body: { name: "shop-web" }, origin: null })).json()) as any;
    const path = new URL(j.dashboardUrl).pathname;
    const secret = path.split("/").pop()!;
    await sendBatch(env, j.token, detection());
    const page = await call(env, "GET", path, { origin: null });
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain('id="content"');
    expect(html).toContain("How visitors use this app");
    expect(html).not.toMatch(PAYWALL);
    const st = await call(env, "GET", `/api/projects/${secret}?range=7d`, { origin: null });
    expect(st.status).toBe(200);
    expect(((await st.json()) as any).range).toBe("7d");
  });

  it("a link to an app in a Free account opens too", async () => {
    const { env } = setup(LIVE);
    const j = (await (await call(env, "POST", "/api/projects", { body: { name: "Old shop" }, origin: null })).json()) as any;
    const { cookie } = await signedIn(env);
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: j.dashboardUrl }, cookie })).status).toBe(200);
    resetOwnerCache();
    const path = new URL(j.dashboardUrl).pathname;
    expect(await text(call(env, "GET", path, { origin: null }))).not.toMatch(PAYWALL);
    expect((await call(env, "GET", `/api/projects/${path.split("/").pop()}`, { origin: null })).status).toBe(200);
  });
});

describe("analytics are free: what the worker says", () => {
  it("no page says a dashboard needs Pro; the billing page says Free has the dashboard and analytics", async () => {
    const { env } = setup(LIVE);
    const pages = [await text(call(env, "GET", "/start", {})), await text(call(env, "GET", "/signup", {})), await text(call(env, "GET", "/login", {}))];
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie);
    const billing = await text(call(env, "GET", "/account/billing", { cookie }));
    pages.push(await text(call(env, "GET", "/account", { cookie })), billing, await text(call(env, "GET", `/account/apps/${app.id}`, { cookie })));
    for (const p of pages) expect(p).not.toMatch(PAYWALL);
    expect(billing).toMatch(/You are on the <b>Free<\/b> plan: the dashboard and interaction analytics for every app/);
  });

  it("Pro is still on offer, as an upgrade: the pricing page's Start a trial leads to the billing page with the trial focused", async () => {
    const { env } = setup(LIVE);
    expect((await call(env, "GET", "/account/trial", {})).headers.get("location")).toBe("/signup?next=%2Faccount%2Fbilling%3Ftrial%3D1");
    const { cookie } = await signedIn(env);
    expect((await call(env, "GET", "/account/trial", { cookie })).headers.get("location")).toBe("/account/billing?trial=1");
    const page = await text(call(env, "GET", "/account/billing?trial=1", { cookie }));
    expect(page).toContain('<button class="btn green" type="button" id="trial"><span>Start your 7-day free trial</span></button>');
    expect(page).toContain('"focusTrial":true');
    expect(await text(call(env, "GET", "/account/billing?done=1&trial=1", { cookie }))).not.toContain('"focusTrial":true');
  });

  it("no dashboard answer is a 402, and no locked page is left in src/", () => {
    const src = new URL("../src/", import.meta.url);
    for (const f of readdirSync(src).filter((x) => x.endsWith(".ts"))) {
      const code = readFileSync(new URL(f, src), "utf8");
      expect(code, f).not.toMatch(/json\(402/);
      expect(code, f).not.toMatch(/lockedLink|lockedDashboardPage|lockedJson|hasDashboard/);
      expect(code, f).not.toMatch(PAYWALL);
    }
  });
});

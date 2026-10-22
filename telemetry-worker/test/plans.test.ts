import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import PLANS_JSON from "../../billing/plans.json";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { accessOf, byAgreement, FREE, GRANT_PLAN, PAID_PLANS, PLANS, planByLookupKey, priceText, viewRanges } from "../src/plans.js";
import { resetStripeCache } from "../src/stripe.js";
import {
  call,
  createApp,
  fakeStripe,
  GENCLASS_PORTAL,
  resetClock,
  setPlan,
  setup,
  signedIn,
  WEBHOOK_SECRET,
} from "./account-helpers.js";

// The real plans (billing/plans.json, version 2, 2026-10-22), with no fixture: two plans, Free and Enterprise. Free has
// the dashboard, analytics, export and forwarding with 90 days of history, and your own classifier, which a person from
// GenClass trains on request; Enterprise is agreed by email and given by GenClass's own grant. Nothing is sold on the
// site and there is no trial. Selling one paid plan (Individual, until 2026-10-22) is tested on
// test/fixtures/plans-individual.json (one-paid tests); the machinery that two paid plans or a locked dashboard reach
// on test/fixtures/plans-two-paid.json (billing, locked, dashboard, auth, export and forward tests).

// a live-mode key: what is sold would be on sale to everyone (fetch is always the fake Stripe)
const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL };

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
});

const text = async (r: Promise<Response> | Response) => (await r).text();
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!doctype html>/gi, "");

describe("billing/plans.json: the one source of plans", () => {
  it("has Free and Enterprise with the owner's prices, limits and entitlements; Free has your own classifier (2026-10-22)", () => {
    expect(PLANS.map((p) => p.id)).toEqual(["free", "enterprise"]);
    const [free, enterprise] = PLANS;
    expect(free!.price_usd_cents).toEqual({ monthly: 0, yearly: null });
    expect(enterprise!.price_usd_cents).toEqual({ monthly: null, yearly: null });
    for (const p of PLANS) expect(p.stripe_lookup_keys, p.id).toEqual({ monthly: null, yearly: null });
    // the dashboard, analytics, export, forwarding and a classifier are free, with 90 days of history and no app limit
    expect(free!.limits).toEqual({ apps: null, history_days: 90 });
    expect(free!.entitlements).toEqual({ dashboard: true, forwarding: true, export: true, analytics: true, custom_model: true });
    expect(free!.features).toContainEqual({
      text: "Your own classifier: we train a GenClass model on your app's traffic, bug reports or labelled examples and ship it as a private model your runtime loads",
      available: true,
    });
    expect(enterprise!.limits).toEqual({ apps: null, history_days: 365 });
    expect(enterprise!.entitlements).toEqual({ dashboard: true, forwarding: true, export: true, analytics: true, custom_model: true });
    expect(enterprise!.features[0]).toEqual({ text: "Everything in Free", available: true });
    expect(PLANS.map((p) => p.managed_payments)).toEqual([false, false]);
    expect(PLANS.map((p) => p.stripe_tax_code)).toEqual([null, null]);
    // nothing is sold on the site; Enterprise is agreed by email and is what GenClass's grant gives
    expect(PAID_PLANS).toEqual([]);
    expect(PLANS.filter(byAgreement).map((p) => p.id)).toEqual(["enterprise"]);
    expect(GRANT_PLAN.id).toBe("enterprise");
    expect(FREE.id).toBe("free");
    expect(priceText(free!)).toBe("$0");
    expect(priceText(enterprise!)).toBe("By agreement");
    // Individual (until 2026-10-22) and the plans before it name no plan any more
    for (const k of ["genclass_individual_monthly", "genclass_pro_monthly"]) expect(planByLookupKey(k), k).toBeNull();
    expect(viewRanges(free!)).toEqual(["24h", "7d", "30d", "90d"]);
    expect(viewRanges(enterprise!)).toEqual(["24h", "7d", "30d", "90d", "1y"]);
    // interaction analytics is listed as coming next on Free, not as available
    expect(free!.features.find((f) => /Interaction analytics/.test(f.text))).toEqual({ text: "Interaction analytics: clicks, scrolls and time on page (coming next)", available: false });
    expect((PLANS_JSON as any).footer).toBe("Questions about your classifier, Enterprise, self-hosting or invoices? Email mehar@daybot.ca.");
    expect((PLANS_JSON as any).grant_plan).toBe("enterprise");
    expect(PLANS_JSON).not.toHaveProperty("trial_days");
  });

  it("feature text follows the voice rules: no em-dashes, no exclamation marks, nothing about seats, teams or a trial", () => {
    const text = JSON.stringify(PLANS_JSON);
    expect(text).not.toMatch(/—|!/);
    expect(text).not.toMatch(/\bseats?\b|\bteams?\b/i);
    expect(JSON.stringify((PLANS_JSON as any).plans)).not.toMatch(/\btrial\b/i);
  });

  it("accessOf: a paid plan or GenClass's grant, whichever plans.json lists later; Free otherwise", () => {
    const at = new Date("2026-10-19T12:00:00Z");
    const later = "2026-12-31T00:00:00.000Z";
    const row = (o: Record<string, unknown> = {}) => ({ plan: "free", stripe_mode: null, comp_until: null, ...o });
    expect(accessOf(null, null, at)).toEqual({ plan: FREE, source: null });
    expect(accessOf(row(), "live", at)).toEqual({ plan: FREE, source: null });
    expect(accessOf(row({ comp_until: later }), "live", at)).toMatchObject({ source: "comp", plan: { id: "enterprise" } });
    expect(accessOf(row({ comp_until: "2026-10-01T00:00:00.000Z" }), "live", at)).toEqual({ plan: FREE, source: null });
    // the plans that ended (Pro and Custom on 2026-10-19, Individual on 2026-10-22) count as Free
    expect(accessOf(row({ plan: "individual", stripe_mode: "live" }), "live", at)).toEqual({ plan: FREE, source: null });
    expect(accessOf(row({ plan: "individual", comp_until: later }), "live", at)).toMatchObject({ source: "comp", plan: { id: "enterprise" } });
    expect(accessOf(row({ plan: "pro" }), "live", at)).toEqual({ plan: FREE, source: null });
    expect(accessOf(row({ plan: "custom", stripe_mode: "live" }), "live", at)).toEqual({ plan: FREE, source: null });
  });
});

describe("the dashboard is free: every app opens it, with an account or without", () => {
  it("a private link from /start (and the 0.3.0-beta.0 CLI's init) opens the dashboard and its stats", async () => {
    const { env } = setup();
    const j = (await (await call(env, "POST", "/api/projects", { body: { name: "shop-web" }, origin: null })).json()) as any;
    const path = new URL(j.dashboardUrl).pathname;
    const page = await call(env, "GET", path, { origin: null });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain("has no dashboard");
    expect(html).toContain("shop-web");
    expect((await call(env, "GET", `/api/projects/${path.split("/").pop()}?range=30d`, { origin: null })).status).toBe(200);
  });

  it("a new account on Free: its apps' dashboards, stats, ranges to 90 days, more than 3 apps, export and forwarding", async () => {
    const { env } = setup(LIVE);
    const { cookie } = await signedIn(env);
    const apps = [];
    for (const n of ["a", "b", "c", "d", "e"]) apps.push(await createApp(env, cookie, n));
    const page = await text(call(env, "GET", `/account/apps/${apps[0]!.id}`, { cookie }));
    expect(page).not.toContain("has no dashboard");
    expect(page).toContain('id="export"');
    expect(page).toContain('id="forwarding"');
    const st = await call(env, "GET", `/api/account/projects/${apps[0]!.id}/stats?range=1y`, { cookie });
    expect(st.status).toBe(200);
    // a longer ask than Free's 90 days gets the longest it shows
    expect(((await st.json()) as any).range).toBe("90d");
    expect((await call(env, "GET", `/api/account/projects/${apps[0]!.id}/events`, { cookie })).status).toBe(200);
    expect((await call(env, "GET", `/api/account/projects/${apps[0]!.id}/integrations`, { cookie })).status).toBe(200);
    const account = await text(call(env, "GET", "/account", { cookie }));
    expect(account).not.toContain("has no dashboard");
  });
});

describe("no trial", () => {
  it("POST /api/billing/trial is 410, GET /account/trial leads to /account through sign-up, and Stripe is never called", async () => {
    const { env } = setup(LIVE);
    const s = fakeStripe();
    expect((await call(env, "GET", "/account/trial", { fetch: s.fetch })).headers.get("location")).toBe("/signup?next=%2Faccount");
    const { cookie } = await signedIn(env);
    expect((await call(env, "GET", "/account/trial", { cookie, fetch: s.fetch })).headers.get("location")).toBe("/account");
    const r = await call(env, "POST", "/api/billing/trial", { body: {}, cookie, fetch: s.fetch });
    expect(r.status).toBe(410);
    expect(((await r.json()) as any).error).toBe("GenClass has no trial any more: the dashboard is free; see https://genclass.dev/account/billing");
    expect(s.calls).toEqual([]);
    expect(await (await call(env, "GET", "/api/billing", { cookie })).json()).toEqual({
      plan: "free",
      subscription_status: null,
      current_period_end: null,
      cancel_at_period_end: false,
      // nothing is sold on the site, whatever the key
      on_sale: false,
      access: null,
    });
  });

  it("no page the worker serves offers a trial; the public ones say the dashboard is free", async () => {
    const { env } = setup(LIVE);
    const pages: [string, string][] = [];
    for (const p of ["/start", "/signup", "/login"]) pages.push([p, await text(call(env, "GET", p, {}))]);
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie, "a");
    for (const p of ["/account", "/account/billing", `/account/apps/${app.id}`]) pages.push([p, await text(call(env, "GET", p, { cookie }))]);
    for (const [p, html] of pages) {
      expect(visible(html), p).not.toMatch(/trial/i);
      expect(html, p).not.toContain("/api/billing/trial");
      expect(html, p).not.toMatch(/\bPro\b/);
    }
    expect(pages[0]![1]).toContain("The dashboard is free.");
    expect(pages[1]![1]).toContain('<p class="opt">The runtime needs no account. The dashboard is free for every app.</p>');
    expect(pages[2]![1]).toContain('<p class="opt">The runtime needs no account. The dashboard is free for every app.</p>');
  });

  it("nothing in src/ asks Stripe for a trial or writes the trial's columns", () => {
    const dir = new URL("../src/", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const code = readFileSync(new URL(f, dir), "utf8");
      expect(code, f).not.toMatch(/trial_period_days|trial_settings|payment_intents|trial_started_at\s*=|trial_ends_at\s*=|trial_check_failures\s*=/);
      expect(code, f).not.toMatch(/INSERT INTO accounts[^;`]*\b(trial_ends_at|trial_started_at|comp_until)\b/);
    }
    // TRIAL_DAYS is gone from the worker's configuration
    expect(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8")).not.toMatch(/TRIAL_DAYS/);
  });

  it("the CLI says the dashboard is free, and never offers a trial", () => {
    for (const f of ["../../packages/runtime/bin/genclass-runtime.mjs", "../../packages/runtime/bin/lib/init.mjs"]) {
      const cli = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(cli, f).not.toMatch(/trial|needs Pro|\/account\/trial/i);
      expect(cli, f).toMatch(/dashboard is free/);
    }
  });
});

describe("nothing sold on the site: Free with your own classifier, Enterprise by email", () => {
  it("checkout sells nothing, whatever the key and the plan asked for, and never calls Stripe", async () => {
    const { env } = setup(LIVE);
    const { cookie } = await signedIn(env);
    const s = fakeStripe();
    for (const plan of ["individual", "enterprise", "free", "pro", "custom"]) {
      const r = await call(env, "POST", "/api/billing/checkout", { body: { plan }, cookie, fetch: s.fetch });
      expect(r.status, plan).toBe(400);
      expect(((await r.json()) as any).error).toBe("no plan is sold on genclass.dev: Free has everything, and Enterprise is agreed by email with mehar@daybot.ca");
    }
    expect(s.calls).toEqual([]);
  });

  it("the billing page: two plans, Free with your own classifier, Talk to us for Enterprise, no Upgrade, no Stripe", async () => {
    for (const keys of [{}, LIVE]) {
      const t = setup(keys);
      const a = await signedIn(t.env);
      const page = await text(call(t.env, "GET", "/account/billing", { cookie: a.cookie }));
      expect(page).toContain("You are on the <b>Free</b> plan: the runtime, its on-device model and the dashboard, with 90 days of history (you have 0 apps).</p>");
      expect(page).toContain("grid-template-columns:repeat(2,minmax(0,1fr))");
      expect(page).toContain("<li>Your own classifier: we train a GenClass model on your app&#39;s traffic, bug reports or labelled examples and ship it as a private model your runtime loads</li>");
      expect(page).not.toContain("data-plan=");
      expect(page).not.toMatch(/Individual|\$29|Upgrade to|billed monthly|Paid plans are not on sale|Payments are handled by Stripe/);
      expect(page).toContain('<a class="btn ghost" href="mailto:mehar@daybot.ca?subject=GenClass%20Enterprise"><span>Talk to us</span></a>');
      expect(page).toContain('<p class="price">By agreement</p>');
      expect(page).toContain('Questions about your classifier, Enterprise, self-hosting or invoices? Email <a href="mailto:mehar@daybot.ca">mehar@daybot.ca</a>.');
      expect(visible(page)).not.toMatch(/—|!/);
    }
  });

  it("an account still stored on Individual reads as Free; GenClass's grant gives Enterprise", async () => {
    const t = setup(LIVE);
    const b = await signedIn(t.env);
    setPlan(t.sql, b.account.id, "individual", { stripe_customer_id: "cus_b000000001", subscription_id: "sub_b000000001", subscription_status: "active", current_period_end: "2026-11-19T12:00:00.000Z" });
    expect(((await (await call(t.env, "GET", "/api/billing", { cookie: b.cookie })).json()) as any).plan).toBe("free");
    setPlan(t.sql, b.account.id, "free", { stripe_customer_id: null, subscription_id: null, subscription_status: null, current_period_end: null, comp_until: "9999-12-31T00:00:00.000Z" });
    const granted = await text(call(t.env, "GET", "/account/billing", { cookie: b.cookie }));
    expect(granted).toContain("You have <b>Enterprise</b>, set up by GenClass.");
    expect(granted).toContain('<span class="tag">Set up by GenClass</span>');
  });
});

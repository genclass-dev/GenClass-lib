import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PLANS_JSON from "../../billing/plans.json";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { accessOf, byAgreement, FREE, GRANT_PLAN, PAID_PLANS, PLANS, planByLookupKey, priceText, viewRanges } from "../src/plans.js";
import { resetStripeCache } from "../src/stripe.js";
import {
  call,
  createApp,
  deliver,
  fakeStripe,
  GENCLASS_PORTAL,
  invoice,
  now,
  resetClock,
  setPlan,
  setup,
  signedIn,
  stripeEvent,
  subscription,
  WEBHOOK_SECRET,
} from "./account-helpers.js";

// The real plans (billing/plans.json, version 2, 2026-10-19), with no fixture: the dashboard, analytics, export and
// forwarding are free for every app; Individual (US$29 a month, on Stripe Checkout) adds a classifier a person from
// GenClass trains; Enterprise is agreed by email and given by GenClass's own grant; there is no trial. The billing
// machinery that two paid plans or a locked dashboard reach is tested on test/fixtures/plans-two-paid.json (billing,
// locked, dashboard, auth, export and forward tests).

// a live-mode key: Individual on sale to everyone (fetch is always the fake Stripe)
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
  it("has Free, Individual and Enterprise with the owner's prices, lookup keys, limits and entitlements (2026-10-19)", () => {
    expect(PLANS.map((p) => p.id)).toEqual(["free", "individual", "enterprise"]);
    const [free, individual, enterprise] = PLANS;
    expect(free!.price_usd_cents).toEqual({ monthly: 0, yearly: null });
    expect(individual!.price_usd_cents).toEqual({ monthly: 2900, yearly: null });
    expect(enterprise!.price_usd_cents).toEqual({ monthly: null, yearly: null });
    expect(individual!.stripe_lookup_keys).toEqual({ monthly: "genclass_individual_monthly", yearly: null });
    expect(enterprise!.stripe_lookup_keys).toEqual({ monthly: null, yearly: null });
    // the dashboard, analytics, export and forwarding are free, with 90 days of history and no app limit
    expect(free!.limits).toEqual({ apps: null, history_days: 90 });
    expect(free!.entitlements).toEqual({ dashboard: true, forwarding: true, export: true, analytics: true, custom_model: false });
    expect(individual!.limits).toEqual({ apps: null, history_days: 365 });
    expect(individual!.entitlements).toEqual({ dashboard: true, forwarding: true, export: true, analytics: true, custom_model: true });
    expect(enterprise!.entitlements).toEqual({ dashboard: true, forwarding: true, export: true, analytics: true, custom_model: true });
    // a person trains Individual's classifier, so it is not a Managed Payments product; nothing is
    expect(PLANS.map((p) => p.managed_payments)).toEqual([false, false, false]);
    expect(individual!.stripe_tax_code).toBe("txcd_10203001");
    // only Individual is sold on the site; Enterprise is agreed by email and is what GenClass's grant gives
    expect(PAID_PLANS.map((p) => p.id)).toEqual(["individual"]);
    expect(PLANS.filter(byAgreement).map((p) => p.id)).toEqual(["enterprise"]);
    expect(GRANT_PLAN.id).toBe("enterprise");
    expect(FREE.id).toBe("free");
    expect(priceText(free!)).toBe("$0");
    expect(priceText(individual!)).toBe("$29 / month");
    expect(priceText(enterprise!)).toBe("Talk to us");
    expect(planByLookupKey("genclass_individual_monthly")?.id).toBe("individual");
    expect(planByLookupKey("genclass_pro_monthly")).toBeNull();
    expect(viewRanges(free!)).toEqual(["24h", "7d", "30d", "90d"]);
    expect(viewRanges(individual!)).toEqual(["24h", "7d", "30d", "90d", "1y"]);
    // interaction analytics is listed as coming next on Free, not as available
    expect(free!.features.find((f) => /Interaction analytics/.test(f.text))).toEqual({ text: "Interaction analytics: clicks, scrolls and time on page (coming next)", available: false });
    expect((PLANS_JSON as any).footer).toBe("Questions about Enterprise, self-hosting or invoices? Email mehar@daybot.ca.");
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
    expect(accessOf(row({ plan: "individual" }), "live", at)).toMatchObject({ source: "paid", plan: { id: "individual" } });
    // the grant (Enterprise) is listed after Individual, so it applies over a paid Individual while it runs
    expect(accessOf(row({ plan: "individual", comp_until: later }), "live", at)).toMatchObject({ source: "comp", plan: { id: "enterprise" } });
    expect(accessOf(row({ comp_until: "2026-10-01T00:00:00.000Z" }), "live", at)).toEqual({ plan: FREE, source: null });
    // the plans from before 2026-10-19 count as Free
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
      on_sale: true,
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

describe("Individual on Stripe Checkout, Enterprise by email", () => {
  it("checkout sells Individual by its lookup key on standard Checkout; Enterprise and the old plans have no Checkout", async () => {
    const { env } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    const s = fakeStripe();
    const r = await call(env, "POST", "/api/billing/checkout", { body: { plan: "individual" }, cookie, fetch: s.fetch });
    expect(r.status).toBe(200);
    const prices = s.calls.find((c) => c.method === "GET" && c.url.pathname === "/v1/prices")!;
    expect(prices.url.searchParams.get("lookup_keys[0]")).toBe("genclass_individual_monthly");
    const session = s.calls.find((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions")!;
    expect(Object.fromEntries(session.form!)).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_indiv00001",
      "metadata[genclass_plan]": "individual",
      "metadata[genclass_account]": account.id,
      payment_method_collection: "always",
      "subscription_data[billing_mode][type]": "flexible",
    });
    for (const k of session.form!.keys()) expect(k).not.toMatch(/trial|managed_payments/);
    for (const plan of ["enterprise", "free", "pro", "custom"]) {
      const no = await call(env, "POST", "/api/billing/checkout", { body: { plan }, cookie, fetch: s.fetch });
      expect(no.status, plan).toBe(400);
      expect(((await no.json()) as any).error).toBe("choose a plan: individual");
    }
  });

  it("the billing page: Free with the dashboard, Upgrade to Individual, Talk to us for Enterprise, no switch", async () => {
    const off = setup();
    const a = await signedIn(off.env);
    const closed = await text(call(off.env, "GET", "/account/billing", { cookie: a.cookie }));
    // not on sale (no key): no Upgrade button, but Enterprise's Talk to us is a mailto link whatever the key
    expect(closed).not.toContain("data-plan=");
    expect(closed).toContain('<a class="btn ghost" href="mailto:mehar@daybot.ca?subject=GenClass%20Enterprise"><span>Talk to us</span></a>');

    const on = setup(LIVE);
    const b = await signedIn(on.env);
    const page = await text(call(on.env, "GET", "/account/billing", { cookie: b.cookie }));
    expect(page).toContain("the runtime, its on-device model and the dashboard, with 90 days of history (you have 0 apps).");
    expect(page).toContain('<button class="btn" type="button" data-plan="individual"><span>Upgrade to Individual</span></button>');
    expect(page).not.toContain('data-plan="enterprise"');
    expect(page).toContain("$29 / month");
    expect(page).toContain('<p class="price">Talk to us</p>');
    expect(page).toContain('Questions about Enterprise, self-hosting or invoices? Email <a href="mailto:mehar@daybot.ca">mehar@daybot.ca</a>.');
    expect(page).not.toMatch(/Switching between|To switch between/);
    expect(visible(page)).not.toMatch(/—|!/);

    // paying for Individual: a person emails the buyer; still no switch with one paid plan
    setPlan(on.sql, b.account.id, "individual", { stripe_customer_id: "cus_b000000001", subscription_id: "sub_b000000001", subscription_status: "active", current_period_end: "2026-11-19T12:00:00.000Z" });
    const paid = await text(call(on.env, "GET", "/account/billing", { cookie: b.cookie }));
    expect(paid).toContain("You are on the <b>Individual</b> plan, $29 / month.");
    expect(paid).toContain("emails ada@example.com within 1 business day of your purchase");
    expect(paid).not.toContain("data-plan=");
    expect(paid).not.toMatch(/To switch between/);

    // GenClass's grant gives Enterprise
    setPlan(on.sql, b.account.id, "free", { stripe_customer_id: null, subscription_id: null, subscription_status: null, current_period_end: null, comp_until: "9999-12-31T00:00:00.000Z" });
    const granted = await text(call(on.env, "GET", "/account/billing", { cookie: b.cookie }));
    expect(granted).toContain("You have <b>Enterprise</b>, set up by GenClass.");
    expect(granted).toContain('<span class="tag">Set up by GenClass</span>');
    expect(((await (await call(on.env, "GET", "/api/billing", { cookie: b.cookie })).json()) as any).access).toBe("comp");
  });

  it("a paid Individual purchase is recorded once for a person to follow up, and the owner's notice names the plan", async () => {
    const t = setup({ ...LIVE, NOTIFY_WEBHOOK: "https://hooks.example.com/notify" });
    const a = await signedIn(t.env);
    const s = fakeStripe();
    t.sql.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_ada0000001', stripe_mode = 'live' WHERE id = ?").run(a.account.id);
    s.genclassCustomer("cus_ada0000001", a.account.id);
    s.subs.set("sub_ada0000001", subscription("sub_ada0000001", a.account.id, "cus_ada0000001", "genclass_individual_monthly"));
    const sub = s.subs.get("sub_ada0000001")!;
    s.invoices.set("in_ada0000001", invoice("in_ada0000001", "cus_ada0000001", "sub_ada0000001", [["price_indiv00001", 2900]], "paid"));
    sub.latest_invoice = "in_ada0000001";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await deliver(t.env, stripeEvent("customer.subscription.created", sub), s.fetch)).status).toBe(200);
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), s.fetch)).status).toBe(200);
    log.mockRestore();
    expect(t.sql.rows("SELECT plan FROM accounts")).toEqual([{ plan: "individual" }]);
    const rows = t.sql.rows("SELECT id, account_id, subscription_id, mode FROM custom_requests");
    expect(rows).toEqual([{ id: rows[0]!.id, account_id: a.account.id, subscription_id: "sub_ada0000001", mode: "live" }]);
    expect(s.other).toHaveLength(1);
    const notice = JSON.parse(s.other[0]!.body);
    expect(notice).toMatchObject({ event: "custom_purchase", request_id: rows[0]!.id, account_id: a.account.id });
    expect(notice.text).toBe(`GenClass Individual plan bought: request ${rows[0]!.id}, account ${a.account.id}. The buyer's email is in custom_requests; write to them within 1 business day.`);
    expect(now().toISOString()).toBe(t.sql.rows("SELECT notified FROM custom_requests")[0]!.notified);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/collector.js";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { accessOf, canTrial, longRetention, planRetention, trialDays, trialDaysLeft, trialTerms } from "../src/plans.js";
import { cardOnFile, resetStripeCache } from "../src/stripe.js";
import { MIGRATION_FILES } from "./d1.js";
import {
  advance,
  call,
  cliToken,
  createApp,
  deliver,
  detection,
  fakeStripe,
  GENCLASS_PORTAL,
  now,
  ORIGIN,
  price,
  resetClock,
  sendBatch,
  setPlan,
  setup,
  signedIn,
  stripeEvent,
  subscription,
  WEBHOOK_SECRET,
  type Fetch,
} from "./account-helpers.js";

// Dashboards come with Pro (src/plans.ts accountAccess), and the trial of Pro needs a card (src/billing.ts checkout,
// src/stripe.ts checkoutSession and handleEvent, src/plans.ts canTrial): apps of an account without a plan, GenClass's
// grant or a trial are collected but their dashboards are locked; one trial per account, which starts only on Stripe
// Checkout with a payment method collected up front, is granted by the webhook only once Stripe has the trialing
// subscription and its saved payment method, and ends in the first charge, whose failure is a failed payment like any
// other. Private links from /start and the 0.3.0-beta.0 CLI's init open a locked page that leads to sign-in, adding the
// app to an account and the trial's Checkout. Public copy says how long a trial lasts ("Get a 7-day free trial for
// analytics") and that a card is required: the worker's pages from TRIAL_DAYS (wrangler.toml), the site from
// billing/plans.json trial_days; they agree.

const DAY = 86_400_000;
// a live-mode key: paid plans and the trial on sale to everyone (fetch is always the fake Stripe)
const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL };

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
});

const trial = (env: Env, cookie: string, o: { origin?: string | null; fetch?: Fetch } = {}) => call(env, "POST", "/api/billing/trial", { body: {}, cookie, ...o });
const text = async (r: Promise<Response> | Response) => (await r).text();
const error = async (r: Promise<Response> | Response) => ((await (await r).json()) as any).error as string;

/** The trial's public line and button, with its length (the owner's copy, 2026-10-15). */
const OFFER = (days = 7) => `Get a ${days}-day free trial for analytics`;
const START = (days = 7) => `Start your ${days}-day free trial`;
/** What every offer of the trial says next to it (2026-10-17: the trial needs a card). */
const TERMS = (days = 7) => `Card required. Stripe checks it with a $1 hold that is released at once. Nothing is charged for ${days} days; when they end, your card is charged $99 for the first month of Pro, then monthly, unless you cancel before.`;
/** The copy before 2026-10-15, which hid the length. */
const OLD = /trials available|start a trial/i;
/** Any sentence about the trial that says it needs no card (the copy before 2026-10-17). */
const NO_CARD = /\bno (credit )?card\b|without a card|needs no card|card (is )?not (needed|required)/i;
const noCardTrialLines = (s: string): string[] => s.split(/[.!?\n<>]/).filter((x) => /\btrial\b/i.test(x) && NO_CARD.test(x));

/** The trial's Checkout Session requests the fake Stripe received. */
const sessionPosts = (s: ReturnType<typeof fakeStripe>) => s.calls.filter((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions");

const T0S = Math.floor(now().getTime() / 1000);
/** A subscription in its 7-day trial as Stripe has it once the trial's Checkout is paid with a card. */
function trialSub(id: string, accountId: string, customer: string, over: Record<string, unknown> = {}) {
  const end = T0S + 7 * 86_400;
  return subscription(id, accountId, customer, "genclass_pro_monthly", "trialing", {
    trial_start: T0S,
    trial_end: end,
    default_payment_method: "pm_card0000001",
    items: { data: [{ id: `si_${id.slice(4)}`, current_period_end: end, price: price("genclass_pro_monthly") }] },
    ...over,
  });
}

/** A signed-in account that opened the trial's Checkout, and the trialing subscription Stripe makes when it is paid. */
async function trialing(over: Partial<Env> = {}) {
  const t = setup({ ...LIVE, ...over });
  const a = await signedIn(t.env);
  const s = fakeStripe();
  const r = await trial(t.env, a.cookie, { fetch: s.fetch });
  expect(r.status).toBe(200);
  const customer = String(t.sql.rows("SELECT stripe_customer_id FROM accounts")[0]!.stripe_customer_id);
  s.subs.set("sub_trial00001", trialSub("sub_trial00001", a.account.id, customer));
  const sub = s.subs.get("sub_trial00001")!;
  const state = () => t.sql.rows("SELECT plan, subscription_status, trial_started_at, trial_ends_at, past_due_since FROM accounts WHERE id = ?", a.account.id)[0]!;
  const send = async (type: string, previous?: Record<string, unknown>) => {
    const ev = stripeEvent(type, sub);
    const r2 = await deliver(t.env, previous ? { ...ev, data: { object: sub, previous_attributes: previous } } : ev, s.fetch);
    expect(r2.status, type).toBe(200);
    return ((await r2.json()) as any).result as string;
  };
  return { ...t, ...a, s, customer, sub, state, send };
}

describe("dashboards come with Pro: a new account's apps are collected, and their dashboards locked", () => {
  it("the app's page keeps its key and Connect panel and offers the trial with its card terms; its stats answer 402; ingest keeps counting", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie, "Shop");
    await sendBatch(env, app.token, detection());
    expect(Number(sql.rows("SELECT COUNT(*) AS n FROM daily WHERE token = ?", app.token)[0]!.n)).toBeGreaterThan(0);
    const html = await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }));
    expect(html).toContain('<h2 id="lock-h">Dashboards come with Pro.</h2>');
    expect(html).toContain(`<p>${OFFER()}. ${TERMS()}</p>`);
    expect(html).toContain(`<button class="btn green" type="button" id="trial">${START()}</button>`);
    expect(html).toContain("Connect this app");
    expect(html).toContain(app.token);
    expect(html).not.toContain(`/api/account/projects/${app.id}/stats`);
    expect(html).not.toMatch(/ style="/);
    const st = await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie });
    expect(st.status).toBe(402);
    expect(await st.json()).toEqual({ ok: false, error: "dashboards come with Pro (get a 7-day free trial for analytics)", locked: true, upgrade_url: `${ORIGIN}/account/billing` });
    const acct = await text(call(env, "GET", "/account", { cookie }));
    expect(acct).toContain('<section class="blk" id="plan">');
    expect(acct).toContain(`<h2>Dashboards come with Pro</h2><span class="aside">${OFFER()}</span>`);
    expect(acct).toContain(`<p class="intro">${TERMS()}</p>`);
    expect(acct).toContain(`<button class="btn green" type="button" id="trial"><span>${START()}</span></button>`);
    const billing = await text(call(env, "GET", "/account/billing", { cookie }));
    expect(billing).toContain(`${OFFER()}. ${TERMS()}`);
    for (const page of [html, acct, billing]) {
      expect(page).toContain(START());
      expect(page).toContain(TERMS());
      expect(page).not.toMatch(OLD);
      expect(noCardTrialLines(page)).toEqual([]);
      // every button posts to the trial's Checkout and follows Stripe's URL; none reloads into Pro
      expect(page).toContain("/api/billing/trial");
      expect(page).not.toMatch(/api\/billing\/trial", \{\}\)\.then\(function\(\)\{ location\.(reload|href = "\/account\?started)/);
    }
    expect(html).toContain("location.href = j.url;");
    expect(acct).toContain("location.href = j.url;");
    expect(billing).toContain("location.href = j.url;");
  });

  it("signing up gives no trial and no Pro: the account starts on Free, with no trial, grant or Stripe ids", async () => {
    const { env, sql } = setup(LIVE);
    const { account } = await signedIn(env);
    expect(sql.rows("SELECT plan, trial_started_at, trial_ends_at, comp_until, subscription_id, stripe_customer_id FROM accounts WHERE id = ?", account.id)).toEqual([
      { plan: "free", trial_started_at: null, trial_ends_at: null, comp_until: null, subscription_id: null, stripe_customer_id: null },
    ]);
    // and no column defaults to one: the migrations add the trial and grant columns without a DEFAULT
    for (const m of MIGRATION_FILES) expect(m.sql, m.name).not.toMatch(/ADD COLUMN (trial_started_at|trial_ends_at|comp_until)[^;\n]*DEFAULT/i);
  });
});

describe("the trial needs a card: it starts only on Stripe Checkout, which collects one up front", () => {
  it("POST /api/billing/trial opens a Pro Checkout with the trial's days and payment_method_collection always, and grants nothing", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie);
    const s = fakeStripe();
    expect((await call(env, "POST", "/api/billing/trial", { body: {}, fetch: s.fetch })).status).toBe(401);
    expect((await trial(env, cookie, { origin: "https://evil.example", fetch: s.fetch })).status).toBe(403);
    const bearer = await cliToken(env, cookie);
    const cli = await call(env, "POST", "/api/billing/trial", { body: {}, bearer, origin: null, fetch: s.fetch });
    expect(cli.status).toBe(403);
    expect(await error(cli)).toBe("a trial can be started only in the browser, on genclass.dev");
    expect((await call(env, "GET", "/api/billing/trial", { cookie, fetch: s.fetch })).status).toBe(405);
    expect(s.calls).toEqual([]);

    const r = await trial(env, cookie, { fetch: s.fetch });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_000001", trial: true });
    expect(s.calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual(["POST /v1/customers", "GET /v1/prices", "POST /v1/checkout/sessions"]);
    const [session] = sessionPosts(s);
    expect(Object.fromEntries(session!.form!)).toMatchObject({
      mode: "subscription",
      customer: "cus_test0001",
      client_reference_id: account.id,
      "line_items[0][price]": "price_pro000001",
      "line_items[0][quantity]": "1",
      // the card is collected although nothing is due today
      payment_method_collection: "always",
      "subscription_data[trial_period_days]": "7",
      // a trial that reaches its end with no payment method is cancelled, never invoiced into past_due
      "subscription_data[trial_settings][end_behavior][missing_payment_method]": "cancel",
      "subscription_data[metadata][genclass]": "1",
      "subscription_data[metadata][genclass_account]": account.id,
      "subscription_data[billing_mode][type]": "flexible",
      "metadata[genclass_plan]": "pro",
      "metadata[genclass_trial]": "1",
      success_url: "https://genclass.dev/account/billing?done=1&trial=1",
      cancel_url: "https://genclass.dev/account/billing",
    });
    expect(session!.form!.has("subscription_data[metadata][genclass_trial]")).toBe(false);
    expect(session!.headers["idempotency-key"]).toMatch(new RegExp(`^genclass-checkout-${account.id}-pro-\\d+-trial$`));
    // opening Stripe's page grants nothing: no trial dates, no plan, the dashboard still locked
    expect(sql.rows("SELECT plan, trial_started_at, trial_ends_at, comp_until FROM accounts")).toEqual([{ plan: "free", trial_started_at: null, trial_ends_at: null, comp_until: null }]);
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie })).status).toBe(402);

    // a second click (or tab) gets the same page; Upgrade to Pro closes it and opens one without a trial; the trial
    // again closes that one
    expect(await (await trial(env, cookie, { fetch: s.fetch })).json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_000001", trial: true });
    expect(sessionPosts(s)).toHaveLength(1);
    const buy = await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie, fetch: s.fetch });
    expect(await buy.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_000002" });
    expect(s.sessions.get("cs_test_000001")!.status).toBe("expired");
    const paid = sessionPosts(s)[1]!.form!;
    expect(paid.get("payment_method_collection")).toBe("always");
    expect(paid.has("subscription_data[trial_period_days]")).toBe(false);
    expect(paid.has("subscription_data[trial_settings][end_behavior][missing_payment_method]")).toBe(false);
    expect(paid.has("metadata[genclass_trial]")).toBe(false);
    expect(paid.get("success_url")).toBe("https://genclass.dev/account/billing?done=1");
    expect((await trial(env, cookie, { fetch: s.fetch })).status).toBe(200);
    expect(s.sessions.get("cs_test_000002")!.status).toBe("expired");
    expect(sessionPosts(s)[2]!.form!.get("subscription_data[trial_period_days]")).toBe("7");
    expect(sessionPosts(s)[2]!.headers["idempotency-key"]).toMatch(/-trial-after-[0-9a-f]{16}$/);
    expect(sql.rows("SELECT trial_started_at, trial_ends_at FROM accounts")).toEqual([{ trial_started_at: null, trial_ends_at: null }]);

    // back from the trial's Checkout the page waits for Stripe's word, with no buttons
    const back = await text(call(env, "GET", "/account/billing?done=1&trial=1", { cookie }));
    expect(back).toContain("This page changes to your 7-day Pro trial as soon as Stripe confirms it, usually within a minute. Nothing is charged until the trial ends.");
    expect(back).not.toContain('id="trial"');
    expect(back).not.toContain("data-plan=");
  });

  it("TRIAL_DAYS is the trial's length on Stripe, and every page that offers the trial says it, with the card terms", async () => {
    const { env } = setup({ ...LIVE, TRIAL_DAYS: "3" });
    const { cookie } = await signedIn(env);
    const app = await createApp(env, cookie);
    for (const path of ["/account", "/account/billing", `/account/apps/${app.id}`]) {
      const page = await text(call(env, "GET", path, { cookie }));
      expect(page, path).toContain(START(3));
      expect(page, path).toContain(TERMS(3));
    }
    for (const path of ["/start", "/login", "/signup"]) expect(await text(call(env, "GET", path, {})), path).toContain(OFFER(3));
    const s = fakeStripe();
    expect((await trial(env, cookie, { fetch: s.fetch })).status).toBe(200);
    expect(sessionPosts(s)[0]!.form!.get("subscription_data[trial_period_days]")).toBe("3");
    for (const [v, days] of [["0", 7], ["61", 7], ["abc", 7], [undefined, 7], ["14", 14], [" 3 ", 3]] as const) expect(trialDays({ BUCKET: { async put() {} }, TRIAL_DAYS: v }), String(v)).toBe(days);
    expect(trialTerms(7)).toBe(TERMS(7));
    expect(trialDaysLeft(new Date(now().getTime() + 1).toISOString(), now())).toBe(1);
  });

  it("with MANAGED_PAYMENTS on, the trial's Checkout is Managed Payments' too and sends nothing it refuses", async () => {
    const { env } = setup({ ...LIVE, MANAGED_PAYMENTS: "on" });
    const { cookie } = await signedIn(env);
    const s = fakeStripe();
    expect((await trial(env, cookie, { fetch: s.fetch })).status).toBe(200);
    const form = Object.fromEntries(sessionPosts(s)[0]!.form!);
    expect(form).toMatchObject({ "managed_payments[enabled]": "true", payment_method_collection: "always", "subscription_data[trial_period_days]": "7" });
    const refused = ["adaptive_pricing", "automatic_tax", "tax_id_collection", "payment_method_configuration", "payment_method_types", "customer_update", "subscription_data[invoice_settings]", "invoice_creation", "customer_email", "customer_creation"];
    for (const k of Object.keys(form)) for (const r of refused) expect(k.startsWith(r), k).toBe(false);
  });

  it("no trial while Stripe cannot sell to the account (no key, or a test key and an account not listed): 503, no Stripe call, no button", async () => {
    for (const over of [{}, { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_TEST_ACCOUNTS: "someone-else@example.com" }]) {
      const { env, sql } = setup(over);
      const { cookie } = await signedIn(env);
      const app = await createApp(env, cookie);
      const s = fakeStripe();
      const r = await trial(env, cookie, { fetch: s.fetch });
      expect(r.status).toBe(503);
      expect(await error(r)).toBe("the free trial starts on Stripe's checkout, which is not open yet");
      expect(s.calls).toEqual([]);
      expect(sql.rows("SELECT trial_started_at, trial_ends_at, plan FROM accounts")).toEqual([{ trial_started_at: null, trial_ends_at: null, plan: "free" }]);
      for (const path of ["/account", "/account/billing", `/account/apps/${app.id}`]) {
        const page = await text(call(env, "GET", path, { cookie }));
        expect(page, path).not.toContain('id="trial"');
        expect(page, path).not.toContain(TERMS());
        expect(page, path).not.toContain("Your trial has ended");
        if (path !== "/account/billing") expect(page, path).toContain('href="/account/billing">See plans</a>');
      }
      expect(await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }))).toContain("<p>Pick a plan to open it.</p>");
      expect(((await (await call(env, "GET", "/api/billing", { cookie })).json()) as any).can_trial).toBe(false);
      // the Free plan's app limit applies all the same
      for (const n of ["b", "c"]) await createApp(env, cookie, n);
      expect((await call(env, "POST", "/api/account/projects", { body: { name: "d" }, cookie })).status).toBe(409);
    }
  });

  it("refused (409) with a plan, a grant or a running trial, after a trial, and after any GenClass subscription, whatever the database says", async () => {
    const { env, sql } = setup(LIVE);
    const s = fakeStripe();
    // `dbKnows`: the database records why (pages then offer no trial); else only Stripe knows, until its webhook arrives
    const refused = async (email: string, set: (id: string) => void, why: RegExp | string, dbKnows = true) => {
      const a = await signedIn(env, email);
      set(a.account.id);
      const before = sql.rows("SELECT trial_started_at, trial_ends_at, plan FROM accounts WHERE id = ?", a.account.id);
      const posts = sessionPosts(s).length;
      const r = await trial(env, a.cookie, { fetch: s.fetch });
      expect(r.status, email).toBe(409);
      expect(await error(r), email).toMatch(why);
      expect(sessionPosts(s), email).toHaveLength(posts);
      expect(sql.rows("SELECT trial_started_at, trial_ends_at, plan FROM accounts WHERE id = ?", a.account.id), email).toEqual(before);
      expect(((await (await call(env, "GET", "/api/billing", { cookie: a.cookie })).json()) as any).can_trial, email).toBe(!dbKnows);
      if (dbKnows) expect(await text(call(env, "GET", "/account/billing", { cookie: a.cookie })), email).not.toContain('id="trial"');
      return a;
    };
    const iso = (ms: number) => new Date(now().getTime() + ms).toISOString();
    await refused("payer@example.com", (id) => setPlan(sql, id, "pro", { subscription_id: "sub_p000000001", subscription_status: "active", stripe_mode: "live" }), "this account already has the Pro plan");
    await refused("granted@example.com", (id) => setPlan(sql, id, "free", { comp_until: iso(10 * DAY) }), "this account already has Pro");
    await refused("old-running@example.com", (id) => setPlan(sql, id, "free", { trial_started_at: iso(-DAY), trial_ends_at: iso(6 * DAY) }), "this account already has Pro");
    await refused("old-ended@example.com", (id) => setPlan(sql, id, "free", { trial_started_at: iso(-30 * DAY), trial_ends_at: iso(-23 * DAY) }), /^this account already had its trial; see the plans at https:\/\/genclass\.dev\/account\/billing$/);
    await refused("stripe-trial@example.com", (id) => setPlan(sql, id, "free", { trial_started_at: iso(-30 * DAY), subscription_id: "sub_t000000001", subscription_status: "canceled", stripe_mode: "live" }), /already had its trial/);
    await refused("lapsed@example.com", (id) => setPlan(sql, id, "free", { subscription_id: "sub_l000000001", subscription_status: "canceled", stripe_mode: "live" }), /^the free trial comes before a first plan, and this account has had one/);
    // the database has no subscription yet (a late webhook), but Stripe lists one on the customer, in any status
    for (const [n, status] of [["1", "canceled"], ["2", "trialing"], ["3", "incomplete_expired"]] as const) {
      await refused(
        `late${n}@example.com`,
        (id) => {
          const cus = `cus_late00000${n}`;
          setPlan(sql, id, "free", { stripe_customer_id: cus, stripe_mode: "live" });
          s.genclassCustomer(cus, id, `late${n}@example.com`);
          s.subs.set(`sub_late0000${n}`, subscription(`sub_late0000${n}`, id, cus, "genclass_pro_monthly", status));
        },
        /the free trial comes before a first plan/,
        false,
      );
    }
    // a grant used no trial: once it ends, the account may have one
    const g = await signedIn(env, "grant-ended@example.com");
    setPlan(sql, g.account.id, "free", { comp_until: iso(-DAY) });
    expect((await trial(env, g.cookie, { fetch: s.fetch })).status).toBe(200);
  });
});

describe("the webhook grants the trial only once Stripe has it with a saved payment method", () => {
  it("a trialing subscription with a card gives Pro and records when the trial started; then no page offers the trial", async () => {
    const t = await trialing();
    const app = await createApp(t.env, t.cookie);
    expect(await t.send("customer.subscription.created")).toBe("applied");
    expect(t.state()).toEqual({ plan: "pro", subscription_status: "trialing", trial_started_at: new Date(T0S * 1000).toISOString(), trial_ends_at: null, past_due_since: null });
    expect((await call(t.env, "GET", `/api/account/projects/${app.id}/stats?range=1y`, { cookie: t.cookie })).status).toBe(200);
    const billing = await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }));
    expect(billing).toContain("You are on the <b>Pro</b> plan, in a trial until <time");
    expect(billing).toContain("When it ends your card is charged for the first month ($99 / month), unless you cancel before in Manage billing.");
    expect(billing).toContain('id="portal"');
    for (const path of ["/account", "/account/billing", `/account/apps/${app.id}`]) {
      const page = await text(call(t.env, "GET", path, { cookie: t.cookie }));
      expect(page, path).not.toContain('id="trial"');
      expect(page, path).not.toContain("Dashboards come with Pro");
    }
    expect(await (await call(t.env, "GET", "/api/billing", { cookie: t.cookie })).json()).toMatchObject({ plan: "pro", subscription_status: "trialing", access: "paid", can_trial: false });
    expect(await error(trial(t.env, t.cookie, { fetch: t.s.fetch }))).toBe("this account already has the Pro plan");
    // the same Pro again on Checkout is refused; Custom would be a switch, as from any Pro
    expect((await call(t.env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(409);
  });

  it("a trialing subscription without a saved payment method gives nothing until one is saved (cardOnFile)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await trialing();
    delete t.sub.default_payment_method;
    expect(await t.send("customer.subscription.created")).toBe("ignored");
    expect(t.state()).toMatchObject({ plan: "free", subscription_status: null, trial_started_at: null });
    expect(log.mock.calls.flat().join("\n")).toMatch(/customer\.subscription\.created evt_\w+ ignored: its trial has no saved payment method/);
    // the customer's default payment method counts too (the subscription is fetched with its customer)
    t.s.customers.get(t.customer)!.invoice_settings = { default_payment_method: "pm_card0000002" };
    expect(await t.send("customer.subscription.updated")).toBe("applied");
    expect(t.state()).toMatchObject({ plan: "pro", subscription_status: "trialing" });
    log.mockRestore();
    expect(cardOnFile({ status: "trialing" })).toBe(false);
    expect(cardOnFile({ status: "trialing", default_payment_method: "pm_x00000001" })).toBe(true);
    expect(cardOnFile({ status: "trialing", default_payment_method: { id: "pm_x00000001", object: "payment_method" } })).toBe(true);
    expect(cardOnFile({ status: "trialing", default_source: "card_x0000001" })).toBe(true);
    expect(cardOnFile({ status: "trialing", customer: { id: "cus_x0000001", invoice_settings: { default_payment_method: null } } })).toBe(false);
    expect(cardOnFile({ status: "trialing", customer: "cus_x0000001", default_payment_method: "" })).toBe(false);
    // other statuses are paid for (paymentCleared decides those)
    expect(cardOnFile({ status: "active" })).toBe(true);
  });

  it("the trial's end: a paid first charge keeps Pro; a card that fails is past_due like any failed payment, then Free after 14 days", async () => {
    const ok = await trialing();
    await ok.send("customer.subscription.created");
    advance(7 * DAY);
    ok.sub.status = "active";
    expect(await ok.send("customer.subscription.updated", { status: "trialing" })).toBe("applied");
    expect(ok.state()).toEqual({ plan: "pro", subscription_status: "active", trial_started_at: new Date(T0S * 1000).toISOString(), trial_ends_at: null, past_due_since: null });

    resetClock();
    const t = await trialing();
    await t.send("customer.subscription.created");
    advance(7 * DAY);
    const failed = now().toISOString();
    t.sub.status = "past_due";
    expect(await t.send("customer.subscription.updated", { status: "trialing" })).toBe("applied");
    expect(t.state()).toMatchObject({ plan: "pro", subscription_status: "past_due", past_due_since: failed });
    const pastDue = await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }));
    expect(pastDue).toContain("The last payment did not go through; Stripe tries the card again over the next days.");
    expect(pastDue).toContain("if it is still unpaid 14 days after the failed payment, the account moves to the Free plan");
    advance(13 * DAY);
    await planRetention(t.sql.api, now());
    expect(t.state().plan).toBe("pro");
    advance(2 * DAY);
    await planRetention(t.sql.api, now());
    expect(t.state()).toMatchObject({ plan: "free", subscription_status: "past_due", past_due_since: failed });
    const ended = await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }));
    expect(ended).toContain("Your trial has ended.");
    expect(ended).toContain("The last payment for your paid plan did not go through, so it has ended.");
    expect(ended).not.toContain('id="trial"');
    // paying the open invoice brings Pro back, as for any failed renewal; a new trial never does
    expect(await error(trial(t.env, t.cookie, { fetch: t.s.fetch }))).toMatch(/already had its trial/);
    t.sub.status = "active";
    expect(await t.send("customer.subscription.updated", { status: "past_due" })).toBe("applied");
    expect(t.state()).toMatchObject({ plan: "pro", subscription_status: "active", past_due_since: null });
  });

  it("a trial cancelled before its end, or ended by Stripe for want of a payment method, charges nothing and leaves no second trial", async () => {
    const t = await trialing();
    await t.send("customer.subscription.created");
    // cancelled in Manage billing during the trial: Pro until the trial's end, which the page says
    t.sub.cancel_at = T0S + 7 * 86_400;
    expect(await t.send("customer.subscription.updated")).toBe("applied");
    expect(await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }))).toContain("It is cancelled and will not renew");
    advance(7 * DAY);
    t.sub.status = "canceled";
    t.sub.ended_at = T0S + 7 * 86_400;
    expect(await t.send("customer.subscription.deleted")).toBe("applied");
    expect(t.state()).toMatchObject({ plan: "free", subscription_status: "canceled", trial_started_at: new Date(T0S * 1000).toISOString() });
    const app = await createApp(t.env, t.cookie);
    expect((await call(t.env, "GET", `/api/account/projects/${app.id}/stats`, { cookie: t.cookie })).status).toBe(402);
    expect(await text(call(t.env, "GET", `/account/apps/${app.id}`, { cookie: t.cookie }))).toContain("<p>Your trial has ended.</p>");
    expect((await trial(t.env, t.cookie, { fetch: t.s.fetch })).status).toBe(409);
  });
});

describe("the $1 card check: Stripe holds $1 on the trial's card and releases it before the trial is granted", () => {
  const holds = (s: ReturnType<typeof fakeStripe>) => s.calls.filter((c) => c.method === "POST" && c.url.pathname.startsWith("/v1/payment_intents"));
  const failures = (t: Awaited<ReturnType<typeof trialing>>) => t.sql.rows("SELECT trial_check_failures, trial_check_failed_at, subscription_id, trial_started_at FROM accounts WHERE id = ?", t.account.id)[0]!;

  it("a card that holds $1 gets the trial: a manual-capture PaymentIntent off session on that card, cancelled at once, made once", async () => {
    const t = await trialing();
    expect(await t.send("customer.subscription.created")).toBe("applied");
    expect(t.state()).toMatchObject({ plan: "pro", subscription_status: "trialing" });
    const [hold, release] = holds(t.s);
    expect(hold!.url.pathname).toBe("/v1/payment_intents");
    expect(Object.fromEntries(hold!.form!)).toMatchObject({
      amount: "100",
      currency: "usd",
      customer: t.customer,
      payment_method: "pm_card0000001",
      "payment_method_types[0]": "card",
      capture_method: "manual",
      confirm: "true",
      off_session: "true",
      "metadata[genclass]": "1",
      "metadata[genclass_account]": t.account.id,
      "metadata[genclass_card_check]": "sub_trial00001",
    });
    expect(hold!.headers["idempotency-key"]).toBe("genclass-card-check-sub_trial00001");
    // released: never captured, nothing charged
    expect(release!.url.pathname).toBe("/v1/payment_intents/pi_test000001/cancel");
    expect(t.s.paymentIntents.get("pi_test000001")).toMatchObject({ amount: 100, capture_method: "manual", status: "canceled" });
    expect(t.s.calls.some((c) => /\/capture$/.test(c.url.pathname))).toBe(false);
    // the subscription is the account's now: later events hold nothing again
    expect(await t.send("customer.subscription.updated")).toBe("applied");
    expect(holds(t.s)).toHaveLength(2);
    expect(failures(t)).toMatchObject({ trial_check_failures: 0, trial_check_failed_at: null });
  });

  it("a declined card gets no trial: the subscription is marked and cancelled, the page says so, and another card can be tried, 3 times at most", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const t = await trialing();
    t.sub.default_payment_method = "pm_cardDeclined01";
    expect(await t.send("customer.subscription.created")).toBe("ignored");
    expect(log.mock.calls.flat().join("\n")).toMatch(/the \$1 card check was declined \(card_declined\)/);
    // nothing granted, no trial used, no subscription recorded
    expect(t.state()).toMatchObject({ plan: "free", subscription_status: null, trial_started_at: null });
    expect(failures(t)).toEqual({ trial_check_failures: 1, trial_check_failed_at: now().toISOString(), subscription_id: null, trial_started_at: null });
    // the subscription is marked and cancelled at once (it was trialing: nothing to refund)
    expect(t.sub.metadata.genclass_card_check).toBe("failed");
    expect(t.sub.status).toBe("canceled");
    expect(t.s.calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname)).toEqual(["/v1/subscriptions/sub_trial00001"]);
    // no later event about it is applied (its end, its $0 invoice)
    expect(await t.send("customer.subscription.deleted")).toBe("ignored");
    expect(failures(t)).toMatchObject({ trial_check_failures: 1, subscription_id: null });
    // back from Checkout the page says so at once, and stops waiting; the browser learns it from /api/billing too
    const back = await text(call(t.env, "GET", "/account/billing?done=1&trial=1", { cookie: t.cookie }));
    expect(back).toContain('<p class="notice n-bad" role="alert" id="declined"><b>Your card did not pass the $1 check.</b> The bank declined a $1 hold, so the trial did not start and nothing was charged. Try another card with Start your 7-day free trial.</p>');
    expect(back).not.toContain('id="donemsg"');
    expect(back).toContain('id="trial"');
    expect(back).toContain('if (j && j.trial_card_declined_at && j.plan === "free") { clearInterval(timer); location.href = "/account/billing"; return; }');
    expect(await (await call(t.env, "GET", "/api/billing", { cookie: t.cookie })).json()).toMatchObject({ plan: "free", can_trial: true, trial_card_declined_at: now().toISOString() });

    // another card: the cancelled subscription does not count as a first plan; opening Checkout clears the last failure
    for (const [n, pm] of [["2", "pm_cardDeclined02"], ["3", "pm_cardDeclined03"]] as const) {
      advance(60_000);
      expect((await trial(t.env, t.cookie, { fetch: t.s.fetch })).status, n).toBe(200);
      expect(failures(t).trial_check_failed_at, n).toBeNull();
      const id = `sub_trial0000${n}`;
      t.s.subs.set(id, trialSub(id, t.account.id, t.customer, { default_payment_method: pm }));
      expect((await deliver(t.env, stripeEvent("customer.subscription.created", t.s.subs.get(id)!), t.s.fetch)).status).toBe(200);
      expect(t.s.subs.get(id)!.status, n).toBe("canceled");
    }
    expect(failures(t)).toMatchObject({ trial_check_failures: 3, subscription_id: null, trial_started_at: null });
    // after 3 failed cards no trial starts (against card testing), and the page says why
    const r = await trial(t.env, t.cookie, { fetch: t.s.fetch });
    expect(r.status).toBe(409);
    expect(await error(r)).toBe("3 cards on this account did not pass the $1 card check, so no trial can start; email mehar@daybot.ca");
    const page = await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }));
    expect(page).toContain("3 cards on this account did not pass it, so no trial can start");
    expect(page).not.toContain('id="trial"');
    expect(((await (await call(t.env, "GET", "/api/billing", { cookie: t.cookie })).json()) as any).can_trial).toBe(false);
    log.mockRestore();
  });

  it("a card that passes after one that failed gets the trial; the failure notice goes", async () => {
    const t = await trialing();
    t.sub.default_payment_method = "pm_cardDeclined01";
    await t.send("customer.subscription.created");
    expect((await trial(t.env, t.cookie, { fetch: t.s.fetch })).status).toBe(200);
    t.s.subs.set("sub_trial00002", trialSub("sub_trial00002", t.account.id, t.customer));
    expect((await deliver(t.env, stripeEvent("customer.subscription.created", t.s.subs.get("sub_trial00002")!), t.s.fetch)).status).toBe(200);
    expect(t.state()).toMatchObject({ plan: "pro", subscription_status: "trialing", trial_started_at: new Date(T0S * 1000).toISOString() });
    expect(failures(t)).toMatchObject({ trial_check_failures: 1, trial_check_failed_at: null, subscription_id: "sub_trial00002" });
    expect(await text(call(t.env, "GET", "/account/billing", { cookie: t.cookie }))).not.toContain('id="declined"');
  });

  it("a card whose bank asks for authentication counts as real (Checkout authenticated it when it was saved)", async () => {
    const t = await trialing();
    t.sub.default_payment_method = "pm_cardAuthRequired1";
    expect(await t.send("customer.subscription.created")).toBe("applied");
    expect(t.state()).toMatchObject({ plan: "pro", subscription_status: "trialing" });
    expect(failures(t)).toMatchObject({ trial_check_failures: 0 });
  });

  it("only through Stripe, and only where GenClass may hold: none for Managed Payments (Link charges the card) or a payment method that is not a card", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const mp = await trialing({ MANAGED_PAYMENTS: "on" });
    expect(await mp.send("customer.subscription.created")).toBe("applied");
    expect(holds(mp.s)).toEqual([]);
    const flagged = await trialing();
    flagged.sub.managed_payments = { enabled: true };
    expect(await flagged.send("customer.subscription.created")).toBe("applied");
    expect(holds(flagged.s)).toEqual([]);
    const bank = await trialing();
    bank.sub.default_payment_method = "pm_bank00000001";
    expect(await bank.send("customer.subscription.created")).toBe("applied");
    expect(holds(bank.s)).toEqual([]);
    expect(log.mock.calls.flat().join("\n")).toMatch(/no \$1 card check \(a us_bank_account payment method\)/);
    // the card saved on the customer (not on the subscription) is held
    const onCustomer = await trialing();
    delete onCustomer.sub.default_payment_method;
    onCustomer.s.customers.get(onCustomer.customer)!.invoice_settings = { default_payment_method: "pm_card0000009" };
    expect(await onCustomer.send("customer.subscription.created")).toBe("applied");
    expect(holds(onCustomer.s)[0]!.form!.get("payment_method")).toBe("pm_card0000009");
    log.mockRestore();
  });

  it("a Stripe outage during the hold grants nothing and answers 500, so Stripe delivers the event again", async () => {
    const t = await trialing();
    const down = fakeStripe({ answer: (url) => (url.pathname === "/v1/payment_intents" ? new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 }) : undefined) });
    for (const [k, v] of t.s.customers) down.customers.set(k, v);
    down.subs.set("sub_trial00001", t.sub);
    const ev = stripeEvent("customer.subscription.created", t.sub);
    expect((await deliver(t.env, ev, down.fetch)).status).toBe(500);
    expect(t.state()).toMatchObject({ plan: "free", subscription_status: null });
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM billing_events")[0]!.n).toBe(0);
    expect((await deliver(t.env, ev, t.s.fetch)).status).toBe(200);
    expect(t.state()).toMatchObject({ plan: "pro", subscription_status: "trialing" });
  });
});

describe("trials from before cards (trial_ends_at): they run to their end; nothing starts one any more", () => {
  it("a no-card trial already running keeps Pro and its days-left line to its end, then the dashboard locks for good", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie);
    sql.db.prepare("UPDATE accounts SET trial_started_at = ?, trial_ends_at = ? WHERE id = ?").run(new Date(now().getTime() - DAY).toISOString(), new Date(now().getTime() + 6 * DAY).toISOString(), account.id);
    const html = await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }));
    expect(html).toContain('<p class="trialn" id="trialn">Pro trial: 6 days left. <a href="/account/billing">See plans</a></p>');
    expect(await text(call(env, "GET", "/account/billing", { cookie }))).toContain("You are on a <b>Pro</b> trial.");
    expect(await (await call(env, "GET", "/api/billing", { cookie })).json()).toMatchObject({ plan: "free", access: "trial", can_trial: false });
    expect((await call(env, "GET", `/api/account/projects/${app.id}/events`, { cookie })).status).toBe(200);
    advance(6 * DAY + 1000);
    resetOwnerCache();
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { cookie })).status).toBe(402);
    const locked = await text(call(env, "GET", `/account/apps/${app.id}`, { cookie }));
    expect(locked).toContain("<p>Your trial has ended.</p>");
    expect(locked).not.toContain('id="trial"');
    expect(locked).toContain('<a class="btn green" href="/account/billing">See plans</a>');
    expect(await text(call(env, "GET", "/account", { cookie }))).toContain('<span class="aside">Your trial has ended</span>');
    expect((await trial(env, cookie, { fetch: fakeStripe().fetch })).status).toBe(409);
  });

  it("nothing in src/ writes trial_ends_at or comp_until; trial_started_at is written only by the webhook, once", () => {
    const dir = new URL("../src/", import.meta.url);
    const writes: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const code = readFileSync(new URL(f, dir), "utf8");
      for (const m of code.matchAll(/\b(trial_ends_at|trial_started_at|comp_until)\s*=\s*(\?|COALESCE|'|NULL)/gi)) writes.push(`${f}: ${m[0]}`);
      expect(code, f).not.toMatch(/INSERT INTO accounts[^;`]*\b(trial_ends_at|trial_started_at|comp_until)\b/);
    }
    expect(writes).toEqual(["stripe.ts: trial_started_at = COALESCE"]);
  });

  it("accessOf and canTrial: the paid plan first, then the grant, then a trial from before cards; a test-mode plan does not count under a live key", () => {
    const at = new Date("2026-10-15T12:00:00Z");
    const later = "2026-10-20T00:00:00.000Z";
    const earlier = "2026-10-10T00:00:00.000Z";
    const row = (o: Partial<Parameters<typeof accessOf>[0] & object> = {}) => ({ plan: "free", stripe_mode: null, trial_started_at: null, trial_ends_at: null, comp_until: null, subscription_id: null, ...o });
    expect(accessOf(null, null, at)).toMatchObject({ source: null, trialUsed: false, subscribed: false, plan: { id: "free" } });
    expect(accessOf(row(), null, at)).toMatchObject({ source: null, plan: { id: "free" } });
    expect(accessOf(row({ trial_started_at: earlier, trial_ends_at: later }), null, at)).toEqual({ plan: expect.objectContaining({ id: "pro" }), source: "trial", trialEndsAt: later, trialUsed: true, subscribed: false });
    expect(accessOf(row({ trial_started_at: earlier, trial_ends_at: earlier }), null, at)).toMatchObject({ source: null, trialUsed: true, plan: { id: "free" } });
    expect(accessOf(row({ comp_until: later, trial_started_at: earlier, trial_ends_at: later }), null, at)).toMatchObject({ source: "comp", plan: { id: "pro" } });
    expect(accessOf(row({ plan: "custom", comp_until: later }), "live", at)).toMatchObject({ source: "paid", plan: { id: "custom" } });
    expect(accessOf(row({ plan: "pro", stripe_mode: "test" }), "live", at)).toMatchObject({ source: null, plan: { id: "free" } });
    expect(accessOf(row({ plan: "pro", stripe_mode: "test", trial_started_at: earlier, trial_ends_at: later }), "live", at)).toMatchObject({ source: "trial" });
    // a subscription recorded in this mode counts as had; one from test mode does not once the key is live
    expect(accessOf(row({ subscription_id: "sub_x00000001", stripe_mode: "live" }), "live", at)).toMatchObject({ source: null, subscribed: true });
    expect(accessOf(row({ subscription_id: "sub_x00000001", stripe_mode: "test" }), "live", at)).toMatchObject({ source: null, subscribed: false });
    const env = { BUCKET: { async put() {} }, ...LIVE };
    const who = { id: "a1", email: "ada@example.com" };
    expect(canTrial(accessOf(row(), "live", at), env, who)).toBe(true);
    expect(canTrial(accessOf(row(), "live", at), { BUCKET: env.BUCKET }, who)).toBe(false);
    for (const r of [row({ trial_started_at: earlier }), row({ subscription_id: "sub_x00000001", stripe_mode: "live" }), row({ comp_until: later }), row({ plan: "pro" })]) {
      expect(canTrial(accessOf(r, "live", at), env, who)).toBe(false);
    }
  });

  it("retention: the apps of a grant or a running trial from before cards keep Pro's history; the Stripe mode stays the last parameter", () => {
    const l = longRetention(now(), "live")!;
    expect(l.tokens).toContain("a.comp_until > ? OR a.trial_ends_at > ? OR ((a.plan IN (");
    expect(l.params.slice(0, 2)).toEqual([now().toISOString(), now().toISOString()]);
    expect(l.params[l.params.length - 1]).toBe("live");
    expect(l.days).toBe(365);
  });
});

describe("private links without Pro: sign in, add the app to the account, go to the trial's Checkout", () => {
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
    expect(html).toContain(`<p class="lead">${OFFER()}.</p>`);
    expect(html).toContain('<div class="eb">shop-web</div>');
    // no OAuth on this server: sign in or sign up (an email and a password), then back here through /account?claim=1
    expect(html).toContain('href="/login?next=%2Faccount%3Fclaim%3D1"');
    expect(html).toContain('href="/signup?next=%2Faccount%3Fclaim%3D1"');
    expect(html).toContain('sessionStorage.setItem("gc.claim", secret)');
    expect(html).not.toContain(secret);
    expect(html).not.toMatch(OLD);
    // with Google: Continue with Google first, then Sign in (every other way in is on that page)
    const g = setup({ GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "s" });
    const gj = (await (await call(g.env, "POST", "/api/projects", { body: {}, origin: null })).json()) as any;
    const gh = await text(call(g.env, "GET", new URL(gj.dashboardUrl).pathname, { origin: null }));
    expect(gh).toContain('href="/auth/google?next=%2Faccount%3Fclaim%3D1"');
    expect(gh.indexOf("Continue with Google")).toBeLessThan(gh.indexOf('href="/login?next=%2Faccount%3Fclaim%3D1"'));
  });

  it("signed in: the page adds the app to the account and opens the trial's Checkout; the link opens the dashboard once Stripe has the trial", async () => {
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
    expect(html).toContain(`<button class="btn prov green" id="claim" type="button" data-trial="1"><span>Add to my account and start your 7-day free trial</span></button>`);
    expect(html).toContain(`<p class="opt">${TERMS()} The app keeps its key and its data.</p>`);
    expect(html).toContain('gcPost("/api/account/projects/claim", { secret: secret })');
    // what the button does: /account's claim, then the trial's Checkout (Stripe's page, where the card is entered)
    expect(html).toContain('return gcPost("/api/billing/trial", {}).then(function(t){ if (t && t.url) location.href = t.url; else go(); }, go);');
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { secret }, cookie })).status).toBe(200);
    const mine = await text(call(env, "GET", path, { cookie }));
    expect(mine).toContain('id="trial"');
    expect(mine).toContain(`<p class="opt">${TERMS()}</p>`);
    const s = fakeStripe();
    expect(await (await trial(env, cookie, { fetch: s.fetch })).json()).toMatchObject({ url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//), trial: true });
    // still locked: opening Checkout is not a trial
    expect(await text(call(env, "GET", path, { origin: null }))).toContain("Dashboards come with Pro.");
    // Stripe has the trialing subscription with its card: the link opens the dashboard for whoever holds it
    const customer = String(sql.rows("SELECT stripe_customer_id FROM accounts WHERE id = ?", account.id)[0]!.stripe_customer_id);
    s.subs.set("sub_trial00001", trialSub("sub_trial00001", account.id, customer));
    expect((await deliver(env, stripeEvent("customer.subscription.created", s.subs.get("sub_trial00001")!), s.fetch)).status).toBe(200);
    resetOwnerCache();
    expect(await text(call(env, "GET", path, { origin: null }))).not.toContain("Dashboards come with Pro.");
    expect((await call(env, "GET", `/api/projects/${secret}`, { origin: null })).status).toBe(200);
    expect(sql.rows("SELECT account_id FROM projects WHERE token = ?", anon.token)).toEqual([{ account_id: account.id }]);
  });

  it("another account's app says so; an account whose trial ended can still add an app and is shown the plans", async () => {
    const { env, sql } = setup(LIVE);
    const anon = (await (await call(env, "POST", "/api/projects", { body: { name: "Old shop" }, origin: null })).json()) as any;
    const path = new URL(anon.dashboardUrl).pathname;
    const ada = await signedIn(env, "ada@example.com");
    const bob = await signedIn(env, "bob@example.com");
    sql.db.prepare("UPDATE accounts SET trial_started_at = ?, trial_ends_at = ? WHERE id = ?").run("2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z", bob.account.id);
    const bobPage = await text(call(env, "GET", path, { cookie: bob.cookie }));
    expect(bobPage).toContain('data-trial="0"><span>Add to my account</span>');
    expect(bobPage).toContain('<p class="opt">Your trial has ended. <a href="/account/billing">See plans</a></p>');
    expect(bobPage).not.toContain(TERMS());
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, cookie: ada.cookie })).status).toBe(200);
    expect(await text(call(env, "GET", path, { cookie: bob.cookie }))).toContain("This app is in another GenClass account.");
    expect(await text(call(env, "GET", path, {}))).toContain("Then add this app to your account.");
  });

  it("GET /account/trial (the pricing page's button) leads to the account's Start your trial, through sign-up; a GET opens nothing", async () => {
    const { env, sql } = setup(LIVE);
    const s = fakeStripe();
    expect((await call(env, "GET", "/account/trial", { fetch: s.fetch })).headers.get("location")).toBe("/signup?next=%2Faccount%3Ftrial%3D1");
    const { cookie } = await signedIn(env);
    expect((await call(env, "GET", "/signup?next=%2Faccount%3Ftrial%3D1", { cookie })).headers.get("location")).toBe("/account?trial=1");
    expect((await call(env, "GET", "/account/trial", { cookie, fetch: s.fetch })).headers.get("location")).toBe("/account?trial=1");
    expect(s.calls).toEqual([]);
    expect(sql.rows("SELECT trial_started_at FROM accounts")).toEqual([{ trial_started_at: null }]);
    const page = await text(call(env, "GET", "/account?trial=1", { cookie }));
    expect(page).toContain('"trial":true');
    expect(page).toContain("if (cfg.trial) trial.focus();");
    expect(page).toContain(TERMS());
    expect((await trial(env, cookie, { fetch: s.fetch })).status).toBe(200);
    // the old "started" notice is gone: Stripe's success page comes back to the billing page
    expect(await text(call(env, "GET", "/account?started=1", { cookie }))).not.toContain("Your Pro trial has started.");
  });

  it("public pages say how long a trial lasts, from TRIAL_DAYS, never the days left, and never that it needs no card", async () => {
    const { env } = setup(LIVE);
    const pages = [await text(call(env, "GET", "/start", {})), await text(call(env, "GET", "/signup", {})), await text(call(env, "GET", "/login", {}))];
    const { cookie } = await signedIn(env);
    pages.push(await text(call(env, "GET", "/account", { cookie })), await text(call(env, "GET", "/account/billing", { cookie })));
    for (const p of pages) {
      expect(p).toContain(OFFER());
      expect(p).not.toMatch(OLD);
      expect(p).not.toMatch(/days? left/i);
      expect(noCardTrialLines(p)).toEqual([]);
    }
    expect(pages[0]).toContain(`Dashboards come with Pro. ${OFFER()}.`);
    expect(pages[1]).toContain(`<p class="opt">The runtime needs no account. Dashboards come with Pro. ${OFFER()}.</p>`);
    const fourteen = setup({ TRIAL_DAYS: "14" });
    expect(await text(call(fourteen.env, "GET", "/login", {}))).toContain(OFFER(14));
  });

  it("one number per side: wrangler.toml TRIAL_DAYS equals billing/plans.json trial_days (the site), and the CLI's copy says the same", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const days = /^TRIAL_DAYS = "(\d+)"$/m.exec(toml)?.[1];
    expect(days).toBeDefined();
    const plans = JSON.parse(readFileSync(new URL("../../billing/plans.json", import.meta.url), "utf8"));
    expect(plans.trial_days).toBe(Number(days));
    expect(trialDays({ BUCKET: { async put() {} }, TRIAL_DAYS: days })).toBe(plans.trial_days);
    // the site's build reads that field, and the committed pricing page was built with it
    expect(readFileSync(new URL("../../site/build.py", import.meta.url), "utf8")).toMatch(/PLANS(\.get\("trial_days"\)|\["trial_days"\])/);
    const pricing = readFileSync(new URL("../../site/public/pricing.html", import.meta.url), "utf8");
    expect(pricing).toContain(START(plans.trial_days));
    expect(pricing).not.toMatch(OLD);
    // the CLI states it in plain text (packages/runtime/bin): the same number
    for (const f of ["../../packages/runtime/bin/genclass-runtime.mjs", "../../packages/runtime/bin/lib/init.mjs"]) {
      const cli = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(cli, f).toMatch(new RegExp(`get a ${plans.trial_days}-day free trial\\s+for\\s+analytics`));
      expect(cli, f).not.toMatch(/trials available/i);
    }
  });

  it("the site says plainly that the trial needs a card and when it is first charged, and nowhere that it needs none", () => {
    const plans = JSON.parse(readFileSync(new URL("../../billing/plans.json", import.meta.url), "utf8"));
    const days = plans.trial_days as number;
    const price = `$${plans.plans.find((p: any) => p.id === "pro").price_usd_cents.monthly / 100}`;
    const read = (f: string) => readFileSync(new URL(`../../site/${f}`, import.meta.url), "utf8");
    // the pricing page: the line under Start your trial, and the FAQ
    const pricing = read("public/pricing.html");
    expect(pricing).toContain(`${START(days)}</a><p>Card required, checked by Stripe with a $1 hold that is released at once. Nothing is charged for ${days} days; when they end, your card is charged ${price} a month unless you cancel before.</p>`);
    expect(pricing).toContain(`<summary><span>Is there a free trial?</span></summary><p>Yes. Get a ${days}-day free trial for analytics: sign in, choose Start your ${days}-day free trial and enter a card on Stripe's checkout. A card is required: Stripe checks it with a $1 hold and releases the hold at once (your bank may show it as pending for a few days). Nothing is charged for ${days} days; when they end, your card is charged ${price} for the first month of Pro, then monthly.`);
    // the home page's FAQ (and its JSON-LD), and the terms
    const index = read("public/index.html");
    const faq = `${OFFER(days)}: a card is required, and it is first charged ${price} when the ${days} days end, unless you cancel before.`;
    expect(index.split(faq)).toHaveLength(3);
    expect(read("public/terms.html")).toContain(`It needs a card, entered on Stripe's checkout when you start it. Stripe checks the card with a temporary $1 authorization hold, released at once and never charged (your bank may show it as pending for a few days); a card that cannot hold $1 gets no trial. Nothing is charged during the trial. When it ends, Pro starts and the card is charged ${price} for the first month`);
    expect(read("public/llms.txt")).toContain("with a card that is first charged when the trial ends");
    // nothing the site builds from, or publishes, says the trial needs no card
    const files = ["build.py", ...readdirSync(new URL("../../site/src/pages/", import.meta.url)).filter((f) => f.endsWith(".html")).map((f) => `src/pages/${f}`)];
    files.push(...readdirSync(new URL("../../site/src/partials/", import.meta.url)).filter((f) => f.endsWith(".html")).map((f) => `src/partials/${f}`));
    files.push(...readdirSync(new URL("../../site/public/", import.meta.url)).filter((f) => f.endsWith(".html") || f.endsWith(".txt")).map((f) => `public/${f}`));
    for (const f of files) expect(noCardTrialLines(read(f)), f).toEqual([]);
    const src = new URL("../src/", import.meta.url);
    for (const f of readdirSync(src).filter((x) => x.endsWith(".ts"))) expect(noCardTrialLines(readFileSync(new URL(f, src), "utf8")), f).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import PLANS_JSON from "../../billing/plans.json";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { ACCOUNT_RANGES, canBuy, PLANS, pickRange, planByLookupKey, planForPrice, priceText, stripeMode, viewRanges } from "../src/plans.js";
import { form, invoicePaysCustom, invoiceSubscription, resetStripeCache, STRIPE_VERSION, subscriptionState, verifySignature, WEBHOOK_EVENTS } from "../src/stripe.js";
import {
  call,
  cliToken,
  createApp,
  deliver,
  fakeStripe,
  refusingLimiter,
  resetClock,
  setPlan,
  setup,
  signedIn,
  stripeEvent,
  subscription,
  WEBHOOK_SECRET,
  now,
} from "./account-helpers.js";

// Paid plans (src/plans.ts, src/stripe.ts, src/billing.ts): billing/plans.json, the Stripe webhook (signature,
// idempotency, plan from the subscription), Checkout and the Billing Portal with fetch mocked, CSRF, the Free plan's
// limits, the dashboard ranges per plan, the billing page, and account deletion with a live subscription.

// a live-mode key: paid plans on sale to everyone, the Free plan's limits on (fetch is always the fake below)
const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
const TEST_SECRET = "whsec_test_mode_0123456789";

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
  resetStripeCache();
});

const enc = (s: string) => new TextEncoder().encode(s);

// ------------------------------------------------------------------------------------------------- plans.json

describe("billing/plans.json: the one source of plans", () => {
  it("has free, pro and custom with the owner's prices, lookup keys, limits and entitlements", () => {
    expect(PLANS.map((p) => p.id)).toEqual(["free", "pro", "custom"]);
    const [free, pro, custom] = PLANS;
    expect(free!.price_usd_cents).toEqual({ monthly: 0, yearly: null });
    expect(pro!.price_usd_cents).toEqual({ monthly: 9900, yearly: null });
    expect(custom!.price_usd_cents).toEqual({ monthly: 59900, yearly: null });
    expect(pro!.stripe_lookup_keys).toEqual({ monthly: "genclass_pro_monthly", yearly: null });
    expect(custom!.stripe_lookup_keys).toEqual({ monthly: "genclass_custom_monthly", yearly: null });
    expect(free!.limits).toEqual({ apps: 3, history_days: 7 });
    expect(pro!.limits).toEqual({ apps: null, history_days: 365 });
    expect(free!.entitlements).toEqual({ forwarding: false, export: false, analytics: false, custom_model: false });
    expect(pro!.entitlements).toEqual({ forwarding: true, export: true, analytics: true, custom_model: false });
    expect(custom!.entitlements.custom_model).toBe(true);
    expect(priceText(pro!)).toBe("$99 / month");
    expect(priceText(custom!)).toBe("$599 / month");
    expect(planByLookupKey("genclass_custom_monthly")?.id).toBe("custom");
    expect(planByLookupKey("something_else")).toBeNull();
    // interaction analytics is listed as coming next, not as available
    expect(pro!.features.find((f) => /Interaction analytics/.test(f.text))).toEqual({ text: "Interaction analytics (coming next)", available: false });
    expect((PLANS_JSON as any).footer).toBe("Need self-hosting, SSO or invoices? Email mehar@daybot.ca.");
  });

  it("feature text follows the voice rules: no em-dashes, no exclamation marks, nothing about seats or teams", () => {
    const text = JSON.stringify(PLANS_JSON);
    expect(text).not.toMatch(/\u2014|!/);
    expect(text).not.toMatch(/\bseats?\b|\bteams?\b/i);
  });
});

// ------------------------------------------------------------------------------------------------- signature

describe("Stripe webhook signature (Stripe-Signature: t=, v1=; HMAC-SHA256 of t.payload)", () => {
  const body = enc('{"id":"evt_1","type":"invoice.paid"}');
  const t = 1_790_000_000;
  async function header(secret: string, ts = t, payload = body) {
    const k = await crypto.subtle.importKey("raw", enc(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const msg = new Uint8Array([...enc(`${ts}.`), ...payload]);
    return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, msg))].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  it("accepts a valid signature, and any one valid v1 among several (secret rotation)", async () => {
    const good = await header(WEBHOOK_SECRET);
    expect(await verifySignature(body, `t=${t},v1=${good}`, WEBHOOK_SECRET, t + 10)).toBe("ok");
    const other = await header("whsec_old");
    expect(await verifySignature(body, `t=${t},v1=${other},v1=${good},v0=abc`, WEBHOOK_SECRET, t)).toBe("ok");
  });
  it("refuses a wrong secret, a changed body, an old or future timestamp, and malformed headers", async () => {
    const good = await header(WEBHOOK_SECRET);
    expect(await verifySignature(body, `t=${t},v1=${await header("whsec_wrong")}`, WEBHOOK_SECRET, t)).toMatch(/does not match/);
    expect(await verifySignature(enc('{"id":"evt_2"}'), `t=${t},v1=${good}`, WEBHOOK_SECRET, t)).toMatch(/does not match/);
    expect(await verifySignature(body, `t=${t},v1=${good}`, WEBHOOK_SECRET, t + 301)).toMatch(/tolerance/);
    expect(await verifySignature(body, `t=${t},v1=${good}`, WEBHOOK_SECRET, t - 301)).toMatch(/tolerance/);
    expect(await verifySignature(body, `t=${t + 1},v1=${good}`, WEBHOOK_SECRET, t)).toMatch(/does not match/);
    expect(await verifySignature(body, null, WEBHOOK_SECRET, t)).toMatch(/no Stripe-Signature/);
    expect(await verifySignature(body, `v1=${good}`, WEBHOOK_SECRET, t)).toMatch(/no timestamp/);
    expect(await verifySignature(body, `t=${t}`, WEBHOOK_SECRET, t)).toMatch(/no v1/);
    expect(await verifySignature(body, `t=${t},v0=${good}`, WEBHOOK_SECRET, t)).toMatch(/no v1/);
  });
});

// ------------------------------------------------------------------------------------------------- REST encoding

describe("Stripe requests: form encoding, version, idempotency", () => {
  it("encodes nested objects and arrays the way Stripe reads them, leaving out null and undefined", () => {
    const s = form({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }], metadata: { a: "x y" }, skip: null, gone: undefined, lookup_keys: ["k"] });
    expect(new URLSearchParams(s).toString()).toBe(s);
    expect([...new URLSearchParams(s)]).toEqual([
      ["mode", "subscription"],
      ["line_items[0][price]", "price_1"],
      ["line_items[0][quantity]", "1"],
      ["metadata[a]", "x y"],
      ["lookup_keys[0]", "k"],
    ]);
  });
});

// ------------------------------------------------------------------------------------------------- Checkout, portal

describe("POST /api/billing/checkout and /api/billing/portal", () => {
  it("checkout: a customer is created once with the account's email, then a subscription session by lookup_key", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    const s = fakeStripe();
    const r = await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie, fetch: s.fetch });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_000001" });
    expect(s.calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual(["POST /v1/customers", "GET /v1/prices", "POST /v1/checkout/sessions"]);
    const [customer, prices, session] = s.calls;
    expect(prices!.url.searchParams.get("lookup_keys[0]")).toBe("genclass_pro_monthly");
    expect(prices!.url.searchParams.get("active")).toBe("true");
    expect(Object.fromEntries(customer!.form!)).toEqual({ email: "ada@example.com", "metadata[account_id]": account.id });
    expect(customer!.headers["idempotency-key"]).toBe(`genclass-customer-${account.id}`);
    expect(Object.fromEntries(session!.form!)).toMatchObject({
      mode: "subscription",
      customer: "cus_test0001",
      client_reference_id: account.id,
      "line_items[0][price]": "price_pro000001",
      "line_items[0][quantity]": "1",
      success_url: "https://genclass.dev/account/billing?done=1",
      cancel_url: "https://genclass.dev/account/billing",
      "metadata[account_id]": account.id,
      "metadata[plan]": "pro",
      "subscription_data[metadata][account_id]": account.id,
      "subscription_data[metadata][plan]": "pro",
    });
    for (const c of s.calls) {
      expect(c.headers.authorization).toBe("Bearer sk_live_fake");
      expect(c.headers["stripe-version"]).toBe(STRIPE_VERSION);
    }
    expect(session!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(session!.headers["idempotency-key"]).toMatch(new RegExp(`^genclass-checkout-${account.id}-pro-\\d+$`));
    expect(sql.rows("SELECT stripe_customer_id, stripe_mode, plan FROM accounts")).toEqual([{ stripe_customer_id: "cus_test0001", stripe_mode: "live", plan: "free" }]);

    // again (Custom this time): the customer is reused, Stripe is asked for its subscriptions and open Checkout pages,
    // the unpaid Pro page is closed, and the price comes from Custom's own lookup key
    s.calls.length = 0;
    const second = await call(env, "POST", "/api/billing/checkout", { body: { plan: "custom" }, cookie, fetch: s.fetch });
    expect(await second.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_000002" });
    expect(s.calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      "GET /v1/subscriptions",
      "GET /v1/checkout/sessions",
      "POST /v1/checkout/sessions/cs_test_000001/expire",
      "GET /v1/prices",
      "POST /v1/checkout/sessions",
    ]);
    expect(s.calls[0]!.url.searchParams.get("customer")).toBe("cus_test0001");
    expect(s.calls[0]!.url.searchParams.get("status")).toBe("all");
    expect(s.calls[1]!.url.searchParams.get("status")).toBe("open");
    expect(s.sessions.get("cs_test_000001")!.status).toBe("expired");
    const made = s.calls[4]!;
    expect(made.form!.get("line_items[0][price]")).toBe("price_custom0001");
    expect(made.form!.get("customer")).toBe("cus_test0001");
    // after closing a page the idempotency key changes, so Stripe cannot hand back the page it just closed
    expect(made.headers["idempotency-key"]).toMatch(new RegExp(`^genclass-checkout-${account.id}-custom-\\d+-after-[0-9a-f]{16}$`));

    // a second click on Custom (or a second tab) gets the same open page, not a second one
    s.calls.length = 0;
    const third = await call(env, "POST", "/api/billing/checkout", { body: { plan: "custom" }, cookie, fetch: s.fetch });
    expect(await third.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_000002" });
    expect(s.calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual(["GET /v1/subscriptions", "GET /v1/checkout/sessions"]);
  });

  it("CSRF and sessions: both POSTs need the browser session and our Origin; a CLI token and bad input are refused", async () => {
    const { env } = setup(LIVE);
    const { cookie } = await signedIn(env);
    const bearer = await cliToken(env, cookie);
    const s = fakeStripe();
    for (const path of ["/api/billing/checkout", "/api/billing/portal"]) {
      expect((await call(env, "POST", path, { body: { plan: "pro" }, cookie, origin: null, fetch: s.fetch })).status).toBe(403);
      expect((await call(env, "POST", path, { body: { plan: "pro" }, cookie, origin: "https://evil.example", fetch: s.fetch })).status).toBe(403);
      expect((await call(env, "POST", path, { body: { plan: "pro" }, fetch: s.fetch })).status).toBe(401);
      expect((await call(env, "POST", path, { body: { plan: "pro" }, bearer, origin: null, fetch: s.fetch })).status).toBe(403);
      expect((await call(env, "POST", path, { body: "plan=pro", cookie, headers: { "content-type": "application/x-www-form-urlencoded" }, fetch: s.fetch })).status).toBe(415);
      expect((await call(env, "GET", path, { cookie, fetch: s.fetch })).status).toBe(405);
    }
    expect(s.calls).toEqual([]);
    expect((await call(env, "POST", "/api/billing/checkout", { body: { plan: "free" }, cookie, fetch: s.fetch })).status).toBe(400);
    expect((await call(env, "POST", "/api/billing/checkout", { body: { plan: "enterprise" }, cookie, fetch: s.fetch })).status).toBe(400);
    // nothing to manage before a first purchase
    expect((await call(env, "POST", "/api/billing/portal", { body: {}, cookie, fetch: s.fetch })).status).toBe(409);
    // not on sale without the secret key
    const off = setup();
    const o = await signedIn(off.env);
    expect((await call(off.env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie: o.cookie, fetch: s.fetch })).status).toBe(503);
  });

  it("portal: a session for the account's customer, with the configuration the setup script made", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    setPlan(sql, account.id, "pro", { stripe_customer_id: "cus_known0001", subscription_id: "sub_known0001", subscription_status: "active" });
    const s = fakeStripe();
    const r = await call(env, "POST", "/api/billing/portal", { body: {}, cookie, fetch: s.fetch });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: "https://billing.stripe.com/p/session/test_000001" });
    const sess = s.calls.find((c) => c.url.pathname === "/v1/billing_portal/sessions")!;
    expect(Object.fromEntries(sess.form!)).toEqual({ customer: "cus_known0001", return_url: "https://genclass.dev/account/billing", configuration: "bpc_genclass01" });
  });

  it("a paying account asking for the other plan is sent to the portal's plan change, never into a second subscription", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    setPlan(sql, account.id, "pro", { stripe_customer_id: "cus_known0001", subscription_id: "sub_known0001", subscription_status: "active", stripe_mode: "live" });
    const s = fakeStripe();
    s.subs.set("sub_known0001", subscription("sub_known0001", account.id, "cus_known0001", "genclass_pro_monthly"));
    const r = await call(env, "POST", "/api/billing/checkout", { body: { plan: "custom" }, cookie, fetch: s.fetch });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).portal).toBe(true);
    const sess = s.calls.find((c) => c.url.pathname === "/v1/billing_portal/sessions")!;
    expect(sess.form!.get("flow_data[type]")).toBe("subscription_update");
    expect(sess.form!.get("flow_data[subscription_update][subscription]")).toBe("sub_known0001");
    expect(s.calls.some((c) => c.url.pathname === "/v1/checkout/sessions")).toBe(false);
    expect((await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie, fetch: s.fetch })).status).toBe(409);
  });

  it("what Stripe has decides, not the database: a payment whose webhook has not arrived yet blocks a second purchase", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    // the database still says Free (no webhook yet), Stripe already has the Pro subscription
    setPlan(sql, account.id, "free", { stripe_customer_id: "cus_late000001", stripe_mode: "live" });
    const s = fakeStripe();
    s.subs.set("sub_late000001", subscription("sub_late000001", account.id, "cus_late000001", "genclass_pro_monthly"));
    const again = await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie, fetch: s.fetch });
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error).toBe("you are already on the Pro plan");
    const other = await call(env, "POST", "/api/billing/checkout", { body: { plan: "custom" }, cookie, fetch: s.fetch });
    expect(((await other.json()) as any).portal).toBe(true);
    expect(s.calls.some((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions")).toBe(false);
    // a cancelled-at-period-end plan says how to keep it
    s.subs.get("sub_late000001")!.cancel_at_period_end = true;
    expect(((await (await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie, fetch: s.fetch })).json()) as any).error).toBe(
      "you are already on the Pro plan; to keep it after this period, resume it in Manage billing",
    );
  });

  it("a stored customer Stripe no longer has is replaced at checkout, and forgotten by the portal", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    setPlan(sql, account.id, "free", { stripe_customer_id: "cus_gone000001", stripe_mode: "live" });
    const missing = () => new Response(JSON.stringify({ error: { code: "resource_missing", param: "customer", message: "No such customer: 'cus_gone000001'" } }), { status: 400 });
    const s = fakeStripe({ answer: (u) => (u.searchParams.get("customer") === "cus_gone000001" ? missing() : undefined) });
    const r = await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie, fetch: s.fetch });
    expect(r.status).toBe(200);
    expect(s.calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual(["GET /v1/subscriptions", "POST /v1/customers", "GET /v1/prices", "POST /v1/checkout/sessions"]);
    expect(s.calls[1]!.headers["idempotency-key"]).toBe(`genclass-customer-${account.id}-after-cus_gone000001`);
    expect(sql.rows("SELECT stripe_customer_id, stripe_mode FROM accounts")).toEqual([{ stripe_customer_id: "cus_test0001", stripe_mode: "live" }]);

    setPlan(sql, account.id, "pro", { stripe_customer_id: "cus_gone000002", subscription_id: "sub_gone000002", subscription_status: "active", stripe_mode: "live" });
    const p = fakeStripe({ answer: (u) => (u.pathname === "/v1/billing_portal/sessions" ? missing() : undefined) });
    const pr = await call(env, "POST", "/api/billing/portal", { body: {}, cookie, fetch: p.fetch });
    expect(pr.status).toBe(409);
    expect(sql.rows("SELECT plan, stripe_customer_id, subscription_id FROM accounts")).toEqual([{ plan: "free", stripe_customer_id: null, subscription_id: null }]);
  });

  it("checkout, portal, Send test, new export keys and the export answer 429 once an account is over its budget", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie);
    // from here on every budget is used up (sign-in itself has one too, so it is set after)
    env.AUTH_LIMIT = refusingLimiter;
    env.EXPORT_LIMIT = refusingLimiter;
    const s = fakeStripe();
    const r = await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie, fetch: s.fetch });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(s.calls).toEqual([]);
    setPlan(sql, account.id, "pro", { stripe_customer_id: "cus_rate000001", stripe_mode: "live" });
    expect((await call(env, "POST", "/api/billing/portal", { body: {}, cookie, fetch: s.fetch })).status).toBe(429);
    expect((await call(env, "POST", "/api/account/export-keys", { body: {}, cookie })).status).toBe(429);
    expect((await call(env, "GET", `/api/account/projects/${app.id}/events`, { cookie })).status).toBe(429);
    expect(s.calls).toEqual([]);
  });

  it("a Stripe refusal or outage is a 502 with Stripe's reason, and nothing is saved", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie } = await signedIn(env);
    const s = fakeStripe({ answer: (u) => (u.pathname === "/v1/customers" ? new Response(JSON.stringify({ error: { message: "Invalid API Key provided" } }), { status: 401 }) : undefined) });
    const r = await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie, fetch: s.fetch });
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error).toBe("Stripe: Invalid API Key provided");
    expect(sql.rows("SELECT stripe_customer_id FROM accounts")).toEqual([{ stripe_customer_id: null }]);
    const down = await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie, fetch: async () => { throw new Error("offline"); } });
    expect(down.status).toBe(502);
  });
});

// ------------------------------------------------------------------------------------------------- webhook

describe("POST /api/billing/webhook: the plan follows the subscription", () => {
  async function paying(planKey = "genclass_pro_monthly") {
    const t = setup({ ...LIVE, NOTIFY_WEBHOOK: "https://hooks.example.com/notify" });
    const a = await signedIn(t.env);
    const s = fakeStripe();
    t.sql.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_ada0000001' WHERE id = ?").run(a.account.id);
    s.subs.set("sub_ada0000001", subscription("sub_ada0000001", a.account.id, "cus_ada0000001", planKey));
    const plan = () => t.sql.rows("SELECT plan, subscription_id, subscription_status, current_period_end, cancel_at_period_end FROM accounts")[0]!;
    return { ...t, ...a, s, plan };
  }
  const checkoutDone = (accountId: string) =>
    stripeEvent("checkout.session.completed", { id: "cs_test_000001", object: "checkout.session", mode: "subscription", client_reference_id: accountId, customer: "cus_ada0000001", subscription: "sub_ada0000001", payment_status: "paid" });

  it("checkout.session.completed: Pro, from the subscription's lookup key; the same event again changes nothing", async () => {
    const t = await paying();
    const ev = checkoutDone(t.account.id);
    const r = await deliver(t.env, ev, t.s.fetch);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: true, result: "applied" });
    expect(t.plan()).toEqual({ plan: "pro", subscription_id: "sub_ada0000001", subscription_status: "active", current_period_end: new Date(1_792_000_000_000).toISOString(), cancel_at_period_end: 0 });
    // the subscription (with its prices' products), then the customer's subscriptions (one subscription per account)
    expect(t.s.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /v1/subscriptions/sub_ada0000001", "GET /v1/subscriptions"]);
    expect(t.s.calls[0]!.url.searchParams.get("expand[0]")).toBe("items.data.price.product");
    expect(t.sql.rows("SELECT stripe_mode FROM accounts")).toEqual([{ stripe_mode: "live" }]);
    expect(t.sql.rows("SELECT id, type FROM billing_events")).toEqual([{ id: ev.id, type: "checkout.session.completed" }]);
    // a redelivery is recognised by its id: no second fetch, no change
    t.s.subs.get("sub_ada0000001")!.status = "canceled";
    const again = await deliver(t.env, ev, t.s.fetch);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect(t.s.calls).toHaveLength(2);
    expect(t.plan().plan).toBe("pro");
  });

  it("every event type moves the plan the way the subscription's status says", async () => {
    const t = await paying();
    const sub = t.s.subs.get("sub_ada0000001")!;
    const send = async (type: string, obj: Record<string, unknown>) => {
      const r = await deliver(t.env, stripeEvent(type, obj), t.s.fetch);
      expect(r.status, type).toBe(200);
      return t.plan();
    };
    expect((await send("customer.subscription.created", sub)).plan).toBe("pro");
    // cancel at period end: still Pro, flagged, ends at the period end
    sub.cancel_at_period_end = true;
    expect(await send("customer.subscription.updated", sub)).toMatchObject({ plan: "pro", cancel_at_period_end: 1 });
    sub.cancel_at_period_end = false;
    // a failed renewal: past_due keeps Pro while Stripe retries
    sub.status = "past_due";
    expect(await send("invoice.payment_failed", { id: "in_1", object: "invoice", customer: "cus_ada0000001", parent: { subscription_details: { subscription: "sub_ada0000001" } } })).toMatchObject({ plan: "pro", subscription_status: "past_due" });
    sub.status = "active";
    expect(await send("invoice.paid", { id: "in_2", object: "invoice", customer: "cus_ada0000001", subscription: "sub_ada0000001" })).toMatchObject({ plan: "pro", subscription_status: "active" });
    // switched to Custom in the portal
    sub.items.data[0].price.lookup_key = "genclass_custom_monthly";
    expect((await send("customer.subscription.updated", sub)).plan).toBe("custom");
    sub.status = "unpaid";
    expect(await send("invoice.payment_failed", { id: "in_3", object: "invoice", customer: "cus_ada0000001", subscription: "sub_ada0000001" })).toMatchObject({ plan: "free", subscription_status: "unpaid" });
    sub.status = "canceled";
    expect(await send("customer.subscription.deleted", sub)).toMatchObject({ plan: "free", subscription_status: "canceled", cancel_at_period_end: 0 });
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM billing_events")[0]!.n).toBe(7);
  });

  it("subscriptionState: active and trialing give the plan, past_due keeps it, anything else is free; both API shapes", () => {
    const base = subscription("sub_x00000001", "a".repeat(22), "cus_x00000001", "genclass_pro_monthly");
    for (const [status, plan] of [["active", "pro"], ["trialing", "pro"], ["past_due", "pro"], ["incomplete", "free"], ["incomplete_expired", "free"], ["canceled", "free"], ["unpaid", "free"], ["paused", "free"]] as const) {
      expect(subscriptionState({ ...base, status }).plan, status).toBe(plan);
    }
    expect(subscriptionState({ ...base, items: { data: [{ price: { lookup_key: "old_plan_key" } }] } })).toMatchObject({ plan: "free", priced: null, lookupKey: "old_plan_key" });
    // a price the setup script replaced has lost its lookup key but keeps its metadata: its subscribers keep the plan
    expect(subscriptionState({ ...base, items: { data: [{ price: { id: "price_old", lookup_key: null, metadata: { genclass_plan: "pro" } } }] } })).toMatchObject({ plan: "pro", priced: "pro", lookupKey: null });
    expect(subscriptionState({ ...base, items: { data: [{ price: { id: "price_old", lookup_key: null, metadata: {}, product: { id: "prod_1", metadata: { genclass_plan: "custom" } } } }] } }).plan).toBe("custom");
    // metadata can only name a paid plan in plans.json
    expect(planForPrice({ lookup_key: null, metadata: { genclass_plan: "free" } })).toBeNull();
    expect(planForPrice({ lookup_key: null, metadata: { genclass_plan: "enterprise" } })).toBeNull();
    // cancelled at once (deletion, a refund, dunning): the period ends when it ended, not at the paid period's end
    expect(subscriptionState({ ...base, status: "canceled", ended_at: 1_791_000_000 })).toMatchObject({ plan: "free", periodEnd: new Date(1_791_000_000_000).toISOString(), cancelAtPeriodEnd: false });
    expect(subscriptionState({ ...base, status: "active", ended_at: 1_791_000_000 }).periodEnd).toBe(new Date(1_792_000_000_000).toISOString());
    // before API version 2025-03-31 the period end was on the subscription
    expect(subscriptionState({ ...base, current_period_end: 1_700_000_000, items: { data: [{ price: { lookup_key: "genclass_pro_monthly" } }] } }).periodEnd).toBe(new Date(1_700_000_000_000).toISOString());
    expect(subscriptionState({ ...base, cancel_at: 1_795_000_000 })).toMatchObject({ cancelAtPeriodEnd: true, periodEnd: new Date(1_795_000_000_000).toISOString() });
    expect(invoiceSubscription({ subscription: "sub_old0000001" })).toBe("sub_old0000001");
    expect(invoiceSubscription({ parent: { subscription_details: { subscription: "sub_new0000001" } } })).toBe("sub_new0000001");
    expect(invoiceSubscription({ lines: { data: [{ parent: { subscription_item_details: { subscription: "sub_line000001" } } }] } })).toBe("sub_line000001");
    expect(invoiceSubscription({})).toBeNull();
    expect(WEBHOOK_EVENTS).toEqual(["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"]);
  });

  it("an older subscription ending does not downgrade an account that has a newer live one", async () => {
    const t = await paying();
    setPlan(t.sql, t.account.id, "pro", { subscription_id: "sub_new0000001", subscription_status: "active" });
    t.s.subs.set("sub_old0000001", subscription("sub_old0000001", t.account.id, "cus_ada0000001", "genclass_pro_monthly", "canceled"));
    const r = await deliver(t.env, stripeEvent("customer.subscription.deleted", t.s.subs.get("sub_old0000001")!), t.s.fetch);
    expect(await r.json()).toEqual({ received: true, result: "ignored" });
    expect(t.plan()).toMatchObject({ plan: "pro", subscription_id: "sub_new0000001" });
  });

  it("events for a customer GenClass does not know are logged by type and id and ignored", async () => {
    const t = await paying();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    t.s.subs.set("sub_zzz0000001", subscription("sub_zzz0000001", "Z".repeat(22), "cus_zzz0000001", "genclass_pro_monthly"));
    const ev = stripeEvent("customer.subscription.updated", t.s.subs.get("sub_zzz0000001")!);
    const r = await deliver(t.env, ev, t.s.fetch);
    expect(await r.json()).toEqual({ received: true, result: "ignored" });
    expect(log).toHaveBeenCalledWith(`stripe webhook: customer.subscription.updated ${ev.id} ignored: no GenClass account for this customer`);
    log.mockRestore();
    expect(t.plan().plan).toBe("free");
    expect((await deliver(t.env, stripeEvent("customer.created", { id: "cus_1" }), t.s.fetch)).status).toBe(200);
  });

  it("refuses a bad signature, an old timestamp and unconfigured servers; records nothing", async () => {
    const t = await paying();
    const ev = checkoutDone(t.account.id);
    expect((await deliver(t.env, ev, t.s.fetch, { secret: "whsec_wrong" })).status).toBe(400);
    expect((await deliver(t.env, ev, t.s.fetch, { t: Math.floor(now().getTime() / 1000) - 600 })).status).toBe(400);
    expect((await deliver(t.env, ev, t.s.fetch, { header: "" })).status).toBe(400);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM billing_events")[0]!.n).toBe(0);
    expect(t.plan().plan).toBe("free");
    const off = setup({ STRIPE_SECRET_KEY: "sk_test_fake" });
    expect((await deliver(off.env, ev, t.s.fetch)).status).toBe(503);
  });

  it("a Stripe failure while applying answers 500 and does not record the event, so Stripe's retry applies it", async () => {
    const t = await paying();
    const ev = checkoutDone(t.account.id);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await deliver(t.env, ev, async () => { throw new Error("offline"); });
    log.mockRestore();
    expect(r.status).toBe(500);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM billing_events")[0]!.n).toBe(0);
    expect((await deliver(t.env, ev, t.s.fetch)).status).toBe(200);
    expect(t.plan().plan).toBe("pro");
  });

  it("a Custom purchase is recorded once and the owner is notified at NOTIFY_WEBHOOK, with ids only", async () => {
    const t = await paying("genclass_custom_monthly");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await deliver(t.env, checkoutDone(t.account.id), t.s.fetch)).status).toBe(200);
    expect((await deliver(t.env, stripeEvent("customer.subscription.created", t.s.subs.get("sub_ada0000001")!), t.s.fetch)).status).toBe(200);
    log.mockRestore();
    expect(t.plan().plan).toBe("custom");
    const rows = t.sql.rows("SELECT id, account_id, email, subscription_id, notified, mode FROM custom_requests");
    expect(rows).toEqual([{ id: rows[0]!.id, account_id: t.account.id, email: "ada@example.com", subscription_id: "sub_ada0000001", notified: now().toISOString(), mode: "live" }]);
    expect(t.s.other).toHaveLength(1);
    expect(t.s.other[0]!.url).toBe("https://hooks.example.com/notify");
    const notice = JSON.parse(t.s.other[0]!.body);
    expect(notice).toMatchObject({ event: "custom_purchase", request_id: rows[0]!.id, account_id: t.account.id, subscription_id: "sub_ada0000001", mode: "live" });
    // the buyer's email stays in custom_requests; the chat channel gets ids only
    expect(t.s.other[0]!.body).not.toContain("ada@example.com");
    expect(notice.text).toBe(`GenClass Custom plan bought: request ${rows[0]!.id}, account ${t.account.id}. The buyer's email is in custom_requests; write to them within 1 business day.`);
    expect(notice.content).toBe(notice.text);
  });

  it("a switch from Pro to Custom counts as a purchase only when Stripe reports the Custom price paid", async () => {
    const t = await paying();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sub = t.s.subs.get("sub_ada0000001")!;
    expect((await deliver(t.env, checkoutDone(t.account.id), t.s.fetch)).status).toBe(200);
    // the portal changes the price; the plan follows, but nothing is recorded or announced before payment
    sub.items.data[0].price = { id: "price_custom0001", lookup_key: "genclass_custom_monthly" };
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch)).status).toBe(200);
    expect(t.plan().plan).toBe("custom");
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM custom_requests")[0]!.n).toBe(0);
    expect(t.s.other).toHaveLength(0);
    // a paid invoice with only Pro lines (an earlier renewal arriving late) is not the Custom payment
    const proRenewal = { id: "in_pro", object: "invoice", customer: "cus_ada0000001", subscription: "sub_ada0000001", billing_reason: "subscription_cycle", lines: { data: [{ amount: 9900, pricing: { price_details: { price: "price_pro000001" } } }] } };
    expect((await deliver(t.env, stripeEvent("invoice.paid", proRenewal), t.s.fetch)).status).toBe(200);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM custom_requests")[0]!.n).toBe(0);
    // the prorated switch, invoiced at once and paid: now it is a purchase
    const lines = [
      { amount: -9500, pricing: { price_details: { price: "price_pro000001" } } },
      { amount: 57500, pricing: { price_details: { price: "price_custom0001" } } },
    ];
    const upgrade = { id: "in_switch", object: "invoice", customer: "cus_ada0000001", parent: { subscription_details: { subscription: "sub_ada0000001" } }, billing_reason: "subscription_update", lines: { data: lines } };
    expect(invoicePaysCustom(upgrade, sub)).toBe(true);
    expect((await deliver(t.env, stripeEvent("invoice.paid", upgrade), t.s.fetch)).status).toBe(200);
    log.mockRestore();
    expect(t.sql.rows("SELECT subscription_id FROM custom_requests")).toEqual([{ subscription_id: "sub_ada0000001" }]);
    expect(JSON.parse(t.s.other[0]!.body).event).toBe("custom_purchase");
    // the older API shape (line.price) is read too; a zero or credit line is not a payment
    expect(invoicePaysCustom({ lines: { data: [{ amount: 59900, price: { id: "price_custom0001" } }] } }, sub)).toBe(true);
    expect(invoicePaysCustom({ lines: { data: [{ amount: 0, price: { id: "price_custom0001" } }] } }, sub)).toBe(false);
  });

  it("after a price change, subscribers on the replaced price keep their plan (its lookup key moved, its metadata did not)", async () => {
    const t = await paying();
    const sub = t.s.subs.get("sub_ada0000001")!;
    sub.items.data[0].price = { id: "price_old000001", lookup_key: null, active: false, metadata: { genclass_plan: "pro" } };
    const r = await deliver(t.env, stripeEvent("invoice.paid", { id: "in_renew", object: "invoice", customer: "cus_ada0000001", subscription: "sub_ada0000001" }), t.s.fetch);
    expect(r.status).toBe(200);
    expect(t.plan()).toMatchObject({ plan: "pro", subscription_status: "active" });
  });

  it("two subscriptions for one account (two tabs paid): the newest is kept, the other cancelled at once with a credit", async () => {
    const t = await paying();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    t.s.subs.set("sub_ada0000002", subscription("sub_ada0000002", t.account.id, "cus_ada0000001", "genclass_custom_monthly", "active", { created: 1_790_000_100 }));
    // the older one's Checkout is reported first: the newer is still the one kept
    const r = await deliver(t.env, checkoutDone(t.account.id), t.s.fetch);
    log.mockRestore();
    expect(r.status).toBe(200);
    const cancel = t.s.calls.find((c) => c.method === "DELETE")!;
    expect(cancel.url.pathname).toBe("/v1/subscriptions/sub_ada0000001");
    expect(cancel.url.searchParams.get("prorate")).toBe("true");
    expect(cancel.url.searchParams.get("invoice_now")).toBe("true");
    expect(t.s.subs.get("sub_ada0000001")!.status).toBe("canceled");
    expect(t.plan()).toMatchObject({ plan: "custom", subscription_id: "sub_ada0000002" });
    const notice = JSON.parse(t.s.other.find((o) => o.body.includes("duplicate_subscription"))!.body);
    expect(notice).toMatchObject({ event: "duplicate_subscription", account_id: t.account.id, kept: "sub_ada0000002", cancelled: ["sub_ada0000001"] });
    // the cancelled one's own events change nothing
    const ended = await deliver(t.env, stripeEvent("customer.subscription.deleted", t.s.subs.get("sub_ada0000001")!), t.s.fetch);
    expect(await ended.json()).toEqual({ received: true, result: "ignored" });
    expect(t.plan().plan).toBe("custom");
  });

  it("a Checkout naming this account but paid by another Stripe customer is not applied to it", async () => {
    const t = await paying();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    t.s.subs.set("sub_oth0000001", subscription("sub_oth0000001", "Z".repeat(22), "cus_oth0000001", "genclass_custom_monthly"));
    const ev = stripeEvent("checkout.session.completed", { id: "cs_test_other1", mode: "subscription", client_reference_id: t.account.id, customer: "cus_oth0000001", subscription: "sub_oth0000001", payment_status: "paid" });
    const r = await deliver(t.env, ev, t.s.fetch);
    expect(log).toHaveBeenCalledWith(`stripe webhook: checkout.session.completed ${ev.id} ignored: the subscription belongs to another Stripe customer than the account's`);
    log.mockRestore();
    expect(await r.json()).toEqual({ received: true, result: "ignored" });
    expect(t.plan().plan).toBe("free");
    expect(t.sql.rows("SELECT stripe_customer_id FROM accounts")).toEqual([{ stripe_customer_id: "cus_ada0000001" }]);
  });
});

// ------------------------------------------------------------------------------------------------- limits

describe("plans: the Free plan's limits (apps, dashboard ranges)", () => {
  it("a fourth app on Free is refused with a link to upgrade, created or claimed; Pro may add it", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    for (const n of ["a", "b", "c"]) await createApp(env, cookie, n);
    const r = await call(env, "POST", "/api/account/projects", { body: { name: "d" }, cookie });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({
      ok: false,
      error: "the Free plan holds 3 apps; upgrade to Pro for more apps at https://genclass.dev/account/billing",
      upgrade_url: "https://genclass.dev/account/billing",
    });
    const anon = (await (await call(env, "POST", "/api/projects", { body: { name: "Old" }, origin: null })).json()) as any;
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, cookie })).status).toBe(409);
    setPlan(sql, account.id, "pro");
    expect((await call(env, "POST", "/api/account/projects", { body: { name: "d" }, cookie })).status).toBe(201);
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, cookie })).status).toBe(200);
  });

  it("before paid plans are on sale (no STRIPE_SECRET_KEY) accounts keep the limits they had", async () => {
    const { env } = setup();
    const { cookie } = await signedIn(env);
    for (const n of ["a", "b", "c", "d", "e"]) await createApp(env, cookie, n);
  });

  it("ranges: Free shows 24 h and 7 days once on sale; Pro and Custom reach a year; a longer ask gets the longest shown", async () => {
    const free = PLANS[0]!;
    const pro = PLANS[1]!;
    const on = { BUCKET: { async put() {} }, ...LIVE };
    const off = { BUCKET: { async put() {} } };
    expect(viewRanges(on, free)).toEqual(["24h", "7d"]);
    expect(viewRanges(off, free)).toEqual(["24h", "7d", "30d"]);
    expect(viewRanges(on, pro)).toEqual(ACCOUNT_RANGES);
    expect(pickRange("30d", ["24h", "7d"])).toBe("7d");
    expect(pickRange("1y", ["24h", "7d", "30d"])).toBe("30d");
    expect(pickRange(null, ACCOUNT_RANGES)).toBe("7d");
    expect(pickRange("bogus", ["24h", "7d"])).toBe("7d");

    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie);
    const range = async (r: string) => ((await (await call(env, "GET", `/api/account/projects/${app.id}/stats?range=${r}`, { cookie })).json()) as any);
    expect((await range("30d")).range).toBe("7d");
    const page = await (await call(env, "GET", `/account/apps/${app.id}`, { cookie })).text();
    expect(page).toContain('data-r="7d"');
    expect(page).not.toContain('data-r="30d"');
    expect(page).toContain("The Free plan shows 7 days.");
    setPlan(sql, account.id, "pro");
    const year = await range("1y");
    expect(year.range).toBe("1y");
    expect(year.series).toHaveLength(365);
    const proPage = await (await call(env, "GET", `/account/apps/${app.id}`, { cookie })).text();
    expect(proPage).toContain('<button type="button" data-r="1y" aria-pressed="false" aria-label="1 year" title="1 year">1y</button>');
    expect(proPage).toContain("Data is kept 1 year");
    expect(proPage).not.toContain("The Free plan shows");
  });
});

// ------------------------------------------------------------------------------------------------- pages

describe("GET /account/billing", () => {
  it("shows the plan, the plans from plans.json and Upgrade buttons only when paid plans are on sale", async () => {
    const off = setup();
    const a = await signedIn(off.env);
    const html = await (await call(off.env, "GET", "/account/billing", { cookie: a.cookie })).text();
    expect(html).toContain("<h1>Plan and billing</h1>");
    expect(html).toContain("Paid plans are not on sale yet.");
    expect(html).toContain("$99 / month");
    expect(html).toContain("$599 / month");
    expect(html).toContain("Interaction analytics (coming next)");
    expect(html).toContain('Need self-hosting, SSO or invoices? Email <a href="mailto:mehar@daybot.ca">mehar@daybot.ca</a>.');
    expect(html).toContain("never card details");
    expect(html).not.toContain("data-plan=");
    expect(html).not.toContain('id="portal"');

    const on = setup(LIVE);
    const b = await signedIn(on.env);
    const page = await (await call(on.env, "GET", "/account/billing", { cookie: b.cookie })).text();
    expect(page).toContain('data-plan="pro"><span>Upgrade to Pro</span>');
    expect(page).toContain('data-plan="custom"><span>Upgrade to Custom</span>');
    expect(page).toContain("up to 3 apps (you have 0) and 7 days of dashboard history");
    const visible = page.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!doctype html>/gi, "");
    expect(visible).not.toMatch(/\u2014|!/);

    setPlan(on.sql, b.account.id, "pro", { stripe_customer_id: "cus_b000000001", subscription_id: "sub_b000000001", subscription_status: "active", current_period_end: "2026-11-13T12:00:00.000Z", cancel_at_period_end: 1 });
    const paid = await (await call(on.env, "GET", "/account/billing?done=1", { cookie: b.cookie })).text();
    expect(paid).toContain("until <time");
    expect(paid).toContain("It is cancelled and will not renew");
    expect(paid).toContain('data-plan="custom"><span>Switch to Custom</span>');
    expect(paid).toContain('id="portal"');
    expect(paid).toContain("You are on the Pro plan now.");

    expect((await call(on.env, "GET", "/account/billing", {})).headers.get("location")).toBe("/login?next=%2Faccount%2Fbilling");
    // the sidebars link to it
    expect(await (await call(on.env, "GET", "/account", { cookie: b.cookie })).text()).toContain('<a href="/account/billing">Plan and billing</a>');
    const app = await createApp(on.env, b.cookie);
    expect(await (await call(on.env, "GET", `/account/apps/${app.id}`, { cookie: b.cookie })).text()).toContain('<a href="/account/billing">Plan and billing</a>');
  });

  it("?plan from the pricing page survives sign-in and picks that plan's button; back from Checkout there are no buttons", async () => {
    const { env, sql } = setup(LIVE);
    expect((await call(env, "GET", "/account/billing?plan=custom", {})).headers.get("location")).toBe("/login?next=%2Faccount%2Fbilling%3Fplan%3Dcustom");
    expect((await call(env, "GET", "/account/billing?plan=enterprise", {})).headers.get("location")).toBe("/login?next=%2Faccount%2Fbilling");
    const a = await signedIn(env);
    const html = await (await call(env, "GET", "/account/billing?plan=custom", { cookie: a.cookie })).text();
    expect(html).toContain('<div class="plan pick"><h3>Custom</h3>');
    expect(html).toContain('<button class="btn" type="button" data-plan="custom" data-pick><span>Upgrade to Custom</span></button>');
    expect(html).toContain('data-plan="pro"><span>Upgrade to Pro</span>');
    // waiting for Stripe after paying: the plan still reads Free, and no button can start a second purchase
    const waiting = await (await call(env, "GET", "/account/billing?done=1&plan=pro", { cookie: a.cookie })).text();
    expect(waiting).toContain('id="donemsg"');
    expect(waiting).not.toContain("data-plan=");
    setPlan(sql, a.account.id, "pro", { subscription_id: "sub_p000000001", subscription_status: "active", current_period_end: "2026-11-13T12:00:00.000Z" });
    // already on that plan: nothing to pick (the page script's [data-pick] selector is not a button)
    const onPro = await (await call(env, "GET", "/account/billing?plan=pro", { cookie: a.cookie })).text();
    expect(onPro).not.toContain(" data-pick>");
    expect(onPro).not.toContain('class="plan pick"');
  });

  it("GET /api/billing gives the browser its plan; a Custom page says who emails and when", async () => {
    const { env, sql } = setup(LIVE);
    const a = await signedIn(env);
    expect(await (await call(env, "GET", "/api/billing", { cookie: a.cookie })).json()).toEqual({ plan: "free", subscription_status: null, current_period_end: null, cancel_at_period_end: false, on_sale: true });
    setPlan(sql, a.account.id, "custom", { subscription_id: "sub_c000000001", subscription_status: "active", current_period_end: "2026-11-13T12:00:00.000Z" });
    const html = await (await call(env, "GET", "/account/billing", { cookie: a.cookie })).text();
    expect(html).toContain("emails ada@example.com within 1 business day of your purchase");
    expect((await call(env, "GET", "/api/billing", {})).status).toBe(401);
  });
});

// ------------------------------------------------------------------------------------------------- deletion

describe("deleting an account with a paid plan", () => {
  it("cancels the subscription with Stripe first; if Stripe fails, the account stays", async () => {
    const { env, sql } = setup(LIVE);
    const a = await signedIn(env);
    const s = fakeStripe();
    s.subs.set("sub_del0000001", subscription("sub_del0000001", a.account.id, "cus_del0000001", "genclass_pro_monthly"));
    setPlan(sql, a.account.id, "pro", { stripe_customer_id: "cus_del0000001", subscription_id: "sub_del0000001", subscription_status: "active" });
    const failing = await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: a.cookie, fetch: async () => { throw new Error("offline"); } });
    expect(failing.status).toBe(502);
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(1);
    const del = await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: a.cookie, fetch: s.fetch });
    expect(del.status).toBe(204);
    expect(s.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /v1/subscriptions", "DELETE /v1/subscriptions/sub_del0000001"]);
    expect(s.subs.get("sub_del0000001")!.status).toBe("canceled");
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(0);
  });

  it("cancels every subscription the customer has, also one GenClass never recorded (a second one, or a late webhook)", async () => {
    const { env, sql } = setup(LIVE);
    const a = await signedIn(env);
    const s = fakeStripe();
    s.subs.set("sub_rec0000001", subscription("sub_rec0000001", a.account.id, "cus_two0000001", "genclass_pro_monthly"));
    s.subs.set("sub_unr0000001", subscription("sub_unr0000001", a.account.id, "cus_two0000001", "genclass_custom_monthly", "past_due"));
    s.subs.set("sub_old0000001", subscription("sub_old0000001", a.account.id, "cus_two0000001", "genclass_pro_monthly", "canceled"));
    s.subs.set("sub_bob0000001", subscription("sub_bob0000001", "B".repeat(22), "cus_bob0000001", "genclass_pro_monthly"));
    setPlan(sql, a.account.id, "pro", { stripe_customer_id: "cus_two0000001", subscription_id: "sub_rec0000001", subscription_status: "active", stripe_mode: "live" });
    expect((await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: a.cookie, fetch: s.fetch })).status).toBe(204);
    expect(s.calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname).sort()).toEqual(["/v1/subscriptions/sub_rec0000001", "/v1/subscriptions/sub_unr0000001"]);
    expect(s.subs.get("sub_bob0000001")!.status).toBe("active");

    // a payment whose webhook never arrived: no subscription recorded, but the customer is
    const b = await signedIn(env, "late@example.com");
    s.subs.set("sub_late000001", subscription("sub_late000001", b.account.id, "cus_late000001", "genclass_pro_monthly"));
    setPlan(sql, b.account.id, "free", { stripe_customer_id: "cus_late000001", stripe_mode: "live" });
    expect((await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: b.cookie, fetch: s.fetch })).status).toBe(204);
    expect(s.subs.get("sub_late000001")!.status).toBe("canceled");
  });

  it("refuses when payments are switched off but a paid plan is recorded; test-mode records need no Stripe call", async () => {
    const off = setup();
    const a = await signedIn(off.env);
    setPlan(off.sql, a.account.id, "pro", { stripe_customer_id: "cus_off0000001", subscription_id: "sub_off0000001", subscription_status: "active", stripe_mode: "live" });
    const s = fakeStripe();
    const r = await call(off.env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: a.cookie, fetch: s.fetch });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error).toMatch(/payments are switched off on this server, so the account was not deleted; email mehar@daybot.ca/);
    expect(off.sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(1);
    // nothing live recorded (only a customer): deletion goes ahead
    setPlan(off.sql, a.account.id, "free", { subscription_status: "canceled" });
    expect((await call(off.env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: a.cookie, fetch: s.fetch })).status).toBe(204);

    const on = setup(LIVE);
    const t = await signedIn(on.env);
    setPlan(on.sql, t.account.id, "pro", { stripe_customer_id: "cus_tst0000001", subscription_id: "sub_tst0000001", subscription_status: "active", stripe_mode: "test" });
    expect((await call(on.env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: t.cookie, fetch: s.fetch })).status).toBe(204);
    expect(s.calls).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------- Stripe modes

describe("Stripe test and live mode", () => {
  const TESTING = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET_TEST: TEST_SECRET, STRIPE_TEST_ACCOUNTS: "Owner@Example.com, someid" };

  it("the key's prefix says the mode; with a test key only the listed accounts can buy", () => {
    const env = (k?: string, list?: string) => ({ BUCKET: { async put() {} }, STRIPE_SECRET_KEY: k, STRIPE_TEST_ACCOUNTS: list });
    expect(stripeMode(env("sk_live_x"))).toBe("live");
    expect(stripeMode(env("rk_live_x"))).toBe("live");
    expect(stripeMode(env("sk_test_x"))).toBe("test");
    expect(stripeMode(env("pk_live_x"))).toBeNull();
    expect(stripeMode(env())).toBeNull();
    const ada = { id: "someid", email: null };
    expect(canBuy(env("sk_live_x"), { id: "x", email: null })).toBe(true);
    expect(canBuy(env("sk_test_x", "owner@example.com,someid"), ada)).toBe(true);
    expect(canBuy(env("sk_test_x", "owner@example.com"), { id: "x", email: "OWNER@example.com" })).toBe(true);
    expect(canBuy(env("sk_test_x", "owner@example.com"), { id: "x", email: "other@example.com" })).toBe(false);
    expect(canBuy(env("sk_test_x"), ada)).toBe(false);
    expect(canBuy(env(), ada)).toBe(false);
  });

  it("test key on the production worker: the owner can test-buy, nobody else sees buttons or limits", async () => {
    const { env } = setup(TESTING);
    const owner = await signedIn(env, "owner@example.com");
    const other = await signedIn(env, "visitor@example.com");
    const s = fakeStripe();
    expect((await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie: owner.cookie, fetch: s.fetch })).status).toBe(200);
    expect(s.calls[0]!.headers.authorization).toBe("Bearer sk_test_fake");
    const ownerPage = await (await call(env, "GET", "/account/billing", { cookie: owner.cookie })).text();
    expect(ownerPage).toContain("<b>Stripe test mode.</b>");
    expect(ownerPage).toContain('data-plan="pro"');
    expect((await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie: other.cookie, fetch: s.fetch })).status).toBe(503);
    const page = await (await call(env, "GET", "/account/billing", { cookie: other.cookie })).text();
    expect(page).toContain("Paid plans are not on sale yet.");
    expect(page).not.toContain("data-plan=");
    expect(page).not.toContain("Stripe test mode");
    expect(((await (await call(env, "GET", "/api/billing", { cookie: other.cookie })).json()) as any).on_sale).toBe(false);
    // the Free plan's limits wait for the live key
    for (const n of ["a", "b", "c", "d"]) await createApp(env, other.cookie, n);
  });

  it("the webhook takes the test secret with a test key, and ignores (200) the other mode's events after going live", async () => {
    const t = setup({ ...LIVE, STRIPE_WEBHOOK_SECRET_TEST: TEST_SECRET });
    const a = await signedIn(t.env);
    const s = fakeStripe();
    s.subs.set("sub_mix0000001", subscription("sub_mix0000001", a.account.id, "cus_mix0000001", "genclass_pro_monthly"));
    t.sql.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_mix0000001' WHERE id = ?").run(a.account.id);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // signed by the test endpoint while the key is live
    const fromTest = await deliver(t.env, stripeEvent("customer.subscription.updated", s.subs.get("sub_mix0000001")!), s.fetch, { secret: TEST_SECRET });
    expect(await fromTest.json()).toEqual({ received: true, result: "ignored" });
    // signed with the live secret but a test-mode event
    const testEvent = stripeEvent("customer.subscription.updated", s.subs.get("sub_mix0000001")!, undefined, { livemode: false });
    expect(await (await deliver(t.env, testEvent, s.fetch)).json()).toEqual({ received: true, result: "ignored" });
    expect(s.calls).toEqual([]);
    expect(t.sql.rows("SELECT plan FROM accounts")).toEqual([{ plan: "free" }]);
    // a live event applies
    const liveEvent = stripeEvent("customer.subscription.updated", s.subs.get("sub_mix0000001")!, undefined, { livemode: true });
    expect(await (await deliver(t.env, liveEvent, s.fetch)).json()).toEqual({ received: true, result: "applied" });
    log.mockRestore();
    // neither secret: 400
    expect((await deliver(t.env, liveEvent, s.fetch, { secret: "whsec_nobody" })).status).toBe(400);
    // with a test key the test secret is the one checked
    const tm = setup(TESTING);
    expect((await deliver(tm.env, stripeEvent("customer.created", { id: "cus_1" }), s.fetch, { secret: TEST_SECRET })).status).toBe(200);
    expect((await deliver(tm.env, stripeEvent("customer.created", { id: "cus_1" }), s.fetch, { secret: WEBHOOK_SECRET })).status).toBe(400);
  });

  it("a plan bought in test mode does not carry over once the key is live, and that account can buy for real", async () => {
    const { env, sql } = setup(LIVE);
    const a = await signedIn(env);
    setPlan(sql, a.account.id, "custom", { stripe_customer_id: "cus_tst0000009", subscription_id: "sub_tst0000009", subscription_status: "active", stripe_mode: "test" });
    expect(((await (await call(env, "GET", "/api/billing", { cookie: a.cookie })).json()) as any).plan).toBe("free");
    const app = await createApp(env, a.cookie);
    expect(((await (await call(env, "GET", `/api/account/projects/${app.id}/stats?range=30d`, { cookie: a.cookie })).json()) as any).range).toBe("7d");
    expect((await call(env, "GET", `/api/account/projects/${app.id}/events`, { cookie: a.cookie })).status).toBe(403);
    // Upgrade: a new live customer replaces the test one (whose plan goes with it)
    const s = fakeStripe();
    expect((await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie: a.cookie, fetch: s.fetch })).status).toBe(200);
    expect(s.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["POST /v1/customers", "GET /v1/prices", "POST /v1/checkout/sessions"]);
    expect(s.calls[0]!.headers["idempotency-key"]).toBe(`genclass-customer-${a.account.id}-after-cus_tst0000009`);
    expect(sql.rows("SELECT plan, stripe_customer_id, stripe_mode, subscription_id FROM accounts")).toEqual([{ plan: "free", stripe_customer_id: "cus_test0001", stripe_mode: "live", subscription_id: null }]);
  });

  it("a test key never touches an account that pays in live mode", async () => {
    const { env, sql } = setup({ ...TESTING, STRIPE_TEST_ACCOUNTS: "ada@example.com" });
    const a = await signedIn(env);
    setPlan(sql, a.account.id, "pro", { stripe_customer_id: "cus_liv0000001", subscription_id: "sub_liv0000001", subscription_status: "active", stripe_mode: "live" });
    const s = fakeStripe();
    const r = await call(env, "POST", "/api/billing/checkout", { body: { plan: "custom" }, cookie: a.cookie, fetch: s.fetch });
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toMatch(/pays in Stripe's live mode/);
    expect(s.calls).toEqual([]);
    // its live plan is untouched and still counts under the test key (live records always count)
    expect(sql.rows("SELECT plan, stripe_customer_id FROM accounts")).toEqual([{ plan: "pro", stripe_customer_id: "cus_liv0000001" }]);
    expect(((await (await call(env, "GET", "/api/billing", { cookie: a.cookie })).json()) as any).plan).toBe("pro");
  });
});

// ------------------------------------------------------------------------------------------------- migration

describe("migration 0004 on a database that already has accounts and apps", () => {
  it("existing accounts start on Free with no Stripe ids; their apps and dashboards are untouched", async () => {
    const { d1 } = await import("./d1.js");
    const sql = d1({
      before: "0004",
      seed: (db) => {
        db.prepare("INSERT INTO accounts (id, email, created) VALUES (?, ?, ?)").run("A".repeat(22), "old@example.com", "2026-10-12T00:00:00.000Z");
        db.prepare("INSERT INTO projects (id, token, secret_hash, name, created, account_id, private_link) VALUES (?, ?, ?, ?, ?, ?, 0)").run("0123456789abcdef", `gc_${"O".repeat(22)}`, "h", "Old app", "2026-10-12T00:00:00.000Z", "A".repeat(22));
        db.prepare("INSERT INTO daily (token, day, metric, key, count) VALUES (?, '2026-10-12', 'sessions', '', 3)").run(`gc_${"O".repeat(22)}`);
      },
    });
    expect(sql.rows("SELECT plan, stripe_customer_id, subscription_id, subscription_status, current_period_end, cancel_at_period_end FROM accounts")).toEqual([
      { plan: "free", stripe_customer_id: null, subscription_id: null, subscription_status: null, current_period_end: null, cancel_at_period_end: 0 },
    ]);
    expect(sql.rows("SELECT name, account_id FROM projects")).toEqual([{ name: "Old app", account_id: "A".repeat(22) }]);
    expect(sql.rows("SELECT count FROM daily")).toEqual([{ count: 3 }]);
    for (const t of ["billing_events", "custom_requests", "integrations", "forward_log", "event_batches", "export_keys"]) expect(sql.rows(`SELECT COUNT(*) AS n FROM ${t}`)[0]!.n).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import PLANS_JSON from "../../billing/plans.json";
import { resetTokenCache } from "../src/dashboard.js";
import { resetOwnerCache } from "../src/paid.js";
import { ACCOUNT_RANGES, canBuy, PAST_DUE_GRACE_DAYS, PLANS, pickRange, planByLookupKey, planForPrice, planRetention, priceText, stripeMode, viewRanges } from "../src/plans.js";
import { form, invoicePaysCustom, invoiceSubscription, isGenClassSubscription, latestInvoicePaysCustom, resetStripeCache, sharedCustomer, STRIPE_VERSION, subscriptionState, verifySignature, WEBHOOK_EVENTS } from "../src/stripe.js";
import {
  advance,
  call,
  cliToken,
  createApp,
  deliver,
  fakeStripe,
  GENCLASS_PORTAL,
  invoice,
  refusingLimiter,
  resetClock,
  setPlan,
  setup,
  signedIn,
  stripeEvent,
  subscription,
  WEBHOOK_SECRET,
  now,
  price,
} from "./account-helpers.js";

// Paid plans (src/plans.ts, src/stripe.ts, src/billing.ts): billing/plans.json, the Stripe webhook (signature,
// idempotency, plan from the subscription), Checkout and the Billing Portal with fetch mocked, CSRF, the Free plan's
// limits, the dashboard ranges per plan, the billing page, and account deletion with a live subscription.

// a live-mode key: paid plans on sale to everyone, the Free plan's limits on (fetch is always the fake below)
const LIVE = { STRIPE_SECRET_KEY: "sk_live_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PORTAL_CONFIGURATION: GENCLASS_PORTAL };
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
  it("checkout: a GenClass customer is created once with the account's email, then a subscription session by lookup_key", async () => {
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
    expect(prices!.url.searchParams.get("expand[0]")).toBe("data.product");
    // GenClass's own customer, marked as such: never one found by email (the Stripe account is shared with Polar Parts)
    expect(Object.fromEntries(customer!.form!)).toEqual({ email: "ada@example.com", description: "GenClass account", "metadata[genclass]": "1", "metadata[genclass_account]": account.id });
    expect(customer!.headers["idempotency-key"]).toBe(`genclass-customer-${account.id}`);
    expect(Object.fromEntries(session!.form!)).toMatchObject({
      mode: "subscription",
      customer: "cus_test0001",
      client_reference_id: account.id,
      "line_items[0][price]": "price_pro000001",
      "line_items[0][quantity]": "1",
      success_url: "https://genclass.dev/account/billing?done=1",
      cancel_url: "https://genclass.dev/account/billing",
      "metadata[genclass]": "1",
      "metadata[genclass_account]": account.id,
      "metadata[genclass_plan]": "pro",
      "subscription_data[metadata][genclass]": "1",
      "subscription_data[metadata][genclass_account]": account.id,
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
    // the stored customer is checked first: it must be the account's own GenClass customer
    expect(s.calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      "GET /v1/customers/cus_test0001",
      "GET /v1/subscriptions",
      "GET /v1/checkout/sessions",
      "POST /v1/checkout/sessions/cs_test_000001/expire",
      "GET /v1/prices",
      "POST /v1/checkout/sessions",
    ]);
    expect(s.calls[1]!.url.searchParams.get("customer")).toBe("cus_test0001");
    expect(s.calls[1]!.url.searchParams.get("status")).toBe("all");
    expect(s.calls[2]!.url.searchParams.get("status")).toBe("open");
    expect(s.sessions.get("cs_test_000001")!.status).toBe("expired");
    const made = s.calls[5]!;
    expect(made.form!.get("line_items[0][price]")).toBe("price_custom0001");
    expect(made.form!.get("customer")).toBe("cus_test0001");
    // after closing a page the idempotency key changes, so Stripe cannot hand back the page it just closed
    expect(made.headers["idempotency-key"]).toMatch(new RegExp(`^genclass-checkout-${account.id}-custom-\\d+-after-[0-9a-f]{16}$`));

    // a second click on Custom (or a second tab) gets the same open page, not a second one
    s.calls.length = 0;
    const third = await call(env, "POST", "/api/billing/checkout", { body: { plan: "custom" }, cookie, fetch: s.fetch });
    expect(await third.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_000002" });
    expect(s.calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual(["GET /v1/customers/cus_test0001", "GET /v1/subscriptions", "GET /v1/checkout/sessions"]);
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

  it("portal: a session for the account's checked customer, with GenClass's own configuration, never the account's default", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    setPlan(sql, account.id, "pro", { stripe_customer_id: "cus_known0001", subscription_id: "sub_known0001", subscription_status: "active" });
    const s = fakeStripe();
    s.genclassCustomer("cus_known0001", account.id);
    s.subs.set("sub_known0001", subscription("sub_known0001", account.id, "cus_known0001", "genclass_pro_monthly", "active", { latest_invoice: "in_known0001" }));
    s.invoices.set("in_known0001", invoice("in_known0001", "cus_known0001", "sub_known0001", [["price_pro000001", 9900]]));
    const r = await call(env, "POST", "/api/billing/portal", { body: {}, cookie, fetch: s.fetch });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: "https://billing.stripe.com/p/session/test_000001" });
    // the customer, everything on it, then GenClass's configuration by its id (no configuration is listed)
    expect(s.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "GET /v1/customers/cus_known0001",
      "GET /v1/subscriptions",
      "GET /v1/invoices",
      `GET /v1/billing_portal/configurations/${GENCLASS_PORTAL}`,
      "POST /v1/billing_portal/sessions",
    ]);
    const sess = s.calls.find((c) => c.url.pathname === "/v1/billing_portal/sessions")!;
    expect(Object.fromEntries(sess.form!)).toEqual({ customer: "cus_known0001", return_url: "https://genclass.dev/account/billing", configuration: GENCLASS_PORTAL });
  });

  it("a paying account asking for the other plan is sent to the portal's plan change, never into a second subscription", async () => {
    const { env, sql } = setup(LIVE);
    const { cookie, account } = await signedIn(env);
    setPlan(sql, account.id, "pro", { stripe_customer_id: "cus_known0001", subscription_id: "sub_known0001", subscription_status: "active", stripe_mode: "live" });
    const s = fakeStripe();
    s.genclassCustomer("cus_known0001", account.id);
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
    s.genclassCustomer("cus_late000001", account.id);
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
    // the fake has no such customer: GET /v1/customers/cus_gone000001 answers 404 resource_missing
    const s = fakeStripe();
    const r = await call(env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie, fetch: s.fetch });
    expect(r.status).toBe(200);
    expect(s.calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual(["GET /v1/customers/cus_gone000001", "POST /v1/customers", "GET /v1/prices", "POST /v1/checkout/sessions"]);
    expect(s.calls[1]!.headers["idempotency-key"]).toBe(`genclass-customer-${account.id}-after-cus_gone000001`);
    expect(sql.rows("SELECT stripe_customer_id, stripe_mode FROM accounts")).toEqual([{ stripe_customer_id: "cus_test0001", stripe_mode: "live" }]);

    setPlan(sql, account.id, "pro", { stripe_customer_id: "cus_gone000002", subscription_id: "sub_gone000002", subscription_status: "active", stripe_mode: "live" });
    const p = fakeStripe();
    const pr = await call(env, "POST", "/api/billing/portal", { body: {}, cookie, fetch: p.fetch });
    expect(pr.status).toBe(409);
    expect(sql.rows("SELECT plan, stripe_customer_id, subscription_id FROM accounts")).toEqual([{ plan: "free", stripe_customer_id: null, subscription_id: null }]);
    expect(p.calls.some((c) => c.url.pathname === "/v1/billing_portal/sessions")).toBe(false);
    // ... also when the customer goes missing between the check and the session
    setPlan(sql, account.id, "pro", { stripe_customer_id: "cus_gone000003", subscription_id: null, subscription_status: null, stripe_mode: "live" });
    const q = fakeStripe({ answer: (u) => (u.pathname === "/v1/billing_portal/sessions" ? missing() : undefined) });
    q.genclassCustomer("cus_gone000003", account.id);
    expect((await call(env, "POST", "/api/billing/portal", { body: {}, cookie, fetch: q.fetch })).status).toBe(409);
    expect(sql.rows("SELECT stripe_customer_id FROM accounts")).toEqual([{ stripe_customer_id: null }]);
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
    t.sql.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_ada0000001', stripe_mode = 'live' WHERE id = ?").run(a.account.id);
    s.genclassCustomer("cus_ada0000001", a.account.id);
    s.subs.set("sub_ada0000001", subscription("sub_ada0000001", a.account.id, "cus_ada0000001", planKey));
    const plan = () => t.sql.rows("SELECT plan, subscription_id, subscription_status, current_period_end, cancel_at_period_end FROM accounts")[0]!;
    return { ...t, ...a, s, plan };
  }
  // what Stripe sends when GenClass's Checkout has started the subscription
  const subscribed = (t: { s: ReturnType<typeof fakeStripe> }) => stripeEvent("customer.subscription.created", t.s.subs.get("sub_ada0000001")!);

  it("customer.subscription.created: Pro, from the subscription's lookup key; the same event again changes nothing", async () => {
    const t = await paying();
    const ev = subscribed(t);
    const r = await deliver(t.env, ev, t.s.fetch);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: true, result: "applied" });
    expect(t.plan()).toEqual({ plan: "pro", subscription_id: "sub_ada0000001", subscription_status: "active", current_period_end: new Date(1_792_000_000_000).toISOString(), cancel_at_period_end: 0 });
    // the subscription (with its prices' products, its customer and its latest invoice), then the customer's
    // subscriptions (one subscription per account)
    expect(t.s.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /v1/subscriptions/sub_ada0000001", "GET /v1/subscriptions"]);
    expect(t.s.calls[0]!.url.searchParams.get("expand[0]")).toBe("items.data.price.product");
    expect(t.s.calls[0]!.url.searchParams.get("expand[1]")).toBe("customer");
    expect(t.s.calls[0]!.url.searchParams.get("expand[2]")).toBe("latest_invoice");
    expect(t.s.calls[1]!.url.searchParams.get("expand[0]")).toBe("data.items.data.price.product");
    expect(t.sql.rows("SELECT stripe_mode FROM accounts")).toEqual([{ stripe_mode: "live" }]);
    expect(t.sql.rows("SELECT id, type FROM billing_events")).toEqual([{ id: ev.id, type: "customer.subscription.created" }]);
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
    // a failed renewal: past_due keeps Pro while Stripe retries (for 14 days at most: the past-due tests below)
    sub.status = "past_due";
    expect(await send("customer.subscription.updated", sub)).toMatchObject({ plan: "pro", subscription_status: "past_due" });
    // paid after all (no invoice event: the status change arrives as customer.subscription.updated)
    sub.status = "active";
    expect(await send("customer.subscription.updated", sub)).toMatchObject({ plan: "pro", subscription_status: "active" });
    // switched to Custom in the portal
    sub.items.data[0].price = price("genclass_custom_monthly");
    expect((await send("customer.subscription.updated", sub)).plan).toBe("custom");
    sub.status = "unpaid";
    expect(await send("customer.subscription.updated", sub)).toMatchObject({ plan: "free", subscription_status: "unpaid" });
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
    // a price the setup script replaced keeps its product and gets a genclass_..._retired_ key: its subscribers keep the plan
    const retired = price("genclass_pro_monthly_retired_price_old000001", { id: "price_old000001", plan: "pro" });
    expect(subscriptionState({ ...base, items: { data: [{ price: retired }] } })).toMatchObject({ plan: "pro", priced: "pro", lookupKey: "genclass_pro_monthly_retired_price_old000001" });
    // provably GenClass's only: a genclass_ lookup key AND a product with metadata genclass_plan naming a paid plan
    expect(planForPrice(price("genclass_custom_monthly"))?.id).toBe("custom");
    expect(planForPrice({ ...price("genclass_pro_monthly"), product: "genclass_pro" })).toBeNull(); // product not expanded
    expect(planForPrice(price("genclass_pro_monthly", { plan: null }))).toBeNull(); // a product without the metadata
    expect(planForPrice(price("polar_box_monthly", { plan: "pro" }))).toBeNull(); // not a GenClass lookup key
    expect(planForPrice({ id: "price_1", lookup_key: null, metadata: { genclass_plan: "pro" }, product: { metadata: { genclass_plan: "pro" } } })).toBeNull();
    expect(planForPrice(price("genclass_pro_monthly", { plan: "custom" }))).toBeNull(); // the key and the product disagree
    // metadata can only name a paid plan in plans.json
    expect(planForPrice(price("genclass_free", { plan: "free" }))).toBeNull();
    expect(planForPrice(price("genclass_enterprise", { plan: "enterprise" }))).toBeNull();
    for (const p of PLANS) for (const k of Object.values(p.stripe_lookup_keys)) if (k) expect(k.startsWith("genclass_")).toBe(true);
    // every price must be GenClass's for the subscription to be
    expect(isGenClassSubscription(base)).toBe(true);
    expect(isGenClassSubscription({ ...base, items: { data: [...base.items.data, { price: price("polar_box_monthly") }] } })).toBe(false);
    expect(isGenClassSubscription({ ...base, items: { data: [] } })).toBe(false);
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
    // subscription events only: they carry no buyer's name, email or address (Checkout, invoice, charge and customer
    // events do, for Polar Parts' orders too, so the endpoint takes none of them)
    expect(WEBHOOK_EVENTS).toEqual(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);
  });

  it("an older subscription ending does not downgrade an account that has a newer live one", async () => {
    const t = await paying();
    setPlan(t.sql, t.account.id, "pro", { subscription_id: "sub_new0000001", subscription_status: "active" });
    t.s.subs.set("sub_old0000001", subscription("sub_old0000001", t.account.id, "cus_ada0000001", "genclass_pro_monthly", "canceled"));
    const r = await deliver(t.env, stripeEvent("customer.subscription.deleted", t.s.subs.get("sub_old0000001")!), t.s.fetch);
    expect(await r.json()).toEqual({ received: true, result: "ignored" });
    expect(t.plan()).toMatchObject({ plan: "pro", subscription_id: "sub_new0000001" });
  });

  it("events for a customer GenClass does not know are logged by type and id and ignored, with no Stripe call", async () => {
    const t = await paying();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    t.s.subs.set("sub_zzz0000001", subscription("sub_zzz0000001", "Z".repeat(22), "cus_zzz0000001", "genclass_pro_monthly"));
    const ev = stripeEvent("customer.subscription.updated", t.s.subs.get("sub_zzz0000001")!);
    const r = await deliver(t.env, ev, t.s.fetch);
    expect(await r.json()).toEqual({ received: true, result: "ignored" });
    expect(log).toHaveBeenCalledWith(`stripe webhook: customer.subscription.updated ${ev.id} ignored: not a GenClass customer`);
    expect(t.s.calls).toEqual([]);
    log.mockRestore();
    expect(t.plan().plan).toBe("free");
    expect((await deliver(t.env, stripeEvent("customer.created", { id: "cus_1" }), t.s.fetch)).status).toBe(200);
  });

  it("refuses a bad signature, an old timestamp and unconfigured servers; records nothing", async () => {
    const t = await paying();
    const ev = subscribed(t);
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
    const ev = subscribed(t);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await deliver(t.env, ev, async () => { throw new Error("offline"); });
    log.mockRestore();
    expect(r.status).toBe(500);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM billing_events")[0]!.n).toBe(0);
    expect((await deliver(t.env, ev, t.s.fetch)).status).toBe(200);
    expect(t.plan().plan).toBe("pro");
  });

  it("a Custom purchase is recorded once, when the subscription's latest invoice is paid, and the owner is notified with ids only", async () => {
    const t = await paying("genclass_custom_monthly");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sub = t.s.subs.get("sub_ada0000001")!;
    // Checkout made the subscription; its first invoice is not paid yet: Custom is not bought yet
    t.s.invoices.set("in_ada0000001", invoice("in_ada0000001", "cus_ada0000001", "sub_ada0000001", [["price_custom0001", 59900]], "open"));
    sub.latest_invoice = "in_ada0000001";
    sub.status = "incomplete";
    expect((await deliver(t.env, stripeEvent("customer.subscription.created", sub), t.s.fetch)).status).toBe(200);
    expect(t.plan().plan).toBe("free");
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM custom_requests")[0]!.n).toBe(0);
    // paid: Stripe moves the subscription to active (customer.subscription.updated, its status changed)
    t.s.invoices.get("in_ada0000001")!.status = "paid";
    sub.status = "active";
    const paid = stripeEvent("customer.subscription.updated", sub, undefined, {});
    (paid.data as any).previous_attributes = { status: "incomplete" };
    expect((await deliver(t.env, paid, t.s.fetch)).status).toBe(200);
    // and again (a renewal, a redelivered change): still one purchase, one notice
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch)).status).toBe(200);
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
    t.s.invoices.set("in_pro", invoice("in_pro", "cus_ada0000001", "sub_ada0000001", [["price_pro000001", 9900]]));
    sub.latest_invoice = "in_pro";
    expect((await deliver(t.env, subscribed(t), t.s.fetch)).status).toBe(200);
    // the portal changes the price and invoices the prorated switch at once; until it is paid nothing is recorded
    sub.items.data[0].price = price("genclass_custom_monthly");
    t.s.invoices.set("in_switch", invoice("in_switch", "cus_ada0000001", "sub_ada0000001", [["price_pro000001", -9500], ["price_custom0001", 57500]], "open"));
    sub.latest_invoice = "in_switch";
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch)).status).toBe(200);
    expect(t.plan().plan).toBe("custom");
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM custom_requests")[0]!.n).toBe(0);
    expect(t.s.other).toHaveLength(0);
    // a paid invoice with only Pro lines (the previous renewal) is not the Custom payment
    sub.latest_invoice = "in_pro";
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch)).status).toBe(200);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM custom_requests")[0]!.n).toBe(0);
    // the switch paid: now it is a purchase
    t.s.invoices.get("in_switch")!.status = "paid";
    sub.latest_invoice = "in_switch";
    expect(invoicePaysCustom(t.s.invoices.get("in_switch")!, sub)).toBe(true);
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch)).status).toBe(200);
    log.mockRestore();
    expect(t.sql.rows("SELECT subscription_id FROM custom_requests")).toEqual([{ subscription_id: "sub_ada0000001" }]);
    expect(JSON.parse(t.s.other[0]!.body).event).toBe("custom_purchase");
    // the older API shape (line.price) is read too; a zero or credit line is not a payment
    expect(invoicePaysCustom({ lines: { data: [{ amount: 59900, price: { id: "price_custom0001" } }] } }, sub)).toBe(true);
    expect(invoicePaysCustom({ lines: { data: [{ amount: 0, price: { id: "price_custom0001" } }] } }, sub)).toBe(false);
    // the latest invoice must be paid, expanded, and the subscription's own
    const paidSwitch = t.s.invoices.get("in_switch")!;
    expect(latestInvoicePaysCustom({ ...sub, latest_invoice: paidSwitch })).toBe(true);
    expect(latestInvoicePaysCustom({ ...sub, latest_invoice: "in_switch" })).toBe(false);
    expect(latestInvoicePaysCustom({ ...sub, latest_invoice: { ...paidSwitch, status: "open" } })).toBe(false);
    expect(latestInvoicePaysCustom({ ...sub, latest_invoice: { ...paidSwitch, parent: { subscription_details: { subscription: "sub_other00001" } } } })).toBe(false);
  });

  it("invoice and Checkout events are not GenClass's to handle: even GenClass's own are ignored, unfetched and unstored", async () => {
    const t = await paying("genclass_custom_monthly");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const own = [
      stripeEvent("checkout.session.completed", { id: "cs_test_000001", mode: "subscription", metadata: { genclass: "1", genclass_account: t.account.id, genclass_plan: "custom" }, customer: "cus_ada0000001", subscription: "sub_ada0000001", payment_status: "paid" }),
      stripeEvent("invoice.paid", invoice("in_ada0000001", "cus_ada0000001", "sub_ada0000001", [["price_custom0001", 59900]])),
    ];
    for (const ev of own) {
      expect(await (await deliver(t.env, ev, t.s.fetch)).json()).toEqual({ received: true, result: "ignored" });
      expect(log).toHaveBeenCalledWith(`stripe webhook: ${ev.type} ${ev.id} ignored: event type not handled`);
    }
    log.mockRestore();
    expect(t.s.calls).toEqual([]);
    expect(t.plan().plan).toBe("free");
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM billing_events")[0]!.n).toBe(0);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM custom_requests")[0]!.n).toBe(0);
  });

  it("after a price change, subscribers on the replaced price keep their plan (a retired genclass_ key, the same product)", async () => {
    const t = await paying();
    const sub = t.s.subs.get("sub_ada0000001")!;
    sub.items.data[0].price = { ...price("genclass_pro_monthly_retired_price_old000001", { id: "price_old000001", plan: "pro" }), active: false };
    const r = await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch);
    expect(r.status).toBe(200);
    expect(t.plan()).toMatchObject({ plan: "pro", subscription_status: "active" });
  });

  it("two subscriptions for one account (two tabs paid): the newest is kept, the other cancelled at once with a credit", async () => {
    const t = await paying();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    t.s.subs.set("sub_ada0000002", subscription("sub_ada0000002", t.account.id, "cus_ada0000001", "genclass_custom_monthly", "active", { created: 1_790_000_100 }));
    // the older one's start is reported first: the newer is still the one kept
    const r = await deliver(t.env, subscribed(t), t.s.fetch);
    log.mockRestore();
    expect(r.status).toBe(200);
    const cancel = t.s.calls.find((c) => c.method === "DELETE")!;
    expect(cancel.url.pathname).toBe("/v1/subscriptions/sub_ada0000001");
    expect(cancel.url.searchParams.get("prorate")).toBe("true");
    expect(cancel.url.searchParams.get("invoice_now")).toBe("true");
    expect(t.s.subs.get("sub_ada0000001")!.status).toBe("canceled");
    expect(t.plan()).toMatchObject({ plan: "custom", subscription_id: "sub_ada0000002" });
    const notice = JSON.parse(t.s.other.find((o) => o.body.includes("duplicate_subscription"))!.body);
    expect(notice).toMatchObject({ event: "duplicate_subscription", account_id: t.account.id, kept: "sub_ada0000002", cancelled: ["sub_ada0000001"], credited: true });
    // the cancelled one's own events change nothing
    const ended = await deliver(t.env, stripeEvent("customer.subscription.deleted", t.s.subs.get("sub_ada0000001")!), t.s.fetch);
    expect(await ended.json()).toEqual({ received: true, result: "ignored" });
    expect(t.plan().plan).toBe("custom");
    // a plain update (no status change) does not look for duplicates
    t.s.calls.length = 0;
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", t.s.subs.get("sub_ada0000002")!), t.s.fetch)).status).toBe(200);
    expect(t.s.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /v1/subscriptions/sub_ada0000002"]);
  });

  it("a subscription event for another Stripe customer is not applied to the account, whatever its metadata says", async () => {
    const t = await paying();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // a subscription naming this account in its metadata, on a customer the accounts table does not name
    t.s.subs.set("sub_oth0000001", { ...subscription("sub_oth0000001", t.account.id, "cus_oth0000001", "genclass_custom_monthly") });
    const ev = stripeEvent("customer.subscription.created", t.s.subs.get("sub_oth0000001")!);
    const r = await deliver(t.env, ev, t.s.fetch);
    expect(log).toHaveBeenCalledWith(`stripe webhook: customer.subscription.created ${ev.id} ignored: not a GenClass customer`);
    log.mockRestore();
    expect(await r.json()).toEqual({ received: true, result: "ignored" });
    expect(t.s.calls).toEqual([]);
    expect(t.plan().plan).toBe("free");
    expect(t.sql.rows("SELECT stripe_customer_id FROM accounts")).toEqual([{ stripe_customer_id: "cus_ada0000001" }]);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM billing_events")[0]!.n).toBe(0);
  });

  it("past_due keeps the plan 14 days from when GenClass first saw it, then Free, whatever the account's retry settings", async () => {
    const t = await paying();
    const sub = t.s.subs.get("sub_ada0000001")!;
    const state = () => t.sql.rows("SELECT plan, subscription_status, past_due_since FROM accounts")[0]!;
    const DAY = 86_400_000;
    expect(PAST_DUE_GRACE_DAYS).toBe(14);
    expect((await deliver(t.env, subscribed(t), t.s.fetch)).status).toBe(200);
    const first = now().toISOString();
    sub.status = "past_due";
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch)).status).toBe(200);
    expect(state()).toEqual({ plan: "pro", subscription_status: "past_due", past_due_since: first });
    // a retry fails 10 days later: still Pro, and the grace still counts from the first time
    advance(10 * DAY);
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch)).status).toBe(200);
    expect(state()).toEqual({ plan: "pro", subscription_status: "past_due", past_due_since: first });
    await planRetention(t.sql.api, now());
    expect(state().plan).toBe("pro");
    // day 15 with no event at all (the shared account may leave the subscription past due for good): the daily sweep
    advance(5 * DAY);
    await planRetention(t.sql.api, now());
    expect(state()).toEqual({ plan: "free", subscription_status: "past_due", past_due_since: first });
    // an event after the grace keeps it Free
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch)).status).toBe(200);
    expect(state().plan).toBe("free");
    // the page says why, and Upgrade asks for the open payment instead of a second subscription
    const page = await (await call(t.env, "GET", "/account/billing", { cookie: t.cookie })).text();
    expect(page).toContain("The last payment for your paid plan did not go through, so it has ended.");
    expect(page).toContain('id="portal"');
    const again = await call(t.env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie: t.cookie, fetch: t.s.fetch });
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error).toBe("the last payment for your Pro plan did not go through; update your card in Manage billing to pay it, or email mehar@daybot.ca");
    expect(t.s.calls.some((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions")).toBe(false);
    // paid after all: Pro again, and the next failure starts a new grace
    sub.status = "active";
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch)).status).toBe(200);
    expect(state()).toEqual({ plan: "pro", subscription_status: "active", past_due_since: null });
    sub.status = "past_due";
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch)).status).toBe(200);
    expect(state().past_due_since).toBe(now().toISOString());
    const proPage = await (await call(t.env, "GET", "/account/billing", { cookie: t.cookie })).text();
    expect(proPage).toContain("if it is still unpaid 14 days after the failed payment, the account moves to the Free plan");
    advance(13 * DAY);
    await planRetention(t.sql.api, now());
    expect(state().plan).toBe("pro");
    // unpaid (the account's retry setting may say "mark as unpaid") is Free at once, and the sweep catches it too
    sub.status = "unpaid";
    expect((await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch)).status).toBe(200);
    expect(state()).toEqual({ plan: "free", subscription_status: "unpaid", past_due_since: null });
    t.sql.db.prepare("UPDATE accounts SET plan = 'pro'").run();
    await planRetention(t.sql.api, now());
    expect(state().plan).toBe("free");
  });

  it("subscriptionState: past_due past its grace gives Free", () => {
    const sub = subscription("sub_x00000001", "a".repeat(22), "cus_x00000001", "genclass_pro_monthly", "past_due");
    const at = new Date("2026-10-30T00:00:00Z");
    expect(subscriptionState(sub, { pastDueSince: "2026-10-16T00:00:00.000Z", now: at }).plan).toBe("pro");
    expect(subscriptionState(sub, { pastDueSince: "2026-10-15T23:59:59.000Z", now: at }).plan).toBe("free");
    expect(subscriptionState(sub).plan).toBe("pro");
  });
});

// ------------------------------------------------------------------------------------------------- shared account

describe("shared Stripe account (daybot.ca, also Polar Parts): GenClass touches only its own objects", () => {
  // Polar Parts sells in the same Stripe account: its customers (one has the same email as a GenClass account), its
  // orders, subscriptions and invoices. None of it may change a plan, be fetched from Stripe, or be stored or logged
  // beyond an event's id and type.
  const POLAR = "cus_polar0000001";
  const polarCustomer = { id: POLAR, object: "customer", email: "ada@example.com", name: "Ada Lovelace", phone: "+14165550100", address: { line1: "1 Polar Way", city: "Toronto" }, metadata: { polar_id: "7781" } };
  const PRIVATE = [POLAR, "ada@example.com", "Ada Lovelace", "Polar Way", "4165550100", "PP-1001", "sub_polar0000001", "in_polar0000001", "price_polar0000001"];
  const polarSub = (status = "active") => ({
    id: "sub_polar0000001",
    object: "subscription",
    customer: POLAR,
    status,
    created: 1_790_000_000,
    metadata: { order: "PP-1001" },
    cancel_at_period_end: false,
    items: { data: [{ id: "si_polar0000001", current_period_end: 1_792_000_000, price: { id: "price_polar0000001", object: "price", lookup_key: "polar_tires_monthly", product: "prod_polar0000001" } }] },
  });
  const polarInvoice = (sub: string | null) => ({
    id: "in_polar0000001",
    object: "invoice",
    customer: POLAR,
    customer_email: "ada@example.com",
    customer_name: "Ada Lovelace",
    customer_address: { line1: "1 Polar Way", city: "Toronto" },
    parent: sub ? { subscription_details: { subscription: sub, metadata: { order: "PP-1001" } } } : null,
    lines: { data: [{ amount: 18900, pricing: { price_details: { price: "price_polar0000001" } } }] },
  });

  async function shop(over: Record<string, unknown> = {}) {
    const t = setup({ ...LIVE, NOTIFY_WEBHOOK: "https://hooks.example.com/notify", ...over });
    const a = await signedIn(t.env); // ada@example.com, like the Polar Parts customer
    const s = fakeStripe();
    s.customers.set(POLAR, structuredClone(polarCustomer));
    s.subs.set("sub_polar0000001", polarSub());
    const state = () => t.sql.rows("SELECT plan, stripe_customer_id, subscription_id, subscription_status, past_due_since FROM accounts");
    return { ...t, ...a, s, state };
  }

  /** Polar Parts' webhook traffic, as GenClass's endpoint receives it for the whole account. */
  const polarEvents = (accountId: string) => [
    // a one-time order
    stripeEvent("checkout.session.completed", {
      id: "cs_live_polar00001",
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      client_reference_id: "PP-1001",
      customer: POLAR,
      customer_details: { email: "ada@example.com", name: "Ada Lovelace", phone: "+14165550100", address: { line1: "1 Polar Way" } },
      metadata: { order: "PP-1001" },
    }),
    // a Polar Parts subscription bought through Checkout
    stripeEvent("checkout.session.completed", { id: "cs_live_polar00002", object: "checkout.session", mode: "subscription", payment_status: "paid", customer: POLAR, subscription: "sub_polar0000001", metadata: { order: "PP-1001" } }),
    // a Checkout whose client_reference_id happens to look like a GenClass account id, without GenClass's metadata
    stripeEvent("checkout.session.completed", { id: "cs_live_polar00003", object: "checkout.session", mode: "subscription", payment_status: "paid", client_reference_id: accountId, customer: POLAR, subscription: "sub_polar0000001", metadata: { order: "PP-1001" } }),
    // ... or with an account_id of its own
    stripeEvent("checkout.session.completed", { id: "cs_live_polar00004", object: "checkout.session", mode: "subscription", payment_status: "paid", client_reference_id: accountId, customer: POLAR, subscription: "sub_polar0000001", metadata: { account_id: accountId, genclass_account: accountId } }),
    stripeEvent("customer.subscription.created", polarSub()),
    stripeEvent("customer.subscription.updated", { ...polarSub("past_due"), metadata: { account_id: accountId } }),
    stripeEvent("customer.subscription.deleted", polarSub("canceled")),
    stripeEvent("invoice.paid", polarInvoice("sub_polar0000001")),
    stripeEvent("invoice.paid", polarInvoice(null)),
    stripeEvent("invoice.payment_failed", polarInvoice("sub_polar0000001")),
    stripeEvent("customer.created", polarCustomer),
    stripeEvent("charge.refunded", { id: "ch_polar0000001", object: "charge", customer: POLAR, billing_details: { email: "ada@example.com" } }),
  ];

  it("Polar Parts orders, subscriptions and invoices change no plan, call Stripe for nothing, and leave nothing stored", async () => {
    const t = await shop();
    // one GenClass account on Free, one paying for Pro
    const b = await signedIn(t.env, "bob@example.com");
    setPlan(t.sql, b.account.id, "pro", { stripe_customer_id: "cus_bob0000001", subscription_id: "sub_bob0000001", subscription_status: "active", stripe_mode: "live", current_period_end: "2026-11-13T12:00:00.000Z" });
    const before = t.state();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const events = [...polarEvents(t.account.id), ...polarEvents(b.account.id)];
    for (const ev of events) {
      const r = await deliver(t.env, ev, t.s.fetch);
      expect(r.status, ev.type).toBe(200);
      expect(await r.json(), ev.type).toEqual({ received: true, result: "ignored" });
    }
    const lines = log.mock.calls.map((c) => c.join(" "));
    log.mockRestore();
    expect(t.state()).toEqual(before);
    // nothing about them was fetched or sent anywhere
    expect(t.s.calls).toEqual([]);
    expect(t.s.other).toEqual([]);
    // logged by type and id only
    expect(lines).toHaveLength(events.length);
    for (const [i, line] of lines.entries()) {
      expect(line.startsWith(`stripe webhook: ${events[i]!.type} ${events[i]!.id} ignored: `)).toBe(true);
      for (const x of PRIVATE) expect(line).not.toContain(x);
      expect(line).not.toContain(t.account.id);
    }
    // stored: nothing, not even the event ids (a table of them would be a record of Polar Parts' sales)
    expect(t.sql.rows("SELECT * FROM billing_events")).toEqual([]);
    const dump = JSON.stringify([t.sql.rows("SELECT * FROM custom_requests"), t.sql.rows("SELECT plan, stripe_customer_id, subscription_id, subscription_status FROM accounts")]);
    for (const x of PRIVATE) expect(dump).not.toContain(x);
    // the endpoint does not even subscribe to the event types that carry Polar Parts' order details
    for (const ev of events) if (!ev.type.startsWith("customer.subscription.")) expect(WEBHOOK_EVENTS).not.toContain(ev.type);
  });

  it("a Checkout whose client_reference_id or metadata names a GenClass account changes nothing", async () => {
    const t = await shop();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // the account has no Stripe customer yet: the old code would have adopted the Checkout's customer
    const ev = stripeEvent("checkout.session.completed", { id: "cs_live_lookalike1", mode: "subscription", payment_status: "paid", client_reference_id: t.account.id, customer: POLAR, subscription: "sub_polar0000001" });
    expect(await (await deliver(t.env, ev, t.s.fetch)).json()).toEqual({ received: true, result: "ignored" });
    expect(log).toHaveBeenCalledWith(`stripe webhook: checkout.session.completed ${ev.id} ignored: event type not handled`);
    // GenClass's metadata naming an account, but not that account's GenClass customer
    const forged = stripeEvent("checkout.session.completed", { id: "cs_live_lookalike2", mode: "subscription", payment_status: "paid", client_reference_id: t.account.id, metadata: { genclass: "1", genclass_account: t.account.id }, customer: POLAR, subscription: "sub_polar0000001" });
    expect(await (await deliver(t.env, forged, t.s.fetch)).json()).toEqual({ received: true, result: "ignored" });
    log.mockRestore();
    expect(t.state()).toEqual([{ plan: "free", stripe_customer_id: null, subscription_id: null, subscription_status: null, past_due_since: null }]);
    expect(t.s.calls).toEqual([]);
  });

  it("a subscription of a GenClass customer counts only when it is provably GenClass's and its customer names the account", async () => {
    const t = await shop();
    t.sql.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_ada0000001', stripe_mode = 'live' WHERE id = ?").run(t.account.id);
    t.s.genclassCustomer("cus_ada0000001", t.account.id);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const send = async (sub: Record<string, unknown>) => {
      t.s.subs.set(String(sub.id), sub);
      return ((await (await deliver(t.env, stripeEvent("customer.subscription.updated", sub), t.s.fetch)).json()) as any).result;
    };
    const mine = (id: string, p: Record<string, unknown>) => ({ ...subscription(id, t.account.id, "cus_ada0000001", null), items: { data: [{ id: `si_${id.slice(4)}`, current_period_end: 1_792_000_000, price: p }] } });
    // a Polar Parts price on the GenClass customer
    expect(await send(mine("sub_foreign00001", price("polar_tires_monthly")))).toBe("ignored");
    // a genclass_ lookup key on a product without genclass_plan, and GenClass's product under another lookup key
    expect(await send(mine("sub_foreign00002", price("genclass_pro_monthly", { plan: null })))).toBe("ignored");
    expect(await send(mine("sub_foreign00003", price("tires_pro_monthly", { plan: "pro" })))).toBe("ignored");
    // a GenClass price, but a subscription that names another account
    expect(await send({ ...subscription("sub_other00001", "Z".repeat(22), "cus_ada0000001", "genclass_pro_monthly") })).toBe("ignored");
    expect(t.state()[0]).toMatchObject({ plan: "free", subscription_id: null });
    // a GenClass price, but the customer's metadata names another account (the row was tampered with, say)
    t.s.customers.get("cus_ada0000001")!.metadata.genclass_account = "Z".repeat(22);
    expect(await send(subscription("sub_ada0000009", t.account.id, "cus_ada0000001", "genclass_pro_monthly"))).toBe("ignored");
    t.s.customers.get("cus_ada0000001")!.metadata.genclass_account = t.account.id;
    expect(t.state()[0]).toMatchObject({ plan: "free", subscription_id: null });
    // GenClass's: applied
    expect(await send(subscription("sub_ada0000009", t.account.id, "cus_ada0000001", "genclass_pro_monthly"))).toBe("applied");
    expect(t.state()[0]).toMatchObject({ plan: "pro", subscription_id: "sub_ada0000009" });
    // a customer deleted in Stripe keeps no metadata: the account row (only ensureCustomer writes it) names it
    t.s.customers.set("cus_ada0000001", { id: "cus_ada0000001", object: "customer", deleted: true });
    t.s.subs.get("sub_ada0000009")!.status = "canceled";
    expect(await send(t.s.subs.get("sub_ada0000009")!)).toBe("applied");
    log.mockRestore();
    expect(t.state()[0]).toMatchObject({ plan: "free", subscription_status: "canceled" });
    // only GenClass's own subscriptions were fetched, and never a Polar Parts object
    for (const c of t.s.calls) for (const x of PRIVATE) expect(c.url.toString()).not.toContain(x);
  });

  it("customers: GenClass makes its own, never looks one up by email, and never reads or changes Polar Parts' customer", async () => {
    const t = await shop();
    const r = await call(t.env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie: t.cookie, fetch: t.s.fetch });
    expect(r.status).toBe(200);
    const customerCalls = t.s.calls.filter((c) => c.url.pathname.startsWith("/v1/customers"));
    expect(customerCalls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["POST /v1/customers"]);
    const made = [...t.s.customers.values()].find((c) => c.id !== POLAR)!;
    expect(made).toMatchObject({ email: "ada@example.com", description: "GenClass account", metadata: { genclass: "1", genclass_account: t.account.id } });
    expect(t.state()[0]!.stripe_customer_id).toBe(made.id);
    expect(t.s.customers.get(POLAR)).toEqual(polarCustomer);
    // Checkout is for that customer only (no customer_email, so Stripe makes no customer of its own)
    const session = t.s.calls.find((c) => c.method === "POST" && c.url.pathname === "/v1/checkout/sessions")!;
    expect(session.form!.get("customer")).toBe(made.id);
    expect(session.form!.has("customer_email")).toBe(false);
    expect(session.form!.has("customer_creation")).toBe(false);
    // a Checkout page of that customer that GenClass did not make is never reused or closed
    t.s.sessions.set("cs_test_manual01", { id: "cs_test_manual01", object: "checkout.session", status: "open", customer: made.id, metadata: {}, url: "https://checkout.stripe.com/c/pay/cs_test_manual01" });
    const second = await call(t.env, "POST", "/api/billing/checkout", { body: { plan: "custom" }, cookie: t.cookie, fetch: t.s.fetch });
    expect(((await second.json()) as any).url).not.toContain("cs_test_manual01");
    expect(t.s.sessions.get("cs_test_manual01")!.status).toBe("open");
    expect(t.s.calls.some((c) => c.url.pathname.includes("cs_test_manual01"))).toBe(false);
    // no request at all names a Polar Parts object
    for (const c of t.s.calls) for (const x of PRIVATE.filter((p) => p !== "ada@example.com")) expect(`${c.url} ${c.form ?? ""}`).not.toContain(x);
  });

  it("checkout sells only a price on GenClass's product: a genclass_ lookup key on another product is refused", async () => {
    const t = await shop();
    // someone moved GenClass's lookup key onto a Polar Parts price
    const s = fakeStripe({ answer: (u) => (u.pathname === "/v1/prices" ? new Response(JSON.stringify({ data: [price("genclass_pro_monthly", { id: "price_polar0000001", plan: null })] }), { status: 200 }) : undefined) });
    const r = await call(t.env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie: t.cookie, fetch: s.fetch });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error).toBe(
      "Stripe: the price with the lookup key genclass_pro_monthly is not on GenClass's Pro product (metadata genclass_plan=pro); run scripts/stripe-setup.mjs",
    );
    expect(s.calls.some((c) => c.url.pathname === "/v1/checkout/sessions")).toBe(false);
  });

  it("deleting an account, or a second subscription, cancels GenClass subscriptions only", async () => {
    const t = await shop();
    t.sql.db.prepare("UPDATE accounts SET stripe_customer_id = 'cus_ada0000001', stripe_mode = 'live' WHERE id = ?").run(t.account.id);
    t.s.genclassCustomer("cus_ada0000001", t.account.id);
    t.s.subs.set("sub_ada0000001", subscription("sub_ada0000001", t.account.id, "cus_ada0000001", "genclass_pro_monthly"));
    // something else on the GenClass customer (added by hand in the dashboard, say): not provably GenClass's
    t.s.subs.set("sub_hand0000001", { ...subscription("sub_hand0000001", t.account.id, "cus_ada0000001", null, "active", { created: 1_790_000_500 }), items: { data: [{ id: "si_hand0000001", price: price("polar_tires_monthly") }] } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const started = stripeEvent("customer.subscription.created", t.s.subs.get("sub_ada0000001")!);
    expect(await (await deliver(t.env, started, t.s.fetch)).json()).toEqual({ received: true, result: "applied" });
    log.mockRestore();
    // the newer one is not GenClass's: it is not counted as a second subscription, and not cancelled
    expect(t.s.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(t.state()[0]).toMatchObject({ plan: "pro", subscription_id: "sub_ada0000001" });
    expect((await call(t.env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(204);
    expect(t.s.calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname)).toEqual(["/v1/subscriptions/sub_ada0000001"]);
    expect(t.s.subs.get("sub_hand0000001")!.status).toBe("active");
    expect(t.s.subs.get("sub_polar0000001")!.status).toBe("active");
  });

  it("Polar Parts billing on the GenClass customer: no portal session, no Checkout, no balance credit", async () => {
    const t = await shop();
    setPlan(t.sql, t.account.id, "pro", { stripe_customer_id: "cus_ada0000001", subscription_id: "sub_ada0000001", subscription_status: "active", stripe_mode: "live" });
    t.s.genclassCustomer("cus_ada0000001", t.account.id);
    t.s.subs.set("sub_ada0000001", subscription("sub_ada0000001", t.account.id, "cus_ada0000001", "genclass_pro_monthly"));
    // Polar Parts' store found the newest customer with ada@example.com (GenClass's) and put a tire subscription on it
    t.s.subs.set("sub_polar0000002", { ...polarSub(), id: "sub_polar0000002", customer: "cus_ada0000001", created: 1_790_000_300 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const opened = () => t.s.calls.filter((c) => c.method === "POST" && /^\/v1\/(billing_portal\/sessions|checkout\/sessions)/.test(c.url.pathname));
    const portal = await call(t.env, "POST", "/api/billing/portal", { body: {}, cookie: t.cookie, fetch: t.s.fetch });
    expect(portal.status).toBe(409);
    expect(((await portal.json()) as any).error).toBe(
      "this account's Stripe billing record holds something that is not GenClass's, so GenClass does not open it; email mehar@daybot.ca and we will sort it out",
    );
    for (const plan of ["pro", "custom"]) expect((await call(t.env, "POST", "/api/billing/checkout", { body: { plan }, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(409);
    expect(opened()).toEqual([]);
    // the Polar Parts subscription's own events: on a GenClass customer, but not fetched, not stored, no plan change
    for (const type of ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]) {
      const ev = stripeEvent(type, t.s.subs.get("sub_polar0000002")!);
      expect(await (await deliver(t.env, ev, t.s.fetch)).json()).toEqual({ received: true, result: "ignored" });
      expect(log).toHaveBeenCalledWith(`stripe webhook: ${type} ${ev.id} ignored: not a GenClass subscription`);
    }
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM billing_events")[0]!.n).toBe(0);
    expect(t.state()[0]).toMatchObject({ plan: "pro", subscription_id: "sub_ada0000001" });
    // nothing about the Polar Parts subscription was fetched beyond the customer's subscription list
    expect(t.s.calls.some((c) => c.url.pathname.includes("sub_polar") || c.url.pathname === "/v1/invoices")).toBe(false);
    // the owner hears of it, with ids only
    const notices = t.s.other.map((o) => JSON.parse(o.body));
    expect(notices.map((n) => n.event)).toEqual(["shared_customer", "shared_customer", "shared_customer"]);
    expect(notices[0]).toMatchObject({ account_id: t.account.id, customer: "cus_ada0000001" });
    for (const o of t.s.other) for (const x of PRIVATE) expect(o.body).not.toContain(x);

    // only an invoice of Polar Parts' (a one-off order invoiced to that customer): the portal would list it, so no portal
    t.s.subs.delete("sub_polar0000002");
    t.s.invoices.set("in_polar0000001", { ...polarInvoice(null), customer: "cus_ada0000001" });
    expect((await call(t.env, "POST", "/api/billing/portal", { body: {}, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(409);
    // ... nor the plan switch, which opens the portal too
    expect((await call(t.env, "POST", "/api/billing/checkout", { body: { plan: "custom" }, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(409);
    expect(opened()).toEqual([]);
    // GenClass's own invoices are fine: with the Polar Parts one gone, Manage billing opens
    t.s.invoices.delete("in_polar0000001");
    t.s.invoices.set("in_ada0000001", invoice("in_ada0000001", "cus_ada0000001", "sub_ada0000001", [["price_pro000001", 9900]]));
    expect((await call(t.env, "POST", "/api/billing/portal", { body: {}, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(200);
    expect(opened()).toHaveLength(1);

    // a second GenClass subscription while a Polar Parts one is on the customer: the duplicate is cancelled without a
    // credit (a balance credit would pay Polar Parts' next invoice)
    t.s.subs.set("sub_polar0000002", { ...polarSub(), id: "sub_polar0000002", customer: "cus_ada0000001", created: 1_790_000_300 });
    t.s.subs.set("sub_ada0000002", subscription("sub_ada0000002", t.account.id, "cus_ada0000001", "genclass_custom_monthly", "active", { created: 1_790_000_400 }));
    t.s.calls.length = 0;
    t.s.other.length = 0;
    expect(await (await deliver(t.env, stripeEvent("customer.subscription.created", t.s.subs.get("sub_ada0000002")!), t.s.fetch)).json()).toEqual({ received: true, result: "applied" });
    log.mockRestore();
    const cancels = t.s.calls.filter((c) => c.method === "DELETE");
    expect(cancels.map((c) => c.url.pathname)).toEqual(["/v1/subscriptions/sub_ada0000001"]);
    expect(cancels[0]!.url.search).toBe("");
    expect(t.s.subs.get("sub_polar0000002")!.status).toBe("active");
    const dup = JSON.parse(t.s.other[0]!.body);
    expect(dup).toMatchObject({ event: "duplicate_subscription", kept: "sub_ada0000002", cancelled: ["sub_ada0000001"], credited: false });
    expect(dup.text).toMatch(/without a credit, because the Stripe customer cus_ada0000001 also holds a subscription that is not GenClass's/);
    expect(sharedCustomer([t.s.subs.get("sub_ada0000002")!])).toBe(false);
  });

  it("a stored customer that is not GenClass's (a row from older code): checkout, the portal and deletion leave it alone", async () => {
    const t = await shop();
    // Polar Parts' customer and subscription on record, as the code before customers were checked could have left
    setPlan(t.sql, t.account.id, "pro", { stripe_customer_id: POLAR, subscription_id: "sub_polar0000001", subscription_status: "active", stripe_mode: "live" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await call(t.env, "POST", "/api/billing/portal", { body: {}, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(409);
    expect((await call(t.env, "POST", "/api/billing/checkout", { body: { plan: "custom" }, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(409);
    // the customer is read to find out, and nothing else
    expect(t.s.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`GET /v1/customers/${POLAR}`, `GET /v1/customers/${POLAR}`]);
    // deleting the account: Polar Parts' subscription is not GenClass's to cancel, so a person sorts it out
    const del = await call(t.env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: t.cookie, fetch: t.s.fetch });
    log.mockRestore();
    expect(del.status).toBe(409);
    expect(((await del.json()) as any).error).toBe("your paid plan could not be cancelled automatically, so the account was not deleted; email mehar@daybot.ca");
    expect(t.s.calls.some((c) => c.method !== "GET")).toBe(false);
    expect(t.s.subs.get("sub_polar0000001")!.status).toBe("active");
    expect(t.s.customers.get(POLAR)).toEqual(polarCustomer);
    // nothing recorded as live: the account goes, and still nothing is cancelled
    setPlan(t.sql, t.account.id, "free", { subscription_status: "canceled" });
    expect((await call(t.env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(204);
    expect(t.s.calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("portal: the configuration STRIPE_PORTAL_CONFIGURATION names, fetched by id and checked; never listed, never the default", async () => {
    const t = await shop();
    setPlan(t.sql, t.account.id, "pro", { stripe_customer_id: "cus_ada0000001", subscription_id: "sub_ada0000001", subscription_status: "active", stripe_mode: "live" });
    t.s.genclassCustomer("cus_ada0000001", t.account.id);
    for (let i = 0; i < 2; i++) expect((await call(t.env, "POST", "/api/billing/portal", { body: {}, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(200);
    const sessions = t.s.calls.filter((c) => c.url.pathname === "/v1/billing_portal/sessions");
    expect(sessions.map((c) => c.form!.get("configuration"))).toEqual([GENCLASS_PORTAL, GENCLASS_PORTAL]);
    // fetched once (cached), by its id: Polar Parts' configurations are never listed or read
    expect(t.s.calls.filter((c) => c.url.pathname.startsWith("/v1/billing_portal/configurations")).map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      `GET /v1/billing_portal/configurations/${GENCLASS_PORTAL}`,
    ]);

    // the setting names a configuration that is not GenClass's: the account's default one (even carrying the
    // metadata), Polar Parts' other one, an inactive one, or none in this mode: 503, and no session
    const refused = async (over: Record<string, unknown>, edit?: (portal: Record<string, any>[]) => void) => {
      resetStripeCache();
      const u = await shop(over);
      setPlan(u.sql, u.account.id, "pro", { stripe_customer_id: "cus_ada0000001", subscription_id: "sub_ada0000001", subscription_status: "active", stripe_mode: "live" });
      u.s.genclassCustomer("cus_ada0000001", u.account.id);
      edit?.(u.s.portal);
      const r = await call(u.env, "POST", "/api/billing/portal", { body: {}, cookie: u.cookie, fetch: u.s.fetch });
      expect(r.status).toBe(503);
      expect(u.s.calls.some((c) => c.url.pathname === "/v1/billing_portal/sessions")).toBe(false);
      expect(u.s.calls.some((c) => c.method === "GET" && c.url.pathname === "/v1/billing_portal/configurations")).toBe(false);
      return ((await r.json()) as any).error as string;
    };
    expect(await refused({ STRIPE_PORTAL_CONFIGURATION: "bpc_polardefault1" }, (p) => (p[0]!.metadata = { genclass: "1" }))).toMatch(
      /bpc_polardefault1 \(STRIPE_PORTAL_CONFIGURATION\) is not GenClass's Billing Portal configuration/,
    );
    expect(await refused({ STRIPE_PORTAL_CONFIGURATION: "bpc_other00001" })).toMatch(/is not GenClass's Billing Portal configuration/);
    expect(await refused({}, (p) => (p[2]!.active = false))).toMatch(/is not GenClass's Billing Portal configuration/);
    expect(await refused({ STRIPE_PORTAL_CONFIGURATION: "bpc_nosuchone01" })).toMatch(/Stripe has no Billing Portal configuration bpc_nosuchone01/);
    // not set (the setup script has not run)
    expect(await refused({ STRIPE_PORTAL_CONFIGURATION: undefined })).toBe("Stripe: GenClass's Billing Portal configuration is not set (STRIPE_PORTAL_CONFIGURATION); run scripts/stripe-setup.mjs");
  });

  it("test mode: the same isolation (Polar Parts' test-mode traffic is ignored the same way)", async () => {
    const TESTING = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET_TEST: TEST_SECRET, STRIPE_WEBHOOK_SECRET: undefined, STRIPE_TEST_ACCOUNTS: "ada@example.com" };
    const t = await shop(TESTING);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const ev of polarEvents(t.account.id)) {
      const r = await deliver(t.env, { ...ev, livemode: false }, t.s.fetch, { secret: TEST_SECRET });
      expect(await r.json(), ev.type).toEqual({ received: true, result: "ignored" });
    }
    log.mockRestore();
    expect(t.s.calls).toEqual([]);
    // a test checkout makes a GenClass customer too, and its session carries GenClass's metadata
    expect((await call(t.env, "POST", "/api/billing/checkout", { body: { plan: "pro" }, cookie: t.cookie, fetch: t.s.fetch })).status).toBe(200);
    expect(t.s.calls[0]!.form!.get("metadata[genclass_account]")).toBe(t.account.id);
    expect(t.s.calls.at(-1)!.form!.get("metadata[genclass]")).toBe("1");
    expect(t.s.customers.get(POLAR)).toEqual(polarCustomer);
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
    s.genclassCustomer("cus_del0000001", a.account.id);
    s.subs.set("sub_del0000001", subscription("sub_del0000001", a.account.id, "cus_del0000001", "genclass_pro_monthly"));
    setPlan(sql, a.account.id, "pro", { stripe_customer_id: "cus_del0000001", subscription_id: "sub_del0000001", subscription_status: "active" });
    const failing = await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: a.cookie, fetch: async () => { throw new Error("offline"); } });
    expect(failing.status).toBe(502);
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(1);
    const del = await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: a.cookie, fetch: s.fetch });
    expect(del.status).toBe(204);
    expect(s.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /v1/customers/cus_del0000001", "GET /v1/subscriptions", "DELETE /v1/subscriptions/sub_del0000001"]);
    expect(s.subs.get("sub_del0000001")!.status).toBe("canceled");
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(0);
  });

  it("cancels every subscription the customer has, also one GenClass never recorded (a second one, or a late webhook)", async () => {
    const { env, sql } = setup(LIVE);
    const a = await signedIn(env);
    const s = fakeStripe();
    s.genclassCustomer("cus_two0000001", a.account.id);
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
    s.genclassCustomer("cus_late000001", b.account.id, "late@example.com");
    s.subs.set("sub_late000001", subscription("sub_late000001", b.account.id, "cus_late000001", "genclass_pro_monthly"));
    setPlan(sql, b.account.id, "free", { stripe_customer_id: "cus_late000001", stripe_mode: "live" });
    expect((await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: b.cookie, fetch: s.fetch })).status).toBe(204);
    expect(s.subs.get("sub_late000001")!.status).toBe("canceled");
  });

  it("never cancels a subscription by its recorded id alone: only what Stripe lists on the checked customer as GenClass's", async () => {
    const { env, sql } = setup(LIVE);
    const a = await signedIn(env);
    const s = fakeStripe();
    s.genclassCustomer("cus_swp0000001", a.account.id);
    // the recorded subscription had a Polar Parts price swapped in (Polar Parts' default portal, or by hand): it is
    // not GenClass's any more, and deleting the GenClass account leaves it to its business
    s.subs.set("sub_swp0000001", { ...subscription("sub_swp0000001", a.account.id, "cus_swp0000001", null), items: { data: [{ id: "si_swp0000001", price: price("polar_tires_monthly") }] } });
    setPlan(sql, a.account.id, "pro", { stripe_customer_id: "cus_swp0000001", subscription_id: "sub_swp0000001", subscription_status: "active", stripe_mode: "live" });
    expect((await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: a.cookie, fetch: s.fetch })).status).toBe(204);
    expect(s.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(s.subs.get("sub_swp0000001")!.status).toBe("active");

    // no customer on record (a row from older code), a live subscription recorded: cancelled only when it is
    // GenClass's and its customer names the account
    const b = await signedIn(env, "old@example.com");
    s.genclassCustomer("cus_old0000001", b.account.id, "old@example.com");
    s.subs.set("sub_old0000001", subscription("sub_old0000001", b.account.id, "cus_old0000001", "genclass_pro_monthly"));
    setPlan(sql, b.account.id, "pro", { subscription_id: "sub_old0000001", subscription_status: "active", stripe_mode: "live" });
    expect((await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: b.cookie, fetch: s.fetch })).status).toBe(204);
    expect(s.subs.get("sub_old0000001")!.status).toBe("canceled");
    const c = await signedIn(env, "other@example.com");
    setPlan(sql, c.account.id, "pro", { subscription_id: "sub_polar0000009", subscription_status: "active", stripe_mode: "live" });
    s.subs.set("sub_polar0000009", { ...subscription("sub_polar0000009", "Z".repeat(22), "cus_polar0000009", "genclass_pro_monthly"), metadata: {} });
    s.calls.length = 0;
    expect((await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie: c.cookie, fetch: s.fetch })).status).toBe(204);
    expect(s.calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual(["GET /v1/subscriptions/sub_polar0000009"]);
    expect(s.subs.get("sub_polar0000009")!.status).toBe("active");
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
    s.genclassCustomer("cus_mix0000001", a.account.id);
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

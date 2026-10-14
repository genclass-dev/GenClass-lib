// Stripe, over its REST API with fetch (form-encoded requests, a pinned Stripe-Version, idempotency keys on every
// create; no SDK): Checkout Sessions for the paid plans and for switching between them, Billing Portal sessions,
// immediate cancellation when an account is deleted, and the webhook that keeps accounts.plan in step with the
// subscription.
//
// Invariants:
// - Pro is sold through Stripe Managed Payments (Stripe, through Link, is the merchant of record) when the Worker var
//   MANAGED_PAYMENTS is "on" (off until the owner's test-mode Pro checkout showed Stripe accepts it); Custom never is
//   (a person trains the model, so it is not an eligible fully automated digital product). Managed Payments
//   subscriptions exist only through Checkout, cannot hold a non-eligible product and cannot be turned on for an
//   existing subscription, so a switch between Pro and Custom is always a new Checkout for the other plan (README
//   "Paid plans", "Stripe documentation notes"). Every subscription GenClass starts uses flexible billing mode.
// - GenClass bills through a Stripe account of its own ("GenClass"). It used to share daybot.ca's account with Polar
//   Parts, and keeps the defences from then: it touches only objects it can prove are its own (README "Shared-account
//   defences"):
//   - customers it created itself (description "GenClass account", metadata genclass=1 and genclass_account). They
//     are never looked up by email, and accounts.stripe_customer_id is written only by ensureCustomer. Before
//     GenClass opens a Stripe page for a stored customer, starts a Checkout on it or cancels anything on it, the
//     customer itself is checked (checkCustomer): its metadata must name the account. A Billing Portal session also
//     needs every subscription and invoice on the customer to be GenClass's (sharedCustomer, foreignInvoice): the
//     portal would otherwise let the buyer cancel, re-card or read another business's billing on that customer;
//   - Checkout Sessions it created (mode subscription, metadata genclass=1 and genclass_account) for those customers;
//   - subscriptions whose every price has a genclass_ lookup key and a product with metadata genclass_plan
//     (src/plans.ts planForPrice), of those customers (fetched with the customer expanded, whose metadata
//     genclass_account must name the account), and the invoices, payments and refunds of those subscriptions;
//   - its own Billing Portal configuration (metadata genclass=1, never the account's default one), by the id
//     scripts/stripe-setup.mjs stores in STRIPE_PORTAL_CONFIGURATION (live) or STRIPE_PORTAL_CONFIGURATION_TEST.
//   The webhook endpoint subscribes to WEBHOOK_EVENTS only. An event for a customer the accounts table does not name is
//   answered 200, logged by type and id only, not stored, and nothing about it is fetched from Stripe (a dispute, which
//   names no customer, has its charge read for that): the check before any Stripe call uses the event itself and our
//   database. From invoices, charges and disputes, which carry the buyer's details, only ids and amounts are read.
// - GenClass stores the Stripe customer id, subscription id, status, period end, plan and the Stripe mode (test or
//   live) those ids belong to. Never card data: payment details are typed into Stripe's own pages. A Managed Payments
//   checkout asks the buyer for a name and billing address (for the tax) and Stripe keeps them on the customer; the
//   worker reads a customer only for its metadata and stores none of that.
// - A plan is granted only once Stripe has the money: a subscription the account has not been granted yet counts only
//   when its latest invoice is paid (or asks for nothing), not when Stripe calls it active while a bank debit is still
//   processing; invoice.paid brings it back when the payment clears.
// - One subscription per account. Checkout asks Stripe (not the database, which a late webhook leaves behind) whether
//   the customer already has one: the same plan is refused, the other plan is a switch (a Checkout whose subscription
//   carries metadata genclass_switch_from naming the one it replaces); an account's older unpaid Checkout pages are
//   closed when it opens another. When a subscription starts billing and the customer has more than one GenClass
//   subscription that bills and is paid for (a switch paid, or two tabs paid at once), the one kept (a switch's new
//   plan; for a duplicate, Custom over Pro) is written to the account first, and only then are the others refunded to
//   their payment method (a switch's old plan: the unused time; a duplicate: its latest payment) and cancelled at once
//   with no balance credit. So the account is never left without a plan, and is billed for both only until that
//   cancellation (a failure answers 500 and Stripe's retry finishes it; the refund is made once). A switch whose new
//   subscription is never paid changes nothing. The owner is told about every switch and duplicate.
// - A webhook is accepted only with a valid Stripe-Signature (HMAC-SHA256 of "t.payload" under the webhook secret of
//   the key's mode, any v1 matching, compared in constant time, timestamp within 5 minutes). Events from the other
//   mode (a test endpoint left over after going live) are acknowledged and ignored. Each event about a GenClass
//   customer is handled once (billing_events); a failure answers 500 so Stripe delivers it again.
// - The plan always comes from the subscription as Stripe has it now (fetched when an event arrives, so events that
//   arrive out of order cannot leave a stale plan): the price names the plan (src/plans.ts planForPrice), and the
//   status decides whether it applies (active or trialing: yes; past_due: for 14 days from when GenClass first saw it
//   past due, whatever the account's retry settings; anything else: free). An event about another subscription than
//   the account's current one never overwrites a live plan unless oneSubscription chose it.
// - A Custom purchase is recorded (custom_requests, NOTIFY_WEBHOOK) only once Stripe reports the Custom price paid:
//   the subscription's latest invoice (fetched with it) is paid and has a positive Custom line (a first Custom
//   invoice, which a switch from Pro is too), seen on invoice.paid or on the subscription's own events.
// - Refunds and disputes of GenClass customers' charges are reported to the owner (NOTIFY_WEBHOOK), ids and amounts only.

import type { Env } from "./collector.js";
import { randomBase62, sha256Hex, type D1Like } from "./dashboard.js";
import { json } from "./http.js";
import { LIVE_STATUSES, LOOKUP_PREFIX, pastDueLapsed, PLANS_FILE, planForPrice, stripeMode, type Billing, type Plan, type PlanId } from "./plans.js";
import { equalStrings } from "./webauthn.js";

export const STRIPE_API = "https://api.stripe.com";
/**
 * Every request names this API version; scripts/stripe-setup.mjs creates the webhook endpoint with it too. Managed
 * Payments needs 2025-03-31.basil or later, flexible billing mode (subscription_data.billing_mode) 2025-06-30.basil or
 * later; monthly releases within basil add no breaking changes (README "Stripe documentation notes").
 */
export const STRIPE_VERSION = "2025-06-30.basil";
export const WEBHOOK_TOLERANCE_S = 300;
/**
 * The events GenClass's endpoint subscribes to, and no more: the endpoint receives these for the whole Stripe account.
 * Subscription events carry ids, prices, statuses and dates, never a buyer's name, email or address. A renewal, a
 * failed payment and a cancellation change a subscription, so each arrives as customer.subscription.created, .updated
 * or .deleted (Managed Payments subscriptions send the same events). invoice.paid is there because Stripe can make a
 * subscription active while its first payment is still processing (a bank debit): the plan is granted only once that
 * payment clears, which invoice.paid reports. charge.refunded and charge.dispute.created tell the owner about money
 * going back. Invoices, charges and disputes carry the buyer's name, email or address: the worker reads only ids and
 * amounts from them (the invoice's subscription, the charge's customer), logs the event's type and id, and stores none
 * of it.
 */
export const WEBHOOK_EVENTS = ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "charge.refunded", "charge.dispute.created"];
/** metadata.genclass on every Stripe object GenClass creates (customers, Checkout Sessions, subscriptions, products, prices, portal configuration, webhook endpoint). */
export const GENCLASS_MARK = "1";
/** The description of every customer GenClass creates. */
export const CUSTOMER_DESCRIPTION = "GenClass account";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
// Stripe objects are read defensively field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const STRIPE_ID_RE = /^[a-z]{2,8}_[A-Za-z0-9]{6,255}$/;
const SESSION_ID_RE = /^cs_[A-Za-z0-9_]{6,255}$/;

/** Subscriptions that exist and bill, or can bill again: an account may hold one. */
export const HOLDING_STATUSES = new Set([...LIVE_STATUSES, "unpaid", "paused"]);
/** Subscriptions that can never bill again. */
const ENDED_STATUSES = new Set(["canceled", "incomplete_expired"]);

// --------------------------------------------------------------------------------------------- REST

/** Stripe's form encoding: nested objects as a[b]=1, arrays as a[0]=1; null and undefined are left out. */
export function form(params: Record<string, unknown>): string {
  const out: [string, string][] = [];
  const walk = (key: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${key}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(`${key}[${k}]`, x);
    else out.push([key, String(v)]);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return new URLSearchParams(out).toString();
}

export class StripeError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly param?: string) {
    super(message);
  }
}

/** Stripe no longer has this customer (deleted in the Stripe dashboard, or an id from another Stripe account). */
export const missingCustomer = (e: unknown): boolean =>
  e instanceof StripeError && e.code === "resource_missing" && (e.param === "customer" || /customer/i.test(e.message));

/** One Stripe API call. Throws StripeError (no secret in its message) on a refusal, a network error or a timeout. */
export async function stripe(env: Env, f: Fetch, method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<Obj> {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeError("paid plans are not configured on this server", 503);
  const qs = method !== "POST" && params ? `?${form(params)}` : "";
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, "stripe-version": STRIPE_VERSION };
  if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  let res: Response;
  try {
    res = await f(`${STRIPE_API}${path}${qs}`, { method, headers, body: method === "POST" ? form(params ?? {}) : undefined, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new StripeError("Stripe did not answer; try again in a minute", 502);
  }
  let j: Obj = {};
  try {
    j = (await res.json()) as Obj;
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new StripeError(typeof j?.error?.message === "string" ? j.error.message : `Stripe answered HTTP ${res.status}`, res.status, j?.error?.code, j?.error?.param);
  return j;
}

const priceCache = new Map<string, { id: string; exp: number }>();
export const resetStripeCache = (): void => {
  priceCache.clear();
  portalConfigs.clear();
};

/**
 * The active price with this lookup key (cached for 10 minutes), with its product, which must be GenClass's product
 * for `plan` (src/plans.ts planForPrice): a lookup key alone does not make a price GenClass's in a shared account.
 */
export async function priceId(env: Env, f: Fetch, lookupKey: string, nowMs: number, plan: Plan): Promise<string> {
  const c = priceCache.get(lookupKey);
  if (c && c.exp > nowMs) return c.id;
  const r = await stripe(env, f, "GET", "/v1/prices", { lookup_keys: [lookupKey], active: true, limit: 1, expand: ["data.product"] });
  const p: Obj | undefined = r?.data?.[0];
  if (typeof p?.id !== "string") throw new StripeError(`no active Stripe price has the lookup key ${lookupKey}; run scripts/stripe-setup.mjs`, 503);
  if (planForPrice(p)?.id !== plan.id) {
    throw new StripeError(`the price with the lookup key ${lookupKey} is not on GenClass's ${plan.name} product (metadata genclass_plan=${plan.id}); run scripts/stripe-setup.mjs`, 503);
  }
  priceCache.set(lookupKey, { id: p.id, exp: nowMs + 10 * 60_000 });
  return p.id;
}

/** Billing Portal configuration ids checked to be GenClass's, until when (configurations differ between modes). */
const portalConfigs = new Map<string, number>();

/** The setting that holds GenClass's Billing Portal configuration id for the key's mode. */
export const portalSetting = (env: Env): "STRIPE_PORTAL_CONFIGURATION" | "STRIPE_PORTAL_CONFIGURATION_TEST" =>
  stripeMode(env) === "test" ? "STRIPE_PORTAL_CONFIGURATION_TEST" : "STRIPE_PORTAL_CONFIGURATION";

/**
 * The Billing Portal configuration scripts/stripe-setup.mjs made, by the id it stored (STRIPE_PORTAL_CONFIGURATION,
 * or STRIPE_PORTAL_CONFIGURATION_TEST with a test key). Fetched by that id alone, so no other configuration in the
 * shared account is read, and it must be GenClass's: metadata genclass=1, active, never the account's default one
 * (Polar Parts may use that). Checked once and cached 10 minutes. Without it no portal session is made: the default
 * configuration would show Polar Parts' settings to GenClass customers.
 */
async function portalConfiguration(env: Env, f: Fetch, nowMs: number): Promise<string> {
  const setting = portalSetting(env);
  const id = (env[setting] ?? "").trim();
  if (!/^bpc_[A-Za-z0-9]{6,255}$/.test(id)) throw new StripeError(`GenClass's Billing Portal configuration is not set (${setting}); run scripts/stripe-setup.mjs`, 503);
  const key = `${stripeMode(env)}:${id}`;
  if ((portalConfigs.get(key) ?? 0) > nowMs) return id;
  let c: Obj;
  try {
    c = await stripe(env, f, "GET", `/v1/billing_portal/configurations/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) throw new StripeError(`Stripe has no Billing Portal configuration ${id} (${setting}) in this mode; run scripts/stripe-setup.mjs`, 503);
    throw e;
  }
  if (c?.metadata?.genclass !== GENCLASS_MARK || c?.is_default !== false || c?.active !== true) {
    throw new StripeError(`${id} (${setting}) is not GenClass's Billing Portal configuration (metadata genclass=1, active, not the default); run scripts/stripe-setup.mjs`, 503);
  }
  portalConfigs.set(key, nowMs + 10 * 60_000);
  return id;
}

// --------------------------------------------------------------------------------------------- Checkout, portal

export interface BillingAccount {
  id: string;
  email: string | null;
  plan: string;
  stripe_customer_id: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
  /** The Stripe mode stripe_customer_id belongs to. */
  stripe_mode?: string | null;
  /** When GenClass first saw the subscription past_due (ISO), else null. */
  past_due_since?: string | null;
}

/**
 * The account's Stripe customer in the current key's mode, created the first time it is needed: always a new customer
 * of GenClass's own (the account's email, description "GenClass account", metadata genclass=1 and genclass_account).
 * Never found by email: a shared account may have another business's customer with the same email, which GenClass
 * must not reuse or change (README "Shared-account defences", owner check 1). This is the only place
 * accounts.stripe_customer_id is written with a customer id;
 * a stored customer is still checked (checkCustomer) before anything is done on it. `fresh`: created by this call,
 * so it has no subscriptions or Checkout pages yet.
 * - A stored customer from test mode while the key is live is replaced (the test plan is cleared with it).
 * - A stored customer from live mode while the key is a test key is refused: testing must not touch a paying account.
 * - `gone`: the stored customer Stripe reported missing; it is replaced the same way.
 */
export async function ensureCustomer(env: Env, f: Fetch, db: D1Like, a: BillingAccount, gone?: string): Promise<{ id: string; fresh: boolean }> {
  const mode = stripeMode(env);
  if (!mode) throw new StripeError("paid plans are not configured on this server", 503);
  const stored = a.stripe_customer_id;
  if (stored && stored !== gone) {
    if (!a.stripe_mode || a.stripe_mode === mode) return { id: stored, fresh: false };
    if (mode === "test") throw new StripeError("this account pays in Stripe's live mode; test with an account that has never paid", 409);
  }
  const c = await stripe(
    env,
    f,
    "POST",
    "/v1/customers",
    { email: a.email ?? undefined, description: CUSTOMER_DESCRIPTION, metadata: { genclass: GENCLASS_MARK, genclass_account: a.id } },
    stored ? `genclass-customer-${a.id}-after-${stored}` : `genclass-customer-${a.id}`,
  );
  if (typeof c.id !== "string" || !STRIPE_ID_RE.test(c.id)) throw new StripeError("Stripe did not return a customer", 502);
  if (stored) {
    // the old customer's plan and ids go with it (they are from test mode, or Stripe no longer has them)
    await db
      .prepare(
        "UPDATE accounts SET stripe_customer_id = ?, stripe_mode = ?, plan = 'free', subscription_id = NULL, subscription_status = NULL, " +
          "current_period_end = NULL, cancel_at_period_end = 0 WHERE id = ? AND stripe_customer_id = ?",
      )
      .bind(c.id, mode, a.id, stored)
      .run();
  } else {
    await db.prepare("UPDATE accounts SET stripe_customer_id = ?, stripe_mode = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(c.id, mode, a.id).run();
  }
  const row = await db.prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?").bind(a.id).first<{ stripe_customer_id: string | null }>();
  const id = row?.stripe_customer_id ?? c.id;
  return { id, fresh: id === c.id };
}

/**
 * A GenClass customer's subscriptions as Stripe has them now, every status, with their prices' products (whose
 * metadata says whether a subscription is GenClass's: isGenClassSubscription) and their latest invoices (whether a new
 * one's first payment cleared: paymentCleared). Only ever called with a customer id from the accounts table, which
 * only ensureCustomer writes.
 */
export async function customerSubscriptions(env: Env, f: Fetch, customer: string): Promise<Obj[]> {
  const r = await stripe(env, f, "GET", "/v1/subscriptions", { customer, status: "all", limit: 100, expand: ["data.items.data.price.product", "data.latest_invoice"] });
  return (Array.isArray(r?.data) ? r.data : []).filter((s: Obj) => idOf(s?.id));
}

/**
 * Every price of the subscription is provably GenClass's (a genclass_ lookup key and a product with metadata
 * genclass_plan; the product must be expanded). A subscription mixing in any other price is not GenClass's.
 */
export function isGenClassSubscription(sub: Obj): boolean {
  const items: Obj[] = Array.isArray(sub?.items?.data) ? sub.items.data : [];
  return items.length > 0 && items.every((it) => planForPrice(it?.price) !== null);
}

/** A stored customer as Stripe has it: GenClass's for this account (with its subscriptions), gone, or not GenClass's. */
export type CustomerCheck = { state: "ok"; subs: Obj[] } | { state: "missing" } | { state: "not_genclass" };

/**
 * Check the customer accounts.stripe_customer_id names before GenClass opens a Stripe page for it, starts a Checkout
 * on it or cancels anything on it: it must be a customer GenClass made for this account (metadata genclass=1 and
 * genclass_account naming the account). A row written before customers were marked, or by hand, may name someone
 * else's customer, which is then left alone. "missing": Stripe no longer has it (deleted, or from the other mode).
 */
export async function checkCustomer(env: Env, f: Fetch, accountId: string, customer: string): Promise<CustomerCheck> {
  let c: Obj;
  try {
    c = await stripe(env, f, "GET", `/v1/customers/${encodeURIComponent(customer)}`);
  } catch (e) {
    if (missingCustomer(e)) return { state: "missing" };
    throw e;
  }
  if (c?.deleted === true) return { state: "missing" };
  if (c?.metadata?.genclass !== GENCLASS_MARK || c?.metadata?.genclass_account !== accountId) return { state: "not_genclass" };
  return { state: "ok", subs: await customerSubscriptions(env, f, customer) };
}

/**
 * Something that is not GenClass's is on its customer: a subscription (any status) with a price that is not provably
 * GenClass's, for instance a Polar Parts subscription attached to the customer by an email lookup on Polar Parts' side.
 * GenClass then opens no Stripe page for that customer.
 */
export const sharedCustomer = (subs: Obj[]): boolean => subs.some((s) => !isGenClassSubscription(s));

/**
 * An invoice on the customer that is not for one of its GenClass subscriptions (`subs`, from checkCustomer): a Billing
 * Portal session would list it under GenClass's headline. Reads the customer's latest 100 invoices; only called for a
 * customer checkCustomer found to be GenClass's.
 */
export async function foreignInvoice(env: Env, f: Fetch, customer: string, subs: Obj[]): Promise<boolean> {
  const mine = new Set(subs.filter(isGenClassSubscription).map((s) => s.id as string));
  const r = await stripe(env, f, "GET", "/v1/invoices", { customer, limit: 100 });
  return (Array.isArray(r?.data) ? (r.data as Obj[]) : []).some((inv) => !mine.has(invoiceSubscription(inv) ?? ""));
}

/** A Checkout Session GenClass created for this account (metadata genclass=1 and genclass_account). */
const ownSession = (x: Obj, accountId: string): boolean => x?.metadata?.genclass === GENCLASS_MARK && x?.metadata?.genclass_account === accountId;

/**
 * This plan's Checkout uses Stripe Managed Payments: the plan is eligible (billing/plans.json managed_payments, Pro
 * only) and the Worker var MANAGED_PAYMENTS is "on" (or true, 1, yes). Unset, or anything else, is off: wrangler.toml
 * says "off" until the owner has accepted the Managed Payments terms and a test-mode Pro checkout with it on went
 * through with the pinned API version.
 */
export function managedPayments(env: Env, plan: Plan): boolean {
  if (plan.managed_payments !== true) return false;
  return /^(on|true|1|yes)$/i.test((env.MANAGED_PAYMENTS ?? "").trim());
}

/**
 * A Checkout Session in subscription mode for one plan's monthly price, for the account's own GenClass customer, with
 * metadata genclass=1, genclass_account and genclass_plan (the subscription it starts carries genclass and
 * genclass_account), flexible billing mode, and Managed Payments when managedPayments says so (then nothing Managed
 * Payments refuses is sent: no automatic_tax, tax_id_collection, payment_method_types, customer_update or invoice
 * settings). `switchFrom`: the GenClass subscription this one replaces (metadata genclass_switch_from on the session
 * and the subscription; the webhook cancels it once the new one is active). Returns Stripe's page URL. Unless the
 * customer is `fresh`, its open Checkout pages are looked at first: GenClass's page for this plan and this switch is
 * reused (a second click, or a second tab), any other page of GenClass's is closed, so an abandoned tab cannot start a
 * second subscription later. A page GenClass did not make is left alone.
 */
export async function checkoutSession(
  env: Env,
  f: Fetch,
  o: { account: BillingAccount; customer: string; plan: Plan; origin: string; now: Date; fresh?: boolean; switchFrom?: string },
): Promise<string> {
  const lookup = o.plan.stripe_lookup_keys.monthly;
  if (!lookup) throw new StripeError(`the ${o.plan.name} plan has no monthly price`, 400);
  if (o.switchFrom !== undefined && !idOf(o.switchFrom)) throw new StripeError("not a subscription id", 400);
  const closed: string[] = [];
  if (!o.fresh) {
    const open = await stripe(env, f, "GET", "/v1/checkout/sessions", { customer: o.customer, status: "open", limit: 20 });
    for (const x of Array.isArray(open?.data) ? (open.data as Obj[]) : []) {
      if (typeof x?.id !== "string" || !SESSION_ID_RE.test(x.id) || !ownSession(x, o.account.id)) continue;
      const same = x.metadata?.genclass_plan === o.plan.id && (x.metadata?.genclass_switch_from ?? undefined) === o.switchFrom;
      if (same && typeof x.url === "string" && x.url.startsWith("https://")) return x.url;
      await stripe(env, f, "POST", `/v1/checkout/sessions/${encodeURIComponent(x.id)}/expire`, {});
      closed.push(x.id);
    }
  }
  const price = await priceId(env, f, lookup, o.now.getTime(), o.plan);
  const mark: Record<string, string> = { genclass: GENCLASS_MARK, genclass_account: o.account.id };
  if (o.switchFrom) mark.genclass_switch_from = o.switchFrom;
  // a double click within the same minute gets the same session; after closing pages, a new key (the old session
  // under the plain key may be one of those just closed); a switch has its own
  const after = closed.length ? `-after-${(await sha256Hex(closed.join(","))).slice(0, 16)}` : "";
  const from = o.switchFrom ? `-from-${o.switchFrom}` : "";
  let s: Obj;
  try {
    s = await stripe(
      env,
      f,
      "POST",
      "/v1/checkout/sessions",
      {
        mode: "subscription",
        customer: o.customer,
        client_reference_id: o.account.id,
        line_items: [{ price, quantity: 1 }],
        // back from a switch, the page waits for the new plan
        success_url: `${o.origin}/account/billing?done=1${o.switchFrom ? `&to=${o.plan.id}` : ""}`,
        cancel_url: `${o.origin}/account/billing`,
        metadata: { ...mark, genclass_plan: o.plan.id },
        subscription_data: { metadata: mark, billing_mode: { type: "flexible" } },
        managed_payments: managedPayments(env, o.plan) ? { enabled: true } : undefined,
      },
      `genclass-checkout-${o.account.id}-${o.plan.id}-${Math.floor(o.now.getTime() / 60_000)}${from}${after}`,
    );
  } catch (e) {
    priceCache.delete(lookup); // the cached price may have been replaced since
    throw e;
  }
  if (typeof s.url !== "string" || !s.url.startsWith("https://")) throw new StripeError("Stripe did not return a checkout page", 502);
  return s.url;
}

/**
 * A Billing Portal session on GenClass's own portal configuration (never the account's default): card, invoices,
 * email and tax id, cancel at period end. It offers no plan switch (scripts/stripe-setup.mjs): a Managed Payments
 * subscription cannot take the Custom price, so a switch is a new Checkout (src/billing.ts checkout). The portal shows
 * and acts on everything on the customer, so the caller first checks that it all is GenClass's (src/billing.ts portal).
 */
export async function portalSession(env: Env, f: Fetch, o: { customer: string; origin: string; now: Date }): Promise<string> {
  const configuration = await portalConfiguration(env, f, o.now.getTime());
  const s = await stripe(env, f, "POST", "/v1/billing_portal/sessions", { customer: o.customer, return_url: `${o.origin}/account/billing`, configuration });
  if (typeof s.url !== "string" || !s.url.startsWith("https://")) throw new StripeError("Stripe did not return a billing page", 502);
  return s.url;
}

/**
 * Cancel a subscription at once, with no proration and no final invoice (Stripe's defaults: nothing goes to the
 * customer's balance; a switch or a duplicate is refunded to the card instead, refundUnused). A subscription Stripe
 * no longer has counts as done; after any other refusal (400) the subscription is read back, and only one that is
 * canceled or incomplete_expired counts as done: anything else throws, so the webhook answers 500 and Stripe retries.
 */
export async function cancelNow(env: Env, f: Fetch, subscriptionId: string): Promise<void> {
  const path = `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`;
  try {
    await stripe(env, f, "DELETE", path);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return;
    if (e instanceof StripeError && e.status === 400) {
      const now = await stripe(env, f, "GET", path).catch(() => null);
      if (now && ENDED_STATUSES.has(now.status)) return;
    }
    throw e;
  }
}

/**
 * Close the account's own open Checkout pages (metadata genclass=1 and genclass_account), so none can start a
 * subscription later: before an account is deleted. A page GenClass did not make is left alone.
 */
async function expireOwnSessions(env: Env, f: Fetch, customer: string, accountId: string): Promise<void> {
  const open = await stripe(env, f, "GET", "/v1/checkout/sessions", { customer, status: "open", limit: 20 });
  for (const x of Array.isArray(open?.data) ? (open.data as Obj[]) : []) {
    if (typeof x?.id !== "string" || !SESSION_ID_RE.test(x.id) || !ownSession(x, accountId)) continue;
    await stripe(env, f, "POST", `/v1/checkout/sessions/${encodeURIComponent(x.id)}/expire`, {});
  }
}

/**
 * Before an account is deleted: cancel at once every GenClass subscription of its Stripe customer that could still
 * charge it, not only the one GenClass recorded (a second one, or one whose webhook has not arrived yet). Only what
 * Stripe lists on the account's own GenClass customer (checkCustomer) and is provably GenClass's is cancelled: never a
 * subscription by its recorded id alone, which a price swapped in by hand could have made another business's. With no
 * customer on record, a recorded subscription is fetched and cancelled only when it is GenClass's and its customer
 * names the account. The account's own open Checkout pages are closed first, so none can start a subscription after
 * the account is gone. Returns null when nothing GenClass sold can charge the account any more, else why the deletion
 * has to wait.
 */
export async function cancelForDeletion(env: Env, f: Fetch, b: Billing, accountId: string): Promise<{ status: number; error: string } | null> {
  if (!b.stripe_customer_id && !b.subscription_id) return null;
  const mode = stripeMode(env);
  const recordedLive = !!b.subscription_id && HOLDING_STATUSES.has(b.subscription_status ?? "");
  if (b.stripe_mode === "test" && mode !== "test") return null; // test mode: no real money
  if (!mode || (b.stripe_mode && b.stripe_mode !== mode)) {
    // live-mode records and no live key to reach them: refuse rather than leave a plan charging a deleted account
    return recordedLive
      ? { status: 503, error: `your paid plan could not be cancelled because payments are switched off on this server, so the account was not deleted; email ${PLANS_FILE.contact}` }
      : null;
  }
  try {
    const ids = new Set<string>();
    if (b.stripe_customer_id) {
      const own = await checkCustomer(env, f, accountId, b.stripe_customer_id);
      if (own.state === "not_genclass") {
        // someone else's customer on record: nothing on it is GenClass's to cancel; a recorded plan needs a person
        if (!recordedLive) return null;
        console.log(`account deletion: account ${accountId}: Stripe customer ${b.stripe_customer_id} is not GenClass's; nothing cancelled`);
        return { status: 409, error: `your paid plan could not be cancelled automatically, so the account was not deleted; email ${PLANS_FILE.contact}` };
      }
      // missing: a deleted customer's subscriptions and pages went with it
      if (own.state === "ok") {
        await expireOwnSessions(env, f, b.stripe_customer_id, accountId);
        for (const s of own.subs) if (!ENDED_STATUSES.has(s.status) && isGenClassSubscription(s)) ids.add(s.id);
      }
    } else if (b.subscription_id && recordedLive) {
      let s: Obj | null = null;
      try {
        s = await stripe(env, f, "GET", `/v1/subscriptions/${encodeURIComponent(b.subscription_id)}`, { expand: ["items.data.price.product", "customer"] });
      } catch (e) {
        if (!(e instanceof StripeError && e.status === 404)) throw e;
      }
      if (s && idOf(s.id) && !ENDED_STATUSES.has(s.status) && isGenClassSubscription(s) && s.customer?.metadata?.genclass_account === accountId) ids.add(s.id);
    }
    for (const id of ids) await cancelNow(env, f, id);
    return null;
  } catch (e) {
    if (e instanceof StripeError) return { status: 502, error: "your paid plan could not be cancelled with Stripe, so the account was not deleted; try again in a minute" };
    throw e;
  }
}

// --------------------------------------------------------------------------------------------- webhook signature

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Check a Stripe-Signature header ("t=<unix>,v1=<hex>[,v1=<hex>...][,v0=...]") against the raw body. Returns "ok" or
 * why it failed.
 */
export async function verifySignature(payload: Uint8Array, header: string | null, secret: string, nowSec: number, toleranceS = WEBHOOK_TOLERANCE_S): Promise<"ok" | string> {
  if (!header || header.length > 4096) return "no Stripe-Signature header";
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && t === null) t = v;
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  if (t === null || !/^\d{1,12}$/.test(t)) return "no timestamp";
  if (!v1.length) return "no v1 signature";
  if (Math.abs(nowSec - Number(t)) > toleranceS) return "timestamp outside the 5-minute tolerance";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const head = new TextEncoder().encode(`${t}.`);
  const signed = new Uint8Array(head.length + payload.length);
  signed.set(head);
  signed.set(payload, head.length);
  const expected = hex(await crypto.subtle.sign("HMAC", key, signed));
  let ok = false;
  for (const s of v1) ok = equalStrings(s, expected) || ok; // compare every one: no early exit
  return ok ? "ok" : "signature does not match";
}

// --------------------------------------------------------------------------------------------- plan from a subscription

export interface SubscriptionState {
  plan: PlanId;
  /** The plan the subscription's price sells, whatever its status (null: a price GenClass does not know). */
  priced: PlanId | null;
  status: string;
  lookupKey: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

const isoOf = (s: unknown): string | null => (typeof s === "number" && Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : null);

/**
 * What a subscription means for the account (pure; exported for tests). With `pastDueSince` and `now`, a past_due
 * subscription past its grace (src/plans.ts PAST_DUE_GRACE_DAYS) gives Free.
 */
export function subscriptionState(sub: Obj, o: { pastDueSince?: string | null; now?: Date } = {}): SubscriptionState {
  const status = typeof sub?.status === "string" ? sub.status : "";
  const items: Obj[] = Array.isArray(sub?.items?.data) ? sub.items.data : [];
  let priced: Plan | null = null;
  let lookupKey: string | null = null;
  for (const it of items) {
    const k = it?.price?.lookup_key;
    // a genclass_ lookup key and the product's genclass_plan metadata (a price the setup script replaced keeps its
    // product and gets a genclass_..._retired_ key, so its subscribers keep their plan)
    const p = planForPrice(it?.price);
    if (p) {
      priced = p;
      lookupKey = typeof k === "string" ? k : null;
      break;
    }
    if (typeof k === "string" && !lookupKey) lookupKey = k;
  }
  // API versions before 2025-03-31 put the period on the subscription, later ones on its items
  const itemEnds = items.map((it) => it?.current_period_end).filter((x): x is number => typeof x === "number");
  const ended = (status === "canceled" || status === "incomplete_expired") && typeof sub?.ended_at === "number" ? sub.ended_at : null;
  const end =
    ended ?? (typeof sub?.cancel_at === "number" ? sub.cancel_at : typeof sub?.current_period_end === "number" ? sub.current_period_end : itemEnds.length ? Math.max(...itemEnds) : null);
  const lapsed = status === "past_due" && !!o.now && pastDueLapsed(o.pastDueSince, o.now);
  return {
    plan: priced && LIVE_STATUSES.has(status) && !lapsed ? priced.id : "free",
    priced: priced?.id ?? null,
    status,
    lookupKey,
    periodEnd: isoOf(end),
    cancelAtPeriodEnd: status !== "canceled" && (sub?.cancel_at_period_end === true || typeof sub?.cancel_at === "number"),
  };
}

// --------------------------------------------------------------------------------------------- events

export interface EventResult {
  status: "applied" | "ignored";
  /** The event is about a GenClass customer (it passed the checks that need no Stripe call): it is recorded. */
  ours: boolean;
  reason?: string;
  account?: string;
  plan?: PlanId;
}

const idOf = (v: unknown): string | null => {
  const s = typeof v === "string" ? v : v && typeof v === "object" ? (v as Obj).id : null;
  return typeof s === "string" && STRIPE_ID_RE.test(s) ? s : null;
};

const ACCOUNT_BILLING_COLUMNS = "id, email, plan, stripe_customer_id, subscription_id, subscription_status, stripe_mode, past_due_since";

/** The account whose GenClass customer this is (only ensureCustomer writes stripe_customer_id), or null. */
async function accountByCustomer(db: D1Like, customer: string | null): Promise<BillingAccount | null> {
  if (!customer) return null;
  return db.prepare(`SELECT ${ACCOUNT_BILLING_COLUMNS} FROM accounts WHERE stripe_customer_id = ?`).bind(customer).first<BillingAccount>();
}

/**
 * The subscription (fetched with its customer expanded) is the account's: its customer is the account's GenClass
 * customer and that customer's metadata genclass_account names the account (a customer deleted in Stripe keeps no
 * metadata; the account row, written only by ensureCustomer, names it then), and the subscription's own metadata, if
 * it names an account, names this one. One more case: the subscription recorded for the account has ended and its
 * customer's metadata names no account at all. Stripe erases a buyer's data when they ask (Managed Payments data
 * deletion cancels their subscriptions), and that end must still reach the account; ending a plan can only take
 * entitlements away.
 */
function accountsSubscription(account: BillingAccount, sub: Obj): boolean {
  const c = sub?.customer;
  if (!account.stripe_customer_id || idOf(c) !== account.stripe_customer_id || !c || typeof c !== "object") return false;
  if (c.deleted !== true && c.metadata?.genclass_account !== account.id) {
    const erased = c.metadata?.genclass_account === undefined || c.metadata?.genclass_account === null || c.metadata?.genclass_account === "";
    if (!(erased && idOf(sub?.id) === account.subscription_id && ENDED_STATUSES.has(sub?.status))) return false;
  }
  const named = sub?.metadata?.genclass_account;
  return named === undefined || named === null || named === account.id;
}

/**
 * From the event alone, the subscription could be GenClass's: the one recorded for the account, or one with GenClass's
 * metadata (every subscription GenClass's Checkout starts has it) or a genclass_ lookup key on a price. Anything else
 * on a GenClass customer (another business's subscription put on it) is neither fetched nor stored.
 */
function maybeGenClass(obj: Obj, account: BillingAccount): boolean {
  const id = idOf(obj?.id);
  if (id && id === account.subscription_id) return true;
  if (obj?.metadata?.genclass === GENCLASS_MARK) return true;
  const items: Obj[] = Array.isArray(obj?.items?.data) ? obj.items.data : [];
  return items.some((it) => typeof it?.price?.lookup_key === "string" && it.price.lookup_key.startsWith(LOOKUP_PREFIX));
}

/** The subscription an invoice is for (the field moved in API version 2025-03-31), or null for a one-off invoice. */
export function invoiceSubscription(inv: Obj): string | null {
  return idOf(inv?.subscription) ?? idOf(inv?.parent?.subscription_details?.subscription) ?? idOf(inv?.lines?.data?.[0]?.subscription) ?? idOf(inv?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription);
}

/** An event left alone; `ours`: about a GenClass customer (recorded in billing_events), else not stored at all. */
const ignored = (reason: string, event: Obj, ours = false): EventResult => {
  console.log(`stripe webhook: ${String(event?.type)} ${String(event?.id)} ignored: ${reason}`);
  return { status: "ignored", ours, reason };
};

export interface EventContext {
  env: Env;
  db: D1Like;
  fetch: Fetch;
  now: Date;
}

/** The price id of an invoice line (API 2025-03-31 moved it under pricing.price_details). */
const linePrice = (line: Obj): string | null => {
  const v = line?.pricing?.price_details?.price ?? line?.price?.id ?? line?.price ?? line?.plan?.id;
  return typeof v === "string" ? v : null;
};

/**
 * The invoice charges for the Custom plan: a line with a positive amount on one of the subscription's Custom prices (a
 * first Custom invoice, a switch from Pro's included, or a Custom price swapped in by hand and invoiced at once).
 * Exported for tests.
 */
export function invoicePaysCustom(inv: Obj, sub: Obj): boolean {
  const custom = new Set<string>();
  for (const it of Array.isArray(sub?.items?.data) ? (sub.items.data as Obj[]) : []) {
    if (planForPrice(it?.price)?.id === "custom" && typeof it?.price?.id === "string") custom.add(it.price.id);
  }
  const lines: Obj[] = Array.isArray(inv?.lines?.data) ? inv.lines.data : [];
  return lines.some((l) => typeof l?.amount === "number" && l.amount > 0 && custom.has(linePrice(l) ?? ""));
}

/**
 * Stripe reports the subscription's Custom price paid: its latest invoice (expanded by fetchSubscription) is paid,
 * is the subscription's own, and charges a Custom price (invoicePaysCustom). Exported for tests.
 */
export function latestInvoicePaysCustom(sub: Obj): boolean {
  const inv = sub?.latest_invoice;
  if (!inv || typeof inv !== "object" || inv.status !== "paid") return false;
  return invoiceSubscription(inv) === idOf(sub?.id) && invoicePaysCustom(inv, sub);
}

/**
 * The subscription's latest invoice (expanded) is paid, or asks for nothing: its payment cleared. Stripe can make a
 * subscription active while that payment is still processing (a bank debit), so a subscription GenClass has not
 * granted yet counts only once this holds. Exported for tests.
 */
export function paymentCleared(sub: Obj): boolean {
  const inv = sub?.latest_invoice;
  return !!inv && typeof inv === "object" && (inv.status === "paid" || inv.amount_due === 0);
}

/** The account already has this subscription, live: its plan was granted from it. */
const granted = (account: BillingAccount, sub: Obj): boolean => !!account.subscription_id && idOf(sub?.id) === account.subscription_id && LIVE_STATUSES.has(account.subscription_status ?? "");

/**
 * GET a subscription of a GenClass customer with its prices' products (whose metadata says the plan), its customer
 * (whose metadata says the account) and its latest invoice (whether the Custom price is paid). Only called once the
 * event has passed the check that needs no Stripe call.
 */
const fetchSubscription = (x: EventContext, id: string): Promise<Obj> =>
  stripe(x.env, x.fetch, "GET", `/v1/subscriptions/${encodeURIComponent(id)}`, { expand: ["items.data.price.product", "customer", "latest_invoice"] });

/**
 * Apply one verified Stripe event. Throws on a Stripe or database error (the webhook then answers 500).
 *
 * The endpoint gets its events (WEBHOOK_EVENTS) for the whole Stripe account. Before any Stripe call the event must be
 * about a customer the accounts table names (only ensureCustomer writes one), and its subscription must look like
 * GenClass's (maybeGenClass; for an invoice, the subscription's id and the metadata the invoice copies from it).
 * Anything else is ignored with no Stripe call and is not stored (ignored() logs its type and id only). A dispute names
 * no customer, so its charge is read first (chargeNotice). Then the subscription is fetched and must be provably
 * GenClass's (isGenClassSubscription, or the one already recorded for the account) and the account's
 * (accountsSubscription) before anything is written. A subscription the account has not been granted yet counts only
 * once its first payment cleared (paymentCleared): until then nothing changes, and invoice.paid brings it back. When
 * it starts billing and the customer holds another GenClass subscription that bills (a switch, or a duplicate), the
 * one kept is written to the account first, and the others are refunded and cancelled only after that
 * (oneSubscription, settleOthers).
 */
export async function handleEvent(x: EventContext, event: Obj): Promise<EventResult> {
  const type = event?.type;
  const obj: Obj = event?.data?.object ?? {};
  if (!WEBHOOK_EVENTS.includes(type)) return ignored("event type not handled", event);
  if (type === "charge.refunded" || type === "charge.dispute.created") return chargeNotice(x, event, obj);
  const account = await accountByCustomer(x.db, idOf(obj.customer));
  if (!account) return ignored("not a GenClass customer", event);
  let subId: string | null;
  if (type === "invoice.paid") {
    // only the subscription's id (and the mark the invoice copies from its metadata) is read from the invoice
    subId = invoiceSubscription(obj);
    if (!subId) return ignored("not a subscription's invoice", event);
    if (subId !== account.subscription_id && obj?.parent?.subscription_details?.metadata?.genclass !== GENCLASS_MARK) return ignored("not a GenClass subscription", event);
  } else {
    if (!maybeGenClass(obj, account)) return ignored("not a GenClass subscription", event);
    subId = idOf(obj.id);
    if (!subId) return ignored("no subscription", event, true);
  }
  // from here on the event is about a GenClass customer and maybe GenClass's subscription
  // the subscription as it is now, so the order events arrive in does not matter
  let sub = await fetchSubscription(x, subId);
  if (!accountsSubscription(account, sub)) return ignored("the subscription is not the account's", event, true);
  // the subscription already recorded for the account stays readable whatever its price now says (it then counts as
  // Free); any other must be provably GenClass's
  if (!isGenClassSubscription(sub) && idOf(sub?.id) !== account.subscription_id) return ignored("not a GenClass subscription", event, true);
  // a new subscription is granted only once its first payment cleared: never on "active" alone
  if (!granted(account, sub) && LIVE_STATUSES.has(sub?.status) && !paymentCleared(sub)) return ignored("its first payment has not cleared yet", event, true);
  // a subscription that starts billing (created, its status changed, or an invoice of it paid)
  const prev = event?.data?.previous_attributes;
  const started =
    type === "invoice.paid" || type === "customer.subscription.created" || (type === "customer.subscription.updated" && !!prev && typeof prev === "object" && "status" in prev);
  const one = started ? await oneSubscription(x, account, sub) : null;
  if (one) sub = one.keep;
  // the subscription kept is on the account before any other is cancelled: never without a plan
  const result = await applySubscription(x, account, sub, event, !!one);
  // a Custom purchase counts once Stripe reports it paid
  if (result.status === "applied" && result.plan === "custom" && latestInvoicePaysCustom(sub)) await recordCustom(x, account, idOf(sub.id)!);
  if (one?.extra.length && result.status === "applied") await settleOthers(x, account, one);
  return result;
}

/** A refunded or disputed charge of a GenClass customer: the owner is told, with ids and amounts only. */
async function chargeNotice(x: EventContext, event: Obj, obj: Obj): Promise<EventResult> {
  const refund = event.type === "charge.refunded";
  const charge = refund ? idOf(obj.id) : idOf(obj.charge);
  let customer = idOf(obj.customer);
  if (!refund) {
    // a dispute names no customer; its charge does (read for that alone)
    if (!charge) return ignored("no charge", event);
    try {
      customer = idOf((await stripe(x.env, x.fetch, "GET", `/v1/charges/${encodeURIComponent(charge)}`))?.customer);
    } catch (e) {
      if (e instanceof StripeError && e.status === 404) return ignored("its charge is not in this Stripe account", event);
      throw e;
    }
  }
  const account = await accountByCustomer(x.db, customer);
  if (!account) return ignored("not a GenClass customer", event);
  const amount = Number(refund ? obj.amount_refunded : obj.amount) || 0;
  const currency = typeof obj.currency === "string" ? obj.currency : "usd";
  await notifyOwner(x, {
    event: refund ? "charge_refunded" : "charge_disputed",
    text: refund
      ? `${modeNote(x.env)}GenClass account ${account.id}: charge ${charge} refunded, ${money(amount, currency)} in all so far. A switch refunds the unused part of the old plan, and Stripe (Link support, for Pro) can refund a payment too: check that nothing is refunded twice.`
      : `${modeNote(x.env)}GenClass account ${account.id}: charge ${charge} disputed (${idOf(obj.id)}, ${money(amount, currency)}). Stripe answers disputes on payments sold through Managed Payments; for the others, answer it in the Stripe dashboard.`,
    account_id: account.id,
    charge,
    ...(refund ? {} : { dispute: idOf(obj.id) }),
    amount,
    currency,
  });
  return { status: "applied", ours: true, account: account.id };
}

const money = (cents: number, currency: string): string => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;

type SettleKind = "switch" | "duplicate";

interface OneSubscription {
  /** The subscription the account keeps (fetched like fetchSubscription). */
  keep: Obj;
  /** The other GenClass subscriptions of the customer that bill, to refund and cancel at once: the one a switch
   * replaces, or an accidental duplicate. */
  extra: { sub: Obj; kind: SettleKind }[];
}

/** The plan's rank when two subscriptions were bought by accident: Custom over Pro. */
const rank = (s: Obj): number => PLAN_RANK[subscriptionState(s).priced ?? ""] ?? 0;
const PLAN_RANK: Record<string, number> = { pro: 1, custom: 2 };

/**
 * When a subscription starts billing: if the account's GenClass customer now has more than one GenClass subscription
 * that bills and is either the account's granted one or paid for (a switch paid, two tabs paid, or an old Checkout
 * page completed after a purchase), the account keeps one. A switch keeps the subscription whose genclass_switch_from
 * names another of them (the newest such); the one it names is the switch's old plan. Otherwise (a duplicate) a live
 * one before one that is unpaid or paused, then the higher plan (Custom over Pro), then the newest. A new subscription
 * whose first payment has not cleared is not counted: it neither replaces nor is cancelled until it clears. Only
 * GenClass subscriptions are counted. When it is the only one that bills, it is chosen with nothing to settle; null
 * when it is not live or not GenClass's. The caller applies `keep` first and then settles `extra` (settleOthers).
 */
async function oneSubscription(x: EventContext, account: BillingAccount, sub: Obj): Promise<OneSubscription | null> {
  const customer = idOf(sub?.customer);
  if (!customer || customer !== account.stripe_customer_id || !LIVE_STATUSES.has(sub?.status) || !isGenClassSubscription(sub)) return null;
  const all = await customerSubscriptions(x.env, x.fetch, customer);
  const holding = all.filter((s) => HOLDING_STATUSES.has(s.status) && isGenClassSubscription(s) && (granted(account, s) || paymentCleared(s)));
  // the only one that bills (Stripe may have ended the account's recorded one before its event arrived): it is chosen
  if (holding.length < 2) return { keep: sub, extra: [] };
  const newest = (a: Obj, b: Obj): number => (Number(b.created) || 0) - (Number(a.created) || 0) || String(b.id).localeCompare(String(a.id));
  const switches = holding.filter((s) => LIVE_STATUSES.has(s.status) && holding.some((o) => o.id !== s.id && o.id === s.metadata?.genclass_switch_from)).sort(newest);
  let first: Obj;
  if (switches.length) first = switches[0]!;
  else {
    const live = (s: Obj): number => (LIVE_STATUSES.has(s.status) ? 1 : 0);
    first = [...holding].sort((a, b) => live(b) - live(a) || rank(b) - rank(a) || newest(a, b))[0]!;
  }
  const keep = first.id === idOf(sub.id) ? sub : await fetchSubscription(x, first.id);
  if (!accountsSubscription(account, keep)) {
    console.log(`stripe webhook: account ${account.id}: subscription ${first.id} is not the account's; nothing cancelled`);
    return null;
  }
  const extra = holding.filter((s) => s.id !== first.id).map((s) => ({ sub: s, kind: (s.id === keep.metadata?.genclass_switch_from ? "switch" : "duplicate") as SettleKind }));
  return { keep, extra };
}

interface Refunded {
  subscription: string;
  kind: SettleKind;
  refund: string | null;
  amount: number;
  currency: string | null;
  /** Why nothing was refunded. */
  note?: string;
}

/**
 * Refund a subscription GenClass is about to cancel, to the payment method that paid it: for a switch, the unused part
 * of its latest paid invoice (its total times the share of the paid period left, counted from the current hour); for
 * a duplicate, that invoice in full. Never a balance credit: Pro's invoices are issued through Link (Managed Payments)
 * and Custom's by GenClass, so a credit could be stranded or pay the other issuer's invoice. Idempotent: a refund
 * GenClass already made for it (metadata genclass_refund) is found and not made again, and the request carries an
 * idempotency key. A refusal (already refunded by Stripe or Link support, say) is reported, not retried.
 */
async function refundFor(x: EventContext, account: BillingAccount, sub: Obj, kind: SettleKind): Promise<Refunded> {
  const out: Refunded = { subscription: String(sub.id), kind, refund: null, amount: 0, currency: null };
  const list = await stripe(x.env, x.fetch, "GET", "/v1/invoices", { subscription: sub.id, status: "paid", limit: 1 });
  const inv: Obj | undefined = Array.isArray(list?.data) ? list.data[0] : undefined;
  if (!inv || typeof inv.id !== "string") return { ...out, note: "it has no paid invoice" };
  const currency = typeof inv.currency === "string" ? inv.currency : "usd";
  const paid = Number(inv.amount_paid) || 0;
  let amount = paid;
  if (kind === "switch") {
    const lines: Obj[] = Array.isArray(inv.lines?.data) ? inv.lines.data : [];
    const period = lines.find((l) => Number(l?.amount) > 0 && typeof l?.period?.start === "number" && typeof l?.period?.end === "number")?.period;
    const at = Math.floor(x.now.getTime() / 3_600_000) * 3600; // the same amount for every retry within the hour
    amount = period && period.end > period.start ? Math.floor((paid * Math.min(Math.max(period.end - at, 0), period.end - period.start)) / (period.end - period.start)) : 0;
  }
  if (amount <= 0) return { ...out, currency, note: kind === "switch" ? "no unused time is left on it" : "its latest invoice was not charged" };
  const pays = await stripe(x.env, x.fetch, "GET", "/v1/invoice_payments", { invoice: inv.id, status: "paid", limit: 10 });
  const pay: Obj | undefined = (Array.isArray(pays?.data) ? (pays.data as Obj[]) : []).map((p) => p?.payment).find((p) => idOf(p?.payment_intent) || idOf(p?.charge));
  const to: Record<string, string> | null = idOf(pay?.payment_intent) ? { payment_intent: idOf(pay!.payment_intent)! } : idOf(pay?.charge) ? { charge: idOf(pay!.charge)! } : null;
  if (!to) return { ...out, currency, note: "its invoice was not paid with a payment method Stripe can refund to" };
  const tag = `${kind}:${sub.id}`;
  const before = await stripe(x.env, x.fetch, "GET", "/v1/refunds", { ...to, limit: 100 });
  const done = (Array.isArray(before?.data) ? (before.data as Obj[]) : []).find((r) => r?.metadata?.genclass_refund === tag && r.status !== "failed" && r.status !== "canceled");
  if (done) return { ...out, refund: idOf(done.id), amount: Number(done.amount) || 0, currency };
  try {
    const r = await stripe(
      x.env,
      x.fetch,
      "POST",
      "/v1/refunds",
      { ...to, amount, reason: kind === "duplicate" ? "duplicate" : "requested_by_customer", metadata: { genclass: GENCLASS_MARK, genclass_account: account.id, genclass_refund: tag, genclass_invoice: inv.id } },
      `genclass-refund-${tag}-${inv.id}-${amount}`,
    );
    return { ...out, refund: idOf(r?.id), amount, currency };
  } catch (e) {
    if (e instanceof StripeError && e.status === 400) return { ...out, currency, note: `Stripe refused the refund (${e.message})` };
    throw e;
  }
}

/**
 * Settle the subscriptions the account does not keep, after the kept one is on the account: each is refunded to its
 * payment method (refundFor: the unused time for a switch's old plan, the latest payment for a duplicate), then
 * cancelled at once with no balance credit. Refund first: a retry after a failed cancellation finds the refund made.
 * The owner is always told (plan_switch, or duplicate_subscription), with the refunds and anything to refund by hand.
 */
async function settleOthers(x: EventContext, account: BillingAccount, o: OneSubscription): Promise<void> {
  const refunds: Refunded[] = [];
  for (const { sub, kind } of o.extra) {
    refunds.push(await refundFor(x, account, sub, kind));
    await cancelNow(x.env, x.fetch, sub.id);
  }
  const switched = o.extra.some((e) => e.kind === "switch");
  const ids = o.extra.map((e) => e.sub.id).join(", ");
  console.log(`stripe webhook: account ${account.id} ${switched ? "switched plans" : `had ${o.extra.length + 1} subscriptions`}; kept ${o.keep.id}, cancelled ${ids}`);
  const each = refunds
    .map((r) => (r.refund ? `${r.subscription}: refunded ${money(r.amount, r.currency ?? "usd")} to the card (${r.refund})` : `${r.subscription}: not refunded, because ${r.note}; refund by hand if anything is due`))
    .join("; ");
  await notifyOwner(x, {
    event: switched ? "plan_switch" : "duplicate_subscription",
    text: `${modeNote(x.env)}GenClass account ${account.id} ${switched ? "switched plans" : "paid for a second subscription"}. Kept ${o.keep.id}; cancelled ${ids}. ${each}. Stripe (Link support, for Pro) can also refund a payment within 60 days of it: a charge_refunded notice would show it.`,
    account_id: account.id,
    kept: o.keep.id,
    cancelled: o.extra.map((e) => e.sub.id),
    refunds,
  });
}

/**
 * Write a subscription's state to its account (the caller has checked that it is the account's GenClass
 * subscription). past_due_since keeps the time GenClass first saw this subscription past due, so the grace runs from
 * there whatever events follow. Another subscription than the account's current one is written only when
 * oneSubscription chose it (`chosen`), or when it is live and the current one has ended (a purchase after a cancelled
 * plan): an event about an older or duplicate subscription never overwrites a live plan.
 */
export async function applySubscription(x: EventContext, account: BillingAccount, sub: Obj, event: Obj = {}, chosen = false): Promise<EventResult> {
  const subId = idOf(sub?.id);
  if (!subId) return ignored("the subscription has no id", event, true);
  const customer = idOf(sub?.customer);
  if (!customer || customer !== account.stripe_customer_id) return ignored("the subscription belongs to another Stripe customer than the account's", event, true);
  const status = typeof sub?.status === "string" ? sub.status : "";
  const pastDueSince =
    status !== "past_due"
      ? null
      : account.subscription_id === subId && account.subscription_status === "past_due" && account.past_due_since
        ? account.past_due_since
        : x.now.toISOString();
  const s = subscriptionState(sub, { pastDueSince, now: x.now });
  if (account.subscription_id && account.subscription_id !== subId && !chosen && (!LIVE_STATUSES.has(s.status) || LIVE_STATUSES.has(account.subscription_status ?? ""))) {
    // an older subscription ending while the account has another one, or one that is not the one chosen
    return ignored("not the account's current subscription", event, true);
  }
  if (s.priced === null) console.log(`stripe webhook: ${String(event?.type)} ${String(event?.id)}: subscription ${subId} no longer has a GenClass price; plan set to free`);
  await x.db
    .prepare(
      "UPDATE accounts SET plan = ?, subscription_id = ?, subscription_status = ?, past_due_since = ?, current_period_end = ?, cancel_at_period_end = ?, " +
        "stripe_mode = ? WHERE id = ? AND stripe_customer_id = ?",
    )
    .bind(s.plan, subId, s.status, pastDueSince, s.periodEnd, s.cancelAtPeriodEnd ? 1 : 0, stripeMode(x.env), account.id, customer)
    .run();
  return { status: "applied", ours: true, account: account.id, plan: s.plan };
}

export const modeNote = (env: Env): string => (stripeMode(env) === "test" ? "[Stripe test mode, no real money] " : "");

/** POST a short JSON notice to NOTIFY_WEBHOOK (`text` suits Slack, `content` Discord). True when it was accepted. */
export async function notifyOwner(x: Pick<EventContext, "env" | "fetch" | "now">, body: Record<string, unknown> & { text: string }): Promise<boolean> {
  const hook = x.env.NOTIFY_WEBHOOK;
  if (!hook || !/^https:\/\//.test(hook)) return false;
  try {
    const r = await x.fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, content: body.text, mode: stripeMode(x.env), at: x.now.toISOString() }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * A paid Custom purchase: a custom_requests row (once per subscription) and, with NOTIFY_WEBHOOK, a short notice. The
 * notice carries ids only; the buyer's email is in the row.
 */
async function recordCustom(x: EventContext, account: BillingAccount, subId: string): Promise<void> {
  const iso = x.now.toISOString();
  const mode = stripeMode(x.env) ?? "live";
  const row = await x.db
    .prepare("INSERT INTO custom_requests (id, account_id, email, subscription_id, created, mode) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (subscription_id) DO NOTHING RETURNING id")
    .bind(randomBase62(22), account.id, account.email, subId, iso, mode)
    .first<{ id: string }>();
  if (!row) return;
  console.log(`custom plan bought: account ${account.id}, request ${row.id}`);
  const ok = await notifyOwner(x, {
    event: "custom_purchase",
    text: `${modeNote(x.env)}GenClass Custom plan bought: request ${row.id}, account ${account.id}. The buyer's email is in custom_requests; write to them within 1 business day.`,
    request_id: row.id,
    account_id: account.id,
    subscription_id: subId,
  });
  if (ok) await x.db.prepare("UPDATE custom_requests SET notified = ? WHERE id = ?").bind(iso, row.id).run();
}

/**
 * POST /api/billing/webhook: signature, mode, idempotency, then the event. `raw` is the body exactly as received.
 * Only an event about a GenClass customer is recorded in billing_events (its id and type, so a redelivery changes
 * nothing). Any other event (Polar Parts' subscriptions) is answered 200 and not stored: handling it again does
 * nothing, and a table of them would be a record of another business's sales.
 */
export async function stripeWebhook(x: EventContext, raw: Uint8Array, signature: string | null): Promise<Response> {
  const mode = stripeMode(x.env);
  const secret = mode === "live" ? x.env.STRIPE_WEBHOOK_SECRET : mode === "test" ? x.env.STRIPE_WEBHOOK_SECRET_TEST : undefined;
  if (!secret) return json(503, { ok: false, error: "paid plans are not configured on this server" });
  const nowSec = Math.floor(x.now.getTime() / 1000);
  const v = await verifySignature(raw, signature, secret, nowSec);
  if (v !== "ok") {
    // the other mode's endpoint (a test endpoint left after going live): acknowledged so Stripe stops, never applied
    const other = mode === "live" ? x.env.STRIPE_WEBHOOK_SECRET_TEST : x.env.STRIPE_WEBHOOK_SECRET;
    if (other && other !== secret && (await verifySignature(raw, signature, other, nowSec)) === "ok") {
      console.log(`stripe webhook: an event signed for the other mode's endpoint ignored (the key is ${mode})`);
      return json(200, { received: true, result: "ignored" });
    }
    return json(400, { ok: false, error: `signature check failed: ${v}` });
  }
  let event: Obj;
  try {
    event = JSON.parse(new TextDecoder().decode(raw)) as Obj;
  } catch {
    return json(400, { ok: false, error: "invalid JSON" });
  }
  if (typeof event?.id !== "string" || !/^evt_[A-Za-z0-9]{6,255}$/.test(event.id) || typeof event.type !== "string") return json(400, { ok: false, error: "not a Stripe event" });
  if (await x.db.prepare("SELECT 1 AS x FROM billing_events WHERE id = ?").bind(event.id).first()) return json(200, { received: true, duplicate: true });
  let result: EventResult;
  if (typeof event.livemode === "boolean" && event.livemode !== (mode === "live")) {
    result = ignored(`a ${event.livemode ? "live" : "test"} mode event while the key is ${mode}`, event);
  } else {
    try {
      result = await handleEvent(x, event);
    } catch (e) {
      console.log(`stripe webhook: ${event.type} ${event.id} failed: ${e instanceof Error ? e.message : "error"}`);
      return json(500, { ok: false, error: "the event could not be applied; Stripe will send it again" });
    }
  }
  if (result.ours) {
    await x.db.prepare("INSERT OR IGNORE INTO billing_events (id, type, received) VALUES (?, ?, ?)").bind(event.id, event.type.slice(0, 80), x.now.toISOString()).run();
  }
  return json(200, { received: true, result: result.status });
}

// Stripe, over its REST API with fetch (form-encoded requests, a pinned Stripe-Version, idempotency keys on every
// create; no SDK): Checkout Sessions for the paid plans, Billing Portal sessions, immediate cancellation when an
// account is deleted, and the webhook that keeps accounts.plan in step with the subscription.
//
// Invariants:
// - The Stripe account is shared: GenClass bills through daybot.ca's account, which also runs Polar Parts (its own
//   products, prices, customers, Checkout Sessions, subscriptions, invoices, webhooks and Billing Portal). GenClass
//   touches only objects it can prove are its own (README "Shared Stripe account"):
//   - customers it created itself (description "GenClass account", metadata genclass=1 and genclass_account). They
//     are never looked up by email, and accounts.stripe_customer_id is written only by ensureCustomer;
//   - Checkout Sessions it created (mode subscription, metadata genclass=1 and genclass_account) for those customers;
//   - subscriptions whose every price has a genclass_ lookup key and a product with metadata genclass_plan
//     (src/plans.ts planForPrice), of those customers (fetched with the customer expanded, whose metadata
//     genclass_account must name the account);
//   - its own Billing Portal configuration (metadata genclass=1, never the account's default one).
//   Every other webhook event is answered 200, recorded by event id and type only, logged by type and id only, and
//   nothing about it is fetched from Stripe: the checks before any Stripe call use the event itself and our database.
// - GenClass stores the Stripe customer id, subscription id, status, period end, plan and the Stripe mode (test or
//   live) those ids belong to. Never card data: payment details are typed into Stripe's own pages.
// - One subscription per account. Checkout asks Stripe (not the database, which a late webhook leaves behind) whether
//   the customer already has one, and sends a paying account to the Billing Portal to change it instead; an account's
//   older unpaid Checkout pages are closed when it opens another plan's. If two subscriptions still end up live (two
//   tabs paid at once), the newest is kept and the others are cancelled at once with a prorated credit.
// - A webhook is accepted only with a valid Stripe-Signature (HMAC-SHA256 of "t.payload" under the webhook secret of
//   the key's mode, any v1 matching, compared in constant time, timestamp within 5 minutes). Events from the other
//   mode (a test endpoint left over after going live) are acknowledged and ignored. Each event id is handled once
//   (billing_events); a failure answers 500 so Stripe delivers it again.
// - The plan always comes from the subscription as Stripe has it now (fetched when an event arrives, so events that
//   arrive out of order cannot leave a stale plan): the price names the plan (src/plans.ts planForPrice), and the
//   status decides whether it applies (active or trialing: yes; past_due: for 14 days from when GenClass first saw it
//   past due, whatever the shared account's retry settings; anything else: free).
// - A Custom purchase is recorded (custom_requests, NOTIFY_WEBHOOK) only once Stripe reports the Custom price paid: a
//   paid Checkout, or a paid invoice with a Custom line (a switch from Pro is invoiced at once).

import type { Env } from "./collector.js";
import { randomBase62, sha256Hex, type D1Like } from "./dashboard.js";
import { json } from "./http.js";
import { LIVE_STATUSES, pastDueLapsed, PLANS_FILE, planForPrice, stripeMode, type Billing, type Plan, type PlanId } from "./plans.js";
import { equalStrings } from "./webauthn.js";

export const STRIPE_API = "https://api.stripe.com";
/** Every request names this API version; scripts/stripe-setup.mjs creates the webhook endpoint with it too. */
export const STRIPE_VERSION = "2025-03-31.basil";
export const WEBHOOK_TOLERANCE_S = 300;
/**
 * The events GenClass's endpoint subscribes to, and no more: the endpoint receives these for the whole shared account
 * (Polar Parts' too). A failed payment needs no invoice event: the subscription's move to past_due or unpaid arrives
 * as customer.subscription.updated.
 */
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
];
/** metadata.genclass on every Stripe object GenClass creates (customers, Checkout Sessions, subscriptions, products, prices, portal configuration, webhook endpoint). */
export const GENCLASS_MARK = "1";
/** The description of every customer GenClass creates. */
export const CUSTOMER_DESCRIPTION = "GenClass account";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
// Stripe objects are read defensively field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const ID22_RE = /^[A-Za-z0-9]{22}$/;
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

/** GenClass's Billing Portal configuration id per Stripe mode (configurations differ between test and live). */
const portalConfigs = new Map<string, { id: string | null; exp: number }>();

/**
 * The Billing Portal configuration scripts/stripe-setup.mjs made: metadata genclass=1, never the account's default
 * one (Polar Parts may use that). Looked up once and cached (10 minutes; a miss 1 minute). Without it no portal
 * session is made: the default configuration would show Polar Parts' settings to GenClass customers.
 */
async function portalConfiguration(env: Env, f: Fetch, nowMs: number): Promise<string> {
  const mode = stripeMode(env) ?? "";
  let c = portalConfigs.get(mode);
  if (!c || c.exp <= nowMs) {
    let id: string | null = null;
    let after: string | undefined;
    for (let page = 0; page < 5 && !id; page++) {
      const r = await stripe(env, f, "GET", "/v1/billing_portal/configurations", { is_default: false, active: true, limit: 100, starting_after: after });
      const data: Obj[] = Array.isArray(r?.data) ? r.data : [];
      const hit = data.find((x) => x?.metadata?.genclass === GENCLASS_MARK && x?.is_default !== true && typeof x?.id === "string" && /^bpc_[A-Za-z0-9]+$/.test(x.id));
      id = hit ? (hit.id as string) : null;
      if (!r?.has_more || !data.length) break;
      after = typeof data[data.length - 1]?.id === "string" ? data[data.length - 1]!.id : undefined;
      if (!after) break;
    }
    c = { id, exp: nowMs + (id ? 10 : 1) * 60_000 };
    portalConfigs.set(mode, c);
  }
  if (!c.id) throw new StripeError("GenClass's Billing Portal configuration (metadata genclass=1) is missing; run scripts/stripe-setup.mjs", 503);
  return c.id;
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
 * Never found by email: the shared account may have a Polar Parts customer with the same email, which GenClass must
 * not reuse or change. This is the only place accounts.stripe_customer_id is written with a customer id, so a
 * customer the database names is one GenClass made for that account. `fresh`: created by this call, so it has no
 * subscriptions or Checkout pages yet.
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
 * metadata says whether a subscription is GenClass's: isGenClassSubscription). Only ever called with a customer id
 * from the accounts table, which only ensureCustomer writes.
 */
export async function customerSubscriptions(env: Env, f: Fetch, customer: string): Promise<Obj[]> {
  const r = await stripe(env, f, "GET", "/v1/subscriptions", { customer, status: "all", limit: 100, expand: ["data.items.data.price.product"] });
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

/** A Checkout Session GenClass created for this account (metadata genclass=1 and genclass_account). */
const ownSession = (x: Obj, accountId: string): boolean => x?.metadata?.genclass === GENCLASS_MARK && x?.metadata?.genclass_account === accountId;

/**
 * A Checkout Session in subscription mode for one plan's monthly price, for the account's own GenClass customer, with
 * metadata genclass=1, genclass_account and genclass_plan (the subscription it starts carries genclass and
 * genclass_account). Returns Stripe's page URL. Unless the customer is `fresh`, its open Checkout pages are looked at
 * first: GenClass's page for this plan is reused (a second click, or a second tab), GenClass's page for another plan
 * is closed, so an abandoned tab cannot start a second subscription later. A page GenClass did not make is left alone.
 */
export async function checkoutSession(env: Env, f: Fetch, o: { account: BillingAccount; customer: string; plan: Plan; origin: string; now: Date; fresh?: boolean }): Promise<string> {
  const lookup = o.plan.stripe_lookup_keys.monthly;
  if (!lookup) throw new StripeError(`the ${o.plan.name} plan has no monthly price`, 400);
  const closed: string[] = [];
  if (!o.fresh) {
    const open = await stripe(env, f, "GET", "/v1/checkout/sessions", { customer: o.customer, status: "open", limit: 20 });
    for (const x of Array.isArray(open?.data) ? (open.data as Obj[]) : []) {
      if (typeof x?.id !== "string" || !SESSION_ID_RE.test(x.id) || !ownSession(x, o.account.id)) continue;
      if (x.metadata?.genclass_plan === o.plan.id && typeof x.url === "string" && x.url.startsWith("https://")) return x.url;
      await stripe(env, f, "POST", `/v1/checkout/sessions/${encodeURIComponent(x.id)}/expire`, {});
      closed.push(x.id);
    }
  }
  const price = await priceId(env, f, lookup, o.now.getTime(), o.plan);
  const mark = { genclass: GENCLASS_MARK, genclass_account: o.account.id };
  // a double click within the same minute gets the same session; after closing pages, a new key (the old session
  // under the plain key may be one of those just closed)
  const after = closed.length ? `-after-${(await sha256Hex(closed.join(","))).slice(0, 16)}` : "";
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
        success_url: `${o.origin}/account/billing?done=1`,
        cancel_url: `${o.origin}/account/billing`,
        metadata: { ...mark, genclass_plan: o.plan.id },
        subscription_data: { metadata: mark },
      },
      `genclass-checkout-${o.account.id}-${o.plan.id}-${Math.floor(o.now.getTime() / 60_000)}${after}`,
    );
  } catch (e) {
    priceCache.delete(lookup); // the cached price may have been replaced since
    throw e;
  }
  if (typeof s.url !== "string" || !s.url.startsWith("https://")) throw new StripeError("Stripe did not return a checkout page", 502);
  return s.url;
}

/**
 * A Billing Portal session on GenClass's own portal configuration (never the account's default); with
 * `subscription`, it opens straight on changing that subscription's plan.
 */
export async function portalSession(env: Env, f: Fetch, o: { customer: string; origin: string; subscription?: string | null; now: Date }): Promise<string> {
  const configuration = await portalConfiguration(env, f, o.now.getTime());
  const s = await stripe(env, f, "POST", "/v1/billing_portal/sessions", {
    customer: o.customer,
    return_url: `${o.origin}/account/billing`,
    configuration,
    flow_data: o.subscription ? { type: "subscription_update", subscription_update: { subscription: o.subscription } } : undefined,
  });
  if (typeof s.url !== "string" || !s.url.startsWith("https://")) throw new StripeError("Stripe did not return a billing page", 502);
  return s.url;
}

/**
 * Cancel a subscription at once. An already-cancelled one counts as done. `credit`: the unused part of the period is
 * credited to the customer's balance (prorated, invoiced now), for a duplicate subscription.
 */
export async function cancelNow(env: Env, f: Fetch, subscriptionId: string, credit = false): Promise<void> {
  try {
    await stripe(env, f, "DELETE", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, credit ? { prorate: true, invoice_now: true } : undefined);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return;
    if (e instanceof StripeError && /cancel/i.test(e.message) && e.status === 400) return;
    throw e;
  }
}

/**
 * Before an account is deleted: cancel at once every GenClass subscription of its Stripe customer that could still
 * charge it, not only the one GenClass recorded (a second one, or one whose webhook has not arrived yet). A
 * subscription that is not provably GenClass's is left alone. Returns null when nothing GenClass sold can charge the
 * account any more, else why the deletion has to wait.
 */
export async function cancelForDeletion(env: Env, f: Fetch, b: Billing): Promise<{ status: number; error: string } | null> {
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
      try {
        for (const s of await customerSubscriptions(env, f, b.stripe_customer_id)) if (!ENDED_STATUSES.has(s.status) && isGenClassSubscription(s)) ids.add(s.id);
      } catch (e) {
        if (!missingCustomer(e)) throw e; // a deleted customer's subscriptions were cancelled with it
      }
    }
    if (b.subscription_id && recordedLive) ids.add(b.subscription_id);
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
  reason?: string;
  account?: string;
  plan?: PlanId;
}

const idOf = (v: unknown): string | null => {
  const s = typeof v === "string" ? v : v && typeof v === "object" ? (v as Obj).id : null;
  return typeof s === "string" && STRIPE_ID_RE.test(s) ? s : null;
};

const ACCOUNT_BILLING_COLUMNS = "id, email, plan, stripe_customer_id, subscription_id, subscription_status, stripe_mode, past_due_since";

async function accountById(db: D1Like, id: unknown): Promise<BillingAccount | null> {
  if (typeof id !== "string" || !ID22_RE.test(id)) return null;
  return db.prepare(`SELECT ${ACCOUNT_BILLING_COLUMNS} FROM accounts WHERE id = ?`).bind(id).first<BillingAccount>();
}

/** The account whose GenClass customer this is (only ensureCustomer writes stripe_customer_id), or null. */
async function accountByCustomer(db: D1Like, customer: string | null): Promise<BillingAccount | null> {
  if (!customer) return null;
  return db.prepare(`SELECT ${ACCOUNT_BILLING_COLUMNS} FROM accounts WHERE stripe_customer_id = ?`).bind(customer).first<BillingAccount>();
}

/**
 * The subscription (fetched with its customer expanded) is the account's: its customer is the account's GenClass
 * customer and that customer's metadata genclass_account names the account (a customer deleted in Stripe keeps no
 * metadata; the account row, written only by ensureCustomer, names it then), and the subscription's own metadata, if
 * it names an account, names this one.
 */
function accountsSubscription(account: BillingAccount, sub: Obj): boolean {
  const c = sub?.customer;
  if (!account.stripe_customer_id || idOf(c) !== account.stripe_customer_id || !c || typeof c !== "object") return false;
  if (c.deleted !== true && c.metadata?.genclass_account !== account.id) return false;
  const named = sub?.metadata?.genclass_account;
  return named === undefined || named === null || named === account.id;
}

/** The subscription an invoice is for (the field moved in API version 2025-03-31), or null for a one-off invoice. */
export function invoiceSubscription(inv: Obj): string | null {
  return idOf(inv?.subscription) ?? idOf(inv?.parent?.subscription_details?.subscription) ?? idOf(inv?.lines?.data?.[0]?.subscription) ?? idOf(inv?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription);
}

const ignored = (reason: string, event: Obj): EventResult => {
  console.log(`stripe webhook: ${String(event?.type)} ${String(event?.id)} ignored: ${reason}`);
  return { status: "ignored", reason };
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
 * first Custom invoice, or the prorated switch from Pro, which the portal invoices at once). Exported for tests.
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
 * GET a subscription of a GenClass customer with its prices' products (whose metadata says the plan) and its customer
 * (whose metadata says the account). Only called once the event has passed the checks that need no Stripe call.
 */
const fetchSubscription = (x: EventContext, id: string): Promise<Obj> =>
  stripe(x.env, x.fetch, "GET", `/v1/subscriptions/${encodeURIComponent(id)}`, { expand: ["items.data.price.product", "customer"] });

/**
 * Apply one verified Stripe event. Throws on a Stripe or database error (the webhook then answers 500).
 *
 * The endpoint gets these event types for the whole shared Stripe account, Polar Parts' too. Before any Stripe call
 * the event itself must point at GenClass: a Checkout Session GenClass created (mode subscription, metadata genclass=1,
 * genclass_account naming an account, the account's own customer), or a subscription or invoice of a customer the
 * accounts table names. Anything else is ignored with no Stripe call (ignored() logs its type and id only). Then the
 * subscription is fetched and must be provably GenClass's (isGenClassSubscription, or the one already recorded for
 * the account) and the account's (accountsSubscription) before anything is written.
 */
export async function handleEvent(x: EventContext, event: Obj): Promise<EventResult> {
  const obj: Obj = event?.data?.object ?? {};
  let account: BillingAccount | null = null;
  let subId: string | null = null;
  let checkout = false;
  switch (event?.type) {
    case "checkout.session.completed": {
      // a Polar Parts order (mode payment) or a Polar Parts subscription checkout ends here. client_reference_id says
      // nothing: anyone's Checkout can carry a string that looks like an account id
      if (obj.mode !== "subscription") return ignored("not a subscription checkout", event);
      if (obj.metadata?.genclass !== GENCLASS_MARK) return ignored("not a GenClass checkout", event);
      account = await accountById(x.db, obj.metadata?.genclass_account);
      if (!account) return ignored("no GenClass account for this checkout", event);
      const customer = idOf(obj.customer);
      if (!customer || customer !== account.stripe_customer_id) return ignored("the checkout's customer is not the account's GenClass customer", event);
      subId = idOf(obj.subscription);
      if (!subId) return ignored("the checkout has no subscription", event);
      checkout = true;
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      account = await accountByCustomer(x.db, idOf(obj.customer));
      if (!account) return ignored("not a GenClass customer", event);
      subId = idOf(obj.id);
      break;
    case "invoice.paid":
      account = await accountByCustomer(x.db, idOf(obj.customer));
      if (!account) return ignored("not a GenClass customer", event);
      subId = invoiceSubscription(obj);
      if (!subId) return ignored("not a subscription invoice", event);
      break;
    default:
      return ignored("event type not handled", event);
  }
  if (!account || !subId) return ignored("no subscription", event);
  // the subscription as it is now, so the order events arrive in does not matter
  let sub = await fetchSubscription(x, subId);
  if (!accountsSubscription(account, sub)) return ignored("the subscription is not the account's", event);
  // the subscription already recorded for the account stays readable whatever its price now says (it then counts as
  // Free); any other must be provably GenClass's
  if (!isGenClassSubscription(sub) && idOf(sub?.id) !== account.subscription_id) return ignored("not a GenClass subscription", event);
  if (checkout) sub = await oneSubscription(x, account, sub);
  const result = await applySubscription(x, account, sub, event);
  // a Custom purchase counts once Stripe reports it paid
  const paid =
    (checkout && idOf(sub?.id) === subId && obj.payment_status === "paid") ||
    (event.type === "invoice.paid" && invoiceSubscription(obj) === idOf(sub?.id) && invoicePaysCustom(obj, sub));
  if (result.status === "applied" && result.plan === "custom" && paid) await recordCustom(x, account, idOf(sub.id)!);
  return result;
}

/**
 * After a Checkout: if the account's GenClass customer now has more than one GenClass subscription that bills (two
 * tabs paid, or an old Checkout page completed after a purchase), keep the newest and cancel the others at once, with
 * the unused time credited to the customer's balance; the owner is told at NOTIFY_WEBHOOK. Only GenClass
 * subscriptions are counted or cancelled. Returns the subscription to apply.
 */
async function oneSubscription(x: EventContext, account: BillingAccount, sub: Obj): Promise<Obj> {
  const customer = idOf(sub?.customer);
  if (!customer || customer !== account.stripe_customer_id || !LIVE_STATUSES.has(sub?.status) || !isGenClassSubscription(sub)) return sub;
  const holding = (await customerSubscriptions(x.env, x.fetch, customer)).filter((s) => HOLDING_STATUSES.has(s.status) && isGenClassSubscription(s));
  if (holding.length < 2) return sub;
  holding.sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0) || String(b.id).localeCompare(String(a.id)));
  const [keep, ...extra] = holding;
  for (const s of extra) await cancelNow(x.env, x.fetch, s.id, true);
  const ids = extra.map((s) => s.id).join(", ");
  console.log(`stripe webhook: account ${account.id} had ${holding.length} subscriptions; kept ${keep!.id}, cancelled ${ids} with a prorated credit`);
  await notifyOwner(x, {
    event: "duplicate_subscription",
    text: `${modeNote(x.env)}GenClass account ${account.id} paid for a second subscription. Kept ${keep!.id}; cancelled ${ids} with the unused time credited to the customer's balance in Stripe. Refund it instead if they ask.`,
    account_id: account.id,
    kept: keep!.id,
    cancelled: extra.map((s) => s.id),
  });
  return keep!.id === idOf(sub.id) ? sub : fetchSubscription(x, keep!.id);
}

/**
 * Write a subscription's state to its account (the caller has checked that it is the account's GenClass
 * subscription). past_due_since keeps the time GenClass first saw this subscription past due, so the grace runs from
 * there whatever events follow.
 */
export async function applySubscription(x: EventContext, account: BillingAccount, sub: Obj, event: Obj = {}): Promise<EventResult> {
  const subId = idOf(sub?.id);
  if (!subId) return ignored("the subscription has no id", event);
  const customer = idOf(sub?.customer);
  if (!customer || customer !== account.stripe_customer_id) return ignored("the subscription belongs to another Stripe customer than the account's", event);
  const status = typeof sub?.status === "string" ? sub.status : "";
  const pastDueSince =
    status !== "past_due"
      ? null
      : account.subscription_id === subId && account.subscription_status === "past_due" && account.past_due_since
        ? account.past_due_since
        : x.now.toISOString();
  const s = subscriptionState(sub, { pastDueSince, now: x.now });
  if (account.subscription_id && account.subscription_id !== subId && !LIVE_STATUSES.has(s.status)) {
    // an older subscription ending while the account has another one
    return ignored("not the account's current subscription", event);
  }
  if (s.priced === null) console.log(`stripe webhook: ${String(event?.type)} ${String(event?.id)}: subscription ${subId} no longer has a GenClass price; plan set to free`);
  await x.db
    .prepare(
      "UPDATE accounts SET plan = ?, subscription_id = ?, subscription_status = ?, past_due_since = ?, current_period_end = ?, cancel_at_period_end = ?, " +
        "stripe_mode = ? WHERE id = ? AND stripe_customer_id = ?",
    )
    .bind(s.plan, subId, s.status, pastDueSince, s.periodEnd, s.cancelAtPeriodEnd ? 1 : 0, stripeMode(x.env), account.id, customer)
    .run();
  return { status: "applied", account: account.id, plan: s.plan };
}

const modeNote = (env: Env): string => (stripeMode(env) === "test" ? "[Stripe test mode, no real money] " : "");

/** POST a short JSON notice to NOTIFY_WEBHOOK (`text` suits Slack, `content` Discord). True when it was accepted. */
async function notifyOwner(x: EventContext, body: Record<string, unknown> & { text: string }): Promise<boolean> {
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
 * Every verified event, GenClass's or not, is recorded in billing_events by its id and type only.
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
  await x.db.prepare("INSERT OR IGNORE INTO billing_events (id, type, received) VALUES (?, ?, ?)").bind(event.id, event.type.slice(0, 80), x.now.toISOString()).run();
  return json(200, { received: true, result: result.status });
}

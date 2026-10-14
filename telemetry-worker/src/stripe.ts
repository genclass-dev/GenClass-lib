// Stripe, over its REST API with fetch (form-encoded requests, a pinned Stripe-Version, idempotency keys on every
// create; no SDK): Checkout Sessions for the paid plans, Billing Portal sessions, immediate cancellation when an
// account is deleted, and the webhook that keeps accounts.plan in step with the subscription.
//
// Invariants:
// - GenClass stores the Stripe customer id, subscription id, status, period end and plan. Never card data: payment
//   details are typed into Stripe's own pages.
// - A webhook is accepted only with a valid Stripe-Signature (HMAC-SHA256 of "t.payload" under STRIPE_WEBHOOK_SECRET,
//   any v1 matching, compared in constant time, timestamp within 5 minutes). Each event id is handled once
//   (billing_events); a failure answers 500 so Stripe delivers it again.
// - The plan always comes from the subscription as Stripe has it now (fetched when an event arrives, so events that
//   arrive out of order cannot leave a stale plan): the price's lookup_key names the plan, and the status decides
//   whether it applies (active or trialing: yes; past_due: yes, while Stripe retries the card; anything else: free).
// - Events for customers GenClass does not know are logged by type and id only, and ignored.

import type { Env } from "./collector.js";
import { randomBase62, type D1Like } from "./dashboard.js";
import { json } from "./http.js";
import { LIVE_STATUSES, planByLookupKey, type Plan, type PlanId } from "./plans.js";
import { equalStrings } from "./webauthn.js";

export const STRIPE_API = "https://api.stripe.com";
/** Every request names this API version; scripts/stripe-setup.mjs creates the webhook endpoint with it too. */
export const STRIPE_VERSION = "2025-03-31.basil";
export const WEBHOOK_TOLERANCE_S = 300;
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
// Stripe objects are read defensively field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const ID22_RE = /^[A-Za-z0-9]{22}$/;
const STRIPE_ID_RE = /^[a-z]{2,8}_[A-Za-z0-9]{6,255}$/;

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
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

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
  if (!res.ok) throw new StripeError(typeof j?.error?.message === "string" ? j.error.message : `Stripe answered HTTP ${res.status}`, res.status, j?.error?.code);
  return j;
}

const priceCache = new Map<string, { id: string; exp: number }>();
export const resetStripeCache = (): void => {
  priceCache.clear();
  portalConfig = null;
};

/** The active price with this lookup key (cached for 10 minutes). */
export async function priceId(env: Env, f: Fetch, lookupKey: string, nowMs: number): Promise<string> {
  const c = priceCache.get(lookupKey);
  if (c && c.exp > nowMs) return c.id;
  const r = await stripe(env, f, "GET", "/v1/prices", { lookup_keys: [lookupKey], active: true, limit: 1 });
  const id = r?.data?.[0]?.id;
  if (typeof id !== "string") throw new StripeError(`no active Stripe price has the lookup key ${lookupKey}; run scripts/stripe-setup.mjs`, 503);
  priceCache.set(lookupKey, { id, exp: nowMs + 10 * 60_000 });
  return id;
}

let portalConfig: { id: string | null; exp: number } | null = null;

/** The portal configuration scripts/stripe-setup.mjs made (metadata genclass=portal), or null for Stripe's default. */
async function portalConfiguration(env: Env, f: Fetch, nowMs: number): Promise<string | null> {
  if (portalConfig && portalConfig.exp > nowMs) return portalConfig.id;
  let id: string | null = null;
  try {
    const r = await stripe(env, f, "GET", "/v1/billing_portal/configurations", { active: true, limit: 100 });
    const hit = (r?.data ?? []).find((x: Obj) => x?.metadata?.genclass === "portal");
    id = typeof hit?.id === "string" ? hit.id : null;
  } catch {
    id = null;
  }
  portalConfig = { id, exp: nowMs + 10 * 60_000 };
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
}

/** The account's Stripe customer, created (with the account's email and id) the first time it is needed. */
export async function ensureCustomer(env: Env, f: Fetch, db: D1Like, a: BillingAccount): Promise<string> {
  if (a.stripe_customer_id) return a.stripe_customer_id;
  const c = await stripe(env, f, "POST", "/v1/customers", { email: a.email ?? undefined, metadata: { account_id: a.id } }, `genclass-customer-${a.id}`);
  if (typeof c.id !== "string" || !STRIPE_ID_RE.test(c.id)) throw new StripeError("Stripe did not return a customer", 502);
  await db.prepare("UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(c.id, a.id).run();
  const row = await db.prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?").bind(a.id).first<{ stripe_customer_id: string | null }>();
  return row?.stripe_customer_id ?? c.id;
}

/** A Checkout Session in subscription mode for one plan's monthly price. Returns Stripe's page URL. */
export async function checkoutSession(env: Env, f: Fetch, o: { account: BillingAccount; customer: string; plan: Plan; origin: string; now: Date }): Promise<string> {
  const lookup = o.plan.stripe_lookup_keys.monthly;
  if (!lookup) throw new StripeError(`the ${o.plan.name} plan has no monthly price`, 400);
  const price = await priceId(env, f, lookup, o.now.getTime());
  const meta = { account_id: o.account.id, plan: o.plan.id };
  const s = await stripe(
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
      metadata: meta,
      subscription_data: { metadata: meta },
    },
    // a double click within the same minute gets the same session
    `genclass-checkout-${o.account.id}-${o.plan.id}-${Math.floor(o.now.getTime() / 60_000)}`,
  );
  if (typeof s.url !== "string" || !s.url.startsWith("https://")) throw new StripeError("Stripe did not return a checkout page", 502);
  return s.url;
}

/** A Billing Portal session; with `subscription`, it opens straight on changing that subscription's plan. */
export async function portalSession(env: Env, f: Fetch, o: { customer: string; origin: string; subscription?: string | null; now: Date }): Promise<string> {
  const configuration = await portalConfiguration(env, f, o.now.getTime());
  const s = await stripe(env, f, "POST", "/v1/billing_portal/sessions", {
    customer: o.customer,
    return_url: `${o.origin}/account/billing`,
    configuration: configuration ?? undefined,
    flow_data: o.subscription ? { type: "subscription_update", subscription_update: { subscription: o.subscription } } : undefined,
  });
  if (typeof s.url !== "string" || !s.url.startsWith("https://")) throw new StripeError("Stripe did not return a billing page", 502);
  return s.url;
}

/** Cancel a subscription at once (the account is being deleted). An already-cancelled one counts as done. */
export async function cancelNow(env: Env, f: Fetch, subscriptionId: string): Promise<void> {
  try {
    await stripe(env, f, "DELETE", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return;
    if (e instanceof StripeError && /cancel/i.test(e.message) && e.status === 400) return;
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

/** What a subscription means for the account (pure; exported for tests). */
export function subscriptionState(sub: Obj): SubscriptionState {
  const status = typeof sub?.status === "string" ? sub.status : "";
  const items: Obj[] = Array.isArray(sub?.items?.data) ? sub.items.data : [];
  let priced: Plan | null = null;
  let lookupKey: string | null = null;
  for (const it of items) {
    const k = it?.price?.lookup_key;
    const p = planByLookupKey(k);
    if (p) {
      priced = p;
      lookupKey = k;
      break;
    }
    if (typeof k === "string" && !lookupKey) lookupKey = k;
  }
  // API versions before 2025-03-31 put the period on the subscription, later ones on its items
  const itemEnds = items.map((it) => it?.current_period_end).filter((x): x is number => typeof x === "number");
  const end = typeof sub?.cancel_at === "number" ? sub.cancel_at : typeof sub?.current_period_end === "number" ? sub.current_period_end : itemEnds.length ? Math.max(...itemEnds) : null;
  return {
    plan: priced && LIVE_STATUSES.has(status) ? priced.id : "free",
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

const ACCOUNT_BILLING_COLUMNS = "id, email, plan, stripe_customer_id, subscription_id, subscription_status";

async function accountById(db: D1Like, id: unknown): Promise<BillingAccount | null> {
  if (typeof id !== "string" || !ID22_RE.test(id)) return null;
  return db.prepare(`SELECT ${ACCOUNT_BILLING_COLUMNS} FROM accounts WHERE id = ?`).bind(id).first<BillingAccount>();
}

async function accountByCustomer(db: D1Like, customer: string | null): Promise<BillingAccount | null> {
  if (!customer) return null;
  return db.prepare(`SELECT ${ACCOUNT_BILLING_COLUMNS} FROM accounts WHERE stripe_customer_id = ?`).bind(customer).first<BillingAccount>();
}

/** The account a subscription belongs to: by its customer, else by the account id GenClass put in its metadata. */
async function accountForSubscription(db: D1Like, sub: Obj): Promise<BillingAccount | null> {
  const customer = idOf(sub?.customer);
  const byCustomer = await accountByCustomer(db, customer);
  if (byCustomer) return byCustomer;
  const byMeta = await accountById(db, sub?.metadata?.account_id);
  if (byMeta && (!byMeta.stripe_customer_id || byMeta.stripe_customer_id === customer)) return byMeta;
  return null;
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

/** Apply one verified Stripe event. Throws on a Stripe or database error (the webhook then answers 500). */
export async function handleEvent(x: EventContext, event: Obj): Promise<EventResult> {
  const obj: Obj = event?.data?.object ?? {};
  let account: BillingAccount | null = null;
  let subId: string | null = null;
  switch (event?.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription") return ignored("not a subscription checkout", event);
      account = await accountById(x.db, obj.client_reference_id ?? obj.metadata?.account_id);
      if (!account) return ignored("no GenClass account for this checkout", event);
      const customer = idOf(obj.customer);
      if (customer && !account.stripe_customer_id) {
        await x.db.prepare("UPDATE accounts SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(customer, account.id).run();
        account = await accountById(x.db, account.id);
      }
      subId = idOf(obj.subscription);
      if (!subId) return ignored("the checkout has no subscription", event);
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      subId = idOf(obj.id);
      account = await accountForSubscription(x.db, obj);
      if (!account) return ignored("no GenClass account for this customer", event);
      break;
    case "invoice.paid":
    case "invoice.payment_failed":
      subId = invoiceSubscription(obj);
      if (!subId) return ignored("not a subscription invoice", event);
      account = await accountByCustomer(x.db, idOf(obj.customer));
      break;
    default:
      return ignored("event type not handled", event);
  }
  if (!subId) return ignored("no subscription", event);
  // the subscription as it is now, so the order events arrive in does not matter
  const sub = await stripe(x.env, x.fetch, "GET", `/v1/subscriptions/${encodeURIComponent(subId)}`);
  account ??= await accountForSubscription(x.db, sub);
  if (!account) return ignored("no GenClass account for this customer", event);
  return applySubscription(x, account, sub, event);
}

/** Write a subscription's state to its account (and record a Custom purchase). */
export async function applySubscription(x: EventContext, account: BillingAccount, sub: Obj, event: Obj = {}): Promise<EventResult> {
  const subId = idOf(sub?.id);
  if (!subId) return ignored("the subscription has no id", event);
  const s = subscriptionState(sub);
  if (account.subscription_id && account.subscription_id !== subId && !LIVE_STATUSES.has(s.status)) {
    // an older subscription ending while the account has another one
    return ignored("not the account's current subscription", event);
  }
  if (s.priced === null && s.lookupKey) console.log(`stripe webhook: ${String(event?.id)}: price lookup key ${s.lookupKey} is not in billing/plans.json; plan set to free`);
  await x.db
    .prepare(
      "UPDATE accounts SET plan = ?, subscription_id = ?, subscription_status = ?, current_period_end = ?, cancel_at_period_end = ?, " +
        "stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?",
    )
    .bind(s.plan, subId, s.status, s.periodEnd, s.cancelAtPeriodEnd ? 1 : 0, idOf(sub?.customer), account.id)
    .run();
  if (s.plan === "custom" && account.plan !== "custom") await recordCustom(x, account, subId);
  return { status: "applied", account: account.id, plan: s.plan };
}

/** A Custom purchase: a custom_requests row (once per subscription) and, with NOTIFY_WEBHOOK, a short notice. */
async function recordCustom(x: EventContext, account: BillingAccount, subId: string): Promise<void> {
  const iso = x.now.toISOString();
  const row = await x.db
    .prepare("INSERT INTO custom_requests (id, account_id, email, subscription_id, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT (subscription_id) DO NOTHING RETURNING id")
    .bind(randomBase62(22), account.id, account.email, subId, iso)
    .first<{ id: string }>();
  if (!row) return;
  console.log(`custom plan bought: account ${account.id}, request ${row.id}`);
  const hook = x.env.NOTIFY_WEBHOOK;
  if (!hook || !/^https:\/\//.test(hook)) return;
  const text = `GenClass Custom plan bought by ${account.email ?? "an account without an email"} (account ${account.id}). Email them within 1 business day to start.`;
  try {
    const r = await x.fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text, event: "custom_purchase", request_id: row.id, account_id: account.id, email: account.email, subscription_id: subId, at: iso }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) await x.db.prepare("UPDATE custom_requests SET notified = ? WHERE id = ?").bind(iso, row.id).run();
  } catch {
    /* the row is there; the owner sees it in custom_requests */
  }
}

/** POST /api/billing/webhook: signature, idempotency, then the event. `raw` is the body exactly as received. */
export async function stripeWebhook(x: EventContext, raw: Uint8Array, signature: string | null): Promise<Response> {
  const secret = x.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !x.env.STRIPE_SECRET_KEY) return json(503, { ok: false, error: "paid plans are not configured on this server" });
  const v = await verifySignature(raw, signature, secret, Math.floor(x.now.getTime() / 1000));
  if (v !== "ok") return json(400, { ok: false, error: `signature check failed: ${v}` });
  let event: Obj;
  try {
    event = JSON.parse(new TextDecoder().decode(raw)) as Obj;
  } catch {
    return json(400, { ok: false, error: "invalid JSON" });
  }
  if (typeof event?.id !== "string" || !/^evt_[A-Za-z0-9]{6,255}$/.test(event.id) || typeof event.type !== "string") return json(400, { ok: false, error: "not a Stripe event" });
  if (await x.db.prepare("SELECT 1 AS x FROM billing_events WHERE id = ?").bind(event.id).first()) return json(200, { received: true, duplicate: true });
  let result: EventResult;
  try {
    result = await handleEvent(x, event);
  } catch (e) {
    console.log(`stripe webhook: ${event.type} ${event.id} failed: ${e instanceof Error ? e.message : "error"}`);
    return json(500, { ok: false, error: "the event could not be applied; Stripe will send it again" });
  }
  await x.db.prepare("INSERT OR IGNORE INTO billing_events (id, type, received) VALUES (?, ?, ?)").bind(event.id, event.type.slice(0, 80), x.now.toISOString()).run();
  return json(200, { received: true, result: result.status });
}

// Shared by the paid-plan tests (billing, forward, export, trial): an env over node:sqlite with an R2 stand-in that keeps
// the bytes, signed-in accounts made through the real email and password sign-up, apps, batches through the real
// collector, a fake Stripe API, and Stripe-signed webhook deliveries.
import { expect } from "vitest";
import { handle, type Env, type HandleOptions } from "../src/collector.js";
import { d1 } from "./d1.js";

export const ORIGIN = "https://genclass.dev";
export const T0 = new Date("2026-10-13T12:00:00Z");
let clock = new Date(T0);
export const now = (): Date => clock;
export const setNow = (d: Date): Date => (clock = new Date(d));
export const advance = (ms: number): Date => (clock = new Date(clock.getTime() + ms));
export const resetClock = (): Date => (clock = new Date(T0));

export type Fetch = NonNullable<HandleOptions["fetch"]>;

export function bucket() {
  const objects = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    async put(key: string, value: ArrayBuffer | Uint8Array) {
      objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
    },
    async get(key: string) {
      const v = objects.get(key);
      return v ? { arrayBuffer: async () => v.slice().buffer as ArrayBuffer } : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        deleted.push(k);
        objects.delete(k);
      }
    },
  };
}

export function setup(over: Partial<Env> = {}) {
  const sql = d1();
  const r2 = bucket();
  const env: Env = { BUCKET: r2, DB: sql.api, ...over };
  return { env, sql, r2 };
}

export interface CallOpts {
  body?: unknown;
  cookie?: string;
  bearer?: string;
  /** null sends no Origin header */
  origin?: string | null;
  headers?: Record<string, string>;
  fetch?: Fetch;
}

export async function call(env: Env, method: string, path: string, o: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  const origin = o.origin === undefined ? ORIGIN : o.origin;
  if (origin) headers.origin = origin;
  if (o.body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  if (o.cookie) headers.cookie = o.cookie;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  const body = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
  return handle(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, { now: () => clock, fetch: o.fetch });
}

/** The password the helper accounts sign up with. */
export const PASSWORD = "correct horse battery staple";

/** A new account, signed up with an email and a password (no passkey): its session cookie and id. */
export async function signedIn(env: Env, email = "ada@example.com") {
  const res = await call(env, "POST", "/api/auth/password/signup", { body: { email, password: PASSWORD } });
  expect(res.status).toBe(200);
  const v = res.headers.getSetCookie().find((c) => c.startsWith("__Host-gc_session="))!.split(";")[0]!;
  const account = ((await res.json()) as any).account as { id: string; email: string };
  return { cookie: v, account };
}

export async function cliToken(env: Env, cookie: string): Promise<string> {
  const code = (await (await call(env, "POST", "/api/device/code", { origin: null })).json()) as any;
  expect((await call(env, "POST", "/api/device/approve", { body: { user_code: code.user_code, approve: true }, cookie })).status).toBe(200);
  const tok = (await (await call(env, "POST", "/api/device/token", { body: { device_code: code.device_code }, origin: null })).json()) as any;
  return tok.access_token;
}

export async function createApp(env: Env, cookie: string, name = "Shop"): Promise<{ id: string; token: string; name: string }> {
  const r = await call(env, "POST", "/api/account/projects", { body: { name }, cookie });
  expect(r.status).toBe(201);
  return ((await r.json()) as any).project;
}

export function setPlan(sql: ReturnType<typeof d1>, accountId: string, plan: string, over: Record<string, unknown> = {}) {
  const cols = { plan, ...over };
  const keys = Object.keys(cols);
  sql.db.prepare(`UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(keys.map((k) => (cols as any)[k]) as never[]), accountId);
}

let uuid = 0;
/** One batch through the real collector (/api/v1/events). */
export async function sendBatch(env: Env, token: string, events: Record<string, unknown>[], o: { sid?: string; fetch?: Fetch } = {}) {
  const body = { schema: "genclass-telemetry/1", sid: o.sid ?? "cccccccccccc", sent: 1, runtime: "0.3.0", model: "0.2.0", token, events };
  const r = await handle(new Request(`${ORIGIN}/api/v1/events`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "text/plain" } }), env, {
    now: () => clock,
    fetch: o.fetch,
    uuid: () => `u-${++uuid}`,
  });
  expect(r.status).toBe(202);
  return r;
}

/** A decision and its detection, as runtime 0.3.0 sends them. */
export function detection(diagnosis = "duplicate", route = "/checkout", over: Record<string, unknown> = {}): Record<string, unknown>[] {
  const id = `d${Math.random().toString(36).slice(2, 8)}`;
  return [
    { t: "decision", id, seq: 1, trigger: "delivery", route, diagnosis, diagnosisConfidence: 0.97, situation: "SECRET PAGE TEXT typed by a user", effectiveMode: "observe" },
    { t: "detect", decision: id, seq: 2, trigger: "delivery", diagnosis, p: 0.97, ...over },
  ];
}

// --------------------------------------------------------------------------------------------- Stripe

export interface StripeCall {
  method: string;
  url: URL;
  form: URLSearchParams | null;
  headers: Record<string, string>;
}

/** Stripe's form fields under a prefix as an object: metadata[genclass]=1 -> { genclass: "1" }. */
const formObject = (form: URLSearchParams, prefix: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of form) {
    const m = new RegExp(`^${prefix}\\[([^\\]]+)\\]$`).exec(k);
    if (m) out[m[1]!] = v;
  }
  return out;
};

/** The expand[] values of a request. */
export const expands = (url: URL): string[] => [...url.searchParams.entries()].filter(([k]) => /^expand\[\d*\]$/.test(k)).map(([, v]) => v);

/**
 * The shared Stripe account's Billing Portal configurations: Polar Parts' default one, another of Polar Parts', and
 * GenClass's (metadata genclass=1), as scripts/stripe-setup.mjs leaves them. The worker reads GenClass's by the id in
 * STRIPE_PORTAL_CONFIGURATION (GENCLASS_PORTAL) and lists none.
 */
export const PORTAL_CONFIGS = [
  { id: "bpc_polardefault1", object: "billing_portal.configuration", is_default: true, active: true, metadata: {} },
  { id: "bpc_other00001", object: "billing_portal.configuration", is_default: false, active: true, metadata: {} },
  { id: "bpc_genclass01", object: "billing_portal.configuration", is_default: false, active: true, metadata: { genclass: "1" } },
];
export const GENCLASS_PORTAL = "bpc_genclass01";

/**
 * A fake fetch for api.stripe.com (and any other URL, recorded and answered 200 unless `answer` says otherwise; `answer`
 * runs first for every request, so a test can refuse a DELETE, fail a refund or watch the database at that moment). It
 * keeps customers (`customers`: created with their form fields, fetched by id, 404 resource_missing for any other id;
 * a subscription fetched with expand customer gets the stored one, or one with no metadata, like a Polar Parts
 * customer), subscriptions (`subs`, listed by customer; expand latest_invoice, or data.latest_invoice on the list,
 * swaps in the stored invoice, and a subscription stored without latest_invoice reads as one whose latest invoice is
 * paid with nothing due), invoices (`invoices`, listed by customer, subscription and status, newest first; a paid one
 * has one invoice payment, by the payment intent paymentIntentFor(id)), refunds (`refunds`: created with their form
 * fields, the same one again for the same idempotency key, listed by payment intent or charge), charges (`charges`,
 * fetched by id), Checkout Sessions (`sessions`: created open with their metadata, listed by customer and status,
 * expired on request), and the portal configurations (`portal`, listed by is_default or fetched by id).
 */
export function fakeStripe(o: { answer?: (url: URL, init: RequestInit) => Response | undefined } = {}) {
  const calls: StripeCall[] = [];
  const other: { url: string; init: RequestInit; body: string }[] = [];
  const customers = new Map<string, Record<string, any>>();
  const subs = new Map<string, Record<string, any>>();
  const sessions = new Map<string, Record<string, any>>();
  const invoices = new Map<string, Record<string, any>>();
  const refunds = new Map<string, Record<string, any>>();
  const refundKeys = new Map<string, Record<string, any>>();
  const charges = new Map<string, Record<string, any>>();
  const portal: Record<string, any>[] = PORTAL_CONFIGS.map((c) => ({ ...c, metadata: { ...c.metadata } }));
  /** A subscription's latest invoice as an expansion returns it. */
  const latest = (sub: Record<string, any>) =>
    typeof sub.latest_invoice === "string"
      ? (invoices.get(sub.latest_invoice) ?? sub.latest_invoice)
      : sub.latest_invoice === undefined
        ? { id: `in_auto${String(sub.id).slice(4)}`, object: "invoice", customer: sub.customer, status: "paid", amount_due: 0, amount_paid: 0, parent: { subscription_details: { subscription: sub.id } }, lines: { data: [] } }
        : sub.latest_invoice;
  let n = 0;
  let cs = 0;
  const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
  const fetch: Fetch = async (input, init = {}) => {
    const url = new URL(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    if (url.origin !== "https://api.stripe.com") {
      other.push({ url: input, init, body: String(init.body ?? "") });
      return o.answer?.(url, init) ?? new Response("ok", { status: 200 });
    }
    const method = init.method ?? "GET";
    const form = method === "POST" ? new URLSearchParams(String(init.body ?? "")) : null;
    calls.push({ method, url, form, headers });
    const custom = o.answer?.(url, init);
    if (custom) return custom;
    const p = url.pathname;
    if (method === "GET" && p === "/v1/prices") {
      // GenClass's two prices, with their products expanded (the worker asks for data.product)
      const key = url.searchParams.get("lookup_keys[0]");
      return ok({ data: key === "genclass_pro_monthly" || key === "genclass_custom_monthly" ? [price(key)] : [] });
    }
    const cus = /^\/v1\/customers\/([^/]+)$/.exec(p);
    if (method === "GET" && cus) {
      const id = decodeURIComponent(cus[1]!);
      const c = customers.get(id);
      return c ? ok(c) : ok({ error: { code: "resource_missing", param: "id", message: `No such customer: '${id}'` } }, 404);
    }
    if (method === "GET" && p === "/v1/invoices") {
      const q = url.searchParams;
      const list = [...invoices.values()]
        .filter((i) => (!q.get("customer") || i.customer === q.get("customer")) && (!q.get("subscription") || i.parent?.subscription_details?.subscription === q.get("subscription")) && (!q.get("status") || i.status === q.get("status")))
        .reverse();
      return ok({ data: list.slice(0, Number(q.get("limit") ?? 100)), has_more: false });
    }
    if (method === "GET" && p === "/v1/invoice_payments") {
      const inv = invoices.get(url.searchParams.get("invoice") ?? "");
      const paid = inv && inv.status === "paid" ? [{ id: `inpay_${String(inv.id).slice(3)}`, object: "invoice_payment", invoice: inv.id, status: "paid", amount_paid: inv.amount_paid, payment: { type: "payment_intent", payment_intent: paymentIntentFor(inv.id) } }] : [];
      return ok({ data: paid.filter((x) => !url.searchParams.get("status") || x.status === url.searchParams.get("status")), has_more: false });
    }
    if (method === "GET" && p === "/v1/refunds") {
      const q = url.searchParams;
      return ok({ data: [...refunds.values()].filter((r) => (!q.get("payment_intent") || r.payment_intent === q.get("payment_intent")) && (!q.get("charge") || r.charge === q.get("charge"))).reverse(), has_more: false });
    }
    if (method === "POST" && p === "/v1/refunds") {
      const key = headers["idempotency-key"];
      if (key && refundKeys.has(key)) return ok(refundKeys.get(key));
      const r = { id: `re_test${String(refunds.size + 1).padStart(6, "0")}`, object: "refund", status: "succeeded", amount: Number(form!.get("amount")), payment_intent: form!.get("payment_intent"), charge: form!.get("charge"), reason: form!.get("reason"), metadata: formObject(form!, "metadata") };
      refunds.set(r.id, r);
      if (key) refundKeys.set(key, r);
      return ok(r);
    }
    const ch = /^\/v1\/charges\/([^/]+)$/.exec(p);
    if (method === "GET" && ch) {
      const c = charges.get(decodeURIComponent(ch[1]!));
      return c ? ok(c) : ok({ error: { code: "resource_missing", message: "No such charge" } }, 404);
    }
    if (method === "POST" && p === "/v1/customers") {
      const c = { id: `cus_test${String(++n).padStart(4, "0")}`, object: "customer", email: form!.get("email"), description: form!.get("description"), metadata: formObject(form!, "metadata") };
      customers.set(c.id, c);
      return ok(c);
    }
    if (method === "POST" && p === "/v1/checkout/sessions") {
      const id = `cs_test_${String(++cs).padStart(6, "0")}`;
      const s = {
        id,
        object: "checkout.session",
        status: "open",
        mode: form!.get("mode"),
        customer: form!.get("customer"),
        metadata: formObject(form!, "metadata"),
        url: `https://checkout.stripe.com/c/pay/${id}`,
      };
      sessions.set(id, s);
      return ok(s);
    }
    if (method === "GET" && p === "/v1/checkout/sessions") {
      const q = url.searchParams;
      return ok({ data: [...sessions.values()].filter((s) => s.customer === q.get("customer") && (!q.get("status") || s.status === q.get("status"))).reverse() });
    }
    const exp = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(p);
    if (method === "POST" && exp) {
      const s = sessions.get(decodeURIComponent(exp[1]!));
      if (!s) return ok({ error: { message: "No such checkout.session" } }, 404);
      s.status = "expired";
      return ok(s);
    }
    if (method === "GET" && p === "/v1/subscriptions") {
      const customer = url.searchParams.get("customer");
      const withInvoice = expands(url).includes("data.latest_invoice");
      return ok({ data: [...subs.values()].filter((s) => s.customer === customer).map((s) => (withInvoice ? { ...s, latest_invoice: latest(s) } : s)) });
    }
    if (method === "GET" && p === "/v1/billing_portal/configurations") {
      const d = url.searchParams.get("is_default");
      return ok({ data: portal.filter((c) => d === null || String(c.is_default) === d), has_more: false });
    }
    const bpc = /^\/v1\/billing_portal\/configurations\/([^/]+)$/.exec(p);
    if (method === "GET" && bpc) {
      const c = portal.find((x) => x.id === decodeURIComponent(bpc[1]!));
      return c ? ok(c) : ok({ error: { code: "resource_missing", message: "No such configuration" } }, 404);
    }
    if (method === "POST" && p === "/v1/billing_portal/sessions") return ok({ url: "https://billing.stripe.com/p/session/test_000001" });
    const sub = /^\/v1\/subscriptions\/([^/]+)$/.exec(p);
    if (sub) {
      const s = subs.get(decodeURIComponent(sub[1]!));
      if (!s) return ok({ error: { message: "No such subscription" } }, 404);
      if (method === "DELETE") s.status = "canceled";
      if (method === "GET") {
        const out: Record<string, any> = { ...s };
        if (expands(url).includes("customer")) {
          const id = String(s.customer);
          out.customer = customers.get(id) ?? { id, object: "customer", metadata: {} };
        }
        if (expands(url).includes("latest_invoice")) out.latest_invoice = latest(s);
        return ok(out);
      }
      return ok(s);
    }
    return ok({ error: { message: `fake Stripe has no ${method} ${p}` } }, 404);
  };
  /** A customer GenClass made for this account (as ensureCustomer does), for tests that start from a stored id. */
  const genclassCustomer = (id: string, accountId: string, email = "ada@example.com") => {
    customers.set(id, { id, object: "customer", email, description: "GenClass account", metadata: { genclass: "1", genclass_account: accountId } });
  };
  return { fetch, calls, other, customers, subs, sessions, invoices, refunds, charges, portal, genclassCustomer };
}

/** A price as a subscription fetched with its products expanded shows it: GenClass's carry product metadata genclass_plan. */
export function price(lookupKey: string | null, o: { id?: string; plan?: string | null; product?: string } = {}) {
  const plan = o.plan !== undefined ? o.plan : lookupKey === "genclass_custom_monthly" ? "custom" : lookupKey === "genclass_pro_monthly" ? "pro" : null;
  const id = o.id ?? (lookupKey === "genclass_custom_monthly" ? "price_custom0001" : lookupKey === "genclass_pro_monthly" ? "price_pro000001" : "price_x000001");
  return { id, object: "price", lookup_key: lookupKey, product: { id: o.product ?? (plan ? `genclass_${plan}` : "prod_polar00001"), object: "product", metadata: plan ? { genclass_plan: plan } : {} } };
}

/** A GenClass subscription as Stripe API 2025-03-31 returns it (the period end on the item; prices' products expanded). */
export function subscription(id: string, accountId: string, customer: string, lookupKey: string | null, status = "active", over: Record<string, unknown> = {}) {
  return {
    id,
    object: "subscription",
    customer,
    status,
    created: 1_790_000_000,
    metadata: { genclass: "1", genclass_account: accountId },
    cancel_at_period_end: false,
    cancel_at: null,
    items: { data: [{ id: `si_${id.slice(4)}`, current_period_end: 1_792_000_000, price: price(lookupKey) }] },
    ...over,
  };
}

/** The paid period of the fake's invoices and subscriptions: 30 days to 1_792_000_000, which is 29 h 46 min after T0. */
export const PERIOD = { start: 1_789_408_000, end: 1_792_000_000 };

/** The payment intent that paid a fake invoice (its one invoice payment). */
export const paymentIntentFor = (invoiceId: string): string => `pi_${invoiceId.replace(/^in_/, "").replace(/[^A-Za-z0-9]/g, "")}000000`;

/**
 * A subscription invoice as Stripe API 2025-03-31 returns it (the subscription under parent.subscription_details, the
 * price under pricing.price_details, each line's service period), with one line per [price id, amount]; amount_due is
 * their sum, amount_paid too once paid.
 */
export function invoice(id: string, customer: string, sub: string, lines: [string, number][], status = "paid") {
  const total = lines.reduce((n, [, a]) => n + a, 0);
  return {
    id,
    object: "invoice",
    customer,
    status,
    currency: "usd",
    amount_due: total,
    amount_paid: status === "paid" ? total : 0,
    parent: { type: "subscription_details", subscription_details: { subscription: sub, metadata: { genclass: "1" } } },
    lines: { data: lines.map(([p, amount]) => ({ amount, period: { ...PERIOD }, pricing: { price_details: { price: p } } })) },
  };
}

export const WEBHOOK_SECRET = "whsec_test_0123456789abcdef";

async function hmacHex(secret: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function stripeHeader(body: string, o: { secret?: string; t?: number } = {}): Promise<string> {
  const t = o.t ?? Math.floor(clock.getTime() / 1000);
  return `t=${t},v1=${await hmacHex(o.secret ?? WEBHOOK_SECRET, `${t}.${body}`)}`;
}

let evt = 0;
export function stripeEvent(type: string, object: Record<string, unknown>, id = `evt_test${String(++evt).padStart(6, "0")}`, extra: Record<string, unknown> = {}) {
  return { id, object: "event", type, created: Math.floor(clock.getTime() / 1000), data: { object }, ...extra };
}

/** A rate limiter that refuses everything (to test the 429s). */
export const refusingLimiter = { async limit() { return { success: false }; } };

/** Deliver an event to /api/billing/webhook as Stripe does (no Origin, no cookie, signed). */
export async function deliver(env: Env, event: unknown, f: Fetch, o: { secret?: string; t?: number; header?: string } = {}): Promise<Response> {
  const body = JSON.stringify(event);
  const header = o.header ?? (await stripeHeader(body, o));
  return call(env, "POST", "/api/billing/webhook", { body, origin: null, headers: { "stripe-signature": header }, fetch: f });
}

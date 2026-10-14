// Shared by the paid-plan tests (billing, forward, export): an env over node:sqlite with an R2 stand-in that keeps the
// bytes, signed-in accounts made through the real passkey routes, apps, batches through the real collector, a fake
// Stripe API, and Stripe-signed webhook deliveries.
import { expect } from "vitest";
import { handle, type Env, type HandleOptions } from "../src/collector.js";
import { makeAuthenticator } from "./authenticator.mjs";
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

/** A new account signed in with a passkey: its session cookie and id. */
export async function signedIn(env: Env, email = "ada@example.com") {
  const auth = await makeAuthenticator(-7);
  const o = await call(env, "POST", "/api/auth/passkey/register/options", { body: { email } });
  const opts = (await o.json()) as any;
  const credential = await auth.register(opts.publicKey);
  const res = await call(env, "POST", "/api/auth/passkey/register/verify", { body: { id: opts.id, credential } });
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

/**
 * A fake fetch for api.stripe.com (and any other URL, recorded and answered 200 unless `answer` says otherwise). It
 * keeps subscriptions (`subs`, listed by customer) and Checkout Sessions (`sessions`: created open, listed by customer
 * and status, expired on request).
 */
export function fakeStripe(o: { answer?: (url: URL, init: RequestInit) => Response | undefined } = {}) {
  const calls: StripeCall[] = [];
  const other: { url: string; init: RequestInit; body: string }[] = [];
  const subs = new Map<string, Record<string, any>>();
  const sessions = new Map<string, Record<string, any>>();
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
      const key = url.searchParams.get("lookup_keys[0]");
      const known: Record<string, string> = { genclass_pro_monthly: "price_pro000001", genclass_custom_monthly: "price_custom0001" };
      return ok({ data: key && known[key] ? [{ id: known[key], lookup_key: key }] : [] });
    }
    if (method === "POST" && p === "/v1/customers") return ok({ id: `cus_test${String(++n).padStart(4, "0")}` });
    if (method === "POST" && p === "/v1/checkout/sessions") {
      const id = `cs_test_${String(++cs).padStart(6, "0")}`;
      const s = {
        id,
        object: "checkout.session",
        status: "open",
        customer: form!.get("customer"),
        metadata: { account_id: form!.get("metadata[account_id]"), plan: form!.get("metadata[plan]") },
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
      return ok({ data: [...subs.values()].filter((s) => s.customer === customer) });
    }
    if (method === "GET" && p === "/v1/billing_portal/configurations") return ok({ data: [{ id: "bpc_other00001", metadata: {} }, { id: "bpc_genclass01", metadata: { genclass: "portal" } }] });
    if (method === "POST" && p === "/v1/billing_portal/sessions") return ok({ url: "https://billing.stripe.com/p/session/test_000001" });
    const sub = /^\/v1\/subscriptions\/([^/]+)$/.exec(p);
    if (sub) {
      const s = subs.get(decodeURIComponent(sub[1]!));
      if (!s) return ok({ error: { message: "No such subscription" } }, 404);
      if (method === "DELETE") s.status = "canceled";
      return ok(s);
    }
    return ok({ error: { message: `fake Stripe has no ${method} ${p}` } }, 404);
  };
  return { fetch, calls, other, subs, sessions };
}

/** A subscription as Stripe API 2025-03-31 returns it (the period end on the item). */
export function subscription(id: string, accountId: string, customer: string, lookupKey: string | null, status = "active", over: Record<string, unknown> = {}) {
  const price = lookupKey === "genclass_custom_monthly" ? "price_custom0001" : lookupKey === "genclass_pro_monthly" ? "price_pro000001" : "price_x000001";
  return {
    id,
    object: "subscription",
    customer,
    status,
    created: 1_790_000_000,
    metadata: { account_id: accountId },
    cancel_at_period_end: false,
    cancel_at: null,
    items: { data: [{ id: `si_${id.slice(4)}`, current_period_end: 1_792_000_000, price: { id: price, lookup_key: lookupKey } }] },
    ...over,
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

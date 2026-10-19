// GenClass telemetry collector: a Cloudflare Worker that accepts batches from @genclass/runtime
// (packages/runtime/src/telemetry/*) and writes them, gzip-compressed JSON Lines, to R2.
//
// Privacy invariants (packages/runtime/TELEMETRY.md):
// - Never store the client IP, user agent, cookies or any request header. The only server-side additions are
//   `receivedAt` (ISO time) and `country` (Cloudflare's coarse two-letter `request.cf.country`).
// - Only the known top-level batch fields are kept; anything else is dropped.
// - Nothing from the request is logged (wrangler.toml disables observability).
//
// Routes: POST /v1/events (application/json or text/plain, so navigator.sendBeacon needs no CORS preflight),
// OPTIONS /v1/events (CORS preflight), GET /v1/health.
//
// Per-app tokens and dashboards (src/dashboard.ts, src/pages.ts; also routed on genclass.dev/{api/*,start*,dashboard*}):
// POST /api/projects, GET /api/projects/<secret>, GET /start, GET /dashboard/<secret>. A batch with a known top-level
// `token` is also aggregated into D1 for that app's dashboard; without one it is stored in R2 only, exactly as before.
// Every plan includes the dashboard (billing/plans.json), so a private link opens it, also for an app with no account
// (Free). A plan file that left the dashboard out would open the locked page instead (src/locked.ts) and its stats
// would answer 402. Collection never depends on it: every known token is aggregated.
//
// Accounts (src/auth.ts, src/account-pages.ts; routed on genclass.dev/{login*,signup*,logout*,account*,auth/*} and
// /api/{auth,device,me,account}*): passkeys, Google and GitHub sign-in, sessions, the CLI's device flow, owned apps.

import { lockedError, routeAuth, runtimeHasTokens } from "./auth.js";
import {
  aggregate,
  createProject,
  knownToken,
  projectBySecret,
  projectsCreatedSince,
  randomBase62,
  RANGES,
  sanitizeName,
  sha256Hex,
  stats,
  TOKEN_RE,
  type D1Like,
  type Range,
} from "./dashboard.js";
import { routeBilling } from "./billing.js";
import { json, readCapped } from "./http.js";
import { afterBatch } from "./paid.js";
import { dashboardPage, notFoundPage, securityHeaders, startPage } from "./pages.js";
import { lockedLink } from "./locked.js";
import { hasDashboard, projectAccess } from "./plans.js";
import { SAMPLE_PROJECT, SAMPLE_SECRET, sampleStats } from "./sample.js";

export const SCHEMA = "genclass-telemetry/1";
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_EVENTS = 500;

/** The subset of the R2 binding this worker uses (avoids a dependency on @cloudflare/workers-types). */
export interface BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: Record<string, string> }): Promise<unknown>;
  /** The export (src/export.ts) reads stored batches back and the sweep deletes export copies. */
  get?(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete?(keys: string | string[]): Promise<unknown>;
}

export interface RateLimiterLike {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  BUCKET: BucketLike;
  /** D1 `genclass-dashboard` (projects and aggregates). Without it the worker is the plain R2 collector. */
  DB?: D1Like;
  /** Workers Rate Limiting binding for project creation (10 / 60 s per client). */
  CREATE_LIMITER?: RateLimiterLike;
  /** Workers Rate Limiting binding for batches (60 / 60 s per client IP; the IP is only the counter key, never stored). */
  LIMIT?: RateLimiterLike;
  /** Workers Rate Limiting binding for batches per session id (the `sid` in the body). */
  SESSION_LIMIT?: RateLimiterLike;
  /** Service binding to the site worker (`genclass-site`), for genclass.dev paths this worker does not serve. */
  SITE?: { fetch(request: Request): Promise<Response> };
  /** Origin used in dashboard links (default https://genclass.dev). */
  DASHBOARD_ORIGIN?: string;
  /** Workers Rate Limiting binding for sign-up, sign-in options and the device flow (20 / 60 s per client and route). */
  AUTH_LIMIT?: RateLimiterLike;
  /** The origin accounts live on: cookies, the CSRF Origin check, WebAuthn and OAuth redirects (default https://genclass.dev). */
  AUTH_ORIGIN?: string;
  /** WebAuthn relying party id (default genclass.dev). */
  AUTH_RP_ID?: string;
  /** The newest @genclass/runtime on npm, on any dist-tag (a var in wrangler.toml): "0.3.0-beta.0" once release.yml
   * has published the beta. Below 0.3.0-beta.0 the Connect panel, /start and private dashboards say first that
   * project keys and `login` are not published yet; unset counts as not published. */
  RUNTIME_ON_NPM?: string;
  /** Google sign-in (Worker secrets). The Google button is shown only when both are set. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** GitHub sign-in (Worker secrets). The GitHub button is shown only when both are set. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Paid plans (src/plans.ts, src/stripe.ts; Worker secrets). A live key (sk_live_) puts them on sale and the Free
   * plan's limits apply; a test key (sk_test_) lets only the accounts in STRIPE_TEST_ACCOUNTS (emails or account ids,
   * comma-separated) buy, with no limits for anyone. The webhook checks STRIPE_WEBHOOK_SECRET with a live key and
   * STRIPE_WEBHOOK_SECRET_TEST with a test key (503 without it). */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_WEBHOOK_SECRET_TEST?: string;
  STRIPE_TEST_ACCOUNTS?: string;
  /** GenClass's own Billing Portal configuration (bpc_...), for a live key and for a test key; scripts/stripe-setup.mjs
   * stores the one for its key's mode. Without it the portal answers 503. */
  STRIPE_PORTAL_CONFIGURATION?: string;
  STRIPE_PORTAL_CONFIGURATION_TEST?: string;
  /** Worker var (wrangler.toml, "off" until verified): "on" makes the Checkout of a plan marked managed_payments in
   * billing/plans.json (none today) use Stripe Managed Payments (Stripe, through Link, is the merchant of record).
   * Unset or "off" sells every plan on standard Checkout (src/stripe.ts managedPayments). */
  MANAGED_PAYMENTS?: string;
  /** Export pages per account per minute (src/billing.ts); without it the export is not rate-limited. */
  EXPORT_LIMIT?: RateLimiterLike;
  /** 32 bytes, base64: encrypts forwarding settings at rest (src/forward.ts). Without it they cannot be saved. */
  INTEGRATIONS_KEY?: string;
  /** Optional https URL that gets short JSON notices: a Custom purchase, a duplicate subscription, a plan switch
   * that needs a refund by hand, a billing record holding something that is not GenClass's. */
  NOTIFY_WEBHOOK?: string;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export function reply(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Path-segment-safe version label: `[A-Za-z0-9._+-]`, at most 40 chars, else `fallback`. */
export function pathLabel(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const s = v.trim();
  return /^[A-Za-z0-9._+-]{1,40}$/.test(s) ? s : fallback;
}

export interface Batch {
  schema: string;
  sid: string;
  sent: number;
  runtime: string;
  model: string | null;
  /** Per-app token (`gc_` + 22 base62), only when present and well-formed. */
  token?: string;
  events: Record<string, unknown>[];
}

/** Validate a parsed body. Returns the normalised batch (unknown top-level fields dropped) or an error string. */
export function validate(body: unknown): Batch | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (b.schema !== SCHEMA) return `schema must be "${SCHEMA}"`;
  if (typeof b.sid !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(b.sid)) return "sid must be 8-64 chars [A-Za-z0-9_-]";
  if (typeof b.sent !== "number" || !Number.isFinite(b.sent)) return "sent must be a finite number";
  if (typeof b.runtime !== "string" || b.runtime.length === 0 || b.runtime.length > 40) return "runtime must be a version string";
  if (b.model !== null && b.model !== undefined && (typeof b.model !== "string" || b.model.length > 80)) {
    return "model must be a string or null";
  }
  if (!Array.isArray(b.events)) return "events must be an array";
  if (b.events.length === 0) return "events must not be empty";
  if (b.events.length > MAX_EVENTS) return `at most ${MAX_EVENTS} events per batch`;
  for (const e of b.events) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return "each event must be an object";
    const t = (e as Record<string, unknown>).t;
    if (typeof t !== "string" || t.length === 0 || t.length > 32) return "each event needs a string type `t`";
  }
  return {
    schema: SCHEMA,
    sid: b.sid,
    sent: b.sent,
    runtime: b.runtime,
    model: typeof b.model === "string" ? b.model : null,
    // optional; a missing or malformed token never rejects the batch (it is simply not attributed to an app)
    ...(typeof b.token === "string" && TOKEN_RE.test(b.token) ? { token: b.token } : {}),
    events: b.events as Record<string, unknown>[],
  };
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface HandleOptions {
  /** Injected for tests. */
  now?: () => Date;
  uuid?: () => string;
  /** Outgoing requests to Google and GitHub during sign-in (the global fetch in production; tests mock it). */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** ctx.waitUntil in production (aggregation runs after the response); tests await inline. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** Requests on genclass.dev that this worker does not serve go on to the site (fetch in production). */
  passthrough?: (request: Request) => Promise<Response>;
}

export async function handle(request: Request, env: Env, opts: HandleOptions = {}): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/v1/health" && (request.method === "GET" || request.method === "HEAD")) {
    return reply(200, { ok: true, schema: SCHEMA });
  }
  if (path === "/v1/events" || path === "/api/v1/events") return ingest(request, env, opts);
  const billing = await routeBilling(request, url, path, env, opts);
  if (billing) return billing;
  const account = await routeAuth(request, url, path, env, opts);
  if (account) return account;
  const site = await routeSite(request, url, path, env, opts);
  if (site) return site;
  // On genclass.dev, anything else under the routed prefixes belongs to the site.
  if (!url.hostname.endsWith(".workers.dev") && url.hostname !== "localhost" && opts.passthrough !== undefined) {
    return opts.passthrough(request);
  }
  return reply(404, { ok: false, error: "not found" });
}

/** One limiter check. A missing or failing limiter lets the request through (the limiters are best effort). */
async function allowed(limiter: RateLimiterLike | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

async function ingest(request: Request, env: Env, opts: HandleOptions): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return reply(405, { ok: false, error: "method not allowed" });

  const ct = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json" && ct !== "text/plain") {
    return reply(415, { ok: false, error: "content-type must be application/json or text/plain" });
  }

  // Abuse guard, per IP: a ceiling high enough for an office or campus behind one address (the runtime sends at most
  // one batch every 10 s per page, and since 0.2.2 a page stops sending after 3 failed requests in a row, so a low
  // per-IP limit would silence every page behind a shared NAT for good). The per-session budget below is the tight one.
  if (!(await allowed(env.LIMIT, request.headers.get("cf-connecting-ip") ?? "unknown"))) {
    return reply(429, { ok: false, error: "too many batches; slow down" });
  }

  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (raw === null) return reply(413, { ok: false, error: `body over ${MAX_BODY_BYTES} bytes` });

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return reply(400, { ok: false, error: "invalid JSON" });
  }
  const batch = validate(parsed);
  if (typeof batch === "string") return reply(400, { ok: false, error: batch });
  // Per session: one page sends about 6 batches a minute; the budget leaves room for flushes on hide and unload.
  if (!(await allowed(env.SESSION_LIMIT, `sid:${batch.sid}`))) return reply(429, { ok: false, error: "too many batches; slow down" });

  const now = (opts.now ?? (() => new Date()))();
  const receivedAt = now.toISOString();
  // Coarse country only; never the IP, colo, city, ASN or any header.
  const cf = (request as unknown as { cf?: { country?: unknown } }).cf;
  const country = typeof cf?.country === "string" && /^[A-Z0-9]{2}$/.test(cf.country) ? cf.country : null;

  const meta = {
    sid: batch.sid, runtime: batch.runtime, model: batch.model, sent: batch.sent, receivedAt, country,
    ...(batch.token ? { token: batch.token } : {}),
  };
  const lines = batch.events.map((event) => JSON.stringify({ ...meta, event })).join("\n") + "\n";

  const dt = receivedAt.slice(0, 10);
  const rt = pathLabel(batch.runtime, "unknown");
  const model = pathLabel(batch.model, "none");
  const id = (opts.uuid ?? (() => crypto.randomUUID()))();
  const key = `events/dt=${dt}/rt=${rt}/model=${model}/${id}.jsonl.gz`;

  const gz = await gzip(lines);
  try {
    await env.BUCKET.put(key, gz, {
      httpMetadata: { contentType: "application/gzip" },
    });
  } catch {
    return reply(503, { ok: false, error: "storage unavailable" });
  }

  // Dashboard aggregation for a known token. Never affects the response (failures are swallowed).
  const db = env.DB;
  if (batch.token && db) {
    const token = batch.token;
    const task = (async () => {
      if (!(await knownToken(db, token, now.getTime()))) return;
      await aggregate(db, token, batch, now).catch(() => undefined);
      // export index, and forwarding for apps on a paid plan (src/paid.ts)
      const f = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
      await afterBatch(env, db, { token, runtime: batch.runtime, model: batch.model, events: batch.events, key, gz, received: receivedAt, id }, now, f);
    })().catch(() => undefined);
    if (opts.waitUntil) opts.waitUntil(task);
    else await task;
  }
  return reply(202, { ok: true, accepted: batch.events.length });
}

// ------------------------------------------------------------------------------------------ tokens and dashboards

/** Global ceiling on anonymous project creation (all clients together; apps created in accounts count separately). */
export const MAX_PROJECTS_PER_MINUTE = 60;

const PROJECT_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function html(status: number, body: string, nonce: string): Response {
  return new Response(body, { status, headers: securityHeaders(nonce) });
}

async function routeSite(request: Request, url: URL, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  const m = request.method;
  const now = (opts.now ?? (() => new Date()))();

  if (path === "/api/projects") {
    if (m === "OPTIONS") return new Response(null, { status: 204, headers: PROJECT_CORS });
    if (m !== "POST") return json(405, { ok: false, error: "method not allowed" }, PROJECT_CORS);
    if (!env.DB) return json(503, { ok: false, error: "dashboards unavailable" }, PROJECT_CORS);
    if (env.CREATE_LIMITER) {
      // The limiter key is a hash of the client IP; the IP itself is never stored or logged.
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.CREATE_LIMITER.limit({ key: (await sha256Hex(`create:${ip}`)).slice(0, 32) });
      if (!success) return json(429, { ok: false, error: "too many projects created; try again in a minute" }, { ...PROJECT_CORS, "retry-after": "60" });
    }
    // Backstop for the (per-location, eventually consistent) limiter: a global ceiling on new projects per minute.
    if ((await projectsCreatedSince(env.DB, new Date(now.getTime() - 60_000), "anonymous")) >= MAX_PROJECTS_PER_MINUTE) {
      return json(429, { ok: false, error: "too many projects created; try again in a minute" }, { ...PROJECT_CORS, "retry-after": "60" });
    }
    const raw = await readCapped(request, 4096);
    if (raw === null) return json(413, { ok: false, error: "body too large" }, PROJECT_CORS);
    let body: unknown = {};
    const text = new TextDecoder().decode(raw).trim();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return json(400, { ok: false, error: "invalid JSON" }, PROJECT_CORS);
      }
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return json(400, { ok: false, error: "body must be a JSON object" }, PROJECT_CORS);
    const name = sanitizeName((body as Record<string, unknown>).name);
    const p = await createProject(env.DB, name, now);
    const origin = (env.DASHBOARD_ORIGIN ?? "https://genclass.dev").replace(/\/+$/, "");
    return json(201, { token: p.token, dashboardUrl: `${origin}/dashboard/${p.secret}`, name: p.name, created: p.created }, PROJECT_CORS);
  }

  const api = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (api) {
    if (m !== "GET" && m !== "HEAD") return json(405, { ok: false, error: "method not allowed" });
    if (api[1] === SAMPLE_SECRET) return json(200, sampleStats(url.searchParams.get("range"), now));
    const p = env.DB ? await projectBySecret(env.DB, api[1]!) : null;
    if (!p || !env.DB) return json(404, { ok: false, error: "not found" });
    if (!hasDashboard(await projectAccess(env.DB, p, env, now))) return json(402, { ok: false, error: lockedError(env), locked: true });
    const r = url.searchParams.get("range") as Range | null;
    const range: Range = r && RANGES.includes(r) ? r : "7d";
    return json(200, await stats(env.DB, p, range, now));
  }

  if (path === "/start") {
    if (m !== "GET" && m !== "HEAD") return null;
    const nonce = randomBase62(22);
    return html(200, startPage(nonce, { runtimeReady: runtimeHasTokens(env) }), nonce);
  }

  if (path === "/dashboard") {
    if (m !== "GET" && m !== "HEAD") return null;
    return new Response(null, { status: 302, headers: { location: "/start", "cache-control": "no-store" } });
  }

  const dash = /^\/dashboard\/([^/]+)$/.exec(path);
  if (dash) {
    if (m !== "GET" && m !== "HEAD") return null;
    const nonce = randomBase62(22);
    const runtimeReady = runtimeHasTokens(env);
    if (dash[1] === SAMPLE_SECRET) return html(200, dashboardPage(nonce, { ...SAMPLE_PROJECT, lastEvent: new Date(now.getTime() - 180_000).toISOString() }, { runtimeReady }), nonce);
    const p = env.DB ? await projectBySecret(env.DB, dash[1]!) : null;
    if (!p || !env.DB) return html(404, notFoundPage(nonce), nonce);
    // locked only while the app's plan leaves the dashboard out (none does today): sign in, add it, see the plans
    if (!hasDashboard(await projectAccess(env.DB, p, env, now))) return lockedLink(request, url, env, opts, p);
    return html(200, dashboardPage(nonce, { name: p.name, token: p.token, created: p.created, lastEvent: p.last_event }, { runtimeReady }), nonce);
  }

  if (path.startsWith("/api/")) return json(404, { ok: false, error: "not found" });
  return null;
}

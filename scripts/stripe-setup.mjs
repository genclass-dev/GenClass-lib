#!/usr/bin/env node
// Stripe setup for GenClass's paid plans, for the owner to run (Node 20 or later, no dependencies).
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs     test mode first
//   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs     then live
//
// It reads billing/plans.json and, in the Stripe account the key belongs to (it says which mode):
// 1. creates or updates a product per paid plan (GenClass Pro, GenClass Custom) and its monthly price under the
//    plan's lookup_key (a changed amount gets a new price; the lookup key moves to it);
// 2. creates the webhook endpoint https://genclass.dev/api/billing/webhook for the events the worker handles, and
//    pipes its signing secret straight into `npx wrangler secret put STRIPE_WEBHOOK_SECRET` (it is never printed);
//    an existing endpoint keeps its secret, since Stripe shows a secret only once (--new-webhook replaces it);
// 3. configures the Billing Portal: cancel at the end of the period, switch between Pro and Custom, update the card,
//    invoices;
// then prints the remaining steps. Running it again changes only what differs.
//
// Flags: --dry-run (read only: say what would change), --new-webhook (delete and recreate the endpoint and secret).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(ROOT, "telemetry-worker");
const SITE = "https://genclass.dev";
const WEBHOOK_URL = `${SITE}/api/billing/webhook`;
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const NEW_WEBHOOK = args.has("--new-webhook");
for (const a of args) if (!["--dry-run", "--new-webhook"].includes(a)) fail(`unknown option ${a} (use --dry-run or --new-webhook)`);

// The API version and the webhook events come from the worker's own source, so the two cannot drift.
const stripeTs = readFileSync(join(WORKER, "src/stripe.ts"), "utf8");
const API_VERSION = /export const STRIPE_VERSION = "([^"]+)"/.exec(stripeTs)?.[1];
const EVENTS = [...(/export const WEBHOOK_EVENTS = \[([^\]]+)\]/.exec(stripeTs)?.[1] ?? "").matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]);
if (!API_VERSION || EVENTS.length === 0) fail("could not read STRIPE_VERSION and WEBHOOK_EVENTS from telemetry-worker/src/stripe.ts");
const PLANS = JSON.parse(readFileSync(join(ROOT, "billing/plans.json"), "utf8"));

const KEY = (process.env.STRIPE_SECRET_KEY ?? "").trim();
const mode = /^(sk|rk)_test_/.test(KEY) ? "test" : /^(sk|rk)_live_/.test(KEY) ? "live" : null;
if (!mode) fail("set STRIPE_SECRET_KEY to a Stripe secret key (sk_test_... or sk_live_...) in your environment");

function fail(msg) {
  console.error(`stripe-setup: ${msg}`);
  process.exit(1);
}

// --------------------------------------------------------------------------------------------- Stripe REST

function form(params) {
  const out = [];
  const walk = (key, v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${key}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(`${key}[${k}]`, x);
    else out.push([key, String(v)]);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return new URLSearchParams(out).toString();
}

async function stripe(method, path, params) {
  const qs = method === "GET" && params ? `?${form(params)}` : "";
  const headers = { authorization: `Bearer ${KEY}`, "stripe-version": API_VERSION };
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers["idempotency-key"] = crypto.randomUUID(); // a retried request is not applied twice
  }
  const body = method === "POST" ? form(params ?? {}) : undefined;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.stripe.com${path}${qs}`, { method, headers, body, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      if (attempt < 2) continue;
      fail(`no answer from Stripe for ${method} ${path} (${e?.message ?? e})`);
    }
    const j = await res.json().catch(() => ({}));
    if (res.status >= 500 && attempt < 2) continue;
    if (!res.ok) fail(`Stripe refused ${method} ${path}: ${j?.error?.message ?? `HTTP ${res.status}`}`);
    return j;
  }
}

async function listAll(path, params = {}) {
  const out = [];
  let after;
  for (;;) {
    const page = await stripe("GET", path, { ...params, limit: 100, starting_after: after });
    out.push(...(page.data ?? []));
    if (!page.has_more || !page.data?.length) return out;
    after = page.data[page.data.length - 1].id;
  }
}

const say = (s) => console.log(s);
const would = (s) => say(`${DRY ? "would " : ""}${s}`);

// --------------------------------------------------------------------------------------------- products and prices

async function products() {
  const paid = PLANS.plans.filter((p) => p.price_usd_cents.monthly > 0);
  const existing = await listAll("/v1/products", { active: true });
  const result = {};
  for (const plan of paid) {
    const name = `GenClass ${plan.name}`;
    let product = existing.find((p) => p.metadata?.genclass_plan === plan.id);
    if (!product) {
      would(`create product ${name}`);
      product = DRY ? { id: `(new ${plan.id} product)` } : await stripe("POST", "/v1/products", { name, description: plan.summary, metadata: { genclass_plan: plan.id } });
    } else if (product.name !== name || product.description !== plan.summary) {
      would(`update product ${name} (${product.id})`);
      if (!DRY) product = await stripe("POST", `/v1/products/${product.id}`, { name, description: plan.summary });
    } else say(`product ${name}: ${product.id}, unchanged`);
    result[plan.id] = { product: product.id, prices: [] };
    for (const [interval, field] of [["month", "monthly"], ["year", "yearly"]]) {
      const lookup = plan.stripe_lookup_keys[field];
      const cents = plan.price_usd_cents[field];
      if (!lookup || cents === null || cents === undefined) continue;
      const [price] = (await stripe("GET", "/v1/prices", { lookup_keys: [lookup], limit: 1 })).data ?? [];
      const same = price && price.active && price.unit_amount === cents && price.currency === PLANS.currency && price.recurring?.interval === interval && price.product === product.id;
      if (same) {
        say(`price ${lookup}: ${price.id}, US$${cents / 100} per ${interval}, unchanged`);
        result[plan.id].prices.push(price.id);
        continue;
      }
      would(`create price ${lookup}: US$${cents / 100} per ${interval}${price ? ` (replaces ${price.id}; its subscribers stay on it until moved)` : ""}`);
      if (DRY) continue;
      const created = await stripe("POST", "/v1/prices", {
        product: product.id,
        unit_amount: cents,
        currency: PLANS.currency,
        recurring: { interval },
        lookup_key: lookup,
        transfer_lookup_key: true,
        nickname: `${plan.name} ${field}`,
        metadata: { genclass_plan: plan.id },
      });
      if (price?.active) await stripe("POST", `/v1/prices/${price.id}`, { active: false });
      result[plan.id].prices.push(created.id);
    }
  }
  return result;
}

// --------------------------------------------------------------------------------------------- webhook

function wranglerSecret(name, value) {
  return new Promise((resolve) => {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(npx, ["--yes", "wrangler@4", "secret", "put", name], { cwd: WORKER, stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(`${value}\n`);
  });
}

async function webhook() {
  const all = await listAll("/v1/webhook_endpoints");
  const mine = all.filter((w) => w.url === WEBHOOK_URL);
  const current = mine[0];
  if (current && !NEW_WEBHOOK) {
    const missing = EVENTS.filter((e) => !current.enabled_events?.includes(e));
    const extra = (current.enabled_events ?? []).filter((e) => !EVENTS.includes(e));
    if (missing.length || extra.length || current.status !== "enabled") {
      would(`update webhook endpoint ${current.id}: events ${EVENTS.join(", ")}`);
      if (!DRY) await stripe("POST", `/v1/webhook_endpoints/${current.id}`, { enabled_events: EVENTS, disabled: false });
    } else say(`webhook endpoint ${current.id}: unchanged`);
    if (current.api_version && current.api_version !== API_VERSION) {
      say(`  note: it was made for API version ${current.api_version}, the worker uses ${API_VERSION}; run again with --new-webhook to replace it`);
    }
    say("  its signing secret is unchanged: Stripe shows a secret only when an endpoint is created.");
    say("  If the worker has no STRIPE_WEBHOOK_SECRET for this mode yet, run again with --new-webhook.");
    return;
  }
  for (const w of mine) {
    would(`delete webhook endpoint ${w.id}`);
    if (!DRY) await stripe("DELETE", `/v1/webhook_endpoints/${w.id}`);
  }
  would(`create webhook endpoint ${WEBHOOK_URL} (API version ${API_VERSION}) and store its signing secret with wrangler`);
  if (DRY) return;
  const created = await stripe("POST", "/v1/webhook_endpoints", {
    url: WEBHOOK_URL,
    enabled_events: EVENTS,
    api_version: API_VERSION,
    description: "GenClass paid plans (telemetry-worker /api/billing/webhook)",
    metadata: { genclass: "webhook" },
  });
  say(`webhook endpoint ${created.id}: created; storing its signing secret as STRIPE_WEBHOOK_SECRET with wrangler...`);
  const ok = await wranglerSecret("STRIPE_WEBHOOK_SECRET", created.secret);
  if (!ok) fail("wrangler did not store STRIPE_WEBHOOK_SECRET (signed in? `npx wrangler login`). Run this again with --new-webhook for a new endpoint and secret.");
  say("STRIPE_WEBHOOK_SECRET stored on the worker.");
}

// --------------------------------------------------------------------------------------------- Billing Portal

async function portal(ids) {
  const products = Object.values(ids).filter((x) => x.prices.length && !x.product.startsWith("("));
  const params = {
    business_profile: { headline: "Manage your GenClass plan", privacy_policy_url: `${SITE}/privacy`, terms_of_service_url: `${SITE}/terms` },
    default_return_url: `${SITE}/account/billing`,
    features: {
      customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        cancellation_reason: { enabled: true, options: ["too_expensive", "missing_features", "switched_service", "unused", "other"] },
      },
      subscription_update: {
        enabled: products.length > 1,
        default_allowed_updates: ["price"],
        proration_behavior: "create_prorations",
        products: products.map((x) => ({ product: x.product, prices: x.prices })),
      },
    },
    metadata: { genclass: "portal" },
  };
  const existing = (await listAll("/v1/billing_portal/configurations", { active: true })).find((c) => c.metadata?.genclass === "portal");
  if (existing) {
    would(`update Billing Portal configuration ${existing.id}`);
    if (!DRY) await stripe("POST", `/v1/billing_portal/configurations/${existing.id}`, params);
  } else {
    would("create the Billing Portal configuration (the worker finds it by its metadata genclass=portal)");
    if (!DRY) await stripe("POST", "/v1/billing_portal/configurations", params);
  }
}

// --------------------------------------------------------------------------------------------- run

say(`Stripe ${mode} mode${DRY ? ", dry run (nothing is changed)" : ""}. API version ${API_VERSION}.`);
const ids = await products();
await webhook();
await portal(ids);
say(`
Done in ${mode} mode. The remaining steps, in this order (from telemetry-worker/):
1. The database migration:
     npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote
2. The R2 rule that keeps paid apps' export copies a year:
     npx --yes wrangler@4 r2 bucket lifecycle add genclass-telemetry expire-export-366d export/ --expire-days 366
3. The key that encrypts forwarding settings (once; replacing it makes saved settings unreadable):
     openssl rand -base64 32 | npx --yes wrangler@4 secret put INTEGRATIONS_KEY
4. Optional, a notice when someone buys Custom (an https URL, for example a Slack incoming webhook):
     npx --yes wrangler@4 secret put NOTIFY_WEBHOOK
5. Deploy:
     npx --yes wrangler@4 deploy
6. Put paid plans on sale with the ${mode} key (paste it when asked):
     npx --yes wrangler@4 secret put STRIPE_SECRET_KEY
${
  mode === "test"
    ? `7. Test: on ${SITE}/account/billing choose Upgrade to Pro and pay with card 4242 4242 4242 4242, any future
   date and any CVC. The page should show Pro within a minute. Try Manage billing, switch to Custom, cancel.
8. Then live: run this script again with STRIPE_SECRET_KEY=sk_live_..., then repeat step 6 with the live key.`
    : `7. Live payments are on. Check ${SITE}/account/billing while signed in.`
}`);

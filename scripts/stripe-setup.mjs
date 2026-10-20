#!/usr/bin/env node
// Stripe setup for GenClass's paid plans, for the owner to run (Node 20 or later, no dependencies).
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs     test mode first
//   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs     then live
//
// The key is for GenClass's own Stripe account ("GenClass", in the Stripe organization "GenClass"). GenClass used to
// bill through a Stripe account shared with another business, and this script keeps the rules it had then: it creates,
// finds and edits only GenClass's own objects, and never lists, changes, archives or deletes anything else
// (telemetry-worker/README.md, "Stripe object ownership"):
// 1. a product for each plan billing/plans.json prices above 0 (today GenClass Individual, id genclass_individual),
//    with metadata genclass_plan, the statement descriptor GENCLASS and the product tax code from billing/plans.json
//    (stripe_tax_code; Individual's is custom software, which Stripe Managed Payments does not sell, since a person
//    trains the model). Free costs nothing and Enterprise is agreed by email, so neither has a product. A product
//    from an earlier run (genclass_pro or genclass_custom, from the plans before 2026-10-19) is left as it is. A
//    product from an earlier run with an id Stripe chose is found by a search on metadata genclass_plan
//    (which returns only such products). A product with GenClass's id but without that metadata is not GenClass's:
//    the script stops and changes nothing;
// 2. each plan's monthly price under its lookup key from billing/plans.json (all start with genclass_). Prices are
//    read only by those lookup keys; a key on another product's price stops the script. A changed amount gets a new
//    price: the old one is archived and keeps a genclass_..._retired_<price id> lookup key, so its subscribers stay
//    on it and on their plan (the worker reads a plan from a genclass_ lookup key and the product's metadata);
// 3. its webhook endpoint https://genclass.dev/api/billing/webhook with the description "GenClass billing", for the
//    events the worker handles and no others (the customer.subscription events, invoice.paid, charge.refunded and
//    charge.dispute.created; the worker reads only ids and amounts from the last three, which carry the buyer's
//    details). Stripe has no search for endpoints, so the list is read to find that one; no other endpoint is ever
//    edited or deleted, and an endpoint for the same URL with another description stops the script. The new
//    endpoint's signing secret is piped straight into `npx wrangler secret put` (never printed):
//    STRIPE_WEBHOOK_SECRET in live mode, STRIPE_WEBHOOK_SECRET_TEST in test mode, so a test run can never replace
//    the live secret. An existing endpoint keeps its secret, since Stripe shows a secret only once (--new-webhook
//    deletes GenClass's endpoint, the one with that exact URL and description, and makes a new one);
// 4. its own Billing Portal configuration (metadata genclass=1, a headline naming GenClass): cancel at the end of the
//    period, update the card, invoices, and change the email or tax id on the GenClass customer (no address: GenClass
//    has no use for one). It offers no plan switch: a subscription sold through Managed Payments cannot take another
//    plan's price, so the billing page switches plans with a new Checkout (telemetry-worker/src/billing.ts). To find
//    it the script lists the non-default configurations (is_default=false), reading their settings and changing none
//    but its own: the account's default configuration is never read or changed, and GenClass's is never made the
//    default. Its id goes to the worker with `npx wrangler secret put` (STRIPE_PORTAL_CONFIGURATION in live mode,
//    STRIPE_PORTAL_CONFIGURATION_TEST in test mode): the worker fetches that one configuration by id, and lists none.
// Everything is read and checked first; changes start only when every check passed. Then it prints the remaining
// steps. Running it again changes only what differs (its portal configuration is written again with the same
// settings, and its id stored again). Account-wide settings (Managed Payments, business details, branding, customer
// emails, revenue recovery, Stripe Tax) are never changed: they are the owner's dashboard steps, which the script
// prints and the README lists in order.
//
// Flags: --dry-run (read only: say what would change), --new-webhook (replace GenClass's endpoint and its secret).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(ROOT, "telemetry-worker");
export const SITE = "https://genclass.dev";
export const WEBHOOK_URL = `${SITE}/api/billing/webhook`;
export const WEBHOOK_DESCRIPTION = "GenClass billing";
export const STATEMENT_DESCRIPTOR = "GENCLASS";
export const PORTAL_HEADLINE = "Manage your GenClass plan";
const TAX_CODE_RE = /^txcd_\d{8}$/;
/** metadata.genclass on everything GenClass creates in the Stripe account (the worker checks the same mark). */
const MARK = "1";
const LOOKUP_PREFIX = "genclass_";

// The API version and the webhook events come from the worker's own source, so the two cannot drift.
const stripeTs = readFileSync(join(WORKER, "src/stripe.ts"), "utf8");
export const API_VERSION = /export const STRIPE_VERSION = "([^"]+)"/.exec(stripeTs)?.[1];
export const EVENTS = [...(/export const WEBHOOK_EVENTS = \[([^\]]+)\]/.exec(stripeTs)?.[1] ?? "").matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]);
const PLANS = JSON.parse(readFileSync(join(ROOT, "billing/plans.json"), "utf8"));

export class SetupError extends Error {}
function fail(msg) {
  throw new SetupError(msg);
}

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

function wranglerSecret(name, value) {
  return new Promise((done) => {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(npx, ["--yes", "wrangler@4", "secret", "put", name], { cwd: WORKER, stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
    child.stdin.end(`${value}\n`);
  });
}

/**
 * The whole run. `fetch`, `log` and `putSecret` are parameters so the tests can run it against a fake Stripe
 * (telemetry-worker/test/stripe-setup.test.ts). Throws SetupError when a check fails.
 */
export async function main({ argv = process.argv.slice(2), env = process.env, fetch: fetchImpl = globalThis.fetch, log = console.log, putSecret = wranglerSecret } = {}) {
  const args = new Set(argv);
  for (const a of args) if (!["--dry-run", "--new-webhook"].includes(a)) fail(`unknown option ${a} (use --dry-run or --new-webhook)`);
  const DRY = args.has("--dry-run");
  const NEW_WEBHOOK = args.has("--new-webhook");
  if (!API_VERSION || EVENTS.length === 0) fail("could not read STRIPE_VERSION and WEBHOOK_EVENTS from telemetry-worker/src/stripe.ts");
  const KEY = (env.STRIPE_SECRET_KEY ?? "").trim();
  const mode = /^(sk|rk)_test_/.test(KEY) ? "test" : /^(sk|rk)_live_/.test(KEY) ? "live" : null;
  if (!mode) fail("set STRIPE_SECRET_KEY to a Stripe secret key (sk_test_... or sk_live_...) in your environment");
  // the worker reads the webhook secret of its key's mode (telemetry-worker/src/stripe.ts stripeWebhook)
  const SECRET_NAME = mode === "live" ? "STRIPE_WEBHOOK_SECRET" : "STRIPE_WEBHOOK_SECRET_TEST";
  // ... and its Billing Portal configuration by this id (telemetry-worker/src/stripe.ts portalConfiguration)
  const PORTAL_NAME = mode === "live" ? "STRIPE_PORTAL_CONFIGURATION" : "STRIPE_PORTAL_CONFIGURATION_TEST";
  const say = (s) => log(s);
  const would = (s) => say(`${DRY ? "would " : ""}${s}`);

  // ------------------------------------------------------------------------------------------- Stripe REST

  /** One call; `missingOk`: a 404 answers null. Retries a network error or a 5xx twice (POSTs carry an idempotency key). */
  async function stripe(method, path, params, o = {}) {
    const qs = method !== "POST" && params ? `?${form(params)}` : "";
    const headers = { authorization: `Bearer ${KEY}`, "stripe-version": API_VERSION };
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers["idempotency-key"] = crypto.randomUUID(); // a retried request is not applied twice
    }
    const body = method === "POST" ? form(params ?? {}) : undefined;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`https://api.stripe.com${path}${qs}`, { method, headers, body, signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        if (attempt < 2) continue;
        fail(`no answer from Stripe for ${method} ${path} (${e?.message ?? e})`);
      }
      const j = await res.json().catch(() => ({}));
      if (res.status >= 500 && attempt < 2) continue;
      if (res.status === 404 && o.missingOk) return null;
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

  // ------------------------------------------------------------------------------------------- read and check

  /** GenClass's product for a plan: by its id, else (an earlier run) by a search on its metadata. Null: none yet. */
  async function findProduct(plan, id) {
    const byId = await stripe("GET", `/v1/products/${id}`, undefined, { missingOk: true });
    if (byId) {
      if (byId.metadata?.genclass_plan !== plan.id) {
        fail(`a product with the id ${id} exists without metadata genclass_plan=${plan.id}, so it is not GenClass's and this script does not touch it. Nothing was changed.`);
      }
      return byId;
    }
    // the search returns only products with this metadata: nothing else in the account is read
    const found = ((await stripe("GET", "/v1/products/search", { query: `metadata['genclass_plan']:'${plan.id}'`, limit: 10 })).data ?? []).filter(
      (p) => p.metadata?.genclass_plan === plan.id,
    );
    if (found.length > 1) fail(`${found.length} products have metadata genclass_plan=${plan.id} (${found.map((p) => p.id).join(", ")}); archive all but one in the Stripe dashboard, then run this again. Nothing was changed.`);
    return found[0] ?? null;
  }

  async function readPlans() {
    const out = [];
    for (const plan of PLANS.plans.filter((p) => p.price_usd_cents.monthly > 0)) {
      const id = `genclass_${plan.id}`;
      const product = await findProduct(plan, id);
      const prices = [];
      for (const [interval, field] of [["month", "monthly"], ["year", "yearly"]]) {
        const lookup = plan.stripe_lookup_keys[field];
        const cents = plan.price_usd_cents[field];
        if (!lookup || cents === null || cents === undefined) continue;
        if (!lookup.startsWith(LOOKUP_PREFIX)) fail(`billing/plans.json: the lookup key ${lookup} must start with ${LOOKUP_PREFIX}`);
        if (!TAX_CODE_RE.test(plan.stripe_tax_code ?? "")) fail(`billing/plans.json: the ${plan.name} plan needs a Stripe product tax code (stripe_tax_code, txcd_ and 8 digits)`);
        const [price] = (await stripe("GET", "/v1/prices", { lookup_keys: [lookup], limit: 1 })).data ?? [];
        if (price && price.product !== product?.id) {
          fail(`the lookup key ${lookup} is on price ${price.id} of product ${price.product}, not on GenClass's product ${product?.id ?? id}; this script does not touch it. Nothing was changed.`);
        }
        prices.push({ interval, field, lookup, cents, price: price ?? null });
      }
      out.push({ plan, id, product, prices });
    }
    return out;
  }

  /** GenClass's webhook endpoints (exact URL and description). Stops when another endpoint uses GenClass's URL. */
  async function readWebhooks() {
    // Stripe has no search for endpoints: the list is read only to find GenClass's, and nothing else is used or shown
    const sameUrl = (await listAll("/v1/webhook_endpoints")).filter((w) => w.url === WEBHOOK_URL);
    const strangers = sameUrl.filter((w) => w.description !== WEBHOOK_DESCRIPTION);
    if (strangers.length) {
      const old = strangers.some((w) => w.metadata?.genclass) ? " (it looks like one an earlier version of this script made)" : "";
      fail(
        `webhook endpoint ${strangers.map((w) => w.id).join(", ")} also points at ${WEBHOOK_URL} but is not described "${WEBHOOK_DESCRIPTION}"${old}, ` +
          "so this script neither changes nor deletes it, and a second endpoint for the same URL would deliver every event twice. " +
          "Delete it in the Stripe dashboard (Developers, Webhooks) if it is GenClass's, then run this again. Nothing was changed.",
      );
    }
    return sameUrl;
  }

  async function readPortal() {
    // is_default=false: the account's default configuration is never read, let alone changed
    const mine = (await listAll("/v1/billing_portal/configurations", { is_default: false })).filter((c) => c.is_default !== true && (c.metadata?.genclass === MARK || c.metadata?.genclass === "portal"));
    return mine.find((c) => c.active) ?? mine[0] ?? null;
  }

  // ------------------------------------------------------------------------------------------- write

  async function products(state) {
    const result = {};
    for (const { plan, id, product: found, prices } of state) {
      const name = `GenClass ${plan.name}`;
      // the tax code: Managed Payments sells only products with an eligible one, and Stripe Tax reads it
      const want = { name, description: plan.summary, statement_descriptor: STATEMENT_DESCRIPTOR, tax_code: plan.stripe_tax_code };
      const taxCode = (x) => (x && typeof x === "object" ? x.id : x) ?? null;
      let product = found;
      if (!product) {
        would(`create product ${name} (${id}, statement descriptor ${STATEMENT_DESCRIPTOR}, tax code ${plan.stripe_tax_code})`);
        product = DRY ? { id, planned: true } : await stripe("POST", "/v1/products", { id, ...want, metadata: { genclass: MARK, genclass_plan: plan.id } });
      } else if (
        product.name !== name ||
        product.description !== plan.summary ||
        product.statement_descriptor !== STATEMENT_DESCRIPTOR ||
        taxCode(product.tax_code) !== plan.stripe_tax_code ||
        product.active === false ||
        product.metadata?.genclass !== MARK
      ) {
        would(`update product ${name} (${product.id}, tax code ${plan.stripe_tax_code})`);
        if (!DRY) product = await stripe("POST", `/v1/products/${product.id}`, { ...want, active: true, metadata: { genclass: MARK } });
      } else say(`product ${name}: ${product.id}, unchanged`);
      result[plan.id] = { product: product.id, planned: !!product.planned, prices: [] };
      for (const { interval, field, lookup, cents, price } of prices) {
        const same = price && price.active && price.unit_amount === cents && price.currency === PLANS.currency && price.recurring?.interval === interval;
        if (same) {
          say(`price ${lookup}: ${price.id}, US$${cents / 100} per ${interval}, unchanged`);
          result[plan.id].prices.push(price.id);
          continue;
        }
        if (price) {
          // first, so the lookup key is free; its subscribers stay on it, and the genclass_ key keeps their plan
          const retired = `${lookup}_retired_${price.id}`;
          would(`retire price ${price.id}: archived, lookup key ${retired} (its subscribers stay on it, and on ${plan.name}, until moved)`);
          if (!DRY) await stripe("POST", `/v1/prices/${price.id}`, { lookup_key: retired, active: false });
        }
        would(`create price ${lookup}: US$${cents / 100} per ${interval}`);
        if (DRY) continue;
        const created = await stripe("POST", "/v1/prices", {
          product: product.id,
          unit_amount: cents,
          currency: PLANS.currency,
          recurring: { interval },
          lookup_key: lookup,
          nickname: `${plan.name} ${field}`,
          metadata: { genclass: MARK, genclass_plan: plan.id },
        });
        result[plan.id].prices.push(created.id);
      }
    }
    return result;
  }

  async function webhook(mine) {
    const current = mine[0];
    if (current && !NEW_WEBHOOK) {
      const missing = EVENTS.filter((e) => !current.enabled_events?.includes(e));
      const extra = (current.enabled_events ?? []).filter((e) => !EVENTS.includes(e));
      if (missing.length || extra.length || current.status !== "enabled") {
        would(`update GenClass's webhook endpoint ${current.id}: events ${EVENTS.join(", ")}`);
        if (!DRY) await stripe("POST", `/v1/webhook_endpoints/${current.id}`, { enabled_events: EVENTS, disabled: false });
      } else say(`webhook endpoint ${current.id}: unchanged`);
      if (mine.length > 1) say(`  note: ${mine.length} endpoints are GenClass's (${mine.map((w) => w.id).join(", ")}); run again with --new-webhook to keep one`);
      if (current.api_version && current.api_version !== API_VERSION) {
        say(`  note: it was made for API version ${current.api_version}, the worker uses ${API_VERSION}; run again with --new-webhook to replace it`);
      }
      say("  its signing secret is unchanged: Stripe shows a secret only when an endpoint is created.");
      say(`  If the worker has no ${SECRET_NAME} yet, run again with --new-webhook.`);
      return;
    }
    // only GenClass's own endpoints: this exact URL and description
    for (const w of mine) {
      would(`delete GenClass's webhook endpoint ${w.id}`);
      if (!DRY) await stripe("DELETE", `/v1/webhook_endpoints/${w.id}`);
    }
    would(`create webhook endpoint ${WEBHOOK_URL} ("${WEBHOOK_DESCRIPTION}", API version ${API_VERSION}, events ${EVENTS.join(", ")}) and store its signing secret as ${SECRET_NAME} with wrangler`);
    if (DRY) return;
    const created = await stripe("POST", "/v1/webhook_endpoints", {
      url: WEBHOOK_URL,
      enabled_events: EVENTS,
      api_version: API_VERSION,
      description: WEBHOOK_DESCRIPTION,
      metadata: { genclass: MARK },
    });
    say(`webhook endpoint ${created.id}: created; storing its signing secret as ${SECRET_NAME} with wrangler...`);
    const ok = await putSecret(SECRET_NAME, created.secret);
    if (!ok) fail(`wrangler did not store ${SECRET_NAME} (signed in? \`npx wrangler login\`). Run this again with --new-webhook for a new endpoint and secret.`);
    say(`${SECRET_NAME} stored on the worker.`);
  }

  async function portal(existing) {
    const params = {
      business_profile: { headline: PORTAL_HEADLINE, privacy_policy_url: `${SITE}/privacy`, terms_of_service_url: `${SITE}/terms` },
      default_return_url: `${SITE}/account/billing`,
      features: {
        // the GenClass customer's own email (receipts) and tax id; never an address, which GenClass does not need
        customer_update: { enabled: true, allowed_updates: ["email", "tax_id"] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: {
          enabled: true,
          mode: "at_period_end",
          cancellation_reason: { enabled: true, options: ["too_expensive", "missing_features", "switched_service", "unused", "other"] },
        },
        // no plan switch here: a Managed Payments subscription cannot take another plan's price, and must not move
        // onto a subscription outside Managed Payments; the billing page switches with a new Checkout
        subscription_update: { enabled: false },
      },
      metadata: { genclass: MARK },
    };
    let id = existing?.id;
    if (existing) {
      would(`update GenClass's Billing Portal configuration ${existing.id}`);
      if (!DRY) await stripe("POST", `/v1/billing_portal/configurations/${existing.id}`, { ...params, active: true });
    } else {
      would("create GenClass's Billing Portal configuration (metadata genclass=1, not the default)");
      if (!DRY) id = (await stripe("POST", "/v1/billing_portal/configurations", params)).id;
    }
    would(`store its id as ${PORTAL_NAME} with wrangler (the worker opens the portal on that configuration only)`);
    if (DRY) return;
    if (typeof id !== "string" || !/^bpc_[A-Za-z0-9]+$/.test(id)) fail("Stripe did not return the Billing Portal configuration's id");
    // an id, not a secret: printed so it can be set by hand if wrangler fails
    const ok = await putSecret(PORTAL_NAME, id);
    if (!ok) fail(`wrangler did not store ${PORTAL_NAME} (signed in? \`npx wrangler login\`). Set it from telemetry-worker/: echo ${id} | npx --yes wrangler@4 secret put ${PORTAL_NAME}`);
    say(`${PORTAL_NAME} (${id}) stored on the worker.`);
  }

  // ------------------------------------------------------------------------------------------- run

  say(`Stripe ${mode} mode${DRY ? ", dry run (nothing is changed)" : ""}. API version ${API_VERSION}. Only GenClass's own objects are read or changed.`);
  const state = await readPlans();
  const endpoints = (await readWebhooks()).filter((w) => w.description === WEBHOOK_DESCRIPTION);
  const existingPortal = await readPortal();
  await products(state);
  await webhook(endpoints);
  await portal(existingPortal);
  const dashboard = `
Dashboard steps for GenClass's Stripe account, in this mode, before the worker gets its key (the reasons are in
telemetry-worker/README.md, "Paid plans"):
a. Billing, Revenue recovery: Smart Retries on, failed-payment emails on, and when all retries for a payment fail,
   cancel the subscription. The worker also ends a plan that stays past due for 14 days, or goes unpaid.
b. Settings, Customer emails: receipts for successful payments on.
c. Settings, Branding: icon, logo and colours (Checkout, the customer portal, receipts and invoices).
d. Stripe Tax: the head office address, and threshold monitoring on (no plan is sold through Managed Payments, so
   every sale counts towards GenClass's own registration thresholds).`;
  // before the worker's first key: rows written for an earlier account must not name a Stripe object
  const clean = `npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "SELECT COUNT(*) AS n FROM accounts WHERE stripe_customer_id IS NOT NULL OR subscription_id IS NOT NULL"`;
  say(
    mode === "test"
      ? `
Done in test mode. Next (from telemetry-worker/; the full list is in telemetry-worker/README.md, "Owner steps"):
1. If not done yet: the migrations, the export lifecycle rule, INTEGRATIONS_KEY, NOTIFY_WEBHOOK and a deploy. Before
   the worker's first Stripe key, this must print n = 0 (nothing was ever on sale; if not, see the README):
     ${clean}
2. If not done yet (the README lists them before this script): the dashboard steps below (a to d), in test mode.
3. Only the accounts you list can buy while the key is a test key (your email or account id, comma-separated):
     npx --yes wrangler@4 secret put STRIPE_TEST_ACCOUNTS
4. The test key (paste it when asked). Nothing changes for anyone else: no limits, no buttons.
     npx --yes wrangler@4 secret put STRIPE_SECRET_KEY
5. Test: on ${SITE}/account/billing choose Upgrade to Individual and pay with card 4242 4242 4242 4242, any future
   date and any CVC. Check in Developers, Logs that Stripe accepted the Checkout Session with billing_mode flexible.
   The page shows Individual within a minute, and a custom_requests row and test-mode notices appear. Then Manage
   billing, and cancel.
6. Then live: the reset in the README, this script with STRIPE_SECRET_KEY=sk_live_..., and step 4 with the live key.
${dashboard}`
      : `
Done in live mode. Next (from telemetry-worker/; the full list is in telemetry-worker/README.md, "Owner steps"):
1. If you tested in test mode on this worker, clear the test records first (they no longer count once the key is
   live, but this keeps the tables clean):
     npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "UPDATE accounts SET plan = 'free', stripe_customer_id = NULL, subscription_id = NULL, subscription_status = NULL, past_due_since = NULL, current_period_end = NULL, cancel_at_period_end = 0, stripe_mode = NULL WHERE stripe_mode = 'test'; DELETE FROM custom_requests WHERE mode = 'test';"
   With no test pass before, this must print n = 0 instead: ${clean}
2. If not done yet: the dashboard steps below (a to d), live this time.
3. Put Individual on sale (paste the live key when asked).
     npx --yes wrangler@4 secret put STRIPE_SECRET_KEY
4. Check ${SITE}/account/billing while signed in.
${dashboard}`,
  );
}

const invoked = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  main().catch((e) => {
    console.error(`stripe-setup: ${e instanceof SetupError ? e.message : (e?.stack ?? e)}`);
    process.exit(1);
  });
}

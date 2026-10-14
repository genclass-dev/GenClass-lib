// Plans and what they allow: limits (apps, dashboard history), entitlements (forwarding, export, analytics,
// custom_model), the dashboard ranges a plan shows, and the plan-aware retention sweep.
//
// - The plans live in billing/plans.json at the repo root (the site's pricing page reads the same file). Change a
//   price or a limit there, not here.
// - A plan comes from accounts.plan, which src/stripe.ts derives from the Stripe subscription. Entitlements follow the
//   plan whatever the server's configuration, except that a plan bought in Stripe's test mode counts only while the
//   key is a test key (inMode): a test purchase never carries over to live. A live plan always counts.
// - A price names a plan only when it is provably GenClass's: a lookup key starting with genclass_ AND a product whose
//   metadata genclass_plan names a paid plan (planForPrice). GenClass now has a Stripe account of its own; this rule
//   is kept from when it shared daybot.ca's account with Polar Parts, as a defence in depth.
// - A plan whose payment is overdue ends here, whatever the Stripe account's retry settings: past_due keeps the plan
//   for PAST_DUE_GRACE_DAYS (14) after GenClass first saw it past due, then it is Free (the webhook, and the daily
//   sweep below); unpaid is Free at once.
// - The Free plan's limits (3 apps, 7 days in view) apply only once paid plans are on sale to everyone (a live
//   STRIPE_SECRET_KEY): before that nobody could upgrade, so accounts keep the limits they had (200 apps, 30 days in
//   view). With a test key only the accounts in STRIPE_TEST_ACCOUNTS can buy (canBuy), and no limits change.
// - Retention never deletes data newer than the plan allows, and never shortens what existing projects had: daily
//   counters, recent rows and stored batches are kept RETENTION_DAYS (90) for every project, and longer for the apps
//   of accounts on a plan with more history (and for GRACE_DAYS after such a plan ends, so a lapsed card does not
//   cost a year of data at once).

import PLANS_JSON from "../../billing/plans.json";
import type { Env } from "./collector.js";
import { retention, RETENTION_DAYS, type D1Like, type Range } from "./dashboard.js";
import { exportSweep, type BucketOps } from "./export.js";

const DAY = 86_400_000;
export const GRACE_DAYS = 30;

export type PlanId = "free" | "pro" | "custom";
export type Entitlement = "forwarding" | "export" | "analytics" | "custom_model";

export interface Plan {
  id: PlanId;
  name: string;
  summary: string;
  price_usd_cents: { monthly: number; yearly: number | null };
  stripe_lookup_keys: { monthly: string | null; yearly: string | null };
  /** The Stripe product tax code scripts/stripe-setup.mjs sets on the plan's product (null for Free). */
  stripe_tax_code: string | null;
  /** Sold through Stripe Managed Payments (src/stripe.ts managedPayments): Pro only; Custom is a person's work. */
  managed_payments: boolean;
  limits: { apps: number | null; history_days: number };
  entitlements: Record<Entitlement, boolean>;
  features: { text: string; available: boolean }[];
}

export interface PlansFile {
  version: number;
  currency: string;
  contact: string;
  footer: string;
  plans: Plan[];
}

export const PLANS_FILE = PLANS_JSON as unknown as PlansFile;
export const PLANS: Plan[] = PLANS_FILE.plans;
export const FREE: Plan = PLANS.find((p) => p.id === "free")!;
export const PAID_PLANS: Plan[] = PLANS.filter((p) => p.price_usd_cents.monthly > 0);

export function planById(id: unknown): Plan {
  return PLANS.find((p) => p.id === id) ?? FREE;
}

/** Every GenClass lookup key starts with this: plans.json's, and those of prices scripts/stripe-setup.mjs retired. */
export const LOOKUP_PREFIX = "genclass_";

/** The plan a lookup_key from billing/plans.json sells (monthly or yearly), or null for any other key. */
export function planByLookupKey(key: unknown): Plan | null {
  if (typeof key !== "string" || !key) return null;
  return PLANS.find((p) => p.stripe_lookup_keys.monthly === key || p.stripe_lookup_keys.yearly === key) ?? null;
}

/** The paid plan named by a Stripe product's (or price's) metadata.genclass_plan (scripts/stripe-setup.mjs sets it). */
export function planByMetadata(meta: unknown): Plan | null {
  const id = meta && typeof meta === "object" ? (meta as Record<string, unknown>).genclass_plan : null;
  return PAID_PLANS.find((p) => p.id === id) ?? null;
}

/**
 * The plan a Stripe price sells, or null when the price is not provably GenClass's. The Stripe account is shared with
 * Polar Parts, so both must hold: the price's lookup_key starts with genclass_, and its product (expanded) carries
 * metadata genclass_plan naming a paid plan; the plan is the product's. A price the setup script replaced keeps its
 * product and gets a genclass_..._retired_<id> lookup key, so its subscribers keep their plan. A lookup key from
 * plans.json that names another plan than the product does is refused as inconsistent.
 */
export function planForPrice(price: unknown): Plan | null {
  if (!price || typeof price !== "object") return null;
  const p = price as Record<string, unknown>;
  if (typeof p.lookup_key !== "string" || !p.lookup_key.startsWith(LOOKUP_PREFIX)) return null;
  const product = p.product && typeof p.product === "object" ? (p.product as Record<string, unknown>) : null;
  const plan = planByMetadata(product?.metadata);
  if (!plan) return null;
  const named = planByLookupKey(p.lookup_key);
  return named && named.id !== plan.id ? null : plan;
}

export const entitled = (plan: Plan, e: Entitlement): boolean => plan.entitlements[e] === true;

export type StripeMode = "test" | "live";

/** The mode of STRIPE_SECRET_KEY (sk_ or rk_, live_ or test_), or null when it is unset or not a Stripe key. */
export function stripeMode(env: Env): StripeMode | null {
  const k = (env.STRIPE_SECRET_KEY ?? "").trim();
  return /^[sr]k_live_/.test(k) ? "live" : /^[sr]k_test_/.test(k) ? "test" : null;
}

/** Paid plans are on sale to everyone (a live key), so the Free plan's limits apply. */
export const billingLive = (env: Env): boolean => stripeMode(env) === "live";

/**
 * This account can buy a plan: any account with a live key; with a test key only the accounts listed in
 * STRIPE_TEST_ACCOUNTS (emails or account ids), so a test pass on the production worker sells nothing to anyone else.
 */
export function canBuy(env: Env, account: { id: string; email: string | null }): boolean {
  const mode = stripeMode(env);
  if (mode === "live") return true;
  if (mode !== "test") return false;
  const list = (env.STRIPE_TEST_ACCOUNTS ?? "").split(/[\s,]+/).filter(Boolean);
  const email = account.email?.toLowerCase();
  return list.some((x) => x === account.id || (!!email && x.toLowerCase() === email));
}

/** "$99 / month", or "$0". */
export function priceText(plan: Plan): string {
  const c = plan.price_usd_cents.monthly;
  if (!c) return "$0";
  return `$${c % 100 ? (c / 100).toFixed(2) : String(c / 100)} / month`;
}

// --------------------------------------------------------------------------------------------- an account's plan

/** Subscription statuses that keep a paid plan (past_due: for PAST_DUE_GRACE_DAYS, while Stripe retries the card). */
export const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

/** How long a past_due subscription keeps its plan, counted from when GenClass first saw it past due. */
export const PAST_DUE_GRACE_DAYS = 14;

/** A past_due subscription seen past due since `since` (ISO) has used up its grace at `now`. */
export const pastDueLapsed = (since: string | null | undefined, now: Date): boolean => {
  const t = since ? Date.parse(since) : NaN;
  return Number.isFinite(t) && now.getTime() - t > PAST_DUE_GRACE_DAYS * DAY;
};

export interface Billing {
  plan: string;
  stripe_customer_id: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  /** The Stripe mode the ids belong to ('test' or 'live'), null when there are none. */
  stripe_mode: string | null;
}

const NO_BILLING: Billing = { plan: "free", stripe_customer_id: null, subscription_id: null, subscription_status: null, current_period_end: null, cancel_at_period_end: 0, stripe_mode: null };

/** The SQL test for "this account's plan counts under the current key" (`?` binds the key's mode, or ''). */
export const MODE_OK_SQL = "(a.stripe_mode IS NULL OR a.stripe_mode <> 'test' OR ? = 'test')";

/** A plan recorded in this Stripe mode counts under a key of `mode`: test-mode records only under a test key. */
export const modeCounts = (recorded: string | null | undefined, mode: StripeMode | null): boolean => recorded !== "test" || mode === "test";

/**
 * The billing as the current Stripe key sees it: ids and a plan bought in test mode count as none unless the key is a
 * test key (a test purchase after the key went live). Live records always count, so changing or removing the key
 * never downgrades someone Stripe still charges.
 */
export function inMode(b: Billing, env: Env): Billing {
  return modeCounts(b.stripe_mode, stripeMode(env)) ? b : NO_BILLING;
}

/** The account's billing row; with `env`, as the current Stripe key sees it (inMode). Without, as stored. */
export async function accountBilling(db: D1Like, accountId: string, env?: Env): Promise<Billing> {
  const row = await db
    .prepare("SELECT plan, stripe_customer_id, subscription_id, subscription_status, current_period_end, cancel_at_period_end, stripe_mode FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<Billing>();
  if (!row) return NO_BILLING;
  return env ? inMode(row, env) : row;
}

export async function accountPlan(db: D1Like, accountId: string, env?: Env): Promise<Plan> {
  return planById((await accountBilling(db, accountId, env)).plan);
}

// --------------------------------------------------------------------------------------------- apps

export interface AppLimit {
  plan: Plan;
  /** The most apps this account may hold under its plan, or null when the plan sets no limit. */
  max: number | null;
}

/** The plan's app limit (null: none; the caller's abuse cap still applies). */
export async function appLimit(db: D1Like, env: Env, accountId: string): Promise<AppLimit> {
  const plan = await accountPlan(db, accountId, env);
  const applies = billingLive(env) || plan.id !== "free";
  return { plan, max: applies ? plan.limits.apps : null };
}

/** The 409 for an account at its plan's app limit: says the limit and where to upgrade, for the page and the CLI. */
export function appLimitBody(lim: AppLimit, origin: string): { ok: false; error: string; upgrade_url: string } {
  const url = `${origin}/account/billing`;
  return {
    ok: false,
    error: `the ${lim.plan.name} plan holds ${lim.max} app${lim.max === 1 ? "" : "s"}; upgrade to Pro for more apps at ${url}`,
    upgrade_url: url,
  };
}

// --------------------------------------------------------------------------------------------- dashboard history

/** Dashboard ranges an owned app can show, shortest first, with the days each one reaches back. */
export const ACCOUNT_RANGES: Range[] = ["24h", "7d", "30d", "90d", "1y"];
export const RANGE_DAYS: Record<Range, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 };
/** What an account's dashboard showed before plans: 24 h, 7 and 30 days. */
const LEGACY_RANGES: Range[] = ["24h", "7d", "30d"];

/** The ranges this plan's dashboard shows. */
export function viewRanges(env: Env, plan: Plan): Range[] {
  if (plan.id === "free" && !billingLive(env)) return LEGACY_RANGES;
  const out = ACCOUNT_RANGES.filter((r) => RANGE_DAYS[r] <= plan.limits.history_days);
  return out.length ? out : ["24h"];
}

/** The range to serve for a request: the one asked for when the plan shows it, else the longest it shows up to 7 days. */
export function pickRange(asked: string | null, allowed: Range[]): Range {
  if (asked && (allowed as string[]).includes(asked)) return asked as Range;
  const days = asked && asked in RANGE_DAYS ? RANGE_DAYS[asked as Range] : 7;
  const fit = allowed.filter((r) => RANGE_DAYS[r] <= days);
  return fit.length ? fit[fit.length - 1]! : allowed[0]!;
}

/** How long this plan keeps an app's data, in days (never less than what every project had before plans). */
export const keepDays = (plan: Plan): number => Math.max(RETENTION_DAYS, plan.limits.history_days);

// --------------------------------------------------------------------------------------------- retention

/**
 * The apps kept longer than RETENTION_DAYS: those of accounts on a plan with more history, and of accounts whose paid
 * period ended less than GRACE_DAYS ago. `days` is the longest such plan's history. With `mode` (the current key's,
 * null without one), a plan bought in test mode counts only under a test key.
 */
export function longRetention(now: Date, mode?: StripeMode | null): { tokens: string; params: unknown[]; days: number } | undefined {
  const long = PLANS.filter((p) => p.limits.history_days > RETENTION_DAYS);
  if (!long.length) return undefined;
  const grace = new Date(now.getTime() - GRACE_DAYS * DAY).toISOString();
  return {
    tokens:
      "SELECT p.token FROM projects p JOIN accounts a ON a.id = p.account_id WHERE " +
      `(a.plan IN (${long.map(() => "?").join(", ")}) OR (a.subscription_id IS NOT NULL AND a.current_period_end > ?))` +
      (mode !== undefined ? ` AND ${MODE_OK_SQL}` : ""),
    params: [...long.map((p) => p.id), grace, ...(mode !== undefined ? [mode ?? ""] : [])],
    days: Math.max(...long.map((p) => p.limits.history_days)),
  };
}

/**
 * Plans whose payment is overdue end, whatever the Stripe account's retry settings (the owner sets them to cancel the
 * subscription once every retry failed; this is the backstop): an unpaid subscription, or one past_due for more than
 * PAST_DUE_GRACE_DAYS, leaves its account on Free. The webhook does the same when an event arrives; this catches the
 * accounts no event arrives for.
 */
export async function endOverduePlans(db: D1Like, now: Date): Promise<void> {
  await db
    .prepare("UPDATE accounts SET plan = 'free' WHERE plan <> 'free' AND (subscription_status = 'unpaid' OR (subscription_status = 'past_due' AND past_due_since < ?))")
    .bind(new Date(now.getTime() - PAST_DUE_GRACE_DAYS * DAY).toISOString())
    .run();
}

/**
 * The daily sweep (index.ts): dashboard rows by plan, stored-batch index and export copies by plan, forwarding
 * dedupe rows older than 2 hours, handled Stripe event ids older than 30 days, then overdue plans end
 * (endOverduePlans; an ended plan's data keeps its GRACE_DAYS either way).
 */
export async function planRetention(db: D1Like, now: Date, bucket?: BucketOps, mode?: StripeMode | null): Promise<void> {
  const long = longRetention(now, mode);
  await retention(db, now, long);
  // one after the other (each D1 batch is a transaction); a failure in one does not stop the next
  await exportSweep(db, bucket, now, long).catch(() => undefined);
  await db
    .batch([
      db.prepare("DELETE FROM forward_log WHERE hour < ?").bind(new Date(now.getTime() - 2 * 3_600_000).toISOString().slice(0, 13)),
      db.prepare("DELETE FROM billing_events WHERE received < ?").bind(new Date(now.getTime() - 30 * DAY).toISOString()),
    ])
    .catch(() => undefined);
  await endOverduePlans(db, now).catch(() => undefined);
}

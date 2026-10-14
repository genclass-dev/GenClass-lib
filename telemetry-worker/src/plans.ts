// Plans and what they allow: limits (apps, dashboard history), entitlements (forwarding, export, analytics,
// custom_model), the dashboard ranges a plan shows, and the plan-aware retention sweep.
//
// - The plans live in billing/plans.json at the repo root (the site's pricing page reads the same file). Change a
//   price or a limit there, not here.
// - A plan comes from accounts.plan, which src/stripe.ts derives from the Stripe subscription. Entitlements follow the
//   plan whatever the server's configuration.
// - The Free plan's limits (3 apps, 7 days in view) apply only once paid plans are on sale (STRIPE_SECRET_KEY is
//   set): before that nobody could upgrade, so accounts keep the limits they had (200 apps, 30 days in view).
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

/** The plan a Stripe price lookup_key sells (monthly or yearly), or null for a price GenClass does not know. */
export function planByLookupKey(key: unknown): Plan | null {
  if (typeof key !== "string" || !key) return null;
  return PLANS.find((p) => p.stripe_lookup_keys.monthly === key || p.stripe_lookup_keys.yearly === key) ?? null;
}

export const entitled = (plan: Plan, e: Entitlement): boolean => plan.entitlements[e] === true;

/** Paid plans are on sale: the Stripe secret key is set. */
export const billingLive = (env: Env): boolean => !!env.STRIPE_SECRET_KEY;

/** "$99 / month", or "$0". */
export function priceText(plan: Plan): string {
  const c = plan.price_usd_cents.monthly;
  if (!c) return "$0";
  return `$${c % 100 ? (c / 100).toFixed(2) : String(c / 100)} / month`;
}

// --------------------------------------------------------------------------------------------- an account's plan

/** Subscription statuses that keep a paid plan (past_due: while Stripe retries the card). */
export const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export interface Billing {
  plan: string;
  stripe_customer_id: string | null;
  subscription_id: string | null;
  subscription_status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
}

const NO_BILLING: Billing = { plan: "free", stripe_customer_id: null, subscription_id: null, subscription_status: null, current_period_end: null, cancel_at_period_end: 0 };

export async function accountBilling(db: D1Like, accountId: string): Promise<Billing> {
  const row = await db
    .prepare("SELECT plan, stripe_customer_id, subscription_id, subscription_status, current_period_end, cancel_at_period_end FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<Billing>();
  return row ?? NO_BILLING;
}

export async function accountPlan(db: D1Like, accountId: string): Promise<Plan> {
  return planById((await accountBilling(db, accountId)).plan);
}

// --------------------------------------------------------------------------------------------- apps

export interface AppLimit {
  plan: Plan;
  /** The most apps this account may hold under its plan, or null when the plan sets no limit. */
  max: number | null;
}

/** The plan's app limit (null: none; the caller's abuse cap still applies). */
export async function appLimit(db: D1Like, env: Env, accountId: string): Promise<AppLimit> {
  const plan = await accountPlan(db, accountId);
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
 * period ended less than GRACE_DAYS ago. `days` is the longest such plan's history.
 */
export function longRetention(now: Date): { tokens: string; params: unknown[]; days: number } | undefined {
  const long = PLANS.filter((p) => p.limits.history_days > RETENTION_DAYS);
  if (!long.length) return undefined;
  const grace = new Date(now.getTime() - GRACE_DAYS * DAY).toISOString();
  return {
    tokens:
      "SELECT p.token FROM projects p JOIN accounts a ON a.id = p.account_id WHERE " +
      `a.plan IN (${long.map(() => "?").join(", ")}) OR (a.subscription_id IS NOT NULL AND a.current_period_end > ?)`,
    params: [...long.map((p) => p.id), grace],
    days: Math.max(...long.map((p) => p.limits.history_days)),
  };
}

/**
 * The daily sweep (index.ts): dashboard rows by plan, stored-batch index and export copies by plan, forwarding
 * dedupe rows older than 2 hours, handled Stripe event ids older than 30 days.
 */
export async function planRetention(db: D1Like, now: Date, bucket?: BucketOps): Promise<void> {
  const long = longRetention(now);
  await retention(db, now, long);
  await Promise.allSettled([
    exportSweep(db, bucket, now, long),
    db.batch([
      db.prepare("DELETE FROM forward_log WHERE hour < ?").bind(new Date(now.getTime() - 2 * 3_600_000).toISOString().slice(0, 13)),
      db.prepare("DELETE FROM billing_events WHERE received < ?").bind(new Date(now.getTime() - 30 * DAY).toISOString()),
    ]),
  ]);
}

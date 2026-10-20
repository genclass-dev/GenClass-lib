// Trials of Individual (TRIAL_PLAN, src/plans.ts: the hosted closed-loop MCP). An account without a paid plan or
// GenClass's own grant gets one trial, without a card and without Stripe, of TRIAL_DAYS days (wrangler.toml; the
// billing page says the number from it). The dashboard is free and needs no trial: a trial only adds what Individual
// sells, so it is refused while Individual is not on sale (billing/plans.json on_sale: until the hosted MCP ships).
//
//   POST /api/billing/trial   browser session + Origin: start the account's one trial (409 while Individual is not on
//                             sale, once the trial was used, or while a paid plan or a grant applies). Individual's
//                             entitlements until trial_ends_at (src/plans.ts accessOf).
//   GET  /account/trial       the pricing page's Start a trial: /account?trial=1 (its Start a trial button focused,
//                             when one is shown), through sign-up when signed out. A GET never starts a trial.
//
// Invariants: one trial per account (trial_started_at is set once, in a conditional UPDATE, and never cleared); a CLI
// session cannot start one; nothing here reads or stores a dashboard secret.

import { authenticate, csrfFail, fail, originOk, readJson, redirect, webSession, type C } from "./auth.js";
import { json } from "./http.js";
import { forgetOwner } from "./paid.js";
import { accountAccess, onSale, TRIAL_PLAN, trialDays } from "./plans.js";

const DAY = 86_400_000;

/** The 409 for a trial while TRIAL_PLAN is not on sale (billing/plans.json on_sale false). */
export const notOnSale = (): Response => fail(409, `${TRIAL_PLAN.name} is not on sale yet`);

/** POST /api/billing/trial: start the signed-in account's one trial of TRIAL_PLAN (Individual). */
export async function startTrial(c: C): Promise<Response> {
  const a = await authenticate(c);
  if (!a) return fail(401, "not signed in");
  if (a.via !== "cookie") return fail(403, "a trial is started in the browser, on genclass.dev");
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c, 1024);
  if (body instanceof Response) return body;
  if (!onSale(TRIAL_PLAN)) return notOnSale();
  const access = await accountAccess(c.db, a.account.id, c.env, c.now);
  if (access.source === "paid") return fail(409, `this account already has the ${access.plan.name} plan`);
  if (access.source === "comp") return fail(409, `this account already has ${TRIAL_PLAN.name}`);
  const used = (): Response => fail(409, `this account already had its trial; see the plans at ${c.cfg.origin}/account/billing`);
  if (access.trialUsed) return used();
  const ends = new Date(c.now.getTime() + trialDays(c.env) * DAY).toISOString();
  const row = await c.db
    .prepare("UPDATE accounts SET trial_started_at = ?, trial_ends_at = ? WHERE id = ? AND trial_started_at IS NULL RETURNING trial_ends_at")
    .bind(c.now.toISOString(), ends, a.account.id)
    .first<{ trial_ends_at: string }>();
  if (!row) return used(); // started in another tab at the same moment
  // the collector caches each app's plan for a minute (src/paid.ts): forget this account's apps, so the plan's
  // entitlements apply from the next batch
  const apps = await c.db.prepare("SELECT token FROM projects WHERE account_id = ?").bind(a.account.id).all<{ token: string }>();
  for (const p of apps.results ?? []) forgetOwner(p.token);
  return json(200, { ok: true, trial: { started: c.now.toISOString(), ends: row.trial_ends_at } });
}

/** GET /account/trial: to the account page with its Start a trial button, through sign-up when signed out. */
export async function trialEntry(c: C): Promise<Response> {
  const next = "/account?trial=1";
  return redirect((await webSession(c)) ? next : `/signup?next=${encodeURIComponent(next)}`);
}

// Trials of Pro and the locked private link. Dashboards come with Pro: an account without a paid plan or GenClass's own
// grant gets one trial, without a card and without Stripe, of TRIAL_DAYS days (wrangler.toml; the pages say "Get a
// 7-day free trial for analytics" from it).
//
//   POST /api/billing/trial   browser session + Origin: start the account's one trial (409 once it was used, or while
//                             a paid plan or a grant applies). Pro's entitlements until trial_ends_at (src/plans.ts).
//   GET  /account/trial       the pricing page's Start a trial: /account?trial=1 (its Start a trial button focused),
//                             through sign-up when signed out. A GET never starts a trial.
//   lockedLink()              /dashboard/<secret> of an app without Pro (src/collector.ts): sign in, add the app to the
//                             account, start the trial (account-pages.ts lockedLinkPage).
//
// Invariants: one trial per account (trial_started_at is set once, in a conditional UPDATE, and never cleared); a CLI
// session cannot start one; the dashboard secret is never stored or sent anywhere new (the locked page keeps it in its
// own tab's sessionStorage for the way back from signing in).

import { accountContext, authenticate, csrfFail, fail, originOk, readJson, redirect, webSession, type C } from "./auth.js";
import { lockedLinkPage } from "./account-pages.js";
import type { Env, HandleOptions } from "./collector.js";
import { randomBase62, type Project } from "./dashboard.js";
import { json } from "./http.js";
import { forgetOwner } from "./paid.js";
import { securityHeaders } from "./pages.js";
import { accountAccess, hasDashboard, trialDays } from "./plans.js";

const DAY = 86_400_000;

/** POST /api/billing/trial: start the signed-in account's one trial of Pro. */
export async function startTrial(c: C): Promise<Response> {
  const a = await authenticate(c);
  if (!a) return fail(401, "not signed in");
  if (a.via !== "cookie") return fail(403, "a trial is started in the browser, on genclass.dev");
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c, 1024);
  if (body instanceof Response) return body;
  const access = await accountAccess(c.db, a.account.id, c.env, c.now);
  if (access.source === "paid") return fail(409, `this account already has the ${access.plan.name} plan`);
  if (access.source === "comp") return fail(409, "this account already has Pro");
  const used = (): Response => fail(409, `this account already had its trial; see the plans at ${c.cfg.origin}/account/billing`);
  if (access.trialUsed) return used();
  const ends = new Date(c.now.getTime() + trialDays(c.env) * DAY).toISOString();
  const row = await c.db
    .prepare("UPDATE accounts SET trial_started_at = ?, trial_ends_at = ? WHERE id = ? AND trial_started_at IS NULL RETURNING trial_ends_at")
    .bind(c.now.toISOString(), ends, a.account.id)
    .first<{ trial_ends_at: string }>();
  if (!row) return used(); // started in another tab at the same moment
  // the collector caches each app's plan for a minute (src/paid.ts): forget this account's apps, so export and
  // forwarding start with the next batch
  const apps = await c.db.prepare("SELECT token FROM projects WHERE account_id = ?").bind(a.account.id).all<{ token: string }>();
  for (const p of apps.results ?? []) forgetOwner(p.token);
  return json(200, { ok: true, trial: { started: c.now.toISOString(), ends: row.trial_ends_at } });
}

/** GET /account/trial: to the account page with its Start a trial button, through sign-up when signed out. */
export async function trialEntry(c: C): Promise<Response> {
  const next = "/account?trial=1";
  return redirect((await webSession(c)) ? next : `/signup?next=${encodeURIComponent(next)}`);
}

/** /dashboard/<secret> for an app whose dashboard is locked: the way to Pro for whoever holds the link. */
export async function lockedLink(request: Request, url: URL, env: Env, opts: HandleOptions, p: Project): Promise<Response> {
  const c = accountContext(request, url, env, opts);
  const nonce = randomBase62(22);
  const providers = { google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) };
  let signedIn: { pro: boolean; canTrial: boolean } | null = null;
  let owner: "none" | "mine" | "other" = p.account_id ? "other" : "none";
  const a = c ? await webSession(c) : null;
  if (c && a) {
    const access = await accountAccess(c.db, a.account.id, env, c.now);
    signedIn = { pro: hasDashboard(access), canTrial: access.source === null && !access.trialUsed };
    if (p.account_id === a.account.id) owner = "mine";
  }
  const html = lockedLinkPage(nonce, { name: p.name, signedIn, owner, providers, trialDays: trialDays(env) });
  return new Response(html, { status: 200, headers: securityHeaders(nonce) });
}

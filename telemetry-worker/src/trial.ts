// Trials of Pro and the locked private link. Dashboards come with Pro: an account without a paid plan or GenClass's own
// grant gets one trial of TRIAL_DAYS days (wrangler.toml; the pages say "Get a 7-day free trial for analytics" from
// it), and only with a card: the trial is a Pro subscription that starts on Stripe Checkout, which collects the card up
// front and charges it when the trial ends (src/billing.ts checkout, src/stripe.ts checkoutSession). Nothing here
// grants Pro.
//
//   POST /api/billing/trial   (src/billing.ts) browser session + Origin: {url} of the trial's Stripe Checkout.
//   GET  /account/trial       the pricing page's Start a trial: /account?trial=1 (its Start a trial button focused),
//                             through sign-up when signed out. A GET never opens Stripe or starts anything.
//   lockedLink()              /dashboard/<secret> of an app without Pro (src/collector.ts): sign in, add the app to the
//                             account, go to the trial's Checkout (account-pages.ts lockedLinkPage).
//
// Invariants: one trial per account (src/plans.ts canTrial: accounts.trial_started_at, set once by the webhook, and no
// GenClass subscription before); a CLI session cannot start one; the dashboard secret is never stored or sent anywhere
// new (the locked page keeps it in its own tab's sessionStorage for the way back from signing in).

import { accountContext, redirect, webSession, type C } from "./auth.js";
import { lockedLinkPage } from "./account-pages.js";
import type { Env, HandleOptions } from "./collector.js";
import { randomBase62, type Project } from "./dashboard.js";
import { securityHeaders } from "./pages.js";
import { accountAccess, canTrial, hasDashboard, trialDays } from "./plans.js";

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
  let signedIn: { pro: boolean; canTrial: boolean; trialUsed: boolean } | null = null;
  let owner: "none" | "mine" | "other" = p.account_id ? "other" : "none";
  const a = c ? await webSession(c) : null;
  if (c && a) {
    const access = await accountAccess(c.db, a.account.id, env, c.now);
    signedIn = { pro: hasDashboard(access), canTrial: canTrial(access, env, a.account), trialUsed: access.trialUsed };
    if (p.account_id === a.account.id) owner = "mine";
  }
  const html = lockedLinkPage(nonce, { name: p.name, signedIn, owner, providers, trialDays: trialDays(env) });
  return new Response(html, { status: 200, headers: securityHeaders(nonce) });
}

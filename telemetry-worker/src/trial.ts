// Trials of Pro. Analytics are free on every plan (src/plans.ts); Pro adds a year of history, export and forwarding.
// An account without a paid plan or GenClass's own grant gets one trial of TRIAL_DAYS days (wrangler.toml; the pages
// say "Start your 7-day free trial" from it), and only with a card: the trial is a Pro subscription that starts on
// Stripe Checkout, which collects the card up front and charges it when the trial ends (src/billing.ts checkout,
// src/stripe.ts checkoutSession). Nothing here grants Pro.
//
//   POST /api/billing/trial   (src/billing.ts) browser session + Origin: {url} of the trial's Stripe Checkout.
//   GET  /account/trial       the pricing page's Start a trial: /account/billing?trial=1 (its Start your trial button
//                             focused), through sign-up when signed out. A GET never opens Stripe or starts anything.
//
// Invariants: one trial per account (src/plans.ts canTrial: accounts.trial_started_at, set once by the webhook, and no
// GenClass subscription before); a CLI session cannot start one.

import { redirect, webSession, type C } from "./auth.js";

/** GET /account/trial: to the billing page with its Start your trial button, through sign-up when signed out. */
export async function trialEntry(c: C): Promise<Response> {
  const next = "/account/billing?trial=1";
  return redirect((await webSession(c)) ? next : `/signup?next=${encodeURIComponent(next)}`);
}

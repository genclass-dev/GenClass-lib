// The locked private link: /dashboard/<secret> of an app whose plan leaves the dashboard out. No plan in
// billing/plans.json does today (every plan includes the dashboard, Free too), so this answers only for a plan file
// that changes that; the tests run it on a fixture (test/fixtures/plans-two-paid.json). GenClass has no trial.
//
//   lockedLink()   /dashboard/<secret> (src/collector.ts): sign in, add the app to the account, see the plans
//                  (account-pages.ts lockedLinkPage).
//
// Invariants: the dashboard secret is never stored or sent anywhere new (the locked page keeps it in its own tab's
// sessionStorage for the way back from signing in).

import { accountContext, webSession } from "./auth.js";
import { lockedLinkPage } from "./account-pages.js";
import type { Env, HandleOptions } from "./collector.js";
import { randomBase62, type Project } from "./dashboard.js";
import { securityHeaders } from "./pages.js";
import { accountAccess, hasDashboard } from "./plans.js";

/** /dashboard/<secret> for an app whose dashboard is locked: the way to the plans for whoever holds the link. */
export async function lockedLink(request: Request, url: URL, env: Env, opts: HandleOptions, p: Project): Promise<Response> {
  const c = accountContext(request, url, env, opts);
  const nonce = randomBase62(22);
  const providers = { google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) };
  let signedIn: { open: boolean } | null = null;
  let owner: "none" | "mine" | "other" = p.account_id ? "other" : "none";
  const a = c ? await webSession(c) : null;
  if (c && a) {
    signedIn = { open: hasDashboard(await accountAccess(c.db, a.account.id, env, c.now)) };
    if (p.account_id === a.account.id) owner = "mine";
  }
  const html = lockedLinkPage(nonce, { name: p.name, signedIn, owner, providers });
  return new Response(html, { status: 200, headers: securityHeaders(nonce) });
}

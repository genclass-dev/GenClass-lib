// HTML for the paid plans: /account/billing (the plan, its renewal or end, the plans side by side, Upgrade, Switch and
// Manage billing buttons) and the plan-dependent sections of an owned app's dashboard (forwarding and export, and the
// note on the time ranges). A switch between Pro and Custom is a new Checkout (src/billing.ts checkout); back from it
// the page waits for the new plan. Same shell, tokens and rules as the account pages; server-rendered text goes through esc(),
// scripts insert text with textContent. Buttons that need Stripe are shown only to an account that can buy (a live
// STRIPE_SECRET_KEY, or a test key and the account in STRIPE_TEST_ACCOUNTS). Start a trial opens Stripe Checkout too
// (a card is required, checked by Stripe with a $1 hold released at once, first charged when the trial ends; the terms
// are said next to it): it shows to an account that may have one (src/plans.ts canTrial). A trial whose card failed
// that check is said here, with the way to try another card. The trial's days left are said only inside the
// dashboard, never here.

import { ACCOUNT_CSS, CLIENT_JS, time } from "./account-pages.js";
import type { Env } from "./collector.js";
import type { D1Like, Project, Range } from "./dashboard.js";
import { integrationRows, integrationsKey, KIND_NAMES, KINDS, maskConfig, openConfig, DATADOG_SITES, POSTHOG_HOSTS, type Kind } from "./forward.js";
import { DASH_CSS, embed, esc, shell, SIGNED_IN_NAV } from "./pages.js";
import {
  accountPlan,
  billingLive,
  entitled,
  GRACE_DAYS,
  keepDays,
  LIVE_STATUSES,
  PAST_DUE_GRACE_DAYS,
  PLANS,
  PLANS_FILE,
  planById,
  priceText,
  trialTerms,
  viewRanges,
  type Access,
  type Billing,
  type Plan,
} from "./plans.js";

const CONTACT = PLANS_FILE.contact;
const day = (iso: string | null): string => (iso ? time(iso, "date") : "");

// --------------------------------------------------------------------------------------------- /account/billing

export interface BillingView {
  account: { id: string; email: string | null; githubLogin: string | null };
  apps: { id: string; name: string }[];
  billing: Billing;
  /** What the account may use now: its paid plan, or Pro during GenClass's grant or the trial (src/plans.ts). */
  access: Access;
  /** This account can buy (src/plans.ts canBuy). */
  live: boolean;
  /** The key is a Stripe test key: no real money moves. */
  testMode: boolean;
  /** Back from Stripe Checkout (?done=1). */
  done: boolean;
  /** The plan chosen on the pricing page (?plan=pro|custom). */
  picked: string | null;
  /** Back from a switch's Checkout (?to=pro|custom): the plan it bought. */
  switchTo?: string | null;
  /** The names of the plans sold through Stripe Managed Payments (src/stripe.ts managedPayments). */
  managedPlans?: string[];
  /** How long a trial of Pro lasts (TRIAL_DAYS, src/plans.ts trialDays): "Start your 7-day free trial". */
  trialDays: number;
  /** The account may start its trial now (src/plans.ts canTrial: on Stripe Checkout, with a card). */
  canTrial: boolean;
  /** Back from the trial's Checkout (?done=1&trial=1). */
  trialDone?: boolean;
  /** From the pricing page's Start a trial (/account/trial, ?trial=1 without done): focus the trial's button. */
  focusTrial?: boolean;
  /**
   * The $1 card check before a trial (src/stripe.ts cardCheck): how many of the account's cards failed it, when the
   * latest trial attempt's did (null: it has not, or not yet), and how many failures end the trial offer.
   */
  cardCheck?: { failures: number; failedAt: string | null; max: number };
  now: Date;
}

const BILLING_CSS = `
.plans{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px;margin-top:22px}
.plan{border-top:1px solid var(--rule2);padding-top:16px;display:flex;flex-direction:column;gap:10px;min-width:0}
.plan.cur,.plan.pick{border-top-color:var(--accent)}
.plan h3{font:500 22px/1.1 var(--display);letter-spacing:-.02em;margin:0}
.plan .price{font:500 15px var(--mono)}
.plan .sum{font-size:14.5px;color:var(--ink2);line-height:1.5}
.plan ul{list-style:none;padding:0;margin:4px 0 0;display:grid;gap:7px;font-size:14px;line-height:1.45;color:var(--ink2)}
.plan li{padding-left:16px;position:relative}
.plan li::before{content:"";position:absolute;left:0;top:.66em;width:7px;height:1.5px;background:var(--ink3)}
.plan li.soon{color:var(--ink3)}
.plan .act{margin-top:auto;padding-top:10px}
.plan .tag{font:500 12px var(--mono);color:var(--accent)}
.status{margin-top:18px;font-size:16px;line-height:1.55;max-width:70ch;color:var(--ink2)}
.status b{color:var(--ink);font-weight:500}
@media (max-width:860px){.plans{grid-template-columns:1fr}}
`;

function statusLine(v: BillingView, plan: Plan, apps: number): string {
  const b = v.billing;
  const name = `<b>${esc(plan.name)}</b>`;
  if (plan.id === "free") {
    if (v.access.source === "comp") return `You have <b>${esc(v.access.plan.name)}</b>, set up by GenClass. Questions: <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>.`;
    if (v.access.source === "trial") return `You are on a <b>${esc(v.access.plan.name)}</b> trial.${v.live ? "" : " Paid plans are not on sale yet."}`;
    const offer = v.access.trialUsed
      ? " Your trial of Pro has ended."
      : v.canTrial
        ? ` Pro adds a year of history, export and forwarding: start your ${v.trialDays}-day free trial. ${esc(trialTerms(v.trialDays))}`
        : "";
    const limits = `the dashboard and interaction analytics for every app, with 90 days of history (you have ${apps} app${apps === 1 ? "" : "s"}).${offer}`;
    const overdue = !!b.subscription_id && (b.subscription_status === "past_due" || b.subscription_status === "unpaid");
    const ended = overdue
      ? ` The last payment for your paid plan did not go through, so it has ended. Update your card in Manage billing to pay it and get the plan back, or email <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>.`
      : b.subscription_id && b.current_period_end && b.subscription_status === "canceled" && Date.parse(b.current_period_end) > v.now.getTime() - GRACE_DAYS * 86_400_000
        ? ` Your paid plan ended on ${day(b.current_period_end)}. Data older than 90 days stays for ${GRACE_DAYS} days after that, in case you come back.`
        : "";
    return `You are on the ${name} plan: ${limits}${ended}${v.live ? "" : " Paid plans are not on sale yet."}`;
  }
  if (!b.subscription_id) return `You are on the ${name} plan, set up by GenClass. Questions: <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>.`;
  if (b.subscription_status === "past_due") {
    return `You are on the ${name} plan. The last payment did not go through; Stripe tries the card again over the next days. Update it in Manage billing to keep ${esc(plan.name)}: if it is still unpaid ${PAST_DUE_GRACE_DAYS} days after the failed payment, the account moves to the Free plan.`;
  }
  if (b.cancel_at_period_end) {
    return `You are on the ${name} plan until ${day(b.current_period_end)}. It is cancelled and will not renew; you can resume it in Manage billing before then.`;
  }
  if (b.subscription_status === "trialing") {
    return `You are on the ${name} plan, in a trial until ${day(b.current_period_end)}. When it ends your card is charged for the first month (${esc(priceText(plan))}), unless you cancel before in Manage billing.`;
  }
  return `You are on the ${name} plan, ${esc(priceText(plan))}. It renews on ${day(b.current_period_end)}.`;
}

function planColumn(v: BillingView, p: Plan, current: Plan): string {
  // the column marked as the account's: its paid plan, or Pro during a grant or the trial (which can still be bought)
  const granted = v.access.source === "comp" || v.access.source === "trial";
  const cur = p.id === (granted ? v.access.plan.id : current.id);
  const subscribed = !!v.billing.subscription_id && LIVE_STATUSES.has(v.billing.subscription_status ?? "") && current.id !== "free";
  // back from Checkout (a purchase or a switch) and still waiting for Stripe's word: no buttons, so a second purchase
  // or switch cannot start
  const waiting = !!awaited(v, current);
  const pick = !(cur && v.access.source !== "trial") && v.picked === p.id && v.live && !waiting;
  // the trial: once per account, on Stripe Checkout with a card
  const trial = p.id === "pro" && v.canTrial && !waiting;
  const buy = `<button class="btn${(p.id === "custom" && !pick) || trial ? " ghost" : ""}" type="button" data-plan="${esc(p.id)}"${pick ? " data-pick" : ""}><span>${subscribed ? "Switch to" : "Upgrade to"} ${esc(p.name)}</span></button>`;
  let act = "";
  if (cur && v.access.source === "trial") act = `<span class="tag">Your trial</span>${v.live && !waiting ? ` ${buy}` : ""}`;
  else if (cur) act = `<span class="tag">${v.access.source === "comp" ? "Set up by GenClass" : "Your plan"}</span>`;
  else if (p.id === "free") act = subscribed && v.live ? '<span class="muted">To go back to Free, cancel in Manage billing.</span>' : "";
  else if (v.live && !waiting) act = buy;
  if (trial) act = `<button class="btn green" type="button" id="trial"><span>Start your ${v.trialDays}-day free trial</span></button>${act ? ` ${act}` : ""}`;
  const features = p.features
    .map((f) => `<li${f.available ? "" : ' class="soon"'}>${esc(f.text)}${f.available || /coming next/i.test(f.text) ? "" : " (coming next)"}</li>`)
    .join("");
  return `<div class="plan${cur ? " cur" : pick ? " pick" : ""}"><h3>${esc(p.name)}</h3><p class="price">${esc(priceText(p))}</p><p class="sum">${esc(p.summary)}</p><ul>${features}</ul><div class="act">${act}</div></div>`;
}

/** Back from Checkout and the plan bought is not on the account yet: that plan ("paid": any paid plan), else null. */
function awaited(v: BillingView, current: Plan): string | null {
  if (!v.done) return null;
  // the trial's card failed the $1 check: nothing more is coming from Stripe
  if (v.trialDone && declined(v, current)) return null;
  if (v.switchTo && v.switchTo !== current.id) return v.switchTo;
  return current.id === "free" ? "paid" : null;
}

/** The latest trial attempt's card failed the $1 check, and the account has no plan, grant or trial since. */
const declined = (v: BillingView, current: Plan): boolean => !!v.cardCheck?.failedAt && current.id === "free" && v.access.source === null;

export function billingPage(nonce: string, v: BillingView): string {
  const plan = planById(v.billing.plan);
  const want = awaited(v, plan);
  const a = v.account;
  const who = a.email ? esc(a.email) : a.githubLogin ? `@${esc(a.githubLogin)} on GitHub` : "No email";
  const appsNav = v.apps.map((p) => `<a href="/account/apps/${esc(p.id)}">${esc(p.name)}</a>`).join("");
  const manage = v.live && v.billing.stripe_customer_id;
  let notice = "";
  if (declined(v, plan)) {
    const c = v.cardCheck!;
    notice =
      c.failures >= c.max
        ? `<p class="notice n-bad" role="alert" id="declined"><b>Your card did not pass the $1 check.</b> The bank declined a $1 hold, so the trial did not start and nothing was charged. ${c.failures} cards on this account did not pass it, so no trial can start; email <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>.</p>`
        : `<p class="notice n-bad" role="alert" id="declined"><b>Your card did not pass the $1 check.</b> The bank declined a $1 hold, so the trial did not start and nothing was charged. Try another card with Start your ${v.trialDays}-day free trial.</p>`;
  } else if (v.done) {
    const to = want && want !== "paid" ? planById(want) : null;
    notice = to
      ? `<p class="notice n-ok" role="status" id="donemsg"><b>Thanks.</b> This page changes to ${esc(to.name)} as soon as Stripe confirms your payment, usually within a minute (a bank debit can take a few days). Your ${esc(plan.name)} plan stays until then, then ends, and its unused days are refunded to the card or account that paid for it.</p>`
      : want && v.trialDone
        ? `<p class="notice n-ok" role="status" id="donemsg"><b>Thanks.</b> This page changes to your ${v.trialDays}-day Pro trial as soon as Stripe confirms it, usually within a minute. Nothing is charged until the trial ends.</p>`
      : want
        ? '<p class="notice n-ok" role="status" id="donemsg"><b>Thanks.</b> This page changes to your new plan as soon as Stripe confirms your payment, usually within a minute (a bank debit can take a few days).</p>'
        : `<p class="notice n-ok" role="status"><b>Thanks.</b> You are on the ${esc(plan.name)} plan now.</p>`;
  }
  const subscribed = !!v.billing.subscription_id && LIVE_STATUSES.has(v.billing.subscription_status ?? "") && plan.id !== "free";
  const switchNote =
    subscribed && v.live && !want
      ? '<p class="intro">Switching between Pro and Custom opens Stripe\'s checkout for the new plan. Your current plan stays until that payment goes through, then ends at once, and its unused days are refunded to the card or account that paid for it.</p>'
      : "";
  const managed = v.live && v.managedPlans?.length
    ? ` ${esc(v.managedPlans.join(" and "))} ${v.managedPlans.length > 1 ? "are" : "is"} sold through Link, Stripe's merchant of record service: Link's name is on the receipt and on your card statement, it adds sales tax or VAT where it applies, and it answers questions about the payment.`
    : "";
  const custom =
    plan.id === "custom"
      ? `<p class="status">A person from GenClass emails ${a.email ? esc(a.email) : "you"} within 1 business day of your purchase to start training your classifier. You can also write to <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>.</p>`
      : "";
  const test =
    v.testMode && v.live
      ? '<p class="notice" role="note"><b>Stripe test mode.</b> Only accounts listed in STRIPE_TEST_ACCOUNTS can buy, and no real money moves. Pay with card 4242 4242 4242 4242, any future date and any CVC.</p>'
      : "";
  const body = `
<style nonce="${nonce}">${DASH_CSS}${ACCOUNT_CSS}${BILLING_CSS}</style>
<div class="app">
<aside class="side acct" aria-label="Account">
  <div class="proj">Account<small>${who}</small></div>
  <div class="grp">Your apps</div>
  <nav class="apps" aria-label="Your apps">${appsNav}<a class="new" href="/account#new-app">New app</a></nav>
  <div class="grp">Account</div>
  <div class="out"><a href="/account/billing" aria-current="page">Plan and billing</a><a href="/account#security">Security</a><a href="/account#sessions">Sessions</a><a href="/account#delete">Delete account</a><form method="post" action="/logout"><button class="lnk" type="submit">Sign out</button></form></div>
</aside>
<div class="mainc" id="mc" tabindex="-1">
<section class="dh" id="top">
  <div class="eb">Account</div>
  <h1>Plan and billing</h1>
  <p class="status" id="status">${statusLine(v, plan, v.apps.length)}</p>
  ${custom}
</section>
${notice}${test}
<section class="blk" id="plans">
  <div class="blk-h"><h2>Plans</h2><span class="aside">US dollars, billed monthly</span></div>
  <div class="plans">${PLANS.map((p) => planColumn(v, p, plan)).join("")}</div>
  <p class="err" id="planerr" role="alert"></p>
  ${switchNote}
  <p class="intro">${esc(PLANS_FILE.footer).replace(esc(CONTACT), `<a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>`)}</p>
</section>
${
  manage
    ? `<section class="blk" id="manage">
  <div class="blk-h"><h2>Manage billing</h2><span class="aside">On Stripe</span></div>
  <p class="intro">Change your card, see and download invoices, or cancel. A cancelled plan stays until the end of the period you paid for. To switch between Pro and Custom, use the buttons under Plans.</p>
  <div class="acct-form"><button class="btn ghost" type="button" id="portal"><span>Manage billing</span></button></div>
  <p class="err" id="portalerr" role="alert"></p>
</section>`
    : ""
}
<footer class="dfoot">Payments are handled by Stripe.${managed} GenClass stores your Stripe customer and subscription ids, the subscription's
status and renewal date, and your plan; never card details. <a href="https://genclass.dev/privacy">Privacy</a> · <a href="https://genclass.dev/terms">Terms</a></footer>
</div>
</div>
<script type="application/json" id="cfg">${embed(v.focusTrial ? { want, focusTrial: true } : { want })}</script>`;

  const script = `
(function(){
  gcDropQuery([]);
  var cfg = JSON.parse(document.getElementById("cfg").textContent);
  document.querySelectorAll("[data-plan]").forEach(function(b){
    b.addEventListener("click", function(){
      var err = document.getElementById("planerr"); err.textContent = "";
      gcBusy(b, true, "Opening Stripe...");
      gcPost("/api/billing/checkout", { plan: b.getAttribute("data-plan") }).then(function(j){ location.href = j.url; }, function(e){ err.textContent = gcWhy(e); gcBusy(b, false); });
    });
  });
  var pick = document.querySelector("[data-pick]");
  if (pick) pick.focus();
  var trial = document.getElementById("trial");
  if (trial) trial.addEventListener("click", function(){
    var err = document.getElementById("planerr"); err.textContent = "";
    gcBusy(trial, true, "Opening Stripe...");
    gcPost("/api/billing/trial", {}).then(function(j){ location.href = j.url; }, function(e){ err.textContent = gcWhy(e); gcBusy(trial, false); });
  });
  if (cfg.focusTrial && trial) trial.focus();
  var portal = document.getElementById("portal");
  if (portal) portal.addEventListener("click", function(){
    var err = document.getElementById("portalerr"); err.textContent = "";
    gcBusy(portal, true, "Opening Stripe...");
    gcPost("/api/billing/portal", {}).then(function(j){ location.href = j.url; }, function(e){ err.textContent = gcWhy(e); gcBusy(portal, false); });
  });
  if (cfg.want) {
    var tries = 0;
    var timer = setInterval(function(){
      if (++tries > 40) { clearInterval(timer); var m = document.getElementById("donemsg"); if (m) m.lastChild.textContent = " Stripe has not told us yet. Reload this page in a few minutes; if your plan still shows Free, email ${esc(CONTACT)}."; return; }
      fetch("/api/billing", { headers: { accept: "application/json" }, cache: "no-store", credentials: "same-origin" })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){
          // the trial's card failed the $1 check: the page says so without ?done
          if (j && j.trial_card_declined_at && j.plan === "free") { clearInterval(timer); location.href = "/account/billing"; return; }
          if (j && j.plan && (cfg.want === "paid" ? j.plan !== "free" : j.plan === cfg.want)) { clearInterval(timer); location.reload(); }
        })
        .catch(function(){});
    }, 3000);
  }
})();`;
  return shell(nonce, "Plan and billing | GenClass", body, CLIENT_JS + script, { nav: SIGNED_IN_NAV, account: true, skip: "mc" });
}

// --------------------------------------------------------------------------------------------- app page sections

export interface AppExtras {
  projectId: string;
  projectName: string;
  plan: Plan;
  live: boolean;
  /** INTEGRATIONS_KEY is set and valid, so forwarding settings can be saved. */
  canSave: boolean;
  destinations: { kind: Kind; enabled: boolean; summary: string; lastSent: string | null; lastError: string | null }[];
  exportKeys: { id: string; label: string | null; created: string; lastUsed: string | null }[];
  ranges: Range[];
  keep: number;
}

/** Everything the app page's plan-dependent sections show, read for one owned app (a grant or a trial gives Pro's). */
export async function appExtrasData(db: D1Like, env: Env, accountId: string, p: Project, now: Date): Promise<AppExtras> {
  const plan = await accountPlan(db, accountId, env, now);
  const projectId = p.id ?? "";
  const destinations: AppExtras["destinations"] = [];
  if (entitled(plan, "forwarding") && projectId) {
    for (const r of await integrationRows(db, projectId)) {
      const c = await openConfig(env, projectId, r.kind, r.config);
      destinations.push({ kind: r.kind, enabled: !!r.enabled, summary: maskConfig(r.kind, c), lastSent: r.last_sent, lastError: r.last_error });
    }
  }
  let exportKeys: AppExtras["exportKeys"] = [];
  if (entitled(plan, "export")) {
    const r = await db.prepare("SELECT id, label, created, last_used FROM export_keys WHERE account_id = ? ORDER BY created").bind(accountId).all<{ id: string; label: string | null; created: string; last_used: string | null }>();
    exportKeys = (r.results ?? []).map((k) => ({ id: k.id, label: k.label, created: k.created, lastUsed: k.last_used }));
  }
  return {
    projectId,
    projectName: p.name,
    plan,
    live: billingLive(env),
    canSave: !!(await integrationsKey(env)),
    destinations,
    exportKeys,
    ranges: viewRanges(plan),
    keep: keepDays(plan),
  };
}

const EXTRA_CSS = `
.paid .intro{font-size:14.5px;color:var(--ink2);margin-top:14px;max-width:72ch;line-height:1.55}
.paid .intro a,.paid td a{color:var(--ink)}
.paid .xf{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-top:14px;max-width:760px}
.paid .xf .f{flex:1 1 220px;min-width:0}
.paid .xf .f.sm{flex:0 1 150px}
.paid .xf label{display:block;font:500 12.5px var(--mono);color:var(--ink3);margin-bottom:6px}
.paid .xf input,.paid .xf select{min-height:40px;width:100%;padding:0 10px;border-radius:0;border:1px solid var(--line);background:var(--paper);color:var(--ink);font:14px var(--sans)}
.paid .xf input:focus-visible,.paid .xf select:focus-visible{outline:1px solid var(--accent);outline-offset:1px}
.paid .xf .btn{min-height:40px}
.paid .err{font-size:14px;color:var(--warn);margin-top:8px}
.paid .err:empty{display:none}
.paid .ok{font-size:14px;color:var(--ink2);margin-top:8px}
.paid .ok:empty{display:none}
.paid .ok code{font:13px var(--mono);overflow-wrap:anywhere}
.paid .caution{margin-top:14px;padding:10px 0 10px 14px;border-left:3px solid var(--warn);font-size:14.5px;color:var(--ink2)}
.paid td .btn.sm{margin-left:6px}
.paid td.act{text-align:right;white-space:nowrap}
.paid td.e{white-space:normal;color:var(--warn);max-width:34ch}
.paid details.more{margin-top:14px}
.paid pre.code{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:10px}
.rnote{font-size:12.5px;color:var(--ink3);margin-top:8px;line-height:1.45}
.rnote a{color:var(--ink2)}
`;

const SEE_PLANS = '<a href="/account/billing">See plans</a>';

function destinationForm(kind: Kind, set: boolean, disabled: boolean): string {
  const dis = disabled ? " disabled" : "";
  const f = (id: string, label: string, input: string, cls = "f") => `<div class="${cls}"><label for="${id}">${label}</label>${input}</div>`;
  let fields = "";
  switch (kind) {
    case "sentry":
      fields = f("fw-sentry-dsn", "DSN", `<input id="fw-sentry-dsn" name="dsn" type="text" autocomplete="off" spellcheck="false" placeholder="https://abc123@o1.ingest.sentry.io/456"${dis}>`);
      break;
    case "posthog":
      fields =
        f("fw-posthog-key", "Project API key", `<input id="fw-posthog-key" name="key" type="text" autocomplete="off" spellcheck="false" placeholder="phc_..."${dis}>`) +
        f("fw-posthog-host", "Host", `<select id="fw-posthog-host" name="host"${dis}>${POSTHOG_HOSTS.map((h) => `<option value="${esc(h)}">${esc(new URL(h).host)}</option>`).join("")}</select>`, "f sm");
      break;
    case "datadog":
      fields =
        f("fw-datadog-key", "API key", `<input id="fw-datadog-key" name="api_key" type="password" autocomplete="off" spellcheck="false" placeholder="32 hex characters"${dis}>`) +
        f("fw-datadog-site", "Site", `<select id="fw-datadog-site" name="site"${dis}>${DATADOG_SITES.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select>`, "f sm");
      break;
    case "slack":
      fields = f("fw-slack-url", "Incoming webhook URL", `<input id="fw-slack-url" name="url" type="password" autocomplete="off" spellcheck="false" placeholder="https://hooks.slack.com/services/..."${dis}>`);
      break;
    case "webhook":
      fields = f("fw-webhook-url", "URL", `<input id="fw-webhook-url" name="url" type="url" autocomplete="off" spellcheck="false" placeholder="https://example.com/hooks/genclass"${dis}>`);
      break;
  }
  const help: Record<Kind, string> = {
    sentry: "Sentry gets one event per record, level warning, grouped by problem type and page.",
    posthog: "PostHog gets a <code>genclass detection</code> event per record, without person profiles.",
    datadog: "Datadog gets one log per record, source <code>genclass</code>, tagged with the problem type and page.",
    slack: "Slack gets one short message per record with a link to this dashboard.",
    webhook:
      "Your endpoint gets a JSON POST per record. It is signed: the <code>x-genclass-signature</code> header is <code>t=&lt;unix time&gt;,v1=&lt;hex&gt;</code>, the HMAC-SHA256 of <code>t</code>, a dot and the body, under the secret shown once after you save.",
  };
  return `<details class="more" id="fw-${kind}"><summary>${set ? "Change" : "Set up"} ${KIND_NAMES[kind]}</summary>
  <p class="intro">${help[kind]}</p>
  <form class="xf" data-kind="${kind}" novalidate>${fields}<button class="btn" type="submit"${dis}><span>Save</span></button></form>
  <p class="err" data-err="${kind}" role="alert"></p><p class="ok" data-ok="${kind}" role="status"></p>
</details>`;
}

/** The forwarding and export sections and their script (rendered into the dashboard page with its nonce). */
export function appExtrasHtml(nonce: string, d: AppExtras): { html: string; script: string } {
  const fw = entitled(d.plan, "forwarding");
  const ex = entitled(d.plan, "export");
  let forwarding: string;
  if (!fw) {
    forwarding = `<p class="intro">On Pro and Custom, GenClass sends each new detection from this app to Sentry, PostHog, Datadog, Slack or your own webhook. It is sent from our server, so nothing changes in your app. ${SEE_PLANS}</p>`;
  } else {
    const byKind = new Map(d.destinations.map((x) => [x.kind, x]));
    const rows = KINDS.map((k) => {
      const x = byKind.get(k);
      const status = !x ? '<span class="muted">Not set up</span>' : x.enabled ? "On" : '<span class="muted">Off</span>';
      const acts = x
        ? `<button class="btn sm ghost" type="button" data-test="${k}" aria-label="Send a test record to ${KIND_NAMES[k]}">Send test</button>` +
          `<button class="btn sm ghost" type="button" data-toggle="${k}" data-on="${x.enabled ? "1" : "0"}">${x.enabled ? "Turn off" : "Turn on"}</button>` +
          `<button class="btn sm ghost" type="button" data-remove="${k}" aria-label="Remove ${KIND_NAMES[k]}">Remove</button>`
        : `<a href="#fw-${k}" data-open="${k}">Set up</a>`;
      return `<tr><td>${KIND_NAMES[k]}${x ? `<div class="muted">${esc(x.summary)}</div>` : ""}</td><td data-l="Status">${status}</td><td data-l="Last sent">${x ? time(x.lastSent, "ago", "never") : ""}</td><td class="e" data-l="Last error">${x?.lastError ? esc(x.lastError) : ""}</td><td class="act">${acts}</td></tr>`;
    }).join("\n");
    forwarding = `<p class="intro">Each new detection is sent from our server to the destinations you turn on: the problem type, confidence, trigger, page route, runtime and model versions, the time and a link to this dashboard. Never text from your pages. The same problem on the same page is sent at most once an hour, and at most 60 records an hour for this app.</p>
  ${d.canSave ? "" : '<p class="caution"><b>Not available on this server yet.</b> Forwarding settings are stored encrypted, and this server has no encryption key set, so they cannot be saved.</p>'}
  <div class="tablewrap"><table class="dt rows"><thead><tr><th>Destination</th><th>Status</th><th>Last sent</th><th>Last error</th><th></th></tr></thead><tbody>
${rows}
  </tbody></table></div>
  <p class="err" id="fwerr" role="alert"></p><p class="ok" id="fwok" role="status"></p>
  ${KINDS.map((k) => destinationForm(k, byKind.has(k), !d.canSave)).join("\n")}`;
  }

  let exportHtml: string;
  if (!ex) {
    exportHtml = `<p class="intro">On Pro and Custom you can download every event GenClass receives for this app from the day you upgrade, kept a year, as JSON Lines or CSV, or read it with an API key. ${SEE_PLANS}</p>`;
  } else {
    const keys = d.exportKeys.length
      ? `<div class="tablewrap"><table class="dt rows"><thead><tr><th>Export key</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${d.exportKeys
          .map((k) => `<tr><td>${esc(k.label ?? "Export key")}</td><td data-l="Created">${time(k.created)}</td><td data-l="Last used">${time(k.lastUsed, "ago")}</td><td class="act"><button class="btn sm ghost" type="button" data-revokekey="${esc(k.id)}">Revoke</button></td></tr>`)
          .join("")}</tbody></table></div>`
      : '<p class="intro">No export keys yet.</p>';
    const curl = `curl -H "Authorization: Bearer gce_..." \\\n  "https://genclass.dev/api/account/projects/${d.projectId}/events?from=2026-10-01&to=2026-10-14&format=jsonl"`;
    exportHtml = `<p class="intro">Every event GenClass received for this app while this account was on Pro or Custom, kept ${d.keep >= 365 ? "1 year" : `${d.keep} days`}: one JSON object per line as the collector stored it (the batch's session id, versions, time received, country and the event), or one CSV row per event.</p>
  <form class="xf" id="exf" novalidate>
    <div class="f sm"><label for="exfrom">From</label><input id="exfrom" type="date"></div>
    <div class="f sm"><label for="exto">To (inclusive)</label><input id="exto" type="date"></div>
    <div class="f sm"><label for="exfmt">Format</label><select id="exfmt"><option value="jsonl">JSON Lines</option><option value="csv">CSV</option></select></div>
    <button class="btn" type="submit" id="exgo"><span>Download</span></button>
  </form>
  <p class="ok" id="exstat" role="status"></p><p class="err" id="exerr" role="alert"></p>
  <details class="more" id="exapi"><summary>Read it with the API</summary>
  <p class="intro">Send an export key as a bearer token. <code>from</code> and <code>to</code> take a date or an ISO time (<code>to</code> is exclusive); <code>format</code> is <code>jsonl</code> or <code>csv</code>. An answer holds up to 200 batches; when there are more, the <code>x-genclass-next-cursor</code> header holds a cursor to send as <code>cursor</code> for the next page. An export key reads the export of every app in this account and nothing else.</p>
  <pre class="code">${esc(curl)}</pre>
  ${keys}
  <form class="xf" id="keyf" novalidate><div class="f"><label for="keylabel">New export key</label><input id="keylabel" type="text" maxlength="60" autocomplete="off" placeholder="Name, e.g. warehouse sync"></div><button class="btn ghost" type="submit"><span>Create export key</span></button></form>
  <p class="err" id="keyerr" role="alert"></p><p class="ok" id="keyok" role="status"></p>
  </details>`;
  }

  const html = `<style nonce="${nonce}">${EXTRA_CSS}</style>
<section class="blk paid" id="forwarding">
  <div class="blk-h"><h2>Forwarding</h2><span class="aside">${fw ? "New detections, sent where you already look" : "Pro and Custom"}</span></div>
  ${forwarding}
</section>
<section class="blk paid" id="export">
  <div class="blk-h"><h2>Export</h2><span class="aside">${ex ? "Every event, as a file or by API" : "Pro and Custom"}</span></div>
  ${exportHtml}
</section>
<script type="application/json" id="paidcfg">${embed({
    id: d.projectId,
    name: d.projectName,
    keep: d.keep,
    note: d.plan.id === "free" && d.live && d.plan.limits.history_days < 30 ? `The ${d.plan.name} plan shows ${d.plan.limits.history_days} days.` : null,
  })}</script>`;

  const script = `
(function(){
  var C = JSON.parse(document.getElementById("paidcfg").textContent);
  var base = "/api/account/projects/" + encodeURIComponent(C.id);
  function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function req(method, url, body){
    return fetch(url, { method: method, credentials: "same-origin", headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function(r){
        if (r.status === 204) return {};
        return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status)); return j; });
      });
  }
  function say(node, text){ if (node) node.textContent = text ? text.charAt(0).toUpperCase() + text.slice(1) + (/[.]$/.test(text) ? "" : ".") : ""; }
  // times in the viewer's zone ("12 min ago", "13 Oct 2026"); the server wrote UTC dates
  document.querySelectorAll(".paid time[data-f]").forEach(function(t){
    var d = new Date(t.getAttribute("datetime")); if (isNaN(d)) return;
    var s = (Date.now() - d.getTime()) / 1000;
    t.textContent = t.getAttribute("data-f") === "ago" && s >= 0 && s < 129600 ? (s < 90 ? "just now" : s < 5400 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago") : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    t.title = d.toLocaleString();
  });
  // the plan's ranges: a short note under the range buttons
  if (C.note) document.querySelectorAll(".seg").forEach(function(s){ var p = el("p", "rnote", C.note + " "); var a = el("a", null, "Pro shows a year."); a.href = "/account/billing"; p.appendChild(a); s.parentNode.insertBefore(p, s.nextSibling); });
  // forwarding
  var fwerr = document.getElementById("fwerr"), fwok = document.getElementById("fwok");
  document.querySelectorAll("form[data-kind]").forEach(function(f){
    f.addEventListener("submit", function(ev){
      ev.preventDefault();
      var kind = f.getAttribute("data-kind"), err = document.querySelector('[data-err="' + kind + '"]'), ok = document.querySelector('[data-ok="' + kind + '"]'), body = {};
      say(err, ""); say(ok, "");
      f.querySelectorAll("input,select").forEach(function(i){ body[i.name] = i.value; });
      var b = f.querySelector("button"); b.disabled = true;
      req("PUT", base + "/integrations/" + kind, body).then(function(j){
        if (j.secret) { ok.textContent = "Saved. Your signing secret, shown once: "; ok.appendChild(el("code", null, j.secret)); b.disabled = false; return; }
        location.reload();
      }, function(e){ say(err, e.message); b.disabled = false; });
    });
  });
  document.querySelectorAll("[data-open]").forEach(function(a){ a.addEventListener("click", function(){ var d = document.getElementById("fw-" + a.getAttribute("data-open")); if (d) d.open = true; }); });
  document.querySelectorAll("[data-test]").forEach(function(b){
    b.addEventListener("click", function(){
      say(fwerr, ""); say(fwok, ""); b.disabled = true;
      req("POST", base + "/integrations/" + b.getAttribute("data-test") + "/test", {}).then(function(){ say(fwok, "Sent a test record. Check that it arrived"); b.disabled = false; }, function(e){ say(fwerr, e.message); b.disabled = false; });
    });
  });
  document.querySelectorAll("[data-toggle]").forEach(function(b){
    b.addEventListener("click", function(){
      b.disabled = true;
      req("PATCH", base + "/integrations/" + b.getAttribute("data-toggle"), { enabled: b.getAttribute("data-on") !== "1" }).then(function(){ location.reload(); }, function(e){ say(fwerr, e.message); b.disabled = false; });
    });
  });
  document.querySelectorAll("[data-remove]").forEach(function(b){
    b.addEventListener("click", function(){
      if (b.getAttribute("data-armed") !== "1") { b.setAttribute("data-armed", "1"); b.textContent = "Confirm remove"; return; }
      b.disabled = true;
      req("DELETE", base + "/integrations/" + b.getAttribute("data-remove")).then(function(){ location.reload(); }, function(e){ say(fwerr, e.message); b.disabled = false; });
    });
  });
  // export
  var exf = document.getElementById("exf");
  if (exf) {
    var from = document.getElementById("exfrom"), to = document.getElementById("exto"), fmt = document.getElementById("exfmt"), stat = document.getElementById("exstat"), exerr = document.getElementById("exerr");
    var today = new Date(), d0 = new Date(today.getTime() - 6 * 86400000), min = new Date(today.getTime() - (C.keep - 1) * 86400000);
    function ymd(d){ return d.toISOString().slice(0, 10); }
    from.value = ymd(d0); to.value = ymd(today); from.min = ymd(min); to.min = ymd(min); from.max = ymd(today); to.max = ymd(today);
    exf.addEventListener("submit", function(ev){
      ev.preventDefault(); say(exerr, ""); say(stat, "");
      if (!from.value || !to.value || from.value > to.value) { say(exerr, "Pick a start date on or before the end date"); return; }
      var end = new Date(Date.parse(to.value + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
      var q = base + "/events?from=" + from.value + "&to=" + end + "&format=" + fmt.value, parts = [], pages = 0, btn = document.getElementById("exgo");
      btn.disabled = true;
      function page(url){
        return fetch(url, { credentials: "same-origin", cache: "no-store" }).then(function(r){
          if (!r.ok) return r.json().catch(function(){ return {}; }).then(function(j){ throw new Error(j.error || ("HTTP " + r.status)); });
          var next = r.headers.get("x-genclass-next-cursor");
          return r.blob().then(function(b){ parts.push(b); pages++; stat.textContent = "Downloaded " + pages + (pages === 1 ? " page" : " pages") + (next ? ", reading more..." : "."); if (next) return page(q + "&cursor=" + encodeURIComponent(next)); });
        });
      }
      page(q).then(function(){
        var blob = new Blob(parts, { type: fmt.value === "csv" ? "text/csv" : "application/x-ndjson" });
        var a = el("a"); a.href = URL.createObjectURL(blob); a.download = "genclass-" + C.id + "-" + from.value + "-" + to.value + "." + fmt.value;
        document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 2000);
        stat.textContent = blob.size ? "Saved " + Math.max(1, Math.round(blob.size / 1024)) + " KB." : "No events in those dates.";
      }, function(e){ say(exerr, e.message); }).then(function(){ btn.disabled = false; });
    });
  }
  var keyf = document.getElementById("keyf");
  if (keyf) keyf.addEventListener("submit", function(ev){
    ev.preventDefault();
    var err = document.getElementById("keyerr"), ok = document.getElementById("keyok"); say(err, ""); say(ok, "");
    req("POST", "/api/account/export-keys", { label: document.getElementById("keylabel").value }).then(function(j){
      ok.textContent = "Your export key, shown once. Keep it like a password: "; ok.appendChild(el("code", null, j.key));
    }, function(e){ say(err, e.message); });
  });
  document.querySelectorAll("[data-revokekey]").forEach(function(b){
    b.addEventListener("click", function(){
      if (b.getAttribute("data-armed") !== "1") { b.setAttribute("data-armed", "1"); b.textContent = "Confirm revoke"; return; }
      b.disabled = true;
      req("DELETE", "/api/account/export-keys/" + encodeURIComponent(b.getAttribute("data-revokekey"))).then(function(){ location.reload(); }, function(e){ say(document.getElementById("keyerr"), e.message); b.disabled = false; });
    });
  });
})();`;
  return { html, script };
}

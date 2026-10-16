// `genclass-runtime stats` (also `npx @genclass/runtime stats`; owner: INSTALL): a free summary, in the terminal, of
// what GenClass found on the deployed app, read from genclass.dev's summary endpoint (telemetry-worker/src/summary.ts).
//
// Which app, in this order: --app (an app of the signed-in account); the private dashboard link in .genclass.local
// when its token is the one in the setup (GET /api/projects/<secret>/summary, no session); the token in what init
// wrote plus a signed-in CLI session (GET /api/me, then GET /api/account/projects/<id>/summary with the bearer); the
// account's only app. A private link that no longer works (turned off or replaced) falls through to the signed-in
// account. Otherwise it says how to get one (init, login) and exits 1.
//
// Invariants:
// - It sends only the dashboard secret or the CLI session (and the app id and the range); nothing from the code or
//   the pages. A private dashboard link is only sent to the host it belongs to (as login.mjs does).
// - It reads the summary only. The summary holds counters the collector already keeps; nothing new is collected
//   for it, and it is no reason to send more.
// - --json prints the answer's JSON and nothing else on stdout; errors go to stderr. Exit codes: 0 (also with no
//   data), 1 (no app, network, HTTP errors), 2 (usage).
// - Every string from the server is printed through clean(): route and diagnosis keys come from whoever holds the
//   public app token, so control, bidi and zero-width characters never reach the terminal (the worker strips them
//   too). The private link's secret is never printed in the human output.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchMe, readCredentialsFor } from "./account.mjs";
import { apiHost, hostConfig, hostUrl } from "./host.mjs";
import { UsageError, accountLabel, currentConfig, hostNotice, inspectProject, parse } from "./init.mjs";
import { LOCAL_FILE } from "./token.mjs";
import { c, err, out, sym } from "./ui.mjs";

const CMD = "npx @genclass/runtime";
const TIMEOUT_MS = 10_000;
/** The trial's length: billing/plans.json trial_days (telemetry-worker/test/trial.test.ts checks the CLI's copy). */
const TRIAL_DAYS = 7;
const TELEMETRY_DOCS = "https://genclass.dev/docs/telemetry";
const SAMPLE_URL = "https://genclass.dev/dashboard/sample";
const ISSUES_URL = "https://github.com/genclass-dev/GenClass-lib/issues";

/** Server text as a terminal can print it: no control, bidi or zero-width characters, at most `max` characters. */
export function clean(v, max = 120) {
  // eslint-disable-next-line no-control-regex
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "").trim();
  return [...s].slice(0, max).join("");
}

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")).version;
  } catch {
    return "0";
  }
})();

export const USAGE = `Usage:
  genclass-runtime stats [--range 24h|7d] [--json] [--app <id|name|gc_token>] [--cwd <dir>]

stats    prints a free summary of what GenClass found on your deployed app: page loads, problems found and
         the pages they were on, possible issues, the mode, how often the model loaded, and the last event,
         for the last 24 hours or 7 days (UTC). It counts only what the app sent with telemetry on (the
         default) and its token. It finds the app from --app, the private dashboard link in ${LOCAL_FILE}
         (made by init), or your signed-in account (login) and the token in your setup.

  --range <r>      24h or 7d (default: 7d)
  --json           print the summary as JSON and nothing else
  --app <a>        an app of your signed-in account, by id, name or token
  --cwd <dir>      the project directory (default: the current directory)

stats sends genclass.dev only the private link's secret, or your CLI session and the app's id, with the
range: nothing from your code or your pages. The summary is free and deliberately short; the dashboard
(every page and problem, what GenClass did, 1 year of history, export, forwarding) needs Pro: get a
${TRIAL_DAYS}-day free trial for analytics. --json includes the dashboard's address, which on the private-link
path is the private link: keep its output out of code, docs, issues and pull requests.`;

const SPEC = { bool: { json: "json", help: "help", h: "help" }, value: { range: "range", app: "app", cwd: "cwd" } };

// ------------------------------------------------------------------------------------------------ words

/** The problem types' names, as the dashboard shows them (telemetry-worker/src/pages.ts, TYPES), in lower case. */
const DIAGNOSES = {
  duplicate: "double submits",
  stale: "stale responses",
  failing: "failing endpoints",
  slow: "slow operations",
  conflict: "write races",
  transient: "one-off failures",
  inconsistent: "broken state",
  overload: "request storms",
  unusual: "unusual behaviour",
};
const diagnosisName = (key) => DIAGNOSES[key] ?? (clean(key) || "(unknown)");

const RANGES = {
  "24h": { title: "last 24 hours", before: "the 24 hours before" },
  "7d": { title: "last 7 days", before: "the 7 days before" },
};

const MID = sym.ok === "✔" ? " · " : ", ";
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const fmt = (n) => Math.round(num(n)).toLocaleString("en-US");
const plural = (n, one, many) => `${fmt(n)} ${Math.round(num(n)) === 1 ? one : many}`;

/** "+12% vs the 7 days before", or "" when there is nothing to compare with. */
function change(now, before, label) {
  if (!(num(before) > 0)) return "";
  const pct = Math.round(((num(now) - num(before)) / num(before)) * 100);
  if (pct === 0) return `about the same as ${label}`;
  return `${pct > 0 ? "+" : ""}${pct}% vs ${label}`;
}

/** "98%" of a 0..1 share; never 100% unless it is all of them, never 0% unless it is none. */
function percent(share) {
  const p = share * 100;
  if (share >= 1) return "100%";
  if (share <= 0) return "0%";
  if (p < 1) return "under 1%";
  return `${Math.min(99, Math.round(p))}%`;
}

/** "3 minutes ago" for an ISO time, or null. */
export function ago(iso, now = Date.now()) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "under a minute ago";
  const m = Math.round(s / 60);
  if (m < 90) return `${plural(m, "minute", "minutes")} ago`;
  const h = Math.round(s / 3600);
  if (h < 36) return `${plural(h, "hour", "hours")} ago`;
  return `${plural(Math.round(s / 86400), "day", "days")} ago`;
}

function modeLine(mode, t) {
  const acted = num(t.acted);
  const did = acted > 0 ? `reported them and acted ${plural(acted, "time", "times")}` : "reported them and changed nothing";
  if (mode === "observe") return num(t.detections) > 0 ? "observe: GenClass reported them and changed nothing" : "observe: GenClass reports and changes nothing";
  if (mode === "guard") return `guard: GenClass ${did}`;
  if (mode === "heal") return `heal (experimental): GenClass ${did}`;
  if (mode === "mixed") return `mixed: page loads ran in more than one mode${acted > 0 ? `; GenClass acted ${plural(acted, "time", "times")}` : ""}`;
  return null;
}

/** The summary as the lines `stats` prints (no colour codes when NO_COLOR is set). */
export function render(s) {
  const r = RANGES[s.range] ?? RANGES["7d"];
  const t = s.totals ?? {};
  const name = clean(s.name, 80) || "this app";
  const lines = [];
  const dash = s.dashboard ?? {};
  // empty only when nothing at all arrived: a tab opened before the range sends its page load once, at load, and
  // its later problems still count
  if (![t.sessions, t.detections, t.possible, t.acted].some((n) => num(n) > 0)) {
    lines.push(`No diagnostics received for ${c.bold(name)} in the ${r.title}.`);
    lines.push(`GenClass sends them from public hosts when the app runs with telemetry on (the default) and this app's token:`);
    lines.push(`the deployed page logs "[GenClass] Sends anonymous diagnostics …" in the browser console. Just ran init?`);
    lines.push(`Deploy the change (the token needs @genclass/runtime 0.3.0 or later) and check again after some page loads.`);
    lines.push(`Local and private hosts (localhost, *.local, *.test, private networks) do not send unless telemetry: true is set.`);
    lines.push(`telemetry: false turns it off for the whole app; ?genclass=no-telemetry, localStorage genclass.telemetry=off`);
    lines.push(`and Global Privacy Control turn it off for one visitor.`);
    lines.push(`What is sent: ${c.cyan(TELEMETRY_DOCS)}`);
    return lines;
  }
  const top = s.top ?? {};
  const diagnoses = Array.isArray(top.diagnoses) ? top.diagnoses : [];
  const routes = Array.isArray(top.routes) ? top.routes : [];
  const w = Math.max(7, ...[t.sessions, t.detections, t.possible, t.pagesAffected].map((n) => fmt(n).length + 2));
  const counted = (label, n, detail) => `  ${label.padEnd(16)}${fmt(n).padStart(w)}${detail ? `   ${detail}` : ""}`;
  const text = (label, value) => `  ${label.padEnd(16 + w - 5)}${value}`;

  lines.push(c.bold(`GenClass stats for ${name} (${r.title}, UTC)`));
  // with no page loads in the range (only problems from tabs opened before it), a change would say -100%
  lines.push(counted("Page loads", t.sessions, num(t.sessions) > 0 ? change(t.sessions, s.previous?.sessions, r.before) : ""));
  lines.push(counted("Problems found", t.detections, diagnoses.map((d) => `${diagnosisName(d.key)} ${fmt(d.count)}`).join(MID)));
  lines.push(counted("Possible issues", t.possible, "lower-confidence detections"));
  const seen = num(t.pagesSeen);
  const pages = [seen > 0 ? `of ${plural(seen, "page", "pages")} that sent data` : "", routes.length ? `most on ${routes.map((x) => `${clean(x.key) || "(unknown)"} (${fmt(x.count)})`).join(", ")}` : ""].filter(Boolean);
  lines.push(counted("Pages affected", t.pagesAffected, pages.join(MID)));
  const mode = modeLine(s.mode, t);
  if (mode) lines.push(text("Mode", mode));
  if (typeof t.modelLoadedShare === "number") {
    const ms = typeof t.modelLoadMsAvg === "number" ? `, ${fmt(t.modelLoadMsAvg)} ms on average` : "";
    lines.push(text("Model loaded", `${percent(t.modelLoadedShare)} of page loads${ms}`));
  }
  lines.push(text("Last event", ago(s.lastEvent) ?? "none yet"));
  lines.push("");
  lines.push("This is the free summary. The dashboard shows every page and problem, what GenClass did, how to fix each kind,");
  lines.push("1 year of history, export, and forwarding to Sentry, PostHog, Datadog or Slack.");
  const url = typeof dash.url === "string" ? clean(dash.url, 300) : null;
  // the private link (/dashboard/<secret>) is a password: name where it is instead of printing it
  const isLink = (u) => typeof u === "string" && /\/dashboard\/(?!sample$)[^/]+$/.test(u);
  if (dash.locked === false && url) lines.push(isLink(url) ? `Dashboard: open the private link in ${LOCAL_FILE} (keep it out of code, docs and pull requests)` : `Dashboard: ${c.cyan(url)}`);
  else {
    const trialUrl = typeof dash.trialUrl === "string" ? clean(dash.trialUrl, 300) : hostUrl("/account/trial");
    if (dash.trialAvailable === false) lines.push(`Your trial has ended; the dashboard comes with Pro: ${c.cyan(hostUrl("/account/billing"))}`);
    else if (isLink(trialUrl)) {
      // an app in no account: its locked private link adds it to an account and starts the trial there
      lines.push(`Get a ${TRIAL_DAYS}-day free trial for analytics (no card needed): open the private link in ${LOCAL_FILE},`);
      lines.push(`sign in, add this app to your account and start the trial there.`);
    } else lines.push(`Get a ${TRIAL_DAYS}-day free trial for analytics: ${c.cyan(trialUrl)} (no card needed)`);
    lines.push(`See one filled in: ${c.cyan(SAMPLE_URL)}`);
  }
  return lines;
}

// ------------------------------------------------------------------------------------------------ network

/** GET a JSON path on the host: { ok, status, text, json, retryAfter } or { ok: false, status: 0, reason }. Never rejects. */
async function get(path, token, { host = apiHost(), fetchFn = globalThis.fetch } = {}) {
  if (typeof fetchFn !== "function") return { ok: false, status: 0, reason: "this Node.js has no fetch" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers = { accept: "application/json", "user-agent": `genclass-runtime-cli/${VERSION}` };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchFn(`${host}${path}`, { method: "GET", headers, signal: ctl.signal, redirect: "error" });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, text, json, retryAfter: res.headers.get("retry-after") };
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return { ok: false, status: 0, reason: aborted ? `no answer within ${TIMEOUT_MS / 1000} s` : `network error (${e?.cause?.code ?? e?.message ?? e})` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One app's summary: `app` is { secret } (the private link's, GET /api/projects/<secret>/summary) or { id, token }
 * (an app of the account and the CLI session, GET /api/account/projects/<id>/summary). Resolves get()'s answer with
 * `summary` set when it is one (ok, with totals), else null. Never rejects. telemetry-worker/test/stats-cli.test.ts
 * runs it against the worker.
 */
export async function fetchSummary(app, { range = "7d", host = apiHost(), fetchFn = globalThis.fetch } = {}) {
  const path = app.secret ? `/api/projects/${encodeURIComponent(app.secret)}/summary` : `/api/account/projects/${encodeURIComponent(app.id)}/summary`;
  const r = await get(`${path}?range=${encodeURIComponent(range)}`, app.secret ? null : app.token, { host, fetchFn });
  const j = r.json;
  return { ...r, summary: r.ok && j && j.ok === true && typeof j.totals === "object" && j.totals !== null ? j : null };
}

/** Why a summary request failed, in plain words (one or two lines for stderr). */
function failed(r, who) {
  const host = apiHost();
  const error = typeof r.json?.error === "string" ? clean(r.json.error, 200) : "";
  const http = `HTTP ${r.status}${error ? `: ${error}` : ""}`;
  if (r.status === 0) return [`Could not reach ${host} (${r.reason}).`];
  if (r.status === 429) {
    const n = Number(r.retryAfter);
    const s = Number.isFinite(n) && n > 0 ? Math.ceil(n) : 60;
    return [`${host} is answering too many summary requests for ${who} right now: try again in ${s} s.`];
  }
  if (r.status === 401) return [`The saved CLI session no longer works (signed out, revoked or expired). Sign in again: ${CMD} login`];
  // the summary is free on every plan: a 402 is a fault to report, not an offer
  if (r.status === 402) return [`${host} refused ${who}'s summary (${http}). The summary is meant to be free on every plan;`, `please report this: ${ISSUES_URL}`];
  if (r.status === 403) return [`${host} did not let this CLI session read ${who}'s summary (${http}).`, `Sign in with the account that owns it (${CMD} logout, then login).`];
  if (r.status === 404) return [`${host} does not know ${who} (${http}); it may have been deleted.`];
  return [`Could not read ${who}'s summary: ${host} answered ${http}.`];
}

const say = (o, s = "") => (o.json ? err(s) : out(s));
const fail = (lines) => {
  for (const [i, l] of lines.entries()) err(i === 0 ? `  ${c.red(sym.cross)} ${l}` : `    ${l}`);
  return 1;
};

/** Reads one summary and prints it (or its JSON). Returns the exit code. */
async function show(o, app, who) {
  return print(o, await fetchSummary(app, { range: o.range ?? "7d" }), who);
}

/** Prints a summary answer (or why it failed). Returns the exit code. */
function print(o, r, who) {
  if (!r.ok) return fail(failed(r, who));
  if (!r.summary) return fail([`Could not read ${who}'s summary: ${apiHost()}'s answer was not one.`]);
  if (o.json) {
    out(r.text.trimEnd());
    return 0;
  }
  for (const l of render(r.summary)) out(l);
  out();
  return 0;
}

// ------------------------------------------------------------------------------------------------ apps

/** Whether `url` (a dashboard link) is on `host` (an origin). */
const onHost = (url, host) => {
  try {
    return new URL(url).origin === host;
  } catch {
    return false;
  }
};
const secretOf = (url) => {
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[1] ?? null;
  } catch {
    return null;
  }
};

function listApps(o, apps) {
  const rows = apps.map((p) => ({ name: clean(p.name, 80), id: clean(p.id, 40), token: clean(p.token, 40), last: p.last_event }));
  const w = Math.min(28, Math.max(4, ...rows.map((p) => p.name.length)));
  for (const p of rows) say(o, `    ${c.bold(p.name.padEnd(w))}  ${p.id}  ${p.token}  ${c.gray(p.last ? `last event ${ago(p.last)}` : "no events yet")}`.trimEnd());
}

async function stats(o) {
  if (o.json) {
    const h = hostConfig();
    if (h.overridden) err(`genclass-runtime stats: GENCLASS_HOST is set: ${h.host} (for tests only, instead of https://genclass.dev)`);
  } else hostNotice();
  const host = apiHost();
  const st = inspectProject(o);
  const local = st.local;

  // a setup made with --no-telemetry sends nothing: say so, and how to turn it back on (init alone would do nothing)
  if (!o.app && currentConfig(st.marked).telemetry === false) {
    return fail([
      `Telemetry is off in this project's GenClass setup (init --no-telemetry wrote the opt-out), so the app sends no`,
      `diagnostics and there is nothing to summarise. To turn it back on: ${CMD} init --telemetry (then give the app a`,
      `token as it says). For an app of your signed-in account: ${CMD} stats --app <id>`,
    ]);
  }

  // (1) the private link init saved, when it is this setup's app (connect may have replaced the token since)
  let staleLink = false;
  if (!o.app && local?.dashboardUrl && st.token === local.token) {
    if (onHost(local.dashboardUrl, host)) {
      const secret = secretOf(local.dashboardUrl);
      if (secret) {
        const r = await fetchSummary({ secret }, { range: o.range ?? "7d" });
        if (r.status !== 404) return print(o, r, "this app");
        // turned off or replaced on the account page (or the app was deleted): the signed-in account may still read it
        staleLink = true;
      }
    } else {
      say(o, `  ${c.yellow(sym.warn)} The private dashboard link in ${LOCAL_FILE} belongs to ${new URL(local.dashboardUrl).origin}, not ${host},`);
      say(o, `    so it is not sent there.`);
    }
  }

  // (2), (3) a signed-in account: the app with this setup's token, the one --app names, or the only one
  const { creds, otherHost } = readCredentialsFor(host);
  const staleLines = [
    `The private dashboard link in ${LOCAL_FILE} no longer works at ${host} (HTTP 404): it was turned off or replaced`,
    `on the app's account page, or the app was deleted.`,
  ];
  if (staleLink && !creds) return fail([...staleLines, `If the app is in your account, sign in and run stats again: ${CMD} login`]);
  if (staleLink) say(o, `  ${c.yellow(sym.warn)} ${staleLines.join(" ")} Reading the app from your signed-in account instead.`);
  if (!creds) {
    if (o.app) return fail([`--app needs a signed-in GenClass account${otherHost ? ` at ${host} (the saved session is for ${otherHost})` : ""}. Sign in: ${CMD} login`]);
    if (st.token)
      return fail([
        `This app has a token (${st.token}) but no private dashboard link in ${LOCAL_FILE}, and you are not signed in${otherHost ? ` at ${host}` : ""}.`,
        `Sign in to the account it belongs to: ${CMD} login`,
      ]);
    return fail([`No app found here: no private dashboard link in ${LOCAL_FILE} and no signed-in GenClass account.`, `Run ${CMD} init (it creates this app's token) or ${CMD} login.`]);
  }
  const me = await fetchMe(creds, { timeoutMs: TIMEOUT_MS });
  if (!me.ok) {
    if (me.status === 401) return fail(failed({ status: 401 }, "this app"));
    return fail([`Could not read your apps at ${host} (${me.reason}).`]);
  }
  const apps = me.projects;
  const label = accountLabel(me.account);
  let app = null;
  if (o.app) {
    app = apps.find((a) => a.id === o.app || a.token === o.app) ?? apps.find((a) => a.name === o.app) ?? null;
    if (!app) {
      fail([`No app "${clean(o.app, 80)}" in your account (${label}).${apps.length ? " Your apps:" : " It has no apps yet."}`]);
      listApps({ json: true }, apps);
      return 1;
    }
  } else if (st.token) {
    app = apps.find((a) => a.token === st.token) ?? null;
    if (!app) {
      fail([`This app's token (${st.token}) is not one of your account's apps (${label}).`, `Add it with ${CMD} connect, or pick one with --app <id>.`]);
      if (apps.length) listApps({ json: true }, apps);
      return 1;
    }
  } else if (apps.length === 1) app = apps[0];
  else if (!apps.length) return fail([`Your account (${label}) has no apps yet. In your app's folder: ${CMD} init or ${CMD} connect`]);
  else {
    say(o, `  Your account (${label}) has ${apps.length} apps. Pick one with ${c.cyan(`${CMD} stats --app <id>`)}:`);
    listApps(o, apps);
    say(o);
    return 1;
  }
  if (!app.id) return fail([`${host} did not give an id for ${clean(app.name, 80)}.`]);
  return show(o, { id: app.id, token: creds.access_token }, clean(app.name, 80) || "this app");
}

/** Entry from bin/genclass-runtime.mjs. Returns the exit code. */
export async function run(_cmd, argv) {
  const h = hostConfig();
  if (h.error) {
    err(`genclass-runtime stats: ${h.error}`);
    return 2;
  }
  let o;
  try {
    o = parse(argv, SPEC);
    if (o.range !== undefined && !RANGES[o.range]) throw new UsageError(`--range must be 24h or 7d (the dashboard has the longer ranges)`);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`genclass-runtime stats: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (o.help) {
    out(USAGE);
    return 0;
  }
  return stats(o);
}

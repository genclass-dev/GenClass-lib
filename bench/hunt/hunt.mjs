#!/usr/bin/env node
// bench/hunt: GenClass's explore and replay loop against any web app already running at a URL, without changing its
// source (README.md next to this file). It builds nothing: it needs packages/runtime/dist and packages/mcp/dist.
//
//   node bench/hunt/hunt.mjs --url http://localhost:1337/admin --scenario scenarios/strapi-search.mjs --runs 6 --slow 600
//
// What one run does:
//   1. starts the GenClass MCP server in this process (its bridge on a free loopback port) and Chromium;
//   2. for each scenario: genclass_explore start (2 baselines + N seeded orders), then one fresh browser context per
//      planned load: the runtime put on the page by an init script (lib/inject.mjs), the agent link connected to the
//      bridge, the page's first quiet point, the scenario's steps, whenSettled, the scenario's oracle; then
//      genclass_explore report, and for every race finding genclass_explain (the generated Playwright test is saved),
//      genclass_replay arm, the scenario once more, genclass_replay result, and the generated test run against the app;
//   3. writes <out>/report.json and <out>/report.md.
// The harness orchestrates and records; it decides nothing about the app. Every verdict in the report is GenClass's,
// kept verbatim and counted from its structured report, except the DOM-oracle comparison and the per-load
// observations (a page that ended elsewhere, steps that could not be done), which are labelled as the harness's own.
// Rule 1 holds: observe never holds or changes anything, and the schedules only move when a response reaches the app
// (AGENT.md section 9).

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { USAGE, paramsOf, parseArgs } from "./lib/args.mjs";
import { VIRTUAL, injectGenClass, pageConfig } from "./lib/inject.mjs";
import { startMcp } from "./lib/mcp.mjs";
import { compareOracles, renderMarkdown } from "./lib/report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
/** Other (non-race) findings explained in full, with their generated test; the rest are listed with their evidence. */
const OTHERS_IN_FULL = 3;
/** The order other findings are listed in: errors and duplicate requests before witnesses of overwrites. */
const OTHER_RANK = { error: 0, "duplicate-request": 1, "stale-write": 2, detection: 3, check: 4, expectation: 5, intervention: 6 };
/** The store keeps a finding's latest 20 runs (packages/mcp/src/store.ts). */
const FINDING_RUNS_KEPT = 20;
/** The bridge caps an explore's extra latency (packages/mcp/src/api.ts explore.start). */
const SLOW_MAX = 5000;
/** Parameter names whose values never reach a report (and JSON parameters' keys, such as a fill's selectors). */
const SECRETISH = /pass|pwd|secret|token|key|credential|otp|e-?mail|user|login|auth|session|cookie|card|cvv|iban|ssn/i;
const rtDist = resolve(repo, "packages/runtime/dist");
const mcpDist = resolve(repo, "packages/mcp/dist");
const HARNESS_VERSION = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version;

const { options: args, errors } = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.render) {
  // report.md again from a saved report.json (after a change to the template)
  const file = resolve(process.cwd(), args.render);
  writeFileSync(join(dirname(file), "report.md"), renderMarkdown(JSON.parse(readFileSync(file, "utf8"))));
  console.log(`report: ${join(dirname(file), "report.md")}`);
  process.exit(0);
}
if (!args.url) errors.push("--url is required");
if (!args.scenario.length) errors.push("--scenario is required (at least one)");
if (args.expect !== undefined && args.expect !== "race" && args.expect !== "no-race") errors.push("--expect takes race or no-race");
if (errors.length) {
  console.error(errors.map((e) => `error: ${e}`).join("\n"));
  console.error(`\n${USAGE}`);
  process.exit(1);
}
for (const [dir, files, build] of [
  [rtDist, ["genclass.global.min.js", "agent.js"], "npm run build -w @genclass/runtime"],
  [mcpDist, ["index.js"], "npm run build -w @genclass/mcp"],
]) {
  const missing = files.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) {
    console.error(`error: ${dir} is missing ${missing.join(", ")}. This harness builds nothing: run \`${build}\` first.`);
    process.exit(1);
  }
}

// ----------------------------------------------------------------------------------------------- settings
const log = (s) => console.error(`[hunt] ${s}`);
const runs = Math.max(1, Math.min(50, Math.round(args.runs ?? 6)));
const slow = Math.max(0, Math.min(SLOW_MAX, Math.round(args.slow ?? 600)));
if ((args.slow ?? 0) > SLOW_MAX) log(`--slow ${args.slow}: the bridge caps the extra latency at ${SLOW_MAX} ms; using ${SLOW_MAX}`);
const seed = Math.max(0, Math.round(args.seed ?? 1));
const timeout = Math.max(1000, Math.round(args.timeout ?? 30_000));
const headless = !args.headful;
const viewport = (() => {
  const m = /^(\d+)x(\d+)$/.exec(args.viewport ?? "1280x800");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 800 };
})();
const serviceWorkers = args.allowServiceWorkers ? "allow" : "block";
const params = paramsOf(args.param);
// parameters as the report shows them: a value under a secret-looking name, or under a secret-looking key of a JSON
// parameter (a fill's selector), never reaches report.json or report.md
const shownParams = Object.fromEntries(
  Object.entries(params).map(([k, v]) => {
    if (SECRETISH.test(k)) return [k, "[redacted]"];
    try {
      const j = JSON.parse(v);
      if (j && typeof j === "object" && !Array.isArray(j)) return [k, JSON.stringify(Object.fromEntries(Object.entries(j).map(([a, b]) => [a, SECRETISH.test(a) ? "[redacted]" : b])))];
    } catch {
      /* not JSON */
    }
    return [k, v];
  }),
);
const appUrl = new URL(args.url);
const appOrigin = appUrl.origin;
const devHost = (h) => h === "localhost" || h === "::1" || h.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
const anyHost = !devHost(appUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase());
const runTests = !args.noRunTests;
const modelDir = args.modelDir ? resolve(args.modelDir) : null;
const modelOn = !!args.model || !!modelDir;
const config = pageConfig({ model: modelOn, modelDir });
const injectOpts = { dist: rtDist, anyHost, holdProtected: !!args.holdProtected, config, model: modelOn, modelDir };

// ----------------------------------------------------------------------------------------------- scenarios
/** A module given on the command line: relative to the working directory, else to bench/hunt (so `scenarios/x.mjs` works from the repository root). */
function moduleFile(spec, what) {
  const file = resolve(process.cwd(), spec);
  const alt = resolve(here, spec);
  const path = existsSync(file) ? file : existsSync(alt) ? alt : null;
  if (!path) throw new Error(`${what} not found: ${spec} (looked in ${process.cwd()} and ${here})`);
  return path;
}
async function loadScenario(spec) {
  const path = moduleFile(spec, "scenario");
  const m = await import(pathToFileURL(path).href);
  const s = m.default && typeof m.default === "object" ? { ...m.default, ...m } : { ...m };
  if (typeof s.steps !== "function") throw new Error(`${spec} must export steps(page, ctx)`);
  const name = String(s.name ?? spec.replace(/^.*[\\/]/, "").replace(/\.m?js$/, ""));
  return { name, file: relative(repo, path), steps: s.steps, oracle: typeof s.oracle === "function" ? s.oracle : null, url: s.url, route: s.route, settleMs: Math.max(50, Math.round(args.settle ?? s.settleMs ?? 400)), settleBeforeSteps: s.settleBeforeSteps !== false };
}
const scenarios = [];
for (const spec of args.scenario) scenarios.push(await loadScenario(spec));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "hunt";
const out = resolve(process.cwd(), args.out ?? join(here, "results", slug(scenarios[0].name)));
mkdirSync(out, { recursive: true });
const testsDir = join(out, "tests");

function pageUrlOf(sc) {
  if (!sc.url) return appUrl.href;
  return new URL(sc.url, appUrl.href).href;
}

// ----------------------------------------------------------------------------------------------- versions
function git(...a) {
  try {
    return execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
const commit = git("rev-parse", "--short=12", "HEAD") || "unknown";
// uncommitted changes in what ran: the packages' sources (dist/ is built from the checkout, which is not checked), and
// the harness itself (its results directory aside)
const dirty = git("status", "--porcelain", "--", "packages/runtime/src", "packages/mcp/src") !== "";
const harnessDirty = git("status", "--porcelain", "--", "bench/hunt", ":(exclude)bench/hunt/results") !== "";
const version = (p) => JSON.parse(readFileSync(join(repo, p, "package.json"), "utf8")).version;

// ----------------------------------------------------------------------------------------------- start
const started = new Date();
const mcpMod = await import(pathToFileURL(join(mcpDist, "index.js")).href);
const mcp = await startMcp(mcpMod, { cwd: out, port: args.port ?? 0, stderr: process.stderr, env: anyHost ? { GENCLASS_AGENT_ORIGINS: appOrigin } : {} });
log(`bridge ${mcp.url}${anyHost ? ` (origin ${appOrigin} allowed; the page gets anyHost)` : ""}`);
const browser = await chromium.launch({ headless, ...(args.chromium ? { executablePath: args.chromium } : {}) });
log(`chromium ${browser.version()} ${headless ? "headless" : "headful"}`);
const contextOptions = () => ({ bypassCSP: true, serviceWorkers, ignoreHTTPSErrors: true, viewport, ...(storageState ? { storageState } : {}) });

// login once, without GenClass on the page (nothing to record there), into a storage state every load reuses; by
// default under bench/hunt/.storage/, which git ignores
let storageState = args.storageState ? resolve(process.cwd(), args.storageState) : null;
try {
  if (args.login) {
    const m = await import(pathToFileURL(moduleFile(args.login, "login module")).href);
    const login = m.login ?? m.default?.login ?? m.default;
    if (typeof login !== "function") throw new Error(`${args.login} must export login(page, ctx)`);
    storageState ??= join(here, ".storage", `${slug(scenarios[0].name)}.json`);
    mkdirSync(dirname(storageState), { recursive: true });
    const ctx = await browser.newContext({ bypassCSP: true, serviceWorkers, ignoreHTTPSErrors: true, viewport });
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeout);
    log(`login: ${args.login}`);
    try {
      await login(page, { params, url: appUrl.href, log });
      await ctx.storageState({ path: storageState });
      log(`storage state saved to ${storageState} (a session: keep it out of git)`);
    } finally {
      await ctx.close();
    }
  } else if (storageState && !existsSync(storageState)) throw new Error(`--storage-state ${storageState} does not exist (pass --login to create it)`);
} catch (e) {
  console.error(`error: ${e.message}`);
  await browser.close().catch(() => undefined);
  await mcp.close().catch(() => undefined);
  process.exit(1);
}

// ----------------------------------------------------------------------------------------------- one page load
/** A Playwright error that means the page navigated under us (the evaluation's document is gone). */
const navigatedAway = (e) => /context was destroyed|because of a navigation|Target page, context or browser has been closed|frame was detached/i.test(String(e?.message ?? e));

async function loadOnce(sc, url, phase, index) {
  const t0 = Date.now();
  const rec = { index, phase, url, run: null, runs: [], schedule: null, connected: false, settled: null, error: null, console: [], consoleErrors: [], pageErrors: [], t: {}, hunt: null, snapshot: null };
  const ctx = await browser.newContext(contextOptions());
  let page = null;
  const runIds = new Set();
  // the agent on the page's current document: connected, or a reason it will not be
  const connectedNow = () => page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true || window.__GENCLASS_HUNT__?.reason || window.__GENCLASS_HUNT__?.error, null, { timeout });
  const noteRun = async () => {
    const id = await page.evaluate(() => window.__GENCLASS_AGENT__?.run ?? null).catch(() => null);
    if (id) runIds.add(id);
    return id;
  };
  // the next quiet point of the current document; a step that navigates to another document is followed there (a new
  // page load, a new run: the bridge may have given it an explore slot, so set --route to the page under test)
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      try {
        await connectedNow();
        await noteRun();
        return await page.evaluate((ms) => (window.__GENCLASS_AGENT__ ? window.__GENCLASS_AGENT__.whenSettled(ms) : false), timeout);
      } catch (e) {
        if (!navigatedAway(e)) throw e;
        rec.navigated = true;
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      }
    }
    return false;
  };
  try {
    const injLog = await injectGenClass(ctx, { ...injectOpts, agentUrl: mcp.url, settleMs: sc.settleMs, onLog: log });
    page = await ctx.newPage();
    page.setDefaultTimeout(timeout);
    page.on("console", (m) => {
      const text = m.text();
      // GenClass's own messages, and the page's console errors from any source (a hydration mismatch shows only there)
      if (/genclass/i.test(text)) {
        if (rec.console.length < 50) rec.console.push({ type: m.type(), text: text.slice(0, 500) });
      } else if (m.type() === "error" && rec.consoleErrors.length < 20) rec.consoleErrors.push(text.slice(0, 300));
    });
    page.on("pageerror", (e) => rec.pageErrors.length < 50 && rec.pageErrors.push(String(e.message ?? e).slice(0, 500)));
    await page.goto(url, { timeout });
    rec.t.goto = Date.now() - t0;
    await connectedNow();
    const h = await page.evaluate(() => ({ ...window.__GENCLASS_HUNT__, connected: window.__GENCLASS_AGENT__?.connected === true }));
    rec.hunt = { injected: h.injected, reason: h.reason, error: h.error, completedBeforeConnect: 0, routed: injLog.routed };
    if (!h.connected) throw new Error(`GenClass did not connect to the bridge: ${h.reason ?? h.error ?? "no hello"}`);
    rec.t.connected = Date.now() - t0;
    rec.connected = true;
    // the page under test is this first document: its run holds the steps and is the one the explore armed (a step that
    // navigates leaves it for another document, recorded as finalRun)
    const first = await page.evaluate(() => ({ run: window.__GENCLASS_AGENT__.run, schedule: window.__GENCLASS_AGENT__.schedule }));
    rec.run = first.run;
    rec.schedule = first.schedule;
    if (first.run) runIds.add(first.run);
    // the steps start from the page's first quiet point, as the generated regression test does (testgen.ts): actions
    // that race the page's own loading record differently from load to load (a label that a load response changes
    // splits a typing burst), and GenClass compares only loads whose recorded actions match
    if (sc.settleBeforeSteps !== false) {
      rec.readyBeforeSteps = await settle();
      rec.t.ready = Date.now() - t0;
    }
    rec.routeBeforeSteps = await page.evaluate(() => location.pathname).catch(() => null);
    const sctx = { params, url, log, phase };
    try {
      await sc.steps(page, sctx);
    } catch (e) {
      // the steps could not be done (an element never appeared): the load still counts, and what the page showed
      // instead is the most useful thing to record
      rec.stepsError = String(e?.message ?? e).split("\n")[0].slice(0, 300);
    }
    rec.t.steps = Date.now() - t0;
    rec.settled = await settle();
    rec.t.settled = Date.now() - t0;
    if (sc.oracle)
      try {
        rec.oracle = await sc.oracle(page, sctx);
      } catch (e) {
        rec.oracleError = String(e?.message ?? e).split("\n")[0].slice(0, 300);
      }
    if (rec.stepsError) rec.pageText = await page.evaluate(() => document.body.innerText.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 60)).catch(() => []);
    const st = await page.evaluate(() => {
      const a = window.__GENCLASS_AGENT__;
      const s = a.snapshot();
      const r = a.recorded();
      // steps are timed from connectAgent: a request sent before it has a negative time; one that also has no
      // delivery or end step completed before the agent link could schedule it
      const later = new Set(r.steps.filter((x) => x.k === "recv" || x.k === "end").map((x) => x.key));
      return {
        run: a.run,
        schedule: a.schedule,
        settled: a.settled,
        route: location.pathname,
        // the final document's snapshot (the first one's, unless a step navigated away)
        snapshot: { stateFields: Object.keys(s.state).length, statePaths: Object.keys(s.state).slice(0, 12), textLines: s.text?.length ?? 0, fields: Object.keys(s.fields ?? {}).length, requests: s.requests, witnesses: s.witnesses, errors: s.errors, forced: s.forced },
        actions: r.steps.filter((x) => x.k === "act").length,
        completedBeforeConnect: r.steps.filter((x) => x.k === "send" && x.t < 0 && !later.has(x.key)).length,
      };
    });
    if (st.run) runIds.add(st.run);
    if (st.run && st.run !== rec.run) {
      rec.finalRun = st.run;
      rec.finalSchedule = st.schedule;
    }
    rec.route = st.route;
    // a page that ended somewhere else than asked: a login redirect (a stale storage state), an error or permission
    // page, a client-side redirect. Recorded as seen, never interpreted
    const norm = (p) => String(p ?? "").replace(/\/+$/, "") || "/";
    const asked = norm(new URL(url).pathname);
    if (rec.routeBeforeSteps && norm(rec.routeBeforeSteps) !== asked) rec.landedOn = rec.routeBeforeSteps;
    if (norm(st.route) !== asked) rec.endedOn = st.route;
    rec.snapshot = st.snapshot;
    rec.actions = st.actions;
    rec.hunt.completedBeforeConnect = st.completedBeforeConnect;
    // files the page asked for under the virtual path that dist/ does not have (a harness problem when not empty)
    rec.hunt.missing = injLog.missing.slice(0, 10);
  } catch (e) {
    rec.error = String(e?.message ?? e).split("\n")[0].slice(0, 400);
    log(`load ${rec.index + 1} (${phase}): ${rec.error}`);
  } finally {
    rec.runs = [...runIds];
    // the last batch (the snapshot, or what an interrupted load recorded) reaches the bridge before the page goes away
    if (page) await page.waitForTimeout(500).catch(() => undefined);
    await ctx.close().catch(() => undefined);
  }
  rec.t.total = Date.now() - t0;
  return rec;
}

// ----------------------------------------------------------------------------------------------- GenClass's verdict
/** packages/mcp/src/compare.ts endedDifferently: the run ended in another state (not only a witness along the way). */
const endedDifferently = (d) => d.fields.length > 0 || d.textOnlyBaseline.length > 0 || d.textOnlyRun.length > 0 || d.errors.length > 0;

/**
 * How the schedule delivered a run's responses: `late` counts responses delivered after the response to a request
 * sent later (an older answer landing after a newer one). A seeded order with no late response reordered nothing.
 */
function reorderOf(run) {
  if (!run) return null;
  const sent = new Map();
  for (const s of run.steps) if (s.k === "send" && !sent.has(s.key)) sent.set(s.key, sent.size);
  let max = -1;
  let late = 0;
  let delivered = 0;
  for (const k of run.order) {
    const i = sent.get(k);
    if (i === undefined) continue;
    delivered++;
    if (i < max) late++;
    else max = i;
  }
  return { delivered, late };
}

/**
 * GenClass's verdict, counted from the structured explore report (the data genclass_explore report renders as text).
 * Runs are compared only inside a group (the same route and the same recorded user actions) that holds the two
 * baselines; a seeded load GenClass grouped apart, or that never reached a quiet point after its steps, is counted as
 * not compared, so "no race" always says how many orders it rests on. "no race" also needs at least one compared
 * order that delivered a response out of request order: with nothing reordered, nothing was tested.
 */
function verdictOf(rep, loads, session) {
  const findingIds = (rep?.findings ?? []).map((f) => f.id);
  const groups = rep?.groups ?? [];
  const judged = groups.filter((g) => !g.missingBaseline && !g.insufficientBaselines);
  const judgedKeys = new Set(judged.map((g) => `${g.route}\n${g.scenario}`));
  let compared = 0;
  let ended = 0;
  let along = 0;
  for (const g of judged) {
    compared += g.runs - g.baselines.length;
    for (const d of g.diffs) endedDifferently(d) ? ended++ : along++;
  }
  const explored = loads.filter((l) => l.phase === "explore");
  const armed = explored.filter((l) => l.schedule?.id === session);
  const seededLoads = armed.filter((l) => l.schedule?.order === "seeded");
  // the seeded loads GenClass compared, and how many of them reordered anything
  let reordered = 0;
  for (const l of seededLoads) {
    const run = l.run ? mcp.store.runs.get(l.run) : undefined;
    if (!run || !judgedKeys.has(`${run.page.route}\n${mcpMod.scenarioOf(run)}`)) continue;
    l.reorder = reorderOf(run);
    if (l.reorder?.late) reordered++;
  }
  for (const l of armed) if (!l.reorder && l.run) l.reorder = reorderOf(mcp.store.runs.get(l.run));
  const out = { compared, notCompared: Math.max(0, seededLoads.length - compared), seeded: seededLoads.length, armed: armed.length, reordered, groups: groups.length, findingIds };
  if (ended || along) return { kind: "race", ended, along, of: compared, ...out };
  let reason;
  const baseFailed = armed.filter((l) => l.schedule?.order === "fifo" && (l.stepsError || l.error));
  if (explored.length && explored.every((l) => l.error)) reason = `every page load failed (first: ${explored[0].error})`;
  else if (!armed.length) reason = "no page load was armed by the explore session (its path did not match --route, or another page took the slots)";
  else if (baseFailed.length) reason = `the steps could not be done on baseline load ${baseFailed[0].index + 1} (${baseFailed[0].stepsError ?? baseFailed[0].error}), so there is no baseline to compare with`;
  else if (compared && !reordered) reason = `none of the ${compared} compared orders delivered a response after the answer to a later request: nothing was reordered, so nothing was tested (no two requests over fetch or XHR overlapped)`;
  else if (compared) return { kind: "no-race", of: compared, ...out };
  else if (!groups.length) reason = "no load reached a quiet point after its steps";
  else if (judged.length) reason = `none of the ${seededLoads.length} seeded loads recorded the same user actions as the baselines (GenClass grouped them apart), so nothing was compared`;
  else if (groups.some((g) => g.insufficientBaselines)) reason = "only one baseline load in the group (another page load took the other baseline slot: set --route)";
  else reason = "no group holds the baseline loads (their steps recorded different actions, or they never reached a quiet point)";
  return { kind: "no-verdict", reason, ...out };
}

function parsePlan(text) {
  return [...text.matchAll(/^\s+\d+\. (.+)$/gm)].map((m) => m[1]);
}

// ----------------------------------------------------------------------------------------------- the generated test
const playwrightBin = join(repo, "node_modules", ".bin", "playwright");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The playwright.config.mjs next to the generated tests: the same browser settings and injection as the loads. */
function writeTestConfig(sc) {
  const opts = { anyHost, holdProtected: !!args.holdProtected, config, model: modelOn, modelDir, settleMs: sc.settleMs };
  const use = { headless: true, bypassCSP: true, ignoreHTTPSErrors: true, serviceWorkers, viewport, ...(args.chromium ? { launchOptions: { executablePath: args.chromium } } : {}) };
  writeFileSync(
    join(testsDir, "playwright.config.mjs"),
    [
      "// Written by bench/hunt: runs the generated regression tests with the harness's injection (fixture.mjs) and the",
      "// browser settings of the hunt's page loads. GENCLASS_APP_URL is the app's origin; GENCLASS_HUNT_STORAGE a login's",
      "// storage state.",
      `process.env.GENCLASS_HUNT_OPTS ??= ${JSON.stringify(JSON.stringify(opts))};`,
      `const use = ${JSON.stringify(use)};`,
      "export default { testDir: \".\", testMatch: /\\.hunt\\.spec\\.mts$/, timeout: 60000, workers: 1, reporter: \"line\", use: { ...use, storageState: process.env.GENCLASS_HUNT_STORAGE || undefined } };",
      "",
    ].join("\n"),
  );
}

/** Run one generated test against the app; its result as Playwright's JSON reporter gives it. */
function runGeneratedTest(file) {
  return new Promise((done) => {
    const env = { ...process.env, GENCLASS_APP_URL: appOrigin, GENCLASS_HUNT_DIST: rtDist, ...(storageState ? { GENCLASS_HUNT_STORAGE: storageState } : {}) };
    const cmd = existsSync(playwrightBin) ? playwrightBin : "npx";
    // the file filter is a regular expression over the path: the file's own name, escaped
    const argv = [...(cmd === "npx" ? ["playwright"] : []), "test", "--config", join(testsDir, "playwright.config.mjs"), "--reporter=json", `${escapeRe(basename(file))}$`];
    const p = spawn(cmd, argv, { cwd: testsDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const killer = setTimeout(() => p.kill("SIGKILL"), 180_000);
    p.on("close", (code) => {
      clearTimeout(killer);
      const strip = (s) => String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
      let report = null;
      try {
        report = JSON.parse(stdout);
      } catch {
        /* not JSON: Playwright did not get as far as running a test */
      }
      const results = [];
      const walk = (suite) => {
        for (const s of suite?.suites ?? []) walk(s);
        for (const spec of suite?.specs ?? []) for (const t of spec.tests ?? []) results.push(...(t.results ?? []));
      };
      for (const s of report?.suites ?? []) walk(s);
      const r = results[results.length - 1];
      const error = r?.errors?.[0]?.message ?? r?.error?.message ?? report?.errors?.[0]?.message ?? "";
      const status = !report ? `error (exit ${code})` : !r ? "did not run" : r.status === "passed" ? "passed" : r.status === "failed" ? "failed" : r.status;
      done({ status, firstError: strip(error).split("\n").find((l) => l.trim()) ?? "", output: strip(error || stderr).trim().split("\n").slice(0, 30).join("\n") });
    });
    p.on("error", (e) => done({ status: `error (${e.message})`, firstError: "", output: "" }));
  });
}

// ----------------------------------------------------------------------------------------------- one scenario
async function huntScenario(sc) {
  const t0 = Date.now();
  const url = pageUrlOf(sc);
  const route = args.route ?? (sc.route === undefined || sc.route === null ? undefined : String(sc.route));
  const S = { name: sc.name, file: sc.file, url, route: route ?? null, params: shownParams, settleMs: sc.settleMs, explore: null, loads: [], findings: [], otherFindings: [], oracle: null, discovered: { fields: 0, examples: [] }, timings: {}, error: null };
  log(`scenario ${sc.name}: ${url}`);
  try {
    const start = await mcp.tool("genclass_explore", { action: "start", runs, slow_ms: slow || undefined, seed, ...(args.focus.length ? { focus: args.focus } : {}), ...(route ? { route } : {}) });
    if (start.isError) throw new Error(start.text);
    const session = /Explore (x\d+) armed/.exec(start.text)?.[1];
    const plan = parsePlan(start.text);
    S.explore = { session, plan, startText: start.text, reportText: null, verdict: null, groups: [], scenario: null };
    for (let i = 0; i < plan.length; i++) {
      const l = await loadOnce(sc, url, "explore", S.loads.length);
      S.loads.push(l);
      log(`load ${i + 1}/${plan.length}: ${l.error ? `error ${l.error}` : `${l.schedule?.label ?? "no schedule assigned"} · run ${l.run} · ${l.settled ? "quiet" : "not quiet"} · ${l.snapshot?.stateFields ?? 0} state fields, ${l.snapshot?.textLines ?? 0} text lines${l.stepsError ? ` · steps failed: ${l.stepsError}` : ""}${l.landedOn ? ` · was on ${l.landedOn} before the steps` : l.endedOn ? ` · ended on ${l.endedOn}` : ""}${l.navigated ? " · navigated" : ""}`}`);
      if (i < 2 && l.landedOn) log(`WARNING: baseline ${i + 1} was on ${l.landedOn} before its steps, not on ${new URL(url).pathname}. If that is a login page, the storage state is stale: pass --login.`);
    }
    const report = await mcp.tool("genclass_explore", { action: "report", id: session });
    S.explore.reportText = report.text;
    // the same session reported again through the API: reportExplore is idempotent for runs already counted
    const structured = await mcp.api("explore.report", { id: session });
    S.explore.groups = (structured?.groups ?? []).map((g) => ({ route: g.route, scenario: g.scenario, baselines: g.baselines, runs: g.runs, noise: g.noise, diffs: g.diffs, missingBaseline: g.missingBaseline, insufficientBaselines: g.insufficientBaselines, unfiltered: g.unfiltered?.length ?? 0 }));
    S.explore.verdict = verdictOf(structured, S.loads, session);
    const withBaselines = S.explore.groups.find((g) => g.baselines.length >= 2) ?? S.explore.groups[0];
    S.explore.scenario = withBaselines?.scenario ?? null;
    const v = S.explore.verdict;
    log(`verdict: ${v.kind}${v.kind === "no-verdict" ? ` (${v.reason})` : ` on ${v.compared} compared order(s), ${v.reordered} of them reordered`}${v.notCompared ? `, ${v.notCompared} seeded load(s) not compared` : ""}${v.findingIds.length ? ` (${v.findingIds.join(", ")})` : ""}`);
    const explored = S.loads.filter((l) => l.phase === "explore");
    if (explored.length && explored.every((l) => l.error)) throw new Error(`every page load failed (first: ${explored[0].error})`);

    for (const id of v.findingIds) {
      const F = { id, kind: "race", title: "", explainText: "", testFile: null, huntTestFile: null, replay: null, testRun: null };
      F.explainText = (await mcp.tool("genclass_explain", { id })).text;
      const detail = await mcp.api("finding", { id });
      F.kind = detail?.finding?.kind ?? "race";
      F.title = detail?.finding?.title ?? "";
      if (detail?.test) {
        mkdirSync(testsDir, { recursive: true });
        const base = `${slug(sc.name)}-${id}`;
        F.testFile = relative(out, join(testsDir, `${base}.spec.ts`));
        writeFileSync(join(testsDir, `${base}.spec.ts`), detail.test);
        // the same test with the harness's injection, for an app that does not include GenClass itself (an .mts file:
        // ESM whatever the nearest package.json says, so it can import the fixture)
        const fixturePath = join(here, "fixture.mjs");
        const rel = relative(testsDir, fixturePath).split("\\").join("/");
        const fixture = testsDir.startsWith(repo) ? (rel.startsWith(".") ? rel : `./${rel}`) : fixturePath;
        F.huntTestFile = relative(out, join(testsDir, `${base}.hunt.spec.mts`));
        writeFileSync(join(testsDir, `${base}.hunt.spec.mts`), detail.test.replace(`import { test, expect } from "@playwright/test";`, `import { test, expect } from ${JSON.stringify(fixture)};`));
        writeTestConfig(sc);
      }
      const arm = await mcp.tool("genclass_replay", { action: "arm", id });
      if (arm.isError) F.replay = { verdict: "not armed", note: arm.text, text: arm.text };
      else {
        const l = await loadOnce(sc, url, `replay ${id}`, S.loads.length);
        S.loads.push(l);
        // a replay load that never said hello leaves its arm behind: the next load of that route would take it
        mcp.store.replays = mcp.store.replays.filter((r) => r.finding !== id);
        const res = await mcp.tool("genclass_replay", { action: "result", id });
        const r = await mcp.api("replay.result", { id });
        const last = r?.results?.[r.results.length - 1];
        F.replay = { verdict: !last ? "no replay run" : last.reproduced === true ? "REPRODUCED" : last.reproduced === false ? "not reproduced" : "inconclusive", note: last?.note ?? "", scenarioMatches: last?.scenarioMatches ?? null, run: last?.run ?? null, text: res.text };
        log(`replay ${id}: ${F.replay.verdict}`);
      }
      if (runTests && F.huntTestFile) {
        log(`running the generated test ${F.huntTestFile}`);
        F.testRun = await runGeneratedTest(join(out, F.huntTestFile));
        log(`generated test: ${F.testRun.status}${F.testRun.firstError ? ` (${F.testRun.firstError.slice(0, 120)})` : ""}`);
      }
      S.findings.push(F);
    }
    // what else GenClass recorded on this scenario's loads (an uncaught error, a duplicate request from two clicks, a
    // stale write): not from the order comparison, so no replay here. Every one is listed with its evidence (read from
    // the in-process store, so no tool's list limit applies); the first OTHERS_IN_FULL, errors and duplicates first,
    // get genclass_explain's full text and their generated test. Every run a load registered counts, the runs of
    // loads that failed or navigated included
    const mine = new Set(S.loads.flatMap((l) => l.runs ?? []));
    const num = (fid) => Number(String(fid).slice(1)) || 0;
    const others = [...mcp.store.findings.values()]
      .filter((f) => f.kind !== "race" && f.runs.some((r) => mine.has(r)))
      .map((f) => ({ f, n: f.runs.filter((r) => mine.has(r)).length }))
      .sort((a, b) => (OTHER_RANK[a.f.kind] ?? 9) - (OTHER_RANK[b.f.kind] ?? 9) || b.n - a.n || num(a.f.id) - num(b.f.id));
    for (const [i, { f, n }] of others.entries()) {
      const O = { id: f.id, kind: f.kind, title: f.title, count: f.count, runs: n, runsAtLeast: f.runs.length >= FINDING_RUNS_KEPT, evidence: f.evidence, explainText: null, testFile: null };
      if (i < OTHERS_IN_FULL) {
        O.explainText = (await mcp.tool("genclass_explain", { id: f.id })).text;
        const detail = await mcp.api("finding", { id: f.id });
        if (detail?.test) {
          mkdirSync(testsDir, { recursive: true });
          O.testFile = relative(out, join(testsDir, `${slug(sc.name)}-${f.id}.spec.ts`));
          writeFileSync(join(out, O.testFile), detail.test);
        }
      }
      S.otherFindings.push(O);
    }
    if (others.length) {
      const byKind = {};
      for (const { f } of others) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
      log(`other findings on these loads: ${Object.entries(byKind).map(([k, c]) => `${c} ${k}`).join(", ")}`);
    }
  } catch (e) {
    S.error = String(e?.message ?? e).slice(0, 500);
    log(`scenario ${sc.name} stopped: ${S.error}`);
  }
  S.oracle = compareOracles(S.loads);
  const withState = S.loads.filter((l) => l.snapshot);
  S.discovered.fields = Math.max(0, ...withState.map((l) => l.snapshot.stateFields));
  S.discovered.examples = withState.find((l) => l.snapshot.stateFields === S.discovered.fields)?.snapshot.statePaths.slice(0, 6) ?? [];
  S.timings.totalMs = Date.now() - t0;
  return S;
}

// ----------------------------------------------------------------------------------------------- run
const results = [];
let exitCode = 0;
try {
  for (const sc of scenarios) results.push(await huntScenario(sc));
} finally {
  await browser.close().catch(() => undefined);
  await mcp.close().catch(() => undefined);
}
const finished = new Date();
const report = {
  schema: "genclass-hunt/1",
  started: started.toISOString(),
  finished: finished.toISOString(),
  durationMs: finished - started,
  harness: { version: HARNESS_VERSION, commit, dirty: harnessDirty },
  app: { url: appUrl.href, origin: appOrigin, commit: args.appCommit ?? null },
  runtime: { version: version("packages/runtime"), commit, dirty },
  mcp: { version: version("packages/mcp"), commit, dirty },
  browser: { name: "chromium", version: browser.version(), headless, viewport: `${viewport.width}x${viewport.height}`, serviceWorkers },
  options: { runs, slow, seed, focus: args.focus, route: args.route ?? null, timeout, model: modelDir ? `served from ${modelDir}` : args.model ? "loaded from jsDelivr" : "skipped", holdProtected: !!args.holdProtected, storageState: !!storageState, runTests },
  injection: { virtualPath: modelOn ? VIRTUAL : null, how: `the runtime's script-tag build run inline from an init script as soon as the document has its root element, then removed; the agent link imported from a blob URL${modelOn ? `; ${VIRTUAL} routed for the model (the HTTP cache is off with routing)` : "; no request of the app routed"}`, config },
  node: process.version,
  scenarios: results,
  summary: {
    scenarios: results.length,
    races: results.filter((s) => s.explore?.verdict?.kind === "race").length,
    noRace: results.filter((s) => s.explore?.verdict?.kind === "no-race").length,
    noVerdict: results.filter((s) => !s.explore?.verdict || !["race", "no-race"].includes(s.explore.verdict.kind)).length,
    reproduced: results.reduce((n, s) => n + s.findings.filter((f) => f.replay?.verdict === "REPRODUCED").length, 0),
    findings: results.reduce((n, s) => n + s.findings.length, 0),
    otherFindings: results.reduce((n, s) => n + s.otherFindings.length, 0),
  },
};
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(join(out, "report.md"), renderMarkdown(report));
for (const s of results) {
  const v = s.explore?.verdict;
  const verdict = !v ? "no explore" : v.kind === "no-verdict" ? `no verdict (${v.reason})` : `${v.kind} on ${v.compared} compared order(s), ${v.reordered} reordered${v.notCompared ? `, ${v.notCompared} not compared` : ""}`;
  console.log(`${s.name}: ${verdict}${s.findings.length ? ` · ${s.findings.map((f) => `${f.id} replay ${f.replay?.verdict}${f.testRun ? `, test ${f.testRun.status}` : ""}`).join("; ")}` : ""}${s.otherFindings.length ? ` · ${s.otherFindings.length} other finding(s)` : ""} · oracle ${s.oracle?.status}${s.error ? ` · stopped: ${s.error}` : ""}`);
}
console.log(`report: ${join(out, "report.md")}`);
if (args.expect) {
  const unmet = results.filter((s) => s.explore?.verdict?.kind !== args.expect);
  if (unmet.length) {
    console.error(`expected ${args.expect} in every scenario; got ${unmet.map((s) => `${s.name}: ${s.explore?.verdict?.kind ?? "none"}`).join(", ")}`);
    exitCode = 2;
  }
}
if (results.some((s) => s.error)) exitCode = exitCode || 1;
process.exit(exitCode);

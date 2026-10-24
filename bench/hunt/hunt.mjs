#!/usr/bin/env node
// bench/hunt: GenClass's explore and replay loop against any web app already running at a URL, without changing its
// source (README.md next to this file). It builds nothing: it needs packages/runtime/dist and packages/mcp/dist.
//
//   node bench/hunt/hunt.mjs --url http://localhost:1337/admin --scenario scenarios/strapi-search.mjs --runs 6 --slow 600 --out results/strapi
//
// What one run does:
//   1. starts the GenClass MCP server in this process (its bridge on a free loopback port) and Chromium;
//   2. for each scenario: genclass_explore start (2 baselines + N seeded orders), then one fresh browser context per
//      planned load: the runtime's dist/ served on a virtual same-origin path, the script tag first in <head>, the
//      agent link connected to the bridge, the scenario's steps, whenSettled, the scenario's oracle; then
//      genclass_explore report, and for every race finding genclass_explain (the generated Playwright test is saved),
//      genclass_replay arm, the scenario once more, genclass_replay result, and the generated test run against the app;
//   3. writes <out>/report.json and <out>/report.md.
// The harness orchestrates and records; it decides nothing about the app. Every verdict in the report is GenClass's,
// kept verbatim, except the DOM-oracle comparison, which is labelled as the harness's own. Rule 1 holds: observe never
// holds or changes anything, and the schedules only move when a response reaches the app (AGENT.md section 9).

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { USAGE, paramsOf, parseArgs } from "./lib/args.mjs";
import { VIRTUAL, injectGenClass, pageConfig } from "./lib/inject.mjs";
import { startMcp } from "./lib/mcp.mjs";
import { compareOracles, renderMarkdown } from "./lib/report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
/** Other (non-race) findings whose explanation is kept in full; later ones are cut to OTHERS_CUT characters. */
const OTHERS_IN_FULL = 3;
const OTHERS_CUT = 4000;
const OTHERS_CUT_MARK = "[cut by the harness: genclass_explain {id} gives the whole text]";
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
  [rtDist, ["genclass.global.js", "agent.js"], "npm run build -w @genclass/runtime"],
  [mcpDist, ["index.js"], "npm run build -w @genclass/mcp"],
]) {
  const missing = files.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) {
    console.error(`error: ${dir} is missing ${missing.join(", ")}. This harness builds nothing: run \`${build}\` first.`);
    process.exit(1);
  }
}

// ----------------------------------------------------------------------------------------------- settings
const runs = Math.max(1, Math.min(50, Math.round(args.runs ?? 6)));
const slow = Math.max(0, Math.round(args.slow ?? 600));
const seed = Math.max(0, Math.round(args.seed ?? 1));
const timeout = Math.max(1000, Math.round(args.timeout ?? 30_000));
const headless = !args.headful;
const viewport = (() => {
  const m = /^(\d+)x(\d+)$/.exec(args.viewport ?? "1280x800");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 800 };
})();
const params = paramsOf(args.param);
// parameters as the report shows them: a value under a secret-looking name never reaches report.json or report.md
const shownParams = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, /pass|pwd|secret|token|key|credential|otp/i.test(k) ? "[redacted]" : v]));
const appUrl = new URL(args.url);
const appOrigin = appUrl.origin;
const devHost = (h) => h === "localhost" || h === "::1" || h.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
const anyHost = !devHost(appUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase());
const runTests = !args.noRunTests;
const modelDir = args.modelDir ? resolve(args.modelDir) : null;
const config = pageConfig({ model: !!args.model || !!modelDir, modelDir });
const injectOpts = { dist: rtDist, anyHost, holdProtected: !!args.holdProtected, config, modelDir, rewrite: !args.noRewrite };

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
  return { name, file: relative(repo, path), steps: s.steps, oracle: typeof s.oracle === "function" ? s.oracle : null, url: s.url, route: s.route, settleMs: Math.max(50, Math.round(args.settle ?? s.settleMs ?? 400)), configure: typeof s.configure === "function" ? s.configure : null };
}
const scenarios = [];
for (const spec of args.scenario) scenarios.push(await loadScenario(spec));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "hunt";
const out = resolve(process.cwd(), args.out ?? join(here, "results", slug(scenarios[0].name)));
mkdirSync(out, { recursive: true });
const testsDir = join(out, "tests");
const log = (s) => console.error(`[hunt] ${s}`);

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
const dirty = git("status", "--porcelain", "--", "packages/runtime/src", "packages/mcp/src") !== "";
const version = (p) => JSON.parse(readFileSync(join(repo, p, "package.json"), "utf8")).version;

// ----------------------------------------------------------------------------------------------- start
const started = new Date();
const mcpMod = await import(pathToFileURL(join(mcpDist, "index.js")).href);
const mcp = await startMcp(mcpMod, { cwd: out, port: args.port ?? 0, stderr: process.stderr, env: anyHost ? { GENCLASS_AGENT_ORIGINS: appOrigin } : {} });
log(`bridge ${mcp.url}${anyHost ? ` (origin ${appOrigin} allowed; the page gets anyHost)` : ""}`);
const browser = await chromium.launch({ headless, ...(args.chromium ? { executablePath: args.chromium } : {}) });
log(`chromium ${browser.version()} ${headless ? "headless" : "headful"}`);

// login once, without GenClass on the page (nothing to record there), into a storage state every load reuses
let storageState = args.storageState ? resolve(process.cwd(), args.storageState) : null;
try {
  if (args.login) {
    const m = await import(pathToFileURL(moduleFile(args.login, "login module")).href);
    const login = m.login ?? m.default?.login ?? m.default;
    if (typeof login !== "function") throw new Error(`${args.login} must export login(page, ctx)`);
    storageState ??= join(out, "storage-state.json");
    mkdirSync(dirname(storageState), { recursive: true });
    const ctx = await browser.newContext({ bypassCSP: true, ignoreHTTPSErrors: true, viewport });
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeout);
    log(`login: ${args.login}`);
    try {
      await login(page, { params, url: appUrl.href, log });
      await ctx.storageState({ path: storageState });
      log(`storage state saved to ${storageState} (cookies and local storage: keep it out of git)`);
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
async function loadOnce(sc, url, phase, index) {
  const t0 = Date.now();
  const rec = { index, phase, url, run: null, schedule: null, connected: false, settled: null, error: null, console: [], pageErrors: [], t: {}, hunt: null, snapshot: null };
  const ctx = await browser.newContext({ bypassCSP: true, serviceWorkers: "block", ignoreHTTPSErrors: true, viewport, ...(storageState ? { storageState } : {}) });
  try {
    const injLog = await injectGenClass(ctx, { ...injectOpts, agentUrl: mcp.url, settleMs: sc.settleMs, onLog: log });
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeout);
    page.on("console", (m) => {
      const text = m.text();
      if (/genclass/i.test(text) && rec.console.length < 50) rec.console.push({ type: m.type(), text: text.slice(0, 500) });
    });
    page.on("pageerror", (e) => rec.pageErrors.length < 50 && rec.pageErrors.push(String(e.message ?? e).slice(0, 500)));
    await page.goto(url, { timeout });
    rec.t.goto = Date.now() - t0;
    await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true || window.__GENCLASS_HUNT__?.reason || window.__GENCLASS_HUNT__?.error, null, { timeout });
    const h = await page.evaluate(() => ({ ...window.__GENCLASS_HUNT__, connect: undefined, connected: window.__GENCLASS_AGENT__?.connected === true }));
    rec.hunt = { injected: h.injected, reason: h.reason, error: h.error, rewritten: injLog.rewritten.length > 0, requestsBeforeConnect: 0 };
    if (!h.connected) throw new Error(`GenClass did not connect to the bridge: ${h.reason ?? h.error ?? "no hello"}${h.reason === "not-dev-host" ? " (the page is not on localhost; the harness passes anyHost for such URLs, so this should not happen)" : ""}`);
    rec.t.connected = Date.now() - t0;
    rec.connected = true;
    const sctx = { params, url, log, phase };
    try {
      await sc.steps(page, sctx);
    } catch (e) {
      // the steps could not be done (an element never appeared): the load still counts, and what the page showed
      // instead is the most useful thing to record
      rec.stepsError = String(e?.message ?? e).split("\n")[0].slice(0, 300);
    }
    rec.t.steps = Date.now() - t0;
    rec.settled = await page.evaluate((ms) => window.__GENCLASS_AGENT__.whenSettled(ms), timeout);
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
      const acts = r.steps.filter((x) => x.k === "act").length;
      return {
        run: a.run,
        schedule: a.schedule,
        settled: a.settled,
        route: location.pathname,
        snapshot: { stateFields: Object.keys(s.state).length, statePaths: Object.keys(s.state).slice(0, 12), textLines: s.text?.length ?? 0, fields: Object.keys(s.fields ?? {}).length, requests: s.requests, witnesses: s.witnesses, errors: s.errors, forced: s.forced },
        actions: acts,
        // steps are timed from connectAgent: a request that started before it has a negative time
        requestsBeforeConnect: r.steps.filter((x) => x.k === "send" && x.t < 0).length,
      };
    });
    rec.run = st.run;
    rec.schedule = st.schedule;
    rec.route = st.route;
    rec.snapshot = st.snapshot;
    rec.actions = st.actions;
    rec.hunt.requestsBeforeConnect = st.requestsBeforeConnect;
    await page.waitForTimeout(500); // the last batch (the snapshot) reaches the bridge before the page goes away
  } catch (e) {
    rec.error = String(e?.message ?? e).split("\n")[0].slice(0, 400);
    log(`load ${rec.index + 1} (${phase}): ${rec.error}`);
  } finally {
    await ctx.close().catch(() => undefined);
  }
  rec.t.total = Date.now() - t0;
  return rec;
}

// ----------------------------------------------------------------------------------------------- parsing the tools' text
function parseVerdict(text) {
  const ids = [...(/Race finding\(s\): ([^.]+)\./.exec(text)?.[1] ?? "").matchAll(/f\d+/g)].map((m) => m[0]);
  const race = /^RACE: (\d+) of (\d+) reordered run\(s\) ended in a different state than the baseline \(responses in request order\)(?:; (\d+) more ended right)?/m.exec(text);
  if (race) return { kind: "race", ended: Number(race[1]), of: Number(race[2]), along: Number(race[3] ?? 0), findingIds: ids };
  const along = /^RACE: no reordered run ended differently, but (\d+) of (\d+)/m.exec(text);
  if (along) return { kind: "race", ended: 0, of: Number(along[2]), along: Number(along[1]), findingIds: ids };
  const none = /^No race found: all (\d+) reordered run\(s\)/m.exec(text);
  if (none) return { kind: "no-race", of: Number(none[1]), findingIds: [] };
  if (/Only one baseline in this group/.test(text)) return { kind: "no-verdict", reason: "only one baseline run in the group (another page load took the other baseline slot)", findingIds: [] };
  if (/No baseline run in this group/.test(text)) return { kind: "no-verdict", reason: "no baseline run in the group", findingIds: [] };
  if (/No run reached a quiet point/.test(text)) return { kind: "no-runs", findingIds: [] };
  return { kind: "no-verdict", reason: "the report text matched no known verdict line", findingIds: ids };
}

function parsePlan(text) {
  return [...text.matchAll(/^\s+\d+\. (.+)$/gm)].map((m) => m[1]);
}

// ----------------------------------------------------------------------------------------------- the generated test
const playwrightBin = join(repo, "node_modules", ".bin", "playwright");
function runGeneratedTest(file) {
  return new Promise((done) => {
    const env = { ...process.env, GENCLASS_APP_URL: appOrigin, GENCLASS_HUNT_DIST: rtDist, GENCLASS_HUNT_OPTS: JSON.stringify({ anyHost, holdProtected: !!args.holdProtected, config, modelDir, rewrite: !args.noRewrite }), ...(storageState ? { GENCLASS_HUNT_STORAGE: storageState } : {}) };
    const cmd = existsSync(playwrightBin) ? playwrightBin : "npx";
    const argv = [...(cmd === "npx" ? ["playwright"] : []), "test", "--config", join(testsDir, "playwright.config.mjs"), file];
    const p = spawn(cmd, argv, { cwd: testsDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let outp = "";
    p.stdout.on("data", (d) => (outp += d));
    p.stderr.on("data", (d) => (outp += d));
    const killer = setTimeout(() => p.kill("SIGKILL"), 180_000);
    p.on("close", (status) => {
      clearTimeout(killer);
      done({ status: status === 0 ? "passed" : status === 1 ? "failed" : `error (exit ${status})`, output: outp.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-40).join("\n") });
    });
    p.on("error", (e) => done({ status: `error (${e.message})`, output: "" }));
  });
}

// ----------------------------------------------------------------------------------------------- one scenario
async function huntScenario(sc) {
  const t0 = Date.now();
  const url = pageUrlOf(sc);
  const route = args.route ?? (sc.route === undefined ? undefined : sc.route === null ? undefined : String(sc.route));
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
      log(`load ${i + 1}/${plan.length}: ${l.error ? `error ${l.error}` : `${l.schedule?.label ?? "no schedule assigned"} · run ${l.run} · ${l.settled ? "quiet" : "not quiet"} · ${l.snapshot?.stateFields ?? 0} state fields, ${l.snapshot?.textLines ?? 0} text lines`}`);
    }
    const report = await mcp.tool("genclass_explore", { action: "report", id: session });
    S.explore.reportText = report.text;
    S.explore.verdict = parseVerdict(report.text);
    const structured = await mcp.api("explore.report", { id: session });
    S.explore.groups = (structured?.groups ?? []).map((g) => ({ route: g.route, scenario: g.scenario, baselines: g.baselines, runs: g.runs, noise: g.noise, diffs: g.diffs, missingBaseline: g.missingBaseline, insufficientBaselines: g.insufficientBaselines }));
    S.explore.scenario = S.explore.groups[0]?.scenario ?? null;
    log(`verdict: ${S.explore.verdict.kind}${S.explore.verdict.findingIds.length ? ` (${S.explore.verdict.findingIds.join(", ")})` : ""}`);

    for (const id of S.explore.verdict.findingIds) {
      const F = { id, kind: "race", title: "", explainText: "", testFile: null, huntTestFile: null, replay: null, testRun: null };
      const explain = await mcp.tool("genclass_explain", { id });
      F.explainText = explain.text;
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
        writeFileSync(join(testsDir, "playwright.config.mjs"), `// Written by bench/hunt: runs the generated regression tests with the harness's injection (fixture.mjs).\nexport default { testDir: ".", testMatch: /\\.hunt\\.spec\\.mts$/, timeout: 60000, workers: 1, reporter: "line", use: { headless: true, bypassCSP: true, serviceWorkers: "block", storageState: process.env.GENCLASS_HUNT_STORAGE || undefined } };\n`);
      }
      const arm = await mcp.tool("genclass_replay", { action: "arm", id });
      if (arm.isError) F.replay = { verdict: "not armed", note: arm.text, text: arm.text };
      else {
        const l = await loadOnce(sc, url, `replay ${id}`, S.loads.length);
        S.loads.push(l);
        const res = await mcp.tool("genclass_replay", { action: "result", id });
        const r = await mcp.api("replay.result", { id });
        const last = r?.results?.[r.results.length - 1];
        F.replay = { verdict: !last ? "no replay run" : last.reproduced === true ? "REPRODUCED" : last.reproduced === false ? "not reproduced" : "inconclusive", note: last?.note ?? "", scenarioMatches: last?.scenarioMatches ?? null, run: last?.run ?? null, text: res.text };
        log(`replay ${id}: ${F.replay.verdict}`);
      }
      if (runTests && F.huntTestFile) {
        log(`running the generated test ${F.huntTestFile}`);
        F.testRun = await runGeneratedTest(join(out, F.huntTestFile));
        log(`generated test: ${F.testRun.status}`);
      }
      S.findings.push(F);
    }
    // what else GenClass recorded on this scenario's loads (a duplicate request from two clicks, a stale write, an
    // error): not from the order comparison, so no replay here; the explanation and its test are kept
    const mine = new Set(S.loads.map((l) => l.run).filter(Boolean));
    const list = (await mcp.api("findings", { limit: 50 })) ?? [];
    for (const item of list) {
      if (item.kind === "race") continue;
      const detail = await mcp.api("finding", { id: item.id });
      const f = detail?.finding;
      if (!f || !f.runs.some((r) => mine.has(r))) continue;
      const explain = await mcp.tool("genclass_explain", { id: f.id });
      // the first few explanations in full; the rest cut (each carries the whole step log, tens of kilobytes)
      const text = S.otherFindings.length < OTHERS_IN_FULL || explain.text.length <= OTHERS_CUT ? explain.text : `${explain.text.slice(0, OTHERS_CUT)}\n${OTHERS_CUT_MARK}`;
      const O = { id: f.id, kind: f.kind, title: f.title, count: f.count, runs: f.runs.filter((r) => mine.has(r)).length, explainText: text, testFile: null };
      if (detail.test) {
        mkdirSync(testsDir, { recursive: true });
        O.testFile = relative(out, join(testsDir, `${slug(sc.name)}-${f.id}.spec.ts`));
        writeFileSync(join(out, O.testFile), detail.test);
      }
      S.otherFindings.push(O);
    }
    if (S.otherFindings.length) log(`other findings on these loads: ${S.otherFindings.map((o) => `${o.id} ${o.kind}`).join(", ")}`);
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
  harness: { version: HARNESS_VERSION, commit },
  app: { url: appUrl.href, origin: appOrigin, commit: args.appCommit ?? null },
  runtime: { version: version("packages/runtime"), commit, dirty },
  mcp: { version: version("packages/mcp"), commit, dirty },
  browser: { name: "chromium", version: browser.version(), headless, viewport: `${viewport.width}x${viewport.height}` },
  options: { runs, slow, seed, focus: args.focus, route: args.route ?? null, timeout, model: modelDir ? `served from ${modelDir}` : args.model ? "loaded from jsDelivr" : "skipped", holdProtected: !!args.holdProtected, storageState: !!storageState, runTests, rewrite: !args.noRewrite },
  injection: { virtualPath: VIRTUAL, how: args.noRewrite ? "inline from the init script" : "script tag first in <head> of the rewritten document, inline from the init script when the document was not rewritten", config },
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
for (const s of results) console.log(`${s.name}: ${s.explore?.verdict ? s.explore.verdict.kind : "no explore"}${s.findings.length ? ` · ${s.findings.map((f) => `${f.id} replay ${f.replay?.verdict}${f.testRun ? `, test ${f.testRun.status}` : ""}`).join("; ")}` : ""}${s.otherFindings.length ? ` · other findings ${s.otherFindings.map((o) => `${o.id} ${o.kind}`).join(", ")}` : ""} · oracle ${s.oracle?.status}${s.error ? ` · stopped: ${s.error}` : ""}`);
console.log(`report: ${join(out, "report.md")}`);
if (args.expect) {
  const want = args.expect;
  const unmet = results.filter((s) => s.explore?.verdict?.kind !== want);
  if (unmet.length) {
    console.error(`expected ${want} in every scenario; got ${unmet.map((s) => `${s.name}: ${s.explore?.verdict?.kind ?? "none"}`).join(", ")}`);
    exitCode = 2;
  }
}
if (results.some((s) => s.error)) exitCode = exitCode || 1;
process.exit(exitCode);

// The end-to-end walkthrough (docs/evidence/e2e-walkthrough/README.md): a small shop full of problems gets GenClass
// the way a user adds it, step by step, with the real published packages, the real genclass.dev dashboard and the real
// MCP server; a browser plays the user and a coding agent's client plays the agent. Every command's output becomes a
// transcript and a terminal screenshot in out/, every page state a screenshot, and the browser session a video.
// Run from the repository root: node docs/evidence/e2e-walkthrough/walkthrough.mjs
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startMcp } from "./lib/mcp-client.mjs";
import { redact, renderTerminal, saveTranscript, stripAnsi } from "./lib/term.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "app");
const OUT = join(HERE, "out");
const SITE = "http://localhost:5173";
const AGENT_PORT = "47400"; // another GenClass MCP server owns the default 47357 on this machine
const MCP = "@genclass/mcp@0.1.0";
const RUNTIME = "@genclass/runtime@beta";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const summary = { started: new Date().toISOString(), steps: [] };
const errors = [];
let n = 0;
const num = () => String(++n).padStart(2, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const children = [];
const render = await chromium.launch(); // renders terminal windows; the recording browser is separate

/** Run a shell command in the app folder, save its transcript and terminal screenshot. */
async function sh(name, cmd, o = {}) {
  const id = `${num()}-${name}`;
  log(`\n$ ${cmd}`);
  const r = spawnSync("bash", ["-lc", cmd], { cwd: o.cwd ?? APP, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...(o.env ?? {}) }, encoding: "utf8", timeout: o.timeout ?? 300_000, maxBuffer: 64 * 1024 * 1024 });
  let out = redact(stripAnsi((r.stdout ?? "") + (r.stderr ?? "")));
  if (o.trim) out = o.trim(out);
  const shown = o.cwdLabel ?? "~/tiny-shop";
  saveTranscript(join(OUT, `${id}.txt`), { cwd: shown, cmd, out });
  await renderTerminal(render, join(OUT, `${id}.png`), { title: o.title ?? "Terminal", cwd: shown, cmd, out });
  summary.steps.push({ id, cmd, status: r.status });
  log(out.split("\n").slice(0, 12).join("\n") + (out.split("\n").length > 12 ? "\n  …" : ""));
  return out;
}
/** Save a tool call of the agent as a transcript and a screenshot, like a line in the agent's own log. */
async function agentShot(name, tool, args, res) {
  const id = `${num()}-${name}`;
  const cmd = `${tool} ${JSON.stringify(args)}`;
  const out = redact(res.text) + (res.isError ? "\n[isError]" : "");
  saveTranscript(join(OUT, `${id}.txt`), { cwd: "agent", cmd, out });
  await renderTerminal(render, join(OUT, `${id}.png`), { title: "Coding agent · MCP server genclass", cwd: "agent", cmd, out, kind: "tool call" });
  summary.steps.push({ id, cmd, isError: res.isError });
  log(`\n> ${cmd}\n${out.split("\n").slice(0, 14).join("\n")}${out.split("\n").length > 14 ? "\n  …" : ""}`);
  return out;
}
const shot = async (page, name) => {
  const id = `${num()}-${name}`;
  await page.screenshot({ path: join(OUT, `${id}.png`) });
  summary.steps.push({ id, screenshot: true });
};
const waitHttp = async (url, ms = 30_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`not up: ${url}`);
};
const step = async (title, fn) => {
  log(`\n\n===== ${title}`);
  try {
    await fn();
  } catch (e) {
    errors.push(`${title}: ${e.message}`);
    log(`!! ${title}: ${e.message}`);
  }
};

// ---------------------------------------------------------------------------------------------------- 0. the app
await step("0. A fresh checkout of the shop, without GenClass", async () => {
  copyFileSync(join(HERE, "steps", "00-main.before.js"), join(APP, "src", "main.js"));
  for (const f of ["src/genclass.config.js", ".genclass.local", ".mcp.json"]) rmSync(join(APP, f), { force: true });
  rmSync(join(APP, ".genclass"), { recursive: true, force: true });
  rmSync(join(APP, "tests"), { recursive: true, force: true });
  spawnSync("npm", ["uninstall", "@genclass/runtime", "--no-audit", "--no-fund"], { cwd: APP, encoding: "utf8" });
  await sh("tree", "ls -a && cat package.json && head -8 src/main.js", { title: "Terminal — the shop before GenClass" });
});

const api = spawn(process.execPath, ["api.mjs"], { cwd: APP, stdio: "ignore" });
const vite = spawn("npx", ["vite"], { cwd: APP, stdio: "ignore" });
children.push(api, vite);
await waitHttp("http://127.0.0.1:8788/api/search?q=x");
await waitHttp(SITE);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: join(OUT, ".video"), size: { width: 1280, height: 800 } } });
const page = await context.newPage();
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));

const typeSearch = async (text) => {
  await page.fill("#q", "");
  for (const ch of text) {
    await page.type("#q", ch);
    await sleep(70);
  }
};
const settle = async () => {
  await page.evaluate(() => (globalThis.__GENCLASS_AGENT__ && globalThis.__GENCLASS_AGENT__.whenSettled ? globalThis.__GENCLASS_AGENT__.whenSettled() : null)).catch(() => null);
  await sleep(1500);
};
/** The user's session: a fast search, a double click on Add to cart, a checkout, reviews, the profile, three subscribes. */
const useTheShop = async () => {
  await typeSearch("react");
  await sleep(1400);
  await page.dblclick('button.add[data-item="Retro keyboard"]');
  await sleep(900);
  await page.click("#checkout", { force: true });
  await sleep(900);
  await page.click("#reviews");
  await page.click("#profile");
  for (let i = 0; i < 3; i++) {
    await page.click("#newsletter button");
    await sleep(500);
  }
  await sleep(4200);
};

await step("1. The shop as it is: the page, and a scan with no integration at all", async () => {
  await page.goto(SITE);
  await sleep(1200);
  await shot(page, "shop-before");
  await typeSearch("react");
  await sleep(1500);
  await shot(page, "shop-before-stale-search");
  summary.staleBefore = await page.$eval("#results", (ul) => ul.textContent);
  summary.queryBefore = await page.$eval("#q", (i) => i.value);
  // `scan` is newer than the published 0.3.0-beta.1 CLI, so this runs the repository's own CLI (the same command a
  // later release puts behind `npx @genclass/runtime@beta scan`)
  await sh("scan", `node ../../../../packages/runtime/bin/genclass-runtime.mjs scan ${SITE}`, { title: "Terminal — the page scan, before any integration (the repository's CLI: scan is not on npm yet)", timeout: 400_000 });
});

// ---------------------------------------------------------------------------------------------------- 2. init
let link = null;
let token = null;
await step("2. npx @genclass/runtime@beta init: the runtime, a token and the dashboard", async () => {
  await sh("init", `npx ${RUNTIME} init --yes`, { title: "Terminal — init", timeout: 400_000 });
  const local = readFileSync(join(APP, ".genclass.local"), "utf8");
  link = /GENCLASS_DASHBOARD=(\S+)/.exec(local)?.[1] ?? null;
  token = /GENCLASS_TOKEN=(\S+)/.exec(local)?.[1] ?? null;
  summary.dashboardCreated = !!link;
  copyFileSync(join(APP, "src", "main.js"), join(OUT, ".after-init.js"));
  await sh("init-diff", "diff -u ../steps/00-main.before.js src/main.js; echo; echo '--- src/genclass.config.js (new)'; cat src/genclass.config.js; echo; echo '--- .genclass.local (new, gitignored)'; cat .genclass.local", { title: "Terminal — what init wrote" });
  await page.goto(SITE);
  await sleep(6000);
  await shot(page, "shop-with-runtime-and-overlay");
  const gc = consoleLines.filter((l) => l.includes("[GenClass]")).slice(0, 40);
  summary.consoleChecks = gc.length;
  const out = gc.map((l) => l.replace(/^\[\w+\] /, "")).join("\n");
  const id = `${num()}-browser-console`;
  saveTranscript(join(OUT, `${id}.txt`), { cwd: "browser", cmd: "console", out });
  await renderTerminal(render, join(OUT, `${id}.png`), { title: "Browser console — the measured checks, with no code of yours", cwd: "console", cmd: "(DevTools)", out: out.slice(0, 6000), kind: "DevTools" });
});

// ---------------------------------------------------------------------------------------------------- 3. the state and the agent link
await step("3. Three lines more: the shop's state, the agent link, telemetry from localhost", async () => {
  copyFileSync(join(HERE, "steps", "02-main.js"), join(APP, "src", "main.js"));
  const cfg = join(APP, "src", "genclass.config.js");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/globalThis\.GENCLASS_CONFIG = \{ token: ("[^"]+") \};/, "globalThis.GENCLASS_CONFIG = { token: $1, telemetry: true }; // telemetry: true also sends from localhost (this demo runs there)"));
  await sh("wire-diff", "diff -u ../out/.after-init.js src/main.js | tail -n +3; echo; echo '--- src/genclass.config.js'; cat src/genclass.config.js", { title: "Terminal — the state, the agent link, telemetry on" });
});

// ---------------------------------------------------------------------------------------------------- 4. the MCP server
// The server process is this repository's build of @genclass/mcp (packages/mcp): the package on npm, 0.1.0, predates
// the dashboard mirror (GENCLASS_REPORT) and genclass_scan, which are in the repository's unreleased 0.1.0. The
// published package still writes the project's .mcp.json above; a release moves the server itself to npm.
const REPO = join(HERE, "..", "..", "..");
const MCP_BIN = join(REPO, "packages", "mcp", "bin", "genclass-mcp.mjs");
let mcp = null;
await step("4. The coding agent: npx -y @genclass/mcp init, then the server as the agent's client starts it", async () => {
  await sh("mcp-init", `npx -y ${MCP} init && cat .mcp.json`, { title: "Terminal — the MCP server in the project", timeout: 300_000 });
  mcp = startMcp({ cwd: APP, command: process.execPath, args: [MCP_BIN], env: { GENCLASS_DASHBOARD: link ?? "", GENCLASS_REPORT: "on", GENCLASS_AGENT_PORT: AGENT_PORT }, log: (s) => log(`  [mcp] ${s}`) });
  const init = await mcp.init("claude-code");
  summary.mcpServer = init.serverInfo;
  summary.mcpFrom = "the repository's build (packages/mcp); npm's 0.1.0 has no GENCLASS_REPORT mirror and no genclass_scan";
  summary.mcpTools = await mcp.list();
  await sleep(1500);
  const setup = await mcp.call("genclass_setup");
  await agentShot("agent-setup", "genclass_setup", {}, setup);
  const st0 = await mcp.call("genclass_status");
  await agentShot("agent-status-nopage", "genclass_status", {}, st0);
});

// ---------------------------------------------------------------------------------------------------- 5. use the shop, findings
// One page load per thing the user does, so each finding's recorded run is a short scenario a replay can repeat.
const scenarios = {
  search: async () => {
    await typeSearch("react");
    await sleep(2200);
  },
  cart: async () => {
    await page.dblclick('button.add[data-item="Retro keyboard"]');
    await sleep(1200);
  },
  checkout: async () => {
    await page.click("#checkout", { force: true });
    await sleep(900);
    await page.click("#reviews");
    for (let i = 0; i < 3; i++) {
      await page.click("#newsletter button");
      await sleep(500);
    }
    await sleep(4200);
  },
  profile: async () => {
    await page.click("#profile");
    await sleep(900);
  },
};
const load = async (ms = 2500) => {
  await page.goto(SITE);
  await sleep(ms);
};
let topId = null;
let topKind = null;
let replayScenario = null;
await step("5. The user uses the shop; the agent asks what happened", async () => {
  await load(15_000); // the first load: the model loads at idle
  await scenarios.search();
  await settle();
  await shot(page, "shop-stale-search");
  await load();
  await scenarios.cart();
  await settle();
  await load();
  await scenarios.checkout();
  await settle();
  await shot(page, "shop-used");
  await load();
  await scenarios.profile();
  await settle();
  const st = await mcp.call("genclass_status");
  await agentShot("agent-status", "genclass_status", {}, st);
  const f = await mcp.call("genclass_findings");
  await agentShot("agent-findings", "genclass_findings", {}, f);
  summary.findingsText = redact(f.text);
  const pick = (kind) => new RegExp(`\\b(f\\d+) \\[${kind}\\]`).exec(f.text)?.[1] ?? null;
  for (const [kind, sc] of [["stale-write", "search"], ["race", "search"], ["duplicate-request", "cart"], ["error", "profile"]]) {
    const id = pick(kind);
    if (id) {
      topId = id;
      topKind = kind;
      replayScenario = scenarios[sc];
      break;
    }
  }
  summary.replayTarget = { id: topId, kind: topKind };
});

// ---------------------------------------------------------------------------------------------------- 6. explore before the fix
const explore = async (label) => {
  const start = await mcp.call("genclass_explore", { action: "start", runs: 3, route: "/" });
  await agentShot(`agent-explore-start-${label}`, "genclass_explore", { action: "start", runs: 3, route: "/" }, start);
  for (let i = 0; i < 5; i++) {
    await load(1800);
    await scenarios.search();
    await settle();
  }
  const rep = await mcp.call("genclass_explore", { action: "report" });
  await agentShot(`agent-explore-report-${label}`, "genclass_explore", { action: "report" }, rep);
  return redact(rep.text);
};
await step("6. Explore before the fix: the same search with the responses delivered in other orders", async () => {
  summary.exploreBefore = (await explore("before-fix")).slice(0, 2000);
  const race = /Race finding\(s\): (f\d+)/.exec(summary.exploreBefore)?.[1];
  if (race) {
    topId = race;
    topKind = "race";
    replayScenario = scenarios.search;
  }
  summary.replayTarget = { id: topId, kind: topKind };
});

// ---------------------------------------------------------------------------------------------------- 7. explain and replay
await step("7. Explain the race, replay its order: reproduced", async () => {
  if (!topId) throw new Error("no replayable finding");
  const ex = await mcp.call("genclass_explain", { id: topId });
  await agentShot("agent-explain", "genclass_explain", { id: topId }, ex);
  const test = /```(?:ts|typescript)?\n([\s\S]*?)```/.exec(ex.text)?.[1];
  if (test) {
    mkdirSync(join(APP, "tests"), { recursive: true });
    writeFileSync(join(APP, "tests", `${topId}.spec.ts`), test);
    summary.testWritten = `tests/${topId}.spec.ts`;
  }
  const arm = await mcp.call("genclass_replay", { action: "arm", id: topId });
  await agentShot("agent-replay-arm", "genclass_replay", { action: "arm", id: topId }, arm);
  await load();
  await replayScenario();
  await settle();
  await shot(page, "shop-replay-reproduced");
  const res = await mcp.call("genclass_replay", { action: "result", id: topId });
  await agentShot("agent-replay-result-before-fix", "genclass_replay", { action: "result", id: topId }, res);
  summary.replayBefore = /REPRODUCED|not reproduced|inconclusive/i.exec(res.text)?.[0] ?? null;
});

// ---------------------------------------------------------------------------------------------------- 8. the fix, replay and explore again
await step("8. The agent fixes the code; the same order no longer reproduces it, and explore finds no race", async () => {
  copyFileSync(join(HERE, "steps", "06-main.fixed.js"), join(APP, "src", "main.js"));
  await sh("fix-diff", "diff -u ../steps/02-main.js src/main.js | tail -n +3", { title: "Terminal — the fix" });
  // until Vite serves the changed module (its watcher invalidates the cached transform a moment after the write)
  for (let i = 0; i < 40; i++) {
    const src = await (await fetch(`${SITE}/src/main.js`)).text();
    if (src.includes("searchSeq")) break;
    await sleep(500);
  }
  await sleep(1000);
  const arm = await mcp.call("genclass_replay", { action: "arm", id: topId });
  await agentShot("agent-replay-arm-after-fix", "genclass_replay", { action: "arm", id: topId }, arm);
  await load();
  await replayScenario();
  await settle();
  await shot(page, "shop-after-fix");
  const res = await mcp.call("genclass_replay", { action: "result", id: topId });
  await agentShot("agent-replay-result-after-fix", "genclass_replay", { action: "result", id: topId }, res);
  summary.replayAfter = [...res.text.matchAll(/REPRODUCED|not reproduced|inconclusive/gi)].map((m) => m[0]).pop() ?? null;
  summary.fixedResults = await page.$eval("#results", (ul) => ul.textContent);
  summary.exploreAfter = (await explore("after-fix")).slice(0, 2000);
  // the double click, after the fix: one request
  await load();
  await scenarios.cart();
  await settle();
  summary.cartAfterFix = await page.$eval("#cartcount", (e) => e.textContent);
  const f2 = await mcp.call("genclass_findings", { sinceMinutes: 1 });
  await agentShot("agent-findings-after-fix", "genclass_findings", { sinceMinutes: 1 }, f2);
});

// ---------------------------------------------------------------------------------------------------- 9. scan and production
await step("9. The page scan from the agent", async () => {
  const sc = await mcp.call("genclass_scan", { url: SITE });
  await agentShot("agent-scan", "genclass_scan", { url: SITE }, sc);
  summary.scanText = sc.text.slice(0, 3000);
});
await step("9b. The production numbers, from the dashboard", async () => {
  await sleep(12_000); // the page's telemetry batches flush every few seconds
  const an = await mcp.call("genclass_analytics", { source: "production" });
  await agentShot("agent-analytics-production", "genclass_analytics", { source: "production" }, an);
});

// ---------------------------------------------------------------------------------------------------- 10. the dashboard
await step("10. The dashboard: the problems, the closed loop, the MCP page", async () => {
  if (!link) throw new Error("no dashboard link");
  await sleep(4000);
  for (const [hash, name] of [["#top", "dashboard-overview"], ["#found", "dashboard-problems"], ["#loop", "dashboard-closed-loop"], ["#mcp", "dashboard-mcp"]]) {
    await page.goto(`${link}${hash}`);
    await sleep(3500);
    await shot(page, name);
  }
  await page.goto(`${link}#loop`);
  await sleep(3000);
  await page.evaluate(() => window.scrollTo(0, document.querySelector("#agentlog")?.getBoundingClientRect().top + window.scrollY - 60));
  await sleep(700);
  await shot(page, "dashboard-closed-loop-log");
  const stats = await (await fetch(`${link.replace("/dashboard/", "/api/projects/")}?range=24h`)).json();
  summary.dashboard = { sessions: stats.totals?.sessions, detections: stats.totals?.detections, possible: stats.totals?.possible, agentStages: stats.agent?.stages, agentLog: stats.agent?.log?.map((e) => `${e.t}${e.id ? " " + e.id : ""}${e.reproduced === null ? "" : e.reproduced ? " reproduced" : " not reproduced"}`) };
});

// ---------------------------------------------------------------------------------------------------- done
if (mcp) await mcp.close().catch(() => {});
await context.close();
await browser.close();
await render.close();
for (const c of children) c.kill();
const vdir = join(OUT, ".video");
const webm = existsSync(vdir) ? readdirSync(vdir).find((f) => f.endsWith(".webm")) : null;
if (webm) renameSync(join(vdir, webm), join(OUT, "walkthrough.webm"));
rmSync(vdir, { recursive: true, force: true });
summary.finished = new Date().toISOString();
summary.errors = errors;
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(OUT, "browser-console.txt"), redact(consoleLines.join("\n")));
log("\n\nsummary:", JSON.stringify({ ...summary, findingsText: undefined, exploreText: undefined, scanText: undefined }, null, 2));
if (errors.length) log("errors:", errors);
process.exit(0);

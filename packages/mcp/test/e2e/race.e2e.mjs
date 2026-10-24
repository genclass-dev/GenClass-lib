// End-to-end: the agent loop on a real page in headless Chromium (docs/runtime/AGENT.md section 7). Not part of CI;
// run on the train VM after building both packages:
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
//   node packages/mcp/test/e2e/race.e2e.mjs
//
// It starts the MCP server in-process (its bridge on a free port), a tiny app server (the search page in ./app with
// the built runtime from packages/runtime/dist), and drives Chromium through the same steps an agent would take with
// the MCP tools:
//   1. explore on the buggy page: two baselines + 6 seeded orders with up to 600 ms of extra latency → a race finding;
//   2. replay the finding → reproduced;
//   3. write the generated regression test and run it with Playwright → fails on the buggy page;
//   4. switch the server to the fixed page; replay → not reproduced; the regression test → passes; explore → no race.
// Exit code 0 when all hold; the summary is printed as JSON.

import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { serve } from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const rtDist = resolve(here, "../../../runtime/dist");
const TYPES = { ".js": "text/javascript", ".html": "text/html", ".map": "application/json" };

// --------------------------------------------------------------------------- the app server
let fixed = false;
const app = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    // a fast, in-order backend: on its own it never shows the race
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [`${q} one`, `${q} two`] }));
    }, 40);
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Search</title>
<script type="importmap">{"imports":{"@genclass/runtime":"/rt/index.js","@genclass/runtime/agent":"/rt/agent.js"}}</script>
${fixed ? "<script>window.__FIXED__ = true</script>" : ""}
<input id="q" aria-label="Search" autocomplete="off"><h2 id="for"></h2><ul id="results"></ul>
<script type="module" src="/app.js"></script>`);
    return;
  }
  const file = url.pathname === "/app.js" ? join(here, "app", "app.js") : url.pathname.startsWith("/rt/") ? join(rtDist, url.pathname.slice(4)) : null;
  if (!file || !file.startsWith(here) && !file.startsWith(rtDist)) return res.writeHead(404).end();
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const APP = `http://localhost:${app.address().port}`;

// --------------------------------------------------------------------------- the MCP server, driven like an agent
const input = new PassThrough();
const output = new PassThrough();
const lines = [];
let buf = "";
output.setEncoding("utf8");
output.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    lines.push(JSON.parse(buf.slice(0, nl)));
    buf = buf.slice(nl + 1);
  }
});
const served = await serve({ cwd: here, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: null });
let id = 0;
async function rpc(method, params = {}) {
  const my = ++id;
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
  for (let i = 0; i < 500; i++) {
    const m = lines.find((x) => x.id === my);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no reply to ${method}`);
}
const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

// --------------------------------------------------------------------------- the scenario (what a person or agent does)
const browser = await chromium.launch();
const bridgeUrl = `http://127.0.0.1:${served.port}`;
async function scenario() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript((u) => (window.__GENCLASS_AGENT_URL__ = u), bridgeUrl);
  await page.goto(APP + "/");
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 10_000 });
  await page.getByLabel("Search").pressSequentially("react", { delay: 80 });
  await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000));
  const shown = await page.locator("#for").textContent();
  await page.waitForTimeout(400); // the snapshot batch reaches the bridge
  await ctx.close();
  return shown;
}

const summary = {};
const fail = (msg) => {
  summary.failed = msg;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
};

// 1. explore the buggy page
console.log(await tool("genclass_explore", { action: "start", runs: 6, slow_ms: 600 }));
summary.buggyRuns = [];
for (let i = 0; i < 8; i++) summary.buggyRuns.push(await scenario());
const report = await tool("genclass_explore", { action: "report" });
console.log(report);
summary.exploreBuggy = /RACE: (\d+) of (\d+)/.exec(report)?.slice(1).join("/") ?? "no race";
if (!/RACE:/.test(report)) fail("explore found no race on the buggy page");
const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1];
if (!fid) fail("no race finding id");
const explain = await tool("genclass_explain", { id: fid });
console.log(explain);
const test = /```ts\n([\s\S]*?)```/.exec(explain)?.[1];
if (!test) fail("explain gave no regression test");

// 2. replay → reproduced
await tool("genclass_replay", { action: "arm", id: fid });
summary.replayBuggyShown = await scenario();
const r1 = await tool("genclass_replay", { action: "result", id: fid });
console.log(r1);
summary.replayBuggy = /REPRODUCED/.test(r1) ? "reproduced" : r1;
if (!/REPRODUCED/.test(r1)) fail("the replay did not reproduce the race on the buggy page");

// 3. the generated regression test fails on the buggy page
const gen = join(here, ".gen");
rmSync(gen, { recursive: true, force: true });
mkdirSync(gen, { recursive: true });
// the test sets its own schedule through a page global: it needs no bridge (as in CI)
writeFileSync(join(gen, "race.spec.ts"), test);
writeFileSync(join(gen, "playwright.config.mjs"), `export default { testDir: ".", timeout: 30000, reporter: "line", use: { headless: true } };\n`);
// async: this process also serves the app and the bridge, so it must keep its event loop running meanwhile
const runTest = () =>
  new Promise((resolve) => {
    const p = spawn("npx", ["playwright", "test", "--config", join(gen, "playwright.config.mjs")], { cwd: gen, env: { ...process.env, GENCLASS_APP_URL: APP } });
    let stdout = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stdout += d));
    p.on("close", (status) => resolve({ status, stdout }));
  });
const t1 = await runTest();
summary.testOnBuggy = t1.status === 0 ? "passed" : "failed";
console.log(t1.stdout.slice(-1500));
if (t1.status === 0) fail("the regression test passed on the buggy page");

// 4. the fix
fixed = true;
await tool("genclass_replay", { action: "arm", id: fid });
summary.replayFixedShown = await scenario();
const r2 = await tool("genclass_replay", { action: "result", id: fid });
console.log(r2);
summary.replayFixed = /not reproduced/.test(r2.split("\n").slice(-3).join("\n")) ? "not reproduced" : r2;
const t2 = await runTest();
summary.testOnFixed = t2.status === 0 ? "passed" : "failed";
console.log(t2.stdout.slice(-1500));
if (t2.status !== 0) fail("the regression test failed on the fixed page");
console.log(await tool("genclass_explore", { action: "start", runs: 6, slow_ms: 600 }));
summary.fixedRuns = [];
for (let i = 0; i < 8; i++) summary.fixedRuns.push(await scenario());
const report2 = await tool("genclass_explore", { action: "report" });
console.log(report2);
summary.exploreFixed = /RACE:/.test(report2) ? "race" : /No race found: all 6 reordered/.test(report2) ? "no race" : "not compared";
if (/RACE:/.test(report2)) fail("explore reported a race on the fixed page (a false report)");
// "no race" only counts when the reordered runs were compared (not "0 reordered runs could be compared")
if (summary.exploreFixed !== "no race") fail("explore on the fixed page compared no reordered run with the baselines");

await browser.close();
await served.close();
app.close();
summary.ok = true;
console.log(JSON.stringify(summary, null, 2));
process.exit(0);

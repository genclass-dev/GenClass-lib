// The explore bench on two small search pages (bench/explore/README.md): Redux Toolkit Query and TanStack Query, each
// with a planted stale race (?bug) and a correct variant, run in headless Chromium with the real runtime (script-tag
// build, observe, no model) and the real MCP server in-process, driven the way an agent drives it: genclass_explore
// start → one page load per armed run (type "react" at 80 ms a key, then whenSettled) → report; on a race,
// genclass_replay of the first finding. Each session writes what bench/explore/summarise.mjs scores: the report, every
// load's DOM oracle (the heading and the result rows) with its bridge run id, and the bridge's state directory.
//
//   (cd bench/explore/apps && npm install)                 # once: the apps' own dependencies
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
//   node bench/explore/apps.mjs <out dir> [--rt <runtime dist>] [--mcp <mcp dist>] [--slow 300,600,900] [--runs 6]
//   node bench/explore/summarise.mjs <out dir>
//
// --rt and --mcp run the same bench with other builds (the comparison before a change, from a git worktree).

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
const OUT = resolve(args[0] ?? join(here, "out"));
const rtDist = resolve(opt("--rt", join(here, "../../packages/runtime/dist")));
const mcpDist = resolve(opt("--mcp", join(here, "../../packages/mcp/dist")));
const SLOW = opt("--slow", "600").split(",").map(Number);
const RUNS = Number(opt("--runs", "6"));
const { serve } = await import(pathToFileURL(join(mcpDist, "index.js")).href);
mkdirSync(OUT, { recursive: true });

// --------------------------------------------------------------------------- the apps, bundled (React development build)
const bundles = {};
for (const name of ["rtk", "tanstack"]) {
  const r = await build({ entryPoints: [join(here, "apps/src", `${name}.jsx`)], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' }, logLevel: "error" });
  bundles[name] = r.outputFiles[0].text;
}

// --------------------------------------------------------------------------- the app server (a fast, in-order backend)
const TYPES = { ".js": "text/javascript", ".map": "application/json", ".wasm": "application/wasm" };
const page = (name) => `<!doctype html><meta charset="utf-8"><title>Search</title>
<script>window.GENCLASS_CONFIG=${JSON.stringify({ telemetry: false, mode: "observe", model: false, visual: false, devtools: false, report: "silent" })};</script>
<script src="/rt/genclass.global.js" data-base="/rt/"></script>
<script type="module">import { connectAgent } from "/rt/agent.js"; connectAgent(window.GenClass.runtime);</script>
<div id="root"></div>
<script type="module" src="/app/${name}.js"></script>`;
const app = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [`${q} one`, `${q} two`] }));
    }, 40);
    return;
  }
  const m = /^\/(rtk|tanstack)\/$/.exec(url.pathname);
  if (m) return res.writeHead(200, { "content-type": "text/html" }).end(page(m[1]));
  const b = /^\/app\/(rtk|tanstack)\.js$/.exec(url.pathname);
  if (b) return res.writeHead(200, { "content-type": "text/javascript" }).end(bundles[b[1]]);
  if (url.pathname.startsWith("/rt/")) {
    const file = resolve(rtDist, url.pathname.slice(4));
    if (file.startsWith(rtDist) && existsSync(file)) return res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  }
  res.writeHead(404).end();
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const APP = `http://localhost:${app.address().port}`;

// --------------------------------------------------------------------------- one explore session, driven like an agent
async function session(browser, name, bug, slow) {
  const tag = `${name}-${bug ? "bug" : "ok"}-${slow}`;
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
  const served = await serve({ cwd: OUT, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: join(OUT, `state-${tag}`) });
  let id = 0;
  const rpc = async (method, params = {}) => {
    const my = ++id;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
    for (let i = 0; i < 1000; i++) {
      const m = lines.find((x) => x.id === my);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no reply to ${method}`);
  };
  const tool = async (t, a = {}) => (await rpc("tools/call", { name: t, arguments: a })).result.content[0].text;
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "explore-bench", version: "1" } });
  const bridge = `http://127.0.0.1:${served.port}`;
  const load = async (i) => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.addInitScript((u) => (window.__GENCLASS_AGENT_URL__ = u), bridge);
    const out = { i };
    try {
      await p.goto(`${APP}/${name}/${bug ? "?bug" : ""}`);
      await p.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
      out.run = await p.evaluate(() => window.__GENCLASS_AGENT__.run);
      out.schedule = await p.evaluate(() => window.__GENCLASS_AGENT__.schedule);
      await p.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000));
      await p.getByLabel("Search").pressSequentially("react", { delay: 80 });
      out.settled = await p.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000));
      out.oracle = { heading: await p.locator("#for").textContent(), rows: await p.locator("#results li").allTextContents() };
      const s = await p.evaluate(() => window.__GENCLASS_AGENT__.snapshot());
      out.snapshot = { stateFields: Object.keys(s.state).length, stateLeft: s.stateLeft ?? 0, stores: [...new Set(Object.keys(s.state).map((k) => k.split(".")[0]))], witnesses: (await p.evaluate(() => window.__GENCLASS_AGENT__.witnesses())).map((w) => `${w.kind} ${w.subject} by ${w.by}`), forced: s.forced };
      await p.waitForTimeout(400); // the last batch reaches the bridge
    } catch (e) {
      out.error = String(e?.message ?? e).slice(0, 500);
    }
    await ctx.close();
    return out;
  };
  const result = { scenario: `${name}-${bug ? "bug" : "ok"}`, slow_ms: slow, runs: RUNS, loads: [] };
  result.start = await tool("genclass_explore", { action: "start", runs: RUNS, slow_ms: slow });
  for (let i = 0; i < RUNS + 2; i++) result.loads.push(await load(i));
  result.report = await tool("genclass_explore", { action: "report" });
  const fid = /Race finding\(s\): (f\d+)/.exec(result.report)?.[1];
  if (fid) {
    result.replay = { id: fid, arm: await tool("genclass_replay", { action: "arm", id: fid }) };
    result.replay.load = await load(RUNS + 2);
    result.replay.result = await tool("genclass_replay", { action: "result", id: fid });
  }
  writeFileSync(join(OUT, `${tag}.json`), JSON.stringify(result, null, 2));
  await served.close();
  const headings = result.loads.map((l) => l.oracle?.heading ?? l.error ?? "?");
  console.log(`${tag}: ${result.report.split("\n").filter((l) => /^(RACE:|No race found|No verdict|Internal state only|Along the way only|Compared:)/.test(l)).map((l) => l.slice(0, 110)).join(" | ")}${fid ? ` | replay: ${/REPRODUCED/.test(result.replay.result) ? "reproduced" : /not reproduced/.test(result.replay.result) ? "not reproduced" : "inconclusive"}` : ""}\n  pages: ${headings.join(", ")}`);
}

const browser = await chromium.launch();
for (const slow of SLOW) for (const name of ["rtk", "tanstack"]) for (const bug of [true, false]) await session(browser, name, bug, slow);
await browser.close();
app.close();
process.exit(0);

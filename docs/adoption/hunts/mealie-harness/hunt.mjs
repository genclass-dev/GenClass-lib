// GenClass race hunt on a local Mealie dev server (frontend :3000, backend :9000).
//
// Same loop as packages/mcp/test/e2e/race.e2e.mjs, on an app we do not own: the MCP server runs in-process (its bridge
// on a free port); every page load gets the runtime's script-tag build injected through page.route on a virtual
// same-origin path (/__genclass/), with window.GENCLASS_CONFIG (telemetry off, no model, silent) and then
// connectAgent(window.GenClass.runtime, { url }). No Mealie file is changed. Mealie is Vue, which GenClass does not
// discover, so no store is registered: the explore verdict compares the page text and form values in the snapshots,
// and the delivery order is in the recorded steps.
//
//   node hunt.mjs --scenario dialog-pause --slow 600 [--runs 6] [--delay 90] [--tag buggy]
//
// Prints the explore report (what an agent sees), the DOM oracle per load, and writes everything to out/<tag>-....json.

import { PassThrough } from "node:stream";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import { serve } from "@genclass/mcp";
import { SCENARIOS } from "./scenarios.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const scenarioName = arg("scenario", "dialog-pause");
const slow = Number(arg("slow", "600"));
const runs = Number(arg("runs", "6"));
const keyDelay = Number(arg("delay", "90"));
const tag = arg("tag", "buggy");
const seed = arg("seed") ? Number(arg("seed")) : undefined;
const sc = SCENARIOS[scenarioName];
if (!sc) throw new Error(`unknown scenario ${scenarioName}`);

const APP = "http://localhost:3000";
const RT_DIST = "/home/user/GenClass-lib/packages/runtime/dist";
const OUT = "/home/user/hunt/out";
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ the MCP server, driven like an agent
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
const served = await serve({ cwd: "/home/user/hunt/harness", env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: null });
let id = 0;
async function rpc(method, params = {}) {
  const my = ++id;
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
  for (let i = 0; i < 3000; i++) {
    const m = lines.find((x) => x.id === my);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no reply to ${method}`);
}
const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hunt", version: "1" } });
input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const bridgeUrl = `http://127.0.0.1:${served.port}`;

// ------------------------------------------------------------------ injection
const CONFIG = { telemetry: false, model: false, report: "silent" };
// --atom: register the visible search results as a GenClass atom (read from the rendered list on DOM changes), so the
// snapshots carry them as a store field; without it explore sees only the first 300 lines of page text.
const ATOM = process.argv.includes("--atom")
  ? `
const rt = window.GenClass.runtime;
const st = rt.atom("searchResults", "");
const read = () => {
  const names = [...document.querySelectorAll(".v-dialog .arrow-nav, .v-overlay--active .v-list-item")].map((e) => e.innerText.split("\\n")[0].trim());
  return names.length ? names.length + ": " + names[0] + " ... " + names[names.length - 1] : "";
};
new MutationObserver(() => { const v = read(); if (v !== st.get()) st.set(v); }).observe(document.body, { childList: true, subtree: true, characterData: true });`
  : "";
const HEAD = `<script>window.GENCLASS_CONFIG=${JSON.stringify(CONFIG)};</script>
<script src="/__genclass/genclass.global.js"></script>
<script type="module">import { connectAgent } from "/__genclass/agent.js"; connectAgent(window.GenClass.runtime, { url: ${JSON.stringify(bridgeUrl)} });${ATOM}</script>`;
const TYPES = { ".js": "text/javascript", ".map": "application/json" };

async function newPage(browser) {
  const ctx = await browser.newContext({ storageState: "/home/user/hunt/harness/state.json", bypassCSP: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.route(`${APP}/__genclass/**`, async (route) => {
    const p = new URL(route.request().url()).pathname.slice("/__genclass/".length);
    const file = join(RT_DIST, p);
    if (!file.startsWith(RT_DIST + "/") || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }, body: readFileSync(file) });
  });
  await page.route((u) => u.origin === APP && !u.pathname.startsWith("/_nuxt/") && !u.pathname.startsWith("/api/") && !u.pathname.startsWith("/__genclass/"), async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const res = await route.fetch();
    const html = await res.text();
    return route.fulfill({ response: res, body: html.replace(/<head([^>]*)>/i, (m) => `${m}\n${HEAD}`) });
  });
  const net = [];
  const t0 = Date.now();
  const watch = (u) => u.includes("/api/recipes?") && new URL(u).searchParams.has("_searchSeed");
  page.on("request", (r) => watch(r.url()) && net.push({ t: Date.now() - t0, ev: "send", search: new URL(r.url()).searchParams.get("search") }));
  page.on("response", (r) => watch(r.url()) && net.push({ t: Date.now() - t0, ev: "net-response", search: new URL(r.url()).searchParams.get("search") }));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, net, errors };
}

// ------------------------------------------------------------------ one load
async function load(browser, i) {
  const { ctx, page, net, errors } = await newPage(browser);
  await page.goto(APP + sc.path, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 20_000 });
  await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(20_000));
  const schedule = await page.evaluate(() => {
    const a = window.__GENCLASS_AGENT__;
    return a?.schedule ? JSON.stringify(a.schedule) : null;
  });
  await sc.setup?.(page);
  await sc.steps(page, keyDelay);
  const settled = await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(20_000));
  const shown = await sc.read(page);
  const verdict = sc.oracle(shown);
  // what GenClass recorded: the user actions and the recipe-search sends and app-level deliveries, in order
  const rec = await page.evaluate(() => {
    const r = window.__GENCLASS_AGENT__.recorded();
    const keys = new Set(r.steps.filter((s) => s.k === "send" && /recipes/.test(s.key) && /search/.test(s.detail ?? "")).map((s) => s.key));
    return {
      spec: r.spec,
      forced: r.forced,
      steps: r.steps.filter((s) => s.k === "act" || ((s.k === "send" || s.k === "recv" || s.k === "end") && keys.has(s.key))),
      order: r.order.filter((k) => keys.has(k)),
      all: r.steps.filter((s) => s.k === "send" || s.k === "recv" || s.k === "end").map((s) => `${s.k} ${s.key}@${s.t}${s.held ? ` held ${s.held}` : ""}${s.detail ? ` ${s.detail.slice(0, 40)}` : ""}`),
    };
  });
  await page.waitForTimeout(500); // the snapshot batch reaches the bridge
  await ctx.close();
  const row = { i, schedule, settled, shown, oracle: verdict, net, rec, errors: errors.slice(0, 3) };
  console.log(`[${new Date().toISOString().slice(11, 19)}] load ${i + 1}: oracle ${verdict.ok ? "OK" : "WRONG"} (${verdict.why}); settled=${settled}; app order ${rec.order.join(" > ")}; net ${net.map((n) => `${n.ev}:${JSON.stringify(n.search)}@${n.t}`).join(" ")}`);
  return row;
}

// Chromium 153 treats a document served by route.fulfill as non-local and blocks its requests to loopback (the
// bridge, Vite HMR) under Local Network Access; this test browser turns that check off.
const browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks"] });
const started = Date.now();
// warm the dev server (Vite compiles on first request) outside the session
if (!process.argv.includes("--no-warm")) {
  const { ctx, page } = await newPage(browser);
  await page.goto(APP + sc.path, { waitUntil: "load", timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await ctx.close();
}
const armed = await tool("genclass_explore", { action: "start", runs, slow_ms: slow, route: sc.route, ...(seed !== undefined ? { seed } : {}) });
console.log(armed);
const plan = (armed.match(/^\s+\d+\. .*/gm) ?? []).length;
const rows = [];
for (let i = 0; i < plan; i++) rows.push(await load(browser, i));
const report = await tool("genclass_explore", { action: "report" });
console.log(report);
const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1];
let explain = null;
if (fid) explain = await tool("genclass_explain", { id: fid });
const findings = await tool("genclass_findings", {});
const verdict = /RACE: (\d+) of (\d+)/.exec(report);
const summary = {
  tag,
  scenario: scenarioName,
  slow_ms: slow,
  keyDelay,
  loads: rows.length,
  explore: verdict ? `race ${verdict[1]}/${verdict[2]}` : /No race found/.test(report) ? "no race" : "no verdict",
  oracleWrong: rows.filter((r) => !r.oracle.ok).length,
  oracleWrongSeeded: rows.slice(2).filter((r) => !r.oracle.ok).length,
  oracleWrongBaseline: rows.slice(0, 2).filter((r) => !r.oracle.ok).length,
  findingId: fid ?? null,
  minutes: +((Date.now() - started) / 60000).toFixed(1),
};
console.log(JSON.stringify(summary));
const file = join(OUT, `${tag}-${scenarioName}-slow${slow}-d${keyDelay}-${Date.now()}.json`);
writeFileSync(file, JSON.stringify({ summary, armed, report, explain, findings, rows }, null, 2));
console.log("wrote", file);
await browser.close();
await served.close();
process.exit(0);

// Race hunt harness for Gitea (docs/adoption/hunts/gitea.md). Not part of CI; run by hand against a local Gitea.
//
//   node docs/adoption/hunts/gitea-explore.mjs --gitea http://localhost:3000 --owner e2e-admin --password <pw> \
//     --repo hunt --surface comment --slow 300,600,900 [--runs 6] [--out <dir>]
//
// GenClass is injected from outside: Gitea's own code is unchanged. A Playwright route rewrites each Gitea HTML page to
// load the script-tag build (packages/runtime/dist/genclass.global.js) from a virtual same-origin path
// (/__genclass/rt/), started with the model skipped (model: false) and telemetry off, then connects the coding-agent
// link (dist/agent.js, an ES module) to the MCP bridge started in this process (packages/mcp/dist). Gitea's frontend is
// Go templates, Fomantic, jQuery and vanilla TypeScript, so GenClass discovers no store: the injected script registers
// each watched pane's visible text with rt.atom() from a MutationObserver (the only state the explore verdict compares
// besides page text and form values).
//
// Surfaces (--surface):
//   comment   the issue comment box (ComboMarkdownEditor): fill A, Preview, Write, fill B, Preview
//   file      the web file editor (repo-editor.ts): fill A, Preview, Edit File, fill B, Preview
//   diff      the web file editor's "Preview Changes" tab: fill A, Preview Changes, Edit File, fill B, Preview Changes
//   dispatch  Actions "Run workflow": pick branch "other", then branch "main" (the inputs form is re-fetched per pick)
// For each --slow value it runs one explore session: 2 fifo baselines + --runs seeded loads, the same steps each load,
// at Playwright's pace (--pause <ms> adds a wait after the first Preview or branch pick). Each load's line in the output
// ends with the delivery order of the requests under test, as the agent link recorded it. Each browser context gets the
// local-network-access permission: Chromium otherwise blocks a route-fulfilled page's requests to the loopback bridge.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const rtDist = join(root, "packages/runtime/dist");
const { serve } = await import(join(root, "packages/mcp/dist/index.js"));

const { values: arg } = parseArgs({
  options: {
    gitea: { type: "string", default: "http://localhost:3000" },
    owner: { type: "string", default: "e2e-admin" },
    password: { type: "string", default: "password" },
    repo: { type: "string", default: "hunt" },
    surface: { type: "string", default: "comment" },
    slow: { type: "string", default: "300,600,900" },
    runs: { type: "string", default: "6" },
    out: { type: "string", default: "" },
    pause: { type: "string", default: "0" },
  },
});
const G = arg.gitea.replace(/\/+$/, "");
const TYPES = { ".js": "text/javascript", ".map": "application/json" };
const pause = Number(arg.pause);

// --------------------------------------------------------------------------- what the route injects into <head>
const INJECT = `<script src="/__genclass/rt/genclass.global.js" data-manual data-base="/__genclass/rt/"></script>
<script>window.__gcRt = window.GenClass.init({ model: false, telemetry: false, report: "silent" });</script>
<script type="module">
import { connectAgent } from "/__genclass/rt/agent.js";
const rt = window.__gcRt;
connectAgent(rt);
// Gitea keeps no client store: register what each pane shows, so the explore verdict compares it.
const panes = {
  commentPreview: '#comment-form .ui.tab[data-tab-panel="markdown-previewer"]',
  filePreview: 'form .tab[data-tab="preview"]',
  fileDiff: 'form .tab[data-tab="diff"]',
  dispatchInputs: "#runWorkflowDispatchModalInputs",
};
const atoms = {};
for (const k of Object.keys(panes)) atoms[k] = rt.atom(k, { text: "" });
const read = () => {
  for (const [k, sel] of Object.entries(panes)) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = k === "dispatchInputs"
      ? [...el.querySelectorAll("[name]")].map((i) => i.getAttribute("name")).join(" ")
      : k === "fileDiff"
        ? [...el.querySelectorAll(".code-inner")].map((c) => c.textContent).filter((t) => /alpha|bravo/.test(t)).join(" | ")
        : (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (atoms[k].get().text !== text) atoms[k].set({ text });
  }
};
new MutationObserver(read).observe(document.documentElement, { childList: true, subtree: true });
</script>
`;

async function route(page) {
  await page.route(`${G}/**`, async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith("/__genclass/rt/")) {
      const file = join(rtDist, url.pathname.slice("/__genclass/rt/".length));
      if (!file.startsWith(rtDist)) return r.fulfill({ status: 404 });
      try {
        return r.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
      } catch {
        return r.fulfill({ status: 404 });
      }
    }
    if (req.resourceType() !== "document") return r.fallback();
    const resp = await r.fetch();
    const type = resp.headers()["content-type"] ?? "";
    if (!type.includes("text/html")) return r.fulfill({ response: resp });
    const body = (await resp.text()).replace(/<head([^>]*)>/i, (m) => `${m}\n${INJECT}`);
    return r.fulfill({ response: resp, body });
  });
}

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
  for (let i = 0; i < 1000; i++) {
    const m = lines.find((x) => x.id === my);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no reply to ${method}`);
}
const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gitea-hunt", version: "1" } });
input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const bridgeUrl = `http://127.0.0.1:${served.port}`;

// --------------------------------------------------------------------------- the scenarios (what a person does)
const A = "alpha draft of the comment";
const B = "bravo final wording";
const nap = (page) => (pause ? page.waitForTimeout(pause) : Promise.resolve());

const surfaces = {
  async comment(page) {
    await page.goto(`${G}/${arg.owner}/${arg.repo}/issues/1`);
    const form = page.locator("#comment-form");
    const text = form.locator("textarea.markdown-text-editor");
    const preview = form.locator('[data-tab-for="markdown-previewer"]');
    const write = form.locator('[data-tab-for="markdown-writer"]');
    await connected(page);
    await text.fill(A);
    await preview.click();
    await nap(page);
    await write.click();
    await text.fill(B);
    await preview.click();
    await settle(page);
    return (await form.locator('[data-tab-panel="markdown-previewer"]').innerText()).trim();
  },
  async file(page) {
    await page.goto(`${G}/${arg.owner}/${arg.repo}/_edit/main/README.md`);
    const editor = page.locator('.cm-content[role="textbox"]');
    await editor.waitFor();
    await connected(page);
    const menu = page.locator(".repo-editor-menu");
    await editor.fill(A);
    await menu.locator('a[data-tab="preview"]').click();
    await nap(page);
    await menu.locator('a[data-tab="write"]').click();
    await editor.fill(B);
    await menu.locator('a[data-tab="preview"]').click();
    await settle(page);
    return (await page.locator('form .tab[data-tab="preview"]').innerText()).trim();
  },
  async diff(page) {
    await page.goto(`${G}/${arg.owner}/${arg.repo}/_edit/main/README.md`);
    const editor = page.locator('.cm-content[role="textbox"]');
    await editor.waitFor();
    await connected(page);
    const menu = page.locator(".repo-editor-menu");
    await editor.fill(A);
    await menu.locator('a[data-tab="diff"]').click();
    await nap(page);
    await menu.locator('a[data-tab="write"]').click();
    await editor.fill(B);
    await menu.locator('a[data-tab="diff"]').click();
    await settle(page);
    return (await page.locator('form .tab[data-tab="diff"] .code-inner').allTextContents()).filter((t) => /alpha|bravo/.test(t)).join(" | ");
  },
  async dispatch(page) {
    await page.goto(`${G}/${arg.owner}/${arg.repo}/actions?workflow=dispatch.yml`);
    await connected(page);
    await page.locator('button.show-modal[data-modal="#runWorkflowDispatchModal"]').click();
    const dd = page.locator("#runWorkflowDispatchModal .branch-selector-dropdown");
    await dd.click();
    await dd.locator('#branch-list .item[data-value="refs/heads/other"]').click();
    await nap(page);
    await dd.click();
    await dd.locator('#branch-list .item[data-value="refs/heads/main"]').click();
    await settle(page);
    const ref = await page.locator('#runWorkflowDispatchModal input[name="ref"]').inputValue();
    const names = await page.locator("#runWorkflowDispatchModalInputs [name]").evaluateAll((els) => els.map((e) => e.getAttribute("name")).join(" "));
    return `ref=${ref} inputs=${names}`;
  },
};

async function connected(page) {
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
}
async function settle(page) {
  await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000));
}

const browser = await chromium.launch();
// one login, reused by every page load (a fresh context per load: one explore run each)
const loginCtx = await browser.newContext();
const login = await loginCtx.request.post(`${G}/user/login`, { form: { user_name: arg.owner, password: arg.password }, maxRedirects: 0 });
if (![302, 303].includes(login.status())) throw new Error(`login failed: HTTP ${login.status()}`);
const storageState = await loginCtx.storageState();
await loginCtx.close();

async function scenario(fn) {
  const ctx = await browser.newContext({ storageState, permissions: ["local-network-access"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (process.env.HUNT_DEBUG) {
    page.on("console", (m) => console.log("[page]", m.type(), m.text()));
    page.on("requestfailed", (r) => console.log("[failed]", r.url(), r.failure()?.errorText));
  }
  await page.addInitScript((u) => (window.__GENCLASS_AGENT_URL__ = u), bridgeUrl);
  await route(page);
  let shown;
  try {
    shown = await fn(page);
  } catch (e) {
    shown = `ERROR ${String(e).split("\n")[0]}`;
  }
  // the delivery order of the requests under test, as the agent link recorded it
  const order = await page
    .evaluate(() => window.__GENCLASS_AGENT__.recorded().order.filter((k) => /markup|_preview|workflow-dispatch-inputs/.test(k)).map((k) => k.slice(k.lastIndexOf("#"))))
    .catch(() => []);
  await page.waitForTimeout(500); // the snapshot batch reaches the bridge
  await ctx.close();
  const line = `${shown} [delivered ${order.join(" then ") || "none"}]`;
  return errors.length ? `${line} [pageerror: ${errors[0]}]` : line;
}

const fn = surfaces[arg.surface];
if (!fn) throw new Error(`unknown surface ${arg.surface}`);
const out = arg.out ? resolve(arg.out) : null;
if (out) mkdirSync(out, { recursive: true });
const summary = { surface: arg.surface, gitea: G, runs: Number(arg.runs), pause, sessions: [] };
for (const slow of arg.slow.split(",").map(Number)) {
  await tool("genclass_clear", { what: "all" });
  const started = await tool("genclass_explore", { action: "start", runs: Number(arg.runs), slow_ms: slow });
  const shown = [];
  for (let i = 0; i < Number(arg.runs) + 2; i++) shown.push(await scenario(fn));
  const report = await tool("genclass_explore", { action: "report" });
  const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1];
  const explain = fid ? await tool("genclass_explain", { id: fid }) : null;
  const findings = await tool("genclass_findings");
  const verdict = /RACE: (\d+) of (\d+)/.exec(report);
  summary.sessions.push({ slow_ms: slow, verdict: verdict ? `race in ${verdict[1]} of ${verdict[2]}` : "no race", shown });
  if (out) writeFileSync(join(out, `${arg.surface}-${slow}.txt`), [started, "", ...shown.map((s, i) => `load ${i + 1}: ${s}`), "", report, "", findings, "", explain ?? ""].join("\n"));
  console.log(`--- ${arg.surface} slow_ms=${slow}\n${report}\n`);
}
await browser.close();
await served.close();
console.log(JSON.stringify(summary, null, 2));
if (out) writeFileSync(join(out, `${arg.surface}-summary.json`), JSON.stringify(summary, null, 2));
process.exit(0);

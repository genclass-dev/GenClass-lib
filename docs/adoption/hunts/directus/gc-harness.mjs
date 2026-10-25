// GenClass hunt harness for the Directus Studio (Vite dev server on :8080, API on :8055).
//
// It starts the GenClass MCP server in-process (its bridge on a free port), injects the script-tag build of
// @genclass/runtime and the agent link into the Studio's index.html through page.route on a virtual path
// (/__genclass/), with telemetry off and the model skipped, and drives Chromium through one scenario per page load
// while an explore session assigns the delivery schedules (2 fifo baselines + N seeded orders, optional slow_ms).
//
//   node gc-harness.mjs --scenario nav-back --gap 100 --slow 600 --runs 6 --out results/x.json
//
// Scenarios (user-level actions only; no synthetic routing). Each starts at the Articles list and opens article 1:
//   nav-back      click "Navigate to Item" on its Related field (article 2), after --gap ms click the header back
//                 arrow (router.back(), back to article 1)
//   nav-chain     related link (2), related link on 2 once shown (3), then the back arrow twice with --gap ms between
//                 the clicks (3 -> 2 -> 1); written, not used in the report
//   picker        choose Delta in the Related field's "Select Item" drawer, then --gap ms later reopen it and choose Echo
//   autocomplete  clear the Topic field (autocomplete interface), wait 600 ms, type "rea" at --gap ms a key
//
// The report (docs/adoption/hunts/directus.md) explains the two test-side workarounds below: the Local Network Access
// flag (the document is fulfilled through page.route) and the Vue DevTools overlay tags dropped from the page.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
// GENCLASS_LIB: a GenClass-lib checkout with both packages built (default: this repository)
const LIB = process.env.GENCLASS_LIB ?? fileURLToPath(new URL("../../../../", import.meta.url));
const { chromium } = await import(pathToFileURL(join(LIB, "node_modules/@playwright/test/index.mjs")).href);
const { serve } = await import(pathToFileURL(join(LIB, "packages/mcp/dist/index.js")).href);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]] : acc), []),
);
const SCENARIO = args.scenario ?? "nav-back";
const GAP = Number(args.gap ?? 100);
const SLOW = args.slow !== undefined ? Number(args.slow) : 600;
const RUNS = Number(args.runs ?? 6);
const OUT = args.out ?? null;
const APP = "http://localhost:8080";
const RT_DIST = join(LIB, "packages/runtime/dist");
const TYPES = { ".js": "text/javascript", ".map": "application/json" };

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
const served = await serve({ cwd: process.cwd(), env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: null });
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
const tool = async (name, a = {}) => (await rpc("tools/call", { name, arguments: a })).result.content[0].text;
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "directus-hunt", version: "1" } });
input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const bridgeUrl = `http://127.0.0.1:${served.port}`;

// --------------------------------------------------------------------------- the injected boot module
// Vue state is not discovered by the runtime, so the visible item form is mirrored into a registered atom: one key per
// form field (data-field), the value shown in it, plus the route. Read on every animation frame and on input.
const BOOT = `
import { connectAgent } from "/__genclass/agent.js";
const rt = window.GenClass.runtime ?? window.GenClass.init({ model: false, report: "silent", telemetry: false });
window.__hunt_conn = connectAgent(rt);
const st = rt.atom("directus.form", { route: location.pathname });
const read = () => {
  const out = { route: location.pathname };
  for (const f of document.querySelectorAll("#main-content .field[data-field], .field[data-field]")) {
    const name = f.getAttribute("data-field");
    if (!name || name in out) continue;
    const inp = f.querySelector("input, textarea");
    const shown = inp ? inp.value : (f.querySelector(".interface")?.innerText ?? "").replace(/\\s+/g, " ").trim();
    out[name] = String(shown).slice(0, 120);
  }
  const h = document.querySelector("header.header-bar h1");
  if (h) out.header = h.innerText.replace(/\\s+/g, " ").trim().slice(0, 120);
  return out;
};
let last = "";
const sync = () => {
  try {
    const v = read();
    const k = JSON.stringify(v);
    if (k !== last) { last = k; st.set(v); }
  } catch {}
};
const loop = () => { sync(); requestAnimationFrame(loop); };
requestAnimationFrame(loop);
document.addEventListener("input", sync, true);
`;

const HEAD_INJECT = `<meta charset="utf-8" />
<script src="/__genclass/genclass.global.js" data-manual data-base="/__genclass/"></script>
<script>window.GenClass.init({ model: false, report: "silent", telemetry: false });</script>
<script type="module" src="/__genclass/boot.js"></script>`;

async function newContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies(["license-onboarding-dismissed", "license-banner-dismissed", "license-login-modal-dismissed"].map((name) => ({ name, value: "true", url: APP })));
  const r = await ctx.request.post(`${APP}/auth/login`, { data: { email: "admin@example.com", password: "hunt-admin-pw", mode: "session" } });
  if (r.status() !== 200) throw new Error(`login ${r.status()}`);
  await ctx.addInitScript((u) => (window.__GENCLASS_AGENT_URL__ = u), bridgeUrl);
  await ctx.route("**/__genclass/**", async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/__genclass\//, "");
    if (p === "boot.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: BOOT });
    const file = resolve(RT_DIST, p);
    if (!file.startsWith(RT_DIST)) return route.fulfill({ status: 404 });
    try {
      return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    } catch {
      return route.fulfill({ status: 404 });
    }
  });
  await ctx.route(/localhost:8080\/admin(\/|$)/, async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const res = await route.fetch();
    let body = await res.text();
    // Directus's vite.config.js always loads the Vue DevTools overlay; its 120 ms interval would keep the page from ever
    // being quiet. Dev tooling only: drop its two tags from the served page (no Directus source is changed).
    body = body.replace(/<script type="module" src="\/admin\/@id\/virtual:vue-(devtools|inspector)-path:[^"]*"><\/script>/g, "");
    body = body.replace('<meta charset="utf-8" />', HEAD_INJECT);
    return route.fulfill({ response: res, body, headers: { ...res.headers(), "content-length": String(Buffer.byteLength(body)) } });
  });
  return ctx;
}

const relatedLink = (page) => page.locator('.field[data-field="related"] a.item-link');
const backArrow = (page) => page.locator("header.header-bar .back-button a, header.header-bar .back-button button").first();
const shownTitle = (page) => page.locator('.field[data-field="title"] input').inputValue();

async function settle(page) {
  await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(30_000));
}

async function scenario(browser, n) {
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  // start at the Articles list and open article 1 from it, as a user does (this gives the item view in-app history, so
  // its header back arrow calls router.back(): item.vue lines 809-815)
  await page.goto(`${APP}/admin/content/articles`);
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 30_000 });
  await page.locator(".table-row", { hasText: "Alpha: launch checklist" }).waitFor({ timeout: 60_000 });
  await settle(page);
  await page.locator(".table-row", { hasText: "Alpha: launch checklist" }).click();
  await page.waitForURL(/articles\/1$/);
  await relatedLink(page).waitFor({ timeout: 60_000 });
  await page.locator('.field[data-field="related"] .preview', { hasText: "Bravo" }).waitFor({ timeout: 30_000 });
  await settle(page);
  const t0 = Date.now();
  if (SCENARIO === "nav-back") {
    await relatedLink(page).click();
    await page.waitForTimeout(GAP);
    await backArrow(page).click();
  } else if (SCENARIO === "nav-chain") {
    await relatedLink(page).click();
    await page.waitForURL(/articles\/2$/);
    await page.locator('.field[data-field="related"] .preview', { hasText: "Charlie" }).waitFor({ timeout: 30_000 });
    await settle(page);
    await relatedLink(page).click();
    await page.waitForURL(/articles\/3$/);
    await settle(page);
    await backArrow(page).click();
    await page.waitForTimeout(GAP);
    await backArrow(page).click();
  } else if (SCENARIO === "picker") {
    // choose Delta in the Related field's "Select Item" drawer, then --gap ms later reopen it and choose Echo
    const field = page.locator('.field[data-field="related"]');
    const choose = async (title) => {
      await field.locator("button.v-list-item").first().click();
      const drawer = page.locator(".v-drawer").last();
      await drawer.locator(".table-row", { hasText: title }).click({ timeout: 30_000 });
      await drawer.getByRole("button", { name: "Save" }).click();
      await drawer.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
    };
    await choose("Delta: onboarding");
    await page.waitForTimeout(GAP);
    await choose("Echo: security");
  } else if (SCENARIO === "autocomplete") {
    // clear the Topic field (that input takes the throttle's leading edge), let the 500 ms throttle window pass, then
    // type "rea" at --gap ms a key: at >= 500 ms each key sends its own request and opens the menu on its own answer
    const inp = page.locator('.field[data-field="topic"] input');
    await inp.click();
    await inp.fill("");
    await page.waitForTimeout(600);
    await inp.pressSequentially("rea", { delay: GAP });
  }
  await settle(page);
  await page.waitForTimeout(500);
  await settle(page);
  const result = await page.evaluate(() => {
    const val = (f) => document.querySelector(`.field[data-field="${f}"] input, .field[data-field="${f}"] textarea`)?.value ?? null;
    const text = (f) => document.querySelector(`.field[data-field="${f}"] .interface`)?.innerText.replace(/\s+/g, " ").trim() ?? null;
    return {
      url: location.pathname,
      title: val("title"),
      summary: val("summary"),
      topic: val("topic"),
      related: text("related"),
      header: document.querySelector("header.header-bar h1")?.innerText.replace(/\s+/g, " ").trim() ?? null,
      menu: [...document.querySelectorAll(".v-menu-content .v-list-item")].map((e) => e.innerText.trim()).slice(0, 12),
    };
  });
  result.ms = Date.now() - t0;
  result.errors = errors;
  await page.waitForTimeout(600); // the last snapshot batch reaches the bridge
  await ctx.close();
  console.error(`run ${n}: ${JSON.stringify(result)}`);
  return result;
}

// The document is fulfilled through page.route, so Chromium treats it as a public page and its Local Network Access
// checks would block the page's calls to the loopback bridge (and Vite's websocket): turn those checks off here.
const browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests"] });
const summary = { scenario: SCENARIO, gapMs: GAP, slowMs: SLOW, runs: RUNS, started: new Date().toISOString() };
// warm-up page load (Vite module graph), not part of the session
await scenario(browser, 0).catch((e) => console.error("warm-up failed", String(e).slice(0, 300)));
const startArgs = { action: "start", runs: RUNS, route: "/admin/content/articles" };
if (SLOW > 0) startArgs.slow_ms = SLOW;
summary.start = await tool("genclass_explore", startArgs);
console.error(summary.start);
summary.results = [];
for (let i = 1; i <= RUNS + 2; i++) {
  try {
    summary.results.push(await scenario(browser, i));
  } catch (e) {
    summary.results.push({ failed: String(e).slice(0, 300) });
    console.error(`run ${i} failed`, String(e).slice(0, 300));
  }
}
summary.report = await tool("genclass_explore", { action: "report" });
console.error(summary.report);
const fid = /Race finding\(s\): (f\d+)/.exec(summary.report)?.[1];
summary.verdict = /RACE: (\d+) of (\d+)/.exec(summary.report)?.slice(1).join("/") ?? "no race";
if (fid) summary.explain = await tool("genclass_explain", { id: fid });
summary.findings = await tool("genclass_findings", {});
await browser.close();
await served.close();
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
}
console.log(JSON.stringify({ scenario: SCENARIO, gap: GAP, slow: SLOW, verdict: summary.verdict, finals: summary.results.map((r) => r.failed ? "FAILED" : `${r.url}|${r.title}`) }));
process.exit(0);

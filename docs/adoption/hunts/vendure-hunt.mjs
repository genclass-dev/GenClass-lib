// Duplicate-submit hunt on Vendure's React dashboard (docs/adoption/hunts/vendure.md). Not part of CI.
//
// For each entity page and click gap it opens the page in headless Chromium, fills the form, presses the Create (or
// Update) button twice with raw input events sent `gap` ms apart through CDP (Input.dispatchMouseEvent, clickCount 1
// then 2: a double-click; the second press is not held back until the page has handled the first, just as a person's
// is not; a disabled button ignores it), and records three independent counts:
//   wire     create/update mutations the page sent to /admin-api (Playwright's request log)
//   db       rows written, read from the dev server's SQLite file (better-sqlite3 from Vendure's node_modules)
//   genclass identical-in-flight witnesses of the agent link (GenClass's script-tag build injected through
//            page.route on a virtual same-origin path, model off, telemetry off, hold: false: nothing is delayed)
// GENCLASS=0 runs the same trials without GenClass (the control: the wire and db counts must not depend on it).
//
// Needs: both GenClass packages built (npm run build -w @genclass/runtime && npm run build -w @genclass/mcp) and a
// Vendure dev server (cd packages/dev-server && DB=sqlite bun run dev:direct) with its dashboard at BASE.
//
//   VENDURE=/path/to/vendure node docs/adoption/hunts/vendure-hunt.mjs
//
// Env: BASE (http://localhost:5173/dashboard), VENDURE (checkout, for the SQLite file and better-sqlite3), TRIALS (10),
// GAPS (0,30,80,150), ENTITIES (collection,product,facet,customer), ACTIONS (create,update), GENCLASS (1), LATENCY (0:
// added request latency in ms through CDP Network.emulateNetworkConditions, a server that far away), LABEL, OUT (a
// JSON file for the raw trials).

import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const rtDist = join(repo, "packages/runtime/dist");
const BASE = (process.env.BASE ?? "http://localhost:5173/dashboard").replace(/\/+$/, "");
const ORIGIN = new URL(BASE).origin;
const VENDURE = resolve(process.env.VENDURE ?? join(repo, "../vendurehq/vendure"));
const TRIALS = Number(process.env.TRIALS ?? 10);
const GAPS = (process.env.GAPS ?? "0,30,80,150").split(",").map(Number);
const ENTITIES = (process.env.ENTITIES ?? "collection,product,facet,customer").split(",");
const ACTIONS = (process.env.ACTIONS ?? "create,update").split(",");
const WITH_GENCLASS = process.env.GENCLASS !== "0";
const LATENCY = Number(process.env.LATENCY ?? 0);
const LABEL = process.env.LABEL ?? "run";
const RUN = `${LABEL}-${Date.now().toString(36)}`;

const Database = createRequire(join(VENDURE, "packages/dev-server/package.json"))("better-sqlite3");
const db = new Database(join(VENDURE, "packages/dev-server/vendure.sqlite"), { readonly: true, fileMustExist: true });
const one = (sql, ...a) => db.prepare(sql).get(...a).n;

// --------------------------------------------------------------------------- the pages under test
// update targets are rows of the populated dev database (populate-dev-server.ts)
const PAGES = {
  collection: {
    create: "collections/new",
    update: "collections/2",
    createOp: "createCollection",
    updateOp: "updateCollection",
    fill: (page, v) => page.locator("#field-name").fill(v),
    created: (v) => one("select count(distinct baseId) n from collection_translation where name = ?", v),
  },
  product: {
    create: "products/new",
    update: "products/1",
    createOp: "createProduct",
    updateOp: "updateProduct",
    fill: (page, v) => page.locator("#field-name").fill(v),
    created: (v) => one("select count(distinct t.baseId) n from product_translation t join product p on p.id = t.baseId where t.name = ? and p.deletedAt is null", v),
  },
  facet: {
    create: "facets/new",
    update: "facets/2",
    createOp: "createFacet",
    updateOp: "updateFacet",
    fill: (page, v) => page.locator("#field-name").fill(v),
    created: (v) => one("select count(distinct baseId) n from facet_translation where name = ?", v),
  },
  customer: {
    create: "customers/new",
    update: "customers/1",
    createOp: "createCustomer",
    updateOp: "updateCustomer",
    fill: async (page, v, action) => {
      if (action === "create") {
        await page.locator("#field-firstName").fill("Hunt");
        await page.locator("#field-emailAddress").fill(`${v.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@example.com`);
      }
      await page.locator("#field-lastName").fill(v);
    },
    created: (v) => one("select count(*) n from customer where lastName = ? and deletedAt is null", v),
  },
};

// --------------------------------------------------------------------------- the bridge (the MCP server, in-process)
let bridgeUrl = null;
let tool = async () => "";
if (WITH_GENCLASS) {
  const { serve } = await import(join(repo, "packages/mcp/dist/index.js"));
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
  bridgeUrl = `http://127.0.0.1:${served.port}`;
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
  tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vendure-hunt", version: "1" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
}

// --------------------------------------------------------------------------- the browser
// A document fulfilled through page.route loses its loopback address space, so Chromium's Local Network Access check
// would block the dashboard's calls to the API on another localhost port. Turning the check off changes nothing else.
const browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks"] });
const TYPES = { ".js": "text/javascript", ".map": "application/json", ".wasm": "application/wasm" };
const INJECT =
  `<script src="/__genclass/genclass.global.js" data-model="off" data-telemetry="off" data-report="silent" data-visual="off" data-analytics="off"></script>` +
  `<script type="module">import { connectAgent } from "/__genclass/agent.js"; connectAgent(window.GenClass.runtime, { hold: false });</script>`;

async function login() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.locator('input[name="username"]').fill("superadmin");
  await page.locator('input[name="password"]').fill("superadmin");
  await page.getByRole("button", { name: /sign in|log in|login/i }).click();
  await page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 20_000 });
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}
const storageState = await login();
const ctx = await browser.newContext({ storageState });
if (WITH_GENCLASS) {
  await ctx.addInitScript((u) => (window.__GENCLASS_AGENT_URL__ = u), bridgeUrl);
  // the virtual same-origin path for GenClass's files: nothing is added to the app's server or source
  await ctx.route(`${ORIGIN}/__genclass/**`, async (route) => {
    const rel = new URL(route.request().url()).pathname.slice("/__genclass/".length);
    const file = resolve(rtDist, rel);
    if (!file.startsWith(rtDist)) return route.fulfill({ status: 404 });
    try {
      await route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  // the dashboard's HTML document: the two tags go first in <head>, so GenClass sees the app's first request
  await ctx.route((u) => u.origin === ORIGIN && u.pathname.startsWith(new URL(BASE).pathname), async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const res = await route.fetch();
    const html = (await res.text()).replace(/<head([^>]*)>/i, (m) => `${m}${INJECT}`);
    await route.fulfill({ response: res, body: html, headers: { ...res.headers(), "content-length": String(Buffer.byteLength(html)) } });
  });
}
// the press times and the button's disabled state at each press, in the page's own clock
await ctx.addInitScript(() => {
  window.__HUNT__ = [];
  addEventListener(
    "pointerdown",
    (e) => {
      if (!(e.target instanceof Element)) return;
      const b = e.target.closest("button[type=submit]");
      const hit = b ?? e.target;
      window.__HUNT__.push({ t: e.timeStamp, submit: !!b, disabled: !!b?.disabled, hit: `${hit.tagName.toLowerCase()} ${(hit.textContent ?? "").trim().slice(0, 24)}` });
    },
    true,
  );
});

// --------------------------------------------------------------------------- one trial
async function trial(entity, action, gap, i) {
  const spec = PAGES[entity];
  const op = action === "create" ? spec.createOp : spec.updateOp;
  const value = `Hunt ${RUN} ${entity} ${action} g${gap} t${i}`;
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  if (LATENCY > 0) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
  }
  const sent = [];
  const answered = [];
  page.on("request", (r) => {
    if (r.method() !== "POST" || !r.url().includes("/admin-api")) return;
    const body = r.postData() ?? "";
    if (new RegExp(`\\b${op}\\s*\\(`).test(body) && /mutation/.test(body)) sent.push(r);
  });
  page.on("response", async (r) => {
    if (!sent.includes(r.request())) return;
    let ok = false;
    let error = null;
    try {
      const j = await r.json();
      const d = j?.data?.[op];
      ok = !!d && !d.errorCode && !j.errors;
      error = j.errors?.[0]?.message ?? d?.message ?? null;
    } catch (e) {
      error = String(e);
    }
    answered.push({ ok, error });
  });
  await page.goto(`${BASE}/${spec[action]}`);
  if (WITH_GENCLASS) await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
  const label = action === "create" ? "Create" : "Update";
  const button = page.getByRole("button", { name: label, exact: true });
  await button.waitFor({ state: "visible", timeout: 20_000 });
  await spec.fill(page, value, action);
  await page.waitForFunction((l) => [...document.querySelectorAll("button[type=submit]")].some((b) => b.textContent.trim() === l && !b.disabled), label, { timeout: 15_000 });
  const before = action === "create" ? spec.created(value) : null;
  const box = await button.boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2, button: "left" };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  // two presses, `gap` ms apart, the second sent without waiting for the page to handle the first
  const press = (clickCount) => [
    cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", clickCount, ...at }),
    cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", clickCount, ...at }),
  ];
  const first = press(1);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  await Promise.all([...first, ...press(2)]);
  // wait for every sent mutation to be answered, then for the page to go quiet
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000 && (sent.length === 0 || answered.length < sent.length)) await page.waitForTimeout(50);
  await page.waitForTimeout(1500);
  let witnesses = [];
  if (WITH_GENCLASS) {
    await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(10_000)).catch(() => false);
    witnesses = await page
      .evaluate(() => window.__GENCLASS_AGENT__.witnesses().filter((w) => w.kind === "identical-in-flight").map((w) => ({ gapMs: w.gapMs, detail: w.byDetail ?? "" })))
      .catch(() => []);
    await page.waitForTimeout(400); // the last batch reaches the bridge
  }
  const presses = await page.evaluate(() => window.__HUNT__);
  const created = action === "create" ? spec.created(value) - before : null;
  await cdp.detach().catch(() => {});
  await page.close();
  return {
    entity,
    action,
    gap,
    i,
    pressGapMs: presses.length >= 2 ? Math.round(presses[1].t - presses[0].t) : null,
    secondPress: presses.length >= 2 ? (presses[1].submit ? (presses[1].disabled ? "disabled button" : "enabled button") : presses[1].hit) : "not seen",
    wire: sent.length,
    ok: answered.filter((a) => a.ok).length,
    errors: answered.filter((a) => !a.ok).map((a) => a.error),
    created,
    // the mutation pair, and other identical pairs (an Update's detail query refetched by both responses)
    genclass: witnesses.filter((w) => /mutation/.test(w.detail)).length,
    genclassOther: witnesses.filter((w) => !/mutation/.test(w.detail)).length,
    witnesses,
  };
}

// --------------------------------------------------------------------------- the sweep
const rows = [];
for (const action of ACTIONS)
  for (const entity of ENTITIES)
    for (const gap of GAPS)
      for (let i = 0; i < TRIALS; i++) {
        let r;
        try {
          r = await trial(entity, action, gap, i);
        } catch (e) {
          r = { entity, action, gap, i, failed: String(e).split("\n")[0] };
        }
        rows.push(r);
        console.log(JSON.stringify(r));
      }

// --------------------------------------------------------------------------- the table
const summary = [];
for (const action of ACTIONS)
  for (const entity of ENTITIES)
    for (const gap of GAPS) {
      const rs = rows.filter((r) => r.action === action && r.entity === entity && r.gap === gap && !r.failed);
      const sum = (k) => rs.reduce((a, r) => a + (r[k] ?? 0), 0);
      const gaps = rs.map((r) => r.pressGapMs).filter((g) => g !== null).sort((a, b) => a - b);
      summary.push({
        action,
        entity,
        gap,
        trials: rs.length,
        failed: rows.filter((r) => r.action === action && r.entity === entity && r.gap === gap && r.failed).length,
        medianPressGapMs: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
        trialsWithTwoMutations: rs.filter((r) => r.wire >= 2).length,
        mutations: sum("wire"),
        created: action === "create" ? sum("created") : null,
        trialsWithDuplicateEntity: action === "create" ? rs.filter((r) => r.created >= 2).length : null,
        trialsWithGenclassDuplicate: WITH_GENCLASS ? rs.filter((r) => r.genclass > 0).length : null,
        trialsWithOtherGenclassPairs: WITH_GENCLASS ? rs.filter((r) => r.genclassOther > 0).length : null,
        secondPressOnEnabledButton: rs.filter((r) => r.secondPress === "enabled button").length,
      });
    }
console.table(summary);
const findings = WITH_GENCLASS ? await tool("genclass_findings", {}) : null;
if (findings) console.log(findings);
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ label: LABEL, run: RUN, base: BASE, latency: LATENCY, genclass: WITH_GENCLASS, summary, rows, findings }, null, 2));
await browser.close();
db.close();
process.exit(0);

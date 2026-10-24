// The GenClass race hunt on Strapi's admin panel (docs/adoption/hunts/strapi.md). Not part of CI.
//
// It drives a locally running Strapi (STRAPI_URL, default http://localhost:1337) in headless Chromium with the real
// @genclass/runtime script-tag build and the agent entry injected into the admin's HTML by Playwright (Strapi's source
// is untouched), the real @genclass/mcp server in-process (its bridge on a free port), and the same tool calls a coding
// agent makes: genclass_explore start → one page load per armed run → report → genclass_explain → genclass_replay.
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp     # in GenClass-lib
//   node docs/adoption/hunts/strapi/hunt.mjs login                           # once: saves the admin session
//   node docs/adoption/hunts/strapi/hunt.mjs probe /admin/content-manager/collection-types/api::article.article
//   node docs/adoption/hunts/strapi/hunt.mjs once <scenario>                 # one natural load, the recording printed
//   node docs/adoption/hunts/strapi/hunt.mjs explore <scenario> <slow_ms> [runs]
//   node docs/adoption/hunts/strapi/hunt.mjs replay <scenario> <finding id>
//
// Scenarios (one page load each; repeated once per armed run): see SCENARIOS below. The deep-link scenarios load the
// content manager URL directly; the action scenarios load the admin home, wait until it is quiet, then move to the
// content manager without a page load (history.pushState + popstate, which React Router follows), so the admin's
// own start-up requests are not part of what the actions' responses are reordered with. Besides the explore verdict,
// every run records a DOM oracle of its own (the visible rows / options / status, read after the page settled),
// compared across the fifo and seeded runs by this script: a secondary oracle, labelled as such in the report.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { chromium } from "@playwright/test";
import { serve } from "../../../../packages/mcp/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const rtDist = join(repo, "packages/runtime/dist");
const APP = (process.env.STRAPI_URL ?? "http://localhost:1337").replace(/\/+$/, "");
const OUT = process.env.HUNT_OUT ?? "/home/user/strapi-hunt/out";
const STATE = join(OUT, "storageState.json");
const EMAIL = process.env.STRAPI_EMAIL ?? "hunt@example.com";
const PASSWORD = process.env.STRAPI_PASSWORD ?? "HuntPassw0rd!";
const MODEL = "api::article.article";
const LIST = `/admin/content-manager/collection-types/${MODEL}`;
const LIST_Q = "?page=1&pageSize=10&sort=id:ASC";
const FORBIDDEN = "You don't have the permissions to access that content";
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".map": "application/json", ".wasm": "application/wasm" };
mkdirSync(OUT, { recursive: true });

// --------------------------------------------------------------------------- the MCP server, driven like an agent
let served = null;
let input;
let id = 0;
const lines = [];
async function startServer() {
  input = new PassThrough();
  const output = new PassThrough();
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
  // the bridge's state (runs, findings) persists in this directory, so a later invocation can replay a finding
  served = await serve({ cwd: OUT, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: join(OUT, process.env.HUNT_STATE ?? "state") });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "strapi-hunt", version: "1" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return `http://127.0.0.1:${served.port}`;
}
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

// --------------------------------------------------------------------------- the admin API (seed lookups)
function adminToken() {
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  for (const o of st.origins ?? []) for (const e of o.localStorage ?? []) if (e.name === "jwtToken") return JSON.parse(e.value);
  throw new Error("no jwtToken in the saved session; run: hunt.mjs login");
}
async function api(path) {
  const r = await fetch(APP + path, { headers: { authorization: `Bearer ${adminToken()}` } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
/** The edit view of the first seeded article ("React guide 1"). */
async function editUrl() {
  const d = await api(`/content-manager/collection-types/${MODEL}?page=1&pageSize=1&_q=${encodeURIComponent("React guide 1")}`);
  const doc = d.results?.find((r) => r.title === "React guide 1") ?? d.results?.[0];
  if (!doc) throw new Error("the seed article is missing");
  return `${LIST}/${doc.documentId}`;
}

// --------------------------------------------------------------------------- injection (Strapi's files untouched)
function tags(bridgeUrl) {
  // the runtime: observe mode, no model (nothing to download; explore needs none), no telemetry, no visual checks;
  // automatic state discovery is on by default in the script-tag build and installs before react-dom evaluates
  const cfg = { telemetry: false, mode: "observe", model: false, visual: false, devtools: false, report: "console" };
  return (
    `<script>window.GENCLASS_CONFIG=${JSON.stringify(cfg)};window.__GENCLASS_AGENT_URL__=${JSON.stringify(bridgeUrl)};</script>` +
    `<script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script>` +
    `<script type="module">import{connectAgent}from"/__genclass/agent.js";window.__GENCLASS_CONN__=connectAgent(window.GenClass.runtime,{url:${JSON.stringify(bridgeUrl)}});</script>`
  );
}
async function inject(context, bridgeUrl) {
  // hermetic runs: the admin asks api.github.com for Strapi's latest release on every load (and gets a 403 "rate limit
  // exceeded" from this machine); nothing but the local server and the bridge is reachable
  await context.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => route.abort());
  await context.route("**/__genclass/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/__genclass\//, "");
    const file = resolve(rtDist, p);
    if (!file.startsWith(rtDist) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  await context.route(
    (url) => url.pathname === "/admin" || url.pathname.startsWith("/admin/"),
    async (route) => {
      const req = route.request();
      if (req.resourceType() !== "document") return route.continue();
      const res = await route.fetch();
      const ct = res.headers()["content-type"] ?? "";
      if (!ct.includes("text/html")) return route.fulfill({ response: res });
      const html = await res.text();
      return route.fulfill({ response: res, body: html.replace(/<head>/i, `<head>${bridgeUrl ? tags(bridgeUrl) : ""}`) });
    },
  );
}

async function newPage(browser, bridgeUrl, { state = true } = {}) {
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1400, height: 900 }, ...(state && existsSync(STATE) ? { storageState: STATE } : {}) });
  await inject(ctx, bridgeUrl);
  // the guided tour a new admin sees once: its step tooltip comes with a full-screen transparent backdrop that
  // takes every click until the tour is advanced or skipped, so the harness marks the tours as done beforehand
  await ctx.addInitScript(() => {
    try {
      const done = { currentStep: 0, isCompleted: true };
      localStorage.setItem("STRAPI_GUIDED_TOUR", JSON.stringify({ tours: { contentTypeBuilder: done, contentManager: done, apiTokens: done, strapiCloud: done }, enabled: false, hidden: true, completedActions: [] }));
    } catch {
      /* ignore */
    }
  });
  const page = await ctx.newPage();
  const log = [];
  page.on("console", (m) => {
    const t = m.type();
    const text = m.text();
    if (/React Router Future Flag|useRBAC: The first argument/.test(text)) return; // the admin's own dev warnings, every load
    if (t === "error" || t === "warning" || /genclass/i.test(text)) log.push(`${t}: ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => log.push(`pageerror: ${String(e.message ?? e).slice(0, 300)}`));
  return { ctx, page, log };
}

/** Log in through the admin's form in a fresh context and save the session (cookies, localStorage) to STATE. */
async function login(browser) {
  const { ctx, page } = await newPage(browser, null, { state: false });
  await page.goto(APP + "/admin/auth/login");
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/^password/i).fill(PASSWORD);
  const remember = page.getByLabel(/remember me/i);
  if (await remember.count()) await remember.check();
  await page.getByRole("button", { name: /log ?in/i }).click();
  await page.waitForURL((u) => !/\/admin\/auth\//.test(u.pathname), { timeout: 60_000 });
  await page.waitForTimeout(1000);
  await ctx.storageState({ path: STATE });
  await ctx.close();
}
/** The admin's access token lasts 30 minutes and the saved refresh cookie does not survive its rotation: a session older than 10 minutes is renewed. */
async function freshLogin(browser) {
  let age = Infinity;
  try {
    age = Date.now() - statSync(STATE).mtimeMs;
  } catch {
    /* no session yet */
  }
  if (age > 10 * 60_000) {
    await login(browser);
    console.log("logged in again (saved session was", Math.round(age / 60_000), "min old)");
  }
}

/** Move within the loaded admin without a page load (React Router follows popstate), so the run stays one recording. */
async function nav(page, url) {
  await page.evaluate((u) => {
    const idx = (history.state && history.state.idx) ?? 0;
    history.pushState({ idx: idx + 1, usr: null, key: `gc${idx + 1}` }, "", u);
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, url);
}
const settle = (page, ms = 25_000) => page.evaluate((t) => window.__GENCLASS_AGENT__.whenSettled(t), ms);
const forbidden = (page) => page.getByText(FORBIDDEN).isVisible().catch(() => false);
/** Until `loc` is visible or the 403 page is (polled: a Promise.race of two waitFors kept the loser's timer running). */
async function readyOr403(page, loc, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await loc.isVisible().catch(() => false)) || (await forbidden(page))) return;
    if (/\/admin\/auth\//.test(new URL(page.url()).pathname)) throw new Error(`the admin asked for a login (session expired): ${page.url()}`);
    await page.waitForTimeout(150);
  }
  const text = await page.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 400)).catch(() => "?");
  throw new Error(`not ready after ${timeoutMs} ms: neither ${String(loc)} nor the 403 page; the page shows: ${JSON.stringify(text)}`);
}
const listReady = (page) => readyOr403(page, page.locator("table tbody tr").first());
const editReady = (page) => readyOr403(page, page.getByRole("textbox", { name: /^title/i }));
const rows = async (page) => page.locator("table tbody tr").evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).slice(1, -1).map((td) => td.textContent.replace(/\s+/g, " ").trim()).join(" | ")));
const listOracle = async (page) => ({
  path: new URL(page.url()).pathname,
  query: new URL(page.url()).search,
  heading: await page.locator("main h1").first().textContent({ timeout: 1500 }).catch(() => null),
  forbidden: await forbidden(page),
  count: await page.getByText(/entr(y|ies) found/).first().textContent({ timeout: 1500 }).catch(() => null),
  rows: await rows(page),
});
const pickerOracle = async (page) => ({
  path: new URL(page.url()).pathname,
  forbidden: await forbidden(page),
  value: await page.getByRole("combobox", { name: /author/i }).first().inputValue({ timeout: 1500 }).catch(() => null),
  options: await page.getByRole("option").allTextContents(),
});

// --------------------------------------------------------------------------- scenarios
// start: "home" loads /admin and moves to `path` without a page load once the admin is quiet; "direct" loads `path`.
const SCENARIOS = {
  // the content manager list, opened by its URL (a bookmark, a reload, the redirect after login): no action
  "load-list": { start: "direct", path: LIST + LIST_Q, ready: listReady, steps: async () => {}, oracle: listOracle },
  // the edit view of one entry, opened by its URL: no action
  "load-edit": { start: "direct", path: editUrl, ready: editReady, steps: async () => {}, oracle: pickerOracle },
  // (a) the list search, typed one key at a time (the admin's SearchInput submits on Enter, not per keystroke), then
  // a second query typed and submitted at once, so two list requests with different _q overlap
  search: {
    start: "home",
    path: LIST + LIST_Q,
    ready: listReady,
    steps: async (page) => {
      await page.getByRole("button", { name: "Search", exact: true }).click();
      const box = page.locator("main").getByRole("searchbox").first();
      await box.pressSequentially("react", { delay: 90 });
      await box.press("Enter");
      await box.pressSequentially("ux", { delay: 90 }); // "reactux": no entry matches
      for (let i = 0; i < 7; i++) await box.press("Backspace");
      await box.pressSequentially("redux", { delay: 90 });
      await box.press("Enter");
    },
    oracle: listOracle,
  },
  // (b) rapid sort changes through the column headers
  sort: {
    start: "home",
    path: LIST + LIST_Q,
    ready: listReady,
    steps: async (page) => {
      const header = (name) => page.locator("table thead th", { hasText: new RegExp(`^${name}$`) }).first();
      await header("title").click();
      await header("rank").click();
      await header("title").click();
      await header("rank").click();
    },
    oracle: listOracle,
  },
  // (b') rapid filter changes: the status filter added, then removed, then added again
  filter: {
    start: "home",
    path: LIST + LIST_Q,
    ready: listReady,
    steps: async (page) => {
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.getByRole("combobox", { name: "Select field" }).click();
      await page.getByRole("option", { name: "rank", exact: true }).click();
      await page.getByRole("textbox", { name: "rank" }).fill("5");
      await page.getByRole("button", { name: "Add filter" }).click();
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.getByRole("combobox", { name: "Select field" }).click();
      await page.getByRole("option", { name: "title", exact: true }).click();
      await page.getByRole("textbox", { name: "title" }).fill("React");
      await page.getByRole("button", { name: "Add filter" }).click();
    },
    oracle: listOracle,
  },
  // (e) rapid pagination: three clicks on the next-page link before the first response lands
  pagination: {
    start: "home",
    path: LIST + LIST_Q,
    ready: listReady,
    steps: async (page) => {
      const next = page.getByRole("link", { name: /next page/i });
      await next.click();
      await next.click();
      await next.click();
    },
    oracle: listOracle,
  },
  // (c) the relation picker's async search: typed slower than its 300 ms debounce, so every key sends a request
  "relation-search": {
    start: "home",
    path: editUrl,
    ready: editReady,
    steps: async (page) => {
      const box = page.getByRole("combobox", { name: /author/i }).first();
      await box.click();
      await box.pressSequentially("re", { delay: 350 });
      await page.getByRole("option").first().waitFor({ timeout: 15_000 }).catch(() => {});
    },
    oracle: pickerOracle,
  },
  // (c') the same picker typed at 80 ms a key (one debounced request)
  "relation-search-fast": {
    start: "home",
    path: editUrl,
    ready: editReady,
    steps: async (page) => {
      const box = page.getByRole("combobox", { name: /author/i }).first();
      await box.click();
      await box.pressSequentially("ra", { delay: 80 }); // "ri" matched only the author already connected (omitted from the picker)
      await page.getByRole("option").first().waitFor({ timeout: 15_000 }).catch(() => {});
    },
    oracle: pickerOracle,
  },
  // (d) a double click on Save, then on Publish, in the edit view (the title gets a new value each run; its digits
  // are blanked by the comparison, so the shape is the same on every run). Run last: it changes the seed entry.
  "double-save": {
    start: "home",
    path: editUrl,
    ready: editReady,
    steps: async (page, i) => {
      const title = page.getByRole("textbox", { name: /^title/i });
      await title.fill(`React guide 1 edit ${i + 1} ${Date.now() % 100000}`); // always a change: digits are blanked in the comparison
      await page.getByRole("button", { name: "Save", exact: true }).dblclick();
      await settle(page, 20_000);
      await page.getByRole("button", { name: "Publish", exact: true }).dblclick();
    },
    oracle: async (page) => ({
      path: new URL(page.url()).pathname,
      title: await page.getByRole("textbox", { name: /^title/i }).inputValue({ timeout: 1500 }).catch(() => null),
      status: await page.locator("main").getByText(/^(Draft|Published|Modified)$/).first().textContent({ timeout: 1500 }).catch(() => null),
      saveDisabled: await page.getByRole("button", { name: "Save", exact: true }).isDisabled({ timeout: 1500 }).catch(() => null),
      publishDisabled: await page.getByRole("button", { name: "Publish", exact: true }).isDisabled({ timeout: 1500 }).catch(() => null),
      notifications: await page.locator("[role=status], [role=alert]").allTextContents(),
    }),
  },
};

// --------------------------------------------------------------------------- one page load (one run)
async function load(browser, bridgeUrl, scenario, i) {
  const { ctx, page, log } = await newPage(browser, bridgeUrl);
  const t0 = Date.now();
  const out = { i, log };
  try {
    const path = typeof scenario.path === "function" ? await scenario.path() : scenario.path;
    if (scenario.start === "home") {
      await page.goto(APP + "/admin");
      await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 60_000 });
      await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 60_000 });
      await settle(page, 30_000);
      await nav(page, path);
    } else {
      await page.goto(APP + path);
      await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 60_000 });
    }
    out.schedule = await page.evaluate(() => window.__GENCLASS_AGENT__.schedule);
    out.run = await page.evaluate(() => window.__GENCLASS_AGENT__.run);
    out.t = { connected: Date.now() - t0 };
    await scenario.ready(page);
    out.t.ready = Date.now() - t0;
    out.forbidden = await forbidden(page);
    if (!out.forbidden) await scenario.steps(page, i);
    out.t.steps = Date.now() - t0;
    out.settled = await settle(page);
    out.t.settled = Date.now() - t0;
    out.path = new URL(page.url()).pathname;
    out.oracle = await scenario.oracle(page);
    out.snapshot = await page.evaluate(() => {
      const s = window.__GENCLASS_AGENT__.snapshot();
      const rec = window.__GENCLASS_AGENT__.recorded();
      return {
        stateFields: Object.keys(s.state).length,
        stores: [...new Set(Object.keys(s.state).map((k) => k.split(".")[0]))].slice(0, 60),
        requests: s.requests,
        witnesses: window.__GENCLASS_AGENT__.witnesses().map((w) => `${w.kind} ${w.subject} by ${w.by}`),
        errors: s.errors,
        forced: s.forced,
        acts: rec.steps.filter((x) => x.k === "act").map((a) => `${a.kind} ${a.target ?? ""}${a.value !== undefined ? ` = ${a.value}` : ""}${a.clicks > 1 ? ` x${a.clicks}` : ""}`),
        sends: rec.steps.filter((x) => x.k === "send").length,
        order: rec.order,
      };
    });
    await page.waitForTimeout(600); // the last batch and the end reach the bridge
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 2000);
  }
  out.ms = Date.now() - t0;
  await ctx.close();
  return out;
}
const summary = (l) =>
  `load ${l.i}: ${l.schedule ? `${l.schedule.order}${l.schedule.seed !== undefined ? ` seed ${l.schedule.seed}` : ""}` : "no schedule"} path=${l.path ?? "?"} forbidden=${l.forbidden} settled=${l.settled} acts=${l.snapshot?.acts?.length} sends=${l.snapshot?.sends} witnesses=${l.snapshot?.witnesses?.length} forced=${l.snapshot?.forced} state=${l.snapshot?.stateFields} ${l.ms} ms${l.t ? ` (connected ${l.t.connected}, ready ${l.t.ready}, steps ${l.t.steps}, settled ${l.t.settled})` : ""}${l.error ? ` ERROR ${l.error.slice(0, 300)}` : ""}${l.log?.length ? ` log=${JSON.stringify(l.log.slice(0, 3))}` : ""}`;

// --------------------------------------------------------------------------- the DOM oracle comparison (secondary)
function compareOracles(loads) {
  const key = (l) => JSON.stringify(l.oracle ?? null);
  const fifo = loads.filter((l) => l.schedule?.order === "fifo");
  const seeded = loads.filter((l) => l.schedule?.order === "seeded");
  const baseKeys = new Set(fifo.map(key));
  return {
    baselines: fifo.length,
    baselinesAgree: baseKeys.size <= 1,
    seeded: seeded.length,
    seededDiffering: seeded.filter((l) => !baseKeys.has(key(l))).map((l) => ({ i: l.i, seed: l.schedule?.seed, oracle: l.oracle })),
  };
}

// --------------------------------------------------------------------------- commands
const cmd = process.argv[2];
// --no-proxy-server: the container's HTTPS proxy must not see localhost. The Local Network Access checks are off
// because a document Playwright fulfilled has no address space of its own, so Chromium would refuse the page's
// requests to the loopback bridge (it did: "Permission was denied for this request to access the loopback address
// space"); a developer's own page, served from localhost, is not affected.
const browser = await chromium.launch({ args: ["--no-proxy-server", "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers"] });

if (cmd === "login") {
  await login(browser);
  console.log("saved", STATE);
} else if (cmd === "probe") {
  const bridgeUrl = await startServer();
  const { ctx, page, log } = await newPage(browser, bridgeUrl);
  await page.goto(APP + (process.argv[3] ?? LIST));
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 60_000 }).catch((e) => console.log("not connected:", e.message));
  await page.waitForTimeout(Number(process.argv[4] ?? 4000));
  if (process.argv[5]) for (const html of await page.locator(process.argv[5]).evaluateAll((els) => els.map((e) => e.outerHTML.slice(0, 3000)))) console.log(html);
  else console.log(await page.locator("body").ariaSnapshot());
  console.log(await page.evaluate(() => JSON.stringify({ conn: window.__GENCLASS_AGENT__?.connected, run: window.__GENCLASS_AGENT__?.run, schedule: window.__GENCLASS_AGENT__?.schedule, stateFields: Object.keys(window.__GENCLASS_AGENT__?.snapshot().state ?? {}).length })));
  console.log(await tool("genclass_status"));
  console.log(log.join("\n"));
  await ctx.close();
} else if (cmd === "once") {
  const scenario = SCENARIOS[process.argv[3]];
  if (!scenario) throw new Error(`unknown scenario; one of ${Object.keys(SCENARIOS).join(", ")}`);
  await freshLogin(browser);
  const bridgeUrl = await startServer();
  const l = await load(browser, bridgeUrl, scenario, 0);
  console.log(summary(l));
  console.log(JSON.stringify({ oracle: l.oracle, acts: l.snapshot?.acts, requests: l.snapshot?.requests, order: l.snapshot?.order, witnesses: l.snapshot?.witnesses, stores: l.snapshot?.stores, log: l.log, error: l.error }, null, 1));
} else if (cmd === "explore") {
  const name = process.argv[3];
  const slow = Number(process.argv[4] ?? 600);
  const runs = Number(process.argv[5] ?? 6);
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}; one of ${Object.keys(SCENARIOS).join(", ")}`);
  await freshLogin(browser);
  const bridgeUrl = await startServer();
  const result = { scenario: name, slow_ms: slow, runs, startedAt: new Date().toISOString(), loads: [] };
  result.start = await tool("genclass_explore", { action: "start", runs, slow_ms: slow });
  console.log(result.start.split("\n")[0]);
  for (let i = 0; i < runs + 2; i++) {
    const l = await load(browser, bridgeUrl, scenario, i);
    result.loads.push(l);
    console.log(summary(l));
    if (i === 0) result.status = await tool("genclass_status");
  }
  result.report = await tool("genclass_explore", { action: "report" });
  console.log(result.report);
  result.oracle = compareOracles(result.loads);
  console.log("DOM oracle (secondary):", JSON.stringify({ ...result.oracle, seededDiffering: result.oracle.seededDiffering.map((d) => `${d.i} (seed ${d.seed})`) }));
  const fids = [...new Set([...result.report.matchAll(/\b(f\d+)\b/g)].map((m) => m[1]))];
  result.findings = await tool("genclass_findings", { limit: 20 });
  if (/RACE:/.test(result.report) && fids.length) {
    result.explain = {};
    for (const fid of fids) result.explain[fid] = await tool("genclass_explain", { id: fid });
    console.log(result.explain[fids[0]]);
    // replay the first race finding: arm, one load, result
    const fid = fids[0];
    result.replay = { id: fid, arm: await tool("genclass_replay", { action: "arm", id: fid }) };
    result.replay.load = await load(browser, bridgeUrl, scenario, runs + 2);
    console.log(summary(result.replay.load));
    result.replay.result = await tool("genclass_replay", { action: "result", id: fid });
    console.log(result.replay.result);
  }
  const file = join(OUT, `${name}-${slow}${process.env.HUNT_TAG ? `-${process.env.HUNT_TAG}` : ""}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log("wrote", file);
} else if (cmd === "replay") {
  const scenario = SCENARIOS[process.argv[3]];
  const fid = process.argv[4];
  await freshLogin(browser);
  const bridgeUrl = await startServer();
  console.log(await tool("genclass_replay", { action: "arm", id: fid }));
  const l = await load(browser, bridgeUrl, scenario, 99);
  console.log(summary(l));
  console.log(JSON.stringify(l.oracle));
  console.log(await tool("genclass_replay", { action: "result", id: fid }));
} else if (cmd === "explain") {
  await startServer();
  console.log(await tool("genclass_explain", { id: process.argv[3] }));
} else if (cmd === "findings") {
  await startServer();
  console.log(await tool("genclass_findings", { limit: 50 }));
} else {
  console.log("usage: hunt.mjs login | probe <path> | once <scenario> | explore <scenario> <slow_ms> [runs] | replay <scenario> <id> | explain <id> | findings");
}
await browser.close();
if (served) await served.close();
process.exit(0);

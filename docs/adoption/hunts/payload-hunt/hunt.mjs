// GenClass race hunt against Payload's admin panel (docs/adoption/hunts/payload.md). Nothing in Payload is touched:
// the runtime is injected by Playwright into the HTML the dev server returns (a script tag before Next's own, served
// from packages/runtime/dist through a routed virtual path), and the MCP server runs in this process, driven through
// JSON-RPC exactly as a coding agent would drive it (packages/mcp/test/e2e/race.e2e.mjs is the model for this loop).
//
//   node hunt.mjs probe                                  injection check: connected, discovered state, DOM handles
//   node hunt.mjs explore <scenario> <slow_ms> [runs]    2 fifo baselines + runs seeded loads, then the report
//   node hunt.mjs replay <scenario> <finding-id>         arm the finding's order, run the scenario once, result
//   node hunt.mjs explain x <finding-id>                 genclass_explain from the persisted state
//   node hunt.mjs once <scenario>                        one unarmed run, with the requests it made
//
// Scenarios: search, filtersort, relsearch, autosave, autosave2, dblpublish, dblsave, dbldraft.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { PassThrough } from "node:stream";
import { chromium } from "@playwright/test";

// GenClass-lib: this repository (four directories up from docs/adoption/hunts/payload-hunt/), or GENCLASS_LIB
const LIB = (process.env.GENCLASS_LIB ?? new URL("../../../../", import.meta.url).pathname).replace(/\/+$/, "");
const { serve } = await import(`${LIB}/packages/mcp/dist/index.js`);

const APP = process.env.PAYLOAD_URL ?? "http://localhost:3000";
const RT_DIST = `${LIB}/packages/runtime/dist`;
const OUT = process.env.HUNT_OUT ?? new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const USER = { email: "dev@payloadcms.com", password: "test1234" };
const TYPES = { ".js": "text/javascript", ".map": "application/json", ".wasm": "application/wasm", ".json": "application/json" };
const [, , cmd = "probe", scenarioName = "search", arg3, arg4] = process.argv;
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

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
    const l = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (l.trim()) lines.push(JSON.parse(l));
  }
});
// a persistent state directory: runs and findings survive the process, so a finding can be explained and replayed later
const served = await serve({ cwd: OUT, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: join(OUT, "state") });
const bridgeUrl = `http://127.0.0.1:${served.port}`;
let rpcId = 0;
async function rpc(method, params = {}) {
  const my = ++rpcId;
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
  for (let i = 0; i < 1000; i++) {
    const m = lines.find((x) => x.id === my);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no reply to ${method}`);
}
const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "payload-hunt", version: "1" } });
input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

// --------------------------------------------------------------------------- the browser: injection and login
// Chromium 153 treats a document fulfilled through a Playwright route as coming from the public address space and then
// refuses its fetches to 127.0.0.1 (Local Network Access); the page really is on localhost, so the check is turned off.
const browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers"] });
const STATE = join(OUT, "storageState.json");

async function login() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${APP}/admin/login`, { waitUntil: "domcontentloaded" });
  await page.fill("#field-email", USER.email);
  await page.fill("#field-password", USER.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${APP}/admin`, { timeout: 120_000 });
  await ctx.storageState({ path: STATE });
  await ctx.close();
  log("logged in; storage state saved");
}
if (!existsSync(STATE)) await login();

// the script tag (first in <head>, before react-dom) and a module that connects the runtime to the bridge
const INJECT = `<script src="/__genclass/genclass.global.js" data-base="/__genclass/" data-mode="observe" data-model="off" data-telemetry="off" data-report="silent" data-devtools="off" data-visual="off"></script><script type="module" src="/__genclass/__connect.js"></script>`;
const CONNECT_JS = `import { connectAgent } from "./agent.js";\nwindow.__GENCLASS_CONN__ = connectAgent(window.GenClass && window.GenClass.runtime, {});\n`;

async function newContext() {
  const ctx = await browser.newContext({ storageState: STATE, bypassCSP: true, viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript((u) => {
    window.__GENCLASS_AGENT_URL__ = u;
    window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, report: "silent", devtools: false, visual: false, analytics: false };
  }, bridgeUrl);
  // the runtime's files, same-origin, from the built package
  await ctx.route(
    (u) => u.pathname.startsWith("/__genclass/"),
    (route, req) => {
      const rel = new URL(req.url()).pathname.slice("/__genclass/".length);
      if (rel === "__connect.js") return route.fulfill({ status: 200, body: CONNECT_JS, headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
      const file = join(RT_DIST, rel);
      if (!file.startsWith(RT_DIST) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, body: readFileSync(file), headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" } });
    },
  );
  // every admin document: the script tag first in <head>, before Next's own scripts (the React discovery hook must be
  // on the page before react-dom evaluates)
  await ctx.route(
    (u) => u.pathname.startsWith("/admin"),
    async (route, req) => {
      if (req.resourceType() !== "document") return route.continue();
      const res = await route.fetch();
      const ct = res.headers()["content-type"] ?? "";
      if (!ct.includes("text/html")) return route.fulfill({ response: res });
      const body = (await res.text()).replace(/<head([^>]*)>/i, (m) => `${m}${INJECT}`);
      return route.fulfill({ response: res, body, headers: { ...res.headers(), "content-length": String(Buffer.byteLength(body)) } });
    },
  );
  return ctx;
}

// connected to the bridge, and the page quiet once (hydrated, first requests answered) before the user acts: a keystroke
// typed into a controlled input while React is still hydrating is lost, which would change the scenario
async function connected(page) {
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 60_000 });
  await settle(page, 30_000);
  await page.waitForTimeout(150);
}
const settle = (page, ms = 30_000) => page.evaluate((t) => window.__GENCLASS_AGENT__.whenSettled(t), ms);
// whenSettled resolves too early on this app (a pending debounce it does not see): wait it out, then settle again
const settleAfterActions = async (page, extraMs = 4000) => {
  const t0 = Date.now();
  const first = await settle(page, 30_000);
  const firstMs = Date.now() - t0;
  await page.waitForTimeout(extraMs);
  const settled = await settle(page, 30_000);
  return { settled, firstSettleMs: firstMs };
};
const scheduleLabel = (page) =>
  page.evaluate(() => {
    const s = window.__GENCLASS_AGENT__?.schedule;
    return s ? `${s.order}${s.seed !== undefined ? `:${s.seed}` : ""}${s.delay ? ` +${s.delay.maxMs}ms` : ""}` : "none";
  });

// --------------------------------------------------------------------------- helpers for Payload's admin DOM
const LIST = `${APP}/admin/collections/posts`;
const rowsOf = (page) => page.evaluate(() => Array.from(document.querySelectorAll("table tbody tr")).map((tr) => Array.from(tr.querySelectorAll("td")).slice(0, 3).map((td) => td.innerText.replace(/\s+/g, " ").trim()).join(" | ")));
const pageInfo = (page) =>
  page.evaluate(() => ({
    url: location.pathname + location.search,
    search: document.querySelector("#search-filter-input")?.value ?? null,
    count: document.querySelector(".page-controls__page-info, .collection-list__page-info")?.innerText?.replace(/\s+/g, " ").trim() ?? null,
    title: document.querySelector("#field-title")?.value ?? null,
    autosave: document.querySelector(".autosave")?.innerText?.trim() ?? null,
    toasts: Array.from(document.querySelectorAll("[data-sonner-toast], .payload-toast-item")).map((t) => t.innerText.replace(/\s+/g, " ").trim()),
    status: document.querySelector(".status__value, .doc-controls__status")?.innerText?.trim() ?? null,
  }));

async function postIds() {
  const r = await fetch(`${APP}/api/posts?limit=3&sort=id&where[title][like]=alpha`, { headers: { cookie: cookieHeader() } });
  const j = await r.json();
  return j.docs.map((d) => d.id);
}
function cookieHeader() {
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  return st.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
async function restDoc(id, draft = true) {
  const r = await fetch(`${APP}/api/posts/${id}?depth=0&draft=${draft}`, { headers: { cookie: cookieHeader() } });
  return r.json();
}
async function restVersions(id) {
  const r = await fetch(`${APP}/api/posts/versions?where[parent][equals]=${id}&limit=200&depth=0`, { headers: { cookie: cookieHeader() } });
  return r.json();
}
async function firstId(slug) {
  const r = await fetch(`${APP}/api/${slug}?limit=1&sort=id&depth=0`, { headers: { cookie: cookieHeader() } });
  return (await r.json()).docs[0].id;
}
async function restPatchAny(slug, id, data) {
  const r = await fetch(`${APP}/api/${slug}/${id}?depth=0&draft=false`, { method: "PATCH", headers: { cookie: cookieHeader(), "content-type": "application/json" }, body: JSON.stringify(data) });
  return r.json();
}
async function restVersionsOf(slug, id) {
  const r = await fetch(`${APP}/api/${slug}/versions?where[parent][equals]=${id}&limit=200&depth=0`, { headers: { cookie: cookieHeader() } });
  return r.json();
}
async function restPatch(id, data) {
  const r = await fetch(`${APP}/api/posts/${id}?depth=0&draft=false`, { method: "PATCH", headers: { cookie: cookieHeader(), "content-type": "application/json" }, body: JSON.stringify(data) });
  return r.json();
}

// --------------------------------------------------------------------------- the scenarios (one page load each)
// Each returns my own DOM snapshot of the final state (the secondary oracle, next to the explore verdict).
const scenarios = {
  // (a) list view search typed into a collection of 300 documents
  async search(page) {
    await page.goto(LIST, { waitUntil: "domcontentloaded" });
    await connected(page);
    await page.locator("#search-filter-input").waitFor();
    await page.locator("table tbody tr").first().waitFor();
    await page.locator("#search-filter-input").pressSequentially("react", { delay: 90 });
    const settled = await settle(page);
    const info = await pageInfo(page);
    return { settled, ...info, rows: await rowsOf(page) };
  },
  // (b) rapid filter and sort changes: sort by title, then by views, then a filter typed, without waiting
  async filtersort(page) {
    await page.goto(LIST, { waitUntil: "domcontentloaded" });
    await connected(page);
    await page.locator("table tbody tr").first().waitFor();
    await page.locator("#heading-title button.sort-column__asc, #heading-title .sort-column__asc").first().click();
    await page.waitForTimeout(120);
    await page.locator("#heading-views button.sort-column__desc, #heading-views .sort-column__desc").first().click();
    await page.waitForTimeout(120);
    await page.locator("#search-filter-input").pressSequentially("echo", { delay: 60 });
    const settled = await settle(page);
    const info = await pageInfo(page);
    return { settled, ...info, rows: await rowsOf(page) };
  },
  // (c) a relationship field's async search (categories, 20 options, typed prefix)
  async relsearch(page) {
    const id = 1; // a fixed document: explore groups runs by route
    await page.goto(`${LIST}/${id}`, { waitUntil: "domcontentloaded" });
    await connected(page);
    const input = page.locator("#field-category input").first();
    await input.waitFor();
    await input.click();
    await input.pressSequentially("Category r", { delay: 90 });
    const { settled } = await settleAfterActions(page, 2500);
    const options = await page.evaluate(() => Array.from(document.querySelectorAll('#field-category [class*="option"], #field-category [role="option"]')).map((o) => o.innerText.trim()).filter(Boolean));
    const info = await pageInfo(page);
    return { settled, ...info, options };
  },
  // (d) drafts with autosave: type in bursts with pauses longer than the 800 ms autosave debounce, then stop
  async autosave(page) {
    const id = 2;
    if (!process.env.NO_PATCH) await restPatch(id, { title: "autosave base", _status: "published" });
    await page.goto(`${LIST}/${id}`, { waitUntil: "domcontentloaded" });
    await connected(page);
    const title = page.locator("#field-title");
    await title.waitFor();
    await title.click();
    await page.keyboard.press("End");
    // 1.5 s pauses: the autosave of a burst (800 ms debounce, restarted by the form-state merge) goes out just before
    // the next burst is typed, so its response, and the form-state refresh after it, land over newer text
    for (const burst of [" one", " two", " three", " four"]) {
      await title.pressSequentially(burst, { delay: 80 });
      await page.waitForTimeout(1500);
    }
    const { settled, firstSettleMs: settleMs } = await settleAfterActions(page, 5000);
    const info = await pageInfo(page);
    const stored = await restDoc(id, true);
    const versions = await restVersions(id);
    return { settled, settleMs, ...info, storedTitle: stored.title, storedStatus: stored._status, versions: versions.totalDocs, versionTitles: versions.docs.slice(0, 6).map((v) => `${v.version?.title}/${v.version?._status}${v.autosave ? "/auto" : ""}`) };
  },
  // (d2) autosave with 2.6 s pauses: each burst's autosave goes out about 2 s after the burst (800 ms debounce, restarted
  // once by the form-state merge), so its response and the form-state refresh that follows it land while the next burst
  // is being typed: an older save over newer text, if the merge lets it
  async autosave2(page) {
    const id = 4;
    await restPatch(id, { title: "autosave two base", _status: "published" });
    await page.goto(`${LIST}/${id}`, { waitUntil: "domcontentloaded" });
    await connected(page);
    const title = page.locator("#field-title");
    await title.waitFor();
    await title.click();
    await page.keyboard.press("End");
    for (const burst of [" one", " two", " three", " four", " five"]) {
      await title.pressSequentially(burst, { delay: 80 });
      await page.waitForTimeout(2600);
    }
    const { settled, firstSettleMs: settleMs } = await settleAfterActions(page, 5000);
    const info = await pageInfo(page);
    const stored = await restDoc(id, true);
    const versions = await restVersions(id);
    return { settled, settleMs, ...info, storedTitle: stored.title, storedStatus: stored._status, versions: versions.totalDocs, versionTitles: versions.docs.slice(0, 8).map((v) => `${v.version?.title}/${v.version?._status}${v.autosave ? "/auto" : ""}`) };
  },
  // (e1) double-click Save on a collection without versions (categories: one Save button, a plain PATCH)
  async dblsave(page) {
    const id = await firstId("categories");
    await restPatchAny("categories", id, { name: "Category dbl base" });
    await page.goto(`${APP}/admin/collections/categories/${id}`, { waitUntil: "domcontentloaded" });
    await connected(page);
    const name = page.locator("#field-name");
    await name.waitFor();
    await name.fill("Category dbl base edited");
    await page.waitForTimeout(400);
    await settle(page, 20_000);
    await page.locator("#action-save").dblclick();
    const { settled } = await settleAfterActions(page, 4000);
    const info = await pageInfo(page);
    const stored = await (await fetch(`${APP}/api/categories/${id}?depth=0`, { headers: { cookie: cookieHeader() } })).json();
    return { settled, ...info, name: await name.inputValue(), storedName: stored.name, storedUpdatedAt: stored.updatedAt };
  },
  // (e1b) double-click Save Draft on a drafts collection without autosave (pages)
  async dbldraft(page) {
    const id = await firstId("pages");
    await restPatchAny("pages", id, { title: "Page dbl base", _status: "published" });
    const before = (await restVersionsOf("pages", id)).totalDocs;
    await page.goto(`${APP}/admin/collections/pages/${id}`, { waitUntil: "domcontentloaded" });
    await connected(page);
    const title = page.locator("#field-title");
    await title.waitFor();
    await title.fill("Page dbl base edited");
    await page.waitForTimeout(400);
    await settle(page, 20_000);
    await page.locator("#action-save-draft").dblclick();
    const { settled } = await settleAfterActions(page, 4000);
    const info = await pageInfo(page);
    const versions = await restVersionsOf("pages", id);
    const stored = await (await fetch(`${APP}/api/pages/${id}?depth=0&draft=true`, { headers: { cookie: cookieHeader() } })).json();
    return { settled, ...info, versionsBefore: before, versionsAfter: versions.totalDocs, storedTitle: stored.title, storedStatus: stored._status };
  },
  // (e2) double-click Publish
  async dblpublish(page) {
    const id = 3;
    await restPatch(id, { title: "pub base", _status: "published" });
    const before = (await restVersions(id)).totalDocs;
    await page.goto(`${LIST}/${id}`, { waitUntil: "domcontentloaded" });
    await connected(page);
    const title = page.locator("#field-title");
    await title.waitFor();
    await title.fill("pub base edited");
    await page.waitForTimeout(2500); // the autosave of the edit goes out and lands first
    await settle(page, 20_000);
    await page.locator("#action-save").dblclick();
    const { settled } = await settleAfterActions(page, 4000);
    const info = await pageInfo(page);
    const versions = await restVersions(id);
    const stored = await restDoc(id, false);
    return { settled, ...info, versionsBefore: before, versionsAfter: versions.totalDocs, storedTitle: stored.title, storedStatus: stored._status };
  },
};

async function runOnce(name) {
  const ctx = await newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "warning" || m.type() === "error") {
      const t = m.text();
      if (/genclass|hunt/i.test(t)) errors.push(`console: ${t.slice(0, 200)}`);
    }
  });
  const reqs = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/") || r.headers()["next-action"]) reqs.push(`${r.method()} ${u.replace(APP, "").slice(0, 90)}${r.headers()["next-action"] ? " [action]" : ""}`);
  });
  let result;
  try {
    result = await scenarios[name](page);
    result.requests = reqs;
    result.schedule = await scheduleLabel(page);
    result.run = await page.evaluate(() => window.__GENCLASS_AGENT__?.run ?? null);
    result.witnesses = await page.evaluate(() => window.__GENCLASS_AGENT__.witnesses().map((w) => `${w.kind} ${w.subject} by ${w.by?.sig ?? w.by?.key ?? JSON.stringify(w.by).slice(0, 80)}`));
    result.stateKeys = await page.evaluate(() => Object.keys(window.__GENCLASS_AGENT__.snapshot().state).length);
    await page.waitForTimeout(600); // the snapshot batch reaches the bridge
  } catch (e) {
    result = { error: String(e).slice(0, 500) };
  }
  result.pageErrors = errors;
  await ctx.close();
  return result;
}

// --------------------------------------------------------------------------- commands
if (cmd === "probe") {
  const ctx = await newContext();
  const page = await ctx.newPage();
  page.on("console", (m) => (m.type() === "warning" || m.type() === "error") && log("console", m.type(), m.text().slice(0, 300)));
  page.on("pageerror", (e) => log("pageerror", String(e).slice(0, 300)));
  await page.goto(LIST, { waitUntil: "domcontentloaded" });
  await connected(page);
  log("connected; genclass version", await page.evaluate(() => window.GenClass?.version), "mode", await page.evaluate(() => window.GenClass?.runtime?.mode), "model", await page.evaluate(() => JSON.stringify(window.GenClass?.runtime?.status)));
  await page.locator("table tbody tr").first().waitFor();
  await page.locator("#search-filter-input").pressSequentially("react", { delay: 90 });
  log("settled", await settle(page));
  const snap = await page.evaluate(() => window.__GENCLASS_AGENT__.snapshot());
  log("state fields", Object.keys(snap.state).length, JSON.stringify(Object.keys(snap.state).slice(0, 60)));
  log("requests", JSON.stringify(snap.requests));
  log("fields", JSON.stringify(snap.fields));
  log("text lines", snap.text?.length, JSON.stringify(snap.text?.slice(0, 12)));
  const rec = await page.evaluate(() => window.__GENCLASS_AGENT__.recorded());
  log("steps", rec.steps.length, JSON.stringify(rec.steps.slice(0, 40)));
  log("rows", JSON.stringify(await rowsOf(page)).slice(0, 600));
  log("pageInfo", JSON.stringify(await pageInfo(page)));
  log("dom handles", JSON.stringify(await page.evaluate(() => ({
    sortBtns: Array.from(document.querySelectorAll("th [class*=sort]")).slice(0, 6).map((b) => `${b.tagName}.${b.className} in ${b.closest("th")?.id}`),
    buttons: Array.from(document.querySelectorAll("button[id], a[id]")).slice(0, 30).map((b) => `${b.id}:${b.innerText.trim().slice(0, 20)}`),
    inputs: Array.from(document.querySelectorAll("input[id]")).slice(0, 20).map((i) => i.id),
  }))));
  await page.waitForTimeout(700);
  // the edit view too
  const [id] = await postIds();
  await page.goto(`${LIST}/${id}`, { waitUntil: "domcontentloaded" });
  await connected(page);
  await page.locator("#field-title").waitFor();
  log("edit handles", JSON.stringify(await page.evaluate(() => ({
    buttons: Array.from(document.querySelectorAll("button[id], button[type=submit]")).slice(0, 30).map((b) => `${b.id}:${b.innerText.trim().slice(0, 24)}`),
    inputs: Array.from(document.querySelectorAll("input[id], textarea[id]")).slice(0, 20).map((i) => `${i.id}:${i.tagName}`),
    autosave: document.querySelector(".autosave")?.innerText,
    status: document.querySelector(".status")?.innerText,
  }))));
  await page.locator("#field-title").pressSequentially(" x", { delay: 80 });
  log("settled", await settle(page, 30_000));
  const snap2 = await page.evaluate(() => window.__GENCLASS_AGENT__.snapshot());
  log("edit state fields", Object.keys(snap2.state).length, JSON.stringify(Object.keys(snap2.state).slice(0, 60)));
  log("edit requests", JSON.stringify(snap2.requests));
  const rec2 = await page.evaluate(() => window.__GENCLASS_AGENT__.recorded());
  log("edit steps", JSON.stringify(rec2.steps.slice(-30)));
  log("witnesses", JSON.stringify(await page.evaluate(() => window.__GENCLASS_AGENT__.witnesses())));
  await page.waitForTimeout(700);
  await ctx.close();
  console.log(await tool("genclass_status"));
  console.log(await tool("genclass_findings", {}));
} else if (cmd === "explore") {
  const slow = Number(arg3 ?? 600);
  const runs = Number(arg4 ?? 6);
  const route = { search: "/admin/collections/posts", filtersort: "/admin/collections/posts", relsearch: "/admin/collections/posts/1", autosave: "/admin/collections/posts/2", autosave2: "/admin/collections/posts/4", dblpublish: "/admin/collections/posts/3" }[scenarioName];
  // a warm-up load before arming: the dev server compiles the route on its first load, and a slow first load makes the
  // scenario itself different (keystrokes lost to hydration); an unarmed run takes no explore slot
  const warm = await runOnce(scenarioName);
  log("warm-up", JSON.stringify({ ...warm, rows: warm.rows?.slice(0, 2), options: warm.options?.slice(0, 3) }));
  log(await tool("genclass_explore", { action: "start", runs, slow_ms: slow, ...(route ? { route } : {}) }));
  const results = [];
  for (let i = 0; i < runs + 2; i++) {
    const r = await runOnce(scenarioName);
    results.push(r);
    log(`run ${i + 1}/${runs + 2}`, JSON.stringify({ ...r, rows: r.rows?.slice(0, 3), options: r.options?.slice(0, 5) }));
  }
  const report = await tool("genclass_explore", { action: "report" });
  console.log(report);
  const status = await tool("genclass_status");
  const findings = await tool("genclass_findings", {});
  const explains = {};
  for (const fid of [...report.matchAll(/Race finding\(s\): ([^\n]+)/g)].flatMap((m) => m[1].split(/[,\s]+/).map((x) => x.replace(/[^\w]/g, "")).filter((x) => /^f\d+$/.test(x)))) {
    explains[fid] = await tool("genclass_explain", { id: fid });
    console.log(`\n==== genclass_explain ${fid}\n${explains[fid]}`);
  }
  const file = join(OUT, `${scenarioName}-${slow}${process.env.HUNT_TAG ?? ""}.json`);
  writeFileSync(file, JSON.stringify({ scenario: scenarioName, slow, runs: results, report, status, findings, explains }, null, 2));
  // my own oracle: compare each seeded run's final DOM with the fifo baselines
  const base = results.filter((r) => r.schedule?.startsWith("fifo"));
  const key = (r) => JSON.stringify({ rows: r.rows, options: r.options, title: r.title, name: r.name, storedTitle: r.storedTitle, storedName: r.storedName, storedStatus: r.storedStatus, versionsDelta: r.versionsAfter !== undefined ? r.versionsAfter - r.versionsBefore : undefined, search: r.search, url: r.url, toasts: r.toasts });
  const baseKeys = new Set(base.map(key));
  console.log(`\n== DOM oracle: ${base.length} baselines agree: ${baseKeys.size === 1}`);
  for (const r of results) if (!r.schedule?.startsWith("fifo")) console.log(`  ${r.schedule}: ${baseKeys.has(key(r)) ? "same as baseline" : "DIFFERS"}${r.witnesses?.length ? ` witnesses=${JSON.stringify(r.witnesses)}` : ""}${r.error ? ` error=${r.error}` : ""}`);
  console.log(`saved ${file}`);
} else if (cmd === "replay") {
  const fid = arg3;
  log(await tool("genclass_replay", { action: "arm", id: fid }));
  const r = await runOnce(scenarioName);
  log("replay run", JSON.stringify({ ...r, rows: r.rows?.slice(0, 3) }));
  console.log(await tool("genclass_replay", { action: "result", id: fid }));
} else if (cmd === "once") {
  const r = await runOnce(scenarioName);
  console.log(JSON.stringify(r, null, 1));
} else if (cmd === "explain") {
  console.log(await tool("genclass_explain", { id: arg3 }));
}

await browser.close();
await served.close();
process.exit(0);

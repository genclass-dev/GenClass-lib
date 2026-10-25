// GenClass race hunt against Ghost's admin (docs/adoption/hunts/ghost.md). Not part of any test suite.
//
// Drives the real Ghost admin (a React app served by Ghost core at http://localhost:2368/ghost/) in headless Chromium
// with @genclass/runtime injected at the page's edge (no change to Ghost's source) and the @genclass/mcp server
// in-process, the way race.e2e.mjs drives the MCP tools:
//   1. explore start (2 fifo baselines + N seeded orders, up to --slow ms of extra latency per response);
//   2. one page load per armed run, the same user steps each time (the scenario);
//   3. explore report; explain any race finding; optionally replay it.
// Three oracles per run, labelled in the output: GenClass's own explore verdict (state registered through a mirror
// atom plus React state discovery and the page text), the Admin API read-back of the post (what the server holds
// against what was typed last), and a DOM snapshot of the editor.
//
// Usage (from the GenClass-lib repo root, both packages built, Ghost running on 2368 with the owner account below):
//   node docs/adoption/hunts/ghost/hunt.mjs <scenario> [--slow 600] [--runs 6] [--seed 1] [--replay] [--out dir]
// Scenarios: smoke, autosave, switch, list, publish, pickers.
// Environment: GHOST_URL (default http://localhost:2368), GHOST_EMAIL / GHOST_PASSWORD (the owner account),
// GHOST_STATE (where the signed-in storageState is kept).

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { chromium } from "@playwright/test";
import { serve } from "../../../../packages/mcp/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const rtDist = resolve(repo, "packages/runtime/dist");
const TYPES = { ".js": "text/javascript", ".map": "application/json", ".wasm": "application/wasm", ".json": "application/json" };

// --------------------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const scenarioName = argv.find((a) => !a.startsWith("--")) ?? "smoke";
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const SLOW = Number(opt("slow", 600));
const RUNS = Number(opt("runs", 6));
const SEED = Number(opt("seed", 1));
const OUT = resolve(opt("out", join(here, "results")));
const REPLAY = flag("replay");
const ONCE = flag("once");
// React state discovery (autoState) is off unless --autostate on: in the production build the discovered component
// stores carry minified names shared by many components, and which instance gets a store depends on timing (see
// ghost.md, "what GenClass could and could not see"); the mirror atom below is the registered app state instead.
const AUTOSTATE = opt("autostate", "off") === "on";
const APP = (process.env.GHOST_URL ?? "http://localhost:2368").replace(/\/$/, "");
const EMAIL = process.env.GHOST_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.GHOST_PASSWORD ?? "genclass-hunt-2026";
const STATE = process.env.GHOST_STATE ?? join(here, ".state", "ghost-state.json");
mkdirSync(OUT, { recursive: true });
mkdirSync(dirname(STATE), { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

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
const served = await serve({ cwd: here, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: null });
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
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ghost-hunt", version: "1" } });
input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const bridgeUrl = `http://127.0.0.1:${served.port}`;
log("bridge", bridgeUrl, "mode", served.mode);

// --------------------------------------------------------------------------- Ghost fixtures through the Admin API
// Chromium 143 (Playwright 1.63) refuses a page on localhost:2368 a fetch to 127.0.0.1 (Local Network Access checks)
// without a permission prompt headless Chromium cannot answer; the bridge is loopback-only, so the check is turned off.
const browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks"] });

async function signIn() {
  const ctx = await browser.newContext();
  const r = await ctx.request.post(`${APP}/ghost/api/admin/session/`, {
    headers: { Origin: APP, "Content-Type": "application/json" },
    data: { username: EMAIL, password: PASSWORD },
  });
  if (r.status() !== 201 && r.status() !== 200) throw new Error(`sign-in failed: ${r.status()} ${await r.text()}`);
  await ctx.storageState({ path: STATE });
  await ctx.close();
}
if (!existsSync(STATE)) await signIn();
const apiCtx = await browser.newContext({ storageState: STATE });
const api = {
  headers: { Origin: APP, "Content-Type": "application/json" },
  async get(path) {
    const r = await apiCtx.request.get(`${APP}/ghost/api/admin${path}`);
    if (r.status() === 403 || r.status() === 401) {
      await signIn();
      throw new Error(`session expired (${r.status()}); signed in again, rerun`);
    }
    return r.json();
  },
  async put(path, data) {
    const r = await apiCtx.request.put(`${APP}/ghost/api/admin${path}`, { headers: this.headers, data });
    if (!r.ok()) throw new Error(`PUT ${path}: ${r.status()} ${await r.text()}`);
    return r.json();
  },
  async post(path, data) {
    const r = await apiCtx.request.post(`${APP}/ghost/api/admin${path}`, { headers: this.headers, data });
    if (!r.ok()) throw new Error(`POST ${path}: ${r.status()} ${await r.text()}`);
    return r.json();
  },
};
const me = await api.get("/users/me/");
if (!me.users) throw new Error(`not signed in: ${JSON.stringify(me).slice(0, 200)}`);

/** The hunt's fixtures: two drafts and a few tags, created once and reset before every run. */
const FIX = {
  A: { title: "Hunt post A", html: "<p>Initial body of Hunt post A.</p>" },
  B: { title: "Hunt post B", html: "<p>Initial body of Hunt post B.</p>" },
  C: { title: "Hunt post C", html: "<p>Initial body of Hunt post C.</p>" },
  tags: ["news", "newsletter", "neat", "alpha", "beta"],
};
// The scenarios rename the posts (and so their slugs), so the fixture ids are kept next to the storageState.
const FIXTURE_IDS = join(dirname(STATE), "fixtures.json");
const fixtureIds = existsSync(FIXTURE_IDS) ? JSON.parse(readFileSync(FIXTURE_IDS, "utf8")) : {};
async function ensurePost(key, fx) {
  const id = fixtureIds[key];
  if (id) {
    const r = await apiCtx.request.get(`${APP}/ghost/api/admin/posts/${id}/`);
    if (r.ok()) return (await r.json()).posts[0];
  }
  const r = await api.post(`/posts/?source=html`, { posts: [{ title: fx.title, html: fx.html, status: "draft" }] });
  fixtureIds[key] = r.posts[0].id;
  writeFileSync(FIXTURE_IDS, JSON.stringify(fixtureIds, null, 2));
  return r.posts[0];
}
/** Puts a post back to its fixture content and status so every run starts from the same state. */
async function resetPost(id, fx, status = "draft") {
  const cur = (await api.get(`/posts/${id}/`)).posts[0];
  const r = await api.put(`/posts/${id}/?source=html`, { posts: [{ id, title: fx.title, html: fx.html, status, published_at: null, tags: [], updated_at: cur.updated_at }] });
  return r.posts[0];
}
async function ensureTags() {
  const have = (await api.get(`/tags/?limit=all`)).tags.map((t) => t.name);
  for (const name of FIX.tags) if (!have.includes(name)) await api.post(`/tags/`, { tags: [{ name }] });
}
const postA = await ensurePost("A", FIX.A);
const postB = await ensurePost("B", FIX.B);
const postC = await ensurePost("C", FIX.C);
await ensureTags();
log("fixtures", postA.id, postB.id);

/** The Admin API's view of a post: the read-back oracle. */
async function readBack(id) {
  const p = (await api.get(`/posts/${id}/?formats=plaintext`)).posts[0];
  return { title: p.title, plaintext: (p.plaintext ?? "").replace(/\s+/g, " ").trim(), status: p.status, updated_at: p.updated_at, tags: (p.tags ?? []).map((t) => t.name), authors: (p.authors ?? []).map((a) => a.name) };
}

// --------------------------------------------------------------------------- injection (nothing in Ghost changes)
const globalJs = readFileSync(join(rtDist, "genclass.global.js"), "utf8");
// Runs in the page before any of Ghost's scripts (addInitScript): page-level configuration, the bridge URL.
const initScript = ({ bridge, autoState }) => {
  window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, devtools: false, visual: false, analytics: false, report: "silent", autoState };
  window.__GENCLASS_AGENT_URL__ = bridge;
};
// The mirror atom: Ghost's React Query cache (window.__TANSTACK_QUERY_CLIENT__) and the editor's DOM, registered as
// GenClass state so explore has app state to compare on a React app without a store GenClass discovers on its own.
// Event-driven (no polling): the query cache's subscription, DOM mutations and input events, coalesced per frame.
const mirrorSource = `
(() => {
  const rt = window.GenClass && window.GenClass.runtime;
  if (!rt) return;
  const atom = rt.atom("ghost", { editor: { title: null, body: null, status: null }, cache: {} });
  let qc = null;
  const squash = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  const compute = () => {
    const q = (sel) => document.querySelector(sel);
    const editor = {
      title: q('[data-testid="editor-title-input"]') ? q('[data-testid="editor-title-input"]').value : null,
      body: q('[data-testid="editor-body"]') ? squash(q('[data-testid="editor-body"]').innerText).slice(0, 400) : null,
      status: q('[data-testid="editor-status"]') ? squash(q('[data-testid="editor-status"]').innerText) : null,
    };
    const cache = {};
    if (qc) {
      for (const query of qc.getQueryCache().getAll()) {
        const [type, url] = query.queryKey;
        const d = query.state.data;
        if (typeof url !== "string" || !d) continue;
        const rel = url.replace(/^.*\\/ghost\\/api\\/admin/, "");
        if (type === "PostsResponseType" && /^\\/posts\\/[0-9a-f]{24}\\//.test(rel) && Array.isArray(d.posts) && d.posts.length === 1) {
          const p = d.posts[0];
          cache["post " + p.id] = { title: p.title, status: p.status, updated_at: p.updated_at, plaintext: squash(p.plaintext).slice(0, 200), lexical: String(p.lexical || "").length, tags: (p.tags || []).map((t) => t.name).join(","), authors: (p.authors || []).map((a) => a.name).join(",") };
        } else if (rel.startsWith("/posts/?") || rel.startsWith("/pages/?")) {
          const pages = Array.isArray(d.pages) && Array.isArray(d.pageParams) ? d.pages : [d];
          const items = pages.flatMap((pg) => pg.posts || pg.pages || []);
          cache["list " + rel.slice(0, 120)] = items.map((p) => p.title).join(" | ").slice(0, 300);
        } else if (rel.startsWith("/tags/?") && d.tags) {
          cache["tags " + rel.slice(0, 120)] = d.tags.map((t) => t.name).join(" | ").slice(0, 300);
        } else if (rel.startsWith("/users/?") && d.users) {
          cache["users " + rel.slice(0, 120)] = d.users.map((u) => u.name).join(" | ").slice(0, 300);
        }
      }
    }
    return { editor, cache };
  };
  let last = "";
  const sync = () => {
    try {
      const v = compute();
      const k = JSON.stringify(v);
      if (k !== last) { last = k; atom.set(v); }
    } catch (e) { /* never break the page */ }
  };
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; sync(); }); };
  const hook = (c) => { qc = c; try { c.getQueryCache().subscribe(schedule); } catch (e) {} schedule(); };
  if (window.__TANSTACK_QUERY_CLIENT__) hook(window.__TANSTACK_QUERY_CLIENT__);
  else Object.defineProperty(window, "__TANSTACK_QUERY_CLIENT__", { configurable: true, get() { return undefined; }, set(v) { Object.defineProperty(window, "__TANSTACK_QUERY_CLIENT__", { value: v, writable: true, configurable: true }); hook(v); } });
  const start = () => { new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, characterData: true }); document.addEventListener("input", schedule, true); schedule(); };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
  window.__GENCLASS_MIRROR__ = { sync, compute };
})();
`;
const connectSource = `import { connectAgent } from "/__genclass/agent.js";
window.__GENCLASS_CONN__ = connectAgent(window.GenClass && window.GenClass.runtime, { url: window.__GENCLASS_AGENT_URL__ });
`;

let lastPage = null;
async function newPageContext() {
  const ctx = await browser.newContext({ storageState: STATE, bypassCSP: true, viewport: { width: 1400, height: 900 } });
  ctx.on("page", (p) => (lastPage = p));
  await ctx.addInitScript(initScript, { bridge: bridgeUrl, autoState: AUTOSTATE });
  // the runtime's files on a virtual same-origin path
  await ctx.route((u) => u.pathname.startsWith("/__genclass/"), async (route) => {
    const u = new URL(route.request().url());
    const name = u.pathname.slice("/__genclass/".length);
    const file = join(rtDist, name);
    if (!file.startsWith(rtDist) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  // the admin's HTML gets GenClass as its first script (so it sees every request and react-dom), then the agent link
  await ctx.route((u) => u.pathname === "/ghost/" || u.pathname === "/ghost", async (route) => {
    const res = await route.fetch();
    const ct = res.headers()["content-type"] ?? "";
    if (!ct.includes("text/html")) return route.fulfill({ response: res });
    const html = (await res.text()).replace(
      "<head>",
      `<head>\n<script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script>\n<script>${mirrorSource}</script>\n<script type="module">${connectSource}</script>`,
    );
    const { "content-encoding": _enc, "content-length": _len, ...headers } = res.headers();
    return route.fulfill({ status: res.status(), headers, contentType: "text/html; charset=utf-8", body: html });
  });
  return ctx;
}

// --------------------------------------------------------------------------- page helpers
const editorUrl = (id) => `${APP}/ghost/#/editor/post/${id}`;
const sel = {
  title: '[data-testid="editor-title-input"]',
  body: '[data-testid="editor-body"] [contenteditable="true"]',
  bodyBox: '[data-testid="editor-body"]',
  status: '[data-testid="editor-status"]',
  settingsToggle: '[data-testid="settings-menu-toggle"]',
  tagsInput: '[data-testid="settings-tags-input"]',
  tagsList: '[data-testid="settings-tags-list"]',
  authorsPicker: '[data-testid="settings-authors-picker"]',
  listItem: '[data-testid="posts-list-item"]',
  listLink: '[data-testid="post-list-item-link"]',
};
async function waitConnected(page) {
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
}
async function openEditor(page, id) {
  await page.goto(editorUrl(id));
  await waitConnected(page);
  await page.locator(sel.title).waitFor({ timeout: 20_000 });
  await page.locator(sel.body).waitFor({ timeout: 20_000 });
}
async function waitSaved(page, timeout = 20_000) {
  // "Draft - Saved" (or "Published") and nothing in flight or held by the schedule
  try {
    await page.waitForFunction(
      (s) => {
        const el = document.querySelector(s);
        const t = (el?.innerText ?? "").replace(/\s+/g, " ").trim();
        return /Saved|Published|Scheduled/.test(t) && !/Saving/.test(t);
      },
      sel.status,
      { timeout },
    );
  } catch (e) {
    const dom = await domSnapshot(page).catch(() => ({}));
    const shot = join(OUT, `failure-${Date.now()}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    throw new Error(`not saved within ${timeout} ms: status ${JSON.stringify(dom.status)} title ${JSON.stringify(dom.title)} url ${dom.url} (${shot})`);
  }
}
async function settled(page, ms = 20_000) {
  return page.evaluate((t) => window.__GENCLASS_AGENT__.whenSettled(t), ms);
}
async function domSnapshot(page) {
  return page.evaluate((s) => {
    const q = (x) => document.querySelector(x);
    const sq = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
    return {
      url: location.hash,
      title: q(s.title)?.value ?? null,
      body: sq(q(s.bodyBox)?.innerText).slice(0, 400) || null,
      status: sq(q(s.status)?.innerText) || null,
      stores: window.GenClass?.runtime?.stores?.().map((x) => `${x.kind}:${x.name}`).slice(0, 60) ?? [],
      agent: { run: window.__GENCLASS_AGENT__?.run, schedule: window.__GENCLASS_AGENT__?.schedule, witnesses: window.__GENCLASS_AGENT__?.witnesses().length, errors: window.__GENCLASS_AGENT__?.errors().length, forced: window.__GENCLASS_AGENT__?.snapshot().forced },
    };
  }, sel);
}
async function finish(page, ctx) {
  await settled(page);
  const dom = await domSnapshot(page);
  await page.waitForTimeout(500); // the snapshot batch reaches the bridge
  await ctx.close();
  return dom;
}
// The editor hides its header while the writer types (writing focus); a mouse move brings it back.
async function liftWritingFocus(page) {
  await page.mouse.move(700, 30);
  await page.mouse.move(720, 34);
  await page.waitForTimeout(400);
}
async function typeAtEndOfBody(page, text, delay) {
  const body = page.locator(sel.body);
  await body.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("End");
  await body.pressSequentially(text, { delay });
}
async function typeAtEndOfTitle(page, text, delay) {
  const title = page.locator(sel.title);
  await title.click();
  await page.keyboard.press("End");
  await title.pressSequentially(text, { delay });
}

// --------------------------------------------------------------------------- scenarios
// Each returns { dom, api, expect } for the run; `expect` is what the server should hold if the app is right.
const scenarios = {
  // Load editor A, type a little, settle. Checks injection, connection, the mirror atom and the read-back.
  async smoke() {
    await resetPost(postA.id, FIX.A);
    const ctx = await newPageContext();
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error" || m.text().includes("GenClass")) log("  page:", m.text().slice(0, 200)); });
    await openEditor(page, postA.id);
    await typeAtEndOfTitle(page, " smoke", 60);
    await waitSaved(page);
    const dom = await finish(page, ctx);
    return { dom, api: await readBack(postA.id), expect: { title: `${FIX.A.title} smoke` } };
  },

  // (a) Autosave: three typing bursts with pauses just over the 3 s autosave debounce, so the second and third bursts
  // type while the previous save (slug GET, PUT, then the post refetch the invalidation triggers) is still in flight.
  async autosave() {
    await resetPost(postA.id, FIX.A);
    const ctx = await newPageContext();
    const page = await ctx.newPage();
    await openEditor(page, postA.id);
    await typeAtEndOfTitle(page, " one", 80);
    await typeAtEndOfBody(page, " First burst typed here.", 70);
    await page.waitForTimeout(3100); // the debounce fires: slug + PUT start now
    await typeAtEndOfBody(page, " Second burst lands while the save is out.", 70);
    await page.waitForTimeout(3100);
    await typeAtEndOfTitle(page, " two", 80);
    await typeAtEndOfBody(page, " Third.", 90);
    await waitSaved(page, 30_000);
    const dom = await finish(page, ctx);
    return {
      dom,
      api: await readBack(postA.id),
      expect: { title: `${FIX.A.title} one two`, plaintext: "Initial body of Hunt post A. First burst typed here. Second burst lands while the save is out. Third." },
    };
  },

  // (f) A new post: the first autosave creates it (POST, then the URL takes the id), typing goes on while the create
  // and its refetch are out, then two more autosaves. The post is deleted at the end so every run starts the same.
  async create() {
    const ctx = await newPageContext();
    const page = await ctx.newPage();
    await page.goto(`${APP}/ghost/#/editor/post/`);
    await waitConnected(page);
    await page.locator(sel.title).waitFor({ timeout: 20_000 });
    await page.locator(sel.body).waitFor({ timeout: 20_000 });
    await page.locator(sel.title).click();
    await page.locator(sel.title).pressSequentially("Hunt created post", { delay: 80 });
    await page.locator(sel.body).click();
    await page.locator(sel.body).pressSequentially("Body typed while the create is out.", { delay: 70 });
    await page.waitForTimeout(3100);
    await typeAtEndOfTitle(page, " done", 80);
    // a title edit is saved on blur or with the next body autosave (Ghost's design, see ghost.md), so the body goes last
    await typeAtEndOfBody(page, " Second burst.", 70);
    await waitSaved(page, 30_000);
    await page.waitForURL((u) => /#\/editor\/post\/[0-9a-f]{24}/.test(u.hash), { timeout: 20_000 });
    const id = /#\/editor\/post\/([0-9a-f]{24})/.exec(new URL(page.url()).hash)[1];
    const dom = await finish(page, ctx);
    const api = await readBack(id);
    await apiCtx.request.delete(`${APP}/ghost/api/admin/posts/${id}/`, { headers: { Origin: APP } });
    return { dom, api, expect: { title: "Hunt created post done", plaintext: "Body typed while the create is out. Second burst." } };
  },

  // (b) Switching posts quickly: edit A, go back to the list (the leave save), open B at once, edit B.
  async switch() {
    await resetPost(postA.id, FIX.A);
    await resetPost(postB.id, FIX.B);
    const ctx = await newPageContext();
    const page = await ctx.newPage();
    await openEditor(page, postA.id);
    await typeAtEndOfTitle(page, " edited", 80);
    await liftWritingFocus(page);
    await page.getByRole("link", { name: "Posts", exact: true }).first().click();
    await page.locator(sel.listLink).filter({ hasText: FIX.B.title }).first().click();
    await page.waitForURL((u) => u.hash.includes(postB.id), { timeout: 20_000 });
    await page.locator(sel.title).waitFor({ timeout: 20_000 });
    await page.waitForFunction(({ s, t }) => document.querySelector(s)?.value === t, { s: sel.title, t: FIX.B.title }, { timeout: 20_000 });
    await typeAtEndOfTitle(page, " too", 80);
    await typeAtEndOfBody(page, " Also here.", 70);
    await waitSaved(page, 30_000);
    const dom = await finish(page, ctx);
    return {
      dom,
      api: { A: await readBack(postA.id), B: await readBack(postB.id) },
      expect: { A: { title: `${FIX.A.title} edited` }, B: { title: `${FIX.B.title} too`, plaintext: "Initial body of Hunt post B. Also here." }, domTitle: `${FIX.B.title} too` },
    };
  },

  // (c) The posts list: change the status filter quickly (each change is a new query), then sort.
  async list() {
    const ctx = await newPageContext();
    const page = await ctx.newPage();
    await page.goto(`${APP}/ghost/#/posts`);
    await waitConnected(page);
    await page.locator(sel.listItem).first().waitFor({ timeout: 20_000 });
    for (const hash of ["#/posts?type=draft", "#/posts?type=published", "#/posts?type=draft", "#/posts"]) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForTimeout(120);
    }
    await page.locator(sel.listItem).first().waitFor({ timeout: 20_000 });
    await settled(page);
    const titles = await page.locator(sel.listLink).allInnerTexts();
    const dom = await finish(page, ctx);
    return { dom: { ...dom, titles: titles.map((t) => t.replace(/\s+/g, " ").trim().slice(0, 60)) }, api: null, expect: { note: "list shows every post (no filter) in the final state" } };
  },

  // (d) Double-click Publish on a draft, then double-click Update after an edit.
  async publish() {
    await resetPost(postC.id, FIX.C);
    const ctx = await newPageContext();
    const page = await ctx.newPage();
    await openEditor(page, postC.id);
    await typeAtEndOfTitle(page, " live", 80);
    await liftWritingFocus(page);
    await page.getByRole("button", { name: "Publish", exact: true }).first().click();
    await page.locator('[data-testid="publish-continue"]').click();
    await page.locator('[data-testid="publish-confirm"]').dblclick();
    // after publishing, the admin goes to the posts list and celebrates in a dialog
    await page.waitForURL((u) => u.hash.startsWith("#/posts"), { timeout: 30_000 });
    const celebration = page.getByRole("dialog");
    await celebration.waitFor({ timeout: 15_000 });
    await celebration.getByRole("button", { name: /close/i }).first().click();
    await celebration.waitFor({ state: "hidden", timeout: 10_000 });
    // back into the editor by URL: a click on the list row would be recorded with the row's relative time in its
    // name, which changes between loads and would put every run in a scenario group of its own
    await page.evaluate((h) => { location.hash = h; }, `#/editor/post/${postC.id}`);
    await page.waitForURL((u) => u.hash.includes(postC.id), { timeout: 20_000 });
    await page.locator(sel.title).waitFor({ timeout: 20_000 });
    await typeAtEndOfTitle(page, " again", 80);
    await liftWritingFocus(page);
    await page.getByRole("button", { name: "Update", exact: true }).first().dblclick();
    await page.getByRole("button", { name: "Updated", exact: true }).first().waitFor({ timeout: 30_000 });
    await waitSaved(page, 30_000);
    const dom = await finish(page, ctx);
    return { dom, api: await readBack(postC.id), expect: { title: `${FIX.C.title} live again`, status: "published" } };
  },

  // (e) The settings sidebar's tag picker (async search per debounced term) and the authors picker.
  async pickers() {
    await resetPost(postA.id, FIX.A);
    const ctx = await newPageContext();
    const page = await ctx.newPage();
    await openEditor(page, postA.id);
    await page.locator(sel.settingsToggle).click();
    const tags = page.locator(sel.tagsInput);
    await tags.waitFor({ timeout: 20_000 });
    await tags.click();
    await tags.pressSequentially("ne", { delay: 90 });
    await page.waitForTimeout(350);
    await tags.pressSequentially("ws", { delay: 90 });
    await page.getByRole("option", { name: "news", exact: true }).first().click();
    await tags.pressSequentially("alp", { delay: 90 });
    await page.getByRole("option", { name: "alpha", exact: true }).first().click();
    const authors = page.locator(sel.authorsPicker).locator("input").first();
    if (await authors.count()) {
      await authors.click();
      await page.keyboard.press("Escape");
    }
    await waitSaved(page, 30_000);
    const dom = await finish(page, ctx);
    return { dom, api: await readBack(postA.id), expect: { tags: ["news", "alpha"] } };
  },
};

const scenario = scenarios[scenarioName];
if (!scenario) {
  console.error(`unknown scenario ${scenarioName}; one of ${Object.keys(scenarios).join(", ")}`);
  process.exit(2);
}

// --------------------------------------------------------------------------- the explore loop
const summary = { scenario: scenarioName, slow_ms: SLOW, runs: RUNS, seed: SEED, autoState: AUTOSTATE, started: new Date().toISOString(), loads: [] };
const label = `${scenarioName}-slow${SLOW}-seed${SEED}${AUTOSTATE ? "-discovery" : ""}${ONCE ? "-once" : ""}`;
const save = () => writeFileSync(join(OUT, `${label}.json`), JSON.stringify(summary, null, 2));

if (scenarioName === "smoke" || ONCE) {
  log(`${scenarioName}: one natural load`);
  let r;
  try {
    r = await scenario();
  } catch (e) {
    const shot = join(OUT, `failure-${label}.png`);
    await lastPage?.screenshot({ path: shot }).catch(() => {});
    log("failed:", e.message.split("\n")[0], "screenshot", shot);
    throw e;
  }
  console.log(JSON.stringify(r, null, 2));
  console.log(await tool("genclass_status"));
  summary.loads.push(r);
  save();
} else {
  const started = await tool("genclass_explore", { action: "start", runs: RUNS, slow_ms: SLOW, seed: SEED, route: "/ghost/" });
  log(started);
  summary.exploreStart = started;
  for (let i = 0; i < RUNS + 2; i++) {
    log(`load ${i + 1}/${RUNS + 2}`);
    try {
      const r = await scenario();
      summary.loads.push({ n: i + 1, ...r });
      log(`  schedule ${JSON.stringify(r.dom.agent?.schedule)} run ${r.dom.agent?.run} witnesses ${r.dom.agent?.witnesses} errors ${r.dom.agent?.errors} forced ${r.dom.agent?.forced}`);
      log(`  api ${JSON.stringify(r.api)?.slice(0, 300)}`);
    } catch (e) {
      log("  load failed:", e.message.split("\n")[0]);
      const shot = join(OUT, `failure-${label}-${i + 1}.png`);
      await lastPage?.screenshot({ path: shot }).catch(() => {});
      await lastPage?.context().close().catch(() => {});
      summary.loads.push({ n: i + 1, error: e.message.split("\n").slice(0, 3).join(" "), screenshot: shot });
    }
    save();
  }
  const report = await tool("genclass_explore", { action: "report" });
  console.log(report);
  summary.report = report;
  const ids = [...report.matchAll(/Race finding\(s\): ([^\n]+)/g)].flatMap((m) => m[1].split(/[,\s]+/).filter((x) => /^f\d+$/.test(x)));
  summary.findings = await tool("genclass_findings", {});
  console.log(summary.findings);
  summary.explains = {};
  for (const id of new Set(ids)) {
    summary.explains[id] = await tool("genclass_explain", { id });
    console.log(summary.explains[id]);
  }
  if (REPLAY && ids[0]) {
    log("replay", ids[0]);
    await tool("genclass_replay", { action: "arm", id: ids[0] });
    const r = await scenario();
    summary.replayLoad = r;
    summary.replay = await tool("genclass_replay", { action: "result", id: ids[0] });
    console.log(summary.replay);
  }
  save();
}
log("written", join(OUT, `${label}.json`));
await apiCtx.close();
await browser.close();
await served.close();
process.exit(0);

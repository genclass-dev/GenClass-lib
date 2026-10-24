// GenClass race hunt against Umami's shared list search (docs/adoption/hunts/umami.md). Not part of any test suite.
//
// Drives a local Umami (Next.js App Router, React 19; http://localhost:3000) in headless Chromium with
// @genclass/runtime injected at the page's edge (no change to Umami's source) and the @genclass/mcp server in-process,
// the way packages/mcp/test/e2e/race.e2e.mjs drives the MCP tools:
//   1. explore start (2 fifo baselines + N seeded orders, up to --slow ms of extra latency per response);
//   2. one page load per armed run, the same typing each time (the scenario);
//   3. explore report; explain any race finding.
// Oracles per run, labelled separately from explore's verdict:
//   input: the search box's final value equals everything typed;
//   list:  the rows shown equal what Umami's own API returns for everything typed (page 1, as a set).
// Each run also keeps a timeline (page clock, ms): keystrokes, history pushes (the URL commit), RSC responses and every
// change of the input's value, so a revert can be read in causal order.
//
// Usage (from the GenClass-lib repo root, both packages built, Umami on 3000 seeded with seed.mjs):
//   node docs/adoption/hunts/umami/hunt.mjs <page> <pattern> [--slow 600] [--runs 6] [--seed 1] [--once] [--replay]
//     [--label x] [--out dir]
// Pages: websites (/websites), users (/admin/users). Patterns: pause (word, 700 ms, rest), split (650 ms mid-word).
// Environment: UMAMI_URL (default http://localhost:3000), UMAMI_USER / UMAMI_PASSWORD (default admin / umami).

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
const VALUED = ["--slow", "--runs", "--seed", "--key", "--out", "--label"];
const pos = argv.filter((a, i) => !a.startsWith("--") && !VALUED.includes(argv[i - 1]));
const pageName = pos[0] ?? "websites";
const patternName = pos[1] ?? "pause";
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const SLOW = Number(opt("slow", 600));
const RUNS = Number(opt("runs", 6));
const SEED = Number(opt("seed", 1));
const ONCE = flag("once");
const REPLAY = flag("replay");
const KEY_MS = Number(opt("key", 90));
const OUT = resolve(opt("out", join(here, "results")));
const APP = (process.env.UMAMI_URL ?? "http://localhost:3000").replace(/\/$/, "");
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --------------------------------------------------------------------------- pages and typing patterns
// Each pattern types its parts with KEY_MS between keystrokes and waits the given ms between parts. The waits straddle
// DataGrid's 600 ms debounce: the first router.push starts while the rest is still being typed.
const PAGES = {
  websites: {
    path: "/websites",
    rows: 'a[href^="/websites/"]',
    patterns: { pause: ["shop", 700, " stu"], split: ["sho", 650, "p st"] },
    api: (uid, q) => `/users/${uid}/websites?page=1&search=${encodeURIComponent(q)}`,
    name: (r) => r.name,
  },
  users: {
    path: "/admin/users",
    rows: 'a[href^="/admin/users/"]',
    patterns: { pause: ["anna", 700, "_sto"], split: ["an", 650, "na_st"] },
    api: (_uid, q) => `/admin/users?page=1&search=${encodeURIComponent(q)}`,
    name: (r) => r.username,
  },
};
const P = PAGES[pageName];
if (!P || !P.patterns[patternName]) {
  console.error(`usage: hunt.mjs <${Object.keys(PAGES).join("|")}> <pause|split> [--slow ms] [--runs n] [--seed n] [--once]`);
  process.exit(2);
}
const PATTERN = P.patterns[patternName];
const TYPED = PATTERN.filter((x) => typeof x === "string").join("");

// --------------------------------------------------------------------------- Umami's API (the list oracle)
const login = await fetch(`${APP}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: process.env.UMAMI_USER ?? "admin", password: process.env.UMAMI_PASSWORD ?? "umami" }),
});
const { token, user } = await login.json();
if (!token) throw new Error(`login failed: ${login.status}`);
async function apiNames(q) {
  const r = await fetch(`${APP}/api${P.api(user.id, q)}`, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json();
  return j.data.map(P.name);
}
const EXPECTED = await apiNames(TYPED);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

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
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "umami-hunt", version: "1" } });
input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const bridgeUrl = `http://127.0.0.1:${served.port}`;
log("bridge", bridgeUrl, "page", P.path, "pattern", patternName, JSON.stringify(PATTERN), "slow", SLOW, "seed", SEED);

// Chromium refuses a page on localhost a fetch to 127.0.0.1 (Local Network Access) without a prompt headless Chromium
// cannot answer; the bridge is loopback-only, so the check is turned off.
const browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks"] });

// --------------------------------------------------------------------------- injection (nothing in Umami changes)
// Runs before any of Umami's scripts: page-level configuration, the bridge URL, the signed-in token, and the timeline
// probe (history pushes and the search box's value, read once per frame; it writes nothing the app reads).
const initScript = ({ bridge, token }) => {
  window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, devtools: false, visual: false, analytics: false, report: "silent" };
  window.__GENCLASS_AGENT_URL__ = bridge;
  try { localStorage.setItem("umami.auth", JSON.stringify(token)); } catch {}
  const tl = (window.__HUNT_TL__ = []);
  const now = () => Math.round(performance.now());
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (state, title, url) {
      if (url != null) tl.push({ t: now(), k: m === "pushState" ? "push" : "replace", url: String(url).replace(location.origin, "") });
      return orig.apply(this, arguments);
    };
  }
  // navigation RSC requests (not prefetches): when the router asked, and when the network answered. Installed before
  // GenClass, so it sits under GenClass's own fetch observer and sees the network's timing, not the delivery's.
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const h = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
    if (h.get("rsc") !== "1" || h.get("next-router-prefetch")) return origFetch.apply(this, arguments);
    const url = String(input instanceof Request ? input.url : input).replace(location.origin, "").replace(/[?&]_rsc=[^&]+/, "");
    tl.push({ t: now(), k: "rsc-start", url });
    const p = origFetch.apply(this, arguments);
    p.then(() => tl.push({ t: now(), k: "rsc-net", url }), () => tl.push({ t: now(), k: "rsc-fail", url }));
    return p;
  };
  let last = null;
  const poll = () => {
    const el = document.querySelector('input[type="search"]');
    const v = el ? el.value : null;
    if (v !== last) { tl.push({ t: now(), k: "value", v }); last = v; }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
  document.addEventListener("keydown", (e) => { if (e.key.length === 1) tl.push({ t: now(), k: "key", v: e.key }); }, true);
};
const connectSource = `import { connectAgent } from "/__genclass/agent.js";
window.__GENCLASS_CONN__ = connectAgent(window.GenClass && window.GenClass.runtime, { url: window.__GENCLASS_AGENT_URL__ });
`;

let lastPage = null;
async function newPageContext() {
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1400, height: 900 } });
  ctx.on("page", (p) => (lastPage = p));
  await ctx.addInitScript(initScript, { bridge: bridgeUrl, token });
  // the runtime's files on a virtual same-origin path
  await ctx.route((u) => u.pathname.startsWith("/__genclass/"), async (route) => {
    const u = new URL(route.request().url());
    const file = join(rtDist, u.pathname.slice("/__genclass/".length));
    if (!file.startsWith(rtDist) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  // the page's HTML gets GenClass as its first script (so it sees every request and react-dom), then the agent link
  await ctx.route((u) => u.pathname === P.path, async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const res = await route.fetch();
    const ct = res.headers()["content-type"] ?? "";
    if (!ct.includes("text/html")) return route.fulfill({ response: res });
    const html = (await res.text()).replace(
      "<head>",
      `<head><script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script><script type="module">${connectSource}</script>`,
    );
    const { "content-encoding": _e, "content-length": _l, ...headers } = res.headers();
    return route.fulfill({ status: res.status(), headers, contentType: "text/html; charset=utf-8", body: html });
  });
  return ctx;
}

// --------------------------------------------------------------------------- one load: the scenario and its oracles
async function scenario() {
  const ctx = await newPageContext();
  const page = await ctx.newPage();
  const rsc = [];
  page.on("response", (r) => {
    const req = r.request();
    if (req.headers()["rsc"] === "1" && !req.headers()["next-router-prefetch"]) rsc.push({ url: req.url().replace(APP, "").replace(/[?&]_rsc=[^&]+/, ""), status: r.status() });
  });
  await page.goto(APP + P.path);
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
  await page.locator(P.rows).first().waitFor({ timeout: 20_000 });
  const box = page.getByRole("searchbox");
  await box.click();
  for (const part of PATTERN) {
    if (typeof part === "number") await page.waitForTimeout(part);
    else await box.pressSequentially(part, { delay: KEY_MS });
  }
  await page.evaluate((t) => window.__GENCLASS_AGENT__.whenSettled(t), 20_000);
  // the list query for the committed URL has rendered (nothing fetching, rows or the empty state shown)
  await page.waitForTimeout(300);
  await page.evaluate((t) => window.__GENCLASS_AGENT__.whenSettled(t), 20_000);
  const dom = await page.evaluate((rowsSel) => {
    const el = document.querySelector('input[type="search"]');
    return {
      value: el ? el.value : null,
      urlSearch: new URL(location.href).searchParams.get("search"),
      rows: [...document.querySelectorAll(rowsSel)].map((a) => a.textContent.trim()).filter(Boolean),
      timeline: window.__HUNT_TL__,
      stores: window.GenClass?.runtime?.stores?.().map((x) => `${x.kind}:${x.source ?? ""}:${x.name}`).slice(0, 80) ?? [],
      agent: {
        run: window.__GENCLASS_AGENT__?.run,
        schedule: window.__GENCLASS_AGENT__?.schedule,
        witnesses: window.__GENCLASS_AGENT__?.witnesses?.() ?? [],
        forced: window.__GENCLASS_AGENT__?.snapshot?.().forced,
      },
    };
  }, P.rows);
  await page.waitForTimeout(500); // the snapshot batch reaches the bridge
  await ctx.close();
  const listForInput = dom.value === TYPED ? EXPECTED : await apiNames(dom.value ?? "");
  return {
    typed: TYPED,
    value: dom.value,
    urlSearch: dom.urlSearch,
    oracle: {
      input: dom.value === TYPED ? "pass" : "FAIL",
      list: sameSet(dom.rows, EXPECTED) ? "pass" : "FAIL",
      listMatchesInput: sameSet(dom.rows, listForInput),
    },
    rows: dom.rows,
    expectedRows: EXPECTED,
    rsc,
    timeline: dom.timeline,
    stores: dom.stores,
    agent: { ...dom.agent, witnesses: dom.agent.witnesses.map((w) => `${w.kind} ${w.subject} by ${w.by} over ${w.over}`) },
  };
}

// --------------------------------------------------------------------------- the explore loop
const label = opt("label", `${pageName}-${patternName}-slow${SLOW}-seed${SEED}${ONCE ? "-once" : ""}`);
const summary = { page: P.path, pattern: patternName, parts: PATTERN, typed: TYPED, keyMs: KEY_MS, slow_ms: SLOW, runs: RUNS, seed: SEED, started: new Date().toISOString(), loads: [] };
const save = () => writeFileSync(join(OUT, `${label}.json`), JSON.stringify(summary, null, 2));
const brief = (r) => `input ${r.oracle.input} (${JSON.stringify(r.value)}) list ${r.oracle.list} (${r.rows.length} rows) url ${JSON.stringify(r.urlSearch)} schedule ${JSON.stringify(r.agent.schedule)} witnesses ${r.agent.witnesses.length} forced ${r.agent.forced}`;

if (ONCE) {
  const r = await scenario();
  summary.loads.push(r);
  log(brief(r));
  console.log(JSON.stringify({ stores: r.stores, timeline: r.timeline, rsc: r.rsc, witnesses: r.agent.witnesses }, null, 1));
  console.log(await tool("genclass_status"));
  save();
} else {
  summary.exploreStart = await tool("genclass_explore", { action: "start", runs: RUNS, slow_ms: SLOW, seed: SEED, route: P.path });
  log(summary.exploreStart.split("\n")[0]);
  for (let i = 0; i < RUNS + 2; i++) {
    try {
      const r = await scenario();
      summary.loads.push({ n: i + 1, ...r });
      log(`load ${i + 1}/${RUNS + 2}: ${brief(r)}`);
    } catch (e) {
      log(`load ${i + 1} failed:`, e.message.split("\n")[0]);
      const shot = join(OUT, `failure-${label}-${i + 1}.png`);
      await lastPage?.screenshot({ path: shot }).catch(() => {});
      await lastPage?.context().close().catch(() => {});
      summary.loads.push({ n: i + 1, error: e.message.split("\n").slice(0, 3).join(" ") });
    }
    save();
  }
  summary.report = await tool("genclass_explore", { action: "report" });
  console.log(summary.report);
  const ids = [...summary.report.matchAll(/Race finding\(s\): ([^\n]+)/g)].flatMap((m) => m[1].split("Next:")[0].match(/\bf\d+\b/g) ?? []);
  summary.findings = await tool("genclass_findings", {});
  summary.explains = {};
  for (const id of new Set(ids)) summary.explains[id] = await tool("genclass_explain", { id });
  if (REPLAY && ids[0]) {
    await tool("genclass_replay", { action: "arm", id: ids[0] });
    const r = await scenario();
    summary.replayLoad = r;
    summary.replay = await tool("genclass_replay", { action: "result", id: ids[0] });
    log(`replay ${ids[0]}: ${brief(r)}`);
    console.log(summary.replay);
  }
  const n = summary.loads.filter((l) => l.oracle);
  summary.oracles = {
    loads: n.length,
    inputFail: n.filter((l) => l.oracle.input === "FAIL").length,
    listFail: n.filter((l) => l.oracle.list === "FAIL").length,
    exploreRace: /RACE:/.test(summary.report) ? /RACE: (\d+) of (\d+)/.exec(summary.report)?.slice(1).join(" of ") ?? "race" : "no race",
  };
  log("oracles", JSON.stringify(summary.oracles));
  save();
}
log("written", join(OUT, `${label}.json`));
await browser.close();
await served.close();
process.exit(0);

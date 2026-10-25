// The GenClass race hunt on Vikunja's task detail view and kanban board (docs/adoption/hunts/vikunja.md). Not part of CI.
//
// It drives a locally running Vikunja (the API on 127.0.0.1:3456, the Vite dev frontend on VIKUNJA_URL, default
// http://127.0.0.1:4173, proxying /api to the API) in headless Chromium with the real @genclass/runtime script-tag build
// and the agent entry injected into the frontend's HTML by Playwright (Vikunja's source is untouched), the real
// @genclass/mcp server in-process (its bridge on a free port), and the same tool calls a coding agent makes:
// genclass_explore start → one page load per armed run → report → genclass_explain → genclass_replay.
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/mcp     # in GenClass-lib
//   node docs/adoption/hunts/vikunja/hunt.mjs setup                          # once: user, project, task, board
//   node docs/adoption/hunts/vikunja/hunt.mjs once <scenario> [slow_ms]      # one load, the recording printed
//   node docs/adoption/hunts/vikunja/hunt.mjs explore <scenario> <slow_ms> [runs]
//   node docs/adoption/hunts/vikunja/hunt.mjs replay <scenario> <finding id>
//
// Every load starts from the same server state: the harness resets the task (or the board) through the API before
// the page loads, outside the browser, so nothing of the reset is recorded. Vikunja keeps its state in TanStack Vue
// Query and component refs, which GenClass does not discover, so the injected script registers one atom, "visible",
// that mirrors the fields the page shows (written from a MutationObserver: the write runs in the same microtask
// checkpoint as the Vue render that caused it, so the runtime attributes it to that response or user action). Besides
// the explore verdict, every load reads its own oracle after the page settled: the server's task (GET /api/v2/tasks/
// {id}) and the page's fields, compared with the last edit the scenario made.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { chromium } from "@playwright/test";
import { serve } from "../../../../packages/mcp/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const rtDist = join(repo, "packages/runtime/dist");
const APP = (process.env.VIKUNJA_URL ?? "http://127.0.0.1:4173").replace(/\/+$/, "");
const OUT = process.env.HUNT_OUT ?? "/home/user/vikunja-hunt/out";
const FIXTURE = join(OUT, "fixture.json");
const USER = { username: "hunt", email: "hunt@example.com", password: "HuntPassw0rd!" };
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
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vikunja-hunt", version: "1" } });
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

// --------------------------------------------------------------------------- the API (fixture, reset, oracle)
let token = null;
async function api(method, path, body, type = "application/json") {
  const r = await fetch(APP + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": type } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok && r.status !== 304) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`); // PATCH answers 304 when nothing changed
  return text ? JSON.parse(text) : null;
}
async function apiLogin() {
  token = (await api("POST", "/api/v1/login", { username: USER.username, password: USER.password, long_token: true })).token;
  return token;
}
const patchTask = (taskId, fields) =>
  api("PATCH", `/api/v2/tasks/${taskId}`, Object.entries(fields).map(([k, v]) => ({ op: "add", path: `/${k}`, value: v })), "application/json-patch+json");

// The detail scenarios' starting state: every field the scenarios touch is set, so its column is shown.
const TASK0 = {
  title: "Race hunt task",
  description: "<p>Original description</p>",
  done: false,
  priority: 1, // Low
  percent_done: 0.1,
  due_date: "2026-11-02T12:00:00Z",
};
const fixture = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

async function setup() {
  try {
    await api("POST", "/api/v1/register", USER);
  } catch (e) {
    if (!/already exists|1001|2002/.test(String(e.message))) console.log("register:", e.message.slice(0, 120));
  }
  await apiLogin();
  const project = await api("POST", "/api/v2/projects", { title: "Race hunt" });
  const views = (await api("GET", `/api/v2/projects/${project.id}`)).views ?? [];
  const kanban = views.find((v) => v.view_kind === "kanban");
  const task = await api("POST", `/api/v2/projects/${project.id}/tasks`, { title: TASK0.title });
  await patchTask(task.id, TASK0);
  const existing = (await api("GET", `/api/v2/projects/${project.id}/views/${kanban.id}/buckets`)).items ?? [];
  const buckets = [existing[0]];
  for (const title of ["Doing", "Review"]) buckets.push(await api("POST", `/api/v2/projects/${project.id}/views/${kanban.id}/buckets`, { title }));
  const cards = [];
  for (const title of ["Card A", "Card B", "Card C"]) cards.push(await api("POST", `/api/v2/projects/${project.id}/tasks`, { title }));
  const fx = { user: USER.username, project: project.id, kanban: kanban.id, task: task.id, buckets: buckets.map((b) => ({ id: b.id, title: b.title })), cards: cards.map((c) => ({ id: c.id, title: c.title })) };
  writeFileSync(FIXTURE, JSON.stringify(fx, null, 2));
  await resetBoard(fx);
  return fx;
}

async function resetTask(fx) {
  await patchTask(fx.task, TASK0);
}
// all cards back in the first bucket, at asymmetric positions (the drag midpoints then differ from every card's own)
async function resetBoard(fx) {
  await resetTask(fx); // the detail task sits on the same board; its title is part of the page text
  const positions = [100, 250, 300];
  for (const [i, c] of fx.cards.entries()) {
    await api("PUT", `/api/v2/projects/${fx.project}/views/${fx.kanban}/buckets/${fx.buckets[0].id}/tasks`, { task_id: c.id });
    await api("PUT", `/api/v2/tasks/${c.id}/position`, { project_view_id: fx.kanban, position: positions[i] });
  }
}

// --------------------------------------------------------------------------- injection (Vikunja's files untouched)
// The atom mirrors what the page shows. It reads the DOM only: the task detail's fields and the board's columns.
function mirror() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
  const column = (name) => Array.from(document.querySelectorAll(".task-view .columns.details .column")).find((c) => text(c.querySelector(".detail-title")) === name) ?? null;
  const read = () => {
    const out = {};
    const view = document.querySelector(".task-view");
    if (view) {
      out.title = text(document.querySelector(".task-view .heading h1.title"));
      out.description = text(document.querySelector(".task-view .tiptap__task-description .tiptap"));
      out.priority = column("Priority")?.querySelector("select")?.value ?? null;
      out.percentDone = column("Progress")?.querySelector("select")?.value ?? null;
      out.dueDate = text(column("Due Date")?.querySelector(".datepicker .show"));
    }
    const board = document.querySelector(".kanban-view");
    if (board) {
      out.board = Object.fromEntries(
        Array.from(board.querySelectorAll(".bucket:not(.new-bucket)")).map((b) => [
          text(b.querySelector(".bucket-header .title")) ?? "?",
          Array.from(b.querySelectorAll(".task-item .kanban-card__title-link, .task-item .tw\\:w-full")).map((a) => text(a)).filter(Boolean).join(" | "),
        ]),
      );
    }
    return out;
  };
  return read;
}

function tags(bridgeUrl) {
  // observe mode, no model (nothing to download; explore needs none), no telemetry, no visual checks
  const cfg = { telemetry: false, mode: "observe", model: false, visual: false, devtools: false, report: "silent" };
  const atom = `const read=(${mirror.toString()})();` +
    `const st=rt.atom("visible",{});let last="{}";` +
    `const sync=()=>{try{const v=read();const s=JSON.stringify(v);if(s!==last){last=s;st.set(v);}}catch(e){}};` +
    `new MutationObserver(sync).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["value","class"]});` +
    `document.addEventListener("change",sync,true);`;
  return (
    `<script>window.GENCLASS_CONFIG=${JSON.stringify(cfg)};window.__GENCLASS_AGENT_URL__=${JSON.stringify(bridgeUrl)};</script>` +
    `<script src="/__genclass/genclass.global.js" data-base="/__genclass/"></script>` +
    `<script type="module">import{connectAgent}from"/__genclass/agent.js";const rt=window.GenClass.runtime;` +
    `window.__GENCLASS_CONN__=connectAgent(rt,{url:${JSON.stringify(bridgeUrl)}});${atom}</script>`
  );
}
async function inject(context, bridgeUrl) {
  // hermetic runs: nothing but the local frontend (and its API proxy) and the bridge is reachable
  await context.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => route.abort());
  await context.route("**/__genclass/**", (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/__genclass\//, "");
    const file = resolve(rtDist, p);
    if (!file.startsWith(rtDist) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
  });
  await context.route(
    (url) => url.origin === new URL(APP).origin && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__genclass/"),
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

async function newPage(browser, bridgeUrl) {
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  await inject(ctx, bridgeUrl);
  // signed in the way Vikunja's own e2e support does it (tests/support/authenticateUser.ts): the token and the API
  // root in localStorage; without API_URL a deep link to /tasks/:id is sent through /login to the home page. The API
  // root is the frontend's own origin, whose /api the Vite dev server proxies to the API.
  await ctx.addInitScript(([t, apiUrl]) => {
    try {
      localStorage.setItem("token", t);
      localStorage.setItem("API_URL", apiUrl);
      window.API_URL = apiUrl;
    } catch {
      /* ignore */
    }
  }, [token, APP]);
  const page = await ctx.newPage();
  const log = [];
  page.on("console", (m) => {
    const t = m.type();
    const text = m.text();
    if (t === "error" || t === "warning" || /genclass/i.test(text)) log.push(`${t}: ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => log.push(`pageerror: ${String(e.message ?? e).slice(0, 300)}`));
  page.on("response", (r) => {
    if (r.status() >= 400) log.push(`http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  return { ctx, page, log };
}

const settle = (page, ms = 25_000) => page.evaluate((t) => window.__GENCLASS_AGENT__.whenSettled(t), ms);
const detailColumn = (page, name) => page.locator(".task-view .columns.details .column").filter({ has: page.locator(".detail-title", { hasText: name }) });
const prioritySelect = (page) => detailColumn(page, "Priority").locator("select");
const percentSelect = (page) => detailColumn(page, "Progress").locator("select");
// A select is changed the way a keyboard user changes it (focus, then the option's first character, which no other
// option shares), not with selectOption: Playwright's selectOption dispatches untrusted input/change events, which the
// runtime does not record as user actions (the act, and the write it makes, would have no user op).
async function choose(select, label) {
  await select.focus();
  await select.page().keyboard.press(label[0]);
}

/** The page's fields (what the user sees) for the detail scenarios. */
async function uiTask(page) {
  return page.evaluate(() => {
    const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    const column = (name) => Array.from(document.querySelectorAll(".task-view .columns.details .column")).find((c) => text(c.querySelector(".detail-title")) === name) ?? null;
    return {
      title: text(document.querySelector(".task-view .heading h1.title")),
      description: text(document.querySelector(".task-view .tiptap__task-description .tiptap")),
      priority: Number(column("Priority")?.querySelector("select")?.value ?? NaN),
      percent_done: Number(column("Progress")?.querySelector("select")?.value ?? NaN),
      due: text(column("Due Date")?.querySelector(".datepicker .show")),
    };
  });
}
async function serverTask(taskId) {
  const t = await api("GET", `/api/v2/tasks/${taskId}`);
  return { title: t.title, description: t.description, priority: t.priority, percent_done: t.percent_done, due_date: t.due_date };
}
const stripHtml = (s) => (s ?? "").replace(/<[^>]+>/g, "").trim();

// --------------------------------------------------------------------------- scenarios
// Each scenario: reset (the server state before the load), path, ready (the page is usable), steps (the edits, as a
// user makes them, quickly), expect (the last edit of each field), oracle (UI and server after the page settled).
const detailOracle = async (page, fx, expect) => {
  const ui = await uiTask(page);
  const server = await serverTask(fx.task);
  const wrong = [];
  for (const [k, v] of Object.entries(expect)) {
    if (k === "description") {
      if (stripHtml(server.description) !== v) wrong.push(`server.description=${JSON.stringify(stripHtml(server.description))}`);
      if (ui.description !== v) wrong.push(`ui.description=${JSON.stringify(ui.description)}`);
    } else if (k === "title") {
      if (server.title !== v) wrong.push(`server.title=${JSON.stringify(server.title)}`);
      if (ui.title !== v) wrong.push(`ui.title=${JSON.stringify(ui.title)}`);
    } else if (k === "due_date") {
      if (server.due_date?.slice(0, 10) !== v) wrong.push(`server.due_date=${server.due_date}`);
    } else {
      if (server[k] !== v) wrong.push(`server.${k}=${server[k]}`);
      if (ui[k] !== v) wrong.push(`ui.${k}=${ui[k]}`);
    }
  }
  return { ui, server, wrong };
};
const ready = async (page) => {
  await page.locator(".task-view .heading h1.title").first().waitFor({ timeout: 30_000 });
  await prioritySelect(page).waitFor({ timeout: 30_000 });
};
const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};
async function pickDueTomorrow(page) {
  await detailColumn(page, "Due Date").locator(".datepicker .show").click();
  await page.locator(".datepicker .datepicker-popup button").filter({ hasText: "Tomorrow" }).click();
  const confirm = page.locator('[data-cy="closeDatepicker"]').filter({ hasText: "Confirm" });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

const SCENARIOS = {
  // (1) two quick field edits on one task: the due date through the datepicker (@closeOnChange → saveTask), then the
  // priority (@update:modelValue → setPriority → saveTask) while the first PATCH is in flight
  "two-edits": {
    kind: "detail",
    reset: resetTask,
    path: (fx) => `/tasks/${fx.task}`,
    ready,
    steps: async (page) => {
      await pickDueTomorrow(page);
      await choose(prioritySelect(page), "High");
    },
    expect: () => ({ priority: 3, due_date: tomorrow() }),
  },
  // (2) three quick edits: the due date, the priority, then the percent done
  "three-edits": {
    kind: "detail",
    reset: resetTask,
    path: (fx) => `/tasks/${fx.task}`,
    ready,
    steps: async (page) => {
      await pickDueTomorrow(page);
      await choose(prioritySelect(page), "High");
      await choose(percentSelect(page), "50%");
    },
    expect: () => ({ priority: 3, percent_done: 0.5, due_date: tomorrow() }),
  },
  // (2') the same field twice: the priority to High, then to Urgent
  "priority-twice": {
    kind: "detail",
    reset: resetTask,
    path: (fx) => `/tasks/${fx.task}`,
    ready,
    steps: async (page) => {
      await choose(prioritySelect(page), "High");
      // a second letter within a second extends the select's type-ahead ("hu" matches nothing): the next option instead
      await page.keyboard.press("ArrowDown"); // Urgent
    },
    expect: () => ({ priority: 4 }),
  },
  // (3) a title edit while the description autosaves: the description is changed and saved (its own Save button;
  // the 5 s autosave sends the same request), then the title is edited and confirmed with Enter while that PATCH is
  // in flight
  "title-description": {
    kind: "detail",
    reset: resetTask,
    path: (fx) => `/tasks/${fx.task}`,
    ready,
    steps: async (page) => {
      // as Vikunja's own e2e edits it (tests/e2e/task/tiptap-editor-save.spec.ts): Edit, fill, Save
      await page.locator(".task-view .details.content.description .tiptap button.done-edit").click();
      await page.locator(".task-view .details.content.description .tiptap__editor .tiptap.ProseMirror").fill("Edited description");
      await page.locator('[data-cy="saveEditor"]').filter({ hasText: "Save" }).click();
      const title = page.locator(".task-view .heading h1.title");
      await title.click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("Edited title");
      await page.keyboard.press("Enter");
    },
    expect: () => ({ title: "Edited title", description: "Edited description" }),
  },
  // (4) two quick kanban drags: Card A to Doing, then Card B to Review, the second before the first's requests ended
  "kanban-drags": {
    kind: "board",
    reset: resetBoard,
    path: (fx) => `/projects/${fx.project}/${fx.kanban}`,
    ready: async (page) => {
      await page.locator(".kanban-view .bucket .task-item").first().waitFor({ timeout: 30_000 });
    },
    steps: async (page, fx) => {
      await dragTo(page, fx.cards[0].title, fx.buckets[1].title);
      await dragTo(page, fx.cards[1].title, fx.buckets[2].title);
    },
    expect: (fx) => ({ [fx.cards[0].title]: fx.buckets[1].title, [fx.cards[1].title]: fx.buckets[2].title, [fx.cards[2].title]: fx.buckets[0].title }),
  },
};

// as Vikunja's own e2e drags a card (tests/e2e/project/project-view-kanban.spec.ts): locator.dragTo onto the
// target bucket's task list
async function dragTo(page, cardTitle, bucketTitle) {
  const card = page.locator(".kanban .bucket .tasks .task").filter({ hasText: cardTitle }).first();
  const bucket = page.locator(".kanban .bucket").filter({ has: page.locator(".bucket-header .title", { hasText: bucketTitle }) }).first();
  await card.dragTo(bucket.locator(".tasks").first());
}

async function boardOracle(page, fx, expect) {
  const ui = await page.evaluate(() => {
    const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    const out = {};
    for (const b of document.querySelectorAll(".kanban-view .bucket:not(.new-bucket)")) {
      const title = text(b.querySelector(".bucket-header .title"));
      for (const card of b.querySelectorAll(".task-item")) {
        for (const name of ["Card A", "Card B", "Card C"]) if (text(card)?.includes(name)) out[name] = title;
      }
    }
    return out;
  });
  const server = {};
  const buckets = await api("GET", `/api/v2/projects/${fx.project}/views/${fx.kanban}/buckets/tasks?per_page=50`);
  for (const b of buckets.items ?? []) for (const t of b.tasks ?? []) server[t.title] = b.title;
  const wrong = [];
  for (const [card, bucket] of Object.entries(expect)) {
    if (server[card] !== bucket) wrong.push(`server.${card}=${server[card]}`);
    if (ui[card] !== bucket) wrong.push(`ui.${card}=${ui[card]}`);
  }
  return { ui, server, wrong };
}

// --------------------------------------------------------------------------- one page load (one run)
async function load(browser, bridgeUrl, scenario, i) {
  const fx = fixture();
  await scenario.reset(fx);
  const { ctx, page, log } = await newPage(browser, bridgeUrl);
  const t0 = Date.now();
  const out = { i, log };
  try {
    await page.goto(APP + scenario.path(fx));
    if (bridgeUrl) await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 60_000 });
    if (bridgeUrl) {
      out.schedule = await page.evaluate(() => window.__GENCLASS_AGENT__.schedule);
      out.run = await page.evaluate(() => window.__GENCLASS_AGENT__.run);
    }
    await scenario.ready(page);
    if (bridgeUrl) await settle(page, 30_000);
    out.t = { ready: Date.now() - t0 };
    await scenario.steps(page, fx);
    out.t.steps = Date.now() - t0;
    if (bridgeUrl) out.settled = await settle(page);
    else await page.waitForTimeout(3000);
    out.t.settled = Date.now() - t0;
    await page.waitForTimeout(300);
    const expect = scenario.expect(fx);
    out.expect = expect;
    out.oracle = scenario.kind === "board" ? await boardOracle(page, fx, expect) : await detailOracle(page, fx, expect);
    if (bridgeUrl) {
      out.snapshot = await page.evaluate(() => {
        const s = window.__GENCLASS_AGENT__.snapshot();
        const rec = window.__GENCLASS_AGENT__.recorded();
        return {
          visible: Object.fromEntries(Object.entries(s.state).filter(([k]) => k.startsWith("visible"))),
          stateFields: Object.keys(s.state).length,
          steps: rec.steps.map((x) => `${x.k} ${x.kind ?? ""} ${x.key ?? ""} ${x.target ?? ""}${x.value !== undefined ? ` = ${x.value}` : ""}${x.field ? ` ${x.field}` : ""}${x.by ? ` by ${x.by}` : ""}`),
          requests: s.requests,
          witnesses: window.__GENCLASS_AGENT__.witnesses().map((w) => `${w.kind} ${w.subject} by ${w.by}`),
          errors: s.errors,
          forced: s.forced,
          acts: rec.steps.filter((x) => x.k === "act").map((a) => `${a.kind} ${a.target ?? ""}${a.value !== undefined ? ` = ${a.value}` : ""}${a.clicks > 1 ? ` x${a.clicks}` : ""}`),
          sends: rec.steps.filter((x) => x.k === "send").map((x) => x.key),
          order: rec.order,
        };
      });
      await page.waitForTimeout(600); // the last batch and the end reach the bridge
    }
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 2000);
  }
  out.ms = Date.now() - t0;
  await ctx.close();
  return out;
}
const summary = (l) =>
  `load ${l.i}: ${l.schedule ? `${l.schedule.order}${l.schedule.seed !== undefined ? ` seed ${l.schedule.seed}` : ""}` : "no schedule"} settled=${l.settled} sends=${l.snapshot?.sends?.length} witnesses=${l.snapshot?.witnesses?.length} forced=${l.snapshot?.forced} oracle=${l.oracle ? (l.oracle.wrong.length ? `WRONG ${l.oracle.wrong.join(", ")}` : "ok") : "?"} ${l.ms} ms${l.error ? ` ERROR ${l.error.slice(0, 300)}` : ""}${l.log?.length ? ` log=${JSON.stringify(l.log.slice(0, 3))}` : ""}`;

// --------------------------------------------------------------------------- commands
const cmd = process.argv[2];
// --no-proxy-server: the container's HTTPS proxy must not see localhost. The Local Network Access checks are off
// because a document Playwright fulfilled has no address space of its own, so Chromium would refuse the page's
// requests to the loopback bridge; a developer's own page, served from localhost, is not affected.
const browser = await chromium.launch({ args: ["--no-proxy-server", "--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers"] });

if (cmd === "setup") {
  console.log(JSON.stringify(await setup(), null, 2));
} else if (cmd === "probe") {
  await apiLogin();
  const bridgeUrl = await startServer();
  const { ctx, page, log } = await newPage(browser, bridgeUrl);
  await page.goto(APP + (process.argv[3] ?? `/tasks/${fixture().task}`));
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 60_000 }).catch((e) => console.log("not connected:", e.message));
  await page.waitForTimeout(Number(process.argv[4] ?? 5000));
  if (process.argv[5]) for (const html of await page.locator(process.argv[5]).evaluateAll((els) => els.map((e) => e.outerHTML.slice(0, 3000)))) console.log(html);
  else console.log((await page.locator("body").ariaSnapshot()).slice(0, 6000));
  console.log(page.url());
  console.log(await page.evaluate(() => JSON.stringify({ conn: window.__GENCLASS_AGENT__?.connected, schedule: window.__GENCLASS_AGENT__?.schedule, visible: window.__GENCLASS_AGENT__?.snapshot().state.visible })));
  console.log(log.join("\n"));
  await page.screenshot({ path: join(OUT, "probe.png") });
  await ctx.close();
} else if (cmd === "once") {
  const scenario = SCENARIOS[process.argv[3]];
  if (!scenario) throw new Error(`unknown scenario; one of ${Object.keys(SCENARIOS).join(", ")}`);
  await apiLogin();
  const bridgeUrl = process.env.HUNT_NO_GENCLASS ? null : await startServer();
  if (bridgeUrl && process.argv[4]) console.log(await tool("genclass_explore", { action: "start", runs: 1, slow_ms: Number(process.argv[4]) }));
  const l = await load(browser, bridgeUrl, scenario, 0);
  console.log(summary(l));
  console.log(JSON.stringify({ oracle: l.oracle, acts: l.snapshot?.acts, sends: l.snapshot?.sends, order: l.snapshot?.order, witnesses: l.snapshot?.witnesses, visible: l.snapshot?.visible, steps: l.snapshot?.steps, log: l.log, error: l.error }, null, 1));
} else if (cmd === "explore") {
  const name = process.argv[3];
  const slow = Number(process.argv[4] ?? 600);
  const runs = Number(process.argv[5] ?? 6);
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}; one of ${Object.keys(SCENARIOS).join(", ")}`);
  await apiLogin();
  const bridgeUrl = await startServer();
  const result = { scenario: name, slow_ms: slow, runs, variant: process.env.HUNT_TAG ?? "unfixed", startedAt: new Date().toISOString(), loads: [] };
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
  const fids = [...new Set([...result.report.matchAll(/\b(f\d+)\b/g)].map((m) => m[1]))];
  result.findings = await tool("genclass_findings", { limit: 20 });
  if (/RACE:/.test(result.report) && fids.length) {
    result.explain = {};
    for (const fid of fids) result.explain[fid] = await tool("genclass_explain", { id: fid });
    console.log(result.explain[fids[0]]);
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
  await apiLogin();
  const bridgeUrl = await startServer();
  console.log(await tool("genclass_replay", { action: "arm", id: fid }));
  const l = await load(browser, bridgeUrl, scenario, 99);
  console.log(summary(l));
  console.log(JSON.stringify(l.oracle));
  console.log(await tool("genclass_replay", { action: "result", id: fid }));
} else if (cmd === "explain") {
  await startServer();
  console.log(await tool("genclass_explain", { id: process.argv[3] }));
} else {
  console.log("usage: hunt.mjs setup | once <scenario> [slow_ms] | explore <scenario> <slow_ms> [runs] | replay <scenario> <id> | explain <id>");
}
await browser.close();
if (served) await served.close();
process.exit(0);

// The GenClass-free reproduction of the Vikunja task autosave race (docs/adoption/hunts/vikunja.md section 5).
// Plain Playwright, nothing injected: page.route lets the first PATCH /api/v2/tasks/{id} reach the server at once (so
// the server applies the two saves in the order they were made) and only hands its response to the page DELAY_MS
// later, the way a slow or congested network does. Not part of CI.
//
//   node docs/adoption/hunts/vikunja/repro.mjs [runs] [delay_ms]         # default 3 runs, 800 ms
//
// Each run, on its own task (created once, reset through the API before every run):
//   1. open /tasks/{id}; set the due date (Tomorrow, Confirm), then the priority to High with the keyboard;
//   2. after both responses landed: the page's priority and the server's (GET /api/v2/tasks/{id});
//   3. one more edit (Progress 50%, no delay): the server's priority after it.
// Then the same with no delay (the control), and the title/description variant: the description is saved, then the
// title is edited and confirmed while the description's PATCH response is delayed.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const APP = (process.env.VIKUNJA_URL ?? "http://127.0.0.1:4173").replace(/\/+$/, "");
const OUT = process.env.HUNT_OUT ?? "/home/user/vikunja-hunt/out";
const RUNS = Number(process.argv[2] ?? 3);
const DELAY_MS = Number(process.argv[3] ?? 800);
const START = { title: "Repro task", description: "<p>Original description</p>", done: false, priority: 1, percent_done: 0.1, due_date: "2026-11-02T12:00:00Z" };
mkdirSync(OUT, { recursive: true });

let token;
async function api(method, path, body, type = "application/json") {
  const r = await fetch(APP + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": type } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok && r.status !== 304) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const patch = (id, fields) => api("PATCH", `/api/v2/tasks/${id}`, Object.entries(fields).map(([k, v]) => ({ op: "add", path: `/${k}`, value: v })), "application/json-patch+json");

token = (await api("POST", "/api/v1/login", { username: "hunt", password: "HuntPassw0rd!", long_token: true })).token;
const file = join(OUT, "repro-task.json");
let taskId;
if (existsSync(file)) taskId = JSON.parse(readFileSync(file, "utf8")).id;
else {
  const fx = JSON.parse(readFileSync(join(OUT, "fixture.json"), "utf8"));
  taskId = (await api("POST", `/api/v2/projects/${fx.project}/tasks`, { title: START.title })).id;
  writeFileSync(file, JSON.stringify({ id: taskId }));
}

const browser = await chromium.launch({ args: ["--no-proxy-server"] });

async function open(delayFirstPatch) {
  await patch(taskId, START);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  // signed in as Vikunja's e2e support does it: the token and the API root in localStorage
  await ctx.addInitScript(([t, u]) => {
    localStorage.setItem("token", t);
    localStorage.setItem("API_URL", u);
  }, [token, APP]);
  const page = await ctx.newPage();
  const patches = [];
  await page.route(`**/api/v2/tasks/${taskId}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const n = patches.length + 1;
    const entry = { n, sentAt: Date.now() };
    patches.push(entry);
    const response = await route.fetch(); // the server has applied this save now
    entry.answeredAt = Date.now();
    if (n === 1 && delayFirstPatch) await new Promise((r) => setTimeout(r, DELAY_MS));
    entry.deliveredAt = Date.now();
    await route.fulfill({ response });
  });
  await page.goto(`${APP}/tasks/${taskId}`);
  await page.locator(".task-view .heading h1.title").waitFor();
  await page.waitForLoadState("networkidle");
  return { ctx, page, patches };
}
const column = (page, name) => page.locator(".task-view .columns.details .column").filter({ has: page.locator(".detail-title", { hasText: name }) });
const settled = async (page, patches, n) => {
  for (let i = 0; i < 100 && patches.filter((p) => p.deliveredAt).length < n; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
};

async function twoEdits(delay) {
  const { ctx, page, patches } = await open(delay);
  await column(page, "Due Date").locator(".datepicker .show").click();
  await page.locator(".datepicker .datepicker-popup button").filter({ hasText: "Tomorrow" }).click();
  await page.locator('[data-cy="closeDatepicker"]').filter({ hasText: "Confirm" }).click();
  await column(page, "Priority").locator("select").focus();
  await page.keyboard.press("h"); // High
  await settled(page, patches, 2);
  const uiPriority = Number(await column(page, "Priority").locator("select").inputValue());
  const server1 = await api("GET", `/api/v2/tasks/${taskId}`);
  // one more edit, as the user goes on working on the task
  await column(page, "Progress").locator("select").focus();
  await page.keyboard.press("5"); // 50%
  await settled(page, patches, 3);
  const server2 = await api("GET", `/api/v2/tasks/${taskId}`);
  await ctx.close();
  return {
    delay: delay ? DELAY_MS : 0,
    deliveryOrder: [...patches].filter((p) => p.n <= 2).sort((a, b) => a.deliveredAt - b.deliveredAt).map((p) => `PATCH #${p.n}`),
    serverOrder: [...patches].filter((p) => p.n <= 2).sort((a, b) => a.answeredAt - b.answeredAt).map((p) => `PATCH #${p.n}`),
    afterTwoEdits: { pagePriority: uiPriority, serverPriority: server1.priority, serverDue: server1.due_date },
    afterThirdEdit: { serverPriority: server2.priority, serverProgress: server2.percent_done },
  };
}

async function titleDescription(delay) {
  const { ctx, page, patches } = await open(delay);
  await page.locator(".task-view .details.content.description .tiptap button.done-edit").click();
  await page.locator(".task-view .details.content.description .tiptap__editor .tiptap.ProseMirror").fill("Edited description");
  await page.locator('[data-cy="saveEditor"]').filter({ hasText: "Save" }).click();
  await page.locator(".task-view .heading h1.title").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Edited title");
  await page.keyboard.press("Enter");
  await settled(page, patches, 2);
  const shown = (await page.locator(".task-view .tiptap__task-description .tiptap").first().textContent()).trim();
  const server = await api("GET", `/api/v2/tasks/${taskId}`);
  await ctx.close();
  return { delay: delay ? DELAY_MS : 0, patches: patches.length, pageDescription: shown, serverTitle: server.title, serverDescription: server.description };
}

const result = { delayMs: DELAY_MS, runs: RUNS, twoEdits: { delayed: [], control: [] }, titleDescription: { delayed: [], control: [] } };
for (let i = 0; i < RUNS; i++) result.twoEdits.delayed.push(await twoEdits(true));
for (let i = 0; i < RUNS; i++) result.twoEdits.control.push(await twoEdits(false));
for (let i = 0; i < RUNS; i++) result.titleDescription.delayed.push(await titleDescription(true));
for (let i = 0; i < RUNS; i++) result.titleDescription.control.push(await titleDescription(false));
console.log(JSON.stringify(result, null, 1));
writeFileSync(join(OUT, `repro-${process.env.HUNT_TAG ?? "unfixed"}.json`), JSON.stringify(result, null, 2));
await browser.close();

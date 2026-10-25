// Probe (no GenClass, natural timing) on a draft of its own: is a title-only edit saved when it is the first edit
// after opening the post, and when the editor has been idle for 6 s first? Prints the writes and the server's title.
// Usage: node docs/adoption/hunts/ghost/probe-title-first.mjs
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const APP = (process.env.GHOST_URL ?? "http://localhost:2368").replace(/\/$/, "");
const STATE = process.env.GHOST_STATE ?? join(here, ".state", "ghost-state.json");
const sel = { title: '[data-testid="editor-title-input"]', body: '[data-testid="editor-body"] [contenteditable="true"]', status: '[data-testid="editor-status"]' };
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1400, height: 900 } });
const headers = { Origin: APP, "Content-Type": "application/json" };
const created = await (await ctx.request.post(`${APP}/ghost/api/admin/posts/?source=html`, { headers, data: { posts: [{ title: "Probe title first", html: "<p>Probe body.</p>", status: "draft" }] } })).json();
const id = created.posts[0].id;
const page = await ctx.newPage();
const writes = [];
page.on("request", (r) => { if (/\/ghost\/api\/admin\/posts\/[0-9a-f]+\//.test(r.url()) && /PUT/.test(r.method())) writes.push(`${new Date().toISOString().slice(11, 23)} ${r.method()} ${(r.postData() ?? "").includes('"title"') ? JSON.parse(r.postData()).posts[0].title : ""}`); });
const status = async () => (await page.locator(sel.status).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
const read = async () => (await (await ctx.request.get(`${APP}/ghost/api/admin/posts/${id}/`)).json()).posts[0];
async function open() {
  await page.goto(`${APP}/ghost/#/posts`);
  await page.waitForTimeout(800);
  await page.goto(`${APP}/ghost/#/editor/post/${id}`);
  await page.locator(sel.body).waitFor();
}
async function step(name, fn) {
  await fn();
  await page.waitForTimeout(8000);
  console.log(`${name}: status "${await status()}" | title field "${await page.locator(sel.title).inputValue()}" | server title "${(await read()).title}"`);
}
await open();
await page.waitForTimeout(1000);
await step("A opened, 1 s idle, title-only edit", async () => { await page.locator(sel.title).click(); await page.keyboard.press("End"); await page.locator(sel.title).pressSequentially(" one", { delay: 80 }); });
await open();
await page.waitForTimeout(6000);
await step("B opened, 6 s idle, title-only edit", async () => { await page.locator(sel.title).click(); await page.keyboard.press("End"); await page.locator(sel.title).pressSequentially(" two", { delay: 80 }); });
await step("C then a body edit", async () => { await page.locator(sel.body).click(); await page.keyboard.press("End"); await page.locator(sel.body).pressSequentially(" More.", { delay: 70 }); });
console.log(writes.join("\n"));
await ctx.request.delete(`${APP}/ghost/api/admin/posts/${id}/`, { headers });
await browser.close();

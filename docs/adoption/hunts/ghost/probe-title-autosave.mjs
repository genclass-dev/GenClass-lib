// Probe (no GenClass, natural timing): does a title-only edit autosave after earlier saves, on a new post and on an
// existing one? Prints the Admin API's title after each step. Usage: node docs/adoption/hunts/ghost/probe-title-autosave.mjs
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const APP = (process.env.GHOST_URL ?? "http://localhost:2368").replace(/\/$/, "");
const STATE = process.env.GHOST_STATE ?? join(here, ".state", "ghost-state.json");
const sel = { title: '[data-testid="editor-title-input"]', body: '[data-testid="editor-body"] [contenteditable="true"]', status: '[data-testid="editor-status"]' };
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const writes = [];
page.on("request", (r) => { if (/\/ghost\/api\/admin\/posts\//.test(r.url()) && /PUT|POST/.test(r.method())) writes.push(`${new Date().toISOString().slice(11, 23)} ${r.method()} ${r.url().replace(/\?.*/, "")} ${(r.postData() ?? "").includes('"title"') ? JSON.parse(r.postData()).posts[0].title : ""}`); });
const status = async () => (await page.locator(sel.status).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
const read = async (id) => (await (await ctx.request.get(`${APP}/ghost/api/admin/posts/${id}/?formats=plaintext`)).json()).posts[0];
const idOf = () => /#\/editor\/post\/([0-9a-f]{24})/.exec(new URL(page.url()).hash)?.[1];

async function step(name, fn, id) {
  await fn();
  await page.waitForTimeout(6000);
  const pid = id ?? idOf();
  const p = pid ? await read(pid) : null;
  console.log(`${name}: status "${await status()}" | title field "${await page.locator(sel.title).inputValue()}" | server title "${p?.title}" plaintext "${p?.plaintext?.replace(/\s+/g, " ").trim()}"`);
}

console.log("== new post");
await page.goto(`${APP}/ghost/#/editor/post/`);
await page.locator(sel.body).waitFor();
await step("1 title typed", async () => { await page.locator(sel.title).click(); await page.locator(sel.title).pressSequentially("Probe post", { delay: 80 }); });
await step("2 body typed", async () => { await page.locator(sel.body).click(); await page.locator(sel.body).pressSequentially("Body one.", { delay: 70 }); });
await step("3 body typed again", async () => { await page.locator(sel.body).click(); await page.keyboard.press("End"); await page.locator(sel.body).pressSequentially(" Body two.", { delay: 70 }); });
await step("4 title-only edit", async () => { await page.locator(sel.title).click(); await page.keyboard.press("End"); await page.locator(sel.title).pressSequentially(" done", { delay: 80 }); });
await step("5 wait 10 s more", async () => { await page.waitForTimeout(10000); });
await step("6 body typed after", async () => { await page.locator(sel.body).click(); await page.keyboard.press("End"); await page.locator(sel.body).pressSequentially(" Three.", { delay: 70 }); });
const newId = idOf();
console.log(writes.join("\n"));
writes.length = 0;

console.log("== existing post (reopened)");
await page.goto(`${APP}/ghost/#/posts`);
await page.waitForTimeout(1500);
await page.goto(`${APP}/ghost/#/editor/post/${newId}`);
await page.locator(sel.body).waitFor();
await page.waitForTimeout(1500);
await step("7 body typed", async () => { await page.locator(sel.body).click(); await page.keyboard.press("End"); await page.locator(sel.body).pressSequentially(" Four.", { delay: 70 }); }, newId);
await step("8 title-only edit", async () => { await page.locator(sel.title).click(); await page.keyboard.press("End"); await page.locator(sel.title).pressSequentially(" again", { delay: 80 }); }, newId);
await step("9 wait 10 s more", async () => { await page.waitForTimeout(10000); }, newId);
console.log(writes.join("\n"));
await ctx.request.delete(`${APP}/ghost/api/admin/posts/${newId}/`, { headers: { Origin: APP } });
await browser.close();

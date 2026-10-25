// Confirms the Directus item-view race WITHOUT GenClass: plain Playwright, no injected script, no special browser
// flags. The only intervention is a page.route delay on the requests for article 2 (a slow response), armed after
// article 1 has loaded.
//
//   node confirm-plain.mjs --delay 600 --gap 100 --repeat 3 [--save summary|title] [--out file.jsonl]
//
// Flow (what a person does): open the Articles list, click "Alpha" (article 1), click "Navigate to item" on its
// Related field (article 2), and --gap ms later click the header back arrow (back to article 1).
// With --save: then edit a field the way a person would (append to Summary, or replace Title), click Save, and read
// article 1 and article 2 back from the API to see what was written.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// GENCLASS_LIB: a GenClass-lib checkout with both packages built (default: this repository)
const LIB = process.env.GENCLASS_LIB ?? fileURLToPath(new URL("../../../../", import.meta.url));
const { chromium } = await import(pathToFileURL(join(LIB, "node_modules/@playwright/test/index.mjs")).href);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]] : acc), []),
);
const DELAY = Number(args.delay ?? 600);
const GAP = Number(args.gap ?? 100);
const REPEAT = Number(args.repeat ?? 1);
const SAVE = args.save ?? null;
const OUT = args.out ?? null;
const APP = "http://localhost:8080";
const API = "http://127.0.0.1:8055";

const SEED = {
  1: { title: "Alpha: launch checklist", summary: "Alpha body: the steps before a launch.", status: "draft", topic: "rest", author: 1, related: 2 },
  2: { title: "Bravo: incident review", summary: "Bravo body: what failed on Tuesday.", status: "review", topic: "redis", author: 2, related: 3 },
};
async function adminToken() {
  const r = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: "hunt-admin-pw" }) });
  return (await r.json()).data.access_token;
}
async function readArticle(token, id) {
  const r = await fetch(`${API}/items/articles/${id}?fields=id,title,summary,status,topic,author,related`, { headers: { authorization: `Bearer ${token}` } });
  return (await r.json()).data;
}
async function restore(token) {
  for (const [id, v] of Object.entries(SEED)) await fetch(`${API}/items/articles/${id}`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(v) });
}

const browser = await chromium.launch();
const results = [];
for (let n = 1; n <= REPEAT; n++) {
  const token = await adminToken();
  if (SAVE) await restore(token);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies(["license-onboarding-dismissed", "license-banner-dismissed", "license-login-modal-dismissed"].map((name) => ({ name, value: "true", url: APP })));
  await ctx.request.post(`${APP}/auth/login`, { data: { email: "admin@example.com", password: "hunt-admin-pw", mode: "session" } });
  const page = await ctx.newPage();
  let armed = false;
  let tClick = 0;
  const net = [];
  const rel = () => (tClick ? Date.now() - tClick : null);
  // the only intervention: article 2's requests answer DELAY ms late once armed (a slow network for that request)
  await page.route(/\/items\/articles\/2(\?|$)/, async (route) => {
    if (armed && route.request().method() === "GET" && DELAY > 0) await new Promise((r) => setTimeout(r, DELAY));
    await route.continue();
  });
  page.on("request", (q) => {
    const u = q.url();
    if (tClick && /\/items\/articles\/[12](\?|$)/.test(u)) net.push({ ev: "request", at: rel(), method: q.method(), path: u.replace(APP, "") });
  });
  page.on("requestfinished", (q) => {
    const u = q.url();
    if (tClick && /\/items\/articles\/[12](\?|$)/.test(u)) net.push({ ev: "response", at: rel(), method: q.method(), path: u.replace(APP, "") });
  });
  await page.goto(`${APP}/admin/content/articles`);
  await page.locator(".table-row", { hasText: "Alpha: launch checklist" }).click({ timeout: 60_000 });
  await page.locator('.field[data-field="related"] .preview', { hasText: "Bravo" }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  armed = true;
  tClick = Date.now();
  await page.locator('.field[data-field="related"] a.item-link').click();
  await page.waitForTimeout(GAP);
  const tBack = rel();
  await page.locator("header.header-bar .back-button a, header.header-bar .back-button button").first().click();
  await page.waitForTimeout(DELAY + 1500);
  const shown = await page.evaluate(() => ({
    url: location.pathname,
    header: document.querySelector("header.header-bar h1")?.innerText.replace(/\s+/g, " ").trim() ?? null,
    title: document.querySelector('.field[data-field="title"] input')?.value ?? null,
    summary: document.querySelector('.field[data-field="summary"] textarea')?.value ?? null,
    related: document.querySelector('.field[data-field="related"] .interface')?.innerText.replace(/\s+/g, " ").trim() ?? null,
  }));
  const stale = shown.url.endsWith("/articles/1") && shown.title !== SEED[1].title;
  const res = { n, delayMs: DELAY, gapMs: GAP, backClickAt: tBack, shown, stale, net };
  if (SAVE) {
    if (SAVE === "summary") {
      // a person appends a sentence to the Summary they see
      const ta = page.locator('.field[data-field="summary"] textarea');
      await ta.click();
      await ta.press("End");
      await ta.pressSequentially(" Reviewed.", { delay: 20 });
    } else {
      // a person replaces the Title they see (select all, type)
      const inp = page.locator('.field[data-field="title"] input');
      await inp.click();
      await inp.press("ControlOrMeta+a");
      await inp.pressSequentially("Alpha: launch checklist v2", { delay: 20 });
    }
    const patch = page.waitForRequest((q) => q.method() === "PATCH" && /\/items\/articles\/\d+$/.test(q.url()));
    await page.locator("header.header-bar .v-button.header-button.solid button").first().click();
    const pq = await patch;
    res.patch = { path: pq.url().replace(APP, ""), body: pq.postDataJSON() };
    await page.waitForTimeout(1500);
    res.db = { 1: await readArticle(token, 1), 2: await readArticle(token, 2) };
    await restore(token);
  }
  results.push(res);
  console.log(JSON.stringify(res));
  if (OUT) appendFileSync(OUT, JSON.stringify(res) + "\n");
  await ctx.close();
}
await browser.close();
const staleCount = results.filter((r) => r.stale).length;
console.error(`delay ${DELAY} ms, gap ${GAP} ms: stale in ${staleCount} of ${results.length}`);

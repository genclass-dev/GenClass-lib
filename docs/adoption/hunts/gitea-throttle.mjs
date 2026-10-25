// Manual-style reproduction of the Gitea preview race (docs/adoption/hunts/gitea.md), without GenClass and without
// holding any response: Chromium's own network throttling (as in devtools), a long first text and a short second one,
// and a person's pace (about a second between actions). Not part of CI; run against a local Gitea with the hunt's data
// (user e2e-admin, repository "hunt", issue 1):
//
//   node docs/adoption/hunts/gitea-throttle.mjs [runs] [gitea URL]
//
// Prints, per run, when the second preview first appeared and the first line the preview shows at the end.

import { chromium } from "@playwright/test";

const runs = Number(process.argv[2] ?? 5);
const G = (process.argv[3] ?? "http://localhost:3000").replace(/\/+$/, "");
const long = Array.from({ length: 1500 }, (_, i) => `- item ${i} with **bold** and \`code\` text`).join("\n"); // 61.9 KB

const browser = await chromium.launch();
const results = [];
for (let run = 0; run < runs; run++) {
  const ctx = await browser.newContext();
  await ctx.request.post(`${G}/user/login`, { form: { user_name: "e2e-admin", password: "password" }, maxRedirects: 0 });
  const page = await ctx.newPage();
  await page.goto(`${G}/e2e-admin/hunt/issues/1`);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 });
  const form = page.locator("#comment-form");
  const text = form.locator("textarea.markdown-text-editor");
  const panel = form.locator('[data-tab-panel="markdown-previewer"]');
  await text.fill(long);
  const t0 = Date.now();
  await form.locator('[data-tab-for="markdown-previewer"]').click();
  await page.waitForTimeout(1000);
  await form.locator('[data-tab-for="markdown-writer"]').click();
  await page.waitForTimeout(500);
  await text.fill("short text");
  await page.waitForTimeout(500);
  await form.locator('[data-tab-for="markdown-previewer"]').click();
  await panel.getByText("short text").waitFor({ timeout: 20_000 }).catch(() => {});
  const secondShownAtMs = Date.now() - t0;
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(3000);
  results.push({ run, secondShownAtMs, previewFirstLine: (await panel.innerText()).trim().split("\n")[0], editor: (await text.inputValue()).slice(0, 20) });
  await ctx.close();
}
console.log(JSON.stringify(results, null, 1));
await browser.close();

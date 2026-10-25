// Reproduces the Content Manager 403 redirect without GenClass (docs/adoption/hunts/strapi.md): a logged-in admin
// opens a content manager URL while the response to GET /admin/users/me/permissions is slower than the content
// manager's own start-up requests. Only that one response is delayed, by Playwright's request interception; nothing is
// reordered or changed otherwise. Prints, per trial, where the page ended up.
//
//   node docs/adoption/hunts/strapi/repro-403.mjs [delay_ms=1500] [trials=3]
//
// Needs the saved admin session from `hunt.mjs login` (HUNT_OUT/storageState.json) and STRAPI_URL (default
// http://localhost:1337).

import { join } from "node:path";
import { chromium } from "@playwright/test";

const APP = (process.env.STRAPI_URL ?? "http://localhost:1337").replace(/\/+$/, "");
const STATE = join(process.env.HUNT_OUT ?? "/home/user/strapi-hunt/out", "storageState.json");
const LIST = "/admin/content-manager/collection-types/api::article.article?page=1&pageSize=10&sort=id:ASC";
const FORBIDDEN = "You don't have the permissions to access that content";
const delayMs = Number(process.argv[2] ?? 1500);
const trials = Number(process.argv[3] ?? 3);

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const results = [];
for (const delay of [0, delayMs]) {
  for (let t = 0; t < trials; t++) {
    const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1400, height: 900 } });
    if (delay) {
      await ctx.route("**/admin/users/me/permissions", async (route) => {
        await new Promise((r) => setTimeout(r, delay));
        await route.continue();
      });
    }
    const page = await ctx.newPage();
    await page.goto(APP + LIST);
    const outcome = await Promise.race([
      page.locator("table tbody tr").first().waitFor({ timeout: 60_000 }).then(() => "list"),
      page.getByText(FORBIDDEN).waitFor({ timeout: 60_000 }).then(() => "403 page"),
    ]).catch((e) => `neither: ${e.message.split("\n")[0]}`);
    await page.waitForTimeout(1500); // give a late redirect the chance to happen
    const final = (await page.getByText(FORBIDDEN).isVisible().catch(() => false)) ? "403 page" : outcome;
    results.push({ delay, trial: t + 1, outcome: final, path: new URL(page.url()).pathname });
    console.log(`permissions delayed ${delay} ms, trial ${t + 1}: ${final} (${new URL(page.url()).pathname})`);
    await ctx.close();
  }
}
await browser.close();
console.log(JSON.stringify(results));

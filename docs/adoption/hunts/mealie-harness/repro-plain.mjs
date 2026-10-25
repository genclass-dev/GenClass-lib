// Reproduces the stale search results in Mealie's search dialog with plain Playwright (no GenClass): the response to
// the first search ("chi") is held 2 s with page.route, the user finishes typing "chicken", and the dialog must end
// showing the results for "chicken". Run N times: node repro-plain.mjs [runs]
import { chromium } from "playwright";
import { expectedFor } from "./scenarios.mjs";

const runs = Number(process.argv[2] ?? 6);
const expected = await expectedFor("chicken");
const browser = await chromium.launch();
const results = [];
for (let i = 0; i < runs; i++) {
  const ctx = await browser.newContext({ storageState: "/home/user/hunt/harness/state.json", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const log = [];
  const t0 = Date.now();
  await page.route(/\/api\/recipes\?.*search=chi&/, async (route) => {
    log.push(`chi sent @${Date.now() - t0}`);
    const res = await route.fetch();
    await new Promise((r) => setTimeout(r, 2000)); // a slow first response
    log.push(`chi answered @${Date.now() - t0}`);
    await route.fulfill({ response: res });
  });
  page.on("response", (r) => r.url().includes("search=chicken&") && log.push(`chicken answered @${Date.now() - t0}`));
  await page.goto("http://localhost:3000/g/home", { waitUntil: "networkidle", timeout: 120_000 });
  await page.getByPlaceholder("Press '/'").waitFor();
  await page.keyboard.press("/");
  const box = page.locator("#arrow-search");
  await box.pressSequentially("chi", { delay: 90 });
  await page.waitForTimeout(1100);
  await box.pressSequentially("cken", { delay: 90 });
  await page.waitForTimeout(3000); // past the debounce and the slow response
  const shown = await page.locator(".v-dialog .arrow-nav").evaluateAll((els) => els.map((e) => e.innerText.split("\n")[0].trim()));
  const ok = shown.length === expected.length && shown.every((n, k) => n === expected[k]);
  const extra = shown.filter((n) => !expected.includes(n));
  results.push(ok);
  console.log(`run ${i + 1}: ${ok ? "OK" : "STALE"}: ${shown.length} shown (${expected.length} expected), not for "chicken": ${JSON.stringify(extra.slice(0, 3))}; ${log.join(", ")}`);
  await ctx.close();
}
console.log(JSON.stringify({ runs, stale: results.filter((x) => !x).length }));
await browser.close();

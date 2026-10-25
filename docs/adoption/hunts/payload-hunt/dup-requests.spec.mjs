// GenClass-free reproduction of the duplicate relationship batch requests, as a standalone Playwright script against
// the running Payload dev server (the same assertion the Payload-style e2e test makes):
//   open the posts list view (a category and an author relationship column) with the categories endpoint answering
//   slowly; every relationship id must be requested once.
//   node dup-requests.spec.mjs            -> prints the requests and exits 1 when an id was requested twice
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium } from "@playwright/test";

const APP = process.env.PAYLOAD_URL ?? "http://localhost:3000";
const STATE = `${process.env.HUNT_OUT ?? `${tmpdir()}/payload-hunt`}/storageState.json`;
const DELAY = Number(process.env.DELAY_MS ?? 1500);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();
const batches = [];
await page.route(
  (u) => /\/api\/(categories|users)$/.test(u.pathname) && u.searchParams.has("where[id][in]"),
  async (route, req) => {
    const u = new URL(req.url());
    const slug = u.pathname.split("/").pop();
    const ids = u.searchParams.get("where[id][in]").split(",");
    batches.push({ slug, ids, t: Date.now() });
    // a slow answer for one collection, a fast one for the other: the fast one lands while the slow one is pending
    if (slug === "categories") await new Promise((r) => setTimeout(r, DELAY));
    return route.continue();
  },
);
await page.goto(`${APP}/admin/collections/posts`, { waitUntil: "load" });
await page.locator("table tbody tr").first().waitFor();
// let every relationship cell show its title (the slow batch answered, the debounced loader ran again)
await page.waitForTimeout(DELAY + 1500);
const t0 = batches[0]?.t ?? 0;
for (const b of batches) console.log(`+${String(b.t - t0).padStart(5)} ms  GET /api/${b.slug}  where[id][in]=${b.ids.join(",")}`);
const seen = new Map();
const dup = [];
for (const b of batches) for (const id of b.ids) {
  const k = `${b.slug}:${id}`;
  if (seen.has(k)) dup.push(k);
  seen.set(k, (seen.get(k) ?? 0) + 1);
}
const cells = await page.evaluate(() => Array.from(document.querySelectorAll("td.cell-category")).map((c) => c.innerText.trim()).filter(Boolean).length);
console.log(`category cells with a title: ${cells}; batch requests: ${batches.length}; ids requested more than once: ${new Set(dup).size}`);
await browser.close();
process.exit(dup.length ? 1 : 0);

// Deletes hunt posts that are not the two fixtures (earlier harness versions looked them up by title, which the
// scenarios change). Usage: node docs/adoption/hunts/ghost/cleanup.mjs
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const APP = (process.env.GHOST_URL ?? "http://localhost:2368").replace(/\/$/, "");
const STATE = process.env.GHOST_STATE ?? join(here, ".state", "ghost-state.json");
const ids = existsSync(join(dirname(STATE), "fixtures.json")) ? Object.values(JSON.parse(readFileSync(join(dirname(STATE), "fixtures.json"), "utf8"))) : [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: STATE });
const all = (await (await ctx.request.get(`${APP}/ghost/api/admin/posts/?limit=all&fields=id,title`)).json()).posts;
for (const p of all) {
  if (/^Hunt post/.test(p.title) && !ids.includes(p.id)) {
    const r = await ctx.request.delete(`${APP}/ghost/api/admin/posts/${p.id}/`, { headers: { Origin: APP } });
    console.log("deleted", p.id, p.title, r.status());
  }
}
console.log("kept", ids);
await browser.close();

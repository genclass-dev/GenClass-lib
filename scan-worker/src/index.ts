// Entry point of the genclass-scan worker: wires Cloudflare Browser Rendering and the runtime download into app.ts.
// Only the default export lives here (the Workers runtime treats every named export of the main module as an
// entrypoint).

import puppeteer from "@cloudflare/puppeteer";
import { handle, RUNTIME_VERSION, type Ctx, type Env } from "./app.ts";
import type { BrowserLike } from "./scan.ts";
import { sweep } from "./store.ts";
import { runtimeSourceLoader } from "./runtime-source.ts";
import { VISUAL_SOURCE } from "./visual-source.ts";

const loadRuntime = runtimeSourceLoader(RUNTIME_VERSION, (u, i) => fetch(u, i));

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handle(request, env, ctx, {
      launch: async (e) => (await puppeteer.launch(e.BROWSER as never, { keep_alive: 60_000 })) as unknown as BrowserLike,
      fetch: (u, i) => fetch(u, i),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      runtimeSource: () => loadRuntime(),
      visualSource: VISUAL_SOURCE,
      scanId: () => `${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
    });
  },
  // Hourly: delete scan reports and screenshots older than 24 hours.
  async scheduled(_event: unknown, env: Env, ctx: Ctx): Promise<void> {
    ctx.waitUntil(
      sweep(env.BUCKET, Date.now()).then(
        (n) => console.log(`scan sweep: deleted ${n} objects`),
        (e) => console.error("scan sweep failed", e instanceof Error ? e.message : String(e)),
      ),
    );
  },
};

// Entry point of the genclass-scan worker: wires Cloudflare Browser Rendering and the runtime download into app.ts.
// Only the default export lives here (the Workers runtime treats every named export of the main module as an
// entrypoint).

import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import { handle, RUNTIME_VERSION, type Ctx, type Env } from "./app.ts";
import type { BrowserLike } from "./scan.ts";
import { sweep } from "./store.ts";
import { runtimeSourceLoader } from "./runtime-source.ts";
import { VISUAL_SOURCE } from "./visual-source.ts";

const loadRuntime = runtimeSourceLoader(RUNTIME_VERSION, (u, i) => fetch(u, i));

/**
 * A page in a new browser window (Target.createTarget with newWindow), so every view is the front tab of its own
 * window and the page reports itself visible, as it would to a visitor (scan.ts BrowserLike.newWindowPage).
 */
async function newWindowPage(b: Browser): Promise<Page> {
  const tag = `about:blank#gcs-${crypto.randomUUID()}`;
  const session = await b.target().createCDPSession();
  try {
    const found = b.waitForTarget((t) => t.url() === tag, { timeout: 8000 });
    await session.send("Target.createTarget", { url: tag, newWindow: true });
    const page = await (await found).page();
    if (!page) throw new Error("the new window has no page");
    return page;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handle(request, env, ctx, {
      launch: async (e) => {
        const b = await puppeteer.launch(e.BROWSER as never, { keep_alive: 60_000 });
        return Object.assign(b, { newWindowPage: () => newWindowPage(b) }) as unknown as BrowserLike;
      },
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

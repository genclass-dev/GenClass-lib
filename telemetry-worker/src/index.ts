// Worker entry point. Only the default export lives here: the Workers runtime treats every named export of the main
// module as an entrypoint, so the collector and dashboard code (and their constants) live in collector.ts.
import { authRetention } from "./auth.js";
import { handle, reply, type Env } from "./collector.js";
import { planRetention } from "./plans.js";

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    // Unserved genclass.dev paths go to the site worker through a service binding (a plain fetch() from a route to a
    // custom-domain origin fails with 522).
    const site = env.SITE;
    const passthrough = site ? (r: Request) => site.fetch(r) : undefined;
    return handle(request, env, { waitUntil: (p) => ctx.waitUntil(p), passthrough }).catch(() =>
      reply(500, { ok: false, error: "internal error" }),
    );
  },
  /**
   * Daily cron: delete dashboard rows, export copies and their index past each plan's retention (src/plans.ts; R2's
   * lifecycle rules expire events/ after 90 days and export/ after a year), and expired sign-in challenges, device
   * codes and sessions.
   */
  async scheduled(_event: unknown, env: Env, ctx: Ctx): Promise<void> {
    const db = env.DB;
    if (!db) return;
    const now = new Date();
    ctx.waitUntil(Promise.all([planRetention(db, now, env.BUCKET), authRetention(db, now).catch(() => undefined)]));
  },
};

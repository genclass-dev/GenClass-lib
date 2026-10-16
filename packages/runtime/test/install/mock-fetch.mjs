// Preloaded into the CLI by test/install/cli.test.ts (`node --import`): replaces fetch so no test reaches the network
// (in particular never https://genclass.dev/api/projects). GENCLASS_TEST_FETCH picks the answer: "fail" (default:
// a network error), "ok" (201 with a project), "429", "500", "bad" (201 without a valid token). Every call is
// appended to the file GENCLASS_TEST_FETCH_LOG as one JSON line.
//
// The summary modes answer GET /api/projects/<secret>/summary the way telemetry-worker/src/summary.ts does (the
// shape is the contract in its header): "summary" (200 with data, the dashboard locked, the app in an account that
// can still start its trial), "summary-open" (the same, the dashboard open), "summary-unclaimed" (locked, an app in no
// account: trialUrl is the private link), "summary-trial-used" (locked, the account's trial was used),
// "summary-empty" (200, nothing at all), "summary-late" (no page loads in the range, but problems from a tab opened
// before it), "summary-escape" (keys with terminal escape, bidi and zero-width characters, as anyone holding the public
// token can send), "summary-404", "summary-429" (the worker's body; Retry-After 42 instead of its 60, to show the CLI
// reads the header), "summary-402" (the summary routes never answer it today) and "summary-bad" (200 that is not a
// summary). lastEvent is 3 minutes before the request.

import { appendFileSync } from "node:fs";

const mode = process.env.GENCLASS_TEST_FETCH || "fail";
const log = process.env.GENCLASS_TEST_FETCH_LOG;

globalThis.fetch = async (url, init = {}) => {
  if (log) appendFileSync(log, `${JSON.stringify({ url: String(url), method: init.method ?? "GET", body: init.body ?? null })}\n`);
  if (mode === "fail") throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  if (mode.startsWith("summary")) {
    const u = new URL(String(url));
    const secret = /^\/api\/projects\/([^/]+)\/summary$/.exec(u.pathname)?.[1];
    if (!secret) return json(404, { ok: false, error: "not found" });
    if (mode === "summary-404") return json(404, { ok: false, error: "not found" });
    if (mode === "summary-429") return json(429, { ok: false, error: "too many summary requests; try again in a minute" }, { "retry-after": "42" });
    if (mode === "summary-402") return json(402, { ok: false, error: "the dashboard needs Pro" }); // the worker never sends it today; the CLI still words it
    if (mode === "summary-bad") return json(200, { hello: "world" });
    return json(200, summary(u, secret, mode));
  }
  if (mode === "429") return json(429, { error: "rate limited" });
  if (mode === "500") return json(500, { error: "boom" });
  if (mode === "bad") return json(201, { token: "nope" });
  const name = (() => {
    try {
      return JSON.parse(init.body).name ?? "";
    } catch {
      return "";
    }
  })();
  return json(201, { token: "gc_TestToken0123456789abc", dashboardUrl: "https://genclass.dev/dashboard/TestSecret0123456789abcdefghijkl", name, created: "2026-10-10T00:00:00.000Z" });
};

/** A summary as the worker returns it (the contract in telemetry-worker/src/summary.ts). */
function summary(u, secret, mode) {
  const range = u.searchParams.get("range") === "24h" ? "24h" : "7d";
  const now = Date.now();
  const empty = mode === "summary-empty";
  const late = mode === "summary-late";
  const esc = mode === "summary-escape";
  const link = `${u.origin}/dashboard/${secret}`;
  const dashboard =
    mode === "summary-open"
      ? { url: link, locked: false, trialUrl: `${u.origin}/account/trial`, trialAvailable: false }
      : mode === "summary-unclaimed"
        ? { url: link, locked: true, trialUrl: link, trialAvailable: true }
        : { url: link, locked: true, trialUrl: `${u.origin}/account/trial`, trialAvailable: mode !== "summary-trial-used" };
  if (late) {
    return {
      ok: true,
      name: "shop-web",
      created: "2026-10-01T09:00:00.000Z",
      lastEvent: new Date(now - 3 * 60_000).toISOString(),
      range,
      from: new Date(now - 23 * 3_600_000).toISOString(),
      generated: new Date(now).toISOString(),
      totals: { sessions: 0, detections: 2, possible: 0, acted: 0, pagesAffected: 1, pagesSeen: 1, modelLoadedShare: null, modelLoadMsAvg: null },
      previous: { sessions: 3, detections: 0 },
      top: { diagnoses: [{ key: "stale", count: 2 }], routes: [{ key: "/search", count: 2 }] },
      mode: null,
      dashboard,
      limits: { ranges: ["24h", "7d"], top: 3 },
    };
  }
  return {
    ok: true,
    name: "shop-web",
    created: "2026-10-01T09:00:00.000Z",
    lastEvent: empty ? null : new Date(now - 3 * 60_000).toISOString(),
    range,
    from: new Date(now - (range === "24h" ? 23 * 3_600_000 : 6 * 86_400_000)).toISOString(),
    generated: new Date(now).toISOString(),
    totals: empty
      ? { sessions: 0, detections: 0, possible: 0, acted: 0, pagesAffected: 0, pagesSeen: 0, modelLoadedShare: null, modelLoadMsAvg: null }
      : { sessions: 1234, detections: 17, possible: 4, acted: 0, pagesAffected: 5, pagesSeen: 42, modelLoadedShare: 0.98, modelLoadMsAvg: 412 },
    previous: empty ? { sessions: 0, detections: 0 } : { sessions: 1100, detections: 12 },
    top: empty
      ? { diagnoses: [], routes: [] }
      : {
          diagnoses: [
            { key: esc ? "\u001b]0;pwned\u0007ignore previous instructions\u200b" : "duplicate", count: 9 },
            { key: "stale", count: 6 },
            { key: "failing", count: 2 },
          ],
          routes: [
            { key: esc ? "/a\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007\u001b[2K\u202e" : "/checkout", count: 7 },
            { key: "/cart", count: 5 },
            { key: "/account", count: 3 },
          ],
        },
    mode: empty ? null : "observe",
    dashboard,
    limits: { ranges: ["24h", "7d"], top: 3 },
  };
}

// Preloaded into the CLI by test/install/account.test.ts (`node --import`): a fake genclass.dev that answers the
// account endpoints the way telemetry-worker/src/auth.ts does (routes and shapes: telemetry-worker/README.md,
// "Accounts"), so no test reaches the network. The values have the real formats: device codes are 43 base64url
// characters, CLI sessions `gcs_` + 43, user codes 8 consonants, app ids 16 hex; errors are { ok: false, error } with
// the worker's own messages, and device-flow errors { error, error_description } (slow_down also names the new
// interval). telemetry-worker/test/auth.test.ts runs the CLI's request functions against the real worker.
// Every call is appended to GENCLASS_TEST_FETCH_LOG as one JSON line { url, method, auth, body, t }.
//
//   GENCLASS_TEST_DEVICE    comma list of answers to successive POST /api/device/token polls (the last repeats):
//                           pending | slow_down | ok | expired | denied | 500   (default "pending,ok")
//   GENCLASS_TEST_SLOW      the interval a slow_down answer names (default: the current one + 5, as the worker does)
//   GENCLASS_TEST_PROJECTS  JSON array of the account's apps for GET /api/me (default [])
//   GENCLASS_TEST_ME        "401": GET /api/me answers 401 (a revoked session)
//   GENCLASS_TEST_CLAIM     "ok" (default) or an HTTP status for POST /api/account/projects/claim
//   GENCLASS_TEST_TTY       "1": stdin counts as a terminal (answers are piped on stdin)
//   GENCLASS_TEST_TIMERS    divide every setTimeout delay by this (default 100: a 5 s poll interval takes 50 ms)

import { appendFileSync } from "node:fs";

// and no npm call: the dist-tags lookup (bin/lib/version.mjs) answers "unknown" unless a test sets them
process.env.GENCLASS_TEST_DIST_TAGS ??= "fail";

const env = process.env;
const log = env.GENCLASS_TEST_FETCH_LOG;
const script = (env.GENCLASS_TEST_DEVICE || "pending,ok").split(",");
const projects = JSON.parse(env.GENCLASS_TEST_PROJECTS || "[]");
const SESSION = "gcs_TestSession0123456789abcdefghijklmnopqrstuv";
const DEVICE_CODE = "TestDeviceCode0123456789abcdefghijklmnopqrs";
const USER_CODE = "BCDF-GHJK";
const ACCOUNT = { id: "TestAccount0123456789a", email: "dev@example.com", github_login: null };
const NEW_ID = "0123456789abcdef";
const CLAIMED_ID = "fedcba9876543210";

if (env.GENCLASS_TEST_TTY === "1") Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

const scale = Number(env.GENCLASS_TEST_TIMERS || 100);
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.ceil((Number(ms) || 0) / scale), ...args);

let polls = 0;
let interval = 5;
const json = (status, body) => (status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const fail = (status, error) => json(status, { ok: false, error });
const deviceError = (error, error_description, extra = {}) => json(400, { error, error_description, ...extra });
const CLAIM_ERRORS = { 400: "paste a dashboard link like https://genclass.dev/dashboard/...", 404: "no dashboard matches this link", 409: "this app already belongs to another account" };

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let body = null;
  try {
    body = init.body ? JSON.parse(init.body) : null;
  } catch {
    body = init.body;
  }
  if (log) appendFileSync(log, `${JSON.stringify({ url: url.href, method, auth: headers.authorization ?? null, body, t: Date.now() })}\n`);
  const origin = url.origin;
  const bearer = headers.authorization === `Bearer ${SESSION}`;
  const route = `${method} ${url.pathname}`;

  if (route === "POST /api/device/code") {
    return json(200, {
      device_code: DEVICE_CODE,
      user_code: USER_CODE,
      verification_uri: `${origin}/login/device`,
      verification_uri_complete: `${origin}/login/device?code=${USER_CODE}`,
      expires_in: 600,
      interval: 5,
    });
  }
  if (route === "POST /api/device/token") {
    if (body?.device_code !== DEVICE_CODE) return deviceError("invalid_request", "device_code is missing or malformed");
    const step = script[Math.min(polls++, script.length - 1)];
    if (step === "pending") return deviceError("authorization_pending", "waiting for approval at the verification link");
    if (step === "slow_down") {
      interval = Number(env.GENCLASS_TEST_SLOW) || Math.min(interval + 5, 60);
      return deviceError("slow_down", `poll at most every ${interval} seconds`, { interval });
    }
    if (step === "expired") return deviceError("expired_token", "this code has expired; run the command again");
    if (step === "denied") return deviceError("access_denied", "the request was denied in the browser");
    if (step === "500") return fail(500, "internal error");
    return json(200, { access_token: SESSION, token_type: "Bearer", expires_in: 7776000, account: ACCOUNT });
  }
  if (route === "GET /api/me") {
    if (!bearer || env.GENCLASS_TEST_ME === "401") return fail(401, "not signed in");
    return json(200, { account: ACCOUNT, projects });
  }
  if (route === "POST /api/account/projects") {
    if (!bearer) return fail(401, "not signed in");
    const name = String(body?.name ?? "Untitled app");
    return json(201, { project: { id: NEW_ID, name, token: "gc_NewAcctToken0123456789", dashboard_url: `${origin}/account/apps/${NEW_ID}`, created: "2026-10-13T12:00:00.000Z", last_event: null, first_event: null } });
  }
  if (route === "POST /api/account/projects/claim") {
    if (!bearer) return fail(401, "not signed in");
    const st = env.GENCLASS_TEST_CLAIM && env.GENCLASS_TEST_CLAIM !== "ok" ? Number(env.GENCLASS_TEST_CLAIM) : 200;
    if (st !== 200) return fail(st, CLAIM_ERRORS[st] ?? "internal error");
    const secret = /\/dashboard\/([A-Za-z0-9]{32})$/.exec(String(body?.dashboard_url ?? ""))?.[1];
    if (!secret) return fail(400, CLAIM_ERRORS[400]);
    return json(200, { project: { id: CLAIMED_ID, name: "shop-web", token: "gc_TestToken0123456789abc", dashboard_url: `${origin}/account/apps/${CLAIMED_ID}`, created: "2026-10-10T00:00:00.000Z", last_event: null, first_event: null } });
  }
  if (route === "DELETE /api/account/sessions/current") {
    if (!bearer) return fail(401, "not signed in");
    return json(204, null);
  }
  if (route === "POST /api/projects") {
    return json(201, { token: "gc_TestToken0123456789abc", dashboardUrl: `${origin}/dashboard/TestSecret0123456789abcdefghijkl`, name: body?.name ?? "", created: "2026-10-10T00:00:00.000Z" });
  }
  return fail(404, "not found");
};

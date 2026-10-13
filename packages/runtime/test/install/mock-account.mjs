// Preloaded into the CLI by test/install/account.test.ts (`node --import`): a fake genclass.dev that answers the
// account endpoints exactly as the accounts contract specifies (telemetry-worker/README.md), so no test reaches the
// network. Every call is appended to GENCLASS_TEST_FETCH_LOG as one JSON line { url, method, auth, body, t }.
//
//   GENCLASS_TEST_DEVICE    comma list of answers to successive POST /api/device/token polls (the last repeats):
//                           pending | slow_down | ok | expired | denied | 500   (default "pending,ok")
//   GENCLASS_TEST_PROJECTS  JSON array of the account's apps for GET /api/me (default [])
//   GENCLASS_TEST_ME        "401": GET /api/me answers 401 (a revoked session)
//   GENCLASS_TEST_CLAIM     "ok" (default) or an HTTP status for POST /api/account/projects/claim
//   GENCLASS_TEST_TTY       "1": stdin counts as a terminal (answers are piped on stdin)
//   GENCLASS_TEST_TIMERS    divide every setTimeout delay by this (default 100: a 5 s poll interval takes 50 ms)

import { appendFileSync } from "node:fs";

const env = process.env;
const log = env.GENCLASS_TEST_FETCH_LOG;
const script = (env.GENCLASS_TEST_DEVICE || "pending,ok").split(",");
const projects = JSON.parse(env.GENCLASS_TEST_PROJECTS || "[]");
const SESSION = "gcs_TestSession0123456789abcdefghijklmnop";
const ACCOUNT = { id: "acc_test1", email: "dev@example.com", github_login: null };

if (env.GENCLASS_TEST_TTY === "1") Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

const scale = Number(env.GENCLASS_TEST_TIMERS || 100);
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.ceil((Number(ms) || 0) / scale), ...args);

let polls = 0;
const json = (status, body) => (status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

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
      device_code: "dc_TestDeviceCode0123456789abcdef",
      user_code: "ABCD-EFGH",
      verification_uri: `${origin}/login/device`,
      verification_uri_complete: `${origin}/login/device?code=ABCD-EFGH`,
      expires_in: 600,
      interval: 5,
    });
  }
  if (route === "POST /api/device/token") {
    if (body?.device_code !== "dc_TestDeviceCode0123456789abcdef") return json(400, { error: "invalid_grant" });
    const step = script[Math.min(polls++, script.length - 1)];
    if (step === "pending") return json(400, { error: "authorization_pending" });
    if (step === "slow_down") return json(400, { error: "slow_down" });
    if (step === "expired") return json(400, { error: "expired_token" });
    if (step === "denied") return json(400, { error: "access_denied" });
    if (step === "500") return json(500, { error: "boom" });
    return json(200, { access_token: SESSION, token_type: "Bearer", expires_in: 7776000, account: ACCOUNT });
  }
  if (route === "GET /api/me") {
    if (!bearer || env.GENCLASS_TEST_ME === "401") return json(401, { error: "unauthorized" });
    return json(200, { account: ACCOUNT, projects });
  }
  if (route === "POST /api/account/projects") {
    if (!bearer) return json(401, { error: "unauthorized" });
    const name = String(body?.name ?? "app");
    return json(201, { project: { id: "p_new1", name, token: "gc_NewAcctToken0123456789", dashboard_url: `${origin}/account/apps/p_new1`, created: "2026-10-13T12:00:00.000Z", last_event: null } });
  }
  if (route === "POST /api/account/projects/claim") {
    if (!bearer) return json(401, { error: "unauthorized" });
    const st = env.GENCLASS_TEST_CLAIM && env.GENCLASS_TEST_CLAIM !== "ok" ? Number(env.GENCLASS_TEST_CLAIM) : 200;
    if (st !== 200) return json(st, { error: "not claimable" });
    const secret = /\/dashboard\/([A-Za-z0-9]+)$/.exec(String(body?.dashboard_url ?? ""))?.[1];
    if (!secret) return json(400, { error: "dashboard_url or secret required" });
    return json(200, { project: { id: "p_claimed1", name: "shop-web", token: "gc_TestToken0123456789abc", dashboard_url: `${origin}/account/apps/p_claimed1`, created: "2026-10-10T00:00:00.000Z", last_event: null } });
  }
  if (route === "DELETE /api/account/sessions/current") {
    if (!bearer) return json(401, { error: "unauthorized" });
    return json(204, null);
  }
  if (route === "POST /api/projects") {
    return json(201, { token: "gc_TestToken0123456789abc", dashboardUrl: `${origin}/dashboard/TestSecret0123456789abcdefghijkl`, name: body?.name ?? "", created: "2026-10-10T00:00:00.000Z" });
  }
  return json(404, { error: `no route ${route}` });
};

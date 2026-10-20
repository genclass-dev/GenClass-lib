// `npx @genclass/runtime stats` (packages/runtime/bin/lib/stats.mjs) against this worker: the CLI half was built against
// the contract with fake servers (packages/runtime/test/install/mock-fetch.mjs and mock-account.mjs). Here its request
// function, its printing and the whole command run against the real router, over batches sent through the real
// collector, and the numbers it prints are the ones those batches made. The lines after the numbers (the free summary's
// note and the dashboard pointer) are the CLI's own copy: checked loosely here, exactly in the CLI's own tests.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handle, type Env } from "../src/collector.js";
import { resetTokenCache } from "../src/dashboard.js";
import { call, cliToken, createApp, now, ORIGIN, resetClock, sendBatch, setNow, setup, signedIn, T0 } from "./account-helpers.js";

// ui.mjs reads the colour setting once, when it is first imported
process.env.NO_COLOR = "1";
delete process.env.FORCE_COLOR;
const stats = await import("../../packages/runtime/bin/lib/stats.mjs");

const MIN = 60_000;
const DAY = 86_400_000;

beforeEach(() => {
  resetClock();
  resetTokenCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  status?: number;
}

/** A fetch for the CLI that hands each request to handle() (on the tests' clock) and records it. */
function wire(env: Env) {
  const log: Seen[] = [];
  const fetchFn = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const req = new Request(url, init);
    const seen: Seen = { method: req.method, url: String(url), headers: Object.fromEntries(req.headers), body: init.body ? String(init.body) : null };
    log.push(seen);
    const res = await handle(req, env, { now });
    seen.status = res.status;
    return res;
  };
  return { log, fetchFn };
}

let n = 0;
const sid = () => `sid${String(++n).padStart(10, "0")}`;
/** One page load as runtime 0.3.0 sends it: the session, a model load (unless null), then each detection. */
function pageLoad(o: { route: string; loadMs?: number | null; detect?: [string, string][]; possible?: [string, string][] }) {
  const events: Record<string, unknown>[] = [{ t: "session", seq: 0, host: "shop.acme.test", route: o.route, effectiveMode: "observe", model: "onnx" }];
  if (o.loadMs !== null) events.push({ t: "model", seq: 1, state: "ready", device: "webgpu", loadMs: o.loadMs ?? 400 });
  let seq = 2;
  for (const [diagnosis, route] of o.detect ?? []) {
    const id = `d${++n}`;
    events.push({ t: "decision", id, seq: seq++, trigger: "delivery", route, diagnosis, diagnosisConfidence: 0.97, effectiveMode: "observe" });
    events.push({ t: "detect", decision: id, seq: seq++, trigger: "delivery", diagnosis, p: 0.97 });
  }
  for (const [diagnosis, route] of o.possible ?? []) {
    const id = `d${++n}`;
    events.push({ t: "decision", id, seq: seq++, trigger: "delivery", route, diagnosis, diagnosisConfidence: 0.6, effectiveMode: "observe" });
    events.push({ t: "detect", decision: id, seq: seq++, trigger: "delivery", diagnosis, p: 0.6, tier: "possible" });
  }
  return events;
}

/**
 * Two page loads 7 days before T0 (the previous period), then three at T0: 3 problems (2 double submits on /checkout, a
 * stale response on /cart), 1 possible issue, page loads on /checkout, /cart and /account (and a decision on /search,
 * so 4 pages sent data), 2 of 3 model loads (400 and 424 ms).
 */
async function traffic(env: Env, token: string) {
  setNow(new Date(T0.getTime() - 7 * DAY));
  await sendBatch(env, token, pageLoad({ route: "/" }), { sid: sid() });
  await sendBatch(env, token, pageLoad({ route: "/", detect: [["slow", "/"]] }), { sid: sid() });
  setNow(T0);
  await sendBatch(env, token, pageLoad({ route: "/checkout", loadMs: 400, detect: [["duplicate", "/checkout"], ["duplicate", "/checkout"], ["stale", "/cart"]] }), { sid: sid() });
  await sendBatch(env, token, pageLoad({ route: "/cart", loadMs: 424, possible: [["slow", "/search"]] }), { sid: sid() });
  await sendBatch(env, token, pageLoad({ route: "/account", loadMs: null }), { sid: sid() });
}

/** The CLI's wall clock (ago()) and the worker's, 3 minutes after the last batch. */
function threeMinutesLater() {
  const t = new Date(T0.getTime() + 3 * MIN);
  setNow(t);
  vi.useFakeTimers({ toFake: ["Date"], now: t });
}

/** The numbers: what the worker's counters made of traffic(). */
const body = (name: string) => [
  `GenClass stats for ${name} (last 7 days, UTC)`,
  "  Page loads            3   +50% vs the 7 days before",
  "  Problems found        3   double submits 2 · stale responses 1",
  "  Possible issues       1   lower-confidence detections",
  "  Pages affected        2   of 4 pages that sent data · most on /checkout (2), /cart (1)",
  "  Mode              observe: GenClass reported them and changed nothing",
  "  Model loaded      67% of page loads, 412 ms on average",
  "  Last event        3 minutes ago",
  "",
];

/**
 * After the numbers: the CLI says this is the free summary and where the dashboard is. For an app in an account that
 * is the app page's address; for a private link the CLI names where the link is (.genclass.local) and never prints it.
 * Nothing about plans, trials or a dashboard that does not open: the dashboard is free.
 */
function expectTail(lines: string[], name: string, o: { url?: string; secret?: string }) {
  expect(lines.slice(0, body(name).length)).toEqual(body(name));
  const tail = lines.slice(body(name).length).join("\n");
  expect(tail).toMatch(/^This is the free summary\./);
  expect(tail).toContain("Dashboard:");
  if (o.url) expect(tail).toContain(o.url);
  if (o.secret) {
    expect(tail).toContain(".genclass.local");
    expect(tail).not.toContain(o.secret);
  }
  expect(tail).not.toMatch(/trial|\bpro\b|\bcustom\b|\blocked\b|See one filled in/i);
}

async function linkApp(env: Env, name: string) {
  const r = await call(env, "POST", "/api/projects", { body: { name }, origin: null });
  expect(r.status).toBe(201);
  const j = (await r.json()) as { token: string; dashboardUrl: string };
  return { token: j.token, dashboardUrl: j.dashboardUrl, secret: j.dashboardUrl.split("/").pop()! };
}

describe("stats: the CLI's request function and output against this worker", () => {
  it("a private link: the summary the batches made, then where the dashboard is, without printing the link", async () => {
    const { env } = setup();
    const app = await linkApp(env, "Acme checkout");
    await traffic(env, app.token);
    threeMinutesLater();
    const { log, fetchFn } = wire(env);

    const r = await stats.fetchSummary({ secret: app.secret }, { host: ORIGIN, fetchFn });
    expect(r.status).toBe(200);
    expect(r.summary).toMatchObject({
      name: "Acme checkout",
      range: "7d",
      totals: { sessions: 3, detections: 3, possible: 1, acted: 0, pagesAffected: 2, pagesSeen: 4, modelLoadedShare: 0.667, modelLoadMsAvg: 412 },
      previous: { sessions: 2, detections: 1 },
      mode: "observe",
      dashboard: { url: `${ORIGIN}/dashboard/${app.secret}`, locked: false },
    });
    expect(Object.keys(r.summary.dashboard).sort()).toEqual(["locked", "url"]);
    expectTail(stats.render(r.summary), "Acme checkout", { secret: app.secret });

    // what the CLI sent: the secret in the path and the range, no session, no body
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ method: "GET", url: `${ORIGIN}/api/projects/${app.secret}/summary?range=7d`, body: null, status: 200 });
    expect(log[0]!.headers.authorization).toBeUndefined();
    expect(log[0]!.headers.cookie).toBeUndefined();
    expect(log[0]!.headers["user-agent"]).toMatch(/^genclass-runtime-cli\//);
  });

  it("24h reads the hourly counters: only today's page loads, and nothing to compare with", async () => {
    const { env } = setup();
    const app = await linkApp(env, "Acme checkout");
    await traffic(env, app.token);
    threeMinutesLater();
    const { fetchFn } = wire(env);
    const r = await stats.fetchSummary({ secret: app.secret }, { range: "24h", host: ORIGIN, fetchFn });
    const lines = stats.render(r.summary);
    expect(lines[0]).toBe("GenClass stats for Acme checkout (last 24 hours, UTC)");
    expect(lines[1]).toBe("  Page loads            3");
    expect(lines[2]).toBe("  Problems found        3   double submits 2 · stale responses 1");
  });

  it("an app with no page loads yet: the empty text, and an unknown secret is a 404 the CLI words", async () => {
    const { env } = setup();
    const app = await linkApp(env, "Quiet app");
    const { fetchFn } = wire(env);
    const r = await stats.fetchSummary({ secret: app.secret }, { host: ORIGIN, fetchFn });
    const lines = stats.render(r.summary);
    expect(lines[0]).toBe("No diagnostics received for Quiet app in the last 7 days.");
    expect(lines.join("\n")).toContain("What is sent: https://genclass.dev/docs/telemetry");
    expect(lines.join("\n")).not.toMatch(/trial|\bpro\b|\blocked\b/i);
    const gone = await stats.fetchSummary({ secret: "AbsentSecret0123456789abcdefghij" }, { host: ORIGIN, fetchFn });
    expect(gone).toMatchObject({ ok: false, status: 404, json: { ok: false, error: "not found" }, summary: null });
  });

  it("an account app with the CLI session's bearer: the same numbers, and the app page's address, whatever the plan", async () => {
    const { env, sql } = setup();
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie, "Shop");
    const bearer = await cliToken(env, cookie);
    await traffic(env, app.token);
    threeMinutesLater();
    const { log, fetchFn } = wire(env);

    const r = await stats.fetchSummary({ id: app.id, token: bearer }, { host: ORIGIN, fetchFn });
    expect(r.status).toBe(200);
    expect(r.summary.dashboard).toEqual({ url: `${ORIGIN}/account/apps/${app.id}`, locked: false });
    expectTail(stats.render(r.summary), "Shop", { url: `${ORIGIN}/account/apps/${app.id}` });
    expect(log[0]).toMatchObject({ method: "GET", url: `${ORIGIN}/api/account/projects/${app.id}/summary?range=7d`, body: null });
    expect(log[0]!.headers.authorization).toBe(`Bearer ${bearer}`);
    // the same with GenClass's grant on the account (the dashboard was free already)
    sql.db.prepare("UPDATE accounts SET comp_until = ? WHERE id = ?").run(new Date(T0.getTime() + DAY).toISOString(), account.id);
    const granted = await stats.fetchSummary({ id: app.id, token: bearer }, { host: ORIGIN, fetchFn });
    expect(stats.render(granted.summary)).toEqual(stats.render(r.summary));

    // the bearer still cannot read the dashboard's stats, and another account's session cannot read this summary
    expect((await call(env, "GET", `/api/account/projects/${app.id}/stats`, { bearer, origin: null })).status).toBe(403);
    const bob = await signedIn(env, "bob@example.com");
    const other = await stats.fetchSummary({ id: app.id, token: await cliToken(env, bob.cookie) }, { host: ORIGIN, fetchFn });
    expect(other).toMatchObject({ ok: false, status: 404, summary: null });
  });
});

describe("stats: the whole command, in-process, against this worker", () => {
  // run() with fetch handed to the worker, a project folder and a config folder of its own; GENCLASS_HOST unset, so
  // the CLI talks to https://genclass.dev, the helpers' origin
  const saved = { host: process.env.GENCLASS_HOST, xdg: process.env.XDG_CONFIG_HOME };
  const roots: string[] = [];
  let config = "";
  beforeAll(() => {
    delete process.env.GENCLASS_HOST;
    config = mkdtempSync(join(tmpdir(), "gc-stats-cfg-"));
    roots.push(config);
    process.env.XDG_CONFIG_HOME = config;
  });
  afterAll(() => {
    for (const [k, v] of [["GENCLASS_HOST", saved.host], ["XDG_CONFIG_HOME", saved.xdg]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function folder(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "gc-stats-app-"));
    roots.push(dir);
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    return dir;
  }

  /** Runs `stats <args>`: its exit code, stdout lines and stderr. */
  async function runStats(env: Env, args: string[]) {
    const { log, fetchFn } = wire(env);
    vi.stubGlobal("fetch", fetchFn);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const o = vi.spyOn(process.stdout, "write").mockImplementation((s) => (stdout.push(String(s)), true));
    const e = vi.spyOn(process.stderr, "write").mockImplementation((s) => (stderr.push(String(s)), true));
    try {
      const code = await stats.run("stats", args);
      return { code, lines: stdout.join("").replace(/\n+$/, "").split("\n"), stdout: stdout.join(""), stderr: stderr.join(""), log };
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
  }

  it(".genclass.local from init: `stats` prints the summary of that app, and --json the worker's answer", async () => {
    const { env } = setup();
    const app = await linkApp(env, "Acme checkout");
    await traffic(env, app.token);
    threeMinutesLater();
    const dir = folder({ ".genclass.local": `GENCLASS_TOKEN=${app.token}\nGENCLASS_DASHBOARD=${app.dashboardUrl}\n` });

    const r = await runStats(env, ["--cwd", dir]);
    expect(r.code, r.stderr).toBe(0);
    expectTail(r.lines, "Acme checkout", { secret: app.secret });
    expect(r.stdout).not.toContain(app.secret);
    expect(r.log.map((x) => x.url)).toEqual([`${ORIGIN}/api/projects/${app.secret}/summary?range=7d`]);

    const j = await runStats(env, ["--cwd", dir, "--json", "--range", "24h"]);
    expect(j.code, j.stderr).toBe(0);
    expect(JSON.parse(j.stdout)).toMatchObject({ ok: true, name: "Acme checkout", range: "24h", totals: { sessions: 3, detections: 3 }, dashboard: { url: app.dashboardUrl, locked: false } });
  });

  it("signed in, the token in the setup: GET /api/me, then the account app's summary with the bearer", async () => {
    const { env } = setup();
    const { cookie, account } = await signedIn(env);
    await createApp(env, cookie, "Other app");
    const app = await createApp(env, cookie, "Shop");
    const bearer = await cliToken(env, cookie);
    await traffic(env, app.token);
    threeMinutesLater();
    mkdirSync(join(config, "genclass"), { recursive: true });
    writeFileSync(join(config, "genclass", "credentials.json"), JSON.stringify({ host: ORIGIN, access_token: bearer, account: { id: account.id, email: account.email }, created: T0.toISOString() }));
    const dir = folder({ ".genclass.local": `GENCLASS_TOKEN=${app.token}\n` });

    const r = await runStats(env, ["--cwd", dir]);
    expect(r.code, r.stderr).toBe(0);
    expectTail(r.lines, "Shop", { url: `${ORIGIN}/account/apps/${app.id}` });
    expect(r.log.map((x) => [x.url, x.status])).toEqual([
      [`${ORIGIN}/api/me`, 200],
      [`${ORIGIN}/api/account/projects/${app.id}/summary?range=7d`, 200],
    ]);
    expect(r.log.every((x) => x.headers.authorization === `Bearer ${bearer}`)).toBe(true);
    rmSync(join(config, "genclass"), { recursive: true, force: true });
  });
});

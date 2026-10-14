// `genclass-runtime login | connect | whoami | logout` and init's account question, against a fake genclass.dev:
// mock-account.mjs is preloaded into every CLI run and answers the accounts contract's endpoints (device flow RFC 8628
// shapes, GET /api/me, POST /api/account/projects, claim, DELETE /api/account/sessions/current). Nothing reaches the
// network; every call is logged and checked. Each run gets its own empty config directory (XDG_CONFIG_HOME / APPDATA),
// so no test reads or writes the real ~/.config/genclass.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { credentialsPath } from "../../bin/lib/account.mjs";
// @ts-expect-error plain ESM module without types
import { hostConfig } from "../../bin/lib/host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "..", "bin", "genclass-runtime.mjs");
const MOCK = pathToFileURL(resolve(HERE, "mock-account.mjs")).href;
const PKG_VERSION = JSON.parse(readFileSync(resolve(HERE, "..", "..", "package.json"), "utf8")).version as string;
const SESSION = "gcs_TestSession0123456789abcdefghijklmnopqrstuv";
const ACCOUNT = { id: "TestAccount0123456789a", email: "dev@example.com", github_login: null };
const NEW_TOKEN = "gc_NewAcctToken0123456789";
const ANON_TOKEN = "gc_TestToken0123456789abc";
const ANON_LINK = "https://genclass.dev/dashboard/TestSecret0123456789abcdefghijkl";
const SHOP = { id: "p_shop", name: "shop-web", token: "gc_ShopToken0123456789abc", dashboard_url: "https://genclass.dev/account/apps/p_shop", created: "2026-10-12T09:00:00.000Z", last_event: "2026-10-13T14:02:00.000Z" };
const BLOG = { id: "p_blog", name: "blog", token: "gc_BlogToken0123456789abc", dashboard_url: "https://genclass.dev/account/apps/p_blog", created: "2026-10-11T09:00:00.000Z", last_event: null };
const isWin = process.platform === "win32";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
};

type Call = { url: string; method: string; auth: string | null; body: unknown; t: number };
type Run = { code: number; out: string; calls: Call[] };

const readCalls = (log: string): Call[] => {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
  } catch {
    return [];
  }
};
const routes = (calls: Call[]) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);

/** One CLI run. `input`: answers piped on stdin, which then counts as a terminal; without it, stdin is not one. */
function run(args: string[], opts: { config?: string; env?: Record<string, string>; input?: string } = {}): Run {
  const config = opts.config ?? tmp("gc-cfg-");
  const log = join(tmp("gc-log-"), "calls.jsonl");
  const env: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config, GENCLASS_TEST_FETCH_LOG: log, NO_COLOR: "1", FORCE_COLOR: "0", GENCLASS_HOST: undefined, ...opts.env };
  if (opts.input !== undefined) env.GENCLASS_TEST_TTY = "1";
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  try {
    const out = execFileSync(process.execPath, ["--import", MOCK, BIN, ...args], { encoding: "utf8", env: env as NodeJS.ProcessEnv, input: opts.input ?? "", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, out, calls: readCalls(log) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}`, calls: readCalls(log) };
  }
}

const credFile = (config: string) => join(config, "genclass", "credentials.json");

/** A config directory holding a saved CLI session (for `host`). */
function signedIn(host = "https://genclass.dev"): string {
  const config = tmp("gc-cfg-");
  mkdirSync(join(config, "genclass"), { recursive: true, mode: 0o700 });
  writeFileSync(credFile(config), JSON.stringify({ host, access_token: SESSION, account: ACCOUNT, created: "2026-10-13T10:00:00.000Z" }), { mode: 0o600 });
  return config;
}

const VITE_HTML = `<!doctype html>\n<html lang="en">\n  <head>\n    <title>Vite</title>\n  </head>\n  <body>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n`;
function viteApp(extra: Record<string, string> = {}): string {
  const dir = tmp("gc-app-");
  const files = { "package.json": JSON.stringify({ name: "shop-web", private: true, dependencies: { vite: "^7" } }, null, 2) + "\n", "index.html": VITE_HTML, "src/main.ts": "console.log(1);\n", ...extra };
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), content);
  }
  return dir;
}
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}
const configOf = (dir: string) => readFileSync(join(dir, "src/genclass.config.ts"), "utf8");

describe("login: the device flow (RFC 8628 shapes, fake genclass.dev)", () => {
  it("prints the code and the link, polls until approved, saves the session with mode 600 in a 700 directory", () => {
    const config = tmp("gc-cfg-");
    const r = run(["login", "--no-connect"], { config, env: { GENCLASS_TEST_DEVICE: "pending,ok" } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("BCDF-GHJK");
    expect(r.out).toContain("https://genclass.dev/login/device?code=BCDF-GHJK");
    expect(r.out).toMatch(/Signed in\s+dev@example\.com/);
    expect(r.out).not.toContain("Opening it in your browser"); // not a terminal: never starts a browser
    expect(routes(r.calls)).toEqual(["POST /api/device/code", "POST /api/device/token", "POST /api/device/token"]);
    expect(r.calls.every((c) => c.url.startsWith("https://genclass.dev/") && c.auth === null)).toBe(true);
    // the CLI names itself (package and version only): genclass.dev labels the CLI session with it
    expect(r.calls[0].body).toEqual({ client_name: `genclass-runtime ${PKG_VERSION}` });
    expect(r.calls[1].body).toEqual({ device_code: "TestDeviceCode0123456789abcdefghijklmnopqrs" });
    const saved = JSON.parse(readFileSync(credFile(config), "utf8"));
    expect(Object.keys(saved).sort()).toEqual(["access_token", "account", "created", "host"]);
    expect(saved).toMatchObject({ host: "https://genclass.dev", access_token: SESSION, account: ACCOUNT });
    expect(Number.isNaN(Date.parse(saved.created))).toBe(false);
    if (!isWin) {
      expect(statSync(credFile(config)).mode & 0o777).toBe(0o600);
      expect(statSync(join(config, "genclass")).mode & 0o777).toBe(0o700);
    }
  });

  it.skipIf(isWin)("a directory that already exists with wider permissions is narrowed to 700", () => {
    const config = tmp("gc-cfg-");
    mkdirSync(join(config, "genclass"), { mode: 0o755 });
    expect(run(["login", "--no-connect"], { config, env: { GENCLASS_TEST_DEVICE: "ok" } }).code).toBe(0);
    expect(statSync(join(config, "genclass")).mode & 0o777).toBe(0o700);
    expect(statSync(credFile(config)).mode & 0o777).toBe(0o600);
  });

  it("honours slow_down: every poll after it waits 5 s longer", () => {
    // timers run 50x faster in the mock: interval 5 s -> 100 ms, after slow_down 10 s -> 200 ms
    const r = run(["login", "--no-connect"], { env: { GENCLASS_TEST_DEVICE: "pending,slow_down,pending,ok", GENCLASS_TEST_TIMERS: "50" } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("every 10 s");
    const t = r.calls.filter((c) => c.url.endsWith("/api/device/token")).map((c) => c.t);
    expect(t).toHaveLength(4);
    expect(t[1] - t[0]).toBeGreaterThanOrEqual(90);
    expect(t[2] - t[1]).toBeGreaterThanOrEqual(190);
    expect(t[3] - t[2]).toBeGreaterThanOrEqual(190);
  });

  it("slow_down naming a longer interval (genclass.dev sends one): every later poll waits that long", () => {
    // 50x faster: 5 s -> 100 ms; the server asks for 20 s -> 400 ms (more than the 5 s RFC 8628 minimum step)
    const r = run(["login", "--no-connect"], { env: { GENCLASS_TEST_DEVICE: "pending,slow_down,pending,ok", GENCLASS_TEST_SLOW: "20", GENCLASS_TEST_TIMERS: "50" } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("every 20 s");
    const t = r.calls.filter((c) => c.url.endsWith("/api/device/token")).map((c) => c.t);
    expect(t).toHaveLength(4);
    expect(t[2] - t[1]).toBeGreaterThanOrEqual(390);
    expect(t[3] - t[2]).toBeGreaterThanOrEqual(390);
  });

  it("denied or expired: says so, exits 1 and saves nothing", () => {
    for (const [step, text] of [
      ["denied", "denied in the browser"],
      ["expired", "expired before it was approved"],
    ]) {
      const config = tmp("gc-cfg-");
      const r = run(["login", "--no-connect"], { config, env: { GENCLASS_TEST_DEVICE: `pending,${step}` } });
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(text);
      expect(existsSync(credFile(config))).toBe(false);
    }
  });

  it.skipIf(isWin)("Ctrl-C while waiting stops cleanly (exit 130) and saves nothing", async () => {
    const config = tmp("gc-cfg-");
    const child = spawn(process.execPath, ["--import", MOCK, BIN, "login", "--no-connect"], {
      env: { ...process.env, XDG_CONFIG_HOME: config, NO_COLOR: "1", GENCLASS_TEST_DEVICE: "pending" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const done = new Promise<number | null>((res) => child.on("close", (code) => res(code)));
    await new Promise<void>((res) => {
      const on = (b: Buffer) => {
        out += b.toString();
        if (out.includes("Waiting for approval")) res();
      };
      child.stdout.on("data", on);
      child.stderr.on("data", on);
    });
    await new Promise((res) => setTimeout(res, 150)); // a few polls
    child.kill("SIGINT");
    expect(await done).toBe(130);
    expect(out).toContain("Cancelled: not signed in, nothing was saved.");
    expect(existsSync(credFile(config))).toBe(false);
  });

  it("already signed in: checks the session with GET /api/me and starts no new sign-in; a revoked one signs in again", () => {
    const ok = run(["login", "--no-connect"], { config: signedIn() });
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("already signed in");
    expect(routes(ok.calls)).toEqual(["GET /api/me"]);
    expect(ok.calls[0].auth).toBe(`Bearer ${SESSION}`);
    const config = signedIn();
    const again = run(["login", "--no-connect"], { config, env: { GENCLASS_TEST_ME: "401", GENCLASS_TEST_DEVICE: "ok" } });
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain("no longer works");
    expect(routes(again.calls)).toEqual(["GET /api/me", "POST /api/device/code", "POST /api/device/token"]);
  });

  it("in an app's folder it asks to connect the app; declining sends nothing more and changes no file", () => {
    const dir = viteApp();
    const before = snapshot(dir);
    const config = tmp("gc-cfg-");
    const r = run(["login", "--cwd", dir], { config, input: "n\n", env: { GENCLASS_TEST_DEVICE: "ok" } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Connect shop-web");
    expect(r.out).toContain("Not connected");
    expect(routes(r.calls)).toEqual(["POST /api/device/code", "POST /api/device/token"]);
    expect(snapshot(dir)).toEqual(before);
    expect(existsSync(credFile(config))).toBe(true);
  });

  it("login --yes connects the app: a new app in the account, its token written once the changes apply", () => {
    const dir = viteApp();
    const r = run(["login", "--yes", "--no-install", "--cwd", dir], { env: { GENCLASS_TEST_DEVICE: "pending,ok" } });
    expect(r.code, r.out).toBe(0);
    expect(routes(r.calls)).toEqual(["POST /api/device/code", "POST /api/device/token", "POST /api/device/token", "GET /api/me", "POST /api/account/projects"]);
    const create = r.calls[4];
    expect(create.auth).toBe(`Bearer ${SESSION}`);
    expect(create.body).toEqual({ name: "shop-web" });
    expect(configOf(dir)).toContain(`GENCLASS_CONFIG = { token: "${NEW_TOKEN}" };`);
    expect(readFileSync(join(dir, "src/main.ts"), "utf8").split("\n")[0]).toBe(`import "./genclass.config"; // genclass:init`);
    // an app in the account has no secret link: nothing to keep in .genclass.local
    expect(existsSync(join(dir, ".genclass.local"))).toBe(false);
    expect(r.out).toContain("https://genclass.dev/account/apps/0123456789abcdef");
  });

  it("is outside a project: no connect question, a hint instead", () => {
    const r = run(["login", "--cwd", tmp("gc-empty-")], { env: { GENCLASS_TEST_DEVICE: "ok" } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("npx @genclass/runtime connect");
    expect(routes(r.calls)).toEqual(["POST /api/device/code", "POST /api/device/token"]);
  });
});

describe("connect: the app in this folder and an app of the account", () => {
  it("not signed in: says to log in and contacts nothing", () => {
    const dir = viteApp();
    const r = run(["connect", "--cwd", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Not signed in");
    expect(r.out).toContain("npx @genclass/runtime login");
    expect(r.calls).toEqual([]);
  });

  it("--yes uses the account's app named like package.json and writes its token the way init does; again: nothing to do; remove undoes it", () => {
    const dir = viteApp();
    const before = snapshot(dir);
    const config = signedIn();
    const env = { GENCLASS_TEST_PROJECTS: JSON.stringify([BLOG, SHOP]) };
    const r = run(["connect", "--yes", "--no-install", "--cwd", dir], { config, env });
    expect(r.code, r.out).toBe(0);
    expect(routes(r.calls)).toEqual(["GET /api/me"]);
    expect(r.calls[0].auth).toBe(`Bearer ${SESSION}`);
    expect(configOf(dir)).toContain(`GENCLASS_CONFIG = { token: "${SHOP.token}" };`);
    expect(r.out).toContain(SHOP.dashboard_url);
    const again = run(["connect", "--yes", "--no-install", "--cwd", dir], { config, env });
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain("Nothing to do");
    expect(again.out).toContain("already in your account");
    expect(run(["remove", "--yes", "--cwd", dir]).code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });

  it("asks which app, then shows the diff and asks; declining sends and writes nothing; a new app is created only once applied", () => {
    const dir = viteApp();
    const before = snapshot(dir);
    const config = signedIn();
    const env = { GENCLASS_TEST_PROJECTS: JSON.stringify([BLOG, SHOP]) };
    // Enter: the default (shop-web, the package.json name), then no
    const no = run(["connect", "--no-install", "--cwd", dir], { config, env, input: "\nn\n" });
    expect(no.code, no.out).toBe(0);
    expect(no.out).toContain("Which app of your account is this");
    expect(no.out).toContain("Create a new app named shop-web");
    expect(no.out).toContain(SHOP.token);
    expect(no.out).toContain("Nothing changed");
    expect(routes(no.calls)).toEqual(["GET /api/me"]);
    expect(snapshot(dir)).toEqual(before);
    // 3: a new app; the diff shows the placeholder; no: nothing is created
    const no2 = run(["connect", "--no-install", "--cwd", dir], { config, env, input: "3\nn\n" });
    expect(no2.out).toContain("gc_new-token-created-when-you-apply");
    expect(no2.out).toContain("https://genclass.dev/api/account/projects");
    expect(routes(no2.calls)).toEqual(["GET /api/me"]);
    expect(snapshot(dir)).toEqual(before);
    // 3, yes: created now, with the session
    const yes = run(["connect", "--no-install", "--cwd", dir], { config, env, input: "3\ny\n" });
    expect(yes.code, yes.out).toBe(0);
    expect(routes(yes.calls)).toEqual(["GET /api/me", "POST /api/account/projects"]);
    expect(yes.calls[1].body).toEqual({ name: "shop-web" });
    expect(configOf(dir)).toContain(`token: "${NEW_TOKEN}"`);
  });

  it("no terminal and no --yes: shows the diff, creates nothing, writes nothing", () => {
    const dir = viteApp();
    const before = snapshot(dir);
    const r = run(["connect", "--no-install", "--cwd", dir], { config: signedIn() });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("Not a terminal, so nothing was written");
    expect(routes(r.calls)).toEqual(["GET /api/me"]);
    expect(snapshot(dir)).toEqual(before);
  });

  it("--dry-run reads the app list (GET /api/me), and creates and writes nothing; it says so", () => {
    const dir = viteApp();
    const before = snapshot(dir);
    const r = run(["connect", "--dry-run", "--cwd", dir], { config: signedIn() });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("dry run: nothing is created");
    expect(r.out).not.toContain("no network");
    expect(routes(r.calls)).toEqual(["GET /api/me"]);
    expect(snapshot(dir)).toEqual(before);
    // init --dry-run has no account to read, and sends nothing
    const init = run(["init", "--dry-run", "--cwd", viteApp()], { config: signedIn() });
    expect(init.code, init.out).toBe(0);
    expect(init.out).toContain("dry run: no network");
    expect(init.calls).toEqual([]);
  });

  it("never sends a private dashboard link to another host: with GENCLASS_HOST set, a genclass.dev link is not claimed there", () => {
    const dir = viteApp({ ".gitignore": "node_modules\n" });
    const made = run(["init", "--yes", "--no-install", "--cwd", dir]); // a genclass.dev private link, as without an account
    expect(made.code, made.out).toBe(0);
    expect(readFileSync(join(dir, ".genclass.local"), "utf8")).toContain(`GENCLASS_DASHBOARD=${ANON_LINK}`);
    const host = "http://localhost:8787";
    const r = run(["connect", "--yes", "--no-install", "--cwd", dir], { config: signedIn(host), env: { GENCLASS_HOST: host } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`belongs to https://genclass.dev, not ${host}`);
    expect(routes(r.calls)).toEqual(["GET /api/me", "POST /api/account/projects"]);
    expect(r.calls.every((c) => c.url.startsWith(`${host}/`))).toBe(true);
    const secret = ANON_LINK.split("/").pop()!;
    expect(JSON.stringify(r.calls)).not.toContain(secret);
  });

  it("an existing setup without a token gets the new app's token in place", () => {
    const dir = viteApp();
    expect(run(["init", "--yes", "--no-install", "--no-token", "--cwd", dir]).code).toBe(0);
    const r = run(["connect", "--yes", "--no-install", "--cwd", dir], { config: signedIn() });
    expect(r.code, r.out).toBe(0);
    expect(routes(r.calls)).toEqual(["GET /api/me", "POST /api/account/projects"]);
    expect(configOf(dir)).toContain(`token: "${NEW_TOKEN}"`);
    expect(readFileSync(join(dir, "src/main.ts"), "utf8").split("\n").slice(0, 2)).toEqual([`import "./genclass.config"; // genclass:init`, `import genclass from "@genclass/runtime/auto"; // genclass:init`]);
  });

  it("a setup made by init --sink keeps its sinks and the adapter import when connect adds the token", () => {
    const pkg = JSON.stringify({ name: "shop-web", private: true, dependencies: { vite: "^7", "@sentry/browser": "^9" } }, null, 2) + "\n";
    const dir = viteApp({ "package.json": pkg });
    expect(run(["init", "--yes", "--no-install", "--no-token", "--sink", "sentry", "--cwd", dir]).code).toBe(0);
    const sinks = `sinks: [sentrySink({ sentry: Sentry })]`;
    expect(configOf(dir)).toContain(`GENCLASS_CONFIG = { ${sinks} };`);
    const r = run(["connect", "--yes", "--no-install", "--cwd", dir], { config: signedIn() });
    expect(r.code, r.out).toBe(0);
    expect(routes(r.calls)).toEqual(["GET /api/me", "POST /api/account/projects"]);
    const cfg = configOf(dir);
    expect(cfg).toContain(`GENCLASS_CONFIG = { token: "${NEW_TOKEN}", ${sinks} };`);
    expect(cfg.split("\n").filter((l) => l.startsWith("import "))).toEqual([
      `import * as Sentry from "@sentry/browser";`,
      `import { sentry as sentrySink } from "@genclass/runtime/sinks/sentry";`,
    ]);
  });

  it("--sink is init's and remove's: login and connect refuse it as an unknown option (exit 2) and contact nothing", () => {
    for (const cmd of ["login", "connect"]) {
      const r = run([cmd, "--sink", "sentry", "--cwd", viteApp()], { config: signedIn() });
      expect(r.code, `${cmd}: ${r.out}`).toBe(2);
      expect(r.out).toContain(`genclass-runtime ${cmd}: unknown option --sink`);
      expect(r.calls).toEqual([]);
    }
  });

  it("a setup init made with a private link: the dashboard is added to the account (claim) and the key stays", () => {
    const dir = viteApp({ ".gitignore": "node_modules\n" });
    const made = run(["init", "--yes", "--no-install", "--cwd", dir]); // not signed in: a private link, as before
    expect(made.code, made.out).toBe(0);
    expect(routes(made.calls)).toEqual(["POST /api/projects"]);
    const files = snapshot(dir);
    expect(files[".genclass.local"]).toContain(`GENCLASS_DASHBOARD=${ANON_LINK}`);
    const config = signedIn();
    const r = run(["connect", "--yes", "--no-install", "--cwd", dir], { config });
    expect(r.code, r.out).toBe(0);
    expect(routes(r.calls)).toEqual(["GET /api/me", "POST /api/account/projects/claim"]);
    expect(r.calls[1].auth).toBe(`Bearer ${SESSION}`);
    expect(r.calls[1].body).toEqual({ dashboard_url: ANON_LINK });
    expect(r.out).toContain("added to your account");
    expect(snapshot(dir)).toEqual(files);
    // the server refuses (the worker's answers): each says what to do instead, and nothing changes. The account page
    // gives the same 404 and 409, so it is suggested only for an error that may pass.
    const unknown = run(["connect", "--yes", "--no-install", "--cwd", dir], { config, env: { GENCLASS_TEST_CLAIM: "404" } });
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain("does not know the dashboard link in .genclass.local");
    expect(unknown.out).toContain("npx @genclass/runtime connect --name shop-web");
    expect(unknown.out).not.toContain("Add an existing dashboard");
    const taken = run(["connect", "--yes", "--no-install", "--cwd", dir], { config, env: { GENCLASS_TEST_CLAIM: "409" } });
    expect(taken.code).toBe(1);
    expect(taken.out).toContain("That dashboard belongs to another GenClass account");
    expect(taken.out).toContain("npx @genclass/runtime connect --name shop-web");
    expect(taken.out).not.toContain("Add an existing dashboard");
    const down = run(["connect", "--yes", "--no-install", "--cwd", dir], { config, env: { GENCLASS_TEST_CLAIM: "500" } });
    expect(down.code).toBe(1);
    expect(down.out).toContain("HTTP 500: internal error");
    expect(down.out).toContain("Add an existing dashboard");
    for (const r of [unknown, taken, down]) expect(routes(r.calls)).toEqual(["GET /api/me", "POST /api/account/projects/claim"]);
    expect(snapshot(dir)).toEqual(files);
    // declined, then a new app: the old key is replaced, and its link is said to stay in .genclass.local
    const replaced = run(["connect", "--no-install", "--cwd", dir], { config, input: "n\ny\n" });
    expect(replaced.code, replaced.out).toBe(0);
    expect(replaced.out).toContain(`This replaces the project key ${ANON_TOKEN}`);
    expect(routes(replaced.calls)).toEqual(["GET /api/me", "POST /api/account/projects"]);
    expect(configOf(dir)).toContain(`token: "${NEW_TOKEN}"`);
    expect(readFileSync(join(dir, ".genclass.local"), "utf8")).toBe(files[".genclass.local"]);
  });

  it("--app picks an app by id or name; an unknown one is an error and nothing is written", () => {
    const env = { GENCLASS_TEST_PROJECTS: JSON.stringify([BLOG, SHOP]) };
    const dir = viteApp();
    const r = run(["connect", "--yes", "--no-install", "--app", "p_blog", "--cwd", dir], { config: signedIn(), env });
    expect(r.code, r.out).toBe(0);
    expect(configOf(dir)).toContain(`token: "${BLOG.token}"`);
    const dir2 = viteApp();
    const before = snapshot(dir2);
    const bad = run(["connect", "--yes", "--no-install", "--app", "nope", "--cwd", dir2], { config: signedIn(), env });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain(`No app "nope"`);
    expect(snapshot(dir2)).toEqual(before);
    expect(run(["connect", "--app", "a", "--name", "b", "--cwd", dir2], { config: signedIn() }).code).toBe(2);
  });

  it("a revoked session says to sign in again", () => {
    const r = run(["connect", "--yes", "--no-install", "--cwd", viteApp()], { config: signedIn(), env: { GENCLASS_TEST_ME: "401" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("no longer works");
    expect(r.out).toContain("npx @genclass/runtime login");
  });

  it("a hand-written setup: prints the key to add, edits nothing", () => {
    const dir = viteApp({ "src/main.ts": `import { GenClass } from "@genclass/runtime";\nGenClass.init();\n` });
    const before = snapshot(dir);
    const r = run(["connect", "--yes", "--no-install", "--cwd", dir], { config: signedIn(), env: { GENCLASS_TEST_PROJECTS: JSON.stringify([SHOP]) } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`GenClass.init({ token: "${SHOP.token}" })`);
    expect(snapshot(dir)).toEqual(before);
  });
});

describe("whoami and logout", () => {
  it("whoami prints the account and its apps (Bearer session); not signed in: exit 1 and no network", () => {
    const r = run(["whoami"], { config: signedIn(), env: { GENCLASS_TEST_PROJECTS: JSON.stringify([SHOP, BLOG]) } });
    expect(r.code, r.out).toBe(0);
    expect(routes(r.calls)).toEqual(["GET /api/me"]);
    expect(r.calls[0].auth).toBe(`Bearer ${SESSION}`);
    expect(r.out).toContain("dev@example.com");
    expect(r.out).toContain("Apps (2)");
    expect(r.out).toMatch(/shop-web\s+gc_ShopToken0123456789abc\s+last event 2026-10-13 14:02 UTC\s+https:\/\/genclass\.dev\/account\/apps\/p_shop/);
    expect(r.out).toMatch(/blog\s+gc_BlogToken0123456789abc\s+no events yet/);
    const none = run(["whoami"]);
    expect(none.code).toBe(1);
    expect(none.out).toContain("Not signed in");
    expect(none.calls).toEqual([]);
  });

  it("logout ends the session (DELETE /api/account/sessions/current) and deletes the file; again: nothing to do", () => {
    const config = signedIn();
    const r = run(["logout"], { config });
    expect(r.code, r.out).toBe(0);
    expect(routes(r.calls)).toEqual(["DELETE /api/account/sessions/current"]);
    expect(r.calls[0].auth).toBe(`Bearer ${SESSION}`);
    expect(existsSync(credFile(config))).toBe(false);
    const again = run(["logout"], { config });
    expect(again.code).toBe(0);
    expect(again.out).toContain("Not signed in");
    expect(again.calls).toEqual([]);
  });
});

describe("init and a signed-in account", () => {
  it("asks before anything is sent; yes creates the app in the account (no private link to save)", () => {
    const dir = viteApp();
    const r = run(["init", "--no-install", "--cwd", dir], { config: signedIn(), input: "y\ny\n" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Signed in as dev@example.com: create this app in your GenClass account?");
    expect(routes(r.calls)).toEqual(["POST /api/account/projects"]);
    expect(r.calls[0].auth).toBe(`Bearer ${SESSION}`);
    expect(configOf(dir)).toContain(`token: "${NEW_TOKEN}"`);
    expect(existsSync(join(dir, ".genclass.local"))).toBe(false);
  });

  it("no to the account question: a private dashboard link, as without an account", () => {
    const dir = viteApp();
    const r = run(["init", "--no-install", "--cwd", dir], { config: signedIn(), input: "n\ny\n" });
    expect(r.code, r.out).toBe(0);
    expect(routes(r.calls)).toEqual(["POST /api/projects"]);
    expect(r.calls[0].auth).toBeNull();
    expect(readFileSync(join(dir, ".genclass.local"), "utf8")).toContain(`GENCLASS_DASHBOARD=${ANON_LINK}`);
  });

  it("no to the changes: nothing is sent and nothing is written", () => {
    const dir = viteApp();
    const before = snapshot(dir);
    const r = run(["init", "--no-install", "--cwd", dir], { config: signedIn(), input: "y\nn\n" });
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });

  it("init --sink while signed in: both notices (the sinks and the account question), and the token and sinks together", () => {
    const dir = viteApp();
    const r = run(["init", "--no-install", "--sink", "sentry", "--cwd", dir], { config: signedIn(), input: "y\ny\n" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Signed in as dev@example.com: create this app in your GenClass account?");
    expect(r.out).toMatch(/Findings\s+sentry \(--sink, written to src\/genclass\.config\.ts\)/);
    expect(r.out).toContain("They also reach sentry");
    expect(routes(r.calls)).toEqual(["POST /api/account/projects"]);
    expect(configOf(dir)).toContain(`GENCLASS_CONFIG = { token: "${NEW_TOKEN}", sinks: ["sentry"] };`);
  });

  it("--yes uses the account; without saved credentials (or with ones for another host) init is unchanged", () => {
    const a = viteApp();
    expect(routes(run(["init", "--yes", "--no-install", "--cwd", a], { config: signedIn() }).calls)).toEqual(["POST /api/account/projects"]);
    const b = viteApp();
    const plain = run(["init", "--yes", "--no-install", "--cwd", b]);
    expect(routes(plain.calls)).toEqual(["POST /api/projects"]);
    expect(plain.out).not.toContain("account");
    const c = viteApp();
    const other = run(["init", "--yes", "--no-install", "--cwd", c], { config: signedIn("http://localhost:8787") });
    expect(routes(other.calls)).toEqual(["POST /api/projects"]);
  });
});

describe("GENCLASS_HOST (tests only)", () => {
  it("is printed and used for every request; plain http only on loopback hosts", () => {
    const r = run(["whoami"], { config: signedIn("http://localhost:8787"), env: { GENCLASS_HOST: "http://localhost:8787" } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("GENCLASS_HOST is set");
    expect(r.calls.map((c) => c.url)).toEqual(["http://localhost:8787/api/me"]);
    // a session saved for another host is not used (and not sent)
    const other = run(["whoami"], { config: signedIn(), env: { GENCLASS_HOST: "http://localhost:8787" } });
    expect(other.code).toBe(1);
    expect(other.out).toContain("the saved session is for https://genclass.dev");
    expect(other.calls).toEqual([]);
    const bad = run(["login"], { env: { GENCLASS_HOST: "http://example.com" } });
    expect(bad.code).toBe(2);
    expect(bad.calls).toEqual([]);
    expect(hostConfig({}).host).toBe("https://genclass.dev");
    expect(hostConfig({ GENCLASS_HOST: "http://127.0.0.1:8787" })).toEqual({ host: "http://127.0.0.1:8787", overridden: true });
    expect(hostConfig({ GENCLASS_HOST: "https://genclass.dev/x" }).error).toBeTruthy();
  });
});

describe("credentials file location", () => {
  it("$XDG_CONFIG_HOME/genclass, else ~/.config/genclass, Windows %APPDATA%\\genclass", () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: "/x/cfg", HOME: "/home/a" }, "linux")).toBe(join("/x/cfg", "genclass", "credentials.json"));
    expect(credentialsPath({ HOME: "/home/a" }, "darwin")).toBe(join("/home/a", ".config", "genclass", "credentials.json"));
    expect(credentialsPath({ XDG_CONFIG_HOME: "relative/cfg", HOME: "/home/a" }, "linux")).toBe(join("/home/a", ".config", "genclass", "credentials.json"));
    expect(credentialsPath({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32")).toBe(join("C:\\Users\\a\\AppData\\Roaming", "genclass", "credentials.json"));
  });

  it("help lists the account commands", () => {
    const top = run(["--help"]);
    for (const cmd of ["login", "connect", "whoami", "logout"]) expect(top.out).toContain(`genclass-runtime ${cmd}`);
    const login = run(["login", "--help"]);
    expect(login.code).toBe(0);
    expect(login.out).toContain("--no-browser");
    expect(login.calls).toEqual([]);
  });
});

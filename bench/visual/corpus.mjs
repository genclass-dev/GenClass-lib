// The pages the visual bench loads (docs/runtime/VISUAL.md section 15): how to prepare and serve each group, served
// the way their READMEs say. Nothing here edits an app: the demos, templates and compat apps are built from this
// checkout as they are (AGENTS.md rule 4), and their own GenClass runtime is told to leave visual checks off
// (?genclass-visual=off) so the only checks on a page are the harness's.
//
//   demos      npm run build (demos/scripts/build.mjs), served by demos/e2e/serve.ts under /genclass/ (npm run preview)
//   templates  each starter copied, @genclass/runtime pointed at the packed tarball, npm install, npm run dev
//   compat     the packed runtime installed in each app, its production build served through compat/harness/front.mjs
//              with the shared mock backend (clean traffic, scenario h latencies)
//   sites      bench/visual/sites.json, one public home page per entry
//
//   node bench/visual/corpus.mjs prepare <demos|templates|compat>     (CI: before run.mjs)

import { execSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../..");
const RUNTIME = join(REPO, "packages/runtime");
const PACK = join(REPO, "compat/.pack");
const TGZ = join(PACK, "genclass-runtime.tgz");
export const PKG_X = join(PACK, "pkg", "package");
const WORK = process.env.VISUAL_BENCH_WORK || join(REPO, "bench/visual/.work");
const ENV = { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", NEXT_TELEMETRY_DISABLED: "1", NG_CLI_ANALYTICS: "false", SVELTEKIT_TELEMETRY_DISABLED: "1" };

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, cwd, timeout = 1_500_000) {
  log(`$ ${cmd}  (${cwd.replace(REPO, ".")})`);
  execSync(cmd, { cwd, env: ENV, stdio: "inherit", timeout });
}

export const freePort = () =>
  new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });

async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

/** A child server in its own process group; stop() kills the group. */
async function serve(cmd, cwd, url, env = {}) {
  let out = "";
  const child = spawn(cmd, { cwd, shell: true, detached: true, env: { ...ENV, ...env } });
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const stop = async () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* gone */
    }
    await sleep(500);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  };
  if (!(await waitHttp(url, 180_000))) {
    await stop();
    throw new Error(`server did not start: ${cmd}\n${out.slice(-2000)}`);
  }
  return { stop, log: () => out };
}

// ------------------------------------------------------------------------------------------------ prepare

function packRuntime() {
  if (existsSync(join(PKG_X, "package.json"))) return;
  mkdirSync(PACK, { recursive: true });
  const name = execSync(`npm pack --silent --pack-destination ${JSON.stringify(PACK)}`, { cwd: RUNTIME, env: ENV, encoding: "utf8" }).trim().split("\n").pop();
  renameSync(join(PACK, name), TGZ);
  rmSync(join(PACK, "pkg"), { recursive: true, force: true });
  mkdirSync(join(PACK, "pkg"), { recursive: true });
  execSync(`tar -xzf ${JSON.stringify(TGZ)} -C ${JSON.stringify(join(PACK, "pkg"))}`);
  log(`packed @genclass/runtime at ${TGZ}`);
}

export const TEMPLATES = {
  "react-vite": "npx vite --host 127.0.0.1 --strictPort --port {port}",
  nextjs: "npx next dev -H 127.0.0.1 -p {port}",
  "vue-vite": "npx vite --host 127.0.0.1 --strictPort --port {port}",
  sveltekit: "npx vite dev --host 127.0.0.1 --strictPort --port {port}",
};

/** Build or install a group before run.mjs (each step prints its output, so a failure is visible in CI). */
export async function prepare(group) {
  if (group === "demos") {
    sh("node scripts/build.mjs", join(REPO, "demos"));
    return;
  }
  packRuntime();
  if (group === "templates") {
    for (const name of Object.keys(TEMPLATES)) {
      const dir = join(WORK, "templates", name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      cpSync(join(REPO, "templates", name), dir, { recursive: true, filter: (s) => !/node_modules|\.next|\.svelte-kit|[\\/]dist/.test(s) });
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      pkg.dependencies["@genclass/runtime"] = `file:${TGZ}`;
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
      sh("npm install --no-audit --no-fund --loglevel=error", dir);
    }
    return;
  }
  if (group === "compat") {
    const { APPS } = await import("../../compat/harness/apps.mjs");
    for (const [name, app] of Object.entries(APPS)) {
      const dir = join(REPO, "compat", app.dir);
      if (existsSync(join(dir, "package.json"))) {
        rmSync(join(dir, "node_modules/@genclass"), { recursive: true, force: true });
        sh("npm install --no-audit --no-fund --loglevel=error", dir);
      }
      if (app.build) sh(app.build, dir);
      log(`compat ${name}: ready`);
    }
    return;
  }
  throw new Error(`nothing to prepare for ${group}`);
}

// --------------------------------------------------------------------------------------------------- start

/**
 * Start a group's servers. Returns { pages, stop } where each page is
 * { group, id, url, ready?, local, timeoutMs, gcConfig?, route? (context route handler for the page's own CDN) }.
 */
export async function start(group, { shard = null } = {}) {
  if (group === "demos") {
    const port = await freePort();
    const s = await serve(`node --experimental-strip-types e2e/serve.ts dist --base /genclass/ --port ${port}`, join(REPO, "demos"), `http://127.0.0.1:${port}/genclass/`);
    const base = `http://127.0.0.1:${port}/genclass/`;
    const names = ["index", ...readdirSync(join(REPO, "demos/src/demos")).filter((n) => existsSync(join(REPO, "demos", n, "index.html"))).sort()];
    const pages = names.map((n) => ({ group, id: `demos/${n}`, url: `${base}${n === "index" ? "" : `${n}/`}?mode=off&genclass-visual=off`, local: true, timeoutMs: 60_000, faults: true }));
    return { pages, stop: s.stop };
  }
  if (group === "templates") {
    const stops = [];
    const pages = [];
    for (const [name, cmd] of Object.entries(TEMPLATES)) {
      const dir = join(WORK, "templates", name);
      const port = await freePort();
      const url = `http://127.0.0.1:${port}/`;
      const s = await serve(cmd.replace("{port}", port), dir, url);
      stops.push(s.stop);
      // the dev servers compile on the first request
      await waitHttp(`${url}?genclass-visual=off`, 120_000);
      pages.push({ group, id: `templates/${name}`, url: `${url}?genclass-visual=off`, local: true, timeoutMs: 120_000, faults: true, ready: "input" });
    }
    return { pages, stop: async () => Promise.all(stops.map((f) => f())) };
  }
  if (group === "compat") {
    const { APPS } = await import("../../compat/harness/apps.mjs");
    const { createBackend } = await import("../../compat/harness/backend.mjs");
    const { startFront } = await import("../../compat/harness/front.mjs");
    const stops = [];
    const pages = [];
    for (const [name, app] of Object.entries(APPS)) {
      const dir = join(REPO, "compat", app.dir);
      let upstream = null;
      let staticDir = null;
      if (app.serve.static) staticDir = join(dir, app.serve.static);
      else {
        const port = await freePort();
        const env = Object.fromEntries(Object.entries(app.serve.env ?? {}).map(([k, v]) => [k, String(v).replace("{port}", port)]));
        upstream = `http://127.0.0.1:${port}`;
        const s = await serve(app.serve.cmd.replace("{port}", port), dir, upstream, env);
        stops.push(s.stop);
      }
      const backend = createBackend();
      backend.reset({ seed: 1, scenario: "h" });
      const front = await startFront({ backend, upstream, staticDir, pkgDir: PKG_X });
      stops.push(() => front.close());
      const layer = Object.keys(app.layers)[0];
      for (const sc of ["c", "d", "h"]) {
        pages.push({
          group,
          id: `compat/${name}?s=${sc}`,
          url: `${front.url}/?s=${sc}&layer=${layer}&genclass-visual=off`,
          ready: '#compat[data-ready="1"]',
          local: true,
          timeoutMs: 60_000,
          faults: sc === "h",
          integration: sc === "h",
          reset: () => backend.reset({ seed: 1, scenario: "h" }),
          gcConfig: { telemetry: false, model: false },
          cdn: !!app.cdn,
        });
      }
    }
    return { pages, stop: async () => Promise.all(stops.map((f) => f())) };
  }
  if (group === "sites") {
    const list = JSON.parse(readFileSync(join(HERE, "sites.json"), "utf8")).sites;
    const [i, n] = shard ? shard.split("/").map(Number) : [0, 1];
    const pages = list.filter((_, k) => k % n === i).map((s) => ({ group, id: s.id, url: s.url, category: s.category, local: false, timeoutMs: 30_000, faults: false }));
    return { pages, stop: async () => undefined };
  }
  throw new Error(`unknown group ${group}`);
}

/** The context route for a page served locally: other hosts are blocked, the CDN script is served from the tarball. */
export function localRoute(blocked) {
  return (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return route.continue();
    let m;
    if (u.hostname === "cdn.jsdelivr.net") {
      if (/^\/npm\/@genclass\/runtime(?:@[^/]+)?\/?$/.test(u.pathname)) return route.fulfill({ path: join(PKG_X, "dist/genclass.global.min.js"), contentType: "text/javascript", headers: { "access-control-allow-origin": "*" } });
      if ((m = /^\/npm\/@genclass\/runtime(?:@[^/]+)?\/(.+)$/.exec(u.pathname))) return route.fulfill({ path: join(PKG_X, m[1]), contentType: "text/javascript", headers: { "access-control-allow-origin": "*" } });
    }
    blocked.add(u.origin);
    return route.abort();
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, group] = process.argv.slice(2);
  if (cmd !== "prepare" || !group) {
    console.error("usage: node bench/visual/corpus.mjs prepare <demos|templates|compat>");
    process.exit(2);
  }
  await prepare(group);
}

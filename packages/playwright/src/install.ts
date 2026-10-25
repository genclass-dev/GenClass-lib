// Puts GenClass on a Playwright page without touching the app under test, and collects what it saw. Node only, but
// Playwright-agnostic: it takes the few page methods it uses as an interface (PageLike), so unit tests drive it with
// a fake page and the fixture (fixture.ts) passes the real one.
//
// What it does to the page:
//   - serves @genclass/runtime's dist/ (resolved from the installed package, or `runtimeDir`) on the virtual
//     same-origin path RUNTIME_PATH ("/__genclass__/") with page.route, so the script-tag build, the agent entry and
//     anything the runtime loads later come from disk, never from a CDN;
//   - adds one init script (page.addInitScript): the page-side function of page.ts plus the script-tag build, so the
//     runtime starts before the app's first script, in observe mode with telemetry off and the model as chosen;
//   - exposes one function (page.exposeFunction) the page pushes each finding through as it happens, so navigations
//     and an early page close lose nothing;
//   - with chaos, routes every request through the seeded scheduler (chaos.ts): a matched fetch/XHR request is held
//     for its planned time and then passed on with route.fallback(), so it still reaches the user's own routes
//     (context.route, routeFromHAR), the browser's network stack and its cache. Anything else is passed on at once.
// The page's agent link never sends a request (page.ts gives it a stand-in fetch); requests to its URL are aborted
// anyway as a safety net. Observe only: no hold on the page's side, no change to any request or response (chaos
// changes when a request leaves, never what it says). Every handler catches its own errors: a page that closes
// mid-test is not a failure.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { ChaosScheduler, RUNTIME_PATH, isCandidate, isRuntimeUrl, type ResolvedChaos } from "./chaos.js";
import { genclassPageScript, type PageScriptConfig } from "./page.js";

/** The page methods the installer uses (a subset of Playwright's Page, by shape). */
export interface PageLike {
  route(url: string, handler: (route: RouteLike, request: RequestLike) => Promise<void> | void): Promise<void>;
  addInitScript(script: { content: string }): Promise<void>;
  exposeFunction(name: string, fn: (item: unknown) => unknown): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  isClosed?(): boolean;
}

export interface RouteLike {
  fulfill(options: { status?: number; headers?: Record<string, string>; body?: string | Buffer; contentType?: string }): Promise<void>;
  fallback(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export interface RequestLike {
  url(): string;
  method(): string;
  resourceType(): string;
  headers(): Record<string, string>;
  frame(): { url(): string };
}

export interface InstallOptions {
  /** The runtime's dist/ directory. Default: the installed @genclass/runtime package's. */
  runtimeDir?: string;
  /** "skip": no model (the file carries witnesses only). "load": the runtime loads its model. */
  model: "skip" | "load";
  /** With `model: "load"`: a model directory URL (the runtime's `model.baseUrl`). */
  modelUrl?: string;
  /** Resolved chaos, or null for none. */
  chaos: ResolvedChaos | null;
}

/** The runtime's model status as the page reported it last. */
export interface ModelInfo {
  state?: string;
  name?: string;
  version?: string;
  device?: string;
}

/** What one test collected. */
export interface Collected {
  /** Sink records of kind "detection" (likely tier), as the runtime sent them. */
  records: unknown[];
  /** The agent entry's witnesses, in order of appearance. */
  witnesses: unknown[];
  /** The runtime's mode on the page (null: it never started). */
  mode: string | null;
  /** Its model status (null: it never started). */
  model: ModelInfo | null;
  /** The agent entry's state: null when connected, else why not ("not-loaded", an error message). */
  agent: string | null;
  /** The chaos plans applied, in request order. */
  plans: { key: string; delayMs: number }[];
  /** A service worker controlled the page when the fixture collected (page.route does not see what it handles). */
  serviceWorker: boolean;
  /** The URL or localStorage switch had put the runtime in another mode; the fixture set it back to observe. */
  modeOverridden: string | null;
}

export interface Session {
  /** Collect what the page still holds, release every chaos hold, and return everything seen. */
  finish(): Promise<Collected>;
}

/** The name of the function exposed on the page. */
export const BINDING = "__genclassPlaywright";
/** The loopback URL the page's agent link is pointed at; the fixture aborts every request to it. */
export const AGENT_URL = "http://127.0.0.1:9";

const require = createRequire(import.meta.url);
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};
const fileCache = new Map<string, Buffer>();

/** The installed @genclass/runtime's dist/ directory (its package.json export), or `given`. Throws when neither exists. */
export function resolveRuntimeDir(given?: string): string {
  if (given) {
    const dir = resolve(given);
    if (!existsSync(join(dir, "genclass.global.js"))) throw new Error(`@genclass/playwright: runtimeDir ${dir} has no genclass.global.js (point it at @genclass/runtime's dist/)`);
    return dir;
  }
  let pkg: string;
  try {
    pkg = require.resolve("@genclass/runtime/package.json");
  } catch {
    throw new Error("@genclass/playwright: @genclass/runtime is not installed (npm install -D @genclass/runtime@beta), or pass genclass.runtimeDir");
  }
  const dir = join(dirname(pkg), "dist");
  if (!existsSync(join(dir, "genclass.global.js"))) throw new Error(`@genclass/playwright: ${dir} has no genclass.global.js: the installed @genclass/runtime has no build`);
  if (!existsSync(join(dir, "agent.js"))) throw new Error(`@genclass/playwright: ${dir} has no agent.js: the fixture needs @genclass/runtime 0.3.0-beta.1 or later`);
  return dir;
}

function readCached(path: string): Buffer {
  let b = fileCache.get(path);
  if (!b) {
    b = readFileSync(path);
    fileCache.set(path, b);
  }
  return b;
}

/** The init script's source: the page function applied to its config and to the script-tag build wrapped in a function. */
export function initScriptContent(runtimeDir: string, cfg: PageScriptConfig): string {
  const global = readCached(join(runtimeDir, "genclass.global.js")).toString("utf8");
  return `(${genclassPageScript.toString()})(${JSON.stringify(cfg)}, function () {\n${global}\n});\n`;
}

/** A URL on the agent link's address (not merely one whose port starts with the same digits). */
export function isAgentUrl(url: string): boolean {
  return url === AGENT_URL || url.startsWith(`${AGENT_URL}/`);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The file inside dist/ a request for RUNTIME_PATH names, or null when it is not a plain file path inside it. */
export function runtimeFile(runtimeDir: string, url: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  if (!pathname.startsWith(RUNTIME_PATH)) return null;
  const rel = pathname.slice(RUNTIME_PATH.length);
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(rel) || rel.split("/").some((s) => s === "." || s === "..")) return null;
  const abs = resolve(runtimeDir, ...rel.split("/"));
  if (!abs.startsWith(resolve(runtimeDir) + sep)) return null;
  return abs;
}

/**
 * Installs GenClass on the page and returns the session to finish at the end of the test. Throws only before touching
 * the page (a runtime that cannot be found); everything after that is best effort.
 */
export async function install(page: PageLike, o: InstallOptions): Promise<Session> {
  const runtimeDir = resolveRuntimeDir(o.runtimeDir);
  const collected: Collected = { records: [], witnesses: [], mode: null, model: null, agent: "not-loaded", plans: [], serviceWorker: false, modeOverridden: null };
  const scheduler = o.chaos ? new ChaosScheduler(o.chaos) : null;

  const take = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    const x = item as Record<string, unknown>;
    if (x.t === "record" && x.record) collected.records.push(x.record);
    else if (x.t === "witness" && x.witness) collected.witnesses.push(x.witness);
    else if (x.t === "status") {
      collected.mode = typeof x.mode === "string" ? x.mode : null;
      collected.model = x.model && typeof x.model === "object" ? (x.model as ModelInfo) : null;
      if (typeof x.overridden === "string") collected.modeOverridden = x.overridden;
    } else if (x.t === "agent") collected.agent = x.ok === true ? null : String(x.reason ?? "unknown");
  };
  await page.exposeFunction(BINDING, take);

  // chaos first: the routes below are matched before it (Playwright tries the last registered handler first)
  if (scheduler) {
    const chaos = scheduler.chaos;
    await page.route("**/*", async (route, request) => {
      try {
        const url = request.url();
        if (isRuntimeUrl(url) || isAgentUrl(url)) return await route.fallback();
        let frameUrl = "";
        try {
          frameUrl = request.frame().url();
        } catch {
          /* a detached frame */
        }
        const origin = originOf(url);
        let accept = "";
        try {
          accept = request.headers()["accept"] ?? "";
        } catch {
          /* no headers */
        }
        const req = { url, method: request.method(), resourceType: request.resourceType(), sameOrigin: origin !== null && origin === originOf(frameUrl), accept };
        // planned now, in the order the page sent its requests; the request itself is only held, never fetched here
        if (isCandidate(req, chaos.match)) await scheduler.hold(scheduler.plan(req.method, req.url, req.sameOrigin));
        await route.fallback();
      } catch {
        /* the page closed while the request was held */
      }
    });
  }

  // the runtime's files, from disk
  await page.route(`**${RUNTIME_PATH}**`, async (route, request) => {
    try {
      const file = runtimeFile(runtimeDir, request.url());
      if (!file || !existsSync(file)) return await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
      await route.fulfill({ status: 200, headers: { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }, body: readCached(file) });
    } catch {
      /* the page closed */
    }
  });
  // the page's agent link sends nothing (page.ts gives it a stand-in fetch); should anything still ask, never let it
  // reach a bridge
  await page.route(`${AGENT_URL}/**`, (route) => route.abort("connectionrefused").catch(() => undefined));

  const cfg: PageScriptConfig = {
    base: RUNTIME_PATH,
    model: o.model === "load" ? (o.modelUrl ? { baseUrl: o.modelUrl } : {}) : false,
    agentUrl: AGENT_URL,
    binding: BINDING,
  };
  await page.addInitScript({ content: initScriptContent(runtimeDir, cfg) });

  return {
    async finish(): Promise<Collected> {
      try {
        if (!page.isClosed?.()) {
          const r = await Promise.race([
            page.evaluate(`(function () { var a = window.__GENCLASS_PLAYWRIGHT__; return a ? a.collect() : null; })()`),
            new Promise<null>((res) => setTimeout(() => res(null), 2000).unref?.()),
          ]);
          if (r && typeof r === "object") {
            const x = r as Record<string, unknown>;
            if (typeof x.mode === "string") collected.mode = x.mode;
            if (x.model && typeof x.model === "object") collected.model = x.model as ModelInfo;
            // a specific reason the page already pushed (an import error) beats collect()'s generic "not-loaded"
            if (x.agent === null) collected.agent = null;
            else if (typeof x.agent === "string" && (collected.agent === null || collected.agent === "not-loaded")) collected.agent = x.agent;
            if (x.serviceWorker === true) collected.serviceWorker = true;
          }
        }
      } catch {
        /* the page is gone: what it pushed so far is what there is */
      }
      scheduler?.dispose();
      collected.plans = scheduler ? scheduler.plans.slice() : [];
      return collected;
    },
  };
}

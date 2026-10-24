// The installer (src/install.ts) on a fake page: what it registers, what the init script carries, how the runtime's
// files are served (and what is refused), how chaos routes behave, and what finish() collects. No browser.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_URL, BINDING, initScriptContent, install, resolveRuntimeDir, runtimeFile, type PageLike, type RequestLike, type ResponseLike, type RouteLike } from "../src/install.js";
import { RUNTIME_PATH, resolveChaos } from "../src/chaos.js";
import { here } from "./helpers.js";

type Handler = (route: RouteLike, request: RequestLike) => Promise<void> | void;

class FakePage implements PageLike {
  routes: { pattern: string; handler: Handler }[] = [];
  initScripts: string[] = [];
  exposed = new Map<string, (item: unknown) => unknown>();
  evaluateResult: unknown = null;
  evaluated: string[] = [];
  closed = false;
  async route(pattern: string, handler: Handler): Promise<void> {
    this.routes.push({ pattern, handler });
  }
  async addInitScript(s: { content: string }): Promise<void> {
    this.initScripts.push(s.content);
  }
  async exposeFunction(name: string, fn: (item: unknown) => unknown): Promise<void> {
    this.exposed.set(name, fn);
  }
  async evaluate(expression: string): Promise<unknown> {
    this.evaluated.push(expression);
    return this.evaluateResult;
  }
  isClosed(): boolean {
    return this.closed;
  }
  handler(pattern: string): Handler {
    const r = this.routes.find((x) => x.pattern === pattern);
    if (!r) throw new Error(`no route ${pattern}`);
    return r.handler;
  }
  push(item: unknown): void {
    this.exposed.get(BINDING)!(item);
  }
}

class FakeRoute implements RouteLike {
  calls: string[] = [];
  fulfilled: Parameters<RouteLike["fulfill"]>[0] | null = null;
  constructor(
    private readonly response: ResponseLike | Error = { headers: () => ({ "content-type": "application/json" }) },
  ) {}
  async fetch(): Promise<ResponseLike> {
    this.calls.push("fetch");
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
  async fulfill(o: Parameters<RouteLike["fulfill"]>[0]): Promise<void> {
    this.calls.push("fulfill");
    this.fulfilled = o;
  }
  async fallback(): Promise<void> {
    this.calls.push("fallback");
  }
  async abort(code?: string): Promise<void> {
    this.calls.push(`abort:${code ?? ""}`);
  }
}

const request = (url: string, o: { method?: string; resourceType?: string; frameUrl?: string } = {}): RequestLike => ({
  url: () => url,
  method: () => o.method ?? "GET",
  resourceType: () => o.resourceType ?? "fetch",
  frame: () => ({ url: () => o.frameUrl ?? "http://app.test/page" }),
});

let runtimeDir = "";
beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "genclass-rt-"));
  writeFileSync(join(runtimeDir, "genclass.global.js"), "/* the script-tag build */ window.__fakeGlobalRan = true;\n");
  writeFileSync(join(runtimeDir, "agent.js"), "export function connectAgent() {}\n");
  mkdirSync(join(runtimeDir, "cdn"));
  writeFileSync(join(runtimeDir, "cdn", "worker.js"), "// worker\n");
});
afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

describe("install: the runtime directory", () => {
  it("takes a given dist/ and refuses one without the script-tag build", () => {
    expect(resolveRuntimeDir(runtimeDir)).toBe(runtimeDir);
    const empty = mkdtempSync(join(tmpdir(), "genclass-empty-"));
    expect(() => resolveRuntimeDir(empty)).toThrow(/no genclass\.global\.js/);
    rmSync(empty, { recursive: true, force: true });
  });

  const built = existsSync(join(here, "..", "..", "runtime", "dist", "genclass.global.js"));
  it.runIf(built)("by default finds the installed @genclass/runtime's dist/", () => {
    const dir = resolveRuntimeDir();
    expect(dir.endsWith(join("runtime", "dist"))).toBe(true);
    expect(existsSync(join(dir, "agent.js"))).toBe(true);
  });

  it("maps a request on the virtual path to a file inside dist/, and nothing else", () => {
    expect(runtimeFile(runtimeDir, `http://app.test${RUNTIME_PATH}genclass.global.js`)).toBe(join(runtimeDir, "genclass.global.js"));
    expect(runtimeFile(runtimeDir, `http://app.test${RUNTIME_PATH}cdn/worker.js?x=1`)).toBe(join(runtimeDir, "cdn", "worker.js"));
    expect(runtimeFile(runtimeDir, `http://app.test${RUNTIME_PATH}../package.json`)).toBeNull();
    expect(runtimeFile(runtimeDir, `http://app.test${RUNTIME_PATH}cdn/..%2F..%2Fetc/passwd`)).toBeNull();
    expect(runtimeFile(runtimeDir, `http://app.test${RUNTIME_PATH}`)).toBeNull();
    expect(runtimeFile(runtimeDir, `http://app.test${RUNTIME_PATH}a b.js`)).toBeNull();
    expect(runtimeFile(runtimeDir, "http://app.test/other/agent.js")).toBeNull();
    expect(runtimeFile(runtimeDir, "not a url")).toBeNull();
  });
});

describe("install: what goes on the page", () => {
  it("one exposed function, the runtime route, the agent abort route and one init script; no chaos route without chaos", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: null });
    expect([...page.exposed.keys()]).toEqual([BINDING]);
    expect(page.routes.map((r) => r.pattern)).toEqual([`**${RUNTIME_PATH}**`, `${AGENT_URL}/**`]);
    expect(page.initScripts).toHaveLength(1);
    const script = page.initScripts[0];
    expect(script).toContain("/* the script-tag build */");
    expect(script).toContain(`"base":"${RUNTIME_PATH}"`);
    expect(script).toContain('"model":false');
    expect(script).toContain(`"agentUrl":"${AGENT_URL}"`);
    expect(script).toContain(`"binding":"${BINDING}"`);
    expect(script).toContain("__GENCLASS_PLAYWRIGHT__");
    expect(script).toContain('telemetry: false');
    expect(script).toContain('mode: "observe"');
    expect(script).toContain("hold: false");
  });

  it("the init script is the page function applied to its config and the build, as plain JavaScript", () => {
    const content = initScriptContent(runtimeDir, { base: RUNTIME_PATH, model: { baseUrl: "/models/" }, agentUrl: AGENT_URL, binding: BINDING });
    expect(content.startsWith("(function genclassPageScript(cfg, runGlobal)")).toBe(true);
    expect(content).toContain('"model":{"baseUrl":"/models/"}');
    // it parses as a script (no TypeScript left in it)
    expect(() => new Function(content)).not.toThrow();
  });

  it("model load without a URL passes an empty model options object", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "load", chaos: null });
    expect(page.initScripts[0]).toContain('"model":{}');
  });

  it("serves the runtime's files from disk with the right content type, and 404 for anything else", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: null });
    const serve = page.handler(`**${RUNTIME_PATH}**`);
    const ok = new FakeRoute();
    await serve(ok, request(`http://app.test${RUNTIME_PATH}genclass.global.js`, { resourceType: "script" }));
    expect(ok.calls).toEqual(["fulfill"]);
    expect(ok.fulfilled).toMatchObject({ status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
    expect(String(ok.fulfilled!.body)).toContain("the script-tag build");
    const worker = new FakeRoute();
    await serve(worker, request(`http://app.test${RUNTIME_PATH}cdn/worker.js`, { resourceType: "other" }));
    expect(worker.fulfilled).toMatchObject({ status: 200 });
    for (const u of [`http://app.test${RUNTIME_PATH}missing.js`, `http://app.test${RUNTIME_PATH}../package.json`]) {
      const r = new FakeRoute();
      await serve(r, request(u));
      expect(r.fulfilled, u).toMatchObject({ status: 404 });
    }
  });

  it("aborts the page's agent link so it never reaches a bridge", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: null });
    const r = new FakeRoute();
    await page.handler(`${AGENT_URL}/**`)(r, request(`${AGENT_URL}/v1/hello`, { method: "POST" }));
    expect(r.calls).toEqual(["abort:connectionrefused"]);
  });
});

describe("install: chaos routes", () => {
  it("registers the chaos route first, so the runtime's files and the agent URL are matched before it", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [0, 0] }) });
    expect(page.routes.map((r) => r.pattern)).toEqual(["**/*", `**${RUNTIME_PATH}**`, `${AGENT_URL}/**`]);
  });

  it("leaves alone what is outside the filter: documents, scripts, cross-origin requests, the runtime's files, the agent URL", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [0, 0] }) });
    const chaos = page.handler("**/*");
    for (const [url, o] of [
      ["http://app.test/page", { resourceType: "document" }],
      ["http://app.test/app.js", { resourceType: "script" }],
      ["https://api.other.test/api/x", {}],
      [`http://app.test${RUNTIME_PATH}agent.js`, {}],
      [`${AGENT_URL}/v1/hello`, { method: "POST" }],
    ] as const) {
      const r = new FakeRoute();
      await chaos(r, request(url, o));
      expect(r.calls, url).toEqual(["fallback"]);
    }
  });

  it("fetches a candidate, delays a confirmed one and fulfils with the real response; a non-JSON non-API response goes through at once", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [5, 5] }) });
    const chaos = page.handler("**/*");
    const api = new FakeRoute({ headers: () => ({ "content-type": "text/html" }) });
    const t0 = Date.now();
    await chaos(api, request("http://app.test/api/items?page=2", { resourceType: "xhr" }));
    expect(api.calls).toEqual(["fetch", "fulfill"]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4);
    const json = new FakeRoute({ headers: () => ({ "Content-Type": "application/json" }) });
    await chaos(json, request("http://app.test/graphql", { method: "POST" }));
    expect(json.calls).toEqual(["fetch", "fulfill"]);
    const html = new FakeRoute({ headers: () => ({ "content-type": "text/html" }) });
    await chaos(html, request("http://app.test/fragment"));
    expect(html.calls).toEqual(["fetch", "fulfill"]);
    const c = await session.finish();
    expect(c.plans.map((p) => p.key)).toEqual(["GET /api/items#1", "POST /graphql#1"]);
    expect(c.plans.every((p) => p.delayMs === 5)).toBe(true);
  });

  it("a request that fails to fetch is aborted so the app sees the failure; a closed page is not an error", async () => {
    const page = new FakePage();
    await install(page, { runtimeDir, model: "skip", chaos: resolveChaos({ seed: 1, delayMs: [0, 0] }) });
    const chaos = page.handler("**/*");
    const down = new FakeRoute(new Error("connection refused"));
    await chaos(down, request("http://app.test/api/x"));
    expect(down.calls).toEqual(["fetch", "abort:failed"]);
    const gone = new FakeRoute({ headers: () => ({ "content-type": "application/json" }) });
    gone.fulfill = async () => {
      throw new Error("Target page, context or browser has been closed");
    };
    await expect(chaos(gone, request("http://app.test/api/x"))).resolves.toBeUndefined();
  });
});

describe("install: collecting", () => {
  it("keeps what the page pushes through the binding and what collect() returns at the end", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    page.push({ t: "status", mode: "observe", model: { state: "off", name: "none" } });
    page.push({ t: "record", record: { kind: "detection", diagnosis: "stale" } });
    page.push({ t: "witness", witness: { kind: "overwrote-newer" } });
    page.push({ t: "agent", ok: true, reason: null });
    page.push({ t: "nonsense" });
    page.push(null);
    page.evaluateResult = { mode: "observe", model: { state: "off", name: "none", version: "0" }, agent: null };
    const c = await session.finish();
    expect(page.evaluated).toHaveLength(1);
    expect(c).toEqual({ records: [{ kind: "detection", diagnosis: "stale" }], witnesses: [{ kind: "overwrote-newer" }], mode: "observe", model: { state: "off", name: "none", version: "0" }, agent: null, plans: [] });
  });

  it("a page that never started GenClass, or that is closed, or whose agent failed", async () => {
    const page = new FakePage();
    const session = await install(page, { runtimeDir, model: "skip", chaos: null });
    page.push({ t: "status", mode: null, model: null, error: "boom" });
    page.push({ t: "agent", ok: false, reason: "not-dev-host" });
    page.closed = true;
    const c = await session.finish();
    expect(page.evaluated).toEqual([]);
    expect(c).toMatchObject({ records: [], witnesses: [], mode: null, model: null, agent: "not-dev-host" });
    const failing = new FakePage();
    const s2 = await install(failing, { runtimeDir, model: "skip", chaos: null });
    failing.evaluate = async () => {
      throw new Error("Execution context was destroyed");
    };
    await expect(s2.finish()).resolves.toMatchObject({ agent: "not-loaded" });
  });
});

// The fixture entry (src/fixture.ts) without a browser: startGenClass on a fake page and a fake TestInfo. Inert when
// disabled; otherwise it installs, and at the end writes one genclass-races/1 file where the reporter reads it, named
// after the test, with the seed and chaos that produced it.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outDirOf, startGenClass, testName, type TestInfoLike } from "../src/fixture.js";
import type { PageLike } from "../src/install.js";
import { parseRaces } from "../src/schema.js";

class FakePage implements PageLike {
  routes: string[] = [];
  initScripts: string[] = [];
  exposed: string[] = [];
  evaluateResult: unknown = null;
  async route(pattern: string): Promise<void> {
    this.routes.push(pattern);
  }
  async addInitScript(s: { content: string }): Promise<void> {
    this.initScripts.push(s.content);
  }
  async exposeFunction(name: string): Promise<void> {
    this.exposed.push(name);
  }
  async evaluate(): Promise<unknown> {
    return this.evaluateResult;
  }
  isClosed(): boolean {
    return false;
  }
  untouched(): boolean {
    return this.routes.length === 0 && this.initScripts.length === 0 && this.exposed.length === 0;
  }
}

let root = "";
let runtimeDir = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-fixture-"));
  runtimeDir = join(root, "rt");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "genclass.global.js"), "/* build */\n");
  writeFileSync(join(runtimeDir, "agent.js"), "export function connectAgent() {}\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function info(over: Partial<TestInfoLike> = {}): TestInfoLike {
  return {
    titlePath: ["", "chromium", "checkout.spec.ts", "checkout", "places one order"],
    file: join(root, "tests", "checkout.spec.ts"),
    testId: "a1b2c3-d4e5f6",
    repeatEachIndex: 0,
    project: { name: "chromium", testDir: join(root, "tests") },
    config: { configFile: join(root, "playwright.config.ts"), rootDir: join(root, "tests") },
    ...over,
  };
}

describe("fixture: names and places", () => {
  it("testName: [project] file > describe > title; no project prefix without a project name; odd shapes still name the test", () => {
    expect(testName(info())).toBe("[chromium] checkout.spec.ts > checkout > places one order");
    expect(testName(info({ project: { name: "", testDir: join(root, "tests") }, titlePath: ["", "", "checkout.spec.ts", "checkout", "places one order"] }))).toBe("checkout.spec.ts > checkout > places one order");
    expect(testName(info({ titlePath: ["", "chromium", "sub/other.spec.ts", "t"], file: join(root, "tests", "sub", "other.spec.ts") }))).toBe("[chromium] sub/other.spec.ts > t");
    expect(testName(info({ titlePath: ["weird", "shape"], file: join(root, "tests", "x.spec.ts"), project: { name: "", testDir: join(root, "tests") } }))).toBe("weird > shape");
  });

  it("outDirOf: test-results/genclass next to the config by default; a relative outDir against it; an absolute one as is", () => {
    expect(outDirOf(info())).toBe(join(root, "test-results", "genclass"));
    expect(outDirOf(info(), "out/races")).toBe(join(root, "out", "races"));
    expect(outDirOf(info(), join(root, "abs"))).toBe(join(root, "abs"));
    expect(outDirOf(info({ config: { rootDir: join(root, "tests") } }))).toBe(join(root, "tests", "test-results", "genclass"));
  });
});

describe("fixture: startGenClass", () => {
  it("enabled false: the page is untouched and nothing is written", async () => {
    const page = new FakePage();
    const run = await startGenClass(page, { enabled: false, chaos: true, runtimeDir }, info());
    const r = await run.finish();
    expect(page.untouched()).toBe(true);
    expect(r).toEqual({ collected: null, file: null, path: null });
    expect(existsSync(join(root, "test-results"))).toBe(false);
  });

  it("refuses a mode other than observe and an unknown model value, before touching the page", async () => {
    const page = new FakePage();
    await expect(startGenClass(page, { mode: "guard" as unknown as "observe", runtimeDir }, info())).rejects.toThrow(/must be "observe"/);
    await expect(startGenClass(page, { model: "cdn" as unknown as "skip", runtimeDir }, info())).rejects.toThrow(/must be "skip" or "load"/);
    expect(page.untouched()).toBe(true);
  });

  it("writes one valid file per test, named after it, with the seed from the repeat index when there is no chaos", async () => {
    const page = new FakePage();
    page.evaluateResult = { mode: "observe", model: { state: "off", name: "none" }, agent: null };
    const run = await startGenClass(page, { runtimeDir }, info({ repeatEachIndex: 2 }));
    expect(page.initScripts).toHaveLength(1);
    const r = await run.finish();
    expect(r.path).toBe(join(root, "test-results", "genclass", "chromium-checkout-spec-ts-checkout-places-one-order-a1b2c3-d4e5f6-s3.json"));
    expect(readdirSync(join(root, "test-results", "genclass"))).toEqual(["chromium-checkout-spec-ts-checkout-places-one-order-a1b2c3-d4e5f6-s3.json"]);
    const parsed = parseRaces(readFileSync(r.path!, "utf8"));
    expect(parsed.ok && parsed.file).toEqual({
      schema: "genclass-races/1",
      test: "[chromium] checkout.spec.ts > checkout > places one order",
      seed: 3,
      signatures: [],
      mode: "observe",
      model: { state: "off", name: "none" },
      chaos: null,
    });
    expect(r.file).toEqual(parsed.ok && parsed.file);
  });

  it("with chaos: the seed is the chaos seed plus the repeat index, and the settings are in the file", async () => {
    const page = new FakePage();
    page.evaluateResult = { mode: "observe", model: { state: "off" }, agent: null };
    const run = await startGenClass(page, { runtimeDir, chaos: { seed: 10, delayMs: [100, 200], reorder: false, match: ["/api", /x/] }, outDir: "races" }, info({ repeatEachIndex: 1 }));
    expect(page.routes[0]).toBe("**/*");
    const r = await run.finish();
    expect(r.path).toBe(join(root, "races", "chromium-checkout-spec-ts-checkout-places-one-order-a1b2c3-d4e5f6-s11.json"));
    expect(r.file).toMatchObject({ seed: 11, chaos: { latencyMs: [100, 200], reorder: false, routes: ["/api", "/x/"] } });
    expect(parseRaces(readFileSync(r.path!, "utf8")).ok).toBe(true);
  });

  it("chaos true means the defaults", async () => {
    const page = new FakePage();
    const run = await startGenClass(page, { runtimeDir, chaos: true }, info());
    const r = await run.finish();
    expect(r.file).toMatchObject({ seed: 1, chaos: { latencyMs: [0, 600], reorder: true, routes: ["same-origin /api* or JSON responses"] }, model: null, signatures: [] });
  });
});

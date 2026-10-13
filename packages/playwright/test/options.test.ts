import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../src/constants.js";
import { DEFAULT_CHAOS, DEFAULT_HANDLES, DEFAULT_ROUTES, resolveChaos, resolveOptions, routePattern } from "../src/options.js";

describe("options: defaults", () => {
  it("fills the defaults: observe, inject, local runtime, default handles, no chaos", () => {
    const o = resolveOptions();
    expect(o.mode).toBe("observe");
    expect(o.install).toBe("inject");
    expect(o.runtime).toBe("local");
    expect(o.handle).toEqual([...DEFAULT_HANDLES]);
    expect(o.chaos).toBeNull();
    expect(o.config).toEqual({});
    expect(o.settle).toEqual({ quietMs: 1500, maxMs: 6000 });
    expect(o.attach).toBe(true);
    expect(o.annotate).toBe(true);
    expect(o.warnings).toEqual([]);
  });

  it("PACKAGE_VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it("never throws on bad options: corrects them and records a warning", () => {
    const o = resolveOptions({ mode: "turbo" as never, install: "maybe" as never, runtime: "" as never, config: [] as never, settle: { quietMs: -1, maxMs: "x" as never } });
    expect(o.mode).toBe("observe");
    expect(o.install).toBe("inject");
    expect(o.runtime).toBe("local");
    expect(o.config).toEqual({});
    expect(o.settle).toEqual({ quietMs: 1500, maxMs: 6000 });
    expect(o.warnings.length).toBe(4);
    expect(o.warnings.join("\n")).toMatch(/mode "turbo"/);
    expect(o.warnings.join("\n")).toMatch(/install "maybe"/);
  });

  it("the fixture owns config.mode and config.telemetry", () => {
    const o = resolveOptions({ mode: "guard", config: { mode: "heal", telemetry: true, model: { baseUrl: "/m/" } } });
    expect(o.mode).toBe("guard");
    expect(o.config).toEqual({ model: { baseUrl: "/m/" } });
    expect(o.warnings).toHaveLength(2);
  });

  it("settle.maxMs is never below quietMs", () => {
    expect(resolveOptions({ settle: { quietMs: 8000, maxMs: 1000 } }).settle).toEqual({ quietMs: 8000, maxMs: 8000 });
    expect(resolveOptions({ settle: { quietMs: 0, maxMs: 0 } }).settle).toEqual({ quietMs: 0, maxMs: 0 });
  });

  it("handles: the app's paths first, then the defaults, no duplicates, `window.` stripped", () => {
    expect(resolveOptions({ handle: "window.__demo.gc" }).handle).toEqual(["__demo.gc", "GenClass.runtime", "__genclass"]);
    expect(resolveOptions({ handle: ["__genclass", "app.rt"] }).handle).toEqual(["__genclass", "app.rt", "GenClass.runtime"]);
    const bad = resolveOptions({ handle: ["not a path", "ok.path", 3 as never] });
    expect(bad.handle).toEqual(["ok.path", "GenClass.runtime", "__genclass"]);
    expect(bad.warnings).toHaveLength(2);
  });
});

describe("options: chaos parsing", () => {
  const warn = () => {
    const w: string[] = [];
    return { w, fn: (s: string) => w.push(s) };
  };

  it("off by default, `true` is the documented preset", () => {
    expect(resolveChaos(undefined, () => {})).toBeNull();
    expect(resolveChaos(false, () => {})).toBeNull();
    const c = resolveChaos(true, () => {})!;
    expect(c.latencyMs).toEqual(DEFAULT_CHAOS.latencyMs);
    expect(c.reorder).toBe(true);
    expect(c.failRate).toBe(0.05);
    expect(c.failStatus).toBe(503);
    expect(c.routes).toEqual([...DEFAULT_ROUTES]);
    expect(c.seed).toBeNull();
  });

  it("the README example parses as written", () => {
    const { w, fn } = warn();
    const c = resolveChaos({ latencyMs: [50, 800], reorder: true, failRate: 0.05, routes: [/\/api\//] }, fn)!;
    expect(c).toEqual({ latencyMs: [50, 800], reorder: true, failRate: 0.05, failStatus: 503, routes: [/\/api\//], seed: null });
    expect(w).toEqual([]);
  });

  it("latencyMs: a number is a fixed delay; reversed or negative bounds are corrected with a warning", () => {
    expect(resolveChaos({ latencyMs: 120 }, () => {})!.latencyMs).toEqual([120, 120]);
    const { w, fn } = warn();
    expect(resolveChaos({ latencyMs: [800, 50] }, fn)!.latencyMs).toEqual([50, 800]);
    expect(resolveChaos({ latencyMs: [-5, 10] }, fn)!.latencyMs).toEqual([0, 10]);
    expect(resolveChaos({ latencyMs: -3 }, fn)!.latencyMs).toEqual([0, 0]);
    expect(resolveChaos({ latencyMs: "slow" as never }, fn)!.latencyMs).toEqual([0, 0]);
    expect(w).toHaveLength(4);
  });

  it("failRate is clamped to [0, 1]; failStatus must be 4xx/5xx", () => {
    const { w, fn } = warn();
    expect(resolveChaos({ failRate: 1.5 }, fn)!.failRate).toBe(1);
    expect(resolveChaos({ failRate: -1 }, fn)!.failRate).toBe(0);
    expect(resolveChaos({ failRate: "x" as never }, fn)!.failRate).toBe(0);
    expect(resolveChaos({ failStatus: 500 }, fn)!.failStatus).toBe(500);
    expect(resolveChaos({ failStatus: 200 }, fn)!.failStatus).toBe(503);
    expect(w).toHaveLength(4);
  });

  it("routes: strings are `*` globs, RegExps pass through, junk is dropped, empty falls back to the default", () => {
    expect(routePattern("**/api/**")!.test("http://localhost:3000/api/items?x=1")).toBe(true);
    expect(routePattern("/graphql")!.test("http://localhost/graphql")).toBe(true);
    expect(routePattern("/v1/users/*/orders")!.test("http://h/v1/users/42/orders")).toBe(true);
    expect(routePattern("/v1/users/*/orders")!.test("http://h/v1/users")).toBe(false);
    expect(routePattern("a.b")!.test("http://h/axb")).toBe(false);
    const { w, fn } = warn();
    const c = resolveChaos({ routes: ["/api/*", /graphql/, 42 as never] }, fn)!;
    expect(c.routes).toHaveLength(2);
    expect(w).toHaveLength(1);
    expect(resolveChaos({ routes: [] }, fn)!.routes).toEqual([...DEFAULT_ROUTES]);
    expect(resolveChaos({ routes: "x" as never }, fn)!.routes).toEqual([...DEFAULT_ROUTES]);
  });

  it("seed: a number or a non-empty string", () => {
    expect(resolveChaos({ seed: 7 }, () => {})!.seed).toBe(7);
    expect(resolveChaos({ seed: "run-1" }, () => {})!.seed).toBe("run-1");
    const { w, fn } = warn();
    expect(resolveChaos({ seed: "" }, fn)!.seed).toBeNull();
    expect(w).toHaveLength(1);
  });

  it("a non-object chaos value is off, with a warning", () => {
    const { w, fn } = warn();
    expect(resolveChaos("lots" as never, fn)).toBeNull();
    expect(w).toHaveLength(1);
  });
});

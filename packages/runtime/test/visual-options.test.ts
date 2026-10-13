// InitOptions.visual: how the first-load stub resolves it and when it downloads the chunk (docs/runtime/VISUAL.md
// sections 7 and 8; src/visual/start.ts). Off means nothing at all; "local" is the GenClass.init() default and turns
// on only on development hosts (or through ?genclass-visual=on, the overlay, checkNow()); the chunk loads 1.5 s after
// `load` (6.5 s at most) and never while `enabled` is false or pending.
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, GenClass } from "../src/index.js";
import { fromPairs, parsePairs } from "../src/cdn/config.js";
import type { RuntimeImpl } from "../src/runtime.js";
import type { CreateOptions } from "../src/types.js";
import { startVisual } from "../src/visual/start.js";
import { visualRegistry } from "../src/visual/registry.js";
import type { VisualChunk } from "../src/visual/host.js";
import { drain, FakeClock } from "./helpers.js";

const OFF = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false };

function fakeWindow(o: { host?: string; search?: string; ready?: "loading" | "complete" } = {}) {
  const win = new Map<string, Set<() => void>>();
  const doc: string[] = [];
  const host = o.host ?? "localhost";
  return {
    docListeners: doc,
    fire: (t: string) => [...(win.get(t) ?? [])].forEach((f) => f()),
    g: {
      document: {
        readyState: o.ready ?? "complete",
        visibilityState: "visible",
        title: "Fixture",
        addEventListener: (t: string) => void doc.push(t),
        removeEventListener: (t: string) => {
          const i = doc.indexOf(t);
          if (i >= 0) doc.splice(i, 1);
        },
      },
      location: { hostname: host, search: o.search ?? "", pathname: "/", href: `http://${host}/${o.search ?? ""}` },
      addEventListener: (t: string, fn: () => void) => {
        if (!win.has(t)) win.set(t, new Set());
        win.get(t)!.add(fn);
      },
      removeEventListener: (t: string, fn: () => void) => void win.get(t)?.delete(fn),
      console: { warn: () => undefined, info: () => undefined, log: () => undefined },
    } as Record<string, unknown>,
  };
}

let loads = 0;
function fakeChunk(): void {
  loads = 0;
  visualRegistry.loader = () => {
    loads++;
    return Promise.resolve({ startVisual: () => ({ now: () => Promise.resolve([]), summary: () => null, gateFixes: () => undefined, stop: () => undefined }) } as unknown as VisualChunk);
  };
}

const rts: RuntimeImpl[] = [];
function runtime(w: ReturnType<typeof fakeWindow>, o: Partial<CreateOptions> = {}, clock = new FakeClock()): { rt: RuntimeImpl; clock: FakeClock } {
  const rt = createRuntime({ clock, global: w.g, observe: OFF, decider: null, report: "silent", ...o }) as RuntimeImpl;
  rts.push(rt);
  return { rt, clock };
}

afterEach(() => {
  for (const rt of rts.splice(0)) rt.destroy();
  delete visualRegistry.loader;
});

describe("InitOptions.visual resolution (VISUAL.md 7)", () => {
  it("off, unset in createRuntime(), ?genclass-visual=off: no stub, no listener, no timer", () => {
    for (const [o, search] of [
      [{ visual: false }, ""],
      [{}, ""],
      [{ visual: true }, "?genclass-visual=off"],
      [{ visual: { on: true, fix: true } }, "?genclass-visual=off"],
    ] as const) {
      const w = fakeWindow({ search });
      const { rt, clock } = runtime(w, o as Partial<CreateOptions>);
      expect(rt.vis).toBeNull();
      expect(w.docListeners).not.toContain("securitypolicyviolation");
      expect(clock.pending).toBe(0);
    }
  });

  it("enabled: false installs nothing", () => {
    const w = fakeWindow();
    const { rt } = runtime(w, { visual: true, enabled: false });
    expect(rt.vis).toBeNull();
  });

  it("true is on everywhere; the GenClass.init default 'local' is on for development hosts only", () => {
    expect(runtime(fakeWindow({ host: "shop.example.com" }), { visual: true }).rt.vis?.setting).toBe("on");
    const pub = runtime(fakeWindow({ host: "shop.example.com" })).rt;
    expect(startVisual(pub, undefined, true)?.setting).toBe("local");
    for (const host of ["localhost", "127.0.0.1", "app.test", "192.168.1.20"]) expect(startVisual(runtime(fakeWindow({ host })).rt, undefined, true)?.setting, host).toBe("on");
    // ?genclass-visual=on turns report-only checks on for a public host
    expect(startVisual(runtime(fakeWindow({ host: "shop.example.com", search: "?genclass-visual=on" })).rt, undefined, true)?.setting).toBe("on");
    // an app's explicit false wins over the URL
    expect(startVisual(runtime(fakeWindow({ search: "?genclass-visual=on" })).rt, false, true)).toBeNull();
  });

  it("a headless global (no document) never starts", () => {
    const { rt } = runtime({ docListeners: [], fire: () => undefined, g: { location: { hostname: "localhost" } } });
    expect(startVisual(rt, true, true)).toBeNull();
  });

  it("the page config key: on, off, local, fix", () => {
    expect(fromPairs(parsePairs("visual=off")).visual).toBe(false);
    expect(fromPairs(parsePairs("visual=on")).visual).toBe(true);
    expect(fromPairs(parsePairs("visual")).visual).toBe(true);
    expect(fromPairs(parsePairs("visual=local")).visual).toBe("local");
    expect(fromPairs(parsePairs("visual=fix")).visual).toEqual({ on: true, fix: true });
    expect(fromPairs(parsePairs("mode=guard")).visual).toBeUndefined();
  });

  it("in Node, GenClass.init({ visual: true }) starts nothing", () => {
    const rt = GenClass.init({ visual: true, telemetry: false, model: false }) as RuntimeImpl;
    try {
      expect(rt.vis).toBeNull();
      expect(rt.checks()).toEqual([]);
    } finally {
      GenClass.destroy();
    }
  });
});

describe("when the chunk loads (VISUAL.md 8 steps 1 to 3)", () => {
  it("1.5 s after load, never before; the CSP buffer starts at init", async () => {
    fakeChunk();
    const w = fakeWindow({ ready: "loading" });
    const { rt, clock } = runtime(w, { visual: true });
    expect(w.docListeners).toContain("securitypolicyviolation");
    await clock.advance(4000);
    expect(loads).toBe(0);
    w.fire("load");
    await clock.advance(1499);
    expect(loads).toBe(0);
    await clock.advance(1);
    await drain();
    expect(loads).toBe(1);
    expect(rt.vis?.c).toBeTruthy();
    await clock.advance(10_000);
    expect(loads).toBe(1); // the 6.5 s cap finds it loaded: one download
  });

  it("a load event held up by a slow request: at most 6.5 s", async () => {
    fakeChunk();
    const w = fakeWindow({ ready: "loading" });
    const { clock } = runtime(w, { visual: true });
    await clock.advance(6499);
    expect(loads).toBe(0);
    await clock.advance(1);
    await drain();
    expect(loads).toBe(1);
  });

  it("enabled pending: no download until it turns on", async () => {
    fakeChunk();
    let open: (v: boolean) => void = () => undefined;
    const w = fakeWindow();
    const { clock } = runtime(w, { visual: true, enabled: () => new Promise<boolean>((r) => (open = r)) });
    await clock.advance(10_000);
    expect(loads).toBe(0);
    open(true);
    await drain();
    await clock.advance(5000);
    await drain();
    expect(loads).toBe(1);
  });

  it("destroyed before it loads: no download, the CSP listener is removed", async () => {
    fakeChunk();
    const w = fakeWindow();
    const { rt, clock } = runtime(w, { visual: true });
    rt.destroy();
    await clock.advance(10_000);
    await drain();
    expect(loads).toBe(0);
    expect(w.docListeners).not.toContain("securitypolicyviolation");
  });

  it("'local' on a public host loads only on demand: checkNow() or the overlay", async () => {
    fakeChunk();
    const w = fakeWindow({ host: "shop.example.com" });
    const { rt, clock } = runtime(w);
    rt.vis = startVisual(rt, undefined, true);
    expect(w.docListeners).not.toContain("securitypolicyviolation");
    await clock.advance(10_000);
    expect(loads).toBe(0);
    expect(await rt.checkNow()).toEqual([]);
    expect(loads).toBe(1);
  });

  it("off: checks() is empty and checkNow() resolves to an empty list without a download", async () => {
    fakeChunk();
    const { rt } = runtime(fakeWindow(), { visual: false });
    expect(rt.checks()).toEqual([]);
    expect(await rt.checkNow()).toEqual([]);
    expect(loads).toBe(0);
  });
});

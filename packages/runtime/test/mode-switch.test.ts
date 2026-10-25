// The URL and localStorage switches (CONTRACT §2 kill switch and §13; THREAT-MODEL T8). `?genclass=` and
// localStorage.genclass may only lower the app's mode (observe when it sets none), except on a development host
// (src/devhost.ts: a dev server's port on a loopback name, or *.test). `?genclass-mode=`, `?genclass-aggr=` and
// `?genclass-sample=` only lower, on every host. `debug: true` is console logging only: it never lets a link raise
// anything. Lowering works on every host.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GenClass, createRuntime } from "../src/index.js";
import type { ObserverName, Runtime } from "../src/types.js";
import { setup } from "./helpers.js";

const g = globalThis as unknown as Record<string, unknown>;
const opts = { model: false as const, report: "silent" as const, telemetry: false as const, observe: { fetch: false, timers: false } };
const OFF: Record<ObserverName, boolean> = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false };
/** A location stub with every field the runtime reads, from a real URL. */
const loc = (href: string) => {
  const u = new URL(href);
  return { href, search: u.search, hostname: u.hostname, protocol: u.protocol, port: u.port, pathname: u.pathname };
};
/** localStorage.genclass (Node 22+ defines its own localStorage, so it is stubbed in every test). */
const stubLs = (v: string | null) => vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "genclass" ? v : null), setItem: () => undefined, removeItem: () => undefined });
const made: Runtime[] = [];
/** createRuntime (not GenClass.init) on its own global, nothing observed. */
const bare = (href: string, o: Parameters<typeof createRuntime>[0] = {}) => {
  const rt = createRuntime({ report: "silent", decider: null, observe: OFF, telemetry: false, global: { location: loc(href) }, ...o });
  made.push(rt);
  return rt;
};

beforeEach(() => stubLs(null));
afterEach(() => {
  GenClass.destroy();
  for (const rt of made.splice(0)) rt.destroy();
  delete g.location;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("URL and localStorage switches only lower the mode, debug or not (CONTRACT §2 kill switch, §13; THREAT-MODEL T8)", () => {
  it("debug: true does not let ?genclass= raise a production host", () => {
    g.location = loc("https://shop.example/?genclass=heal");
    expect(GenClass.init({ ...opts, debug: true }).mode).toBe("observe");
    GenClass.destroy();
    expect(GenClass.init({ ...opts, mode: "guard", debug: true }).mode).toBe("guard");
    GenClass.destroy();
    g.location = loc("https://shop.example/?genclass=guard");
    expect(GenClass.init({ ...opts, debug: true }).mode).toBe("observe");
  });

  it("debug: true does not let localStorage.genclass raise a production host", () => {
    stubLs("heal");
    g.location = loc("https://shop.example/");
    expect(GenClass.init({ ...opts, debug: true }).mode).toBe("observe");
    GenClass.destroy();
    expect(GenClass.init({ ...opts, mode: "guard", debug: true }).mode).toBe("guard");
  });

  it("debug: true does not let ?genclass-mode= raise, through GenClass.init or createRuntime", () => {
    g.location = loc("https://shop.example/?genclass-mode=heal");
    expect(GenClass.init({ ...opts, debug: true }).mode).toBe("observe");
    GenClass.destroy();
    expect(GenClass.init({ ...opts, mode: "observe", debug: true }).mode).toBe("observe");
    GenClass.destroy();
    expect(GenClass.init({ ...opts, mode: "guard", debug: true }).mode).toBe("guard");
    expect(bare("https://shop.example/?genclass-mode=heal", { debug: true }).mode).toBe("observe");
    expect(bare("https://shop.example/?genclass-mode=guard", { debug: true }).mode).toBe("observe");
  });

  it("debug: true does not undo a lowering link: ?genclass=observe&genclass-mode=heal over heal stays observe", () => {
    g.location = loc("https://shop.example/?genclass=observe&genclass-mode=heal");
    expect(GenClass.init({ ...opts, mode: "heal", debug: true }).mode).toBe("observe");
  });

  it("debug: true does not let ?genclass-aggr= raise the aggressiveness", () => {
    const { rt } = setup({ aggressiveness: "cautious", debug: true, extraGlobal: { location: loc("https://shop.example/?genclass-aggr=eager") } });
    expect(rt.aggressiveness).toBe(0);
    const b = setup({ debug: true, extraGlobal: { location: loc("https://shop.example/?genclass-aggr=eager") } });
    expect(b.rt.aggressiveness).toBe(0.5); // the "balanced" default, not eager
  });

  it("debug: true does not let ?genclass-sample=1 lift sample: 0 into the acting cohort", () => {
    const { rt } = setup({ mode: "guard", sample: 0, debug: true, extraGlobal: { location: loc("https://shop.example/?genclass-sample=1") } });
    expect(rt.status.sampled).toBe(false);
    expect(rt.status.effectiveMode).toBe("observe");
    expect(rt.mode).toBe("guard"); // the configured mode is kept; sampling caps what it does
  });

  it("?genclass-mode=, ?genclass-aggr= and ?genclass-sample=1 do not raise on a development host either", () => {
    expect(bare("http://localhost:5173/?genclass-mode=guard").mode).toBe("observe");
    expect(bare("http://localhost:5173/?genclass-mode=heal", { mode: "guard", debug: true }).mode).toBe("guard");
    expect(setup({ aggressiveness: "cautious", extraGlobal: { location: loc("http://localhost:5173/?genclass-aggr=eager") } }).rt.aggressiveness).toBe(0);
    const s = setup({ mode: "guard", sample: 0, extraGlobal: { location: loc("http://localhost:5173/?genclass-sample=1") } }).rt.status;
    expect([s.sampled, s.effectiveMode]).toEqual([false, "observe"]);
  });

  // production for some apps: a bare intranet name, private addresses (even with a dev server's port), Capacitor
  // (https://localhost), port 80 on localhost, Tauri on Windows, *.internal, *.local, Electron (file:). Then
  // look-alikes that pin each part of devHost (src/devhost.ts), through the call in GenClass.init: a "test" label that
  // is not the last one (the `$` in `\.test$`), a loopback name followed by more labels (the `$` after the loopback
  // names), 127.0.0.1 and [::1] without a port (the port rule), and a loopback name with a port under a scheme other
  // than http(s) (the protocol check)
  it.each([
    "http://intranet/",
    "https://10.1.2.3/",
    "http://192.168.1.5:5173/",
    "https://localhost/",
    "http://localhost/",
    "https://tauri.localhost/",
    "https://app.internal/",
    "http://printer.local/",
    "http://myapp.local:8080/",
    "file:///app/index.html",
    "https://app.testrail.io/",
    "https://shop.test.example.com/",
    "http://localhost.example.com:8080/",
    "http://127.0.0.1.nip.io:8080/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "capacitor://localhost:8100/",
  ])("%s only looks local: ?genclass=heal does not raise it", (href) => {
    g.location = loc(`${href}?genclass=heal`);
    expect(GenClass.init(opts).mode).toBe("observe");
    GenClass.destroy();
    expect(GenClass.init({ ...opts, mode: "guard" }).mode).toBe("guard");
    GenClass.destroy();
    stubLs("heal");
    g.location = loc(href);
    expect(GenClass.init(opts).mode).toBe("observe");
  });

  it("a development host still raises with ?genclass= and localStorage.genclass, with or without debug", () => {
    for (const base of ["http://localhost:5173/", "http://127.0.0.1:3000/", "http://[::1]:3000/", "http://app.localhost:3000/", "http://app.test/", "https://shop.test:8443/"]) {
      g.location = loc(`${base}?genclass=guard`);
      expect(GenClass.init(opts).mode, base).toBe("guard");
      GenClass.destroy();
      g.location = loc(`${base}?genclass=heal`);
      expect(GenClass.init({ ...opts, mode: "guard", debug: true }).mode, base).toBe("heal");
      GenClass.destroy();
    }
    stubLs("heal");
    g.location = loc("http://localhost:5173/");
    expect(GenClass.init({ ...opts, debug: true }).mode).toBe("heal");
  });

  it("lowering works on every host, debug or not", () => {
    for (const base of ["https://shop.example/", "http://localhost:5173/", "http://intranet/", "https://localhost/"]) {
      g.location = loc(`${base}?genclass=observe`);
      expect(GenClass.init({ ...opts, mode: "heal", debug: true }).mode, base).toBe("observe");
      GenClass.destroy();
      g.location = loc(`${base}?genclass=guard`);
      expect(GenClass.init({ ...opts, mode: "heal" }).mode, base).toBe("guard");
      GenClass.destroy();
      g.location = loc(`${base}?genclass-mode=observe`);
      expect(GenClass.init({ ...opts, mode: "heal", debug: true }).mode, base).toBe("observe");
      GenClass.destroy();
      expect(bare(`${base}?genclass-mode=guard`, { mode: "heal" }).mode, base).toBe("guard");
      expect(setup({ aggressiveness: "eager", debug: true, extraGlobal: { location: loc(`${base}?genclass-aggr=cautious`) } }).rt.aggressiveness, base).toBe(0);
      const s = setup({ mode: "guard", debug: true, extraGlobal: { location: loc(`${base}?genclass-sample=0`) } }).rt.status;
      expect([s.sampled, s.effectiveMode], base).toEqual([false, "observe"]);
    }
    // without the URL switch the same options act (so the cases above are the switch, not the setup)
    const s = setup({ mode: "guard", extraGlobal: { location: loc("https://shop.example/") } }).rt.status;
    expect([s.sampled, s.effectiveMode]).toEqual([true, "guard"]);
    expect(setup({ aggressiveness: "eager", extraGlobal: { location: loc("https://shop.example/") } }).rt.aggressiveness).toBe(1);
  });

  it("localStorage.genclass lowers on a production host; observe and off", () => {
    stubLs("observe");
    g.location = loc("https://shop.example/");
    expect(GenClass.init({ ...opts, mode: "heal", debug: true }).mode).toBe("observe");
    GenClass.destroy();
    stubLs("off");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const native = g.fetch;
    const rt = GenClass.init({ ...opts, mode: "heal", debug: true });
    expect(g.fetch).toBe(native);
    expect(rt.mode).toBe("observe");
    expect(String(info.mock.calls[0]?.[0])).toMatch(/Disabled by \?genclass=off/);
  });

  it("?genclass=off installs nothing on a production host with debug and mode heal", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    g.location = loc("https://shop.example/?genclass=off");
    const native = g.fetch;
    const rt = GenClass.init({ model: false, mode: "heal", debug: true });
    expect(g.fetch).toBe(native);
    expect(rt.mode).toBe("observe");
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/Disabled by \?genclass=off/);
  });

  it("debug still logs every decision to console.debug", async () => {
    const dbg = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { clock, server, fetch } = setup({ debug: true, triage: "always", extraGlobal: { location: loc("https://shop.example/") } });
    server.on("GET", "/api/x", { body: 1, latency: 5 });
    const p = fetch("/api/x");
    await clock.advance(5);
    await p;
    await clock.flush();
    expect(dbg.mock.calls.some((c) => /^\[GenClass\] decision /.test(String(c[0])))).toBe(true);
  });
});

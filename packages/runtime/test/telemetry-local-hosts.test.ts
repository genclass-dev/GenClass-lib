// GenClass.init's default telemetry on local and private hosts (TELEMETRY.md "When it is on"): off unless the app
// opts in explicitly. 0.2.1 and 0.2.2 passed `telemetry: true` to createRuntime internally, which reads as an explicit
// opt-in and skips the local-host check, so GenClass.init(), /auto and the script tag sent diagnostics from localhost.
// An unset option must stay unset. Telemetry here goes to a stubbed fetch; nothing reaches the network.

import { afterEach, describe, expect, it, vi } from "vitest";

const QUIET = {
  model: false as const,
  report: "silent" as const,
  observe: { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false },
};

const at = (hostname: string) => ({ hostname, search: "", href: `http://${hostname}/`, pathname: "/" });

/** A fresh copy of the library in a fake browser page on `hostname`. */
async function browserPage(hostname: string) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 202 }))));
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  vi.stubGlobal("location", at(hostname));
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const m = await import("../src/index.js");
  m.GenClass.destroy();
  return { m, info };
}

describe("telemetry: GenClass.init on local and private hosts (TELEMETRY.md, When it is on)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("the default stays off on localhost, loopback, *.local, *.test and private networks, with no console notice", async () => {
    const { m, info } = await browserPage("localhost");
    for (const h of ["localhost", "127.0.0.1", "app.localhost", "mac.local", "shop.test", "192.168.1.20", "10.0.0.5"]) {
      vi.stubGlobal("location", at(h));
      const rt = m.GenClass.init(QUIET);
      expect(rt.telemetry, h).toMatchObject({ enabled: false, reason: "local" });
      m.GenClass.destroy();
    }
    expect(info.mock.calls.filter((c) => c[0] === m.TELEMETRY_NOTICE)).toHaveLength(0);
  });

  it("an explicit telemetry: true still sends from a local host; a public host is on by default", async () => {
    const { m, info } = await browserPage("localhost");
    const optedIn = m.GenClass.init({ ...QUIET, telemetry: true });
    expect(optedIn.telemetry?.enabled).toBe(true);
    m.GenClass.destroy();
    vi.stubGlobal("location", at("shop.example"));
    const pub = m.GenClass.init(QUIET);
    expect(pub.telemetry?.enabled).toBe(true);
    expect(info.mock.calls.filter((c) => c[0] === m.TELEMETRY_NOTICE)).toHaveLength(1);
    m.GenClass.destroy();
  });

  it("explicit opt-outs keep their own reasons on a public host", async () => {
    const { m } = await browserPage("shop.example");
    expect(m.GenClass.init({ ...QUIET, telemetry: false }).telemetry).toMatchObject({ enabled: false, reason: "option" });
    m.GenClass.destroy();
    vi.stubGlobal("location", { ...at("shop.example"), search: "?genclass=no-telemetry" });
    expect(m.GenClass.init(QUIET).telemetry).toMatchObject({ enabled: false, reason: "url" });
    m.GenClass.destroy();
  });
});

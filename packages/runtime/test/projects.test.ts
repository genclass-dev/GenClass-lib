// App tokens, dashboards and protect() (README "Your dashboard", "Function-specific"): the token from every config
// source, invalid tokens, the telemetry envelope's `token`, `fn` on decisions, protect() semantics and
// InitOptions.scope "functions". Telemetry is only on where a test injects a recording transport.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GenClass, createRuntime, isValidToken, protect, TOKEN_PATTERN } from "../src/index.js";
import { fromDataset, fromPairs, mergeConfig, parsePairs, readMetaConfig, readWindowConfig } from "../src/cdn/config.js";
import { setProtectResolver } from "../src/protect.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { resetTelemetryNotice } from "../src/telemetry/index.js";
import { fnLabel } from "../src/telemetry/client.js";
import { TELEMETRY_NOTICE, TELEMETRY_TOKEN_NOTICE } from "../src/telemetry/config.js";
import type { Answer, EvaluateRequest, TelemetryTransport } from "../src/types.js";
import { defaultScript, setup, type Setup } from "./helpers.js";

const TOKEN = "gc_AbCdEfGhIjKlMnOpQrStUv";

interface Sent {
  body: Record<string, unknown> & { events: Record<string, unknown>[] };
}
function recorder(): TelemetryTransport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send(_url, body) {
      sent.push({ body: JSON.parse(body) });
      return Promise.resolve();
    },
  };
}

afterEach(() => {
  setProtectResolver(() => (GenClass.runtime as RuntimeImpl | null) ?? null);
  GenClass.destroy();
  vi.restoreAllMocks();
});

describe("token format", () => {
  it("gc_ + 22 base62 characters", () => {
    expect(TOKEN_PATTERN.source).toBe("^gc_[A-Za-z0-9]{22}$");
    expect(isValidToken(TOKEN)).toBe(true);
    for (const bad of ["", "gc_", "gc_short", `${TOKEN}x`, TOKEN.replace("gc_", "GC_"), "gc_AbCdEfGhIjKlMnOpQrSt-v", 42, null]) expect(isValidToken(bad)).toBe(false);
  });
});

describe("token from every config source", () => {
  it("meta tag, data attributes, window.GENCLASS_CONFIG and GenClass.init options", () => {
    expect(fromPairs(parsePairs(`token=${TOKEN}, mode=observe`))).toEqual({ token: TOKEN, mode: "observe" });
    const doc = { querySelectorAll: () => [{ getAttribute: () => `token=${TOKEN}` }] };
    expect(readMetaConfig(doc).token).toBe(TOKEN);
    expect(fromDataset({ token: TOKEN, devtools: "local" }).token).toBe(TOKEN);
    expect(readWindowConfig({ GENCLASS_CONFIG: { token: TOKEN, scope: "functions" } })).toEqual({ token: TOKEN, scope: "functions" });
    // window config wins over the meta tag, as for every other key
    expect(mergeConfig(fromPairs({ token: "gc_metametametametametameta" }), { token: TOKEN }).token).toBe(TOKEN);
    expect(fromPairs(parsePairs("scope=functions")).scope).toBe("functions");
    expect(fromPairs(parsePairs("scope=everything")).scope).toBeUndefined();
  });

  it("a valid token goes on every batch envelope (top-level `token`); runtime.telemetry.token reports it", async () => {
    const transport = recorder();
    const s = setup({ token: TOKEN, telemetry: { transport }, extraGlobal: { crypto: globalThis.crypto } });
    expect(s.rt.telemetry?.token).toBe(TOKEN);
    await s.rt.telemetry!.flush();
    expect(transport.sent.length).toBeGreaterThan(0);
    for (const b of transport.sent) {
      expect(b.body.token).toBe(TOKEN);
      expect(b.body.schema).toBe("genclass-telemetry/1");
    }
    // never inside an event
    expect(JSON.stringify(transport.sent.flatMap((b) => b.body.events))).not.toContain(TOKEN);
    s.rt.destroy();
  });

  it("no token: the envelope has no `token` key", async () => {
    const transport = recorder();
    const s = setup({ telemetry: { transport }, extraGlobal: { crypto: globalThis.crypto } });
    await s.rt.telemetry!.flush();
    expect(transport.sent.length).toBeGreaterThan(0);
    for (const b of transport.sent) expect("token" in b.body).toBe(false);
    s.rt.destroy();
  });

  it("an invalid token: one console warning, ignored, never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transport = recorder();
    const s = setup({ token: "gc_tooShort", telemetry: { transport }, extraGlobal: { crypto: globalThis.crypto, console } });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("Ignoring token"))).toHaveLength(1);
    expect(s.rt.telemetry?.token).toBeUndefined();
    await s.rt.telemetry!.flush();
    for (const b of transport.sent) expect("token" in b.body).toBe(false);
    s.rt.destroy();
    expect(() => createRuntime({ token: 12 as unknown as string, report: "silent", observe: {} })).not.toThrow();
  });

  it("GenClass.init({ token }) with telemetry off: nothing is sent; one info line in debug only", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const quiet = createRuntime({ token: TOKEN, report: "silent", observe: {} });
    expect(quiet.telemetry).toMatchObject({ enabled: false });
    expect(info).not.toHaveBeenCalled();
    const loud = createRuntime({ token: TOKEN, debug: true, report: "silent", observe: {}, telemetry: false });
    expect(info.mock.calls.filter((c) => String(c[0]).includes("telemetry is off"))).toHaveLength(1);
    quiet.destroy();
    loud.destroy();
  });

  it("with a token, the one console notice also says the diagnostics feed the app's dashboard", async () => {
    resetTelemetryNotice();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const s = setup({ token: TOKEN, telemetry: { transport: recorder() }, extraGlobal: { crypto: globalThis.crypto, console } });
    const notices = () => info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(TELEMETRY_NOTICE));
    expect(notices()).toEqual([`${TELEMETRY_NOTICE} ${TELEMETRY_TOKEN_NOTICE}`]);
    s.rt.destroy();
    resetTelemetryNotice();
    const s2 = setup({ telemetry: { transport: recorder() }, extraGlobal: { crypto: globalThis.crypto, console } });
    expect(notices()).toEqual([`${TELEMETRY_NOTICE} ${TELEMETRY_TOKEN_NOTICE}`, TELEMETRY_NOTICE]);
    s2.rt.destroy();
  });

  it("opt-outs still win over a token (GPC)", () => {
    resetTelemetryNotice();
    const s = setup({ token: TOKEN, telemetry: { transport: recorder() }, extraGlobal: { crypto: globalThis.crypto, navigator: { globalPrivacyControl: true } } });
    expect(s.rt.telemetry).toMatchObject({ enabled: false, reason: "gpc" });
    s.rt.destroy();
  });
});

// ------------------------------------------------------------------------------------------------ protect()

describe("protect(): same function, tracked", () => {
  it("without a runtime it calls fn directly (this, args, return value, throws)", () => {
    setProtectResolver(() => null);
    const obj = {
      k: 2,
      mul: protect("mul", function (this: { k: number }, a: number, b: number) {
        return this.k * a * b;
      }),
    };
    expect(obj.mul(3, 4)).toBe(24);
    const boom = protect("boom", () => {
      throw new RangeError("nope");
    });
    expect(() => boom()).toThrow(RangeError);
    expect(GenClass.protect).toBe(protect);
  });

  it("keeps name and length; bad arguments warn and never throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    function submitOrder(_a: number, _b: string) {
      return 1;
    }
    const p = protect("checkout", submitOrder);
    expect(p.name).toBe("submitOrder");
    expect(p.length).toBe(2);
    expect(() => protect("x", undefined as unknown as () => void)).not.toThrow();
    expect(protect("", submitOrder)(1, "a")).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("with a runtime: sync stays sync, async stays async, `this`, args, results and errors pass through", async () => {
    const s = setup();
    setProtectResolver(() => s.rt);
    const self = { base: 10 };
    const sync = protect("sync", function (this: typeof self, x: number) {
      return this.base + x;
    });
    expect(sync.call(self, 5)).toBe(15);
    const asyncFn = protect("async", async (x: number) => x * 2);
    const r = asyncFn(21);
    expect(r).toBeInstanceOf(Promise);
    await expect(r).resolves.toBe(42);
    const throwsSync = protect("throws", () => {
      throw new TypeError("sync boom");
    });
    expect(() => throwsSync()).toThrow("sync boom");
    const rejects = protect("rejects", async () => {
      throw new Error("async boom");
    });
    await expect(rejects()).rejects.toThrow("async boom");
    // other thenables come back untouched (never .then()-ed by GenClass)
    const thenable = { then: vi.fn() };
    expect(protect("q", () => thenable)()).toBe(thenable);
    expect(thenable.then).not.toHaveBeenCalled();
    // each call is a task op named after the function
    const names = s.rt.history().filter((e) => e.kind === "op.start").map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["sync", "async", "throws", "rejects", "q"]));
    s.rt.destroy();
  });

  it("a destroyed runtime: fn is called directly", () => {
    const s = setup();
    setProtectResolver(() => s.rt);
    s.rt.destroy();
    expect(protect("after", (a: number) => a + 1)(1)).toBe(2);
  });

  it("decisions about what a protected call caused carry fn (also in telemetry, with a token); others do not", async () => {
    const transport = recorder();
    const s = setup({ token: TOKEN, triage: "always", telemetry: { transport }, extraGlobal: { crypto: globalThis.crypto }, script: defaultScript({ failure: { diagnosis: "transient" } }) });
    setProtectResolver(() => s.rt);
    s.server.on("POST", "/api/orders", { status: 500, body: {}, latency: 20 });
    s.server.on("GET", "/api/feed", { status: 500, body: {}, latency: 20 });
    // outer wraps inner: the outermost protected function names the decision
    const inner = protect("inner", async () => {
      await s.fetch("/api/orders", { method: "POST", body: "{}" }).catch(() => undefined);
    });
    const outer = protect("checkout submit", () => inner());
    void outer();
    void s.fetch("/api/feed").catch(() => undefined);
    await s.clock.advance(2000);
    const ds = s.rt.decisions().filter((d) => d.trigger === "failure");
    expect(ds).toHaveLength(2);
    const orders = ds.find((d) => d.subject.includes("/api/orders"))!;
    const feed = ds.find((d) => d.subject.includes("/api/feed"))!;
    expect(orders.fn).toBe("checkout submit");
    expect(feed.fn).toBeUndefined();
    await s.rt.telemetry!.flush();
    const evs = transport.sent.flatMap((b) => b.body.events).filter((e) => e.t === "decision" && e.trigger === "failure");
    expect(evs.map((e) => e.fn).sort()).toEqual(["checkout submit", undefined]);
    s.rt.destroy();
  });
});

describe("protect(): a label that looks like data is redacted in telemetry (TELEMETRY.md, App tokens)", () => {
  it("static names pass; e-mail addresses, URLs, 4+ digit runs and long hex ids are sent as [redacted]", () => {
    for (const ok of ["checkout submit", "cart save", "search v2", "Send invoice", "x".repeat(80)]) expect(fnLabel(ok)).toBe(ok);
    expect(fnLabel("y".repeat(90))).toBe("y".repeat(80));
    for (const bad of ["save jane@example.com", "load https://api.example.com/x", "order 10423", "card 4242 4242 4242 4242", "user 3f2a9c1e7b4d40aa"]) expect(fnLabel(bad), bad).toBe("[redacted]");
    expect(fnLabel(undefined)).toBeUndefined();
  });

  it("the Decision keeps the full label; the telemetry event carries [redacted]", async () => {
    const transport = recorder();
    const s = setup({ token: TOKEN, triage: "always", telemetry: { transport }, extraGlobal: { crypto: globalThis.crypto }, script: defaultScript({ failure: { diagnosis: "transient" } }) });
    setProtectResolver(() => s.rt);
    s.server.on("POST", "/api/orders", { status: 500, body: {}, latency: 20 });
    const email = "jane@example.com";
    const submit = protect(`save ${email}`, () => s.fetch("/api/orders", { method: "POST", body: "{}" }).catch(() => undefined));
    void submit();
    await s.clock.advance(2000);
    expect(s.rt.decisions().find((x) => x.trigger === "failure")?.fn).toBe(`save ${email}`);
    await s.rt.telemetry!.flush();
    const evs = transport.sent.flatMap((b) => b.body.events).filter((e) => e.t === "decision" && e.trigger === "failure");
    expect(evs.map((e) => e.fn)).toEqual(["[redacted]"]);
    expect(JSON.stringify(transport.sent)).not.toContain(email);
    s.rt.destroy();
  });
});

describe("protect(): the same situation as runtime.op() (README: each call is tracked)", () => {
  async function run(wrap: "protect" | "op") {
    const s = setup({ triage: "always", script: defaultScript({ failure: { diagnosis: "transient" } }) });
    setProtectResolver(() => s.rt);
    s.server.on("GET", "/api/cart", { status: 200, body: { id: 1 }, latency: 20 });
    s.server.on("POST", "/api/orders", { status: 500, body: {}, latency: 20 });
    const body = async () => {
      const cart = await (await s.fetch("/api/cart")).json();
      return s.fetch("/api/orders", { method: "POST", body: JSON.stringify(cart) });
    };
    const submit = wrap === "protect" ? protect("checkout submit", body) : () => s.rt.op("checkout submit", body);
    void submit().catch(() => undefined);
    await s.clock.advance(2000);
    const d = s.rt.decisions().find((x) => x.trigger === "failure" && x.subject.includes("/api/orders"));
    const req = s.decider.calls.find((c) => c.trigger === "failure" && c.subject?.op === d?.subjectRef?.op);
    const history = s.rt.history().filter((e) => e.kind !== "decision").map((e) => `${e.kind} ${e.name}`);
    s.rt.destroy();
    return { d, state: req?.state, history };
  }

  it("an async function: byte-identical EvaluateRequest state and the same history; only the Decision carries fn", async () => {
    const p = await run("protect");
    const o = await run("op");
    expect(p.state).toBeDefined();
    expect(JSON.stringify(p.state)).toBe(JSON.stringify(o.state));
    expect(p.history).toEqual(o.history);
    expect(p.d?.fn).toBe("checkout submit");
    expect(o.d?.fn).toBeUndefined();
  });
});

describe("GenClass.init on a running runtime: a different token or scope is ignored, with one warning", () => {
  const quiet = { model: false as const, report: "silent" as const, telemetry: false as const };

  it("says once where token and scope must be set (the zero-code entries start before app code)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rt = GenClass.init(quiet);
    expect(GenClass.init({ token: TOKEN, scope: "functions" })).toBe(rt);
    expect(GenClass.init({ token: TOKEN, scope: "functions" })).toBe(rt);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("Already running"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('The token and scope "functions" must be set where GenClass starts');
    expect(lines[0]).toContain('GENCLASS_CONFIG = { token: "gc_...", scope: "functions" }');
    expect(lines[0]).toContain('content="token=gc_..., scope=functions"');
    expect(lines[0]).not.toContain("setMode");
    expect((rt as RuntimeImpl).scope).toBe("app");
  });

  it("the same token and scope again: no warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    GenClass.init({ ...quiet, token: TOKEN, scope: "functions" });
    GenClass.init({ token: TOKEN, scope: "functions" });
    GenClass.init({ token: ` ${TOKEN} ` });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("Already running"))).toHaveLength(0);
  });
});

describe("protect(): fn in telemetry only with a token", () => {
  it("without a token, Decision.fn is still set but decision events carry no fn", async () => {
    const transport = recorder();
    const s = setup({ triage: "always", telemetry: { transport }, extraGlobal: { crypto: globalThis.crypto }, script: defaultScript({ failure: { diagnosis: "transient" } }) });
    setProtectResolver(() => s.rt);
    s.server.on("POST", "/api/orders", { status: 500, body: {}, latency: 20 });
    const submit = protect("checkout submit", () => s.fetch("/api/orders", { method: "POST", body: "{}" }).catch(() => undefined));
    void submit();
    await s.clock.advance(2000);
    const d = s.rt.decisions().find((x) => x.trigger === "failure");
    expect(d?.fn).toBe("checkout submit");
    await s.rt.telemetry!.flush();
    const evs = transport.sent.flatMap((b) => b.body.events).filter((e) => e.t === "decision");
    expect(evs.length).toBeGreaterThan(0);
    for (const e of evs) expect("fn" in e).toBe(false);
    expect(JSON.stringify(transport.sent)).not.toContain("checkout submit");
    s.rt.destroy();
  });
});

/** The scripted decider answers `delay` ms of fake-clock time after it is asked. */
function slowDecider(s: Setup, delay: number): void {
  const d = s.decider;
  const script = d.script;
  d.evaluate = (req: EvaluateRequest) => {
    d.calls.push(req);
    return new Promise<Record<string, Answer>>((resolve) => s.clock.setTimeout(() => resolve(script(req)), delay));
  };
}

describe("protect(): a held request answered after the hold budget (CONTRACT §8)", () => {
  it("the late decision still carries fn, on the Decision and on the telemetry event", async () => {
    const transport = recorder();
    const s = setup({
      token: TOKEN,
      policy: { holdBudgetMs: 150 },
      telemetry: { transport },
      extraGlobal: { crypto: globalThis.crypto },
      script: defaultScript({ request: { diagnosis: "duplicate", action: "coalesce" } }),
    });
    setProtectResolver(() => s.rt);
    const { rt, clock, server } = s;
    const reports: string[] = [];
    rt.on("report", (r) => reports.push(r.message));
    server.on("POST", "/api/orders", ({ n }) => ({ status: 201, body: { order: n }, latency: 1500 }));
    slowDecider(s, 400); // answers 400 ms after it is asked: after the 150 ms budget
    const submitOrder = protect("checkout submit", () => s.fetch("/api/orders", { method: "POST", body: JSON.stringify({ invoice: "INV-1042", amount: 2400 }) }));
    const click = () =>
      rt.user({ kind: "click", target: 'button "Send invoice"' }, () => {
        void submitOrder().catch(() => undefined);
      });
    click();
    await clock.advance(90);
    click();
    await clock.advance(3200);
    // released at the budget (both POSTs sent, nothing coalesced), then the answer arrived and was recorded
    expect(server.hits.get("POST /api/orders")).toBe(2);
    expect(rt.interventions()).toHaveLength(0);
    expect(reports.join("\n")).toMatch(/the decision arrived after the hold budget expired/);
    const d = rt.decisions().find((x) => x.trigger === "request");
    expect(d).toBeDefined();
    expect(d!.fn).toBe("checkout submit");
    await rt.telemetry!.flush();
    const ev = transport.sent.flatMap((b) => b.body.events).find((e) => e.t === "decision" && e.trigger === "request");
    expect(ev?.fn).toBe("checkout submit");
    rt.destroy();
  });
});

describe("protect(): attribution after await", () => {
  it("a request started after awaiting the function's own request is still attributed (fn and scope)", async () => {
    const s = setup({ triage: "always", scope: "functions", script: defaultScript({ failure: { diagnosis: "transient" } }) });
    setProtectResolver(() => s.rt);
    s.server.on("GET", "/api/cart", { status: 200, body: { id: 1 }, latency: 20 });
    s.server.on("POST", "/api/orders", { status: 500, body: {}, latency: 20 });
    const submit = protect("checkout submit", async () => {
      const cart = await (await s.fetch("/api/cart")).json();
      return s.fetch("/api/orders", { method: "POST", body: JSON.stringify(cart) });
    });
    void submit().catch(() => undefined);
    await s.clock.advance(2000);
    const d = s.rt.decisions().find((x) => x.trigger === "failure");
    expect(d?.subject).toContain("/api/orders");
    expect(d?.fn).toBe("checkout submit");
    s.rt.destroy();
  });
});

describe("scope: \"functions\"", () => {
  async function run(scope: "app" | "functions" | undefined) {
    const s = setup({ triage: "always", ...(scope ? { scope } : {}), script: defaultScript({ failure: { diagnosis: "transient" } }) });
    setProtectResolver(() => s.rt);
    s.server.on("POST", "/api/orders", { status: 500, body: {}, latency: 20 });
    s.server.on("GET", "/api/feed", { status: 500, body: {}, latency: 20 });
    const submit = protect("checkout submit", (body: string) => s.fetch("/api/orders", { method: "POST", body }));
    void s.fetch("/api/feed").catch(() => undefined);
    await s.clock.advance(500);
    void submit("{}").catch(() => undefined);
    await s.clock.advance(2000);
    const ds = s.rt.decisions();
    const out = {
      s,
      triggers: ds.map((d) => `${d.trigger} ${d.subject}`),
      decided: ds.map((d) => d.subject),
      orderState: (() => {
        const d = ds.find((x) => x.trigger === "failure" && x.subject.includes("/api/orders"));
        return s.decider.calls.find((c) => c.trigger === "failure" && c.subject?.op === d?.subjectRef?.op)?.state;
      })(),
      history: s.rt.history().filter((e) => e.kind !== "decision").map((e) => `${e.kind} ${e.name}`),
    };
    s.rt.destroy();
    return out;
  }

  it("decides only for activity inside protected functions; still records everything", async () => {
    const fns = await run("functions");
    expect(fns.decided.length).toBeGreaterThan(0);
    expect(fns.decided.every((x) => x.includes("/api/orders"))).toBe(true);
    expect(fns.triggers.some((t) => t.includes("/api/feed"))).toBe(false);
    // the unprotected request is still in the history (context)
    expect(fns.history.some((h) => h.includes("/api/feed"))).toBe(true);
  });

  it("default scope (app) is unchanged: unprotected activity is decided too; the situation text is identical", async () => {
    const app = await run(undefined);
    const explicit = await run("app");
    const fns = await run("functions");
    expect(app.decided.some((x) => x.includes("/api/feed"))).toBe(true);
    expect(app.decided).toEqual(explicit.decided);
    expect(app.history).toEqual(fns.history);
    // gating changes which subjects are decided, never what the model reads about a decided one
    expect(fns.orderState).toBeDefined();
    expect(fns.orderState).toEqual(app.orderState);
  });

  it("GenClass.init({ scope }) passes through", () => {
    const rt = GenClass.init({ scope: "functions", model: false, report: "silent", telemetry: false }) as RuntimeImpl;
    expect(rt.scope).toBe("functions");
  });
});

describe("GenClass.init on a local host (TELEMETRY.md: off by default on local and private hosts)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const quiet = {
    model: false as const,
    report: "silent" as const,
    observe: { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false },
  };

  it("default telemetry stays off on localhost; with a token the console says once why the dashboard stays empty", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 202 }))));
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    vi.stubGlobal("location", { hostname: "localhost", search: "", href: "http://localhost:5173/", pathname: "/" });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const m = await import("../src/index.js");
    m.GenClass.destroy();
    const lines = (needle: string) => info.mock.calls.filter((c) => String(c[0]).includes(needle)).length;
    // GenClass.init leaves the option unset (it used to pass `telemetry: true`, which reads as an explicit opt-in)
    const rt = m.GenClass.init({ ...quiet, token: TOKEN });
    expect(rt.telemetry).toMatchObject({ enabled: false, reason: "local" });
    expect(lines("telemetry is off on local hosts")).toBe(1);
    expect(lines("Sends anonymous diagnostics")).toBe(0);
    m.GenClass.destroy();
    // no token: off and silent
    const rt2 = m.GenClass.init(quiet);
    expect(rt2.telemetry).toMatchObject({ enabled: false, reason: "local" });
    expect(lines("telemetry is off on local hosts")).toBe(1);
    m.GenClass.destroy();
    // an explicit opt-in still sends from a local host (tests, dogfooding)
    const rt3 = m.GenClass.init({ ...quiet, telemetry: true });
    expect(rt3.telemetry?.enabled).toBe(true);
    m.GenClass.destroy();
    // a public host: on by default, as before
    vi.stubGlobal("location", { hostname: "shop.example", search: "", href: "https://shop.example/", pathname: "/" });
    const rt4 = m.GenClass.init(quiet);
    expect(rt4.telemetry?.enabled).toBe(true);
    m.GenClass.destroy();
  });
});

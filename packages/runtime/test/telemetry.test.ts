// Anonymous diagnostics (InitOptions.telemetry, TELEMETRY.md): defaults, opt-outs, batching, page exit, event
// shapes, the redacted situation text, transport failures, and that GenClass never observes its own requests.

import { BACKOFF_MS, MAX_BACKOFFS, MAX_BACKOFF_MS, MAX_FAIL_STREAK, backoffOf, decisionDraw } from "../src/telemetry/client.js";
import { retryAfterMs } from "../src/telemetry/transport.js";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenClass, createRuntime, DEFAULT_TELEMETRY_ENDPOINT, RUNTIME_VERSION, TELEMETRY_NOTICE } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { stateText } from "../src/situation/serialize.js";
import { resetTelemetryNotice, resolveTelemetry, MAX_QUEUE } from "../src/telemetry/index.js";
import { isLocalHost } from "../src/telemetry/config.js";
import type { ModelStatus, TelemetryTransport } from "../src/types.js";
import { FakeClock, FakeServer, defaultScript, makeGlobal, setup } from "./helpers.js";

interface Sent {
  url: string;
  body: Record<string, unknown> & { events: Record<string, unknown>[] };
  beacon: boolean;
}

function recorder(fail?: "throw" | "reject"): TelemetryTransport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send(url, body, o) {
      sent.push({ url, body: JSON.parse(body), beacon: o.beacon });
      if (fail === "throw") throw new Error("offline");
      if (fail === "reject") return Promise.reject(new Error("HTTP 500"));
      return Promise.resolve();
    },
  };
}

const events = (t: { sent: Sent[] }) => t.sent.flatMap((s) => s.body.events);
const ofType = (t: { sent: Sent[] }, type: string) => events(t).filter((e) => e.t === type);

/** A headless runtime with telemetry explicitly on and an injected transport. */
function tsetup(opts: Parameters<typeof setup>[0] = {}, telemetry: Record<string, unknown> = {}, fail?: "throw" | "reject") {
  const transport = recorder(fail);
  const s = setup({ ...opts, telemetry: { transport, ...telemetry }, extraGlobal: { crypto: globalThis.crypto, ...(opts.extraGlobal ?? {}) } });
  return { ...s, transport };
}

const noRandom = { getRandomValues: undefined };

describe("telemetry: defaults and opt-outs (TELEMETRY.md)", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  afterEach(() => {
    GenClass.destroy();
    delete g.location;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("RUNTIME_VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(RUNTIME_VERSION).toBe(pkg.version);
  });

  it("off in createRuntime (headless) and in GenClass.init outside a browser unless enabled", () => {
    const { rt } = setup();
    expect(rt.telemetry).toMatchObject({ enabled: false, reason: "headless" });
    const r = GenClass.init({ model: false, report: "silent", observe: { fetch: false, timers: false } });
    expect(r.telemetry).toMatchObject({ enabled: false, reason: "headless" });
  });

  it("on by default in GenClass.init in a browser, with one console notice per page, to the default endpoint", async () => {
    vi.resetModules();
    const sent: { url: string; init: RequestInit }[] = [];
    const fake = vi.fn((url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Promise.resolve(new Response(null, { status: 202 }));
    });
    vi.stubGlobal("fetch", fake);
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const m = await import("../src/index.js");
    m.GenClass.destroy();
    const rt = m.GenClass.init({ model: false, report: "silent", observe: { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false } });
    expect(rt.telemetry?.enabled).toBe(true);
    expect(info.mock.calls.filter((c) => c[0] === TELEMETRY_NOTICE)).toHaveLength(1);
    expect(TELEMETRY_NOTICE).toBe(
      "[GenClass] Sends anonymous diagnostics (decisions and counts, no page text) to improve the model. Opt out: GenClass.init({ telemetry: false }) or ?genclass=no-telemetry.",
    );
    // a second runtime on the same page does not repeat the notice
    const rt2 = m.createRuntime({ telemetry: true, decider: null, report: "silent", observe: { fetch: false, timers: false } });
    expect(info.mock.calls.filter((c) => c[0] === TELEMETRY_NOTICE)).toHaveLength(1);
    rt2.destroy();
    await rt.telemetry!.flush();
    const mine = sent.filter((s) => s.url === m.DEFAULT_TELEMETRY_ENDPOINT);
    expect(mine.length).toBeGreaterThan(0);
    expect(m.DEFAULT_TELEMETRY_ENDPOINT).toBe("https://genclass.dev/api/v1/events");
    const req = mine[0].init;
    expect(req.method).toBe("POST");
    expect(req.keepalive).toBe(true);
    expect(req.credentials).toBe("omit");
    expect((req.headers as Record<string, string>)["content-type"]).toMatch(/^text\/plain/);
    const body = JSON.parse(String(req.body));
    expect(body).toMatchObject({ schema: "genclass-telemetry/1", runtime: RUNTIME_VERSION, model: null });
    expect(body.sid).toMatch(/^[0-9a-f]{24}$/);
    expect(body.events[0]).toMatchObject({ t: "session", seq: 0, mode: "observe", model: "off" });
    m.GenClass.destroy();
  });

  it("every opt-out: option, ?genclass=no-telemetry / off, localStorage, GPC, sample, no crypto", () => {
    const base = { crypto: globalThis.crypto };
    const ls = (v: string | null) => ({ getItem: (k: string) => (k === "genclass.telemetry" ? v : null) });
    expect(resolveTelemetry(false, base, true)).toEqual({ on: false, reason: "option" });
    expect(resolveTelemetry(undefined, base, false)).toEqual({ on: false, reason: "headless" });
    expect(resolveTelemetry(undefined, { ...base, location: { search: "?genclass=no-telemetry" } }, true)).toEqual({ on: false, reason: "url" });
    expect(resolveTelemetry(true, { ...base, location: { search: "?genclass=guard&genclass=no-telemetry" } }, true)).toEqual({ on: false, reason: "url" });
    expect(resolveTelemetry(undefined, { ...base, location: { search: "?genclass=off" } }, true)).toEqual({ on: false, reason: "url" });
    expect(resolveTelemetry(undefined, { ...base, localStorage: ls("off") }, true)).toEqual({ on: false, reason: "localStorage" });
    expect(resolveTelemetry({}, { ...base, navigator: { globalPrivacyControl: true } }, true)).toEqual({ on: false, reason: "gpc" });
    expect(resolveTelemetry({ sample: 0 }, base, true)).toEqual({ on: false, reason: "sampled-out" });
    expect(resolveTelemetry(undefined, { crypto: noRandom }, true)).toEqual({ on: false, reason: "no-crypto" });
    // still on: GPC false, localStorage other values, sample 1, an unrelated genclass value
    const on = resolveTelemetry({ sample: 1 }, { ...base, navigator: { globalPrivacyControl: false }, localStorage: ls("on"), location: { search: "?genclass=guard" } }, true);
    expect(on.on).toBe(true);
    if (on.on) expect(on.config).toMatchObject({ endpoint: DEFAULT_TELEMETRY_ENDPOINT, flushMs: 10_000, maxBatch: 100, situation: false, sample: 1 });
    const withText = resolveTelemetry({ include: { situation: true } }, base, true);
    expect(withText.on).toBe(true);
    if (withText.on) expect(withText.config.situation).toBe(true);
  });

  it("the default-on telemetry stays off on local and private hosts; an explicit option still sends from them", () => {
    const base = { crypto: globalThis.crypto };
    const at = (hostname: string) => ({ ...base, location: { hostname, search: "" } });
    for (const h of ["localhost", "LOCALHOST", "app.localhost", "dev.test", "mac.local", "db.internal", "127.0.0.1", "127.9.9.9", "[::1]", "::1", "0.0.0.0", "10.0.0.5", "192.168.1.20", "172.16.0.1", "172.31.255.255", "169.254.1.1", "100.64.0.1", "fd12::1", "fe80::1", "intranet", ""]) {
      expect(resolveTelemetry(undefined, at(h), true), h).toEqual({ on: false, reason: "local" });
    }
    for (const h of ["genclass.dev", "app.example.com", "172.32.0.1", "11.0.0.1", "8.8.8.8", "2606:4700::1"]) {
      expect(resolveTelemetry(undefined, at(h), true).on, h).toBe(true);
    }
    expect(resolveTelemetry(undefined, { ...base, location: { search: "" } }, true).on).toBe(true); // hostname unknown: not local
    expect(isLocalHost(undefined)).toBe(false);
    expect(resolveTelemetry(true, at("localhost"), true).on).toBe(true);
    expect(resolveTelemetry({ sample: 1 }, at("10.0.0.5"), true).on).toBe(true);
    // the explicit opt-outs keep their reasons on local hosts too
    expect(resolveTelemetry(undefined, { ...at("localhost"), location: { hostname: "localhost", search: "?genclass=no-telemetry" } }, true)).toEqual({ on: false, reason: "url" });
  });

  it("opt-outs apply to createRuntime and GenClass.init too (GPC, ?genclass=off kill switch)", () => {
    const { rt } = tsetup({ extraGlobal: { navigator: { globalPrivacyControl: true } } });
    expect(rt.telemetry).toMatchObject({ enabled: false, reason: "gpc" });
    const { rt: rt2, transport } = tsetup({}, { sample: 0 });
    expect(rt2.telemetry).toMatchObject({ enabled: false, reason: "sampled-out" });
    void rt2.telemetry!.flush();
    expect(transport.sent).toHaveLength(0);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    g.location = { search: "?genclass=off", href: "http://x/?genclass=off", pathname: "/" };
    const r = GenClass.init({ telemetry: true });
    expect(r.telemetry).toMatchObject({ enabled: false, reason: "kill-switch" });
  });
});

describe("telemetry: batching, flush and page exit", () => {
  it("batches on the flush interval, splits by maxBatch, and keeps a bounded queue", async () => {
    const { rt, clock, transport } = tsetup({ triage: "always" }, { flushMs: 5000, maxBatch: 3, decisionSample: 1 });
    expect(rt.telemetry?.enabled).toBe(true);
    expect(transport.sent).toHaveLength(0);
    const a = rt.atom("a", 1);
    for (let i = 0; i < 3; i++) {
      void rt.op("w", () => a.set(i + 2));
      await clock.advance(100);
    }
    expect(transport.sent).toHaveLength(0);
    await clock.advance(5000);
    const n = events(transport).length;
    expect(n).toBeGreaterThanOrEqual(4); // session + 3 decisions
    expect(transport.sent.every((s) => s.body.events.length <= 3)).toBe(true);
    expect(transport.sent.every((s) => s.beacon === false && s.url === DEFAULT_TELEMETRY_ENDPOINT)).toBe(true);
    const seqs = events(transport).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => (x as number) - (y as number)));
    expect(new Set(transport.sent.map((s) => s.body.sid)).size).toBe(1);
    // bounded: beyond MAX_QUEUE queued events new ones are dropped and counted
    const client = rt.telemetry as unknown as { push(e: Record<string, unknown>): void; summary(r: string): void };
    for (let i = 0; i < MAX_QUEUE + 5; i++) client.push({ t: "x" });
    await rt.telemetry!.flush();
    const before = transport.sent.length;
    client.summary("periodic");
    await rt.telemetry!.flush();
    const sum = transport.sent.slice(before).flatMap((s) => s.body.events).find((e) => e.t === "summary") as { telemetry: { dropped: number } };
    expect(sum.telemetry.dropped).toBe(5);
  });

  it("pagehide sends a final summary with sendBeacon; a hidden tab flushes too", async () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const { rt, clock, transport } = tsetup({ triage: "always", extraGlobal: { addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win), document: doc } });
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await clock.flush();
    expect(transport.sent.at(-1)!.beacon).toBe(true);
    expect(transport.sent.at(-1)!.body.events.at(-1)).toMatchObject({ t: "summary", reason: "hidden" });
    win.dispatchEvent(new Event("pagehide"));
    await clock.flush();
    const last = transport.sent.at(-1)!;
    expect(last.beacon).toBe(true);
    const s = last.body.events.at(-1) as Record<string, any>;
    expect(s).toMatchObject({ t: "summary", reason: "pagehide" });
    expect(s.counts.decisions).toBe(1);
    expect(s.counts.byTrigger).toEqual({ mutation: 1 });
    rt.destroy();
    expect(transport.sent.at(-1)!.body.events.at(-1)).toMatchObject({ t: "summary", reason: "destroy" });
  });

  it("transport errors never reach the app: failures are counted and the batch dropped", async () => {
    for (const fail of ["throw", "reject"] as const) {
      const { rt, clock, transport } = tsetup({ triage: "always" }, {}, fail);
      const a = rt.atom("a", 1);
      void rt.op("w", () => a.set(2));
      await clock.flush();
      await expect(rt.telemetry!.flush()).resolves.toBeUndefined();
      await expect(rt.telemetry!.flush()).resolves.toBeUndefined();
      expect(a.get()).toBe(2);
      (rt.telemetry as unknown as { summary(r: string): void }).summary("periodic");
      await rt.telemetry!.flush();
      const s = events(transport).filter((e) => e.t === "summary").at(-1) as { telemetry: { sendFailures: number } };
      expect(s.telemetry.sendFailures).toBeGreaterThanOrEqual(1);
      expect(() => rt.destroy()).not.toThrow();
    }
  });

  it("after MAX_FAIL_STREAK failed requests in a row a page stops sending (a CSP block logs at most 3 violations)", async () => {
    const { rt, clock, transport } = tsetup({ triage: "always" }, { decisionSample: 1 }, "reject");
    const a = rt.atom("a", 1);
    for (let i = 0; i < 6; i++) {
      void rt.op(`w${i}`, () => a.set(i + 2));
      await clock.flush();
      await rt.telemetry!.flush();
    }
    expect(transport.sent).toHaveLength(MAX_FAIL_STREAK);
    void rt.op("later", () => a.set(100));
    await clock.advance(60_000);
    await rt.telemetry!.flush();
    expect(transport.sent).toHaveLength(MAX_FAIL_STREAK);
    expect(a.get()).toBe(100);
    expect(() => rt.destroy()).not.toThrow();
    expect(transport.sent).toHaveLength(MAX_FAIL_STREAK);
  });

  it("a successful request resets the failure streak", async () => {
    const sent: number[] = [];
    let n = 0;
    const outcomes = [false, false, true, false, false, true, false, false];
    const transport = {
      send: () => {
        const ok = outcomes[n++] ?? true;
        sent.push(n);
        return ok ? Promise.resolve() : Promise.reject(new Error("HTTP 503"));
      },
    };
    const s = setup({ triage: "always", telemetry: { transport, decisionSample: 1 }, extraGlobal: { crypto: globalThis.crypto } });
    const a = s.rt.atom("a", 1);
    for (let i = 0; i < 8; i++) {
      void s.rt.op(`w${i}`, () => a.set(i + 2));
      await s.clock.flush();
      await s.rt.telemetry!.flush();
    }
    expect(sent.length).toBe(8);
    s.rt.destroy();
  });
});

describe("telemetry: event shapes and the situation text", () => {
  it("with include.situation, a decision carries the exact redacted situation text the model received, its answers and the gate", async () => {
    const { rt, clock, transport, decider } = tsetup(
      { triage: "always", policy: { holdWrites: true }, script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) },
      { include: { situation: true } },
    );
    const auth = rt.atom("auth", { user: "ada", password: "hunter2-secret", token: "tok-SECRET-123" });
    void rt.op("login", () => auth.set({ user: "bob", password: "correct-horse", token: "tok-SECRET-456" }));
    await clock.flush();
    await rt.telemetry!.flush();
    const [d] = ofType(transport, "decision") as Record<string, any>[];
    expect(decider.calls).toHaveLength(1);
    expect(d.situation).toBe(stateText(decider.calls[0].state));
    expect(d.situation).toBe(rt.explain(d.id)!.situationText);
    for (const secret of ["hunter2", "correct-horse", "SECRET"]) expect(JSON.stringify(transport.sent)).not.toContain(secret);
    expect(d).toMatchObject({
      t: "decision",
      trigger: "mutation",
      route: "/search",
      model: "scripted",
      held: true,
      diagnosis: "stale",
      action: "discard",
      ran: "discard",
      executed: true,
      acted: true,
      tier: "guard",
      gateKind: "mass",
      threshold: 0.9,
      thresholdSource: "default",
      effectiveMode: "guard",
    });
    expect(d.questions).toEqual(expect.arrayContaining(["diagnosis", "action"]));
    expect(d.answers.diagnosis).toMatchObject({ type: "choice", choice: "stale" });
    expect(d.answers.action.probabilities.discard).toBe(0.97);
    expect(typeof d.latencyMs).toBe("number");
    expect(d.gates).toMatchObject({ guard: 0.9, heal: 0.8 });
    const [det] = ofType(transport, "detect");
    expect(det).toMatchObject({ decision: d.id, trigger: "mutation", diagnosis: "stale", p: 0.97 });
    const [act] = ofType(transport, "action") as Record<string, any>[];
    expect(act).toMatchObject({ decision: d.id, action: "discard", tier: "guard", trigger: "mutation", outcome: "applied", reversible: true });
    expect(act).not.toHaveProperty("error");
    // undo
    rt.interventions()[0].undo!();
    await rt.telemetry!.flush();
    expect(ofType(transport, "action").at(-1)).toMatchObject({ outcome: "undone", action: "discard" });
  });

  it("by default (include.situation off) the text is left out; vetoes, failures and late reverts are recorded", async () => {
    const { rt, clock, transport } = tsetup(
      { triage: "always", onBeforeAction: () => false, script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) },
      {},
    );
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    await rt.telemetry!.flush();
    const [d] = ofType(transport, "decision");
    expect(d).not.toHaveProperty("situation");
    expect(d).toMatchObject({ reason: "vetoed", acted: false });
    expect(ofType(transport, "veto")[0]).toMatchObject({ decision: d.id, action: "discard", enforced: true });
    expect(ofType(transport, "session")[0]).toMatchObject({ situation: false, runtime: RUNTIME_VERSION, mode: "guard", model: "custom", route: "/search" });
  });

  it("late reverts and model errors / fail-opens are counted", async () => {
    const { rt, clock, transport } = tsetup({ triage: "always", script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) });
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    await rt.telemetry!.flush();
    expect(ofType(transport, "action")[0]).toMatchObject({ outcome: "applied", late: true });

    let n = 0;
    const { rt: rt2, clock: c2, transport: t2 } = tsetup({
      triage: "always",
      script: () => {
        n++;
        throw Object.assign(new Error("inference failed"), { code: "inference_failed" });
      },
    });
    const b = rt2.atom("b", 1);
    void rt2.op("w", () => b.set(2));
    await c2.flush();
    expect(n).toBe(1);
    (rt2.telemetry as unknown as { summary(r: string): void }).summary("periodic");
    await rt2.telemetry!.flush();
    expect(ofType(t2, "model-error")[0]).toMatchObject({ code: "inference_failed", message: "inference failed" });
    const s = ofType(t2, "summary").at(-1) as Record<string, any>;
    expect(s.counts.modelErrors).toEqual({ inference_failed: 1 });
    expect(s.counts.failOpen).toEqual({ "no-answer:mutation": 1 });
    expect(b.get()).toBe(2);
  });

  it("a model event's workerError carries no URLs (the browser's text names the worker script and the page origin)", async () => {
    const fns = new Set<(s: ModelStatus) => void>();
    const decider = {
      status: { state: "loading" } as ModelStatus,
      ready: () => Promise.resolve(),
      evaluate: () => Promise.reject(new Error("no model")),
      onStatus(fn: (s: ModelStatus) => void) {
        fns.add(fn);
        return () => fns.delete(fn);
      },
    };
    const { rt, transport } = tsetup({ decider });
    const text = "SecurityError: Failed to construct 'Worker': Script at 'https://cdn.example/npm/x/worker.js' cannot be accessed from origin 'https://shop.example'. blob:https://shop.example/0b1c";
    decider.status = { state: "skipped", reason: "worker-unavailable", worker: false, workerError: text };
    for (const f of fns) f(decider.status);
    await rt.telemetry!.flush();
    const m = ofType(transport, "model").at(-1)!;
    expect(m).toMatchObject({ state: "skipped", reason: "worker-unavailable" });
    expect(m.workerError).toBe("SecurityError: Failed to construct 'Worker': Script at '<url>' cannot be accessed from origin '<url>'. <url>");
    // the runtime's own status (and the console warning built from it) keeps the full text
    expect(rt.status.workerError).toBe(text);
  });

  it("a model event's error and attempts, and a model-error message, carry no URLs either (the model host's messages quote the worker's)", async () => {
    const fns = new Set<(s: ModelStatus) => void>();
    const decider = {
      status: { state: "loading" } as ModelStatus,
      ready: () => Promise.resolve(),
      evaluate: () => Promise.reject(new Error("no model")),
      onStatus(fn: (s: ModelStatus) => void) {
        fns.add(fn);
        return () => fns.delete(fn);
      },
    };
    const { rt, transport } = tsetup({ decider });
    decider.status = {
      state: "error",
      error: "model not ready: the worker failed (SecurityError: Script at 'https://cdn.example/npm/x/worker.js' cannot be accessed from origin 'https://shop.example')",
      attempts: [{ variant: "q8", device: "wasm", error: "fetch https://cdn.example/npm/m/model.onnx failed" }],
    } as ModelStatus;
    for (const f of fns) f(decider.status);
    await rt.telemetry!.flush();
    const m = ofType(transport, "model").at(-1)! as Record<string, any>;
    expect(m.error).toBe("model not ready: the worker failed (SecurityError: Script at '<url>' cannot be accessed from origin '<url>')");
    expect(m.attempts).toEqual([{ variant: "q8", device: "wasm", error: "fetch <url> failed" }]);

    const { rt: rt2, clock: c2, transport: t2 } = tsetup({
      triage: "always",
      script: () => {
        throw Object.assign(new Error("Model not loaded: Failed to construct 'Worker': Script at 'https://cdn.example/npm/x/worker.js' cannot be accessed from origin 'https://shop.example'."), { code: "not_ready" });
      },
    });
    const b = rt2.atom("b", 1);
    void rt2.op("w", () => b.set(2));
    await c2.flush();
    await rt2.telemetry!.flush();
    expect(ofType(t2, "model-error")[0]).toMatchObject({ code: "not_ready", message: "Model not loaded: Failed to construct 'Worker': Script at '<url>' cannot be accessed from origin '<url>'." });
    expect(JSON.stringify(t2.sent)).not.toContain("cdn.example");
    expect(JSON.stringify(transport.sent)).not.toContain("cdn.example");
  });

  it("a page path segment holding an e-mail address (raw or %40) is sent as :id, as sink records have it", async () => {
    const pathname = "/users/alice@example.com/orders/bob%40example.org/42";
    const { rt, clock, transport } = tsetup({
      triage: "always",
      script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }),
      extraGlobal: { location: { href: `https://app.test${pathname}`, pathname, search: "" } },
    });
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    await rt.telemetry!.flush();
    expect(ofType(transport, "session")[0].route).toBe("/users/:id/orders/:id/:id");
    const [d] = ofType(transport, "decision");
    expect(d.route).toBe("/users/:id/orders/:id/:id");
    expect(JSON.stringify(transport.sent)).not.toMatch(/alice|bob|example\.(com|org)/);
  });

  it("telemetry never changes what the model sees", async () => {
    const run = async (telemetry: boolean) => {
      const s = telemetry ? tsetup({ triage: "always" }) : setup({ triage: "always" });
      const a = s.rt.atom("cart", { items: 1, card: "4111111111111111" });
      void s.rt.op("add", () => a.set({ items: 2, card: "4111111111111111" }));
      await s.clock.flush();
      return s.decider.calls.map((c) => JSON.stringify(c.state) + JSON.stringify(c.questions));
    };
    expect(await run(true)).toEqual(await run(false));
  });
});

describe("telemetry: volume (TELEMETRY.md, Volume): routine decision records sampled and capped, detections never, counts exact", () => {
  const STALE = defaultScript({ mutation: { diagnosis: "stale", action: "discard" } });
  /** n mutation decisions, one every `everyMs`, then a final summary; returns what was sent. */
  async function run(n: number, everyMs: number, opts: Parameters<typeof setup>[0], telemetry: Record<string, unknown> = {}) {
    const s = tsetup({ triage: "always", mode: undefined, ...opts }, telemetry);
    const a = s.rt.atom("a", 0);
    for (let i = 0; i < n; i++) {
      void s.rt.op("w", () => a.set(i + 1));
      await s.clock.advance(everyMs);
    }
    (s.rt.telemetry as unknown as { summary(r: string): void }).summary("periodic");
    await s.rt.telemetry!.flush();
    const sum = ofType(s.transport, "summary").at(-1) as Record<string, any>;
    return { ...s, sum, decisions: ofType(s.transport, "decision"), detects: ofType(s.transport, "detect") };
  }

  it("routine decisions: about 1 in 4 records by default, the same verdict for the same session and decision ids; counts exact", async () => {
    const r = await run(80, 500, {});
    expect(r.sum.counts.decisions).toBe(80);
    const t = r.sum.telemetry;
    expect(t.decisionRecords + t.decisionsSampledOut).toBe(80);
    expect(t.decisionsCapped).toBe(0);
    expect(r.decisions).toHaveLength(t.decisionRecords);
    expect(t.decisionRecords).toBeGreaterThan(5); // a hash draw at 0.25 of 80: about 20
    expect(t.decisionRecords).toBeLessThan(40);
    // the page's sampling settings are not sent (AGENTS.md rule 8): summary.telemetry is what a collector scales by
    const session = ofType(r.transport, "session")[0];
    expect(session).not.toHaveProperty("decisionSample");
    expect(session).not.toHaveProperty("maxDecisions");
    // decisionSample: 1 sends every record, 0 none of the routine ones
    expect((await run(10, 500, {}, { decisionSample: 1 })).decisions).toHaveLength(10);
    const none = await run(10, 500, {}, { decisionSample: 0 });
    expect(none.decisions).toHaveLength(0);
    expect(none.sum.counts.decisions).toBe(10);
    expect(none.sum.telemetry.decisionsSampledOut).toBe(10);
  });

  it("the routine-record draw is even for every session: decision ids that differ only in their last digits do not skew a page's share", () => {
    // fnv1a alone gave one session 0 of 80 and another 59 of 80 at 0.25; the finalizer keeps every session near 20
    const per: number[] = [];
    for (let k = 0; k < 200; k++) {
      const sid = `${((k * 2654435761) >>> 0).toString(16).padStart(8, "0")}-4c0a-4b65-9e3f-${k.toString(16).padStart(12, "0")}`;
      let n = 0;
      for (let i = 1; i <= 80; i++) if (decisionDraw(`${sid}:d${i}`) < 0.25) n++;
      per.push(n);
    }
    expect(Math.min(...per)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...per)).toBeLessThanOrEqual(36);
    const share = per.reduce((a, b) => a + b, 0) / (200 * 80);
    expect(share).toBeGreaterThan(0.23);
    expect(share).toBeLessThan(0.27);
  });

  it("detections, actions and vetoes are never sampled out: their decision, detect and veto records all go", async () => {
    const det = await run(12, 500, { script: STALE }, { decisionSample: 0 });
    expect(det.sum.counts.detections).toBe(12);
    expect(det.decisions).toHaveLength(12);
    expect(det.detects.map((e) => e.decision)).toEqual(det.decisions.map((e) => e.id));
    // a near-miss (top diagnosis not "expected", below the report gate) is not routine either: its record goes, with
    // no detect event
    const near = await run(8, 500, { script: defaultScript({ mutation: { diagnosis: "stale", action: "discard", p: 0.45 } }) }, { decisionSample: 0, maxDecisions: 0 });
    expect(near.sum.counts.decisions).toBe(8);
    expect(near.decisions).toHaveLength(8);
    expect(near.decisions.every((e) => e.diagnosis === "stale")).toBe(true);
    expect(near.detects).toHaveLength(0);
    expect(near.sum.telemetry).toMatchObject({ decisionRecords: 8, decisionsSampledOut: 0, decisionsCapped: 0 });
    const vetoed = await run(5, 500, { mode: "guard", onBeforeAction: () => false, script: STALE }, { decisionSample: 0 });
    expect(ofType(vetoed.transport, "veto")).toHaveLength(5);
    expect(vetoed.sum.counts.vetoes).toBe(5);
  });

  it("maxDecisions caps routine records for the page load; detections are never capped; summaries keep the exact counts", async () => {
    const r = await run(20, 500, {}, { maxDecisions: 6, decisionSample: 1 });
    expect(r.decisions).toHaveLength(6);
    expect(r.sum.counts.decisions).toBe(20);
    expect(r.sum.telemetry).toMatchObject({ decisionRecords: 6, decisionsCapped: 14 });
    // every decision a detection: all 20 decision and detect records go, whatever the cap
    const det = await run(20, 500, { script: STALE }, { maxDecisions: 6 });
    expect(det.decisions).toHaveLength(20);
    expect(det.detects).toHaveLength(20);
    expect(det.detects.map((e) => e.decision)).toEqual(det.decisions.map((e) => e.id));
    expect(det.sum.counts.detections).toBe(20);
    expect(det.sum.telemetry).toMatchObject({ decisionRecords: 20, decisionsCapped: 0, decisionsSampledOut: 0 });
    const all = await run(20, 500, {}, { maxDecisions: Infinity, decisionSample: 1 });
    expect(all.decisions).toHaveLength(20);
  });

  it("detections after the routine cap is reached still go, with their decision records", async () => {
    // 10 routine decisions fill a cap of 3, then 5 detections, then routine again
    let stale = false;
    const routine = defaultScript();
    const det = defaultScript({ mutation: { diagnosis: "stale", action: "discard" } });
    const s = tsetup({ triage: "always", mode: undefined, script: (req) => (stale ? det(req) : routine(req)) }, { maxDecisions: 3, decisionSample: 1 });
    const a = s.rt.atom("a", 0);
    let k = 0;
    const step = async (n: number) => {
      for (let i = 0; i < n; i++) {
        void s.rt.op("w", () => a.set(++k));
        await s.clock.advance(500);
      }
    };
    await step(10);
    stale = true;
    await step(5);
    stale = false;
    await step(4);
    (s.rt.telemetry as unknown as { summary(r: string): void }).summary("periodic");
    await s.rt.telemetry!.flush();
    const decisions = ofType(s.transport, "decision");
    const detects = ofType(s.transport, "detect");
    expect(detects).toHaveLength(5);
    expect(decisions.filter((e) => e.diagnosis === "stale")).toHaveLength(5);
    expect(decisions.filter((e) => e.diagnosis === "expected")).toHaveLength(3);
    for (const d of detects) expect(decisions.some((e) => e.id === d.decision)).toBe(true);
    const sum = ofType(s.transport, "summary").at(-1) as Record<string, any>;
    expect(sum.counts).toMatchObject({ decisions: 19, detections: 5 });
    expect(sum.telemetry).toMatchObject({ decisionRecords: 8, decisionsCapped: 11 });
  });

  it("a page the device floor skips still sends its session event (modelState skipped) and a model event saying why", async () => {
    const clock = new FakeClock();
    const transport = recorder();
    const rt = createRuntime({
      clock,
      global: makeGlobal(new FakeServer(clock), { navigator: { deviceMemory: 2 }, crypto: globalThis.crypto }),
      model: {},
      report: "silent",
      observe: { fetch: false, timers: false },
      telemetry: { transport },
    });
    expect(rt.status).toMatchObject({ state: "skipped", reason: "device-memory" });
    await rt.telemetry!.flush();
    const session = ofType(transport, "session");
    expect(session).toHaveLength(1);
    expect(session[0]).toMatchObject({ model: "local", modelState: "skipped", device: { memoryGB: 2 } });
    const model = ofType(transport, "model");
    expect(model).toHaveLength(1);
    expect(model[0]).toMatchObject({ state: "skipped", reason: "device-memory" });
    expect((model[0].seq as number) > (session[0].seq as number)).toBe(true);
    rt.destroy();
  });

  it("summaries keep their once-a-minute cadence while decisions continue, when records are capped or sampled out", async () => {
    // a decision every 5 s for 10 minutes; the records stop after 2 decisions, or are never sent
    for (const telemetry of [{ maxDecisions: 2 }, { decisionSample: 0 }]) {
      const r = await run(120, 5000, {}, telemetry);
      expect(r.sum.counts.decisions).toBe(120);
      const timed = ofType(r.transport, "summary").slice(0, -1); // the last one is run()'s own
      expect(timed.every((e) => e.reason === "periodic")).toBe(true);
      expect(timed.length, JSON.stringify(telemetry)).toBeGreaterThanOrEqual(8);
      const at = timed.map((e) => e.at as number);
      // at least SUMMARY_MS apart, and at most one flush interval (10 s) plus one decision interval later than that
      for (let i = 1; i < at.length; i++) {
        expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(60_000);
        expect(at[i] - at[i - 1]).toBeLessThanOrEqual(75_000);
      }
      // each one carries the exact counts at its time
      const counts = timed.map((e) => (e.counts as { decisions: number }).decisions);
      expect(counts).toEqual([...counts].sort((x, y) => x - y));
      expect(counts.at(-1)).toBeGreaterThan(100);
    }
  });

  it("an hour at the built-in model's maximum rate (30 decisions a minute) stays bounded", async () => {
    const size = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;
    const bytes = (t: { sent: Sent[] }) => t.sent.reduce((n, x) => n + size(x.body), 0);
    const summaries = (t: { sent: Sent[] }) => ofType(t, "summary");
    const routine = await run(1800, 2000, {});
    const noisy = await run(1800, 2000, { script: STALE });
    const full = await run(1800, 2000, { script: STALE }, { decisionSample: 1, maxDecisions: Infinity });
    const kb = (n: number) => Math.round(n / 102.4) / 10;
    const line = (t: { sent: Sent[] }) => `${kb(bytes(t))} KB in ${t.sent.length} requests, ${summaries(t).length} summaries ${kb(summaries(t).reduce((n, e) => n + size(e), 0))} KB`;
    // the numbers TELEMETRY.md and docs/runtime/RESULTS.md quote come from this line of the CI log
    console.info(`[telemetry volume] 1 h at 30 decisions/min: routine ${line(routine.transport)}; every decision a detection ${line(noisy.transport)}; uncapped and unsampled ${line(full.transport)}`);
    expect(routine.sum.counts.decisions).toBe(1800);
    // detections are never sampled or capped: every decision a detection sends every record
    expect(noisy.sum.telemetry.decisionRecords).toBe(1800);
    expect(ofType(noisy.transport, "detect")).toHaveLength(1800);
    // summaries are not capped: about one a minute for the whole hour in every configuration
    for (const r of [routine, noisy, full]) expect(summaries(r.transport).length).toBeGreaterThanOrEqual(50);
    expect(Math.abs(bytes(noisy.transport) - bytes(full.transport)) / bytes(full.transport)).toBeLessThan(0.01);
    // TELEMETRY.md and RESULTS.md quote the CI measurement (the [telemetry volume] line) and this ceiling for routine
    // decisions; a page where every decision is a detection sends every record (about 2 MB for this hour)
    expect(bytes(routine.transport) / 1024).toBeLessThan(300);
  }, 120_000);
});

describe("telemetry: GenClass never observes its own requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses the fetch captured at module load, not the instrumented one", async () => {
    vi.resetModules();
    const calls: string[] = [];
    const fake = vi.fn((url: string) => {
      calls.push(String(url));
      return Promise.resolve(new Response("{}", { status: 202, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fake);
    resetTelemetryNotice();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const m = await import("../src/index.js");
    const clock = new FakeClock();
    const rt = m.createRuntime({
      clock,
      decider: null,
      report: "silent",
      telemetry: { endpoint: "https://collector.test/v1/events" },
      observe: { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false },
    }) as RuntimeImpl;
    expect((globalThis as { fetch: unknown }).fetch).not.toBe(fake); // instrumented by the runtime
    await rt.telemetry!.flush();
    expect(calls).toEqual(["https://collector.test/v1/events"]);
    expect(rt.history().filter((e) => e.kind === "op.start")).toHaveLength(0);
    await (globalThis as { fetch: typeof fetch }).fetch("https://app.test/api/items");
    expect(rt.history().filter((e) => e.kind === "op.start").map((e) => e.name)).toEqual([expect.stringContaining("/api/items")]);
    rt.destroy();
    vi.restoreAllMocks();
  });
});

describe("telemetry: a 429 or a 503 with a Retry-After is a back-off, not a failure (TELEMETRY.md, Transport)", () => {
  it("429 and 503 with a Retry-After back off; network errors, other statuses and 503 without one are failures", () => {
    expect(backoffOf(Object.assign(new Error("HTTP 429"), { status: 429 }))).toBeUndefined();
    expect(backoffOf({ status: 429, retryAfterMs: 5000 })).toBe(5000);
    expect(backoffOf({ status: 503, retryAfterMs: 2000 })).toBe(2000);
    expect(backoffOf({ status: 503 })).toBeNull();
    expect(backoffOf({ status: 500, retryAfterMs: 2000 })).toBeNull(); // a Retry-After on another status is ignored
    expect(backoffOf({ retryAfterMs: 2000 })).toBeNull();
    expect(backoffOf("HTTP 429")).toBeNull();
    expect(backoffOf(Object.assign(new Error("HTTP 500"), { status: 500 }))).toBeNull();
    expect(backoffOf(new Error("HTTP 500"))).toBeNull();
    expect(backoffOf(new TypeError("Failed to fetch"))).toBeNull();
    expect(backoffOf(undefined)).toBeNull();
    expect(retryAfterMs("120")).toBe(120_000);
    expect(retryAfterMs(" 3 ")).toBe(3000);
    expect(retryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT")).toBeUndefined(); // a date would need the wall clock
    expect(retryAfterMs(null)).toBeUndefined();
  });

  it("the default transport puts the status and a readable Retry-After on the error", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 429, headers: { "retry-after": "7" } }))));
    const t = await import("../src/telemetry/transport.js");
    await expect(t.nativeTransport.send("https://collector.test/v1/events", "{}", { beacon: false })).rejects.toMatchObject({ status: 429, retryAfterMs: 7000 });
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 500 }))));
    const t2 = await import("../src/telemetry/transport.js");
    const e = (await t2.nativeTransport.send("https://collector.test/v1/events", "{}", { beacon: false }).then(
      () => null,
      (x: unknown) => x,
    )) as { status?: number; retryAfterMs?: number };
    expect(e).toMatchObject({ status: 500 });
    expect(e.retryAfterMs).toBeUndefined();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("429s in a row do not stop the page (up to MAX_BACKOFFS): nothing is sent during the back-off, and the refused batch goes once accepted", async () => {
    let refuse = true;
    const sent: { events: Record<string, unknown>[] }[] = [];
    const accepted: { events: Record<string, unknown>[] }[] = [];
    const transport: TelemetryTransport = {
      send(_u, body) {
        const b = JSON.parse(body) as { events: Record<string, unknown>[] };
        sent.push(b);
        if (refuse) return Promise.reject(Object.assign(new Error("HTTP 429"), { status: 429 }));
        accepted.push(b);
        return Promise.resolve();
      },
    };
    const s = setup({ triage: "always", telemetry: { transport, decisionSample: 1 }, extraGlobal: { crypto: globalThis.crypto } });
    const a = s.rt.atom("a", 1);
    void s.rt.op("w", () => a.set(2));
    await s.clock.flush();
    await s.rt.telemetry!.flush();
    expect(sent).toHaveLength(1);
    await s.rt.telemetry!.flush(); // during the back-off: nothing
    expect(sent).toHaveLength(1);
    // BACKOFF_MS, doubling: four more 429s (more than MAX_FAIL_STREAK in a row)
    await s.clock.advance(BACKOFF_MS * (1 + 2 + 4 + 8) + 1000);
    expect(sent).toHaveLength(5);
    expect(sent.length).toBeGreaterThan(MAX_FAIL_STREAK);
    refuse = false;
    await s.clock.advance(300_000 + 1000);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    const evs = accepted.flatMap((b) => b.events);
    expect(evs[0]).toMatchObject({ t: "session", seq: 0 }); // the refused batch, in order
    expect(evs.filter((e) => e.t === "decision")).toHaveLength(1);
    // and the page keeps sending
    void s.rt.op("w2", () => a.set(3));
    await s.clock.flush();
    await s.rt.telemetry!.flush();
    expect(accepted.flatMap((b) => b.events).filter((e) => e.t === "decision")).toHaveLength(2);
    s.rt.destroy();
  });

  it("the back-off is BACKOFF_MS doubling, or a longer Retry-After, never more than MAX_BACKOFF_MS (a 0 s Retry-After does not make the page retry faster)", async () => {
    const replies: unknown[] = [{ status: 429, retryAfterMs: 0 }, { status: 503, retryAfterMs: 3_600_000 }, { status: 503, retryAfterMs: 200_000 }];
    const sent: number[] = [];
    const clockRef: { now?: () => number } = {};
    const transport: TelemetryTransport = {
      send() {
        sent.push(clockRef.now!());
        const r = replies.shift();
        return r ? Promise.reject(r) : Promise.resolve();
      },
    };
    const s = setup({ triage: "always", telemetry: { transport, flushMs: 1000, decisionSample: 1 }, extraGlobal: { crypto: globalThis.crypto } });
    clockRef.now = () => s.clock.now();
    const a = s.rt.atom("a", 1);
    void s.rt.op("w", () => a.set(2));
    await s.clock.flush();
    await s.rt.telemetry!.flush();
    await s.clock.advance(BACKOFF_MS + MAX_BACKOFF_MS + 200_000 + 5000);
    expect(sent).toHaveLength(4);
    // 0 s asked: the first back-off; an hour asked: the cap; 200 s asked (over the 120 s schedule): honoured
    expect(sent.slice(1).map((t, i) => t - sent[i])).toEqual([BACKOFF_MS, MAX_BACKOFF_MS, 200_000]);
    s.rt.destroy();
  });

  it(`back-offs are bounded: after ${MAX_BACKOFFS} in a row a refusal is a failure, and ${MAX_FAIL_STREAK} of those stop the page`, async () => {
    let mode: "retry" | "ok" = "retry";
    const sent: number[] = [];
    const clockRef: { now?: () => number } = {};
    const transport: TelemetryTransport = {
      send() {
        sent.push(clockRef.now!());
        // a dead collector behind a proxy that answers 503 with a Retry-After of 0
        return mode === "retry" ? Promise.reject({ status: 503, retryAfterMs: 0 }) : Promise.resolve();
      },
    };
    const s = setup({ triage: "always", telemetry: { transport, flushMs: 1000, decisionSample: 1 }, extraGlobal: { crypto: globalThis.crypto } });
    clockRef.now = () => s.clock.now();
    const a = s.rt.atom("a", 1);
    const step = async (i: number) => {
      void s.rt.op(`w${i}`, () => a.set(i + 2));
      await s.clock.flush();
    };
    await step(0);
    await s.rt.telemetry!.flush();
    // 30 s, 60 s, 120 s, 240 s, then 5 min four times: the ninth refusal is the first failure
    await s.clock.advance(BACKOFF_MS * (1 + 2 + 4 + 8) + 4 * MAX_BACKOFF_MS + 1000);
    expect(sent).toHaveLength(MAX_BACKOFFS + 1);
    expect(sent.slice(1).map((t, i) => t - sent[i])).toEqual([1, 2, 4, 8].map((k) => k * BACKOFF_MS).concat([1, 2, 3, 4].map(() => MAX_BACKOFF_MS)));
    for (const i of [1, 2]) {
      await step(i);
      await s.rt.telemetry!.flush();
    }
    expect(sent).toHaveLength(MAX_BACKOFFS + 3); // failures 2 and 3: the page stops
    mode = "ok";
    await step(3);
    await s.clock.advance(60_000);
    await s.rt.telemetry!.flush();
    expect(sent).toHaveLength(MAX_BACKOFFS + 3);
    s.rt.destroy();
  });

  it("a 5xx without a Retry-After is a failure: three in a row stop the page", async () => {
    const sent: number[] = [];
    const transport: TelemetryTransport = {
      send() {
        sent.push(0);
        return Promise.reject(Object.assign(new Error("HTTP 503"), { status: 503 }));
      },
    };
    const s = setup({ triage: "always", telemetry: { transport, flushMs: 1000, decisionSample: 1 }, extraGlobal: { crypto: globalThis.crypto } });
    const a = s.rt.atom("a", 1);
    for (const i of [0, 1, 2, 3]) {
      void s.rt.op(`w${i}`, () => a.set(i + 2));
      await s.clock.flush();
      await s.rt.telemetry!.flush();
    }
    expect(sent).toHaveLength(MAX_FAIL_STREAK);
    s.rt.destroy();
  });
});

describe("telemetry: a full queue drops routine decision records first (TELEMETRY.md, Volume)", () => {
  it("with the queue full of routine records, a detection and its decision record still go", async () => {
    const t = recorder();
    const s = setup({ triage: "always", mode: undefined, telemetry: { transport: t, decisionSample: 1, maxDecisions: Infinity }, extraGlobal: { crypto: globalThis.crypto } });
    const a = s.rt.atom("a", 0);
    // the clock never advances: nothing is flushed while the queue fills (as during a long back-off)
    for (let i = 0; i < MAX_QUEUE + 20; i++) {
      void s.rt.op("w", () => a.set(i + 1));
      if (i % 16 === 15) await s.clock.flush();
    }
    await s.clock.flush();
    s.decider.script = defaultScript({ mutation: { diagnosis: "stale", action: "discard" } });
    void s.rt.op("w", () => a.set(-1));
    await s.clock.flush();
    await s.rt.telemetry!.flush();
    const evs = events(t);
    const det = evs.find((e) => e.t === "detect");
    expect(det).toBeDefined();
    expect(evs.some((e) => e.t === "decision" && e.id === det!.decision && e.diagnosis === "stale")).toBe(true);
    expect(evs[0]).toMatchObject({ t: "session", seq: 0 }); // never evicted
    expect(evs.filter((e) => e.t === "decision").length).toBeLessThan(MAX_QUEUE);
    (s.rt.telemetry as unknown as { summary(r: string): void }).summary("periodic");
    await s.rt.telemetry!.flush();
    const sum = ofType(t, "summary").at(-1) as { telemetry: { dropped: number }; counts: { decisions: number } };
    expect(sum.counts.decisions).toBe(MAX_QUEUE + 21);
    expect(sum.telemetry.dropped).toBeGreaterThanOrEqual(22);
    s.rt.destroy();
  }, 60_000);
});

void createRuntime;

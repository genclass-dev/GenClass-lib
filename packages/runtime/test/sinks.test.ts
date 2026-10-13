// The sink adapters (@genclass/runtime/sinks/*; OPTIONS-SPEC §4.11, README "See it where you already look"): each
// forwards the runtime's SinkRecords to the SDK already on the page, never throws into the app, and sends nothing but
// the record's own fields (redacted evidence included, no situation text, no query values).
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_KINDS, signature, titleOf } from "../src/sinks/common.js";
import { consoleJson } from "../src/sinks/console-json.js";
import { datadog } from "../src/sinks/datadog.js";
import { posthog } from "../src/sinks/posthog.js";
import { sentry } from "../src/sinks/sentry.js";
import { WEBHOOK_MAX_BODY_BYTES, WEBHOOK_SCHEMA, webhook } from "../src/sinks/webhook.js";
import type { Sink, SinkRecord } from "../src/types.js";
import { RUNTIME_VERSION } from "../src/version.js";
import { FakeClock, defaultScript, setup } from "./helpers.js";

const DELAY = defaultScript({ request: { diagnosis: "overload", action: "delay" } });

function rec(over: Partial<SinkRecord> = {}): SinkRecord {
  return {
    schema: 1,
    kind: "detection",
    id: "r1",
    ts: 1000,
    sessionId: "S",
    tags: { release: "1.0" },
    mode: "observe",
    sampled: true,
    diagnosis: "stale",
    p: 0.93,
    trigger: "delivery",
    route: "/search",
    evidence: {
      message: "[GenClass] Flagged a stale response: search.results was written twice since its operation (#6) started. (stale, 0.93)",
      trigger: "delivery",
      subject: "response to GET /api/search?q=… (#6)",
      timeline: ["0.00s GET /api/search?q=… (#6)"],
    },
    ...over,
  };
}

/** A guard-mode runtime with the sinks; one request GenClass slows down (an intervention), with a query value to redact. */
async function intervene(sinks: Sink[]) {
  const s = setup({ sinks, triage: "always", script: DELAY });
  s.server.on("GET", "/api/x", { body: 1, latency: 5 });
  const p = s.fetch("/api/x?q=secret").catch(() => undefined);
  await s.clock.advance(2000);
  await p;
  await s.clock.advance(10);
  expect(s.rt.interventions().length).toBe(1);
  return s;
}

describe("sinks/sentry", () => {
  it("captureMessage at level warning: tags per diagnosis, mode and action, the record under extra, a fingerprint per bug", () => {
    const fake = { captureMessage: vi.fn(), addBreadcrumb: vi.fn() };
    const r = rec({ kind: "intervention", action: "discard", tier: "guard" });
    sentry({ sentry: fake }).send(r);
    expect(fake.captureMessage).toHaveBeenCalledTimes(1);
    expect(fake.addBreadcrumb).not.toHaveBeenCalled();
    const [message, ctx] = fake.captureMessage.mock.calls[0] as [string, { level: string; tags: Record<string, unknown>; extra: { genclass: Record<string, unknown> }; fingerprint: string[] }];
    expect(message).toBe(r.evidence!.message);
    expect(ctx.level).toBe("warning");
    expect(ctx.tags).toEqual({ genclass: "stale", "genclass.kind": "intervention", "genclass.mode": "observe", "genclass.action": "discard", "genclass.trigger": "delivery", "genclass.route": "/search" });
    expect(ctx.extra.genclass.message).toBe(r.evidence!.message);
    expect(ctx.extra.genclass.subject).toBe(r.evidence!.subject);
    expect(ctx.extra.genclass.timeline).toEqual(r.evidence!.timeline);
    expect(ctx.extra.genclass.evidence).toBeUndefined();
    expect(ctx.extra.genclass.sessionId).toBe("S");
    expect(ctx.fingerprint).toEqual(["genclass", signature(r)]);
    // op ids and numbers never split one bug into many issues
    expect(signature(rec({ evidence: { subject: "response to GET /api/search?q=… (#17)" } }))).toBe(signature(rec({ evidence: { subject: "response to GET /api/search?q=… (#3)" } })));
    expect(signature(rec({ diagnosis: "duplicate" }))).not.toBe(signature(rec()));
  });

  it("no SDK: nothing and no throw; a throwing SDK is contained; the SDK is looked up on every record, so a late load works", () => {
    const g: Record<string, unknown> = {};
    const s = sentry({ global: g });
    expect(() => s.send(rec())).not.toThrow();
    g.Sentry = {
      captureMessage: () => {
        throw new Error("x");
      },
    };
    expect(() => s.send(rec())).not.toThrow();
    const spy = vi.fn();
    g.Sentry = { captureMessage: spy };
    s.send(rec());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(() => sentry({ sentry: null as never }).send(rec())).not.toThrow();
    expect(() => sentry({ sentry: {} }).send(rec())).not.toThrow();
  });

  it("kinds default to everything but the summary; maxPerSignature caps repeats of one bug; as:'breadcrumb' files breadcrumbs only", () => {
    expect(sentry().kinds).toEqual(DEFAULT_KINDS);
    expect(sentry().kinds).not.toContain("summary");
    expect(sentry({ kinds: ["intervention"] }).kinds).toEqual(["intervention"]);
    expect(sentry({ sampleRate: 0.5 }).sampleRate).toBe(0.5);
    expect(sentry().evidence).toBe(true);
    const fake = { captureMessage: vi.fn() };
    const s = sentry({ sentry: fake });
    for (let i = 0; i < 12; i++) s.send(rec({ id: `r${i}` }));
    expect(fake.captureMessage).toHaveBeenCalledTimes(10);
    s.send(rec({ diagnosis: "duplicate" }));
    expect(fake.captureMessage).toHaveBeenCalledTimes(11);
    const unlimited = { captureMessage: vi.fn() };
    const u = sentry({ sentry: unlimited, maxPerSignature: 0 });
    for (let i = 0; i < 12; i++) u.send(rec());
    expect(unlimited.captureMessage).toHaveBeenCalledTimes(12);
    const crumbs = { captureMessage: vi.fn(), addBreadcrumb: vi.fn() };
    sentry({ sentry: crumbs, as: "breadcrumb", level: "info" }).send(rec());
    expect(crumbs.captureMessage).not.toHaveBeenCalled();
    expect(crumbs.addBreadcrumb).toHaveBeenCalledTimes(1);
    const crumb = crumbs.addBreadcrumb.mock.calls[0][0] as { category: string; level: string; message: string; data: Record<string, unknown> };
    expect(crumb.category).toBe("genclass");
    expect(crumb.level).toBe("info");
    expect(crumb.message).toBe(rec().evidence!.message);
    expect(crumb.data.diagnosis).toBe("stale");
    // an SDK without captureMessage (an old loader stub) still gets a breadcrumb
    const old = { addBreadcrumb: vi.fn() };
    sentry({ sentry: old }).send(rec());
    expect(old.addBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it("through the runtime: an intervention reaches Sentry as the console line, redacted, with its route", async () => {
    const fake = { captureMessage: vi.fn() };
    await intervene([sentry({ sentry: fake })]);
    expect(fake.captureMessage).toHaveBeenCalledTimes(1);
    const [message, ctx] = fake.captureMessage.mock.calls[0] as [string, { tags: Record<string, unknown>; extra: { genclass: Record<string, unknown> } }];
    expect(message).toMatch(/^\[GenClass\] Slowed down an overload request: /);
    expect(ctx.tags.genclass).toBe("overload");
    expect(ctx.tags["genclass.action"]).toBe("delay");
    expect(ctx.tags["genclass.kind"]).toBe("intervention");
    expect(ctx.tags["genclass.route"]).toBe("/search");
    expect(ctx.extra.genclass.route).toBe("/search");
    const text = JSON.stringify([message, ctx]);
    expect(text).toContain("/api/x");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("situationText");
  });
});

describe("sinks/posthog", () => {
  it("capture('genclass_<kind>', properties) with the record's fields flat and a per-bug signature", () => {
    const fake = { capture: vi.fn() };
    const r = rec();
    posthog({ posthog: fake }).send(r);
    expect(fake.capture).toHaveBeenCalledTimes(1);
    const [event, props] = fake.capture.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe("genclass_detection");
    expect(props.kind).toBe("detection");
    expect(props.diagnosis).toBe("stale");
    expect(props.p).toBe(0.93);
    expect(props.route).toBe("/search");
    expect(props.message).toBe(r.evidence!.message);
    expect(props.subject).toBe(r.evidence!.subject);
    expect(props.timeline).toEqual(r.evidence!.timeline);
    expect(props.evidence).toBeUndefined();
    expect(props.sessionId).toBe("S");
    expect(props.tags).toEqual({ release: "1.0" });
    expect(props.signature).toBe(signature(r));
    expect(posthog().kinds).toEqual(DEFAULT_KINDS);
  });

  it("the snippet's pre-init stub works; no client, or one without capture, sends nothing and never throws; prefix", () => {
    const g: Record<string, unknown> = {};
    const s = posthog({ global: g });
    expect(() => s.send(rec())).not.toThrow();
    g.posthog = {};
    expect(() => s.send(rec())).not.toThrow();
    const stub = Object.assign([] as unknown[], { capture: vi.fn() });
    g.posthog = stub;
    s.send(rec({ kind: "intervention" }));
    expect(stub.capture).toHaveBeenCalledWith("genclass_intervention", expect.objectContaining({ kind: "intervention" }));
    const fake = { capture: vi.fn() };
    posthog({ posthog: fake, prefix: "gc:" }).send(rec());
    expect(fake.capture.mock.calls[0][0]).toBe("gc:detection");
    const bad = {
      capture: () => {
        throw new Error("x");
      },
    };
    expect(() => posthog({ posthog: bad }).send(rec())).not.toThrow();
    const capped = { capture: vi.fn() };
    const c = posthog({ posthog: capped, maxPerSignature: 2 });
    for (let i = 0; i < 5; i++) c.send(rec());
    expect(capped.capture).toHaveBeenCalledTimes(2);
  });

  it("through the runtime: an intervention is one genclass_intervention event, redacted", async () => {
    const fake = { capture: vi.fn() };
    await intervene([posthog({ posthog: fake })]);
    expect(fake.capture).toHaveBeenCalledTimes(1);
    const [event, props] = fake.capture.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe("genclass_intervention");
    expect(props.action).toBe("delay");
    expect(props.diagnosis).toBe("overload");
    expect(String(props.message)).toMatch(/^\[GenClass\] Slowed down/);
    expect(JSON.stringify(props)).not.toContain("secret");
  });
});

describe("sinks/datadog", () => {
  it("detections and interventions are RUM errors named GenClassDetection / GenClassIntervention; undo, breaker and errors are actions", () => {
    const rum = { addError: vi.fn(), addAction: vi.fn() };
    const d = datadog({ rum });
    d.send(rec());
    expect(rum.addError).toHaveBeenCalledTimes(1);
    const [err, ctx] = rum.addError.mock.calls[0] as [Error, { genclass: Record<string, unknown> }];
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GenClassDetection");
    expect(err.message).toBe(titleOf(rec()));
    expect(ctx.genclass.diagnosis).toBe("stale");
    expect(ctx.genclass.message).toBe(rec().evidence!.message);
    expect(ctx.genclass.signature).toBe(signature(rec()));
    d.send(rec({ kind: "intervention", action: "discard" }));
    expect((rum.addError.mock.calls[1][0] as Error).name).toBe("GenClassIntervention");
    d.send(rec({ kind: "undo", undone: true }));
    d.send(rec({ kind: "breaker" }));
    d.send(rec({ kind: "error" }));
    expect(rum.addAction.mock.calls.map((c) => c[0])).toEqual(["genclass_undo", "genclass_breaker", "genclass_error"]);
    expect((rum.addAction.mock.calls[0][1] as { genclass: Record<string, unknown> }).genclass.kind).toBe("undo");
    expect(datadog().kinds).toEqual(DEFAULT_KINDS);
  });

  it("as:'action' sends everything as actions; the async stub's onReady is honoured; no SDK: nothing, never throws", () => {
    const rum = { addError: vi.fn(), addAction: vi.fn() };
    datadog({ rum, as: "action" }).send(rec());
    expect(rum.addError).not.toHaveBeenCalled();
    expect(rum.addAction).toHaveBeenCalledWith("genclass_detection", expect.objectContaining({ genclass: expect.objectContaining({ diagnosis: "stale" }) }));
    const stub: { onReady: ReturnType<typeof vi.fn>; addError?: ReturnType<typeof vi.fn> } = { onReady: vi.fn() };
    datadog({ rum: stub }).send(rec());
    expect(stub.onReady).toHaveBeenCalledTimes(1);
    stub.addError = vi.fn();
    (stub.onReady.mock.calls[0][0] as () => void)();
    expect(stub.addError).toHaveBeenCalledTimes(1);
    expect(() => datadog({ global: {} }).send(rec())).not.toThrow();
    expect(() => datadog({ rum: {} }).send(rec())).not.toThrow();
    const bad = {
      addError: () => {
        throw new Error("x");
      },
    };
    expect(() => datadog({ rum: bad }).send(rec())).not.toThrow();
  });

  it("through the runtime: an intervention is one GenClassIntervention error, redacted", async () => {
    const rum = { addError: vi.fn(), addAction: vi.fn() };
    await intervene([datadog({ rum })]);
    expect(rum.addError).toHaveBeenCalledTimes(1);
    expect(rum.addAction).not.toHaveBeenCalled();
    const [err, ctx] = rum.addError.mock.calls[0] as [Error, { genclass: Record<string, unknown> }];
    expect(err.name).toBe("GenClassIntervention");
    expect(err.message).toMatch(/^\[GenClass\] Slowed down/);
    expect(ctx.genclass.action).toBe("delay");
    expect(JSON.stringify(ctx)).not.toContain("secret");
  });
});

describe("sinks/console-json", () => {
  it("one JSON line per record with source first, every kind (the summary too), on the chosen method", () => {
    const con = { log: vi.fn(), warn: vi.fn() };
    const s = consoleJson({ console: con });
    expect(s.kinds).toBeUndefined();
    expect(s.evidence).toBe(true);
    s.send(rec());
    expect(con.log).toHaveBeenCalledTimes(1);
    const line = con.log.mock.calls[0][0] as string;
    expect(typeof line).toBe("string");
    expect(line.includes("\n")).toBe(false);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed)[0]).toBe("source");
    expect(parsed.source).toBe("genclass");
    expect(parsed.schema).toBe(1);
    expect(parsed.kind).toBe("detection");
    expect((parsed.evidence as { message: string }).message).toBe(rec().evidence!.message);
    s.send(rec({ kind: "summary", summary: { startedAt: 0, durationMs: 1, detections: { stale: 1 }, interventions: {}, undos: 0, lateReverts: 0, denied: {}, shadow: {}, model: { state: "ready", decisions: 1, dropped: 0, hiddenSkipped: 0 }, heldMs: { total: 0, max: 0 }, errors: 0 } }));
    expect(con.log).toHaveBeenCalledTimes(2);
    expect((JSON.parse(con.log.mock.calls[1][0] as string) as { summary: { detections: Record<string, number> } }).summary.detections.stale).toBe(1);
    consoleJson({ console: con, method: "warn" }).send(rec());
    expect(con.warn).toHaveBeenCalledTimes(1);
  });

  it("no console: nothing and no throw; a throwing console is contained", () => {
    expect(() => consoleJson({ global: {} }).send(rec())).not.toThrow();
    const con = {
      log: () => {
        throw new Error("x");
      },
    };
    expect(() => consoleJson({ console: con }).send(rec())).not.toThrow();
    // a method that is missing falls back to log
    const only = { log: vi.fn() };
    consoleJson({ console: only, method: "info" }).send(rec());
    expect(only.log).toHaveBeenCalledTimes(1);
  });

  it("through the runtime: the intervention's line parses and holds no query value", async () => {
    const con = { log: vi.fn() };
    await intervene([consoleJson({ console: con })]);
    const lines = con.log.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, unknown>);
    const iv = lines.find((l) => l.kind === "intervention")!;
    expect(iv).toBeDefined();
    expect(iv.action).toBe("delay");
    expect(iv.route).toBe("/search");
    expect(JSON.stringify(lines)).not.toContain("secret");
  });
});

describe("sinks/webhook", () => {
  it("batches: sent flushMs after the first record, at maxBatch, and on flush(); the body is the records and nothing else", async () => {
    const clock = new FakeClock();
    const send = vi.fn();
    const w = webhook({ url: "/genclass", send, clock, flushMs: 5000 });
    expect(w.kinds).toBeUndefined(); // every kind, the summary included
    expect(w.evidence).toBe(true);
    w.send(rec());
    w.send(rec({ id: "r2" }));
    expect(send).not.toHaveBeenCalled();
    await clock.advance(4999);
    expect(send).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, body] = send.mock.calls[0] as [string, string];
    expect(url).toBe("/genclass");
    const parsed = JSON.parse(body) as { schema: string; version: string; records: SinkRecord[] };
    expect(Object.keys(parsed)).toEqual(["schema", "version", "records"]);
    expect(parsed.schema).toBe(WEBHOOK_SCHEMA);
    expect(parsed.version).toBe(RUNTIME_VERSION);
    expect(parsed.records).toEqual([rec(), rec({ id: "r2" })]);
    expect(clock.pending).toBe(0);
    // maxBatch: sent at once, no timer left behind
    const fast = webhook({ url: "/genclass", send, clock, maxBatch: 2 });
    fast.send(rec());
    expect(send).toHaveBeenCalledTimes(1);
    fast.send(rec());
    expect(send).toHaveBeenCalledTimes(2);
    expect(clock.pending).toBe(0);
    // flush(): sent now, the pending timer cleared
    w.send(rec({ id: "r3" }));
    expect(clock.pending).toBe(1);
    await w.flush!();
    expect(send).toHaveBeenCalledTimes(3);
    expect(clock.pending).toBe(0);
    await w.flush!(); // nothing queued: no empty POST
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("transport: navigator.sendBeacon first, else fetch keepalive as text/plain; headers force fetch; failures are dropped", async () => {
    const clock = new FakeClock();
    const g: Record<string, unknown> = { navigator: { sendBeacon: vi.fn(() => true) }, fetch: vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))) };
    const beacon = (g.navigator as { sendBeacon: ReturnType<typeof vi.fn> }).sendBeacon;
    const fetchSpy = g.fetch as ReturnType<typeof vi.fn>;
    const w = webhook({ url: "https://hooks.example/genclass", clock, global: g, flushMs: 100 });
    w.send(rec());
    await clock.advance(100);
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0][0]).toBe("https://hooks.example/genclass");
    expect(typeof beacon.mock.calls[0][1]).toBe("string");
    expect(fetchSpy).not.toHaveBeenCalled();
    // the browser refuses the beacon: fetch with keepalive, a CORS simple request
    beacon.mockReturnValue(false);
    w.send(rec());
    await clock.advance(100);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://hooks.example/genclass");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(init.headers["content-type"]).toMatch(/^text\/plain/);
    expect(JSON.parse(init.body as string).records.length).toBe(1);
    // headers: sendBeacon cannot carry them, so fetch is used
    beacon.mockReturnValue(true);
    const h = webhook({ url: "/genclass", clock, global: g, flushMs: 100, headers: { authorization: "Bearer t" } });
    h.send(rec());
    await clock.advance(100);
    expect(beacon).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((fetchSpy.mock.calls[1][1] as { headers: Record<string, string> }).headers.authorization).toBe("Bearer t");
    // a throwing beacon and a rejecting fetch: nothing escapes
    beacon.mockImplementation(() => {
      throw new Error("x");
    });
    fetchSpy.mockImplementation(() => Promise.reject(new Error("offline")));
    w.send(rec());
    await expect(w.flush!()).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // neither available: nothing, no throw
    const none = webhook({ url: "/genclass", clock, global: {}, flushMs: 100 });
    none.send(rec());
    await expect(none.flush!()).resolves.toBeUndefined();
    // a transport that throws synchronously
    const thrower = webhook({
      url: "/genclass",
      clock,
      send: () => {
        throw new Error("x");
      },
    });
    thrower.send(rec());
    await expect(thrower.flush!()).resolves.toBeUndefined();
    // no url: nothing is queued or sent
    const noUrl = webhook({ url: "", clock, send: fetchSpy });
    noUrl.send(rec());
    await noUrl.flush!();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("a batch is split before it exceeds what sendBeacon accepts; an unserialisable record is skipped, not its batch", async () => {
    const clock = new FakeClock();
    const send = vi.fn();
    const w = webhook({ url: "/genclass", send, clock, flushMs: 100, maxBatch: 500 });
    const big = "x".repeat(30_000);
    for (let i = 0; i < 4; i++) w.send(rec({ id: `r${i}`, evidence: { message: big } }));
    await clock.advance(100);
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
    let total = 0;
    for (const [, body] of send.mock.calls as [string, string][]) {
      expect(body.length).toBeLessThan(65_536);
      expect(body.length).toBeLessThan(WEBHOOK_MAX_BODY_BYTES + 200);
      total += (JSON.parse(body) as { records: unknown[] }).records.length;
    }
    expect(total).toBe(4);
    send.mockClear();
    w.send(rec({ id: "a" }));
    w.send(rec({ id: "bad", tags: { n: BigInt(1) as never } }));
    w.send(rec({ id: "c" }));
    await clock.advance(100);
    expect(send).toHaveBeenCalledTimes(1);
    expect((JSON.parse(send.mock.calls[0][1] as string) as { records: { id: string }[] }).records.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("through the runtime: the POST holds the record's own fields (route, diagnosis, action, evidence) and no page text or query value", async () => {
    const send = vi.fn();
    const s = await intervene([webhook({ url: "/genclass", send, maxBatch: 1 })]);
    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(send.mock.calls[0][1] as string) as { records: SinkRecord[] };
    const r = body.records[0];
    expect(r.kind).toBe("intervention");
    expect(r.diagnosis).toBe("overload");
    expect(r.action).toBe("delay");
    expect(r.route).toBe("/search");
    expect(r.mode).toBe("guard");
    expect(r.evidence!.message).toMatch(/^\[GenClass\] Slowed down an overload request/);
    expect(r.evidence!.subject).toContain("/api/x");
    const text = send.mock.calls[0][1] as string;
    expect(text).not.toContain("secret");
    expect(text).not.toContain("situationText");
    const allowed = new Set(["schema", "kind", "id", "ts", "sessionId", "tags", "correlationId", "mode", "sampled", "diagnosis", "p", "action", "tier", "trigger", "label", "route", "changed", "undone", "shadow", "reason", "summary", "evidence"]);
    for (const k of Object.keys(r)) expect(allowed.has(k), k).toBe(true);
    void s;
  });

  it("the fetch fallback to a URL in requests.ignore passes through GenClass unobserved", async () => {
    // the sink is built before the runtime, so its global is a holder the test fills with the runtime's (wrapped) fetch
    const holder: Record<string, unknown> = {};
    const w = webhook({ url: "/genclass", global: holder, maxBatch: 1 });
    const s = setup({ sinks: [w], requests: { ignore: ["/genclass"] }, triage: "always", script: DELAY });
    holder.fetch = (u: string, i?: RequestInit) => (s.g.fetch as typeof fetch)(u, i);
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    s.server.on("POST", "/genclass", { status: 204, latency: 1 });
    const p = s.fetch("/api/x").catch(() => undefined);
    await s.clock.advance(2000);
    await p;
    await s.clock.advance(50);
    expect(s.rt.interventions().length).toBe(1);
    expect(s.server.log.some((e) => e.method === "POST" && e.path === "/genclass")).toBe(true);
    expect(s.rt.decisions().every((d) => !d.subject.includes("/genclass"))).toBe(true);
    expect(s.rt.history().every((e) => !JSON.stringify(e).includes("/genclass"))).toBe(true);
  });
});

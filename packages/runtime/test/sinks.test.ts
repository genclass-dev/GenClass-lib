// The sink adapters (@genclass/runtime/sinks/*; OPTIONS-SPEC §4.11, README "See it where you already look"): each
// forwards the runtime's SinkRecords to the SDK already on the page, never throws into the app, and sends nothing but
// the record's own fields (redacted evidence included unless `evidence: false`, no situation text, no query values).
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_KINDS, signature, titleOf } from "../src/sinks/common.js";
import { consoleJson } from "../src/sinks/console-json.js";
import { datadog } from "../src/sinks/datadog.js";
import { posthog } from "../src/sinks/posthog.js";
import { sentry } from "../src/sinks/sentry.js";
import { WEBHOOK_MAX_BODY_BYTES, WEBHOOK_SCHEMA, utf8Length, webhook } from "../src/sinks/webhook.js";
import type { Sink, SinkRecord } from "../src/types.js";
import { RUNTIME_VERSION } from "../src/version.js";
import { FakeClock, defaultScript, drain, setup } from "./helpers.js";

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
    // nor do ids with letters in the request's path (UUIDs, hex, tokens, slug ids, emails): one issue per bug, not per entity
    const on = (path: string) => signature(rec({ evidence: { subject: `response to GET ${path}?q=… (#4)` } }));
    expect(on("/api/orders/550e8400-e29b-41d4-a716-446655440000")).toBe(on("/api/orders/7c9e6679-7425-40de-944b-e07fc1f90ae7"));
    expect(on("/api/orders/5f3a9c0e1b2d")).toBe(on("/api/orders/a1b2c3d4e5f6"));
    expect(on("/api/users/ann%40example.com/cart")).toBe(on("/api/users/bob@example.org/cart"));
    expect(on("/api/tasks/tasks-1cam")).toBe(on("/api/tasks/x7k2p"));
    expect(on("/api/s/AbCdEfGhIjKlMnOp12")).toBe(on("/api/s/ZyXwVuTsRqPoNmLk34"));
    expect(on("/api/orders/550e8400-e29b-41d4-a716-446655440000")).toContain("GET /api/orders/:id?q=… (#)");
    // a route stays itself: another endpoint, a version or a word with a number is not an id
    expect(on("/api/orders/550e8400-e29b-41d4-a716-446655440000")).not.toBe(on("/api/carts/550e8400-e29b-41d4-a716-446655440000"));
    expect(on("/api/v2/sha256/item42/report.pdf")).toContain("GET /api/vn/shan/itemn/report.pdf?q=…");
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
    expect(() => sentry({ sentry: null as never, global: {} }).send(rec())).not.toThrow();
    expect(() => sentry({ sentry: {} }).send(rec())).not.toThrow();
  });

  it("no SDK when records arrive (an npm SDK sets no global): one console warning that names the fix, per adapter", () => {
    for (const [make, fix] of [
      [sentry, "sentry({ sentry: Sentry })"],
      [posthog, "posthog({ posthog })"],
      [datadog, "datadog({ rum: datadogRum })"],
    ] as const) {
      const warn = vi.fn();
      const g: Record<string, unknown> = { console: { warn } };
      const s = make({ global: g });
      s.send(rec());
      s.send(rec({ id: "r2", diagnosis: "duplicate" }));
      expect(warn, make.name).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0]), make.name).toMatch(/^\[GenClass\] The \w+ sink found no /);
      expect(String(warn.mock.calls[0][0]), make.name).toContain(fix);
      // a console that throws is contained
      const t = make({ global: { console: { warn: () => { throw new Error("x"); } } } });
      expect(() => t.send(rec()), make.name).not.toThrow();
    }
    // with an SDK there is no warning
    const warn = vi.fn();
    sentry({ global: { console: { warn }, Sentry: { captureMessage: vi.fn() } } }).send(rec());
    expect(warn).not.toHaveBeenCalled();
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

  it("the record's route is normalised as telemetry's: id-like and email segments as :id, at most 200 chars", async () => {
    const fake = { captureMessage: vi.fn() };
    const s = setup({
      sinks: [sentry({ sentry: fake })],
      triage: "always",
      script: DELAY,
      extraGlobal: { location: { href: "http://app.test/u/jane@example.com/reset/a8f3b2c9d1e04f5a/orders/12345", pathname: "/u/jane@example.com/reset/a8f3b2c9d1e04f5a/orders/12345", search: "" } },
    });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    const p = s.fetch("/api/x").catch(() => undefined);
    await s.clock.advance(2000);
    await p;
    await s.clock.advance(10);
    expect(fake.captureMessage).toHaveBeenCalledTimes(1);
    const ctx = fake.captureMessage.mock.calls[0][1] as { tags: Record<string, unknown>; extra: { genclass: Record<string, unknown> } };
    expect(ctx.tags["genclass.route"]).toBe("/u/:id/reset/:id/orders/:id");
    expect(ctx.extra.genclass.route).toBe("/u/:id/reset/:id/orders/:id");
    expect(JSON.stringify(ctx)).not.toContain("jane");
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

  it("evidence: false sends the structured fields only (every adapter takes it; default true)", async () => {
    for (const make of [sentry, posthog, datadog, consoleJson]) {
      expect(make().evidence, make.name).toBe(true);
      expect(make({ evidence: false }).evidence, make.name).toBe(false);
    }
    expect(webhook({ url: "/g" }).evidence).toBe(true);
    expect(webhook({ url: "/g", evidence: false }).evidence).toBe(false);
    const fake = { captureMessage: vi.fn() };
    await intervene([sentry({ sentry: fake, evidence: false })]);
    expect(fake.captureMessage).toHaveBeenCalledTimes(1);
    const [message, ctx] = fake.captureMessage.mock.calls[0] as [string, { tags: Record<string, unknown>; extra: { genclass: Record<string, unknown> } }];
    expect(message).toBe("[GenClass] intervention: overload request (delay)");
    expect(ctx.tags.genclass).toBe("overload");
    expect(ctx.extra.genclass.route).toBe("/search");
    for (const k of ["message", "subject", "timeline", "evidence"]) expect(ctx.extra.genclass[k], k).toBeUndefined();
    expect(JSON.stringify([message, ctx])).not.toContain("/api/x");
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
  it("without a clock: the records of one delivery round go in one POST, a microtask after the round", async () => {
    const send = vi.fn();
    const w = webhook({ url: "/genclass", send });
    w.send(rec());
    w.send(rec({ id: "r2" }));
    w.send(rec({ id: "r3" }));
    expect(send).not.toHaveBeenCalled();
    await drain(1);
    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.parse(send.mock.calls[0][1] as string) as { version: string; records: SinkRecord[] };
    expect(body.records.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(body.version).toBe(RUNTIME_VERSION);
    // a later round is its own POST; flush() before the microtask sends at once, and only once
    w.send(rec({ id: "r4" }));
    await w.flush!();
    expect(send).toHaveBeenCalledTimes(2);
    await drain(1);
    expect(send).toHaveBeenCalledTimes(2);
    // through the runtime, with the defaults: the intervention arrives without a timer
    const rt = vi.fn();
    await intervene([webhook({ url: "/genclass", send: rt })]);
    await drain();
    expect(rt).toHaveBeenCalled();
    expect((JSON.parse(rt.mock.calls[0][1] as string) as { records: SinkRecord[] }).records.some((r) => r.kind === "intervention")).toBe(true);
  });

  it("with a clock: sent flushMs after the first record, at maxBatch, and on flush(); the body is the records and nothing else", async () => {
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

  it("a batch is split before it exceeds what sendBeacon accepts, one POST per round; an unserialisable record is skipped, not its batch", async () => {
    const clock = new FakeClock();
    const send = vi.fn();
    const w = webhook({ url: "/genclass", send, clock, flushMs: 100, maxBatch: 500 });
    const big = "x".repeat(30_000);
    for (let i = 0; i < 4; i++) w.send(rec({ id: `r${i}`, evidence: { message: big } }));
    await clock.advance(100);
    // one ~30 KB record per POST, and one POST per round: the rest waits flushMs for the next round, oldest first
    expect(send).toHaveBeenCalledTimes(1);
    await clock.advance(99);
    expect(send).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    expect(send).toHaveBeenCalledTimes(2);
    await clock.advance(200);
    expect(send).toHaveBeenCalledTimes(4);
    expect(clock.pending).toBe(0);
    expect((send.mock.calls as [string, string][]).map(([, b]) => (JSON.parse(b) as { records: { id: string }[] }).records.map((r) => r.id))).toEqual([["r0"], ["r1"], ["r2"], ["r3"]]);
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

  it("the split counts UTF-8 bytes, not UTF-16 units: non-ASCII evidence never makes a body the browser refuses", async () => {
    expect([utf8Length("a"), utf8Length("é"), utf8Length("測"), utf8Length("😀"), utf8Length(JSON.stringify("\ud800"))]).toEqual([1, 2, 3, 4, 8]);
    const clock = new FakeClock();
    const send = vi.fn();
    const w = webhook({ url: "/genclass", send, clock, flushMs: 100, maxBatch: 500, maxPerSignature: 0 });
    // 12,000 CJK characters: 12,000 UTF-16 units but 36,000 bytes each
    for (let i = 0; i < 3; i++) w.send(rec({ id: `r${i}`, evidence: { message: "測".repeat(12_000) } }));
    for (let i = 0; i < 20; i++) w.send(rec({ id: `s${i}`, evidence: { message: "é".repeat(1_000) } }));
    await clock.advance(1_000); // one POST per round, flushMs apart
    expect(clock.pending).toBe(0);
    let total = 0;
    for (const [, body] of send.mock.calls as [string, string][]) {
      const recs = (JSON.parse(body) as { records: unknown[] }).records;
      total += recs.length;
      expect(utf8Length(body)).toBeLessThan(65_536);
      // a body over the cap is a lone record that is itself that large; anything batched stays under it
      if (recs.length > 1) expect(utf8Length(body)).toBeLessThan(WEBHOOK_MAX_BODY_BYTES + 200);
    }
    expect(total).toBe(23);
    expect(WEBHOOK_MAX_BODY_BYTES).toBeLessThanOrEqual(32_768);
  });

  it("one POST per round: a storm larger than one beacon never takes the page's keepalive budget; flush() sends one batch and drops the rest", async () => {
    // a browser's quota: 64 KiB of sendBeacon / keepalive bodies in flight per page, shared with the app's own beacons
    let inflight = 0;
    let refused = 0;
    const flying: number[] = [];
    const quota = (body: string): boolean => {
      const n = utf8Length(body);
      if (inflight + n > 65_536) {
        refused++;
        return false;
      }
      inflight += n;
      flying.push(n);
      return true;
    };
    const land = () => {
      for (const n of flying.splice(0)) inflight -= n;
    };
    const sendBeacon = vi.fn((_url: string, body: string) => quota(body));
    // no fetch: a refused beacon would be dropped, so a refusal shows up in `refused`
    const w = webhook({ url: "/genclass", global: { navigator: { sendBeacon } }, maxPerSignature: 0, maxBatch: 500 });
    const ids = () => sendBeacon.mock.calls.map(([, b]) => (JSON.parse(b) as { records: SinkRecord[] }).records.map((r) => r.id));
    // about 175 KB of records in one delivery round (40 of about 4.4 KB)
    for (let i = 0; i < 40; i++) w.send(rec({ id: `r${i}`, evidence: { message: "x".repeat(4_000) } }));
    await drain(1);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(inflight).toBeLessThanOrEqual(WEBHOOK_MAX_BODY_BYTES + 200);
    expect(quota("y".repeat(30_000))).toBe(true); // the app's own beacon in the same moment still fits
    land();
    // the next round sends the next batch, where the first one stopped, and again only one
    w.send(rec({ id: "n1", evidence: { message: "x".repeat(4_000) } }));
    await drain(1);
    expect(sendBeacon).toHaveBeenCalledTimes(2);
    expect(ids()[1][0]).toBe(`r${ids()[0].length}`);
    land();
    // page exit: one batch, the session summary first; what is left is dropped, and the app's pagehide beacon still goes
    w.send(rec({ id: "sum", kind: "summary" }));
    await w.flush!();
    expect(sendBeacon).toHaveBeenCalledTimes(3);
    expect(ids()[2][0]).toBe("sum");
    expect(quota("y".repeat(30_000))).toBe(true);
    await drain(2);
    w.send(rec({ id: "later" }));
    await drain(1);
    expect(ids()[3]).toEqual(["later"]); // nothing left over from before the flush
    expect(refused).toBe(0);
    const all = ids().flat();
    expect(new Set(all).size).toBe(all.length); // nothing sent twice
    expect(all.length).toBeLessThan(43); // three batches of about 32 KB cannot hold 175 KB: the rest was dropped at exit
    for (const [, b] of sendBeacon.mock.calls) expect(utf8Length(b)).toBeLessThan(WEBHOOK_MAX_BODY_BYTES + 200);
  });

  it("without a clock, a transport that says when it is done (fetch, or a send returning a promise) carries the rest on when it settles", async () => {
    const done: (() => void)[] = [];
    const send = vi.fn(() => new Promise<void>((r) => done.push(r)));
    const w = webhook({ url: "/genclass", send, maxBatch: 2 });
    for (let i = 0; i < 5; i++) w.send(rec({ id: `r${i}` }));
    await drain(1);
    expect(send).toHaveBeenCalledTimes(1);
    done.shift()!();
    await drain(1);
    expect(send).toHaveBeenCalledTimes(2);
    done.shift()!();
    await drain(1);
    expect(send).toHaveBeenCalledTimes(3);
    done.shift()!();
    await drain(1);
    expect(send).toHaveBeenCalledTimes(3);
    const ids = (send.mock.calls as unknown as [string, string][]).map(([, b]) => (JSON.parse(b) as { records: { id: string }[] }).records.map((r) => r.id));
    expect(ids).toEqual([["r0", "r1"], ["r2", "r3"], ["r4"]]);
  });

  it("caps repeats of one bug at maxPerSignature (10) per page load, like the tool adapters; the summary always goes; 0 = no cap", async () => {
    const send = vi.fn();
    const w = webhook({ url: "/genclass", send, maxBatch: 500 });
    for (let i = 0; i < 25; i++) w.send(rec({ id: `r${i}` }));
    w.send(rec({ id: "d", diagnosis: "duplicate" }));
    w.send(rec({ id: "sum", kind: "summary" }));
    await w.flush!();
    const ids = (send.mock.calls as [string, string][]).flatMap(([, b]) => (JSON.parse(b) as { records: SinkRecord[] }).records.map((r) => r.id));
    expect(ids.filter((id) => id.startsWith("r"))).toHaveLength(10);
    expect(ids).toContain("d");
    expect(ids).toContain("sum");
    // ids with letters in the path are one bug too: 25 orders' UUIDs share one cap
    const uu = vi.fn();
    const v = webhook({ url: "/genclass", send: uu, maxBatch: 500 });
    for (let i = 0; i < 25; i++) v.send(rec({ id: `u${i}`, evidence: { subject: `response to GET /api/orders/${(0x10000000 + i * 7919).toString(16)}-e29b-41d4-a716-446655440000 (#${i})` } }));
    await v.flush!();
    expect((JSON.parse(uu.mock.calls[0][1] as string) as { records: unknown[] }).records).toHaveLength(10);
    const all = vi.fn();
    const u = webhook({ url: "/genclass", send: all, maxBatch: 500, maxPerSignature: 0 });
    for (let i = 0; i < 25; i++) u.send(rec({ id: `r${i}` }));
    await u.flush!();
    expect((JSON.parse(all.mock.calls[0][1] as string) as { records: unknown[] }).records).toHaveLength(25);
  });

  it("through the runtime: the POST holds the record's own fields (route, diagnosis, action, evidence), no situation text and no query value", async () => {
    const send = vi.fn();
    const s = await intervene([webhook({ url: "/genclass", send, maxBatch: 1 })]);
    await drain();
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
    // evidence: false: the same record without the evidence text
    const bare = vi.fn();
    await intervene([webhook({ url: "/genclass", send: bare, maxBatch: 1, evidence: false })]);
    await drain();
    const r2 = (JSON.parse(bare.mock.calls[0][1] as string) as { records: SinkRecord[] }).records[0];
    expect(r2.kind).toBe("intervention");
    expect(r2.route).toBe("/search");
    expect(r2.evidence).toBeUndefined();
    expect(bare.mock.calls[0][1] as string).not.toContain("/api/x");
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

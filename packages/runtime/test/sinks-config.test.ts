// Sinks by name in the zero-code entries (src/cdn/sinks.ts, src/cdn/config.ts; README "See it where you already
// look"): a name in the meta tag, the script tag's data-sink or window.GENCLASS_CONFIG becomes a lazy adapter, the
// records queued while its module loads are handed over, and a webhook URL joins requests.ignore.
import { describe, expect, it, vi } from "vitest";
import { fromDataset, fromPairs, mergeConfig, parsePairs, readMetaConfig, splitConfig } from "../src/cdn/config.js";
import { SINK_NAMES, applySinks, lazySink, parseSinkList, parseSinkSpec, type SinkLoader, type SinkModule } from "../src/cdn/sinks.js";
import { sentry } from "../src/sinks/sentry.js";
import type { SinkObject, SinkRecord } from "../src/types.js";
import { defaultScript, drain, setup } from "./helpers.js";

const DELAY = defaultScript({ request: { diagnosis: "overload", action: "delay" } });

function rec(over: Partial<SinkRecord> = {}): SinkRecord {
  return { schema: 1, kind: "detection", id: "r1", ts: 1000, sessionId: "S", tags: {}, mode: "observe", sampled: true, diagnosis: "stale", evidence: { message: "[GenClass] Flagged a stale response" }, ...over };
}

const moduleOf = (sink: SinkObject): SinkModule => ({ default: () => sink });

describe("sink names (cdn/sinks.ts)", () => {
  it("parseSinkSpec: the five names, case and spelling variants, webhook:<url> / webhook=<url>; anything else is null", () => {
    expect(SINK_NAMES).toEqual(["sentry", "posthog", "datadog", "console-json", "webhook"]);
    expect(parseSinkSpec("sentry")).toEqual({ name: "sentry" });
    expect(parseSinkSpec(" PostHog ")).toEqual({ name: "posthog" });
    expect(parseSinkSpec("datadog")).toEqual({ name: "datadog" });
    for (const v of ["console-json", "console_json", "consoleJson", "CONSOLE-JSON"]) expect(parseSinkSpec(v), v).toEqual({ name: "console-json" });
    expect(parseSinkSpec("webhook:/genclass")).toEqual({ name: "webhook", arg: "/genclass" });
    expect(parseSinkSpec("webhook=https://hooks.example/g?k=v")).toEqual({ name: "webhook", arg: "https://hooks.example/g?k=v" });
    expect(parseSinkSpec("webhook")).toBeNull();
    expect(parseSinkSpec("webhook:")).toBeNull();
    expect(parseSinkSpec("bogus")).toBeNull();
    expect(parseSinkSpec("")).toBeNull();
    expect(parseSinkSpec(42)).toBeNull();
    expect(parseSinkSpec(null)).toBeNull();
    expect(parseSinkSpec("sentry:x")).toEqual({ name: "sentry", arg: "x" });
  });

  it("parseSinkList splits on commas, plus signs and spaces", () => {
    expect(parseSinkList("sentry,posthog")).toEqual(["sentry", "posthog"]);
    expect(parseSinkList("sentry+posthog")).toEqual(["sentry", "posthog"]);
    expect(parseSinkList("sentry posthog")).toEqual(["sentry", "posthog"]);
    expect(parseSinkList(" sentry , webhook:/g ")).toEqual(["sentry", "webhook:/g"]);
    expect(parseSinkList("")).toEqual([]);
  });

  it("page config: sink= in the meta tag (+ joins names), data-sink on the tag, GENCLASS_CONFIG.sinks; later sources win; off clears", () => {
    expect(fromPairs(parsePairs("sink=sentry+posthog, mode=observe"))).toEqual({ sinks: ["sentry", "posthog"], mode: "observe" });
    expect(fromPairs(parsePairs("sinks=datadog"))).toEqual({ sinks: ["datadog"] });
    expect(fromPairs(parsePairs("sink=webhook:https://hooks.example/g?k=v"))).toEqual({ sinks: ["webhook:https://hooks.example/g?k=v"] });
    expect(fromPairs({ sink: "off" })).toEqual({ sinks: [] });
    expect(fromPairs({ sink: "" })).toEqual({});
    expect(fromDataset({ sink: "sentry,webhook:/g", mode: "observe" })).toEqual({ sinks: ["sentry", "webhook:/g"], mode: "observe" });
    const doc = { querySelectorAll: () => [{ getAttribute: () => "sink=sentry" }, { getAttribute: () => "mode=observe" }] };
    expect(readMetaConfig(doc)).toEqual({ sinks: ["sentry"], mode: "observe" });
    expect(mergeConfig({ sinks: ["sentry"] }, { sinks: ["posthog"] })).toEqual({ sinks: ["posthog"] });
    const fn = () => undefined;
    expect(splitConfig({ mode: "observe", sinks: ["sentry", fn], devtools: true })).toEqual({ init: { mode: "observe" }, devtools: true, sinks: ["sentry", fn] });
    expect(splitConfig({ mode: "observe" })).toEqual({ init: { mode: "observe" }, devtools: undefined, sinks: undefined });
  });
});

describe("lazySink: the proxy a name becomes", () => {
  it("queues records until the module loads, then forwards with the adapter's kinds and evidence; loads once", async () => {
    let resolve!: (m: SinkModule) => void;
    const load = vi.fn<SinkLoader>(() => new Promise<SinkModule>((r) => (resolve = r)));
    const send = vi.fn();
    const warn = vi.fn();
    const s = lazySink({ name: "sentry" }, load, warn, {});
    expect(s.evidence).toBe(true);
    expect(load).not.toHaveBeenCalled(); // no requestIdleCallback here: loads on the first record
    s.send(rec());
    s.send(rec({ id: "r2", kind: "summary" }));
    s.send(rec({ id: "r3" }));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("sentry");
    expect(send).not.toHaveBeenCalled();
    resolve(moduleOf({ send, kinds: ["detection"], evidence: false }));
    await drain();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c) => (c[0] as SinkRecord).id)).toEqual(["r1", "r3"]);
    expect((send.mock.calls[0][0] as SinkRecord).evidence).toBeUndefined();
    s.send(rec({ id: "r4" }));
    expect(send).toHaveBeenCalledTimes(3);
    expect((send.mock.calls[2][0] as SinkRecord).id).toBe("r4");
    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    // an adapter that wants evidence gets it
    const withEv = vi.fn();
    const t = lazySink({ name: "posthog" }, () => Promise.resolve(moduleOf({ send: withEv, evidence: true })), warn, {});
    t.send(rec());
    await drain();
    expect((withEv.mock.calls[0][0] as SinkRecord).evidence).toBeDefined();
  });

  it("starts loading at idle when requestIdleCallback exists", async () => {
    const ric = vi.fn();
    const load = vi.fn<SinkLoader>(() => Promise.resolve(moduleOf({ send: vi.fn() })));
    lazySink({ name: "sentry" }, load, vi.fn(), { requestIdleCallback: ric });
    expect(ric).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
    (ric.mock.calls[0][0] as () => void)();
    expect(load).toHaveBeenCalledTimes(1);
    // a throwing requestIdleCallback is contained; the load still happens on the first record
    const s = lazySink(
      { name: "sentry" },
      load,
      vi.fn(),
      {
        requestIdleCallback: () => {
          throw new Error("x");
        },
      },
    );
    s.send(rec());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a module that fails to load: one warning, records dropped, never throws; flush() waits for the load and the adapter", async () => {
    const warn = vi.fn();
    const s = lazySink({ name: "datadog" }, () => Promise.reject(new Error("404")), warn, {});
    s.send(rec());
    await drain();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/sink "datadog" could not load \(404\)/);
    expect(() => s.send(rec())).not.toThrow();
    await expect(s.flush!()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    // flush before the module arrived: waits for it, then the adapter's flush
    let resolve!: (m: SinkModule) => void;
    const flushSpy = vi.fn(() => Promise.resolve());
    const send = vi.fn();
    const t = lazySink({ name: "webhook", arg: "/g" }, () => new Promise<SinkModule>((r) => (resolve = r)), warn, {});
    t.send(rec());
    let flushed = false;
    const p = t.flush!().then(() => (flushed = true));
    await drain();
    expect(flushed).toBe(false);
    resolve(moduleOf({ send, flush: flushSpy }));
    await p;
    expect(send).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    // nothing queued and never asked: flush is a no-op that loads nothing
    const idle = vi.fn<SinkLoader>();
    await lazySink({ name: "sentry" }, idle, warn, {}).flush!();
    expect(idle).not.toHaveBeenCalled();
  });

  it("webhook gets its URL as the adapter's option; a throwing adapter is contained", async () => {
    let seen: unknown;
    const s = lazySink(
      { name: "webhook", arg: "/genclass" },
      () =>
        Promise.resolve({
          default: (o: unknown) => {
            seen = o;
            return {
              send: () => {
                throw new Error("x");
              },
            };
          },
        }),
      vi.fn(),
      {},
    );
    s.send(rec());
    await drain();
    expect(seen).toEqual({ url: "/genclass" });
    expect(() => s.send(rec())).not.toThrow();
    let opts: unknown;
    const t = lazySink({ name: "sentry" }, () => Promise.resolve({ default: (o: unknown) => ((opts = o), { send: vi.fn() }) }), vi.fn(), {});
    t.send(rec());
    await drain();
    expect(opts).toEqual({});
  });
});

describe("applySinks: page config → InitOptions", () => {
  const load: SinkLoader = () => Promise.resolve(moduleOf({ send: vi.fn() }));

  it("strings become lazy sinks, functions and objects pass through, unknown names warn and drop, webhook URLs join requests.ignore", () => {
    const fn = () => undefined;
    const obj = { send: fn };
    const warn = vi.fn();
    const init = { mode: "observe" as const, requests: { ignore: ["/x"] } };
    const out = applySinks(init, ["sentry", fn, obj, "bogus", "webhook:/genclass"], load, warn, {});
    expect(out.mode).toBe("observe");
    expect(out.sinks!.length).toBe(4);
    expect(out.sinks![1]).toBe(fn);
    expect(out.sinks![2]).toBe(obj);
    expect(typeof (out.sinks![0] as SinkObject).send).toBe("function");
    expect(typeof (out.sinks![3] as SinkObject).send).toBe("function");
    expect(out.requests!.ignore).toEqual(["/x", "/genclass"]);
    expect(init.requests.ignore).toEqual(["/x"]); // the input is not mutated
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/unknown sink "bogus"/);
    // no webhook: requests untouched; no list: the same object back
    expect(applySinks({ mode: "observe" }, ["sentry"], load, warn, {}).requests).toBeUndefined();
    const same = { mode: "observe" as const };
    expect(applySinks(same, undefined, load, warn, {})).toBe(same);
    expect(applySinks(same, [], load, warn, {})).toBe(same);
    expect(applySinks(same, "sentry" as never, load, warn, {})).toBe(same);
  });

  it("through the runtime: a named sink delivers an intervention to Sentry once its module has loaded", async () => {
    const fake = { captureMessage: vi.fn() };
    const loadSentry: SinkLoader = () => Promise.resolve({ default: (o?: Record<string, unknown>) => sentry({ ...(o ?? {}), sentry: fake }) });
    const warn = vi.fn();
    const init = applySinks({}, ["sentry"], loadSentry, warn, {});
    const s = setup({ sinks: init.sinks, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    const p = s.fetch("/api/x").catch(() => undefined);
    await s.clock.advance(2000);
    await p;
    await s.clock.advance(10);
    await drain();
    expect(s.rt.interventions().length).toBe(1);
    expect(fake.captureMessage).toHaveBeenCalledTimes(1);
    expect(fake.captureMessage.mock.calls[0][0]).toMatch(/^\[GenClass\] Slowed down an overload request/);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a name handed straight to createRuntime / GenClass.init is ignored with one warning (names need /auto or the script tag); the runtime still works", async () => {
    const warn = vi.fn();
    const s = setup({ sinks: ["sentry" as never], triage: "always", script: DELAY, extraGlobal: { console: { warn, info: vi.fn(), log: vi.fn() } } });
    expect(warn.mock.calls.some((c) => /sink "sentry" is neither a function nor \{ send \}/.test(String(c[0])))).toBe(true);
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    const p = s.fetch("/api/x").catch(() => undefined);
    await s.clock.advance(2000);
    await p;
    await s.clock.advance(10);
    expect(s.rt.interventions().length).toBe(1);
  });
});

// Sinks by name in the zero-code entries (src/cdn/sinks.ts, sinks-fanout.ts, sinks-load.ts, config.ts; README "See
// it where you already look"; OPTIONS-SPEC §4.11): the names in the meta tag, the script tag's data-sink or
// window.GENCLASS_CONFIG become one lazy proxy, the records queued while the adapters load are handed over, each
// adapter gets the kinds and evidence it asks for, and a webhook URL joins requests.ignore (same-origin only from a
// meta tag).
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSinks } from "../src/cdn/auto-start.js";
import { fromDataset, fromPairs, mergeConfig, parsePairs, readMetaConfig, sameOriginUrl, splitConfig } from "../src/cdn/config.js";
import { SINK_NAMES, fanout, parseSinkSpec, type SinkLoader, type SinkModule } from "../src/cdn/sinks-fanout.js";
import { loadSink, resolve as resolveLazy } from "../src/cdn/sinks-load.js";
import { applySinks, namedSinks, parseSinkList, webhookUrl, type SinkResolver } from "../src/cdn/sinks.js";
import { GenClass } from "../src/index.js";
import { sentry } from "../src/sinks/sentry.js";
import type { InitOptions, SinkObject, SinkRecord } from "../src/types.js";
import { defaultScript, drain, setup } from "./helpers.js";

const DELAY = defaultScript({ request: { diagnosis: "overload", action: "delay" } });

function rec(over: Partial<SinkRecord> = {}): SinkRecord {
  return { schema: 1, kind: "detection", id: "r1", ts: 1000, sessionId: "S", tags: {}, mode: "observe", sampled: true, diagnosis: "stale", evidence: { message: "[GenClass] Flagged a stale response" }, ...over };
}

const moduleOf = (sink: SinkObject): SinkModule => ({ default: () => sink });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sink names (cdn/sinks-fanout.ts, cdn/sinks.ts)", () => {
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
    // the tool names take one option, evidence / noevidence; anything else is not a sink (one "unknown sink" warning)
    expect(parseSinkSpec("sentry:noevidence")).toEqual({ name: "sentry", evidence: false });
    expect(parseSinkSpec("posthog=no-evidence")).toEqual({ name: "posthog", evidence: false });
    expect(parseSinkSpec("console-json:NoEvidence")).toEqual({ name: "console-json", evidence: false });
    expect(parseSinkSpec("datadog:evidence")).toEqual({ name: "datadog", evidence: true });
    expect(parseSinkSpec("sentry:x")).toBeNull();
    expect(parseSinkSpec("sentry:")).toEqual({ name: "sentry" });
  });

  it("parseSinkList splits on commas, plus signs and spaces; webhookUrl reads webhook:<url> / webhook=<url>", () => {
    expect(parseSinkList("sentry,posthog")).toEqual(["sentry", "posthog"]);
    expect(parseSinkList("sentry+posthog")).toEqual(["sentry", "posthog"]);
    expect(parseSinkList("sentry posthog")).toEqual(["sentry", "posthog"]);
    expect(parseSinkList(" sentry , webhook:/g ")).toEqual(["sentry", "webhook:/g"]);
    expect(parseSinkList("")).toEqual([]);
    expect(webhookUrl("webhook:/genclass")).toBe("/genclass");
    expect(webhookUrl(" Webhook = https://hooks.example/g?k=v ")).toBe("https://hooks.example/g?k=v");
    expect(webhookUrl("webhook:")).toBeUndefined();
    expect(webhookUrl("sentry")).toBeUndefined();
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

  it("a meta tag's webhook URL must be same-origin, like its model URL (THREAT-MODEL T8); data-sink and GENCLASS_CONFIG may name any", () => {
    const tag = (content: string) => ({ getAttribute: () => content });
    const loc = { href: "https://shop.example/p", origin: "https://shop.example" };
    const head = (...contents: string[]) => ({ head: { querySelectorAll: () => contents.map(tag) } });
    const warns: string[] = [];
    expect(readMetaConfig(head("sink=sentry+webhook:https://evil.example/c, mode=observe"), { location: loc, warn: (m) => warns.push(m) })).toEqual({ sinks: ["sentry"], mode: "observe" });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("sink=webhook:https://evil.example/c");
    expect(warns[0]).toContain("data-sink");
    // only a cross-origin webhook: no sinks left; protocol-relative is another host too
    expect(readMetaConfig(head("sink=webhook://evil.example/c"), { location: loc })).toEqual({ sinks: [] });
    // one warning for model and webhook together
    const both: string[] = [];
    readMetaConfig(head("model=https://evil.example/m/, sink=webhook:https://evil.example/c"), { location: loc, warn: (m) => both.push(m) });
    expect(both).toHaveLength(1);
    expect(both[0]).toMatch(/model=https:\/\/evil\.example\/m\/, sink=webhook:https:\/\/evil\.example\/c/);
    // same-origin (a path, or the page's own origin) stays, with no warning
    const ok: string[] = [];
    expect(readMetaConfig(head("sink=webhook:/genclass+webhook:https://shop.example/g+posthog"), { location: loc, warn: (m) => ok.push(m) })).toEqual({
      sinks: ["webhook:/genclass", "webhook:https://shop.example/g", "posthog"],
    });
    expect(ok).toEqual([]);
    // off still clears
    expect(readMetaConfig(head("sink=off"), { location: loc })).toEqual({ sinks: [] });
    // the browser's URL parser decides, not a prefix check: a backslash or a tab inside "//" is another host
    for (const far of ["/\\evil.example/c", "\\\\evil.example/c", "\\/evil.example/c", "HTTPS://evil.example/c"]) {
      const w: string[] = [];
      expect(readMetaConfig(head(`sink=webhook:${far}`), { location: loc, warn: (m) => w.push(m) }), JSON.stringify(far)).toEqual({ sinks: [] });
      expect(w, JSON.stringify(far)).toHaveLength(1);
    }
    for (const far of ["/\\evil.example/c", "\\\\evil.example/c", "\\/evil.example/c", "HTTPS://evil.example/c", "/\t/evil.example/c", " //evil.example/c", "//evil.example/c"]) {
      expect(sameOriginUrl(far, loc), JSON.stringify(far)).toBe(false);
      expect(sameOriginUrl(far, null), JSON.stringify(far)).toBe(false);
    }
    // an injected <base href> moves where fetch and sendBeacon resolve a path: checked against document.baseURI too
    const based = (content: string, baseURI: string) => ({ baseURI, head: { querySelectorAll: () => [tag(content)] } });
    expect(readMetaConfig(based("sink=webhook:c+sentry", "https://evil.example/"), { location: loc })).toEqual({ sinks: ["sentry"] });
    expect(readMetaConfig(based("model=m/, device=wasm", "https://evil.example/"), { location: loc })).toEqual({ model: { device: "wasm" } });
    expect(readMetaConfig(based("sink=webhook:c", "https://shop.example/app/"), { location: loc })).toEqual({ sinks: ["webhook:c"] });
    expect(sameOriginUrl("c", loc, "https://evil.example/")).toBe(false);
    expect(sameOriginUrl("c", loc, "https://shop.example/app/")).toBe(true);
    expect(sameOriginUrl("/genclass", { origin: "https://shop.example" })).toBe(true);
    expect(sameOriginUrl("/genclass", null)).toBe(true);
    // the script tag's data-* and GENCLASS_CONFIG are the author's own: any origin
    expect(fromDataset({ sink: "webhook:https://hooks.example/g" })).toEqual({ sinks: ["webhook:https://hooks.example/g"] });
  });
});

describe("namedSinks: the one proxy the names become (first load)", () => {
  it("queues records until the resolver's sink arrives, then forwards them all and every later one; resolves once, with the names", async () => {
    let done!: (s: SinkObject) => void;
    const resolve = vi.fn<SinkResolver>(() => new Promise<SinkObject>((r) => (done = r)));
    const send = vi.fn();
    const warn = vi.fn();
    const s = namedSinks(["sentry", "webhook:/g"], resolve, warn);
    expect(s.evidence).toBe(true);
    expect(resolve).not.toHaveBeenCalled(); // loads on the first record
    s.send(rec());
    s.send(rec({ id: "r2", kind: "summary" }));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toEqual(["sentry", "webhook:/g"]);
    expect(resolve.mock.calls[0][1]).toBe(warn);
    expect(send).not.toHaveBeenCalled();
    done({ send });
    await drain();
    expect(send.mock.calls.map((c) => (c[0] as SinkRecord).id)).toEqual(["r1", "r2"]);
    s.send(rec({ id: "r3" }));
    expect(send).toHaveBeenCalledTimes(3);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("loads nothing before the first record, not even at idle: a page with ?genclass=off, or that never reports, fetches no adapter", async () => {
    const resolve = vi.fn<SinkResolver>(() => Promise.resolve({ send: vi.fn() }));
    const s = namedSinks(["sentry"], resolve, vi.fn());
    await drain();
    expect(resolve).not.toHaveBeenCalled();
    await s.flush!();
    expect(resolve).not.toHaveBeenCalled();
    s.send(rec());
    expect(resolve).toHaveBeenCalledTimes(1);
    // through applySinks with a page that has requestIdleCallback: still nothing until a record
    const ric = vi.fn();
    const lazy = vi.fn<SinkResolver>(() => Promise.resolve({ send: vi.fn() }));
    applySinks({}, ["sentry"], lazy, vi.fn(), { requestIdleCallback: ric, location: { href: "https://shop.example/" } });
    await drain();
    expect(ric).not.toHaveBeenCalled();
    expect(lazy).not.toHaveBeenCalled();
  });

  it("a resolver that rejects or throws: one warning, records dropped, never throws; at most 200 records wait", async () => {
    const warn = vi.fn();
    const s = namedSinks(["datadog"], () => Promise.reject(new Error("404")), warn);
    s.send(rec());
    await drain();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/sinks datadog could not load \(404\)/);
    expect(() => s.send(rec())).not.toThrow();
    await expect(s.flush!()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const t = namedSinks(
      ["sentry"],
      () => {
        throw new Error("sync");
      },
      warn,
    );
    expect(() => t.send(rec())).not.toThrow();
    await drain();
    expect(String(warn.mock.calls[1][0])).toMatch(/could not load \(sync\)/);
    // the queue is capped while the adapters load
    let done!: (s: SinkObject) => void;
    const send = vi.fn();
    const u = namedSinks(["sentry"], () => new Promise<SinkObject>((r) => (done = r)), warn);
    for (let i = 0; i < 250; i++) u.send(rec({ id: `q${i}` }));
    done({ send });
    await drain();
    expect(send).toHaveBeenCalledTimes(200);
  });

  it("flush() waits for the adapters, then flushes them; with nothing queued and nothing asked it loads nothing", async () => {
    let done!: (s: SinkObject) => void;
    const flush = vi.fn(() => Promise.resolve());
    const send = vi.fn();
    const s = namedSinks(["webhook:/g"], () => new Promise<SinkObject>((r) => (done = r)), vi.fn());
    s.send(rec());
    let flushed = false;
    const p = s.flush!().then(() => (flushed = true));
    await drain();
    expect(flushed).toBe(false);
    done({ send, flush });
    await p;
    expect(send).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    const idle = vi.fn<SinkResolver>();
    await namedSinks(["sentry"], idle, vi.fn()).flush!();
    expect(idle).not.toHaveBeenCalled();
  });
});

describe("fanout: the names' adapters as one sink (lazy)", () => {
  it("each adapter gets the kinds it asks for, the evidence only when it wants it; a webhook gets its URL; duplicates load once", async () => {
    const calls: Record<string, SinkRecord[]> = { sentry: [], webhook: [] };
    const opts: Record<string, unknown> = {};
    const load = vi.fn<SinkLoader>((name) =>
      Promise.resolve({
        default: (o?: unknown) => {
          opts[name] = o;
          return name === "sentry" ? { kinds: ["detection"], evidence: false, send: (r: SinkRecord) => void calls.sentry.push(r) } : { evidence: true, send: (r: SinkRecord) => void calls.webhook.push(r) };
        },
      }),
    );
    const warn = vi.fn();
    const s = await fanout(["sentry", "webhook:/genclass", "Sentry"], load, warn);
    expect(load.mock.calls.map((c) => c[0])).toEqual(["sentry", "webhook"]);
    expect(opts).toEqual({ sentry: {}, webhook: { url: "/genclass" } });
    expect(s.evidence).toBe(true);
    s.send(rec());
    s.send(rec({ id: "r2", kind: "summary" }));
    expect(calls.sentry.map((r) => r.id)).toEqual(["r1"]);
    expect(calls.sentry[0].evidence).toBeUndefined();
    expect(calls.webhook.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(calls.webhook[0].evidence).toEqual({ message: "[GenClass] Flagged a stale response" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("<name>:noevidence makes its adapter with evidence: false (the no-code forms can turn the evidence off); the real adapter then gets none", async () => {
    const opts: unknown[] = [];
    const load = vi.fn<SinkLoader>(() => Promise.resolve({ default: (o?: unknown) => (opts.push(o), { send: vi.fn() }) }));
    await fanout(["sentry:noevidence", "posthog:evidence", "sentry", "sentry:noevidence"], load, vi.fn());
    expect(opts).toEqual([{ evidence: false }, { evidence: true }, {}]);
    const fake = { captureMessage: vi.fn() };
    const real: SinkLoader = () => Promise.resolve({ default: (o?: Record<string, unknown>) => sentry({ ...(o ?? {}), sentry: fake }) });
    const s = await fanout(["sentry:noevidence"], real, vi.fn());
    s.send(rec());
    expect(fake.captureMessage).toHaveBeenCalledTimes(1);
    const [message, ctx] = fake.captureMessage.mock.calls[0] as [string, { extra: { genclass: Record<string, unknown> } }];
    expect(message).toBe("[GenClass] detection: stale");
    expect(ctx.extra.genclass.message).toBeUndefined();
    expect(ctx.extra.genclass.diagnosis).toBe("stale");
  });

  it("an unknown name or an adapter that cannot load is one warning each; the others still get records; a throwing adapter is contained", async () => {
    const good = vi.fn();
    const load: SinkLoader = (name) => {
      if (name === "datadog") return Promise.reject(new Error("404"));
      if (name === "console-json") return Promise.resolve({ default: () => ({ nope: true }) as never });
      if (name === "webhook")
        return Promise.resolve(
          moduleOf({
            send: () => {
              throw new Error("x");
            },
          }),
        );
      return Promise.resolve(moduleOf({ send: good }));
    };
    const warn = vi.fn();
    const s = await fanout(["bogus", "datadog", "console-json", "webhook:/g", "posthog"], load, warn);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/unknown sink "bogus" \(the names are sentry, posthog, datadog, console-json, each optionally :noevidence, and webhook:<url>\); ignored/),
      expect.stringMatching(/sink "datadog" could not load \(404\)/),
      expect.stringMatching(/sink "console-json" could not load \(not a sink\)/),
    ]);
    expect(() => s.send(rec())).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    // a loader that throws synchronously is a failed load too
    const w2 = vi.fn();
    const t = await fanout(
      ["sentry"],
      () => {
        throw new Error("sync");
      },
      w2,
    );
    expect(String(w2.mock.calls[0][0])).toMatch(/sink "sentry" could not load \(sync\)/);
    expect(() => t.send(rec())).not.toThrow();
  });

  it("flush() flushes every adapter, and a failing flush is contained", async () => {
    const f1 = vi.fn(() => Promise.reject(new Error("x")));
    const f2 = vi.fn(() => Promise.resolve());
    const load: SinkLoader = (name) => Promise.resolve(moduleOf({ send: vi.fn(), flush: name === "sentry" ? f1 : f2 }));
    const s = await fanout(["sentry", "webhook:/g"], load, vi.fn());
    await expect(s.flush!()).resolves.toBeUndefined();
    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it("/auto's lazy resolver loads the real adapters by name (cdn/sinks-load.ts), and only those", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.fn();
    const s = await resolveSinks(["console-json", "bogus"], warn);
    expect(warn).toHaveBeenCalledTimes(1);
    s.send(rec());
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ source: "genclass", kind: "detection", diagnosis: "stale" });
    const direct = await resolveLazy(["console-json"], warn);
    expect(typeof direct.send).toBe("function");
    for (const name of SINK_NAMES) expect(typeof (await loadSink(name)).default, name).toBe("function");
    await expect(loadSink("nope" as never)).rejects.toThrow(/unknown sink nope/);
  });
});

describe("applySinks: page config → InitOptions", () => {
  const resolve: SinkResolver = () => Promise.resolve({ send: vi.fn() });

  it("the names become one proxy, functions and objects pass through, blanks are skipped, webhook URLs join requests.ignore", () => {
    const fn = () => undefined;
    const obj = { send: fn };
    const warn = vi.fn();
    const init = { mode: "observe" as const, requests: { ignore: ["/x"] } };
    const out = applySinks(init, ["sentry", fn, obj, " ", "bogus", "webhook:/genclass"], resolve, warn, {});
    expect(out.mode).toBe("observe");
    expect(out.sinks!.length).toBe(3);
    expect(out.sinks![0]).toBe(fn);
    expect(out.sinks![1]).toBe(obj);
    expect(typeof (out.sinks![2] as SinkObject).send).toBe("function");
    // without a page (no base URL) the webhook's path is matched exactly, whatever the origin and query
    const ig = out.requests!.ignore!;
    expect(ig.length).toBe(2);
    expect(ig[0]).toBe("/x");
    const m = ig[1] as (r: { url: string; method: string; channel: "fetch" }) => boolean;
    const at = (url: string) => m({ url, method: "POST", channel: "fetch" });
    expect(at("http://app.test/genclass")).toBe(true);
    expect(at("http://app.test/genclass?k=v")).toBe(true);
    expect(at("http://app.test/genclassx")).toBe(false);
    expect(at("http://app.test/genclass/x")).toBe(false);
    expect(init.requests.ignore).toEqual(["/x"]); // the input is not mutated
    expect(warn).not.toHaveBeenCalled(); // an unknown name warns once the resolver has loaded (it holds the name table)
    // no webhook: requests untouched; no list: the same object back
    expect(applySinks({ mode: "observe" }, ["sentry"], resolve, warn, {}).requests).toBeUndefined();
    const same = { mode: "observe" as const };
    expect(applySinks(same, undefined, resolve, warn, {})).toBe(same);
    expect(applySinks(same, [], resolve, warn, {})).toBe(same);
    expect(applySinks(same, "sentry" as never, resolve, warn, {})).toBe(same);
    expect(applySinks(same, [" "], resolve, warn, {}).sinks).toEqual([]);
  });

  it("never throws, though /auto runs it before GenClass.init's guard: an ignore that is not a list stays as written; anything else is one warning", () => {
    const warn = vi.fn();
    for (const ignore of [/\/beacon/, () => true, "/beacon"]) {
      const init = { requests: { ignore: ignore as never } };
      let out: InitOptions | undefined;
      expect(() => (out = applySinks(init, ["webhook:/genclass", "sentry"], resolve, warn, {}))).not.toThrow();
      // left as the page wrote it: GenClass.init reports it, with sinks or without, and the app runs on without GenClass
      expect(out!.requests!.ignore).toBe(ignore);
      expect(out!.sinks!.length).toBe(1);
    }
    expect(warn).not.toHaveBeenCalled();
    GenClass.destroy();
    const gwarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const rt = GenClass.init(applySinks({ telemetry: false, model: false, report: "silent", requests: { ignore: /\/beacon/ as never } }, ["webhook:/genclass"], resolve, warn, {}));
      expect(rt).toBeTruthy();
      expect(gwarn.mock.calls.some((c) => /^\[GenClass\] Could not start \(.*\); running without it\.$/.test(String(c[0])))).toBe(true);
    } finally {
      GenClass.destroy();
    }
    // a page config that throws when read: one warning, and `init` without the page-config sinks
    const hostile = {
      mode: "observe" as const,
      get requests(): never {
        throw new Error("boom");
      },
    } as InitOptions;
    expect(applySinks(hostile, ["webhook:/genclass"], resolve, warn, {})).toBe(hostile);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("sinks could not load (boom); their records are dropped.");
    // a list that throws while it is read, and a warn that throws too: still nothing escapes
    const bad = new Proxy(["sentry"], {
      get(t, k) {
        if (k === Symbol.iterator) throw new Error("no");
        return Reflect.get(t, k);
      },
    });
    const thrower = () => {
      throw new Error("x");
    };
    expect(applySinks(hostile, bad, resolve, thrower, {})).toBe(hostile);
    expect(applySinks({}, bad, resolve, warn, {})).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("a webhook URL is made absolute at init (against document.baseURI, else the location) and only its own endpoint is ignored", () => {
    const names: string[][] = [];
    const capture: SinkResolver = (n) => (names.push(n), Promise.resolve({ send: vi.fn() }));
    const page = { location: { href: "https://shop.example/products/1" } };
    const out = applySinks({}, ["webhook:/collect", "webhook:hooks/g?k=v", "webhook:https://hooks.example/in", "sentry"], capture, vi.fn(), page);
    (out.sinks![0] as SinkObject).send(rec());
    expect(names[0]).toEqual(["webhook:https://shop.example/collect", "webhook:https://shop.example/products/hooks/g?k=v", "webhook:https://hooks.example/in", "sentry"]);
    const ig = out.requests!.ignore! as ((r: { url: string; method: string; channel: "fetch" }) => boolean)[];
    expect(ig.length).toBe(3);
    const ignored = (url: string) => ig.some((f) => f({ url, method: "POST", channel: "fetch" }));
    expect(ignored("https://shop.example/collect")).toBe(true);
    expect(ignored("https://shop.example/collect?x=1#y")).toBe(true);
    expect(ignored("https://shop.example/products/hooks/g")).toBe(true);
    expect(ignored("https://hooks.example/in")).toBe(true);
    // never a sibling of the app's: webhook:/collect does not hide /collections, nor another origin's /collect
    expect(ignored("https://shop.example/collections/1")).toBe(false);
    expect(ignored("https://shop.example/collect/more")).toBe(false);
    expect(ignored("https://other.example/collect")).toBe(false);
    expect(ignored("https://shop.example/in")).toBe(false);
    // document.baseURI wins over the location (what sendBeacon and fetch use), and a later <base> cannot move it
    const based: string[][] = [];
    applySinks({}, ["webhook:c"], (n) => (based.push(n), Promise.resolve({ send: vi.fn() })), vi.fn(), { document: { baseURI: "https://shop.example/app/" }, ...page }).sinks!.forEach((s) =>
      (s as SinkObject).send(rec()),
    );
    expect(based[0]).toEqual(["webhook:https://shop.example/app/c"]);
  });

  it("through the runtime: webhook:/collect leaves /collections observed and its own POSTs unobserved", async () => {
    const init = applySinks({}, ["webhook:/collect"], resolve, vi.fn(), { location: { href: "http://app.test/search" } });
    const s = setup({ ...init, triage: "always" });
    s.server.on("GET", "/collections/1", { body: [1], latency: 5 });
    s.server.on("POST", "/collect", { status: 204, latency: 1 });
    const a = s.fetch("/collections/1").catch(() => undefined);
    const b = s.fetch("/collect", { method: "POST", body: "{}" }).catch(() => undefined);
    await s.clock.advance(2000);
    await Promise.all([a, b]);
    await s.clock.advance(10);
    expect(s.server.log.map((e) => `${e.method} ${e.path}`)).toEqual(expect.arrayContaining(["GET /collections/1", "POST /collect"]));
    const seen = JSON.stringify(s.rt.history());
    expect(seen).toContain("GET /collections"); // the request's op (its signature: /collections/:id)
    expect(seen).not.toMatch(/\/collect(?![a-z])/);
  });

  it("through the runtime: a named sink delivers an intervention to Sentry once its adapter has loaded", async () => {
    const fake = { captureMessage: vi.fn() };
    const load: SinkLoader = () => Promise.resolve({ default: (o?: Record<string, unknown>) => sentry({ ...(o ?? {}), sentry: fake }) });
    const warn = vi.fn();
    const init = applySinks({}, ["sentry"], (names, w) => fanout(names, load, w), warn, {});
    const s = setup({ sinks: init.sinks, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    const p = s.fetch("/api/x").catch(() => undefined);
    await s.clock.advance(2000);
    await p;
    await s.clock.advance(10);
    await drain(8);
    expect(s.rt.interventions().length).toBe(1);
    expect(fake.captureMessage).toHaveBeenCalledTimes(1);
    expect(fake.captureMessage.mock.calls[0][0]).toMatch(/^\[GenClass\] Slowed down an overload request/);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a name handed straight to createRuntime / GenClass.init is ignored with one warning (names need /auto or the script tag); the runtime still works", async () => {
    const warn = vi.fn();
    const s = setup({ sinks: ["sentry" as never], triage: "always", script: DELAY, extraGlobal: { console: { warn, info: vi.fn(), log: vi.fn() } } });
    expect(warn.mock.calls.some((c) => /sink "sentry" is neither a function nor \{ send \}; ignored \(import its adapter from @genclass\/runtime\/sinks\)/.test(String(c[0])))).toBe(true);
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    const p = s.fetch("/api/x").catch(() => undefined);
    await s.clock.advance(2000);
    await p;
    await s.clock.advance(10);
    expect(s.rt.interventions().length).toBe(1);
  });
});

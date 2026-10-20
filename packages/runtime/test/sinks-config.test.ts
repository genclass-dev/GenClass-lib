// Sinks by name in the zero-code entries (src/cdn/sinks.ts, sinks-fanout.ts, sinks-load.ts, config.ts; README "See
// it where you already look"; OPTIONS-SPEC §4.11): the names in the meta tag, the script tag's data-sink or
// window.GENCLASS_CONFIG become one lazy proxy, the records queued while the adapters load are handed over, each
// adapter gets the kinds and evidence it asks for, and a webhook URL joins requests.ignore (same-origin only from a
// meta tag). The names sentry, posthog and datadog have no adapter in the runtime: one console warning says that the
// genclass.dev collector forwards detections to those tools, free, from the app's dashboard, and nothing else happens.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSinks } from "../src/cdn/auto-start.js";
import { fromDataset, fromPairs, mergeConfig, parsePairs, readMetaConfig, sameOriginUrl, splitConfig } from "../src/cdn/config.js";
import { SINK_NAMES, fanout, parseSinkSpec, type SinkLoader, type SinkModule } from "../src/cdn/sinks-fanout.js";
import { loadSink, resolve as resolveLazy } from "../src/cdn/sinks-load.js";
import { applySinks, namedSinks, parseSinkList, webhookUrl, type SinkResolver } from "../src/cdn/sinks.js";
import { GenClass } from "../src/index.js";
import { consoleJson } from "../src/sinks/console-json.js";
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
  it("parseSinkSpec: the two names, case and spelling variants, webhook:<url> / webhook=<url>; anything else is null", () => {
    expect(SINK_NAMES).toEqual(["console-json", "webhook"]);
    // no vendor adapter in the runtime (applySinks warns about these names before they get here)
    for (const v of ["sentry", " PostHog ", "datadog", "sentry:noevidence"]) expect(parseSinkSpec(v), v).toBeNull();
    for (const v of ["console-json", "console_json", "consoleJson", "CONSOLE-JSON", " Console-Json "]) expect(parseSinkSpec(v), v).toEqual({ name: "console-json" });
    expect(parseSinkSpec("webhook:/genclass")).toEqual({ name: "webhook", arg: "/genclass" });
    expect(parseSinkSpec("webhook=https://hooks.example/g?k=v")).toEqual({ name: "webhook", arg: "https://hooks.example/g?k=v" });
    expect(parseSinkSpec("webhook")).toBeNull();
    expect(parseSinkSpec("webhook:")).toBeNull();
    expect(parseSinkSpec("bogus")).toBeNull();
    expect(parseSinkSpec("")).toBeNull();
    expect(parseSinkSpec(42)).toBeNull();
    expect(parseSinkSpec(null)).toBeNull();
    // console-json takes one option, evidence / noevidence; anything else is not a sink (one "unknown sink" warning)
    expect(parseSinkSpec("console-json:noevidence")).toEqual({ name: "console-json", evidence: false });
    expect(parseSinkSpec("console-json=no-evidence")).toEqual({ name: "console-json", evidence: false });
    expect(parseSinkSpec("console-json:NoEvidence")).toEqual({ name: "console-json", evidence: false });
    expect(parseSinkSpec("console-json:evidence")).toEqual({ name: "console-json", evidence: true });
    expect(parseSinkSpec("console-json:x")).toBeNull();
    expect(parseSinkSpec("console-json:")).toEqual({ name: "console-json" });
  });

  it("parseSinkList splits on commas, plus signs and spaces; webhookUrl reads webhook:<url> / webhook=<url>", () => {
    expect(parseSinkList("console-json,webhook:/g")).toEqual(["console-json", "webhook:/g"]);
    expect(parseSinkList("console-json+webhook:/g")).toEqual(["console-json", "webhook:/g"]);
    expect(parseSinkList("console-json webhook:/g")).toEqual(["console-json", "webhook:/g"]);
    expect(parseSinkList(" console-json , webhook:/g ")).toEqual(["console-json", "webhook:/g"]);
    expect(parseSinkList("")).toEqual([]);
    expect(webhookUrl("webhook:/genclass")).toBe("/genclass");
    expect(webhookUrl(" Webhook = https://hooks.example/g?k=v ")).toBe("https://hooks.example/g?k=v");
    expect(webhookUrl("webhook:")).toBeUndefined();
    expect(webhookUrl("console-json")).toBeUndefined();
  });

  it("page config: sink= in the meta tag (+ joins names), data-sink on the tag, GENCLASS_CONFIG.sinks; later sources win; off clears", () => {
    expect(fromPairs(parsePairs("sink=console-json+webhook:/g, mode=observe"))).toEqual({ sinks: ["console-json", "webhook:/g"], mode: "observe" });
    expect(fromPairs(parsePairs("sinks=console-json"))).toEqual({ sinks: ["console-json"] });
    expect(fromPairs(parsePairs("sink=webhook:https://hooks.example/g?k=v"))).toEqual({ sinks: ["webhook:https://hooks.example/g?k=v"] });
    expect(fromPairs({ sink: "off" })).toEqual({ sinks: [] });
    expect(fromPairs({ sink: "" })).toEqual({});
    expect(fromDataset({ sink: "console-json,webhook:/g", mode: "observe" })).toEqual({ sinks: ["console-json", "webhook:/g"], mode: "observe" });
    const doc = { querySelectorAll: () => [{ getAttribute: () => "sink=console-json" }, { getAttribute: () => "mode=observe" }] };
    expect(readMetaConfig(doc)).toEqual({ sinks: ["console-json"], mode: "observe" });
    expect(mergeConfig({ sinks: ["console-json"] }, { sinks: ["webhook:/g"] })).toEqual({ sinks: ["webhook:/g"] });
    const fn = () => undefined;
    expect(splitConfig({ mode: "observe", sinks: ["console-json", fn], devtools: true })).toEqual({ init: { mode: "observe" }, devtools: true, sinks: ["console-json", fn] });
    expect(splitConfig({ mode: "observe" })).toEqual({ init: { mode: "observe" }, devtools: undefined, sinks: undefined });
  });

  it("a meta tag's webhook URL must be same-origin, like its model URL (THREAT-MODEL T8); data-sink and GENCLASS_CONFIG may name any", () => {
    const tag = (content: string) => ({ getAttribute: () => content });
    const loc = { href: "https://shop.example/p", origin: "https://shop.example" };
    const head = (...contents: string[]) => ({ head: { querySelectorAll: () => contents.map(tag) } });
    const warns: string[] = [];
    expect(readMetaConfig(head("sink=console-json+webhook:https://evil.example/c, mode=observe"), { location: loc, warn: (m) => warns.push(m) })).toEqual({ sinks: ["console-json"], mode: "observe" });
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
    expect(readMetaConfig(head("sink=webhook:/genclass+webhook:https://shop.example/g+console-json"), { location: loc, warn: (m) => ok.push(m) })).toEqual({
      sinks: ["webhook:/genclass", "webhook:https://shop.example/g", "console-json"],
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
    expect(readMetaConfig(based("sink=webhook:c+console-json", "https://evil.example/"), { location: loc })).toEqual({ sinks: ["console-json"] });
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
    const s = namedSinks(["console-json", "webhook:/g"], resolve, warn);
    expect(s.evidence).toBe(true);
    expect(resolve).not.toHaveBeenCalled(); // loads on the first record
    s.send(rec());
    s.send(rec({ id: "r2", kind: "summary" }));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toEqual(["console-json", "webhook:/g"]);
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
    const s = namedSinks(["console-json"], resolve, vi.fn());
    await drain();
    expect(resolve).not.toHaveBeenCalled();
    await s.flush!();
    expect(resolve).not.toHaveBeenCalled();
    s.send(rec());
    expect(resolve).toHaveBeenCalledTimes(1);
    // through applySinks with a page that has requestIdleCallback: still nothing until a record
    const ric = vi.fn();
    const lazy = vi.fn<SinkResolver>(() => Promise.resolve({ send: vi.fn() }));
    applySinks({}, ["console-json"], lazy, vi.fn(), { requestIdleCallback: ric, location: { href: "https://shop.example/" } });
    await drain();
    expect(ric).not.toHaveBeenCalled();
    expect(lazy).not.toHaveBeenCalled();
  });

  it("a resolver that rejects or throws: one warning, records dropped, never throws; at most 200 records wait", async () => {
    const warn = vi.fn();
    const s = namedSinks(["console-json"], () => Promise.reject(new Error("404")), warn);
    s.send(rec());
    await drain();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/sinks console-json could not load \(404\)/);
    expect(() => s.send(rec())).not.toThrow();
    await expect(s.flush!()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const t = namedSinks(
      ["console-json"],
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
    const u = namedSinks(["console-json"], () => new Promise<SinkObject>((r) => (done = r)), warn);
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
    await namedSinks(["console-json"], idle, vi.fn()).flush!();
    expect(idle).not.toHaveBeenCalled();
  });
});

describe("fanout: the names' adapters as one sink (lazy)", () => {
  it("each adapter gets the kinds it asks for, the evidence only when it wants it; a webhook gets its URL; duplicates load once", async () => {
    const calls: Record<string, SinkRecord[]> = { "console-json": [], webhook: [] };
    const opts: Record<string, unknown> = {};
    const load = vi.fn<SinkLoader>((name) =>
      Promise.resolve({
        default: (o?: unknown) => {
          opts[name] = o;
          return name === "console-json"
            ? { kinds: ["detection"], evidence: false, send: (r: SinkRecord) => void calls["console-json"].push(r) }
            : { evidence: true, send: (r: SinkRecord) => void calls.webhook.push(r) };
        },
      }),
    );
    const warn = vi.fn();
    const s = await fanout(["console-json", "webhook:/genclass", "Console-Json"], load, warn);
    expect(load.mock.calls.map((c) => c[0])).toEqual(["console-json", "webhook"]);
    expect(opts).toEqual({ "console-json": {}, webhook: { url: "/genclass" } });
    expect(s.evidence).toBe(true);
    s.send(rec());
    s.send(rec({ id: "r2", kind: "summary" }));
    expect(calls["console-json"].map((r) => r.id)).toEqual(["r1"]);
    expect(calls["console-json"][0].evidence).toBeUndefined();
    expect(calls.webhook.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(calls.webhook[0].evidence).toEqual({ message: "[GenClass] Flagged a stale response" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("<name>:noevidence makes its adapter with evidence: false (the no-code forms can turn the evidence off); the real adapter then gets none", async () => {
    const opts: unknown[] = [];
    const load = vi.fn<SinkLoader>(() => Promise.resolve({ default: (o?: unknown) => (opts.push(o), { send: vi.fn() }) }));
    await fanout(["console-json:noevidence", "console-json:evidence", "console-json", "console-json:noevidence"], load, vi.fn());
    expect(opts).toEqual([{ evidence: false }, { evidence: true }, {}]);
    const con = { log: vi.fn() };
    const real: SinkLoader = () => Promise.resolve({ default: (o?: Record<string, unknown>) => consoleJson({ ...(o ?? {}), console: con }) });
    const s = await fanout(["console-json:noevidence"], real, vi.fn());
    s.send(rec());
    expect(con.log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(con.log.mock.calls[0][0])) as Record<string, unknown>;
    expect(line.diagnosis).toBe("stale");
    expect(line.evidence).toBeUndefined();
  });

  it("an unknown name (sentry, posthog and datadog included) or an adapter that cannot load is one warning each; the others still get records; a throwing adapter is contained", async () => {
    const good = vi.fn();
    const load: SinkLoader = (name) => {
      if (name === "console-json") return Promise.reject(new Error("404"));
      return Promise.resolve({
        default: (o?: { url?: string }) =>
          o?.url === "/bad"
            ? ({ nope: true } as never)
            : o?.url === "/throw"
              ? {
                  send: () => {
                    throw new Error("x");
                  },
                }
              : { send: good },
      });
    };
    const warn = vi.fn();
    const s = await fanout(["bogus", "sentry", "console-json", "webhook:/bad", "webhook:/throw", "webhook:/g"], load, warn);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/unknown sink "bogus" \(the names are console-json, optionally :noevidence, and webhook:<url>\); ignored/),
      expect.stringMatching(/unknown sink "sentry"/),
      expect.stringMatching(/sink "console-json" could not load \(404\)/),
      expect.stringMatching(/sink "webhook:\/bad" could not load \(not a sink\)/),
    ]);
    expect(() => s.send(rec())).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    // a loader that throws synchronously is a failed load too
    const w2 = vi.fn();
    const t = await fanout(
      ["console-json"],
      () => {
        throw new Error("sync");
      },
      w2,
    );
    expect(String(w2.mock.calls[0][0])).toMatch(/sink "console-json" could not load \(sync\)/);
    expect(() => t.send(rec())).not.toThrow();
  });

  it("flush() flushes every adapter, and a failing flush is contained", async () => {
    const f1 = vi.fn(() => Promise.reject(new Error("x")));
    const f2 = vi.fn(() => Promise.resolve());
    const load: SinkLoader = (name) => Promise.resolve(moduleOf({ send: vi.fn(), flush: name === "console-json" ? f1 : f2 }));
    const s = await fanout(["console-json", "webhook:/g"], load, vi.fn());
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
    const out = applySinks(init, ["console-json", fn, obj, " ", "bogus", "webhook:/genclass"], resolve, warn, {});
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
    expect(applySinks({ mode: "observe" }, ["console-json"], resolve, warn, {}).requests).toBeUndefined();
    const same = { mode: "observe" as const };
    expect(applySinks(same, undefined, resolve, warn, {})).toBe(same);
    expect(applySinks(same, [], resolve, warn, {})).toBe(same);
    expect(applySinks(same, "console-json" as never, resolve, warn, {})).toBe(same);
    expect(applySinks(same, [" "], resolve, warn, {}).sinks).toEqual([]);
  });

  it("never throws, though /auto runs it before GenClass.init's guard: an ignore that is not a list stays as written; anything else is one warning", () => {
    const warn = vi.fn();
    for (const ignore of [/\/beacon/, () => true, "/beacon"]) {
      const init = { requests: { ignore: ignore as never } };
      let out: InitOptions | undefined;
      expect(() => (out = applySinks(init, ["webhook:/genclass", "console-json"], resolve, warn, {}))).not.toThrow();
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
    const bad = new Proxy(["console-json"], {
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
    const out = applySinks({}, ["webhook:/collect", "webhook:hooks/g?k=v", "webhook:https://hooks.example/in", "console-json"], capture, vi.fn(), page);
    (out.sinks![0] as SinkObject).send(rec());
    expect(names[0]).toEqual(["webhook:https://shop.example/collect", "webhook:https://shop.example/products/hooks/g?k=v", "webhook:https://hooks.example/in", "console-json"]);
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

  it("through the runtime: a named sink delivers an intervention once its adapter has loaded", async () => {
    const con = { log: vi.fn() };
    const load: SinkLoader = () => Promise.resolve({ default: (o?: Record<string, unknown>) => consoleJson({ ...(o ?? {}), console: con }) });
    const warn = vi.fn();
    const init = applySinks({}, ["console-json"], (names, w) => fanout(names, load, w), warn, {});
    const s = setup({ sinks: init.sinks, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    const p = s.fetch("/api/x").catch(() => undefined);
    await s.clock.advance(2000);
    await p;
    await s.clock.advance(10);
    await drain(8);
    expect(s.rt.interventions().length).toBe(1);
    const lines = con.log.mock.calls.map((c) => JSON.parse(String(c[0])) as { kind: string; evidence?: { message?: string } });
    const iv = lines.find((l) => l.kind === "intervention")!;
    expect(iv.evidence!.message).toMatch(/^\[GenClass\] Slowed down an overload request/);
    expect(warn).not.toHaveBeenCalled();
  });

  it("sentry, posthog and datadog have no adapter: one warning for them all says the collector forwards to them, free, with the docs link, and nothing else happens", async () => {
    const warn = vi.fn();
    const resolver = vi.fn<SinkResolver>(() => Promise.resolve({ send: vi.fn() }));
    const init = { mode: "observe" as const };
    const out = applySinks(init, ["sentry", " PostHog ", "datadog:noevidence", "Sentry=evidence"], resolver, warn, { location: { href: "https://shop.example/" } });
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0][0]);
    expect(text).toBe(
      "Ignored sink sentry, PostHog, datadog:noevidence, Sentry=evidence: the runtime has no Sentry, PostHog or Datadog adapter; the genclass.dev collector forwards detections to them, free, from the app's dashboard: https://genclass.dev/docs#dashboard",
    );
    expect(text).not.toMatch(/GenClass Pro|\bPro\b|trial|not in the free runtime|genclass\.dev\/pricing/);
    expect(text).not.toMatch(/\u2014|!/);
    // no proxy, no requests.ignore, nothing loaded now or later
    expect(out).toEqual({ mode: "observe", sinks: [] });
    await drain();
    expect(resolver).not.toHaveBeenCalled();
    // next to sinks the runtime has: those work as before, still one warning for the vendor names
    const w2 = vi.fn();
    const mixed = applySinks({}, ["webhook:/genclass", "sentry", "console-json", "posthog"], resolver, w2, {});
    expect(w2).toHaveBeenCalledTimes(1);
    expect(String(w2.mock.calls[0][0])).toBe("Ignored sink sentry, posthog: the runtime has no Sentry, PostHog or Datadog adapter; the genclass.dev collector forwards detections to them, free, from the app's dashboard: https://genclass.dev/docs#dashboard");
    expect(mixed.sinks!.length).toBe(1);
    expect(mixed.requests!.ignore!.length).toBe(1);
    (mixed.sinks![0] as SinkObject).send(rec());
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][0]).toEqual(["webhook:/genclass", "console-json"]);
    // only the names themselves: a longer word is just an unknown name (warned about by the resolver, as before)
    const w3 = vi.fn();
    expect(applySinks({}, ["sentryx", "my-posthog"], resolver, w3, {}).sinks!.length).toBe(1);
    expect(w3).not.toHaveBeenCalled();
  });

  it("through the runtime: a page config that names sentry gets that one warning; the runtime runs and sends nothing for it", async () => {
    const warn = vi.fn();
    const resolver = vi.fn<SinkResolver>(() => Promise.resolve({ send: vi.fn() }));
    const init = applySinks({}, ["sentry"], resolver, (m) => warn(`[GenClass] ${m}`), {});
    const s = setup({ ...init, triage: "always", script: DELAY, extraGlobal: { console: { warn, info: vi.fn(), log: vi.fn(), debug: vi.fn() } } });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    const p = s.fetch("/api/x").catch(() => undefined);
    await s.clock.advance(2000);
    await p;
    await s.clock.advance(10);
    await drain(8);
    expect(s.rt.interventions().length).toBe(1);
    expect(resolver).not.toHaveBeenCalled();
    const vendor = warn.mock.calls.filter((c) => /has no Sentry, PostHog or Datadog adapter/.test(String(c[0])));
    expect(vendor).toHaveLength(1);
    expect(String(vendor[0][0])).toContain("https://genclass.dev/docs#dashboard");
    expect(warn.mock.calls.some((c) => /sink .* (is neither|could not load)|unknown sink/.test(String(c[0])))).toBe(false);
  });

  it("a name handed straight to createRuntime / GenClass.init is ignored with one warning (names need /auto or the script tag); the runtime still works", async () => {
    const warn = vi.fn();
    const s = setup({ sinks: ["console-json" as never], triage: "always", script: DELAY, extraGlobal: { console: { warn, info: vi.fn(), log: vi.fn() } } });
    expect(warn.mock.calls.some((c) => /sink "console-json" is neither a function nor \{ send \}; ignored \(import its adapter from @genclass\/runtime\/sinks\)/.test(String(c[0])))).toBe(true);
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    const p = s.fetch("/api/x").catch(() => undefined);
    await s.clock.advance(2000);
    await p;
    await s.clock.advance(10);
    expect(s.rt.interventions().length).toBe(1);
  });
});

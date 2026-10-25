// @genclass/runtime/agent (docs/runtime/AGENT.md): delivery schedules, the recording, witnesses and the bridge link.
import { describe, expect, it } from "vitest";
import { connectAgent, hash32, isDevHost, parseSpec, type AgentConnection } from "../src/agent/index.js";
import { Scheduler } from "../src/agent/schedule.js";
import { FakeClock, setup as baseSetup, type Setup } from "./helpers.js";

/** The app on the developer's machine (connectAgent's default hosts). */
const LOC = { href: "http://localhost:5173/search", pathname: "/search", hostname: "localhost", search: "" };
const setup = (o: Parameters<typeof baseSetup>[0] = {}): Setup => baseSetup({ ...o, extraGlobal: { location: LOC, ...(o?.extraGlobal ?? {}) } });

/** A fake bridge on the fake server: hello answers with `schedule`; events are kept. */
function bridge(s: Setup, schedule: unknown = null, latency = 1) {
  const events: Record<string, unknown>[] = [];
  const hellos: Record<string, unknown>[] = [];
  s.server.on("POST", "/v1/hello", ({ body }) => {
    hellos.push(JSON.parse(body ?? "{}"));
    return { body: { run: `r${hellos.length}`, schedule }, latency };
  });
  s.server.on("POST", "/v1/events", ({ body }) => {
    const b = JSON.parse(body ?? "{}") as { events?: Record<string, unknown>[] };
    events.push(...(b.events ?? []));
    return { body: { ok: true }, latency };
  });
  return { events, hellos };
}

/** Two GETs that overlap: /api/a is slow, /api/b is fast; each response's handler records its arrival order. */
async function overlap(s: Setup, a = 300, b = 50): Promise<string[]> {
  s.server.on("GET", "/api/a", { body: { v: "a" }, latency: a });
  s.server.on("GET", "/api/b", { body: { v: "b" }, latency: b });
  const seen: string[] = [];
  const get = async (p: string) => {
    const r = await s.fetch(p);
    const j = (await r.json()) as { v: string };
    seen.push(j.v);
  };
  void get("/api/a");
  await s.clock.advance(10);
  void get("/api/b");
  await s.clock.advance(3000);
  return seen;
}

describe("agent: schedules (AGENT.md §3)", () => {
  it("parses the URL and page-global forms", () => {
    expect(parseSpec("fifo")).toEqual({ order: "fifo" });
    expect(parseSpec("seeded:7")).toEqual({ order: "seeded", seed: 7 });
    expect(parseSpec("explore:3")).toEqual({ order: "seeded", seed: 3 });
    expect(parseSpec('{"order":"given","given":["GET /a#1"]}')).toEqual({ order: "given", given: ["GET /a#1"] });
    expect(parseSpec({ order: "nope" })).toBeNull();
    expect(parseSpec("rm -rf")).toBeNull();
    expect(parseSpec({ order: "seeded", delay: { minMs: 5, maxMs: 2 } })).toEqual({ order: "seeded", seed: 1, delay: { minMs: 5, maxMs: 5 } });
  });

  it("natural delivers as responses arrive (no hold, nothing reordered)", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    connectAgent(s.rt, { schedule: "natural" });
    expect(await overlap(s)).toEqual(["b", "a"]);
  });

  it("fifo delivers in request start order: the faster later response waits for the earlier one", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    const c = connectAgent(s.rt, { schedule: "fifo" });
    expect(await overlap(s)).toEqual(["a", "b"]);
    expect(c.recorded().order).toEqual(["GET /api/a#1", "GET /api/b#1"]);
    expect(c.recorded().forced).toBe(0);
  });

  it("seeded orders are deterministic per seed, and different seeds explore both orders", async () => {
    const orders = new Map<number, string>();
    for (let seed = 1; seed <= 8; seed++) {
      const runs: string[] = [];
      for (let k = 0; k < 2; k++) {
        const s = setup({ mode: undefined });
        bridge(s);
        connectAgent(s.rt, { schedule: { order: "seeded", seed } });
        runs.push((await overlap(s, 120, 100)).join(""));
      }
      expect(runs[0]).toBe(runs[1]);
      orders.set(seed, runs[0]);
    }
    expect(new Set(orders.values())).toEqual(new Set(["ab", "ba"]));
  });

  it("given replays a recorded delivery order even when the latencies are different", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    const c = connectAgent(s.rt, { schedule: { order: "given", given: ["GET /api/b#1", "GET /api/a#1"] } });
    // b is now the slow one: the recorded order still holds a until b was delivered
    expect(await overlap(s, 40, 400)).toEqual(["b", "a"]);
    expect(c.recorded().order).toEqual(["GET /api/b#1", "GET /api/a#1"]);
  });

  it("a hold never outlasts maxHoldMs: a key that never comes is waited for, then the response is delivered and marked forced", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("GET", "/api/a", { body: { v: "a" }, latency: 20 });
    const c = connectAgent(s.rt, { schedule: { order: "given", given: ["GET /api/never#1", "GET /api/a#1"], maxHoldMs: 500 } });
    let got = -1;
    const t0 = s.clock.now();
    void s.fetch("/api/a").then(() => (got = s.clock.now() - t0));
    await s.clock.advance(400);
    expect(got).toBe(-1);
    await s.clock.advance(400);
    expect(got).toBeGreaterThanOrEqual(500);
    expect(got).toBeLessThan(600);
    expect(c.recorded().forced).toBe(1);
    expect(c.recorded().steps.find((x) => x.k === "recv")).toMatchObject({ key: "GET /api/a#1", forced: true });
  });

  it("a failed request stops blocking: fifo does not wait for a response that will never be delivered", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("GET", "/api/a", { status: 500, body: {}, latency: 100 });
    s.server.on("GET", "/api/b", { body: { v: "b" }, latency: 20 });
    connectAgent(s.rt, { schedule: "fifo" });
    let bAt = -1;
    const t0 = s.clock.now();
    void s.fetch("/api/a").catch(() => undefined);
    await s.clock.advance(5);
    void s.fetch("/api/b").then(() => (bAt = s.clock.now() - t0));
    await s.clock.advance(2000);
    // b waited for a's end (100 ms), not for the 1.5 s hold limit
    expect(bAt).toBeGreaterThanOrEqual(100);
    expect(bAt).toBeLessThan(400);
  });

  it("a delay emulates a slow network deterministically (seeded per key)", async () => {
    const at: number[] = [];
    for (let k = 0; k < 2; k++) {
      const s = setup({ mode: undefined });
      bridge(s);
      s.server.on("GET", "/api/a", { body: {}, latency: 10 });
      connectAgent(s.rt, { schedule: { order: "seeded", seed: 4, delay: { minMs: 200, maxMs: 800 } } });
      const t0 = s.clock.now();
      let got = -1;
      void s.fetch("/api/a").then(() => (got = s.clock.now() - t0));
      await s.clock.advance(2000);
      at.push(got);
    }
    expect(at[0]).toBe(at[1]);
    expect(at[0]).toBeGreaterThanOrEqual(210);
    expect(at[0]).toBeLessThanOrEqual(830);
  });

  it("the scheduler alone: priorities are a hash of seed and key", () => {
    expect(hash32("1|GET /a#1")).not.toBe(hash32("2|GET /a#1"));
    const clock = new FakeClock();
    const d: string[] = [];
    const sc = new Scheduler(clock, { order: "seeded", seed: 9 }, (x) => d.push(x.key));
    expect(sc.started({ id: 1, name: "GET /a", start: 0 }).key).toBe("GET /a#1");
    expect(sc.started({ id: 2, name: "GET /a", start: 1 }).key).toBe("GET /a#2");
    expect(sc.started({ id: 1, name: "GET /a", start: 0 }).key).toBe("GET /a#1");
  });
});

describe("agent: recording and witnesses (AGENT.md §2)", () => {
  /** A search box without a staleness guard: each response writes the results it carries. */
  function typeahead(s: Setup) {
    const st = s.rt.atom("search", { input: "", results: [] as string[] });
    const type = (value: string, latency: number) => {
      s.server.on("GET", "/api/search", ({ url }) => ({ body: { items: [`${url.searchParams.get("q")}!`] }, latency }));
      s.rt.user({ kind: "type", target: 'searchbox "Search"', value }, () => {
        st.set((v) => ({ ...v, input: value }));
        void (async () => {
          const r = await s.fetch(`/api/search?q=${value}`);
          const j = (await r.json()) as { items: string[] };
          st.set((v) => ({ ...v, results: j.items }));
        })();
      });
    };
    return { st, type };
  }

  it("records a stale overwrite as a witness: the older response's write landed over the newer one's", async () => {
    const s = setup({ mode: undefined });
    const b = bridge(s);
    const c = connectAgent(s.rt, { schedule: "natural" });
    const app = typeahead(s);
    // "reac" is slow, "react" (typed 20 ms later, the same typing burst) is fast
    app.type("reac", 600);
    await s.clock.advance(20);
    app.type("react", 40);
    await s.clock.advance(2000);
    expect(app.st.get().results).toEqual(["reac!"]); // the bug: results for the older query
    const w = c.witnesses();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: "overwrote-newer", subject: "search.results", by: "GET /api/search#1", over: "GET /api/search#2", overKind: "request", byAct: 0, overAct: 0 });
    expect(w[0].gapMs).toBe(20);
    expect(w[0].change).toContain("→");
    await s.clock.advance(1000);
    expect(b.events.some((e) => e.t === "witness")).toBe(true);
    // the recorded steps: one typing burst with its final value and pace, the requests by key, deliveries, writes
    const steps = c.recorded().steps;
    const acts = steps.filter((x) => x.k === "act");
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ kind: "type", target: 'searchbox "Search"', value: "react", count: 2, dur: 20 });
    expect(c.recorded().order).toEqual(["GET /api/search#2", "GET /api/search#1"]);
    expect(steps.some((x) => x.k === "write" && x.by === "GET /api/search#1")).toBe(true);
  });

  it("the same scenario under fifo delivery leaves the right results and no witness", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    const c = connectAgent(s.rt, { schedule: "fifo" });
    const app = typeahead(s);
    app.type("reac", 600);
    await s.clock.advance(20);
    app.type("react", 40);
    await s.clock.advance(2000);
    expect(app.st.get().results).toEqual(["react!"]);
    expect(c.witnesses()).toEqual([]);
  });

  it("a replay of the recorded order reproduces the stale overwrite even when the network is now in order", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    const c = connectAgent(s.rt, { schedule: { order: "given", given: ["GET /api/search#2", "GET /api/search#1"] } });
    const app = typeahead(s);
    app.type("reac", 40);
    await s.clock.advance(20);
    app.type("react", 40);
    await s.clock.advance(2000);
    expect(app.st.get().results).toEqual(["reac!"]);
    expect(c.witnesses()).toHaveLength(1);
  });

  it("an app that ignores stale answers records no witness", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    const c = connectAgent(s.rt, { schedule: "natural" });
    const st = s.rt.atom("search", { input: "", results: [] as string[] });
    let latest = "";
    const type = (value: string, latency: number) => {
      s.server.on("GET", "/api/search", ({ url }) => ({ body: { q: url.searchParams.get("q"), items: [`${url.searchParams.get("q")}!`] }, latency }));
      s.rt.user({ kind: "type", target: 'searchbox "Search"', value }, () => {
        latest = value;
        st.set((v) => ({ ...v, input: value }));
        void (async () => {
          const r = await s.fetch(`/api/search?q=${value}`);
          const j = (await r.json()) as { q: string; items: string[] };
          if (j.q === latest) st.set((v) => ({ ...v, results: j.items }));
        })();
      });
    };
    type("reac", 600);
    await s.clock.advance(20);
    type("react", 40);
    await s.clock.advance(2000);
    expect(st.get().results).toEqual(["react!"]);
    expect(c.witnesses()).toEqual([]);
  });

  it("records identical requests in flight from two separate clicks", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("POST", "/api/orders", { body: { id: 1 }, latency: 300 });
    const c = connectAgent(s.rt, { schedule: "natural" });
    const pay = () => s.rt.user({ kind: "click", target: 'button "Pay"' }, () => void s.fetch("/api/orders", { method: "POST", body: JSON.stringify({ cart: 7 }) }));
    pay();
    await s.clock.advance(120);
    pay();
    await s.clock.advance(1000);
    const w = c.witnesses().filter((x) => x.kind === "identical-in-flight");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ subject: "POST /api/orders", by: "POST /api/orders#2", over: "POST /api/orders#1", byAct: 1, overAct: 0 });
    expect(w[0].gapMs).toBe(120);
  });

  it("one click that sends two identical requests is not two separate actions (no witness)", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("GET", "/api/x", { body: {}, latency: 100 });
    const c = connectAgent(s.rt, { schedule: "natural" });
    s.rt.user({ kind: "click", target: 'button "Load"' }, () => {
      void s.fetch("/api/x");
      void s.fetch("/api/x");
    });
    await s.clock.advance(500);
    expect(c.witnesses()).toEqual([]);
  });

  it("records an error with the request and action that led to it", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("GET", "/api/cart", { body: { items: null }, latency: 50 });
    const c = connectAgent(s.rt, { schedule: "natural" });
    s.rt.user({ kind: "click", target: 'button "Cart"' }, () => {
      void (async () => {
        const r = await s.fetch("/api/cart");
        await r.json();
        s.rt.reportError(new TypeError("Cannot read properties of null (reading 'map')"));
      })();
    });
    await s.clock.advance(500);
    const e = c.errors();
    expect(e).toHaveLength(1);
    expect(e[0].message).toContain("Cannot read properties of null");
    expect(e[0].chain[0]).toBe("GET /api/cart#1");
    expect(e[0].act).toBe(0);
  });

  it("snapshots the app's state at quiet points; whenSettled resolves there", async () => {
    const s = setup({ mode: undefined });
    const b = bridge(s);
    s.server.on("GET", "/api/items", { body: { items: ["a", "b"] }, latency: 80 });
    const st = s.rt.atom("list", { items: [] as string[] });
    const c = connectAgent(s.rt, { schedule: "natural", settleMs: 100 });
    const settled = c.whenSettled(5000);
    void (async () => {
      const r = await s.fetch("/api/items");
      st.set({ items: ((await r.json()) as { items: string[] }).items });
    })();
    await s.clock.advance(1000);
    expect(await settled).toBe(true);
    expect(c.settled).toBe(true);
    expect(c.snapshot().state["list.items"]).toBeDefined();
    expect(c.snapshot().requests).toEqual({ "GET /api/items": 1 });
    await s.clock.advance(500);
    expect(b.events.some((e) => e.t === "snapshot")).toBe(true);
  });
});

describe("agent: snapshots and witnesses that do not depend on arrival order (AGENT.md §2)", () => {
  /** A discovered Redux-like cache: 30 queries of 3 fields each (90 store fields), tagged as discovery tags it. */
  function cache(s: Setup, name: string, source = "redux") {
    const q = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`q${i}`, { status: "fulfilled", requestId: `req${i}`, data: { n: i } }]));
    s.rt.atom(name, q);
    s.rt.internals.hub.get(name)!.source = source;
  }

  it("a snapshot takes registered stores, then component state, then other discovered stores, shallowest first, and says what its budget left out", async () => {
    const keysOf = async (first: boolean) => {
      const s = setup({ mode: undefined });
      bridge(s);
      const c = connectAgent(s.rt, { schedule: "natural" });
      // the same stores, created (and so listed) in two different orders
      const app = () => s.rt.atom("app", { page: 2, filter: { q: "react" } });
      const list = () => {
        s.rt.atom("List.state0", { open: true });
        s.rt.internals.hub.get("List.state0")!.source = "react";
      };
      if (first) {
        app();
        list();
      }
      for (let k = 0; k < 12; k++) cache(s, `cache${k}`);
      if (!first) {
        list();
        app();
      }
      await s.clock.advance(10);
      return c.snapshot();
    };
    const a = await keysOf(true);
    const b = await keysOf(false);
    expect(Object.keys(a.state)).toEqual(Object.keys(b.state));
    expect(Object.keys(a.state)).toHaveLength(1000);
    expect(Object.keys(a.state).slice(0, 4)).toEqual(["app.page", "app.filter.q", "List.state0.open", "cache0.q0.requestId"]);
    expect(a.stateTotal).toBe(3 + 12 * 90);
    expect(a.stateLeft).toBe(3 + 12 * 90 - 1000);
    // the deepest fields of the last caches are what the budget left out
    expect(a.state["cache9.q29.data.n"]).toBeUndefined();
    expect(a.state["cache11.q29.status"]).toBeDefined();
  });

  it("a snapshot within its budget says nothing was left out", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    const c = connectAgent(s.rt, { schedule: "natural" });
    s.rt.atom("app", { page: 2 });
    await s.clock.advance(10);
    const snap = c.snapshot();
    expect(snap.state).toEqual({ "app.page": "2" });
    expect(snap.stateLeft).toBeUndefined();
    expect(snap.stateTotal).toBeUndefined();
  });

  it("the page's last snapshot is not sent again as it unloads (the bridge keeps the quiet one)", async () => {
    const s = setup({ mode: undefined, extraGlobal: { addEventListener: undefined } });
    const b = bridge(s);
    const c = connectAgent(s.rt, { schedule: "natural", settleMs: 100 });
    s.rt.atom("app", { page: 2 });
    await s.clock.advance(1000);
    expect(c.settled).toBe(true);
    c.disconnect();
    await s.clock.advance(1000);
    const end = b.events.find((e) => e.t === "end");
    expect(end).toMatchObject({ t: "end", settled: true });
    expect(end!.snapshot).toBeUndefined();
    expect(b.events.filter((e) => e.t === "snapshot")).toHaveLength(1);
  });

  it("a response that only re-sorts a list of cache keys put nothing older over newer: no witness", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    const c = connectAgent(s.rt, { schedule: "natural" });
    // a cache's bookkeeping: each fulfilled query moves its key to the end of the tag's list
    const st = s.rt.atom("api", { provided: ["list(2)", "list(1)"], last: "" });
    s.server.on("GET", "/api/list", ({ url }) => ({ body: { page: url.searchParams.get("page") }, latency: url.searchParams.get("page") === "1" ? 400 : 40 }));
    const get = (page: string, rewrite: boolean) =>
      s.rt.user({ kind: "click", target: `link "Page ${page}"` }, () => {
        void (async () => {
          const r = await s.fetch(`/api/list?page=${page}`);
          await r.json();
          st.set((v) => ({ ...v, provided: rewrite ? [`other(${page})`] : [...v.provided.filter((k) => k !== `list(${page})`), `list(${page})`] }));
        })();
      });
    get("1", false); // older, slow
    await s.clock.advance(20);
    get("2", false); // newer, fast: moves list(2) to the end
    await s.clock.advance(2000);
    expect(st.get().provided).toEqual(["list(2)", "list(1)"]);
    expect(c.witnesses()).toEqual([]);
    // the same race where the older response replaces the list: an overwrite, recorded
    get("1", true);
    await s.clock.advance(20);
    get("2", true);
    await s.clock.advance(2000);
    expect(c.witnesses().map((w) => `${w.kind} ${w.subject} by ${w.by}`)).toEqual(["overwrote-newer api.provided by GET /api/list#3"]);
  });

  it("a field the store's layout re-cut (the store grew past its field budget elsewhere) was not overwritten: no witness", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    const c = connectAgent(s.rt, { schedule: "natural" });
    const st = s.rt.atom("app", { items: {} as Record<string, Record<string, number>>, cfg: { flag: false, mode: "a" } });
    s.server.on("GET", "/api/items", { body: {}, latency: 400 });
    s.server.on("GET", "/api/flag", { body: {}, latency: 40 });
    s.rt.user({ kind: "click", target: 'button "Load"' }, () => {
      void (async () => {
        await (await s.fetch("/api/items")).json();
        // the older response fills the items: 31 records of 7 fields push the store past 200 fields, so the hub
        // lays `cfg` out as one field from now on (cfg.flag and cfg.mode are gone as fields, cfg appears)
        st.set((v) => ({ ...v, items: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, { a: i, b: i, c: i, d: i, e: i, f: i, g: i }])) }));
      })();
    });
    await s.clock.advance(20);
    s.rt.user({ kind: "click", target: 'button "Flag"' }, () => {
      void (async () => {
        await (await s.fetch("/api/flag")).json();
        st.set((v) => ({ ...v, cfg: { ...v.cfg, flag: true } }));
      })();
    });
    await s.clock.advance(2000);
    expect(st.get().cfg.flag).toBe(true);
    expect(s.rt.internals.hub.leaf("app.cfg")).toBeDefined();
    expect(c.witnesses()).toEqual([]);
  });
});

describe("agent: the bridge link (AGENT.md §4)", () => {
  it("hello registers the page; the bridge's schedule applies; responses before the reply wait for it", async () => {
    const s = setup({ mode: undefined });
    const b = bridge(s, { order: "fifo" }, 30);
    const c = connectAgent(s.rt);
    expect(c.schedule).toBeNull();
    const seen = await overlap(s, 200, 10);
    expect(b.hellos).toHaveLength(1);
    expect(b.hellos[0]).toMatchObject({ schema: "genclass-agent/1", page: { route: "/search" } });
    expect(c.run).toBe("r1");
    expect(c.schedule).toEqual({ order: "fifo" });
    expect(seen).toEqual(["a", "b"]);
  });

  it("no bridge: hello fails, the schedule is natural and nothing else waits", async () => {
    const s = setup({ mode: undefined });
    const c = connectAgent(s.rt);
    expect(await overlap(s)).toEqual(["b", "a"]);
    expect(c.schedule).toEqual({ order: "natural" });
    expect(c.connected).toBe(false);
  });

  it("the agent's own requests are never observed: no op, no event, no decision", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    connectAgent(s.rt, { schedule: "natural", settleMs: 50 });
    s.server.on("GET", "/api/items", { body: { items: [1] }, latency: 30 });
    const p = s.fetch("/api/items");
    await s.clock.advance(2000);
    await p;
    const names = s.rt.history().map((e) => e.name);
    expect(names.some((n) => n.includes("/v1/"))).toBe(false);
    expect(names.some((n) => n.includes("/api/items"))).toBe(true);
  });

  it("does nothing on a public host or with a non-loopback bridge URL", async () => {
    const s = setup({ mode: undefined, extraGlobal: { location: { href: "https://app.example.com/search", pathname: "/search", hostname: "app.example.com", search: "" } } });
    const c = connectAgent(s.rt, { schedule: "fifo" });
    expect(c.reason).toBe("not-dev-host");
    expect(await overlap(s)).toEqual(["b", "a"]);
    const s2 = setup({ mode: undefined, extraGlobal: { location: { href: "http://localhost:5173/", pathname: "/", hostname: "localhost", search: "" }, console: { warn: () => undefined } } });
    expect(connectAgent(s2.rt, { url: "https://collector.example.com" }).reason).toBe("not-loopback");
  });

  it("disconnect delivers what is held and restores the delivery gate", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("GET", "/api/a", { body: { v: "a" }, latency: 10 });
    const orig = s.rt.runDelivery;
    const c: AgentConnection = connectAgent(s.rt, { schedule: { order: "given", given: ["GET /api/never#1", "GET /api/a#1"], maxHoldMs: 10_000 } });
    expect(s.rt.runDelivery).not.toBe(orig);
    let got = false;
    void s.fetch("/api/a").then(() => (got = true));
    await s.clock.advance(200);
    expect(got).toBe(false);
    c.disconnect();
    await s.clock.advance(10);
    expect(got).toBe(true);
    expect(s.rt.runDelivery).toBe(orig);
    expect(c.reason).toBe("disconnected");
  });

  it("connectAgent twice returns the same connection; hold: false never holds", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    const c = connectAgent(s.rt, { schedule: "fifo", hold: false });
    expect(connectAgent(s.rt)).toBe(c);
    expect(await overlap(s)).toEqual(["b", "a"]);
  });
});

describe("agent: review fixes (AGENT.md §2–§4)", () => {
  /** A clock whose timers fire half a millisecond early by its own measure (as performance.now can read). */
  class EarlyClock extends FakeClock {
    override setTimeout(fn: () => void, ms: number): unknown {
      return super.setTimeout(fn, Math.max(0, ms - 0.5));
    }
  }

  it("a held response is delivered even when the clock fires its hold timer a little early", async () => {
    const clock = new EarlyClock();
    const got: string[] = [];
    const sc = new Scheduler(clock, { order: "given", given: ["GET /never#1", "GET /a#1"], maxHoldMs: 500 }, (d) => got.push(`${d.key}${d.forced ? " forced" : ""}`));
    sc.started({ id: 1, name: "GET /a", start: 0 });
    sc.gate({ id: 1, name: "GET /a", start: 0 }, (landed) => landed());
    await clock.advance(450);
    expect(got).toEqual([]);
    await clock.advance(1000);
    expect(got).toEqual(["GET /a#1 forced"]);
  });

  it("a response's delay does not count against its hold: a 2 s slow network is not a forced delivery", async () => {
    const clock = new FakeClock();
    const got: { key: string; at: number; forced: boolean }[] = [];
    const sc = new Scheduler(clock, { order: "seeded", seed: 1, delay: { minMs: 2000, maxMs: 2000 }, maxHoldMs: 500 }, (d) => got.push(d));
    const t0 = clock.now();
    sc.gate({ id: 1, name: "GET /a", start: t0 }, (landed) => landed());
    await clock.advance(3000);
    expect(got).toHaveLength(1);
    expect(got[0].forced).toBe(false);
    expect(got[0].at - t0).toBeGreaterThanOrEqual(2000);
    expect(got[0].at - t0).toBeLessThan(2100);
  });

  it("fifo: a response the runtime still holds keeps later responses waiting until the app has it", async () => {
    const clock = new FakeClock();
    const order: string[] = [];
    const sc = new Scheduler(clock, { order: "fifo", gapMs: 0 }, (d) => order.push(d.key));
    const a = { id: 1, name: "GET /a", start: clock.now() };
    const b = { id: 2, name: "GET /b", start: clock.now() + 1 };
    sc.started(a);
    sc.started(b);
    let landA: (() => void) | null = null;
    sc.gate(a, (landed) => (landA = landed)); // released into the runtime, which holds it (a guard decision)
    let bOut = false;
    sc.gate(b, (landed) => {
      bOut = true;
      landed();
    });
    await clock.advance(200);
    expect(bOut).toBe(false);
    landA!();
    await clock.advance(10);
    expect(bOut).toBe(true);
    expect(order).toEqual(["GET /a#1", "GET /b#1"]);
  });

  it("retries and hedges keep the numbering of the requests after them", () => {
    const clock = new FakeClock();
    const sc = new Scheduler(clock, { order: "natural" }, () => undefined);
    expect(sc.started({ id: 1, name: "GET /a", start: 0 }).key).toBe("GET /a#1");
    expect(sc.started({ id: 2, name: "GET /a", start: 1, attempt: 2, cause: 1 }).key).toBe("GET /a#1~retry2");
    expect(sc.started({ id: 3, name: "GET /a", start: 2, attempt: 1, cause: 1 }).key).toBe("GET /a#1~hedge");
    expect(sc.started({ id: 4, name: "GET /a", start: 3 }).key).toBe("GET /a#2");
  });

  it("parallel requests from one click are peers: the one delivered last is not 'older data over newer'", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("GET", "/api/cpu", { body: {}, latency: 300 });
    s.server.on("GET", "/api/mem", { body: {}, latency: 50 });
    const st = s.rt.atom("ui", { pending: 2 });
    const c = connectAgent(s.rt, { schedule: "natural" });
    s.rt.user({ kind: "click", target: 'button "Refresh"' }, () => {
      for (const p of ["/api/cpu", "/api/mem"]) {
        void (async () => {
          await (await s.fetch(p)).json();
          st.set((v) => ({ pending: v.pending - 1 }));
        })();
        s.clock.t += 1; // the second starts a moment after the first, as on a real clock
      }
    });
    await s.clock.advance(1000);
    expect(st.get().pending).toBe(0);
    expect(c.witnesses()).toEqual([]);
  });

  it("an aborted request followed by the same request from another click is not a duplicate", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    s.server.on("GET", "/api/list", { body: { items: [] }, latency: 300 });
    const c = connectAgent(s.rt, { schedule: "natural" });
    let ctrl: AbortController | null = null;
    const refresh = () =>
      s.rt.user({ kind: "click", target: 'button "Refresh"' }, () => {
        ctrl?.abort();
        ctrl = new AbortController();
        void s.fetch("/api/list", { signal: ctrl.signal }).catch(() => undefined);
      });
    refresh();
    await s.clock.advance(50);
    refresh();
    await s.clock.advance(1000);
    expect(c.witnesses().filter((w) => w.kind === "identical-in-flight")).toEqual([]);
  });

  it("writes from before connectAgent are recorded without inventing witnesses", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    const st = s.rt.atom("list", { items: [] as number[] });
    s.server.on("GET", "/api/items", ({ n }) => ({ body: { items: [n] }, latency: 20 }));
    for (let i = 0; i < 2; i++) {
      void (async () => {
        const j = (await (await s.fetch("/api/items")).json()) as { items: number[] };
        st.set({ items: j.items });
      })();
      await s.clock.advance(100);
    }
    const c = connectAgent(s.rt, { schedule: "natural" });
    expect(c.recorded().steps.filter((x) => x.k === "write")).toHaveLength(2);
    expect(c.witnesses()).toEqual([]);
  });

  it("a pending debounce keeps the page from looking quiet until its request has answered", async () => {
    const holder: { clock?: FakeClock } = {};
    const s = setup({ mode: undefined, extraGlobal: { setTimeout: (fn: () => void, ms: number) => holder.clock!.setTimeout(fn, ms), clearTimeout: (h: unknown) => holder.clock!.clearTimeout(h) } });
    holder.clock = s.clock;
    bridge(s);
    s.server.on("GET", "/api/search", { body: { items: ["react!"] }, latency: 50 });
    const st = s.rt.atom("search", { results: [] as string[] });
    const origT = s.g.setTimeout;
    const c = connectAgent(s.rt, { schedule: "natural", settleMs: 100 });
    await s.clock.advance(500);
    const setT = s.g.setTimeout as (f: () => void, ms: number) => unknown;
    s.rt.user({ kind: "type", target: 'searchbox "Search"', value: "react" }, () => {
      setT(() => {
        void (async () => {
          const j = (await (await s.fetch("/api/search?q=react")).json()) as { items: string[] };
          st.set({ results: j.items });
        })();
      }, 500);
    });
    await s.clock.advance(300);
    expect(c.settled).toBe(false);
    await s.clock.advance(1000);
    expect(c.settled).toBe(true);
    expect(c.snapshot().state["search.results"]).toContain("react!");
    c.disconnect();
    expect(s.g.setTimeout).toBe(origT);
  });

  it("protected requests are recorded but never held", async () => {
    const s = setup({ mode: undefined, requests: { protect: ["/api/pay"] } });
    bridge(s);
    s.server.on("POST", "/api/pay", { body: { ok: true }, latency: 20 });
    const c = connectAgent(s.rt, { schedule: { order: "given", given: ["GET /api/never#1", "POST /api/pay#1"], maxHoldMs: 5000 } });
    let at = -1;
    const t0 = s.clock.now();
    void s.fetch("/api/pay", { method: "POST", body: "{}" }).then(() => (at = s.clock.now() - t0));
    await s.clock.advance(200);
    expect(at).toBeGreaterThanOrEqual(20);
    expect(at).toBeLessThan(100);
    expect(c.recorded().order).toEqual(["POST /api/pay#1"]);
  });

  it("hold: false tells the bridge the page runs natural (no explore slot is spent on it)", async () => {
    const s = setup({ mode: undefined });
    const b = bridge(s);
    connectAgent(s.rt, { hold: false });
    await s.clock.advance(100);
    expect(b.hellos[0].schedule).toEqual({ order: "natural" });
  });

  it("a hello reply after the timeout: the page reports the schedule it actually ran", async () => {
    const s = setup({ mode: undefined });
    const b = bridge(s, { order: "fifo" }, 1000);
    const c = connectAgent(s.rt, { helloTimeoutMs: 600 });
    await s.clock.advance(700);
    expect(c.schedule).toEqual({ order: "natural" });
    await s.clock.advance(2000);
    expect(c.run).toBe("r1");
    expect(b.events.find((e) => e.t === "schedule")).toMatchObject({ spec: { order: "natural" }, late: true });
  });

  it("the bridge URL is compared in one spelling: its requests are never observed, however it was written", async () => {
    const s = setup({ mode: undefined });
    bridge(s);
    const c = connectAgent(s.rt, { url: "http://LOCALHOST:47357/", schedule: "natural", settleMs: 50 });
    expect(c.url).toBe("http://localhost:47357");
    await s.clock.advance(2000);
    expect(s.rt.history().some((e) => e.name.includes("/v1/"))).toBe(false);
  });

  it("only pages on this machine connect by default", () => {
    for (const h of ["localhost", "127.0.0.1", "app.localhost", "::1"]) expect(isDevHost(h), h).toBe(true);
    for (const h of ["shop.test", "192.168.1.5", "10.0.0.2", "printer.local", "corp.internal", "", "example.com"]) expect(isDevHost(h), h).toBe(false);
  });
});

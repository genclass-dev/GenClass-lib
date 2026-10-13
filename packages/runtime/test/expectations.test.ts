// Flow expectations (docs/runtime/EXPECTATIONS.md; CONTRACT §0.5 precision, §4 learned state, §8 reporting): a
// deterministic, reporting-only layer that learns what each user action on a route usually does and reports the
// step that did not happen. No model call, no action, no model-visible text: the decider never sees a trigger here.
import { describe, expect, it, vi } from "vitest";
import { FlowProfiles, type FlowEnv } from "../src/learn/flows.js";
import type { Expectation, Report, SinkRecord } from "../src/types.js";
import { RUNTIME_VERSION } from "../src/version.js";
import { setup, type Setup } from "./helpers.js";

/** A localStorage stand-in shared between "sessions" (runtimes). */
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

type Opts = Parameters<typeof setup>[0];

/** A runtime whose reports are collected; learning is in memory only unless storage is given (then persistence is the default). */
function app(reports: Report[], opts: Opts = {}): Setup {
  const { learn, ...rest } = opts;
  return setup({ learn: { persist: false, ...(learn ?? {}) }, report: (r) => reports.push(r), ...rest });
}

const exps = (reports: Report[]): Expectation[] => reports.filter((r) => r.kind === "expectation").map((r) => r.expectation!);

/** The checkout pattern: a click that POSTs the cart and writes the response into a store. */
function cartApp(s: Setup, latency: number | ((n: number) => number) = 50) {
  s.server.on("POST", "/api/cart", ({ n }) => ({ body: { items: [n] }, latency: typeof latency === "function" ? latency(n) : latency }));
  const cart = s.rt.atom("cart", { items: [] as number[] });
  let k = 0;
  const click = async (o: { send?: boolean; write?: boolean; clicks?: number; disabled?: boolean; wait?: number } = {}) => {
    const action = { kind: "click", target: 'button "Add to cart"', ...(o.clicks ? { clicks: o.clicks } : {}), ...(o.disabled ? { data: { disabled: true } } : {}) };
    s.rt.user(action, () => {
      if (o.send === false) return;
      void (async () => {
        const res = await s.fetch("/api/cart", { method: "POST", body: JSON.stringify({ item: ++k }) });
        const d = (await res.json()) as { items: number[] };
        if (o.write !== false) cart.set({ items: d.items });
      })();
    });
    await s.clock.advance(o.wait ?? 2000);
  };
  return { cart, click };
}

/** A page with a real history: `go(path)` navigates (pushState), the nav observer is on. */
function navApp(reports: Report[], path = "/checkout") {
  const loc = { href: `http://app.test${path}`, pathname: path, search: "", hash: "" };
  const history = { pushState() {}, replaceState() {} };
  const s = app(reports, { observe: { fetch: true, nav: true, xhr: false, user: false, errors: false, storage: false, perf: false, websocket: false, timers: false }, extraGlobal: { location: loc, history, addEventListener() {}, removeEventListener() {} } });
  const go = (to: string) => {
    loc.pathname = to;
    loc.href = `http://app.test${to}`;
    history.pushState({}, "", to);
  };
  return { s, go };
}

describe("flow expectations: learning (EXPECTATIONS.md §1)", () => {
  it("learns, per route and user action, the requests it sends, what their responses write and how long it settles; rt.learned() shows it", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    const { click } = cartApp(s);
    for (let i = 0; i < 8; i++) await click();
    const L = s.rt.learned();
    expect(L.route).toBe("/search");
    expect(L.session).toBe(1);
    expect(L.flows).toHaveLength(1);
    const f = L.flows[0];
    expect(f).toMatchObject({ route: "/search", action: 'click button "Add to cart"', n: 8, repeats: 7, sessions: 1 });
    // expected the first time in a page load (8 of 8); a repeat needs 8 repeats first (7 so far)
    expect(f.children).toEqual([{ signature: "POST /api/cart", n: 8, share: 1, onRepeat: 7, expected: true, expectedOnRepeat: false, delayMs: { p50: 0, p95: 0 } }]);
    expect(f.writes).toEqual([{ signature: "POST /api/cart", field: "cart.items", n: 8, of: 8, share: 1, expected: true }]);
    expect(f.followUps).toEqual([]);
    expect(f.nav).toEqual([]);
    expect(f.settleMs).toEqual({ p50: 50, p95: 50 });
    expect(L.deviations).toEqual([]);
    expect(reports).toEqual([]);
    // nothing here went through the model
    expect(s.decider.calls.map((c) => c.trigger)).not.toContain("transition");
  });

  it("typing is never a flow; a step seen below the support threshold is not expected", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    const { click } = cartApp(s);
    s.rt.user({ kind: "type", target: 'input "Search"', value: "re" });
    await s.clock.advance(2000);
    for (let i = 0; i < 7; i++) await click();
    expect(s.rt.learned().flows.map((f) => f.action)).toEqual(['click button "Add to cart"']);
    expect(s.rt.learned().flows[0].children[0].expected).toBe(false); // 7 < 8
    await click({ send: false });
    expect(reports).toEqual([]);
  });
});

describe("flow expectations: absence detection (EXPECTATIONS.md §2)", () => {
  it("a click that usually sends a request sent nothing: one report at the learned deadline, through the report path and the expectation event", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    const events: Expectation[] = [];
    s.rt.on("expectation", (e) => events.push(e));
    const { click } = cartApp(s);
    for (let i = 0; i < 9; i++) await click();
    expect(s.rt.learned().flows[0].children[0]).toMatchObject({ n: 9, onRepeat: 8, expected: true, expectedOnRepeat: true });
    await click({ send: false, wait: 1100 });
    const e = exps(reports);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: "request", route: "/search", action: 'clicking button "Add to cart"', signature: "POST /api/cart", seen: 9, of: 9, sessions: 1, waitedMs: 1000, usualMs: 0 });
    expect(e[0].message).toBe('[GenClass] Expected a request on /search: clicking button "Add to cart" usually sends POST /api/cart (9 of 9 times across 1 session, within 0.00 s); this time nothing was sent in 1.0 s.');
    expect(reports[0].mode).toBe("guard");
    expect(events).toEqual(e);
    expect(s.rt.learned().deviations).toEqual(e);
    // the flow closes without a second report, and the miss is learned (10 observations, 9 with the request)
    await s.clock.advance(3000);
    expect(exps(reports)).toHaveLength(1);
    expect(s.rt.learned().flows[0]).toMatchObject({ n: 10 });
    expect(s.rt.learned().flows[0].children[0]).toMatchObject({ n: 9, expected: false });
    // there is no trigger kind for an expectation: whatever the model was asked about, it was never this
    expect(s.decider.calls.every((c) => c.trigger === "request" || c.trigger === "delivery" || c.trigger === "mutation")).toBe(true);
  });

  it("learn.minSupport sets the support; a step seen in fewer than minShare of the observations is not expected", async () => {
    const reports: Report[] = [];
    const s = app(reports, { learn: { minSupport: 3 } });
    const { click } = cartApp(s);
    for (let i = 0; i < 4; i++) await click(); // 4 observations, 3 of them repeats
    await click({ send: false });
    expect(exps(reports).map((e) => [e.kind, e.seen, e.of])).toEqual([["request", 4, 4]]);

    const reports2: Report[] = [];
    const s2 = app(reports2);
    const c2 = cartApp(s2);
    for (let i = 0; i < 10; i++) await c2.click({ send: i === 2 }); // 1 of 10 sends: usual is "nothing"
    expect(reports2).toEqual([]);
    const reports3: Report[] = [];
    const s3 = app(reports3);
    const c3 = cartApp(s3);
    for (let i = 0; i < 10; i++) await c3.click({ send: i !== 2 }); // 9 of 10 (0.9 < 0.95)
    await c3.click({ send: false });
    expect(reports3).toEqual([]);
    expect(s3.rt.learned().flows[0].children[0]).toMatchObject({ n: 9, share: 9 / 11, expected: false });
  });

  it("a response whose handler usually writes a field wrote nothing: reported when the flow closes", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    const { click, cart } = cartApp(s);
    for (let i = 0; i < 8; i++) await click();
    expect(cart.get().items).toEqual([8]);
    await click({ write: false });
    const e = exps(reports);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: "write", signature: "POST /api/cart", field: "cart.items", seen: 8, of: 8 });
    expect(e[0].message).toBe('[GenClass] Expected a state change on /search: the response to POST /api/cart after clicking button "Add to cart" usually writes cart.items (8 of 8 times); this time it wrote nothing.');
  });

  it("a follow-up request that usually comes after another one never came: reported as a follow-up, not as a missing request", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    s.server.on("POST", "/api/orders", { body: { id: 1 }, latency: 50 });
    s.server.on("GET", "/api/orders", { body: [], latency: 50 });
    let k = 0;
    const order = async (refetch: boolean) => {
      s.rt.user({ kind: "click", target: 'button "Place order"' }, () => {
        void (async () => {
          const res = await s.fetch("/api/orders", { method: "POST", body: JSON.stringify({ order: ++k }) });
          if (refetch && res.ok) await s.fetch("/api/orders");
        })();
      });
      await s.clock.advance(2000);
    };
    for (let i = 0; i < 8; i++) await order(true);
    const f = s.rt.learned().flows[0];
    expect(f.followUps).toEqual([{ after: "POST /api/orders", then: "GET /api/orders", n: 8, of: 8, share: 1, expected: true, delayMs: { p50: 0, p95: 0 } }]);
    await order(false);
    const e = exps(reports);
    expect(e.map((x) => x.kind)).toEqual(["follow-up"]);
    expect(e[0]).toMatchObject({ signature: "GET /api/orders", after: "POST /api/orders", seen: 8, of: 8, waitedMs: 1000 });
    expect(e[0].message).toBe('[GenClass] Expected a follow-up on /search: after POST /api/orders completes, clicking button "Place order" usually sends GET /api/orders (8 of 8 times, within 0.00 s); this time nothing followed in 1.0 s.');
    // the POST itself failing is not a missing follow-up (nor a missing request)
    s.server.on("POST", "/api/orders", { status: 500, latency: 50 });
    await order(true);
    expect(exps(reports)).toHaveLength(1);
  });

  it("a navigation that usually follows the action did not happen", async () => {
    const reports: Report[] = [];
    const { s, go } = navApp(reports);
    s.server.on("POST", "/api/orders", { body: { id: 1 }, latency: 50 });
    let k = 0;
    const order = async (navigate: boolean) => {
      s.rt.user({ kind: "click", target: 'button "Place order"' }, () => {
        void (async () => {
          await s.fetch("/api/orders", { method: "POST", body: JSON.stringify({ order: ++k }) });
          if (navigate) go("/confirmation");
        })();
      });
      await s.clock.advance(2000);
      go("/checkout");
      await s.clock.advance(100);
    };
    for (let i = 0; i < 8; i++) await order(true);
    const f = s.rt.learned().flows.find((x) => x.route === "/checkout")!;
    expect(f.nav).toEqual([{ to: "/confirmation", n: 8, share: 1, expected: true }]);
    await order(false);
    const e = exps(reports);
    expect(e.map((x) => x.kind)).toEqual(["navigation"]);
    expect(e[0]).toMatchObject({ route: "/checkout", to: "/confirmation", seen: 8, of: 8 });
    expect(e[0].message).toMatch(/^\[GenClass\] Expected a navigation on \/checkout: clicking button "Place order" usually leads to \/confirmation \(8 of 8 times, within 0\.05 s\); this time the page stayed on \/checkout for 1\.5 s\.$/);
  });

  it("a request that usually answers is still waiting past twice its p99 latency (at least 1 s)", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    let slow = false;
    s.server.on("GET", "/api/items", () => ({ body: [], latency: slow ? 5000 : 50 }));
    for (let i = 0; i < 10; i++) {
      const p = s.fetch("/api/items");
      await s.clock.advance(500);
      await p;
    }
    slow = true;
    const p = s.fetch("/api/items");
    await s.clock.advance(900);
    expect(reports).toEqual([]);
    await s.clock.advance(200);
    const e = exps(reports);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: "response", signature: "GET /api/items", seen: 10, of: 10, waitedMs: 1000, usualMs: 50 });
    expect(e[0].message).toBe("[GenClass] Expected a response: GET /api/items usually answers within 0.05 s (p99 of the last 10; 10 of 10 recent requests answered); this one has been waiting 1.0 s (bound 1.0 s).");
    await s.clock.advance(5000);
    await p;
    expect(exps(reports)).toHaveLength(1);
  });

  it("requests of one signature hanging together are one response line (none again until one of them answers)", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    let slow = false;
    s.server.on("GET", "/api/items", () => ({ body: [], latency: slow ? 3000 : 50 }));
    for (let i = 0; i < 10; i++) {
      const p = s.fetch("/api/items");
      await s.clock.advance(500);
      await p;
    }
    slow = true;
    const a = s.fetch("/api/items");
    await s.clock.advance(200);
    const b = s.fetch("/api/items");
    await s.clock.advance(1500);
    expect(exps(reports).map((e) => [e.kind, e.op])).toEqual([["response", exps(reports)[0].op]]);
    await s.clock.advance(3000);
    await Promise.all([a, b]);
    expect(exps(reports)).toHaveLength(1);
  });
});

/** A flow learner on a hand-driven environment (no runtime): for the bounds. */
function learner() {
  const env: FlowEnv = {
    now: () => 0,
    setTimeout: () => null,
    clearTimeout: () => undefined,
    hidden: () => false,
    online: () => true,
    quiet: () => false,
    startedSince: () => false,
    report: () => undefined,
    changed: () => undefined,
  };
  const f = new FlowProfiles(env, { minSupport: 8, minStoredSupport: 20, minShare: 0.95, minSessions: 1 });
  let id = 0;
  const click = (route: string, label: string) => f.onUser({ id: ++id, kind: "user", name: `click ${label}`, start: 0, root: id, meta: { action: { kind: "click", target: label } }, scope: { route } } as never);
  return { f, click };
}
/** Labels without digits (digits are normalised away in flow keys): "aa", "ba", … */
const label = (i: number) => `button "${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}"`;
const onRoute = (f: FlowProfiles, route: string) => [...f.byKey.values()].filter((r) => r.route === route).map((r) => r.label);

describe("flow expectations: bounds (EXPECTATIONS.md §1)", () => {
  it("64 flows per route and 500 in total, the least recently used dropped first", () => {
    const { f, click } = learner();
    for (let i = 0; i < 64; i++) click("/a", label(i));
    expect(f.byKey.size).toBe(64);
    click("/a", label(0)); // used again
    click("/a", label(64)); // the 65th on the route: the least recently used one (label 1) goes
    expect(onRoute(f, "/a")).toHaveLength(64);
    expect(onRoute(f, "/a")).toContain(label(0));
    expect(onRoute(f, "/a")).not.toContain(label(1));
    expect(onRoute(f, "/a")).toContain(label(64));
    for (let r = 0; r < 9; r++) for (let i = 0; i < 50; i++) click(`/route-${String.fromCharCode(98 + r)}`, label(i));
    // 64 + 450 = 514: the 14 least recently used overall (labels 2 to 15 on /a) went
    expect(f.byKey.size).toBe(500);
    expect(onRoute(f, "/a")).toHaveLength(50);
    expect(onRoute(f, "/a")).toContain(label(0));
    expect(onRoute(f, "/a")).not.toContain(label(15));
    expect(onRoute(f, "/a")).toContain(label(16));
  });

  it("stored records are held to the same bounds when loaded (per route, in total, and per flow)", () => {
    const many = (n: number, key: (k: number) => string, v: (k: number) => unknown) => Object.fromEntries(Array.from({ length: n }, (_, k) => [key(k), v(k)]));
    const rec = (i: number, route: string) => ({
      h: `h${i}`,
      route,
      n: 10,
      used: i + 1,
      children: many(20, (k) => `POST /x/${label(k)}`, () => ({ n: 10, own: many(12, (k) => `b${k}`, () => 1) })),
      follows: many(20, (k) => `POST /x\tGET /y/${label(k)}`, () => ({ n: 1 })),
      writes: { "POST /x": { n: 10, fields: many(30, (k) => `f.${label(k)}`, () => 1) } },
      nav: many(12, (k) => `/n/${label(k)}`, () => 1),
      navKeys: many(12, (k) => `k${k}`, () => 1),
    });
    const a = learner().f;
    a.load(Array.from({ length: 70 }, (_, i) => rec(i, "/a")));
    expect(a.byKey.size).toBe(64);
    expect(a.byKey.has("h0")).toBe(false); // the 6 least used went
    expect(a.byKey.has("h6")).toBe(true);
    const r = a.byKey.get("h6")!;
    expect(Object.keys(r.children)).toHaveLength(16);
    expect(Object.keys(Object.values(r.children)[0].own)).toHaveLength(8);
    expect(Object.keys(r.follows)).toHaveLength(16);
    expect(Object.keys(r.writes["POST /x"].fields)).toHaveLength(16);
    expect(Object.keys(r.nav)).toHaveLength(8);
    expect(Object.keys(r.navKeys)).toHaveLength(8);
    expect(r.stored).toBe(true);
    const b = learner().f;
    b.load(Array.from({ length: 600 }, (_, i) => rec(i, `/route-${String.fromCharCode(97 + (i % 10))}`)));
    expect(b.byKey.size).toBe(500);
    expect(b.byKey.has("h99")).toBe(false);
    expect(b.byKey.has("h100")).toBe(true);
  });
});

describe("flow expectations: false-positive controls (EXPECTATIONS.md §3)", () => {
  it("nothing fires on clean runs: the typeahead and checkout patterns, varying latency, 30 rounds", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    s.server.on("GET", "/api/search", ({ url }) => {
      const q = url.searchParams.get("q");
      return { body: { q, results: [`${q}-1`] }, latency: q === "rea" ? 900 : 120 };
    });
    const search = s.rt.atom("search", { query: "", results: [] as string[] });
    const type = (q: string) =>
      s.rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
        search.set((v) => ({ ...v, query: q }));
        void (async () => {
          const res = await s.fetch(`/api/search?q=${q}`);
          const data = (await res.json()) as { results: string[] };
          search.set((v) => ({ ...v, results: data.results }));
        })();
      });
    const { click } = cartApp(s, (n) => 50 + (n % 5) * 100);
    for (let round = 0; round < 30; round++) {
      type("r");
      await s.clock.advance(80);
      type("re");
      await s.clock.advance(70);
      type("rea");
      await s.clock.advance(90);
      type("reac");
      await s.clock.advance(3000);
      await click();
    }
    expect(reports.filter((r) => r.kind === "expectation")).toEqual([]);
    expect(s.rt.learned().flows.map((f) => f.action)).toEqual(['click button "Add to cart"']);
    expect(s.rt.learned().flows[0]).toMatchObject({ n: 30 });
  });

  it("the second click of a double click, a disabled control, a hidden page, an offline page and a protected request are never reported", async () => {
    const reports: Report[] = [];
    const doc = { visibilityState: "visible" };
    const nav = { onLine: true };
    const s = app(reports, { extraGlobal: { document: doc, navigator: nav }, requests: { protect: ["/api/pay"] } });
    const { click } = cartApp(s);
    for (let i = 0; i < 9; i++) await click(); // from here a miss would be reported (see above)
    await click({ send: false, clicks: 2 });
    await click({ send: false, disabled: true });
    doc.visibilityState = "hidden";
    await click({ send: false });
    doc.visibilityState = "visible";
    nav.onLine = false;
    await click({ send: false });
    nav.onLine = true;
    expect(reports).toEqual([]);
    // the double click, the disabled click and the hidden one were not learned either; the offline one was
    expect(s.rt.learned().flows[0]).toMatchObject({ n: 10 });
    // a protected request is learned as such and never expected
    s.server.on("POST", "/api/pay", { body: { ok: true }, latency: 50 });
    const pay = async (send: boolean) => {
      s.rt.user({ kind: "click", target: 'button "Pay"' }, () => {
        if (send) void s.fetch("/api/pay", { method: "POST", body: "{}" });
      });
      await s.clock.advance(2000);
    };
    for (let i = 0; i < 9; i++) await pay(true);
    expect(s.rt.learned().flows.find((f) => f.action === 'click button "Pay"')!.children).toEqual([{ signature: "POST /api/pay", n: 9, share: 1, onRepeat: 8, expected: false, expectedOnRepeat: false, protected: true, delayMs: { p50: 0, p95: 0 } }]);
    await pay(false);
    expect(reports).toEqual([]);
  });

  it("a second click while the first is still in flight (the app's own guard ignores it) is neither checked nor learned", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    s.server.on("POST", "/api/orders", { body: { id: 1 }, latency: 1200 });
    let busy = false;
    const place = () =>
      s.rt.user({ kind: "click", target: 'button "Place order"' }, () => {
        if (busy) return;
        busy = true;
        void s.fetch("/api/orders", { method: "POST", body: "{}" }).then(() => {
          busy = false;
        });
      });
    for (let i = 0; i < 10; i++) {
      place();
      await s.clock.advance(3000);
    }
    expect(s.rt.learned().flows[0].children[0]).toMatchObject({ n: 10, expected: true, expectedOnRepeat: true });
    place();
    await s.clock.advance(400);
    place(); // ignored by the app: its POST is in flight
    await s.clock.advance(4000);
    expect(exps(reports)).toEqual([]);
    expect(s.rt.learned().flows[0]).toMatchObject({ n: 11 });
  });

  it("a GET is never expected to start (an app cache may answer it) nor to write (an unchanged answer may be left unwritten); a 4xx answer is not a missing write or follow-up", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    s.server.on("GET", "/api/orders", { body: [], latency: 50 });
    const orders = s.rt.atom("orders", { at: 0 });
    let k = 0;
    const tab = async (o: { send?: boolean; write?: boolean } = {}) => {
      s.rt.user({ kind: "click", target: 'tab "Orders"' }, () => {
        if (o.send === false) return;
        void (async () => {
          const res = await s.fetch("/api/orders");
          await res.json();
          if (o.write !== false) orders.set({ at: ++k });
        })();
      });
      await s.clock.advance(2000);
    };
    for (let i = 0; i < 12; i++) await tab();
    const t = s.rt.learned().flows[0];
    expect(t.children[0]).toMatchObject({ signature: "GET /api/orders", share: 1, expected: false, expectedOnRepeat: false });
    expect(t.writes).toEqual([{ signature: "GET /api/orders", field: "orders.at", n: 12, of: 12, share: 1, expected: false }]);
    await tab({ send: false }); // answered from the app's cache
    await tab({ write: false }); // an unchanged answer the app did not write again
    expect(reports).toEqual([]);

    let status = 200;
    s.server.on("POST", "/api/cart", ({ n }) => ({ status, body: { items: [n] }, latency: 50 }));
    s.server.on("GET", "/api/cart/count", { body: { count: 1 }, latency: 50 });
    const cart = s.rt.atom("cart", { items: [] as number[] });
    const add = async () => {
      s.rt.user({ kind: "click", target: 'button "Add to cart"' }, () => {
        void (async () => {
          const res = await s.fetch("/api/cart", { method: "POST", body: "{}" });
          if (!res.ok) return; // the server declined (out of stock): nothing to write, nothing to refetch
          cart.set({ items: ((await res.json()) as { items: number[] }).items });
          await s.fetch("/api/cart/count");
        })();
      });
      await s.clock.advance(2000);
    };
    for (let i = 0; i < 9; i++) await add();
    const f = s.rt.learned().flows.find((x) => x.action === 'click button "Add to cart"')!;
    expect(f.writes).toEqual([{ signature: "POST /api/cart", field: "cart.items", n: 9, of: 9, share: 1, expected: true }]);
    expect(f.followUps.map((u) => [u.after, u.then, u.expected])).toEqual([["POST /api/cart", "GET /api/cart/count", true]]);
    status = 409;
    await add();
    expect(reports).toEqual([]);
  });

  it("a step is expected only on the branch of the handler it was learned on: a submit that wrote a validation error sent nothing by design", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    s.server.on("POST", "/api/orders", { body: { id: 1 }, latency: 50 });
    const form = s.rt.atom("form", { placing: false, error: "" });
    const submit = async (how: "valid" | "invalid" | "dead") => {
      s.rt.user({ kind: "submit", target: 'form "Checkout"' }, () => {
        if (how === "invalid") return form.set((v) => ({ ...v, error: "Card number is required" }));
        form.set((v) => ({ ...v, placing: true, error: "" }));
        // "dead": the bug, the handler marks the form as placing and never sends it
        if (how === "valid") void s.fetch("/api/orders", { method: "POST", body: "{}" }).then(() => form.set((v) => ({ ...v, placing: false })));
      });
      await s.clock.advance(2000);
    };
    for (let i = 0; i < 10; i++) await submit("valid");
    await submit("invalid");
    expect(reports).toEqual([]);
    // the same branch without its request is the gap (10 more valid submits bring the share back over 0.95)
    for (let i = 0; i < 10; i++) await submit("valid");
    await submit("dead");
    expect(exps(reports).map((e) => [e.kind, e.signature, e.seen, e.of])).toEqual([["request", "POST /api/orders", 20, 21]]);
  });

  it("a slow answer: the flow stays open for its usual tail after it, so a navigation that follows it is not missing", async () => {
    const reports: Report[] = [];
    const { s, go } = navApp(reports);
    let latency = 100;
    s.server.on("POST", "/api/orders", () => ({ body: { id: 1 }, latency }));
    const order = async () => {
      s.rt.user({ kind: "click", target: 'button "Place order"' }, () => {
        void (async () => {
          await s.fetch("/api/orders", { method: "POST", body: "{}" });
          // a confirmation toast, then the page moves on
          s.clock.setTimeout(() => go("/confirmation"), 800);
        })();
      });
      await s.clock.advance(5000);
      go("/checkout");
      await s.clock.advance(100);
    };
    for (let i = 0; i < 8; i++) await order();
    expect(s.rt.learned().flows[0].nav).toEqual([{ to: "/confirmation", n: 8, share: 1, expected: true }]);
    latency = 2000;
    await order();
    expect(exps(reports).filter((e) => e.kind === "navigation")).toEqual([]);
    expect(s.rt.learned().flows[0].nav[0]).toMatchObject({ n: 9 });
  });

  it("an action whose page was left for another one, a request started from elsewhere, and a write of an unchanged value are not gaps", async () => {
    const reports: Report[] = [];
    const { s, go } = navApp(reports);
    s.server.on("POST", "/api/orders", { body: { id: 1 }, latency: 50 });
    const order = async (navigate: boolean, leave = false) => {
      s.rt.user({ kind: "click", target: 'button "Place order"' }, () => {
        void (async () => {
          await s.fetch("/api/orders", { method: "POST", body: "{}" });
          if (navigate) go("/confirmation");
        })();
      });
      if (leave) {
        await s.clock.advance(300);
        s.rt.user({ kind: "click", target: 'link "Home"' }, () => go("/"));
      }
      await s.clock.advance(2000);
      go("/checkout");
      await s.clock.advance(100);
    };
    for (let i = 0; i < 8; i++) await order(true);
    await order(false, true); // the user went Home before the confirmation could show
    expect(exps(reports)).toEqual([]);
    expect(s.rt.learned().flows.find((f) => f.action === 'click button "Place order"')).toMatchObject({ n: 8 });

    // a request whose cause was not traced back to the click (started outside its task) still counts as sent
    const c = cartApp(s);
    for (let i = 0; i < 9; i++) await c.click();
    s.rt.user({ kind: "click", target: 'button "Add to cart"' });
    await s.clock.flush();
    void s.fetch("/api/cart", { method: "POST", body: "{}" });
    await s.clock.advance(2000);
    expect(exps(reports)).toEqual([]);

    // a response handler that wrote the value the store already had handled its response (saving without changes)
    let name = 0;
    s.server.on("PUT", "/api/profile", () => ({ body: { name: `v${name}` }, latency: 50 }));
    const profile = s.rt.atom("profile", { name: "" });
    const save = async (change: boolean) => {
      if (change) name++;
      s.rt.user({ kind: "click", target: 'button "Save"' }, () => {
        void (async () => {
          const res = await s.fetch("/api/profile", { method: "PUT", body: "{}" });
          profile.set((await res.json()) as { name: string });
        })();
      });
      await s.clock.advance(2000);
    };
    for (let i = 0; i < 9; i++) await save(true);
    expect(s.rt.learned().flows.find((f) => f.action === 'click button "Save"')!.writes).toEqual([{ signature: "PUT /api/profile", field: "profile.name", n: 9, of: 9, share: 1, expected: true }]);
    await save(false);
    expect(exps(reports)).toEqual([]);
  });

  it("an action repeated while its flow is open (a stepper clicked quickly): an answer the app dropped as superseded is not a gap", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    s.server.on("PUT", "/api/cart/qty", ({ body }) => ({ body: JSON.parse(body ?? "{}") as unknown, latency: 300 }));
    const cart = s.rt.atom("cart", { qty: 0 });
    let want = 0;
    const plus = () =>
      s.rt.user({ kind: "click", target: 'button "+"' }, () => {
        const q = ++want;
        void (async () => {
          const res = await s.fetch("/api/cart/qty", { method: "PUT", body: JSON.stringify({ qty: q }) });
          const d = (await res.json()) as { qty: number };
          if (d.qty === want) cart.set({ qty: d.qty }); // only the latest answer is applied
        })();
      });
    for (let i = 0; i < 10; i++) {
      plus();
      await s.clock.advance(2000);
    }
    expect(s.rt.learned().flows[0].writes).toEqual([{ signature: "PUT /api/cart/qty", field: "cart.qty", n: 10, of: 10, share: 1, expected: true }]);
    plus();
    await s.clock.advance(100);
    plus(); // the first answer is now superseded: the app drops it
    await s.clock.advance(4000);
    expect(exps(reports)).toEqual([]);
    expect(cart.get().qty).toBe(12);
    // the superseded instance is learned, its writes are not (the write stays expected)
    expect(s.rt.learned().flows[0]).toMatchObject({ n: 11 });
    expect(s.rt.learned().flows[0].writes[0]).toMatchObject({ n: 10, of: 10, expected: true });
  });

  it("learn.expectations: false learns and reports nothing", async () => {
    const reports: Report[] = [];
    const s = app(reports, { learn: { expectations: false } });
    const { click } = cartApp(s);
    for (let i = 0; i < 9; i++) await click();
    await click({ send: false });
    expect(reports).toEqual([]);
    expect(s.rt.learned().flows).toEqual([]);
  });
});

/** One page load on an origin whose storage is `ls` (and, when given, a tab's sessionStorage). */
async function pageLoad<T>(ls: MemStorage, run: (s: Setup, reports: Report[]) => Promise<T>, opts: Opts & { ss?: MemStorage } = {}): Promise<{ e: Expectation[]; out: T; learned: ReturnType<Setup["rt"]["learned"]> }> {
  const { ss, extraGlobal, ...rest } = opts;
  const reports: Report[] = [];
  const s = setup({ extraGlobal: { localStorage: ls, ...(ss ? { sessionStorage: ss } : {}), ...(extraGlobal ?? {}) }, report: (r) => reports.push(r), ...rest });
  const out = await run(s, reports);
  const learned = s.rt.learned();
  s.rt.destroy(); // writes the pending save
  return { e: exps(reports), out, learned };
}

/** `sends` clicks that send, then (when `miss`) one that sends nothing. */
const clicks = (sends: number, miss = false) => async (s: Setup) => {
  const c = cartApp(s);
  for (let i = 0; i < sends; i++) await c.click();
  if (miss) await c.click({ send: false });
};

describe("flow expectations: persistence (EXPECTATIONS.md §4)", () => {
  it("by default only the flows are stored (format, runtime version, no page text); transition profiles, which feed the model, stay in memory", async () => {
    const ls = new MemStorage();
    const a = await pageLoad(ls, clicks(8, true));
    expect(a.e).toEqual([]); // a first session never reports with persistence (3 sessions needed)
    const raw = ls.getItem("genclass:learn")!;
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("Add to cart");
    expect(raw).not.toContain("user click");
    const stored = JSON.parse(raw) as { format: number; lib: string; version?: string; sessions: number; flows: { h: string; n: number; rep: number; label?: string; stored?: boolean; children: Record<string, unknown> }[]; profiles: unknown[] };
    expect(stored).toMatchObject({ format: 2, lib: RUNTIME_VERSION, sessions: 1, profiles: [] });
    expect(stored.version).toBeUndefined();
    expect(stored.flows).toHaveLength(1);
    expect(stored.flows[0]).toMatchObject({ n: 9, rep: 8 });
    expect(stored.flows[0].label).toBeUndefined();
    expect(stored.flows[0].stored).toBeUndefined();
    expect(stored.flows[0].h).toMatch(/^[0-9a-f]{8}$/);
    expect(Object.keys(stored.flows[0].children)).toEqual(["POST /api/cart"]);

    const s2 = setup({ extraGlobal: { localStorage: ls } });
    expect(s2.rt.learned().session).toBe(2);
    expect(s2.rt.learned().flows[0]).toMatchObject({ n: 9, sessions: 1, action: expect.stringMatching(/^click button #[0-9a-f]{8}$/) });
    expect(s2.rt.profiles.bySig.size).toBe(0); // nothing the model reads came from storage
    s2.rt.learn.clear();
    expect(ls.getItem("genclass:learn")).toBeNull();
    expect(s2.rt.learned().flows).toEqual([]);
    s2.rt.destroy();
  });

  it("with an explicit learn.persist, transition profiles are stored too (user actions under a hash) and found again; the default ignores them", async () => {
    const ls = new MemStorage();
    await pageLoad(ls, clicks(3), { learn: { persist: true } });
    const stored = JSON.parse(ls.getItem("genclass:learn")!) as { profiles: { sig: string }[] };
    expect(stored.profiles.some((p) => /^user#[0-9a-f]{8}$/.test(p.sig))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("Add to cart");
    const b = await pageLoad(
      ls,
      async (s) => {
        await clicks(3)(s);
        // the user-action profile loaded under its hash is the same profile (renamed in memory, hashed again on save)
        return { has: s.rt.profiles.bySig.has('user click button "Add to cart"'), n: s.rt.profiles.get('user click button "Add to cart"')?.n ?? 0 };
      },
      { learn: { persist: true } },
    );
    expect(b.out.has).toBe(true);
    expect(b.out.n).toBeGreaterThanOrEqual(4);
    const c = await pageLoad(ls, async (s) => {
      const n = s.rt.profiles.bySig.size;
      await clicks(1)(s);
      return n;
    });
    expect(c.out).toBe(0);
    expect(c.learned.flows[0]).toMatchObject({ n: 7 }); // the flows are loaded
    expect((JSON.parse(ls.getItem("genclass:learn")!) as { profiles: unknown[] }).profiles).toEqual([]);
  });

  it("with persistence, nothing is expected before 20 observations (8 while all are from this page load) and 3 sessions", async () => {
    // one click per visit: 19 stored observations are not enough, 21 are
    const ls = new MemStorage();
    const visit = (send: boolean) => pageLoad(ls, clicks(send ? 1 : 0, !send));
    for (let i = 0; i < 19; i++) expect((await visit(true)).e).toEqual([]);
    expect((await visit(false)).e).toEqual([]);
    expect((await visit(true)).e).toEqual([]);
    expect((await visit(false)).e.map((e) => [e.kind, e.seen, e.of, e.sessions])).toEqual([["request", 20, 21, 21]]);

    // 26 observations in 2 sessions are not enough; the third session reports
    const ls2 = new MemStorage();
    expect((await pageLoad(ls2, clicks(15))).e).toEqual([]);
    const two = await pageLoad(ls2, clicks(10, true));
    expect(two.e).toEqual([]);
    expect(two.learned.flows[0]).toMatchObject({ n: 26, sessions: 2 });
    expect((await pageLoad(ls2, clicks(1, true))).e.map((e) => [e.kind, e.seen, e.of, e.sessions])).toEqual([["request", 26, 27, 3]]);
  });

  it("a reload in the same tab continues its session (sessionStorage keeps the ordinal); another tab is another session", async () => {
    const ls = new MemStorage();
    const tab = new MemStorage();
    const a = await pageLoad(ls, clicks(1), { ss: tab });
    expect(a.learned).toMatchObject({ session: 1 });
    const b = await pageLoad(ls, clicks(1), { ss: tab });
    expect(b.learned.session).toBe(1);
    expect(b.learned.flows[0]).toMatchObject({ n: 2, sessions: 1 });
    const c = await pageLoad(ls, clicks(1), { ss: new MemStorage() });
    expect(c.learned.session).toBe(2);
    expect(c.learned.flows[0]).toMatchObject({ n: 3, sessions: 2 });
    const d = await pageLoad(ls, async () => undefined, { ss: tab });
    expect(d.learned.session).toBe(1);
    expect((JSON.parse(ls.getItem("genclass:learn")!) as { sessions: number }).sessions).toBe(2);
  });

  it("with persistence, a flow's first sessions report nothing (a missing write here), nor do this origin's first sessions (a late response)", async () => {
    const ls = new MemStorage();
    const lateResponse = async (s: Setup) => {
      let slow = false;
      s.server.on("GET", "/api/items", () => ({ body: [], latency: slow ? 5000 : 50 }));
      for (let i = 0; i < 10; i++) {
        const p = s.fetch("/api/items");
        await s.clock.advance(500);
        await p;
      }
      slow = true;
      const p = s.fetch("/api/items");
      await s.clock.advance(6000);
      await p;
    };
    const first = await pageLoad(ls, async (s) => {
      const c = cartApp(s);
      for (let i = 0; i < 9; i++) await c.click();
      await c.click({ write: false });
      await lateResponse(s);
    });
    expect(first.e).toEqual([]);
    const second = await pageLoad(ls, lateResponse);
    expect(second.learned.session).toBe(2);
    expect(second.e).toEqual([]);
    const third = await pageLoad(ls, lateResponse);
    expect(third.e.map((e) => e.kind)).toEqual(["response"]);
  });

  it("after the app changes, a returning visitor gets one report, not one per visit; counts are halved at 64 observations", async () => {
    const ls = new MemStorage();
    let path = "/api/cart";
    const session = (n: number) =>
      pageLoad(ls, async (s) => {
        s.server.on("POST", "/api/cart", ({ n: k }) => ({ body: { items: [k] }, latency: 50 }));
        s.server.on("POST", "/api/v2/cart", ({ n: k }) => ({ body: { items: [k] }, latency: 50 }));
        const cart = s.rt.atom("cart", { items: [] as number[] });
        for (let i = 0; i < n; i++) {
          s.rt.user({ kind: "click", target: 'button "Add to cart"' }, () => {
            void s.fetch(path, { method: "POST", body: "{}" }).then(async (res) => cart.set((await res.json()) as { items: number[] }));
          });
          await s.clock.advance(2000);
        }
      });
    for (let k = 0; k < 3; k++) expect((await session(14)).e).toEqual([]);
    path = "/api/v2/cart"; // a release renames the endpoint
    const after = [await session(10), await session(10), await session(10)];
    expect(after.flatMap((x) => x.e).map((e) => [e.kind, e.signature, e.seen, e.of])).toEqual([["request", "POST /api/cart", 42, 42]]);
    const flow = after[2].learned.flows[0];
    expect(flow.n).toBe(40); // 72 observations: 64 halved to 32, then 8 more
    expect(flow.children.find((c) => c.signature === "POST /api/cart")).toMatchObject({ n: 21, missed: true, expected: false });
    expect(flow.children.find((c) => c.signature === "POST /api/v2/cart")).toMatchObject({ n: 19, expected: false });
  });

  it("a repeat within a page load is held to what repeats did before: a query an app cache answers the second time is not a gap", async () => {
    const ls = new MemStorage();
    const visit = (clicked: boolean[]) =>
      pageLoad(ls, async (s) => {
        s.server.on("POST", "/graphql", { body: { data: { orders: [] } }, latency: 50 });
        for (const send of clicked) {
          s.rt.user({ kind: "click", target: 'tab "Orders"' }, () => {
            if (send) void s.fetch("/graphql", { method: "POST", body: '{"query":"{ orders { id } }"}' });
          });
          await s.clock.advance(2000);
        }
      });
    for (let i = 0; i < 20; i++) await visit([true]);
    const last = await visit([true, false]);
    expect(last.e).toEqual([]);
    expect(last.learned.flows[0]).toMatchObject({ n: 22, repeats: 1, sessions: 21 });
    expect(last.learned.flows[0].children[0]).toMatchObject({ signature: "POST /graphql", onRepeat: 0, expected: true, expectedOnRepeat: false });
  });

  it("storage that throws keeps learning in memory with this page load's thresholds; a DOM test environment stores nothing unless asked", async () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    const reports: Report[] = [];
    const s = setup({ extraGlobal: { localStorage: broken }, report: (r) => reports.push(r) });
    const { click } = cartApp(s);
    for (let i = 0; i < 9; i++) await click();
    await click({ send: false });
    expect(exps(reports).map((e) => [e.kind, e.seen, e.of, e.sessions])).toEqual([["request", 9, 9, 1]]);
    expect(s.rt.learned().session).toBe(1);

    for (const ua of ["Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/24.1.0", "Mozilla/5.0 (X11; Linux x64) AppleWebKit/537.36 (KHTML, like Gecko) HappyDOM/15.7.4"]) {
      const ls = new MemStorage();
      await pageLoad(ls, clicks(1), { extraGlobal: { navigator: { userAgent: ua } } });
      expect(ls.getItem("genclass:learn")).toBeNull();
      await pageLoad(ls, clicks(1), { extraGlobal: { navigator: { userAgent: ua } }, learn: { persist: "local" } });
      expect(ls.getItem("genclass:learn")).toBeTruthy();
    }
  });

  it("destroy() writes a pending save; a cap below the header removes the stored value; learn.clear() also drops the pending save and is not recorded", async () => {
    const OBS = { fetch: true, storage: true, xhr: false, user: false, errors: false, nav: false, perf: false, websocket: false, timers: false };
    const ls = new MemStorage();
    const s = setup({ extraGlobal: { Storage: MemStorage, localStorage: ls }, observe: OBS });
    await cartApp(s).click(); // the save is pending (5 s debounce)
    expect(ls.getItem("genclass:learn")).toBeNull();
    s.rt.destroy();
    expect((JSON.parse(ls.getItem("genclass:learn")!) as { flows: unknown[] }).flows).toHaveLength(1);

    const tiny = await pageLoad(ls, async (u) => {
      const n = u.rt.learned().flows.length;
      await cartApp(u).click();
      return n;
    }, { learn: { maxBytes: 10 } });
    expect(tiny.out).toBe(1); // it was loaded
    expect(ls.getItem("genclass:learn")).toBeNull(); // and nothing stale is left behind

    const t = setup({ extraGlobal: { Storage: MemStorage, localStorage: ls }, observe: OBS });
    await cartApp(t).click();
    t.rt.learn.clear();
    await t.clock.advance(6000);
    expect(ls.getItem("genclass:learn")).toBeNull();
    expect(t.rt.history().filter((e) => e.kind === "storage")).toEqual([]);
    t.rt.destroy();
    expect(ls.getItem("genclass:learn")).toBeNull();
  });

  it("learn.persist: false stores nothing; a version change discards the stored state; the storage observer never records the runtime's own writes", async () => {
    const ls = new MemStorage();
    const s = setup({ extraGlobal: { localStorage: ls }, learn: { persist: false } });
    const c = cartApp(s);
    for (let i = 0; i < 3; i++) await c.click();
    await s.clock.advance(6000);
    expect(ls.getItem("genclass:learn")).toBeNull();

    const OBS = { fetch: true, storage: true, xhr: false, user: false, errors: false, nav: false, perf: false, websocket: false, timers: false };
    const t = setup({ extraGlobal: { Storage: MemStorage, localStorage: ls }, observe: OBS, learn: { version: "1" } });
    const ct = cartApp(t);
    await ct.click();
    await t.clock.advance(6000);
    expect(JSON.parse(ls.getItem("genclass:learn")!).version).toBe("1");
    expect(t.rt.history().filter((e) => e.kind === "storage")).toEqual([]);
    ls.setItem("app", "1"); // the app's own writes are still observed
    expect(t.rt.history().filter((e) => e.kind === "storage").map((e) => e.name)).toEqual(["localStorage.setItem"]);
    const u = setup({ extraGlobal: { Storage: MemStorage, localStorage: ls }, observe: OBS, learn: { version: "2" } });
    expect(u.rt.learned().flows).toEqual([]);
    expect(ls.getItem("genclass:learn")).toBeNull();
    expect(u.rt.history().filter((e) => e.kind === "storage")).toEqual([]);
    u.rt.destroy();
    t.rt.destroy();

    // another format or runtime version is discarded too (never migrated), and so is the 0.2.2 value
    for (const v of [{ format: 1, lib: RUNTIME_VERSION, sessions: 3, profiles: [], flows: [] }, { format: 2, lib: "0.0.1", sessions: 3, profiles: [], flows: [] }, { profiles: [{ sig: "GET /x", n: 30 }] }, [{ sig: "GET /x", n: 30 }]]) {
      const m = new MemStorage();
      m.setItem("genclass:learn", JSON.stringify(v));
      const w = setup({ extraGlobal: { localStorage: m }, learn: { persist: true } });
      expect(w.rt.learned().session).toBe(1);
      expect(w.rt.profiles.bySig.size).toBe(0);
      expect(m.getItem("genclass:learn")).toBeNull();
      w.rt.destroy();
    }
  });

  it("malformed stored state is dropped or zeroed field by field (stored state is never trusted as is)", async () => {
    const ls = new MemStorage();
    const profiles = [null, { sig: 1 }, { sig: "GET /api/x", n: -1 }, { sig: "POST /api/cart", n: 3, sets: { "": "many", "cart.items": 3 }, kinds: { "cart.items": { array: 3, bad: null } }, status: 5 }];
    const flows = [{ h: "zz", n: 2, route: "/search", children: { "POST /api/cart": { n: "2" }, "POST /api/ok": { n: 2, delay: [1, "x", 2], own: { "": 2, b: "y" } } }, nav: { "/a": 1, "/b": "c" } }, 7, "s"];
    ls.setItem("genclass:learn", JSON.stringify({ format: 2, lib: RUNTIME_VERSION, sessions: "x", profiles, flows }));
    const s = setup({ extraGlobal: { localStorage: ls }, learn: { persist: true } });
    expect(s.rt.learned().session).toBe(1);
    expect([...s.rt.profiles.bySig.keys()]).toEqual(["POST /api/cart"]);
    expect(s.rt.profiles.get("POST /api/cart")).toEqual({ sig: "POST /api/cart", n: 3, sets: { "cart.items": 3 }, kinds: { "cart.items": { array: 3 } }, wrote: {}, status: {}, writes: {}, dur: {} });
    const f = s.rt.learned().flows;
    expect(f).toHaveLength(1);
    expect(f[0].children.map((c) => [c.signature, c.n, c.delayMs])).toEqual([["POST /api/ok", 2, { p50: 1, p95: 2 }]]);
    expect(f[0].nav.map((x) => x.to)).toEqual(["/a"]);
    // and the runtime learns on top of it
    const c = cartApp(s);
    for (let i = 0; i < 3; i++) await c.click();
    expect(s.rt.learned().flows.find((x) => x.action === 'click button "Add to cart"')).toMatchObject({ n: 3 });
    expect(s.rt.profiles.get("POST /api/cart")!.n).toBe(6);
  });

  it("learn.maxBytes caps the stored copy (most-used flows first); what is in memory is never dropped for it", async () => {
    const run = async (maxBytes?: number) => {
      const ls = new MemStorage();
      const s = setup({ extraGlobal: { localStorage: ls }, ...(maxBytes ? { learn: { maxBytes } } : {}) });
      s.server.on("DELETE", "/api/cart", { body: {}, latency: 50 });
      const c = cartApp(s);
      await c.click();
      s.rt.user({ kind: "click", target: 'button "Empty cart"' }, () => void s.fetch("/api/cart", { method: "DELETE" }));
      await s.clock.advance(8000);
      return { s, raw: ls.getItem("genclass:learn")! };
    };
    const full = await run();
    const all = JSON.parse(full.raw) as { flows: { used: number }[] };
    expect(all.flows).toHaveLength(2);
    const top = [...all.flows].sort((a, b) => b.used - a.used)[0];
    const head = `{"format":2,"lib":${JSON.stringify(RUNTIME_VERSION)},"sessions":1,`;
    const cap = head.length + '"profiles":[],"flows":[]}'.length + JSON.stringify(top).length;
    const capped = await run(cap);
    expect(capped.raw.length).toBe(cap);
    expect(JSON.parse(capped.raw)).toEqual({ format: 2, lib: RUNTIME_VERSION, sessions: 1, profiles: [], flows: [top] });
    expect(capped.s.rt.learned().flows).toHaveLength(2);
    expect(capped.s.rt.profiles.bySig.size).toBe(full.s.rt.profiles.bySig.size);
  });
});

describe("flow expectations: developer-facing output (EXPECTATIONS.md §5)", () => {
  it("sinks receive an expectation record without page text; the console prints one collapsed group and folds repeats", async () => {
    const recs: SinkRecord[] = [];
    const group = vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const end = vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      // minShare 0.8: after a miss, the step is expected again once it was seen again (and the reporter folds the line)
      const s = setup({ learn: { persist: false, minShare: 0.8 }, report: "console", sinks: [(r) => void recs.push(r)] });
      const { click } = cartApp(s);
      for (let i = 0; i < 9; i++) await click();
      await click({ send: false });
      await click({ send: false }); // not expected until seen again: no line
      expect(s.rt.learned().deviations).toHaveLength(1);
      await click();
      await click({ send: false });
      expect(s.rt.learned().deviations).toHaveLength(2);
      expect(group).toHaveBeenCalledTimes(1);
      expect(String(group.mock.calls[0][0])).toMatch(/^\[GenClass\] Expected a request on \/search: clicking button "Add to cart" usually sends POST \/api\/cart/);
      const logged = log.mock.calls.map((x) => String(x[0])).join("\n");
      expect(logged).toContain('Learned on /search: clicking button "Add to cart" sends POST /api/cart within 0.00 s (9 of 9, 1 session).');
      expect(logged).toContain("GenClass.runtime.learned()");
      expect(logged).toContain("learn: { expectations: false }");
      expect(end).toHaveBeenCalledTimes(1);
      await s.clock.advance(61_000);
      expect(info.mock.calls.map((x) => String(x[0]))).toContainEqual(expect.stringMatching(/Expected a request on \/search: .*\(×1 more in the last minute\)$/));
      await s.clock.advance(10);
      const rec = recs.find((r) => r.kind === "expectation")!;
      expect(rec).toBeTruthy();
      expect(rec.expectation).toEqual({ kind: "request", route: "/search", signature: "POST /api/cart", seen: 9, of: 9, sessions: 1, waitedMs: 1000 });
      expect(JSON.stringify(rec)).not.toContain("Add to cart");
    } finally {
      group.mockRestore();
      log.mockRestore();
      end.mockRestore();
      info.mockRestore();
    }
  });
});

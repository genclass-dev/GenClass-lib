// Flow expectations (docs/runtime/EXPECTATIONS.md; CONTRACT §0.5 precision, §4 learned state, §8 reporting): a
// deterministic, reporting-only layer that learns what each user action on a route usually does and reports the
// step that did not happen. No model call, no action, no model-visible text: the decider never sees a trigger here.
import { describe, expect, it, vi } from "vitest";
import type { Expectation, Report, SinkRecord } from "../src/types.js";
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
    expect(f).toMatchObject({ route: "/search", action: 'click button "Add to cart"', n: 8, sessions: 1 });
    expect(f.children).toEqual([{ signature: "POST /api/cart", n: 8, share: 1, expected: true, delayMs: { p50: 0, p95: 0 } }]);
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
    for (let i = 0; i < 8; i++) await click();
    await click({ send: false, wait: 600 });
    const e = exps(reports);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: "request", route: "/search", action: 'clicking button "Add to cart"', signature: "POST /api/cart", seen: 8, of: 8, sessions: 1, waitedMs: 500, usualMs: 0 });
    expect(e[0].message).toBe('[GenClass] Expected a request on /search: clicking button "Add to cart" usually sends POST /api/cart (8 of 8 times across 1 session, within 0.00 s); this time nothing was sent in 0.50 s.');
    expect(reports[0].mode).toBe("guard");
    expect(events).toEqual(e);
    expect(s.rt.learned().deviations).toEqual(e);
    // the flow closes without a second report, and the miss is learned (9 of 9 observations, 8 with the request)
    await s.clock.advance(3000);
    expect(exps(reports)).toHaveLength(1);
    expect(s.rt.learned().flows[0]).toMatchObject({ n: 9 });
    expect(s.rt.learned().flows[0].children[0]).toMatchObject({ n: 8, expected: false });
    // there is no trigger kind for an expectation: whatever the model was asked about, it was never this
    expect(s.decider.calls.every((c) => c.trigger === "request" || c.trigger === "delivery" || c.trigger === "mutation")).toBe(true);
  });

  it("learn.minSupport sets the support; a step seen in fewer than minShare of the observations is not expected", async () => {
    const reports: Report[] = [];
    const s = app(reports, { learn: { minSupport: 3 } });
    const { click } = cartApp(s);
    for (let i = 0; i < 3; i++) await click();
    await click({ send: false });
    expect(exps(reports).map((e) => e.kind)).toEqual(["request"]);

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

  it("a response whose chain usually writes a field wrote nothing: reported when the flow closes", async () => {
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
    expect(e[0]).toMatchObject({ signature: "GET /api/orders", after: "POST /api/orders", seen: 8, of: 8, waitedMs: 500 });
    expect(e[0].message).toBe('[GenClass] Expected a follow-up on /search: after POST /api/orders completes, clicking button "Place order" usually sends GET /api/orders (8 of 8 times, within 0.00 s); this time nothing followed in 0.50 s.');
    // the POST itself failing is not a missing follow-up (nor a missing request)
    s.server.on("POST", "/api/orders", { status: 500, latency: 50 });
    await order(true);
    expect(exps(reports)).toHaveLength(1);
  });

  it("a navigation that usually follows the action did not happen", async () => {
    const reports: Report[] = [];
    const loc = { href: "http://app.test/checkout", pathname: "/checkout", search: "", hash: "" };
    const history = { pushState() {}, replaceState() {} };
    const s = app(reports, { observe: { fetch: true, nav: true, xhr: false, user: false, errors: false, storage: false, perf: false, websocket: false, timers: false }, extraGlobal: { location: loc, history, addEventListener() {}, removeEventListener() {} } });
    s.server.on("POST", "/api/orders", { body: { id: 1 }, latency: 50 });
    const go = (path: string) => {
      loc.pathname = path;
      loc.href = `http://app.test${path}`;
      history.pushState({}, "", path);
    };
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
    for (let i = 0; i < 8; i++) await click();
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
    expect(s.rt.learned().flows[0]).toMatchObject({ n: 9 });
    // a protected request is learned as such and never expected
    s.server.on("POST", "/api/pay", { body: { ok: true }, latency: 50 });
    const pay = async (send: boolean) => {
      s.rt.user({ kind: "click", target: 'button "Pay"' }, () => {
        if (send) void s.fetch("/api/pay", { method: "POST", body: "{}" });
      });
      await s.clock.advance(2000);
    };
    for (let i = 0; i < 8; i++) await pay(true);
    expect(s.rt.learned().flows.find((f) => f.action === 'click button "Pay"')!.children).toEqual([{ signature: "POST /api/pay", n: 8, share: 1, expected: false, protected: true, delayMs: { p50: 0, p95: 0 } }]);
    await pay(false);
    expect(reports).toEqual([]);
  });

  it("learn.expectations: false learns and reports nothing", async () => {
    const reports: Report[] = [];
    const s = app(reports, { learn: { expectations: false } });
    const { click } = cartApp(s);
    for (let i = 0; i < 8; i++) await click();
    await click({ send: false });
    expect(reports).toEqual([]);
    expect(s.rt.learned().flows).toEqual([]);
  });
});

describe("flow expectations: persistence (EXPECTATIONS.md §4)", () => {
  it("learned state persists per origin by default, without page text; the second session can expect; clear() forgets it", async () => {
    const ls = new MemStorage();
    const r1: Report[] = [];
    const s1 = setup({ extraGlobal: { localStorage: ls }, report: (r) => r1.push(r) });
    const c1 = cartApp(s1);
    for (let i = 0; i < 8; i++) await c1.click();
    await c1.click({ send: false });
    expect(r1).toEqual([]); // first session: never (minSessions 2 with persistence)
    await s1.clock.advance(6000);
    const raw = ls.getItem("genclass:learn")!;
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("Add to cart");
    expect(raw).not.toContain("user click");
    const stored = JSON.parse(raw) as { sessions: number; flows: { h: string; n: number; label?: string; children: Record<string, unknown> }[]; profiles: { sig: string }[] };
    expect(stored.sessions).toBe(1);
    expect(stored.flows).toHaveLength(1);
    expect(stored.flows[0]).toMatchObject({ n: 9 });
    expect(stored.flows[0].label).toBeUndefined();
    expect(stored.flows[0].h).toMatch(/^[0-9a-f]{8}$/);
    expect(Object.keys(stored.flows[0].children)).toEqual(["POST /api/cart"]);
    expect(stored.profiles.some((p) => /^user#[0-9a-f]{8}$/.test(p.sig))).toBe(true);
    s1.rt.destroy();

    const r2: Report[] = [];
    const s2 = setup({ extraGlobal: { localStorage: ls }, report: (r) => r2.push(r) });
    expect(s2.rt.learned().session).toBe(2);
    expect(s2.rt.learned().flows[0]).toMatchObject({ n: 9, sessions: 1, action: expect.stringMatching(/^click button #[0-9a-f]{8}$/) });
    const c2 = cartApp(s2);
    for (let i = 0; i < 11; i++) await c2.click(); // 19 of 20 with the request: expected again
    expect(s2.rt.learned().flows[0]).toMatchObject({ n: 20, sessions: 2, action: 'click button "Add to cart"' });
    expect(s2.rt.learned().flows[0].children[0]).toMatchObject({ n: 19, expected: true });
    await c2.click({ send: false, wait: 600 });
    expect(exps(r2).map((e) => [e.kind, e.seen, e.of, e.sessions])).toEqual([["request", 19, 20, 2]]);
    // the user-action profile loaded under its hash is the same profile (renamed in memory, hashed again on save)
    expect(s2.rt.profiles.bySig.has('user click button "Add to cart"')).toBe(true);
    expect(s2.rt.profiles.get('user click button "Add to cart"')!.n).toBeGreaterThanOrEqual(19);
    s2.rt.learn.clear();
    expect(ls.getItem("genclass:learn")).toBeNull();
    expect(s2.rt.learned().flows).toEqual([]);
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
  });

  it("learn.maxBytes caps the stored state (least-used flows and smallest profiles go first)", async () => {
    const ls = new MemStorage();
    const s = setup({ extraGlobal: { localStorage: ls }, learn: { maxBytes: 120 } });
    const c = cartApp(s);
    await c.click();
    await s.clock.advance(6000);
    const raw = ls.getItem("genclass:learn")!;
    expect(raw.length).toBeLessThanOrEqual(120);
    expect(JSON.parse(raw)).toEqual({ sessions: 1, profiles: [], flows: [] });
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
      const s = setup({ learn: { persist: false }, report: "console", sinks: [(r) => void recs.push(r)] });
      const { click } = cartApp(s);
      for (let i = 0; i < 8; i++) await click();
      // two misses while the first flow is still open: both reported, the second folded into the first's line
      await click({ send: false, wait: 100 });
      await click({ send: false });
      expect(s.rt.learned().deviations).toHaveLength(2);
      expect(group).toHaveBeenCalledTimes(1);
      expect(String(group.mock.calls[0][0])).toMatch(/^\[GenClass\] Expected a request on \/search: clicking button "Add to cart" usually sends POST \/api\/cart/);
      const logged = log.mock.calls.map((x) => String(x[0])).join("\n");
      expect(logged).toContain("Learned on /search: clicking button \"Add to cart\" sends POST /api/cart within 0.00 s (8 of 8, 1 session).");
      expect(logged).toContain("GenClass.runtime.learned()");
      expect(logged).toContain("learn: { expectations: false }");
      expect(end).toHaveBeenCalledTimes(1);
      await s.clock.advance(61_000);
      expect(info.mock.calls.map((x) => String(x[0]))).toContainEqual(expect.stringMatching(/Expected a request on \/search: .*\(×1 more in the last minute\)$/));
      await s.clock.advance(10);
      const rec = recs.find((r) => r.kind === "expectation")!;
      expect(rec).toBeTruthy();
      expect(rec.expectation).toEqual({ kind: "request", route: "/search", signature: "POST /api/cart", seen: 8, of: 8, sessions: 1, waitedMs: 500 });
      expect(JSON.stringify(rec)).not.toContain("Add to cart");
    } finally {
      group.mockRestore();
      log.mockRestore();
      end.mockRestore();
      info.mockRestore();
    }
  });
});

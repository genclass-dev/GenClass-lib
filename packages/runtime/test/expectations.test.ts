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

  it("a GET an app cache may answer is never expected to start; a 4xx answer is not a missing write or follow-up", async () => {
    const reports: Report[] = [];
    const s = app(reports);
    s.server.on("GET", "/api/orders", { body: [], latency: 50 });
    const tab = async (send: boolean) => {
      s.rt.user({ kind: "click", target: 'tab "Orders"' }, () => {
        if (send) void s.fetch("/api/orders");
      });
      await s.clock.advance(2000);
    };
    for (let i = 0; i < 12; i++) await tab(true);
    expect(s.rt.learned().flows[0].children[0]).toMatchObject({ signature: "GET /api/orders", share: 1, expected: false, expectedOnRepeat: false });
    await tab(false); // answered from the app's cache
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

    // a response handler that wrote the value the store already had handled its response
    let items = 0;
    s.server.on("GET", "/api/cart", () => ({ body: { items: [items] }, latency: 50 }));
    const refresh = async (change: boolean) => {
      if (change) items++;
      s.rt.user({ kind: "click", target: 'button "Refresh"' }, () => {
        void (async () => {
          const res = await s.fetch("/api/cart");
          c.cart.set({ items: ((await res.json()) as { items: number[] }).items });
        })();
      });
      await s.clock.advance(2000);
    };
    for (let i = 0; i < 9; i++) await refresh(true);
    expect(s.rt.learned().flows.find((f) => f.action === 'click button "Refresh"')!.writes).toEqual([{ signature: "GET /api/cart", field: "cart.items", n: 9, of: 9, share: 1, expected: true }]);
    await refresh(false);
    expect(exps(reports)).toEqual([]);
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
    const stored = JSON.parse(raw) as { sessions: number; flows: { h: string; n: number; rep: number; label?: string; children: Record<string, unknown> }[]; profiles: { sig: string }[] };
    expect(stored.sessions).toBe(1);
    expect(stored.flows).toHaveLength(1);
    expect(stored.flows[0]).toMatchObject({ n: 9, rep: 8 });
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
    // 13 more: 21 of 22 with the request overall, 19 of 20 among repeats
    for (let i = 0; i < 13; i++) await c2.click();
    expect(s2.rt.learned().flows[0]).toMatchObject({ n: 22, repeats: 20, sessions: 2, action: 'click button "Add to cart"' });
    expect(s2.rt.learned().flows[0].children[0]).toMatchObject({ n: 21, onRepeat: 19, expected: true, expectedOnRepeat: true });
    await c2.click({ send: false, wait: 1100 });
    expect(exps(r2).map((e) => [e.kind, e.seen, e.of, e.sessions])).toEqual([["request", 21, 22, 2]]);
    // the user-action profile loaded under its hash is the same profile (renamed in memory, hashed again on save)
    expect(s2.rt.profiles.bySig.has('user click button "Add to cart"')).toBe(true);
    expect(s2.rt.profiles.get('user click button "Add to cart"')!.n).toBeGreaterThanOrEqual(19);
    s2.rt.learn.clear();
    expect(ls.getItem("genclass:learn")).toBeNull();
    expect(s2.rt.learned().flows).toEqual([]);
  });

  it("with persistence, a flow's first session reports nothing (a missing write here), nor does this origin's first session (a late response)", async () => {
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
    const r1: Report[] = [];
    const s1 = setup({ extraGlobal: { localStorage: ls }, report: (r) => r1.push(r) });
    const c1 = cartApp(s1);
    for (let i = 0; i < 9; i++) await c1.click();
    await c1.click({ write: false });
    await lateResponse(s1);
    expect(exps(r1)).toEqual([]);
    s1.rt.destroy();

    const r2: Report[] = [];
    const s2 = setup({ extraGlobal: { localStorage: ls }, report: (r) => r2.push(r) });
    expect(s2.rt.learned().session).toBe(2);
    await lateResponse(s2);
    expect(exps(r2).map((e) => e.kind)).toEqual(["response"]);
  });

  it("a repeat within a page load is held to what repeats did before: a query an app cache answers the second time is not a gap", async () => {
    const ls = new MemStorage();
    const visit = async (clicks: boolean[]) => {
      const r: Report[] = [];
      const s = setup({ extraGlobal: { localStorage: ls }, report: (x) => r.push(x) });
      s.server.on("POST", "/graphql", { body: { data: { orders: [] } }, latency: 50 });
      for (const send of clicks) {
        s.rt.user({ kind: "click", target: 'tab "Orders"' }, () => {
          if (send) void s.fetch("/graphql", { method: "POST", body: '{"query":"{ orders { id } }"}' });
        });
        await s.clock.advance(2000);
      }
      await s.clock.advance(6000);
      const learned = s.rt.learned();
      s.rt.destroy();
      return { r, learned };
    };
    for (let i = 0; i < 8; i++) await visit([true]);
    const last = await visit([true, false]);
    expect(exps(last.r)).toEqual([]);
    expect(last.learned.flows[0]).toMatchObject({ n: 10, repeats: 1, sessions: 9 });
    expect(last.learned.flows[0].children[0]).toMatchObject({ signature: "POST /graphql", onRepeat: 0, expectedOnRepeat: false });
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
    const cap = '{"sessions":1,'.length + '"profiles":[],"flows":[]}'.length + JSON.stringify(top).length;
    const capped = await run(cap);
    expect(capped.raw.length).toBe(cap);
    expect(JSON.parse(capped.raw)).toEqual({ sessions: 1, profiles: [], flows: [top] });
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
      // minShare 0.8: one miss does not stop the next one from being expected (so the reporter can fold it)
      const s = setup({ learn: { persist: false, minShare: 0.8 }, report: "console", sinks: [(r) => void recs.push(r)] });
      const { click } = cartApp(s);
      for (let i = 0; i < 9; i++) await click();
      await click({ send: false });
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

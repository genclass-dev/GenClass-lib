// The seeded chaos (src/chaos.ts): the same seed gives the same delays, another seed gives others; the filter
// decides what is touched (never anything outside it, never the runtime's own files); with reorder off nothing
// overtakes. The scheduler is driven with hand-cranked timers, so nothing here waits on the clock.

import { describe, expect, it } from "vitest";
import { ChaosScheduler, DEFAULT_DELAY_MS, FIFO_GAP_MS, MAX_DELAY_MS, RUNTIME_PATH, delayFor, describeMatch, hash32, isCandidate, isRuntimeUrl, mulberry32, resolveChaos, type ChaosRequest } from "../src/chaos.js";

function manualTimers() {
  const q: { at: number; fn: () => void; id: number }[] = [];
  let now = 0;
  let n = 0;
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++n;
        q.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (id: unknown) => {
        const i = q.findIndex((x) => x.id === id);
        if (i >= 0) q.splice(i, 1);
      },
    },
    /** Moves time forward 1 ms at a time, firing what is due and letting promise chains queue new timers. */
    async advance(ms: number): Promise<void> {
      for (let i = 0; i < ms; i++) {
        now += 1;
        for (const x of [...q].filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) {
          q.splice(q.indexOf(x), 1);
          x.fn();
        }
        for (let k = 0; k < 5; k++) await Promise.resolve();
      }
      await new Promise((r) => setTimeout(r, 0));
    },
    now: () => now,
    pending: () => q.length,
  };
}

const req = (p: Partial<ChaosRequest> = {}): ChaosRequest => ({ url: "http://app.test/api/items", method: "GET", resourceType: "fetch", sameOrigin: true, ...p });

describe("chaos: seeded values", () => {
  it("hash32 and mulberry32 are deterministic and spread", () => {
    expect(hash32("GET /api/search#1")).toBe(hash32("GET /api/search#1"));
    expect(hash32("GET /api/search#1")).not.toBe(hash32("GET /api/search#2"));
    const r = mulberry32(42);
    const a = [r(), r(), r()];
    const b = mulberry32(42);
    expect([b(), b(), b()]).toEqual(a);
    for (const x of a) expect(x >= 0 && x < 1).toBe(true);
  });

  it("delayFor: within [min, max], the same for the same seed and key, different across seeds for most keys", () => {
    const keys = Array.from({ length: 50 }, (_, i) => `GET /api/x#${i + 1}`);
    let differ = 0;
    for (const k of keys) {
      const d = delayFor(7, k, [100, 600]);
      expect(d).toBe(delayFor(7, k, [100, 600]));
      expect(d >= 100 && d <= 600).toBe(true);
      if (d !== delayFor(8, k, [100, 600])) differ++;
    }
    expect(differ).toBeGreaterThan(40);
    expect(delayFor(1, "k", [250, 250])).toBe(250);
    expect(delayFor(1, "k", [0, 0])).toBe(0);
  });

  it("resolveChaos: defaults, bounds, the repeat offset, and bad values", () => {
    expect(resolveChaos(true)).toEqual({ seed: 1, delayMs: [...DEFAULT_DELAY_MS], reorder: true, match: undefined });
    expect(resolveChaos({})).toEqual(resolveChaos(true));
    expect(resolveChaos({ seed: 5 }, 2).seed).toBe(7);
    expect(resolveChaos({ delayMs: [50, 20] }).delayMs).toEqual([50, 50]);
    expect(resolveChaos({ delayMs: [0, 99999] }).delayMs).toEqual([0, MAX_DELAY_MS]);
    expect(resolveChaos({ reorder: false, match: "/api" })).toMatchObject({ reorder: false, match: "/api" });
    expect(() => resolveChaos({ delayMs: [1] as unknown as [number, number] })).toThrow(/delayMs/);
    expect(() => resolveChaos({ match: 5 as unknown as string })).toThrow(/match/);
  });
});

describe("chaos: the filter", () => {
  it("only fetch and XHR requests, never the runtime's own files", () => {
    expect(isCandidate(req(), undefined)).toBe(true);
    expect(isCandidate(req({ resourceType: "xhr" }), undefined)).toBe(true);
    for (const t of ["document", "script", "stylesheet", "image", "font", "websocket", "other"]) expect(isCandidate(req({ resourceType: t }), undefined), t).toBe(false);
    expect(isCandidate(req({ url: `http://app.test${RUNTIME_PATH}genclass.global.js` }), undefined)).toBe(false);
    expect(isCandidate(req({ url: `http://app.test${RUNTIME_PATH}agent.js` }), "/")).toBe(false);
    expect(isCandidate(req({ url: `http://app.test${RUNTIME_PATH}x.js` }), () => true)).toBe(false);
    expect(isRuntimeUrl("http://a/__genclass__/x")).toBe(true);
    expect(isRuntimeUrl("http://a/api/__genclass__/x")).toBe(false);
  });

  it("by default: same-origin requests with an /api path or an Accept header asking for JSON, decided from the request alone", () => {
    expect(isCandidate(req(), undefined)).toBe(true); // /api path
    expect(isCandidate(req({ sameOrigin: false }), undefined)).toBe(false);
    expect(isCandidate(req({ url: "http://app.test/graphql", accept: "application/json, text/plain, */*" }), undefined)).toBe(true);
    expect(isCandidate(req({ url: "http://app.test/graphql", accept: "*/*" }), undefined)).toBe(false);
    // a stream or any other same-origin fetch outside the filter is never held
    expect(isCandidate(req({ url: "http://app.test/events", accept: "text/event-stream" }), undefined)).toBe(false);
    expect(isCandidate(req({ url: "http://app.test/fragment" }), undefined)).toBe(false);
  });

  it("with a match: a path prefix, a URL prefix, a RegExp, a function or a list", () => {
    expect(isCandidate(req({ url: "http://app.test/graphql" }), "/graphql")).toBe(true);
    expect(isCandidate(req({ url: "http://app.test/graphql" }), "/api")).toBe(false);
    expect(isCandidate(req({ url: "https://api.other.com/v1/x", sameOrigin: false }), "https://api.other.com/")).toBe(true);
    expect(isCandidate(req({ url: "https://api.other.com/v1/x", sameOrigin: false }), /\/v1\//)).toBe(true);
    expect(isCandidate(req({ url: "https://api.other.com/v2/x", sameOrigin: false }), /\/v1\//g)).toBe(false);
    expect(isCandidate(req({ method: "POST" }), (r) => r.method === "POST")).toBe(true);
    expect(isCandidate(req({ method: "GET" }), (r) => r.method === "POST")).toBe(false);
    expect(isCandidate(req({ url: "http://app.test/graphql" }), ["/api", "/graphql"])).toBe(true);
    expect(isCandidate(req({ url: "http://app.test/other" }), ["/api", "/graphql"])).toBe(false);
  });

  it("describeMatch for the race file", () => {
    expect(describeMatch(undefined)).toEqual(["same-origin /api* or Accept: json"]);
    expect(describeMatch(["/api", /x\/y/, () => true])).toEqual(["/api", "/x\\/y/", "function"]);
    expect(describeMatch("https://a/")).toEqual(["https://a/"]);
  });
});

describe("chaos: the scheduler", () => {
  it("keys requests by method, path and occurrence; the same seed plans the same delays, another seed others", () => {
    const a = new ChaosScheduler(resolveChaos({ seed: 3, delayMs: [0, 600] }));
    const b = new ChaosScheduler(resolveChaos({ seed: 3, delayMs: [0, 600] }));
    const c = new ChaosScheduler(resolveChaos({ seed: 4, delayMs: [0, 600] }));
    const urls = ["http://a/api/search?q=r", "http://a/api/search?q=re", "http://a/api/items/7", "http://a/api/search?q=rea"];
    const pa = urls.map((u) => a.plan("get", u));
    const pb = urls.map((u) => b.plan("GET", u));
    const pc = urls.map((u) => c.plan("GET", u));
    expect(pa.map((p) => p.key)).toEqual(["GET /api/search#1", "GET /api/search#2", "GET /api/items/7#1", "GET /api/search#3"]);
    expect(pb).toEqual(pa);
    expect(pc.map((p) => p.key)).toEqual(pa.map((p) => p.key));
    expect(pc.map((p) => p.delayMs)).not.toEqual(pa.map((p) => p.delayMs));
    for (const p of pa) expect(p.delayMs >= 0 && p.delayMs <= 600).toBe(true);
    expect(a.plans).toEqual(pa);
    expect(a.plan("GET", "https://other.test/api/x", false).key).toBe("GET other.test/api/x#1");
    // a cross-origin backend on another random port keeps its key, so the seed gives it the same delay
    expect(b.plan("GET", "http://127.0.0.1:41234/api/x", false).key).toBe(c.plan("GET", "http://127.0.0.1:50999/api/x", false).key);
  });

  it("reorder on: each response waits for its own delay only, so a later one can overtake", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(resolveChaos({ seed: 1, delayMs: [0, 600] }), t.timers);
    const order: string[] = [];
    const first = s.hold({ key: "A", delayMs: 300 }).then(() => order.push("A"));
    const second = s.hold({ key: "B", delayMs: 50 }).then(() => order.push("B"));
    await t.advance(100);
    expect(order).toEqual(["B"]);
    await t.advance(300);
    await Promise.all([first, second]);
    expect(order).toEqual(["B", "A"]);
  });

  it("reorder off: requests leave in the order they were sent, at least FIFO_GAP_MS apart (latency only)", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(resolveChaos({ seed: 1, delayMs: [0, 600], reorder: false }), t.timers);
    const at: Record<string, number> = {};
    const a = s.hold({ key: "A", delayMs: 300 }).then(() => (at.A = t.now()));
    const b = s.hold({ key: "B", delayMs: 50 }).then(() => (at.B = t.now()));
    const c = s.hold({ key: "C", delayMs: 0 }).then(() => (at.C = t.now()));
    await t.advance(100);
    expect(at).toEqual({});
    await t.advance(400);
    await Promise.all([a, b, c]);
    expect(Object.keys(at).sort((x, y) => at[x] - at[y])).toEqual(["A", "B", "C"]);
    expect(at.A).toBe(300);
    expect(at.B - at.A).toBeGreaterThanOrEqual(FIFO_GAP_MS);
    expect(at.C - at.B).toBeGreaterThanOrEqual(FIFO_GAP_MS);
    // a request whose own delay is longer than the gap leaves on its own delay
    const late = new ChaosScheduler(resolveChaos({ seed: 1, reorder: false }), t.timers);
    const t0 = t.now();
    let first = 0;
    let second = 0;
    void late.hold({ key: "X", delayMs: 0 }).then(() => (first = t.now() - t0));
    void late.hold({ key: "Y", delayMs: 200 }).then(() => (second = t.now() - t0));
    await t.advance(250);
    expect(first).toBeLessThanOrEqual(1); // at once (seen at the next tick of the hand-cranked clock)
    expect(second).toBe(200);
  });

  it("a zero delay resolves at once; dispose releases every hold and clears the timers", async () => {
    const t = manualTimers();
    const s = new ChaosScheduler(resolveChaos({ seed: 1 }), t.timers);
    let now = false;
    void s.hold({ key: "Z", delayMs: 0 }).then(() => (now = true));
    await Promise.resolve();
    expect(now).toBe(true);
    const held = [s.hold({ key: "A", delayMs: 5000 }), s.hold({ key: "B", delayMs: 9000 })];
    expect(t.pending()).toBe(2);
    s.dispose();
    expect(t.pending()).toBe(0);
    await Promise.all(held);
    // after dispose nothing is held any more
    let late = false;
    void s.hold({ key: "C", delayMs: 5000 }).then(() => (late = true));
    await Promise.resolve();
    expect(late).toBe(true);
  });
});

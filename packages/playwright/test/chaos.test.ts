import { describe, expect, it } from "vitest";
import { ChaosScheduler, hashSeed, mulberry32, requestKey } from "../src/chaos.js";
import type { ResolvedChaos } from "../src/types.js";

const base: ResolvedChaos = { latencyMs: [50, 800], reorder: false, failRate: 0, failStatus: 503, routes: [/\/api\//], seed: null };

describe("chaos: determinism", () => {
  it("hashSeed and mulberry32 are stable", () => {
    expect(hashSeed("search › fast typing")).toBe(hashSeed("search › fast typing"));
    expect(hashSeed("a")).not.toBe(hashSeed("b"));
    expect(hashSeed(7)).toBe(hashSeed("7"));
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });

  it("the same seed gives the same decisions for the same request sequence", () => {
    const run = () => {
      const s = new ChaosScheduler({ ...base, failRate: 0.3 }, hashSeed("t"));
      const out: unknown[] = [];
      for (let i = 0; i < 20; i++) {
        const d = s.decide(i, "GET http://h/api/x", 1000 + i * 10);
        out.push([d.fail, Math.round(d.until)]);
        s.complete(i);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe("chaos: decisions", () => {
  it("latency stays within [min, max] and counts as delayed", () => {
    const s = new ChaosScheduler(base, 1);
    for (let i = 0; i < 200; i++) {
      const d = s.decide(i, "GET http://h/api/x", 0);
      expect(d.fail).toBe(false);
      expect(d.until >= 50 && d.until <= 800).toBe(true);
      s.complete(i);
    }
    expect(s.stats).toEqual({ matched: 200, delayed: 200, failed: 0, reordered: 0 });
  });

  it("a fixed latency of 0 adds nothing and is not counted as delayed", () => {
    const s = new ChaosScheduler({ ...base, latencyMs: [0, 0] }, 1);
    const d = s.decide(1, "k", 500);
    expect(d.until).toBe(500);
    expect(s.stats.delayed).toBe(0);
  });

  it("failRate 1 fails every request, failRate 0 none", () => {
    const all = new ChaosScheduler({ ...base, failRate: 1 }, 3);
    for (let i = 0; i < 10; i++) expect(all.decide(i, "k", 0).fail).toBe(true);
    expect(all.stats.failed).toBe(10);
    expect(all.inflight()).toBe(0);
    const none = new ChaosScheduler({ ...base, failRate: 0 }, 3);
    for (let i = 0; i < 10; i++) expect(none.decide(i, "k", 0).fail).toBe(false);
    expect(none.stats.failed).toBe(0);
  });

  it("failRate 0.5 fails about half over many requests", () => {
    const s = new ChaosScheduler({ ...base, failRate: 0.5 }, 11);
    let failed = 0;
    for (let i = 0; i < 1000; i++) {
      if (s.decide(i, "k", 0).fail) failed++;
      else s.complete(i);
    }
    expect(failed).toBeGreaterThan(400);
    expect(failed).toBeLessThan(600);
  });

  it("reorder: every older request of the same key still in flight is released after the newer one", () => {
    const s = new ChaosScheduler({ ...base, latencyMs: [300, 300], reorder: true }, 5);
    const first = s.decide(1, "GET http://h/api/search", 1000); // would land at 1300
    expect(first.pushed).toEqual([]);
    expect(first.until).toBe(1300);
    const second = s.decide(2, "GET http://h/api/search", 1100); // lands at 1400: the first is pushed after it
    expect(second.until).toBe(1400);
    expect(second.pushed.map((p) => p.id)).toEqual([1]);
    expect(second.pushed[0].until).toBeGreaterThan(1400);
    expect(second.pushed[0].until).toBeLessThanOrEqual(1400 + 120);
    const third = s.decide(3, "GET http://h/api/search", 1150); // lands at 1450: both older ones land after it, in their order
    expect(third.pushed.map((p) => p.id)).toEqual([1, 2]);
    expect(third.pushed[0].until).toBeGreaterThan(1450);
    expect(third.pushed[1].until).toBeGreaterThan(third.pushed[0].until);
    expect(s.stats.reordered).toBe(3);
    // with no latency at all the newer one still wins
    const fast = new ChaosScheduler({ ...base, latencyMs: [0, 0], reorder: true }, 5);
    const a = fast.decide(1, "k", 1000);
    expect(a.until).toBe(1000);
    const b = fast.decide(2, "k", 1000);
    expect(b.pushed.map((p) => p.id)).toEqual([1]);
    expect(b.pushed[0].until).toBeGreaterThan(b.until);
    expect(fast.stats.reordered).toBe(1);
    fast.complete(1);
    fast.complete(2);
    expect(fast.inflight()).toBe(0);
  });

  it("reorder: with a latency range, an older request landing after a newer one is left alone, one landing before is pushed", () => {
    const s = new ChaosScheduler({ ...base, latencyMs: [100, 100], reorder: true }, 9);
    s.decide(1, "k", 0); // until 100
    const d = s.decide(2, "k", 50); // until 150 > 100: the older one (100) must now land after 150
    expect(d.pushed.map((p) => p.id)).toEqual([1]);
    expect(d.pushed[0].until).toBeGreaterThan(150);
    expect(d.pushed[0].until).toBeLessThanOrEqual(150 + 120);
  });

  it("reorder never touches other keys or completed requests", () => {
    const s = new ChaosScheduler({ ...base, latencyMs: [0, 0], reorder: true }, 2);
    s.decide(1, "GET http://h/api/a", 0);
    s.decide(2, "GET http://h/api/b", 0);
    expect(s.decide(3, "GET http://h/api/b", 0).pushed.map((p) => p.id)).toEqual([2]);
    s.complete(1);
    s.complete(2);
    s.complete(3);
    s.decide(4, "GET http://h/api/a", 10);
    s.complete(4);
    expect(s.decide(5, "GET http://h/api/a", 10).pushed).toEqual([]);
  });

  it("reorder off: nothing is pushed", () => {
    const s = new ChaosScheduler({ ...base, latencyMs: [0, 0] }, 2);
    s.decide(1, "k", 0);
    expect(s.decide(2, "k", 0).pushed).toEqual([]);
    expect(s.stats.reordered).toBe(0);
  });
});

describe("chaos: matching and keys", () => {
  it("matches a URL against every route pattern (global flags do not stick)", () => {
    const s = new ChaosScheduler({ ...base, routes: [/\/api\//g, /graphql$/] }, 1);
    expect(s.matches("http://localhost:3000/api/items")).toBe(true);
    expect(s.matches("http://localhost:3000/api/items")).toBe(true);
    expect(s.matches("http://localhost:3000/graphql")).toBe(true);
    expect(s.matches("http://localhost:3000/assets/app.js")).toBe(false);
  });

  it("requestKey ignores the query so q=re and q=rea can overtake each other", () => {
    expect(requestKey("get", "http://h/api/search?q=re")).toBe(requestKey("GET", "http://h/api/search?q=rea"));
    expect(requestKey("GET", "http://h/api/search")).not.toBe(requestKey("POST", "http://h/api/search"));
    expect(requestKey("GET", "not a url")).toBe("GET not a url");
  });
});

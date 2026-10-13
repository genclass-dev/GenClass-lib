// Network chaos: seeded per-request decisions (delay, fail, reorder) applied through page.route. The scheduler
// is pure and takes the clock as an argument (unit-tested); installChaos wires it to Playwright with real timers.
// Invariants: the same seed gives the same decisions for the same request sequence; a request is never dropped
// (it is delayed, answered with `failStatus`, or passed on with route.fallback()); a failing handler passes the
// request on untouched rather than breaking the test.

import type { Page, Request, Route } from "@playwright/test";
import type { ChaosStats, ResolvedChaos } from "./types.js";

/** FNV-1a of a string or number -> 32-bit seed. */
export function hashSeed(s: string | number): number {
  const str = String(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small deterministic PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Pending {
  id: number;
  key: string;
  /** When the response is released (the caller's clock, ms). */
  until: number;
}

export interface ChaosDecision {
  fail: boolean;
  /** When to release this request (caller's clock, ms); equals `now` when nothing is added. */
  until: number;
  /** Older in-flight requests of the same key whose release was pushed after this one (reorder). */
  pushed: Pending[];
}

/** The gap kept between a newer response and the older one it overtakes (ms). */
const REORDER_GAP: [number, number] = [20, 120];

export class ChaosScheduler {
  private readonly rnd: () => number;
  private readonly pending = new Map<number, Pending>();
  readonly stats: ChaosStats = { matched: 0, delayed: 0, failed: 0, reordered: 0 };

  constructor(
    readonly chaos: ResolvedChaos,
    seed: number,
  ) {
    this.rnd = mulberry32(seed);
  }

  matches(url: string): boolean {
    for (const re of this.chaos.routes) {
      re.lastIndex = 0;
      if (re.test(url)) return true;
    }
    return false;
  }

  /** Decides for one matched request; `key` groups requests that may overtake each other (method + path). */
  decide(id: number, key: string, now: number): ChaosDecision {
    this.stats.matched++;
    const fail = this.chaos.failRate > 0 && this.rnd() < this.chaos.failRate;
    const [lo, hi] = this.chaos.latencyMs;
    const delay = hi > lo ? lo + (hi - lo) * this.rnd() : lo;
    if (fail) {
      this.stats.failed++;
      return { fail: true, until: now, pushed: [] };
    }
    const until = now + delay;
    if (delay > 0) this.stats.delayed++;
    const pushed: Pending[] = [];
    if (this.chaos.reorder) {
      // every older request of this key still in flight lands after this one
      let floor = until;
      for (const p of this.pending.values()) {
        if (p.key !== key || p.id === id) continue;
        if (p.until <= floor) {
          const [g0, g1] = REORDER_GAP;
          p.until = floor + g0 + (g1 - g0) * this.rnd();
          floor = p.until;
          pushed.push(p);
          this.stats.reordered++;
        }
      }
    }
    this.pending.set(id, { id, key, until });
    return { fail: false, until, pushed };
  }

  complete(id: number): void {
    this.pending.delete(id);
  }

  inflight(): number {
    return this.pending.size;
  }
}

/** Method + path without query: requests that differ only in their query (q=re, q=rea) share a key. */
export function requestKey(method: string, url: string): string {
  try {
    const u = new URL(url);
    return `${method.toUpperCase()} ${u.origin}${u.pathname}`;
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
}

interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Wires a scheduler to page.route. Returns the stats and a dispose() that unroutes and releases everything. */
export async function installChaos(page: Page, chaos: ResolvedChaos, seed: number): Promise<{ scheduler: ChaosScheduler; dispose: () => Promise<void> }> {
  const scheduler = new ChaosScheduler(chaos, seed);
  const waiters = new Map<number, Waiter>();
  let nextId = 0;
  let disposed = false;

  const schedule = (id: number, until: number) => {
    const w = waiters.get(id);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    const ms = Math.max(0, until - Date.now());
    w.timer = setTimeout(() => {
      w.timer = null;
      w.resolve();
    }, ms);
  };

  const hold = (id: number, until: number): Promise<void> =>
    new Promise<void>((resolve) => {
      waiters.set(id, { resolve, timer: null });
      schedule(id, until);
    });

  const matcher = (url: URL) => !disposed && scheduler.matches(url.href);

  const handler = async (route: Route, request: Request) => {
    const id = ++nextId;
    try {
      const d = scheduler.decide(id, requestKey(request.method(), request.url()), Date.now());
      if (d.fail) {
        await route.fulfill({ status: chaos.failStatus, contentType: "application/json", headers: { "x-genclass-chaos": "fail" }, body: JSON.stringify({ error: "injected by @genclass/playwright chaos", status: chaos.failStatus }) });
        return;
      }
      for (const p of d.pushed) schedule(p.id, p.until);
      if (d.until > Date.now()) await hold(id, d.until);
    } catch {
      /* decide or fulfil failed: the request goes on untouched */
    } finally {
      const w = waiters.get(id);
      if (w?.timer) clearTimeout(w.timer);
      waiters.delete(id);
      scheduler.complete(id);
    }
    try {
      await route.fallback();
    } catch {
      /* the page is gone or the route was already handled */
    }
  };

  await page.route(matcher, handler);

  const dispose = async () => {
    disposed = true;
    for (const w of waiters.values()) {
      if (w.timer) clearTimeout(w.timer);
      w.timer = null;
      w.resolve();
    }
    waiters.clear();
    try {
      await page.unroute(matcher, handler);
    } catch {
      /* page closed */
    }
  };

  return { scheduler, dispose };
}

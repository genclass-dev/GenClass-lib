// @vitest-environment happy-dom
// Scheduling and budgets of the measured visual checks (docs/runtime/VISUAL.md sections 2.2, 2.3 and 8;
// src/visual/engine.ts) on the injected FakeClock: no layout engine means zero findings and nothing installed; slices
// end at budgetMs; a pass ends as partial at passBudgetMs; one slow read backs off; the session budget stops
// incremental checks; GenClass's own attribute writes are not app mutations; a hidden tab waits.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VisualHost } from "../src/visual/host.js";
import { Visual } from "../src/visual/engine.js";
import { drain, FakeClock } from "./helpers.js";

type Internals = {
  run(gen: Generator<void>, b: { spent: number; partial: boolean }): Promise<boolean>;
  stats: { maxSliceMs: number; ms: number; stopped?: boolean };
  slow: number;
  maxEl: number;
  muts: number;
  budget: { start: number; spent: number };
  onMutations(r: MutationRecord[]): void;
  addResource(e: unknown): void;
  entry(url: string): { name: string } | undefined;
  okRes: Map<string, unknown>;
  failedRes: Map<string, unknown>;
  moResting: boolean;
  whenVisible(): Promise<void>;
  pass(roots: Element[] | null, manual?: boolean): Promise<unknown[]>;
};

const realRect = document.documentElement.getBoundingClientRect.bind(document.documentElement);
const W = window as unknown as { requestIdleCallback?: unknown };
const realRic = W.requestIdleCallback;
beforeEach(() => {
  // idle callbacks fall back to 0 ms Clock timers, so the fake clock drives every slice
  W.requestIdleCallback = undefined;
});
afterEach(() => {
  document.documentElement.getBoundingClientRect = realRect;
  document.body.innerHTML = "";
  W.requestIdleCallback = realRic;
  delete (document as unknown as { visibilityState?: string }).visibilityState;
});

function host(clock: FakeClock): VisualHost {
  return {
    clock,
    global: window as unknown as Record<string, unknown>,
    seed: "s",
    mode: () => "observe",
    sampled: () => true,
    active: () => true,
    inflight: () => 0,
    errors: () => 0,
    describe: () => "x",
    route: () => "/",
    report: () => undefined,
    note: () => undefined,
    audit: () => undefined,
  };
}

function withLayout(): void {
  const rect = { width: 1024, height: 768, top: 0, left: 0, right: 1024, bottom: 768, x: 0, y: 0, toJSON: () => ({}) };
  document.documentElement.getBoundingClientRect = () => rect as DOMRect;
}

/** Pump the fake clock until `p` settles (idle callbacks fall back to 0 ms Clock timers here). */
async function pump<T>(clock: FakeClock, p: Promise<T>): Promise<T> {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 500 && !done; i++) await clock.advance(1);
  return p;
}

describe("visual scheduling (VISUAL.md 8)", () => {
  it("no layout engine (happy-dom, jsdom, hidden iframes): zero findings, nothing installed, no timers", async () => {
    const clock = new FakeClock();
    const v = new Visual(host(clock), { on: true });
    expect(clock.pending).toBe(0);
    expect(await v.now()).toEqual([]);
    expect(v.summary()).toBeNull();
    v.stop();
  });

  it("slices end once budgetMs is spent, and the longest slice stays within one unit of it", async () => {
    withLayout();
    const clock = new FakeClock();
    const v = new Visual(host(clock), { on: true, budgetMs: 8 }, [], false);
    const i = v as unknown as Internals;
    function* work(): Generator<void> {
      for (let n = 0; n < 20; n++) {
        clock.t += 3; // a 3 ms read
        yield;
      }
    }
    const b = { spent: 0, partial: false };
    expect(await pump(clock, i.run(work(), b))).toBe(true);
    expect(b.partial).toBe(false);
    expect(i.stats.maxSliceMs).toBeLessThanOrEqual(8 + 3);
    expect(b.spent).toBeGreaterThanOrEqual(60);
    v.stop();
  });

  it("a pass ends as partial when passBudgetMs is spent", async () => {
    withLayout();
    const clock = new FakeClock();
    const v = new Visual(host(clock), { on: true, budgetMs: 8, passBudgetMs: 20 }, [], false);
    const i = v as unknown as Internals;
    function* work(): Generator<void> {
      for (let n = 0; n < 100; n++) {
        clock.t += 3;
        yield;
      }
    }
    const b = { spent: 0, partial: false };
    expect(await pump(clock, i.run(work(), b))).toBe(false);
    expect(b.partial).toBe(true);
    expect(b.spent).toBeLessThan(40);
    v.stop();
  });

  it("one read over 16 ms ends the pass, doubles the settle wait and halves maxElements", async () => {
    withLayout();
    const clock = new FakeClock();
    const v = new Visual(host(clock), { on: true, maxElements: 2000 }, [], false);
    const i = v as unknown as Internals;
    function* work(): Generator<void> {
      clock.t += 20;
      yield;
      yield;
    }
    const b = { spent: 0, partial: false };
    expect(await pump(clock, i.run(work(), b))).toBe(false);
    expect(i.slow).toBe(2);
    expect(i.maxEl).toBe(1000);
    v.stop();
  });

  it("the session budget (1,000 ms per 10 minutes) stops incremental re-checks", async () => {
    withLayout();
    const clock = new FakeClock();
    const v = new Visual(host(clock), { on: true }, [], false);
    const i = v as unknown as Internals;
    i.budget.spent = 1000;
    document.body.innerHTML = "<p>Hi</p>";
    expect(await pump(clock, i.pass([document.body.firstElementChild!]))).toEqual([]);
    expect(i.stats.stopped).toBe(true);
    v.stop();
  });

  it("GenClass's own data-genclass-fix writes are not app mutations", () => {
    withLayout();
    const clock = new FakeClock();
    const v = new Visual(host(clock), { on: true }, [], false);
    const i = v as unknown as Internals;
    document.body.innerHTML = "<p>Hi</p>";
    const p = document.querySelector("p")!;
    i.onMutations([{ type: "attributes", attributeName: "data-genclass-fix", target: p, addedNodes: [] as unknown as NodeList, removedNodes: [] as unknown as NodeList } as unknown as MutationRecord]);
    expect(i.muts).toBe(0);
    i.onMutations([{ type: "attributes", attributeName: "class", target: p, addedNodes: [] as unknown as NodeList, removedNodes: [] as unknown as NodeList } as unknown as MutationRecord]);
    expect(i.muts).toBe(1);
    v.stop();
  });

  it("resource entries: only images, CSS requests and stylesheets, at most 500 good and 200 failed, newest kept", () => {
    withLayout();
    const clock = new FakeClock();
    const v = new Visual(host(clock), { on: true }, [], false);
    const i = v as unknown as Internals;
    // a dashboard polling a cache-busted URL that answers 401, and an analytics pixel with a random query: bounded
    for (let n = 0; n < 1000; n++) i.addResource({ name: `https://app.example/api/status?_=${n}`, initiatorType: "fetch", responseStatus: 401, startTime: n });
    expect(i.failedRes.size + i.okRes.size).toBe(0);
    for (let n = 0; n < 1000; n++) i.addResource({ name: `https://px.example/p.gif?r=${n}`, initiatorType: "img", responseStatus: 404, startTime: n });
    expect(i.failedRes.size).toBe(200);
    expect(i.entry("https://px.example/p.gif?r=999")?.name).toBe("https://px.example/p.gif?r=999");
    for (let n = 0; n < 900; n++) i.addResource({ name: `https://app.example/img/${n}.png`, initiatorType: "img", responseStatus: 200, startTime: n });
    expect(i.okRes.size).toBe(500);
    v.stop();
  });

  it("a flood of mutation records (an animation library writing styles every frame) rests the observer for 5 s", async () => {
    withLayout();
    const clock = new FakeClock();
    const v = new Visual(host(clock), { on: true }, [], false);
    const i = v as unknown as Internals;
    document.body.innerHTML = "<p>Hi</p>";
    const p = document.querySelector("p")!;
    const rec = { type: "attributes", attributeName: "style", target: p, addedNodes: [] as unknown as NodeList, removedNodes: [] as unknown as NodeList } as unknown as MutationRecord;
    i.onMutations(Array.from({ length: 2000 }, () => rec));
    expect(i.moResting).toBe(false);
    i.onMutations(Array.from({ length: 2000 }, () => rec));
    expect(i.moResting).toBe(true);
    await clock.advance(5000);
    expect(i.moResting).toBe(false);
    v.stop();
  });

  it("a hidden tab waits until it is visible again", async () => {
    withLayout();
    const clock = new FakeClock();
    const v = new Visual(host(clock), { on: true }, [], false);
    const i = v as unknown as Internals;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    let done = false;
    void i.whenVisible().then(() => (done = true));
    await drain();
    expect(done).toBe(false);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await drain();
    expect(done).toBe(true);
    v.stop();
  });
});

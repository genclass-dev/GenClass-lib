// @vitest-environment happy-dom
// Scheduling and budgets of the measured visual checks (docs/runtime/VISUAL.md sections 2.2, 2.3 and 8;
// src/visual/engine.ts) on the injected FakeClock: no layout engine means zero findings and nothing installed; slices
// end at budgetMs; a pass ends as partial at passBudgetMs; one slow read backs off; the session budget stops
// incremental checks; GenClass's own attribute writes are not app mutations; a hidden tab waits; the settle wait
// ends after 500 ms with nothing in flight and no DOM change, or at its 10 s cap on a page animating inline styles
// (unless the animation is inside [data-genclass-ignore]) or with a request that never ends, and both the quiet
// window and the cap start after the fonts wait. Text checks: the first-pass schedule in VISUAL.md, API.md and the
// README names the delays and caps src/visual/start.ts and engine.ts use (each text is found by its heading or bold
// lead; the rest of the wording is not pinned).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  settledAt: number | null;
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

  it("one read over 16 ms ends the pass, doubles later persistence waits (slow 2) and halves maxElements", async () => {
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

describe("the settle wait before the first pass (VISUAL.md 2.3 and 8 step 3)", () => {
  /** What a requestAnimationFrame loop writing `el.style.transform` on every frame gives the MutationObserver. */
  const styleWrite = (el: Element): MutationRecord =>
    ({ type: "attributes", attributeName: "style", target: el, addedNodes: [] as unknown as NodeList, removedNodes: [] as unknown as NodeList }) as unknown as MutationRecord;

  type SettleOptions = {
    /** An element that gets an inline style write every 33 ms (30 fps) until the engine settles. */
    animate?: string;
    /** The host's in-flight count, by ms since construction (nothing in flight when unset). */
    inflight?: (ms: number) => number;
    /** `document.fonts.ready` never resolves (happy-dom has no `document.fonts`, so the fonts wait ends at once). */
    fontsNeverLoad?: boolean;
  };

  /** Boot an engine (its automatic first pass) on `html` and return how long after construction it settled (16 s at most). */
  async function settleAfter(html: string, o: SettleOptions = {}): Promise<number> {
    withLayout();
    document.body.innerHTML = html;
    const clock = new FakeClock();
    const t0 = clock.now();
    const inflight = o.inflight ?? (() => 0);
    if (o.fontsNeverLoad) Object.defineProperty(document, "fonts", { configurable: true, value: { ready: new Promise(() => undefined) } });
    const v = new Visual({ ...host(clock), inflight: () => inflight(clock.now() - t0) }, { on: true });
    const i = v as unknown as Internals;
    const el = o.animate ? document.querySelector(o.animate)! : null;
    try {
      while (i.settledAt === null && clock.now() - t0 < 16_000) {
        if (el) i.onMutations([styleWrite(el)]);
        await clock.advance(33);
      }
      return i.settledAt === null ? Infinity : i.settledAt - t0;
    } finally {
      v.stop();
      if (o.fontsNeverLoad) delete (document as unknown as { fonts?: unknown }).fonts;
    }
  }

  const MASCOT = '<div class="mascot"><svg><g></g></svg></div><p>Hi</p>';

  it("a quiet page settles after 500 ms with nothing in flight and no DOM change", async () => {
    const t = await settleAfter("<p>Hi</p>");
    expect(t).toBeGreaterThanOrEqual(500);
    expect(t).toBeLessThan(700);
  });

  it("a 30 fps animation writing inline styles (below the 3,000-records-a-second rest) holds it to the 10 s cap", async () => {
    const t = await settleAfter(MASCOT, { animate: ".mascot g" });
    expect(t).toBeGreaterThanOrEqual(10_000);
    expect(t).toBeLessThan(10_200);
  });

  it("the same animation inside [data-genclass-ignore] does not hold it", async () => {
    const t = await settleAfter('<div class="mascot" data-genclass-ignore><svg><g></g></svg></div><p>Hi</p>', { animate: ".mascot g" });
    expect(t).toBeGreaterThanOrEqual(500);
    expect(t).toBeLessThan(700);
  });

  it("a request in flight holds it until 500 ms after the request ends (in-flight is sampled every 100 ms)", async () => {
    // in flight until 3 s: the last busy sample is at 2.9 s, so it settles at 3.4 s, not 500 ms
    const t = await settleAfter("<p>Hi</p>", { inflight: (ms) => (ms < 3_000 ? 1 : 0) });
    expect(t).toBeGreaterThanOrEqual(3_400);
    expect(t).toBeLessThan(3_700);
  });

  it("a request that never ends (a long poll, a hung request) holds it to the 10 s cap", async () => {
    const t = await settleAfter("<p>Hi</p>", { inflight: () => 1 });
    expect(t).toBeGreaterThanOrEqual(10_000);
    expect(t).toBeLessThan(10_200);
  });

  it("the 10 s cap starts after the fonts wait: web fonts that never load add their 3 s (the documented 14.5 s)", async () => {
    const t = await settleAfter(MASCOT, { animate: ".mascot g", fontsNeverLoad: true });
    expect(t).toBeGreaterThanOrEqual(13_000);
    expect(t).toBeLessThan(13_200);
  });

  it("the 500 ms of quiet start after the fonts wait too", async () => {
    const t = await settleAfter("<p>Hi</p>", { fontsNeverLoad: true });
    expect(t).toBeGreaterThanOrEqual(3_500);
    expect(t).toBeLessThan(3_700);
  });
});

describe("the documented first-pass schedule names the delays and caps the code uses (VISUAL.md 2.3 and 8, API.md, README)", () => {
  const PKG = resolve(__dirname, "..");
  const DOCS = resolve(PKG, "..", "..", "docs", "runtime");
  const read = (p: string): string => readFileSync(p, "utf8");
  const START = read(join(PKG, "src", "visual", "start.ts"));
  const ENGINE = read(join(PKG, "src", "visual", "engine.ts"));
  const VISUAL = read(join(DOCS, "VISUAL.md"));
  const API = read(join(DOCS, "API.md"));
  const README = read(join(PKG, "README.md"));

  /** A number literal (`10_000` too) the code uses, found by the code around it. */
  function constant(src: string, re: RegExp, what: string): number {
    const m = re.exec(src);
    expect(m, `${what}: ${re}`).not.toBeNull();
    return Number(m![1].replace(/_/g, ""));
  }
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** `doc` names `ms` as "1.5 s" or "1,500 ms", not as part of a longer number. */
  const names = (doc: string, ms: number): boolean =>
    new RegExp(`(?<![\\d.,])(?:${esc(String(ms / 1000))} s|${esc(ms.toLocaleString("en-US"))} ms)(?!\\d)`).test(doc.replace(/\s+/g, " "));
  /** The text from `from` up to the next `to` (the end of the file without one). */
  function part(doc: string, from: string, to: string): string {
    const a = doc.indexOf(from);
    expect(a, `"${from}"`).toBeGreaterThan(-1);
    const b = doc.indexOf(to, a + from.length);
    return doc.slice(a, b === -1 ? undefined : b);
  }

  /**
   * The delays and caps the code uses, and the end-to-end times they give. Read inside each case, not while the file
   * is collected, so a miss fails the doc cases only and the behaviour tests above still run.
   */
  function durations() {
    const chunk = constant(START, /const soon = \(\) => clock\.setTimeout\(go, ([\d_]+)\)/, "start.ts: the chunk import after load");
    const loadCap = constant(START, /addEventListener\?\.\("load", soon\);\s*clock\.setTimeout\(go, ([\d_]+)\)/, "start.ts: the import when load is late");
    const fonts = constant(ENGINE, /private async fontsReady\(\)[\s\S]*?this\.sleep\(([\d_]+)\)/, "engine.ts fontsReady: the fonts cap");
    const quiet = constant(ENGINE, /private async settle\(\)[\s\S]*?t - busy >= ([\d_]+) \* this\.slow/, "engine.ts settle: the quiet window");
    const cap = constant(ENGINE, /private async settle\(\)[\s\S]*?t - start >= ([\d_]+)\)/, "engine.ts settle: the cap");
    // a page that never goes quiet: the chunk, then the settle cap, which starts after the fonts wait (pinned by "the
    // 10 s cap starts after the fonts wait" above)
    const endToEnd = { "the never-quiet first pass": chunk + cap, "its longest case": chunk + fonts + cap };
    const core = { "the chunk delay": chunk, "the fonts cap": fonts, "the quiet window": quiet, "the settle cap": cap };
    return { all: { ...core, "the import when load is late": loadCap }, core, endToEnd };
  }
  type Durations = ReturnType<typeof durations>;

  // each text is found by its own heading or bold lead, nothing more
  const cases: [string, () => string, (d: Durations) => Record<string, number>][] = [
    ["VISUAL.md 2.3 Page settle", () => part(VISUAL, "- **Page settle**", "- **Persistence**"), (d) => d.all],
    ["VISUAL.md 8 Scheduling and budgets", () => part(VISUAL, "## 8. Scheduling and budgets", "\n## 9. "), (d) => ({ ...d.all, ...d.endToEnd })],
    ["API.md When they run", () => part(API, "- **When they run.**", "\n- **"), (d) => ({ ...d.all, ...d.endToEnd })],
    ["README visual checks Cost", () => part(README, "**Cost.**", "\n\n"), (d) => ({ ...d.core, ...d.endToEnd })],
  ];

  it.each(cases)("%s", (_name, text, want) => {
    const doc = text();
    const missing = Object.entries(want(durations()))
      .filter(([, ms]) => !names(doc, ms))
      .map(([what, ms]) => `${what} (${ms / 1000} s)`);
    expect(missing, "durations the code uses that this text does not name").toEqual([]);
  });
});

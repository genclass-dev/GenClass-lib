// Mutation triage: steady timer ticks (CONTRACT §6 Triage). A field that one timer writes with the same numeric step
// on that timer's own schedule (an elapsed-seconds counter, a countdown) carried the identical-change fact ("An
// identical change to call.elapsedS (+1) was applied N times in the last 10s") on every tick, the only non-neutral
// fact, so a correct 1 Hz clock asked the model about 59 writes a minute (Troy Bot, 0.3.0-beta.0: 87 of 116
// decisions, all "expected"). Once the field's last 4 writes are such ticks, triage no longer counts that one fact; any
// break (another writer, a different step, an off-schedule gap, a second timer) asks again, and every other
// non-neutral fact still asks. The asked situations keep their exact text.
import { describe, expect, it } from "vitest";
import type { Answer, DecisionProvider, EvaluateRequest, ModelStatus } from "../src/types.js";
import { FakeClock, ScriptedDecider, defaultScript, setup, type Setup } from "./helpers.js";

/** setTimeout/setInterval on the fake clock (an interval re-arms itself; `jitter(k)` shifts the k-th re-arm). */
function timerGlobal(holder: { clock?: FakeClock }, jitter?: (k: number) => number) {
  let k = 0;
  return {
    setTimeout: (fn: () => void, ms: number) => holder.clock!.setTimeout(fn, ms),
    clearTimeout: (h: unknown) => holder.clock!.clearTimeout(h),
    setInterval: (fn: () => void, ms: number) => {
      const loop = () => {
        holder.clock!.setTimeout(loop, ms + (jitter ? jitter(++k) : 0));
        fn();
      };
      holder.clock!.setTimeout(loop, ms);
      return 1;
    },
    clearInterval: () => undefined,
  };
}

type Opts = Parameters<typeof setup>[0] & { jitter?: (k: number) => number; fetch?: boolean; slowMs?: number };

/** A provider that answers `ms` of fake-clock time after it is asked (so a held write is visibly held). */
class SlowDecider extends ScriptedDecider {
  constructor(
    private readonly holder: { clock?: FakeClock },
    private readonly ms: number,
  ) {
    super();
  }
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>> {
    this.calls.push(req);
    return new Promise((r) => this.holder.clock!.setTimeout(() => r(this.script(req) as Record<string, Answer>), this.ms));
  }
}

function start(o: Opts = {}) {
  const holder: { clock?: FakeClock } = {};
  const { jitter, fetch, slowMs, ...rest } = o;
  const slow = slowMs ? { decider: new SlowDecider(holder, slowMs) } : {};
  const s = setup({ mode: undefined /* observe */, observe: { fetch: fetch ?? false, timers: true }, extraGlobal: timerGlobal(holder, jitter), ...slow, ...rest });
  if (slow.decider) s.decider = slow.decider;
  holder.clock = s.clock;
  const every = s.g.setInterval as (fn: () => void, ms: number) => unknown;
  const later = s.g.setTimeout as (fn: () => void, ms: number) => unknown;
  const call = s.rt.atom("call", { elapsedS: 0, phase: "talking" });
  const inc = (d = 1) => () => call.set((v) => ({ ...v, elapsedS: v.elapsedS + d }));
  return { s, every, later, call, inc };
}

const asked = (s: Setup) => s.decider.calls.filter((c) => c.trigger === "mutation");
const facts = (c: EvaluateRequest) => c.state.facts as string[];
/** The value each asked write changed call.elapsedS from ("This write would change call.elapsedS: 23 → 24."). */
const befores = (s: Setup) => asked(s).map((c) => Number(/would change call\.elapsedS: (-?\d+) →/.exec(facts(c).join("\n"))?.[1]));

const LEARNING = [
  "An identical change to call.elapsedS (+1) was applied 1.00s ago by interval 1.00s (#1).",
  "An identical change to call.elapsedS (+1) was applied 2 times in the last 10s, last 1.00s ago by interval 1.00s (#2).",
  "An identical change to call.elapsedS (+1) was applied 3 times in the last 10s, last 1.00s ago by interval 1.00s (#3).",
];

describe("mutation triage: steady timer ticks are learned (CONTRACT §6 Triage)", () => {
  it("observe: a 1 Hz +1 elapsed counter reaches the model for its first ticks only, with today's text", async () => {
    const { s, every, call, inc } = start();
    every(inc(), 1000);
    await s.clock.advance(60_000);
    expect(call.get().elapsedS).toBe(60);
    expect(asked(s).map((c) => facts(c)[0])).toEqual(LEARNING);
    expect(s.rt.decisions()).toHaveLength(3); // the skipped ticks leave no decision record
    // the asked situations are exactly what a run that never reaches the learned state asks
    const ref = start();
    ref.every(ref.inc(), 1000);
    await ref.s.clock.advance(4_000);
    expect(asked(ref.s)).toHaveLength(3);
    expect(JSON.stringify(asked(s).map((c) => [c.state, c.questions]))).toBe(JSON.stringify(asked(ref.s).map((c) => [c.state, c.questions])));
    // nothing is relearned over a long session
    await s.clock.advance(9 * 60_000);
    expect(call.get().elapsedS).toBe(600);
    expect(asked(s)).toHaveLength(3);
    s.rt.destroy();
    ref.s.rt.destroy();
  });

  it("guard: the same (background decisions), and a decrementing countdown interval is learned too", async () => {
    const { s, every, call, inc } = start({ mode: "guard" });
    every(inc(), 1000);
    await s.clock.advance(60_000);
    expect(call.get().elapsedS).toBe(60);
    expect(asked(s).map((c) => facts(c)[0])).toEqual(LEARNING);
    s.rt.destroy();
    const d = start({ mode: "guard" });
    d.every(d.inc(-1), 1000);
    await d.s.clock.advance(30_000);
    expect(d.call.get().elapsedS).toBe(-30);
    expect(asked(d.s)).toHaveLength(3);
    d.s.rt.destroy();
  });

  it("a write-then-schedule setTimeout countdown (each tick caused by the previous one) is learned", async () => {
    const { s, later } = start();
    const c = s.rt.atom("countdown", { left: 60 });
    const tick = () => {
      c.set((v) => ({ left: v.left - 1 }));
      later(tick, 1000);
    };
    later(tick, 1000);
    await s.clock.advance(30_000);
    expect(c.get().left).toBe(30);
    expect(asked(s)).toHaveLength(3);
    s.rt.destroy();
  });

  it("an observed store (React state discovery's path: the stuck timer op captured at commit, in a microtask)", async () => {
    const { s, every } = start();
    const rt = s.rt as unknown as { observedStore(base: string, initial: unknown, source: string): { name: string; write(value: unknown, w: unknown): void } | null };
    const value = (n: number) => ({ external0: { state: { elapsedS: n, phase: "talking" } } });
    const store = rt.observedStore("voiceScreen", value(0), "react")!;
    let n = 0;
    let seq = 0;
    every(() => {
      const next = ++n;
      queueMicrotask(() => store.write(value(next), { amb: s.rt.internals.ctx.peek(), user: false, seq: ++seq }));
    }, 1000);
    await s.clock.advance(60_000);
    expect(s.rt.internals.hub.valueAt("voiceScreen.external0.state.elapsedS")).toBe(60);
    const a = asked(s);
    expect(a).toHaveLength(3);
    expect(facts(a[2])[0]).toBe("An identical change to voiceScreen.external0.state.elapsedS (+1) was applied 3 times in the last 10s, last 1.00s ago by interval 1.00s (#3).");
    s.rt.destroy();
  });

  it("guard with policy.holdWrites: learned ticks apply at once, without a hold or a decision record", async () => {
    // a slow model (300 ms) delays the held learning ticks' writes, not their cadence: ticks are timed by their timer ops
    for (const slowMs of [50, 300]) {
      const { s, every, call } = start({ mode: "guard", policy: { holdWrites: true }, slowMs });
      const applied = () => s.rt.internals.hub.valueAt("call.elapsedS") as number; // not the writer's own pending view
      const held: number[] = [];
      let k = 0;
      every(() => {
        k++;
        const want = applied() + 1;
        call.set((v) => ({ ...v, elapsedS: v.elapsedS + 1 }));
        if (applied() !== want) held.push(k);
      }, 1000);
      await s.clock.advance(30_000);
      await s.clock.advance(500); // the last held tick's decision
      expect(applied()).toBe(30);
      expect(asked(s)).toHaveLength(3);
      expect(held).toEqual([2, 3, 4]); // the learning ticks wait for the model, as any salient write
      expect(s.rt.decisions()).toHaveLength(3);
      s.rt.destroy();
    }
  });

  it("observe while the model loads: the learning ticks are deferred and still decided", async () => {
    const loading = new LoadingDecider();
    const { s, every, call, inc } = start({ decider: loading });
    every(inc(), 1000);
    await s.clock.advance(10_000);
    expect(loading.calls).toHaveLength(0);
    loading.load();
    await s.clock.advance(20_000);
    expect(call.get().elapsedS).toBe(30);
    expect(loading.calls.filter((c) => c.trigger === "mutation").map((c) => facts(c)[0])).toEqual(LEARNING);
    s.rt.destroy();
  });

  it("unlearns on a step change: the 4 writes after it are asked again", async () => {
    const { s, every, call } = start();
    let k = 0;
    every(() => {
      k++;
      call.set((v) => ({ ...v, elapsedS: v.elapsedS + (k === 20 ? 5 : 1) }));
    }, 1000);
    await s.clock.advance(30_000);
    expect(befores(s)).toEqual([1, 2, 3, 24, 25, 26, 27]);
    s.rt.destroy();
  });

  it("unlearns on a user write: the 4 ticks after a reset are asked again", async () => {
    const { s, every, call, inc } = start();
    every(inc(), 1000);
    await s.clock.advance(10_000);
    const n0 = asked(s).length;
    expect(n0).toBe(3);
    s.rt.user({ kind: "click", target: 'button "Restart"' }, () => call.set((v) => ({ ...v, elapsedS: 0 })));
    await s.clock.advance(10_000);
    expect(call.get().elapsedS).toBe(10);
    expect(asked(s).length - n0).toBe(4);
    s.rt.destroy();
  });

  it("only the identical-change fact is excused: ticks with a pending local change are all asked", async () => {
    const { s, every, call, inc } = start({ fetch: true });
    s.server.on("POST", "/api/timer/reset", { body: {}, latency: 20_000 });
    every(inc(), 1000);
    await s.clock.advance(10_000);
    const n0 = asked(s).length;
    s.rt.user({ kind: "click", target: 'button "Reset"' }, () => {
      call.set((v) => ({ ...v, elapsedS: 0 }));
      void s.fetch("/api/timer/reset", { method: "POST", body: "{}" });
    });
    await s.clock.advance(10_000);
    const after = asked(s).slice(n0);
    expect(after).toHaveLength(10);
    expect(after.every((c) => facts(c).some((f) => /call\.elapsedS has a pending local change/.test(f)))).toBe(true);
    s.rt.destroy();
  });

  it("an irregular cadence stays salient", async () => {
    const jit = [2000, -800, 500, -700, 1800, -500];
    const { s, every, call, inc } = start({ jitter: (k) => jit[k % jit.length] });
    every(inc(), 1000);
    await s.clock.advance(60_000);
    expect(asked(s).length).toBe(call.get().elapsedS - 1);
    s.rt.destroy();
  });

  it("two intervals writing the same field stay salient (offset by half a period, or registered together)", async () => {
    const a = start();
    a.every(a.inc(), 1000);
    await a.s.clock.advance(500);
    a.every(a.inc(), 1000);
    await a.s.clock.advance(30_000);
    expect(a.call.get().elapsedS).toBe(60);
    expect(asked(a.s).length).toBe(59);
    a.s.rt.destroy();
    const b = start();
    b.every(b.inc(), 1000);
    b.every(b.inc(), 1000);
    await b.s.clock.advance(30_000);
    expect(b.call.get().elapsedS).toBe(60);
    expect(asked(b.s).length).toBe(59);
    b.s.rt.destroy();
  });

  it("a +1/-1 alternation and a wrapping index of 4 stay salient", async () => {
    const a = start();
    let k = 0;
    a.every(() => {
      k++;
      a.call.set((v) => ({ ...v, elapsedS: v.elapsedS + (k % 2 ? 1 : -1) }));
    }, 1000);
    await a.s.clock.advance(30_000);
    expect(asked(a.s).length).toBe(28);
    a.s.rt.destroy();
    const b = start();
    b.every(() => b.call.set((v) => ({ ...v, elapsedS: (v.elapsedS + 1) % 4 })), 1000);
    await b.s.clock.advance(30_000);
    expect(asked(b.s).length).toBe(MODULAR_4);
    b.s.rt.destroy();
  });

  it("only a finite step is learned: a field flipping to and from NaN at 1 Hz stays salient", async () => {
    // every change into or out of NaN has the delta "n:NaN", whatever the values: no step at all (0.3.0-beta.0 asked
    // 29 of these 30 writes, the identical-change fact being their only non-neutral fact)
    for (const next of [(k: number) => (k % 2 ? NaN : 60), (k: number) => (k % 2 ? NaN : 50 + k), (k: number) => (k % 2 ? 0 / 0 : 3000 / 50)]) {
      const { s, every } = start();
      const stats = s.rt.atom("stats", { fps: 0 });
      let k = 0;
      every(() => stats.set({ fps: next(++k) }), 1000);
      await s.clock.advance(30_000);
      expect(k).toBe(30);
      expect(asked(s).length).toBe(29);
      expect(facts(asked(s)[28])[0]).toMatch(/^An identical change to stats\.fps \(NaN\) was applied 10 times in the last 10s/);
      s.rt.destroy();
    }
  });

  it("a steady tick written through a task op, a 100 ms interval and a timer appending identical items stay salient", async () => {
    const a = start();
    a.every(() => void a.s.rt.op("tick", () => a.call.set((v) => ({ ...v, elapsedS: v.elapsedS + 1 }))), 1000);
    await a.s.clock.advance(30_000);
    expect(a.call.get().elapsedS).toBe(30);
    expect(asked(a.s).length).toBe(29);
    a.s.rt.destroy();
    const b = start();
    b.every(b.inc(), 100);
    await b.s.clock.advance(10_000);
    expect(b.call.get().elapsedS).toBe(100);
    expect(asked(b.s).length).toBe(99);
    b.s.rt.destroy();
    const c = start();
    const log = c.s.rt.atom("log", { lines: [] as string[] });
    c.every(() => log.set((v) => ({ lines: [...v.lines, "tick"] })), 1000);
    await c.s.clock.advance(30_000);
    expect(log.get().lines).toHaveLength(30);
    expect(asked(c.s).length).toBe(29);
    c.s.rt.destroy();
  });

  it('triage "always" is unchanged: every tick is asked', async () => {
    const { s, every, inc } = start({ triage: "always" });
    every(inc(), 1000);
    await s.clock.advance(60_000);
    expect(asked(s)).toHaveLength(60);
    s.rt.destroy();
  });

  it("is deterministic: the same ticks give the same calls", async () => {
    const run = async () => {
      const { s, every, inc } = start();
      every(inc(), 1000);
      await s.clock.advance(12_000);
      const out = JSON.stringify(s.decider.calls);
      s.rt.destroy();
      return out;
    };
    expect(await run()).toBe(await run());
  });
});

/** Mutation decisions of a 0,1,2,3,0,... index at 1 Hz over 30 s (measured on 0.3.0-beta.0: never 4 equal steps). */
const MODULAR_4 = 28;

/** A provider that is loading until `load()`. */
class LoadingDecider implements DecisionProvider {
  status: ModelStatus = { state: "loading" };
  calls: EvaluateRequest[] = [];
  private fns = new Set<(s: ModelStatus) => void>();
  private done!: () => void;
  private readonly p = new Promise<void>((res) => (this.done = res));
  ready(): Promise<void> {
    return this.p;
  }
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>> {
    this.calls.push(req);
    return Promise.resolve(defaultScript()(req) as Record<string, Answer>);
  }
  onStatus(fn: (s: ModelStatus) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  load(): void {
    this.status = { state: "ready", model: "loaded" };
    for (const f of this.fns) f(this.status);
    this.done();
  }
}

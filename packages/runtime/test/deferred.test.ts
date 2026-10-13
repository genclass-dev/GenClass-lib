// Observe-mode situations that cannot be decided yet are deferred, not dropped (CONTRACT §10 model loading, OPTIONS-SPEC
// §5.1 hidden tabs, §4.18 model.unloadAfterIdleMs): built at the trigger (the same text an immediate decision reads),
// kept in a bounded queue (DEFERRED_MAX, oldest dropped and counted), and decided in order once the model is ready and
// the tab visible, as background decisions that can only detect. Guard and heal keep failing open while loading and
// skipping hidden-tab work; a deferred situation never acts, whatever the mode is by the time it is decided.
import { describe, expect, it } from "vitest";
import { IdleUnloadProvider } from "../src/index.js";
import { DEFERRED_MAX } from "../src/runtime.js";
import type { Answer, Atom, DecisionProvider, EvaluateRequest, ModelStatus } from "../src/types.js";
import { FakeClock, defaultScript, setup } from "./helpers.js";

type Script = (req: EvaluateRequest) => Record<string, Answer>;

/** A provider that is loading until `load()` (its ready() resolves then; status listeners are told). */
class LoadingDecider implements DecisionProvider {
  status: ModelStatus = { state: "loading" };
  calls: EvaluateRequest[] = [];
  private fns = new Set<(s: ModelStatus) => void>();
  private done!: () => void;
  private fail!: (e: unknown) => void;
  private readonly p = new Promise<void>((res, rej) => {
    this.done = res;
    this.fail = rej;
  });
  constructor(public script: Script = defaultScript()) {
    this.p.catch(() => undefined);
  }
  ready(): Promise<void> {
    return this.p;
  }
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>> {
    this.calls.push(req);
    return Promise.resolve(this.script(req));
  }
  onStatus(fn: (s: ModelStatus) => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  set(s: ModelStatus): void {
    this.status = s;
    for (const f of this.fns) f(s);
  }
  load(): void {
    this.set({ state: "ready", model: "loaded" });
    this.done();
  }
  error(): void {
    this.set({ state: "error", error: "bad model" });
    this.fail(new Error("bad model"));
  }
}

const STALE = defaultScript({ mutation: { diagnosis: "stale", action: "discard" } });

/** n writes, each to its own atom, in one synchronous block (no decision lands between them). */
function writes(s: ReturnType<typeof setup>, n: number, from = 0): Atom<number>[] {
  const out: Atom<number>[] = [];
  for (let i = from; i < from + n; i++) {
    const a = s.rt.atom(`s${i}`, 0);
    void s.rt.op(`w${i}`, () => a.set(1));
    out.push(a);
  }
  return out;
}

function failOpens(s: ReturnType<typeof setup>): string[] {
  const out: string[] = [];
  s.rt.tap = { failOpen: (r, t) => void out.push(`${r}:${t}`) };
  return out;
}

const stores = (calls: EvaluateRequest[]) => calls.map((c) => c.subject?.store);

describe("observe: situations built while the model loads are decided once it is ready (CONTRACT §10)", () => {
  it("decided in order, from the text built at the trigger (byte-identical to an immediate decision), without acting", async () => {
    // reference: the model ready from the start
    const ref = setup({ mode: undefined, triage: "always", script: STALE });
    writes(ref, 3);
    await ref.clock.flush();
    const want = ref.decider.calls.map((c) => JSON.stringify([c.trigger, c.state, c.questions]));
    expect(want).toHaveLength(3);

    const loading = new LoadingDecider(STALE);
    const s = setup({ mode: undefined, triage: "always", decider: loading });
    const atoms = writes(s, 3);
    await s.clock.flush();
    expect(loading.calls).toHaveLength(0);
    expect(s.rt.decisions()).toHaveLength(0);
    expect(atoms.map((a) => a.get())).toEqual([1, 1, 1]); // nothing waited: observe never holds
    loading.load();
    await s.clock.flush();
    expect(loading.calls.map((c) => JSON.stringify([c.trigger, c.state, c.questions]))).toEqual(want);
    expect(stores(loading.calls)).toEqual(["s0", "s1", "s2"]);
    const ds = s.rt.decisions();
    expect(ds).toHaveLength(3);
    expect(ds.every((d) => d.diagnosis === "stale" && d.detection === "likely" && d.ran === "apply")).toBe(true);
    expect(s.rt.interventions()).toEqual([]);
  });

  it(`keeps at most ${DEFERRED_MAX}: the oldest are dropped and counted as failOpen "not-ready"`, async () => {
    const loading = new LoadingDecider();
    const s = setup({ mode: undefined, triage: "always", decider: loading });
    const fo = failOpens(s);
    writes(s, DEFERRED_MAX + 2);
    await s.clock.flush();
    expect(fo).toEqual(["not-ready:mutation", "not-ready:mutation"]);
    loading.load();
    await s.clock.flush();
    expect(loading.calls).toHaveLength(DEFERRED_MAX);
    expect(stores(loading.calls)[0]).toBe("s2"); // s0 and s1 were the oldest
  });

  it("a model that fails to load drops them, counted", async () => {
    const loading = new LoadingDecider();
    const s = setup({ mode: undefined, triage: "always", decider: loading });
    const fo = failOpens(s);
    writes(s, 2);
    await s.clock.flush();
    loading.error();
    await s.clock.flush();
    expect(fo).toEqual(["not-ready:mutation", "not-ready:mutation"]);
    expect(loading.calls).toHaveLength(0);
  });

  it("guard: nothing is deferred (each fails open as not-ready, as a held subject must)", async () => {
    const loading = new LoadingDecider(STALE);
    const s = setup({ mode: "guard", triage: "always", decider: loading });
    const fo = failOpens(s);
    writes(s, 2);
    await s.clock.flush();
    expect(fo).toEqual(["not-ready:mutation", "not-ready:mutation"]);
    loading.load();
    await s.clock.flush();
    expect(loading.calls).toHaveLength(0);
    expect(s.rt.decisions()).toEqual([]);
  });

  it("a deferred situation never acts: switched to guard before the model is ready, it is dropped; decided as observe otherwise", async () => {
    const loading = new LoadingDecider(STALE);
    const s = setup({ mode: undefined, triage: "always", decider: loading });
    const fo = failOpens(s);
    const a = s.rt.atom("a", 0);
    void s.rt.op("w", () => a.set(1));
    await s.clock.flush();
    s.rt.setMode("guard");
    loading.load();
    await s.clock.flush();
    expect(loading.calls).toHaveLength(0);
    expect(fo).toEqual(["not-ready:mutation"]);
    expect(a.get()).toBe(1);
    expect(s.rt.interventions()).toEqual([]);
  });

  it("a lazy model ('off') starts loading at the first salient situation, which is then decided too", async () => {
    let state: ModelStatus["state"] = "off";
    let readyCalls = 0;
    const calls: EvaluateRequest[] = [];
    const clock = new FakeClock();
    const lazy: DecisionProvider = {
      get status() {
        return { state } as ModelStatus;
      },
      ready: () => {
        readyCalls++;
        return new Promise<void>((r) =>
          clock.setTimeout(() => {
            state = "ready";
            r();
          }, 500),
        );
      },
      evaluate: (req) => {
        calls.push(req);
        return Promise.resolve(STALE(req));
      },
    };
    const s = setup({ mode: undefined, triage: "always", decider: lazy, clock });
    const a = s.rt.atom("a", 0);
    void s.rt.op("w", () => a.set(1));
    await clock.flush();
    expect(readyCalls).toBe(1);
    expect(calls).toHaveLength(0);
    await clock.advance(600);
    expect(calls).toHaveLength(1);
    expect(s.rt.decisions()[0]).toMatchObject({ trigger: "mutation", diagnosis: "stale", detection: "likely" });
  });
});

/** A document whose visibility the test flips (visibilitychange is dispatched on it). */
function tab(hidden: boolean) {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: hidden ? "hidden" : "visible" });
  const extraGlobal = { addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win), document: doc };
  const show = (v: boolean) => {
    doc.visibilityState = v ? "visible" : "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  return { extraGlobal, show };
}

describe("observe: situations raised in a hidden tab are decided when it is visible again (OPTIONS-SPEC §5.1)", () => {
  it("built while hidden, decided in order on visibilitychange; nothing is counted as skipped", async () => {
    const t = tab(true);
    const s = setup({ mode: undefined, triage: "always", script: STALE, extraGlobal: t.extraGlobal });
    writes(s, 3);
    await s.clock.flush();
    expect(s.decider.calls).toHaveLength(0);
    t.show(true);
    await s.clock.flush();
    expect(stores(s.decider.calls)).toEqual(["s0", "s1", "s2"]);
    expect(s.rt.decisions().map((d) => d.detection)).toEqual(["likely", "likely", "likely"]);
    expect(s.rt.summary().model.hiddenSkipped).toBe(0);
  });

  it(`at most ${DEFERRED_MAX} wait; the oldest are dropped and counted in summary.model.hiddenSkipped`, async () => {
    const t = tab(true);
    const s = setup({ mode: undefined, triage: "always", extraGlobal: t.extraGlobal });
    writes(s, DEFERRED_MAX + 3);
    await s.clock.flush();
    expect(s.rt.summary().model.hiddenSkipped).toBe(3);
    t.show(true);
    await s.clock.flush();
    expect(s.decider.calls).toHaveLength(DEFERRED_MAX);
  });

  it("guard: background situations in a hidden tab are still skipped and counted, never deferred", async () => {
    const t = tab(true);
    const s = setup({ mode: "guard", triage: "always", extraGlobal: t.extraGlobal });
    writes(s, 2);
    await s.clock.flush();
    expect(s.rt.summary().model.hiddenSkipped).toBe(2);
    t.show(true);
    await s.clock.flush();
    expect(s.decider.calls).toHaveLength(0);
  });

  it("hidden while the model loads: decided once both hold, whichever comes last", async () => {
    const t = tab(true);
    const loading = new LoadingDecider();
    const s = setup({ mode: undefined, triage: "always", decider: loading, extraGlobal: t.extraGlobal });
    writes(s, 2);
    await s.clock.flush();
    loading.load();
    await s.clock.flush();
    expect(loading.calls).toHaveLength(0); // ready, still hidden
    t.show(true);
    await s.clock.flush();
    expect(loading.calls).toHaveLength(2);
  });
});

describe("model.unloadAfterIdleMs: an unloaded model reloads on the next salient situation (OPTIONS-SPEC §4.18)", () => {
  /** The first host is ready at once; a reloaded one is loading for 200 ms. */
  function idle(clock: FakeClock, script: Script) {
    let made = 0;
    const calls: EvaluateRequest[] = [];
    const mk = (): DecisionProvider => {
      const n = ++made;
      const st: { status: ModelStatus } = { status: { state: n === 1 ? "ready" : "loading", model: `host${n}` } };
      return {
        get status() {
          return st.status;
        },
        ready: () =>
          st.status.state === "ready"
            ? Promise.resolve()
            : new Promise<void>((r) =>
                clock.setTimeout(() => {
                  st.status = { state: "ready", model: `host${n}` };
                  r();
                }, 200),
              ),
        evaluate: (req) => {
          calls.push(req);
          return Promise.resolve(script(req));
        },
      };
    };
    return { provider: new IdleUnloadProvider(mk, 1000, clock), calls, made: () => made };
  }

  it("observe: the situation that finds it unloaded starts the reload and is decided once it is back", async () => {
    const clock = new FakeClock();
    const m = idle(clock, STALE);
    const s = setup({ mode: undefined, triage: "always", decider: m.provider, clock });
    const a = s.rt.atom("a", 0);
    void s.rt.op("w1", () => a.set(1));
    await clock.flush();
    expect(m.calls).toHaveLength(1);
    await clock.advance(1500);
    expect(s.rt.status.state).toBe("unloaded");
    void s.rt.op("w2", () => a.set(2));
    await clock.flush();
    expect(m.made()).toBe(2); // the reload started
    expect(m.calls).toHaveLength(1);
    await clock.advance(250);
    expect(m.calls).toHaveLength(2);
    expect(s.rt.decisions()).toHaveLength(2);
    // and again later: the reloaded host is idle-unloaded and reloaded the same way
    await clock.advance(1500);
    expect(s.rt.status.state).toBe("unloaded");
    void s.rt.op("w3", () => a.set(3));
    await clock.advance(250);
    expect(m.made()).toBe(3);
    expect(s.rt.decisions()).toHaveLength(3);
  });

  it("guard: the situation during the reload fails open; the next one is decided (detection no longer stops for good)", async () => {
    const clock = new FakeClock();
    const m = idle(clock, STALE);
    const s = setup({ mode: "guard", triage: "always", decider: m.provider, clock });
    const fo = failOpens(s);
    const a = s.rt.atom("a", 0);
    await clock.advance(1500);
    expect(s.rt.status.state).toBe("unloaded");
    void s.rt.op("w1", () => a.set(1));
    await clock.flush();
    expect(fo).toEqual(["not-ready:mutation"]);
    await clock.advance(250);
    void s.rt.op("w2", () => a.set(2));
    await clock.flush();
    expect(m.calls).toHaveLength(1);
    expect(s.rt.decisions()).toHaveLength(1);
  });
});

// Observe-mode situations that cannot be decided yet are deferred, not dropped (CONTRACT §10 model loading, OPTIONS-SPEC
// §5.1 hidden tabs, §4.18 model.unloadAfterIdleMs, §5.3): built at the trigger (the same text an immediate decision
// reads at the same situation budget), kept in a bounded queue (DEFERRED_MAX, oldest dropped and counted), and decided
// in order once the model is ready and the tab visible, as background decisions that can only detect and are reported
// at the possible tier at most. Only where observe's possible tier is in force (detect: "likely" skips them, as 0.2.x
// did). A hidden tab never loads or reloads the model; the tab becoming visible does. Guard and heal skip situations
// while the model loads and skip hidden-tab work, as before 0.3.0; a deferred situation never acts, whatever the mode is
// by the time it is decided.
import { describe, expect, it } from "vitest";
import { fromPairs } from "../src/cdn/config.js";
import { IdleUnloadProvider } from "../src/index.js";
import { DEFERRED_MAX } from "../src/runtime.js";
import type { Answer, Atom, DecisionProvider, Detection, EvaluateRequest, ModelStatus, TelemetryTransport } from "../src/types.js";
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
  it("decided in order, from the text built at the trigger (byte-identical to an immediate decision at the same budget), without acting", async () => {
    // reference: the model ready from the start (the same fixed situation budget: an automatic one is the smallest
    // while the device is unknown, see below)
    const ref = setup({ mode: undefined, triage: "always", script: STALE, situation: { budget: 2400 } });
    writes(ref, 3);
    await ref.clock.flush();
    const want = ref.decider.calls.map((c) => JSON.stringify([c.trigger, c.state, c.questions]));
    expect(want).toHaveLength(3);

    const loading = new LoadingDecider(STALE);
    const s = setup({ mode: undefined, triage: "always", decider: loading, situation: { budget: 2400 } });
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
    // reported at the possible tier at most (their false-report rate is not measured yet): summary, devtools, telemetry
    expect(ds.every((d) => d.diagnosis === "stale" && d.detection === "possible" && d.ran === "apply")).toBe(true);
    expect(s.rt.summary().possibleDetections).toEqual({ stale: 3 });
    expect(s.rt.summary().detections).toEqual({});
    expect(s.rt.interventions()).toEqual([]);
  });

  it('while the device is unknown (not loaded yet), an automatic situation budget is the smallest one (1,000), not 2,400', async () => {
    const loading = new LoadingDecider(STALE);
    const s = setup({ mode: undefined, triage: "always", decider: loading });
    expect(s.rt.situationBudget()).toBe(1000);
    loading.load();
    expect(s.rt.situationBudget()).toBe(2400); // ready, no device reported (a custom provider): as before
  });

  it("deferred detections reach the \"detect\" event and a report function only with detect: \"possible\" set", async () => {
    const run = async (detect?: "possible") => {
      const loading = new LoadingDecider(STALE);
      const reports: string[] = [];
      const s = setup({ mode: undefined, triage: "always", decider: loading, report: (r) => void (r.kind === "detect" && reports.push(r.kind)), ...(detect ? { detect } : {}) });
      const seen: Detection[] = [];
      s.rt.on("detect", (d) => seen.push(d));
      writes(s, 2);
      await s.clock.flush();
      loading.load();
      await s.clock.flush();
      expect(s.rt.decisions().map((d) => d.detection)).toEqual(["possible", "possible"]);
      return { seen: seen.map((d) => d.detection), reports };
    };
    expect(await run()).toEqual({ seen: [], reports: [] });
    expect(await run("possible")).toEqual({ seen: ["possible", "possible"], reports: ["detect", "detect"] });
  });

  it('detect: "likely": nothing is deferred while the model loads (not built, not counted), as 0.2.x', async () => {
    const loading = new LoadingDecider(STALE);
    const s = setup({ mode: undefined, triage: "always", decider: loading, detect: "likely" });
    const fo = failOpens(s);
    writes(s, 2);
    await s.clock.flush();
    loading.load();
    await s.clock.flush();
    expect(fo).toEqual([]);
    expect(loading.calls).toHaveLength(0);
    // the meta tag and data-* attributes take the same key
    expect(fromPairs({ detect: "likely" }).detect).toBe("likely");
    expect(fromPairs({ detect: "possible" }).detect).toBe("possible");
    expect(fromPairs({ detect: "loud" }).detect).toBeUndefined();
  });

  it("a fresh situation is submitted before the deferred ones still waiting (a held one never waits behind them)", async () => {
    const loading = new LoadingDecider(STALE);
    const s = setup({ mode: undefined, triage: "always", decider: loading });
    writes(s, 2);
    await s.clock.flush();
    loading.load();
    writes(s, 1, 5); // before the ready notification's drain runs
    await s.clock.flush();
    expect(stores(loading.calls)).toEqual(["s5", "s0", "s1"]);
  });

  it("a deferred decision's telemetry route is the page path at its trigger, not the page it is decided on", async () => {
    const sent: { events: Record<string, unknown>[] }[] = [];
    const transport: TelemetryTransport = {
      send(_u, body) {
        sent.push(JSON.parse(body));
        return Promise.resolve();
      },
    };
    const loading = new LoadingDecider(STALE);
    const s = setup({ mode: undefined, triage: "always", decider: loading, telemetry: { transport, decisionSample: 1 }, extraGlobal: { crypto: globalThis.crypto, location: { href: "http://app.test/checkout", pathname: "/checkout", search: "" } } });
    writes(s, 1);
    await s.clock.flush();
    // an SPA navigation before the model is ready
    s.g.location = { href: "http://app.test/orders/12345", pathname: "/orders/12345", search: "" };
    loading.load();
    await s.clock.flush();
    writes(s, 1, 1); // decided at once, on the new page
    await s.clock.flush();
    await s.rt.telemetry!.flush();
    const evs = sent.flatMap((b) => b.events);
    expect(evs.filter((e) => e.t === "decision").map((e) => e.route)).toEqual(["/checkout", "/orders/:id"]);
    expect(evs.filter((e) => e.t === "detect").map((e) => e.tier)).toEqual(["possible", undefined]);
    s.rt.destroy();
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

  it("guard: nothing is deferred, built or counted while the model loads, exactly as before 0.3.0", async () => {
    const loading = new LoadingDecider(STALE);
    const s = setup({ mode: "guard", triage: "always", decider: loading });
    const fo = failOpens(s);
    writes(s, 2);
    await s.clock.flush();
    expect(fo).toEqual([]);
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
    expect(s.rt.decisions()[0]).toMatchObject({ trigger: "mutation", diagnosis: "stale", detection: "possible" });
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
    expect(s.rt.decisions().map((d) => d.detection)).toEqual(["possible", "possible", "possible"]);
    expect(s.rt.summary().model.hiddenSkipped).toBe(0);
  });

  it('detect: "likely": hidden-tab situations are skipped and counted, as 0.2.x', async () => {
    const t = tab(true);
    const s = setup({ mode: undefined, triage: "always", detect: "likely", extraGlobal: t.extraGlobal });
    writes(s, 2);
    await s.clock.flush();
    expect(s.rt.summary().model.hiddenSkipped).toBe(2);
    t.show(true);
    await s.clock.flush();
    expect(s.decider.calls).toHaveLength(0);
  });

  it("a lazy model is not loaded from a hidden tab; the tab becoming visible loads it and decides the queue", async () => {
    const t = tab(true);
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
        state = "loading";
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
    const s = setup({ mode: undefined, triage: "always", decider: lazy, clock, extraGlobal: t.extraGlobal });
    writes(s, 2);
    await clock.advance(2000);
    expect(readyCalls).toBe(0);
    t.show(true);
    await clock.flush();
    expect(readyCalls).toBe(1);
    await clock.advance(600);
    expect(stores(calls)).toEqual(["s0", "s1"]);
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

  it("hidden tab: no reload while hidden (hidden time is idle); becoming visible reloads the model and decides the queue", async () => {
    const t = tab(false);
    const clock = new FakeClock();
    const m = idle(clock, STALE);
    const s = setup({ mode: undefined, triage: "always", decider: m.provider, clock, extraGlobal: t.extraGlobal });
    const a = s.rt.atom("a", 0);
    void s.rt.op("w0", () => a.set(1));
    await clock.flush();
    expect(m.calls).toHaveLength(1);
    t.show(false);
    // a background tab polling: salient writes every 300 ms for 6 s, through an idle unload
    for (let i = 1; i <= 20; i++) {
      void s.rt.op(`w${i}`, () => a.set(i + 1));
      await clock.advance(300);
    }
    expect(s.rt.status.state).toBe("unloaded");
    expect(m.made()).toBe(1); // never reloaded from the hidden tab
    expect(m.calls).toHaveLength(1);
    t.show(true);
    await clock.flush();
    expect(m.made()).toBe(2); // the tab came back: the model reloads
    await clock.advance(250);
    expect(m.calls).toHaveLength(21); // and every deferred situation is decided, in order
    expect(s.rt.decisions()).toHaveLength(21);
    expect(s.rt.summary().model.hiddenSkipped).toBe(0);
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

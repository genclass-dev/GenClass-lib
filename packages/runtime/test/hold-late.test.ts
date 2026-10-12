// CONTRACT §8 (policy, decisions, safety): the hold budget before the first decision, and what happens to a decision
// that arrives after a held subject was released. Found on genclass.dev (2026-10-12): the warm-up pass is a ~430-token
// situation, a real one is ~1,100 tokens, so the budget derived from the warm-up (150 ms) expired before the first
// answer (~180 ms); the answer was then thrown away unseen, the queue read as stuck, and the next subject was not
// held either. The first duplicate submit of every page load was lost that way.
import { describe, expect, it } from "vitest";
import { DeciderQueue } from "../src/decide/decider.js";
import { HOLD_MIN_MS } from "../src/decide/policy.js";
import type { Answer, EvaluateRequest } from "../src/types.js";
import { FakeClock, defaultScript, setup, type Setup } from "./helpers.js";

/** Replace the scripted decider's evaluate with one that answers after `delay` ms of fake-clock time. */
function slow(s: Setup, delay: () => number): void {
  const d = s.decider;
  const script = d.script;
  d.evaluate = (req: EvaluateRequest) => {
    d.calls.push(req);
    return new Promise<Record<string, Answer>>((resolve) => s.clock.setTimeout(() => resolve(script(req)), delay()));
  };
}

function doubleSubmit(s: Setup, gapMs: number): Promise<{ status: number; mark: string | null }[]> {
  const { rt, clock, fetch } = s;
  const out: { status: number; mark: string | null }[] = [];
  const submit = () =>
    rt.user({ kind: "click", target: 'button "Send invoice"' }, () => {
      void fetch("/api/orders", { method: "POST", body: JSON.stringify({ invoice: "INV-1042", amount: 2400 }) }).then((r) => {
        out.push({ status: r.status, mark: r.headers.get("x-genclass") });
      });
    });
  submit();
  return clock.advance(gapMs).then(() => {
    submit();
    return out;
  });
}

describe("hold budget before the first decision (§8)", () => {
  it("scales the warm-up latency to a typical situation instead of trusting the small warm-up pass", () => {
    const s = setup();
    // what the WebGPU host reports on genclass.dev after its warm pass: 61 ms for 434 tokens
    s.decider.status = { state: "ready", model: "scripted", latency: { p50: 61, p90: 61, n: 0, tokensP50: 434, msPerToken: 0.141, source: "warmup" } };
    // a typical situation is ~1,100 tokens (observed p50 1,135): ≈ 0.141 × 1,200 + 20 ms round trip = 189 ms, × 1.5
    expect(s.rt.holdBudgetMs()).toBe(284);
    expect(s.rt.holdBudgetMs()).toBeGreaterThan(HOLD_MIN_MS);
  });

  it("uses measured decision latency once there is one", () => {
    const s = setup();
    s.decider.status = { state: "ready", model: "scripted", latency: { p50: 172, p90: 172, n: 1, tokensP50: 1135, msPerToken: 0.151, source: "evaluations" } };
    expect(s.rt.holdBudgetMs()).toBe(258);
  });

  it("falls back to the warm-up time when the host reports no per-token cost", () => {
    const s = setup();
    s.decider.status = { state: "ready", model: "scripted", warmupMs: 400 };
    expect(s.rt.holdBudgetMs()).toBe(600);
  });
});

describe("a decision that arrives after the hold budget (§8)", () => {
  it("releases the subject at the budget, then still records and reports the late answer", async () => {
    const s = setup({ policy: { holdBudgetMs: 150 }, script: defaultScript({ request: { diagnosis: "duplicate", action: "coalesce" } }) });
    const { rt, clock, server } = s;
    const reports: string[] = [];
    rt.on("report", (r) => reports.push(r.message));
    server.on("POST", "/api/orders", ({ n }) => ({ status: 201, body: { order: n }, latency: 1500 }));
    slow(s, () => 400); // the model answers 400 ms after it is asked: later than the 150 ms budget
    const out = await doubleSubmit(s, 90);
    // the second POST waited for the budget, no longer: sent at +150 ms, not coalesced (that would be late)
    await clock.advance(100);
    expect(server.hits.get("POST /api/orders")).toBe(1);
    await clock.advance(100);
    expect(server.hits.get("POST /api/orders")).toBe(2);
    await clock.advance(3000);
    expect(out).toEqual([
      { status: 201, mark: null },
      { status: 201, mark: null },
    ]);
    // the late answer was not thrown away: it is a decision, a detection and a report, and says why it did not act
    const d = rt.decisions().find((x) => x.trigger === "request");
    expect(d).toBeDefined();
    expect(d!.action).toBe("coalesce");
    expect(rt.summary().model.decisions).toBe(1);
    expect(rt.interventions()).toHaveLength(0);
    expect(reports.join("\n")).toMatch(/Flagged a duplicate .*Not acted on \(would have done coalesce 0\.97\): the decision arrived after the hold budget expired/);
  });

  it("a late answer does not leave the queue 'stuck': the next salient request is held and acted on", async () => {
    const s = setup({ policy: { holdBudgetMs: 150 }, script: defaultScript({ request: { diagnosis: "duplicate", action: "coalesce" } }) });
    const { rt, clock, server } = s;
    server.on("POST", "/api/orders", ({ n }) => ({ status: 201, body: { order: n }, latency: 1500 }));
    let delay = 400;
    slow(s, () => delay);
    await doubleSubmit(s, 90);
    await clock.advance(3000);
    expect(server.hits.get("POST /api/orders")).toBe(2);
    // the queue measured one 400 ms answer; with its own budget fixed at 150 ms the runtime will not wait that long,
    // so give it a fast answer and a second measurement before the next double submit
    delay = 60;
    await doubleSubmit(s, 90);
    await clock.advance(3000);
    await doubleSubmit(s, 90);
    await clock.advance(3000);
    const n = server.hits.get("POST /api/orders")!;
    // at least one of the later double submits was held and coalesced (two clicks, one request)
    expect(n).toBeLessThan(6);
    expect(rt.interventions().some((a) => a.action === "coalesce")).toBe(true);
  });
});

describe("DeciderQueue: superseded items run behind fresh ones, never dropped for that alone", () => {
  const req = (trigger: string): EvaluateRequest => ({ trigger, state: { trigger }, questions: {}, priority: 2 });
  const provider = (log: string[], clock: FakeClock) => ({
    status: { state: "ready" as const, model: "p" },
    ready: () => Promise.resolve(),
    evaluate: (r: EvaluateRequest) =>
      new Promise<Record<string, Answer>>((resolve) => {
        log.push(r.trigger);
        clock.setTimeout(() => resolve({}), 10);
      }),
  });

  it("evaluates a superseded item after a fresh one of equal priority", async () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const p = provider(log, clock);
    const q = new DeciderQueue(clock, () => p);
    // one item is being computed; two more queue up: the first is superseded, the second fresh
    const a = q.submit(req("a"), clock.now() + 5000);
    const b = q.submit(req("b"), clock.now() + 5000, () => true);
    const c = q.submit(req("c"), clock.now() + 5000);
    await clock.advance(100);
    expect(log).toEqual(["a", "c", "b"]);
    expect(await a).not.toBeNull();
    expect(await b).not.toBeNull();
    expect(await c).not.toBeNull();
  });

  it("skips a superseded item on a slow provider, so a fresh held item is never queued behind one", async () => {
    const clock = new FakeClock();
    const log: string[] = [];
    // WASM-class device: 600 ms per decision
    const p = {
      status: { state: "ready" as const, model: "p" },
      ready: () => Promise.resolve(),
      evaluate: (r: EvaluateRequest) =>
        new Promise<Record<string, Answer>>((resolve) => {
          log.push(r.trigger);
          clock.setTimeout(() => resolve({}), 600);
        }),
    };
    const q = new DeciderQueue(clock, () => p);
    const a = q.submit(req("a"), clock.now() + 5000); // measures the 600 ms
    await clock.advance(700);
    expect(await a).not.toBeNull();
    const b = q.submit(req("b"), clock.now() + 5000, () => true); // superseded: would occupy the model for 600 ms
    const c = q.submit(req("c"), clock.now() + 5000);
    await clock.advance(10);
    expect(log).toEqual(["a", "c"]); // c runs now; b was skipped, not computed
    expect(await b).toBeNull();
    await clock.advance(700);
    expect(await c).not.toBeNull();
  });

  it("the provider's own warm-up estimate decides before any measurement (scaled to a typical situation)", async () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const mk = (p50: number, msPerToken: number) => ({
      status: { state: "ready" as const, model: "p", latency: { p50, p90: p50, n: 0, tokensP50: 434, msPerToken, source: "warmup" as const } },
      ready: () => Promise.resolve(),
      evaluate: (r: EvaluateRequest) => {
        log.push(r.trigger);
        return Promise.resolve({} as Record<string, Answer>);
      },
    });
    // WebGPU: 61 ms warm pass → ≈ 189 ms typical: superseded items are computed
    const fast = mk(61, 0.141);
    const q1 = new DeciderQueue(clock, () => fast);
    expect(await q1.submit(req("s"), clock.now() + 5000, () => true)).not.toBeNull();
    // WASM: 200 ms warm pass → ≈ 573 ms typical: superseded items are skipped
    const slow = mk(200, 0.461);
    const q2 = new DeciderQueue(clock, () => slow);
    expect(await q2.submit(req("t"), clock.now() + 5000, () => true)).toBeNull();
    expect(log).toEqual(["s"]);
  });

  it("an answer arriving after the deadline reaches `late`, counts as a latency sample and clears 'stuck'", async () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const p = {
      status: { state: "ready" as const, model: "p" },
      ready: () => Promise.resolve(),
      evaluate: (r: EvaluateRequest) =>
        new Promise<Record<string, Answer>>((resolve) => {
          log.push(r.trigger);
          clock.setTimeout(() => resolve({ ok: { type: "noul", noul: 1 } as unknown as Answer }), 400);
        }),
    };
    const q = new DeciderQueue(clock, () => p);
    const lateSeen: number[] = [];
    const a = q.submit(req("a"), clock.now() + 150, undefined, (r) => lateSeen.push(r.latencyMs));
    await clock.advance(160);
    expect(await a).toBeNull(); // the queue moved on at the deadline
    expect(q.stuck).toBe(true);
    expect(q.computing).toBe(false);
    await clock.advance(300);
    expect(lateSeen).toEqual([400]); // the answer still arrived, 250 ms late
    expect(q.stuck).toBe(false);
    expect(q.latencies()).toEqual([400]);
  });

  it("still drops an item whose deadline passed while it queued", async () => {
    const clock = new FakeClock();
    const log: string[] = [];
    const p = provider(log, clock);
    const q = new DeciderQueue(clock, () => p);
    void q.submit(req("a"), clock.now() + 5000);
    const late = q.submit(req("late"), clock.now() + 5, () => true);
    await clock.advance(100);
    expect(await late).toBeNull();
    expect(log).toEqual(["a"]);
  });
});

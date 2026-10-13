// Detection tiers (CONTRACT §8, InitOptions.detect): in observe, a top diagnosis other than `expected` is "likely" at
// or above the report gate (the aggressiveness profile's value from the model meta) and "possible" at or above the
// eager profile's report value but below it. Possible ones print with console.debug and "(possible)", reach
// explain(), the devtools, the summary and telemetry with their tier, and the "detect" event, "report" listeners, a
// report function and sinks only on request (detect: "possible" for the first three, possible: true for a sink).
// Guard and heal keep their gates: the tiers are reporting only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectionTier, possibleGate } from "../src/decide/policy.js";
import type { Answer, Detection, EvaluateRequest, ModelGate, ModelStatus, Report, SinkRecord, TelemetryTransport } from "../src/types.js";
import { choice, setup } from "./helpers.js";

/** Model 0.2.0's report values per profile (MODEL_CARD.md): cautious 0.95, balanced 0.90, eager 0.70. */
const GATE: ModelGate = {
  report: 0.9,
  profiles: { cautious: { report: 0.95 }, balanced: { report: 0.9 }, eager: { report: 0.7 } },
};
const READY = { state: "ready", model: "m", gate: GATE } as ModelStatus;

/** Every mutation diagnosed `stale` at the probability in `p.value` (action: the passive one). */
function at(p: { value: number }) {
  return (req: EvaluateRequest): Record<string, Answer> => {
    const out: Record<string, Answer> = {};
    const dq = req.questions.diagnosis;
    if (dq?.type === "choice") out.diagnosis = choice("stale", Object.keys(dq.criteria), p.value);
    const aq = req.questions.action;
    if (aq?.type === "choice") out.action = choice(Object.keys(aq.criteria)[0], Object.keys(aq.criteria), 0.97);
    return out;
  };
}

function tiers(opts: Parameters<typeof setup>[0] = {}) {
  const p = { value: 0.8 };
  const reports: Report[] = [];
  const s = setup({ mode: undefined, triage: "always", report: (r) => reports.push(r), script: at(p), ...opts });
  s.decider.status = READY;
  const detections: Detection[] = [];
  s.rt.on("detect", (d) => detections.push(d));
  const a = s.rt.atom("a", 0);
  let n = 0;
  const write = async (v: number) => {
    p.value = v;
    void s.rt.op("w", () => a.set(++n));
    await s.clock.flush();
  };
  return { ...s, p, reports, detections, write };
}

afterEach(() => vi.restoreAllMocks());

describe("detection tiers: likely and possible (CONTRACT §8, InitOptions.detect)", () => {
  it("the tier is a threshold on the model's output: likely at the report gate, possible at the eager gate below it", () => {
    expect(detectionTier("stale", 0.95, { report: 0.9, possible: 0.7 })).toBe("likely");
    expect(detectionTier("stale", 0.9, { report: 0.9, possible: 0.7 })).toBe("likely");
    expect(detectionTier("stale", 0.7, { report: 0.9, possible: 0.7 })).toBe("possible");
    expect(detectionTier("stale", 0.69, { report: 0.9, possible: 0.7 })).toBeUndefined();
    expect(detectionTier("stale", 0.8, { report: 0.9 })).toBeUndefined();
    expect(detectionTier("expected", 0.99, { report: 0.9, possible: 0.7 })).toBeUndefined();
    expect(detectionTier("stale", Number.NaN, { report: 0.9, possible: 0.7 })).toBeUndefined();
    expect(possibleGate(GATE, 0.9)).toBe(0.7);
    expect(possibleGate(GATE, 0.7)).toBeUndefined(); // eager in force: no lower tier
    expect(possibleGate({ report: 0.9 }, 0.9)).toBeUndefined(); // no profiles
    expect(possibleGate({ profiles: { balanced: { report: 0.9 } } }, 0.9)).toBeUndefined(); // no eager profile
  });

  it("observe (default): 0.80 is a possible detection, 0.95 a likely one, 0.60 nothing; the detect event and a report function get the likely one", async () => {
    const t = tiers();
    expect(t.rt.gates()).toMatchObject({ report: 0.9, possible: 0.7, mode: "observe" });
    const listened: string[] = [];
    t.rt.on("report", (r) => void (r.kind === "detect" && listened.push(r.decision!.detection!)));
    const decided: string[] = [];
    t.rt.on("decide", (d) => void decided.push(d.detection ?? "-"));
    await t.write(0.8);
    await t.write(0.95);
    await t.write(0.6);
    expect(t.rt.decisions().map((d) => d.detection)).toEqual(["possible", "likely", undefined]);
    // as in 0.2.x, what an app wired to rt.on("detect"), rt.on("report") or report: fn receives is the likely ones;
    // every decision, with its tier, is on "decide"
    expect(t.detections.map((d) => d.detection)).toEqual(["likely"]);
    expect(listened).toEqual(["likely"]);
    expect(decided).toEqual(["possible", "likely", "-"]);
    expect(t.reports.map((r) => [r.kind, r.decision?.detection])).toEqual([["detect", "likely"]]);
    expect(t.reports[0].message).toMatch(/^\[GenClass\] Flagged a stale write: .* \(stale, 0\.95\)$/);
    // explain() uses the tier recorded at decision time: the same line format, possible ones end in "(possible)"
    const [d1, d2, d3] = t.rt.decisions();
    expect(t.rt.explain(d1.id)!.message).toMatch(/^\[GenClass\] Flagged a stale write: .* \(stale, 0\.80\) \(possible\)$/);
    expect(t.rt.explain(d2.id)!.message).toBe(t.reports[0].message);
    expect(t.rt.explain(d3.id)!.message).toMatch(/^\[GenClass\] Checked /);
    expect(t.rt.explain(d1.id)!.gates).toMatchObject({ report: 0.9, possible: 0.7 });
    // summary counts per tier
    const sum = t.rt.summary();
    expect(sum.detections).toEqual({ stale: 1 });
    expect(sum.possibleDetections).toEqual({ stale: 1 });
    // observe never acts
    expect(t.rt.interventions()).toEqual([]);
  });

  it("console: likely detections print as before (a collapsed group); possible ones only with console.debug", async () => {
    const group = vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const t = tiers({ report: "console" });
    await t.write(0.8);
    await t.write(0.95);
    const dbg = debug.mock.calls.map((c) => String(c[0]));
    expect(dbg).toHaveLength(1);
    expect(dbg[0]).toMatch(/^\[GenClass\] Flagged a stale write: .*\(stale, 0\.80\) \(possible\)$/);
    const groups = group.mock.calls.map((c) => String(c[0]));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatch(/\(stale, 0\.95\)$/);
    expect(info.mock.calls.map((c) => String(c[0])).some((l) => l.includes("(possible)"))).toBe(false);
    // repeats fold per tier: a second possible one within the minute is summarised with console.debug too
    await t.write(0.75);
    await t.clock.advance(61_000);
    expect(debug.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("more in the last minute"))).toHaveLength(1);
  });

  it('detect: "possible" set explicitly: possible detections reach the detect event, "report" listeners and a report function too', async () => {
    const t = tiers({ detect: "possible" });
    const listened: string[] = [];
    t.rt.on("report", (r) => void (r.kind === "detect" && listened.push(r.decision!.detection!)));
    await t.write(0.8);
    await t.write(0.95);
    expect(t.detections.map((d) => d.detection)).toEqual(["possible", "likely"]);
    expect(listened).toEqual(["possible", "likely"]);
    expect(t.reports.map((r) => [r.kind, r.decision?.detection])).toEqual([
      ["detect", "possible"],
      ["detect", "likely"],
    ]);
    expect(t.reports[0].message).toMatch(/^\[GenClass\] Flagged a stale write: .* \(stale, 0\.80\) \(possible\)$/);
    expect(t.rt.explain(t.rt.decisions()[0].id)!.message).toBe(t.reports[0].message);
    // report: "interventions" (listeners only for detections) follows the same rule
    const u = tiers({ report: "interventions" });
    const heard: string[] = [];
    u.rt.on("report", (r) => void (r.kind === "detect" && heard.push(r.decision!.detection!)));
    await u.write(0.8);
    await u.write(0.95);
    expect(heard).toEqual(["likely"]);
  });

  it('detect: "likely" turns the possible tier off; so does an explicit policy.thresholds.report', async () => {
    const t = tiers({ detect: "likely" });
    expect(t.rt.gates().possible).toBeUndefined();
    await t.write(0.8);
    expect(t.detections).toEqual([]);
    const u = tiers({ policy: { thresholds: { report: 0.85 } } });
    expect(u.rt.gates()).toMatchObject({ report: 0.85 });
    expect(u.rt.gates().possible).toBeUndefined();
    await u.write(0.8);
    expect(u.detections).toEqual([]);
    // asked for explicitly, the possible tier sits below the app's own report gate
    const v = tiers({ detect: "possible", policy: { thresholds: { report: 0.85 } } });
    await v.write(0.8);
    expect(v.detections.map((d) => d.detection)).toEqual(["possible"]);
  });

  it("guard and heal: no possible tier by default, and actions are gated exactly as before", async () => {
    const t = tiers({ mode: "guard" });
    expect(t.rt.gates().possible).toBeUndefined();
    await t.write(0.8);
    expect(t.detections).toEqual([]);
    expect(t.rt.decisions()[0].detection).toBeUndefined();
    // detect: "possible" in guard reports them too; it changes nothing that acts
    const g = tiers({ mode: "guard", detect: "possible" });
    await g.write(0.8);
    expect(g.detections.map((d) => d.detection)).toEqual(["possible"]);
    expect(g.rt.decisions()[0]).toMatchObject({ executed: true, tier: "passive" });
    expect(g.rt.interventions()).toEqual([]);
  });

  it("a route scoped to observe in a guard app gets the possible tier there", async () => {
    const t = tiers({ mode: "guard", routes: [{ match: "/search", mode: "observe" }] });
    expect(t.rt.gates()).toMatchObject({ mode: "observe", possible: 0.7 });
    await t.write(0.8);
    expect(t.rt.decisions().map((d) => d.detection)).toEqual(["possible"]);
    expect(t.rt.summary().possibleDetections).toEqual({ stale: 1 });
    expect(t.detections).toEqual([]); // not asked for explicitly
  });

  it("without gate profiles (no lower eager report value) there is no possible tier", async () => {
    const t = tiers();
    t.decider.status = { state: "ready", model: "m", gate: { report: 0.9 } } as ModelStatus;
    expect(t.rt.gates().possible).toBeUndefined();
    await t.write(0.8);
    expect(t.rt.decisions()[0].detection).toBeUndefined();
  });

  it("sinks get likely detections by default and possible ones with possible: true", async () => {
    const plain: SinkRecord[] = [];
    const fn: SinkRecord[] = [];
    const all: SinkRecord[] = [];
    const t = tiers({ sinks: [{ send: (r) => void plain.push(r) }, (r) => void fn.push(r), { send: (r) => void all.push(r), possible: true }] });
    await t.write(0.8);
    await t.write(0.95);
    await t.clock.flush();
    expect(plain.filter((r) => r.kind === "detection").map((r) => r.detection)).toEqual(["likely"]);
    expect(fn.filter((r) => r.kind === "detection").map((r) => r.detection)).toEqual(["likely"]);
    expect(all.filter((r) => r.kind === "detection").map((r) => [r.detection, r.p !== undefined])).toEqual([
      ["possible", true],
      ["likely", true],
    ]);
  });

  it("telemetry: the detect event carries the tier; detections counts the likely ones, possibleDetections the rest", async () => {
    const sent: { events: Record<string, unknown>[] }[] = [];
    const transport: TelemetryTransport = {
      send(_u, body) {
        sent.push(JSON.parse(body));
        return Promise.resolve();
      },
    };
    const t = tiers({ telemetry: { transport }, extraGlobal: { crypto: globalThis.crypto } });
    await t.write(0.8);
    await t.write(0.95);
    await t.rt.telemetry!.flush();
    const evs = sent.flatMap((b) => b.events);
    // only a possible one carries the tier (no field: likely, as from earlier runtimes)
    expect(evs.filter((e) => e.t === "detect").map((e) => [e.tier, e.p])).toEqual([
      ["possible", 0.8],
      [undefined, 0.95],
    ]);
    // each detection's decision record went too (never sampled), with the gate already sent (report 0.9)
    const decs = evs.filter((e) => e.t === "decision") as { gates?: { report?: number; possible?: number } }[];
    expect(decs).toHaveLength(2);
    expect(decs[0].gates?.report).toBe(0.9);
    expect(decs[0].gates).not.toHaveProperty("possible"); // nothing new in the decision record
    t.rt.destroy();
    const sum = sent.flatMap((b) => b.events).filter((e) => e.t === "summary").at(-1) as { counts: Record<string, unknown> };
    expect(sum.counts).toMatchObject({ detections: 1, possibleDetections: 1, detectionsByDiagnosis: { stale: 1 } });
  });
});

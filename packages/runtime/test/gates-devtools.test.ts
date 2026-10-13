// @vitest-environment happy-dom
// Batch 6: the devtools "Now" view shows the gate thresholds in force (defaults and the model's per-trigger values).
import { describe, expect, it } from "vitest";
import { mountDevtools } from "../src/devtools/index.js";
import type { Answer, EvaluateRequest, ModelStatus } from "../src/types.js";
import { choice, setup } from "./helpers.js";

const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

describe("devtools Now view: gates", () => {
  it("lists the effective thresholds and where they come from", async () => {
    const s = setup({ policy: { thresholds: { heal: 0.85 } } });
    s.decider.status = { state: "ready", model: "m", gate: { report: 0.4, guard: { default: 0.6, byTrigger: { delivery: 0.5 } } } } as ModelStatus;
    const dt = mountDevtools(s.rt, { collapsed: false });
    const sr = dt.element!.shadowRoot!;
    await frame();
    (sr.querySelector('[data-tab="now"]') as HTMLElement).click();
    await frame();
    const text = sr.querySelector(".now")?.textContent ?? "";
    expect(text).toContain("default: guard 0.6 (model) · heal 0.85 (policy) · report 0.4 (model)");
    expect(text).toContain("delivery: guard 0.5 (model) · heal 0.85 (policy) · report 0.4 (model)");
    expect(text).toContain("kind: mass (summed probability of the permitted actions)");
    dt.unmount();
    s.rt.destroy();
  });

  it("shows the gain gate kind, τ and margins", async () => {
    const s = setup();
    s.decider.status = { state: "ready", model: "m", gate: { kind: "gain", tauGain: 1.5, guard: { default: 3 }, heal: { default: 5 } } } as ModelStatus;
    const dt = mountDevtools(s.rt, { collapsed: false });
    const sr = dt.element!.shadowRoot!;
    await frame();
    (sr.querySelector('[data-tab="now"]') as HTMLElement).click();
    await frame();
    const text = sr.querySelector(".now")?.textContent ?? "";
    expect(text).toContain("kind: gain (per-action gain over the passive action, τ 1.5)");
    expect(text).toContain("default: guard margin 3 (model) · heal margin 5 (model) · report 0.6 (default)");
    dt.unmount();
    s.rt.destroy();
  });

  it("has an aggressiveness selector next to the mode switch", async () => {
    const s = setup();
    const dt = mountDevtools(s.rt, { collapsed: false });
    const sr = dt.element!.shadowRoot!;
    await frame();
    const sel = sr.querySelector('[data-part="aggressiveness"]') as HTMLSelectElement;
    expect(sel.value).toBe("balanced");
    sel.value = "eager";
    sel.dispatchEvent(new Event("change"));
    expect(s.rt.aggressiveness).toBe(1);
    dt.unmount();
    s.rt.destroy();
  });
});

describe("devtools backfill: the report gate the runtime decided with", () => {
  it("a panel opened after the fact lists exactly the decisions the runtime reported as detections", async () => {
    // before the fix, the backfill listed every non-expected decision at p >= 0.6, so 0.6-0.9 at balanced (report
    // 0.9) showed as detections that the console, telemetry and the dashboard never reported
    const p = { value: 0.75, diag: "stale" };
    const script = (req: EvaluateRequest): Record<string, Answer> => {
      const out: Record<string, Answer> = {};
      const dq = req.questions.diagnosis;
      if (dq?.type === "choice") out.diagnosis = choice(p.diag, Object.keys(dq.criteria), p.value);
      const aq = req.questions.action;
      if (aq?.type === "choice") out.action = choice(Object.keys(aq.criteria)[0], Object.keys(aq.criteria), 0.97);
      return out;
    };
    const s = setup({ mode: undefined, triage: "always", script });
    s.decider.status = { state: "ready", model: "m", gate: { report: 0.9 } } as ModelStatus;
    const detected: string[] = [];
    s.rt.on("detect", (d) => detected.push(d.id));
    const a = s.rt.atom("a", 0);
    const b = s.rt.atom("b", 0);
    void s.rt.op("w1", () => a.set(1)); // 0.75: below the report gate
    await s.clock.flush();
    p.value = 0.95;
    p.diag = "conflict";
    void s.rt.op("w2", () => b.set(1)); // 0.95: a detection
    await s.clock.flush();
    const decs = s.rt.decisions();
    expect(decs.map((d) => d.diagnosis)).toEqual(["stale", "conflict"]);
    expect(detected).toEqual([decs[1].id]);
    const dt = mountDevtools(s.rt, { collapsed: false });
    const sr = dt.element!.shadowRoot!;
    await frame();
    (sr.querySelector('[data-tab="detections"]') as HTMLElement).click();
    await frame();
    const cards = [...sr.querySelectorAll<HTMLElement>('[data-pane="detections"] article.card')];
    expect(cards.map((c) => c.getAttribute("data-id"))).toEqual([decs[1].id]);
    dt.unmount();
    s.rt.destroy();
  });
});

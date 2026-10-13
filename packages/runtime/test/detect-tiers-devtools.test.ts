// @vitest-environment happy-dom
// Devtools and detection tiers (CONTRACT §8, InitOptions.detect): possible detections are listed as secondary cards and
// left out of the badge counts; the backfill (opening the panel after the fact) shows exactly the detections the
// "detect" event carried, from the tier the runtime recorded, not from a threshold of its own.
import { describe, expect, it } from "vitest";
import { mountDevtools } from "../src/devtools/index.js";
import type { Answer, EvaluateRequest, ModelStatus } from "../src/types.js";
import { choice, setup } from "./helpers.js";

const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
const READY = { state: "ready", model: "m", gate: { report: 0.9, profiles: { balanced: { report: 0.9 }, eager: { report: 0.7 } } } } as ModelStatus;

describe("devtools: possible detections are secondary (CONTRACT §8)", () => {
  it("backfill and live cards use the runtime's tier; possible cards are dimmed and not counted", async () => {
    const p = { value: 0.8, diag: "stale" };
    const script = (req: EvaluateRequest): Record<string, Answer> => {
      const out: Record<string, Answer> = {};
      const dq = req.questions.diagnosis;
      if (dq?.type === "choice") out.diagnosis = choice(p.diag, Object.keys(dq.criteria), p.value);
      const aq = req.questions.action;
      if (aq?.type === "choice") out.action = choice(Object.keys(aq.criteria)[0], Object.keys(aq.criteria), 0.97);
      return out;
    };
    const s = setup({ mode: undefined, triage: "always", script });
    s.decider.status = READY;
    const a = s.rt.atom("a", 0);
    const b = s.rt.atom("b", 0);
    // before the panel opens: a possible detection (0.80), and 0.65, which is neither (the old backfill's 0.6 showed it)
    void s.rt.op("w1", () => a.set(1));
    await s.clock.flush();
    p.value = 0.65;
    void s.rt.op("w2", () => b.set(1));
    await s.clock.flush();
    expect(s.rt.decisions().map((d) => d.detection)).toEqual(["possible", undefined]);
    const dt = mountDevtools(s.rt, { collapsed: false });
    const sr = dt.element!.shadowRoot!;
    await frame();
    (sr.querySelector('[data-tab="detections"]') as HTMLElement).click();
    await frame();
    expect(sr.querySelectorAll('[data-pane="detections"] .card').length).toBe(1);
    expect(sr.querySelectorAll('[data-pane="detections"] .card.possible').length).toBe(1);
    // live: a likely one (another diagnosis, so it is its own card)
    p.value = 0.95;
    p.diag = "conflict";
    void s.rt.op("w3", () => a.set(2));
    await s.clock.flush();
    await frame();
    const cards = [...sr.querySelectorAll<HTMLElement>('[data-pane="detections"] .card')];
    expect(cards.length).toBe(2);
    expect(cards.filter((c) => c.classList.contains("possible")).length).toBe(1);
    expect(sr.querySelector('[data-pane="detections"] .card.possible .chip.poss')?.textContent).toBe("possible");
    // the badges count likely detections only
    expect(sr.querySelector(".pc.d b")?.textContent).toBe("1");
    dt.unmount();
    s.rt.destroy();
  });

  it("a live possible detection is listed (from its decision: the detect event does not carry it) without the pill's detection pulse", async () => {
    const p = { value: 0.8 };
    const script = (req: EvaluateRequest): Record<string, Answer> => {
      const out: Record<string, Answer> = {};
      const dq = req.questions.diagnosis;
      if (dq?.type === "choice") out.diagnosis = choice("stale", Object.keys(dq.criteria), p.value);
      const aq = req.questions.action;
      if (aq?.type === "choice") out.action = choice(Object.keys(aq.criteria)[0], Object.keys(aq.criteria), 0.97);
      return out;
    };
    const s = setup({ mode: undefined, triage: "always", script });
    s.decider.status = READY;
    const dt = mountDevtools(s.rt, { collapsed: true });
    const sr = dt.element!.shadowRoot!;
    await frame();
    const pill = sr.querySelector<HTMLElement>('[data-part="pill"]')!;
    const a = s.rt.atom("a", 0);
    void s.rt.op("w1", () => a.set(1)); // 0.80: possible
    await s.clock.flush();
    await frame();
    expect(s.rt.decisions()[0].detection).toBe("possible");
    expect(pill.classList.contains("pdd")).toBe(false);
    expect(sr.querySelector(".pc.d b")?.textContent).toBe("0");
    (pill as HTMLElement).click();
    await frame();
    (sr.querySelector('[data-tab="detections"]') as HTMLElement).click();
    await frame();
    expect(sr.querySelectorAll('[data-pane="detections"] .card.possible').length).toBe(1);
    // a likely one pulses as before
    p.value = 0.95;
    const b = s.rt.atom("b", 0);
    void s.rt.op("w2", () => b.set(1));
    await s.clock.flush();
    expect(pill.classList.contains("pdd")).toBe(true);
    dt.unmount();
    s.rt.destroy();
  });
});

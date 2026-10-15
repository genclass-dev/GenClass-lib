// The bridge between the runtime and the measured visual checks (src/visual/bridge.ts; docs/runtime/VISUAL.md 9.3,
// 9.4): a finding reaches rt.checks(), the "check" event, a kind "check" Report and only the sinks that list
// "check"; a fix writes an audit entry of kind "fix" with no model fields; the console line is labelled as measured.
// It also pins the RuntimeImpl members the bridge reads (some are TypeScript-private): renaming one fails here.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import type { CheckFinding, Report, SinkRecord } from "../src/types.js";
import { follow, hostFor } from "../src/visual/bridge.js";
import { toFinding } from "../src/visual/report.js";
import type { VisualStub } from "../src/visual/start.js";
import { drain, FakeClock, setup } from "./helpers.js";

const OFF = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false };

const finding = (id = "c1"): CheckFinding =>
  toFinding(
    {
      kind: "text-invisible",
      el: null,
      key: "text-invisible|p.a|rest|light",
      severity: "high",
      measured: { ratio: 1 },
      threshold: { value: 1.5, unit: ":1 contrast", source: "WCAG 2.2 contrast formula; unreadable-text threshold" },
      text: "text contrast 1.00:1 on p.a, below 1.5:1 (WCAG 2.2 contrast formula; unreadable-text threshold).",
      suggestion: { selector: "p.a", css: "color: #737373;" },
    },
    { id, at: 1, route: "/cart", scheme: "light", viewport: { w: 1280, h: 800 }, coarse: false, tier: "full", target: 'paragraph "Hi"', selector: "p.a", structural: false },
  );

function stub(rt: RuntimeImpl): VisualStub {
  const v: VisualStub = { setting: "on", b: [], now: () => Promise.resolve([]), start: () => undefined };
  rt.vis = v;
  return v;
}

afterEach(() => vi.restoreAllMocks());

describe("visual bridge (VISUAL.md 9.3, 9.4)", () => {
  it("reads only what the host needs from the runtime (these members must keep their names)", () => {
    const { rt } = setup();
    for (const k of ["clock", "global", "ops", "isPaused", "vis", "effectiveMode", "summary", "on", "addTeardown", "sessionId", "sessionTags", "sampled", "reportMode", "_aggr", "reporter", "sinks", "fire", "pushAudit", "auditBase", "urlParams"])
      expect(k in rt, k).toBe(true);
    expect("sink" in (rt as unknown as { reporter: object }).reporter).toBe(true);
  });

  it("a finding: rt.checks(), the check event, a kind 'check' report; never detect, never an RtEvent", () => {
    const { rt } = setup({ mode: undefined });
    stub(rt);
    const events: string[] = [];
    rt.on("check", (f) => events.push(`check ${f.id}`));
    rt.on("detect", () => events.push("detect"));
    rt.on("report", (r) => events.push(`report ${r.kind}`));
    const before = rt.history().length;
    const host = hostFor(rt, () => "x", (p) => p);
    host.report(finding(), true);
    expect(events).toEqual(["check c1", "report check"]);
    expect(rt.checks().map((f) => f.id)).toEqual(["c1"]);
    expect(rt.history().length).toBe(before);
    expect(rt.decisions()).toEqual([]);
    for (let i = 2; i <= 205; i++) host.report(finding(`c${i}`), false);
    expect(rt.checks().length).toBe(200);
    expect(rt.checks(1)[0].id).toBe("c205");
  });

  it("sinks: only those whose kinds list 'check'; selectors and text only with evidence: true", async () => {
    const plain: SinkRecord[] = [];
    const listed: SinkRecord[] = [];
    const withEvidence: SinkRecord[] = [];
    const { rt } = setup({ sinks: [(r) => void plain.push(r), { send: (r) => void listed.push(r), kinds: ["check"] }, { send: (r) => void withEvidence.push(r), kinds: ["check"], evidence: true }] });
    stub(rt);
    hostFor(rt, () => "x", (p) => p).report(finding(), true);
    await drain();
    expect(plain).toEqual([]);
    expect(listed.length).toBe(1);
    expect(listed[0]).toMatchObject({ kind: "check", check: { kind: "text-invisible", severity: "high", fixed: false }, route: "/cart" });
    expect(listed[0].evidence).toBeUndefined();
    expect(JSON.stringify(listed[0])).not.toContain("p.a");
    expect(withEvidence[0].evidence).toMatchObject({ selector: "p.a", target: 'paragraph "Hi"' });
  });

  it("a fix writes an audit entry of kind 'fix' with no model fields", () => {
    const { rt } = setup();
    hostFor(rt, () => "x", (p) => p).audit({ what: "apply", checkId: "c1", kind: "text-invisible", css: "p.a { color: #737373 }" });
    const e = rt.audit().at(-1)!;
    expect(e.kind).toBe("fix");
    expect(e.fix).toEqual({ what: "apply", checkId: "c1", kind: "text-invisible", css: "p.a { color: #737373 }" });
    for (const k of ["diagnosis", "probabilities", "proposed", "gate", "decisionId"]) expect(e, k).not.toHaveProperty(k);
  });

  it("the console: a collapsed group labelled as measured (never the model's situation); fix lines as one info line", () => {
    const clock = new FakeClock();
    const rt = createRuntime({ clock, global: { location: { pathname: "/" } }, decider: null, observe: OFF }) as RuntimeImpl;
    stub(rt);
    const group = vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    const host = hostFor(rt, () => "x", (p) => p);
    const f = finding();
    host.report(f, true);
    expect(group).toHaveBeenCalledWith(f.message);
    expect(String(log.mock.calls[0][0])).toContain("not a model finding");
    expect(String(log.mock.calls[0][0])).not.toContain("Situation sent to the model");
    host.report(finding("c2"), false); // past the line limit: listeners and rt.checks() only
    expect(group).toHaveBeenCalledTimes(1);
    host.note("[GenClass] Applied a CSS fix for check c1: p.a { color: #737373 }.", f, true);
    expect(info).toHaveBeenCalledWith("[GenClass] Applied a CSS fix for check c1: p.a { color: #737373 }.");
    rt.destroy();
  });

  it("report: a function gets every check report; 'interventions' prints only fix lines", () => {
    const got: Report[] = [];
    const { rt } = setup({ report: (r) => void got.push(r) });
    stub(rt);
    const host = hostFor(rt, () => "x", (p) => p);
    host.report(finding(), true);
    host.note("[GenClass] Undid the CSS fix for check c1.", finding(), true);
    expect(got.map((r) => [r.kind, r.message.slice(0, 28)])).toEqual([
      ["check", "[GenClass] Check (measured):"],
      ["check", "[GenClass] Undid the CSS fix"],
    ]);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const group = vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    const clock = new FakeClock();
    const rt2 = createRuntime({ clock, global: { location: { pathname: "/" } }, decider: null, report: "interventions", observe: OFF }) as RuntimeImpl;
    stub(rt2);
    const h2 = hostFor(rt2, () => "x", (p) => p);
    h2.report(finding(), true);
    h2.note("[GenClass] 3 more measured checks.", finding(), false);
    expect(group).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    h2.note("[GenClass] Applied a CSS fix for check c1.", finding(), true);
    expect(info).toHaveBeenCalledTimes(1);
    rt2.destroy();
  });

  it("follow(): summary() gains its visual key, status changes re-check the fix gate, destroy() stops", () => {
    const { rt } = setup();
    expect("visual" in rt.summary()).toBe(false);
    const calls: string[] = [];
    let ran = false;
    follow(rt, {
      gateFixes: () => calls.push("gate"),
      stop: () => calls.push("stop"),
      summary: () => (ran ? { visual: { passes: 1 } } : null),
    });
    expect("visual" in rt.summary()).toBe(false);
    ran = true;
    expect((rt.summary() as unknown as { visual: { passes: number } }).visual.passes).toBe(1);
    rt.setMode("observe");
    expect(calls).toContain("gate");
    rt.destroy();
    expect(calls).toContain("stop");
  });

  it("the host: effective mode, sampling, pause, in-flight count, normalised route", () => {
    const { rt } = setup({ mode: "guard" });
    const host = hostFor(rt, () => "x", (p) => p.replace(/\d+/, ":id"));
    expect(host.mode()).toBe("guard");
    expect(host.sampled()).toBe(true);
    expect(host.active()).toBe(true);
    rt.pause();
    expect(host.active()).toBe(false);
    rt.resume();
    expect(host.inflight()).toBe(0);
    expect(host.route()).toBe("/search");
    expect(host.seed).toBe((rt as unknown as { sessionId: string }).sessionId);
  });

  it("the host's route masks a path segment holding an @ (raw or %40), as sink records and telemetry send a route", () => {
    const at = (pathname: string) => {
      const { rt } = setup({ mode: "guard", extraGlobal: { location: { href: `http://app.test${pathname}`, pathname, search: "" } } });
      return hostFor(rt, () => "x", (p) => p).route();
    };
    expect(at("/u/jane@example.com/orders")).toBe("/u/:id/orders");
    expect(at("/u/jane%40example.com")).toBe("/u/:id");
    expect(at("/cart")).toBe("/cart");
  });
});

// Batch 12: configuration options (docs/runtime/OPTIONS-SPEC.md). One block per option.
import { describe, expect, it, vi } from "vitest";
import { defaultScript, FakeClock, setup } from "./helpers.js";
import { deviceEnv, evalLoadIf, IdleUnloadProvider } from "../src/index.js";
import { hash32 } from "../src/util/match.js";
import type { DecisionProvider, ModelStatus, SinkRecord } from "../src/types.js";

const DELAY = defaultScript({ request: { diagnosis: "overload", action: "delay" } });

async function hit(s: ReturnType<typeof setup>, url = "/api/x", n = 1, step = 2000): Promise<void> {
  for (let i = 0; i < n; i++) {
    const p = s.fetch(url).catch(() => undefined);
    await s.clock.advance(step);
    await p;
  }
}
const reqDecisions = (s: ReturnType<typeof setup>) => s.rt.decisions().filter((d) => d.trigger === "request");

describe("enabled / disable()", () => {
  it("enabled:false installs nothing and never consults the model", async () => {
    const s = setup({ enabled: false, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.rt.status.state).toBe("disabled");
    expect(s.decider.calls.length).toBe(0);
  });
  it("disable() stops decisions", async () => {
    const s = setup({ triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    const n = s.decider.calls.length;
    expect(n).toBeGreaterThan(0);
    s.rt.disable();
    await hit(s);
    expect(s.decider.calls.length).toBe(n);
  });
});

describe("sample", () => {
  it("sample:0 observes only", async () => {
    const s = setup({ sample: 0, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.rt.status.sampled).toBe(false);
    expect(reqDecisions(s).every((d) => !d.executed)).toBe(true);
    expect(s.rt.interventions().length).toBe(0);
  });
  it("sample:1 acts", async () => {
    const s = setup({ sample: 1, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.rt.interventions().length).toBe(1);
  });
});

describe("routes", () => {
  it("a route rule demotes to observe", async () => {
    const s = setup({ routes: [{ match: "/search", mode: "observe" }], triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.rt.interventions().length).toBe(0);
  });
  it("a route rule never promotes", async () => {
    const s = setup({ mode: "observe", routes: [{ match: "/search", mode: "heal" }], triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.rt.interventions().length).toBe(0);
  });
});

describe("requests", () => {
  it("ignore: no op, no decision", async () => {
    const s = setup({ requests: { ignore: ["/api/x"] }, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.decider.calls.length).toBe(0);
    expect(s.server.log.length).toBe(1);
  });
  it("protect: decided but never acted on", async () => {
    const s = setup({ requests: { protect: ["/api/x"] }, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.rt.interventions().length).toBe(0);
  });
  it("a throwing protect predicate counts as protected", async () => {
    const s = setup({ requests: { protect: [() => { throw new Error("x"); }] }, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.rt.interventions().length).toBe(0);
  });
  it("cross-origin requests are always passive", async () => {
    const s = setup({ triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s, "http://other.test/api/x");
    expect(s.rt.interventions().length).toBe(0);
  });
  it("labels never reach the model unless labelsToModel", async () => {
    for (const labelsToModel of [false, true]) {
      const s = setup({ requests: { labels: [{ match: "/api/x", label: "checkout total" }], labelsToModel }, triage: "always", script: DELAY });
      s.server.on("GET", "/api/x", { body: 1, latency: 5 });
      await hit(s, "/api/x", 2);
      const seen = JSON.stringify(s.decider.calls.map((c) => c.state));
      expect(seen.includes("checkout total")).toBe(labelsToModel);
    }
  });
});

describe("breaker", () => {
  it("errors after actions trip it and demote the session", async () => {
    const s = setup({ triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { status: 500, body: "no", latency: 5 });
    await hit(s, "/api/x", 4);
    expect(s.rt.breaker.tripped).toBeTruthy();
    expect(s.rt.status.effectiveMode).toBe("observe");
    s.rt.breaker.reset();
    expect(s.rt.breaker.tripped).toBeFalsy();
  });
  it("breaker:false never trips", async () => {
    const s = setup({ breaker: false, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { status: 500, body: "no", latency: 5 });
    await hit(s, "/api/x", 4, 30_000); // repeated 5xx lengthen the delay
    expect(s.rt.breaker.tripped).toBeFalsy();
  });
});

describe("shadow", () => {
  it("records what the higher mode would have done, without doing it", async () => {
    const s = setup({ mode: "observe", shadow: "guard", triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.rt.interventions().length).toBe(0);
    const d = reqDecisions(s)[0];
    expect(d.shadow?.action).toBe("delay");
  });
});

describe("onBeforeAction / vetoMode", () => {
  it("enforce: a false return vetoes", async () => {
    const seen: string[] = [];
    const s = setup({ onBeforeAction: (a) => (seen.push(a.action), false), triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(seen).toEqual(["delay"]);
    expect(s.rt.interventions().length).toBe(0);
    expect(reqDecisions(s)[0].reason).toMatch(/vetoed/);
  });
  it("report: the action still runs", async () => {
    const s = setup({ onBeforeAction: () => false, vetoMode: "report", triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.rt.interventions().length).toBe(1);
  });
  it("a throwing hook vetoes", async () => {
    const s = setup({ onBeforeAction: () => { throw new Error("x"); }, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.rt.interventions().length).toBe(0);
  });
});

describe("policy.actionLimits", () => {
  it("perSubject caps actions on one subject", async () => {
    const s = setup({ policy: { actionLimits: { perSubject: 2 } }, breaker: false, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s, "/api/x", 3);
    const ds = reqDecisions(s);
    expect(ds.map((d) => d.executed)).toEqual([true, true, false]);
    expect(ds[2].reason).toBe("limit:perSubject");
  });
  it("perSubject defaults to 10 per rolling minute (a typeahead keeps getting fixes)", async () => {
    const s = setup({ breaker: false, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s, "/api/x", 11, 1000);
    const ds = reqDecisions(s);
    expect(ds.slice(0, 10).every((d) => d.executed)).toBe(true);
    expect(ds[10].reason).toBe("limit:perSubject");
    await s.clock.advance(61_000);
    await hit(s, "/api/x", 1, 1000);
    expect(reqDecisions(s).pop()!.executed).toBe(true);
  });
  it("perSession caps the session", async () => {
    const s = setup({ policy: { actionLimits: { perSession: 1 } }, breaker: false, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s, "/api/x", 2);
    expect(reqDecisions(s)[1].reason).toBe("limit:perSession");
  });
});

describe("sinks / summary / session", () => {
  it("sinks get minimal records stamped with the session; summary counts", async () => {
    const recs: SinkRecord[] = [];
    const s = setup({ sinks: [(r) => void recs.push(r)], session: { id: "S1", tags: { plan: "pro" } }, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    await s.clock.advance(10);
    const iv = recs.find((r) => r.kind === "intervention");
    expect(iv?.sessionId).toBe("S1");
    expect(iv?.tags).toEqual({ plan: "pro" });
    expect(iv?.evidence).toBeUndefined();
    expect(s.rt.summary().interventions.delay).toBe(1);
    s.rt.setSession({ id: "S2" });
    await hit(s);
    await s.clock.advance(10);
    expect(recs.some((r) => r.sessionId === "S2")).toBe(true);
    // session tags never reach the model
    expect(JSON.stringify(s.decider.calls.map((c) => c.state)).includes("pro")).toBe(false);
  });
  it("a throwing sink is swallowed", async () => {
    const s = setup({ sinks: [() => { throw new Error("x"); }], triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    await s.clock.advance(10);
    expect(s.rt.interventions().length).toBe(1);
  });
});

describe("hidden tab", () => {
  it("held requests are released without evaluation while hidden", async () => {
    const s = setup({ triage: "always", script: DELAY, extraGlobal: { document: { visibilityState: "hidden" } } });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.decider.calls.length).toBe(0);
    expect(s.server.log.length).toBe(1);
  });
});

describe("model.loadIf", () => {
  const warn = () => undefined;
  it("Save-Data with the default → lazy", () => {
    expect(evalLoadIf({}, { webgpu: false, saveData: true }, warn)).toBe("lazy");
  });
  it("minDeviceMemoryGB:4 on a 2 GB device → skipped", () => {
    expect(evalLoadIf({ loadIf: { minDeviceMemoryGB: 4 } }, { webgpu: false, deviceMemoryGB: 2 }, warn)).toEqual({ skip: "device-memory" });
  });
  it("unknown device memory → loads", () => {
    expect(evalLoadIf({ loadIf: { minDeviceMemoryGB: 4 } }, { webgpu: false }, warn)).toBe("load");
  });
  it("a throwing predicate loads, with a warning", () => {
    const w: string[] = [];
    expect(evalLoadIf({ loadIf: () => { throw new Error("x"); } }, { webgpu: false }, (s) => void w.push(s))).toBe("load");
    expect(w.length).toBe(1);
  });
  it("env.mobile (navigator.userAgentData.mobile) lets a predicate keep the model off phones (README: Costs)", () => {
    expect(deviceEnv({ navigator: { userAgentData: { mobile: true }, deviceMemory: 4 } }).mobile).toBe(true);
    expect(deviceEnv({ navigator: { userAgentData: { mobile: false } } }).mobile).toBe(false);
    expect(deviceEnv({ navigator: {} }).mobile).toBeUndefined(); // Safari: unknown
    const notOnPhones = { loadIf: (env: { mobile?: boolean }) => (env.mobile ? false : true) };
    expect(evalLoadIf(notOnPhones, deviceEnv({ navigator: { userAgentData: { mobile: true } } }), warn)).toEqual({ skip: "loadIf" });
    expect(evalLoadIf(notOnPhones, deviceEnv({ navigator: { userAgentData: { mobile: false } } }), warn)).toBe("load");
  });
});

describe("model.unloadAfterIdleMs", () => {
  it("unloads after idle and rejects (fails open) while reloading", async () => {
    const clock = new FakeClock();
    let made = 0;
    let disposed = 0;
    const mk = (): DecisionProvider => {
      made++;
      const status: ModelStatus = { state: "ready" };
      return { status, ready: () => Promise.resolve(), evaluate: () => Promise.resolve({}), dispose: () => void disposed++ };
    };
    const p = new IdleUnloadProvider(mk, 1000, clock);
    await clock.advance(1500);
    expect(p.status.state).toBe("unloaded");
    expect(disposed).toBe(1);
    await expect(p.evaluate({ trigger: "request", state: {} as never, questions: {} })).rejects.toThrow();
    expect(made).toBe(2);
    await expect(p.evaluate({ trigger: "request", state: {} as never, questions: {} })).resolves.toEqual({});
    p.dispose();
  });
});

// `mode` is validated (0.2.3 review): before, a value that was not observe, guard or heal ("HEAL", "Guard", an object)
// fell through `minMode` and `modeAllows` and ran as heal, which `?genclass-mode=observe` could not lower either.
describe("mode: any value but observe, guard or heal runs as observe, with one warning", () => {
  it.each(["HEAL", "Guard", "heal ", "", {}, 1, true, null])("%j", async (bad) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = setup({ mode: bad as never, triage: "always", script: DELAY });
    expect(s.rt.mode).toBe("observe");
    expect(s.rt.status.effectiveMode).toBe("observe");
    expect(warn.mock.calls.filter((c) => /mode must be "observe", "guard" or "heal"/.test(String(c[0]))).length).toBe(1);
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    await hit(s);
    expect(s.rt.interventions().length).toBe(0);
    warn.mockRestore();
  });

  it("the three modes pass unchanged, without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const m of ["observe", "guard", "heal"] as const) expect(setup({ mode: m }).rt.mode).toBe(m);
    expect(setup({ mode: undefined }).rt.mode).toBe("observe");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("modeAllows fails closed for a value that is not a mode", async () => {
    const { modeAllows } = await import("../src/decide/policy.js");
    for (const bad of ["HEAL", "Guard", "", "off", undefined, null]) {
      expect(modeAllows(bad as never, "guard"), String(bad)).toBe(false);
      expect(modeAllows(bad as never, "heal"), String(bad)).toBe(false);
      expect(modeAllows(bad as never, "passive"), String(bad)).toBe(true);
    }
  });

  it("window.GENCLASS_CONFIG.mode is validated like the meta tag and data attributes", async () => {
    const { readWindowConfig } = await import("../src/cdn/config.js");
    const warns: string[] = [];
    expect(readWindowConfig({ GENCLASS_CONFIG: { mode: "guard", debug: true } }, (m) => warns.push(m))).toEqual({ mode: "guard", debug: true });
    expect(readWindowConfig({ GENCLASS_CONFIG: { mode: "HEAL", debug: true } }, (m) => warns.push(m))).toEqual({ debug: true });
    expect(readWindowConfig({ GENCLASS_CONFIG: { mode: {} } }, (m) => warns.push(m))).toEqual({});
    expect(warns.length).toBe(2);
    expect(warns[0]).toMatch(/GENCLASS_CONFIG\.mode must be "observe", "guard" or "heal" \(got "HEAL"\)/);
    expect(readWindowConfig({ GENCLASS_CONFIG: { mode: "HEAL" } })).toEqual({}); // no sink: still dropped
    expect(readWindowConfig({})).toEqual({});
  });
});

// The sample bucket (OPTIONS-SPEC §4.2) is frozen in sessionStorage. 0.2.3 review: a saved "act" verdict overrode
// `sample: 0` (a tab that drew act under 0.5 kept acting after a deploy set 0, or a same-origin script wrote it); now
// 0 never reads storage, and a verdict is kept with the sample it was drawn under and reused only under the same one.
describe("sample: the stored bucket is read only for the sample it was drawn under; 0 never reads it", () => {
  const storage = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) };
  };
  const ID = "session-1";
  const draw = (p: number) => hash32(ID) / 4294967296 < p;

  it("sample: 0 ignores a saved act verdict and writes nothing", async () => {
    for (const saved of ["act", "act@0.5", "act@0"]) {
      const ss = storage({ "genclass:bucket": saved });
      const s = setup({ sample: 0, session: { id: ID }, triage: "always", script: DELAY, extraGlobal: { sessionStorage: ss } });
      expect([s.rt.status.sampled, s.rt.status.effectiveMode], saved).toEqual([false, "observe"]);
      expect(ss.m.get("genclass:bucket"), saved).toBe(saved);
      s.server.on("GET", "/api/x", { body: 1, latency: 5 });
      await hit(s);
      expect(s.rt.interventions().length, saved).toBe(0);
    }
  });

  it("a verdict drawn under the same sample is reused; one from another sample, or the old bare format, is drawn again", () => {
    const ss = storage({ "genclass:bucket": "observe@0.5" });
    expect(setup({ sample: 0.5, session: { id: ID }, extraGlobal: { sessionStorage: ss } }).rt.status.sampled).toBe(false);
    ss.m.set("genclass:bucket", "act@0.5");
    expect(setup({ sample: 0.5, session: { id: ID }, extraGlobal: { sessionStorage: ss } }).rt.status.sampled).toBe(true);
    for (const stale of ["act@0.9", "observe@0.9", "act", "observe", "act@", "nonsense"]) {
      ss.m.set("genclass:bucket", stale);
      expect(setup({ sample: 0.5, session: { id: ID }, extraGlobal: { sessionStorage: ss } }).rt.status.sampled, stale).toBe(draw(0.5));
      expect(ss.m.get("genclass:bucket"), stale).toBe(draw(0.5) ? "act@0.5" : "observe@0.5");
    }
  });

  it("a fresh draw is stored with its sample, and reloading under the same sample keeps it", () => {
    const ss = storage();
    const first = setup({ sample: 0.3, session: { id: ID }, extraGlobal: { sessionStorage: ss } }).rt.status.sampled;
    expect(first).toBe(draw(0.3));
    expect(ss.m.get("genclass:bucket")).toBe(first ? "act@0.3" : "observe@0.3");
    expect(setup({ sample: 0.3, session: { id: "another-id" }, extraGlobal: { sessionStorage: ss } }).rt.status.sampled).toBe(first);
    // sample: 1 never reads or writes it either
    ss.m.set("genclass:bucket", "observe@1");
    expect(setup({ sample: 1, session: { id: ID }, extraGlobal: { sessionStorage: ss } }).rt.status.sampled).toBe(true);
    expect(ss.m.get("genclass:bucket")).toBe("observe@1");
  });
});

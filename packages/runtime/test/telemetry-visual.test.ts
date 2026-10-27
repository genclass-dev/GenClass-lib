// Telemetry's counts for the measured visual checks (docs/runtime/VISUAL.md section 10, approved by the owner on
// 2026-10-27; TELEMETRY.md): the session event says whether the checks run on the page and whether the app turned
// their runtime fixes on; once the checks' chunk has run, every summary event carries the findings per kind and per
// route, the fixes applied and undone, and the passes' cost and tier, added by the chunk (src/visual/bridge.ts), so
// first load carries no code for them. Never a selector, element text, colour, URL, size or a per-finding event.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeImpl } from "../src/runtime.js";
import type { TelemetryClient } from "../src/telemetry/client.js";
import { resetTelemetryNotice } from "../src/telemetry/index.js";
import type { TelemetryTransport, VisualSummary } from "../src/types.js";
import { follow, hostFor, resetVisualNotice, VISUAL_TELEMETRY_NOTICE, withChecks } from "../src/visual/bridge.js";
import { toFinding } from "../src/visual/report.js";
import { setup } from "./helpers.js";

type Ev = Record<string, any>;

function recorder(): TelemetryTransport & { events: Ev[] } {
  const events: Ev[] = [];
  return {
    events,
    send(_url, body) {
      events.push(...(JSON.parse(body) as { events: Ev[] }).events);
      return Promise.resolve();
    },
  };
}

/** A document the first-load stub accepts (it only listens); readyState "loading", so the chunk is never imported. */
const doc = () => ({ readyState: "loading", visibilityState: "visible", addEventListener: () => undefined, removeEventListener: () => undefined });

const rts: RuntimeImpl[] = [];
function tsetup(opts: Parameters<typeof setup>[0] = {}) {
  const transport = recorder();
  const s = setup({ mode: undefined, ...opts, telemetry: { transport }, extraGlobal: { crypto: globalThis.crypto, ...(opts.extraGlobal ?? {}) } });
  rts.push(s.rt);
  return { ...s, transport, tel: s.rt.telemetry as unknown as TelemetryClient };
}

const VS: VisualSummary = {
  checks: { "scroll-lock-stuck": 2, "text-invisible": 1 },
  checksByRoute: { "/": { "scroll-lock-stuck": 2 }, "/items/:id": { "text-invisible": 1 } },
  fixes: { applied: 2, undone: 1 },
  passes: 3,
  elements: 412,
  ms: 41.3,
  maxSliceMs: 7.9,
  partial: 1,
  abstained: 5,
  unsupported: ["image-css-broken"],
  tier: "full",
  stopped: true,
};

const ctl = (v: () => VisualSummary | null) => ({ gateFixes: () => undefined, stop: () => undefined, summary: () => (v() ? { visual: v()! } : null) });

afterEach(() => {
  for (const rt of rts.splice(0)) rt.destroy();
  resetVisualNotice();
  resetTelemetryNotice();
  vi.restoreAllMocks();
});

describe("telemetry: the measured visual checks' counts (VISUAL.md section 10)", () => {
  it("the session event: visual off and fix false without the checks; the stub's setting and the fix option with them", async () => {
    const session = async (opts: Parameters<typeof setup>[0]) => {
      const { tel, transport } = tsetup(opts);
      await tel.flush();
      return transport.events.find((e) => e.t === "session")!;
    };
    expect(await session({})).toMatchObject({ visual: "off", fix: false });
    expect(await session({ visual: true, extraGlobal: { document: doc() } })).toMatchObject({ visual: "on", fix: false });
    expect(await session({ visual: { on: true, fix: true }, mode: "guard", extraGlobal: { document: doc() } })).toMatchObject({ visual: "on", fix: true, mode: "guard" });
    expect(await session({ visual: { on: true, fix: ["scroll-lock-stuck"] }, extraGlobal: { document: doc() } })).toMatchObject({ visual: "on", fix: true });
    expect(await session({ visual: { on: true, fix: [] }, extraGlobal: { document: doc() } })).toMatchObject({ visual: "on", fix: false });
    // "local" never fixes (the engine's resolveCfg needs on: true), so the session says so
    expect(await session({ visual: { on: "local", fix: true }, extraGlobal: { document: doc() } })).toMatchObject({ visual: "local", fix: false });
  });

  it("a summary carries counts.checks, counts.checksByRoute, counts.fixes and runtime.visual once the checks ran, and nothing else of them", async () => {
    const { rt, tel, transport } = tsetup();
    let v: VisualSummary | null = null;
    follow(rt, ctl(() => v));
    tel.summary("hidden");
    await tel.flush();
    const before = transport.events.find((e) => e.t === "summary")!;
    expect(before.counts).not.toHaveProperty("checks");
    expect(before.counts).not.toHaveProperty("fixes");
    expect(before.runtime).not.toHaveProperty("visual");

    v = VS;
    tel.summary("hidden");
    await tel.flush();
    const s = transport.events.filter((e) => e.t === "summary").at(-1)!;
    expect(s.counts.checks).toEqual({ "scroll-lock-stuck": 2, "text-invisible": 1 });
    expect(s.counts.checksByRoute).toEqual({ "/": { "scroll-lock-stuck": 2 }, "/items/:id": { "text-invisible": 1 } });
    expect(s.counts.fixes).toEqual({ applied: 2, undone: 1 });
    expect(s.runtime.visual).toEqual({ passes: 3, ms: 41.3, partial: 1, tier: "full" });
    // the model's counts are unchanged beside them
    expect(s.counts).toMatchObject({ decisions: 0, detections: 0, byDiagnosis: {} });
    const text = JSON.stringify(transport.events);
    for (const never of ["elements", "maxSliceMs", "abstained", "unsupported", "stopped", "image-css-broken"]) expect(text).not.toContain(never);
    // no per-finding event: only the event types telemetry already had
    expect(new Set(transport.events.map((e) => e.t))).toEqual(new Set(["session", "summary"]));
  });

  it("page exit and destroy send them too; a finding reported through the host adds no event of its own", async () => {
    const { rt, tel, transport } = tsetup();
    follow(rt, ctl(() => VS));
    const f = toFinding(
      {
        kind: "scroll-lock-stuck",
        el: null,
        key: "scroll-lock-stuck|body",
        severity: "high",
        measured: { overflow: "hidden" },
        threshold: { value: 1000, unit: "ms", source: "VISUAL.md 3.20" },
        text: "the page cannot scroll: body has overflow: hidden.",
      },
      { id: "c1", at: 1, route: "/", scheme: "light", viewport: { w: 1280, h: 800 }, coarse: false, tier: "full", target: "body", selector: "body.locked-for-test", structural: false },
    );
    hostFor(rt, () => "body", (p) => p).report(f, false);
    rt.destroy();
    await tel.settled();
    const s = transport.events.filter((e) => e.t === "summary").at(-1)!;
    expect(s).toMatchObject({ reason: "destroy", counts: { checks: VS.checks, fixes: VS.fixes } });
    expect(JSON.stringify(transport.events)).not.toContain("locked-for-test");
    expect(transport.events.some((e) => e.t === "check")).toBe(false);
  });

  it("withChecks: a summary without counts or runtime (rt.summary() threw) stays as it was", () => {
    const e: Ev = { t: "summary", counts: { decisions: 1 } };
    withChecks(e, VS);
    expect(e).toEqual({ t: "summary", counts: { decisions: 1, checks: VS.checks, checksByRoute: VS.checksByRoute, fixes: VS.fixes } });
    const bare: Ev = { t: "summary" };
    withChecks(bare, VS);
    expect(bare).toEqual({ t: "summary" });
    withChecks(e, undefined);
    expect(e.counts.checks).toEqual(VS.checks);
  });

  it("the console says once per page what telemetry sends of the checks, only when telemetry is on", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const off = setup({ mode: undefined });
    rts.push(off.rt);
    follow(off.rt, ctl(() => null));
    expect(info.mock.calls.flat()).not.toContain(VISUAL_TELEMETRY_NOTICE);
    const { rt } = tsetup();
    follow(rt, ctl(() => null));
    const { rt: rt2 } = tsetup();
    follow(rt2, ctl(() => null));
    expect(info.mock.calls.flat().filter((m) => m === VISUAL_TELEMETRY_NOTICE)).toHaveLength(1);
  });

  it("the bridge reads the runtime's telemetry by this name (renaming it fails here)", () => {
    const { rt } = tsetup();
    expect("telemetry" in rt).toBe(true);
    expect(typeof (rt.telemetry as unknown as { push?: unknown }).push).toBe("function");
  });
});

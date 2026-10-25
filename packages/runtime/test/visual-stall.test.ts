// @vitest-environment happy-dom
// request-stalled (docs/runtime/VISUAL.md 3.24, issue 94): a measured check, never a situation. A fetch or XHR
// request pending past visual.checks.stallMs (default 15 s) is reported once, with the control the page disabled or
// marked busy around its start if that control is still busy; long-lived requests (a learned background schedule, an
// endpoint that usually takes that long) are not checked. All timing on the injected FakeClock.
import { afterEach, describe, expect, it } from "vitest";
import type { CheckFinding } from "../src/types.js";
import type { VisualHost } from "../src/visual/host.js";
import type { PendingRequest } from "../src/visual/checks/stall.js";
import { parseSig, stallDraft } from "../src/visual/checks/stall.js";
import { Visual, KINDS, LIGHT, resolveCfg } from "../src/visual/engine.js";
import { hostFor } from "../src/visual/bridge.js";
import { FakeClock, setup } from "./helpers.js";

const realRect = document.documentElement.getBoundingClientRect.bind(document.documentElement);
afterEach(() => {
  document.documentElement.getBoundingClientRect = realRect;
  document.body.innerHTML = "";
  delete (document as unknown as { visibilityState?: string }).visibilityState;
});

function withLayout(): void {
  const rect = { width: 1024, height: 768, top: 0, left: 0, right: 1024, bottom: 768, x: 0, y: 0, toJSON: () => ({}) };
  document.documentElement.getBoundingClientRect = () => rect as DOMRect;
}

function host(clock: FakeClock, pending: () => PendingRequest[], found: CheckFinding[], mode: "observe" | "off" = "observe"): VisualHost {
  return {
    clock,
    global: window as unknown as Record<string, unknown>,
    seed: "s",
    mode: () => mode,
    sampled: () => true,
    active: () => true,
    inflight: () => pending().length,
    pending,
    errors: () => 0,
    describe: (el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim()}"`,
    route: () => "/",
    report: (f) => void found.push(f),
    note: () => undefined,
    audit: () => undefined,
  };
}

const WEATHER: PendingRequest = { id: "7", sig: "GET api.weather.test/v1/forecast", start: 1000 };

describe("request-stalled verdict and wording (VISUAL.md 3.24)", () => {
  it("is a v1-style kind, near-free (light tier), on by default, stallMs 15 s clamped", () => {
    expect(KINDS).toContain("request-stalled");
    expect(LIGHT.has("request-stalled")).toBe(true);
    expect(resolveCfg({}, null)).toMatchObject({ stallMs: 15_000, checks: { "request-stalled": true } });
    expect(resolveCfg({ checks: { stallMs: 20_000 } }, null).stallMs).toBe(20_000);
    expect(resolveCfg({ checks: { stallMs: 5 } }, null).stallMs).toBe(1000);
    expect(resolveCfg({ checks: { "request-stalled": false } }, null).checks["request-stalled"]).toBe(false);
  });

  it("parses method, host and path; same-origin requests get the page's host", () => {
    expect(parseSig("GET api.weather.test/v1/forecast", "shop.test")).toEqual({ method: "GET", host: "api.weather.test", path: "/v1/forecast" });
    expect(parseSig("POST /api/orders/:id", "shop.test")).toEqual({ method: "POST", host: "shop.test", path: "/api/orders/:id" });
    expect(parseSig("GET api.weather.test", "shop.test")).toEqual({ method: "GET", host: "api.weather.test", path: "/" });
  });

  it("names the request, how long, the threshold and the busy control; measured values, never a probability", () => {
    const btn = document.createElement("button");
    const d = stallDraft({ req: WEATHER, pageHost: "shop.test", now: 16_200, stallMs: 15_000, control: { el: btn, name: 'button "Get weather"', state: "disabled", since: 1000 }, watched: true });
    expect(d).toMatchObject({ kind: "request-stalled", severity: "high", el: btn, key: "request-stalled|7", measured: { method: "GET", host: "api.weather.test", path: "/v1/forecast", pendingMs: 15_200, control: "disabled" } });
    expect(d.text).toBe('GET api.weather.test/v1/forecast has been pending for 15.2 s (threshold 15.0 s), and button "Get weather", which became disabled 0.0 s after it started, still is: the page is waiting on a request that has not answered.');
    expect(d.fixText).toContain("AbortSignal.timeout");
    const none = stallDraft({ req: WEATHER, pageHost: "shop.test", now: 16_000, stallMs: 15_000, control: null, watched: true });
    expect(none).toMatchObject({ severity: "medium", el: null, target: "GET api.weather.test/v1/forecast", measured: { control: "none" } });
    expect(none.text).toContain("no control the page disabled or marked busy since it started is still so");
    expect(stallDraft({ req: WEATHER, pageHost: "", now: 16_000, stallMs: 15_000, control: null, watched: false }).measured.control).toBe("not watched");
  });
});

describe("request-stalled in the engine (VISUAL.md 3.24, 8)", () => {
  it("the reporter's case: a click disables the button, the request never answers; one high finding after 15 s, with the button", async () => {
    withLayout();
    const clock = new FakeClock();
    const found: CheckFinding[] = [];
    let pending: PendingRequest[] = [];
    const v = new Visual(host(clock, () => pending, found), { on: true }, [], false);
    document.body.innerHTML = `<button id="go">Get weather</button><button id="other" disabled>Old</button>`;
    await clock.advance(500);
    // the handler: disable the button, show a spinner, send
    (document.getElementById("go") as HTMLButtonElement).disabled = true;
    pending = [{ ...WEATHER, start: clock.now() }];
    await clock.advance(14_000);
    expect(found).toHaveLength(0);
    await clock.advance(1_200);
    expect(found).toHaveLength(1);
    const f = found[0];
    expect(f).toMatchObject({ source: "check", basis: "measurement", kind: "request-stalled", severity: "high", target: 'button "Get weather"', measured: { host: "api.weather.test", control: "disabled" }, threshold: { value: 15_000 } });
    expect(f.message.startsWith("[GenClass] Check (measured): GET api.weather.test/v1/forecast has been pending for 15.")).toBe(true);
    expect(f.details).toContain("This is a measured check with a fixed threshold, not a model finding.");
    expect(f.element()).toBe(document.getElementById("go"));
    // once per request, however long it stays pending
    await clock.advance(60_000);
    expect(found).toHaveLength(1);
    expect(v.summary()?.visual.checks["request-stalled"]).toBe(1);
    v.stop();
  });

  it("a control re-enabled before the threshold, or one disabled long before the request, is not named", async () => {
    withLayout();
    const clock = new FakeClock();
    const found: CheckFinding[] = [];
    let pending: PendingRequest[] = [];
    const v = new Visual(host(clock, () => pending, found), { on: true }, [], false);
    document.body.innerHTML = `<button id="a">A</button><div id="b">B</div>`;
    await clock.advance(100);
    (document.getElementById("b") as HTMLElement).setAttribute("aria-busy", "true"); // busy long before
    await clock.advance(5000);
    (document.getElementById("a") as HTMLButtonElement).disabled = true;
    pending = [{ ...WEATHER, start: clock.now() }];
    await clock.advance(3000);
    (document.getElementById("a") as HTMLButtonElement).disabled = false; // recovered
    await clock.advance(13_000);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "medium", measured: { control: "none" }, target: "GET api.weather.test/v1/forecast" });
    v.stop();
  });

  it("aria-busy counts; stallMs is configurable; answered requests and ignored hosts are not reported", async () => {
    withLayout();
    const clock = new FakeClock();
    const found: CheckFinding[] = [];
    let pending: PendingRequest[] = [];
    const v = new Visual(host(clock, () => pending, found), { on: true, checks: { stallMs: 5000 }, ignore: ["cdn.ads.test"] }, [], false);
    // a div: happy-dom hands out a proxy for a <form> that is not the mutation record's target
    document.body.innerHTML = `<div id="f"><button>Save</button></div>`;
    await clock.advance(100);
    const t = clock.now();
    (document.getElementById("f") as HTMLElement).setAttribute("aria-busy", "true");
    pending = [
      { id: "1", sig: "POST /api/save", start: t },
      { id: "2", sig: "GET cdn.ads.test/slot", start: t },
      { id: "3", sig: "GET /api/fast", start: t },
    ];
    await clock.advance(2000);
    pending = pending.filter((r) => r.id !== "3"); // answered
    await clock.advance(3500);
    expect(found.map((f) => f.measured.path)).toEqual(["/api/save"]);
    expect(found[0].measured).toMatchObject({ control: "aria-busy", host: window.location.host });
    v.stop();
  });

  it("off in mode off and while the tab is hidden (reported once visible again); off when the kind is turned off", async () => {
    withLayout();
    const clock = new FakeClock();
    const found: CheckFinding[] = [];
    const pending = [{ ...WEATHER, start: 1000 }];
    const off = new Visual(host(clock, () => pending, found, "off"), { on: true }, [], false);
    await clock.advance(20_000);
    expect(found).toHaveLength(0);
    off.stop();
    const disabled = new Visual(host(clock, () => pending, found), { on: true, checks: { "request-stalled": false } }, [], false);
    await clock.advance(20_000);
    expect(found).toHaveLength(0);
    disabled.stop();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const v = new Visual(host(clock, () => pending, found), { on: true }, [], false);
    await clock.advance(20_000);
    expect(found).toHaveLength(0);
    delete (document as unknown as { visibilityState?: string }).visibilityState;
    await clock.advance(2500);
    expect(found).toHaveLength(1);
    v.stop();
  });

  it("stop() ends the timer; no runtime (checkPage) means no stall timer at all", async () => {
    withLayout();
    const clock = new FakeClock();
    const v = new Visual(host(clock, () => [], []), { on: true }, [], false);
    expect(clock.pending).toBe(1);
    v.stop();
    expect(clock.pending).toBe(0);
    const h = host(clock, () => [], []);
    delete h.pending;
    const w = new Visual(h, { on: true }, [], false);
    expect(clock.pending).toBe(0);
    w.stop();
  });
});

describe("request-stalled: what the bridge hands over (long-lived requests excluded)", () => {
  it("fetch requests in flight, without a learned background schedule or an endpoint whose p95 is past stallMs", async () => {
    const s = setup({ mode: undefined });
    s.server.on("GET", "/poll", { status: 200, body: {}, latency: 30_000 });
    s.server.on("GET", "/slow-report", { status: 200, body: {}, latency: 20_000 });
    s.server.on("GET", "/v1/forecast", { status: 200, body: {}, latency: 600_000 });
    // a long poll on a schedule: background requests (no user action) every ~30 s
    for (let i = 0; i < 5; i++) {
      void s.fetch("/poll");
      await s.clock.advance(30_000);
    }
    // an endpoint that usually takes 20 s, sent on clicks (not a schedule)
    const click = (fn: () => unknown) => s.rt.user({ kind: "click", target: 'button "Report"' }, fn);
    for (let i = 0; i < 5; i++) {
      let p!: Promise<Response>;
      click(() => (p = s.fetch("/slow-report")));
      await s.clock.advance(20_100 + i * 3000);
      await p;
    }
    void s.fetch("/poll");
    click(() => s.fetch("/slow-report"));
    void s.fetch("https://api.weather.test/v1/forecast");
    const h = hostFor(s.rt, () => "x", (p) => p);
    expect(h.pending!(15_000).map((r) => r.sig)).toEqual(["GET api.weather.test/v1/forecast"]);
    // with a threshold past the slow endpoint's usual latency, it is checked again
    expect(h.pending!(30_000).map((r) => r.sig).sort()).toEqual(["GET /slow-report", "GET api.weather.test/v1/forecast"]);
  });
});

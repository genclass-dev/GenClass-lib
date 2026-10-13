// @vitest-environment happy-dom
// /auto's start with sinks by name (src/cdn/auto-start.ts → applySinks in src/cdn/sinks.ts). It runs while the app's
// entry module is being evaluated (init writes the /auto import as the entry's first line), before GenClass.init's
// own guard, so a page configuration it cannot use must never throw into the app. Telemetry and the model are off.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAuto } from "../src/cdn/auto-start.js";
import { GenClass } from "../src/index.js";

const W = window as unknown as Record<string, unknown>;
const SAFE = { telemetry: false, model: false as const, report: "silent" as const, autoState: false };
const couldNotStart = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.some((c) => /^\[GenClass\] Could not start \(/.test(String(c[0])));

afterEach(() => {
  GenClass.destroy();
  delete W.GENCLASS_CONFIG;
  vi.restoreAllMocks();
});

describe("startAuto with sinks by name (GENCLASS_CONFIG)", () => {
  it("a requests.ignore that is not a list, next to a webhook name, does not throw: GenClass says so and the app runs without it", () => {
    for (const ignore of [/\/beacon/, () => true]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      W.GENCLASS_CONFIG = { ...SAFE, requests: { ignore }, sinks: ["webhook:/genclass"] };
      let rt: unknown;
      expect(() => (rt = startAuto())).not.toThrow();
      expect(rt).toBeTruthy();
      expect(couldNotStart(warn)).toBe(true); // the same as without sinks
      GenClass.destroy();
      warn.mockRestore();
    }
  });

  it("a valid ignore list keeps its own matchers and gains the webhook's endpoint; the runtime starts", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    W.GENCLASS_CONFIG = { ...SAFE, requests: { ignore: ["/beacon"] }, sinks: ["webhook:/genclass", "sentry"] };
    let rt: unknown;
    expect(() => (rt = startAuto())).not.toThrow();
    expect(rt).toBe(GenClass.runtime);
    expect(couldNotStart(warn)).toBe(false);
  });

  it("a sinks value that is not a list is left out and never thrown over; the runtime starts", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const sinks of ["sentry", 42, { send: 1 }, null]) {
      W.GENCLASS_CONFIG = { ...SAFE, sinks };
      expect(() => startAuto()).not.toThrow();
      expect(GenClass.runtime).toBeTruthy();
      GenClass.destroy();
    }
    expect(couldNotStart(warn)).toBe(false);
  });
});

// Device floor for the model (OPTIONS-SPEC §4.15, `model.loadIf`). The model is about 10 MB on the wire and the
// renderer holds 190 to 280 MB more while it is loaded (package README, "Costs"), so by default it is not loaded on
// devices that report 2 GB of memory or less, nor on Save-Data connections. The runtime then keeps observing without
// a model (status, devtools; nothing is detected or prevented) and prints one console line saying so.
// `model: { loadIf: () => true }` forces the load. `loadIf` never affects a decision.
//
// navigator.deviceMemory is quantised to powers of two (0.25, 0.5, 1, 2, 4, 8), so a floor of 4 GB skips exactly the
// devices reporting 2 GB or less; browsers that do not report it (Safari, Firefox) count as allowed.

import type { DeviceEnv, ModelOptions } from "../types.js";

/** The default `model.loadIf`: no model on devices reporting under 4 GB (i.e. 2 GB or less) or with Save-Data on. */
export const DEFAULT_LOAD_IF: { minDeviceMemoryGB: number; saveData: "skip" } = { minDeviceMemoryGB: 4, saveData: "skip" };

/** What the page can tell about the device (OPTIONS-SPEC §4.15). Unknown values stay undefined (= allowed). */
export function deviceEnv(g: Record<string, unknown>): DeviceEnv {
  const nav = (g.navigator ?? {}) as {
    deviceMemory?: number;
    hardwareConcurrency?: number;
    gpu?: unknown;
    connection?: { saveData?: boolean; effectiveType?: string };
    userAgentData?: { mobile?: boolean };
  };
  const env: DeviceEnv = { webgpu: !!nav.gpu };
  if (typeof nav.userAgentData?.mobile === "boolean") env.mobile = nav.userAgentData.mobile;
  if (typeof nav.deviceMemory === "number") env.deviceMemoryGB = nav.deviceMemory;
  if (typeof nav.hardwareConcurrency === "number") env.cores = nav.hardwareConcurrency;
  if (typeof nav.connection?.saveData === "boolean") env.saveData = nav.connection.saveData;
  if (typeof nav.connection?.effectiveType === "string") env.effectiveType = nav.connection.effectiveType;
  return env;
}

export type LoadIfResult = "load" | "lazy" | { skip: "device-memory" | "save-data" | "loadIf" };

/** loadIf → "load" | "lazy" | skip reason. A throwing predicate counts as allowed. */
export function evalLoadIf(m: ModelOptions, env: DeviceEnv, warn: (s: string) => void): LoadIfResult {
  const li = m.loadIf ?? DEFAULT_LOAD_IF;
  if (typeof li === "function") {
    try {
      const v = li(env);
      return v === "lazy" ? "lazy" : v === false ? { skip: "loadIf" } : "load";
    } catch (e) {
      warn(`model.loadIf threw (${(e as Error)?.message ?? e}); loading anyway.`);
      return "load";
    }
  }
  if (typeof li.minDeviceMemoryGB === "number" && typeof env.deviceMemoryGB === "number" && env.deviceMemoryGB < li.minDeviceMemoryGB) return { skip: "device-memory" };
  const sd = li.saveData ?? "skip";
  if (env.saveData === true && sd === "skip") return { skip: "save-data" };
  if (env.saveData === true && sd === "lazy") return "lazy";
  return "load";
}

/** The memory floor (GB) a `model` option applies: its `loadIf.minDeviceMemoryGB`, the default's when unset. */
export function memoryFloor(m: ModelOptions | undefined): number | undefined {
  const li = m?.loadIf ?? DEFAULT_LOAD_IF;
  return typeof li === "object" && li !== null && typeof li.minDeviceMemoryGB === "number" ? li.minDeviceMemoryGB : undefined;
}

/** The one console line printed when the model is not loaded on this device (status.reason → sentence). */
export function skippedMessage(reason: string | undefined, env: DeviceEnv, floorGB?: number): string {
  const floor = typeof floorGB === "number" ? floorGB : DEFAULT_LOAD_IF.minDeviceMemoryGB;
  const why =
    reason === "device-memory"
      ? `this device reports ${typeof env.deviceMemoryGB === "number" ? `${env.deviceMemoryGB} GB` : "less"} of memory and model.loadIf asks for at least ${floor} GB`
      : reason === "save-data"
        ? "the browser asks to save data (Save-Data)"
        : reason === "loadIf"
          ? "model.loadIf returned false"
          : `${reason ?? "skipped"}`;
  return `[GenClass] Model not loaded: ${why}. GenClass keeps observing (status, devtools) but detects and prevents nothing on this device. To load it anyway: GenClass.init({ model: { loadIf: () => true } }).`;
}

// @genclass/runtime/sinks/datadog: GenClass's findings in Datadog RUM. Detections and interventions go to Error
// Tracking (`DD_RUM.addError`, so they alert and group like errors); undos, breaker trips and runtime errors are
// custom actions (`DD_RUM.addAction("genclass_<kind>")`). Zero dependencies: it uses the SDK the page already has
// (`window.DD_RUM`, as the CDN snippets set it; the async stub's `onReady` is honoured) or the one you pass
// (`datadog({ rum: datadogRum })` with @datadog/browser-rum). Never throws; without an SDK it sends nothing.

import type { SinkObject, SinkRecord } from "../types.js";
import { type AdapterOptions, DEFAULT_KINDS, flatten, globalOf, overCap, signature, titleOf } from "./common.js";

/** The part of the Datadog RUM browser SDK the adapter uses. */
export interface DatadogRumLike {
  addAction?(name: string, context?: object): unknown;
  addError?(error: unknown, context?: object): unknown;
  /** The async CDN stub: runs the callback once the SDK has loaded. */
  onReady?(callback: () => void): unknown;
}

export interface DatadogSinkOptions extends AdapterOptions {
  /** The SDK (default: `globalThis.DD_RUM`, read on every record). */
  rum?: DatadogRumLike;
  /** "error" (default): detections and interventions as RUM errors (Error Tracking); "action": everything as custom actions. */
  as?: "error" | "action";
}

/**
 * A sink that files every detection and intervention as a RUM error named `GenClassDetection` / `GenClassIntervention`
 * (message: the console line) and every undo, breaker trip and runtime error as the custom action `genclass_<kind>`,
 * each with the record's fields under the context key `genclass` (plus `genclass.signature`, a per-bug key).
 */
export function datadog(o: DatadogSinkOptions = {}): SinkObject {
  const seen = new Map<string, number>();
  const as = o.as ?? "error";
  return {
    kinds: o.kinds ?? DEFAULT_KINDS,
    sampleRate: o.sampleRate,
    evidence: o.evidence ?? true,
    send(r: SinkRecord): void {
      try {
        const rum = o.rum ?? (globalOf(o).DD_RUM as DatadogRumLike | undefined);
        if (!rum || typeof rum !== "object") return;
        if (overCap(seen, r, o.maxPerSignature)) return;
        const run = () => {
          try {
            const context = { genclass: { ...flatten(r), signature: signature(r) } };
            if (as === "error" && (r.kind === "detection" || r.kind === "intervention") && typeof rum.addError === "function") {
              const err = new Error(titleOf(r));
              err.name = r.kind === "detection" ? "GenClassDetection" : "GenClassIntervention";
              rum.addError(err, context);
            } else if (typeof rum.addAction === "function") rum.addAction(`genclass_${r.kind}`, context);
          } catch {
            /* never into the app */
          }
        };
        if (typeof rum.addAction !== "function" && typeof rum.addError !== "function" && typeof rum.onReady === "function") rum.onReady(run);
        else run();
      } catch {
        /* never into the app */
      }
    },
  };
}

export default datadog;

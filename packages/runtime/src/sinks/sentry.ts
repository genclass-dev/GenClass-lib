// @genclass/runtime/sinks/sentry: GenClass's findings as Sentry events (captureMessage, level "warning", one issue
// per bug) or breadcrumbs. Zero dependencies: it uses the SDK the page already has (`window.Sentry`, which the
// Sentry loader and CDN bundles set) or the one you pass (`sentry({ sentry: Sentry })` with the npm SDK, which sets
// no global). Looked up on every record, so an SDK that loads later still gets them. Never throws; without an SDK it
// sends nothing.

import type { SinkObject, SinkRecord } from "../types.js";
import { type AdapterOptions, DEFAULT_KINDS, flatten, globalOf, overCap, signature, titleOf } from "./common.js";

export type SentryLevel = "fatal" | "error" | "warning" | "log" | "info" | "debug";

/** The part of the Sentry SDK the adapter uses (@sentry/browser ≥ 7 and the loader / CDN bundles). */
export interface SentryLike {
  captureMessage?(message: string, context?: { level?: SentryLevel; tags?: Record<string, string | number | boolean>; extra?: Record<string, unknown>; fingerprint?: string[] }): unknown;
  addBreadcrumb?(breadcrumb: { category?: string; type?: string; level?: SentryLevel; message?: string; data?: Record<string, unknown> }): unknown;
}

export interface SentrySinkOptions extends AdapterOptions {
  /** The SDK (default: `globalThis.Sentry`, read on every record). */
  sentry?: SentryLike;
  /** "event" (default): one captureMessage per record, grouped per bug. "breadcrumb": addBreadcrumb only (no issue, no quota). */
  as?: "event" | "breadcrumb";
  /** Level of the events and breadcrumbs (default "warning"). */
  level?: SentryLevel;
}

/**
 * A sink that forwards every detection, intervention, undo, breaker trip and runtime error to Sentry: tags
 * `genclass` (the diagnosis), `genclass.kind`, `genclass.mode`, `genclass.action`, `genclass.trigger` and
 * `genclass.route`; the record (message, subject, timeline, probabilities, session id and tags) under `extra.genclass`;
 * a fingerprint per kind, trigger, diagnosis, action and subject shape.
 */
export function sentry(o: SentrySinkOptions = {}): SinkObject {
  const seen = new Map<string, number>();
  const as = o.as ?? "event";
  const level = o.level ?? "warning";
  return {
    kinds: o.kinds ?? DEFAULT_KINDS,
    sampleRate: o.sampleRate,
    evidence: true,
    send(r: SinkRecord): void {
      try {
        const sdk = o.sentry ?? (globalOf(o).Sentry as SentryLike | undefined);
        if (!sdk || typeof sdk !== "object") return;
        if (overCap(seen, r, o.maxPerSignature)) return;
        const message = titleOf(r);
        const data = flatten(r);
        if (as === "breadcrumb" || typeof sdk.captureMessage !== "function") {
          if (typeof sdk.addBreadcrumb === "function") sdk.addBreadcrumb({ category: "genclass", type: "info", level, message, data });
          return;
        }
        const tags: Record<string, string | number | boolean> = { genclass: r.diagnosis ?? r.kind, "genclass.kind": r.kind, "genclass.mode": r.mode };
        if (r.action) tags["genclass.action"] = r.action;
        if (r.trigger) tags["genclass.trigger"] = r.trigger;
        if (r.route) tags["genclass.route"] = r.route;
        sdk.captureMessage(message, { level, tags, extra: { genclass: data }, fingerprint: ["genclass", signature(r)] });
      } catch {
        /* never into the app */
      }
    },
  };
}

export default sentry;

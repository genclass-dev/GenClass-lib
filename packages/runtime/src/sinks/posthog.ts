// @genclass/runtime/sinks/posthog: GenClass's findings as PostHog events (`posthog.capture("genclass_detection",
// { ... })`, one event name per record kind). Zero dependencies: it uses the client the page already has
// (`window.posthog`, as the snippet sets it; the pre-init stub queues too) or the one you pass
// (`posthog({ posthog })` with the npm package, which sets no global). Never throws; without a client it sends nothing
// and says so once on the console.

import type { SinkObject, SinkRecord } from "../types.js";
import { type AdapterOptions, DEFAULT_KINDS, flatten, globalOf, overCap, signature, warnOnce } from "./common.js";

/** The part of posthog-js the adapter uses. */
export interface PostHogLike {
  capture?(event: string, properties?: Record<string, unknown>): unknown;
}

export interface PostHogSinkOptions extends AdapterOptions {
  /** The client (default: `globalThis.posthog`, read on every record). */
  posthog?: PostHogLike;
  /** Event name prefix (default "genclass_"): genclass_detection, genclass_intervention, genclass_undo, genclass_breaker, genclass_error. */
  prefix?: string;
}

/**
 * A sink that captures one PostHog event per detection, intervention, undo, breaker trip and runtime error, named
 * `genclass_<kind>`, with the record's fields as properties (kind, diagnosis, p, action, tier, trigger, mode, route,
 * label, reason, changed, message, subject, timeline, sessionId, tags, correlationId) plus `signature`, a per-bug key.
 */
export function posthog(o: PostHogSinkOptions = {}): SinkObject {
  const seen = new Map<string, number>();
  const prefix = o.prefix ?? "genclass_";
  const missing = warnOnce(
    o,
    `The PostHog sink found no PostHog client (window.posthog) for a record, so it was dropped (and later ones are until there is one). posthog-js from npm sets no global: pass it, posthog({ posthog }) (npx @genclass/runtime init --sink posthog writes that), or set window.posthog = posthog.`,
  );
  return {
    kinds: o.kinds ?? DEFAULT_KINDS,
    sampleRate: o.sampleRate,
    evidence: o.evidence ?? true,
    send(r: SinkRecord): void {
      try {
        const client = o.posthog ?? (globalOf(o).posthog as PostHogLike | undefined);
        if (!client) return missing();
        if (typeof client.capture !== "function") return;
        if (overCap(seen, r, o.maxPerSignature)) return;
        client.capture(`${prefix}${r.kind}`, { ...flatten(r), signature: signature(r) });
      } catch {
        /* never into the app */
      }
    },
  };
}

export default posthog;

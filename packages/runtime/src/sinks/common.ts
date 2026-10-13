// Shared pieces of the sink adapters (@genclass/runtime/sinks/*, OPTIONS-SPEC §4.11): the SDK lookup on the page, a
// grouping signature built from a record's own fields, a flat property bag and a per-session cap per signature.
//
// Invariants: an adapter never throws into the app (every send is wrapped), never imports a vendor SDK (it uses the
// one the page already has, found at send time, or the one passed in), and never reads page text: everything it
// forwards is the SinkRecord the runtime handed it (redacted evidence included, OPTIONS-SPEC §4.10).

import type { SinkKind, SinkRecord } from "../types.js";

/** Record kinds the tool adapters forward by default: everything but the session summary. */
export const DEFAULT_KINDS: SinkKind[] = ["detection", "intervention", "undo", "breaker", "error"];

/** Default `maxPerSignature` of the tool adapters. */
export const DEFAULT_MAX_PER_SIGNATURE = 10;

/** Signatures tracked per session for the cap; beyond that, records pass. */
const MAX_SIGNATURES = 500;

/** Options every tool adapter takes. */
export interface AdapterOptions {
  /** Record kinds to forward (default: detection, intervention, undo, breaker, error; never the session summary). */
  kinds?: SinkKind[];
  /** Session-deterministic sampling (SinkObject.sampleRate); interventions, undos and breaker trips are never dropped. */
  sampleRate?: number;
  /**
   * At most this many records per signature (kind, trigger, diagnosis, action and the subject's shape) per page
   * load, so a failure storm does not burn an event quota (default 10; 0 = no cap).
   */
  maxPerSignature?: number;
  /** Where the SDK global is looked up (default `globalThis`). */
  global?: object;
}

export const globalOf = (o: { global?: object } | undefined): Record<string, unknown> => (o?.global ?? globalThis) as Record<string, unknown>;

/** A grouping key with op ids and numbers normalised, so repeats of one bug land in one issue. */
export function signature(r: SinkRecord): string {
  const subject = (r.evidence?.subject ?? "").replace(/#\d+/g, "#").replace(/\d+(\.\d+)?/g, "n");
  return [r.kind, r.trigger ?? "", r.diagnosis ?? "", r.action ?? "", subject].join("|");
}

/** The one-line title: the console line the runtime printed for this record, else one built from its fields. */
export function titleOf(r: SinkRecord): string {
  if (r.evidence?.message) return r.evidence.message;
  const what = r.diagnosis ? `${r.diagnosis} ${r.trigger ?? ""}`.trim() : r.kind;
  return `[GenClass] ${r.kind}: ${what}${r.action ? ` (${r.action})` : ""}`;
}

/** The record's fields as one flat, JSON-safe object (evidence lifted to message / subject / timeline). */
export function flatten(r: SinkRecord): Record<string, unknown> {
  const { evidence, ...rest } = r;
  const out: Record<string, unknown> = { ...rest };
  if (evidence) {
    if (evidence.message) out.message = evidence.message;
    if (evidence.subject) out.subject = evidence.subject;
    if (evidence.timeline) out.timeline = evidence.timeline;
  }
  return out;
}

/** Per-session cap per signature: true when this record is over the cap and should be dropped. */
export function overCap(seen: Map<string, number>, r: SinkRecord, max: number | undefined): boolean {
  const lim = max === undefined ? DEFAULT_MAX_PER_SIGNATURE : max;
  if (!(lim > 0)) return false;
  const k = signature(r);
  const n = (seen.get(k) ?? 0) + 1;
  if (!seen.has(k) && seen.size >= MAX_SIGNATURES) return false;
  seen.set(k, n);
  return n > lim;
}

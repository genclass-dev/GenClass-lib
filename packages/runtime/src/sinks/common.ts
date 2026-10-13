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
  /**
   * Send the redacted evidence: the console line, the subject and the timeline (default true). Timeline lines can hold
   * short fragments of app data (a store value summary, an error message, text typed into an ordinary input); false
   * sends the structured fields only (kind, diagnosis, p, action, route, ...).
   */
  evidence?: boolean;
  /** Where the SDK global is looked up (default `globalThis`). */
  global?: object;
}

export const globalOf = (o: { global?: object } | undefined): Record<string, unknown> => (o?.global ?? globalThis) as Record<string, unknown>;

/**
 * A function that, the first time it is called, prints one console warning (on the adapter's global) that a record
 * arrived and the adapter found no SDK, so it was dropped, and how to fix it. Later calls do nothing. Never throws.
 */
export function warnOnce(o: { global?: object } | undefined, message: string): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      (globalOf(o).console as { warn?: (...a: unknown[]) => void } | undefined)?.warn?.(`[GenClass] ${message}`);
    } catch {
      /* never into the app */
    }
  };
}

/**
 * Whether one path segment names an entity rather than a route: a UUID, long hex, a long token with letters and
 * digits, a short slug id ("tasks-1cam", "x7k2p", "PPBqWA9"; never "v2", "sha256" or "item42"), or anything holding
 * an "@" (an email). The main cases of util.ts isIdSegment, copied so that the adapters import nothing from the
 * runtime (an adapter's chunk stays its own, test/bundle.test.ts).
 */
export function idLike(seg: string): boolean {
  if (/@|%40/i.test(seg)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^(?=[0-9a-f]*\d)[0-9a-f]{8,}$/i.test(seg)) return true;
  if (!/^[\w-]+$/.test(seg) || !/\d/.test(seg) || !/[A-Za-z]/.test(seg)) return false;
  if (seg.length >= 16) return true;
  if (seg.length < 4 || /^v\d+([a-z]+\d*)?$/i.test(seg)) return false;
  if (seg.length >= 6 && /[a-z]/.test(seg) && /[A-Z]/.test(seg)) return true;
  return seg.split(/[-_]/).some((p) => /\d/.test(p) && /[A-Za-z]/.test(p) && (/^\d/.test(p) || (p.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g) ?? []).length >= 2));
}

/**
 * A grouping key with op ids, numbers and id-like path segments (UUIDs, hex, tokens, slugs, emails: `idLike`)
 * normalised, so repeats of one bug on different entities land in one issue and share one `maxPerSignature` cap.
 */
export function signature(r: SinkRecord): string {
  const subject = (r.evidence?.subject ?? "")
    .replace(/\/([^\s/?#()]+)/g, (m, seg: string) => (idLike(seg) ? "/:id" : m))
    .replace(/#\d+/g, "#")
    .replace(/\d+(\.\d+)?/g, "n");
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

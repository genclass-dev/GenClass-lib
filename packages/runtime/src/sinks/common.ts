// Shared pieces of the sink adapters (@genclass/runtime/sinks/*, OPTIONS-SPEC §4.11): the global lookup, a grouping
// signature built from a record's own fields and a per-session cap per signature.
//
// Invariants: an adapter never throws into the app (every send is wrapped), imports nothing from the runtime but
// types, and never reads page text: everything it forwards is the SinkRecord the runtime handed it (redacted evidence
// included, OPTIONS-SPEC §4.10).

import type { SinkRecord } from "../types.js";

/** Default `maxPerSignature` of the webhook adapter. */
export const DEFAULT_MAX_PER_SIGNATURE = 10;

/** Signatures tracked per session for the cap; beyond that, records pass. */
const MAX_SIGNATURES = 500;

export const globalOf = (o: { global?: object } | undefined): Record<string, unknown> => (o?.global ?? globalThis) as Record<string, unknown>;

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
 * normalised, so repeats of one bug on different entities share one `maxPerSignature` cap.
 */
export function signature(r: SinkRecord): string {
  const subject = (r.evidence?.subject ?? "")
    .replace(/\/([^\s/?#()]+)/g, (m, seg: string) => (idLike(seg) ? "/:id" : m))
    .replace(/#\d+/g, "#")
    .replace(/\d+(\.\d+)?/g, "n");
  return [r.kind, r.trigger ?? "", r.diagnosis ?? "", r.action ?? "", subject].join("|");
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

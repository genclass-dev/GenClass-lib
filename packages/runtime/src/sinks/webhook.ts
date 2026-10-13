// @genclass/runtime/sinks/webhook: batched POSTs of GenClass's records to a URL the app owns. What is sent is the
// records and nothing else: each is the SinkRecord the runtime built (kind, diagnosis, probability, action, tier,
// trigger, mode, route, label, reason, changed paths, session id and tags, and the redacted evidence: the console
// line, the subject and the timeline), wrapped as { schema: "genclass-sink/1", version, records }. The adapter reads
// nothing from the page itself. The evidence is the text GenClass prints, with URL query and fragment values as "…":
// its timeline lines can hold short fragments of app data (a store value summary, an error message, text typed into
// an ordinary input; secret-named fields are "[redacted]"), and `evidence: false` leaves it out. Never the full
// situation text the model read, never request or response bodies, headers or cookies (beyond what the browser itself
// sends to your own origin).
//
// Transport: navigator.sendBeacon (which GenClass never wraps, and which survives page exit), else fetch with
// keepalive. The body is JSON in both cases, sent as text/plain (a CORS simple request: no preflight); parse it as
// JSON on the server. Headers force the fetch path (sendBeacon takes none). When the fetch path is used from a page
// where GenClass observes fetch, list the URL in `requests.ignore` so the sink's own POSTs are never decided about
// (the zero-code entries do this for `webhook:<url>`).
//
// Batching: records are sent `flushMs` after the first one queued, at `maxBatch` records, and on `flush()` (pagehide);
// a batch is split before it exceeds what sendBeacon / keepalive accept (64 KiB). Timers come from the Clock
// (default browserClock, the runtime's own; pass the test clock in tests). Never throws; send failures are dropped.

import { browserClock } from "../clock.js";
import type { Clock, SinkKind, SinkObject, SinkRecord } from "../types.js";
import { RUNTIME_VERSION } from "../version.js";
import { globalOf } from "./common.js";

export const WEBHOOK_SCHEMA = "genclass-sink/1";
/** keepalive fetch and sendBeacon refuse bodies over 64 KiB. */
export const WEBHOOK_MAX_BODY_BYTES = 60_000;

/** One POST body. */
export interface WebhookBatch {
  schema: typeof WEBHOOK_SCHEMA;
  /** @genclass/runtime version. */
  version: string;
  records: SinkRecord[];
}

export interface WebhookSinkOptions {
  /** Where to POST (same origin, or an endpoint of yours that allows the page's origin). */
  url: string;
  /** Record kinds to forward (default: all, the session summary included). */
  kinds?: SinkKind[];
  /** Session-deterministic sampling (SinkObject.sampleRate); interventions, undos and breaker trips are never dropped. */
  sampleRate?: number;
  /** Send this long after the first queued record (default 5,000 ms; at least 100). */
  flushMs?: number;
  /** Send once this many records are queued (default 50). */
  maxBatch?: number;
  /** Request headers (fetch only: sendBeacon cannot set any, so headers switch the transport to fetch). */
  headers?: Record<string, string>;
  /** Your own transport (tests, a queue of yours): gets the URL and the JSON body. */
  send?: (url: string, body: string) => unknown;
  /** The clock for the batch timer (default: the runtime's browserClock). */
  clock?: Clock;
  /**
   * Send the redacted evidence: the console line, the subject and the timeline (default true). Timeline lines can hold
   * short fragments of app data (a store value summary, an error message, text typed into an ordinary input); false
   * sends the structured fields only (kind, diagnosis, p, action, route, ...).
   */
  evidence?: boolean;
  /** Where navigator / fetch are looked up (default `globalThis`). */
  global?: object;
}

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** navigator.sendBeacon, else fetch keepalive (both looked up at send time). */
function defaultTransport(g: Record<string, unknown>, headers: Record<string, string> | undefined): (url: string, body: string) => unknown {
  return (url, body) => {
    if (!headers) {
      try {
        const nav = g.navigator as { sendBeacon?: (u: string, d?: string) => boolean } | undefined;
        if (nav && typeof nav.sendBeacon === "function" && nav.sendBeacon(url, body)) return true;
      } catch {
        /* fall back to fetch */
      }
    }
    const f = g.fetch as typeof fetch | undefined;
    if (typeof f !== "function") return undefined;
    return f(url, { method: "POST", body, headers: { "content-type": "text/plain;charset=UTF-8", ...(headers ?? {}) }, keepalive: true, cache: "no-store" });
  };
}

/**
 * A sink that POSTs batches of records to `url` (see the module header for the body and the transport). Every record
 * kind by default, the session summary included: one `summary` record per page load says how many detections and
 * interventions the session had.
 */
export function webhook(o: WebhookSinkOptions): SinkObject {
  const url = String(o?.url ?? "");
  const g = globalOf(o);
  const clock = o?.clock ?? browserClock;
  const flushMs = num(o?.flushMs, 100, 600_000, 5000);
  const maxBatch = Math.floor(num(o?.maxBatch, 1, 500, 50));
  const transport = typeof o?.send === "function" ? o.send : defaultTransport(g, o?.headers);
  let queue: SinkRecord[] = [];
  let timer: unknown = null;

  const post = (records: SinkRecord[]): void => {
    if (!records.length) return;
    const batch: WebhookBatch = { schema: WEBHOOK_SCHEMA, version: RUNTIME_VERSION, records };
    try {
      const res = transport(url, JSON.stringify(batch));
      if (res && typeof (res as Promise<unknown>).catch === "function") (res as Promise<unknown>).catch(() => undefined);
    } catch {
      /* a failed send is dropped */
    }
  };

  const drain = (): void => {
    if (timer !== null) {
      try {
        clock.clearTimeout(timer);
      } catch {
        /* ignore */
      }
      timer = null;
    }
    const all = queue;
    queue = [];
    // split before a body exceeds what sendBeacon / keepalive accept (the envelope is small; record sizes add up)
    let batch: SinkRecord[] = [];
    let bytes = 0;
    for (const r of all) {
      let n = 0;
      try {
        n = JSON.stringify(r).length + 1;
      } catch {
        continue; // not serialisable: skip the record rather than the batch
      }
      if (batch.length && bytes + n > WEBHOOK_MAX_BODY_BYTES) {
        post(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(r);
      bytes += n;
    }
    post(batch);
  };

  return {
    kinds: o?.kinds,
    sampleRate: o?.sampleRate,
    evidence: o?.evidence ?? true,
    send(r: SinkRecord): void {
      try {
        if (!url) return;
        queue.push(r);
        if (queue.length >= maxBatch) drain();
        else if (timer === null) timer = clock.setTimeout(drain, flushMs);
      } catch {
        /* never into the app */
      }
    },
    flush(): Promise<void> {
      try {
        drain();
      } catch {
        /* never into the app */
      }
      return Promise.resolve();
    },
  };
}

export default webhook;

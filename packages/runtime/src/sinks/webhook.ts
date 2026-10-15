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
// (the zero-code entries do this for `webhook:<url>`, as an exact match on the endpoint's origin and path).
//
// Batching: the runtime hands sinks their records in idle-time rounds (SinkDispatcher), and by default the records of
// one round go in one POST, sent in a microtask after the round. With a `clock` the batch waits `flushMs` after its
// first record instead, and goes at once when `maxBatch` records are queued. One POST holds at most `maxBatch` records
// and 32,000 UTF-8 bytes of them, and each round sends at most one: sendBeacon and keepalive fetch allow 64 KiB in
// flight per page, shared with the app's own beacons (often its analytics on pagehide), so GenClass never sends two
// half-budget bodies at once. What does not fit waits, oldest first, for the next round: with a clock `flushMs` later,
// without one the next round of records, or the previous POST settling when the transport says when (fetch, or your
// own `send` returning a promise). `flush()` (pagehide, or the tab hidden) sends one batch, the session summary first,
// and drops what is left. At most 500 records wait. Repeats of one bug are capped at `maxPerSignature` (10) per page
// load, so a failure storm is a few POSTs, not one per round. Never throws; send failures are dropped.
//
// Imports nothing from the runtime but types (the version is a build-time constant), so loading this adapter adds no
// shared chunk to an app's first load (test/bundle.test.ts).

import type { Clock, SinkKind, SinkObject, SinkRecord } from "../types.js";
import { DEFAULT_MAX_PER_SIGNATURE, globalOf, overCap } from "./common.js";

declare const __GENCLASS_PKG_VERSION__: string;
/** The @genclass/runtime version, defined at build time (tsup, vitest). */
const VERSION: string = typeof __GENCLASS_PKG_VERSION__ === "string" ? __GENCLASS_PKG_VERSION__ : "0.0.0";

export const WEBHOOK_SCHEMA = "genclass-sink/1";
/**
 * Most UTF-8 bytes of records in one POST body. keepalive fetch and sendBeacon refuse more than 64 KiB in flight per
 * page, shared with the app's own beacons, so a batch stays at about half of that.
 */
export const WEBHOOK_MAX_BODY_BYTES = 32_000;
/** Most records waiting for a later round; newer ones are dropped beyond it (the session summary always waits). */
export const WEBHOOK_MAX_QUEUED = 500;

/** UTF-8 length of a string (JSON.stringify output: lone surrogates are already escaped, so pairs count 2 + 2). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 || (c >= 0xd800 && c <= 0xdfff) ? 2 : 3;
  }
  return n;
}

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
  /** With `clock`: send this long after the first queued record (default 5,000 ms; at least 100). */
  flushMs?: number;
  /** Most records in one POST (default 50); with a `clock`, a batch this full goes at once instead of after `flushMs`. */
  maxBatch?: number;
  /**
   * At most this many records per signature (kind, trigger, diagnosis, action and the subject's shape; for a `check`
   * record its check kind and selector) per page load, so a failure storm does not flood your endpoint (default 10;
   * 0 = no cap). The session
   * `summary` record still counts every detection and intervention.
   */
  maxPerSignature?: number;
  /** Request headers (fetch only: sendBeacon cannot set any, so headers switch the transport to fetch). */
  headers?: Record<string, string>;
  /** Your own transport (tests, a queue of yours): gets the URL and the JSON body. */
  send?: (url: string, body: string) => unknown;
  /** A clock to batch over `flushMs` instead of per delivery round (your own, or the test clock). */
  clock?: Clock;
  /**
   * Send the redacted evidence: the console line, the subject and the timeline (default true). Timeline lines can hold
   * short fragments of app data (a store value summary, an error message, text typed into an ordinary input); false
   * sends the structured fields only (kind, diagnosis, p, action, route, ...).
   */
  evidence?: boolean;
  /**
   * Also forward "possible" detections (observe's lower tier, `SinkRecord.detection` "possible"; InitOptions.detect).
   * Default false: likely detections only.
   */
  possible?: boolean;
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
  const clock = o?.clock;
  const flushMs = num(o?.flushMs, 100, 600_000, 5000);
  const maxBatch = Math.floor(num(o?.maxBatch, 1, 500, 50));
  const transport = typeof o?.send === "function" ? o.send : defaultTransport(g, o?.headers);
  const seen = new Map<string, number>();
  const cap = o?.maxPerSignature ?? DEFAULT_MAX_PER_SIGNATURE;
  let queue: SinkRecord[] = [];
  /** A clock timer, or true while a microtask drain is pending. */
  let timer: unknown = null;
  /** Records were left over by the last POST and wait for the next round (with a clock: its timer). */
  let holding = false;

  const clear = (): void => {
    if (timer !== null && clock) {
      try {
        clock.clearTimeout(timer);
      } catch {
        /* ignore */
      }
    }
    timer = null;
  };

  /** The next round without a clock: the previous POST settled (fetch, or a `send` returning a promise). */
  const settled = (): void => {
    try {
      if (!clock && timer === null && queue.length) drain();
    } catch {
      /* never into the app */
    }
  };

  const post = (records: SinkRecord[]): void => {
    if (!records.length) return;
    const batch: WebhookBatch = { schema: WEBHOOK_SCHEMA, version: VERSION, records };
    try {
      const res = transport(url, JSON.stringify(batch));
      if (res && typeof (res as Promise<unknown>).then === "function") (res as Promise<unknown>).then(settled, settled);
    } catch {
      /* a failed send is dropped */
    }
  };

  /**
   * The oldest records that fit one POST: at most `maxBatch` of them and WEBHOOK_MAX_BODY_BYTES of their JSON (a lone
   * record larger than that goes alone). An unserialisable record is dropped, not its batch. The rest stays queued.
   */
  const take = (summaryFirst: boolean): SinkRecord[] => {
    const order = summaryFirst ? [...queue.filter((r) => r.kind === "summary"), ...queue.filter((r) => r.kind !== "summary")] : queue;
    const out: SinkRecord[] = [];
    let bytes = 0;
    let i = 0;
    for (; i < order.length && out.length < maxBatch; i++) {
      let n = 0;
      try {
        n = utf8Length(JSON.stringify(order[i])) + 1;
      } catch {
        continue; // not serialisable: skip the record rather than the batch
      }
      if (out.length && bytes + n > WEBHOOK_MAX_BODY_BYTES) break;
      out.push(order[i]);
      bytes += n;
    }
    queue = order.slice(i);
    return out;
  };

  /** One round: one POST; what does not fit waits for the next round. */
  const drain = (): void => {
    clear();
    const batch = take(false);
    holding = queue.length > 0;
    if (holding && clock) timer = clock.setTimeout(drain, flushMs);
    post(batch);
  };

  return {
    kinds: o?.kinds,
    sampleRate: o?.sampleRate,
    evidence: o?.evidence ?? true,
    possible: o?.possible === true,
    send(r: SinkRecord): void {
      try {
        if (!url || (r.kind !== "summary" && overCap(seen, r, cap))) return;
        if (queue.length >= WEBHOOK_MAX_QUEUED && r.kind !== "summary") return;
        queue.push(r);
        if (clock) {
          // a full batch goes at once, unless records are already waiting out a round (then its timer sends them)
          if (queue.length >= maxBatch && !holding) drain();
          else if (timer === null) timer = clock.setTimeout(drain, flushMs);
        } else if (timer === null) {
          timer = true;
          void Promise.resolve().then(() => {
            if (timer === true) drain();
          });
        }
      } catch {
        /* never into the app */
      }
    },
    flush(): Promise<void> {
      try {
        // page exit: one more batch (the summary first) is all GenClass takes of the page's keepalive budget
        clear();
        holding = false;
        const batch = take(true);
        queue = [];
        post(batch);
      } catch {
        /* never into the app */
      }
      return Promise.resolve();
    },
  };
}

export default webhook;

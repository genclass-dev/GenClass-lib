// Decider queue (CONTRACT §8): one evaluation at a time, highest priority first (held writes/requests; items whose
// subject already went its way run last, see `prio`), a small cache of identical requests, deadlines (a request
// whose deadline passed while queued is dropped, never computed; the time left is passed to the provider as
// `timeoutMs`), latency samples for the automatic hold budget, and fail-open on any provider error (not ready, too
// many tokens, timeout, busy, ...).

import type { Answer, Clock, DecisionProvider, EvaluateRequest, ModelStatus } from "../types.js";
import { fnv1a, stableStringify } from "../util.js";

/**
 * The warm-up pass is a small situation (about 430 tokens); a typical real one is about 1,100 tokens (observed p50
 * 1,135 on genclass.dev). Before the first measured decision the host's per-token cost is scaled to this size, plus
 * the worker round trip, so the first hold budget is not sized to the warm-up pass alone (0.2.1 did that: the first
 * held decision of every page load missed its 150 ms budget and was lost).
 */
export const TYPICAL_TOKENS = 1200;
export const ROUND_TRIP_MS = 20;
/**
 * A superseded item (its subject already went its way; the answer can only be reported) is computed only while
 * decisions are at most this fast: the queue runs one evaluation at a time without preemption, so on a slow device
 * (WASM: 500–800 ms per decision) a superseded evaluation could make a fresh held duplicate submit miss its budget.
 */
export const SUPERSEDED_MAX_MS = 300;

/** The model's typical decision latency from its status alone (no measured decisions yet). */
export function typicalLatency(st: ModelStatus | undefined): number {
  const lat = st?.latency;
  const warm = lat?.p50;
  if (typeof warm === "number" && warm > 0) {
    if (lat?.source === "warmup" && typeof lat.msPerToken === "number" && lat.msPerToken > 0) {
      return Math.max(warm, Math.round(lat.msPerToken * TYPICAL_TOKENS + ROUND_TRIP_MS));
    }
    return warm;
  }
  return st?.warmupMs ?? 0;
}

export interface DecideResult {
  answers: Record<string, Answer>;
  /** Provider time (dispatch to answer), 0 for cache hits. */
  latencyMs: number;
  /** Time spent waiting in this queue. */
  waitMs: number;
  cached: boolean;
}

interface QueueItem {
  req: EvaluateRequest;
  /** Absolute clock time after which the answer is useless. */
  deadline?: number;
  /** The subject was superseded (already delivered, sent, applied): compute behind fresh items (detection only). */
  stale?: () => boolean;
  /** Receives the answer when it arrives after the deadline (the item was already resolved null and the queue moved on). */
  late?: (r: DecideResult) => void;
  resolve: (r: DecideResult | null) => void;
  seq: number;
  t0: number;
}

const CACHE_MAX = 64;
const CACHE_TTL = 30_000;
const MAX_QUEUE = 32;
const LATENCY_SAMPLES = 20;
/** A provider that has not answered after this long (or the request's deadline) is abandoned: the slot frees up. */
export const PROVIDER_TIMEOUT_MS = 10_000;

export class DeciderQueue {
  private q: QueueItem[] = [];
  private busy = false;
  private seq = 0;
  private cache = new Map<string, { t: number; answers: Record<string, Answer> }>();
  private lat: number[] = [];
  private since = 0;
  private overdue = false;
  disposed = false;
  /** model.maxDecisionsPerMinute (OPTIONS-SPEC §4.17): evaluations per sliding minute; Infinity = no limit. */
  perMinute = Infinity;
  private evals: number[] = [];
  private dropped = 0;
  /** Called (at most once a minute) when an evaluation is dropped by the budget. */
  onBudget?: (b: { decisionsLastMinute: number; dropped: number }) => void;
  private budgetWarnedAt = -Infinity;

  budget(): { decisionsLastMinute: number; dropped: number } {
    const now = this.clock.now();
    this.evals = this.evals.filter((t) => now - t < 60_000);
    return { decisionsLastMinute: this.evals.length, dropped: this.dropped };
  }

  constructor(
    private readonly clock: Clock,
    private readonly provider: () => DecisionProvider | null,
    private readonly onError?: (e: unknown) => void,
  ) {}

  get length(): number {
    return this.q.length;
  }

  /** Items waiting (not counting the one being computed). */
  get waiting(): number {
    return this.q.length;
  }

  get computing(): boolean {
    return this.busy;
  }

  /** Clock time the evaluation being computed was dispatched (meaningful while `computing`). */
  get computingSince(): number {
    return this.since;
  }

  /** The provider's last evaluation was abandoned (timed out) and none has answered since. */
  get stuck(): boolean {
    return this.overdue;
  }

  /** Provider latencies of the last 20 computed evaluations (oldest first). */
  latencies(): number[] {
    return [...this.lat];
  }

  submit(req: EvaluateRequest, deadline?: number, stale?: () => boolean, late?: (r: DecideResult) => void): Promise<DecideResult | null> {
    return new Promise((resolve) => {
      const item: QueueItem = { req, resolve, seq: ++this.seq, t0: this.clock.now() };
      if (deadline !== undefined) item.deadline = deadline;
      if (stale) item.stale = stale;
      if (late) item.late = late;
      this.q.push(item);
      if (this.q.length > MAX_QUEUE) {
        // drop the lowest-priority (superseded first), oldest item
        let worst = 0;
        for (let i = 1; i < this.q.length; i++) {
          const a = this.q[i];
          const b = this.q[worst];
          const pa = this.prio(a);
          const pb = this.prio(b);
          if (pa < pb || (pa === pb && a.seq < b.seq)) worst = i;
        }
        const [dropped] = this.q.splice(worst, 1);
        dropped.resolve(null);
      }
      this.pump();
    });
  }

  /**
   * Effective priority: an item whose subject already went its way (`stale()` true: the request was sent, the
   * response delivered, the write applied) can only produce a detection and a report, so it runs behind every item
   * that can still act. It is not dropped for that: a lost answer is a lost detection (and, until 0.2.1, a queue
   * that read as stuck).
   */
  private prio(it: QueueItem): number {
    let superseded = false;
    try {
      superseded = !!it.stale?.();
    } catch {
      superseded = false;
    }
    const p = it.req.priority ?? 0;
    return superseded ? Math.min(p, 0) - 1 : p;
  }

  /** Median of the measured decision latencies, else the provider's own estimate (0 when it has none). */
  private typicalMs(p: DecisionProvider): number {
    if (this.lat.length) {
      const a = [...this.lat].sort((x, y) => x - y);
      return a[Math.floor((a.length - 1) / 2)];
    }
    return typicalLatency(p.status);
  }

  private next(): QueueItem | undefined {
    if (!this.q.length) return undefined;
    let best = 0;
    for (let i = 1; i < this.q.length; i++) {
      const a = this.q[i];
      const b = this.q[best];
      const pa = this.prio(a);
      const pb = this.prio(b);
      if (pa > pb || (pa === pb && a.seq < b.seq)) best = i;
    }
    return this.q.splice(best, 1)[0];
  }

  private pump(): void {
    while (!this.busy && !this.disposed) {
      const item = this.next();
      if (!item) return;
      const now = this.clock.now();
      if (item.deadline !== undefined && now >= item.deadline) {
        item.resolve(null);
        continue;
      }
      const p = this.provider();
      if (!p || p.status.state !== "ready") {
        item.resolve(null);
        continue;
      }
      // a superseded item can only be reported: compute it when decisions are fast (it then delays a fresh held
      // item by at most SUPERSEDED_MAX_MS, which the hold logic accounts for), skip it on a slow device
      if (this.prio(item) < 0 && this.typicalMs(p) > SUPERSEDED_MAX_MS) {
        item.resolve(null);
        continue;
      }
      const key = fnv1a(item.req.trigger + "\u0000" + stableStringify(item.req.state) + "\u0000" + stableStringify(item.req.questions));
      const hit = this.cache.get(key);
      if (hit && now - hit.t <= CACHE_TTL) {
        item.resolve({ answers: hit.answers, latencyMs: 0, waitMs: now - item.t0, cached: true });
        continue;
      }
      if (Number.isFinite(this.perMinute)) {
        this.evals = this.evals.filter((t) => now - t < 60_000);
        if (this.evals.length >= this.perMinute) {
          // over the budget: fail open now (held subjects are released unchanged, background ones dropped)
          this.dropped++;
          item.resolve(null);
          if (now - this.budgetWarnedAt >= 60_000) {
            this.budgetWarnedAt = now;
            try {
              this.onBudget?.({ decisionsLastMinute: this.evals.length, dropped: this.dropped });
            } catch {
              /* ignore */
            }
          }
          continue;
        }
        this.evals.push(now);
      }
      this.dispatch(p, item, key, now);
    }
  }

  private dispatch(p: DecisionProvider, item: QueueItem, key: string, t1: number): void {
    this.busy = true;
    this.since = t1;
    let settled = false;
    // runtime-side timeout: a provider that never answers must not block every later decision
    const limit = item.deadline !== undefined ? Math.max(1, item.deadline - t1) : PROVIDER_TIMEOUT_MS;
    const timer = this.clock.setTimeout(() => {
      this.overdue = true;
      this.onError?.(Object.assign(new Error("the decision provider did not answer in time"), { code: "timeout" }));
      done(null);
    }, limit);
    const done = (r: DecideResult | null) => {
      if (settled) return;
      settled = true;
      this.clock.clearTimeout(timer);
      this.busy = false;
      item.resolve(r);
      this.pump();
    };
    const req: EvaluateRequest = item.deadline !== undefined ? { ...item.req, timeoutMs: Math.max(1, item.deadline - t1) } : item.req;
    let pr: Promise<Record<string, Answer>>;
    try {
      pr = p.evaluate(req);
    } catch (e) {
      this.onError?.(e);
      done(null);
      return;
    }
    Promise.resolve(pr).then(
      (answers) => {
        if (answers && typeof answers === "object") {
          this.overdue = false;
          const t2 = this.clock.now();
          this.cache.set(key, { t: t2, answers });
          if (this.cache.size > CACHE_MAX) {
            const first = this.cache.keys().next().value;
            if (first !== undefined) this.cache.delete(first);
          }
          this.lat.push(t2 - t1);
          if (this.lat.length > LATENCY_SAMPLES) this.lat.shift();
          const r = { answers, latencyMs: t2 - t1, waitMs: t1 - item.t0, cached: false };
          if (settled) {
            // the deadline passed and the queue moved on: the answer still counts (record, report, latency sample)
            if (item.late && !this.disposed) {
              try {
                item.late(r);
              } catch (e) {
                this.onError?.(e);
              }
            }
            return;
          }
          done(r);
        } else done(null);
      },
      (e) => {
        this.onError?.(e);
        done(null);
      },
    );
  }

  clear(): void {
    const q = this.q;
    this.q = [];
    for (const it of q) it.resolve(null);
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}

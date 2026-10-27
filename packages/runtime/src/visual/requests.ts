// rt.summary().requests (issue 94; API.md "Requests in rt.summary()"): request counts and per-host health, so a quiet
// summary can be told apart from one where GenClass saw no requests. It lives in the lazily loaded checks chunk to keep
// first load unchanged: on load it counts the fetch and XHR operations the runtime still holds (its op store), then
// follows the runtime's `event` stream (op.start, op.end). The only first-load part is the `nj` flag the fetch and
// XHR observers set when the app reads a non-JSON answer as JSON. Reporting only: it reads the runtime and never feeds
// a situation, a fact, the gate or the model; telemetry does not send it. Latency comes from the learned baselines.

import type { RequestHealth, RequestSummary } from "../types.js";

/** The parts of an op it reads (src/trace/ops.ts OpRec). */
export interface OpLike {
  kind: string;
  name: string;
  end?: number;
  status?: string;
  code?: number | string;
  genclass?: boolean;
  nj?: 1;
}

/** The parts of the runtime it reads. */
export interface RequestsRt {
  readonly ops: { byId: Map<number, OpLike> };
  readonly base: { sigs: Map<string, { sig: string; lat: number[] }> };
  on(type: "event", fn: (e: { kind: string; op?: number; data?: Record<string, unknown> }) => void): () => void;
}

/** The counters, in index order (RequestHealth's fields). */
const K = "requests 2xx 3xx 4xx 5xx network aborted notJson byGenClass".split(" ");
const zeros = () => K.map(() => 0);
/** Ended requests kept to see a later `response.json()` (the nj flag); older ones are judged when dropped. */
const KEEP = 500;

/** "same-origin" for a path signature ("GET /api/x"), else its host ("GET api.example.com/v1"). */
export function hostOfSig(sig: string): string {
  const where = sig.slice(sig.indexOf(" ") + 1);
  return where.startsWith("/") ? "same-origin" : where.split("/")[0];
}

export class RequestCounter {
  private readonly h = new Map<string, number[]>();
  private readonly t = zeros();
  private readonly started = new WeakSet<OpLike>();
  private readonly ended = new WeakSet<OpLike>();
  private readonly nj = new WeakSet<OpLike>();
  private recent: OpLike[] = [];
  /** Stop following the runtime. */
  readonly stop: () => void;

  constructor(private readonly rt: RequestsRt) {
    for (const op of rt.ops.byId.values()) {
      this.start(op);
      // an op already ended: "blocked" is GenClass's synthetic answer (a reused response counts by its status here)
      if (op.end !== undefined) this.end(op, op.status === "blocked");
    }
    this.stop = rt.on("event", (e) => {
      const op = e.op === undefined ? undefined : rt.ops.byId.get(e.op);
      if (!op) return;
      if (e.kind === "op.start") this.start(op);
      else if (e.kind === "op.end") this.end(op, !!e.data?.synthetic);
    });
  }

  private key(sig: string): string {
    const k = hostOfSig(sig);
    return this.h.has(k) || this.h.size < 30 ? k : "other";
  }

  private add(sig: string, i: number): void {
    const k = this.key(sig);
    const a = this.h.get(k) ?? zeros();
    this.h.set(k, a);
    a[i]++;
    this.t[i]++;
  }

  private start(op: OpLike): void {
    if ((op.kind !== "fetch" && op.kind !== "xhr") || op.genclass || this.started.has(op)) return;
    this.started.add(op);
    this.add(op.name, 0);
  }

  private end(op: OpLike, synthetic: boolean): void {
    if (!this.started.has(op) || this.ended.has(op)) return;
    this.ended.add(op);
    const c = op.code;
    this.add(op.name, synthetic ? 8 : op.status === "aborted" ? 6 : typeof c == "number" && c >= 200 && c < 600 ? ((c / 100) | 0) - 1 : 5);
    this.recent.push(op);
    if (this.recent.length > KEEP) this.judge(this.recent.splice(0, this.recent.length - KEEP));
  }

  /** Count the not-JSON answers among these ops, once each. */
  private judge(ops: OpLike[]): void {
    for (const op of ops) if (op.nj && !this.nj.has(op)) this.nj.add(op), this.add(op.name, 7);
  }

  snapshot(): RequestSummary {
    this.judge(this.recent);
    const lat: Record<string, number[]> = {};
    const all: number[] = [];
    for (const s of this.rt.base.sigs.values()) (lat[this.key(s.sig)] ??= []).push(...s.lat), all.push(...s.lat);
    const out = (a: number[], l: number[] = []) => {
      const o = Object.fromEntries(K.map((k, i) => [k, a[i]])) as unknown as RequestHealth;
      // every request that started ends once (index 7, notJson, is not an end)
      o.pending = a.reduce((n, v, i) => (i == 7 ? n : n - v), 2 * a[0]);
      const q = (p: number) => Math.round(l[Math.ceil(p * l.length) - 1]);
      if (l.sort((x, y) => x - y).length) o.latency = { n: l.length, p50: q(0.5), p95: q(0.95) };
      return o;
    };
    const hosts: Record<string, RequestHealth> = {};
    for (const [k, a] of this.h) hosts[k] = out(a, lat[k]);
    return { ...out(this.t, all), hosts };
  }
}

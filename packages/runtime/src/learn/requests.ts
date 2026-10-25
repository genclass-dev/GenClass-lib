// Request counts and per-host request health for rt.summary().requests (issue 94; API.md "summary()"). Counted from
// the fetch and XHR operations the runtime already records (startOp / endOp), so a quiet summary can be told apart
// from one where GenClass saw no requests at all. Reporting only: nothing here feeds a situation, a fact, the gate
// or the model, and telemetry does not send it (src/telemetry/client.ts picks its summary fields one by one).
// Latency comes from the learned baselines (src/learn/baselines.ts): nothing is measured twice. First-load code, so
// it is kept small: counters are arrays, named only in snapshot().

import type { RequestHealth, RequestSummary } from "../types.js";
import type { Baselines } from "./baselines.js";
import { hostOfSig } from "../situation/evidence.js";

/** The counters, in index order (RequestHealth's fields). */
const K = "requests 2xx 3xx 4xx 5xx network aborted notJson byGenClass".split(" ");

export class RequestStats {
  private readonly h = new Map<string, number[]>();
  private readonly t = K.map(() => 0);

  /** "same-origin", the host, or "other" once 30 hosts are tracked. */
  private key(sig: string): string {
    const k = hostOfSig(sig);
    return this.h.has(k) || this.h.size < 30 ? k : "other";
  }

  /** Count K[i] for the signature's host and in the totals. */
  add(sig: string, i: number): void {
    const k = this.key(sig);
    const a = this.h.get(k) ?? K.map(() => 0);
    this.h.set(k, a);
    a[i]++;
    this.t[i]++;
  }

  snapshot(base: Baselines): RequestSummary {
    const lat: Record<string, number[]> = {};
    const all: number[] = [];
    for (const s of base.sigs.values()) (lat[this.key(s.sig)] ??= []).push(...s.lat), all.push(...s.lat);
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

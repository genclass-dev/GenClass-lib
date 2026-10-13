// The public sample dashboard (genclass.dev/dashboard/sample): simulated stats for a storefront, generated on each
// request relative to the current time, so the page always shows a full period. Nothing is stored and no real
// project is involved; the project name says it is simulated. Deterministic per day (a seeded generator), so a
// refresh does not reshuffle the chart. It shows the "possible issues" tier too (lower confidence, never counted as
// problems), with its own simulated counts.

import { dayKey, hourKey, RANGES, type Range, type Stats } from "./dashboard.js";

export const SAMPLE_SECRET = "sample";
export const SAMPLE_PROJECT = { name: "Sample storefront (simulated data)", token: "gc_SAMPLEsampleSAMPLE00", created: "2026-10-01T00:00:00.000Z" };

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const TYPES: [string, number, [string, number][]][] = [
  ["duplicate", 2.6, [["/checkout", 0.58], ["/cart", 0.32], ["/products/:id", 0.1]]],
  ["stale", 1.7, [["/search", 0.75], ["/products", 0.25]]],
  ["failing", 1.0, [["/products/:id", 0.62], ["/", 0.38]]],
  ["slow", 0.7, [["/products/:id", 1]]],
  ["conflict", 0.45, [["/cart", 1]]],
  ["transient", 0.35, [["/checkout", 1]]],
];
const ACT = { duplicate: "coalesce", stale: "discard" } as Record<string, string>;
/** The lower-confidence tier: per type, a daily rate and where it shows up (simulated). */
const POSSIBLE: [string, number, [string, number][]][] = [
  ["stale", 1.3, [["/search", 0.6], ["/products", 0.4]]],
  ["slow", 1.1, [["/products/:id", 0.7], ["/checkout", 0.3]]],
  ["duplicate", 0.8, [["/cart", 0.6], ["/account", 0.4]]],
  ["overload", 0.5, [["/search", 1]]],
  ["failing", 0.3, [["/orders", 1]]],
];

function split(n: number, routes: [string, number][], into: (route: string, c: number) => void): void {
  let left = n;
  routes.forEach(([route, f], i) => {
    const c = i === routes.length - 1 ? left : Math.min(left, Math.max(1, Math.round(n * f)));
    left -= c;
    if (c > 0) into(route, c);
  });
}

export function sampleStats(rangeParam: string | null, now: Date): Stats {
  const range: Range = rangeParam && (RANGES as string[]).includes(rangeParam) ? (rangeParam as Range) : "7d";
  const hourly = range === "24h";
  const span = hourly ? 24 : range === "7d" ? 7 : 30;
  const step = hourly ? 3_600_000 : 86_400_000;
  const buckets: string[] = [];
  for (let i = span - 1; i >= 0; i--) buckets.push(hourly ? hourKey(new Date(now.getTime() - i * step)) : dayKey(new Date(now.getTime() - i * step)));
  const scale = hourly ? 1 / 10 : 1;
  const tot: Record<string, number> = {};
  const typeSeries = buckets.map((b) => {
    const r = rng([...b].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7));
    const counts: Record<string, number> = {};
    for (const [k, w] of TYPES) {
      const n = hourly ? (r() < w / 7 ? 1 + (r() < 0.25 ? 1 : 0) : 0) : Math.max(0, Math.round(w * (0.35 + r() * 1.3)));
      if (n) {
        counts[k] = n;
        tot[k] = (tot[k] ?? 0) + n;
      }
    }
    return { bucket: b, counts };
  });
  const detections = Object.values(tot).reduce((a, b) => a + b, 0);
  const issue: { key: string; count: number }[] = [];
  const byRoute: Record<string, number> = {};
  for (const [k, , routes] of TYPES) {
    const n = tot[k] ?? 0;
    if (n) {
      split(n, routes, (route, c) => {
        issue.push({ key: `${k}\t${route}`, count: c });
        byRoute[route] = (byRoute[route] ?? 0) + c;
      });
    }
  }
  // possible issues: their own draw per bucket, their own counters
  const ptot: Record<string, number> = {};
  const possibleBy = buckets.map((b) => {
    const r = rng([...b].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 101));
    let n = 0;
    for (const [k, w] of POSSIBLE) {
      const x = hourly ? (r() < w / 8 ? 1 : 0) : Math.max(0, Math.round(w * (0.3 + r() * 1.4)));
      if (x) {
        ptot[k] = (ptot[k] ?? 0) + x;
        n += x;
      }
    }
    return n;
  });
  const possible = Object.values(ptot).reduce((a, b) => a + b, 0);
  const pissue: { key: string; count: number }[] = [];
  const pRoute: Record<string, number> = {};
  for (const [k, , routes] of POSSIBLE) {
    const n = ptot[k] ?? 0;
    if (n) {
      split(n, routes, (route, c) => {
        pissue.push({ key: `${k}\t${route}`, count: c });
        pRoute[route] = (pRoute[route] ?? 0) + c;
      });
    }
  }
  const perBucket = hourly ? 11 : 262;
  const r = rng(span * 17 + Math.floor(now.getTime() / 86_400_000));
  const series = buckets.map((b, i) => ({ bucket: b, sessions: Math.round(perBucket * (0.82 + r() * 0.36)), decisions: Math.round(perBucket * 0.66 * (0.8 + r() * 0.4)), detections: Object.values(typeSeries[i]!.counts).reduce((a, x) => a + x, 0), acted: 0, possible: possibleBy[i]! }));
  const sessions = series.reduce((a, s) => a + s.sessions, 0);
  const coalesce = Math.round((tot.duplicate ?? 0) * 0.55), discard = Math.round((tot.stale ?? 0) * 0.4);
  const interventions = coalesce + discard;
  const undone = interventions > 6 ? 1 : 0;
  const ready = Math.round(sessions * 0.968), failed = Math.max(1, Math.round(sessions * 0.004));
  const recent: Record<string, unknown>[] = [];
  const rr = rng(Math.floor(now.getTime() / 600_000));
  const weighted = TYPES.flatMap(([k, w]) => Array(Math.max(1, Math.round(w * 4))).fill(k) as string[]);
  for (let i = 0; i < 24; i++) {
    const d = weighted[Math.floor(rr() * weighted.length)]!;
    const routes = TYPES.find((t) => t[0] === d)![2];
    const route = routes[Math.floor(rr() * routes.length)]![0];
    const acted = !!ACT[d] && rr() < 0.5;
    recent.push({
      t: new Date(now.getTime() - (i * 41 + Math.floor(rr() * 25)) * 60_000).toISOString(),
      route, fn: null,
      trigger: d === "duplicate" ? "request" : d === "stale" ? "delivery" : d === "conflict" ? "mutation" : "failure",
      diagnosis: d, action: ACT[d] ?? "deliver", ran: acted ? ACT[d] : "send",
      confidence: Math.round((0.82 + rr() * 0.17) * 100) / 100, mode: "guard", executed: true, acted, kind: acted ? "acted" : "detect",
    });
  }
  const from = buckets[0]!;
  const breakdowns: Stats["breakdowns"] = {
    detect_diagnosis: Object.entries(tot).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    detect_issue: issue,
    detect_route: Object.entries(byRoute).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    possible_diagnosis: Object.entries(ptot).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    possible_issue: pissue,
    possible_route: Object.entries(pRoute).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    page_route: ["/", "/products", "/products/:id", "/search", "/cart", "/checkout", "/account", "/orders"].map((key, i) => ({ key, count: Math.round(sessions / (i + 2)) })),
    intervention: [{ key: "coalesce", count: coalesce }, { key: "discard", count: discard }].filter((x) => x.count > 0),
    action_outcome: [{ key: "applied", count: interventions }, ...(undone ? [{ key: "undone", count: undone }] : [])],
    mode: [{ key: "guard", count: sessions }],
    backend: [{ key: "webgpu", count: Math.round(ready * 0.83) }, { key: "wasm", count: ready - Math.round(ready * 0.83) }],
    model_error_events: [{ key: "model card download failed: HTTP 429", count: Math.ceil(failed * 0.6) }, { key: "timeout", count: Math.floor(failed * 0.4) }].filter((x) => x.count > 0),
    runtime: [{ key: "0.3.0", count: sessions }],
    model_version: [{ key: "2.0.0-rc4t", count: sessions }],
    trigger: [{ key: "request", count: 610 }, { key: "delivery", count: 390 }, { key: "failure", count: 180 }],
    latency_bucket: [{ key: "<50 ms", count: 60 }, { key: "100-250 ms", count: 820 }, { key: "250-500 ms", count: 290 }],
    host: [{ key: "shop.example", count: sessions }],
  };
  return {
    name: SAMPLE_PROJECT.name,
    token: SAMPLE_PROJECT.token,
    created: SAMPLE_PROJECT.created,
    lastEvent: new Date(now.getTime() - 3 * 60_000).toISOString(),
    range,
    from: hourly ? `${from}:00:00.000Z` : `${from}T00:00:00.000Z`,
    generated: now.toISOString(),
    totals: {
      sessions, decisions: series.reduce((a, s) => a + s.decisions, 0), detections, acted: interventions, executed: interventions, interventions,
      model_ready: ready, model_load_failed: failed, modelLoadAvgMs: 1340, latency_ms_n: Math.round(sessions * 0.66), latencyAvgMs: 168, failOpens: Math.round(sessions * 0.011), modelErrors: failed,
      detectionsWithPage: detections, possible, possibleWithPage: possible, hidden_skipped: Math.round(sessions * 0.05), model_dropped: hourly ? 0 : Math.round(sessions * 0.002), telemetry_dropped: 0,
    },
    breakdowns,
    distinct: Object.fromEntries(Object.entries(breakdowns).map(([k, v]) => [k, v.length])),
    series,
    typeSeries,
    previous: { sessions: Math.round(sessions * 0.94), detections: Math.round(detections * 1.15), acted: Math.max(0, interventions - 2) },
    recent,
  };
}

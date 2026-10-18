// The public sample dashboard (genclass.dev/dashboard/sample): simulated stats for a storefront, generated on each
// request relative to the current time, so the page always shows a full period. Nothing is stored and no real
// project is involved; the project name says it is simulated. Deterministic per day (a seeded generator), so a
// refresh does not reshuffle the chart. It shows the "possible issues" tier too (lower confidence, never counted as
// problems), with its own simulated counts, and interaction analytics (page views, time on page, scroll depth, clicks,
// rage and dead clicks per element), as an app that turned them on would.

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

/** Interaction analytics per page (simulated): share of page views, average engaged seconds, share reaching 25/50/75/100 %. */
const IX_PAGES: [string, number, number, number[]][] = [
  ["/", 0.27, 38, [0.88, 0.63, 0.41, 0.24]],
  ["/products", 0.2, 52, [0.92, 0.74, 0.52, 0.31]],
  ["/products/:id", 0.22, 71, [0.95, 0.78, 0.49, 0.27]],
  ["/search", 0.11, 44, [0.83, 0.55, 0.3, 0.16]],
  ["/cart", 0.09, 63, [0.97, 0.9, 0.81, 0.74]],
  ["/checkout", 0.06, 118, [0.99, 0.94, 0.86, 0.79]],
  ["/account", 0.03, 35, [0.9, 0.71, 0.5, 0.42]],
  ["/orders", 0.02, 29, [0.93, 0.66, 0.45, 0.37]],
];
/** Clicks per 100 page views (simulated), and rage and dead clicks per 1,000, per page and element key. */
const IX_CLICKS: [string, string, number][] = [
  ["/", 'a[href="/products"]', 21],
  ["/", '[data-genclass-name="hero-shop"]', 17],
  ["/", "nav > ul > li:nth-of-type(3) > a", 6],
  ["/products", 'a[href="/products/:id"]', 58],
  ["/products", "button.filter-toggle", 9],
  ["/products/:id", '[data-genclass-name="add-to-cart"]', 34],
  ["/products/:id", "img.gallery-main", 26],
  ["/search", "input#q", 41],
  ["/cart", "button.qty-plus", 19],
  ["/cart", "button.promo-apply", 8],
  ["/checkout", "button#pay", 63],
];
const IX_RAGE: [string, string, number][] = [
  ["/checkout", "button#pay", 4.1],
  ["/products/:id", "img.gallery-main", 2.6],
];
const IX_DEAD: [string, string, number][] = [
  ["/cart", "button.promo-apply", 6.2],
  ["/account", "button#save-address", 1.4],
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
  const series = buckets.map((b, i) => {
    const sessions = Math.round(perBucket * (0.82 + r() * 0.36));
    // a page load plus its in-app route changes
    return { bucket: b, sessions, decisions: Math.round(perBucket * 0.66 * (0.8 + r() * 0.4)), detections: Object.values(typeSeries[i]!.counts).reduce((a, x) => a + x, 0), acted: 0, possible: possibleBy[i]!, ix_views: Math.round(sessions * 1.36) };
  });
  const sessions = series.reduce((a, s) => a + s.sessions, 0);
  const views = series.reduce((a, s) => a + s.ix_views, 0);
  const ixViews = IX_PAGES.map(([route, share, secs, reach]) => ({ route, n: Math.round(views * share), secs, reach }));
  const engagedMs = ixViews.reduce((a, p) => a + p.n * p.secs * 1000, 0);
  const per = (list: [string, string, number][], unit: number) => list.map(([route, k, rate]) => ({ key: `${route}\t${k}`, count: Math.max(1, Math.round((views * rate) / unit)) }));
  const ixClick = per(IX_CLICKS, 100), ixRage = per(IX_RAGE, 1000), ixDead = per(IX_DEAD, 1000);
  const total = (l: { count: number }[]) => l.reduce((a, x) => a + x.count, 0);
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
    ix_views: ixViews.map((p) => ({ key: p.route, count: p.n })),
    ix_engaged_ms: ixViews.map((p) => ({ key: p.route, count: p.n * p.secs * 1000 })),
    ix_scroll: ixViews.flatMap((p) => [25, 50, 75, 100].map((m, i) => ({ key: `${p.route}\t${m}`, count: Math.round(p.n * p.reach[i]!) }))),
    ix_click: ixClick.sort((a, b) => b.count - a.count),
    ix_rage: ixRage.sort((a, b) => b.count - a.count),
    ix_dead: ixDead.sort((a, b) => b.count - a.count),
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
      ix_views: views, ix_engaged_ms: engagedMs, ix_click: total(ixClick), ix_rage: total(ixRage), ix_dead: total(ixDead),
    },
    breakdowns,
    distinct: Object.fromEntries(Object.entries(breakdowns).map(([k, v]) => [k, v.length])),
    series,
    typeSeries,
    previous: { sessions: Math.round(sessions * 0.94), detections: Math.round(detections * 1.15), acted: Math.max(0, interventions - 2), ix_views: Math.round(views * 0.91) },
    recent,
  };
}

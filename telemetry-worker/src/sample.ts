// The public sample dashboard (genclass.dev/dashboard/sample): simulated stats for a storefront, generated on each
// request relative to the current time, so the page always shows a full period. Nothing is stored and no real
// project is involved; the project name says it is simulated. Deterministic per day (a seeded generator), so a
// refresh does not reshuffle the chart. It shows the "possible issues" tier too (lower confidence, never counted as
// problems), with its own simulated counts, and interaction analytics (page views, time on page, scroll depth, clicks,
// rage and dead clicks per element; visits, their sources, devices, countries, entry and exit pages, and two funnels),
// as an app that turned them on would, and the measured visual checks (runtime 0.3.0-beta.4) with their runtime fixes,
// as an app with `visual: { on: true, fix: true }` in guard mode sends them.

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

/** Measured visual checks (simulated): per check kind, a daily rate and where it shows up. */
const CHECKS: [string, number, [string, number][]][] = [
  ["scroll-lock-stuck", 1.5, [["/products/:id", 0.7], ["/", 0.3]]],
  ["text-invisible", 1.1, [["/checkout", 1]]],
  ["image-broken", 0.9, [["/products", 0.6], ["/products/:id", 0.4]]],
  ["click-blocked", 0.5, [["/cart", 1]]],
];
/** The share of each fixable kind's findings that got a runtime fix (the others had no inline declaration to remove). */
const CHECK_FIXED: Record<string, number> = { "scroll-lock-stuck": 0.8, "text-invisible": 0.6 };

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
/** Navigation (simulated, ANALYTICS.md section 11): steps per 100 page views with seconds before the step, paths per 100 page loads, first interactions. */
const IX_STEPS: [string, string, number, number][] = [
  ["/", "/products", 14, 31],
  ["/products", "/products/:id", 12, 44],
  ["/products/:id", "/cart", 5, 63],
  ["/", "/search", 6, 18],
  ["/search", "/products/:id", 5, 27],
  ["/cart", "/checkout", 4, 41],
  ["/products/:id", "/products", 4, 52],
  ["/checkout", "/orders", 1.5, 96],
];
const IX_PATHS: [string, number][] = [
  ["/", 34],
  ["/ > /products > /products/:id", 9],
  ["/products/:id", 8],
  ["/ > /search > /products/:id", 5],
  ["/ > /products > /products/:id > /cart > /checkout", 3],
  ["/products/:id > /cart > /checkout > /orders", 1.5],
];
const IX_FIRST: [string, string, number][] = [
  ["/", 'a[href="/products"]', 0.41],
  ["/products", '[data-genclass-name="filter-size"]', 0.38],
  ["/products/:id", '[data-genclass-name="add-to-cart"]', 0.36],
  ["/search", "input#q", 0.71],
  ["/cart", "button.qty-plus", 0.33],
  ["/checkout", "input#email", 0.68],
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

/** Visits (simulated): shares of the visits that started in the period, per source, device, browser, OS and country. */
const IX_SHARES: Record<string, [string, number][]> = {
  ix_ref: [["(direct)", 0.41], ["google.com", 0.27], ["news.ycombinator.com", 0.09], ["t.co", 0.07], ["duckduckgo.com", 0.04], ["reddit.com", 0.04], ["bing.com", 0.03], ["(other)", 0.05]],
  ix_utm_source: [["newsletter", 0.06], ["producthunt", 0.03]],
  ix_utm_medium: [["email", 0.06], ["social", 0.03]],
  ix_utm_campaign: [["autumn-sale", 0.06], ["launch", 0.03]],
  ix_device: [["desktop", 0.58], ["mobile", 0.37], ["tablet", 0.05]],
  ix_browser: [["Chrome", 0.61], ["Safari", 0.24], ["Edge", 0.06], ["Firefox", 0.06], ["Samsung Internet", 0.02], ["Other", 0.01]],
  ix_os: [["Windows", 0.31], ["iOS", 0.27], ["macOS", 0.21], ["Android", 0.15], ["Linux", 0.04], ["ChromeOS", 0.01], ["Other", 0.01]],
  ix_country: [["US", 0.38], ["DE", 0.09], ["GB", 0.08], ["IN", 0.07], ["CA", 0.05], ["FR", 0.05], ["NL", 0.03], ["BR", 0.03], ["AU", 0.03], ["(unknown)", 0.01]],
  ix_returning: [["new", 0.64], ["returning", 0.36]],
};
const ENTRY: [string, number][] = [["/", 0.46], ["/products/:id", 0.24], ["/products", 0.14], ["/search", 0.09], ["/account", 0.04], ["/orders", 0.03]];
const EXIT: [string, number][] = [["/products/:id", 0.31], ["/", 0.22], ["/checkout", 0.15], ["/cart", 0.12], ["/products", 0.1], ["/search", 0.07], ["/orders", 0.03]];
/** Funnels (simulated): per step, the share of visits that reached it in order. */
const FUNNELS: [string, string[], number[]][] = [
  ["Checkout", ["/products/:id", "/cart", "/checkout"], [0.52, 0.19, 0.09]],
  ["Search to product", ["/search", "/products/:id"], [0.17, 0.11]],
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
  // measured visual checks: their own draw per bucket, their own counters (never in detections)
  const ctot: Record<string, number> = {};
  const checkSeries = buckets.map((b) => {
    const r = rng([...b].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 211));
    const counts: Record<string, number> = {};
    for (const [k, w] of CHECKS) {
      const n = hourly ? (r() < w / 7 ? 1 : 0) : Math.max(0, Math.round(w * (0.35 + r() * 1.3)));
      if (n) {
        counts[k] = n;
        ctot[k] = (ctot[k] ?? 0) + n;
      }
    }
    return { bucket: b, counts };
  });
  const checks = Object.values(ctot).reduce((a, b) => a + b, 0);
  const cissue: { key: string; count: number }[] = [];
  for (const [k, , routes] of CHECKS) if (ctot[k]) split(ctot[k]!, routes, (route, c) => cissue.push({ key: `${k}\t${route}`, count: c }));
  const fixesApplied = Object.entries(CHECK_FIXED).reduce((a, [k, f]) => a + Math.round((ctot[k] ?? 0) * f), 0);
  const perBucket = hourly ? 11 : 262;
  const r = rng(span * 17 + Math.floor(now.getTime() / 86_400_000));
  const series = buckets.map((b, i) => {
    const sessions = Math.round(perBucket * (0.82 + r() * 0.36));
    // a page load plus its in-app route changes
    const ix_views = Math.round(sessions * 1.36);
    return { bucket: b, sessions, decisions: Math.round(perBucket * 0.66 * (0.8 + r() * 0.4)), detections: Object.values(typeSeries[i]!.counts).reduce((a, x) => a + x, 0), acted: 0, possible: possibleBy[i]!, checks: Object.values(checkSeries[i]!.counts).reduce((a, x) => a + x, 0), ix_views, ix_sessions: Math.round(ix_views / 2.6) };
  });
  const visitCount = series.reduce((a, s) => a + s.ix_sessions, 0);
  const shareOf = (list: [string, number][]) => list.map(([key, f]) => ({ key, count: Math.max(1, Math.round(visitCount * f)) }));
  const sessions = series.reduce((a, s) => a + s.sessions, 0);
  const views = series.reduce((a, s) => a + s.ix_views, 0);
  const ixViews = IX_PAGES.map(([route, share, secs, reach]) => ({ route, n: Math.round(views * share), secs, reach }));
  const engagedMs = ixViews.reduce((a, p) => a + p.n * p.secs * 1000, 0);
  const per = (list: [string, string, number][], unit: number) => list.map(([route, k, rate]) => ({ key: `${route}\t${k}`, count: Math.max(1, Math.round((views * rate) / unit)) }));
  const ixClick = per(IX_CLICKS, 100), ixRage = per(IX_RAGE, 1000), ixDead = per(IX_DEAD, 1000);
  const total = (l: { count: number }[]) => l.reduce((a, x) => a + x.count, 0);
  const steps = IX_STEPS.map(([a, b, rate, secs]) => ({ key: `${a}\t${b}`, count: Math.round((views * rate) / 100), secs }));
  const entries = Math.max(1, views - total(steps));
  const viewsOf = (r0: string) => ixViews.find((p) => p.route === r0)?.n ?? 0;
  const entryOf = (r0: string) => Math.max(0, viewsOf(r0) - steps.filter((x) => x.key.endsWith(`\t${r0}`)).reduce((a, x) => a + x.count, 0));
  const exitOf = (r0: string) => Math.round(Math.max(0, viewsOf(r0) - steps.filter((x) => x.key.startsWith(`${r0}\t`)).reduce((a, x) => a + x.count, 0)) * 0.86);
  const ixEntry = ixViews.map((p) => ({ key: p.route, count: entryOf(p.route) }));
  const ixExit = ixViews.map((p) => ({ key: p.route, count: exitOf(p.route) }));
  const ixFirst = IX_FIRST.map(([r0, k, rate]) => ({ key: `${r0}\t${k}`, count: Math.round(viewsOf(r0) * rate) }));
  const coalesce = Math.round((tot.duplicate ?? 0) * 0.55), discard = Math.round((tot.stale ?? 0) * 0.4);
  const interventions = coalesce + discard;
  // the series' acted: the interventions spread over the buckets where the repeats and stale responses happened
  const actable = typeSeries.map((b) => (b.counts.duplicate ?? 0) + (b.counts.stale ?? 0));
  const actTotal = actable.reduce((a, x) => a + x, 0);
  let left = interventions;
  series.forEach((s, i) => {
    const n = i === series.length - 1 ? left : Math.min(left, actTotal ? Math.round((interventions * actable[i]!) / actTotal) : 0);
    s.acted = n;
    left -= n;
  });
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
    ix_entry: ixEntry.sort((a, b) => b.count - a.count),
    ix_exit: ixExit.sort((a, b) => b.count - a.count),
    ix_nav: steps.map(({ key, count }) => ({ key, count })).sort((a, b) => b.count - a.count),
    ix_nav_ms: steps.map(({ key, count, secs }) => ({ key, count: count * secs * 1000 })),
    ix_arrive: [
      ...[["load", 0.78], ["push", 0.15], ["back", 0.04], ["back_forward", 0.02], ["reload", 0.01]].map(([k, f]) => ({ key: k as string, count: Math.round(views * (f as number)) })),
      ...ixViews.map((p) => ({ key: `${p.route}\tback`, count: Math.round(p.n * 0.04) })),
    ],
    ix_first: ixFirst.sort((a, b) => b.count - a.count),
    ix_first_n: IX_FIRST.map(([r0]) => ({ key: r0, count: Math.round(viewsOf(r0) * 0.8) })),
    ix_first_ms: IX_FIRST.map(([r0], i) => ({ key: r0, count: Math.round(viewsOf(r0) * 0.8) * (3200 + 1700 * i) })),
    ix_path: IX_PATHS.map(([key, rate]) => ({ key, count: Math.round((entries * rate) / 100) })),
    ...Object.fromEntries(Object.entries(IX_SHARES).map(([m, list]) => [m, shareOf(list)])),
    check_kind: Object.entries(ctot).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    check_issue: cissue.sort((a, b) => b.count - a.count),
    check_fix: [{ key: "applied", count: fixesApplied }, ...(fixesApplied > 4 ? [{ key: "undone", count: 1 }] : [])].filter((x) => x.count > 0),
    check_tier: [{ key: "full", count: Math.round(sessions * 0.93) }, { key: "light", count: Math.round(sessions * 0.07) }],
    visual_setting: [{ key: "on", count: sessions }],
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
      ix_views: views, ix_engaged_ms: engagedMs, ix_click: total(ixClick), ix_rage: total(ixRage), ix_dead: total(ixDead), ix_sessions: visitCount,
      ix_entry: total(ixEntry), ix_exit: total(ixExit),
      checks, checksWithPage: checks, check_loads: sessions, visual_fix: sessions, check_ms: Math.round(sessions * 38),
    },
    breakdowns,
    distinct: Object.fromEntries(Object.entries(breakdowns).map(([k, v]) => [k, v.length])),
    series,
    typeSeries,
    checkSeries,
    previous: { sessions: Math.round(sessions * 0.94), detections: Math.round(detections * 1.15), acted: Math.max(0, interventions - 2), checks: Math.round(checks * 1.3), ix_views: Math.round(views * 0.91), ix_sessions: Math.round(visitCount * 0.88) },
    recent,
    agent: sampleAgent(now),
    visits: { sessions: visitCount, pages: views, bounces: Math.round(visitCount * 0.41), entry: shareOf(ENTRY), exit: shareOf(EXIT) },
    funnels: FUNNELS.map(([name, steps, f]) => ({ name, steps, counts: f.map((x) => Math.round(visitCount * x)) })),
  };
}

/**
 * What a coding agent reported on the sample app: one problem proven fixed and closed (after a first fix that did not
 * hold), one reproduced and tested, one found; and the log those steps left, newest first.
 */
function sampleAgent(now: Date): Stats["agent"] {
  const t = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const findings: Stats["agent"]["findings"] = [
    { id: "f3", kind: "stale-write", route: "/search", found: t(310), explained: t(245), replayed: t(42), reproduced: false, reproducedN: 2, tested: t(240), proven: t(42), closed: true, updated: t(42) },
    { id: "f7", kind: "duplicate-request", route: "/checkout", found: t(95), explained: t(72), replayed: t(80), reproduced: true, reproducedN: 1, tested: t(70), proven: null, closed: false, updated: t(70) },
    { id: "f9", kind: "error", route: "/products/:id", found: t(12), explained: null, replayed: null, reproduced: null, reproducedN: 0, tested: null, proven: null, closed: false, updated: t(12) },
  ];
  const f3 = { id: "f3", kind: "stale-write", route: "/search" };
  const f7 = { id: "f7", kind: "duplicate-request", route: "/checkout" };
  const none = { id: null, kind: null, route: null };
  const row = (minAgo: number, t2: string, f: { id: string | null; kind: string | null; route: string | null }, x: Partial<Stats["agent"]["log"][number]> = {}): Stats["agent"]["log"][number] => ({
    at: t(minAgo), t: t2, id: f.id, kind: f.kind, route: f.route, reproduced: null, runs: null, races: null, what: null, ...x,
  });
  const log: Stats["agent"]["log"] = [
    row(12, "found", { id: "f9", kind: "error", route: "/products/:id" }),
    row(42, "replay", f3, { reproduced: false }),
    row(55, "armed", f3),
    row(70, "test", f7),
    row(72, "explain", f7),
    row(80, "replay", f7, { reproduced: true }),
    row(85, "armed", f7),
    row(95, "found", f7),
    row(120, "replay", f3, { reproduced: true }),
    row(130, "armed", f3),
    row(180, "explore", { ...none, route: "/search" }, { runs: 8, races: 1 }),
    row(240, "test", f3),
    row(245, "explain", f3),
    row(290, "replay", f3, { reproduced: true }),
    row(300, "armed", f3),
    row(310, "found", f3),
  ];
  return { findings, counts: { found: 3, reproduced: 2, tested: 2, proven: 1 }, stages: { found: 3, explained: 2, reproduced: 2, fixed: 1, closed: 1, open: 2, continued: 1 }, log, last: t(12) };
}

// The free summary behind `npx @genclass/runtime stats`: a few totals, the top 3 problem types and pages, and whether
// the app's dashboard is open, for the last 24 hours or 7 days.
//
// Routes (src/collector.ts, src/auth.ts):
//   GET /api/projects/<secret>/summary?range=24h|7d         the private link's secret (or `sample`); anyone with it
//   GET /api/account/projects/<id>/summary?range=24h|7d     browser session or CLI bearer; the app must be the account's
//
// Invariants:
// - It reads only counters the collector already keeps (D1 `daily` for 7d, `hourly` for 24h, written by
//   dashboard.ts aggregate()) and the `projects` row (name, created, last_event). Nothing new is collected for it.
// - It is deliberately smaller than the dashboard: totals, at most SUMMARY_TOP diagnoses and pages, two ranges. No
//   series, recent rows, breakdowns or distinct-key lists; those are the dashboard's (Pro).
// - It is not gated by the plan: `dashboard.locked` says whether the dashboard opens. Any other range is answered for 7d.
// - Rate limited per IP (LIMIT, its own key) and per secret or account (SUMMARY_LIMIT, 30 / 60 s); both are best effort.
// - Route and diagnosis keys come from any page that holds the public app token, so they are printed in a terminal
//   only after printable() strips control, bidi and zero-width characters (`stats` does the same on its side).

import type { Env, RateLimiterLike } from "./collector.js";
import { dayKey, hourKey, sha256Hex, type D1Like, type Project, type Stats } from "./dashboard.js";
import { json } from "./http.js";

export type SummaryRange = "24h" | "7d";
export const SUMMARY_RANGES: SummaryRange[] = ["24h", "7d"];
/** Entries per top list. */
export const SUMMARY_TOP = 3;
const MODES = ["observe", "guard", "heal"];

export interface SummaryDashboard {
  /** The private link (/dashboard/<secret>) or the account's app page (/account/apps/<id>). */
  url: string;
  /** True while the app's account has no Pro (a plan, GenClass's grant or a trial): the dashboard is locked. */
  locked: boolean;
  /**
   * Where the 7-day free trial for analytics starts: /account/trial for an app in an account; for an app with only a
   * private link, that link (its locked page signs in, adds the app to an account and starts the trial there).
   */
  trialUrl: string;
  /** False when the app's account already had its one trial, or has Pro now; true for an app in no account. */
  trialAvailable: boolean;
}

export interface Summary {
  ok: true;
  name: string;
  created: string;
  lastEvent: string | null;
  range: SummaryRange;
  /** Start of the first hour (24h) or UTC day (7d) counted. */
  from: string;
  generated: string;
  totals: {
    /** Page loads (metric `sessions`). */
    sessions: number;
    /** Problems found (metric `detections`). */
    detections: number;
    /** Lower-confidence detections (metric `possible`), never part of `detections`. */
    possible: number;
    /** Times GenClass acted (metric `acted`). */
    acted: number;
    /** Distinct pages with a problem (keys of `detect_route`). */
    pagesAffected: number;
    /**
     * Distinct pages that sent data: where page loads started (`page_route`) and where GenClass made a decision
     * (`route`, `detect_route`), so a single-page app's pages after client-side navigation count too. Never less
     * than pagesAffected.
     */
    pagesSeen: number;
    /** model_ready / sessions (0 to 1, 3 decimals); null with no page loads or no model load reported at all. */
    modelLoadedShare: number | null;
    /** model_load_ms_sum / model_load_ms_n, rounded; null when no load time was reported. */
    modelLoadMsAvg: number | null;
  };
  /**
   * The same totals over the period of the same length just before. The current range ends now, partway through its
   * last hour or day, so the previous one is as long: its full buckets and, of its first bucket, the same share (an
   * estimate that assumes even traffic within that one bucket), rounded.
   */
  previous: { sessions: number; detections: number };
  top: { diagnoses: { key: string; count: number }[]; routes: { key: string; count: number }[] };
  /** The runtime's effective mode across page loads (metric `mode`): one of them, "mixed", or null when unknown. */
  mode: "observe" | "guard" | "heal" | "mixed" | null;
  dashboard: SummaryDashboard;
  limits: { ranges: SummaryRange[]; top: number };
}

/** 24h or 7d; anything else is 7d, for every plan. */
export const summaryRange = (v: string | null): SummaryRange => (v === "24h" ? "24h" : "7d");

type Row = { key: string; count: number };

/** A key as text a terminal can print: no control, bidi or zero-width characters, at most 120 characters. */
export function printable(v: string): string {
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "").trim();
  return [...s].slice(0, 120).join("") || "(unknown)";
}

/** What build() needs: plain totals (key ""), full key lists per metric, and the previous period. */
interface Parts {
  totals: Record<string, number>;
  lists: Record<string, Row[]>;
  previous: { sessions: number; detections: number };
}

/** The SUMMARY_TOP largest, most first (ties by key), with printable keys (keys that clean to the same text merge). */
function top(list: Row[] | undefined): Row[] {
  const by = new Map<string, number>();
  for (const x of list ?? []) {
    const k = printable(x.key);
    by.set(k, (by.get(k) ?? 0) + x.count);
  }
  return [...by].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, SUMMARY_TOP);
}

/** Distinct keys across several key lists. */
const distinct = (...lists: (Row[] | undefined)[]): number => new Set(lists.flatMap((l) => (l ?? []).map((x) => x.key))).size;

function modeOf(list: Row[] | undefined): Summary["mode"] {
  const keys = [...new Set((list ?? []).filter((x) => x.count > 0 && x.key !== "(unknown)").map((x) => x.key))];
  if (keys.length > 1) return "mixed";
  if (keys.length === 1 && MODES.includes(keys[0]!)) return keys[0] as Summary["mode"];
  return null;
}

function build(meta: { name: string; created: string; lastEvent: string | null }, range: SummaryRange, from: string, now: Date, parts: Parts, dashboard: SummaryDashboard): Summary {
  const t = parts.totals;
  const n = (m: string) => Number(t[m] ?? 0) || 0;
  const sessions = n("sessions");
  const ready = n("model_ready");
  const loads = ready + n("model_load_failed");
  return {
    ok: true,
    name: meta.name,
    created: meta.created,
    lastEvent: meta.lastEvent,
    range,
    from,
    generated: now.toISOString(),
    totals: {
      sessions,
      detections: n("detections"),
      possible: n("possible"),
      acted: n("acted"),
      pagesAffected: (parts.lists.detect_route ?? []).length,
      pagesSeen: distinct(parts.lists.page_route, parts.lists.route, parts.lists.detect_route),
      modelLoadedShare: sessions > 0 && loads > 0 ? Math.round(1000 * Math.min(1, ready / sessions)) / 1000 : null,
      modelLoadMsAvg: n("model_load_ms_n") > 0 ? Math.round(n("model_load_ms_sum") / n("model_load_ms_n")) : null,
    },
    previous: parts.previous,
    top: { diagnoses: top(parts.lists.detect_diagnosis), routes: top(parts.lists.detect_route) },
    mode: modeOf(parts.lists.mode),
    dashboard,
    limits: { ranges: [...SUMMARY_RANGES], top: SUMMARY_TOP },
  };
}

const LIST_METRICS = ["detect_diagnosis", "detect_route", "page_route", "route", "mode"];
const TOTAL_METRICS = ["sessions", "detections", "possible", "acted", "model_ready", "model_load_failed", "model_load_ms_sum", "model_load_ms_n"];

/** An app's summary from its D1 counters (24h: `hourly`, 7d: `daily`), with the same buckets as stats(). */
export async function summary(db: D1Like, p: Project, range: SummaryRange, now: Date, dashboard: SummaryDashboard): Promise<Summary> {
  const hourly = range === "24h";
  const table = hourly ? "hourly" : "daily";
  const col = hourly ? "hour" : "day";
  const span = hourly ? 24 : 7;
  const step = hourly ? 3_600_000 : 86_400_000;
  const first = new Date(now.getTime() - (span - 1) * step);
  const from = hourly ? hourKey(first) : dayKey(first);
  const fromIso = hourly ? `${from}:00:00.000Z` : `${from}T00:00:00.000Z`;
  const prevStart = new Date(Date.parse(fromIso) - span * step);
  const prevFrom = hourly ? hourKey(prevStart) : dayKey(prevStart);
  // how far into its last bucket the current range is (0 to 1): the previous range takes that share of its first one
  const current = Date.parse(fromIso) + (span - 1) * step;
  const share = Math.min(1, Math.max(0, (now.getTime() - current) / step));
  const metrics = [...TOTAL_METRICS, ...LIST_METRICS];
  const [agg, prev] = await db.batch([
    db
      .prepare(`SELECT metric, key, SUM(count) AS c FROM ${table} WHERE token = ? AND ${col} >= ? AND metric IN (${metrics.map(() => "?").join(", ")}) GROUP BY metric, key`)
      .bind(p.token, from, ...metrics),
    db
      .prepare(`SELECT metric, ${col} AS b, SUM(count) AS c FROM ${table} WHERE token = ? AND ${col} >= ? AND ${col} < ? AND key = '' AND metric IN ('sessions', 'detections') GROUP BY metric, ${col}`)
      .bind(p.token, prevFrom, from),
  ]);
  const rows = (r: unknown) => ((r as { results?: Record<string, unknown>[] })?.results ?? []) as Record<string, unknown>[];
  const totals: Record<string, number> = {};
  const lists: Record<string, Row[]> = {};
  for (const r of rows(agg)) {
    const metric = String(r.metric);
    const key = String(r.key ?? "");
    const c = Number(r.c) || 0;
    if (key === "") totals[metric] = (totals[metric] ?? 0) + c;
    else if (LIST_METRICS.includes(metric)) (lists[metric] ??= []).push({ key, count: c });
  }
  const previous = { sessions: 0, detections: 0 };
  for (const r of rows(prev)) {
    const m = String(r.metric);
    const weight = String(r.b) === prevFrom ? share : 1;
    if (m === "sessions" || m === "detections") previous[m] += (Number(r.c) || 0) * weight;
  }
  previous.sessions = Math.round(previous.sessions);
  previous.detections = Math.round(previous.detections);
  return build({ name: p.name, created: p.created, lastEvent: p.last_event }, range, fromIso, now, { totals, lists, previous }, dashboard);
}

/** The sample's summary, from the same simulated stats as the sample dashboard (src/sample.ts). */
export function summaryFromStats(s: Stats, dashboard: SummaryDashboard, now: Date): Summary {
  const range: SummaryRange = s.range === "24h" ? "24h" : "7d";
  // stats() totals carry the average load time (modelLoadAvgMs); the sample has no sum and count behind it
  const totals = { ...s.totals };
  if (!totals.model_load_ms_n && totals.modelLoadAvgMs) Object.assign(totals, { model_load_ms_sum: totals.modelLoadAvgMs, model_load_ms_n: 1 });
  return build(
    { name: s.name, created: s.created, lastEvent: s.lastEvent },
    range,
    s.from,
    now,
    { totals, lists: s.breakdowns, previous: { sessions: s.previous.sessions, detections: s.previous.detections } },
    dashboard,
  );
}

/** One limiter check under a hashed key; a missing or failing limiter lets the request through (best effort). */
async function under(lim: RateLimiterLike | undefined, key: string): Promise<boolean> {
  if (!lim) return true;
  try {
    return (await lim.limit({ key: (await sha256Hex(key)).slice(0, 32) })).success;
  } catch {
    return true;
  }
}

/** The 429 a summary request gets over either budget. */
export const summaryTooMany = (): Response => json(429, { ok: false, error: "too many summary requests; try again in a minute" }, { "retry-after": "60" });

/**
 * The summary's rate limits: per client IP (LIMIT, under its own key, so it never shares the batches' budget; the IP is
 * only hashed into the key, never stored) and, when `scope` is given, per dashboard secret or account (SUMMARY_LIMIT).
 * Returns the 429 to send, or null.
 */
export async function summaryLimited(env: Env, request: Request, scope: string | null): Promise<Response | null> {
  if (!(await under(env.LIMIT, `summary:ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`))) return summaryTooMany();
  if (scope !== null && !(await under(env.SUMMARY_LIMIT, `summary:${scope}`))) return summaryTooMany();
  return null;
}

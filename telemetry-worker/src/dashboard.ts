// Per-app tokens and dashboards: D1 storage, aggregation of telemetry batches, stats for the dashboard, retention.
//
// - A token (`gc_` + 22 base62) identifies one web app. It is public (ships in client code) and only lets data be
//   sent. The dashboard secret (32 base62) is private; only its SHA-256 hex is stored.
// - Aggregates are counters per (token, UTC day | UTC hour, metric, key). No situation text, no IP, no user agent.
// - Totals are exact: page loads, decisions, detections (and by diagnosis), acted, triggers and the loss counters come
//   from each page load's cumulative `summary` once it arrives, and from its events until then, through a per-page-load
//   high-water mark (sessions table) updated under optimistic concurrency, so a repeated, split or concurrently
//   processed batch is never counted twice. Routes, functions and recent rows always come from the events.
// - "Possible issues": the runtime's own lower detection tier (0.3.0, observe mode: under the report gate, at or over
//   the eager profile's report value), sent as `detect` events with `tier: "possible"` and counted in
//   `summary.counts.possibleDetections`. Their own metrics (possible, possible_*), exact like detections, never in
//   detections or detect_diagnosis. The worker never derives the tier from decision records: what the dashboard lists
//   is what the page's console listed.
// - Interaction analytics (runtime `interactions` events, docs/runtime/ANALYTICS.md; only from apps that turned them on):
//   page views, engaged time, scroll milestones, and clicks, rage clicks and dead clicks per page and element key, as
//   ix_* counters with their own per-batch budget (MAX_IX_COUNTERS), so they never crowd out the diagnostics counters.
//   The runtime sends deltas, so they are plain counters like routes: a repeated batch is skipped as a whole.
//   Visits (ANALYTICS.md section 1.2): the view that opens a visit adds per visit counters (where it came from: the
//   referring host and utm values; device class, browser and OS families; the country from request.cf; new or
//   returning) and every view's route goes into the visit's row (`visits`, keyed by a hash of the token and the
//   visit id), which entry and exit pages, pages per visit and funnels are counted from. Every value is checked
//   against an allowlist or a pattern here, whatever the client sent.
// - Funnels: up to MAX_FUNNELS per app (projects.funnels), each 2 to MAX_STEPS routes; a step is counted for the visits
//   whose routes include every step up to it in order (GLOB on the visit's route list), so a funnel defined today
//   counts the visits already stored.
// - Retention (daily cron): daily counters and recent rows 90 days, hourly counters 48 hours, summary state 2 days,
//   visits 90 days (on every plan).

import { json, readCapped } from "./http.js";

export const TOKEN_RE = /^gc_[A-Za-z0-9]{22}$/;
export const SECRET_RE = /^[A-Za-z0-9]{32}$/;
/** A project's stable id (16 lowercase hex), used in account URLs; the token stays the public key. */
export const PROJECT_ID_RE = /^[0-9a-f]{16}$/;
export const RECENT_CAP = 500;
export const RETENTION_DAYS = 90;
/** Distinct counters one batch may touch (bounds D1 writes per batch). */
export const MAX_COUNTERS = 300;
/** Distinct interaction analytics counters one batch may touch, on top of MAX_COUNTERS. */
export const MAX_IX_COUNTERS = 200;
/** Page-load state is kept this long after its last batch (retention); a page load quiet for longer starts a baseline. */
export const SESSION_KEEP_MS = 2 * 86_400_000;
const KEY_MAX = 120;
const ROWS_PER_STMT = 16; // 5 bound params per row; D1 allows 100 per statement

// --------------------------------------------------------------------------------------------- D1 subset

export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(stmts: D1Stmt[]): Promise<unknown[]>;
}

// --------------------------------------------------------------------------------------------- ids, hashing

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** n base62 chars from crypto.getRandomValues, unbiased (rejection sampling). */
export function randomBase62(n: number): string {
  let out = "";
  while (out.length < n) {
    const bytes = crypto.getRandomValues(new Uint8Array(n * 2));
    for (const b of bytes) {
      if (b < 248) out += B62[b % 62];
      if (out.length === n) break;
    }
  }
  return out;
}

export const newToken = (): string => `gc_${randomBase62(22)}`;
export const newSecret = (): string => randomBase62(32);
/** 16 lowercase hex, the same shape migration 0003 gave existing projects (lower(hex(randomblob(8)))). */
export const newProjectId = (): string => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Project name: printable text, whitespace collapsed, at most 80 chars; default "Untitled app". */
export function sanitizeName(v: unknown): string {
  if (typeof v !== "string") return "Untitled app";
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  const cut = [...s].slice(0, 80).join("").trim();
  return cut || "Untitled app";
}

export const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
export const hourKey = (d: Date): string => d.toISOString().slice(0, 13);

// --------------------------------------------------------------------------------------------- projects

export interface Project {
  /** Stable id (PROJECT_ID_RE); null only for a row written by code older than migration 0003. */
  id: string | null;
  token: string;
  name: string;
  created: string;
  last_event: string | null;
  first_event: string | null;
  /** The owning account, or null for a project known only by its private dashboard link. */
  account_id: string | null;
  /** 1 when a private dashboard link (/dashboard/<secret>) opens this project; 0 for an app created in an account
   * (nobody was given a link) or one whose owner turned its link off. */
  private_link: number;
}

export const PROJECT_COLUMNS = "id, token, name, created, last_event, first_event, account_id, private_link";

/**
 * Create a project. Without an account it is reachable through its private dashboard link (the secret, returned once).
 * With an account the secret is generated and hashed the same way (the column is required) but the caller does not
 * show it and `private_link` is 0: the app is opened from the account only.
 */
export async function createProject(
  db: D1Like,
  name: string,
  now: Date,
  accountId: string | null = null,
): Promise<{ id: string; token: string; secret: string; name: string; created: string }> {
  for (let attempt = 0; ; attempt++) {
    const id = newProjectId();
    const token = newToken();
    const secret = newSecret();
    const created = now.toISOString();
    try {
      await db
        .prepare("INSERT INTO projects (id, token, secret_hash, name, created, account_id, private_link) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, token, await sha256Hex(secret), name, created, accountId, accountId ? 0 : 1)
        .run();
      tokenCache.set(token, { ok: true, exp: now.getTime() + CACHE_OK_MS });
      return { id, token, secret, name, created };
    } catch (e) {
      if (attempt >= 2) throw e; // a collision is astronomically unlikely; anything else is a real error
    }
  }
}

/**
 * Projects created after `since` (all clients together), for the global creation ceilings. Anonymous creation
 * (/api/projects) and creation in an account have separate ceilings, so a flood of anonymous requests cannot stop
 * signed-in owners from creating apps, nor the reverse.
 */
export async function projectsCreatedSince(db: D1Like, since: Date, by: "anonymous" | "account"): Promise<number> {
  const owner = by === "account" ? "account_id IS NOT NULL" : "account_id IS NULL";
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE created > ? AND ${owner}`).bind(since.toISOString()).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Look a project up by its dashboard secret (by hash, so lookup time does not depend on how much of it matches). */
export async function projectBySecret(db: D1Like, secret: string): Promise<Project | null> {
  if (!SECRET_RE.test(secret)) return null;
  return db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE secret_hash = ?`)
    .bind(await sha256Hex(secret))
    .first<Project>();
}

/** Drop a deleted project's token from this isolate's cache, so its batches stop being counted here at once. */
export function forgetToken(token: string): void {
  tokenCache.delete(token);
}

const CACHE_OK_MS = 5 * 60_000;
const CACHE_MISS_MS = 30_000;
const tokenCache = new Map<string, { ok: boolean; exp: number }>();
export function resetTokenCache(): void {
  tokenCache.clear();
}

/** Is this a token of a known project? Cached in memory briefly (5 min hits, 30 s misses). */
export async function knownToken(db: D1Like, token: string, nowMs: number): Promise<boolean> {
  if (!TOKEN_RE.test(token)) return false;
  const c = tokenCache.get(token);
  if (c && c.exp > nowMs) return c.ok;
  const row = await db.prepare("SELECT 1 AS ok FROM projects WHERE token = ?").bind(token).first();
  const ok = !!row;
  if (tokenCache.size > 5000) tokenCache.clear();
  tokenCache.set(token, { ok, exp: nowMs + (ok ? CACHE_OK_MS : CACHE_MISS_MS) });
  return ok;
}

// --------------------------------------------------------------------------------------------- aggregation

type Ev = Record<string, unknown>;
export interface AggBatch {
  sid: string;
  runtime: string;
  model: string | null;
  events: Ev[];
  /** The collector's coarse country for this request (request.cf.country), counted once per visit. */
  country?: string | null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? [...v.trim()].slice(0, KEY_MAX).join("") : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const LATENCY_BUCKETS: [number, string][] = [
  [50, "<50 ms"],
  [100, "50-100 ms"],
  [250, "100-250 ms"],
  [500, "250-500 ms"],
  [1000, "0.5-1 s"],
  [2500, "1-2.5 s"],
  [Infinity, ">2.5 s"],
];
const latencyBucket = (ms: number): string => LATENCY_BUCKETS.find(([max]) => ms < max)![1];

class Counters {
  readonly m = new Map<string, number>();
  constructor(private readonly cap = MAX_COUNTERS) {}
  add(metric: string, key: string | undefined = "", n = 1): void {
    if (!(n > 0) || !Number.isFinite(n)) return;
    const k = `${metric}\u0000${key ?? ""}`;
    const prev = this.m.get(k);
    if (prev === undefined && this.m.size >= this.cap) return;
    this.m.set(k, (prev ?? 0) + n);
  }
}

interface RecentRow {
  route?: string;
  fn?: string;
  trigger?: string;
  diagnosis?: string;
  action?: string;
  ran?: string;
  confidence?: number;
  mode?: string;
  executed?: boolean;
  acted?: boolean;
  kind: "detect" | "acted";
}

// ------------------------------------------------------------------------------------------ exact totals

/**
 * Metrics counted exactly per page load: metric -> key -> count (key "" for a plain total). A page load's `summary`
 * carries them cumulatively (summaryValues); its events carry the same counts one at a time, which is what counts
 * before the first summary arrives and for fields a client's summary lacks.
 */
export type Exact = Record<string, Record<string, number>>;
/** One event's share of the exact metrics; `seq` is the event's sequence number in its page load (null without one). */
export interface Contribution {
  seq: number | null;
  m: string;
  k: string;
  n: number;
}
/** The newest `summary` in a batch: its seq, its `at` (ms since the page load started) and its exact values. */
export interface SummaryValues {
  seq: number;
  at: number;
  values: Exact;
}

/** Keys kept per exact metric and their length (summary maps and page-load state stay small). */
const EXACT_KEYS = 24;
const EXACT_KEY_MAX = 64;
/** Event seq ranges remembered per page load (closest ranges are merged beyond this). */
const MAX_RANGES = 16;
/** Tries when another batch of the same page load updates its state at the same time. */
const MAX_ATTEMPTS = 4;
const STATE_MAX = 64 * 1024;

const obj = (v: unknown): Ev => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Ev) : {});
const cutKey = (k: string): string => [...k.trim()].slice(0, EXACT_KEY_MAX).join("");
const ekey = (v: unknown, fallback: string): string => cutKey(str(v) ?? fallback);
const seqOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

function put(x: Exact, m: string, k: string, n: number, add: boolean): void {
  const row = (x[m] ??= {});
  if (!(k in row) && Object.keys(row).length >= EXACT_KEYS) return;
  row[k] = add ? (row[k] ?? 0) + n : n;
}

function countMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(v))) {
    const x = num(n);
    if (x === undefined || x <= 0) continue;
    const key = cutKey(k);
    if (!(key in out) && Object.keys(out).length >= EXACT_KEYS) continue;
    out[key] = (out[key] ?? 0) + x;
  }
  return out;
}

function exactOf(v: unknown): Exact {
  const out: Exact = {};
  for (const [m, row] of Object.entries(obj(v))) {
    const r = countMap(row);
    if (Object.keys(r).length) out[m] = r;
  }
  return out;
}

/**
 * The exact values a `summary` event carries (packages/runtime/src/telemetry/client.ts, summary()). A field the summary
 * does not have stays absent, so its events keep counting for it; a present one (even 0 or {}) covers every event
 * before the summary.
 */
export function summaryValues(e: Ev): SummaryValues {
  const counts = obj(e.counts);
  const model = obj(obj(e.runtime).model);
  const tel = obj(e.telemetry);
  const values: Exact = { sessions: { "": 1 } };
  const one = (m: string, v: unknown) => {
    const x = num(v);
    if (x !== undefined && x >= 0) values[m] = { "": x };
  };
  const many = (m: string, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) values[m] = countMap(v);
  };
  one("decisions", counts.decisions);
  one("acted", counts.acted);
  one("detections", counts.detections);
  // 0.3.0: observe's possible detections, which `detections` (the likely ones) leaves out
  one("possible", counts.possibleDetections);
  one("vetoes", counts.vetoes);
  one("breaker_trips", counts.breakerTrips);
  many("trigger", counts.byTrigger);
  many("diagnosis", counts.byDiagnosis);
  many("detect_diagnosis", counts.detectionsByDiagnosis);
  if ([counts.actionsOk, counts.actionsFailed, counts.undos].some((x) => num(x) !== undefined)) {
    values.action_outcome = countMap({ applied: counts.actionsOk, failed: counts.actionsFailed, undone: counts.undos });
  }
  many("fail_open", counts.failOpen);
  many("model_errors", counts.modelErrors);
  many("action_limits", counts.limits);
  one("hidden_skipped", model.hiddenSkipped);
  one("model_dropped", model.dropped);
  one("telemetry_dropped", tel.dropped);
  one("records_sampled_out", tel.decisionsSampledOut);
  one("records_capped", tel.decisionsCapped);
  return { seq: seqOf(e.seq) ?? 0, at: num(e.at) ?? 0, values };
}

// Interaction analytics (`interactions` events): what one event may add. The runtime sends at most 50 element keys
// for clicks and 20 each for rage and dead clicks; anything beyond these bounds is not a real page.
const IX_KEYS = 60;
const IX_MAX_COUNT = 10_000;
const IX_MAX_MS = 86_400_000;
const IX_MILESTONES = new Set([25, 50, 75, 100]);
const IX_FIELDS: [string, string][] = [
  ["clicks", "ix_click"],
  ["rage", "ix_rage"],
  ["dead", "ix_dead"],
];
const chars = (s: string, n: number): string => [...s].slice(0, n).join("");

// Visits: what the view opening one may say (the runtime's buckets, src/analytics/index.ts deviceOf), and bounds.
export const VISIT_RE = /^[0-9a-f]{16}$/;
const DEVICES = new Set(["desktop", "mobile", "tablet"]);
const BROWSERS = new Set(["Chrome", "Safari", "Firefox", "Edge", "Opera", "Samsung Internet", "Other"]);
const OSES = new Set(["Windows", "macOS", "iOS", "Android", "Linux", "ChromeOS", "Other"]);
const REF_RE = /^[a-z0-9][a-z0-9.-]{0,79}$/;
const UTM_RE = /^[a-z0-9][a-z0-9 ._+-]{0,39}$/;
/** Distinct visits one batch may add to (a page load names one, rarely two), and routes per visit per batch. */
const VISITS_PER_BATCH = 5;
/** A visit's row keeps the routes of about its first this many page views (funnels look no further). */
export const VISIT_ROUTES = 50;
/** One batch's page views for one visit, in order; `entry` when one of them opened the visit. */
export interface VisitPart {
  routes: string[];
  entry: boolean;
}
/** A route as it goes into a visit's route list: no tabs (the separator), at most 100 characters. */
const visitRoute = (r: string): string => chars(r.replace(/\t/g, " "), 100);

/**
 * One `interactions` event into ix_* counters (key "" is the total; the route, or route TAB element key, the
 * breakdown): ix_views (a view's first event), ix_engaged_ms, ix_scroll (route TAB milestone), ix_click, ix_rage,
 * ix_dead. Element keys are selectors and names from the page's markup, never its text (the runtime builds them).
 */
function interactions(ix: Counters, e: Ev, visits: Map<string, VisitPart>, country: string | null | undefined): void {
  const route = chars(str(e.route) ?? "(unknown)", 100);
  if (e.start === true) {
    ix.add("ix_views");
    ix.add("ix_views", route);
    const v = typeof e.visit === "string" && VISIT_RE.test(e.visit) ? e.visit : null;
    if (v && (visits.has(v) || visits.size < VISITS_PER_BATCH)) {
      const part = visits.get(v) ?? { routes: [], entry: false };
      visits.set(v, part);
      if (part.routes.length < VISIT_ROUTES) part.routes.push(visitRoute(route));
      if (e.entry === true && !part.entry) {
        part.entry = true;
        visitCounters(ix, e, country);
      }
    }
  }
  const ms = num(e.engagedMs);
  if (ms !== undefined && ms > 0 && ms <= IX_MAX_MS) {
    ix.add("ix_engaged_ms", "", ms);
    ix.add("ix_engaged_ms", route, ms);
  }
  if (Array.isArray(e.scroll)) for (const m of new Set(e.scroll)) if (IX_MILESTONES.has(m as number)) ix.add("ix_scroll", `${route}\t${m}`);
  for (const [field, metric] of IX_FIELDS) {
    for (const [k, v] of Object.entries(obj(e[field])).slice(0, IX_KEYS)) {
      const n = num(v);
      const el = chars(k.trim(), KEY_MAX);
      if (n === undefined || n <= 0 || n > IX_MAX_COUNT || !el) continue;
      ix.add(metric, "", n);
      ix.add(metric, `${route}\t${el}`, n);
    }
  }
}

/**
 * The counters of a view that opened a visit, one each: ix_sessions, ix_ref (the referring host, or "(direct)"),
 * ix_utm_source / ix_utm_medium / ix_utm_campaign (when sent), ix_device, ix_browser, ix_os, ix_country,
 * ix_returning ("new" or "returning", when the runtime could tell). Values outside the allowlists are not counted.
 */
function visitCounters(ix: Counters, e: Ev, country: string | null | undefined): void {
  ix.add("ix_sessions");
  const ref = typeof e.ref === "string" ? e.ref : undefined;
  ix.add("ix_ref", ref === undefined ? "(direct)" : ref === "(other)" || REF_RE.test(ref) ? ref : "(other)");
  const utm = obj(e.utm);
  for (const f of ["source", "medium", "campaign"]) {
    const v = utm[f];
    if (typeof v === "string" && UTM_RE.test(v)) ix.add(`ix_utm_${f}`, v);
  }
  for (const [field, metric, ok] of [
    ["device", "ix_device", DEVICES],
    ["browser", "ix_browser", BROWSERS],
    ["os", "ix_os", OSES],
  ] as const) {
    const v = e[field];
    ix.add(metric, typeof v === "string" && ok.has(v) ? v : field === "device" ? "(unknown)" : "Other");
  }
  ix.add("ix_country", country && /^[A-Z0-9]{2}$/.test(country) ? country : "(unknown)");
  if (typeof e.returning === "boolean") ix.add("ix_returning", e.returning ? "returning" : "new");
}

/** Pure part of the aggregation: event counters, recent rows and exact-metric contributions for one batch (exported for tests). */
export function summarize(batch: AggBatch): {
  counters: Counters;
  ix: Counters;
  recent: RecentRow[];
  exact: Contribution[];
  seqs: number[];
  summary?: SummaryValues;
  visits: Map<string, VisitPart>;
} {
  const c = new Counters();
  const ix = new Counters(MAX_IX_COUNTERS);
  const visits = new Map<string, VisitPart>();
  const recent: RecentRow[] = [];
  const exact: Contribution[] = [];
  const seqs: number[] = [];
  const decisions = new Map<string, Ev>();
  for (const e of batch.events) if (e.t === "decision" && typeof e.id === "string") decisions.set(e.id, e);
  const detected = new Set<string>();
  let summary: Ev | undefined;

  for (const e of batch.events) {
    const seq = seqOf(e.seq);
    if (seq !== null) seqs.push(seq);
    const x = (m: string, k = "") => exact.push({ seq, m, k, n: 1 });
    switch (e.t) {
      case "session": {
        x("sessions");
        c.add("host", str(e.host) ?? "(unknown)");
        c.add("page_route", str(e.route) ?? "(unknown)");
        c.add("runtime", str(e.runtime) ?? str(batch.runtime) ?? "(unknown)");
        c.add("model_version", str(e.modelVersion) ?? str(batch.model) ?? "none");
        c.add("mode", str(e.effectiveMode) ?? str(e.mode) ?? "(unknown)");
        c.add("model_kind", str(e.model) ?? "(unknown)");
        const dev = e.device as Ev | undefined;
        if (dev && typeof dev === "object") c.add("webgpu_available", dev.webgpu ? "yes" : "no");
        break;
      }
      case "model": {
        const state = str(e.state);
        if (!state) break;
        c.add("model_state", state);
        if (state === "ready") {
          c.add("model_ready");
          c.add("backend", str(e.device) ?? "(unknown)");
          const ms = num(e.loadMs);
          if (ms !== undefined && ms >= 0) {
            c.add("model_load_ms_sum", "", ms);
            c.add("model_load_ms_n");
          }
          if (e.fromCache === true) c.add("model_from_cache");
        } else if (state === "error") {
          c.add("model_load_failed");
        }
        break;
      }
      case "decision": {
        x("decisions");
        x("trigger", ekey(e.trigger, "(unknown)"));
        c.add("route", str(e.route) ?? "(unknown)");
        const fn = str(e.fn);
        if (fn) c.add("fn", fn);
        x("diagnosis", ekey(e.diagnosis, "(unknown)"));
        c.add("decision_mode", str(e.effectiveMode) ?? "(unknown)");
        if (e.executed === true) c.add("executed");
        if (e.acted === true) {
          x("acted");
          c.add("acted_action", str(e.ran) ?? str(e.action) ?? "(unknown)");
          if (fn) c.add("fn_acted", fn);
        }
        const lat = num(e.latencyMs);
        if (lat !== undefined && lat >= 0) {
          c.add("latency_ms_sum", "", lat);
          c.add("latency_ms_n");
          c.add("latency_bucket", latencyBucket(lat));
        }
        break;
      }
      case "detect": {
        const d = typeof e.decision === "string" ? decisions.get(e.decision) : undefined;
        if (e.tier === "possible") {
          // runtime 0.3.0's possible tier: its own metrics, never a detection (no tier, or any other value, is one)
          x("possible");
          x("possible_diagnosis", ekey(e.diagnosis, "(unknown)"));
          if (d) {
            const route = str(d.route) ?? "(unknown)";
            c.add("possible_route", route);
            c.add("possible_issue", `${str(e.diagnosis) ?? "(unknown)"}\t${route}`);
            const fn = str(d.fn);
            if (fn) c.add("possible_fn", fn);
          }
          break;
        }
        x("detections");
        x("detect_diagnosis", ekey(e.diagnosis, "(unknown)"));
        c.add("detect_trigger", str(e.trigger) ?? "(unknown)");
        if (typeof e.decision === "string") detected.add(e.decision);
        if (d) {
          c.add("detect_route", str(d.route) ?? "(unknown)");
          // type x page, for the dashboard's "where" view (tab-separated: diagnosis, route)
          c.add("detect_issue", `${str(e.diagnosis) ?? "(unknown)"}\t${str(d.route) ?? "(unknown)"}`);
          const fn = str(d.fn);
          if (fn) c.add("fn_detect", fn);
        } else {
          recent.push({ kind: "detect", trigger: str(e.trigger), diagnosis: str(e.diagnosis), confidence: num(e.p) });
        }
        break;
      }
      case "action": {
        const outcome = str(e.outcome) ?? "(unknown)";
        x("action_outcome", cutKey(outcome));
        if (outcome === "applied") c.add("intervention", str(e.action) ?? "(unknown)");
        break;
      }
      case "veto":
        x("vetoes");
        break;
      case "breaker":
        if (e.tripped === true) x("breaker_trips");
        break;
      case "model-error":
        c.add("model_error_events", str(e.code) ?? "error");
        break;
      case "summary": {
        const prevSeq = num(summary?.seq) ?? -1;
        if (!summary || (num(e.seq) ?? 0) >= prevSeq) summary = e;
        break;
      }
      case "interactions":
        interactions(ix, e, visits, batch.country);
        break;
    }
  }

  for (const [id, d] of decisions) {
    const acted = d.acted === true;
    if (!acted && !detected.has(id)) continue;
    recent.push({
      kind: detected.has(id) ? "detect" : "acted",
      route: str(d.route),
      fn: str(d.fn),
      trigger: str(d.trigger),
      diagnosis: str(d.diagnosis),
      action: str(d.action),
      ran: str(d.ran),
      // the diagnosis confidence, which is what the dashboard shows next to the diagnosis (not p(action))
      confidence: num(d.diagnosisConfidence),
      mode: str(d.effectiveMode),
      executed: d.executed === true,
      acted,
    });
  }
  return { counters: c, ix, recent: recent.slice(-100), exact, seqs, summary: summary ? summaryValues(summary) : undefined, visits };
}

/**
 * Per-page-load state (sessions.counts, JSON). `hw` is what the dashboard counters already hold for the page load (the
 * high-water mark), `sb` the seq of the newest summary applied, `cov` per metric the seq of the newest applied summary
 * that carried it (events before it are in that count), `seen` the event seq ranges already counted, `rev` a revision
 * bumped on every write (the concurrency guard). `base`: what was counted
 * before is unknown except for these metrics (state written by the previous worker version, or a page load quiet for
 * longer than SESSION_KEEP_MS whose state was swept); the next summary then sets the baseline for the other metrics
 * instead of being counted, so nothing is counted twice.
 */
export interface SidState {
  v: 2;
  rev: number | null;
  sb: number;
  cov: Record<string, number>;
  seen: [number, number][];
  hw: Exact;
  base?: string[];
}

/** Read a sessions row (null when there is none). Exported for tests. */
export function parseState(raw: string | null | undefined, summary?: SummaryValues): SidState {
  const fresh = (): SidState => ({ v: 2, rev: null, sb: -1, cov: {}, seen: [], hw: {} });
  if (raw === null || raw === undefined) {
    const st = fresh();
    if (summary && summary.at > SESSION_KEEP_MS) st.base = [];
    return st;
  }
  let j: Ev = {};
  try {
    j = obj(JSON.parse(raw));
  } catch {
    /* corrupt: a baseline below */
  }
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((m): m is string => typeof m === "string") : []);
  if (j.v === 2) {
    const cov: Record<string, number> = {};
    for (const [m, q] of Object.entries(obj(j.cov))) if (seqOf(q) !== null) cov[m] = q as number;
    const st: SidState = {
      v: 2,
      rev: num(j.rev) ?? null,
      sb: num(j.sb) ?? -1,
      cov,
      seen: (Array.isArray(j.seen) ? j.seen : [])
        .filter((r): r is [number, number] => Array.isArray(r) && seqOf(r[0]) !== null && seqOf(r[1]) !== null)
        .map(([a, b]) => [a, b] as [number, number]),
      hw: exactOf(j.hw),
    };
    if (Array.isArray(j.base)) st.base = strs(j.base);
    return st;
  }
  const st = fresh();
  st.base = [];
  if ("failOpen" in j || "modelErrors" in j) {
    // the previous format, { failOpen, modelErrors }: the summary values already counted for those two metrics
    st.base = ["fail_open", "model_errors"];
    st.hw = { fail_open: countMap(j.failOpen), model_errors: countMap(j.modelErrors) };
  }
  return st;
}

function addRanges(seen: [number, number][], seqs: number[]): [number, number][] {
  const all: [number, number][] = [...seen.map(([a, b]) => [a, b] as [number, number]), ...seqs.map((q) => [q, q] as [number, number])];
  all.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  while (out.length > MAX_RANGES) {
    // join the two closest ranges: a late event in the gap is then skipped, never counted twice
    let best = 1;
    for (let i = 2; i < out.length; i++) if (out[i]![0] - out[i - 1]![1] < out[best]![0] - out[best - 1]![1]) best = i;
    out[best - 1]![1] = out[best]![1];
    out.splice(best, 1);
  }
  return out;
}

/**
 * Fold one batch into a page load's exact counts. Pure (exported for tests). Two lower bounds of the true cumulative
 * count: what was counted plus the batch's new events (events already counted, or covered by a summary applied before,
 * are skipped), and the batch's newest summary plus its events after that summary. The counters get the difference
 * between the larger one and what they already hold, so a repeated, split or out-of-order batch adds nothing twice.
 */
export function advance(prev: SidState, contribs: Contribution[], seqs: number[], summary: SummaryValues | undefined): { next: SidState; delta: Exact } {
  const sum = summary && summary.seq > prev.sb ? summary : undefined;
  const seen = (q: number) => prev.seen.some(([lo, hi]) => q >= lo && q <= hi);
  const covered = (m: string, q: number) => q < (prev.cov[m] ?? -1);
  const fresh: Exact = {};
  const after: Exact = {};
  for (const x of contribs) {
    if (x.seq !== null && (seen(x.seq) || covered(x.m, x.seq))) continue;
    put(fresh, x.m, x.k, x.n, true);
    if (sum && (x.seq === null || x.seq > sum.seq)) put(after, x.m, x.k, x.n, true);
  }
  const want: Exact = {};
  for (const src of [prev.hw, fresh]) for (const [m, row] of Object.entries(src)) for (const [k, n] of Object.entries(row)) put(want, m, k, n, true);
  if (sum) {
    for (const [m, row] of Object.entries(sum.values)) {
      for (const k of new Set([...Object.keys(row), ...Object.keys(after[m] ?? {})])) {
        const est = (row[k] ?? 0) + (after[m]?.[k] ?? 0);
        if (est > (want[m]?.[k] ?? 0)) put(want, m, k, est, false);
      }
    }
  }
  const delta: Exact = {};
  const hw: Exact = {};
  for (const [m, row] of Object.entries(want)) {
    for (const [k, w] of Object.entries(row)) {
      const have = prev.hw[m]?.[k] ?? 0;
      // baseline pending: count this batch's new events, not the summary's jump (that was partly counted before)
      const d = prev.base && sum && !prev.base.includes(m) ? (fresh[m]?.[k] ?? 0) : Math.max(0, w - have);
      if (d > 0) put(delta, m, k, d, true);
      if (Math.max(have + d, w) > 0) put(hw, m, k, Math.max(have + d, w), false);
    }
  }
  const cov = { ...prev.cov };
  if (sum) for (const m of Object.keys(sum.values)) cov[m] = Math.max(cov[m] ?? -1, sum.seq);
  const next: SidState = { v: 2, rev: (prev.rev ?? 0) + 1, sb: sum ? sum.seq : prev.sb, cov, seen: addRanges(prev.seen, seqs), hw };
  if (prev.base && !sum) next.base = prev.base;
  return { next, delta };
}

function stateJson(s: SidState): string {
  let j = JSON.stringify(s);
  if (j.length > STATE_MAX && s.seen.length > 1) {
    // only an adversarial client gets here; one range keeps the state bounded (late events are skipped, never doubled)
    j = JSON.stringify({ ...s, seen: [[s.seen[0]![0], s.seen[s.seen.length - 1]![1]]] });
  }
  return j;
}

/** The page load's state revision, NULL when there is no row, no revision (older format) or the JSON is corrupt. */
const REV_OF = (col: string) => `(CASE WHEN json_valid(${col}) THEN json_extract(${col}, '$.rev') END)`;
interface Guard {
  sidHash: string;
  rev: number | null;
}

function upserts(db: D1Like, table: "daily" | "hourly", col: "day" | "hour", token: string, bucket: string, counters: Counters, guard?: Guard): D1Stmt[] {
  const entries = [...counters.m];
  const out: D1Stmt[] = [];
  for (let i = 0; i < entries.length; i += ROWS_PER_STMT) {
    const chunk = entries.slice(i, i + ROWS_PER_STMT);
    const rows = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const conflict = ` ON CONFLICT (token, ${col}, metric, key) DO UPDATE SET count = count + excluded.count`;
    // guarded: applies only while the page load's state still has the revision this batch read (see aggregate)
    const sql = guard
      ? `INSERT INTO ${table} (token, ${col}, metric, key, count) SELECT column1, column2, column3, column4, column5 FROM (VALUES ${rows}) ` +
        `WHERE (SELECT ${REV_OF("counts")} FROM sessions WHERE sid_hash = ?) IS ?` +
        conflict
      : `INSERT INTO ${table} (token, ${col}, metric, key, count) VALUES ${rows}` + conflict;
    const params: unknown[] = [];
    for (const [k, n] of chunk) {
      const [metric, key] = k.split("\u0000") as [string, string];
      params.push(token, bucket, metric, key, n);
    }
    if (guard) params.push(guard.sidHash, guard.rev);
    out.push(db.prepare(sql).bind(...params));
  }
  return out;
}

/**
 * Aggregate one accepted batch for a known token. The event counters, recent rows and last_event go in one
 * db.batch() with the exact totals; those are guarded by the page load's state revision and the state is written last
 * in the same transaction. When another batch of the same page load wrote its state in between, the guarded part did
 * nothing: read the state again and retry that part alone (the event counters are never written twice).
 */
export async function aggregate(db: D1Like, token: string, batch: AggBatch, now: Date): Promise<void> {
  const { counters, ix, recent, exact, seqs, summary, visits } = summarize(batch);
  const iso = now.toISOString();
  const day = dayKey(now);
  const hour = hourKey(now);

  const plain: D1Stmt[] = [
    ...upserts(db, "daily", "day", token, day, counters),
    ...upserts(db, "hourly", "hour", token, hour, counters),
    ...upserts(db, "daily", "day", token, day, ix),
    ...upserts(db, "hourly", "hour", token, hour, ix),
    db.prepare("UPDATE projects SET last_event = ?1, first_event = COALESCE(first_event, ?1) WHERE token = ?2").bind(iso, token),
  ];
  for (const r of recent) {
    plain.push(
      db
        .prepare("INSERT INTO recent (token, t, route, fn, trigger, diagnosis, action, ran, confidence, mode, executed, acted, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(token, iso, r.route ?? null, r.fn ?? null, r.trigger ?? null, r.diagnosis ?? null, r.action ?? null, r.ran ?? null, r.confidence ?? null, r.mode ?? null, r.executed === undefined ? null : r.executed ? 1 : 0, r.acted === undefined ? null : r.acted ? 1 : 0, r.kind),
    );
  }
  if (recent.length) {
    plain.push(
      db
        .prepare("DELETE FROM recent WHERE token = ?1 AND id < (SELECT id FROM recent WHERE token = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)")
        .bind(token, RECENT_CAP - 1),
    );
  }
  // each visit's row: created by its first batch, then its exit page, page count and (up to VISIT_ROUTES) routes
  for (const [v, part] of visits) {
    plain.push(
      db
        .prepare(
          "INSERT INTO visits (visit_hash, token, started, updated, entry, exit, pages, routes) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (visit_hash) DO UPDATE SET updated = excluded.updated, exit = excluded.exit, pages = visits.pages + excluded.pages, " +
            "routes = CASE WHEN visits.pages >= ? THEN visits.routes ELSE visits.routes || excluded.routes END",
        )
        .bind(
          (await sha256Hex(`${token}:visit:${v}`)).slice(0, 32),
          token,
          iso,
          iso,
          part.routes[0],
          part.routes[part.routes.length - 1],
          part.routes.length,
          part.routes.map((r) => `\t${r}\t`).join(""),
          VISIT_ROUTES,
        ),
    );
  }

  const sidHash = (await sha256Hex(`${token}:${batch.sid}`)).slice(0, 32);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await db.prepare("SELECT counts FROM sessions WHERE sid_hash = ?").bind(sidHash).first<{ counts: string }>();
    const prev = parseState(row?.counts, summary);
    const { next, delta } = advance(prev, exact, seqs, summary);
    const ec = new Counters();
    for (const [m, r] of Object.entries(delta)) for (const [k, n] of Object.entries(r)) ec.add(m, k, n);
    const guard: Guard = { sidHash, rev: prev.rev };
    // a batch whose every event was already counted is a repeat: its event counters and recent rows are skipped too
    const repeat = seqs.length > 0 && seqs.every((q) => prev.seen.some(([lo, hi]) => q >= lo && q <= hi));
    const out = await db.batch([
      ...(attempt === 0 && !repeat ? plain : []),
      ...upserts(db, "daily", "day", token, day, ec, guard),
      ...upserts(db, "hourly", "hour", token, hour, ec, guard),
      db
        .prepare(
          "INSERT INTO sessions (sid_hash, token, day, counts) VALUES (?, ?, ?, ?) ON CONFLICT (sid_hash) DO UPDATE SET counts = excluded.counts, day = excluded.day " +
            `WHERE ${REV_OF("sessions.counts")} IS ? RETURNING sid_hash`,
        )
        .bind(sidHash, token, day, stateJson(next), prev.rev),
    ]);
    const res = out[out.length - 1] as { results?: unknown[] } | null | undefined;
    if (res?.results?.length) return;
  }
}

// --------------------------------------------------------------------------------------------- stats

/** 90d and 1y: account dashboards on a plan with that much history (src/plans.ts); link dashboards use RANGES. */
export type Range = "24h" | "7d" | "30d" | "90d" | "1y";
export const RANGES: Range[] = ["24h", "7d", "30d"];
const SERIES_METRICS = ["sessions", "decisions", "detections", "acted", "possible", "ix_views", "ix_sessions"];

export interface Stats {
  name: string;
  token: string;
  created: string;
  lastEvent: string | null;
  range: Range;
  from: string;
  generated: string;
  totals: Record<string, number>;
  /** Top 25 keys per metric (200 for the type x page metrics `detect_issue` and `possible_issue`, and the ix_* ones). */
  breakdowns: Record<string, { key: string; count: number }[]>;
  /** Distinct keys per metric in the period, before the top-N cut (e.g. how many pages had a problem). */
  distinct: Record<string, number>;
  /** Per bucket; `possible` is the lower-confidence tier, never part of `detections`; `ix_views` the page views and `ix_sessions` the visits counted by interaction analytics. */
  series: { bucket: string; sessions: number; decisions: number; detections: number; acted: number; possible: number; ix_views: number; ix_sessions: number }[];
  /** Detections per bucket by diagnosis (the dashboard's stacked timeline). */
  typeSeries: { bucket: string; counts: Record<string, number> }[];
  /** The same totals over the period just before this one (deltas). */
  previous: { sessions: number; detections: number; acted: number; ix_views: number; ix_sessions: number };
  recent: Record<string, unknown>[];
  /** Interaction analytics: the visits that started in the period (visits are kept 90 days whatever the plan). */
  visits: VisitStats;
  /** The app's funnels and, per step, the visits that started in the period and reached it in order. */
  funnels: FunnelStats[];
  /** What the developer's coding agent reported through @genclass/mcp in the period (agentStats); off unless the developer turned reporting on. */
  agent: AgentStats;
}

// --------------------------------------------------------------------------------------------- visits and funnels

export interface VisitStats {
  /** Visits that started in the period, their page views, and those with one page view only. */
  sessions: number;
  pages: number;
  bounces: number;
  /** Top 25 entry and exit pages of those visits. */
  entry: { key: string; count: number }[];
  exit: { key: string; count: number }[];
}
export interface Funnel {
  name: string;
  /** Routes as the dashboard keys them; one ending in "*" matches every route that starts with what comes before it. */
  steps: string[];
}
export interface FunnelStats extends Funnel {
  /** Per step, the visits whose routes include every step up to this one, in that order. */
  counts: number[];
}
export const MAX_FUNNELS = 5;
export const MIN_STEPS = 2;
export const MAX_STEPS = 6;
const FUNNEL_NAME_MAX = 60;

/** A funnel step: a route (normalised like the runtime's), or a route prefix ending in "*". Null when it is not one. */
export function funnelStep(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const prefix = s.endsWith("*");
  const r = normalizeRoute(prefix ? s.slice(0, -1) : s);
  if (!r || r.includes("*") || r.includes("\t")) return null;
  return prefix ? `${r}*` : r;
}

/** Check funnels sent by the dashboard: the cleaned list, or why it was refused. */
export function cleanFunnels(v: unknown): Funnel[] | { error: string } {
  if (!Array.isArray(v)) return { error: "funnels must be an array" };
  if (v.length > MAX_FUNNELS) return { error: `at most ${MAX_FUNNELS} funnels` };
  const out: Funnel[] = [];
  for (const [i, f] of v.entries()) {
    const o = obj(f);
    if (!Array.isArray(o.steps) || o.steps.length < MIN_STEPS || o.steps.length > MAX_STEPS) return { error: `a funnel has ${MIN_STEPS} to ${MAX_STEPS} steps` };
    const steps: string[] = [];
    for (const raw of o.steps) {
      const st = funnelStep(raw);
      if (!st) return { error: `not a page route: ${chars(String(raw), 60)} (a step starts with /)` };
      steps.push(st);
    }
    const name = typeof o.name === "string" ? sanitizeName(o.name).slice(0, FUNNEL_NAME_MAX).trim() : "";
    out.push({ name: name && name !== "Untitled app" ? name : `Funnel ${i + 1}`, steps });
  }
  return out;
}

/** The funnels stored for an app (projects.funnels); [] when none or unreadable. */
export function parseFunnels(raw: unknown): Funnel[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const f = cleanFunnels(JSON.parse(raw));
    return Array.isArray(f) ? f : [];
  } catch {
    return [];
  }
}

/** Save an app's funnels (the whole list). */
export async function saveFunnels(db: D1Like, token: string, funnels: Funnel[]): Promise<void> {
  await db.prepare("UPDATE projects SET funnels = ? WHERE token = ?").bind(funnels.length ? JSON.stringify(funnels) : null, token).run();
}

/**
 * PUT .../funnels with `{ funnels: [{ name, steps }] }` (application/json, at most 4 KB): replace the app's funnels.
 * Shared by the private link (above) and account mode (src/auth.ts), which authenticate first.
 */
export async function putFunnels(request: Request, db: D1Like, token: string): Promise<Response> {
  const ct = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return json(415, { ok: false, error: "content-type must be application/json" });
  const raw = await readCapped(request, 4096);
  if (raw === null) return json(413, { ok: false, error: "body too large" });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json(400, { ok: false, error: "invalid JSON" });
  }
  const f = cleanFunnels((body as { funnels?: unknown } | null)?.funnels);
  if (!Array.isArray(f)) return json(400, { ok: false, error: f.error });
  await saveFunnels(db, token, f);
  return json(200, { ok: true, funnels: f });
}

/** A GLOB pattern matching a visit's route list ("\t/a\t\t/b\t") when it includes `steps` in order. */
export function funnelGlob(steps: string[]): string {
  const lit = (s: string) => s.replace(/[*?[]/g, (c) => `[${c}]`);
  return `*${steps.map((s) => `\t${s.endsWith("*") ? `${lit(s.slice(0, -1))}*` : lit(s)}\t`).join("*")}*`;
}

async function visitStats(db: D1Like, token: string, fromIso: string, funnels: Funnel[]): Promise<{ visits: VisitStats; funnels: FunnelStats[] }> {
  const globs = funnels.flatMap((f) => f.steps.map((_, i) => funnelGlob(f.steps.slice(0, i + 1))));
  const sums = globs.length ? globs.map((_, i) => `SUM(routes GLOB ?) AS g${i}`).join(", ") : "0 AS g";
  const [tot, entry, exit, fun] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n, SUM(pages) AS p, SUM(pages = 1) AS b FROM visits WHERE token = ? AND started >= ?").bind(token, fromIso),
    db.prepare("SELECT entry AS k, COUNT(*) AS c FROM visits WHERE token = ? AND started >= ? GROUP BY entry ORDER BY c DESC, entry LIMIT 25").bind(token, fromIso),
    db.prepare("SELECT exit AS k, COUNT(*) AS c FROM visits WHERE token = ? AND started >= ? GROUP BY exit ORDER BY c DESC, exit LIMIT 25").bind(token, fromIso),
    db.prepare(`SELECT ${sums} FROM visits WHERE token = ? AND started >= ?`).bind(...globs, token, fromIso),
  ]);
  const rows = (r: unknown) => ((r as { results?: Record<string, unknown>[] })?.results ?? []) as Record<string, unknown>[];
  const t = rows(tot)[0] ?? {};
  const list = (r: unknown) => rows(r).map((x) => ({ key: String(x.k), count: Number(x.c) || 0 }));
  const f = rows(fun)[0] ?? {};
  let g = 0;
  return {
    visits: { sessions: Number(t.n) || 0, pages: Number(t.p) || 0, bounces: Number(t.b) || 0, entry: list(entry), exit: list(exit) },
    funnels: funnels.map((x) => ({ ...x, counts: x.steps.map(() => Number(f[`g${g++}`]) || 0) })),
  };
}

// --------------------------------------------------------------------------------------------- agent reports

/** The finding kinds @genclass/mcp makes (packages/mcp/src/types.ts FindingKind). */
export const AGENT_KINDS = ["race", "stale-write", "error", "duplicate-request", "detection", "check", "expectation", "intervention"];
export const AGENT_SCHEMA = "genclass-agent/1";
export const AGENT_MAX_EVENTS = 50;
export const AGENT_MAX_BODY = 16 * 1024;
const AGENT_ID_RE = /^f[0-9]{1,9}$/;

export interface AgentFinding {
  id: string;
  kind: string;
  route: string;
  found: string | null;
  replayed: string | null;
  reproduced: boolean | null;
  tested: string | null;
  proven: string | null;
  updated: string;
}
export interface AgentStats {
  /** The findings reported in the period, newest change first (at most 25). */
  findings: AgentFinding[];
  counts: { found: number; reproduced: number; tested: number; proven: number };
  /** When the agent last reported anything for this app, in the period. */
  last: string | null;
}

/** A page route as the dashboard keys it: path only, capped, with id-like segments replaced by :id (as the runtime does). */
export function normalizeRoute(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let r = v.trim();
  const q = r.search(/[?#]/);
  if (q >= 0) r = r.slice(0, q);
  if (!r.startsWith("/")) return null;
  r = r
    .split("/")
    .map((seg) => (/^(\d+|[0-9a-f]{8,}|[0-9a-f-]{32,}|[A-Za-z0-9_-]{20,}|[^@]*@[^@]*)$/i.test(seg) ? ":id" : seg))
    .join("/");
  // eslint-disable-next-line no-control-regex
  r = r.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "");
  if (r.length > 200) r = r.slice(0, 200);
  return r || "/";
}

/**
 * Store what an agent reported (POST /api/projects/<secret>/agent): `found` (kind, route), `replay` (reproduced true or
 * false; a false after a true marks the fix proven) and `test` (a regression test was written). Anything else in an
 * event is dropped. Returns how many events were stored, or the reason none were.
 */
export async function agentReport(db: D1Like, token: string, body: unknown, now: Date): Promise<{ stored: number } | { error: string }> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (b.schema !== AGENT_SCHEMA) return { error: `schema must be ${AGENT_SCHEMA}` };
  if (!Array.isArray(b.events)) return { error: "events must be an array" };
  if (b.events.length > AGENT_MAX_EVENTS) return { error: `at most ${AGENT_MAX_EVENTS} events per request` };
  const nowMs = now.getTime();
  const stmts: D1Stmt[] = [];
  for (const raw of b.events) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const e = raw as Record<string, unknown>;
    const id = typeof e.id === "string" && AGENT_ID_RE.test(e.id) ? e.id : null;
    const kind = typeof e.kind === "string" && AGENT_KINDS.includes(e.kind) ? e.kind : null;
    const route = normalizeRoute(e.route);
    if (!id || !kind || !route) continue;
    const atMs = typeof e.at === "number" && Number.isFinite(e.at) && Math.abs(e.at - nowMs) < 86_400_000 ? e.at : nowMs;
    const at = new Date(atMs).toISOString();
    const iso = now.toISOString();
    if (e.t === "found") {
      stmts.push(
        db
          .prepare(
            "INSERT INTO agent_reports (token, finding, kind, route, found, updated) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (token, finding) DO UPDATE SET kind = excluded.kind, route = excluded.route, found = COALESCE(agent_reports.found, excluded.found), updated = excluded.updated",
          )
          .bind(token, id, kind, route, at, iso),
      );
    } else if (e.t === "replay" && typeof e.reproduced === "boolean") {
      const r = e.reproduced ? 1 : 0;
      stmts.push(
        db
          .prepare(
            "INSERT INTO agent_reports (token, finding, kind, route, replayed, reproduced, reproduced_once, proven, updated) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT (token, finding) DO UPDATE SET kind = excluded.kind, route = excluded.route, replayed = excluded.replayed, reproduced = excluded.reproduced, reproduced_once = MAX(agent_reports.reproduced_once, excluded.reproduced_once), proven = CASE WHEN excluded.reproduced = 0 AND agent_reports.reproduced_once = 1 THEN excluded.replayed ELSE agent_reports.proven END, updated = excluded.updated",
          )
          .bind(token, id, kind, route, at, r, r, iso),
      );
    } else if (e.t === "test") {
      stmts.push(
        db
          .prepare(
            "INSERT INTO agent_reports (token, finding, kind, route, tested, updated) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (token, finding) DO UPDATE SET kind = excluded.kind, route = excluded.route, tested = excluded.tested, updated = excluded.updated",
          )
          .bind(token, id, kind, route, at, iso),
      );
    }
  }
  if (stmts.length) await db.batch(stmts);
  return { stored: stmts.length };
}

/** The agent's reports for the dashboard: the findings changed in the period and the counts. */
export async function agentStats(db: D1Like, token: string, fromIso: string): Promise<AgentStats> {
  const r = await db
    .prepare("SELECT finding, kind, route, found, replayed, reproduced, reproduced_once, tested, proven, updated FROM agent_reports WHERE token = ? AND updated >= ? ORDER BY updated DESC LIMIT 25")
    .bind(token, fromIso)
    .all<Record<string, unknown>>();
  const findings: AgentFinding[] = (r.results ?? []).map((x) => ({
    id: String(x.finding),
    kind: String(x.kind),
    route: String(x.route),
    found: x.found == null ? null : String(x.found),
    replayed: x.replayed == null ? null : String(x.replayed),
    reproduced: x.reproduced == null ? null : !!x.reproduced,
    tested: x.tested == null ? null : String(x.tested),
    proven: x.proven == null ? null : String(x.proven),
    updated: String(x.updated),
  }));
  const counts = { found: 0, reproduced: 0, tested: 0, proven: 0 };
  for (const f of findings) {
    if (f.found) counts.found++;
    if (f.reproduced === true || (f.proven && f.replayed)) counts.reproduced++;
    if (f.tested) counts.tested++;
    if (f.proven) counts.proven++;
  }
  return { findings, counts, last: findings[0]?.updated ?? null };
}

export async function stats(db: D1Like, p: Project, range: Range, now: Date): Promise<Stats> {
  const hourly = range === "24h";
  const table = hourly ? "hourly" : "daily";
  const col = hourly ? "hour" : "day";
  const span = hourly ? 24 : range === "7d" ? 7 : range === "90d" ? 90 : range === "1y" ? 365 : 30;
  const buckets: string[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * (hourly ? 3_600_000 : 86_400_000));
    buckets.push(hourly ? hourKey(d) : dayKey(d));
  }
  const from = buckets[0]!;
  const prevStart = new Date(Date.parse(hourly ? `${from}:00:00.000Z` : `${from}T00:00:00.000Z`) - span * (hourly ? 3_600_000 : 86_400_000));
  const prevFrom = hourly ? hourKey(prevStart) : dayKey(prevStart);

  const [agg, series, recent, types, prev, fun] = await db.batch([
    db.prepare(`SELECT metric, key, SUM(count) AS c FROM ${table} WHERE token = ? AND ${col} >= ? GROUP BY metric, key`).bind(p.token, from),
    db
      .prepare(`SELECT ${col} AS b, metric, SUM(count) AS c FROM ${table} WHERE token = ? AND ${col} >= ? AND key = '' AND metric IN (${SERIES_METRICS.map(() => "?").join(", ")}) GROUP BY ${col}, metric`)
      .bind(p.token, from, ...SERIES_METRICS),
    db
      .prepare("SELECT t, route, fn, trigger, diagnosis, action, ran, confidence, mode, executed, acted, kind FROM recent WHERE token = ? AND t >= ? ORDER BY id DESC LIMIT 50")
      .bind(p.token, hourly ? new Date(now.getTime() - 86_400_000).toISOString() : `${from}T00:00:00.000Z`),
    db.prepare(`SELECT ${col} AS b, key, SUM(count) AS c FROM ${table} WHERE token = ? AND ${col} >= ? AND metric = 'detect_diagnosis' GROUP BY ${col}, key`).bind(p.token, from),
    db
      .prepare(`SELECT metric, SUM(count) AS c FROM ${table} WHERE token = ? AND ${col} >= ? AND ${col} < ? AND key = '' AND metric IN ('sessions', 'detections', 'acted', 'ix_views', 'ix_sessions') GROUP BY metric`)
      .bind(p.token, prevFrom, from),
    db.prepare("SELECT funnels FROM projects WHERE token = ?").bind(p.token),
  ]);
  const rows = (r: unknown) => ((r as { results?: Record<string, unknown>[] })?.results ?? []) as Record<string, unknown>[];

  const totals: Record<string, number> = {};
  const breakdowns: Record<string, { key: string; count: number }[]> = {};
  for (const r of rows(agg)) {
    const metric = String(r.metric);
    const key = String(r.key ?? "");
    const c = Number(r.c) || 0;
    if (key === "") totals[metric] = (totals[metric] ?? 0) + c;
    else (breakdowns[metric] ??= []).push({ key, count: c });
  }
  const distinct: Record<string, number> = {};
  const sums: Record<string, number> = {};
  for (const [metric, list] of Object.entries(breakdowns)) {
    distinct[metric] = list.length;
    sums[metric] = list.reduce((s, x) => s + x.count, 0);
    list.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    list.splice(metric === "detect_issue" || metric === "possible_issue" || metric.startsWith("ix_") ? 200 : 25);
  }
  const sumOf = (m: string) => sums[m] ?? 0;
  totals.latencyAvgMs = totals.latency_ms_n ? Math.round(totals.latency_ms_sum! / totals.latency_ms_n) : 0;
  totals.modelLoadAvgMs = totals.model_load_ms_n ? Math.round(totals.model_load_ms_sum! / totals.model_load_ms_n) : 0;
  totals.failOpens = sumOf("fail_open");
  totals.modelErrors = sumOf("model_errors");
  totals.interventions = sumOf("intervention");
  totals.actionLimits = sumOf("action_limits");
  // detections (and possible ones) whose page is known (their decision record came in the same batch); the rest have no route
  totals.detectionsWithPage = sumOf("detect_route");
  totals.possibleWithPage = sumOf("possible_route");
  if (breakdowns.latency_bucket) {
    const order = LATENCY_BUCKETS.map(([, l]) => l);
    breakdowns.latency_bucket.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }

  const byBucket = new Map(buckets.map((b) => [b, { bucket: b, sessions: 0, decisions: 0, detections: 0, acted: 0, possible: 0, ix_views: 0, ix_sessions: 0 }]));
  for (const r of rows(series)) {
    const s = byBucket.get(String(r.b));
    if (s && SERIES_METRICS.includes(String(r.metric))) (s as Record<string, unknown>)[String(r.metric)] = Number(r.c) || 0;
  }

  const byType = new Map(buckets.map((b) => [b, { bucket: b, counts: {} as Record<string, number> }]));
  for (const r of rows(types)) {
    const s = byType.get(String(r.b));
    if (s) s.counts[String(r.key ?? "")] = (s.counts[String(r.key ?? "")] ?? 0) + (Number(r.c) || 0);
  }
  const previous = { sessions: 0, detections: 0, acted: 0, ix_views: 0, ix_sessions: 0 };
  for (const r of rows(prev)) {
    const m = String(r.metric) as keyof typeof previous;
    if (m in previous) previous[m] = Number(r.c) || 0;
  }

  const fromIso = hourly ? `${from}:00:00.000Z` : `${from}T00:00:00.000Z`;
  const vs = await visitStats(db, p.token, fromIso, parseFunnels(rows(fun)[0]?.funnels));
  return {
    name: p.name,
    token: p.token,
    created: p.created,
    lastEvent: p.last_event,
    range,
    from: fromIso,
    generated: now.toISOString(),
    totals,
    breakdowns,
    distinct,
    series: [...byBucket.values()],
    typeSeries: [...byType.values()],
    previous,
    recent: rows(recent).map((r) => ({ ...r, executed: r.executed === null ? null : !!r.executed, acted: r.acted === null ? null : !!r.acted })),
    agent: await agentStats(db, p.token, fromIso),
    visits: vs.visits,
    funnels: vs.funnels,
  };
}

// --------------------------------------------------------------------------------------------- retention

/**
 * `longer` (src/plans.ts): a SELECT of the tokens whose owner's plan keeps daily counters and recent rows for `days`
 * (more than RETENTION_DAYS); their rows are kept that long instead. Without it every token keeps RETENTION_DAYS.
 */
export async function retention(db: D1Like, now: Date, longer?: { tokens: string; params: unknown[]; days: number }): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const keep = longer ? ` AND token NOT IN (${longer.tokens})` : "";
  const p = longer?.params ?? [];
  const stmts = [
    db.prepare(`DELETE FROM daily WHERE day < ?${keep}`).bind(dayKey(cutoff), ...p),
    db.prepare("DELETE FROM hourly WHERE hour < ?").bind(hourKey(new Date(now.getTime() - 48 * 3_600_000))),
    db.prepare(`DELETE FROM recent WHERE t < ?${keep}`).bind(cutoff.toISOString(), ...p),
    db.prepare("DELETE FROM sessions WHERE day < ?").bind(dayKey(new Date(now.getTime() - 2 * 86_400_000))),
    db.prepare("DELETE FROM agent_reports WHERE updated < ?").bind(cutoff.toISOString()),
    db.prepare("DELETE FROM visits WHERE started < ?").bind(cutoff.toISOString()),
  ];
  if (longer) {
    const far = new Date(now.getTime() - Math.max(longer.days, RETENTION_DAYS) * 86_400_000);
    stmts.push(db.prepare("DELETE FROM daily WHERE day < ?").bind(dayKey(far)), db.prepare("DELETE FROM recent WHERE t < ?").bind(far.toISOString()));
  }
  await db.batch(stmts);
}

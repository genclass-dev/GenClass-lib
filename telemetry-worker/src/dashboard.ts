// Per-app tokens and dashboards: D1 storage, aggregation of telemetry batches, stats for the dashboard, retention.
//
// - A token (`gc_` + 22 base62) identifies one web app. It is public (ships in client code) and only lets data be
//   sent. The dashboard secret (32 base62) is private; only its SHA-256 hex is stored.
// - Aggregates are counters per (token, UTC day | UTC hour, metric, key). No situation text, no IP, no user agent.
// - Totals are exact: page loads, decisions, detections (and by diagnosis), acted, triggers and the loss counters come
//   from each page load's cumulative `summary` once it arrives, and from its events until then, through a per-page-load
//   high-water mark (sessions table) updated under optimistic concurrency, so a repeated, split or concurrently
//   processed batch is never counted twice. Routes, functions and recent rows always come from the events.
// - "Possible issues": decisions whose top diagnosis is not `expected` with diagnosis confidence at least
//   POSSIBLE_MIN but below that decision's own report gate. Their own counters, never added to detections.
// - Retention (daily cron): daily counters and recent rows 90 days, hourly counters 48 hours, summary state 2 days.

export const TOKEN_RE = /^gc_[A-Za-z0-9]{22}$/;
export const SECRET_RE = /^[A-Za-z0-9]{32}$/;
export const RECENT_CAP = 500;
export const RETENTION_DAYS = 90;
/** Distinct counters one batch may touch (bounds D1 writes per batch). */
export const MAX_COUNTERS = 300;
/** Lower bound (diagnosis confidence) of the "possible issues" tier; its upper bound is each decision's report gate. */
export const POSSIBLE_MIN = 0.7;
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
  token: string;
  name: string;
  created: string;
  last_event: string | null;
}

export async function createProject(db: D1Like, name: string, now: Date): Promise<{ token: string; secret: string; name: string; created: string }> {
  for (let attempt = 0; ; attempt++) {
    const token = newToken();
    const secret = newSecret();
    const created = now.toISOString();
    try {
      await db
        .prepare("INSERT INTO projects (token, secret_hash, name, created) VALUES (?, ?, ?, ?)")
        .bind(token, await sha256Hex(secret), name, created)
        .run();
      tokenCache.set(token, { ok: true, exp: now.getTime() + CACHE_OK_MS });
      return { token, secret, name, created };
    } catch (e) {
      if (attempt >= 2) throw e; // a collision is astronomically unlikely; anything else is a real error
    }
  }
}

/** Look a project up by its dashboard secret (by hash, so lookup time does not depend on how much of it matches). */
export async function projectBySecret(db: D1Like, secret: string): Promise<Project | null> {
  if (!SECRET_RE.test(secret)) return null;
  return db
    .prepare("SELECT token, name, created, last_event FROM projects WHERE secret_hash = ?")
    .bind(await sha256Hex(secret))
    .first<Project>();
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
  add(metric: string, key: string | undefined = "", n = 1): void {
    if (!(n > 0) || !Number.isFinite(n)) return;
    const k = `${metric}\u0000${key ?? ""}`;
    const prev = this.m.get(k);
    if (prev === undefined && this.m.size >= MAX_COUNTERS) return;
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

/** Pure part of the aggregation: event counters, recent rows and exact-metric contributions for one batch (exported for tests). */
export function summarize(batch: AggBatch): { counters: Counters; recent: RecentRow[]; exact: Contribution[]; seqs: number[]; summary?: SummaryValues } {
  const c = new Counters();
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
        x("detections");
        x("detect_diagnosis", ekey(e.diagnosis, "(unknown)"));
        c.add("detect_trigger", str(e.trigger) ?? "(unknown)");
        if (typeof e.decision === "string") detected.add(e.decision);
        const d = typeof e.decision === "string" ? decisions.get(e.decision) : undefined;
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
    }
  }

  // The "possible issues" tier: not expected, diagnosis confidence in [POSSIBLE_MIN, the decision's report gate).
  // A decision at or over its gate is a detection (it has a detect event); one without a gate is left out.
  for (const [id, d] of decisions) {
    if (detected.has(id)) continue;
    const diagnosis = str(d.diagnosis);
    const p = num(d.diagnosisConfidence);
    const gate = num(obj(d.gates).report);
    if (!diagnosis || diagnosis === "expected" || p === undefined || gate === undefined || p < POSSIBLE_MIN || p >= gate) continue;
    const route = str(d.route) ?? "(unknown)";
    c.add("possible");
    c.add("possible_diagnosis", diagnosis);
    c.add("possible_route", route);
    c.add("possible_issue", `${diagnosis}\t${route}`);
    const fn = str(d.fn);
    if (fn) c.add("possible_fn", fn);
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
  return { counters: c, recent: recent.slice(-100), exact, seqs, summary: summary ? summaryValues(summary) : undefined };
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
  const { counters, recent, exact, seqs, summary } = summarize(batch);
  const iso = now.toISOString();
  const day = dayKey(now);
  const hour = hourKey(now);

  const plain: D1Stmt[] = [
    ...upserts(db, "daily", "day", token, day, counters),
    ...upserts(db, "hourly", "hour", token, hour, counters),
    db.prepare("UPDATE projects SET last_event = ? WHERE token = ?").bind(iso, token),
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

export type Range = "24h" | "7d" | "30d";
export const RANGES: Range[] = ["24h", "7d", "30d"];
const SERIES_METRICS = ["sessions", "decisions", "detections", "acted", "possible"];

export interface Stats {
  name: string;
  token: string;
  created: string;
  lastEvent: string | null;
  range: Range;
  from: string;
  generated: string;
  totals: Record<string, number>;
  /** Top 25 keys per metric (200 for the type x page metrics `detect_issue` and `possible_issue`). */
  breakdowns: Record<string, { key: string; count: number }[]>;
  /** Distinct keys per metric in the period, before the top-N cut (e.g. how many pages had a problem). */
  distinct: Record<string, number>;
  /** Per bucket; `possible` is the lower-confidence tier, never part of `detections`. */
  series: { bucket: string; sessions: number; decisions: number; detections: number; acted: number; possible: number }[];
  /** Detections per bucket by diagnosis (the dashboard's stacked timeline). */
  typeSeries: { bucket: string; counts: Record<string, number> }[];
  /** The same totals over the period just before this one (deltas). */
  previous: { sessions: number; detections: number; acted: number };
  recent: Record<string, unknown>[];
}

export async function stats(db: D1Like, p: Project, range: Range, now: Date): Promise<Stats> {
  const hourly = range === "24h";
  const table = hourly ? "hourly" : "daily";
  const col = hourly ? "hour" : "day";
  const span = hourly ? 24 : range === "7d" ? 7 : 30;
  const buckets: string[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * (hourly ? 3_600_000 : 86_400_000));
    buckets.push(hourly ? hourKey(d) : dayKey(d));
  }
  const from = buckets[0]!;
  const prevStart = new Date(Date.parse(hourly ? `${from}:00:00.000Z` : `${from}T00:00:00.000Z`) - span * (hourly ? 3_600_000 : 86_400_000));
  const prevFrom = hourly ? hourKey(prevStart) : dayKey(prevStart);

  const [agg, series, recent, types, prev] = await db.batch([
    db.prepare(`SELECT metric, key, SUM(count) AS c FROM ${table} WHERE token = ? AND ${col} >= ? GROUP BY metric, key`).bind(p.token, from),
    db
      .prepare(`SELECT ${col} AS b, metric, SUM(count) AS c FROM ${table} WHERE token = ? AND ${col} >= ? AND key = '' AND metric IN (${SERIES_METRICS.map(() => "?").join(", ")}) GROUP BY ${col}, metric`)
      .bind(p.token, from, ...SERIES_METRICS),
    db
      .prepare("SELECT t, route, fn, trigger, diagnosis, action, ran, confidence, mode, executed, acted, kind FROM recent WHERE token = ? AND t >= ? ORDER BY id DESC LIMIT 50")
      .bind(p.token, hourly ? new Date(now.getTime() - 86_400_000).toISOString() : `${from}T00:00:00.000Z`),
    db.prepare(`SELECT ${col} AS b, key, SUM(count) AS c FROM ${table} WHERE token = ? AND ${col} >= ? AND metric = 'detect_diagnosis' GROUP BY ${col}, key`).bind(p.token, from),
    db
      .prepare(`SELECT metric, SUM(count) AS c FROM ${table} WHERE token = ? AND ${col} >= ? AND ${col} < ? AND key = '' AND metric IN ('sessions', 'detections', 'acted') GROUP BY metric`)
      .bind(p.token, prevFrom, from),
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
    list.splice(metric === "detect_issue" || metric === "possible_issue" ? 200 : 25);
  }
  const sumOf = (m: string) => sums[m] ?? 0;
  totals.latencyAvgMs = totals.latency_ms_n ? Math.round(totals.latency_ms_sum! / totals.latency_ms_n) : 0;
  totals.modelLoadAvgMs = totals.model_load_ms_n ? Math.round(totals.model_load_ms_sum! / totals.model_load_ms_n) : 0;
  totals.failOpens = sumOf("fail_open");
  totals.modelErrors = sumOf("model_errors");
  totals.interventions = sumOf("intervention");
  totals.actionLimits = sumOf("action_limits");
  // detections whose page is known (their decision record came in the same batch); the rest have no route
  totals.detectionsWithPage = sumOf("detect_route");
  if (breakdowns.latency_bucket) {
    const order = LATENCY_BUCKETS.map(([, l]) => l);
    breakdowns.latency_bucket.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }

  const byBucket = new Map(buckets.map((b) => [b, { bucket: b, sessions: 0, decisions: 0, detections: 0, acted: 0, possible: 0 }]));
  for (const r of rows(series)) {
    const s = byBucket.get(String(r.b));
    if (s && SERIES_METRICS.includes(String(r.metric))) (s as Record<string, unknown>)[String(r.metric)] = Number(r.c) || 0;
  }

  const byType = new Map(buckets.map((b) => [b, { bucket: b, counts: {} as Record<string, number> }]));
  for (const r of rows(types)) {
    const s = byType.get(String(r.b));
    if (s) s.counts[String(r.key ?? "")] = (s.counts[String(r.key ?? "")] ?? 0) + (Number(r.c) || 0);
  }
  const previous = { sessions: 0, detections: 0, acted: 0 };
  for (const r of rows(prev)) {
    const m = String(r.metric) as keyof typeof previous;
    if (m in previous) previous[m] = Number(r.c) || 0;
  }

  return {
    name: p.name,
    token: p.token,
    created: p.created,
    lastEvent: p.last_event,
    range,
    from: hourly ? `${from}:00:00.000Z` : `${from}T00:00:00.000Z`,
    generated: now.toISOString(),
    totals,
    breakdowns,
    distinct,
    series: [...byBucket.values()],
    typeSeries: [...byType.values()],
    previous,
    recent: rows(recent).map((r) => ({ ...r, executed: r.executed === null ? null : !!r.executed, acted: r.acted === null ? null : !!r.acted })),
  };
}

// --------------------------------------------------------------------------------------------- retention

export async function retention(db: D1Like, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  await db.batch([
    db.prepare("DELETE FROM daily WHERE day < ?").bind(dayKey(cutoff)),
    db.prepare("DELETE FROM hourly WHERE hour < ?").bind(hourKey(new Date(now.getTime() - 48 * 3_600_000))),
    db.prepare("DELETE FROM recent WHERE t < ?").bind(cutoff.toISOString()),
    db.prepare("DELETE FROM sessions WHERE day < ?").bind(dayKey(new Date(now.getTime() - 2 * 86_400_000))),
  ]);
}

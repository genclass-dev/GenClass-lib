// Telemetry client: turns runtime events into genclass-telemetry/1 batches (packages/runtime/TELEMETRY.md).
//
// Invariants:
// - Read-only on the runtime: it listens (rt.on, rt.tap) and reads decisionInfo(); nothing it does feeds a
//   decision or changes model input (situation-v2 freeze). The situation text it sends is the exact text built
//   from the state the model received, after the redactor.
// - Never throws into the app or the runtime; failures drop the batch, and MAX_FAIL_STREAK failures in a row stop the
//   page from sending. A 429 (or any response with a Retry-After) is a back-off, not a failure: the batch goes back to
//   the front of the queue and nothing is sent until the Retry-After (else BACKOFF_MS, doubling to MAX_BACKOFF_MS)
//   has passed; only page exit (sendBeacon) sends during it. Bounded queue (MAX_QUEUE events).
// - Timers come from the runtime's Clock; times are ms since this session started (no wall clock: the collector
//   stamps receivedAt). The session id is random per page load and never stored.
// - Volume (TELEMETRY.md "Volume"): every decision is counted in `summary`. Detections are never sampled or capped:
//   every `detect` event and the `decision` record it points to are sent, as are the records of every decision whose
//   top diagnosis is not "expected" (near-misses below the report gate included) and of every action or veto. Only
//   routine decisions (top diagnosis "expected", nothing acted, vetoed or shadow-passed) are sampled, a
//   `decisionSample` share (a hash of the session and decision ids, no randomness), and capped at `maxDecisions` per
//   page load. A decision whose record is withheld still arms the flush timer, so `summary` keeps its once-a-minute
//   cadence while decisions continue.
// - A page whose model is skipped before telemetry starts (the device floor, model.loadIf) still sends its `session`
//   event (modelState "skipped") followed by a `model` event with the reason.

import type { RuntimeImpl } from "../runtime.js";
import type { ActionRecord, Answer, Decision, ModelStatus, TelemetryStatus } from "../types.js";
import { REDACTED, fnv1a, normalizePath } from "../util.js";
import { RUNTIME_VERSION } from "../version.js";
import { TELEMETRY_SCHEMA, type TelemetryConfig } from "./config.js";

export const MAX_QUEUE = 1000;
/** keepalive fetch and sendBeacon refuse bodies over 64 KiB. */
export const MAX_REQUEST_BYTES = 60_000;
/** Consecutive failed requests after which a page stops sending telemetry (a CSP block, a dead endpoint). */
export const MAX_FAIL_STREAK = 3;
/** First back-off after a 429 without a readable Retry-After; doubled for each 429 in a row, up to MAX_BACKOFF_MS. */
export const BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 300_000;
export const SUMMARY_MS = 60_000;
const MAX_ERROR_EVENTS = 20;

type Ev = Record<string, unknown>;
type Counts = Record<string, number>;

/** What createRuntime knows about the options (never their values beyond these names). */
export interface TelemetrySessionInfo {
  model: "local" | "custom" | "off";
  triage?: string;
  shadow?: string | false;
  holdWrites?: boolean;
  install?: string;
}

const r4 = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : undefined);
const cut = (s: unknown, n: number): string | undefined => (typeof s === "string" ? (s.length > n ? s.slice(0, n) : s) : undefined);
/** URLs in browser error text are not sent (a Worker constructor's SecurityError names the script and the page origin). */
const noUrls = (s: unknown): unknown => (typeof s === "string" ? s.replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|(?:blob|data):[a-z])[^\s'"`<>]*/gi, "<url>") : s);

/** An e-mail address, a URL, a run of 4+ digits (ids, phone or card numbers) or 12+ hex digits (a UUID, a hash). */
const DATA_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+|\b(?:https?:\/\/|www\.)|\d{4,}|\b[0-9a-f]{12,}\b/i;

/**
 * A protect() label as telemetry sends it (only on batches with the app's token): a name the developer chose, at most
 * 80 characters. A label that looks like it carries data rather than naming a function (DATA_LIKE: `save ${email}`)
 * is sent as "[redacted]". Decision.fn keeps the full label locally.
 */
export function fnLabel(s: unknown): string | undefined {
  const v = cut(s, 80);
  if (v === undefined) return undefined;
  return DATA_LIKE.test(v) ? REDACTED : v;
}
/**
 * A deterministic draw in [0, 1) from a string: fnv1a, then murmur3's 32-bit finalizer. fnv1a alone hardly mixes the
 * last characters into the high bits, and decision ids ("d1", "d2", ...) differ only there, so the share a page sent
 * swung with its session id (44 of 80 routine records at decisionSample 0.25 in one CI run).
 */
export function decisionDraw(s: string): number {
  let h = parseInt(fnv1a(s), 16) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

const inc = (c: Counts, k: string, by = 1) => {
  c[k] = (c[k] ?? 0) + by;
};

function probs(p: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!p) return undefined;
  const o: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) o[k] = r4(v) ?? 0;
  return o;
}

function answersOut(a: Record<string, Answer>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, x] of Object.entries(a ?? {})) {
    if (!x || typeof x !== "object") continue;
    if (x.type === "noul") out[id] = { type: "noul", p: r4(x.noul) };
    else if (x.type === "choice") out[id] = { type: "choice", choice: x.choice, confidence: r4(x.confidence), probabilities: probs(x.probabilities) };
    else if (x.type === "score") out[id] = { type: "score", score: r4(x.score), confidence: r4(x.confidence), probabilities: probs(x.probabilities) };
  }
  return out;
}

function compact(o: Ev): Ev {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export class TelemetryClient implements TelemetryStatus {
  readonly enabled = true;
  private queue: Ev[] = [];
  private seq = 0;
  private readonly t0: number;
  private timer: unknown = null;
  private stopped = false;
  private lastSummaryAt: number;
  private dirty = false;
  private modelKey = "";
  private statusKey = "";
  private errorEvents = 0;
  private dropped = 0;
  private sendFailures = 0;
  /** Consecutive failed requests; at MAX_FAIL_STREAK the page stops sending (a CSP block or a dead endpoint). */
  private failStreak = 0;
  /** Back-off (429, Retry-After): nothing is sent before this clock time except on page exit; 429s in a row. */
  private backoffUntil = -Infinity;
  private backoffs = 0;
  private sentEvents = 0;
  /** Decisions whose records were sent, routine ones sampled out (decisionSample), and routine ones over maxDecisions. */
  private decisionRecords = 0;
  private decisionsSampledOut = 0;
  private decisionsCapped = 0;
  /** Routine decisions whose records were sent: the count maxDecisions caps. */
  private routineRecords = 0;
  private pending = new Set<Promise<void>>();
  private offs: (() => void)[] = [];
  private readonly c = {
    decisions: 0,
    acted: 0,
    detections: 0,
    possibleDetections: 0,
    actionsOk: 0,
    actionsFailed: 0,
    lateReverts: 0,
    undos: 0,
    vetoes: 0,
    breakerTrips: 0,
    byTrigger: {} as Counts,
    byDiagnosis: {} as Counts,
    byAction: {} as Counts,
    detectionsByDiagnosis: {} as Counts,
    limits: {} as Counts,
    modelErrors: {} as Counts,
    failOpen: {} as Counts,
  };

  constructor(
    private readonly rt: RuntimeImpl,
    private readonly cfg: TelemetryConfig,
    private readonly g: Record<string, unknown>,
    info: TelemetrySessionInfo,
  ) {
    this.t0 = rt.clock.now();
    this.lastSummaryAt = this.t0;
    this.session(info);
    // skipped before the runtime could report a change (the device floor): say why right after the session
    const st = rt.status;
    if (st.state === "skipped" || st.state === "error") this.modelEvent(st);
    this.listen();
  }

  get endpoint(): string {
    return this.cfg.endpoint;
  }
  get sessionId(): string {
    return this.cfg.sessionId;
  }
  get token(): string | undefined {
    return this.cfg.token;
  }

  // ------------------------------------------------------------------------------------------------ events

  private at(): number {
    return Math.round(this.rt.clock.now() - this.t0);
  }

  private push(e: Ev): void {
    if (this.stopped) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.dropped++;
      return;
    }
    e.seq = this.seq++;
    e.at = this.at();
    this.queue.push(compact(e));
    this.arm();
  }

  private route(): string | undefined {
    try {
      const p = (this.g.location as { pathname?: unknown } | undefined)?.pathname;
      return typeof p === "string" ? cut(normalizePath(p), 200) : undefined;
    } catch {
      return undefined;
    }
  }

  private session(info: TelemetrySessionInfo): void {
    const nav = (this.g.navigator ?? {}) as { gpu?: unknown; hardwareConcurrency?: unknown; deviceMemory?: unknown; connection?: { effectiveType?: unknown; saveData?: unknown } };
    let host: string | undefined;
    try {
      host = cut((this.g.location as { hostname?: unknown } | undefined)?.hostname, 253);
    } catch {
      /* no location */
    }
    const st = this.rt.status;
    this.modelKey = `${st.state}|${st.version ?? ""}`;
    this.statusKey = this.statusKeyOf(st);
    this.push({
      t: "session",
      runtime: RUNTIME_VERSION,
      host,
      route: this.route(),
      mode: this.rt.mode,
      effectiveMode: st.effectiveMode,
      aggressiveness: r4(this.rt.aggressiveness),
      sampled: st.sampled,
      model: info.model,
      modelState: st.state,
      modelVersion: st.version,
      triage: info.triage,
      shadow: info.shadow || undefined,
      holdWrites: info.holdWrites || undefined,
      install: info.install,
      device: compact({
        webgpu: !!nav.gpu,
        cores: typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : undefined,
        memoryGB: typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined,
        crossOriginIsolated: typeof this.g.crossOriginIsolated === "boolean" ? this.g.crossOriginIsolated : undefined,
        effectiveType: cut(nav.connection?.effectiveType, 16),
        saveData: typeof nav.connection?.saveData === "boolean" ? nav.connection.saveData : undefined,
      }),
      sample: this.cfg.sample,
      situation: this.cfg.situation,
      decisionSample: this.cfg.decisionSample,
      maxDecisions: this.cfg.maxDecisions,
    });
  }

  /**
   * Whether this decision's records are sent. Not routine (a diagnosis other than "expected", an action, a veto, a
   * shadow pass): always, never sampled or capped. Routine: while fewer than `maxDecisions` routine records were sent
   * in this page load, a `decisionSample` share drawn from a hash of the session and decision ids. Counts are kept
   * either way.
   */
  private sends(id: string, routine: boolean): boolean {
    if (routine) {
      if (this.routineRecords >= this.cfg.maxDecisions) {
        this.decisionsCapped++;
        return false;
      }
      if (this.cfg.decisionSample < 1 && decisionDraw(`${this.cfg.sessionId}:${id}`) >= this.cfg.decisionSample) {
        this.decisionsSampledOut++;
        return false;
      }
      this.routineRecords++;
    }
    this.decisionRecords++;
    return true;
  }

  private statusKeyOf(s: ModelStatus): string {
    return `${this.rt.mode}|${s.effectiveMode ?? ""}|${this.rt.aggressiveness}|${s.breaker?.tripped ? 1 : 0}`;
  }

  private onStatus(): void {
    const s = this.rt.status;
    const mk = `${s.state}|${s.version ?? ""}`;
    if (mk !== this.modelKey) {
      this.modelKey = mk;
      this.modelEvent(s);
    }
    const sk = this.statusKeyOf(s);
    if (sk !== this.statusKey) {
      this.statusKey = sk;
      this.push({ t: "status", mode: this.rt.mode, effectiveMode: s.effectiveMode, aggressiveness: r4(this.rt.aggressiveness), breaker: !!s.breaker?.tripped });
    }
  }

  private modelEvent(s: ModelStatus): void {
    this.push({
      t: "model",
      state: s.state,
      version: s.version,
      model: cut(s.model, 80),
      variant: cut(s.variant, 80),
      device: s.device,
      threads: s.threads,
      worker: s.worker,
      workerError: cut(noUrls(s.workerError), 200),
      gpu: cut(s.gpu, 120),
      ort: cut(s.ort, 40),
      loadMs: typeof s.loadMs === "number" ? Math.round(s.loadMs) : undefined,
      warmupMs: typeof s.warmupMs === "number" ? Math.round(s.warmupMs) : undefined,
      fromCache: s.fromCache,
      bytes: s.bytes,
      phase: s.phase,
      reason: cut(s.reason, 120),
      error: cut(s.error, 200),
      attempts: Array.isArray(s.attempts) ? s.attempts.slice(0, 6).map((a) => ({ variant: cut(a.variant, 80), device: cut(a.device, 16), error: cut(a.error, 160) })) : undefined,
    });
  }

  private onDecide(d: Decision): void {
    this.dirty = true;
    const c = this.c;
    c.decisions++;
    inc(c.byTrigger, d.trigger);
    inc(c.byDiagnosis, d.diagnosis);
    inc(c.byAction, d.ran);
    const acted = d.executed && d.tier !== "passive";
    if (acted) c.acted++;
    const vetoed = d.reason === "vetoed" || d.reason === "would-veto";
    if (vetoed) c.vetoes++;
    const info = this.rt.decisionInfo(d.id);
    const gates = info?.gates;
    // routine: the top diagnosis is "expected" and nothing acted, was vetoed or would have acted in shadow mode. Every
    // detection (its "detect" event follows this one) has a diagnosis other than "expected", so its record is never
    // sampled out or capped; only which records are sent depends on this, never what is counted
    const routine = d.diagnosis === "expected" && !acted && !vetoed && !d.shadow?.wouldPass;
    if (!this.sends(d.id, routine)) {
      // counted, not sent: the periodic summary is due from the flush timer, which queued events arm otherwise
      this.arm();
      return;
    }
    this.push({
      t: "decision",
      id: d.id,
      trigger: d.trigger,
      route: this.route(),
      model: cut(d.model, 80),
      latencyMs: Math.round(d.latencyMs),
      held: info?.held,
      situation: this.cfg.situation ? info?.situationText : undefined,
      // the situation includes automatically discovered state (InitOptions.autoState), redacted like registered stores
      autoState: info?.autoState ? true : undefined,
      budget: info?.budget,
      compact: info?.compact,
      questions: Object.keys(d.answers ?? {}),
      answers: answersOut(d.answers),
      diagnosis: d.diagnosis,
      diagnosisConfidence: r4(d.diagnosisConfidence),
      action: d.action,
      confidence: r4(d.confidence),
      tier: d.tier,
      candidate: d.candidate,
      ran: d.ran,
      executed: d.executed,
      acted,
      reason: cut(d.reason, 120),
      mass: r4(d.mass),
      gateKind: d.gateKind,
      threshold: r4(d.threshold),
      gain: r4(d.gain),
      margin: r4(d.margin),
      thresholdSource: d.thresholdSource,
      gates: gates
        ? compact({ report: r4(gates.report), guard: r4(gates.guard), heal: r4(gates.heal), aggressiveness: r4(gates.aggressiveness), level: gates.level, levelSource: gates.levelSource, source: gates.source })
        : undefined,
      effectiveMode: d.effectiveMode,
      shadow: d.shadow ? compact({ action: d.shadow.action, tier: d.shadow.tier, wouldPass: d.shadow.wouldPass, reason: cut(d.shadow.reason, 120) }) : undefined,
      // the protect()ed function the subject ran inside (a name the app chose), only on batches that carry the app's
      // token: it feeds that app's dashboard and is not sent otherwise; a label that looks like data is redacted
      fn: this.cfg.token ? fnLabel(d.fn) : undefined,
    });
    if (vetoed) this.push({ t: "veto", decision: d.id, action: d.candidate ?? d.action, enforced: d.reason === "vetoed" });
  }

  private onDetect(d: Decision): void {
    this.dirty = true;
    // the tier (likely at the report gate, possible below it in observe) follows from p and the gates already in the
    // decision record; only a possible one says so (`tier: "possible"`: no field means likely, as from earlier
    // runtimes). `detections` and `detectionsByDiagnosis` keep counting the likely ones, as before 0.3.0
    const possible = d.detection === "possible";
    if (possible) this.c.possibleDetections++;
    else {
      this.c.detections++;
      inc(this.c.detectionsByDiagnosis, d.diagnosis);
    }
    // never sampled or capped (its decision record went too: a detection's diagnosis is never "expected")
    this.push({ t: "detect", decision: d.id, trigger: d.trigger, diagnosis: d.diagnosis, p: r4(d.diagnosisConfidence), tier: possible ? "possible" : undefined });
  }

  private onAct(a: ActionRecord): void {
    this.dirty = true;
    if (a.ok) this.c.actionsOk++;
    else this.c.actionsFailed++;
    if (a.late) this.c.lateReverts++;
    // never the error message or the changed sentence (app text); only what happened
    this.push({
      t: "action",
      id: a.id,
      decision: a.decisionId,
      action: a.action,
      tier: a.tier,
      trigger: a.trigger,
      outcome: a.ok ? "applied" : "failed",
      late: a.late || undefined,
      reversible: typeof a.undo === "function",
      droppedFields: Array.isArray(a.dropped) ? a.dropped.length : undefined,
    });
  }

  private listen(): void {
    const rt = this.rt;
    const safe =
      <T>(fn: (v: T) => void) =>
      (v: T) => {
        try {
          fn(v);
        } catch {
          /* telemetry never breaks the runtime */
        }
      };
    this.offs.push(rt.on("decide", safe((d) => this.onDecide(d))));
    this.offs.push(rt.on("detect", safe((d) => this.onDetect(d))));
    this.offs.push(rt.on("act", safe((a) => this.onAct(a))));
    this.offs.push(rt.on("status", safe(() => this.onStatus())));
    this.offs.push(
      rt.on(
        "report",
        safe((r) => {
          if (r.kind === "undo" && r.action) {
            this.dirty = true;
            this.c.undos++;
            this.push({ t: "action", id: r.action.id, decision: r.action.decisionId, action: r.action.action, tier: r.action.tier, trigger: r.action.trigger, outcome: "undone" });
          }
        }),
      ),
    );
    this.offs.push(
      rt.on(
        "breaker",
        safe((b) => {
          this.dirty = true;
          if (b.tripped) this.c.breakerTrips++;
          this.push({ t: "breaker", tripped: b.tripped, reason: b.reason, undos: b.counts.undos, errors: b.counts.errors, decisions: b.decisionIds.slice(0, 20) });
        }),
      ),
    );
    this.offs.push(
      rt.on(
        "limit",
        safe((l) => {
          this.dirty = true;
          inc(this.c.limits, l.kind);
        }),
      ),
    );
    const prevTap = rt.tap;
    rt.tap = {
      modelError: (e) => {
        try {
          prevTap?.modelError?.(e);
        } catch {
          /* ignore */
        }
        this.dirty = true;
        const err = e as { code?: unknown; name?: unknown; message?: unknown } | null;
        const code = cut(typeof err?.code === "string" ? err.code : typeof err?.name === "string" ? err.name : "error", 40) ?? "error";
        inc(this.c.modelErrors, code);
        if (this.errorEvents++ < MAX_ERROR_EVENTS) this.push({ t: "model-error", code, message: cut(typeof err?.message === "string" ? err.message : String(e), 200) });
      },
      failOpen: (reason, trigger) => {
        try {
          prevTap?.failOpen?.(reason, trigger);
        } catch {
          /* ignore */
        }
        this.dirty = true;
        inc(this.c.failOpen, `${reason}:${trigger}`);
      },
    };
    this.offs.push(() => {
      rt.tap = prevTap;
    });
    // page exit: summary + beacon
    const g = this.g as { addEventListener?: (t: string, fn: () => void) => void; removeEventListener?: (t: string, fn: () => void) => void; document?: unknown };
    const doc = g.document as (EventTarget & { visibilityState?: string }) | undefined;
    const onHide = () => {
      try {
        if (doc?.visibilityState !== "hidden") return;
        this.summary("hidden");
        void this.flush(true);
      } catch {
        /* ignore */
      }
    };
    const onPageHide = () => {
      try {
        this.summary("pagehide");
        void this.flush(true);
      } catch {
        /* ignore */
      }
    };
    try {
      if (typeof g.addEventListener === "function") {
        g.addEventListener("pagehide", onPageHide);
        this.offs.push(() => g.removeEventListener?.("pagehide", onPageHide));
      }
      if (doc && typeof doc.addEventListener === "function") {
        doc.addEventListener("visibilitychange", onHide);
        this.offs.push(() => doc.removeEventListener("visibilitychange", onHide));
      }
    } catch {
      /* ignore */
    }
    rt.addTeardown(() => this.stop());
  }

  // ------------------------------------------------------------------------------------------ summary, send

  /** Queue a summary event (counts since the session started). */
  summary(reason: "periodic" | "hidden" | "pagehide" | "destroy"): void {
    if (this.stopped) return;
    this.dirty = false;
    this.lastSummaryAt = this.rt.clock.now();
    let rs: ReturnType<RuntimeImpl["summary"]> | undefined;
    try {
      rs = this.rt.summary();
    } catch {
      /* ignore */
    }
    const c = this.c;
    this.push({
      t: "summary",
      reason,
      counts: {
        decisions: c.decisions,
        acted: c.acted,
        detections: c.detections,
        possibleDetections: c.possibleDetections,
        actionsOk: c.actionsOk,
        actionsFailed: c.actionsFailed,
        lateReverts: c.lateReverts,
        undos: c.undos,
        vetoes: c.vetoes,
        breakerTrips: c.breakerTrips,
        byTrigger: { ...c.byTrigger },
        byDiagnosis: { ...c.byDiagnosis },
        byAction: { ...c.byAction },
        detectionsByDiagnosis: { ...c.detectionsByDiagnosis },
        limits: { ...c.limits },
        modelErrors: { ...c.modelErrors },
        failOpen: { ...c.failOpen },
      },
      runtime: rs
        ? {
            model: compact({ state: rs.model.state, p50Ms: r4(rs.model.p50Ms), p95Ms: r4(rs.model.p95Ms), decisions: rs.model.decisions, dropped: rs.model.dropped, hiddenSkipped: rs.model.hiddenSkipped }),
            heldMs: { total: Math.round(rs.heldMs.total), max: Math.round(rs.heldMs.max) },
            denied: { ...rs.denied },
            shadow: { ...rs.shadow },
            errors: rs.errors,
          }
        : undefined,
      telemetry: {
        queued: this.queue.length,
        dropped: this.dropped,
        sendFailures: this.sendFailures,
        sentEvents: this.sentEvents,
        decisionRecords: this.decisionRecords,
        decisionsSampledOut: this.decisionsSampledOut,
        decisionsCapped: this.decisionsCapped,
      },
    });
  }

  private arm(): void {
    if (this.timer !== null || this.stopped) return;
    try {
      // during a back-off the next send waits for its end
      const wait = Math.max(this.cfg.flushMs, this.backoffUntil - this.rt.clock.now());
      this.timer = this.rt.clock.setTimeout(() => {
        this.timer = null;
        if (this.dirty && this.rt.clock.now() - this.lastSummaryAt >= SUMMARY_MS) this.summary("periodic");
        void this.flush(false);
      }, wait);
    } catch {
      this.timer = null;
    }
  }

  /**
   * Send everything queued, in requests of ≤ maxBatch events and ≤ MAX_REQUEST_BYTES. Never rejects. During a
   * back-off only a page-exit flush (`beacon`) sends; otherwise the queue waits for the back-off to end.
   */
  flush(beacon = false): Promise<void> {
    try {
      if (this.timer !== null) {
        this.rt.clock.clearTimeout(this.timer);
        this.timer = null;
      }
      if (!beacon && this.rt.clock.now() < this.backoffUntil) {
        if (this.queue.length) this.arm();
        return Promise.resolve();
      }
      const sends: Promise<void>[] = [];
      while (this.queue.length) {
        const parts: string[] = [];
        const batch: Ev[] = [];
        let n = 0;
        const head = this.header();
        let bytes = head.length + 2;
        while (this.queue.length && n < this.cfg.maxBatch) {
          let s: string;
          try {
            s = JSON.stringify(this.queue[0]);
          } catch {
            this.queue.shift();
            this.dropped++;
            continue;
          }
          if (head.length + s.length + 2 > MAX_REQUEST_BYTES) {
            // a single event too large for one request
            this.queue.shift();
            this.dropped++;
            continue;
          }
          if (bytes + s.length + 1 > MAX_REQUEST_BYTES) break;
          batch.push(this.queue.shift()!);
          parts.push(s);
          bytes += s.length + 1;
          n++;
        }
        if (!n) continue;
        sends.push(this.send(`${head}${parts.join(",")}]}`, batch, beacon));
      }
      return Promise.all(sends).then(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  /** Batch envelope up to the events array. */
  private header(): string {
    let model: string | null = null;
    try {
      model = this.rt.status.version ?? null;
    } catch {
      /* ignore */
    }
    const token = this.cfg.token ? `"token":${JSON.stringify(this.cfg.token)},` : "";
    return `{"schema":${JSON.stringify(TELEMETRY_SCHEMA)},${token}"sid":${JSON.stringify(this.cfg.sessionId)},"sent":${this.at()},"runtime":${JSON.stringify(RUNTIME_VERSION)},"model":${JSON.stringify(model)},"events":[`;
  }

  private send(body: string, batch: Ev[], beacon: boolean): Promise<void> {
    let p: Promise<void>;
    try {
      p = Promise.resolve(this.cfg.transport.send(this.cfg.endpoint, body, { beacon })).then(
        () => {
          this.sentEvents += batch.length;
          this.failStreak = 0;
          this.backoffs = 0;
        },
        (e: unknown) => this.refused(e, batch),
      );
    } catch (e) {
      this.refused(e, batch);
      return Promise.resolve();
    }
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
    return p;
  }

  /** A rejected send: a back-off (429, Retry-After) or a failure. */
  private refused(e: unknown, batch: Ev[]): void {
    const b = backoffOf(e);
    if (b === null) this.failed();
    else this.backOff(b, batch);
  }

  /**
   * The collector asked this page to slow down (429, or a Retry-After): not a failure. The batch goes back to the
   * front of the queue (within MAX_QUEUE; what does not fit counts as dropped) and nothing is sent until the
   * Retry-After, else BACKOFF_MS doubling per 429 in a row up to MAX_BACKOFF_MS, has passed.
   */
  private backOff(retryAfterMs: number | undefined, batch: Ev[]): void {
    if (this.stopped) return;
    this.backoffs++;
    // a Retry-After of at most an hour (backoffOf: ≥ 0), else the doubling schedule
    const ms = retryAfterMs ?? Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (this.backoffs - 1));
    this.backoffUntil = Math.max(this.backoffUntil, this.rt.clock.now() + Math.min(3_600_000, ms));
    const room = Math.max(0, MAX_QUEUE - this.queue.length);
    if (batch.length > room) this.dropped += batch.length - room;
    this.queue.unshift(...batch.slice(0, room));
    // several requests of one flush refused: keep the events in the order they were queued
    this.queue.sort((a, b) => (a.seq as number) - (b.seq as number));
    if (this.timer !== null) {
      try {
        this.rt.clock.clearTimeout(this.timer);
      } catch {
        /* ignore */
      }
      this.timer = null;
    }
    this.arm();
  }

  /**
   * A request failed. After MAX_FAIL_STREAK failures in a row the page stops sending for good: a Content-Security-Policy
   * that does not allow the endpoint would otherwise log a violation on every flush, and a dead endpoint costs a request
   * every 10 s for nothing. The queue is dropped; nothing is retried.
   */
  private failed(): void {
    this.sendFailures++;
    this.failStreak++;
    if (this.failStreak < MAX_FAIL_STREAK || this.stopped) return;
    this.dropped += this.queue.length;
    this.queue.length = 0;
    this.stopped = true;
    if (this.timer !== null) {
      try {
        this.rt.clock.clearTimeout(this.timer);
      } catch {
        /* ignore */
      }
      this.timer = null;
    }
  }

  /** Final summary and flush (runtime destroyed). */
  stop(): void {
    if (this.stopped) return;
    try {
      this.summary("destroy");
      void this.flush(false);
    } catch {
      /* ignore */
    }
    this.stopped = true;
    if (this.timer !== null) {
      try {
        this.rt.clock.clearTimeout(this.timer);
      } catch {
        /* ignore */
      }
      this.timer = null;
    }
    for (const off of this.offs.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
  }

  /** Requests still in flight (tests, e2e). */
  settled(): Promise<void> {
    return Promise.all([...this.pending]).then(() => undefined);
  }
}

/**
 * A rejected send that asks for a back-off: the error's `status` is 429, or it carries `retryAfterMs` (the transport
 * read a Retry-After header). Returns the wait in ms (undefined: none given), or null for an ordinary failure.
 */
export function backoffOf(e: unknown): number | undefined | null {
  if (!e || typeof e !== "object") return null;
  const x = e as { status?: unknown; retryAfterMs?: unknown };
  const ra = typeof x.retryAfterMs === "number" && Number.isFinite(x.retryAfterMs) && x.retryAfterMs >= 0 ? x.retryAfterMs : undefined;
  if (ra !== undefined) return ra;
  return x.status === 429 ? undefined : null;
}

/** runtime.telemetry when nothing is sent. */
export function telemetryOff(reason: string): TelemetryStatus {
  return { enabled: false, reason, flush: () => Promise.resolve() };
}

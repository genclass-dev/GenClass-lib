// What happened on this page, in order (docs/runtime/AGENT.md section 2): user actions, requests (by key), the order
// their responses were delivered, state writes, errors, and two happens-before facts the runtime already computes for
// its situations, recorded here as witnesses:
//   overwrote-newer      a request's response chain wrote a field that a newer operation (one that started after the
//                        request did, outside its causal chain) or the user had written since the request started
//   identical-in-flight  two identical requests (same method, URL and body) in flight together, from separate user
//                        actions
// Witnesses are facts, never diagnoses: whether one is a bug is for the order comparison (explore), the model or the
// developer to say. Nothing here feeds the model, a situation, the gate or the event log; it only reads the runtime's
// internals (events, ops, store fields) and keeps bounded lists.

import type { Clock } from "../types.js";
import type { OpRec } from "../trace/ops.js";
import type { RuntimeInternals } from "../runtime.js";
import type { Delivered, ScheduleSpec } from "./schedule.js";

export const SCHEDULE_SCHEMA = "genclass-schedule/1";
const MAX_STEPS = 600;
const MAX_WITNESSES = 100;
const MAX_VALUE = 500;
const MAX_PATHS_CHECKED = 200;
const NET = new Set(["fetch", "xhr"]);
/** A write this long after its request ended is no longer "that response's" write (as the runtime's 10 s windows). */
const CHAIN_WINDOW_MS = 10_000;
/** A timer callback scheduled with at least this delay, or any interval tick, starts a new chain (not the response's). */
const LONG_TIMER_MS = 1000;
/** Fan-out siblings start within this window of each other (src/runtime.ts FANOUT_WINDOW_MS; kept equal). */
const FANOUT_WINDOW_MS = 100;

/**
 * x and w are fan-out siblings: requests of one kind started by the same direct cause within FANOUT_WINDOW_MS (one
 * timer tick or user action fetching several items). Their completion order is arbitrary, not older vs newer. The same
 * predicate as src/runtime.ts fanOutSibling, copied so this entry imports no runtime code (it would share a chunk with
 * the first load).
 */
function fanOutSibling(x: { cause?: number | null; kind: string; start: number }, w: { cause?: number | null; kind: string; start: number }): boolean {
  return x.cause !== undefined && x.cause !== null && w.cause === x.cause && w.kind === x.kind && Math.abs(w.start - x.start) <= FANOUT_WINDOW_MS;
}

/** "timer 300ms" → 300, "timer 1.2s" → 1200, "interval 1s" → Infinity (every tick is a chain of its own). */
function timerDelay(name: string): number {
  if (name.startsWith("interval")) return Infinity;
  const m = /^timer (\d+(?:\.\d+)?)(ms|s)$/.exec(name);
  return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : 0;
}

/** One user action (a typing burst is one action with its final value). */
export interface ActStep {
  k: "act";
  /** Index among this page's actions (0-based). */
  i: number;
  t: number;
  kind: string;
  /** 'button "Place order"', 'searchbox "Search"' (the runtime's element description). */
  target?: string;
  /** Typed or chosen value ("[redacted]" for sensitive fields). */
  value?: string;
  key?: string;
  clicks?: number;
  /** Keystrokes in a typing burst. */
  count?: number;
  /** ms from a typing burst's first keystroke to its last (its pace, for replays). */
  dur?: number;
}

export type Step =
  | ActStep
  | { k: "send"; t: number; key: string; detail?: string; act?: number; via?: string }
  | { k: "recv"; t: number; key: string; held?: number; forced?: boolean }
  | { k: "end"; t: number; key: string; status: string; code?: number | string }
  | { k: "write"; t: number; store: string; paths: string[]; by?: string; act?: number; summary?: string[] }
  | { k: "error"; t: number; message: string; by?: string; act?: number };

export interface Witness {
  kind: "overwrote-newer" | "identical-in-flight";
  t: number;
  /** overwrote-newer: the field; identical-in-flight: the request signature. */
  subject: string;
  /** The request whose response chain wrote (overwrote-newer), or the second identical request. */
  by: string;
  byDetail?: string;
  /** What it landed over: the newer request's key, or the user action ('type textbox "Title"'). */
  over: string;
  overKind: "request" | "user";
  /** The user action at the root of each side, when there is one (action index). */
  byAct?: number;
  overAct?: number;
  /** ms: how long after `by` started the newer write / second request happened. */
  gapMs?: number;
  /** The field's change, redacted ("6 items → 2 items"). */
  change?: string;
}

export interface ErrorRec {
  t: number;
  name: string;
  message: string;
  source?: string;
  stack?: string;
  /** The causal chain at the error, newest first: request keys and user actions. */
  chain: string[];
  act?: number;
}

/** A recorded run: the steps and the delivery order, replayable with `{ order: "given", given: order }`. */
export interface RecordedSchedule {
  schema: typeof SCHEDULE_SCHEMA;
  route: string;
  spec: ScheduleSpec | null;
  steps: Step[];
  /** Request keys in the order their responses were delivered. */
  order: string[];
  /** Responses the schedule held to its limit (the run did not follow the schedule exactly). */
  forced: number;
  truncated: boolean;
}

/** Keys for requests come from the scheduler (one numbering per page load). */
export type KeyOf = (op: OpRec) => string;

export class Recorder {
  readonly steps: Step[] = [];
  readonly order: string[] = [];
  readonly witnesses: Witness[] = [];
  readonly errors: ErrorRec[] = [];
  /** Recent actions by index (bounded), for re-sending a typing burst that changed after it was sent. */
  readonly acts = new Map<number, ActStep>();
  /** Actions changed in place (a typing burst) since the last send. */
  readonly updated = new Set<number>();
  private nActs = 0;
  private actByOp = new Map<number, number>();
  private actByEvent = new Map<number, ActStep>();
  private seenWitness = new Set<string>();
  truncated = false;
  /** Steps recorded so far (the list keeps the newest MAX_STEPS). */
  pushed = 0;
  /** Called for each new witness and error (the bridge link streams them). */
  onWitness: ((w: Witness) => void) | null = null;
  onError: ((e: ErrorRec) => void) | null = null;
  private readonly t0: number;

  constructor(
    private readonly rt: Pick<RuntimeInternals, "hub" | "ops" | "clock">,
    private readonly keyOf: KeyOf,
    private readonly redact: (path: string, v: unknown) => string,
  ) {
    this.t0 = rt.clock.now();
  }

  private get ops(): RuntimeInternals["ops"] {
    return this.rt.ops;
  }

  private rel(t: number): number {
    return Math.round(t - this.t0);
  }

  private push(s: Step): void {
    this.pushed++;
    this.steps.push(s);
    if (this.steps.length > MAX_STEPS) {
      this.steps.splice(0, this.steps.length - MAX_STEPS);
      this.truncated = true;
    }
  }

  /** The action index at the root of an op's chain (its nearest user op). */
  actOf(op: OpRec | undefined | null): number | undefined {
    const u = this.ops.userOf(op);
    if (!u) return undefined;
    return this.actByOp.get(u.id);
  }

  /** A label for an op in a chain: a request's key, a user action, or the op's signature. */
  label(op: OpRec): string {
    if (NET.has(op.kind)) return this.keyOf(op);
    return op.name;
  }

  user(e: { seq: number; t: number; op?: number; data?: Record<string, unknown> }, touched: boolean): void {
    const d = e.data ?? {};
    const op = this.ops.get(e.op);
    const action = (op?.meta as { action?: { kind?: string; value?: string; key?: string; clicks?: number; target?: string } } | undefined)?.action;
    const prev = this.actByEvent.get(e.seq);
    if (prev && touched) {
      // a typing burst: the same action, with its latest value
      if (action?.value !== undefined) prev.value = String(action.value).slice(0, MAX_VALUE);
      prev.count = typeof d.count === "number" ? d.count : (prev.count ?? 1) + 1;
      const last = typeof d.lastT === "number" ? d.lastT : e.t;
      prev.dur = Math.max(0, Math.round(this.rel(last) - prev.t));
      if (op) this.mapOp(op.id, prev.i);
      this.updated.add(prev.i);
      return;
    }
    const a: ActStep = { k: "act", i: this.nActs++, t: this.rel(e.t), kind: String(d.kind ?? action?.kind ?? "action") };
    const target = d.target ?? action?.target;
    if (typeof target === "string" && target) a.target = target.slice(0, 200);
    if (action?.value !== undefined) a.value = String(action.value).slice(0, MAX_VALUE);
    if (action?.key) a.key = String(action.key).slice(0, 40);
    if (typeof action?.clicks === "number") a.clicks = action.clicks;
    this.acts.set(a.i, a);
    if (this.acts.size > 500) this.acts.delete(this.acts.keys().next().value as number);
    this.actByEvent.set(e.seq, a);
    if (this.actByEvent.size > 2000) this.actByEvent.delete(this.actByEvent.keys().next().value as number);
    if (op) this.mapOp(op.id, a.i);
    this.push(a);
  }

  private mapOp(id: number, act: number): void {
    this.actByOp.set(id, act);
    if (this.actByOp.size > 4000) this.actByOp.delete(this.actByOp.keys().next().value as number);
  }

  sent(op: OpRec): void {
    const s: Step = { k: "send", t: this.rel(op.start), key: this.keyOf(op) };
    if (op.detail) s.detail = op.detail.slice(0, 160);
    const act = this.actOf(op);
    if (act !== undefined) s.act = act;
    const cause = this.ops.get(op.cause);
    if (cause && cause.kind !== "user") s.via = cause.name.slice(0, 120);
    this.push(s);
  }

  delivered(d: Delivered): void {
    this.order.push(d.key);
    if (this.order.length > 2000) this.order.splice(0, this.order.length - 2000);
    const s: Step = { k: "recv", t: this.rel(d.at), key: d.key };
    if (d.heldMs >= 1) s.held = Math.round(d.heldMs);
    if (d.forced) s.forced = true;
    this.push(s);
  }

  /** A request ended without a delivery (failed, aborted). */
  endedWithout(op: OpRec): void {
    const s: Step = { k: "end", t: this.rel(op.end ?? this.rt.clock.now()), key: this.keyOf(op), status: String(op.status ?? "error") };
    if (op.code !== undefined) s.code = op.code;
    this.push(s);
  }

  /**
   * A state write (the hub's "state" event). `backfill`: a write from before connectAgent, replayed from the event log;
   * the hub's log already holds later writes, so no witness is computed for it.
   */
  wrote(e: { t: number; op?: number; data?: Record<string, unknown> }, backfill = false): void {
    const d = e.data ?? {};
    const store = String(d.store ?? "");
    const all = Array.isArray(d.paths) ? (d.paths as unknown[]).filter((p): p is string => typeof p === "string") : [];
    const writer = this.ops.get(e.op);
    const s: Step = { k: "write", t: this.rel(e.t), store, paths: all.slice(0, 12) };
    const net = writer ? this.netOf(writer) : undefined;
    if (net) s.by = this.keyOf(net);
    const act = this.actOf(writer);
    if (act !== undefined) s.act = act;
    if (Array.isArray(d.summary)) s.summary = (d.summary as string[]).slice(0, 3).map((x) => String(x).slice(0, 160));
    this.push(s);
    // a response's chain, while it is still that response's (not a late timer or interval it scheduled)
    if (net && !d.user && !backfill && e.t - (net.end ?? net.start) <= CHAIN_WINDOW_MS) for (const p of all.slice(0, MAX_PATHS_CHECKED)) this.checkOverNewer(net, p, e.t);
  }

  /**
   * The nearest request in an op's chain (itself included). The walk stops at an interval tick or a long timer: what a
   * ticker or a deferred job writes is not the response's write, even when the response's handler scheduled it.
   */
  private netOf(op: OpRec): OpRec | undefined {
    if (NET.has(op.kind)) return op;
    for (const a of [op, ...this.ops.ancestors(op, 8)]) {
      if (NET.has(a.kind)) return a;
      if (a.kind === "timer" && timerDelay(a.name) >= LONG_TIMER_MS) return undefined;
    }
    return undefined;
  }

  /**
   * Since `x` started, did a newer operation (started after x, outside x's chain) or the user write `path`? The same
   * relation as the runtime's writtenOver (src/runtime.ts) and the "newer data" facts.
   */
  private checkOverNewer(x: OpRec, path: string, t: number): void {
    if (x.genclass || this.witnesses.length >= MAX_WITNESSES) return;
    const id = `${x.id}|${path}`;
    if (this.seenWitness.has(id)) return;
    const log = this.rt.hub.logSince(path, x.startSeq);
    // the newest qualifying write before this one
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.writer === null) continue;
      const w = this.ops.get(e.writer);
      if (!w || w.genclass || this.ops.isAncestorOrSelf(x, w) || this.ops.isAncestorOrSelf(w, x)) continue;
      const root = this.ops.get(e.root);
      const byUser = e.user || w.kind === "user";
      // a fan-out sibling (one tick or click fetching several things at once) is a peer, not newer data
      const wNet = byUser ? undefined : this.netOf(w);
      if (wNet && fanOutSibling(x, wNet)) continue;
      const newer = byUser || w.start > x.start || (!!root && root.kind === "user" && root.start > x.start);
      if (!newer) continue;
      this.seenWitness.add(id);
      const overOp = byUser ? this.ops.userOf(w) ?? w : this.netOf(w) ?? w;
      const wit: Witness = {
        kind: "overwrote-newer",
        t: this.rel(t),
        subject: path,
        by: this.keyOf(x),
        over: byUser ? overOp.name : this.label(overOp),
        overKind: byUser ? "user" : "request",
        gapMs: Math.round(Math.max(0, (byUser ? e.t : overOp.start) - x.start)),
      };
      if (x.detail) wit.byDetail = x.detail.slice(0, 160);
      const ba = this.actOf(x);
      if (ba !== undefined) wit.byAct = ba;
      const oa = this.actOf(w);
      if (oa !== undefined) wit.overAct = oa;
      const f = this.rt.hub.field(path);
      const h = f?.hist[f.hist.length - 1];
      if (h) wit.change = `${this.redact(path, h.before)} → ${this.redact(path, h.after)}`.slice(0, 200);
      this.addWitness(wit);
      return;
    }
  }

  /** At a request's end: an identical request (same identity) in flight with it, from a separate user action. */
  identical(op: OpRec, inFlightOrRecent: Iterable<OpRec>): void {
    if (!op.identity || op.genclass || op.identity.startsWith("uniq:") || op.status === "aborted" || this.witnesses.length >= MAX_WITNESSES) return;
    const ua = this.ops.userOf(op);
    if (!ua) return;
    for (const o of inFlightOrRecent) {
      if (o === op || o.identity !== op.identity || o.genclass || !NET.has(o.kind) || o.status === "aborted") continue;
      // a retry or hedge of the same request is GenClass's, not a second intent
      if (o.cause === op.id || op.cause === o.id) continue;
      const oEnd = o.end ?? Infinity;
      if (o.start >= (op.end ?? Infinity) || oEnd <= op.start) continue; // not in flight together
      const ub = this.ops.userOf(o);
      if (!ub || ub === ua) continue;
      // keystrokes of one typing burst are one action
      const aa = this.actOf(op);
      if (aa !== undefined && aa === this.actOf(o)) continue;
      const [first, second] = o.start <= op.start ? [o, op] : [op, o];
      const id = `dup|${Math.min(o.id, op.id)}|${Math.max(o.id, op.id)}`;
      if (this.seenWitness.has(id)) continue;
      this.seenWitness.add(id);
      const wit: Witness = {
        kind: "identical-in-flight",
        t: this.rel(second.start),
        subject: op.name,
        by: this.keyOf(second),
        over: this.keyOf(first),
        overKind: "request",
        gapMs: Math.round(second.start - first.start),
      };
      if (second.detail) wit.byDetail = second.detail.slice(0, 160);
      const ba = this.actOf(second);
      if (ba !== undefined) wit.byAct = ba;
      const oa = this.actOf(first);
      if (oa !== undefined) wit.overAct = oa;
      this.addWitness(wit);
    }
  }

  private addWitness(w: Witness): void {
    if (this.witnesses.length >= MAX_WITNESSES) return;
    this.witnesses.push(w);
    try {
      this.onWitness?.(w);
    } catch {
      /* ignore */
    }
  }

  error(e: { t: number; name: string; op?: number; data?: Record<string, unknown> }, stack?: string): void {
    const d = e.data ?? {};
    const op = this.ops.get(e.op);
    const chain: string[] = [];
    if (op) for (const x of [op, ...this.ops.ancestors(op, 8)]) chain.push(this.label(x).slice(0, 160));
    const rec: ErrorRec = { t: this.rel(e.t), name: String(e.name).slice(0, 80), message: String(d.message ?? e.name).slice(0, 300), chain };
    if (typeof d.source === "string") rec.source = d.source.slice(0, 200);
    if (stack) rec.stack = stack.slice(0, 2000);
    const act = this.actOf(op);
    if (act !== undefined) rec.act = act;
    if (this.errors.length < 100) this.errors.push(rec);
    const s: Step = { k: "error", t: rec.t, message: rec.message };
    const net = op ? this.netOf(op) : undefined;
    if (net) s.by = this.keyOf(net);
    if (act !== undefined) s.act = act;
    this.push(s);
    try {
      this.onError?.(rec);
    } catch {
      /* ignore */
    }
  }

  schedule(route: string, spec: ScheduleSpec | null, forced: number): RecordedSchedule {
    return { schema: SCHEDULE_SCHEMA, route, spec, steps: this.steps.slice(), order: this.order.slice(), forced, truncated: this.truncated };
  }
}

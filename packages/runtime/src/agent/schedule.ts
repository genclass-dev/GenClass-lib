// Delivery schedules for the local agent harness (docs/runtime/AGENT.md section 3). A schedule only chooses WHEN each
// response reaches the app, the way a slower or reordering network would: it never drops, changes or invents a
// response, never touches a request, and decides nothing about the app. Every response is delivered; a hold never
// outlasts the response's own `delay` plus `maxHoldMs` (then the run is marked forced).
//
// Orders:
//   natural  deliver as responses arrive (no hold; recording only)
//   fifo     deliver in the order the requests started: the serial baseline an explore run is compared with
//   seeded   each request gets a priority hashed from the seed and its key; a response waits while a request with a
//            higher priority is in flight (probabilistic concurrency testing over the requests that overlap)
//   given    a recorded delivery order (a run's `order`): each response waits for the keys listed before it
//
// Deterministic: priorities and delays are hashes of the seed and the request key (never Math.random); time comes from
// the injected Clock. A request's key is its signature and occurrence in this page load ("GET /api/search#3"), so the
// same scenario gives the same keys on every run, whatever the query values or timing. A retry (attempt > 1) or a hedge
// of a keyed request gets that request's key plus a suffix and does not shift the numbering.
//
// A response counts as delivered when the app receives it (`landed`), not when it is handed to the runtime's own
// delivery path, which in guard or heal may hold it further: until then it still blocks later responses (bounded).

import type { Clock } from "../types.js";

export type ScheduleOrder = "natural" | "fifo" | "seeded" | "given";

/** How responses are delivered on this page (docs/runtime/AGENT.md section 3). */
export interface ScheduleSpec {
  order: ScheduleOrder;
  /** seeded: the seed (a non-negative integer). Also seeds `delay`. */
  seed?: number;
  /** given: request keys in the order their responses are delivered. */
  given?: string[];
  /** seeded: request signatures ("PUT /api/notes/:id") whose responses go after every other overlapping one. */
  focus?: string[];
  /** Extra latency per response, uniform in [minMs, maxMs], hashed from the seed and the key (a slow network). */
  delay?: { minMs: number; maxMs: number };
  /** A response is never held longer than this; then it is delivered and the run is marked forced. Default 1500. */
  maxHoldMs?: number;
  /** Time between two releases, so one response's handlers run before the next arrives. Default 30. */
  gapMs?: number;
  /** Set by the MCP server: the explore session or finding this run belongs to. */
  id?: string;
  /** Free text for reports ("explore 3 of 6"). */
  label?: string;
}

export const DEFAULT_MAX_HOLD_MS = 1500;
export const DEFAULT_GAP_MS = 30;
/** A request older than this neither blocks a delivery nor waits for one (long polls, streams), as in Runtime.busy. */
export const LONG_RUNNING_MS = 10_000;
const ORDERS: readonly ScheduleOrder[] = ["natural", "fifo", "seeded", "given"];

/** 32-bit FNV-1a: the priority and delay hash. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // final avalanche (murmur3 fmix32), so neighbouring keys do not get neighbouring priorities
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** A schedule from untrusted input (URL, a page global, the bridge), or null when it is not one. */
export function parseSpec(v: unknown): ScheduleSpec | null {
  if (typeof v === "string") {
    // URL forms: "fifo", "natural", "seeded:7", "explore:7" (alias), "given:<json array of keys>", or a JSON object
    const s = v.trim();
    const m = /^(natural|fifo|seeded|explore)(?::(\d{1,9}))?$/.exec(s);
    if (m) return m[1] === "natural" || m[1] === "fifo" ? { order: m[1] } : { order: "seeded", seed: Number(m[2] ?? 1) };
    if (s.startsWith("given:")) {
      try {
        return parseSpec({ order: "given", given: JSON.parse(s.slice(6)) as unknown });
      } catch {
        return null;
      }
    }
    if (s.startsWith("{")) {
      try {
        return parseSpec(JSON.parse(s));
      } catch {
        return null;
      }
    }
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const order = o.order as ScheduleOrder;
  if (!ORDERS.includes(order)) return null;
  const out: ScheduleSpec = { order };
  const int = (x: unknown, max: number): number | undefined => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.min(Math.floor(x), max) : undefined);
  const seed = int(o.seed, 2 ** 31);
  if (order === "seeded") out.seed = seed ?? 1;
  else if (seed !== undefined) out.seed = seed;
  if (order === "given") {
    if (!Array.isArray(o.given)) return null;
    out.given = o.given.filter((k): k is string => typeof k === "string" && k.length <= 300).slice(0, 2000);
  }
  if (Array.isArray(o.focus)) out.focus = o.focus.filter((k): k is string => typeof k === "string" && k.length <= 300).slice(0, 20);
  const d = o.delay as Record<string, unknown> | undefined;
  if (d && typeof d === "object") {
    const lo = int(d.minMs, 10_000) ?? 0;
    const hi = Math.max(lo, int(d.maxMs, 10_000) ?? lo);
    if (hi > 0) out.delay = { minMs: lo, maxMs: hi };
  }
  const mh = int(o.maxHoldMs, 30_000);
  if (mh !== undefined) out.maxHoldMs = Math.max(50, mh);
  const gap = int(o.gapMs, 1000);
  if (gap !== undefined) out.gapMs = gap;
  if (typeof o.id === "string" && o.id.length <= 100) out.id = o.id;
  if (typeof o.label === "string" && o.label.length <= 200) out.label = o.label;
  return out;
}

/** The request being scheduled (an OpRec of kind fetch/xhr, as far as the scheduler reads it). */
export interface SchedOp {
  id: number;
  name: string;
  start: number;
  /** 1 for the first try; a GenClass retry is 2, 3, ... */
  attempt?: number;
  /** The op that was ambient when this one started (a hedge's is the request it hedges). */
  cause?: number;
}

/** One request this page load: its key and where its response is. */
export interface Slot {
  op: SchedOp;
  /** "GET /api/search#3": signature and occurrence (1-based) in this page load; retries and hedges add a suffix. */
  key: string;
  /** Seeded priority (higher goes first). */
  prio: number;
  /** When the response reached the delivery gate. */
  arrived?: number;
  /** When the schedule let it go (handed to the runtime's delivery path). */
  released?: number;
  /** When the app received it. */
  delivered?: number;
  /** The request ended without a delivery to schedule (failed, aborted, or passed without the gate). */
  done?: boolean;
  /** Released because its hold ran out, not because the schedule allowed it. */
  forced?: boolean;
  go?: (landed: () => void) => void;
}

/** What the scheduler reports for each delivery (recording). */
export interface Delivered {
  key: string;
  op: number;
  /** When the app received it. */
  at: number;
  /** How long the schedule held it (arrival to release). */
  heldMs: number;
  forced: boolean;
}

/**
 * Holds response deliveries and releases them in the schedule's order. `gate(op, go)` is called at the runtime's
 * delivery gate; `go(landed)` hands the response to the runtime's own delivery path, which calls `landed` when the app
 * receives it. While `spec` is null the schedule is not known yet (the bridge has not answered): deliveries wait, at
 * most `pendingMs` from creation. Never throws into its caller.
 */
export class Scheduler {
  private readonly slots = new Map<number, Slot>();
  private readonly counts = new Map<string, number>();
  private readonly deliveredKeys = new Set<string>();
  private readonly doneKeys = new Set<string>();
  private rank = new Map<string, number>();
  private pendingUntil: number;
  private lastRelease = -Infinity;
  private gapTimer: unknown = null;
  private wakeTimer: unknown = null;
  private pumping = false;
  private again = false;
  private disposed = false;
  forced = 0;

  constructor(
    private readonly clock: Clock,
    private spec: ScheduleSpec | null,
    private readonly onDeliver: (d: Delivered) => void,
    pendingMs = 600,
  ) {
    this.pendingUntil = clock.now() + pendingMs;
    if (spec) this.setSpec(spec);
    else this.clock.setTimeout(() => this.pump(), pendingMs + 1);
  }

  get current(): ScheduleSpec | null {
    return this.spec;
  }

  /** The schedule arrived (or changed). Held deliveries are re-evaluated at once. */
  setSpec(spec: ScheduleSpec): void {
    this.spec = spec;
    this.rank = new Map((spec.order === "given" ? spec.given ?? [] : []).map((k, i) => [k, i]));
    for (const s of this.slots.values()) s.prio = this.prioOf(s.key, s.op.id);
    this.pump();
  }

  /** A request started (fetch/xhr): its key is assigned now, in start order. */
  started(op: SchedOp): Slot {
    let s = this.slots.get(op.id);
    if (s) return s;
    let key: string;
    const parent = op.cause !== undefined ? this.slots.get(op.cause) : undefined;
    if (parent && parent.op.name === op.name) key = `${parent.key}~${(op.attempt ?? 1) > (parent.op.attempt ?? 1) ? `retry${op.attempt}` : "hedge"}`;
    else if ((op.attempt ?? 1) > 1) key = `${op.name}#${this.counts.get(op.name) ?? 0}~retry${op.attempt}`;
    else {
      const n = (this.counts.get(op.name) ?? 0) + 1;
      this.counts.set(op.name, n);
      key = `${op.name}#${n}`;
    }
    s = { op, key, prio: this.prioOf(key, op.id) };
    this.slots.set(op.id, s);
    if (this.slots.size > 4000) this.prune();
    return s;
  }

  slot(id: number): Slot | undefined {
    return this.slots.get(id);
  }

  /** A response reached the delivery gate. `go(landed)` delivers it; called exactly once (now or later). */
  gate(op: SchedOp, go: (landed: () => void) => void): void {
    const s = this.started(op);
    if (s.go || s.released !== undefined) return this.call(go, () => undefined); // a second delivery of one op: pass
    s.arrived = this.clock.now();
    s.go = go;
    const spec = this.spec;
    if (spec && spec.order === "natural" && !spec.delay) return this.release(s, false);
    this.pump();
  }

  /** A response the schedule must not hold (a protected request): delivered at once, recorded like the others. */
  pass(op: SchedOp, go: (landed: () => void) => void): void {
    const s = this.started(op);
    if (s.go || s.released !== undefined) return this.call(go, () => undefined);
    s.arrived = this.clock.now();
    s.go = go;
    this.release(s, false);
  }

  /** The app received a response the schedule released. */
  landed(id: number): void {
    const s = this.slots.get(id);
    if (!s || s.delivered !== undefined) return;
    const now = this.clock.now();
    s.delivered = now;
    this.deliveredKeys.add(s.key);
    try {
      this.onDeliver({ key: s.key, op: s.op.id, at: now, heldMs: (s.released ?? now) - (s.arrived ?? now), forced: !!s.forced });
    } catch {
      /* recording never blocks a delivery */
    }
    this.pump();
  }

  /**
   * A request ended without a delivery to schedule (failed, aborted, answered elsewhere), or its held response was
   * dropped by the app (an XHR aborted while held): it stops blocking others and is never recorded as delivered.
   */
  ended(id: number): void {
    const s = this.slots.get(id);
    if (!s || s.delivered !== undefined || s.done) return;
    if (s.released !== undefined) return; // in the runtime's delivery path: it lands or not on its own
    s.done = true;
    this.doneKeys.add(s.key);
    const go = s.go;
    if (go) {
      // let the runtime finish its own bookkeeping for the dropped response (its release is a no-op by then)
      s.go = undefined;
      s.released = this.clock.now();
      this.call(go, () => undefined);
    }
    this.pump();
  }

  /** Responses waiting at the gate. */
  held(): Slot[] {
    return [...this.slots.values()].filter((s) => s.go && s.released === undefined);
  }

  /** Deliver everything now (disconnect, destroy). */
  dispose(): void {
    this.disposed = true;
    for (const t of [this.gapTimer, this.wakeTimer]) if (t !== null) this.clock.clearTimeout(t);
    this.gapTimer = this.wakeTimer = null;
    for (const s of this.held().sort((a, b) => a.op.id - b.op.id)) this.release(s, false);
  }

  private prioOf(key: string, id: number): number {
    const spec = this.spec;
    if (!spec || spec.order !== "seeded") return -id;
    const base = key.slice(0, key.lastIndexOf("#"));
    const focus = spec.focus?.includes(base) ? 0 : 2 ** 32;
    return focus + hash32(`${spec.seed ?? 1}|${key}`);
  }

  private delayOf(key: string): number {
    const d = this.spec?.delay;
    if (!d) return 0;
    const span = d.maxMs - d.minMs;
    return d.minMs + (span > 0 ? hash32(`${this.spec?.seed ?? 0}|delay|${key}`) % (span + 1) : 0);
  }

  private holdOf(): number {
    return this.spec?.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  }

  /** Does `o` keep later responses waiting? Not once done, delivered, long-running, or stuck in the runtime's path. */
  private blocks(o: Slot, now: number): boolean {
    if (o.done || o.delivered !== undefined || now - o.op.start >= LONG_RUNNING_MS) return false;
    return o.released === undefined || now - o.released < this.holdOf();
  }

  /** May this held response be delivered now? `forced` when only the hold limit allows it. */
  private verdict(s: Slot, now: number): "go" | "wait" | "forced" {
    const spec = this.spec;
    if (this.disposed || now - s.op.start >= LONG_RUNNING_MS) return "go";
    const hold = this.holdOf();
    const arrived = s.arrived ?? now;
    if (!spec) return now >= this.pendingUntil ? "go" : now - arrived >= hold ? "forced" : "wait";
    // a response's own delay is the slow network it emulates: it never counts against the hold limit
    const d = this.delayOf(s.key);
    if (now - arrived < d) return "wait";
    const timedOut = now - arrived - d >= hold;
    let blocked = false;
    if (spec.order === "fifo" || spec.order === "seeded") {
      for (const o of this.slots.values()) {
        if (o === s || !this.blocks(o, now)) continue;
        const ahead = spec.order === "fifo" ? o.op.start < s.op.start || (o.op.start === s.op.start && o.op.id < s.op.id) : o.prio > s.prio;
        if (ahead) {
          blocked = true;
          break;
        }
      }
    } else if (spec.order === "given") {
      const r = this.rank.get(s.key);
      if (r !== undefined) {
        const given = spec.given ?? [];
        const byKey = new Map<string, Slot>();
        for (const o of this.slots.values()) byKey.set(o.key, o);
        for (let i = 0; i < r; i++) {
          const k = given[i];
          if (this.deliveredKeys.has(k) || this.doneKeys.has(k)) continue;
          const o = byKey.get(k);
          if (o && !this.blocks(o, now)) continue;
          blocked = true;
          break;
        }
      }
    }
    if (!blocked) return "go";
    return timedOut ? "forced" : "wait";
  }

  /** When should a waiting response be looked at again (its delay ends, or its hold runs out)? */
  private dueOf(s: Slot, now: number): number {
    const arrived = s.arrived ?? now;
    if (!this.spec) return Math.min(this.pendingUntil, arrived + this.holdOf());
    const d = this.delayOf(s.key);
    return arrived + d > now ? arrived + d : arrived + d + this.holdOf();
  }

  /** Release what may go, one at a time, `gapMs` apart; re-arm a wake-up for what still waits. */
  private pump(): void {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        this.pumpOnce();
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }

  private pumpOnce(): void {
    if (this.gapTimer !== null) return;
    const now = this.clock.now();
    const held = this.held();
    if (!held.length) return;
    const ready: { s: Slot; forced: boolean }[] = [];
    let due = Infinity;
    for (const s of held) {
      const v = this.verdict(s, now);
      if (v !== "wait") ready.push({ s, forced: v === "forced" });
      else due = Math.min(due, this.dueOf(s, now));
    }
    // a waiting response always has a wake-up of its own (the clock may fire a timer a little early by its measure)
    if (this.wakeTimer !== null) this.clock.clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (due < Infinity)
      this.wakeTimer = this.clock.setTimeout(() => {
        this.wakeTimer = null;
        this.pump();
      }, Math.max(1, due - now + 1));
    if (!ready.length) return;
    const spec = this.spec;
    ready.sort((a, b) => {
      if (spec?.order === "given") return (this.rank.get(a.s.key) ?? 1e9) - (this.rank.get(b.s.key) ?? 1e9) || a.s.op.id - b.s.op.id;
      if (spec?.order === "seeded") return b.s.prio - a.s.prio;
      if (spec?.order === "fifo") return a.s.op.start - b.s.op.start || a.s.op.id - b.s.op.id;
      return (a.s.arrived ?? 0) - (b.s.arrived ?? 0);
    });
    const gap = this.disposed || !spec || spec.order === "natural" ? 0 : spec.gapMs ?? DEFAULT_GAP_MS;
    const wait = this.lastRelease + gap - now;
    if (gap > 0 && wait > 0) {
      this.gapTimer = this.clock.setTimeout(() => {
        this.gapTimer = null;
        this.pump();
      }, wait);
      return;
    }
    if (gap === 0) {
      for (const r of ready) if (r.s.released === undefined) this.release(r.s, r.forced);
      return;
    }
    this.release(ready[0].s, ready[0].forced);
    if (this.held().length && this.gapTimer === null)
      this.gapTimer = this.clock.setTimeout(() => {
        this.gapTimer = null;
        this.pump();
      }, gap);
  }

  private release(s: Slot, forced: boolean): void {
    if (s.released !== undefined || !s.go) return;
    const now = this.clock.now();
    s.released = now;
    s.forced = forced;
    if (forced) this.forced++;
    this.lastRelease = now;
    const go = s.go;
    const id = s.op.id;
    this.call(go, () => this.landed(id));
  }

  /** Run the runtime's delivery; an app handler that throws is rethrown on its own task, never into the scheduler. */
  private call(go: (landed: () => void) => void, landed: () => void): void {
    try {
      go(landed);
    } catch (e) {
      this.clock.setTimeout(() => {
        throw e;
      }, 0);
    }
  }

  private prune(): void {
    for (const [id, s] of this.slots) {
      if (this.slots.size <= 3000) break;
      if (s.delivered !== undefined || s.done) this.slots.delete(id);
    }
  }
}

// Flow expectations (docs/runtime/EXPECTATIONS.md): for every (route, user action) the runtime learns which
// requests the action starts and how soon, which request follows which, what each response's handler writes, where
// the page navigates, and how long the whole flow takes to settle. A step that usually happens (seen in at least
// `minShare` of `minSupport` or more observations spread over `minSessions` or more sessions) and this time did not
// is reported to the developer as an `expectation` report: a click that started no request within its learned
// deadline, a follow-up request that never came, a response whose handler wrote nothing, a navigation that did not
// happen. Reporting only: nothing here is read by the model (no fact, no trigger, no situation text) and nothing
// acts, in any mode. Deterministic: every time and timer comes from the injected clock. Bounded: flows per route
// and in total (least-used dropped), 16 child signatures per flow, 32-sample delay windows, 8 branches per step, 64
// open instances, one timer per open instance. Persisted without page text: the action label is kept only as a hash.
//
// False-positive controls (EXPECTATIONS.md §3) are learned, never hardcoded patterns: a step is expected only on the
// branch of the handler it was learned on (the same set of fields written), a repeat of an action within a page load
// only when repeats did the step before, a request's absence or a response's missing write only when the request
// changes data (a GET may have been answered by an app cache, or its unchanged answer left unwritten), a missing
// follow-up only when one of the pair changes data.

import type { OpRec } from "../trace/ops.js";
import type { Expectation, LearnedFlow, UserAction } from "../types.js";
import { defaultRedact, fnv1a, normalizePath, plural } from "../util.js";

export interface FlowConfig {
  /** Observations of a flow (or completions of a request) before anything is expected of it. */
  minSupport: number;
  /** Share of observations in which a step occurred for it to be expected. */
  minShare: number;
  /** Distinct sessions a flow was observed in before anything is expected of it. */
  minSessions: number;
}

export const DEFAULT_MIN_SUPPORT = 8;
export const DEFAULT_MIN_SHARE = 0.95;
export const DEFAULT_MIN_SESSIONS = 2;

/** What the flow learner needs from the runtime (all through the injected clock). */
export interface FlowEnv {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  hidden(): boolean;
  online(): boolean | undefined;
  /** Reports are off for now (paused); learning goes on. */
  quiet(): boolean;
  /** A request with this signature is in flight or started at or after `t`, whatever caused it. */
  startedSince(sig: string, t: number): boolean;
  report(e: Expectation): void;
  /** Learned state changed (persist soon). */
  changed(): void;
}

const MAX_FLOWS = 500;
const MAX_PER_ROUTE = 64;
const MAX_OPEN = 64;
const MAX_CHILDREN = 16;
const MAX_FOLLOWS = 16;
const MAX_NAV = 8;
const MAX_FIELDS = 16;
const MAX_BRANCHES = 8;
const MAX_SEEN = 2000;
const WINDOW = 32;
const MIN_DEADLINE_MS = 1000;
const MAX_DEADLINE_MS = 10_000;
const MIN_CLOSE_MS = 1500;
const MAX_CLOSE_MS = 15_000;
const BUSY_RETRY_MS = 500;
const DEVIATIONS_KEPT = 50;
const PAIR = "\t";
/** Methods whose request an app cache may answer without sending it: never expected to start on their own. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A request signature the action starts. */
interface Step {
  /** Observations in which it started, of them repeats of the action within a page load, and those it completed in. */
  n: number;
  r: number;
  done: number;
  /** Delay from the action to its first start. */
  delay: number[];
  /** Branches it started in: hash of the fields the action's handler itself wrote -> count. */
  own: Record<string, number>;
  /** Seen under `requests.protect`: never expected. */
  protected?: boolean;
}
interface Follow {
  n: number;
  delay: number[];
  /** Branches it followed in: hash of the fields the predecessor's response handler wrote -> count. */
  when: Record<string, number>;
}
interface Writes {
  n: number;
  fields: Record<string, number>;
}

/** One learned flow. Everything but `label` is persisted. */
export interface FlowRecord {
  /** fnv1a of `${route}|${kind} ${target with digits normalised}`: the only form the label takes in storage. */
  h: string;
  route: string;
  kind: string;
  role: string;
  /** The element description as last seen this session (never persisted). */
  label?: string;
  /** Observations (closed instances), of them repeats within a page load, distinct sessions, the last session. */
  n: number;
  rep: number;
  sessions: number;
  last: number;
  settle: number[];
  navDelay: number[];
  children: Record<string, Step>;
  follows: Record<string, Follow>;
  writes: Record<string, Writes>;
  nav: Record<string, number>;
  /** Branches the flow navigated in: hash of every field the flow wrote -> count. */
  navKeys: Record<string, number>;
  /** Least-recently-used ordinal (eviction and the storage size cap). */
  used: number;
}

interface Check {
  kind: "request" | "follow-up";
  sig: string;
  at: number;
  after?: string;
  /** follow-up: the predecessor's op. */
  afterOp?: number;
}

interface Inst {
  user: OpRec;
  rec: FlowRecord;
  opened: number;
  /** The same flow was already seen in this page load. */
  repeat: boolean;
  children: OpRec[];
  started: Set<string>;
  /** Normalised fields written by each request's response handler (request op id -> fields; present = it wrote). */
  wrote: Map<number, Set<string>>;
  /** Normalised fields the action's own handler wrote. */
  own: Set<string>;
  checks: Check[];
  nav: string | null;
  navAt: number;
  closeAt: number;
  timer: unknown;
  /** The page was hidden while this instance was open: neither learned from nor reported. */
  hidden: boolean;
  /** The page navigated for another action while this one was open: neither learned from nor reported. */
  left: boolean;
  /**
   * The same action happened again while this instance was open (a stepper clicked three times, a second submit):
   * a later answer may supersede this one's, so its responses' writes are neither checked nor learned.
   */
  repeated: boolean;
  /** One report per instance. */
  reported: boolean;
}

function push(w: number[], v: number): void {
  w.push(v);
  if (w.length > WINDOW) w.shift();
}

function bump(m: Record<string, number>, k: string): void {
  if (k in m || Object.keys(m).length < MAX_BRANCHES) m[k] = (m[k] ?? 0) + 1;
}

/** A set of written fields as a branch key ("" for none). */
function branch(fields: Iterable<string>): string {
  const a = [...new Set(fields)].sort();
  return a.length ? fnv1a(a.join(",")) : "";
}

/** The request changes data (its absence cannot be an app cache answering it). */
function mutating(sig: string): boolean {
  const m = sig.slice(0, sig.indexOf(" ")).toUpperCase();
  return m !== "" && !SAFE_METHODS.has(m);
}

/** Quantile of a sample window (the baselines' convention). */
export function quantile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
}

/** "0.05 s", "0.8 s", "12.3 s" (console reports to developers; not model-visible). */
export function fmtSec(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${s < 1 ? s.toFixed(2) : s.toFixed(1)} s`;
}

/** Completed with a 1xx-3xx answer (a 4xx is the server declining: its handler writing nothing is no gap). */
function okEnd(o: OpRec): boolean {
  return o.end !== undefined && o.status === "ok" && !(typeof o.code === "number" && o.code >= 400);
}

/** Route key: the path without query or hash, ids normalised. */
export function flowRoute(route: string | undefined): string {
  const r = (route ?? "/").split("?")[0].split("#")[0] || "/";
  return normalizePath(r);
}

/** 'click button "Add 3 items"' -> role "button", learning label with digits normalised. */
function labelKey(target: string): { role: string; norm: string } {
  const role = target.split(/[\s"]/)[0] || "page";
  return { role, norm: target.replace(/\d+(\.\d+)?/g, "n") };
}

const VERB: Record<string, string> = { click: "clicking", submit: "submitting", change: "changing", key: "pressing Enter in" };

/** "clicking button "Add to cart"" (a label seen this session), else "clicking a button". */
export function actionPhrase(rec: FlowRecord): string {
  const verb = VERB[rec.kind] ?? rec.kind;
  if (rec.label) return `${verb} ${rec.label}`;
  return `${verb} ${/^[aeiou]/i.test(rec.role) ? "an" : "a"} ${rec.role}`;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const num = (x: unknown): number => (isNum(x) ? x : 0);
const nums = (x: unknown): number[] => (Array.isArray(x) ? x.filter(isNum).slice(-WINDOW) : []);
function counts(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (x && typeof x === "object") for (const [k, v] of Object.entries(x as Record<string, unknown>)) if (isNum(v)) out[k] = v;
  return out;
}
function entries<T>(x: unknown, fix: (v: Record<string, unknown>) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  if (!x || typeof x !== "object") return out;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const f = fix(v as Record<string, unknown>);
    if (f) out[k] = f;
  }
  return out;
}

export class FlowProfiles {
  readonly byKey = new Map<string, FlowRecord>();
  private open = new Map<number, Inst>();
  /** Flow keys seen in this page load (a later instance is a repeat). */
  private seen = new Set<string>();
  private tick = 0;
  /** This session's ordinal on this origin (1 + the sessions that persisted before it). */
  session = 1;
  readonly deviations: Expectation[] = [];
  /** Off: nothing is learned or reported (learn.expectations: false). */
  enabled = true;

  constructor(
    private readonly env: FlowEnv,
    public cfg: FlowConfig,
  ) {}

  // ------------------------------------------------------------------------------------------ records

  private record(route: string, kind: string, target: string): FlowRecord {
    const { role, norm } = labelKey(target);
    const h = fnv1a(`${route}|${kind} ${norm}`);
    let rec = this.byKey.get(h);
    if (!rec) {
      this.evict(route);
      rec = { h, route, kind, role, n: 0, rep: 0, sessions: 0, last: 0, settle: [], navDelay: [], children: {}, follows: {}, writes: {}, nav: {}, navKeys: {}, used: 0 };
      this.byKey.set(h, rec);
    }
    rec.label = target;
    rec.used = ++this.tick;
    return rec;
  }

  /** Room for one more record: drop the least-used of the route at MAX_PER_ROUTE, of all at MAX_FLOWS. */
  private evict(route: string): void {
    let onRoute = 0;
    for (const r of this.byKey.values()) if (r.route === route) onRoute++;
    if (onRoute >= MAX_PER_ROUTE) this.dropLeastUsed(1, route);
    if (this.byKey.size >= MAX_FLOWS) this.dropLeastUsed(1);
  }

  /** Drop the `k` least-used records (of one route when given). Returns how many were dropped. */
  dropLeastUsed(k: number, route?: string): number {
    const list = [...this.byKey.values()].filter((r) => route === undefined || r.route === route).sort((a, b) => a.used - b.used);
    let n = 0;
    for (const r of list.slice(0, k)) {
      this.byKey.delete(r.h);
      n++;
    }
    return n;
  }

  private qualifies(rec: FlowRecord): boolean {
    return rec.n >= this.cfg.minSupport && rec.sessions >= this.cfg.minSessions;
  }

  /**
   * The request is expected to start: it changes data, is not protected, started in `minShare` of the flow's
   * observations, and, for a repeat of the action within a page load, also in `minShare` of the repeats seen before.
   */
  private expectedStep(rec: FlowRecord, sig: string, repeat: boolean): Step | null {
    const st = rec.children[sig];
    if (!st || st.protected || !mutating(sig) || !this.qualifies(rec) || st.n / rec.n < this.cfg.minShare) return null;
    if (repeat && (rec.rep < this.cfg.minSupport || st.r / rec.rep < this.cfg.minShare)) return null;
    return st;
  }

  /** B usually starts after A of this flow completes (any methods): B is then checked only as A's follow-up. */
  private followLearned(rec: FlowRecord, a: string, b: string): Follow | null {
    const f = rec.follows[`${a}${PAIR}${b}`];
    const stA = rec.children[a];
    if (!f || !stA || stA.done < this.cfg.minSupport || f.n / stA.done < this.cfg.minShare) return null;
    return f;
  }

  /** ...and its absence is reportable: the flow qualifies, B is not protected, and A or B changes data. */
  private expectedFollow(rec: FlowRecord, a: string, b: string): Follow | null {
    if (!this.qualifies(rec) || rec.children[b]?.protected || (!mutating(a) && !mutating(b))) return null;
    return this.followLearned(rec, a, b);
  }

  /** The signature usually follows another request of the flow: only the follow-up check may report it missing. */
  private isFollowUp(rec: FlowRecord, sig: string): boolean {
    for (const pair of Object.keys(rec.follows)) {
      const i = pair.indexOf(PAIR);
      if (pair.slice(i + 1) === sig && this.followLearned(rec, pair.slice(0, i), sig)) return true;
    }
    return false;
  }

  private deadline(delay: number[]): number {
    return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, 2 * quantile(delay, 0.95)));
  }

  private closeAfter(rec: FlowRecord): number {
    const want = Math.max(MIN_CLOSE_MS, 2 * quantile(rec.settle, 0.95), 2 * quantile(rec.navDelay, 0.95));
    return Math.min(MAX_CLOSE_MS, want);
  }

  // ----------------------------------------------------------------------------------------- instances

  /** A user op was recorded (clicks, submits, Enter, changes; typing is never a flow). */
  onUser(op: OpRec): void {
    if (!this.enabled || op.scope?.mode === "off") return;
    const a = op.meta?.action as UserAction | undefined;
    if (!a) return;
    const kind = a.kind;
    if (kind === "key" ? a.key !== "Enter" : kind !== "click" && kind !== "submit" && kind !== "change") return;
    // the second click of a double click and a click on a disabled control do nothing by design
    if ((a.clicks ?? 1) > 1 || (a.data as { disabled?: unknown } | undefined)?.disabled) return;
    const now = this.env.now();
    const rec = this.record(flowRoute(op.scope?.route), kind, a.target ?? "");
    // the same action again while its previous instance is open (a second submit while the first is in flight, which
    // an app's own in-flight guard ignores by design): neither checked nor learned
    for (const o of this.open.values())
      if (o.rec === rec) {
        o.repeated = true;
        return;
      }
    const repeat = this.seen.has(rec.h);
    if (!repeat) {
      this.seen.add(rec.h);
      if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value as string);
    }
    const inst: Inst = { user: op, rec, opened: now, repeat, children: [], started: new Set(), wrote: new Map(), own: new Set(), checks: [], nav: null, navAt: 0, closeAt: now + this.closeAfter(rec), timer: null, hidden: this.env.hidden(), left: false, repeated: false, reported: false };
    for (const [sig, st] of Object.entries(rec.children)) {
      if (!this.expectedStep(rec, sig, repeat)) continue;
      inst.checks.push({ kind: "request", sig, at: now + this.deadline(st.delay) });
    }
    this.open.set(op.id, inst);
    if (this.open.size > MAX_OPEN) {
      // the oldest open instance is dropped unchecked and unlearned (closing it early could report a step it was
      // still going to take)
      const first = this.open.values().next().value;
      if (first) this.drop(first);
    }
    this.arm(inst);
  }

  /** A flow is open with this root op (a write under it is worth attributing). */
  isOpen(root: number | undefined): boolean {
    return root !== undefined && this.open.has(root);
  }

  /** A request started inside a flow (its root is the user op). */
  onChild(op: OpRec): void {
    const inst = this.open.get(op.root ?? -1);
    if (!inst) return;
    if (inst.children.length < 64) inst.children.push(op);
    inst.started.add(op.name);
  }

  /**
   * A state write by `writer` (`chain` = writer and its ancestors, nearest first) inside a flow: the fields it
   * changed (none for a write that left the value as it was, which still means the response was handled). A write
   * by the action itself is the handler's branch; otherwise it belongs to the nearest request of its chain (a
   * refetch's writes are the refetch's, not those of the request whose handler started it).
   */
  onWrite(writer: OpRec, chain: OpRec[], fields: string[]): void {
    const inst = this.open.get(writer.root ?? -1);
    if (!inst) return;
    if (writer.id === inst.user.id) {
      for (const f of fields) inst.own.add(f);
      return;
    }
    const req = chain.find((o) => (o.kind === "fetch" || o.kind === "xhr") && o.root === inst.user.id);
    if (!req) return;
    let s = inst.wrote.get(req.id);
    if (!s) inst.wrote.set(req.id, (s = new Set()));
    for (const f of fields) s.add(f);
  }

  /** A request of a flow ended: the flow stays open for its usual tail; follow-ups of an ok answer are expected. */
  onChildEnd(op: OpRec): void {
    const inst = this.open.get(op.root ?? -1);
    if (!inst || op.end === undefined) return;
    const rec = inst.rec;
    // what a slow response's handler does (writes, a navigation) is still seen: as long after the last answer as
    // the flow usually stays open after its answers
    const tail = Math.max(BUSY_RETRY_MS, this.closeAfter(rec) - quantile(rec.settle, 0.95));
    inst.closeAt = Math.max(inst.closeAt, Math.min(inst.opened + MAX_CLOSE_MS, op.end + tail));
    if (okEnd(op)) {
      const now = this.env.now();
      for (const pair of Object.keys(rec.follows)) {
        const i = pair.indexOf(PAIR);
        const a = pair.slice(0, i);
        const b = pair.slice(i + 1);
        if (a !== op.name || inst.started.has(b)) continue;
        const f = this.expectedFollow(rec, a, b);
        if (!f || inst.checks.some((c) => c.kind === "follow-up" && c.sig === b)) continue;
        inst.checks.push({ kind: "follow-up", sig: b, after: a, afterOp: op.id, at: now + this.deadline(f.delay) });
      }
    }
    this.arm(inst);
  }

  /**
   * The page navigated: the flow whose causal chain did it (`root`), else the most recently opened one. Every
   * other open flow whose route the page left is incomplete. A history change that stays on the route (a query
   * string, a router's replaceState) is not a navigation.
   */
  onNav(route: string, root?: number): void {
    const to = flowRoute(route);
    let inst = root !== undefined ? this.open.get(root) : undefined;
    if (!inst) for (const o of this.open.values()) if (!inst || o.opened >= inst.opened) inst = o;
    for (const o of this.open.values()) if (o !== inst && o.rec.route !== to) o.left = true;
    if (!inst || inst.nav !== null || inst.rec.route === to) return;
    inst.nav = to;
    inst.navAt = this.env.now();
  }

  /** The page was hidden: the open flows are neither learned nor reported (timers are throttled there). */
  onHidden(): void {
    for (const o of this.open.values()) o.hidden = true;
  }

  private arm(inst: Inst): void {
    let next = inst.closeAt;
    for (const c of inst.checks) if (c.at < next) next = c.at;
    if (inst.timer !== null) this.env.clearTimeout(inst.timer);
    inst.timer = this.env.setTimeout(() => {
      try {
        this.fire(inst);
      } catch {
        // reporting only: a failure here never surfaces in the page (as an uncaught error from a runtime timer)
        this.drop(inst);
      }
    }, Math.max(0, next - this.env.now()));
  }

  private fire(inst: Inst): void {
    inst.timer = null;
    if (this.open.get(inst.user.id) !== inst) return;
    const now = this.env.now();
    if (this.env.hidden()) inst.hidden = true;
    const due = inst.checks.filter((c) => c.at <= now);
    inst.checks = inst.checks.filter((c) => c.at > now);
    for (const c of due) this.evaluate(inst, c, now);
    if (now >= inst.closeAt) {
      if (inst.children.some((c) => c.end === undefined) && now < inst.opened + MAX_CLOSE_MS) inst.closeAt = now + BUSY_RETRY_MS;
      else return this.close(inst, now);
    }
    this.arm(inst);
  }

  private suppressed(inst: Inst): boolean {
    return inst.reported || inst.hidden || inst.left || this.env.hidden() || this.env.online() === false || this.env.quiet();
  }

  private evaluate(inst: Inst, c: Check, now: number): void {
    if (inst.started.has(c.sig) || this.suppressed(inst)) return;
    const rec = inst.rec;
    const who = actionPhrase(rec);
    if (c.kind === "request") {
      // a request that usually follows another one is missing only once that one completed (the follow-up check)
      if (this.isFollowUp(rec, c.sig)) return;
      const st = rec.children[c.sig];
      // the same branch of the handler (it wrote what it wrote when it sent the request), and no request of that
      // signature from anywhere since the action (one whose cause was not traced back to it)
      if (!st || !st.own[branch(inst.own)] || this.env.startedSince(c.sig, inst.user.start)) return;
      const usual = quantile(st.delay, 0.95);
      const waited = now - inst.user.start;
      this.report(inst, {
        kind: "request",
        route: rec.route,
        action: who,
        op: inst.user.id,
        signature: c.sig,
        seen: st.n,
        of: rec.n,
        sessions: rec.sessions,
        waitedMs: waited,
        usualMs: usual,
        at: now,
        message: `[GenClass] Expected a request on ${rec.route}: ${who} usually sends ${c.sig} (${st.n} of ${plural(rec.n, "time")} across ${plural(rec.sessions, "session")}, within ${fmtSec(usual)}); this time nothing was sent in ${fmtSec(waited)}.`,
      });
      return;
    }
    const a = c.after ?? "";
    const f = rec.follows[`${a}${PAIR}${c.sig}`];
    const stA = rec.children[a];
    // the same branch of the predecessor's handler, and no request of that signature from anywhere since the action
    if (!f || !stA || !f.when[branch(inst.wrote.get(c.afterOp ?? -1) ?? [])] || this.env.startedSince(c.sig, inst.opened)) return;
    let endA = inst.user.start;
    for (const o of inst.children) if (o.id === c.afterOp && o.end !== undefined) endA = o.end;
    const usual = quantile(f.delay, 0.95);
    const waited = now - endA;
    this.report(inst, {
      kind: "follow-up",
      route: rec.route,
      action: who,
      op: inst.user.id,
      signature: c.sig,
      after: a,
      seen: f.n,
      of: stA.done,
      sessions: rec.sessions,
      waitedMs: waited,
      usualMs: usual,
      at: now,
      message: `[GenClass] Expected a follow-up on ${rec.route}: after ${a} completes, ${who} usually sends ${c.sig} (${f.n} of ${plural(stA.done, "time")}, within ${fmtSec(usual)}); this time nothing followed in ${fmtSec(waited)}.`,
    });
  }

  private report(inst: Inst, e: Expectation): void {
    inst.reported = true;
    this.note(e);
  }

  /** Record a deviation (kept for rt.learned()) and report it. The runtime adds its own `response` kind here. */
  note(e: Expectation): void {
    this.deviations.push(e);
    if (this.deviations.length > DEVIATIONS_KEPT) this.deviations.shift();
    this.env.report(e);
  }

  private drop(inst: Inst): void {
    this.open.delete(inst.user.id);
    if (inst.timer !== null) this.env.clearTimeout(inst.timer);
    inst.timer = null;
  }

  private close(inst: Inst, now: number): void {
    this.drop(inst);
    if (inst.hidden || inst.left || this.env.hidden()) return;
    this.checkAtClose(inst, now);
    this.learn(inst);
  }

  /** Every field the flow wrote (the handler's own and its responses'). */
  private allWrites(inst: Inst): string[] {
    const out = [...inst.own];
    for (const s of inst.wrote.values()) out.push(...s);
    return out;
  }

  /** Writes and navigation are checked once the flow is over (responses write in their callbacks). */
  private checkAtClose(inst: Inst, now: number): void {
    const rec = inst.rec;
    if (this.suppressed(inst) || !this.qualifies(rec)) return;
    const who = actionPhrase(rec);
    const seenSig = new Set<string>();
    // a response's missing write: only for a request that changes data (an unchanged GET answer is often left
    // unwritten by design: structural sharing, a stale answer dropped), and not when a repeat may have superseded it
    for (const o of inst.repeated ? [] : inst.children) {
      if (!okEnd(o) || o.genclass || o.scope?.protected || !mutating(o.name) || seenSig.has(o.name)) continue;
      seenSig.add(o.name);
      const W = rec.writes[o.name];
      if (!W || W.n < this.cfg.minSupport || inst.wrote.has(o.id)) continue;
      const fields = Object.keys(W.fields)
        .filter((f) => W.fields[f] / W.n >= this.cfg.minShare)
        .sort();
      if (!fields.length) continue;
      const seen = Math.min(...fields.map((f) => W.fields[f]));
      return this.report(inst, {
        kind: "write",
        route: rec.route,
        action: who,
        op: inst.user.id,
        signature: o.name,
        field: fields.join(", "),
        seen,
        of: W.n,
        sessions: rec.sessions,
        waitedMs: now - inst.user.start,
        at: now,
        message: `[GenClass] Expected a state change on ${rec.route}: the response to ${o.name} after ${who} usually writes ${fields.join(", ")} (${seen} of ${plural(W.n, "time")}); this time it wrote nothing.`,
      });
    }
    // a navigation: not while a request of the flow is still in flight (a slow answer, not a missing step), and only
    // on the branch the flow navigated in before (the same set of fields written)
    if (inst.nav !== null || inst.children.some((c) => c.end === undefined) || !rec.navKeys[branch(this.allWrites(inst))]) return;
    for (const [to, c] of Object.entries(rec.nav)) {
      if (c / rec.n < this.cfg.minShare) continue;
      const usual = quantile(rec.navDelay, 0.95);
      const waited = now - inst.user.start;
      return this.report(inst, {
        kind: "navigation",
        route: rec.route,
        action: who,
        op: inst.user.id,
        to,
        seen: c,
        of: rec.n,
        sessions: rec.sessions,
        waitedMs: waited,
        usualMs: usual,
        at: now,
        message: `[GenClass] Expected a navigation on ${rec.route}: ${who} usually leads to ${to} (${c} of ${plural(rec.n, "time")}, within ${fmtSec(usual)}); this time the page stayed on ${rec.route} for ${fmtSec(waited)}.`,
      });
    }
  }

  private learn(inst: Inst): void {
    const rec = inst.rec;
    rec.n++;
    if (inst.repeat) rec.rep++;
    if (rec.last !== this.session) {
      rec.last = this.session;
      rec.sessions++;
    }
    rec.used = ++this.tick;
    const u = inst.user.start;
    const ownKey = branch(inst.own);
    let lastEnd = u;
    const bySig = new Map<string, OpRec[]>();
    for (const c of inst.children) {
      if (c.genclass) continue;
      const list = bySig.get(c.name) ?? [];
      list.push(c);
      bySig.set(c.name, list);
      if (c.end !== undefined && c.end > lastEnd) lastEnd = c.end;
    }
    push(rec.settle, lastEnd - u);
    for (const [sig, ops] of bySig) {
      let st = rec.children[sig];
      if (!st) {
        if (Object.keys(rec.children).length >= MAX_CHILDREN) continue;
        st = rec.children[sig] = { n: 0, r: 0, done: 0, delay: [], own: {} };
      }
      st.n++;
      if (inst.repeat) st.r++;
      bump(st.own, ownKey);
      push(st.delay, Math.min(...ops.map((o) => o.start)) - u);
      if (ops.some(okEnd)) st.done++;
      if (ops.some((o) => o.scope?.protected)) st.protected = true;
      if (st.protected || inst.repeated) continue;
      for (const o of ops) {
        if (!okEnd(o)) continue;
        let W = rec.writes[sig];
        if (!W) {
          if (Object.keys(rec.writes).length >= MAX_CHILDREN) break;
          W = rec.writes[sig] = { n: 0, fields: {} };
        }
        W.n++;
        for (const f of inst.wrote.get(o.id) ?? []) {
          // fields whose names mean a secret are never learned (nor stored)
          if (defaultRedact(f, "x") !== "x") continue;
          if (!(f in W.fields) && Object.keys(W.fields).length >= MAX_FIELDS) continue;
          W.fields[f] = (W.fields[f] ?? 0) + 1;
        }
      }
    }
    // follow-ups: B started after some A of this flow completed (the nearest such A is the predecessor)
    for (const [a, opsA] of bySig) {
      const doneA = opsA.filter(okEnd);
      if (!doneA.length) continue;
      for (const [b, opsB] of bySig) {
        if (a === b) continue;
        let best = Infinity;
        let by: OpRec | null = null;
        for (const oa of doneA)
          for (const o of opsB) {
            const d = o.start - (oa.end as number);
            if (d >= 0 && d < best) {
              best = d;
              by = oa;
            }
          }
        if (!by) continue;
        const k = `${a}${PAIR}${b}`;
        let f = rec.follows[k];
        if (!f) {
          if (Object.keys(rec.follows).length >= MAX_FOLLOWS) continue;
          f = rec.follows[k] = { n: 0, delay: [], when: {} };
        }
        f.n++;
        push(f.delay, best);
        bump(f.when, branch(inst.wrote.get(by.id) ?? []));
      }
    }
    if (inst.nav !== null && (inst.nav in rec.nav || Object.keys(rec.nav).length < MAX_NAV)) {
      rec.nav[inst.nav] = (rec.nav[inst.nav] ?? 0) + 1;
      push(rec.navDelay, inst.navAt - u);
      bump(rec.navKeys, branch(this.allWrites(inst)));
    }
    this.env.changed();
  }

  // --------------------------------------------------------------------------------------- introspection

  /** The learned flows (the current route's first, then by observations), with what is expected of each. */
  learned(route: string): LearnedFlow[] {
    const cur = flowRoute(route);
    const out: LearnedFlow[] = [];
    const stat = (w: number[]) => ({ p50: quantile(w, 0.5), p95: quantile(w, 0.95) });
    for (const rec of this.byKey.values()) {
      const q = this.qualifies(rec);
      const flow: LearnedFlow = {
        route: rec.route,
        action: `${rec.kind} ${rec.label ?? `${rec.role} #${rec.h}`}`,
        n: rec.n,
        repeats: rec.rep,
        sessions: rec.sessions,
        children: Object.entries(rec.children).map(([signature, st]) => {
          const c: LearnedFlow["children"][number] = { signature, n: st.n, share: rec.n ? st.n / rec.n : 0, onRepeat: st.r, expected: !!this.expectedStep(rec, signature, false), expectedOnRepeat: !!this.expectedStep(rec, signature, true) };
          if (st.protected) c.protected = true;
          if (st.delay.length) c.delayMs = stat(st.delay);
          return c;
        }),
        writes: Object.entries(rec.writes).flatMap(([signature, W]) => Object.entries(W.fields).map(([field, n]) => ({ signature, field, n, of: W.n, share: W.n ? n / W.n : 0, expected: q && mutating(signature) && W.n >= this.cfg.minSupport && n / W.n >= this.cfg.minShare }))),
        followUps: Object.entries(rec.follows).map(([pair, f]) => {
          const i = pair.indexOf(PAIR);
          const after = pair.slice(0, i);
          const then = pair.slice(i + 1);
          const of = rec.children[after]?.done ?? 0;
          const u: LearnedFlow["followUps"][number] = { after, then, n: f.n, of, share: of ? f.n / of : 0, expected: !!this.expectedFollow(rec, after, then) };
          if (f.delay.length) u.delayMs = stat(f.delay);
          return u;
        }),
        nav: Object.entries(rec.nav).map(([to, n]) => ({ to, n, share: rec.n ? n / rec.n : 0, expected: q && n / rec.n >= this.cfg.minShare })),
      };
      if (rec.settle.length) flow.settleMs = stat(rec.settle);
      out.push(flow);
    }
    out.sort((a, b) => Number(b.route === cur) - Number(a.route === cur) || b.n - a.n || a.action.localeCompare(b.action));
    return out;
  }

  // ----------------------------------------------------------------------------------------- persistence

  /** Records without their labels (hashes, signatures, field names and counts only). */
  toJSON(): Omit<FlowRecord, "label">[] {
    return [...this.byKey.values()].map(({ label: _l, ...rest }) => rest);
  }

  /** Records from storage; anything malformed is dropped or zeroed (stored state is never trusted). */
  load(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (const r of list as Record<string, unknown>[]) {
      if (!r || typeof r !== "object") continue;
      const h = r.h;
      const n = r.n;
      const route = r.route;
      if (typeof h !== "string" || !isNum(n) || typeof route !== "string") continue;
      const sessions = r.sessions;
      const rec: FlowRecord = {
        h,
        route,
        kind: typeof r.kind === "string" ? r.kind : "click",
        role: typeof r.role === "string" ? r.role : "page",
        n,
        rep: num(r.rep),
        sessions: isNum(sessions) ? sessions : 1,
        last: num(r.last),
        settle: nums(r.settle),
        navDelay: nums(r.navDelay),
        children: entries<Step>(r.children, (v) => (isNum(v.n) ? { n: num(v.n), r: num(v.r), done: num(v.done), delay: nums(v.delay), own: counts(v.own), ...(v.protected === true ? { protected: true } : {}) } : null)),
        follows: entries<Follow>(r.follows, (v) => (isNum(v.n) ? { n: num(v.n), delay: nums(v.delay), when: counts(v.when) } : null)),
        writes: entries<Writes>(r.writes, (v) => (isNum(v.n) ? { n: num(v.n), fields: counts(v.fields) } : null)),
        nav: counts(r.nav),
        navKeys: counts(r.navKeys),
        used: num(r.used),
      };
      this.byKey.set(rec.h, rec);
      if (rec.used > this.tick) this.tick = rec.used;
      if (this.byKey.size > MAX_FLOWS) this.dropLeastUsed(this.byKey.size - MAX_FLOWS);
    }
  }

  clear(): void {
    this.byKey.clear();
    this.seen.clear();
    this.deviations.length = 0;
  }

  /** Cancel every open instance's timer (destroy). */
  dispose(): void {
    for (const inst of this.open.values()) if (inst.timer !== null) this.env.clearTimeout(inst.timer);
    this.open.clear();
  }
}

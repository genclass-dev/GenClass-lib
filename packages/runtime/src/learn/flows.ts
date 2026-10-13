// Flow expectations (docs/runtime/EXPECTATIONS.md): for every (route, user action) the runtime learns which
// requests the action starts and how soon, which request follows which, what each response's chain writes, where
// the page navigates, and how long the whole flow takes to settle. A step that usually happens (seen in at least
// `minShare` of `minSupport` or more observations spread over `minSessions` or more sessions) and this time did not
// is reported to the developer as an `expectation` report: a click that started no request within its learned
// deadline, a follow-up request that never came, a response whose chain wrote nothing, a navigation that did not
// happen. Reporting only: nothing here is read by the model (no fact, no trigger, no situation text) and nothing
// acts, in any mode. Deterministic: every time and timer comes from the injected clock. Bounded: flows per route
// and in total (least-used dropped), 16 child signatures per flow, 32-sample delay windows, 64 open instances, one
// timer per open instance. Persisted without page text: the action label is kept only as a hash in storage.

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
const WINDOW = 32;
const MIN_DEADLINE_MS = 500;
const MAX_DEADLINE_MS = 10_000;
const MIN_CLOSE_MS = 1500;
const MAX_CLOSE_MS = 15_000;
const BUSY_RETRY_MS = 500;
const DEVIATIONS_KEPT = 50;
const PAIR = "\t";

/** A request signature the action starts: observations in which it started / completed, delay from the action. */
interface Step {
  n: number;
  done: number;
  delay: number[];
  /** Seen under `requests.protect`: never expected. */
  protected?: boolean;
}
interface Follow {
  n: number;
  delay: number[];
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
  /** Observations (closed instances), distinct sessions, the session ordinal of the last observation. */
  n: number;
  sessions: number;
  last: number;
  settle: number[];
  navDelay: number[];
  children: Record<string, Step>;
  follows: Record<string, Follow>;
  writes: Record<string, Writes>;
  nav: Record<string, number>;
  /** Least-recently-used ordinal (eviction and the storage size cap). */
  used: number;
}

interface Check {
  kind: "request" | "follow-up";
  sig: string;
  at: number;
  after?: string;
}

interface Inst {
  user: OpRec;
  rec: FlowRecord;
  opened: number;
  children: OpRec[];
  started: Set<string>;
  reported: Set<string>;
  /** Normalised fields written by each request's response chain (request op id -> fields). */
  wrote: Map<number, Set<string>>;
  checks: Check[];
  nav: string | null;
  navAt: number;
  closeAt: number;
  timer: unknown;
  /** The page was hidden while this instance was open: neither learned from nor reported. */
  hidden: boolean;
}

function push(w: number[], v: number): void {
  w.push(v);
  if (w.length > WINDOW) w.shift();
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

function okEnd(o: OpRec): boolean {
  return o.end !== undefined && o.status === "ok";
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

export class FlowProfiles {
  readonly byKey = new Map<string, FlowRecord>();
  private open = new Map<number, Inst>();
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

  private key(route: string, kind: string, norm: string): string {
    return fnv1a(`${route}|${kind} ${norm}`);
  }

  private record(route: string, kind: string, target: string): FlowRecord {
    const { role, norm } = labelKey(target);
    const h = this.key(route, kind, norm);
    let rec = this.byKey.get(h);
    if (!rec) {
      this.evict(route);
      rec = { h, route, kind, role, n: 0, sessions: 0, last: 0, settle: [], navDelay: [], children: {}, follows: {}, writes: {}, nav: {}, used: 0 };
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

  private expectedStep(rec: FlowRecord, sig: string): Step | null {
    const st = rec.children[sig];
    if (!st || st.protected || !this.qualifies(rec) || st.n / rec.n < this.cfg.minShare) return null;
    return st;
  }

  /** The follow-up pair A -> B when B usually follows A's completion in this flow. */
  private expectedFollow(rec: FlowRecord, a: string, b: string): Follow | null {
    const f = rec.follows[`${a}${PAIR}${b}`];
    const stA = rec.children[a];
    if (!f || !stA || stA.done < this.cfg.minSupport || f.n / stA.done < this.cfg.minShare || rec.children[b]?.protected) return null;
    return f;
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
    const inst: Inst = { user: op, rec, opened: now, children: [], started: new Set(), reported: new Set(), wrote: new Map(), checks: [], nav: null, navAt: 0, closeAt: now + this.closeAfter(rec), timer: null, hidden: this.env.hidden() };
    for (const [sig, st] of Object.entries(rec.children)) {
      if (!this.expectedStep(rec, sig)) continue;
      inst.checks.push({ kind: "request", sig, at: now + this.deadline(st.delay) });
    }
    this.open.set(op.id, inst);
    if (this.open.size > MAX_OPEN) {
      const first = this.open.values().next().value;
      if (first) this.close(first, now);
    }
    this.arm(inst);
  }

  /** A request started inside a flow (its root is the user op). */
  onChild(op: OpRec): void {
    const inst = this.open.get(op.root ?? -1);
    if (!inst) return;
    if (inst.children.length < 64) inst.children.push(op);
    inst.started.add(op.name);
  }

  /**
   * A state write applied with `writer` as its direct cause: the requests of its causal chain (inside the flow of
   * its root user op) wrote these fields. Recorded here rather than read from the op's transition accumulator, which
   * closes at the next settled point and can miss a write made after a slow body read.
   */
  onWrite(writer: OpRec, chain: OpRec[], fields: string[]): void {
    const inst = this.open.get(writer.root ?? -1);
    if (!inst || !fields.length) return;
    for (const op of chain) {
      if ((op.kind !== "fetch" && op.kind !== "xhr") || op.root !== inst.user.id) continue;
      let s = inst.wrote.get(op.id);
      if (!s) inst.wrote.set(op.id, (s = new Set()));
      for (const f of fields) s.add(f);
    }
  }

  /** The signature usually follows another request of the flow: only the follow-up check may report it missing. */
  private isFollowUp(rec: FlowRecord, sig: string): boolean {
    for (const pair of Object.keys(rec.follows)) {
      const i = pair.indexOf(PAIR);
      if (pair.slice(i + 1) === sig && this.expectedFollow(rec, pair.slice(0, i), sig)) return true;
    }
    return false;
  }

  /** A request of a flow ended: follow-ups that usually come after it are now expected. */
  onChildEnd(op: OpRec): void {
    const inst = this.open.get(op.root ?? -1);
    if (!inst || !okEnd(op)) return;
    const rec = inst.rec;
    if (!this.qualifies(rec)) return;
    const now = this.env.now();
    for (const pair of Object.keys(rec.follows)) {
      const i = pair.indexOf(PAIR);
      const a = pair.slice(0, i);
      const b = pair.slice(i + 1);
      if (a !== op.name || inst.started.has(b)) continue;
      const f = this.expectedFollow(rec, a, b);
      if (!f || inst.checks.some((c) => c.kind === "follow-up" && c.sig === b)) continue;
      inst.checks.push({ kind: "follow-up", sig: b, after: a, at: now + this.deadline(f.delay) });
    }
    this.arm(inst);
  }

  /** The page navigated: attributed to the most recently opened flow. */
  onNav(route: string): void {
    let last: Inst | null = null;
    for (const inst of this.open.values()) if (!last || inst.opened >= last.opened) last = inst;
    if (!last || last.nav !== null) return;
    last.nav = flowRoute(route);
    last.navAt = this.env.now();
  }

  private arm(inst: Inst): void {
    let next = inst.closeAt;
    for (const c of inst.checks) if (c.at < next) next = c.at;
    if (inst.timer !== null) this.env.clearTimeout(inst.timer);
    inst.timer = this.env.setTimeout(() => this.fire(inst), Math.max(0, next - this.env.now()));
  }

  private fire(inst: Inst): void {
    inst.timer = null;
    if (!this.open.has(inst.user.id)) return;
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
    return inst.hidden || this.env.hidden() || this.env.online() === false;
  }

  private evaluate(inst: Inst, c: Check, now: number): void {
    if (inst.started.has(c.sig) || inst.reported.has(c.sig)) return;
    const rec = inst.rec;
    // a request that usually follows another one is missing only once that one completed (the follow-up check)
    if (c.kind === "request" && this.isFollowUp(rec, c.sig)) return;
    if (this.suppressed(inst)) return;
    inst.reported.add(c.sig);
    const who = actionPhrase(rec);
    if (c.kind === "request") {
      const st = rec.children[c.sig];
      if (!st) return;
      const usual = quantile(st.delay, 0.95);
      const waited = now - inst.user.start;
      this.note({
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
    if (!f || !stA) return;
    let endA = inst.user.start;
    for (const o of inst.children) if (o.name === a && okEnd(o) && (o.end ?? 0) > endA) endA = o.end ?? endA;
    const usual = quantile(f.delay, 0.95);
    const waited = now - endA;
    this.note({
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

  /** Record a deviation (kept for rt.learned()) and report it. The runtime adds its own `response` kind here. */
  note(e: Expectation): void {
    this.deviations.push(e);
    if (this.deviations.length > DEVIATIONS_KEPT) this.deviations.shift();
    this.env.report(e);
  }

  private close(inst: Inst, now: number): void {
    this.open.delete(inst.user.id);
    if (inst.timer !== null) this.env.clearTimeout(inst.timer);
    inst.timer = null;
    if (inst.hidden || this.env.hidden()) return;
    this.checkAtClose(inst, now);
    this.learn(inst, now);
  }

  /** Writes and navigation are checked once the flow is over (responses write in their callbacks). */
  private checkAtClose(inst: Inst, now: number): void {
    const rec = inst.rec;
    if (this.env.online() === false) return;
    const who = actionPhrase(rec);
    const seenSig = new Set<string>();
    for (const o of inst.children) {
      if (!okEnd(o) || o.genclass || o.scope?.protected || seenSig.has(o.name)) continue;
      seenSig.add(o.name);
      const W = rec.writes[o.name];
      if (!W || W.n < this.cfg.minSupport || (inst.wrote.get(o.id)?.size ?? 0) > 0) continue;
      const fields = Object.keys(W.fields)
        .filter((f) => W.fields[f] / W.n >= this.cfg.minShare)
        .sort();
      if (!fields.length) continue;
      this.note({
        kind: "write",
        route: rec.route,
        action: who,
        op: inst.user.id,
        signature: o.name,
        field: fields.join(", "),
        seen: Math.min(...fields.map((f) => W.fields[f])),
        of: W.n,
        sessions: rec.sessions,
        waitedMs: now - inst.user.start,
        at: now,
        message: `[GenClass] Expected a state change on ${rec.route}: the response to ${o.name} after ${who} usually writes ${fields.join(", ")} (${Math.min(...fields.map((f) => W.fields[f]))} of ${plural(W.n, "time")}); this time it wrote nothing.`,
      });
    }
    if (inst.nav !== null || !this.qualifies(rec)) return;
    for (const [to, c] of Object.entries(rec.nav)) {
      if (c / rec.n < this.cfg.minShare) continue;
      const usual = quantile(rec.navDelay, 0.95);
      const waited = now - inst.user.start;
      this.note({
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
      return;
    }
  }

  private learn(inst: Inst, now: number): void {
    const rec = inst.rec;
    rec.n++;
    if (rec.last !== this.session) {
      rec.last = this.session;
      rec.sessions++;
    }
    rec.used = ++this.tick;
    const u = inst.user.start;
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
        st = rec.children[sig] = { n: 0, done: 0, delay: [] };
      }
      st.n++;
      push(st.delay, Math.min(...ops.map((o) => o.start)) - u);
      if (ops.some(okEnd)) st.done++;
      if (ops.some((o) => o.scope?.protected)) st.protected = true;
      if (st.protected) continue;
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
    // follow-ups: B started after some A of this flow completed
    for (const [a, opsA] of bySig) {
      const ends = opsA.filter(okEnd).map((o) => o.end as number);
      if (!ends.length) continue;
      for (const [b, opsB] of bySig) {
        if (a === b) continue;
        let best = Infinity;
        for (const e of ends) for (const o of opsB) if (o.start >= e && o.start - e < best) best = o.start - e;
        if (best === Infinity) continue;
        const k = `${a}${PAIR}${b}`;
        let f = rec.follows[k];
        if (!f) {
          if (Object.keys(rec.follows).length >= MAX_FOLLOWS) continue;
          f = rec.follows[k] = { n: 0, delay: [] };
        }
        f.n++;
        push(f.delay, best);
      }
    }
    if (inst.nav !== null && (inst.nav in rec.nav || Object.keys(rec.nav).length < MAX_NAV)) {
      rec.nav[inst.nav] = (rec.nav[inst.nav] ?? 0) + 1;
      push(rec.navDelay, inst.navAt - u);
    }
    void now;
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
        sessions: rec.sessions,
        children: Object.entries(rec.children).map(([signature, st]) => {
          const c: LearnedFlow["children"][number] = { signature, n: st.n, share: rec.n ? st.n / rec.n : 0, expected: !!this.expectedStep(rec, signature) };
          if (st.protected) c.protected = true;
          if (st.delay.length) c.delayMs = stat(st.delay);
          return c;
        }),
        writes: Object.entries(rec.writes).flatMap(([signature, W]) => Object.entries(W.fields).map(([field, n]) => ({ signature, field, n, of: W.n, share: W.n ? n / W.n : 0, expected: W.n >= this.cfg.minSupport && n / W.n >= this.cfg.minShare }))),
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

  load(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (const r of list as FlowRecord[]) {
      if (!r || typeof r !== "object" || typeof r.h !== "string" || typeof r.n !== "number" || typeof r.route !== "string") continue;
      const rec: FlowRecord = {
        h: r.h,
        route: r.route,
        kind: typeof r.kind === "string" ? r.kind : "click",
        role: typeof r.role === "string" ? r.role : "page",
        n: r.n,
        sessions: typeof r.sessions === "number" ? r.sessions : 1,
        last: typeof r.last === "number" ? r.last : 0,
        settle: Array.isArray(r.settle) ? r.settle.filter((x) => typeof x === "number") : [],
        navDelay: Array.isArray(r.navDelay) ? r.navDelay.filter((x) => typeof x === "number") : [],
        children: r.children && typeof r.children === "object" ? r.children : {},
        follows: r.follows && typeof r.follows === "object" ? r.follows : {},
        writes: r.writes && typeof r.writes === "object" ? r.writes : {},
        nav: r.nav && typeof r.nav === "object" ? r.nav : {},
        used: typeof r.used === "number" ? r.used : 0,
      };
      this.byKey.set(rec.h, rec);
      if (rec.used > this.tick) this.tick = rec.used;
      if (this.byKey.size > MAX_FLOWS) this.dropLeastUsed(this.byKey.size - MAX_FLOWS);
    }
  }

  clear(): void {
    this.byKey.clear();
    this.deviations.length = 0;
  }

  /** Cancel every open instance's timer (destroy). */
  dispose(): void {
    for (const inst of this.open.values()) if (inst.timer !== null) this.env.clearTimeout(inst.timer);
    this.open.clear();
  }
}

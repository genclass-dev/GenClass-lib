// The bridge's state (docs/runtime/AGENT.md section 4): page loads (runs) and what they sent, the findings derived
// from them, explore sessions and armed replays. Findings are deduplicated by a key made of their kind, route and
// signatures (state paths by shape: a new record's id does not make a new bug), and ranked by kind, then count, then
// recency. Persisted as one JSON file in the state directory (which ignores itself in git) so a new agent session sees
// what the last one found; runs a finding needs are always kept.
//
// Findings name facts the page recorded (a response that overwrote newer data, identical requests from two clicks, an
// uncaught error, an explore run whose final state differs from the request-order baseline) or the on-device model's
// own detections, labelled as such. The bridge adds no judgement of its own. Every page string in a title is quoted.
//
// A run belongs to the page that registered it: events must come from the same origin with the token it got at hello.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareRuns, endedDifferently, sameScenario, sameValue, settledAfterActs, stateValue, type GroupReport, type RunDiff } from "./compare.js";
import { clean, pathShape, q, shape, sigOf } from "./text.js";
import type { ExploreSession, Finding, FindingKind, ReplayArm, Run, ScheduleSpec, Step } from "./types.js";
import * as V from "./validate.js";

const MAX_RUNS = 300;
const MAX_FINDINGS = 500;
const MAX_STEPS = 3000;
const SAVED_RUNS = 80;
/** Armed explores and replays expire: a page load hours later is not given a held schedule by surprise. */
export const ARM_TTL_MS = 30 * 60_000;
const RANK: Record<FindingKind, number> = { race: 0, "stale-write": 1, error: 2, "duplicate-request": 3, detection: 4, check: 5, expectation: 6, intervention: 7 };

export interface StoreOptions {
  /** Directory for state.json (default: none, in memory only). */
  dir?: string;
  now?: () => number;
}

export interface FindingEvent {
  finding: Finding;
  fresh: boolean;
}

export interface Hello {
  run: string;
  token: string;
  schedule: ScheduleSpec | null;
}

export class Store {
  runs = new Map<string, Run>();
  findings = new Map<string, Finding>();
  byKey = new Map<string, string>();
  explores = new Map<string, ExploreSession>();
  replays: ReplayArm[] = [];
  private nextRun = 1;
  private nextFinding = 1;
  private nextExplore = 1;
  private saveTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(e: FindingEvent) => void>();
  readonly now: () => number;
  /** This store's identity for digest cursors (a cursor from another process means "from the start"). */
  readonly epoch = randomUUID();
  /** Monotonic counter of finding changes (digest cursors). */
  version = 0;
  private changedAt = new Map<string, number>();

  constructor(private readonly opts: StoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    if (opts.dir) this.load();
  }

  onFinding(fn: (e: FindingEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------------------------------- page side

  /** A page load said hello: a run, and the schedule the agent armed for it (a replay first, then an explore plan). */
  hello(body: unknown, origin?: string): Hello | null {
    const h = V.hello(body);
    if (!h) return null;
    const id = `r${this.nextRun++}`;
    const now = this.now();
    const run: Run = {
      id,
      started: now,
      lastSeen: now,
      page: { url: h.url, route: h.route, ...(h.title ? { title: h.title } : {}) },
      schedule: h.schedule,
      steps: [],
      lost: 0,
      order: [],
      forced: 0,
      witnesses: [],
      errors: [],
      detections: [],
      interventions: [],
      checks: [],
      expectations: [],
      snapshots: 0,
      ended: false,
      token: randomBytes(16).toString("hex"),
    };
    if (origin) run.origin = origin;
    if (h.ua) run.ua = h.ua;
    if (h.mode || h.model) run.runtime = { ...(h.mode ? { mode: h.mode } : {}), ...(h.model ? { model: h.model } : {}) };
    // a schedule the page set itself (a regression test, a URL, hold: false) wins; otherwise what the agent armed
    if (!h.schedule) {
      const arm = this.replays.find((r) => r.remaining > 0 && now - r.created < ARM_TTL_MS && (!r.route || r.route === h.route));
      if (arm) {
        arm.remaining--;
        arm.runs.push(id);
        run.schedule = { ...arm.spec, id: arm.finding, label: `replay of ${arm.finding}` };
        run.assignment = { kind: "replay", ref: arm.finding, index: arm.runs.length - 1, label: `replay of ${arm.finding}` };
      } else {
        const x = [...this.explores.values()].find((s) => s.state === "armed" && now - s.created < ARM_TTL_MS && (!s.route || s.route === h.route));
        if (x) {
          // an explore armed without a route belongs to the page of its first load: other pages and tabs keep out
          if (!x.route) x.route = h.route;
          const spec = x.plan[x.next];
          const label = spec.label ?? `explore ${x.next + 1}`;
          run.schedule = { ...spec, id: x.id, label };
          run.assignment = { kind: "explore", ref: x.id, index: x.next, label };
          x.runs.push(id);
          x.next++;
          if (x.next >= x.plan.length) x.state = "collecting";
        }
      }
    }
    this.runs.set(id, run);
    if (this.runs.size > MAX_RUNS) {
      const pin = this.pinnedIds();
      const old = [...this.runs.values()].filter((r) => !pin.has(r.id)).sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (old) this.runs.delete(old.id);
    }
    this.saveSoon();
    return { run: id, token: run.token!, schedule: run.schedule };
  }

  /** Runs a finding, a live explore session or an armed replay refers to: never dropped, always saved. */
  private pinnedIds(): Set<string> {
    const pin = new Set<string>();
    for (const f of this.findings.values()) {
      if (f.run) pin.add(f.run);
      for (const r of f.replays) pin.add(r.run);
    }
    for (const x of this.explores.values()) if (x.state !== "stopped") for (const r of x.runs) pin.add(r);
    for (const a of this.replays) for (const r of a.runs) pin.add(r);
    return pin;
  }

  /**
   * A batch of events from a page. Only the page that registered the run may send them (same origin, its token).
   * Invalid events are skipped. Returns how many were applied.
   */
  events(body: unknown, origin?: string): number {
    const o = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const run = o && typeof o.run === "string" ? this.runs.get(o.run) : undefined;
    if (!run || !Array.isArray(o?.events)) return 0;
    if (run.origin !== undefined && run.origin !== origin) return 0;
    if (run.token !== undefined && o!.token !== run.token) return 0;
    run.lastSeen = this.now();
    let n = 0;
    for (const ev of (o!.events as unknown[]).slice(0, 200)) {
      if (!ev || typeof ev !== "object") continue;
      try {
        if (this.apply(run, ev as Record<string, unknown>)) n++;
      } catch {
        /* skip a bad event */
      }
    }
    this.saveSoon();
    return n;
  }

  private apply(run: Run, e: Record<string, unknown>): boolean {
    const route = run.page.route;
    switch (e.t) {
      case "steps": {
        for (const s of Array.isArray(e.steps) ? e.steps.slice(0, 1000) : []) {
          const st = V.step(s);
          if (!st) continue;
          // a typing burst sent again with its latest value replaces the earlier copy of that action
          if (st.k === "act") {
            const i = run.steps.findIndex((x) => x.k === "act" && x.i === st.i);
            if (i >= 0) {
              run.steps[i] = st;
              continue;
            }
          }
          run.steps.push(st);
        }
        if (run.steps.length > MAX_STEPS) run.steps.splice(0, run.steps.length - MAX_STEPS);
        if (Array.isArray(e.order)) {
          const order = e.order.filter((k): k is string => typeof k === "string").slice(-400).map((k) => k.slice(0, 300));
          // the page sends its newest keys; keep the full order by appending what is new
          run.order = mergeOrder(run.order, order);
        }
        if (typeof e.forced === "number") run.forced = Math.max(0, Math.floor(e.forced));
        if (typeof e.lost === "number") run.lost += Math.max(0, Math.floor(e.lost));
        return true;
      }
      case "snapshot":
      case "end": {
        const s = V.snapshot(e.snapshot);
        if (s) {
          run.snapshot = s;
          run.snapshots++;
        }
        if (e.t === "end") run.ended = true;
        return true;
      }
      case "schedule": {
        // the page applied another schedule than the bridge assigned (its hello reply came too late)
        const spec = V.spec(e.spec);
        if (!spec) return false;
        this.unassign(run);
        run.schedule = spec;
        return true;
      }
      case "witness": {
        const w = V.witness(e.witness);
        if (!w || run.witnesses.length >= 200) return false;
        run.witnesses.push(w);
        if (w.kind === "overwrote-newer") {
          const over = w.overKind === "user" ? `the user's ${q(w.over, 80)}` : `a newer ${q(sigOf(w.over), 120)}`;
          this.upsert(`stale|${route}|${pathShape(w.subject)}|${sigOf(w.by)}`, "stale-write", route, run, {
            title: `The response to ${q(sigOf(w.by), 120)}${w.byDetail ? ` ${q(w.byDetail, 60)}` : ""} overwrote ${q(w.subject, 80)} after ${over} had already written it`,
            evidence: { ...w },
          });
        } else {
          this.upsert(`dup|${route}|${w.subject}`, "duplicate-request", route, run, {
            title: `${q(w.subject, 100)} was sent twice, ${w.gapMs ?? "?"} ms apart, by two separate user actions while the first was in flight`,
            evidence: { ...w },
          });
        }
        return true;
      }
      case "error": {
        const er = V.error(e.error);
        if (!er || run.errors.length >= 200) return false;
        run.errors.push(er);
        const top = er.stack?.split("\n").find((l) => /\bat\b|@/.test(l))?.trim() ?? er.source ?? "";
        this.upsert(`err|${route}|${er.name}|${shape(er.message)}|${shape(top)}`, "error", route, run, {
          title: `Uncaught ${q(er.message, 120)}${er.chain.length ? ` after ${q(er.chain[0], 80)}` : ""}`,
          evidence: { ...er, stack: er.stack?.split("\n").slice(0, 12).join("\n") },
        });
        return true;
      }
      case "detection": {
        const d = V.decision(e.decision);
        if (!d) return false;
        const x = V.explain(e.explain);
        run.detections.push({ at: Number(e.at) || 0, decision: d, ...(x ? { explain: x } : {}) });
        if (run.detections.length > 200) run.detections.shift();
        const subj = d.subject ?? "";
        this.upsert(`det|${route}|${d.trigger}|${d.diagnosis}|${shape(subj)}`, "detection", route, run, {
          title: `The on-device model diagnosed ${q(d.diagnosis, 30)} (${Math.round((d.diagnosisConfidence ?? 0) * 100)}%, ${q(d.detection, 20)}) at the ${q(d.trigger, 20)} of ${q(subj, 100)}`,
          evidence: { decision: d, ...(x ? { explain: x } : {}) },
        });
        return true;
      }
      case "intervention": {
        const a = V.small(e.action);
        const x = V.explain(e.explain);
        run.interventions.push({ at: Number(e.at) || 0, action: a, ...(x ? { explain: x } : {}) });
        if (run.interventions.length > 200) run.interventions.shift();
        this.upsert(`act|${route}|${clean(a.action, 30)}|${shape(String(a.subject ?? ""))}`, "intervention", route, run, {
          title: `GenClass ran ${q(a.action, 30)} on ${q(a.subject, 100)}: ${q(a.changed, 160)}`,
          evidence: { action: a, ...(x ? { explain: x } : {}) },
        });
        return true;
      }
      case "check": {
        const c = V.small(e.check);
        run.checks.push({ at: Number(e.at) || 0, check: c });
        if (run.checks.length > 200) run.checks.shift();
        this.upsert(`check|${route}|${clean(c.kind, 40)}|${shape(String(c.selector ?? c.message ?? ""))}`, "check", route, run, {
          title: `Visual check ${q(c.kind, 40)}: ${q(c.message ?? c.selector, 160)}`,
          evidence: { check: c },
        });
        return true;
      }
      case "expectation": {
        const x = V.small(e.expectation);
        run.expectations.push({ at: Number(e.at) || 0, expectation: x });
        if (run.expectations.length > 200) run.expectations.shift();
        this.upsert(`exp|${route}|${clean(x.kind, 40)}|${shape(String(x.signature ?? x.field ?? ""))}`, "expectation", route, run, {
          title: `A learned step did not happen: ${q(x.message ?? x.signature ?? x.field, 160)}`,
          evidence: { expectation: x },
        });
        return true;
      }
      case "learned": {
        run.learned = V.small(e.learned, 4);
        run.baselines = V.baselines(e.baselines);
        return true;
      }
      default:
        return false;
    }
  }

  /** Give a run's explore slot or replay back: the page did not run what it was assigned. */
  private unassign(run: Run): void {
    const a = run.assignment;
    if (!a) return;
    if (a.kind === "explore") {
      const x = this.explores.get(a.ref);
      if (x) {
        x.runs = x.runs.filter((r) => r !== run.id);
        const spec = x.plan[a.index];
        if (spec && x.state !== "stopped") {
          x.plan.push({ ...spec });
          if (x.state === "collecting") x.state = "armed";
        }
      }
    } else {
      const arm = this.replays.find((r) => r.finding === a.ref && r.runs.includes(run.id));
      if (arm) {
        arm.runs = arm.runs.filter((r) => r !== run.id);
        arm.remaining++;
      }
    }
    delete run.assignment;
  }

  private upsert(key: string, kind: FindingKind, route: string, run: Run, o: { title: string; evidence: Record<string, unknown>; replay?: ScheduleSpec; replace?: boolean }): Finding {
    const now = this.now();
    const id = this.byKey.get(key);
    let f = id ? this.findings.get(id) : undefined;
    const fresh = !f;
    if (!f) {
      f = { id: `f${this.nextFinding++}`, key, kind, title: o.title, route, count: 0, runs: [], first: now, last: now, evidence: o.evidence, replays: [] };
      if (o.replay) f.replay = o.replay;
      f.run = run.id;
      this.findings.set(f.id, f);
      this.byKey.set(key, f.id);
      if (this.findings.size > MAX_FINDINGS) this.dropOldest();
    } else if (o.replace) {
      // the newest failing run, its evidence and its replay belong together
      f.title = o.title;
      f.evidence = o.evidence;
      f.run = run.id;
      if (o.replay) f.replay = o.replay;
    }
    f.count++;
    f.last = now;
    if (!f.runs.includes(run.id)) {
      f.runs.push(run.id);
      if (f.runs.length > 20) f.runs.shift();
    }
    this.version++;
    this.changedAt.set(f.id, this.version);
    for (const fn of this.listeners) {
      try {
        fn({ finding: f, fresh });
      } catch {
        /* a listener never breaks ingestion */
      }
    }
    return f;
  }

  private dropOldest(): void {
    const old = [...this.findings.values()].sort((a, b) => a.last - b.last)[0];
    if (!old) return;
    this.findings.delete(old.id);
    this.byKey.delete(old.key);
    this.changedAt.delete(old.id);
  }

  private noteReplay(f: Finding, run: Run, reproduced: boolean | null, note: string): void {
    const prev = f.replays.find((r) => r.run === run.id);
    if (prev) {
      Object.assign(prev, { reproduced, note, at: this.now() });
      return;
    }
    f.replays.push({ run: run.id, at: this.now(), reproduced, note });
    if (f.replays.length > 20) f.replays.shift();
  }

  // ------------------------------------------------------------------------------------------- agent side

  ranked(o: { kind?: string; route?: string; sinceMs?: number; limit?: number } = {}): Finding[] {
    const now = this.now();
    return [...this.findings.values()]
      .filter((f) => (!o.kind || f.kind === o.kind) && (!o.route || f.route === o.route) && (!o.sinceMs || now - f.last <= o.sinceMs))
      .sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.count - a.count || b.last - a.last)
      .slice(0, Math.max(1, Math.min(o.limit ?? 20, 100)));
  }

  /** Findings changed since a digest cursor (the prompt hook, a shared bridge's followers). Another epoch: from 0. */
  since(cursor: number, epoch?: string): { epoch: string; cursor: number; findings: Finding[] } {
    const from = epoch !== undefined && epoch !== this.epoch ? 0 : cursor;
    const out: Finding[] = [];
    for (const [id, v] of this.changedAt)
      if (v > from) {
        const f = this.findings.get(id);
        if (f) out.push(f);
      }
    out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.last - a.last);
    return { epoch: this.epoch, cursor: this.version, findings: out };
  }

  /**
   * Arm an explore session: two fifo baselines, then `runs` seeded orders, all with the same extra latency when asked
   * (so timing alone never separates the baselines from the seeded runs).
   */
  armExplore(o: { runs?: number; route?: string; focus?: string[]; delay?: { minMs: number; maxMs: number }; seed?: number }): ExploreSession {
    for (const x of this.explores.values()) if (x.state === "armed") x.state = "stopped";
    const id = `x${this.nextExplore++}`;
    const n = Math.max(1, Math.min(o.runs ?? 6, 50));
    const seed0 = o.seed ?? 1;
    // a blocker may sit in its own emulated delay: the hold limit grows by the largest delay, so waiting behind it is
    // never cut short (1500 is the page's default maxHoldMs; 30 s its cap)
    const slow = (spec: ScheduleSpec): ScheduleSpec => (o.delay ? { ...spec, delay: o.delay, maxHoldMs: Math.min(30_000, 1500 + o.delay.maxMs) } : spec);
    const plan: ScheduleSpec[] = [slow({ order: "fifo", label: "baseline 1 (responses in request order)" }), slow({ order: "fifo", label: "baseline 2 (responses in request order)" })];
    for (let i = 0; i < n; i++) {
      const spec: ScheduleSpec = slow({ order: "seeded", seed: seed0 + i, label: `seed ${seed0 + i}` });
      if (o.focus?.length) spec.focus = o.focus.slice(0, 20);
      plan.push(spec);
    }
    const x: ExploreSession = { id, created: this.now(), plan, next: 0, runs: [], state: "armed", counted: [] };
    if (o.route) x.route = o.route;
    if (o.focus?.length) x.focus = o.focus.slice(0, 20);
    this.explores.set(id, x);
    this.saveSoon();
    return x;
  }

  latestExplore(): ExploreSession | undefined {
    return [...this.explores.values()].sort((a, b) => b.created - a.created)[0];
  }

  /**
   * Compare an explore session's runs; a group with two baselines and a run whose difference reached the page (its
   * text, form values, requests or errors) becomes (or refreshes) a race finding. Differences in store values only, and
   * overwrites a later response repaired, are reported in the groups but make no finding. A run already counted for a
   * finding is not counted again when the same session is reported twice.
   */
  reportExplore(id?: string): { session: ExploreSession; groups: GroupReport[]; findings: Finding[] } | null {
    const x = id ? this.explores.get(id) : this.latestExplore();
    if (!x) return null;
    const runs = x.runs.map((r) => this.runs.get(r)).filter((r): r is Run => !!r);
    const groups = compareRuns(runs);
    const findings: Finding[] = [];
    const counted = new Set(x.counted ?? []);
    for (const g of groups) {
      if (g.insufficientBaselines) continue;
      const races = g.diffs.filter((y) => y.tier === "visible");
      const d = races[0];
      if (!d) continue;
      const run = this.runs.get(d.run);
      if (!run) continue;
      // keyed by what the page showed or sent (store values that differ along with it are evidence, not identity)
      const shown = d.fields.filter((f) => f.where !== "state");
      const kindOfDiff = shown.length ? `fields:${shown.map((f) => f.name).sort().join(",")}` : d.errors.length ? `error:${shape(d.errors[0])}` : "text";
      const key = `race|${g.route}|${g.scenarioKey.slice(0, 600)}|${kindOfDiff}`;
      const replay: ScheduleSpec = run.schedule ? { ...run.schedule } : { order: "given", given: run.order.slice() };
      delete replay.id;
      delete replay.label;
      const evidence = { session: x.id, scenario: g.scenario, baselines: g.baselines, noise: g.noise, ...d, endedDifferently: endedDifferently(d), failingRuns: races.map((y) => ({ run: y.run, label: y.label, endedDifferently: endedDifferently(y) })), of: g.compared };
      const existing = this.byKey.get(key);
      if (existing && counted.has(`${run.id}|${key}`)) {
        const f = this.findings.get(existing);
        if (f) findings.push(f);
        continue;
      }
      const f = this.upsert(key, "race", g.route, run, { title: raceTitle(d), evidence, replay, replace: true });
      counted.add(`${run.id}|${key}`);
      findings.push(f);
    }
    x.counted = [...counted].slice(-500);
    if (x.state === "collecting" && x.runs.length >= x.plan.length) x.state = "stopped";
    this.saveSoon();
    return { session: x, groups, findings };
  }

  stopExplore(): ExploreSession | null {
    let last: ExploreSession | null = null;
    for (const x of this.explores.values())
      if (x.state !== "stopped") {
        x.state = "stopped";
        last = x;
      }
    this.saveSoon();
    return last;
  }

  /** Arm the next page loads of a finding's page with the order that produced it; an error when nothing replays it. */
  armReplay(findingId: string, times = 1): ReplayArm | { error: string } | null {
    const f = this.findings.get(findingId);
    if (!f) return null;
    const spec = replaySpecOf(f, f.run ? this.runs.get(f.run) : undefined);
    if (!spec) return { error: `the run that recorded ${f.id} is gone (cleared or expired), so its order cannot be replayed: record the bug again, or reproduce it with genclass_explore` };
    this.replays = this.replays.filter((r) => r.finding !== findingId || (r.remaining <= 0 && this.now() - r.created < ARM_TTL_MS));
    const arm: ReplayArm = { finding: f.id, spec, route: f.route, remaining: Math.max(1, Math.min(times, 10)), created: this.now(), runs: [] };
    this.replays.push(arm);
    if (this.replays.length > 50) this.replays.shift();
    this.saveSoon();
    return arm;
  }

  /**
   * Did the latest replay runs of a finding reproduce it? Stale-write and duplicate findings: the same witness (field
   * by shape, signature). Error: the same error. Race: the failing run's values, page text, error or witness again;
   * the baseline's = not reproduced. Inconclusive (null) when the run has not settled or done the steps yet, when its
   * steps differ from the original run's, or when the original run is gone.
   */
  replayResult(findingId: string): { finding: Finding; results: { run: string; reproduced: boolean | null; note: string; scenarioMatches: boolean }[] } | null {
    const f = this.findings.get(findingId);
    if (!f) return null;
    const orig = f.run ? this.runs.get(f.run) : undefined;
    const runs = [...this.runs.values()].filter((r) => r.assignment?.kind === "replay" && r.assignment.ref === f.id);
    const ev = f.evidence as Record<string, unknown>;
    const results = runs.map((r) => {
      const scenarioMatches = !!orig && sameScenario(orig, r);
      const origActs = orig ? orig.steps.some((s) => s.k === "act") : false;
      const acted = r.steps.some((s) => s.k === "act");
      let reproduced: boolean | null = null;
      let note = "";
      if (!orig) note = "the original run is gone, so the steps cannot be compared: record the bug again before trusting a replay";
      else if (origActs && !acted) note = "no user actions were recorded in this run yet: do the steps, await whenSettled(), then ask again";
      else if (!settledAfterActs(r)) note = "the run has not reached a quiet point after its steps yet (or never connected): wait for whenSettled(), then ask again";
      else if (f.kind === "stale-write" || f.kind === "duplicate-request") {
        const want = f.kind === "stale-write" ? "overwrote-newer" : "identical-in-flight";
        const hit = r.witnesses.some((w) => w.kind === want && pathShape(w.subject) === pathShape(String(ev.subject)) && sigOf(w.by) === sigOf(String(ev.by)));
        reproduced = hit;
        note = hit ? "the same fact was recorded again under the replayed order" : "not recorded under the replayed order";
      } else if (f.kind === "error") {
        const hit = r.errors.some((e) => e.name === ev.name && shape(e.message) === shape(String(ev.message)));
        reproduced = hit;
        note = hit ? "the same error was thrown again" : "the error did not recur";
      } else if (f.kind === "race") {
        const v = raceVerdict(ev, r);
        reproduced = scenarioMatches ? v.reproduced : null;
        note = v.note;
      } else note = "replays verify stale-write, duplicate-request, error and race findings";
      if (orig && !scenarioMatches && note) note += " (the replay's user actions differ from the original run's: do the same steps)";
      if (r.forced) note += ` (${r.forced} response(s) were delivered only when their hold ran out: the run did not follow the order exactly)`;
      this.noteReplay(f, r, reproduced, note);
      return { run: r.id, reproduced, note, scenarioMatches };
    });
    this.saveSoon();
    return { finding: f, results };
  }

  clear(what: "all" | "findings" | "runs" = "all"): void {
    if (what !== "runs") {
      this.findings.clear();
      this.byKey.clear();
      this.changedAt.clear();
    }
    if (what !== "findings") {
      // runs the remaining findings need stay (a finding without its run cannot be replayed)
      const pin = what === "runs" ? this.pinnedIds() : new Set<string>();
      for (const id of [...this.runs.keys()]) if (!pin.has(id)) this.runs.delete(id);
      this.explores.clear();
      this.replays = [];
    }
    this.version++;
    this.saveSoon();
  }

  // ------------------------------------------------------------------------------------------- persistence

  private file(): string | null {
    return this.opts.dir ? join(this.opts.dir, "state.json") : null;
  }

  saveSoon(): void {
    if (!this.opts.dir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1000);
    this.saveTimer.unref?.();
  }

  save(): void {
    const file = this.file();
    if (!file) return;
    const dir = this.opts.dir!;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // the state directory ignores itself (and only itself), so recorded runs are never committed by accident
      try {
        writeFileSync(join(dir, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 });
      } catch {
        /* exists */
      }
      const pin = this.pinnedIds();
      const all = [...this.runs.values()];
      const keep = [...all.filter((r) => pin.has(r.id)), ...all.filter((r) => !pin.has(r.id)).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, SAVED_RUNS)];
      const runs = keep.map((r) => {
        const { token: _t, ...rest } = r;
        return rest;
      });
      const data = { schema: "genclass-mcp-state/1", nextRun: this.nextRun, nextFinding: this.nextFinding, nextExplore: this.nextExplore, runs, findings: [...this.findings.values()], explores: [...this.explores.values()].slice(-20) };
      // a fresh temporary name (never an existing file or a planted link), then an atomic rename
      const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
      try {
        renameSync(tmp, file);
      } catch {
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* state is a convenience; never fail a request over it */
    }
  }

  /** Load state.json, keeping only well-formed entries. Armed explores and replays are not restored (they expire). */
  private load(): void {
    const file = this.file();
    if (!file) return;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      return; // no state yet, or unreadable: start empty
    }
    if (!d || d.schema !== "genclass-mcp-state/1") return;
    const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1);
    this.nextRun = int(d.nextRun);
    this.nextFinding = int(d.nextFinding);
    this.nextExplore = int(d.nextExplore);
    for (const r of Array.isArray(d.runs) ? d.runs : []) {
      const run = loadRun(r);
      if (run) this.runs.set(run.id, run);
    }
    for (const x of Array.isArray(d.findings) ? d.findings : []) {
      const f = loadFinding(x);
      if (!f || this.byKey.has(f.key)) continue;
      this.findings.set(f.id, f);
      this.byKey.set(f.key, f.id);
    }
    for (const x of Array.isArray(d.explores) ? d.explores : []) {
      const o = x as ExploreSession;
      if (!o || typeof o.id !== "string" || !Array.isArray(o.plan) || !Array.isArray(o.runs)) continue;
      const plan = o.plan.map((p) => V.spec(p)).filter((p): p is ScheduleSpec => !!p);
      this.explores.set(o.id, { id: o.id, created: Number(o.created) || 0, plan, next: Math.min(Number(o.next) || 0, plan.length), runs: o.runs.filter((r) => typeof r === "string"), state: "stopped", ...(typeof o.route === "string" ? { route: o.route } : {}), counted: Array.isArray(o.counted) ? o.counted.filter((c) => typeof c === "string") : [] });
    }
  }
}

/** A run from state.json, re-validated (steps, witnesses, errors, snapshot); null when malformed. */
function loadRun(v: unknown): Run | null {
  const r = v as Run;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.page || typeof r.page.route !== "string") return null;
  const steps = (Array.isArray(r.steps) ? r.steps : []).map((s) => V.step(s)).filter((s): s is Step => !!s);
  const run: Run = {
    id: r.id.slice(0, 20),
    started: Number(r.started) || 0,
    lastSeen: Number(r.lastSeen) || 0,
    page: { url: String(r.page.url ?? "").slice(0, 2000), route: r.page.route.slice(0, 500), ...(typeof r.page.title === "string" ? { title: r.page.title.slice(0, 200) } : {}) },
    schedule: V.spec(r.schedule),
    steps,
    lost: Number(r.lost) || 0,
    order: (Array.isArray(r.order) ? r.order : []).filter((k): k is string => typeof k === "string").slice(-4000),
    forced: Number(r.forced) || 0,
    witnesses: (Array.isArray(r.witnesses) ? r.witnesses : []).map((w) => V.witness(w)).filter((w): w is NonNullable<typeof w> => !!w),
    errors: (Array.isArray(r.errors) ? r.errors : []).map((e) => V.error(e)).filter((e): e is NonNullable<typeof e> => !!e),
    detections: [],
    interventions: [],
    checks: [],
    expectations: [],
    snapshots: Number(r.snapshots) || 0,
    ended: true,
  };
  const snap = V.snapshot(r.snapshot);
  if (snap) run.snapshot = snap;
  if (typeof r.origin === "string") run.origin = r.origin.slice(0, 300);
  run.token = randomBytes(16).toString("hex"); // a restored run takes no more events: no page knows this token
  if (r.assignment && typeof r.assignment === "object" && (r.assignment.kind === "explore" || r.assignment.kind === "replay")) run.assignment = { kind: r.assignment.kind, ref: String(r.assignment.ref).slice(0, 20), index: Number(r.assignment.index) || 0, label: clean(r.assignment.label, 100) };
  return run;
}

const KINDS = new Set(Object.keys(RANK));

/** A finding from state.json; its title is cleaned again (printed as one line whatever the file holds). */
function loadFinding(v: unknown): Finding | null {
  const f = v as Finding;
  if (!f || typeof f !== "object" || typeof f.id !== "string" || typeof f.key !== "string" || !KINDS.has(f.kind)) return null;
  const out: Finding = {
    id: f.id.slice(0, 20),
    key: f.key.slice(0, 2000),
    kind: f.kind,
    title: clean(f.title, 400),
    route: clean(f.route, 500),
    count: Number(f.count) || 1,
    runs: (Array.isArray(f.runs) ? f.runs : []).filter((r): r is string => typeof r === "string").slice(-20),
    first: Number(f.first) || 0,
    last: Number(f.last) || 0,
    evidence: f.evidence && typeof f.evidence === "object" ? f.evidence : {},
    replays: (Array.isArray(f.replays) ? f.replays : []).filter((r) => r && typeof r.run === "string").slice(-20),
  };
  if (typeof f.run === "string") out.run = f.run;
  const rp = V.spec(f.replay);
  if (rp) out.replay = rp;
  return out;
}

/** A race finding's title, by what differed (page strings quoted). */
function raceTitle(d: RunDiff): string {
  const shown = d.fields.filter((f) => f.where !== "state");
  if (shown.length) return `The final state depends on response order: ${shown.slice(0, 2).map((f) => `${f.where === "requests" ? "requests to" : f.where} ${q(f.name, 60)} (${q(f.baseline, 40)} in request order, ${q(f.run, 40)} under ${q(d.label, 30)})`).join("; ")}`;
  if (d.errors.length) return `An error depends on response order: ${q(d.errors[0], 120)} under ${q(d.label, 30)}, not in request order`;
  if (d.textOnlyRun.length) return `The page depends on response order: it shows ${q(d.textOnlyRun[0], 80)} under ${q(d.label, 30)}, not in request order`;
  if (d.textOnlyBaseline.length) return `The page depends on response order: it no longer shows ${q(d.textOnlyBaseline[0], 80)} under ${q(d.label, 30)}`;
  if (d.fields.length) return `The final state depends on response order: ${d.fields.slice(0, 2).map((f) => `${f.where} ${q(f.name, 60)} (${q(f.baseline, 40)} in request order, ${q(f.run, 40)} under ${q(d.label, 30)})`).join("; ")}`;
  const w = d.witnesses[0] ?? "";
  if (w.startsWith("identical-in-flight")) return `The same request was sent twice under ${q(d.label, 30)}, not in request order (the final state matched the baseline): ${q(w, 160)}`;
  return `An older response overwrote newer data under ${q(d.label, 30)} (the final state matched the baseline; users would see it flicker): ${q(w, 160)}`;
}

/** Does a replay run show the race finding's difference again? From the evidence of the failing run. */
function raceVerdict(ev: Record<string, unknown>, r: Run): { reproduced: boolean | null; note: string } {
  const snap = r.snapshot!;
  const all = (ev.fields as { where: string; name: string; baseline: string; run: string }[] | undefined) ?? [];
  const val = (d: { where: string; name: string }) => (d.where === "state" ? stateValue(snap.state, d.name) : d.where === "field" ? snap.fields?.[d.name] : snap.requests[d.name] !== undefined ? String(snap.requests[d.name]) : undefined) ?? "(absent)";
  const byValues = (fields: typeof all): { reproduced: boolean | null; note: string } => {
    const same = fields.every((d) => sameValue(val(d), d.run));
    const fixed = fields.every((d) => sameValue(val(d), d.baseline));
    return same ? { reproduced: true, note: "ended with the same wrong values as the failing run" } : fixed ? { reproduced: false, note: "ended with the values of the request-order baseline" } : { reproduced: null, note: `ended with other values: ${fields.map((d) => `${clean(d.name, 40)} = ${q(val(d), 40)}`).join(", ")}` };
  };
  // what the page showed or sent decides; store values only for a finding that has nothing else
  const shownFields = all.filter((d) => d.where !== "state");
  if (shownFields.length) return byValues(shownFields);
  const errors = (ev.errors as string[] | undefined) ?? [];
  if (errors.length) {
    const hit = errors.some((m) => r.errors.some((e) => shape(e.message) === shape(m)));
    return { reproduced: hit, note: hit ? "the same error was thrown again" : "the error did not recur" };
  }
  const shown = new Set(snap.text ?? []);
  const onlyRun = (ev.textOnlyRun as string[] | undefined) ?? [];
  const onlyBase = (ev.textOnlyBaseline as string[] | undefined) ?? [];
  if (onlyRun.length || onlyBase.length) {
    const again = onlyRun.some((l) => shown.has(l));
    const missing = onlyBase.filter((l) => !shown.has(l));
    if (again || (!onlyRun.length && missing.length === onlyBase.length)) return { reproduced: true, note: "the page shows the failing run's text again" };
    if (!missing.length) return { reproduced: false, note: "the page shows the baseline's text" };
    return { reproduced: null, note: `the page shows neither the failing run's text nor all of the baseline's (missing ${q(missing[0], 60)})` };
  }
  if (all.length) return byValues(all);
  const wits = (ev.witnesses as string[] | undefined) ?? [];
  if (wits.length) {
    const have = new Set(r.witnesses.map((w) => `${w.kind} ${pathShape(w.subject)} by ${sigOf(w.by)}`));
    const hit = wits.some((w) => have.has(w));
    return { reproduced: hit, note: hit ? "the older response overwrote newer data again" : "no older response overwrote newer data" };
  }
  return { reproduced: null, note: "nothing comparable was recorded" };
}

/**
 * The schedule that reproduces a finding: an explore race replays its run's seeded schedule; anything recorded in a
 * natural run replays that run's delivery order (read now, so it includes deliveries sent after the finding). Null
 * when the run is gone and the finding has no schedule of its own.
 */
export function replaySpecOf(f: Finding, run: Run | undefined): ScheduleSpec | null {
  const spec: ScheduleSpec | null = f.kind === "race" && f.replay ? { ...f.replay } : run && run.order.length ? { order: "given", given: run.order.slice() } : null;
  if (!spec) return null;
  delete spec.id;
  delete spec.label;
  return spec;
}

/** Append the keys of `next` that are not yet at the end of `prev` (pages resend their newest keys). Linear. */
export function mergeOrder(prev: string[], next: string[]): string[] {
  if (!prev.length) return next.slice(-4000);
  if (!next.length) return prev;
  // keys are unique in a page load ("SIG#n"): find where next's first key sits in prev's tail
  const tail = prev.slice(-next.length);
  const pos = tail.lastIndexOf(next[0]);
  if (pos >= 0) {
    const k = tail.length - pos;
    let ok = k <= next.length;
    for (let i = 0; ok && i < k; i++) if (tail[pos + i] !== next[i]) ok = false;
    if (ok) return prev.concat(next.slice(k)).slice(-4000);
  }
  return prev.concat(next).slice(-4000);
}

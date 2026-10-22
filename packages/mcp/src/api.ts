// The agent API over a Store (docs/runtime/AGENT.md section 4.3): plain JSON in, plain JSON out. The MCP tools call it
// in-process, or over HTTP when another MCP server on this machine already owns the bridge (one bridge, many agent
// sessions), and the prompt hook calls it for its digest. Results carry the recorded data; tools.ts turns them into
// text for the model.

import { regressionTest } from "./testgen.js";
import { replaySpecOf, type Store } from "./store.js";
import { scenarioOf, settledAfterActs } from "./compare.js";
import type { ActStep, Finding, Run } from "./types.js";

export type Api = (m: string, p: unknown) => unknown;

const ACTIVE_MS = 10 * 60_000;

function args(p: unknown): Record<string, unknown> {
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

export function runSummary(r: Run, now: number) {
  return {
    id: r.id,
    route: r.page.route,
    url: r.page.url,
    title: r.page.title,
    started: r.started,
    lastSeen: r.lastSeen,
    active: now - r.lastSeen < ACTIVE_MS && !r.ended,
    schedule: r.schedule ? { order: r.schedule.order, ...(r.schedule.seed !== undefined ? { seed: r.schedule.seed } : {}), ...(r.schedule.label ? { label: r.schedule.label } : {}) } : null,
    assignment: r.assignment,
    runtime: r.runtime,
    actions: r.steps.filter((s) => s.k === "act").length,
    requests: r.steps.filter((s) => s.k === "send").length,
    witnesses: r.witnesses.length,
    errors: r.errors.length,
    detections: r.detections.length,
    settled: settledAfterActs(r),
    forced: r.forced,
  };
}

export function findingSummary(f: Finding) {
  return { id: f.id, kind: f.kind, title: f.title, route: f.route, count: f.count, runs: f.runs.length, first: f.first, last: f.last, replays: f.replays.slice(-3) };
}

export function makeApi(store: Store, info: { url: string; port: number }): Api {
  return (m, p) => {
    const a = args(p);
    const now = store.now();
    switch (m) {
      case "status": {
        const runs = [...store.runs.values()].sort((x, y) => y.lastSeen - x.lastSeen);
        const counts: Record<string, number> = {};
        for (const f of store.findings.values()) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
        const x = store.latestExplore();
        return {
          bridge: info,
          pages: runs.slice(0, 12).map((r) => runSummary(r, now)),
          activePages: runs.filter((r) => now - r.lastSeen < ACTIVE_MS && !r.ended).length,
          totalRuns: runs.length,
          findings: counts,
          explore: x ? { id: x.id, state: x.state, planned: x.plan.length, assigned: x.next, runs: x.runs, route: x.route } : null,
          replays: store.replays.filter((r) => r.remaining > 0).map((r) => ({ finding: r.finding, remaining: r.remaining, route: r.route })),
        };
      }
      case "findings": {
        const sinceMs = typeof a.sinceMinutes === "number" ? a.sinceMinutes * 60_000 : undefined;
        return store.ranked({ ...(typeof a.kind === "string" ? { kind: a.kind } : {}), ...(typeof a.route === "string" ? { route: a.route } : {}), ...(sinceMs ? { sinceMs } : {}), limit: typeof a.limit === "number" ? a.limit : 20 }).map(findingSummary);
      }
      case "finding": {
        const f = store.findings.get(String(a.id ?? ""));
        if (!f) return null;
        const run = f.run ? store.runs.get(f.run) : undefined;
        const replay = replaySpecOf(f, run);
        return {
          finding: f,
          run: run ? { ...runSummary(run, now), steps: run.steps.slice(-160), lost: run.lost, order: run.order.slice(-200), witnesses: run.witnesses.slice(0, 20), errors: run.errors.slice(0, 10), snapshot: run.snapshot, detections: run.detections.slice(-5) } : null,
          scenario: run ? (run.steps.filter((s) => s.k === "act") as ActStep[]) : [],
          replay,
          runGone: !!f.run && !run,
          test: replay ? regressionTest(f, run, replay) : null,
        };
      }
      case "explore.start": {
        const focus = Array.isArray(a.focus) ? a.focus.filter((s): s is string => typeof s === "string") : undefined;
        const d = typeof a.delayMs === "number" && a.delayMs > 0 ? { minMs: 0, maxMs: Math.min(5000, Math.floor(a.delayMs)) } : undefined;
        return store.armExplore({
          ...(typeof a.runs === "number" ? { runs: a.runs } : {}),
          ...(typeof a.route === "string" && a.route ? { route: a.route } : {}),
          ...(focus?.length ? { focus } : {}),
          ...(d ? { delay: d } : {}),
          ...(typeof a.seed === "number" ? { seed: a.seed } : {}),
        });
      }
      case "explore.report": {
        const r = store.reportExplore(typeof a.id === "string" ? a.id : undefined);
        if (!r) return null;
        const runs = r.session.runs.map((id) => store.runs.get(id)).filter((x): x is Run => !!x);
        return { session: r.session, runs: runs.map((x) => ({ ...runSummary(x, now), scenario: scenarioOf(x) })), groups: r.groups, findings: r.findings.map(findingSummary) };
      }
      case "explore.stop":
        return store.stopExplore();
      case "replay.arm":
        return store.armReplay(String(a.id ?? ""), typeof a.times === "number" ? a.times : 1);
      case "replay.result":
        return store.replayResult(String(a.id ?? ""));
      case "analytics":
        return analytics(store, typeof a.route === "string" ? a.route : undefined);
      case "digest":
        return store.since(typeof a.cursor === "number" ? a.cursor : 0, typeof a.epoch === "string" ? a.epoch : undefined);
      case "clear":
        store.clear(a.what === "findings" || a.what === "runs" ? a.what : "all");
        return { ok: true };
      default:
        throw new Error(`unknown method ${m}`);
    }
  };
}

/** What the pages on this machine learned and saw, merged across recent runs (newest first wins per key). */
export function analytics(store: Store, route?: string) {
  const runs = [...store.runs.values()].filter((r) => !route || r.page.route === route).sort((a, b) => b.lastSeen - a.lastSeen);
  const endpoints = new Map<string, { sig: string; count: number; median?: number; p95?: number; errorRate: number; failStreak: number; runs: number }>();
  for (const r of runs)
    for (const b of r.baselines ?? []) {
      const e = endpoints.get(b.sig);
      if (!e) endpoints.set(b.sig, { ...b, runs: 1 });
      else {
        e.runs++;
        e.count += b.count;
      }
    }
  const routes = new Map<string, { route: string; runs: number; requests: number; witnesses: number; errors: number; detections: Record<string, number> }>();
  for (const r of runs) {
    const x = routes.get(r.page.route) ?? { route: r.page.route, runs: 0, requests: 0, witnesses: 0, errors: 0, detections: {} };
    x.runs++;
    x.requests += r.steps.filter((s) => s.k === "send").length;
    x.witnesses += r.witnesses.length;
    x.errors += r.errors.length;
    for (const d of r.detections) x.detections[d.decision.diagnosis ?? "?"] = (x.detections[d.decision.diagnosis ?? "?"] ?? 0) + 1;
    routes.set(r.page.route, x);
  }
  const fields = new Map<string, number>();
  for (const r of runs) for (const w of r.witnesses) if (w.kind === "overwrote-newer") fields.set(w.subject, (fields.get(w.subject) ?? 0) + 1);
  const latestLearned = runs.find((r) => r.learned)?.learned as Record<string, unknown> | undefined;
  return {
    runs: runs.length,
    endpoints: [...endpoints.values()].sort((a, b) => b.count - a.count).slice(0, 60),
    routes: [...routes.values()].sort((a, b) => b.runs - a.runs).slice(0, 40),
    overwrittenFields: [...fields.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([field, n]) => ({ field, n })),
    relations: (latestLearned?.relations as unknown[] | undefined)?.slice(0, 30) ?? [],
    flows: (latestLearned?.flows as unknown[] | undefined)?.slice(0, 20) ?? [],
  };
}

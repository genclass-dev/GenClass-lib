// The bridge between the runtime and the visual checks (docs/runtime/VISUAL.md section 13). It lives in the lazily
// loaded chunk so that first load stays within its 0.5 KB budget: the stub hands it the runtime object, and this is
// the only module of src/visual that touches it. Everything else in the chunk sees only the narrow VisualHost.
//
// What it may do with the runtime, and nothing more:
// - read: the clock, the global, the effective mode, sampling, pause state, the in-flight count and requests (with
//   the learned cadence and latency that make a request long-lived, for request-stalled), the error count;
// - report a finding: the rt.checks() buffer, the "check" event, a kind "check" Report (report: "silent",
//   "interventions" and a function behave as for every other report), and a sink record for sinks whose `kinds`
//   lists "check";
// - write an audit entry of kind "fix";
// - follow status changes (mode, enabled, breaker) and the runtime's teardown.
// It never pushes RtEvents, facts or situations and never touches the gate, the queue or the model (AGENTS.md rule 2
// exception). Some members it reads are private in TypeScript only (cadence, reporter, sinks, fire, pushAudit, auditBase,
// sessionId, sessionTags, sampled, reportMode, _aggr): the RtLike interface below names them, and
// test/visual-bridge.test.ts fails when one of them is renamed.

import type { AuditEntry, CheckFinding, Clock, ModeOrOff, Report, SessionSummary, SinkRecord } from "../types.js";
import type { VisualHost } from "./host.js";
import type { VisualStub } from "./start.js";

/** The parts of RuntimeImpl the bridge uses (some are TypeScript-private there). */
export interface RtLike {
  readonly clock: Clock;
  readonly global: Record<string, unknown>;
  readonly ops: { inFlight: Set<{ id: number; kind: string; name: string; start: number; genclass?: boolean }> };
  readonly base: { latency(sig: string): { p95: number } | undefined };
  readonly isPaused: boolean;
  vis: VisualStub | null;
  effectiveMode(): ModeOrOff;
  summary(): SessionSummary;
  on(type: "status", fn: () => void): () => void;
  addTeardown(fn: () => void): void;
  // TypeScript-private members of RuntimeImpl
  cadence: { get(sig: string, now: number): { kind: string } | undefined };
  sessionId: string;
  sessionTags: Record<string, string | number | boolean>;
  sampled: boolean;
  reportMode: "console" | "interventions" | "silent" | "fn";
  _aggr: number;
  reporter: { emit(r: Report): void; sink: "console" | "silent" | ((r: Report) => void) };
  sinks: { size: number; nextId(): string; push(r: SinkRecord): void };
  fire(type: "check" | "report", v: unknown): void;
  pushAudit(make: () => Omit<AuditEntry, "schema" | "seq">): void;
  auditBase(kind: "fix", mode: ModeOrOff, aggr: number): Omit<AuditEntry, "schema" | "seq">;
}

/** Query and fragment values of URLs in free text -> "…" (as src/runtime.ts redactUrlText does for sink evidence). */
const redactUrlText = (t: string): string => String(t).replace(/([?&#][^=&#\s"]+)=([^&#\s"]*)/g, (_m, k: string) => `${k}=…`);

export function hostFor(rt0: unknown, describe: (el: Element) => string, normalize: (path: string) => string): VisualHost {
  const rt = rt0 as RtLike;
  const g = rt.global as Record<string, unknown> & { location?: { pathname?: string } };
  // A kind "check" report. The runtime's reporter handles "silent" and the app's report function; with the console
  // sink this prints it (the reporter's own console path would fold different findings together and look for a
  // model explanation): a finding as a collapsed group with its measured values, a fix line as one info line.
  const emit = (f: CheckFinding, line: string, important: boolean, quiet: boolean) => {
    const r: Report = { kind: "check", message: line || f.message, check: f, mode: rt.effectiveMode(), session: { id: rt.sessionId, tags: { ...rt.sessionTags } } };
    if (quiet || (rt.reportMode === "interventions" && !important)) return rt.fire("report", r);
    if (rt.reporter.sink !== "console") return rt.reporter.emit(r);
    rt.fire("report", r);
    const con = (globalThis as { console?: Console }).console;
    if (!con) return;
    if (line) return con.info(line);
    con.groupCollapsed(f.message);
    con.log(f.details.join("\n"));
    con.groupEnd();
  };
  return {
    clock: rt.clock,
    global: rt.global,
    seed: rt.sessionId,
    mode: () => rt.effectiveMode(),
    sampled: () => rt.sampled !== false,
    active: () => !rt.isPaused,
    inflight: () => rt.ops.inFlight.size,
    pending: (ms) => {
      const now = rt.clock.now();
      const out = [];
      for (const op of rt.ops.inFlight) {
        if ((op.kind !== "fetch" && op.kind !== "xhr") || op.genclass || rt.cadence.get(op.name, now)?.kind === "periodic" || (rt.base.latency(op.name)?.p95 ?? 0) >= ms) continue;
        out.push({ id: String(op.id), sig: op.name, start: op.start });
      }
      return out;
    },
    errors: () => rt.summary().errors,
    describe,
    // as sink records and telemetry send a route (runtime.ts toSinkRecord): a segment holding an @ (raw or %40) is :id
    route: () => normalize(String(g.location?.pathname ?? "/")).replace(/[^/]*(?:@|%40)[^/]*/gi, ":id").slice(0, 200),
    report: (f, print) => {
      const b = rt.vis?.b;
      if (b) {
        b.push(f);
        if (b.length > 200) b.shift();
      }
      rt.fire("check", f);
      if (rt.sinks.size)
        rt.sinks.push({
          schema: 1,
          kind: "check",
          id: rt.sinks.nextId(),
          ts: rt.clock.now(),
          sessionId: rt.sessionId,
          tags: { ...rt.sessionTags },
          mode: rt.effectiveMode(),
          sampled: rt.sampled,
          check: { kind: f.kind, severity: f.severity, fixed: !!f.fix?.applied },
          ...(f.route ? { route: f.route } : {}),
          evidence: { message: redactUrlText(f.message), target: f.target, selector: f.selector },
        });
      emit(f, "", false, !print);
    },
    note: (m, f, important) => emit(f, m, important, false),
    audit: (fix) => rt.pushAudit(() => ({ ...rt.auditBase("fix", rt.effectiveMode(), rt._aggr), fix: { ...fix } })),
  };
}

/**
 * Follow the runtime: status changes re-check the fix gate, teardown stops the checks, and rt.summary() of this
 * runtime gains its `visual` key once the checks have run (added here, so first load carries no code for it).
 */
export function follow(rt0: unknown, ctl: { gateFixes(): void; stop(): void; summary(): object | null }): void {
  const rt = rt0 as RtLike & { summary: () => SessionSummary };
  rt.on("status", () => ctl.gateFixes());
  rt.addTeardown(() => ctl.stop());
  const base = rt.summary.bind(rt);
  rt.summary = () => Object.assign(base(), ctl.summary());
}

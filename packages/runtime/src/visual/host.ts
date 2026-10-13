// The seam between the first-load stub (src/visual/start.ts), the bridge (src/visual/bridge.ts) and the checks.
// Types only: every side imports it with `import type`, so the chunk shares no module with first load and builds to
// one file.
//
// The engine and the checks see the runtime only through VisualHost: they can read the effective mode, whether the
// runtime is active, the in-flight request count and the error count, and hand over findings, fix lines and fix
// audit entries. They cannot write to the event log, situations, facts, the gate or the model (AGENTS.md rule 2
// exception). Only bridge.ts touches the runtime object, and only to build this host.

import type { AuditEntry, CheckFinding, Clock, ModeOrOff, VisualOptions, VisualSummary } from "../types.js";

export interface VisualHost {
  readonly clock: Clock;
  /** The window-like global the runtime observes. */
  readonly global: Record<string, unknown>;
  /** The session id: visual.sample hashes it (deterministic per session, never Math.random). */
  readonly seed: string;
  /** The effective mode for the page now ("off" while enabled is false or pending). */
  mode(): ModeOrOff;
  /** The session may act (not sampled out by InitOptions.sample). */
  sampled(): boolean;
  /** Not destroyed and not paused. */
  active(): boolean;
  /** Requests in flight that the runtime knows about. */
  inflight(): number;
  /** Errors the runtime reported in this session (read-only, for evidence). */
  errors(): number;
  /** The runtime's element description ('button "Save"'). */
  describe(el: Element): string;
  /** The normalised route (same normalisation as decisions in telemetry). */
  route(): string;
  /**
   * A confirmed finding (kind "check" report, `check` event, sink record). `print`: false past the console line limit
   * of a pass (listeners, sinks and rt.checks() still get it).
   */
  report(f: CheckFinding, print: boolean): void;
  /** A fix line (applied, undone, dropped) printed as a kind "check" report; `important` lines also print in "interventions" mode. */
  note(message: string, f: CheckFinding, important: boolean): void;
  /** An audit entry of kind "fix". */
  audit(fix: NonNullable<AuditEntry["fix"]>): void;
}

/** What the chunk returns to the stub. */
export interface VisualController {
  /** Run a pass now and resolve with the findings it confirmed. */
  now(): Promise<CheckFinding[]>;
  /** rt.summary().visual (null until a pass has run or a finding was made). */
  summary(): { visual: VisualSummary } | null;
  /** Mode, enabled, breaker, pause or resume changed: undo the fixes that are no longer allowed. */
  gateFixes(): void;
  /** Stop everything and undo every fix. */
  stop(): void;
}

/** The chunk module (dist/visual/index.js). */
export interface VisualChunk {
  /**
   * Start the checks for a runtime. The chunk builds the narrow VisualHost itself (src/visual/bridge.ts); the stub
   * passes the runtime's element describer and path normaliser so the chunk shares no module with first load.
   */
  startVisual(rt: unknown, options: VisualOptions, early: Event[], describe: (el: Element) => string, normalize: (path: string) => string): VisualController;
}

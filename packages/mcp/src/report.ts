// Reporting to the app's GenClass dashboard (docs/runtime/AGENT.md section 4.5): off unless the developer sets
// GENCLASS_REPORT. Then the server's own log of the loop is mirrored there, one small event at a time, to
// POST <dashboard origin>/api/projects/<secret>/agent, batched and best effort: each finding the bridge makes, each
// time the agent reads its evidence, each replay armed and each replay verdict, each regression test written, each
// explore report and each clear. Ids, kinds, page paths, verdicts, counts and times only, never a title, an evidence
// line, a snapshot or any page text. A failure is logged once and never thrown; nothing here feeds a decision, a
// finding or a tool result. The dashboard's Closed-loop view draws the stages (found, reproduced, fix proven, closed,
// or round again) and lists the log.
import { dashboardTarget } from "./production.js";
import type { Finding } from "./types.js";

export const REPORT_SCHEMA = "genclass-agent/1";
export const REPORT_FLUSH_MS = 500;
export const REPORT_MAX_BATCH = 50;

/** The event types, in the order they happen in the loop; the dashboard drops any other. */
export type ReportKind = "found" | "explain" | "armed" | "replay" | "test" | "explore" | "cleared";

export interface ReportEvent {
  t: ReportKind;
  /** The finding (every type but `explore` and `cleared`). */
  id?: string;
  kind?: Finding["kind"];
  /** The page path only (no query or fragment), capped; for `explore` the session's route when it had one. */
  route?: string;
  at: number;
  /** `replay`: the verdict. */
  reproduced?: boolean;
  /** `explore`: page loads in the report and race findings it made. */
  runs?: number;
  races?: number;
  /** `cleared`: what the developer cleared on their machine. */
  what?: "all" | "findings" | "runs";
}

export interface Reporter {
  readonly target: { origin: string; secret: string };
  found(f: Finding): void;
  /** The agent read the finding's evidence (genclass_explain). */
  explain(f: Finding): void;
  /** A replay of the finding was armed. */
  armed(f: Finding): void;
  replay(f: Finding, reproduced: boolean | null): void;
  test(f: Finding): void;
  /** An explore session was reported: how many page loads it compared and how many race findings it made. */
  explore(o: { route?: string; runs: number; races: number }): void;
  /** The developer cleared findings, runs or everything on their machine. */
  cleared(what: "all" | "findings" | "runs"): void;
  /** Send what is queued now (tests, and close). */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Where to report, from the environment: GENCLASS_REPORT is a dashboard link or secret, or "on"/"1"/"true" to use
 * GENCLASS_DASHBOARD. Anything else, or nothing, means no reporting. The sample dashboard is never a target.
 */
export function reportTarget(env: Record<string, string | undefined>): { origin: string; secret: string } | null {
  const v = (env.GENCLASS_REPORT ?? "").trim();
  if (!v) return null;
  const t = /^(on|1|true|yes)$/i.test(v) ? dashboardTarget(env.GENCLASS_DASHBOARD) : dashboardTarget(v);
  if (!t || t.secret === "sample") return null;
  return t;
}

/** The route as sent: the page path only (no query or fragment), capped. */
export function reportRoute(route: string): string {
  const r = String(route || "/");
  const q = r.search(/[?#]/);
  const path = (q >= 0 ? r.slice(0, q) : r).slice(0, 200);
  return path.startsWith("/") ? path : "/";
}

export function reportEvent(t: ReportEvent["t"], f: Pick<Finding, "id" | "kind" | "route">, at: number, reproduced?: boolean): ReportEvent {
  return { t, id: f.id, kind: f.kind, route: reportRoute(f.route), at, ...(typeof reproduced === "boolean" ? { reproduced } : {}) };
}

/** The event for an explore report: counts and the session's page path only. */
export function exploreEvent(o: { route?: string; runs: number; races: number }, at: number): ReportEvent {
  const n = (v: number) => Math.max(0, Math.min(1_000_000, Math.floor(Number(v) || 0)));
  return { t: "explore", at, runs: n(o.runs), races: n(o.races), ...(o.route ? { route: reportRoute(o.route) } : {}) };
}

export function createReporter(
  target: { origin: string; secret: string },
  o: { fetch?: typeof fetch; now?: () => number; log?: (s: string) => void; flushMs?: number } = {},
): Reporter {
  const fetchFn = o.fetch ?? fetch;
  const now = o.now ?? (() => Date.now());
  const flushMs = o.flushMs ?? REPORT_FLUSH_MS;
  const url = `${target.origin}/api/projects/${encodeURIComponent(target.secret)}/agent`;
  let queue: ReportEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  let sending: Promise<void> | null = null;
  let warned = false;
  const send = async (events: ReportEvent[]): Promise<void> => {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ schema: REPORT_SCHEMA, events }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok && !warned) {
        warned = true;
        o.log?.(`dashboard report refused (HTTP ${res.status}); reporting continues, check GENCLASS_REPORT`);
      }
    } catch (e) {
      if (!warned) {
        warned = true;
        o.log?.(`dashboard report failed (${(e as Error).message}); reporting continues`);
      }
    }
  };
  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    while (queue.length) {
      const batch = queue.splice(0, REPORT_MAX_BATCH);
      sending = send(batch);
      await sending;
      sending = null;
    }
  };
  const push = (e: ReportEvent) => {
    queue.push(e);
    if (queue.length >= REPORT_MAX_BATCH) void flush();
    else if (!timer) timer = setTimeout(() => void flush(), flushMs).unref();
  };
  return {
    target,
    found: (f) => push(reportEvent("found", f, now())),
    explain: (f) => push(reportEvent("explain", f, now())),
    armed: (f) => push(reportEvent("armed", f, now())),
    replay: (f, reproduced) => {
      if (typeof reproduced === "boolean") push(reportEvent("replay", f, now(), reproduced));
    },
    test: (f) => push(reportEvent("test", f, now())),
    explore: (o) => push(exploreEvent(o, now())),
    cleared: (what) => push({ t: "cleared", at: now(), what: what === "findings" || what === "runs" ? what : "all" }),
    flush,
    close: async () => {
      await flush();
      if (sending) await sending;
    },
  };
}

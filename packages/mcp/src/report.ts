// Reporting to the app's GenClass dashboard (docs/runtime/AGENT.md section 4.5): off unless the developer sets
// GENCLASS_REPORT. Then, for each finding the bridge makes, each replay verdict and each regression test written,
// one small event goes to POST <dashboard origin>/api/projects/<secret>/agent, batched and best effort: ids, kinds,
// routes, verdicts and times only, never a title, an evidence line, a snapshot or any page text. A failure is logged
// once and never thrown; nothing here feeds a decision, a finding or a tool result.
import { dashboardTarget } from "./production.js";
import type { Finding } from "./types.js";

export const REPORT_SCHEMA = "genclass-agent/1";
export const REPORT_FLUSH_MS = 500;
export const REPORT_MAX_BATCH = 50;

export interface ReportEvent {
  t: "found" | "replay" | "test";
  id: string;
  kind: Finding["kind"];
  route: string;
  at: number;
  reproduced?: boolean;
}

export interface Reporter {
  readonly target: { origin: string; secret: string };
  found(f: Finding): void;
  replay(f: Finding, reproduced: boolean | null): void;
  test(f: Finding): void;
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
    replay: (f, reproduced) => {
      if (typeof reproduced === "boolean") push(reportEvent("replay", f, now(), reproduced));
    },
    test: (f) => push(reportEvent("test", f, now())),
    flush,
    close: async () => {
      await flush();
      if (sending) await sending;
    },
  };
}

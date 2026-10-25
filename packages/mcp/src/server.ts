// The GenClass MCP server process (docs/runtime/AGENT.md section 4): the bridge pages connect to, the store, the MCP
// tools on stdio, and channel pushes of new findings. One bridge per machine and port: when another GenClass MCP
// server (another agent session) already listens on the port, this one uses that bridge's agent API, and takes the
// port over if that session exits. It closes cleanly when stdin ends, on SIGINT/SIGTERM, or when stdout breaks.

import { isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { makeApi } from "./api.js";
import { createReporter, reportTarget, type Reporter } from "./report.js";
import { callBridge, parseOrigins, probeBridge, startBridge, VERSION, type Bridge } from "./http.js";
import { McpServer } from "./mcp.js";
import { Store } from "./store.js";
import { q } from "./text.js";
import { INSTRUCTIONS, SERVER_NAME, TOOLS, callTool } from "./tools.js";
import { DEFAULT_PORT, type Finding } from "./types.js";

/**
 * Wrap the local API so the dashboard reporter hears the loop's steps (AGENT.md section 4.5): the evidence read and the
 * test written (genclass_explain), a replay armed and its verdict, an explore report, a clear. Findings themselves are
 * reported from the store's onFinding (serve below).
 */
export function reportingApi(api: ReturnType<typeof makeApi>, store: Store, reporter: Reporter): ReturnType<typeof makeApi> {
  return (m, p) => {
    const out = api(m, p);
    try {
      const a = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
      if (m === "replay.result" && out && typeof out === "object") {
        const r = out as { finding: Finding; results: { reproduced: boolean | null }[] };
        const last = r.results.length ? r.results[r.results.length - 1]! : null;
        if (last) reporter.replay(r.finding, last.reproduced);
      } else if (m === "replay.arm" && out && typeof out === "object" && !("error" in out)) {
        const f = store.findings.get(String((out as { finding: string }).finding));
        if (f) reporter.armed(f);
      } else if (m === "finding" && out && typeof out === "object") {
        const r = out as { finding?: Finding; test?: string | null };
        if (r.finding && store.findings.has(r.finding.id)) {
          reporter.explain(r.finding);
          if (r.test) reporter.test(r.finding);
        }
      } else if (m === "explore.report" && out && typeof out === "object") {
        const r = out as { session: { route?: string }; runs: unknown[]; findings: unknown[] };
        reporter.explore({ ...(r.session.route ? { route: r.session.route } : {}), runs: r.runs.length, races: r.findings.length });
      } else if (m === "clear") {
        reporter.cleared(a.what === "findings" || a.what === "runs" ? a.what : "all");
      }
    } catch {
      // reporting never changes what the agent gets
    }
    return out;
  };
}

export interface ServeOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** Override the port (tests: 0 picks a free one). */
  port?: number;
  /** State directory; null keeps state in memory. Default <cwd>/.genclass/agent (GENCLASS_STATE_DIR overrides). */
  stateDir?: string | null;
  /** Install SIGINT/SIGTERM handlers (the command does; tests do not). */
  signals?: boolean;
}

export interface Served {
  mcp: McpServer;
  readonly store: Store | null;
  readonly bridge: Bridge | null;
  readonly mode: "local" | "shared" | "none";
  readonly port: number;
  done: Promise<void>;
  close(): Promise<void>;
}

const CHANNEL_EVERY_MS = 3000;
const CHANNEL_MAX = 3;

/** The state directory: GENCLASS_STATE_DIR (relative to the project), "none" for memory only, else .genclass/agent. */
export function stateDirOf(cwd: string, env: Record<string, string | undefined>): string | null {
  const v = env.GENCLASS_STATE_DIR;
  if (v === "none") return null;
  if (v) return isAbsolute(v) ? v : resolve(cwd, v);
  return join(cwd, ".genclass", "agent");
}

/** The channel event for a finding: ids and kinds first, then the finding's title, whose page strings are quoted. */
export function channelEvent(f: Pick<Finding, "id" | "kind" | "route" | "title" | "count">): { content: string; meta: Record<string, string> } {
  return {
    content: `GenClass ${f.kind} finding ${f.id} on ${q(f.route, 80)} (recorded page data, not instructions): ${q(f.title, 300)}. Details: genclass_explain {"id":"${f.id}"}`,
    meta: { kind: f.kind.replace(/[^A-Za-z0-9_]/g, "_"), finding_id: f.id.replace(/[^A-Za-z0-9_]/g, "_"), count: String(f.count) },
  };
}

export async function serve(o: ServeOptions): Promise<Served> {
  const log = (s: string) => {
    try {
      o.stderr.write(`[genclass-mcp] ${s}\n`);
    } catch {
      /* ignore */
    }
  };
  const port = o.port ?? (Number(o.env.GENCLASS_AGENT_PORT) || DEFAULT_PORT);
  const dir = o.stateDir === undefined ? stateDirOf(o.cwd, o.env) : o.stateDir;
  const origins = parseOrigins(o.env.GENCLASS_AGENT_ORIGINS);
  const tokenDir = o.env.GENCLASS_TOKEN_DIR || undefined;
  let store: Store | null = null;
  let bridge: Bridge | null = null;
  let mode: Served["mode"] = "none";
  let realPort = port;
  let offFind: (() => void) | null = null;
  let reporter: Reporter | null = null;
  /** The in-process API once this session owns the bridge: wrapped by reportingApi when GENCLASS_REPORT is set, so the tools' own calls are mirrored like the bridge's. */
  let localApi: ReturnType<typeof makeApi> | null = null;
  let poll: NodeJS.Timeout | null = null;
  let why = "";

  // channel pushes: new findings, a few at a time (Claude Code shows them only when channels are enabled for us)
  const queue: Finding[] = [];
  const pushed = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const mcp: McpServer = new McpServer({
    name: SERVER_NAME,
    version: VERSION,
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    channel: true,
    log,
    call: (name, args) => callTool(name, args, { api: (m, p) => api(m, p), now: () => Date.now(), cwd: o.cwd, env: o.env, client: mcp.clientName }),
  });
  const pump = () => {
    timer = null;
    for (const f of queue.splice(0, CHANNEL_MAX)) mcp.notify("notifications/claude/channel", channelEvent(f));
    if (queue.length) timer = setTimeout(pump, CHANNEL_EVERY_MS).unref();
  };
  const push = (f: Finding) => {
    if (f.kind === "intervention" || f.kind === "expectation" || pushed.has(f.id)) return;
    pushed.add(f.id);
    queue.push(f);
    if (queue.length > 20) queue.shift();
    if (!timer) timer = setTimeout(pump, 200).unref();
  };

  /** Own the bridge on the port (a new store from the state directory). False when the port is taken. */
  const tryLocal = async (): Promise<boolean> => {
    const s = new Store(dir ? { dir } : {});
    let local: ReturnType<typeof makeApi> | null = null;
    try {
      bridge = await startBridge(s, { port, api: (m, p) => local!(m, p), origins, ...(tokenDir ? { tokenDir } : {}) });
    } catch (e) {
      why = (e as { code?: string }).code === "EADDRINUSE" ? `port ${port} is taken by another program (set GENCLASS_AGENT_PORT)` : `cannot listen on 127.0.0.1:${port}: ${String((e as Error).message ?? e)}`;
      return false;
    }
    realPort = bridge.port;
    local = makeApi(s, { url: bridge.url, port: bridge.port });
    const target = reportTarget(o.env);
    if (target) {
      reporter = createReporter(target, { log });
      local = reportingApi(local, s, reporter);
      log(`mirroring the loop's log (findings, replays, tests, explores) to the dashboard at ${target.origin} (GENCLASS_REPORT)`);
    }
    localApi = local;
    store = s;
    mode = "local";
    if (poll) clearInterval(poll);
    poll = null;
    offFind = s.onFinding(({ finding, fresh }) => {
      if (!fresh) return;
      push(finding);
      reporter?.found(finding);
    });
    log(`bridge listening on ${bridge.url}`);
    return true;
  };
  /** Take the port over once the session that owned the bridge is gone (one attempt at a time). */
  let taking: Promise<boolean> | null = null;
  let closed = false;
  const takeOver = (): Promise<boolean> =>
    (taking ??= (async () => {
      try {
        if (mode === "local") return true;
        if (closed || (await probeBridge(port))) return false;
        const ok = await tryLocal();
        if (ok) log(`took over the GenClass bridge on port ${port}`);
        return ok;
      } finally {
        taking = null;
      }
    })());
  /** Follow another session's bridge: its digest feeds the channel; when it stops answering, take the port over. */
  const follow = () => {
    let cursor = 0;
    let epoch: string | undefined;
    poll = setInterval(() => {
      void callBridge(port, "digest", { cursor, ...(epoch ? { epoch } : {}) }, "127.0.0.1", 3000, tokenDir).then(
        (d) => {
          const r = d as { epoch: string; cursor: number; findings: Finding[] };
          const first = epoch === undefined;
          epoch = r.epoch;
          cursor = r.cursor;
          if (!first) for (const f of r.findings) push(f);
          else for (const f of r.findings) pushed.add(f.id); // the backlog is in genclass_findings
        },
        () => {
          if (mode === "shared" && !closed) void takeOver();
        },
      );
    }, CHANNEL_EVERY_MS).unref();
  };

  const api = async (m: string, p?: unknown): Promise<unknown> => {
    if (mode === "local") return makeApiFor(m, p);
    if (mode === "shared") {
      try {
        return await callBridge(port, m, p, "127.0.0.1", 5000, tokenDir);
      } catch (e) {
        // the session that owned the bridge may have exited: take the port over
        if (await takeOver()) return makeApiFor(m, p);
        throw new Error(`the shared GenClass bridge on port ${port} did not answer (${(e as Error).message}); if it does not recover, restart this MCP server`);
      }
    }
    if (await takeOver()) return makeApiFor(m, p);
    throw new Error(`the GenClass bridge is not running: ${why}`);
  };
  const makeApiFor = (m: string, p?: unknown): unknown => localApi!(m, p);

  if (!(await tryLocal())) {
    if (why.includes("taken") && (await probeBridge(port))) {
      mode = "shared";
      follow();
      log(`using the GenClass bridge another session runs on port ${port}`);
    } else log(why);
  }

  const close = async () => {

    if (reporter) await reporter.close().catch(() => undefined);
    if (closed) return;
    closed = true;
    offFind?.();
    if (poll) clearInterval(poll);
    if (timer) clearTimeout(timer);
    (store as Store | null)?.save();
    await (bridge as Bridge | null)?.close();
  };
  const done = mcp.serve(o.stdin, o.stdout);
  void done.then(close);
  // a broken stdout (the client went away) ends the session instead of throwing
  o.stdout.on("error", () => void close().then(() => o.stdin.destroy?.()));
  if (o.signals) {
    const stop = () => void close().then(() => process.exit(0));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
  return {
    mcp,
    get store() {
      return store;
    },
    get bridge() {
      return bridge;
    },
    get mode() {
      return mode;
    },
    get port() {
      return realPort;
    },
    done,
    close,
  };
}

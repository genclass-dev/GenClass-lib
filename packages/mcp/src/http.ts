// The bridge's HTTP server (docs/runtime/AGENT.md section 4). Listens on 127.0.0.1 only.
//
//   POST /v1/hello    a page load registers (genclass-agent/1); the reply names its run, its token and its schedule
//   POST /v1/events   a page's batched events (the run's origin and token must match)
//   GET  /v1/health   { ok, name, version } (for a second MCP server that finds the port taken)
//   POST /v1/api      the agent API ({ m, p } → result), used by MCP servers that share this bridge and by the hook
//
// Who may call what (section 6):
//   - every request: the Host header must be the loopback address and port (a DNS-rebinding page cannot pose as it);
//   - page endpoints: a browser Origin on this machine (localhost, *.localhost, 127.x, [::1]), or one listed exactly in
//     GENCLASS_AGENT_ORIGINS (a *.test or LAN dev host). A public site's page, a router's or a captive portal's cannot
//     feed findings to the agent; a request without an Origin (not a browser) is refused too. CORS answers name that
//     origin only.
//   - /v1/api: never a browser (no Origin header), with the header x-genclass-api: 1 (a page cannot send it without a
//     preflight, which this server refuses) and the bridge's token, which only the user who started it can read
//     (~/.genclass/bridge-<port>.token, mode 0600): other users of a shared machine cannot read or change its state.
// Bodies are capped at 1 MB; anything invalid is a 400 without detail.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Store } from "./store.js";
import { DEFAULT_PORT } from "./types.js";

export const MAX_BODY = 1024 * 1024;
export const VERSION = "0.2.0";

/** A page origin on this machine (where a page with connectAgent runs by default), or one the developer allowed. */
export function devOrigin(origin: string | undefined, allow?: ReadonlySet<string>): boolean {
  if (!origin || origin === "null") return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (allow?.has(u.origin)) return true;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // *.localhost resolves to loopback in the browser itself; *.test and the like go through DNS, which a hostile network
  // controls: those need an exact GENCLASS_AGENT_ORIGINS entry
  return host === "localhost" || host === "::1" || host.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** GENCLASS_AGENT_ORIGINS: a comma-separated list of exact origins also allowed ("http://192.168.1.20:5173"). */
export function parseOrigins(v: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const s of (v ?? "").split(",")) {
    try {
      const u = new URL(s.trim());
      if (u.protocol === "http:" || u.protocol === "https:") out.add(u.origin);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Where the bridge's API token lives (one per user and port). */
export function tokenFile(port: number, dir?: string): string {
  return join(dir || process.env.GENCLASS_TOKEN_DIR || join(homedir(), ".genclass"), `bridge-${port}.token`);
}

export interface BridgeOptions {
  port?: number;
  host?: string;
  /** The agent API: method name → handler (the MCP server's backend). */
  api?: (m: string, p: unknown) => unknown;
  /** Exact page origins allowed besides this machine's (GENCLASS_AGENT_ORIGINS). */
  origins?: ReadonlySet<string>;
  /** Directory for the API token file (default ~/.genclass; GENCLASS_TOKEN_DIR). */
  tokenDir?: string;
}

export interface Bridge {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  /** The agent API token (also in tokenFile(port)). */
  readonly token: string;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(text);
}

function read(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    req.on("data", (c: Buffer) => {
      size += c.length;
      // over the cap: keep nothing more, read to the end and answer 413; a client far past it is cut off
      if (size > 4 * MAX_BODY) {
        finish(null);
        req.destroy();
      } else if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => finish(size > MAX_BODY ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(null));
  });
}

/** Start the bridge. Rejects with the listen error (EADDRINUSE: another bridge may own the port). */
export function startBridge(store: Store, o: BridgeOptions = {}): Promise<Bridge> {
  const host = o.host ?? "127.0.0.1";
  const want = o.port ?? DEFAULT_PORT;
  let port = want;
  const token = randomBytes(24).toString("hex");
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        send(res, 500, { ok: false });
      } catch {
        /* closed */
      }
    });
  });
  // slow clients cannot hold sockets open
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin;
    if (!allowedHosts().has(String(req.headers.host ?? "").toLowerCase())) return send(res, 421, { ok: false, error: "wrong host" });
    const page = url.pathname === "/v1/hello" || url.pathname === "/v1/events";
    if (page) {
      if (!devOrigin(origin, o.origins)) return send(res, 403, { ok: false, error: "pages on this machine only (GENCLASS_AGENT_ORIGINS allows others)" });
      const cors: Record<string, string> = { "access-control-allow-origin": origin!, vary: "Origin" };
      if (req.method === "OPTIONS") {
        const pna: Record<string, string> = req.headers["access-control-request-private-network"] === "true" ? { "access-control-allow-private-network": "true" } : {};
        return send(res, 204, undefined, { ...cors, ...pna, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
      }
      if (req.method !== "POST") return send(res, 405, { ok: false }, cors);
      const raw = await read(req);
      if (raw === null) return send(res, 413, { ok: false }, cors);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { ok: false }, cors);
      }
      if (url.pathname === "/v1/hello") {
        const r = store.hello(body, origin);
        return r ? send(res, 200, { run: r.run, token: r.token, schedule: r.schedule }, cors) : send(res, 400, { ok: false }, cors);
      }
      return send(res, 200, { ok: true, applied: store.events(body, origin) }, cors);
    }
    // everything else is for local processes, never for browsers
    if (origin !== undefined) return send(res, 403, { ok: false, error: "not for browsers" });
    if (url.pathname === "/v1/health" && req.method === "GET") return send(res, 200, { ok: true, name: "genclass-mcp-bridge", version: VERSION });
    if (url.pathname === "/v1/api" && req.method === "POST") {
      if (req.headers["x-genclass-api"] !== "1" || req.headers["x-genclass-token"] !== token || !o.api) return send(res, 403, { ok: false, error: "forbidden" });
      const raw = await read(req);
      if (raw === null) return send(res, 413, { ok: false });
      try {
        const { m, p } = JSON.parse(raw) as { m: string; p: unknown };
        if (typeof m !== "string") return send(res, 400, { ok: false });
        return send(res, 200, { ok: true, result: await o.api(m, p) });
      } catch (e) {
        return send(res, 400, { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "bad request" });
      }
    }
    return send(res, 404, { ok: false });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(want, host, () => {
      server.off("error", reject);
      const a = server.address();
      port = typeof a === "object" && a ? a.port : want;
      const file = tokenFile(port, o.tokenDir);
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        try {
          unlinkSync(file); // never write through a link someone left there
        } catch {
          /* none */
        }
        writeFileSync(file, token, { flag: "wx", mode: 0o600 });
      } catch {
        /* the API then works only in this process */
      }
      resolve({
        server,
        port,
        url: `http://${host}:${port}`,
        token,
        close: () =>
          new Promise<void>((r) => {
            try {
              if (readFileSync(file, "utf8") === token) unlinkSync(file);
            } catch {
              /* gone */
            }
            server.close(() => r());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** Is a GenClass bridge already listening on this port? (Another MCP server for the same machine.) */
export async function probeBridge(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    const r = await fetch(`http://${host}:${port}/v1/health`, { signal: AbortSignal.timeout(800) });
    const j = (await r.json()) as { name?: string };
    return r.ok && j.name === "genclass-mcp-bridge";
  } catch {
    return false;
  }
}

/** Call another bridge's agent API (its token comes from the bridge's token file, readable by this user only). */
export async function callBridge(port: number, m: string, p: unknown, host = "127.0.0.1", timeoutMs = 5000, tokenDir?: string): Promise<unknown> {
  let token = "";
  try {
    token = readFileSync(tokenFile(port, tokenDir), "utf8").trim();
  } catch {
    throw new Error(`cannot read the bridge's token (${tokenFile(port, tokenDir)}): is the GenClass MCP server running as this user?`);
  }
  const r = await fetch(`http://${host}:${port}/v1/api`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-genclass-api": "1", "x-genclass-token": token },
    body: JSON.stringify({ m, p }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await r.json()) as { ok?: boolean; result?: unknown; error?: string };
  if (!r.ok || !j.ok) throw new Error(j.error ?? `bridge answered ${r.status}`);
  return j.result;
}

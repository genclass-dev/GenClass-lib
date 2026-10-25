// The page's link to the local GenClass MCP bridge (packages/mcp, docs/runtime/AGENT.md section 4). Development only:
// it talks to a loopback address on the developer's machine, never to a public host, and sends nothing anywhere else.
// The runtime's fetch observer ignores the bridge's URL (connectAgent registers it), so GenClass never records,
// holds or decides about its own link. Never throws into the page; a bridge that is not running costs one failed
// request at hello and nothing after.

import type { Clock } from "../types.js";

export const AGENT_SCHEMA = "genclass-agent/1";
export const DEFAULT_AGENT_URL = "http://127.0.0.1:47357";
const FLUSH_MS = 250;
const MAX_BATCH = 80;
const MAX_QUEUE = 2000;

type FetchFn = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Loopback hosts the bridge may listen on: the link refuses any other URL. */
export function isLoopbackUrl(u: string): boolean {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (url.protocol === "http:" || url.protocol === "https:") && (h === "127.0.0.1" || h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h));
  } catch {
    return false;
  }
}

/**
 * A page served from the developer's own machine, where connectAgent runs by default: localhost, *.localhost, 127.x
 * and ::1 (names the browser itself resolves to loopback). Pages on *.test, *.local or *.internal names and private
 * networks need `anyHost` (and an exact GENCLASS_AGENT_ORIGINS entry on the bridge): their names go through DNS, which
 * a hostile network controls, and they may be someone else's machine. The bridge accepts the same origins
 * (packages/mcp/src/http.ts devOrigin).
 */
export function isDevHost(hostname: unknown): boolean {
  if (typeof hostname !== "string" || !hostname) return false;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export interface HelloReply {
  run: string;
  /** Sent back with every batch: the bridge accepts a run's events only from the page that registered it. */
  token?: string;
  schedule?: unknown;
  settleMs?: number;
}

export class Link {
  private queue: Record<string, unknown>[] = [];
  private timer: unknown = null;
  private seq = 0;
  run: string | null = null;
  private token: string | null = null;
  /** A hello reply that came after the timeout (the page already fell back); the run id is still taken. */
  onLate: ((r: HelloReply) => void) | null = null;
  failures = 0;
  dead = false;
  sent = 0;

  constructor(
    readonly url: string,
    private readonly fetchFn: FetchFn | undefined,
    private readonly clock: Clock,
    private readonly beacon?: (url: string, body: string) => boolean,
  ) {}

  /** POST /v1/hello: register this page load; the reply may carry the schedule the agent asked for. */
  hello(body: Record<string, unknown>, timeoutMs: number): Promise<HelloReply | null> {
    const f = this.fetchFn;
    if (!f) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: HelloReply | null) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      this.clock.setTimeout(() => finish(null), timeoutMs);
      try {
        f(`${this.url}/v1/hello`, this.init(JSON.stringify({ schema: AGENT_SCHEMA, ...body })))
          .then((r) => (r.ok ? r.json() : null))
          .then(
            (j) => {
              const o = j as HelloReply | null;
              if (o && typeof o.run === "string" && o.run.length <= 64) {
                this.run = o.run;
                if (typeof o.token === "string" && o.token.length <= 128) this.token = o.token;
                if (done) {
                  try {
                    this.onLate?.(o);
                  } catch {
                    /* ignore */
                  }
                } else finish(o);
              } else finish(null);
            },
            () => {
              this.failures++;
              this.dead = true;
              finish(null);
            },
          );
      } catch {
        this.dead = true;
        finish(null);
      }
    });
  }

  send(ev: Record<string, unknown>): void {
    if (this.dead) return;
    this.queue.push(ev);
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (this.timer === null)
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.flush(false);
      }, FLUSH_MS);
  }

  /** Send what is queued. `exit`: the page is going away (sendBeacon). */
  flush(exit: boolean): void {
    if (this.dead || !this.run) return;
    while (this.queue.length) {
      const batch = this.queue.splice(0, MAX_BATCH);
      const body = JSON.stringify({ schema: AGENT_SCHEMA, run: this.run, ...(this.token ? { token: this.token } : {}), seq: this.seq++, events: batch });
      this.sent += batch.length;
      if (exit && this.beacon) {
        try {
          if (this.beacon(`${this.url}/v1/events`, body)) continue;
        } catch {
          /* fall back to fetch */
        }
      }
      try {
        this.fetchFn?.(`${this.url}/v1/events`, { ...this.init(body), keepalive: exit }).then(
          (r) => {
            if (!r.ok) this.failures++;
          },
          () => {
            if (++this.failures >= 5) this.dead = true;
          },
        );
      } catch {
        this.dead = true;
      }
    }
  }

  private init(body: string): Record<string, unknown> {
    // text/plain: a CORS simple request (no preflight); the bridge answers only loopback and local-host origins
    return { method: "POST", body, headers: { "content-type": "text/plain;charset=UTF-8" }, credentials: "omit", mode: "cors", cache: "no-store", referrerPolicy: "no-referrer" };
  }
}

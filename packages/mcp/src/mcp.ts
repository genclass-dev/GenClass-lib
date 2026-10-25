// A minimal MCP server over stdio (JSON-RPC 2.0, one message per line), without dependencies: initialize (with
// instructions and the experimental claude/channel capability), ping, tools/list, tools/call, and empty resources
// and prompts lists. Notifications from the server (channel events) go out on the same stream. stdout carries
// protocol messages only; diagnostics go to stderr.

import type { Readable, Writable } from "node:stream";

/** Protocol revisions this server speaks, newest first; it answers with the client's when listed, else the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpServerOptions {
  name: string;
  version: string;
  instructions: string;
  tools: McpTool[];
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
  /** Declare the experimental claude/channel capability (Claude Code channels). */
  channel?: boolean;
  log?: (s: string) => void;
}

type Msg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export class McpServer {
  initialized = false;
  clientName: string | null = null;
  private buf = "";
  private out: Writable | null = null;

  constructor(private readonly o: McpServerOptions) {}

  /** Serve on these streams until `input` ends. */
  serve(input: Readable, output: Writable): Promise<void> {
    this.out = output;
    input.setEncoding("utf8");
    return new Promise((resolve) => {
      input.on("data", (chunk: string) => {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line) void this.onLine(line);
        }
        if (this.buf.length > 8 * 1024 * 1024) this.buf = "";
      });
      input.on("end", () => resolve());
      input.on("close", () => resolve());
    });
  }

  /** Send a notification (no id). Dropped before the client initialized. */
  notify(method: string, params: Record<string, unknown>): boolean {
    if (!this.initialized || !this.out) return false;
    this.write({ jsonrpc: "2.0", method, params });
    return true;
  }

  private write(m: unknown): void {
    try {
      this.out?.write(`${JSON.stringify(m)}\n`);
    } catch (e) {
      this.o.log?.(`write failed: ${String(e)}`);
    }
  }

  /** Handle one line: a message or a batch (answered as one array; notifications get no answer). */
  async onLine(line: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.write(err(null, -32700, "parse error"));
    }
    if (Array.isArray(msg)) {
      if (!msg.length) return this.write(err(null, -32600, "empty batch"));
      const out: unknown[] = [];
      for (const m of msg) {
        const r = await this.respond(m as Msg);
        if (r) out.push(r);
      }
      if (out.length) this.write(out);
      return;
    }
    const r = await this.respond(msg as Msg);
    if (r) this.write(r);
  }

  /** Handle one message and write its answer, if it has one. */
  async handle(m: Msg): Promise<void> {
    const r = await this.respond(m);
    if (r) this.write(r);
  }

  /** The answer to one message, or null for a notification (or a response to us). */
  private async respond(m: Msg): Promise<Record<string, unknown> | null> {
    if (!m || typeof m !== "object" || typeof m.method !== "string") {
      if (m && typeof m === "object" && m.id !== undefined && m.method === undefined) return null; // a response to something we sent: none expected
      return err(m && typeof m === "object" ? m.id ?? null : null, -32600, "invalid request");
    }
    const isRequest = m.id !== undefined && m.id !== null;
    const ok = (result: unknown) => (isRequest ? { jsonrpc: "2.0", id: m.id, result } : null);
    const fail = (code: number, message: string) => (isRequest ? err(m.id ?? null, code, message) : null);
    try {
      switch (m.method) {
        case "initialize": {
          const asked = String(m.params?.protocolVersion ?? "");
          const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
          const ci = m.params?.clientInfo as { name?: string } | undefined;
          this.clientName = typeof ci?.name === "string" ? ci.name.slice(0, 80) : null;
          const capabilities: Record<string, unknown> = { tools: { listChanged: false } };
          if (this.o.channel) capabilities.experimental = { "claude/channel": {} };
          return ok({ protocolVersion: version, capabilities, serverInfo: { name: this.o.name, version: this.o.version }, instructions: this.o.instructions });
        }
        case "notifications/initialized":
          this.initialized = true;
          return null;
        case "ping":
          return ok({});
        case "tools/list":
          return ok({ tools: this.o.tools });
        case "tools/call": {
          const name = String(m.params?.name ?? "");
          const args = (m.params?.arguments && typeof m.params.arguments === "object" ? m.params.arguments : {}) as Record<string, unknown>;
          if (!this.o.tools.some((t) => t.name === name)) return fail(-32602, `unknown tool ${name.slice(0, 60)}`);
          try {
            const r = await this.o.call(name, args);
            return ok({ content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
          } catch (e) {
            return ok({ content: [{ type: "text", text: `GenClass: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
          }
        }
        case "resources/list":
          return ok({ resources: [] });
        case "resources/templates/list":
          return ok({ resourceTemplates: [] });
        case "prompts/list":
          return ok({ prompts: [] });
        case "logging/setLevel":
          return ok({});
        default:
          if (m.method.startsWith("notifications/")) return null;
          return fail(-32601, `method not found: ${m.method.slice(0, 60)}`);
      }
    } catch (e) {
      return fail(-32603, e instanceof Error ? e.message : "internal error");
    }
  }
}

function err(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

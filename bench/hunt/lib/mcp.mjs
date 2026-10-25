// The GenClass MCP server in this process, driven the way an agent drives it: JSON-RPC over two PassThrough streams,
// `tools/call` for the text an agent reads (kept verbatim in the report as evidence), and the same store's agent API
// for the structured form of the same answers (`makeApi`), so the report's counts and the tool text never disagree.
// The bridge listens on a free loopback port; state stays in memory (nothing is written to .genclass/).

import { PassThrough } from "node:stream";

const RPC_TIMEOUT_MS = 30_000;

/** Start the server from a built @genclass/mcp module (its dist/index.js). */
export async function startMcp(mod, o) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map();
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const cb = m && m.id !== undefined ? pending.get(m.id) : undefined;
      if (cb) {
        pending.delete(m.id);
        cb(m);
      }
    }
  });
  const served = await mod.serve({ cwd: o.cwd, env: { ...(o.env ?? {}) }, stdin: input, stdout: output, stderr: o.stderr, port: o.port ?? 0, stateDir: null });
  if (served.mode !== "local" || !served.store || !served.bridge) {
    await served.close();
    throw new Error(`the GenClass bridge did not start in this process (mode ${served.mode}); with --port, is the port free?`);
  }
  let id = 0;
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const my = ++id;
      const t = setTimeout(() => {
        pending.delete(my);
        reject(new Error(`no reply to ${method} within ${RPC_TIMEOUT_MS} ms`));
      }, RPC_TIMEOUT_MS);
      pending.set(my, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "genclass-hunt", version: "0.1.0" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const api = mod.makeApi(served.store, { url: served.bridge.url, port: served.port });
  return {
    url: served.bridge.url,
    port: served.port,
    /** One tool call; the text the agent would read. A tool error is returned as text with `isError`. */
    async tool(name, args = {}) {
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.error) throw new Error(`${name}: ${r.error.message ?? JSON.stringify(r.error)}`);
      const text = r.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
      return { text, isError: !!r.result?.isError };
    },
    /** The in-process store itself (read-only use: every finding, without a tool's list limit). */
    store: served.store,
    /** The structured agent API of the same store (what the tools render). */
    api: (m, p) => Promise.resolve(api(m, p)),
    async close() {
      input.end();
      await served.close();
    },
  };
}

// A minimal MCP client over stdio, the way a coding agent's client talks to `npx -y @genclass/mcp`: newline-delimited
// JSON-RPC, `initialize`, then `tools/call`. Used by the walkthrough to call the real server process.
import { spawn } from "node:child_process";

export function startMcp({ cwd, env, command = "npx", args = ["-y", "@genclass/mcp@0.1.0"], log = () => {} }) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let id = 0;
  let buf = "";
  const stderr = [];
  child.stderr.on("data", (c) => {
    const s = String(c);
    stderr.push(s);
    log(s.trim());
  });
  child.stdout.on("data", (c) => {
    buf += String(c);
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const me = ++id;
      pending.set(me, { resolve, reject });
      send({ jsonrpc: "2.0", id: me, method, params });
      setTimeout(() => {
        if (pending.has(me)) {
          pending.delete(me);
          reject(new Error(`${method}: no answer in 120 s`));
        }
      }, 120_000).unref();
    });
  return {
    child,
    stderr,
    async init(clientName = "walkthrough") {
      const r = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return r;
    },
    /** The tool names the server offers. */
    async list() {
      const r = await request("tools/list", {});
      return (r.tools || []).map((t) => t.name);
    },
    /** Call a tool; returns its first text block (and whether it is an error). */
    async call(name, args = {}) {
      const r = await request("tools/call", { name, arguments: args });
      const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return { text, isError: !!r.isError, structured: r.structuredContent };
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => {
        child.once("exit", r);
        setTimeout(() => {
          child.kill();
          r();
        }, 5000).unref();
      });
    },
  };
}

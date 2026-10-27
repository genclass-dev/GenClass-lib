#!/usr/bin/env node
// Renders Claude Code's `--output-format stream-json --verbose` events as a readable terminal transcript: the
// assistant's text, each tool call (one line, the command or file), and tool results trimmed. Also tees the raw
// events to the file named by PRETTY_LOG, so an orchestrator can read what happened.
import { appendFileSync } from "node:fs";

const log = process.env.PRETTY_LOG;
const C = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", magenta: "\x1b[35m", reset: "\x1b[0m" };
const out = (s) => process.stdout.write(s + "\n");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    if (log) appendFileSync(log, line + "\n");
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    render(e);
  }
});
function render(e) {
  if (e.type === "assistant" && e.message?.content) {
    for (const part of e.message.content) {
      if (part.type === "text" && part.text.trim()) out(`\n${C.bold}${part.text.trim()}${C.reset}`);
      if (part.type === "tool_use") out(`${C.cyan}▸ ${part.name}${C.reset} ${C.dim}${clip(toolLine(part), 150)}${C.reset}`);
    }
  } else if (e.type === "user" && e.message?.content) {
    for (const part of e.message.content) {
      if (part.type === "tool_result") {
        const text = typeof part.content === "string" ? part.content : Array.isArray(part.content) ? part.content.map((x) => x.text ?? "").join("\n") : "";
        const first = text.split("\n").filter((l) => l.trim()).slice(0, 4).map((l) => clip(l, 140));
        if (first.length) out(`${C.dim}  ${first.join("\n  ")}${C.reset}`);
      }
    }
  } else if (e.type === "result") {
    out(`\n${C.green}✓ done${C.reset} ${C.dim}${e.duration_ms ? Math.round(e.duration_ms / 1000) + " s" : ""}${e.total_cost_usd ? ` · $${e.total_cost_usd.toFixed(2)}` : ""}${C.reset}`);
  }
}
function toolLine(part) {
  const i = part.input ?? {};
  if (part.name === "Bash") return i.command ?? "";
  if (part.name === "Edit" || part.name === "Write" || part.name === "Read") return i.file_path ?? "";
  if (part.name.startsWith("mcp__")) return JSON.stringify(i);
  return JSON.stringify(i);
}

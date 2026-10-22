#!/usr/bin/env node
// genclass-mcp: the GenClass MCP server and its helper commands (see src/cli.ts).
import { runCli } from "../dist/cli.js";

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`[genclass-mcp] ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);

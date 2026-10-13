#!/usr/bin/env node
// genclass-playwright-report: renders genclass-report.md from test-results/genclass/*.json (see src/cli.ts).
import { runCli } from "../dist/cli.js";

process.exitCode = runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
});

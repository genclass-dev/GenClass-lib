#!/usr/bin/env bash
# Reproduce the evidence in docs/evidence/closed-loop-dashboard/README.md, from the repository root:
#   bash docs/evidence/closed-loop-dashboard/run.sh
# Needs: npm ci done (Node 20+), Playwright's Chromium (npx playwright install chromium) and, for the GIF, ffmpeg.
set -euo pipefail
cd "$(dirname "$0")/../../.."
D=docs/evidence/closed-loop-dashboard
{
  echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(git rev-parse --short HEAD)"
  echo; echo "## 1. Collector: the agent report route, storage, stages, log, migration 0011, retention; the page's Fig. 3 and Table 15"
  (cd telemetry-worker && npx vitest run test/agent.test.ts test/pages.test.ts -t "agent|closed loop" --reporter=verbose 2>&1 | grep -E "✓|×|Tests |Test Files")
  echo; echo "## 2. MCP server: the reporter and the API wrapper"
  (cd packages/mcp && npx vitest run test/report.test.ts test/mcp.test.ts --reporter=verbose 2>&1 | grep -E "✓|×|Tests |Test Files")
  echo; echo "## 3. End to end: MCP store -> reporter -> collector handle() -> SQLite schema -> stats -> rendered page"
  npx vite-node "$D/loop.e2e.ts" 2>&1 | grep -v -e ExperimentalWarning -e trace-warnings
  echo; echo "## 4. Recording"
  node "$D/record.mjs"
} | tee "$D/run.log"

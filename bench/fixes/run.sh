#!/usr/bin/env bash
# The fix bench end to end, from a fresh clone: installs what is missing, builds @genclass/runtime from this
# repository, builds the strategy pages, fetches the default model from the npm registry, runs every strategy,
# profile, seed and GenClass condition in headless Chromium, and writes results/raw/, results/summary.json and
# RESULTS.md. Arguments go to run.mjs (for example: --conditions off --seeds 20).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

cd "$ROOT"
if [ ! -d node_modules ]; then
  ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
fi
npm run build -w @genclass/runtime

cd "$HERE"
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund
fi
# Chromium for Playwright 1.63, unless the machine provides browsers (PLAYWRIGHT_BROWSERS_PATH)
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  npx playwright install chromium
fi

node run.mjs "$@"

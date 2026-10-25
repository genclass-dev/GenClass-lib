#!/usr/bin/env bash
# Reproduce docs/evidence/e2e-walkthrough/README.md from the repository root:
#   bash docs/evidence/e2e-walkthrough/run.sh
# Needs: Node 20+, npm, Playwright's Chromium (npx playwright install chromium), the network (npm, jsDelivr and
# genclass.dev: the published @genclass/runtime@beta and @genclass/mcp are used, and a real dashboard is created),
# and ffmpeg for the GIF. Ports 5173, 8788 and 47400 must be free.
set -euo pipefail
cd "$(dirname "$0")/../../.."
D=docs/evidence/e2e-walkthrough
(cd $D/app && npm install --no-audit --no-fund >/dev/null)
mkdir -p $D/out && node $D/walkthrough.mjs 2>&1 | tee $D/run.log
if command -v ffmpeg >/dev/null && [ -f $D/out/walkthrough.webm ]; then
  ffmpeg -y -loglevel error -i $D/out/walkthrough.webm -vf "fps=3,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=48[p];[s1][p]paletteuse=dither=none" $D/out/walkthrough.gif
fi

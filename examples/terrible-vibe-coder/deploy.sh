#!/bin/bash
# Deploys The Terrible Vibe Coder to Cloudflare (worker.js, wrangler.toml). GenClass is served from the same origin:
# pass the built runtime's dist/ (npm run build -w @genclass/runtime) and it is copied into public/genclass/.
#
#   examples/terrible-vibe-coder/deploy.sh [path/to/packages/runtime/dist]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dist="${1:-$here/../../packages/runtime/dist}"
[ -f "$dist/genclass.global.min.js" ] || { echo "no built runtime in $dist (npm run build -w @genclass/runtime)" >&2; exit 2; }
rm -rf "$here/public/genclass"
mkdir -p "$here/public/genclass"
# the script tag and what it loads on demand; no type declarations or source maps
(cd "$dist" && find . -type f ! -name '*.d.ts' ! -name '*.d.cts' ! -name '*.map' -print0 | xargs -0 -I{} rsync -R {} "$here/public/genclass/")
cd "$here" && npx --yes wrangler@4 deploy

#!/bin/sh
# Runs the regression test in Payload's own e2e suite (test/fields), as done for docs/adoption/hunts/payload.md
# section 7. Needs Node 22.23.4 and pnpm 11.28.6 (Payload's .tool-versions) on PATH, and about 6 GB of disk.
#   PAYLOAD_DIR   a Payload checkout at v3.92.0 (git clone --branch v3.92.0 https://github.com/payloadcms/payload)
#   PATCH         docs/adoption/hunts/payload.patch (v3.92.0) or payload-main.patch (main at aebbf75)
set -e
here="$(cd "$(dirname "$0")" && pwd)"
cd "$PAYLOAD_DIR"
pnpm install --frozen-lockfile
NODE_OPTIONS="--max-old-space-size=6144" pnpm run build:core --concurrency=2   # tsc runs out of the default 2 GB heap
cp "$here/playwright.local.config.ts" test/                                    # one worker; CHROMIUM_PATH: a Chromium to use
# MongoDB, as test/docker-compose.yml provides it: a single-node replica set on 27018 (mongodb-memory-server)
node "$here/mongo-replset.mjs" & mongo=$!
export PORT=3100 MONGODB_URL="mongodb://127.0.0.1:27018/payload?replicaSet=rs0&directConnection=true"
pnpm dev fields & dev=$!
until curl -s -o /dev/null --max-time 300 "http://localhost:3100/api/users?limit=1"; do sleep 5; done
t() { node_modules/.bin/playwright test test/fields/collections/Relationship/e2e.spec.ts -c test/playwright.local.config.ts --workers=1 --retries=0 --repeat-each=3 --grep "should not request related documents again" || true; }
git apply --include='test/*' "$PATCH"; echo "== unfixed (expected: 3 failed)"; t
git apply --exclude='test/*' "$PATCH"; echo "== fixed (expected: 3 passed)"; t
kill $dev $mongo

#!/bin/sh
# every scenario at 300, 600 and 900 ms of extra latency: a warm-up load, 2 baselines + 6 seeded loads, the report
cd "$(dirname "$0")"
for sc in search filtersort relsearch autosave autosave2 dblpublish dblsave dbldraft; do
  for slow in 300 600 900; do
    echo "===== $sc $slow $(date -u +%H:%M:%S)"
    timeout 1500 node hunt.mjs explore "$sc" "$slow" 6 2>&1 | grep -v "^\[genclass-mcp\]"
  done
done
echo "===== sweep done $(date -u +%H:%M:%S)"

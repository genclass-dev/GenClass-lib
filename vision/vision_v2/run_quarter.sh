#!/bin/bash
# run_quarter.sh SLOT NAME [train.py args...] : one training run pinned to one slot of an 80-vCPU node, detached,
# logged to ~/vision-out/vision-v2/logs/NAME.log, output in ~/vision-out/vision-v2/models/NAME.
# SLOTS (default 4) splits the node: 4 slots of 20 vCPUs (19 threads) or 8 slots of 10 vCPUs (9 threads); the last
# vCPU of a slot is left to the data loader. (Vision v1 measured one process across both NUMA nodes with 78 threads at
# 3 to 5x slower than a quarter.)
set -e
S="$1"; NAME="$2"; shift 2
SLOTS="${SLOTS:-4}"
W=$((80 / SLOTS)); TH=$((W - 1))
C0=$((S * W)); C1=$((C0 + W - 1))
L="$HOME/vision-out/vision-v2/logs"
mkdir -p "$L"
export OMP_NUM_THREADS=$TH
cd "$HOME/vv2-code"
setsid nohup taskset -c "$C0-$C1" "$HOME/vv1-venv/bin/python" train.py --threads "$TH" --bf16 \
  --out "$HOME/vision-out/vision-v2/models/$NAME" "$@" > "$L/$NAME.log" 2>&1 < /dev/null &
echo "started $NAME pid $! on cpus $C0-$C1 with $TH threads"

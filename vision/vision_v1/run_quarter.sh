#!/bin/bash
# run_quarter.sh Q NAME [train.py args...] : one training run pinned to quarter Q (0..3) of an 80-vCPU node,
# 19 threads, detached, logged to ~/vision-out/vision-v1/logs/NAME.log, output in ~/vision-out/vision-v1/models/NAME.
# (One process across both NUMA nodes with 78 threads ran 3 to 5x slower than this.)
set -e
Q="$1"; NAME="$2"; shift 2
C0=$((Q * 20)); C1=$((C0 + 18))
export OMP_NUM_THREADS=19
exec bash "$HOME/vv1-code/bg.sh" "$NAME" taskset -c "$C0-$C1" "$HOME/vv1-venv/bin/python" train.py --threads 19 --bf16 \
  --out "$HOME/vision-out/vision-v1/models/$NAME" "$@"

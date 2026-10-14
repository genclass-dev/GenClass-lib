#!/bin/bash
# run_half.sh H NAME [train.py args...] : one training run pinned to NUMA node H (0 or 1) of an 80-vCPU node,
# 38 threads, detached, logged to ~/vision-out/vision-v1/logs/NAME.log (VV1_INPUT passes through for other sizes).
set -e
H="$1"; NAME="$2"; shift 2
C0=$((H * 40)); C1=$((C0 + 37))
export OMP_NUM_THREADS=38
exec bash "$HOME/vv1-code/bg.sh" "$NAME" taskset -c "$C0-$C1" "$HOME/vv1-venv/bin/python" train.py --threads 38 --bf16 \
  --out "$HOME/vision-out/vision-v1/models/$NAME" "$@"

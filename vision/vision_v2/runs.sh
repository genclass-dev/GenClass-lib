#!/bin/bash
# runs.sh : the Vision v2 training runs, eight at once on one 80-vCPU node (10 vCPUs, 9 threads each), 12 epochs each.
#   L*  : OpenAI labels only (verdict and family heads both taught by OpenAI)
#   A*  : OpenAI + Clef averaged (family head taught by the mean of OpenAI's and Clef's family answers)
#   AH* : as A, plus an any-problem head taught by the mean of OpenAI's notFine and Clef's anyProblem
#   5 / 3: head learning rate 5e-3 (backbone 2e-3, Vision v1's chosen run) or 3e-3 (backbone 1.2e-3); s2: seed 2
set -e
cd "$HOME/vv2-code"
export SLOTS=8
E="--epochs 12"
bash run_quarter.sh 0 L5   --fam-target luna $E --lr 5e-3 --lr-backbone 2e-3
bash run_quarter.sh 1 A5   --fam-target avg  $E --lr 5e-3 --lr-backbone 2e-3
bash run_quarter.sh 2 AH5  --fam-target avg --any-head $E --lr 5e-3 --lr-backbone 2e-3
bash run_quarter.sh 3 L3   --fam-target luna $E --lr 3e-3 --lr-backbone 1.2e-3
bash run_quarter.sh 4 A3   --fam-target avg  $E --lr 3e-3 --lr-backbone 1.2e-3
bash run_quarter.sh 5 AH3  --fam-target avg --any-head $E --lr 3e-3 --lr-backbone 1.2e-3
bash run_quarter.sh 6 L5s2 --fam-target luna $E --lr 5e-3 --lr-backbone 2e-3 --seed 2
bash run_quarter.sh 7 A5s2 --fam-target avg  $E --lr 5e-3 --lr-backbone 2e-3 --seed 2

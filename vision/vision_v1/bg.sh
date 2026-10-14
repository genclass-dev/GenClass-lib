#!/bin/bash
# bg.sh NAME CMD... : run a command detached on the node (own session, no tty), log to ~/vision-out/vision-v1/logs/NAME.log
set -e
name="$1"; shift
L="$HOME/vision-out/vision-v1/logs"
mkdir -p "$L"
export CLEF_EVAL_URL="https://genclass-clef-eval.mehar-144.workers.dev" CLEF_EVAL_KEY_FILE="$HOME/.vv1-eval-key"
cd "$HOME/vv1-code"
setsid nohup "$@" > "$L/$name.log" 2>&1 < /dev/null &
echo "started $name pid $!"

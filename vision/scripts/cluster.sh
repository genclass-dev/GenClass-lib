#!/bin/bash
# Mac-side helper for vision/ on cluster nodes (ssh and rsync only; never runs browsers or crawls locally).
#   vision/scripts/cluster.sh sync   "c20 c21"            # rsync vision/ and research/visual/ to ~/gcl/ on each node
#   vision/scripts/cluster.sh setup  "c20 c21"            # run scripts/node_setup.sh detached (log ~/vision-setup.log)
#   vision/scripts/cluster.sh exec   "c20 c21" 'cmd'      # run a command in ~/gcl/vision on each node
#   vision/scripts/cluster.sh crawl  "c20 c21" [args]     # start crawl.mjs detached, shard i/N on the i-th host
#   vision/scripts/cluster.sh status "c20 c21"            # setup log tail, running vision jobs, output sizes
# Hosts come from ~/.jev-local/azure_hosts; the key from AZURE_SSH_KEY (default ~/.ssh/jev_azure). Every ssh is
# wrapped in timeout. Written for bash: zsh mangles user@$IP:dir/ destinations (history modifiers).
set -euo pipefail
MODE="${1:?mode}"; HOSTS="${2:?hosts}"; shift 2 || true
KEY="${AZURE_SSH_KEY:-$HOME/.ssh/jev_azure}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSH_OPTS="-i $KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6"
ip_of() { awk -v h="$1" '$1==h {print $2}' "$HOME/.jev-local/azure_hosts"; }
N=$(echo $HOSTS | wc -w | tr -d ' ')
I=0
for H in $HOSTS; do
  IP="$(ip_of "$H")"; [ -n "$IP" ] || { echo "unknown host $H" >&2; exit 2; }
  case "$MODE" in
    sync)
      timeout 60 ssh $SSH_OPTS "azureuser@${IP}" 'mkdir -p ~/gcl/research/visual ~/gcl/vision'
      timeout 300 rsync -az --delete -e "ssh $SSH_OPTS" --exclude node_modules --exclude '.DS_Store' --exclude 'out/' \
        "$ROOT/vision/" "azureuser@${IP}:gcl/vision/"
      timeout 120 rsync -az -e "ssh $SSH_OPTS" "$ROOT/research/visual/" "azureuser@${IP}:gcl/research/visual/"
      echo "$H synced: $(timeout 30 ssh $SSH_OPTS "azureuser@${IP}" 'ls ~/gcl/vision | tr "\n" " "')" ;;
    setup)
      timeout 60 ssh $SSH_OPTS "azureuser@${IP}" 'nohup bash ~/gcl/vision/scripts/node_setup.sh > ~/vision-setup.log 2>&1 < /dev/null & echo "$(hostname) setup started"' ;;
    exec)
      timeout "${VISION_EXEC_TIMEOUT:-540}" ssh $SSH_OPTS "azureuser@${IP}" "export PATH=\$HOME/node/bin:\$PATH; cd ~/gcl/vision && $*" ;;
    crawl)
      # each host takes the URLs whose shard byte is I modulo N; a rerun resumes from done-*.jsonl
      timeout 60 ssh $SSH_OPTS "azureuser@${IP}" "export PATH=\$HOME/node/bin:\$PATH; cd ~/gcl/vision && mkdir -p ~/vision-out/crawl && nohup node src/crawl.mjs --shard $I/$N $* > ~/vision-out/crawl/shard-$I.log 2>&1 < /dev/null & echo \"\$(hostname): crawl shard $I/$N started\"" ;;
    status)
      timeout 60 ssh $SSH_OPTS "azureuser@${IP}" 'echo "== $(hostname)"; tail -2 ~/vision-setup.log 2>/dev/null; pgrep -fa "[n]ode src/(discover|crawl)" | cut -c1-160; tail -1 ~/vision-out/crawl/shard-*.log 2>/dev/null; du -shL ~/vision-out 2>/dev/null; uptime; cat ~/.gcl-claim/owner 2>/dev/null' ;;
    *) echo "unknown mode $MODE" >&2; exit 2 ;;
  esac
  I=$((I + 1))
done

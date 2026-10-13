#!/bin/bash
# Set up an Ubuntu cluster node for vision/ (runs ON the node, idempotent): Node 22 in ~/node, vision's npm deps
# (playwright only), Playwright's headless Chromium and the system libraries it needs, and an output directory on
# the largest local disk. Never run this on the Mac.
#   bash ~/gcl/vision/scripts/node_setup.sh
set -euo pipefail
NODE_V=v22.22.0
VISION="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -x "$HOME/node/bin/node" ] || ! "$HOME/node/bin/node" -v | grep -q '^v22\.'; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_V/SHASUMS256.txt"
  want="$(awk -v f="node-$NODE_V-linux-x64.tar.xz" '$2==f {print $1}' "$tmp/SHASUMS256.txt")"
  have="$(sha256sum "$tmp/node.tar.xz" | awk '{print $1}')"
  [ -n "$want" ] && [ "$want" = "$have" ] || { echo "node tarball checksum mismatch" >&2; exit 1; }
  tar -xJf "$tmp/node.tar.xz" -C "$tmp"
  rm -rf "$HOME/node" && mv "$tmp/node-$NODE_V-linux-x64" "$HOME/node" && rm -rf "$tmp"
fi
export PATH="$HOME/node/bin:$PATH"
grep -q 'HOME/node/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/node/bin:$PATH"' >> "$HOME/.profile"
cd "$VISION"
# vision/ keeps its own lockfile (it is not a root workspace); the first install on a node generates it
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --ignore-scripts --loglevel=error
else
  npm install --no-audit --no-fund --ignore-scripts --loglevel=error
fi
if true; then  # no-op when the matching revision is already installed
  npx playwright install --only-shell chromium
fi
shell_bin="$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-*/headless_shell \
  "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-*/chrome-headless-shell 2>/dev/null | head -1 || true)"
if [ -z "$shell_bin" ] || ldd "$shell_bin" 2>/dev/null | grep -q "not found"; then
  sudo -n env PATH="$PATH" npx playwright install-deps chromium >/dev/null
fi
# fonts so pages render text realistically (no-op when present)
if ! (fc-list 2>/dev/null || true) | grep -qi 'dejavu\|liberation\|noto'; then
  sudo -n apt-get install -y -q fonts-liberation fonts-noto-core fonts-noto-color-emoji >/dev/null 2>&1 || true
fi
# outputs live in ~/vision-out, outside the synced tree (an rsync --delete of vision/ never touches them); when a
# separate local temp disk is mounted at /mnt with 100 GB free, ~/vision-out is a link to /mnt/vision-out
if [ ! -e "$HOME/vision-out" ]; then
  if mountpoint -q /mnt 2>/dev/null && [ "$(df -BG --output=avail /mnt | tail -1 | tr -dc 0-9)" -gt 100 ]; then
    sudo -n mkdir -p /mnt/vision-out && sudo -n chown "$(id -u):$(id -g)" /mnt/vision-out
    ln -s /mnt/vision-out "$HOME/vision-out"
  else
    mkdir -p "$HOME/vision-out"
  fi
fi
out="$HOME/vision-out"
node -e 'require("playwright")' 2>/dev/null || node --input-type=module -e 'await import("playwright")'
echo "setup ok on $(hostname): node $(node -v), $(nproc) vCPU, $(free -g | awk '/Mem/ {print $2}') GB RAM, out=$out ($(df -h --output=avail "$out" | tail -1 | tr -d ' ') free)"

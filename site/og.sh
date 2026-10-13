#!/bin/sh
# Renders src/og.svg to public/og.png (1200x630, the social card) with macOS QuickLook, no extra tools.
# qlmanage rasterises a square SVG at 1:1 into a 1200x1200 PNG; the card sits in its middle 630 rows, so sips crops it.
# Bump the ?v= on og.png in build.py after regenerating, and keep the headline equal to HEADLINE in build.py.
set -eu
cd "$(dirname "$0")"
tmp=$(mktemp -d)
qlmanage -t -s 1200 -o "$tmp" src/og.svg >/dev/null 2>&1
sips -c 630 1200 "$tmp/og.svg.png" --out public/og.png >/dev/null
rm -rf "$tmp"
sips -g pixelWidth -g pixelHeight public/og.png | tail -2

#!/usr/bin/env bash
# Render the LiquidGlassAd composition.
#   ./render.sh <props.json> <output.mp4> [extra remotion flags, e.g. --frames=0-359]
# The video named by "videoSrc" in the props must be inside public/.
set -euo pipefail
cd "$(dirname "$0")"

if [ $# -lt 2 ]; then
  echo "usage: $0 <props.json> <output.mp4> [extra remotion render flags]" >&2
  exit 1
fi
PROPS="$(realpath "$1")"
OUT="$(realpath -m "$2")"
shift 2

[ -d node_modules ] || npm ci

BROWSER_FLAG=()
BROWSER="${REMOTION_BROWSER:-/opt/pw-browsers/chromium}"
if [ -n "$BROWSER" ] && [ -x "$BROWSER" ]; then
  BROWSER_FLAG=(--browser-executable="$BROWSER" --chrome-mode=chrome-for-testing)
fi

mkdir -p "$(dirname "$OUT")"
npx remotion render src/index.ts "${COMP:-LiquidGlassAd}" "$OUT" \
  --props="$PROPS" \
  --codec=h264 --crf=16 --pixel-format=yuv420p \
  --image-format=jpeg --jpeg-quality=95 \
  "${BROWSER_FLAG[@]}" "$@"
echo "rendered: $OUT"

#!/usr/bin/env bash
# Usage: scripts/faq-videos.sh <folder with the downloaded faq-*.mp4 files>
# Transcodes the FAQ answer videos used on the site (see src/content/faq-videos.ts) to 720p web MP4s
# with a poster frame in public/assets/media/faq/, then lists them in faq-videos-ready.ts so they show.
set -euo pipefail
SRC="${1:?folder with the downloaded faq-*.mp4 files}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/assets/media/faq"
mkdir -p "$OUT"
IDS=$(grep -o "id: 'faq-[a-z0-9-]*'" "$ROOT/src/content/faq-videos.ts" | sed "s/id: '//; s/'//")
READY=()
for id in $IDS; do
  in=$(ls "$SRC"/"$id"*.mp4 2>/dev/null | head -1 || true)
  if [ -z "$in" ]; then echo "skip $id (no file like $id*.mp4)"; continue; fi
  ffmpeg -loglevel error -y -i "$in" -vf "scale=-2:720" -c:v libx264 -preset slow -crf 25 -profile:v high -pix_fmt yuv420p \
    -c:a aac -b:a 96k -ac 2 -movflags +faststart "$OUT/$id.mp4"
  ffmpeg -loglevel error -y -ss 6 -i "$in" -frames:v 1 -vf "scale=-2:720" -q:v 4 "$OUT/$id.jpg"
  size=$(du -k "$OUT/$id.mp4" | cut -f1)
  if [ "$size" -gt 24000 ]; then echo "$id is ${size}KB, over the 25MB asset limit"; exit 1; fi
  echo "ok $id (${size}KB)"; READY+=("'$id'")
done
LIST=$(IFS=,; echo "${READY[*]:-}" | sed 's/,/, /g')
printf '%s\n' "// Written by scripts/faq-videos.sh: ids whose video and poster are in public/assets/media/faq/." "export const FAQ_READY: string[] = [${LIST}];" > "$ROOT/src/content/faq-videos-ready.ts"
cat "$ROOT/src/content/faq-videos-ready.ts"

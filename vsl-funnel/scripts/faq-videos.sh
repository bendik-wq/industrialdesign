#!/usr/bin/env bash
# Usage: scripts/faq-videos.sh <folder with the downloaded faq-*.mp4 files>
# Transcodes the FAQ answer videos used on the site (see src/content/faq-videos.ts) to 720p HLS
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
  # HLS: the site's static hosting doesn't answer byte-range requests, which iPhones need for a plain MP4.
  rm -rf "$OUT/$id" && mkdir -p "$OUT/$id"
  ffmpeg -loglevel error -y -i "$in" -vf "scale=-2:720" -c:v libx264 -preset slow -crf 25 -profile:v high -pix_fmt yuv420p \
    -g 48 -keyint_min 48 -sc_threshold 0 -c:a aac -b:a 96k -ac 2 \
    -f hls -hls_time 6 -hls_playlist_type vod -hls_segment_filename "$OUT/$id/%03d.ts" "$OUT/$id/index.m3u8"
  ffmpeg -loglevel error -y -ss 6 -i "$in" -frames:v 1 -vf "scale=-2:720" -q:v 4 "$OUT/$id.jpg"
  size=$(du -sk "$OUT/$id" | cut -f1)
  echo "ok $id (${size}KB)"; READY+=("'$id'")
done
LIST=$(IFS=,; echo "${READY[*]:-}" | sed 's/,/, /g')
printf '%s\n' "// Written by scripts/faq-videos.sh: ids whose video and poster are in public/assets/media/faq/." "export const FAQ_READY: string[] = [${LIST}];" > "$ROOT/src/content/faq-videos-ready.ts"
cat "$ROOT/src/content/faq-videos-ready.ts"

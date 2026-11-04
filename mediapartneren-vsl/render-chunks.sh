#!/bin/bash
# Renders the VSL in 300-frame chunks (resumable), then joins them into out/vsl.mp4.
set -e
cd "$(dirname "$0")"
mkdir -p out/chunks
TOTAL=$(npx remotion compositions src/index.ts --quiet 2>/dev/null | awk '/VSL/{print $4}')
TOTAL=${TOTAL:-4335}
STEP=300
i=0
for ((s=0; s<TOTAL; s+=STEP)); do
  e=$((s+STEP-1)); [ $e -ge $TOTAL ] && e=$((TOTAL-1))
  f=$(printf 'out/chunks/c%03d.mp4' $i)
  if [ ! -s "$f" ]; then
    npx remotion render src/index.ts VSL "$f.tmp.mp4" --frames=$s-$e --log=error
    mv "$f.tmp.mp4" "$f"
    echo "chunk $i ($s-$e) done $(date +%T)"
  fi
  i=$((i+1))
done
ls out/chunks/c*.mp4 | sed "s|out/chunks/|file '|;s|$|'|" > out/chunks/list.txt
npx remotion ffmpeg -y -f concat -safe 0 -i out/chunks/list.txt -c copy -movflags +faststart out/vsl.mp4 -loglevel error
[ -s out/poster.jpg ] || npx remotion still src/index.ts VSL out/poster.jpg --frame=250 --image-format=jpeg --log=error
ls -la out/vsl.mp4

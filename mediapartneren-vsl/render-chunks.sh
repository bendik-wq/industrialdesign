#!/bin/bash
# Renders the VSL in 300-frame chunks (resumable), then joins them.
# Usage: ./render-chunks.sh            -> out/vsl.mp4 (Midnight)
#        ./render-chunks.sh blue       -> out/vsl-blue.mp4 (Deep Blue)
set -e
THEME=${1:-midnight}
SUF=$([ "$THEME" = midnight ] && echo '' || echo "-$THEME")
PROPS="{\"theme\":\"$THEME\"}"
CH=out/chunks$SUF
cd "$(dirname "$0")"
mkdir -p $CH
TOTAL=$(npx remotion compositions src/index.ts --quiet 2>/dev/null | awk '/VSL/{print $4}')
TOTAL=${TOTAL:-4335}
STEP=300
i=0
for ((s=0; s<TOTAL; s+=STEP)); do
  e=$((s+STEP-1)); [ $e -ge $TOTAL ] && e=$((TOTAL-1))
  f=$(printf "$CH/c%03d.mp4" $i)
  if [ ! -s "$f" ]; then
    npx remotion render src/index.ts VSL "$f.tmp.mp4" --frames=$s-$e --props="$PROPS" --log=error
    mv "$f.tmp.mp4" "$f"
    echo "chunk $i ($s-$e) done $(date +%T)"
  fi
  i=$((i+1))
done
ls $CH/c*.mp4 | sed "s|$CH/|file '|;s|\$|'|" > $CH/list.txt
npx remotion ffmpeg -y -f concat -safe 0 -i $CH/list.txt -c copy -movflags +faststart out/vsl$SUF.mp4 -loglevel error
[ -s out/poster$SUF.jpg ] || npx remotion still src/index.ts VSL out/poster$SUF.jpg --frame=250 --props="$PROPS" --image-format=jpeg --log=error
ls -la out/vsl$SUF.mp4

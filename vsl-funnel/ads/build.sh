#!/usr/bin/env bash
# Build one ad end to end.
#   ./build.sh a1_one_in_one                    # score only (no narration)
#   FISH_API_KEY=... ./build.sh a1_one_in_one <fish_voice_id>   # with British narrator
# Output: out/<ad>.mp4 (master, 1080x1920) and out/web/<ad>.mp4 (720p preview).
set -euo pipefail
cd "$(dirname "$0")"
AD=$1; VOICE=${2:-}
SCRIPT=scripts/$AD.py
mkdir -p out/web out/music
if [[ -n "$VOICE" ]]; then
  python3 render/vo.py "$SCRIPT" "$VOICE" "out/vo/$AD"
  SCRIPT=out/vo/$AD/timed_script.py
fi
python3 render/render.py "$SCRIPT" "out/$AD.video.mp4"
python3 render/score.py "$SCRIPT" "out/music/$AD.wav"
if [[ -n "$VOICE" ]]; then
  # music ducks under the narrator (sidechain), narrator sits on top with a touch of room
  ffmpeg -v error -y -i "out/$AD.video.mp4" -i "out/music/$AD.wav" -i "out/vo/$AD/vo.wav" -filter_complex \
    "[2:a]aresample=48000,highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,aecho=0.8:0.5:40:0.12,volume=1.6,asplit[v1][v2];\
     [1:a][v1]sidechaincompress=threshold=0.04:ratio=6:attack=40:release=450[m];\
     [m][v2]amix=inputs=2:normalize=0,alimiter=limit=0.89[a]" \
    -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "out/$AD.mp4"
else
  ffmpeg -v error -y -i "out/$AD.video.mp4" -i "out/music/$AD.wav" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "out/$AD.mp4"
fi
rm -f "out/$AD.video.mp4"
ffmpeg -v error -y -i "out/$AD.mp4" -vf scale=720:-2 -c:v libx264 -preset slow -b:v 1150k -maxrate 1400k -bufsize 4M -pix_fmt yuv420p -c:a copy -movflags +faststart "out/web/$AD.mp4"
echo "built out/$AD.mp4"

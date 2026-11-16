#!/usr/bin/env bash
# Build one ad end to end: narration -> video -> music bed + impacts -> ducked mix -> web preview.
#   TREG_TOKEN=... ./build.sh a1_one_in_one [fish_voice_id] [lyria_track.mp3]
# Voice defaults to the deep British narrator; the music bed defaults to out/music/lyria_v1.mp3
# (make a new one with: TREG_TOKEN=... python3 render/lyria.py gen out/music/lyria_vN.mp3).
# Output: out/<ad>.mp4 (master 1080x1920, -14 LUFS) and out/web/<ad>.mp4 (720p preview).
set -euo pipefail
cd "$(dirname "$0")"
AD=$1; VOICE=${2:-d33bd87d47a04c2eada3c5438047e32d}; SONG=${3:-out/music/lyria_v1.mp3}
mkdir -p out/web out/music
python3 render/vo.py "scripts/$AD.py" "$VOICE" "out/vo/$AD"
TS=out/vo/$AD/timed_script.py
python3 render/render.py "$TS" "out/$AD.video.mp4"
python3 render/lyria.py fit "$SONG" "$TS" "out/music/${AD}_lyria.wav"
HITS_ONLY=1 python3 render/score.py "$TS" "out/music/${AD}_hits.wav"
# Balance tuned by measurement: narrator ~12 dB over the music while speaking; music swells in the gaps.
ffmpeg -v error -y -i "out/$AD.video.mp4" -i "out/music/${AD}_lyria.wav" -i "out/music/${AD}_hits.wav" -i "out/vo/$AD/vo.wav" -filter_complex \
  "[1:a]volume=0.24[bed];[2:a]volume=0.28[hit];[bed][hit]amix=inputs=2:normalize=0[mus];\
   [3:a]aresample=48000,highpass=f=70,equalizer=f=180:t=q:w=1:g=2,equalizer=f=3500:t=q:w=1.2:g=2,acompressor=threshold=-22dB:ratio=3:attack=5:release=120,aecho=0.8:0.4:35:0.08,volume=1.5,asplit[v1][v2];\
   [mus][v1]sidechaincompress=threshold=0.015:ratio=10:attack=25:release=450:makeup=1[duck];\
   [duck][v2]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -ar 48000 -shortest -movflags +faststart "out/$AD.mp4"
rm -f "out/$AD.video.mp4"
ffmpeg -v error -y -i "out/$AD.mp4" -vf scale=720:-2 -c:v libx264 -preset slow -b:v 950k -maxrate 1300k -bufsize 3M -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart "out/web/$AD.mp4"
echo "built out/$AD.mp4"

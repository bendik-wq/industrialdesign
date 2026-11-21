"""Edit the physio back-pain piece: VO-timed cuts, push-ins, xfades, pop captions, ducked music, end card."""
import json, re, subprocess, os
D = os.environ.get('PHYSIO_DIR', os.path.dirname(os.path.abspath(__file__)) + '/../out/vidlab/physio/').rstrip('/') + '/'
W, H, FPS, XF = 1080, 1920, 30, 0.3

def sh(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode: raise SystemExit(r.stderr[-3000:])
    return r.stderr + r.stdout

def dur(f):
    return float(subprocess.check_output(f'ffprobe -v error -show_entries format=duration -of csv=p=0 "{f}"', shell=True))

script = json.load(open(D + '../scripts.json'))['physio']
sents = [s.strip() for s in re.split(r'(?<=[.?!])\s+', script.replace('\n\n', ' ')) if s.strip()]

# --- VO: tighten pauses (sentence gaps -> 0.3s, inner gaps -> 0.18s), speed 1.06x, keep sentence bounds
TEMPO = 1.06
src_d = dur(D + 'vo.wav')
log = sh(f'ffmpeg -i "{D}vo.wav" -af silencedetect=noise=-38dB:d=0.12 -f null -')
starts = [float(x) for x in re.findall(r'silence_start: ([\d.]+)', log)]
ends = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', log)] + [src_d]
sil = list(zip(starts, ends[:len(starts)]))
lead = sil.pop(0)[1] if sil and sil[0][0] < 0.05 else 0.0
tail = sil.pop()[0] if sil and sil[-1][1] >= src_d - 0.05 else src_d
sent_gaps = set(sorted(range(len(sil)), key=lambda i: sil[i][1] - sil[i][0], reverse=True)[:len(sents) - 1])
speech, t, keep = [], lead, []
for i, (s, e) in enumerate(sil):
    speech.append((t, s)); keep.append(min(e - s, 0.22)); t = e
speech.append((t, tail)); keep.append(0)
fl, labels, cuts, pos = [], [], [], 0.0
for k, ((a, b), g) in enumerate(zip(speech, keep)):
    fl.append(f'[0:a]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=mono[s{k}]'); labels.append(f'[s{k}]')
    pos += b - a
    if g:
        fl.append(f'aevalsrc=0:d={g:.3f}:s=48000:c=mono[g{k}]'); labels.append(f'[g{k}]')
        if (k) in sent_gaps: cuts.append((pos + g / 2) / TEMPO)
        pos += g
fl.append(f'{"".join(labels)}concat=n={len(labels)}:v=0:a=1,atempo={TEMPO},highpass=f=70[out]')
open(D + 'vo_fc.txt', 'w').write(';'.join(fl))
sh(f'ffmpeg -y -i "{D}vo.wav" -filter_complex_script "{D}vo_fc.txt" -map "[out]" -ar 48000 -ac 1 "{D}vo_t.wav"')
VD = dur(D + 'vo_t.wav')
# word timing: spread syllables over voiced time only, then snap sentence ends to real pauses
log2 = sh(f'ffmpeg -i "{D}vo_t.wav" -af silencedetect=noise=-38dB:d=0.1 -f null -')
s2 = [float(x) for x in re.findall(r'silence_start: ([\d.]+)', log2)]
e2 = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', log2)]
pauses = [(a, b) for a, b in zip(s2, e2) if b - a < 5]
voiced, t = [], 0.0
for a, b in pauses:
    if a > t: voiced.append((t, a))
    t = b
if t < VD: voiced.append((t, VD))
VT = sum(b - a for a, b in voiced)
def at_voiced(x):  # x seconds of voiced time -> timeline
    for a, b in voiced:
        if x <= b - a: return a + x
        x -= b - a
    return VD
def syl(w):
    w = re.sub(r'[^a-z]', '', w.lower().replace('-', ' ')) or 'a'
    n = len(re.findall(r'[aeiouy]+', w)) - (1 if w.endswith('e') and not w.endswith('le') else 0)
    return max(1, n)
words = [(si, w) for si, s in enumerate(sents) for w in s.split()]
wsyl = [syl(w) for _, w in words]; TS = sum(wsyl)
wstart, acc = [], 0
for n in wsyl:
    wstart.append(at_voiced(VT * acc / TS)); acc += n
wstart.append(VD)
mids = [(a + b) / 2 for a, b in pauses]
cuts = []
for si in range(len(sents) - 1):
    k = max(i for i, (s_, _) in enumerate(words) if s_ == si) + 1
    p = wstart[k]
    near = min(mids, key=lambda m: abs(m - p)) if mids else p
    cuts.append(near if abs(near - p) < 0.8 else p)
bounds = [0.0] + cuts + [VD]
WORDS, WSTART = words, wstart
print('VO', round(VD, 2), 's;', len(sents), 'sentences')

# --- shot plan: sentence index -> clip
plan = ['s2_desk', 's1_hook', 's3_flexor', 's4_glutes', 's4_glutes', 's1_hook', 's1_hook', 's5_stretch', 's5_stretch',
        's5_stretch', 's6_bridge', 's6_bridge', 's7_walk', 's7_walk', 's2_desk', 's2_desk', 's8_cta', 's8_cta']
plan = (plan + ['s8_cta'] * 99)[:len(sents)]
END_CARD = 2.2
segs = []
for i, clip in enumerate(plan):
    a, b = bounds[i], bounds[i + 1]
    if segs and segs[-1]['clip'] == clip: segs[-1]['b'] = b
    else: segs.append({'clip': clip, 'a': a, 'b': b})
segs[-1]['b'] += END_CARD
used = {}
trans = {'s3_flexor': 'zoomin', 's4_glutes': 'fadeblack', 's5_stretch': 'smoothleft', 's6_bridge': 'smoothleft',
         's7_walk': 'wipeleft', 's8_cta': 'fade'}
parts = []
for k, s in enumerate(segs):
    L = s['b'] - s['a'] + (XF if k < len(segs) - 1 else 0)
    src = D + s['clip'] + '.mp4'; cd = dur(src)
    off = used.get(s['clip'], {'s5_stretch': 3.5, 's6_bridge': 4.0}.get(s['clip'], 0.3))
    if off + L > cd: off = max(0, cd - L)
    used[s['clip']] = off + L
    zin = k % 2 == 0
    z = "'min(1.0+0.0009*on,1.12)'" if zin else "'max(1.12-0.0009*on,1.0)'"
    out = f'{D}seg{k:02d}.mp4'
    speed = 1.0 if L <= cd else cd / L  # slow down if a clip is short
    sh(f'ffmpeg -y -ss {off:.3f} -i "{src}" -t {L / speed:.3f} -an -vf "setpts=PTS/{speed},'
       f'scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},'
       f'zoompan=z={z}:x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=1:s={W}x{H}:fps={FPS},'
       f'eq=contrast=1.05:saturation=1.08,format=yuv420p" -t {L:.3f} -c:v libx264 -preset veryfast -crf 17 "{out}"')
    parts.append((out, L, trans.get(s['clip'], 'fade')))

# --- chain xfades
inputs = ' '.join(f'-i "{p}"' for p, _, _ in parts)
fc, last, t = [], '[0:v]', 0.0
for k in range(1, len(parts)):
    t += parts[k - 1][1] - XF
    fc.append(f'{last}[{k}:v]xfade=transition={parts[k][2]}:duration={XF}:offset={t:.3f}[v{k}]')
    last = f'[v{k}]'
sh(f'ffmpeg -y {inputs} -filter_complex "{";".join(fc)}" -map "{last}" -c:v libx264 -preset veryfast -crf 17 "{D}cut.mp4"')

# --- captions (ASS): 3-word pop-on chunks, keywords in yellow
KEY = re.compile(r"(lower back|hip flexors?|glutes?|pelvis|overworked|three|thirty seconds|ten slow reps|forty-five minutes|two weeks|down your leg|numbness|assessed|assessment)", re.I)
def ts(x):
    h = int(x // 3600); m = int(x % 3600 // 60); s = x % 60
    return f'{h}:{m:02d}:{s:05.2f}'
ev = []
for si in range(len(sents)):
    idx = [i for i, (s_, _) in enumerate(WORDS) if s_ == si]
    for j in range(0, len(idx), 3):
        ch = idx[j:j + 3]
        t0 = max(WSTART[ch[0]], bounds[si]); t1 = WSTART[ch[-1] + 1] if j + 3 < len(idx) else bounds[si + 1]
        c = ' '.join(WORDS[i][1] for i in ch)
        txt = KEY.sub(lambda m: r'{\c&H4DD8FF&}' + m.group(0) + r'{\c&HFFFFFF&}', c.upper())
        ev.append(f'Dialogue: 0,{ts(t0)},{ts(max(t1, t0 + 0.2))},Cap,,0,0,0,,{{\\fscx82\\fscy82\\t(0,90,\\fscx100\\fscy100)}}{txt}')
# end card + disclaimer
E0 = VD
ev.append(f'Dialogue: 1,{ts(E0)},{ts(E0 + END_CARD + 0.1)},Card,,0,0,0,,{{\\fad(200,0)}}BOOK AN ASSESSMENT')
ev.append(f'Dialogue: 1,{ts(E0)},{ts(E0 + END_CARD + 0.1)},Sub,,0,0,0,,{{\\fad(200,0)}}Link below  ·  Physio-led plan for your back')
ev.append(f'Dialogue: 1,{ts(0)},{ts(E0 + END_CARD + 0.1)},Disc,,0,0,0,,AI-generated · General information, not medical advice')
ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Inter ExtraBold,84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,7,3,2,80,80,640,1
Style: Card,Inter ExtraBold,104,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,8,4,5,60,60,0,1
Style: Sub,Inter,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,4,2,5,60,60,-170,1
Style: Disc,Inter,34,&H00E0E0E0,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,8,40,40,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" + '\n'.join(ev) + '\n'
open(D + 'caps.ass', 'w').write(ass)
# fix the Sub style's vertical offset (ASS has no negative margin): place via \pos
ass = ass.replace('{\\fad(200,0)}Link', f'{{\\fad(200,0)\\pos({W // 2},{H // 2 + 150})}}Link')
open(D + 'caps.ass', 'w').write(ass)

# --- audio: VO + ducked music, loudnorm
total = dur(D + 'cut.mp4')
sh(f'ffmpeg -y -i "{D}vo_t.wav" -stream_loop -1 -i "{D}music.mp3" -filter_complex '
   f'"[0:a]apad=whole_dur={total:.3f},asplit=2[vo][sc];'
   f'[1:a]atrim=0:{total:.3f},volume=0.22,afade=t=out:st={total - 1.5:.3f}:d=1.5[m];'
   f'[m][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=350[md];'
   f'[vo]volume=1.0[v2];[v2][md]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=9[a]" '
   f'-map "[a]" -ar 48000 "{D}mix.wav"')

# --- final: darken under end card, burn captions, mux
sh(f'ffmpeg -y -i "{D}cut.mp4" -i "{D}mix.wav" -vf "eq=brightness=-0.35:enable=\'gte(t,{E0:.2f})\',ass={D}caps.ass" '
   f'-map 0:v -map 1:a -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart "{D}../physio_backpain_final.mp4"')
print('done', round(total, 1), 's')

"""Recut the VidLab Animation Ad: trim dead air, word-timed gold captions, ducked music, end card."""
import json, re, subprocess, os
D = os.environ.get('JOSH_DIR', os.path.dirname(os.path.abspath(__file__)) + '/../out/vidlab/josh/').rstrip('/') + '/'
W, H = 1080, 1920
KEEP_GAP = 0.24      # max pause kept between phrases
PAD = 0.06           # breath kept either side of speech
END_CARD = 2.6

def sh(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode: raise SystemExit(r.stderr[-3000:])
    return r.stderr + r.stdout
def dur(f): return float(subprocess.check_output(f'ffprobe -v error -show_entries format=duration -of csv=p=0 "{f}"', shell=True))

raw = D + 'raw.mp4'; RD = dur(raw)
log = sh(f'ffmpeg -i "{raw}" -af silencedetect=noise=-38dB:d=0.12 -f null -')
ss = [float(x) for x in re.findall(r'silence_start: ([\d.]+)', log)]
se = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', log)] + [RD]
sil = list(zip(ss, se[:len(ss)]))
# keep-intervals: everything except the part of each pause longer than KEEP_GAP
keep, t = [], 0.0
for a, b in sil:
    if b - a > KEEP_GAP + 2 * PAD:
        cut_a = a + PAD + (0 if a < 0.05 else KEEP_GAP / 2)
        cut_b = b - PAD - (0 if b >= RD - 0.05 else KEEP_GAP / 2)
        if cut_a > t: keep.append((t, cut_a))
        t = cut_b
if t < RD: keep.append((t, RD))
keep = [(a, b) for a, b in keep if b - a > 0.08]
print('raw', round(RD, 1), '-> keep', round(sum(b - a for a, b in keep), 1), 's in', len(keep), 'pieces')

fl = []
for i, (a, b) in enumerate(keep):
    fl.append(f'[0:v]trim={a:.3f}:{b:.3f},setpts=PTS-STARTPTS[v{i}];[0:a]atrim={a:.3f}:{b:.3f},asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st={max(0, b - a - 0.012):.3f}:d=0.012[a{i}]')
fl.append(''.join(f'[v{i}][a{i}]' for i in range(len(keep))) + f'concat=n={len(keep)}:v=1:a=1[cv0][ca0];[cv0]setpts=PTS/1.07[cv];[ca0]atempo=1.07[ca]')
fl.append(f'[cv]tpad=stop_mode=clone:stop_duration={END_CARD}[vo];[ca]apad=pad_dur={END_CARD}[ao]')
open(D + 'cut_fc.txt', 'w').write(';'.join(fl))
sh(f'ffmpeg -y -i "{raw}" -filter_complex_script "{D}cut_fc.txt" -map "[vo]" -map "[ao]" -c:v libx264 -preset veryfast -crf 16 -c:a pcm_s16le "{D}cut.mov"')
sh(f'ffmpeg -y -i "{D}cut.mov" -vn -ac 1 -ar 48000 "{D}vo.wav"')
TOT = dur(D + 'cut.mov'); VD = TOT - END_CARD

# word timing: syllables spread over voiced time
script = json.load(open(D + '../scripts.json'))['josh']
sents = [s.strip() for s in re.split(r'(?<=[.?!])\s+', script.replace('\n\n', ' ')) if s.strip()]
log2 = sh(f'ffmpeg -i "{D}vo.wav" -af "atrim=0:{VD:.3f},silencedetect=noise=-38dB:d=0.1" -f null -')
s2 = [float(x) for x in re.findall(r'silence_start: ([\d.]+)', log2)]
e2 = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', log2)] + [VD]
pauses = list(zip(s2, e2[:len(s2)]))
voiced, t = [], 0.0
for a, b in pauses:
    if a > t: voiced.append((t, a))
    t = b
if t < VD: voiced.append((t, VD))
VT = sum(b - a for a, b in voiced)
def at_voiced(x):
    for a, b in voiced:
        if x <= b - a: return a + x
        x -= b - a
    return VD
SPOKEN = {'$': 2}
def syl(w):
    w = w.lower().replace('-', ' ')
    w = re.sub(r'[^a-z ]', '', w) or 'a'
    return max(1, sum(max(1, len(re.findall(r'[aeiouy]+', p)) - (1 if p.endswith('e') and not p.endswith('le') and len(p) > 3 else 0)) for p in w.split()))
words = [(si, w) for si, s in enumerate(sents) for w in s.split()]
wsyl = [syl(w) for _, w in words]; TS = sum(wsyl)
wst, acc = [], 0
for n in wsyl: wst.append(at_voiced(VT * acc / TS)); acc += n
wst.append(VD)
mids = [(a + b) / 2 for a, b in pauses]
bounds = [0.0]
for si in range(len(sents) - 1):
    k = max(i for i, (s_, _) in enumerate(words) if s_ == si) + 1
    p = wst[k]; near = min(mids, key=lambda m: abs(m - p)) if mids else p
    bounds.append(near if abs(near - p) < 0.8 else p)
bounds.append(VD)

GOLD = r'{\c&H5CC4E8&}'; WHITE = r'{\c&HFFFFFF&}'
KEY = re.compile(r"(josh li|without putting in a dollar|whole price|nine months|no personal guarantee|no security|five million|rent customers|biggest cheque|outlive them|serious|get paid|one and a half times|pays for itself|no money|no experience|thousand cold calls|same terms|capital|playbook|million dollars a year)", re.I)
def ts(x): return f'{int(x // 3600)}:{int(x % 3600 // 60):02d}:{x % 60:05.2f}'
# per-word highlight flags from key phrases over the whole script
full, offs = '', []
for _, w in words: offs.append(len(full)); full += w + ' '
hl = [False] * len(words)
for m in KEY.finditer(full):
    for i, o in enumerate(offs):
        if m.start() <= o < m.end(): hl[i] = True
ev = []
for si in range(len(sents)):
    idx = [i for i, (s_, _) in enumerate(words) if s_ == si]
    # chunk by up to 3 words, but never split a highlighted phrase across lines badly: keep simple 3-word chunks
    for j in range(0, len(idx), 3):
        ch = idx[j:j + 3]
        t0 = max(wst[ch[0]], bounds[si]); t1 = wst[ch[-1] + 1] if j + 3 < len(idx) else bounds[si + 1]
        c = ' '.join((GOLD + words[i][1].upper() + WHITE) if hl[i] else words[i][1].upper() for i in ch)
        ev.append(f'Dialogue: 0,{ts(t0)},{ts(max(t1, t0 + 0.2))},Cap,,0,0,0,,{{\\fscx80\\fscy80\\t(0,90,\\fscx100\\fscy100)}}{c}')
# highlight full key phrases even when split across chunks: color whole chunk words that belong to a key phrase
full = ' '.join(w for _, w in words).upper()
E0 = VD
ev.append(f'Dialogue: 1,{ts(E0)},{ts(TOT)},Card,,0,0,0,,{{\\fad(250,0)\\pos({W // 2},{H // 2 - 90})}}DOING {GOLD}$1M+{WHITE} A YEAR?')
ev.append(f'Dialogue: 1,{ts(E0 + 0.25)},{ts(TOT)},Card2,,0,0,0,,{{\\fad(250,0)\\pos({W // 2},{H // 2 + 60})}}APPLY BELOW')
ev.append(f'Dialogue: 1,{ts(E0 + 0.5)},{ts(TOT)},Sub,,0,0,0,,{{\\fad(250,0)\\pos({W // 2},{H // 2 + 200})}}G&L M&A Advisory')
ev.append(f'Dialogue: 1,{ts(0)},{ts(TOT)},Disc,,0,0,0,,AI-generated animation')
ass = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Inter ExtraBold,82,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,7,3,2,80,80,520,1
Style: Card,Inter ExtraBold,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,3,5,60,60,0,1
Style: Card2,Inter ExtraBold,96,&H00141414,&H00FFFFFF,&H005CC4E8,&H00000000,-1,0,0,0,100,100,2,0,3,22,0,5,60,60,0,1
Style: Sub,Inter,46,&H00E8E8E8,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,3,1,5,60,60,0,1
Style: Disc,Inter,32,&H00D0D0D0,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,8,40,40,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" + '\n'.join(ev) + '\n'
open(D + 'caps.ass', 'w').write(ass)

# audio: narrator + ducked music bed, loudnorm
music = D + 'music.mp3'
sh(f'ffmpeg -y -i "{D}vo.wav" -stream_loop -1 -i "{music}" -filter_complex '
   f'"[0:a]asplit=2[vo][sc];[1:a]atrim=0:{TOT:.3f},volume=0.30,afade=t=in:d=1.2,afade=t=out:st={TOT - 2.0:.3f}:d=2.0[m];'
   f'[m][sc]sidechaincompress=threshold=0.02:ratio=7:attack=25:release=400[md];'
   f'[vo][md]amix=inputs=2:normalize=0,loudnorm=I=-13:TP=-1.2:LRA=9[a]" -map "[a]" -ar 48000 "{D}mix.wav"')

# final: slight grade, darken + blur end card, captions
sh(f'ffmpeg -y -i "{D}cut.mov" -i "{D}mix.wav" -filter_complex '
   f'"[0:v]eq=contrast=1.04:saturation=1.06,split[a][b];[b]boxblur=18:2,eq=brightness=-0.32[bl];'
   f'[a][bl]overlay=enable=\'gte(t,{E0:.2f})\',ass={D}caps.ass,format=yuv420p[v]" '
   f'-map "[v]" -map 1:a -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k -shortest -movflags +faststart "{D}../josh_payment_holiday_final.mp4"')
print('done', round(TOT, 1), 's')

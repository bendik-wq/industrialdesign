"""Assemble UGC shots into one clip + Remotion props (word timings, stat beats)."""
import json, re, subprocess, os
D = os.environ.get('UGC_DIR', os.path.dirname(os.path.abspath(__file__)) + '/../out/vidlab/ugc/').rstrip('/') + '/'
OUT_PUBLIC = '/home/user/industrialdesign/vsl-funnel/ads/remotion/public/gl_platform.mp4'
PROPS = '/home/user/industrialdesign/vsl-funnel/ads/remotion/props/gl_platform.json'
LEAD, TAIL = 0.10, 0.16
SPEED = 1.08

def sh(c):
    r = subprocess.run(c, shell=True, capture_output=True, text=True)
    if r.returncode: raise SystemExit(r.stderr[-2500:])
    return r.stderr + r.stdout
def dur(f): return float(subprocess.check_output(f'ffprobe -v error -show_entries format=duration -of csv=p=0 "{f}"', shell=True))

# display text (what the captions show), aligned 1:1 with the spoken lines
DISPLAY = {
 "01": "Private equity already has a word for your business. Add-on.",
 "02": "It's the company they buy at 4x earnings and bolt onto somebody else's group, and that group gets valued at 8 to 12.",
 "03": "Same profit, twice the price, and it isn't your name on the cheque.",
 "04": "HVAC add-on deals were up 88% in the first five months of 2025.",
 "05": "Your industry is being rolled up right now, and you're either the platform or the add-on.",
 "06": "Here's what nobody tells owners your size. Private equity's edge was never the money. It's the playbook.",
 "07": "Find owners before they list, and structure every deal so the target's profit pays for it,",
 "08": "with seller finance, seller rollover and debt against the business's own cash flow.",
 "09": "Josh Li at G&L bought his first two companies 100% seller financed, with no personal guarantee and no security.",
 "10": "At your size, five businesses earning $1M each, bought at 4x, sit inside a group worth $40M.",
 "11": "Every retiring owner in your region sells to someone. The first buyer to call becomes the platform.",
 "12": "If you run a profitable business doing $1M a year or more, tap below and apply.",
 "13": "Under that? Keep scrolling. This isn't for you yet.",
}
SPOKEN_TOKEN = {"4x": "four times", "8": "eight", "12.": "twelve", "88%": "eighty eight percent", "2025.": "twenty twenty five",
                "G&L": "G and L", "100%": "one hundred percent", "$1M": "a million", "$40M.": "forty million"}
HL = re.compile(r"(add-on|4x|8 to 12|twice the price|88%|platform|playbook|100% seller financed|no personal guarantee|no security|\$40M|\$1M a year or more|rolled up|never the money|tap below and apply)", re.I)

def syl(tok):
    w = SPOKEN_TOKEN.get(tok, tok).lower().replace('-', ' ')
    w = re.sub(r'[^a-z ]', ' ', w)
    n = 0
    for p in w.split():
        k = len(re.findall(r'[aeiouy]+', p)) - (1 if p.endswith('e') and not p.endswith('le') and len(p) > 3 else 0)
        n += max(1, k) if len(p) > 1 or p in 'ai' else 1   # spelled letters (G, L) count 1
    return max(1, n)

lines = [l for l in json.load(open(D + 'lines.json')) if os.path.exists(D + f'clip_{l[0]}.mp4')]
segs, words, t = [], [], 0.0
for k, (n, _, _) in enumerate(lines):
    f = D + f'clip_{n}.mp4'; cd = dur(f)
    log = sh(f'ffmpeg -i "{f}" -af silencedetect=noise=-35dB:d=0.12 -f null -')
    ss = [float(x) for x in re.findall(r'silence_start: ([\d.]+)', log)]
    se = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', log)] + [cd]
    sil = list(zip(ss, se[:len(ss)]))
    a = sil[0][1] if sil and sil[0][0] < 0.05 else 0.0
    b = sil[-1][0] if sil and sil[-1][1] >= cd - 0.05 else cd
    a0, b0 = max(0, a - LEAD), min(cd, b + TAIL)
    # voiced spans inside [a, b] for word timing
    inner = [(s, e) for s, e in sil if s > a and e < b]
    voiced, p = [], a
    for s, e in inner: voiced.append((p, s)); p = e
    voiced.append((p, b))
    VT = sum(y - x for x, y in voiced)
    def at(x):
        for x0, x1 in voiced:
            if x <= x1 - x0: return x0 + x
            x -= x1 - x0
        return b
    toks = DISPLAY[n].split(); sy = [syl(x) for x in toks]; TS = sum(sy)
    full, offs = '', []
    for x in toks: offs.append(len(full)); full += x + ' '
    hl = [False] * len(toks)
    for m in HL.finditer(full):
        for i, o in enumerate(offs):
            if m.start() <= o < m.end(): hl[i] = True
    acc = 0
    for i, x in enumerate(toks):
        s0 = at(VT * acc / TS); acc += sy[i]; s1 = at(VT * acc / TS)
        words.append({"text": x, "start": round(t + s0 - a0, 3), "end": round(t + s1 - a0, 3), "highlight": hl[i]})
    segs.append((f, a0, b0, k)); t += b0 - a0
print('total', round(t, 2), 's from', len(segs), 'shots')

# jump-cut assembly with alternating punch-in, normalised audio
fl, ins = [], ''
for i, (f, a0, b0, k) in enumerate(segs):
    ins += f' -i "{f}"'
    z = 1.0 if k % 2 == 0 else 1.09
    fl.append(f'[{i}:v]trim={a0:.3f}:{b0:.3f},setpts=PTS-STARTPTS,scale={int(1080*z)//2*2}:{int(1920*z)//2*2},crop=1080:1920,fps=30,setsar=1[v{i}];'
              f'[{i}:a]atrim={a0:.3f}:{b0:.3f},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:d=0.02,afade=t=out:st={b0 - a0 - 0.03:.3f}:d=0.03[a{i}]')
fl.append(''.join(f'[v{i}][a{i}]' for i in range(len(segs))) + f'concat=n={len(segs)}:v=1:a=1[cvs][cas];[cvs]setpts=PTS/{SPEED}[cv0];[cas]atempo={SPEED}[ca0];[cv0]tpad=stop_mode=clone:stop_duration=2.5[cv];[ca0]apad=pad_dur=2.5[ca1]')
MI = len(segs)
fl.append('[ca1]highpass=f=80,acompressor=threshold=0.1:ratio=3:attack=10:release=150,asplit=2[vo][sc]')
fl.append(f'[{MI}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.20,afade=t=in:d=0.8[m0];[m0][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=350[md]')
fl.append('[vo][md]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-14:TP=-1.5:LRA=8[ao]')
open(D + 'asm_fc.txt', 'w').write(';'.join(fl))
os.makedirs(os.path.dirname(OUT_PUBLIC), exist_ok=True)
ins += f' -stream_loop -1 -i "{D}music.mp3"'
sh(f'ffmpeg -y{ins} -filter_complex_script "{D}asm_fc.txt" -map "[cv]" -map "[ao]" -c:v libx264 -preset medium -crf 16 -c:a aac -b:a 192k -movflags +faststart "{OUT_PUBLIC}"')
total = dur(OUT_PUBLIC)
for w in words: w['start'] = round(w['start'] / SPEED, 3); w['end'] = round(w['end'] / SPEED, 3)

def when(n):  # start/end of line n in the assembled timeline
    i = [k for k, (m, _, _) in enumerate(lines) if m == n][0]
    st = sum(b - a for _, a, b, _ in segs[:i]); return st / SPEED, (st + segs[i][2] - segs[i][1]) / SPEED
s2, e2 = when("02"); s4, e4 = when("04"); s9, e9 = when("09"); s10, e10 = when("10")
beats = [
  {"kind": "stat", "start": round(s2 + 0.6, 2), "end": round(e2 + 0.4, 2), "title": "Bought at *4x* → valued at *8–12x*", "sub": "Add-on vs platform multiples", "footnote": "Typical ranges"},
  {"kind": "stat", "start": round(s4 + 0.3, 2), "end": round(e4 + 0.8, 2), "title": "*+88%*", "sub": "HVAC private-equity add-on deals", "footnote": "Jan–May 2025 vs prior year"},
  {"kind": "stat", "start": round(s9 + 0.8, 2), "end": round(e9 + 0.3, 2), "title": "*100%* seller financed", "sub": "No personal guarantee · No security", "footnote": "Josh Li's first two acquisitions"},
  {"kind": "stat", "start": round(s10 + 0.6, 2), "end": round(e10 + 0.4, 2), "title": "5 × $1M profit → *$40M*", "sub": "Group valued at 8x", "footnote": "Illustrative"},
  {"kind": "lowerThird", "start": 1.0, "end": 4.0, "title": "G&L M&A Advisory"},
  {"kind": "cta", "start": round(total - 3.0, 2), "end": round(total, 2), "title": "Doing *$1M+* a year?", "sub": "Apply below", "footnote": "G&L M&A Advisory"},
]
props = {"videoSrc": "gl_platform.mp4", "brand": "G&L M&A Advisory", "autoBrandBeats": False,
         "durationInSeconds": round(total, 2), "words": words, "beats": beats}
props["beats"][-1]["start"] = round(total - 2.9, 2); props["beats"][-1]["end"] = round(total, 2)
json.dump(props, open(PROPS, 'w'), indent=1)
print('clip', round(total, 2), 's; props ->', PROPS)

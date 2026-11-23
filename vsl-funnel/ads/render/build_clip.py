"""Build a retention-edited vertical clip from a Josh long-form + AI inserts.

Pipeline per clip:
  AI cold open (AI shot + AI voice line)  ->  hard cut to Josh (cropped to his card, pauses jump-cut,
  alternating punch-ins)  ->  AI B-roll cutaways over his voice at keyword moments  ->  freeze for CTA.
Outputs the assembled base video into remotion/public/ and Remotion props (word-timed captions,
hook card, CTA) into remotion/props/, ready for ./render.sh.

usage: python3 build_clip.py <clip-id>    (clip config in CLIPS below)
"""
import json, os, re, subprocess, sys, difflib

ADS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CL = os.path.join(ADS, 'out/clips/')
AI = CL + 'ai/'
REM = os.path.join(ADS, 'remotion/')
MUSIC = os.environ.get('CLIP_MUSIC', CL + 'music.mp3')
W, H, FPS = 1080, 1920, 30
MAX_GAP = 0.28       # pauses longer than this are cut down to it
END_HOLD = 2.6       # CTA freeze

# card crop (4K source): x0, y0, w, h  (9:16)
CARD = (192, 240, 1148, 1400)   # full card width; shown over a blurred fill

CLIPS = {
 'p1': dict(src='21oct', win='p1', crop=CARD,
            start="It is easier. Remember this.", end="That is literally the banker mentality.",
            drop=["So, how are these people going to hit their targets and get their bonus?", "shitty"],
            cold='c1', hook="Banks would rather lend you *$100M*",
            broll=[('b1a', "big boss man"), ('b1b', "multi-million dollar transactions")],
            stat=None),
 'p2': dict(src='23oct', win='p2', crop=CARD,
            start="these vendor finance structures is basically an IOU", end="walk away with nothing.",
            drop=[], cold='c2', hook="Make the *seller* your bank",
            broll=[('b2a', "pay it over time"), ('b2b', "dream unicorn buyer")],
            stat=None),
 'p3': dict(src='26oct', win='p3', crop=CARD,
            start="So, you're at 5 mil today.", end="corporate development",
            drop=[], cold='c3', hook="*$5M → $10M* without more ads",
            broll=[('b3a', "hiring more, advertising more"), ('b3b', "buying another five")],
            stat=None),
 'p4': dict(src='30oct', win='p4', crop=None,
            start="You go out there, most people who teach you", end="career in corporate finance.",
            drop=["And yeah, you create your own reality. So whatever you choose to believe, that's that's what your reality is."],
            cold='c4', hook="They said it was *impossible*",
            broll=[('b4a', "my first ever deal"), ('b4b', "30, 40 year career")],
            stat=None),
 'p5': dict(src='23oct', win='p5', crop=CARD,
            start="I've never been in healthcare.", end="helped me run that.",
            drop=[], cold='c5', hook="Never worked in healthcare. *Bought in anyway.*",
            broll=[('b5a', "I built a board of directors"), ('b5b', "helped me do my first deal")],
            stat=None),
}
VO_TEXT = {
 'c1': "Your bank said no to a million dollars. Here's why.",
 'c2': "What if the seller became your bank?",
 'c3': "Stuck at five million, and still paying for ads?",
 'c4': "Experts called this deal impossible. He did it on his first one.",
 'c5': "Think you need industry experience to buy a company?",
}

CENTER_CROP = {'c4', 'c5', 'b2b'}   # landscape AI shots whose subject is centred: crop full-bleed

def ai_vf(name, lab):
    """filter (input -> 1080x1920) for an AI shot; landscape shots get a blur-fill unless centre-croppable."""
    w, h = map(int, subprocess.check_output(f'ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "{AI}{name}.mp4"', shell=True).decode().split(',')[:2])
    if h >= w or name in CENTER_CROP:
        return f'scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}'
    return (f'split[af{lab}][ab{lab}];[ab{lab}]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=40:2,eq=brightness=-0.2[abb{lab}];'
            f'[af{lab}]scale=1350:-2,crop={W}:ih[afs{lab}];[abb{lab}][afs{lab}]overlay=0:(H-h)/2')

def sh(c):
    r = subprocess.run(c, shell=True, capture_output=True, text=True)
    if r.returncode: raise SystemExit(r.stderr[-2500:])
    return r.stderr + r.stdout
def dur(f): return float(subprocess.check_output(f'ffprobe -v error -show_entries format=duration -of csv=p=0 "{f}"', shell=True))
norm = lambda s: re.sub(r"[^a-z0-9$]", "", s.lower())

def locate(words, phrase, after=0):
    """index of the word sequence best matching phrase (fuzzy), searching from `after`."""
    target = [norm(x) for x in phrase.split() if norm(x)]
    toks = [norm(w['w']) for w in words]
    best, bi = 0, None
    for i in range(after, len(toks) - len(target) + 1):
        r = difflib.SequenceMatcher(None, toks[i:i + len(target)], target).ratio()
        if r > best: best, bi = r, i
    return bi, best, len(target)

def main(cid):
    c = CLIPS[cid]
    words = json.load(open(CL + f"win/{c['win']}.json"))
    i0, r0, _ = locate(words, c['start'])
    i1, r1, n1 = locate(words, c['end'], i0 or 0)
    print(cid, 'start match', round(r0, 2), 'end match', round(r1, 2))
    if r0 < 0.6 or r1 < 0.6: raise SystemExit(f'{cid}: could not locate start/end in transcript')
    seg = words[i0:i1 + n1]
    # drop phrases
    keep = [True] * len(seg)
    for ph in c['drop']:
        j, r, n = locate(seg, ph)
        if j is not None and r >= 0.6:
            for k in range(j, j + n): keep[k] = False
            print(' dropped', repr(ph[:40]), round(r, 2))
    kept = [w for w, k in zip(seg, keep) if k]
    # spans: contiguous kept words, gaps capped at MAX_GAP
    spans = []
    for w in kept:
        a, b = w['s'] - 0.04, w['e'] + 0.06
        if spans and a - spans[-1][1] <= MAX_GAP: spans[-1][1] = max(spans[-1][1], b)
        else: spans.append([a, b])
    # cold open
    vo = AI + c['cold'] + '_vo.wav'; vd = dur(vo)
    cold_len = round(vd + 0.35, 2)
    # source crop/scale filter
    def base_vf(n):
        if c['crop']:
            x, y, w, h = c['crop']
            return (f'crop={w}:{h}:{x}:{y},split[fg{n}][bg{n}];[bg{n}]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=40:2,eq=brightness=-0.18:saturation=0.9[bgb{n}];'
                    f'[fg{n}]scale={W}:-2:flags=lanczos[fgs{n}];[bgb{n}][fgs{n}]overlay=(W-w)/2:(H-h)/2-60')
        return f'crop=1069:1900:1232:0,scale={W}:{H}:flags=lanczos'
    src = CL + f"src/{c['src']}.mp4"
    parts, fl, t, timeline = [], [], 0.0, []
    # 0: cold open video
    ins = f' -i "{AI}{c["cold"]}.mp4" -i "{vo}"'
    fl.append(f'[0:v]{ai_vf(c["cold"], "cold")},fps={FPS},setsar=1,trim=0:{cold_len},setpts=PTS-STARTPTS,eq=contrast=1.08:saturation=1.1[cv]')
    fl.append(f'[1:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur={cold_len}[ca]')
    vlabels, alabels = ['[cv]'], ['[ca]']
    t = cold_len
    for n, (a, b) in enumerate(spans):
        idx = 2 + n
        ins += f' -ss {a:.3f} -t {b - a:.3f} -i "{src}"'
        z = 1.0 if n % 2 == 0 else 1.1
        zf = f',scale={int(W * z) // 2 * 2}:{int(H * z) // 2 * 2},crop={W}:{H}' if z > 1 else ''
        fl.append(f'[{idx}:v]{base_vf(n)}{zf},fps={FPS},setsar=1,setpts=PTS-STARTPTS[v{n}]')
        fl.append(f'[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:d=0.015,afade=t=out:st={max(0, b - a - 0.02):.3f}:d=0.02[a{n}]')
        vlabels.append(f'[v{n}]'); alabels.append(f'[a{n}]')
        timeline.append((a, b, t)); t += b - a
    josh_end = t
    nseg = len(vlabels)
    fl.append(''.join(v + a for v, a in zip(vlabels, alabels)) + f'concat=n={nseg}:v=1:a=1[catv][cata]')
    # map source time -> output time
    def out_t(st):
        for a, b, o in timeline:
            if a <= st <= b: return o + st - a
        return None
    # b-roll overlays
    last = '[catv]'; bi = 2 + len(spans)
    for k, (shot, phrase) in enumerate(c['broll']):
        j, r, n = locate(kept, phrase)
        if j is None or r < 0.55 or not os.path.exists(AI + shot + '.mp4'): print(' skip broll', shot, r); continue
        st = out_t(kept[j]['s']);
        if st is None: continue
        d = 2.3
        ins += f' -i "{AI}{shot}.mp4"'
        fl.append(f'[{bi}:v]{ai_vf(shot, f"b{k}")},fps={FPS},setsar=1,trim=0.3:{0.3 + d},setpts=PTS-STARTPTS+{st:.3f}/TB,eq=contrast=1.06:saturation=1.1[br{k}]')
        fl.append(f'{last}[br{k}]overlay=enable=\'between(t,{st:.3f},{st + d:.3f})\':eof_action=pass[ov{k}]'); last = f'[ov{k}]'
        print(' broll', shot, 'at', round(st, 2)); bi += 1
    fl.append(f'{last}tpad=stop_mode=clone:stop_duration={END_HOLD}[vout]')
    # audio: voice + whoosh/hit at the cut + music bed ducked
    ins += f' -stream_loop -1 -i "{MUSIC}"'
    mi = bi
    fl.append(f'[cata]apad=pad_dur={END_HOLD},highpass=f=70,acompressor=threshold=0.12:ratio=3:attack=8:release=120,asplit=2[vo][sc]')
    fl.append(f'[{mi}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.22,afade=t=in:d=0.3[m0];[m0][sc]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=300[md]')
    # impact at the cut to Josh: short low sine thump
    fl.append(f'aevalsrc=\'0.9*sin(2*PI*(55+90*exp(-25*t))*t)*exp(-7*t)\':s=48000:d=0.6,aformat=channel_layouts=stereo,adelay={int(cold_len * 1000)}|{int(cold_len * 1000)}[hit]')
    fl.append('[vo][md][hit]amix=inputs=3:normalize=0:duration=first,loudnorm=I=-14:TP=-1.2:LRA=8[aout]')
    open(CL + f'{cid}_fc.txt', 'w').write(';'.join(fl))
    out = REM + f'public/{cid}.mp4'
    sh(f'ffmpeg -y{ins} -filter_complex_script "{CL}{cid}_fc.txt" -map "[vout]" -map "[aout]" -c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "{out}"')
    total = dur(out)
    # captions: cold open VO words spread over VO duration, then Josh's whisper words
    capw = []
    vw = VO_TEXT[c['cold']].split(); sy = [max(1, len(re.findall(r'[aeiouy]+', x.lower()))) for x in vw]; T = sum(sy); acc = 0
    for x, s_ in zip(vw, sy):
        capw.append({'text': x, 'start': round(0.05 + (vd - 0.1) * acc / T, 3), 'end': round(0.05 + (vd - 0.1) * (acc + s_) / T, 3), 'highlight': False}); acc += s_
    HL = re.compile(r"(\$?\d[\d,.]*\s*(million|mil|m)?|million|vendor|seller|impossible|bank|banker|bonus|competitor|buy|buying|board|healthcare|100%|IOU|nothing)", re.I)
    for w in kept:
        st = out_t(w['s']); en = out_t(w['e'])
        if st is None: continue
        txt = w['w']
        capw.append({'text': txt, 'start': round(st, 3), 'end': round(en if en else st + 0.25, 3), 'highlight': bool(HL.fullmatch(norm(txt)) or HL.search(txt) and len(txt) > 3)})
    props = {'videoSrc': f'{cid}.mp4', 'brand': 'G&L M&A Advisory', 'autoBrandBeats': False, 'durationInSeconds': round(total, 2), 'words': capw,
             'beats': [
                 {'kind': 'stat', 'start': 0.15, 'end': round(cold_len, 2), 'title': c['hook']},
                 {'kind': 'lowerThird', 'start': round(cold_len + 0.4, 2), 'end': round(cold_len + 3.4, 2), 'title': 'Josh Li · G&L M&A Advisory'},
                 {'kind': 'cta', 'start': round(total - END_HOLD - 0.2, 2), 'end': round(total, 2), 'title': 'Doing *$1M+* a year?', 'sub': 'Apply below', 'footnote': 'G&L M&A Advisory'},
             ]}
    json.dump(props, open(REM + f'props/{cid}.json', 'w'), indent=1)
    print(cid, 'done', round(total, 1), 's (cold open', cold_len, 's, Josh', round(josh_end - cold_len, 1), 's)')

if __name__ == '__main__':
    for cid in sys.argv[1:]: main(cid)

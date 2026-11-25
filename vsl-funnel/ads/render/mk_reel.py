"""Build an InfoCardReel from any of Josh's long-forms.

    python3 mk_reel.py specs.json [name ...]

specs.json: {"name": {"src": "21oct", "t0": 12.3, "t1": 48.0,
                      "card": {"kicker", "title", "rows": [{"label", "value", "at"(abs secs in source), "tone"}]},
                      "hl": ["words", "to", "highlight"], "fix": [["wrong words", "right words"], ...]}}

Cuts + crops the clip into remotion/public/reel_<name>.mp4, writes remotion/props/reel_<name>.json.
Transcripts (Whisper JSON with word timestamps) are read from $TRANSCRIPTS/t_<src>.json.
"""
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
REM = os.path.join(ROOT, '..', 'remotion')
SRC = os.path.join(ROOT, '..', 'out', 'clips', 'src')
TR = os.environ.get('TRANSCRIPTS', '.')

# crop boxes (x, y, w, h) in the 4K source -> scaled to the 1080x1220 video panel
CROPS = {
    'card': (192, 230, 1148, 1297),      # 21/22/23/26 Oct: Josh's portrait card on the navy set
    '30oct': (1350, 360, 1260, 1423),    # Pilates studio, full frame
    '27oct': (1570, 300, 1260, 1423),    # outdoors, full frame
}
PRESET = {'21oct': 'card', '22oct': 'card', '23oct': 'card', '26oct': 'card', '30oct': '30oct', '27oct': '27oct'}


def words(src, t0, t1, hl=(), fixes=()):
    r = json.load(open(os.path.join(TR, f't_{src}.json')))
    out = []
    for s in r['segments']:
        for w in s.get('words', []):
            if w['start'] >= t0 - 0.05 and w['end'] <= t1 + 0.05:
                t = w['word'].strip()
                if out and t[:1] in '-.%' and t not in ('-',):
                    out[-1]['text'] += t
                    out[-1]['end'] = round(w['end'] - t0, 3)
                    continue
                out.append({'text': t, 'start': round(w['start'] - t0, 3), 'end': round(w['end'] - t0, 3)})
    for old, new in fixes:
        o, n = old.split(), new.split()
        low = [w['text'].lower() for w in out]
        for i in range(len(low) - len(o) + 1):
            if low[i:i + len(o)] == [x.lower() for x in o]:
                st, en = out[i]['start'], out[i + len(o) - 1]['end']
                step = (en - st) / len(n)
                out[i:i + len(o)] = [{'text': n[k], 'start': round(st + k * step, 3), 'end': round(st + (k + 1) * step, 3)} for k in range(len(n))]
                break
        else:
            print('  ! fix not found:', old)
    hls = {h.lower() for h in hl}
    for w in out:
        if w['text'].strip('.,?!').lower() in hls:
            w['highlight'] = True
    return out


import re

def _tok(t):
    return re.sub(r"[^a-z0-9$%']", '', t.lower())


def find(src, phrase, after=0.0, end=False):
    """time (s) where `phrase` is spoken in the source, first occurrence after `after`"""
    r = json.load(open(os.path.join(TR, f't_{src}.json')))
    ws = [w for s in r['segments'] for w in s.get('words', [])]
    toks = [_tok(w['word']) for w in ws]
    ph = [_tok(x) for x in phrase.split() if _tok(x)]
    for i in range(len(ws) - len(ph) + 1):
        if ws[i]['start'] >= after and toks[i:i + len(ph)] == ph:
            return ws[i + len(ph) - 1]['end'] if end else ws[i]['start']
    raise SystemExit(f'phrase not found in {src}: {phrase!r} (after {after})')


def resolve(spec):
    """turn phrase-based cuts/rows into absolute times; returns list of (t0, t1) ranges"""
    src = spec['src']
    hint = spec.get('near', 0)
    ranges = []
    for c in spec.get('cuts', [[spec.get('from'), spec.get('to')]]):
        a = find(src, c[0], hint) - 0.12 if isinstance(c[0], str) else c[0]
        b = find(src, c[1], a, end=True) + 0.30 if isinstance(c[1], str) else c[1]
        ranges.append((round(a, 3), round(b, 3)))
        hint = b
    for r in spec['card']['rows']:
        if 'say' in r:
            r['at'] = find(src, r.pop('say'), ranges[0][0]) + 0.1
    return ranges


def build(name, spec):
    if 'from' in spec or 'cuts' in spec:
        ranges = resolve(spec)
    else:
        ranges = [(spec['t0'], spec['t1'])]
    if len(ranges) > 1:
        return build_multi(name, spec, ranges)
    spec['t0'], spec['t1'] = ranges[0]
    src, t0, t1 = spec['src'], spec['t0'], spec['t1']
    x, y, w, h = CROPS[spec.get('crop', PRESET[src])]
    clip = os.path.join(REM, 'public', f'reel_{name}.mp4')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(t0), '-to', str(t1), '-i', os.path.join(SRC, f'{src}.mp4'),
                    '-vf', f'crop={w}:{h}:{x}:{y},scale=1080:1220:flags=lanczos',
                    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium',
                    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', clip], check=True)
    card = json.loads(json.dumps(spec['card']))
    for r in card['rows']:
        r['at'] = max(0.5, round(r['at'] - t0, 2))
    props = {'videoSrc': f'reel_{name}.mp4', 'name': 'Josh Li', 'handle': '2 companies, $0 down',
             'durationInSeconds': round(t1 - t0, 2), 'card': card,
             'words': words(src, t0, t1, spec.get('hl', ()), spec.get('fix', ()))}
    json.dump(props, open(os.path.join(REM, 'props', f'reel_{name}.json'), 'w'), indent=1)
    print(name, round(t1 - t0, 1), 's |', ' '.join(w['text'] for w in props['words'])[:160])


def build_multi(name, spec, ranges):
    """several source ranges joined back to back (for stories)"""
    src = spec['src']
    x, y, w, h = CROPS[spec.get('crop', PRESET[src])]
    parts = []
    for k, (a, b) in enumerate(ranges):
        pp = os.path.join(REM, 'public', f'_part{k}.mp4')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(a), '-to', str(b), '-i', os.path.join(SRC, f'{src}.mp4'),
                        '-vf', f'crop={w}:{h}:{x}:{y},scale=1080:1220:flags=lanczos,fps=30', '-c:v', 'libx264', '-crf', '14',
                        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-b:a', '256k', pp], check=True)
        parts.append(pp)
    lst = os.path.join(REM, 'public', '_parts.txt')
    open(lst, 'w').write(''.join(f"file '{p}'\n" for p in parts))
    clip = os.path.join(REM, 'public', f'reel_{name}.mp4')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
                    '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', clip], check=True)
    for p in parts + [lst]:
        os.remove(p)
    ws, off = [], 0.0
    for a, b in ranges:
        for wd in words(src, a, b, spec.get('hl', ()), ()):
            wd['start'] = round(wd['start'] + off, 3); wd['end'] = round(wd['end'] + off, 3); ws.append(wd)
        off += b - a
    card = json.loads(json.dumps(spec['card']))
    for r in card['rows']:  # map absolute source times into the joined timeline
        t, off = r['at'], 0.0
        for a, b in ranges:
            if a <= t <= b:
                r['at'] = round(off + t - a, 2); break
            off += b - a
        else:
            r['at'] = 0.5
    props = {'videoSrc': f'reel_{name}.mp4', 'name': 'Josh Li', 'handle': '2 companies, $0 down',
             'durationInSeconds': round(off if False else sum(b - a for a, b in ranges), 2), 'card': card, 'words': ws}
    json.dump(props, open(os.path.join(REM, 'props', f'reel_{name}.json'), 'w'), indent=1)
    print(name, round(props['durationInSeconds'], 1), 's |', ' '.join(w['text'] for w in ws)[:160])


if __name__ == '__main__':
    specs = json.load(open(sys.argv[1]))
    for n in (sys.argv[2:] or specs):
        build(n, specs[n])

#!/usr/bin/env python3
"""
AI-edition masterclass builder.

  script-ai.md  ->  segments (one per slide or cue)  ->  ElevenLabs audio (cached by text hash)
               ->  slide PNGs (Playwright)            ->  MP4 per segment -> one MP4 -> HLS
               ->  timeline (chapters, cues, key points) written to src/webinar/edition-ai.ts

Usage:
  python3 build.py --dry      # silent placeholder audio (no ElevenLabs credit), everything written to out-dry/
  python3 build.py --slides   # only the slide PNGs, into out-dry/slides (fast design check, no audio, no video)
  python3 build.py --sample   # one short real-voice sample (about 400 characters)
  python3 build.py            # the real render (uses ElevenLabs credit for uncached segments only), written live
  --out DIR                   # write slides, video, HLS and the timeline into DIR instead of the live files
                              # (--dry and --slides default to out-dry/; the live media and edition-ai.ts are only
                              #  ever written by a real render without --out)

Slide metadata in script-ai.md (not spoken; lines after a [SLIDE: ...] line, see README.md):
  [LAYOUT: name]  [DATA: a | b | c] (repeatable)  [IMAGE: id from deck-images.json]  [CAPTION: text]  [KICKER: text]
Margin notes: <!-- ... --> anywhere (one line or several) are stripped before parsing: never spoken, never on a slide.
Any other line that starts with "[" is a note for the owner and is skipped (e.g. a bracketed conditional line).
Room cues: [POLL: id] [CALCULATOR] [BUY-IN] [APPLY OPENS] (or the older [SPRINT UNLOCKS]) [CTA] (repeatable) [WORKSHEET]
"""
import hashlib, json, os, re, subprocess, sys, shutil, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))  # scripts/ai-webinar
REPO = os.environ.get('REPO') or os.path.abspath(os.path.join(HERE, '..', '..'))  # the vsl-funnel checkout this script sits in
# --script FILE picks another script (script-ai-josh.md for Josh's cloned voice); --dump prints the parsed segments as JSON and stops.
SCRIPT = os.path.join(HERE, sys.argv[sys.argv.index('--script') + 1]) if '--script' in sys.argv else os.path.join(HERE, 'script-ai.md')
DRY = '--dry' in sys.argv; SAMPLE = '--sample' in sys.argv; SLIDES_ONLY = '--slides' in sys.argv
_out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else (os.path.join(HERE, 'out-dry') if DRY or SLIDES_ONLY else None)
OUT = os.path.abspath(_out) if _out else None  # None = the real, live build
WORKDIR = OUT or HERE
AUDIO = os.path.join(HERE, 'audio')  # the audio cache is shared (keyed by text), dry files are named dry-*
SLIDES = os.path.join(WORKDIR, 'slides'); SEGS = os.path.join(WORKDIR, 'segs')
OUT_MEDIA = os.path.join(OUT, 'media') if OUT else os.path.join(REPO, 'public/assets/media/webinar/ai')
OUT_TS = os.path.join(OUT, 'edition-ai.ts') if OUT else os.path.join(REPO, 'src/webinar/edition-ai.ts')
DECK_MAP = os.path.join(HERE, 'deck-images.json'); DECK_RES = os.path.join(HERE, 'deck', 'resolved')
LAYOUTS = {'title', 'statement', 'section', 'stat', 'list', 'comparison', 'quote', 'table', 'offer', 'step', 'image-full', 'image-left'}
VOICE = os.environ.get('VOICE_ID', 'G17SuINrv2H9FC6nvetn')  # Christopher: gentle, trustworthy British narrator (library voice, AI narration disclosed)
MODEL = 'eleven_multilingual_v2'
WPM = 183  # dry-run estimate: measured on the last voiced render (3,705 words in 20.3 min at speed 0.92, breaks included)
# The disclosure on every slide: the AI narrator, or Josh's own voice recreated by AI (script-ai-josh.md).
FOOTER = 'The Acquisition Masterclass · ' + ('Josh Li, in an AI version of his voice' if 'josh' in os.path.basename(SCRIPT) else 'Narrated by an AI voice · Method by Josh Li')

# Key points shown in the room: (id, text, phrase in the script it lands on). Texts follow the room's copy rules.
TAKEAWAYS = [
    ('two-kinds', 'Owners build one customer and one hire at a time. Buyers compound, adding a business someone else already built.', 'A buyer compounds.'),
    ('structure-problem', 'Your first acquisition is a structure problem, not a money problem.', 'Your first acquisition is a structure problem'),
    ('off-market', 'The best businesses to buy sit with owners who have no successor and have not listed.', 'The best businesses never reach a listing'),
    ('three-sources', 'The price is paid from three places: commercial debt, seller finance and seller rollover, all from the profit of the business you buy.', 'Three places pay the price'),
    ('dscr', 'Debt service coverage is yearly profit divided by yearly debt payments, and lenders want to see about 1.5x or better.', 'Lenders call it debt service coverage'),
    ('structures', 'Banks do not reject buyers, they reject structures.', "Banks don't reject buyers. They reject structures."),
    ('multiples', 'Illustrative ranges: one owner-run business trades at 3 to 5x profit, and a group of them at 8 to 12x.', 'A group of them, with a manager in each'),
    ('seller-order', 'Agree the shape of the deal with the seller first, then take it to the lender.', 'shape with the seller first'),
    ('big-domino', 'You do not have to become a different person to buy a company. You have to be seen as the buyer, and the credibility can be borrowed.', 'You have to be seen as the buyer'),
    ('the-call', 'The strategy call: your numbers, what your profit can carry at 1.5x, the business to buy first, and an honest answer on fit.', 'Here is what happens on the call'),
    ('loi-guarantee', 'The engagement guarantee: no signed letter of intent in 90 days and the team keeps working at no extra cost, or you take a full refund, when the conditions are met.', "If you don't have a signed letter of intent within"),
]
RECAPS = {
    'Owners build. Buyers compound.': 'Two kinds of owners, the ceiling most of them hit, and what this masterclass will show you.',
    'The ceiling': 'Sam, an illustrative owner, at the point where more growth costs more of his life.',
    'The owner down the road': 'The best deals are off market, with owners who have no successor.',
    'How a business pays for itself': 'Commercial debt, seller finance and seller rollover, and the 1.5x test every deal has to pass.',
    'What a group is worth': 'Illustrative ranges of 3 to 5x profit for one business against 8 to 12x for a group.',
    'What 90 owners told us': 'What owners who booked a call wanted, and why the application asks what it asks.',
    "The seller's side of the table": 'Why a retiring owner says yes to a note and a rollover, and the order: seller first, lender second.',
    'The first conversation': 'What it sounds like when a buyer calls a seller, and the question that loses most first-time buyers.',
    'Two yeses and the big domino': 'Does it work, could you do it, the question every seller asks, and the big domino.',
    'What happens when you apply': 'The application, the booking, the strategy call, the 90-day engagement it can lead to, and its guarantee.',
    'Twelve months from now': 'Sam a year after his first deal, and the two paths in front of you.',
    "Who you're becoming": 'From owner to buyer, one level at a time.',
    'The questions owners ask us': 'The reasons owners hold back, answered one at a time.',
    'Three owners, three situations': 'Three illustrative owners and what the call would map for each.',
    'Your decision': 'Two ways to leave, permission to decide, and the worksheet.',
}
STEP_ANCHORS = {'size': ('chapter', 'The ceiling'), 'where': ('chapter', 'The owner down the road'), 'test': ('chapter', 'How a business pays for itself'),
                'stack': ('cue', 'CALCULATOR'), 'group': ('chapter', 'What a group is worth'), 'plan': ('cue', 'PITCH')}


def parse():
    # Margin notes (<!-- ... -->) are for the owner: stripped before anything is parsed, so never voiced or shown.
    body = re.sub(r'<!--.*?-->', '', open(SCRIPT).read().split('\n---\n', 1)[1], flags=re.S)
    segs, chapter, slide, onscreen, text, cues, meta = [], None, None, [], [], [], {}
    def flush():
        if slide is not None and (text or cues):
            segs.append({'chapter': chapter, 'slide': slide, 'onscreen': list(onscreen), 'text': ' <break time="0.6s" /> '.join(text), 'cues': list(cues),
                         'layout': meta.get('layout', 'statement'), 'data': list(meta.get('data', [])), 'image': meta.get('image'), 'caption': meta.get('caption'),
                         'kicker': meta.get('kicker')})
    for ln in body.split('\n'):
        s = ln.strip()
        if not s: continue
        m = re.match(r'## \[\d\d:\d\d\] (.*)', s)
        if m:
            flush(); text.clear(); cues.clear(); chapter = m.group(1); continue
        m = re.match(r'\[SLIDE: (.*)\]$', s)
        if m:
            flush(); text.clear(); cues.clear(); onscreen.clear(); meta = {}; slide = m.group(1); continue
        # Slide metadata: how the slide looks. Never spoken, so the audio cache is untouched by it.
        m = re.match(r'\[(LAYOUT|DATA|IMAGE|CAPTION|KICKER): (.*)\]$', s)
        if m:
            k, v = m.group(1).lower(), m.group(2).strip()
            if k == 'layout' and v not in LAYOUTS: raise SystemExit(f'unknown layout {v!r} on slide {slide!r}')
            if k == 'data': meta.setdefault('data', []).append(v)
            else: meta[k] = v
            continue
        m = re.match(r'\[ON SCREEN: (.*)\]$', s)
        if m: onscreen.append(m.group(1)); continue
        m = re.match(r'\[(POLL: \w+|CALCULATOR|BUY-IN|SPRINT UNLOCKS|APPLY OPENS|CTA|WORKSHEET)\]$', s)
        if m:
            # A cue starts its own segment so it lands exactly when the next words begin.
            flush(); text.clear(); cues.clear(); cues.append(m.group(1)); continue
        if s.startswith('['): continue
        text.append(s)
    flush()
    # A cue line is followed by a [SLIDE]; merge cue-only segments into the next one.
    out = []
    for sg in segs:
        if out and not out[-1]['text'] and out[-1]['cues']:
            sg['cues'] = out[-1]['cues'] + sg['cues']; out.pop()
        out.append(sg)
    # Cue written before a [SLIDE] uses that slide; a segment with no slide line keeps the previous slide.
    return out


def tts(seg, prev_text, next_text):
    os.makedirs(AUDIO, exist_ok=True)
    key = hashlib.sha256(f'{VOICE}|{MODEL}|{seg["text"]}'.encode()).hexdigest()[:20]
    path = os.path.join(AUDIO, f'{key}.mp3')
    if os.path.exists(path): return path
    if DRY:
        secs = max(1.0, len(re.sub(r'<break[^>]*>', '', seg['text']).split()) * 60 / WPM)
        dry = os.path.join(AUDIO, f'dry-{key}.mp3')
        if not os.path.exists(dry):
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', f'{secs:.2f}', '-q:a', '9', dry], check=True)
        return dry
    api_key = open(os.path.join(HERE, '.key')).read().strip()
    body = {'text': seg['text'], 'model_id': MODEL, 'previous_text': prev_text[-600:], 'next_text': next_text[:300],
            'voice_settings': {'stability': 0.5, 'similarity_boost': 0.8, 'style': 0.15, 'use_speaker_boost': True, 'speed': float(os.environ.get('VOICE_SPEED', '1.0'))}}
    req = urllib.request.Request(f'https://api.elevenlabs.io/v1/text-to-speech/{VOICE}?output_format=mp3_44100_128',
                                 data=json.dumps(body).encode(), headers={'xi-api-key': api_key, 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=300) as r, open(path + '.part', 'wb') as f: f.write(r.read())
    os.replace(path + '.part', path)
    return path


def dur(path):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).decode().strip())


def deck_images(segs):
    """Image id -> what slides.js needs: the extracted original (deck/resolved/<id>.png) or a placeholder."""
    m = json.load(open(DECK_MAP))
    by_id = {i['id']: i for i in m['images']}
    out, unconfirmed = {}, []
    for sg in segs:
        iid = sg['image']
        if not iid or iid in out: continue
        if iid not in by_id: raise SystemExit(f'[IMAGE: {iid}] on slide {sg["slide"]!r} is not in deck-images.json')
        e = by_id[iid]
        f = os.path.join(DECK_RES, f'{iid}.png')
        out[iid] = {'id': iid, 'deck_slide': e['deck_slide'], 'what': e['what'], 'fit': e.get('fit', 'cover'), 'position': e.get('position'),
                    'src': f if os.path.exists(f) else None, 'credit': m['credit'].format(slide=e['deck_slide'])}
        if e.get('consent') == 'verify' and not e.get('confirmed'): unconfirmed.append(iid)
    missing = [k for k, v in out.items() if not v['src']]
    if missing: print(f'{len(missing)} deck images not extracted yet, shown as placeholders: {", ".join(missing)}')
    if not OUT and (missing or unconfirmed):
        # The live render never ships a placeholder, or a person, name or private chat the owner hasn't approved.
        raise SystemExit('Live render stopped. ' + (f'Not extracted: {", ".join(missing)} (run deck_images.py on the deck PDF). ' if missing else '')
                         + (f'Needs the owner\'s consent ("confirmed": true in deck-images.json): {", ".join(unconfirmed)}.' if unconfirmed else ''))
    return out


def render_slides(segs):
    os.makedirs(SLIDES, exist_ok=True)
    images = deck_images(segs)
    chapters = list(dict.fromkeys(sg['chapter'] for sg in segs))
    jobs, n, prev = [], 0, None
    for i, sg in enumerate(segs):
        title, _, sub = sg['slide'].partition(' | ')
        if sg['slide'] != prev: n += 1; prev = sg['slide']
        im = images.get(sg['image'])
        jobs.append({'file': os.path.join(SLIDES, f'{i:03d}.png'), 'title': title, 'sub': sub, 'onscreen': sg['onscreen'], 'chapter': sg['chapter'] or '',
                     'chapterNo': f'{chapters.index(sg["chapter"]) + 1:02d}', 'n': n, 'footer': FOOTER, 'layout': sg['layout'], 'data': sg['data'],
                     'caption': sg['caption'], 'kicker': sg.get('kicker'), 'image': im, 'credit': im['credit'] if im else None})
    json.dump(jobs, open(os.path.join(WORKDIR, 'slides.json'), 'w'), indent=1)
    subprocess.run(['node', os.path.join(HERE, 'slides.js'), os.path.join(WORKDIR, 'slides.json')], check=True)


def main():
    segs = parse()
    if '--dump' in sys.argv:  # for the copy audit (audit-script.ts): what is spoken and what is on screen, nothing else
        print(json.dumps([{k: sg[k] for k in ('chapter', 'slide', 'onscreen', 'text', 'cues', 'layout', 'data', 'image', 'caption', 'kicker')} for sg in segs])); return
    chars = sum(len(s['text']) for s in segs)
    print(f'{len(segs)} segments, {chars} characters to voice' + (f', writing to {OUT}' if OUT else ', writing the LIVE media and timeline'))
    if OUT: os.makedirs(OUT, exist_ok=True)
    if not SAMPLE: deck_images(segs)  # checks images and consent before any voice credit is spent
    if SLIDES_ONLY:
        render_slides(segs); print('slides in', SLIDES); return
    if SAMPLE:
        s = {'text': segs[0]['text'][:420].rsplit('.', 1)[0] + '.'}
        p = tts(s, '', '')
        shutil.copy(p, os.path.join(HERE, 'sample.mp3')); print('sample', p, f'{dur(p):.1f}s'); return
    for i, sg in enumerate(segs):
        sg['audio'] = tts(sg, segs[i - 1]['text'] if i else '', segs[i + 1]['text'] if i + 1 < len(segs) else '')
        sg['dur'] = dur(sg['audio']) + 0.35  # a short breath between slides
    render_slides(segs)
    os.makedirs(SEGS, exist_ok=True)
    lst = []
    for i, sg in enumerate(segs):
        out = os.path.join(SEGS, f'{i:03d}.mp4')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-loop', '1', '-framerate', '2', '-i', os.path.join(SLIDES, f'{i:03d}.png'), '-i', sg['audio'],
                        '-af', 'apad', '-t', f'{sg["dur"]:.3f}', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
                        '-vf', 'scale=1280:720', '-r', '2', '-g', '12', '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '1', out], check=True)
        lst.append(f"file '{out}'")
    open(os.path.join(WORKDIR, 'concat.txt'), 'w').write('\n'.join(lst))
    full = os.path.join(WORKDIR, 'masterclass-ai.mp4')
    raw = os.path.join(WORKDIR, 'masterclass-raw.mp4')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', os.path.join(WORKDIR, 'concat.txt'), '-c', 'copy', raw], check=True)
    # Even loudness for speech (-16 LUFS) with peaks kept under -1.5 dB, so no line clips or drops away.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', raw, '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=9', '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', full], check=True)
    # Timeline from the real segment lengths.
    t = 0.0; chapters, cues, starts, cta_at = [], {}, [], []
    for sg in segs:
        starts.append(t)
        if not chapters or chapters[-1]['title'] != sg['chapter']: chapters.append({'title': sg['chapter'], 'sec': t})
        for c in sg['cues']:
            if c == 'CTA': cta_at.append(round(t))  # repeatable: each spoken call to apply and book
            else: cues[c] = t
        t += sg['dur']
    # The pitch: where the room's offer appears. [APPLY OPENS] = the Apply and book button (this script), the older
    # [SPRINT UNLOCKS] = the First Deal Sprint.
    apply = 'APPLY OPENS' in cues
    cues['PITCH'] = cues['APPLY OPENS'] if apply else cues['SPRINT UNLOCKS']
    total = t
    def at_phrase(ph):
        for st, sg in zip(starts, segs):
            i = sg['text'].find(ph)
            if i >= 0:
                words_before = len(sg['text'][:i].split()); words = max(1, len(sg['text'].split()))
                return st + (sg['dur'] - 0.35) * words_before / words
        raise SystemExit(f'phrase not found: {ph}')
    tk, last = [], -999
    for tid, text, ph in TAKEAWAYS:
        s = round(at_phrase(ph))
        if s - last >= 75: tk.append({'id': tid, 'at': s, 'text': text}); last = s
    chap_at = {c['title']: c['sec'] for c in chapters}
    steps = {'target': 0}
    for k, (kind, name) in STEP_ANCHORS.items(): steps[k] = round(chap_at[name] if kind == 'chapter' else cues[name])
    m = lambda sec: round(sec / 60, 2)
    timeline = {
        'durationMin': m(total + 30), 'pitchAtMin': m(cues['PITCH']), 'bonusAtMin': m(cues['WORKSHEET']), 'buyinAt': round(cues['BUY-IN']),
        'calcAt': round(cues['CALCULATOR']),
        'chapters': [{'at': m(c['sec']), 'title': c['title']} for c in chapters],
        'recaps': {('%g' % m(c['sec'])): RECAPS[c['title']] for c in chapters},
        'polls': {k.split(': ')[1]: m(v) for k, v in cues.items() if k.startswith('POLL')},
        'steps': steps, 'takeaways': tk, 'mode': 'dry' if DRY else 'voiced', 'seconds': round(total),
    }
    # This script sells the strategy call: the room shows Apply and book at the pitch (no Sprint), nudged at each [CTA].
    if apply: timeline.update({'cta': 'apply', 'ctaAt': [x for x in cta_at if x >= round(cues['PITCH'])]})
    json.dump(timeline, open(os.path.join(WORKDIR, 'timeline.json'), 'w'), indent=1)
    ts = ('// Generated by the AI-edition build (scripts/ai-webinar/build.py) from the rendered audio. Do not edit by hand.\n'
          'import type { EditionTimeline } from \'./editions\';\n\n'
          f'export const AI_TIMELINE: EditionTimeline = {json.dumps(timeline, indent=2, ensure_ascii=False)};\n')
    open(OUT_TS, 'w').write(ts)
    # HLS for the room (6 s segments, all well under the 25 MB asset limit).
    if os.path.exists(OUT_MEDIA): shutil.rmtree(OUT_MEDIA)
    os.makedirs(OUT_MEDIA)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', full, '-c', 'copy', '-hls_time', '6', '-hls_playlist_type', 'vod',
                    '-hls_segment_filename', os.path.join(OUT_MEDIA, '%03d.ts'), os.path.join(OUT_MEDIA, 'index.m3u8')], check=True)
    shutil.copy(os.path.join(SLIDES, '000.png'), os.path.join(OUT_MEDIA, 'poster.png'))
    print(json.dumps({k: timeline[k] for k in ('durationMin', 'pitchAtMin', 'bonusAtMin', 'buyinAt', 'calcAt', 'polls', 'mode', 'seconds', 'cta', 'ctaAt') if k in timeline}, indent=1))


if __name__ == '__main__':
    main()

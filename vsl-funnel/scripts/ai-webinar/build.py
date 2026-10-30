#!/usr/bin/env python3
"""
AI-edition masterclass builder.

  script-ai.md  ->  segments (one per slide or cue)  ->  ElevenLabs audio (cached by text hash)
               ->  slide PNGs (Playwright)            ->  MP4 per segment -> one MP4 -> HLS
               ->  timeline (chapters, cues, key points) written to src/webinar/edition-ai.ts

Usage:
  python3 build.py --dry      # silent placeholder audio timed at 150 wpm (no ElevenLabs credit used)
  python3 build.py --sample   # one short real-voice sample (about 400 characters)
  python3 build.py            # the real render (uses ElevenLabs credit for uncached segments only)
"""
import hashlib, json, os, re, subprocess, sys, shutil, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))  # scripts/ai-webinar, or a scratch copy
REPO = '/home/user/industrialdesign/vsl-funnel'
SCRIPT = os.path.join(HERE, 'script-ai.md')
AUDIO = os.path.join(HERE, 'audio'); SLIDES = os.path.join(HERE, 'slides'); SEGS = os.path.join(HERE, 'segs')
OUT_MEDIA = os.path.join(REPO, 'public/assets/media/webinar/ai')
OUT_TS = os.path.join(REPO, 'src/webinar/edition-ai.ts')
VOICE = os.environ.get('VOICE_ID', 'G17SuINrv2H9FC6nvetn')  # Christopher: gentle, trustworthy British narrator (library voice, AI narration disclosed)
MODEL = 'eleven_multilingual_v2'
WPM = 165  # the cloned voice at speed 0.85 with paragraph breaks (measured 208 wpm at full speed)
DRY = '--dry' in sys.argv; SAMPLE = '--sample' in sys.argv
FOOTER = 'The Acquisition Masterclass · Narrated by an AI voice · Method by Josh Li'

# Key points shown in the room: (id, text, phrase in the script it lands on). Texts follow the room's copy rules.
TAKEAWAYS = [
    ('structure-problem', 'Your first acquisition is a structure problem, not a money problem.', 'Your first acquisition is a structure problem'),
    ('big-idea', 'Buy a business that is already built, and let commercial debt, seller finance and seller rollover pay the price instead of your savings.', 'A commercial lender, lending against the profit'),
    ('revenue-gap', 'Illustrative: adding $500,000 of profit at a 15% margin takes about $3.3M of new revenue, or one acquisition of a business that already makes it.', 'At a fifteen percent margin'),
    ('off-market', 'Listed businesses are auctions, and the best deals sit with owners who have no successor and have not listed yet.', "The best deals sit with owners who haven't listed"),
    ('dscr', 'Debt service coverage is yearly profit divided by yearly debt payments, and lenders want to see about 1.5x or better.', "There's one number that stops"),
    ('structures', 'Banks do not reject buyers, they reject structures.', "Banks don't reject buyers. They reject structures."),
    ('multiples', 'Illustrative ranges: one small business trades at 3 to 5x profit, and a group of them at 8 to 12x.', 'A business is worth its profit multiplied'),
    ('group-math', 'Illustrative: two businesses making $500,000 each are worth about $4M apart and $8M together as a group at 8x.', 'Two businesses making five hundred thousand each'),
    ('sprint-days', 'The First Deal Sprint: in seven days, your acquisition capacity, your buy box, a first shortlist, a deal-structure memo, an outreach script and a Deal Plan session.', "Here's what happens, day by day."),
    ('guarantee', 'The Sprint guarantee: if at the end of your Deal Plan session it was not worth far more than you paid, tell the team that day and the full fee is refunded.', 'Do the Sprint. Come to your Deal Plan session.'),
    ('three-outcomes', 'The Sprint ends one of three ways: worth far more than you paid, refunded, or credited in full against the engagement.', 'So the Sprint ends one of three ways'),
]
RECAPS = {
    'One decision': 'What this masterclass is for, who it is for, and the First Deal Sprint named up front.',
    'The real problem': 'Your first deal is a structure problem: commercial debt, seller finance and seller rollover, not your savings.',
    'Where the deals are': 'Off market, with owners who have no successor, found through a buy box and a shortlist.',
    'The test every deal has to pass': 'Yearly profit divided by yearly debt payments has to clear about 1.5x, and banks reject structures, not buyers.',
    'Why this is worth so much more than the profit': 'Illustrative ranges of 3 to 5x profit for one business against 8 to 12x for a group.',
    'The First Deal Sprint': 'The Sprint opened: seven days, one deal mapped out, day by day.',
    'What it costs, and what protects you': 'The price, the ticket credit, the guarantee, the credit against the engagement, the bonus and when it closes.',
    'Is this for you?': 'The reasons owners hold back, answered one at a time.',
    'Your decision': 'Two ways to leave, permission to decide, and the worksheet.',
}
STEP_ANCHORS = {'size': ('chapter', 'The real problem'), 'where': ('chapter', 'Where the deals are'), 'test': ('chapter', 'The test every deal has to pass'),
                'stack': ('cue', 'CALCULATOR'), 'group': ('chapter', 'Why this is worth so much more than the profit'), 'plan': ('cue', 'SPRINT UNLOCKS')}


def parse():
    body = open(SCRIPT).read().split('\n---\n', 1)[1]
    segs, chapter, slide, onscreen, text, cues = [], None, None, [], [], []
    def flush():
        if slide is not None and (text or cues):
            segs.append({'chapter': chapter, 'slide': slide, 'onscreen': list(onscreen), 'text': ' <break time="0.6s" /> '.join(text), 'cues': list(cues)})
    for ln in body.split('\n'):
        s = ln.strip()
        if not s: continue
        m = re.match(r'## \[\d\d:\d\d\] (.*)', s)
        if m:
            flush(); text.clear(); cues.clear(); chapter = m.group(1); continue
        m = re.match(r'\[SLIDE: (.*)\]$', s)
        if m:
            flush(); text.clear(); cues.clear(); onscreen.clear(); slide = m.group(1); continue
        m = re.match(r'\[ON SCREEN: (.*)\]$', s)
        if m: onscreen.append(m.group(1)); continue
        m = re.match(r'\[(POLL: \w+|CALCULATOR|BUY-IN|SPRINT UNLOCKS|WORKSHEET)\]$', s)
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


def render_slides(segs):
    os.makedirs(SLIDES, exist_ok=True)
    jobs = []
    for i, sg in enumerate(segs):
        title, _, sub = sg['slide'].partition(' | ')
        jobs.append({'file': os.path.join(SLIDES, f'{i:03d}.png'), 'title': title, 'sub': sub, 'onscreen': sg['onscreen'], 'chapter': sg['chapter'] or '', 'footer': FOOTER})
    json.dump(jobs, open(os.path.join(HERE, 'slides.json'), 'w'))
    subprocess.run(['node', os.path.join(HERE, 'slides.js'), os.path.join(HERE, 'slides.json')], check=True)


def main():
    segs = parse()
    chars = sum(len(s['text']) for s in segs)
    print(f'{len(segs)} segments, {chars} characters to voice')
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
    open(os.path.join(HERE, 'concat.txt'), 'w').write('\n'.join(lst))
    full = os.path.join(HERE, 'masterclass-ai.mp4')
    raw = os.path.join(HERE, 'masterclass-raw.mp4')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', os.path.join(HERE, 'concat.txt'), '-c', 'copy', raw], check=True)
    # Even loudness for speech (-16 LUFS) with peaks kept under -1.5 dB, so no line clips or drops away.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', raw, '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=9', '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', full], check=True)
    # Timeline from the real segment lengths.
    t = 0.0; chapters, cues, starts = [], {}, []
    for sg in segs:
        starts.append(t)
        if not chapters or chapters[-1]['title'] != sg['chapter']: chapters.append({'title': sg['chapter'], 'sec': t})
        for c in sg['cues']: cues[c] = t
        t += sg['dur']
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
        'durationMin': m(total + 30), 'pitchAtMin': m(cues['SPRINT UNLOCKS']), 'bonusAtMin': m(cues['WORKSHEET']), 'buyinAt': round(cues['BUY-IN']),
        'calcAt': round(cues['CALCULATOR']),
        'chapters': [{'at': m(c['sec']), 'title': c['title']} for c in chapters],
        'recaps': {('%g' % m(c['sec'])): RECAPS[c['title']] for c in chapters},
        'polls': {k.split(': ')[1]: m(v) for k, v in cues.items() if k.startswith('POLL')},
        'steps': steps, 'takeaways': tk, 'mode': 'dry' if DRY else 'voiced', 'seconds': round(total),
    }
    json.dump(timeline, open(os.path.join(HERE, 'timeline.json'), 'w'), indent=1)
    ts = ('// Generated by the AI-edition build (scratchpad aiweb/build.py) from the rendered audio. Do not edit by hand.\n'
          'import type { EditionTimeline } from \'./editions\';\n\n'
          f'export const AI_TIMELINE: EditionTimeline = {json.dumps(timeline, indent=2, ensure_ascii=False)};\n')
    open(OUT_TS, 'w').write(ts)
    # HLS for the room (6 s segments, all well under the 25 MB asset limit).
    if os.path.exists(OUT_MEDIA): shutil.rmtree(OUT_MEDIA)
    os.makedirs(OUT_MEDIA)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', full, '-c', 'copy', '-hls_time', '6', '-hls_playlist_type', 'vod',
                    '-hls_segment_filename', os.path.join(OUT_MEDIA, '%03d.ts'), os.path.join(OUT_MEDIA, 'index.m3u8')], check=True)
    shutil.copy(os.path.join(SLIDES, '000.png'), os.path.join(OUT_MEDIA, 'poster.png'))
    print(json.dumps({k: timeline[k] for k in ('durationMin', 'pitchAtMin', 'bonusAtMin', 'buyinAt', 'calcAt', 'polls', 'mode', 'seconds')}, indent=1))


if __name__ == '__main__':
    main()

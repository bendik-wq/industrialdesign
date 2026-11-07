#!/usr/bin/env python3
"""
The presented masterclass deck: script-ai-josh.md -> the data the deck app (public/assets/deck/) presents.

  python3 scripts/ai-webinar/present/build_deck.py          # writes src/admin/deck-data.ts and present/out/deck.html
  python3 scripts/ai-webinar/present/build_deck.py --check  # fails if src/admin/deck-data.ts is out of date (no writes)

What it writes:
  src/admin/deck-data.ts       every slide (layout, scene, on-screen text, data rows), the words Josh says on it
                               (the presenter notes), the NLP levers (the script's <!-- --> margin notes), the room cues,
                               the planned time and the face-cam layout Studio switches to. Served only by /admin/deck.
  public/assets/deck/img/      deck originals (deck/resolved/<id>.png from deck_images.py) that may be shown: consent "ok",
                               or "verify" with "confirmed": true. Others stay a labelled photo slot.
  present/out/deck.html        the same deck as one self-contained file (gitignored): open it offline, and the PDF export
                               (export.mjs) and the checks run on it.
The words come from build.py --dump, so the deck shows and says exactly what the audit (audit-script.ts) checked.
"""
import base64, json, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))  # scripts/ai-webinar/present
AIW = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(AIW, '..', '..'))
SCRIPT = 'script-ai-josh.md'
OUT_TS = os.path.join(REPO, 'src', 'admin', 'deck-data.ts')
ASSETS = os.path.join(REPO, 'public', 'assets', 'deck')
IMG_OUT = os.path.join(ASSETS, 'img')
OUT_DIR = os.path.join(HERE, 'out')
WPM = 160  # live presenting pace (the AI voice runs at 183); the presenter view paces against it

# Parts of the run of show (WEBINAR-NOTES.md), by chapter number.
PARTS = {1: 'Intro'} | {n: 'Content' for n in range(2, 9)} | {9: 'Transition', 10: 'Offer'} | {n: 'Pitch' for n in range(11, 16)}
# Room polls (src/webinar/content.ts DEFAULT_POLLS; test/deck.test.ts keeps them in step). soft_close: this edition's wording.
POLLS = {
    'target_type': ('What kind of business would you buy first?', ['A competitor', 'A supplier', 'A customer', 'An adjacent business', 'Not sure yet']),
    'timeline': ('When would you want your first deal closed?', ['0 to 3 months', '3 to 6 months', '6 to 12 months', 'Just learning']),
    'blocker': ('What is the biggest thing stopping you right now?', ['Finding deals', 'Financing', 'Structuring', 'Time', 'Confidence']),
    'own_cash': ('How much of your own cash would you want in the deal?', ['None', 'Some', 'Happy to put cash in if it helps']),
    'soft_close': ('Is a strategy call with my team right for you?', ['Yes, I want to apply', 'I have a question first', 'Not yet']),
}
CUE_LABEL = {'CALCULATOR': 'Calculator opens under the video', 'BUY-IN': 'Buy-in: they write one sentence', 'APPLY OPENS': 'The Apply button appears',
             'CTA': 'Call to action: apply and book', 'WORKSHEET': 'Worksheet unlocks'}
# Face-cam layout for Studio's auto layout (public/assets/studio-core.js LAYOUTS): data on screen -> the screen big.
SCREEN_SCENES = {'revenue-hours', 'price-stack', 'dscr-meter', 'deal-math', 'dscr-pass', 'multiple-arbitrage', 'group-value', 'owners-90', 'owners-63',
                 'paid-twice', 'offer-stack', 'guarantee', 'guarantee-conditions', 'guarantee-seven', 'apply-qr', 'two-paths', 'cost-of-waiting',
                 'dan-timeline', 'dan-year', 'big-domino', 'seller-chair', 'one-shape', 'levels', 'three-c', 'tally', 'day', 'split', 'proof'}


def cam_for(layout, scene):
    if scene in SCREEN_SCENES or layout in ('stat', 'table', 'comparison', 'offer'): return 'stage'
    if layout in ('list', 'step', 'image-left', 'image-full'): return 'split'
    return 'spotlight'  # title, section, statement, quote: the person carries it


def dump():
    out = subprocess.check_output(['python3', os.path.join(AIW, 'build.py'), '--dump', '--script', SCRIPT], text=True)
    return json.loads(out)


def margin_notes():
    """The <!-- --> notes of each [SLIDE] in order (the NLP levers), and the chapter of each slide."""
    body = open(os.path.join(AIW, SCRIPT)).read().split('\n---\n', 1)[1]
    slides, cur = [], None
    for tok in re.finditer(r'<!--(.*?)-->|^\[SLIDE: ([^\n]*)\]$', body, flags=re.S | re.M):
        if tok.group(2) is not None:
            cur = {'slide': tok.group(2), 'levers': []}; slides.append(cur)
        elif cur is not None:
            cur['levers'].append(re.sub(r'\s+', ' ', tok.group(1)).strip())
    return slides


def images():
    m = json.load(open(os.path.join(AIW, 'deck-images.json')))
    out = {}
    for e in m['images']:
        ok = e.get('consent') == 'ok' or e.get('confirmed') is True
        src = os.path.join(AIW, 'deck', 'resolved', f"{e['id']}.png")
        out[e['id']] = {'id': e['id'], 'what': e['what'], 'slide': e['deck_slide'], 'fit': e.get('fit', 'cover'),
                        'credit': m['credit'].format(slide=e['deck_slide']), 'file': src if ok and os.path.exists(src) else None,
                        'needsConsent': not ok}
    return out


def build():
    segs = dump()
    notes = margin_notes()
    imgs = images()
    # Group the segments into slides: a cue in the middle of a slide starts a new segment with the same slide line
    # (consecutive slides never share a title, so consecutive segments with one slide line are one slide).
    merged = []
    for sg in segs:
        if merged and merged[-1]['_key'] == sg['slide']:
            merged[-1]['_text'].append(sg['text']); merged[-1]['cues'] += sg['cues']; continue
        merged.append({'_key': sg['slide'], '_text': [sg['text']], '_seg': sg, 'cues': list(sg['cues'])})
    if len(merged) != len(notes):
        raise SystemExit(f'slides from the dump ({len(merged)}) and [SLIDE] lines ({len(notes)}) differ')
    chapters = list(dict.fromkeys(s['_seg']['chapter'] for s in merged))
    out, t = [], 0.0
    for i, (s, n) in enumerate(zip(merged, notes)):
        if s['_key'] != n['slide']: raise SystemExit(f'slide {i + 1}: {s["_key"]!r} != {n["slide"]!r}')
        sg = s['_seg']
        title, _, sub = sg['slide'].partition(' | ')
        paras = [p.strip() for txt in s['_text'] for p in re.split(r'\s*<break[^>]*>\s*', txt) if p.strip()]
        words = sum(len(p.split()) for p in paras)
        ch = chapters.index(sg['chapter']) + 1
        polls = [c.split(': ')[1] for c in s['cues'] if c.startswith('POLL: ')]
        scene = sg.get('scene') or ('poll' if polls else None)
        if title == 'Owners build. Buyers compound.' and sg['layout'] == 'section': scene = 'anchor'
        im = imgs.get(sg['image']) if sg['image'] else None
        d = {
            'n': i + 1, 'chapter': ch, 'title': title, 'sub': sub, 'layout': sg['layout'], 'scene': scene,
            'onscreen': sg['onscreen'], 'data': [[c.strip() for c in row.split('|')] for row in sg['data']],
            'caption': sg['caption'], 'kicker': sg['kicker'],
            'image': ({k: im[k] for k in ('id', 'what', 'slide', 'fit', 'credit', 'needsConsent')} | {'src': f"/assets/deck/img/{im['id']}.jpg" if im['file'] else None}) if im else None,
            'notes': [{'text': p, 'aiOnly': bool(re.search(r'AI version of my voice', p))} for p in paras],
            'levers': n['levers'], 'cues': [{'id': c, 'label': (f"Poll: {POLLS[c[6:]][0]}" if c.startswith('POLL: ') and c[6:] in POLLS else CUE_LABEL.get(c, c))} for c in s['cues']],
            'poll': {'id': polls[0], 'q': POLLS[polls[0]][0], 'options': POLLS[polls[0]][1]} if polls and polls[0] in POLLS else None,
            'at': round(t), 'words': words, 'cam': cam_for(sg['layout'], scene),
        }
        out.append(d)
        t += words * 60 / WPM + 4  # a beat between slides
    return {
        'title': 'The Acquisition Masterclass', 'brand': 'G&L M&A Advisory', 'presenter': 'Josh Li',
        'chapters': [{'n': i + 1, 'title': c, 'part': PARTS.get(i + 1, ''), 'at': next(s['at'] for s in out if s['chapter'] == i + 1)} for i, c in enumerate(chapters)],
        'slides': out, 'plannedSec': round(t), 'wpm': WPM, 'applyPath': '/apply', 'script': f'scripts/ai-webinar/{SCRIPT}',
    }, imgs


def ts_source(deck):
    return ('// Generated by scripts/ai-webinar/present/build_deck.py from script-ai-josh.md. Do not edit by hand: edit the script, then rerun.\n'
            '// Served only to admins (/admin/deck, src/admin/deck.ts): it carries the presenter notes and the NLP levers.\n'
            'import type { DeckData } from \'./deck\';\n\n'
            f'export const DECK_DATA: DeckData = {json.dumps(deck, ensure_ascii=False, indent=0)};\n')


def main():
    deck, imgs = build()
    src = ts_source(deck)
    if '--check' in sys.argv:
        cur = open(OUT_TS).read() if os.path.exists(OUT_TS) else ''
        if cur != src: raise SystemExit('src/admin/deck-data.ts is out of date: run python3 scripts/ai-webinar/present/build_deck.py')
        print('deck-data.ts is up to date'); return
    open(OUT_TS, 'w').write(src)
    # Deck originals that may be shown, as JPEGs next to the deck app (none until deck_images.py has run and consent is given).
    shown = [i for i in imgs.values() if i['file']]
    if shown:
        os.makedirs(IMG_OUT, exist_ok=True)
        for i in shown:
            subprocess.run(['python3', '-c', 'import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGB");im.thumbnail((1920,1920));im.save(sys.argv[2],quality=86)',
                            i['file'], os.path.join(IMG_OUT, f"{i['id']}.jpg")], check=True)
    # The standalone file: the deck app with its data and images inlined.
    os.makedirs(OUT_DIR, exist_ok=True)
    css = open(os.path.join(ASSETS, 'deck.css')).read()
    js = open(os.path.join(ASSETS, 'qr.js')).read() + '\n' + open(os.path.join(ASSETS, 'deck.js')).read()
    data = json.loads(json.dumps(deck))
    for s in data['slides']:
        if s['image'] and s['image']['src']:
            s['image']['src'] = 'data:image/jpeg;base64,' + base64.b64encode(open(os.path.join(IMG_OUT, f"{s['image']['id']}.jpg"), 'rb').read()).decode()
    html = page_html(json.dumps(data, ensure_ascii=False).replace('</', '<\\/'), f'<style>{css}</style>', f'<script>{js}</script>', apply_origin='https://apply.grosfjeld-li.com')
    open(os.path.join(OUT_DIR, 'deck.html'), 'w').write(html)
    print(f"{len(deck['slides'])} slides, {len(deck['chapters'])} chapters, planned {deck['plannedSec'] // 60} min at {WPM} wpm; "
          f"{len(shown)} deck originals shown, {sum(1 for i in imgs.values() if not i['file'])} photo slots pending")
    print('wrote', os.path.relpath(OUT_TS, REPO), 'and', os.path.relpath(os.path.join(OUT_DIR, 'deck.html'), REPO))


def page_html(data_json, head_css, body_js, apply_origin):
    """The deck page around the data (the same shell src/admin/deck.ts serves; keep the two in step)."""
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Acquisition Masterclass · Deck</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,200..800;1,6..72,200..800&family=Inter:opsz,wght@14..32,300..700&display=block">
{head_css}</head><body class="dk" data-apply-origin="{apply_origin}"><div id="deck" class="dk-root"></div>
<script type="application/json" id="deck-data">{data_json}</script>
{body_js}</body></html>'''


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
The original images from Josh's March 2026 deck, for the AI-edition slides.

  python3 deck_images.py /path/to/deck.pdf   # extract everything, then resolve the mapping
  python3 deck_images.py --resolve           # re-resolve after editing deck-images.json (no PDF needed)
  python3 deck_images.py --status            # which mapped images exist, which are placeholders, which need consent

Extraction (into deck/, gitignored; excluded slides are never extracted):
  deck/embedded/img-PPP-NNN.png   every embedded image (pdfimages -png -p), PPP = slide number
  deck/pages/page-PP.png          every slide rendered at 2x (pdftoppm -r 144), for screenshot-style slides
  deck/contact.html               every slide with its embedded images, to check and correct deck-images.json
  deck/resolved/<id>.png          what build.py puts on the webinar slides
"""
import html, json, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAP = os.path.join(HERE, 'deck-images.json')
WORK = os.path.join(HERE, 'deck')
EMB, PAGES, RES = (os.path.join(WORK, d) for d in ('embedded', 'pages', 'resolved'))
SCRIPT = os.path.join(HERE, 'script-ai.md')
MIN_SIDE = 240  # smaller embedded images are logos and icons


def load():
    m = json.load(open(MAP))
    bad = {e['deck_slide'] for e in m['excluded']} & {i['deck_slide'] for i in m['images']}
    if bad: raise SystemExit(f'deck-images.json maps excluded slides: {sorted(bad)}')
    ids = [i['id'] for i in m['images']]
    if len(ids) != len(set(ids)): raise SystemExit('deck-images.json has duplicate ids')
    return m


def run(*a):
    return subprocess.run(a, check=True, capture_output=True, text=True).stdout


def page_count(pdf):
    return int(re.search(r'Pages:\s+(\d+)', run('pdfinfo', pdf)).group(1))


def ranges(n, skip):
    """Slide ranges [(first, last)] covering 1..n without the excluded slides."""
    out, start = [], None
    for p in range(1, n + 2):
        if p <= n and p not in skip:
            start = start or p
        elif start:
            out.append((start, p - 1)); start = None
    return out


def embedded_list(pdf, first, last):
    """pdfimages -list rows: (page, num, type, width, height)."""
    rows = []
    for ln in run('pdfimages', '-list', '-f', str(first), '-l', str(last), pdf).splitlines()[2:]:
        c = ln.split()
        if len(c) > 4: rows.append((int(c[0]), int(c[1]), c[2], int(c[3]), int(c[4])))
    return rows


def extract(pdf):
    m = load()
    n = page_count(pdf)
    if n != 88: print(f'warning: the deck has {n} slides, the mapping was written for 88. Check deck_slide numbers in deck/contact.html.')
    skip = {e['deck_slide'] for e in m['excluded']}
    for d in (EMB, PAGES): shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    index = []
    for a, b in ranges(n, skip):
        run('pdfimages', '-png', '-p', '-f', str(a), '-l', str(b), pdf, os.path.join(EMB, 'img'))
        run('pdftoppm', '-png', '-r', '144', '-f', str(a), '-l', str(b), pdf, os.path.join(PAGES, 'page'))
        index += embedded_list(pdf, a, b)
    # pdftoppm pads page numbers to the width of the last page; make them all two digits.
    for f in os.listdir(PAGES):
        mm = re.match(r'page-0*(\d+)\.png$', f)
        if mm: os.replace(os.path.join(PAGES, f), os.path.join(PAGES, f'page-{int(mm.group(1)):02d}.png'))
    # Drop soft masks, stencils and anything icon-sized; keep a manifest of what is left.
    keep = {}
    for page, num, typ, w, h in index:
        f = os.path.join(EMB, f'img-{page:03d}-{num:03d}.png')
        if not os.path.exists(f): continue
        if typ != 'image' or min(w, h) < MIN_SIDE: os.remove(f); continue
        keep.setdefault(page, []).append({'file': os.path.basename(f), 'w': w, 'h': h})
    json.dump(keep, open(os.path.join(WORK, 'embedded.json'), 'w'), indent=1)
    contact(n, skip, keep, m)
    print(f'extracted {sum(len(v) for v in keep.values())} embedded images and {n - len(skip)} slide renders into {WORK}')


def contact(n, skip, keep, m):
    used = {}
    for i in m['images']: used.setdefault(i['deck_slide'], []).append(i['id'])
    rows = []
    for p in range(1, n + 1):
        if p in skip: rows.append(f'<section><h2>Slide {p}: excluded</h2></section>'); continue
        ims = ''.join(f'<figure><img src="embedded/{e["file"]}"><figcaption>pick {k} · {e["w"]}×{e["h"]}</figcaption></figure>' for k, e in enumerate(keep.get(p, [])))
        tag = f' · mapped: {html.escape(", ".join(used[p]))}' if p in used else ''
        rows.append(f'<section><h2>Slide {p}{tag}</h2><div><figure><img src="pages/page-{p:02d}.png"><figcaption>page</figcaption></figure>{ims}</div></section>')
    open(os.path.join(WORK, 'contact.html'), 'w').write(
        '<!doctype html><meta charset="utf-8"><title>Deck images</title><style>body{font:14px/1.4 Inter,system-ui,sans-serif;margin:32px;background:#f7f6f3;color:#121212}'
        'section{border-top:1px solid #dcd9d2;padding:16px 0}h2{font-size:15px;font-weight:600;margin:0 0 10px}div{display:flex;gap:12px;flex-wrap:wrap}'
        'figure{margin:0}img{height:180px;display:block;background:#fff}figcaption{color:#8b8984;font-size:12px;margin-top:4px}</style>'
        '<h1>Deck slides and embedded images</h1>' + ''.join(rows))


def resolve():
    from PIL import Image
    m = load()
    if not os.path.isdir(PAGES): raise SystemExit('Nothing extracted yet: run python3 deck_images.py /path/to/deck.pdf first.')
    keep = json.load(open(os.path.join(WORK, 'embedded.json')))
    os.makedirs(RES, exist_ok=True)
    for i in m['images']:
        p, out = i['deck_slide'], os.path.join(RES, f'{i["id"]}.png')
        page = os.path.join(PAGES, f'page-{p:02d}.png')
        src = None
        if i.get('source') == 'embedded':
            cands = keep.get(str(p), [])
            pick = i.get('pick', 'largest')
            if cands:
                c = max(cands, key=lambda e: e['w'] * e['h']) if pick == 'largest' else cands[min(int(pick), len(cands) - 1)]
                src = os.path.join(EMB, c['file'])
            else:
                print(f'{i["id"]}: no embedded image on slide {p}, using the slide render')
        src = src or page
        if not os.path.exists(src): print(f'{i["id"]}: slide {p} missing'); continue
        im = Image.open(src).convert('RGB')
        if i.get('crop'):
            x, y, w, h = i['crop']; W, H = im.size
            im = im.crop((round(x * W), round(y * H), round((x + w) * W), round((y + h) * H)))
        im.save(out, optimize=True)
        print(f'{i["id"]}: slide {p} ({os.path.basename(src)}) -> {os.path.relpath(out, HERE)}')


def status():
    m = load()
    script = open(SCRIPT).read()
    where, slide = {}, None
    for ln in script.split('\n'):
        s = re.match(r'\[SLIDE: (.*)\]$', ln.strip()); im = re.match(r'\[IMAGE: ([\w-]+)\]$', ln.strip())
        if s: slide = s.group(1)
        if im: where.setdefault(im.group(1), []).append(slide)
    used = set(where)
    ids = {i['id'] for i in m['images']}
    for u in sorted(used - ids): print(f'script uses unknown image: {u}')
    for i in m['images']:  # keep 'used_on' in the mapping honest
        got = sorted(where.get(i['id'], []))
        if sorted(i.get('used_on', [])) != got and sorted(i.get('used_on', [])) != sorted(g.split(' | ')[0] for g in got):
            print(f'{i["id"]}: used_on says {i.get("used_on")}, script-ai.md shows it on {got}')
    for i in m['images']:
        have = os.path.exists(os.path.join(RES, f'{i["id"]}.png'))
        flags = [('resolved' if have else 'placeholder'), ('used' if i['id'] in used else 'unused')]
        if i['consent'] == 'verify' and not i.get('confirmed'): flags.append('NEEDS OWNER CONSENT')
        if not i.get('slide_exact', True): flags.append(f'check slide number (range {i.get("range")})')
        print(f'{i["id"]:22} slide {i["deck_slide"]:>2}  ' + ' · '.join(flags))


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a: print(__doc__); sys.exit(1)
    if a[0] == '--status': status()
    elif a[0] == '--resolve': resolve(); status()
    else: extract(a[0]); resolve(); status()

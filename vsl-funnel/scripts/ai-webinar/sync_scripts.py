#!/usr/bin/env python3
"""
One source for the two masterclass scripts: script-ai-josh.md (first person, Josh's own voice; the presented deck reads it)
is the source, and script-ai.md (the AI narrator, Josh in the third person) is generated from it.

  python3 scripts/ai-webinar/sync_scripts.py          # rewrites script-ai.md and the chapter times in both
  python3 scripts/ai-webinar/sync_scripts.py --check  # fails if script-ai.md is out of step (no writes)

What changes between the two: the header, the disclosure paragraph, "my team" -> "Josh's team", and the sentences
in PERSON below, where Josh speaks about himself. The narrator also says "I" ("I want you to meet someone"), so only
Josh's own facts move to the third person. Anything Josh-first-person left over fails the run (LEFTOVER), so a new
sentence about Josh needs a line in PERSON. Chapter times are estimated at 183 spoken words a minute (the rate measured
on the last voiced render); the real timeline comes from the render.
"""
import os, re, subprocess, sys, json

HERE = os.path.dirname(os.path.abspath(__file__))
SRC, OUT = os.path.join(HERE, 'script-ai-josh.md'), os.path.join(HERE, 'script-ai.md')
WPM = 183

HEADER_AI = '''# The Acquisition Masterclass (AI edition): script

**Presenter:** an AI narrator voice (disclosed at the start and on every slide), presenting Josh Li's method in the third person.
**What it sells:** the application and the strategy call with Josh's team (the button under the video: /apply, then one-tap booking on /book). The call is never called free. The call can lead to the 90-day "Done with you" advisory engagement (the 3C model), with the LOI guarantee and the 7-day money-back read in full. Fees exist and are covered on the call, not here.
**How it sells:** story first, desire over teaching (docs/desire-doctrine.md). One protagonist (Dan, an illustrative composite owner) goes from the ceiling to the buyer's path to becoming the buyer. Josh's own story uses only approved facts. Identity is walked up Dilts' logical levels. One anchor ("Owners build. Buyers compound."), three nested loops closed in reverse, one big domino, a double tie-down, double binds toward apply and book, always with a visible no. Run of show, levers and the verify list: WEBINAR-NOTES.md.
**Format rules for the build script:** `## [mm:ss] Title` starts a chapter (times estimated at 183 words a minute; the real timeline comes from the render). `[SLIDE: …]` starts a new slide; `[LAYOUT]`, `[DATA]`, `[IMAGE]`, `[CAPTION]`, `[KICKER]` style it. `[ON SCREEN: …]` adds a line to the current slide. `[POLL: id]`, `[CALCULATOR]`, `[BUY-IN]`, `[APPLY OPENS]`, `[CTA]` and `[WORKSHEET]` are room cues, timed from the rendered audio: `[APPLY OPENS]` is the pitch, where the Apply and book button appears; each `[CTA]` nudges it. `<!-- … -->` are margin notes for the owner (the NLP levers and proof sources): never spoken, never shown. Any other line in square brackets is an owner note the build skips. Plain paragraphs are spoken.
**Generated:** from script-ai-josh.md by `python3 scripts/ai-webinar/sync_scripts.py`. Edit the Josh script, then rerun.
'''

DISCLOSURE_JOSH = "Before anything else, one thing you should know. This masterclass is presented in an AI version of my voice. The method, the numbers and every word of it are mine and my team's. I made it this way so you can watch it at a time that suits you, and so every owner gets exactly the same masterclass."
DISCLOSURE_AI = "Before anything else, one thing you should know. This masterclass is narrated by an AI voice. The method, the numbers and every word of it come from Josh Li and his team at G&L M&A Advisory. It's made this way so you can watch it at a time that suits you, and so every owner gets exactly the same masterclass."

# Josh speaking about himself -> the narrator speaking about Josh. Exact substrings, applied in order.
PERSON = [
    ('when I bought my clinics', 'when Josh bought his clinics'),
    ("Twice, a seller trusted me with his life's work", "Twice, a seller trusted Josh with his life's work"),
    ('My clinics, bought for JC Health Group, my own healthcare holding company', "Josh's clinics, bought for JC Health Group, his own healthcare holding company"),
    ("And I'm not telling you this from the outside.", "And this doesn't come from the outside."),
    ("I've done it twice. Two acquisitions,", "Josh has done it twice. Two acquisitions,"),
    ('a condition you can hold me to', 'a condition you can hold us to'),
    ('My name is Josh Li. I founded JC Health Group, my own healthcare holding company. I bought my clinics in two acquisitions, and in both of them the sellers financed',
     'The method comes from Josh Li. Josh founded JC Health Group, his own healthcare holding company. He bought his clinics in two acquisitions, and in both of them the sellers financed'),
    ("Hold on to that, because I'll tell you what made it possible", "Hold on to that fact, because you'll hear what made it possible"),
    ('Remember my two acquisitions.', "Remember Josh's two acquisitions."),
    ("I didn't walk in with a pile of cash.", "Josh didn't walk in with a pile of cash."),
    ('because I had the most money in the room', 'because Josh had the most money in the room'),
    ("because he believed I'd look after", "because he believed Josh would look after"),
    ('in my case clinics', "in Josh's case clinics"),
    ('JC Health Group, my healthcare holding company', "JC Health Group, Josh's healthcare holding company"),
    ('I need two answers from you, not out loud', 'there are two questions to answer, not out loud'),
    ('and my own clinics, bought twice', "and Josh's own clinics, bought twice"),
    ('the sellers in my two acquisitions', "the sellers in Josh's two acquisitions"),
    ('In both of my acquisitions', "In both of Josh's acquisitions"),
    ('My own businesses are clinics.', "Josh's own businesses are clinics."),
    ('My own two acquisitions were clinics', "Josh's own two acquisitions were clinics"),
    ('I founded JC Health Group, my own healthcare holding company, and bought my clinics',
     'Josh founded JC Health Group, his own healthcare holding company, and bought his clinics'),
    ('When I bought my clinics', 'When Josh bought his clinics'),
    ('I sat across the table from two sellers', 'Josh sat across the table from two sellers'),
    ('both of my sellers', "both of Josh's sellers"),
    ('I can tell you what it felt like', "Josh can tell you what it felt like"),
    ('what it felt like for me', 'what it felt like for him'),
    ('the board behind me', 'the board behind Josh'),
    ('who stood behind me', 'who stood behind Josh'),
    ('I started where you are', 'Josh started where you are'),
]
# An owner's own words, where "my team" means the owner's staff.
KEEP = ['What if my team finds out']
# Phrases that mean Josh is speaking about himself. Left in the narrator script, they fail the run.
LEFTOVER = re.compile(r"\bmy (team|clinics|acquisitions|healthcare|sellers|two)\b|\bmy own (healthcare|clinics|businesses|two)\b|\bI (founded|bought my|didn't walk)\b|\bmine and my\b|\bhold me to\b|\bMy name is\b|\btrusted me\b|\bI've done it twice\b", re.I)


def to_narrator(src):
    body = src.split('\n---\n', 1)[1]
    assert DISCLOSURE_JOSH in body, 'the disclosure paragraph changed: update DISCLOSURE_JOSH and DISCLOSURE_AI together'
    body = body.replace(DISCLOSURE_JOSH, DISCLOSURE_AI)
    for a, b in PERSON: body = body.replace(a, b)
    # "my team" is Josh's team, except where an owner speaks about their own staff (KEEP).
    for i, k in enumerate(KEEP): body = body.replace(k, f'\x00{i}\x00')
    body = re.sub(r'\b[Mm]y team\b', "Josh's team", body)
    for i, k in enumerate(KEEP): body = body.replace(f'\x00{i}\x00', k)
    left = [ln for ln in body.split('\n') if not ln.startswith('<!--') and LEFTOVER.search(re.sub('|'.join(map(re.escape, KEEP)), '', re.sub(r'<!--.*?-->', '', ln)))]
    if left:
        raise SystemExit('Josh in the first person left in the narrator script (add a PERSON line):\n  ' + '\n  '.join(l[:160] for l in left))
    return HEADER_AI + '\n---\n' + body


def retime(text, script_name):
    """Rewrite the `## [mm:ss]` chapter times from the spoken words before each chapter, at WPM."""
    tmp = os.path.join(HERE, '.retime.md')
    open(tmp, 'w').write(text)
    try:
        segs = json.loads(subprocess.check_output(['python3', os.path.join(HERE, 'build.py'), '--dump', '--script', tmp], text=True))
    finally:
        os.remove(tmp)
    words, start = 0, {}
    for s in segs:
        start.setdefault(s['chapter'], words)
        words += len(re.sub(r'<break[^>]*>', ' ', s['text']).split())
    def rep(m):
        t = start.get(m.group(2))
        if t is None: return m.group(0)
        sec = round(t / WPM * 60)
        return f'## [{sec // 60:02d}:{sec % 60:02d}] {m.group(2)}'
    return re.sub(r'^## \[(\d+:\d\d)\] (.+)$', rep, text, flags=re.M)


def main():
    src = open(SRC).read()
    new_src = retime(src, 'script-ai-josh.md')
    out = retime(to_narrator(new_src), 'script-ai.md')
    if '--check' in sys.argv:
        bad = [p for p, t in ((SRC, new_src), (OUT, out)) if open(p).read() != t]
        if bad: raise SystemExit('out of step: run python3 scripts/ai-webinar/sync_scripts.py (' + ', '.join(os.path.basename(b) for b in bad) + ')')
        print('scripts in step'); return
    open(SRC, 'w').write(new_src)
    open(OUT, 'w').write(out)
    print('wrote script-ai-josh.md (chapter times) and script-ai.md')


if __name__ == '__main__':
    main()

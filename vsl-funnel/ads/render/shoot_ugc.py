import sys, os, json, concurrent.futures as cf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vidlab
D = os.environ.get('UGC_DIR', os.path.dirname(os.path.abspath(__file__)) + '/../out/vidlab/ugc/').rstrip('/') + '/'
img = open(D + 'start_url').read().strip()
V = ('Selfie-style iPhone UGC video, vertical. The man in the image, a sharp confident Australian businessman in his early forties in a navy blazer, '
     'in his glass-walled office, talks straight into the phone camera with conviction and a slightly provocative edge, natural hand gestures. '
     'Deep, confident Australian male voice, clear, punchy delivery, close microphone, quiet office room tone, no music. No captions, no on-screen text. ')
MOVES = ['Slow handheld push-in toward his face.', 'He walks slowly along the window, phone in hand, city behind him.',
         'Tighter close-up, he leans toward the lens.', 'He gestures with his free hand, slight handheld sway.',
         'He leans against the boardroom table, relaxed but intense.', 'Close selfie framing, he points at the camera on the key word.']
lines = [
 ("02", 8, "It's the company they buy at four times earnings and bolt onto somebody else's group, and that group gets valued at eight to twelve."),
 ("03", 6, "Same profit, twice the price, and it isn't your name on the cheque."),
 ("04", 6, "HVAC add-on deals were up eighty-eight percent in the first five months of twenty twenty-five."),
 ("05", 8, "Your industry is being rolled up right now, and you're either the platform or the add-on."),
 ("06", 8, "Here's what nobody tells owners your size. Private equity's edge was never the money. It's the playbook."),
 ("07", 8, "Find owners before they list, and structure every deal so the target's profit pays for it,"),
 ("08", 6, "with seller finance, seller rollover and debt against the business's own cash flow."),
 ("09", 8, "Josh Li at G and L bought his first two companies one hundred percent seller financed, with no personal guarantee and no security."),
 ("10", 8, "At your size, five businesses earning a million each, bought at four times, sit inside a group worth forty million."),
 ("11", 8, "Every retiring owner in your region sells to someone. The first buyer to call becomes the platform."),
 ("12", 8, "If you run a profitable business doing a million a year or more, tap below and apply."),
 ("13", 6, "Under that? Keep scrolling. This isn't for you yet."),
]
json.dump([("01", 6, "Private equity already has a word for your business. Add-on.")] + lines, open(D + 'lines.json', 'w'))
def shoot(a):
    n, dur, text = a
    for attempt in range(2):
        try:
            j = vidlab.generate('gemini-omni-1.1-flash', {"prompt": V + MOVES[int(n) % len(MOVES)] + f' He says exactly, word for word: "{text}"',
                                "images": [img], "duration": dur, "aspect_ratio": "9:16", "resolution": "1080p"}, D + f'clip_{n}.mp4')
            print('ok', n, j.get('price_usd'), flush=True); return
        except BaseException as e: print('retry' if attempt == 0 else 'FAIL', n, str(e)[:200], flush=True)
with cf.ThreadPoolExecutor(6) as ex: list(ex.map(shoot, lines))
print('DONE', flush=True)

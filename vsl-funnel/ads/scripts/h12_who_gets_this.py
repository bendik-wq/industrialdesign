# H12 · Who gets this. Belief: the best deals never list; they go to whoever asks first.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "Who gets this"
SCRIPT = [
    dict(d=2.8, card="Nobody asks a sixty-year-old owner, \"who gets this when you stop?\"", size=60, bg="street"),
    dict(d=1.6, card="Somebody should.", hit=True),
    dict(d=2.6, sub="The best businesses never reach a listing site."),
    dict(d=2.6, sub="They sell to the buyer who called first and made the owner feel safe."),
    dict(d=2.4, card="Brokers run auctions. Buyers who win go direct.", size=64),
    dict(d=2.0, card="Be the one who asks.", hit=True),
    *disqualify(),
    *mechanism(),
    *proof(),
    dict(d=2.4, card="Somewhere near you, an owner is waiting for that call.", size=64),
    dict(d=2.0, card="Make it yours.", hit=True),
    *cta(),
]
MUSIC = [(0, 1), (4, 2), (10, 3), (20, 4), (32, 5)]

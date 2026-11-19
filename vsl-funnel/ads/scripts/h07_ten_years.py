# H07 · Ten years. Belief: the next ten years of growth can be bought, not repeated.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "Ten years"
SCRIPT = [
    dict(d=2.4, card="How long did it take you to build what you have?", size=64),
    dict(d=1.8, card="Ten years? Twenty?", hit=True),
    dict(d=2.6, bg="clock", tick=True, sub="At the same speed, the next stage takes just as long."),
    dict(d=2.4, bg="clock", tick=True, sub="You'll be a decade older when you get there."),
    dict(d=2.6, card="Somewhere near you, an owner already spent those years.", size=64),
    dict(d=2.4, sub="The customers, the team and the name are built, and the owner is ready to stop."),
    dict(d=2.2, card="You can buy their ten years.", hit=True),
    *disqualify(),
    *mechanism(),
    *proof(),
    dict(d=2.2, card="Ten more years of building."),
    dict(d=2.4, card="Or a decade bought in a single settlement.", hit=True),
    *cta(),
]
MUSIC = [(0, 1), (4, 2), (10, 3), (22, 4), (34, 5)]
DARK = [(4, 10)]

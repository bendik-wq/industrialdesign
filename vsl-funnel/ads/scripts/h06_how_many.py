# H06 · How many. Belief: you don't have to build every business from scratch.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "How many"
SCRIPT = [
    dict(d=2.6, card="How many businesses will you build in your life?", size=64),
    dict(d=1.6, card="Probably one.", hit=True),
    dict(d=2.0, card="How many could you own?"),
    dict(d=0.5),
    dict(d=2.8, sub="Building one took years of your life, one customer at a time."),
    dict(d=2.4, card="Nobody said you have to build the next one.", size=64),
    dict(d=2.4, bg="ledger", sub="Disney bought Pixar, then Marvel, then Lucasfilm."),
    dict(d=2.2, bg="ledger", sub="Facebook bought Instagram."),
    dict(d=2.2, card="The biggest owners collect businesses.", hit=True),
    *disqualify(),
    *mechanism(),
    *proof(),
    dict(d=2.2, card="You built one."),
    dict(d=2.4, card="Your next three can be bought.", hit=True),
    *cta(),
]
MUSIC = [(0, 1), (4, 2), (12, 3), (24, 4), (36, 5)]

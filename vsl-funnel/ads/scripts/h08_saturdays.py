# H08 · Count the Saturdays. Belief: hours don't scale a business; acquisitions do.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "Count the Saturdays"
SCRIPT = [
    dict(d=1.8, card="Count your Saturdays."),
    dict(d=2.8, bg="squares", n=52, sub="52 a year.", tick=True),
    dict(d=2.4, card="How many did the business take this year?", hit=True),
    dict(d=2.6, sub="You were told hard work grows a business."),
    dict(d=2.4, sub="It does, one customer at a time."),
    dict(d=2.6, card="Owners who buy their growth add a whole customer base in one signature.", size=60),
    dict(d=2.0, card="And they get their Saturdays back.", hit=True),
    *disqualify(),
    *mechanism(),
    *proof(),
    dict(d=2.2, card="Your Saturdays won't come back."),
    dict(d=2.4, card="Your next business is already out there.", hit=True),
    *cta(),
]
MUSIC = [(0, 1), (3, 2), (12, 3), (24, 4), (36, 5)]
DARK = [(6, 14)]

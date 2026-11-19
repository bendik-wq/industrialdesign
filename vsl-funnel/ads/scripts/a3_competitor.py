# A3 · "Your competitor" (~32 s). Short cutdown for Reels/Shorts. Same odds hook, aimed at the
# owner's strongest desire object: the competitor's customers.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "Your competitor"
SCRIPT = [
    dict(d=2.8, card="The odds your biggest competitor walks away one day?", size=66),
    dict(d=1.9, card="1 in 1.", big=True, hit=True, vo="One in one."),
    dict(d=1.6, bg="street", sub="Their customers.", vo="Their customers, their team, their phone number."),
    dict(d=1.5, bg="street", sub="Their team.", vo=""),
    dict(d=1.7, bg="street", sub="Their phone number.", vo=""),
    dict(d=2.4, bg="street", dim=True, sub="Someone is going to own all of it."),
    dict(d=0.4),
    dict(d=1.8, card="Why not you?", hit=True),
    *disqualify(),
    *mechanism(),
    *proof(),
    dict(d=0.4),
    *cta(),
]

MUSIC = [(0, 1), (2.8, 2), (4.7, 3), (12.3, 4), (16.8, 5)]
DARK = []

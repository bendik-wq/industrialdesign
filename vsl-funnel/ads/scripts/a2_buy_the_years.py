# A2 · "Buy the years" (~50 s). Belief shift: time is the one thing you CAN buy, from the owner
# who already spent it. Motif: the clock / squares as years.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "Buy the years"
SCRIPT = [
    dict(d=2.6, card="Time is the one thing money can't buy."),
    dict(d=1.5, card="Everyone says so."),
    dict(d=0.5),
    dict(d=1.8, card="They're wrong.", hit=True),
    dict(d=2.6, bg="clock", tick=True, sub="Somewhere near you, an owner spent 25 years"),
    dict(d=1.6, bg="clock", tick=True, sub="finding the customers,"),
    dict(d=1.5, bg="clock", tick=True, sub="training the team,"),
    dict(d=1.8, bg="clock", tick=True, sub="earning the name."),
    dict(d=2.8, bg="squares", n=25, sub="You could spend the next 25 years doing the same."),
    dict(d=0.5),
    dict(d=2.0, card="Or you could buy them.", hit=True),
    *disqualify(),
    *mechanism(),
    *proof(),
    dict(d=2.0, card="The years are for sale.", bg="warm"),
    dict(d=2.4, card="Most owners never ask the price.", bg="warm"),
    dict(d=0.5),
    *cta(),
]

MUSIC = [(0, 1), (4.6, 2), (6.4, 3), (17.2, 4), (29.6, 5)]
DARK = [(6.4, 17.2)]

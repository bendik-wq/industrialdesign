# H04 · Every sign. Belief: the businesses around you are inventory, and private equity already knows it.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "Every sign"
SCRIPT = [
    dict(d=2.0, card="Every sign on your street", bg="street"),
    dict(d=2.4, card="will carry someone else's name one day.", bg="street", hit=True),
    dict(d=2.6, bg="street", sub="The bakery, the plumber, the clinic on the corner."),
    dict(d=2.6, bg="street", dim=True, sub="Each owner behind those signs stops one day, and somebody buys what they built."),
    dict(d=2.4, card="More and more, that somebody is private equity."),
    dict(d=2.6, sub="Their buyers skip the listings and call the owner first."),
    dict(d=2.4, card="You were taught to compete with the business next door.", size=64),
    dict(d=1.8, card="The smart money buys it.", hit=True),
    *disqualify(),
    *mechanism(),
    *proof(),
    dict(d=2.0, card="Every sign changes one day."),
    dict(d=2.4, card="Make sure some of them carry your name.", hit=True),
    *cta(),
]
MUSIC = [(0, 1), (5, 2), (14, 3), (28, 4), (40, 5)]

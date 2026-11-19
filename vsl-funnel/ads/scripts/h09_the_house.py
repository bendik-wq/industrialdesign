# H09 · The house. Belief: buying a business is as normal as buying a house; lenders fund the cash flow.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "The house"
SCRIPT = [
    dict(d=2.4, card="You'd buy a house someone else built.", bg="street"),
    dict(d=1.6, card="Nobody thinks twice.", bg="street"),
    dict(d=2.8, card="Yet owners think their next business has to be built from scratch.", size=60, hit=True),
    dict(d=2.6, sub="A house comes with a mortgage against its value."),
    dict(d=2.8, sub="Buy a business, and the bank lends against its cash flow instead."),
    dict(d=2.2, card="Same idea. Bigger asset.", hit=True),
    *disqualify(),
    *mechanism(),
    *proof(),
    dict(d=2.2, card="You already know how to buy a house."),
    dict(d=2.4, card="Learn to buy a business the same way.", hit=True),
    *cta(),
]
MUSIC = [(0, 1), (5, 2), (12, 3), (22, 4), (34, 5)]

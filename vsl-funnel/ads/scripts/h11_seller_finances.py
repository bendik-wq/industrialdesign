# H11 · The seller finances it. Belief: the seller can fund your purchase of their business.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "The seller finances it"
SCRIPT = [
    dict(d=2.8, card="The person selling a business can be the one who finances it.", size=62),
    dict(d=1.6, card="Read that again.", hit=True),
    dict(d=2.6, sub="It's called seller finance. The seller is paid over time,"),
    dict(d=2.4, sub="out of the profits of the business they sold you."),
    dict(d=2.8, sub="Add seller rollover, and the seller keeps a slice and gets paid twice."),
    dict(d=2.6, card="Josh Li's first two acquisitions were 100% seller financed.", size=62, bg="key"),
    dict(d=2.0, card="None of his own money went in.", bg="key", hit=True),
    *disqualify(),
    *mechanism(),
    dict(d=2.4, card="Your next acquisition has a seller."),
    dict(d=2.4, card="Learn how to make them your lender.", hit=True),
    *cta(),
]
MUSIC = [(0, 1), (4, 2), (10, 3), (20, 4), (32, 5)]

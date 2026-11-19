# H05 · 100%. Belief: one business is one point of failure; owners who build groups spread the risk.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "One hundred percent"
SCRIPT = [
    dict(d=2.6, card="What share of business owners stop working one day?", size=64),
    dict(d=1.8, card="100%.", big=True, hit=True, vo="One hundred percent."),
    dict(d=1.8, card="Not ninety-nine. All of them.", vo="Not ninety-nine percent, every single one of them."),
    dict(d=2.4, card="The only choice is what you own when you stop."),
    dict(d=0.5),
    dict(d=2.6, card="You were told the business is your retirement plan.", size=64),
    dict(d=2.8, bg="squares", n=1, sub="One business is one point of failure."),
    dict(d=3.2, bg="squares", n=1, sub="A key customer leaves, a manager quits, a bad year lands right before you sell."),
    dict(d=2.8, bg="squares", n=4, sub="Owners who build groups spread that risk across several businesses."),
    dict(d=2.4, card="And a group sells at a bigger multiple than any one of them.", size=64, hit=True),
    *disqualify(),
    *mechanism(),
    *proof(),
    dict(d=2.4, card="100% of owners stop one day."),
    dict(d=2.4, card="Decide now what you'll own when you do.", hit=True),
    *cta(),
]
MUSIC = [(0, 1), (4, 2), (12, 3), (24, 4), (38, 5)]
DARK = [(12, 22)]

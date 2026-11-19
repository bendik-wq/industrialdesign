# H10 · Banks lend. Belief: you don't need a big deposit; banks reject structures, not buyers.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "Banks lend"
SCRIPT = [
    dict(d=2.6, card="Banks lend money to buy businesses every single day.", size=64),
    dict(d=2.0, card="Nobody told you that.", hit=True),
    dict(d=2.8, sub="You were told you need a huge deposit before you can buy anything."),
    dict(d=2.6, sub="A lender looks at the target's cash flow, then at the structure."),
    dict(d=1.8, card="Banks don't reject buyers.", bg="ledger"),
    dict(d=2.0, card="They reject structures.", bg="ledger", hit=True),
    *disqualify(),
    *mechanism(),
    *proof(),
    dict(d=2.4, card="The money to buy your next business exists."),
    dict(d=2.4, card="Build the structure that unlocks it.", hit=True),
    *cta(),
]
MUSIC = [(0, 1), (4, 2), (10, 3), (20, 4), (32, 5)]

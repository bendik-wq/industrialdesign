# H13 · The keys. Belief: owning one business is a job; owning several is a group.
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "The keys"
SCRIPT = [
    dict(d=2.4, card="You will hand over the keys one day.", bg="key"),
    dict(d=2.6, card="The only question is how many sets you'll hand over.", bg="key", hit=True),
    dict(d=2.6, sub="One set means you owned a job, however good it was."),
    dict(d=2.6, sub="Several sets means you built a group that runs without you."),
    dict(d=2.4, card="Groups sell at bigger multiples than single businesses.", size=64, hit=True),
    *disqualify(),
    *mechanism(),
    *proof(),
    dict(d=2.4, card="When you hand over the keys,"),
    dict(d=2.4, card="hand over a whole ring of them.", hit=True),
    *cta(),
]
MUSIC = [(0, 1), (4, 2), (10, 3), (20, 4), (32, 5)]

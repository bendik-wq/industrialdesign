# A1 · "1 in 1" — flagship story ad (~95 s). Structure modelled on ref D (bookended odds hook,
# fragmented cards, one controlling motif = THE KEY, villain, historical authority, mechanism,
# proof, desire montage, white identity card). Proof: only approved facts (WEBINAR-NOTES.md).
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import disqualify, mechanism, proof, cta
TITLE = "1 in 1"
SCRIPT = [
    # --- hook (bookend opens) ---
    dict(d=3.2, card="Do you know the odds you'll leave your business one day?", size=66),
    dict(d=2.0, card="1 in 1.", big=True, hit=True, vo="One in one, and that's guaranteed."),
    dict(d=1.7, card="That's guaranteed.", vo=""),
    dict(d=1.4, card="You'll sell it.", bg="key", vo="You'll sell it, hand it down, or close the doors."),
    dict(d=1.4, card="Hand it down.", bg="key", vo=""),
    dict(d=1.9, card="Or close the doors.", bg="key", vo=""),
    dict(d=0.5),
    dict(d=2.6, bg="street", sub="Every owner on your street will do the same."),
    dict(d=2.6, bg="street", dim=True, sub="One by one, the keys change hands."),
    dict(d=2.4, bg="street", sub="Somebody is going to own what they built."),
    dict(d=1.8, card="The only question that matters:"),
    dict(d=2.2, card="will that somebody be you?", hit=True),
    dict(d=0.5),
    # --- historical authority ---
    dict(d=1.5, card="For over a hundred years,", bg="ledger"),
    dict(d=2.0, card="the biggest companies weren't only built.", bg="ledger"),
    dict(d=1.8, card="They were bought.", bg="ledger", hit=True),
    dict(d=2.6, bg="ledger", sub="Rockefeller bought out rival refineries."),
    dict(d=2.4, bg="ledger", sub="Buffett buys whole companies."),
    # --- villain (hard cut) ---
    dict(d=0.6),
    dict(d=1.5, card="Then someone told you"),
    dict(d=1.3, card="the only way to grow"),
    dict(d=1.8, card="was to work harder."),
    dict(d=2.6, bg="squares", n=18, sub="Longer hours, a bigger team, another ad budget."),
    dict(d=2.2, bg="squares", n=34, sub="One customer at a time."),
    dict(d=2.6, bg="squares", n=52, sub="52 Saturdays a year.", tick=True),
    dict(d=2.8, sub="And when it didn't grow fast enough, you thought it was you."),
    dict(d=2.2, sub="You may have even believed it."),
    dict(d=0.6),
    # --- belief shift ---
        dict(d=2.2, card="Growth isn't only something you build."),
    dict(d=1.8, card="You can buy it.", hit=True),
    dict(d=3.0, bg="clock", sub="Somewhere near you, an owner spent decades building the customers, the team, the name."),
    dict(d=2.4, card="And you don't need the cash to buy it.", hit=True),
    *disqualify(),
    *mechanism(),
    # --- proof (approved facts only) ---
    *proof(),
    # --- desire montage (the reach) ---
    dict(d=1.6, bg="warm", sub="The second site."),
    dict(d=1.7, bg="warm", sub="The van with your name on it."),
    dict(d=1.9, bg="warm", sub="The competitor who's now your team."),
    dict(d=2.2, bg="warm", sub="The Saturday that's yours again."),
    dict(d=2.2, card="Be the one who buys.", bg="warm"),
    dict(d=0.6),
    # --- bookend closes ---
    dict(d=2.8, card="The odds you'll leave your business are 1 in 1.", size=64),
    dict(d=2.2, card="But the odds you're the one buying?"),
    dict(d=0.9, card="That", vo=""),
    dict(d=1.6, card="That part starts here."),
    *cta(),
]

# Score: (seconds, level 0-5). Quiet piano hook → street builds → authority swells →
# villain drops dark → belief shift climbs → proof → full at the reach → solo piano bookend.
MUSIC = [(0, 1), (12.0, 2), (23.8, 3), (34.7, 1), (44.0, 2), (52.1, 3), (60.0, 4), (73.8, 5), (84.0, 1)]
DARK = [(34.7, 52.1)]

"""Shared blocks for the hook-bank ads. Wording here is compliance-checked once (house rules:
funding names debt + seller finance + seller rollover; only Josh's approved proof; never "free")."""

def disqualify():
    # X Opener: business criteria only, never a personal attribute; no shaming.
    return [
        dict(d=2.8, card="This is for owners of profitable businesses doing $1M+ a year.", size=62),
        dict(d=2.4, card="Under that, grow the core business first. This isn't for you yet.", size=58),
    ]

def mechanism():
    return [
        dict(d=2.6, bg="ledger", sub="The bank lends against the target's own cash flow."),
        dict(d=2.8, bg="ledger", sub="The seller finances part of the price and rolls part of it over."),
        dict(d=2.8, bg="ledger", sub="When the profit covers the repayments 1.5x, the business pays for itself."),
    ]

def proof():
    return [
        dict(d=2.8, card="Josh Li bought his first two companies this way.", size=64, bg="key"),
        dict(d=2.2, card="Both 100% seller financed.", size=64, bg="key", note="Josh Li · founder, JC Health Group"),
    ]

def cta():
    return [
        dict(d=2.8, bg="white", card="Apply to see if you qualify.", size=66, hold=True, note="If it's a fit, our team books your strategy call."),
        dict(d=3.0, bg="white", card="G&L M&A Advisory", size=60, note="Profitable businesses · $1M+ a year · US & Australia", hold=True),
    ]

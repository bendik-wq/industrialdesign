# Usage: python3 viz.py <name>   -> adds a "viz" HTML block to each section in tl_<name>.json
# Every element carries data-at (seconds) resolved from the word Josh says, so graphics land on the spoken cue.
import json, re, sys

N = sys.argv[1]
TL = json.load(open(f"tl_{N}.json"))
WORDS = [w for line in TL["chunks"] for w in line]
norm = lambda s: re.sub(r"[^a-z0-9%$.]", "", s.lower().replace("-", " ").strip(".,?!;:"))


def sec_words(k):
    a = TL["secs"][k]["t"] - 0.3
    b = TL["secs"][k + 1]["t"] - 0.3 if k + 1 < len(TL["secs"]) else 1e9
    return [w for w in WORDS if a <= w["s"] < b]


NUM = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10", "twenty": "20", "seventy": "70", "sixty": "60", "forty": "40", "ninety": "90", "thirteen": "13", "hundred": "100"}


def at(k, phrase, nth=1, off=0.0):
    """Time Josh starts saying `phrase` in section k (nth occurrence). Number words also match digits."""
    try:
        return _at(k, phrase, nth, off)
    except SystemExit:
        alt = " ".join(NUM.get(w, w) for w in phrase.split())
        if alt == phrase:
            raise
        return _at(k, alt, nth, off)


def _at(k, phrase, nth=1, off=0.0):
    ws = sec_words(k)
    toks = [norm(x) for x in re.split(r"[\s-]+", phrase) if norm(x)]
    flat = []
    for i, w in enumerate(ws):
        for p in re.split(r"[\s-]+", w["w"]):
            if norm(p):
                flat.append((norm(p), i))
    seen = 0
    for j in range(len(flat) - len(toks) + 1):
        if [f[0] for f in flat[j:j + len(toks)]] == toks:
            seen += 1
            if seen == nth:
                return round(ws[flat[j][1]]["s"] + off, 3)
    raise SystemExit(f"cue not found in {N} section {k}: {phrase!r}\n" + " ".join(w["w"] for w in ws))


def A(t, fx="up", d=None, **kw):
    s = f' data-at="{t}" data-fx="{fx}"' + (f' data-d="{d}"' if d else "")
    return s + "".join(f' data-{k}="{v}"' for k, v in kw.items())


H = lambda s: s  # readability marker for raw HTML


# ── components ──────────────────────────────────────────────────────────────
def chips(items):
    """items: (t, value_html, label, gold)"""
    cells = "".join(f'<div class="vc{" gold" if g else ""}" style="flex:1;opacity:0"{A(t, "pop", 0.7)}><div class="big{" g" if g else ""}">{v}</div><div class="lbl">{l}</div></div>' for t, v, l, g in items)
    return f'<div class="vrow" style="height:auto;margin-top:40px">{cells}</div>'


def checklist(items, title=None, cross=False):
    rows = "".join(f'<div class="li" style="opacity:0"{A(t, "left")}><div class="{"cross" if cross else "tick"}">{"✕" if cross else "✓"}</div><div class="t26">{x}</div></div>' for t, x in items)
    head = f'<div class="k">{title}</div>' if title else ""
    return f'<div class="vcol" style="max-width:880px">{head}{rows}</div>'


def cards3(items, strike_at=None, win_at=None):
    """items: (t, kicker, title, body); the third card wins when strike_at is set"""
    out = []
    for i, (t, kk, ti, body) in enumerate(items):
        third = i == 2 and win_at
        inner = f'<div class="k">{kk}</div><div class="t26" style="font-size:30px">{ti}</div><div class="t22" style="margin-top:12px">{body}</div>'
        if strike_at and i < 2:
            out.append(f'<div style="flex:1;opacity:0"{A(t, "pop", 0.7)}><div class="vc" style="height:100%"{A(strike_at, "dim", 0.6)}>{inner}<div class="strike"{A(strike_at + 0.15 * i, "strike", 0.5)}></div></div></div>')
        elif third:
            out.append(f'<div style="flex:1;opacity:0"{A(t, "pop", 0.8)}><div class="vc" style="height:100%"{A(win_at, "gold", 0.8)}>{inner}</div></div>')
        else:
            out.append(f'<div class="vc" style="flex:1;opacity:0"{A(t, "pop", 0.7)}>{inner}</div>')
    return f'<div class="vrow" style="height:330px;margin-top:20px">{"".join(out)}</div>'


def stack(parts, price_at=None, price_label="Price $1.5M", total=None, scale=1.6, cash_at=None):
    """Vertical funding stack. parts: (t, label, amount, value_$M, colour). The bar spans `scale` $M."""
    bar_h, y, segs = 420, 0.0, []
    for t, lab, amt, v, col in parts:
        h = v / scale * bar_h
        segs.append(f'<div style="position:absolute;left:0;right:0;bottom:{y:.1f}px;height:{h:.1f}px;display:flex;align-items:flex-end">'
                    f'<div class="seg" style="position:relative;width:100%;height:0;background:{col};border-top:2px solid rgba(11,20,51,.35)"{A(t, "grow", 0.8, v=100, dim="h")}>'
                    f'<span>{lab}</span><b>{amt}</b></div></div>')
        y += h
    price = ""
    if price_at:
        py = 1.5 / scale * bar_h
        price = (f'<div style="position:absolute;left:-14px;width:468px;bottom:{py:.1f}px;border-top:3px dashed #f6f3ec;opacity:0"{A(price_at, "fade")}>'
                 f'<span style="position:absolute;left:484px;top:-17px;font:500 24px Inter;color:#f6f3ec;white-space:nowrap">{price_label}</span></div>')
    side = ""
    if total:
        tt, html = total
        side += f'<div class="vc gold" style="opacity:0"{A(tt, "pop", 0.7)}>{html}</div>'
    if cash_at:
        side += f'<div class="vc" style="opacity:0"{A(cash_at, "pop", 0.7)}><div class="k">Your cash in the deal</div><div class="big g">$0</div></div>'
    return (f'<div class="vrow"><div style="position:relative;width:440px;height:{bar_h}px;margin-top:24px;border-bottom:2px solid rgba(255,255,255,.3)">{"".join(segs)}{price}</div>'
            f'<div class="vcol" style="flex:1;padding:120px 0 0 230px;justify-content:flex-end;gap:16px">{side}</div></div>')


def timeline(phases, marker):
    """phases: (t, weeks, title, width%)"""
    segs, left = [], 0
    for t, wk, ti, w in phases:
        segs.append(f'<div style="position:absolute;left:{left}%;width:{w}%;top:0;padding-right:10px;opacity:0"{A(t, "up")}><div style="height:14px;border-radius:7px;background:#e2b44b;opacity:.9"></div><div class="k" style="margin-top:22px">{wk}</div><div class="t26">{ti}</div></div>')
        left += w
    m_t0, m_t1 = marker
    mk = f'<div style="position:absolute;top:-13px;left:0;width:40px;height:40px;margin-left:-20px;border-radius:50%;background:#f6f3ec;box-shadow:0 0 0 8px rgba(246,243,236,.18);opacity:0"{A(m_t0, "mark", round(m_t1 - m_t0, 2), **{"from": 0, "to": 100})}></div>'
    return f'<div style="position:relative;margin-top:110px;height:200px">{"".join(segs)}{mk}</div>'


# ── sections ────────────────────────────────────────────────────────────────
V = {}
if N == "main":
    V[0] = chips([(at(0, "doubling"), "2–3x", "the size of your business", False), (at(0, "none of their own"), "$0", "of your own money in", True), (at(0, "ninety days"), "90", "days to a signed LOI", False)])
    V[1] = chips([(at(1, "founder"), "JC", "Health Group, founder", False), (at(1, "two of them"), "2", "businesses acquired", False), (at(1, "one hundred percent"), "100%", "seller financed", True)])
    c = [at(2, "marketing"), at(2, "another hire"), at(2, "own time")]
    V[2] = (f'<svg width="1000" height="440" viewBox="0 0 1000 440" style="overflow:visible">'
            f'<line x1="40" y1="400" x2="980" y2="400" stroke="rgba(255,255,255,.25)" stroke-width="2"/>'
            f'<line x1="40" y1="110" x2="980" y2="110" stroke="#e46a5a" stroke-width="3" stroke-dasharray="12 10" style="opacity:0"{A(at(2, "growth has"), "fade")}/>'
            f'<text x="980" y="92" text-anchor="end" font-family="Inter" font-size="22" fill="#e46a5a" style="opacity:0"{A(at(2, "growth has"), "fade")}>THE CEILING</text>'
            f'<path d="M40 390 C 260 330, 420 190, 600 145 S 900 122, 980 120" fill="none" stroke="#e2b44b" stroke-width="6" stroke-linecap="round"{A(at(2, "you have built", off=0) if False else at(2, "built something"), "draw", 6)}/>'
            + "".join(f'<g style="opacity:0"{A(t, "up")}><rect x="{x}" y="{y}" width="230" height="56" rx="28" fill="rgba(255,255,255,.08)" stroke="rgba(255,255,255,.2)"/><text x="{x + 115}" y="{y + 36}" text-anchor="middle" font-family="Inter" font-size="22" fill="#f1efe9">{lab}</text></g>'
                      for t, x, y, lab in [(c[0], 120, 180, "+ more marketing"), (c[1], 390, 250, "+ another hire"), (c[2], 660, 300, "+ more of your time")]) + "</svg>")
    V[3] = cards3([(at(3, "the first"), "Path 1", "Keep grinding", "More ads, more hires. Slow, and it takes years."),
                   (at(3, "the second"), "Path 2", "Raise money", "Give away equity and answer to investors."),
                   (at(3, "a third way"), "Path 3", "Buy a business", "Paid for by the seller and the bank, from its own cash flow.")],
                  strike_at=at(3, "a third way"), win_at=at(3, "a third way", off=0.3))
    V[4] = (f'<div class="vrow"><div style="flex:1.1;position:relative">'
            f'<svg width="560" height="440" viewBox="0 0 560 440"><line x1="0" y1="120" x2="560" y2="120" stroke="#5f8fd6" stroke-width="3" style="opacity:0"{A(at(4, "never go"), "fade")}/>'
            f'<path d="M210 120 L280 40 L350 120 Z" fill="#f6f3ec" style="opacity:0"{A(at(4, "never go"), "up")}/>'
            f'<path d="M210 120 L350 120 L470 260 L420 420 L130 420 L80 270 Z" fill="rgba(226,180,75,.85)" style="opacity:0"{A(at(4, "never appear"), "up", 0.9)}/>'
            f'<text x="380" y="80" font-family="Inter" font-size="22" fill="#f6f3ec" style="opacity:0"{A(at(4, "never go"), "fade")}>Listed for sale</text>'
            f'<text x="275" y="300" text-anchor="middle" font-family="Inter" font-size="26" font-weight="600" fill="#0b1433" style="opacity:0"{A(at(4, "never appear"), "fade")}>Off market</text>'
            f'<text x="275" y="336" text-anchor="middle" font-family="Inter" font-size="20" fill="#0b1433" style="opacity:0"{A(at(4, "never appear"), "fade")}>retiring owners, no successor</text></svg></div>'
            f'<div class="vcol" style="flex:1;justify-content:center"><div class="vc gold" style="opacity:0"{A(at(4, "have you ever"), "pop", 0.7)}><div class="k">The golden question</div><div style="font:400 44px/1.1 IS,serif;color:#f6f3ec">“Have you ever thought about selling?”</div></div>'
            f'<div class="vc" style="opacity:0"{A(at(4, "they pick the buyer"), "up")}><div class="t26">They pick the buyer they trust.</div></div></div></div>')
    V[5] = checklist([(at(5, "a team"), "A team"), (at(5, "systems"), "Systems"), (at(5, "a track record"), "A track record"), (at(5, "and profit"), "Profit"), (at(5, "obvious successor"), "The obvious successor to a retiring owner")], title="What you already have")
    pil = [(at(6, "the first c"), "C1", "Capabilities", "The right people in the room", 72), (at(6, "the second c"), "C2", "Capital", "Seller and lender fund it", 86), (at(6, "the third c"), "C3", "Closing", "Off market, on your timeline", 100)]
    V[6] = '<div class="vrow" style="align-items:flex-end;height:440px">' + "".join(
        f'<div style="flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end"><div class="vc{" gold" if i == 2 else ""}" style="height:0;padding:0 24px;display:flex;flex-direction:column;justify-content:flex-start"{A(t, "grow", 0.9, v=h, dim="h")}><div class="big g" style="margin-top:26px">{c1}</div><div class="t26" style="margin-top:10px;font-size:30px">{ti}</div><div class="t22" style="margin-top:8px">{b}</div></div></div>'
        for i, (t, c1, ti, b, h) in enumerate(pil)) + "</div>"
    V[7] = stack([(at(7, "a lender funds"), "Lender", "most", 1.05, "#e2b44b"), (at(7, "the seller carries"), "Seller", "the rest", 0.45, "#f6f3ec"), (at(7, "working capital line"), "Working capital", "on top", 0.10, "#9db7e8")],
                 price_at=at(7, "a price of"), total=(at(7, "more funding than"), '<div class="k">Over-financed</div><div class="big">$1.6M</div><div class="lbl">of funding for a $1.5M price</div>'),
                 scale=1.75) + f'<div class="vc gold" style="position:absolute;right:0;top:-6px;opacity:0"{A(at(7, "one and a half times"), "pop", 0.7)}><div class="k">The rule</div><div class="big g">1.5x</div><div class="lbl">profit over repayments</div></div>'
    V[8] = '<div class="vcol" style="gap:12px">' + "".join(
        f'<div class="li" style="opacity:0;justify-content:space-between"{A(t, "left")}><div class="t26" style="color:#b9bdd3">{q}</div><div class="t26 g" style="text-align:right">{a}</div></div>'
        for t, q, a in [(at(8, "will the bank"), "Will the bank go for it?", "Financing lined up before the LOI"), (at(8, "own cash in"), "Do I put my own cash in?", "No. $0"), (at(8, "have the time"), "Do I have the time?", "A few focused hours a week"), (at(8, "distract me"), "Will it distract me?", "Integration plan from day one")]) + "</div>"
    V[9] = timeline([(at(9, "weeks one and two"), "Weeks 1–2", "Audit and target profile", 16), (at(9, "weeks three to eight"), "Weeks 3–8", "Owner outreach, coached", 46), (at(9, "weeks nine to thirteen"), "Weeks 9–13", "Negotiate, finance, sign the LOI", 38)],
                    (at(9, "weeks one and two"), at(9, "sign the letter", off=1.0)))
    V[10] = ('<div class="vrow" style="align-items:center;height:330px;margin-top:30px">'
             f'<div class="vc" style="flex:1;opacity:0"{A(at(10, "adding its profit"), "pop", 0.7)}><div class="k">Profit</div><div class="big">↑</div><div class="lbl">theirs joins yours</div></div>'
             f'<div class="big muted" style="opacity:0"{A(at(10, "adding its profit"), "fade")}>×</div>'
             f'<div class="vc" style="flex:1;opacity:0"{A(at(10, "lifting what"), "pop", 0.7)}><div class="k">Multiple</div><div class="big">↑</div><div class="lbl">bigger groups often earn more</div></div>'
             f'<div class="big muted" style="opacity:0"{A(at(10, "lifting what"), "fade")}>=</div>'
             f'<div class="vc gold" style="flex:1.2;opacity:0"{A(at(10, "exit value"), "pop", 0.8)}><div class="k">Exit value</div><div class="big g">↑↑</div><div class="lbl">two levers at once</div></div></div>')
    stay = [(at(11, "another year of growing"), "Growing one customer at a time"), (at(11, "own shoulders"), "Carrying everything yourself"), (at(11, "competitor buys"), "A competitor buys your target")]
    nxt = [(at(11, "two businesses"), "Two businesses"), (at(11, "combined profit"), "Combined profit"), (at(11, "stronger team"), "A stronger team"), (at(11, "worth far more"), "Worth far more")]
    V[11] = ('<div class="vrow">'
             f'<div class="vcol" style="flex:1"><div class="k muted">If you wait</div>' + "".join(f'<div class="li" style="opacity:0"{A(t, "left")}><div class="cross">✕</div><div class="t22">{x}</div></div>' for t, x in stay) + '</div>'
             f'<div class="vcol" style="flex:1"><div class="k">This time next year</div>' + "".join(f'<div class="li" style="opacity:0"{A(t, "left")}><div class="tick">✓</div><div class="t22" style="color:#f6f3ec">{x}</div></div>' for t, x in nxt) + '</div></div>')
    V[12] = ('<div class="vrow" style="height:auto">' + "".join(
        f'<div class="vc" style="flex:1;opacity:0;padding:20px 22px"{A(t, "pop", 0.7)}><div class="k">Step {i + 1}</div><div class="t26">{x}</div></div>'
        for i, (t, x) in enumerate([(at(12, "ten quick"), "Answer 10 questions (2 min)"), (at(12, "strategy call"), "Strategy call with my team"), (at(12, "seven days"), "7-day money-back guarantee")])) + "</div>")

if N == "breakout":
    V[0] = checklist([(at(0, "what the seller carries"), "What the seller carries"), (at(0, "what the bank funds"), "What the bank funds"), (at(0, "credible buyer"), "Why you're the credible buyer"), (at(0, "is worth"), "What it does to your company's value")], title="In this video")
    V[1] = ('<div class="vrow"><div class="vc" style="flex:1"><div class="k">The target</div>' + "".join(
        f'<div style="display:flex;justify-content:space-between;align-items:baseline;padding:13px 0;border-bottom:1px solid rgba(255,255,255,.1);opacity:0"{A(t, "left")}><span class="t22">{a}</span><span class="t26">{b}</span></div>'
        for t, a, b in [(at(1, "five hundred thousand"), "Profit (EBITDA)", "$500k a year"), (at(1, "sixties"), "Owner", "60s, retiring"), (at(1, "nda"), "NDA", "Signed ✓"), (at(1, "three years"), "Financials and tax returns", "3 years ✓")]) + '</div>'
        f'<div class="vcol" style="width:340px"><div class="vc gold" style="opacity:0"{A(at(1, "a price of"), "pop", 0.7)}><div class="k">Agreed price</div><div class="big">$<span{A(at(1, "a price of"), "count", 1.2, **{"from": 0, "to": 1.5, "dec": 1})}>0</span>M</div></div>'
        f'<div class="vc" style="opacity:0"{A(at(1, "three times profit"), "pop", 0.7)}><div class="k">Multiple</div><div class="big g">3x</div><div class="lbl">profit, normal at this size</div></div></div></div>')
    V[2] = stack([(at(2, "seventy percent", nth=1), "Bank debt 70%", "$1.05M", 1.05, "#e2b44b"), (at(2, "twenty percent"), "Seller note 20%", "$300k", 0.30, "#f6f3ec"), (at(2, "last ten percent"), "Rollover 10%", "$150k", 0.15, "#c9a2e8")],
                 price_at=at(2, "one and a half million"), scale=1.75,
                 total=(at(2, "skin in the game"), '<div class="k">Seller keeps</div><div class="big">10%</div><div class="lbl">skin in the game after you take over</div>'))
    V[3] = stack([(at(3, "the piece", off=-0.6), "Bank debt 70%", "$1.05M", 1.05, "#e2b44b"), (at(3, "the piece", off=-0.6), "Seller note 20%", "$300k", 0.30, "#f6f3ec"), (at(3, "the piece", off=-0.6), "Rollover 10%", "$150k", 0.15, "#c9a2e8"), (at(3, "working capital line"), "Working capital", "$100k", 0.10, "#9db7e8")],
                 price_at=at(3, "the piece", off=-0.6), scale=1.75,
                 total=(at(3, "one point six"), '<div class="k">Total funding</div><div class="big">$1.6M</div><div class="lbl">for a $1.5M price</div>'), cash_at=at(3, "your own cash"))
    rows = [(at(4, "start with the bank"), at(4, "one hundred and ninety"), "Bank loan", "$1.05M · 8% · 7 years", 196),
            (at(4, "next, the seller note") if False else at(4, "the seller note"), at(4, "sixty eight"), "Seller note", "$300k · 5% · 5 years", 68),
            (at(4, "working capital line"), at(4, "about nine thousand"), "Working capital line", "$100k · 9% interest", 9)]
    V[4] = ('<table class="tbl">' + "".join(
        f'<tr style="opacity:0"{A(t, "left")}><td><div class="t26">{lab}</div><div class="t22 muted">{terms}</div></td><td class="r">$<span{A(t2, "count", 1.0, **{"from": 0, "to": v})}>0</span>k</td></tr>'
        for t, t2, lab, terms, v in rows)
        + f'<tr class="tot" style="opacity:0"{A(at(4, "add those together"), "up")}><td><div class="t26">Repayments per year</div><div class="t22 muted">Rollover is equity: no repayments</div></td><td class="r">$<span{A(at(4, "add those together"), "count", 1.4, **{"from": 0, "to": 273})}>0</span>k</td></tr></table>')
    gauge_max = 2.5
    pos = lambda x: round(x / gauge_max * 100, 2)
    V[5] = (f'<div class="vcol" style="gap:20px">'
            f'<div style="display:flex;align-items:baseline;gap:22px;opacity:0"{A(at(5, "five hundred thousand"), "up")}><span class="big">$500k</span><span class="big muted">÷</span><span class="big">$273k</span><span class="big muted">=</span><span class="big g"><span{A(at(5, "about one point eight"), "count", 1.2, **{"from": 0, "to": 1.83, "dec": 2})}>0.00</span>x</span></div>'
            f'<div style="position:relative;height:34px;border-radius:17px;background:rgba(255,255,255,.08);margin:26px 0 10px;opacity:0"{A(at(5, "five hundred thousand"), "fade")}>'
            f'<div style="position:absolute;left:0;top:0;bottom:0;border-radius:17px;background:linear-gradient(90deg,#b88a2a,#e2b44b);width:0"{A(at(5, "about one point eight"), "grow", 1.2, v=pos(1.83))}></div>'
            f'<div style="position:absolute;left:{pos(1.5)}%;top:-14px;bottom:-14px;width:4px;background:#f6f3ec;opacity:0"{A(at(5, "our minimum"), "fade")}><span style="position:absolute;top:-34px;left:50%;transform:translateX(-50%);font:500 20px Inter;white-space:nowrap">Minimum 1.5x</span></div></div>'
            f'<div class="vrow" style="height:auto;gap:16px">'
            f'<div class="vc" style="flex:1;opacity:0;padding:18px 22px"{A(at(5, "could carry up to"), "pop", 0.7)}><div class="k">Max repayments at 1.5x</div><div class="t26" style="font-size:34px">$333k <span class="muted" style="font-size:22px">vs $273k</span></div></div>'
            f'<div class="vc" style="flex:1;opacity:0;padding:18px 22px"{A(at(5, "stress test"), "pop", 0.7)}><div class="k">Stress test: profit −20%</div><div class="t26" style="font-size:34px">$400k ÷ $273k = <span{A(at(5, "one point four six"), "count", 1.0, **{"from": 0, "to": 1.46, "dec": 2})}>0.00</span>x</div></div>'
            f'<div class="vc gold" style="flex:1;opacity:0;padding:18px 22px"{A(at(5, "left over"), "pop", 0.7)}><div class="k">Left over each year</div><div class="t26" style="font-size:34px">$227k <span class="muted" style="font-size:20px">before tax</span></div></div>'
            f'</div></div>')
    def mini(parts):
        return '<div style="display:flex;height:26px;border-radius:6px;overflow:hidden;margin:14px 0 6px">' + "".join(f'<div style="width:{w}%;background:{c}"></div>' for w, c in parts) + "</div>"
    S = [(at(6, "most of their cash"), "Wants cash at settlement", "70 / 20 / 10", mini([(70, "#e2b44b"), (20, "#f6f3ec"), (10, "#c9a2e8")]), "Bank · seller note · rollover"),
         (at(6, "stay invested"), "Wants to stay invested", "60 / 40", mini([(60, "#e2b44b"), (40, "#c9a2e8")]), "Bank · rollover · no personal guarantee"),
         (at(6, "right successor"), "Wants the right successor", "100% VF", mini([(100, "#f6f3ec")]), "Vendor finance, paid over time")]
    V[6] = '<div class="vrow" style="height:340px;margin-top:10px">' + "".join(
        f'<div class="vc{" gold" if i == 2 else ""}" style="flex:1;opacity:0"{A(t, "pop", 0.7)}><div class="k">{who}</div><div class="big" style="font-size:58px">{name}</div>{bar}<div class="t22">{note}</div></div>'
        for i, (t, who, name, bar, note) in enumerate(S)) + "</div>"
    V[7] = checklist([(at(7, "a team"), "A team that can run it"), (at(7, "systems"), "Systems that can absorb it"), (at(7, "track record"), "A track record the bank can see"), (at(7, "add the right"), "The right advisers around you")], title="Why they back you")
    V[8] = ('<div class="vrow" style="align-items:flex-end;height:420px;gap:40px">'
            f'<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%"><div class="k">Your business</div><div style="height:0;background:#f6f3ec;border-radius:10px 10px 0 0;display:flex;align-items:flex-start;justify-content:center"{A(at(8, "as well"), "grow", 0.8, v=40, dim="h")}><span style="font:400 40px IS,serif;color:#0b1433;margin-top:14px">$500k</span></div></div>'
            f'<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%"><div class="k">After the deal</div><div style="height:0;background:#e2b44b;border-radius:10px 10px 0 0;display:flex;align-items:flex-start;justify-content:center"{A(at(8, "makes a million"), "grow", 1.0, v=80, dim="h")}><span style="font:400 40px IS,serif;color:#0b1433;margin-top:14px">$1M</span></div></div>'
            f'<div class="vcol" style="flex:1.2;justify-content:flex-end;height:100%"><div class="vc gold" style="opacity:0"{A(at(8, "higher multiple"), "pop", 0.7)}><div class="k">And the multiple</div><div class="t26">Bigger groups are often valued at a higher multiple of earnings</div></div>'
            f'<div class="vc" style="opacity:0"{A(at(8, "doubled your profit"), "pop", 0.7)}><div class="big g">2x</div><div class="lbl">profit, in one move</div></div></div></div>')
    fails = [(at(9, "only then go"), "Bank last: structure never bankable", at(9, "line up the financing"), "Financing lined up before the LOI"),
             (at(9, "broker auction"), "Broker auction, fifty buyers", at(9, "work off market"), "Off market, one buyer: you"),
             (at(9, "drags on"), "Diligence drags for months", at(9, "on a clock"), "The whole process on a clock")]
    V[9] = '<div class="vcol" style="gap:14px">' + "".join(
        f'<div class="li" style="opacity:0;justify-content:space-between"{A(t, "left")}><div style="display:flex;gap:16px;align-items:center"><div class="cross">✕</div><div class="t22">{a}</div></div>'
        f'<div style="display:flex;gap:16px;align-items:center;opacity:0"{A(t2, "up")}><div class="t22 g" style="text-align:right">{b}</div><div class="tick">✓</div></div></div>'
        for t, a, t2, b in fails) + "</div>"
    V[10] = ('<div class="vrow" style="height:auto">' + "".join(
        f'<div class="vc" style="flex:1;opacity:0;padding:20px 22px"{A(t, "pop", 0.7)}><div class="k">On the call</div><div class="t26">{x}</div></div>'
        for t, x in [(at(10, "your numbers"), "Your numbers and market"), (at(10, "target profile"), "Your target profile"), (at(10, "map the structure"), "The structure for deal one")]) + "</div>")

for k, html in V.items():
    TL["secs"][k]["viz"] = html
json.dump(TL, open(f"tl_{N}.json", "w"))
print(N, "viz on", len(V), "of", len(TL["secs"]), "sections")

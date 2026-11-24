"""v7: v6 + pattern-interrupt drawings that interact with Josh and the scene.
usage: python3 comp7.py [name...]"""
import sys, math
import numpy as np
from PIL import Image
import comp
from comp5 import grade
from comp6 import (Ink, seg, poly, circ, bank, xmark, check, person, battery, fill_rect, arrow,
                   WHITE, YEL, GRN, CYAN, ORG, RED, D, W, H)

PINK = (255, 110, 170)


# ---------- new figures ----------
def smooth(pts, n=12):
    out = []
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        for k in range(n):
            t = k / n
            out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    out.append(pts[-1])
    return out


def curve_pts(a, c, b, n=40):
    return [((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0],
             (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]) for t in [i / n for i in range(n + 1)]]


def flame(p, x, y, s=1.0, w=12):
    """Teardrop flame, base at (x, y)."""
    L = [(x - 90 * s, y), (x - 120 * s, y - 120 * s), (x - 60 * s, y - 230 * s), (x - 30 * s, y - 180 * s),
         (x, y - 330 * s), (x + 50 * s, y - 200 * s), (x + 80 * s, y - 250 * s), (x + 120 * s, y - 110 * s), (x + 90 * s, y), (x - 90 * s, y)]
    pts = []
    for i in range(len(L) - 1):
        a, b = L[i], L[i + 1]
        c = ((a[0] + b[0]) / 2 + (b[1] - a[1]) * 0.18, (a[1] + b[1]) / 2 - (b[0] - a[0]) * 0.18)
        pts += curve_pts(a, c, b, 14)
    p.stroke(pts, w, taper=False)


def bubble(p, x, y, w_, h_, tail, w=12, thought=False):
    cx, cy = x + w_ / 2, y + h_ / 2
    if thought:
        p.ellipse(cx, cy, w_ / 2, h_ / 2, rot=0, w=w, over=0.05)
        tx, ty = tail
        for k, r in enumerate((34, 22, 13)):
            f = 0.35 + k * 0.25
            circ(p, cx + (tx - cx) * f, cy + h_ / 2 * 0.9 + (ty - cy - h_ / 2) * f, r, w * 0.8)
    else:
        pts = []
        start, end = math.radians(70), math.radians(70 + 330)
        for i in range(81):
            t = start + (end - start) * i / 80
            pts.append((cx + w_ / 2 * math.cos(t), cy + h_ / 2 * math.sin(t)))
        pts = [tail] + pts + [tail]
        p.stroke(pts, w, taper=False)


def shock(p, hx0, hy0, hx1, hy1, w=14, n=7):
    """Radiating 'surprise' strokes around the head."""
    cx, cy = (hx0 + hx1) / 2, hy0 + (hy1 - hy0) * 0.55
    rx, ry = (hx1 - hx0) * 0.62, (hy1 - hy0) * 0.75
    angs = [150, 170, 190, 210, 330, 350, 10, 30]
    for a in angs:
        a = math.radians(a)
        x0, y0 = cx + rx * math.cos(a), cy + ry * math.sin(a)
        x1, y1 = cx + (rx + 130) * math.cos(a), cy + (ry + 130) * math.sin(a)
        seg(p, (x0, y0), (x1, y1), w, n=10)


def key(p, x, y, s=1.0, ang=70, w=11):
    a = math.radians(ang)
    ux, uy = math.cos(a), math.sin(a)
    vx, vy = -uy, ux
    circ(p, x, y, 70 * s, w)
    sx, sy = x + ux * 70 * s, y + uy * 70 * s
    ex, ey = x + ux * 330 * s, y + uy * 330 * s
    seg(p, (sx, sy), (ex, ey), w)
    for d in (250, 300):
        bx, by = x + ux * d * s, y + uy * d * s
        seg(p, (bx, by), (bx + vx * 55 * s, by + vy * 55 * s), w)


def tally(p, x, y, n=20, h=150, w=11):
    gx = x
    for g in range(n // 5):
        for k in range(4):
            seg(p, (gx + k * 38, y), (gx + k * 38 + 6, y + h), w, n=8)
        seg(p, (gx - 25, y + h * 0.75), (gx + 4 * 38 - 5, y + h * 0.2), w, n=10)
        gx += 230


def runner(p, x, y, s=1.0, w=10):
    circ(p, x + 30 * s, y, 34 * s, w)
    hip = (x - 20 * s, y + 170 * s)
    seg(p, (x + 20 * s, y + 40 * s), hip, w)
    poly(p, [hip, (x + 40 * s, y + 230 * s), (x + 20 * s, y + 310 * s)], w)
    poly(p, [hip, (x - 70 * s, y + 230 * s), (x - 130 * s, y + 280 * s)], w)
    poly(p, [(x + 10 * s, y + 80 * s), (x + 80 * s, y + 130 * s), (x + 120 * s, y + 90 * s)], w)
    poly(p, [(x + 10 * s, y + 80 * s), (x - 60 * s, y + 110 * s), (x - 90 * s, y + 60 * s)], w)
    for k in range(3):
        seg(p, (x - 170 * s - k * 10, y + (60 + k * 70) * s), (x - 260 * s - k * 10, y + (60 + k * 70) * s), w * 0.8, n=6)


def door(p, x, y, w_=300, h_=520, w=12):
    poly(p, [(x, y + h_), (x, y), (x + w_, y), (x + w_, y + h_)], w)
    poly(p, [(x + w_, y + h_), (x + w_ * 1.45, y + h_ * 0.92), (x + w_ * 1.45, y + h_ * 0.05), (x + w_, y)], w)
    circ(p, x + w_ * 1.32, y + h_ * 0.52, 12, w)


def face(p, cx, cy, happy=True, s=1.0, w=11):
    circ(p, cx - 55 * s, cy, 9 * s, w); circ(p, cx + 55 * s, cy, 9 * s, w)
    k = 1 if happy else -1
    pts = [(cx - 70 * s + 140 * s * i / 20, cy + 60 * s + k * math.sin(math.pi * i / 20) * 40 * s - (0 if happy else -40 * s)) for i in range(21)]
    p.stroke(pts, w, taper=False)


def tag(p, x, y, w_=420, h_=200, w=12):
    poly(p, [(x, y + h_ / 2), (x + 90, y), (x + w_, y), (x + w_, y + h_), (x + 90, y + h_), (x, y + h_ / 2)], w)
    circ(p, x + 85, y + h_ / 2, 18, w * 0.8)


def zzz(ink, x, y, col):
    for k, (dx, dy, s) in enumerate(((0, 0, 130), (120, -150, 170), (270, -330, 220))):
        ink.text(x + dx, y + dy, 'Z', s, col, rot=-10)


def sparkle(p, x, y, r=60, w=10):
    seg(p, (x - r, y), (x + r, y), w, n=8); seg(p, (x, y - r), (x, y + r), w, n=8)


# ---------- concepts ----------
def c_100m(ink, HD):
    a = ink.text(150, 130, '$1M', 430, rot=4)
    ink.draw(lambda p: xmark(p, a[2] + 250, (a[1] + a[3]) / 2 + 60), RED)
    b = ink.text(2580, 110, '$100M', 410, YEL, rot=-3)
    ink.draw(lambda p: check(p, b[0] - 330, (b[1] + b[3]) / 2 - 20), GRN)
    # grumpy little bank under $1M, happy big bank under $100M
    ink.draw(lambda p: bank(p, 260, 860, 0.55), WHITE)
    ink.draw(lambda p: bubble(p, 640, 600, 420, 240, (640, 900)), WHITE)
    ink.text(715, 620, 'NO.', 170, RED)
    ink.draw(lambda p: bank(p, 2980, 1160, 1.05), WHITE)
    ink.draw(lambda p: bubble(p, 3080, 760, 560, 280, (3200, 1100)), WHITE)
    ink.text(3150, 790, 'YES!!', 190, GRN, rot=-4)
    ink.draw(lambda p: (sparkle(p, 2880, 1200), sparkle(p, 3700, 1180, 45)), YEL)


def c_zero(ink, HD):
    a = ink.text(160, 220, '$0', 540, YEL, rot=2)
    ink.text(a[2] + 60, 290, 'DOWN', 440, rot=2)
    ink.text(190, 880, '2 COMPANIES', 240, rot=1)
    ink.text(220, 1250, 'both 100% seller financed', 140, CYAN, rot=-1)
    ink.draw(lambda p: arrow(p, (1650, 1330), (2250, 1350), (2560, 1520)), WHITE)
    # two keys dangling from his gesturing hand
    hx, hy = 2660, 1500
    ink.draw(lambda p: (key(p, hx, hy, 1.0, 100), key(p, hx + 120, hy + 40, 0.9, 75)), YEL)
    ink.text(hx + 380, hy + 120, '#1  #2', 130, YEL, rot=-6)


def c_banker(ink, HD):
    ink.text(170, 240, 'YOUR BANK', 300, rot=-2)
    b = ink.text(170, 560, 'SAID NO?', 480, YEL, rot=-2)
    ink.draw(lambda p: p.underline(190, b[2] - 60, b[3] + 40, w=14), WHITE)
    ink.draw(lambda p: bank(p, 300, 1380, 0.85), WHITE)
    ink.draw(lambda p: bubble(p, 800, 1250, 560, 300, (760, 1520)), WHITE)
    ink.text(870, 1280, 'NOPE.', 190, RED, rot=-3)
    ink.draw(lambda p: shock(p, *HD), YEL)
    ink.text(1500, 1650, "here's why", 140, CYAN, rot=-4)


def c_firesale(ink, HD):
    ink.text(160, 180, 'BUY THE', 280, rot=-2)
    b = ink.text(160, 450, 'FIRE SALE', 430, ORG, rot=-2)
    ink.draw(lambda p: [flame(p, x, 470, s) for x, s in ((b[2] + 60, 0.9), (b[2] + 230, 0.6))], ORG)
    ink.draw(lambda p: [flame(p, x, 440, s * 0.55) for x, s in ((b[2] + 60, 0.9), (b[2] + 230, 0.6))], YEL)
    pts = [(260, 1250), (520, 1150), (760, 1220), (980, 1120), (1180, 1350), (1360, 1640), (1520, 1880)]
    ink.draw(lambda p: (seg(p, (220, 1000), (220, 1950), 11), seg(p, (220, 1950), (1750, 1950), 11)), WHITE)
    ink.draw(lambda p: poly(p, pts, 14), RED)
    ink.draw(lambda p: [flame(p, x, y, 0.45) for x, y in ((1200, 1360), (1380, 1650))], ORG)
    ink.draw(lambda p: circ(p, 1520, 1880, 95, 12), YEL)
    ink.text(1640, 1700, '$0', 170, YEL)
    # price tag hanging off the chart
    ink.draw(lambda p: (seg(p, (520, 1150), (520, 1440), 8), tag(p, 420, 1440, 440, 200)), GRN)
    ink.text(560, 1450, 'SALE', 150, GRN, rot=0)
    ink.draw(lambda p: bubble(p, HD[2] + 20, HD[1] + 20, 560, 280, (HD[2] - 60, HD[1] + 330), thought=True), WHITE)
    ink.text(HD[2] + 110, HD[1] + 70, 'bargain?', 140, YEL, rot=-4)


def c_multiple(ink, HD):
    a = ink.text(160, 170, '$250K', 330, rot=-2)
    ink.text(a[2] + 50, 300, 'PROFIT', 170, rot=-2)
    b = ink.text(160, 560, '$500K', 400, GRN, rot=-2)
    ink.text(b[2] + 50, 720, 'OFFER', 190, GRN, rot=-2)
    # balance scale tipping
    ink.draw(lambda p: (seg(p, (700, 1950), (700, 1330), 12), seg(p, (560, 1950), (840, 1950), 12),
                        seg(p, (330, 1250), (1070, 1410), 12), circ(p, 700, 1330, 18, 10),
                        seg(p, (330, 1250), (270, 1450), 9), seg(p, (330, 1250), (390, 1450), 9),
                        p.ellipse(330, 1460, 110, 26, rot=0, w=10, over=0),
                        seg(p, (1070, 1410), (1010, 1610), 9), seg(p, (1070, 1410), (1130, 1610), 9),
                        p.ellipse(1070, 1620, 110, 26, rot=0, w=10, over=0)), WHITE)
    ink.text(240, 1060, '1x', 170, WHITE); ink.text(990, 1220, '2x', 190, YEL)
    ink.draw(lambda p: bubble(p, HD[2] - 20, HD[1] - 60, 600, 290, (HD[2] - 80, HD[1] + 240), thought=True), WHITE)
    ink.text(HD[2] + 70, HD[1] - 5, 'too low?', 150, CYAN, rot=-4)


def c_tired(ink, HD):
    ink.text(160, 170, '20 YEARS', 300, rot=-2)
    ink.text(160, 470, 'TIRED OWNER', 340, YEL, rot=-2)
    ink.draw(lambda p: tally(p, 260, 950, 20, 150), WHITE)
    ink.draw(lambda p: battery(p, 260, 1300, 470, 210), WHITE)
    ink.draw(lambda p: fill_rect(p, 290, 1330, 370, 1490), RED)
    ink.text(830, 1310, '3%', 170, RED, rot=-3)
    zzz(ink, 1080, 1450, CYAN)
    ink.text(260, 1620, 'ready to sell', 150, CYAN, rot=-3)
    ink.draw(lambda p: arrow(p, (1000, 1720), (1700, 1760), (2000, 1300)), WHITE)


def c_staff(ink, HD):
    ink.text(160, 160, 'HALF THE STAFF', 280, rot=-2)
    ink.text(160, 450, 'LEAVE?', 470, RED, rot=-2)
    for i in range(3):
        cx = 260 + i * 200
        ink.draw(lambda p, cx=cx: person(p, cx, 1270, 0.85), WHITE)
    ink.draw(lambda p: door(p, 860, 1120, 250, 470), WHITE)
    ink.text(870, 990, 'EXIT', 130, GRN, rot=0)
    ink.draw(lambda p: [runner(p, 1330 + k * 190, 1230 + k * 25, 0.72) for k in range(3)], RED)
    ink.text(300, 1680, 'the cash flow cost', 140, YEL, rot=-2)


CONCEPTS = {
    '100m': (44, 0.5, False, c_100m), 'zero': (42, 0.70, False, c_zero),
    'banker': (358, 0.70, True, c_banker), 'firesale': (120, 0.74, False, c_firesale),
    'multiple': (296, 0.72, False, c_multiple), 'tired': (164, 0.72, False, c_tired),
    'staff': (416, 0.74, False, c_staff),
}


def build(name):
    t, jx, bw, fn = CONCEPTS[name]
    comp.CUT_L = 2500
    img, msk = comp.plate(t, josh_x=jx, zoom=1.25)
    HD = comp.HEAD
    base = grade(img, msk, bw=bw).convert('RGBA')
    if jx > 0.6:
        a = np.asarray(base).astype(float)
        x = np.linspace(0, 1, W)[None, :, None]
        a[..., :3] *= 1 - np.clip(1 - x / 0.55, 0, 1) ** 1.5 * 0.45
        base = Image.fromarray(a.astype('uint8'), 'RGBA')
    ink = Ink()
    fn(ink, HD)
    out = ink.onto(base).convert('RGB')
    p = D + f'v7_{name}.png'
    out.save(p)
    out.resize((1600, 900), Image.LANCZOS).save(p.replace('.png', '_v.jpg'), quality=90)
    print('done', name, [int(v) for v in HD])


if __name__ == '__main__':
    for n in (sys.argv[1:] or CONCEPTS):
        build(n)

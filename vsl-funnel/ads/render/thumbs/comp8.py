"""v8: Dragon-slayer thumbnail. Hand-drawn marker Chinese dragon + sword in Josh's hand."""
import sys, math
import numpy as np
from PIL import Image
import comp
from comp5 import grade
from comp6 import Ink, seg, poly, circ, WHITE, YEL, GRN, CYAN, ORG, RED, D, W, H
from comp7 import curve_pts, sparkle

# dragon centreline (head at t=0, facing right toward Josh)
HX, HY = 1020, 1130
K = 1.35


def cl(t):
    x = HX - 150 * K - 820 * t
    y = HY + 60 + 280 * math.sin(2.3 * math.pi * t) + 560 * t
    return x, y


def rad(t):
    return 135 * (1 - 0.75 * t ** 1.1) + 10


def normal(t, e=1e-3):
    x0, y0 = cl(max(0, t - e)); x1, y1 = cl(min(1, t + e))
    dx, dy = x1 - x0, y1 - y0
    L = math.hypot(dx, dy) or 1
    return -dy / L, dx / L


def body(p, w=13):
    ts = [i / 160 for i in range(161)]
    top, bot = [], []
    for t in ts:
        x, y = cl(t); nx, ny = normal(t); r = rad(t)
        top.append((x + nx * r, y + ny * r)); bot.append((x - nx * r, y - ny * r))
    p.stroke(top, w, taper=False); p.stroke(bot, w, taper=False)
    return top, bot


def scales(p, w=7):
    for i in range(3, 150, 5):
        t = i / 160
        x, y = cl(t); nx, ny = normal(t); r = rad(t) * 0.75
        tx, ty = ny, -nx
        pts = []
        for k in range(13):
            a = math.pi * k / 12
            pts.append((x + nx * r * math.cos(a) * 0.9 + tx * r * 0.45 * math.sin(a),
                        y + ny * r * math.cos(a) * 0.9 + ty * r * 0.45 * math.sin(a)))
        p.stroke(pts, w, taper=False)


def spines(p, w=9):
    for i in range(4, 150, 7):
        t = i / 160
        x, y = cl(t); nx, ny = normal(t); r = rad(t)
        bx, by = x + nx * r, y + ny * r
        tx, ty = -ny, nx
        h = 70 * (1 - 0.6 * t)
        a = (bx - tx * 25, by - ty * 25)
        b = (bx + nx * h - tx * 10, by + ny * h - ty * 10)
        c = (bx + tx * 25, by + ty * 25)
        poly(p, [a, b, c], w)


def head(p, w=13):
    x, y = HX, HY
    # upper jaw / snout
    poly(p, [(x - 120 * K, y - 70 * K), (x + 40 * K, y - 120 * K), (x + 230 * K, y - 95 * K), (x + 300 * K, y - 40 * K), (x + 250 * K, y - 10 * K), (x + 60 * K, y + 5 * K)], w)
    # lower jaw (open)
    poly(p, [(x + 40 * K, y + 30 * K), (x + 230 * K, y + 90 * K), (x + 200 * K, y + 130 * K), (x - 20 * K, y + 120 * K), (x - 120 * K, y + 80 * K)], w)
    # teeth
    for k in range(5):
        tx = x + 80 * K + k * 32
        poly(p, [(tx, y + 3 * K), (tx + 12, y + 35 * K), (tx + 24, y + 8 * K)], 6)
        poly(p, [(tx + 10, y + 70 * K + k * 7), (tx + 20, y + 40 * K + k * 7), (tx + 32, y + 72 * K + k * 7)], 6)
    # back of head / cheek frill
    for k in range(4):
        a = math.radians(140 + k * 25)
        poly(p, [(x - 110 * K, y), (x - 110 * K + 170 * math.cos(a), y + 150 * K * math.sin(a)), (x - 140 * K + 120 * math.cos(a + 0.25), y + 110 * K * math.sin(a + 0.25))], 8)
    # eye
    p.ellipse(x + 20 * K, y - 75 * K, 40, 24, rot=-12, w=9, over=0.05)
    circ(p, x + 28 * K, y - 75 * K, 10, 10)
    # brow
    poly(p, [(x - 30 * K, y - 110 * K), (x + 30 * K, y - 120 * K), (x + 80 * K, y - 100 * K)], 10)


def horns(p, w=11):
    x, y = HX, HY
    p.stroke(curve_pts((x - 40 * K, y - 120 * K), (x - 120 * K, y - 330 * K), (x - 330 * K, y - 360 * K)), w, taper=True)
    p.stroke(curve_pts((x - 80 * K, y - 100 * K), (x - 200 * K, y - 250 * K), (x - 380 * K, y - 230 * K)), w, taper=True)


def whiskers(p, w=8):
    x, y = HX, HY
    p.stroke(curve_pts((x + 280 * K, y - 70 * K), (x + 420 * K, y - 200 * K), (x + 360 * K, y - 300 * K)), w, taper=True)
    p.stroke(curve_pts((x + 260 * K, y - 30 * K), (x + 430 * K, y + 60 * K), (x + 400 * K, y + 200 * K)), w, taper=True)

def leg(p, t, side=1, w=11):
    x, y = cl(t); nx, ny = normal(t); r = rad(t)
    bx, by = x - nx * r * side, y - ny * r * side
    kx, ky = bx - nx * 120 * side + 60, by - ny * 120 * side + 40
    fx, fy = kx + 40, ky + 110
    poly(p, [(bx - 30, by), (kx, ky), (fx, fy)], w)
    poly(p, [(bx + 40, by + 10), (kx + 50, ky + 10), (fx + 40, fy - 10)], w)
    for d in (-1, 0, 1):
        poly(p, [(fx + 20, fy), (fx + 20 + 60 * d + 30, fy + 70), (fx + 20 + 60 * d + 50, fy + 50)], 8)


def tail_flame(p, w=10):
    x, y = cl(1.0)
    for k, (dx, dy) in enumerate(((-140, -60), (-170, 40), (-120, 140))):
        p.stroke(curve_pts((x, y), (x + dx * 0.4, y + dy * 0.2 - 60), (x + dx, y + dy)), w, taper=True)


def sword(p, hx, hy, tx, ty, w=12):
    dx, dy = tx - hx, ty - hy
    L = math.hypot(dx, dy); ux, uy = dx / L, dy / L; vx, vy = -uy, ux
    g = 90  # guard distance from hand
    gx, gy = hx + ux * g, hy + uy * g
    # grip + pommel
    seg(p, (hx - ux * 90, hy - uy * 90), (gx, gy), w * 1.3)
    circ(p, hx - ux * 110, hy - uy * 110, 22, 9)
    # cross-guard
    seg(p, (gx + vx * 110, gy + vy * 110), (gx - vx * 110, gy - vy * 110), w * 1.2)
    # blade
    bw = 34
    a1 = (gx + vx * bw, gy + vy * bw); a2 = (gx - vx * bw, gy - vy * bw)
    tip = (tx, ty)
    b1 = (tx - ux * 120 + vx * bw, ty - uy * 120 + vy * bw); b2 = (tx - ux * 120 - vx * bw, ty - uy * 120 - vy * bw)
    poly(p, [a1, b1, tip, b2, a2], w)
    seg(p, (gx + ux * 30, gy + uy * 30), (tx - ux * 160, ty - uy * 160), 6)


def slash(p, w=16):
    # big crescent cut across the dragon's neck
    pts = curve_pts((980, 980), (700, 1300), (900, 1680), 50)
    p.stroke(pts, w, taper=True)
    pts = curve_pts((1060, 1010), (800, 1310), (980, 1650), 50)
    p.stroke(pts, w * 0.6, taper=True)


def build():
    comp.CUT_L = 2500
    img, msk = comp.plate(164, josh_x=0.72, zoom=1.25)
    base = grade(img, msk).convert('RGBA')
    a = np.asarray(base).astype(float)
    x = np.linspace(0, 1, W)[None, :, None]
    a[..., :3] *= 1 - np.clip(1 - x / 0.55, 0, 1) ** 1.5 * 0.5
    base = Image.fromarray(a.astype('uint8'), 'RGBA')
    ink = Ink()
    # dragon
    ink.draw(lambda p: (body(p), head(p), leg(p, 0.3, 1), leg(p, 0.7, 1)), RED)
    ink.draw(lambda p: (scales(p), spines(p)), ORG)
    ink.draw(lambda p: (horns(p), whiskers(p), tail_flame(p)), YEL)
    # sword from Josh's raised hand toward the dragon's neck
    ink.draw(lambda p: sword(p, 1700, 1660, 1010, 1300), WHITE)
    ink.draw(lambda p: slash(p), WHITE)
    ink.draw(lambda p: (sparkle(p, 1060, 1250, 80, 12), sparkle(p, 700, 1700, 60, 10)), YEL)
    # label on the dragon + headline
    ink.text(1450, 640, 'BANK JOB', 160, WHITE, rot=-4)
    ink.draw(lambda p: p.curve((1470, 780), (1350, 860), (1290, 960), w=11, hs=60), WHITE)
    ink.text(140, 60, 'I SLAYED THE', 230, WHITE, rot=-2)
    ink.text(140, 300, 'DRAGON', 330, YEL, rot=-2)
    ink.text(1800, 1900, '2 companies, $0 down', 120, CYAN, rot=-3)
    out = ink.onto(base).convert('RGB')
    p = D + 'v8_dragon.png'
    out.save(p)
    out.resize((1600, 900), Image.LANCZOS).save(p.replace('.png', '_v.jpg'), quality=90)
    print('done')


if __name__ == '__main__':
    build()

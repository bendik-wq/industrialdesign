"""v10: scribbled marker Chinese dragon, 'M&A DRAGON SLAYER', 4 versions.
usage: python3 dragon3.py [jian pen behind ko]"""
import sys, math, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import comp
from comp5 import grade
from comp6 import Ink, WHITE, YEL, CYAN, D, W, H

RED = (232, 44, 44); GOLD = (255, 200, 50); ORG = (255, 128, 40); WH = (252, 252, 246)
DK = (20, 12, 12); BLUE = (60, 150, 255); PINK = (255, 120, 170)


class Cv:
    """Local drawing canvas at 2x supersample."""
    def __init__(self, w, h, seed=3):
        self.w, self.h, self.S = w, h, 2
        self.im = Image.new('RGBA', (w * 2, h * 2), (0, 0, 0, 0))
        self.r = random.Random(seed)

    def _wob(self, pts, amt):
        ph = self.r.random() * 9
        return [(x + math.sin(i * 0.37 + ph) * amt, y + math.cos(i * 0.29 + ph) * amt) for i, (x, y) in enumerate(pts)]

    def stroke(self, pts, col, w=10, taper=True, wob=2.0, alpha=255):
        if len(pts) < 2:
            return
        pts = self._wob(dense(pts, 6), wob)
        lay = Image.new('L', self.im.size, 0)
        d = ImageDraw.Draw(lay)
        n = len(pts)
        for i in range(n - 1):
            f = i / (n - 1)
            ww = w * (0.35 + 0.65 * math.sin(math.pi * min(1, f * 1.1 + 0.02))) if taper else w
            ww = max(1.5, ww) * 2
            a, b = pts[i], pts[i + 1]
            d.line([(a[0] * 2, a[1] * 2), (b[0] * 2, b[1] * 2)], fill=alpha, width=int(ww))
            rr = ww / 2
            d.ellipse([b[0] * 2 - rr, b[1] * 2 - rr, b[0] * 2 + rr, b[1] * 2 + rr], fill=alpha)
        self.paint(lay, col)

    def paint(self, mask, col):
        bb = mask.getbbox()
        if not bb:
            return
        mc = mask.crop(bb)
        c = Image.new('RGBA', mc.size, col + (255,))
        c.putalpha(mc)
        self.im.alpha_composite(c, (bb[0], bb[1]))

    def mask(self, polys):
        m = Image.new('L', self.im.size, 0)
        d = ImageDraw.Draw(m)
        for p in polys:
            d.polygon([(x * 2, y * 2) for x, y in p], fill=255)
        return m

    def scribble(self, m, col, ang=35, gap=19, w=13, over=6):
        """Fill mask with back-and-forth marker hatching that slightly overshoots the edge (bbox-local)."""
        bb = m.getbbox()
        if not bb:
            return
        pad = over * 2 + 30
        X0, Y0 = max(0, bb[0] - pad), max(0, bb[1] - pad)
        X1, Y1 = min(m.width, bb[2] + pad), min(m.height, bb[3] + pad)
        mc = m.crop((X0, Y0, X1, Y1))
        cw, ch = mc.size
        lay = Image.new('L', (cw, ch), 0)
        d = ImageDraw.Draw(lay)
        a = math.radians(ang)
        ux, uy = math.cos(a), math.sin(a)
        vx, vy = -uy, ux
        cx, cy = cw / 2, ch / 2
        R = math.hypot(cw, ch) / 2 + 20
        g2 = gap * 2
        pts = []
        k = -R
        flip = 1
        while k < R:
            jit = self.r.uniform(-8, 8)
            pts.append((cx + vx * (k + jit) - ux * R * flip, cy + vy * (k + jit) - uy * R * flip))
            pts.append((cx + vx * (k + jit + g2 / 2) + ux * R * flip, cy + vy * (k + jit + g2 / 2) + uy * R * flip))
            k += g2
            flip *= -1
        d.line(pts, fill=255, width=w * 2, joint='curve')
        grown = mc.filter(ImageFilter.MaxFilter(over * 4 + 1)) if over else mc
        rough = Image.effect_noise((cw, ch), 60).point(lambda v: 255 if v > 120 else 0).filter(ImageFilter.GaussianBlur(3))
        edge = ImageChops.multiply(ImageChops.subtract(grown, mc), rough)
        clip = ImageChops.lighter(mc, edge)
        part = ImageChops.multiply(lay, clip)
        full = Image.new('L', m.size, 0)
        full.paste(part, (X0, Y0))
        c = Image.new('RGBA', (cw, ch), col + (255,))
        c.putalpha(part)
        self.im.alpha_composite(c, (X0, Y0))

    def out(self):
        return self.im.resize((self.w, self.h), Image.LANCZOS)


def dense(pts, step=6):
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(L / step))
        out += [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(1, n + 1)]
    return out


def catmull(pts, n=16):
    out = []
    P = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(n):
            t = k / n
            out.append(tuple(0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t * t + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t ** 3) for j in (0, 1)))
    out.append(pts[-1])
    return out


def qc(a, c, b, n=24):
    return [((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]) for t in [i / n for i in range(n + 1)]]


# ---------------- the dragon (local canvas 2400 x 1700, facing right) ----------------
DW, DH = 2400, 1700
SPINE = [(1720, 600), (1480, 720), (1240, 930), (1180, 1220), (1380, 1430), (1700, 1380), (1770, 1130), (1560, 980),
         (1220, 1030), (930, 1230), (660, 1430), (380, 1470), (140, 1360)]
HX, HY = 1810, 560


def geom():
    c = catmull(SPINE, 14)
    n = len(c)
    top, bot, nor = [], [], []
    for i in range(n):
        a = c[max(0, i - 1)]; b = c[min(n - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1
        nx, ny = -dy / L, dx / L
        t = i / (n - 1)
        r = 112 * (1 - 0.85 * t ** 1.1) + 12
        top.append((c[i][0] + nx * r, c[i][1] + ny * r)); bot.append((c[i][0] - nx * r, c[i][1] - ny * r))
        nor.append((nx, ny, r))
    return c, top, bot, nor


def dragon(ko=False, seed=3):
    cv = Cv(DW, DH, seed)
    c, top, bot, nor = geom()
    n = len(c)
    K = 1.2
    T = lambda dx, dy: (HX + dx * K, HY + dy * K)

    # legs (behind body)
    for t in (0.14, 0.44, 0.64, 0.88):
        i = int(t * (n - 1)); x, y = c[i]; nx, ny, r = nor[i]
        sc = 1 - 0.45 * t
        bx, by = x - nx * r * 0.5, y - ny * r * 0.5
        kx, ky = bx - nx * 140 * sc + 40, by - ny * 140 * sc + 70 * sc
        fx, fy = kx + 50 * sc, ky + 90 * sc
        legp = [(bx - 28 * sc, by), (kx - 24 * sc, ky), (fx - 18 * sc, fy), (fx + 30 * sc, fy + 4), (kx + 26 * sc, ky - 6), (bx + 34 * sc, by + 6)]
        cv.scribble(cv.mask([legp]), RED, ang=60, gap=16, w=11)
        cv.stroke([legp[0], legp[1], legp[2]], WH, 8, taper=False)
        cv.stroke([legp[5], legp[4], legp[3]], WH, 8, taper=False)
        for d_ in (-1, 0, 1):
            cv.stroke(qc((fx, fy), (fx + 40 * d_ + 20, fy + 40), (fx + 60 * d_ + 35, fy + 30 * sc + 25), 10), GOLD, 9 * sc + 3)

    # tail flame
    tx, ty = c[-1]
    for dx, dy, col in ((-150, -120, ORG), (-210, 0, GOLD), (-150, 120, ORG)):
        fl = [(tx, ty - 15), (tx + dx * 0.5, ty + dy * 0.25 - 40), (tx + dx, ty + dy), (tx + dx * 0.45, ty + dy * 0.55 + 30), (tx, ty + 15)]
        cv.scribble(cv.mask([fl]), col, ang=20, gap=15, w=10)
        cv.stroke(fl, WH, 7, taper=True)

    # body: scribble fill in chunks from tail to head (so neck overlaps coils)
    chunk = 10
    for s in range(n - 1 - (n - 1) % chunk, -1, -chunk):
        e = min(n - 1, s + chunk + 1)
        poly = top[s:e + 1] + bot[s:e + 1][::-1]
        cv.scribble(cv.mask([poly]), RED, ang=(40 if (s // chunk) % 2 else -40), gap=18, w=13, over=4)
        belly = [((c[i][0] * 0.6 + bot[i][0] * 0.4), (c[i][1] * 0.6 + bot[i][1] * 0.4)) for i in range(s, e + 1)] + bot[s:e + 1][::-1]
        cv.scribble(cv.mask([belly]), GOLD, ang=80, gap=15, w=10, over=2)
        for i in range(s, e, 3):
            cv.stroke([((c[i][0] * 0.6 + bot[i][0] * 0.4), (c[i][1] * 0.6 + bot[i][1] * 0.4)), bot[i]], (200, 130, 20), 5, taper=False, wob=0.5)
        cv.stroke(top[s:e + 1], WH, 10, taper=False, wob=1.5)
        cv.stroke(bot[s:e + 1], WH, 10, taper=False, wob=1.5)
        # scale squiggles
        for i in range(s, e, 4):
            x, y = c[i]; nx, ny, r = nor[i]
            cx, cy = x + nx * r * 0.35, y + ny * r * 0.35
            cv.stroke(qc((cx - ny * r * 0.22, cy + nx * r * 0.22), (cx + nx * r * 0.35, cy + ny * r * 0.35), (cx + ny * r * 0.22, cy - nx * r * 0.22), 8), (255, 170, 170), 5, taper=False, wob=0.5)
        # dorsal spikes
        for i in range(s, e, 5):
            if i > n - 8:
                continue
            nx, ny, r = nor[i]
            b0 = top[i]; b1 = top[min(n - 1, i + 3)]
            h = 85 * (1 - 0.55 * i / n)
            tip = ((b0[0] + b1[0]) / 2 + nx * h - ny * 20, (b0[1] + b1[1]) / 2 + ny * h + nx * 20)
            cv.scribble(cv.mask([[b0, tip, b1]]), ORG, ang=70, gap=12, w=8, over=2)
            cv.stroke([b0, tip, b1], WH, 7, taper=False, wob=1)

    # ---- head ----
    mane = []
    for k in range(6):
        a = math.radians(125 + k * 26)
        tip = T(-30 + 300 * math.cos(a), -10 + 240 * math.sin(a))
        mid = T(-30 + 190 * math.cos(a + 0.4), -10 + 150 * math.sin(a + 0.4))
        poly = [T(-10, -60), mid, tip, T(-60, 40)]
        cv.scribble(cv.mask([poly]), ORG if k % 2 else GOLD, ang=30 + k * 20, gap=13, w=9, over=2)
        cv.stroke(poly + [poly[0]], WH, 7, taper=False, wob=1.2)
    for off in (0, 45):
        cv.stroke(qc(T(20, -120 + off * 0.3), T(-90, -270 + off * 0.6), T(-300, -275 + off * 0.6), 20), GOLD, 20, taper=False)
        cv.stroke([T(-130, -240 + off * 0.6), T(-115, -330 + off * 0.6)], GOLD, 14)
        cv.stroke([T(-230, -260 + off * 0.6), T(-270, -345 + off * 0.6)], GOLD, 12)
    skull = [T(-60, -90), T(60, -150), T(220, -140), T(330, -95), T(395, -40), T(360, 0), T(200, 12), T(40, 30), T(-70, 40)]
    jaw = [T(10, 40), T(220, 64), T(340, 140), T(300, 185), T(150, 172), T(-60, 120)]
    if ko:
        jaw = [T(10, 40), T(220, 50), T(330, 80), T(300, 110), T(150, 110), T(-60, 100)]
    cv.scribble(cv.mask([jaw]), (190, 30, 40), ang=-30, gap=15, w=11)
    cv.paint(cv.mask([[T(40, 30), T(330, 0), T(320, 120 if not ko else 70), T(200, 66 if not ko else 50)]]), (70, 8, 16))
    cv.scribble(cv.mask([skull]), RED, ang=35, gap=16, w=12)
    cv.stroke(skull + [skull[0]], WH, 11, taper=False, wob=1.5)
    cv.stroke(jaw + [jaw[0]], WH, 10, taper=False, wob=1.5)
    # teeth
    for k in range(5):
        fx = 90 + k * 50
        cv.paint(cv.mask([[T(fx, 12), T(fx + 16, 66 - k * 4), T(fx + 30, 10)]]), WH)
        if not ko:
            cv.paint(cv.mask([[T(fx + 10, 118 - k * 7), T(fx + 24, 72 - k * 6), T(fx + 38, 116 - k * 7)]]), WH)
    if ko:  # tongue out
        tg = qc(T(250, 90), T(330, 230), T(250, 280), 16) + qc(T(250, 280), T(200, 230), T(210, 100), 16)
        cv.scribble(cv.mask([tg]), PINK, ang=80, gap=12, w=9)
        cv.stroke(tg, WH, 7, taper=False)
    # nostril smoke curls
    for k in range(2):
        pts = [T(400 + k * 30 + 40 * math.cos(a) * (1 - a / 12), -70 - k * 30 - a * 6 + 40 * math.sin(a) * (1 - a / 12)) for a in [i * 0.25 for i in range(40)]]
        cv.stroke(pts, (230, 230, 230), 6, taper=True)
    # brow + eye
    cv.stroke([T(40, -125), T(120, -155), T(190, -118)], WH, 14, taper=False)
    if ko:
        cv.stroke([T(95, -110), T(165, -60)], WH, 12, taper=False)
        cv.stroke([T(165, -110), T(95, -60)], WH, 12, taper=False)
        for k in range(5):  # dizzy stars orbit
            a = k * 2 * math.pi / 5
            sx, sy = T(60 + 230 * math.cos(a), -330 + 60 * math.sin(a))
            cv.stroke([(sx - 26, sy), (sx + 26, sy)], GOLD, 9, taper=False)
            cv.stroke([(sx, sy - 26), (sx, sy + 26)], GOLD, 9, taper=False)
        cv.stroke([T(60 + 230 * math.cos(a), -330 + 60 * math.sin(a)) for a in [i * 0.1 for i in range(63)]], WH, 5, taper=False)
    else:
        eye = [T(85, -100), T(175, -104), T(160, -58), T(92, -60)]
        cv.paint(cv.mask([eye]), (255, 236, 120))
        cv.stroke(eye + [eye[0]], WH, 8, taper=False, wob=0.8)
        cv.paint(cv.mask([[T(126, -100), T(142, -100), T(138, -60), T(130, -60)]]), DK)
    # whiskers + beard
    cv.stroke(qc(T(385, -70), T(560, -230), T(470, -330), 30) + qc(T(470, -330), T(420, -390), T(520, -430), 14), GOLD, 12, taper=True)
    cv.stroke(qc(T(375, -20), T(600, 40), T(560, 220), 30) + qc(T(560, 220), T(520, 320), T(640, 360), 14), GOLD, 12, taper=True)
    for k in range(4):
        cv.stroke(qc(T(-20 + k * 40, 150), T(-40 + k * 40, 250), T(-100 + k * 30, 320), 16), GOLD, 9, taper=True)
    return cv.out()


# ---------------- weapons (drawn on a full-frame canvas) ----------------
def jian(cv, hx, hy, tx, ty):
    dx, dy = tx - hx, ty - hy
    L = math.hypot(dx, dy); ux, uy = dx / L, dy / L; vx, vy = -uy, ux
    gx, gy = hx + ux * 70, hy + uy * 70
    # handle wrap
    h0 = (hx - ux * 150, hy - uy * 150)
    grip = [(h0[0] + vx * 22, h0[1] + vy * 22), (gx + vx * 22, gy + vy * 22), (gx - vx * 22, gy - vy * 22), (h0[0] - vx * 22, h0[1] - vy * 22)]
    cv.scribble(cv.mask([grip]), (120, 60, 30), ang=math.degrees(math.atan2(vy, vx)) + 30, gap=12, w=8, over=1)
    cv.stroke(grip + [grip[0]], WH, 7, taper=False, wob=0.8)
    # tassel
    px, py = h0
    for k in range(5):
        cv.stroke(qc((px, py), (px - 60 + k * 18, py + 120), (px - 120 + k * 25, py + 260), 16), RED, 9, taper=True)
    cv.stroke([(px - 14, py), (px + 14, py + 18)], GOLD, 16, taper=False)
    # guard
    g = [(gx + vx * 95, gy + vy * 95), (gx + ux * 26 + vx * 40, gy + uy * 26 + vy * 40), (gx + ux * 26 - vx * 40, gy + uy * 26 - vy * 40), (gx - vx * 95, gy - vy * 95), (gx - ux * 18, gy - uy * 18)]
    cv.scribble(cv.mask([g]), GOLD, ang=10, gap=11, w=8, over=1)
    cv.stroke(g + [g[0]], WH, 7, taper=False, wob=0.8)
    # blade
    bw = 30
    b0 = (gx + ux * 26, gy + uy * 26)
    blade = [(b0[0] + vx * bw, b0[1] + vy * bw), (tx - ux * 90 + vx * bw, ty - uy * 90 + vy * bw), (tx, ty), (tx - ux * 90 - vx * bw, ty - uy * 90 - vy * bw), (b0[0] - vx * bw, b0[1] - vy * bw)]
    cv.scribble(cv.mask([blade]), (210, 225, 240), ang=math.degrees(math.atan2(uy, ux)) + 70, gap=14, w=9, over=1)
    cv.stroke(blade + [blade[0]], WH, 9, taper=False, wob=1)
    cv.stroke([(b0[0] + ux * 20, b0[1] + uy * 20), (tx - ux * 120, ty - uy * 120)], (120, 140, 170), 6, taper=False)
    # swoosh lines
    for k in range(3):
        cv.stroke(qc((tx + vx * (90 + k * 50), ty + vy * (90 + k * 50)), (tx - ux * 300 + vx * (200 + k * 50), ty - uy * 300 + vy * (200 + k * 50)), (hx + vx * (160 + k * 40), hy + vy * (160 + k * 40)), 24), WH, 6, taper=True)


def fpen(cv, hx, hy, tx, ty):
    dx, dy = tx - hx, ty - hy
    L = math.hypot(dx, dy); ux, uy = dx / L, dy / L; vx, vy = -uy, ux
    bw = 62
    back = (hx - ux * 260, hy - uy * 260)
    nb = (tx - ux * 220, ty - uy * 220)
    barrel = [(back[0] + vx * bw, back[1] + vy * bw), (nb[0] + vx * bw * 0.8, nb[1] + vy * bw * 0.8), (nb[0] - vx * bw * 0.8, nb[1] - vy * bw * 0.8), (back[0] - vx * bw, back[1] - vy * bw)]
    cv.scribble(cv.mask([barrel]), (40, 95, 215), ang=math.degrees(math.atan2(vy, vx)) + 25, gap=14, w=11, over=1)
    cv.stroke(barrel + [barrel[0]], WH, 9, taper=False, wob=1)
    # gold bands + clip
    for f in (0.18, 0.8):
        bx, by = back[0] + (nb[0] - back[0]) * f, back[1] + (nb[1] - back[1]) * f
        cv.stroke([(bx + vx * bw, by + vy * bw), (bx - vx * bw, by - vy * bw)], GOLD, 16, taper=False)
    cv.stroke([(back[0] + vx * (bw + 20) + ux * 40, back[1] + vy * (bw + 20) + uy * 40), (back[0] + vx * (bw + 20) + ux * 330, back[1] + vy * (bw + 20) + uy * 330)], GOLD, 14, taper=False)
    # nib
    nib = [(nb[0] + vx * bw * 0.8, nb[1] + vy * bw * 0.8), (tx, ty), (nb[0] - vx * bw * 0.8, nb[1] - vy * bw * 0.8)]
    cv.scribble(cv.mask([nib]), GOLD, ang=math.degrees(math.atan2(uy, ux)) + 60, gap=12, w=9, over=1)
    cv.stroke(nib + [nib[0]], WH, 8, taper=False, wob=0.8)
    cv.stroke([(nb[0] + ux * 40, nb[1] + uy * 40), (tx - ux * 30, ty - uy * 30)], DK, 6, taper=False)
    cv.stroke([(nb[0] + ux * 60 - vx * 6, nb[1] + uy * 60 - vy * 6), (nb[0] + ux * 60 + vx * 6, nb[1] + uy * 60 + vy * 6)], DK, 14, taper=False)
    # ink splat at the tip
    rr = random.Random(9)
    for k in range(9):
        a = rr.uniform(0, 2 * math.pi); d = rr.uniform(60, 190); s = rr.uniform(14, 38)
        cx, cy = tx + math.cos(a) * d, ty + math.sin(a) * d
        cv.paint(cv.mask([[(cx + s * math.cos(t), cy + s * math.sin(t)) for t in [i * 0.5 for i in range(13)]]]), BLUE)
    blob = [(tx + (90 + 25 * math.sin(i * 1.7)) * math.cos(i * 0.4), ty + (90 + 25 * math.sin(i * 1.7)) * math.sin(i * 0.4)) for i in range(16)]
    cv.paint(cv.mask([blob]), BLUE)


# ---------------- compositing ----------------
def place(base, dimg, x, y, scale=1.0, flip=False, glow=True):
    if flip:
        dimg = dimg.transpose(Image.FLIP_LEFT_RIGHT)
    if scale != 1:
        dimg = dimg.resize((int(dimg.width * scale), int(dimg.height * scale)), Image.LANCZOS)
    lay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    lay.alpha_composite(dimg, (int(x), int(y)))
    a = lay.split()[3]
    sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sh.putalpha(a.filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * 0.65)))
    base.alpha_composite(sh, (8, 12))
    if glow:
        g = Image.new('RGBA', (W, H), (255, 80, 30, 0))
        g.putalpha(a.filter(ImageFilter.GaussianBlur(80)).point(lambda v: int(v * 0.3)))
        base.alpha_composite(g)
    base.alpha_composite(lay)
    return base


def plate(t, jx, bw=False, shade=True):
    comp.CUT_L = 2500
    img, msk = comp.plate(t, josh_x=jx, zoom=1.25)
    base = grade(img, msk, bw=bw).convert('RGBA')
    if shade:
        a = np.asarray(base).astype(float)
        x = np.linspace(0, 1, W)[None, :, None]
        a[..., :3] *= 1 - np.clip(1 - x / 0.6, 0, 1) ** 1.4 * 0.5
        base = Image.fromarray(a.astype('uint8'), 'RGBA')
    return base, img, msk


def title(ink, x=140, y=40, small=False):
    ink.text(x, y, 'M&A', 250, YEL, rot=-3)
    ink.text(x, y + 250, 'DRAGON SLAYER', 300, WHITE, rot=-3)


def finish(base, ink, name):
    out = ink.onto(base).convert('RGB')
    p = D + f'v10_{name}.png'
    out.save(p)
    out.resize((1600, 900), Image.LANCZOS).save(p.replace('.png', '_v.jpg'), quality=90)
    print('done', name)


def v_jian():
    base, _, _ = plate(164, 0.74)
    place(base, dragon(), -380, 520, 0.95)
    cv = Cv(W, H, 5); jian(cv, 1800, 1650, 1330, 960)
    base.alpha_composite(cv.out())
    ink = Ink(); title(ink); finish(base, ink, 'jian')


def v_pen():
    base, _, _ = plate(164, 0.74)
    place(base, dragon(seed=5), -380, 520, 0.95)
    cv = Cv(W, H, 6); fpen(cv, 1820, 1640, 1290, 1020)
    base.alpha_composite(cv.out())
    ink = Ink(); title(ink)
    ink.text(1950, 1880, 'sign here', 130, CYAN, rot=-4)
    finish(base, ink, 'pen')


def v_behind():
    base, img, msk = plate(358, 0.66, bw=True, shade=True)
    place(base, dragon(seed=7), 2330, 120, 1.0, flip=True)
    # Josh back on top so the dragon coils behind him
    josh = grade(img, msk, bw=True).convert('RGBA')
    m = msk.filter(ImageFilter.GaussianBlur(1.5))
    josh.putalpha(m)
    base.alpha_composite(josh)
    ink = Ink(); title(ink)
    finish(base, ink, 'behind')


def v_ko():
    base, _, _ = plate(44, 0.62)
    place(base, dragon(ko=True, seed=11), -560, 760, 0.85)
    ink = Ink(); title(ink)
    ink.text(1240, 1880, 'K.O.', 200, YEL, rot=-6)
    finish(base, ink, 'ko')


VERS = {'jian': v_jian, 'pen': v_pen, 'behind': v_behind, 'ko': v_ko}

if __name__ == '__main__':
    for n in (sys.argv[1:] or VERS):
        VERS[n]()

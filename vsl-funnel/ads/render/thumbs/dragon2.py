"""v9: 'They called me' dragon slayer. Filled Chinese dragon (the failing PE roll-up),
Josh with a sword, 3 words of text."""
import math, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import comp
from comp5 import grade
from comp6 import Ink, WHITE, YEL, RED, D, W, H

S = 2
RD = (206, 32, 36); RD2 = (150, 18, 26); GOLD = (250, 196, 60); GOLD2 = (255, 228, 140)
ORG = (255, 120, 40); INK = (30, 8, 8); WH = (250, 248, 240)
rng = random.Random(4)


def catmull(pts, n=18):
    out = []
    P = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in (0, 1)))
    out.append(pts[-1])
    return out


class L:
    def __init__(self):
        self.im = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)

    def P(self, pts):
        return [(x * S, y * S) for x, y in pts]

    def poly(self, pts, fill=None, outline=None, w=10):
        if fill:
            self.d.polygon(self.P(pts), fill=fill + (255,))
        if outline:
            self.line(pts + [pts[0]], outline, w)

    def line(self, pts, col, w=10, taper=False):
        n = len(pts)
        for i in range(n - 1):
            f = i / max(1, n - 2)
            ww = w * (0.25 + 0.75 * math.sin(math.pi * min(1, f))) if taper else w
            a, b = pts[i], pts[i + 1]
            self.d.line([(a[0] * S, a[1] * S), (b[0] * S, b[1] * S)], fill=col + (255,), width=max(2, int(ww * S)))
            r = ww * S / 2
            self.d.ellipse([b[0] * S - r, b[1] * S - r, b[0] * S + r, b[1] * S + r], fill=col + (255,))

    def circle(self, cx, cy, r, fill=None, outline=None, w=8):
        self.d.ellipse([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], fill=(fill + (255,)) if fill else None,
                       outline=(outline + (255,)) if outline else None, width=int(w * S))


def qcurve(a, c, b, n=30):
    return [((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]) for t in [i / n for i in range(n + 1)]]


# ---------------- dragon ----------------
HEAD = (1330, 980)   # back of the head / neck join
SPINE = [(1230, 1010), (1000, 1120), (760, 1330), (700, 1620), (900, 1820), (1220, 1760), (1300, 1520), (1100, 1360),
         (760, 1420), (480, 1620), (300, 1880), (120, 2040)]


def body_geom():
    c = catmull(SPINE, 16)
    n = len(c)
    top, bot, nor = [], [], []
    for i in range(n):
        a = c[max(0, i - 1)]; b = c[min(n - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        Lh = math.hypot(dx, dy) or 1
        nx, ny = -dy / Lh, dx / Lh
        t = i / (n - 1)
        r = 118 * (1 - 0.86 * t ** 1.15) + 10
        top.append((c[i][0] + nx * r, c[i][1] + ny * r)); bot.append((c[i][0] - nx * r, c[i][1] - ny * r))
        nor.append((nx, ny, r))
    return c, top, bot, nor


def draw_body(L_):
    c, top, bot, nor = body_geom()
    n = len(c)
    # legs first (behind)
    for t in (0.12, 0.42, 0.62, 0.86):
        i = int(t * (n - 1)); x, y = c[i]; nx, ny, r = nor[i]
        bx, by = x - nx * r * 0.6, y - ny * r * 0.6
        kx, ky = bx - nx * 150 + 50, by - ny * 150 + 60
        fx, fy = kx + 60, ky + 100
        sc = 1 - 0.45 * t
        L_.line([(bx, by), (kx, ky), (fx, fy)], RD2, 46 * sc)
        L_.line([(bx, by), (kx, ky), (fx, fy)], RD, 30 * sc)
        for d in (-1, 0, 1):
            L_.line(qcurve((fx, fy), (fx + 45 * d + 20, fy + 50), (fx + 70 * d + 30, fy + 40 * sc + 20)), GOLD, 11 * sc, taper=True)
    # tail flame
    tx, ty = c[-1]
    for k, (dx, dy, col) in enumerate(((-160, -110, ORG), (-210, 10, GOLD), (-150, 120, ORG))):
        L_.poly([(tx, ty), (tx + dx * 0.5, ty + dy * 0.2 - 40), (tx + dx, ty + dy), (tx + dx * 0.4, ty + dy * 0.6 + 30)], fill=col)
    # segments from tail to head so the neck overlaps the coils
    for i in range(n - 2, -1, -1):
        quad = [top[i], top[i + 1], bot[i + 1], bot[i]]
        L_.poly(quad, fill=RD)
        nx, ny, r = nor[i]
        # belly plates on the 'bot' side
        bi = [(c[i][0] - nx * r * 0.25, c[i][1] - ny * r * 0.25), (c[i + 1][0] - nor[i + 1][0] * nor[i + 1][2] * 0.25, c[i + 1][1] - nor[i + 1][1] * nor[i + 1][2] * 0.25), bot[i + 1], bot[i]]
        L_.poly(bi, fill=GOLD)
        if i % 3 == 0:
            L_.line([bi[0], bi[3]], (200, 140, 30), 5)
        # scale arcs
        if i % 2 == 0:
            cx, cy = c[i][0] + nx * r * 0.45, c[i][1] + ny * r * 0.45
            L_.line(qcurve((cx - ny * r * 0.25, cy + nx * r * 0.25), (cx + nx * r * 0.35, cy + ny * r * 0.35), (cx + ny * r * 0.25, cy - nx * r * 0.25), 8), RD2, 5)
        # edges
        L_.line([top[i], top[i + 1]], INK, 7)
        L_.line([bot[i], bot[i + 1]], INK, 7)
        # dorsal fin
        if i % 4 == 0 and i < n - 6:
            b0 = top[i]; b1 = top[min(n - 1, i + 3)]
            h = 95 * (1 - 0.6 * i / n)
            tip = ((b0[0] + b1[0]) / 2 + nx * h - ny * 25, (b0[1] + b1[1]) / 2 + ny * h + nx * 25)
            L_.poly([b0, tip, b1], fill=ORG, outline=INK, w=5)


def draw_head(L_):
    x, y = HEAD
    K = 1.25
    T = lambda dx, dy: (x + dx * K, y + dy * K)
    # mane (flame curls behind head)
    for k in range(6):
        a = math.radians(120 + k * 28)
        base = T(-30, -10)
        tip = T(-30 + 330 * math.cos(a), -10 + 260 * math.sin(a))
        mid = T(-30 + 200 * math.cos(a + 0.35), -10 + 160 * math.sin(a + 0.35))
        L_.poly([T(-20, -60), mid, tip, T(-60, 40)], fill=ORG if k % 2 else GOLD, outline=INK, w=5)
    # antlers
    for side, off in ((1, 0), (-1, 40)):
        a = T(20, -120 + off * 0.3)
        c = T(-300, -270 + off * 0.6)
        L_.line(qcurve(a, T(-80, -270 + off * 0.6), c, 20), GOLD, 22, taper=False)
        L_.line([T(-130, -235 + off * 0.6), T(-120, -320 + off * 0.6)], GOLD, 16)
        L_.line([T(-230, -255 + off * 0.6), T(-270, -335 + off * 0.6)], GOLD, 14)
    # head block (upper jaw / skull)
    skull = [T(-60, -90), T(60, -150), T(220, -140), T(330, -95), T(390, -40), T(360, 0), T(200, 10), T(40, 30), T(-70, 40)]
    L_.poly(skull, fill=RD, outline=INK, w=8)
    # snout ridge + nostril curl
    L_.line(qcurve(T(120, -135), T(260, -150), T(370, -70), 20), RD2, 8)
    L_.line(qcurve(T(330, -60), T(370, -110), T(395, -60), 12), INK, 6)
    # lower jaw, open
    jaw = [T(10, 40), T(220, 60), T(340, 140), T(300, 185), T(150, 170), T(-60, 120)]
    L_.poly(jaw, fill=RD2, outline=INK, w=8)
    # mouth interior
    L_.poly([T(40, 30), T(330, 0), T(320, 135), T(200, 70)], fill=(90, 10, 20))
    # fangs
    for k in range(5):
        fx = 90 + k * 50
        L_.poly([T(fx, 12), T(fx + 16, 70 - k * 4), T(fx + 30, 8)], fill=WH, outline=INK, w=3)
        L_.poly([T(fx + 10, 120 - k * 8), T(fx + 24, 70 - k * 6), T(fx + 38, 118 - k * 8)], fill=WH, outline=INK, w=3)
    # brow + eye
    L_.poly([T(40, -120), T(170, -150), T(180, -105), T(60, -90)], fill=GOLD, outline=INK, w=5)
    L_.poly([T(80, -95), T(175, -100), T(160, -60), T(90, -62)], fill=GOLD2, outline=INK, w=5)
    L_.poly([T(125, -96), T(140, -96), T(136, -62), T(129, -62)], fill=INK)
    # beard
    for k in range(4):
        L_.line(qcurve(T(-20 + k * 40, 150), T(-40 + k * 40, 260), T(-100 + k * 30, 330)), GOLD, 9, taper=True)
    # whiskers (long flowing)
    L_.line(qcurve(T(380, -70), T(540, -200), T(470, -300), 30), GOLD, 12, taper=True)
    L_.line(qcurve(T(370, -20), T(600, 40), T(560, 230), 30) + qcurve(T(560, 230), T(520, 340), T(650, 380), 20), GOLD, 12, taper=True)


def cloud(L_, x, y, s=1.0, col=(255, 255, 255)):
    # ruyi cloud: three spiral curls on a base line
    for k, (dx, r) in enumerate(((0, 60), (110, 80), (230, 55))):
        pts = []
        for i in range(60):
            a = math.pi * 2.4 * i / 59
            rr = r * s * (1 - i / 75)
            pts.append((x + dx * s + rr * math.cos(a + math.pi), y - r * s * 0.2 + rr * math.sin(a + math.pi)))
        L_.line(pts, col, 8 * s)
    L_.line([(x - 70 * s, y + 55 * s), (x + 300 * s, y + 55 * s)], col, 8 * s)


def sword(L_, hx, hy, tx, ty):
    dx, dy = tx - hx, ty - hy
    Ln = math.hypot(dx, dy); ux, uy = dx / Ln, dy / Ln; vx, vy = -uy, ux
    gx, gy = hx + ux * 80, hy + uy * 80
    L_.line([(hx - ux * 130, hy - uy * 130), (gx, gy)], (60, 40, 30), 36)
    L_.circle(hx - ux * 125, hy - uy * 125, 22, fill=GOLD, outline=INK, w=4)
    L_.line([(gx + vx * 120, gy + vy * 120), (gx - vx * 120, gy - vy * 120)], GOLD, 26)
    bw = 44
    blade = [(gx + vx * bw, gy + vy * bw), (tx - ux * 140 + vx * bw * 0.9, ty - uy * 140 + vy * bw * 0.9), (tx, ty),
             (tx - ux * 140 - vx * bw * 0.9, ty - uy * 140 - vy * bw * 0.9), (gx - vx * bw, gy - vy * bw)]
    L_.poly(blade, fill=(235, 240, 248), outline=INK, w=5)
    L_.line([(gx + ux * 30, gy + uy * 30), (tx - ux * 170, ty - uy * 170)], (170, 180, 195), 6)


def build():
    comp.CUT_L = 2500
    img, msk = comp.plate(164, josh_x=0.74, zoom=1.25)
    base = grade(img, msk).convert('RGBA')
    a = np.asarray(base).astype(float)
    x = np.linspace(0, 1, W)[None, :, None]
    a[..., :3] *= 1 - np.clip(1 - x / 0.6, 0, 1) ** 1.4 * 0.55
    base = Image.fromarray(a.astype('uint8'), 'RGBA')

    Lg = L()
    cloud(Lg, 300, 1180, 1.0, (235, 235, 235))
    cloud(Lg, 1380, 1930, 0.8, (235, 235, 235))
    draw_body(Lg)
    draw_head(Lg)
    sword(Lg, 1800, 1650, 1400, 1210)
    lay = Lg.im.resize((W, H), Image.LANCZOS)
    sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sh.putalpha(lay.split()[3].filter(ImageFilter.GaussianBlur(16)).point(lambda v: int(v * 0.7)))
    base.alpha_composite(sh, (8, 14))
    # warm glow behind the dragon
    g = Image.new('RGBA', (W, H), (255, 90, 30, 0))
    g.putalpha(lay.split()[3].filter(ImageFilter.GaussianBlur(70)).point(lambda v: int(v * 0.35)))
    base.alpha_composite(g)
    base.alpha_composite(lay)

    ink = Ink()
    ink.text(140, 40, 'THEY CALLED', 300, WHITE, rot=-2)
    ink.text(140, 330, 'ME.', 380, YEL, rot=-2)
    ink.text(560, 1450, 'PE', 230, WHITE, rot=-8)
    out = ink.onto(base).convert('RGB')
    p = D + 'v9_dragon.png'
    out.save(p)
    out.resize((1600, 900), Image.LANCZOS).save(p.replace('.png', '_v.jpg'), quality=90)
    print('done')


if __name__ == '__main__':
    build()

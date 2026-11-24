"""v6: Taki-style marker system + hand-drawn figures + multi-colour, sharper lettering.
usage: python3 comp6.py NAME...   (names: see CONCEPTS)"""
import sys, math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import comp
from comp5 import grade

D, W, H = comp.D, 3840, 2160
MARK = D + 'fonts/CaveatBrush-Regular.ttf'
WHITE = (252, 252, 248); YEL = (255, 199, 44); GRN = (80, 232, 140)
CYAN = (82, 204, 255); ORG = (255, 128, 48); RED = (245, 68, 58)


class Ink:
    def __init__(self):
        self.im = Image.new('RGBA', (W * 2, H * 2), (0, 0, 0, 0))

    def text(self, x, y, t, size, fill=WHITE, rot=0):
        f = ImageFont.truetype(MARK, size * 2)
        layer = Image.new('RGBA', self.im.size, (0, 0, 0, 0))
        dd = ImageDraw.Draw(layer)
        dd.text((x * 2, y * 2), t, font=f, fill=fill + (255,), stroke_width=1, stroke_fill=fill + (255,))
        b = dd.textbbox((x * 2, y * 2), t, font=f)
        if rot:
            layer = layer.rotate(rot, center=(x * 2, y * 2), resample=Image.BICUBIC)
        self.im.alpha_composite(layer)
        return [v / 2 for v in b]

    def draw(self, fn, fill=WHITE, w=1.0):
        p = comp.Pen(5)
        p.wmul = w
        fn(p)
        col = Image.new('RGBA', self.im.size, fill + (255,))
        col.putalpha(p.layer)
        self.im.alpha_composite(col)

    def onto(self, base):
        im = self.im.resize((W, H), Image.LANCZOS)
        sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        sh.putalpha(im.split()[3].filter(ImageFilter.GaussianBlur(9)).point(lambda v: int(v * 0.7)))
        base.alpha_composite(sh, (4, 7))
        base.alpha_composite(im)
        return base


# ---------- figures (all marker strokes) ----------
def seg(p, a, b, w=12, n=24, wob=2.5):
    pts = [(a[0] + (b[0] - a[0]) * i / n + math.sin(i * 0.9) * wob * 0.3,
            a[1] + (b[1] - a[1]) * i / n + math.cos(i * 1.1) * wob * 0.3) for i in range(n + 1)]
    p.stroke(pts, w, taper=False)


def poly(p, pts, w=12):
    for a, b in zip(pts, pts[1:]):
        seg(p, a, b, w)


def circ(p, cx, cy, r, w=11):
    p.ellipse(cx, cy, r, r * 0.92, rot=0, w=w, over=0.08)


def bank(p, x, y, s=1.0, w=11):
    S = lambda a, b: (x + a * s, y + b * s)
    poly(p, [S(0, 120), S(260, 0), S(520, 120), S(0, 120)], w)
    seg(p, S(-10, 140), S(530, 140), w)
    for cx in (60, 190, 330, 460):
        seg(p, S(cx, 160), S(cx, 400), w)
    seg(p, S(-30, 420), S(550, 420), w)
    seg(p, S(-50, 460), S(570, 460), w)


def xmark(p, cx, cy, r=100, w=22):
    seg(p, (cx - r, cy - r), (cx + r, cy + r), w)
    seg(p, (cx + r, cy - r), (cx - r, cy + r), w)


def check(p, x, y, s=140, w=22):
    poly(p, [(x, y + s * 0.5), (x + s * 0.38, y + s * 0.9), (x + s * 1.1, y - s * 0.2)], w)


def person(p, cx, y, s=1.0, w=10):
    circ(p, cx, y + 55 * s, 52 * s, w)
    pts = [(cx - 95 * s + 190 * s * i / 40, y + 300 * s - math.sin(math.pi * i / 40) ** 0.6 * 175 * s) for i in range(41)]
    p.stroke(pts + [pts[0]], w, taper=False)


def battery(p, x, y, w_=520, h_=240, w=12):
    poly(p, [(x, y), (x + w_, y), (x + w_, y + h_), (x, y + h_), (x, y)], w)
    poly(p, [(x + w_, y + h_ * 0.3), (x + w_ + 45, y + h_ * 0.3), (x + w_ + 45, y + h_ * 0.7), (x + w_, y + h_ * 0.7)], w)


def fill_rect(p, x0, y0, x1, y1):
    for k in range(int((x1 - x0) / 18) + 1):
        seg(p, (x0 + k * 18, y0), (x0 + k * 18 - 6, y1), 16, n=8, wob=1)


def arrow(p, a, c, b, w=13):
    p.curve(a, c, b, w=w, hs=80)


# ---------- concepts ----------
def c_100m(ink):
    a = ink.text(150, 130, '$1M', 430, rot=4)
    ink.draw(lambda p: xmark(p, a[2] + 250, (a[1] + a[3]) / 2 + 60), RED)
    b = ink.text(2580, 110, '$100M', 410, YEL, rot=-3)
    ink.draw(lambda p: check(p, b[0] - 330, (b[1] + b[3]) / 2 - 20), GRN)
    ink.draw(lambda p: bank(p, 3020, 1180, 1.05), WHITE)
    ink.text(2860, 1720, 'easier to get', 125, CYAN, rot=-3)
    ink.draw(lambda p: arrow(p, (2860, 1840), (2600, 1880), (2480, 1640)), CYAN)


def c_zero(ink):
    a = ink.text(160, 220, '$0', 540, YEL, rot=2)
    ink.text(a[2] + 60, 290, 'DOWN', 440, rot=2)
    ink.text(190, 880, '2 COMPANIES', 240, rot=1)
    # little deal timeline figure
    ink.draw(lambda p: (seg(p, (220, 1500), (1500, 1500), 12), circ(p, 450, 1500, 34, 14), circ(p, 1130, 1500, 34, 14)), WHITE)
    ink.text(370, 1260, 'DEAL 1', 120, GRN, rot=-3); ink.text(1040, 1260, 'DEAL 2', 120, GRN, rot=-3)
    ink.text(240, 1600, 'both 100% seller financed', 125, CYAN, rot=-1)
    ink.draw(lambda p: arrow(p, (1560, 1500), (1900, 1520), (2040, 1120)), WHITE)


def c_banker(ink):
    ink.text(170, 240, 'YOUR BANK', 300, rot=-2)
    b = ink.text(170, 560, 'SAID NO?', 480, YEL, rot=-2)
    ink.draw(lambda p: p.underline(190, b[2] - 60, b[3] + 40, w=14), WHITE)
    ink.draw(lambda p: bank(p, 330, 1360, 0.95), WHITE)
    ink.draw(lambda p: xmark(p, 580, 1580, 210, 26), RED)
    ink.text(1100, 1530, "here's why", 140, CYAN, rot=-4)


def c_firesale(ink):
    ink.text(160, 180, 'BUY THE', 280, rot=-2)
    b = ink.text(160, 450, 'FIRE SALE', 430, ORG, rot=-2)
    # crashing chart to zero
    pts = [(260, 1250), (520, 1150), (760, 1220), (980, 1120), (1180, 1350), (1360, 1640), (1520, 1880)]
    ink.draw(lambda p: (seg(p, (220, 1000), (220, 1950), 11), seg(p, (220, 1950), (1750, 1950), 11)), WHITE)
    ink.draw(lambda p: poly(p, pts, 14), RED)
    ink.draw(lambda p: circ(p, 1520, 1880, 95, 12), YEL)
    ink.text(1640, 1700, '$0', 170, YEL)


def c_multiple(ink):
    a = ink.text(160, 170, '$250K', 330, rot=-2)
    ink.text(a[2] + 50, 300, 'PROFIT', 170, rot=-2)
    b = ink.text(160, 560, '$500K', 400, GRN, rot=-2)
    ink.text(b[2] + 50, 720, 'OFFER', 190, GRN, rot=-2)
    t2 = ink.text(440, 1300, '2x', 280, YEL)
    ink.draw(lambda p: circ(p, (t2[0] + t2[2]) / 2, (t2[1] + t2[3]) / 2 + 10, 230, 14), YEL)
    ink.text(930, 1380, 'too low?', 150, CYAN, rot=-5)
    ink.draw(lambda p: arrow(p, (1500, 1500), (1850, 1560), (2050, 1250)), WHITE)


def c_tired(ink):
    ink.text(160, 170, '20 YEARS', 300, rot=-2)
    b = ink.text(160, 470, 'TIRED OWNER', 340, YEL, rot=-2)
    ink.draw(lambda p: battery(p, 260, 1180), WHITE)
    ink.draw(lambda p: fill_rect(p, 290, 1210, 380, 1390), RED)
    ink.text(920, 1200, '3%', 170, RED, rot=-3)
    ink.text(260, 1520, 'ready to sell', 150, CYAN, rot=-3)
    ink.draw(lambda p: arrow(p, (1150, 1600), (1700, 1660), (2000, 1250)), WHITE)


def c_staff(ink):
    ink.text(160, 160, 'HALF THE STAFF', 280, rot=-2)
    b = ink.text(160, 450, 'LEAVE?', 470, RED, rot=-2)
    for i in range(6):
        cx = 300 + i * 260
        ink.draw(lambda p, cx=cx: person(p, cx, 1230, 1.0), WHITE)
        if i % 2:
            ink.draw(lambda p, cx=cx: xmark(p, cx, 1360, 95, 18), RED)
    ink.text(300, 1560, 'the cash flow cost', 140, YEL, rot=-2)


CONCEPTS = {
    '100m': (44, 0.5, False, c_100m),
    'zero': (42, 0.70, False, c_zero),
    'banker': (358, 0.70, True, c_banker),
    'firesale': (120, 0.74, False, c_firesale),
    'multiple': (296, 0.72, False, c_multiple),
    'tired': (164, 0.72, False, c_tired),
    'staff': (416, 0.74, False, c_staff),
}


def build(name):
    t, jx, bw, fn = CONCEPTS[name]
    comp.CUT_L = 2500
    img, msk = comp.plate(t, josh_x=jx, zoom=1.25)
    base = grade(img, msk, bw=bw).convert('RGBA')
    if not bw:
        # darker left third for the lettering
        a = np.asarray(base).astype(float)
        x = np.linspace(0, 1, W)[None, :, None]
        g = np.clip(1 - x / 0.55, 0, 1) ** 1.5 * 0.45 if jx > 0.6 else 0
        a[..., :3] = a[..., :3] * (1 - g)
        base = Image.fromarray(a.astype('uint8'), 'RGBA')
    ink = Ink()
    fn(ink)
    out = ink.onto(base).convert('RGB')
    p = D + f'v6_{name}.png'
    out.save(p)
    out.resize((1600, 900), Image.LANCZOS).save(p.replace('.png', '_v.jpg'), quality=90)
    print('done', name)


if __name__ == '__main__':
    for n in (sys.argv[1:] or CONCEPTS):
        build(n)

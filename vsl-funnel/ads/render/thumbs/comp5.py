"""v5: Taki Moore-style system for Josh. Real cinematic frame, big white marker caps,
one warm accent word, white hand-drawn doodles. usage: python3 comp5.py NAME..."""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import comp

D, W, H = comp.D, 3840, 2160
MARK = D + 'fonts/CaveatBrush-Regular.ttf'
WHITE = (252, 252, 248)
ACC = (255, 196, 46)
RED = (240, 60, 50)
GREEN = (70, 220, 110)


def grade(img, msk, bw=False):
    a = np.asarray(img).astype(float) / 255
    m = np.asarray(msk.filter(ImageFilter.GaussianBlur(1.2))).astype(float)[..., None] / 255
    bg = np.asarray(img.filter(ImageFilter.GaussianBlur(6))).astype(float) / 255
    l = bg @ [0.3, 0.59, 0.11]
    bg = bg * 0.55 + l[..., None] * 0.45 if not bw else np.repeat(l[..., None], 3, 2)
    bg = np.clip((bg - 0.5) * 1.1 + 0.5, 0, 1) * 0.62
    j = np.clip((a - 0.5) * 1.12 + 0.52, 0, 1)
    jl = j @ [0.3, 0.59, 0.11]
    j = np.clip(jl[..., None] + (j - jl[..., None]) * (0.25 if bw else 1.08), 0, 1)
    out = bg * (1 - m) + j * m
    y, x = np.ogrid[:H, :W]
    d = np.sqrt(((x - W / 2) / (W / 2)) ** 2 + ((y - H / 2) / (H / 2)) ** 2)
    out = out * (1 - np.clip(d - 0.6, 0, 1) * 0.5)[..., None]
    im = Image.fromarray((out * 255).astype('uint8'))
    im = im.filter(ImageFilter.UnsharpMask(radius=24, percent=20, threshold=0))
    return im.filter(ImageFilter.UnsharpMask(radius=1.8, percent=130, threshold=1))


class Ink:
    """Marker layer at 2x, composited with a soft drop shadow for legibility."""
    def __init__(self):
        self.S = 2
        self.im = Image.new('RGBA', (W * 2, H * 2), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)
        self.pen = comp.Pen(5)

    def text(self, x, y, t, size, fill=WHITE, rot=0):
        f = ImageFont.truetype(MARK, size * 2)
        layer = Image.new('RGBA', self.im.size, (0, 0, 0, 0))
        dd = ImageDraw.Draw(layer)
        dd.text((x * 2, y * 2), t, font=f, fill=fill + (255,), stroke_width=4, stroke_fill=fill + (255,))
        b = dd.textbbox((x * 2, y * 2), t, font=f, stroke_width=4)
        if rot:
            layer = layer.rotate(rot, center=(x * 2, y * 2), resample=Image.BICUBIC)
        self.im.alpha_composite(layer)
        return [v / 2 for v in b]

    def strokes(self, fn, fill=WHITE):
        p = comp.Pen(5)
        fn(p)
        m = p.render().resize((W * 2, H * 2), Image.LANCZOS)
        col = Image.new('RGBA', self.im.size, fill + (255,))
        col.putalpha(m)
        self.im.alpha_composite(col)

    def onto(self, base):
        im = self.im.resize((W, H), Image.LANCZOS)
        a = im.split()[3]
        sh = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        sh.putalpha(a.filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * 0.75)))
        base.alpha_composite(sh, (6, 10))
        base.alpha_composite(im)
        return base


def xmark(p, cx, cy, r=110):
    p.stroke([(cx - r + i * 2 * r / 30, cy - r + i * 2 * r / 30 + (i % 7 - 3)) for i in range(31)], 30, taper=False)
    p.stroke([(cx + r - i * 2 * r / 30, cy - r + i * 2 * r / 30) for i in range(31)], 30, taper=False)


def check(p, x, y, s=130):
    pts = [(x + i * s * 0.4 / 15, y + i * s * 0.55 / 15) for i in range(16)]
    pts += [(x + s * 0.4 + i * s * 0.8 / 25, y + s * 0.55 - i * s * 1.25 / 25) for i in range(1, 26)]
    p.stroke(pts, 30, taper=False)


def build(name):
    t = comp.T[name]
    comp.CUT_L = 2500
    ink = Ink()
    if name == '100m':
        img, msk = comp.plate(t, josh_x=0.5, zoom=1.25)
        base = grade(img, msk).convert('RGBA')
        a = ink.text(150, 150, '$1M', 420, rot=4)
        ink.strokes(lambda p: xmark(p, a[2] + 200, (a[1] + a[3]) / 2 + 40), RED)
        b = ink.text(2560, 120, '$100M', 400, ACC, rot=-3)
        ink.strokes(lambda p: check(p, b[0] - 250, (b[1] + b[3]) / 2 - 10), GREEN)
        ink.text(2600, 660, 'BANKS PREFER IT', 135, rot=-3)
    elif name == 'zero':
        img, msk = comp.plate(t, josh_x=0.70, zoom=1.25)
        base = grade(img, msk).convert('RGBA')
        a = ink.text(170, 260, '$0', 520, ACC, rot=2)
        ink.text(a[2] + 70, 330, 'DOWN', 420, rot=2)
        c = ink.text(200, 900, '2 COMPANIES.', 230, rot=1)
        ink.text(230, 1240, '100% seller financed', 120, rot=-2)
        ink.strokes(lambda p: p.curve((1460, 1360), (1850, 1460), (2050, 1080), w=16, hs=90))
        ink.strokes(lambda p: p.underline(200, 1450, c[3] + 30, w=14, double=False), ACC)
    elif name == 'banker':
        img, msk = comp.plate(t, josh_x=0.70, zoom=1.25)
        base = grade(img, msk, bw=True).convert('RGBA')
        ink.text(170, 300, 'YOUR BANK', 300, rot=-2)
        b = ink.text(170, 640, 'SAID NO?', 470, ACC, rot=-2)
        ink.strokes(lambda p: p.underline(190, b[2] - 60, b[3] + 30, w=18), WHITE)
        ink.text(230, 1450, "here's why", 120, rot=-2)
    out = ink.onto(base).convert('RGB')
    p = D + f'v5_{name}.png'
    out.save(p)
    out.resize((1600, 900), Image.LANCZOS).save(p.replace('.png', '_v.jpg'), quality=90)
    print('done', name)


if __name__ == '__main__':
    for n in sys.argv[1:]:
        build(n)

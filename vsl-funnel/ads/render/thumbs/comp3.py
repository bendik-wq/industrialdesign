"""Thumbnail v3 'purple cow': B&W real set, Josh in colour, acid-lime accent, Unbounded + Plex Mono.
usage: python3 comp3.py NAME..."""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import comp  # plate(), D

D, W, H = comp.D, 3840, 2160
F = D + 'fonts/'
LIME = (204, 255, 46)
INK = (10, 10, 10)
WHITE = (247, 247, 242)
S = 2  # supersample for razor edges


def font(n, s, ax=None):
    f = ImageFont.truetype(F + n, s * S)
    if ax:
        f.set_variation_by_axes(ax)
    return f


def UB(s): return font('Unbounded.ttf', s, [900])
def MONO(s): return font('PlexMonoBold.ttf', s)


def grade(img, msk):
    a = np.asarray(img).astype(float) / 255
    m = np.asarray(msk.filter(ImageFilter.GaussianBlur(1.2))).astype(float)[..., None] / 255
    # background: high-contrast mono, slight blur, darker on the left
    bg = np.asarray(img.filter(ImageFilter.GaussianBlur(5))).astype(float) / 255
    l = bg @ [0.3, 0.59, 0.11]
    l = np.clip((l - 0.5) * 1.35 + 0.5, 0, 1) ** 1.25 * 0.8
    x = np.linspace(0, 1, W)[None, :]
    l = l * (0.28 + 0.72 * np.clip((x - 0.05) / 0.55, 0, 1) ** 1.3)
    bg = np.repeat(l[..., None], 3, 2)
    # Josh: full colour, punchy, sharp
    j = np.clip((a - 0.5) * 1.15 + 0.52, 0, 1) * np.array([1.03, 1.0, 0.97])
    sat_l = j @ [0.3, 0.59, 0.11]
    j = np.clip(sat_l[..., None] + (j - sat_l[..., None]) * 1.18, 0, 1)
    out = bg * (1 - m) + j * m
    im = Image.fromarray((out * 255).astype('uint8'))
    return im.filter(ImageFilter.UnsharpMask(radius=2.2, percent=110, threshold=1))


class Layer:
    def __init__(self):
        self.im = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)

    def text(self, x, y, t, f, fill, shadow=True):
        if shadow:
            self.d.text(((x + 14) * S, (y + 16) * S), t, font=f, fill=(0, 0, 0, 200), features=['lnum'])
        self.d.text((x * S, y * S), t, font=f, fill=fill + (255,), features=['lnum'])
        b = self.d.textbbox((x * S, y * S), t, font=f, features=['lnum'])
        return [v / S for v in b]

    def box(self, b, fill, pad=(40, 26), r=0):
        x0, y0, x1, y1 = b
        self.d.rounded_rectangle(((x0 - pad[0]) * S, (y0 - pad[1]) * S, (x1 + pad[0]) * S, (y1 + pad[1]) * S), r * S, fill=fill + (255,))

    def line(self, x0, y0, x1, y1, w, fill):
        self.d.line((x0 * S, y0 * S, x1 * S, y1 * S), fill=fill + (255,), width=w * S)

    def flat(self):
        return self.im.resize((W, H), Image.LANCZOS)


def measure(t, f):
    d = ImageDraw.Draw(Image.new('L', (8, 8)))
    b = d.textbbox((0, 0), t, font=f, features=['lnum'])
    return b[2] / S, b[3] / S, b[1] / S


def slip(lines, stamp, w=1050, rot=-7):
    """A loan-application slip: white card, mono text, lime 'stamp'."""
    h = 120 + 105 * len(lines) + 230
    c = Image.new('RGBA', (w * S, h * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(c)
    d.rounded_rectangle((0, 0, w * S, h * S), 18 * S, fill=WHITE + (255,))
    d.rectangle((0, 0, w * S, 26 * S), fill=INK + (255,))
    y = 70
    for t, sz in lines:
        d.text((55 * S, y * S), t, font=MONO(sz), fill=INK + (255,), features=['lnum'])
        y += 105
    st = Image.new('RGBA', (w * S, h * S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(st)
    f = font('Unbounded.ttf', 118, [900])
    tw, th, ty = measure(stamp, f)
    sx, sy = w - tw - 110, h - th - 70
    sd.rounded_rectangle(((sx - 30) * S, (sy - 10 + ty) * S, (sx + tw + 30) * S, (sy + th + 25) * S), 10 * S, outline=(220, 30, 30, 255), width=12 * S)
    sd.text((sx * S, sy * S), stamp, font=f, fill=(220, 30, 30, 255))
    st = st.rotate(9, resample=Image.BICUBIC, center=((sx + tw / 2) * S, (sy + th / 2) * S))
    c.alpha_composite(st)
    sh = Image.new('RGBA', c.size, (0, 0, 0, 0))
    sh.putalpha(c.split()[3].point(lambda v: v * 0.55).filter(ImageFilter.GaussianBlur(28 * S)))
    big = Image.new('RGBA', ((w + 200) * S, (h + 200) * S), (0, 0, 0, 0))
    big.alpha_composite(sh, (130 * S, 150 * S))
    big.alpha_composite(c, (100 * S, 100 * S))
    big = big.rotate(rot, resample=Image.BICUBIC, expand=True)
    return big.resize((big.width // S, big.height // S), Image.LANCZOS)


def build(name):
    t = comp.T[name]
    comp.CUT_L = {'100m': 600, 'zero': 600, 'banker': 1000}[name]
    img, msk = comp.plate(t, josh_x=0.72, zoom=1.3)
    base = grade(img, msk).convert('RGBA')
    L = Layer()
    X = 170
    if name == '100m':
        L.text(X, 250, 'LOAN REQUEST', MONO(78), WHITE, shadow=False)
        f = UB(420)
        tw, th, ty = measure('$100M', f)
        L.box((X, 380 + ty, X + tw, 380 + th), LIME, pad=(46, 40))
        L.text(X, 380, '$100M', f, INK, shadow=False)
        L.text(X + 6, 900, 'APPROVED.', UB(170), LIME)
        base.alpha_composite(L.flat())
        s = slip([('LOAN REQUEST', 64), ('AMOUNT  $1,000,000', 64)], 'DECLINED', rot=6)
        base.alpha_composite(s, (40, 1180))
    elif name == 'zero':
        f = UB(330)
        tw, th, ty = measure('$0', f)
        L.box((X, 300 + ty, X + tw, 300 + th), LIME, pad=(46, 40))
        L.text(X, 300, '$0', f, INK, shadow=False)
        L.text(X + tw + 80, 300, 'DOWN', f, WHITE)
        L.text(X + 6, 760, 'x2 COMPANIES', UB(150), LIME)
        L.box((X + 6, 1050, X + 1500, 1120), INK, pad=(30, 22))
        L.text(X + 6, 1040, '> 100% SELLER FINANCED_', MONO(86), LIME, shadow=False)
    elif name == 'banker':
        L.text(X, 300, 'YOUR BANKER', UB(170), WHITE)
        f = UB(330)
        tw, th, ty = measure('SAID NO?', f)
        L.box((X, 560 + ty, X + tw, 560 + th), LIME, pad=(46, 40))
        L.text(X, 560, 'SAID NO?', f, INK, shadow=False)
        base.alpha_composite(L.flat())
        s = slip([('APPLICANT  BUSINESS OWNER', 60), ('AMOUNT     $1,000,000', 60)], 'DECLINED', w=1150, rot=-5)
        base.alpha_composite(s, (110, 1020))
        L = Layer()
    base.alpha_composite(L.flat())
    out = base.convert('RGB')
    g = np.asarray(out).astype(float) + np.random.default_rng(2).normal(0, 2.2, (H, W, 3))
    out = Image.fromarray(g.clip(0, 255).astype('uint8'))
    p = D + f'v3_{name}.png'
    out.save(p)
    out.resize((1600, 900), Image.LANCZOS).save(p.replace('.png', '_v.jpg'), quality=90)
    print('done', name)


if __name__ == '__main__':
    for n in sys.argv[1:]:
        build(n)

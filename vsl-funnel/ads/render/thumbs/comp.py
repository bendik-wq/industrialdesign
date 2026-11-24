"""Thumbnail compositor: real video frame + grade + premium type + gold pen scribbles.
usage: python3 comp.py CONFIG_NAME"""
import sys, math, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

D = '/tmp/claude-0/-home-user-industrialdesign/e0d95f09-8bea-5c75-baeb-9fbcc1b56ec1/scratchpad/thumbs/'
F = D + 'fonts/'
W, H = 3840, 2160
NAVY = np.array([8, 16, 36], float)
GOLD = (214, 172, 96)
IVORY = (246, 240, 228)


def font(name, size, wght=None):
    f = ImageFont.truetype(F + name, size)
    if wght:
        try:
            f.set_variation_by_axes([wght])
        except Exception:
            pass
    return f


# ---------- plate ----------
def plate(t, josh_x=0.70, head_top=0.07, zoom=1.5):
    src = Image.open(D + f'clean_{t}.png').convert('RGB')
    m = Image.open(D + f'mask_{t}.png').convert('L')
    a = np.array(m) > 128
    rows = np.where(a.any(1))[0]
    top = rows[0]
    head = a[top:top + 450]
    cx = np.where(head.any(0))[0].mean()
    cw, ch = int(W / zoom), int(H / zoom)
    left = int(cx - josh_x * cw)
    tp = int(top - head_top * ch)
    left = max(0, min(left, src.width - cw)); tp = max(0, min(tp, src.height - ch))
    box = (left, tp, left + cw, tp + ch)
    ma = np.array(m).astype(float); xs = np.arange(ma.shape[1]); ma = (ma * np.clip((xs - (cx - CUT_L - 160)) / 320, 0, 1)[None, :]).astype('uint8')
    m = Image.fromarray(ma)
    img = src.crop(box).resize((W, H), Image.LANCZOS)
    msk = m.crop(box).resize((W, H), Image.LANCZOS)
    hc = np.where(head.any(0))[0]
    global HEAD
    HEAD = ((hc[0] - left) * zoom, (top - tp) * zoom, (hc[-1] - left) * zoom, (top + 450 - tp) * zoom)
    return img, msk


def grade_bg(img):
    bg = img.filter(ImageFilter.GaussianBlur(9))
    a = np.asarray(bg).astype(float) / 255
    lum = a @ [0.3, 0.59, 0.11]
    a = a * 0.45 + lum[..., None] * 0.55                       # partial desat
    sh = np.array([0.42, 0.62, 0.85]); hi = np.array([1.0, 0.86, 0.66])
    a = a * (sh + (hi - sh) * lum[..., None] ** 1.5)           # teal shadows, warm highlights
    a = a ** 1.1 * 0.88
    return Image.fromarray((a.clip(0, 1) * 255).astype('uint8'))


def grade_josh(img):
    a = np.asarray(img).astype(float) / 255
    a = (a - 0.5) * 1.12 + 0.5                                  # contrast
    a = a * np.array([1.04, 1.0, 0.95])                         # warm skin
    a = np.clip(a, 0, 1) ** 0.96
    out = Image.fromarray((a * 255).astype('uint8'))
    return out.filter(ImageFilter.UnsharpMask(radius=3, percent=70, threshold=2))


def radial(cx, cy, r, color, strength):
    y, x = np.ogrid[:H, :W]
    d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / r
    g = np.clip(1 - d, 0, 1) ** 2 * strength
    return g[..., None] * np.array(color, float)


def left_shade(arr, end=0.52, maxa=0.9):
    x = np.linspace(0, 1, W)
    g = np.clip(1 - x / end, 0, 1) ** 1.4 * maxa
    g = g[None, :, None]
    return arr * (1 - g) + NAVY * g


def vignette(arr, k=0.55):
    y, x = np.ogrid[:H, :W]
    d = np.sqrt(((x - W / 2) / (W / 2)) ** 2 + ((y - H / 2) / (H / 2)) ** 2)
    v = 1 - np.clip(d - 0.55, 0, 1) * k
    return arr * v[..., None]


def rim(mask, side='left'):
    m = np.asarray(mask).astype(float) / 255
    shifted = np.roll(m, 26 if side == 'left' else -26, axis=1)
    edge = np.clip(m - shifted, 0, 1)
    edge = np.asarray(Image.fromarray((edge * 255).astype('uint8')).filter(ImageFilter.GaussianBlur(10))).astype(float) / 255
    top = np.linspace(1.0, 0.25, H)[:, None]
    return edge * top


# ---------- pen strokes ----------
class Pen:
    def __init__(self, seed=1):
        self.S = 2
        self.layer = Image.new('L', (W * self.S, H * self.S), 0)
        self.d = ImageDraw.Draw(self.layer)
        self.r = random.Random(seed)

    def stroke(self, pts, w=14, taper=True):
        S = self.S
        n = len(pts)
        for i in range(n - 1):
            f = i / (n - 1)
            p = math.sin(math.pi * min(1, f * 1.15)) if taper else 1
            ww = max(2, w * (0.35 + 0.65 * p)) * S
            (x0, y0), (x1, y1) = pts[i], pts[i + 1]
            self.d.line([(x0 * S, y0 * S), (x1 * S, y1 * S)], fill=255, width=int(ww))
            r = ww / 2
            self.d.ellipse([x1 * S - r, y1 * S - r, x1 * S + r, y1 * S + r], fill=255)

    def wobble(self, pts, amt=3):
        out = []
        ph = self.r.random() * 6
        for i, (x, y) in enumerate(pts):
            out.append((x + math.sin(i * 0.21 + ph) * amt, y + math.cos(i * 0.17 + ph) * amt))
        return out

    def ellipse(self, cx, cy, rx, ry, rot=-4, w=13, over=0.12):
        t0 = self.r.uniform(-2.2, -1.6)
        n = 220
        pts = []
        for i in range(n + 1):
            t = t0 + (2 * math.pi * (1 + over)) * i / n
            grow = 1 + 0.06 * i / n
            x, y = rx * math.cos(t) * grow, ry * math.sin(t) * grow
            c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))
            pts.append((cx + x * c - y * s, cy + x * s + y * c))
        self.stroke(self.wobble(pts, 4), w)

    def curve(self, p0, p1, p2, w=12, head=True, hs=70):
        pts = []
        for i in range(121):
            t = i / 120
            pts.append(((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
                        (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]))
        self.stroke(self.wobble(pts, 2), w)
        if head:
            ex, ey = pts[-1]; px, py = pts[-8]
            ang = math.atan2(ey - py, ex - px)
            for da in (2.55, -2.45):
                hx, hy = ex + hs * math.cos(ang + da), ey + hs * math.sin(ang + da)
                self.stroke([(hx + (ex - hx) * k / 20, hy + (ey - hy) * k / 20) for k in range(21)], w * 0.95, taper=False)

    def underline(self, x0, x1, y, w=11, double=True):
        for k in range(2 if double else 1):
            yy = y + k * 34
            a, b = x0 + k * 40, x1 - k * 90
            pts = [(a + (b - a) * i / 60, yy + math.sin(i / 60 * math.pi) * -10 + self.r.uniform(-1, 1)) for i in range(61)]
            self.stroke(pts, w - k * 2)

    def strike(self, x0, x1, y, w=15):
        pts = [(x0 + (x1 - x0) * i / 60, y - (i / 60) * 50 + math.sin(i / 9) * 4) for i in range(61)]
        self.stroke(pts, w, taper=False)

    def render(self):
        return self.layer.resize((W, H), Image.LANCZOS)


def gold_fill(mask, glow=True):
    """Metallic gold: vertical gradient + subtle highlight band."""
    y = np.linspace(0, 1, H)[:, None]
    top = np.array([250, 226, 170]); mid = np.array([214, 168, 88]); bot = np.array([150, 104, 44])
    g = np.where(y[..., None] < 0.5, top + (mid - top) * (y[..., None] / 0.5), mid + (bot - mid) * ((y[..., None] - 0.5) / 0.5))
    g = np.broadcast_to(g, (H, W, 3))
    return g


def put(base, mask, color, alpha=1.0, glow=0, shadow=0):
    m = np.asarray(mask).astype(float)[..., None] / 255 * alpha
    if shadow:
        s = np.asarray(mask.filter(ImageFilter.GaussianBlur(shadow))).astype(float)[..., None] / 255
        s = np.roll(np.roll(s, 10, 0), 6, 1)
        base = base * (1 - s * 0.55)
    if glow:
        gl = np.asarray(mask.filter(ImageFilter.GaussianBlur(glow))).astype(float)[..., None] / 255
        base = base + gl * np.array([214, 168, 88]) * 0.35
    col = color if isinstance(color, np.ndarray) else np.array(color, float)
    return base * (1 - m) + col * m


def text_mask(spec):
    """spec: list of (x, y, text, fontname, size, wght)."""
    m = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(m)
    boxes = []
    for x, y, txt, fn, sz, wg in spec:
        f = font(fn, sz, wg)
        d.text((x, y), txt, font=f, fill=255, features=['lnum'])
        boxes.append(d.textbbox((x, y), txt, font=f, features=['lnum']))
    return m, boxes


def bbox(spec):
    d = ImageDraw.Draw(Image.new('L', (8, 8)))
    x, y, txt, fn, sz, wg = spec
    return d.textbbox((x, y), txt, font=font(fn, sz, wg), features=['lnum'])


def build(t, ivory_spec, gold_spec, scribble, note, out, josh_x=0.70):
    img, msk = plate(t, josh_x)
    bg = np.asarray(grade_bg(img)).astype(float)
    jo = np.asarray(grade_josh(img)).astype(float)
    m = np.asarray(msk.filter(ImageFilter.GaussianBlur(1.5))).astype(float)[..., None] / 255
    hx = josh_x * W
    bg = bg + radial(hx, H * 0.30, 1500, (255, 190, 110), 0.30)     # warm glow behind head
    hl = np.clip(bg - 150, 0, None)
    hl = np.asarray(Image.fromarray(hl.clip(0, 255).astype('uint8')).filter(ImageFilter.GaussianBlur(60))).astype(float)
    bg = bg + hl * 0.9                                                # highlight bloom
    bg = bg + radial(W * 1.02, -H * 0.05, 2300, (255, 170, 90), 0.22)  # warm window leak
    bg = left_shade(bg)
    pen_back = Pen(7)
    if 'back' in scribble: scribble['back'](pen_back)
    bg = put(bg, pen_back.render(), GOLD, alpha=0.55)
    jo = jo * (1 + radial(HEAD[0] + 300, HEAD[1] + 700, 1100, (1, 1, 1), 0.26))
    arr = bg * (1 - m) + jo * m
    r = rim(msk)[..., None]
    arr = arr + r * np.array([255, 205, 130]) * 0.55
    arr = vignette(arr)
    # type
    iv, _ = text_mask(ivory_spec)
    arr = put(arr, iv, IVORY, shadow=18)
    gm, _ = text_mask(gold_spec)
    arr = put(arr, gm, gold_fill(gm), shadow=18, glow=30)
    pen = Pen(3)
    scribble['front'](pen)
    sm = pen.render()
    if note:
        nd = Image.new('L', (W, H), 0)
        x, y, txt, fn, sz, rot = note
        tmp = Image.new('L', (W, H), 0)
        ImageDraw.Draw(tmp).text((x, y), txt, font=font(fn, sz), fill=255, stroke_width=3, stroke_fill=255)
        tmp = tmp.rotate(rot, center=(x, y), resample=Image.BICUBIC)
        sm = ImageChops.lighter(sm, tmp)
    arr = put(arr, sm, gold_fill(sm), shadow=10, glow=22)
    # grain
    arr = arr + np.random.default_rng(1).normal(0, 3.2, arr.shape)
    Image.fromarray(arr.clip(0, 255).astype('uint8')).save(out)
    Image.open(out).resize((1600, 900), Image.LANCZOS).save(out.replace('.png', '_v.jpg'), quality=90)


CONFIGS = {}


HAND = 'HomemadeApple-Regular.ttf'


def cfg_100m():
    X = 190
    a = (X, 330, '$100M', 'Playfair.ttf', 470, 700)
    b = (X + 10, 900, 'is easier to', 'PlayfairItalic.ttf', 200, 500)
    c = (X + 10, 1125, 'borrow than', 'PlayfairItalic.ttf', 200, 500)
    d = (X, 1370, '$1M', 'Playfair.ttf', 400, 700)
    A, Dd = bbox(a), bbox(d)

    def front(p):
        p.ellipse((A[0] + A[2]) / 2, (A[1] + A[3]) / 2, (A[2] - A[0]) / 2 + 90, (A[3] - A[1]) / 2 + 55, rot=-4, w=14)
        p.strike(Dd[0] - 40, Dd[2] + 50, (Dd[1] + Dd[3]) / 2 + 40, w=18)
        p.curve((A[2] + 170, A[1] - 10), (A[2] + 520, A[1] - 200), (2150, 640), w=13, hs=80)
    return dict(t=44, ivory=[b, c, d], gold=[a], scribble={'front': front},
                note=(1330, 1000, 'banks want this', HAND, 104, 9))


def cfg_zero():
    X = 190
    a = (X, 330, '$0 down.', 'Playfair.ttf', 450, 700)
    b = (X + 10, 940, 'Two companies.', 'PlayfairItalic.ttf', 230, 500)
    A, B = bbox(a), bbox(b)
    zero = bbox((X, 330, '$', 'Playfair.ttf', 450, 700))[2]
    zw = bbox((X, 330, '$0', 'Playfair.ttf', 450, 700))[2]

    def front(p):
        p.ellipse((zero + zw) / 2, (A[1] + A[3]) / 2 + 5, (zw - zero) / 2 + 65, (A[3] - A[1]) / 2 + 55, rot=8, w=14)
        p.underline(B[0], B[2], B[3] + 45, w=12)
        p.curve((B[0] + 1900, B[3] + 380), (2150, B[3] + 400), (2220, B[3] - 40), w=13, hs=80)
    return dict(t=42, ivory=[b], gold=[a], scribble={'front': front},
                note=(B[0] + 10, B[3] + 230, 'both 100% seller financed', HAND, 100, 3))


def cfg_banker():
    X = 190
    a = (X, 420, 'Your banker', 'Playfair.ttf', 300, 600)
    b = (X, 760, 'said no?', 'PlayfairItalic.ttf', 470, 700)
    B = bbox(b)
    no = bbox((X, 760, 'said ', 'PlayfairItalic.ttf', 470, 700))[2]

    def front(p):
        p.ellipse((no + B[2]) / 2 + 10, (B[1] + B[3]) / 2 + 15, (B[2] - no) / 2 + 85, (B[3] - B[1]) / 2 + 60, rot=-6, w=14)
    return dict(t=358, ivory=[a], gold=[b], scribble={'front': front},
                note=(no - 40, B[3] + 150, "here's why", HAND, 120, 4))


T = {'100m': 44, 'zero': 42, 'banker': 358}
HEAD = None
CUT_L = 640
CONFIGS = {'100m': cfg_100m, 'zero': cfg_zero, 'banker': cfg_banker}

if __name__ == '__main__':
    for name in sys.argv[1:]:
        plate(T[name])
        c = CONFIGS[name]()
        build(c['t'], c['ivory'], c['gold'], c['scribble'], c['note'], D + f'v2_{name}.png')
        print('done', name)

"""Kinetic-typography ad renderer for G&L creatives.

Style modelled on the reference "story ad" structure (see ../reference-analysis.md, ref D):
condensed didone title cards on black, revealed left-to-right; monospace subtitles over
procedural visuals; film grain + vignette; a generated score with sub hits on reveals.

Usage:  python3 render.py <script.py> <out.mp4> [--w 1080 --h 1920] [--preview]
A script module defines SCRIPT = [segment, ...] and optional TITLE.
Segment keys:
  d      duration (s)
  bg     black | stars | street | squares | key | warm | clock | ledger | white
  card   serif title text (centred)        size  font px (default 72)
  sub    monospace subtitle (lower third)
  big    True -> giant numeral styling
  hit    True -> sub-bass hit at segment start
  tick   True -> clock ticks during segment
  n      for squares: how many to show filled by segment end (of 52)
  note   small mono label on the card (e.g. proof attribution)
"""
import importlib.util, math, os, subprocess, sys, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SERIF = os.path.join(HERE, "fonts", "BodoniModa.ttf")
MONO = os.path.join(HERE, "fonts", "JetBrainsMono-Regular.ttf")
FPS = 30
CREAM = (242, 237, 228)
AMBER = (232, 170, 92)
BLUE = (120, 160, 230)
RNG = np.random.default_rng(7)

_font_cache = {}
def serif(px, wght=420):
    k = ("s", px, wght)
    if k not in _font_cache:
        f = ImageFont.truetype(SERIF, px)
        try:
            f.set_variation_by_axes([wght, min(28, max(6, px * 0.3))])
        except Exception:
            pass
        _font_cache[k] = f
    return _font_cache[k]

def mono(px):
    k = ("m", px)
    if k not in _font_cache:
        _font_cache[k] = ImageFont.truetype(MONO, px)
    return _font_cache[k]

def wrap(text, font, maxw):
    lines = _greedy(text, font, maxw)
    if len(lines) < 2: return lines
    # rebalance: shrink width until line count would grow (avoids orphans like "day?")
    best, w = lines, maxw
    while w > maxw * 0.45:
        w -= 20
        cand = _greedy(text, font, w)
        if len(cand) > len(lines): break
        best = cand
    return best

def _greedy(text, font, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if font.getlength(t) <= maxw or not cur:
            cur = t
        else:
            lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

def text_layer(W, H, text, font, fill, maxw, y_center, spacing=1.18, box=False):
    """Return (rgba image, bbox x0,x1) of centred multi-line text."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    lines = wrap(text, font, maxw)
    asc, desc = font.getmetrics()
    lh = int((asc + desc) * spacing)
    total = lh * len(lines)
    y = int(y_center - total / 2)
    x0s, x1s = [], []
    for ln in lines:
        w = font.getlength(ln)
        x = int((W - w) / 2)
        if box:
            d.rectangle([x - 14, y - 6, x + w + 14, y + lh - 4], fill=(0, 0, 0, 205))
        d.text((x, y), ln, font=font, fill=fill)
        x0s.append(x); x1s.append(x + w)
        y += lh
    return img, (min(x0s), max(x1s))

# ---------- procedural backgrounds (return float32 HxWx3 in 0..1) ----------
class BG:
    def __init__(s, W, H):
        s.W, s.H = W, H
        n = 900
        s.sx = RNG.uniform(0, W, n); s.sy = RNG.uniform(0, H, n)
        s.sz = RNG.uniform(0.3, 1.0, n) ** 3
        s.sph = RNG.uniform(0, 6.28, n)
        s.scol = np.where(RNG.uniform(0, 1, n)[:, None] > 0.7, np.array(AMBER) / 255, np.array([0.85, 0.88, 1.0]))
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        r = np.sqrt(((xx - W / 2) / (W * 0.75)) ** 2 + ((yy - H / 2) / (H * 0.62)) ** 2)
        s.vig = np.clip(1.15 - r ** 1.6, 0.25, 1.0)[..., None]
        s.radial = np.clip(1 - np.sqrt(((xx - W / 2) / (W * 0.6)) ** 2 + ((yy - H * 0.42) / (H * 0.45)) ** 2), 0, 1)
        s.grain = [RNG.normal(0, 1, (H // 2, W // 2)).astype(np.float32) for _ in range(6)]
        s.dust_x = RNG.uniform(0, W, 160); s.dust_y = RNG.uniform(0, H, 160); s.dust_v = RNG.uniform(6, 22, 160)
        s.street = s._make_street()

    def _make_street(s):
        W, H = s.W, s.H
        img = Image.new("RGB", (W * 2, H), (0, 0, 0))
        d = ImageDraw.Draw(img)
        x, base = 0, int(H * 0.72)
        rng = np.random.default_rng(3)
        s.windows = []
        while x < W * 2:
            bw = int(rng.uniform(260, 420)); bh = int(rng.uniform(380, 700))
            d.rectangle([x, base - bh, x + bw - 14, base], fill=(14, 14, 18))
            # sign board
            d.rectangle([x + 30, base - bh + 40, x + bw - 44, base - bh + 100], fill=(30, 28, 26))
            for wy in range(base - bh + 150, base - 120, 110):
                for wx in range(x + 40, x + bw - 80, 90):
                    s.windows.append((wx, wy, rng.uniform(0, 1)))
            # door + shop window
            d.rectangle([x + 40, base - 220, x + bw - 160, base - 30], fill=(22, 20, 18))
            x += bw
        d.rectangle([0, base, W * 2, H], fill=(6, 6, 8))
        return np.asarray(img).astype(np.float32) / 255

    def render(s, kind, t, lt, seg):
        W, H = s.W, s.H
        f = np.zeros((H, W, 3), np.float32)
        if kind in ("black", None):
            pass
        elif kind == "white":
            f[:] = np.array([0.975, 0.97, 0.96])
            return f
        elif kind == "stars":
            x = (s.sx + t * 14 * s.sz) % W; y = (s.sy - t * 4 * s.sz) % H
            b = (0.35 + 0.65 * (0.5 + 0.5 * np.sin(s.sph + t * 1.7))) * (0.25 + s.sz)
            xi, yi = x.astype(int), y.astype(int)
            for r in (0, 1):
                m = s.sz > (0.15 if r else -1)
                np.add.at(f, (np.clip(yi[m] + r, 0, H - 1), np.clip(xi[m], 0, W - 1)), (s.scol[m] * b[m, None]).astype(np.float32))
                np.add.at(f, (np.clip(yi[m], 0, H - 1), np.clip(xi[m] + r, 0, W - 1)), (s.scol[m] * b[m, None] * 0.6).astype(np.float32))
            f += (s.radial[..., None] ** 2) * np.array([0.05, 0.06, 0.12])
        elif kind == "street":
            off = int((t * 18) % W)
            f = s.street[:, off:off + W].copy()
            sky = np.linspace(0.10, 0.0, H)[:, None, None] * np.array([0.25, 0.32, 0.6])
            f += sky * (f.sum(2, keepdims=True) < 0.02)
            # windows: lit, then going dark one by one through the segment
            img = Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8))
            d = ImageDraw.Draw(img)
            p = lt / max(seg["d"], 0.1)
            for wx, wy, th in s.windows:
                X = wx - off
                if -60 < X < W:
                    lit = th > p * 0.85 if seg.get("dim") else True
                    if lit:
                        d.rectangle([X, wy, X + 46, wy + 64], fill=(205, 150, 80))
            f = np.asarray(img).astype(np.float32) / 255
            glow = np.asarray(Image.fromarray((f * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(18))).astype(np.float32) / 255
            f = f + glow * 0.6
        elif kind == "squares":
            n = seg.get("n", 52); total = 52
            p = min(1, lt / max(seg["d"] * 0.8, 0.1))
            filled = int(round(n * p))
            img = Image.new("RGB", (W, H)); d = ImageDraw.Draw(img)
            cols, sz, gap = 7, 104, 22
            gw = cols * sz + (cols - 1) * gap
            x0, y0 = (W - gw) // 2, int(H * 0.2)
            for i in range(total):
                r, c = divmod(i, cols)
                X, Y = x0 + c * (sz + gap), y0 + r * (sz + gap)
                if i < filled:
                    d.rectangle([X, Y, X + sz, Y + sz], fill=(150, 108, 60))
                else:
                    d.rectangle([X, Y, X + sz, Y + sz], outline=(70, 66, 60), width=3)
            f = np.asarray(img).astype(np.float32) / 255
        elif kind == "key":
            img = Image.new("RGB", (W, H)); d = ImageDraw.Draw(img)
            cx, cy = W / 2, H * 0.27
            ang = math.radians(-35 + 8 * math.sin(t * 0.35))
            sc = 0.82 + 0.025 * lt
            def P(x, y):
                x, y = x * sc, y * sc
                return (cx + x * math.cos(ang) - y * math.sin(ang), cy + x * math.sin(ang) + y * math.cos(ang))
            col = (214, 168, 98)
            # bow (ring)
            pts = [P(-260 + 130 * math.cos(a), 130 * math.sin(a)) for a in np.linspace(0, 6.283, 90)]
            d.line(pts + [pts[0]], fill=col, width=10)
            pts = [P(-260 + 62 * math.cos(a), 62 * math.sin(a)) for a in np.linspace(0, 6.283, 60)]
            d.line(pts + [pts[0]], fill=col, width=6)
            # shaft
            d.line([P(-130, -16), P(330, -16)], fill=col, width=10)
            d.line([P(-130, 16), P(330, 16)], fill=col, width=10)
            d.line([P(330, -16), P(330, 16)], fill=col, width=10)
            # teeth
            for x, h in ((200, 70), (250, 46), (290, 82)):
                d.line([P(x, 16), P(x, 16 + h), P(x + 30, 16 + h), P(x + 30, 16)], fill=col, width=8)
            f = np.asarray(img.filter(ImageFilter.GaussianBlur(0.6))).astype(np.float32) / 255
            glow = np.asarray(img.filter(ImageFilter.GaussianBlur(30))).astype(np.float32) / 255
            f = f + glow * 0.9
        elif kind == "warm":
            f += (s.radial[..., None] ** 1.5) * np.array([0.42, 0.24, 0.09]) * (0.85 + 0.15 * math.sin(t * 0.8))
            x = (s.dust_x + np.sin(t * 0.5 + s.dust_y) * 30) % W; y = (s.dust_y - t * s.dust_v) % H
            xi, yi = x.astype(int), y.astype(int)
            np.add.at(f, (yi, xi), np.array([0.9, 0.7, 0.45], np.float32))
            np.add.at(f, (np.clip(yi + 1, 0, H - 1), xi), np.array([0.5, 0.38, 0.25], np.float32))
        elif kind == "clock":
            img = Image.new("RGB", (W, H)); d = ImageDraw.Draw(img)
            cx, cy, R = W / 2, H * 0.4, 330
            d.ellipse([cx - R, cy - R, cx + R, cy + R], outline=(110, 104, 96), width=4)
            for i in range(60):
                a = i * 6 * math.pi / 180; L = 34 if i % 5 == 0 else 14
                d.line([(cx + (R - L) * math.sin(a), cy - (R - L) * math.cos(a)), (cx + (R - 6) * math.sin(a), cy - (R - 6) * math.cos(a))], fill=(150, 140, 128), width=4 if i % 5 == 0 else 2)
            sec = math.floor(t) * 6 * math.pi / 180
            d.line([(cx, cy), (cx + (R - 50) * math.sin(sec), cy - (R - 50) * math.cos(sec))], fill=AMBER, width=5)
            mn = t * 0.8 * math.pi / 180 * 6
            d.line([(cx, cy), (cx + (R - 120) * math.sin(mn), cy - (R - 120) * math.cos(mn))], fill=CREAM, width=9)
            d.ellipse([cx - 12, cy - 12, cx + 12, cy + 12], fill=AMBER)
            f = np.asarray(img).astype(np.float32) / 255
        elif kind == "ledger":
            if not hasattr(s, "_ledger"):
                rng = np.random.default_rng(11)
                img = Image.new("RGB", (W, H * 2)); d = ImageDraw.Draw(img); fm = mono(30)
                for i in range(int(H * 2 / 58)):
                    y = 40 + i * 58
                    d.line([(70, y + 44), (W - 70, y + 44)], fill=(34, 33, 30), width=1)
                    for c, x in enumerate((90, 430, 640, 850)):
                        if c == 0:
                            txt = "".join(rng.choice(list("ABCDEFGHKLMNPRSTW"), 3)) + "-" + str(rng.integers(100, 999))
                        else:
                            txt = f"{rng.integers(10, 999)},{rng.integers(100, 999)}"
                        d.text((x, y), txt, font=fm, fill=(92, 88, 80) if c else (70, 66, 60))
                sharp = np.asarray(img).astype(np.float32) / 255
                soft = np.asarray(img.filter(ImageFilter.GaussianBlur(7))).astype(np.float32) / 255
                yy = np.linspace(-1, 1, H * 2)[:, None, None]
                band = np.exp(-((np.abs(yy) * 3.0) ** 2) * 0)  # placeholder, focus computed per frame
                s._ledger = (sharp, soft)
            sharp, soft = s._ledger
            off = int((t * 26) % H)
            a_ = sharp[off:off + H]; b_ = soft[off:off + H]
            yy = np.linspace(0, 1, H)[:, None, None]
            focus = np.exp(-(((yy - 0.38) / 0.09) ** 2))  # shallow depth of field: one sharp band
            f = (a_ * focus + b_ * (1 - focus)) * 0.9
            f += (s.radial[..., None] ** 2) * np.array([0.06, 0.035, 0.012])
        return f

    def finish(s, f, fi, white=False):
        if white:
            g = s.grain[fi % 6]
            g = np.repeat(np.repeat(g, 2, 0), 2, 1)[: s.H, : s.W, None]
            return np.clip(f + g * 0.012, 0, 1)
        f = f * s.vig
        g = s.grain[fi % 6]
        g = np.repeat(np.repeat(g, 2, 0), 2, 1)[: s.H, : s.W, None]
        return np.clip(f + g * 0.035 + 0.012, 0, 1)

# ---------------- score ----------------
def score(segs, total, path, sr=48000):
    n = int(total * sr) + sr
    t = np.arange(n) / sr
    # arc: quiet open, build through the middle, lift at the end
    env = np.interp(t, [0, 4, total * 0.35, total * 0.7, total - 6, total - 1, total + 1], [0.15, 0.35, 0.55, 0.85, 0.7, 0.25, 0.0])
    drone = (np.sin(2 * np.pi * 55 * t) * 0.5 + np.sin(2 * np.pi * 82.4 * t + np.sin(t * 0.3)) * 0.25
             + np.sin(2 * np.pi * 110 * t) * 0.12 * (0.5 + 0.5 * np.sin(t * 0.21)))
    noise = RNG.normal(0, 1, n)
    k = np.exp(-np.arange(400) / 60.0); k /= k.sum()
    air = np.convolve(noise, k, "same") * 0.35 * (0.5 + 0.5 * np.sin(t * 0.13))
    pad = np.zeros(n)
    for fr in (220, 277.2, 329.6):  # A minor-ish pad, slow tremolo
        pad += np.sin(2 * np.pi * fr * t + np.sin(t * 0.7) * 0.6) * 0.04
    out = (drone * 0.55 + air * 0.25 + pad * np.interp(t, [0, total * 0.5, total], [0.2, 1.0, 0.6])) * env
    clock_t = 0.0
    for sgm in segs:
        s0 = int(clock_t * sr)
        if sgm.get("hit"):
            L = int(2.2 * sr); tt = np.arange(L) / sr
            boom = np.sin(2 * np.pi * (58 * np.exp(-tt * 1.4) + 28) * tt) * np.exp(-tt * 2.1)
            boom += RNG.normal(0, 1, L) * np.exp(-tt * 30) * 0.15
            out[s0:s0 + L] += boom[: len(out[s0:s0 + L])] * 0.95
            # duck the bed just before the hit (silence before impact)
            pre = int(0.35 * sr)
            if s0 > pre:
                out[s0 - pre:s0] *= np.linspace(1, 0.15, pre)
        if sgm.get("tick"):
            for k2 in range(int(sgm["d"])):
                p = s0 + k2 * sr
                L = int(0.05 * sr); tt = np.arange(L) / sr
                out[p:p + L] += np.sin(2 * np.pi * 2400 * tt) * np.exp(-tt * 140) * 0.25
        if sgm.get("bg") == "white":
            out[s0:] *= np.exp(-np.arange(n - s0) / sr / 2.5)
        clock_t += sgm["d"]
    out = np.tanh(out * 1.6) * 0.6
    st = np.stack([out, np.roll(out, 300)], 1)
    pcm = (st * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())

# ---------------- main ----------------
def main():
    a = sys.argv[1:]
    script_path, out = a[0], a[1]
    W = int(a[a.index("--w") + 1]) if "--w" in a else 1080
    H = int(a[a.index("--h") + 1]) if "--h" in a else 1920
    preview = "--preview" in a
    spec = importlib.util.spec_from_file_location("s", script_path); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    segs = mod.SCRIPT
    total = sum(s["d"] for s in segs)
    wav = out.replace(".mp4", ".wav"); score(segs, total, wav)
    starts, acc = [], 0.0
    for sg in segs: starts.append(acc); acc += sg["d"]
    tmpdir = os.path.abspath(out) + ".parts"; os.makedirs(tmpdir, exist_ok=True)
    jobs = [(i, segs[i], starts[i], W, H, preview, os.path.join(tmpdir, f"{i:03d}.mp4")) for i in range(len(segs))]
    from multiprocessing import Pool
    with Pool(int(os.environ.get("JOBS", os.cpu_count() or 2))) as pool:
        pool.map(render_segment, jobs)
    lst = os.path.join(tmpdir, "list.txt")
    open(lst, "w").write("".join(f"file '{j[-1]}'\n" for j in jobs))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-i", wav, "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out], check=True)
    import shutil; shutil.rmtree(tmpdir); os.remove(wav)
    print(f"{out}: {total:.1f}s")

_BG = {}
def render_segment(job):
    si, sg, t0, W, H, preview, path = job
    if (W, H) not in _BG: _BG[(W, H)] = BG(W, H)
    bg = _BG[(W, H)]
    scale = W / 1080
    fi = int(t0 * FPS)
    ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                           "-c:v", "libx264", "-preset", "veryfast" if preview else "medium", "-crf", "19", "-pix_fmt", "yuv420p", path], stdin=subprocess.PIPE)
    nf = int(round(sg["d"] * FPS))
    white = sg.get("bg") == "white"
    ink = (20, 18, 16, 255) if white else CREAM + (255,)
    L = []
    if sg.get("card"):
        px = int(sg.get("size", 220 if sg.get("big") else 72) * scale)
        yc = H * (0.40 if sg.get("sub") else (0.6 if sg.get("bg") == "key" else 0.47))
        L.append(("card",) + text_layer(W, H, sg["card"], serif(px, 470 if not sg.get("big") else 560), ink, W * 0.8, yc))
    if sg.get("note"):
        L.append(("note",) + text_layer(W, H, sg["note"], mono(int(30 * scale)), (150, 140, 128, 255) if not white else (90, 86, 80, 255), W * 0.8, H * (0.69 if sg.get("bg") == "key" else 0.58)))
    if sg.get("sub"):
        L.append(("sub",) + text_layer(W, H, sg["sub"], mono(int(38 * scale)), (236, 232, 224, 255), W * 0.82, H * 0.74, box=True))
    for k in range(nf):
        lt = k / FPS; t = t0 + lt
        frame = bg.render(sg.get("bg", "black"), t, lt, sg)
        img = Image.fromarray((np.clip(frame, 0, 1) * 255).astype(np.uint8)).convert("RGBA")
        for kind, layer, (x0, x1) in L:
            rev = 0.55 if kind == "card" else 0.3
            p = min(1, lt / rev)
            fade_out = min(1, (sg["d"] - lt) / 0.18) if not sg.get("hold") else 1
            if kind == "card" and not sg.get("big"):
                edge = x0 + (x1 - x0 + 160) * p
                ramp = np.clip((edge - np.arange(W)) / 160, 0, 1) * fade_out
                a_ = (np.asarray(layer.getchannel("A"), np.float32) * ramp[None, :]).astype(np.uint8)
            else:
                a_ = (np.asarray(layer.getchannel("A"), np.float32) * min(1, p) * fade_out).astype(np.uint8)
            lay = layer.copy(); lay.putalpha(Image.fromarray(a_))
            if kind == "card" and not white:
                sc = 1 + 0.012 * lt
                if sc > 1.001:
                    lw, lh = int(W * sc), int(H * sc)
                    lay = lay.resize((lw, lh), Image.BILINEAR).crop(((lw - W) // 2, (lh - H) // 2, (lw - W) // 2 + W, (lh - H) // 2 + H))
            img.alpha_composite(lay)
        fr = bg.finish(np.asarray(img.convert("RGB")).astype(np.float32) / 255, fi, white)
        ff.stdin.write((fr * 255).astype(np.uint8).tobytes())
        fi += 1
    ff.stdin.close(); ff.wait()

def _unused():
    pass

if __name__ == "__main__":
    main()

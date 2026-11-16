"""Narration for an ad script via Fish Audio TTS, timed to the cards.

  FISH_API_KEY=... python3 vo.py <script.py> <voice_id> <outdir>

Groups consecutive segments into sentences (a card split across several segments is read
once), synthesises each sentence, then writes:
  <outdir>/timed_script.py  - the script with segment durations stretched where the voice
                              needs longer (render.py and score.py take this file as-is)
  <outdir>/vo.wav           - the narration laid on that timeline
The key is read from the environment only and never written anywhere.
"""
import importlib.util, json, os, re, subprocess, sys, urllib.request, wave
import numpy as np

SR = 48000
SPOKEN = [(r"\b1 in 1\b", "one in one"), (r"100%", "one hundred percent"), (r"\b52\b", "fifty-two"),
          (r"\b25\b", "twenty-five"), (r"G&L M&A Advisory", "G and L, M and A Advisory"), (r"&", "and")]


def say(text):
    for a, b in SPOKEN: text = re.sub(a, b, text)
    return text


def tts(text, voice, path, key):
    body = json.dumps({"text": text, "reference_id": voice, "format": "wav", "sample_rate": SR,
                       "latency": "normal", "prosody": {"speed": 0.92}}).encode()
    req = urllib.request.Request("https://api.fish.audio/v1/tts", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "model": "s1"})
    with urllib.request.urlopen(req, timeout=120) as r, open(path + ".src", "wb") as f:
        f.write(r.read())
    # normalise format, trim silence at both ends
    subprocess.run(["sox", path + ".src", "-r", str(SR), "-c", "1", "-b", "16", path, "silence", "1", "0.02", "0.5%",
                    "reverse", "silence", "1", "0.05", "0.5%", "reverse"], check=True)
    os.remove(path + ".src")
    with wave.open(path) as w:
        return w.getnframes() / SR


def main():
    script, voice, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
    key = os.environ["FISH_API_KEY"]
    os.makedirs(outdir, exist_ok=True)
    s = importlib.util.spec_from_file_location("m", script); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
    segs = [dict(g) for g in m.SCRIPT]

    # sentence groups: [(first_idx, last_idx, text)]
    groups, cur, buf = [], None, []
    for i, g in enumerate(segs):
        txt = g.get("vo", g.get("card") or g.get("sub") or "")
        if g.get("bg") == "white" and not g.get("vo"): txt = g.get("card", "")
        if not txt:
            continue
        if cur is None: cur = i
        buf.append(txt)
        if re.search(r"[.?!…]$", txt.strip()):
            groups.append((cur, i, " ".join(buf))); cur, buf = None, []
    if buf: groups.append((cur, len(segs) - 1, " ".join(buf)))

    clips = []
    for gi, (a, b, txt) in enumerate(groups):
        p = os.path.join(outdir, f"line_{gi:02d}.wav")
        dur = tts(say(txt), voice, p, key)
        span = sum(segs[k]["d"] for k in range(a, b + 1))
        need = dur + 0.35  # breath after the line
        if need > span:  # stretch this group's segments proportionally
            f = need / span
            for k in range(a, b + 1): segs[k]["d"] = round(segs[k]["d"] * f, 2)
        clips.append((a, p))
        print(f"{gi:02d} {dur:5.2f}s  {txt}")

    starts, t = [], 0.0
    for g in segs: starts.append(t); t += g["d"]
    total = t
    mix = np.zeros(int((total + 1) * SR), np.float32)
    for a, p in clips:
        with wave.open(p) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        s0 = int((starts[a] + 0.12) * SR)
        mix[s0:s0 + len(x)] += x[: len(mix) - s0]
    pcm = (np.clip(mix, -1, 1) * 32767).astype(np.int16)
    with wave.open(os.path.join(outdir, "vo.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())

    # timed script keeps every other field (MUSIC times are scaled to the new length)
    old_total = sum(g["d"] for g in m.SCRIPT)
    k = total / old_total
    music = [(round(ts * k, 2), lv) for ts, lv in getattr(m, "MUSIC", [])]
    dark = [(round(a * k, 2), round(b * k, 2)) for a, b in getattr(m, "DARK", [])]
    with open(os.path.join(outdir, "timed_script.py"), "w") as f:
        f.write(f"TITLE = {getattr(m, 'TITLE', '')!r}\nSCRIPT = {segs!r}\nMUSIC = {music!r}\nDARK = {dark!r}\n")
    print(f"total {old_total:.1f}s -> {total:.1f}s")


if __name__ == "__main__":
    main()

# Usage: python3 stitch.py <name> "<cta html>"  -> <name>.m4a + tl_<name>.json
import json, subprocess, sys, wave, re
N, CTA = sys.argv[1], sys.argv[2]
secs = json.load(open(f"{N}.json")); d = f"parts_{N}"; GAP = 0.6; PAUSE = 0.22; SR = 44100
pcm, t, tl_secs, words = b"", 0.0, [], []
for i, s in enumerate(secs):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f"{d}/s{i}.mp3", "-ac", "1", "-ar", str(SR), "-sample_fmt", "s16", f"{d}/s{i}.wav"], check=True)
    w = wave.open(f"{d}/s{i}.wav"); data = w.readframes(w.getnframes()); w.close()
    tl_secs.append({"eyebrow": s["eb"], "headline": s["hl"], "t": round(t + 0.15, 3)})
    ws = [x for x in json.load(open(f"{d}/s{i}.json"))["words"] if x.get("type") == "word"]
    # a short extra pause after each sentence: cut midway through the existing gap and insert silence
    cuts = []
    for k in range(len(ws) - 1):
        if re.search(r"[.?!]$", ws[k]["text"].strip()):
            cuts.append(((ws[k]["end"] + ws[k + 1]["start"]) / 2, k + 1))
    shift, pos, out = 0.0, 0, b""
    ci = 0
    for k, x in enumerate(ws):
        while ci < len(cuts) and cuts[ci][1] == k:
            c = int(cuts[ci][0] * SR) * 2; out += data[pos:c] + b"\0\0" * int(PAUSE * SR); pos = c; shift += PAUSE; ci += 1
        words.append({"w": x["text"].strip(), "s": round(t + x["start"] + shift, 3), "e": round(t + x["end"] + shift, 3)})
    out += data[pos:]; data = out
    pcm += data; t += len(data) / 2 / SR
    if i < len(secs) - 1: pcm += b"\0\0" * int(GAP * SR); t += GAP
pcm += b"\0\0" * int(1.5 * SR); t += 1.5
w = wave.open(f"{N}_raw.wav", "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm); w.close()
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f"{N}_raw.wav", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", f"{N}.m4a"], check=True)
# caption lines: up to ~44 chars, break early after punctuation
lines, cur = [], []
for x in words:
    cur.append(x); txt = " ".join(y["w"] for y in cur)
    gap_next = False
    if len(txt) >= 44 or (re.search(r"[.?!]$", x["w"]) and len(cur) >= 2) or (re.search(r",$", x["w"]) and len(txt) >= 26):
        lines.append(cur); cur = []
if cur: lines.append(cur)
json.dump({"dur": round(t, 3), "secs": tl_secs, "chunks": lines, "cta": CTA}, open(f"tl_{N}.json", "w"))
print(N, "duration", round(t / 60, 2), "min,", len(words), "words,", len(lines), "caption lines")

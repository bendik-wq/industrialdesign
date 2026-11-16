"""Cinematic music bed from Google Lyria 3.5 through Treg, fitted to an ad's story arc.

  TREG_TOKEN=... python3 lyria.py gen <out.mp3> [prompt-file]      # one song (~3 min), $0.08
  python3 lyria.py fit <song.mp3> <script.py> <out.wav>             # pick the best stretch

`fit` slides an ad-length window over the song's loudness envelope and picks the offset that
best matches the script's MUSIC curve (quiet hook, build, peak at the reach, quiet bookend),
then fades it in/out and lets the last chord ring under the white card.
"""
import base64, importlib.util, json, os, subprocess, sys, urllib.request, wave
import numpy as np

PROMPT = (
    "Original cinematic orchestral instrumental for a film trailer about ambition and legacy. "
    "80 BPM, D minor. It opens with a solitary, intimate felt-piano ostinato of repeating eighth notes. "
    "Soft sustained strings enter, then low cellos pulse underneath. It builds patiently and steadily: "
    "choir pads, warm French horns carry a noble rising melody, deep taiko and timpani hits mark each new section, "
    "with braam-like low brass swells. It rises to a soaring, hopeful, emotional climax with full strings and horns, "
    "then pulls back to the lone piano and ends on a warm, resolved major chord that rings out. "
    "Inspiring, majestic, determined, human. No vocals, no lyrics, no drums kit, no electronic beats."
)


def gen(out, prompt):
    args = {"endpoint_id": "google-ai.music-gen.lyria-3-5", "method": "POST",
            "query": {"model": "lyria-3.5"}, "body": {"contents": [{"parts": [{"text": prompt}]}]}}
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "call", "arguments": args}}).encode()
    req = urllib.request.Request("https://treg.to/mcp/", data=payload, method="POST", headers={
        "Authorization": "Bearer " + os.environ["TREG_TOKEN"], "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"})
    raw = urllib.request.urlopen(req, timeout=600).read().decode()
    blob = None
    for line in raw.splitlines():
        line = line.removeprefix("data: ").strip()
        if not line.startswith("{"):
            continue
        res = json.loads(line).get("result") or {}
        for c in res.get("content", []):
            if c.get("type") == "audio":
                blob = base64.b64decode(c["data"])
            elif c.get("type") == "text":
                try:
                    body = json.loads(c["text"])
                except Exception:
                    print(c["text"][:500]); continue
                b = body.get("body", body)
                b = b.get("result", b) if isinstance(b, dict) else b
                for cand in (b or {}).get("candidates", []):
                    for p in cand.get("content", {}).get("parts", []):
                        if "inlineData" in p: blob = base64.b64decode(p["inlineData"]["data"])
                        elif "text" in p: print("sections:", p["text"][:300])
                if blob is None: print(json.dumps(body)[:600])
    if blob is None:
        raise SystemExit("no audio returned")
    open(out, "wb").write(blob)
    print("saved", out, len(blob) // 1024, "KB")


def env_of(path, sr=8000, hop=0.5):
    x = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"], capture_output=True, check=True).stdout
    x = np.frombuffer(x, np.int16).astype(np.float32) / 32768
    n = int(sr * hop)
    e = np.array([np.sqrt((x[i:i + n] ** 2).mean()) for i in range(0, len(x) - n, n)])
    return 20 * np.log10(e + 1e-6), len(x) / sr


def fit(song, script, out):
    s = importlib.util.spec_from_file_location("m", script); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
    total = sum(g["d"] for g in m.SCRIPT)
    white = next((sum(x["d"] for x in m.SCRIPT[:i]) for i, g in enumerate(m.SCRIPT) if g.get("bg") == "white"), total - 5)
    music = getattr(m, "MUSIC", [(0, 1), (total * 0.7, 5)])
    hop = 0.5
    e, dur = env_of(song, hop=hop)
    tgt = np.array([max(l for ts, l in music if ts <= t) if any(ts <= t for ts, _ in music) else 1 for t in np.arange(0, white, hop)], float)
    L = len(tgt)
    best = (-9, 0)
    for off in range(0, max(1, len(e) - L - int(4 / hop))):
        w = e[off:off + L]
        if len(w) < L: break
        c = np.corrcoef(w, tgt)[0, 1]
        # prefer windows whose start is quiet (the hook needs room for the voice)
        c -= 0.02 * max(0, w[:6].mean() - e.mean())
        if c > best[0]: best = (c, off)
    off = best[1] * hop
    print(f"song {dur:.0f}s, ad {total:.1f}s, best offset {off:.1f}s (match {best[0]:.2f})")
    # take the window, fade the head, and let the tail ring through the white card
    tmp = out + ".src.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", song, "-ar", "48000", "-ac", "2", tmp], check=True)
    subprocess.run(["sox", tmp, out, "trim", f"{off:.2f}", f"{total + 0.5:.2f}",
                    "fade", "t", "0.8", f"{total + 0.5:.2f}", "2.5", "gain", "-n", "-1.5"], check=True)
    os.remove(tmp)


if __name__ == "__main__":
    if sys.argv[1] == "gen":
        prompt = open(sys.argv[3]).read() if len(sys.argv) > 3 else PROMPT
        gen(sys.argv[2], prompt)
    else:
        fit(sys.argv[2], sys.argv[3], sys.argv[4])

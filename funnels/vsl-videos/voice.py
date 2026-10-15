# Usage: python3 voice.py <scratchpad> <name>   -> parts_<name>/s<i>.mp3 + s<i>.json (heard words with timestamps)
import json, re, subprocess, sys, os
S, N = sys.argv[1], sys.argv[2]
KEY = open(f"{S}/elevenlabs_voice_key").read().strip(); VID = "CzDOqzvGBuRK8lMYWZ2O"
C = [x["text"] for x in json.load(open(f"{N}.json"))]; d = f"parts_{N}"; os.makedirs(d, exist_ok=True)
words = lambda s: re.findall(r"[a-z0-9']+", s.lower().replace("-", " "))
FILL = {"um", "uh", "umm", "erm", "ah", "uhh", "hmm", "mm"}
def tts(i, seed, out):
    body = {"text": C[i], "model_id": "eleven_multilingual_v2", "apply_text_normalization": "auto", "seed": seed,
            "previous_text": C[i-1][-400:] if i else "", "next_text": C[i+1][:400] if i+1 < len(C) else "",
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.95, "style": 0.3, "use_speaker_boost": True, "speed": 0.95}}
    r = subprocess.run(["curl", "-s", "-o", out, "-w", "%{http_code}", "-X", "POST", f"https://api.elevenlabs.io/v1/text-to-speech/{VID}?output_format=mp3_44100_128",
                        "-H", f"xi-api-key: {KEY}", "-H", "Content-Type: application/json", "-d", json.dumps(body)], capture_output=True, text=True)
    return r.stdout == "200"
def stt(f):
    r = subprocess.run(["curl", "-s", "-X", "POST", "https://api.elevenlabs.io/v1/speech-to-text", "-H", f"xi-api-key: {KEY}", "-F", "model_id=scribe_v1",
                        "-F", "tag_audio_events=true", "-F", "timestamps_granularity=word", "-F", f"file=@{f}"], capture_output=True, text=True)
    return json.loads(r.stdout)
for i in range(len(C)):
    if os.path.exists(f"{d}/s{i}.json"): continue
    best = None
    for a in range(6):
        tmp = f"{d}/try{i}_{a}.mp3"
        if not tts(i, 5000 + i * 31 + a, tmp): print(i, "tts failed", flush=True); continue
        res = stt(tmp); heard = res.get("text", "")
        hw = words(re.sub(r"\([^)]*\)", "", heard)); want = words(C[i])
        fill = [w for w in hw if w in FILL]
        dup = [hw[k] for k in range(len(hw) - 1) if hw[k] == hw[k + 1] and hw[k] not in ("that", "had")]
        ev = re.findall(r"\((?:laugh|sigh|cough|breath|clear)[^)]*\)", heard.lower())
        score = len(fill) * 3 + len(dup) * 2 + len(ev) * 2 + max(0, abs(len(hw) - len(want)) - 3)
        if best is None or score < best[0]: best = (score, tmp, res)
        print(N, i, "try", a + 1, "fill", fill, "dup", dup, "ev", ev, "words", len(hw), "/", len(want), flush=True)
        if score == 0: break
    os.replace(best[1], f"{d}/s{i}.mp3"); json.dump(best[2], open(f"{d}/s{i}.json", "w"))
    print(N, i, "kept score", best[0], flush=True)
print(N, "done", flush=True)

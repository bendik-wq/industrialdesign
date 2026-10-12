#!/usr/bin/env python3
"""Create Josh's Professional Voice Clone in ElevenLabs from the clips prepare.py wrote.

Usage:
  ELEVENLABS_API_KEY=... python3 clone.py create <clips folder>   # make the voice, upload clips, start verification
  ELEVENLABS_API_KEY=... python3 clone.py status <voice_id>        # verification and training state
  ELEVENLABS_API_KEY=... python3 clone.py captcha <voice_id>       # save the prompt Josh reads to verify (or verify in the app)
  ELEVENLABS_API_KEY=... python3 clone.py verify <voice_id> <file> # send his recording of the prompt
  ELEVENLABS_API_KEY=... python3 clone.py train <voice_id>         # start training once Josh has verified

The key needs voice permissions (Voices: write; a Creator plan or higher for Professional clones). The key only
lives in the environment of this command; nothing is written to disk.

Verification: ElevenLabs only trains a Professional clone after the speaker proves it's their voice. `create` asks
for the captcha: Josh opens the voice in the ElevenLabs app (Voices → My voices → Josh Li) and reads the short
prompt out loud, or you upload a consent recording there. Then run `train`. Training takes a few hours; the
voice_id is the one to set as JOSH_VOICE_ID (wrangler secret put JOSH_VOICE_ID) or under Settings → Integrations.
"""
import json, os, sys, urllib.request, uuid

API = "https://api.elevenlabs.io/v1"
KEY = os.environ.get("ELEVENLABS_API_KEY", "")


def call(method, path, body=None, files=None, field="files"):
    headers = {"xi-api-key": KEY, "User-Agent": "warplan-voice-clone"}
    data = None
    if files is not None:
        boundary = uuid.uuid4().hex
        chunks = []
        for k, v in (body or {}).items():
            chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
        for path_ in files:
            with open(path_, "rb") as fh:
                chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{os.path.basename(path_)}\"\r\nContent-Type: application/octet-stream\r\n\r\n".encode() + fh.read() + b"\r\n")
        chunks.append(f"--{boundary}--\r\n".encode())
        data = b"".join(chunks)
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        sys.exit(f"ElevenLabs {e.code} on {method} {path}: {e.read().decode()[:400]}")


def create(folder):
    clips = sorted(os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".wav"))
    if not clips:
        sys.exit(f"No .wav clips in {folder}: run prepare.py first")
    v = call("POST", "/voices/pvc", {
        "name": "Josh Li", "language": "en",
        "description": "Josh Li, Australian male, founder of JC Health Group. Clear, direct, conversational delivery. Trained on his solo YouTube videos, with his consent, for Warplan's Ask Josh.",
        "labels": {"accent": "australian", "gender": "male", "language": "en"},
    })
    vid = v["voice_id"]
    print(f"Created voice {vid}. Uploading {len(clips)} clips…")
    for i in range(0, len(clips), 5):   # a few files per request keeps each upload small
        call("POST", f"/voices/pvc/{vid}/samples", {"remove_background_noise": "false"}, files=clips[i:i + 5])
        print(f"  uploaded {min(i + 5, len(clips))}/{len(clips)}")
    print(f"\nNext: Josh verifies it's his voice in the ElevenLabs app (Voices → My voices → Josh Li → Verify),\nthen run:  python3 clone.py train {vid}")


def status(vid):
    v = call("GET", f"/voices/{vid}")
    fine = v.get("fine_tuning", {})
    print(json.dumps({"voice_id": vid, "name": v.get("name"), "category": v.get("category"),
                      "verified": fine.get("is_allowed_to_fine_tune"), "verification_attempts": fine.get("verification_attempts_count"),
                      "state": fine.get("state"), "progress": fine.get("progress"), "samples": len(v.get("samples") or [])}, indent=1))


def captcha(vid):
    """Save the verification prompt as captcha.png: Josh reads it out loud and records it."""
    import base64
    r = call("GET", f"/voices/pvc/{vid}/captcha")
    img = r if isinstance(r, str) else r.get("captcha") or r.get("image") or next(iter(r.values()))
    open("captcha.png", "wb").write(base64.b64decode(img))
    print(f"Saved captcha.png. Josh records himself reading it, then: python3 clone.py verify {vid} recording.m4a")


def verify(vid, recording=None):
    if not recording:
        sys.exit("Give the recording: python3 clone.py verify <voice_id> <recording file>")
    call("POST", f"/voices/pvc/{vid}/captcha", {}, files=[recording], field="recording")
    print(f"Verification sent. Check with: python3 clone.py status {vid}; then: python3 clone.py train {vid}")


def train(vid):
    call("POST", f"/voices/pvc/{vid}/train", {"model_id": "eleven_multilingual_v2"})
    print(f"Training started for {vid}. It takes a few hours; check with: python3 clone.py status {vid}")


if __name__ == "__main__":
    if not KEY or len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    {"create": create, "status": status, "train": train, "captcha": captcha, "verify": verify}[sys.argv[1]](*sys.argv[2:4])

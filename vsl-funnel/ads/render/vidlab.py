"""VidLab client. Key from env VIDLAB_API_KEY (never stored).
usage: python3 vidlab.py MODEL OUT 'json-input' [--quote]"""
import os, sys, json, uuid, time, requests
API = "https://vidlab.ai/v1"
H = {"Authorization": f"Bearer {os.environ['VIDLAB_API_KEY']}"}

def quote(model, inp):
    r = requests.post(f"{API}/generations/quote", headers=H, json={"model": model, "input": inp}, timeout=60)
    return r.json()

def generate(model, inp, out, max_cost=None):
    body = {"model": model, "input": inp}
    if max_cost: body["max_cost_usd"] = max_cost
    r = requests.post(f"{API}/generations", headers={**H, "Idempotency-Key": str(uuid.uuid4())}, json=body, timeout=60)
    if r.status_code >= 400: raise SystemExit(r.text)
    job = r.json()["data"]
    while job["status"] in ("queued", "running"):
        job = requests.get(f"{API}/generations/{job['id']}", params={"wait": 60}, headers=H, timeout=90).json()["data"]
    if job["status"] != "succeeded": raise SystemExit(json.dumps(job.get("error")))
    f = requests.get(f"{API}/generations/{job['id']}/content", headers=H, timeout=300)
    open(out, "wb").write(f.content)
    return job

if __name__ == "__main__":
    model, out, inp = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    print(json.dumps(quote(model, inp) if "--quote" in sys.argv else generate(model, inp, out)))

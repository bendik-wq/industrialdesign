"""roofscan: find roofs in bad shape in Bergen from Google satellite imagery.

Pipeline:
  1. Places API text search -> candidate buildings (name, address, lat/lng)
  2. Solar API buildingInsights -> building footprint bbox, roof area, imagery date
  3. Static Maps satellite tile of the footprint
  4. Pixel heuristics inside the footprint -> "shitty score"
       moss/algae (green), rust (orange-brown), patchiness (repairs, ponding,
       mismatched membrane), dark staining
  5. results.csv + report.html + contact sheets for human review

The API key is read only from $GOOGLE_API_KEY (keep it in ~/.secrets/google.env,
never in the repo). A hard request budget stops runaway spend.
"""
import argparse, csv, html, io, json, math, os, sys, time
from pathlib import Path

import numpy as np
import requests
from PIL import Image, ImageDraw

KEY = os.environ.get("GOOGLE_API_KEY")
BERGEN = (60.3913, 5.3221)
QUERIES = [
    "lager i Bergen", "industribygg Bergen", "verksted Bergen", "næringsbygg Bergen",
    "lagerbygg Bergen", "fabrikk Bergen", "bilverksted Bergen", "logistikk Bergen",
    "byggevare Bergen", "kjøpesenter Bergen", "idrettshall Bergen", "skole Bergen",
    "borettslag Bergen", "landbruk fjøs Bergen", "båtnaust Bergen", "hotell Bergen",
    "barnehage Bergen", "kontorbygg Bergen", "grossist Bergen", "mekanisk verksted Bergen",
]


class Budget:
    def __init__(self, n): self.left = n
    def take(self):
        if self.left <= 0: sys.exit("request budget exhausted, stopping")
        self.left -= 1


def get(url, budget, **kw):
    budget.take()
    r = None
    for i in range(4):
        try:
            r = requests.post(url, timeout=30, **kw) if "json" in kw else requests.get(url, timeout=30, **kw)
        except requests.RequestException:
            time.sleep(2 ** i); continue
        if r.status_code in (429, 500, 503): time.sleep(2 ** i); continue
        return r
    return r


def places(budget, per_query_pages):
    seen = {}
    for q in QUERIES:
        token = None
        for _ in range(per_query_pages):
            body = {"textQuery": q, "pageSize": 20,
                    "locationBias": {"circle": {"center": {"latitude": BERGEN[0], "longitude": BERGEN[1]}, "radius": 20000}}}
            if token: body["pageToken"] = token
            r = get("https://places.googleapis.com/v1/places:searchText", budget, json=body, headers={
                "X-Goog-Api-Key": KEY,
                "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types,nextPageToken"})
            d = r.json()
            for p in d.get("places", []):
                if "Bergen" not in p.get("formattedAddress", "") and "Bergen" not in q: continue
                seen.setdefault(p["id"], {
                    "place_id": p["id"], "name": p["displayName"]["text"], "address": p.get("formattedAddress", ""),
                    "lat": p["location"]["latitude"], "lng": p["location"]["longitude"],
                    "types": ",".join(p.get("types", [])[:3]), "query": q})
            token = d.get("nextPageToken")
            if not token: break
    return list(seen.values())


def solar(c, budget):
    r = get("https://solar.googleapis.com/v1/buildingInsights:findClosest", budget, params={
        "location.latitude": c["lat"], "location.longitude": c["lng"], "requiredQuality": "LOW", "key": KEY})
    if r.status_code != 200: return None
    d = r.json()
    bb = d["boundingBox"]; sp = d["solarPotential"]
    return {"building_id": d["name"], "sw": bb["sw"], "ne": bb["ne"],
            "roof_m2": round(sp.get("wholeRoofStats", {}).get("areaMeters2", 0)),
            "imagery": "{year}-{month:02d}".format(**d["imageryDate"]), "quality": d["imageryQuality"]}


def mercator(lat, lng, z):
    s = 256 * 2 ** z
    x = (lng + 180) / 360 * s
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * s
    return x, y


def tile(b, budget, cache):
    sw, ne = b["sw"], b["ne"]
    clat, clng = (sw["latitude"] + ne["latitude"]) / 2, (sw["longitude"] + ne["longitude"]) / 2
    # largest zoom (<=20) where footprint fits in ~560 of the 640 logical px
    for z in range(20, 15, -1):
        x0, y0 = mercator(ne["latitude"], sw["longitude"], z); x1, y1 = mercator(sw["latitude"], ne["longitude"], z)
        if max(x1 - x0, y1 - y0) <= 560: break
    f = cache / (b["building_id"].split("/")[-1] + ".png")
    if not f.exists():
        r = get("https://maps.googleapis.com/maps/api/staticmap", budget, params={
            "center": f"{clat},{clng}", "zoom": z, "size": "640x640", "scale": 2, "maptype": "satellite", "key": KEY})
        if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image"): return None, None
        f.write_bytes(r.content)
    img = Image.open(f).convert("RGB")
    cx, cy = mercator(clat, clng, z)
    box = [(x0 - cx) * 2 + 640, (y0 - cy) * 2 + 640, (x1 - cx) * 2 + 640, (y1 - cy) * 2 + 640]
    return img, [int(round(v)) for v in box]


def score(img, box):
    a = np.asarray(img.crop(box)).astype(np.float32) / 255
    if a.size == 0 or min(a.shape[:2]) < 12: return None
    # shrink 10% to stay on roof, drop the Google attribution strip
    h, w = a.shape[:2]; a = a[int(h * .1):int(h * .9), int(w * .1):int(w * .9)]
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1); v = mx; s = np.where(mx > 0, (mx - mn) / (mx + 1e-6), 0)
    hue = np.zeros_like(v); d = mx - mn + 1e-6
    hue = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    lum = .299 * r + .587 * g + .114 * b
    moss = ((hue > 60) & (hue < 160) & (s > .15) & (v > .12)).mean()
    rust = ((hue > 10) & (hue < 40) & (s > .35) & (v > .2)).mean()
    dark = (lum < np.percentile(lum, 50) * .55).mean()
    # patchiness: std of 8x8 block means, normalised by overall brightness
    bh, bw = lum.shape[0] // 8 * 8, lum.shape[1] // 8 * 8
    blk = lum[:bh, :bw].reshape(bh // 8, 8, bw // 8, 8).mean((1, 3))
    patch = float(blk.std() / (lum.mean() + 1e-6))
    total = 100 * (1.6 * moss + 2.0 * rust + 0.6 * dark) + 40 * patch
    return {"moss": round(float(moss), 3), "rust": round(float(rust), 3), "dark": round(float(dark), 3),
            "patchiness": round(patch, 3), "score": round(float(total), 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out/roofscan")
    ap.add_argument("--budget", type=int, default=1500, help="hard cap on API requests")
    ap.add_argument("--pages", type=int, default=3, help="Places result pages per query (20/page)")
    ap.add_argument("--min-roof", type=int, default=150, help="ignore roofs smaller than this (m2)")
    a = ap.parse_args()
    if not KEY: sys.exit("set GOOGLE_API_KEY (e.g. `set -a; . ~/.secrets/google.env`)")
    out = Path(a.out); cache = out / "tiles"; cache.mkdir(parents=True, exist_ok=True)
    budget = Budget(a.budget)

    cand_f = out / "candidates.json"
    cands = json.loads(cand_f.read_text()) if cand_f.exists() else places(budget, a.pages)
    cand_f.write_text(json.dumps(cands, ensure_ascii=False, indent=1))
    print(f"{len(cands)} candidate places")

    rows, seen_bld = [], set()
    for i, c in enumerate(cands):
        b = c.get("solar") or solar(c, budget); c["solar"] = b
        if not b or b["building_id"] in seen_bld or b["roof_m2"] < a.min_roof: continue
        seen_bld.add(b["building_id"])
        img, box = tile(b, budget, cache)
        if img is None: continue
        sc = score(img, box)
        if not sc: continue
        rows.append({**{k: c[k] for k in ("name", "address", "lat", "lng", "types")},
                     "roof_m2": b["roof_m2"], "imagery": b["imagery"], **sc,
                     "tile": f"tiles/{Path(b['building_id']).name}.png", "box": box,
                     "maps": f"https://www.google.com/maps/@{c['lat']},{c['lng']},80m/data=!3m1!1e3"})
        print(f"[{i+1}/{len(cands)}] {sc['score']:6.1f}  {c['name'][:40]}")
    cand_f.write_text(json.dumps(cands, ensure_ascii=False, indent=1))
    rows.sort(key=lambda r: -r["score"])

    with open(out / "results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[k for k in rows[0] if k not in ("tile", "box")], extrasaction="ignore")
        w.writeheader(); w.writerows(rows)

    # contact sheets of the top roofs (crop + outline) for eyeball review
    crops = []
    for r in rows:
        im = Image.open(out / r["tile"]).convert("RGB"); x0, y0, x1, y1 = r["box"]
        pad = 20; im = im.crop((max(0, x0 - pad), max(0, y0 - pad), min(1280, x1 + pad), min(1280, y1 + pad)))
        im.thumbnail((300, 300)); crops.append(im)
    for p in range(0, min(len(crops), 80), 20):
        sheet = Image.new("RGB", (5 * 310, 4 * 330), "white"); dr = ImageDraw.Draw(sheet)
        for j, im in enumerate(crops[p:p + 20]):
            x, y = (j % 5) * 310 + 5, (j // 5) * 330 + 5
            sheet.paste(im, (x, y)); dr.text((x, y + 302), f"#{p + j + 1} {rows[p + j]['score']} {rows[p + j]['name'][:30]}", fill="black")
        sheet.save(out / f"sheet_{p // 20 + 1}.jpg", quality=85)
    (out / "rows.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    print(f"{len(rows)} roofs scored, {a.budget - budget.left} API requests used")


if __name__ == "__main__":
    main()

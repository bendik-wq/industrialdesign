"""Builds public/geo/: GeoNames cities1000 (places with 1,000+ people, CC BY 4.0, geonames.org) cut into 5-degree
tiles for the territory map. Run: python3 tools/build-geo.py path/to/cities1000.txt
Each tile is a JSON array of [lat*1e4, lng*1e4, population, name, kind] where kind is 'c' for a city or town and
's' for a section of a bigger place (a suburb or district; its people are already in the bigger place's figure)."""
import sys, json, os, math, collections
src = sys.argv[1]
out = os.path.join(os.path.dirname(__file__), "..", "public", "geo")
os.makedirs(out, exist_ok=True)
for f in os.listdir(out):
    if f.endswith(".json"): os.remove(os.path.join(out, f))
SKIP = {"PPLH", "PPLQ", "PPLW", "PPLCH"}  # historical, abandoned, destroyed
tiles = collections.defaultdict(list)
n = 0
for line in open(src, encoding="utf-8"):
    c = line.rstrip("\n").split("\t")
    if len(c) < 15 or c[7] in SKIP: continue
    pop = int(c[14] or 0)
    if pop < 1000: continue
    lat, lng = float(c[4]), float(c[5])
    tiles[(math.floor(lat / 5), math.floor(lng / 5))].append([round(lat * 1e4), round(lng * 1e4), pop, c[1][:60], "s" if c[7] == "PPLX" else "c"])
    n += 1
index = {}
for (a, b), rows in tiles.items():
    rows.sort(key=lambda r: -r[2])
    json.dump(rows, open(os.path.join(out, f"{a}_{b}.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    index[f"{a}_{b}"] = len(rows)
json.dump(index, open(os.path.join(out, "index.json"), "w"), separators=(",", ":"))
open(os.path.join(out, "LICENSE.txt"), "w").write("Population data: GeoNames (geonames.org), cities1000, licensed CC BY 4.0. https://creativecommons.org/licenses/by/4.0/\n")
print(n, "places in", len(tiles), "tiles")

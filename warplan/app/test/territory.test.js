import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { km, plan, preparePlaces, tilesFor, peopleIn, overlap, unionKm2, arms, areaKm2 } from "../public/js/territory.js";

const tiles = (circles) => tilesFor(circles, 100).flatMap((k) => { try { return JSON.parse(readFileSync(new URL(`../public/geo/${k}.json`, import.meta.url))); } catch { return []; } });
const PARRA = { id: 1, name: "Parramatta", lat: -33.815, lng: 151.003, radius_km: 15 };

test("distance and area basics", () => {
  assert.ok(Math.abs(km({ lat: -33.8688, lng: 151.2093 }, { lat: -37.8136, lng: 144.9631 }) - 714) < 5); // Sydney-Melbourne
  assert.ok(Math.abs(unionKm2([PARRA]) - areaKm2(15)) < 1);
  const two = [PARRA, { ...PARRA, id: 2 }];
  assert.ok(Math.abs(unionKm2(two) - areaKm2(15)) / areaKm2(15) < 0.05, "identical circles don't double count");
  assert.equal(overlap(PARRA, [{ ...PARRA, id: 2 }]), 1);
  assert.equal(overlap(PARRA, [{ ...PARRA, lat: 0, lng: 0 }]), 0);
  assert.equal(arms([PARRA, { ...PARRA, id: 2, lat: -33.75, lng: 150.69 }, { ...PARRA, id: 3, lat: -32.93, lng: 151.78 }]).length, 2);
});

test("population estimate is in the right range and suburbs don't double count", () => {
  const places = preparePlaces(tiles([{ lat: -33.8688, lng: 151.2093, radius_km: 40 }]));
  const syd = peopleIn([{ lat: -33.8688, lng: 151.2093, radius_km: 40 }], places);
  assert.ok(syd > 3.5e6 && syd < 7e6, `Greater Sydney within 40 km ≈ 5M, got ${syd}`);
  const outback = peopleIn([{ lat: -25.0, lng: 132.0, radius_km: 20 }], preparePlaces(tiles([{ lat: -25, lng: 132, radius_km: 20 }])));
  assert.ok(outback < 5000, `empty outback, got ${outback}`);
});

test("plan ranks tuck-ins above far-away deals and explains why", () => {
  const sites = [PARRA];
  const targets = [
    { id: 11, name: "Near", stage: "meeting", lat: -33.80, lng: 150.99, ebitda: 500000 },
    { id: 12, name: "Far", stage: "meeting", lat: -32.93, lng: 151.78, ebitda: 500000 },
    { id: 13, name: "Lost one", stage: "lost", lat: -33.81, lng: 151.0 },
    { id: 14, name: "No place", stage: "meeting", lat: null, lng: null },
  ];
  const p = plan({ sites, targets, places: preparePlaces(tiles([...sites, ...targets.filter((t) => t.lat).map((t) => ({ ...t, radius_km: 15 }))])), radiusKm: 15 });
  assert.deepEqual(p.ranked.map((r) => r.name), ["Near", "Far"]);
  assert.equal(p.ranked[0].kind, "tuckin");
  assert.equal(p.ranked[1].kind, "arm");
  assert.match(p.ranked[0].why.join(" "), /Local share of known operators goes from 1\/2 to 2\/2/);
  assert.equal(p.summary.operators, 2);
  assert.ok(p.whitespace.every((w) => w.people >= 5000));
});

test("with no sites, targets still rank (first deal) and nothing crashes", () => {
  const p = plan({ sites: [], targets: [{ id: 1, name: "A", stage: "sourced", lat: -33.8, lng: 151 }], places: [], radiusKm: 25 });
  assert.equal(p.ranked[0].kind, "first");
  assert.equal(p.summary.sites, 0);
  assert.deepEqual(p.whitespace, []);
});

test("territory API: scoped to the workspace, validated, rate-limited geocoding", () => {
  const src = readFileSync(new URL("../src/territory.js", import.meta.url), "utf8");
  for (const q of src.match(/prepare\(`?"?[^]*?\)\.bind/g).filter((s) => /territory_sites|targets/.test(s) && /UPDATE|DELETE|SELECT \*/.test(s))) assert.match(q, /account_id = \?/, q.slice(0, 80));
  assert.match(src, /PLATFORM_MIN = 50/);
  assert.match(src, /Math\.abs\(a\) > 85 \|\| Math\.abs\(b\) > 180/);
  assert.match(src, /hops: 0/);
});

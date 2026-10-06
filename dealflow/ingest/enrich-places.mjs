// Adds website, phone, Google rating and review count (the best public size proxy) for top targets using the
// Google Places API (New) Text Search. Needs GOOGLE_PLACES_API_KEY. Results are cached in data/enrichment.json,
// so re-runs only look up companies not seen before.
//
//   GOOGLE_PLACES_API_KEY=... node ingest/enrich-places.mjs --limit 500 --min-fit 40
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const KEY = process.env.GOOGLE_PLACES_API_KEY;
if (!KEY) {
  console.error("Set GOOGLE_PLACES_API_KEY (Google Cloud → APIs & Services → enable 'Places API (New)').");
  process.exit(1);
}
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const LIMIT = Number(arg("limit", 300));
const MIN_FIT = Number(arg("min-fit", 40));

const { companies } = JSON.parse(readFileSync(join(DATA, "companies.json"), "utf8"));
const cachePath = join(DATA, "enrichment.json");
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

const tokens = (s) => new Set((s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !["INC", "LLC", "AND", "THE", "CO"].includes(t)));
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size);
}

async function lookup(c) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.businessStatus,places.primaryType",
    },
    body: JSON.stringify({ textQuery: `${c.legalName || c.name} ${c.city || c.county + " County"} Texas`, maxResultCount: 5 }),
  });
  if (!res.ok) throw new Error(`Places HTTP ${res.status}: ${await res.text()}`);
  const { places = [] } = await res.json();
  const best = places
    .map((p) => ({ p, score: Math.max(similarity(c.name, p.displayName?.text), similarity(c.legalName, p.displayName?.text)) }))
    .sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 0.6) return { matched: false, checked: new Date().toISOString() };
  const p = best.p;
  return {
    matched: true,
    checked: new Date().toISOString(),
    placeId: p.id,
    placeName: p.displayName?.text,
    address: p.formattedAddress,
    phone: p.nationalPhoneNumber || null,
    website: p.websiteUri || null,
    rating: p.rating ?? null,
    reviews: p.userRatingCount ?? 0,
    businessStatus: p.businessStatus || null,
    matchScore: Number(best.score.toFixed(2)),
  };
}

const queue = companies.filter((c) => !c.nonTarget && c.fitScore >= MIN_FIT && !cache[c.key]?.places).slice(0, LIMIT);
console.log(`looking up ${queue.length} companies (fit ≥ ${MIN_FIT})`);
let done = 0, matched = 0;
for (const c of queue) {
  try {
    const places = await lookup(c);
    cache[c.key] = { ...cache[c.key], places };
    if (places.matched) matched++;
  } catch (err) {
    console.error(`  ${c.name}: ${err.message}`);
    if (/HTTP (401|403|429)/.test(err.message)) break;
  }
  if (++done % 25 === 0) { writeFileSync(cachePath, JSON.stringify(cache)); console.log(`  ${done}/${queue.length}, matched ${matched}`); }
  await new Promise((r) => setTimeout(r, 120)); // stay well under QPS limits
}
writeFileSync(cachePath, JSON.stringify(cache));
console.log(`done: ${done} looked up, ${matched} matched. Re-run ingest/build.mjs to apply.`);

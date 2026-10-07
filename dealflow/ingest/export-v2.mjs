// Converts the Texas TDLR build (data/companies.json from build.mjs) into the v2 multi-country schema as a
// ready-made search, written to data/seed-tx.sql. Load with:
//   npx wrangler d1 execute dealflow --remote --file ../data/seed-tx.sql   (from app/)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toRow } from "../app/src/store.js";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const { companies } = JSON.parse(readFileSync(join(DATA, "companies.json"), "utf8"));
const KEEP_SIZE = /licensed contractors|locations|Class A|Environmental|Corporation|LLC|LP|Partnership|reviews|trucks/;
const KEEP_SUCC = /License lapsed|Family successor|Website/;

const rows = companies.map((c) => toRow({
  source: "us_tx_tdlr",
  sourceId: c.key,
  country: "us",
  name: c.name,
  legalForm: c.entityLabel !== "Unknown" ? c.entityLabel : null,
  industryCode: "TDLR A/C contractor",
  address: [c.street, c.city, c.zip && `TX ${c.zip}`].filter(Boolean).join(", ") || null,
  city: c.city || `${c.county} County`,
  region: "TX",
  postcode: c.zip || null,
  founded: c.businessSince,
  licensedSince: c.licensedSince,
  establishments: c.outlets || null,
  currency: "USD",
  website: c.website, phone: c.phone, email: c.email, rating: c.rating, reviews: c.reviews,
  people: c.licensees.map((l) => ({ name: l.owner, role: `Licensed A/C contractor #${l.number}${l.active ? "" : " (lapsed)"}` })),
  extraSize: c.signals.filter((s) => s.type === "size" && KEEP_SIZE.test(s.label)),
  extraSuccession: c.signals.filter((s) => s.type === "succession" && KEEP_SUCC.test(s.label)),
  registryUrl: "https://www.tdlr.texas.gov/LicenseSearch/",
  excluded: c.nonTarget,
}));

const sq = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const cols = Object.keys(rows[0]);
const now = new Date().toISOString();
const out = [
  `DELETE FROM search_results WHERE search_id IN (SELECT id FROM searches WHERE label = 'HVAC / heating & cooling · Texas (state license data)');`,
  `DELETE FROM searches WHERE label = 'HVAC / heating & cooling · Texas (state license data)';`,
];
for (let i = 0; i < rows.length; i += 25) {
  out.push(`INSERT INTO companies (${cols.join(",")}) VALUES\n${rows.slice(i, i + 25).map((r) => `(${cols.map((k) => sq(r[k])).join(",")})`).join(",\n")}\nON CONFLICT (source, source_id) DO UPDATE SET ${cols.filter((k) => !["source", "source_id"].includes(k)).map((k) => `${k} = excluded.${k}`).join(", ")};`);
}
out.push(`INSERT INTO searches (country, industry, region, region_label, min_staff, label, status, total, found, pages, pages_done, created_at, finished_at)
  VALUES ('us', 'hvac', 'TX', 'Texas (state license data)', 0, 'HVAC / heating & cooling · Texas (state license data)', 'done', ${rows.length}, ${rows.length}, 1, 1, '${now}', '${now}');`);
out.push(`INSERT OR IGNORE INTO search_results (search_id, company_id) SELECT (SELECT MAX(id) FROM searches), id FROM companies WHERE source = 'us_tx_tdlr';`);
writeFileSync(join(DATA, "seed-tx.sql"), out.join("\n") + "\n");
console.log(`wrote seed-tx.sql: ${rows.length} companies; verdicts:`,
  Object.entries(rows.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {})).map((e) => e.join(" ")).join(", "));

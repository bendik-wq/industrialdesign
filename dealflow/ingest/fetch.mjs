// Downloads the public Texas source files into data/raw. Re-run to refresh (sources update daily/weekly).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAW = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "raw");
mkdirSync(RAW, { recursive: true });

const SOCRATA = "https://data.texas.gov/resource";
const HVAC_NAME_TERMS = ["AIR", "HVAC", "HEATING", "COOLING", "MECHANICAL", "REFRIGERAT", "COMFORT", "A/C", "CLIMATE", "TEMP", "PLUMB"];

const SOURCES = [
  {
    // TDLR Air Conditioning & Refrigeration contractor licenses (all statuses, incl. recently expired).
    file: "ltairref.csv",
    url: "https://www.tdlr.texas.gov/dbproduction2/ltairref.csv",
  },
  {
    // Comptroller: active sales tax permit outlets, NAICS 238220 (plumbing, heating & AC contractors).
    file: "salestax_238220.json",
    url: socrata("jrea-zgmq", `outlet_naics_code="238220"`),
  },
  {
    // Comptroller: active franchise taxpayers (LLCs/corps) that are HVAC by NAICS or by name.
    file: "franchise_hvac.json",
    url: socrata("9cir-efmm", [
      `starts_with(_621111,"2382")`,
      ...HVAC_NAME_TERMS.map((t) => `taxpayer_name like "%${t}%"`),
      `taxpayer_name like "% AC %"`,
      `taxpayer_name like "% AC"`,
    ].join(" OR ")),
  },
];

function socrata(id, where) {
  const u = new URL(`${SOCRATA}/${id}.json`);
  u.searchParams.set("$where", where);
  u.searchParams.set("$limit", "500000");
  return u.toString();
}

for (const s of SOURCES) {
  process.stdout.write(`fetching ${s.file} … `);
  const res = await fetch(s.url);
  if (!res.ok) throw new Error(`${s.file}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(RAW, s.file), body);
  console.log(`${(body.length / 1e6).toFixed(1)} MB`);
}

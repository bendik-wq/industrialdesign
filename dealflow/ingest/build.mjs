// Joins TDLR HVAC contractor licenses with Comptroller franchise + sales tax records, groups them into
// companies, derives size and succession signals, scores every company and writes:
//   data/companies.json   full records (used by enrichers and exports)
//   data/seed.sql         D1 seed for the dashboard Worker
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const RAW = join(DATA, "raw");
const TODAY = new Date();
const YEAR = TODAY.getFullYear() + TODAY.getMonth() / 12;

// ---------- helpers ----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  const h = head.map((s) => s.replace(/^﻿/, "").trim());
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const SUFFIXES = new Set(["INC", "INCORPORATED", "LLC", "L", "C", "CO", "CORP", "CORPORATION", "COMPANY", "LTD", "LIMITED", "LP", "LLP", "PLLC", "PC", "THE", "OF", "TX", "TEXAS", "SERVICE", "SERVICES", "SVC", "SVCS"]);
function normName(s) {
  if (!s) return "";
  return s.toUpperCase()
    .replace(/A\/C/g, " AC ")
    .replace(/AIR[\s-]*CONDITIONING/g, " AC ")
    .replace(/HEATING\s*(&|AND)\s*AIR/g, " HEATING AC ")
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !SUFFIXES.has(t))
    .join(" ");
}
// "ACME AC INC DBA COOL GUYS" -> ["ACME AC", "COOL GUYS"]
function nameAliases(s) {
  if (!s) return [];
  const names = s.toUpperCase().split(/\b(?:D\/?B\/?A|A\/K\/A|AKA)\b/).map(normName).filter((n) => n.length >= 3);
  return [...new Set([...names, ...names.map((n) => n.replace(/ /g, ""))])]; // "TD INDUSTRIES" == "TDINDUSTRIES"
}
const isPersonName = (s) => /^[A-Z' .-]+,\s*[A-Z]/.test(s || ""); // "SMITH, JOHN A"
const surname = (person) => (person || "").split(",")[0].trim();
const titleCase = (s) => (s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Llc|Inc|Lp|Ltd|Ac|Hvac|Dba|Ii|Iii|Iv|Pllc)\b/g, (m) => m.toUpperCase());
const personDisplay = (p) => {
  const [last, first = ""] = (p || "").split(",");
  const parts = first.trim().split(/\s+/);
  const sfx = parts.length > 1 && /^(JR|SR|II|III|IV)$/.test(parts.at(-1)) ? ` ${parts.pop()}` : "";
  return titleCase(`${parts.join(" ")} ${last.trim()}${sfx}`.trim());
};
const year = (iso) => (iso ? Number(iso.slice(0, 4)) : null);
function parseMDY(s) { const m = (s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null; }

const NON_TARGET = /\b(ISD|SCHOOL|COLLEGE|UNIVERSITY|CITY OF|COUNTY OF|COUNTY|HOSPITAL|MEDICAL CENTER|HEALTH|CARRIER|TRANE|JOHNSON CONTROLS|LENNOX|DAIKIN|GOODMAN|SEARS|HOME DEPOT|LOWE'?S|WALMART|APARTMENT|APARTMENTS|PROPERTIES|PROPERTY|REALTY|MANAGEMENT|HOTEL|RESORT|CHURCH|AUTHORITY|DISTRICT|STATE OF|DEPARTMENT|UNITED STATES|AIRLINES|AIRPORT|HOMES|BUILDERS|CONSTRUCTION|ELECTRIC COOP|COOPERATIVE|CINEMARK|ENERGY|DEFENSE|MARRIOTT|HILTON|SIEMENS|EMCOR|COMFORT SYSTEMS USA|SERVICE EXPERTS|ONE HOUR|ARS |AMERICAN RESIDENTIAL SERVICES|ABM |CBRE|JONES LANG|AMAZON|TEXAS A ?& ?M|INSTITUTE)\b/;

// Words that don't identify a company on their own ("A-1 Air Conditioning" exists in dozens of counties).
const GENERIC = new Set(["AC", "AIR", "HEATING", "COOLING", "MECHANICAL", "REFRIGERATION", "PLUMBING", "AND", "COMFORT", "SYSTEMS", "SYSTEM", "TEXAS", "CONDITIONING", "HVAC", "PRO", "PROS", "QUALITY", "BEST", "AMERICAN", "ALL", "STAR", "TOTAL", "CLIMATE", "CONTROL", "ENERGY", "HOME", "SOLUTIONS", "CONTRACTORS", "COMMERCIAL", "RESIDENTIAL", "ELECTRIC", "ELECTRICAL", "SALES", "REPAIR", "EXPERTS", "MASTER", "MASTERS", "PREMIER", "SUPERIOR", "PRECISION", "RELIABLE", "AFFORDABLE", "LONE", "NORTH", "SOUTH", "EAST", "WEST", "CENTRAL", "CITY", "COUNTY", "METRO"]);
const distinctive = (name) => name.split(" ").some((t) => t.length >= 4 && !GENERIC.has(t) && !/^\d+$/.test(t));

const METROS = {
  Houston: ["HARRIS", "FORT BEND", "MONTGOMERY", "BRAZORIA", "GALVESTON", "LIBERTY", "WALLER", "CHAMBERS", "AUSTIN"],
  "Dallas–Fort Worth": ["DALLAS", "TARRANT", "COLLIN", "DENTON", "ROCKWALL", "KAUFMAN", "ELLIS", "JOHNSON", "PARKER", "WISE", "HUNT", "HOOD", "SOMERVELL"],
  "San Antonio": ["BEXAR", "COMAL", "GUADALUPE", "MEDINA", "WILSON", "ATASCOSA", "BANDERA", "KENDALL"],
  Austin: ["TRAVIS", "WILLIAMSON", "HAYS", "BASTROP", "CALDWELL"],
  "Rio Grande Valley": ["HIDALGO", "CAMERON", "STARR", "WILLACY"],
  "El Paso": ["EL PASO"],
  "Corpus Christi": ["NUECES", "SAN PATRICIO"],
  "Killeen–Temple–Waco": ["BELL", "CORYELL", "MCLENNAN", "LAMPASAS"],
  "Beaumont–Port Arthur": ["JEFFERSON", "ORANGE", "HARDIN"],
  "Lubbock": ["LUBBOCK"],
  "Midland–Odessa": ["MIDLAND", "ECTOR"],
  "Amarillo": ["POTTER", "RANDALL"],
  "Tyler–Longview": ["SMITH", "GREGG", "HARRISON", "UPSHUR", "RUSK"],
  "Bryan–College Station": ["BRAZOS", "BURLESON", "ROBERTSON"],
  "Laredo": ["WEBB"],
};
const COUNTY_METRO = Object.fromEntries(Object.entries(METROS).flatMap(([m, cs]) => cs.map((c) => [c, m])));

// ---------- load sources ----------
const licenses = parseCsv(readFileSync(join(RAW, "ltairref.csv"), "utf8"));
const salesTax = JSON.parse(readFileSync(join(RAW, "salestax_238220.json"), "utf8"));
// Optional enrichment from ingest/enrich-places.mjs and ingest/enrich-web.mjs, keyed by company key.
const enrichPath = join(DATA, "enrichment.json");
const enrichment = existsSync(enrichPath) ? JSON.parse(readFileSync(enrichPath, "utf8")) : {};
const franchise = JSON.parse(readFileSync(join(RAW, "franchise_hvac.json"), "utf8"));
console.log(`licenses ${licenses.length}, sales-tax outlets ${salesTax.length}, franchise taxpayers ${franchise.length}`);

// Comptroller county code = (FIPS + 1) / 2 ; TDLR gives FIPS ("0201" = Harris).
const fipsToComptroller = (fips) => (fips ? String((parseInt(fips, 10) + 1) / 2) : "");
const comptrollerCountyName = new Map(
  licenses.filter((r) => r["BUSINESS COUNTY CODE"] && r["BUSINESS COUNTY"]).map((r) => [fipsToComptroller(r["BUSINESS COUNTY CODE"]), r["BUSINESS COUNTY"].toUpperCase()])
);

// ---------- group licenses into companies ----------
const companies = new Map();
for (const r of licenses) {
  const exp = parseMDY(r["LICENSE EXPIRATION DATE"]);
  const monthsLapsed = exp ? (TODAY - exp) / (30.44 * 864e5) : 999;
  if (monthsLapsed > 18) continue; // drop long-dead licenses; keep recently lapsed as a signal
  const owner = r["NAME"];
  const biz = r["BUSINESS NAME"];
  const county = (r["BUSINESS COUNTY"] || r["COUNTY"] || "").toUpperCase();
  const sole = !biz || biz === owner || isPersonName(biz);
  const displayBiz = sole ? (biz && !isPersonName(biz) ? biz : `${owner}`) : biz;
  // Group per county first: "Davis Air Conditioning" in Harris and in Brazoria are usually different shops.
  // Groups are merged across counties later only when they match the same Comptroller taxpayer.
  const key = sole ? `P:${normName(owner)}|${county}` : `B:${normName(biz)}|${county}`;
  if (!companies.has(key)) {
    companies.set(key, { key, name: displayBiz, sole, county, countyCode: fipsToComptroller(r["BUSINESS COUNTY CODE"]), licensees: [], counties: new Set() });
  }
  const c = companies.get(key);
  c.counties.add(county);
  c.licensees.push({
    owner,
    number: parseInt(r["LICENSE NUMBER"], 10),
    subtype: r["LICENSE SUBTYPE"],
    expires: exp?.toISOString().slice(0, 10),
    active: monthsLapsed <= 0,
  });
}
console.log(`companies (raw) ${companies.size}`);

// ---------- index Comptroller records by normalized name ----------
function indexBy(rows, names) {
  const idx = new Map();
  for (const row of rows) for (const n of names(row)) {
    if (!idx.has(n)) idx.set(n, []);
    idx.get(n).push(row);
  }
  return idx;
}
const ftIdx = indexBy(franchise, (r) => nameAliases(r.taxpayer_name));
const stIdx = indexBy(salesTax, (r) => [...new Set([...nameAliases(r.taxpayer_name), ...nameAliases(r.outlet_name)])]);

function pick(cands, c, countyField, alias) {
  if (!cands?.length) return null;
  const sameCounty = cands.filter((x) => x[countyField] === c.countyCode);
  if (sameCounty.length) return sameCounty[0];
  // Out-of-county match only for a unique, distinctive name.
  return cands.length === 1 && distinctive(alias) ? cands[0] : null;
}

// ---------- match each county group to Comptroller records ----------
for (const c of companies.values()) {
  c.ft = null;
  c.outlets = [];
  c.taxId = null; // taxpayer number, only when matched inside the same county (safe to merge on)
  for (const a of c.sole ? [] : nameAliases(c.name)) {
    if (!c.ft) {
      c.ft = pick(ftIdx.get(a), c, "taxpayer_county_code", a);
      if (c.ft?.taxpayer_county_code === c.countyCode) c.taxId ||= c.ft.taxpayer_number;
    }
    const st = stIdx.get(a);
    if (st && !c.outlets.length) {
      const tp = pick(st, c, "taxpayer_county_code", a) || pick(st, c, "outlet_county_code", a);
      if (tp) {
        c.outlets = salesTax.filter((o) => o.taxpayer_number === tp.taxpayer_number);
        if ([tp.taxpayer_county_code, tp.outlet_county_code].includes(c.countyCode)) c.taxId ||= tp.taxpayer_number;
      }
    }
  }
  // Sole proprietors: try matching sales tax by owner's personal name (IS = individual sole owner).
  if (c.sole) {
    const p = c.licensees[0].owner.split(",");
    const asTaxpayer = normName(`${(p[1] || "").trim()} ${p[0]}`);
    const st = (stIdx.get(asTaxpayer) || []).filter((o) => o.taxpayer_county_code === c.countyCode);
    if (st.length) c.outlets = salesTax.filter((o) => o.taxpayer_number === st[0].taxpayer_number);
  }
}

// ---------- merge county groups that are the same legal entity ----------
const byTaxId = new Map();
for (const c of [...companies.values()].sort((a, b) => b.licensees.length - a.licensees.length)) {
  if (!c.taxId) continue;
  const primary = byTaxId.get(c.taxId);
  if (!primary) { byTaxId.set(c.taxId, c); continue; }
  primary.licensees.push(...c.licensees);
  for (const k of c.counties) primary.counties.add(k);
  primary.ft ||= c.ft;
  if (!primary.outlets.length) primary.outlets = c.outlets;
  companies.delete(c.key);
}
console.log(`companies (after entity merge) ${companies.size}`);

// ---------- derive per-company facts ----------
const out = [];
for (const c of companies.values()) {
  const { ft, outlets } = c;
  c.licensees.sort((a, b) => a.number - b.number);
  const lead = c.licensees[0];
  const firstSale = outlets.map((o) => o.outlet_first_sales_date).filter(Boolean).sort()[0];
  const charter = ft?.sos_charter_date || ft?.responsibility_beginning_date;
  const addrSrc = outlets[0]
    ? { street: outlets[0].outlet_address, city: outlets[0].outlet_city, zip: outlets[0].outlet_zip_code }
    : ft && !/^P\.?\s*O\.?\s*BOX/i.test(ft.taxpayer_address || "")
      ? { street: ft.taxpayer_address, city: ft.taxpayer_city, zip: ft.taxpayer_zip }
      : ft ? { street: ft.taxpayer_address, city: ft.taxpayer_city, zip: ft.taxpayer_zip } : {};

  const addrCode = outlets[0]?.outlet_county_code || ft?.taxpayer_county_code;
  const addrCounty = (addrSrc.street && comptrollerCountyName.get(addrCode)) || c.county;
  out.push({
    key: c.key,
    name: titleCase(c.sole && isPersonName(c.name) ? personDisplay(c.name) : c.name),
    legalName: ft?.taxpayer_name || outlets[0]?.taxpayer_name || null,
    owner: personDisplay(lead.owner),
    ownerRaw: lead.owner,
    sole: c.sole,
    county: titleCase(addrCounty),
    metro: COUNTY_METRO[addrCounty] || (addrCounty === "OUT OF STATE" ? "Out of state" : "Other Texas"),
    street: titleCase(addrSrc.street || ""),
    city: titleCase(addrSrc.city || ""),
    zip: addrSrc.zip || "",
    entityType: ft?.taxpayer_organizational_type || outlets[0]?.taxpayer_organization_type || (c.sole ? "IS" : null),
    sosStatus: ft?.sos_status_code || null,
    charterYear: year(charter),
    firstSaleYear: year(firstSale),
    outlets: outlets.length,
    licensees: c.licensees.map((l) => ({ ...l, owner: personDisplay(l.owner), surname: surname(l.owner) })),
    licenseCount: c.licensees.length,
    activeLicenses: c.licensees.filter((l) => l.active).length,
    oldestLicense: lead.number,
    classA: c.licensees.some((l) => /A[ER]/.test(l.subtype)),
    endorsements: [...new Set(c.licensees.flatMap((l) => (l.subtype.match(/[AB]([ER])/g) || []).map((m) => m[1])))],
    nonTarget: NON_TARGET.test(` ${c.name.toUpperCase()} `) || c.county === "OUT OF STATE",
  });
}

// ---------- calibrate license number -> approximate first-licensed year ----------
// Owners are usually licensed before (or when) they form the business, so the 10th percentile of business start
// year (earliest of charter / first sale) per license-number bucket is a rough, conservative estimate of when that
// license was issued. Texas ACR licensing began in 1983, which floors the estimate.
const LICENSING_BEGAN = 1983;
const pairs = out
  .filter((c) => c.charterYear || c.firstSaleYear)
  .map((c) => [c.oldestLicense, Math.min(...[c.charterYear, c.firstSaleYear].filter(Boolean))])
  .sort((a, b) => a[0] - b[0]);
const BUCKETS = 20;
const knots = [];
for (let b = 0; b < BUCKETS; b++) {
  const slice = pairs.slice(Math.floor((b * pairs.length) / BUCKETS), Math.floor(((b + 1) * pairs.length) / BUCKETS));
  if (!slice.length) continue;
  const yrs = slice.map((p) => p[1]).sort((x, y) => x - y);
  knots.push([slice[Math.floor(slice.length / 2)][0], Math.max(LICENSING_BEGAN, yrs[Math.floor(yrs.length * 0.1)])]);
}
knots.unshift([0, LICENSING_BEGAN]);
for (let i = 1; i < knots.length; i++) knots[i][1] = Math.max(knots[i][1], knots[i - 1][1]); // monotone
const maxLicense = Math.max(...out.map((c) => c.oldestLicense));
knots.push([maxLicense, Math.floor(YEAR)]);
function licenseYear(n) {
  if (n <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
    if (n <= x1) return Math.round(y0 + ((n - x0) / Math.max(1, x1 - x0)) * (y1 - y0));
  }
  return Math.floor(YEAR);
}
console.log("license→year knots:", knots.map(([n, y]) => `${n}:${y}`).join(" "));

// ---------- signals & scores ----------
const ENTITY = { CL: "LLC", CT: "Corporation", CF: "Foreign corp", CI: "Foreign LLC", PL: "LP", PI: "Foreign LP", PB: "Partnership", PV: "Partnership", IS: "Sole proprietor" };
for (const c of out) {
  const signals = [];
  const add = (type, label, pts, detail) => signals.push({ type, label, pts, detail });

  c.licensedSince = licenseYear(c.oldestLicense);
  const licenseAge = Math.floor(YEAR - c.licensedSince);
  const places = enrichment[c.key]?.places?.matched ? enrichment[c.key].places : null;
  const web = enrichment[c.key]?.web && !enrichment[c.key].web.error ? enrichment[c.key].web : null;
  c.website = places?.website || null;
  c.phone = places?.phone || null;
  c.rating = places?.rating ?? null;
  c.reviews = places?.reviews ?? null;
  c.email = web?.emails?.[0] || null;
  if (places?.businessStatus === "CLOSED_PERMANENTLY") { c.nonTarget = true; add("flag", "Closed on Google", 0, "Google lists this business as permanently closed"); }
  const bizStart = Math.min(...[c.charterYear, c.firstSaleYear, web?.foundedYear].filter(Boolean)) || null;
  if (web?.foundedYear && web.foundedYear === bizStart) add("flag", `Website: founded ${web.foundedYear}`, 0, "Founding year claimed on company website");
  c.businessSince = Number.isFinite(bizStart) ? bizStart : null;
  const bizAge = c.businessSince ? Math.floor(YEAR - c.businessSince) : null;
  c.entityLabel = ENTITY[c.entityType] || (c.sole ? "Sole proprietor" : "Unknown");

  // --- succession (likelihood the owner is ready to sell in the next 1–5 years) ---
  let s = 0;
  if (licenseAge >= 35) { s += 40; add("succession", `Licensed ~${licenseAge} yrs`, 40, `Lead license #${c.oldestLicense} ≈ ${c.licensedSince}; owner likely 60+`); }
  else if (licenseAge >= 25) { s += 30; add("succession", `Licensed ~${licenseAge} yrs`, 30, `Lead license #${c.oldestLicense} ≈ ${c.licensedSince}; owner likely 50s–60s`); }
  else if (licenseAge >= 15) { s += 12; add("succession", `Licensed ~${licenseAge} yrs`, 12, `Lead license #${c.oldestLicense} ≈ ${c.licensedSince}`); }
  if (bizAge >= 30) { s += 20; add("succession", `In business since ${c.businessSince}`, 20, "30+ years operating"); }
  else if (bizAge >= 20) { s += 12; add("succession", `In business since ${c.businessSince}`, 12, "20+ years operating"); }
  const leadSurname = c.licensees[0].surname;
  if (!c.sole && leadSurname.length > 2 && c.name.toUpperCase().includes(leadSurname)) { s += 10; add("succession", "Owner-named business", 10, `"${leadSurname}" in company name: owner-dependent brand`); }
  if (c.licenseCount === 1) { s += 10; add("succession", "Single licensed owner", 10, "Key-person dependency; no second license holder"); }
  if (c.activeLicenses === 0) { s += 15; add("succession", "License lapsed", 15, `Not renewed (expired ${c.licensees.map((l) => l.expires).sort().at(-1)}); possible wind-down`); }
  const successor = c.licensees.slice(1).find((l) => l.surname === leadSurname && l.number - c.oldestLicense > 15000);
  if (successor) { s -= 15; add("succession", "Family successor licensed", -15, `${successor.owner} holds a newer license; next generation may take over`); }
  if (web?.copyrightYear && web.copyrightYear <= YEAR - 4) { s += 8; add("succession", `Website untouched since ${web.copyrightYear}`, 8, "Stale site: owner not investing in growth"); }
  if (web?.mentionsRetirement) { s += 10; add("succession", "Website mentions retirement", 10, "Check context: owner retiring or a retirement-community service area"); }
  if (web?.multiGeneration) { s -= 10; add("succession", "Multi-generation family business", -10, "Succession may already be planned inside the family"); }
  if (c.sosStatus && c.sosStatus !== "A") { add("flag", "SOS status not active", 0, `Secretary of State status code ${c.sosStatus}`); }
  c.successionScore = Math.max(0, Math.min(100, s));

  // --- size (bigger = more acquirable cash flow) ---
  let z = 0;
  if (c.licenseCount >= 5) { z += 50; add("size", `${c.licenseCount} licensed contractors`, 50, "Multiple license holders: larger crew"); }
  else if (c.licenseCount >= 3) { z += 38; add("size", `${c.licenseCount} licensed contractors`, 38, "Multiple license holders"); }
  else if (c.licenseCount === 2) { z += 22; add("size", "2 licensed contractors", 22, "Second license holder on staff"); }
  if (c.outlets >= 2) { z += 18; add("size", `${c.outlets} locations`, 18, "Multiple sales tax outlets"); }
  if (c.classA) { z += 14; add("size", "Class A license", 14, "Unlimited tonnage: commercial-capable"); }
  if (c.endorsements.length >= 2) { z += 8; add("size", "Environmental + refrigeration", 8, "Both endorsements: broader service mix"); }
  if (["CT", "CF"].includes(c.entityType)) { z += 10; add("size", "Corporation", 10, "Incorporated entity"); }
  else if (["CL", "CI", "PL", "PI", "PB", "PV"].includes(c.entityType)) { z += 6; add("size", c.entityLabel, 6, "Registered entity"); }
  if (bizAge >= 15) { z += 8; add("size", "Established 15+ yrs", 8, "Durable customer base"); }
  if (c.reviews >= 300) { z += 20; add("size", `${c.reviews} Google reviews`, 20, `Rated ${c.rating}: high customer volume`); }
  else if (c.reviews >= 100) { z += 14; add("size", `${c.reviews} Google reviews`, 14, `Rated ${c.rating}`); }
  else if (c.reviews >= 30) { z += 6; add("size", `${c.reviews} Google reviews`, 6, `Rated ${c.rating}`); }
  const crew = Math.max(web?.trucks || 0, web?.technicians || 0);
  if (crew >= 15) { z += 15; add("size", `${crew}+ trucks/techs (website)`, 15, "Crew size stated on website"); }
  else if (crew >= 5) { z += 8; add("size", `${crew} trucks/techs (website)`, 8, "Crew size stated on website"); }
  c.sizeScore = Math.min(100, z);
  c.sizeTier = c.sizeScore >= 60 ? "Large" : c.sizeScore >= 38 ? "Mid" : c.sizeScore >= 20 ? "Small" : "Micro";

  c.fitScore = c.nonTarget ? 0 : Math.round(0.55 * c.successionScore + 0.45 * c.sizeScore);
  c.signals = signals;
}

out.sort((a, b) => b.fitScore - a.fitScore || b.sizeScore - a.sizeScore);
out.forEach((c, i) => (c.id = i + 1));

// ---------- write outputs ----------
writeFileSync(join(DATA, "companies.json"), JSON.stringify({ generated: TODAY.toISOString(), calibration: knots, companies: out }));

const sq = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "1" : "0") : `'${String(v).replace(/'/g, "''")}'`);
const COLS = ["id", "key", "name", "legal_name", "owner", "sole", "county", "metro", "street", "city", "zip", "entity", "licensed_since", "business_since", "license_count", "active_licenses", "outlets", "class_a", "size_score", "size_tier", "succession_score", "fit_score", "non_target", "website", "phone", "email", "rating", "reviews", "signals", "licensees"];
const lines = ["DELETE FROM companies;"];
for (let i = 0; i < out.length; i += 25) { // D1 caps statements at 100 KB
  const vals = out.slice(i, i + 25).map((c) => `(${[
    c.id, c.key, c.name, c.legalName, c.owner, c.sole, c.county, c.metro, c.street, c.city, c.zip, c.entityLabel,
    c.licensedSince, c.businessSince, c.licenseCount, c.activeLicenses, c.outlets, c.classA,
    c.sizeScore, c.sizeTier, c.successionScore, c.fitScore, c.nonTarget, c.website, c.phone, c.email, c.rating, c.reviews,
    JSON.stringify(c.signals), JSON.stringify(c.licensees.map(({ owner, number, subtype, expires, active }) => ({ owner, number, subtype, expires, active }))),
  ].map(sq).join(",")})`);
  lines.push(`INSERT INTO companies (${COLS.join(",")}) VALUES\n${vals.join(",\n")};`);
}
writeFileSync(join(DATA, "seed.sql"), lines.join("\n") + "\n");

// ---------- summary ----------
const targets = out.filter((c) => !c.nonTarget);
const pct = (n) => `${((100 * n) / targets.length).toFixed(0)}%`;
console.log(`companies ${out.length} (targets ${targets.length}, excluded ${out.length - targets.length})`);
console.log(`matched to Comptroller: ${pct(targets.filter((c) => c.legalName || c.outlets).length)}; with address ${pct(targets.filter((c) => c.street).length)}`);
console.log("size tiers:", Object.entries(targets.reduce((m, c) => ((m[c.sizeTier] = (m[c.sizeTier] || 0) + 1), m), {})).map((e) => e.join(" ")).join(", "));
console.log(`succession ≥ 50: ${targets.filter((c) => c.successionScore >= 50).length}; both ≥ 50/38: ${targets.filter((c) => c.successionScore >= 50 && c.sizeScore >= 38).length}`);
console.log("top 10:");
for (const c of out.slice(0, 10)) console.log(`  ${c.fitScore} | ${c.name} | ${c.owner} | ${c.city || c.county} | since ${c.licensedSince} | lic ${c.licenseCount} | ${c.sizeTier} | S${c.successionScore}`);

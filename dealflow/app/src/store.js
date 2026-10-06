// D1 persistence. Rows go in as one JSON parameter expanded with json_each, which keeps every page to a
// single statement (D1 allows at most 100 bound parameters per query).
import { score } from "./scoring.js";
import { valuation } from "../public/deal.js";

const COLS = [
  "source", "source_id", "country", "name", "legal_form", "industry_code", "address", "city", "region", "postcode", "lat", "lng",
  "founded", "employees_min", "employees_band", "establishments", "revenue", "revenue_year", "currency", "owner_name", "owner_age",
  "people", "website", "phone", "email", "rating", "reviews", "registry_url", "size_score", "succession_score", "fit_score",
  "verdict", "summary", "signals", "excluded", "updated_at",
  "industry", "fin_year", "ebit", "net_income", "payroll", "cash", "equity", "long_term_debt", "valuation_mid",
];

export function toRow(c) {
  const s = score(c);
  const fin = {
    industry: c.industry ?? null, fin_year: c.finYear ?? null, ebit: c.ebit ?? null, net_income: c.netIncome ?? null,
    payroll: c.payroll ?? null, cash: c.cash ?? null, equity: c.equity ?? null, long_term_debt: c.longTermDebt ?? null,
    revenue: c.revenue ?? null,
  };
  const v = valuation(fin);
  return {
    ...fin,
    valuation_mid: v ? Math.round(v.equity[1]) : null,
    source: c.source, source_id: String(c.sourceId), country: c.country, name: c.name || "(unnamed)",
    legal_form: c.legalForm ?? null, industry_code: c.industryCode ?? null, address: c.address ?? null, city: c.city ?? null,
    region: c.region ?? null, postcode: c.postcode ?? null, lat: c.lat ?? null, lng: c.lng ?? null, founded: c.founded ?? null,
    employees_min: c.employeesMin ?? c.employees ?? null, employees_band: c.employeesBand ?? null, establishments: c.establishments ?? null,
    revenue: c.revenue ?? null, revenue_year: c.revenueYear ?? null, currency: c.currency ?? null,
    owner_name: s.ownerName, owner_age: s.ownerAge, people: JSON.stringify(c.people || []),
    website: c.website ?? null, phone: c.phone ?? null, email: c.email ?? null, rating: c.rating ?? null, reviews: c.reviews ?? null,
    registry_url: c.registryUrl ?? null, size_score: s.sizeScore, succession_score: s.successionScore, fit_score: s.fitScore,
    verdict: s.verdict, summary: s.summary, signals: JSON.stringify(s.signals), excluded: c.excluded ? 1 : 0,
    updated_at: new Date().toISOString(),
  };
}

export async function saveCompanies(db, searchId, companies, industry) {
  const rows = companies.filter(Boolean).map((c) => toRow({ industry, ...c }));
  if (!rows.length) return 0;
  const json = JSON.stringify(rows);
  const updates = COLS.filter((c) => !["source", "source_id"].includes(c)).map((c) => `${c} = excluded.${c}`).join(", ");
  await db.batch([
    db.prepare(
      `INSERT INTO companies (${COLS.join(", ")})
       SELECT ${COLS.map((c) => `json_extract(value, '$.${c}')`).join(", ")} FROM json_each(?1) WHERE true
       ON CONFLICT (source, source_id) DO UPDATE SET ${updates}`
    ).bind(json),
    db.prepare(
      `INSERT OR IGNORE INTO search_results (search_id, company_id)
       SELECT ?1, c.id FROM companies c JOIN json_each(?2) j
         ON c.source = json_extract(j.value, '$.source') AND c.source_id = json_extract(j.value, '$.source_id')`
    ).bind(searchId, JSON.stringify(rows.map((r) => ({ source: r.source, source_id: r.source_id })))),
  ]);
  return rows.length;
}

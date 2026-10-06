// Seller-side lookups for the public "What is my business worth?" page and for adding one company by number.
// Owners type their own registry number; we pull their filed figures live and value them on the spot.
import { PROVIDERS } from "./providers.js";
import { INDUSTRIES } from "./data/industries.js";
import { toRow, saveCompanies } from "./store.js";
import { valuation } from "../public/deal.js";
import { ownerOf } from "./tenancy.js";
import { bucketSearch } from "./index.js"; // circular import is fine: used at run time only

const UA = { "User-Agent": "Dealflow/1.0 (acquisition research; contact bendik@asym.capital)", Accept: "application/json" };
const get = async (url) => {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers: UA });
    if (r.status === 404) return null;
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && i < 2) { await new Promise((res) => setTimeout(res, 1500 * (i + 1))); continue; }
    throw Object.assign(new Error(r.status === 429 ? "The registry is busy right now. Please try again in a minute." : `Registry lookup failed (${r.status})`), { status: 503 });
  }
};

function industryFor(country, code) {
  if (!code) return null;
  return INDUSTRIES.find((i) => (i[country] || []).includes(code))?.id
    || INDUSTRIES.find((i) => (i[country] || []).some((c) => c.slice(0, 4) === code.slice(0, 4)))?.id
    || null;
}

export async function lookup(country, rawId) {
  const id = String(rawId || "").replace(/\D/g, "");
  if (country === "no") {
    if (id.length !== 9) throw Object.assign(new Error("A Norwegian organisation number has 9 digits"), { status: 400 });
    const e = await get(`https://data.brreg.no/enhetsregisteret/api/enheter/${id}`);
    if (!e) throw Object.assign(new Error("No company with that organisation number"), { status: 404 });
    const [roles, accounts] = await Promise.all([
      get(`https://data.brreg.no/enhetsregisteret/api/enheter/${id}/roller`).catch(() => null),
      get(`https://data.brreg.no/regnskapsregisteret/regnskap/${id}`).catch(() => null),
    ]);
    const c = PROVIDERS.no.normalize(e, roles, accounts);
    return { ...c, industry: industryFor("no", c.industryCode) };
  }
  if (country === "fr") {
    if (id.length !== 9 && id.length !== 14) throw Object.assign(new Error("A SIREN has 9 digits (or give the 14-digit SIRET)"), { status: 400 });
    const d = await get(`https://recherche-entreprises.api.gouv.fr/search?q=${id.slice(0, 9)}&per_page=1`);
    const r = d?.results?.find((x) => x.siren === id.slice(0, 9));
    if (!r) throw Object.assign(new Error("No company with that SIREN"), { status: 404 });
    const c = PROVIDERS.fr.normalize(r, {});
    return { ...c, industry: industryFor("fr", c.industryCode) };
  }
  throw Object.assign(new Error("Instant valuation is available for France and Norway"), { status: 400 });
}

// What the public page is allowed to show: the company's own filed figures and our range. No personal data.
export function publicView(c) {
  const row = toRow(c);
  const v = valuation(row);
  return {
    country: c.country, id: c.sourceId, name: c.name, city: c.city, founded: c.founded,
    staff: c.employeesBand, revenue: c.revenue, revenueYear: c.revenueYear, currency: c.currency,
    ebit: c.ebit ?? null, netIncome: c.netIncome ?? null,
    industry: INDUSTRIES.find((i) => i.id === c.industry)?.label || null,
    valuation: v ? { low: v.equity[0], mid: v.equity[1], high: v.equity[2], basis: v.basis, multiple: v.multiple, confidence: v.confidence } : null,
  };
}

// Saves the company plus the owner's details and routes it to the buyer holding that territory (the platform
// account when nobody does): their pipeline, their "Inbound sellers" list.
export async function captureLead(env, c, lead) {
  const db = env.DB;
  const holder = await ownerOf(env, c.country, c.industry, c.region);
  const accountId = holder?.account_id || 1;
  const search = await bucketSearch(db, accountId, "Inbound sellers");
  await saveCompanies(db, search.id, [c], c.industry);
  const company = await db.prepare("SELECT id, valuation_mid, currency FROM companies WHERE source = ?1 AND source_id = ?2").bind(c.source, String(c.sourceId)).first();
  const v = valuation(toRow(c));
  const now = new Date().toISOString();
  const note = `Inbound seller via valuation page (${now.slice(0, 10)}).
Contact: ${lead.name} · ${lead.email}${lead.phone ? ` · ${lead.phone}` : ""}
Timeline: ${lead.timeline || "not given"}${lead.message ? `\nMessage: ${lead.message}` : ""}`;
  await db.batch([
    db.prepare("UPDATE companies SET inbound = 1 WHERE id = ?1").bind(company.id),
    db.prepare(
      `INSERT INTO leads (account_id, company_id, name, email, phone, timeline, message, valuation_low, valuation_high, currency, created_at)
       VALUES (?11, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    ).bind(company.id, lead.name, lead.email, lead.phone || null, lead.timeline || null, lead.message || null, v?.equity[0] ?? null, v?.equity[2] ?? null, c.currency, now, accountId),
    db.prepare(
      `INSERT INTO pipeline (account_id, company_id, status, notes, updated_at) VALUES (?4, ?1, 'Conversation', ?2, ?3)
       ON CONFLICT (account_id, company_id) DO UPDATE SET status = 'Conversation', notes = ?2 || char(10) || char(10) || notes, updated_at = ?3`
    ).bind(company.id, note, now, accountId),
    db.prepare("UPDATE searches SET found = (SELECT COUNT(*) FROM search_results WHERE search_id = ?1), total = (SELECT COUNT(*) FROM search_results WHERE search_id = ?1) WHERE id = ?1").bind(search.id),
  ]);
  return company.id;
}

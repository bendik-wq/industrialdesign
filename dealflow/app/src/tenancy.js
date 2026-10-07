// Exclusive territories. A territory is one industry in one area of one country, held by exactly one account.
// A whole-country claim (region NULL) overlaps every region of that country+industry, and vice versa.
// France and Norway regions are registry codes (département, fylke); UK and US regions are free text, matched
// loosely so "Austin, TX" and "Austin" count as the same place.
import { PROVIDERS } from "./providers.js";
import { INDUSTRIES } from "./data/industries.js";

const fold = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const coded = (country) => Array.isArray(PROVIDERS[country]?.regions);

export function sameRegion(country, a, b) {
  if (!a || !b) return true; // whole country overlaps everything
  if (coded(country)) return String(a) === String(b);
  const x = fold(a), y = fold(b);
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);
}

// Does the territory cover a specific company/search region? (Whole-country territory covers all of it.)
export function covers(country, territoryRegion, region) {
  if (!territoryRegion) return true;
  if (!region) return false;
  return sameRegion(country, territoryRegion, region);
}

export function territoryLabel(t) {
  const p = PROVIDERS[t.country];
  const ind = INDUSTRIES.find((i) => i.id === t.industry);
  const region = !t.region ? `All of ${p?.label || t.country}` : coded(t.country) ? (p.regions.find((r) => r.code === t.region)?.name.replace(/^\S+ · /, "") || t.region) : t.region;
  return `${ind?.label || t.industry} · ${region}`;
}

export function normalizeClaim(body) {
  const p = PROVIDERS[body.country];
  const ind = INDUSTRIES.find((i) => i.id === body.industry);
  if (!p || !ind) throw Object.assign(new Error("Pick a country and an industry"), { status: 400 });
  if (p.id !== "us" && !(ind[p.id] || []).length) throw Object.assign(new Error(`${ind.label} isn't available in ${p.label} yet`), { status: 400 });
  let region = String(body.region || "").trim().slice(0, 80) || null;
  if (region && coded(p.id) && !p.regions.find((r) => r.code === region)) throw Object.assign(new Error("Unknown region"), { status: 400 });
  if (!region && !coded(p.id)) throw Object.assign(new Error(`Name a city or area in ${p.label}`), { status: 400 });
  return { country: p.id, industry: ind.id, region };
}

export async function conflicts(env, claim, exceptAccountId = null) {
  const { results } = await env.DB.prepare("SELECT t.*, a.name AS account_name FROM territories t JOIN accounts a ON a.id = t.account_id WHERE t.country = ?1 AND t.industry = ?2")
    .bind(claim.country, claim.industry).all();
  return results.filter((t) => t.account_id !== exceptAccountId && sameRegion(claim.country, t.region, claim.region));
}

// Which account holds the territory a company sits in (for routing inbound sellers, blocking add-by-number).
export async function ownerOf(env, country, industry, region) {
  if (!country || !industry) return null;
  const { results } = await env.DB.prepare("SELECT * FROM territories WHERE country = ?1 AND industry = ?2").bind(country, industry).all();
  return results.find((t) => covers(country, t.region, region)) || null;
}

export async function myTerritories(env, accountId) {
  const { results } = await env.DB.prepare("SELECT * FROM territories WHERE account_id = ?1 ORDER BY created_at").bind(accountId).all();
  return results.map((t) => ({ ...t, label: territoryLabel(t) }));
}

// Members may only search inside their own territories. Returns the region to search (narrowing a whole-country
// request to the account's single region when that's the only fit), or throws with a clear reason.
export async function scopeToTerritory(env, ctx, { country, industry, region }) {
  if (ctx.isAdmin) return region || null;
  const mine = (await myTerritories(env, ctx.accountId)).filter((t) => t.country === country && t.industry === industry);
  if (!mine.length) throw Object.assign(new Error("That industry and area is outside your territories. Claim it on the Territories page first."), { status: 403 });
  if (mine.some((t) => covers(country, t.region, region))) return region || null;
  if (!region && mine.length === 1 && mine[0].region) return mine[0].region; // narrow "everywhere" to their one region
  throw Object.assign(new Error(`You can search ${mine.map((t) => t.label).join(" or ")}.`), { status: 403 });
}

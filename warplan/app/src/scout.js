// Scout: find acquisition targets with owners and contact details, from official registries and maps.
//   UK       Companies House: directors + birth month/year, size class. Free key (workspace integration).
//   Anywhere Google Places: phone, website, rating. Key (workspace integration).
//   Anywhere Google Maps via Monid (litescrape): phone, website, rating, category. Monid key; ~$0.0002 a page.
//   Anywhere OpenStreetMap: phone, email, website where mapped. No key; patchier coverage.
// Every result comes back in one shape; importing turns it into a pipeline target.
import { INDUSTRIES, industryById } from "./data/industries.js";
import { run as monidRun } from "./monid.js";

const UA = "Warplan/2 (acquisition research; https://warplan.bendik-50e.workers.dev)";
const err = (status, message) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const titleCase = (s) => (s || "").toLowerCase().replace(/(^|[\s\-'’(/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const yearNow = () => new Date().getUTCFullYear();
// Drop tracking parameters (utm_*, gclid...) that Google listings append to websites.
const cleanUrl = (u) => { try { const x = new URL(u); [...x.searchParams.keys()].filter((k) => /^(utm_|gclid|fbclid|y_source)/i.test(k)).forEach((k) => x.searchParams.delete(k)); return x.toString().replace(/\?$/, ""); } catch { return u || ""; } };

async function getJson(url, init = {}, tries = 3) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers || {}) } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if ((res.status === 429 || res.status >= 500) && i < tries - 1) { await sleep(1200 * 2 ** i); continue; }
    if (res.status === 401 || res.status === 403) throw err(400, `${new URL(url).host} rejected the API key`);
    throw err(502, `${new URL(url).host} answered ${res.status}`);
  }
}

// OpenStreetMap tags per industry (for the keyless worldwide source).
const OSM_TAGS = {
  hvac: ['craft="hvac"'], plumbing: ['craft="plumber"'], electrical: ['craft="electrician"'], roofing: ['craft="roofer"'],
  landscaping: ['craft="gardener"', 'shop="garden_centre"'], cleaning: ['office="cleaning"', 'craft="cleaning"'], pest: ['craft="pest_control"'],
  dental: ['amenity="dentist"', 'healthcare="dentist"'], gp: ['amenity="doctors"', 'amenity="clinic"'], physio: ['healthcare="physiotherapist"'],
  vet: ['amenity="veterinary"'], accounting: ['office="accountant"', 'office="tax_advisor"'], insurance: ['office="insurance"'],
  it: ['office="it"'], auto: ['shop="car_repair"'], trucking: ['office="logistics"', 'office="moving_company"'], waste: ['office="waste_management"'],
  security: ['office="security"'], engineering: ['office="engineer"'], funeral: ['shop="funeral_directors"'], childcare: ['amenity="childcare"', 'amenity="kindergarten"'],
};

const ownerFrom = (people) => {
  const p = people.find((x) => x.birthYear) || people[0];
  return p ? { owner_name: p.name, owner_age: p.birthYear ? yearNow() - p.birthYear : null } : {};
};

// ------------------------------------------------------------------ United Kingdom
const uk = {
  id: "uk", label: "United Kingdom", flag: "🇬🇧", currency: "£", needs: "companies_house",
  regionLabel: "Town or city", regions: "text",
  gives: ["Directors and birth month/year", "Incorporation date", "No email/phone: scan the website after import"],
  async search(env, q, keys) {
    const ind = industryById(q.industry);
    if (!keys.companies_house) throw err(400, "Connect a Companies House key under Settings → Integrations (it's free)");
    const auth = { Authorization: `Basic ${btoa(`${keys.companies_house}:`)}` };
    const u = new URL("https://api.company-information.service.gov.uk/advanced-search/companies");
    u.searchParams.set("sic_codes", ind.uk.join(","));
    if (q.region) u.searchParams.set("location", q.region);
    u.searchParams.set("company_status", "active"); u.searchParams.set("size", "15"); u.searchParams.set("start_index", String((q.page - 1) * 15));
    const d = await getJson(u.toString(), { headers: auth });
    const rows = [];
    for (const c of d?.items || []) {
      const officers = await getJson(`https://api.company-information.service.gov.uk/company/${c.company_number}/officers?items_per_page=20`, { headers: auth }).catch(() => null);
      const people = (officers?.items || []).filter((o) => !o.resigned_on && o.date_of_birth).map((o) => {
        const [last, first = ""] = o.name.split(",");
        return { name: titleCase(`${first.trim().split(" ")[0]} ${last.trim()}`), role: o.officer_role, birthYear: o.date_of_birth.year };
      });
      const a = c.registered_office_address || {};
      rows.push({
        source: "uk_ch", source_id: c.company_number, name: titleCase(c.company_name), legal_form: c.company_type, location: titleCase(a.locality), address: [a.address_line_1, a.locality, a.postal_code].filter(Boolean).join(", "),
        website: "", email: "", phone: "", employees: null, revenue: null, ebitda: null, founded: Number((c.date_of_creation || "").slice(0, 4)) || null,
        people: people.slice(0, 6), ...ownerFrom(people), registry_url: `https://find-and-update.company-information.service.gov.uk/company/${c.company_number}`,
      });
    }
    return { results: rows, more: (d?.hits || 0) > q.page * 15, total: d?.hits ?? null };
  },
};

// ------------------------------------------------------------------ Google Places (anywhere)
const places = {
  id: "places", label: "Anywhere · Google Maps", flag: "🌍", currency: "$", needs: "google_places",
  regionLabel: "City or area", regions: "text",
  gives: ["Phone and website for almost every business", "Google rating and reviews", "Owner: scan the website or add by hand"],
  async search(env, q, keys) {
    const ind = industryById(q.industry);
    if (!keys.google_places) throw err(400, "Connect a Google Places API key under Settings → Integrations");
    if (!q.region) throw err(400, "Type a city or area, e.g. “Austin, TX”");
    const body = { textQuery: `${ind.places} in ${q.region}`, pageSize: 20, ...(q.cursor ? { pageToken: q.cursor } : {}) };
    const d = await getJson("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": keys.google_places, "X-Goog-FieldMask": "nextPageToken,places.id,places.displayName,places.formattedAddress,places.addressComponents,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.businessStatus" },
      body: JSON.stringify(body),
    });
    const rows = (d?.places || []).filter((x) => x.businessStatus !== "CLOSED_PERMANENTLY").map((x) => {
      const comp = (t) => x.addressComponents?.find((c) => c.types?.includes(t))?.longText;
      return {
        source: "places", source_id: x.id, name: x.displayName?.text, location: [comp("locality"), comp("administrative_area_level_1")].filter(Boolean).join(", "), address: x.formattedAddress || "",
        website: cleanUrl(x.websiteUri), email: "", phone: x.internationalPhoneNumber || x.nationalPhoneNumber || "", employees: null, revenue: null, ebitda: null,
        rating: x.rating ?? null, reviews: x.userRatingCount ?? 0, people: [], registry_url: `https://www.google.com/maps/place/?q=place_id:${x.id}`,
      };
    });
    return { results: rows, more: !!d?.nextPageToken, cursor: d?.nextPageToken || null, total: null };
  },
};

// ------------------------------------------------------------------ Google Maps via Monid (anywhere, no Google key)
const maps = {
  id: "maps", label: "Anywhere · Google Maps (Monid)", flag: "📍", currency: "$", needs: "monid",
  regionLabel: "City or area", regions: "text",
  gives: ["Every business Google lists: phone, website, category", "Rating and review count (size signal)", "20 per page for a fraction of a cent", "Then Deep enrich finds the owner's email"],
  async search(env, q, keys, ctx) {
    const ind = industryById(q.industry);
    if (!keys.monid) throw err(400, "Connect a Monid key under Settings → Integrations");
    if (!q.region) throw err(400, "Type a city or area, e.g. “Austin, TX”");
    const r = await monidRun(env, ctx, { provider: "litescrape", endpoint: "/google/maps", input: { queryParams: { q: ind.places, type: "search", location: q.region, z: 12, ...(q.page > 1 && { start: (q.page - 1) * 20 }) } } }, { purpose: `Scout: ${ind.places} in ${q.region}`, key: keys.monid, maxWaitMs: 28000 });
    const list = r.output?.local_results || [];
    const rows = list.filter((x) => x.title && !/permanently closed/i.test(x.open_state || "")).map((x) => {
      const parts = String(x.address || "").split(",").map((s) => s.trim());
      return {
        source: "maps", source_id: x.place_id || x.data_id || x.title, name: x.title, location: parts.length > 2 ? parts.slice(-2).join(", ").replace(/\s+\d{4,6}$/, "") : x.address || q.region, address: x.address || "",
        website: cleanUrl(x.website), email: "", phone: x.phone || "", employees: null, revenue: null, ebitda: null,
        rating: x.rating ?? null, reviews: x.reviews ?? 0, category: x.type || "", people: [], registry_url: x.place_id ? `https://www.google.com/maps/place/?q=place_id:${x.place_id}` : "",
      };
    });
    return { results: rows, more: list.length >= 20, total: null, cost_usd: r.cost_usd };
  },
};

// ------------------------------------------------------------------ OpenStreetMap (anywhere, free)
const osm = {
  id: "osm", label: "Anywhere · OpenStreetMap", flag: "🗺", currency: "$", needs: null,
  regionLabel: "City or area", regions: "text",
  gives: ["Phone, email and website where mapped", "Free, worldwide, but patchier than Google"],
  async search(env, q) {
    const tags = OSM_TAGS[q.industry];
    if (!tags) throw err(400, "No map category for that industry yet");
    if (!q.region) throw err(400, "Type a city or area, e.g. “Austin, TX”");
    const geo = await getJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q.region)}`);
    if (!geo?.[0]) throw err(400, `Couldn't find “${q.region}” on the map`);
    const [s, n, w, e] = geo[0].boundingbox.map(Number);
    const bbox = `${s},${w},${n},${e}`;
    const query = `[out:json][timeout:25];(${tags.map((t) => `nwr[${t}](${bbox});`).join("")});out center tags 400;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent(query)}` });
    if (!res.ok) throw err(502, `OpenStreetMap answered ${res.status}; try again in a minute`);
    const d = await res.json();
    const all = (d.elements || []).filter((x) => x.tags?.name).map((x) => {
      const t = x.tags;
      return {
        source: "osm", source_id: `${x.type}/${x.id}`, name: t.name, location: t["addr:city"] || q.region, address: [t["addr:housenumber"], t["addr:street"], t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" "),
        website: t.website || t["contact:website"] || "", email: t.email || t["contact:email"] || "", phone: t.phone || t["contact:phone"] || "",
        employees: null, revenue: null, ebitda: null, people: [], registry_url: `https://www.openstreetmap.org/${x.type}/${x.id}`,
      };
    }).sort((a, b) => (b.phone || b.email ? 1 : 0) - (a.phone || a.email ? 1 : 0));
    const start = (q.page - 1) * 25;
    return { results: all.slice(start, start + 25), more: all.length > start + 25, total: all.length };
  },
};

export const SOURCES = { maps, uk, places, osm };

export function scoutInfo(keys) {
  return {
    industries: INDUSTRIES.map(({ id, label }) => ({ id, label })), monid: !!keys.monid,
    sources: Object.values(SOURCES).map((s) => ({ id: s.id, label: s.label, flag: s.flag, regionLabel: s.regionLabel, regions: s.regions, gives: s.gives, needs: s.needs, ready: !s.needs || !!keys[s.needs] })),
  };
}

export async function scoutSearch(env, ctx, b, keys) {
  const src = SOURCES[b.source];
  if (!src) throw err(400, "Pick a source");
  if (!industryById(b.industry)) throw err(400, "Pick an industry");
  const q = { industry: b.industry, region: String(b.region || "").trim().slice(0, 80), minStaff: Math.max(0, +b.min_staff || 0), page: Math.max(1, Math.min(50, +b.page || 1)), cursor: b.cursor ? String(b.cursor) : null };
  const out = await src.search(env, q, keys, ctx);
  // Flag what's already in the pipeline so it isn't imported twice.
  const names = out.results.map((r) => r.name.toLowerCase());
  const known = new Set();
  if (names.length) {
    const { results } = await env.DB.prepare(`SELECT lower(name) AS n FROM targets WHERE account_id = ?1 AND lower(name) IN (${names.map((_, i) => `?${i + 2}`).join(",")})`).bind(ctx.accountId, ...names).all();
    results.forEach((r) => known.add(r.n));
  }
  const industry = industryById(b.industry).label;
  return { ...out, currency: src.currency, results: out.results.map((r) => ({ ...r, industry, in_pipeline: known.has(r.name.toLowerCase()) })) };
}

// Scout result → pipeline target fields.
export function toTarget(r, currency) {
  const people = (r.people || []).map((p) => `${p.name}${p.role ? ` (${p.role}${p.birthYear ? `, born ${p.birthYear}` : ""})` : ""}`).join("; ");
  return {
    name: r.name, industry: r.industry || "", location: r.location || "", website: r.website || "", owner_name: r.owner_name || "", owner_age: r.owner_age ?? null,
    phone: r.phone || "", email: r.email || "", employees: r.employees ?? null, revenue: r.revenue ?? null, ebitda: r.ebitda ?? null, currency: currency || "$",
    stage: "sourced", source: `Scout · ${({ uk_ch: "Companies House", places: "Google Maps", maps: "Google Maps (Monid)", osm: "OpenStreetMap" })[r.source] || r.source}`,
    motivation: [people && `People on file: ${people}.`, r.founded && `Founded ${r.founded}.`, r.address && `Address: ${r.address}.`, r.registry_url && `Record: ${r.registry_url}`].filter(Boolean).join(" "),
  };
}

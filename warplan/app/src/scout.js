// Scout: find acquisition targets with owners and contact details, from official registries and maps.
//   Norway   Brønnøysund: owners + birth dates, email, phone, website, revenue and operating profit. No key.
//   France   Recherche d'entreprises (Sirene + RNE): owners + birth years, size, revenue when filed. No key.
//   UK       Companies House: directors + birth month/year, size class. Free key (workspace integration).
//   Anywhere Google Places: phone, website, rating. Key (workspace integration).
//   Anywhere OpenStreetMap: phone, email, website where mapped. No key; patchier coverage.
// Every result comes back in one shape; importing turns it into a pipeline target.
import { INDUSTRIES, industryById } from "./data/industries.js";
import NO_FYLKER from "./data/no_fylker.json";
import FR_DEPARTEMENTS from "./data/fr_dep.json";

const UA = "Warplan/2 (acquisition research; https://warplan.bendik-50e.workers.dev)";
const err = (status, message) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const titleCase = (s) => (s || "").toLowerCase().replace(/(^|[\s\-'’(/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const yearNow = () => new Date().getUTCFullYear();

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

// ------------------------------------------------------------------ Norway
const NO_FORMS = { AS: "AS", ENK: "Sole proprietorship", ANS: "Partnership", DA: "Partnership", ASA: "ASA" };
const norway = {
  id: "no", label: "Norway", flag: "🇳🇴", currency: "NOK ", needs: null,
  regionLabel: "County", regions: NO_FYLKER.map((f) => ({ code: f.code, name: f.name })),
  gives: ["Owner and birth date", "Company email and phone", "Website", "Revenue and operating profit", "Exact headcount"],
  async search(env, q) {
    const ind = industryById(q.industry);
    if (!ind?.no?.length) throw err(400, "No Norwegian activity code for that industry yet");
    const u = new URL("https://data.brreg.no/enhetsregisteret/api/enheter");
    u.searchParams.set("naeringskode", ind.no.join(","));
    if (q.region) u.searchParams.set("kommunenummer", NO_FYLKER.find((f) => f.code === q.region)?.kommuner.join(",") || "");
    if (q.minStaff > 0) u.searchParams.set("fraAntallAnsatte", String(q.minStaff));
    u.searchParams.set("konkurs", "false"); u.searchParams.set("underAvvikling", "false");
    u.searchParams.set("size", "15"); u.searchParams.set("page", String(q.page - 1)); u.searchParams.set("sort", "antallAnsatte,DESC");
    const d = await getJson(u.toString());
    const units = (d?._embedded?.enheter || []).filter((e) => ind.no.includes(e.naeringskode1?.kode));
    const rows = await Promise.all(units.map(async (e) => {
      const [roles, accounts] = await Promise.all([
        getJson(`https://data.brreg.no/enhetsregisteret/api/enheter/${e.organisasjonsnummer}/roller`).catch(() => null),
        getJson(`https://data.brreg.no/regnskapsregisteret/regnskap/${e.organisasjonsnummer}`).catch(() => null),
      ]);
      const people = [];
      for (const g of roles?.rollegrupper || []) for (const r of g.roller || []) {
        if (!r.person || r.avregistrert || r.person.erDoed) continue;
        const n = r.person.navn || {};
        people.push({ name: [n.fornavn, n.etternavn].filter(Boolean).join(" "), role: r.type?.beskrivelse, birthYear: Number((r.person.fodselsdato || "").slice(0, 4)) || null });
      }
      const uniq = [...new Map(people.map((p) => [p.name, p])).values()].sort((x, y) => /daglig leder|innehaver/i.test(y.role) - /daglig leder|innehaver/i.test(x.role));
      const acc = Array.isArray(accounts) ? accounts.sort((x, y) => (y.regnskapsperiode?.tilDato || "").localeCompare(x.regnskapsperiode?.tilDato || ""))[0] : null;
      const res = acc?.resultatregnskapResultat?.driftsresultat;
      const a = e.forretningsadresse || e.postadresse || {};
      return {
        source: "no_brreg", source_id: e.organisasjonsnummer, name: titleCase(e.navn), legal_form: NO_FORMS[e.organisasjonsform?.kode] || e.organisasjonsform?.beskrivelse,
        location: titleCase(a.poststed || a.kommune), address: [...(a.adresse || []), [a.postnummer, a.poststed].filter(Boolean).join(" ")].filter(Boolean).join(", "),
        website: e.hjemmeside ? (e.hjemmeside.startsWith("http") ? e.hjemmeside : `https://${e.hjemmeside}`) : "",
        email: e.epostadresse || "", phone: e.telefon || e.mobil || "",
        employees: e.harRegistrertAntallAnsatte ? e.antallAnsatte ?? null : null,
        revenue: res?.driftsinntekter?.sumDriftsinntekter > 0 ? res.driftsinntekter.sumDriftsinntekter : null,
        ebitda: res?.driftsresultat ?? null, // operating profit (EBIT) as filed: a floor for EBITDA
        founded: Number((e.stiftelsesdato || "").slice(0, 4)) || null,
        people: uniq.slice(0, 6), ...ownerFrom(uniq),
        registry_url: `https://virksomhet.brreg.no/nb/oppslag/enheter/${e.organisasjonsnummer}`,
      };
    }));
    return { results: rows, more: (d?.page?.totalPages || 0) > q.page, total: d?.page?.totalElements ?? null };
  },
};

// ------------------------------------------------------------------ France
const FR_BANDS = { "01": [1, "1–2"], "02": [3, "3–5"], "03": [6, "6–9"], "11": [10, "10–19"], "12": [20, "20–49"], "21": [50, "50–99"], "22": [100, "100–199"], "31": [200, "200–249"], "32": [250, "250–499"] };
const france = {
  id: "fr", label: "France", flag: "🇫🇷", currency: "€", needs: null,
  regionLabel: "Département", regions: FR_DEPARTEMENTS.map((d) => ({ code: d.code, name: `${d.code} · ${d.nom}` })),
  gives: ["Owners and birth years", "Headcount band", "Revenue when filed", "No email/phone: scan the website after import"],
  async search(env, q) {
    const ind = industryById(q.industry);
    if (!ind?.fr?.length) throw err(400, "No French activity code for that industry yet");
    const u = new URL("https://recherche-entreprises.api.gouv.fr/search");
    u.searchParams.set("activite_principale", ind.fr.join(","));
    if (q.region) u.searchParams.set("departement", q.region);
    u.searchParams.set("etat_administratif", "A");
    if (q.minStaff > 0) u.searchParams.set("tranche_effectif_salarie", Object.entries(FR_BANDS).filter(([, [m]]) => m >= q.minStaff).map(([k]) => k).join(","));
    u.searchParams.set("per_page", "25"); u.searchParams.set("page", String(q.page));
    const d = await getJson(u.toString());
    const rows = (d?.results || []).filter((r) => r.categorie_entreprise !== "GE").map((r) => {
      const s = r.siege || {}, band = FR_BANDS[r.tranche_effectif_salarie];
      const fin = Object.entries(r.finances || {}).filter(([, v]) => v?.ca).sort(([a], [b]) => b.localeCompare(a))[0];
      const people = (r.dirigeants || []).filter((x) => x.type_dirigeant === "personne physique").map((x) => ({ name: titleCase(`${(x.prenoms || "").split(" ")[0]} ${(x.nom || "").replace(/\s*\(.*?\)\s*/g, " ")}`.replace(/\s+/g, " ").trim()), role: x.qualite, birthYear: Number(x.annee_de_naissance) || null }));
      return {
        source: "fr_sirene", source_id: r.siren, name: titleCase(r.nom_complet).replace(/\s*\(.*?\)\s*$/, ""), legal_form: r.nature_juridique, location: titleCase(s.libelle_commune), address: s.adresse || "",
        website: "", email: "", phone: "", employees: band ? band[0] : null, employees_label: band?.[1],
        revenue: fin ? fin[1].ca : null, ebitda: null, founded: Number((r.date_creation || "").slice(0, 4)) || null,
        people: people.slice(0, 6), ...ownerFrom(people), registry_url: `https://annuaire-entreprises.data.gouv.fr/entreprise/${r.siren}`,
      };
    });
    return { results: rows, more: (d?.total_pages || 0) > q.page, total: d?.total_results ?? null };
  },
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
        website: x.websiteUri || "", email: "", phone: x.internationalPhoneNumber || x.nationalPhoneNumber || "", employees: null, revenue: null, ebitda: null,
        rating: x.rating ?? null, reviews: x.userRatingCount ?? 0, people: [], registry_url: `https://www.google.com/maps/place/?q=place_id:${x.id}`,
      };
    });
    return { results: rows, more: !!d?.nextPageToken, cursor: d?.nextPageToken || null, total: null };
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

export const SOURCES = { no: norway, fr: france, uk, places, osm };

export function scoutInfo(keys) {
  return {
    industries: INDUSTRIES.map(({ id, label }) => ({ id, label })),
    sources: Object.values(SOURCES).map((s) => ({ id: s.id, label: s.label, flag: s.flag, regionLabel: s.regionLabel, regions: s.regions, gives: s.gives, needs: s.needs, ready: !s.needs || !!keys[s.needs] })),
  };
}

export async function scoutSearch(env, ctx, b, keys) {
  const src = SOURCES[b.source];
  if (!src) throw err(400, "Pick a source");
  if (!industryById(b.industry)) throw err(400, "Pick an industry");
  const q = { industry: b.industry, region: String(b.region || "").trim().slice(0, 80), minStaff: Math.max(0, +b.min_staff || 0), page: Math.max(1, Math.min(50, +b.page || 1)), cursor: b.cursor ? String(b.cursor) : null };
  const out = await src.search(env, q, keys);
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
    stage: "sourced", source: `Scout · ${({ no_brreg: "Brønnøysund", fr_sirene: "Sirene", uk_ch: "Companies House", places: "Google Maps", osm: "OpenStreetMap" })[r.source] || r.source}`,
    motivation: [people && `People on file: ${people}.`, r.founded && `Founded ${r.founded}.`, r.address && `Address: ${r.address}.`, r.registry_url && `Record: ${r.registry_url}`].filter(Boolean).join(" "),
  };
}

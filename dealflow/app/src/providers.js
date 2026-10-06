// Country connectors. Each turns an official registry (or Google Places) into the common company shape that
// scoring.js understands. Pages are small so one Workflow step stays well under Workers' subrequest limits.
import FR_DEPARTEMENTS from "./data/fr_dep.json";
import NO_FYLKER from "./data/no_fylker.json";

const UA = "Dealflow/1.0 (acquisition research; contact bendik@asym.capital)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, init = {}, tries = 4) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers || {}) } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if ((res.status === 429 || res.status >= 500) && i < tries - 1) { await sleep(800 * 2 ** i); continue; }
    throw new Error(`${new URL(url).host} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
const year = (d) => (d ? Number(String(d).slice(0, 4)) || null : null);
const title = (s) => (s || "").toLowerCase().replace(/(^|[\s\-'’(/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

// --------------------------------------------------------------------------------------------
// France — recherche-entreprises.api.gouv.fr (INSEE Sirene + RNE). No key. ~7 req/s per IP.
// --------------------------------------------------------------------------------------------
const FR_BANDS = { "00": [0, "0"], "01": [1, "1–2"], "02": [3, "3–5"], "03": [6, "6–9"], "11": [10, "10–19"], "12": [20, "20–49"], "21": [50, "50–99"], "22": [100, "100–199"], "31": [200, "200–249"], "32": [250, "250–499"], "41": [500, "500–999"], "42": [1000, "1,000–1,999"], "51": [2000, "2,000–4,999"], "52": [5000, "5,000–9,999"], "53": [10000, "10,000+"] };
const FR_LEGAL = { "1000": "Sole trader", "5499": "SARL", "5498": "EURL", "5710": "SAS", "5720": "SASU", "5599": "SA", "5485": "SELARL", "5785": "SELAS", "6540": "SCI" };

const france = {
  id: "fr",
  label: "France",
  flag: "🇫🇷",
  currency: "EUR",
  regionLabel: "Département",
  regions: FR_DEPARTEMENTS.map((d) => ({ code: d.code, name: `${d.code} · ${d.nom}` })),
  publishes: ["Owner birth year", "Headcount band", "Founded date", "Sites", "Revenue (when filed publicly)"],
  pageSize: 25,
  pagesPerStep: 6,
  query(p, page) {
    const u = new URL("https://recherche-entreprises.api.gouv.fr/search");
    u.searchParams.set("activite_principale", p.codes.join(","));
    if (p.region) u.searchParams.set("departement", p.region);
    u.searchParams.set("etat_administratif", "A");
    const bands = Object.entries(FR_BANDS).filter(([, [min]]) => min >= (p.minStaff || 0) && min > 0).map(([k]) => k);
    if (p.minStaff > 0) u.searchParams.set("tranche_effectif_salarie", bands.join(","));
    u.searchParams.set("per_page", "25");
    u.searchParams.set("page", String(page));
    return u.toString();
  },
  async plan(env, p) {
    const d = await getJson(this.query(p, 1));
    return { total: d.total_results, pages: Math.min(d.total_pages, 200) };
  },
  async fetchPage(env, p, page) {
    const d = await getJson(this.query(p, page));
    return (d?.results || []).map((r) => this.normalize(r, p));
  },
  normalize(r, p) {
    const band = FR_BANDS[r.tranche_effectif_salarie];
    const fin = Object.entries(r.finances || {}).filter(([, v]) => v?.ca).sort(([a], [b]) => b.localeCompare(a))[0];
    const s = r.siege || {};
    return {
      source: "fr_sirene",
      sourceId: r.siren,
      country: "fr",
      name: title(r.nom_complet),
      legalForm: FR_LEGAL[r.nature_juridique] || r.nature_juridique,
      industryCode: r.activite_principale,
      address: s.adresse || null,
      city: title(s.libelle_commune),
      region: s.departement,
      postcode: s.code_postal,
      lat: Number(s.latitude) || null,
      lng: Number(s.longitude) || null,
      founded: year(r.date_creation),
      employeesMin: band ? band[0] : null,
      employeesBand: band ? band[1] : null,
      establishments: r.nombre_etablissements_ouverts || null,
      revenue: fin ? fin[1].ca : null,
      revenueYear: fin ? Number(fin[0]) : null,
      currency: "EUR",
      people: (r.dirigeants || []).filter((x) => x.type_dirigeant === "personne physique").map((x) => ({
        name: title(`${(x.prenoms || "").split(" ")[0]} ${x.nom || ""}`.trim()),
        role: x.qualite,
        birthYear: Number(x.annee_de_naissance) || null,
        birthMonth: Number((x.date_de_naissance || "").split("-")[1]) || null,
      })),
      registryUrl: `https://annuaire-entreprises.data.gouv.fr/entreprise/${r.siren}`,
      excluded: r.categorie_entreprise === "GE",
    };
  },
};

// --------------------------------------------------------------------------------------------
// Norway — Brønnøysund Enhetsregisteret + roles (birth dates) + Regnskapsregisteret (revenue). No key.
// --------------------------------------------------------------------------------------------
const NO_FORMS = { AS: "AS", ENK: "Sole proprietorship", ANS: "Partnership (ANS)", DA: "Partnership (DA)", ASA: "ASA", NUF: "Foreign branch" };
const norway = {
  id: "no",
  label: "Norway",
  flag: "🇳🇴",
  currency: "NOK",
  regionLabel: "County (fylke)",
  regions: NO_FYLKER.map((f) => ({ code: f.code, name: f.name })),
  publishes: ["Owner birth date", "Exact headcount", "Founded date", "Revenue (filed accounts)", "Website"],
  pageSize: 15,
  pagesPerStep: 1,
  query(p, page) {
    const u = new URL("https://data.brreg.no/enhetsregisteret/api/enheter");
    u.searchParams.set("naeringskode", p.codes.join(","));
    if (p.region) u.searchParams.set("kommunenummer", NO_FYLKER.find((f) => f.code === p.region)?.kommuner.join(",") || "");
    if (p.minStaff > 0) u.searchParams.set("fraAntallAnsatte", String(p.minStaff));
    u.searchParams.set("konkurs", "false");
    u.searchParams.set("underAvvikling", "false");
    u.searchParams.set("size", String(this.pageSize));
    u.searchParams.set("page", String(page - 1));
    u.searchParams.set("sort", "antallAnsatte,DESC");
    return u.toString();
  },
  async plan(env, p) {
    const d = await getJson(this.query(p, 1));
    return { total: d.page.totalElements, pages: Math.min(d.page.totalPages, Math.floor(10000 / this.pageSize)) };
  },
  async fetchPage(env, p, page) {
    const d = await getJson(this.query(p, page));
    // Brreg matches secondary activity codes too; keep companies whose main activity is the industry.
    const units = (d?._embedded?.enheter || []).filter((e) => p.codes.includes(e.naeringskode1?.kode));
    // 2 extra calls per company (roles, accounts) → 15 × 2 + 1 = 31 subrequests per step.
    return Promise.all(units.map(async (e) => {
      const [roles, accounts] = await Promise.all([
        getJson(`https://data.brreg.no/enhetsregisteret/api/enheter/${e.organisasjonsnummer}/roller`).catch(() => null),
        getJson(`https://data.brreg.no/regnskapsregisteret/regnskap/${e.organisasjonsnummer}`).catch(() => null),
      ]);
      return this.normalize(e, roles, accounts);
    }));
  },
  normalize(e, roles, accounts) {
    const a = e.forretningsadresse || e.postadresse || {};
    const people = [];
    for (const g of roles?.rollegrupper || []) for (const r of g.roller || []) {
      if (!r.person || r.avregistrert || r.person.erDoed) continue;
      const n = r.person.navn || {};
      const [y, m] = (r.person.fodselsdato || "").split("-").map(Number);
      people.push({ name: [n.fornavn, n.etternavn].filter(Boolean).join(" "), role: r.type?.beskrivelse, birthYear: y || null, birthMonth: m || null });
    }
    const unique = [...new Map(people.map((p) => [`${p.name}|${p.birthYear}`, p])).values()]
      .sort((x, y) => /daglig leder|innehaver/i.test(y.role) - /daglig leder|innehaver/i.test(x.role));
    const acc = Array.isArray(accounts) ? accounts.sort((x, y) => (y.regnskapsperiode?.tilDato || "").localeCompare(x.regnskapsperiode?.tilDato || ""))[0] : null;
    const revenue = acc?.resultatregnskapResultat?.driftsresultat?.driftsinntekter?.sumDriftsinntekter ?? null;
    return {
      source: "no_brreg",
      sourceId: e.organisasjonsnummer,
      country: "no",
      name: title(e.navn),
      legalForm: NO_FORMS[e.organisasjonsform?.kode] || e.organisasjonsform?.beskrivelse,
      industryCode: e.naeringskode1?.kode,
      address: [...(a.adresse || []), [a.postnummer, a.poststed].filter(Boolean).join(" ")].filter(Boolean).join(", "),
      city: title(a.poststed || a.kommune),
      region: (a.kommunenummer || "").slice(0, 2),
      postcode: a.postnummer,
      founded: year(e.stiftelsesdato || e.registreringsdatoEnhetsregisteret),
      employees: e.harRegistrertAntallAnsatte ? e.antallAnsatte ?? 0 : null,
      employeesMin: e.harRegistrertAntallAnsatte ? e.antallAnsatte ?? 0 : null,
      employeesBand: e.harRegistrertAntallAnsatte ? String(e.antallAnsatte ?? 0) : null,
      revenue: revenue && revenue > 0 ? revenue : null,
      revenueYear: year(acc?.regnskapsperiode?.tilDato),
      currency: "NOK",
      website: e.hjemmeside ? (e.hjemmeside.startsWith("http") ? e.hjemmeside : `https://${e.hjemmeside}`) : null,
      people: unique,
      registryUrl: `https://virksomhet.brreg.no/nb/oppslag/enheter/${e.organisasjonsnummer}`,
      excluded: false,
    };
  },
};

// --------------------------------------------------------------------------------------------
// United Kingdom — Companies House (free API key: COMPANIES_HOUSE_API_KEY). 600 requests / 5 min.
// --------------------------------------------------------------------------------------------
const UK_ACCOUNTS = {
  "micro-entity": [1, "<10 (micro accounts)"],
  small: [10, "10–49 (small accounts)"], "total-exemption-small": [10, "10–49 (small accounts)"], "total-exemption-full": [10, "10–49 (small accounts)"], "audit-exemption-subsidiary": [10, "10–49 (small accounts)"], unaudited_abridged: [10, "10–49 (small accounts)"],
  medium: [50, "50–249 (medium accounts)"], full: [50, "50+ (full accounts)"], group: [50, "50+ (group accounts)"],
};
const uk = {
  id: "uk",
  label: "United Kingdom",
  flag: "🇬🇧",
  currency: "GBP",
  needsKey: "COMPANIES_HOUSE_API_KEY",
  keyHelp: "Free: developer.company-information.service.gov.uk → Create an application → REST API key",
  regionLabel: "Town or city",
  regions: "text",
  publishes: ["Director birth month/year", "Size class from filed accounts", "Incorporation date"],
  pageSize: 15,
  pagesPerStep: 1,
  auth(env) { return { Authorization: `Basic ${btoa(`${env.COMPANIES_HOUSE_API_KEY}:`)}` }; },
  query(p, page) {
    const u = new URL("https://api.company-information.service.gov.uk/advanced-search/companies");
    u.searchParams.set("sic_codes", p.codes.join(","));
    if (p.region) u.searchParams.set("location", p.region);
    u.searchParams.set("company_status", "active");
    u.searchParams.set("size", String(this.pageSize));
    u.searchParams.set("start_index", String((page - 1) * this.pageSize));
    return u.toString();
  },
  async plan(env, p) {
    const d = await getJson(this.query(p, 1), { headers: this.auth(env) });
    const total = d?.hits || 0;
    return { total, pages: Math.min(Math.ceil(total / this.pageSize), Math.floor(5000 / this.pageSize)) };
  },
  async fetchPage(env, p, page) {
    const d = await getJson(this.query(p, page), { headers: this.auth(env) });
    const out = [];
    for (const c of d?.items || []) {
      const [officers, profile] = await Promise.all([
        getJson(`https://api.company-information.service.gov.uk/company/${c.company_number}/officers?items_per_page=35`, { headers: this.auth(env) }).catch(() => null),
        getJson(`https://api.company-information.service.gov.uk/company/${c.company_number}`, { headers: this.auth(env) }).catch(() => null),
      ]);
      out.push(this.normalize(c, officers, profile));
      await sleep(250); // stay inside 600 requests / 5 minutes
    }
    return out;
  },
  normalize(c, officers, profile) {
    const a = c.registered_office_address || {};
    const acct = UK_ACCOUNTS[profile?.accounts?.last_accounts?.type];
    const people = (officers?.items || []).filter((o) => !o.resigned_on && o.date_of_birth).map((o) => {
      const [last, first = ""] = o.name.split(",");
      return { name: title(`${first.trim().split(" ")[0]} ${last.trim()}`), role: o.officer_role, birthYear: o.date_of_birth.year, birthMonth: o.date_of_birth.month };
    });
    return {
      source: "uk_ch",
      sourceId: c.company_number,
      country: "uk",
      name: title(c.company_name),
      legalForm: c.company_type?.toUpperCase(),
      industryCode: (c.sic_codes || []).join(", "),
      address: [a.address_line_1, a.locality, a.postal_code].filter(Boolean).join(", "),
      city: title(a.locality),
      region: a.region || a.locality,
      postcode: a.postal_code,
      founded: year(c.date_of_creation),
      employeesMin: acct ? acct[0] : null,
      employeesBand: acct ? acct[1] : null,
      currency: "GBP",
      people,
      registryUrl: `https://find-and-update.company-information.service.gov.uk/company/${c.company_number}`,
      excluded: profile?.accounts?.last_accounts?.type === "dormant",
    };
  },
};

// --------------------------------------------------------------------------------------------
// Anywhere — Google Places (New) Text Search (GOOGLE_PLACES_API_KEY). Max 60 results per query, so
// a region is split into the area the user types (e.g. "Austin, TX"). No owner data: size only.
// --------------------------------------------------------------------------------------------
const places = {
  id: "us",
  label: "United States (Google Places)",
  flag: "🇺🇸",
  currency: "USD",
  needsKey: "GOOGLE_PLACES_API_KEY",
  keyHelp: "Google Cloud console → enable “Places API (New)” → Credentials → API key",
  regionLabel: "City or area",
  regions: "text",
  publishes: ["Phone & website", "Google rating & review count", "No owner age (add Texas license data or enrich)"],
  pageSize: 20,
  pagesPerStep: 1,
  async plan() { return { total: null, pages: 3 }; },
  async fetchPage(env, p, page, state) {
    if (page > 1 && !state?.nextPageToken) return [];
    const body = { textQuery: `${p.industry.places} in ${p.region || "United States"}`, pageSize: 20 };
    if (state?.nextPageToken) body.pageToken = state.nextPageToken;
    const d = await getJson("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": "nextPageToken,places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.businessStatus",
      },
      body: JSON.stringify(body),
    });
    if (state) state.nextPageToken = d?.nextPageToken || null;
    return (d?.places || []).map((x) => {
      const comp = (t) => x.addressComponents?.find((c) => c.types?.includes(t))?.longText;
      return {
        source: "places",
        sourceId: x.id,
        country: "us",
        name: x.displayName?.text,
        address: x.formattedAddress,
        city: comp("locality"),
        region: comp("administrative_area_level_1"),
        postcode: comp("postal_code"),
        lat: x.location?.latitude, lng: x.location?.longitude,
        phone: x.nationalPhoneNumber || null,
        website: x.websiteUri || null,
        rating: x.rating ?? null,
        reviews: x.userRatingCount ?? 0,
        currency: "USD",
        people: [],
        registryUrl: `https://www.google.com/maps/place/?q=place_id:${x.id}`,
        excluded: x.businessStatus === "CLOSED_PERMANENTLY",
      };
    });
  },
};

export const PROVIDERS = { fr: france, no: norway, uk, us: places };

export function providerInfo(env) {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id, label: p.label, flag: p.flag, regionLabel: p.regionLabel,
    regions: p.regions, publishes: p.publishes,
    ready: !p.needsKey || Boolean(env[p.needsKey]),
    needsKey: p.needsKey || null, keyHelp: p.keyHelp || null,
  }));
}

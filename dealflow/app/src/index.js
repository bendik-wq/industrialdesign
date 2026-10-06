// Dealflow API + app server.
//   Browser: sign in at /login (session cookie).   Scripts: Authorization: Bearer <API_TOKEN>.
//   GET /api lists every endpoint.
import { PROVIDERS, providerInfo } from "./providers.js";
import { INDUSTRIES, industryById } from "./data/industries.js";
import { brief, letter } from "./ai.js";
import { lookup, publicView, captureLead } from "./seller.js";
import { saveCompanies } from "./store.js";
import { handleMcp } from "./mcp.js";
import { recommend, structure, STRUCTURES } from "../public/deal.js";
export { SearchWorkflow } from "./workflow.js";

const STATUSES = ["New", "Researching", "Contacted", "Conversation", "NDA signed", "Financials", "LOI", "Passed", "Not a fit"];
const SESSION_DAYS = 30;
const PUBLIC_PATHS = new Set([
  "/login", "/login.html", "/login.js", "/style.css",
  "/value", "/value.html", "/value.js", "/value.css", "/deal.js",
  "/api/login", "/api/public/valuation", "/api/public/lead",
]);

const API_DOCS = {
  auth: "Session cookie from POST /api/login, or header Authorization: Bearer <API_TOKEN>",
  endpoints: [
    "GET    /api/sources                      countries (with readiness), regions, industries",
    "GET    /api/searches                     your searches with progress",
    "POST   /api/searches                     {country, industry, region?, minStaff?} → starts a background search",
    "GET    /api/searches/:id                 one search",
    "DELETE /api/searches/:id                 remove a search and companies nothing else uses",
    "POST   /api/searches/:id/retry           re-run a failed search (already-saved companies are updated, not duplicated)",
    "GET    /api/companies                    ?search=&country=&q=&verdict=&minFit=&minOwnerAge=&minStaff=&status=&sort=fit|size|succession|owner_age|founded|staff|name&page=&limit=",
    "GET    /api/companies/:id                full record: people, signals, pipeline",
    "PUT    /api/companies/:id/pipeline       {status?, notes?}",
    "GET    /api/pipeline                     every company you are working, by stage",
    "GET    /api/stats                        ?search= counts by verdict",
    "GET    /api/export.csv                   same filters as /api/companies, &format=full|mail|email",
    "GET    /api/companies/:id/deal           ?price= valuation range + three seller-finance structures with DSCR",
    "POST   /api/companies/:id/ai             {kind: brief|letter, regenerate?, me?} AI brief or owner letter (cached)",
    "POST   /api/companies/add                {country: fr|no, number} add one company by registry number",
    "GET    /api/leads                        inbound sellers from the public valuation page",
    "POST   /mcp                              MCP server (Streamable HTTP) for Claude and other agents; Bearer API_TOKEN",
    "PUBLIC /value                            seller-facing 'What is my business worth?' page",
  ],
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/login" && request.method === "POST") return login(request, env);
      if (url.pathname === "/api/logout" && request.method === "POST") return logout();
      if (!PUBLIC_PATHS.has(url.pathname) && !(await authorized(request, env))) {
        return url.pathname.startsWith("/api/") || url.pathname === "/mcp" ? json({ error: "Not signed in" }, 401) : Response.redirect(`${url.origin}/login`, 302);
      }
      if (url.pathname === "/mcp") return handleMcp(request, mcpOps(env));
      if (url.pathname.startsWith("/api/public/")) return await publicRoute(request, env, url);
      if (!url.pathname.startsWith("/api")) return env.ASSETS.fetch(request);
      return await route(request, env, url);
    } catch (err) {
      console.error(err);
      if (/D1_ERROR: .*(limit|exceeded)/i.test(err?.message || "")) {
        return json({ error: "The database's free daily write allowance is used up. Saving resumes at midnight UTC, or immediately on the Workers Paid plan." }, 503);
      }
      return json({ error: err.status ? err.message : "Internal error" }, err.status || 500);
    }
  },
};

// ------------------------------------------------------------------ auth
async function hmac(env, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`session:${env.DASHBOARD_PASSWORD}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
}
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
async function authorized(request, env) {
  if (!env.DASHBOARD_PASSWORD) return false;
  const bearer = (request.headers.get("Authorization") || "").match(/^Bearer (.+)$/)?.[1];
  if (bearer && env.API_TOKEN && safeEqual(bearer, env.API_TOKEN)) return true;
  const cookie = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)df_session=([^;]+)/)?.[1];
  if (!cookie) return false;
  const [exp, sig] = cookie.split(".");
  return Number(exp) > Date.now() && safeEqual(sig || "", await hmac(env, exp));
}
async function login(request, env) {
  const { password = "" } = await request.json().catch(() => ({}));
  if (!env.DASHBOARD_PASSWORD || !safeEqual(password, env.DASHBOARD_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 600));
    return json({ error: "Wrong password" }, 401);
  }
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return json({ ok: true }, 200, {
    "Set-Cookie": `df_session=${exp}.${await hmac(env, exp)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
  });
}
function logout() {
  return json({ ok: true }, 200, { "Set-Cookie": "df_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
}

// ------------------------------------------------------------------ routing
async function route(request, env, url) {
  const p = url.pathname, m = request.method;
  if (p === "/api" || p === "/api/") return json(API_DOCS);
  if (p === "/api/sources" && m === "GET") return json({ countries: providerInfo(env), industries: INDUSTRIES.map(({ id, label, ...codes }) => ({ id, label, countries: Object.keys(codes).filter((k) => k !== "places" && codes[k].length).concat("us") })), statuses: STATUSES });
  if (p === "/api/searches" && m === "GET") return json(await listSearches(env));
  if (p === "/api/searches" && m === "POST") return json(await createSearch(env, await request.json().catch(() => ({}))), 201);
  if (p === "/api/leads" && m === "GET") return json((await env.DB.prepare("SELECT l.*, c.name AS company FROM leads l LEFT JOIN companies c ON c.id = l.company_id ORDER BY l.id DESC").all()).results);
  if (p === "/api/companies/add" && m === "POST") return json(await addCompany(env, await request.json().catch(() => ({}))), 201);
  if (p === "/api/companies" && m === "GET") return json(await listCompanies(env, url.searchParams));
  if (p === "/api/pipeline" && m === "GET") return json(await pipeline(env));
  if (p === "/api/stats" && m === "GET") return json(await stats(env, url.searchParams));
  if (p === "/api/export.csv" && m === "GET") return exportCsv(env, url.searchParams);
  let r;
  if ((r = p.match(/^\/api\/searches\/(\d+)$/))) {
    if (m === "GET") return json(await env.DB.prepare("SELECT * FROM searches WHERE id = ?1").bind(+r[1]).first() ?? fail(404, "Search not found"));
    if (m === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM search_results WHERE search_id = ?1").bind(+r[1]),
        env.DB.prepare("DELETE FROM searches WHERE id = ?1").bind(+r[1]),
        // Drop companies no other search or pipeline entry refers to.
        env.DB.prepare(`DELETE FROM companies WHERE id NOT IN (SELECT company_id FROM search_results) AND id NOT IN (SELECT company_id FROM pipeline)`),
      ]);
      return json({ ok: true });
    }
  }
  if ((r = p.match(/^\/api\/searches\/(\d+)\/retry$/)) && m === "POST") {
    const row = await env.DB.prepare("UPDATE searches SET status = 'queued', error = NULL WHERE id = ?1 AND status IN ('failed', 'done') AND country != 'all' RETURNING *").bind(+r[1]).first();
    if (!row) fail(400, "This search can't be re-run right now");
    await env.SEARCH.create({ id: `search-${row.id}-${Date.now()}`, params: { searchId: row.id } });
    return json(row);
  }
  if ((r = p.match(/^\/api\/companies\/(\d+)$/)) && m === "GET") return json(await company(env, +r[1]));
  if ((r = p.match(/^\/api\/companies\/(\d+)\/deal$/)) && m === "GET") return json(await deal(env, +r[1], url.searchParams.get("price")));
  if ((r = p.match(/^\/api\/companies\/(\d+)\/ai$/)) && m === "POST") return json(await ai(env, +r[1], await request.json().catch(() => ({}))));
  if ((r = p.match(/^\/api\/companies\/(\d+)\/pipeline$/)) && m === "PUT") return json(await savePipeline(env, +r[1], await request.json().catch(() => ({}))));
  return json({ error: "Not found" }, 404);
}
function fail(status, message) { throw Object.assign(new Error(message), { status }); }

// ------------------------------------------------------------------ searches
async function createSearch(env, body) {
  const provider = PROVIDERS[body.country];
  const industry = industryById(body.industry);
  if (!provider) fail(400, "Unknown country");
  if (!industry) fail(400, "Unknown industry");
  if (provider.needsKey && !env[provider.needsKey]) fail(400, `${provider.label} needs ${provider.needsKey}. ${provider.keyHelp}`);
  if (provider.id !== "us" && !(industry[provider.id] || []).length) fail(400, `${industry.label} has no official code in ${provider.label} yet`);
  let region = String(body.region || "").trim().slice(0, 80) || null;
  let regionLabel = region;
  if (Array.isArray(provider.regions) && region) {
    const match = provider.regions.find((x) => x.code === region);
    if (!match) fail(400, "Unknown region");
    regionLabel = match.name.replace(/^\d+[AB]? · /, "");
  }
  if (provider.id === "us" && !region) fail(400, "Type a city or area, e.g. “Austin, TX”");
  const minStaff = Math.max(0, Math.min(500, Number(body.minStaff) || 0));
  const label = `${industry.label} · ${regionLabel || `all of ${provider.label}`}${minStaff ? ` · ${minStaff}+ staff` : ""}`;
  const row = await env.DB.prepare(
    `INSERT INTO searches (country, industry, region, region_label, min_staff, label, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7) RETURNING *`
  ).bind(provider.id, industry.id, region, regionLabel, minStaff, label, new Date().toISOString()).first();
  await env.SEARCH.create({ id: `search-${row.id}-${Date.now()}`, params: { searchId: row.id } });
  return row;
}

// ------------------------------------------------------------------ deals, AI, single-company add
async function deal(env, id, price) {
  const c = await company(env, id);
  const r = recommend(c, price ? Number(price) : undefined);
  if (!r) return { company: c.name, currency: c.currency, available: false, reason: "Not enough published financials to value this company" };
  return { company: c.name, currency: c.currency, available: true, ...r };
}

async function ai(env, id, body) {
  const kind = body.kind === "letter" ? "letter" : "brief";
  if (!body.regenerate) {
    const cached = await env.DB.prepare("SELECT * FROM ai_outputs WHERE company_id = ?1 AND kind = ?2").bind(id, kind).first();
    if (cached) return cached;
  }
  const c = await company(env, id);
  const out = kind === "brief" ? await brief(env, c) : await letter(env, c, body.me || {});
  const row = { company_id: id, kind, model: out.model, content: out.text, created_at: new Date().toISOString() };
  await env.DB.prepare(
    `INSERT INTO ai_outputs (company_id, kind, model, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (company_id, kind) DO UPDATE SET model = ?3, content = ?4, created_at = ?5`
  ).bind(id, kind, row.model, row.content, row.created_at).run();
  return row;
}

async function addCompany(env, body) {
  const c = await lookup(body.country, body.number);
  let search = await env.DB.prepare("SELECT id FROM searches WHERE label = 'Added by hand'").first();
  if (!search) {
    search = await env.DB.prepare(
      `INSERT INTO searches (country, industry, label, status, total, found, pages, pages_done, created_at, finished_at)
       VALUES ('all', 'all', 'Added by hand', 'done', 0, 0, 1, 1, ?1, ?1) RETURNING id`
    ).bind(new Date().toISOString()).first();
  }
  await saveCompanies(env.DB, search.id, [c], c.industry);
  await env.DB.prepare("UPDATE searches SET found = (SELECT COUNT(*) FROM search_results WHERE search_id = ?1) WHERE id = ?1").bind(search.id).run();
  const row = await env.DB.prepare("SELECT id FROM companies WHERE source = ?1 AND source_id = ?2").bind(c.source, String(c.sourceId)).first();
  return company(env, row.id);
}

// ------------------------------------------------------------------ public seller page
async function publicRoute(request, env, url) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  if (url.pathname === "/api/public/valuation") return json(publicView(await lookup(body.country, body.number)));
  if (url.pathname === "/api/public/lead") {
    if (body.website) return json({ ok: true }); // honeypot: bots fill every field
    const name = String(body.name || "").trim().slice(0, 120), email = String(body.email || "").trim().slice(0, 200);
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, "Please give your name and a valid email");
    const c = await lookup(body.country, body.number);
    await captureLead(env, c, {
      name, email,
      phone: String(body.phone || "").slice(0, 40),
      timeline: String(body.timeline || "").slice(0, 60),
      message: String(body.message || "").slice(0, 2000),
    });
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}

// ------------------------------------------------------------------ MCP tool implementations
function mcpOps(env) {
  const slim = (r) => ({
    id: r.id, name: r.name, country: r.country, city: r.city, owner: r.owner_name, owner_age: r.owner_age, founded: r.founded,
    staff: r.employees_band, revenue: r.revenue, valuation_mid: r.valuation_mid, currency: r.currency,
    fit: r.fit_score, verdict: r.verdict, summary: r.summary, status: r.status,
  });
  return {
    list_sources: async () => ({
      countries: providerInfo(env).map(({ regions, ...c }) => ({ ...c, regions: Array.isArray(regions) ? regions : "free text" })),
      industries: INDUSTRIES.map(({ id, label }) => ({ id, label })),
    }),
    start_search: (a) => createSearch(env, a),
    list_searches: async () => (await listSearches(env)).map(({ id, label, status, pages_done, pages, found, strong, error }) => ({ id, label, status, progress: pages ? `${pages_done}/${pages}` : null, found, worth_a_call: strong, error })),
    find_targets: async (a) => {
      const q = new URLSearchParams();
      for (const k of ["search", "country", "q", "minOwnerAge", "minStaff", "minFit", "sort"]) if (a[k] != null) q.set(k, String(a[k]));
      q.set("limit", String(a.limit || 25));
      const d = await listCompanies(env, q);
      return { total: d.total, targets: d.rows.map(slim) };
    },
    get_company: async ({ id }) => {
      const c = await company(env, id);
      const { signals, people, notes, ...rest } = c;
      return { ...rest, people, notes, why: signals.map((s) => `${s.pts > 0 ? "+" : ""}${s.pts} ${s.label}: ${s.detail}`) };
    },
    value_deal: async ({ id, price }) => {
      const d = await deal(env, id, price);
      if (!d.available) return d;
      const m = (v) => Math.round(v);
      return {
        company: d.company, currency: d.currency,
        valuation: { basis: d.valuation.basis, confidence: d.valuation.confidence, ebitda: m(d.valuation.ebitda), multiple: d.valuation.multiple, equity_low: m(d.valuation.equity[0]), equity_mid: m(d.valuation.equity[1]), equity_high: m(d.valuation.equity[2]) },
        price_tested: m(d.price),
        recommended: d.best.label,
        structures: d.structures.map((s) => ({ name: s.label, how: s.blurb, min_dscr: s.minDscr && +s.minDscr.toFixed(2), bankable_at_1_5x: s.bankable, max_price_at_1_5x: s.maxPriceAt15 && m(s.maxPriceAt15), debt_service_by_year: s.debtService.map(m) })),
      };
    },
    update_pipeline: ({ id, ...rest }) => savePipeline(env, id, rest),
    write_brief: async ({ id }) => (await ai(env, id, { kind: "brief" })).content,
    add_company: async ({ country, number }) => slim(await addCompany(env, { country, number })),
  };
}

async function listSearches(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM search_results r JOIN companies c ON c.id = r.company_id
       WHERE r.search_id = s.id AND c.excluded = 0 AND c.fit_score >= 50) AS strong
     FROM searches s ORDER BY s.id DESC`
  ).all();
  return results;
}

// ------------------------------------------------------------------ companies
const SORTS = {
  fit: "c.fit_score DESC", size: "c.size_score DESC", succession: "c.succession_score DESC",
  owner_age: "c.owner_age IS NULL, c.owner_age DESC", founded: "c.founded IS NULL, c.founded ASC",
  value: "c.valuation_mid IS NULL, c.valuation_mid DESC",
  staff: "c.employees_min IS NULL, c.employees_min DESC", name: "c.name ASC",
};
function filters(q) {
  const where = [], binds = [];
  const bind = (v) => { binds.push(v); return `?${binds.length}`; };
  let from = "companies c";
  if (q.get("search")) from += ` JOIN search_results sr ON sr.company_id = c.id AND sr.search_id = ${bind(+q.get("search"))}`;
  from += " LEFT JOIN pipeline p ON p.company_id = c.id";
  if (q.get("excluded") !== "1") where.push("c.excluded = 0");
  if (q.get("country")) where.push(`c.country = ${bind(q.get("country"))}`);
  if (q.get("q")) { const b = bind(`%${q.get("q").trim()}%`); where.push(`(c.name LIKE ${b} OR c.city LIKE ${b} OR c.owner_name LIKE ${b} OR c.postcode LIKE ${b})`); }
  const verdicts = q.getAll("verdict").filter(Boolean);
  if (verdicts.length) where.push(`c.verdict IN (${verdicts.map(bind).join(",")})`);
  for (const [k, col] of [["minFit", "c.fit_score"], ["minOwnerAge", "c.owner_age"], ["minStaff", "c.employees_min"]]) {
    if (Number(q.get(k)) > 0) where.push(`${col} >= ${bind(Number(q.get(k)))}`);
  }
  if (q.get("ownerKnown") === "1") where.push("c.owner_age IS NOT NULL");
  if (q.get("valued") === "1") where.push("c.valuation_mid IS NOT NULL");
  const status = q.get("status");
  if (status === "Any") where.push("p.status IS NOT NULL AND p.status != 'New'");
  else if (STATUSES.includes(status)) where.push(status === "New" ? "(p.status IS NULL OR p.status = 'New')" : `p.status = ${bind(status)}`);
  return { from, where: where.length ? `WHERE ${where.join(" AND ")}` : "", binds, order: `ORDER BY ${SORTS[q.get("sort")] || SORTS.fit}, c.fit_score DESC, c.id` };
}
const LIST = `c.id, c.country, c.name, c.legal_form, c.city, c.region, c.founded, c.employees_min, c.employees_band, c.revenue, c.currency,
  c.owner_name, c.owner_age, c.size_score, c.succession_score, c.fit_score, c.verdict, c.summary, c.reviews, c.rating,
  c.valuation_mid, c.inbound,
  COALESCE(p.status, 'New') AS status`;

async function listCompanies(env, q) {
  const f = filters(q);
  const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 50));
  const page = Math.max(1, Number(q.get("page")) || 1);
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(`SELECT ${LIST} FROM ${f.from} ${f.where} ${f.order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`).bind(...f.binds),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM ${f.from} ${f.where}`).bind(...f.binds),
  ]);
  return { total: total.results[0].n, page, limit, rows: rows.results };
}

async function company(env, id) {
  const c = await env.DB.prepare(
    `SELECT c.*, COALESCE(p.status, 'New') AS status, COALESCE(p.notes, '') AS notes, p.updated_at AS pipeline_updated
     FROM companies c LEFT JOIN pipeline p ON p.company_id = c.id WHERE c.id = ?1`
  ).bind(id).first();
  if (!c) fail(404, "Company not found");
  c.people = JSON.parse(c.people || "[]");
  c.signals = JSON.parse(c.signals || "[]");
  const { results } = await env.DB.prepare("SELECT kind, model, content, created_at FROM ai_outputs WHERE company_id = ?1").bind(id).all();
  c.ai = Object.fromEntries(results.map((r) => [r.kind, r]));
  return c;
}

async function savePipeline(env, id, body) {
  if (body.status != null && !STATUSES.includes(body.status)) fail(400, "Invalid status");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO pipeline (company_id, status, notes, updated_at) VALUES (?1, COALESCE(?2, 'New'), COALESCE(?3, ''), ?4)
     ON CONFLICT (company_id) DO UPDATE SET status = COALESCE(?2, status), notes = COALESCE(?3, notes), updated_at = ?4`
  ).bind(id, body.status ?? null, typeof body.notes === "string" ? body.notes.slice(0, 20000) : null, now).run();
  return { ok: true, updated_at: now };
}

async function pipeline(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${LIST}, p.notes, p.updated_at FROM pipeline p JOIN companies c ON c.id = p.company_id
     WHERE p.status != 'New' ORDER BY p.updated_at DESC`
  ).all();
  return { statuses: STATUSES, rows: results };
}

async function stats(env, q) {
  const f = filters(new URLSearchParams(q.get("search") ? { search: q.get("search") } : {}));
  const { results } = await env.DB.prepare(
    `SELECT c.verdict, COUNT(*) AS n, SUM(c.owner_age >= 60) AS owner60 FROM ${f.from} ${f.where} GROUP BY c.verdict`
  ).bind(...f.binds).all();
  return results;
}

// ------------------------------------------------------------------ export
const CSV = {
  full: [["Company", "name"], ["Country", "country"], ["Verdict", "verdict"], ["Fit", "fit_score"], ["Succession", "succession_score"], ["Size", "size_score"],
    ["Owner", "owner_name"], ["Owner age", "owner_age"], ["Founded", "founded"], ["Staff", "employees_band"], ["Revenue", "revenue"], ["Currency", "currency"],
    ["Address", "address"], ["City", "city"], ["Postcode", "postcode"], ["Phone", "phone"], ["Website", "website"], ["Email", "email"],
    ["Legal form", "legal_form"], ["Registry", "registry_url"], ["Status", "status"], ["Summary", "summary"]],
  mail: [["name", "owner_name"], ["company", "name"], ["address", "address"], ["city", "city"], ["postcode", "postcode"], ["country", (r) => r.country.toUpperCase()]],
  email: [["email", "email"], ["first_name", (r) => (r.owner_name || "").split(" ")[0]], ["last_name", (r) => (r.owner_name || "").split(" ").slice(1).join(" ")],
    ["company_name", "name"], ["city", "city"], ["founded", "founded"], ["owner_age", "owner_age"]],
};
async function exportCsv(env, q) {
  const format = CSV[q.get("format")] ? q.get("format") : "full";
  const f = filters(q);
  const extra = { mail: "c.address IS NOT NULL AND c.owner_name IS NOT NULL", email: "c.email IS NOT NULL" }[format];
  const where = extra ? (f.where ? `${f.where} AND ${extra}` : `WHERE ${extra}`) : f.where;
  const { results } = await env.DB.prepare(`SELECT c.*, COALESCE(p.status, 'New') AS status FROM ${f.from} ${where} ${f.order} LIMIT 10000`).bind(...f.binds).all();
  const cell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols = CSV[format];
  const body = [cols.map(([h]) => h).join(","), ...results.map((r) => cols.map(([, k]) => cell(typeof k === "function" ? k(r) : r[k])).join(","))].join("\n");
  return new Response(body + "\n", { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="dealflow-${format}.csv"` } });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

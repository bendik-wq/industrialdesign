// Densification map: your sites and their service radius, where the pipeline's targets are, and where the next deal
// should go to build a local monopoly. The maths lives in public/js/territory.js (shared with the browser).
//
// Geocoding: OpenStreetMap's Nominatim, cached in geocode_cache for every workspace (public geography only: the
// query is a place name or address, never who asked). Nominatim allows about one request a second, so lookups are
// rate-limited per workspace and across the whole platform, and pipeline targets are geocoded a few at a time.
import { json, now } from "./http.js";
import { safeFetch } from "./net.js";
import { plan, tilesFor, preparePlaces } from "../public/js/territory.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => String(v ?? "").trim().slice(0, max);
const MAX_SITES = 200;
const DEFAULT_RADIUS = 25;
const radius = (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 1 || n > 300) throw err(400, "Service radius is 1 to 300 km"); return Math.round(n * 10) / 10; };
const coord = (lat, lng) => {
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 85 || Math.abs(b) > 180) throw err(400, "That isn't a place on the map");
  return [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5];
};
const normQ = (q) => text(q, 200).toLowerCase().replace(/\s+/g, " ");

// ------------------------------------------------------------------ geocoding
const PER_ACCOUNT_MIN = 20, PER_ACCOUNT_DAY = 400, PLATFORM_MIN = 50;
async function allowGeocode(env, accountId) {
  const t = Date.now(), min = new Date(t - 60_000).toISOString(), day = new Date(t - 864e5).toISOString();
  const r = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM geocode_log WHERE at > ?2) AS all_min,
      (SELECT COUNT(*) FROM geocode_log WHERE account_id = ?1 AND at > ?2) AS mine_min,
      (SELECT COUNT(*) FROM geocode_log WHERE account_id = ?1 AND at > ?3) AS mine_day`).bind(accountId, min, day).first();
  if (r.all_min >= PLATFORM_MIN || r.mine_min >= PER_ACCOUNT_MIN) throw err(429, "The map lookup is busy. Try again in a minute.");
  if (r.mine_day >= PER_ACCOUNT_DAY) throw err(429, "That's today's limit of place lookups. Click the map to place a site instead.");
  await env.DB.prepare("INSERT INTO geocode_log (account_id, at) VALUES (?1, ?2)").bind(accountId, now()).run();
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM geocode_log WHERE at < ?1").bind(day).run();
}

export async function geocode(env, ctx, q, { limit = 5, key: exact = null } = {}) {
  // exact: the cache key a pipeline location is looked up by (lower(trim(location)) in SQL).
  const key = exact ?? normQ(q);
  if (key.length < 2) return [];
  const hit = await env.DB.prepare("SELECT results, at FROM geocode_cache WHERE q = ?1").bind(key).first();
  if (hit && (JSON.parse(hit.results).length || Date.now() - Date.parse(hit.at) < 30 * 864e5)) return JSON.parse(hit.results).slice(0, limit);
  await allowGeocode(env, ctx.accountId);
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=0&q=${encodeURIComponent(key)}`;
  const res = await safeFetch(url, { headers: { "User-Agent": "Warplan/1.0 (territory map; https://warplan.bendik-50e.workers.dev)", "Accept-Language": "en" } }, { httpsOnly: true, hops: 0 });
  if (!res.ok) throw err(502, "The map lookup didn't answer. Try again, or click the map to place it.");
  const rows = await res.json().catch(() => []);
  const results = (Array.isArray(rows) ? rows : []).slice(0, 5).map((r) => ({ label: text(r.display_name, 200), lat: +(+r.lat).toFixed(5), lng: +(+r.lon).toFixed(5) })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  await env.DB.prepare("INSERT INTO geocode_cache (q, results, at) VALUES (?1, ?2, ?3) ON CONFLICT (q) DO UPDATE SET results = excluded.results, at = excluded.at").bind(key, JSON.stringify(results), now()).run();
  return results.slice(0, limit);
}

// Geocode a few more pipeline locations (Nominatim: about one a second). The map calls this until pending is 0.
export async function geocodeTargets(env, ctx) {
  const { results } = await env.DB.prepare(`SELECT DISTINCT lower(trim(t.location)) AS q FROM targets t
    LEFT JOIN geocode_cache g ON g.q = lower(trim(t.location))
    WHERE t.account_id = ?1 AND t.stage != 'lost' AND length(trim(t.location)) > 1 AND g.q IS NULL LIMIT 4`).bind(ctx.accountId).all();
  let done = 0;
  for (const [i, r] of results.entries()) {
    if (i) await new Promise((ok) => setTimeout(ok, 1100));
    try { await geocode(env, ctx, r.q, { limit: 1, key: r.q }); done++; } catch (e) { if (e.status === 429) break; }
  }
  return { done, pending: await pendingCount(env, ctx) };
}
async function pendingCount(env, ctx) {
  return (await env.DB.prepare(`SELECT COUNT(DISTINCT lower(trim(t.location))) AS n FROM targets t LEFT JOIN geocode_cache g ON g.q = lower(trim(t.location))
    WHERE t.account_id = ?1 AND t.stage != 'lost' AND length(trim(t.location)) > 1 AND g.q IS NULL`).bind(ctx.accountId).first()).n;
}

// ------------------------------------------------------------------ sites
const siteOut = (r) => ({ id: r.id, name: r.name, address: r.address, lat: r.lat, lng: r.lng, radius_km: r.radius_km, target_id: r.target_id });

export async function createSite(env, ctx, b) {
  const name = text(b.name, 120), address = text(b.address, 300);
  let lat = b.lat, lng = b.lng;
  if ((lat == null || lng == null) && address) {
    const [hit] = await geocode(env, ctx, address, { limit: 1 });
    if (!hit) throw err(400, "Couldn't find that address. Try a suburb and city, or click the map.");
    ({ lat, lng } = hit);
  }
  [lat, lng] = coord(lat, lng);
  if (!name) throw err(400, "Give the site a name");
  const r = b.radius_km == null ? (await prefs(env, ctx)).radius_km : radius(b.radius_km);
  let targetId = null;
  if (b.target_id != null) {
    const t = await env.DB.prepare("SELECT id FROM targets WHERE id = ?1 AND account_id = ?2").bind(+b.target_id, ctx.accountId).first();
    if (!t) throw err(400, "That target isn't in your pipeline");
    targetId = t.id;
  }
  const stamp = now();
  const row = await env.DB.prepare(`INSERT INTO territory_sites (account_id, target_id, name, address, lat, lng, radius_km, created_at, updated_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8 WHERE (SELECT COUNT(*) FROM territory_sites WHERE account_id = ?1) < ?9 RETURNING *`)
    .bind(ctx.accountId, targetId, name, address, lat, lng, r, stamp, MAX_SITES).first();
  if (!row) throw err(400, `That's ${MAX_SITES} sites; remove some first`);
  return siteOut(row);
}

export async function updateSite(env, ctx, id, b) {
  const cur = await env.DB.prepare("SELECT * FROM territory_sites WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId).first();
  if (!cur) throw err(404, "Site not found");
  const name = "name" in b ? text(b.name, 120) : cur.name;
  if (!name) throw err(400, "Give the site a name");
  const [lat, lng] = "lat" in b || "lng" in b ? coord(b.lat ?? cur.lat, b.lng ?? cur.lng) : [cur.lat, cur.lng];
  const r = "radius_km" in b ? radius(b.radius_km) : cur.radius_km;
  const address = "address" in b ? text(b.address, 300) : cur.address;
  const row = await env.DB.prepare("UPDATE territory_sites SET name = ?3, address = ?4, lat = ?5, lng = ?6, radius_km = ?7, updated_at = ?8 WHERE id = ?1 AND account_id = ?2 RETURNING *")
    .bind(cur.id, ctx.accountId, name, address, lat, lng, r, now()).first();
  return siteOut(row);
}

export async function deleteSite(env, ctx, id) {
  const r = await env.DB.prepare("DELETE FROM territory_sites WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId).run();
  if (!r.meta.changes) throw err(404, "Site not found");
  return { ok: true };
}

async function prefs(env, ctx) {
  return (await env.DB.prepare("SELECT radius_km FROM territory_prefs WHERE account_id = ?1").bind(ctx.accountId).first()) || { radius_km: DEFAULT_RADIUS };
}
export async function setPrefs(env, ctx, b) {
  const r = radius(b.radius_km);
  await env.DB.prepare("INSERT INTO territory_prefs (account_id, radius_km, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (account_id) DO UPDATE SET radius_km = excluded.radius_km, updated_at = excluded.updated_at").bind(ctx.accountId, r, now()).run();
  return { radius_km: r };
}

// ------------------------------------------------------------------ the map's data
export async function getTerritory(env, ctx) {
  const [sites, p, targets, pending] = await Promise.all([
    env.DB.prepare("SELECT * FROM territory_sites WHERE account_id = ?1 ORDER BY id").bind(ctx.accountId).all(),
    prefs(env, ctx),
    env.DB.prepare(`SELECT t.id, t.name, t.stage, t.location, t.industry, t.revenue, t.ebitda, t.currency, g.results
      FROM targets t LEFT JOIN geocode_cache g ON g.q = lower(trim(t.location))
      WHERE t.account_id = ?1 AND t.stage != 'lost' ORDER BY t.updated_at DESC LIMIT 1000`).bind(ctx.accountId).all(),
    pendingCount(env, ctx),
  ]);
  const linked = new Set(sites.results.map((s) => s.target_id).filter(Boolean));
  const out = targets.results.map((t) => {
    const g = t.results ? JSON.parse(t.results)[0] : null;
    return { id: t.id, name: t.name, stage: t.stage, location: t.location, industry: t.industry, revenue: t.revenue, ebitda: t.ebitda, currency: t.currency, lat: g?.lat ?? null, lng: g?.lng ?? null, site: linked.has(t.id) };
  });
  return { sites: sites.results.map(siteOut), radius_km: p.radius_km, targets: out, pending,
    unplaced: out.filter((t) => t.lat == null && !t.location.trim()).length };
}

// The plan, server side (for the API and Josh). Population tiles are static assets.
export async function territoryPlan(env, ctx, origin) {
  const d = await getTerritory(env, ctx);
  const sites = d.sites;
  const targets = d.targets.filter((t) => !t.site && t.lat != null);
  const circles = [...sites, ...targets.map((t) => ({ lat: t.lat, lng: t.lng, radius_km: d.radius_km }))];
  const keys = tilesFor(circles, Math.max(d.radius_km, ...sites.map((s) => s.radius_km)) * 4).slice(0, 40);
  const rows = (await Promise.all(keys.map((k) => env.ASSETS.fetch(new Request(new URL(`/geo/${k}.json`, origin))).then((r) => (r.ok ? r.json() : [])).catch(() => [])))).flat();
  return { ...plan({ sites, targets, places: preparePlaces(rows), radiusKm: d.radius_km }), pending: d.pending };
}

export async function territoryRoute(request, env, ctx, url, body) {
  const p = url.pathname, m = request.method;
  let r;
  if (p === "/api/territory" && m === "GET") return json(await getTerritory(env, ctx));
  if (p === "/api/territory/plan" && m === "GET") return json(await territoryPlan(env, ctx, url.origin));
  if (p === "/api/territory/geocode" && m === "POST") return json(await geocodeTargets(env, ctx));
  if (p === "/api/territory/search" && m === "GET") return json({ results: await geocode(env, ctx, url.searchParams.get("q") || "") });
  if (p === "/api/territory/prefs" && m === "PUT") return json(await setPrefs(env, ctx, await body(request)));
  if (p === "/api/territory/sites" && m === "POST") return json(await createSite(env, ctx, await body(request)), 201);
  if ((r = p.match(/^\/api\/territory\/sites\/(\d+)$/))) {
    if (m === "PATCH") return json(await updateSite(env, ctx, +r[1], await body(request)));
    if (m === "DELETE") return json(await deleteSite(env, ctx, +r[1]));
  }
  return null;
}

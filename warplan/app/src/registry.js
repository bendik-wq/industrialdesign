// Ownership X-ray: who legally owns a business, since when, and whether it's really an independent.
//   Australia  ABN Lookup (abr.business.gov.au), read through TinyFish's free browser fetch on Monid: entity name and
//              type (a sole trader's registered name IS the owner), ABN active since (tenure), GST, every business
//              name the entity holds. An entity with many practice names is a chain or a corporate roll-up.
//   UK         Companies House (free key): incorporation date, active directors with birth year (age!), and the
//              people with significant control (who owns it).
// Free for the workspace either way; results are kept per target and fed into the research dossier.
import { run } from "./monid.js";
import { getTarget } from "./pipeline.js";
import { dataKeys } from "./keys.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const AU_STATES = /\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const CHAIN_NAMES = 6; // an entity trading under this many names is a group, not an owner-operator

export function countryOf(t) {
  const l = String(t.location || "");
  if (/australia/i.test(l) || t.currency === "A$" || (AU_STATES.test(l) && /\b\d{4}\b/.test(l))) return "AU";
  if (/united kingdom|\buk\b|england|scotland|wales|northern ireland/i.test(l) || t.currency === "£") return "UK";
  return null;
}

// ------------------------------------------------------------------ name matching
const STOP = new Set(["pty", "ltd", "limited", "the", "and", "&", "co", "company", "group", "trust", "trustee", "for", "of", "au", "australia", "inc", "llc", "plc"]);
export const tokens = (s) => String(s || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
export function nameScore(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w) || [...B].some((x) => x.length > 4 && w.length > 4 && (x.startsWith(w) || w.startsWith(x)))) hit++;
  return hit / Math.max(A.size, B.size);
}
// The best row for this target: name overlap first, then the same postcode / state.
export function pickMatch(rows, t) {
  const pc = String(t.location || "").match(/\b(\d{4})\b/)?.[1], st = String(t.location || "").match(AU_STATES)?.[1];
  const clean = String(t.name || "").split(/\s[-|–]\s|\|/)[0];
  const scored = rows.map((r) => ({ ...r, score: Math.max(nameScore(clean, r.name), nameScore(t.name, r.name)) + (pc && r.postcode === pc ? 0.35 : 0) + (st && r.state === st ? 0.1 : 0) }));
  scored.sort((x, y) => y.score - x.score);
  return scored[0] && scored[0].score >= 0.5 ? scored[0] : null;
}

// ------------------------------------------------------------------ ABN Lookup parsing (HTML from the free fetch)
const strip = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
export function parseAbnSearch(html) {
  const rows = [];
  for (const tr of String(html).split(/<tr[\s>]/i).slice(1)) {
    const abn = tr.match(/ABN\/View\?abn=(\d{11})/)?.[1];
    if (!abn) continue;
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
    const loc = tds[3] || "";
    rows.push({ abn, active: /active/i.test(tds[0] || ""), name: tds[1] || "", kind: tds[2] || "", postcode: loc.match(/\b(\d{4})\b/)?.[1] || null, state: loc.match(AU_STATES)?.[1] || null });
  }
  return rows;
}
const auDate = (s) => { const m = String(s || "").match(/(\d{1,2}) (\w{3}) (\d{4})/); return m && MONTHS[m[2]] != null ? new Date(Date.UTC(+m[3], MONTHS[m[2]], +m[1])).toISOString().slice(0, 10) : null; };
export function parseAbnView(html) {
  const h = String(html);
  const field = (label) => { const m = h.match(new RegExp(`<th>\\s*${label}[^<]*</th>\\s*<td>([\\s\\S]*?)</td>`, "i")); return m ? strip(m[1]) : ""; };
  const status = field("ABN status");
  const names = [];
  const block = h.match(/Business name\(s\)[\s\S]*?<\/table>/i)?.[0] || "";
  for (const tr of block.split(/<tr[\s>]/i).slice(1)) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
    if (tds.length === 2 && auDate(tds[1])) names.push({ name: tds[0], from: auDate(tds[1]) });
  }
  return {
    entity_name: field("Entity name"), entity_type: field("Entity type"), status: status.split(" ")[0] || null, active_from: auDate(status),
    gst_from: auDate(field("Goods &amp; Services Tax \\(GST\\)") || field("Goods & Services Tax")), location: field("Main business location"),
    acn: field("ASIC registration - ACN or ARBN").match(/[\d ]{9,11}/)?.[0]?.replace(/\s/g, "") || null, business_names: names,
  };
}

// What the record says about the seller, in plain words.
export function signals(rec, today = new Date()) {
  const out = [];
  const years = rec.since ? Math.floor((today - new Date(rec.since)) / (365.25 * 864e5)) : null;
  if (years != null) out.push(years >= 20 && !rec.chain ? `Registered ${years} years ago: a long-held business (a classic succession candidate)` : `Registered ${years} year${years === 1 ? "" : "s"} ago`);
  if (rec.owner_operator) out.push(`Sole trader: the owner is ${rec.owner_guess || "the registered individual"}, personally`);
  if (rec.chain) out.push(`Trades under ${rec.names_count} business names: a group or corporate roll-up, probably not an owner-operator`);
  if (rec.directors?.length) {
    const oldest = rec.directors.filter((d) => d.age).sort((a, b) => b.age - a.age)[0];
    if (oldest) out.push(`Oldest active director: ${oldest.name}, about ${oldest.age}`);
  }
  if (rec.owners?.length) out.push(`Owned by: ${rec.owners.map((o) => o.name + (o.share ? ` (${o.share})` : "")).join(", ")}`);
  return out;
}

async function fetchHtml(env, ctx, url, targetId) {
  const r = await run(env, ctx, { provider: "tinyfish", endpoint: "/fetch", input: { body: { urls: [url], ttl: 0, format: "html", include_selectors: ["table"] } } }, { purpose: "Ownership check (ABN Lookup)", targetId, maxWaitMs: 30000 });
  const res = r.output?.results?.[0];
  if (!res) throw err(502, `ABN Lookup didn't answer (${r.output?.errors?.[0]?.code || "no result"})`);
  return res.text || res.html || "";
}

async function checkAU(env, ctx, t) {
  const q = String(t.name).split(/\s[-|–]\s|\|/)[0].trim().slice(0, 80);
  const list = parseAbnSearch(await fetchHtml(env, ctx, `https://abr.business.gov.au/Search/ResultsActive?SearchText=${encodeURIComponent(q)}`, t.id));
  const best = pickMatch(list, t);
  if (!best) return { found: false, searched: q, candidates: list.slice(0, 5) };
  const v = parseAbnView(await fetchHtml(env, ctx, `https://abr.business.gov.au/ABN/View?abn=${best.abn}`, t.id));
  const soleTrader = /individual|sole trader/i.test(v.entity_type);
  const [last, first] = soleTrader ? v.entity_name.split(",").map((s) => s.trim()) : [];
  return {
    found: true, source: "ABN Lookup", country: "AU", abn: best.abn, matched_on: best.name, match_score: Math.round(best.score * 100) / 100,
    entity_name: v.entity_name, entity_type: v.entity_type, status: v.status, since: v.active_from, gst_from: v.gst_from, location: v.location, acn: v.acn,
    names_count: v.business_names.length, business_names: v.business_names.slice(0, 25), chain: v.business_names.length >= CHAIN_NAMES,
    owner_operator: soleTrader, owner_guess: soleTrader && first ? `${first.split(" ").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ")} ${last[0] + last.slice(1).toLowerCase()}` : null,
    url: `https://abr.business.gov.au/ABN/View?abn=${best.abn}`,
  };
}

async function checkUK(env, ctx, t) {
  const key = (await dataKeys(env, ctx)).companies_house;
  if (!key) throw err(400, "Connect a free Companies House key under Settings → Integrations to check UK companies");
  const auth = { Authorization: `Basic ${btoa(`${key}:`)}` };
  const get = async (path) => { const r = await fetch(`https://api.company-information.service.gov.uk${path}`, { headers: auth }); if (r.status === 404) return null; if (!r.ok) throw err(502, `Companies House answered ${r.status}`); return r.json(); };
  const s = await get(`/search/companies?q=${encodeURIComponent(String(t.name).slice(0, 80))}&items_per_page=10`);
  const rows = (s?.items || []).map((c) => ({ number: c.company_number, name: c.title, active: c.company_status === "active", postcode: null, state: null, address: c.address_snippet }));
  const best = pickMatch(rows.filter((r) => r.active), t);
  if (!best) return { found: false, searched: t.name, candidates: rows.slice(0, 5) };
  const [co, off, psc] = await Promise.all([get(`/company/${best.number}`), get(`/company/${best.number}/officers?items_per_page=30`), get(`/company/${best.number}/persons-with-significant-control`)]);
  const year = new Date().getUTCFullYear();
  const directors = (off?.items || []).filter((o) => !o.resigned_on && /director/i.test(o.officer_role || "")).map((o) => ({ name: o.name, appointed: o.appointed_on || null, age: o.date_of_birth?.year ? year - o.date_of_birth.year : null }));
  const owners = (psc?.items || []).filter((p) => !p.ceased_on).map((p) => ({ name: p.name, share: (p.natures_of_control || []).map((n) => n.match(/(\d+)-to-(\d+)-percent/)?.slice(1).join("–") + "%").filter((x) => x && !x.startsWith("undefined"))[0] || null, corporate: /corporate/i.test(p.kind || "") }));
  return {
    found: true, source: "Companies House", country: "UK", company_number: best.number, matched_on: best.name, match_score: Math.round(best.score * 100) / 100,
    entity_name: co?.company_name || best.name, entity_type: co?.type || "", status: co?.company_status || null, since: co?.date_of_creation || null, location: best.address,
    directors, owners, chain: owners.some((o) => o.corporate), owner_operator: owners.length > 0 && owners.every((o) => !o.corporate),
    url: `https://find-and-update.company-information.service.gov.uk/company/${best.number}`,
  };
}

export async function ownershipCheck(env, ctx, targetId, { quiet = false } = {}) {
  const t = await getTarget(env, ctx, +targetId);
  const c = countryOf(t);
  if (!c) throw err(400, "The ownership check covers Australia (ABN Lookup) and the UK (Companies House) so far. Add the state or country to the target's location.");
  const rec = c === "AU" ? await checkAU(env, ctx, t) : await checkUK(env, ctx, t);
  rec.signals = rec.found ? signals(rec) : [];
  rec.checked_at = now();
  await env.DB.prepare("INSERT INTO target_registry (target_id, account_id, source, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (target_id) DO UPDATE SET source = ?3, data = ?4, updated_at = ?5")
    .bind(t.id, ctx.accountId, c === "AU" ? "abn" : "companies_house", JSON.stringify(rec), rec.checked_at).run();
  if (rec.found && !quiet) {
    await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'note', ?5, ?6)")
      .bind(ctx.accountId, t.id, ctx.user?.id || null, ctx.user?.name || "Agent", `Ownership (${rec.source}): ${rec.entity_name}, ${rec.entity_type || "entity"}${rec.since ? `, since ${rec.since}` : ""}. ${rec.signals.join(". ")}`, rec.checked_at).run();
    // Fill gaps only: a sole trader's registered name is the owner.
    if (rec.owner_guess && !t.owner_name) await env.DB.prepare("UPDATE targets SET owner_name = ?3, updated_at = ?4 WHERE id = ?1 AND account_id = ?2").bind(t.id, ctx.accountId, rec.owner_guess, now()).run();
    const oldest = rec.directors?.filter((d) => d.age).sort((a, b) => b.age - a.age)[0];
    if (oldest && !t.owner_age) await env.DB.prepare("UPDATE targets SET owner_age = ?3, updated_at = ?4 WHERE id = ?1 AND account_id = ?2").bind(t.id, ctx.accountId, oldest.age, now()).run();
  }
  return { target_id: t.id, ...rec, receipt: rec.found ? `${rec.entity_name}: ${rec.signals[0] || rec.entity_type}` : `No confident match for ${t.name} in ${c === "AU" ? "ABN Lookup" : "Companies House"}` };
}

export async function getRegistry(env, ctx, targetId) {
  const r = await env.DB.prepare("SELECT data FROM target_registry WHERE target_id = ?1 AND account_id = ?2").bind(+targetId, ctx.accountId).first();
  return r ? JSON.parse(r.data) : null;
}

// Every AU/UK target in the pipeline that hasn't been checked in 90 days, up to 8 per call.
export async function ownershipBulk(env, ctx, limit = 8) {
  const { results } = await env.DB.prepare(`SELECT t.id, t.name, t.location, t.currency FROM targets t LEFT JOIN target_registry r ON r.target_id = t.id
    WHERE t.account_id = ?1 AND t.stage NOT IN ('closed','lost') AND (r.updated_at IS NULL OR r.updated_at < ?2) ORDER BY t.updated_at DESC LIMIT 60`).bind(ctx.accountId, new Date(Date.now() - 90 * 864e5).toISOString()).all();
  const todo = results.filter((t) => countryOf(t)).slice(0, Math.min(limit, 10));
  // Four at a time: each check is two page fetches (~5–10s), and the whole batch has to finish inside one request.
  const done = [];
  for (let i = 0; i < todo.length; i += 4) {
    done.push(...(await Promise.all(todo.slice(i, i + 4).map(async (t) => {
      try { const r = await ownershipCheck(env, ctx, t.id); return { id: t.id, name: t.name, found: r.found, chain: !!r.chain, summary: r.receipt }; }
      catch (e) { return { id: t.id, name: t.name, error: e.message }; }
    }))));
  }
  const left = results.filter((t) => countryOf(t)).length - todo.length;
  return { checked: done, left, receipt: `Checked ${done.length} target${done.length === 1 ? "" : "s"}${left > 0 ? `, ${left} to go` : ""}. ${done.filter((d) => d.chain).length} look like chains.` };
}

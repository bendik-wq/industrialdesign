// Monid: one key and one prepaid wallet for 2,500+ data, scraping and enrichment APIs (Google Maps, Hunter,
// LinkedIn, Apify actors, people data...). Warplan uses it three ways:
//   1. Scout's "Google Maps (Monid)" source and the deep-enrich waterfall (fixed, known-price endpoints).
//   2. Agent tools (monid_discover / monid_inspect / monid_run) so Josh or any MCP client can reach any endpoint.
//   3. A per-workspace monthly budget: every run is logged with what Monid billed, runs stop at the cap, and runs
//      with an unknown or high price wait for a person's approval in the Inbox.
// REST: POST /v1/discover, POST /v1/inspect, POST /v1/run, GET /v1/runs/{id}, GET /v1/wallet/balance.
import { providerKeys } from "./keys.js";

const BASE = "https://api.monid.ai";
const DONE = new Set(["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"]);
const err = (status, message) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
export const BUDGET_DEFAULTS = { monthly_usd: 25, approve_over_usd: 0.5 };

export async function monidKey(env, ctx) {
  const k = (await providerKeys(env, ctx, ["monid"])).monid;
  return k?.key || null;
}
async function needKey(env, ctx) {
  const key = await monidKey(env, ctx);
  if (!key) throw err(400, "Connect a Monid key under Settings → Integrations to use the data marketplace");
  return key;
}

async function call(key, method, path, payload) {
  const res = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
  if (res.status === 401 || res.status === 403) throw err(400, "Monid rejected the key");
  if (res.status === 402) throw err(402, "The Monid wallet is empty; top it up at monid.ai");
  if (!res.ok) throw err(res.status === 404 ? 404 : 502, `Monid: ${data?.error?.message || data?.message || `answered ${res.status}`}`);
  return data;
}

// ------------------------------------------------------------------ catalogue
const inspectCache = new Map();
export async function inspect(key, provider, endpoint) {
  const id = `${provider} ${endpoint}`;
  if (inspectCache.has(id)) return inspectCache.get(id);
  const d = await call(key, "POST", "/v1/inspect", { provider, endpoint });
  if (inspectCache.size > 200) inspectCache.clear();
  inspectCache.set(id, d);
  return d;
}

export async function discover(env, ctx, query, limit = 8) {
  const key = await needKey(env, ctx);
  const d = await call(key, "POST", "/v1/discover", { query: String(query).slice(0, 300), limit: Math.max(1, Math.min(20, +limit || 8)) });
  const items = d.results || d.endpoints || d.items || d.data || [];
  return items.map((x) => ({
    provider: x.provider, endpoint: x.endpoint, name: x.providerName || x.provider, description: String(x.summary || x.description || "").slice(0, 300),
    price: priceText(x.price), score: x.score ?? undefined,
  }));
}

export async function describe(env, ctx, provider, endpoint) {
  const d = await inspect(await needKey(env, ctx), provider, endpoint);
  return { provider: d.provider, endpoint: d.endpoint, method: d.method, description: d.summary || d.description, input: d.input, price: priceText(d.price), price_raw: d.price, notes: d.notes, hints: d.hints, typical_seconds: d.metrics?.runTimeMs?.p50 ? Math.round(d.metrics.runTimeMs.p50 / 1000) : undefined };
}

export function priceText(p) {
  if (!p?.amount?.value && p?.amount?.value !== 0) return "price unknown";
  const v = `$${p.amount.value}`;
  return p.type === "PER_RESULT" ? `${v} per result` : p.type === "PER_UNIT" ? `${v} per ${p.per || 1} ${p.unit || "unit"}${(p.per || 1) > 1 ? "s" : ""}` : p.type === "TIERED" ? `from ${v} per call` : `${v} per call`;
}

// Worst-case cost of one run, from the endpoint's price and the limit in the input. null = can't tell.
export function estimate(price, input = {}) {
  const v = price?.amount?.value;
  if (v == null) return null;
  if (price.type === "PER_CALL") return v;
  if (price.type === "TIERED") return Math.max(v, ...(price.tiers || []).map((t) => t.price?.amount?.value || 0));
  if (price.type === "PER_RESULT") {
    const all = { ...(input.body || {}), ...(input.queryParams || {}) };
    const n = ["max_results", "maxItems", "limit", "max_items", "count", "num", "maxResults"].map((k) => +all[k]).find((x) => x > 0);
    return n ? v * n : null;
  }
  return null; // per-minute calls and the like
}

// ------------------------------------------------------------------ budget
export async function budget(env, ctx) {
  const row = await env.DB.prepare("SELECT data FROM settings WHERE account_id = ?1 AND key = 'monid'").bind(ctx.accountId).first();
  const cfg = { ...BUDGET_DEFAULTS, ...(row ? JSON.parse(row.data) : {}) };
  // On the platform's shared key (no key of their own) a workspace gets a fixed allowance it can't raise.
  if (env.MONID_API_KEY && !(await env.DB.prepare("SELECT 1 FROM account_keys WHERE account_id = ?1 AND provider = 'monid'").bind(ctx.accountId).first())) {
    const cap = Math.max(0, +env.MONID_PLATFORM_CAP_USD || 5);
    cfg.monthly_usd = Math.min(cfg.monthly_usd, cap); cfg.approve_over_usd = Math.min(cfg.approve_over_usd, 0.1); cfg.platform = true;
  }
  const month = now().slice(0, 7);
  const s = await env.DB.prepare("SELECT COALESCE(SUM(cost), 0) AS spent, COUNT(*) AS runs FROM monid_runs WHERE account_id = ?1 AND created_at >= ?2").bind(ctx.accountId, `${month}-01`).first();
  return { ...cfg, month, spent_usd: +s.spent.toFixed(4), runs: s.runs, left_usd: +Math.max(0, cfg.monthly_usd - s.spent).toFixed(4) };
}
export async function setBudget(env, ctx, b) {
  const cfg = { monthly_usd: Math.max(0, Math.min(10000, +b.monthly_usd || 0)), approve_over_usd: Math.max(0, Math.min(1000, +b.approve_over_usd || 0)) };
  await env.DB.prepare("INSERT INTO settings (account_id, key, data, updated_at) VALUES (?1, 'monid', ?2, ?3) ON CONFLICT (account_id, key) DO UPDATE SET data = ?2, updated_at = ?3").bind(ctx.accountId, JSON.stringify(cfg), now()).run();
  return budget(env, ctx);
}

export async function balance(env, ctx) {
  const key = await monidKey(env, ctx);
  if (!key) return { connected: false };
  const d = await call(key, "GET", "/v1/wallet/balance");
  return { connected: true, balance_usd: d.balance?.value ?? d.value ?? d.balance ?? null };
}

// Does this run need a person to approve it first? Returns a reason, or null if it can go ahead.
export async function needsApproval(env, ctx, provider, endpoint, input) {
  const key = await needKey(env, ctx);
  const d = await inspect(key, provider, endpoint);
  const cost = estimate(d.price, input), b = await budget(env, ctx);
  if (cost == null) return `${provider} ${endpoint} costs ${priceText(d.price)} and the total can't be known up front`;
  if (cost > b.approve_over_usd) return `${provider} ${endpoint} may cost up to $${cost.toFixed(3)} (over the $${b.approve_over_usd} auto-approve limit)`;
  return null;
}

// ------------------------------------------------------------------ runs
// Run one endpoint and wait for it (up to maxWaitMs). Long runs come back RUNNING with a run_id to check later.
export async function run(env, ctx, { provider, endpoint, input = {} }, { purpose = "", targetId = null, maxWaitMs = 25000, key } = {}) {
  key = key || (await needKey(env, ctx));
  if (!provider || !endpoint) throw err(400, "Say which provider and endpoint to run (find them with monid_discover)");
  if (targetId && !(await env.DB.prepare("SELECT 1 FROM targets WHERE id = ?1 AND account_id = ?2").bind(+targetId, ctx.accountId).first())) targetId = null;
  const b = await budget(env, ctx);
  if (b.left_usd <= 0) throw err(402, `This month's data budget ($${b.monthly_usd}) is used up. Raise it under Settings → Integrations → Monid.`);
  const clean = { ...(input.body && { body: input.body }), ...(input.queryParams && { queryParams: input.queryParams }), ...(input.pathParams && { pathParams: input.pathParams }) };
  let r = await call(key, "POST", "/v1/run", { provider, endpoint, input: clean });
  const runId = r.runId || r.id;
  const started = Date.now();
  while (!DONE.has(r.status) && runId && Date.now() - started < maxWaitMs) {
    await sleep(Math.min(4000, 1000 + (Date.now() - started) / 4));
    r = await call(key, "GET", `/v1/runs/${encodeURIComponent(runId)}`);
  }
  // The synchronous answer to POST /v1/run carries no cost; the run record does.
  if (DONE.has(r.status) && r.cost == null && runId) { try { const full = await call(key, "GET", `/v1/runs/${encodeURIComponent(runId)}`); r = { ...full, output: r.output ?? full.output }; } catch { /* cost stays unknown */ } }
  const cost = +(r.cost?.value ?? 0) || 0;
  await env.DB.prepare("INSERT INTO monid_runs (account_id, user_id, target_id, provider, endpoint, run_id, status, cost, purpose, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
    .bind(ctx.accountId, ctx.user?.id || null, targetId, provider, endpoint, runId || null, r.status || "UNKNOWN", cost, String(purpose).slice(0, 200), now()).run();
  if (r.status === "FAILED" || r.status === "BLOCKED" || r.status === "TIMED_OUT") throw err(502, `Monid ${provider} ${endpoint}: ${r.error?.message || r.status.toLowerCase().replace("_", " ")}`);
  return { run_id: runId, status: r.status, cost_usd: cost, output: r.output ?? null };
}

// Check on (and log the final cost of) a run that was still going.
export async function result(env, ctx, runId) {
  const key = await needKey(env, ctx);
  const own = await env.DB.prepare("SELECT id, status FROM monid_runs WHERE account_id = ?1 AND run_id = ?2").bind(ctx.accountId, String(runId)).first();
  if (!own) throw err(404, "No run with that id in this workspace");
  const r = await call(key, "GET", `/v1/runs/${encodeURIComponent(runId)}`);
  if (DONE.has(r.status) && own.status !== r.status) await env.DB.prepare("UPDATE monid_runs SET status = ?2, cost = ?3 WHERE id = ?1").bind(own.id, r.status, +(r.cost?.value ?? 0) || 0).run();
  return { run_id: runId, status: r.status, cost_usd: +(r.cost?.value ?? 0) || 0, output: DONE.has(r.status) ? r.output ?? null : null };
}

export async function recentRuns(env, ctx, limit = 30) {
  const { results } = await env.DB.prepare("SELECT r.id, r.provider, r.endpoint, r.status, r.cost, r.purpose, r.created_at, r.target_id, t.name AS target_name FROM monid_runs r LEFT JOIN targets t ON t.id = r.target_id AND t.account_id = r.account_id WHERE r.account_id = ?1 ORDER BY r.id DESC LIMIT ?2").bind(ctx.accountId, limit).all();
  return results;
}

// Keep tool results small enough for a model's context: trim long arrays and strings.
export function compact(v, depth = 0) {
  if (typeof v === "string") return v.length > 600 ? `${v.slice(0, 600)}…` : v;
  if (Array.isArray(v)) { const a = v.slice(0, depth ? 10 : 25).map((x) => compact(x, depth + 1)); if (v.length > a.length) a.push(`…${v.length - a.length} more`); return a; }
  if (v && typeof v === "object") {
    if (depth > 4) return "…";
    return Object.fromEntries(Object.entries(v).filter(([k]) => !/^(thumbnail|image|images|photos?|serpapi_|gps|raw_html|html|logo)/i.test(k)).slice(0, 40).map(([k, x]) => [k, compact(x, depth + 1)]));
  }
  return v;
}

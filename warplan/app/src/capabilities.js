// C1 and C2 of the 3C model (the JL skill): the board, the professional bench and the lender matrix, plus the
// financing workflow for a deal (which lenders fit it, who has it, term sheets) and the facts the credibility packet
// and the lender pack are written from. Statuses, fields and cadences are the skill's: see public/js/jl.js.
import { REL_STATUSES, LENDER_FIELDS, STALE_DAYS, FINANCING_STAGES, BOARD_ROLES, BENCH_ROLES, LENDER_TARGET } from "../public/js/jl.js";
import { dealModel, targetDeal, money } from "../public/js/deal.js";
import { now, cleanEmail, displayName } from "./http.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const KINDS = new Set(["board", "bench", "lender"]);
const ROLES = { board: new Set(BOARD_ROLES.map((r) => r.id)), bench: new Set(BENCH_ROLES.map((r) => r.id)) };
const FIN_STAGES = new Set(FINANCING_STAGES.map(([k]) => k));
const text = (v, max) => String(v ?? "").trim().slice(0, max);
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : null);
const numOrNull = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const daysSince = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso)) / 864e5) : null);

// Only the matrix's own fields (and a few free-text ones for the board and bench) are kept from `terms`.
const EXTRA_TERMS = { vesting: 300, bio: 2000, track: 600, fees: 600, scope: 600, rate: 60 };
function cleanTerms(t = {}) {
  const out = {};
  for (const f of LENDER_FIELDS) {
    if (!(f.k in t)) continue;
    if (f.type === "number") { const n = numOrNull(t[f.k]); if (n != null) out[f.k] = n; }
    else if (f.type === "select") { if (f.options.includes(t[f.k])) out[f.k] = t[f.k]; }
    else { const s = text(t[f.k], 300); if (s) out[f.k] = s; }
  }
  for (const [k, max] of Object.entries(EXTRA_TERMS)) { const s = text(t[k], max); if (s) out[k] = s; }
  return out;
}

function clean(b, partial, kind) {
  const out = {};
  if ("name" in b || !partial) { out.name = text(b.name, 120); if (!out.name) throw err(400, "Give them a name"); }
  if ("role" in b) out.role = text(b.role, 40);
  if (out.role && ROLES[kind] && !ROLES[kind].has(out.role)) throw err(400, "Unknown role");
  for (const k of ["firm", "phone", "linkedin"]) if (k in b) out[k] = text(b[k], k === "linkedin" ? 300 : 120);
  if ("email" in b) out.email = b.email ? cleanEmail(b.email) : "";
  if ("email" in b && b.email && !out.email) throw err(400, "That email doesn't look right");
  if ("status" in b) { if (!REL_STATUSES[kind].some(([s]) => s === b.status)) throw err(400, "Unknown status"); out.status = b.status; }
  if ("equity_pct" in b) { const e = numOrNull(b.equity_pct); if (e != null && (e < 0 || e > 50)) throw err(400, "Equity is a percentage between 0 and 50"); out.equity_pct = e; }
  if ("notes" in b) out.notes = text(b.notes, 4000);
  if ("last_contact" in b) out.last_contact = ymd(b.last_contact);
  if ("next_date" in b) out.next_date = ymd(b.next_date);
  if ("terms" in b) out.terms = JSON.stringify(cleanTerms(b.terms && typeof b.terms === "object" ? b.terms : {}));
  return out;
}

const rowOut = (r) => {
  const terms = JSON.parse(r.terms || "{}");
  const stale = daysSince(r.last_contact);
  return { ...r, terms, days_since: stale, stale: r.status !== "passed" && (stale == null ? r.status !== "prospect" : stale > STALE_DAYS[r.kind]) };
};

export async function listRelationships(env, ctx, kind) {
  if (kind && !KINDS.has(kind)) throw err(400, "kind is board, bench or lender");
  const { results } = await env.DB.prepare("SELECT * FROM relationships WHERE account_id = ?1 AND (?2 IS NULL OR kind = ?2) ORDER BY kind, CASE status WHEN 'passed' THEN 1 ELSE 0 END, updated_at DESC LIMIT 500").bind(ctx.accountId, kind || null).all();
  const rows = results.map(rowOut);
  return { relationships: rows, summary: c1c2Summary(rows) };
}

// The skill's Capabilities and Capital metrics, from the rows.
export function c1c2Summary(rows) {
  const by = (k) => rows.filter((r) => r.kind === k);
  const board = by("board"), bench = by("bench"), lenders = by("lender");
  const seats = BOARD_ROLES.map((role) => ({ ...role, filled: board.filter((r) => r.role === role.id && ["agreed", "signed"].includes(r.status)).map((r) => r.name) }));
  return {
    board: { seats, filled: seats.filter((s) => s.filled.length).length, signed: board.filter((r) => r.status === "signed").length, equity: board.filter((r) => ["agreed", "signed"].includes(r.status)).reduce((t, r) => t + (r.equity_pct || 0), 0) },
    bench: { engaged: bench.filter((r) => r.status === "engaged").length, roles: BENCH_ROLES.map((role) => ({ ...role, engaged: bench.some((r) => r.role === role.id && r.status === "engaged") })) },
    lenders: {
      total: lenders.filter((r) => r.status !== "passed").length,
      interviewed: lenders.filter((r) => ["interviewed", "relationship"].includes(r.status)).length,
      inMatrix: lenders.filter((r) => Object.keys(r.terms).some((k) => LENDER_FIELDS.some((f) => f.k === k))).length,
      target: LENDER_TARGET,
    },
    stale: rows.filter((r) => r.stale).length,
  };
}

async function own(env, ctx, id) {
  const r = await env.DB.prepare("SELECT * FROM relationships WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId).first();
  if (!r) throw err(404, "Not found");
  return r;
}

export async function createRelationship(env, ctx, b) {
  const kind = b.kind;
  if (!KINDS.has(kind)) throw err(400, "kind is board, bench or lender");
  const c = clean(b, false, kind);
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM relationships WHERE account_id = ?1").bind(ctx.accountId).first();
  if (n >= 500) throw err(400, "That's 500 relationships; remove some first");
  const stamp = now();
  const cols = { account_id: ctx.accountId, kind, role: "", status: "prospect", terms: "{}", created_by: ctx.user.id || null, created_at: stamp, updated_at: stamp, ...c };
  const keys = Object.keys(cols);
  const row = await env.DB.prepare(`INSERT INTO relationships (${keys.join(", ")}) VALUES (${keys.map((_, i) => `?${i + 1}`).join(", ")}) RETURNING *`).bind(...keys.map((k) => cols[k])).first();
  return rowOut(row);
}

export async function updateRelationship(env, ctx, id, b) {
  const cur = await own(env, ctx, id);
  const c = clean(b, true, cur.kind);
  if (c.terms) c.terms = JSON.stringify({ ...JSON.parse(cur.terms || "{}"), ...JSON.parse(c.terms) });
  // A status step forward counts as a touch.
  if (c.status && c.status !== cur.status && !("last_contact" in c)) c.last_contact = now().slice(0, 10);
  const keys = Object.keys(c);
  if (!keys.length) return rowOut(cur);
  const row = await env.DB.prepare(`UPDATE relationships SET ${keys.map((k, i) => `${k} = ?${i + 3}`).join(", ")}, updated_at = ?${keys.length + 3} WHERE id = ?1 AND account_id = ?2 RETURNING *`)
    .bind(+id, ctx.accountId, ...keys.map((k) => c[k]), now()).first();
  return rowOut(row);
}

export async function deleteRelationship(env, ctx, id) {
  await own(env, ctx, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM relationships WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId),
    env.DB.prepare("DELETE FROM financing WHERE relationship_id = ?1 AND account_id = ?2").bind(+id, ctx.accountId),
  ]);
  return { ok: true };
}

// ------------------------------------------------------------------ lender fit for one deal
// What the deal needs from a bank: the commercial-debt slice of its stack. With no bank slice (pure vendor finance)
// there's nothing to borrow, and fit is shown against the whole price as a hypothetical (the skill: "Request term
// sheets for hypothetical scenarios").
export function lenderNeed(t) {
  const d = targetDeal(t), m = dealModel(d);
  return { cur: d.cur, amount: m.amt.bank || 0, price: m.price, hypothetical: !(m.amt.bank > 0), minDscr: m.minDscr, industry: t.industry || "", ebitda: d.ebitda };
}

// Score one lender against a need: each matrix field that can be checked passes, fails, or is unknown.
export function scoreLender(l, need) {
  const t = l.terms || {}, amount = need.hypothetical ? need.price : need.amount;
  const checks = [];
  const add = (label, ok, detail) => checks.push({ label, ok, detail });
  if (t.ticket_min != null || t.ticket_max != null) {
    const ok = (t.ticket_min == null || amount >= t.ticket_min) && (t.ticket_max == null || amount <= t.ticket_max);
    add("Ticket size", ok, `${money(t.ticket_min || 0, need.cur)}–${t.ticket_max != null ? money(t.ticket_max, need.cur) : "any"} vs ${money(amount, need.cur)}`);
  } else add("Ticket size", null, "Ask: What size tickets do you typically finance?");
  if (t.min_dscr != null && need.minDscr != null && !need.hypothetical) add("DSCR", need.minDscr >= t.min_dscr, `deal ${need.minDscr.toFixed(2)}x vs their ${t.min_dscr}x minimum`);
  else if (t.min_dscr != null) add("DSCR", null, `their minimum ${t.min_dscr}x; the skill's own floor is 1.5x`);
  else add("DSCR", null, "Ask: What DSCR do you require? ICR?");
  if (t.sectors && need.industry) {
    const words = need.industry.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
    const hay = t.sectors.toLowerCase();
    const match = /\b(all|any|general|generalist)\b/.test(hay) || words.some((w) => hay.includes(w.slice(0, 6)));
    add("Sector appetite", match ? true : null, t.sectors);
  } else add("Sector appetite", null, t.sector_exp ? `Sector experience: ${t.sector_exp}` : "Ask: How many deals have you done in [sector]?");
  if (t.pg_policy) add("PG policy", /\b(no|none|negotiable|flex|waiv)/i.test(t.pg_policy) ? true : null, t.pg_policy);
  if (t.unsecured) add("Unsecured portions", t.unsecured === "No" ? false : true, t.unsecured);
  const fails = checks.filter((c) => c.ok === false).length, passes = checks.filter((c) => c.ok === true).length;
  const warmth = { relationship: 3, interviewed: 2, emailed: 1 }[l.status] || 0;
  return { score: fails ? -fails : passes * 2 + warmth, fit: fails ? "no" : passes >= 2 ? "good" : "unknown", checks, timing_days: t.timing_days ?? null };
}

export async function lenderFit(env, ctx, targetId) {
  const t = await env.DB.prepare("SELECT id, name, industry, ebitda, currency, deal FROM targets WHERE id = ?1 AND account_id = ?2").bind(+targetId, ctx.accountId).first();
  if (!t) throw err(404, "Target not found");
  const need = lenderNeed({ ...t, deal: t.deal ? JSON.parse(t.deal) : null });
  const [lenders, fin] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM relationships WHERE account_id = ?1 AND kind = 'lender' AND status != 'passed'").bind(ctx.accountId),
    env.DB.prepare("SELECT f.*, r.name, r.firm FROM financing f JOIN relationships r ON r.id = f.relationship_id WHERE f.account_id = ?1 AND f.target_id = ?2 ORDER BY f.updated_at DESC").bind(ctx.accountId, +targetId),
  ]);
  const sent = new Map(fin.results.map((f) => [f.relationship_id, f]));
  const ranked = lenders.results.map(rowOut).map((l) => ({ id: l.id, name: l.name, firm: l.firm, status: l.status, email: l.email, ...scoreLender(l, need), financing: sent.get(l.id) ? { ...sent.get(l.id), terms: JSON.parse(sent.get(l.id).terms || "{}") } : null }))
    .sort((a, b) => b.score - a.score);
  return { need, lenders: ranked, financing: fin.results.map((f) => ({ ...f, terms: JSON.parse(f.terms || "{}") })) };
}

// ------------------------------------------------------------------ financing workflow
export async function setFinancing(env, ctx, targetId, b) {
  const t = await env.DB.prepare("SELECT id, name FROM targets WHERE id = ?1 AND account_id = ?2").bind(+targetId, ctx.accountId).first();
  if (!t) throw err(404, "Target not found");
  const l = await own(env, ctx, b.relationship_id);
  if (l.kind !== "lender") throw err(400, "That isn't a lender");
  const stage = b.stage || "sent";
  if (!FIN_STAGES.has(stage)) throw err(400, "Unknown financing stage");
  const terms = {};
  for (const k of ["rate", "years", "dscr", "pg", "security", "covenants", "notes"]) if (b.terms?.[k] != null && b.terms[k] !== "") terms[k] = text(b.terms[k], 400);
  const stamp = now();
  const prev = await env.DB.prepare("SELECT stage FROM financing WHERE account_id = ?1 AND target_id = ?2 AND relationship_id = ?3").bind(ctx.accountId, t.id, l.id).first();
  const row = await env.DB.prepare(`INSERT INTO financing (account_id, target_id, relationship_id, stage, amount, terms, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT (account_id, target_id, relationship_id) DO UPDATE SET stage = ?4, amount = COALESCE(?5, amount), terms = CASE WHEN ?6 = '{}' THEN terms ELSE ?6 END, updated_at = ?7 RETURNING *`)
    .bind(ctx.accountId, t.id, l.id, stage, numOrNull(b.amount), JSON.stringify(terms), stamp).first();
  const label = Object.fromEntries(FINANCING_STAGES)[stage];
  if (prev?.stage !== stage) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'note', ?5, ?6)").bind(ctx.accountId, t.id, ctx.user.id || null, displayName(ctx), `Financing · ${l.name}${l.firm ? ` (${l.firm})` : ""}: ${label}`, stamp),
      env.DB.prepare("UPDATE relationships SET last_contact = ?3, updated_at = ?4 WHERE id = ?1 AND account_id = ?2").bind(l.id, ctx.accountId, stamp.slice(0, 10), stamp),
    ]);
  }
  return { ...row, terms: JSON.parse(row.terms) };
}

export async function deleteFinancing(env, ctx, id) {
  await env.DB.prepare("DELETE FROM financing WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId).run();
  return { ok: true };
}

// ------------------------------------------------------------------ facts for the agents
// The roster block for the credibility packet: only what's in the table, so the agent can't invent credentials.
export async function rosterBlock(env, accountId) {
  const { results } = await env.DB.prepare("SELECT kind, role, name, firm, status, equity_pct, terms FROM relationships WHERE account_id = ?1 AND kind IN ('board', 'bench') AND status NOT IN ('passed', 'prospect') ORDER BY kind, role").bind(accountId).all();
  if (!results.length) return "";
  const roles = Object.fromEntries([...BOARD_ROLES, ...BENCH_ROLES].map((r) => [r.id, r.label]));
  return results.map((r) => {
    const t = JSON.parse(r.terms || "{}");
    return `- ${r.kind === "board" ? "Board" : "Bench"} · ${roles[r.role] || r.role || "Advisor"}: ${r.name}${r.firm ? `, ${r.firm}` : ""} (${r.status})${t.track ? `. Track record: ${t.track}` : ""}${t.bio ? `. Bio: ${t.bio}` : ""}`;
  }).join("\n");
}

// The lender matrix as the lender pack's "Lenders to call" source: the buyer's real lenders, best fit first.
export async function lendersBlock(env, ctx, target) {
  const { results } = await env.DB.prepare("SELECT * FROM relationships WHERE account_id = ?1 AND kind = 'lender' AND status != 'passed' LIMIT 200").bind(ctx.accountId).all();
  if (!results.length) return "";
  const need = lenderNeed(target);
  return results.map(rowOut).map((l) => ({ l, s: scoreLender(l, need) })).sort((a, b) => b.s.score - a.s.score).slice(0, 8)
    .map(({ l, s }) => `- ${l.name}${l.firm ? ` (${l.firm})` : ""}, ${l.status}: fit ${s.fit}; ${s.checks.map((c) => `${c.label} ${c.ok === true ? "✓" : c.ok === false ? "✗" : "?"} ${c.detail}`).join("; ")}`).join("\n");
}

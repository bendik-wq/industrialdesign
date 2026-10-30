// Monthly actuals for the businesses you own: the numbers the post-close agents watch.
import { getTarget } from "./pipeline.js";
import { now } from "./http.js";

const err = (status, message) => Object.assign(new Error(message), { status });
export const FIELDS = ["revenue", "gross_profit", "wages", "ebitda", "cash", "receivables", "payables", "debt_service", "headcount", "customers"];
const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export async function listActuals(env, ctx, targetId, months = 36) {
  await getTarget(env, ctx, +targetId);
  const { results } = await env.DB.prepare(`SELECT period, ${FIELDS.join(", ")}, source, updated_at FROM actuals WHERE account_id = ?1 AND target_id = ?2 ORDER BY period DESC LIMIT ?3`)
    .bind(ctx.accountId, +targetId, Math.min(120, months)).all();
  return results.reverse();
}

// rows: [{period: "2026-07", revenue, ebitda, ...}]. Blank fields keep what's stored.
export async function saveActuals(env, ctx, targetId, rows, source = "manual") {
  await getTarget(env, ctx, +targetId);
  if (!Array.isArray(rows) || !rows.length) throw err(400, "Send rows: [{period: 'YYYY-MM', revenue, ebitda, ...}]");
  if (rows.length > 120) throw err(400, "Up to 120 months at a time");
  const stamp = now(), stmts = [];
  for (const r of rows) {
    const period = String(r.period || "").slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw err(400, `Bad period "${r.period}": use YYYY-MM`);
    const vals = FIELDS.map((f) => num(r[f]));
    if (vals.every((v) => v == null)) continue;
    stmts.push(env.DB.prepare(`INSERT INTO actuals (account_id, target_id, period, ${FIELDS.join(", ")}, source, updated_at)
      VALUES (?1, ?2, ?3, ${FIELDS.map((_, i) => `?${i + 4}`).join(", ")}, ?${FIELDS.length + 4}, ?${FIELDS.length + 5})
      ON CONFLICT (account_id, target_id, period) DO UPDATE SET ${FIELDS.map((f) => `${f} = COALESCE(excluded.${f}, ${f})`).join(", ")}, source = excluded.source, updated_at = excluded.updated_at`)
      .bind(ctx.accountId, +targetId, period, ...vals, String(source).slice(0, 40), stamp));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { saved: stmts.length };
}

export async function deleteActual(env, ctx, targetId, period) {
  await env.DB.prepare("DELETE FROM actuals WHERE account_id = ?1 AND target_id = ?2 AND period = ?3").bind(ctx.accountId, +targetId, String(period)).run();
  return { ok: true };
}

export async function saveSnapshot(env, accountId, targetId, kind, data, source) {
  await env.DB.prepare("INSERT INTO snapshots (account_id, target_id, kind, taken_at, source, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(accountId, targetId, kind, now(), String(source || "").slice(0, 60), JSON.stringify(data).slice(0, 200000)).run();
}
export async function snapshots(env, accountId, targetId, kind) {
  const { results } = await env.DB.prepare("SELECT id, taken_at, source, data FROM snapshots WHERE account_id = ?1 AND target_id = ?2 AND kind = ?3 ORDER BY taken_at").bind(accountId, targetId, kind).all();
  return results.map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

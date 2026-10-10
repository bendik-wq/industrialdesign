// The approval queue: actions an agent wants to take that a person must OK first (sending email, autopilot moves).
const err = (status, message) => Object.assign(new Error(message), { status });

export async function propose(env, accountId, a) {
  // A target id from an agent or API caller must belong to this workspace (never trust it for a join).
  if (a.target_id && !(await env.DB.prepare("SELECT 1 FROM targets WHERE id = ?1 AND account_id = ?2").bind(+a.target_id, accountId).first())) a = { ...a, target_id: null };
  const r = await env.DB.prepare(`INSERT INTO agent_actions (account_id, target_id, tool, input, title, reason, source, dedupe, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT DO NOTHING RETURNING id`).bind(accountId, a.target_id || null, a.tool, JSON.stringify(a.input || {}), String(a.title || `Run ${a.tool}`).slice(0, 200), String(a.reason || "").slice(0, 500), String(a.source || "autopilot").slice(0, 40), a.dedupe || null, new Date().toISOString()).first();
  return r?.id || null;
}
export { err };

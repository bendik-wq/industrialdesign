// Autopilot and the approve-before-act inbox.
// Every morning (Cron Trigger) the autopilot looks at each workspace's pipeline and proposes the next moves: follow-ups
// for targets that went quiet, first letters for new targets, a weekly AI Board review. Nothing runs until a person
// approves it in the inbox; approving runs the tool as that person. A daily briefing goes out as a webhook
// (briefing.daily) so it can land in Slack, email or a CRM via Zapier/Make/n8n.
import { runTool, toolByName, overview } from "./tools.js";
import { aiEnv } from "./keys.js";
import { hookEmitter } from "./pipeline.js";
import { checkLimits } from "./usage.js";
import { toCtx } from "./auth.js";
import { propose } from "./approvals.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const MAX_PROPOSALS_PER_RUN = 8;

export async function getSetting(env, accountId, key, fallback) {
  const r = await env.DB.prepare("SELECT data FROM settings WHERE account_id = ?1 AND key = ?2").bind(accountId, key).first();
  return r ? JSON.parse(r.data) : fallback;
}
export async function setSetting(env, accountId, key, data) {
  await env.DB.prepare("INSERT INTO settings (account_id, key, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (account_id, key) DO UPDATE SET data = ?3, updated_at = ?4").bind(accountId, key, JSON.stringify(data), now()).run();
}

export { propose };

export async function listInbox(env, ctx, status = "pending") {
  const { results } = await env.DB.prepare(`SELECT a.id, a.target_id, a.tool, a.input, a.title, a.reason, a.source, a.status, a.result, a.created_at, a.decided_by, a.decided_at, t.name AS target_name
    FROM agent_actions a LEFT JOIN targets t ON t.id = a.target_id AND t.account_id = a.account_id WHERE a.account_id = ?1 AND (?2 = 'all' OR a.status = ?2) ORDER BY a.id DESC LIMIT 100`).bind(ctx.accountId, status).all();
  return results.map((r) => ({ ...r, input: JSON.parse(r.input), result: r.result ? JSON.parse(r.result) : null, write: !!toolByName(r.tool)?.write }));
}

export async function decide(env, ctx, id, approve, hooks) {
  const a = await env.DB.prepare("SELECT * FROM agent_actions WHERE id = ?1 AND account_id = ?2").bind(id, ctx.accountId).first();
  if (!a) throw err(404, "That proposal doesn't exist");
  if (a.status !== "pending") throw err(409, `Already ${a.status}`);
  const who = ctx.user.name || ctx.user.email;
  if (!approve) {
    await env.DB.prepare("UPDATE agent_actions SET status = 'dismissed', decided_by = ?3, decided_at = ?4 WHERE id = ?1 AND account_id = ?2").bind(id, ctx.accountId, who, now()).run();
    return { ok: true, status: "dismissed" };
  }
  // Claim it first so a double-click can't run it twice.
  const claimed = await env.DB.prepare("UPDATE agent_actions SET status = 'running', decided_by = ?3, decided_at = ?4 WHERE id = ?1 AND account_id = ?2 AND status = 'pending' RETURNING id").bind(id, ctx.accountId, who, now()).first();
  if (!claimed) throw err(409, "Someone is already handling this");
  const ai = await aiEnv(env, ctx);
  if (a.tool === "draft_document") { try { await checkLimits(env, ai, ctx); } catch (e) { await env.DB.prepare("UPDATE agent_actions SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = ?1").bind(id).run(); throw e; } }
  const r = await runTool(env, ctx, ai, hooks, a.tool, JSON.parse(a.input), { approved: true });
  await env.DB.prepare("UPDATE agent_actions SET status = ?3, result = ?4 WHERE id = ?1 AND account_id = ?2").bind(id, ctx.accountId, r.ok ? "done" : "failed", JSON.stringify(r.result).slice(0, 20000)).run();
  return { ok: r.ok, status: r.ok ? "done" : "failed", result: r.result };
}

// One workspace's morning run. Returns what it proposed.
export async function autopilotRun(env, accountId, exec) {
  const owner = await env.DB.prepare(`SELECT u.id, u.account_id, u.email, u.name, u.role, u.is_admin, u.session_epoch, a.name AS account_name, a.plan, a.max_territories, a.active AS account_active
    FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.account_id = ?1 AND a.active = 1 ORDER BY (u.role = 'owner') DESC, u.id LIMIT 1`).bind(accountId).first();
  if (!owner) return { skipped: "no users" };
  const ctx = toCtx(owner);
  const settings = await getSetting(env, accountId, "autopilot", { enabled: true });
  const ov = await overview(env, ctx);
  const proposals = [];
  if (settings.enabled) {
    const q = async (a) => { if (proposals.length >= MAX_PROPOSALS_PER_RUN) return; const id = await propose(env, accountId, a); if (id) proposals.push({ id, ...a }); };
    // Quiet targets in active conversation: draft a follow-up.
    const { results: quiet } = await env.DB.prepare(`SELECT id, name, stage, owner_name, CAST(julianday('now') - julianday(updated_at) AS INTEGER) AS days FROM targets
      WHERE account_id = ?1 AND stage IN ('contacted','first_call','meeting','docs','loi','diligence') AND updated_at < datetime('now', '-14 days') ORDER BY updated_at LIMIT 10`).bind(accountId).all();
    for (const t of quiet) await q({ target_id: t.id, tool: "draft_document", input: { kind: "outreach", target_id: t.id, channel: "email" }, title: `Draft a follow-up email to ${t.owner_name || t.name}`, reason: `${t.name} has had no activity for ${t.days} days. Deals die in silence.`, dedupe: `followup:${t.id}` });
    // New targets with nothing written yet: draft the first letter.
    const { results: fresh } = await env.DB.prepare(`SELECT t.id, t.name, t.owner_name FROM targets t WHERE t.account_id = ?1 AND t.stage = 'sourced' AND t.created_at < datetime('now', '-1 day')
      AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.target_id = t.id) ORDER BY t.priority, t.created_at LIMIT 5`).bind(accountId).all();
    for (const t of fresh) await q({ target_id: t.id, tool: "draft_document", input: { kind: "outreach", target_id: t.id, channel: "letter" }, title: `Write the first letter to ${t.owner_name || t.name}`, reason: `${t.name} is in your pipeline with no outreach yet.`, dedupe: `firstletter:${t.id}` });
    // Overdue next actions with no date discipline: push the date and flag it.
    for (const d of ov.overdue.slice(0, 5)) await q({ target_id: d.id, tool: "log_activity", input: { target_id: d.id, kind: "note", body: `Autopilot: “${d.next_action}” was due ${d.next_date} and hasn't been done.` }, title: `Flag the overdue action on ${d.name}`, reason: `“${d.next_action}” was due ${d.next_date}.`, dedupe: `overdue:${d.id}:${d.next_date}` });
    // Mondays: the AI Board reviews the pipeline.
    if (new Date().getUTCDay() === 1 && ov.live_targets > 0) await q({ tool: "draft_document", input: { kind: "board" }, title: "Hold this week's AI Board review", reason: "Weekly: the board votes pursue / pause / drop on every live target.", dedupe: `board:${new Date().toISOString().slice(0, 10)}` });
  }
  const hooks = hookEmitter(env, accountId, (p) => exec.waitUntil(p));
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE account_id = ?1 AND status = 'pending'").bind(accountId).first();
  hooks.emit("briefing.daily", { workspace: owner.account_name, overview: ov, new_proposals: proposals.map((p) => ({ id: p.id, title: p.title, reason: p.reason })), pending_approvals: pending.n });
  return { proposals: proposals.length, overdue: ov.overdue.length };
}

export async function autopilotAll(env, exec) {
  const { results } = await env.DB.prepare("SELECT DISTINCT account_id FROM targets").all();
  for (const r of results) {
    try { await autopilotRun(env, r.account_id, exec); } catch (e) { console.error(`autopilot account ${r.account_id}`, e); }
  }
}

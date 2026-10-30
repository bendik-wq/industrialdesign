// The multi-layer agent engine. An agent is a list of layers that run in order, each on its own queue message so a
// long run never hits a Worker time limit:
//   gather  → pull the facts (D1, uploaded files, the deal model, registries)
//   compute → deterministic maths in code (DSCR, cash runway, concentration); the model never does arithmetic alone
//   reason  → Claude reads the facts and the numbers, grounded in the JL skill, and returns structured findings
//   verify  → code checks the model's claims against the computed numbers; anything unsupported is dropped
//   act     → findings become alerts, a document, and proposed actions that wait in the Inbox for a person
// Every layer's output is stored (agent_steps), so the run shows its working and can be audited.
import { chat, chatJson } from "./ai.js";
import { aiEnv } from "./keys.js";
import { checkLimits, record } from "./usage.js";
import { propose } from "./approvals.js";
import { toCtx } from "./auth.js";
import { getTarget } from "./pipeline.js";
import { now } from "./http.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const DEFS = new Map();
export const MAX_FINDINGS = 40, MAX_PROPOSALS = 8;

// def: {id, name, needsTarget, stages?: [...] (target stages allowed), layers: [{id, title, kind, run(L)}], describe}
export function registerAgent(def) { DEFS.set(def.id, def); return def; }
export const agentDef = (id) => DEFS.get(id);
export const agentDefs = () => [...DEFS.values()];

export async function startRun(env, ctx, agentId, { targetId = null, input = {} } = {}, exec) {
  const def = DEFS.get(agentId);
  if (!def) throw err(404, "No such agent");
  let target = null;
  if (def.needsTarget) {
    if (!targetId) throw err(400, `${def.name} needs a target`);
    target = await getTarget(env, ctx, +targetId);
    if (def.stages && !def.stages.includes(target.stage)) throw err(400, `${def.name} runs on targets at: ${def.stages.join(", ")}`);
  }
  // One live run per agent and target at a time.
  const live = await env.DB.prepare("SELECT id FROM agent_runs WHERE account_id = ?1 AND agent = ?2 AND IFNULL(target_id, 0) = ?3 AND status IN ('queued','running')")
    .bind(ctx.accountId, agentId, target?.id || 0).first();
  if (live) return { id: live.id, already: true };
  const stamp = now();
  const run = await env.DB.prepare(`INSERT INTO agent_runs (account_id, target_id, agent, status, step, input, state, created_by, created_at, updated_at)
    VALUES (?1, ?2, ?3, 'queued', 0, ?4, '{}', ?5, ?6, ?6) RETURNING id`).bind(ctx.accountId, target?.id || null, agentId, JSON.stringify(input).slice(0, 20000), ctx.user.id || null, stamp).first();
  await kick(env, ctx.accountId, run.id, exec);
  return { id: run.id };
}

async function kick(env, accountId, runId, exec) {
  if (env.WORK) await env.WORK.send({ type: "run", accountId, runId });
  else if (exec) exec.waitUntil(stepRun(env, accountId, runId).then((r) => r?.more && kick(env, accountId, runId, exec)));
}

async function runCtx(env, accountId, userId) {
  const u = await env.DB.prepare(`SELECT u.id, u.account_id, u.email, u.name, u.role, u.is_admin, u.session_epoch, a.name AS account_name, a.plan, a.max_territories, a.active AS account_active
    FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.account_id = ?1 AND a.active = 1 ORDER BY (u.id = ?2) DESC, (u.role = 'owner') DESC, u.id LIMIT 1`).bind(accountId, userId || 0).first();
  if (!u) throw err(404, "Workspace not found");
  return toCtx(u);
}

// Runs the next layer of a run. Queue consumer calls this; it re-queues itself until the last layer is done.
export async function stepRun(env, accountId, runId, exec) {
  const run = await env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?1 AND account_id = ?2").bind(runId, accountId).first();
  if (!run || !["queued", "running"].includes(run.status)) return { more: false };
  const def = DEFS.get(run.agent);
  if (!def) { await fail(env, run, "Agent no longer exists"); return { more: false }; }
  const layer = def.layers[run.step];
  if (!layer) { await finish(env, run, JSON.parse(run.state)); return { more: false }; }
  // Claim the step so a duplicate queue delivery can't run it twice.
  const claim = await env.DB.prepare("UPDATE agent_runs SET status = 'running', updated_at = ?3 WHERE id = ?1 AND step = ?2 AND (status = 'queued' OR updated_at < ?4)")
    .bind(run.id, run.step, now(), new Date(Date.now() - 10 * 60_000).toISOString()).run();
  if (!claim.meta.changes) return { more: false };
  const ctx = await runCtx(env, accountId, run.created_by);
  const ai = await aiEnv(env, ctx);
  const state = JSON.parse(run.state || "{}");
  const target = run.target_id ? await getTarget(env, ctx, run.target_id).catch(() => null) : null;
  const tokens = { in: 0, out: 0 };
  const meter = async (feature, out) => { await record(env, ai, ctx, `agent:${run.agent}:${feature}`, out); tokens.in += out.usage?.input || 0; tokens.out += out.usage?.output || 0; };
  const L = {
    env, ctx, ai, run, def, target, input: JSON.parse(run.input || "{}"), state,
    // Metered model calls. `ask` returns parsed JSON against a schema; `write` returns prose.
    async ask(system, prompt, schema, maxTokens = 3000, effort = "medium") { await checkLimits(env, ai, ctx); const out = await chatJson(ai, system, prompt, schema, maxTokens, effort); await meter(layer.id, out); return out.data; },
    async write(system, prompt, maxTokens = 3000, effort = "medium") { await checkLimits(env, ai, ctx); const out = await chat(ai, system, [{ role: "user", content: prompt }], maxTokens, effort); await meter(layer.id, out); return out.text; },
  };
  const started = now();
  await env.DB.prepare("INSERT INTO agent_steps (run_id, n, layer, title, kind, status, started_at) VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6) ON CONFLICT (run_id, n) DO UPDATE SET status = 'running', started_at = ?6")
    .bind(run.id, run.step, layer.id, layer.title, layer.kind || "", started).run();
  let out;
  try { out = (await layer.run(L)) || {}; }
  catch (e) {
    await env.DB.prepare("UPDATE agent_steps SET status = 'failed', summary = ?3, finished_at = ?4 WHERE run_id = ?1 AND n = ?2").bind(run.id, run.step, String(e.message).slice(0, 500), now()).run();
    await fail(env, run, e.message);
    return { more: false };
  }
  state[layer.id] = out.data ?? null;
  if (out.findings) state._findings = [...(state._findings || []), ...out.findings].slice(0, MAX_FINDINGS);
  if (out.proposals) state._proposals = [...(state._proposals || []), ...out.proposals].slice(0, MAX_PROPOSALS);
  if (out.document) state._document = out.document;
  if (out.headline) state._headline = out.headline;
  await env.DB.batch([
    env.DB.prepare("UPDATE agent_steps SET status = 'done', summary = ?3, data = ?4, finished_at = ?5 WHERE run_id = ?1 AND n = ?2")
      .bind(run.id, run.step, String(out.summary || "").slice(0, 1000), JSON.stringify(out.data ?? null).slice(0, 60000), now()),
    env.DB.prepare("UPDATE agent_runs SET step = step + 1, status = 'queued', state = ?2, tokens_in = tokens_in + ?3, tokens_out = tokens_out + ?4, updated_at = ?5 WHERE id = ?1")
      .bind(run.id, JSON.stringify(state).slice(0, 400000), tokens.in, tokens.out, now()),
  ]);
  if (out.stop) { await finish(env, { ...run, step: run.step + 1 }, state, out.stop); return { more: false }; }
  if (run.step + 1 >= def.layers.length) { await finish(env, { ...run, step: run.step + 1 }, state); return { more: false }; }
  if (env.WORK) await env.WORK.send({ type: "run", accountId, runId: run.id });
  return { more: true };
}

async function fail(env, run, message) {
  await env.DB.prepare("UPDATE agent_runs SET status = 'failed', error = ?2, updated_at = ?3, finished_at = ?3 WHERE id = ?1").bind(run.id, String(message).slice(0, 500), now()).run();
}

// Turns the run's findings, document and proposals into things a person sees: alerts, a document, Inbox items.
async function finish(env, run, state, stopReason) {
  const stamp = now();
  const findings = state._findings || [];
  const stmts = [];
  for (const f of findings) {
    const dedupe = f.dedupe ? `${run.agent}:${run.target_id || 0}:${f.dedupe}` : null;
    stmts.push(env.DB.prepare(`INSERT INTO agent_findings (account_id, target_id, agent, run_id, severity, title, detail, evidence, metric, dedupe, status, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'open', ?11, ?11)
      ON CONFLICT (account_id, dedupe) WHERE status = 'open' AND dedupe IS NOT NULL DO UPDATE SET run_id = ?4, severity = ?5, title = ?6, detail = ?7, evidence = ?8, metric = ?9, updated_at = ?11`)
      .bind(run.account_id, run.target_id, run.agent, run.id, ["high", "medium", "low"].includes(f.severity) ? f.severity : "medium", String(f.title).slice(0, 200), String(f.detail || "").slice(0, 2000), String(f.evidence || "").slice(0, 1000), f.metric == null ? null : JSON.stringify(f.metric).slice(0, 2000), dedupe, stamp));
  }
  // Monitors resolve their own alerts: anything open from this agent on this target that this run didn't raise again.
  const def = DEFS.get(run.agent);
  if (def?.monitor) {
    const keep = findings.filter((f) => f.dedupe).map((f) => `${run.agent}:${run.target_id || 0}:${f.dedupe}`);
    stmts.push(env.DB.prepare(`UPDATE agent_findings SET status = 'resolved', resolved_at = ?4, updated_at = ?4 WHERE account_id = ?1 AND agent = ?2 AND IFNULL(target_id, 0) = ?3 AND status = 'open'
      AND dedupe IS NOT NULL AND dedupe NOT IN (SELECT value FROM json_each(?5))`).bind(run.account_id, run.agent, run.target_id || 0, stamp, JSON.stringify(keep)));
  }
  if (stmts.length) await env.DB.batch(stmts);
  let documentId = null;
  if (state._document?.content) {
    const d = state._document;
    const row = await env.DB.prepare("INSERT INTO documents (account_id, target_id, kind, title, content, meta, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) RETURNING id")
      .bind(run.account_id, run.target_id, d.kind || run.agent, String(d.title).slice(0, 200), d.content, JSON.stringify({ run_id: run.id, agent: run.agent, ...(d.meta || {}) }), run.created_by, stamp).first();
    documentId = row.id;
    if (run.target_id) await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'doc', ?5, ?6)")
      .bind(run.account_id, run.target_id, run.created_by, def?.name || "Agent", `${def?.name || "Agent"}: ${d.title}`, stamp).run();
  }
  const proposed = [];
  for (const p of (state._proposals || []).slice(0, MAX_PROPOSALS)) {
    const id = await propose(env, run.account_id, { target_id: p.target_id ?? run.target_id, tool: p.tool, input: p.input, title: p.title, reason: p.reason, source: `agent:${run.agent}`, dedupe: p.dedupe ? `${run.agent}:${p.dedupe}` : null });
    if (id) proposed.push(id);
  }
  const summary = { headline: state._headline || stopReason || "", findings: findings.length, high: findings.filter((f) => f.severity === "high").length, document_id: documentId, proposals: proposed };
  await env.DB.prepare("UPDATE agent_runs SET status = 'done', summary = ?2, updated_at = ?3, finished_at = ?3 WHERE id = ?1").bind(run.id, JSON.stringify(summary), stamp).run();
}

export async function getRun(env, ctx, id) {
  const run = await env.DB.prepare("SELECT id, target_id, agent, status, step, input, summary, error, tokens_in, tokens_out, created_at, updated_at, finished_at FROM agent_runs WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId).first();
  if (!run) throw err(404, "Run not found");
  const def = DEFS.get(run.agent);
  const [steps, findings] = await env.DB.batch([
    env.DB.prepare("SELECT n, layer, title, kind, status, summary, data, started_at, finished_at FROM agent_steps WHERE run_id = ?1 ORDER BY n").bind(run.id),
    env.DB.prepare("SELECT id, severity, title, detail, evidence, metric, status FROM agent_findings WHERE run_id = ?1 AND account_id = ?2 ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id").bind(run.id, ctx.accountId),
  ]);
  return {
    ...run, input: JSON.parse(run.input || "{}"), summary: run.summary ? JSON.parse(run.summary) : null,
    name: def?.name, layers: (def?.layers || []).map((l) => ({ id: l.id, title: l.title, kind: l.kind })),
    steps: steps.results.map((s) => ({ ...s, data: s.data ? JSON.parse(s.data) : null })),
    findings: findings.results.map((f) => ({ ...f, metric: f.metric ? JSON.parse(f.metric) : null })),
  };
}

export async function listRuns(env, ctx, { targetId, agent, limit = 30 } = {}) {
  const { results } = await env.DB.prepare(`SELECT r.id, r.target_id, t.name AS target_name, r.agent, r.status, r.step, r.summary, r.error, r.created_at, r.finished_at
    FROM agent_runs r LEFT JOIN targets t ON t.id = r.target_id WHERE r.account_id = ?1 AND (?2 IS NULL OR r.target_id = ?2) AND (?3 IS NULL OR r.agent = ?3) ORDER BY r.id DESC LIMIT ?4`)
    .bind(ctx.accountId, targetId ? +targetId : null, agent || null, Math.min(100, +limit || 30)).all();
  return results.map((r) => ({ ...r, name: DEFS.get(r.agent)?.name || r.agent, layers: DEFS.get(r.agent)?.layers.length || 0, summary: r.summary ? JSON.parse(r.summary) : null }));
}

export async function listFindings(env, ctx, { targetId, status = "open", limit = 100 } = {}) {
  const { results } = await env.DB.prepare(`SELECT f.id, f.target_id, t.name AS target_name, f.agent, f.run_id, f.severity, f.title, f.detail, f.evidence, f.metric, f.status, f.created_at, f.updated_at
    FROM agent_findings f LEFT JOIN targets t ON t.id = f.target_id WHERE f.account_id = ?1 AND (?2 IS NULL OR f.target_id = ?2) AND f.status = ?3
    ORDER BY CASE f.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, f.updated_at DESC LIMIT ?4`).bind(ctx.accountId, targetId ? +targetId : null, status, Math.min(300, +limit || 100)).all();
  return results.map((f) => ({ ...f, agent_name: DEFS.get(f.agent)?.name || f.agent, metric: f.metric ? JSON.parse(f.metric) : null }));
}

export async function setFinding(env, ctx, id, status) {
  if (!["resolved", "dismissed", "open"].includes(status)) throw err(400, "Bad status");
  const r = await env.DB.prepare("UPDATE agent_findings SET status = ?3, resolved_at = CASE WHEN ?3 = 'open' THEN NULL ELSE ?4 END, updated_at = ?4 WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId, status, now()).run();
  if (!r.meta.changes) throw err(404, "Finding not found");
  return { ok: true };
}

// When a monitor last finished on this target (scheduled runs skip the model when nothing changed since then).
export async function lastDone(env, accountId, agent, targetId) {
  const r = await env.DB.prepare("SELECT created_at FROM agent_runs WHERE account_id = ?1 AND agent = ?2 AND target_id = ?3 AND status = 'done' ORDER BY id DESC LIMIT 1").bind(accountId, agent, targetId).first();
  return r?.created_at || null;
}

// Monitors (def.monitor = true) re-run on the daily cron for every target they watch.
export async function queueMonitors(env, exec) {
  const monitors = agentDefs().filter((d) => d.monitor);
  if (!monitors.length) return;
  for (const d of monitors) {
    const { results } = await env.DB.prepare(`SELECT t.account_id, t.id FROM targets t JOIN accounts a ON a.id = t.account_id AND a.active = 1
      WHERE t.stage IN (SELECT value FROM json_each(?1)) AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.agent = ?2 AND r.target_id = t.id AND r.created_at > ?3) LIMIT 500`)
      .bind(JSON.stringify(d.monitorStages || d.stages || ["closed"]), d.id, new Date(Date.now() - 20 * 3600_000).toISOString()).all();
    for (const t of results) {
      const owner = await runCtx(env, t.account_id, null).catch(() => null);
      if (owner) await startRun(env, owner, d.id, { targetId: t.id, input: { scheduled: true } }, exec).catch((e) => console.error("monitor", d.id, t.id, e.message));
    }
  }
}

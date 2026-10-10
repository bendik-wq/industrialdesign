// Documents the agents write, shared by the REST API, Josh's tools, the MCP server and the autopilot.
import { generate } from "./desk.js";
import { getTarget } from "./pipeline.js";
import { checkLimits, record } from "./usage.js";
import { now, displayName } from "./http.js";

export async function getProfile(env, ctx) {
  if (!ctx.user.id) return {};
  const r = await env.DB.prepare("SELECT data FROM user_state WHERE user_id = ?1 AND key = 'profile'").bind(ctx.user.id).first();
  return r ? JSON.parse(r.data) : {};
}

// Have an agent write a document and store it. `ai` is the workspace's AI env (keys.js aiEnv).
export async function createDocument(env, ctx, ai, b, hooks, { skipLimits = false } = {}) {
  let target = null;
  if (b.target_id) target = await getTarget(env, ctx, +b.target_id);
  if (!skipLimits) await checkLimits(env, ai, ctx);
  const profile = await getProfile(env, ctx);
  const doc = await generate(ai, ctx, String(b.kind || ""), target, profile, { channel: b.channel, language: String(b.language || "").slice(0, 40), financials: b.financials });
  await record(env, ai, ctx, `doc:${doc.kind}`, doc.out);
  const stamp = now();
  const row = await env.DB.prepare("INSERT INTO documents (account_id, target_id, kind, title, content, meta, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) RETURNING id, kind, title, target_id, created_at")
    .bind(ctx.accountId, target?.id || null, doc.kind, doc.title, doc.content, JSON.stringify(doc.meta), ctx.user.id || null, stamp).first();
  if (target) await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'doc', ?5, ?6)")
    .bind(ctx.accountId, target.id, ctx.user.id || null, displayName(ctx), `Generated: ${doc.title}`, stamp).run();
  hooks.emit("document.created", { document: row });
  return { ...row, content: doc.content, meta: doc.meta, model: doc.out.model };
}

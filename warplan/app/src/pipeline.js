// The deal pipeline: acquisition targets, their timeline, and outgoing webhooks for the workspace's own systems.
import { STAGES, normalizeDeal } from "../public/js/deal.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const STAGE_IDS = new Set(STAGES.map((s) => s.id));
const EVENT_KINDS = new Set(["note", "call", "email", "meeting", "stage", "doc"]);

// Editable fields and how to clean them. Anything else in a request body is ignored.
const text = (max) => (v) => String(v ?? "").trim().slice(0, max);
const num = (v) => (v === "" || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const int = (v) => { const x = num(v); return x == null ? null : Math.round(x); };
const FIELDS = {
  name: text(140), industry: text(80), location: text(120), website: text(200), owner_name: text(120), owner_age: int,
  phone: text(40), email: text(160), employees: int, revenue: num, ebitda: num, asking: num, currency: (v) => (["$", "€", "£", "NOK "].includes(v) ? v : "$"),
  stage: (v) => (STAGE_IDS.has(v) ? v : "sourced"), priority: (v) => ([1, 2, 3].includes(Number(v)) ? Number(v) : 2),
  source: text(80), motivation: text(2000), next_action: text(300), next_date: (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : null),
  deal: (v) => (v && typeof v === "object" ? JSON.stringify(normalizeDeal(v)) : null), tags: text(200), lost_reason: text(300),
};
const PUBLIC_COLS = ["id", ...Object.keys(FIELDS), "created_at", "updated_at", "stage_at", "created_by"];

function clean(b, partial) {
  const out = {};
  for (const [k, f] of Object.entries(FIELDS)) if (k in b) out[k] = f(b[k]);
  if (!partial && !out.name) throw err(400, "Give the target a name");
  if ("name" in out && !out.name) throw err(400, "The name can't be empty");
  if (out.website && !/^https?:\/\//i.test(out.website)) out.website = `https://${out.website}`;
  return out;
}

export function rowToTarget(r) {
  if (!r) return r;
  return { ...r, deal: r.deal ? JSON.parse(r.deal) : null };
}

async function own(env, ctx, id) {
  const t = await env.DB.prepare(`SELECT ${PUBLIC_COLS.join(", ")} FROM targets WHERE id = ?1 AND account_id = ?2`).bind(id, ctx.accountId).first();
  if (!t) throw err(404, "Target not found");
  return rowToTarget(t);
}

export async function listTargets(env, ctx, q) {
  const stage = q.get("stage"), search = (q.get("q") || "").trim();
  const { results } = await env.DB.prepare(
    `SELECT t.${PUBLIC_COLS.join(", t.")},
       (SELECT body FROM target_events e WHERE e.target_id = t.id AND e.kind != 'stage' ORDER BY e.id DESC LIMIT 1) AS last_note,
       (SELECT COUNT(*) FROM documents d WHERE d.target_id = t.id) AS docs
     FROM targets t WHERE t.account_id = ?1 AND (?2 IS NULL OR t.stage = ?2)
       AND (?3 = '' OR t.name LIKE ?4 OR t.industry LIKE ?4 OR t.location LIKE ?4 OR t.owner_name LIKE ?4 OR t.tags LIKE ?4)
     ORDER BY t.priority, t.updated_at DESC LIMIT 1000`
  ).bind(ctx.accountId, stage || null, search, `%${search}%`).all();
  return results.map(rowToTarget);
}

export async function getTarget(env, ctx, id) {
  const t = await own(env, ctx, id);
  const [events, docs, threads] = await env.DB.batch([
    env.DB.prepare("SELECT id, kind, body, user_name, created_at FROM target_events WHERE target_id = ?1 AND account_id = ?2 ORDER BY id DESC LIMIT 200").bind(id, ctx.accountId),
    env.DB.prepare("SELECT id, kind, title, created_at, updated_at FROM documents WHERE target_id = ?1 AND account_id = ?2 ORDER BY id DESC").bind(id, ctx.accountId),
    env.DB.prepare("SELECT id, agent, title, meta, updated_at FROM threads WHERE account_id = ?1 AND json_extract(meta, '$.target') = ?2 ORDER BY updated_at DESC LIMIT 30").bind(ctx.accountId, id),
  ]);
  return { ...t, events: events.results, documents: docs.results, threads: threads.results.map((x) => ({ ...x, meta: JSON.parse(x.meta) })) };
}

const who = (ctx) => ctx.user.name || ctx.user.email;
const event = (env, ctx, targetId, kind, body) =>
  env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(ctx.accountId, targetId, ctx.user.id || null, who(ctx), kind, body, now());

export async function createTarget(env, ctx, b, hooks) {
  const f = clean(b, false);
  const cols = Object.keys(f);
  const t = await env.DB.prepare(`INSERT INTO targets (account_id, created_by, ${cols.join(", ")}, created_at, updated_at, stage_at) VALUES (?1, ?2, ${cols.map((_, i) => `?${i + 3}`).join(", ")}, ?${cols.length + 3}, ?${cols.length + 3}, ?${cols.length + 3}) RETURNING ${PUBLIC_COLS.join(", ")}`)
    .bind(ctx.accountId, ctx.user.id || null, ...cols.map((k) => f[k]), now()).first();
  await event(env, ctx, t.id, "stage", `Added to the pipeline as ${STAGES.find((s) => s.id === t.stage).label}`).run();
  hooks.emit("target.created", { target: rowToTarget(t) });
  return rowToTarget(t);
}

export async function updateTarget(env, ctx, id, b, hooks) {
  const before = await own(env, ctx, id);
  const f = clean(b, true);
  const cols = Object.keys(f);
  if (!cols.length) return before;
  const stageChanged = "stage" in f && f.stage !== before.stage;
  const sets = cols.map((k, i) => `${k} = ?${i + 3}`);
  sets.push(`updated_at = ?${cols.length + 3}`);
  if (stageChanged) sets.push(`stage_at = ?${cols.length + 3}`);
  const t = await env.DB.prepare(`UPDATE targets SET ${sets.join(", ")} WHERE id = ?1 AND account_id = ?2 RETURNING ${PUBLIC_COLS.join(", ")}`)
    .bind(id, ctx.accountId, ...cols.map((k) => f[k]), now()).first();
  if (stageChanged) {
    const from = STAGES.find((s) => s.id === before.stage)?.label, to = STAGES.find((s) => s.id === f.stage)?.label;
    await event(env, ctx, id, "stage", `Moved from ${from} to ${to}${f.stage === "lost" && f.lost_reason ? `: ${f.lost_reason}` : ""}`).run();
    hooks.emit("target.stage_changed", { target: rowToTarget(t), from: before.stage, to: f.stage });
  } else hooks.emit("target.updated", { target: rowToTarget(t), fields: cols });
  return rowToTarget(t);
}

export async function deleteTarget(env, ctx, id, hooks) {
  const t = await own(env, ctx, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM target_events WHERE target_id = ?1 AND account_id = ?2").bind(id, ctx.accountId),
    env.DB.prepare("DELETE FROM documents WHERE target_id = ?1 AND account_id = ?2").bind(id, ctx.accountId),
    env.DB.prepare("DELETE FROM targets WHERE id = ?1 AND account_id = ?2").bind(id, ctx.accountId),
  ]);
  hooks.emit("target.deleted", { id, name: t.name });
  return { ok: true };
}

export async function addEvent(env, ctx, id, b, hooks) {
  await own(env, ctx, id);
  const kind = EVENT_KINDS.has(b.kind) && b.kind !== "stage" ? b.kind : "note";
  const body = String(b.body || "").trim().slice(0, 8000);
  if (!body) throw err(400, "Write something first");
  const e = await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id, kind, body, user_name, created_at")
    .bind(ctx.accountId, id, ctx.user.id || null, who(ctx), kind, body, now()).first();
  await env.DB.prepare("UPDATE targets SET updated_at = ?3 WHERE id = ?1 AND account_id = ?2").bind(id, ctx.accountId, now()).run();
  hooks.emit("target.note_added", { target_id: id, event: e });
  return e;
}

export async function deleteEvent(env, ctx, id, eid) {
  await env.DB.prepare("DELETE FROM target_events WHERE id = ?1 AND target_id = ?2 AND account_id = ?3 AND kind != 'stage'").bind(eid, id, ctx.accountId).run();
  return { ok: true };
}

// Bulk import (rows already parsed from CSV in the browser, or sent by an API client). Max 500 per call.
export async function importTargets(env, ctx, b, hooks) {
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 500) : [];
  if (!rows.length) throw err(400, "No rows to import");
  const stamp = now(), made = [], skipped = [];
  const stmts = [];
  rows.forEach((r, i) => {
    let f;
    try { f = clean(r, false); } catch (e) { skipped.push({ row: i + 1, reason: e.message }); return; }
    const cols = Object.keys(f);
    stmts.push(env.DB.prepare(`INSERT INTO targets (account_id, created_by, ${cols.join(", ")}, created_at, updated_at, stage_at) VALUES (?1, ?2, ${cols.map((_, j) => `?${j + 3}`).join(", ")}, ?${cols.length + 3}, ?${cols.length + 3}, ?${cols.length + 3}) RETURNING id, name`)
      .bind(ctx.accountId, ctx.user.id || null, ...cols.map((k) => f[k]), stamp));
  });
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await env.DB.batch(stmts.slice(i, i + 50));
    res.forEach((x) => made.push(x.results[0]));
  }
  if (made.length) hooks.emit("target.imported", { count: made.length });
  return { imported: made.length, skipped };
}

const CSV_COLS = ["name", "industry", "location", "website", "owner_name", "owner_age", "phone", "email", "employees", "revenue", "ebitda", "asking", "currency", "stage", "priority", "source", "next_action", "next_date", "tags", "motivation", "created_at", "updated_at"];
export async function exportCsv(env, ctx) {
  const rows = await listTargets(env, ctx, new URLSearchParams());
  const cell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  // Prefix formula-looking cells so spreadsheets don't execute them.
  const safe = (v) => (typeof v === "string" && /^[=+\-@]/.test(v) ? `'${v}` : v);
  const body = [CSV_COLS.join(","), ...rows.map((r) => CSV_COLS.map((c) => cell(safe(r[c]))).join(","))].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="warplan-pipeline-${now().slice(0, 10)}.csv"` } });
}

// One line per active target, for Josh and the AI Board to reason about the pipeline.
export async function pipelineBrief(env, ctx, limit = 25) {
  const { results } = await env.DB.prepare(`SELECT id, name, industry, location, owner_name, owner_age, revenue, ebitda, asking, currency, stage, priority, next_action, next_date, motivation
    FROM targets WHERE account_id = ?1 AND stage NOT IN ('lost') ORDER BY priority, updated_at DESC LIMIT ?2`).bind(ctx.accountId, limit).all();
  if (!results.length) return "";
  const m = (v, c) => (v == null ? "?" : `${c}${Math.round(v / 1000)}k`);
  return results.map((t) => `#${t.id} ${t.name} (${[t.industry, t.location].filter(Boolean).join(", ") || "no details"}) · stage ${STAGES.find((s) => s.id === t.stage)?.label} · revenue ${m(t.revenue, t.currency)}, EBITDA ${m(t.ebitda, t.currency)}${t.asking ? `, asking ${m(t.asking, t.currency)}` : ""}${t.owner_name ? ` · owner ${t.owner_name}${t.owner_age ? ` (${t.owner_age})` : ""}` : ""}${t.next_action ? ` · next: ${t.next_action}${t.next_date ? ` by ${t.next_date}` : ""}` : ""}${t.motivation ? ` · motivation: ${t.motivation.slice(0, 160)}` : ""}`).join("\n");
}

export function targetFacts(t) {
  const m = (v) => (v == null ? "unknown" : `${t.currency}${Number(v).toLocaleString("en-US")}`);
  return [
    `Company: ${t.name}`, t.industry && `Industry: ${t.industry}`, t.location && `Location: ${t.location}`, t.website && `Website: ${t.website}`,
    `Owner: ${t.owner_name || "unknown"}${t.owner_age ? `, age ${t.owner_age}` : ""}`, t.employees != null && `Employees: ${t.employees}`,
    `Revenue: ${m(t.revenue)} · EBITDA: ${m(t.ebitda)} · Asking: ${m(t.asking)}`,
    `Stage: ${STAGES.find((s) => s.id === t.stage)?.label}`, t.motivation && `What we know about the owner's motivation: ${t.motivation}`,
    t.next_action && `Next action: ${t.next_action}${t.next_date ? ` (by ${t.next_date})` : ""}`, t.source && `Source: ${t.source}`,
  ].filter(Boolean).join("\n");
}

// ------------------------------------------------------------------ webhooks
export const HOOK_EVENTS = ["target.created", "target.updated", "target.stage_changed", "target.note_added", "target.deleted", "target.imported", "document.created", "call.debriefed"];

async function sign(secret, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function deliver(env, hook, type, data) {
  const body = JSON.stringify({ type, created_at: now(), data });
  const ts = Math.floor(Date.now() / 1000);
  let status = 0;
  try {
    const r = await fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Warplan-Webhooks/1", "X-Warplan-Event": type, "X-Warplan-Timestamp": String(ts), "X-Warplan-Signature": `sha256=${await sign(hook.secret, `${ts}.${body}`)}` },
      body,
      signal: AbortSignal.timeout(8000),
    });
    status = r.status;
  } catch { status = 0; }
  await env.DB.prepare("UPDATE webhooks SET last_status = ?2, last_at = ?3 WHERE id = ?1").bind(hook.id, status, now()).run();
  return status;
}

// A per-request emitter: collects events and delivers them after the response (ctx.waitUntil).
export function hookEmitter(env, accountId, waitUntil) {
  let hooks = null;
  return {
    emit(type, data) {
      waitUntil((async () => {
        hooks ??= (await env.DB.prepare("SELECT * FROM webhooks WHERE account_id = ?1 AND active = 1").bind(accountId).all()).results;
        await Promise.all(hooks.filter((h) => h.events === "*" || h.events.split(",").includes(type)).map((h) => deliver(env, h, type, data)));
      })().catch((e) => console.warn("webhook", e.message)));
    },
  };
}

export async function listHooks(env, ctx) {
  const { results } = await env.DB.prepare("SELECT id, url, events, active, created_at, last_status, last_at FROM webhooks WHERE account_id = ?1 ORDER BY id").bind(ctx.accountId).all();
  return { hooks: results, events: HOOK_EVENTS };
}

export async function createHook(env, ctx, b) {
  let url;
  try { url = new URL(String(b.url || "")); } catch { throw err(400, "Enter a full https:// URL"); }
  if (url.protocol !== "https:") throw err(400, "Webhooks must use https://");
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(url.hostname) || url.hostname.endsWith(".internal")) throw err(400, "That address isn't reachable from the internet");
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE account_id = ?1").bind(ctx.accountId).first()).n;
  if (n >= 10) throw err(400, "Ten webhooks is the limit; remove one first");
  const events = Array.isArray(b.events) && b.events.length ? b.events.filter((e) => HOOK_EVENTS.includes(e)).join(",") || "*" : "*";
  const secret = `whsec_${[...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  const h = await env.DB.prepare("INSERT INTO webhooks (account_id, url, secret, events, created_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id, url, events, active, created_at")
    .bind(ctx.accountId, url.toString(), secret, events, now()).first();
  return { ...h, secret }; // the signing secret is shown once
}

export async function testHook(env, ctx, id) {
  const h = await env.DB.prepare("SELECT * FROM webhooks WHERE id = ?1 AND account_id = ?2").bind(id, ctx.accountId).first();
  if (!h) throw err(404, "Webhook not found");
  const status = await deliver(env, h, "ping", { message: "Test delivery from Warplan" });
  return { status, ok: status >= 200 && status < 300 };
}

export async function deleteHook(env, ctx, id) {
  await env.DB.prepare("DELETE FROM webhooks WHERE id = ?1 AND account_id = ?2").bind(id, ctx.accountId).run();
  return { ok: true };
}

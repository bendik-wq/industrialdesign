// Long-running Monid work that finishes in the background (a cron every 10 minutes, or "check now"):
//   meeting  Recall.ai bot joins a Zoom / Meet / Teams call with an owner, records it; when it ends we fetch the
//            transcript and the AI writes meeting notes onto the target (facts, motivations, numbers, next steps).
//   ai_call  Saperly AI assistant line (your own US number with an AI persona, compliance disclosure always on)
//            places a call, e.g. to find out who owns a business and when they're free; the transcript and the
//            AI's read of it land on the timeline. Every AI call waits for a person's approval first.
import { run, result, monidKey } from "./monid.js";
import { getTarget, updateTarget, hookEmitter } from "./pipeline.js";
import { chatJson } from "./ai.js";
import { aiEnv } from "./keys.js";
import { safeFetch } from "./net.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();

async function addJob(env, ctx, kind, runId, targetId, meta) {
  const r = await env.DB.prepare("INSERT INTO jobs (account_id, user_id, target_id, kind, run_id, meta, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) RETURNING id")
    .bind(ctx.accountId, ctx.user.id || null, targetId || null, kind, runId, JSON.stringify(meta || {}), now()).first();
  return r.id;
}
export async function listJobs(env, ctx) {
  const { results } = await env.DB.prepare("SELECT j.id, j.kind, j.status, j.target_id, j.meta, j.result, j.created_at, j.updated_at, t.name AS target_name FROM jobs j LEFT JOIN targets t ON t.id = j.target_id AND t.account_id = j.account_id WHERE j.account_id = ?1 ORDER BY j.id DESC LIMIT 30").bind(ctx.accountId).all();
  return results.map((j) => ({ ...j, meta: JSON.parse(j.meta), result: j.result ? JSON.parse(j.result) : null }));
}

// ------------------------------------------------------------------ meeting recorder
export async function recordMeeting(env, ctx, b) {
  const url = String(b.meeting_url || "").trim();
  if (!/^https:\/\/([\w-]+\.)*(zoom\.us|zoom\.com|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com)\//i.test(url)) throw err(400, "Paste a Zoom, Google Meet, Teams or Webex meeting link");
  const target = b.target_id ? await getTarget(env, ctx, +b.target_id) : null;
  const minutes = Math.max(10, Math.min(180, +b.max_minutes || 90));
  const join = b.join_at && !Number.isNaN(Date.parse(b.join_at)) ? new Date(b.join_at).toISOString() : undefined;
  const r = await run(env, ctx, { provider: "recall", endpoint: "/meetings/record", input: { body: { meeting_url: url, max_duration_minutes: minutes, bot_name: String(b.bot_name || "Notetaker").slice(0, 60), transcript_model: "recallai", ...(join && { join_at: join }) } } },
    { purpose: `Record meeting${target ? ` with ${target.name}` : ""}`, targetId: target?.id || null, maxWaitMs: 1500 });
  const id = await addJob(env, ctx, "meeting", r.run_id, target?.id, { url, minutes, join_at: join || null });
  return { job_id: id, run_id: r.run_id, status: r.status, receipt: `The notetaker ${join ? `joins at ${join}` : "is joining now"}${target ? ` (${target.name})` : ""}. Notes land on the timeline when the meeting ends. Billed at about $0.50 an hour of meeting.` };
}

// ------------------------------------------------------------------ AI assistant line (Saperly)
const PERSONA = `You are a polite, brief assistant calling a local business on behalf of a business owner who buys and keeps well-run companies. Your goals, in order: 1) find out the name of the business owner, 2) find out the best way and time to reach them directly, 3) if you reach the owner, ask if they'd be open to a short call with your principal next week. Never discuss price, valuation or selling on the phone; if asked why, say your principal is a local business owner who'd like to introduce himself. If they ask not to be called, apologise and end the call. Keep the whole call under 2 minutes.`;
export async function setupAssistantLine(env, ctx, b) {
  const area = /^\d{3}$/.test(String(b.area_code || "")) ? String(b.area_code) : undefined;
  const r = await run(env, ctx, { provider: "saperly", endpoint: "/provision-numbers", input: { body: { country: "US", phoneNumber: { numberType: "local", ...(area && { areaCode: area }) }, connection: { name: String(b.name || "Warplan assistant").slice(0, 120), instructions: String(b.instructions || PERSONA).slice(0, 10000), language: "en", complianceEnabled: true } } } }, { purpose: "AI assistant phone line" });
  return { number: r.output?.phoneNumber || r.output?.number || null, id: r.output?.resourceId || r.output?.id || null, receipt: "AI assistant line ready (renews monthly)" };
}
async function assistantNumber(env, ctx) {
  const r = await run(env, ctx, { provider: "saperly", endpoint: "/list-numbers", input: {} }, { purpose: "AI line lookup" });
  const list = Array.isArray(r.output) ? r.output : r.output?.items || r.output?.numbers || r.output?.data || [];
  const n = list.find((x) => !x.state || /active/i.test(x.state)) || list[0];
  if (!n) throw err(400, "Set up an AI assistant line first (Dialer → AI assistant line), about $1 a month");
  return { id: n.resourceId || n.id, number: n.phoneNumber || n.number };
}
export async function aiCall(env, ctx, b) {
  const to = String(b.to || "").replace(/[\s().-]/g, "");
  if (!/^\+1\d{10}$/.test(to)) throw err(400, "AI calls go to US and Canadian numbers in +1 format for now");
  const target = b.target_id ? await getTarget(env, ctx, +b.target_id) : null;
  if (await env.DB.prepare("SELECT 1 FROM suppressions WHERE account_id = ?1 AND email = ?2").bind(ctx.accountId, `tel:${to}`).first()) throw err(400, `${to} asked not to be contacted`);
  const line = await assistantNumber(env, ctx);
  const goal = String(b.instructions || "").trim().slice(0, 2000);
  const r = await run(env, ctx, { provider: "saperly", endpoint: "/place-calls", input: { body: { fromNumberId: line.id, to, ...(goal && { instructions: `${PERSONA}\n\nFor this call: ${goal}${target ? `\nThe business: ${target.name}${target.location ? `, ${target.location}` : ""}.` : ""}` }) } } },
    { purpose: `AI call${target ? ` to ${target.name}` : ""}`, targetId: target?.id || null, maxWaitMs: 1500 });
  const id = await addJob(env, ctx, "ai_call", r.run_id, target?.id, { to, numberId: line.id, from: line.number, goal });
  return { job_id: id, run_id: r.run_id, status: r.status, receipt: `AI assistant is calling ${target?.name || to}. The transcript lands on the timeline after the call.` };
}

// ------------------------------------------------------------------ finishing jobs
const NOTES_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "facts", "owner_motivation", "numbers_mentioned", "next_steps", "next_action", "days_until_next", "owner_name"],
  properties: {
    summary: { type: "string" }, facts: { type: "array", items: { type: "string" } }, owner_motivation: { type: "string" },
    numbers_mentioned: { type: "array", items: { type: "string" } }, next_steps: { type: "array", items: { type: "string" } },
    next_action: { type: "string" }, days_until_next: { type: "integer" }, owner_name: { type: ["string", "null"] },
  },
};

function transcriptText(data) {
  // Recall: [{participant:{name}, words:[{text}]}]; Saperly: [{role|speaker, text|content}] or {transcript:[...]} or a string.
  const rows = Array.isArray(data) ? data : data?.transcript || data?.turns || data?.messages || data?.items || [];
  if (typeof data === "string") return data;
  if (typeof rows === "string") return rows;
  return rows.map((x) => `${x.participant?.name || x.speaker || x.role || "Speaker"}: ${Array.isArray(x.words) ? x.words.map((w) => w.text).join(" ") : x.text || x.content || ""}`).join("\n");
}
function findUrl(o, re) {
  let hit = null;
  const walk = (v, k = "") => { if (hit || v == null) return; if (typeof v === "string" && /^https:\/\//.test(v) && re.test(k)) hit = v; else if (typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, kk); };
  walk(o); return hit;
}

async function finish(env, job, ctx) {
  const r = await result(env, ctx, job.run_id);
  if (!["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"].includes(r.status)) return null;
  const meta = JSON.parse(job.meta);
  if (r.status !== "COMPLETED") return { status: "failed", result: { error: r.status.toLowerCase() } };
  let text = "";
  if (job.kind === "meeting") {
    const url = findUrl(r.output, /transcript/i);
    if (url) { const res = await safeFetch(url, {}, { httpsOnly: true }); if (res.ok) text = transcriptText(await res.json().catch(async () => res.text())); }
  } else {
    const callId = r.output?.callId || r.output?.id || r.output?.call?.id;
    if (callId) {
      const tr = await run(env, ctx, { provider: "saperly", endpoint: "/calls/{id}/transcript", input: { body: { numberId: meta.numberId, callId } } }, { purpose: "AI call transcript", targetId: job.target_id }).catch(() => null);
      text = transcriptText(tr?.output);
    }
  }
  if (!text.trim()) return { status: "done", result: { note: "No transcript (the meeting didn't happen or nobody answered)", cost_usd: r.cost_usd } };
  const ai = await aiEnv(env, ctx);
  const t = job.target_id ? await getTarget(env, ctx, job.target_id).catch(() => null) : null;
  let notes;
  try {
    ({ data: notes } = await chatJson(ai, `You take notes for a buyer of small private companies after a ${job.kind === "meeting" ? "meeting with a business owner" : "phone call placed by an AI assistant to a business"}. Be factual: only what was said. Capture the owner's name if stated, motivations (retirement, health, family, staff), any numbers (revenue, profit, staff, price ideas), objections and promised next steps.`,
      `${t ? `Company: ${t.name} (${t.location || ""})\n` : ""}Transcript:\n${text.slice(0, 30000)}`, NOTES_SCHEMA, 2000, "low"));
  } catch { notes = { summary: text.slice(0, 600), facts: [], owner_motivation: "", numbers_mentioned: [], next_steps: [], next_action: "Review the transcript", days_until_next: 1, owner_name: null }; }
  if (t) {
    const hooks = hookEmitter(env, ctx.accountId, () => {});
    const body = `${job.kind === "meeting" ? "Meeting notes (recorded)" : `AI call to ${meta.to}`}: ${notes.summary}${notes.facts.length ? `\n\nFacts:\n- ${notes.facts.join("\n- ")}` : ""}${notes.owner_motivation ? `\n\nMotivation: ${notes.owner_motivation}` : ""}${notes.numbers_mentioned.length ? `\n\nNumbers: ${notes.numbers_mentioned.join("; ")}` : ""}${notes.next_steps.length ? `\n\nNext steps:\n- ${notes.next_steps.join("\n- ")}` : ""}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(ctx.accountId, t.id, ctx.user.id || null, job.kind === "meeting" ? "Notetaker" : "AI assistant", job.kind === "meeting" ? "meeting" : "call", body.slice(0, 8000), now()),
      env.DB.prepare("INSERT INTO documents (account_id, target_id, kind, title, content, meta, created_by, created_at, updated_at) VALUES (?1, ?2, 'transcript', ?3, ?4, '{}', ?5, ?6, ?6)").bind(ctx.accountId, t.id, `${job.kind === "meeting" ? "Meeting" : "AI call"} transcript: ${t.name}`, `# ${job.kind === "meeting" ? "Meeting" : "AI call"} transcript\n\n${body}\n\n## Transcript\n\n${text.slice(0, 90000)}`, ctx.user.id || null, now()),
    ]);
    const fields = { next_action: String(notes.next_action || "").slice(0, 300), next_date: new Date(Date.now() + Math.max(0, Math.min(90, +notes.days_until_next || 1)) * 864e5).toISOString().slice(0, 10) };
    if (notes.owner_name && !t.owner_name) fields.owner_name = notes.owner_name.slice(0, 120);
    await updateTarget(env, ctx, t.id, fields, hooks);
  }
  return { status: "done", result: { summary: notes.summary, next_action: notes.next_action, cost_usd: r.cost_usd } };
}

// Check open jobs: all workspaces (cron) or one (check now). Never throws.
export async function processJobs(env, accountId = null) {
  const { results } = await env.DB.prepare(`SELECT j.*, u.email, u.name, u.role FROM jobs j LEFT JOIN users u ON u.id = j.user_id WHERE j.status = 'running' AND (?1 IS NULL OR j.account_id = ?1) AND j.created_at < ?2 ORDER BY j.id LIMIT 25`)
    .bind(accountId, new Date(Date.now() - 30_000).toISOString()).all();
  let done = 0;
  for (const job of results) {
    const ctx = { accountId: job.account_id, user: { id: job.user_id, name: job.name, email: job.email, role: job.role }, isOwner: job.role === "owner" };
    try {
      if (!(await monidKey(env, ctx))) continue;
      const out = await finish(env, job, ctx);
      if (out) { await env.DB.prepare("UPDATE jobs SET status = ?2, result = ?3, updated_at = ?4 WHERE id = ?1").bind(job.id, out.status, JSON.stringify(out.result), now()).run(); done++; }
      // Give up on jobs nobody can finish after a day.
      else if (Date.parse(job.created_at) < Date.now() - 864e5 * (job.kind === "meeting" ? 8 : 1)) await env.DB.prepare("UPDATE jobs SET status = 'failed', result = '{\"error\":\"timed out\"}', updated_at = ?2 WHERE id = ?1").bind(job.id, now()).run();
    } catch (e) { console.warn("job", job.id, e.message); }
  }
  return { checked: results.length, finished: done };
}

// Power dialer: a call queue built from every pipeline target with a phone number, one-key dispositions that move
// the target on (stage, next action, callback date), and two ways to dial:
//   phone   a tel: link: the call goes out from the user's own phone or softphone, Warplan logs it.
//   twilio  click-to-call bridge with the workspace's Twilio account: Twilio rings the user's phone first, then
//           connects the seller, showing the Twilio number. Nothing is recorded.
import { getTarget, updateTarget } from "./pipeline.js";
import { providerKeys } from "./keys.js";
import { STAGES } from "../public/js/deal.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const ymd = (days) => { const d = new Date(Date.now() + days * 864e5); if (days > 0) { while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); } return d.toISOString().slice(0, 10); };
const idx = (id) => STAGES.findIndex((s) => s.id === id);

// What each outcome does to the target. stage = move forward to at least this stage.
export const DISPOSITIONS = {
  no_answer: { label: "No answer", key: "1", next: "Call again", days: 1 },
  voicemail: { label: "Left voicemail", key: "2", next: "Call again (left a voicemail)", days: 2 },
  gatekeeper: { label: "Gatekeeper", key: "3", next: "Call back and ask for the owner", days: 1 },
  callback: { label: "Call back later", key: "4", next: "Callback", days: 1 },
  connected: { label: "Spoke, no next step", key: "5", next: "Follow up", days: 7, stage: "contacted" },
  interested: { label: "Interested", key: "6", next: "Book the first proper call", days: 1, stage: "first_call", priority: 1 },
  meeting: { label: "Meeting booked", key: "7", next: "Meeting", days: 3, stage: "meeting", priority: 1 },
  not_interested: { label: "Not interested", key: "8", next: "Check back in 6 months", days: 180, priority: 3, stage: "contacted" },
  wrong_number: { label: "Wrong number", key: "9", next: "Find a working number", days: 0 },
};

// Phone numbers per target: the target's own plus every phone the contact finder or deep enrich found (owner first).
export async function queue(env, ctx, q) {
  const stage = q.get("stage"), term = q.get("q") ? `%${q.get("q")}%` : null, fresh = q.get("fresh") === "1";
  const { results } = await env.DB.prepare(`
    SELECT t.id, t.name, t.industry, t.location, t.owner_name, t.owner_age, t.stage, t.priority, t.next_action, t.next_date, t.phone, t.website, t.currency, t.motivation,
      (SELECT COUNT(*) FROM calls c WHERE c.target_id = t.id) AS calls,
      (SELECT MAX(created_at) FROM calls c WHERE c.target_id = t.id) AS last_call,
      (SELECT disposition FROM calls c WHERE c.target_id = t.id ORDER BY id DESC LIMIT 1) AS last_disposition,
      (SELECT group_concat(value || '|' || label, '¦') FROM (SELECT value, label FROM contacts c WHERE c.target_id = t.id AND c.kind = 'phone' ORDER BY CASE WHEN label LIKE '%owner%' THEN 0 ELSE 1 END, id)) AS phones
    FROM targets t
    WHERE t.account_id = ?1 AND t.stage NOT IN ('closed', 'lost') AND (?2 IS NULL OR t.stage = ?2)
      AND (?3 IS NULL OR t.name LIKE ?3 OR t.industry LIKE ?3 OR t.location LIKE ?3 OR t.tags LIKE ?3)
      AND (t.phone != '' OR EXISTS (SELECT 1 FROM contacts c WHERE c.target_id = t.id AND c.kind = 'phone'))
      AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM calls c WHERE c.target_id = t.id AND c.created_at >= ?5))
      AND (t.next_action NOT LIKE 'Opted out%')
    ORDER BY CASE WHEN t.next_date IS NOT NULL AND t.next_date <= ?6 THEN 0 ELSE 1 END, t.priority, CASE WHEN last_call IS NULL THEN 0 ELSE 1 END, last_call, t.next_date
    LIMIT 300`).bind(ctx.accountId, stage || null, term, fresh ? 1 : 0, now().slice(0, 10), now().slice(0, 10)).all();
  const twilio = !!(await providerKeys(env, ctx, ["twilio"])).twilio;
  return {
    twilio, dispositions: DISPOSITIONS,
    queue: results.map((r) => {
      const phones = [];
      if (r.phone) phones.push({ value: r.phone, label: "Main" });
      for (const p of (r.phones || "").split("¦").filter(Boolean)) { const [value, label] = p.split("|"); if (!phones.some((x) => digits(x.value) === digits(value))) phones.push({ value, label: label || "" }); }
      const { phones: _p, phone: _ph, ...rest } = r;
      return { ...rest, phones };
    }),
  };
}
const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^00/, "");

export async function logCall(env, ctx, b, hooks) {
  const t = await getTarget(env, ctx, +b.target_id);
  const d = DISPOSITIONS[b.disposition];
  if (!d) throw err(400, "Pick how the call went");
  const phone = String(b.phone || t.phone || "").slice(0, 40), notes = String(b.notes || "").trim().slice(0, 4000);
  const duration = b.duration != null ? Math.max(0, Math.min(36000, Math.round(+b.duration) || 0)) : null;
  const stamp = now();
  const call = await env.DB.prepare("INSERT INTO calls (account_id, user_id, target_id, phone, via, call_sid, disposition, notes, duration, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id")
    .bind(ctx.accountId, ctx.user.id || null, t.id, phone, b.via === "twilio" ? "twilio" : "phone", b.call_sid ? String(b.call_sid).slice(0, 64) : null, b.disposition, notes, duration, stamp).first();
  const mins = duration ? ` · ${Math.floor(duration / 60)}m${String(duration % 60).padStart(2, "0")}s` : "";
  await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'call', ?5, ?6)")
    .bind(ctx.accountId, t.id, ctx.user.id || null, ctx.user.name || ctx.user.email, `${d.label}${mins} (${phone})${notes ? `: ${notes}` : ""}`, stamp).run();

  const fields = {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.next_date || "")) ? b.next_date : ymd(d.days);
  if (b.disposition === "callback" && notes) fields.next_action = `Callback: ${notes.slice(0, 120)}`;
  else fields.next_action = d.next;
  fields.next_date = d.days || b.next_date ? date : ymd(0);
  if (d.stage && idx(t.stage) < idx(d.stage)) fields.stage = d.stage;
  if (d.priority) fields.priority = d.priority;
  if (b.disposition === "wrong_number" && phone) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM contacts WHERE account_id = ?1 AND target_id = ?2 AND kind = 'phone' AND value = ?3").bind(ctx.accountId, t.id, phone),
      env.DB.prepare("UPDATE targets SET phone = '' WHERE id = ?1 AND account_id = ?2 AND phone = ?3").bind(t.id, ctx.accountId, phone),
    ]);
  }
  const updated = await updateTarget(env, ctx, t.id, fields, hooks);
  hooks.emit("call.logged", { target_id: t.id, target: t.name, disposition: b.disposition, notes, duration });
  return { id: call.id, target: { id: updated.id, stage: updated.stage, next_action: updated.next_action, next_date: updated.next_date }, receipt: `Logged “${d.label}” for ${t.name}; next: ${fields.next_action} (${fields.next_date})` };
}

export async function callHistory(env, ctx, q) {
  const { results } = await env.DB.prepare(`SELECT c.id, c.target_id, t.name AS target_name, c.phone, c.via, c.disposition, c.notes, c.duration, c.created_at, u.name AS user_name
    FROM calls c JOIN targets t ON t.id = c.target_id LEFT JOIN users u ON u.id = c.user_id WHERE c.account_id = ?1 AND (?2 IS NULL OR c.target_id = ?2) ORDER BY c.id DESC LIMIT 100`).bind(ctx.accountId, q.get("target") ? +q.get("target") : null).all();
  const today = now().slice(0, 10);
  const mine = results.filter((r) => r.created_at >= today);
  return { calls: results, today: { dials: mine.length, connects: mine.filter((r) => ["connected", "interested", "meeting", "not_interested", "callback"].includes(r.disposition)).length, meetings: mine.filter((r) => r.disposition === "meeting").length } };
}

// ------------------------------------------------------------------ Twilio bridge
const COUNTRY_BY_CURRENCY = { "NOK ": "47", "£": "44", "$": "1" };
export function e164(raw, currency) {
  let s = String(raw || "").trim().replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (/^\+\d{8,15}$/.test(s)) return s;
  const d = s.replace(/\D/g, ""), cc = COUNTRY_BY_CURRENCY[currency];
  if (cc === "47" && d.length === 8) return `+47${d}`;
  if (cc === "1" && d.length === 10) return `+1${d}`;
  if (cc === "1" && d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (cc === "44" && d.length === 11 && d.startsWith("0")) return `+44${d.slice(1)}`;
  return null;
}
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

async function twilio(env, ctx) {
  const k = (await providerKeys(env, ctx, ["twilio"])).twilio;
  if (!k?.meta?.sid) throw err(400, "Connect Twilio under Settings → Integrations to dial from Warplan (or use your phone)");
  return { ...k.meta, auth: `Basic ${btoa(`${k.meta.sid}:${k.key}`)}` };
}
async function twilioReq(tw, path, form) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.sid}${path}`, { method: form ? "POST" : "GET", headers: { Authorization: tw.auth, ...(form && { "Content-Type": "application/x-www-form-urlencoded" }) }, body: form ? new URLSearchParams(form) : undefined });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401) throw err(400, "Twilio rejected the credentials");
  if (!res.ok) throw err(400, `Twilio: ${d.message || `answered ${res.status}`}`);
  return d;
}

export async function startBridge(env, ctx, b) {
  const t = await getTarget(env, ctx, +b.target_id);
  const tw = await twilio(env, ctx);
  const to = e164(b.phone || t.phone, t.currency);
  if (!to) throw err(400, "Save the number in +country format (e.g. +4791234567) so Twilio can dial it");
  const twiml = `<Response><Say>Connecting you to ${xml(t.name).slice(0, 80)}.</Say><Dial callerId="${xml(tw.from)}" timeout="35" answerOnBridge="true"><Number>${xml(to)}</Number></Dial></Response>`;
  const call = await twilioReq(tw, "/Calls.json", { To: tw.agentPhone, From: tw.from, Twiml: twiml, Timeout: "25" });
  return { call_sid: call.sid, status: call.status, dialing: to, ringing: tw.agentPhone.replace(/\d(?=\d{3})/g, "•") };
}
export async function bridgeStatus(env, ctx, sid) {
  if (!/^CA[0-9a-f]{32}$/i.test(sid)) throw err(400, "Bad call id");
  const c = await twilioReq(await twilio(env, ctx), `/Calls/${sid}.json`);
  return { status: c.status, duration: c.duration != null ? +c.duration : null };
}
export async function hangup(env, ctx, sid) {
  if (!/^CA[0-9a-f]{32}$/i.test(sid)) throw err(400, "Bad call id");
  const c = await twilioReq(await twilio(env, ctx), `/Calls/${sid}.json`, { Status: "completed" });
  return { status: c.status };
}

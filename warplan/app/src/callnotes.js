// AI call notes. When a workspace turns recording on (Dialer → Settings, off by default), Twilio records each
// Twilio call (browser or bridge) after the owner hears a short notice that the call is recorded. When the
// recording is ready, Twilio calls our signed webhook; we transcribe it (Workers AI Whisper) and the AI writes the
// notes: a summary, the outcome it heard, the next step, a callback time if one was agreed, facts about the owner
// and the business, objections. The dialer shows them under the call; they land on the target's timeline too.
// Consent: the notice plays to every recorded call, so it works in all-party-consent places (CA, FL, WA, AU…).
import { transcribe, chatJson } from "./ai.js";
import { aiEnv } from "./keys.js";
import { twilio, DISPOSITIONS } from "./dialer.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
export const DEFAULT_NOTICE = "Hi, just so you know, this call is recorded.";
const MAX_AUDIO = 20 * 1024 * 1024;

// Built on first use: dialer.js and this module import each other.
const schema = () => ({
  type: "object", additionalProperties: false,
  required: ["summary", "outcome", "next_step", "callback_when", "notes", "owner_facts", "objections", "sentiment"],
  properties: {
    summary: { type: "string", description: "2-3 sentences: who you spoke to and what happened" },
    outcome: { type: "string", enum: Object.keys(DISPOSITIONS), description: "The outcome that best matches the call" },
    next_step: { type: "string", description: "The one next action, concrete" },
    callback_when: { type: ["string", "null"], description: "If a callback time was agreed, as said (e.g. 'Tuesday 10am'); else null" },
    notes: { type: "string", description: "Notes for the CRM, as bullet points starting with '- '" },
    owner_facts: { type: "array", items: { type: "string" }, description: "Facts about the owner, family, staff, timing, health, plans" },
    objections: { type: "array", items: { type: "string" } },
    sentiment: { type: "string", enum: ["warm", "neutral", "cold"] },
  },
});
const SYSTEM = `You write call notes for a buyer of small private businesses who cold-calls owners about selling one day. From the transcript of one phone call (the buyer and whoever answered: owner, receptionist or voicemail), write accurate, specific notes. Never invent anything not said. If nobody answered or it was voicemail, say so and pick that outcome. "gatekeeper" = spoke to staff, not the owner. Use the owner's own words for timing and plans.`;

// The TwiML pieces a recorded <Dial> needs, or null when recording is off.
export async function recordingTwiml(env, accountId, base, to, userId) {
  const s = await env.DB.prepare("SELECT data FROM settings WHERE account_id = ?1 AND key = 'dialer'").bind(accountId).first();
  const cfg = s ? JSON.parse(s.data) : {};
  if (!cfg.record) return null;
  const q = new URLSearchParams({ to, ...(userId && { uid: String(userId) }) });
  return { dialAttrs: ` record="record-from-answer-dual" recordingStatusCallback="${base}/recording?${q.toString().replace(/&/g, "&amp;")}" recordingStatusCallbackEvent="completed"`, numberUrl: `${base}/notice`, notice: cfg.record_notice || DEFAULT_NOTICE };
}

// Twilio's recording-ready webhook (already signature-checked by the caller).
export async function recordingReady(env, accountId, params, query, defer, findByPhone) {
  const sid = params.get("RecordingSid"), callSid = params.get("CallSid"), url = params.get("RecordingUrl");
  if (!/^RE[0-9a-f]{32}$/i.test(sid || "") || !/^CA[0-9a-f]{32}$/i.test(callSid || "") || !/^https:\/\/api\.twilio\.com\//.test(url || "")) return;
  const to = String(query.get("to") || "").slice(0, 20), uid = +query.get("uid") || null;
  const t = to ? await findByPhone(env, accountId, to) : null;
  const row = await env.DB.prepare(`INSERT INTO call_recordings (account_id, user_id, target_id, call_sid, recording_sid, recording_url, phone, duration, status, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'transcribing', ?9, ?9) ON CONFLICT (account_id, call_sid) DO UPDATE SET recording_sid = ?5, recording_url = ?6, duration = ?8, updated_at = ?9 RETURNING id`)
    .bind(accountId, uid, t?.id || null, callSid, sid, url, to, +params.get("RecordingDuration") || 0, now()).first();
  defer(processRecording(env, accountId, row.id).catch((e) => console.error("call notes", e)));
}

export async function processRecording(env, accountId, id) {
  const rec = await env.DB.prepare("SELECT * FROM call_recordings WHERE id = ?1 AND account_id = ?2").bind(id, accountId).first();
  if (!rec) return;
  const ctx = { accountId, user: { id: rec.user_id, name: "AI notes" }, isOwner: false };
  const fail = (msg) => env.DB.prepare("UPDATE call_recordings SET status = 'failed', error = ?3, updated_at = ?4 WHERE id = ?1 AND account_id = ?2").bind(id, accountId, String(msg).slice(0, 300), now()).run();
  try {
    if ((rec.duration || 0) < 4) { await env.DB.prepare("UPDATE call_recordings SET status = 'done', summary = ?3, updated_at = ?4 WHERE id = ?1 AND account_id = ?2").bind(id, accountId, JSON.stringify({ summary: "Too short to transcribe.", outcome: "no_answer" }), now()).run(); return; }
    const tw = await twilio(env, ctx);
    const res = await fetch(`${rec.recording_url}.mp3`, { headers: { Authorization: tw.auth } });
    if (!res.ok) return fail(`Twilio recording download answered ${res.status}`);
    const audio = new Uint8Array(await res.arrayBuffer());
    if (audio.length > MAX_AUDIO) return fail("Recording too long to transcribe (over ~40 minutes)");
    const { text } = await transcribe(env, audio, "Phone call: a buyer calls a business owner about one day selling the business. Receptionist, voicemail, callback, owner, practice, clinic.");
    if (!text) return fail("Nothing intelligible in the recording");
    const ai = await aiEnv(env, ctx);
    const { data } = await chatJson(ai, SYSTEM, `Call length ${rec.duration}s.\n\nTRANSCRIPT:\n${text.slice(0, 24000)}`, schema(), 1200, "low");
    await env.DB.prepare("UPDATE call_recordings SET status = 'done', transcript = ?3, summary = ?4, updated_at = ?5 WHERE id = ?1 AND account_id = ?2").bind(id, accountId, text.slice(0, 60000), JSON.stringify(data), now()).run();
    if (rec.target_id) {
      const body = `AI call notes (${Math.round(rec.duration / 60) || "<1"} min): ${data.summary}${data.next_step ? ` Next: ${data.next_step}.` : ""}${data.owner_facts?.length ? `\n${data.owner_facts.map((f) => `- ${f}`).join("\n")}` : ""}`;
      await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, 'AI notes', 'call', ?4, ?5)").bind(accountId, rec.target_id, rec.user_id, body.slice(0, 4000), now()).run();
    }
  } catch (e) { await fail(e.status ? e.message : "Couldn't write the notes"); }
}

// What the dialer polls after a call: pending → transcribing → done (or failed).
export async function callNotes(env, ctx, callSid) {
  if (!/^CA[0-9a-f]{32}$/i.test(callSid || "")) throw err(400, "Bad call id");
  const r = await env.DB.prepare("SELECT id, status, summary, error, duration, recording_sid FROM call_recordings WHERE account_id = ?1 AND call_sid = ?2").bind(ctx.accountId, callSid).first();
  if (!r) return { status: "pending" };
  return { id: r.id, status: r.status, duration: r.duration, error: r.error, notes: r.summary ? JSON.parse(r.summary) : null, audio: r.recording_sid ? `/api/calls/recordings/${r.id}/audio` : null };
}

// Play a recording back without exposing the Twilio credentials.
export async function recordingAudio(env, ctx, id) {
  const r = await env.DB.prepare("SELECT recording_url FROM call_recordings WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId).first();
  if (!r?.recording_url) throw err(404, "No such recording");
  const tw = await twilio(env, ctx);
  const res = await fetch(`${r.recording_url}.mp3`, { headers: { Authorization: tw.auth } });
  if (!res.ok) throw err(502, `Twilio answered ${res.status}`);
  return new Response(res.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, no-store" } });
}

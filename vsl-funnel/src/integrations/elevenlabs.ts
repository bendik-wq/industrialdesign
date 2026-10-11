import type { Runtime } from '../app';
import { AI_CALLER, BRAND, CALL_CONSENT, FAQS, outboundSystemPrompt } from '../config';
import { hmacHex, safeEqual } from '../lib/crypto';
import { newId } from '../lib/ids';
import { type Lead, effectiveTier, getLead, parseAnswers, updateLead } from '../funnel/leads';
import type { Settings } from '../settings';
import { identityFromLead, track } from '../tracking/track';
import { formatCallTime } from './email';
import { notify, leadLines, leadName } from './notify';
import { optOut, sendLinkEmail } from './voice';

/**
 * Outbound AI calls on ElevenLabs Agents (https://elevenlabs.io/docs/agents-platform).
 *
 *  - confirm:       ~2 min after a booking, confirm the time and prep them for the call.
 *  - speed_to_lead: ~5 min after a qualified (A/B) application with no booking,
 *                   say hi and email the booking link if they want it.
 *
 * Guard rails, checked when the call is queued AND again right before dialling:
 * the lead ticked the call-consent box, hasn't asked not to be called, has a
 * phone number, it's inside local calling hours, and attempts are capped.
 *
 * Results arrive via the post-call webhook (/hooks/elevenlabs) when it's set up,
 * and are otherwise fetched by the 5-minute cron — so nothing depends on it.
 */

const API = 'https://api.elevenlabs.io';
export type CallKind = 'confirm' | 'speed_to_lead' | 'test';

export interface OutboundCall {
  id: string;
  lead_id: string;
  kind: CallKind;
  status: 'queued' | 'dialing' | 'done' | 'no_answer' | 'failed' | 'skipped' | 'cancelled';
  run_at: number;
  attempts: number;
  conversation_id: string | null;
  call_sid: string | null;
  outcome: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export const elevenConfigured = (s: Settings) => Boolean(s.ELEVENLABS_API_KEY && s.ELEVENLABS_AGENT_ID && s.ELEVENLABS_PHONE_NUMBER_ID);
const enabled = (v: string) => v.trim().toLowerCase() !== 'false';

async function el<T>(s: Settings, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'xi-api-key': s.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new ElevenError(res.status, text.slice(0, 600));
  return (text ? JSON.parse(text) : {}) as T;
}
export class ElevenError extends Error {
  constructor(public status: number, public body: string) {
    super(`ElevenLabs ${status}: ${body}`);
  }
}

// ───────────── agent ─────────────

/** What the call records about the lead. Read back from analysis.data_collection_results. */
export const DATA_COLLECTION = {
  reached_person: { type: 'boolean', description: 'True if a real person (the lead) answered and spoke. False for voicemail, an automated system, or no one.' },
  reached_voicemail: { type: 'boolean', description: 'True if the call went to voicemail or an answering machine.' },
  appointment_confirmed: { type: 'boolean', description: 'True only if the person said their booked strategy call time works for them.' },
  wants_reschedule: { type: 'boolean', description: 'True if the person said they need a different time for their strategy call.' },
  wants_booking_link: { type: 'boolean', description: 'True if the person said they want the link to book a strategy call emailed to them.' },
  do_not_call: { type: 'boolean', description: 'True if the person asked not to be called again, to be removed, or to stop being contacted.' },
  bad_time: { type: 'boolean', description: 'True if the person said it was a bad time to talk.' },
  questions: { type: 'string', description: 'Any questions or concerns the person raised, in one short sentence. Empty if none.' },
  notes_for_closer: { type: 'string', description: 'Anything useful for the closer before the strategy call (goals, target business type, timeline, partner joining). One or two sentences. Empty if nothing.' },
} as const;

export function buildAgent(s: Settings) {
  const builtIns = {
    end_call: { name: 'end_call', description: 'End the call when the conversation is finished, the person asks to stop, or after leaving a voicemail.', params: { system_tool_type: 'end_call' } },
  };
  return {
    name: `${BRAND.name} — appointment confirmations`,
    tags: ['funnel', 'outbound'],
    conversation_config: {
      agent: {
        first_message: AI_CALLER.firstMessage,
        language: 'en',
        prompt: { prompt: outboundSystemPrompt(FAQS), ...(s.ELEVENLABS_LLM ? { llm: s.ELEVENLABS_LLM } : {}), built_in_tools: builtIns },
        dynamic_variables: { dynamic_variable_placeholders: placeholderVars() },
      },
      ...(s.ELEVENLABS_VOICE_ID ? { tts: { voice_id: s.ELEVENLABS_VOICE_ID } } : {}),
      conversation: { max_duration_seconds: AI_CALLER.maxDurationSeconds },
    },
    platform_settings: {
      data_collection: DATA_COLLECTION,
      evaluation: {
        criteria: [{ id: 'goal', name: 'Goal reached', type: 'prompt', conversation_goal_prompt: 'The call is successful if the person confirmed their appointment, asked for a new time or the booking link, or clearly declined. Unsuccessful if nobody was reached or the call broke down.' }],
      },
    },
  };
}

const VAR_KEYS = ['first_name', 'opening', 'call_kind', 'call_time', 'closer_name', 'business', 'tier', 'email', 'lead_ref'] as const;
const placeholderVars = () => Object.fromEntries(VAR_KEYS.map((k) => [k, k === 'opening' ? 'Have you got a minute?' : ''])) as Record<(typeof VAR_KEYS)[number], string>;

/** Creates the agent in ElevenLabs, or updates the one already saved. Returns its id. */
export async function provisionAgent(rt: Runtime): Promise<{ id: string; created: boolean }> {
  const s = rt.settings;
  if (!s.ELEVENLABS_API_KEY) throw new Error('Add your ElevenLabs API key under Integrations → Voice first.');
  const body = buildAgent(s);
  // Older/newer API versions differ on a few optional fields; fall back to the bare agent if they're rejected.
  const lean = (b: ReturnType<typeof buildAgent>) => {
    const c = structuredClone(b) as unknown as { conversation_config: { agent: { prompt: Record<string, unknown> } & Record<string, unknown> }; platform_settings: Record<string, unknown> };
    delete c.conversation_config.agent.prompt.built_in_tools;
    delete c.conversation_config.agent.dynamic_variables;
    delete c.platform_settings.evaluation;
    return c;
  };
  const send = async (b: unknown) =>
    s.ELEVENLABS_AGENT_ID
      ? (await el<{ agent_id?: string }>(s, `/v1/convai/agents/${encodeURIComponent(s.ELEVENLABS_AGENT_ID)}`, { method: 'PATCH', body: b }), { id: s.ELEVENLABS_AGENT_ID, created: false })
      : { id: (await el<{ agent_id: string }>(s, '/v1/convai/agents/create', { method: 'POST', body: b })).agent_id, created: true };
  try {
    return await send(body);
  } catch (e) {
    if (e instanceof ElevenError && e.status === 422) return send(lean(body));
    throw e;
  }
}

export interface PhoneNumber { phone_number: string; label: string | null; phone_number_id: string; provider: string }
export const listPhoneNumbers = (s: Settings) => el<PhoneNumber[]>(s, '/v1/convai/phone-numbers');

// ───────────── consent, hours, queue ─────────────

const COUNTRY_TZ: Record<string, string> = {
  AU: 'Australia/Sydney', NZ: 'Pacific/Auckland', US: 'America/New_York', CA: 'America/Toronto', GB: 'Europe/London', IE: 'Europe/Dublin',
  SG: 'Asia/Singapore', AE: 'Asia/Dubai', ZA: 'Africa/Johannesburg', NO: 'Europe/Oslo', DE: 'Europe/Berlin', NL: 'Europe/Amsterdam',
};
export const leadTimezone = (lead: Pick<Lead, 'timezone' | 'country'>, fallback: string) => lead.timezone || COUNTRY_TZ[lead.country ?? ''] || fallback || 'UTC';

/** Is `t` inside calling hours in `tz`? */
export function inCallingHours(t: number, tz: string) {
  let wd: string, hour: number, minute: number;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(t);
    const get = (k: string) => parts.find((p) => p.type === k)!.value;
    wd = get('weekday'); hour = Number(get('hour')); minute = Number(get('minute'));
  } catch {
    return false;
  }
  const h = hour + minute / 60;
  const win = wd === 'Sun' ? null : wd === 'Sat' ? AI_CALLER.hours.saturday : AI_CALLER.hours.weekday;
  return Boolean(win && h >= win[0] && h < win[1]);
}

/** The first moment at or after `t` that's inside calling hours (15-minute steps, up to 4 days). */
export function nextCallingTime(t: number, tz: string) {
  for (let i = 0, x = t; i < 4 * 96; i++, x = Math.ceil((x + 1) / 900_000) * 900_000) if (inCallingHours(x, tz)) return x;
  return null;
}

/** Why we can't call this lead right now (or null if we can). */
export function blockReason(lead: Lead, kind: CallKind): string | null {
  if (!lead.phone) return 'no phone number';
  if (lead.do_not_call_at) return 'asked not to be called';
  if (kind !== 'test' && !lead.call_consent_at) return 'no call consent';
  if (kind === 'confirm' && (lead.status !== 'booked' || !lead.booked_at || lead.booking_cancelled_at)) return 'no longer booked';
  if (kind === 'confirm' && lead.call_at && lead.call_at < Date.now() + 30 * 60_000) return 'call is too soon';
  if (kind === 'speed_to_lead' && (lead.booked_at && !lead.booking_cancelled_at)) return 'already booked';
  if (kind === 'speed_to_lead' && !['A', 'B'].includes(effectiveTier(lead) ?? '')) return 'not qualified';
  return null;
}

/** Queues a call for later (deduped: one live call per lead per kind). */
export async function queueCall(rt: Runtime, lead: Lead, kind: CallKind, delayMinutes: number) {
  const s = rt.settings;
  if (!elevenConfigured(s)) return null;
  if (kind === 'confirm' && !enabled(s.AI_CALL_CONFIRM)) return null;
  if (kind === 'speed_to_lead' && !enabled(s.AI_CALL_SPEED_TO_LEAD)) return null;
  if (blockReason(lead, kind)) return null;
  const done = await rt.env.DB.prepare(`SELECT id FROM outbound_calls WHERE lead_id = ? AND kind = ? AND status IN ('queued', 'dialing', 'done') LIMIT 1`).bind(lead.id, kind).first();
  if (done) return null;
  const tz = leadTimezone(lead, s.SALES_TIMEZONE);
  const runAt = nextCallingTime(Date.now() + delayMinutes * 60_000, tz);
  if (!runAt) return null;
  if (kind === 'confirm' && lead.call_at && runAt > lead.call_at - 2 * 3600_000) return null; // reminders by email cover it
  if (kind === 'speed_to_lead' && runAt > Date.now() + 72 * 3600_000) return null; // stale by then (a weekend applicant still gets a Monday-morning call)
  const id = newId('oc');
  const now = Date.now();
  await rt.env.DB.prepare(`INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, attempts, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, 0, ?, ?)`)
    .bind(id, lead.id, kind, runAt, now, now).run();
  return id;
}

export async function cancelCalls(rt: Runtime, leadId: string, kinds: CallKind[] = ['confirm', 'speed_to_lead']) {
  await rt.env.DB.prepare(`UPDATE outbound_calls SET status = 'cancelled', updated_at = ? WHERE lead_id = ? AND status = 'queued' AND kind IN (${kinds.map(() => '?').join(',')})`)
    .bind(Date.now(), leadId, ...kinds).run();
}

function variables(rt: Runtime, lead: Lead, kind: CallKind) {
  const rep = rt.reps.find((r) => r.id === lead.closer_id);
  const tz = leadTimezone(lead, rt.settings.SALES_TIMEZONE);
  const callTime = lead.call_at ? formatCallTime(lead.call_at, tz).replace(/ [A-Z]{2,5}$/, '') : '';
  const closer = rep?.name ?? 'Josh’s team';
  const opening =
    kind === 'speed_to_lead'
      ? 'I saw your application come through a few minutes ago. Have you got a minute?'
      : `I’m calling about the strategy call you just booked${callTime ? ` for ${callTime}` : ''}. Have you got thirty seconds?`;
  const answers = parseAnswers(lead);
  return {
    first_name: lead.first_name || 'there',
    opening,
    call_kind: kind === 'test' ? 'confirm' : kind,
    call_time: callTime || 'the time you picked',
    closer_name: closer,
    business: typeof answers.business === 'string' ? answers.business.slice(0, 200) : '',
    tier: effectiveTier(lead) ?? '',
    email: lead.email ?? '',
    lead_ref: lead.ref_code,
  };
}

async function phoneProvider(rt: Runtime) {
  try {
    const nums = await listPhoneNumbers(rt.settings);
    return nums.find((n) => n.phone_number_id === rt.settings.ELEVENLABS_PHONE_NUMBER_ID)?.provider ?? 'twilio';
  } catch {
    return 'twilio';
  }
}

/** Places one call now. Returns the conversation id. */
export async function dial(rt: Runtime, lead: Lead, kind: CallKind, provider?: string, toNumber?: string) {
  const s = rt.settings;
  const path = (provider ?? (await phoneProvider(rt))) === 'sip_trunk' ? '/v1/convai/sip-trunk/outbound-call' : '/v1/convai/twilio/outbound-call';
  const res = await el<{ success: boolean; message: string; conversation_id: string | null; callSid?: string | null; sip_call_id?: string | null }>(s, path, {
    method: 'POST',
    body: {
      agent_id: s.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: s.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: toNumber ?? lead.phone,
      conversation_initiation_client_data: { dynamic_variables: variables(rt, lead, kind) },
    },
  });
  if (!res.success || !res.conversation_id) throw new Error(res.message || 'call not started');
  return { conversationId: res.conversation_id, callSid: res.callSid ?? res.sip_call_id ?? null };
}

/** Cron: dial due calls, then collect results for calls that have finished. */
export async function processCallQueue(rt: Runtime) {
  const s = rt.settings;
  if (!elevenConfigured(s)) return { dialed: 0, synced: 0 };
  const db = rt.env.DB;
  const now = Date.now();
  const due = await db.prepare(`SELECT * FROM outbound_calls WHERE status = 'queued' AND run_at <= ? ORDER BY run_at LIMIT 10`).bind(now).all<OutboundCall>();
  let dialed = 0;
  let provider: string | undefined;
  for (const call of due.results) {
    // Claim it so overlapping cron runs can't double-dial.
    const claim = await db.prepare(`UPDATE outbound_calls SET status = 'dialing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'`).bind(now, call.id).run();
    if (!claim.meta.changes) continue;
    const lead = await getLead(rt.env, call.lead_id);
    const why = lead ? blockReason(lead, call.kind) : 'lead deleted';
    const tz = lead ? leadTimezone(lead, s.SALES_TIMEZONE) : 'UTC';
    if (why || !lead) {
      await db.prepare(`UPDATE outbound_calls SET status = 'skipped', error = ?, updated_at = ? WHERE id = ?`).bind(why, now, call.id).run();
      continue;
    }
    if (!inCallingHours(now, tz)) {
      const next = nextCallingTime(now, tz);
      await db.prepare(`UPDATE outbound_calls SET status = ?, attempts = attempts - 1, run_at = ?, updated_at = ? WHERE id = ?`).bind(next ? 'queued' : 'skipped', next ?? now, now, call.id).run();
      continue;
    }
    try {
      provider ??= await phoneProvider(rt);
      const { conversationId, callSid } = await dial(rt, lead, call.kind, provider);
      await db.prepare(`UPDATE outbound_calls SET conversation_id = ?, call_sid = ?, error = NULL, updated_at = ? WHERE id = ?`).bind(conversationId, callSid, Date.now(), call.id).run();
      await track(rt, await identityFromLead(rt.env, lead.id), { name: 'ai_call_started', source: 'server', props: { kind: call.kind, attempt: call.attempts + 1, conversation_id: conversationId } });
      dialed++;
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 500);
      await retryOrFail(rt, { ...call, attempts: call.attempts + 1 }, lead, 'failed', msg);
    }
  }

  // Calls that should have finished: fetch their results (the webhook may already have done this).
  const open = await db.prepare(`SELECT * FROM outbound_calls WHERE status = 'dialing' AND conversation_id IS NOT NULL AND updated_at < ? ORDER BY updated_at LIMIT 10`).bind(now - 90_000).all<OutboundCall>();
  let synced = 0;
  for (const call of open.results) {
    try {
      const conv = await el<Conversation>(s, `/v1/convai/conversations/${encodeURIComponent(call.conversation_id!)}`);
      if (conv.status === 'done' || conv.status === 'failed') { await finishCall(rt, conv); synced++; }
      else if (now - call.run_at > 30 * 60_000) await finishCall(rt, { ...conv, status: 'failed' });
      else await db.prepare('UPDATE outbound_calls SET updated_at = ? WHERE id = ?').bind(now - 30_000, call.id).run(); // check again next run
    } catch (e) {
      if (e instanceof ElevenError && e.status === 404 && now - call.run_at > 15 * 60_000) await finishCall(rt, { conversation_id: call.conversation_id!, status: 'failed' });
    }
  }
  // Calls that never got a conversation id (crashed mid-dial) are retried.
  await db.prepare(`UPDATE outbound_calls SET status = 'queued', updated_at = ? WHERE status = 'dialing' AND conversation_id IS NULL AND updated_at < ? AND attempts < ?`).bind(now, now - 10 * 60_000, AI_CALLER.maxAttempts).run();
  return { dialed, synced };
}

async function retryOrFail(rt: Runtime, call: OutboundCall, lead: Lead, status: 'no_answer' | 'failed', error: string | null) {
  const now = Date.now();
  const next = call.attempts < AI_CALLER.maxAttempts ? nextCallingTime(now + AI_CALLER.retryAfterMinutes * 60_000, leadTimezone(lead, rt.settings.SALES_TIMEZONE)) : null;
  const stillWanted = next && !blockReason(lead, call.kind) && !(call.kind === 'confirm' && lead.call_at && next > lead.call_at - 2 * 3600_000);
  if (stillWanted) {
    // New row per attempt keeps each conversation id unique; the old one keeps its result.
    await rt.env.DB.prepare(`UPDATE outbound_calls SET status = ?, error = ?, updated_at = ? WHERE id = ?`).bind(status, error, now, call.id).run();
    await rt.env.DB.prepare(`INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, attempts, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`)
      .bind(newId('oc'), call.lead_id, call.kind, next, call.attempts, now, now).run();
  } else {
    await rt.env.DB.prepare(`UPDATE outbound_calls SET status = ?, error = ?, updated_at = ? WHERE id = ?`).bind(status, error, now, call.id).run();
  }
}

// ───────────── results ─────────────

interface Conversation {
  conversation_id: string;
  agent_id?: string;
  status: 'initiated' | 'in-progress' | 'processing' | 'done' | 'failed' | string;
  transcript?: { role: string; message: string | null; time_in_call_secs?: number }[];
  metadata?: { call_duration_secs?: number; termination_reason?: string; start_time_unix_secs?: number; cost?: number };
  analysis?: { call_successful?: string; transcript_summary?: string; data_collection_results?: Record<string, { value: unknown }> };
}

export type CallFacts = { [K in keyof typeof DATA_COLLECTION]?: (typeof DATA_COLLECTION)[K]['type'] extends 'boolean' ? boolean : string };

export function factsFrom(conv: Pick<Conversation, 'analysis'>): CallFacts {
  const out: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(DATA_COLLECTION)) {
    const v = conv.analysis?.data_collection_results?.[k]?.value;
    if (v == null || v === '') continue;
    out[k] = def.type === 'boolean' ? v === true || v === 'true' : String(v).slice(0, 500);
  }
  return out as CallFacts;
}

const transcriptText = (t: Conversation['transcript']) => (t ?? []).filter((x) => x.message).map((x) => `${x.role === 'agent' ? 'AI' : 'Lead'}: ${x.message}`).join('\n');

/** Records a finished call and acts on it. Idempotent per conversation. */
export async function finishCall(rt: Runtime, conv: Conversation, failureReason?: string) {
  const db = rt.env.DB;
  const call = await db.prepare('SELECT * FROM outbound_calls WHERE conversation_id = ?').bind(conv.conversation_id).first<OutboundCall>();
  if (!call || call.status !== 'dialing') return false;
  const lead = await getLead(rt.env, call.lead_id);
  if (!lead) return false;
  const now = Date.now();
  const facts = factsFrom(conv);
  const duration = conv.metadata?.call_duration_secs ?? 0;
  const transcript = transcriptText(conv.transcript);
  const unanswered = Boolean(failureReason) || conv.status === 'failed' || (!transcript.includes('Lead:') && !facts.reached_person) || facts.reached_voicemail;

  await db.prepare(
    `INSERT INTO voice_calls (id, lead_id, kind, from_number, status, started_at, ended_at, duration_s, ended_reason, cost, summary, transcript, recording_url, structured, success, disclosure, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'ended', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(
      conv.conversation_id, lead.id, `ai_${call.kind}`,
      conv.metadata?.start_time_unix_secs ? conv.metadata.start_time_unix_secs * 1000 : call.updated_at, now, duration,
      failureReason ?? conv.metadata?.termination_reason ?? conv.status, conv.metadata?.cost ?? null,
      conv.analysis?.transcript_summary ?? (failureReason ? `Not answered (${failureReason})` : null), transcript || null,
      transcript ? `/admin/api/voice/elevenlabs/audio/${encodeURIComponent(conv.conversation_id)}` : null,
      JSON.stringify(facts), conv.analysis?.call_successful ?? null, `elevenlabs-${CALL_CONSENT.version}`, call.created_at, now,
    )
    .run();

  if (unanswered && !facts.do_not_call) {
    await retryOrFail(rt, call, lead, 'no_answer', failureReason ?? (facts.reached_voicemail ? 'voicemail' : null));
    await track(rt, await identityFromLead(rt.env, lead.id), { name: 'ai_call_unanswered', source: 'webhook', props: { kind: call.kind, attempt: call.attempts, reason: failureReason ?? (facts.reached_voicemail ? 'voicemail' : conv.status) } });
    return true;
  }

  await db.prepare(`UPDATE outbound_calls SET status = 'done', outcome = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(facts), now, call.id).run();
  await track(rt, await identityFromLead(rt.env, lead.id), { name: 'ai_call_completed', source: 'webhook', props: { kind: call.kind, duration_s: duration, ...facts } });

  const rep = rt.reps.find((r) => r.id === lead.closer_id) ?? null;
  const said: string[] = [];
  if (facts.do_not_call) {
    await optOut(rt, lead, 'ai_call');
    await cancelCalls(rt, lead.id);
    said.push('🛑 Asked not to be called again — calls and emails stopped.');
  } else {
    if (facts.appointment_confirmed) said.push('✅ Confirmed the appointment.');
    if (facts.wants_reschedule) { await sendLinkEmail(rt, lead); said.push('📆 Needs a new time — rebooking link emailed.'); }
    if (facts.wants_booking_link && !facts.wants_reschedule) { await sendLinkEmail(rt, lead); said.push('🔗 Wants a call — booking link emailed.'); }
    if (facts.bad_time) said.push('Bad time to talk.');
  }
  if (facts.questions) said.push(`Questions: ${facts.questions}`);
  if (facts.notes_for_closer) {
    said.push(`Notes: ${facts.notes_for_closer}`);
    const notes = [lead.notes, `[AI call ${new Date(now).toISOString().slice(0, 10)}] ${facts.notes_for_closer}`].filter(Boolean).join('\n');
    await updateLead(rt.env, lead.id, { notes: notes.slice(-4000) });
  }
  rt.waitUntil(notify(rt, {
    kind: 'voice',
    title: `🤖 AI ${call.kind === 'speed_to_lead' ? 'speed-to-lead' : 'confirmation'} call — ${leadName(lead)}`,
    lines: [...said, conv.analysis?.transcript_summary ?? '', ...leadLines(lead)],
    lead,
    rep,
  }));
  return true;
}

// ───────────── webhook ─────────────

/** `ElevenLabs-Signature: t=<unix>,v0=<hex hmac_sha256(secret, "t.body")>` */
export async function verifyElevenSignature(secret: string, raw: string, header: string | null, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; }));
  if (!parts.t || !parts.v0) return false;
  if (Math.abs(now / 1000 - Number(parts.t)) > 30 * 60) return false;
  return safeEqual(await hmacHex(secret, `${parts.t}.${raw}`), parts.v0);
}

export async function handleElevenWebhook(rt: Runtime, payload: { type?: string; data?: Record<string, unknown> }) {
  const d = payload.data ?? {};
  const id = d.conversation_id as string | undefined;
  if (!id) return false;
  if (payload.type === 'post_call_transcription') return finishCall(rt, { ...(d as unknown as Conversation), status: 'done' });
  if (payload.type === 'call_initiation_failure') return finishCall(rt, { conversation_id: id, status: 'failed' }, String(d.failure_reason ?? 'unknown'));
  return false;
}

/** Pre-dial check shown in the dashboard. */
export function consentLine(lead: Lead) {
  return lead.call_consent_at ? `consented ${new Date(lead.call_consent_at).toISOString().slice(0, 10)} (${lead.call_consent_text ?? CALL_CONSENT.version})` : 'no consent';
}

import type { Runtime } from '../app';
import { AI_CALLBACK, BRAND, CALL_CONSENT, FAQS, inboundCallbackPrompt } from '../config';
import { hmacHex, safeEqual } from '../lib/crypto';
import { getSecret } from '../lib/secret';
import { type Lead, effectiveTier, updateLead } from '../funnel/leads';
import type { Settings } from '../settings';
import { identityFromLead, track } from '../tracking/track';
import { formatCallTime } from './email';
import { type Conversation, DATA_COLLECTION, ElevenError, el, factsFrom, leadTimezone, transcriptText, upsertAgent } from './elevenlabs';
import { leadLines, leadName, notify } from './notify';
import { leadByPhone, optOut, sendLinkEmail } from './voice';

/**
 * Callback agent: answers people who ring our ElevenLabs/Twilio number back
 * (usually after missing Sam's confirmation call).
 *
 *  - Personalised by caller ID through the conversation-initiation webhook
 *    (/hooks/elevenlabs/init), which ElevenLabs calls as the phone rings.
 *  - Results come in on the post-call webhook, or the cron lists recent
 *    conversations for the agent and processes any it hasn't seen.
 */

export const INBOUND_DATA = {
  ...DATA_COLLECTION,
  wants_human_callback: { type: 'boolean', description: 'True if the caller asked to speak to a person or be called back by the team.' },
  callback_time: { type: 'string', description: 'When the caller said is best for a callback, if they gave one. Empty otherwise.' },
  caller_name: { type: 'string', description: 'The caller’s name, if they gave it.' },
  caller_email: { type: 'string', description: 'The caller’s email address, exactly as confirmed on the call. Empty if not given.' },
} as const;

const VARS = ['greeting_name', 'opening', 'known', 'first_name', 'business', 'tier', 'status', 'call_time', 'closer_name', 'email'] as const;
type Vars = Record<(typeof VARS)[number], string>;

const UNKNOWN: Vars = {
  greeting_name: '', opening: 'How can I help today?', known: 'no', first_name: '', business: '', tier: '', status: '', call_time: '', closer_name: 'Josh’s team', email: '',
};

export function buildInboundAgent(s: Settings) {
  return {
    name: `${BRAND.name} — callbacks (inbound)`,
    tags: ['funnel', 'inbound'],
    conversation_config: {
      agent: {
        first_message: AI_CALLBACK.firstMessage,
        language: 'en',
        prompt: {
          prompt: inboundCallbackPrompt(FAQS),
          ...(s.ELEVENLABS_LLM ? { llm: s.ELEVENLABS_LLM } : {}),
          built_in_tools: { end_call: { name: 'end_call', description: 'End the call when the conversation is finished or the caller asks to stop.', params: { system_tool_type: 'end_call' } } },
        },
        dynamic_variables: { dynamic_variable_placeholders: UNKNOWN },
      },
      ...(s.ELEVENLABS_VOICE_ID ? { tts: { voice_id: s.ELEVENLABS_VOICE_ID } } : {}),
      conversation: { max_duration_seconds: 420 },
    },
    platform_settings: {
      data_collection: INBOUND_DATA,
      overrides: { enable_conversation_initiation_client_data_from_webhook: true },
    },
  };
}

/** Header value ElevenLabs sends on the initiation webhook so only it can ask us about callers. */
export const initSecret = async (rt: Runtime) => (await hmacHex(await getSecret(rt.env), 'elevenlabs-init')).slice(0, 40);

/**
 * Creates/updates the callback agent, puts it on the phone number, and points
 * the workspace's initiation webhook at us. Each step reports its own result.
 */
export async function provisionInbound(rt: Runtime) {
  const s = rt.settings;
  const { id, created } = await upsertAgent(s, buildInboundAgent(s) as unknown as Record<string, unknown>, s.ELEVENLABS_INBOUND_AGENT_ID);
  const out = { id, created, assigned: false, initWebhook: false, notes: [] as string[] };
  if (s.ELEVENLABS_PHONE_NUMBER_ID) {
    try {
      await el(s, `/v1/convai/phone-numbers/${encodeURIComponent(s.ELEVENLABS_PHONE_NUMBER_ID)}`, { method: 'PATCH', body: { agent_id: id } });
      out.assigned = true;
    } catch (e) {
      out.notes.push(`Couldn’t put the agent on the number: ${e instanceof Error ? e.message : e}`);
    }
  } else out.notes.push('Pick a phone number first, then run this again to put the callback agent on it.');
  try {
    await el(s, '/v1/convai/settings', {
      method: 'PATCH',
      body: { conversation_initiation_client_data_webhook: { url: `${rt.origin}/hooks/elevenlabs/init`, request_headers: { 'x-funnel-secret': await initSecret(rt) } } },
    });
    out.initWebhook = true;
  } catch (e) {
    out.notes.push(`Caller look-up webhook not set automatically (${e instanceof ElevenError ? e.status : 'error'}). Callers are still matched to leads after the call.`);
  }
  return { ...out };
}

function varsFor(rt: Runtime, lead: Lead | null): Vars {
  if (!lead) return UNKNOWN;
  const rep = rt.reps.find((r) => r.id === lead.closer_id);
  const booked = Boolean(lead.booked_at && !lead.booking_cancelled_at && lead.status === 'booked');
  const callTime = booked && lead.call_at ? formatCallTime(lead.call_at, leadTimezone(lead, rt.settings.SALES_TIMEZONE)).replace(/ [A-Z]{2,5}$/, '') : '';
  const name = lead.first_name ?? '';
  return {
    greeting_name: name ? ` ${name}` : '',
    opening: booked ? 'Are you calling about your strategy call?' : 'How can I help today?',
    known: 'yes',
    first_name: name,
    // Caller ID can be spoofed: give the agent only what it needs to help, nothing worth phishing for.
    business: '',
    tier: effectiveTier(lead) ?? '',
    status: booked ? 'booked a strategy call' : lead.app_completed_at ? 'applied, not booked yet' : 'started an application',
    call_time: booked ? callTime || 'booked (time in their confirmation email)' : 'not booked',
    closer_name: rep?.name ?? 'Josh’s team',
    email: '',
  };
}

/** ElevenLabs asks who's calling as the phone rings. */
export async function initiationData(rt: Runtime, header: string | undefined, body: { caller_id?: string; agent_id?: string }) {
  if (!header || !safeEqual(header, await initSecret(rt))) return null;
  const lead = await leadByPhone(rt, body.caller_id ?? null).catch(() => null);
  return { type: 'conversation_initiation_client_data', dynamic_variables: varsFor(rt, lead) };
}

const callerNumber = (c: Conversation) =>
  c.metadata?.phone_call?.external_number ?? (c.conversation_initiation_client_data?.dynamic_variables?.system__caller_id as string | undefined) ?? null;

/** Records an answered callback and acts on it. Idempotent per conversation. */
export async function finishInbound(rt: Runtime, conv: Conversation) {
  const now = Date.now();
  const from = callerNumber(conv);
  let lead = await leadByPhone(rt, from).catch(() => null);
  const facts = factsFrom(conv, INBOUND_DATA) as Record<string, string | boolean | undefined>;
  // A spoken email proves nothing (anyone can say anyone's address): link the call for the team, but act on nothing.
  let matchedByVoice = false;
  if (!lead && typeof facts.caller_email === 'string' && facts.caller_email.includes('@')) {
    lead = await rt.env.DB.prepare('SELECT * FROM leads WHERE email = ? LIMIT 1').bind(facts.caller_email.trim().toLowerCase()).first<Lead>();
    matchedByVoice = Boolean(lead);
  }
  const transcript = transcriptText(conv.transcript);
  const res = await rt.env.DB.prepare(
    `INSERT INTO voice_calls (id, lead_id, kind, from_number, status, started_at, ended_at, duration_s, ended_reason, cost, summary, transcript, recording_url, structured, success, disclosure, created_at, updated_at)
     VALUES (?, ?, 'ai_callback', ?, 'ended', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(
      conv.conversation_id, lead?.id ?? null, from,
      conv.metadata?.start_time_unix_secs ? conv.metadata.start_time_unix_secs * 1000 : now, now, conv.metadata?.call_duration_secs ?? 0,
      conv.metadata?.termination_reason ?? conv.status, conv.metadata?.cost ?? null, conv.analysis?.transcript_summary ?? null, transcript || null,
      transcript ? `/admin/api/voice/elevenlabs/audio/${encodeURIComponent(conv.conversation_id)}` : null,
      JSON.stringify(facts), conv.analysis?.call_successful ?? null, `elevenlabs-callback-${CALL_CONSENT.version}`,
      conv.metadata?.start_time_unix_secs ? conv.metadata.start_time_unix_secs * 1000 : now, now,
    )
    .run();
  if (!res.meta.changes) return false; // already handled

  const said: string[] = [];
  if (lead && matchedByVoice) {
    said.push('⚠️ Caller gave the email of this lead but rang from a different number — check before acting on anything they asked.');
    if (facts.do_not_call) said.push('They asked not to be contacted: confirm with the lead, then opt them out in Funnel HQ.');
    if (facts.wants_reschedule || facts.wants_booking_link) said.push('They asked for a booking link: send it from Funnel HQ if it checks out.');
  } else if (lead) {
    await track(rt, await identityFromLead(rt.env, lead.id), { name: 'ai_callback_completed', source: 'webhook', props: { duration_s: conv.metadata?.call_duration_secs ?? 0, ...facts } });
    if (facts.do_not_call) {
      await optOut(rt, lead, 'ai_callback');
      await rt.env.DB.prepare(`UPDATE outbound_calls SET status = 'cancelled', updated_at = ? WHERE lead_id = ? AND status = 'queued'`).bind(now, lead.id).run();
      said.push('🛑 Asked not to be contacted again — calls and emails stopped.');
    } else {
      if (facts.appointment_confirmed) said.push('✅ Confirmed the appointment.');
      if (facts.wants_reschedule) { await sendLinkEmail(rt, lead); said.push('📆 Needs a new time — rebooking link emailed.'); }
      if (facts.wants_booking_link && !facts.wants_reschedule) { await sendLinkEmail(rt, lead); said.push('🔗 Wants a call — booking link emailed.'); }
    }
    if (facts.notes_for_closer) {
      const notes = [lead.notes, `[AI callback ${new Date(now).toISOString().slice(0, 10)}] ${facts.notes_for_closer}`].filter(Boolean).join('\n');
      await updateLead(rt.env, lead.id, { notes: notes.slice(-4000) });
    }
  } else {
    said.push(`Unknown caller ${from ?? ''}${facts.caller_name ? ` — ${facts.caller_name}` : ''}${facts.caller_email ? ` <${facts.caller_email}>` : ''}`);
  }
  if (facts.wants_human_callback) said.push(`☎️ Wants a person to call back${facts.callback_time ? ` (${facts.callback_time})` : ''}.`);
  if (facts.questions) said.push(`Questions: ${facts.questions}`);
  if (facts.notes_for_closer) said.push(`Notes: ${facts.notes_for_closer}`);
  const rep = lead ? rt.reps.find((r) => r.id === lead!.closer_id) ?? null : null;
  rt.waitUntil(notify(rt, {
    kind: 'voice',
    title: `📞 Callback answered by AI — ${lead ? leadName(lead) : from ?? 'unknown caller'}`,
    lines: [...said, conv.analysis?.transcript_summary ?? '', ...(lead ? leadLines(lead) : [])],
    lead,
    rep,
  }));
  return true;
}

/** Cron fallback: process finished callback conversations from the last 2 days that we haven't seen. */
export async function syncInbound(rt: Runtime) {
  const s = rt.settings;
  if (!s.ELEVENLABS_API_KEY || !s.ELEVENLABS_INBOUND_AGENT_ID) return 0;
  const since = Math.floor(Date.now() / 1000) - 2 * 86_400;
  const list = await el<{ conversations: { conversation_id: string; status: string }[] }>(
    s, `/v1/convai/conversations?agent_id=${encodeURIComponent(s.ELEVENLABS_INBOUND_AGENT_ID)}&page_size=30&call_start_after_unix=${since}`,
  );
  const done = list.conversations.filter((c) => c.status === 'done');
  if (!done.length) return 0;
  const seen = await rt.env.DB.prepare(`SELECT id FROM voice_calls WHERE id IN (${done.map(() => '?').join(',')})`).bind(...done.map((c) => c.conversation_id)).all<{ id: string }>();
  const known = new Set(seen.results.map((r) => r.id));
  let n = 0;
  for (const c of done.filter((x) => !known.has(x.conversation_id)).slice(0, 5)) {
    const conv = await el<Conversation>(s, `/v1/convai/conversations/${encodeURIComponent(c.conversation_id)}`);
    if (await finishInbound(rt, conv)) n++;
  }
  return n;
}

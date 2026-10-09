import type { Runtime } from '../app';
import { APPLICATION, BRAND, FAQS, VOICE_AGENT, voiceSystemPrompt } from '../config';
import { hmacHex, safeEqual } from '../lib/crypto';
import { newId, newRefCode } from '../lib/ids';
import { getSecret } from '../lib/secret';
import { type Lead, cleanName, effectiveTier, getLead, getLeadByEmail, normalisePhone, parseAnswers, updateLead, validateEmail } from '../funnel/leads';
import type { Settings } from '../settings';
import { identityFromLead, track } from '../tracking/track';
import { buildEmail, emailConfigured, sendViaResend } from './email';
import { notifySlack } from './notify';

/**
 * Inbound AI voice assistant on Vapi (https://docs.vapi.ai).
 *
 *  - Phone: callers dial your Vapi number. Its Server URL points at
 *    /hooks/voice, so Vapi asks us which assistant to use (assistant-request)
 *    and we personalise it from the lead record matched by caller ID.
 *  - Browser: applicants on /book and /breakout press "talk now"; /api/voice/start
 *    hands the page the public key, assistant id and signed per-lead overrides.
 *
 * Every call ends with an end-of-call-report: transcript, recording, summary
 * and structured answers land in voice_calls, on the lead, in PostHog and Slack.
 *
 * Nothing in here places outbound calls. That's deliberate — see docs/VOICE_AGENT.md.
 */

const VAPI = 'https://api.vapi.ai';

export const voiceConfigured = (s: Settings) => Boolean(s.VOICE_WEBHOOK_SECRET && (s.VAPI_ASSISTANT_ID || s.VAPI_API_KEY));
export const webCallsEnabled = (s: Settings) => s.VOICE_WEB_ENABLED === 'true' && Boolean(s.VAPI_PUBLIC_KEY && s.VAPI_ASSISTANT_ID && s.VOICE_WEBHOOK_SECRET);

export function verifyVapi(s: Settings, header: string | null | undefined) {
  return Boolean(s.VOICE_WEBHOOK_SECRET && header && safeEqual(header, s.VOICE_WEBHOOK_SECRET));
}

const split = (v: string, fallback: [string, string]): [string, string] => {
  const i = v.indexOf(':');
  return i > 0 ? [v.slice(0, i), v.slice(i + 1)] : fallback;
};

// ───────────────────────────── Assistant definition ─────────────────────────────

const option = (id: string) => {
  const q = APPLICATION.find((x) => x.id === id);
  return q && q.type === 'single' ? q.options.map((o) => o.value) : [];
};

/** What the assistant extracts after every call. Enum values match the application, so answers drop straight in. */
export const STRUCTURED_SCHEMA = {
  type: 'object',
  properties: {
    first_name: { type: 'string' },
    last_name: { type: 'string' },
    email: { type: 'string', description: 'Only if the caller said it and confirmed it.' },
    business: { type: 'string', description: 'What the business does, in the caller’s words.' },
    role: { type: 'string', enum: option('role') },
    revenue: { type: 'string', enum: option('revenue') },
    profit: { type: 'string', enum: option('profit') },
    timeline: { type: 'string', enum: option('timeline') },
    recording_consent: { type: 'boolean', description: 'Did the caller agree to the call being recorded?' },
    wants_strategy_call: { type: 'boolean' },
    wants_human_callback: { type: 'boolean', description: 'Caller asked for a person from the team to call them back.' },
    do_not_contact: { type: 'boolean', description: 'Caller asked not to be contacted again.' },
    objections: { type: 'array', items: { type: 'string' } },
  },
} as const;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'send_booking_link',
      description:
        'Emails the caller the link to book their strategy call (or to finish the application if they haven’t). Read the email address back to the caller and get a yes before calling this.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Email address the caller confirmed. Optional if we already have it on file.' },
          first_name: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'do_not_contact',
      description: 'Records that the caller does not want to be contacted again (calls, emails, WhatsApp). Call it as soon as they ask.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/** The full assistant, as created/updated in Vapi from the dashboard. */
export function buildAssistant(rt: Runtime) {
  const s = rt.settings;
  const [modelProvider, model] = split(s.VOICE_MODEL, ['openai', 'gpt-4o']);
  const [voiceProvider, voiceId] = split(s.VOICE_VOICE, ['vapi', 'Elliot']);
  return {
    name: `${BRAND.founder} — inbound assistant`.slice(0, 40),
    firstMessage: VOICE_AGENT.firstMessage,
    firstMessageMode: 'assistant-speaks-first',
    model: {
      provider: modelProvider,
      model,
      temperature: 0.4,
      messages: [{ role: 'system', content: voiceSystemPrompt(FAQS) }],
      tools: TOOLS,
    },
    voice: { provider: voiceProvider, voiceId },
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
    endCallFunctionEnabled: true,
    endCallPhrases: ['goodbye', 'bye for now'],
    maxDurationSeconds: VOICE_AGENT.maxDurationSeconds,
    silenceTimeoutSeconds: 30,
    artifactPlan: { recordingEnabled: true },
    analysisPlan: {
      summaryPlan: { enabled: true },
      structuredDataPlan: { enabled: true, schema: STRUCTURED_SCHEMA },
      successEvaluationPlan: { enabled: true, rubric: 'PassFail' },
    },
    server: { url: `${rt.origin}/hooks/voice`, headers: { 'x-vapi-secret': s.VOICE_WEBHOOK_SECRET } },
    serverMessages: ['end-of-call-report', 'status-update', 'tool-calls'],
    metadata: { app: 'vsl-funnel', disclosure: VOICE_AGENT.disclosureVersion },
  };
}

/** Creates the assistant in Vapi, or updates it in place, and returns its id. */
export async function provisionAssistant(rt: Runtime): Promise<{ id: string; created: boolean }> {
  const s = rt.settings;
  if (!s.VAPI_API_KEY) throw new Error('Add your Vapi private API key first');
  if (!s.VOICE_WEBHOOK_SECRET) throw new Error('Set a voice webhook secret first');
  const existing = s.VAPI_ASSISTANT_ID;
  const res = await fetch(existing ? `${VAPI}/assistant/${encodeURIComponent(existing)}` : `${VAPI}/assistant`, {
    method: existing ? 'PATCH' : 'POST',
    headers: { authorization: `Bearer ${s.VAPI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(buildAssistant(rt)),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string | string[] };
  if (!res.ok || !body.id) throw new Error(`Vapi ${res.status}: ${[body.message].flat().join('; ') || 'unknown error'}`);
  return { id: body.id, created: !existing };
}

// ───────────────────────────── Per-call personalisation ─────────────────────────────

const leadSig = async (rt: Runtime, leadId: string) => (await hmacHex(await getSecret(rt.env), `voice|${leadId}`)).slice(0, 24);

/** Values substituted into {{…}} in the system prompt, plus a signed lead id so webhooks can trust it. */
export async function callVariables(rt: Runtime, lead: Lead | null) {
  if (!lead) return { first_name: '', last_name: '', lead_ref: 'unknown', tier: 'unknown', application_status: 'not started', known_answers: 'none' };
  const answers = parseAnswers(lead);
  const known = APPLICATION.filter((q) => q.type !== 'contact' && answers[q.id] !== undefined)
    .map((q) => {
      const a = answers[q.id];
      const label = 'options' in q ? [a].flat().map((v) => q.options.find((o) => o.value === v)?.label ?? v).join(', ') : String(a);
      return `${q.id}: ${label}`;
    })
    .join('; ');
  return {
    first_name: lead.first_name ?? '',
    last_name: lead.last_name ?? '',
    lead_ref: lead.ref_code,
    tier: effectiveTier(lead) ?? 'unscored',
    application_status: lead.app_completed_at ? 'completed' : lead.app_started_at ? 'started, not finished' : 'not started',
    known_answers: known || 'none',
    lead_id: lead.id,
    lead_sig: await leadSig(rt, lead.id),
  };
}

const personalGreeting = (lead: Lead | null) => (lead?.first_name ? VOICE_AGENT.firstMessage.replace(/^Hi,/, `Hi ${lead.first_name},`) : VOICE_AGENT.firstMessage);

async function overridesFor(rt: Runtime, lead: Lead | null, kind: 'phone' | 'web') {
  return {
    firstMessage: personalGreeting(lead),
    variableValues: await callVariables(rt, lead),
    metadata: { kind, lead_id: lead?.id ?? null, disclosure: VOICE_AGENT.disclosureVersion },
  };
}

/** What the browser needs to start a call. Null when browser calls are off. */
export async function webCallConfig(rt: Runtime, lead: Lead) {
  if (!webCallsEnabled(rt.settings)) return null;
  return { publicKey: rt.settings.VAPI_PUBLIC_KEY, assistantId: rt.settings.VAPI_ASSISTANT_ID, overrides: await overridesFor(rt, lead, 'web') };
}

// ───────────────────────────── Webhook ─────────────────────────────

/* Minimal shapes of the Vapi server messages we use. */
interface VapiCall {
  id?: string;
  type?: string; // inboundPhoneCall | webCall | outboundPhoneCall
  customer?: { number?: string };
  metadata?: Record<string, unknown>;
  assistantOverrides?: { variableValues?: Record<string, unknown>; metadata?: Record<string, unknown> };
}
interface ToolCall { id: string; function?: { name?: string; arguments?: unknown } }
export interface VapiMessage {
  type?: string;
  call?: VapiCall;
  customer?: { number?: string };
  status?: string;
  toolCallList?: ToolCall[];
  toolWithToolCallList?: { toolCall?: ToolCall }[];
  endedReason?: string;
  summary?: string;
  transcript?: string;
  recordingUrl?: string;
  cost?: number;
  durationSeconds?: number;
  startedAt?: string;
  endedAt?: string;
  analysis?: { summary?: string; structuredData?: Record<string, unknown>; successEvaluation?: unknown };
  artifact?: { transcript?: string; recordingUrl?: string; recording?: { mono?: { combinedUrl?: string } } };
}

const callKind = (call: VapiCall | undefined) => (call?.type === 'webCall' ? 'web' : 'phone');
const callerNumber = (m: VapiMessage) => m.call?.customer?.number ?? m.customer?.number ?? null;

/** The lead a call belongs to: the signed lead id we handed out, else caller ID. Never trusts an unsigned id. */
async function leadForCall(rt: Runtime, m: VapiMessage): Promise<Lead | null> {
  const vars = m.call?.assistantOverrides?.variableValues ?? {};
  const id = typeof vars.lead_id === 'string' ? vars.lead_id : null;
  const sig = typeof vars.lead_sig === 'string' ? vars.lead_sig : null;
  if (id && sig && safeEqual(sig, await leadSig(rt, id))) {
    const lead = await getLead(rt.env, id);
    if (lead) return lead;
  }
  const row = await rt.env.DB.prepare('SELECT lead_id FROM voice_calls WHERE id = ? AND lead_id IS NOT NULL').bind(m.call?.id ?? '').first<{ lead_id: string }>();
  if (row) return getLead(rt.env, row.lead_id);
  return leadByPhone(rt, callerNumber(m));
}

async function leadByPhone(rt: Runtime, raw: string | null) {
  const phone = normalisePhone(raw, null);
  if (!phone) return null;
  return rt.env.DB.prepare('SELECT * FROM leads WHERE phone = ? ORDER BY app_completed_at IS NULL, updated_at DESC LIMIT 1').bind(phone).first<Lead>();
}

/** Inbound phone call: pick the assistant and personalise it by caller ID. */
async function assistantRequest(rt: Runtime, m: VapiMessage) {
  const lead = await leadByPhone(rt, callerNumber(m));
  const overrides = await overridesFor(rt, lead, 'phone');
  if (rt.settings.VAPI_ASSISTANT_ID) return { assistantId: rt.settings.VAPI_ASSISTANT_ID, assistantOverrides: overrides };
  // No saved assistant yet: answer with the full definition inline.
  return { assistant: { ...buildAssistant(rt), firstMessage: overrides.firstMessage, metadata: overrides.metadata }, assistantOverrides: { variableValues: overrides.variableValues } };
}

async function upsertCall(rt: Runtime, m: VapiMessage, fields: Record<string, string | number | null>) {
  const id = m.call?.id;
  if (!id) return;
  const now = Date.now();
  const base = { kind: callKind(m.call), from_number: callerNumber(m), status: 'ringing', ...fields };
  const keys = Object.keys(base);
  await rt.env.DB.prepare(
    `INSERT INTO voice_calls (id, ${keys.join(', ')}, created_at, updated_at) VALUES (?, ${keys.map(() => '?').join(', ')}, ?, ?)
     ON CONFLICT(id) DO UPDATE SET ${Object.keys(fields).map((k) => `${k} = COALESCE(excluded.${k}, voice_calls.${k})`).join(', ')}${Object.keys(fields).length ? ', ' : ''}updated_at = excluded.updated_at`,
  )
    .bind(id, ...keys.map((k) => (base as Record<string, unknown>)[k] ?? null), now, now)
    .run();
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

/** Creates a lead for a caller we've never seen (only when they gave us a way to reach them). */
async function createVoiceLead(rt: Runtime, m: VapiMessage, details: { first_name?: unknown; last_name?: unknown; email?: unknown }) {
  const email = validateEmail(details.email);
  if (email) {
    const existing = await getLeadByEmail(rt.env, email.email);
    if (existing) return existing;
  }
  const phone = normalisePhone(callerNumber(m), null);
  if (!email && !phone) return null;
  const id = newId('l');
  const now = Date.now();
  await rt.env.DB.prepare(
    `INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, phone, status, channel, landing_path)
     VALUES (?,?,?,?,?,?,?,?, 'partial', 'Voice', ?)`,
  )
    .bind(id, newRefCode(), now, now, cleanName(details.first_name), cleanName(details.last_name), email?.email ?? null, phone, callKind(m.call) === 'web' ? '/voice/web' : '/voice/phone')
    .run();
  const lead = (await getLead(rt.env, id))!;
  await track(rt, await identityFromLead(rt.env, id), { name: 'lead_captured', source: 'webhook', props: { via: 'voice' } });
  return lead;
}

async function optOut(rt: Runtime, lead: Lead, via: string) {
  const now = Date.now();
  await updateLead(rt.env, lead.id, { do_not_call_at: lead.do_not_call_at ?? now, unsubscribed_at: lead.unsubscribed_at ?? now });
  await rt.env.DB.prepare("UPDATE emails SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending'").bind(lead.id).run();
  await track(rt, await identityFromLead(rt.env, lead.id), { name: 'voice_opt_out', source: 'webhook', props: { via } });
}

/** Sends the voice_link email now (or records it as simulated without an email provider). */
async function sendLinkEmail(rt: Runtime, lead: Lead) {
  if (!lead.email) return false;
  const emailId = newId('m');
  const email = await buildEmail(rt, lead, emailId, 'voice_link', 'voice');
  const providerId = emailConfigured(rt) ? await sendViaResend(rt, { to: lead.email, ...email, tags: { sequence: 'voice', template: 'voice_link' } }) : null;
  const now = Date.now();
  await rt.env.DB.prepare(
    `INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at, sent_at, provider_id, subject, attempts)
     VALUES (?, ?, 'voice', ?, 'voice_link', ?, ?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(emailId, lead.id, now % 1_000_000_000, lead.email, now, providerId ? 'sent' : 'simulated', now, now, providerId, email.subject)
    .run();
  await track(rt, await identityFromLead(rt.env, lead.id), { name: 'voice_link_sent', source: 'webhook', props: { email_id: emailId, simulated: !providerId } });
  return true;
}

async function runTool(rt: Runtime, m: VapiMessage, name: string, args: Record<string, unknown>): Promise<string> {
  let lead = await leadForCall(rt, m);
  if (name === 'send_booking_link') {
    const email = validateEmail(args.email);
    if (!lead) lead = await createVoiceLead(rt, m, { email: args.email, first_name: args.first_name });
    if (!lead) return 'I could not save that email address. Ask the caller to spell it again, slowly.';
    if (email?.disposable) return 'That looks like a temporary email address. Ask for their main business email.';
    // Fill in a missing address, but never silently replace the one on file.
    if (email && !lead.email) await updateLead(rt.env, lead.id, { email: email.email });
    const differs = Boolean(email && lead.email && email.email !== lead.email);
    if (lead.unsubscribed_at) return 'This person previously unsubscribed from email, so do not send anything. Offer the website instead.';
    await upsertCall(rt, m, { lead_id: lead.id });
    const fresh = (await getLead(rt.env, lead.id))!;
    const sent = await sendLinkEmail(rt, fresh);
    if (!sent) return 'I need an email address first. Ask for it and read it back.';
    const where = differs ? ` It went to the address already on file, ending in ${fresh.email!.split('@')[1]}; if that’s wrong, the team will fix it by email.` : '';
    return (fresh.app_completed_at ? 'Sent. The booking link is in their inbox now; tell them to check spam if it’s not there in a minute.' : 'Sent. It’s the link to finish the short application; once done they can book straight away.') + where;
  }
  if (name === 'do_not_contact') {
    if (lead) await optOut(rt, lead, 'voice_tool');
    return 'Done. They will not be contacted again. Confirm that, thank them, and end the call.';
  }
  return 'Unknown tool.';
}

async function toolCalls(rt: Runtime, m: VapiMessage) {
  const calls = m.toolCallList ?? (m.toolWithToolCallList ?? []).map((t) => t.toolCall).filter((t): t is ToolCall => Boolean(t));
  const results = [];
  for (const call of calls) {
    let result: string;
    try {
      result = await runTool(rt, m, call.function?.name ?? '', parseArgs(call.function?.arguments));
    } catch (e) {
      console.error('voice tool failed', e);
      result = 'That didn’t go through. Apologise and say the team will email them instead.';
    }
    results.push({ toolCallId: call.id, result });
  }
  return { results };
}

/** Maps structured call data onto application answers (only values that match an option, only where none exists). */
export function answersFromCall(structured: Record<string, unknown>, existing: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const q of APPLICATION) {
    if (q.type === 'contact' || existing[q.id] !== undefined) continue;
    const v = structured[q.id];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (q.type === 'single' && q.options.some((o) => o.value === v)) out[q.id] = v;
    if (q.type === 'text' && v.trim().length >= q.minLength) out[q.id] = v.trim().slice(0, 1000);
  }
  return out;
}

const iso = (s: string | undefined) => (s && !Number.isNaN(Date.parse(s)) ? Date.parse(s) : null);

async function endOfCall(rt: Runtime, m: VapiMessage) {
  const structured = (m.analysis?.structuredData ?? {}) as Record<string, unknown>;
  let lead = await leadForCall(rt, m);
  if (!lead && !structured.do_not_contact) lead = await createVoiceLead(rt, m, structured);
  const summary = m.analysis?.summary ?? m.summary ?? null;

  await upsertCall(rt, m, {
    lead_id: lead?.id ?? null,
    status: 'ended',
    started_at: iso(m.startedAt),
    ended_at: iso(m.endedAt) ?? Date.now(),
    duration_s: typeof m.durationSeconds === 'number' ? m.durationSeconds : null,
    ended_reason: m.endedReason ?? null,
    cost: typeof m.cost === 'number' ? m.cost : null,
    summary,
    transcript: (m.artifact?.transcript ?? m.transcript ?? '').slice(0, 60_000) || null,
    recording_url: m.artifact?.recordingUrl ?? m.artifact?.recording?.mono?.combinedUrl ?? m.recordingUrl ?? null,
    structured: Object.keys(structured).length ? JSON.stringify(structured).slice(0, 8000) : null,
    success: m.analysis?.successEvaluation == null ? null : String(m.analysis.successEvaluation),
    disclosure: VOICE_AGENT.disclosureVersion,
  });
  if (!lead) return;

  if (structured.do_not_contact === true) {
    await optOut(rt, lead, 'voice_analysis');
  } else {
    const answers = parseAnswers(lead);
    const extra = answersFromCall(structured, answers);
    const fill: Record<string, string | number | null> = {};
    if (Object.keys(extra).length) fill.answers = JSON.stringify({ ...answers, ...extra });
    if (!lead.first_name && cleanName(structured.first_name)) fill.first_name = cleanName(structured.first_name);
    if (!lead.last_name && cleanName(structured.last_name)) fill.last_name = cleanName(structured.last_name);
    if (Object.keys(fill).length) await updateLead(rt.env, lead.id, fill);
  }

  const props = {
    call_id: m.call?.id,
    kind: callKind(m.call),
    duration_s: m.durationSeconds ?? null,
    ended_reason: m.endedReason ?? null,
    wants_strategy_call: structured.wants_strategy_call === true,
    wants_human_callback: structured.wants_human_callback === true,
    recording_consent: structured.recording_consent ?? null,
  };
  await track(rt, await identityFromLead(rt.env, lead.id), { name: 'voice_call_completed', source: 'webhook', props });

  const fresh = (await getLead(rt.env, lead.id))!;
  const flags = [props.wants_human_callback && '📞 wants a person to call back', props.wants_strategy_call && 'wants a strategy call', structured.do_not_contact === true && '⛔ asked not to be contacted'].filter(Boolean);
  rt.waitUntil(notifySlack(rt, fresh, `🎙️ AI call (${props.kind}, ${Math.round(Number(m.durationSeconds ?? 0))}s)`, [flags.join(' · '), summary ? `> ${summary.slice(0, 600)}` : ''].filter(Boolean) as string[]));
}

/** Entry point for every Vapi server message. Returns the JSON Vapi expects (or {}). */
export async function handleVapi(rt: Runtime, m: VapiMessage): Promise<unknown> {
  switch (m.type) {
    case 'assistant-request':
      return assistantRequest(rt, m);
    case 'tool-calls':
      return toolCalls(rt, m);
    case 'status-update': {
      if (m.status === 'in-progress') {
        const lead = await leadForCall(rt, m);
        await upsertCall(rt, m, { status: 'in-progress', started_at: Date.now(), lead_id: lead?.id ?? null, disclosure: VOICE_AGENT.disclosureVersion });
        if (lead) await track(rt, await identityFromLead(rt.env, lead.id), { name: 'voice_call_started', source: 'webhook', props: { call_id: m.call?.id, kind: callKind(m.call) } });
      }
      return {};
    }
    case 'end-of-call-report':
      await endOfCall(rt, m);
      return {};
    default:
      return {};
  }
}

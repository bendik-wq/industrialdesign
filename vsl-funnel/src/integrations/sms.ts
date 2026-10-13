import { safeFirstName } from '../lib/text';
import type { Runtime } from '../app';
import { type Lead, getLead, updateLead } from '../funnel/leads';
import { newId } from '../lib/ids';
import { safeEqual } from '../lib/crypto';
import { identityFromLead, track } from '../tracking/track';
import { bookingUrlFor } from '../funnel/routing';
import { effectiveTier } from '../funnel/leads';
import { callingZones } from './elevenlabs';
import { formatCallTime } from './email';
import { notifySlack, plain } from './notify';
import { leadByPhone } from './voice';

/**
 * SMS follow-up through Twilio. Short, useful texts at the moments that move show rate and bookings:
 * booking confirmation + reminders with the meeting link, a no-show rebook, an unfinished application,
 * and a nudge to book. Rules:
 *  - only to people who ticked "Call or text me at this number" (call_consent_at), never after STOP;
 *  - only 8am–8pm in every time zone of the phone number's country, max 3 texts per person per day;
 *  - never to imported Calendly contacts; every link is a short /s/<id> redirect stored server-side.
 * Without Twilio keys texts are "simulated" so the flows can be tested end to end.
 */

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const booked = (l: Lead) => Boolean(l.booked_at) && !l.booking_cancelled_at;

interface SmsCtx { name: string; time: string | null; link: string }
interface SmsStep { template: string; offsetMs: number; anchor?: 'start' | 'call_at'; link?: 'join' | 'reschedule' | 'book' | 'apply' | 'breakout'; skipIf?: (l: Lead) => boolean }
interface SmsSequence { id: string; steps: SmsStep[]; stopIf?: (l: Lead) => boolean }

export const SMS_TEMPLATES: Record<string, (c: SmsCtx) => string> = {
  sms_confirm: (c) => `Hi ${c.name}, it's Josh's team at G&L. You're booked in for your strategy call${c.time ? ` on ${c.time}` : ''}. Save this link to join: ${c.link}`,
  sms_24h: (c) => `Hi ${c.name}, a quick reminder: your strategy call is tomorrow${c.time ? `, ${c.time}` : ''}. Need a different time? ${c.link}`,
  sms_1h: (c) => `${c.name}, your strategy call starts in about an hour. Here's the link: ${c.link}`,
  sms_10m: (c) => `Starting in 10 minutes, ${c.name}: ${c.link}`,
  sms_noshow_1: (c) => `Hi ${c.name}, we missed you on the call just now. No stress, things come up. Grab a new time here: ${c.link}`,
  sms_noshow_2: (c) => `${c.name}, still keen to map out your first acquisition? A new time takes 10 seconds: ${c.link}`,
  sms_abandon: (c) => `Hi ${c.name}, it's Josh's team at G&L. Your application saved where you left off. It takes about 2 minutes to finish: ${c.link}`,
  sms_book_nudge: (c) => `Hi ${c.name}, good news: your application qualifies for a strategy call with Josh's team. Pick a time that suits you: ${c.link}`,
};

export const SMS_SEQUENCES: Record<string, SmsSequence> = {
  sms_booked: {
    id: 'sms_booked',
    stopIf: (l) => !booked(l) || ['showed', 'won', 'lost', 'no_show'].includes(l.status),
    steps: [
      { template: 'sms_confirm', offsetMs: 0, link: 'join' },
      { template: 'sms_24h', offsetMs: -24 * HOUR, anchor: 'call_at', link: 'reschedule' },
      { template: 'sms_1h', offsetMs: -1 * HOUR, anchor: 'call_at', link: 'join' },
      { template: 'sms_10m', offsetMs: -10 * MIN, anchor: 'call_at', link: 'join' },
    ],
  },
  sms_no_show: {
    id: 'sms_no_show',
    stopIf: (l) => l.status !== 'no_show',
    steps: [
      { template: 'sms_noshow_1', offsetMs: 10 * MIN, link: 'book' },
      { template: 'sms_noshow_2', offsetMs: 1 * DAY, link: 'book' },
    ],
  },
  sms_abandoned: {
    id: 'sms_abandoned',
    stopIf: (l) => Boolean(l.app_completed_at),
    steps: [{ template: 'sms_abandon', offsetMs: 30 * MIN, link: 'apply' }],
  },
  sms_book: {
    id: 'sms_book',
    stopIf: (l) => booked(l) || !['A', 'B'].includes(effectiveTier(l) ?? ''),
    steps: [{ template: 'sms_book_nudge', offsetMs: 2 * HOUR, link: 'book' }],
  },
};
export type SmsSequenceId = keyof typeof SMS_SEQUENCES;

export const smsConfigured = (rt: Runtime) => Boolean(rt.settings.TWILIO_ACCOUNT_SID && rt.settings.TWILIO_AUTH_TOKEN && rt.settings.SMS_FROM);
const smsOn = (rt: Runtime) => rt.settings.SMS_ENABLED.trim().toLowerCase() !== 'false';

/** Why this lead can't be texted (null = OK). */
export function smsBlock(lead: Lead) {
  if (!lead.phone) return 'no phone';
  if (!lead.call_consent_at) return 'no consent to text';
  if (lead.sms_opt_out_at) return 'replied STOP';
  if (lead.booking_source === 'calendly-direct') return 'imported contact';
  if (!callingZones(lead.phone)) return 'number outside the countries we text';
  return null;
}

/** 8am–8pm in every zone of the number's country (TCPA: 8am–9pm; we stay inside it). */
export function inTextingHours(t: number, zones: string[]) {
  return zones.length > 0 && zones.every((tz) => {
    try {
      const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(t));
      return h >= 8 && h < 20;
    } catch { return false; }
  });
}
export function nextTextingTime(t: number, zones: string[]) {
  for (let i = 0, x = t; i < 3 * 96; i++, x = Math.ceil((x + 1) / 900_000) * 900_000) if (inTextingHours(x, zones)) return x;
  return null;
}

export async function enqueueSms(rt: Runtime, lead: Lead, sequenceId: SmsSequenceId) {
  if (!smsOn(rt) || smsBlock(lead)) return 0;
  const seq = SMS_SEQUENCES[sequenceId];
  const now = Date.now();
  const stmts = seq.steps.flatMap((step, i) => {
    const anchor = step.anchor === 'call_at' ? lead.call_at : now;
    if (anchor == null) return [];
    const sendAt = anchor + step.offsetMs;
    if (step.anchor === 'call_at' && sendAt < now) return [];
    return [rt.env.DB.prepare(
      `INSERT INTO sms_messages (id, lead_id, direction, sequence, step, template, to_phone, send_at, status, created_at)
       VALUES (?, ?, 'out', ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(lead_id, sequence, step) WHERE direction = 'out' DO UPDATE SET send_at = excluded.send_at, status = 'pending', to_phone = excluded.to_phone, attempts = 0
         WHERE sms_messages.status IN ('pending', 'cancelled', 'skipped')`,
    ).bind(newId('sm'), lead.id, sequenceId, i, step.template, lead.phone, sendAt, now)];
  });
  if (stmts.length) await rt.env.DB.batch(stmts);
  return stmts.length;
}

export async function cancelSms(rt: Runtime, leadId: string, sequences?: SmsSequenceId[]) {
  const list = sequences ?? (Object.keys(SMS_SEQUENCES) as SmsSequenceId[]);
  await rt.env.DB.prepare(`UPDATE sms_messages SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending' AND sequence IN (${list.map(() => '?').join(',')})`).bind(leadId, ...list).run();
}

function linkTarget(rt: Runtime, lead: Lead, kind: SmsStep['link']) {
  const book = bookingUrlFor(rt, lead.closer_id, effectiveTier(lead)) ? `${rt.origin}/book` : `${rt.origin}/breakout`;
  switch (kind) {
    case 'join': return lead.booking_join_url && /^https:\/\//.test(lead.booking_join_url) ? lead.booking_join_url : `${rt.origin}/breakout`;
    case 'reschedule': return lead.booking_reschedule_url && /^https:\/\/calendly\.com\//.test(lead.booking_reschedule_url) ? lead.booking_reschedule_url : book;
    case 'book': return book;
    case 'apply': return `${rt.origin}/apply`;
    default: return `${rt.origin}/breakout`;
  }
}

/** Builds the text: their first name (only if it looks like a name), call time in their zone, one short link. */
export function buildSms(rt: Runtime, lead: Lead, template: string, step: SmsStep, smsId: string, firstText: boolean) {
  const tz = lead.timezone || callingZones(lead.phone)?.slice(-1)[0] || rt.settings.SALES_TIMEZONE || 'UTC';
  const name = safeFirstName(lead.first_name) ?? 'there';
  const time = lead.call_at ? formatCallTime(lead.call_at, tz).replace(/^(\w+) (\d+) (\w+) at /, '$1 $2 $3, ') : null;
  const body = SMS_TEMPLATES[template]({ name, time, link: `${rt.origin}/s/${smsId}` });
  return { body: firstText ? `${body}\nReply STOP to opt out.` : body, target: linkTarget(rt, lead, step.link) };
}

async function sendTwilio(rt: Runtime, to: string, body: string) {
  const s = rt.settings;
  const form = new URLSearchParams({ To: to, Body: body });
  if (/^MG[0-9a-f]{32}$/i.test(s.SMS_FROM)) form.set('MessagingServiceSid', s.SMS_FROM); else form.set('From', s.SMS_FROM);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${s.TWILIO_ACCOUNT_SID}:${s.TWILIO_AUTH_TOKEN}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${data.message ?? ''} (${data.code ?? ''})`.slice(0, 300));
  return data.sid ?? null;
}

interface SmsRow { id: string; lead_id: string; sequence: SmsSequenceId; step: number; template: string; to_phone: string; attempts: number }

/** Cron: send what's due (claimed atomically, re-checked against fresh lead data). */
export async function processSmsQueue(rt: Runtime, limit = 40) {
  if (!smsOn(rt)) return { due: 0, sent: 0 };
  const now = Date.now();
  const { results } = await rt.env.DB.prepare("SELECT id, lead_id, sequence, step, template, to_phone, attempts FROM sms_messages WHERE direction = 'out' AND status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT ?")
    .bind(now, limit).all<SmsRow>();
  let sent = 0;
  for (const row of results) {
    const claim = await rt.env.DB.prepare("UPDATE sms_messages SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'").bind(row.id).run();
    if (!claim.meta.changes) continue;
    const skip = (why: string) => rt.env.DB.prepare("UPDATE sms_messages SET status = 'skipped', error = ? WHERE id = ?").bind(why, row.id).run();
    const lead = await getLead(rt.env, row.lead_id);
    const seq = SMS_SEQUENCES[row.sequence];
    const step = seq?.steps[row.step];
    if (!lead || !seq || !step) { await skip('missing lead or step'); continue; }
    const why = smsBlock(lead) ?? (seq.stopIf?.(lead) ? 'sequence goal reached' : null) ?? (step.skipIf?.(lead) ? 'step condition' : null) ?? (lead.phone !== row.to_phone ? 'number changed' : null);
    if (why) { await skip(why); continue; }
    const zones = callingZones(lead.phone)!;
    if (!inTextingHours(now, zones)) {
      const next = nextTextingTime(now, zones);
      // Not worth sending a call reminder after the call has started.
      const stale = !next || (step.anchor === 'call_at' && lead.call_at && next > lead.call_at);
      await rt.env.DB.prepare('UPDATE sms_messages SET status = ?, attempts = attempts - 1, send_at = ? WHERE id = ?').bind(stale ? 'skipped' : 'pending', next ?? now, row.id).run();
      continue;
    }
    const today = await rt.env.DB.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE lead_id = ? AND direction = 'out' AND status IN ('sent', 'simulated') AND sent_at > ?").bind(lead.id, now - DAY).first<{ n: number }>();
    if ((today?.n ?? 0) >= 3) { await skip('daily cap'); continue; }
    const before = await rt.env.DB.prepare("SELECT 1 FROM sms_messages WHERE lead_id = ? AND direction = 'out' AND status IN ('sent', 'simulated') LIMIT 1").bind(lead.id).first();
    try {
      const { body, target } = buildSms(rt, lead, row.template, step, row.id, !before);
      let providerId: string | null = null;
      let status = 'simulated';
      if (smsConfigured(rt)) { providerId = await sendTwilio(rt, lead.phone!, body); status = 'sent'; }
      await rt.env.DB.prepare('UPDATE sms_messages SET status = ?, sent_at = ?, provider_id = ?, body = ?, link_target = ?, error = NULL WHERE id = ?')
        .bind(status, Date.now(), providerId, body, target, row.id).run();
      await track(rt, await identityFromLead(rt.env, lead.id), { name: 'sms_sent', source: 'cron', props: { sequence: row.sequence, template: row.template, simulated: status === 'simulated' }, localOnly: true });
      sent++;
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).slice(0, 300);
      const retry = row.attempts + 1 < 3;
      await rt.env.DB.prepare('UPDATE sms_messages SET status = ?, error = ?, send_at = ? WHERE id = ?').bind(retry ? 'pending' : 'failed', message, Date.now() + 10 * MIN * (row.attempts + 1), row.id).run();
    }
  }
  return { due: results.length, sent };
}

/** /s/:id → the link inside a text (target stored server-side, so it can't be pointed anywhere else). */
export async function smsLinkTarget(rt: Runtime, id: string) {
  if (!/^[\w-]{6,40}$/.test(id)) return null;
  const row = await rt.env.DB.prepare("SELECT lead_id, link_target, clicked_at FROM sms_messages WHERE id = ? AND direction = 'out'").bind(id).first<{ lead_id: string; link_target: string | null; clicked_at: number | null }>();
  if (!row?.link_target) return null;
  if (!row.clicked_at) {
    await rt.env.DB.prepare('UPDATE sms_messages SET clicked_at = ? WHERE id = ?').bind(Date.now(), id).run();
    rt.waitUntil(identityFromLead(rt.env, row.lead_id).then((who) => track(rt, who, { name: 'sms_click', source: 'server', props: { sms_id: id }, localOnly: true })));
  }
  return row;
}

// ───────────── inbound (replies, STOP) ─────────────

/** Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted key+value pairs)). */
export async function verifyTwilio(authToken: string, url: string, params: Record<string, string>, signature: string | null) {
  if (!authToken || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return safeEqual(btoa(String.fromCharCode(...sig)), signature);
}

const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt ?out)\s*[.!]?\s*$/i;
const START = /^\s*(start|unstop|yes)\s*[.!]?\s*$/i;

export async function handleInboundSms(rt: Runtime, params: Record<string, string>) {
  const from = params.From ?? '';
  const body = (params.Body ?? '').slice(0, 1000);
  const lead = await leadByPhone(rt, from).catch(() => null);
  const now = Date.now();
  await rt.env.DB.prepare("INSERT INTO sms_messages (id, lead_id, direction, from_phone, body, status, created_at, sent_at, provider_id) VALUES (?, ?, 'in', ?, ?, 'received', ?, ?, ?)")
    .bind(newId('sm'), lead?.id ?? null, from, body, now, now, params.MessageSid ?? null).run();
  if (STOP.test(body)) {
    if (lead) {
      await updateLead(rt.env, lead.id, { sms_opt_out_at: now });
      await cancelSms(rt, lead.id);
      await track(rt, await identityFromLead(rt.env, lead.id), { name: 'sms_opt_out', source: 'webhook', localOnly: true });
    }
    return 'stop';
  }
  if (START.test(body) && lead?.sms_opt_out_at) { await updateLead(rt.env, lead.id, { sms_opt_out_at: null }); return 'start'; }
  if (lead) {
    await track(rt, await identityFromLead(rt.env, lead.id), { name: 'sms_reply', source: 'webhook', localOnly: true });
    rt.waitUntil(notifySlack(rt, lead, '💬 Text reply', [`“${plain(body.slice(0, 300))}”`, 'Reply from your phone or Twilio; the full thread is on the lead in Funnel HQ.'], 'voice'));
  }
  return lead ? 'reply' : 'unknown';
}

import { safeFirstName } from '../lib/text';
import type { Runtime } from '../app';
import { type Lead, effectiveTier, getLead, updateLead } from '../funnel/leads';
import { newId } from '../lib/ids';
import { safeEqual } from '../lib/crypto';
import { identityFromLead, track } from '../tracking/track';
import { bookingUrlFor } from '../funnel/routing';
import { callingZones } from './elevenlabs';
import { formatCallTime } from './email';
import { notifySlack, plain } from './notify';
import { leadByPhone } from './voice';
import { cloudApiConfigured, inWhatsAppWindow, sendWhatsAppTemplate, sendWhatsAppText } from './whatsapp';
import { DEFAULT_SMS_SEQUENCES, SMS_ANCHORS, SMS_CHANNELS, SMS_LINKS, SMS_SKIPS, SMS_TRIGGERS, type SmsSequenceDef, type SmsStepDef, type SmsTrigger } from './sms-defaults';

/**
 * SMS follow-up through Twilio, driven by sequences you edit in Funnel HQ → SMS (stored in kv_state
 * `sms:sequences`, defaults in sms-defaults.ts). Rules that can't be edited away:
 *  - only to people who ticked "Call or text me at this number", never after STOP, never imported contacts;
 *  - only 8am–8pm in every time zone of the number's country, max 3 texts per person per day;
 *  - the first text to anyone says who it's from and "Reply STOP to opt out";
 *  - links are short /s/<id> redirects whose target is stored server-side.
 * Without Twilio keys texts are "simulated".
 */

const MIN = 60_000, DAY = 24 * 60 * MIN;
const booked = (l: Lead) => Boolean(l.booked_at) && !l.booking_cancelled_at;
const cameToWebinar = (l: Lead) => Boolean(l.webinar_attended_at && l.webinar_at && l.webinar_attended_at >= l.webinar_at - 30 * MIN);

/** When a whole sequence has done its job (built in, per trigger). */
const STOP: Record<SmsTrigger, (l: Lead) => boolean> = {
  booked: (l) => !booked(l) || ['showed', 'won', 'lost', 'no_show'].includes(l.status),
  no_show: (l) => l.status !== 'no_show',
  abandoned: (l) => Boolean(l.app_completed_at),
  qualified: (l) => booked(l) || !['A', 'B'].includes(effectiveTier(l) ?? ''),
  cancelled: (l) => booked(l) || ['won', 'lost'].includes(l.status),
  showed: (l) => l.status !== 'showed',
  lost: (l) => l.status !== 'lost' || booked(l),
  won: (l) => l.status !== 'won' || Boolean(l.refunded_at),
  webinar: (l) => ['won', 'lost', 'disqualified'].includes(l.status),
};

const SKIP: Record<(typeof SMS_SKIPS)[number], (l: Lead, clicked: boolean) => boolean> = {
  applied: (l) => Boolean(l.app_completed_at),
  booked: (l) => booked(l),
  confirmed: (l) => Boolean(l.sms_confirmed_at && l.booked_at && l.sms_confirmed_at >= l.booked_at),
  attended: (l) => cameToWebinar(l),
  missed: (l) => !cameToWebinar(l),
  clicked: (_l, clicked) => clicked,
};

// ───────────── sequences (editable) ─────────────

export async function loadSmsSequences(rt: Runtime): Promise<SmsSequenceDef[]> {
  const row = await rt.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'sms:sequences'").first<{ value: string }>();
  if (!row) return DEFAULT_SMS_SEQUENCES;
  try {
    const saved = cleanSequences(JSON.parse(row.value));
    // A trigger added in a later version shows up with its defaults.
    return [...saved, ...DEFAULT_SMS_SEQUENCES.filter((d) => !saved.some((s) => s.id === d.id))];
  } catch {
    return DEFAULT_SMS_SEQUENCES;
  }
}

/** Validates sequences from the dashboard: known triggers/anchors/links/skips, sane timing and length. */
export function cleanSequences(raw: unknown): SmsSequenceDef[] {
  if (!Array.isArray(raw)) throw new Error('sequences must be a list');
  const out: SmsSequenceDef[] = [];
  for (const r of raw.slice(0, 20) as Record<string, unknown>[]) {
    if (!r || !(String(r.id) in SMS_TRIGGERS) || out.some((x) => x.id === r.id)) continue;
    const steps: SmsStepDef[] = [];
    let maxN = 0;
    for (const st of (Array.isArray(r.steps) ? r.steps : []).slice(0, 20) as Record<string, unknown>[]) {
      const n = Math.floor(Number(st?.n));
      if (!Number.isFinite(n) || n < 1 || n > 10_000 || steps.some((x) => x.n === n)) continue;
      const body = typeof st.body === 'string' ? st.body.replace(/\r/g, '').trim().slice(0, 480) : '';
      if (!body) continue;
      const anchor = SMS_ANCHORS.includes(st.anchor as never) ? (st.anchor as SmsStepDef['anchor']) : 'trigger';
      const offsetMin = Math.max(-30 * 24 * 60, Math.min(365 * 24 * 60, Math.round(Number(st.offsetMin) || 0)));
      const link = SMS_LINKS.includes(st.link as never) ? (st.link as SmsStepDef['link']) : 'none';
      const skip = (Array.isArray(st.skip) ? st.skip : []).filter((k): k is SmsStepDef['skip'][number] => SMS_SKIPS.includes(k as never));
      const wa = typeof st.wa === 'string' && /^[a-z0-9_]{1,200}$/.test(st.wa.trim()) ? st.wa.trim() : undefined;
      steps.push({ n, body, anchor, offsetMin, link, skip: [...new Set(skip)], ...(wa ? { wa } : {}) });
      maxN = Math.max(maxN, n);
    }
    const channel = SMS_CHANNELS.includes(r.channel as never) ? (r.channel as SmsSequenceDef['channel']) : 'sms';
    out.push({ id: r.id as SmsTrigger, enabled: r.enabled !== false, channel, steps, next: Math.max(maxN + 1, Math.floor(Number(r.next)) || 0) });
  }
  return out;
}

export const smsConfigured = (rt: Runtime) => Boolean(rt.settings.TWILIO_ACCOUNT_SID && rt.settings.TWILIO_AUTH_TOKEN && rt.settings.SMS_FROM);
const smsOn = (rt: Runtime) => rt.settings.SMS_ENABLED.trim().toLowerCase() !== 'false';

/** Agreed to texts (SMS). */
const smsOk = (l: Lead) => Boolean(l.call_consent_at || l.sms_consent_at);
/** Agreed to WhatsApp (consent wording that names it), or started a WhatsApp chat with us themselves. */
export const waOk = (l: Lead) => Boolean(l.wa_consent_at || l.whatsapp_connected_at);

/** Why this lead can't be messaged at all (null = OK on at least one channel). */
export function smsBlock(lead: Lead) {
  if (!lead.phone) return 'no phone';
  if (!smsOk(lead) && !waOk(lead)) return 'no consent to text';
  if (lead.sms_opt_out_at) return 'replied STOP';
  if (lead.booking_source === 'calendly-direct') return 'imported contact';
  if (!callingZones(lead.phone)) return 'number outside the countries we text';
  return null;
}

/** 8am–8pm in every zone of the number's country (TCPA allows 8am–9pm; we stay inside it). */
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

function anchorTime(step: SmsStepDef, lead: Lead, now: number) {
  if (step.anchor === 'call') return lead.call_at ?? null;
  if (step.anchor === 'webinar') return lead.webinar_at ?? null;
  return now;
}

/** Starts a trigger's sequence for this lead (re-starting reschedules texts that haven't gone yet). */
export async function startSms(rt: Runtime, lead: Lead, trigger: SmsTrigger) {
  if (!smsOn(rt) || smsBlock(lead)) return 0;
  if (!smsOk(lead) && !(waOk(lead) && cloudApiConfigured(rt.settings))) return 0;
  const seq = (await loadSmsSequences(rt)).find((s) => s.id === trigger);
  if (!seq?.enabled) return 0;
  const now = Date.now();
  const stmts = seq.steps.flatMap((step) => {
    const anchor = anchorTime(step, lead, now);
    if (anchor == null) return [];
    const sendAt = anchor + step.offsetMin * MIN;
    if (step.anchor !== 'trigger' && sendAt < now - 5 * MIN) return [];
    return [rt.env.DB.prepare(
      `INSERT INTO sms_messages (id, lead_id, direction, sequence, step, template, to_phone, send_at, status, created_at)
       VALUES (?, ?, 'out', ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(lead_id, sequence, step) WHERE direction = 'out' DO UPDATE SET send_at = excluded.send_at, status = 'pending', to_phone = excluded.to_phone, attempts = 0
         WHERE sms_messages.status IN ('pending', 'cancelled', 'skipped')`,
    ).bind(newId('sm'), lead.id, trigger, step.n, `${trigger}:${step.n}`, lead.phone, sendAt, now)];
  });
  if (stmts.length) await rt.env.DB.batch(stmts);
  return stmts.length;
}

export async function stopSms(rt: Runtime, leadId: string, triggers?: SmsTrigger[]) {
  const list = triggers ?? (Object.keys(SMS_TRIGGERS) as SmsTrigger[]);
  await rt.env.DB.prepare(`UPDATE sms_messages SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending' AND sequence IN (${list.map(() => '?').join(',')})`).bind(leadId, ...list).run();
}

// ───────────── rendering ─────────────

function linkTarget(rt: Runtime, lead: Lead, kind: SmsStepDef['link']) {
  const book = bookingUrlFor(rt, lead.closer_id, effectiveTier(lead)) ? `${rt.origin}/book` : `${rt.origin}/breakout`;
  const web = (rt.settings.WEBINAR_URL || `${rt.origin}/webinar`).replace(/\/+$/, '');
  switch (kind) {
    case 'join': return lead.booking_join_url && /^https:\/\//.test(lead.booking_join_url) ? lead.booking_join_url : `${rt.origin}/breakout`;
    case 'reschedule': return lead.booking_reschedule_url && /^https:\/\/calendly\.com\//.test(lead.booking_reschedule_url) ? lead.booking_reschedule_url : book;
    case 'book': return book;
    case 'apply': return `${rt.origin}/apply`;
    case 'breakout': return `${rt.origin}/breakout`;
    case 'webinar_room': return lead.webinar_token ? `${web}/room/${lead.webinar_token}` : web;
    case 'webinar_replay': return lead.webinar_token ? `${web}/replay/${lead.webinar_token}` : web;
    default: return null;
  }
}

const fmtTime = (t: number, tz: string) => formatCallTime(t, tz).replace(/^(\w+) (\d+) (\w+) at /, '$1 $2 $3, ');

/** Fills merge tags; {link} becomes the short tracked link (added at the end if the text forgot it). */
export function renderSms(rt: Runtime, lead: Lead, step: SmsStepDef, smsId: string, firstText: boolean) {
  const tz = lead.timezone || callingZones(lead.phone)?.slice(-1)[0] || rt.settings.SALES_TIMEZONE || 'UTC';
  const rep = rt.reps?.find((r) => r.id === lead.closer_id);
  const target = linkTarget(rt, lead, step.link);
  const short = target ? `${rt.origin}/s/${smsId}` : '';
  const values: Record<string, string> = {
    first_name: safeFirstName(lead.first_name) ?? 'there',
    call_time: lead.call_at ? fmtTime(lead.call_at, tz) : 'your booked time',
    closer: rep?.name ?? "Josh's team",
    webinar_time: lead.webinar_at ? fmtTime(lead.webinar_at, tz) : 'your session time',
    site_name: rt.settings.SITE_NAME || 'G&L',
    link: short,
  };
  let body = step.body.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? values[k] : m));
  if (short && !step.body.includes('{link}')) body = `${body} ${short}`;
  // Curly quotes and long dashes force Unicode (70-char segments, ~2x the cost): use the plain ones.
  body = body.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...');
  body = body.replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '');
  if (firstText && !/\bSTOP\b/.test(body)) body = `${body}\nReply STOP to opt out.`;
  return { body, target, values };
}

/** Merge tags in the order they appear (the {link} is added at the end when the text forgot it). */
function tagOrder(step: Pick<SmsStepDef, 'body' | 'link'>) {
  const body = step.link !== 'none' && !step.body.includes('{link}') ? `${step.body} {link}` : step.body;
  return { body, tags: [...body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]) };
}

/**
 * The text to submit to Meta as this step's WhatsApp template: merge tags become {{1}}, {{2}}… in order.
 * Meta rejects a variable at the very start or end, so a greeting / sign-off is added where needed.
 */
export function waTemplateText(step: Pick<SmsStepDef, 'body' | 'link'>, siteName = 'G&L') {
  let i = 0;
  let text = tagOrder(step).body.replace(/\{(\w+)\}/g, () => `{{${++i}}}`).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
  if (/^\{\{/.test(text)) text = `Hi ${text}`;
  if (/\}\}[.!?]?$/.test(text)) text = `${text}\n\n- ${siteName}`;
  return text;
}
export const waTemplateParams = (step: Pick<SmsStepDef, 'body' | 'link'>, values: Record<string, string>) => tagOrder(step).tags.map((k) => values[k] ?? '');

/** GSM-7 vs Unicode segment count, for the editor and tests. */
export function smsSegments(text: string) {
  const gsm = /^[\n\r @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/.test(text);
  const len = text.length;
  return gsm ? (len <= 160 ? 1 : Math.ceil(len / 153)) : (len <= 70 ? 1 : Math.ceil(len / 67));
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
export { sendTwilio as sendSmsNow };

interface SmsRow { id: string; lead_id: string; sequence: SmsTrigger; step: number; to_phone: string; attempts: number }

/** Cron: send what's due (claimed atomically, re-checked against fresh lead data and the current sequence). */
export async function processSmsQueue(rt: Runtime, limit = 40) {
  if (!smsOn(rt)) return { due: 0, sent: 0 };
  const now = Date.now();
  const { results } = await rt.env.DB.prepare("SELECT id, lead_id, sequence, step, to_phone, attempts FROM sms_messages WHERE direction = 'out' AND status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT ?")
    .bind(now, limit).all<SmsRow>();
  if (!results.length) return { due: 0, sent: 0 };
  const sequences = await loadSmsSequences(rt);
  let sent = 0;
  for (const row of results) {
    const claim = await rt.env.DB.prepare("UPDATE sms_messages SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'").bind(row.id).run();
    if (!claim.meta.changes) continue;
    const skip = (why: string) => rt.env.DB.prepare("UPDATE sms_messages SET status = 'skipped', error = ? WHERE id = ?").bind(why, row.id).run();
    const lead = await getLead(rt.env, row.lead_id);
    const seq = sequences.find((s) => s.id === row.sequence);
    const step = seq?.steps.find((s) => s.n === row.step);
    if (!lead) { await skip('lead deleted'); continue; }
    if (!seq || !seq.enabled) { await skip('sequence turned off'); continue; }
    if (!step) { await skip('text removed from the sequence'); continue; }
    const clicked = Boolean(await rt.env.DB.prepare("SELECT 1 FROM sms_messages WHERE lead_id = ? AND sequence = ? AND clicked_at IS NOT NULL LIMIT 1").bind(lead.id, row.sequence).first());
    const why = smsBlock(lead)
      ?? (STOP[row.sequence]?.(lead) ? 'sequence goal reached' : null)
      ?? (step.skip.find((k) => SKIP[k](lead, clicked)) ? `skip: ${step.skip.find((k) => SKIP[k](lead, clicked))}` : null)
      ?? (lead.phone !== row.to_phone ? 'number changed' : null);
    if (why) { await skip(why); continue; }
    const zones = callingZones(lead.phone)!;
    if (!inTextingHours(now, zones)) {
      const next = nextTextingTime(now, zones);
      const anchor = step.anchor === 'call' ? lead.call_at : step.anchor === 'webinar' ? lead.webinar_at : null;
      // A "before the call" text that can only go after the call has started is pointless.
      const stale = !next || (anchor != null && step.offsetMin < 0 && next > anchor);
      await rt.env.DB.prepare('UPDATE sms_messages SET status = ?, attempts = attempts - 1, send_at = ?, error = ? WHERE id = ?').bind(stale ? 'skipped' : 'pending', next ?? now, stale ? 'outside texting hours' : null, row.id).run();
      continue;
    }
    const today = await rt.env.DB.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE lead_id = ? AND direction = 'out' AND status IN ('sent', 'simulated') AND sent_at > ?").bind(lead.id, now - DAY).first<{ n: number }>();
    if ((today?.n ?? 0) >= 3) { await skip('daily cap (3)'); continue; }
    const before = await rt.env.DB.prepare("SELECT 1 FROM sms_messages WHERE lead_id = ? AND direction = 'out' AND status IN ('sent', 'simulated') LIMIT 1").bind(lead.id).first();
    try {
      const { body, target, values } = renderSms(rt, lead, step, row.id, !before);
      let providerId: string | null = null;
      let status = 'simulated';
      let channel: 'sms' | 'whatsapp' = 'sms';
      let note: string | null = null;
      // WhatsApp first when the sequence says so and we can reach them there; otherwise the same message by SMS.
      if (seq.channel === 'whatsapp' && waOk(lead) && cloudApiConfigured(rt.settings)) {
        try {
          if (await inWhatsAppWindow(rt, lead.id)) { providerId = await sendWhatsAppText(rt, lead, body); channel = 'whatsapp'; status = 'sent'; }
          else if (step.wa) { providerId = await sendWhatsAppTemplate(rt, lead, step.wa, waTemplateParams(step, values)); channel = 'whatsapp'; status = 'sent'; }
          else note = 'WhatsApp: no approved template for this text, sent by SMS';
        } catch (err) {
          note = `WhatsApp failed, sent by SMS: ${String(err instanceof Error ? err.message : err)}`.slice(0, 300);
        }
      }
      if (channel === 'sms') {
        if (!smsOk(lead)) { await skip(note ?? 'no consent to SMS (WhatsApp only)'); continue; }
        if (smsConfigured(rt)) { providerId = await sendTwilio(rt, lead.phone!, body); status = 'sent'; }
      }
      await rt.env.DB.prepare('UPDATE sms_messages SET status = ?, sent_at = ?, provider_id = ?, body = ?, link_target = ?, channel = ?, error = ? WHERE id = ?')
        .bind(status, Date.now(), providerId, body, target, channel, note, row.id).run();
      await track(rt, await identityFromLead(rt.env, lead.id), { name: channel === 'whatsapp' ? 'whatsapp_sent' : 'sms_sent', source: 'cron', props: { sequence: row.sequence, step: row.step, simulated: status === 'simulated' }, localOnly: true });
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

// ───────────── inbound (replies, STOP, "C" to confirm) ─────────────

/** Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted key+value pairs)). */
export async function verifyTwilio(authToken: string, url: string, params: Record<string, string>, signature: string | null) {
  if (!authToken || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return safeEqual(btoa(String.fromCharCode(...sig)), signature);
}

const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt ?out)\s*[.!]?\s*$/i;
const START_WORDS = /^\s*(start|unstop)\s*[.!]?\s*$/i;
const CONFIRM_WORDS = /^\s*(c|y|yes|yep|confirm|confirmed|👍)\s*[.!]?\s*$/i;

/** Returns the auto-reply text (or null) for Twilio to send back. */
export async function handleInboundSms(rt: Runtime, params: Record<string, string>): Promise<{ kind: string; reply: string | null }> {
  const from = params.From ?? '';
  const body = (params.Body ?? '').slice(0, 1000);
  const lead = await leadByPhone(rt, from).catch(() => null);
  const now = Date.now();
  await rt.env.DB.prepare("INSERT INTO sms_messages (id, lead_id, direction, from_phone, body, status, created_at, sent_at, provider_id) VALUES (?, ?, 'in', ?, ?, 'received', ?, ?, ?)")
    .bind(newId('sm'), lead?.id ?? null, from, body, now, now, params.MessageSid ?? null).run();
  return handleReplyWords(rt, lead, body, 'sms');
}

/** STOP / START / "C" to confirm, from a text or a WhatsApp message. Other replies ping the team. */
export async function handleReplyWords(rt: Runtime, lead: Lead | null, body: string, channel: 'sms' | 'whatsapp'): Promise<{ kind: string; reply: string | null }> {
  const now = Date.now();
  if (STOP_WORDS.test(body)) {
    if (lead) {
      await updateLead(rt.env, lead.id, { sms_opt_out_at: now });
      await stopSms(rt, lead.id);
      await track(rt, await identityFromLead(rt.env, lead.id), { name: 'sms_opt_out', source: 'webhook', localOnly: true });
    }
    // Carriers / Twilio confirm SMS opt-outs; on WhatsApp we say it ourselves.
    return { kind: 'stop', reply: channel === 'whatsapp' ? "You're unsubscribed. We won't message you again." : null };
  }
  if (START_WORDS.test(body) && lead?.sms_opt_out_at) { await updateLead(rt.env, lead.id, { sms_opt_out_at: null }); return { kind: 'start', reply: null }; }
  if (lead && CONFIRM_WORDS.test(body) && booked(lead) && lead.status === 'booked') {
    await updateLead(rt.env, lead.id, { sms_confirmed_at: now });
    await track(rt, await identityFromLead(rt.env, lead.id), { name: 'sms_confirmed', source: 'webhook', localOnly: true });
    const tz = lead.timezone || callingZones(lead.phone)?.slice(-1)[0] || rt.settings.SALES_TIMEZONE || 'UTC';
    return { kind: 'confirmed', reply: `Thanks ${safeFirstName(lead.first_name) ?? ''}, you're confirmed${lead.call_at ? ` for ${fmtTime(lead.call_at, tz)}` : ''}. Speak then.`.replace('Thanks ,', 'Thanks,') };
  }
  if (lead) {
    await track(rt, await identityFromLead(rt.env, lead.id), { name: channel === 'whatsapp' ? 'whatsapp_reply' : 'sms_reply', source: 'webhook', localOnly: true });
    rt.waitUntil(notifySlack(rt, lead, channel === 'whatsapp' ? '💬 WhatsApp reply' : '💬 Text reply', [`“${plain(body.slice(0, 300))}”`, channel === 'whatsapp' ? 'Reply from the WhatsApp Business app within 24 hours.' : 'Reply from Twilio or your phone; the thread is on the lead in Funnel HQ.'], 'voice'));
  }
  return { kind: lead ? 'reply' : 'unknown', reply: null };
}

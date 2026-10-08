import type { Runtime } from '../app';
import { BRAND } from '../config';
import { hmacHex } from '../lib/crypto';
import { newId } from '../lib/ids';
import { getSecret } from '../lib/secret';
import { type Lead, getLead } from '../funnel/leads';
import { bookingUrlFor } from '../funnel/routing';
import { effectiveTier } from '../funnel/leads';
import { identityFromLead, track } from '../tracking/track';
import { SEQUENCES, type SequenceId } from './sequences';
import { TEMPLATES, renderEmail } from './templates';
import { whatsappLink } from './whatsapp';

const MAX_ATTEMPTS = 3;

/** Schedules every step of a sequence. Re-enqueueing (e.g. a rescheduled call) refreshes pending steps. */
export async function enqueueSequence(rt: Runtime, lead: Pick<Lead, 'id' | 'email' | 'call_at' | 'unsubscribed_at'>, sequenceId: SequenceId) {
  if (!lead.email || lead.unsubscribed_at) return;
  const now = Date.now();
  const seq = SEQUENCES[sequenceId];
  const stmts = seq.steps.flatMap((step, i) => {
    const anchor = 'anchor' in step && step.anchor === 'call_at' ? lead.call_at : now;
    if (anchor == null) return [];
    const sendAt = anchor + step.offsetMs;
    // Reminders whose moment has already passed (e.g. a call booked for 30 minutes from now) are pointless.
    if ('anchor' in step && step.anchor === 'call_at' && sendAt < now) return [];
    return [
      rt.env.DB.prepare(
        `INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(lead_id, sequence, step) DO UPDATE SET send_at = excluded.send_at, status = 'pending', to_email = excluded.to_email, attempts = 0
           WHERE emails.status IN ('pending', 'cancelled', 'skipped')`,
      ).bind(newId('m'), lead.id, sequenceId, i, step.template, lead.email, sendAt, now),
    ];
  });
  if (stmts.length) await rt.env.DB.batch(stmts);
}

export async function cancelSequence(rt: Runtime, leadId: string, sequenceId: SequenceId) {
  await rt.env.DB.prepare("UPDATE emails SET status = 'cancelled' WHERE lead_id = ? AND sequence = ? AND status = 'pending'").bind(leadId, sequenceId).run();
}

async function linkSig(rt: Runtime, emailId: string, target: string) {
  return (await hmacHex(await getSecret(rt.env), `${emailId}|${target}`)).slice(0, 16);
}

export async function verifyLinkSig(rt: Runtime, emailId: string, target: string, sig: string) {
  return (await linkSig(rt, emailId, target)) === sig;
}

export async function unsubscribeSig(rt: Runtime, leadId: string) {
  return (await hmacHex(await getSecret(rt.env), `unsub|${leadId}`)).slice(0, 20);
}

async function leadTimezone(rt: Runtime, lead: Lead) {
  if (!lead.visitor_id) return null;
  const row = await rt.env.DB.prepare('SELECT COALESCE(client_tz, timezone) AS tz FROM sessions WHERE visitor_id = ? ORDER BY last_seen_at DESC LIMIT 1').bind(lead.visitor_id).first<{ tz: string | null }>();
  return row?.tz ?? null;
}

export function formatCallTime(ms: number, timeZone: string | null) {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  try {
    return new Intl.DateTimeFormat('en-AU', { ...opts, timeZone: timeZone ?? 'UTC' }).format(ms);
  } catch {
    return new Intl.DateTimeFormat('en-AU', { ...opts, timeZone: 'UTC' }).format(ms);
  }
}

/** Builds a fully rendered, tracked email for a lead. */
export async function buildEmail(rt: Runtime, lead: Lead, emailId: string, template: string, utmCampaign: string) {
  const tpl = TEMPLATES[template];
  if (!tpl) throw new Error(`unknown template ${template}`);
  const tz = lead.call_at ? await leadTimezone(rt, lead) : null;

  const tracked = new Map<string, string>();
  const link = (path: string) => {
    const target = /^https?:/.test(path) ? path : `${rt.origin}${path}`;
    const url = new URL(target);
    if (url.origin === rt.origin) {
      url.searchParams.set('utm_source', 'email');
      url.searchParams.set('utm_medium', 'email');
      url.searchParams.set('utm_campaign', utmCampaign);
      url.searchParams.set('utm_content', template);
    }
    const placeholder = `__LINK_${tracked.size}__`;
    tracked.set(placeholder, url.toString());
    return placeholder;
  };
  const wa = whatsappLink(rt.settings, lead, 'question');
  const content = tpl({
    lead,
    name: lead.first_name || 'there',
    siteName: rt.settings.SITE_NAME || BRAND.name,
    link,
    bookingUrl: bookingUrlFor(rt, lead.closer_id, effectiveTier(lead)),
    whatsappUrl: wa ? link(`/go/wa?src=email-${template}&l=${lead.ref_code}`) : null,
    callTime: lead.call_at ? formatCallTime(lead.call_at, tz) : null,
  });

  // Swap placeholders for signed, tracked redirect links.
  let serialized = JSON.stringify(content);
  for (const [placeholder, target] of tracked) {
    const sig = await linkSig(rt, emailId, target);
    const redirect = `${rt.origin}/r/${emailId}/${sig}?u=${encodeURIComponent(target)}`;
    serialized = serialized.split(placeholder).join(redirect);
  }
  const final = JSON.parse(serialized) as typeof content;

  const unsubscribeUrl = `${rt.origin}/u/${lead.id}/${await unsubscribeSig(rt, lead.id)}`;
  const { html, text } = renderEmail(final, {
    openPixel: `${rt.origin}/o/${emailId}.gif`,
    unsubscribeUrl,
    signature: rt.settings.EMAIL_SIGNATURE || 'Josh',
    address: rt.settings.BUSINESS_ADDRESS || rt.settings.SITE_NAME || BRAND.name,
  });
  return { subject: final.subject, html, text, unsubscribeUrl };
}

/** Resend (https://resend.com/docs/api-reference/emails/send-email). Returns the provider message id. */
export async function sendViaResend(rt: Runtime, msg: { to: string; subject: string; html: string; text: string; unsubscribeUrl: string; tags?: Record<string, string> }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${rt.settings.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: rt.settings.EMAIL_FROM,
      to: [msg.to],
      reply_to: rt.settings.EMAIL_REPLY_TO || undefined,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      headers: { 'List-Unsubscribe': `<${msg.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      tags: Object.entries(msg.tags ?? {}).map(([name, value]) => ({ name, value: value.replace(/[^\w-]/g, '_') })),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`resend ${res.status}: ${body.message ?? 'unknown error'}`);
  return body.id ?? null;
}

export const emailConfigured = (rt: Runtime) => Boolean(rt.settings.RESEND_API_KEY && rt.settings.EMAIL_FROM);

interface QueueRow {
  id: string;
  lead_id: string;
  sequence: SequenceId;
  step: number;
  template: string;
  to_email: string;
  attempts: number;
}

/**
 * Sends everything that is due. Each row is claimed atomically (pending →
 * sending) so overlapping cron runs never double-send. Without an email
 * provider connected, messages are marked "simulated" so the whole flow can be
 * tested end to end from the dashboard.
 */
export async function processEmailQueue(rt: Runtime, limit = 50) {
  const now = Date.now();
  const { results } = await rt.env.DB.prepare(
    "SELECT id, lead_id, sequence, step, template, to_email, attempts FROM emails WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT ?",
  )
    .bind(now, limit)
    .all<QueueRow>();

  let sent = 0;
  for (const row of results) {
    const claim = await rt.env.DB.prepare("UPDATE emails SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'").bind(row.id).run();
    if (!claim.meta.changes) continue;

    const lead = await getLead(rt.env, row.lead_id);
    const seq = SEQUENCES[row.sequence];
    const step = seq?.steps[row.step];
    const skip = (reason: string) => rt.env.DB.prepare("UPDATE emails SET status = 'skipped', error = ? WHERE id = ?").bind(reason, row.id).run();

    if (!lead || !seq || !step) { await skip('missing lead or step'); continue; }
    if (lead.unsubscribed_at) { await skip('unsubscribed'); continue; }
    if ('stopIf' in seq && seq.stopIf?.(lead)) { await skip('sequence goal reached'); continue; }
    if ('skipIf' in step && typeof step.skipIf === 'function' && step.skipIf(lead)) { await skip('step condition'); continue; }

    try {
      const email = await buildEmail(rt, lead, row.id, row.template, `seq-${row.sequence}`);
      let providerId: string | null = null;
      let status = 'simulated';
      if (emailConfigured(rt)) {
        providerId = await sendViaResend(rt, { to: row.to_email, ...email, tags: { sequence: row.sequence, template: row.template } });
        status = 'sent';
      }
      await rt.env.DB.prepare('UPDATE emails SET status = ?, sent_at = ?, provider_id = ?, subject = ?, error = NULL WHERE id = ?')
        .bind(status, Date.now(), providerId, email.subject, row.id)
        .run();
      await track(rt, await identityFromLead(rt.env, lead.id), {
        name: 'email_sent',
        source: 'cron',
        props: { email_id: row.id, sequence: row.sequence, template: row.template, simulated: status === 'simulated' },
      });
      sent++;
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).slice(0, 500);
      const retry = row.attempts + 1 < MAX_ATTEMPTS;
      await rt.env.DB.prepare('UPDATE emails SET status = ?, error = ?, send_at = ? WHERE id = ?')
        .bind(retry ? 'pending' : 'failed', message, Date.now() + 10 * 60_000 * (row.attempts + 1), row.id)
        .run();
      console.error(`email ${row.id} failed`, message);
    }
  }
  return { due: results.length, sent };
}

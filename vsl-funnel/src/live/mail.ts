import type { Runtime } from '../app';
import type { Lead } from '../funnel/leads';
import { emailConfigured, sendViaResend, unsubscribeSig } from '../integrations/email';
import { company, contractEmail } from '../sales/contracts';
import { escHtml } from '../followup/dossier';
import { newId } from '../lib/ids';

/**
 * One-off emails for the live funnels (reminders, replay, deposit onboarding), in the agreement style from
 * Josh's address. Each email is a row in `emails` claimed before it is sent (status 'sending', never 'pending',
 * so the main queue never picks it up), keyed (lead, sequence, step): overlapping cron runs and repeated
 * triggers never send twice. A failed send is retried on a later run, up to three attempts in all.
 */

export interface Mail { subject: string; preheader: string; heading: string; paras: string[]; button?: { label: string; href: string } }

/** Plain text to HTML: escaped, with bare https links made clickable. */
const toHtml = (p: string) => escHtml(p).replace(/(https:\/\/[^\s<]+[^\s<.,;:)])/g, '<a href="$1" style="color:#0f2c5c">$1</a>');

export async function sendOnce(rt: Runtime, lead: Pick<Lead, 'id' | 'email'>, sequence: string, step: number, template: string, mail: Mail, o: { unsubscribe?: boolean } = {}) {
  if (!lead.email) return false;
  const db = rt.env.DB;
  const now = Date.now();
  const claim = await db.prepare(
    `INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', 1, ?)
     ON CONFLICT(lead_id, sequence, step) DO UPDATE SET status = 'sending', attempts = emails.attempts + 1, send_at = excluded.send_at
       WHERE emails.status = 'failed' AND emails.attempts < 3`,
  ).bind(newId('m'), lead.id, sequence, step, template, lead.email, now, now).run();
  if (!claim.meta.changes) return false;
  const co = company(rt);
  const m = contractEmail({ preheader: mail.preheader, heading: mail.heading, paras: mail.paras.map(toHtml), button: mail.button, sender: co.signer, company: co.name, address: co.address });
  const where = 'WHERE lead_id = ? AND sequence = ? AND step = ?';
  try {
    let status = 'simulated';
    let providerId: string | null = null;
    if (emailConfigured(rt)) {
      const unsubscribeUrl = o.unsubscribe ? `${rt.origin}/u/${lead.id}/${await unsubscribeSig(rt, lead.id)}` : undefined;
      providerId = await sendViaResend(rt, { to: lead.email, subject: mail.subject, html: m.html, text: m.text, from: co.from, unsubscribeUrl, tags: { sequence, template } });
      status = 'sent';
    }
    await db.prepare(`UPDATE emails SET status = ?, sent_at = ?, provider_id = ?, subject = ?, error = NULL ${where}`).bind(status, Date.now(), providerId, mail.subject, lead.id, sequence, step).run();
    return true;
  } catch (e) {
    await db.prepare(`UPDATE emails SET status = 'failed', error = ? ${where}`).bind(String(e instanceof Error ? e.message : e).slice(0, 500), lead.id, sequence, step).run();
    console.error('live email failed', template, e);
    return false;
  }
}

/** Marks a step as skipped so it is never sent later (e.g. the 24-hour reminder for someone who registered an hour before). */
export async function skipOnce(rt: Runtime, lead: Pick<Lead, 'id' | 'email'>, sequence: string, step: number, template: string, why: string) {
  if (!lead.email) return;
  await rt.env.DB.prepare(
    `INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', ?, ?)
     ON CONFLICT(lead_id, sequence, step) DO NOTHING`,
  ).bind(newId('m'), lead.id, sequence, step, template, lead.email, Date.now(), why, Date.now()).run();
}

import type { Runtime } from '../app';
import { type Lead, getLead, updateLead } from '../funnel/leads';
import { newId } from '../lib/ids';
import { identityFromLead, track } from '../tracking/track';
import { PAIN_POINTS, type Pain, RESOURCES, isPain } from './sales-playbook';

/**
 * After a call: the pain point the person named, and the ONE guide they said yes to.
 *
 *  - The pain is kept per lead in kv_state (`pain:<leadId>`, no new lead columns) and written once into the lead's
 *    notes, so Funnel HQ shows it on the lead and later calls get it as {{known_pain}}.
 *  - The guide goes in ONE short email (template voice_resource: tracked link, unsubscribe link, auditEmail-clean),
 *    once per lead per guide (the emails table's unique (lead, sequence, step)), never to anyone who unsubscribed,
 *    replied STOP or asked not to be called, and never to a suppressed address (sendViaResend checks).
 */

export const RESOURCE_SEQUENCE = 'resource';
/** One stable step per guide: the unique index makes it once per lead per guide. */
export const resourceStep = (pain: Pain) => 900_000 + PAIN_POINTS.indexOf(pain);
const painKey = (leadId: string) => `pain:${leadId}`;

export interface PainRecord { pain: Pain; at: number; via: string }

export async function leadPain(rt: Pick<Runtime, 'env'>, leadId: string): Promise<PainRecord | null> {
  const row = await rt.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(painKey(leadId)).first<{ value: string }>().catch(() => null);
  if (!row) return null;
  try { const v = JSON.parse(row.value) as PainRecord; return isPain(v.pain) ? v : null; } catch { return null; }
}

/** The {{known_pain}} line for the next call. */
export async function knownPainLine(rt: Pick<Runtime, 'env'>, leadId: string) {
  const p = await leadPain(rt, leadId).catch(() => null);
  if (!p) return 'not known yet: ask.';
  const sent = await rt.env.DB.prepare("SELECT 1 AS x FROM emails WHERE lead_id = ? AND sequence = ? AND step = ? AND status IN ('sent', 'simulated') LIMIT 1").bind(leadId, RESOURCE_SEQUENCE, resourceStep(p.pain)).first().catch(() => null);
  return `${RESOURCES[p.pain].pain} (from an earlier call${sent ? `; the guide "${RESOURCES[p.pain].title}" was already emailed, so don't offer it again` : ''}). Confirm it is still the main thing before you build on it.`;
}

/** Saves the pain point; a new one is added to the lead's notes once. */
export async function recordPain(rt: Pick<Runtime, 'env'>, leadId: string, pain: Pain, via: string, now = Date.now()) {
  const prev = await leadPain(rt, leadId);
  await rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(painKey(leadId), JSON.stringify({ pain, at: now, via } satisfies PainRecord)).run();
  if (prev?.pain === pain) return false;
  const lead = await getLead(rt.env, leadId);
  if (!lead) return false;
  const line = `[AI call ${new Date(now).toISOString().slice(0, 10)}] Main challenge: ${RESOURCES[pain].pain}`;
  await updateLead(rt.env, leadId, { notes: [lead.notes, line].filter(Boolean).join('\n').slice(-4000) });
  return true;
}

/** Why a guide may not be emailed to this lead (null = it may). */
export function resourceBlock(lead: Pick<Lead, 'email' | 'unsubscribed_at' | 'do_not_call_at' | 'sms_opt_out_at'>): string | null {
  if (!lead.email) return 'no email address';
  if (lead.unsubscribed_at) return 'unsubscribed';
  if (lead.sms_opt_out_at) return 'replied STOP';
  if (lead.do_not_call_at) return 'asked not to be contacted';
  return null;
}

export type ResourceResult = { sent: true; simulated: boolean } | { sent: false; why: string };

/** Emails one guide, once per lead per guide. */
export async function sendResourceEmail(rt: Runtime, lead: Lead, pain: Pain, via: string): Promise<ResourceResult> {
  const why = resourceBlock(lead);
  if (why) return { sent: false, why };
  const db = rt.env.DB;
  const id = newId('m');
  const step = resourceStep(pain);
  const now = Date.now();
  const claim = await db.prepare(
    `INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, attempts, created_at) VALUES (?, ?, ?, ?, 'voice_resource', ?, ?, 'sending', 1, ?)
     ON CONFLICT(lead_id, sequence, step) DO NOTHING`,
  ).bind(id, lead.id, RESOURCE_SEQUENCE, step, lead.email, now, now).run();
  if (!claim.meta.changes) return { sent: false, why: 'already sent' };
  const r = RESOURCES[pain];
  try {
    const { buildEmail, emailConfigured, sendViaResend } = await import('./email');
    const email = await buildEmail(rt, lead, id, 'voice_resource', 'voice', { resource: { title: r.title, why: r.why, path: r.path } });
    const providerId = emailConfigured(rt) ? await sendViaResend(rt, { to: lead.email!, ...email, tags: { sequence: RESOURCE_SEQUENCE, template: 'voice_resource' } }) : null;
    await db.prepare(`UPDATE emails SET status = ?, sent_at = ?, provider_id = ?, subject = ?, error = NULL WHERE id = ?`).bind(providerId ? 'sent' : 'simulated', Date.now(), providerId, email.subject, id).run();
    await track(rt, await identityFromLead(rt.env, lead.id), { name: 'voice_resource_sent', source: 'server', props: { email_id: id, pain, via, simulated: !providerId } }).catch(() => null);
    return { sent: true, simulated: !providerId };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 500);
    await db.prepare(`UPDATE emails SET status = 'failed', error = ? WHERE id = ?`).bind(msg, id).run();
    return { sent: false, why: msg };
  }
}

/**
 * What every finished call does with the sales fields (pain_point, resource_wanted, next_action_committed,
 * main_objection). Never runs for an opt-out. Returns lines for the team's notification.
 */
export async function afterSalesCall(rt: Runtime, lead: Lead, facts: Record<string, unknown>, via: string): Promise<string[]> {
  const out: string[] = [];
  if (facts.do_not_call || facts.not_interested) return out;
  if (facts.next_action_committed === true) out.push('Committed to the next action.');
  if (typeof facts.main_objection === 'string' && facts.main_objection.trim()) out.push(`Objection: ${facts.main_objection.trim().slice(0, 200)}`);
  const pain = isPain(facts.pain_point) ? facts.pain_point : null;
  if (!pain) return out;
  await recordPain(rt, lead.id, pain, via).catch((e) => console.error('record pain', e));
  out.push(`Main challenge: ${RESOURCES[pain].pain}.`);
  if (facts.resource_wanted === true) {
    const fresh = (await getLead(rt.env, lead.id)) ?? lead;
    const r = await sendResourceEmail(rt, fresh, pain, via);
    out.push(r.sent ? `Guide emailed: ${RESOURCES[pain].title}.` : `Guide not emailed (${r.why}).`);
  }
  return out;
}

/** For the lead in Funnel HQ: the pain point and the guides emailed. */
export async function leadSales(rt: Pick<Runtime, 'env'>, leadId: string) {
  const p = await leadPain(rt, leadId).catch(() => null);
  const { results } = await rt.env.DB.prepare("SELECT step, status, sent_at FROM emails WHERE lead_id = ? AND sequence = ? ORDER BY sent_at").bind(leadId, RESOURCE_SEQUENCE).all<{ step: number; status: string; sent_at: number | null }>().catch(() => ({ results: [] as { step: number; status: string; sent_at: number | null }[] }));
  const guides = results.map((r) => { const pain = PAIN_POINTS.find((x) => resourceStep(x) === r.step); return pain ? { title: RESOURCES[pain].title, path: RESOURCES[pain].path, status: r.status, at: r.sent_at } : null; }).filter(Boolean);
  if (!p && !guides.length) return null;
  return { pain: p ? { id: p.pain, label: RESOURCES[p.pain].pain, at: p.at, via: p.via } : null, guides };
}

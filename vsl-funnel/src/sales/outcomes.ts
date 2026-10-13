import type { Runtime } from '../app';
import { LEAD_STATUSES, type Lead, type LeadStatus, getLead, updateLead } from '../funnel/leads';
import { cancelSequence, enqueueSequence, formatCallTime } from '../integrations/email';
import { leadLines, leadName, money, notify } from '../integrations/notify';
import type { SequenceId } from '../integrations/sequences';
import { cancelCalls, queueCall } from '../integrations/elevenlabs';
import { AI_CALLER } from '../config';
import { cancelSms, enqueueSms } from '../integrations/sms';
import { identityFromLead, track } from '../tracking/track';

/** What the dashboard (or a rep) can change on a lead. */
export interface LeadUpdate {
  status?: string;
  revenue?: number | string;
  cash_collected?: number | string;
  lost_reason?: string;
  notes?: string;
  tier_override?: string | null;
  closer_id?: string | null;
  setter_id?: string | null;
  temperature?: string | null;
  objection?: string | null;
  follow_up_at?: number | string | null;
  decision_maker?: boolean | number | string | null;
  fit_rating?: number | string | null;
  offer?: string | null;
  payment_plan?: string | null;
  installments_total?: number | string | null;
  next_payment_at?: number | string | null;
  contract_signed_at?: number | string | null;
  refunded_at?: number | string | null;
  refund_amount?: number | string | null;
  loi_signed_at?: number | string | null;
  target_business?: string | null;
  industry?: string | null;
}

export const TEMPERATURES = ['hot', 'warm', 'cold'] as const;
export const PAYMENT_PLANS = ['pif', 'split', 'monthly', 'custom'] as const;
export const OBJECTIONS = ['Price', 'Timing', 'Needs to think', 'Partner / spouse', 'Funding doubts', 'Trust / proof', 'Time to commit', 'Not a fit', 'Other'] as const;

/** Dates come from the dashboard as epoch ms or YYYY-MM-DD. */
const date = (v: unknown) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  return Number.isFinite(n) && n > 946_684_800_000 && n < 4_102_444_800_000 ? n : undefined;
};
const text = (v: unknown, max = 300) => (v === undefined ? undefined : String(v ?? '').trim().slice(0, max) || null);
const oneOf = <T extends string>(v: unknown, list: readonly T[]) => (v === undefined ? undefined : list.includes(String(v) as T) ? String(v) : null);

/** Imported Calendly history (or calls long past): record it, but don't email, ping or send conversions to ad platforms. */
export const isHistorical = (lead: Lead) => lead.booking_source === 'calendly-direct' || Boolean(lead.call_at && lead.call_at < Date.now() - 14 * 86_400_000);

export const LOST_REASONS = ['Price', 'Timing', 'No funding fit', 'Not a decision maker', 'Went with someone else', 'Not qualified', 'Ghosted', 'Other'] as const;

const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : undefined);

/**
 * Applies an update from the team: validates fields, stamps outcome times,
 * starts/stops the right follow-up sequences, tracks the change (Meta gets
 * CallShowed / Purchase) and pings Slack/Discord.
 */
export async function applyLeadUpdate(rt: Runtime, lead: Lead, body: LeadUpdate): Promise<Lead> {
  const fields: Partial<Record<keyof Lead, string | number | null>> = {};
  const status = body.status && (LEAD_STATUSES as readonly string[]).includes(body.status) ? (body.status as LeadStatus) : undefined;
  if (status) fields.status = status;
  const revenue = num(body.revenue);
  if (revenue !== undefined) fields.revenue = revenue;
  const cash = num(body.cash_collected);
  if (cash !== undefined) fields.cash_collected = cash;
  if (body.lost_reason !== undefined) fields.lost_reason = String(body.lost_reason ?? '').slice(0, 200) || null;
  if (body.notes !== undefined) fields.notes = String(body.notes ?? '').slice(0, 5000);
  if (body.tier_override !== undefined) fields.tier_override = ['A', 'B', 'C'].includes(String(body.tier_override)) ? body.tier_override : null;
  const markers: [keyof Lead, string | number | null | undefined][] = [
    ['temperature', oneOf(body.temperature, TEMPERATURES)],
    ['objection', text(body.objection, 120)],
    ['follow_up_at', date(body.follow_up_at)],
    ['decision_maker', body.decision_maker === undefined ? undefined : body.decision_maker === null || body.decision_maker === '' ? null : [true, 1, '1', 'true', 'yes'].includes(body.decision_maker as never) ? 1 : 0],
    ['fit_rating', body.fit_rating === undefined ? undefined : body.fit_rating === null || body.fit_rating === '' ? null : Math.max(1, Math.min(5, Math.round(Number(body.fit_rating)))) || null],
    ['offer', text(body.offer, 120)],
    ['payment_plan', oneOf(body.payment_plan, PAYMENT_PLANS)],
    ['installments_total', body.installments_total === undefined ? undefined : num(body.installments_total) ?? null],
    ['next_payment_at', date(body.next_payment_at)],
    ['contract_signed_at', date(body.contract_signed_at)],
    ['refunded_at', date(body.refunded_at)],
    ['refund_amount', num(body.refund_amount)],
    ['loi_signed_at', date(body.loi_signed_at)],
    ['target_business', text(body.target_business, 200)],
    ['industry', text(body.industry, 120)],
  ];
  for (const [k, v] of markers) if (v !== undefined) fields[k] = v;
  const repIds = new Set(rt.reps.map((r) => r.id));
  if (body.closer_id !== undefined) fields.closer_id = body.closer_id && repIds.has(body.closer_id) ? body.closer_id : null;
  if (body.setter_id !== undefined) fields.setter_id = body.setter_id && repIds.has(body.setter_id) ? body.setter_id : null;

  const changed = status && status !== lead.status;
  const now = Date.now();
  // Logging old calls: date the outcome to the call, so revenue lands in the right month.
  const when = isHistorical(lead) && lead.call_at ? lead.call_at : now;
  if (changed && ['showed', 'won', 'lost'].includes(status) && !lead.showed_at) fields.showed_at = when;
  if (changed && (status === 'won' || status === 'lost')) fields.closed_at = when;
  if (changed && status !== 'won' && status !== 'lost' && lead.closed_at) fields.closed_at = null;
  await updateLead(rt.env, lead.id, fields);
  const fresh = (await getLead(rt.env, lead.id))!;
  if (!changed) return fresh;
  const history = isHistorical(lead);

  // Follow-up sequences (never for imported history).
  if (!history) {
    if (status === 'no_show') {
      await Promise.all([cancelSequence(rt, lead.id, 'booked'), cancelSequence(rt, lead.id, 'precall')]);
      await enqueueSequence(rt, fresh, 'no_show');
      await cancelSms(rt, lead.id, ['sms_booked']);
      await enqueueSms(rt, fresh, 'sms_no_show');
      await queueCall(rt, fresh, 'rebook', AI_CALLER.rebookDelayMinutes);
    } else if (status === 'showed') {
      await Promise.all([cancelSequence(rt, lead.id, 'booked'), cancelSequence(rt, lead.id, 'no_show')]);
      await enqueueSequence(rt, fresh, 'post_call');
    } else if (status === 'won' || status === 'lost' || status === 'disqualified') {
      await Promise.all((['booked', 'no_show', 'post_call', 'tier_a', 'tier_b', 'tier_c', 'precall', 'cancelled', 'nurture', status === 'won' ? 'lost' : 'won'] as SequenceId[]).map((sq) => cancelSequence(rt, lead.id, sq)));
      if (status === 'won') await enqueueSequence(rt, fresh, 'won');
      if (status === 'lost') await enqueueSequence(rt, fresh, 'lost');
    }
    if (status !== 'no_show') await cancelCalls(rt, lead.id, ['rebook']);
    if (status !== 'no_show' && status !== 'booked') await cancelSms(rt, lead.id, ['sms_booked', 'sms_no_show', 'sms_book']);
  }

  await track(rt, await identityFromLead(rt.env, lead.id), {
    name: 'lead_status_changed',
    source: 'admin',
    props: { from: lead.status, to: status, revenue: fresh.revenue, cash_collected: fresh.cash_collected, closer: fresh.closer_id, lost_reason: fresh.lost_reason, historical: history },
    localOnly: history,
  });
  if (history) return fresh;

  // Team pings.
  const rep = rt.reps.find((r) => r.id === fresh.closer_id) ?? null;
  const name = leadName(fresh);
  if (status === 'won') {
    const days = Math.max(0, Math.round((now - fresh.created_at) / 86_400_000));
    rt.waitUntil(notify(rt, {
      kind: 'won',
      title: `🎉 Deal closed — ${name}`,
      lines: [`${rep ? rep.name : 'Unassigned'} closed ${money(fresh.revenue)}${fresh.cash_collected ? ` (${money(fresh.cash_collected)} collected)` : ''}.`],
      fields: [
        { name: 'Source', value: [fresh.channel ?? 'Direct', fresh.utm_campaign, fresh.utm_content].filter(Boolean).join(' / ') },
        { name: 'Lead to close', value: `${days} day${days === 1 ? '' : 's'}` },
        { name: 'Tier', value: String(fresh.tier_override ?? fresh.tier ?? '–') },
      ],
      lead: fresh,
      rep,
    }));
  } else if (status === 'lost') {
    rt.waitUntil(notify(rt, { kind: 'lost', title: `Lost — ${name}`, lines: [`Reason: ${fresh.lost_reason ?? 'not given'}`, ...leadLines(fresh)], lead: fresh, rep }));
  } else if (status === 'no_show') {
    rt.waitUntil(notify(rt, { kind: 'no_show', title: `❌ No-show — ${name}`, lines: ['Rebooking emails are going out automatically.', ...leadLines(fresh)], lead: fresh, rep }));
  } else if (status === 'showed') {
    rt.waitUntil(notify(rt, { kind: 'showed', title: `✅ Call held — ${name}`, lines: ['Follow-up emails are scheduled. Log the outcome when they decide.'], lead: fresh, rep }));
  }
  return fresh;
}

/** Cron: ping the assigned rep ~15 minutes before each call (once per call). */
export async function pingUpcomingCalls(rt: Runtime) {
  const now = Date.now();
  const { results } = await rt.env.DB.prepare(
    `SELECT * FROM leads WHERE call_at BETWEEN ? AND ? AND booked_at IS NOT NULL AND booking_cancelled_at IS NULL AND status = 'booked'`,
  )
    .bind(now + 5 * 60_000, now + 20 * 60_000)
    .all<Lead>();
  for (const lead of results) {
    const key = `ping:call:${lead.id}:${lead.call_at}`;
    const claim = await rt.env.DB.prepare('INSERT OR IGNORE INTO kv_state (key, value) VALUES (?, ?)').bind(key, String(now)).run();
    if (!claim.meta.changes) continue;
    const rep = rt.reps.find((r) => r.id === lead.closer_id) ?? null;
    const vsl = await rt.env.DB.prepare(`SELECT MAX(max_position / NULLIF(duration, 0)) AS pct FROM vsl_views WHERE lead_id = ?`).bind(lead.id).first<{ pct: number | null }>();
    await notify(rt, {
      kind: 'call_soon',
      title: `⏰ Call in 15 min — ${leadName(lead)}`,
      lines: [
        `${formatCallTime(lead.call_at!, rt.settings.SALES_TIMEZONE || 'Australia/Sydney')}${rep ? ` · with ${rep.name}` : ''}`,
        ...leadLines(lead),
        `Watched ${vsl?.pct ? Math.round(Math.min(1, vsl.pct) * 100) : 0}% of the VSL`,
      ],
      lead,
      rep,
    });
  }
  return results.length;
}

/** Payments ledger → cash collected (refunds are negative amounts). */
export async function recordPayment(rt: Runtime, lead: Lead, p: { amount: unknown; paid_at?: unknown; method?: unknown; note?: unknown }) {
  const amount = Number(p.amount);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 10_000_000) throw new Error('Enter an amount (negative for a refund).');
  const paidAt = date(p.paid_at) ?? Date.now();
  const { newId } = await import('../lib/ids');
  await rt.env.DB.prepare('INSERT INTO payments (id, lead_id, amount, paid_at, method, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId('pay'), lead.id, amount, paidAt, text(p.method, 30) ?? null, text(p.note, 200) ?? null, Date.now()).run();
  return syncCash(rt, lead.id);
}

export async function deletePayment(rt: Runtime, leadId: string, paymentId: string) {
  await rt.env.DB.prepare('DELETE FROM payments WHERE id = ? AND lead_id = ?').bind(paymentId, leadId).run();
  return syncCash(rt, leadId);
}

async function syncCash(rt: Runtime, leadId: string) {
  const row = await rt.env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS cash, COALESCE(-SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS refunds, MAX(CASE WHEN amount < 0 THEN paid_at END) AS refunded_at FROM payments WHERE lead_id = ?')
    .bind(leadId).first<{ cash: number; refunds: number; refunded_at: number | null }>();
  await updateLead(rt.env, leadId, { cash_collected: Math.max(0, row?.cash ?? 0), refund_amount: row?.refunds ?? 0, refunded_at: row?.refunded_at ?? null });
  return (await getLead(rt.env, leadId))!;
}

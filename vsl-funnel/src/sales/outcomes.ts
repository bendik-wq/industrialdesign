import type { Runtime } from '../app';
import { LEAD_STATUSES, type Lead, type LeadStatus, getLead, updateLead } from '../funnel/leads';
import { cancelSequence, enqueueSequence, formatCallTime } from '../integrations/email';
import { leadLines, leadName, money, notify } from '../integrations/notify';
import type { SequenceId } from '../integrations/sequences';
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
}

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
  const repIds = new Set(rt.reps.map((r) => r.id));
  if (body.closer_id !== undefined) fields.closer_id = body.closer_id && repIds.has(body.closer_id) ? body.closer_id : null;
  if (body.setter_id !== undefined) fields.setter_id = body.setter_id && repIds.has(body.setter_id) ? body.setter_id : null;

  const changed = status && status !== lead.status;
  const now = Date.now();
  if (changed && ['showed', 'won', 'lost'].includes(status) && !lead.showed_at) fields.showed_at = now;
  if (changed && (status === 'won' || status === 'lost')) fields.closed_at = now;
  if (changed && status !== 'won' && status !== 'lost' && lead.closed_at) fields.closed_at = null;
  await updateLead(rt.env, lead.id, fields);
  const fresh = (await getLead(rt.env, lead.id))!;
  if (!changed) return fresh;

  // Follow-up sequences.
  if (status === 'no_show') {
    await cancelSequence(rt, lead.id, 'booked');
    await enqueueSequence(rt, fresh, 'no_show');
  } else if (status === 'showed') {
    await Promise.all([cancelSequence(rt, lead.id, 'booked'), cancelSequence(rt, lead.id, 'no_show')]);
    await enqueueSequence(rt, fresh, 'post_call');
  } else if (status === 'won' || status === 'lost' || status === 'disqualified') {
    await Promise.all((['booked', 'no_show', 'post_call', 'tier_a', 'tier_b'] as SequenceId[]).map((sq) => cancelSequence(rt, lead.id, sq)));
  }

  await track(rt, await identityFromLead(rt.env, lead.id), {
    name: 'lead_status_changed',
    source: 'admin',
    props: { from: lead.status, to: status, revenue: fresh.revenue, cash_collected: fresh.cash_collected, closer: fresh.closer_id, lost_reason: fresh.lost_reason },
  });

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

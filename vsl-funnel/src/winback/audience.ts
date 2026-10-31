import type { Runtime } from '../app';
import { buildDossier, industryName } from '../followup/dossier';
import type { Lead } from '../funnel/leads';

/**
 * Win-back audience: who a campaign would email, and exactly why everyone else is left out.
 *
 * Segments (a lead matches the first selected one it fits):
 *  - lost:               marked lost after a call
 *  - no_show:            missed their call
 *  - cancelled:          cancelled their call and never rebooked
 *  - applied:            finished the application and never booked
 *  - registered:         registered for the masterclass, a live webinar or the challenge and never bought anything
 *  - ticket_no_sprint:   bought a ticket (masterclass, live or challenge) and never bought the Sprint or a deposit
 *
 * Always left out: anyone who bought the Sprint, a deposit or an engagement, clients, won or disqualified leads,
 * unsubscribed or bounced / complained addresses, anyone emailed by reactivation or win-back in the last N days,
 * anyone already in another live win-back campaign, and anyone already registered for the chosen destination.
 */

export const SEGMENTS = {
  lost: { label: 'Lost', hint: 'Marked lost after a call.' },
  no_show: { label: 'No-show', hint: 'Missed their call and never rebooked.' },
  cancelled: { label: 'Cancelled', hint: 'Cancelled their call and never rebooked.' },
  applied: { label: 'Applied, never booked', hint: 'Finished the application and never picked a call time.' },
  registered: { label: 'Registered, never bought', hint: 'Registered for the masterclass, a live webinar or the challenge and never bought anything.' },
  ticket_no_sprint: { label: 'Ticket, no Sprint', hint: 'Bought a ticket and never bought the First Deal Sprint or a deposit.' },
} as const;
export type Segment = keyof typeof SEGMENTS;
export const SEGMENT_ORDER: Segment[] = ['ticket_no_sprint', 'lost', 'no_show', 'cancelled', 'applied', 'registered'];

export const TIERS = ['A', 'B', 'C', 'none'] as const;
/** Revenue bands, from the application answer (or the Calendly band mapped onto it). */
export const BANDS = {
  under_1m: 'Under $1M',
  '1_3m': '$1M to $3M',
  '3_10m': '$3M to $10M',
  '10m_plus': '$10M and up',
  unknown: 'Not known',
} as const;
export type Band = keyof typeof BANDS;
const bandOf = (revenueKey: string | null): Band =>
  !revenueKey ? 'unknown' : revenueKey === 'lt1m' ? 'under_1m' : revenueKey === '1_3m' ? '1_3m' : revenueKey === '3_10m' ? '3_10m' : /^(10_25m|25_50m|50_100m|gt100m|gt10m)$/.test(revenueKey) ? '10m_plus' : 'unknown';

export type Destination = 'masterclass' | 'live' | 'challenge';
export const DESTINATIONS: Destination[] = ['masterclass', 'live', 'challenge'];

export interface Rules { segments: Segment[]; minDays: number; maxDays: number | null; tiers: string[]; bands: Band[]; recentDays: number }
export const DEFAULT_RULES: Rules = { segments: ['lost', 'no_show', 'cancelled', 'applied'], minDays: 60, maxDays: null, tiers: [], bands: [], recentDays: 30 };

const int = (v: unknown, d: number, lo: number, hi: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
export function cleanRules(raw: unknown): Rules {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = <T extends string>(v: unknown, ok: readonly T[]) => (Array.isArray(v) ? [...new Set(v.filter((x): x is T => typeof x === 'string' && (ok as readonly string[]).includes(x)))] : []);
  const segments = Array.isArray(r.segments) ? list(r.segments, Object.keys(SEGMENTS) as Segment[]) : DEFAULT_RULES.segments;
  const maxDays = r.maxDays == null || r.maxDays === '' ? null : int(r.maxDays, 0, 1, 3650);
  return {
    segments,
    minDays: int(r.minDays, DEFAULT_RULES.minDays, 0, 3650),
    maxDays,
    tiers: list(r.tiers, TIERS),
    bands: list(r.bands, Object.keys(BANDS) as Band[]),
    recentDays: int(r.recentDays, DEFAULT_RULES.recentDays, 0, 365),
  };
}

export interface AudienceRow {
  id: string; name: string; email: string; status: string; segment: Segment; tier: string | null; band: Band;
  last_active_at: number; days_quiet: number;
  /** What the emails are written from (plain words; never raw HTML). */
  industry: string | null; revenue: string | null; goal: string | null; blockers: number; why_now: boolean; data: 'full' | 'some' | 'none';
}
export interface Excluded { reason: string; n: number; sample: string[] }

const DAY = 86_400_000;
const nameOf = (r: { first_name: string | null; last_name: string | null; email: string }) => [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email;

/** Columns read per lead (not l.*: the leads table is at D1's column limit). */
const SQL = `
SELECT l.id, l.first_name, l.last_name, l.email, l.status, COALESCE(l.tier_override, l.tier) AS tier, l.revenue_band, l.answers, l.industry, l.booking_answers, l.objection, l.lost_reason,
       l.created_at, l.updated_at, l.app_completed_at, l.booked_at, l.call_at, l.booking_cancelled_at, l.showed_at, l.webinar_registered_at, l.webinar_attended_at,
       l.unsubscribed_at, l.cash_collected, l.contract_signed_at, l.closed_at,
       (SELECT MAX(e.ts) FROM events e WHERE e.lead_id = l.id AND e.source NOT IN ('cron', 'admin') AND e.name NOT IN ('email_sent', 'sms_sent', 'whatsapp_sent', 'email_open')) AS last_event,
       (SELECT MAX(m.clicked_at) FROM emails m WHERE m.lead_id = l.id) AS last_click,
       (SELECT MAX(m.sent_at) FROM emails m WHERE m.lead_id = l.id AND (m.sequence LIKE 'reactivation%' OR m.sequence = 'winback') AND m.status IN ('sent', 'simulated')) AS last_react_email,
       (SELECT r.reactivated_at FROM lead_reactivation r WHERE r.lead_id = l.id) AS reactivated_at,
       EXISTS (SELECT 1 FROM webinar_passes p WHERE p.lead_id = l.id AND p.kind IN ('offer', 'deposit') AND p.status IN ('paid', 'refunded')) AS bought,
       EXISTS (SELECT 1 FROM contracts k WHERE k.lead_id = l.id AND k.signed_at IS NOT NULL AND COALESCE(k.is_test, 0) = 0) AS signed,
       EXISTS (SELECT 1 FROM webinar_passes p WHERE p.lead_id = l.id AND p.kind IN ('seat', 'live_ticket') AND p.status = 'paid') AS ticket_pass,
       EXISTS (SELECT 1 FROM webinar_passes p WHERE p.lead_id = l.id AND p.kind = 'seat' AND p.status = 'paid') AS masterclass_ticket,
       EXISTS (SELECT 1 FROM challenge_registrations c WHERE c.lead_id = l.id AND c.status = 'paid') AS ticket_challenge,
       EXISTS (SELECT 1 FROM cs_clients s WHERE s.lead_id = l.id) AS client,
       (SELECT reason FROM email_suppressions x WHERE x.email = LOWER(l.email)) AS suppressed,
       (EXISTS (SELECT 1 FROM webinar_registrations w WHERE w.lead_id = l.id) OR EXISTS (SELECT 1 FROM live_webinar_regs g WHERE g.lead_id = l.id) OR EXISTS (SELECT 1 FROM challenge_registrations c WHERE c.lead_id = l.id)) AS registered_any,
       (SELECT MAX(t) FROM (SELECT MAX(created_at) AS t FROM webinar_registrations WHERE lead_id = l.id UNION ALL SELECT MAX(created_at) FROM live_webinar_regs WHERE lead_id = l.id UNION ALL SELECT MAX(created_at) FROM challenge_registrations WHERE lead_id = l.id)) AS last_reg,
       (SELECT e.campaign_id FROM winback_enrollments e JOIN winback_campaigns c ON c.id = e.campaign_id WHERE e.lead_id = l.id AND e.status = 'active' AND c.status IN ('running', 'paused') AND e.campaign_id <> :self LIMIT 1) AS other_campaign,
       :dest AS dest_registered
  FROM leads l
 WHERE l.email IS NOT NULL AND l.email LIKE '%@%' :where
 ORDER BY l.created_at DESC
 LIMIT 10000`;

/** The destination check, as a SQL expression on l.id (already registered for it, or already holds its ticket). */
function destSql(dest: Destination, ref: string | null) {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  if (dest === 'live') return ref ? `EXISTS (SELECT 1 FROM live_webinar_regs g WHERE g.lead_id = l.id AND g.event_id = ${q(ref)})` : '0';
  if (dest === 'challenge') return ref ? `EXISTS (SELECT 1 FROM challenge_registrations c WHERE c.lead_id = l.id AND c.cohort_id = ${q(ref)} AND c.status IN ('pending', 'paid'))` : '0';
  return `EXISTS (SELECT 1 FROM webinar_passes p WHERE p.lead_id = l.id AND p.kind = 'seat' AND p.status = 'paid')`;
}

const audienceSql = (dest: Destination, ref: string | null, self: string | null, where: string) =>
  SQL.replace(':dest', destSql(dest, ref)).replace(':self', `'${String(self ?? '').replace(/'/g, "''")}'`).replace(':where', where);

/** One lead's row, as the audience reads it (re-checked at the moment of sending). */
export async function leadRow(rt: Runtime, leadId: string, dest: Destination, ref: string | null, self: string) {
  return rt.env.DB.prepare(audienceSql(dest, ref, self, 'AND l.id = ?')).bind(leadId).first<Row>();
}

export type Row = Record<string, unknown> & { id: string; first_name: string | null; last_name: string | null; email: string; status: string; tier: string | null };

/** Which segment a lead fits (first of `allowed`, in SEGMENT_ORDER), or null. */
export function segmentOf(r: Row, allowed: Segment[]): Segment | null {
  const n = (k: string) => Number(r[k] ?? 0);
  const ticket = Boolean(n('ticket_pass') || n('ticket_challenge'));
  const bought = Boolean(n('bought'));
  const fits: Record<Segment, boolean> = {
    ticket_no_sprint: ticket && !bought,
    lost: r.status === 'lost',
    no_show: r.status === 'no_show',
    cancelled: Boolean(r.booking_cancelled_at) && !['won', 'lost'].includes(r.status) && !(n('booked_at') > n('booking_cancelled_at')),
    applied: Boolean(r.app_completed_at) && !r.booked_at,
    registered: Boolean(n('registered_any')) && !ticket && !bought,
  };
  return SEGMENT_ORDER.find((s) => allowed.includes(s) && fits[s]) ?? null;
}

/** Their last real activity: application, booking, call, registration, a page visit or a click (never our own sends). */
export const lastActive = (r: Record<string, unknown>) =>
  Math.max(...['created_at', 'app_completed_at', 'booked_at', 'booking_cancelled_at', 'showed_at', 'webinar_registered_at', 'webinar_attended_at', 'last_event', 'last_click', 'last_reg', 'closed_at']
    .map((k) => Number(r[k] ?? 0)).filter((x) => Number.isFinite(x)), 0);

/** Why a lead is left out regardless of segment (null = may receive it). */
export function exclusion(r: Record<string, unknown>, rules: Pick<Rules, 'recentDays'>, now: number): string | null {
  const n = (k: string) => Number(r[k] ?? 0);
  if (r.status === 'won') return 'Client (won)';
  if (r.status === 'disqualified') return 'Ruled out (disqualified)';
  if (n('bought') || n('signed') || n('contract_signed_at') || n('cash_collected') > 0) return 'Bought (Sprint, deposit or engagement)';
  if (n('client')) return 'Client';
  if (r.unsubscribed_at) return 'Unsubscribed';
  if (r.suppressed) return r.suppressed === 'complained' ? 'Marked as spam' : r.suppressed === 'bounced' ? 'Bounced' : 'Blocked address';
  // A reactivation scheduled to start later (reactivated_at in the future) counts as recent too.
  const recent = Math.max(n('last_react_email'), n('reactivated_at'));
  if (rules.recentDays > 0 && recent && recent > now - rules.recentDays * DAY) return `Reactivation or win-back email in the last ${rules.recentDays} days`;
  if (r.other_campaign) return 'In another win-back campaign';
  if (n('dest_registered')) return 'Already registered for this destination';
  return null;
}

function enrich(r: Row, segment: Segment, last: number, now: number): AudienceRow {
  const d = buildDossier(r as unknown as Lead);
  const facts = [d.business, d.revenue, d.goal, d.timeline, d.blockers.length ? 1 : null, d.whyNow].filter(Boolean).length;
  return {
    id: r.id, name: nameOf(r), email: r.email, status: r.status, segment, tier: r.tier ?? null, band: bandOf(d.revenue),
    last_active_at: last, days_quiet: Math.floor((now - last) / DAY),
    industry: d.industry ? industryName(d.industry) : null, revenue: d.revenueLabel, goal: d.goal, blockers: d.blockers.length, why_now: Boolean(d.whyNow),
    data: facts >= 3 ? 'full' : facts ? 'some' : 'none',
  };
}

/**
 * Everyone the rules select right now, and the people left out with the reason (counts plus a few names).
 * `self` is the campaign being built (its own enrolments don't count as "another campaign").
 */
export async function buildAudience(rt: Runtime, o: { rules: Rules; destination: Destination; destRef: string | null; self?: string | null; now?: number }) {
  const now = o.now ?? Date.now();
  const rules = o.rules;
  const { results } = await rt.env.DB.prepare(audienceSql(o.destination, o.destRef, o.self ?? null, '')).all<Row>();
  const rows: AudienceRow[] = [];
  const excluded = new Map<string, Excluded>();
  const segmentCounts: Record<string, number> = {};
  const out = (reason: string, r: Row) => {
    const e = excluded.get(reason) ?? { reason, n: 0, sample: [] };
    e.n++;
    if (e.sample.length < 5) e.sample.push(nameOf(r));
    excluded.set(reason, e);
  };
  for (const r of results) {
    const seg = segmentOf(r, rules.segments);
    if (!seg) continue;
    const last = lastActive(r);
    const days = (now - last) / DAY;
    if (days < rules.minDays) { out(`Active in the last ${rules.minDays} days`, r); continue; }
    if (rules.maxDays && days > rules.maxDays) { out(`Quiet for more than ${rules.maxDays} days`, r); continue; }
    const why = exclusion(r, rules, now);
    if (why) { out(why, r); continue; }
    const tier = r.tier && ['A', 'B', 'C'].includes(r.tier) ? r.tier : 'none';
    if (rules.tiers.length && !rules.tiers.includes(tier)) { out('Tier not selected', r); continue; }
    const row = enrich(r, seg, last, now);
    if (rules.bands.length && !rules.bands.includes(row.band)) { out('Revenue band not selected', r); continue; }
    segmentCounts[seg] = (segmentCounts[seg] ?? 0) + 1;
    rows.push(row);
  }
  rows.sort((a, b) => a.days_quiet - b.days_quiet);
  return { count: rows.length, rows, excluded: [...excluded.values()].sort((a, b) => b.n - a.n), segmentCounts };
}

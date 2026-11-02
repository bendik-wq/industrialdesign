import type { Runtime } from '../app';
import { sha256 } from '../lib/crypto';
import { normalise } from '../tracking/match';
import type { Segment } from './catalog';
import { cohortSlot, type Funnel, sessionSlot } from './enrich';

/**
 * Customer-list audiences: who is in each segment, from our own tables, and the hashed rows Meta receives.
 *
 * Only people we may use for marketing are ever included (the same rule as src/tracking/forward.ts: a lead's events
 * go to Meta unless their latest visit was from the EU without consent), never anyone unsubscribed, on the
 * suppression list (bounced, complained, added by hand), a test or preview lead, or on META_AUDIENCE_EXCLUDE.
 * Every daily sync replaces the whole list, so deleted or newly excluded people leave the audience too.
 */

export interface Member { id: string; email: string | null; phone: string | null; first_name: string | null; last_name: string | null; country: string | null; value?: number }

type DB = Runtime['env']['DB'];
const ids = async (db: DB, sql: string, ...binds: unknown[]) => new Set((await db.prepare(sql).bind(...binds).all<{ lead_id: string }>().catch(() => ({ results: [] as { lead_id: string }[] }))).results.map((r) => r.lead_id));

const BUYER_SQL: Record<string, string> = {
  masterclass_ticket: "SELECT lead_id FROM webinar_passes WHERE kind = 'seat' AND status = 'paid'",
  live_ticket: "SELECT lead_id FROM webinar_passes WHERE kind = 'live_ticket' AND status = 'paid'",
  first_deal_sprint: "SELECT lead_id FROM webinar_passes WHERE kind = 'offer' AND status = 'paid'",
  engagement_deposit: "SELECT lead_id FROM webinar_passes WHERE kind = 'deposit' AND status = 'paid'",
  challenge_ticket: "SELECT lead_id FROM challenge_orders WHERE kind = 'ticket' AND status = 'paid' AND amount > 0",
  challenge_vip: "SELECT lead_id FROM challenge_orders WHERE kind = 'vip' AND status = 'paid'",
  advisory_engagement: "SELECT id AS lead_id FROM leads WHERE status = 'won' UNION SELECT lead_id FROM contracts WHERE signed_at IS NOT NULL AND COALESCE(is_test, 0) = 0 AND voided_at IS NULL AND lead_id IS NOT NULL",
};
const ALL_BUYERS_SQL = Object.values(BUYER_SQL).join(' UNION ');
const CLIENTS_SQL = `SELECT lead_id FROM cs_clients UNION ${BUYER_SQL.first_deal_sprint} UNION ${BUYER_SQL.engagement_deposit} UNION ${BUYER_SQL.advisory_engagement}`;
const REG_SQL: Record<string, string> = {
  auto: 'SELECT lead_id FROM webinar_registrations',
  live: 'SELECT lead_id FROM live_webinar_regs',
  challenge: 'SELECT lead_id FROM challenge_registrations',
};
const stage = (stage: string, funnel?: string) => `SELECT lead_id FROM attr_stages WHERE stage = '${stage}'${funnel ? ` AND funnel = '${funnel}'` : ''}`;

/** Lead ids in a segment (before the marketing exclusions), plus a value per lead for the value-based list. */
export async function segmentIds(rt: Pick<Runtime, 'env' | 'settings'>, seg: Segment): Promise<{ ids: Set<string>; values?: Map<string, number> }> {
  const db = rt.env.DB;
  switch (seg.type) {
    case 'registered': {
      if (!seg.slot) return { ids: await ids(db, REG_SQL[seg.funnel] ?? 'SELECT NULL AS lead_id WHERE 0') };
      return { ids: await slotIds(rt, seg.funnel, seg.slot) };
    }
    case 'attended': {
      const raw = seg.funnel === 'auto' ? ' UNION SELECT lead_id FROM webinar_registrations WHERE joined_at IS NOT NULL'
        : seg.funnel === 'live' ? ' UNION SELECT lead_id FROM live_webinar_regs WHERE joined_at IS NOT NULL' : '';
      return { ids: await ids(db, stage('attended', seg.funnel) + raw) };
    }
    case 'watched_50': return { ids: await ids(db, `${stage('watched_50', seg.funnel)} UNION ${stage('watched_75', seg.funnel)} UNION ${stage('watched_100', seg.funnel)}`) };
    case 'offer_seen_no_purchase': return { ids: await ids(db, `SELECT lead_id FROM (${stage('offer_seen', seg.funnel)}) WHERE lead_id NOT IN (${ALL_BUYERS_SQL})`) };
    case 'checkout_no_purchase': return { ids: await ids(db, `SELECT lead_id FROM (${stage('checkout_started')} UNION ${stage('ticket_checkout_started')}) WHERE lead_id NOT IN (${ALL_BUYERS_SQL})`) };
    case 'buyer': return { ids: await ids(db, BUYER_SQL[seg.product]) };
    case 'booked': return { ids: await ids(db, 'SELECT id AS lead_id FROM leads WHERE booked_at IS NOT NULL AND UPPER(COALESCE(tier_override, tier)) = ?', seg.tier) };
    case 'no_show': return { ids: await ids(db, "SELECT id AS lead_id FROM leads WHERE status = 'no_show'") };
    case 'all_buyers': return { ids: await ids(db, ALL_BUYERS_SQL) };
    case 'clients': return { ids: await ids(db, CLIENTS_SQL) };
    case 'signal': {
      // Deep-funnel signals (src/tracking/signals.ts): everyone recorded for the signal, minus buyers when asked.
      const base = 'SELECT lead_id FROM meta_signals WHERE signal = ?';
      return { ids: await ids(db, seg.noPurchase ? `SELECT lead_id FROM (${base}) WHERE lead_id NOT IN (${ALL_BUYERS_SQL})` : base, seg.signal) };
    }
    case 'buyers_value': {
      const { results } = await db.prepare(
        `SELECT lead_id, SUM(v) AS v FROM (
           SELECT lead_id, (amount - COALESCE(refunded_amount, 0)) / 100.0 AS v FROM webinar_passes WHERE status IN ('paid', 'refunded')
           UNION ALL SELECT lead_id, (amount - COALESCE(refunded_amount, 0)) / 100.0 FROM challenge_orders WHERE status IN ('paid', 'refunded')
           UNION ALL SELECT id, MAX(COALESCE(cash_collected, 0), CASE WHEN status = 'won' THEN COALESCE(revenue, 0) ELSE 0 END) - COALESCE(refund_amount, 0) FROM leads WHERE status = 'won' OR cash_collected > 0
         ) GROUP BY lead_id HAVING SUM(v) > 0`,
      ).all<{ lead_id: string; v: number }>().catch(() => ({ results: [] as { lead_id: string; v: number }[] }));
      return { ids: new Set(results.map((r) => r.lead_id)), values: new Map(results.map((r) => [r.lead_id, Math.round(r.v * 100) / 100])) };
    }
  }
}

/** Registrations whose session falls on this weekday + local hour. */
async function slotIds(rt: Pick<Runtime, 'env' | 'settings'>, funnel: Funnel, slot: string) {
  const out = new Set<string>();
  for (const r of await registrationSlots(rt, funnel)) if (r.slot === slot) out.add(r.lead_id);
  return out;
}

/** Every registration in a funnel with its session slot (newest 20,000). */
async function registrationSlots(rt: Pick<Runtime, 'env' | 'settings'>, funnel: Funnel): Promise<{ lead_id: string; slot: string | null }[]> {
  const db = rt.env.DB;
  const tz = rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
  const safe = <T>(p: Promise<{ results: T[] }>) => p.then((r) => r.results).catch(() => [] as T[]);
  if (funnel === 'auto') return (await safe(db.prepare('SELECT r.lead_id, s.starts_at FROM webinar_registrations r JOIN webinar_sessions s ON s.id = r.session_id ORDER BY r.created_at DESC LIMIT 20000').all<{ lead_id: string; starts_at: number }>())).map((r) => ({ lead_id: r.lead_id, slot: sessionSlot(r.starts_at, tz) }));
  if (funnel === 'live') return (await safe(db.prepare('SELECT r.lead_id, w.starts_at, w.tz FROM live_webinar_regs r JOIN live_webinars w ON w.id = r.event_id ORDER BY r.created_at DESC LIMIT 20000').all<{ lead_id: string; starts_at: number; tz: string }>())).map((r) => ({ lead_id: r.lead_id, slot: sessionSlot(r.starts_at, r.tz) }));
  if (funnel === 'challenge') return (await safe(db.prepare('SELECT r.lead_id, c.start_date, c.start_time FROM challenge_registrations r JOIN challenge_cohorts c ON c.id = r.cohort_id ORDER BY r.created_at DESC LIMIT 20000').all<{ lead_id: string; start_date: string; start_time: string }>())).map((r) => ({ lead_id: r.lead_id, slot: cohortSlot(r.start_date, r.start_time) }));
  return [];
}

/**
 * Session slots worth an audience each: slots of sessions scheduled from 90 days ago onwards, plus slots that
 * already have registrations, most registrations first, at most `max` per funnel.
 */
export async function activeSlots(rt: Pick<Runtime, 'env' | 'settings'>, max = 6): Promise<{ funnel: Funnel; slot: string; n: number }[]> {
  const out: { funnel: Funnel; slot: string; n: number }[] = [];
  const db = rt.env.DB;
  const since = Date.now() - 90 * 86_400_000;
  const tz = rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
  const safe = <T>(p: Promise<{ results: T[] }>) => p.then((r) => r.results).catch(() => [] as T[]);
  for (const funnel of ['auto', 'live', 'challenge'] as Funnel[]) {
    const counts = new Map<string, number>();
    for (const r of await registrationSlots(rt, funnel)) if (r.slot) counts.set(r.slot, (counts.get(r.slot) ?? 0) + 1);
    const scheduled = funnel === 'auto'
      ? (await safe(db.prepare("SELECT starts_at FROM webinar_sessions WHERE starts_at >= ? AND status != 'cancelled' LIMIT 500").bind(since).all<{ starts_at: number }>())).map((s) => sessionSlot(s.starts_at, tz))
      : funnel === 'live'
        ? (await safe(db.prepare('SELECT starts_at, tz FROM live_webinars WHERE starts_at >= ? LIMIT 200').bind(since).all<{ starts_at: number; tz: string }>())).map((s) => sessionSlot(s.starts_at, s.tz))
        : (await safe(db.prepare("SELECT start_date, start_time FROM challenge_cohorts WHERE status != 'cancelled' LIMIT 200").all<{ start_date: string; start_time: string }>())).map((s) => cohortSlot(s.start_date, s.start_time));
    for (const s of scheduled) if (s && !counts.has(s)) counts.set(s, 0);
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).forEach(([slot, n]) => out.push({ funnel, slot, n }));
  }
  return out;
}

// ───────────── marketing eligibility ─────────────

const TEST_EMAIL = /@(example\.(com|org|net)|test\.com)$|\.(test|invalid|example|localhost)$|^test[+@]|\+test@/i;
export const isTestEmail = (email: string | null | undefined) => Boolean(email && TEST_EMAIL.test(email.trim()));

/** Owner's own exclusions: emails, phone numbers or @domains (META_AUDIENCE_EXCLUDE, comma or line separated). */
export function excludeList(raw: string | undefined) {
  const items = String(raw ?? '').split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return (m: { email: string | null; phone: string | null }) => {
    const e = (m.email ?? '').trim().toLowerCase();
    const p = (m.phone ?? '').replace(/\D/g, '');
    return items.some((x) => (x.startsWith('@') ? e.endsWith(x) : x.includes('@') ? e === x : p && x.replace(/\D/g, '') === p));
  };
}

export interface Eligible extends Member { excluded: null | 'no_contact' | 'unsubscribed' | 'suppressed' | 'no_consent' | 'test' | 'owner_excluded' }

/** The lead rows for these ids, each marked with why it is left out (null = may be uploaded). */
export async function eligibility(rt: Pick<Runtime, 'env' | 'settings'>, leadIds: Iterable<string>): Promise<Eligible[]> {
  const list = [...new Set(leadIds)].filter(Boolean);
  const out: Eligible[] = [];
  const owner = excludeList((rt.settings as Partial<Record<string, string>>).META_AUDIENCE_EXCLUDE);
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    const { results } = await rt.env.DB.prepare(
      `SELECT l.id, l.email, l.phone, l.first_name, l.last_name, l.country, l.ref_code, l.unsubscribed_at,
              (SELECT 1 FROM email_suppressions x WHERE x.email = LOWER(TRIM(l.email))) AS suppressed,
              (SELECT s.is_eu FROM sessions s WHERE s.visitor_id = l.visitor_id ORDER BY s.last_seen_at DESC LIMIT 1) AS is_eu
         FROM leads l WHERE l.id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all<{ id: string; email: string | null; phone: string | null; first_name: string | null; last_name: string | null; country: string | null; ref_code: string | null; unsubscribed_at: number | null; suppressed: number | null; is_eu: number | null }>();
    for (const r of results) {
      const excluded: Eligible['excluded'] = !r.email && !r.phone ? 'no_contact'
        : r.unsubscribed_at ? 'unsubscribed'
          : r.suppressed ? 'suppressed'
            : r.is_eu ? 'no_consent'
              : isTestEmail(r.email) || /^(PREVIEW|SAMPLE|TEST)/i.test(r.ref_code ?? '') ? 'test'
                : owner(r) ? 'owner_excluded' : null;
      out.push({ id: r.id, email: r.email, phone: r.phone, first_name: r.first_name, last_name: r.last_name, country: r.country, excluded });
    }
  }
  return out;
}

export const EXCLUDED_LABEL: Record<NonNullable<Eligible['excluded']>, string> = {
  no_contact: 'No email or phone', unsubscribed: 'Unsubscribed', suppressed: 'Bounced, complained or suppressed', no_consent: 'No marketing consent (EU visit without consent)', test: 'Test or preview lead', owner_excluded: 'On your exclusion list',
};

/** Segment members who may be uploaded, plus counts of who was left out and why. */
export async function segmentMembers(rt: Pick<Runtime, 'env' | 'settings'>, seg: Segment) {
  const { ids: set, values } = await segmentIds(rt, seg);
  const rows = await eligibility(rt, set);
  const members: Member[] = [];
  const excluded: Record<string, number> = {};
  for (const r of rows) {
    if (r.excluded) { excluded[r.excluded] = (excluded[r.excluded] ?? 0) + 1; continue; }
    members.push({ id: r.id, email: r.email, phone: r.phone, first_name: r.first_name, last_name: r.last_name, country: r.country, ...(values ? { value: values.get(r.id) ?? 0 } : {}) });
  }
  return { members, excluded, total: set.size };
}

// ───────────── hashing (Meta customer-file normalisation) ─────────────

export const LIST_SCHEMA = ['EMAIL', 'PHONE', 'FN', 'LN', 'COUNTRY'] as const;
export const VALUE_SCHEMA = [...LIST_SCHEMA, 'LOOKALIKE_VALUE'] as const;

/**
 * Meta's customer-file rules: EMAIL trimmed + lowercase; PHONE digits only, no leading zeros, with country code
 * (we store E.164); FN/LN lowercase letters only; COUNTRY lowercase ISO alpha-2. SHA-256, lowercase hex.
 * Missing values are sent as empty strings. LOOKALIKE_VALUE is a plain number, not hashed.
 */
export const normaliseRow = (m: Member) => ({
  EMAIL: m.email ? normalise.em(m.email) : '',
  PHONE: m.phone ? normalise.ph(m.phone).replace(/^0+/, '') : '',
  FN: m.first_name ? normalise.fn(m.first_name) : '',
  LN: m.last_name ? normalise.ln(m.last_name) : '',
  COUNTRY: m.country && /^[a-z]{2}$/i.test(m.country.trim()) ? normalise.country(m.country) : '',
});

export async function hashRow(m: Member, valueBased = false): Promise<(string | number)[]> {
  const n = normaliseRow(m);
  const hashed = await Promise.all(LIST_SCHEMA.map((k) => (n[k] ? sha256(n[k]) : Promise.resolve(''))));
  return valueBased ? [...hashed, Math.max(0, Math.round((m.value ?? 0) * 100) / 100)] : hashed;
}

/** Fingerprint of a member set (order-independent), so an unchanged list isn't uploaded again. */
export async function membersHash(rows: (string | number)[][]) {
  return sha256(rows.map((r) => r.join('|')).sort().join('\n'));
}

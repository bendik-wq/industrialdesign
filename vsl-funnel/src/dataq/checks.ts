import type { Runtime } from '../app';
import { validTimeZone } from '../challenge/schedule';
import { paidSaleOn } from '../lib/paid-sales';

/**
 * Data-quality checks (Funnel HQ → Ad tracking → Data quality, and a daily item in Command).
 * Every check is a real count over our own tables with up to ten example ids, so a number can always be traced
 * to the rows behind it. A check that cannot be measured (Meta not connected, a table a fresh install lacks)
 * returns n = null with a note, never a guess.
 *
 * Flow checks look at the last 7 days ending at the run; state checks (queue, duplicates) look at the table now.
 */
export const DQ_WINDOW_MS = 7 * 86_400_000;
const HOUR = 3_600_000;

export const CHECK_KEYS = [
  'leads_no_attribution', 'regs_no_lead', 'payments_no_attribution', 'payments_no_capi', 'capi_match_keys',
  'forward_failures', 'email_bounces', 'rooms_no_minutes', 'ai_calls_stuck', 'duplicate_leads', 'contact_format',
] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

/** What an example id points at: a lead opens the lead drawer; anything else is shown as text. */
export type ExampleKind = 'lead' | 'registration' | 'event' | 'room';

export interface CheckDef {
  key: CheckKey;
  label: string;
  what: string;
  scope: '7d' | 'now';
  examples: ExampleKind;
  fix: { label: string; href: string };
}

export const CHECKS: Record<CheckKey, CheckDef> = {
  leads_no_attribution: { key: 'leads_no_attribution', label: 'Leads with no source', scope: '7d', examples: 'lead', fix: { label: 'Links & videos', href: '/admin#links' },
    what: 'New leads with no channel, UTM source, click id or first-touch source on the lead or its visitor.' },
  regs_no_lead: { key: 'regs_no_lead', label: 'Registrations without a lead', scope: '7d', examples: 'registration', fix: { label: 'Webinar', href: '/admin#webinar' },
    what: 'Masterclass, live webinar and challenge registrations whose lead row is missing.' },
  payments_no_attribution: { key: 'payments_no_attribution', label: 'Payments without attribution', scope: '7d', examples: 'lead', fix: { label: 'Webinar attribution', href: '/admin#wattrib' },
    what: 'Paid tickets, Sprints, deposits and challenge orders with no attribution row, or one with no first or last touch.' },
  payments_no_capi: { key: 'payments_no_capi', label: 'Payments not sent to Meta', scope: '7d', examples: 'lead', fix: { label: 'Ad tracking', href: '/admin#tracking' },
    what: 'Paid tickets, Sprints, deposits and challenge orders with no Purchase event delivered to the Meta Conversions API.' },
  capi_match_keys: { key: 'capi_match_keys', label: 'Meta events without email or phone', scope: '7d', examples: 'event', fix: { label: 'Ad tracking', href: '/admin#tracking' },
    what: 'Events delivered to Meta that carried neither a hashed email nor a phone. Coverage of em, ph, fbp, fbc and external_id per event is in the detail.' },
  forward_failures: { key: 'forward_failures', label: 'Failed sends to Meta and GA4', scope: '7d', examples: 'event', fix: { label: 'Ad tracking', href: '/admin#tracking' },
    what: 'Server-side events that gave up after every retry. Events still retrying are listed in the detail.' },
  email_bounces: { key: 'email_bounces', label: 'Email bounces and complaints', scope: '7d', examples: 'lead', fix: { label: 'Emails', href: '/admin#emails' },
    what: 'Addresses added to the suppression list (hard bounce or spam complaint) against emails sent. Flagged above a 2% bounce rate or on any complaint.' },
  rooms_no_minutes: { key: 'rooms_no_minutes', label: 'Rooms with attendance but no minute curve', scope: '7d', examples: 'room', fix: { label: 'Rooms', href: '/admin#rooms' },
    what: 'Webinar rooms that went live with attendees and recorded no per-minute attendance.' },
  ai_calls_stuck: { key: 'ai_calls_stuck', label: 'AI calls stuck in the queue', scope: 'now', examples: 'lead', fix: { label: 'AI calls', href: '/admin#voice' },
    what: 'Queued calls more than an hour past their time, or calls marked as dialling for more than an hour.' },
  duplicate_leads: { key: 'duplicate_leads', label: 'Duplicate leads by email', scope: 'now', examples: 'lead', fix: { label: 'Leads', href: '/admin#leads' },
    what: 'Leads whose email matches another lead once case, spaces, plus-tags and Gmail dots are ignored.' },
  contact_format: { key: 'contact_format', label: 'Phone or time zone in the wrong format', scope: '7d', examples: 'lead', fix: { label: 'Leads', href: '/admin#leads' },
    what: 'New leads whose phone is not in international format (+61...) or whose time zone is not a valid zone name.' },
};

export interface CheckResult {
  key: CheckKey;
  n: number | null;
  total: number | null;
  examples: string[];
  detail?: Record<string, unknown>;
  note?: string;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const ids = (rows: Row[], col = 'id') => rows.map((r) => String(r[col] ?? '')).filter(Boolean).slice(0, 10);

/** Is this check a problem today? Most are "any row"; email uses rates. */
export function isWarn(r: Pick<CheckResult, 'key' | 'n' | 'total' | 'detail'>): boolean {
  if (r.n == null) return false;
  if (r.key === 'email_bounces') {
    const complained = num((r.detail ?? {}).complained);
    return complained > 0 || (num(r.total) > 0 && num((r.detail ?? {}).bounced) / num(r.total) > 0.02);
  }
  return r.n > 0;
}

/** Email as one person's address: lower case, no spaces, no +tag, and Gmail ignores dots. */
export function normaliseEmail(raw: string | null | undefined): string | null {
  const e = String(raw ?? '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return null;
  let local = e.slice(0, at).split('+')[0];
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local ? `${local}@${domain}` : null;
}
export const validPhone = (p: string) => /^\+[1-9]\d{7,14}$/.test(p);

const META_KEYS = ['em', 'ph', 'fbp', 'fbc', 'external_id'] as const;
const PURCHASE_EVENTS = ['webinar_seat_purchased', 'webinar_offer_purchased', 'engagement_deposit_purchased', 'live_ticket_purchased', 'challenge_ticket_paid', 'challenge_vip_paid'];
const PAY_LABEL: Record<string, string> = { seat: 'Masterclass ticket', offer: 'First Deal Sprint', deposit: 'Engagement deposit', live_ticket: 'Live webinar ticket', ticket: 'Challenge ticket', vip: 'Challenge VIP' };

export function metaConfigured(rt: Pick<Runtime, 'settings'>) {
  const s = rt.settings as Partial<Record<string, string>>;
  return Boolean(s.META_PIXEL_ID && s.META_ACCESS_TOKEN);
}

/** Runs every check. One failing query makes that check "not measured"; the others still run. */
export async function runChecks(rt: Runtime, now = Date.now()): Promise<CheckResult[]> {
  const db = rt.env.DB;
  const from = now - DQ_WINDOW_MS, to = now;
  const all = async (sql: string, args: unknown[] = []) => (await db.prepare(sql).bind(...args).all<Row>()).results;
  const first = async (sql: string, args: unknown[] = []) => (await db.prepare(sql).bind(...args).first<Row>()) ?? {};
  const guard = async (key: CheckKey, fn: () => Promise<Omit<CheckResult, 'key'>>): Promise<CheckResult> => {
    try { return { key, ...(await fn()) }; } catch (e) { console.error('dataq check', key, e); return { key, n: null, total: null, examples: [], note: 'Could not be measured (the query failed; the table may not exist yet).' }; }
  };

  // Paid rows in the window, shared by the two payment checks.
  let payRows: Row[] | null = null;
  const payments = async () => payRows ??= await all(
    `SELECT 'pass' AS t, p.id, p.kind, p.lead_id,
            EXISTS (SELECT 1 FROM attr_conversions a WHERE a.ref_id = p.id AND COALESCE(a.lt_channel, a.ft_channel, a.lt_source, a.ft_source) IS NOT NULL) AS attributed,
            EXISTS (SELECT 1 FROM events e JOIN forward_log f ON f.event_id = e.id AND f.dest = 'meta' AND f.status = 'sent'
                     WHERE e.lead_id = p.lead_id AND e.name IN (${PURCHASE_EVENTS.map(() => '?').join(', ')}) AND json_extract(e.props, '$.pass_id') = p.id) AS capi
       FROM webinar_passes p WHERE ${paidSaleOn('p')} AND p.paid_at BETWEEN ? AND ?
     UNION ALL
     SELECT 'order' AS t, o.id, o.kind, o.lead_id,
            EXISTS (SELECT 1 FROM attr_conversions a WHERE a.ref_id = o.id AND COALESCE(a.lt_channel, a.ft_channel, a.lt_source, a.ft_source) IS NOT NULL) AS attributed,
            EXISTS (SELECT 1 FROM events e JOIN forward_log f ON f.event_id = e.id AND f.dest = 'meta' AND f.status = 'sent'
                     WHERE e.lead_id = o.lead_id AND e.name IN ('challenge_ticket_paid', 'challenge_vip_paid') AND json_extract(e.props, '$.order_id') = o.id) AS capi
       FROM challenge_orders o WHERE ${paidSaleOn('o')} AND o.paid_at BETWEEN ? AND ?
     LIMIT 5000`,
    [...PURCHASE_EVENTS, from, to, from, to],
  );
  const payCheck = async (flag: 'attributed' | 'capi') => {
    const rows = await payments();
    const missing = rows.filter((r) => !num(r[flag]));
    const byKind: Record<string, { label: string; paid: number; missing: number }> = {};
    for (const r of rows) {
      const k = String(r.kind);
      const x = (byKind[k] ??= { label: PAY_LABEL[k] ?? k, paid: 0, missing: 0 });
      x.paid++;
      if (!num(r[flag])) x.missing++;
    }
    return { n: missing.length, total: rows.length, examples: ids(missing, 'lead_id'), detail: { byKind } };
  };

  return Promise.all([
    guard('leads_no_attribution', async () => {
      const missing = `COALESCE(NULLIF(l.channel, ''), NULLIF(l.ft_channel, ''), NULLIF(l.utm_source, ''), NULLIF(l.ft_source, ''), NULLIF(l.click_id, '')) IS NULL
        AND NOT EXISTS (SELECT 1 FROM visitors v WHERE v.id = l.visitor_id AND COALESCE(NULLIF(v.ft_channel, ''), NULLIF(v.ft_source, '')) IS NOT NULL)`;
      const [tot, ex, how] = await Promise.all([
        first(`SELECT COUNT(*) AS total, SUM(CASE WHEN ${missing} THEN 1 ELSE 0 END) AS n FROM leads l WHERE l.created_at BETWEEN ? AND ?`, [from, to]),
        all(`SELECT l.id FROM leads l WHERE l.created_at BETWEEN ? AND ? AND ${missing} ORDER BY l.created_at DESC LIMIT 10`, [from, to]),
        all(`SELECT COALESCE(l.booking_source, 'site') AS how, COUNT(*) AS n FROM leads l WHERE l.created_at BETWEEN ? AND ? AND ${missing} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [from, to]),
      ]);
      return { n: num(tot.n), total: num(tot.total), examples: ids(ex), detail: { byOrigin: Object.fromEntries(how.map((h) => [String(h.how), num(h.n)])) } };
    }),
    guard('regs_no_lead', async () => {
      const tables = [['webinar_registrations', 'Masterclass'], ['live_webinar_regs', 'Live webinar'], ['challenge_registrations', 'Challenge']] as const;
      const parts = await Promise.all(tables.map(async ([t, label]) => {
        const [tot, ex] = await Promise.all([
          first(`SELECT COUNT(*) AS total, SUM(CASE WHEN l.id IS NULL THEN 1 ELSE 0 END) AS n FROM ${t} r LEFT JOIN leads l ON l.id = r.lead_id WHERE r.created_at BETWEEN ? AND ?`, [from, to]),
          all(`SELECT r.id FROM ${t} r LEFT JOIN leads l ON l.id = r.lead_id WHERE r.created_at BETWEEN ? AND ? AND l.id IS NULL ORDER BY r.created_at DESC LIMIT 10`, [from, to]),
        ]);
        return { label, n: num(tot.n), total: num(tot.total), ex: ids(ex) };
      }));
      return {
        n: parts.reduce((a, p) => a + p.n, 0), total: parts.reduce((a, p) => a + p.total, 0), examples: parts.flatMap((p) => p.ex).slice(0, 10),
        detail: { byFunnel: Object.fromEntries(parts.map((p) => [p.label, { registrations: p.total, missing: p.n }])) },
      };
    }),
    guard('payments_no_attribution', () => payCheck('attributed')),
    guard('payments_no_capi', async () => {
      if (!metaConfigured(rt)) return { n: null, total: null, examples: [], note: 'Meta Conversions API is not connected (Integrations), so nothing is sent to check.' };
      return payCheck('capi');
    }),
    guard('capi_match_keys', async () => {
      const rows = await all(`SELECT event_id, event_name, match_keys FROM forward_log WHERE dest = 'meta' AND status = 'sent' AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 5000`, [from, to]);
      if (!rows.length && !metaConfigured(rt)) return { n: null, total: null, examples: [], note: 'Meta Conversions API is not connected (Integrations).' };
      const per: Record<string, { n: number } & Record<(typeof META_KEYS)[number], number>> = {};
      const bad: Row[] = [];
      for (const r of rows) {
        const keys = new Set(String(r.match_keys ?? '').split(',').map((k) => k.trim()));
        const ev = String(r.event_name);
        const x = (per[ev] ??= { n: 0, em: 0, ph: 0, fbp: 0, fbc: 0, external_id: 0 });
        x.n++;
        for (const k of META_KEYS) if (keys.has(k)) x[k]++;
        if (!keys.has('em') && !keys.has('ph')) bad.push(r);
      }
      const perEvent = Object.entries(per).sort((a, b) => b[1].n - a[1].n).map(([event, x]) => ({
        event, n: x.n, ...Object.fromEntries(META_KEYS.map((k) => [k, x.n ? x[k] / x.n : 0])),
      }));
      return { n: bad.length, total: rows.length, examples: ids(bad, 'event_id'), detail: { perEvent, keys: [...META_KEYS] } };
    }),
    guard('forward_failures', async () => {
      const [by, ex] = await Promise.all([
        all('SELECT dest, status, COUNT(*) AS n FROM forward_log WHERE ts BETWEEN ? AND ? GROUP BY 1, 2', [from, to]),
        all("SELECT event_id FROM forward_log WHERE ts BETWEEN ? AND ? AND status = 'failed' ORDER BY ts DESC LIMIT 10", [from, to]),
      ]);
      const byDest: Record<string, Record<string, number>> = {};
      for (const r of by) (byDest[String(r.dest)] ??= {})[String(r.status)] = num(r.n);
      const sum = (st?: string) => by.filter((r) => !st || r.status === st).reduce((a, r) => a + num(r.n), 0);
      return { n: sum('failed'), total: sum(), examples: ids(ex, 'event_id'), detail: { byDest, retrying: sum('retrying') } };
    }),
    guard('email_bounces', async () => {
      const [sent, sup, ex, failed] = await Promise.all([
        first("SELECT COUNT(*) AS n FROM emails WHERE status = 'sent' AND sent_at BETWEEN ? AND ?", [from, to]),
        all('SELECT reason, COUNT(*) AS n FROM email_suppressions WHERE created_at BETWEEN ? AND ? GROUP BY 1', [from, to]),
        all("SELECT l.id FROM email_suppressions s JOIN leads l ON l.email = s.email WHERE s.created_at BETWEEN ? AND ? AND s.reason IN ('bounced', 'complained') ORDER BY s.created_at DESC LIMIT 10", [from, to]),
        first("SELECT COUNT(*) AS n FROM emails WHERE status = 'failed' AND send_at BETWEEN ? AND ?", [from, to]),
      ]);
      const r = (k: string) => num(sup.find((x) => x.reason === k)?.n);
      const bounced = r('bounced'), complained = r('complained'), total = num(sent.n);
      return {
        n: bounced + complained, total, examples: ids(ex),
        detail: { bounced, complained, manual: r('manual'), failedSends: num(failed.n), bounceRate: total ? bounced / total : null, complaintRate: total ? complained / total : null },
      };
    }),
    guard('rooms_no_minutes', async () => {
      const rows = await all(
        `SELECT r.id,
                (SELECT COUNT(*) FROM room_attendance a WHERE a.room_id = r.id AND COALESCE(a.role, '') NOT IN ('host', 'cohost')) AS attendees,
                EXISTS (SELECT 1 FROM room_minutes m WHERE m.room_id = r.id) AS has_minutes
           FROM rooms r WHERE r.mode = 'webinar' AND r.went_live_at BETWEEN ? AND ? ORDER BY r.went_live_at DESC LIMIT 500`, [from, to]);
      const withPeople = rows.filter((r) => num(r.attendees) > 0);
      const missing = withPeople.filter((r) => !num(r.has_minutes));
      return { n: missing.length, total: withPeople.length, examples: ids(missing) };
    }),
    guard('ai_calls_stuck', async () => {
      const cut = now - HOUR;
      const [rows, open] = await Promise.all([
        all(`SELECT id, lead_id, status FROM outbound_calls WHERE (status = 'queued' AND run_at < ?) OR (status = 'dialing' AND updated_at < ?) ORDER BY run_at LIMIT 500`, [cut, cut]),
        first("SELECT COUNT(*) AS n FROM outbound_calls WHERE status IN ('queued', 'dialing')"),
      ]);
      const s = rt.settings as Partial<Record<string, string>>;
      return {
        n: rows.length, total: num(open.n), examples: ids(rows, 'lead_id'),
        detail: { queued: rows.filter((r) => r.status === 'queued').length, dialing: rows.filter((r) => r.status === 'dialing').length, elevenlabs: Boolean(s.ELEVENLABS_API_KEY) },
      };
    }),
    guard('duplicate_leads', async () => {
      const rows = await all('SELECT id, email FROM leads WHERE email IS NOT NULL ORDER BY created_at LIMIT 50000');
      const seen = new Map<string, string[]>();
      for (const r of rows) {
        const k = normaliseEmail(String(r.email));
        if (k) seen.set(k, [...(seen.get(k) ?? []), String(r.id)]);
      }
      const groups = [...seen.values()].filter((g) => g.length > 1);
      return { n: groups.reduce((a, g) => a + g.length - 1, 0), total: rows.length, examples: groups.flat().slice(0, 10), detail: { groups: groups.length } };
    }),
    guard('contact_format', async () => {
      const rows = await all('SELECT id, phone, timezone FROM leads WHERE created_at BETWEEN ? AND ? AND (phone IS NOT NULL OR timezone IS NOT NULL) ORDER BY created_at DESC LIMIT 5000', [from, to]);
      const badPhone = rows.filter((r) => r.phone != null && String(r.phone).trim() !== '' && !validPhone(String(r.phone)));
      const badTz = rows.filter((r) => r.timezone != null && String(r.timezone).trim() !== '' && !validTimeZone(String(r.timezone)));
      const bad = new Set([...badPhone, ...badTz].map((r) => String(r.id)));
      return { n: bad.size, total: rows.length, examples: [...bad].slice(0, 10), detail: { phone: badPhone.length, timezone: badTz.length } };
    }),
  ]);
}

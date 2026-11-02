import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { logAction } from '../ops/actions';
import { paidSaleOn } from '../lib/paid-sales';
import { fromMinor } from '../webinar/pass';

/**
 * Warehouse-style exports from Funnel HQ (Ad tracking → Exports): CSV or JSON of the key tables for a date range.
 * Admin-only (mounted behind requireAdmin), streamed page by page, capped at EXPORT_ROW_CAP rows, and every
 * download is written to dq_exports and the Command activity log. Personal details (names, emails, phone numbers,
 * free text that can hold them) are only written when the signed-in admin asks for them; without them each row
 * still carries the lead id, so files can be joined without exposing who the person is.
 */
export const EXPORT_ROW_CAP = 50_000;
export const EXPORT_MAX_DAYS = 400;
const PAGE = 500;

interface Source { select: string; from: string; order: string }
export interface Dataset { key: string; label: string; columns: string[]; pii: string[]; money?: string[]; sources: Source[] }

const lead = (a = 'l') => `${a}.first_name AS first_name, ${a}.last_name AS last_name, ${a}.email AS email, ${a}.phone AS phone`;

export const DATASETS: Record<string, Dataset> = {
  leads: {
    key: 'leads', label: 'Leads with attribution',
    columns: ['id', 'ref_code', 'created_at', 'first_name', 'last_name', 'email', 'phone', 'status', 'tier', 'score', 'route', 'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
      'click_type', 'ft_channel', 'ft_source', 'ft_campaign', 'ft_content', 'landing_path', 'lander', 'variant', 'country', 'device', 'industry', 'revenue_band', 'booking_source',
      'app_completed_at', 'booked_at', 'call_at', 'booking_cancelled_at', 'closed_at', 'revenue', 'unsubscribed_at'],
    pii: ['first_name', 'last_name', 'email', 'phone'],
    sources: [{
      select: `l.id, l.ref_code, l.created_at, ${lead()}, l.status, COALESCE(l.tier_override, l.tier) AS tier, l.score, l.route, l.channel, l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term,
               l.click_type, l.ft_channel, l.ft_source, l.ft_campaign, l.ft_content, l.landing_path, l.lander, l.variant, l.country, l.device, l.industry, l.revenue_band, l.booking_source,
               l.app_completed_at, l.booked_at, l.call_at, l.booking_cancelled_at, l.closed_at, l.revenue, l.unsubscribed_at`,
      from: 'FROM leads l WHERE l.created_at BETWEEN ?1 AND ?2', order: 'l.created_at, l.id',
    }],
  },
  registrations: {
    key: 'registrations', label: 'Registrations',
    columns: ['funnel', 'id', 'lead_id', 'created_at', 'first_name', 'last_name', 'email', 'phone', 'revenue_band', 'status', 'cohort', 'joined_at', 'replay_at', 'watch_seconds', 'offer_at'],
    pii: ['first_name', 'last_name', 'email', 'phone'],
    sources: [
      { select: `'masterclass' AS funnel, r.id, r.lead_id, r.created_at, ${lead()}, r.revenue_band, NULL AS status, r.session_id AS cohort, r.joined_at, r.replay_at, r.watch_seconds, r.cta_at AS offer_at`,
        from: 'FROM webinar_registrations r LEFT JOIN leads l ON l.id = r.lead_id WHERE r.created_at BETWEEN ?1 AND ?2', order: 'r.created_at, r.id' },
      { select: `'live' AS funnel, r.id, r.lead_id, r.created_at, ${lead()}, r.revenue_band, NULL AS status, r.event_id AS cohort, r.joined_at, r.replay_at, NULL AS watch_seconds, r.offer_seen_at AS offer_at`,
        from: 'FROM live_webinar_regs r LEFT JOIN leads l ON l.id = r.lead_id WHERE r.created_at BETWEEN ?1 AND ?2', order: 'r.created_at, r.id' },
      { select: `'challenge' AS funnel, r.id, r.lead_id, r.created_at, ${lead()}, r.revenue_band, r.status, r.cohort_id AS cohort, NULL AS joined_at, NULL AS replay_at, NULL AS watch_seconds, NULL AS offer_at`,
        from: 'FROM challenge_registrations r LEFT JOIN leads l ON l.id = r.lead_id WHERE r.created_at BETWEEN ?1 AND ?2', order: 'r.created_at, r.id' },
    ],
  },
  payments: {
    key: 'payments', label: 'Payments with attribution',
    columns: ['source_table', 'id', 'lead_id', 'first_name', 'last_name', 'email', 'phone', 'kind', 'product', 'status', 'amount', 'refunded', 'currency', 'paid_at', 'provider', 'funnel_source',
      'lt_channel', 'lt_source', 'lt_campaign', 'lt_content', 'lt_ad_id', 'ft_channel', 'ft_source', 'ft_campaign', 'ft_content'],
    pii: ['first_name', 'last_name', 'email', 'phone'],
    money: ['amount', 'refunded'],
    sources: [
      { select: `'webinar_passes' AS source_table, p.id, p.lead_id, ${lead()}, p.kind, p.product, p.status, p.amount, p.refunded_amount AS refunded, p.currency, p.paid_at, p.provider, p.source AS funnel_source,
                 a.lt_channel, a.lt_source, a.lt_campaign, a.lt_content, a.lt_ad_id, a.ft_channel, a.ft_source, a.ft_campaign, a.ft_content`,
        from: `FROM webinar_passes p LEFT JOIN leads l ON l.id = p.lead_id LEFT JOIN attr_conversions a ON a.ref_id = p.id WHERE ${paidSaleOn('p')} AND p.paid_at BETWEEN ?1 AND ?2`, order: 'p.paid_at, p.id' },
      { select: `'challenge_orders' AS source_table, o.id, o.lead_id, ${lead()}, o.kind, NULL AS product, o.status, o.amount, o.refunded_amount AS refunded, o.currency, o.paid_at, o.provider, 'challenge' AS funnel_source,
                 a.lt_channel, a.lt_source, a.lt_campaign, a.lt_content, a.lt_ad_id, a.ft_channel, a.ft_source, a.ft_campaign, a.ft_content`,
        from: `FROM challenge_orders o LEFT JOIN leads l ON l.id = o.lead_id LEFT JOIN attr_conversions a ON a.ref_id = o.id WHERE ${paidSaleOn('o')} AND o.paid_at BETWEEN ?1 AND ?2`, order: 'o.paid_at, o.id' },
    ],
  },
  rooms: {
    key: 'rooms', label: 'Room attendance and engagement',
    columns: ['room_id', 'room_title', 'mode', 'starts_at', 'went_live_at', 'who', 'lead_id', 'name', 'role', 'first_at', 'last_at', 'minutes', 'joins', 'on_stage_at', 'points', 'push_clicks'],
    pii: ['name'],
    sources: [{
      select: `a.room_id, r.title AS room_title, r.mode, r.starts_at, r.went_live_at, a.who, a.lead_id, a.name, a.role, a.first_at, a.last_at, a.minutes, a.joins, a.on_stage_at,
               (SELECT COALESCE(SUM(p.points), 0) FROM room_points p WHERE p.room_id = a.room_id AND p.who = a.who) AS points,
               (SELECT COUNT(*) FROM room_push_events e WHERE e.room_id = a.room_id AND e.who = a.who AND e.event = 'click') AS push_clicks`,
      from: 'FROM room_attendance a JOIN rooms r ON r.id = a.room_id WHERE a.first_at BETWEEN ?1 AND ?2', order: 'a.first_at, a.room_id, a.who',
    }],
  },
  emails: {
    key: 'emails', label: 'Emails sent, opened and clicked',
    columns: ['id', 'lead_id', 'to_email', 'sequence', 'step', 'template', 'subject', 'status', 'sent_at', 'opened_at', 'open_count', 'clicked_at', 'click_count', 'personalized', 'error'],
    pii: ['to_email', 'subject'],
    sources: [{
      select: 'e.id, e.lead_id, e.to_email, e.sequence, e.step, e.template, e.subject, e.status, e.sent_at, e.opened_at, e.open_count, e.clicked_at, e.click_count, e.personalized, e.error',
      from: 'FROM emails e WHERE e.sent_at BETWEEN ?1 AND ?2', order: 'e.sent_at, e.id',
    }],
  },
  ai_calls: {
    key: 'ai_calls', label: 'AI calls',
    columns: ['direction', 'id', 'lead_id', 'phone', 'kind', 'status', 'at', 'attempts', 'duration_s', 'outcome', 'ended_reason', 'error', 'summary'],
    pii: ['phone', 'summary'],
    sources: [
      { select: "'outbound' AS direction, c.id, c.lead_id, l.phone, c.kind, c.status, c.run_at AS at, c.attempts, NULL AS duration_s, c.outcome, NULL AS ended_reason, c.error, NULL AS summary",
        from: 'FROM outbound_calls c LEFT JOIN leads l ON l.id = c.lead_id WHERE c.created_at BETWEEN ?1 AND ?2', order: 'c.created_at, c.id' },
      { select: "'inbound' AS direction, v.id, v.lead_id, v.from_number AS phone, v.kind, v.status, v.started_at AS at, NULL AS attempts, v.duration_s, CAST(v.success AS TEXT) AS outcome, v.ended_reason, NULL AS error, v.summary",
        from: 'FROM voice_calls v WHERE v.created_at BETWEEN ?1 AND ?2', order: 'v.created_at, v.id' },
    ],
  },
};
export const DATASET_KEYS = Object.keys(DATASETS);

/** The columns written for this export: personal-detail columns only when pii is on. */
export const exportColumns = (ds: Dataset, pii: boolean) => ds.columns.filter((c) => pii || !ds.pii.includes(c));

const TIME = /(^|_)at$/;
/** One value as written to the file: times as ISO (UTC), money in major units, everything else as stored. */
export function cellValue(col: string, row: Record<string, unknown>, ds: Pick<Dataset, 'money'>): unknown {
  const v = row[col];
  if (v == null) return null;
  if (TIME.test(col) && typeof v === 'number' && v > 0) return new Date(v).toISOString();
  if (ds.money?.includes(col) && typeof v === 'number') return fromMinor(v, String(row.currency || 'usd'));
  return v;
}

/** CSV cell: quoted when needed, and text that a spreadsheet would run as a formula is prefixed with '. */
export function csvCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function countRows(rt: Pick<Runtime, 'env'>, ds: Dataset, from: number, to: number) {
  let n = 0;
  for (const s of ds.sources) {
    try { n += Number((await rt.env.DB.prepare(`SELECT COUNT(*) AS n ${s.from}`).bind(from, to).first<{ n: number }>())?.n ?? 0); } catch (e) { console.error('export count', ds.key, e); }
  }
  return n;
}

export interface ExportOpts { format: 'csv' | 'json'; pii: boolean; from: number; to: number; cap?: number; onDone?: (rows: number) => Promise<unknown> | unknown }

/** The export as a stream: pages of PAGE rows, source after source, stopping at the cap. */
export function exportStream(rt: Pick<Runtime, 'env'>, ds: Dataset, o: ExportOpts): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const cols = exportColumns(ds, o.pii);
  const cap = Math.max(0, Math.min(o.cap ?? EXPORT_ROW_CAP, EXPORT_ROW_CAP));
  let src = 0, offset = 0, written = 0, started = false, done = false;
  const line = (row: Record<string, unknown>) => {
    if (o.format === 'csv') return cols.map((c) => csvCell(cellValue(c, row, ds))).join(',') + '\r\n';
    const obj: Record<string, unknown> = {};
    for (const c of cols) obj[c] = cellValue(c, row, ds);
    return `${written ? ',\n' : ''}${JSON.stringify(obj)}`;
  };
  const finish = async (ctl: ReadableStreamDefaultController<Uint8Array>) => {
    done = true;
    if (o.format === 'json') ctl.enqueue(enc.encode('\n]\n'));
    ctl.close();
    try { await o.onDone?.(written); } catch (e) { console.error('export done', e); }
  };
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (done) return;
      if (!started) {
        started = true;
        ctl.enqueue(enc.encode(o.format === 'csv' ? '﻿' + cols.join(',') + '\r\n' : '[\n'));
        return;
      }
      while (src < ds.sources.length && written < cap) {
        const s = ds.sources[src];
        const limit = Math.min(PAGE, cap - written);
        let rows: Record<string, unknown>[] = [];
        try {
          rows = (await rt.env.DB.prepare(`SELECT ${s.select} ${s.from} ORDER BY ${s.order} LIMIT ?3 OFFSET ?4`).bind(o.from, o.to, limit, offset).all<Record<string, unknown>>()).results;
        } catch (e) { console.error('export page', ds.key, e); rows = []; }
        if (!rows.length) { src++; offset = 0; continue; }
        offset += rows.length;
        let chunk = '';
        for (const r of rows) { chunk += line(r); written++; }
        ctl.enqueue(enc.encode(chunk));
        if (rows.length < limit) { src++; offset = 0; }
        return;
      }
      await finish(ctl);
    },
  });
}

const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dq-export|${s}`)))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');

/** Writes the audit row (and a Command activity entry) before streaming; the row count is filled in at the end. */
export async function auditExport(rt: Runtime, a: { dataset: string; format: string; from: number; to: number; pii: boolean; rows: number; capped: boolean; ip?: string | null; label: string }, now = Date.now()) {
  const id = newId('exp_');
  await rt.env.DB.prepare(
    'INSERT INTO dq_exports (id, dataset, format, from_ts, to_ts, pii, rows, capped, actor, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, a.dataset, a.format, a.from, a.to, a.pii ? 1 : 0, a.rows, a.capped ? 1 : 0, 'admin', a.ip ? await sha(a.ip) : null, now).run();
  await logAction(rt, {
    dept: 'chief', kind: 'data.export', actor: 'you', status: 'done', source: 'Ad tracking → Exports',
    summary: `Exported ${a.rows} rows of ${a.label} (${a.format.toUpperCase()}${a.pii ? ', with personal details' : ', without personal details'})${a.capped ? `, stopped at the ${EXPORT_ROW_CAP}-row cap` : ''}`,
    payload: { export_id: id, dataset: a.dataset, from: a.from, to: a.to },
  }, now).catch((e) => console.error('export log', e));
  return id;
}

export async function finishExport(rt: Pick<Runtime, 'env'>, id: string, rows: number, now = Date.now()) {
  await rt.env.DB.prepare('UPDATE dq_exports SET rows = ?, finished_at = ? WHERE id = ?').bind(rows, now, id).run();
}

export async function recentExports(rt: Pick<Runtime, 'env'>, limit = 10) {
  const { results } = await rt.env.DB.prepare('SELECT id, dataset, format, from_ts, to_ts, pii, rows, capped, created_at, finished_at FROM dq_exports ORDER BY created_at DESC LIMIT ?').bind(limit).all();
  return results;
}

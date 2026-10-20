import type { Runtime } from '../app';
import { overview, parseFilters } from './stats';
import { webinarReport } from './webinar';
import { loadReps } from '../sales/reps';
import { newId } from '../lib/ids';

/** A live rate for one model input: value, how many people it's based on, and what it measures. */
type Live = { value: number; n: number; note: string } | null;
const rate = (num: number, den: number, note: string): Live => (den > 0 ? { value: Math.min(1, num / den), n: den, note } : null);

/**
 * Real numbers to set the model's assumptions against (last 90 days unless said otherwise).
 * Spend and cost per visitor aren't tracked here (no ad-account connection), so those stay assumptions.
 */
export async function financeActuals(rt: Runtime) {
  const db = rt.env.DB;
  const to = Date.now(), from = to - 90 * 86400_000;
  const [ov, web, webVisitors, outcomes, fees, reps] = await Promise.all([
    overview(rt.env, parseFilters({ from: String(from), to: String(to) })),
    webinarReport(rt, { from, to }),
    db.prepare("SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE name = 'page_view' AND path = '/webinar' AND is_bot = 0 AND ts BETWEEN ? AND ?").bind(from, to).first<{ n: number }>(),
    db.prepare(`SELECT SUM(status IN ('showed','won','lost')) AS held, SUM(status = 'no_show') AS no_show, SUM(status = 'won') AS won, SUM(status = 'lost') AS lost,
                       AVG(CASE WHEN status = 'won' AND revenue > 0 THEN revenue END) AS avg_fee, SUM(refunded_at IS NOT NULL) AS refunded,
                       AVG(CASE WHEN status = 'won' AND revenue > 0 THEN MIN(1.0, COALESCE(cash_collected, 0) * 1.0 / revenue) END) AS upfront
                  FROM leads`).first<Record<string, number | null>>(),
    db.prepare('SELECT COUNT(*) AS n, AVG(fee) AS fee FROM contracts WHERE COALESCE(is_test, 0) = 0').first<{ n: number; fee: number | null }>().catch(() => null),
    loadReps(rt.env),
  ]);
  const k = ov.kpis, w = web.kpis as Record<string, number | null>;
  const qualified = (k.tier_a ?? 0) + (k.tier_b ?? 0);
  const landing = ov.funnel.find((x) => x.key === 'landing')?.n ?? 0;
  const leads = ov.funnel.find((x) => x.key === 'lead')?.n ?? 0;
  const applied = ov.funnel.find((x) => x.key === 'applied')?.n ?? 0;
  // Bookings made through the funnel only (calls imported from Calendly history aren't funnel bookings).
  const funnelBooked = ov.funnel.find((x) => x.key === 'booked')?.n ?? 0;
  const won = outcomes?.won ?? 0, lost = outcomes?.lost ?? 0, held = outcomes?.held ?? 0, noShow = outcomes?.no_show ?? 0;
  const regs = w.registrations ?? 0, att = w.attended ?? 0;
  const closers = reps.filter((r) => r.commission_pct > 0);
  const fee: Live = won && outcomes?.avg_fee ? { value: outcomes.avg_fee, n: won, note: 'average deal value of won clients' }
    : fees?.n && fees.fee ? { value: fees.fee, n: fees.n, note: 'average fee on agreements sent' } : null;
  return {
    shared: {
      fee,
      refund: won ? rate(outcomes?.refunded ?? 0, won, 'won clients refunded') : null,
      upfront: won && outcomes?.upfront != null ? { value: outcomes.upfront, n: won, note: 'share of the fee collected so far' } : null,
      commission: closers.length ? { value: closers.reduce((a, r) => a + r.commission_pct, 0) / closers.length / 100, n: closers.length, note: 'average closer commission in Reps & routing' } : null,
    },
    vsl: {
      optin: rate(leads, landing, 'VSL page visitors who gave contact details'),
      appDone: rate(applied, leads, 'of those who finished the application'),
      qualified: rate(qualified, k.applications ?? 0, 'applications scored A or B'),
      book: rate(funnelBooked, qualified, 'qualified applicants who booked through the funnel'),
      show: rate(held, held + noShow, 'calls with an outcome logged, all time'),
      close: rate(won, won + lost, 'held calls won, all time'),
    },
    webinar: {
      reg: rate(regs, webVisitors?.n ?? 0, 'webinar page visitors who registered'),
      attend: rate(att + (w.replays ?? 0), regs, 'registrants who watched live or the replay'),
      applyAtt: rate(w.applied ?? 0, att, 'applications per attendee (includes any who applied without attending)'),
      qualified: null,
      book: rate(w.booked ?? 0, w.applied ?? 0, 'webinar applicants who booked'),
      show: rate(held, held + noShow, 'calls with an outcome logged, all time'),
      close: rate(won, won + lost, 'held calls won, all time'),
    },
    window: { from, to },
  };
}

export async function listModels(rt: Runtime) {
  const { results } = await rt.env.DB.prepare('SELECT id, name, data, updated_at FROM fin_models ORDER BY updated_at DESC LIMIT 50').all<{ id: string; name: string; data: string; updated_at: number }>();
  return results.map((r) => ({ id: r.id, name: r.name, updated_at: r.updated_at, data: safeJson(r.data) }));
}

const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return {}; } };

/** Keep only plain numbers / booleans / a currency code in the three known sections. */
export function cleanModel(input: unknown) {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Record<string, Record<string, number | boolean | string>> = {};
  for (const sec of ['shared', 'vsl', 'webinar']) {
    const o: Record<string, number | boolean | string> = {};
    const v = (src[sec] && typeof src[sec] === 'object' ? src[sec] : {}) as Record<string, unknown>;
    for (const [key, val] of Object.entries(v).slice(0, 40)) {
      if (!/^[a-zA-Z]{1,20}$/.test(key)) continue;
      if (typeof val === 'number' && Number.isFinite(val)) o[key] = val;
      else if (typeof val === 'boolean') o[key] = val;
      else if (key === 'currency' && typeof val === 'string' && /^[A-Z]{3}$/.test(val)) o[key] = val;
    }
    out[sec] = o;
  }
  return out;
}

export async function saveModel(rt: Runtime, body: { id?: unknown; name?: unknown; data?: unknown }) {
  const id = typeof body.id === 'string' && /^[\w-]{1,40}$/.test(body.id) ? body.id : newId('fm_');
  const name = (typeof body.name === 'string' ? body.name.trim() : '').slice(0, 80) || 'Base case';
  await rt.env.DB.prepare('INSERT INTO fin_models (id, name, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at')
    .bind(id, name, JSON.stringify(cleanModel(body.data)), Date.now()).run();
  return { id, name };
}

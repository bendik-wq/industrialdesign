import type { Env } from '../env';
import { REVENUE_LABEL, REVENUE_ORDER } from '../sales/qualify';

/**
 * Who the best leads are. Looks at everyone who booked a call (funnel or
 * Calendly), split by tier, and digs into the A-tier: who they are, how they
 * book, whether they turn up and close.
 */
interface Row {
  id: string; tier: string | null; score: number | null; status: string; revenue_band: string | null; industry: string | null; budget_band: string | null;
  willing_to_invest: string | null; qual_flags: string | null; booked_at: number | null; call_at: number | null; booking_cancelled_at: number | null;
  revenue: number; cash_collected: number; channel: string | null; booking_source: string | null; temperature: string | null; objection: string | null;
  bookings: number; cancels: number; reschedules: number; answers: string | null; created_at: number;
}

const pct = (a: number, b: number) => (b ? a / b : 0);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const count = (xs: (string | null | undefined)[]) => Object.entries(xs.reduce<Record<string, number>>((m, x) => { if (x) m[x] = (m[x] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n }));

/** Collapse free-text industries into broad sectors so patterns show. */
export function sector(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  const map: [RegExp, string][] = [
    [/health|clinic|medical|dental|podiat|physio|pharma|care\b|aged/, 'Healthcare'],
    [/construct|build|trade|plumb|electric|hvac|roof|rood|solar|landscap|janitor|clean|security/, 'Construction, trades & field services'],
    [/m&a|invest|bank|capital|family office|private equity|financ|wealth|insurance|accounting|tax/, 'Finance & investing'],
    [/real estate|property/, 'Real estate'],
    [/tech|software|saas|it\b|\bai\b|digital|seo|marketing|agency|media/, 'Tech, marketing & agencies'],
    [/recruit|staffing|consult|coach|advis|professional/, 'Services & consulting'],
    [/retail|ecom|e-com|food|bakery|restaurant|hospitality|cafe|outlet|event|travel|villa|music/, 'Retail, hospitality & leisure'],
    [/manufactur|logistic|logitic|supply chain|transport|freight|distribut|wholesale/, 'Industrial & logistics'],
    [/telecom|energy|solar|utilit/, 'Telecom & energy'],
    [/student|job|employ|entrepreneur|startup|diversified/, 'Early-stage / individual'],
  ];
  return map.find(([re]) => re.test(t))?.[1] ?? 'Other';
}

export async function insights(env: Env, tz: string) {
  const { results } = await env.DB.prepare(
    `SELECT l.id, COALESCE(l.tier_override, l.tier) AS tier, l.score, l.status, l.revenue_band, l.industry, l.budget_band, l.willing_to_invest, l.qual_flags,
            l.booked_at, l.call_at, l.booking_cancelled_at, l.revenue, l.cash_collected, l.channel, l.booking_source, l.temperature, l.objection, l.created_at,
            (SELECT COUNT(*) FROM calendly_bookings b WHERE b.lead_id = l.id AND b.rescheduled = 0) AS bookings,
            (SELECT COUNT(*) FROM calendly_bookings b WHERE b.lead_id = l.id AND b.status = 'canceled' AND b.rescheduled = 0) AS cancels,
            (SELECT COUNT(*) FROM calendly_bookings b WHERE b.lead_id = l.id AND b.rescheduled = 1) AS reschedules,
            (SELECT answers FROM calendly_bookings b WHERE b.lead_id = l.id AND b.answers IS NOT NULL ORDER BY b.start_at DESC LIMIT 1) AS answers
       FROM leads l WHERE l.booked_at IS NOT NULL`,
  ).all<Row>();
  const now = Date.now();
  const fmt = (ms: number, o: Intl.DateTimeFormatOptions) => { try { return new Intl.DateTimeFormat('en-AU', { ...o, timeZone: tz }).format(ms); } catch { return new Intl.DateTimeFormat('en-AU', o).format(ms); } };

  const summarise = (rows: Row[]) => {
    const past = rows.filter((r) => r.call_at && r.call_at < now && !r.booking_cancelled_at);
    const logged = past.filter((r) => ['showed', 'won', 'lost', 'no_show'].includes(r.status));
    const held = logged.filter((r) => r.status !== 'no_show');
    const won = rows.filter((r) => r.status === 'won');
    const leadDays = rows.filter((r) => r.booked_at && r.call_at && r.call_at > r.booked_at).map((r) => (r.call_at! - r.booked_at!) / 86_400_000);
    const bookings = rows.reduce((t, r) => t + Math.max(1, r.bookings), 0);
    const cancels = rows.reduce((t, r) => t + r.cancels, 0);
    return {
      people: rows.length,
      bookings,
      cancel_rate: pct(cancels, bookings),
      reschedule_rate: pct(rows.reduce((t, r) => t + r.reschedules, 0), bookings),
      repeat_bookers: rows.filter((r) => r.bookings > 1).length,
      median_days_booked_ahead: median(leadDays),
      past_calls: past.length,
      outcomes_logged: logged.length,
      show_rate: logged.length ? pct(held.length, logged.length) : null,
      close_rate: held.length ? pct(won.length, held.length) : null,
      won: won.length,
      revenue: won.reduce((t, r) => t + (r.revenue || 0), 0),
      cash: rows.reduce((t, r) => t + (r.cash_collected || 0), 0),
      willing_yes: pct(rows.filter((r) => r.willing_to_invest === 'yes').length, rows.filter((r) => r.willing_to_invest && r.willing_to_invest !== 'unknown').length),
    };
  };

  const byTier = Object.fromEntries((['A', 'B', 'C', 'none'] as const).map((t) => [t, summarise(results.filter((r) => (r.tier ?? 'none') === t))]));
  const a = results.filter((r) => r.tier === 'A');
  const parsed = a.map((r) => { try { return JSON.parse(r.answers ?? '[]') as { q: string; a: string }[]; } catch { return []; } });
  const answersFor = (re: RegExp, split = false) => parsed.flatMap((ans) => { const x = ans.find((y) => re.test(y.q))?.a; return x ? (split ? x.split('\n').map((s) => s.trim()) : [x.trim()]) : []; });

  return {
    total_booked: results.length,
    byTier,
    a: {
      ...byTier.A,
      revenue_bands: REVENUE_ORDER.map((b) => ({ k: REVENUE_LABEL[b], n: a.filter((r) => r.revenue_band === b).length })).filter((x) => x.n),
      sectors: count(a.map((r) => sector(r.industry))),
      industries: count(a.map((r) => r.industry?.trim() ?? null)).slice(0, 25),
      budgets: count(a.map((r) => r.budget_band)),
      describes: count(answersFor(/best describes/i, true)),
      help: count(answersFor(/looking for help/i, true)),
      statements: count(answersFor(/statements that apply/i, true)),
      call_weekday: count(a.filter((r) => r.call_at).map((r) => fmt(r.call_at!, { weekday: 'short' }))),
      call_hour: count(a.filter((r) => r.call_at).map((r) => fmt(r.call_at!, { hour: 'numeric', hour12: true }))),
      booked_month: count(a.filter((r) => r.booked_at).map((r) => new Date(r.booked_at!).toISOString().slice(0, 7))).sort((x, y) => x.k.localeCompare(y.k)),
      sources: count(a.map((r) => r.booking_source === 'calendly-direct' ? 'Calendly link (direct)' : r.channel ?? 'Direct')),
      statuses: count(a.map((r) => r.status)),
      notes: count(answersFor(/anything else/i)).map((x) => x.k).slice(0, 15),
    },
  };
}

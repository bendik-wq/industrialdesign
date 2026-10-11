import type { Env } from '../env';
import { type Rep, loadReps } from '../sales/reps';

/**
 * Sales team numbers for Funnel HQ. Calls are attributed to the lead's
 * assigned closer; outcomes come from the status the team logs on each lead.
 * Range filters apply to when the call was scheduled (call_at) and, for
 * revenue, to when the deal closed (closed_at).
 */
interface RepRow {
  rep: string | null;
  booked: number;
  held: number;
  no_shows: number;
  won: number;
  lost: number;
  revenue: number;
  cash: number;
}

const rate = (a: number, b: number) => (b ? a / b : 0);

export async function salesStats(env: Env, from: number, to: number, tz: string) {
  const reps = await loadReps(env);
  const db = env.DB;
  const now = Date.now();
  const monthStart = startOfMonth(now, tz);

  const [calls, deals, mtd, upcoming, needsOutcome, recent, lostReasons] = await Promise.all([
    // Calls scheduled in range, by closer.
    db.prepare(
      `SELECT closer_id AS rep, COUNT(*) AS booked,
              SUM(status IN ('showed', 'won', 'lost')) AS held,
              SUM(status = 'no_show') AS no_shows
         FROM leads WHERE booked_at IS NOT NULL AND booking_cancelled_at IS NULL AND COALESCE(call_at, booked_at) BETWEEN ? AND ?
        GROUP BY 1`,
    ).bind(from, to).all<Pick<RepRow, 'rep' | 'booked' | 'held' | 'no_shows'>>(),
    // Deals closed in range.
    db.prepare(
      `SELECT closer_id AS rep, SUM(status = 'won') AS won, SUM(status = 'lost') AS lost,
              COALESCE(SUM(CASE WHEN status = 'won' THEN revenue ELSE 0 END), 0) AS revenue,
              COALESCE(SUM(CASE WHEN status = 'won' THEN cash_collected ELSE 0 END), 0) AS cash
         FROM leads WHERE closed_at BETWEEN ? AND ? GROUP BY 1`,
    ).bind(from, to).all<Pick<RepRow, 'rep' | 'won' | 'lost' | 'revenue' | 'cash'>>(),
    // Month to date, for targets.
    db.prepare(
      `SELECT closer_id AS rep, COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(cash_collected), 0) AS cash, COUNT(*) AS won
         FROM leads WHERE status = 'won' AND closed_at >= ? GROUP BY 1`,
    ).bind(monthStart).all<{ rep: string | null; revenue: number; cash: number; won: number }>(),
    // Upcoming calls (next 14 days).
    db.prepare(
      `SELECT l.id, l.first_name, l.last_name, l.email, l.phone, l.ref_code, l.call_at, l.closer_id, COALESCE(l.tier_override, l.tier) AS tier, l.score,
              l.channel, l.utm_campaign, l.utm_content, l.country,
              (SELECT MAX(max_position / NULLIF(duration, 0)) FROM vsl_views v WHERE v.lead_id = l.id) AS vsl_pct
         FROM leads l
        WHERE l.status = 'booked' AND l.booking_cancelled_at IS NULL AND l.call_at BETWEEN ? AND ?
        ORDER BY l.call_at LIMIT 100`,
    ).bind(now - 30 * 60_000, now + 14 * 86_400_000).all(),
    // Calls that happened but nobody logged an outcome.
    db.prepare(
      `SELECT l.id, l.first_name, l.last_name, l.email, l.call_at, l.booked_at, l.closer_id, COALESCE(l.tier_override, l.tier) AS tier
         FROM leads l
        WHERE l.status = 'booked' AND l.booking_cancelled_at IS NULL AND COALESCE(l.call_at, l.booked_at + 86400000) < ?
        ORDER BY COALESCE(l.call_at, l.booked_at) DESC LIMIT 100`,
    ).bind(now - 60 * 60_000).all(),
    // Recent outcomes.
    db.prepare(
      `SELECT l.id, l.first_name, l.last_name, l.status, l.revenue, l.cash_collected, l.closed_at, l.showed_at, l.updated_at, l.lost_reason, l.closer_id,
              l.channel, l.utm_campaign, l.utm_content
         FROM leads l WHERE l.status IN ('showed', 'won', 'lost', 'no_show') ORDER BY l.updated_at DESC LIMIT 30`,
    ).all(),
    db.prepare(`SELECT COALESCE(lost_reason, 'Not given') AS reason, COUNT(*) AS n FROM leads WHERE status = 'lost' AND closed_at BETWEEN ? AND ? GROUP BY 1 ORDER BY 2 DESC`).bind(from, to).all(),
  ]);

  const byRep = new Map<string, RepRow>();
  const row = (id: string | null) => {
    const k = id ?? '_unassigned';
    let r = byRep.get(k);
    if (!r) byRep.set(k, (r = { rep: id, booked: 0, held: 0, no_shows: 0, won: 0, lost: 0, revenue: 0, cash: 0 }));
    return r;
  };
  for (const c of calls.results) Object.assign(row(c.rep), { booked: c.booked, held: c.held, no_shows: c.no_shows });
  for (const d of deals.results) Object.assign(row(d.rep), { won: d.won, lost: d.lost, revenue: d.revenue, cash: d.cash });
  const mtdBy = new Map(mtd.results.map((m) => [m.rep ?? '_unassigned', m]));

  const repInfo = (id: string | null): Pick<Rep, 'name' | 'role' | 'commission_pct' | 'monthly_target'> & { id: string | null } => {
    const r = reps.find((x) => x.id === id);
    return r ? { id: r.id, name: r.name, role: r.role, commission_pct: r.commission_pct, monthly_target: r.monthly_target } : { id: null, name: 'Unassigned', role: 'closer', commission_pct: 0, monthly_target: 0 };
  };

  const leaderboard = [...new Set([...reps.filter((r) => r.active && r.role !== 'setter').map((r) => r.id), ...byRep.keys()])]
    .map((k) => {
      const id = k === '_unassigned' ? null : k;
      const r = byRep.get(k) ?? { rep: id, booked: 0, held: 0, no_shows: 0, won: 0, lost: 0, revenue: 0, cash: 0 };
      const info = repInfo(id);
      const m = mtdBy.get(k);
      return {
        ...info,
        ...r,
        show_rate: rate(r.held, r.held + r.no_shows),
        close_rate: rate(r.won, r.held),
        avg_deal: rate(r.revenue, r.won),
        commission: (r.cash * info.commission_pct) / 100,
        mtd_revenue: m?.revenue ?? 0,
        mtd_cash: m?.cash ?? 0,
        target_progress: info.monthly_target ? (m?.revenue ?? 0) / info.monthly_target : null,
      };
    })
    .filter((r) => r.id !== null || r.booked || r.won || r.lost)
    .sort((a, b) => b.revenue - a.revenue || b.won - a.won || b.held - a.held);

  const total = leaderboard.reduce((t, r) => ({
    booked: t.booked + r.booked, held: t.held + r.held, no_shows: t.no_shows + r.no_shows, won: t.won + r.won, lost: t.lost + r.lost,
    revenue: t.revenue + r.revenue, cash: t.cash + r.cash, commission: t.commission + r.commission,
  }), { booked: 0, held: 0, no_shows: 0, won: 0, lost: 0, revenue: 0, cash: 0, commission: 0 });

  return {
    totals: {
      ...total,
      show_rate: rate(total.held, total.held + total.no_shows),
      close_rate: rate(total.won, total.held),
      avg_deal: rate(total.revenue, total.won),
      upcoming: upcoming.results.length,
      needs_outcome: needsOutcome.results.length,
    },
    leaderboard,
    upcoming: upcoming.results,
    needsOutcome: needsOutcome.results,
    recent: recent.results,
    lostReasons: lostReasons.results,
    reps,
  };
}

/** Midnight on the 1st of the current month in the team's time zone, as epoch ms. */
export function startOfMonth(now: number, tz: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(new Date(now));
    const y = Number(parts.find((p) => p.type === 'year')!.value);
    const m = Number(parts.find((p) => p.type === 'month')!.value);
    const utcGuess = Date.UTC(y, m - 1, 1);
    // Shift by the zone's offset at that moment.
    const local = new Date(new Date(utcGuess).toLocaleString('en-US', { timeZone: tz })).getTime();
    return utcGuess - (local - utcGuess);
  } catch {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
}

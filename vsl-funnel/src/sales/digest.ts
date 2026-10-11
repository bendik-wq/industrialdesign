import type { Runtime } from '../app';
import { salesStats } from '../admin/sales';
import { money, notify, notifyConfigured } from '../integrations/notify';

const DAY = 86_400_000;

/** Local date (YYYY-MM-DD) and hour for a time zone. */
export function localClock(now: number, tz: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
  } catch {
    const d = new Date(now).toISOString();
    return { date: d.slice(0, 10), hour: Number(d.slice(11, 13)) };
  }
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Builds the morning digest: last 24h of funnel + sales, today's calls, month-to-date leaderboard. */
export async function buildDigest(rt: Runtime, now = Date.now()) {
  const tz = rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
  const db = rt.env.DB;
  const [day, funnel] = await Promise.all([
    salesStats(rt.env, now - DAY, now, tz),
    db.prepare(
      `SELECT (SELECT COUNT(DISTINCT visitor_id) FROM sessions WHERE started_at >= ?1) AS visitors,
              (SELECT COUNT(*) FROM leads WHERE app_completed_at >= ?1) AS applications,
              (SELECT COUNT(*) FROM leads WHERE app_completed_at >= ?1 AND COALESCE(tier_override, tier) IN ('A', 'B')) AS qualified,
              (SELECT COUNT(*) FROM leads WHERE booked_at >= ?1) AS booked`,
    ).bind(now - DAY).first<{ visitors: number; applications: number; qualified: number; booked: number }>().catch(() => null),
  ]);
  const month = await salesStats(rt.env, now - 31 * DAY, now, tz);
  const name = (id: string | null) => rt.reps.find((r) => r.id === id)?.name ?? 'Unassigned';
  const today = day.upcoming.filter((c) => Number((c as { call_at: number }).call_at) < now + DAY);

  const lines = [
    `*Last 24h* — ${funnel?.visitors ?? 0} visitors · ${funnel?.applications ?? 0} applications (${funnel?.qualified ?? 0} qualified) · ${funnel?.booked ?? 0} calls booked`,
    `*Calls* — ${day.totals.held} held · ${day.totals.no_shows} no-shows · ${day.totals.won} won (${money(day.totals.revenue)}) · ${day.totals.lost} lost`,
    '',
    `*Next 24h: ${today.length} call${today.length === 1 ? '' : 's'}*`,
    ...today.slice(0, 15).map((c) => {
      const x = c as { call_at: number; first_name: string | null; last_name: string | null; email: string | null; closer_id: string | null; tier: string | null };
      const when = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit', weekday: 'short' }).format(new Date(x.call_at));
      return `• ${when} — ${[x.first_name, x.last_name].filter(Boolean).join(' ') || x.email} (tier ${x.tier ?? '–'}) → ${name(x.closer_id)}`;
    }),
  ];
  if (day.totals.needs_outcome) lines.push('', `⚠️ ${day.totals.needs_outcome} past call${day.totals.needs_outcome === 1 ? ' needs' : 's need'} an outcome logged in Funnel HQ`);
  const board = month.leaderboard.filter((r) => r.id || r.won).slice(0, 8);
  if (board.length) {
    lines.push('', '*Month to date*');
    board.forEach((r, i) => {
      const target = r.target_progress != null ? ` · ${pct(r.target_progress)} of target` : '';
      lines.push(`${i + 1}. ${r.name} — ${money(r.mtd_revenue)} (${r.won} won, close ${pct(r.close_rate)})${target}`);
    });
  }
  return { title: `☀️ Daily sales digest — ${localClock(now, tz).date}`, lines };
}

/** Cron: post the digest once a day at DIGEST_HOUR in the team's time zone. */
export async function maybeSendDigest(rt: Runtime, now = Date.now()) {
  if (!notifyConfigured(rt)) return false;
  const tz = rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
  const hour = Number(rt.settings.DIGEST_HOUR || 8);
  if (!Number.isFinite(hour) || hour < 0) return false; // set DIGEST_HOUR to -1 to turn it off
  const clock = localClock(now, tz);
  if (clock.hour !== hour) return false;
  const claim = await rt.env.DB.prepare('INSERT OR IGNORE INTO kv_state (key, value) VALUES (?, ?)').bind(`digest:${clock.date}`, String(now)).run();
  if (!claim.meta.changes) return false;
  const d = await buildDigest(rt, now);
  await notify(rt, { kind: 'digest', ...d });
  return true;
}

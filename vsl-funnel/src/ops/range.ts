import type { Runtime } from '../app';
import { localParts, validTimeZone, wallTime } from '../challenge/schedule';

/** Time ranges in the owner's time zone, for the Command chat, the brief, documents and routines. */
export const DAY = 86_400_000;

export function ownerTz(rt: Pick<Runtime, 'settings'>): string {
  const s = rt.settings as Partial<Record<string, string>>;
  for (const tz of [s.OPS_TIMEZONE, s.SALES_TIMEZONE]) if (tz && validTimeZone(tz.trim())) return tz.trim();
  return 'Australia/Sydney';
}

export interface Range { from: number; to: number; label: string; key: string }

const ymd = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()] as const; };
/** Local midnight `offsetDays` from the local date of `now`. */
export function localMidnight(now: number, tz: string, offsetDays = 0) {
  const [y, m, d] = localParts(now, tz).date.split('-').map(Number);
  const [yy, mm, dd] = ymd(y, m, d + offsetDays);
  return wallTime(yy, mm, dd, 0, 0, tz);
}
/** 0 = Sunday … 6 = Saturday, for the local date of `t`. */
export function localWeekday(t: number, tz: string) {
  const [y, m, d] = localParts(t, tz).date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const RANGE_KEYS = ['today', 'yesterday', '24h', '7d', '30d', '90d', 'this_week', 'last_week', 'mtd', 'last_month', 'weekend'] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

/** A named range ending now (or at the last whole period). Weeks start on Monday. */
export function resolveRange(key: string, tz: string, now = Date.now()): Range {
  const today = localMidnight(now, tz);
  const wd = localWeekday(now, tz);
  const mondayOffset = -((wd + 6) % 7);
  const [y, m] = localParts(now, tz).date.split('-').map(Number);
  switch (key) {
    case 'today': return { key, from: today, to: now, label: 'Today' };
    case 'yesterday': return { key, from: localMidnight(now, tz, -1), to: today - 1, label: 'Yesterday' };
    case '24h': return { key, from: now - DAY, to: now, label: 'Last 24 hours' };
    case '30d': return { key, from: now - 30 * DAY, to: now, label: 'Last 30 days' };
    case '90d': return { key, from: now - 90 * DAY, to: now, label: 'Last 90 days' };
    case 'this_week': return { key, from: localMidnight(now, tz, mondayOffset), to: now, label: 'This week' };
    case 'last_week': return { key, from: localMidnight(now, tz, mondayOffset - 7), to: localMidnight(now, tz, mondayOffset) - 1, label: 'Last week' };
    case 'weekend': {
      // The most recent whole Saturday + Sunday.
      const sat = wd === 0 ? -8 : wd === 6 ? -7 : -(wd + 1);
      return { key, from: localMidnight(now, tz, sat), to: localMidnight(now, tz, sat + 2) - 1, label: 'Last weekend' };
    }
    case 'mtd': return { key, from: wallTime(y, m, 1, 0, 0, tz), to: now, label: 'Month to date' };
    case 'last_month': {
      const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      return { key, from: wallTime(py, pm, 1, 0, 0, tz), to: wallTime(y, m, 1, 0, 0, tz) - 1, label: 'Last month' };
    }
    case '7d':
    default: return { key: '7d', from: now - 7 * DAY, to: now, label: 'Last 7 days' };
  }
}

/** A custom range from YYYY-MM-DD dates (inclusive), in the owner's time zone. */
export function dateRange(from: string, to: string, tz: string): Range | null {
  const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!ok(from) || !ok(to)) return null;
  const [a, b, c] = from.split('-').map(Number);
  const [x, y, z] = to.split('-').map(Number);
  const f = wallTime(a, b, c, 0, 0, tz);
  const [yy, mm, dd] = ymd(x, y, z + 1);
  const t = wallTime(yy, mm, dd, 0, 0, tz) - 1;
  if (!(t > f)) return null;
  return { key: 'custom', from: f, to: t, label: `${from} to ${to}` };
}

/** The same length of time immediately before a range. */
export const priorOf = (r: Pick<Range, 'from' | 'to'>) => ({ from: r.from - (r.to - r.from) - 1, to: r.from - 1 });

export function formatDay(t: number, tz: string) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(t).replace(',', '');
}

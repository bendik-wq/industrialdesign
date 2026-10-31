/**
 * Pure scheduling and rules for the First Deal Challenge (no database): when each day runs in the cohort's
 * time zone, where a day stands right now, when the offer closes, and who may still watch a replay.
 */

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY_MS = 24 * HOUR;
export const DAYS_IN_CHALLENGE = 5;
/** Join on Zoom pressed (or the companion page open) from 15 minutes before the start to 15 after the end counts as live attendance. */
export const LIVE_GRACE_MS = 15 * MIN;
/** The cohort chat opens 30 minutes before and closes 30 minutes after each session. */
export const CHAT_WINDOW_MS = 30 * MIN;

export interface DayRow { cohort_id: string; day: number; starts_at: number; duration_min: number; join_url: string | null; replay_url: string | null; hot_seat_url: string | null; edited?: number }
export interface CohortRow { id: string; name: string; start_date: string; start_time: string; timezone: string; duration_min: number; status: string }

export const validTimeZone = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch { return false; }
};
export const validDate = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
export const validTime = (t: unknown): t is string => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

/** Epoch ms for a wall-clock time in a time zone (two passes, so DST changes land right). */
export function wallTime(y: number, m: number, d: number, h: number, min: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const offset = (t: number) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(t);
    const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(t / MIN) * MIN;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

/** The wall-clock date (YYYY-MM-DD) and time (HH:MM) of an instant in a time zone. */
export function localParts(t: number, tz: string) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t);
  const g = (k: string) => p.find((x) => x.type === k)!.value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
}

/** The five daily starts: Day 1 on the start date, then each following calendar day, all at the same local time. */
export function scheduleDays(startDate: string, startTime: string, tz: string, count = DAYS_IN_CHALLENGE): number[] {
  const [y, m, d] = startDate.split('-').map(Number);
  const [h, min] = startTime.split(':').map(Number);
  return Array.from({ length: count }, (_, i) => {
    // Calendar arithmetic on the date only, so a DST change between days keeps the same local start time.
    const date = new Date(Date.UTC(y, m - 1, d + i));
    return wallTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, min, tz);
  });
}

export const dayEnds = (d: Pick<DayRow, 'starts_at' | 'duration_min'>) => d.starts_at + d.duration_min * MIN;

export type DayPhase = 'upcoming' | 'soon' | 'live' | 'ended';
/** soon = within 30 minutes of the start (the page shows the Join button); live = between start and end. */
export function dayPhase(d: Pick<DayRow, 'starts_at' | 'duration_min'>, now: number): DayPhase {
  if (now >= dayEnds(d)) return 'ended';
  if (now >= d.starts_at) return 'live';
  if (now >= d.starts_at - CHAT_WINDOW_MS) return 'soon';
  return 'upcoming';
}

/** Live attendance counts from 15 minutes before the start to 15 minutes after the end. */
export const inLiveWindow = (d: Pick<DayRow, 'starts_at' | 'duration_min'>, now: number) => now >= d.starts_at - LIVE_GRACE_MS && now <= dayEnds(d) + LIVE_GRACE_MS;
/** The cohort chat: open from 30 minutes before to 30 minutes after the session. */
export const chatOpen = (d: Pick<DayRow, 'starts_at' | 'duration_min'>, now: number) => now >= d.starts_at - CHAT_WINDOW_MS && now <= dayEnds(d) + CHAT_WINDOW_MS;

/** CHALLENGE_OFFER_HOURS (default 48): how long after Day 5 ends the deposit offer (and non-VIP replays) stay open. */
export function offerHours(s: Partial<Record<string, string>>) {
  const n = Number(String(s.CHALLENGE_OFFER_HOURS ?? '').trim());
  return Number.isFinite(n) && n > 0 && n <= 24 * 30 ? n : 48;
}

/** The cohort's offer deadline: Day 5's end plus the offer hours. Null until Day 5 exists. */
export function offerCloseAt(days: Pick<DayRow, 'day' | 'starts_at' | 'duration_min'>[], hours: number) {
  const d5 = days.find((d) => d.day === DAYS_IN_CHALLENGE);
  return d5 ? dayEnds(d5) + hours * HOUR : null;
}

/** Replays: VIP keep them; everyone else until the cohort's offer closes. Never before the team posts one. */
export function replayAccess(o: { vip: boolean; replayUrl: string | null; closeAt: number | null; now: number }): 'open' | 'none' | 'closed' {
  if (!o.replayUrl) return 'none';
  if (o.vip) return 'open';
  return o.closeAt != null && o.now >= o.closeAt ? 'closed' : 'open';
}

/**
 * The day the hub puts first: the one live now, else the next one still to come today or later (a day stays
 * "today's" for 12 hours after it ends, so its replay card sits on top until the next day).
 */
export function focusDay<T extends Pick<DayRow, 'day' | 'starts_at' | 'duration_min'>>(days: T[], now: number): T | null {
  const sorted = [...days].sort((a, b) => a.day - b.day);
  return sorted.find((d) => dayPhase(d, now) === 'live') ?? sorted.find((d) => dayEnds(d) + 12 * HOUR > now) ?? sorted[sorted.length - 1] ?? null;
}

/** Registration stays open until Day 1 ends (late joiners get the Day 1 replay). */
export function registrationOpen(days: Pick<DayRow, 'day' | 'starts_at' | 'duration_min'>[], status: string, now: number) {
  const d1 = days.find((d) => d.day === 1);
  return status === 'scheduled' && Boolean(d1) && now < dayEnds(d1!);
}

export interface ProgressRow { day: number; joined_at: number | null; present_at: number | null; replay_at: number | null; homework_at: number | null }
/** Per day: attended live, watched the replay, worksheet done; plus totals. */
export function summarise(rows: ProgressRow[]) {
  const days = Array.from({ length: DAYS_IN_CHALLENGE }, (_, i) => {
    const r = rows.find((x) => x.day === i + 1);
    const live = Boolean(r && (r.joined_at || r.present_at));
    return { day: i + 1, live, replay: Boolean(r?.replay_at) && !live, homework: Boolean(r?.homework_at) };
  });
  return { days, attended: days.filter((d) => d.live || d.replay).length, live: days.filter((d) => d.live).length, homework: days.filter((d) => d.homework).length };
}

/** Countdown parts for display (the browser keeps it ticking from the same server time). */
export function countdownParts(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}
export function countdownText(ms: number) {
  const p = countdownParts(ms);
  if (p.d) return `${p.d}d ${p.h}h ${p.m}m`;
  if (p.h) return `${p.h}h ${p.m}m`;
  return `${p.m}m ${String(p.s).padStart(2, '0')}s`;
}

/** The event key builder A's host console and the offer use for one challenge day. */
export const eventKey = (cohortId: string, day: number) => `challenge:${cohortId}:${day}`;
export function parseEventKey(key: string) {
  const m = /^challenge:([a-z0-9_]{4,40}):([1-5])$/i.exec(key);
  return m ? { cohortId: m[1], day: Number(m[2]) } : null;
}

/** "Monday 9 November, 7:00 pm AEDT" in a time zone. */
export function formatWhen(t: number, tz: string, o: { weekday?: boolean; tzName?: boolean } = {}) {
  const fmt = (zone: string) => new Intl.DateTimeFormat('en-AU', { weekday: o.weekday === false ? undefined : 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: o.tzName === false ? undefined : 'short', timeZone: zone }).format(t);
  try { return fmt(tz); } catch { return fmt('UTC'); }
}
export function formatDate(t: number, tz: string) {
  const fmt = (zone: string) => new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone }).format(t);
  try { return fmt(tz); } catch { return fmt('UTC'); }
}

import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { formatMoney, fromMinor, toMinor } from '../webinar/pass';
import { cleanJoinUrl, upsertLiveEvent } from '../live/stream';
import { DAY_TITLES } from './content';
import {
  type CohortRow, type DayRow, DAYS_IN_CHALLENGE, MIN, dayEnds, eventKey, offerCloseAt, offerHours, registrationOpen, scheduleDays, validDate, validTime, validTimeZone,
} from './schedule';

/** Prices and switches (Funnel HQ → Integrations → Webinar, "Challenge" settings). */
export function challengeConfig(s: Partial<Record<string, string>>) {
  const price = (raw: unknown, dflt: number) => {
    const t = String(raw ?? '').trim();
    if (!t) return dflt;
    if (/^(off|no|none|free)$/i.test(t)) return 0;
    const n = Number(t.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  const currency = (String(s.CHALLENGE_CURRENCY ?? '').trim() || 'USD').toUpperCase().slice(0, 3);
  const ticket = price(s.CHALLENGE_PRICE, 100);
  const vip = price(s.CHALLENGE_VIP_PRICE, 300);
  const dur = Number(String(s.CHALLENGE_DURATION_MIN ?? '').trim());
  return {
    currency,
    ticket, ticketMinor: toMinor(ticket, currency), ticketLabel: formatMoney(ticket, currency),
    vip, vipMinor: toMinor(vip, currency), vipLabel: formatMoney(vip, currency), vipOn: vip > 0,
    free: ticket === 0,
    provider: String(s.WHOP_API_KEY ?? '').trim() ? ('whop' as const) : null,
    offerHours: offerHours(s),
    durationMin: Number.isFinite(dur) && dur >= 30 && dur <= 240 ? Math.round(dur) : 90,
    defaultTz: String(s.CHALLENGE_TIMEZONE ?? '').trim() || String(s.SALES_TIMEZONE ?? '').trim() || 'America/New_York',
  };
}
export type ChallengeConfig = ReturnType<typeof challengeConfig>;
export const money = (minor: number, currency: string) => formatMoney(fromMinor(minor, currency), currency.toUpperCase());

export interface Cohort extends CohortRow { created_at: number; updated_at: number }
export interface Registration {
  id: string; token: string; cohort_id: string; lead_id: string; seq: number; revenue_band: string | null;
  status: 'pending' | 'paid' | 'refunded'; vip: number; vip_seen_at: number | null; created_at: number; paid_at: number | null; vip_at: number | null; refunded_at: number | null;
}

export const getCohort = (rt: Runtime, id: string) => rt.env.DB.prepare('SELECT * FROM challenge_cohorts WHERE id = ?').bind(id).first<Cohort>();
/**
 * The cohort's days. The join link is the live engine's (live_events, set in the host console or created
 * through the Zoom API) when it has one, else the link saved on the day in Funnel HQ.
 */
export async function getDays(rt: Runtime, cohortId: string) {
  const db = rt.env.DB;
  const [days, live] = await db.batch([
    db.prepare('SELECT * FROM challenge_days WHERE cohort_id = ? ORDER BY day').bind(cohortId),
    db.prepare("SELECT key, join_url FROM live_events WHERE key LIKE ? AND join_url IS NOT NULL").bind(`challenge:${cohortId}:%`),
  ]);
  const links = new Map((live.results as { key: string; join_url: string }[]).map((r) => [r.key, cleanJoinUrl(r.join_url)]));
  return (days.results as DayRow[]).map((d) => ({ ...d, join_url: links.get(eventKey(cohortId, d.day)) || d.join_url }));
}

/** Registers (or re-times) each day with the live engine, so the host console shows it and can create its Zoom meeting. */
export async function syncLiveEvents(rt: Runtime, cohortId: string) {
  const c = await getCohort(rt, cohortId);
  if (!c) return;
  const { results } = await rt.env.DB.prepare('SELECT * FROM challenge_days WHERE cohort_id = ? ORDER BY day').bind(cohortId).all<DayRow>();
  for (const d of results) {
    await upsertLiveEvent(rt, eventKey(cohortId, d.day), {
      title: `The First Deal Challenge, Day ${d.day}: ${DAY_TITLES[d.day - 1]} (${c.name})`.slice(0, 200),
      startsAt: d.starts_at, durationMin: d.duration_min,
      ...(d.join_url ? { joinUrl: d.join_url } : {}),
    }).catch((e) => console.error('live event sync', String(e).slice(0, 200)));
  }
}
export const getReg = (rt: Runtime, token: string) =>
  /^[a-z0-9]{16,40}$/i.test(token) ? rt.env.DB.prepare('SELECT * FROM challenge_registrations WHERE token = ?').bind(token).first<Registration>() : Promise.resolve(null);
export const getRegById = (rt: Runtime, id: string) => rt.env.DB.prepare('SELECT * FROM challenge_registrations WHERE id = ?').bind(id).first<Registration>();

/** The cohort with its days and deadline, ready for any page. */
export async function loadCohort(rt: Runtime, id: string) {
  const cohort = await getCohort(rt, id);
  if (!cohort) return null;
  const days = await getDays(rt, id);
  return { cohort, days, closeAt: offerCloseAt(days, challengeConfig(rt.settings).offerHours) };
}
export type LoadedCohort = NonNullable<Awaited<ReturnType<typeof loadCohort>>>;

/** The cohort the landing page sells: the earliest scheduled one still open for registration. */
export async function nextCohort(rt: Runtime, now = Date.now()) {
  const { results } = await rt.env.DB.prepare(
    `SELECT c.* FROM challenge_cohorts c JOIN challenge_days d ON d.cohort_id = c.id AND d.day = 1
      WHERE c.status = 'scheduled' AND d.starts_at + d.duration_min * 60000 > ? ORDER BY d.starts_at LIMIT 3`,
  ).bind(now).all<Cohort>();
  for (const c of results) {
    const days = await getDays(rt, c.id);
    if (registrationOpen(days, c.status, now)) return { cohort: c, days, closeAt: offerCloseAt(days, challengeConfig(rt.settings).offerHours) };
  }
  return null;
}

export class CohortError extends Error { constructor(message: string, public field?: string) { super(message); } }

const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '');
const httpsOrNull = (v: unknown) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^https:\/\/[^\s"'<>]{3,}$/.test(v.trim())) throw new CohortError('Links must start with https://');
  return v.trim().slice(0, 500);
};

/** Creates a cohort and auto-schedules its five days (same local time each day). */
export async function createCohort(rt: Runtime, body: Record<string, unknown>, now = Date.now()) {
  const cfg = challengeConfig(rt.settings);
  const name = cleanName(body.name);
  const tz = typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : cfg.defaultTz;
  if (!name) throw new CohortError('Give the cohort a name', 'name');
  if (!validDate(body.start_date)) throw new CohortError('Pick a start date', 'start_date');
  if (!validTime(body.start_time)) throw new CohortError('Pick a daily start time (HH:MM)', 'start_time');
  if (!validTimeZone(tz)) throw new CohortError('That time zone isn’t recognised (use a name like America/New_York)', 'timezone');
  const duration = Number(body.duration_min) >= 30 && Number(body.duration_min) <= 240 ? Math.round(Number(body.duration_min)) : cfg.durationMin;
  const starts = scheduleDays(body.start_date, body.start_time, tz);
  if (starts[0] < now - 60 * MIN) throw new CohortError('Day 1 is in the past', 'start_date');
  const id = newId('cc');
  const links = Array.isArray(body.join_urls) ? body.join_urls : [];
  const db = rt.env.DB;
  await db.batch([
    db.prepare('INSERT INTO challenge_cohorts (id, name, start_date, start_time, timezone, duration_min, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, \'scheduled\', ?, ?)')
      .bind(id, name, body.start_date, body.start_time, tz, duration, now, now),
    ...starts.map((t, i) => db.prepare('INSERT INTO challenge_days (cohort_id, day, starts_at, duration_min, join_url, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, i + 1, t, duration, httpsOrNull(links[i] ?? body.join_url ?? null), now)),
  ]);
  return id;
}

/**
 * Edits the cohort. A new start date, time or zone re-schedules every day not set by hand; a day edited by
 * hand keeps its time. Returns true when any session time moved (the caller re-times the emails).
 */
export async function updateCohort(rt: Runtime, id: string, body: Record<string, unknown>, now = Date.now()) {
  const c = await getCohort(rt, id);
  if (!c) throw new CohortError('Cohort not found');
  const name = body.name !== undefined ? cleanName(body.name) : c.name;
  const date = body.start_date !== undefined ? body.start_date : c.start_date;
  const time = body.start_time !== undefined ? body.start_time : c.start_time;
  const tz = body.timezone !== undefined ? body.timezone : c.timezone;
  const status = body.status === 'cancelled' || body.status === 'scheduled' ? body.status : c.status;
  if (!name) throw new CohortError('Give the cohort a name', 'name');
  if (!validDate(date)) throw new CohortError('Pick a start date', 'start_date');
  if (!validTime(time)) throw new CohortError('Pick a daily start time (HH:MM)', 'start_time');
  if (!validTimeZone(tz)) throw new CohortError('That time zone isn’t recognised', 'timezone');
  const duration = body.duration_min !== undefined && Number(body.duration_min) >= 30 && Number(body.duration_min) <= 240 ? Math.round(Number(body.duration_min)) : c.duration_min;
  const db = rt.env.DB;
  await db.prepare('UPDATE challenge_cohorts SET name = ?, start_date = ?, start_time = ?, timezone = ?, duration_min = ?, status = ?, updated_at = ? WHERE id = ?')
    .bind(name, date, time, tz, duration, status, now, id).run();
  const moved = date !== c.start_date || time !== c.start_time || tz !== c.timezone || duration !== c.duration_min;
  if (moved) {
    const starts = scheduleDays(date, time, tz);
    await db.batch(starts.map((t, i) => db.prepare('UPDATE challenge_days SET starts_at = ?, duration_min = ?, updated_at = ? WHERE cohort_id = ? AND day = ? AND edited = 0').bind(t, duration, now, id, i + 1)));
  }
  return moved || status !== c.status;
}

/** One day: its own start (local date + time in the cohort's zone), length, Zoom link, replay link and hot seat link. */
export async function updateDay(rt: Runtime, cohortId: string, day: number, body: Record<string, unknown>, now = Date.now()) {
  const c = await getCohort(rt, cohortId);
  if (!c) throw new CohortError('Cohort not found');
  if (!Number.isInteger(day) || day < 1 || day > DAYS_IN_CHALLENGE) throw new CohortError('No such day');
  const cur = await rt.env.DB.prepare('SELECT * FROM challenge_days WHERE cohort_id = ? AND day = ?').bind(cohortId, day).first<DayRow>();
  if (!cur) throw new CohortError('No such day');
  let startsAt = cur.starts_at;
  let edited = cur.edited ?? 0;
  if (body.date !== undefined || body.time !== undefined) {
    if (!validDate(body.date) || !validTime(body.time)) throw new CohortError('Pick the day’s date and start time');
    const [t] = scheduleDays(body.date, body.time, c.timezone, 1);
    if (t !== cur.starts_at) { startsAt = t; edited = 1; }
  }
  const duration = body.duration_min !== undefined && Number(body.duration_min) >= 30 && Number(body.duration_min) <= 240 ? Math.round(Number(body.duration_min)) : cur.duration_min;
  const join = body.join_url !== undefined ? httpsOrNull(body.join_url) : cur.join_url;
  const replay = body.replay_url !== undefined ? httpsOrNull(body.replay_url) : cur.replay_url;
  const hot = body.hot_seat_url !== undefined ? httpsOrNull(body.hot_seat_url) : cur.hot_seat_url;
  await rt.env.DB.prepare('UPDATE challenge_days SET starts_at = ?, duration_min = ?, join_url = ?, replay_url = ?, hot_seat_url = ?, edited = ?, updated_at = ? WHERE cohort_id = ? AND day = ?')
    .bind(startsAt, duration, join, replay, hot, edited, now, cohortId, day).run();
  // The live engine holds the link the room hands out: a link changed (or cleared) here changes it there too.
  await upsertLiveEvent(rt, eventKey(cohortId, day), { startsAt, durationMin: duration, ...(body.join_url !== undefined ? { joinUrl: join } : {}) }).catch((e) => console.error('live event', String(e).slice(0, 200)));
  return { moved: startsAt !== cur.starts_at || duration !== cur.duration_min, replayAdded: !cur.replay_url && Boolean(replay) };
}

/** True once the cohort's last session is over (used to stop selling and for reports). */
export const cohortOver = (days: DayRow[], now: number) => days.length > 0 && days.every((d) => dayEnds(d) < now);

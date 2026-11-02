import type { Runtime } from '../app';
import { ASSETS, assetById, nextUnlock } from '../rooms/engage';
import { parseAutoPush } from '../rooms/state';
import { DAY_TITLES } from './content';
import { CohortError } from './cohorts';
import { type DayRow, DAYS_IN_CHALLENGE, HOUR, MIN, dayEnds, dayPhase, eventKey, localParts, wallTime } from './schedule';

/**
 * First Deal Challenge, round 2 (migration 0072):
 *  - Each day's automatic push schedule for our room. Days that run in our room get a sensible schedule by
 *    default, written into that room's own engage settings (the format the room already reads: "35 application",
 *    "40 deposit", "20 resource scripts"). The owner edits it per day in Funnel HQ → Challenge.
 *  - The owner's progress dashboard per cohort and per day, the drop-off between days and the at-risk list
 *    (a list for the team: nothing is sent from it).
 *  - The participant's tracker: real completion, the streak of days attended, today's worksheet with its real
 *    due time, and what unlocks next in the live room (the rooms engage rules and rows, read only).
 *  - The homework reminder switch (off unless the owner turns it on) and its send times inside sending hours.
 */

// ───────────── automatic pushes per day ─────────────

/**
 * Days 1 to 3: the resource that day's session works with. Day 4: the application, and the deposit preview only
 * if the host opens the offer (the room holds a deposit line until the offer is open). Day 5: the application,
 * then the deposit once the host opens the offer.
 */
export const DAY_AUTO_PUSH: Record<number, string> = {
  1: '20 resource calculator',
  2: '25 resource buybox',
  3: '30 resource scripts',
  4: '35 application\n50 deposit',
  5: '40 application\n55 deposit',
};
export const effectiveAutoPush = (day: number, stored: string | null | undefined) => (stored != null && stored.trim() ? stored : DAY_AUTO_PUSH[day] ?? '');

/** Checks and normalises an owner's schedule for one day. Blank = the day's default (null); "off" = no automatic pushes. */
export function cleanDayAutoPush(day: number, raw: unknown): string | null {
  const t = typeof raw === 'string' ? raw.trim().slice(0, 2000) : '';
  if (!t) return null;
  if (/^(off|none|no)$/i.test(t)) return 'off';
  const lines = t.split(/[\n;,]+/).map((x) => x.trim()).filter(Boolean);
  const items = parseAutoPush(t);
  if (items.length < lines.length) throw new CohortError('Write one push per line: a minute, then application, deposit, vip or resource with its name (for example "35 application" or "20 resource scripts")', 'auto_push');
  for (const it of items) {
    if (it.kind === 'resource' && !assetById(it.ref)) throw new CohortError(`Resources you can push: ${ASSETS.map((a) => a.id).join(', ')}`, 'auto_push');
    if (it.kind === 'deposit' && day < 4) throw new CohortError('The deposit can only be pushed on Days 4 and 5, once the offer is open', 'auto_push');
    if (it.kind === 'sprint') throw new CohortError('The Sprint isn’t sold inside the challenge', 'auto_push');
  }
  return items.map((it) => `${it.at} ${it.kind}${it.ref ? ` ${it.ref}` : ''}`).join('\n');
}

/**
 * Writes the day's schedule into its room's engage settings. Without `force` it only fills a room that has no
 * schedule of its own yet, so a schedule set on the room itself (Funnel HQ → Rooms) is never overwritten.
 */
export async function applyDayAutoPush(rt: Pick<Runtime, 'env'>, cohortId: string, day: number, text: string, o: { force?: boolean } = {}) {
  const room = await rt.env.DB.prepare("SELECT id, engage FROM rooms WHERE ref_type = 'challenge' AND ref_id = ?").bind(eventKey(cohortId, day)).first<{ id: string; engage: string | null }>();
  if (!room) return false;
  let cur: Record<string, unknown> = {};
  try { cur = JSON.parse(room.engage ?? '{}') ?? {}; } catch { cur = {}; }
  const had = typeof cur.autoPush === 'string' ? cur.autoPush : '';
  if ((!o.force && had.trim()) || had === text) return false;
  await rt.env.DB.prepare('UPDATE rooms SET engage = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify({ ...cur, autoPush: text }), Date.now(), room.id).run();
  return true;
}

/** What each day's room will push (the room's own schedule when it has one), for Funnel HQ. */
export async function dayAutoPushes(rt: Pick<Runtime, 'env'>, cohortId: string, days: Pick<DayRow, 'day' | 'auto_push'>[]) {
  const { results } = await rt.env.DB.prepare("SELECT ref_id, engage FROM rooms WHERE ref_type = 'challenge' AND ref_id LIKE ?").bind(`challenge:${cohortId}:%`).all<{ ref_id: string; engage: string | null }>();
  const inRoom = new Map(results.map((r) => {
    let o: { autoPush?: unknown } = {};
    try { o = JSON.parse(r.engage ?? '{}') ?? {}; } catch { o = {}; }
    return [r.ref_id, typeof o.autoPush === 'string' ? o.autoPush : ''];
  }));
  return days.map((d) => {
    const room = inRoom.get(eventKey(cohortId, d.day));
    return { day: d.day, saved: d.auto_push ?? null, default: DAY_AUTO_PUSH[d.day], effective: effectiveAutoPush(d.day, d.auto_push), room: room === undefined ? null : room };
  });
}

// ───────────── prefs (challenge_prefs) ─────────────

export interface ChallengePrefs { hwReminders: boolean; hwHours: { from: number; to: number } }
export const DEFAULT_HW_HOURS = { from: 9, to: 19 };
/** "9-19" (24 hour clock, the person's own time zone). */
export function parseHours(raw: unknown) {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(raw ?? ''));
  if (!m) return null;
  const from = Number(m[1]), to = Number(m[2]);
  return from >= 0 && to <= 24 && to - from >= 2 ? { from, to } : null;
}
export async function getPrefs(rt: Pick<Runtime, 'env'>): Promise<ChallengePrefs> {
  const { results } = await rt.env.DB.prepare('SELECT key, value FROM challenge_prefs').all<{ key: string; value: string }>().catch(() => ({ results: [] as { key: string; value: string }[] }));
  const m = new Map(results.map((r) => [r.key, r.value]));
  return { hwReminders: m.get('hw_reminders') === 'on', hwHours: parseHours(m.get('hw_hours')) ?? DEFAULT_HW_HOURS };
}
export async function savePrefs(rt: Pick<Runtime, 'env'>, body: Record<string, unknown>, now = Date.now()) {
  const stmts = [];
  if (typeof body.hwReminders === 'boolean') stmts.push(['hw_reminders', body.hwReminders ? 'on' : 'off']);
  if (body.hwHours !== undefined) {
    const h = parseHours(body.hwHours);
    if (!h) throw new CohortError('Sending hours look like 9-19 (at least two hours, 24 hour clock)', 'hwHours');
    stmts.push(['hw_hours', `${h.from}-${h.to}`]);
  }
  const db = rt.env.DB;
  if (stmts.length) await db.batch(stmts.map(([k, v]) => db.prepare('INSERT INTO challenge_prefs (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(k, v, now)));
  return getPrefs(rt);
}

// ───────────── homework: due time and the reminder ─────────────

/** A day's worksheet is due before the next session starts (Day 5: before the offer closes, else a day after it ends). */
export function homeworkDue(days: Pick<DayRow, 'day' | 'starts_at' | 'duration_min'>[], n: number, closeAt: number | null) {
  const next = days.find((d) => d.day === n + 1);
  if (next) return next.starts_at;
  const d = days.find((x) => x.day === n);
  if (!d) return null;
  return closeAt ?? dayEnds(d) + 24 * HOUR;
}

const hourIn = (t: number, tz: string) => { const p = localParts(t, tz); const [h, m] = p.time.split(':').map(Number); return h + m / 60; };
export const inSendingHours = (t: number, tz: string, h: { from: number; to: number }) => { const x = hourIn(t, tz); return x >= h.from && x < h.to; };

/**
 * When the reminder for one day goes: the first moment at least 4 hours after the session ends that falls in
 * the sending hours (the person's time zone), and at least 2 hours before the worksheet is due. Null when there
 * is no such moment (then no reminder for that day).
 */
export function hwReminderAt(days: Pick<DayRow, 'day' | 'starts_at' | 'duration_min'>[], n: number, closeAt: number | null, tz: string, hours: { from: number; to: number }) {
  const d = days.find((x) => x.day === n);
  const due = homeworkDue(days, n, closeAt);
  if (!d || due == null) return null;
  let t = dayEnds(d) + 4 * HOUR;
  if (!inSendingHours(t, tz, hours)) {
    // The next opening of the window: today's or tomorrow's start hour in that time zone.
    const p = localParts(t, tz);
    const [y, m, dd] = p.date.split('-').map(Number);
    const today = wallTime(y, m, dd, hours.from, 0, tz);
    const next = new Date(Date.UTC(y, m - 1, dd + 1));
    t = today > t ? today : wallTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hours.from, 0, tz);
  }
  return t <= due - 2 * HOUR ? t : null;
}

// ───────────── the participant's tracker ─────────────

type DayProg = { day: number; live: boolean; replay: boolean; homework: boolean };
type DayLike = Pick<DayRow, 'day' | 'starts_at' | 'duration_min'>;

/** Consecutive days attended (live or replay), counting back from the latest session that has ended (or is live and attended). */
export function attendanceStreak(days: DayLike[], prog: DayProg[], now: number) {
  const sorted = [...days].sort((a, b) => a.day - b.day);
  const attended = (n: number) => { const p = prog.find((x) => x.day === n); return Boolean(p && (p.live || p.replay)); };
  const counted = sorted.filter((d) => dayPhase(d, now) === 'ended' || (dayPhase(d, now) === 'live' && attended(d.day)));
  let n = 0;
  for (let i = counted.length - 1; i >= 0; i--) { if (!attended(counted[i].day)) break; n++; }
  return n;
}

/** A day is complete when they were there (live or replay) and their worksheet is in. */
export const dayComplete = (p: DayProg | undefined) => Boolean(p && (p.live || p.replay) && p.homework);

/**
 * Today's worksheet: the latest day whose worksheet is open (30 minutes before its session) and still due, or
 * done. Null before Day 1 opens and once every due time has passed.
 */
export function todaysHomework(days: DayLike[], prog: DayProg[], closeAt: number | null, now: number) {
  const open = [...days].sort((a, b) => b.day - a.day).filter((d) => now >= d.starts_at - 30 * MIN);
  for (const d of open) {
    const due = homeworkDue(days, d.day, closeAt);
    const done = Boolean(prog.find((x) => x.day === d.day)?.homework);
    if (done || (due != null && due > now)) return { day: d.day, title: DAY_TITLES[d.day - 1], due, done };
  }
  return null;
}

/**
 * What the person has unlocked in the cohort's live rooms and what unlocks next (the rooms' own rules and rows).
 * Null when no day of the cohort runs in our room.
 */
export async function participantUnlocks(rt: Pick<Runtime, 'env' | 'settings' | 'origin'>, reg: { id: string; lead_id: string; cohort_id: string }, fromDay: number | null) {
  const db = rt.env.DB;
  const { results: rooms } = await db.prepare("SELECT id, ref_id FROM rooms WHERE ref_type = 'challenge' AND ref_id LIKE ?").bind(`challenge:${reg.cohort_id}:%`).all<{ id: string; ref_id: string }>();
  if (!rooms.length) return null;
  const dayOfRoom = new Map(rooms.map((r) => [r.id, Number(/:(\d)$/.exec(r.ref_id)?.[1]) || 0]));
  const ids = rooms.map((r) => r.id);
  const marks = ids.map(() => '?').join(', ');
  const [pts, unl] = await db.batch([
    db.prepare(`SELECT room_id, COALESCE(SUM(points), 0) AS n FROM room_points WHERE reg_id = ? AND room_id IN (${marks}) GROUP BY room_id`).bind(reg.id, ...ids),
    db.prepare(`SELECT room_id, who, asset, at FROM room_unlocks WHERE lead_id = ? AND room_id IN (${marks}) ORDER BY at`).bind(reg.lead_id, ...ids),
  ]);
  const byRoom = new Map((pts.results as { room_id: string; n: number }[]).map((r) => [r.room_id, r.n]));
  const total = [...byRoom.values()].reduce((a, n) => a + n, 0);
  const { engageConfig, assetUrl } = await import('../rooms/engage-db');
  const rules = engageConfig(rt as Runtime).unlocks;
  const have: { id: string; title: string; url: string; day: number }[] = [];
  for (const u of unl.results as { room_id: string; who: string; asset: string }[]) {
    if (have.some((h) => h.id === u.asset) || !assetById(u.asset)) continue;
    have.push({ id: u.asset, title: assetById(u.asset)!.title, url: await assetUrl(rt, u.room_id, u.who, u.asset), day: dayOfRoom.get(u.room_id) ?? 0 });
  }
  // The next unlock in the room that matters next: the first room day from `fromDay` (the first session not over yet).
  const target = fromDay == null ? null : rooms.map((r) => ({ id: r.id, day: dayOfRoom.get(r.id) ?? 0 })).filter((r) => r.day >= fromDay).sort((a, b) => a.day - b.day)[0] ?? null;
  const roomPts = target ? byRoom.get(target.id) ?? 0 : 0;
  const nx = target ? nextUnlock(rules.filter((r) => !have.some((h) => h.id === r.asset)), roomPts) : null;
  const atEnd = target ? rules.filter((r) => r.at === 'end' && !have.some((h) => h.id === r.asset)).map((r) => assetById(r.asset)?.title).filter(Boolean) as string[] : [];
  return { total, have, next: nx && target ? { ...nx, day: target.day, points: roomPts } : null, endDay: target?.day ?? null, atEnd };
}

// ───────────── the owner's dashboard ─────────────

export interface ProgReg { id: string; lead_id: string; vip: number; paid_at: number | null; name: string; email: string | null; phone: string | null; app_completed_at?: number | null }
export interface ProgRow { reg_id: string; day: number; joined_at: number | null; present_at: number | null; replay_at: number | null; homework_at: number | null }

/** The day a moment belongs to: the latest session that had opened by then (from 30 minutes before its start). */
export function dayAt(days: DayLike[], ts: number) {
  const opened = [...days].sort((a, b) => a.day - b.day).filter((d) => ts >= d.starts_at - 30 * MIN);
  return opened.length ? opened[opened.length - 1].day : 0;
}

/** Pure maths over the cohort's rows (every number is a count of rows someone's action wrote). */
export function buildProgress(o: {
  days: DayLike[]; regs: ProgReg[]; progress: ProgRow[]; now: number;
  points: { reg_id: string; day: number; n: number }[];
  apps: { reg_id: string; ts: number }[];
  deposits: { reg_id: string; paid_at: number | null }[];
}) {
  const days = [...o.days].sort((a, b) => a.day - b.day);
  const ids = new Set(o.regs.map((r) => r.id));
  const vipIds = new Set(o.regs.filter((r) => r.vip).map((r) => r.id));
  const prog = (reg: string, day: number) => o.progress.find((p) => p.reg_id === reg && p.day === day);
  const live = (p?: ProgRow) => Boolean(p && (p.joined_at || p.present_at));
  const came = (p?: ProgRow) => Boolean(p && (p.joined_at || p.present_at || p.replay_at));
  // An application or deposit counts once per person, on the day it happened.
  const firstBy = (rows: { reg_id: string; ts: number }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) if (ids.has(r.reg_id) && (!m.has(r.reg_id) || r.ts < m.get(r.reg_id)!)) m.set(r.reg_id, r.ts);
    return m;
  };
  const apps = firstBy(o.apps.filter((a) => dayAt(days, a.ts) >= 1)); // before Day 1 opened is not the challenge's
  const deps = firstBy(o.deposits.filter((d) => d.paid_at).map((d) => ({ reg_id: d.reg_id, ts: d.paid_at! })));
  const perDay = days.map((d, i) => {
    const regsBy = o.regs.filter((r) => r.paid_at != null && r.paid_at <= dayEnds(d)).length;
    const rows = o.progress.filter((p) => p.day === d.day && ids.has(p.reg_id));
    const liveN = rows.filter(live).length;
    const replay = rows.filter((p) => !live(p) && p.replay_at).length;
    const homework = rows.filter((p) => p.homework_at).length;
    const prev = i > 0 ? days[i - 1] : null;
    const started = o.now >= d.starts_at;
    const prevCame = prev ? o.regs.filter((r) => came(prog(r.id, prev.day))) : [];
    const kept = prev ? prevCame.filter((r) => came(prog(r.id, d.day))).length : null;
    return {
      day: d.day, title: DAY_TITLES[d.day - 1], phase: dayPhase(d, o.now), registered: regsBy,
      live: liveN, replay, attended: liveN + replay, homework,
      vip: rows.filter((p) => vipIds.has(p.reg_id) && came(p)).length,
      points: o.points.filter((p) => p.day === d.day && ids.has(p.reg_id)).reduce((a, p) => a + p.n, 0),
      applications: [...apps.values()].filter((ts) => dayAt(days, ts) === d.day).length,
      deposits: [...deps.values()].filter((ts) => Math.min(Math.max(dayAt(days, ts), 1), DAYS_IN_CHALLENGE) === d.day).length,
      liveRate: regsBy && started ? liveN / regsBy : null,
      homeworkRate: liveN + replay ? homework / (liveN + replay) : null,
      // Drop-off: of the people at the day before (live or replay), how many came to this one (once it has started).
      fromPrev: prev && started ? { came: prevCame.length, kept: kept!, rate: prevCame.length ? kept! / prevCame.length : null } : null,
    };
  });
  // At risk, as of the latest session that has ended: missed it (no live, no replay) or no worksheet for it.
  const ended = days.filter((d) => dayEnds(d) < o.now);
  const ref = ended.length ? ended[ended.length - 1] : null;
  const atRisk = ref ? o.regs.filter((r) => r.paid_at != null && r.paid_at <= dayEnds(ref)).map((r) => {
    const p = prog(r.id, ref.day);
    const missed = !came(p);
    const noHomework = !p?.homework_at;
    const before = days.filter((d) => d.day < ref.day);
    const missedBefore = before.length > 0 && !came(prog(r.id, before[before.length - 1].day));
    const attendedDays = days.filter((d) => came(prog(r.id, d.day))).length;
    return { reg_id: r.id, lead_id: r.lead_id, name: r.name, email: r.email, phone: r.phone, vip: Boolean(r.vip), missed, noHomework, missedTwo: missed && missedBefore, attendedDays, deposit: deps.has(r.id) };
  }).filter((x) => (x.missed || x.noHomework) && !x.deposit).sort((a, b) => Number(b.missedTwo) - Number(a.missedTwo) || Number(b.missed) - Number(a.missed) || Number(b.vip) - Number(a.vip) || a.name.localeCompare(b.name)) : [];
  return {
    registered: o.regs.length, vip: vipIds.size,
    points: o.points.filter((p) => ids.has(p.reg_id)).reduce((a, p) => a + p.n, 0),
    applications: apps.size, deposits: deps.size,
    days: perDay,
    atRisk: { day: ref?.day ?? null, list: atRisk },
  };
}

/** Loads one cohort's rows and builds the dashboard. */
export async function cohortProgress(rt: Pick<Runtime, 'env'>, cohortId: string, days: DayLike[], closeAt: number | null, now = Date.now()) {
  const db = rt.env.DB;
  const like = `challenge:${cohortId}:%`;
  const [regs, progress, points, stages, deposits] = await db.batch([
    db.prepare(`SELECT r.id, r.lead_id, r.vip, r.paid_at, l.first_name, l.last_name, l.email, l.phone, l.app_completed_at FROM challenge_registrations r JOIN leads l ON l.id = r.lead_id WHERE r.cohort_id = ? AND r.status = 'paid'`).bind(cohortId),
    db.prepare('SELECT p.* FROM challenge_progress p JOIN challenge_registrations r ON r.id = p.reg_id WHERE r.cohort_id = ?').bind(cohortId),
    db.prepare(`SELECT p.reg_id, m.ref_id, COALESCE(SUM(p.points), 0) AS n FROM room_points p JOIN rooms m ON m.id = p.room_id WHERE m.ref_type = 'challenge' AND m.ref_id LIKE ? AND p.reg_id IS NOT NULL GROUP BY p.reg_id, m.ref_id`).bind(like),
    db.prepare(`SELECT s.reg_id, MIN(s.ts) AS ts FROM attr_stages s JOIN challenge_registrations r ON r.id = s.reg_id WHERE r.cohort_id = ? AND s.funnel = 'challenge' AND s.stage = 'room_application' GROUP BY s.reg_id`).bind(cohortId),
    db.prepare('SELECT reg_id, paid_at FROM challenge_deposits WHERE cohort_id = ?').bind(cohortId),
  ]);
  const regRows = (regs.results as (ProgReg & { first_name: string | null; last_name: string | null })[]).map((r) => ({ ...r, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || String(r.email ?? 'Someone') }));
  // Applications: inside the room, or on the application page while the challenge ran (after paying, before the offer closed).
  const d1 = days.find((d) => d.day === 1);
  const end = closeAt ?? (days.length ? dayEnds(days[days.length - 1]) + 48 * HOUR : 0);
  const apps = [
    ...(stages.results as { reg_id: string; ts: number }[]),
    ...regRows.filter((r) => r.app_completed_at && r.paid_at && d1 && r.app_completed_at >= Math.max(r.paid_at, d1.starts_at - 30 * MIN) && r.app_completed_at <= end).map((r) => ({ reg_id: r.id, ts: r.app_completed_at! })),
  ];
  return buildProgress({
    days, regs: regRows, progress: progress.results as ProgRow[], now,
    points: (points.results as { reg_id: string; ref_id: string; n: number }[]).map((p) => ({ reg_id: p.reg_id, day: Number(/:(\d)$/.exec(p.ref_id)?.[1]) || 0, n: p.n })),
    apps, deposits: deposits.results as { reg_id: string; paid_at: number | null }[],
  });
}

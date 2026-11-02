import { describe, expect, it } from 'vitest';
import type { Runtime } from '../src/app';
import { auditEmail, auditFields } from '../src/content/copy-rules';
import { SETTINGS } from '../src/settings';
import { TRACKER } from '../src/challenge/content';
import { createCohort, getReg, loadCohort, updateDay } from '../src/challenge/cohorts';
import { CH_CYCLE, CH_STEPS, CHALLENGE_TEMPLATES, challengeSkip, resyncHomeworkReminders, startChallengeMessages } from '../src/challenge/emails';
import {
  DAY_AUTO_PUSH, applyDayAutoPush, attendanceStreak, buildProgress, cleanDayAutoPush, cohortProgress, dayAt, dayAutoPushes, getPrefs, homeworkDue, hwReminderAt,
  inSendingHours, participantUnlocks, savePrefs, todaysHomework,
} from '../src/challenge/progress';
import { participantView } from '../src/challenge/room';
import { progressHtml } from '../src/challenge/pages';
import { HOUR, MIN, dayEnds, localParts, offerCloseAt, scheduleDays } from '../src/challenge/schedule';
import { parseAutoPush } from '../src/rooms/state';
import { roomEngageSettings } from '../src/rooms/engage-db';
import type { TemplateCtx } from '../src/integrations/templates';

// ───────────── A real SQLite database shaped like D1, every migration applied (same harness as challenge.test.ts) ─────────────
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };

function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const isRead = /^\s*(SELECT|WITH)\b/i.test(sql);
    const st = {
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => {
        if (isRead) return { results: db.prepare(sql).all(...norm()), meta: { changes: 0 } };
        const r = db.prepare(sql).run(...norm());
        return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { run: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}
const BASE = { SALES_TIMEZONE: 'America/New_York', SESSION_SECRET: 'test-secret' };
const makeRt = (db: DatabaseSync, settings: Record<string, string> = BASE) =>
  ({ env: { DB: d1(db), SESSION_SECRET: 'test-secret' }, settings: { ...Object.fromEntries(SETTINGS.map((d) => [d.key, ''])), ...settings }, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;
const DAY = 24 * HOUR;
const TZ = 'America/New_York';

async function setup(inMs = 2 * DAY) {
  const db = freshDb();
  const rt = makeRt(db);
  const start = Date.now() + inMs;
  const p = localParts(start, TZ);
  const id = await createCohort(rt, { name: 'Test cohort', start_date: p.date, start_time: p.time, timezone: TZ, duration_min: 90 }, Math.min(Date.now(), start - HOUR));
  return { db, rt, id };
}
async function paidReg(db: DatabaseSync, rt: Runtime, cohortId: string, o: { vip?: boolean; first?: string; tz?: string; paidAt?: number } = {}) {
  const now = o.paidAt ?? Date.now();
  const lead = `l_${Math.random().toString(36).slice(2, 8)}`;
  const reg = `cr_${Math.random().toString(36).slice(2, 8)}`;
  const token = `tok${Math.random().toString(36).slice(2, 12)}abcdefghij`;
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, status, revenue_band, timezone) VALUES (?, ?, ?, ?, ?, 'Lee', ?, 'partial', '3m-10m', ?)").run(lead, lead.slice(-6).toUpperCase(), now, now, o.first ?? 'Dana', `${lead}@example.com`, o.tz ?? null);
  db.prepare("INSERT INTO challenge_registrations (id, token, cohort_id, lead_id, seq, revenue_band, status, vip, created_at, paid_at) VALUES (?, ?, ?, ?, 0, '3m-10m', 'paid', ?, ?, ?)").run(reg, token, cohortId, lead, o.vip ? 1 : 0, now, now);
  return (await getReg(rt, token))!;
}
const prog = (db: DatabaseSync, reg: string, day: number, o: { live?: number; replay?: number; hw?: number }) =>
  db.prepare('INSERT INTO challenge_progress (reg_id, day, joined_at, replay_at, homework_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(reg_id, day) DO UPDATE SET joined_at = excluded.joined_at, replay_at = excluded.replay_at, homework_at = excluded.homework_at')
    .run(reg, day, o.live ?? null, o.replay ?? null, o.hw ?? null);

// ───────────── 1. automatic pushes per day ─────────────
describe('each challenge day gets an automatic push schedule in our room', () => {
  it('the defaults are valid room schedules: a resource on Days 1 to 3, the application and the deposit on Days 4 and 5', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(parseAutoPush(DAY_AUTO_PUSH[n]).length).toBe(DAY_AUTO_PUSH[n].split('\n').length);
    expect(parseAutoPush(DAY_AUTO_PUSH[1])).toEqual([{ id: '20:resource:calculator', at: 20, kind: 'resource', ref: 'calculator' }]);
    expect(parseAutoPush(DAY_AUTO_PUSH[3])[0]).toMatchObject({ kind: 'resource', ref: 'scripts' });
    expect(parseAutoPush(DAY_AUTO_PUSH[4]).map((x) => x.kind)).toEqual(['application', 'deposit']);
    expect(parseAutoPush(DAY_AUTO_PUSH[5]).map((x) => x.kind)).toEqual(['application', 'deposit']);
    for (const n of [1, 2, 3]) expect(DAY_AUTO_PUSH[n]).not.toMatch(/deposit|application/);
  });

  it('checks an owner edit: normalised lines, blank = default, off, and no deposit before Day 4', () => {
    expect(cleanDayAutoPush(2, '  ')).toBeNull();
    expect(cleanDayAutoPush(2, 'OFF')).toBe('off');
    expect(cleanDayAutoPush(4, '40 min: application\n15 resource buybox')).toBe('15 resource buybox\n40 application');
    expect(() => cleanDayAutoPush(2, '30 deposit')).toThrow(/Days 4 and 5/);
    expect(() => cleanDayAutoPush(2, '30 resource nonsense')).toThrow(/calculator/);
    expect(() => cleanDayAutoPush(2, 'thirty application')).toThrow(/one push per line/);
    expect(() => cleanDayAutoPush(5, '40 sprint')).toThrow(/Sprint/);
  });

  it('a day switched to our room gets its default; an edit in Funnel HQ replaces it; a room’s own schedule is kept otherwise', async () => {
    const { db, rt, id } = await setup();
    await updateDay(rt, id, 1, { platform: 'room' });
    const room1 = db.prepare("SELECT * FROM rooms WHERE ref_type = 'challenge' AND ref_id = ?").get(`challenge:${id}:1`) as { engage: string };
    expect(roomEngageSettings(room1 as never).autoPushRaw).toBe(DAY_AUTO_PUSH[1]);
    // Day 5 in the room, then the owner edits it.
    await updateDay(rt, id, 5, { platform: 'room' });
    await updateDay(rt, id, 5, { auto_push: '30 application\n45 deposit' });
    const r5 = () => roomEngageSettings(db.prepare("SELECT engage FROM rooms WHERE ref_id = ?").get(`challenge:${id}:5`) as never).autoPushRaw;
    expect(r5()).toBe('30 application\n45 deposit');
    // Someone sets the room's own schedule in Funnel HQ → Rooms: saving the day again (no schedule change) keeps it.
    const row = db.prepare("SELECT id, engage FROM rooms WHERE ref_id = ?").get(`challenge:${id}:5`) as { id: string; engage: string };
    db.prepare('UPDATE rooms SET engage = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.engage), autoPush: '10 vip', agenda: 'Kept' }), row.id);
    await updateDay(rt, id, 5, { replay_url: 'https://example.com/r5' });
    expect(r5()).toBe('10 vip');
    expect(JSON.parse((db.prepare("SELECT engage FROM rooms WHERE ref_id = ?").get(`challenge:${id}:5`) as { engage: string }).engage).agenda).toBe('Kept');
    expect(await applyDayAutoPush(rt, id, 5, '30 application', { force: false })).toBe(false);
    // Funnel HQ shows what each day will push and what the room holds.
    const L = (await loadCohort(rt, id))!;
    const view = await dayAutoPushes(rt, id, L.days);
    expect(view[0]).toMatchObject({ day: 1, saved: null, effective: DAY_AUTO_PUSH[1], room: DAY_AUTO_PUSH[1] });
    expect(view[1]).toMatchObject({ day: 2, room: null, effective: DAY_AUTO_PUSH[2] });
    expect(view[4]).toMatchObject({ saved: '30 application\n45 deposit', room: '10 vip' });
    // A bad schedule is refused before anything is saved.
    await expect(updateDay(rt, id, 2, { auto_push: '20 deposit' })).rejects.toThrow(/Days 4 and 5/);
  });
});

// ───────────── 2. the owner's dashboard ─────────────
describe('progress dashboard: per day, drop-off and who is at risk', () => {
  const T0 = Date.UTC(2026, 10, 9, 0, 0);
  const days = [1, 2, 3, 4, 5].map((n) => ({ day: n, starts_at: T0 + (n - 1) * DAY, duration_min: 90 }));
  const reg = (id: string, o: { vip?: number; paid?: number } = {}) => ({ id, lead_id: `l${id}`, vip: o.vip ?? 0, paid_at: o.paid ?? T0 - DAY, name: id.toUpperCase(), email: `${id}@x.test`, phone: null });
  const P = (reg_id: string, day: number, o: { live?: boolean; replay?: boolean; hw?: boolean }) => ({ reg_id, day, joined_at: o.live ? 1 : null, present_at: null, replay_at: o.replay ? 1 : null, homework_at: o.hw ? 1 : null });

  it('counts real rows per day, the drop-off between days and the at-risk list (as of the latest ended session)', () => {
    const now = dayEnds(days[1]) + HOUR; // Day 2 has ended, Day 3 is tomorrow
    const out = buildProgress({
      days, now,
      regs: [reg('a', { vip: 1 }), reg('b'), reg('c'), reg('d', { paid: T0 + DAY + 10 * MIN })],
      progress: [P('a', 1, { live: true, hw: true }), P('a', 2, { live: true, hw: true }), P('b', 1, { live: true, hw: true }), P('b', 2, { replay: true }), P('c', 1, { replay: true }), P('d', 2, { live: true, hw: true })],
      points: [{ reg_id: 'a', day: 1, n: 30 }, { reg_id: 'b', day: 1, n: 10 }, { reg_id: 'a', day: 2, n: 5 }, { reg_id: 'zz', day: 2, n: 99 }],
      apps: [{ reg_id: 'a', ts: days[1].starts_at + 40 * MIN }, { reg_id: 'a', ts: days[3].starts_at }, { reg_id: 'b', ts: T0 - 5 * DAY }],
      deposits: [{ reg_id: 'd', paid_at: dayEnds(days[4]) + 3 * HOUR }, { reg_id: 'c', paid_at: null }],
    });
    expect(out.registered).toBe(4);
    expect(out.vip).toBe(1);
    expect(out.points).toBe(45); // a stranger's room points are not counted
    expect(out.applications).toBe(1); // once per person, and only from Day 1 on
    expect(out.deposits).toBe(1);
    const [d1, d2] = out.days;
    expect(d1).toMatchObject({ registered: 3, live: 2, replay: 1, attended: 3, homework: 2, vip: 1, points: 40, applications: 0, fromPrev: null, phase: 'ended' });
    expect(d2).toMatchObject({ registered: 4, live: 2, replay: 1, homework: 2, points: 5, applications: 1 });
    expect(out.days[3].applications).toBe(0);
    expect(out.days[1].applications + out.days[0].applications + out.days[2].applications + out.days[3].applications + out.days[4].applications).toBe(1); // 'b' applied before the challenge
    expect(out.days[1].applications).toBe(1);
    expect(out.days[4].deposits).toBe(1); // after Day 5 belongs to Day 5
    expect(d2.fromPrev).toEqual({ came: 3, kept: 2, rate: 2 / 3 }); // c came to Day 1 (replay) but not Day 2
    expect(out.atRisk.day).toBe(2);
    const risk = Object.fromEntries(out.atRisk.list.map((x) => [x.reg_id, x]));
    expect(Object.keys(risk).sort()).toEqual(['b', 'c']);
    expect(risk.c).toMatchObject({ missed: true, noHomework: true, missedTwo: false, attendedDays: 1 });
    expect(risk.b).toMatchObject({ missed: false, noHomework: true });
    expect(out.atRisk.list[0].reg_id).toBe('c'); // missed first
    // Before any session ends nobody is at risk.
    expect(buildProgress({ days, now: T0 - HOUR, regs: [reg('a')], progress: [], points: [], apps: [], deposits: [] }).atRisk).toEqual({ day: null, list: [] });
    expect(dayAt(days, T0 - HOUR)).toBe(0);
    expect(dayAt(days, T0 + 2 * DAY + 5 * HOUR)).toBe(3);
  });

  it('reads the cohort from the database: room points by day, applications in the room or on the application page, paid deposits', async () => {
    const { db, rt, id } = await setup(-(DAY + 2 * HOUR) + 30 * MIN); // Day 1 started 25.5 hours ago
    const L = (await loadCohort(rt, id))!;
    const d1 = L.days[0];
    const a = await paidReg(db, rt, id, { vip: true, first: 'Ana', paidAt: d1.starts_at - DAY });
    const b = await paidReg(db, rt, id, { first: 'Ben', paidAt: d1.starts_at - DAY });
    prog(db, a.id, 1, { live: d1.starts_at, hw: dayEnds(d1) });
    db.prepare("INSERT INTO rooms (id, mode, title, ref_type, ref_id, created_at, updated_at) VALUES ('rm1', 'webinar', 'D1', 'challenge', ?, 0, 0)").run(`challenge:${id}:1`);
    db.prepare("INSERT INTO room_points (room_id, who, action, key, points, lead_id, reg_id, at) VALUES ('rm1', 'reg:a', 'on_time', '1', 10, ?, ?, 0), ('rm1', 'reg:a', 'poll', '1', 5, ?, ?, 0)").run(a.lead_id, a.id, a.lead_id, a.id);
    db.prepare("INSERT INTO attr_stages (id, funnel, stage, lead_id, reg_id, cohort_ref, ts, source) VALUES ('x1', 'challenge', 'room_application', ?, ?, ?, ?, 'room')").run(a.lead_id, a.id, id, d1.starts_at + 40 * MIN);
    db.prepare('UPDATE leads SET app_completed_at = ? WHERE id = ?').run(d1.starts_at + 50 * MIN, b.lead_id);
    db.prepare("INSERT INTO challenge_deposits (reg_id, cohort_id, lead_id, started_at, paid_at, amount, currency) VALUES (?, ?, ?, 1, NULL, 500000, 'usd')").run(b.id, id, b.lead_id);
    const out = await cohortProgress(rt, id, L.days, L.closeAt, dayEnds(d1) + HOUR);
    expect(out.days[0]).toMatchObject({ registered: 2, live: 1, homework: 1, vip: 1, points: 15, applications: 2 });
    expect(out.deposits).toBe(0); // started, not paid
    expect(out.atRisk.list.map((x) => x.name)).toEqual(['Ben Lee']);
  });
});

// ───────────── 3. the participant's tracker ─────────────
describe('attendee progress page: tracker, streak, today’s worksheet with its real due time, unlocks', () => {
  const T0 = Date.UTC(2026, 10, 9, 0, 0);
  const days = [1, 2, 3, 4, 5].map((n) => ({ day: n, starts_at: T0 + (n - 1) * DAY, duration_min: 90 }));
  const close = offerCloseAt(days, 48)!;

  it('the streak counts consecutive attended days back from the latest ended session', () => {
    const p = (n: number, live: boolean, replay = false) => ({ day: n, live, replay, homework: false });
    const after3 = dayEnds(days[2]) + HOUR;
    expect(attendanceStreak(days, [p(1, true), p(2, false, true), p(3, true)], after3)).toBe(3);
    expect(attendanceStreak(days, [p(1, true), p(2, false), p(3, true)], after3)).toBe(1);
    expect(attendanceStreak(days, [p(1, true), p(2, true), p(3, false)], after3)).toBe(0);
    // Day 4 live now and attended: it counts; not attended yet: the streak to Day 3 stands.
    expect(attendanceStreak(days, [p(1, true), p(2, true), p(3, true), p(4, true)], days[3].starts_at + 10 * MIN)).toBe(4);
    expect(attendanceStreak(days, [p(1, true), p(2, true), p(3, true)], days[3].starts_at + 10 * MIN)).toBe(3);
  });

  it('a worksheet is due when the next session starts (Day 5: when the offer closes); today’s is the latest still open', () => {
    expect(homeworkDue(days, 1, close)).toBe(days[1].starts_at);
    expect(homeworkDue(days, 5, close)).toBe(close);
    expect(homeworkDue(days, 5, null)).toBe(dayEnds(days[4]) + DAY);
    expect(todaysHomework(days, [], close, T0 - HOUR)).toBeNull(); // before Day 1 opens
    expect(todaysHomework(days, [], close, T0 - 20 * MIN)).toMatchObject({ day: 1, due: days[1].starts_at, done: false });
    const noon2 = days[1].starts_at - 6 * HOUR;
    expect(todaysHomework(days, [{ day: 1, live: true, replay: false, homework: false }], close, noon2)).toMatchObject({ day: 1, done: false });
    expect(todaysHomework(days, [{ day: 1, live: true, replay: false, homework: true }], close, noon2)).toMatchObject({ day: 1, done: true });
    expect(todaysHomework(days, [], close, close + HOUR)).toBeNull();
  });

  it('renders the tracker with real completion, the streak, the due time and the room unlocks; copy passes the rules', () => {
    const now = days[1].starts_at - 6 * HOUR;
    const vdays = days.map((d, i) => ({ ...d, phase: i === 0 ? 'ended' : 'upcoming', progress: { day: d.day, live: i === 0, replay: false, homework: false } }));
    const html = progressHtml({ days: vdays as never, progress: { days: [], attended: 1, live: 1, homework: 0 } }, {
      token: 'tok', tz: 'UTC', now, streak: 1, dueOffer: true,
      today: { day: 1, title: 'Your acquisition capacity', due: days[1].starts_at, done: false },
      unlocks: { total: 35, have: [{ id: 'calculator', title: 'The 1.5x deal calculator', url: 'https://apply.test/rooms/a/x', day: 1 }], next: { asset: 'scripts', at: 60, title: 'The owner outreach scripts', day: 2, points: 0 }, endDay: 2, atEnd: ['The first-deal checklist'] },
    });
    expect(html).toContain('1 of 5 sessions · 0 of 5 worksheets');
    expect(html).toContain(`aria-valuenow="0"`);
    expect(html).toContain('<strong>1</strong> day in a row attended');
    expect(html).toContain('Attended, worksheet open');
    expect(html).toContain('Due before Day 2 starts');
    expect(html).toContain(`data-countdown="${days[1].starts_at}"`);
    expect(html).toContain('/challenge/day/tok/1#worksheet');
    expect(html).toContain('The owner outreach scripts unlocks at 60 points in the Day 2 room. You have 0.');
    expect(html).toContain('https://apply.test/rooms/a/x');
    // Complete = there + worksheet.
    const all = progressHtml({ days: vdays.map((d) => ({ ...d, phase: 'ended', progress: { ...d.progress, live: true, homework: true } })) as never, progress: { days: [], attended: 5, live: 5, homework: 5 } });
    expect(all).toContain('aria-valuenow="5"');
    expect((all.match(/chx-pg-i att hw done/g) ?? []).length).toBe(5);
    expect(auditFields({ TRACKER })).toEqual([]);
    expect(JSON.stringify(TRACKER)).not.toMatch(/—|!/);
  });

  it('unlocks come from the room’s own rows and rules; none without a room day', async () => {
    const { db, rt, id } = await setup();
    const reg = await paidReg(db, rt, id);
    expect(await participantUnlocks(rt, reg, 1)).toBeNull();
    await updateDay(rt, id, 1, { platform: 'room' });
    await updateDay(rt, id, 2, { platform: 'room' });
    const rooms = db.prepare("SELECT id, ref_id FROM rooms WHERE ref_type = 'challenge' ORDER BY ref_id").all() as { id: string }[];
    db.prepare("INSERT INTO room_points (room_id, who, action, key, points, lead_id, reg_id, at) VALUES (?, 'reg:x', 'present_10', '1', 30, ?, ?, 0)").run(rooms[0].id, reg.lead_id, reg.id);
    db.prepare("INSERT INTO room_unlocks (room_id, who, asset, source, lead_id, at) VALUES (?, 'reg:x', 'calculator', 'points', ?, 1)").run(rooms[0].id, reg.lead_id);
    db.prepare("INSERT INTO room_points (room_id, who, action, key, points, lead_id, reg_id, at) VALUES (?, 'reg:x', 'on_time', '1', 10, ?, ?, 0)").run(rooms[1].id, reg.lead_id, reg.id);
    const u = (await participantUnlocks(rt, reg, 2))!;
    expect(u.total).toBe(40);
    expect(u.have.map((h) => h.id)).toEqual(['calculator']);
    expect(u.have[0].url).toMatch(/^https:\/\/apply\.test\/rooms\/a\//);
    expect(u.next).toMatchObject({ asset: 'scripts', at: 60, day: 2, points: 10 });
    expect(u.atEnd).toEqual(['The first-deal checklist']);
    // The hub renders it for this person.
    const v = (await participantView(rt, reg))!;
    expect(v.days.filter((d) => d.join_url === 'room')).toHaveLength(2);
  });
});

// ───────────── 4. homework reminders ─────────────
describe('homework reminder: off by default, attended live and no worksheet, sending hours, consent', () => {
  it('times: at least 4 hours after the session, inside sending hours in their zone, 2 hours before the due time', () => {
    const t = scheduleDays('2026-11-09', '19:00', TZ);
    const days = t.map((s, i) => ({ day: i + 1, starts_at: s, duration_min: 90 }));
    const h = { from: 9, to: 19 };
    const at = hwReminderAt(days, 1, null, TZ, h)!;
    expect(localParts(at, TZ)).toEqual({ date: '2026-11-10', time: '09:00' }); // 8:30 pm + 4 h = 00:30, so 9 am next day
    expect(inSendingHours(at, TZ, h)).toBe(true);
    // A morning session: 4 hours after it ends is inside the window the same day.
    const m = scheduleDays('2026-11-09', '08:00', TZ).map((s, i) => ({ day: i + 1, starts_at: s, duration_min: 90 }));
    expect(localParts(hwReminderAt(m, 1, null, TZ, h)!, TZ)).toEqual({ date: '2026-11-09', time: '13:30' });
    // No moment that fits (sending hours end before the session is 4 hours old and the next day starts early): none.
    const e = scheduleDays('2026-11-09', '07:00', TZ).map((s, i) => ({ day: i + 1, starts_at: s, duration_min: 90 }));
    expect(hwReminderAt(e, 1, null, TZ, { from: 9, to: 11 })).toBeNull();
    // Day 5 is due when the offer closes.
    expect(hwReminderAt(days, 5, offerCloseAt(days, 48), TZ, h)).not.toBeNull();
  });

  it('nothing is scheduled while the switch is off (the default); on schedules it; off again cancels; skip rules at send time', async () => {
    const { db, rt, id } = await setup(2 * DAY);
    const reg = await paidReg(db, rt, id, { tz: 'America/Chicago' });
    expect((await getPrefs(rt)).hwReminders).toBe(false);
    await startChallengeMessages(rt, reg.id);
    const hwRows = () => db.prepare("SELECT template, send_at, status FROM emails WHERE lead_id = ? AND template LIKE 'ch_d%_hw' ORDER BY template").all(reg.lead_id) as { template: string; send_at: number; status: string }[];
    expect(hwRows()).toEqual([]);
    expect(CH_STEPS.length).toBeLessThanOrEqual(CH_CYCLE);
    await expect(savePrefs(rt, { hwHours: '18-19' })).rejects.toThrow(/9-19/);
    await savePrefs(rt, { hwReminders: true, hwHours: '9-19' });
    const n = await resyncHomeworkReminders(rt, true);
    expect(n).toBe(5);
    const rows = hwRows();
    expect(rows.map((r) => r.template)).toEqual(['ch_d1_hw', 'ch_d2_hw', 'ch_d3_hw', 'ch_d4_hw', 'ch_d5_hw']);
    for (const r of rows) expect(inSendingHours(r.send_at, 'America/Chicago', { from: 9, to: 19 })).toBe(true);
    // Each sits in the registration's step block (the sequence engine maps it back by cycle).
    const steps = db.prepare("SELECT step FROM emails WHERE lead_id = ? AND template = 'ch_d1_hw'").get(reg.lead_id) as { step: number };
    expect(CH_STEPS[steps.step % CH_CYCLE]).toBe('ch_d1_hw');
    // Send-time rules.
    const lead = () => db.prepare('SELECT * FROM leads WHERE id = ?').get(reg.lead_id) as never;
    const skip = challengeSkip('ch_d1_hw');
    expect(await skip(rt, lead())).toBe(true); // didn't attend
    prog(db, reg.id, 1, { replay: 1 });
    expect(await skip(rt, lead())).toBe(true); // replay only is not "attended live"
    prog(db, reg.id, 1, { live: 1 });
    const inHours = inSendingHours(Date.now(), 'America/Chicago', { from: 9, to: 19 });
    expect(await skip(rt, lead())).toBe(!inHours); // attended live, no worksheet: sent inside sending hours only
    await savePrefs(rt, { hwHours: '0-24' });
    expect(await skip(rt, lead())).toBe(false);
    prog(db, reg.id, 1, { live: 1, hw: 2 });
    expect(await skip(rt, lead())).toBe(true); // worksheet in
    prog(db, reg.id, 1, { live: 1 });
    await savePrefs(rt, { hwReminders: false });
    expect(await skip(rt, lead())).toBe(true); // switched off after scheduling
    await resyncHomeworkReminders(rt, false);
    expect(hwRows().every((r) => r.status === 'cancelled')).toBe(true);
    // Unsubscribed people get nothing scheduled.
    await savePrefs(rt, { hwReminders: true });
    db.prepare('UPDATE leads SET unsubscribed_at = 1 WHERE id = ?').run(reg.lead_id);
    db.prepare("DELETE FROM emails WHERE lead_id = ?").run(reg.lead_id);
    await resyncHomeworkReminders(rt, true);
    expect(hwRows()).toEqual([]);
  });

  it('the reminder copy renders and passes the email audit, and links to the worksheet on their day page', () => {
    const link = (p: string) => `https://apply.test${p}`;
    const ctx = { lead: {}, name: 'Dana', siteName: 'G&L', link, bookingUrl: null, whatsappUrl: null, callTime: null } as unknown as TemplateCtx;
    for (const n of [1, 2, 3, 4, 5]) {
      const e = CHALLENGE_TEMPLATES[`ch_d${n}_hw`](ctx);
      expect(auditEmail(e), `ch_d${n}_hw`).toEqual([]);
      expect(JSON.stringify(e)).not.toMatch(/—|zoom\.us/);
      expect(e.cta?.href).toMatch(/#worksheet$/);
    }
  });
});

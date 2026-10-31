import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy, auditEmail } from '../src/content/copy-rules';
import { getLead } from '../src/funnel/leads';
import { approveAction, getAction, rejectAction } from '../src/ops/actions';
import { GUARANTEE_BODY, GUARANTEE_HEADLINE, MONEY_BACK_BODY, MONEY_BACK_HEADLINE } from '../src/sales/guarantee';
import { type Segment, SEGMENTS, buildAudience, cleanRules } from '../src/winback/audience';
import {
  START_KIND, createCampaign, getCampaign, nextTiming, previewCampaign, processWinback, proposeStart, renderStep, sendTest, setPaused, stopCampaign, updateCampaign,
} from '../src/winback/campaigns';
import { planFor } from '../src/winback/copy';
import { resolveDestination } from '../src/winback/destination';

// ───────────── A real SQLite database shaped like D1, with every migration applied ─────────────

interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };

function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const st = {
      sql,
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => { const r = db.prepare(sql).run(...norm()); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}
const BASE: Record<string, string> = { SALES_TIMEZONE: 'UTC', SITE_NAME: 'G&L', EMAIL_PERSONALIZE: 'off', EMAIL_REPLY_TO: 'owner@gl.test' };
const makeRt = (db: DatabaseSync, s: Record<string, string> = {}) =>
  ({ env: { DB: d1(db) }, settings: { ...BASE, ...s }, reps: [], origin: 'https://apply.test', waitUntil: () => undefined }) as unknown as Runtime;
afterEach(() => { vi.unstubAllGlobals(); });

const DAY = 86_400_000;
const NOW = Date.now();
const ALL_DAY = { window_from: 0, window_to: 24 };
const count = (db: DatabaseSync, sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

const ANSWERS = {
  full: JSON.stringify({ business: 'Harbour Dental', revenue: '3_10m', goal: 'acquire', timeline: '6_12', blockers: ['funding'], why_now: 'Two competitors nearby want to retire and I want to be the buyer' }),
  goal: JSON.stringify({ goal: 'group', timeline: 'exploring', blockers: ['deal_flow'], revenue: '1_3m' }),
  none: '{}',
};

/** One lead per rule, each with a known fate. */
function seed(db: DatabaseSync) {
  const ins = db.prepare(`INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, status, tier, answers, industry, app_completed_at, booked_at, booking_cancelled_at, unsubscribed_at)
    VALUES (?, ?, ?, ?, ?, 'Lee', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const at = (d: number) => NOW - d * DAY;
  // id, created, first, email, status, tier, answers, industry, app_completed, booked, cancelled, unsub
  ins.run('lost1', 'L1', at(200), at(120), 'Dana', 'dana@example.com', 'lost', 'A', ANSWERS.full, 'dental', at(200), at(190), null, null);
  ins.run('ns1', 'L2', at(150), at(90), 'Sam', 'sam@example.com', 'no_show', 'B', ANSWERS.goal, null, at(150), at(140), null, null);
  ins.run('can1', 'L3', at(130), at(100), 'Ari', 'ari@example.com', 'booked', 'B', ANSWERS.none, null, at(130), at(125), at(100), null);
  ins.run('app1', 'L4', at(90), at(80), 'Kim', 'kim@example.com', 'applied', 'C', ANSWERS.goal, null, at(80), null, null, null);
  ins.run('reg1', 'L5', at(110), at(110), 'Noa', 'noa@example.com', 'partial', null, ANSWERS.none, null, null, null, null, null);
  ins.run('tix1', 'L6', at(100), at(100), 'Max', 'max@example.com', 'partial', null, ANSWERS.none, null, null, null, null, null);
  ins.run('recent', 'L7', at(200), at(10), 'Ivy', 'ivy@example.com', 'lost', 'A', ANSWERS.full, null, at(200), at(190), null, null);
  ins.run('unsub', 'L8', at(200), at(100), 'Lou', 'lou@example.com', 'lost', 'A', ANSWERS.none, null, at(200), at(190), null, at(95));
  ins.run('bounce', 'L9', at(200), at(100), 'Bo', 'bounced@example.com', 'lost', 'A', ANSWERS.none, null, at(200), at(190), null, null);
  ins.run('buyer', 'L10', at(200), at(100), 'Pat', 'pat@example.com', 'lost', 'A', ANSWERS.none, null, at(200), at(190), null, null);
  ins.run('client', 'L11', at(200), at(100), 'Cy', 'cy@example.com', 'lost', 'A', ANSWERS.none, null, at(200), at(190), null, null);
  ins.run('react', 'L12', at(200), at(100), 'Rae', 'rae@example.com', 'lost', 'A', ANSWERS.none, null, at(200), at(190), null, null);
  ins.run('won1', 'L13', at(200), at(100), 'Wes', 'wes@example.com', 'won', 'A', ANSWERS.none, null, at(200), at(190), null, null);
  db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at) VALUES ('wr1', 'tok-reg1-aaaaaaaaaa', 'ws1', 'reg1', ?)").run(at(110));
  db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at) VALUES ('wr2', 'tok-tix1-aaaaaaaaaa', 'ws1', 'tix1', ?)").run(at(100));
  db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES ('p1', 'wr2', 'tix1', 'seat', 'paid', 10000, 'usd', ?, ?, ?)").run(at(100), at(100), at(100));
  db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES ('p2', 'x', 'buyer', 'offer', 'paid', 300000, 'usd', ?, ?, ?)").run(at(150), at(150), at(150));
  db.prepare("INSERT INTO email_suppressions (email, reason, created_at) VALUES ('bounced@example.com', 'bounced', ?)").run(at(99));
  db.prepare("INSERT INTO cs_clients (lead_id, client_type, since_at, created_at, updated_at) VALUES ('client', 'sprint', ?, ?, ?)").run(at(150), at(150), at(150));
  db.prepare("INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, sent_at, created_at) VALUES ('re1', 'react', 'reactivation', 0, 'react_1', 'rae@example.com', ?, 'sent', ?, ?)").run(at(10), at(10), at(10));
  db.prepare("INSERT INTO events (id, ts, name, lead_id, source) VALUES ('ev1', ?, 'page_view', 'recent', 'server')").run(at(10));
  db.prepare("INSERT INTO events (id, ts, name, lead_id, source) VALUES ('ev2', ?, 'email_sent', 'lost1', 'cron')").run(at(5)); // our own sends are not activity
}
const ALL: Segment[] = Object.keys(SEGMENTS) as Segment[];

function seedLive(db: DatabaseSync, startsIn = 10 * DAY) {
  db.prepare("INSERT INTO live_webinars (id, title, starts_at, tz, duration_min, status, created_at, updated_at) VALUES ('le1', 'Buy your first competitor', ?, 'UTC', 120, 'scheduled', ?, ?)").run(NOW + startsIn, NOW, NOW);
}
function seedCohort(db: DatabaseSync, startsIn = 20 * DAY) {
  db.prepare("INSERT INTO challenge_cohorts (id, name, start_date, start_time, timezone, duration_min, status, created_at, updated_at) VALUES ('co1', 'December cohort', '2026-12-01', '19:00', 'UTC', 90, 'scheduled', ?, ?)").run(NOW, NOW);
  for (let d = 1; d <= 5; d++) db.prepare('INSERT INTO challenge_days (cohort_id, day, starts_at, duration_min, updated_at) VALUES (?, ?, ?, 90, ?)').run('co1', d, NOW + startsIn + (d - 1) * DAY, NOW);
}

/** Draft → test → proposal → owner approval. Returns the campaign id. */
async function approved(rt: Runtime, body: Record<string, unknown>) {
  const c = await createCampaign(rt, { name: 'Autumn win-back', ...ALL_DAY, ...body });
  await sendTest(rt, c.id, null);
  const { actionId } = await proposeStart(rt, c.id);
  const r = await approveAction(rt, actionId, 'you');
  expect(r.ok, r.summary).toBe(true);
  return c.id;
}

// ───────────── 1. Segment rules and exclusions ─────────────

describe('win-back audience', () => {
  it('matches each segment once and leaves out buyers, clients, unsubscribes, bounces, recent activity and recent reactivation', async () => {
    const db = freshDb(); seed(db);
    const rt = makeRt(db);
    const a = await buildAudience(rt, { rules: cleanRules({ segments: ALL, minDays: 60 }), destination: 'masterclass', destRef: null });
    const seg = Object.fromEntries(a.rows.map((r) => [r.id, r.segment]));
    expect(seg).toEqual({ lost1: 'lost', ns1: 'no_show', can1: 'cancelled', app1: 'applied', reg1: 'registered' });
    // tix1 holds a Masterclass ticket already, so it's left out of a Masterclass campaign (and in for the live webinar).
    const why = Object.fromEntries(a.excluded.map((e) => [e.reason, e.sample]));
    expect(why['Already registered for this destination']).toEqual(['Max Lee']);
    expect(why['Active in the last 60 days']).toEqual(['Ivy Lee']);
    expect(why.Unsubscribed).toEqual(['Lou Lee']);
    expect(why.Bounced).toEqual(['Bo Lee']);
    expect(why['Bought (Sprint, deposit or engagement)']).toEqual(['Pat Lee']);
    expect(why.Client).toEqual(['Cy Lee']);
    expect(why['Reactivation or win-back email in the last 30 days']).toEqual(['Rae Lee']);
    expect(a.rows.some((r) => r.id === 'won1')).toBe(false);
    seedLive(db);
    const live = await buildAudience(rt, { rules: cleanRules({ segments: ['ticket_no_sprint'], minDays: 60 }), destination: 'live', destRef: 'le1' });
    expect(live.rows.map((r) => r.id)).toEqual(['tix1']);
  });

  it('filters by age, tier, revenue band and the reactivation window', async () => {
    const db = freshDb(); seed(db);
    const rt = makeRt(db);
    const ids = async (rules: Record<string, unknown>) => (await buildAudience(rt, { rules: cleanRules({ segments: ALL, ...rules }), destination: 'masterclass', destRef: null })).rows.map((r) => r.id).sort();
    // ns1's last activity is its booking 140 days ago (a status change by the team is not their activity).
    expect(await ids({ minDays: 100 })).toEqual(['can1', 'lost1', 'ns1', 'reg1']);
    expect(await ids({ minDays: 60, tiers: ['A'] })).toEqual(['lost1']);
    expect(await ids({ minDays: 60, tiers: ['none'] })).toEqual(['reg1']);
    expect(await ids({ minDays: 60, bands: ['3_10m'] })).toEqual(['lost1']);
    expect(await ids({ minDays: 60, bands: ['1_3m'] })).toEqual(['app1', 'ns1']);
    expect(await ids({ minDays: 60, recentDays: 0 })).toContain('react');
    expect(await ids({ minDays: 60, maxDays: 95 })).toEqual(['app1']);
  });
});

// ───────────── 2. Nothing sends while off ─────────────

describe('nothing sends until the owner starts it', () => {
  it('a cron run with every campaign off (draft, proposed, paused, stopped) sends zero', async () => {
    const db = freshDb(); seed(db);
    const rt = makeRt(db, { RESEND_API_KEY: 're_test', EMAIL_FROM: 'Josh <josh@gl.test>' });
    const fetch = vi.fn(async () => new Response('{"id":"x"}'));
    vi.stubGlobal('fetch', fetch);
    // No campaigns at all.
    expect(await processWinback(rt)).toMatchObject({ campaigns: 0, sent: 0 });
    // A draft, even with people enrolled by hand.
    const c = await createCampaign(rt, { ...ALL_DAY, rules: { segments: ALL, minDays: 60 } });
    db.prepare("INSERT INTO winback_enrollments (campaign_id, lead_id, segment, status, next_step, next_at, enrolled_at) VALUES (?, 'lost1', 'lost', 'active', 0, ?, ?)").run(c.id, NOW - DAY, NOW - DAY);
    expect(await processWinback(rt)).toMatchObject({ sent: 0, simulated: 0 });
    // Proposed, waiting for approval.
    await sendTest(rt, c.id, null);
    fetch.mockClear();
    const { actionId } = await proposeStart(rt, c.id);
    expect((await getCampaign(rt, c.id))!.status).toBe('proposed');
    expect(await processWinback(rt)).toMatchObject({ sent: 0, simulated: 0 });
    // Marked running by hand without an approval: still nothing.
    db.prepare("UPDATE winback_campaigns SET status = 'running' WHERE id = ?").run(c.id);
    expect(await processWinback(rt)).toMatchObject({ sent: 0, simulated: 0 });
    db.prepare("UPDATE winback_campaigns SET status = 'proposed' WHERE id = ?").run(c.id);
    // Rejected in Command: back to draft, nothing sent.
    await rejectAction(rt, actionId, 'you');
    await expect(updateCampaign(rt, c.id, { name: 'Edited' })).resolves.toMatchObject({ status: 'draft' });
    expect(await processWinback(rt)).toMatchObject({ sent: 0, simulated: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(count(db, "SELECT COUNT(*) AS n FROM emails WHERE sequence = 'winback'")).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM winback_sends')).toBe(0);
  });

  it('a start needs a test first, and never runs on auto even when sales actions are set to auto', async () => {
    const db = freshDb(); seed(db);
    const rt = makeRt(db, { OPS_AUTO_KINDS: 'sales.*,*' });
    const c = await createCampaign(rt, { ...ALL_DAY, rules: { segments: ALL, minDays: 60 } });
    await expect(proposeStart(rt, c.id)).rejects.toThrow('Send yourself a test first.');
    const t = await sendTest(rt, c.id, null);
    expect(t).toMatchObject({ to: 'owner@gl.test', simulated: true, emails: 5 });
    const { actionId } = await proposeStart(rt, c.id);
    const a = (await getAction(rt, actionId))!;
    expect(a).toMatchObject({ kind: START_KIND, risk: 'high', status: 'proposed', dept: 'sales' });
    expect((await getCampaign(rt, c.id))!.status).toBe('proposed');
    expect(await processWinback(rt)).toMatchObject({ sent: 0, simulated: 0 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM winback_enrollments')).toBe(0);
  });
});

// ───────────── 3. Approval starts it; links carry the win-back UTMs ─────────────

describe('approval starts the campaign', () => {
  it('enrols the audience on approval and the cron sends tracked, attributed emails', async () => {
    const db = freshDb(); seed(db); seedLive(db);
    const rt = makeRt(db, { RESEND_API_KEY: 're_test', EMAIL_FROM: 'Josh <josh@gl.test>' });
    const sent: { to: string[]; subject: string; html: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => { sent.push(JSON.parse(init.body)); return new Response('{"id":"re_1"}'); }));
    const id = await approved(rt, { destination: 'live', dest_ref: 'le1', rules: { segments: ['lost', 'no_show'], minDays: 60 } });
    const c = (await getCampaign(rt, id))!;
    expect(c).toMatchObject({ status: 'running', approved_by: 'you' });
    expect(count(db, 'SELECT COUNT(*) AS n FROM winback_enrollments WHERE campaign_id = ?', id)).toBe(2);
    sent.length = 0; // the test emails
    const r = await processWinback(rt);
    expect(r.sent).toBe(2);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['dana@example.com', 'sam@example.com']);
    const html = decodeURIComponent(sent[0].html.replace(/&amp;/g, '&'));
    expect(html).toContain('/r/');
    expect(html).toContain('utm_source=email');
    expect(html).toContain('utm_medium=winback');
    expect(html).toContain(`utm_campaign=${id}`);
    expect(count(db, "SELECT COUNT(*) AS n FROM emails WHERE sequence = 'winback' AND status = 'sent'")).toBe(2);
    // The next email waits gap_days.
    expect(await processWinback(rt)).toMatchObject({ sent: 0 });
  });

  it('pause holds every send, resume continues, stop ends it for good', async () => {
    const db = freshDb(); seed(db);
    const rt = makeRt(db);
    const id = await approved(rt, { rules: { segments: ['lost'], minDays: 60 } });
    await setPaused(rt, id, true);
    expect(await processWinback(rt)).toMatchObject({ simulated: 0 });
    await setPaused(rt, id, false);
    expect(await processWinback(rt)).toMatchObject({ simulated: 1 });
    await stopCampaign(rt, id);
    db.prepare('UPDATE winback_enrollments SET next_at = 0').run();
    expect(await processWinback(rt)).toMatchObject({ simulated: 0 });
    expect((db.prepare('SELECT status, stop_reason FROM winback_enrollments').get() as Record<string, string>)).toEqual({ status: 'stopped', stop_reason: 'campaign stopped' });
    await expect(setPaused(rt, id, false)).rejects.toThrow();
  });

  it('sends only inside the window in SALES_TIMEZONE', async () => {
    const db = freshDb(); seed(db);
    const rt = makeRt(db);
    const h = new Date(NOW).getUTCHours();
    const win = h < 22 ? { window_from: h + 1, window_to: h + 2 } : { window_from: 0, window_to: 1 };
    const id = await approved(rt, { ...win, rules: { segments: ['lost'], minDays: 60 } });
    expect((await getCampaign(rt, id))!.status).toBe('running');
    expect(await processWinback(rt)).toMatchObject({ simulated: 0 });
  });
});

// ───────────── 4. Stop on conversion, and caps ─────────────

describe('stop on conversion and daily cap', () => {
  it("stops a person's sequence the moment they register, buy, book or reply", async () => {
    const db = freshDb(); seed(db);
    const rt = makeRt(db);
    const id = await approved(rt, { rules: { segments: ['lost', 'no_show', 'cancelled', 'applied'], minDays: 60 } });
    expect(await processWinback(rt)).toMatchObject({ simulated: 4 });
    const later = NOW + 60_000;
    db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at) VALUES ('wr9', 'tok-lost1-bbbbbbbbbb', 'ws1', 'lost1', ?)").run(later);
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES ('p9', 'x', 'ns1', 'seat', 'paid', 10000, 'usd', ?, ?, ?)").run(later, later, later);
    db.prepare('UPDATE leads SET booked_at = ? WHERE id = ?').run(later, 'can1');
    db.prepare("INSERT INTO whatsapp_messages (id, ts, lead_id, direction) VALUES ('wa1', ?, 'app1', 'in')").run(later);
    db.prepare('UPDATE winback_enrollments SET next_at = 0').run();
    expect(await processWinback(rt)).toMatchObject({ simulated: 0, stopped: 4 });
    const reasons = Object.fromEntries((db.prepare('SELECT lead_id, stop_reason FROM winback_enrollments').all() as { lead_id: string; stop_reason: string }[]).map((r) => [r.lead_id, r.stop_reason]));
    expect(reasons).toEqual({ lost1: 'registered', ns1: 'bought', can1: 'booked', app1: 'replied' });
    expect((await getCampaign(rt, id))!.status).toBe('done');
    // The report counts what happened, from our tables.
    const { listCampaigns } = await import('../src/winback/campaigns');
    const [row] = await listCampaigns(rt);
    expect(row.report).toMatchObject({ sent: 4, registered: 1, bought: 1, revenue: { USD: 100 } });
  });

  it('never sends more than the daily cap', async () => {
    const db = freshDb(); seed(db);
    const rt = makeRt(db);
    await approved(rt, { daily_cap: 2, rules: { segments: ALL, minDays: 60 } });
    expect(await processWinback(rt)).toMatchObject({ simulated: 2 });
    expect(await processWinback(rt)).toMatchObject({ simulated: 0 });
    expect(count(db, "SELECT COUNT(*) AS n FROM winback_sends WHERE status = 'simulated'")).toBe(2);
  });

  it('keeps every email before the destination closes', () => {
    const now = NOW;
    expect(nextTiming({ stepIdx: 0, planLength: 5, gapDays: 3, closesAt: null, now })).toEqual({ step: 1, at: now + 3 * DAY });
    // Two days left: jump to the last note a day before registration closes.
    expect(nextTiming({ stepIdx: 0, planLength: 5, gapDays: 3, closesAt: now + 2 * DAY, now })).toEqual({ step: 4, at: now + 2 * DAY - 26 * 3_600_000 });
    // Five hours left: nothing more.
    expect(nextTiming({ stepIdx: 1, planLength: 5, gapDays: 3, closesAt: now + 5 * 3_600_000, now })).toBeNull();
    expect(nextTiming({ stepIdx: 4, planLength: 5, gapDays: 3, closesAt: null, now })).toBeNull();
  });

  it('ends the campaign when its live webinar has passed', async () => {
    const db = freshDb(); seed(db); seedLive(db);
    const rt = makeRt(db);
    const id = await approved(rt, { destination: 'live', dest_ref: 'le1', rules: { segments: ['lost'], minDays: 60 } });
    db.prepare('UPDATE live_webinars SET starts_at = ?').run(NOW - DAY);
    expect(await processWinback(rt)).toMatchObject({ simulated: 0 });
    expect((await getCampaign(rt, id))!.status).toBe('done');
  });
});

// ───────────── 5. Copy ─────────────

describe('win-back copy', () => {
  it('every email for every segment and destination passes auditCopy, names seller rollover with funding, and has the real date', async () => {
    const db = freshDb(); seed(db); seedLive(db); seedCohort(db);
    const rt = makeRt(db, { WEBINAR_JIT_EVERY: '0' });
    db.prepare("INSERT INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES ('ws9', ?, 'evergreen', 'scheduled', 0, ?)").run(NOW + 3 * DAY, NOW);
    for (const [destination, dest_ref] of [['masterclass', null], ['live', 'le1'], ['challenge', 'co1']] as const) {
      const c = await createCampaign(rt, { destination, dest_ref, steps: 6, rules: { segments: ALL, minDays: 0 } });
      const dest = await resolveDestination(rt, destination, dest_ref);
      expect(dest.ok, `${destination}: ${dest.held ?? dest.closed}`).toBe(true);
      expect(dest.when).toBeTruthy();
      for (const leadId of ['lost1', 'ns1', 'can1', 'app1', 'reg1', 'tix1']) {
        const lead = (await getLead(rt.env, leadId))!;
        for (const segment of ALL) {
          for (let i = 0; i < 6; i++) {
            const r = await renderStep(rt, c, lead, { stepIdx: i, segment, lastActiveAt: NOW - 140 * DAY, dest, link: 'https://apply.test/x', mode: 'preview' });
            const where = `${destination}/${leadId}/${segment}/${i}`;
            expect(r.issues, where).toEqual([]);
            const text = [r.content.subject, r.content.preheader, ...r.content.body, r.content.ps ?? ''].join('\n');
            expect(text, where).not.toMatch(/[!—]/);
            // "free" only inside the owner-approved guarantee headline, never about a call.
            expect(text.split(GUARANTEE_HEADLINE).join(''), where).not.toMatch(/\bfree\b/i);
            if (/seller financ|commercial debt/i.test(text)) expect(text, where).toMatch(/seller rollover/);
            if (i !== 5 || destination !== 'masterclass') expect(text, where).toContain(dest.when);
            if (i === 0) expect(text, where).toContain('about 5 months ago');
            if (/guarantee/i.test(text)) {
              expect(destination).not.toBe('masterclass');
              expect(text, where).toContain(GUARANTEE_HEADLINE);
              expect(text, where).toContain(GUARANTEE_BODY);
              expect(text, where).toContain(MONEY_BACK_HEADLINE);
              expect(text, where).toContain(MONEY_BACK_BODY);
            }
          }
        }
      }
    }
  });

  it('writes from their own application answers, and previews every email', async () => {
    const db = freshDb(); seed(db);
    const rt = makeRt(db);
    const c = await createCampaign(rt, { steps: 4, rules: { segments: ['lost'], minDays: 60 } });
    const p = await previewCampaign(rt, c, 'lost1');
    expect(p.lead).toMatchObject({ id: 'lost1', sample: false, segment: 'lost' });
    expect(p.emails).toHaveLength(4);
    expect(p.emails.map((e) => e.template)).toEqual(['Honest re-open', 'How the money side works', 'Their sticking point', 'Last note']);
    expect(p.emails[0].html).toContain('Two competitors nearby want to retire');
    expect(p.emails[0].html).toMatch(/We last spoke in [A-Z][a-z]+( \d{4})?, about 6 months ago/);
    expect(p.emails[2].subject).toBe('Where the money for a first deal comes from');
    for (const e of p.emails) expect(e.issues).toEqual([]);
    expect(planFor(9)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('Claude rewrites only with the Anthropic key, keeps the real date, and never touches the guarantees', async () => {
    const db = freshDb(); seed(db); seedLive(db);
    const rt = makeRt(db, { EMAIL_PERSONALIZE: '', ANTHROPIC_API_KEY: 'sk-ant-test' });
    const c = await createCampaign(rt, { destination: 'live', dest_ref: 'le1', steps: 6, rules: { segments: ['lost'], minDays: 60 } });
    const dest = await resolveDestination(rt, 'live', 'le1');
    const lead = (await getLead(rt.env, 'lost1'))!;
    let paragraphs = ['Dana,', 'You wanted to buy a competitor and two nearby owners want out.', `I am running a live webinar on ${dest.when}.`];
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      calls.push(String(init.body));
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify({ subject: 'Two owners near you want out', preheader: 'An invitation.', paragraphs, ps: '', facts_used: [] }) }] }), { headers: { 'content-type': 'application/json' } });
    }));
    const step = (i: number, mode: 'send' | 'preview') => renderStep(rt, c, lead, { stepIdx: i, segment: 'lost', lastActiveAt: NOW - 140 * DAY, dest, link: 'https://apply.test/x', mode });
    const ok = await step(0, 'send');
    expect(ok.personal.mode).toBe('ai');
    expect(ok.content.subject).toBe('Two owners near you want out');
    expect(ok.content.cta?.href).toBe('https://apply.test/x');
    paragraphs = ['Dana,', 'You wanted to buy a competitor.', 'Come along to the webinar.'];
    const dropped = await step(0, 'send');
    expect(dropped.personal).toMatchObject({ mode: 'fallback', error: 'rewrite dropped the date' });
    expect(dropped.content.subject).toBe("It's been 5 months");
    const n = calls.length;
    const g = await step(3, 'send');
    expect(g.content.body.join(' ')).toContain(GUARANTEE_BODY);
    await step(1, 'preview');
    expect(calls.length).toBe(n); // the guarantee email and previews never go to the model
    // Without the key: no model call at all.
    const off = await renderStep(makeRt(db, { EMAIL_PERSONALIZE: '' }), c, lead, { stepIdx: 0, segment: 'lost', lastActiveAt: NOW - 140 * DAY, dest, link: 'x', mode: 'send' });
    expect(off.personal.mode).toBe('off');
    expect(calls.length).toBe(n);
  });

  it('the tab copy passes auditCopy', () => {
    const admin = fs.readFileSync(`${node.cwd()}/public/assets/admin.js`, 'utf8');
    const m = /\n {4}winback: \{[^\n]*sub: '([^']*)', more: '([^']*)'/.exec(admin);
    expect(m).not.toBeNull();
    expect([...auditCopy(m![1]), ...auditCopy(m![2])]).toEqual([]);
    const ui = fs.readFileSync(`${node.cwd()}/public/assets/admin-winback.js`, 'utf8');
    expect(ui).not.toMatch(/—|!['"]/);
    expect(ui).not.toMatch(/\bfree\b/i);
    for (const s of Object.values(SEGMENTS)) expect([...auditCopy(s.label), ...auditCopy(s.hint)]).toEqual([]);
    expect(auditEmail({ subject: 'x', preheader: 'y', body: ['Hi Sam,', 'Fine.'] })).toEqual([]);
  });
});

// ───────────── 6. Admin auth ─────────────

describe('admin routes', () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  it('every win-back API needs the admin session', async () => {
    const app = (await import('../src/index')).default;
    const db = freshDb();
    const env = { DB: d1(db), ASSETS: { fetch: async () => new Response('', { status: 404 }) }, ADMIN_PASSWORD: 'devpass', SESSION_SECRET: 'x'.repeat(32) };
    const call = (method: string, p: string) => app.fetch(new Request(`https://apply.test/admin/api/winback${p}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }), env as never, ctx as never);
    for (const [m, p] of [['GET', ''], ['POST', ''], ['POST', '/audience'], ['GET', '/x/preview'], ['POST', '/x/test'], ['POST', '/x/start'], ['POST', '/x/pause'], ['POST', '/x/resume'], ['POST', '/x/stop'], ['PUT', '/x'], ['DELETE', '/x']]) {
      expect([401, 403], `${m} ${p}`).toContain((await call(m, p)).status);
    }
    expect(count(db, 'SELECT COUNT(*) AS n FROM winback_campaigns')).toBe(0);
  });
});

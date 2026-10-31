import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { SETTINGS } from '../src/settings';
import { approveAction, clearHandlers, editAction, getAction, isAuto, listActions, logAction, proposeAction, registerActionHandler, rejectAction, actorLabel } from '../src/ops/actions';
import { registerCoreHandlers } from '../src/ops/handlers';
import { type RawCounts, fmt, fmtChange, change, toSnapshot, METRIC_KEYS, rawCounts } from '../src/ops/metrics';
import { type Finding, alertTitle, evaluate, evaluateCampaigns, isDebounced, runMonitors, topMover, thresholds } from '../src/ops/monitors';
import { type BriefData, buildBrief, briefMinute, composeBrief, maybeSendBrief } from '../src/ops/brief';
import { cleanRoutine, createRoutine, describeSchedule, nextRunAt, RoutineError, runDueRoutines } from '../src/ops/routines';
import { type ChatModel, NO_KEY_NOTE, runChat } from '../src/ops/chat';
import { TOOLS, runTool } from '../src/ops/tools';
import { resolveRange, priorOf } from '../src/ops/range';
import { mdToHtml, summaryDocument } from '../src/ops/documents';

// ───────────── A real SQLite database shaped like D1, every migration applied ─────────────
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
const makeRt = (db: DatabaseSync, settings: Record<string, string> = {}) =>
  ({ env: { DB: d1(db) }, settings: { ...Object.fromEntries(SETTINGS.map((d) => [d.key, ''])), OPS_TIMEZONE: 'Australia/Sydney', ...settings }, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;

let leadN = 0;
function addLead(db: DatabaseSync, o: { created: number; campaign?: string; content?: string; booked?: number; callAt?: number; status?: string; tier?: string; closed?: number; revenue?: number; first?: string }) {
  const id = `lead_${++leadN}`;
  db.prepare(`INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, status, tier, utm_campaign, utm_content, booked_at, call_at, closed_at, revenue)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, `R${String(leadN).padStart(5, '0')}`, o.created, o.created, o.first ?? `Lead${leadN}`, `${id}@example.com`, o.status ?? (o.booked ? 'booked' : 'applied'), o.tier ?? 'A', o.campaign ?? null, o.content ?? null, o.booked ?? null, o.callAt ?? null, o.closed ?? null, o.revenue ?? 0);
  return id;
}

const fetchMock = vi.fn(async () => new Response('ok'));
beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); clearHandlers(); registerCoreHandlers(); });
afterEach(() => { vi.unstubAllGlobals(); });

// ───────────────────────── Action layer ─────────────────────────
describe('action layer', () => {
  it('logs an action with department, actor and status', async () => {
    const db = freshDb(); const rt = makeRt(db);
    const id = await logAction(rt, { dept: 'sales', kind: 'sales.reply', summary: 'Replied to Dana', actor: 'ai', status: 'done', leadId: 'lead_x', payload: { a: 1 } });
    const row = await getAction(rt, id);
    expect(row).toMatchObject({ dept: 'sales', kind: 'sales.reply', actor: 'ai', status: 'done', lead_id: 'lead_x', payload: '{"a":1}' });
    expect(actorLabel(row!)).toBe('AI');
  });

  it('queues a proposal, then approving runs the registered handler once and logs the outcome', async () => {
    const db = freshDb(); const rt = makeRt(db);
    const handler = vi.fn(async (_rt: Runtime, p: unknown) => ({ ok: true, summary: `Paused ${(p as { ad: string }).ad}` }));
    registerActionHandler('marketing.pause_ad', handler);
    const id = await proposeAction(rt, { dept: 'marketing', kind: 'marketing.pause_ad', summary: 'Pause ad X', detail: 'CPL doubled', payload: { ad: 'x' }, risk: 'high' });
    expect((await getAction(rt, id))!.status).toBe('proposed');
    expect(handler).not.toHaveBeenCalled();
    const r = await approveAction(rt, id, 'you');
    expect(r).toEqual({ ok: true, summary: 'Paused x' });
    const row = (await getAction(rt, id))!;
    expect(row).toMatchObject({ status: 'done', decided_by: 'you', result: 'Paused x' });
    expect(actorLabel(row)).toBe('AI → You');
    expect((await approveAction(rt, id, 'you')).ok).toBe(false); // already decided
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('records a failed handler, and approves kinds without a handler for manual follow-through', async () => {
    const db = freshDb(); const rt = makeRt(db);
    registerActionHandler('sales.bulk_email', async () => { throw new Error('Resend is not connected'); });
    const a = await proposeAction(rt, { dept: 'sales', kind: 'sales.bulk_email', summary: 'Email 12 quiet leads', detail: '', payload: {}, risk: 'high' });
    await approveAction(rt, a);
    expect(await getAction(rt, a)).toMatchObject({ status: 'failed', result: 'Resend is not connected' });
    const b = await proposeAction(rt, { dept: 'content', kind: 'content.unknown', summary: 'Film a video', detail: '', payload: {}, risk: 'low' });
    await approveAction(rt, b);
    expect((await getAction(rt, b))!.status).toBe('approved');
    expect((await getAction(rt, b))!.result).toMatch(/by hand/);
  });

  it('runs auto kinds straight away (actor auto) and leaves the rest waiting', async () => {
    const db = freshDb(); const rt = makeRt(db, { OPS_AUTO_KINDS: 'ops.document, research.*' });
    expect(isAuto(rt, 'ops.document')).toBe(true);
    expect(isAuto(rt, 'research.scan_reddit')).toBe(true);
    expect(isAuto(rt, 'marketing.pause_ad')).toBe(false);
    expect(isAuto(makeRt(db), 'ops.document')).toBe(false); // default: none
    const id = await proposeAction(rt, { dept: 'chief', kind: 'ops.document', summary: 'Save notes', detail: '', payload: { title: 'Notes', markdown: '# Notes\n- one' }, risk: 'low' });
    expect(await getAction(rt, id)).toMatchObject({ status: 'done', decided_by: 'auto' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM ops_documents').get() as { n: number }).n).toBe(1);
    const q = await proposeAction(rt, { dept: 'marketing', kind: 'marketing.pause_ad', summary: 'Pause', detail: '', payload: {}, risk: 'high' });
    expect((await getAction(rt, q))!.status).toBe('proposed');
  });

  it('edits a proposal (summary, detail, JSON payload) and rejects with a reason', async () => {
    const db = freshDb(); const rt = makeRt(db);
    const id = await proposeAction(rt, { dept: 'sales', kind: 'sales.follow_up', summary: 'Follow up', detail: 'd', payload: { n: 1 }, risk: 'medium' });
    expect((await editAction(rt, id, { payload: '{bad' })).ok).toBe(false);
    expect((await editAction(rt, id, { summary: 'Follow up with 5', payload: '{"n":5}' })).ok).toBe(true);
    expect(await getAction(rt, id)).toMatchObject({ summary: 'Follow up with 5', payload: '{"n":5}' });
    expect((await rejectAction(rt, id, 'you', 'not now')).ok).toBe(true);
    expect(await getAction(rt, id)).toMatchObject({ status: 'rejected', result: 'Rejected: not now' });
    expect((await editAction(rt, id, { summary: 'x' })).ok).toBe(false);
    expect((await listActions(rt, { status: 'rejected' })).length).toBe(1);
    expect((await listActions(rt, { dept: 'marketing' })).length).toBe(0);
  });

  it('core handler ops.routine_create creates the routine on approval', async () => {
    const db = freshDb(); const rt = makeRt(db);
    const id = await proposeAction(rt, { dept: 'chief', kind: 'ops.routine_create', summary: 'Monday review', detail: '', payload: { name: 'Monday review', instruction: 'Summarise last week', cadence: 'weekly', weekday: 1, time: '08:00' }, risk: 'low' });
    await approveAction(rt, id);
    expect((await getAction(rt, id))!.result).toBe('Routine "Monday review" created: Every Monday at 08:00 (Australia/Sydney).');
    expect((db.prepare('SELECT COUNT(*) AS n FROM ops_routines').get() as { n: number }).n).toBe(1);
  });
});

// ───────────────────────── Monitors ─────────────────────────
const raw = (o: Partial<RawCounts> = {}): RawCounts => ({
  visitors: 0, leads: 0, applications: 0, webinar_regs: 0, live_regs: 0, challenge_regs: 0, tickets: 0, bookings: 0, calls_held: 0, no_shows: 0, deals: 0, revenue: 0,
  sprint_sales: 0, sprint_revenue: 0, deposits: 0, deposit_revenue: 0, ad_spend: 0, pass_currency: 'USD', ad_currency: 'USD', ...o,
});
const TH = { dropPct: 0.3, spikePct: 0.5, minCount: 5 };

describe('monitor maths', () => {
  it('flags drops and spikes past the thresholds, with severity', () => {
    const f = evaluate(toSnapshot(raw({ bookings: 6, visitors: 900, leads: 30, tickets: 12 })), toSnapshot(raw({ bookings: 11, visitors: 1000, leads: 10, tickets: 0 })), '24h', TH);
    const byKey = Object.fromEntries(f.map((x) => [x.key, x]));
    expect(byKey['bookings:24h:drop']).toMatchObject({ current: 6, prior: 11, severity: 'medium', text: { current: '6', prior: '11', change: '-45%' } });
    expect(byKey['leads:24h:spike']).toMatchObject({ change: 2, severity: 'high' });
    expect(byKey['tickets:24h:spike']).toMatchObject({ change: null, text: { change: 'new' } });
    expect(byKey['visitors:24h:drop']).toBeUndefined(); // -10% is below the threshold
    expect(alertTitle(byKey['bookings:24h:drop'])).toBe('Calls booked down 45% (24 hours)');
  });

  it('ignores small numbers (below the minimum count)', () => {
    const f = evaluate(toSnapshot(raw({ deals: 1, bookings: 0 })), toSnapshot(raw({ deals: 3, bookings: 4 })), '7d', TH);
    expect(f).toEqual([]);
  });

  it('watches show rate only with enough calls, and cost per lead as a rise', () => {
    const cur = toSnapshot(raw({ calls_held: 3, no_shows: 7, ad_spend: 1000, leads: 10 }));
    const prior = toSnapshot(raw({ calls_held: 8, no_shows: 2, ad_spend: 1000, leads: 25 }));
    const f = evaluate(cur, prior, '7d', TH);
    const sr = f.find((x) => x.metric === 'show_rate')!;
    expect(sr).toMatchObject({ direction: 'drop', text: { current: '30%', prior: '80%' } });
    const cpl = f.find((x) => x.metric === 'cpl')!;
    expect(cpl).toMatchObject({ costUp: true, text: { current: '$100', prior: '$40.00', change: '+150%' } });
    expect(alertTitle(cpl)).toBe('Cost per lead up 150% (7 days)');
  });

  it('flags a campaign whose cost per lead rose or that spent with no sign-ups', () => {
    const row = (campaign: string, spend: number, leads: number, bookings = 0) => ({ campaign, visitors: 0, leads, bookings, spend, cpl: leads ? spend / leads : null, cpa: bookings ? spend / bookings : null, currency: 'USD' });
    const f = evaluateCampaigns([row('guide', 500, 5), row('loi', 300, 0), row('steady', 100, 10)], [row('guide', 500, 20), row('loi', 300, 12), row('steady', 100, 10)], '7d', TH);
    expect(f.map((x) => x.key).sort()).toEqual(['cpl:guide:7d:spike', 'cpl:loi:7d:spike']);
    expect(f.find((x) => x.campaign === 'loi')!.text.current).toBe('$300 spent, no leads');
  });

  it('debounces the same alert inside its window', () => {
    const now = 10 * 86_400_000;
    expect(isDebounced(null, now, '24h')).toBe(false);
    expect(isDebounced(now - 23 * 3_600_000, now, '24h')).toBe(true);
    expect(isDebounced(now - 25 * 3_600_000, now, '24h')).toBe(false);
    expect(isDebounced(now - 6 * 86_400_000, now, '7d')).toBe(true);
  });

  it('finds the campaign that moved most', () => {
    const mv = topMover([{ c: 'a', n: 2 }, { c: 'b', n: 9 }], [{ c: 'a', n: 10 }, { c: 'b', n: 10 }], 'c', 'n', 'drop');
    expect(mv).toEqual({ id: 'a', now: 2, before: 10, delta: -8 });
  });

  it('reads thresholds from settings', () => {
    expect(thresholds(makeRt(freshDb(), { OPS_ALERT_DROP_PCT: '25', OPS_ALERT_MIN_COUNT: '3' }))).toEqual({ dropPct: 0.25, spikePct: 0.5, minCount: 3 });
  });

  it('end to end: a booking drop on one campaign raises one alert with the cause and a proposal, pushed to Slack, then debounced', async () => {
    const db = freshDb();
    const rt = makeRt(db, { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
    const now = Date.UTC(2026, 9, 31, 12);
    const H = 3_600_000;
    // Prior 24h: 10 bookings on "guide" (ad g1), 2 on "loi". Current 24h: 1 on "guide", 2 on "loi". Same spend both days.
    for (let i = 0; i < 10; i++) addLead(db, { created: now - 30 * H, booked: now - 30 * H, campaign: 'guide', content: 'g1' });
    for (let i = 0; i < 2; i++) addLead(db, { created: now - 30 * H, booked: now - 30 * H, campaign: 'loi', content: 'l1' });
    addLead(db, { created: now - 2 * H, booked: now - 2 * H, campaign: 'guide', content: 'g1' });
    for (let i = 0; i < 2; i++) addLead(db, { created: now - 2 * H, booked: now - 2 * H, campaign: 'loi', content: 'l1' });
    for (const day of ['2026-10-29', '2026-10-30', '2026-10-31']) db.prepare("INSERT INTO ad_spend (platform, campaign_id, day, campaign_name, spend, currency, updated_at) VALUES ('meta', '123', ?, 'guide', 200, 'USD', 1)").run(day);

    const r = await runMonitors(rt, now);
    expect(r.ran).toBe(true);
    const alerts = db.prepare("SELECT * FROM ops_alerts WHERE key = 'bookings:24h:drop'").all() as { body: string; action_id: string | null; sent_at: number | null }[];
    expect(alerts.length).toBe(1);
    expect(alerts[0].body).toContain('12 → 3');
    expect(alerts[0].body).toContain('campaign "guide", booked calls 10 → 1');
    expect(alerts[0].sent_at).toBe(now);
    const action = await getAction(rt, alerts[0].action_id!);
    expect(action).toMatchObject({ kind: 'marketing.pause_ad', status: 'proposed', dept: 'marketing', risk: 'high' });
    expect(JSON.parse(action!.payload!)).toMatchObject({ campaign: 'guide', ad: 'g1' });
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.test/x', expect.anything());
    const slackBody = JSON.parse((fetchMock.mock.calls.find((c) => (c as unknown[])[0] === 'https://hooks.slack.test/x') as unknown as [string, { body: string }])[1].body);
    expect(slackBody.text).toContain('<https://apply.test/admin#command/approvals|Review and approve in Funnel HQ>');

    expect((await runMonitors(rt, now + 60_000)).ran).toBe(false); // same hour: claimed
    const again = await runMonitors(rt, now + 2 * H, { force: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops_alerts WHERE key = 'bookings:24h:drop'").get()).toEqual({ n: 1 });
    expect(again.ran).toBe(true);
  });
});

// ───────────────────────── Brief ─────────────────────────
describe('brief composition', () => {
  const data = (): BriefData => ({
    kind: 'daily', dateLabel: 'Sat 31 Oct',
    periods: [{ label: 'Yesterday, Fri 30 Oct', priorLabel: 'the day before', cur: toSnapshot(raw({ visitors: 1234, leads: 17, bookings: 6, calls_held: 4, no_shows: 1, deals: 1, revenue: 40000, ad_spend: 512.5 })), prior: toSnapshot(raw({ visitors: 1000, leads: 20, bookings: 11, calls_held: 3, no_shows: 3, ad_spend: 480 })) }],
    actions: [{ dept: 'sales', summary: 'Replied to a lead', status: 'done', actor: 'ai' }, { dept: 'marketing', summary: 'Paused an ad', status: 'failed', actor: 'auto' }],
    approvals: [{ id: 'a1', dept: 'marketing', summary: 'Pause the ad g1', risk: 'high' }],
    alerts: [{ title: 'Calls booked down 45% (24 hours)' }],
  });

  it('every number in the brief traces back to a metric or a log count', () => {
    const d = data();
    const b = composeBrief(d);
    const p = d.periods[0];
    const allowed = new Set<string>();
    for (const k of METRIC_KEYS) { allowed.add(fmt(p.cur[k])); allowed.add(fmt(p.prior[k])); allowed.add(fmtChange(change(p.cur[k].value, p.prior[k].value))); }
    let t = b.markdown;
    for (const fixed of [d.dateLabel, p.label, d.alerts[0].title, d.approvals[0].summary, 'last 24 hours', '1 logged', '1 failed', '1 waiting']) t = t.split(fixed).join('');
    for (const v of [...allowed].sort((x, y) => y.length - x.length)) if (/\d/.test(v)) t = t.split(v).join('');
    expect(t).not.toMatch(/\d/);
    expect(b.markdown).toContain('- **Visitors**: 1,234 (before: 1,000, +23%) · [Overview](/admin#overview)');
    expect(b.markdown).toContain('- **Show rate**: 80% (before: 50%, +60%) · [Calls & deals](/admin#sales)');
    expect(b.markdown).not.toContain('Tickets sold'); // zero both days: left out, never invented
    expect(b.slackLines[0]).toBe('**Yesterday, Fri 30 Oct (vs the day before)**');
  });

  it('says so plainly when nothing happened', () => {
    const b = composeBrief({ ...data(), periods: [{ label: 'Yesterday', priorLabel: 'the day before', cur: toSnapshot(raw()), prior: toSnapshot(raw()) }], actions: [], approvals: [], alerts: [] });
    expect(b.markdown).toContain('No activity was recorded in this period or the one before.');
    expect(b.markdown).toContain('Nothing is waiting for approval.');
  });

  it('builds yesterday from the database in the owner time zone, and sends once in its half hour', async () => {
    const db = freshDb();
    const rt = makeRt(db, { OPS_TIMEZONE: 'America/New_York', OPS_BRIEF_TIME: '07:30', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/b' });
    const now = Date.UTC(2026, 9, 29, 11, 35); // Thu 29 Oct 07:35 in New York (UTC-4)
    const yesterday = Date.UTC(2026, 9, 28, 15); // Wed 28 Oct 11:00 New York
    for (let i = 0; i < 3; i++) addLead(db, { created: yesterday, booked: yesterday });
    addLead(db, { created: Date.UTC(2026, 9, 29, 3) }); // Wed 23:00 New York: still yesterday there
    addLead(db, { created: Date.UTC(2026, 9, 29, 5) }); // Thu 01:00 New York: today, not in the brief
    const d = await buildBrief(rt, 'daily', now);
    expect(d.periods[0].cur.leads.value).toBe(4);
    expect(d.periods[0].cur.bookings.value).toBe(3);
    expect(briefMinute('off')).toBeNull();
    expect(briefMinute('')).toBe(450);
    expect(await maybeSendBrief(rt, now - 10 * 60_000)).toBeNull(); // 07:25, too early
    const sent = await maybeSendBrief(rt, now);
    expect(sent?.title).toBe('Morning brief, Thu 29 Oct');
    expect(await maybeSendBrief(rt, now + 5 * 60_000)).toBeNull(); // once a day
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const mon = await maybeSendBrief(rt, Date.UTC(2026, 10, 2, 12, 31)); // Mon 2 Nov 07:31 New York (UTC-5 after DST)
    expect(mon?.title).toMatch(/^Weekend summary/);
  });

  it('month-to-date document lists every metric with its source', async () => {
    const db = freshDb(); const rt = makeRt(db);
    addLead(db, { created: Date.UTC(2026, 9, 20), booked: Date.UTC(2026, 9, 20) });
    const doc = await summaryDocument(rt, 'mtd', Date.UTC(2026, 9, 31, 2));
    expect(doc.body).toContain('- **Calls booked**: 1');
    expect(doc.body).toContain('[Traffic & ads](/admin#traffic)');
    expect(mdToHtml('**a** [Leads](/admin#leads) [x](javascript:alert(1))')).toBe('<p><strong>a</strong> <a href="/admin#leads">Leads</a> [x](javascript:alert(1))</p>');
  });
});

// ───────────────────────── Routines ─────────────────────────
describe('routines scheduling', () => {
  it('computes the next run in the routine’s own time zone, across daylight saving changes', () => {
    // Sydney is UTC+11 in October. Daily 07:30 after Sat 31 Oct 11:00 Sydney → Sun 1 Nov 07:30 Sydney.
    expect(new Date(nextRunAt({ cadence: 'daily', weekday: null, time: '07:30', timezone: 'Australia/Sydney' }, Date.UTC(2026, 9, 31, 0))!).toISOString()).toBe('2026-10-31T20:30:00.000Z');
    // New York leaves DST on Sun 1 Nov 2026: Monday 08:00 is 13:00 UTC, not 12:00.
    expect(new Date(nextRunAt({ cadence: 'weekly', weekday: 1, time: '08:00', timezone: 'America/New_York' }, Date.UTC(2026, 9, 30, 12))!).toISOString()).toBe('2026-11-02T13:00:00.000Z');
    // Weekdays skip the weekend: after Fri 18:00 London → Mon 09:00 London.
    expect(new Date(nextRunAt({ cadence: 'weekdays', weekday: null, time: '09:00', timezone: 'Europe/London' }, Date.UTC(2026, 9, 30, 17))!).toISOString()).toBe('2026-11-02T09:00:00.000Z');
    // Exactly at the run time → the next one, never the same instant twice.
    const at = nextRunAt({ cadence: 'daily', weekday: null, time: '09:00', timezone: 'UTC' }, Date.UTC(2026, 0, 1, 9))!;
    expect(new Date(at).toISOString()).toBe('2026-01-02T09:00:00.000Z');
    expect(describeSchedule({ cadence: 'weekly', weekday: 1, time: '08:00', timezone: 'America/New_York' })).toBe('Every Monday at 08:00 (America/New_York)');
  });

  it('validates input', () => {
    const rt = makeRt(freshDb());
    expect(() => cleanRoutine(rt, { instruction: 'x', time: '25:00' })).toThrow(RoutineError);
    expect(() => cleanRoutine(rt, { instruction: 'x', time: '08:00', cadence: 'weekly', weekday: 9 })).toThrow(/day of the week/);
    expect(() => cleanRoutine(rt, { instruction: 'x', time: '08:00', timezone: 'Mars/Base' })).toThrow(/time zone/);
    expect(cleanRoutine(rt, { instruction: 'Summarise', time: '8:05' })).toMatchObject({ time: '08:05', timezone: 'Australia/Sydney', cadence: 'daily' });
  });

  it('runs due routines once: a chat thread, a Slack message, the next run scheduled', async () => {
    const db = freshDb();
    const rt = makeRt(db, { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/r' });
    const t0 = Date.UTC(2026, 9, 30, 0);
    const id = await createRoutine(rt, { name: 'Daily check', instruction: 'How many calls were booked yesterday?', cadence: 'daily', time: '09:00', timezone: 'UTC' }, t0);
    const due = Date.UTC(2026, 9, 30, 9, 2);
    const model: ChatModel = { turn: vi.fn(async (_req, onText) => { onText('Answer from data.'); return { content: [{ type: 'text', text: 'Answer from data.', citations: null }], stop_reason: 'end_turn' }; }) } as unknown as ChatModel;
    expect(await runDueRoutines(rt, due, { model })).toBe(1);
    expect(await runDueRoutines(rt, due + 60_000, { model })).toBe(0);
    const r = db.prepare('SELECT * FROM ops_routines WHERE id = ?').get(id) as { next_run_at: number; last_thread: string };
    expect(new Date(r.next_run_at).toISOString()).toBe('2026-10-31T09:00:00.000Z');
    expect(db.prepare("SELECT kind, routine_id FROM ops_threads WHERE id = ?").get(r.last_thread)).toEqual({ kind: 'routine', routine_id: id });
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.test/r', expect.anything());
  });
});

// ───────────────────────── Chat and tools ─────────────────────────
describe('chat tool layer', () => {
  function scripted(turns: { content: unknown[]; stop_reason: string }[]) {
    const seen: unknown[] = [];
    let i = 0;
    const model: ChatModel = { turn: async (req, onText) => { seen.push(JSON.parse(JSON.stringify(req.messages))); const t = turns[i++]; for (const b of t.content as { type: string; text?: string }[]) if (b.type === 'text') onText(b.text!); return t as never; } };
    return { model, seen };
  }

  it('answers from a tool call, streams text, records tool sources and saves the thread', async () => {
    const db = freshDb(); const rt = makeRt(db);
    const now = Date.UTC(2026, 9, 31, 2);
    for (let i = 0; i < 4; i++) addLead(db, { created: now - 86_400_000, booked: now - 86_400_000 });
    const { model, seen } = scripted([
      { content: [{ type: 'tool_use', id: 'tu1', name: 'funnel_stats', input: { range: '7d' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'You booked 4 calls in the last 7 days ([Calls & deals](/admin#sales)).' }], stop_reason: 'end_turn' },
    ]);
    const events: { type: string }[] = [];
    const res = await runChat(rt, { message: 'How many calls did we book this week?', model, emit: (e) => events.push(e), now });
    expect(events.map((e) => e.type)).toEqual(['thread', 'tool', 'text', 'done']);
    const tool = events[1] as unknown as { name: string; sources: { href: string }[] };
    expect(tool.name).toBe('funnel_stats');
    expect(tool.sources.map((s) => s.href)).toContain('/admin#sales');
    // The tool result handed to the model carries the real count.
    const second = seen[1] as { role: string; content: { type: string; content: string }[] }[];
    const result = JSON.parse(second[2].content[0].content);
    expect(result.metrics.find((m: { key: string }) => m.key === 'bookings')).toMatchObject({ value: 4, shown: '4' });
    const msgs = db.prepare('SELECT role, content, tools FROM ops_messages WHERE thread_id = ? ORDER BY created_at').all(res.threadId) as { role: string; content: string; tools: string | null }[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.parse(msgs[1].tools!)[0].name).toBe('funnel_stats');
    // A follow-up in the same thread sends earlier turns back as plain text only.
    const f = scripted([{ content: [{ type: 'text', text: 'Yes.' }], stop_reason: 'end_turn' }]);
    await runChat(rt, { threadId: res.threadId, message: 'Is that more than last week?', model: f.model, now: now + 1000 });
    expect(f.seen[0]).toEqual([{ role: 'user', content: 'How many calls did we book this week?' }, { role: 'assistant', content: 'You booked 4 calls in the last 7 days ([Calls & deals](/admin#sales)).' }, { role: 'user', content: 'Is that more than last week?' }]);
  });

  it('proposes actions instead of carrying them out', async () => {
    const db = freshDb(); const rt = makeRt(db);
    const { model } = scripted([
      { content: [{ type: 'tool_use', id: 'tu1', name: 'propose_action', input: { dept: 'sales', kind: 'sales.follow_up_quiet_leads', summary: 'Follow up with 3 quiet A-tier leads', detail: 'From search_leads', payload: { leadIds: ['a', 'b', 'c'] }, risk: 'high' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Queued for your approval.' }], stop_reason: 'end_turn' },
    ]);
    const res = await runChat(rt, { message: 'Follow up with every lead who went quiet', model });
    const rows = await listActions(rt, { status: 'proposed' });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ dept: 'sales', kind: 'sales.follow_up_quiet_leads', actor: 'ai', source: `chat:${res.threadId}` });
  });

  it('without the API key, replies with the setup note and still saves the thread', async () => {
    const db = freshDb(); const rt = makeRt(db);
    const events: { type: string; text?: string }[] = [];
    const res = await runChat(rt, { message: 'Hello', emit: (e) => events.push(e) });
    expect(res.text).toBe(NO_KEY_NOTE);
    expect(events.find((e) => e.type === 'text')!.text).toBe(NO_KEY_NOTE);
  });

  it('read tools return real rows with their source views', async () => {
    const db = freshDb(); const rt = makeRt(db);
    const now = Date.UTC(2026, 9, 31, 2);
    const a = addLead(db, { created: now - 3_600_000, first: 'Dana', tier: 'A', campaign: 'guide' });
    addLead(db, { created: now - 3_600_000, first: 'Lee', tier: 'C' });
    const s = await runTool(rt, 'search_leads', { tier: 'A' }, { threadId: 't', now });
    expect((s.result as { total: number; leads: { name: string; link: string }[] })).toMatchObject({ total: 1, leads: [{ name: 'Dana', link: `/admin#lead=${a}` }] });
    const d = await runTool(rt, 'lead_detail', { id: a }, { threadId: 't', now });
    expect(d.sources[0].href).toBe(`/admin#lead=${a}`);
    const ads = await runTool(rt, 'ad_performance', { range: '7d' }, { threadId: 't', now });
    expect((ads.result as { campaigns: { campaign: string; leads: number }[] }).campaigns).toEqual([expect.objectContaining({ campaign: 'guide', leads: 1 })]);
    for (const name of ['bookings', 'deals', 'event_stats', 'sprint_board', 'email_stats', 'live_visitors', 'activity_log']) {
      const out = await runTool(rt, name, {}, { threadId: 't', now });
      expect(out.sources.length, name).toBeGreaterThan(0);
      expect(out.sources.every((x) => x.href.startsWith('/admin')), name).toBe(true);
    }
    expect(TOOLS.map((t) => t.name)).toContain('create_document');
  });

  it('ranges resolve in the owner time zone', () => {
    const r = resolveRange('yesterday', 'Australia/Sydney', Date.UTC(2026, 9, 31, 2)); // Sat 31 Oct 13:00 Sydney
    expect(new Date(r.from).toISOString()).toBe('2026-10-29T13:00:00.000Z'); // Fri 30 Oct 00:00 Sydney
    expect(new Date(r.to + 1).toISOString()).toBe('2026-10-30T13:00:00.000Z');
    const p = priorOf(r);
    expect(new Date(p.from).toISOString()).toBe('2026-10-28T13:00:00.000Z');
    const w = resolveRange('weekend', 'UTC', Date.UTC(2026, 10, 2, 8)); // Monday
    expect([new Date(w.from).toISOString(), new Date(w.to + 1).toISOString()]).toEqual(['2026-10-31T00:00:00.000Z', '2026-11-02T00:00:00.000Z']);
  });

  it('splits daily ad spend between back-to-back ranges without double counting', async () => {
    const { spendDays } = await import('../src/ops/metrics');
    const now = Date.UTC(2026, 9, 31, 12);
    expect(spendDays(now - 86_400_000, now)).toEqual(['2026-10-30', '2026-10-30']);
    expect(spendDays(now - 2 * 86_400_000, now - 86_400_000 - 1)).toEqual(['2026-10-29', '2026-10-29']);
    expect(spendDays(now - 7 * 86_400_000, now)).toEqual(['2026-10-24', '2026-10-30']);
  });

  it('raw counts read every table without failing on a fresh database', async () => {
    const c = await rawCounts(makeRt(freshDb()), { from: 0, to: Date.now() });
    expect(c.visitors).toBe(0);
    expect(c.pass_currency).toBe('USD');
  });
});

// ───────────────────────── Admin auth ─────────────────────────
describe('admin auth', () => {
  it('every Command API needs the admin session, and writes must come from the dashboard', async () => {
    const { default: worker } = await import('../src/index');
    const db = freshDb();
    const env = { DB: d1(db), ADMIN_PASSWORD: 'devpass', SESSION_SECRET: 'test-secret' } as never;
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;
    for (const [method, path] of [['GET', '/admin/api/ops'], ['GET', '/admin/api/ops/actions'], ['GET', '/admin/api/ops/threads'], ['GET', '/admin/api/ops/documents/doc_x.md']]) {
      const res = await worker.fetch(new Request(`https://apply.test${path}`, { method }), env, ctx);
      expect(res.status, path).toBe(401);
    }
    const res = await worker.fetch(new Request('https://apply.test/admin/api/ops/chat', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{"message":"hi"}' }), env, ctx);
    expect(res.status).toBe(403);
  });
});

// ───────────────────────── Copy rules ─────────────────────────
describe('copy rules for fixed Command strings', () => {
  it('settings, notes and generated text pass auditCopy, with no em dashes or exclamation marks', async () => {
    const strings: string[] = [NO_KEY_NOTE];
    for (const s of SETTINGS) if (s.key.startsWith('OPS_')) strings.push(s.label, 'help' in s ? String(s.help) : '');
    strings.push(composeBrief({ kind: 'weekend', dateLabel: 'Mon 2 Nov', periods: [], actions: [], approvals: [], alerts: [] }).markdown);
    const f: Finding = { key: 'k', metric: 'bookings', label: 'Calls booked', window: '24h', direction: 'drop', severity: 'high', current: 1, prior: 10, change: -0.9, text: { current: '1', prior: '10', change: '-90%' }, source: { label: 'Calls & deals', href: '/admin#sales' } };
    strings.push(alertTitle(f));
    // Fixed strings in the Command tab's browser script (sentences of three words or more).
    const js = fs.readFileSync(`${node.cwd()}/public/assets/admin-command.js`, 'utf8').replace(/var CSS = [\s\S]*?;\n\n/, '');
    for (const m of js.matchAll(/'((?:[^'\\]|\\.){12,})'/g)) if (/^[A-Z][^<>{}]*\s\S+\s/.test(m[1]) && !/[;{}=]|\.cmd|function/.test(m[1])) strings.push(m[1].replace(/\\'/g, "'"));
    expect(strings.length).toBeGreaterThan(30);
    for (const s of strings.filter(Boolean)) {
      expect(auditCopy(s), s).toEqual([]);
      expect(s, s).not.toMatch(/—|!/);
    }
  });
});

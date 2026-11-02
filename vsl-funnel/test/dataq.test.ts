import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, Runtime } from '../src/app';
import { login } from '../src/admin/auth';
import { ladderReport } from '../src/admin/deal-sprint';
import { mapCounts } from '../src/admin/funnel-maps';
import { auditCopy } from '../src/content/copy-rules';
import { CHECKS, CHECK_KEYS, type CheckResult, isWarn, normaliseEmail, runChecks, validPhone } from '../src/dataq/checks';
import { DATASETS, EXPORT_ROW_CAP, auditExport, cellValue, countRows, csvCell, exportColumns, exportStream } from '../src/dataq/export';
import { dataqAdmin } from '../src/dataq/routes';
import { compare, composeSummary, loadResults, maybeRunDataQuality, postSummary, prevDay, runDataQuality, saveResults } from '../src/dataq/run';
import { PAID_SALE, netMajor, paidSales, salesSql } from '../src/lib/paid-sales';
import { rawCounts } from '../src/ops/metrics';
import { SETTINGS } from '../src/settings';

// ───────────── A real SQLite database shaped like D1, every migration applied (same shim as ops.test.ts) ─────────────
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
const BASE = { ...Object.fromEntries(SETTINGS.map((d) => [d.key, ''])), OPS_TIMEZONE: 'Australia/Sydney' } as Record<string, string>;
const makeRt = (db: DatabaseSync, settings: Record<string, string> = {}) =>
  ({ env: { DB: d1(db) }, settings: { ...BASE, ...settings }, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-02T00:00:00Z'); // 11:00 in Sydney
let seq = 0;
const id = (p: string) => `${p}${++seq}`;
function lead(db: DatabaseSync, o: { created?: number; email?: string; phone?: string | null; tz?: string | null; channel?: string | null; utm?: string | null; visitor?: string | null; source?: string | null } = {}) {
  const lid = id('lead_');
  db.prepare(`INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, phone, timezone, channel, utm_source, visitor_id, booking_source, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied')`).run(lid, `R${seq}`, o.created ?? NOW - DAY, o.created ?? NOW - DAY, 'Ann', o.email ?? `${lid}@example.com`, o.phone ?? null, o.tz ?? null, o.channel ?? null, o.utm ?? null, o.visitor ?? null, o.source ?? null);
  return lid;
}
function pass(db: DatabaseSync, o: { lead: string; kind: string; status?: string; amount?: number; refunded?: number; paid?: number; source?: string | null; currency?: string }) {
  const pid = id('pass_');
  db.prepare(`INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, refunded_amount, currency, paid_at, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(pid, 'reg_x', o.lead, o.kind, o.status ?? 'paid', o.amount ?? 10_000, o.refunded ?? 0, o.currency ?? 'usd', o.paid ?? NOW - DAY, o.source ?? null, NOW - 2 * DAY, NOW - DAY);
  return pid;
}

const fetchMock = vi.fn(async () => new Response('ok'));
beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

// ───────────── 4. One sale definition across tabs ─────────────
describe('paid sales: one definition shared by Command, Funnel maps, the Sprint board and the Financial model', () => {
  it('counts paid and refunded sales in the range, revenue net of refunds, kinds and source bound', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const a = lead(db), b = lead(db), c = lead(db);
    pass(db, { lead: a, kind: 'seat', amount: 10_000 });
    pass(db, { lead: b, kind: 'seat', status: 'refunded', amount: 10_000, refunded: 10_000 });
    pass(db, { lead: c, kind: 'seat', status: 'pending', amount: 10_000, paid: NOW - DAY });
    pass(db, { lead: c, kind: 'seat', amount: 10_000, paid: NOW - 40 * DAY }); // outside the range
    pass(db, { lead: a, kind: 'offer', amount: 300_000, refunded: 50_000 });
    pass(db, { lead: a, kind: 'deposit', amount: 500_000, source: 'live' });
    pass(db, { lead: b, kind: 'deposit', amount: 500_000, source: 'challenge', status: 'refunded', refunded: 500_000 });
    const r = { from: NOW - 7 * DAY, to: NOW };
    const seat = await paidSales(rt.env.DB, { table: 'webinar_passes', kinds: ['seat'] }, r);
    expect(seat.n).toBe(2);
    expect(netMajor(seat)).toBe(100);
    const sprint = await paidSales(rt.env.DB, { table: 'webinar_passes', kinds: ['offer'] }, r);
    expect([sprint.n, netMajor(sprint)]).toEqual([1, 2500]);
    expect((await paidSales(rt.env.DB, { table: 'webinar_passes', kinds: ['deposit'], source: 'challenge' }, r)).n).toBe(1);
    expect(() => salesSql({ table: 'webinar_passes', kinds: ["seat'; DROP TABLE leads; --"] })).toThrow();
    expect(PAID_SALE).toBe("status IN ('paid', 'refunded')");

    // Every tab now reports the same ticket and Sprint numbers for the same range.
    const cmd = await rawCounts(rt, r);
    const auto = await mapCounts(rt, 'auto', r);
    const live = await mapCounts(rt, 'live', r);
    const ch = await mapCounts(rt, 'challenge', r);
    const ladder = await ladderReport(rt, r);
    const step = (k: string) => ladder.steps.find((s) => s.key === k)!;
    expect(cmd.tickets).toBe(2);
    expect(auto.ticket.n).toBe(2);
    expect(step('tickets').n).toBe(2); // was 1: the Sprint board left the refunded ticket out
    expect(auto.ticket.revenue).toBe(100);
    expect(step('tickets').revenue).toBe(100);
    expect([cmd.sprint_sales, auto.sprint.n, step('sprints').n]).toEqual([1, 1, 1]);
    expect([cmd.sprint_revenue, auto.sprint.revenue, step('sprints').revenue]).toEqual([2500, 2500, 2500]);
    // Deposits: Command counts both funnels; the maps split them by source from the same rows.
    expect(cmd.deposits).toBe(2);
    expect((live.deposit.n ?? 0) + (ch.deposit.n ?? 0)).toBe(2);
    expect(cmd.deposit_revenue).toBe((live.deposit.revenue ?? 0) + (ch.deposit.revenue ?? 0));
    expect(ch.deposit.revenue).toBe(0); // fully refunded: the challenge_deposits mirror used to show it gross
  });
});

// ───────────── 1. Checks ─────────────
function seedChecks(db: DatabaseSync) {
  // Leads: one with a source, one without (made by an import), one whose visitor carries the source.
  const good = lead(db, { channel: 'Paid Social', utm: 'facebook', phone: '+61412345678', tz: 'Australia/Sydney' });
  db.prepare("INSERT INTO visitors (id, created_at, last_seen_at, ft_channel) VALUES ('v1', ?, ?, 'Organic Search')").run(NOW - 2 * DAY, NOW - 2 * DAY);
  lead(db, { visitor: 'v1' });
  const bare = lead(db, { source: 'calendly-import', phone: '0412 345', tz: 'Mars/Base' });
  // Duplicates: case, plus-tag and Gmail dots.
  const d1a = lead(db, { email: 'jo.smith@gmail.com', channel: 'Direct', created: NOW - 30 * DAY });
  const d1b = lead(db, { email: 'Josmith+webinar@Gmail.com', channel: 'Direct', created: NOW - 30 * DAY });
  // Registrations: one with its lead, one whose lead row is missing.
  db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at) VALUES ('wr1', 't1', 's1', ?, ?)").run(good, NOW - DAY);
  db.prepare("INSERT INTO live_webinar_regs (id, token, event_id, lead_id, created_at) VALUES ('lr1', 't2', 'e1', 'lead_gone', ?)").run(NOW - DAY);
  // Payments: one attributed and sent to Meta, one with neither, one challenge order with neither.
  const p1 = pass(db, { lead: good, kind: 'seat' });
  db.prepare("INSERT INTO attr_conversions (id, kind, funnel, ref_id, lead_id, occurred_at, lt_channel, created_at, updated_at) VALUES ('ac1', 'ticket_paid', 'auto', ?, ?, ?, 'Paid Social', ?, ?)").run(p1, good, NOW - DAY, NOW, NOW);
  db.prepare("INSERT INTO events (id, ts, name, lead_id, source, props) VALUES ('ev_p1', ?, 'webinar_seat_purchased', ?, 'webhook', ?)").run(NOW - DAY, good, JSON.stringify({ pass_id: p1 }));
  db.prepare("INSERT INTO forward_log (event_id, dest, event_name, ts, status, match_keys, updated_at) VALUES ('ev_p1', 'meta', 'Purchase', ?, 'sent', 'em,ph,fbp,external_id', ?)").run(NOW - DAY, NOW);
  pass(db, { lead: bare, kind: 'deposit', source: 'live' });
  db.prepare("INSERT INTO challenge_orders (id, reg_id, lead_id, kind, status, amount, currency, created_at, updated_at, paid_at) VALUES ('co1', 'cr1', ?, 'ticket', 'paid', 4700, 'usd', ?, ?, ?)").run(bare, NOW - DAY, NOW, NOW - DAY);
  // Meta events: one without email or phone; a failed GA4 send; one still retrying.
  db.prepare("INSERT INTO forward_log (event_id, dest, event_name, ts, status, match_keys, updated_at) VALUES ('ev_lead', 'meta', 'Lead', ?, 'sent', 'fbp,client_ip_address', ?)").run(NOW - DAY, NOW);
  db.prepare("INSERT INTO forward_log (event_id, dest, event_name, ts, status, updated_at) VALUES ('ev_f', 'ga4', 'generate_lead', ?, 'failed', ?)").run(NOW - DAY, NOW);
  db.prepare("INSERT INTO forward_log (event_id, dest, event_name, ts, status, updated_at) VALUES ('ev_r', 'meta', 'Lead', ?, 'retrying', ?)").run(NOW - DAY, NOW);
  // Emails: 10 sent, one bounce.
  for (let i = 0; i < 10; i++) db.prepare("INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, sent_at, created_at) VALUES (?, ?, 'x', ?, 't', 'a@example.com', ?, 'sent', ?, ?)").run(`em${i}`, good, i, NOW - DAY, NOW - DAY, NOW - DAY);
  db.prepare("INSERT INTO email_suppressions (email, reason, created_at) VALUES (?, 'bounced', ?)").run(`${bare}@example.com`, NOW - DAY);
  // Rooms: a webinar room with an attendee and no minute curve; one with a curve; a meeting room (no curve expected).
  for (const [rid, mode] of [['room_a', 'webinar'], ['room_b', 'webinar'], ['room_c', 'meeting']]) {
    db.prepare("INSERT INTO rooms (id, mode, title, ref_type, went_live_at, created_at, updated_at) VALUES (?, ?, 'Room', 'none', ?, ?, ?)").run(rid, mode, NOW - DAY, NOW - 2 * DAY, NOW);
    db.prepare("INSERT INTO room_attendance (room_id, who, role, first_at, last_at, minutes) VALUES (?, 'p1', 'attendee', ?, ?, 30)").run(rid, NOW - DAY, NOW - DAY + 1_800_000);
  }
  db.prepare("INSERT INTO room_minutes (room_id, minute, n) VALUES ('room_b', 0, 1)").run();
  // AI calls: one queued two hours past its time, one due in the future, one dialling for 3 hours.
  db.prepare("INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, created_at, updated_at) VALUES ('oc1', ?, 'confirm', 'queued', ?, ?, ?)").run(good, NOW - 2 * 3_600_000, NOW - DAY, NOW - DAY);
  db.prepare("INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, created_at, updated_at) VALUES ('oc2', ?, 'confirm', 'queued', ?, ?, ?)").run(good, NOW + 3_600_000, NOW - DAY, NOW - DAY);
  db.prepare("INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, created_at, updated_at) VALUES ('oc3', ?, 'confirm', 'dialing', ?, ?, ?)").run(bare, NOW - 4 * 3_600_000, NOW - DAY, NOW - 3 * 3_600_000);
  return { good, bare, d1a, d1b };
}

describe('data-quality checks', () => {
  it('computes every check from real rows, with counts and example ids', async () => {
    const db = freshDb();
    const ids = seedChecks(db);
    const rt = makeRt(db, { META_PIXEL_ID: '1', META_ACCESS_TOKEN: 'x' });
    const res = await runChecks(rt, NOW);
    const by = Object.fromEntries(res.map((r) => [r.key, r])) as Record<string, CheckResult>;
    expect(res.map((r) => r.key)).toEqual([...CHECK_KEYS]);

    expect(by.leads_no_attribution).toMatchObject({ n: 1, total: 3, examples: [ids.bare] });
    expect(by.leads_no_attribution.detail).toMatchObject({ byOrigin: { 'calendly-import': 1 } });
    expect(by.regs_no_lead).toMatchObject({ n: 1, total: 2, examples: ['lr1'] });
    expect(by.payments_no_attribution).toMatchObject({ n: 2, total: 3 });
    expect(by.payments_no_attribution.examples).toEqual([ids.bare, ids.bare]);
    expect((by.payments_no_attribution.detail as { byKind: Record<string, { paid: number; missing: number }> }).byKind.ticket).toMatchObject({ paid: 1, missing: 1 });
    expect(by.payments_no_capi).toMatchObject({ n: 2, total: 3 });
    expect(by.capi_match_keys).toMatchObject({ n: 1, total: 2, examples: ['ev_lead'] });
    const purchase = (by.capi_match_keys.detail as { perEvent: { event: string; em: number; fbc: number }[] }).perEvent.find((e) => e.event === 'Purchase')!;
    expect([purchase.em, purchase.fbc]).toEqual([1, 0]);
    expect(by.forward_failures).toMatchObject({ n: 1, examples: ['ev_f'], detail: { retrying: 1 } });
    expect(by.email_bounces).toMatchObject({ n: 1, total: 10, examples: [ids.bare] });
    expect(isWarn(by.email_bounces)).toBe(true); // 10% bounce rate
    expect(isWarn({ key: 'email_bounces', n: 1, total: 100, detail: { bounced: 1, complained: 0 } })).toBe(false); // 1% is under the 2% line
    expect(by.rooms_no_minutes).toMatchObject({ n: 1, total: 2, examples: ['room_a'] });
    expect(by.ai_calls_stuck).toMatchObject({ n: 2, total: 3, detail: { queued: 1, dialing: 1 } });
    expect(by.duplicate_leads).toMatchObject({ n: 1, examples: [ids.d1a, ids.d1b] });
    expect(by.contact_format).toMatchObject({ n: 1, examples: [ids.bare], detail: { phone: 1, timezone: 1 } });
  });

  it('says "not measured" instead of guessing when Meta is not connected', async () => {
    const db = freshDb();
    const res = await runChecks(makeRt(db), NOW);
    const capi = res.find((r) => r.key === 'payments_no_capi')!;
    expect(capi.n).toBeNull();
    expect(capi.note).toMatch(/not connected/);
    expect(isWarn(capi)).toBe(false);
    expect(res.find((r) => r.key === 'leads_no_attribution')).toMatchObject({ n: 0, total: 0 });
  });

  it('normalises emails and validates phones', () => {
    expect(normaliseEmail(' J.O.Smith+x@GoogleMail.com ')).toBe('josmith@gmail.com');
    expect(normaliseEmail('a.b+c@work.com')).toBe('a.b@work.com');
    expect(normaliseEmail('nope')).toBeNull();
    expect([validPhone('+61412345678'), validPhone('0412345678'), validPhone('+0412345678'), validPhone('+6141')]).toEqual([true, false, false, false]);
  });

  it('every label, description and fix link passes the copy rules and points into Funnel HQ', () => {
    for (const k of CHECK_KEYS) {
      const d = CHECKS[k];
      expect(auditCopy(`${d.label}. ${d.what}`), k).toEqual([]);
      expect(d.fix.href).toMatch(/^\/admin#[a-z]+$/);
      expect(d.what).not.toMatch(/—/);
    }
  });
});

// ───────────── Storage, trend, Command item ─────────────
describe('daily run, trend vs yesterday, and the Command brief item', () => {
  it('stores each day additively, compares with the day before and summarises it', async () => {
    const db = freshDb();
    seedChecks(db);
    const rt = makeRt(db);
    const yesterday: CheckResult[] = CHECK_KEYS.map((k) => ({ key: k, n: k === 'leads_no_attribution' ? 3 : 0, total: 5, examples: [] }));
    await saveResults(rt, '2026-11-01', yesterday, NOW - DAY);
    const run = await runDataQuality(rt, NOW);
    expect(run.day).toBe('2026-11-02');
    const all = await loadResults(rt, '2026-10-01');
    expect(new Set(all.map((r) => r.day))).toEqual(new Set(['2026-11-01', '2026-11-02']));
    const leadsRow = run.rows.find((r) => r.def.key === 'leads_no_attribution')!;
    expect([leadsRow.today?.n, leadsRow.yesterday?.n, leadsRow.delta]).toEqual([1, 3, -2]);
    // A re-run the same day replaces that day's row (no duplicates).
    await runDataQuality(rt, NOW + 60_000);
    expect((await loadResults(rt, '2026-11-02')).length).toBe(CHECK_KEYS.length);
    expect(prevDay('2026-03-01')).toBe('2026-02-28');

    const s = composeSummary(run.rows, 'Mon 2 Nov');
    expect(s.title).toBe('Data quality, Mon 2 Nov');
    expect(s.markdown).toContain('**Leads with no source**: 1 of 3 (-2 vs yesterday) · [Fix in Links & videos](/admin#links)');
    expect(s.markdown).toContain('Payments not sent to Meta: Meta Conversions API is not connected');
    expect(s.markdown).not.toMatch(/—|!/);
  });

  it('runs once a day after 6am, posts a brief item into Command, and sends to Slack only when the brief already does', async () => {
    const db = freshDb();
    const early = Date.parse('2026-11-01T18:00:00Z'); // 05:00 in Sydney
    expect(await maybeRunDataQuality(makeRt(db), early)).toBeNull();
    const rt = makeRt(db);
    const first = await maybeRunDataQuality(rt, NOW);
    expect(first).toMatchObject({ day: '2026-11-02' });
    expect(await maybeRunDataQuality(rt, NOW + 600_000)).toBeNull(); // claimed for the day
    const th = db.prepare("SELECT kind, title FROM ops_threads WHERE kind = 'brief'").all() as { title: string }[];
    expect(th).toHaveLength(1);
    expect(th[0].title).toMatch(/^Data quality, /);
    expect(fetchMock).not.toHaveBeenCalled(); // no Slack configured: nothing leaves the app

    const run = await runDataQuality(rt, NOW);
    const slackOn = makeRt(db, { OPS_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' });
    const sent = await postSummary(slackOn, run.rows, NOW, fetchMock as unknown as typeof fetch);
    expect(sent.sent.slack).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    const briefOff = makeRt(db, { OPS_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', OPS_BRIEF_TIME: 'off' });
    const quiet = await postSummary(briefOff, run.rows, NOW, fetchMock as unknown as typeof fetch);
    expect(quiet.sent.slack).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(compare([], []).every((r) => r.today == null && !r.warn)).toBe(true);
  });
});

// ───────────── 3. Exports ─────────────
async function readAll(s: ReadableStream<Uint8Array>) { return new Response(s).text(); }

describe('exports', () => {
  it('escapes CSV, guards against spreadsheet formulas and formats times and money', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+61 4')).toBe("'+61 4");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(cellValue('paid_at', { paid_at: Date.UTC(2026, 0, 2) }, {})).toBe('2026-01-02T00:00:00.000Z');
    expect(cellValue('amount', { amount: 12_345, currency: 'usd' }, DATASETS.payments)).toBe(123.45);
    expect(cellValue('amount', { amount: 5000, currency: 'jpy' }, DATASETS.payments)).toBe(5000);
  });

  it('streams leads without personal details by default and with them only when asked', async () => {
    const db = freshDb();
    const ids = seedChecks(db);
    const rt = makeRt(db);
    const r = { from: NOW - 7 * DAY, to: NOW };
    expect(exportColumns(DATASETS.leads, false)).not.toContain('email');
    const plain = await readAll(exportStream(rt, DATASETS.leads, { format: 'csv', pii: false, ...r }));
    const lines = plain.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0].split(',')).not.toContain('email');
    expect(lines).toHaveLength(4); // header + 3 leads in the range
    expect(plain).not.toContain('@example.com');
    expect(plain).toContain(ids.bare);
    const full = await readAll(exportStream(rt, DATASETS.leads, { format: 'csv', pii: true, ...r }));
    expect(full).toContain(`${ids.bare}@example.com`);
    const json = JSON.parse(await readAll(exportStream(rt, DATASETS.payments, { format: 'json', pii: false, ...r }))) as Record<string, unknown>[];
    expect(json).toHaveLength(3);
    expect(json.find((x) => x.source_table === 'webinar_passes' && x.lt_channel === 'Paid Social')).toMatchObject({ amount: 100, currency: 'usd' });
    expect(Object.keys(json[0])).not.toContain('email');
    expect(await countRows(rt, DATASETS.registrations, r.from, r.to)).toBe(2);
    for (const k of Object.keys(DATASETS)) {
      const out = await readAll(exportStream(rt, DATASETS[k], { format: 'json', pii: true, ...r }));
      expect(() => JSON.parse(out), k).not.toThrow();
    }
  });

  it('stops at the row cap and calls back with the rows written', async () => {
    const db = freshDb();
    for (let i = 0; i < 30; i++) lead(db);
    const rt = makeRt(db);
    let done = -1;
    const out = await readAll(exportStream(rt, DATASETS.leads, { format: 'csv', pii: false, from: NOW - 7 * DAY, to: NOW, cap: 12, onDone: (n) => { done = n; } }));
    expect(out.trim().split('\r\n')).toHaveLength(13);
    expect(done).toBe(12);
    expect(EXPORT_ROW_CAP).toBe(50_000);
  });

  it('writes an audit row and a Command activity entry', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const xid = await auditExport(rt, { dataset: 'leads', format: 'csv', from: 1, to: 2, pii: true, rows: 7, capped: false, ip: '1.2.3.4', label: 'leads with attribution' });
    const row = db.prepare('SELECT * FROM dq_exports WHERE id = ?').get(xid) as Record<string, unknown>;
    expect(row).toMatchObject({ dataset: 'leads', pii: 1, rows: 7, actor: 'admin' });
    expect(String(row.ip_hash)).not.toContain('1.2.3.4');
    const act = db.prepare("SELECT summary FROM ops_actions WHERE kind = 'data.export'").get() as { summary: string };
    expect(act.summary).toBe('Exported 7 rows of leads with attribution (CSV, with personal details)');
  });

  it('the route needs an admin session, logs the download and includes personal details only when asked', async () => {
    const db = freshDb();
    const ids = seedChecks(db);
    const env = { DB: d1(db), SESSION_SECRET: 'test-secret-0123456789', ADMIN_PASSWORD: 'devpass' };
    const exec = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('settings', { ...BASE } as never); c.set('reps', []); await next(); });
    app.post('/login', async (c) => c.json(await login(c, 'devpass')));
    app.route('/admin/api/dataq', dataqAdmin);
    const q = '/admin/api/dataq/export?dataset=leads&format=csv&from=2026-10-26&to=2026-11-02';
    expect((await app.request(q, {}, env, exec)).status).toBe(401);
    const lr = await app.request('http://localhost/login', { method: 'POST', headers: { origin: 'http://localhost' } }, env, exec);
    const cookie = (lr.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).toMatch(/^_fa=/);
    const res = await app.request(`http://localhost${q}`, { headers: { cookie } }, env, exec);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('leads-2026-10-26-to-2026-11-02-no-pii.csv');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain(ids.bare);
    expect(body).not.toContain('@example.com');
    const withPii = await (await app.request(`http://localhost${q}&pii=1`, { headers: { cookie } }, env, exec)).text();
    expect(withPii).toContain('@example.com');
    const audit = db.prepare('SELECT pii, rows, finished_at FROM dq_exports ORDER BY created_at').all() as { pii: number; rows: number; finished_at: number | null }[];
    expect(audit.map((a) => a.pii)).toEqual([0, 1]);
    expect(audit.every((a) => a.finished_at != null)).toBe(true);
    expect((await app.request(`http://localhost/admin/api/dataq/export?dataset=nope&from=2026-10-26&to=2026-11-02`, { headers: { cookie } }, env, exec)).status).toBe(400);
    expect((await app.request(`http://localhost/admin/api/dataq/export?dataset=leads&from=2024-01-01&to=2026-11-02`, { headers: { cookie } }, env, exec)).status).toBe(400);
    const dash = await (await app.request('http://localhost/admin/api/dataq', { headers: { cookie } }, env, exec)).json() as { checks: unknown[]; datasets: unknown[]; exports: unknown[] };
    expect(dash.checks).toHaveLength(CHECK_KEYS.length);
    expect(dash.exports).toHaveLength(2);
  });
});

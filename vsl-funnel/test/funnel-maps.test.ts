import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { SETTINGS } from '../src/settings';
import { FUNNEL_MAPS, mapById } from '../src/admin/funnel-maps-defs';
import { buildMap, cleanCustom, cleanLayout, conversions, mapCounts, mapsOverview, mountFunnelMaps, settingViews } from '../src/admin/funnel-maps';

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
const SET: Record<string, string> = { SALES_TIMEZONE: 'America/New_York', WHOP_API_KEY: 'apik_secret_value', ENGAGEMENT_DEPOSIT: '5000', LIVE_OFFER_HOURS: '' };
const makeRt = (db: DatabaseSync) => ({ env: { DB: d1(db) }, settings: { ...SET }, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;

const NOW = Date.now(), DAY = 86_400_000, HOUR = 3_600_000;
const T = NOW - 2 * DAY; // inside the default 30-day range
const OLD = NOW - 90 * DAY; // outside it
const range = { from: NOW - 30 * DAY, to: NOW };

function ins(db: DatabaseSync, table: string, row: Record<string, unknown>) {
  const k = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')})`).run(...(Object.values(row) as (string | number | null)[]));
}
let leadN = 0;
function lead(db: DatabaseSync, o: Record<string, unknown> = {}) {
  const id = `l${++leadN}`;
  ins(db, 'leads', { id, ref_code: `r${leadN}`, created_at: T, updated_at: T, email: `${id}@x.test`, status: 'applied', ...o });
  return id;
}

function seed(db: DatabaseSync) {
  // VSL: two A-tier applications, one booked and won, one lost; one C-tier; a direct Calendly booking; one old lead outside the range.
  const a1 = lead(db, { tier: 'A', score: 80, app_completed_at: T, booked_at: T, call_at: T + HOUR, status: 'won', closed_at: T + 2 * HOUR, revenue: 50000 });
  lead(db, { tier: 'A', score: 75, app_completed_at: T, status: 'lost', closed_at: T + HOUR });
  lead(db, { tier: 'C', score: 20, app_completed_at: T, status: 'nurture' });
  lead(db, { booked_at: T, call_at: T + HOUR, status: 'booked', booking_source: 'calendly-direct' });
  lead(db, { tier: 'A', app_completed_at: OLD, created_at: OLD, booked_at: OLD, status: 'won', closed_at: OLD });
  ins(db, 'sessions', { id: 's1', visitor_id: 'v1', started_at: T, last_seen_at: T, channel: 'Paid Social', landing_path: '/for/dental', is_bot: 0 });
  ins(db, 'sessions', { id: 's2', visitor_id: 'v2', started_at: T, last_seen_at: T, channel: 'Paid Social', landing_path: '/', is_bot: 0 });
  ins(db, 'sessions', { id: 's3', visitor_id: 'v3', started_at: T, last_seen_at: T, channel: 'Direct', landing_path: '/', is_bot: 0 });
  ins(db, 'sessions', { id: 's4', visitor_id: 'v4', started_at: OLD, last_seen_at: OLD, channel: 'Paid Social', landing_path: '/', is_bot: 0 });
  ins(db, 'emails', { id: 'e1', lead_id: a1, sequence: 'tier_a', step: 0, template: 'a_approved', to_email: 'x', send_at: T, created_at: T, sent_at: T, status: 'sent' });
  ins(db, 'emails', { id: 'e2', lead_id: a1, sequence: 'tier_a', step: 1, template: 'a_reminder', to_email: 'x', send_at: T, created_at: T, sent_at: OLD, status: 'sent' });
  ins(db, 'outbound_calls', { id: 'c1', lead_id: a1, kind: 'confirm', status: 'done', run_at: T, created_at: T, updated_at: T });

  // Automated webinar: three registrations, two joined, one reached the pitch and bought the Sprint after a ticket; one Deal Plan held; one signed with the Sprint credit.
  ins(db, 'webinar_sessions', { id: 'ws1', starts_at: T, created_at: T });
  const w = [lead(db), lead(db), lead(db)];
  w.forEach((l, i) => ins(db, 'webinar_registrations', { id: `wr${i}`, token: `wt${i}`, session_id: 'ws1', lead_id: l, created_at: T - HOUR, joined_at: i < 2 ? T : null, offer_unlocked_at: i === 0 ? T + 38 * 60_000 : null }));
  ins(db, 'webinar_passes', { id: 'p_seat', reg_id: 'wr0', lead_id: w[0], kind: 'seat', status: 'paid', amount: 10000, currency: 'usd', paid_at: T - HOUR, created_at: T, updated_at: T });
  ins(db, 'webinar_passes', { id: 'p_offer', reg_id: 'wr0', lead_id: w[0], kind: 'offer', status: 'paid', amount: 290000, currency: 'usd', paid_at: T + HOUR, created_at: T, updated_at: T });
  ins(db, 'deal_sprints', { pass_id: 'p_offer', lead_id: w[0], plan_held_at: T + 6 * DAY > NOW ? T + HOUR : T, proposal_sent_at: T + HOUR, created_at: T, updated_at: T });
  ins(db, 'contracts', { id: 'k1', token: 'kt1', lead_id: w[0], title: 'Engagement', fee: 50000, created_at: T, signed_at: T + 2 * HOUR, credit_pass_id: 'p_offer' });

  // Live webinar: two registrations, one joined and saw the offer, one live deposit.
  ins(db, 'live_webinars', { id: 'lw1', title: 'Live', starts_at: T, tz: 'UTC', created_at: T, updated_at: T });
  const lv = [lead(db), lead(db)];
  lv.forEach((l, i) => ins(db, 'live_webinar_regs', { id: `lr${i}`, token: `lt${i}`, event_id: 'lw1', lead_id: l, created_at: T - HOUR, joined_at: i === 0 ? T : null, offer_seen_at: i === 0 ? T + HOUR : null }));
  ins(db, 'webinar_passes', { id: 'p_dep', reg_id: 'lr0', lead_id: lv[0], kind: 'deposit', source: 'live', ref_id: 'lw1', status: 'paid', amount: 500000, currency: 'usd', paid_at: T + HOUR, created_at: T, updated_at: T });

  // Challenge: one paid ticket with VIP, Day 1 attended, one worksheet, one deposit.
  ins(db, 'challenge_cohorts', { id: 'co1', name: 'C1', start_date: '2026-10-01', start_time: '18:00', timezone: 'UTC', created_at: T, updated_at: T });
  const ch = lead(db);
  ins(db, 'challenge_registrations', { id: 'cr1', token: 'ct1', cohort_id: 'co1', lead_id: ch, created_at: T, status: 'paid', vip: 1, paid_at: T });
  ins(db, 'challenge_orders', { id: 'o1', reg_id: 'cr1', lead_id: ch, kind: 'ticket', status: 'paid', amount: 10000, currency: 'usd', paid_at: T, created_at: T, updated_at: T });
  ins(db, 'challenge_orders', { id: 'o2', reg_id: 'cr1', lead_id: ch, kind: 'vip', status: 'paid', amount: 30000, currency: 'usd', paid_at: T, created_at: T, updated_at: T });
  ins(db, 'challenge_progress', { reg_id: 'cr1', day: 1, present_at: T });
  ins(db, 'challenge_homework', { reg_id: 'cr1', cohort_id: 'co1', day: 1, answers: '{}', created_at: T, updated_at: T });
  ins(db, 'challenge_deposits', { reg_id: 'cr1', cohort_id: 'co1', lead_id: ch, started_at: T, paid_at: T + HOUR, amount: 490000, currency: 'usd' });

  // DMs: a comment thread that became Hot, was replied to and booked; a story reply.
  ins(db, 'dm_threads', { id: 'd1', ig_user_id: 'ig1', source: 'comment', band: 'hot', created_at: T, updated_at: T, replied_at: T, booked_at: T + HOUR });
  ins(db, 'dm_threads', { id: 'd2', ig_user_id: 'ig2', source: 'story_reply', band: 'cold', created_at: T, updated_at: T });

  // Long flows: a reactivation that came back.
  const rx = lead(db, { app_completed_at: T + DAY });
  ins(db, 'lead_reactivation', { lead_id: rx, reactivated_at: T, segment: 'applied' });

  // After the sale and the AI departments.
  ins(db, 'cs_clients', { lead_id: w[0], client_type: 'sprint', since_at: T, band: 'at_risk', created_at: T, updated_at: T });
  ins(db, 'support_threads', { id: 'st1', channel: 'email', escalated: 1, created_at: T, updated_at: T });
  ins(db, 'ops_actions', { id: 'a1', dept: 'marketing', kind: 'marketing.pause_ad', summary: 'Pause', actor: 'ai', status: 'proposed', created_at: T, updated_at: T });
  ins(db, 'ops_actions', { id: 'a2', dept: 'ops', kind: 'ops.document', summary: 'Logged', actor: 'ai', status: 'done', created_at: T, updated_at: T });
}

// ───────────── the definitions ─────────────

const adminJs = fs.readFileSync(`${node.cwd()}/public/assets/admin.js`, 'utf8');
const TAB_IDS = new Set([...adminJs.matchAll(/^ {4}(\w+): \{ group: '/gm)].map((m) => m[1]));
const SETTING_KEYS = new Set(SETTINGS.map((s) => s.key as string));

function strings(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const m of FUNNEL_MAPS) {
    out.push({ where: `${m.id}.title`, text: m.title }, { where: `${m.id}.short`, text: m.short }, { where: `${m.id}.summary`, text: m.summary });
    for (const s of m.stages) {
      for (const k of ['title', 'sub', 'sees', 'behind'] as const) if (s[k]) out.push({ where: `${m.id}.${s.id}.${k}`, text: s[k]! });
      if (s.page?.label) out.push({ where: `${m.id}.${s.id}.page`, text: s.page.label });
      for (const a of s.autos ?? []) out.push({ where: `${m.id}.${s.id}.auto`, text: a.label }, { where: `${m.id}.${s.id}.timing`, text: a.timing });
    }
    for (const e of m.edges) if (e[2]) out.push({ where: `${m.id}.edge`, text: e[2] });
  }
  return out;
}

describe('funnel map definitions', () => {
  it('has the eight funnels from the brief', () => {
    expect(FUNNEL_MAPS.map((m) => m.id)).toEqual(['vsl', 'auto', 'live', 'challenge', 'dm', 'nurture', 'after', 'ops']);
  });

  it('every stage explanation passes the copy rules (no hedges, emojis, em dashes, "free" calls)', () => {
    const bad = strings().flatMap((s) => [
      ...auditCopy(s.text).map((i) => `${s.where}: ${i.rule}: ${i.excerpt}`),
      ...(/—/.test(s.text) ? [`${s.where}: em dash`] : []),
      ...(/\bfree\b/i.test(s.text) && /\b(call|session|consult)/i.test(s.text) ? [`${s.where}: "free" near a call`] : []),
    ]);
    expect(bad).toEqual([]);
  });

  it('every stage links to a Funnel HQ tab that exists, and every setting key is a real setting', () => {
    expect(TAB_IDS.size).toBeGreaterThan(20);
    const missing: string[] = [];
    for (const m of FUNNEL_MAPS) for (const s of m.stages) {
      if (!TAB_IDS.has(s.tab)) missing.push(`${m.id}.${s.id} → tab ${s.tab}`);
      for (const k of s.settings ?? []) if (!SETTING_KEYS.has(k)) missing.push(`${m.id}.${s.id} → setting ${k}`);
      if (s.page && !s.page.path.startsWith('/')) missing.push(`${m.id}.${s.id} → page ${s.page.path}`);
    }
    expect(missing).toEqual([]);
  });

  it('ids are unique, and edges, ladders and conversion sources point at real stages', () => {
    for (const m of FUNNEL_MAPS) {
      const ids = m.stages.map((s) => s.id);
      expect(new Set(ids).size, m.id).toBe(ids.length);
      for (const e of m.edges) { expect(ids, `${m.id} edge ${e[0]}`).toContain(e[0]); expect(ids, `${m.id} edge ${e[1]}`).toContain(e[1]); }
      for (const l of m.ladder) expect(ids, `${m.id} ladder`).toContain(l);
      for (const s of m.stages) if (s.from && s.from !== 'qualified') expect(ids, `${m.id}.${s.id}.from`).toContain(s.from);
      for (const s of m.stages) expect(s.behind.length, `${m.id}.${s.id}`).toBeGreaterThan(20);
    }
  });

  it('keeps the original VSL box ids, so the layout and custom boxes saved today still load', () => {
    const ids = mapById('vsl')!.stages.map((s) => s.id);
    for (const id of ['meta', 'youtube', 'organic', 'caldirect', 'smart', 'landers', 'main', 'vsl', 'apply', 'score', 'tierA', 'tierB', 'tierC', 'booked', 'call', 'won', 'lost', 'noshow',
      'rebookcall', 'cancel', 'cxseq', 'onboard', 'lostseq', 'aicall', 'precall', 'reppings', 'postcall', 'nurture', 'dossier', 'abandon', 'speed', 'tierseq', 'tracking', 'profile', 'triggers', 'personal', 'callback', 'wroom']) {
      expect(ids).toContain(id);
    }
  });
});

// ───────────── live numbers on real SQLite ─────────────

describe('funnel map counts', () => {
  it('every count key a stage uses is produced, and an empty database shows zeros, not invented numbers', async () => {
    const rt = makeRt(freshDb());
    for (const m of FUNNEL_MAPS) {
      const counts = await mapCounts(rt, m.id, range);
      for (const s of m.stages) if (s.count) {
        expect(counts[s.count], `${m.id}.${s.count}`).toBeDefined();
        expect(counts[s.count].n, `${m.id}.${s.count}`).toBe(0);
      }
    }
  });

  it('counts each funnel from its own tables and honours the date range', async () => {
    const db = freshDb();
    seed(db);
    const rt = makeRt(db);
    const vsl = await mapCounts(rt, 'vsl', range);
    expect(vsl.meta.n).toBe(2);
    expect(vsl.organic.n).toBe(1);
    expect(vsl.main.n).toBe(2);
    expect(vsl.direct_booked.n).toBe(1);
    expect(vsl.tier_a.n).toBe(2);
    expect(vsl.tier_c.n).toBe(1);
    expect(vsl.won.n).toBe(1);
    expect(vsl.won.revenue).toBe(50000);
    expect(vsl.lost.n).toBe(1);

    const auto = await mapCounts(rt, 'auto', range);
    expect([auto.registered.n, auto.ticket.n, auto.attended.n, auto.unlocked.n, auto.sprint.n, auto.plan_held.n, auto.signed.n]).toEqual([3, 1, 2, 1, 1, 1, 1]);
    expect(auto.sprint.revenue).toBe(2900);
    expect(auto.sprint.currency).toBe('USD');
    expect(auto.missed.n).toBe(1);

    const live = await mapCounts(rt, 'live', range);
    expect([live.registered.n, live.joined.n, live.offer_seen.n, live.deposit.n]).toEqual([2, 1, 1, 1]);
    expect(live.deposit.revenue).toBe(5000);

    const ch = await mapCounts(rt, 'challenge', range);
    expect([ch.registered.n, ch.ticket.n, ch.vip.n, ch.day1.n, ch.day2.n, ch.homework.n, ch.deposit.n]).toEqual([1, 1, 1, 1, 0, 1, 1]);

    const dm = await mapCounts(rt, 'dm', range);
    expect([dm.threads.n, dm.src_comment.n, dm.src_story.n, dm.hot.n, dm.replied.n, dm.booked.n]).toEqual([2, 1, 1, 1, 1, 1]);

    const nu = await mapCounts(rt, 'nurture', range);
    expect([nu.rx_launched.n, nu.rx_back.n]).toEqual([1, 1]);

    const after = await mapCounts(rt, 'after', range);
    expect([after.clients.n, after.at_risk.n, after.support.n, after.escalated.n, after.signed.n]).toEqual([1, 1, 1, 1, 1]);

    const ops = await mapCounts(rt, 'ops', range);
    expect(ops.proposed.n).toBe(1); // the logged action isn't a proposal

    // A range that ends before everything was seeded counts nothing.
    const before = await mapCounts(rt, 'auto', { from: NOW - 200 * DAY, to: NOW - 100 * DAY });
    expect(before.registered.n).toBe(0);
  });

  it('conversion is the share of the previous stage, shown only when it is a real share', async () => {
    const db = freshDb();
    seed(db);
    const rt = makeRt(db);
    const def = mapById('auto')!;
    const conv = conversions(def, await mapCounts(rt, 'auto', range));
    expect(conv.wticket.rate).toBeCloseTo(1 / 3);
    expect(conv.wticket.fromTitle).toBe('Registered');
    expect(conv.wsprint.rate).toBe(1);
    // VSL bookings convert from qualified (A + B), which is not a stage of its own.
    const v = conversions(mapById('vsl')!, await mapCounts(rt, 'vsl', range));
    expect(v.booked.fromTitle).toBe('Qualified (A + B)');
  });

  it('builds a map with automations counted and secrets shown only as set or not set', async () => {
    const db = freshDb();
    seed(db);
    const rt = makeRt(db);
    const vsl = await buildMap(rt, mapById('vsl')!, range);
    const tierseq = vsl.stages.find((s) => s.id === 'tierseq')!;
    const a = tierseq.autosView.find((x) => x.seq === 'tier_a')!;
    expect(a.steps).toBe(8);
    expect(a.sent).toBe(1); // the second email was sent outside the range
    expect(a.long).toBeGreaterThan(0);
    const confirm = vsl.stages.find((s) => s.id === 'aicall')!.autosView[0];
    expect(confirm.calls).toBe(1);
    const auto = await buildMap(rt, mapById('auto')!, range);
    const closing = auto.stages.find((s) => s.id === 'wpitch')!.autosView[0];
    expect(closing.steps).toBe(4); // only the Sprint closing emails, not the whole webinar sequence
    const ticket = auto.stages.find((s) => s.id === 'wticket')!;
    const key = ticket.settingsView.find((s) => s.key === 'WHOP_API_KEY')!;
    expect(key).toMatchObject({ secret: true, set: true, value: null });
    expect(JSON.stringify(auto)).not.toContain('apik_secret_value');
    const sv = settingViews(rt, ['ENGAGEMENT_DEPOSIT', 'LIVE_OFFER_HOURS', 'NOT_A_SETTING']);
    expect(sv.map((s) => [s.key, s.value])).toEqual([['ENGAGEMENT_DEPOSIT', '5000'], ['LIVE_OFFER_HOURS', null]]);
  });

  it('the overview gives every funnel its stage strip', async () => {
    const db = freshDb();
    seed(db);
    const all = await mapsOverview(makeRt(db), range);
    expect(all).toHaveLength(8);
    const auto = all.find((m) => m.id === 'auto')!;
    expect(auto.strip.map((s) => s.id)).toEqual(mapById('auto')!.ladder);
    expect(auto.strip[0].n?.n).toBe(3);
  });
});

// ───────────── routes and saved layouts ─────────────

describe('funnel map routes', () => {
  function app(db: DatabaseSync) {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => { c.set('settings', { ...SET } as never); c.set('reps', []); await next(); });
    mountFunnelMaps(a);
    return { a, env: { DB: d1(db) } };
  }

  it('serves one endpoint per map with the date range, and 404s an unknown map', async () => {
    const db = freshDb();
    seed(db);
    const { a, env } = app(db);
    const r = await a.request(`/maps/live?from=${range.from}&to=${range.to}`, {}, env);
    expect(r.status).toBe(200);
    const body = await r.json() as { stages: { id: string; n: { n: number } | null }[] };
    expect(body.stages.find((s) => s.id === 'ldeposit')!.n!.n).toBe(1);
    const old = await (await a.request(`/maps/live?from=${NOW - 200 * DAY}&to=${NOW - 100 * DAY}`, {}, env)).json() as typeof body;
    expect(old.stages.find((s) => s.id === 'ldeposit')!.n!.n).toBe(0);
    expect((await a.request('/maps/nope', {}, env)).status).toBe(404);
    expect(((await (await a.request('/maps', {}, env)).json()) as { maps: unknown[] }).maps).toHaveLength(8);
  });

  it('the VSL map reads and writes the layout saved by the old single map; other maps have their own', async () => {
    const db = freshDb();
    db.prepare("INSERT INTO kv_state (key, value) VALUES ('map:layout', ?)").run(JSON.stringify({ vsl: { x: 700, y: 300 } }));
    db.prepare("INSERT INTO kv_state (key, value) VALUES ('map:custom', ?)").run(JSON.stringify({ nodes: [{ id: 'u_abcd1234', kind: 'page', title: 'Mine' }], edges: [], edits: {} }));
    const { a, env } = app(db);
    expect(await (await a.request('/maps/vsl/layout', {}, env)).json()).toEqual({ layout: { vsl: { x: 700, y: 300 } } });
    expect(((await (await a.request('/maps/vsl/custom', {}, env)).json()) as { custom: { nodes: { title: string }[] } }).custom.nodes[0].title).toBe('Mine');
    expect(await (await a.request('/maps/auto/layout', {}, env)).json()).toEqual({ layout: null });
    const put = await a.request('/maps/auto/layout', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ layout: { wreg: { x: 12, y: 99999 }, 'bad id!': { x: 1, y: 1 } } }) }, env);
    expect(put.status).toBe(200);
    expect(await (await a.request('/maps/auto/layout', {}, env)).json()).toEqual({ layout: { wreg: { x: 12, y: 5000 } } });
    // The old map's keys are untouched by another map's save.
    expect((db.prepare("SELECT value FROM kv_state WHERE key = 'map:layout'").get() as { value: string }).value).toContain('700');
    await a.request('/maps/dm/custom', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ custom: { nodes: [{ id: 'u_zzzz9999', kind: 'auto', title: 'Note' }], edges: [['dmthread', 'u_zzzz9999', 'x']] } }) }, env);
    expect((db.prepare("SELECT value FROM kv_state WHERE key = 'map:dm:custom'").get() as { value: string }).value).toContain('u_zzzz9999');
  });

  it('cleans layouts and custom boxes', () => {
    expect(cleanLayout({ a: { x: -5, y: 10.4 }, b: { x: 'n', y: 1 } })).toEqual({ a: { x: 0, y: 10 } });
    const c = cleanCustom({ nodes: [{ id: 'u_ok12', kind: 'weird', title: '' }, { id: 'bad' }], edges: [['a', 'a'], ['a', 'b', 'lbl']] });
    expect(c.nodes).toEqual([{ id: 'u_ok12', kind: 'page', title: 'New step', sub: '', note: '', tab: null }]);
    expect(c.edges).toEqual([['a', 'b', 'lbl']]);
  });
});

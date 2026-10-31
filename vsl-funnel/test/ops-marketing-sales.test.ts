import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy, auditEmail } from '../src/content/copy-rules';
import { storeAdLevel, syncAdLevel } from '../src/integrations/meta-ads';
import { type AdStat, type DayRow, adsTargets, boundShift, fatigue, loadAdStats, loser, runAutopilot, verdicts, winner } from '../src/marketing/autopilot';
import { type Complete, auditDraft, draftAndPropose, writeAngleDrafts } from '../src/marketing/angles';
import { decideAction, getAction, hasActionHandler, listActions, proposeAction, updateActionPayload } from '../src/ops/actions';
import { type Candidate, approveBatch, baseEmail, baseSms, findCandidates, inEmailHours, matchSalesCommand, processFollowupQueue, proposeFollowups } from '../src/sales/followups';
import type { Lead } from '../src/funnel/leads';

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
const BASE: Record<string, string> = { META_ADS_TOKEN: 'read_tok', META_AD_ACCOUNT_ID: '123456', ADS_TARGET_CPA_TICKET: '150', SALES_TIMEZONE: 'Australia/Sydney', SITE_NAME: 'G&L', EMAIL_PERSONALIZE: '', SMS_ENABLED: '' };
const makeRt = (db: DatabaseSync, s: Record<string, string> = {}) =>
  ({ env: { DB: d1(db) }, settings: { ...BASE, ...s }, reps: [], origin: 'https://apply.test', waitUntil: () => undefined }) as unknown as Runtime;
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); });

const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

// ───────────── 1. Meta at ad level ─────────────

describe('Meta ads read at ad level', () => {
  it('pulls daily insights per ad (all pages) plus ads, ad sets and campaigns into D1', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/insights?') && !u.includes('page=2')) return json(200, { data: [{ ad_id: '9001', ad_name: 'Hook A', adset_id: '801', campaign_id: '701', spend: '40.5', impressions: '4000', reach: '2000', frequency: '2.0', clicks: '90', inline_link_clicks: '60', inline_link_click_ctr: '1.5', cost_per_inline_link_click: '0.675', account_currency: 'USD', date_start: '2026-10-20' }], paging: { next: `${u}&page=2` } });
      if (u.includes('/insights?')) return json(200, { data: [{ ad_id: '9001', ad_name: 'Hook A', adset_id: '801', campaign_id: '701', spend: '35', impressions: '3000', reach: '1400', frequency: '2.14', inline_link_clicks: '30', account_currency: 'USD', date_start: '2026-10-21' }] });
      if (u.includes('/ads?')) return json(200, { data: [{ id: '9001', name: 'Hook A', status: 'ACTIVE', effective_status: 'ACTIVE', adset_id: '801', campaign_id: '701', creative: { id: '5551' }, created_time: '2026-10-19T10:00:00+0000' }] });
      if (u.includes('/adsets?')) return json(200, { data: [{ id: '801', name: 'Owners 1M+', status: 'ACTIVE', effective_status: 'ACTIVE', campaign_id: '701', daily_budget: '10000' }] });
      if (u.includes('/campaigns?')) return json(200, { data: [{ id: '701', name: 'Live webinar', status: 'ACTIVE', effective_status: 'ACTIVE' }] });
      return json(404, { error: { message: 'not stubbed' } });
    }));
    const r = await syncAdLevel(rt, 7);
    expect(r).toMatchObject({ rows: 2, ads: 1, adsets: 1, campaigns: 1 });
    expect(urls[0]).toContain('/act_123456/insights?level=ad&time_increment=1');
    expect(urls[0]).toContain('frequency');
    const rows = db.prepare('SELECT * FROM ad_insights ORDER BY day').all() as { spend: number; ctr: number | null; frequency: number; link_clicks: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ spend: 40.5, ctr: 1.5, frequency: 2, link_clicks: 60 });
    const ents = db.prepare('SELECT id, level, daily_budget, creative_id, adset_id FROM ad_entities ORDER BY level').all();
    expect(ents).toEqual([
      { id: '9001', level: 'ad', daily_budget: null, creative_id: '5551', adset_id: '801' },
      { id: '801', level: 'adset', daily_budget: 10000, creative_id: null, adset_id: '801' },
      { id: '701', level: 'campaign', daily_budget: null, creative_id: null, adset_id: null },
    ]);
    // Re-reading revises the same day instead of adding a row.
    await storeAdLevel(rt, [{ ad_id: '9001', date_start: '2026-10-21', spend: '50', impressions: '3100' }], { ads: [], adsets: [], campaigns: [] });
    expect((db.prepare("SELECT spend FROM ad_insights WHERE day = '2026-10-21'").get() as { spend: number }).spend).toBe(50);
  });

  it('does nothing without a read token and an ad account', async () => {
    const db = freshDb();
    expect(await syncAdLevel(makeRt(db, { META_ADS_TOKEN: '', META_AD_ACCOUNT_ID: '' }))).toBeNull();
  });
});

// ───────────── 2. The rules on fixtures ─────────────

const day = (i: number, o: Partial<DayRow> = {}): DayRow => ({ day: ymd(Date.parse('2026-10-01') + i * DAY), spend: 50, impressions: 5000, reach: 2500, frequency: 2, link_clicks: 75, ...o });
const ad = (o: Partial<AdStat> = {}): AdStat => ({
  ad_id: '9001', name: 'Hook A', adset_id: '801', campaign_id: '701', status: 'ACTIVE', created_time: null, currency: 'USD', days: [],
  spend: 0, impressions: 0, link_clicks: 0, ctr: null, cpc: null, frequency: null,
  results: { leads: 0, qualified: 0, under1m: 0, tickets: 0, deposits: 0, bookings: 0, deals: 0, revenue: 0, leadDays: [] }, ...o,
});
const T = adsTargets({ ADS_TARGET_CPA_TICKET: '150', ADS_TARGET_CPA_DEPOSIT: '1500', ADS_TARGET_CPL: '60' });

describe('autopilot rules', () => {
  it('fatigue: frequency rising and CTR falling against the ad\'s first three days', () => {
    const days = [day(0), day(1), day(2), day(3, { link_clicks: 60 }), day(4, { link_clicks: 45, reach: 1500 }), day(5, { link_clicks: 40, reach: 1400 }), day(6, { link_clicks: 35, reach: 1300 })];
    const v = fatigue(ad({ days, spend: 350 }), T)!;
    expect(v.rule).toBe('fatigue');
    expect(v.numbers.ctrDropPct).toBeGreaterThan(30);
    expect(v.numbers.recentFreq!).toBeGreaterThan(2.5);
    expect(v.reasons.join(' ')).toMatch(/Link CTR .* down \d+% from 1\.50%/);
    // Steady CTR: not fatigued. Too little history: no call.
    expect(fatigue(ad({ days: [0, 1, 2, 3, 4, 5].map((i) => day(i)) }), T)).toBeNull();
    expect(fatigue(ad({ days: days.slice(0, 5) }), T)).toBeNull();
    // CTR down but frequency fine and cost per lead on target: not fatigue.
    const lowFreq = days.map((d) => ({ ...d, reach: 4000 }));
    const leadDays = lowFreq.slice(-3).flatMap((d) => [d.day, d.day, d.day]);
    expect(fatigue(ad({ days: lowFreq, results: { ...ad().results, leads: 9, leadDays } }), T)).toBeNull();
    // ...but with cost per lead drifting above target it is.
    expect(fatigue(ad({ days: lowFreq }), T)?.reasons.join(' ')).toMatch(/no leads|Cost per lead/);
  });

  it('loser: enough spend with no qualified result by revenue band; or a ticket cost far above target', () => {
    const r = ad().results;
    expect(loser(ad({ spend: 299 }), T)).toBeNull(); // under the judging spend (2 x ticket target)
    const v = loser(ad({ spend: 420, results: { ...r, leads: 4, under1m: 4 } }), T)!;
    expect(v.reasons[0]).toMatch(/4 leads, 4 under \$1M revenue, none at \$1M\+/);
    expect(loser(ad({ spend: 420, results: { ...r, leads: 4, qualified: 1, under1m: 3 } }), T)).toBeNull();
    expect(loser(ad({ spend: 900, results: { ...r, leads: 6, qualified: 2, tickets: 1 } }), T)?.reasons[0]).toMatch(/Cost per ticket/);
    expect(loser(ad({ spend: 900, results: { ...r, tickets: 1, bookings: 1 } }), T)).toBeNull();
  });

  it('winner: below target with volume, and a winner is never also paused', () => {
    const r = ad().results;
    expect(winner(ad({ spend: 300, results: { ...r, tickets: 2 } }), T)).toBeNull(); // volume under 3
    const w = winner(ad({ spend: 300, results: { ...r, tickets: 3 } }), T)!;
    expect(w.reasons[0]).toMatch(/Cost per ticket USD 100 on 3 results, under the USD 150 target/);
    expect(winner(ad({ spend: 600, results: { ...r, tickets: 3 } }), T)).toBeNull(); // 200 per ticket
    expect(winner(ad({ spend: 300, results: { ...r, tickets: 3 } }), adsTargets({}))).toBeNull(); // no targets, no winners
    expect(verdicts(ad({ spend: 300, results: { ...r, tickets: 3 } }), T).map((v) => v.rule)).toEqual(['winner']);
  });

  it('budget shifts stay inside the daily percentage, the cap and what already moved today', () => {
    expect(boundShift({ fromBudget: 10000, toBudget: 5000, maxPct: 20 })).toEqual({ amount: 1000, fromAfter: 9000, toAfter: 6000 });
    expect(boundShift({ fromBudget: 10000, toBudget: 50000, maxPct: 20 }).amount).toBe(2000);
    expect(boundShift({ fromBudget: 10000, toBudget: 50000, maxPct: 20, usedFrom: 1500 }).amount).toBe(500);
    expect(boundShift({ fromBudget: 10000, toBudget: 50000, maxPct: 20, cap: 50300 }).amount).toBe(300);
    expect(boundShift({ fromBudget: 10000, toBudget: 5000, maxPct: 20, requested: 400 }).amount).toBe(400);
    expect(boundShift({ fromBudget: 10000, toBudget: 5000, maxPct: 20, usedTo: 1000 }).amount).toBe(0);
    expect(boundShift({ fromBudget: 150, toBudget: 5000, maxPct: 100 }).amount).toBe(50); // the giver keeps at least 1 unit
  });
});

// ───────────── 3. The autopilot end to end: proposals, the no-write-token path, execution ─────────────

function seedAds(db: DatabaseSync, now: number) {
  const ins = db.prepare('INSERT INTO ad_insights (ad_id, day, adset_id, campaign_id, ad_name, spend, impressions, reach, frequency, link_clicks, currency, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 7; i++) {
    const d = ymd(now - i * DAY);
    ins.run('9001', d, '801', '701', 'Loser ad', 60, 6000, 3000, 2, 60, 'USD', now);   // 420 spent, nothing qualified
    ins.run('9002', d, '802', '701', 'Winner ad', 45, 5000, 2500, 2, 80, 'USD', now);  // 315 spent, 3 tickets
  }
  const ent = db.prepare("INSERT INTO ad_entities (id, level, name, status, effective_status, campaign_id, adset_id, daily_budget, updated_at) VALUES (?, ?, ?, 'ACTIVE', 'ACTIVE', '701', ?, ?, ?)");
  ent.run('9001', 'ad', 'Loser ad', '801', null, now);
  ent.run('9002', 'ad', 'Winner ad', '802', null, now);
  ent.run('801', 'adset', 'Broad', '801', 10000, now);
  ent.run('802', 'adset', 'Owners 1M+', '802', 5000, now);
  const lead = db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, status, revenue_band, utm_content, ft_content) VALUES (?, ?, ?, ?, 'Dana', ?, 'applied', ?, ?, ?)");
  lead.run('lz1', 'RZ1', now - DAY, now, 'z1@example.com', '<1m', '9001', null);
  for (const i of [1, 2, 3]) {
    lead.run(`lw${i}`, `RW${i}`, now - i * DAY, now, `w${i}@example.com`, '3m-10m', 'Winner ad', null);
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, created_at, updated_at, paid_at) VALUES (?, 'r', ?, 'seat', 'paid', 10000, 'usd', ?, ?, ?)").run(`p${i}`, `lw${i}`, now, now, now);
  }
}

describe('ads autopilot proposals and execution', () => {
  it('joins ads to our leads, bands and tickets by utm_content', async () => {
    const db = freshDb(); const now = Date.now();
    seedAds(db, now);
    const stats = await loadAdStats(makeRt(db), 14, now);
    const w = stats.find((a) => a.ad_id === '9002')!, l = stats.find((a) => a.ad_id === '9001')!;
    expect(w.results).toMatchObject({ leads: 3, qualified: 3, tickets: 3 });
    expect(l.results).toMatchObject({ leads: 1, under1m: 1, qualified: 0, tickets: 0 });
    expect(l.spend).toBe(420);
  });

  it('without a write token: proposals carry apply-manually steps, approval does not pretend it reached Meta', async () => {
    const db = freshDb(); const now = Date.now();
    seedAds(db, now);
    const rt = makeRt(db);
    const r = await runAutopilot(rt, now);
    expect(r.proposed).toHaveLength(3);
    const props = await listActions(rt, { dept: 'marketing', status: ['proposed'] });
    const kinds = props.map((p) => p.kind).sort();
    expect(kinds).toEqual(['marketing.duplicate_ad', 'marketing.pause_ad', 'marketing.shift_budget']);
    const shift = props.find((p) => p.kind === 'marketing.shift_budget')!;
    expect(JSON.parse(shift.payload!)).toMatchObject({ from_adset: '801', to_adset: '802', amount: 1000 }); // 20% of the smaller budget
    expect(shift.risk).toBe('high');
    for (const p of props) {
      expect(p.detail).toContain('Apply manually');
      expect(p.detail).toContain('Source: Funnel HQ');
      expect(auditCopy(p.summary).filter((i) => !/parallel/.test(i.rule))).toEqual([]);
    }
    // The next hourly run proposes nothing new.
    expect((await runAutopilot(rt, now + 3600_000)).proposed).toHaveLength(0);

    const pause = props.find((p) => p.kind === 'marketing.pause_ad')!;
    const res = await decideAction(rt, pause.id, 'approve');
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/Not sent to Meta: no write token.*Apply manually/);
    expect((await getAction(rt, pause.id))!.status).toBe('failed');

    // "I applied it in Ads Manager": recorded as done by hand.
    const dup = props.find((p) => p.kind === 'marketing.duplicate_ad')!;
    await updateActionPayload(rt, dup.id, { ...JSON.parse(dup.payload!), manual_ack: true });
    expect(await decideAction(rt, dup.id, 'approve')).toMatchObject({ ok: true, summary: expect.stringMatching(/by hand/) });
    expect(await decideAction(rt, shift.id, 'reject')).toMatchObject({ ok: true });
  });

  it('with the write token: approved pause and budget shift call the Marketing API, within today\'s bounds', async () => {
    const db = freshDb(); const now = Date.now();
    seedAds(db, now);
    const rt = makeRt(db, { META_ADS_WRITE_TOKEN: 'write_tok' });
    const calls: { url: string; body: URLSearchParams }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: URLSearchParams } = {}) => {
      if (init.method === 'POST') { calls.push({ url: String(url), body: init.body! }); return json(200, { success: true }); }
      return json(404, {});
    }));
    await runAutopilot(rt, now);
    const props = await listActions(rt, { dept: 'marketing', status: ['proposed'] });
    expect(props.every((p) => !p.detail!.includes('Apply manually'))).toBe(true);
    const pause = props.find((p) => p.kind === 'marketing.pause_ad')!;
    expect(await decideAction(rt, pause.id, 'approve')).toMatchObject({ ok: true, summary: 'Paused on Meta: Loser ad.' });
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/9001');
    expect(calls[0].body.get('status')).toBe('PAUSED');
    expect(calls[0].body.get('access_token')).toBe('write_tok');
    expect((db.prepare("SELECT effective_status FROM ad_entities WHERE id = '9001'").get() as { effective_status: string }).effective_status).toBe('PAUSED');

    // The owner edits the amount upward; execution still holds the 20% line.
    const shift = props.find((p) => p.kind === 'marketing.shift_budget')!;
    await updateActionPayload(rt, shift.id, { ...JSON.parse(shift.payload!), amount: 999_999 });
    const r = await decideAction(rt, shift.id, 'approve');
    expect(r).toMatchObject({ ok: true });
    expect(r.summary).toMatch(/Moved on Meta: 10\.00\/day from "Broad" \(now 90\.00\) to "Owners 1M\+" \(now 60\.00\)/);
    const budgets = calls.filter((c) => c.body.has('daily_budget')).map((c) => [c.url.split('/').pop(), c.body.get('daily_budget')]);
    expect(budgets).toEqual([['801', '9000'], ['802', '6000']]);
    expect(db.prepare('SELECT adset_id, delta, applied FROM ads_budget_shifts ORDER BY delta').all()).toEqual([{ adset_id: '801', delta: -1000, applied: 1 }, { adset_id: '802', delta: 1000, applied: 1 }]);

    // A second move between the same ad sets today is refused: the receiver's 20% is used up.
    const again = await proposeAction(rt, { dept: 'marketing', kind: 'marketing.shift_budget', summary: 'again', detail: 'x', risk: 'high', payload: { from_adset: '801', to_adset: '802', amount: 500 } });
    expect(await decideAction(rt, again, 'approve')).toMatchObject({ ok: false, summary: expect.stringMatching(/Nothing to move/) });
  });

  it('every action kind has a handler registered', () => {
    for (const k of ['marketing.pause_ad', 'marketing.duplicate_ad', 'marketing.shift_budget', 'marketing.test_angle', 'marketing.launch_angle_ads', 'sales.bulk_followup']) expect(hasActionHandler(k), k).toBe(true);
  });

  it('a kind set to auto runs at once and is logged', async () => {
    const db = freshDb(); const now = Date.now();
    seedAds(db, now);
    const rt = makeRt(db, { OPS_AUTO_KINDS: 'marketing.duplicate_ad', META_ADS_WRITE_TOKEN: 'w' });
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { copied_ad_id: '9100' })));
    await runAutopilot(rt, now);
    const done = await listActions(rt, { dept: 'marketing', status: ['done'] });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ kind: 'marketing.duplicate_ad', actor: 'auto' });
    expect(done[0].result).toMatch(/new ad 9100/);
  });
});

// ───────────── 4. Angle → ad drafts ─────────────

const GOOD = [
  { primary: 'Most owners at $3M think buying a competitor takes millions in cash.\n\nThe deals we structure use commercial debt, seller finance and seller rollover.\n\nSee how the numbers work on the page.', headline: 'Buy a competitor with the seller\'s help', description: 'Commercial debt, seller finance, seller rollover.' },
  { primary: 'Every year you wait, a competitor with no successor sells to someone else.\n\nLearn how owners buy them instead.', headline: 'Be the buyer, not the add-on', description: 'The 3C model for your first acquisition.' },
  { primary: 'Your business already passes the test lenders use: 1.5x debt service coverage.\n\nThat is the start of a first acquisition.', headline: 'Your cash flow can fund a deal', description: 'Read how the 1.5x test works.' },
];
const mock = (answers: unknown[]): Complete & { calls: string[] } => {
  const calls: string[] = [];
  const f = (async (_s: string, u: string) => { calls.push(u); return JSON.stringify(answers[Math.min(calls.length - 1, answers.length - 1)]); }) as Complete & { calls: string[] };
  f.calls = calls;
  return f;
};

describe('new ad drafts from angles', () => {
  it('drafts three variants, rewrites the one that breaks the copy rules, then queues the launch', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const bad = { primary: 'This might be the best move you make — act now!', headline: 'Huge news!', description: '' };
    const complete = mock([{ variants: [GOOD[0], bad, GOOD[2]] }, { variants: [GOOD[0], GOOD[1], GOOD[2]] }]);
    const r = await draftAndPropose(rt, { angle: 'Owners think buying needs millions in cash', evidence: 'Reddit threads about bank loans' }, complete);
    expect(complete.calls).toHaveLength(2);
    expect(complete.calls[1]).toMatch(/hedge|exclamation|dashes/);
    expect(r.drafts).toHaveLength(3);
    for (const d of r.drafts) { expect(auditDraft(d)).toEqual([]); expect(d.utm_content).toMatch(/^ang-[a-z0-9]{6}-v[123]$/); }
    const prop = (await getAction(rt, r.actionId))!;
    expect(prop.kind).toBe('marketing.launch_angle_ads');
    expect(prop.detail).toContain(r.drafts[1].headline);
    expect(prop.detail).toMatch(/paste-ready spec/);

    // Approve without the write token: a spec to paste, tagged per ad.
    const res = await decideAction(rt, r.actionId, 'approve');
    expect(res).toMatchObject({ ok: true, summary: expect.stringMatching(/Spec ready to paste.*no write token/) });
    const row = db.prepare('SELECT status, spec FROM ads_angle_drafts WHERE id = ?').get(r.id) as { status: string; spec: string };
    expect(row.status).toBe('exported');
    expect(row.spec).toContain(`utm_content=${r.drafts[0].utm_content}`);
    expect(row.spec).toContain('Status: paused until reviewed');
  });

  it('drops variants that still break the rules, and fails clearly when none pass', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const bad = { primary: 'We guarantee you will get funded!', headline: 'Free call today', description: '' };
    const r = await writeAngleDrafts(rt, { angle: 'Funding fear among owners' }, mock([{ variants: [GOOD[0], bad, bad] }]));
    expect(r.drafts).toHaveLength(1);
    expect(r.dropped).toBe(2);
    await expect(writeAngleDrafts(rt, { angle: 'Funding fear among owners' }, mock([{ variants: [bad] }]))).rejects.toThrow(/No draft passed/);
    await expect(writeAngleDrafts(rt, { angle: 'Funding fear among owners' }, null)).rejects.toThrow(/Add the Anthropic API key/);
  });

  it('Research sending an angle without an Anthropic key fails with the "add the key" note', async () => {
    const db = freshDb();
    const rt = makeRt(db, { ANTHROPIC_API_KEY: '' });
    const id = await proposeAction(rt, { dept: 'research', kind: 'marketing.test_angle', summary: 'Test angle', detail: 'x', risk: 'low', payload: { angle: 'Owners fear personal guarantees' } });
    expect(await decideAction(rt, id, 'approve')).toMatchObject({ ok: false, summary: expect.stringMatching(/Anthropic API key/) });
  });

  it('with the write token, a Page and an ad set: one paused ad per draft, reusing the creative\'s image, tagged with utm_content', async () => {
    const db = freshDb();
    const rt = makeRt(db, { META_ADS_WRITE_TOKEN: 'w', ADS_PAGE_ID: '4444444', ADS_LANDING_URL: 'https://live.test/live' });
    const r = await draftAndPropose(rt, { angle: 'Owners think buying needs millions in cash', adset_id: '802', creative_id: '5551' }, mock([{ variants: GOOD }]));
    const posts: { url: string; body: URLSearchParams }[] = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: URLSearchParams } = {}) => {
      const u = String(url);
      if (!init.method) return json(200, { object_story_spec: { link_data: { image_hash: 'abc123' } } });
      posts.push({ url: u, body: init.body! });
      return json(200, { id: u.endsWith('/adcreatives') ? `cr${++n}` : `ad${n}` });
    }));
    const res = await decideAction(rt, r.actionId, 'approve');
    expect(res).toMatchObject({ ok: true, summary: expect.stringMatching(/3 paused ads created in ad set 802 with the chosen image/) });
    const creatives = posts.filter((p) => p.url.endsWith('/act_123456/adcreatives'));
    const ads = posts.filter((p) => p.url.endsWith('/act_123456/ads'));
    expect(creatives).toHaveLength(3);
    expect(ads).toHaveLength(3);
    const spec = JSON.parse(creatives[0].body.get('object_story_spec')!);
    expect(spec).toMatchObject({ page_id: '4444444', link_data: { link: 'https://live.test/live', image_hash: 'abc123', name: GOOD[0].headline } });
    expect(creatives[0].body.get('url_tags')).toContain(`utm_content=${r.drafts[0].utm_content}`);
    expect(ads[0].body.get('status')).toBe('PAUSED');
    expect(ads[0].body.get('adset_id')).toBe('802');
    expect((db.prepare('SELECT status, ad_ids FROM ads_angle_drafts').get() as { status: string; ad_ids: string })).toEqual({ status: 'launched', ad_ids: JSON.stringify(['ad1', 'ad2', 'ad3']) });
  });
});

// ───────────── 5. Sales: bulk follow-ups ─────────────

const IN_HOURS = Date.parse('2026-10-13T01:00:00Z');  // 12pm Sydney, 9am Perth
const OUT_HOURS = Date.parse('2026-10-13T12:00:00Z'); // 11pm Sydney, 8pm Perth
function seedLeads(db: DatabaseSync, now: number, tz = 'Australia/Sydney') {
  const old = now - 20 * DAY;
  const ins = db.prepare(`INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, phone, status, timezone, call_consent_at, sms_consent_at, sms_opt_out_at, unsubscribed_at, booking_source, call_at, booking_reschedule_url)
    VALUES (?, ?, ?, ?, ?, 'Lee', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`);
  ins.run('q1', 'Q1', old, old, 'Dana', 'dana@example.com', '+61412345001', 'applied', tz, old, null, null, 'funnel', null, null);   // quiet, email + text
  ins.run('q2', 'Q2', old, old, 'Sam', 'sam@example.com', '+61412345002', 'applied', tz, null, null, null, 'funnel', null, null);    // quiet, no text consent
  ins.run('q3', 'Q3', old, old, 'Ari', 'ari@example.com', '+61412345003', 'showed', tz, old, old, null, 'funnel', null, null);      // replied STOP
  ins.run('q4', 'Q4', old, old, 'Kim', 'kim@example.com', null, 'applied', tz, null, null, old, 'funnel', null, null);              // unsubscribed
  ins.run('q5', 'Q5', old, old, 'Lou', 'bounced@example.com', null, 'nurture', tz, null, null, null, 'funnel', null, null);         // suppressed address
  ins.run('q6', 'Q6', old, old, 'Max', 'max@example.com', null, 'applied', tz, null, null, null, 'funnel', null, null);             // active yesterday
  ins.run('q7', 'Q7', old, old, 'Ivy', 'ivy@example.com', null, 'won', tz, null, null, null, 'funnel', null, null);                 // client: never
  ins.run('n1', 'N1', old, old, 'Noa', 'noa@example.com', '+61412345008', 'no_show', tz, old, null, null, 'funnel', now - 2 * DAY, 'https://calendly.com/reschedulings/abc');
  db.prepare("INSERT INTO email_suppressions (email, reason, created_at) VALUES ('bounced@example.com', 'bounced', ?)").run(old);
  db.prepare("INSERT INTO events (id, ts, name, lead_id, source) VALUES ('e1', ?, 'page_view', 'q6', 'server')").run(now - DAY);
  db.prepare("INSERT INTO events (id, ts, name, lead_id, source) VALUES ('e2', ?, 'email_sent', 'q1', 'cron')").run(now - DAY); // our own sends don't count as activity
}

describe('sales follow-up actions', () => {
  it('understands the chat phrasing', () => {
    expect(matchSalesCommand('Follow up with every lead who went quiet')).toEqual({ play: 'quiet' });
    expect(matchSalesCommand('follow up with leads who went quiet for 10 days')).toEqual({ play: 'quiet', days: 10 });
    expect(matchSalesCommand('re-engage no-shows')).toEqual({ play: 'no_show' });
    expect(matchSalesCommand('chase unpaid tickets and deposits')).toEqual({ play: 'unpaid' });
    expect(matchSalesCommand('what is the weather')).toBeNull();
  });

  it('picks quiet leads and leaves out the active, clients, unsubscribed, suppressed and people without text consent', async () => {
    const db = freshDb();
    seedLeads(db, IN_HOURS);
    const rt = makeRt(db);
    const { candidates } = await findCandidates(rt, 'quiet', { days: 5, stages: ['applied', 'showed', 'nurture'], now: IN_HOURS });
    expect(candidates.map((c) => c.lead.id).sort()).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    const r = await proposeFollowups(rt, 'quiet', { days: 5, now: IN_HOURS });
    const byLead = (id: string) => r.previews.filter((p) => p.lead_id === id).map((p) => p.channel).sort();
    expect(byLead('q1')).toEqual(['email', 'sms']);
    expect(byLead('q2')).toEqual(['email']);
    expect(byLead('q3')).toEqual(['email']);
    expect(byLead('q4')).toEqual([]);
    expect(byLead('q5')).toEqual([]);
    const why = Object.fromEntries(r.excluded.map((x) => [x.lead_id, x.why]));
    expect(why.q2).toMatch(/sms: no consent/);
    expect(why.q3).toMatch(/sms: replied STOP/);
    expect(why.q4).toMatch(/unsubscribed/);
    expect(why.q5).toMatch(/email bounced/);
    expect(r.leads).toBe(3);
    // One proposal, with a preview of each message, nothing sent yet.
    const a = (await getAction(rt, r.actionId!))!;
    expect(a).toMatchObject({ kind: 'sales.bulk_followup', status: 'proposed', dept: 'sales' });
    expect(a.detail).toContain('Dana Lee · email');
    expect(a.detail).toContain('Reply STOP to opt out.');
    expect(db.prepare("SELECT COUNT(*) AS n FROM emails").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops_followup_messages WHERE status = 'draft'").get()).toEqual({ n: 4 });
  });

  it('sends on approval only, inside sending hours, and re-checks consent at the moment of sending', async () => {
    const db = freshDb();
    seedLeads(db, OUT_HOURS);
    const rt = makeRt(db);
    const r = await proposeFollowups(rt, 'quiet', { days: 5, now: OUT_HOURS });
    expect(r.previews.every((p) => p.send_at > OUT_HOURS)).toBe(true); // 11pm Sydney: everything waits for the morning
    // Dana texts STOP before the approval.
    db.prepare("UPDATE leads SET sms_opt_out_at = ? WHERE id = 'q1'").run(OUT_HOURS);
    const queued = await approveBatch(rt, r.batchId, OUT_HOURS);
    expect(queued.sent).toBe(0);
    expect(queued.counts.queued).toBe(4);
    // Next morning the cron sends: Dana's text is skipped, the emails go (simulated without Resend), recorded in emails.
    const morning = Date.parse('2026-10-14T00:30:00Z'); // 11:30am Sydney, 8:30am Perth
    const out = await processFollowupQueue(rt, { now: morning });
    expect(out).toMatchObject({ sent: 3, skipped: 1 });
    expect(db.prepare("SELECT error FROM ops_followup_messages WHERE channel = 'sms'").get()).toEqual({ error: 'replied STOP' });
    const emails = db.prepare("SELECT lead_id, status, sequence, template FROM emails ORDER BY lead_id").all();
    expect(emails).toEqual([
      { lead_id: 'q1', status: 'simulated', sequence: 'ops_followup', template: 'ops_quiet' },
      { lead_id: 'q2', status: 'simulated', sequence: 'ops_followup', template: 'ops_quiet' },
      { lead_id: 'q3', status: 'simulated', sequence: 'ops_followup', template: 'ops_quiet' },
    ]);
    // Drafted again a day later: they were just followed up, so nobody is picked.
    const again = await proposeFollowups(rt, 'quiet', { days: 5, now: morning + DAY });
    expect(again.actionId).toBeNull();
  });

  it('skips a quiet lead who became active after the draft, and sends texts through Twilio with the STOP line', async () => {
    const db = freshDb();
    seedLeads(db, IN_HOURS);
    const rt = makeRt(db, { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', SMS_FROM: '+15550001111' });
    const sms: URLSearchParams[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: URLSearchParams } = {}) => { if (String(url).includes('twilio')) { sms.push(init.body!); return json(201, { sid: 'SM1' }); } return json(404, {}); }));
    const r = await proposeFollowups(rt, 'quiet', { days: 5, now: IN_HOURS, channels: ['sms', 'email'] });
    db.prepare("INSERT INTO events (id, ts, name, lead_id, source) VALUES ('e9', ?, 'page_view', 'q2', 'server')").run(Date.now() + 1000);
    await approveBatch(rt, r.batchId, IN_HOURS);
    expect(db.prepare("SELECT status, error FROM ops_followup_messages WHERE lead_id = 'q2'").get()).toEqual({ status: 'skipped', error: 'active again since the draft' });
    expect(sms).toHaveLength(1);
    expect(sms[0].get('Body')).toMatch(/^Hi Dana, it's Josh's team at G&L\..*\nReply STOP to opt out\.$/s);
    expect(db.prepare("SELECT status, provider_id, sequence FROM sms_messages").get()).toEqual({ status: 'sent', provider_id: 'SM1', sequence: 'ops_followup' });
  });

  it('re-engages no-shows with their reschedule link, and the approval runs through the registered handler', async () => {
    const db = freshDb();
    const now = Date.now();
    const tz = ['UTC', 'Asia/Tokyo', 'America/New_York', 'Europe/London', 'Australia/Sydney', 'America/Los_Angeles', 'Asia/Kolkata'].find((z) => inEmailHours(now, z))!;
    seedLeads(db, now, tz);
    const rt = makeRt(db);
    const r = await proposeFollowups(rt, 'no_show', { channels: ['email'] });
    expect(r.previews).toHaveLength(1);
    expect(r.previews[0].text).toContain('https://calendly.com/reschedulings/abc');
    const res = await decideAction(rt, r.actionId!, 'approve');
    expect(res).toMatchObject({ ok: true, summary: expect.stringMatching(/1 sent \(1 simulated/) });
  });

  it('chases unpaid checkouts with the right link and stops once paid', async () => {
    const db = freshDb();
    const now = IN_HOURS;
    seedLeads(db, now);
    db.prepare("INSERT INTO challenge_cohorts (id, name, start_date, start_time, timezone, created_at, updated_at) VALUES ('co1', 'Nov', '2026-11-01', '19:00', 'Australia/Sydney', ?, ?)").run(now, now);
    db.prepare("INSERT INTO challenge_registrations (id, token, cohort_id, lead_id, status, created_at) VALUES ('cr1', 'tok123', 'co1', 'q2', 'pending', ?)").run(now - 3 * 3600_000);
    const rt = makeRt(db);
    const r = await proposeFollowups(rt, 'unpaid', { channels: ['email'], now });
    expect(r.previews).toHaveLength(1);
    expect(r.previews[0].text).toContain('https://apply.test/challenge/pay/tok123');
    expect(r.previews[0].subject).toBe('Your First Deal Challenge ticket payment didn\'t go through');
    db.prepare("UPDATE challenge_registrations SET status = 'paid', paid_at = ? WHERE id = 'cr1'").run(Date.now() + 1000);
    await approveBatch(rt, r.batchId, now);
    expect(db.prepare('SELECT status, error FROM ops_followup_messages').get()).toEqual({ status: 'skipped', error: 'paid since the draft' });
  });

  it('every drafted message passes the copy rules', () => {
    const rt = makeRt(freshDb());
    const lead = { id: 'x', first_name: 'Dana', status: 'applied' } as Lead;
    const cands: Candidate[] = [
      ...['partial', 'applied', 'booked', 'showed', 'nurture'].map((s) => ({ lead: { ...lead, status: s } as Lead, play: 'quiet' as const, reason: '', link: null })),
      { lead, play: 'no_show', reason: '', link: 'https://calendly.com/x' },
      { lead, play: 'unpaid', reason: '', link: 'https://apply.test/pay', what: 'your engagement deposit' },
      { lead, play: 'unpaid', reason: '', link: null, what: 'your Masterclass ticket' },
    ];
    for (const c of cands) {
      expect(auditEmail(baseEmail(c)), `${c.play}`).toEqual([]);
      const s = baseSms(rt, c);
      expect(auditCopy(s), s).toEqual([]);
      expect(s).not.toMatch(/[—–]/);
      expect(s.toLowerCase()).not.toMatch(/free (strategy )?call/);
    }
  });
});

describe('copy in settings and Funnel HQ', () => {
  it('the new settings and tab descriptions pass the copy rules', async () => {
    const { SETTINGS } = await import('../src/settings');
    const mine = SETTINGS.filter((s) => /^(ADS_|META_ADS_WRITE|SALES_QUIET)/.test(s.key));
    expect(mine.length).toBeGreaterThan(10);
    for (const s of mine) for (const t of [s.label, 'help' in s ? s.help : '']) {
      expect(auditCopy(t ?? ''), `${s.key}: ${t}`).toEqual([]);
      expect(t ?? '').not.toMatch(/—/);
    }
    const js = fs.readFileSync(`${node.cwd()}/public/assets/admin.js`, 'utf8');
    for (const id of ['autopilot', 'salesops']) {
      const line = js.split('\n').find((l) => l.trim().startsWith(`${id}: {`))!;
      for (const m of line.matchAll(/(sub|more): '((?:[^'\\]|\\.)*)'/g)) { expect(auditCopy(m[2]), m[2]).toEqual([]); expect(m[2]).not.toMatch(/[—!]/); }
    }
  });
});

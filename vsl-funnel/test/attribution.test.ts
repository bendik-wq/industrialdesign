import { describe, expect, it } from 'vitest';
import { classifyChannel, platformOf, touchFromUrl } from '../src/lib/attribution';

const touch = (qs: string, ref: string | null = null) => touchFromUrl(new URL(`https://apply.example.com/${qs}`), ref, 'apply.example.com');

describe('touchFromUrl', () => {
  it('classifies paid Facebook traffic from UTMs', () => {
    const t = touch('?utm_source=facebook&utm_medium=paid&utm_campaign=c1&utm_content=ad1&fbclid=abc&ad_id=99');
    expect(t).toMatchObject({ channel: 'Paid Social', source: 'facebook', campaign: 'c1', content: 'ad1', clickType: 'fbclid', clickId: 'abc', adId: '99' });
  });
  it('does not treat a bare fbclid as paid (Meta adds it to organic clicks too)', () => {
    expect(touch('?fbclid=abc').channel).toBe('Organic Social');
  });
  it('treats gclid as paid search', () => {
    expect(touch('?gclid=xyz').channel).toBe('Paid Search');
  });
  it('detects organic search and referrals from the referrer', () => {
    expect(touch('', 'https://www.google.com/').channel).toBe('Organic Search');
    expect(touch('', 'https://blog.someone.com/post').channel).toBe('Referral');
    expect(touch('', 'https://l.instagram.com/').channel).toBe('Organic Social');
  });
  it('ignores self-referrals', () => {
    expect(touch('', 'https://apply.example.com/apply').channel).toBe('Direct');
  });
  it('does not mistake look-alike hosts for social networks', () => {
    expect(classifyChannel('accept.com', 'referral', 'accept.com', false)).toBe('Referral');
  });
  it('classifies email and video', () => {
    expect(touch('?utm_source=newsletter&utm_medium=email').channel).toBe('Email');
    expect(touch('?utm_source=youtube&utm_medium=cpc').channel).toBe('Paid Video');
  });
});

describe('in-app browsers and platform names', () => {
  const IG = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0.0';
  it('an Instagram bio tap with no referrer is Instagram, not Direct', () => {
    const t = touchFromUrl(new URL('https://apply.example.com/'), null, 'apply.example.com', IG);
    expect(t).toMatchObject({ channel: 'Organic Social', source: 'instagram' });
  });
  it('UTMs still win over the in-app guess', () => {
    const t = touchFromUrl(new URL('https://apply.example.com/?utm_source=newsletter&utm_medium=email'), null, 'apply.example.com', IG);
    expect(t.channel).toBe('Email');
  });
  it('names platforms in plain words', () => {
    expect(platformOf('instagram', null, 'manychat')).toBe('Instagram DM');
    expect(platformOf('instagram', null, 'social')).toBe('Instagram');
    expect(platformOf('m.facebook.com', 'm.facebook.com')).toBe('Facebook');
    expect(platformOf('chatgpt.com')).toBe('ChatGPT');
    expect(platformOf(null, 'gemini.google.com')).toBe('Gemini');
    expect(platformOf(null, 'www.google.com')).toBe('Google');
    expect(platformOf(null, 'mail.google.com')).toBe('Email');
    expect(platformOf('x')).toBe('X');
    expect(platformOf(null, 'accept.com')).toBe('accept.com');
    expect(platformOf(null, null)).toBe('Direct');
  });
});

// ═════════════ Webinar attribution (src/attribution) on a real SQLite database with every migration ═════════════

import { afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, Runtime } from '../src/app';
import type { VisitorCtx } from '../src/lib/identity';
import { auditCopy, auditFields } from '../src/content/copy-rules';
import { captureConversion, checkoutAttribution, linkCrossDomain, metaAdId, xdToken } from '../src/attribution/capture';
import { onRegistered, sendStageEvent } from '../src/attribution/hooks';
import { STAGES, syncAttribution } from '../src/attribution/stages';
import { revenueBy, roomAnalytics, setupChecks, stageCounts } from '../src/attribution/report';
import { mountAttributionAdmin, parseRange, toCsv } from '../src/attribution/routes';
import { registerLive, saveEvent } from '../src/live/events';
import { handleWhopEvent, whopApi } from '../src/webinar/whop';
import { markPassRefunded } from '../src/webinar/pass';
import { requireAdmin } from '../src/admin/auth';
import { SETTINGS as SETTING_DEFS } from '../src/settings';

interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const nodeProc = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = nodeProc.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fsx = nodeProc.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };

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
  const dir = `${nodeProc.cwd()}/migrations`;
  for (const f of fsx.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fsx.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}
const pending: Promise<unknown>[] = [];
const BASE: Record<string, string> = { SALES_TIMEZONE: 'America/New_York', SITE_NAME: 'G&L', PUBLIC_URL: 'https://apply.test', WEBINAR_URL: 'https://live.test', WHOP_API_KEY: 'apik_test', WHOP_COMPANY_ID: 'biz_test' };
const makeRt = (db: DatabaseSync, s: Record<string, string> = BASE) =>
  ({ env: { DB: d1(db), SESSION_SECRET: 'test-secret-0123456789' }, settings: { ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
afterEach(() => { vi.unstubAllGlobals(); pending.length = 0; });

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const visitorCtx = (o: Partial<VisitorCtx> = {}): VisitorCtx => ({
  visitorId: 'v000000000001', sessionId: 's000000000001', leadId: null, isNewVisitor: false, isNewSession: false, isBot: false, botReason: null, variant: 'a',
  ua: { device: 'mobile', browser: 'x', os: 'y' } as never, userAgent: 'test (x)', geo: { country: 'US', city: null, timezone: 'America/New_York' } as never, ip: '1.2.3.4', touch: null, fbp: 'fb.1.1.1', fbc: null, marketingConsent: true, consentRequired: false, ...o,
});

/** A visit (session) as lib/identity writes it. */
function visit(db: DatabaseSync, o: { id: string; visitor: string; at: number; source?: string | null; medium?: string | null; campaign?: string | null; content?: string | null; channel?: string; landing?: string; clickType?: string | null; clickId?: string | null }) {
  db.prepare('INSERT OR IGNORE INTO visitors (id, created_at, last_seen_at, ft_channel, is_bot) VALUES (?, ?, ?, ?, 0)').run(o.visitor, o.at, o.at, o.channel ?? 'Direct');
  db.prepare(`INSERT INTO sessions (id, visitor_id, started_at, last_seen_at, landing_path, channel, utm_source, utm_medium, utm_campaign, utm_content, click_type, click_id, device, country, is_bot)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mobile', 'US', 0)`)
    .run(o.id, o.visitor, o.at, o.at, o.landing ?? '/', o.channel ?? 'Direct', o.source ?? null, o.medium ?? null, o.campaign ?? null, o.content ?? null, o.clickType ?? null, o.clickId ?? null);
}
function lead(db: DatabaseSync, id: string, email: string, visitor: string | null = null) {
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, email, first_name, visitor_id, status, step_reached) VALUES (?, ?, ?, ?, ?, 'Dana', ?, 'partial', 0)").run(id, `R${id}`, Date.now() - DAY, Date.now(), email, visitor);
}
function autoReg(db: DatabaseSync, id: string, leadId: string, at: number) {
  db.prepare("INSERT OR IGNORE INTO webinar_sessions (id, starts_at, mode, created_at) VALUES ('ws1', ?, 'evergreen', ?)").run(at + DAY, at);
  db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at) VALUES (?, ?, 'ws1', ?, ?)").run(id, `t${id}`, leadId, at);
}
function pass(db: DatabaseSync, o: { id: string; reg: string; lead: string; kind: string; amount: number; paidAt: number | null; status?: string; source?: string | null; ref?: string | null }) {
  db.prepare(`INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, stripe_session_id, provider, source, ref_id, paid_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'usd', ?, 'whop', ?, ?, ?, ?, ?)`)
    .run(o.id, o.reg, o.lead, o.kind, o.status ?? (o.paidAt ? 'paid' : 'pending'), o.amount, `whop_${o.id}`, o.source ?? null, o.ref ?? null, o.paidAt, (o.paidAt ?? Date.now()) - MIN, Date.now());
}
const ADID = '120211234567890123';

describe('webinar attribution: capture', () => {
  it('reads the Meta ad id from utm_content={{ad.id}} only on Meta traffic', () => {
    expect(metaAdId({ content: ADID, source: 'facebook' })).toBe(ADID);
    expect(metaAdId({ content: ADID, source: 'newsletter' })).toBeNull();
    expect(metaAdId({ content: 'k7m2pq', source: 'instagram' })).toBeNull(); // a tracked link code
    expect(metaAdId({ ad_id: '99887766', content: 'x', source: null })).toBe('99887766');
  });

  it('a live webinar registration stores first and last touch, the path, the stage and one Lead event', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const now = Date.now();
    visit(db, { id: 's000000000010', visitor: 'v000000000001', at: now - 3 * DAY, source: 'youtube', medium: 'video', campaign: 'yt-desc', channel: 'Organic Video', landing: '/live' });
    visit(db, { id: 's000000000011', visitor: 'v000000000001', at: now - 2 * DAY, source: 'facebook', medium: 'paid', campaign: 'Live Nov', content: ADID, channel: 'Paid Social', landing: '/live', clickType: 'fbclid', clickId: 'fbclid-abc' });
    visit(db, { id: 's000000000012', visitor: 'v000000000001', at: now - HOUR, channel: 'Direct', landing: '/live' });
    db.prepare("INSERT INTO ad_entities (id, level, name, campaign_id, adset_id, updated_at) VALUES (?, 'ad', 'Ad one', 'c900', 'as900', ?)").run(ADID, now);
    const ev = await saveEvent(rt, { title: 'Buy your first competitor', starts_at: now + DAY, tz: 'America/New_York', duration_min: 120, join_url: 'https://zoom.us/j/1' });
    if (!ev.ok) throw new Error(ev.error);
    const { reg } = await registerLive(rt, visitorCtx(), { first_name: 'Dana', email: 'dana@example.com', revenue: '3_10m', event_id: ev.id, pixel_eid: 'cpixel12345' });
    await flush();
    const c = db.prepare("SELECT * FROM attr_conversions WHERE kind = 'registered' AND ref_id = ?").get(reg.id) as Record<string, unknown>;
    expect(c).toMatchObject({ funnel: 'live', reg_id: reg.id, cohort_ref: ev.id, touches: 3, ft_source: 'youtube', ft_platform: 'YouTube', lt_source: 'facebook', lt_campaign: 'Live Nov', lt_ad_id: ADID, lt_adset_id: 'as900', lt_campaign_id: 'c900', fbclid: 'fbclid-abc', fbp: 'fb.1.1.1', via: 'live' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM attr_touches WHERE lead_id = ?').get(reg.lead_id)).toEqual({ n: 3 });
    expect(db.prepare('SELECT stage FROM attr_stages WHERE reg_id = ?').all(reg.id)).toEqual([{ stage: 'registered' }]);
    const leads = db.prepare("SELECT id FROM events WHERE name = 'attr_lead'").all() as { id: string }[];
    expect(leads).toEqual([{ id: 'cpixel12345' }]); // the browser's id: the Pixel's Lead de-duplicates against it
    await onRegistered(rt, visitorCtx(), { funnel: 'live', regId: reg.id, leadId: reg.lead_id, at: now, cohortRef: ev.id });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'attr_lead'").get()).toEqual({ n: 1 }); // once per registration
    expect(db.prepare("SELECT COUNT(*) AS n FROM attr_conversions WHERE kind = 'registered'").get()).toEqual({ n: 1 });
  });

  it('the stage events switch turns the extra Meta events off', async () => {
    const db = freshDb();
    const rt = makeRt(db, { ...BASE, META_STAGE_EVENTS: 'false' });
    lead(db, 'l1', 'a@example.com');
    expect(await sendStageEvent(rt, { kind: 'attended', funnel: 'auto', regId: 'wr1', leadId: 'l1' })).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
  });

  it('carries the visitor across domains: the apply. ad click is the first touch of a live. registration', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const now = Date.now();
    visit(db, { id: 's000000000020', visitor: 'vapply0000001', at: now - DAY, source: 'facebook', medium: 'paid', campaign: 'Webinar', content: ADID, channel: 'Paid Social', landing: '/' });
    visit(db, { id: 's000000000021', visitor: 'vlive00000001', at: now - MIN, channel: 'Direct', landing: '/' });
    const token = await xdToken(rt.env, 'vapply0000001');
    const bad = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    expect(await linkCrossDomain(rt.env, 'vlive00000001', bad)).toBe(false); // tampered
    expect(await linkCrossDomain(rt.env, 'vlive00000001', token, { fromHost: 'apply.test', toHost: 'live.test' })).toBe(true);
    lead(db, 'l2', 'b@example.com', 'vlive00000001');
    autoReg(db, 'wr2', 'l2', now);
    await captureConversion(rt, { kind: 'registered', funnel: 'auto', refId: 'wr2', regId: 'wr2', leadId: 'l2', at: now, visitorId: 'vlive00000001', edition: 'ai' });
    const c = db.prepare("SELECT ft_source, ft_ad_id, lt_source, lt_ad_id, touches, edition FROM attr_conversions WHERE ref_id = 'wr2'").get();
    expect(c).toEqual({ ft_source: 'facebook', ft_ad_id: ADID, lt_source: 'facebook', lt_ad_id: ADID, touches: 2, edition: 'ai' });
    // And the checkout carries it to Whop.
    const meta = await checkoutAttribution(rt.env, 'l2');
    expect(meta.attr_lt).toBe(`facebook|paid|Webinar|${ADID}|${ADID}|`);
  });

  it('Whop metadata attributes a payment we had no path for, and every new checkout carries the metadata', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const now = Date.now();
    lead(db, 'l3', 'c@example.com');
    autoReg(db, 'wr3', 'l3', now - HOUR);
    pass(db, { id: 'wp3', reg: 'wr3', lead: 'l3', kind: 'seat', amount: 10000, paidAt: null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const r = await handleWhopEvent(rt, { type: 'payment.succeeded', data: { id: 'pay_3', status: 'paid', total: 100, currency: 'usd', metadata: { pass_id: 'wp3', reg_id: 'wr3', lead_id: 'l3', kind: 'seat', attr_vid: 'vbuyer0000001', attr_lt: `facebook|paid|Spring|${ADID}|${ADID}|`, attr_ft: 'instagram|social||||k7m2pq' } } }, async () => {});
    expect(r).toMatchObject({ paid: 'wp3' });
    await flush();
    const c = db.prepare("SELECT kind, funnel, amount, lt_source, lt_campaign, lt_ad_id, ft_source, ft_link_code, via FROM attr_conversions WHERE ref_id = 'wp3'").get();
    expect(c).toEqual({ kind: 'ticket_paid', funnel: 'auto', amount: 10000, lt_source: 'facebook', lt_campaign: 'Spring', lt_ad_id: ADID, ft_source: 'instagram', ft_link_code: 'k7m2pq', via: 'metadata' });
    expect(db.prepare("SELECT stage, value FROM attr_stages WHERE reg_id = 'wr3'").all()).toEqual([{ stage: 'ticket_paid', value: 10000 }]);
    expect(db.prepare("SELECT visitor_id FROM attr_people WHERE lead_id = 'l3'").all()).toEqual([{ visitor_id: 'vbuyer0000001' }]);
    // whopApi merges the lead's attribution into the metadata of every payment it creates (our own ids win).
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body?: string }) => { bodies.push(JSON.parse(init.body ?? '{}')); return new Response('{"id":"pay_x"}', { status: 200 }); }));
    await whopApi(rt, 'POST', 'payments', { metadata: { pass_id: 'wpX', lead_id: 'l3' } });
    expect(bodies[0].metadata).toMatchObject({ pass_id: 'wpX', lead_id: 'l3', attr_lt: `facebook|paid|Spring|${ADID}|${ADID}|` });
  });
});

/** Three registrants (two buyers) with different paths, and some spend, for the report tests. */
async function seedReport(db: DatabaseSync, rt: Runtime) {
  const now = Date.now();
  const people = [
    { lead: 'la', v: 'vaaaaaaaaaaa1', paths: [['facebook', 'paid', 'Camp A', ADID, 'Paid Social'], ['google', 'organic', null, null, 'Organic Search']], buy: 300000 },
    { lead: 'lb', v: 'vbbbbbbbbbbb1', paths: [['instagram', 'social', null, 'k7m2pq', 'Organic Social']], buy: 300000 },
    { lead: 'lc', v: 'vccccccccccc1', paths: [], buy: 0 },
  ];
  const day = new Date(now).toISOString().slice(0, 10);
  db.prepare("INSERT INTO tracked_links (code, label, kind, dest_path, utm_source, utm_medium, utm_campaign, created_at) VALUES ('k7m2pq', 'IG bio', 'custom', '/', 'instagram', 'social', 'bio', ?)").run(now);
  db.prepare("INSERT INTO ad_insights (ad_id, day, adset_id, campaign_id, ad_name, spend, updated_at) VALUES (?, ?, 'as1', 'c1', 'Ad A', 250, ?)").run(ADID, day, now);
  db.prepare("INSERT INTO ad_entities (id, level, name, campaign_id, adset_id, updated_at) VALUES (?, 'ad', 'Ad A', 'c1', 'as1', ?)").run(ADID, now);
  db.prepare("INSERT INTO ad_spend (platform, campaign_id, day, campaign_name, spend, updated_at) VALUES ('meta', 'c1', ?, 'Camp A', 500, ?)").run(day, now);
  let i = 0;
  for (const p of people) {
    lead(db, p.lead, `${p.lead}@example.com`, p.v);
    p.paths.forEach((t, k) => visit(db, { id: `s${p.lead}${k}00000000`, visitor: p.v, at: now - 5 * DAY + k * DAY, source: t[0], medium: t[1], campaign: t[2], content: t[3], channel: t[4] as string }));
    autoReg(db, `wr${p.lead}`, p.lead, now - 3 * DAY + i++ * MIN);
    await captureConversion(rt, { kind: 'registered', funnel: 'auto', refId: `wr${p.lead}`, regId: `wr${p.lead}`, leadId: p.lead, at: now - 3 * DAY, edition: 'recorded' });
    pass(db, { id: `wpt${p.lead}`, reg: `wr${p.lead}`, lead: p.lead, kind: 'seat', amount: 10000, paidAt: now - 3 * DAY + HOUR });
    if (p.buy) pass(db, { id: `wpo${p.lead}`, reg: `wr${p.lead}`, lead: p.lead, kind: 'offer', amount: p.buy, paidAt: now - 2 * DAY });
  }
  db.prepare("UPDATE webinar_registrations SET joined_at = ?, max_position = 3000, live_minutes = ? WHERE id IN ('wrla', 'wrlb')").run(now - 3 * DAY + 2 * HOUR, '1'.repeat(50));
  db.prepare("INSERT INTO webinar_interactions (id, reg_id, lead_id, session_id, kind, key, value, created_at) VALUES ('wi1', 'wrla', 'la', 'ws1', 'poll', 'timeline', 'now', ?)").run(now - 2 * DAY);
  await syncAttribution(rt, { full: true });
}

describe('webinar attribution: revenue and stages', () => {
  const R = () => ({ from: Date.now() - 30 * DAY, to: Date.now() + MIN });

  it('first-touch, last-touch and linear each add up to total revenue on every dimension', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    await seedReport(db, rt);
    const totals = new Set<number>();
    for (const model of ['first', 'last', 'linear'] as const) for (const dim of ['platform', 'campaign', 'ad', 'link', 'landing', 'edition'] as const) {
      const r = await revenueBy(rt, 'all', R(), model, dim);
      const sum = Math.round(r.rows.reduce((a, x) => a + x.revenue, 0) * 100) / 100;
      expect(sum, `${model} ${dim}`).toBeCloseTo(r.total, 1);
      totals.add(r.total);
    }
    expect([...totals]).toEqual([6300]); // 3 tickets of $100 + 2 Sprints of $3,000
    // la came from the Meta ad first, then from Google: first touch credits the ad, last touch Google.
    const first = await revenueBy(rt, 'all', R(), 'first', 'ad');
    const ad = first.rows.find((x) => x.key === ADID)!;
    expect(ad).toMatchObject({ label: 'Ad A', spend: 250, revenue: 3100, registrants: 1, buyers: 1, roas: 12.4, costPerRegistrant: 250 });
    const last = await revenueBy(rt, 'all', R(), 'last', 'platform');
    expect(last.rows.find((x) => x.key === 'Google')).toMatchObject({ revenue: 3100, registrants: 1, spend: null });
    expect(last.rows.find((x) => x.key === 'Not tracked')).toMatchObject({ revenue: 100, registrants: 1 });
    const linear = await revenueBy(rt, 'all', R(), 'linear', 'platform');
    expect(linear.rows.find((x) => x.key === 'Google')!.revenue).toBeCloseTo(1550, 1); // half of la's $3,100
    const camp = await revenueBy(rt, 'all', R(), 'first', 'campaign');
    expect(camp.rows.find((x) => x.key === 'c1')).toMatchObject({ label: 'Camp A', spend: 500 });
  });

  it('refunds net out of revenue, conversions and the stage funnel', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    await seedReport(db, rt);
    await markPassRefunded(rt, { paymentIntent: null, passId: 'wpola', amountRefunded: 300000, fully: true });
    await syncAttribution(rt, { force: true });
    expect(db.prepare("SELECT amount, refunded FROM attr_conversions WHERE ref_id = 'wpola'").get()).toEqual({ amount: 300000, refunded: 300000 });
    const r = await revenueBy(rt, 'all', R(), 'last', 'platform');
    expect(r.total).toBe(3300);
    expect(r.refunded).toBe(3000);
    const s = await stageCounts(rt, 'auto', R());
    expect(s.stages.find((x) => x.id === 'sprint_paid')).toMatchObject({ count: 2, revenue: 3000 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM attr_stages WHERE stage = 'refund'").get()).toEqual({ n: 1 });
  });

  it('derives the room stages and the retention curve from what the room recorded', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    await seedReport(db, rt);
    const s = await stageCounts(rt, 'auto', R());
    const c = (id: string) => s.stages.find((x) => x.id === id)!.count;
    expect([c('registered'), c('ticket_paid'), c('attended'), c('watched_25'), c('watched_50'), c('watched_75'), c('sprint_paid')]).toEqual([3, 3, 2, 2, 2, 2, 2]); // 50 of 66 minutes reached is past 75%
    expect(s.stages.find((x) => x.id === 'homework_day1')!.applies).toBe(false);
    const room = await roomAnalytics(rt, 'auto', R()) as { auto: { editions: { edition: string; viewers: number; curve: number[]; buyByMinutes: { label: string; viewers: number; buyers: number }[] }[] }; predictors: { rows: { label: string; people: number; buyers: number }[] } };
    const e = room.auto.editions[0];
    expect(e).toMatchObject({ edition: 'recorded', viewers: 2 });
    expect(e.curve[0]).toBe(1);
    expect(e.curve[60]).toBe(0);
    expect(e.buyByMinutes.find((b) => b.label === '45 to 59 min')).toMatchObject({ viewers: 2, buyers: 2 });
    expect(room.predictors.rows.find((x) => x.label === 'timeline=now')).toMatchObject({ people: 1, buyers: 1 });
  });

  it('GET /admin/api/attribution/stages follows the contract exactly, and every route needs an admin session', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    await seedReport(db, rt);
    const exec = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const appFor = (auth: boolean) => {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => { c.set('settings', { ...BASE } as never); c.set('reps', []); await next(); });
      if (auth) app.use('/admin/api/*', requireAdmin);
      const admin = new Hono<AppEnv>();
      mountAttributionAdmin(admin);
      app.route('/admin/api', admin);
      return app;
    };
    const env = { DB: d1(db), SESSION_SECRET: 'test-secret-0123456789', ADMIN_PASSWORD: 'devpass' };
    const res = await appFor(false).request(`/admin/api/attribution/stages?funnel=auto&from=${Date.now() - 30 * DAY}&to=${Date.now() + MIN}`, {}, env, exec);
    const body = await res.json() as { stages: { id: string; label: string; count: number; revenue?: number }[] };
    expect(Object.keys(body)).toEqual(['stages']);
    const ids = ['visit', 'registered', 'ticket_paid', 'attended', 'watched_25', 'watched_50', 'offer_seen', 'checkout_started', 'sprint_paid', 'deposit_paid', 'engagement_signed', 'vip_paid', 'homework_day1', 'homework_day2', 'homework_day3', 'homework_day4', 'homework_day5'];
    expect(body.stages.map((s) => s.id).sort()).toEqual([...ids].sort());
    for (const s of body.stages) {
      expect(Object.keys(s).every((k) => ['id', 'label', 'count', 'revenue'].includes(k))).toBe(true);
      expect(typeof s.count).toBe('number');
    }
    expect(body.stages.find((s) => s.id === 'registered')!.count).toBe(3);
    expect(body.stages.find((s) => s.id === 'sprint_paid')).toMatchObject({ count: 2, revenue: 6000 });
    // Dates as YYYY-MM-DD work too; an empty range is zeros, not made-up numbers.
    const empty = await (await appFor(false).request('/admin/api/attribution/stages?funnel=live&from=2020-01-01&to=2020-01-31', {}, env, exec)).json() as typeof body;
    expect(empty.stages.every((s) => s.count === 0)).toBe(true);
    // The full report and the CSV.
    const full = await (await appFor(false).request('/admin/api/attribution?funnel=all&model=linear&dim=platform', {}, env, exec)).json() as { revenue: { total: number }; people: unknown[] };
    expect(full.revenue.total).toBe(6300);
    expect(full.people).toHaveLength(3);
    const csv = await appFor(false).request('/admin/api/attribution/export.csv?type=revenue&dim=campaign', {}, env, exec);
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect((await csv.text()).split('\n')[0]).toMatch(/^key,label,revenue/);
    // Without a session: 401 on every route; cross-site writes 403.
    const authed = appFor(true);
    for (const [m, p] of [['GET', '/attribution/stages'], ['GET', '/attribution'], ['GET', '/attribution/revenue'], ['GET', '/attribution/journey/la'], ['GET', '/attribution/export.csv'], ['POST', '/attribution/sync'], ['POST', '/attribution/zoom/x']]) {
      const r = await authed.request(`/admin/api${p}`, { method: m, headers: { origin: 'http://localhost' } }, env, exec);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
    expect((await authed.request('/admin/api/attribution/sync', { method: 'POST', headers: { origin: 'https://evil.example' } }, env, exec)).status).toBe(403);
    // And the real Funnel HQ router mounts it behind its admin check.
    const { admin } = await import('../src/routes/admin');
    const real = new Hono<AppEnv>();
    real.use('*', async (c, next) => { c.set('settings', { ...BASE } as never); c.set('reps', []); await next(); });
    real.route('/admin/api', admin);
    expect((await real.request('/admin/api/attribution/stages', {}, env, exec)).status).toBe(401);
  });

  it('parses ranges and writes spreadsheet-safe CSV', () => {
    expect(parseRange({ from: '2026-10-01', to: '2026-10-02' })).toEqual({ from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-10-02T00:00:00Z') + DAY - 1 });
    expect(toCsv([{ a: '=1+1', b: 'x,"y"' }])).toBe('a,b\n\'=1+1,"x,""y"""');
  });
});

describe('webinar attribution: copy', () => {
  it('every label, setup step and note passes the house copy rules', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    await seedReport(db, rt);
    const R = { from: Date.now() - 30 * DAY, to: Date.now() + MIN };
    const room = await roomAnalytics(rt, 'all', R) as Record<string, unknown>;
    const strings = { stages: STAGES.map((s) => s.label), setup: (await setupChecks(rt)).items.map((i) => [i.text, i.detail]), room, setting: SETTING_DEFS.find((s) => s.key === 'META_STAGE_EVENTS') };
    expect(auditFields(strings)).toEqual([]);
    expect(JSON.stringify(strings)).not.toMatch(/[!—]/);
    // The Funnel HQ tab's own sentences.
    const js = fsx.readFileSync(`${nodeProc.cwd()}/public/assets/admin-wattrib.js`, 'utf8');
    const sentencesInJs = [...js.matchAll(/'([A-Z][^'<>{}]{24,})'/g)].map((m) => m[1]);
    expect(sentencesInJs.length).toBeGreaterThan(5);
    for (const s of sentencesInJs) expect(auditCopy(s), s).toEqual([]);
    expect(js).not.toMatch(/[!—]['\s]/);
  });
});

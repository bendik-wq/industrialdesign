import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { LEARNING_NOTE, RECOMMENDATIONS, buildPlan, conversionRule, websiteRule } from '../src/audiences/catalog';
import { bandSlug, bookingValues, buildParams, cohortSlot, enrichEvent, sessionSlot, sourcePlatform } from '../src/audiences/enrich';
import { uploadUsers } from '../src/audiences/meta';
import { LIST_SCHEMA, hashRow, isTestEmail, normaliseRow, segmentMembers } from '../src/audiences/segments';
import { CREATE_KIND, audiencesReport, maybeSyncAudiences, proposeCreateAll, proposeLookalikes, setup } from '../src/audiences/sync';
import { approveAction, getAction } from '../src/ops/actions';
import { SETTINGS } from '../src/settings';

// ───────────── A real SQLite database shaped like D1, with every migration applied ─────────────

interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };
const nodeCrypto = node.getBuiltinModule('node:crypto') as { createHash(a: string): { update(s: string): { digest(e: string): string } } };
const sha = (s: string) => nodeCrypto.createHash('sha256').update(s).digest('hex');

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
const READY = { META_PIXEL_ID: '366312909220995', META_ACCESS_TOKEN: 'capi', META_AD_ACCOUNT_ID: '708237402214227' };
const makeRt = (db: DatabaseSync, s: Record<string, string> = {}) =>
  ({ env: { DB: d1(db) }, settings: { SALES_TIMEZONE: 'Australia/Sydney', ...s }, reps: [], origin: 'https://apply.test', waitUntil: () => undefined }) as unknown as Runtime;
const count = (db: DatabaseSync, sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
afterEach(() => { vi.unstubAllGlobals(); });

const NOW = Date.now();
function lead(db: DatabaseSync, id: string, o: { email?: string | null; phone?: string | null; status?: string; tier?: string | null; unsub?: number | null; eu?: boolean; booked?: boolean; country?: string } = {}) {
  db.prepare(`INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, first_name, last_name, email, phone, status, tier, unsubscribed_at, booked_at, country)
    VALUES (?, ?, ?, ?, ?, 'Dana', 'O''Neil', ?, ?, ?, ?, ?, ?, ?)`).run(id, `R${id}`, NOW, NOW, `v_${id}`, o.email === undefined ? `${id}@owner.co` : o.email, o.phone ?? null, o.status ?? 'applied', o.tier ?? null, o.unsub ?? null, o.booked ? NOW : null, o.country ?? 'AU');
  db.prepare(`INSERT INTO sessions (id, visitor_id, started_at, last_seen_at, is_eu) VALUES (?, ?, ?, ?, ?)`).run(`s_${id}`, `v_${id}`, NOW, NOW, o.eu ? 1 : 0);
}
const pass = (db: DatabaseSync, id: string, leadId: string, kind: string, amount = 10000, status = 'paid') =>
  db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES (?, 'wr', ?, ?, ?, ?, 'usd', ?, ?, ?)").run(id, leadId, kind, status, amount, NOW, NOW, NOW);

// ───────────── 1. Enrichment per event type ─────────────

describe('event enrichment', () => {
  const L = { id: 'l1', tier: 'A', revenue_band: '1m-5m', utm_source: 'facebook', channel: 'paid', click_type: 'fbclid' };
  it('booked calls carry tier, funnel and source, and no value', () => {
    const p = buildParams('booking_scheduled', {}, L, { funnel: 'vsl' });
    expect(p).toMatchObject({ content_name: 'Strategy call', content_category: 'strategy_call', content_ids: ['strategy_call'], product_id: 'strategy_call', funnel: 'vsl', tier: 'A', revenue_band: '1m_5m', source_platform: 'facebook' });
    expect(p.value).toBeUndefined();
  });
  it('registrations carry their funnel, session slot and (auto webinar) edition', () => {
    expect(buildParams('webinar_registered', {}, L, { slot: 'tue_19', edition: 'ai' })).toMatchObject({ content_category: 'masterclass', funnel: 'auto', session_slot: 'tue_19', edition: 'ai' });
    const live = buildParams('live_registered', {}, L, { slot: 'thu_18', edition: 'ai' });
    expect(live).toMatchObject({ content_category: 'live_webinar', funnel: 'live', session_slot: 'thu_18' });
    expect(live.edition).toBeUndefined();
    expect(live.tier).toBeUndefined();
    expect(buildParams('challenge_registered', { band: '10m+' }, null, {})).toMatchObject({ content_category: 'challenge', funnel: 'challenge', revenue_band: '10m_plus' });
  });
  it('every purchase type is its own product', () => {
    const cases: [string, Record<string, unknown>, string, string][] = [
      ['webinar_seat_purchased', {}, 'masterclass_ticket', 'ticket'], ['live_ticket_purchased', {}, 'live_ticket', 'ticket'], ['challenge_ticket_paid', {}, 'challenge_ticket', 'ticket'],
      ['challenge_vip_paid', {}, 'challenge_vip', 'vip'], ['webinar_offer_purchased', {}, 'first_deal_sprint', 'sprint'], ['engagement_deposit_purchased', { source: 'live' }, 'engagement_deposit', 'deposit'],
      ['lead_status_changed', { to: 'won' }, 'advisory_engagement', 'engagement'],
    ];
    for (const [name, props, id, cat] of cases) expect(buildParams(name, props, L, { funnel: 'vsl' }), name).toMatchObject({ product_id: id, content_ids: [id], content_category: cat });
    expect(buildParams('engagement_deposit_purchased', { source: 'challenge' }, L, {}).funnel).toBe('challenge');
    expect(buildParams('lead_status_changed', { to: 'won' }, L, { funnel: 'dm' })).toMatchObject({ funnel: 'dm', tier: 'A' });
    expect(buildParams('lead_status_changed', { to: 'lost' }, L, {})).toEqual({});
    expect(buildParams('page_view', {}, L, {})).toEqual({});
    expect(buildParams('attr_attended', { funnel: 'live' }, L, {})).toMatchObject({ funnel: 'live' });
  });
  it('slots, bands and platforms', () => {
    // 2026-11-03 08:00 UTC is Tuesday 19:00 in Sydney (AEDT, UTC+11).
    expect(sessionSlot(Date.UTC(2026, 10, 3, 8, 0), 'Australia/Sydney')).toBe('tue_19');
    expect(sessionSlot(Date.UTC(2026, 10, 3, 8, 0), 'UTC')).toBe('tue_08');
    expect(cohortSlot('2026-11-09', '18:30')).toBe('mon_18');
    expect(bandSlug('<1m')).toBe('under_1m');
    expect(bandSlug('3m-10m')).toBe('3m_10m');
    expect(sourcePlatform({ utm_source: 'ig', channel: null })).toBe('instagram');
    expect(sourcePlatform({ utm_source: null, channel: null, click_type: 'gclid' })).toBe('google');
  });
  it('resolves the funnel and slot from the database', async () => {
    const db = freshDb();
    lead(db, 'a', { tier: 'B' });
    db.prepare("INSERT INTO webinar_sessions (id, starts_at, created_at) VALUES ('ws1', ?, ?)").run(Date.UTC(2026, 10, 3, 8, 0), NOW);
    db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at) VALUES ('wr1', 'tok-aaaaaaaaaaaaaaaa', 'ws1', 'a', ?)").run(NOW - 1000);
    const rt = makeRt(db, { WEBINAR_EDITION: 'ai' });
    const L2 = { id: 'a', tier: 'B', utm_source: null, channel: null };
    expect(await enrichEvent(rt, 'webinar_seat_purchased', { value: 100 }, L2)).toMatchObject({ funnel: 'auto', session_slot: 'tue_19', edition: 'ai', product_id: 'masterclass_ticket' });
    expect(await enrichEvent(rt, 'booking_scheduled', {}, L2)).toMatchObject({ funnel: 'auto', tier: 'B' });
  });
  it('the Meta payload carries the params, and a booked call has a value only when switched on', async () => {
    const db = freshDb();
    lead(db, 'b', { tier: 'A' });
    const sent: { url: string; body: { data: { custom_data: Record<string, unknown>; event_id: string }[] } }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{"events_received":1}'); }));
    const { forwardEvent } = await import('../src/tracking/forward');
    const who = { visitorId: 'v_b', sessionId: null, leadId: 'b', marketingConsent: true };
    await forwardEvent(makeRt(db, READY), who, { id: 'evt_schedule_1', ts: NOW, name: 'booking_scheduled', props: {}, path: null });
    const cd = sent[0].body.data[0].custom_data;
    expect(sent[0].body.data[0].event_id).toBe('evt_schedule_1');
    expect(cd).toMatchObject({ product_id: 'strategy_call', tier: 'A', funnel: 'vsl' });
    expect(cd.value).toBeUndefined();
    sent.length = 0;
    await forwardEvent(makeRt(db, { ...READY, META_SCHEDULE_VALUE: 'on' }), who, { id: 'evt_schedule_2', ts: NOW, name: 'booking_scheduled', props: {}, path: null });
    const v = (await bookingValues(makeRt(db))).find((t) => t.tier === 'A')!;
    expect(sent[0].body.data[0].custom_data).toMatchObject({ value: v.value, currency: v.currency, predicted_value: true });
    expect(v.value).toBe(Math.round(22500 * 0.7 * 0.15));
    // No consent: nothing is sent at all.
    sent.length = 0;
    await forwardEvent(makeRt(db, READY), { ...who, marketingConsent: false }, { id: 'evt_schedule_3', ts: NOW, name: 'booking_scheduled', props: {}, path: null });
    expect(sent.length).toBe(0);
  });
  it('the Pixel side adds the same params with the same event id', () => {
    const f = fs.readFileSync(`${node.cwd()}/public/assets/f.js`, 'utf8');
    expect(f).toMatch(/metaParams\(eventName, data \|\| \{\}\), eventId \? \{ eventID: eventId \}/);
    expect(f).toContain("'/webinar': ['masterclass', 'Masterclass registration', 'auto']");
    expect(fs.readFileSync(`${node.cwd()}/public/assets/webinar.js`, 'utf8')).toContain("F.pixel('CompleteRegistration', body.event_id, { session_slot:");
  });
});

// ───────────── 2. Hashing and normalisation (Meta customer-file rules) ─────────────

describe('customer-list hashing', () => {
  it('normalises each key as Meta specifies, then SHA-256 lowercase hex', async () => {
    const m = { id: 'x', email: '  Dana.ONeil@Example.COM ', phone: '+61 412 345 678', first_name: 'Dána-Marie', last_name: "O'Neil", country: 'AU' };
    expect(normaliseRow(m)).toEqual({ EMAIL: 'dana.oneil@example.com', PHONE: '61412345678', FN: 'dánamarie', LN: 'oneil', COUNTRY: 'au' });
    const row = await hashRow(m);
    expect(row).toEqual([sha('dana.oneil@example.com'), sha('61412345678'), sha('dánamarie'), sha('oneil'), sha('au')]);
    expect(row.every((h) => /^[0-9a-f]{64}$/.test(String(h)))).toBe(true);
    expect(LIST_SCHEMA).toEqual(['EMAIL', 'PHONE', 'FN', 'LN', 'COUNTRY']);
    // Missing values are empty strings; a phone's leading zeros go; LOOKALIKE_VALUE stays a plain number.
    expect(await hashRow({ id: 'y', email: null, phone: '0061400', first_name: null, last_name: null, country: 'Australia', value: 1234.567 }, true)).toEqual(['', sha('61400'), '', '', '', 1234.57]);
  });
});

// ───────────── 3. Consent, suppression and test exclusions ─────────────

describe('who may be uploaded', () => {
  it('leaves out unsubscribed, suppressed, EU without consent, test and owner-excluded people', async () => {
    const db = freshDb();
    lead(db, 'ok');
    lead(db, 'unsub', { unsub: NOW });
    lead(db, 'bounced', { email: 'bounced@owner.co' });
    db.prepare("INSERT INTO email_suppressions (email, reason, created_at) VALUES ('bounced@owner.co', 'bounced', ?)").run(NOW);
    lead(db, 'eu', { eu: true });
    lead(db, 'tst', { email: 'someone@example.com' });
    lead(db, 'team', { email: 'josh@gl-team.com' });
    lead(db, 'nocontact', { email: null });
    for (const id of ['ok', 'unsub', 'bounced', 'eu', 'tst', 'team', 'nocontact']) pass(db, `p_${id}`, id, 'seat');
    pass(db, 'p_refund', 'ok', 'offer', 300000, 'refunded');
    const rt = makeRt(db, { META_AUDIENCE_EXCLUDE: '@gl-team.com' });
    const r = await segmentMembers(rt, { type: 'buyer', product: 'masterclass_ticket' });
    expect(r.members.map((m) => m.id)).toEqual(['ok']);
    expect(r.excluded).toEqual({ unsubscribed: 1, suppressed: 1, no_consent: 1, test: 1, owner_excluded: 1, no_contact: 1 });
    // Refunded Sprint: not a Sprint buyer; deleted leads simply aren't there.
    expect((await segmentMembers(rt, { type: 'buyer', product: 'first_deal_sprint' })).members).toEqual([]);
    db.prepare("DELETE FROM leads WHERE id = 'ok'").run();
    expect((await segmentMembers(rt, { type: 'buyer', product: 'masterclass_ticket' })).members).toEqual([]);
    expect(isTestEmail('a@b.test')).toBe(true);
    expect(isTestEmail('owner@clinic.com.au')).toBe(false);
  });
  it('builds booked-per-tier, no-show, offer-seen-without-purchase and the value list', async () => {
    const db = freshDb();
    lead(db, 'a1', { tier: 'A', booked: true });
    lead(db, 'b1', { tier: 'B', booked: true, status: 'no_show' });
    lead(db, 'v1');
    lead(db, 'v2');
    db.prepare("INSERT INTO attr_stages (id, funnel, stage, lead_id, reg_id, ts) VALUES ('auto:r1:offer_seen', 'auto', 'offer_seen', 'v1', 'r1', ?), ('auto:r2:offer_seen', 'auto', 'offer_seen', 'v2', 'r2', ?)").run(NOW, NOW);
    pass(db, 'pv2', 'v2', 'offer', 300000);
    const rt = makeRt(db);
    expect((await segmentMembers(rt, { type: 'booked', tier: 'A' })).members.map((m) => m.id)).toEqual(['a1']);
    expect((await segmentMembers(rt, { type: 'no_show' })).members.map((m) => m.id)).toEqual(['b1']);
    expect((await segmentMembers(rt, { type: 'offer_seen_no_purchase', funnel: 'auto' })).members.map((m) => m.id)).toEqual(['v1']);
    const val = await segmentMembers(rt, { type: 'buyers_value' });
    expect(val.members).toEqual([expect.objectContaining({ id: 'v2', value: 3000 })]);
  });
});

// ───────────── 4. Rule JSON ─────────────

describe('rules sent to Meta', () => {
  const plan = buildPlan({ slots: [{ funnel: 'auto', slot: 'tue_19' }], countries: ['AU', 'US'] });
  it('website audience rules follow the audience-rules format', () => {
    const it0 = plan.find((i) => i.key === 'web_offer_nobuy_auto')!;
    const r = websiteRule(it0, '366312909220995', 400) as { inclusions: { operator: string; rules: { event_sources: unknown[]; retention_seconds: number; filter: { operator: string; filters: { field: string; operator: string; value: unknown }[] } }[] }; exclusions: { rules: { filter: { filters: { field: string; value: unknown }[] } }[] } };
    expect(r.inclusions.operator).toBe('or');
    expect(r.inclusions.rules[0].event_sources).toEqual([{ type: 'pixel', id: '366312909220995' }]);
    expect(r.inclusions.rules[0].retention_seconds).toBe(180 * 86400); // capped at 180 days
    expect(r.inclusions.rules[0].filter).toEqual({ operator: 'and', filters: [{ field: 'event', operator: '=', value: 'WebinarOfferSeen' }, { field: 'funnel', operator: '=', value: 'auto' }] });
    expect(r.exclusions.rules[0].filter.filters[0]).toEqual({ field: 'event', operator: '=', value: 'Purchase' });
    const slot = websiteRule(plan.find((i) => i.key === 'web_reg_auto_tue_19')!, 'px', 30) as { inclusions: { rules: { retention_seconds: number; filter: { filters: unknown[] } }[] } };
    expect(slot.inclusions.rules[0].retention_seconds).toBe(30 * 86400);
    expect(slot.inclusions.rules[0].filter.filters).toContainEqual({ field: 'session_slot', operator: '=', value: 'tue_19' });
    for (const i of plan.filter((x) => x.kind === 'website')) {
      const w = websiteRule(i, 'px', 90) as { inclusions: { rules: { filter: { filters: { field: string; operator: string }[] } }[] }; exclusions?: { rules: unknown[] } };
      expect(w.inclusions.rules.length + (w.exclusions?.rules.length ?? 0)).toBeLessThanOrEqual(10);
      for (const r2 of w.inclusions.rules) expect(r2.filter.filters.filter((f) => f.field === 'event').every((f) => f.operator === '=')).toBe(true);
    }
  });
  it('custom conversion rules and the full plan', () => {
    expect(conversionRule(plan.find((i) => i.key === 'conv_buy_first_deal_sprint')!)).toEqual({ and: [{ event: { eq: 'Purchase' } }, { product_id: { eq: 'first_deal_sprint' } }] });
    expect(conversionRule(plan.find((i) => i.key === 'conv_booked_tier_a')!)).toEqual({ and: [{ event: { eq: 'Schedule' } }, { tier: { eq: 'A' } }] });
    const keys = plan.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ['conv_booked_tier_a', 'conv_buy_masterclass_ticket', 'conv_buy_first_deal_sprint', 'conv_buy_engagement_deposit', 'conv_buy_challenge_vip', 'conv_reg_live', 'web_reg_auto_tue_19', 'list_reg_auto_tue_19', 'web_attended_live', 'list_watched50_auto', 'web_checkout_nobuy', 'list_booked_tier_c', 'web_no_show', 'list_all_buyers', 'list_clients', 'list_buyers_value', 'lal_buyers_value_1_au', 'lal_clients_3_us']) expect(keys, k).toContain(k);
    expect(plan.filter((i) => i.kind === 'conversion').length).toBeLessThanOrEqual(100);
    expect(plan.find((i) => i.key === 'list_buyers_value')!.valueBased).toBe(true);
  });
});

// ───────────── 5. Nothing reaches the Marketing API without approval and a write token ─────────────

describe('approval and write token', () => {
  it('without the write token nothing can be proposed or sent', async () => {
    const db = freshDb();
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const rt = makeRt(db, READY);
    expect((await setup(rt)).ready).toBe(false);
    await expect(proposeCreateAll(rt)).rejects.toThrow(/write token/i);
    await maybeSyncAudiences(rt);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(count(db, 'SELECT COUNT(*) AS n FROM ops_actions')).toBe(0);
  });

  it('proposing calls nothing; approving creates conversions, audiences and lists; the cron resyncs created lists', async () => {
    const db = freshDb();
    lead(db, 'buyer', { tier: 'A', booked: true });
    pass(db, 'pb', 'buyer', 'offer', 300000);
    const calls: { url: string; params: URLSearchParams }[] = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: URLSearchParams }) => {
      calls.push({ url, params: init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(String(url).split('?')[1] ?? '') });
      return new Response(JSON.stringify(/\/users|usersreplace/.test(url) ? { audience_id: 'x', num_received: 1 } : { id: `m${++n}` }));
    }));
    const rt = makeRt(db, { ...READY, META_ADS_WRITE_TOKEN: 'write-token' });
    const { id } = await proposeCreateAll(rt);
    expect(calls.length).toBe(0);
    await maybeSyncAudiences(rt); // the cron never starts unapproved work
    expect(calls.length).toBe(0);
    const act = (await getAction(rt, id))!;
    expect(act).toMatchObject({ kind: CREATE_KIND, status: 'proposed', risk: 'medium', dept: 'marketing' });
    await expect(proposeCreateAll(rt)).rejects.toThrow(/already waiting/); // one proposal at a time

    const res = await approveAction(rt, id);
    expect(res.summary).toMatch(/Queued/);
    expect(calls.some((c) => c.url.includes('/act_708237402214227/customconversions'))).toBe(true);
    const cc = calls.find((c) => c.url.includes('customconversions'))!;
    expect(cc.params.get('event_source_id')).toBe('366312909220995');
    expect(cc.params.get('access_token')).toBe('write-token');
    expect(JSON.parse(cc.params.get('rule')!)).toHaveProperty('and');
    // Keep going until the queue is empty (the cron does this every 5 minutes).
    for (let i = 0; i < 10 && count(db, "SELECT COUNT(*) AS n FROM meta_audiences WHERE status = 'queued'"); i++) await maybeSyncAudiences(rt);
    expect(count(db, "SELECT COUNT(*) AS n FROM meta_audiences WHERE status = 'queued'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM meta_audiences WHERE status = 'error'")).toBe(0);
    const web = calls.find((c) => c.url.endsWith('/customaudiences') && c.params.get('rule'))!;
    expect(JSON.parse(web.params.get('rule')!).inclusions.rules[0].event_sources[0]).toEqual({ type: 'pixel', id: '366312909220995' });
    const upload = calls.find((c) => c.url.endsWith('/users'))!;
    const payload = JSON.parse(upload.params.get('payload')!);
    expect(payload.schema).toEqual(['EMAIL', 'PHONE', 'FN', 'LN', 'COUNTRY']);
    expect(payload.data[0][0]).toBe(sha('buyer@owner.co'));
    expect(JSON.parse(upload.params.get('session')!)).toMatchObject({ batch_seq: 1, last_batch_flag: true });
    const valueUpload = calls.filter((c) => c.url.endsWith('/users')).map((c) => JSON.parse(c.params.get('payload')!)).find((p) => p.schema.includes('LOOKALIKE_VALUE'));
    expect(valueUpload.data[0][5]).toBe(3000);
    expect(calls.some((c) => c.url.includes('LOOKALIKE') || c.params.get('subtype') === 'LOOKALIKE')).toBe(false); // lookalikes are a separate approval

    // Daily resync: a day later, an unchanged list is not re-uploaded; a changed one is replaced in full.
    db.prepare('UPDATE meta_audiences SET last_synced_at = ?, size_checked_at = ?').run(NOW - 2 * 86_400_000, NOW);
    const before = calls.length;
    await maybeSyncAudiences(rt);
    expect(calls.slice(before).some((c) => /usersreplace|\/users$/.test(c.url))).toBe(false);
    db.prepare('UPDATE meta_audiences SET last_synced_at = ? WHERE key = ?').run(NOW - 2 * 86_400_000, 'list_all_buyers');
    db.prepare('UPDATE meta_audiences SET last_synced_at = ? WHERE key != ?').run(NOW, 'list_all_buyers');
    lead(db, 'buyer2');
    pass(db, 'pb2', 'buyer2', 'seat');
    const mid = calls.length;
    await maybeSyncAudiences(rt);
    const replace = calls.slice(mid).filter((c) => c.url.endsWith('/usersreplace'));
    expect(replace.length).toBe(1);
    expect(JSON.parse(replace[0].params.get('payload')!).data.length).toBe(2);

    // Lookalikes: their own proposal, nothing sent until approved.
    const l = await proposeLookalikes(rt, 'list_buyers_value');
    const beforeLal = calls.length;
    expect(calls.length).toBe(beforeLal);
    await approveAction(rt, l.id);
    const lal = calls.slice(beforeLal).filter((c) => c.params.get('subtype') === 'LOOKALIKE');
    expect(lal.length).toBe(2);
    expect(JSON.parse(lal[0].params.get('lookalike_spec')!)).toEqual({ type: 'similarity', ratio: 0.01, country: 'AU' });
  });

  it('an approved action with no write token sends nothing', async () => {
    const db = freshDb();
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const withToken = makeRt(db, { ...READY, META_ADS_WRITE_TOKEN: 'w' });
    const { id } = await proposeCreateAll(withToken);
    const res = await approveAction(makeRt(db, READY), id); // token removed before approval
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a terms refusal is recorded and shown in the setup checklist', async () => {
    const db = freshDb();
    lead(db, 'b');
    pass(db, 'pb', 'b', 'seat');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (/\/users$/.test(url)
      ? new Response(JSON.stringify({ error: { message: 'Custom Audience Terms Not Accepted', code: 1870090 } }), { status: 400 })
      : new Response(JSON.stringify({ id: 'm1' })))));
    const rt = makeRt(db, { ...READY, META_ADS_WRITE_TOKEN: 'w' });
    const { id } = await proposeCreateAll(rt);
    await approveAction(rt, id);
    for (let i = 0; i < 10; i++) await maybeSyncAudiences(rt);
    const su = await setup(rt);
    expect(su.terms).toBe(false);
    expect(su.steps.find((s) => s.id === 'terms')!.detail).toMatch(/customaudiences\/tos/);
  });
});

// ───────────── 6. Upload batching ─────────────

describe('upload sessions', () => {
  it('splits into batches of 10,000 in one session, last batch flagged, replace uses usersreplace', async () => {
    const calls: { url: string; payload: { data: unknown[] }; session: { session_id: number; batch_seq: number; last_batch_flag: boolean; estimated_num_total: number } }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: URLSearchParams }) => {
      calls.push({ url, payload: JSON.parse(init.body.get('payload')!), session: JSON.parse(init.body.get('session')!) });
      return new Response('{"num_received":1}');
    }));
    const rows = Array.from({ length: 25_000 }, (_, i) => [sha(`p${i}@x.co`), '', '', '', '']);
    const rt = { settings: { META_ADS_WRITE_TOKEN: 'w', META_AD_ACCOUNT_ID: '1' } } as unknown as Runtime;
    expect(await uploadUsers(rt, '999', LIST_SCHEMA, rows, true)).toBe(3);
    expect(calls.map((c) => c.payload.data.length)).toEqual([10_000, 10_000, 5_000]);
    expect(calls.map((c) => c.session.batch_seq)).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.session.last_batch_flag)).toEqual([false, false, true]);
    expect(new Set(calls.map((c) => c.session.session_id)).size).toBe(1);
    expect(Number.isSafeInteger(calls[0].session.session_id) && calls[0].session.session_id > 0).toBe(true);
    expect(calls.every((c) => c.url.endsWith('/999/usersreplace') && c.session.estimated_num_total === 25_000)).toBe(true);
    await expect(uploadUsers({ settings: {} } as unknown as Runtime, '999', LIST_SCHEMA, rows, false)).rejects.toThrow(/write token/);
  });
});

// ───────────── 7. Copy ─────────────

describe('copy', () => {
  it('every user-facing string passes auditCopy', async () => {
    const plan = buildPlan({ slots: [{ funnel: 'live', slot: 'thu_18' }], countries: ['AU'] });
    const texts: string[] = [LEARNING_NOTE, ...RECOMMENDATIONS.flatMap((r) => [r.campaign, r.optimise, r.then]), ...plan.flatMap((i) => [i.name, i.description])];
    const db = freshDb();
    const rt = makeRt(db, READY);
    for (const s of (await setup(rt)).steps) texts.push(s.label, s.detail);
    const rep = await audiencesReport(rt);
    for (const t of rep.bookingValues) texts.push(t.basis);
    for (const s of SETTINGS.filter((x) => /^META_(SCHEDULE_VALUE|AUDIENCE_|LOOKALIKE)/.test(x.key))) texts.push(s.label, (s as { help?: string }).help ?? '');
    const admin = fs.readFileSync(`${node.cwd()}/public/assets/admin.js`, 'utf8');
    const m = /\n {4}audiences: \{[^\n]*sub: '([^']*)', more: '([^']*)'/.exec(admin);
    expect(m).not.toBeNull();
    texts.push(m![1], m![2]);
    for (const t of texts) expect(auditCopy(t), t).toEqual([]);
    const ui = fs.readFileSync(`${node.cwd()}/public/assets/admin-audiences.js`, 'utf8');
    expect(ui).not.toMatch(/—|!['"]/);
    expect(ui).not.toMatch(/\bfree\b/i);
    expect(rep.items.length).toBeGreaterThan(40);
  });
});

// ───────────── 8. Admin auth ─────────────

describe('admin routes', () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  it('every audiences API needs the admin session', async () => {
    const app = (await import('../src/index')).default;
    const db = freshDb();
    const env = { DB: d1(db), ASSETS: { fetch: async () => new Response('', { status: 404 }) }, ADMIN_PASSWORD: 'devpass', SESSION_SECRET: 'x'.repeat(32), ...READY, META_ADS_WRITE_TOKEN: 'w' };
    const call = (method: string, p: string) => app.fetch(new Request(`https://apply.test/admin/api/audiences${p}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }), env as never, ctx as never);
    for (const [m, p] of [['GET', ''], ['POST', '/create'], ['POST', '/lookalikes'], ['POST', '/terms'], ['POST', '/sync/list_all_buyers']]) {
      expect([401, 403], `${m} ${p}`).toContain((await call(m, p)).status);
    }
    expect(count(db, 'SELECT COUNT(*) AS n FROM ops_actions')).toBe(0);
  });
});

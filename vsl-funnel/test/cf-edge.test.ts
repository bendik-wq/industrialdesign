import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import type { VisitorCtx } from '../src/lib/identity';
import { SETTINGS as SETTING_DEFS } from '../src/settings';
import { auditCopy } from '../src/content/copy-rules';
import { SITEVERIFY_URL, TURNSTILE_COPY, TURNSTILE_SCRIPT, checkTurnstile, counterKey, turnstileMode, turnstileReport, turnstileSiteKey } from '../src/infra/turnstile';
import { withTurnstile } from '../src/infra/csp';
import { AE_DATASET, AE_SQL, aeEventsReport, aeOn, eventMeasures, toDataPoint, writeAe } from '../src/infra/analytics-engine';
import { roomQualityPoint, type MediaRec } from '../src/rooms/media';

// Cloudflare platform round, builder B: Turnstile (bot protection) and Analytics Engine.

// ───────────── a real SQLite database shaped like D1, with every migration applied ─────────────
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

const T0 = Date.parse('2026-11-03T02:00:00Z');
const ALL = () => Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ''])) as Record<string, string>;
const KEYS = { TURNSTILE_SITE_KEY: '0x4AAAAsite', TURNSTILE_SECRET_KEY: '0x4AAAAsecret-do-not-log' };
let db: DatabaseSync;
const pending: Promise<unknown>[] = [];
const makeRt = (s: Record<string, string> = {}, env: Record<string, unknown> = {}) =>
  ({ env: { DB: d1(db), SESSION_SECRET: 'test-secret-0123456789', ...env }, settings: { ...ALL(), ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const visitor = (o: Partial<VisitorCtx> = {}): VisitorCtx => ({
  visitorId: 'v000000000001', sessionId: 's000000000001', leadId: null, isNewVisitor: false, isNewSession: false, isBot: false, botReason: null, variant: 'a',
  ua: { device: 'mobile', browser: 'x', os: 'y' } as never, userAgent: 'test (x)', geo: { country: 'AU', city: null, timezone: 'Australia/Sydney' } as never, ip: '203.0.113.7',
  touch: { channel: 'Paid Social' } as never, fbp: null, fbc: null, marketingConsent: true, consentRequired: false, ...o,
});
function seedVisit(id = 's000000000001', vid = 'v000000000001') {
  db.prepare('INSERT OR IGNORE INTO visitors (id, created_at, last_seen_at, ft_channel, is_bot) VALUES (?, ?, ?, ?, 0)').run(vid, T0, T0, 'Direct');
  db.prepare("INSERT INTO sessions (id, visitor_id, started_at, last_seen_at, landing_path, channel, is_bot) VALUES (?, ?, ?, ?, '/', 'Direct', 0)").run(id, vid, T0, T0);
  db.prepare("INSERT INTO events (id, ts, name, visitor_id, session_id, source, is_bot) VALUES (?, ?, 'page_view', ?, ?, 'server', 0)").run(`e-${id}`, T0, vid, id);
}

// siteverify mock: answers with `answer` (or throws / returns a status), and records what was sent.
let calls: { url: string; form: Record<string, string> }[] = [];
function mockSiteverify(answer: Record<string, unknown> | Error | number) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: FormData } = {}) => {
    const form: Record<string, string> = {};
    if (init.body instanceof FormData) init.body.forEach((v, k) => { form[k] = String(v); });
    calls.push({ url: String(url), form });
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'number') return new Response('oops', { status: answer });
    return new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
  }));
}

beforeAll(async () => { await import('../src/index'); }, 60_000);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  calls = [];
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); pending.length = 0; });

describe('Turnstile mode', () => {
  it('is off by default, and off without both keys', () => {
    expect(turnstileMode(ALL())).toBe('off');
    expect(turnstileMode({ ...ALL(), ...KEYS })).toBe('off'); // keys alone don't switch it on
    expect(turnstileMode({ ...ALL(), TURNSTILE_MODE: 'enforce', TURNSTILE_SITE_KEY: 'x' })).toBe('off');
    expect(turnstileMode({ ...ALL(), TURNSTILE_MODE: 'log', TURNSTILE_SECRET_KEY: 'x' })).toBe('off');
    expect(turnstileMode({ ...ALL(), TURNSTILE_MODE: 'nonsense', ...KEYS })).toBe('off');
    expect(turnstileMode({ ...ALL(), TURNSTILE_MODE: ' Log ', ...KEYS })).toBe('log');
    expect(turnstileMode({ ...ALL(), TURNSTILE_MODE: 'enforce', ...KEYS })).toBe('enforce');
    expect(turnstileSiteKey({ ...ALL(), ...KEYS })).toBeNull();
    expect(turnstileSiteKey({ ...ALL(), TURNSTILE_MODE: 'log', ...KEYS })).toBe(KEYS.TURNSTILE_SITE_KEY);
  });

  it('off: no request to Cloudflare, nothing counted, everything passes', async () => {
    mockSiteverify({ success: false });
    const r = await checkTurnstile(makeRt(KEYS), 'apply', undefined, visitor());
    expect(r).toMatchObject({ ok: true, mode: 'off', outcome: 'off' });
    expect(calls).toHaveLength(0);
    expect(q("SELECT * FROM kv_state WHERE key LIKE 'tsv:%'")).toHaveLength(0);
  });
});

describe('Turnstile siteverify', () => {
  it('sends the secret, the token and the IP to siteverify, and counts a pass', async () => {
    mockSiteverify({ success: true });
    const r = await checkTurnstile(makeRt({ TURNSTILE_MODE: 'enforce', ...KEYS }), 'apply', 'tok-123', visitor());
    expect(r).toMatchObject({ ok: true, outcome: 'pass' });
    expect(calls).toEqual([{ url: SITEVERIFY_URL, form: { secret: KEYS.TURNSTILE_SECRET_KEY, response: 'tok-123', remoteip: '203.0.113.7' } }]);
    expect(SITEVERIFY_URL).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(q('SELECT value FROM kv_state WHERE key = ?', counterKey('2026-11-03', 'apply', 'pass'))).toEqual([{ value: '1' }]);
  });

  it('log mode never refuses: a failure and a missing token are counted and let through, nobody is marked', async () => {
    seedVisit();
    mockSiteverify({ success: false, 'error-codes': ['invalid-input-response'] });
    const rt = makeRt({ TURNSTILE_MODE: 'log', ...KEYS });
    expect(await checkTurnstile(rt, 'webinar', 'bad', visitor())).toMatchObject({ ok: true, outcome: 'fail', codes: ['invalid-input-response'] });
    expect(await checkTurnstile(rt, 'webinar', '', visitor())).toMatchObject({ ok: true, outcome: 'missing' });
    expect(calls).toHaveLength(1); // no token, no request
    expect(q("SELECT is_bot, bot_reason FROM sessions")).toEqual([{ is_bot: 0, bot_reason: null }]);
    const rep = await turnstileReport(rt);
    expect(rep.mode).toBe('log');
    expect(rep.forms.find((f) => f.form === 'webinar')).toMatchObject({ pass: 0, fail: 1, missing: 1, unreachable: 0 });
  });

  it('enforce refuses a missing or failed token and marks the session (and its events) as non-human', async () => {
    seedVisit();
    mockSiteverify({ success: false, 'error-codes': ['invalid-input-response'] });
    const rt = makeRt({ TURNSTILE_MODE: 'enforce', ...KEYS });
    const v = visitor();
    expect(await checkTurnstile(rt, 'live', null, v)).toMatchObject({ ok: false, outcome: 'missing' });
    expect(q('SELECT is_bot FROM sessions')).toEqual([{ is_bot: 0 }]); // missing alone is not proof
    expect(await checkTurnstile(rt, 'live', 'forged', v)).toMatchObject({ ok: false, outcome: 'fail' });
    expect(q('SELECT is_bot, bot_reason FROM sessions')).toEqual([{ is_bot: 1, bot_reason: 'turnstile' }]);
    expect(q('SELECT is_bot FROM events')).toEqual([{ is_bot: 1 }]);
    expect(q('SELECT is_bot FROM visitors')).toEqual([{ is_bot: 1 }]);
    expect(v.isBot).toBe(true); // this request's own tracking isn't forwarded to ad platforms either
    // A later pass in the same session: the person counts again.
    mockSiteverify({ success: true });
    expect(await checkTurnstile(rt, 'live', 'good', v)).toMatchObject({ ok: true, outcome: 'pass' });
    expect(q('SELECT is_bot, bot_reason FROM sessions')).toEqual([{ is_bot: 0, bot_reason: null }]);
    expect(q('SELECT is_bot FROM events')).toEqual([{ is_bot: 0 }]);
    expect(v.isBot).toBe(false);
  });

  it('enforce: an expired token is refused but never marks a bot; a lead is never marked', async () => {
    seedVisit();
    mockSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    const rt = makeRt({ TURNSTILE_MODE: 'enforce', ...KEYS });
    expect(await checkTurnstile(rt, 'challenge', 'old', visitor())).toMatchObject({ ok: false, outcome: 'fail' });
    mockSiteverify({ success: false, 'error-codes': ['invalid-input-response'] });
    expect(await checkTurnstile(rt, 'challenge', 'bad', visitor({ leadId: 'l1' }))).toMatchObject({ ok: false, outcome: 'fail' });
    expect(q('SELECT is_bot FROM sessions')).toEqual([{ is_bot: 0 }]);
  });

  it('fails open when Cloudflare is unreachable, errors, times out or rejects our own keys, and logs it without the secret', async () => {
    const rt = makeRt({ TURNSTILE_MODE: 'enforce', ...KEYS });
    for (const answer of [new TypeError('fetch failed'), Object.assign(new Error('t'), { name: 'TimeoutError' }), 503, { success: false, 'error-codes': ['invalid-input-secret'] }, { nope: 1 }] as const) {
      mockSiteverify(answer as never);
      expect(await checkTurnstile(rt, 'room_join', 'tok', visitor())).toMatchObject({ ok: true, outcome: 'unreachable' });
    }
    expect(q('SELECT value FROM kv_state WHERE key = ?', counterKey('2026-11-03', 'room_join', 'unreachable'))).toEqual([{ value: '5' }]);
    const errs = q<{ message: string; source: string }>('SELECT message, source FROM app_errors');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((e) => e.source === 'turnstile room_join' && /let through/.test(e.message))).toBe(true);
    expect(JSON.stringify(errs)).not.toContain(KEYS.TURNSTILE_SECRET_KEY);
  });

  it('the report covers 7 days only and names a missing key', async () => {
    db.prepare("INSERT INTO kv_state (key, value) VALUES (?, '4'), (?, '9')").run(counterKey('2026-10-20', 'apply', 'pass'), counterKey('2026-10-28', 'apply', 'pass'));
    const rep = await turnstileReport(makeRt({ TURNSTILE_MODE: 'enforce', TURNSTILE_SITE_KEY: 'x' }));
    expect(rep.mode).toBe('off');
    expect(rep.problem).toMatch(/secret key is missing/);
    expect(rep.forms.find((f) => f.form === 'apply')!.pass).toBe(9);
  });
});

describe('Turnstile on the forms', () => {
  it('the application refuses a missing token in enforce mode with the calm message (field turnstile, 403), and is unchanged when off', async () => {
    const { saveContact, ApplicationError } = await import('../src/funnel/application');
    mockSiteverify({ success: true });
    const body = { first_name: 'Dana', email: 'dana@example.com', phone: '0412 345 678' };
    const err = await saveContact(makeRt({ TURNSTILE_MODE: 'enforce', ...KEYS }), visitor(), body).catch((e) => e);
    expect(err).toBeInstanceOf(ApplicationError);
    expect(err).toMatchObject({ message: TURNSTILE_COPY.failed, field: 'turnstile', status: 403 });
    // Off: the same request reaches the next step (no Turnstile request at all).
    calls = [];
    const off = await saveContact(makeRt(KEYS), visitor(), body).catch((e) => e);
    expect(off instanceof ApplicationError && off.field === 'turnstile').toBe(false);
    expect(calls.filter((c) => c.url === SITEVERIFY_URL)).toHaveLength(0);
  });

  it('the room join sheet shows the widget and accepts the CSP change only when on; a failed join keeps what was typed', async () => {
    const { joinSheet, joinRoom } = await import('../src/rooms/admission');
    const room = { id: 'r_test0000001', mode: 'meeting', title: 'Deal review', ref_type: 'none', ref_id: null, lead_id: null, starts_at: null, duration_min: 60, status: 'scheduled', engage: null } as never;
    const a = { on: true, requireEmail: false, v: 0, cohostV: 0 };
    const off = await joinSheet(makeRt(KEYS), room, a, { action: '/x' });
    expect(off).not.toContain('cf-turnstile');
    expect(off).not.toContain(TURNSTILE_SCRIPT);
    const on = await joinSheet(makeRt({ TURNSTILE_MODE: 'log', ...KEYS }), room, a, { action: '/x', values: { first_name: 'Sam' }, error: TURNSTILE_COPY.failed });
    expect(on).toContain(`data-sitekey="${KEYS.TURNSTILE_SITE_KEY}"`);
    expect(on).toContain(TURNSTILE_SCRIPT);
    expect(on).toContain('value="Sam"');
    expect(on).not.toContain(KEYS.TURNSTILE_SECRET_KEY);

    mockSiteverify({ success: false, 'error-codes': ['invalid-input-response'] });
    const refused = await joinRoom(makeRt({ TURNSTILE_MODE: 'enforce', ...KEYS }), room, visitor(), { name: 'Sam', 'cf-turnstile-response': 'bad' }, a);
    expect(refused).toEqual({ error: TURNSTILE_COPY.failed, field: 'turnstile', status: 403 });
    const logged = await joinRoom(makeRt({ TURNSTILE_MODE: 'log', ...KEYS }), room, visitor(), { name: 'Sam', 'cf-turnstile-response': 'bad' }, a);
    expect('redirect' in logged).toBe(true);
  });

  it('CSP: unchanged when off; Turnstile script and frame allowed when on', () => {
    const room = "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
    expect(withTurnstile(room, false)).toBe(room);
    const on = withTurnstile(room, true);
    expect(on).toContain('script-src https://challenges.cloudflare.com');
    expect(on).not.toMatch(/script-src[^;]*'none'/);
    expect(on).toContain("frame-src 'self' https://challenges.cloudflare.com");
    expect(on).toContain("frame-ancestors 'none'"); // other directives untouched
    expect(withTurnstile(on, true)).toBe(on); // idempotent
    // A policy without default-src (the funnel pages) doesn't restrict scripts, so nothing is added.
    expect(withTurnstile("object-src 'none'; base-uri 'none'; frame-ancestors 'self'", true)).toBe("object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    expect(withTurnstile("default-src 'self'; script-src 'self'", true)).toBe("default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com");
  });

  it('copy passes the house rules', () => {
    expect(auditCopy(TURNSTILE_COPY.failed)).toEqual([]);
    for (const k of ['TURNSTILE_MODE', 'ANALYTICS_ENGINE', 'CF_ACCOUNT_ID', 'CF_ANALYTICS_TOKEN']) {
      const def = SETTING_DEFS.find((d) => d.key === k) as { help?: string; secret?: boolean } | undefined;
      expect(def, k).toBeTruthy();
      expect(auditCopy(def!.help ?? '').filter((i) => i.rule !== 'long-sentence')).toEqual([]);
    }
    expect((SETTING_DEFS.find((d) => d.key === 'CF_ANALYTICS_TOKEN') as { secret?: boolean }).secret).toBe(true);
  });
});

describe('Analytics Engine', () => {
  it('lays out a point as documented: index = name; blobs name, path, channel, source, country, device, variant, room, visitor, kind; doubles value, duration', () => {
    expect(toDataPoint({ name: 'cta_click', path: '/apply', channel: 'Paid Social', source: 'client', country: 'AU', device: 'mobile', variant: 'b', roomId: null, visitorId: 'v1', value: 3, durationMs: 1200 }))
      .toEqual({ indexes: ['cta_click'], blobs: ['cta_click', '/apply', 'Paid Social', 'client', 'AU', 'mobile', 'b', '', 'v1', 'human'], doubles: [3, 1200] });
    const long = toDataPoint({ name: 'x'.repeat(200), path: '/p'.repeat(400), bot: true, value: NaN });
    expect(long.indexes![0]).toHaveLength(96);
    expect((long.blobs![1] as string).length).toBe(256);
    expect(long.blobs![9]).toBe('bot');
    expect(long.doubles).toEqual([0, 0]);
    expect(eventMeasures({ ms: 4000, room_id: 'r1', value: 100 })).toEqual({ value: 100, durationMs: 4000, roomId: 'r1' });
  });

  it('writes only when the setting is on and the binding exists, and never throws', () => {
    const points: unknown[] = [];
    const EVENTS = { writeDataPoint: (p: unknown) => { points.push(p); } };
    expect(aeOn({ env: {}, settings: { ANALYTICS_ENGINE: 'on' } })).toBe(false); // no binding
    expect(writeAe({ env: { EVENTS: EVENTS as never }, settings: { ANALYTICS_ENGINE: '' } }, { name: 'a' })).toBe(false);
    expect(writeAe({ env: {}, settings: { ANALYTICS_ENGINE: 'on' } }, { name: 'a' })).toBe(false);
    expect(writeAe({ env: { EVENTS: EVENTS as never }, settings: { ANALYTICS_ENGINE: 'on' } }, { name: 'a' })).toBe(true);
    expect(points).toHaveLength(1);
    expect(writeAe({ env: { EVENTS: { writeDataPoint: () => { throw new Error('quota'); } } as never }, settings: { ANALYTICS_ENGINE: 'on' } }, { name: 'a' })).toBe(false);
  });

  it('track() keeps writing D1 exactly as before and adds the Analytics Engine copy when on', async () => {
    const { track, identityFromVisitor } = await import('../src/tracking/track');
    const points: AnalyticsEngineDataPoint[] = [];
    const EVENTS = { writeDataPoint: (p: AnalyticsEngineDataPoint) => { points.push(p); } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    await track(makeRt({}, { EVENTS }), identityFromVisitor(visitor({ isBot: true })), { name: 'cta_click', source: 'client', path: '/apply', props: { id: 'x' } });
    expect(points).toHaveLength(0); // off by default
    await track(makeRt({ ANALYTICS_ENGINE: 'on' }, { EVENTS }), identityFromVisitor(visitor({ isBot: true })), { name: 'engaged_time', source: 'client', path: '/apply', props: { ms: 5000 } });
    expect(points).toEqual([{ indexes: ['engaged_time'], blobs: ['engaged_time', '/apply', 'Paid Social', 'client', 'AU', 'mobile', 'a', '', 'v000000000001', 'bot'], doubles: [0, 5000] }]);
    await track(makeRt({ ANALYTICS_ENGINE: 'on' }), identityFromVisitor(visitor({ isBot: true })), { name: 'cta_click', source: 'client', path: '/apply' }); // no binding: fine
    expect(q('SELECT name, path, source, is_bot FROM events ORDER BY ts, name')).toEqual([
      { name: 'cta_click', path: '/apply', source: 'client', is_bot: 1 },
      { name: 'cta_click', path: '/apply', source: 'client', is_bot: 1 },
      { name: 'engaged_time', path: '/apply', source: 'client', is_bot: 1 },
    ]);
  });

  it('room quality reports become room_quality points', () => {
    const rec = { who: 'm1', name: 'Sam', role: 'attendee', leadId: null, firstAt: T0, lastAt: T0, samples: 3, counts: { good: 3, fair: 0, poor: 0, bad: 0 }, worst: 'good', audioOnly: 0, dirty: true,
      sums: {} as never,
      last: { level: 'fair', score: 72, rtt: 180, loss: 0.02, jitter: 12, inKbps: 900, outKbps: 300, tier: 1, why: null, rc: 0, path: 'sfu', relay: false, proto: null, os: 'iOS', browser: 'Safari', mobile: true, fx: null, noise: null, pub: false } } as unknown as MediaRec;
    expect(toDataPoint(roomQualityPoint('r_abc', rec))).toEqual({
      indexes: ['room_quality'],
      blobs: ['room_quality', '/rooms/r_abc', 'attendee', 'room', '', 'mobile iOS/Safari', 'fair', 'r_abc', 'm1', 'human'],
      doubles: [72, 180, 0.02, 12, 900, 300, 1],
    });
  });

  it('the Funnel HQ read path: asks for the token when missing; reads the SQL API with it; reports API errors', async () => {
    db.prepare("INSERT INTO events (id, ts, name, source, is_bot) VALUES ('e1', ?, 'page_view', 'server', 0), ('e2', ?, 'page_view', 'server', 0)").run(T0 - 3_600_000, T0 - 3_600_000);
    const none = await aeEventsReport(makeRt());
    expect(none).toMatchObject({ configured: false, on: false, binding: false, dataset: AE_DATASET });
    expect(none.rows).toEqual([{ day: '2026-11-03', name: 'page_view', ae: null, d1: 2 }]);

    const sent: { url: string; auth: string; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent.push({ url: String(url), auth: init.headers.authorization, body: init.body });
      return new Response(JSON.stringify({ data: init.body.includes('blob2 AS path') ? [{ path: '/apply', n: '7' }] : [{ day: '2026-11-03 00:00:00', name: 'page_view', n: '3' }, { day: '2026-11-02 00:00:00', name: 'cta_click', n: 1 }] }));
    }));
    const rt = makeRt({ ANALYTICS_ENGINE: 'on', CF_ACCOUNT_ID: 'acc123', CF_ANALYTICS_TOKEN: 'tok-secret' }, { EVENTS: { writeDataPoint() {} } });
    const r = await aeEventsReport(rt);
    expect(sent.map((s) => s.url)).toEqual(['https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql', 'https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql']);
    expect(sent[0].auth).toBe('Bearer tok-secret');
    expect(sent.map((s) => s.body)).toEqual([AE_SQL.perDay(30), AE_SQL.topPaths(30)]);
    expect(AE_SQL.perDay(30)).toContain('SUM(_sample_interval)');
    expect(AE_SQL.perDay(30)).toContain(`FROM ${AE_DATASET}`);
    expect(r).toMatchObject({ configured: true, on: true, binding: true, error: null, paths: [{ path: '/apply', n: 7 }] });
    expect(r.rows).toEqual([{ day: '2026-11-03', name: 'page_view', ae: 3, d1: 2 }, { day: '2026-11-02', name: 'cta_click', ae: 1, d1: 0 }]);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"errors":[{"message":"Authentication error"}]}', { status: 403 })));
    const bad = await aeEventsReport(rt);
    expect(bad.error).toMatch(/403/);
    expect(bad.error).not.toContain('tok-secret');
  });
});

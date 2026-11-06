import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The quiz end to end through the real app on a real SQLite database with every migration applied: start, answers,
// the gate (lead, consent with proof, tags, tracking), the result page, the one-click seat for both QUIZ_TARGETs,
// rate limits, and the Funnel HQ route for the owner and for guests.

interface SqlStmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface SqlDb { prepare(sql: string): SqlStmt; exec(sql: string): void }
const nodeP = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = nodeP.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => SqlDb };
const nfs = nodeP.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };
function d1(db: SqlDb) {
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
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select|\breturning\b/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${nodeP.cwd()}/migrations`;
  for (const f of nfs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(nfs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

const ORIGIN = 'https://apply.test';
let sdb: SqlDb;
let extraEnv: Record<string, string> = {};
const pend: Promise<unknown>[] = [];
const exCtx = { waitUntil: (p: Promise<unknown>) => { pend.push(p.catch(() => null)); }, passThroughOnException: () => {} };
const settle = async () => { while (pend.length) await Promise.all(pend.splice(0)); };
const PAGE = '<!doctype html><html><head><title>t</title></head><body></body></html>';
const envFor = () => ({ DB: d1(sdb), SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD: 'devpass', ASSETS: { fetch: async () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }) }, ...extraEnv });
type App = { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> };
let app: App;

/** A browser: keeps its cookies between requests. */
function browser(ip = '203.0.113.7') {
  const jar = new Map<string, string>();
  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cf-connecting-ip', ip);
    if (!headers.has('accept-language')) headers.set('accept-language', 'en-AU,en;q=0.9');
    if (!headers.has('user-agent')) headers.set('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), envFor(), exCtx);
    for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  };
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await call(path, { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { call, post, jar };
}

const ANSWERS = { revenue: '3_10m', industry: 'healthcare', goal: 'competitor', margin: '10_20', debt: 'open', funding: 'bank', deals: '0', timeline: '6_12', blocker: 'funding', team: 'partly' };
const q = (sql: string, ...a: unknown[]) => sdb.prepare(sql).all(...(a as (string | number | null)[])) as Record<string, unknown>[];
const one = (sql: string, ...a: unknown[]) => q(sql, ...a)[0];
const events = (name: string) => q('SELECT props, lead_id, id FROM events WHERE name = ? ORDER BY ts', name);

async function takeQuiz(b: ReturnType<typeof browser>, gate: Record<string, unknown> = {}) {
  expect((await b.call('/quiz')).status).toBe(200);
  const s = await b.post('/api/quiz/start', { event_id: 'qs_evt_000001' });
  expect(s.status).toBe(200);
  const token = String(s.body.token);
  for (const [question, value] of Object.entries(ANSWERS)) expect((await b.post('/api/quiz/answer', { token, question, value })).status).toBe(200);
  expect((await b.post('/api/quiz/gate', { token })).status).toBe(200);
  const lead = await b.post('/api/quiz/lead', { token, first_name: 'Dana', email: 'dana@example.com', answers: ANSWERS, consent_page: '/quiz', event_id: 'ql_evt_000001', ...gate });
  await settle();
  return { token, lead };
}

beforeAll(async () => {
  vi.stubGlobal('HTMLRewriter', class { on() { return this; } transform(r: Response) { return r; } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"offline"}', { status: 503, headers: { 'content-type': 'application/json' } })));
  app = (await import('../src/index')).default as unknown as App;
}, 60_000);
beforeEach(async () => {
  sdb = freshDb();
  extraEnv = {};
  pend.length = 0;
  (await import('../src/settings')).resetSettingsCache();
  (await import('../src/lib/hq-cache')).memoryClear();
  const now = Date.now();
  sdb.prepare("INSERT INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES ('ws_next', ?, 'evergreen', 'scheduled', 0, ?)").run(now + 2 * 86_400_000, now);
  sdb.prepare("INSERT INTO live_webinars (id, title, starts_at, tz, duration_min, status, created_at, updated_at) VALUES ('lw_next', 'Live with Josh', ?, 'Australia/Sydney', 90, 'scheduled', ?, ?)").run(now + 3 * 86_400_000, now, now);
});

describe('quiz: start, answers and drop-off', () => {
  it('saves each answer as it is given, with a quiz_answer event per step', async () => {
    const b = browser();
    const s = await b.post('/api/quiz/start', {});
    const token = String(s.body.token);
    expect(token).toMatch(/^[a-z0-9]{16,40}$/);
    expect(events('quiz_start')).toHaveLength(1);
    await b.post('/api/quiz/answer', { token, question: 'revenue', value: '3_10m' });
    await b.post('/api/quiz/answer', { token, question: 'industry', value: 'trades' });
    const row = one('SELECT answers, step_reached, completed_at FROM quiz_responses WHERE token = ?', token);
    expect(JSON.parse(String(row.answers))).toEqual({ revenue: '3_10m', industry: 'trades' });
    expect(row.step_reached).toBe(2);
    expect(row.completed_at).toBeNull();
    expect(events('quiz_answer').map((e) => JSON.parse(String(e.props)).step)).toEqual([1, 2]);
    // An unknown answer or question is refused; an unknown token is told to start again.
    expect((await b.post('/api/quiz/answer', { token, question: 'revenue', value: 'a lot' })).status).toBe(400);
    expect((await b.post('/api/quiz/answer', { token, question: 'shoe_size', value: '9' })).status).toBe(400);
    expect((await b.post('/api/quiz/answer', { token: 'nope', question: 'revenue', value: 'lt1m' })).status).toBe(404);
  });

  it('refuses calls from other sites', async () => {
    const b = browser();
    const res = await b.call('/api/quiz/start', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
  });
});

describe('quiz: the email gate', () => {
  it('creates the lead, scores, tags by archetype and gap, fills the lead fields and tracks quiz_lead', async () => {
    const b = browser();
    const { token, lead } = await takeQuiz(b);
    expect(lead.status).toBe(200);
    expect(lead.body).toMatchObject({ ok: true, next: `/quiz/r/${token}`, archetype: 'first_deal', score: 67 });
    const row = one('SELECT * FROM quiz_responses WHERE token = ?', token);
    expect(row).toMatchObject({ score: 67, archetype: 'first_deal', revenue_band: '3m-10m', step_reached: 10, first_name: 'Dana' });
    expect(JSON.parse(String(row.gaps))).toEqual(['funding', 'plan']);
    expect(row.gate_viewed_at).not.toBeNull();
    const l = one('SELECT id, email, revenue_band, industry, landing_path, status FROM leads WHERE email = ?', 'dana@example.com');
    expect(l).toMatchObject({ revenue_band: '3m-10m', industry: 'Healthcare and allied health', status: 'partial' });
    expect(row.lead_id).toBe(l.id);
    expect(q('SELECT tag FROM lead_tags WHERE lead_id = ? ORDER BY tag', l.id).map((t) => t.tag)).toEqual(['quiz:first_deal', 'quiz:gap:funding', 'quiz:gap:plan']);
    const ev = events('quiz_lead');
    expect(ev).toHaveLength(1);
    expect(ev[0].id).toBe('ql_evt_000001'); // the Pixel copy shares this id
    expect(JSON.parse(String(ev[0].props))).toMatchObject({ archetype: 'first_deal', score: 67, band: '3m-10m', gaps: 'funding,plan' });
    expect(events('quiz_gate_view')).toHaveLength(1);
    expect(events('revenue_band')).toHaveLength(1); // revenue events, once, like the other funnels
    // The result email (simulated without a Resend key), with the link back to the result.
    expect(q("SELECT template, status FROM emails WHERE lead_id = ? AND template = 'quiz_result'", l.id)).toEqual([{ template: 'quiz_result', status: 'simulated' }]);
    // The segment helper reads the tag back.
    const { quizSegment } = await import('../src/quiz/quiz');
    expect(await quizSegment({ env: { DB: d1(sdb) } } as never, String(l.id))).toBe('first_deal');
  });

  it('captures the two consent boxes exactly like the live funnel: with proof, only what was ticked', async () => {
    const b = browser();
    await takeQuiz(b, { phone: '+61412345678', sms_consent: true, call_consent: false });
    const l = one('SELECT id, phone, sms_consent_at, call_consent_at FROM leads WHERE email = ?', 'dana@example.com');
    expect(l.phone).toBe('+61412345678');
    expect(l.sms_consent_at).not.toBeNull();
    expect(l.call_consent_at).toBeNull();
    const ce = q('SELECT channel, action, phone, source, page_url, text_version, ip_hash FROM consent_events WHERE lead_id = ? ORDER BY channel', l.id);
    const { CONSENT_COPY } = await import('../src/integrations/consent-gate');
    expect(ce.map((r) => r.channel)).toEqual(['sms', 'whatsapp']);
    for (const r of ce) expect(r).toMatchObject({ action: 'granted', phone: '+61412345678', source: 'quiz', page_url: '/quiz', text_version: CONSENT_COPY.version });
    expect(ce[0].ip_hash).toBeTruthy();
  });

  it('records nothing when no box is ticked, and never changes an existing lead’s details', async () => {
    const now = Date.now();
    sdb.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, status, revenue_band, industry) VALUES ('l_old', 'OLD1', ?, ?, 'Pat', 'dana@example.com', 'applied', '10m-25m', 'Dental')").run(now, now);
    const b = browser();
    const { lead } = await takeQuiz(b, { phone: '+61412345678' });
    expect(lead.status).toBe(200);
    expect(one("SELECT first_name, revenue_band, industry, phone FROM leads WHERE id = 'l_old'")).toEqual({ first_name: 'Pat', revenue_band: '10m-25m', industry: 'Dental', phone: null });
    expect(q("SELECT * FROM consent_events WHERE lead_id = 'l_old'")).toEqual([]);
    expect(q('SELECT COUNT(*) AS n FROM leads')[0].n).toBe(1);
  });

  it('checks the fields and every answer', async () => {
    const b = browser();
    const s = await b.post('/api/quiz/start', {});
    const token = String(s.body.token);
    const r1 = await b.post('/api/quiz/lead', { token, first_name: 'Dana', email: 'dana@example.com', answers: { revenue: '3_10m' } });
    expect(r1).toMatchObject({ status: 400, body: { field: 'answers' } });
    const r2 = await b.post('/api/quiz/lead', { token, first_name: '', email: 'dana@example.com', answers: ANSWERS });
    expect(r2.body.field).toBe('first_name');
    const r3 = await b.post('/api/quiz/lead', { token, first_name: 'Dana', email: 'not-an-email', answers: ANSWERS });
    expect(r3.body.field).toBe('email');
    const r4 = await b.post('/api/quiz/lead', { token, first_name: 'Dana', email: 'dana@example.com', phone: '12', answers: ANSWERS });
    expect(r4.body.field).toBe('phone');
    expect(q('SELECT COUNT(*) AS n FROM leads')[0].n).toBe(0);
  });

  it('runs Turnstile like the other forms when it is enforced', async () => {
    extraEnv = { TURNSTILE_MODE: 'enforce', TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' };
    (await import('../src/settings')).resetSettingsCache();
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { headers: { 'content-type': 'application/json' } }));
    const b = browser();
    const s = await b.post('/api/quiz/start', {});
    const r = await b.post('/api/quiz/lead', { token: s.body.token, first_name: 'Dana', email: 'dana@example.com', answers: ANSWERS, turnstile: 'bad' });
    expect(r).toMatchObject({ status: 403, body: { field: 'turnstile' } });
    expect(q('SELECT COUNT(*) AS n FROM leads')[0].n).toBe(0);
  });

  it('limits new quiz leads per connection', async () => {
    const b = browser('198.51.100.42');
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      const s = await b.post('/api/quiz/start', {});
      const r = await b.post('/api/quiz/lead', { token: s.body.token, first_name: 'Dana', email: `dana${i}@example.com`, answers: ANSWERS });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 8)).toEqual([200, 200, 200, 200, 200, 200, 200, 200]);
    expect(statuses[8]).toBe(429);
  });
});

describe('quiz: the result and the one-click seat', () => {
  it('the result page counts its first view as quiz_result; an unknown token goes back to the quiz', async () => {
    const b = browser();
    const { token } = await takeQuiz(b);
    expect((await b.call(`/quiz/r/${token}`)).status).toBe(200);
    expect((await b.call(`/quiz/r/${token}`)).status).toBe(200);
    expect(events('quiz_result')).toHaveLength(1);
    expect(one('SELECT result_viewed_at FROM quiz_responses WHERE token = ?', token).result_viewed_at).not.toBeNull();
    const miss = await b.call('/quiz/r/abcdefghijklmnopqrst');
    expect(miss.status).toBe(302);
    expect(miss.headers.get('location')).toBe('/quiz');
  });

  it('QUIZ_TARGET webinar (default): registers for the chosen showing with the band, the room answer and the same tracking', async () => {
    const b = browser();
    const { token } = await takeQuiz(b);
    const r = await b.post('/api/quiz/register', { token, session_id: 'ws_next', track_id: 'wr_evt_000001', pixel_eid: 'px_evt_000001' });
    await settle();
    expect(r.status).toBe(200);
    expect(String(r.body.next)).toMatch(/\/webinar\/registered\/[a-z0-9]+$/);
    const reg = one('SELECT id, session_id, revenue_band, lead_id FROM webinar_registrations');
    expect(reg).toMatchObject({ session_id: 'ws_next', revenue_band: '3m-10m' });
    expect(one('SELECT target, reg_id, registered_at FROM quiz_responses WHERE token = ?', token)).toMatchObject({ target: 'webinar', reg_id: reg.id });
    // The thank-you page's "which business would you most like to own?" is answered from the quiz.
    expect(q("SELECT kind, value FROM webinar_interactions WHERE reg_id = ? AND kind = 'commit'", reg.id)).toEqual([{ kind: 'commit', value: 'competitor' }]);
    const wr = events('webinar_registered');
    expect(wr).toHaveLength(1);
    expect(wr[0].id).toBe('wr_evt_000001');
    expect(events('quiz_register').map((e) => JSON.parse(String(e.props)))).toEqual([expect.objectContaining({ target: 'webinar', archetype: 'first_deal', score: 67 })]);
    expect(one("SELECT webinar_token FROM leads WHERE id = ?", reg.lead_id).webinar_token).toBeTruthy();
    // A second click is the same seat, not a second registration.
    const again = await b.post('/api/quiz/register', { token, session_id: 'ws_next' });
    expect(again.status).toBe(200);
    expect(q('SELECT COUNT(*) AS n FROM webinar_registrations')[0].n).toBe(1);
    expect(events('quiz_register')).toHaveLength(1);
  });

  it('QUIZ_TARGET live: registers for the next live event', async () => {
    extraEnv = { QUIZ_TARGET: 'live' };
    (await import('../src/settings')).resetSettingsCache();
    const b = browser();
    const { token } = await takeQuiz(b);
    const r = await b.post('/api/quiz/register', { token, event_id: 'lw_next', track_id: 'lr_evt_000001' });
    await settle();
    expect(r.status).toBe(200);
    expect(String(r.body.next)).toMatch(/\/live\/room\/[a-z0-9]+\?new=1$/);
    expect(one('SELECT event_id, revenue_band FROM live_webinar_regs')).toEqual({ event_id: 'lw_next', revenue_band: '3m-10m' });
    expect(q('SELECT COUNT(*) AS n FROM webinar_registrations')[0].n).toBe(0);
    expect(one('SELECT target FROM quiz_responses WHERE token = ?', token).target).toBe('live');
    expect(events('live_registered')).toHaveLength(1);
    expect(events('quiz_register').map((e) => JSON.parse(String(e.props)).target)).toEqual(['live']);
  });

  it('cannot register before the gate', async () => {
    const b = browser();
    const s = await b.post('/api/quiz/start', {});
    const r = await b.post('/api/quiz/register', { token: s.body.token, session_id: 'ws_next' });
    expect(r.status).toBe(409);
    expect(q('SELECT COUNT(*) AS n FROM webinar_registrations')[0].n).toBe(0);
  });
});

describe('quiz: tracking', () => {
  it('every quiz event is first-party and goes on to Meta and GA4 by name', async () => {
    const { META_EVENTS, GA4_EVENTS } = await import('../src/tracking/catalog');
    for (const n of ['quiz_start', 'quiz_lead', 'quiz_result']) expect(META_EVENTS[n], n).toBeTruthy();
    expect(META_EVENTS.quiz_register).toBeUndefined(); // the registration's own CompleteRegistration covers it
    for (const n of ['quiz_start', 'quiz_answer', 'quiz_gate_view', 'quiz_lead', 'quiz_result', 'quiz_register']) expect(GA4_EVENTS[n], n).toBe(n);
    const b = browser();
    const { token } = await takeQuiz(b);
    await b.call(`/quiz/r/${token}`);
    await b.post('/api/quiz/register', { token, session_id: 'ws_next' });
    await settle();
    const names = q("SELECT DISTINCT name FROM events WHERE name LIKE 'quiz_%' ORDER BY name").map((r) => r.name);
    expect(names).toEqual(['quiz_answer', 'quiz_gate_view', 'quiz_lead', 'quiz_register', 'quiz_result', 'quiz_start']);
    // Every quiz event after the gate carries the lead.
    expect(q("SELECT COUNT(*) AS n FROM events WHERE name IN ('quiz_lead', 'quiz_result', 'quiz_register') AND lead_id IS NULL")[0].n).toBe(0);
  });

  it('keeps the visit’s attribution on the quiz row and the lead', async () => {
    const b = browser();
    await b.call('/quiz?utm_source=facebook&utm_medium=paid&utm_campaign=quiz_test&utm_content=ad42');
    const s = await b.post('/api/quiz/start', {});
    const row = one('SELECT utm_source, utm_campaign, utm_content FROM quiz_responses WHERE token = ?', s.body.token);
    expect(row).toEqual({ utm_source: 'facebook', utm_campaign: 'quiz_test', utm_content: 'ad42' });
    await b.post('/api/quiz/lead', { token: s.body.token, first_name: 'Dana', email: 'dana@example.com', answers: ANSWERS });
    expect(one('SELECT utm_source, utm_campaign FROM leads')).toEqual({ utm_source: 'facebook', utm_campaign: 'quiz_test' });
  });
});

describe('quiz: Funnel HQ', () => {
  async function owner(b: ReturnType<typeof browser>) {
    const res = await b.call('/admin/login', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=devpass' });
    expect(res.status).toBe(302);
  }

  it('the Quiz view needs a login, then shows the funnel per step, archetypes, scores and the leads', async () => {
    const visitor = browser();
    const { token } = await takeQuiz(visitor);
    await visitor.post('/api/quiz/register', { token, session_id: 'ws_next' });
    await settle();
    const anon = browser('192.0.2.50');
    expect((await anon.call('/admin/api/quiz')).status).toBe(401);
    const hq = browser('192.0.2.51');
    await owner(hq);
    const res = await hq.call(`/admin/api/quiz?from=1&to=${Date.now() + 1000}`);
    expect(res.status).toBe(200);
    const d = (await res.json()) as { kpis: Record<string, number>; steps: { key: string; n: number; rate: number | null }[]; archetypes: { id: string; n: number }[]; scores: { label: string; n: number }[]; leads: Record<string, unknown>[]; target: string };
    const step = (k: string) => d.steps.find((s) => s.key === k)!.n;
    expect([step('landing'), step('started'), step('q1'), step('q10'), step('gate'), step('lead'), step('registered')]).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(d.kpis).toMatchObject({ started: 1, leads: 1, completion: 1, registered: 1, avgScore: 67 });
    expect(d.archetypes.find((a) => a.id === 'first_deal')!.n).toBe(1);
    expect(d.scores.find((s) => s.label === '60 to 79')!.n).toBe(1);
    expect(d.leads[0]).toMatchObject({ email: 'dana@example.com', archetype: 'first_deal', score: 67, target: 'webinar', attended: false, bought: false });
    expect(d.target).toBe('webinar');
  });

  it('guests may read the Quiz view (GET) and nothing else', async () => {
    const { guestDecision } = await import('../src/admin/guest');
    expect(guestDecision('GET', '/admin/api/quiz', true)).toEqual({ ok: true });
    expect(guestDecision('POST', '/admin/api/quiz', false).ok).toBe(false);
  });

  it('the quiz has a Funnel map, page previews and rate limits on every public write', async () => {
    const { mapById } = await import('../src/admin/funnel-maps-defs');
    const { mapCounts } = await import('../src/admin/funnel-maps');
    const m = mapById('quiz')!;
    expect(m.ladder).toEqual(['qzstart', 'qzgate', 'qzlead', 'qzresult', 'qzseat', 'qzattend', 'qzbought']);
    const b = browser();
    await takeQuiz(b);
    const counts = await mapCounts({ env: { DB: d1(sdb) }, settings: {}, reps: [], origin: ORIGIN, waitUntil: () => {} } as never, 'quiz', { from: 1, to: Date.now() + 1000 });
    expect([counts.started.n, counts.gate.n, counts.lead.n, counts.registered.n]).toEqual([1, 1, 1, 0]);
    const { PUBLIC_RATE_LIMITS } = await import('../src/lib/ratelimit');
    for (const p of ['/api/quiz/start', '/api/quiz/answer', '/api/quiz/gate', '/api/quiz/lead', '/api/quiz/register']) expect(PUBLIC_RATE_LIMITS.some((l) => l.path === p), p).toBe(true);
    const hq = browser('192.0.2.52');
    await owner(hq);
    const pages = (await (await hq.call('/admin/api/pages')).json()) as { pages: { group: string; src: string }[] };
    expect(pages.pages.filter((p) => p.group === 'Quiz').map((p) => p.src)).toEqual(['/quiz?hq_preview=1', '/quiz?hq_step=3&hq_preview=1', '/quiz?hq_step=gate&hq_preview=1', '/quiz/r/preview?hq_preview=1']);
    // The made-up result is only for a logged-in admin's preview.
    expect((await hq.call('/quiz/r/preview?hq_preview=1')).status).toBe(200);
    const pub = await browser('192.0.2.53').call('/quiz/r/preview');
    expect(pub.status).toBe(302);
  });
});

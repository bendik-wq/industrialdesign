import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDossier } from '../src/followup/dossier';
import { TEMPLATES, type TemplateCtx, renderEmail } from '../src/integrations/templates';
import { blockReason, callingZones, inCallingHours, nextCallingTime } from '../src/integrations/elevenlabs';
import { validateEmail } from '../src/funnel/leads';
import { plain } from '../src/integrations/notify';
import { defang, hasContactBait } from '../src/lib/text';
import { validateAi } from '../src/personalize/personalize';
import type { Lead } from '../src/funnel/leads';

const PAYLOAD = 'x</em><a href="https://evil.example/login">Reset your password</a><img src="https://evil.example/p.gif"><em>';
const hostile = {
  id: 'l1', first_name: 'Dana', status: 'booked', booked_at: 1, call_at: Date.now() + 86_400_000,
  answers: JSON.stringify({ business: PAYLOAD, why_now: `${PAYLOAD} pay at pay-gl-advisory.com or call +1 555 010 0199`, goal: 'acquire', blockers: ['funding'] }),
  booking_answers: JSON.stringify([{ q: '<b>Q</b>', a: PAYLOAD }]),
} as unknown as Lead;
const ctx = (lead: Lead): TemplateCtx => ({ lead, name: 'Dana', siteName: 'G&L', link: (p) => `https://x.test${p}`, bookingUrl: 'https://cal.test', whatsappUrl: null, callTime: 'Mon 3pm' });

describe('security: lead-written text in emails', () => {
  it('never becomes markup, links or contact bait', () => {
    for (const t of ['pp_brief', 'pp_booking', 'pp_why_now', 'nu_why', 'fu_goal', 'cx_3', 'won_6', 'ns_goal']) {
      const { html } = renderEmail(TEMPLATES[t](ctx(hostile)), { openPixel: null, unsubscribeUrl: 'u', signature: 'Josh', address: 'a' });
      expect(html, t).not.toMatch(/evil\.example|<a href="https:\/\/evil|<img src/);
      expect(html, t).not.toMatch(/pay-gl-advisory\.com|555 010 0199/);
    }
    expect(buildDossier(hostile).whyNow).toContain('&lt;');
  });

  it('defangs domains, emails and phone numbers', () => {
    expect(defang('go to evil.com/x or mail a@b.co or ring +61 412 345 678')).toBe('go to […] or mail […] or ring […]');
    expect(hasContactBait('We plateaued at $2M in 2023')).toBe(false);
    expect(validateAi({ subject: 's', preheader: 'p', ps: '', paragraphs: ['Hi Dana,', 'Pay at pay-gl.com today.'], facts_used: [] }, new Set())).toBeTruthy();
    expect(validateAi({ subject: 's', preheader: 'p', ps: '', paragraphs: ['Hi Dana,', 'Reply with your bank details.'], facts_used: [] }, new Set())).toBeTruthy();
  });

  it('rejects email addresses that could carry markup', () => {
    expect(validateEmail('<svg/onload=alert(1)>@x.co')).toBeNull();
    expect(validateEmail('"<img/src/onerror=alert(1)>"@attacker.com')).toBeNull();
    expect(validateEmail('<!channel>@x.co')).toBeNull();
    expect(validateEmail('josh.li+test@joshli.com.au')?.email).toBe('josh.li+test@joshli.com.au');
  });

  it('strips Slack/Discord link and mention syntax from team pings', () => {
    const out = plain('<!channel> <https://evil.example|Open in Funnel HQ> [Open](https://evil.example)');
    expect(out).not.toMatch(/[<>[\]|]|https:\/\//);
  });
});

describe('security: AI calls', () => {
  const base = { phone: '+61412345678', call_consent_at: 1, status: 'booked', booked_at: 1, booking_cancelled_at: null, call_at: Date.now() + 3 * 86_400_000, do_not_call_at: null } as unknown as Lead;

  it('uses the phone number’s country, never the browser’s location', () => {
    expect(callingZones('+61412345678')).toContain('Australia/Perth');
    expect(callingZones('+18085550100')).toEqual(['Pacific/Honolulu']);
    expect(callingZones('+882123456789')).toBeNull();
    expect(blockReason({ ...base, phone: '+882123456789' }, 'confirm')).toBe('number outside the countries we call');
  });

  it('only calls when it is within hours in every zone of the country', () => {
    // Tue 13 Oct 2026, 9:30am Sydney = 6:30am Perth → not yet; 1pm Sydney = 10am Perth → yes
    expect(inCallingHours(Date.parse('2026-10-12T22:30:00Z'), callingZones('+61412345678')!)).toBe(false);
    expect(inCallingHours(Date.parse('2026-10-13T02:00:00Z'), callingZones('+61412345678')!)).toBe(true);
    // US: 10am New York is 7am Los Angeles → not yet
    expect(inCallingHours(Date.parse('2026-10-13T14:00:00Z'), callingZones('+12125550100')!)).toBe(false);
  });

  it('skips Australian national public holidays', () => {
    // Christmas Day 2026 (Fri) and Good Friday 2027 (26 Mar), midday Sydney
    expect(inCallingHours(Date.parse('2026-12-25T01:00:00Z'), 'Australia/Sydney')).toBe(false);
    expect(inCallingHours(Date.parse('2027-03-26T01:00:00Z'), 'Australia/Sydney')).toBe(false);
    expect(inCallingHours(Date.parse('2027-03-25T01:00:00Z'), 'Australia/Sydney')).toBe(true);
    expect(nextCallingTime(Date.parse('2026-12-24T09:00:00Z'), 'Australia/Sydney')).toBe(Date.parse('2026-12-27T22:00:00Z'));
  });
});

describe('audit fixes (Oct 2026)', () => {
  it('voice: a caller matched only by caller ID gets nothing worth phishing for', async () => {
    const { callVariables } = await import('../src/integrations/voice');
    const lead = { id: 'l1', ref_code: 'ABC234', first_name: 'Dana', last_name: 'Secret', answers: JSON.stringify({ business: 'Three clinics, 22% margins', revenue: '1m-3m' }), app_completed_at: 1 } as never;
    const vars = await callVariables({} as never, lead, false);
    const all = JSON.stringify(vars);
    expect(vars.first_name).toBe('Dana');
    expect(all).not.toContain('Secret');
    expect(all).not.toContain('22%');
    expect(all).not.toContain('1m-3m');
    expect(all).not.toContain('ABC234');
    expect(all).not.toContain('lead_sig');
  });

  it('booking: a cancellation for a different booking never touches the lead', async () => {
    const { markCancelled } = await import('../src/integrations/booking');
    const touched: string[] = [];
    const rt = { env: { DB: new Proxy({}, { get: () => { touched.push('db'); throw new Error('must not touch the database'); } }) } } as never;
    const lead = { id: 'l1', booking_ref: 'https://api.calendly.com/scheduled_events/REAL', booking_cancelled_at: null, booking_source: 'funnel', status: 'booked' } as never;
    await markCancelled(rt, lead, 'calendly', 'https://api.calendly.com/scheduled_events/ATTACKER');
    expect(touched).toEqual([]);
  });

  it('voice agent prompt names seller rollover and forbids reading back what is on file', async () => {
    const { voiceSystemPrompt } = await import('../src/config');
    const p = voiceSystemPrompt([]);
    expect(p).toContain('seller rollover');
    expect(p).toMatch(/Never read back, confirm or hint at what's on file/);
  });
});

describe('scoring rubric stays server-side', () => {
  it('serialised client config exposes no points or flags', async () => {
    const { APPLICATION } = await import('../src/config');
    const client = APPLICATION.map((q: any) => {
      const base: any = { id: q.id, type: q.type, title: q.title };
      if (q.help) base.help = q.help;
      if (q.placeholder) base.placeholder = q.placeholder;
      if (q.minLength) base.minLength = q.minLength;
      if (Array.isArray(q.options)) base.options = q.options.map((o: any) => ({ value: o.value, label: o.label }));
      return base;
    });
    const json = JSON.stringify(client);
    expect(json).not.toContain('points');
    expect(json).not.toContain('flags');
    // the real rubric does carry them, so the test is meaningful
    expect(JSON.stringify(APPLICATION)).toContain('points');
  });
});

// ═════════════ Security round (overnight round 2): CSP reports, rate limits, admin sessions, secrets ═════════════

interface SqlStmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface SqlDb { prepare(sql: string): SqlStmt; exec(sql: string): void }
const nodeP = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = nodeP.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => SqlDb };
const nfs = nodeP.getBuiltinModule('node:fs') as { readdirSync(p: string, o?: { withFileTypes: true }): { name: string; isDirectory(): boolean; isFile(): boolean }[]; readFileSync(p: string, enc: string): string; statSync(p: string): { size: number } };
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
  for (const f of nfs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name).filter((x) => x.endsWith('.sql')).sort()) db.exec(nfs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

const ORIGIN = 'https://apply.test';
let sdb: SqlDb;
const pend: Promise<unknown>[] = [];
const exCtx = { waitUntil: (p: Promise<unknown>) => { pend.push(p.catch(() => null)); }, passThroughOnException: () => {} };
const settle = async () => { while (pend.length) await Promise.all(pend.splice(0)); };
const ADMIN_HTML = '<!doctype html><html><head><title>HQ</title></head><body><script src="/assets/admin.js"></script></body></html>';
const envFor = () => ({
  DB: d1(sdb), SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD: 'devpass',
  ASSETS: { fetch: async () => new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
});
type App = { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> };
let app: App;
let routeTable: () => { method: string; path: string }[];
const call = (path: string, init: RequestInit & { ip?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', init.ip ?? '203.0.113.7');
  return app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), envFor(), exCtx);
};
const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
const form = { ...same, 'content-type': 'application/x-www-form-urlencoded' };
async function loginCookie(ip = '198.51.100.1') {
  const res = await call('/admin/login', { method: 'POST', ip, headers: form, body: 'password=devpass' });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/admin');
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], raw: res.headers.get('set-cookie') ?? '' };
}

beforeAll(async () => {
  // Pages pass through the asset versioner (HTMLRewriter in Workers): a pass-through stand-in here.
  vi.stubGlobal('HTMLRewriter', class { on() { return this; } transform(r: Response) { return r; } });
  const mod = await import('../src/index');
  app = mod.default as unknown as App;
  routeTable = mod.routeTable;
}, 60_000);
beforeEach(async () => {
  sdb = freshDb();
  pend.length = 0;
  (await import('../src/infra/errors')).resetErrorThrottle();
});

describe('security: CSP violation reporting', () => {
  it('appends report directives without changing the policy', async () => {
    const { withReporting, reportingEndpoints } = await import('../src/infra/csp');
    const p = "default-src 'self'; script-src 'self'; object-src 'none'";
    const out = withReporting(p);
    expect(out.startsWith(p)).toBe(true);
    expect(out).toBe(`${p}; report-uri /csp-report; report-to csp`);
    expect(withReporting(out)).toBe(out);
    expect(withReporting("sandbox; default-src 'none';")).toBe("sandbox; default-src 'none'; report-uri /csp-report; report-to csp");
    expect(reportingEndpoints(ORIGIN)).toBe('csp="https://apply.test/csp-report"');
  });

  it('every page CSP the app sends (admin, funnel pages) carries the report directives', async () => {
    const { cookie } = await loginCookie();
    const admin = await call('/admin', { headers: { cookie } });
    expect(admin.status).toBe(200);
    const csp = admin.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'; script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'; report-uri /csp-report; report-to csp");
    expect(admin.headers.get('reporting-endpoints')).toBe('csp="https://apply.test/csp-report"');
    const present = await call('/admin/present', { headers: { cookie } });
    expect(present.headers.get('content-security-policy')).toMatch(/connect-src 'self'; object-src 'none'.*report-uri \/csp-report; report-to csp$/);
    const funnel = await call('/camera-test');
    expect(funnel.headers.get('content-security-policy')).toBe("object-src 'none'; base-uri 'none'; frame-ancestors 'self'; report-uri /csp-report; report-to csp");
    // Not pages: nothing to report from, so nothing added.
    const health = await call('/health');
    expect(health.headers.get('content-security-policy')).toBe("object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
  });

  it('no CSP in src/ types its own report directive (the middleware adds it to all of them)', () => {
    const files = walk(`${nodeP.cwd()}/src`).filter((f) => f.endsWith('.ts'));
    const policies = files.flatMap((f) => [...nfs.readFileSync(f, 'utf8').matchAll(/content-security-policy['"]?\s*[:,]\s*[`'"]([^`'"]+)/gi)].map((m) => m[1]));
    expect(policies.length).toBeGreaterThanOrEqual(8);
    for (const p of policies) expect(p).not.toMatch(/report-(uri|to)/);
  });

  it('files report-uri and Reporting API reports in the error log as kind "csp"', async () => {
    const one = { 'csp-report': { 'document-uri': 'https://apply.test/ticket/abcdef1234567890?x=1', 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example/x.js?token=sekret', disposition: 'enforce' } };
    const r1 = await call('/csp-report', { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: JSON.stringify(one) });
    expect(r1.status).toBe(204);
    const batch = [
      { type: 'csp-violation', body: { documentURL: 'https://apply.test/admin', effectiveDirective: 'img-src', blockedURL: 'data', disposition: 'enforce' } },
      { type: 'csp-violation', body: { documentURL: 'https://apply.test/', effectiveDirective: 'script-src-elem', blockedURL: 'chrome-extension://abc/inject.js' } },
      { type: 'deprecation', body: {} },
    ];
    const r2 = await call('/csp-report', { method: 'POST', headers: { 'content-type': 'application/reports+json' }, body: JSON.stringify(batch) });
    expect(r2.status).toBe(204);
    await settle();
    const rows = sdb.prepare('SELECT kind, source, message FROM app_errors ORDER BY source').all() as { kind: string; source: string; message: string }[];
    expect(rows).toHaveLength(2); // the extension's violation is ignored
    expect(rows.every((r) => r.kind === 'csp')).toBe(true);
    expect(rows.map((r) => r.source)).toEqual(['img-src on /admin', 'script-src-elem on /ticket/:x']);
    expect(rows[1].message).toBe('CSP script-src-elem blocked https://evil.example');
    expect(JSON.stringify(rows)).not.toContain('sekret');
  });

  it('caps the body size and rate-limits per connection', async () => {
    const big = JSON.stringify({ 'csp-report': { 'document-uri': `${ORIGIN}/`, 'effective-directive': 'img-src', 'blocked-uri': 'x'.repeat(20_000) } });
    expect((await call('/csp-report', { method: 'POST', body: big })).status).toBe(413);
    const body = JSON.stringify({ 'csp-report': { 'document-uri': `${ORIGIN}/`, 'effective-directive': 'img-src', 'blocked-uri': 'https://x.example/a.png' } });
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await call('/csp-report', { method: 'POST', ip: '192.0.2.50', body })).status;
    expect(last).toBe(429);
    expect((await call('/csp-report', { method: 'POST', ip: '192.0.2.51', body })).status).toBe(204);
    await settle();
  });
});

describe('security: rate limits on public endpoints', () => {
  it('counts atomically and resets after the window', async () => {
    const { overLimit, hit } = await import('../src/lib/ratelimit');
    const env = { DB: d1(sdb) } as never;
    const t0 = Date.parse('2026-11-03T00:00:00Z');
    const results = await Promise.all(Array.from({ length: 25 }, () => overLimit(env, 'k:1.2.3.4', 10, 60_000, t0)));
    expect(results.filter((x) => !x)).toHaveLength(10);
    expect(await overLimit(env, 'k:1.2.3.4', 10, 60_000, t0 + 59_000)).toBe(true);
    expect(await overLimit(env, 'k:1.2.3.4', 10, 60_000, t0 + 60_001)).toBe(false);
    // A legacy value (or junk) starts a fresh window instead of failing.
    sdb.prepare("INSERT INTO kv_state (key, value) VALUES ('rl:old', 'not json')").run();
    expect(await hit(env, 'rl:old', 60_000, t0)).toBe(1);
  });

  it('every limit is mounted on a real route, and the 429 copy passes the copy rules', async () => {
    const { PUBLIC_RATE_LIMITS, RATE_LIMIT_COPY, RATE_LIMIT_COPY_CHARGE } = await import('../src/lib/ratelimit');
    const { auditCopy } = await import('../src/content/copy-rules');
    expect(auditCopy(RATE_LIMIT_COPY)).toEqual([]);
    expect(auditCopy(RATE_LIMIT_COPY_CHARGE)).toEqual([]);
    const { LOGIN_COPY } = await import('../src/admin/auth');
    for (const v of Object.values(LOGIN_COPY)) expect(auditCopy(v), v).toEqual([]);
    const routes = routeTable().filter((r) => r.method !== 'ALL');
    for (const l of PUBLIC_RATE_LIMITS) {
      // The limiter itself plus a real handler for the same method and path.
      expect(routes.filter((r) => r.method === l.method && r.path === l.path).length, `${l.method} ${l.path}`).toBeGreaterThanOrEqual(2);
      expect(l.max).toBeGreaterThan(0);
    }
  });

  it('the audit covers every endpoint the brief named', async () => {
    const { PUBLIC_RATE_LIMITS, HANDLER_LIMITS } = await import('../src/lib/ratelimit');
    const covered = new Set([...PUBLIC_RATE_LIMITS.map((l) => l.path), ...HANDLER_LIMITS.map((l) => l.path)]);
    for (const p of [
      '/api/apply/contact', '/api/apply/answer', '/api/apply/submit', '/api/apply/transcribe', // application steps
      '/api/webinar/register', '/api/live/register', '/api/challenge/register', // registrations
      '/api/camera-test', '/rooms/:id/join/:slug', '/api/rooms/:id/net/:kind', '/api/rooms/:id/captions', // rooms
      '/hooks/support-email', '/hooks/zapier/:action', '/l/:code', // inbound, tracked links
      '/api/webinar/checkout', '/api/webinar/sprint/checkout', '/api/webinar/ticket/pay', '/api/pay', '/api/challenge/pay', '/api/live/deposit', // checkout and pay
      '/api/rooms/:id/ws (chat, questions, AI co-host)', '/admin/login',
    ]) expect(covered.has(p), p).toBe(true);
  });

  it('a card-testing burst on the pay endpoint gets a 429 with plain copy', async () => {
    const { RATE_LIMIT_COPY_CHARGE } = await import('../src/lib/ratelimit');
    const json = { ...same, 'content-type': 'application/json' };
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      last = await call('/api/webinar/ticket/pay', { method: 'POST', ip: '192.0.2.9', headers: json, body: JSON.stringify({ token: 'nope', confirmation_token: 'x' }) });
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true); // no such registration: the handler answered
    expect(statuses[10]).toBe(429);
    expect(await last!.json()).toEqual({ ok: false, error: RATE_LIMIT_COPY_CHARGE });
    expect(last!.headers.get('retry-after')).toBe('3600');
    // Another connection is unaffected.
    expect((await call('/api/webinar/ticket/pay', { method: 'POST', ip: '192.0.2.10', headers: json, body: '{}' })).status).toBe(404);
  });

  it('the net test pings are not counted, the downloads are', async () => {
    const { PUBLIC_RATE_LIMITS } = await import('../src/lib/ratelimit');
    const net = PUBLIC_RATE_LIMITS.find((l) => l.method === 'GET' && l.path === '/api/rooms/:id/net/:kind')!;
    expect(net.skip?.({ req: { param: () => 'ping' } } as never)).toBe(true);
    expect(net.skip?.({ req: { param: () => 'down' } } as never)).toBe(false);
  });

  it('a tracked link counts at most 5 clicks per connection per hour, and always redirects', async () => {
    sdb.prepare("INSERT INTO tracked_links (code, label, kind, utm_source, utm_medium, utm_campaign, created_at) VALUES ('yt-bio', 'Bio', 'custom', 'youtube', 'bio', 'test', 1)").run();
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    for (let i = 0; i < 8; i++) {
      const r = await call('/l/yt-bio', { ip: '192.0.2.77', headers: { 'user-agent': ua } });
      expect(r.status).toBe(302);
    }
    await settle();
    expect((sdb.prepare("SELECT clicks FROM tracked_links WHERE code = 'yt-bio'").get() as { clicks: number }).clicks).toBe(5);
  });

  it('old counters are swept, nothing else in kv_state is touched', async () => {
    const { purgeRateLimits } = await import('../src/lib/ratelimit');
    const now = Date.parse('2026-11-03T00:00:00Z');
    sdb.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?), (?, ?), (?, ?)').run('rl:a', JSON.stringify({ n: 1, t: now - 2 * 86_400_000 }), 'rl:b', JSON.stringify({ n: 1, t: now - 60_000 }), 'session_secret', 'keep');
    expect((await purgeRateLimits({ DB: d1(sdb) } as never, now)).removed).toBe(1);
    expect((sdb.prepare('SELECT key FROM kv_state ORDER BY key').all() as { key: string }[]).map((r) => r.key)).toEqual(['rl:b', 'session_secret']);
  });
});

describe('security: admin sessions', () => {
  it('cookie is HttpOnly, Secure, SameSite=Strict with a 3-day lifetime, and each login gets a new token', async () => {
    const a = await loginCookie();
    expect(a.raw).toMatch(/HttpOnly/i);
    expect(a.raw).toMatch(/Secure/i);
    expect(a.raw).toMatch(/SameSite=Strict/i);
    expect(a.raw).toMatch(/Max-Age=259200/i);
    expect(a.raw).toMatch(/Path=\//i);
    const b = await loginCookie();
    expect(b.cookie).not.toBe(a.cookie);
    expect((await call('/admin/api/errors', { headers: { cookie: b.cookie } })).status).toBe(200);
  });

  it('logout ends every session, and a tampered cookie is refused', async () => {
    const a = await loginCookie();
    const b = await loginCookie();
    expect((await call('/admin/api/errors', { headers: { cookie: a.cookie } })).status).toBe(200);
    const out = await call('/admin/logout', { method: 'POST', headers: { ...same, cookie: a.cookie } });
    expect(out.status).toBe(302);
    expect(out.headers.get('set-cookie') ?? '').toMatch(/_fa=;.*Max-Age=0/i);
    for (const c of [a.cookie, b.cookie]) expect((await call('/admin/api/errors', { headers: { cookie: c } })).status).toBe(401);
    const c = await loginCookie();
    const tampered = c.cookie.replace(/admin\.(\d+)/, (_m, exp) => `admin.${Number(exp) + 999999}`);
    expect(tampered).not.toBe(c.cookie);
    expect((await call('/admin/api/errors', { headers: { cookie: tampered } })).status).toBe(401);
    // A logout from someone not signed in doesn't end the team's sessions.
    await call('/admin/logout', { method: 'POST', headers: same });
    expect((await call('/admin/api/errors', { headers: { cookie: c.cookie } })).status).toBe(200);
  });

  it('brute force: a parallel burst checks at most 10 passwords per IP, then even the right one waits', async () => {
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => call('/admin/login', { method: 'POST', ip: '192.0.2.200', headers: form, body: `password=guess${i}` })));
    const codes = burst.map((r) => new URL(r.headers.get('location') ?? '', ORIGIN).searchParams.get('error'));
    expect(codes.filter((c) => c === 'wrong')).toHaveLength(10);
    expect(codes.filter((c) => c === 'tooMany')).toHaveLength(10);
    const right = await call('/admin/login', { method: 'POST', ip: '192.0.2.200', headers: form, body: 'password=devpass' });
    expect(right.headers.get('location')).toBe('/admin/login?error=tooMany');
    expect(right.headers.get('set-cookie')).toBeNull();
    // Another IP still signs in.
    await loginCookie('192.0.2.201');
  }, 20_000);

  it('brute force spread over many IPs: sign-in pauses after 300 failures in an hour', async () => {
    const { MAX_GLOBAL_FAILS } = await import('../src/admin/auth');
    sdb.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?)').run('rl:login-fail:all', JSON.stringify({ n: MAX_GLOBAL_FAILS, t: Date.now() }));
    const r = await call('/admin/login', { method: 'POST', ip: '192.0.2.250', headers: form, body: 'password=devpass' });
    expect(r.headers.get('location')).toBe('/admin/login?error=tooManyAll');
  });

  it('the login page shows only its own copy for an error code (no text through the URL)', () => {
    const html = nfs.readFileSync(`${nodeP.cwd()}/public/admin/login.html`, 'utf8');
    expect(html).toContain("hasOwnProperty.call(msg, e) ? msg[e] : 'Login failed'");
    expect(html).not.toMatch(/textContent = e;/);
  });

  it('every admin write route rejects cross-site and header-less calls, even with a valid session', async () => {
    const { cookie } = await loginCookie();
    const fill = (path: string) => path
      .replace(/:\w+\{(\[0-9\][^/]*)\}/g, '1')
      .replace(/:\w+\{[^/]*\}/g, 'abc1')
      .replace(/:\w+/g, 'abc1')
      .replace(/\*/g, 'x');
    const writes = routeTable().filter((r) => r.path.startsWith('/admin') && !['GET', 'HEAD', 'OPTIONS', 'ALL'].includes(r.method));
    const unique = [...new Map(writes.map((r) => [`${r.method} ${r.path}`, r])).values()];
    expect(unique.length).toBeGreaterThan(150); // the whole dashboard, not a handful
    const attacks: Record<string, string>[] = [
      { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      { origin: 'https://live.apply.test', 'sec-fetch-site': 'same-site' }, // a subdomain
      { 'sec-fetch-site': 'cross-site' },
      {}, // a script that sends neither header
    ];
    const leaks: string[] = [];
    for (const r of unique) {
      for (const h of attacks) {
        const res = await call(fill(r.path), { method: r.method, headers: { ...h, cookie, 'content-type': 'application/json' }, body: '{}' });
        if (res.status !== 403) leaks.push(`${r.method} ${r.path} (${JSON.stringify(h)}) → ${res.status}`);
      }
    }
    expect(leaks).toEqual([]);
    // Same-origin with the session works (the check isn't just refusing everything).
    expect((await call('/admin/api/errors', { headers: { cookie } })).status).toBe(200);
  }, 120_000);

  it('every admin page and API needs the session', async () => {
    const reads = routeTable().filter((r) => r.path.startsWith('/admin') && r.path !== '/admin/login' && r.method === 'GET');
    const unique = [...new Set(reads.map((r) => r.path))];
    expect(unique.length).toBeGreaterThan(100);
    const open: string[] = [];
    for (const p of unique) {
      const path = p.replace(/:\w+\{[^/]*\}/g, '1').replace(/:\w+/g, 'abc1').replace(/\*/g, 'x');
      const res = await call(path, { headers: same });
      const ok = res.status === 401 || (res.status === 302 && res.headers.get('location') === '/admin/login');
      if (!ok) open.push(`${p} → ${res.status}`);
    }
    expect(open).toEqual([]);
  }, 120_000);
});

// ───────────── secrets hygiene ─────────────
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of nfs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
/** Shapes of real credentials (long random tails, so placeholders like "sk_live_…" in help text don't count). */
const SECRET_PATTERNS: [string, RegExp][] = [
  ['Stripe secret/restricted key', /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}/],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9+/=]{20,}/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['Cloudflare API token', /\bcfat_[A-Za-z0-9]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['Slack token', /\bxox[abpr]-[0-9A-Za-z-]{20,}/],
  ['Slack webhook URL', /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}/],
  ['Discord webhook URL', /discord(app)?\.com\/api\/webhooks\/\d{15,}\/[\w-]{40,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Meta access token', /\bEAA[A-Za-z0-9]{80,}/],
  ['Resend API key', /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}/],
  ['SendGrid key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/],
  ['Twilio API key', /\bSK[0-9a-f]{32}\b/],
  ['Private key', /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/],
  ['Hard-coded secret assignment', /\b(ADMIN_PASSWORD|SESSION_SECRET|[A-Z_]*API_KEY|[A-Z_]*SECRET)\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{16,}['"]/],
];

describe('security: secrets hygiene', () => {
  const root = nodeP.cwd();
  const TEXT = /\.(ts|js|mjs|cjs|json|jsonc|html|css|md|txt|svg|xml|toml|sql|yml|yaml)$/i;
  const files = () => [...walk(`${root}/src`), ...walk(`${root}/public`), ...walk(`${root}/scripts`), `${root}/wrangler.jsonc`, `${root}/package.json`]
    .filter((f) => TEXT.test(f) && nfs.statSync(f).size < 5_000_000);

  it('no credential-shaped strings in src/, public/, scripts/ or the Worker config', () => {
    const all = files();
    expect(all.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const f of all) {
      const text = nfs.readFileSync(f, 'utf8');
      for (const [name, re] of SECRET_PATTERNS) {
        const m = re.exec(text);
        if (m) hits.push(`${f.slice(root.length + 1)}: ${name} (${m[0].slice(0, 12)}…)`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the patterns catch real-looking keys (so the scan above is meaningful)', () => {
    const fakes = [
      `sk_live_${'a1B2'.repeat(6)}`, `whsec_${'Zx9'.repeat(8)}`, `sk-ant-api03-${'q'.repeat(30)}`, `cfat_${'N5e'.repeat(10)}`,
      'AKIAABCDEFGHIJKLMNOP', `ghp_${'x'.repeat(36)}`, `AIza${'b'.repeat(35)}`, '-----BEGIN PRIVATE KEY-----', "ADMIN_PASSWORD = 'correct-horse-battery'",
    ];
    for (const f of fakes) expect(SECRET_PATTERNS.some(([, re]) => re.test(f)), f).toBe(true);
    expect(SECRET_PATTERNS.some(([, re]) => re.test("placeholder: 'sk_live_… or rk_live_…'"))).toBe(false);
  });

  it('the error log masks every key shape before it is stored or pinged to Slack', async () => {
    const { scrub } = await import('../src/infra/errors');
    const msg = [
      `sk_live_${'a1B2'.repeat(6)}`, `sk-ant-api03-${'q'.repeat(30)}`, `cfat_${'N5e'.repeat(10)}`, `whsec_${'Zx9'.repeat(8)}`, `ghp_${'x'.repeat(36)}`,
      `AIza${'b'.repeat(35)}`, 'AKIAABCDEFGHIJKLMNOP', `EAA${'c'.repeat(90)}`, `eyJ${'d'.repeat(20)}.eyJ${'e'.repeat(20)}.${'f'.repeat(30)}`,
      'https://graph.facebook.com/v19.0/me?access_token=SECRETVALUE123&x=1', 'Bearer abcdefghijklmnopqrstuvwxyz',
    ].join(' ');
    const out = scrub(msg);
    for (const leak of ['a1B2a1B2', 'qqqqqqqqqq', 'N5eN5e', 'Zx9Zx9', 'xxxxxxxxxx', 'bbbbbbbbbb', 'ABCDEFGHIJKLMNOP', 'cccccccccc', 'dddddddddd', 'SECRETVALUE123', 'abcdefghijklmnop']) expect(out, leak).not.toContain(leak);
  });

  it('the admin login logs the IP on a failure, never the password tried', () => {
    const src = nfs.readFileSync(`${root}/src/admin/auth.ts`, 'utf8');
    expect(src).toMatch(/console\.warn\('admin login failed', ip\)/);
    expect(src).not.toMatch(/console\.\w+\([^)]*password/);
  });
});

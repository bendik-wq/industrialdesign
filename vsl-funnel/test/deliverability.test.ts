import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, Runtime } from '../src/app';
import {
  DOH_URL, type DnsAnswer, type Resolver, checkDomain, defaultExpected, deliveryStats, dnsHealth, dohResolver, domainOf, expectedFromResend, mxValue, orgDomain, parseDmarc, rateLevel, txtValue, worst,
} from '../src/admin/deliverability';
import { GEN_KEY, HQ_CACHE_TTL_MS, bumpGen, cacheKey, hqCache, isCachedPath, memoryClear, memoryGet, memoryPut, readGen } from '../src/lib/hq-cache';
import { SETTINGS } from '../src/settings';
import { posterPreload } from '../src/funnel/pages';
import { VIDEOS } from '../src/config';

// ───────────── A real SQLite database shaped like D1, every migration applied (same shim as dataq.test.ts) ─────────────
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
const BASE = Object.fromEntries(SETTINGS.map((d) => [d.key, ''])) as Record<string, string>;
const makeRt = (db: DatabaseSync | null, settings: Record<string, string> = {}, origin = 'https://apply.example.com') =>
  ({ env: { DB: db ? d1(db) : null }, settings: { ...BASE, ...settings }, reps: [], origin, waitUntil: () => {} }) as unknown as Runtime;

// ───────────── A fake DNS zone answered the way Cloudflare's DoH JSON API answers ─────────────
const T = { A: 1, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 } as const;
type Zone = Record<string, Partial<Record<keyof typeof T, string[]>>>;
const GOOD: Zone = {
  'send.example.com': { TXT: ['"v=spf1 include:amazonses.com ~all"'], MX: ['10 feedback-smtp.us-east-1.amazonses.com.'] },
  'resend._domainkey.example.com': { TXT: ['"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC" "abc123"'] },
  '_dmarc.example.com': { TXT: ['"v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"'] },
  'example.com': { MX: ['1 aspmx.l.google.com.'] },
  'apply.example.com': { A: ['104.21.1.1'] },
};
function dohFetch(zone: Zone, calls: string[] = []) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${u.searchParams.get('name')} ${u.searchParams.get('type')} ${(init?.headers as Record<string, string>)?.accept}`);
    if (u.origin + u.pathname !== DOH_URL) return new Response('nope', { status: 404 });
    const name = u.searchParams.get('name')!, type = u.searchParams.get('type') as keyof typeof T;
    const rec = zone[name];
    if (!rec) return Response.json({ Status: 3, Answer: [] });
    // Real DoH answers include the CNAME chain too; the resolver must keep only the asked-for type.
    const answers: DnsAnswer[] = (rec[type] ?? []).map((data) => ({ name, type: T[type], TTL: 300, data }));
    if (type !== 'CNAME' && rec.CNAME) answers.unshift(...rec.CNAME.map((data) => ({ name, type: T.CNAME, TTL: 300, data })));
    return Response.json({ Status: 0, Answer: answers });
  });
}
const resolverFor = (zone: Zone) => dohResolver(dohFetch(zone) as unknown as typeof fetch);

describe('DNS parsing', () => {
  it('joins split TXT strings, unescapes quotes, and parses MX', () => {
    expect(txtValue('"v=spf1 include:amazonses.com" " ~all"')).toBe('v=spf1 include:amazonses.com ~all');
    expect(txtValue('"a\\"b"')).toBe('a"b');
    expect(txtValue('bare text')).toBe('bare text');
    expect(mxValue('10 feedback-smtp.us-east-1.amazonses.com.')).toEqual({ priority: 10, host: 'feedback-smtp.us-east-1.amazonses.com' });
  });
  it('parses DMARC tags, defaulting pct to 100', () => {
    const d = parseDmarc('v=DMARC1; p=Reject; rua=mailto:a@x.com, mailto:b@y.com; sp=none');
    expect(d).toMatchObject({ v: 'DMARC1', p: 'reject', sp: 'none', rua: ['mailto:a@x.com', 'mailto:b@y.com'], pct: 100 });
    expect(parseDmarc('v=DMARC1; p=none; pct=20').pct).toBe(20);
  });
  it('finds the organisational domain (two-part suffixes too) and the From domain', () => {
    expect(orgDomain('mail.grosfjeld-li.com')).toBe('grosfjeld-li.com');
    expect(orgDomain('send.mail.example.com.au')).toBe('example.com.au');
    expect(orgDomain('Example.CO.UK.')).toBe('example.co.uk');
    expect(domainOf('Josh Li <josh@Mail.Example.com>')).toBe('mail.example.com');
    expect(domainOf('josh@example.com')).toBe('example.com');
    expect(domainOf('not an address')).toBeNull();
    expect(domainOf('')).toBeNull();
  });
  it('maps Resend’s domain records to the expected list (relative names, exact DKIM)', () => {
    const e = expectedFromResend('example.com', [
      { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
      { record: 'SPF', name: 'send.example.com', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' },
      { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=KEY' },
    ]);
    expect(e).toEqual([
      { kind: 'mx', type: 'MX', name: 'send', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
      { kind: 'spf', type: 'TXT', name: 'send', value: 'v=spf1 include:amazonses.com ~all' },
      { kind: 'dkim', type: 'TXT', name: 'resend._domainkey', value: 'p=KEY' },
    ]);
    expect(expectedFromResend('example.com', [])).toEqual(defaultExpected());
    expect(defaultExpected('eu-west-1')[0].value).toBe('feedback-smtp.eu-west-1.amazonses.com');
  });
});

describe('DoH resolver (mocked Cloudflare 1.1.1.1 JSON API)', () => {
  it('asks for application/dns-json, keeps only the asked type, treats NXDOMAIN as empty', async () => {
    const calls: string[] = [];
    const r = dohResolver(dohFetch({ 'x.example.com': { A: ['1.2.3.4'], CNAME: ['edge.example.net.'] } }, calls) as unknown as typeof fetch);
    const a = await r('x.example.com', 'A');
    expect(a.ok).toBe(true);
    expect(a.answers.map((x) => x.data)).toEqual(['1.2.3.4']);
    expect(calls[0]).toBe('x.example.com A application/dns-json');
    expect(await r('missing.example.com', 'TXT')).toEqual({ ok: true, answers: [] });
  });
  it('reports a failed lookup (HTTP error, SERVFAIL, network) instead of “no record”', async () => {
    expect((await dohResolver((async () => new Response('x', { status: 502 })) as unknown as typeof fetch)('a.com', 'TXT')).ok).toBe(false);
    expect((await dohResolver((async () => Response.json({ Status: 2 })) as unknown as typeof fetch)('a.com', 'TXT')).error).toBe('DNS status 2');
    expect((await dohResolver((async () => { throw new Error('down'); }) as unknown as typeof fetch)('a.com', 'TXT')).error).toBe('DNS lookup failed');
  });
});

describe('checkDomain', () => {
  it('passes a fully set-up domain', async () => {
    const checks = await checkDomain('example.com', resolverFor(GOOD), { trackingHost: 'apply.example.com' });
    expect(checks.map((c) => [c.id, c.level])).toEqual([['spf', 'pass'], ['bounce_mx', 'pass'], ['dkim', 'pass'], ['dmarc', 'pass'], ['mx', 'pass'], ['tracking', 'pass']]);
    expect(worst(checks.map((c) => c.level))).toBe('pass');
    expect(checks.find((c) => c.id === 'dkim')!.found[0]).toContain('p=MIGfMA0');
  });
  it('fails a bare domain and gives the exact records to add', async () => {
    const checks = await checkDomain('example.com', resolverFor({ 'apply.other.io': { CNAME: ['x.workers.dev.'] } }), { trackingHost: 'apply.other.io' });
    const by = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(by.spf.level).toBe('fail');
    expect(by.spf.fix).toEqual({ type: 'TXT', name: 'send.example.com', value: 'v=spf1 include:amazonses.com ~all' });
    expect(by.bounce_mx.fix).toEqual({ type: 'MX', name: 'send.example.com', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 });
    expect(by.dkim.level).toBe('fail');
    expect(by.dkim.fix!.name).toBe('resend._domainkey.example.com');
    expect(by.dmarc.level).toBe('fail');
    expect(by.dmarc.fix).toEqual({ type: 'TXT', name: '_dmarc.example.com', value: 'v=DMARC1; p=none; rua=mailto:dmarc@example.com; adkim=r; aspf=r' });
    expect(by.mx.level).toBe('warn');
    expect(by.tracking.level).toBe('warn'); // resolves, but on another domain than the mail
    expect(by.tracking.found).toEqual(['CNAME x.workers.dev']);
  });
  it('warns on DMARC p=none without rua, inherits the org record for a subdomain, flags duplicate SPF and a wrong DKIM key', async () => {
    const zone: Zone = {
      ...GOOD,
      'send.mail.example.com': { TXT: ['"v=spf1 include:amazonses.com ~all"', '"v=spf1 include:_spf.google.com ~all"'], MX: ['10 feedback-smtp.us-east-1.amazonses.com.'] },
      'resend._domainkey.mail.example.com': { TXT: ['"p=OTHERKEY"'] },
      '_dmarc.example.com': { TXT: ['"v=DMARC1; p=none"'] },
      'mail.example.com': { MX: [] },
    };
    const expected = defaultExpected().map((e) => (e.kind === 'dkim' ? { ...e, value: 'p=RESENDKEY' } : e));
    const checks = await checkDomain('mail.example.com', resolverFor(zone), { expected });
    const by = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(by.spf.level).toBe('fail');
    expect(by.spf.detail).toMatch(/More than one SPF/);
    expect(by.dkim.level).toBe('fail');
    expect(by.dkim.fix!.value).toBe('p=RESENDKEY');
    expect(by.dmarc.level).toBe('warn');
    expect(by.dmarc.host).toBe('_dmarc.example.com');
    expect(by.dmarc.detail).toMatch(/from example\.com/);
    expect(by.dmarc.detail).toMatch(/No rua=/);
    expect(by.mx.level).toBe('warn');
    expect(by.tracking).toBeUndefined();
  });
  it('explains a return-path subdomain that is a CNAME to another sending service', async () => {
    const zone: Zone = { 'send.alias.com': { CNAME: ['send.other-esp.net.'], TXT: ['"v=spf1 ip4:1.2.3.4 ~all"'], MX: ['10 feedback.other-esp.net.'] } };
    const checks = await checkDomain('alias.com', resolverFor(zone));
    const by = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(by.spf.level).toBe('fail');
    expect(by.spf.found).toEqual(['v=spf1 ip4:1.2.3.4 ~all']);
    expect(by.spf.detail).toMatch(/send\.alias\.com is a CNAME to send\.other-esp\.net/);
    expect(by.bounce_mx.detail).toMatch(/CNAME to send\.other-esp\.net/);
  });
  it('turns a DNS outage into “check again”, not a false failure', async () => {
    const checks = await checkDomain('example.com', async () => ({ ok: false, answers: [], error: 'DNS lookup timed out' }) as Awaited<ReturnType<Resolver>>);
    expect(checks.every((c) => c.level === 'warn' && c.fix === null)).toBe(true);
    expect(checks[0].detail).toMatch(/timed out/);
  });
});

describe('dnsHealth (Resend + DoH, both mocked)', () => {
  it('uses the From domain with Resend’s defaults when the key is send-only, and memoises for 10 minutes', async () => {
    const doh = dohFetch(GOOD);
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => (String(url).startsWith('https://api.resend.com') ? new Response('{}', { status: 401 }) : doh(url, init)));
    const rt = makeRt(null, { EMAIL_FROM: 'Josh <josh@example.com>', RESEND_API_KEY: 're_x' });
    const a = await dnsHealth(rt, { fetcher: fetcher as unknown as typeof fetch, now: 1_000 });
    expect(a.domains.map((d) => d.domain)).toEqual(['example.com']);
    expect(a.level).toBe('pass');
    expect(a.trackingHost).toBe('apply.example.com');
    expect(a.note).toMatch(/send-only/);
    const n = fetcher.mock.calls.length;
    await dnsHealth(rt, { fetcher: fetcher as unknown as typeof fetch, now: 1_000 + 60_000 });
    expect(fetcher.mock.calls.length).toBe(n);
    await dnsHealth(rt, { fetcher: fetcher as unknown as typeof fetch, now: 1_000 + 60_000, refresh: true });
    expect(fetcher.mock.calls.length).toBeGreaterThan(n);
  });
  it('adds Resend’s domains with their exact records and flags double tracking', async () => {
    const zone: Zone = { ...GOOD, 'send.news.example.com': { TXT: ['"v=spf1 include:amazonses.com ~all"'], MX: ['10 feedback-smtp.eu-west-1.amazonses.com.'] }, 'resend._domainkey.news.example.com': { TXT: ['"p=NEWSKEY"'] }, 'news.example.com': { MX: ['10 mx.example.com.'] } };
    const doh = dohFetch(zone);
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === 'https://api.resend.com/domains') return Response.json({ data: [{ id: 'd1', name: 'news.example.com', status: 'verified', region: 'eu-west-1' }] });
      if (u === 'https://api.resend.com/domains/d1') return Response.json({ id: 'd1', name: 'news.example.com', click_tracking: true, records: [
        { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
        { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' },
        { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=NEWSKEY' },
      ] });
      return doh(url, init);
    });
    const rt = makeRt(null, { EMAIL_FROM: 'josh@example.com', RESEND_API_KEY: 're_full' }, 'https://apply2.example.com');
    const out = await dnsHealth(rt, { fetcher: fetcher as unknown as typeof fetch, refresh: true });
    expect(out.domains.map((d) => d.domain)).toEqual(['example.com', 'news.example.com']);
    const news = out.domains[1];
    expect(news.resendStatus).toBe('verified');
    expect(news.checks.find((c) => c.id === 'dkim')!.level).toBe('pass');
    expect(news.checks.find((c) => c.id === 'bounce_mx')!.level).toBe('pass');
    expect(news.checks.find((c) => c.id === 'resend_tracking')!.level).toBe('warn');
    // Only the From domain carries the tracking-host check.
    expect(news.checks.find((c) => c.id === 'tracking')).toBeUndefined();
    expect(out.domains[0].checks.find((c) => c.id === 'tracking')!.level).toBe('fail'); // apply2 isn't in the zone
  });
  it('says so when there is no From address', async () => {
    const out = await dnsHealth(makeRt(null, {}, 'https://nofrom.example.com'), { fetcher: (async () => Response.json({ Status: 3 })) as unknown as typeof fetch, refresh: true });
    expect(out.domains).toEqual([]);
    expect(out.empty).toMatch(/No From address/);
  });
});

describe('bounce / complaint trend and per-sequence table', () => {
  const DAY = 86_400_000;
  const NOW = Date.parse('2026-11-02T12:00:00Z');
  it('computes rates per day and per sequence with thresholds, ignoring simulated sends', async () => {
    const db = freshDb();
    let i = 0;
    const email = (o: { seq: string; at: number; status?: string; opened?: boolean; clicked?: boolean; error?: string | null }) =>
      db.prepare(`INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, sent_at, opened_at, clicked_at, error, created_at) VALUES (?, 'l1', ?, ?, 't', 'a@x.com', ?, ?, ?, ?, ?, ?, ?)`)
        .run(`m${++i}`, o.seq, i, o.at, o.status ?? 'sent', o.at, o.opened ? o.at + 1 : null, o.clicked ? o.at + 2 : null, o.error ?? null, o.at);
    for (let k = 0; k < 100; k++) email({ seq: 'nurture', at: NOW - 2 * DAY, opened: k < 30, clicked: k < 5, error: k < 5 ? 'bounced' : k === 5 ? 'complained' : null });
    for (let k = 0; k < 60; k++) email({ seq: 'precall', at: NOW - DAY, opened: k < 3 });
    for (let k = 0; k < 40; k++) email({ seq: 'webinar', at: NOW - DAY, status: 'simulated' });
    const sup = (e: string, reason: string, at: number) => db.prepare('INSERT INTO email_suppressions (email, reason, detail, provider_id, created_at) VALUES (?, ?, NULL, NULL, ?)').run(e, reason, at);
    for (let k = 0; k < 5; k++) sup(`b${k}@x.com`, 'bounced', NOW - 2 * DAY);
    sup('c@x.com', 'complained', NOW - 2 * DAY);
    sup('m@x.com', 'manual', NOW - 2 * DAY);
    const s = await deliveryStats(makeRt(db), { from: NOW - 7 * DAY, to: NOW, tzOffsetMin: 0 });
    expect(s.days.length).toBe(8);
    const d2 = s.days.find((d) => d.day === new Date(NOW - 2 * DAY).toISOString().slice(0, 10))!;
    expect(d2).toMatchObject({ sent: 100, bounced: 5, complained: 1 });
    expect(s.range).toMatchObject({ sent: 160, bounced: 5, complained: 1 });
    expect(s.range.bounceRate).toBeCloseTo(5 / 160);
    expect(s.range.bounceLevel).toBe('warn');
    expect(s.range.complaintLevel).toBe('fail'); // 1/160 = 0.6% > 0.3%
    expect(s.real).toBe(160);
    expect(s.simulated).toBe(40);
    const by = Object.fromEntries(s.sequences.map((x) => [x.sequence, x]));
    expect(by.webinar).toBeUndefined();
    expect(by.nurture).toMatchObject({ sent: 100, opened: 30, clicked: 5, bounced: 5, complained: 1, level: 'fail' });
    expect(by.nurture.flags).toEqual(['bounces', 'complaints']);
    expect(by.precall.flags).toEqual(['low opens']);
    expect(by.precall.level).toBe('warn');
  });
  it('only judges rates once enough mail went out', () => {
    expect(rateLevel(0.5, 0.02, 0.04, 5)).toBe('pass');
    expect(rateLevel(0.03, 0.02, 0.04, 100)).toBe('warn');
    expect(rateLevel(0.04, 0.02, 0.04, 100)).toBe('fail');
    expect(rateLevel(null, 0.02, 0.04, 100)).toBe('pass');
  });
});

// ───────────── Funnel HQ cache ─────────────
describe('hq cache keys', () => {
  const NOW = 1_800_000_000_000;
  it('normalises a range ending now to its span, so reloads share a key', () => {
    const a = cacheKey('/overview', { from: String(NOW - 7 * 86_400_000), to: String(NOW), tz: '600' }, '5', NOW);
    const b = cacheKey('/overview', { tz: '600', to: String(NOW + 40_000), from: String(NOW + 40_000 - 7 * 86_400_000) }, '5', NOW + 45_000);
    expect(a).toBe(b);
    expect(a).toBe('g5/overview?from=span10080&to=now&tz=600');
  });
  it('separates endpoints, ranges, filters and generations; drops fresh=1', () => {
    const q = { from: String(NOW - 86_400_000), to: String(NOW) };
    const base = cacheKey('/attribution', q, '1', NOW);
    expect(cacheKey('/attribution', { ...q, dim: 'ad' }, '1', NOW)).not.toBe(base);
    expect(cacheKey('/maps', q, '1', NOW)).not.toBe(base);
    expect(cacheKey('/attribution', q, '2', NOW)).not.toBe(base);
    expect(cacheKey('/attribution', { ...q, from: String(NOW - 2 * 86_400_000) }, '1', NOW)).not.toBe(base);
    expect(cacheKey('/attribution', { ...q, fresh: '1' }, '1', NOW)).toBe(base);
    // A past range keeps its own (minute-rounded) bounds.
    const old = cacheKey('/overview', { from: String(NOW - 30 * 86_400_000), to: String(NOW - 10 * 86_400_000 + 1_234) }, '1', NOW);
    expect(old).toContain(`to=${Math.floor((NOW - 10 * 86_400_000 + 1_234) / 60_000)}`);
  });
  it('caches only the heavy read views (never rooms or layouts)', () => {
    for (const p of ['/overview', '/attribution', '/attribution/stages', '/maps', '/maps/vsl', '/webinar', '/webinar/insights', '/insights', '/emails', '/deliverability']) expect(isCachedPath(p)).toBe(true);
    for (const p of ['/rooms', '/maps/vsl/layout', '/leads', '/live', '/webinar/live/x', '/attribution/journey/l1']) expect(isCachedPath(p)).toBe(false);
  });
  it('memory tier expires after the TTL', () => {
    memoryClear();
    memoryPut('k', '{"a":1}', 0);
    expect(memoryGet('k', HQ_CACHE_TTL_MS - 1)).toBe('{"a":1}');
    expect(memoryGet('k', HQ_CACHE_TTL_MS)).toBeNull();
  });
});

describe('hq cache middleware', () => {
  let db: DatabaseSync;
  let calls = 0;
  let app: Hono<AppEnv>;
  beforeEach(() => {
    memoryClear();
    db = freshDb();
    calls = 0;
    app = new Hono<AppEnv>();
    app.use('/admin/api/*', hqCache);
    app.get('/admin/api/overview', (c) => { calls++; return c.json({ n: calls }); });
    app.get('/admin/api/rooms', (c) => { calls++; return c.json({ n: calls }); });
    app.get('/admin/api/insights', (c) => { calls++; return c.json({ error: 'x' }, 500); });
    app.post('/admin/api/settings', (c) => c.json({ ok: true }));
    app.post('/admin/api/broken', (c) => c.json({ ok: false }, 400));
  });
  afterEach(() => memoryClear());
  const get = (p: string) => app.request(p, {}, { DB: d1(db) });
  const post = (p: string) => app.request(p, { method: 'POST' }, { DB: d1(db) });

  it('serves the second load from cache, and the same range a moment later too', async () => {
    const to = Date.now(), from = to - 7 * 86_400_000;
    const r1 = await get(`/admin/api/overview?from=${from}&to=${to}`);
    expect(r1.headers.get('x-hq-cache')).toBe('miss');
    expect(await r1.json()).toEqual({ n: 1 });
    const r2 = await get(`/admin/api/overview?from=${from + 3000}&to=${to + 3000}`);
    expect(r2.headers.get('x-hq-cache')).toBe('hit');
    expect(await r2.json()).toEqual({ n: 1 });
    expect(calls).toBe(1);
    const r3 = await get(`/admin/api/overview?from=${from - 86_400_000}&to=${to}`);
    expect(r3.headers.get('x-hq-cache')).toBe('miss');
    expect(calls).toBe(2);
  });
  it('a successful Funnel HQ write invalidates everything; a failed one does not', async () => {
    await get('/admin/api/overview?x=1');
    expect(await readGen(d1(db) as never)).toBe('0');
    await post('/admin/api/broken');
    expect((await get('/admin/api/overview?x=1')).headers.get('x-hq-cache')).toBe('hit');
    await post('/admin/api/settings');
    const gen = await readGen(d1(db) as never);
    expect(gen).not.toBe('0');
    expect(db.prepare('SELECT value FROM kv_state WHERE key = ?').get(GEN_KEY)).toBeTruthy();
    const r = await get('/admin/api/overview?x=1');
    expect(r.headers.get('x-hq-cache')).toBe('miss');
    expect(calls).toBe(2);
  });
  it('another isolate’s write (generation bump in D1) also invalidates this isolate’s memory', async () => {
    await get('/admin/api/overview?y=1');
    await bumpGen(d1(db) as never, 123);
    expect((await get('/admin/api/overview?y=1')).headers.get('x-hq-cache')).toBe('miss');
  });
  it('never caches rooms, errors, or fresh=1 loads', async () => {
    await get('/admin/api/rooms'); await get('/admin/api/rooms');
    expect(calls).toBe(2);
    await get('/admin/api/insights'); await get('/admin/api/insights');
    expect(calls).toBe(4);
    await get('/admin/api/overview?z=1');
    const r = await get('/admin/api/overview?z=1&fresh=1');
    expect(r.headers.get('x-hq-cache')).toBe('bypass');
    expect(calls).toBe(6);
  });
});

// ───────────── Public page speed (round 2) ─────────────
describe('public page speed', () => {
  const read = (p: string) => fs.readFileSync(`${node.cwd()}/${p}`, 'utf8');
  it('preloads the VSL poster with high priority, and only a safe URL', () => {
    expect(posterPreload({ video: { poster: '/assets/media/main-poster.webp' } })).toBe('<link rel="preload" as="image" href="/assets/media/main-poster.webp" fetchpriority="high">\n');
    expect(posterPreload({ video: { poster: 'https://cdn.example.com/p.jpg?x=1&y=2' } })).toContain('href="https://cdn.example.com/p.jpg?x=1&amp;y=2"');
    expect(posterPreload({ video: { poster: 'javascript:alert(1)' } })).toBe('');
    expect(posterPreload({ video: { poster: '/x" onload="y' } })).toBe('');
    expect(posterPreload({ video: { poster: '' } })).toBe('');
    expect(posterPreload(undefined)).toBe('');
  });
  it('serves the default posters as WebP files that exist', () => {
    for (const v of [VIDEOS.main, VIDEOS.breakout, VIDEOS.precall]) {
      expect(v.defaultPoster).toMatch(/\.webp$/);
      expect(read(`public${v.defaultPoster}`).length).toBeGreaterThan(1000);
    }
  });
  it('self-hosts Inter and Newsreader: no render-blocking Google Fonts on the four entry pages', () => {
    const css = read('public/assets/site.css');
    for (const f of ['inter-latin', 'inter-latin-ext', 'newsreader-latin', 'newsreader-latin-ext', 'newsreader-italic-latin', 'newsreader-italic-latin-ext']) {
      expect(css).toContain(`url(/assets/fonts/${f}.woff2)`);
      expect(read(`public/assets/fonts/${f}.woff2`).length).toBeGreaterThan(10_000);
    }
    expect(css).toMatch(/--font: "Inter", "Inter Fallback"/);
    for (const page of ['index', 'apply', 'live', 'webinar']) {
      const html = read(`public/${page}.html`);
      expect(html).not.toContain('fonts.googleapis.com');
      expect(html).toContain('/assets/site.css'); // the @font-face rules live there
    }
  });
});

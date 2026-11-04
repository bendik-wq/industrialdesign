import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HIDDEN, PERSONAL_PATHS, maskEmail, maskName, maskPhone, maskPii, maskText } from '../src/admin/pii-mask';

// Guest links for Funnel HQ (src/admin/guest.ts): read-only, secrets never shown, personal details hidden on request,
// revocable at once. The whole worker runs here on an in-memory SQLite D1 with every migration applied.

interface SqlStmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface SqlDb { prepare(sql: string): SqlStmt; exec(sql: string): void }
const nodeP = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = nodeP.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => SqlDb };
const nfs = nodeP.getBuiltinModule('node:fs') as { readdirSync(p: string, o?: { withFileTypes: true }): { name: string }[]; readFileSync(p: string, enc: string): string };
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
const ENV_SECRET = 'env-session-secret-'.padEnd(40, 'z');
const envFor = () => ({
  DB: d1(sdb), SESSION_SECRET: ENV_SECRET, ADMIN_PASSWORD: 'devpass-owner-only',
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
const json = { ...same, 'content-type': 'application/json' };
const form = { ...same, 'content-type': 'application/x-www-form-urlencoded' };
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1) ?? '';

async function ownerCookie(ip = '198.51.100.1') {
  const res = await call('/admin/login', { method: 'POST', ip, headers: form, body: 'password=devpass-owner-only' });
  expect(res.headers.get('location')).toBe('/admin');
  return cookieOf(res, '_fa');
}
async function makeInvite(owner: string, body: Record<string, unknown> = {}) {
  const res = await call('/admin/api/guest-access', { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ label: 'Sam (accountant)', days: 7, ...body }) });
  expect(res.status).toBe(200);
  const d = (await res.json()) as { url: string; invite: { id: string } };
  return { url: d.url, id: d.invite.id, path: new URL(d.url).pathname };
}
async function guestCookie(path: string) {
  const res = await call(path, { headers: { 'sec-fetch-site': 'cross-site' } }); // opened from an email or chat
  expect(res.status).toBe(200);
  const c = cookieOf(res, '_fg');
  expect(c).not.toBe('');
  return c;
}

/** Every admin route pattern with its params filled with the seeded id (L1), so detail views find a row. */
const fill = (path: string) => path
  .replace(/:\w+\{(\[0-9\]|\\d)[^/]*\}/g, '1')
  .replace(/:part\{[^/]*\}/g, 'layout')
  .replace(/:\w+\{[^/]*\}/g, 'L1')
  .replace(/:\w+/g, 'L1')
  .replace(/\*/g, 'x');

// ───────────── seeded personal details ─────────────
const PII = { first: 'Dana', last: 'Quixley', email: 'dana.quixley@example.com', phone: '+61412345678', note: 'ZEBRANOTE private words', ip: '203.0.113.9' };
/** Never anywhere: the last name, the email, the phone, the IP. */
const LEAKS = ['Quixley', 'quixley@', '412345678', '412 345 678', PII.ip];
/** Free text (notes, transcripts, messages, answers): never in the views about people. Elsewhere (ad copy, error
 * messages, internal scripts) the seed's note is just text in a table that holds no personal writing. */
const NOTE = 'ZEBRANOTE';
/** One row in every table, all ids "L1": names, emails, phones, notes and IPs wherever a column can hold them. */
function seedEverything(db: SqlDb) {
  const now = Date.now();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all() as { name: string }[]).map((t) => t.name)
    .filter((t) => !['settings', 'kv_state', 'd1_migrations', 'admin_invites', 'admin_invite_log'].includes(t));
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
    const vals: Record<string, unknown> = {};
    for (const c of cols) {
      const n = c.name.toLowerCase();
      const int = /INT|REAL|NUM/i.test(c.type);
      if (c.pk && int) continue;
      if (n === 'first_name' || n === 'given_name') vals[c.name] = PII.first;
      else if (n === 'last_name' || n === 'surname') vals[c.name] = PII.last;
      else if (/(^|_)email$|^to_addr$|^email/.test(n) && !int) vals[c.name] = PII.email;
      else if (/phone|^wa_id$|whatsapp_wa_id|from_number|to_number/.test(n) && !int) vals[c.name] = PII.phone;
      else if (/^(name|full_name|client_name|signer_name|from_name|who|lead_name|host_name|author)$/.test(n)) vals[c.name] = `${PII.first} ${PII.last}`;
      else if (/^(notes|note|owner_note|transcript|summary|body|text|message|snippet|last_preview|first_message|comment|reply|question|content)$/.test(n)) vals[c.name] = `${PII.note} from ${PII.first} ${PII.last} (${PII.email}, ${PII.phone})`;
      else if (n === 'answers') vals[c.name] = JSON.stringify({ why: PII.note, revenue_band: '3m-10m', email: PII.email });
      else if (/(^|_)ip$/.test(n)) vals[c.name] = PII.ip;
      else if (n === 'id' || n.endsWith('_id') || n === 'ref' || n === 'ref_id') vals[c.name] = int ? 1 : 'L1';
      else if (/(_at|^at|^ts|_ms|^day)$/.test(n) && int) vals[c.name] = now - 3600_000;
      else if (c.notnull && c.dflt_value == null) vals[c.name] = int ? 1 : n === 'status' ? 'applied' : n === 'ref_code' ? 'RQX001' : '{}';
    }
    const keys = Object.keys(vals);
    if (!keys.length) continue;
    try { db.prepare(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => vals[k] as string | number)); } catch { /* a CHECK or a foreign key: that table stays empty */ }
  }
  // The lead itself, filled the way the funnel fills it.
  db.prepare('DELETE FROM leads').run();
  db.prepare(`INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, phone, status, answers, country)
              VALUES ('L1', 'RQX001', ?, ?, ?, ?, ?, ?, 'booked', ?, 'AU')`)
    .run(now - 86_400_000, now - 3600_000, PII.first, PII.last, PII.email, PII.phone, JSON.stringify({ why: PII.note, revenue_band: '3m-10m' }));
  const leadCols = (db.prepare('PRAGMA table_info(leads)').all() as { name: string }[]).map((c) => c.name);
  for (const col of ['notes', 'note', 'owner_note']) if (leadCols.includes(col)) db.prepare(`UPDATE leads SET ${col} = ? WHERE id = 'L1'`).run(PII.note);
}

const SENTINEL = (k: string) => `sentinel-${k.toLowerCase()}-7f3a9c2e1d`;
async function seedSecrets(db: SqlDb) {
  const { SETTINGS } = await import('../src/settings');
  const secret = SETTINGS.filter((d) => 'secret' in d && d.secret);
  for (const d of secret) db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(d.key, SENTINEL(d.key), Date.now());
  return secret.map((d) => SENTINEL(d.key));
}

beforeAll(async () => {
  vi.stubGlobal('HTMLRewriter', class { on() { return this; } transform(r: Response) { return r; } });
  // Nothing leaves the test: any third-party call (with the seeded keys) gets a quiet failure.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"offline"}', { status: 503, headers: { 'content-type': 'application/json' } })));
  const mod = await import('../src/index');
  app = mod.default as unknown as App;
  routeTable = mod.routeTable;
}, 60_000);
beforeEach(async () => {
  sdb = freshDb();
  pend.length = 0;
  (await import('../src/settings')).resetSettingsCache();
  (await import('../src/lib/hq-cache')).memoryClear();
  (await import('../src/admin/guest')).resetGuestCaches();
  (await import('../src/infra/errors')).resetErrorThrottle();
});

describe('guest links: making, opening, revoking', () => {
  it('the owner makes a link; only a hash of its secret is stored; opening it starts a guest session', async () => {
    const owner = await ownerCookie();
    const inv = await makeInvite(owner);
    const token = inv.path.split('/').pop()!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
    const row = sdb.prepare('SELECT * FROM admin_invites WHERE id = ?').get(inv.id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // The list never shows the link again.
    const list = await (await call('/admin/api/guest-access', { headers: { cookie: owner } })).text();
    expect(list).not.toContain(token);
    expect(list).toContain('Sam (accountant)');

    const g = await guestCookie(inv.path);
    const page = await call('/admin', { headers: { cookie: g } });
    expect(page.status).toBe(200);
    const who = await (await call('/admin/api/whoami', { headers: { cookie: g } })).json() as Record<string, unknown>;
    expect(who).toMatchObject({ role: 'viewer', guest: true, label: 'Sam (accountant)', maskPii: true });
    await settle();
    const used = sdb.prepare('SELECT uses, last_used_at FROM admin_invites WHERE id = ?').get(inv.id) as { uses: number; last_used_at: number };
    expect(used.uses).toBe(2); // the link, then one Funnel HQ page load
    expect(used.last_used_at).toBeGreaterThan(0);
    // Every guest request is logged: method and path only.
    const log = sdb.prepare('SELECT method, path, ip_hash FROM admin_invite_log WHERE invite_id = ? ORDER BY id').all(inv.id) as { method: string; path: string; ip_hash: string }[];
    expect(log.map((l) => l.path)).toEqual(['/admin/invite/…', '/admin', '/admin/api/whoami']);
    expect(log.every((l) => l.ip_hash && !l.ip_hash.includes('203.0.113'))).toBe(true);
  });

  it('a bad, expired or revoked link gets a calm 401 page; revoking ends a live guest session on its next request', async () => {
    const owner = await ownerCookie();
    expect((await call('/admin/invite/' + 'A'.repeat(43))).status).toBe(401);
    expect((await call('/admin/invite/short')).status).toBe(401);
    const inv = await makeInvite(owner);
    const g = await guestCookie(inv.path);
    expect((await call('/admin/api/overview', { headers: { cookie: g } })).status).toBe(200);
    const r = await call(`/admin/api/guest-access/${inv.id}/revoke`, { method: 'POST', headers: { ...json, cookie: owner }, body: '{}' });
    expect(await r.json()).toMatchObject({ ok: true, revoked: true });
    expect((await call('/admin/api/overview', { headers: { cookie: g } })).status).toBe(401);
    const page = await call('/admin', { headers: { cookie: g } });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/admin/login');
    const again = await call(inv.path);
    expect(again.status).toBe(401);
    expect(await again.text()).toContain('does not work any more');

    const old = await makeInvite(owner);
    const g2 = await guestCookie(old.path);
    sdb.prepare('UPDATE admin_invites SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, old.id);
    expect((await call('/admin/api/overview', { headers: { cookie: g2 } })).status).toBe(401);
    expect((await call(old.path)).status).toBe(401);
  });

  it('a tampered or forged guest cookie is refused', async () => {
    const owner = await ownerCookie();
    const inv = await makeInvite(owner);
    const g = await guestCookie(inv.path);
    const forged = g.replace(/guest\.[^.]+/, 'guest.inv_other');
    expect((await call('/admin/api/overview', { headers: { cookie: forged } })).status).toBe(401);
    expect((await call('/admin/api/overview', { headers: { cookie: '_fg=guest.x.9999999999999.1.abc' } })).status).toBe(401);
  });

  it('opening links is rate limited per connection', async () => {
    for (let i = 0; i < 20; i++) expect((await call('/admin/invite/' + 'B'.repeat(43), { ip: '192.0.2.77' })).status).toBe(401);
    expect((await call('/admin/invite/' + 'B'.repeat(43), { ip: '192.0.2.77' })).status).toBe(429);
  });

  it('expiry is capped at 90 days and only view-only links can be made', async () => {
    const owner = await ownerCookie();
    const post = (b: Record<string, unknown>) => call('/admin/api/guest-access', { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ label: 'X', ...b }) });
    expect((await post({ days: 91 })).status).toBe(400);
    expect((await post({ days: 0 })).status).toBe(400);
    expect((await post({ days: 7, role: 'editor' })).status).toBe(400);
    expect((await post({ days: 7, label: ' ' })).status).toBe(400);
    const ok = (await (await post({ days: 90 })).json()) as { invite: { expiresAt: number; createdAt: number } };
    expect(ok.invite.expiresAt - ok.invite.createdAt).toBe(90 * 86_400_000);
  });

  it('the guest session lasts 12 hours at most and never past the invite', async () => {
    const owner = await ownerCookie();
    const inv = await makeInvite(owner, { days: 1 / 12 }); // 2 hours
    const res = await call(inv.path);
    const raw = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('_fg=')) ?? '';
    const maxAge = Number(/Max-Age=(\d+)/i.exec(raw)?.[1]);
    expect(maxAge).toBeGreaterThan(7000);
    expect(maxAge).toBeLessThanOrEqual(7200);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    const long = await makeInvite(owner, { days: 30 });
    const raw2 = ((await call(long.path)).headers.getSetCookie?.() ?? []).find((c) => c.startsWith('_fg=')) ?? '';
    expect(Number(/Max-Age=(\d+)/i.exec(raw2)?.[1])).toBe(12 * 3600);
  });

  it('"Leave" ends just the guest session; the owner logging out (which ends every admin session) leaves guests alone', async () => {
    const owner = await ownerCookie();
    const inv = await makeInvite(owner);
    const g = await guestCookie(inv.path);
    await call('/admin/logout', { method: 'POST', headers: { ...form, cookie: owner } });
    expect((await call('/admin/api/overview', { headers: { cookie: owner } })).status).toBe(401);
    expect((await call('/admin/api/overview', { headers: { cookie: g } })).status).toBe(200);
    const leave = await call('/admin/guest/leave', { method: 'POST', headers: { ...form, cookie: g } });
    expect(leave.status).toBe(200);
    expect((leave.headers.getSetCookie?.() ?? []).some((c) => /^_fg=;|^_fg=$|_fg=.*Max-Age=0/i.test(c))).toBe(true);
    // Cross-site "leave" is refused like every other write.
    expect((await call('/admin/guest/leave', { method: 'POST', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', cookie: g } })).status).toBe(403);
  });
});

describe('guest links: read-only', () => {
  it('a guest can never reach Guest access (list, make or revoke links)', async () => {
    const owner = await ownerCookie();
    const inv = await makeInvite(owner);
    const g = await guestCookie(inv.path);
    expect((await call('/admin/api/guest-access', { headers: { cookie: g } })).status).toBe(403);
    expect((await call(`/admin/api/guest-access/${inv.id}/log`, { headers: { cookie: g } })).status).toBe(403);
    expect((await call('/admin/api/guest-access', { method: 'POST', headers: { ...json, cookie: g }, body: JSON.stringify({ label: 'me too', days: 90 }) })).status).toBe(403);
    expect((await call(`/admin/api/guest-access/${inv.id}/revoke`, { method: 'POST', headers: { ...json, cookie: g }, body: '{}' })).status).toBe(403);
    expect((sdb.prepare('SELECT COUNT(*) AS n FROM admin_invites').get() as { n: number }).n).toBe(1);
    expect((sdb.prepare('SELECT revoked_at FROM admin_invites').get() as { revoked_at: number | null }).revoked_at).toBeNull();
  });

  it('every admin write route (all of them, read from the router) is refused for a guest, same-origin or not', async () => {
    const owner = await ownerCookie();
    const g = await guestCookie((await makeInvite(owner)).path);
    const exempt = new Set(['/admin/login', '/admin/logout', '/admin/guest/leave']);
    const writes = routeTable().filter((r) => r.path.startsWith('/admin') && !['GET', 'HEAD', 'OPTIONS', 'ALL'].includes(r.method) && !exempt.has(r.path));
    const unique = [...new Map(writes.map((r) => [`${r.method} ${r.path}`, r])).values()];
    expect(unique.length).toBeGreaterThan(200);
    const before = sdb.prepare("SELECT COUNT(*) AS n FROM kv_state WHERE key = 'hq:cache:gen'").get();
    const open: string[] = [];
    for (const r of unique) {
      const res = await call(fill(r.path), { method: r.method, headers: { ...json, cookie: g }, body: '{}' });
      const body = await res.text();
      if (res.status !== 403 || !body.includes('guest')) open.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(open).toEqual([]);
    // A real one, end to end: saving a setting changes nothing.
    const put = await call('/admin/api/integrations', { method: 'PUT', headers: { ...json, cookie: g }, body: JSON.stringify({ SITE_NAME: 'Hijacked' }) });
    expect(put.status).toBe(403);
    expect(((await put.json()) as { error: string }).error).toMatch(/guest view/);
    expect(sdb.prepare("SELECT value FROM settings WHERE key = 'SITE_NAME'").get()).toBeUndefined();
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM kv_state WHERE key = 'hq:cache:gen'").get()).toEqual(before); // no write reached the cache
    await settle();
    expect((sdb.prepare("SELECT COUNT(*) AS n FROM admin_invite_log WHERE status = 403").get() as { n: number }).n).toBeGreaterThan(200);
  }, 120_000);

  it('GETs that act, cost money or export personal data are refused; everything else opens as it does for the owner', async () => {
    const { GUEST_DENY_GET } = await import('../src/admin/guest');
    const owner = await ownerCookie();
    const g = await guestCookie((await makeInvite(owner, { maskPii: false })).path);
    const reads = [...new Set(routeTable().filter((r) => r.path.startsWith('/admin') && r.method === 'GET' && !r.path.startsWith('/admin/invite') && r.path !== '/admin/login').map((r) => r.path))];
    expect(reads.length).toBeGreaterThan(150);
    const diff: string[] = [];
    let denied = 0;
    for (const p of reads) {
      const path = fill(p);
      const shouldDeny = GUEST_DENY_GET.some((d) => d.path.test(path));
      const gs = (await call(path, { headers: { cookie: g } })).status;
      if (shouldDeny) { denied++; if (gs !== 403) diff.push(`${p} guest ${gs} (want 403)`); continue; }
      const os = (await call(path, { headers: { cookie: owner } })).status;
      if (os !== gs) diff.push(`${p} owner ${os} guest ${gs}`);
    }
    expect(diff).toEqual([]);
    expect(denied).toBeGreaterThanOrEqual(8);
    // The host room is a page, refused with a calm message (not a login loop).
    const room = await call('/admin/rooms/L1', { headers: { cookie: g } });
    expect(room.status).toBe(403);
    expect(await room.text()).toContain('only the owner can join a room as the host');
    // The pages around Funnel HQ open.
    for (const p of ['/admin', '/admin/sandbox', '/admin/voice-demo', '/admin/present']) expect((await call(p, { headers: { cookie: g } })).status, p).toBe(200);
  }, 120_000);
});

describe('guest links: secrets and personal details', () => {
  it('no secret value reaches a guest from any admin GET; Integrations shows only set / not set', async () => {
    const secrets = await seedSecrets(sdb);
    seedEverything(sdb);
    const owner = await ownerCookie();
    const g = await guestCookie((await makeInvite(owner, { maskPii: false })).path);
    const reads = [...new Set(routeTable().filter((r) => r.path.startsWith('/admin') && r.method === 'GET' && !r.path.startsWith('/admin/invite') && r.path !== '/admin/login').map((r) => r.path))];
    const leaks: string[] = [];
    let ownerSaw = 0;
    for (const p of reads) {
      const path = fill(p);
      const body = await (await call(path, { headers: { cookie: g } })).text();
      for (const s of [...secrets, ENV_SECRET, 'devpass-owner-only']) if (body.includes(s)) leaks.push(`${p}: ${s}`);
      if (body.includes('sentinel-') && /sentinel-[a-z_]+-7f3a9c2e1d/.test(body)) leaks.push(`${p}: a sentinel`);
      if (/sentinel-[a-z_]+-7f3a9c2e1d/.test(await (await call(path, { headers: { cookie: owner } })).text())) ownerSaw++;
    }
    expect(leaks).toEqual([]);
    expect(ownerSaw).toBeGreaterThan(0); // the probe works: some owner views do carry a secret (e.g. the Vapi assistant JSON)
    const integ = (await (await call('/admin/api/integrations', { headers: { cookie: g } })).json()) as { settings: { key: string; secret?: boolean; value: string }[] };
    const sec = integ.settings.filter((s) => s.secret);
    expect(sec.length).toBeGreaterThan(30);
    expect(sec.every((s) => s.value === 'set')).toBe(true);
    // The owner's view is unchanged (last four characters).
    const own = (await (await call('/admin/api/integrations', { headers: { cookie: owner } })).json()) as { settings: { key: string; secret?: boolean; value: string }[] };
    expect(own.settings.find((s) => s.key === 'RESEND_API_KEY')?.value).toBe('••••9c2e1d'.replace('9c2e1d', '2e1d'));
  }, 180_000);

  it('with "Hide personal details", no seeded name, email, phone, note or IP reaches the guest from any admin GET', async () => {
    seedEverything(sdb);
    const owner = await ownerCookie();
    const g = await guestCookie((await makeInvite(owner, { maskPii: true })).path);
    const reads = [...new Set(routeTable().filter((r) => r.path.startsWith('/admin') && r.method === 'GET' && !r.path.startsWith('/admin/invite') && r.path !== '/admin/login').map((r) => r.path))];
    const leaks: string[] = [];
    const ownerViews: string[] = [];
    for (const p of reads) {
      const path = fill(p);
      const ob = await (await call(path, { headers: { cookie: owner } })).text();
      if (ob.includes('Quixley') || ob.includes('ZEBRANOTE')) ownerViews.push(p);
      const gb = await (await call(path, { headers: { cookie: g } })).text();
      const personal = PERSONAL_PATHS.test(p.replace(/^\/admin\/api/, ''));
      for (const l of personal ? [...LEAKS, NOTE] : LEAKS) if (gb.includes(l)) leaks.push(`${p}: ${l}` + (process.env.GUEST_DEBUG ? ` ${gb.slice(Math.max(0, gb.indexOf(l) - 300), gb.indexOf(l) + 40)}` : ''));
    }
    expect(leaks).toEqual([]);
    // Coverage: these views really do carry the seeded person for the owner (the leads list, the drawer, calls, DMs…).
    expect(ownerViews.length).toBeGreaterThan(15);
    for (const p of ['/admin/api/leads', '/admin/api/leads/:id']) expect(ownerViews, p).toContain(p);
    // What the guest sees instead.
    const list = (await (await call('/admin/api/leads', { headers: { cookie: g } })).json()) as { rows: Record<string, string>[] };
    const row = list.rows.find((r) => r.id === 'L1')!;
    expect(row.first_name).toBe('Dana');
    expect(row.last_name).toBe('Q.');
    expect(row.email).toBe('d***@example.com');
    if (row.phone) expect(row.phone).toBe('+61 4•• ••• 678');
    const drawer = await (await call('/admin/api/leads/L1', { headers: { cookie: g } })).text();
    expect(drawer).toContain(HIDDEN);
    expect(drawer).toContain('d***@example.com');
  }, 180_000);

  it('without "Hide personal details" the guest sees the same people the owner does', async () => {
    seedEverything(sdb);
    const owner = await ownerCookie();
    const g = await guestCookie((await makeInvite(owner, { maskPii: false })).path);
    const drawer = await (await call('/admin/api/leads/L1', { headers: { cookie: g } })).text();
    expect(drawer).toContain('Quixley');
    expect(drawer).toContain(PII.email);
  });
});

describe('guest links: copy', () => {
  it('every message a guest or the owner reads passes the copy rules', async () => {
    const { auditCopy } = await import('../src/content/copy-rules');
    const { GUEST_COPY } = await import('../src/admin/guest');
    for (const [k, v] of Object.entries(GUEST_COPY)) expect(auditCopy(v), k).toEqual([]);
    const js = nfs.readFileSync(`${nodeP.cwd()}/public/assets/admin-guests.js`, 'utf8');
    for (const s of ['Guest view: changes are switched off.', 'This is the only time the link is shown.', 'Revoking takes effect on the person’s next click.']) {
      expect(js).toContain(s);
      expect(auditCopy(s), s).toEqual([]);
    }
  });
});

describe('masking helpers', () => {
  it('names, emails and phones', () => {
    expect(maskName('Dana Quixley')).toBe('Dana Q.');
    expect(maskName('Mary Ann van dyke')).toBe('Mary D.');
    expect(maskName('Dana')).toBe('Dana');
    expect(maskEmail('dana.quixley@example.com')).toBe('d***@example.com');
    expect(maskPhone('+61412345678')).toBe('+61 4•• ••• 678');
    expect(maskPhone('0412 345 678')).toBe('0••• ••• 678');
  });
  it('free text keeps its words but loses emails, phones, IPs and known full names', () => {
    const known = { last: new Set(['quixley']), full: new Map([['dana quixley', 'Dana Q.']]) };
    expect(maskText('Call Dana Quixley on +61 412 345 678 or dana@x.com from 10.1.2.3', known)).toBe(`Call Dana Q. on +61 4•• ••• 678 or d***@x.com from ${HIDDEN}`);
    expect(maskText('Booked: Sam Quixley', known)).toBe('Booked: Sam Q.');
    expect(maskText('A long-term plan')).toBe('A long-term plan');
  });
  it('records: notes, transcripts and answers are hidden; shape and short codes stay', () => {
    const out = maskPii({ rows: [{ lead_id: 'L1', name: 'Dana Quixley', notes: 'private', answers: '{"why":"because I want out","revenue_band":"3m-10m"}', ip: '1.2.3.4', score: 80 }], title: 'Leads for Dana Quixley' }) as any;
    expect(out.rows[0]).toEqual({ lead_id: 'L1', name: 'Dana Q.', notes: HIDDEN, answers: JSON.stringify({ why: HIDDEN, revenue_band: '3m-10m' }), ip: HIDDEN, score: 80 });
    expect(out.title).toBe('Leads for Dana Q.');
    // Template text outside a personal record is left alone.
    expect(maskPii({ template: 'welcome', html: '<p>Hello {first_name}</p>' })).toEqual({ template: 'welcome', html: '<p>Hello {first_name}</p>' });
  });
});

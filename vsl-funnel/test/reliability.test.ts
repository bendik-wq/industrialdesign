import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, Runtime } from '../src/app';
import { hooks } from '../src/routes/hooks';
import { opsHooks, ZAPIER_DEDUPE_MS } from '../src/integrations/hooks-in';
import { claimEvent, enqueueEvent, finishEvent, KEEP_MS, MAX_ATTEMPTS, onceOnly, retryQueued, STALE_MS } from '../src/lib/webhook-events';
import { retryInboundWebhooks } from '../src/ops/e-cron';
import { hmacHex } from '../src/lib/crypto';
import { verifyCalendly } from '../src/integrations/booking';
import { verifyElevenSignature } from '../src/integrations/elevenlabs';
import { type RoomState, join, newRoomState } from '../src/rooms/state';
import { ENG_CAP, MEMBER_CAP, boundRoomState, cleanupAt, keepDays, sweepRoomStorage } from '../src/rooms/hygiene';
import { RoomDO } from '../src/rooms/do';
import { INTEL_EVENT_CAP, logEvents, resetIntelCounts } from '../src/rooms/intel-db';
import { SETTINGS as SETTING_DEFS } from '../src/settings';
const BLANK = Object.fromEntries(SETTING_DEFS.map((s) => [s.key, ''])) as Record<string, string>;
import { auditCopy } from '../src/content/copy-rules';

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
const MIGRATIONS = `${node.cwd()}/migrations`;
function freshDb(o: { before?: string } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    if (o.before && f.slice(0, 4) >= o.before) continue;
    db.exec(fs.readFileSync(`${MIGRATIONS}/${f}`, 'utf8'));
  }
  return db;
}

const MIN = 60_000, DAY = 86_400_000;
const T0 = Date.parse('2026-11-03T02:00:00Z');
const SECRETS = {
  RESEND_WEBHOOK_SECRET: 'whsec_' + btoa('resend-signing-key-0123456789'),
  CALENDLY_SIGNING_KEY: 'calendly-signing-key',
  ELEVENLABS_WEBHOOK_SECRET: 'eleven-secret',
  IG_APP_SECRET: 'ig-app-secret',
  WHATSAPP_APP_SECRET: 'wa-app-secret',
  ZAPIER_INBOUND_SECRET: 'zap-secret-0123',
};
let db: DatabaseSync;
let env: Record<string, unknown>;
const pending: Promise<unknown>[] = [];
const exec = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); }, passThroughOnException: () => {} } as unknown as ExecutionContext;
const settle = async () => { while (pending.length) await pending.shift(); };
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as (string | number | null)[]));
const makeRt = (settings: Record<string, string> = {}) => ({ env, settings: { ...BLANK, ...SECRETS, ...settings }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;

function app(settings: Record<string, string> = {}) {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => { c.set('settings', { ...BLANK, ...SECRETS, ...settings } as never); c.set('reps', []); await next(); });
  a.route('/hooks', opsHooks);
  a.route('/hooks', hooks);
  a.onError((e, c) => c.text(`error: ${String(e).slice(0, 200)}`, 500));
  return a;
}
const post = (path: string, body: string, headers: Record<string, string>) => app().request(path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }, env, exec);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  env = { DB: d1(db), SESSION_SECRET: 'test-session-secret' };
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  resetIntelCounts();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); pending.length = 0; });

// ───────────── signing helpers (each provider's real scheme) ─────────────

async function svix(id: string, ts: number, body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('resend-signing-key-0123456789'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': 'v1,' + btoa(String.fromCharCode(...new Uint8Array(mac))) };
}
const nowSec = () => Math.floor(Date.now() / 1000);
const calendlySig = async (body: string, t = nowSec()) => ({ 'calendly-webhook-signature': `t=${t},v1=${await hmacHex(SECRETS.CALENDLY_SIGNING_KEY, `${t}.${body}`)}` });
const elevenSig = async (body: string, t = nowSec()) => ({ 'elevenlabs-signature': `t=${t},v0=${await hmacHex(SECRETS.ELEVENLABS_WEBHOOK_SECRET, `${t}.${body}`)}` });
const metaSig = async (secret: string, body: string) => ({ 'x-hub-signature-256': `sha256=${await hmacHex(secret, body)}` });
const events = (provider: string) => q<{ id: string; status: string; attempts: number; error: string | null; payload: string | null }>('SELECT id, status, attempts, error, payload FROM webhook_events WHERE provider = ? ORDER BY received_at', provider);
function lead(id: string, email: string, extra: Record<string, unknown> = {}) {
  const cols = { id, ref_code: `R${id.toUpperCase()}`, created_at: T0 - DAY, updated_at: T0 - DAY, email, first_name: 'Dana', status: 'qualified', ...extra };
  x(`INSERT INTO leads (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`, ...Object.values(cols));
}

// ───────────── the dedupe ledger ─────────────

describe('webhook_events: run once, rerun after a failure, never twice at once', () => {
  it('claims, dedupes, retries failed and stale runs, and honours the window for body-hash ids', async () => {
    const e = env as never;
    const a = await claimEvent(e, 'resend', 'msg_1');
    expect(a).toMatchObject({ run: true, attempt: 1 });
    expect(await claimEvent(e, 'resend', 'msg_1')).toMatchObject({ run: false, reason: 'in_progress' });
    // The run died (no finish): after STALE_MS a retry may take it over.
    vi.setSystemTime(T0 + STALE_MS + 1000);
    expect(await claimEvent(e, 'resend', 'msg_1')).toMatchObject({ run: true, attempt: 2 });
    await finishEvent(e, a.key, new Error('D1 overloaded'));
    expect(events('resend')[0]).toMatchObject({ status: 'failed', error: 'D1 overloaded' });
    expect(await claimEvent(e, 'resend', 'msg_1')).toMatchObject({ run: true, attempt: 3 });
    await finishEvent(e, a.key);
    expect(await claimEvent(e, 'resend', 'msg_1')).toMatchObject({ run: false, reason: 'duplicate' });
    // Same id, other provider: independent.
    expect(await claimEvent(e, 'calendly', 'msg_1')).toMatchObject({ run: true });
    // A window: the same body much later is a new action.
    const w = await claimEvent(e, 'zapier', 'sha256:abc', { windowMs: 15 * MIN });
    await finishEvent(e, w.key);
    expect(await claimEvent(e, 'zapier', 'sha256:abc', { windowMs: 15 * MIN })).toMatchObject({ run: false, reason: 'duplicate' });
    vi.setSystemTime(Date.now() + 16 * MIN);
    expect(await claimEvent(e, 'zapier', 'sha256:abc', { windowMs: 15 * MIN })).toMatchObject({ run: true });
  });

  it('onceOnly records a throw as failed (so the provider retry runs it) and a success as done', async () => {
    const e = env as never;
    let calls = 0;
    await expect(onceOnly(e, 'elevenlabs', 'c1', async () => { calls++; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(events('elevenlabs')[0].status).toBe('failed');
    expect(await onceOnly(e, 'elevenlabs', 'c1', async () => { calls++; return 7; })).toEqual({ ran: true, result: 7 });
    expect(await onceOnly(e, 'elevenlabs', 'c1', async () => { calls++; return 8; })).toMatchObject({ ran: false, duplicate: true });
    expect(calls).toBe(2);
  });

  it('queued events: stored before the ack, retried by the cron up to MAX_ATTEMPTS, old finished rows pruned', async () => {
    const e = env as never;
    const first = await enqueueEvent(e, 'instagram', 'sha256:1', '{"n":1}');
    expect(first.fresh).toBe(true);
    expect((await enqueueEvent(e, 'instagram', 'sha256:1', '{"n":1}')).fresh).toBe(false);
    let ok = false;
    const handler = vi.fn(async () => { if (!ok) throw new Error('down'); });
    // Not stale yet: left for the request's own background run.
    expect((await retryQueued(e, { instagram: handler })).retried).toBe(0);
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      vi.setSystemTime(Date.now() + STALE_MS + 1000);
      await retryQueued(e, { instagram: handler });
    }
    expect(handler).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(events('instagram')[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, error: 'down' });
    // A fresh one that recovers: done, payload cleared, then pruned after KEEP_MS.
    await enqueueEvent(e, 'instagram', 'sha256:2', '{"n":2}');
    ok = true;
    vi.setSystemTime(Date.now() + STALE_MS + 1000);
    expect(await retryQueued(e, { instagram: handler })).toMatchObject({ retried: 1, ok: 1 });
    expect(events('instagram')[1]).toMatchObject({ status: 'done', payload: null });
    vi.setSystemTime(Date.now() + KEEP_MS + 1000);
    expect((await retryQueued(e, { instagram: handler })).pruned).toBe(1);
  });
});

// ───────────── each webhook ─────────────

describe('Resend webhook (bounces)', () => {
  it('blocks once, answers a retry as a duplicate, rejects stale or unsigned deliveries', async () => {
    lead('l1', 'giovanni@sourci.com.au');
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'e1', to: ['Giovanni@Sourci.com.au'], bounce: { type: 'Permanent' } } });
    const h = await svix('msg_b1', nowSec(), body);
    const r1 = await post('/hooks/resend', body, h);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ blocked: [{ email: 'giovanni@sourci.com.au' }] });
    const r2 = await post('/hooks/resend', body, h);
    expect(await r2.json()).toEqual({ ok: true, duplicate: true });
    expect(q('SELECT * FROM email_suppressions')).toHaveLength(1);
    // Replay protection: a captured delivery replayed later than 5 minutes fails the signature check.
    vi.setSystemTime(T0 + 6 * MIN);
    expect((await post('/hooks/resend', body, h)).status).toBe(401);
    expect((await post('/hooks/resend', body, { 'svix-timestamp': String(nowSec()) })).status).toBe(401);
  });

  it('a delivery that fails half-way answers 5xx, and the retry runs it', async () => {
    lead('l1', 'a@b.co');
    const body = JSON.stringify({ type: 'email.complained', data: { to: ['a@b.co'] } });
    const h = await svix('msg_c1', nowSec(), body);
    x('ALTER TABLE email_suppressions RENAME TO email_suppressions_off');
    expect((await post('/hooks/resend', body, h)).status).toBe(500);
    expect(events('resend')[0].status).toBe('failed');
    x('ALTER TABLE email_suppressions_off RENAME TO email_suppressions');
    expect((await post('/hooks/resend', body, h)).status).toBe(200);
    expect(q('SELECT reason FROM email_suppressions')).toEqual([{ reason: 'complained' }]);
    expect(events('resend')[0]).toMatchObject({ status: 'done', attempts: 2 });
  });
});

describe('Calendly webhook', () => {
  const booking = (uri = 'https://api.calendly.com/scheduled_events/E1/invitees/I1') => JSON.stringify({
    event: 'invitee.created', payload: { email: 'dana@x.co', uri, scheduled_event: { start_time: new Date(T0 + 2 * DAY).toISOString(), uri: 'https://api.calendly.com/scheduled_events/E1' }, tracking: { salesforce_uuid: 'l1' } },
  });
  it('books once; a retry is a duplicate; stale, non-numeric or forged timestamps are refused', async () => {
    lead('l1', 'dana@x.co');
    const body = booking();
    const r1 = await post('/hooks/calendly', body, await calendlySig(body));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ matched: true, leadId: 'l1' });
    const bookedAt = q<{ booked_at: number }>('SELECT booked_at FROM leads WHERE id = ?', 'l1')[0].booked_at;
    expect(bookedAt).toBe(T0);
    vi.setSystemTime(T0 + MIN);
    expect(await (await post('/hooks/calendly', body, await calendlySig(body))).json()).toEqual({ ok: true, duplicate: true });
    expect(events('calendly')).toHaveLength(1);
    // Replay protection.
    expect((await post('/hooks/calendly', body, await calendlySig(body, nowSec() - 6 * 60))).status).toBe(401);
    const bad = `t=abc,v1=${await hmacHex(SECRETS.CALENDLY_SIGNING_KEY, `abc.${body}`)}`;
    expect(await verifyCalendly(SECRETS.CALENDLY_SIGNING_KEY, body, bad)).toBe(false);
    expect((await post('/hooks/calendly', 'not json', await calendlySig('not json'))).status).toBe(400);
  });
});

describe('ElevenLabs post-call webhook', () => {
  it('handles each conversation event once, reruns a failed one, refuses stale signatures', async () => {
    lead('l1', 'dana@x.co', { phone: '+61412345678' });
    x("INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, attempts, conversation_id, created_at, updated_at) VALUES ('oc1', 'l1', 'confirm', 'dialing', ?, 1, 'conv_1', ?, ?)", T0, T0, T0);
    const body = JSON.stringify({ type: 'call_initiation_failure', data: { conversation_id: 'conv_1', failure_reason: 'busy' } });
    x('ALTER TABLE voice_calls RENAME TO voice_calls_off');
    expect((await post('/hooks/elevenlabs', body, await elevenSig(body))).status).toBe(500);
    x('ALTER TABLE voice_calls_off RENAME TO voice_calls');
    const ok = await post('/hooks/elevenlabs', body, await elevenSig(body));
    expect(ok.status).toBe(200);
    expect(q('SELECT id FROM voice_calls')).toEqual([{ id: 'conv_1' }]);
    const status = q<{ status: string }>('SELECT status FROM outbound_calls WHERE id = ?', 'oc1')[0].status;
    expect(await (await post('/hooks/elevenlabs', body, await elevenSig(body))).json()).toEqual({ ok: true, duplicate: true });
    expect(q<{ status: string }>('SELECT status FROM outbound_calls WHERE id = ?', 'oc1')[0].status).toBe(status);
    expect(events('elevenlabs')[0]).toMatchObject({ id: 'elevenlabs:call_initiation_failure:conv_1', status: 'done', attempts: 2 });
    expect((await post('/hooks/elevenlabs', body, await elevenSig(body, nowSec() - 31 * 60))).status).toBe(401);
    expect(await verifyElevenSignature(SECRETS.ELEVENLABS_WEBHOOK_SECRET, body, `t=x,v0=${await hmacHex(SECRETS.ELEVENLABS_WEBHOOK_SECRET, `x.${body}`)}`)).toBe(false);
  });
});

describe('Instagram (Meta) webhook', () => {
  const dm = (mid: string, text = 'How does seller finance work?') => JSON.stringify({ object: 'instagram', entry: [{ id: 'acct1', time: T0, messaging: [{ sender: { id: 'igu1' }, recipient: { id: 'acct1' }, timestamp: T0, message: { mid, text } }] }] });
  it('stores the delivery before acknowledging it, processes it in the background, drops a retry of the same bytes', async () => {
    const body = dm('m1');
    const r = await post('/hooks/instagram', body, await metaSig(SECRETS.IG_APP_SECRET, body));
    expect(r.status).toBe(200);
    expect(events('instagram')[0].payload).toBe(body); // durable before the 200
    await settle();
    expect(events('instagram')[0]).toMatchObject({ status: 'done', payload: null });
    expect(q('SELECT * FROM dm_messages')).toHaveLength(1);
    expect((await post('/hooks/instagram', body, await metaSig(SECRETS.IG_APP_SECRET, body))).status).toBe(200);
    await settle();
    expect(events('instagram')).toHaveLength(1);
    expect((await post('/hooks/instagram', body, await metaSig('wrong', body))).status).toBe(401);
  });

  it('a background run that fails is picked up by the cron', async () => {
    const body = dm('m2');
    x('ALTER TABLE dm_messages RENAME TO dm_messages_off');
    expect((await post('/hooks/instagram', body, await metaSig(SECRETS.IG_APP_SECRET, body))).status).toBe(200);
    await settle();
    expect(events('instagram')[0].status).toBe('failed');
    x('ALTER TABLE dm_messages_off RENAME TO dm_messages');
    vi.setSystemTime(T0 + STALE_MS + 1000);
    expect(await retryInboundWebhooks(makeRt())).toMatchObject({ retried: 1, ok: 1 });
    await settle();
    expect(q('SELECT mid FROM dm_messages')).toEqual([{ mid: 'm2' }]);
  });
});

describe('WhatsApp (Meta) webhook', () => {
  const wa = (ids: string[]) => JSON.stringify({ entry: [{ changes: [{ value: { messages: ids.map((id) => ({ from: '61412345678', id, timestamp: String(T0 / 1000), type: 'text', text: { body: 'hi' } })) } }] }] });
  it('dedupes a retried delivery and a message repeated in another batch', async () => {
    const one = wa(['wamid.1']);
    expect((await post('/hooks/whatsapp', one, await metaSig(SECRETS.WHATSAPP_APP_SECRET, one))).status).toBe(200);
    expect(await (await post('/hooks/whatsapp', one, await metaSig(SECRETS.WHATSAPP_APP_SECRET, one))).json()).toEqual({ ok: true, duplicate: true });
    const batch = wa(['wamid.1', 'wamid.2']);
    expect((await post('/hooks/whatsapp', batch, await metaSig(SECRETS.WHATSAPP_APP_SECRET, batch))).status).toBe(200);
    expect(q('SELECT provider_id FROM whatsapp_messages ORDER BY provider_id')).toEqual([{ provider_id: 'wamid.1' }, { provider_id: 'wamid.2' }]);
    expect((await post('/hooks/whatsapp', 'x', await metaSig(SECRETS.WHATSAPP_APP_SECRET, 'x'))).status).toBe(400);
  });
});

describe('Zapier inbound', () => {
  const zap = (action: string, b: Record<string, unknown>, h: Record<string, string> = {}) => post(`/hooks/zapier/${action}`, JSON.stringify(b), { 'x-zapier-secret': SECRETS.ZAPIER_INBOUND_SECRET, ...h });
  const notes = () => q<{ notes: string | null }>("SELECT notes FROM leads WHERE id = 'l1'")[0].notes?.split('\n').length ?? 0;
  it('a retried note is added once; an idempotency key dedupes for good; rejected requests are not recorded', async () => {
    lead('l1', 'dana@x.co');
    expect((await zap('add-note', { lead_id: 'l1', note: 'Called back' })).status).toBe(200);
    expect(await (await zap('add-note', { lead_id: 'l1', note: 'Called back' })).json()).toEqual({ ok: true, duplicate: true });
    expect(notes()).toBe(1);
    // The same note next week is a new note.
    vi.setSystemTime(T0 + ZAPIER_DEDUPE_MS + MIN);
    await zap('add-note', { lead_id: 'l1', note: 'Called back' });
    expect(notes()).toBe(2);
    await zap('add-note', { lead_id: 'l1', note: 'Run A' }, { 'idempotency-key': 'zap-run-1' });
    vi.setSystemTime(Date.now() + 2 * DAY);
    expect(await (await zap('add-note', { lead_id: 'l1', note: 'Run A' }, { 'idempotency-key': 'zap-run-1' })).json()).toEqual({ ok: true, duplicate: true });
    expect(notes()).toBe(3);
    expect((await zap('add-note', { lead_id: 'nobody', note: 'x' })).status).toBe(400);
    expect((await zap('add-note', { lead_id: 'nobody', note: 'x' })).status).toBe(400);
    expect((await zap('create-lead', { email: 'new@x.co' })).status).toBe(200);
    expect(await (await zap('create-lead', { email: 'new@x.co' })).json()).toEqual({ ok: true, duplicate: true });
    expect((await zap('nope', {})).status).toBe(404);
    expect((await zap('add-note', { lead_id: 'l1', note: 'x' }, { 'x-zapier-secret': 'wrong' })).status).toBe(401);
  });
});

// ───────────── D1: the hot queries use indexes ─────────────

describe('D1 indexes (migration 0064)', () => {
  const plan = (d: DatabaseSync, sql: string, n: number) => (d.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n).fill(1)) as { detail: string }[]).map((r) => r.detail).join(' | ');
  const HOT: [string, number, RegExp][] = [
    ['UPDATE emails SET error = ? WHERE provider_id = ?', 2, /idx_emails_provider/],
    ['SELECT SUM(status = \'simulated\') FROM emails WHERE sent_at BETWEEN ? AND ?', 2, /idx_emails_sent/],
    ["SELECT COUNT(*) AS n FROM emails WHERE sequence = ? AND status IN ('sent','simulated') AND sent_at BETWEEN ? AND ?", 3, /idx_emails_seq_sent/],
    ["SELECT COUNT(*) AS n FROM outbound_calls WHERE kind != 'test' AND created_at > ?", 1, /idx_outbound_(kind_)?created/],
    ['SELECT COUNT(*) AS n FROM outbound_calls WHERE kind = ? AND created_at BETWEEN ? AND ?', 3, /idx_outbound_kind_created/],
    ["SELECT COUNT(*) FROM outbound_calls oc JOIN leads l ON l.id = oc.lead_id WHERE l.phone = ? AND oc.kind != 'test' AND oc.created_at > ?", 2, /idx_leads_phone/],
    ['SELECT r.id FROM webinar_registrations r JOIN webinar_sessions s ON s.id = r.session_id WHERE r.created_at >= ? AND (r.joined_at IS NOT NULL OR r.replay_at IS NOT NULL) LIMIT 5000', 1, /idx_webinar_reg_created/],
    ["SELECT 1 FROM whatsapp_messages WHERE provider_id = ? AND direction = 'in' LIMIT 1", 1, /idx_wa_provider/],
    ['SELECT id FROM vsl_views WHERE visitor_id = ? ORDER BY started_at DESC', 1, /idx_vsl_visitor/],
    ['SELECT SUM(author = \'viewer\') FROM webinar_chat WHERE created_at BETWEEN ? AND ?', 2, /idx_wchat_created/],
    ['SELECT s.body FROM sms_messages s WHERE s.created_at BETWEEN ? AND ? ORDER BY s.created_at DESC LIMIT 60', 2, /idx_sms_created/],
    ['SELECT COUNT(*) FROM attr_touches WHERE ts > ? AND ad_id IS NOT NULL', 1, /idx_attr_touches_ts/],
    ["SELECT r.lead_id FROM challenge_registrations r WHERE r.status = 'pending' AND r.created_at BETWEEN ? AND ?", 2, /idx_chreg_status/],
    ["SELECT id FROM webhook_events WHERE status IN ('queued', 'failed') AND updated_at < ? ORDER BY updated_at LIMIT 25", 1, /idx_webhook_events_retry/],
  ];
  it('every hot query searches an index after 0064 (and scanned before it)', () => {
    const before = freshDb({ before: '0064' });
    for (const [sql, n, idx] of HOT) {
      expect(plan(db, sql, n), sql).toMatch(idx);
      expect(plan(db, sql, n), sql).toMatch(/SEARCH/);
      if (!/webhook_events/.test(sql)) expect(plan(before, sql, n), sql).not.toMatch(idx);
    }
  });
  it('the DM link match walks recent sessions by date, not every session per thread', () => {
    const src = fs.readFileSync(`${node.cwd()}/src/dm/inbox.ts`, 'utf8');
    const sql = /const viaLink = await db\.prepare\(\s*`([\s\S]*?)`/.exec(src)![1];
    expect(plan(db, sql, 1)).toMatch(/SEARCH s USING INDEX idx_sessions_started/);
  });
  it('0064 is additive only', () => {
    const sql = fs.readFileSync(`${MIGRATIONS}/0064_reliability.sql`, 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE|ALTER)\b/i);
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) expect(stmt).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS/);
  });
});

// ───────────── room Durable Object hygiene ─────────────

function bigWebinar(n: number) {
  const st = newRoomState({ id: 'rmbig0000001', mode: 'webinar', title: 'Live', startsAt: T0 });
  join(st, { id: 'hadmin', name: 'Josh', role: 'host' }, T0);
  join(st, { id: 'r0', name: 'Person 0', role: 'attendee', leadId: 'l0', regId: 'g0' }, T0);
  const proto = st.members.r0;
  for (let i = 0; i < n; i++) {
    st.members[`r${i}`] = { ...proto, id: `r${i}`, name: `Person ${i}`, leadId: `l${i}`, regId: `g${i}`, joinedAt: T0 + i, lastAt: T0 + i, tracks: [] };
    st.eng!.pts[`r${i}`] = 5; st.eng!.mins[`r${i}`] = 12; st.eng!.unlocks[`r${i}`] = ['scripts'];
  }
  return st;
}

describe('room state stays bounded', () => {
  it('drops the longest-gone people beyond the cap, never staff, the stage or raised hands', () => {
    const st = bigWebinar(MEMBER_CAP + 300);
    for (let i = 0; i < 1000; i++) st.members[`r${i}`].connected = 0;
    st.members.r0.stage = true;
    st.members.r1.hand = T0;
    const out = boundRoomState(st);
    expect(Object.keys(st.members)).toHaveLength(MEMBER_CAP);
    expect(out.members).toBe(301);
    expect(st.members.r0 && st.members.r1 && st.members.hadmin).toBeTruthy();
    expect(st.members.r2).toBeUndefined(); // oldest gone first
    expect(st.members.r999).toBeDefined();
    // Engagement maps keep everyone up to ENG_CAP people who left.
    expect(Object.keys(st.eng!.pts).length).toBe(MEMBER_CAP + 300);
    const st2 = bigWebinar(10);
    for (let i = 0; i < ENG_CAP + 50; i++) st2.eng!.pts[`gone${i}`] = 1;
    expect(boundRoomState(st2).eng).toBe(50);
    expect(st2.eng!.pts.r3).toBe(5);
  });

  it('a 5,000-person webinar with full chat and Q&A fits one storage value (2 MB)', () => {
    const st = bigWebinar(5000);
    for (let i = 0; i < 200; i++) st.chat.msgs.push({ id: i, by: `r${i}`, name: `Person ${i}`, role: 'attendee', text: 'x'.repeat(380), at: T0 });
    for (let i = 0; i < 150; i++) st.qa.push({ id: i, by: `r${i}`, name: `Person ${i}`, text: 'q'.repeat(280), at: T0, votes: Array.from({ length: 400 }, (_, k) => `r${k}`), answered: i % 2 === 0 });
    boundRoomState(st);
    expect(JSON.stringify(st).length).toBeLessThan(2_000_000);
  });
});

describe('ended rooms are cleaned up', () => {
  it('keepDays is bounded and cleanupAt waits for the last person', () => {
    expect(keepDays({})).toBe(30);
    expect(keepDays({ ROOM_DO_KEEP_DAYS: '2' })).toBe(7);
    expect(keepDays({ ROOM_DO_KEEP_DAYS: '9999' })).toBe(365);
    const st = newRoomState({ id: 'rm1', mode: 'webinar', title: 'x', startsAt: T0 });
    expect(cleanupAt(st, 30, 0)).toBeNull();
    st.status = 'ended'; st.endedAt = T0;
    expect(cleanupAt(st, 30, 1)).toBeNull();
    expect(cleanupAt(st, 30, 0)).toBe(T0 + 30 * DAY);
  });

  it('the setting passes the copy rules', () => {
    const def = SETTING_DEFS.find((s) => s.key === 'ROOM_DO_KEEP_DAYS')!;
    expect(auditCopy(`${def.label}. ${def.help}`)).toEqual([]);
  });
});

// A Durable Object context good enough for alarms, sockets and storage.
function fakeCtx() {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const sockets: { id: string; readyState: number; sent: string[] }[] = [];
  const state = { failList: false };
  const storage = {
    get: async (k: string | string[]) => (Array.isArray(k) ? new Map(k.filter((x) => store.has(x)).map((x) => [x, store.get(x)])) : store.get(k)),
    put: async (k: string | Record<string, unknown>, v?: unknown) => { if (typeof k === 'string') store.set(k, structuredClone(v)); else for (const [a, b] of Object.entries(k)) store.set(a, structuredClone(b)); },
    delete: async (k: string) => store.delete(k),
    list: async (o: { prefix?: string; limit?: number } = {}) => { if (state.failList) throw new Error('storage unavailable'); return new Map([...store].filter(([k]) => !o.prefix || k.startsWith(o.prefix)).slice(0, o.limit ?? 1e9)); },
    deleteAll: async () => store.clear(),
    getAlarm: async () => alarm,
    setAlarm: async (t: number) => { alarm = t; },
    deleteAlarm: async () => { alarm = null; },
  };
  const ws = (s: (typeof sockets)[number]) => ({ readyState: s.readyState, deserializeAttachment: () => ({ id: s.id }), send: (d: string) => s.sent.push(d), close: () => { s.readyState = 3; } });
  return {
    ctx: { storage, getWebSockets: (tag?: string) => sockets.filter((s) => s.readyState === 1 && (!tag || s.id === tag)).map(ws), acceptWebSocket: () => {}, waitUntil: () => {}, blockConcurrencyWhile: async (f: () => Promise<void>) => f() },
    store, sockets, state, alarm: () => alarm,
  };
}
async function roomDo(st: RoomState) {
  const f = fakeCtx();
  await f.ctx.storage.put('st', st);
  const dobj = new RoomDO(f.ctx as never, env as never);
  await new Promise((r) => setTimeout(r, 0));
  return { f, dobj };
}

describe('room alarms', () => {
  it('a crash inside the minute work still books the next minute', async () => {
    const st = newRoomState({ id: 'rmcrash00001', mode: 'webinar', title: 'Live', startsAt: T0 });
    join(st, { id: 'ra', name: 'Ann', role: 'attendee' }, T0);
    const { f, dobj } = await roomDo(st);
    f.sockets.push({ id: 'ra', readyState: 1, sent: [] });
    f.state.failList = true; // the call quality flush throws
    await dobj.alarm();
    expect(f.alarm()).toBe(T0 + MIN);
  });

  it('nobody left in an ended room: books the clean-up, a join brings back the minute loop, the due alarm clears storage', async () => {
    x("INSERT INTO rooms (id, mode, title, ref_type, status, starts_at, duration_min, created_at, updated_at, ended_at) VALUES ('rmend0000001', 'webinar', 'Live', 'none', 'ended', ?, 60, ?, ?, ?)", T0, T0, T0, T0);
    const st = newRoomState({ id: 'rmend0000001', mode: 'webinar', title: 'Live', startsAt: T0 });
    st.status = 'ended'; st.endedAt = T0;
    const { f, dobj } = await roomDo(st);
    await f.ctx.storage.put('mq:ra', { who: 'ra' });
    await dobj.alarm();
    expect(f.alarm()).toBe(T0 + 30 * DAY);
    // Someone opens the room again: the minute loop comes back (the clean-up alarm alone would starve it).
    f.sockets.push({ id: 'ra', readyState: 1, sent: [] });
    await (dobj as unknown as { ensureMinuteAlarm(n: number): Promise<void> }).ensureMinuteAlarm(Date.now());
    expect(f.alarm()).toBe(T0 + MIN);
    f.sockets.length = 0;
    vi.setSystemTime(T0 + 31 * DAY);
    await dobj.alarm();
    expect(f.store.size).toBe(0);
    expect(f.alarm()).toBeNull();
    expect(q('SELECT room_id, detail FROM room_do_gc')).toEqual([{ room_id: 'rmend0000001', detail: 'alarm' }]);
  });

  it('a room ended from Funnel HQ (not in the room) is noticed; the daily sweep clears old ones once', async () => {
    x("INSERT INTO rooms (id, mode, title, ref_type, status, starts_at, duration_min, created_at, updated_at, ended_at) VALUES ('rmold0000001', 'webinar', 'Old', 'none', 'ended', ?, 60, ?, ?, ?)", T0 - 90 * DAY, T0 - 90 * DAY, T0 - 90 * DAY, T0 - 90 * DAY);
    const st = newRoomState({ id: 'rmold0000001', mode: 'webinar', title: 'Old', startsAt: T0 - 90 * DAY }); // its object never heard it ended
    const { f, dobj } = await roomDo(st);
    env.ROOMS = { idFromName: (n: string) => n, get: () => ({ fetch: (req: Request) => dobj.fetch(req) }) };
    const rt = makeRt();
    expect(await sweepRoomStorage(rt)).toEqual({ checked: 1, cleared: 1 });
    expect(f.store.size).toBe(0);
    expect(await sweepRoomStorage(rt)).toBeNull(); // once a day
    vi.setSystemTime(T0 + DAY);
    expect(await sweepRoomStorage(rt)).toEqual({ checked: 0, cleared: 0 });
    // The endpoint refuses anything not ended.
    const live = newRoomState({ id: 'rmlive000001', mode: 'webinar', title: 'Live', startsAt: T0 });
    const b = await roomDo(live);
    const r = await b.dobj.fetch(new Request('https://room/gc', { method: 'POST', headers: { 'x-room-gc': '1' } }));
    expect(await r.json()).toMatchObject({ cleared: false });
    expect(b.f.store.size).toBe(1);
  });
});

describe('room timeline is bounded', () => {
  it('past the cap only structural events are logged', async () => {
    const stmt = db.prepare("INSERT INTO room_intel_events (room_id, at, kind, who, text) VALUES ('rmcap0000001', ?, 'chat', 'r', 'x')");
    for (let i = 0; i < INTEL_EVENT_CAP; i++) stmt.run(T0 + i);
    await logEvents(env as never, 'rmcap0000001', [{ at: T0, kind: 'chat', text: 'more' }, { at: T0, kind: 'chapter', text: 'Part 2' }]);
    expect(q("SELECT kind FROM room_intel_events WHERE room_id = 'rmcap0000001' AND at = ? AND (text = 'more' OR kind = 'chapter')", T0)).toEqual([{ kind: 'chapter' }]);
    await logEvents(env as never, 'rmother00001', [{ at: T0, kind: 'chat', text: 'fine' }]);
    expect(q("SELECT COUNT(*) AS n FROM room_intel_events WHERE room_id = 'rmother00001'")).toEqual([{ n: 1 }]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Claude is mocked: each test sets what the model "answers".
const claude = vi.hoisted(() => ({ reply: '' as string, calls: [] as { system: unknown; messages: unknown; model: string }[] }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (req: { system: unknown; messages: unknown; model: string }) => {
        claude.calls.push(req);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: claude.reply }] };
      },
    };
  },
}));

import { Hono } from 'hono';
import type { AppEnv, Runtime } from '../src/app';
import { SETTINGS } from '../src/settings';
import { auditCopy } from '../src/content/copy-rules';
import { hmacHex, signToken } from '../src/lib/crypto';
import type { Rep } from '../src/sales/reps';
import { verifyChallenge, verifyIgSignature, igHost } from '../src/dm/graph';
import {
  DAY, HOUR, bestAndWorst, contactsIn, fillTemplate, firstMatch, matchesTrigger, priority, privateReplyBlock, publicReplyTarget, scoreConversation, scriptStats, statedRevenue, windowLabel, windowState,
} from '../src/dm/rules';
import { type DmThread, getThread, ingestWebhook, parseMessaging, sendReply, updateThread, importedEvent } from '../src/dm/inbox';
import { ASSISTANT_PREFIX, NO_KEY_NOTE, draftProblems, draftReply, maybeAutoReply, ruleFlag, summaryText, ruleSummary } from '../src/dm/ai';
import { composeSetterDigest, dayBounds, scriptReport, tasksFrom } from '../src/dm/team';
import { mountDmHooks, setupSteps } from '../src/dm/routes';

// ───────────── A real SQLite database shaped like D1, every migration applied ─────────────
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
const REPS = [
  { id: 'sam', name: 'Sam', email: 'sam@example.com', role: 'setter', active: 1, commission_pct: 10, slack_user_id: 'U1' },
  { id: 'kim', name: 'Kim', email: null, role: 'closer', active: 1, commission_pct: 15, slack_user_id: null },
] as unknown as Rep[];
const BASE = { IG_ACCESS_TOKEN: 'IGAAtest', IG_ACCOUNT_ID: '1784', IG_APP_SECRET: 'appsecret', IG_WEBHOOK_VERIFY_TOKEN: 'verify-me', SALES_TIMEZONE: 'UTC' };
const pending: Promise<unknown>[] = [];
const settingsOf = (s: Record<string, string>) => ({ ...Object.fromEntries(SETTINGS.map((d) => [d.key, ''])), ...s }) as Runtime['settings'];
const makeRt = (db: DatabaseSync, s: Record<string, string> = BASE) =>
  ({ env: { DB: d1(db) }, settings: settingsOf(s), reps: REPS, origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;
const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };

interface Call { url: string; method: string; body: Record<string, unknown> | null }
function stubGraph(o: { fail?: boolean } = {}) {
  const calls: Call[] = [];
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (o.fail) return json(400, { error: { message: 'Outside of allowed window', code: 10, error_subcode: 2534022 } });
    if (/\/messages$/.test(new URL(u).pathname)) return json(200, { recipient_id: 'x', message_id: `mid.sent.${++n}` });
    if (/\/replies$/.test(new URL(u).pathname)) return json(200, { id: 'reply_1' });
    if (/graph\.instagram\.com\/v[\d.]+\/\d+$/.test(u.split('?')[0])) return json(200, { name: 'Dana Smith', username: 'dana.owner' });
    return json(200, {});
  }));
  return calls;
}
const sent = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && /\/messages$/.test(new URL(c.url).pathname));

beforeEach(() => { claude.reply = ''; claude.calls.length = 0; });
afterEach(async () => { await flush(); vi.unstubAllGlobals(); });

const dm = (from: string, text: string, ts: number, extra: Record<string, unknown> = {}) => ({
  object: 'instagram',
  entry: [{ id: '1784', time: ts, messaging: [{ sender: { id: from }, recipient: { id: '1784' }, timestamp: ts, message: { mid: `mid.${from}.${ts}`, text, ...extra } }] }],
});

// ───────────────────────────── Webhook verification and signatures ─────────────────────────────

describe('Instagram webhook: verify handshake and X-Hub-Signature-256', () => {
  it('echoes the challenge only for the right verify token', () => {
    const s = settingsOf(BASE);
    expect(verifyChallenge(s, { mode: 'subscribe', token: 'verify-me', challenge: '1158201444' })).toBe('1158201444');
    expect(verifyChallenge(s, { mode: 'subscribe', token: 'wrong', challenge: '1' })).toBeNull();
    expect(verifyChallenge(settingsOf({}), { mode: 'subscribe', token: '', challenge: '1' })).toBeNull();
    expect(verifyChallenge(s, { mode: 'unsubscribe', token: 'verify-me', challenge: '1' })).toBeNull();
  });

  it('accepts only a body signed with the app secret', async () => {
    const raw = JSON.stringify(dm('99', 'hello', 1));
    const sig = `sha256=${await hmacHex('appsecret', raw)}`;
    expect(await verifyIgSignature('appsecret', raw, sig)).toBe(true);
    expect(await verifyIgSignature('appsecret', `${raw} `, sig)).toBe(false);
    expect(await verifyIgSignature('other', raw, sig)).toBe(false);
    expect(await verifyIgSignature('appsecret', raw, null)).toBe(false);
    expect(await verifyIgSignature('', raw, sig)).toBe(false);
  });

  it('routes: GET handshake, POST rejects bad signatures and ingests good ones', async () => {
    const db = freshDb();
    stubGraph();
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('settings', settingsOf(BASE)); c.set('reps', REPS); await next(); });
    const hooks = new Hono<AppEnv>();
    mountDmHooks(hooks);
    app.route('/hooks', hooks);
    const env = { DB: d1(db) };
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {} };
    const get = await app.request('/hooks/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42', {}, env, ctx as never);
    expect(await get.text()).toBe('42');
    expect((await app.request('/hooks/instagram?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42', {}, env, ctx as never)).status).toBe(403);
    const raw = JSON.stringify(dm('99', 'Hi, we do $4M a year and want to buy a competitor', Date.now()));
    const bad = await app.request('/hooks/instagram', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': 'sha256=00' } }, env, ctx as never);
    expect(bad.status).toBe(401);
    const good = await app.request('/hooks/instagram', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': `sha256=${await hmacHex('appsecret', raw)}` } }, env, ctx as never);
    expect(good.status).toBe(200);
    await flush();
    const t = db.prepare('SELECT * FROM dm_threads').get() as DmThread;
    expect(t.ig_user_id).toBe('99');
    expect(t.band).toBe('hot');
  });
});

// ───────────────────────────── Ingest and threading ─────────────────────────────

describe('message ingest and threading', () => {
  it('threads by sender, dedupes retries, stores echoes as outbound and story replies by kind', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    stubGraph();
    const t0 = Date.now() - 60_000;
    await ingestWebhook(rt, dm('55', 'hey', t0));
    await ingestWebhook(rt, dm('55', 'hey', t0)); // Meta retry
    await ingestWebhook(rt, dm('55', 'love this', t0 + 1000, { reply_to: { story: { id: 'st1', url: 'https://cdn/story' } } }));
    // Echo: a message the account sent from the Instagram app.
    await ingestWebhook(rt, { object: 'instagram', entry: [{ id: '1784', messaging: [{ sender: { id: '1784' }, recipient: { id: '55' }, timestamp: t0 + 2000, message: { mid: 'mid.echo', text: 'Thanks', is_echo: true } }] }] });
    await ingestWebhook(rt, dm('77', 'other person', t0 + 3000));
    await flush();
    const threads = db.prepare('SELECT * FROM dm_threads ORDER BY created_at').all() as DmThread[];
    expect(threads.map((t) => t.ig_user_id)).toEqual(['55', '77']);
    const msgs = db.prepare("SELECT direction, kind, sent_by FROM dm_messages WHERE thread_id = ? ORDER BY ts").all(threads[0].id) as { direction: string; kind: string; sent_by: string | null }[];
    expect(msgs).toEqual([{ direction: 'in', kind: 'text', sent_by: null }, { direction: 'in', kind: 'story_reply', sent_by: null }, { direction: 'out', kind: 'text', sent_by: 'instagram' }]);
    expect(threads[0].last_in_at).toBe(t0 + 1000);
    expect(threads[0].last_out_at).toBe(t0 + 2000);
    expect(threads[0].status).toBe('replied'); // the owner answered from the Instagram app: a human reply
    expect(threads[0].name).toBe('Dana Smith'); // User Profile API
  });

  it('parses story mentions, postbacks and click-to-Direct ad referrals', () => {
    const mention = parseMessaging('1784', { sender: { id: '9' }, recipient: { id: '1784' }, timestamp: 1, message: { mid: 'm', attachments: [{ type: 'story_mention', payload: { url: 'https://cdn/x' } }] } });
    expect(mention).toMatchObject({ kind: 'story_mention', direction: 'in', media_url: 'https://cdn/x', ts: 1000 });
    expect(parseMessaging('1784', { sender: { id: '9' }, recipient: { id: '1784' }, postback: { mid: 'p', title: 'Get started', payload: 'GS' } })).toMatchObject({ kind: 'postback', text: 'Get started' });
    expect(parseMessaging('1784', { sender: { id: '9' }, recipient: { id: '1784' }, referral: { source: 'ADS', ad_id: '123' } })).toMatchObject({ kind: 'referral', fromAd: true });
    expect(parseMessaging('1784', { sender: { id: '9' }, recipient: { id: '1784' }, message: { mid: 'x', is_deleted: true } })).toBeNull();
    expect(importedEvent('1784', { id: 'm1', created_time: '2026-10-30T10:00:00+0000', from: { id: '1784' }, to: { data: [{ id: '9', username: 'dana' }] }, message: 'hi' })).toMatchObject({ igsid: '9', direction: 'out', username: 'dana' });
  });

  it('links the conversation to a lead by an email they type', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    stubGraph();
    db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, email, status) VALUES ('l1', 'ABCDEF', 1, 1, 'dana@clinic.com', 'applied')").run();
    await ingestWebhook(rt, dm('55', 'sure, it is dana@clinic.com', Date.now()));
    await flush();
    const t = db.prepare('SELECT lead_id, lead_match FROM dm_threads').get() as { lead_id: string; lead_match: string };
    expect(t).toEqual({ lead_id: 'l1', lead_match: 'email' });
  });
});

// ───────────────────────────── Windows ─────────────────────────────

describe('Meta messaging windows', () => {
  const now = 1_800_000_000_000;
  it('24 hours from their last message; 7 days after a click-to-Direct ad', () => {
    expect(windowState({ last_in_at: null }, now).mode).toBe('closed');
    expect(windowState({ last_in_at: now - 23 * HOUR }, now)).toMatchObject({ mode: 'standard', msLeft: HOUR });
    expect(windowState({ last_in_at: now - 25 * HOUR }, now).mode).toBe('closed');
    expect(windowState({ last_in_at: now - 3 * DAY, window_hours: 168 }, now).mode).toBe('standard');
  });
  it('human agent tag: 7 days, only when switched on and never for automated messages', () => {
    const t = { last_in_at: now - 3 * DAY };
    expect(windowState(t, now, { humanAgent: true }).mode).toBe('human_agent');
    expect(windowState(t, now, { humanAgent: true, automated: true }).mode).toBe('closed');
    expect(windowState({ last_in_at: now - 8 * DAY }, now, { humanAgent: true }).mode).toBe('closed');
    expect(windowLabel(windowState({ last_in_at: now - 22 * HOUR }, now))).toBe('2h left');
    expect(windowLabel(windowState({ last_in_at: now - 30 * HOUR }, now))).toBe('Window closed');
  });
});

// ───────────────────────────── Scoring ─────────────────────────────

describe('Hot / Warm / Cold scoring', () => {
  it('reads stated revenue', () => {
    expect(statedRevenue('we do about $4.5M in revenue')).toBe(4_500_000);
    expect(statedRevenue('a 7 figure business')).toBe(1_000_000);
    expect(statedRevenue('my clinic turns over 800k a year')).toBe(800_000);
    expect(statedRevenue('I have 3 kids')).toBeNull();
  });
  it('scores revenue, size, intent and engagement, with a reason', () => {
    const hot = scoreConversation({ texts: ['I own 4 clinics doing $6M revenue', 'How much is it and can we book a call?'] });
    expect(hot.band).toBe('hot');
    expect(hot.revenueBand).toBe('3-10M');
    expect(hot.reason).toMatch(/States 3-10M revenue/);
    expect(scoreConversation({ texts: ['interested, how do I start'] }).band).toBe('warm');
    expect(scoreConversation({ texts: ['nice post'] }).band).toBe('cold');
    const spam = scoreConversation({ texts: ['promote your page with crypto followers www.spam.io'] });
    expect(spam.band).toBe('cold');
    expect(spam.reason).toMatch(/spam|Low fit/);
    expect(scoreConversation({ texts: ['hi'], knownBand: '1-3M' }).reason).toMatch(/on file/);
  });
  it('priority: hot and waiting first, junk last', () => {
    const now = 1_800_000_000_000;
    const base = { last_out_at: null, window_hours: 24 };
    const hotWait = priority({ ...base, band: 'hot', last_in_at: now - 2 * HOUR }, now);
    const warmWait = priority({ ...base, band: 'warm', last_in_at: now - 2 * HOUR }, now);
    const hotAnswered = priority({ band: 'hot', last_in_at: now - 2 * HOUR, last_out_at: now - HOUR }, now);
    expect(hotWait).toBeGreaterThan(warmWait);
    expect(hotWait).toBeGreaterThan(hotAnswered);
    expect(priority({ ...base, band: 'hot', last_in_at: now, ai_flag: 'junk' }, now)).toBeLessThan(0);
  });
  it('rule flags: junk and about to close', () => {
    expect(ruleFlag(['follow for follow crypto signals www.x.io']).flag).toBe('junk');
    expect(ruleFlag(['ok', 'send me the link, ready to start']).flag).toBe('closing');
    expect(ruleFlag(['hello']).flag).toBeNull();
  });
});

// ───────────────────────────── Triggers and private replies ─────────────────────────────

const trigger = (o: Record<string, unknown> = {}) => ({ id: 't1', keywords: 'deal, buy now', match_mode: 'word', sources: '["comment","story_reply","dm"]', active: 1, ...o });

describe('keyword triggers', () => {
  it('matches whole words, phrases, anywhere or the whole message, per source', () => {
    expect(matchesTrigger(trigger(), 'comment', 'DEAL please')).toBe('deal');
    expect(matchesTrigger(trigger(), 'comment', 'ideal')).toBeNull();
    expect(matchesTrigger(trigger(), 'dm', 'I want to buy now.')).toBe('buy now');
    expect(matchesTrigger(trigger({ match_mode: 'contains' }), 'dm', 'ideal')).toBe('deal');
    expect(matchesTrigger(trigger({ match_mode: 'exact' }), 'dm', 'Deal!')).toBe('deal');
    expect(matchesTrigger(trigger({ match_mode: 'exact' }), 'dm', 'deal me in')).toBeNull();
    expect(matchesTrigger(trigger({ sources: '["comment"]' }), 'dm', 'deal')).toBeNull();
    expect(matchesTrigger(trigger({ active: 0 }), 'comment', 'deal')).toBeNull();
    expect(firstMatch([trigger({ id: 'a', keywords: 'x' }), trigger({ id: 'b' })], 'comment', 'deal')?.rule.id).toBe('b');
    expect(fillTemplate('Hi {first_name}, here: {link}', { first_name: 'Dana Smith', link: 'https://l/x' })).toBe('Hi Dana, here: https://l/x');
    expect(fillTemplate('Hi {first_name}', { link: 'https://l/x' })).toBe('Hi there\nhttps://l/x');
  });

  it('private replies: one per comment, within 7 days; public replies go to the top-level comment', () => {
    const now = 1_800_000_000_000;
    expect(privateReplyBlock({ ts: now - DAY, private_reply_at: null }, now)).toBeNull();
    expect(privateReplyBlock({ ts: now - 8 * DAY, private_reply_at: null }, now)).toMatch(/7 days/);
    expect(privateReplyBlock({ ts: now - DAY, private_reply_at: now - 1 }, now)).toMatch(/already/);
    expect(publicReplyTarget({ id: 'c2', parent_id: 'c1' })).toBe('c1');
    expect(publicReplyTarget({ id: 'c1' })).toBe('c1');
  });

  it('a comment trigger tags, assigns, sends the private reply with the DM link and the public reply, once', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const calls = stubGraph();
    db.prepare("INSERT INTO tracked_links (code, label, kind, dest_path, utm_source, utm_medium, utm_campaign, created_at) VALUES ('ig-mc', 'Masterclass', 'custom', '/masterclass', 'instagram', 'dm', 'mc', 1)").run();
    db.prepare("INSERT INTO dm_triggers (id, name, keywords, tag, assign_to, first_message, link_code, public_reply, created_at, updated_at) VALUES ('t1', 'MC', 'masterclass', 'mc', 'sam', 'Hi {first_name}, the ticket page: {link}', 'ig-mc', 'Sent you a DM', 1, 1)").run();
    const comment = (id: string) => ({ object: 'instagram', entry: [{ id: '1784', time: Math.floor(Date.now() / 1000), changes: [{ field: 'comments', value: { id, text: 'MASTERCLASS', from: { id: '321', username: 'owner.co' }, media: { id: 'med1' } } }] }] });
    await ingestWebhook(rt, comment('c1'));
    await ingestWebhook(rt, comment('c1')); // retry: ignored
    await ingestWebhook(rt, comment('c2')); // second comment: no second first message
    await flush();
    const priv = sent(calls).filter((c) => (c.body?.recipient as { comment_id?: string }).comment_id);
    expect(priv).toHaveLength(1);
    expect(priv[0].body).toMatchObject({ recipient: { comment_id: 'c1' } });
    const t = db.prepare('SELECT * FROM dm_threads').get() as DmThread;
    expect(String((priv[0].body!.message as { text: string }).text)).toContain(`https://apply.test/l/ig-mc?dm=${t.id}`);
    expect(calls.filter((c) => c.url.includes('/c1/replies'))).toHaveLength(1);
    expect(JSON.parse(t.tags)).toEqual(['mc']);
    expect(t.assignee_id).toBe('sam');
    expect(t.link_code).toBe('ig-mc');
    expect((db.prepare("SELECT private_reply_at FROM dm_comments WHERE id = 'c1'").get() as { private_reply_at: number }).private_reply_at).toBeGreaterThan(0);
    expect((db.prepare("SELECT hits FROM dm_triggers WHERE id = 't1'").get() as { hits: number }).hits).toBe(2);
  });

  it('a DM trigger answers inside the 24-hour window', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const calls = stubGraph();
    db.prepare("INSERT INTO dm_triggers (id, name, keywords, sources, first_message, created_at, updated_at) VALUES ('t2', 'Guide', 'guide', '[\"dm\",\"story_reply\"]', 'Here is the guide.', 1, 1)").run();
    await ingestWebhook(rt, dm('88', 'can I get the guide', Date.now()));
    await flush();
    expect(sent(calls)).toHaveLength(1);
    expect(sent(calls)[0].body).toMatchObject({ recipient: { id: '88' }, message: { text: 'Here is the guide.' } });
    expect(sent(calls)[0].body).not.toHaveProperty('tag');
  });
});

// ───────────────────────────── Send path ─────────────────────────────

describe('sending a reply (Graph API mocked)', () => {
  async function thread(db: DatabaseSync, rt: Runtime, lastIn: number) {
    stubGraph();
    await ingestWebhook(rt, dm('42', 'hello', lastIn));
    await flush();
    vi.unstubAllGlobals();
    return (db.prepare('SELECT * FROM dm_threads').get() as DmThread).id;
  }

  it('sends inside the window, marks the thread replied and credits the setter', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const id = await thread(db, rt, Date.now() - HOUR);
    db.prepare("INSERT INTO dm_scripts (id, title, body, category, created_at, updated_at) VALUES ('s1', 'Opener', 'Hi', 'opener', 1, 1)").run();
    const calls = stubGraph();
    const r = await sendReply(rt, id, { text: 'Thanks for the message. What does the business do a year?', by: 'sam', script_id: 's1' });
    expect(r).toMatchObject({ ok: true, mode: 'standard' });
    expect(calls[0].url).toBe('https://graph.instagram.com/v24.0/1784/messages');
    expect(calls[0].body).toEqual({ recipient: { id: '42' }, message: { text: 'Thanks for the message. What does the business do a year?' } });
    const t = (await getThread(rt, id))!;
    expect(t.status).toBe('replied');
    expect(t.opener_script_id).toBe('s1');
    expect((db.prepare("SELECT sent_by, script_id, mid FROM dm_messages WHERE direction = 'out'").get() as Record<string, string>)).toEqual({ sent_by: 'sam', script_id: 's1', mid: 'mid.sent.1' });
  });

  it('refuses outside the window, uses the HUMAN_AGENT tag when allowed, and records Graph errors', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const id = await thread(db, rt, Date.now() - 2 * DAY);
    const calls = stubGraph();
    await expect(sendReply(rt, id, { text: 'hi', by: 'sam' })).rejects.toThrow(/window has closed/);
    expect(calls).toHaveLength(0);
    const ha = makeRt(db, { ...BASE, DM_HUMAN_AGENT: 'on' });
    const r = await sendReply(ha, id, { text: 'Sorry for the slow reply.', by: 'sam' });
    expect(r.mode).toBe('human_agent');
    expect(calls[0].body).toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });
    vi.unstubAllGlobals();
    stubGraph({ fail: true });
    await expect(sendReply(ha, id, { text: 'again', by: 'sam' })).rejects.toThrow(/Outside of allowed window/);
    expect((db.prepare("SELECT status, error FROM dm_messages WHERE body = 'again'").get() as { status: string; error: string }).status).toBe('failed');
    expect(igHost('EAAB')).toBe('https://graph.facebook.com');
  });

  it('closing a linked thread marks the lead won with the deal value and credits the setter', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const id = await thread(db, rt, Date.now() - HOUR);
    db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, email, status) VALUES ('l9', 'QWERTY', 1, 1, 'x@y.co', 'booked')").run();
    stubGraph();
    await updateThread(rt, id, { assignee_id: 'sam', lead_id: 'l9' });
    await updateThread(rt, id, { deal_value: 50000 });
    await updateThread(rt, id, { status: 'closed' });
    await flush();
    const lead = db.prepare("SELECT status, revenue, setter_id FROM leads WHERE id = 'l9'").get();
    expect(lead).toEqual({ status: 'won', revenue: 50000, setter_id: 'sam' });
    const t = (await getThread(rt, id))!;
    expect(t.closed_at).toBeGreaterThan(0);
    expect(t.booked_at).toBeGreaterThan(0);
  });
});

// ───────────────────────────── AI ─────────────────────────────

describe('AI drafts (Claude mocked)', () => {
  async function setup(settings: Record<string, string>) {
    const db = freshDb();
    const rt = makeRt(db, settings);
    stubGraph();
    await ingestWebhook(rt, dm('42', 'We run 3 dental clinics, about $5M. How does buying another one work?', Date.now() - 10 * 60_000));
    await flush();
    db.prepare("INSERT INTO dm_scripts (id, title, body, category, created_at, updated_at) VALUES ('s1', 'Clinic opener', 'Hi {first_name}, how many clinics do you run now?', 'opener', 1, 1)").run();
    db.prepare("INSERT INTO dm_scripts (id, title, body, category, created_at, updated_at) VALUES ('faq1', 'Price', 'The fee depends on the size of the business and is covered on the strategy call.', 'faq', 1, 1)").run();
    return { db, rt, id: (db.prepare('SELECT id FROM dm_threads').get() as { id: string }).id };
  }

  it('without a key: the best matching script and a note to add the key', async () => {
    const { rt, id } = await setup(BASE);
    const d = await draftReply(rt, id, 'sam');
    expect(d).toMatchObject({ ai: false, script_id: 's1', note: NO_KEY_NOTE });
    expect(d.text).toBe('Hi Dana, how many clinics do you run now?');
  });

  it('with a key: uses the setter voice, scripts and thread, and returns the draft for the setter to send', async () => {
    const { db, rt, id } = await setup({ ...BASE, ANTHROPIC_API_KEY: 'sk-test', DM_MODEL: 'test-model' });
    db.prepare("INSERT INTO dm_messages (id, thread_id, mid, direction, body, sent_by, status, ts) VALUES ('old', ?, 'm-old', 'out', 'Love that. What made you start looking?', 'sam', 'sent', 1)").run(id);
    claude.reply = '{"text": "Three clinics at $5M is a strong base. Are you looking at a practice nearby or in a new area?", "script_id": "s1"}';
    const d = await draftReply(rt, id, 'sam');
    expect(d).toMatchObject({ ai: true, script_id: 's1', note: null });
    const req = claude.calls.at(-1)!;
    expect(req.model).toBe('test-model');
    expect(JSON.stringify(req.messages)).toContain('What made you start looking?');
    expect(JSON.stringify(req.messages)).toContain('Clinic opener');
    expect(JSON.stringify(req.system)).toContain('seller rollover');
  });

  it('drops a draft that breaks the house rules', async () => {
    const { rt, id } = await setup({ ...BASE, ANTHROPIC_API_KEY: 'sk-test' });
    claude.reply = '{"text": "Book your free call now!!", "script_id": null}';
    const d = await draftReply(rt, id, 'sam');
    expect(d.ai).toBe(false);
    expect(draftProblems('We fund it with seller finance and a bank loan.')).toContain('funding without seller rollover');
  });

  it('the FAQ assistant stays off by default and, when on, says it is automated', async () => {
    const { db, rt, id } = await setup({ ...BASE, ANTHROPIC_API_KEY: 'sk-test', DM_AUTO_REPLY: 'on' });
    db.prepare("UPDATE dm_threads SET ai_flag = NULL").run();
    claude.reply = '{"answer": "The fee depends on the size of the business and is covered on the strategy call.", "faq_id": "faq1"}';
    const calls = stubGraph();
    const text = await maybeAutoReply(rt, id);
    expect(text?.startsWith(ASSISTANT_PREFIX)).toBe(true);
    expect(sent(calls)[0].body).not.toHaveProperty('tag');
    expect((db.prepare("SELECT sent_by FROM dm_messages WHERE direction = 'out'").get() as { sent_by: string }).sent_by).toBe('assistant');
    // Off by default: nothing is sent after an inbound message.
    const off = await setup({ ...BASE, ANTHROPIC_API_KEY: 'sk-test' });
    off.db.prepare('UPDATE dm_threads SET ai_checked_at = NULL').run();
    const before = claude.calls.length;
    const offCalls = stubGraph();
    const { afterInbound } = await import('../src/dm/ai');
    await afterInbound(off.rt, off.id);
    expect(sent(offCalls)).toHaveLength(0);
    expect(claude.calls.length).toBe(before + 1); // the junk / closing check only
  });

  it('pre-call summary from rules states only what they said', () => {
    const s = ruleSummary(['we do $2M revenue', 'not sure about the price', 'want to buy a competitor'], null);
    expect(s.revenue).toMatch(/1-3M \(stated in DMs\)/);
    expect(s.objections).toEqual(['Price']);
    expect(summaryText(s)).toMatch(/Pain points: Not mentioned in the thread/);
  });
});

// ───────────────────────────── Script analytics and the team ─────────────────────────────

describe('script analytics', () => {
  it('reply, booking and close rates per conversation, usage share, best vs worst', () => {
    const uses = [
      { script_id: 'A', thread_id: 't1', ts: 10 }, { script_id: 'A', thread_id: 't2', ts: 10 }, { script_id: 'A', thread_id: 't2', ts: 50 },
      { script_id: 'B', thread_id: 't3', ts: 10 },
    ];
    const inbound = new Map([['t1', [5, 20]], ['t2', [5]], ['t3', [30]]]);
    const status = new Map([['t1', 'closed'], ['t2', 'replied'], ['t3', 'booked']]);
    const [a, b] = scriptStats(uses, inbound, status);
    expect(a).toMatchObject({ script_id: 'A', uses: 3, threads: 2, replied: 1, booked: 1, closed: 1, reply_rate: 0.5, book_rate: 0.5, close_rate: 0.5, share: 0.75 });
    expect(b).toMatchObject({ script_id: 'B', threads: 1, replied: 1, booked: 1, closed: 0, reply_rate: 1, share: 0.25 });
    expect(bestAndWorst([a, b], 1)).toMatchObject({ best: { script_id: 'B' }, worst: { script_id: 'A' } });
    expect(bestAndWorst([a, b], 5)).toMatchObject({ best: null, worst: null });
  });

  it('reads from the database', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    db.prepare("INSERT INTO dm_scripts (id, title, body, category, created_at, updated_at) VALUES ('s1', 'Opener', 'Hi', 'opener', 1, 1)").run();
    db.prepare("INSERT INTO dm_threads (id, ig_user_id, status, created_at, updated_at) VALUES ('t1', '1', 'booked', 1, 1)").run();
    db.prepare("INSERT INTO dm_messages (id, thread_id, mid, direction, script_id, status, ts) VALUES ('a', 't1', 'a', 'out', 's1', 'sent', 10), ('b', 't1', 'b', 'in', NULL, 'received', 20)").run();
    const r = await scriptReport(rt);
    expect(r.rows[0]).toMatchObject({ title: 'Opener', reply_rate: 1, book_rate: 1, share: 1 });
  });
});

describe('manager dashboard and digest', () => {
  const now = Date.UTC(2026, 9, 31, 9, 30);
  const th = (o: Partial<DmThread>) => ({ id: 'x', name: null, username: 'u', band: 'cold', status: 'replied', ai_flag: null, last_in_at: null, last_out_at: null, window_hours: 24, follow_up_at: null, assignee_id: 'sam', ...o }) as DmThread;
  it('today’s tasks: hot waiting, window closing, follow-ups due', () => {
    const tasks = tasksFrom([
      th({ id: 'a', band: 'hot', last_in_at: now - 20 * 60_000, username: 'hot1' }),
      th({ id: 'b', band: 'warm', last_in_at: now - 22 * HOUR }),
      th({ id: 'c', follow_up_at: now + HOUR }),
      th({ id: 'd', band: 'hot', last_in_at: now - 60_000, ai_flag: 'junk' }),
      th({ id: 'e', band: 'hot', last_in_at: now - HOUR, last_out_at: now - 30 * 60_000 }),
    ], now, dayBounds(now, 'UTC').endToday);
    expect(tasks.map((t) => [t.thread_id, t.kind])).toEqual([['a', 'hot_waiting'], ['b', 'window_closing'], ['c', 'follow_up']]);
    expect(tasks[0].detail).toMatch(/Hot, waiting 20 min/);
  });
  it('day bounds follow the team time zone', () => {
    expect(dayBounds(now, 'UTC').startToday).toBe(Date.UTC(2026, 9, 31));
    expect(dayBounds(now, 'Australia/Adelaide').startToday).toBe(Date.UTC(2026, 9, 31) - 10.5 * HOUR); // 8pm Adelaide (UTC+10:30 in summer)
  });
  it('composes a setter digest from counted numbers', () => {
    const d = composeSetterDigest({ name: 'Sam' }, '2026-10-31', { conversations: 4, replies: 12, booked: 2, showed: 1, closed: 1, revenue: 40000 },
      [{ thread_id: 'a', who: '@hot1', kind: 'hot_waiting', detail: 'Hot, waiting 20 min', assignee_id: 'sam' }, { thread_id: 'c', who: '@fu', kind: 'follow_up', detail: 'Follow-up due today', assignee_id: 'sam' }], 'https://apply.test/admin#dminbox');
    expect(d.title).toBe('DM digest for Sam, 2026-10-31');
    expect(d.lines[0]).toContain('12 replies sent');
    expect(d.lines[0]).toContain('$40,000');
    expect(d.lines[1]).toContain('1 hot lead waiting · 1 follow-up due · 0 windows closing soon');
    expect(d.lines[2]).toBe('• @hot1: Hot, waiting 20 min');
    expect(d.text).not.toContain('*');
  });
});

// ───────────────────────────── Admin auth ─────────────────────────────

describe('admin auth on /admin/api/dm/*', () => {
  it('needs a signed-in session and same-origin writes', async () => {
    const { admin } = await import('../src/routes/admin');
    const db = freshDb();
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('settings', settingsOf(BASE)); c.set('reps', REPS); await next(); });
    app.route('/admin/api', admin);
    const env = { DB: d1(db), ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'secret' };
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
    expect((await app.request('https://apply.test/admin/api/dm/threads', {}, env, ctx as never)).status).toBe(401);
    expect((await app.request('https://apply.test/admin/api/dm/threads', { headers: { cookie: '_fa=forged.token' } }, env, ctx as never)).status).toBe(401);
    expect((await app.request('https://apply.test/admin/api/dm/bulk', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{"ids":["x"]}' }, env, ctx as never)).status).toBe(403);
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('admin-pw|pw'));
    const print = [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
    const token = await signToken('secret', `admin.${Math.floor(Date.now() / 1000) + 3600}.${print}.0`);
    const ok = await app.request('https://apply.test/admin/api/dm/threads', { headers: { cookie: `_fa=${token}` } }, env, ctx as never);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ threads: [] });
  });
});

// ───────────────────────────── Copy ─────────────────────────────

describe('fixed strings pass the copy rules', () => {
  it('settings help, notes, setup steps, window labels and the inbox page text', () => {
    const fixed = [
      ...SETTINGS.filter((s) => /^(IG_|DM_)/.test(s.key)).flatMap((s) => [s.label, 'help' in s ? s.help : '']),
      ASSISTANT_PREFIX, NO_KEY_NOTE, ...setupSteps({ origin: 'https://apply.test' } as Runtime),
      windowLabel(windowState({ last_in_at: null }, 0)), 'Window closed',
      summaryText(ruleSummary([], null)),
    ].filter(Boolean);
    for (const s of fixed) expect(auditCopy(String(s)), String(s)).toEqual([]);
    // Visible text in the inbox page: quoted strings that read as sentences.
    const js = fs.readFileSync(`${node.cwd()}/public/assets/dm-inbox.js`, 'utf8');
    const strings = [...js.matchAll(/'([A-Z][^'<>{}]{20,}?[.:]?)'/g)].map((m) => m[1]).filter((s) => / /.test(s) && !/[;=]|\bfunction\b/.test(s));
    expect(strings.length).toBeGreaterThan(10);
    for (const s of strings) {
      expect(auditCopy(s), s).toEqual([]);
      expect(s, s).not.toMatch(/—|!/);
    }
    expect(contactsIn('call me on +61 412 345 678')).toEqual({ email: null, phone: '61412345678' });
  });
});

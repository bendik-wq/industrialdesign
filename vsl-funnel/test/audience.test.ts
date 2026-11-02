import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy, auditFields } from '../src/content/copy-rules';
import { type Identity, type RoomState, apply, join, newEngage, newRoomState } from '../src/rooms/state';
import {
  AUDIENCE_COPY, ProofQueue, PROOF_STALE_MS, ReactionAgg, RX_LIMITS, audienceConfig, buyingSignals, dueNudges, enqueue, flagHot, isQuestion, mentionsHost, newCohost, personalLines,
  proofPreview, proofText, queueView, rulesDraft,
} from '../src/rooms/audience';
import { AudienceHub } from '../src/rooms/audience-do';
import { announceApplication, announcePurchase, checkoutStarted, personalFor, proofFor, saveConsent, setProofOn } from '../src/rooms/audience-db';
import { cleanCaption, transcribePiece, translateLine, validPiece, WHISPER } from '../src/rooms/captions';
import { audienceApi } from '../src/rooms/audience-routes';
import { createRoom, makeTicket } from '../src/rooms/rooms';
import { savePlan } from '../src/rooms/engage-db';
import { setClaudeTransport } from '../src/ops/claude';
import { SETTINGS as SETTING_DEFS } from '../src/settings';
import { Hono } from 'hono';
import type { AppEnv } from '../src/app';

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

const MIN = 60_000, DAY = 24 * 60 * MIN;
const T0 = Date.parse('2026-11-03T02:00:00Z');
let db: DatabaseSync;
let rt: Runtime;
const ALL = () => Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ''])) as Record<string, string>;
const makeRt = (s: Record<string, string> = {}, env: Record<string, unknown> = {}) => ({ env: { DB: d1(db), SESSION_SECRET: 'test-session-secret', ...env }, settings: { ...ALL(), SITE_NAME: 'G&L', ...s }, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a.map((v) => (v === undefined ? null : v)) as (string | number | null)[]));

function seedLead(id: string, o: { first?: string; city?: string | null; answers?: Record<string, unknown> } = {}) {
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, first_name, last_name, email, status, revenue_band, country, city, answers)
     VALUES (?, ?, ?, ?, ?, ?, 'Lee', ?, 'partial', '3m-10m', 'AU', ?, ?)`, id, `R${id}`, T0 - DAY, T0 - DAY, `v${id}`, o.first ?? 'Sam', `${id}@example.com`, o.city === undefined ? 'Perth' : o.city, JSON.stringify(o.answers ?? {}));
}
async function liveRoom(status: 'live' | 'scheduled' = 'live') {
  const room = await createRoom(rt, { mode: 'webinar', title: 'Buy your first competitor', refType: 'none', startsAt: T0 - 10 * MIN });
  x('UPDATE rooms SET status = ?, went_live_at = ? WHERE id = ?', status, status === 'live' ? T0 - 10 * MIN : null, room.id);
  return room;
}

/** audienceApi under a tiny app that sets the settings (as the real app's middleware does). */
function api(settings: Record<string, string> = {}) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('settings', { ...ALL(), ...settings } as never); await next(); });
  app.route('/', audienceApi);
  return (path: string, init: RequestInit, env: Record<string, unknown>) => app.request(path, init, env as never, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
});
afterEach(() => { vi.useRealTimers(); setClaudeTransport(null); });

// ───────────── a room state and the hub with a fake Durable Object around it ─────────────

const host: Identity = { id: 'hadmin', name: 'Josh', role: 'host' };
const ann: Identity = { id: 'rann', name: 'Ann Baker', role: 'attendee', leadId: 'l1', regId: 'r1' };
const bob: Identity = { id: 'rbob', name: 'Bob Chen', role: 'attendee', leadId: 'l2', regId: 'r2' };
function webinar(id = 'rmtest12345') {
  const st = newRoomState({ id, mode: 'webinar', title: 'Live', startsAt: T0, offerAvailable: true });
  st.eng = newEngage();
  for (const w of [host, ann, bob]) join(st, w, T0);
  st.status = 'live'; st.wentLiveAt = T0 - 10 * MIN;
  return st;
}
function hubFor(st: RoomState, r: Runtime = rt) {
  const sent: { to: string; msg: Record<string, unknown> }[] = [];
  const store = new Map<string, unknown>();
  const jobs: Promise<unknown>[] = [];
  const hub = new AudienceHub({
    st: () => st, deliver: (to, msg) => sent.push({ to, msg }), runtime: async () => r,
    storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); } } as unknown as DurableObjectStorage,
    waitUntil: (p) => { jobs.push(p); }, commit: async () => {},
  });
  const settle = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); await new Promise((res) => setTimeout(res, 450)); while (jobs.length) await Promise.all(jobs.splice(0)); };
  return { hub, sent, settle, of: (t: string) => sent.filter((s) => s.msg.t === t) };
}

// ───────────── reactions ─────────────

describe('reactions: per-person limits and one message a second', () => {
  it('limits taps per person (gap, then a window) and counts batched taps only up to the window', () => {
    const a = new ReactionAgg();
    expect(a.add('p1', 'clap', T0)).toEqual({ ok: true, n: 1 });
    expect(a.add('p1', 'clap', T0 + 100)).toEqual({ ok: false, error: 'too_fast' });
    expect(a.add('p1', 'fireworks', T0 + 1000)).toEqual({ ok: false, error: 'bad_value' });
    expect(a.add('p1', 'heart', T0 + 400, 4)).toEqual({ ok: true, n: 4 });
    expect(a.add('p1', 'heart', T0 + 800, 4)).toEqual({ ok: true, n: 3 }); // 8 per five seconds
    expect(a.add('p1', 'heart', T0 + 1200)).toEqual({ ok: false, error: 'rx_limit' });
    expect(a.add('p1', 'heart', T0 + RX_LIMITS.windowMs + 1)).toMatchObject({ ok: true });
    expect(a.add('p1', 'yes', T0 + RX_LIMITS.windowMs + 400, 99)).toEqual({ ok: true, n: 4 }); // never more than 4 in one message
  });
  it('aggregates everyone into one total per flush, and keeps the pulse', () => {
    const a = new ReactionAgg();
    for (let i = 0; i < 1000; i++) a.add(`p${i}`, i % 3 ? 'clap' : 'heart', T0);
    const f = a.flush(T0 + 1000)!;
    expect(f.n).toBe(1000);
    expect(f.counts).toEqual({ clap: 666, heart: 334 });
    expect(a.flush(T0 + 2000)).toBeNull();
    const s = a.series(T0 + 2000, 6);
    expect(s).toHaveLength(6);
    expect(s.reduce((n, b) => n + b.n, 0)).toBe(1000);
    expect(a.minutes()).toEqual([{ minute: Math.floor((T0 + 1000) / 60_000), n: 1000, k: { clap: 666, heart: 334 } }]);
  });
  it('the room sends a thousand reactions as one message, staff get the pulse, and nothing before Go live', async () => {
    const st = webinar();
    for (let i = 0; i < 1000; i++) join(st, { id: `a${i}`, name: `A ${i}`, role: 'attendee' }, T0);
    const { hub, of } = hubFor(st);
    for (let i = 0; i < 1000; i++) expect(await hub.onMessage(`a${i}`, { t: 'react', kind: 'clap' }, T0)).toBeNull();
    expect(await hub.onMessage('a1', { t: 'react', kind: 'clap' }, T0 + 50)).toBeNull(); // too fast: silently ignored
    hub.flush(T0 + 1000);
    expect(of('rx')).toHaveLength(1);
    expect(of('rx')[0]).toMatchObject({ to: 'all', msg: { c: { clap: 1000 }, n: 1000 } });
    expect(of('rx_pulse').map((s) => s.to)).toEqual(['hadmin']);
    const lobby = webinar(); lobby.status = 'lobby';
    const h2 = hubFor(lobby);
    await h2.hub.onMessage('rann', { t: 'react', kind: 'clap' }, T0);
    h2.hub.flush(T0 + 1000);
    expect(h2.of('rx')).toHaveLength(0);
  });
});

// ───────────── captions ─────────────

function wav(bytes = 32_000) {
  const b = new Uint8Array(bytes);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
  return b.buffer;
}
describe('captions: Whisper on the host’s audio, kept for the transcript, translated once per line', () => {
  it('cleans Whisper output and refuses audio that isn’t a WAV piece', () => {
    expect(cleanCaption('  Thank you. ')).toBe('');
    expect(cleanCaption('[music] The 1.5x test decides it (laughs)')).toBe('The 1.5x test decides it');
    expect(validPiece(wav())).toBe(true);
    expect(validPiece(new Uint8Array(32_000).buffer)).toBe(false);
    expect(validPiece(wav(1000))).toBe(false);
  });
  it('transcribes with large-v3-turbo (voice filter, the previous line as context), falling back to whisper', async () => {
    const calls: { model: string; input: Record<string, unknown> }[] = [];
    const ai = { run: async (model: string, input: unknown) => { calls.push({ model, input: input as Record<string, unknown> }); return { text: ' Seller finance closes the gap. ', transcription_info: { language: 'en' } }; } };
    expect(await transcribePiece(ai, wav(), { prompt: 'Previous line' })).toEqual({ text: 'Seller finance closes the gap.', lang: 'en' });
    expect(calls[0].model).toBe(WHISPER);
    expect(calls[0].input).toMatchObject({ vad_filter: true });
    expect(String(calls[0].input.initial_prompt)).toContain('Previous line');
    expect(typeof calls[0].input.audio).toBe('string');
    const flaky = { run: async (model: string) => { if (model === WHISPER) throw new Error('unavailable'); return { text: 'Fallback line' }; } };
    expect((await transcribePiece(flaky, wav())).text).toBe('Fallback line');
  });
  it('the route: staff only, stores t_ms from Go live in room_captions, tells the room, and keeps backstage pieces out', async () => {
    const room = await liveRoom();
    const told: Record<string, unknown>[] = [];
    let live = true;
    const ROOMS = { idFromName: (n: string) => n, get: () => ({ fetch: async (req: Request) => {
      const u = new URL(req.url);
      if (u.pathname === '/audience/cap-ready') return Response.json({ ok: true, live, wentLiveAt: T0 - 10 * MIN });
      told.push(await req.json() as Record<string, unknown>);
      return Response.json({ ok: true });
    } }) };
    const AI = { run: vi.fn(async () => ({ text: 'Agree the shape with the seller first.' })) };
    const env = { DB: d1(db), SESSION_SECRET: 'test-session-secret', ROOMS, AI };
    rt = makeRt({}, { ROOMS, AI });
    const hostT = await makeTicket(rt, room.id, host);
    const annT = await makeTicket(rt, room.id, ann);
    const call = api();
    const post = (t: string, start: number, c = call) => c(`/${room.id}/captions?t=${encodeURIComponent(t)}&start=${start}`, { method: 'POST', body: wav(), headers: { 'content-type': 'audio/wav' } }, env);
    expect((await post(annT, T0)).status).toBe(403);
    const r = await post(hostT, T0 - 5 * MIN);
    expect(await r.json()).toMatchObject({ ok: true, text: 'Agree the shape with the seller first.', kept: true });
    expect(q('SELECT room_id, t_ms, text, lang FROM room_captions')).toEqual([{ room_id: room.id, t_ms: 5 * MIN, text: 'Agree the shape with the seller first.', lang: 'en' }]);
    expect(told[0]).toMatchObject({ text: 'Agree the shape with the seller first.', t_ms: 5 * MIN, by: 'hadmin' });
    live = false;
    expect(await (await post(hostT, T0)).json()).toMatchObject({ ok: true, kept: false });
    expect(q('SELECT * FROM room_captions')).toHaveLength(1);
    expect((await post(hostT, T0, api({ ROOM_CAPTIONS: 'off' }))).status).toBe(403);
    expect(AI.run).toHaveBeenCalledTimes(2);
  });
  it('translates a line once per language (cached) and sends each viewer their own language', async () => {
    const AI = { run: vi.fn(async (_m: string, input: unknown) => ({ translated_text: `[${(input as { target_lang: string }).target_lang}] ${(input as { text: string }).text}` })) };
    rt = makeRt({}, { AI });
    const line = { t_ms: 1000, text: 'Buy the competitor.', lang: 'en' };
    expect(await translateLine(rt as never, 'rmtest12345', line, 'es')).toBe('[es] Buy the competitor.');
    expect(await translateLine(rt as never, 'rmtest12345', line, 'es')).toBe('[es] Buy the competitor.');
    expect(await translateLine(rt as never, 'rmtest12345', line, 'en')).toBe('Buy the competitor.');
    expect(AI.run).toHaveBeenCalledTimes(1);
    const st = webinar();
    const { hub, of } = hubFor(st, rt);
    await hub.onMessage('rann', { t: 'cap_lang', lang: 'fr' }, T0);
    await hub.onMessage('rbob', { t: 'cap_lang', lang: 'xx' }, T0); // not offered: stays as spoken
    await hub.caption({ text: 'The 1.5x test.', t_ms: 2000, lang: 'en', by: 'hadmin', name: 'Josh' }, T0);
    expect(of('cap_state')[0].msg).toMatchObject({ on: true, by: 'Josh' });
    expect(of('cap')[0]).toMatchObject({ to: 'all', msg: { text: 'The 1.5x test.' } });
    expect(of('cap_tr')).toEqual([{ to: 'rann', msg: expect.objectContaining({ lang: 'fr', text: '[fr] The 1.5x test.' }) }]);
    // Captions switch off by themselves when the captioner goes quiet for good (no fake "captions on").
    await hub.tick(T0 + 2 * MIN);
    expect(of('cap_state').at(-1)!.msg).toMatchObject({ on: false });
  });
  it('only staff turn captions on, and only when the setting allows them', async () => {
    const st = webinar();
    const { hub } = hubFor(st);
    expect(await hub.onMessage('rann', { t: 'cap_on' }, T0)).toBe('forbidden');
    expect(await hub.onMessage('hadmin', { t: 'cap_on' }, T0)).toBeNull();
    const h2 = hubFor(webinar(), makeRt({ ROOM_CAPTIONS: 'off' }));
    expect(await h2.hub.onMessage('hadmin', { t: 'cap_on' }, T0)).toBe('cap_off');
  });
});

// ───────────── the co-host: questions and buying signals ─────────────

describe('the AI co-host: buying signals, clusters, drafts a person sends', () => {
  it('flags real buying signals and leaves ordinary chat alone', () => {
    expect(buyingSignals('How much is the deposit?')).toEqual(['price', 'pay']);
    expect(buyingSignals('how do I start with Josh’s team')).toEqual(['start']);
    expect(buyingSignals('Can I pay in two instalments')).toEqual(['pay']);
    expect(buyingSignals("I'm in, where's the link")).toEqual(['ready']);
    expect(buyingSignals('Great point about the seller')).toEqual([]);
    expect(buyingSignals('I priced my house last year')).toEqual([]);
    expect(mentionsHost('@host can you go back a slide')).toBe(true);
    expect(mentionsHost('email me at sam@host.com')).toBe(false);
    expect(isQuestion('Does seller finance work in Australia?')).toBe(true);
    expect(isQuestion('Thanks Josh')).toBe(false);
  });
  it('clusters repeated questions by meaning words, counts the people, keeps first names only', () => {
    const c = newCohost();
    const a = enqueue(c, { kind: 'question', text: 'Does seller finance work in Australia?', who: 'p1', name: 'Sam Lee' }, T0);
    const b = enqueue(c, { kind: 'question', text: 'does seller finance work in australia too', who: 'p2', name: 'Priya Shah' }, T0 + 1);
    const d = enqueue(c, { kind: 'question', text: 'What size business should I target first?', who: 'p3', name: 'Tom' }, T0 + 2);
    expect(a.fresh).toBe(true); expect(b.fresh).toBe(false); expect(d.fresh).toBe(true);
    enqueue(c, { kind: 'prebuy', text: 'Does seller finance work in Australia for clinics?', who: 'p4', name: 'Mia Wong' }, T0 + 3);
    const v = queueView(c);
    expect(v[0]).toMatchObject({ kind: 'prebuy', count: 3, names: ['Sam', 'Priya', 'Mia'] });
    expect(JSON.stringify(v)).not.toMatch(/Lee|Shah|Wong/);
    const h = flagHot(c, { who: 'p1', name: 'Sam Lee', text: 'how much is it', signals: ['price'] }, T0);
    flagHot(c, { who: 'p1', name: 'Sam Lee', text: 'can I pay by card', signals: ['pay'] }, T0 + 5);
    expect(h).toMatchObject({ first: 'Sam', signals: ['price', 'pay'], count: 2, text: 'can I pay by card' });
  });
  it('drafts from the knowledge base without a model', () => {
    const r = rulesDraft('How long does the First Deal Sprint run?', [{ title: 'First Deal Sprint: what is delivered', text: 'The First Deal Sprint runs for 7 days. Day 1: your capacity. The weather is irrelevant here.' }]);
    expect(r).toEqual({ text: 'The First Deal Sprint runs for 7 days.', sources: ['First Deal Sprint: what is delivered'] });
    expect(rulesDraft('anything', [])).toBeNull();
    // Never the team's internal scripts, and never a stage direction.
    expect(rulesDraft('What does the deposit cost?', [{ title: 'Material deck', internal: true, text: 'The deposit costs [SLIDE: price] five thousand dollars tonight.' } as never, { title: 'Engagement deposit terms', text: 'The engagement deposit [ON SCREEN: terms] is credited in full against the engagement fee.' }])).toEqual({ text: 'The engagement deposit is credited in full against the engagement fee.', sources: ['Engagement deposit terms'] });
  });
  it('in the room: chat and Q&A feed the private queue and hot list; a person sends the answer, labelled', async () => {
    const st = webinar();
    const { hub, of, settle } = hubFor(st);
    const ok = (who: string, msg: Record<string, unknown>) => { expect(apply(st, who, msg, T0).ok).toBe(true); return hub.afterApply(who, msg, T0); };
    await ok('rann', { t: 'chat', text: 'How much is the deposit and can I pay by card?' });
    await ok('rbob', { t: 'ask', text: 'Does seller finance work in Australia?' });
    await settle();
    const v = of('cohost').at(-1)!;
    expect(v.to).toBe('hadmin'); // staff only
    expect(of('cohost').every((s) => s.to === 'hadmin')).toBe(true);
    const hot = v.msg.hot as { first: string; signals: string[] }[];
    expect(hot[0]).toMatchObject({ first: 'Ann', signals: ['price', 'pay'] });
    const queue = v.msg.queue as { id: number; text: string; draft: unknown }[];
    const qa = queue.find((x) => /Australia/.test(x.text))!;
    expect(v.msg.ai).toBe(false);
    // An attendee can't send answers; the host can, and the answer says who it's from.
    expect(await hub.onMessage('rann', { t: 'cohost_send', id: qa.id, text: 'x' }, T0)).toBe('forbidden');
    expect(await hub.onMessage('hadmin', { t: 'cohost_send', id: qa.id, text: 'Yes. Seller finance is used in Australia and the US.', mode: 'room' }, T0)).toBeNull();
    const chat = of('chat').at(-1)!.msg.m as { label: string; by: string; text: string };
    expect(chat).toMatchObject({ by: 'hadmin', label: AUDIENCE_COPY.teamAnswer });
    expect(of('team_answer')[0]).toMatchObject({ to: 'rbob', msg: { label: AUDIENCE_COPY.teamAnswer } });
    expect(st.qa.find((x) => /Australia/.test(x.text))!.answered).toBe(true);
    expect(await hub.onMessage('hadmin', { t: 'cohost_send', id: qa.id, text: 'again' }, T0)).toBe('not_found');
  });
  it('a question before buying goes to the team’s queue and the hot list, and the answer goes to that person only', async () => {
    const st = webinar();
    const { hub, of, settle } = hubFor(st);
    expect(await hub.onMessage('rann', { t: 'prebuy_q', text: 'Is the deposit refundable if my lender says no?' }, T0)).toBeNull();
    await settle();
    const v = of('cohost').at(-1)!.msg;
    const item = (v.queue as { id: number; kind: string }[])[0];
    expect(item.kind).toBe('prebuy');
    expect((v.hot as { signals: string[] }[])[0].signals).toContain('prebuy');
    await hub.onMessage('hadmin', { t: 'cohost_send', id: item.id, text: 'The deposit terms are in the offer card.', mode: 'private' }, T0);
    expect(of('chat')).toHaveLength(0);
    expect(of('team_answer').map((s) => s.to)).toEqual(['rann']);
  });
  it('with a key: Claude drafts; automatic answers only when switched on, labelled, and never about money', async () => {
    setClaudeTransport(async () => JSON.stringify({ answer: 'We work with owners in the US and Australia.', citations: ['S1'], confidence: 0.9, needs_human: false }));
    const st = webinar();
    const { hub, of, settle } = hubFor(st, makeRt({ ROOM_COHOST_AUTO: 'on' }));
    await hub.onMessage('rann', { t: 'prebuy_q', text: 'What does the engagement cost?' }, T0);
    apply(st, 'rbob', { t: 'ask', text: 'Do you work with owners in Australia?' }, T0);
    await hub.afterApply('rbob', { t: 'ask' }, T0);
    await settle();
    const auto = of('chat').map((s) => s.msg.m as { label: string; text: string });
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({ label: AUDIENCE_COPY.autoAnswer, text: 'We work with owners in the US and Australia.' });
    const queue = of('cohost').at(-1)!.msg.queue as { kind: string; status: string; draft: { by: string } }[];
    expect(queue.find((x) => x.kind === 'prebuy')).toMatchObject({ status: 'open', draft: { by: 'ai' } });
  });
});

// ───────────── social proof: consent first ─────────────

describe('purchase announcements: only with consent, first name and city, once, rate-limited', () => {
  it('the sentence needs consent and a usable first name', () => {
    const c = { first_name: 'Samantha Jones', city: 'Perth', show_city: 1, consent_at: T0, withdrawn_at: null };
    expect(proofText('sprint', c)).toBe('Samantha from Perth just joined the First Deal Sprint.');
    expect(proofText('deposit', { ...c, show_city: 0 })).toBe('Samantha just secured an engagement place.');
    expect(proofText('sprint', { ...c, withdrawn_at: T0 })).toBeNull();
    expect(proofText('sprint', null)).toBeNull();
    expect(proofText('sprint', { ...c, first_name: '' })).toBeNull();
    expect(proofPreview('Sam', 'Perth', true)).toBe('Sam from Perth');
  });
  it('a purchase is announced only for a buyer who ticked the box, while the room is live with announcements on, once', async () => {
    const room = await liveRoom();
    seedLead('l1'); seedLead('l2', { first: 'Kai' });
    const sam = { id: 'rsam', name: 'Sam Lee', leadId: 'l1' };
    // No consent: nothing, even with announcements on.
    await setProofOn(rt, room.id, true);
    expect(await proofFor(rt, { leadId: 'l2', kind: 'sprint' })).toBeNull();
    // Consent, announcements off (the default): nothing.
    await saveConsent(rt, room.id, sam, { on: true, showCity: true });
    await setProofOn(rt, room.id, false);
    expect(await proofFor(rt, { leadId: 'l1', kind: 'sprint' })).toBeNull();
    await setProofOn(rt, room.id, true);
    const told: unknown[] = [];
    const ROOMS = { idFromName: (n: string) => n, get: () => ({ fetch: async (req: Request) => { told.push(await req.json()); return Response.json({ ok: true }); } }) };
    rt = makeRt({}, { ROOMS });
    expect(await announcePurchase(rt, { id: 'wp1', kind: 'offer', lead_id: 'l1' })).toEqual({ roomId: room.id, text: 'Sam from Perth just joined the First Deal Sprint.' });
    expect(told).toEqual([{ text: 'Sam from Perth just joined the First Deal Sprint.' }]);
    // Once per buyer and kind.
    expect(await announcePurchase(rt, { id: 'wp2', kind: 'offer', lead_id: 'l1' })).toBeNull();
    // The application is its own kind; an untick before paying stops everything after it.
    expect((await announceApplication(rt, room.id, 'l1'))!.text).toBe('Sam from Perth just sent an application.');
    await saveConsent(rt, room.id, sam, { on: false, showCity: true });
    expect(await announcePurchase(rt, { id: 'wp3', kind: 'deposit', lead_id: 'l1' })).toBeNull();
    // A room that isn't live announces nothing.
    const later = await liveRoom('scheduled');
    await saveConsent(rt, later.id, { id: 'rkai', name: 'Kai', leadId: 'l2' }, { on: true, showCity: false });
    await setProofOn(rt, later.id, true);
    expect(await proofFor(rt, { leadId: 'l2', kind: 'deposit' })).toBeNull();
    expect(q('SELECT kind FROM room_proof_events ORDER BY kind')).toEqual([{ kind: 'application' }, { kind: 'sprint' }]);
  });
  it('the room spaces announcements out and drops any that would no longer be "just"', () => {
    const p = new ProofQueue(90_000);
    p.push('A', T0); p.push('B', T0 + 1);
    expect(p.next(T0)).toEqual({ text: 'A', wait: 90_000 });
    expect(p.next(T0 + 30_000)).toEqual({ text: null, wait: 60_000 });
    expect(p.next(T0 + 90_000).text).toBe('B');
    p.push('C', T0 + 100_000);
    expect(p.next(T0 + 100_000 + PROOF_STALE_MS + 1)).toEqual({ text: null, wait: null });
  });
  it('the consent API is the attendee’s own, needs their lead, and staff can’t tick it for them', async () => {
    const room = await liveRoom();
    seedLead('l1');
    const env = { DB: d1(db), SESSION_SECRET: 'test-session-secret' };
    const t = await makeTicket(rt, room.id, { id: 'rsam', name: 'Sam Lee', role: 'attendee', leadId: 'l1' });
    const ht = await makeTicket(rt, room.id, host);
    const call = (tk: string, body: Record<string, unknown>) => api()(`/${room.id}/audience/consent`, { method: 'POST', body: JSON.stringify({ t: tk, ...body }), headers: { 'content-type': 'application/json' } }, env);
    expect((await call(ht, { on: true })).status).toBe(403);
    expect(await (await call(t, { on: true, showCity: false })).json()).toEqual({ ok: true, on: true, showCity: false });
    expect(q('SELECT who, first_name, city, show_city FROM room_proof_consent')).toEqual([{ who: 'rsam', first_name: 'Sam', city: 'Perth', show_city: 0 }]);
  });
});

// ───────────── personal offer moments ─────────────

describe('personal offer moments: the card echoes the attendee’s own data', () => {
  it('uses the Deal Plan and application they really filled in, nothing invented', async () => {
    const room = await liveRoom();
    seedLead('l1', { answers: { business: 'Commercial HVAC services', revenue: '3_10m', why_now: 'We plateaued at $4M and want to buy the competitor across town.' } });
    const who = { id: 'rsam', name: 'Sam Lee', leadId: 'l1' };
    await savePlan(rt, room, who, { industry: 'commercial HVAC', size: '$2M to $5M revenue', geography: 'Perth metro', cash_flow: '$900K', debt_service: '$550K', owners_per_week: '25' });
    const me = await personalFor(rt, room, who);
    const by = Object.fromEntries(me.lines.map((l) => [l.key, l.text]));
    expect(by.buybox).toBe('commercial HVAC, $2M to $5M revenue, Perth metro');
    expect(by.coverage).toBe('1.64x on the numbers you entered, which passes.');
    expect(by.outreach).toBe('25 owners a week');
    expect(by.business).toMatch(/^Commercial HVAC services, \$3/);
    expect(by.why).toBe('We plateaued at $4M and want to buy the competitor across town.');
    expect(me.preview).toEqual({ withCity: 'Sam from Perth', withoutCity: 'Sam', hasCity: true });
    expect(me.consent).toEqual({ on: false, showCity: true });
    // Someone who entered nothing gets no lines (the card shows how to make it theirs instead).
    seedLead('l9', { city: null });
    const empty = await personalFor(rt, room, { id: 'rnone', name: 'Kai', leadId: 'l9' });
    expect(empty.lines).toEqual([]);
    expect(personalLines({ plan: null, app: null })).toEqual([]);
    expect(personalLines({ plan: { industry: '', size: '', geography: '', owners_per_week: '', cash_flow: '$600K', debt_service: '$500K', action_1: '', action_2: '', action_3: '' }, app: null })[0].text)
      .toBe('1.20x on the numbers you entered. Payments up to $400,000 a year pass at that cash flow.');
  });
});

// ───────────── the abandoned-checkout nudge ─────────────

describe('the abandoned-checkout nudge: once, real, only while they are here', () => {
  it('picks rows that are old enough, never nudged, unpaid and present', () => {
    const rows = [
      { who: 'a', kind: 'deposit' as const, lead_id: 'l1', started_at: T0 - 11 * MIN, nudged_at: null },
      { who: 'b', kind: 'deposit' as const, lead_id: 'l2', started_at: T0 - 5 * MIN, nudged_at: null },
      { who: 'c', kind: 'sprint' as const, lead_id: 'l3', started_at: T0 - 20 * MIN, nudged_at: T0 - MIN },
      { who: 'd', kind: 'sprint' as const, lead_id: 'l4', started_at: T0 - 20 * MIN, nudged_at: null },
      { who: 'e', kind: 'sprint' as const, lead_id: 'l5', started_at: T0 - 20 * MIN, nudged_at: null },
    ];
    const due = dueNudges(rows, { now: T0, minutes: 10, here: new Set(['a', 'b', 'c', 'd']), paid: (r) => r.who === 'd' });
    expect(due.map((r) => r.who)).toEqual(['a']);
  });
  it('the room nudges an unpaid checkout once, and never one that was paid', async () => {
    const st = webinar('rmnudge1234');
    x("INSERT INTO rooms (id, mode, title, ref_type, status, created_at, updated_at) VALUES ('rmnudge1234', 'webinar', 'Live', 'none', 'live', 0, 0)");
    const { hub, of } = hubFor(st);
    await hub.onMessage('rann', { t: 'checkout', kind: 'deposit' }, T0);
    await hub.onMessage('rann', { t: 'checkout', kind: 'deposit' }, T0 + 5 * MIN); // the first start counts
    await hub.onMessage('rbob', { t: 'checkout', kind: 'sprint' }, T0);
    expect(await hub.onMessage('hadmin', { t: 'checkout', kind: 'deposit' }, T0)).toBeNull();
    expect(q('SELECT who FROM room_checkouts ORDER BY who')).toEqual([{ who: 'rann' }, { who: 'rbob' }]);
    // Bob paid for real.
    x("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES ('wp1', 'r2', 'l2', 'offer', 'paid', 300000, 'usd', ?, ?, ?)", T0 + MIN, T0, T0);
    await hub.tick(T0 + 9 * MIN);
    expect(of('nudge')).toHaveLength(0);
    await hub.tick(T0 + 10 * MIN);
    expect(of('nudge')).toEqual([{ to: 'rann', msg: { t: 'nudge', kind: 'deposit', offerOpen: false } }]);
    await hub.tick(T0 + 30 * MIN);
    expect(of('nudge')).toHaveLength(1);
    // Off by setting.
    expect(audienceConfig({ ROOM_CHECKOUT_NUDGE_MIN: 'off' }).nudgeMin).toBe(0);
    await checkoutStarted(rt, 'rmnudge1234', { id: 'rzed', leadId: null }, 'sprint', T0);
  });
});

// ───────────── chat threads ─────────────

describe('chat threads', () => {
  it('a reply keeps the message it answers, and only one that exists', () => {
    const st = webinar();
    apply(st, 'rann', { t: 'chat', text: 'Does this work for clinics?' }, T0);
    const first = st.chat.msgs[0].id;
    apply(st, 'rbob', { t: 'chat', text: 'Same question here', re: first }, T0 + 2000);
    apply(st, 'rbob', { t: 'chat', text: 'And this one', re: 999 }, T0 + 4000);
    expect(st.chat.msgs.map((m) => m.re ?? null)).toEqual([null, first, null]);
  });
});

// ───────────── copy ─────────────

describe('copy audit', () => {
  it('every audience string passes the house rules', () => {
    expect(auditFields(AUDIENCE_COPY)).toEqual([]);
    const sample = (v: unknown): string[] => (typeof v === 'string' ? [v] : typeof v === 'function' ? [String((v as (a: string, b: string) => unknown)('Sam', '$400,000'))] : Array.isArray(v) ? v.flatMap(sample) : v && typeof v === 'object' ? Object.values(v).flatMap(sample) : []);
    for (const s of sample(AUDIENCE_COPY)) {
      expect(auditCopy(s), s).toEqual([]);
      expect(s, s).not.toMatch(/[—!]/);
      expect(s, s).not.toMatch(/\p{Extended_Pictographic}/u);
    }
    for (const k of ['deposit', 'sprint', 'application'] as const) expect(proofText(k, { first_name: 'Sam', city: 'Perth', show_city: 1, consent_at: T0, withdrawn_at: null })).toMatch(/^Sam from Perth just /);
  });
  it('the notice and the labels say what is machine-made', () => {
    expect(AUDIENCE_COPY.ccNotice).toMatch(/machine/);
    expect(AUDIENCE_COPY.ccMachine).toMatch(/machine-generated/);
    expect(AUDIENCE_COPY.autoAnswer).toMatch(/AI/);
    expect(AUDIENCE_COPY.teamAnswer).toBe('Answered by the team');
  });
  it('the browser file is wired to the room page', () => {
    const js = fs.readFileSync(`${node.cwd()}/public/assets/room-audience.js`, 'utf8');
    const routes = fs.readFileSync(`${node.cwd()}/src/rooms/routes.ts`, 'utf8');
    expect(routes).toContain('/assets/room-audience.js');
    expect(js).toContain("R.on('msg'");
    expect(js).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

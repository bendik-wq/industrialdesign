import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv, Runtime } from '../src/app';
import { login } from '../src/admin/auth';
import { auditCopy } from '../src/content/copy-rules';
import {
  ANTHROPIC_DIRECT, DEFAULT_CF_ACCOUNT, anthropicClient, featureTag, gatewayFetch, gatewayInfo, runWorkersAi, shouldFallBack, workersAiGateway,
} from '../src/infra/ai-gateway';
import { setClaudeTransport } from '../src/ops/claude';
import { createRoom, makeTicket } from '../src/rooms/rooms';
import { roomsApi } from '../src/rooms/routes';
import { SETTINGS } from '../src/settings';
import { vectorsAdmin } from '../src/vectors/admin';
import {
  DIMS, NOT_HERE, OFF_NOTE, type VecIndex, cosine, leadText, meanVector, normalize, setVectorTestDoubles, sha256, unavailable, vecId,
} from '../src/vectors/core';
import { SOURCES, indexTick, restartPasses } from '../src/vectors/indexer';
import { DRAFT_MAX, HELPER_COPY, HELPER_SYSTEM, draftRoomAnswer, fitChat, speaksAsJosh } from '../src/vectors/room-helper';
import { buyerLookalikes, retrieveDocs, semanticSearch, similarLeads } from '../src/vectors/search';

// ───────────── a real SQLite database shaped like D1, every migration applied (same shim as ops.test.ts) ─────────────
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
const ON = { VECTOR_SEARCH: 'on' };
const makeRt = (db: DatabaseSync, settings: Record<string, string> = ON, env: Record<string, unknown> = {}) =>
  ({ env: { DB: d1(db), SESSION_SECRET: 'test-session-secret', ...env }, settings: { ...BASE, ...settings }, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;

// ───────────── a fake Vectorize index and a fake embedder ─────────────

type V = { id: string; values: number[]; namespace?: string; metadata?: Record<string, unknown> };
class FakeIndex implements VecIndex {
  store = new Map<string, V>();
  calls: string[] = [];
  async upsert(vs: V[]) { this.calls.push(`upsert:${vs.length}`); for (const v of vs) { expect(v.values).toHaveLength(DIMS); expect(new TextEncoder().encode(v.id).length).toBeLessThanOrEqual(64); this.store.set(v.id, { ...v, values: [...v.values] }); } return { mutationId: 'm' }; }
  async query(values: number[], o: { topK?: number; namespace?: string }) {
    this.calls.push(`query:${o.namespace}`);
    const matches = [...this.store.values()].filter((v) => !o.namespace || v.namespace === o.namespace)
      .map((v) => ({ id: v.id, score: cosine(values, v.values), metadata: v.metadata }))
      .sort((a, b) => b.score - a.score).slice(0, o.topK ?? 5);
    return { matches, count: matches.length };
  }
  async getByIds(ids: string[]) { this.calls.push(`get:${ids.length}`); expect(ids.length).toBeLessThanOrEqual(20); return ids.map((id) => this.store.get(id)).filter((v): v is V => Boolean(v)); }
  async deleteByIds(ids: string[]) { this.calls.push(`delete:${ids.length}`); for (const id of ids) this.store.delete(id); return { mutationId: 'd' }; }
}
/** Bag of words hashed into 768 dims: texts that share words point the same way. */
function fakeVec(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
    let h = 2166136261;
    for (const ch of w.slice(0, 6)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % DIMS] += 1;
  }
  v[DIMS - 1] += 0.01; // never all zero
  return v;
}
let embedded: string[] = [];
const fakeEmbed = async (texts: string[]) => { embedded.push(...texts); return texts.map(fakeVec); };

// ───────────── seed data ─────────────

const NOW = Date.parse('2026-11-03T00:00:00Z');
const MIN = 60_000;
let seq = 0;
function lead(db: DatabaseSync, o: { business: string; revenue?: string; status?: string; notes?: string | null; email?: string; first?: string }) {
  const id = `lead_${++seq}`;
  const answers = JSON.stringify({ business: o.business, role: 'owner', revenue: o.revenue ?? '3_10m' });
  db.prepare(`INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, phone, answers, status, tier, revenue_band, notes)
              VALUES (?, ?, ?, ?, ?, 'Smith', ?, '+61400111222', ?, ?, 'A', '1m-5m', ?)`)
    .run(id, `R${seq}`, NOW - 86_400_000, NOW - 86_400_000, o.first ?? 'Ann', o.email ?? `${id}@example.com`, answers, o.status ?? 'applied', o.notes ?? null);
  return id;
}
function question(db: DatabaseSync, room: string, ref: string, text: string, leadId: string | null = null, qtype = 'financing') {
  db.prepare('INSERT INTO room_objections (room_id, ref, item_id, who, lead_id, qtype, source, text, at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)').run(room, ref, `w${ref}`, leadId, qtype, 'question', text, NOW);
}
const LEADS_ONLY = SOURCES.filter((s) => s.name === 'leads');

let db: DatabaseSync;
let idx: FakeIndex;
beforeEach(() => {
  db = freshDb();
  idx = new FakeIndex();
  embedded = [];
  setVectorTestDoubles({ index: idx, embed: fakeEmbed });
});
afterEach(() => { setVectorTestDoubles({ index: null, embed: null }); setClaudeTransport(null); vi.unstubAllGlobals(); });

// ───────────── core ─────────────

describe('vector ids, text and maths', () => {
  it('ids carry their namespace and long refs are hashed to fit 64 bytes', async () => {
    expect(await vecId('lead', 'lead_1')).toBe('lead:lead_1');
    const long = await vecId('q', `room_${'x'.repeat(60)}|qa:123`);
    expect(long.startsWith('q:h')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(await vecId('q', `room_${'x'.repeat(60)}|qa:123`)).toBe(long); // stable
    expect(await sha256('a')).toBe(await sha256('a'));
    expect(await sha256('a')).not.toBe(await sha256('b'));
  });
  it('a lead is embedded from labelled answers, never their name, email or phone', () => {
    const t = leadText({ answers: JSON.stringify({ contact: { email: 'x@y.com' }, business: 'Commercial HVAC, 25 staff', revenue: '3_10m' }), industry: 'HVAC', revenue_band: '1m-5m', booking_answers: JSON.stringify([{ q: 'Anything else?', a: 'Need a lender' }]) });
    expect(t).toContain('Commercial HVAC, 25 staff');
    expect(t).toContain('$3M – $10M'); // the option label, not the code
    expect(t).toContain('Need a lender');
    expect(t).not.toMatch(/x@y\.com|@/);
  });
  it('the buyer centroid weighs each buyer once and is unit length', () => {
    const m = meanVector([[2, 0], [0, 10]])!;
    expect(m[0]).toBeCloseTo(Math.SQRT1_2);
    expect(m[1]).toBeCloseTo(Math.SQRT1_2);
    expect(meanVector([])).toBeNull();
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(normalize([3, 4])).toEqual([0.6, 0.8]);
  });
  it('says why it can’t run: off by default, and not available without the binding', () => {
    setVectorTestDoubles({ index: null, embed: null });
    expect(unavailable(makeRt(db, {}))).toBe(OFF_NOTE);
    expect(unavailable(makeRt(db, ON))).toBe(NOT_HERE); // no VECTORS / AI binding (tests, wrangler dev --local)
    setVectorTestDoubles({ index: idx, embed: fakeEmbed });
    expect(unavailable(makeRt(db, ON))).toBeNull();
  });
});

// ───────────── indexing ─────────────

describe('indexing job', () => {
  it('does nothing when off, or when the bindings are missing', async () => {
    lead(db, { business: 'Dental clinics' });
    expect(await indexTick(makeRt(db, {}), { now: NOW })).toEqual({ skipped: 'VECTOR_SEARCH is off', sources: [] });
    setVectorTestDoubles({ index: null, embed: null });
    expect((await indexTick(makeRt(db, ON), { now: NOW })).skipped).toMatch(/binding/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM vec_items').get()).toEqual({ n: 0 });
  });

  it('embeds every source with namespaced ids and small metadata, then skips unchanged text', async () => {
    const a = lead(db, { business: 'Commercial HVAC servicing', notes: 'Worried about the personal guarantee on the bank loan' });
    question(db, 'room_1', 'qa:1', 'How does seller finance work when the bank wants a guarantee?', a);
    db.prepare("INSERT INTO voice_calls (id, lead_id, kind, status, summary, created_at, updated_at) VALUES ('call_1', ?, 'phone', 'ended', 'Asked about lender terms and timing', ?, ?)").run(a, NOW, NOW);
    const rt = makeRt(db);
    const r = await indexTick(rt, { now: NOW, embedCap: 500, scanLimit: 500 });
    expect(r.sources.map((s) => s.source)).toEqual(['leads', 'questions', 'notes', 'calls', 'docs']);
    expect(r.sources.every((s) => s.done)).toBe(true);
    const ids = [...idx.store.keys()];
    expect(ids).toContain(`lead:${a}`);
    expect(ids).toContain('q:room_1|qa:1');
    expect(ids).toContain(`note:lead-${a}`);
    expect(ids).toContain('note:call-call_1');
    expect(ids.filter((i) => i.startsWith('doc:')).length).toBeGreaterThan(10); // guides, guarantee, FAQ, offer terms
    for (const v of idx.store.values()) {
      expect(v.id.split(':')[0]).toBe(v.namespace);
      expect(JSON.stringify(v.metadata).length).toBeLessThan(400);
      expect(JSON.stringify(v.metadata)).not.toMatch(/@example\.com|\+614|Smith/); // no PII in the index
    }
    expect(idx.store.get(`lead:${a}`)!.metadata).toEqual({ lead: a, tier: 'A', band: '1m-5m', status: 'applied', bought: false });
    expect(embedded.join(' ')).not.toMatch(/@example\.com|\+614/);

    // The next pass (after the gap) finds nothing changed: no embedding at all.
    embedded = [];
    const again = await indexTick(rt, { now: NOW + 7 * 3600_000, embedCap: 500, scanLimit: 500 });
    expect(embedded).toEqual([]);
    expect(again.sources.find((s) => s.source === 'leads')).toMatchObject({ embedded: 0, unchanged: 1 });
  });

  it('waits out the gap between full passes', async () => {
    lead(db, { business: 'Plumbing' });
    const rt = makeRt(db);
    await indexTick(rt, { now: NOW, sources: LEADS_ONLY });
    const r = await indexTick(rt, { now: NOW + 5 * MIN, sources: LEADS_ONLY });
    expect(r.sources[0]).toMatchObject({ waiting: true, scanned: 0 });
  });

  it('re-embeds when the text changes, and only re-upserts metadata when only the status changes', async () => {
    const a = lead(db, { business: 'Accounting firm' });
    const rt = makeRt(db);
    await indexTick(rt, { now: NOW, sources: LEADS_ONLY });
    const before = idx.store.get(`lead:${a}`)!.values;

    db.prepare("UPDATE leads SET status = 'won' WHERE id = ?").run(a);
    embedded = [];
    const r1 = await indexTick(rt, { now: NOW + 31 * MIN, sources: LEADS_ONLY });
    expect(r1.sources[0]).toMatchObject({ embedded: 0, metaOnly: 1 });
    expect(embedded).toEqual([]);
    expect(idx.store.get(`lead:${a}`)!.metadata).toMatchObject({ status: 'won', bought: true });
    expect(idx.store.get(`lead:${a}`)!.values).toEqual(before);

    db.prepare('UPDATE leads SET answers = ? WHERE id = ?').run(JSON.stringify({ business: 'Accounting and tax advisory, 40 staff' }), a);
    const r2 = await indexTick(rt, { now: NOW + 62 * MIN, sources: LEADS_ONLY });
    expect(r2.sources[0]).toMatchObject({ embedded: 1 });
    expect(embedded.join(' ')).toContain('tax advisory');

    // Answers emptied: the vector is removed.
    db.prepare("UPDATE leads SET answers = '{}' WHERE id = ?").run(a);
    await indexTick(rt, { now: NOW + 93 * MIN, sources: LEADS_ONLY });
    expect(idx.store.has(`lead:${a}`)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM vec_items').get()).toEqual({ n: 0 });
  });

  it('a paid deposit marks the lead as bought without changing their text', async () => {
    const a = lead(db, { business: 'Physio clinics' });
    const rt = makeRt(db);
    await indexTick(rt, { now: NOW, sources: LEADS_ONLY });
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, created_at, updated_at, paid_at) VALUES ('p1', 'r1', ?, 'deposit', 'paid', 500000, 'usd', ?, ?, ?)").run(a, NOW, NOW, NOW);
    const r = await indexTick(rt, { now: NOW + 31 * MIN, sources: LEADS_ONLY });
    expect(r.sources[0]).toMatchObject({ metaOnly: 1, embedded: 0 });
    expect(idx.store.get(`lead:${a}`)!.metadata!.bought).toBe(true);
  });

  it('is resumable: a small budget stops mid-pass and the next tick carries on from the cursor', async () => {
    for (let i = 0; i < 5; i++) lead(db, { business: `Business number ${i} in logistics` });
    const rt = makeRt(db);
    const r1 = await indexTick(rt, { now: NOW, embedCap: 2, sources: LEADS_ONLY });
    expect(r1.sources[0]).toMatchObject({ embedded: 2, done: false });
    const cur = db.prepare("SELECT cursor, pass FROM vec_cursor WHERE source = 'leads'").get() as { cursor: string; pass: number };
    expect(cur.cursor).not.toBe('');
    const r2 = await indexTick(rt, { now: NOW + 5 * MIN, embedCap: 2, sources: LEADS_ONLY });
    expect(r2.sources[0]).toMatchObject({ embedded: 2, done: false });
    const r3 = await indexTick(rt, { now: NOW + 10 * MIN, embedCap: 2, sources: LEADS_ONLY });
    expect(r3.sources[0]).toMatchObject({ embedded: 1, done: true });
    expect(idx.store.size).toBe(5);
    expect(db.prepare("SELECT cursor, pass FROM vec_cursor WHERE source = 'leads'").get()).toEqual({ cursor: '', pass: 1 });
    expect(new Set(embedded).size).toBe(5); // each embedded exactly once

    // Re-check everything: a new pass at once, still nothing re-embedded.
    await restartPasses(rt, NOW + 11 * MIN);
    embedded = [];
    const r4 = await indexTick(rt, { now: NOW + 11 * MIN, sources: LEADS_ONLY });
    expect(r4.sources[0]).toMatchObject({ unchanged: 5, embedded: 0, done: true });
  });

  it('removes passages of approved material that no longer exist', async () => {
    const rt = makeRt(db);
    const docs = SOURCES.find((s) => s.name === 'docs')!;
    await indexTick(rt, { now: NOW, sources: [docs], embedCap: 1000, scanLimit: 1000 });
    const n = [...idx.store.keys()].length;
    db.prepare("INSERT INTO vec_items (id, ns, ref, text_hash, meta_hash, pass, indexed_at) VALUES ('doc:old', 'doc', 'old', 'x', 'y', 1, ?)").run(NOW);
    idx.store.set('doc:old', { id: 'doc:old', values: fakeVec('old'), namespace: 'doc' });
    await indexTick(rt, { now: NOW + 7 * 3600_000, sources: [docs], embedCap: 1000, scanLimit: 1000 });
    expect(idx.store.has('doc:old')).toBe(false);
    expect([...idx.store.keys()].length).toBe(n);
  });

  it('wrangler dev --local stubs (“needs to be run remotely”) read as not available, never as an error', async () => {
    lead(db, { business: 'Roofing' });
    const stub = new FakeIndex();
    stub.getByIds = async () => { throw new Error('Binding VECTORS needs to be run remotely'); };
    setVectorTestDoubles({ index: stub, embed: async () => { throw new Error('Binding AI needs to be run remotely'); } });
    expect(await indexTick(makeRt(db), { now: NOW })).toMatchObject({ skipped: NOT_HERE });
    const rt = makeRt(db);
    await expect(similarLeads(rt, 'lead_x')).rejects.toThrow(/run remotely/); // the admin route turns this into NOT_HERE
  });

  it('an index failure is reported (to the cron error log) after every source had its turn', async () => {
    lead(db, { business: 'Roofing' });
    question(db, 'room_1', 'qa:1', 'What does the lender need?');
    const broken = new FakeIndex();
    let first = true;
    broken.upsert = async (vs) => { if (first) { first = false; throw new Error('index gl-knowledge not found'); } return FakeIndex.prototype.upsert.call(broken, vs); };
    setVectorTestDoubles({ index: broken });
    await expect(indexTick(makeRt(db), { now: NOW, sources: SOURCES.slice(0, 2) })).rejects.toThrow(/leads: index gl-knowledge not found/);
    expect(broken.store.has('q:room_1|qa:1')).toBe(true); // the second source still ran
    expect((db.prepare("SELECT last_error FROM vec_cursor WHERE source = 'leads'").get() as { last_error: string }).last_error).toMatch(/not found/);
  });
});

// ───────────── search ─────────────

describe('similar leads, leads like my buyers, search', () => {
  async function seeded() {
    const ids = {
      hvac1: lead(db, { business: 'Commercial HVAC installation and servicing', first: 'Hana' }),
      hvac2: lead(db, { business: 'Commercial HVAC servicing contracts', first: 'Ivan' }),
      dental: lead(db, { business: 'Dental clinics group', first: 'Dee' }),
      buyer1: lead(db, { business: 'Commercial HVAC maintenance', status: 'won', first: 'Bea' }),
      buyer2: lead(db, { business: 'HVAC servicing and installation', first: 'Bo' }),
    };
    db.prepare("INSERT INTO challenge_deposits (reg_id, cohort_id, lead_id, started_at, paid_at) VALUES ('cr1', 'c1', ?, ?, ?)").run(ids.buyer2, NOW, NOW);
    question(db, 'room_1', 'qa:1', 'Will the bank want a personal guarantee on the loan?', ids.dental);
    question(db, 'room_1', 'qa:2', 'How long does the whole process take?', null, 'time');
    await indexTick(makeRt(db), { now: NOW, embedCap: 500, scanLimit: 500 });
    return ids;
  }

  it('finds leads whose answers read most like this one, never the lead itself', async () => {
    const ids = await seeded();
    const r = await similarLeads(makeRt(db), ids.hvac1, 4);
    expect(r.ok).toBe(true);
    expect(r.leads.map((l) => l.id)).not.toContain(ids.hvac1);
    expect(r.leads[0].id).not.toBe(ids.dental);
    expect(r.leads.at(-1)!.id).toBe(ids.dental);
    expect(r.leads[0]).toMatchObject({ tier: 'A', band: '1m-5m' });
    expect(r.leads[0].score).toBeGreaterThan(r.leads.at(-1)!.score);
  });

  it('a lead not in the index yet is compared from their answers on the spot', async () => {
    const ids = await seeded();
    const late = lead(db, { business: 'Dental practice, three clinics' });
    const r = await similarLeads(makeRt(db), late, 2);
    expect(r.leads[0].id).toBe(ids.dental);
  });

  it('leads like my buyers: the centre of recent buyers, nearest who haven’t bought, buyers excluded', async () => {
    const ids = await seeded();
    const r = await buyerLookalikes(makeRt(db), 10);
    expect(r.buyers).toBe(2);
    const got = r.leads.map((l) => l.id);
    expect(got).not.toContain(ids.buyer1);
    expect(got).not.toContain(ids.buyer2);
    expect(got.slice(0, 2).sort()).toEqual([ids.hvac1, ids.hvac2].sort());
    expect(got.at(-1)).toBe(ids.dental);
    expect(r.leads.every((l) => !l.bought)).toBe(true);
  });

  it('with no buyers it says so instead of guessing', async () => {
    lead(db, { business: 'Painting' });
    await indexTick(makeRt(db), { now: NOW, sources: LEADS_ONLY });
    const r = await buyerLookalikes(makeRt(db));
    expect(r).toMatchObject({ ok: true, buyers: 0, leads: [] });
    expect(r.note).toMatch(/No buyers/);
  });

  it('searches questions, notes and answers by meaning, with snippets and the lead’s name', async () => {
    const ids = await seeded();
    const r = await semanticSearch(makeRt(db), 'personal guarantee bank loan');
    expect(r.ok).toBe(true);
    expect(r.hits[0]).toMatchObject({ kind: 'q', roomId: 'room_1', leadId: ids.dental, leadName: 'Dee Smith' });
    expect(r.hits[0].snippet).toContain('personal guarantee');
    expect(idx.calls).not.toContain('query:doc'); // approved material is not part of this search
    expect((await semanticSearch(makeRt(db), 'x')).note).toMatch(/few words/);
  });

  it('every search says why when it can’t run', async () => {
    setVectorTestDoubles({ index: null, embed: null });
    const rt = makeRt(db);
    expect(await similarLeads(rt, 'lead_1')).toEqual({ ok: false, note: NOT_HERE, leads: [] });
    expect(await buyerLookalikes(rt)).toMatchObject({ ok: false, note: NOT_HERE });
    expect(await semanticSearch(rt, 'anything at all')).toMatchObject({ ok: false, note: NOT_HERE });
    expect(await retrieveDocs(rt, 'anything')).toBeNull();
  });

  it('the admin endpoints need an admin session and report off', async () => {
    const env = { DB: d1(db), SESSION_SECRET: 'test-secret-0123456789', ADMIN_PASSWORD: 'devpass' };
    const exec = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('settings', { ...BASE } as never); c.set('reps', []); await next(); });
    app.post('/login', async (c) => c.json(await login(c, 'devpass')));
    app.route('/admin/api/vectors', vectorsAdmin);
    expect((await app.request('http://localhost/admin/api/vectors/status', {}, env, exec)).status).toBe(401);
    expect((await app.request('http://localhost/admin/api/vectors/search?q=bank', {}, env, exec)).status).toBe(401);
    const lr = await app.request('http://localhost/login', { method: 'POST', headers: { origin: 'http://localhost' } }, env, exec);
    const cookie = (lr.headers.get('set-cookie') ?? '').split(';')[0];
    const st = await (await app.request('http://localhost/admin/api/vectors/status', { headers: { cookie } }, env, exec)).json() as Record<string, unknown>;
    expect(st).toMatchObject({ on: false, helper: false, note: OFF_NOTE, counts: { lead: 0, q: 0, note: 0, doc: 0 }, gateway: { on: false } });
    const sim = await (await app.request('http://localhost/admin/api/vectors/similar/lead_1', { headers: { cookie } }, env, exec)).json() as Record<string, unknown>;
    expect(sim).toMatchObject({ off: true, ok: false });
    expect((await app.request('http://localhost/admin/api/vectors/run', { method: 'POST', headers: { cookie } }, env, exec)).status).toBe(403); // no Origin: not same-origin
  });
});

// ───────────── AI Gateway ─────────────

describe('AI Gateway', () => {
  it('builds the gateway URL from the id and the account (default account when blank); blank = direct', () => {
    expect(gatewayInfo({}).on).toBe(false);
    expect(gatewayInfo({ AI_GATEWAY_ID: '' }).anthropicBase).toBeNull();
    const g = gatewayInfo({ AI_GATEWAY_ID: 'default' });
    expect(g).toMatchObject({ on: true, account: DEFAULT_CF_ACCOUNT, anthropicBase: `https://gateway.ai.cloudflare.com/v1/${DEFAULT_CF_ACCOUNT}/default/anthropic` });
    expect(g.dashboardUrl).toBe(`https://dash.cloudflare.com/${DEFAULT_CF_ACCOUNT}/ai/ai-gateway/gateways/default`);
    expect(gatewayInfo({ AI_GATEWAY_ID: 'gw-2', CF_ACCOUNT_ID: 'a'.repeat(32) }).anthropicBase).toBe(`https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/gw-2/anthropic`);
    expect(gatewayInfo({ AI_GATEWAY_ID: '../evil' })).toMatchObject({ on: false });
    expect(gatewayInfo({ AI_GATEWAY_ID: 'default', CF_ACCOUNT_ID: 'nope' })).toMatchObject({ on: false });
    expect(featureTag('Room Helper!')).toBe('room-helper-');
    expect(shouldFallBack(502)).toBe(true);
    expect(shouldFallBack(400)).toBe(false);
    expect(shouldFallBack(429)).toBe(false);
  });

  const BASE_URL = `https://gateway.ai.cloudflare.com/v1/${DEFAULT_CF_ACCOUNT}/default/anthropic`;
  const body = JSON.stringify({ model: 'm', messages: [] });

  it('sends Anthropic requests to the gateway with the feature tag and leaves other URLs alone', async () => {
    const seen: { url: string; meta: string | null; key: string | null }[] = [];
    const inner = async (u: string | URL | Request, init?: RequestInit) => { const h = new Headers(init?.headers); seen.push({ url: String(u), meta: h.get('cf-aig-metadata'), key: h.get('x-api-key') }); return new Response('{}', { status: 200 }); };
    const f = gatewayFetch(BASE_URL, 'support', inner);
    await f(`${ANTHROPIC_DIRECT}/v1/messages`, { method: 'POST', body, headers: { 'x-api-key': 'k' } });
    await f('https://example.com/x', {});
    expect(seen[0]).toEqual({ url: `${BASE_URL}/v1/messages`, meta: '{"feature":"support"}', key: 'k' });
    expect(seen[1].url).toBe('https://example.com/x');
    expect(seen[1].meta).toBeNull();
  });

  it('falls back to the direct API on a gateway 5xx or network error, but not on a 4xx answer', async () => {
    const urls: string[] = [];
    let mode: '500' | 'throw' | '400' = '500';
    const inner = async (u: string | URL | Request) => {
      urls.push(String(u));
      if (String(u).startsWith(BASE_URL)) { if (mode === 'throw') throw new TypeError('fetch failed'); return new Response('{}', { status: mode === '500' ? 502 : 400 }); }
      return new Response('{"ok":true}', { status: 200 });
    };
    const notes: string[] = [];
    const f = gatewayFetch(BASE_URL, 'ops', inner, (w) => notes.push(w));
    expect((await f(`${ANTHROPIC_DIRECT}/v1/messages`, { method: 'POST', body })).status).toBe(200);
    expect(urls).toEqual([`${BASE_URL}/v1/messages`, `${ANTHROPIC_DIRECT}/v1/messages`]);
    mode = 'throw'; urls.length = 0;
    expect((await f(`${ANTHROPIC_DIRECT}/v1/messages`, { method: 'POST', body })).status).toBe(200);
    expect(urls[1]).toBe(`${ANTHROPIC_DIRECT}/v1/messages`);
    mode = '400'; urls.length = 0;
    expect((await f(`${ANTHROPIC_DIRECT}/v1/messages`, { method: 'POST', body })).status).toBe(400);
    expect(urls).toHaveLength(1); // a real Anthropic answer is passed through
    expect(notes).toEqual(['gateway answered 502', 'gateway unreachable: fetch failed']);
  });

  it('the shared client goes through the gateway only when AI_GATEWAY_ID is set, keeping the model the caller chose', async () => {
    const calls: { url: string; model: string; meta: string | null }[] = [];
    vi.stubGlobal('fetch', async (u: string | URL | Request, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? '{}')) as { model: string };
      calls.push({ url: String(u), model: b.model, meta: new Headers(init?.headers).get('cf-aig-metadata') });
      return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const direct = anthropicClient({}, 'x', { apiKey: 'k', maxRetries: 0 });
    await direct.messages.create({ model: 'model-from-settings', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    const via = anthropicClient({ AI_GATEWAY_ID: 'default' }, 'room-helper', { apiKey: 'k', maxRetries: 0 });
    await via.messages.create({ model: 'model-from-settings', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0]).toMatchObject({ url: `${ANTHROPIC_DIRECT}/v1/messages`, model: 'model-from-settings', meta: null });
    expect(calls[1]).toMatchObject({ url: `${BASE_URL}/v1/messages`, model: 'model-from-settings', meta: '{"feature":"room-helper"}' });
  });

  it('every Anthropic client in the app is made through the gateway helper', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir).flatMap((f) => (f.endsWith('.ts') ? [`${dir}/${f}`] : f.includes('.') ? [] : walk(`${dir}/${f}`)));
    const offenders = walk(`${node.cwd()}/src`).filter((f) => !f.endsWith('ai-gateway.ts') && /new Anthropic\(/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('Workers AI runs through the gateway when set, and directly when it fails or is off', async () => {
    const runs: unknown[] = [];
    let fail = true;
    const ai = { run: async (_m: string, _i: unknown, o?: unknown) => { runs.push(o ?? null); if (o && fail) throw new Error('gateway 502'); return { data: [[1]] }; } };
    expect(await runWorkersAi(ai, {}, 'x', 'm', {})).toEqual({ data: [[1]] });
    expect(runs).toEqual([null]);
    runs.length = 0;
    expect(await runWorkersAi(ai, { AI_GATEWAY_ID: 'default' }, 'vector-index', 'm', {})).toEqual({ data: [[1]] });
    expect(runs).toEqual([{ gateway: { id: 'default', metadata: { feature: 'vector-index' } } }, null]);
    fail = false; runs.length = 0;
    await runWorkersAi(ai, { AI_GATEWAY_ID: 'default' }, 'vector-index', 'm', {});
    expect(runs).toHaveLength(1);
    expect(workersAiGateway({}, 'x')).toEqual({});
  });
});

// ───────────── the room helper ─────────────

describe('room AI draft', () => {
  const HELPER = { ROOM_AI_HELPER: 'on', ANTHROPIC_API_KEY: 'sk-test' };

  it('is off by default and degrades without the Anthropic key', async () => {
    expect(await draftRoomAnswer(makeRt(db, {}), 'How does seller finance work?')).toMatchObject({ ok: false, draft: null, aiDrafted: true, note: HELPER_COPY.off });
    expect(await draftRoomAnswer(makeRt(db, { ROOM_AI_HELPER: 'on' }), 'How does seller finance work?')).toMatchObject({ ok: false, draft: null, note: HELPER_COPY.noKey });
  });

  it('drafts from approved material only, labelled as AI-drafted, tagged for the gateway, within the chat limit', async () => {
    const asks: { system: string; user: string; feature?: string }[] = [];
    setClaudeTransport(async (_rt, a) => { asks.push(a); return 'We structure deals with commercial debt, seller finance and seller rollover, tested at about 1.5x debt service coverage. The guarantee has conditions, listed on the guarantee page.'; });
    // A lead's private notes sit in the index too: they must never reach the helper.
    lead(db, { business: 'Secret Co', notes: 'PRIVATE NOTE about seller finance and debt' });
    await indexTick(makeRt(db, { ...ON, ...HELPER }), { now: NOW, embedCap: 1000, scanLimit: 1000 });
    const r = await draftRoomAnswer(makeRt(db, { ...ON, ...HELPER }), 'How is a deal funded with seller finance?');
    expect(r.ok).toBe(true);
    expect(r.aiDrafted).toBe(true);
    expect(r.label).toBe(HELPER_COPY.label);
    expect(r.retrieval).toBe('vectors');
    expect(r.draft!.length).toBeLessThanOrEqual(DRAFT_MAX);
    expect(asks[0].feature).toBe('room-helper');
    expect(asks[0].system).toBe(HELPER_SYSTEM);
    expect(asks[0].user).not.toMatch(/PRIVATE NOTE|Secret Co/);
    expect(idx.calls.filter((c) => c.startsWith('query:'))).toEqual(['query:doc']);
    expect(r.sources.length).toBeGreaterThan(0);
  });

  it('without the index it uses the same approved material by keyword', async () => {
    setVectorTestDoubles({ index: null, embed: null });
    setClaudeTransport(async () => 'We fund deals with commercial debt, seller finance and seller rollover.');
    const r = await draftRoomAnswer(makeRt(db, HELPER), 'What is the guarantee and its conditions?');
    expect(r).toMatchObject({ ok: true, retrieval: 'keywords' });
  });

  it('throws away a draft that speaks as Josh, and says when the material has no answer', async () => {
    setVectorTestDoubles({ index: null, embed: null });
    setClaudeTransport(async () => 'Hi, I’m Josh. I bought my clinics with seller finance, commercial debt and seller rollover.');
    expect(await draftRoomAnswer(makeRt(db, HELPER), 'How did Josh buy his clinics?')).toMatchObject({ ok: false, draft: null, note: HELPER_COPY.asJosh });
    setClaudeTransport(async () => 'NO_ANSWER');
    expect(await draftRoomAnswer(makeRt(db, HELPER), 'What is the guarantee?')).toMatchObject({ ok: false, draft: null, note: HELPER_COPY.noSources });
    expect(speaksAsJosh('Josh here, happy to help')).toBe(true);
    expect(speaksAsJosh('Thanks for asking.\n- Josh')).toBe(true);
    expect(speaksAsJosh('Josh’s team can walk you through it.')).toBe(false);
    expect(speaksAsJosh('Josh bought his clinics with 100% seller finance.')).toBe(false);
  });

  it('house-rule problems are shown to the person, not hidden', async () => {
    setVectorTestDoubles({ index: null, embed: null });
    setClaudeTransport(async () => 'Book your free call and we fund it with commercial debt.');
    const r = await draftRoomAnswer(makeRt(db, HELPER), 'How is a deal funded?');
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual(expect.arrayContaining(['calls a call free', 'funding without seller rollover']));
  });

  it('fits the chat at a sentence end', () => {
    const long = `${'This is one sentence about the deal. '.repeat(20)}`;
    const out = fitChat(long);
    expect(out.length).toBeLessThanOrEqual(DRAFT_MAX);
    expect(out.endsWith('.')).toBe(true);
  });

  it('the route answers only staff tickets and never posts to the room', async () => {
    const rt = makeRt(db, HELPER);
    setClaudeTransport(async () => 'We fund deals with commercial debt, seller finance and seller rollover.');
    setVectorTestDoubles({ index: null, embed: null });
    const room = await createRoom(rt, { mode: 'webinar', title: 'W', refType: 'none' });
    const hostT = await makeTicket(rt, room.id, { id: 'hadmin', name: 'Host', role: 'host' });
    const annT = await makeTicket(rt, room.id, { id: 'rann', name: 'Ann', role: 'attendee', leadId: 'l1' });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('settings', { ...BASE, ...HELPER } as never); await next(); });
    app.route('/api/rooms', roomsApi);
    const roomsStub = { idFromName: () => { throw new Error('the helper must never reach the room'); }, get: () => { throw new Error('never'); } };
    const call = (body: Record<string, unknown>) => app.request(`/api/rooms/${room.id}/ai-draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { DB: d1(db), SESSION_SECRET: 'test-session-secret', ROOMS: roomsStub } as never, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
    expect((await call({ t: annT, text: 'How is a deal funded?' })).status).toBe(403);
    expect((await call({ text: 'How is a deal funded?' })).status).toBe(403);
    const res = await call({ t: hostT, text: 'How is a deal funded?' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, aiDrafted: true, label: HELPER_COPY.label });
  });

  it('in the room page, only a person pressing Send posts a draft to the chat', () => {
    const js = fs.readFileSync(`${node.cwd()}/public/assets/room.js`, 'utf8');
    const start = js.indexOf('var AIC = ');
    const end = js.indexOf('\n  }\n', js.indexOf('function wireAid'));
    const section = js.slice(start, end);
    expect(section).toContain("post('/ai-draft'");
    expect(section.match(/send\(/g)).toHaveLength(1);
    const sendAt = section.indexOf('send(');
    expect(section.lastIndexOf("$$('[data-aid-send]'", sendAt)).toBeGreaterThan(section.lastIndexOf("$$('[data-aid-x]'", sendAt));
    expect(section.slice(section.lastIndexOf('b.onclick', sendAt), sendAt)).toContain('ta.value'); // the person's edited text
    expect(js).toContain('isStaff && CFG.aiDraft');
  });

  it('copy passes the house rules', () => {
    for (const v of Object.values(HELPER_COPY)) expect(auditCopy(v)).toEqual([]);
    for (const k of ['VECTOR_SEARCH', 'ROOM_AI_HELPER', 'AI_GATEWAY_ID', 'CF_ACCOUNT_ID']) {
      const d = SETTINGS.find((s) => s.key === k)!;
      expect(d.group).toBe('AI & search');
      expect(auditCopy(('help' in d ? d.help : '') ?? '')).toEqual([]);
    }
  });
});

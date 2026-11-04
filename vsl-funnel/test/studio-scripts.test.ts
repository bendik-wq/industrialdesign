import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditCopy } from '../src/content/copy-rules';
import { FORMAT_IDS, FRAMEWORKS, FRAMEWORK_IDS, ICP_IDS, LAYOUTS, pickFramework, scriptSystemPrompt } from '../src/studio/copy-brain';
import { type Ask, cleanScript, parseJsonReply, scriptIssues, writeScript } from '../src/studio/scripts';

// Studio → Scripts (src/studio/scripts.ts + copy-brain.ts): the prompt, the beat validation, the copy gate, and the
// routes on the whole worker with an in-memory SQLite D1 (every migration applied) and a stubbed Workers AI.

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

// ───────────── a clean script, as a model would return it ─────────────

const GOOD = {
  hooks: [
    'Banks don\'t reject buyers. They reject structures.',
    'I bought my clinics in two acquisitions, and both sellers financed 100% of the price.',
    'The reason your offer went nowhere had nothing to do with price.',
  ],
  hook_index: 1,
  beats: [
    { layout: 'cinema', text: 'I bought my clinics in two acquisitions, and both sellers financed 100% of the price.\nAnd the order I did it in is the part most owners skip.', cue: 'Slow, eyes on the lens', on_screen: 'Two acquisitions', screen: '' },
    { layout: 'spotlight', text: 'The first step is the conversation with the seller.\nYou agree the shape of the deal with the owner before any lender sees it.', cue: 'Lean in', on_screen: 'Seller first', screen: '' },
    { layout: 'split', text: 'Then the structure: commercial debt, seller finance and seller rollover.\nThe test that decides it is debt service coverage of 1.5x.', cue: 'Point at the diagram', on_screen: 'The 1.5x test', screen: 'A simple stack diagram of debt, seller note and rollover' },
    { layout: 'hologram', text: 'Apply through the link below. If it\'s a fit, the team books a strategy call to look at your numbers.', cue: 'Warm', on_screen: 'Apply below', screen: '' },
  ],
  titles: ['How Owners Buy a Competitor With Seller Finance', 'The Order That Gets a Deal Funded', 'Buying Your First Company: Seller First'],
  thumbnail: 'Seller first',
  description: 'How to agree the deal with the seller before the bank.\nApply: {APPLY_LINK}\nNot legal, tax or financial advice.',
  cta: 'Apply through the link below. If it\'s a fit, the team books a strategy call to look at your numbers.',
};
const BAD = {
  ...GOOD,
  hooks: ['Here\'s the thing about buying a business.', ...GOOD.hooks.slice(1)],
  beats: [
    { layout: 'spotlight', text: 'Our students might buy a business in 90 days — with seller finance.', cue: '', on_screen: '', screen: '' },
    ...GOOD.beats.slice(1),
  ],
};

describe('copy brain: the system prompt', () => {
  it('includes the chosen framework in full, the facts, the CTA, the layouts and the house copy system', () => {
    for (const fw of FRAMEWORK_IDS) {
      const p = scriptSystemPrompt({ topic: 'x', format: 'long', icp: 'trapped', framework: fw, cta: 'Apply through the link below.' });
      expect(p).toContain(FRAMEWORKS[fw].body);
      for (const other of FRAMEWORK_IDS.filter((o) => o !== fw)) expect(p).not.toContain(FRAMEWORKS[other].body);
      expect(p).toContain('In both, the sellers financed 100% of the price.');
      expect(p).toContain('HOOKS BANK');
      expect(p).toContain('"Apply through the link below."');
      expect(p).toContain('BANNED PATTERNS'); // copyBrief('video')
      for (const l of ['cinema', 'spotlight', 'orbit', 'stage', 'split']) expect(p).toContain(`- ${l}:`);
    }
    const short = scriptSystemPrompt({ topic: 'x', format: 'short', icp: 'ceiling', framework: 'third_way', cta: 'c' });
    expect(short).toContain('- vertical:');
    expect(short).not.toContain('- stage:');
  });

  it('never carries the skill templates that need proof G&L does not have', () => {
    const p = scriptSystemPrompt({ topic: 'x', format: 'long', icp: 'deployer', framework: 'saturation', cta: 'c' });
    expect(p).not.toMatch(/Richard Alston|KingVets|\$300M|23 days/);
    expect(p).not.toMatch(/book the only free/i);
  });

  it('auto picks one framework per format and ICP; an explicit choice wins', () => {
    for (const f of FORMAT_IDS) for (const i of ICP_IDS) expect(FRAMEWORK_IDS).toContain(pickFramework(f, i));
    expect(pickFramework('webinar', 'trapped')).toBe('timeline_failure');
    expect(pickFramework('long', 'ceiling', 'cost_inversion')).toBe('cost_inversion');
  });

  it('every label and line the Scripts view shows passes the copy rules', () => {
    for (const fw of FRAMEWORK_IDS) expect(auditCopy(`${FRAMEWORKS[fw].label}. ${FRAMEWORKS[fw].sub}.`)).toEqual([]);
  });
});

describe('beats validation', () => {
  it('clamps unknown layouts, keeps known ones, forces Shorts to vertical, keeps vertical out of long-form', () => {
    const s = cleanScript(GOOD, 'long', 'cta');
    expect(s.beats.map((b) => b.layout)).toEqual(['cinema', 'spotlight', 'split', 'spotlight']);
    expect(s.beats.every((b) => (LAYOUTS as readonly string[]).includes(b.layout))).toBe(true);
    const first = cleanScript({ beats: [{ layout: 'nope', text: 'a' }, { layout: 'vertical', text: 'b' }] }, 'long', 'cta');
    expect(first.beats.map((b) => b.layout)).toEqual(['cinema', 'spotlight']);
    const short = cleanScript(GOOD, 'short', 'cta');
    expect(short.beats.every((b) => b.layout === 'vertical')).toBe(true);
  });

  it('caps lengths, drops empty beats, picks the chosen hook and estimates the length from the words', () => {
    const s = cleanScript({ ...GOOD, beats: [...GOOD.beats, { layout: 'stage', text: '' }, ...Array.from({ length: 60 }, () => ({ layout: 'stage', text: 'word '.repeat(10) }))] }, 'vsl', 'cta');
    expect(s.beats.length).toBeLessThanOrEqual(40);
    expect(s.hook).toBe(GOOD.hooks[1]);
    expect(s.est_seconds).toBe(Math.round((s.words / 150) * 60));
    const bare = cleanScript({ beats: ['Just text'], hook_index: 7 }, 'email', 'Fallback CTA');
    expect(bare.beats[0]).toMatchObject({ layout: 'spotlight', text: 'Just text' });
    expect(bare.hook).toBe('Just text');
    expect(bare.cta).toBe('Fallback CTA');
  });

  it('reads JSON however the model wraps it', () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply({ a: 2 })).toEqual({ a: 2 });
    expect(() => parseJsonReply('no json')).toThrow();
  });
});

describe('the auditCopy gate', () => {
  it('a clean script has no flags; a bad one is flagged for hedges, fillers, em dashes, fake proof and missing rollover', () => {
    expect(scriptIssues(cleanScript(GOOD, 'long', 'cta'))).toEqual([]);
    const rules = scriptIssues(cleanScript(BAD, 'long', 'cta')).map((i) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(['hedge: "might"', 'filler: "here\'s the thing"', 'em dash', expect.stringMatching(/our students/)]));
    const noRollover = cleanScript({ ...GOOD, beats: [{ layout: 'spotlight', text: 'Use commercial debt and seller finance.' }] }, 'long', 'cta');
    expect(scriptIssues(noRollover).map((i) => i.rule)).toContain('house rule: name seller rollover when funding is described');
    const unlabelled = cleanScript({ ...GOOD, beats: [{ layout: 'split', text: 'A business with $800k profit trades at 4x.' }] }, 'long', 'cta');
    expect(scriptIssues(unlabelled).map((i) => i.rule)).toContain('label example numbers "illustrative"');
  });

  it('a failing draft is rewritten once with the failures listed; a clean one is not', async () => {
    const calls: { role: string; content: string }[][] = [];
    const ask: Ask = async (_s, m) => { calls.push(m); return JSON.stringify(calls.length === 1 ? BAD : GOOD); };
    const w = await writeScript(ask, { topic: 't', format: 'long', icp: 'trapped', framework: 'two_paths', cta: 'cta' });
    expect(calls.length).toBe(2);
    expect(calls[1][2].content).toContain('hedge: "might"');
    expect(calls[1][2].content).toContain('em dash');
    expect(w).toMatchObject({ attempts: 2, flags: [] });

    const once: Ask = async () => JSON.stringify(GOOD);
    const spy = vi.fn(once);
    expect(await writeScript(spy, { topic: 't', format: 'long', icp: 'trapped', framework: 'two_paths', cta: 'cta' })).toMatchObject({ attempts: 1, flags: [] });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('flags that survive the rewrite are kept and shown', async () => {
    const ask: Ask = async () => JSON.stringify(BAD);
    const w = await writeScript(ask, { topic: 't', format: 'long', icp: 'trapped', framework: 'two_paths', cta: 'cta' });
    expect(w.attempts).toBe(2);
    expect(w.flags.length).toBeGreaterThan(0);
  });
});

// ───────────── the routes, on the whole worker ─────────────

const ORIGIN = 'https://apply.test';
let sdb: SqlDb;
const exCtx = { waitUntil: (p: Promise<unknown>) => { p.catch(() => null); }, passThroughOnException: () => {} };
const aiCalls: { model: string; input: { messages: { role: string; content: string }[] } }[] = [];
let aiReply: unknown = GOOD;
const envFor = () => ({
  DB: d1(sdb), SESSION_SECRET: 'env-session-secret-'.padEnd(40, 'z'), ADMIN_PASSWORD: 'devpass-owner-only',
  ASSETS: { fetch: async () => new Response('<!doctype html><html><body></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
  AI: { run: async (model: string, input: never) => { aiCalls.push({ model, input }); return { response: JSON.stringify(aiReply) }; } },
});
type App = { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> };
let app: App;
const call = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', '203.0.113.7');
  return app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), envFor(), exCtx);
};
const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
const json = { ...same, 'content-type': 'application/json' };
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1) ?? '';
async function ownerCookie() {
  const res = await call('/admin/login', { method: 'POST', headers: { ...same, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=devpass-owner-only' });
  return cookieOf(res, '_fa');
}
async function guestCookie(owner: string) {
  const res = await call('/admin/api/guest-access', { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ label: 'Viewer', days: 1 }) });
  const { url } = (await res.json()) as { url: string };
  return cookieOf(await call(new URL(url).pathname, { headers: { 'sec-fetch-site': 'cross-site' } }), '_fg');
}

beforeAll(async () => {
  vi.stubGlobal('HTMLRewriter', class { on() { return this; } transform(r: Response) { return r; } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"offline"}', { status: 503 })));
  app = (await import('../src/index')).default as unknown as App;
}, 60_000);
beforeEach(async () => {
  sdb = freshDb();
  aiCalls.length = 0;
  aiReply = GOOD;
  (await import('../src/settings')).resetSettingsCache();
  (await import('../src/lib/hq-cache')).memoryClear();
  (await import('../src/admin/guest')).resetGuestCaches();
});

describe('routes: /admin/api/studio/scripts*', () => {
  it('needs an admin session', async () => {
    expect((await call('/admin/api/studio/scripts')).status).toBe(401);
    expect((await call('/admin/api/studio/scripts', { method: 'POST', headers: json, body: '{"topic":"x"}' })).status).toBe(401);
  });

  it('the owner generates a script with Workers AI (no Anthropic key): the prompt carries the framework, the row is saved and listed', async () => {
    const owner = await ownerCookie();
    const opts = (await (await call('/admin/api/studio/scripts/options', { headers: { cookie: owner } })).json()) as { brain: string; formats: unknown[]; frameworks: { id: string }[] };
    expect(opts.brain).toBe('workers-ai');
    expect(opts.frameworks.map((f) => f.id)).toEqual(['auto', ...FRAMEWORK_IDS]);
    const res = await call('/admin/api/studio/scripts', { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ topic: 'Buying a competitor with seller finance', format: 'long', icp: 'ceiling', framework: 'third_way' }) });
    expect(res.status).toBe(200);
    const d = (await res.json()) as { ok: boolean; script: { id: string; brain: string; framework: string; script: { beats: { layout: string }[]; hook: string }; flags: unknown[] } };
    expect(d).toMatchObject({ ok: true, script: { brain: 'workers-ai', framework: 'third_way', flags: [] } });
    expect(d.script.script.beats.map((b) => b.layout)).toEqual(['cinema', 'spotlight', 'split', 'spotlight']);
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0].model).toMatch(/^@cf\//);
    expect(aiCalls[0].input.messages[0].content).toContain(FRAMEWORKS.third_way.body);
    expect(aiCalls[0].input.messages[1].content).toContain('Buying a competitor with seller finance');
    const list = (await (await call('/admin/api/studio/scripts', { headers: { cookie: owner } })).json()) as { scripts: { id: string; beats: number }[] };
    expect(list.scripts).toEqual([expect.objectContaining({ id: d.script.id, beats: 4 })]);
    const one = await call(`/admin/api/studio/scripts/${d.script.id}`, { headers: { cookie: owner } });
    expect(((await one.json()) as { script: { script: { hook: string } } }).script.script.hook).toBe(GOOD.hooks[1]);
    expect((await call(`/admin/api/studio/scripts/${d.script.id}`, { method: 'DELETE', headers: { ...same, cookie: owner } })).status).toBe(200);
    expect(((await (await call('/admin/api/studio/scripts', { headers: { cookie: owner } })).json()) as { scripts: unknown[] }).scripts).toEqual([]);
  });

  it('a draft that fails the copy rules is rewritten once; remaining flags are stored', async () => {
    const owner = await ownerCookie();
    aiReply = BAD;
    const d = (await (await call('/admin/api/studio/scripts', { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ topic: 'x', format: 'short', icp: 'trapped' }) })).json()) as { script: { attempts: number; flags: unknown[]; script: { beats: { layout: string }[] } } };
    expect(aiCalls).toHaveLength(2);
    expect(aiCalls[1].input.messages.at(-1)!.content).toContain('copy rules');
    expect(d.script.attempts).toBe(2);
    expect(d.script.flags.length).toBeGreaterThan(0);
    expect(d.script.script.beats.every((b) => b.layout === 'vertical')).toBe(true);
  });

  it('asks for a topic', async () => {
    const owner = await ownerCookie();
    const res = await call('/admin/api/studio/scripts', { method: 'POST', headers: { ...json, cookie: owner }, body: '{}' });
    expect(res.status).toBe(400);
    expect(aiCalls).toHaveLength(0);
  });

  it('guests can read scripts but never generate or delete', async () => {
    const owner = await ownerCookie();
    const made = (await (await call('/admin/api/studio/scripts', { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ topic: 'x' }) })).json()) as { script: { id: string } };
    const g = await guestCookie(owner);
    expect(g).not.toBe('');
    aiCalls.length = 0;
    expect((await call('/admin/api/studio/scripts', { headers: { cookie: g } })).status).toBe(200);
    expect((await call(`/admin/api/studio/scripts/${made.script.id}`, { headers: { cookie: g } })).status).toBe(200);
    expect((await call('/admin/api/studio/scripts/options', { headers: { cookie: g } })).status).toBe(200);
    expect((await call('/admin/api/studio/scripts', { method: 'POST', headers: { ...json, cookie: g }, body: JSON.stringify({ topic: 'x' }) })).status).toBe(403);
    expect((await call(`/admin/api/studio/scripts/${made.script.id}`, { method: 'DELETE', headers: { ...same, cookie: g } })).status).toBe(403);
    expect(aiCalls).toHaveLength(0);
  });
});

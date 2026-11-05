import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { getBrain } from '../src/radar/brain-provider';
import { listFormats } from '../src/radar/formats';
import {
  type Models, type PipelineDeps, RADAR_GRAPH, RadarPipelineWorkflow, type StepLike, getRun, nodeStates, radarPipelineTick, runInline, runRadarPipeline, startPipeline,
} from '../src/radar/pipeline-flow';
import { ADAPTATION, SCRIPT, extractionFor, fakeModel, rtFor, seedItems } from './radar-formats-fakes';
import { type SqlDb, d1, freshDb } from './studio-fakes';

// Radar v2 (builder C): the analysis pipeline graph (sweep → transcribe → extract → cluster → adapt → judge ⇄ rewrite
// → store) with fakes: a Workflow-like step runner that replays recorded steps, crash and resume, the inline runner's
// yields and the cron, the Workflow class itself, the API on the whole worker, and the browser module's syntax.

/** Workflow semantics: a step that succeeded is never run again; its result is replayed. */
function memoStep() {
  const memo = new Map<string, unknown>();
  const ran: string[] = [];
  const step: StepLike = {
    async do(name, _c, fn) { if (memo.has(name)) return memo.get(name) as never; const out = await fn(); memo.set(name, out); ran.push(name); return out; },
    async sleep() {},
  };
  return { step, memo, ran };
}

function depsWith(m: ReturnType<typeof fakeModel>, over: Partial<PipelineDeps> = {}): PipelineDeps & { transcribed: number } {
  const d = {
    transcribed: 0,
    models: (rt: Runtime): Models => ({ ask: m.ask, scriptAsk: m.ask, judgeAsk: m.ask, extractAsk: m.ask, nameAsk: m.ask, brain: getBrain(rt), model: 'workers-ai' }),
    sweepActive: async () => 0,
    stepRuns: async () => null,
    transcribe: async () => { d.transcribed++; return { queued: 0 }; },
    transcriptsActive: async () => 0,
    ...over,
  };
  return d;
}
async function newRun(rt: Runtime, id = 'rp-test-1') {
  const ts = new Date().toISOString();
  await rt.env.DB.prepare("INSERT INTO radar_pipeline_runs (id, trigger, status, node, steps_json, started_at, updated_at) VALUES (?, 'button', 'running', 'sweep', '{}', ?, ?)").bind(id, ts, ts).run();
  return id;
}

describe('the pipeline graph', () => {
  let db: SqlDb;
  beforeEach(async () => { db = freshDb(); await seedItems(db); });

  it('runs every node in order and stores the top formats\' adaptations', async () => {
    const rt = rtFor(db, { RADAR_ADAPT_TOP: '2' });
    const m = fakeModel();
    const id = await newRun(rt);
    const { step, ran } = memoStep();
    const out = await runRadarPipeline(async () => rt, id, step, depsWith(m));
    expect(out).toMatchObject({ adaptations: 2, formats: 4, white_space: 1 });
    expect(ran[0]).toBe('sweep_runs 0');
    expect(ran).toEqual(expect.arrayContaining(['transcribe', 'brain_context', 'extract_formats plan', 'extract_formats 0', 'cluster_formats', 'adapt plan', 'store_formats']));
    expect(ran.filter((x) => x.startsWith('copy_gate '))).toHaveLength(2);
    expect(m.calls.extract).toBe(6);
    const run = (await getRun(rt, id))!;
    expect(run.status).toBe('done');
    expect(nodeStates(run).map((n) => `${n.id}:${n.state}`)).toEqual(['sweep_runs:done', 'transcribe:done', 'brain_context:done', 'extract_formats:done', 'cluster_formats:done', 'adapt:done', 'copy_gate:done', 'judge:done', 'rewrite:skipped', 'store_formats:done']);
    // The node ids are the ones in builder B's spec, docs/radar.graph.yaml.
    const spec = readFileSync('docs/radar.graph.yaml', 'utf8');
    for (const nd of RADAR_GRAPH.nodes) expect(spec, nd.id).toMatch(new RegExp(`^  ${nd.id}:`, 'm'));
    const ad = db.prepare("SELECT format_id, status, script_id FROM radar_adaptations ORDER BY created_at").all() as { format_id: string; status: string; script_id: string }[];
    expect(ad).toHaveLength(2);
    expect(ad.every((a) => a.status === 'stored' && a.script_id)).toBe(true);
    // The white-space format makes the adapt list even when it is not in the top 2 by rank.
    const ws = (await listFormats(rt)).find((f) => f.white_space > 0)!;
    expect(ad.map((a) => a.format_id)).toContain(ws.id);
  });

  it('is idempotent: a second run on the same data reads nothing again and reuses the adaptations', async () => {
    const rt = rtFor(db, { RADAR_ADAPT_TOP: '2' });
    const m = fakeModel();
    await runRadarPipeline(async () => rt, await newRun(rt, 'rp-a-1'), memoStep().step, depsWith(m));
    const before = { ...m.calls };
    const out = await runRadarPipeline(async () => rt, await newRun(rt, 'rp-b-1'), memoStep().step, depsWith(m));
    expect(out.adaptations).toBe(2);
    expect(m.calls.extract).toBe(before.extract); // every item already has its format
    expect(m.calls.adapt).toBe(before.adapt); // members unchanged, adaptations reused
    expect(m.calls.name).toBe(before.name);
    expect(db.prepare('SELECT COUNT(*) AS n FROM radar_adaptations').get()).toMatchObject({ n: 2 });
  });

  it('resumes after a crash without redoing finished steps; the failed judge loop rewrites at most twice', async () => {
    const rt = rtFor(db, { RADAR_ADAPT_TOP: '1' });
    let boom = true;
    const m = fakeModel({ judge: () => ({ hook: 4, specificity: 8, mechanism: 8, proof_honesty: 8, cta: 8 }) });
    const flaky: typeof m.ask = async (s, msgs) => { if (boom && s.startsWith('You name content formats')) { boom = false; throw new Error('model down'); } return m.ask(s, msgs); };
    const deps = depsWith(m, { models: (r) => ({ ask: m.ask, scriptAsk: m.ask, judgeAsk: m.ask, extractAsk: m.ask, nameAsk: flaky, brain: getBrain(r), model: 'workers-ai' }) });
    const id = await newRun(rt);
    const s = memoStep();
    // Naming failure is caught inside cluster (rule names), so make the cluster step itself fail once instead.
    let clusterFails = true;
    const step: StepLike = { do: (name, c, fn) => (name === 'cluster_formats' && clusterFails ? (clusterFails = false, Promise.reject(new Error('crash'))) : s.step.do(name, c, fn)), sleep: s.step.sleep };
    await expect(runRadarPipeline(async () => rt, id, step, deps)).rejects.toThrow('crash');
    const extracted = m.calls.extract;
    expect(extracted).toBe(6);
    await runRadarPipeline(async () => rt, id, step, deps);
    expect(m.calls.extract).toBe(extracted);
    expect(s.ran.filter((n) => n === 'extract_formats 0')).toHaveLength(1);
    expect(s.ran.filter((n) => n.startsWith('judge '))).toHaveLength(3);
    expect(s.ran.filter((n) => n.startsWith('rewrite '))).toHaveLength(2);
    expect(db.prepare('SELECT rounds, status, judge_score FROM radar_adaptations').get()).toMatchObject({ rounds: 2, status: 'stored', judge_score: 4 });
    expect((await getRun(rt, id))!.status).toBe('done');
  });

  it('inline: yields when its time is up, waits out a running sweep, and the cron resumes it', async () => {
    const rt = rtFor(db, { RADAR_ADAPT_TOP: '1' });
    const m = fakeModel();
    let active = 1;
    const deps = depsWith(m, { sweepActive: async () => active });
    const id = await newRun(rt);
    expect(await runInline(rt, id, 0, deps)).toMatchObject({ ran: true, done: false });
    expect((await getRun(rt, id))!.steps).toEqual({});
    // The sweep is still running: the step records it and the runner sleeps (lease = wake time).
    expect(await runInline(rt, id, 30_000, deps)).toMatchObject({ ran: true, done: false });
    const r1 = (await getRun(rt, id))!;
    expect(Object.keys(r1.steps)).toEqual(['sweep_runs 0', 'sweep_runs wait 0']);
    expect(Date.parse(r1.lease_until!)).toBeGreaterThan(Date.now() + 30_000);
    expect(await radarPipelineTick(rt, Date.now(), deps)).toMatchObject({ resumed: 0 }); // not due yet
    active = 0;
    expect(await radarPipelineTick(rt, Date.now() + 61_000, deps)).toMatchObject({ resumed: 1 });
    const r2 = (await getRun(rt, id))!;
    expect(r2.status).toBe('done');
    expect(Object.keys(r2.steps)).toEqual(expect.arrayContaining(['sweep_runs 1', 'cluster_formats', 'store_formats']));
  });

  it('start: one run at a time, the Workflow when bound, and the cron starts only after a finished sweep', async () => {
    const m = fakeModel();
    const created: unknown[] = [];
    const flow = { create: async (o: { id: string }) => { created.push(o); return { id: o.id }; } };
    const rt = rtFor(db, {}, { RADAR_FLOW: flow });
    const s = await startPipeline(rt, 'button', depsWith(m));
    expect(s).toMatchObject({ ok: true, mode: 'workflow' });
    expect(created).toEqual([{ id: s.id, params: { runId: s.id } }]);
    expect(await startPipeline(rt, 'button', depsWith(m))).toMatchObject({ ok: false, id: s.id });
    expect(await startPipeline(rtFor(freshDb()), 'button', depsWith(m, { models: () => null }))).toMatchObject({ ok: false, error: expect.stringMatching(/No analyst/) });

    const db2 = freshDb(); await seedItems(db2);
    const rt2 = rtFor(db2);
    expect(await radarPipelineTick(rt2, Date.now(), depsWith(m))).toMatchObject({ started: null }); // no sweep yet
    const ts = new Date().toISOString();
    db2.prepare("INSERT INTO radar_runs (id, slot, provider, endpoint, input_json, status, created_at, updated_at) VALUES ('s1', 'youtube:search', 'a', '/b', '{}', 'completed', ?, ?)").run(ts, ts);
    const t = await radarPipelineTick(rt2, Date.now(), depsWith(m));
    expect(t.started).toMatch(/^rp-/);
    await Promise.all(rt2.pending);
    expect((await getRun(rt2, t.started!))!.status).toBe('done');
    expect(await radarPipelineTick(rt2, Date.now(), depsWith(m))).toMatchObject({ started: null }); // within RADAR_PIPELINE_HOURS
    expect(await radarPipelineTick(rtFor(db2, { RADAR_PIPELINE_HOURS: '0' }), Date.now() + 2 * 86400_000, depsWith(m))).toMatchObject({ started: null });
  });

  it('the Workflow class runs the graph with the real model wiring (Workers AI stub)', async () => {
    const aiCalls: string[] = [];
    const AI = { run: async (_m: string, input: { messages: { content: string }[]; response_format?: { json_schema?: { properties?: Record<string, unknown> } } }) => {
      const p = input.response_format?.json_schema?.properties ?? {};
      const kind = 'format_name' in p ? 'extract' : 'original_skeleton' in p ? 'adapt' : 'scores' in p ? 'judge' : 'definition' in p ? 'name' : 'script';
      aiCalls.push(kind);
      const user = input.messages[1]?.content ?? '';
      const r = kind === 'extract' ? extractionFor(/Title: (.*)/.exec(user)?.[1] ?? '') : kind === 'adapt' ? ADAPTATION : kind === 'judge' ? { scores: { hook: 9, specificity: 9, mechanism: 9, proof_honesty: 9, cta: 9 }, notes: [], verdict: 'ok' } : kind === 'name' ? { name: 'Deal Teardown', definition: 'A.\nB.' } : SCRIPT;
      return { response: JSON.stringify(r) };
    } };
    const env = { DB: d1(db), AI, RADAR_ADAPT_TOP: '1' };
    const rt = rtFor(db);
    const id = await newRun(rt, 'rp-wf-1');
    const wf = new RadarPipelineWorkflow({ waitUntil: () => {} } as never, env as never);
    const out = await wf.run({ payload: { runId: id } } as never, memoStep().step as never);
    expect(out).toMatchObject({ adaptations: 1, formats: 4 });
    expect(aiCalls.filter((k) => k === 'extract')).toHaveLength(6);
    expect(aiCalls).toEqual(expect.arrayContaining(['name', 'adapt', 'judge', 'script']));
    expect(await wf.run({ payload: { runId: 'nope' } } as never, memoStep().step as never)).toEqual({ reason: 'bad run id' });
  });
});

// ───────────── the API on the whole worker ─────────────

const ORIGIN = 'https://apply.test';
let sdb: SqlDb;
let pending: Promise<unknown>[] = [];
const exCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); }, passThroughOnException: () => {} };
const envFor = () => ({
  DB: d1(sdb), SESSION_SECRET: 'env-session-secret-'.padEnd(40, 'z'), ADMIN_PASSWORD: 'devpass-owner-only', RADAR_ADAPT_TOP: '2',
  ASSETS: { fetch: async () => new Response('<!doctype html><html><body></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
  AI: { run: async (_m: string, input: { messages: { content: string }[]; response_format?: { json_schema?: { properties?: Record<string, unknown> } } }) => {
    const p = input.response_format?.json_schema?.properties ?? {};
    const user = input.messages[1]?.content ?? '';
    const r = 'format_name' in p ? extractionFor(/Title: (.*)/.exec(user)?.[1] ?? '') : 'original_skeleton' in p ? ADAPTATION : 'scores' in p ? { scores: { hook: 8, specificity: 8, mechanism: 8, proof_honesty: 8, cta: 8 }, notes: [], verdict: 'ok' } : 'definition' in p ? { name: 'Deal Teardown', definition: 'A.\nB.' } : SCRIPT;
    return { response: JSON.stringify(r) };
  } },
});
type App = { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> };
let app: App;
const call = async (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', '203.0.113.9');
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), envFor(), exCtx);
  await Promise.all(pending); pending = [];
  return res;
};
const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
const json = { ...same, 'content-type': 'application/json' };
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1) ?? '';
async function ownerCookie() { return cookieOf(await call('/admin/login', { method: 'POST', headers: { ...same, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=devpass-owner-only' }), '_fa'); }
async function guestCookie(owner: string) {
  const { url } = (await (await call('/admin/api/guest-access', { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ label: 'Viewer', days: 1 }) })).json()) as { url: string };
  return cookieOf(await call(new URL(url).pathname, { headers: { 'sec-fetch-site': 'cross-site' } }), '_fg');
}
const API = '/admin/api/radar/formats';

describe('routes: /admin/api/radar/formats*', () => {
  beforeAll(async () => {
    vi.stubGlobal('HTMLRewriter', class { on() { return this; } transform(r: Response) { return r; } });
    app = (await import('../src/index')).default as unknown as App;
  }, 60_000);
  beforeEach(async () => {
    sdb = freshDb(); await seedItems(sdb); pending = [];
    (await import('../src/settings')).resetSettingsCache();
    (await import('../src/lib/hq-cache')).memoryClear();
    (await import('../src/admin/guest')).resetGuestCaches();
  });

  it('needs an admin session; guests read but never run or adapt', async () => {
    expect((await call(API)).status).toBe(401);
    const owner = await ownerCookie();
    const g = await guestCookie(owner);
    expect((await call(API, { headers: { cookie: g } })).status).toBe(200);
    for (const p of ['/run', '/f/fmt_x/adapt', '/item/youtube:deal1/extract', '/item/youtube:deal1/adapt']) {
      expect((await call(API + p, { method: 'POST', headers: { ...json, cookie: g }, body: '{}' })).status, p).toBe(403);
    }
    expect(sdb.prepare('SELECT COUNT(*) AS n FROM radar_pipeline_runs').get()).toMatchObject({ n: 0 });
  });

  it('Run analysis → ranked formats with node states → the format sheet with the adaptation and its script', async () => {
    const owner = await ownerCookie();
    const empty = await (await call(API, { headers: { cookie: owner } })).json() as { formats: unknown[]; nodes: { state: string }[]; brain: string };
    expect(empty).toMatchObject({ formats: [], brain: 'workers-ai' });
    expect(empty.nodes.every((n) => n.state === 'idle')).toBe(true);
    const r = await call(`${API}/run`, { method: 'POST', headers: { ...json, cookie: owner }, body: '{}' });
    expect(await r.json()).toMatchObject({ ok: true, mode: 'inline' });
    const st = await (await call(API, { headers: { cookie: owner } })).json() as { formats: { id: string; name: string; white_space: number; adapted: boolean; judge_score: number | null; stats: { count: number } }[]; run: { status: string }; counts: { extracted: number } };
    expect(st.run.status).toBe('done');
    expect(st.counts.extracted).toBe(6);
    expect(st.formats).toHaveLength(4);
    expect(st.formats.filter((f) => f.adapted)).toHaveLength(2);
    const adapted = st.formats.find((f) => f.adapted)!;
    expect(adapted.judge_score).toBe(8);
    const sheet = await (await call(`${API}/f/${adapted.id}`, { headers: { cookie: owner } })).json() as { format: { id: string }; examples: { extraction: { format_name: string } }[]; adaptation: { data: { beats: unknown[]; hooks: string[] }; status: string }; script: { id: string; script: { beats: unknown[] } } };
    expect(sheet.examples[0].extraction.format_name).toBeTruthy();
    expect(sheet.adaptation).toMatchObject({ status: 'stored' });
    expect(sheet.adaptation.data.hooks).toHaveLength(5);
    expect(sheet.script.script.beats.length).toBeGreaterThan(0);
    expect((await call(`${API}/f/nope`, { headers: { cookie: owner } })).status).toBe(404);
    // The item sheet: the breakdown, then "how the script changes for us" on demand.
    const item = await (await call(`${API}/item/youtube:deal1`, { headers: { cookie: owner } })).json() as { extraction: { hook: { type: string } }; format: { id: string }; adaptation: unknown };
    expect(item).toMatchObject({ extraction: { hook: { type: 'result_first' } }, adaptation: null });
    const ia = await (await call(`${API}/item/youtube:deal1/adapt`, { method: 'POST', headers: { ...json, cookie: owner }, body: '{}' })).json() as { ok: boolean; adaptation: { item_id: string; status: string } };
    expect(ia).toMatchObject({ ok: true, adaptation: { item_id: 'youtube:deal1', status: 'stored' } });
    expect((await call(`${API}/run`, { method: 'POST', headers: { ...json, cookie: owner }, body: '{}' })).status).toBe(200); // the last run is done, so a new one starts
  });

  it('the Studio page loads the Radar module, whose browser JS parses', async () => {
    for (const f of ['public/assets/studio-radar.js']) execFileSync(process.execPath, ['--check', f]);
    const owner = await ownerCookie();
    const html = await (await call('/admin/studio', { headers: { cookie: owner } })).text();
    expect(html).toContain('/assets/studio-radar.js');
  });
});

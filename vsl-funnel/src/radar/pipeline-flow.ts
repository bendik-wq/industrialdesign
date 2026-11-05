import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { publicOrigin, type Runtime } from '../app';
import type { Env } from '../env';
import { loadSettings } from '../settings';
import { type Ask, askFor, brainOf, writeStudioScript } from '../studio/scripts';
import { ADAPT_SCHEMA, type AdaptDeps, JUDGE_SCHEMA, MAX_JUDGE_ROUNDS, adaptSourceForFormat, adaptStep, getAdaptation, judgeStep, rewriteStep, storeStep } from './adapt';
import { askJson } from './analyse';
import { getBrain } from './brain-provider';
import { queueTranscript, radarStep } from './engine';
import {
  EXTRACT_SCHEMA, type Extraction, type ExtractInput, NAME_SCHEMA, clusterAndStore, extractBatch, getFormat, hash, itemsToExtract, radarFormatConfig,
} from './formats';

/**
 * The Radar v2 analysis pipeline as a graph; node ids are the ones in docs/radar.graph.yaml (builder B's spec):
 *
 *   sweep_runs → transcribe → brain_context → extract_formats (map, batches) → cluster_formats (reduce)
 *     → adapt (map, top formats) → copy_gate → judge (blind) ⇄ rewrite (loop, max 2 rounds, while any score < 7)
 *     → store_formats
 *
 * It runs as the Workflow gl-radar-pipeline (binding RADAR_FLOW, class RadarPipelineWorkflow) when the binding
 * exists, and otherwise inline: the same function with a step runner that records each step's output in
 * radar_pipeline_runs.steps_json, yields when its time is up or a node waits, and is resumed by the 5-minute cron.
 * Every step is idempotent (extract skips items that have a format, adapt reuses an adaptation whose format members
 * have not changed, judge never re-judges a judged round), so a retried or resumed step does no double work.
 * The spec's sweep segment (load_radars, budget_check, normalise) is the existing engine (radarTick); sweep_runs here
 * waits for its runs to finish. Studio scripts are written in adapt (writeStudioScript), so store_scripts_queue is
 * already satisfied when store_formats runs.
 */

export const RADAR_GRAPH = {
  name: 'radar',
  spec: 'docs/radar.graph.yaml',
  nodes: [
    { id: 'sweep_runs', kind: 'map', label: 'Sweep done' },
    { id: 'transcribe', kind: 'map', label: 'Transcribe' },
    { id: 'brain_context', kind: 'memory_read', label: 'Brain' },
    { id: 'extract_formats', kind: 'map', label: 'Extract formats' },
    { id: 'cluster_formats', kind: 'reduce', label: 'Cluster' },
    { id: 'adapt', kind: 'map', label: 'Adapt for G&L' },
    { id: 'copy_gate', kind: 'check', label: 'Copy gate' },
    { id: 'judge', kind: 'judge', label: 'Blind judge', blind: true },
    { id: 'rewrite', kind: 'llm', label: 'Rewrite', max_rounds: MAX_JUDGE_ROUNDS },
    { id: 'store_formats', kind: 'side_effect', label: 'Store' },
  ],
  edges: [['sweep_runs', 'transcribe'], ['transcribe', 'brain_context'], ['brain_context', 'extract_formats'], ['extract_formats', 'cluster_formats'], ['cluster_formats', 'adapt'], ['adapt', 'copy_gate'], ['copy_gate', 'judge'], ['judge', 'rewrite'], ['rewrite', 'copy_gate'], ['judge', 'store_formats']],
} as const;
export type NodeId = (typeof RADAR_GRAPH.nodes)[number]['id'];

export interface StepLike {
  do<T>(name: string, config: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: number): Promise<void>;
}
const CFG = { retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' }, timeout: '15 minutes' };
const EXTRACT_BATCH = 6;
const WAIT_ROUNDS = 20;

export type Models = AdaptDeps & { extractAsk: Ask; nameAsk: Ask };
export interface PipelineDeps {
  /** The models, or null when no analyst is available (the model nodes are skipped and say so). */
  models(rt: Runtime): Models | null;
  /** How many search runs are still going (the sweep node waits for 0). */
  sweepActive(rt: Runtime): Promise<number>;
  /** Push the Monid runs along (radarStep). */
  stepRuns(rt: Runtime): Promise<unknown>;
  /** Builder A's auto-transcribe: queue transcripts for the top items without one. Returns how many were queued. */
  transcribe(rt: Runtime, o: { limit: number; now: number }): Promise<{ queued: number }>;
  /** How many transcript runs are still going. */
  transcriptsActive(rt: Runtime): Promise<number>;
}

export function modelsFor(rt: Runtime): Models | null {
  const model = brainOf(rt);
  if (!model) return null;
  return {
    model, brain: getBrain(rt),
    ask: askJson(rt, model, ADAPT_SCHEMA, 'radar-adapt'), scriptAsk: askFor(rt, model), judgeAsk: askJson(rt, model, JUDGE_SCHEMA, 'radar-judge'),
    extractAsk: askJson(rt, model, EXTRACT_SCHEMA, 'radar-extract'), nameAsk: askJson(rt, model, NAME_SCHEMA, 'radar-name'),
    write: (r, input) => writeStudioScript(r, model, input),
  };
}

/** The fallback transcribe node (builder A's auto-transcribe replaces it at merge): queue the top items' transcripts. */
async function queueTopTranscripts(rt: Runtime, o: { limit: number; now: number }) {
  const { results } = await rt.env.DB.prepare(
    `SELECT id FROM radar_items WHERE platform IN ('youtube','tiktok','instagram') AND transcript_source IS NOT 'pending' AND transcript_source IS NOT 'monid'
       AND id NOT IN (SELECT item_id FROM radar_item_formats WHERE error IS NULL) ORDER BY score DESC LIMIT ?`,
  ).bind(o.limit).all<{ id: string }>();
  let queued = 0;
  for (const r of results) { const q = await queueTranscript(rt, r.id, o.now); if (q.ok) queued++; else if (/budget|key/i.test(q.note ?? '')) break; }
  return { queued };
}

export const defaultDeps: PipelineDeps = {
  models: modelsFor,
  sweepActive: async (rt) => Number((await rt.env.DB.prepare("SELECT COUNT(*) AS n FROM radar_runs WHERE status IN ('pending','running') AND item_id IS NULL").first<{ n: number }>())?.n ?? 0),
  stepRuns: (rt) => radarStep(rt, { budgetMs: 20_000 }),
  transcribe: queueTopTranscripts,
  transcriptsActive: async (rt) => Number((await rt.env.DB.prepare("SELECT COUNT(*) AS n FROM radar_runs WHERE status IN ('pending','running') AND item_id IS NOT NULL").first<{ n: number }>())?.n ?? 0),
};

// ───────────── run records ─────────────

export interface RunRecord { id: string; trigger: string; status: string; node: string | null; steps: Record<string, { node: string; at: string; out: unknown }>; flow_id: string | null; lease_until: string | null; error: string | null; started_at: string; updated_at: string; finished_at: string | null }
const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
type DbRun = Omit<RunRecord, 'steps'> & { steps_json: string };
export async function getRun(rt: Runtime, id: string): Promise<RunRecord | null> {
  const r = await rt.env.DB.prepare('SELECT * FROM radar_pipeline_runs WHERE id = ?').bind(id).first<DbRun>();
  if (!r) return null;
  const { steps_json, ...rest } = r;
  return { ...rest, steps: parse(steps_json, {}) };
}
export async function latestRun(rt: Runtime) {
  const r = await rt.env.DB.prepare('SELECT id FROM radar_pipeline_runs ORDER BY started_at DESC LIMIT 1').first<{ id: string }>();
  return r ? getRun(rt, r.id) : null;
}
async function record(rt: Runtime, runId: string, name: string, node: NodeId, out: unknown) {
  const ts = new Date().toISOString();
  const run = await getRun(rt, runId);
  if (!run) return;
  run.steps[name] = { node, at: ts, out: out ?? null };
  await rt.env.DB.prepare('UPDATE radar_pipeline_runs SET steps_json = ?, node = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(run.steps), node, ts, runId).run();
}
async function finish(rt: Runtime, runId: string, status: 'done' | 'failed', error: string | null = null) {
  const ts = new Date().toISOString();
  await rt.env.DB.prepare('UPDATE radar_pipeline_runs SET status = ?, error = ?, lease_until = NULL, finished_at = ?, updated_at = ? WHERE id = ?').bind(status, error, ts, ts, runId).run();
}

/** Per node: done, working or waiting, with the summed outputs the UI shows. */
export function nodeStates(run: RunRecord | null) {
  const order = RADAR_GRAPH.nodes.map((n) => n.id);
  const cur = run?.node ? order.indexOf(run.node as NodeId) : -1;
  return RADAR_GRAPH.nodes.map((n, i) => {
    const steps = Object.values(run?.steps ?? {}).filter((s) => s.node === n.id);
    const state = !run ? 'idle' : run.status === 'done' ? (steps.length ? 'done' : 'skipped') : run.status === 'failed' && i === cur ? 'failed'
      : i === cur ? 'working' : i < cur || steps.length ? 'done' : 'waiting';
    return { id: n.id, label: n.label, kind: n.kind, state, steps: steps.length, last: steps.length ? steps[steps.length - 1].out : null };
  });
}

// ───────────── the graph ─────────────

/**
 * Run (or resume) one pipeline run. `rtOf` builds a fresh runtime per step (settings can change mid-run).
 * Returns a summary; marks the run done (or failed) at the end.
 */
export async function runRadarPipeline(rtOf: () => Promise<Runtime>, runId: string, step: StepLike, deps: PipelineDeps = defaultDeps) {
  const node = <T>(name: string, id: NodeId, fn: (rt: Runtime) => Promise<T>) =>
    step.do(name, CFG, async () => { const rt = await rtOf(); const out = await fn(rt); await record(rt, runId, name, id, out); return out; });

  // sweep: wait until the sweep's search runs have finished (pushing them along meanwhile).
  for (let i = 0; i < WAIT_ROUNDS; i++) {
    const s = await node(`sweep_runs ${i}`, 'sweep_runs', async (rt) => { let active = await deps.sweepActive(rt); if (active) { await deps.stepRuns(rt); active = await deps.sweepActive(rt); } return { active }; });
    if (!s.active) break;
    await step.sleep(`sweep_runs wait ${i}`, 60_000);
  }

  // transcribe: the top items without a transcript, then wait for those runs (text posts carry their own text).
  const t = await node('transcribe', 'transcribe', async (rt) => deps.transcribe(rt, { limit: Math.min(40, radarFormatConfig(rt).perSweep), now: Date.now() }));
  if (t.queued) {
    for (let i = 0; i < WAIT_ROUNDS; i++) {
      const w = await node(`transcribe poll ${i}`, 'transcribe', async (rt) => { let active = await deps.transcriptsActive(rt); if (active) { await deps.stepRuns(rt); active = await deps.transcriptsActive(rt); } return { active }; });
      if (!w.active) break;
      await step.sleep(`transcribe wait ${i}`, 60_000);
    }
  }

  // brain_context (memory_read): what the brain holds for this run (legend cards, verified facts); empty is fine.
  await node('brain_context', 'brain_context', async (rt) => {
    const m = deps.models(rt);
    if (!m) return { cards: 0, facts: false };
    const [cards, facts] = await Promise.all([m.brain.legendCards('viral format hook structure mechanism proof cta', 5), m.brain.glFacts()]);
    return { cards: cards.length, legends: cards.map((c) => c.legend), facts: Boolean(facts) };
  });

  // extract (map): plan the batch once, then extract in small steps; each step re-checks what still lacks a format.
  const plan = await node('extract_formats plan', 'extract_formats', async (rt) => {
    const has = deps.models(rt);
    if (!has) return { ids: [] as string[], note: 'No analyst is available, so formats were not read.' };
    return { ids: (await itemsToExtract(rt, radarFormatConfig(rt).perSweep)).map((i) => i.id), note: null };
  });
  for (let b = 0; b * EXTRACT_BATCH < plan.ids.length; b++) {
    await node(`extract_formats ${b}`, 'extract_formats', async (rt) => {
      const m = deps.models(rt);
      if (!m) return { done: 0, failed: 0, skipped: true };
      const ids = plan.ids.slice(b * EXTRACT_BATCH, (b + 1) * EXTRACT_BATCH);
      const todo = await itemsFor(rt, ids);
      const r = await extractBatch(rt, m.extractAsk, m.model, todo);
      return { done: r.done, failed: r.failed };
    });
  }

  // cluster (reduce): deterministic clusters, named by one model call each when their members changed.
  const c = await node('cluster_formats', 'cluster_formats', async (rt) => { const m = deps.models(rt); return clusterAndStore(rt, { ask: m?.nameAsk ?? null, brain: m?.model ?? null, runId }); });

  // adapt (map) → judge ⇄ rewrite → store, for the top formats (one white-space format always makes the list).
  const pick = await node('adapt plan', 'adapt', async (rt) => {
    const n = radarFormatConfig(rt).adaptTop;
    if (!n || !deps.models(rt)) return { ids: [] as string[] };
    const { results } = await rt.env.DB.prepare('SELECT id, white_space FROM radar_formats WHERE active = 1 ORDER BY rank DESC LIMIT 60').all<{ id: string; white_space: number }>();
    const ids = results.slice(0, n).map((r) => r.id);
    const ws = results.find((r) => r.white_space > 0);
    if (ws && !ids.includes(ws.id) && ids.length === n) ids[n - 1] = ws.id;
    return { ids };
  });
  const stored: string[] = [];
  for (const fid of pick.ids) {
    const a = await node(`adapt ${fid}`, 'adapt', async (rt) => {
      const m = deps.models(rt);
      const src = await formatSource(rt, fid);
      if (!m || !src) return { id: null as string | null, reused: false };
      return adaptStep(rt, m, src.src, { membersHash: src.membersHash, runId });
    });
    if (!a.id) continue;
    for (let round = 0; round <= MAX_JUDGE_ROUNDS; round++) {
      // copy_gate (check): auditCopy + scriptIssues ran inside adapt and rewrite (one fix each); record what is left.
      await node(`copy_gate ${fid} ${round}`, 'copy_gate', async (rt) => ({ flags: (await getAdaptation(rt, a.id!))?.flags.length ?? 0 }));
      const j = await node(`judge ${fid} ${round}`, 'judge', async (rt) => {
        const m = deps.models(rt);
        const r = m ? await judgeStep(rt, m, a.id!) : null;
        return r ? { min: r.min, pass: r.pass } : { min: 0, pass: true };
      });
      if (j.pass || round === MAX_JUDGE_ROUNDS) break;
      const rw = await node(`rewrite ${fid} ${round}`, 'rewrite', async (rt) => {
        const m = deps.models(rt);
        const src = await formatSource(rt, fid);
        return { rewritten: m && src ? await rewriteStep(rt, m, a.id!, src.src) : false };
      });
      if (!rw.rewritten) break;
    }
    stored.push(a.id);
  }
  const out = await node('store_formats', 'store_formats', async (rt) => { for (const id of stored) await storeStep(rt, id); return { adaptations: stored.length, formats: c.formats, white_space: c.white_space }; });
  await finish(await rtOf(), runId, 'done');
  return out;
}

async function itemsFor(rt: Runtime, ids: string[]): Promise<ExtractInput[]> {
  if (!ids.length) return [];
  const { results } = await rt.env.DB.prepare(
    `SELECT i.* FROM radar_items i LEFT JOIN radar_item_formats f ON f.item_id = i.id AND f.error IS NULL WHERE f.item_id IS NULL AND i.id IN (${ids.map(() => '?').join(',')})`,
  ).bind(...ids).all<ExtractInput>();
  return results;
}

export async function formatSource(rt: Runtime, fid: string) {
  const f = await getFormat(rt, fid);
  if (!f) return null;
  const ids = f.member_ids.slice(0, 3);
  const { results } = ids.length
    ? await rt.env.DB.prepare(`SELECT i.id, i.platform, i.title, f.data_json FROM radar_items i JOIN radar_item_formats f ON f.item_id = i.id WHERE i.id IN (${ids.map(() => '?').join(',')}) ORDER BY i.score DESC`).bind(...ids).all<{ id: string; platform: string; title: string | null; data_json: string }>()
    : { results: [] };
  const examples = results.map((r) => ({ platform: r.platform, title: r.title, extraction: parse<Extraction>(r.data_json, {} as Extraction) }));
  return { src: adaptSourceForFormat(f, examples), membersHash: f.members_hash ?? hash(f.member_ids.slice().sort().join(',')) };
}

// ───────────── starting, the inline runner, the cron ─────────────

class Yield extends Error { constructor() { super('yield'); this.name = 'Yield'; } }

/** A step runner for the inline mode: replays recorded steps, yields when time is up or a node sleeps. */
export function inlineStep(rt: Runtime, runId: string, deadline: number): StepLike {
  return {
    async do(name, _cfg, fn) {
      const run = await getRun(rt, runId);
      const done = run?.steps[name];
      if (done) return done.out as never;
      if (Date.now() >= deadline) throw new Yield();
      return fn();
    },
    async sleep(name, duration) {
      const run = await getRun(rt, runId);
      if (run?.steps[name]) return;
      const ts = new Date().toISOString();
      if (run) {
        run.steps[name] = { node: run.node ?? 'sweep_runs', at: ts, out: { slept: duration } };
        await rt.env.DB.prepare('UPDATE radar_pipeline_runs SET steps_json = ?, lease_until = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(run.steps), new Date(Date.now() + duration).toISOString(), ts, runId).run();
      }
      throw new Yield();
    },
  };
}

/** Run inline for up to `budgetMs`, holding a lease so two runners never work one run. */
export async function runInline(rt: Runtime, runId: string, budgetMs = 25_000, deps: PipelineDeps = defaultDeps, clock = Date.now()) {
  const now = clock;
  const claim = await rt.env.DB.prepare("UPDATE radar_pipeline_runs SET lease_until = ?, updated_at = ? WHERE id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until <= ?)")
    .bind(new Date(now + budgetMs + 15 * 60_000).toISOString(), new Date(now).toISOString(), runId, new Date(now).toISOString()).run();
  if (!(claim.meta?.changes ?? 0)) return { ran: false as const };
  try {
    const out = await runRadarPipeline(async () => rt, runId, inlineStep(rt, runId, Date.now() + budgetMs), deps);
    return { ran: true as const, done: true, out };
  } catch (e) {
    if (e instanceof Yield) {
      // Release the lease unless a sleep set a wake time.
      await rt.env.DB.prepare('UPDATE radar_pipeline_runs SET lease_until = CASE WHEN lease_until > ? THEN ? ELSE lease_until END WHERE id = ?')
        .bind(new Date(now + budgetMs + 60_000).toISOString(), new Date().toISOString(), runId).run();
      return { ran: true as const, done: false };
    }
    console.error('radar pipeline failed', e instanceof Error ? e.message : e);
    await finish(rt, runId, 'failed', String(e instanceof Error ? e.message : e).slice(0, 300));
    return { ran: true as const, done: false, error: true };
  }
}

export const PIPELINE_COPY = {
  running: 'The analysis is already running.',
  noBrain: 'No analyst is available here. Add the Anthropic key in Integrations, or run where Workers AI is available.',
};

/** Start a run (the "Run analysis" button or the cron). One run at a time. */
export async function startPipeline(rt: Runtime, trigger: 'button' | 'cron', deps: PipelineDeps = defaultDeps): Promise<{ ok: boolean; id?: string; error?: string; mode?: 'workflow' | 'inline' }> {
  const live = await rt.env.DB.prepare("SELECT id, updated_at FROM radar_pipeline_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1").first<{ id: string; updated_at: string }>();
  if (live && Date.now() - Date.parse(live.updated_at) < 6 * 3600_000) return { ok: false, id: live.id, error: PIPELINE_COPY.running };
  if (live) await finish(rt, live.id, 'failed', 'Stopped moving for six hours; a new run took over.');
  if (!deps.models(rt)) return { ok: false, error: PIPELINE_COPY.noBrain };
  const id = `rp-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  const ts = new Date().toISOString();
  await rt.env.DB.prepare("INSERT INTO radar_pipeline_runs (id, trigger, status, node, steps_json, started_at, updated_at) VALUES (?, ?, 'running', 'sweep', '{}', ?, ?)").bind(id, trigger, ts, ts).run();
  const flow = rt.env.RADAR_FLOW;
  if (flow) {
    try {
      const inst = await flow.create({ id, params: { runId: id } });
      await rt.env.DB.prepare('UPDATE radar_pipeline_runs SET flow_id = ? WHERE id = ?').bind(inst.id, id).run();
      return { ok: true, id, mode: 'workflow' };
    } catch (e) {
      console.error('radar: workflow start failed, running inline', e instanceof Error ? e.message : e);
    }
  }
  rt.waitUntil(runInline(rt, id, 25_000, deps).then(() => undefined));
  return { ok: true, id, mode: 'inline' };
}

/** The cron: resume inline runs that are due, and start a run after a finished sweep (RADAR_PIPELINE_HOURS). */
export async function radarPipelineTick(rt: Runtime, now = Date.now(), deps: PipelineDeps = defaultDeps) {
  const ts = new Date(now).toISOString();
  const { results } = await rt.env.DB.prepare("SELECT id FROM radar_pipeline_runs WHERE status = 'running' AND flow_id IS NULL AND (lease_until IS NULL OR lease_until <= ?) ORDER BY started_at LIMIT 1").bind(ts).all<{ id: string }>();
  let resumed = 0;
  for (const r of results) { const x = await runInline(rt, r.id, 120_000, deps, now); if (x.ran) resumed++; }
  const h = Number(rt.settings.RADAR_PIPELINE_HOURS);
  const hours = rt.settings.RADAR_PIPELINE_HOURS === '' || !isFinite(h) ? 24 : Math.max(0, h);
  if (!hours || results.length || !deps.models(rt)) return { resumed, started: null };
  const last = await rt.env.DB.prepare('SELECT started_at FROM radar_pipeline_runs ORDER BY started_at DESC LIMIT 1').first<{ started_at: string }>();
  if (last && now - Date.parse(last.started_at) < hours * 3600_000) return { resumed, started: null };
  // Only after a sweep: a search run finished since the last analysis, and none is still going.
  const swept = await rt.env.DB.prepare("SELECT COUNT(*) AS n FROM radar_runs WHERE item_id IS NULL AND status = 'completed' AND updated_at > ?").bind(last?.started_at ?? '').first<{ n: number }>();
  if (!Number(swept?.n ?? 0) || (await deps.sweepActive(rt))) return { resumed, started: null };
  const s = await startPipeline(rt, 'cron', deps);
  return { resumed, started: s.ok ? s.id ?? null : null };
}

// ───────────── the Workflow ─────────────

export class RadarPipelineWorkflow extends WorkflowEntrypoint<Env, { runId: string }> {
  async run(event: Readonly<WorkflowEvent<{ runId: string }>>, step: WorkflowStep) {
    const runId = String(event.payload?.runId ?? '');
    if (!/^rp-[a-z0-9-]{4,60}$/.test(runId)) return { reason: 'bad run id' };
    const env = this.env;
    const ctx = this.ctx as unknown as { waitUntil?: (p: Promise<unknown>) => void };
    const rtOf = async (): Promise<Runtime> => { const settings = await loadSettings(env); return { env, settings, reps: [], origin: publicOrigin(settings, 'https://example.com'), waitUntil: (p) => (ctx.waitUntil ? ctx.waitUntil(p) : void p) }; };
    try {
      return await runRadarPipeline(rtOf, runId, step as unknown as StepLike);
    } catch (e) {
      await finish(await rtOf(), runId, 'failed', String(e instanceof Error ? e.message : e).slice(0, 300));
      throw e;
    }
  }
}

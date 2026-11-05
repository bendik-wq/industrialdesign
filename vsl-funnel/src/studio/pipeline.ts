import type Anthropic from '@anthropic-ai/sdk';
import type { Runtime } from '../app';
import { REASONING_MODEL, parseJsonReply } from '../ops/claude';
import { anthropicClient, runWorkersAi } from '../infra/ai-gateway';
import { googleAccess, googleReady } from '../content/video-pack';
import { DriveError, driveImportStep, driveName, driveStatus, driveUploadStep, listFolderVideos, pickNewFiles } from './drive';
import { type EditorJob, blobUrl, editorFetch, editorJson, engineStatus } from './editor';
import { type Probe, buildRenderJob, resolutionLabel } from './ffmpeg';
import { brainContext } from '../brain/prompt';
import { type EditPlan, type PlanInput, type Silence, type Transcript, cleanMarkers, fmtDuration, planPrompt, rulesPlan, validatePlan, whisperChunk } from './plan';
import { type Status, type VideoRow, addEvent, claim, delState, delStatePrefix, getState, getVideo, isActive, iso, moveTo, parseJson, patchVideo, release, setState } from './store';

/**
 * G&L Studio: the pipeline. `advance` does the next bounded piece of work for one video and says when to come back;
 * the Workflow gl-studio-pipeline calls it in durable steps (src/studio/workflow.ts), and the 5-minute cron calls it
 * for anything not moving (and for everything when the Workflow binding is missing). A lease makes sure only one of
 * them works on a video at a time.
 *
 *   uploaded      raw → Drive "<date> <title> (raw).<ext>" (resumable), then queued
 *   in_drive      a Drive import being copied into R2; then queued (or skipped when automatic editing is off)
 *   queued        waits for the editor; starts the container's analyse job
 *   transcribing  analyse (probe, silences, 16 kHz chunks, thumbnail), then Whisper chunk by chunk
 *   planning      Claude, else Workers AI, else the rules plan; validated and clamped in code
 *   rendering     the container renders at the source resolution and uploads the edit and shorts to R2
 *   delivering    edit (and shorts) → Drive "<date> <title> (edited, 4K).mp4", then done
 * Errors: retried with backoff (1, 2, 4, 8, 16 min); the sixth failure marks the video failed with a plain sentence,
 * and Retry starts again from that stage.
 */

export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const LLAMA_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const MAX_TRIES = 5;
const LEASE_MS = 15 * 60_000;
const LINK_TTL = 36 * 3600_000;
const POLL_MS = 20_000;

export type Advance = { waitMs: number; done: boolean; status?: Status };
const DONE = (status?: Status): Advance => ({ waitMs: 0, done: true, status });
const later = (ms: number, status?: Status): Advance => ({ waitMs: ms, done: false, status });

const on = (v: string | undefined, dflt: boolean) => { const s = String(v ?? '').trim().toLowerCase(); return s ? !['off', '0', 'false', 'no'].includes(s) : dflt; };
export const studioFlags = (rt: Pick<Runtime, 'settings'>) => {
  const s = rt.settings as Record<string, string>;
  const hours = Number(s.STUDIO_SCAN_HOURS);
  return {
    autoEdit: on(s.STUDIO_AUTO_EDIT, true),
    captions: on(s.STUDIO_CAPTIONS, true),
    shorts: on(s.STUDIO_SHORTS, true),
    scanHours: Number.isFinite(hours) && hours > 0 ? Math.min(48, Math.max(1, hours)) : 6,
    preset: (s.STUDIO_PRESET || 'medium').trim().toLowerCase(),
    model: (s.STUDIO_AI_MODEL || '').trim() || REASONING_MODEL,
  };
};
export const brainName = (rt: Pick<Runtime, 'settings'>) => (planBrain || rt.settings.ANTHROPIC_API_KEY ? 'claude' : 'workers-ai') as 'claude' | 'workers-ai';

const day = (isoStr: string) => isoStr.slice(0, 10);
const ext = (key: string | null) => (/\.(\w{2,4})$/.exec(key ?? '')?.[1] ?? 'mp4').toLowerCase();
const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

// ───────────── test seams ─────────────

export type Brain = (rt: Runtime, ask: { system: string; user: string; model: string }) => Promise<string | null>;
let planBrain: Brain | null = null;
/** Tests: replace the Claude call (null restores it). */
export function setStudioBrain(b: Brain | null) { planBrain = b; }
let fetcher: typeof fetch | undefined;
/** Tests: the fetch used for Google. */
export function setStudioFetch(f: typeof fetch | undefined) { fetcher = f; }

// ───────────── the driver ─────────────

/** Advance one video once (under its lease). Never throws: errors become retries or a failed status. */
export async function advance(rt: Runtime, id: string, now = Date.now()): Promise<Advance> {
  if (!(await claim(rt.env, id, LEASE_MS, now))) return later(60_000);
  let res: Advance = later(60_000);
  try {
    const v = await getVideo(rt.env, id);
    if (!v) return (res = DONE());
    if (!isActive(v.status)) return (res = DONE(v.status));
    try {
      res = await step(rt, v);
      if (res.status && res.status !== v.status) await delState(rt.env, `tries:${id}`); // a new stage starts with a clean slate
    } catch (e) {
      res = await onError(rt, v, e);
    }
    return res;
  } finally {
    await release(rt.env, id, res.done ? null : Date.now() + res.waitMs).catch(() => {});
  }
}

/** Keeps advancing while there is immediate work, for up to `budgetMs`. */
export async function runFor(rt: Runtime, id: string, budgetMs: number): Promise<Advance> {
  const start = Date.now();
  let r: Advance = later(0);
  while (Date.now() - start < budgetMs) {
    r = await advance(rt, id);
    if (r.done || r.waitMs > 2000) return r;
  }
  return r;
}

const plain = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 400);

async function onError(rt: Runtime, v: VideoRow, e: unknown): Promise<Advance> {
  const msg = plain(e);
  const retryable = !(e instanceof DriveError) || e.retryable;
  const tries = Number((await getState(rt.env, `tries:${v.id}`)) ?? 0) + 1;
  console.error(`studio ${v.id} ${v.status}: ${msg}`);
  if (retryable && tries <= MAX_TRIES) {
    await setState(rt.env, `tries:${v.id}`, String(tries));
    const wait = 60_000 * 2 ** (tries - 1);
    await patchVideo(rt.env, v.id, { stage_detail: `Trying again in ${Math.round(wait / 60_000)} min: ${msg}`.slice(0, 300) });
    if (tries === 1) await addEvent(rt.env, v.id, v.status, `Hit a problem, trying again: ${msg}`);
    return later(wait);
  }
  await delState(rt.env, `tries:${v.id}`);
  await moveTo(rt.env, v, 'failed', { error: msg, failed_stage: v.status, stage_detail: null });
  await addEvent(rt.env, v.id, 'failed', `Stopped: ${msg}`);
  return DONE('failed');
}

async function step(rt: Runtime, v: VideoRow): Promise<Advance> {
  switch (v.status) {
    case 'uploaded': return stepUploaded(rt, v);
    case 'in_drive': return stepInDrive(rt, v);
    case 'queued': return stepQueued(rt, v);
    case 'transcribing': return stepTranscribing(rt, v);
    case 'planning': return stepPlanning(rt, v);
    case 'rendering': return stepRendering(rt, v);
    case 'delivering': return stepDelivering(rt, v);
    default: return DONE(v.status);
  }
}

// ───────────── uploaded: the raw goes to Drive ─────────────

async function afterRaw(rt: Runtime, v: VideoRow): Promise<Advance> {
  const flags = studioFlags(rt);
  const go = await getState(rt.env, `go:${v.id}`);
  if (!flags.autoEdit && !go) {
    await moveTo(rt.env, v, 'skipped', { stage_detail: 'Automatic editing is off. Press Edit to start.' });
    await addEvent(rt.env, v.id, 'skipped', 'Waiting for you: automatic editing is off');
    return DONE('skipped');
  }
  await delState(rt.env, `go:${v.id}`);
  await moveTo(rt.env, v, 'queued', { stage_detail: 'Waiting for the editor' });
  await addEvent(rt.env, v.id, 'queued', 'Queued for editing');
  return later(0, 'queued');
}

async function stepUploaded(rt: Runtime, v: VideoRow): Promise<Advance> {
  if (v.drive_raw_id) return afterRaw(rt, v);
  const ds = await driveStatus(rt, { fetcher });
  if (!ds.connected || !ds.scopeOk) {
    await addEvent(rt.env, v.id, 'uploaded', ds.connected ? 'Google Drive needs to be connected again (full Drive access), so the raw stays in Studio storage for now' : 'Google Drive is not connected, so the raw stays in Studio storage');
    return afterRaw(rt, v);
  }
  if (!v.raw_key || !v.raw_size || !rt.env.STUDIO) throw new DriveError('The recording is missing from Studio storage.', 0, false);
  const r = await driveUploadStep(rt, {
    stateKey: `dup:${v.id}:raw`, bucket: rt.env.STUDIO, key: v.raw_key, size: v.raw_size, folder: ds.folderId, studioId: v.id, kind: 'raw',
    name: driveName(day(v.created_at), v.title ?? '', 'raw', ext(v.raw_key)), mime: v.mime?.split(';')[0] || 'video/webm',
  }, { fetcher });
  if (!r.done) {
    await patchVideo(rt.env, v.id, { progress: r.offset / r.size, stage_detail: `Uploading the raw to Drive, ${gb(r.offset)} of ${gb(r.size)}` });
    return later(0);
  }
  await moveTo(rt.env, v, 'in_drive', { drive_raw_id: r.id ?? null, drive_raw_link: r.link ?? null, stage_detail: 'Raw in Drive' });
  await addEvent(rt.env, v.id, 'in_drive', 'Uploaded the raw recording to Drive');
  return afterRaw(rt, v);
}

// ───────────── in_drive: a Drive import is copied in ─────────────

export const IMPORT_PART = 64 * 1024 * 1024;

async function stepInDrive(rt: Runtime, v: VideoRow): Promise<Advance> {
  if (v.source === 'drive' && v.drive_raw_id && !v.upload_id && v.raw_key && v.raw_size && (await rt.env.STUDIO?.head(v.raw_key))) return afterRaw(rt, v);
  if (v.source !== 'drive') return afterRaw(rt, v);
  if (!rt.env.STUDIO) throw new Error('Studio storage is not connected here.');
  const flags = studioFlags(rt);
  if (!flags.autoEdit && !(await getState(rt.env, `go:${v.id}`))) return afterRaw(rt, v);
  const parts = parseJson<Record<string, { e: string; s: number }>>(v.parts_json, {});
  const r = await driveImportStep(rt, { bucket: rt.env.STUDIO, key: v.raw_key!, size: v.raw_size!, fileId: v.drive_raw_id!, mime: v.mime || 'video/mp4', uploadId: v.upload_id, parts, partSize: IMPORT_PART }, { fetcher });
  if (!r.done) {
    await patchVideo(rt.env, v.id, { upload_id: r.uploadId, parts_json: JSON.stringify(r.parts), progress: r.copied / (v.raw_size || 1), stage_detail: `Copying from Drive, ${gb(r.copied)} of ${gb(v.raw_size!)}` });
    return later(0);
  }
  await patchVideo(rt.env, v.id, { upload_id: null, parts_json: null, progress: 1, stage_detail: 'Copied from Drive' });
  await addEvent(rt.env, v.id, 'in_drive', `Copied from Drive (${gb(v.raw_size!)})`);
  return afterRaw(rt, { ...v, upload_id: null });
}

// ───────────── queued → transcribing ─────────────

async function stepQueued(rt: Runtime, v: VideoRow): Promise<Advance> {
  const eng = engineStatus(rt);
  if (!eng.ready) {
    if (v.stage_detail !== eng.detail) await patchVideo(rt.env, v.id, { stage_detail: eng.detail });
    return later(15 * 60_000);
  }
  await delStatePrefix(rt.env, `tx:${v.id}`);
  await delState(rt.env, `render:${v.id}`);
  await moveTo(rt.env, v, 'transcribing', { stage_detail: 'Starting the editor', analysis_key: null, transcript_key: null });
  await addEvent(rt.env, v.id, 'transcribing', 'The editor started on it');
  return later(0, 'transcribing');
}

interface Analysis { probe: Probe & { size?: number }; silences: Silence[]; chunks: { n: number; file: string; start: number; end: number }[]; thumb: boolean }

async function startAnalyze(rt: Runtime, v: VideoRow) {
  const body = {
    id: v.id, kind: 'analyze', rawSize: v.raw_size, chunkSeconds: 30, silenceDb: -35, silenceMin: 0.6,
    rawUrl: await blobUrl(rt, v.id, 'raw', LINK_TTL), progressUrl: await blobUrl(rt, v.id, 'progress', LINK_TTL), thumbUrl: await blobUrl(rt, v.id, 'thumb', LINK_TTL),
  };
  const r = await editorJson<{ error?: string }>(rt.env, v.id, '/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status >= 300) throw new Error(`The editor refused the job: ${r.body?.error ?? r.status}`);
  await setState(rt.env, `tx:${v.id}:job`, String(Date.now()));
}

async function stepTranscribing(rt: Runtime, v: VideoRow): Promise<Advance> {
  if (!rt.env.STUDIO || !rt.env.AI) throw new Error('Studio storage or Workers AI is not connected here.');
  // 1. Analyse in the container.
  if (!v.analysis_key) {
    if (!(await getState(rt.env, `tx:${v.id}:job`))) { await startAnalyze(rt, v); return later(5000); }
    const j = await editorJson<EditorJob<Analysis>>(rt.env, v.id, `/jobs/${v.id}`);
    if (j.status === 404 || !j.body) { await startAnalyze(rt, v); await addEvent(rt.env, v.id, 'transcribing', 'The editor restarted; reading the recording again'); return later(5000); }
    if (j.body.state === 'running' || j.body.kind !== 'analyze') { await patchVideo(rt.env, v.id, { progress: (j.body.progress || 0) * 0.5, stage_detail: j.body.detail || 'Reading the recording' }); return later(POLL_MS); }
    if (j.body.state === 'failed') { await delState(rt.env, `tx:${v.id}:job`); throw new Error(`The editor could not read the recording: ${j.body.error ?? 'unknown error'}`); }
    const a = j.body.result!;
    const key = `analysis/${v.id}.json`;
    await rt.env.STUDIO.put(key, JSON.stringify(a), { httpMetadata: { contentType: 'application/json' } });
    const p = a.probe;
    await patchVideo(rt.env, v.id, {
      analysis_key: key, probe_json: JSON.stringify(p), duration_s: p.duration || v.duration_s, width: p.width || v.width, height: p.height || v.height,
      thumb_key: a.thumb ? `thumbs/${v.id}.jpg` : null, progress: 0.5, stage_detail: a.chunks.length ? 'Transcribing' : 'No sound to transcribe',
    });
    const silent = a.silences.filter((s) => s.end - s.start >= 0.6).reduce((t, s) => t + s.end - s.start, 0);
    await addEvent(rt.env, v.id, 'transcribing', `Read the recording: ${p.width}x${p.height}, ${Math.round(p.fps)} fps, ${fmtDuration(p.duration)}${silent >= 1 ? `, ${fmtDuration(silent)} of silence` : ''}`);
    return later(0);
  }
  // 2. Whisper, chunk by chunk (the partial transcript is kept in R2 so a restart carries on).
  const a = parseJson<Analysis | null>(await (await rt.env.STUDIO.get(v.analysis_key))?.text(), null);
  if (!a) { await patchVideo(rt.env, v.id, { analysis_key: null }); await delState(rt.env, `tx:${v.id}:job`); return later(0); }
  const partialKey = `transcripts/${v.id}.partial.json`;
  let next = Number((await getState(rt.env, `tx:${v.id}:next`)) ?? 0);
  const tr: Transcript = next ? parseJson<Transcript>(await (await rt.env.STUDIO.get(partialKey))?.text(), { words: [], segments: [] }) : { words: [], segments: [] };
  const started = Date.now();
  while (next < a.chunks.length && Date.now() - started < 25_000) {
    const c = a.chunks[next];
    const r = await editorFetch(rt.env, v.id, `/files/${v.id}/audio/${c.file}`);
    if (r.status === 404) {
      // The container lost its disk (restarted): read the recording again.
      await patchVideo(rt.env, v.id, { analysis_key: null });
      await delStatePrefix(rt.env, `tx:${v.id}`);
      return later(0);
    }
    if (!r.ok) throw new Error(`The editor did not hand over audio chunk ${next + 1}`);
    const audio = new Uint8Array(await r.arrayBuffer());
    let out: unknown = null;
    if (audio.byteLength > 1000) out = await runWorkersAi(rt.env.AI as never, rt.settings, 'studio-transcribe', WHISPER_MODEL, { audio: b64(audio), task: 'transcribe', vad_filter: false });
    const piece = whisperChunk(out, c.start);
    tr.words.push(...piece.words);
    tr.segments.push(...piece.segments);
    next++;
    await rt.env.STUDIO.put(partialKey, JSON.stringify(tr));
    await setState(rt.env, `tx:${v.id}:next`, String(next));
    await patchVideo(rt.env, v.id, { progress: 0.5 + 0.5 * (next / a.chunks.length), stage_detail: `Transcribing, ${next} of ${a.chunks.length} pieces` });
  }
  if (next < a.chunks.length) return later(0);
  const key = `transcripts/${v.id}.json`;
  await rt.env.STUDIO.put(key, JSON.stringify(tr), { httpMetadata: { contentType: 'application/json' } });
  await rt.env.STUDIO.delete(partialKey).catch(() => {});
  await delStatePrefix(rt.env, `tx:${v.id}`);
  await moveTo(rt.env, v, 'planning', { transcript_key: key, stage_detail: 'Planning the edit' });
  await addEvent(rt.env, v.id, 'planning', tr.words.length ? `Transcribed ${tr.words.length} words` : 'No speech found; editing on silences and markers');
  return later(0, 'planning');
}

const b64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

// ───────────── planning ─────────────

async function claudePlan(rt: Runtime, system: string, user: string, model: string): Promise<string | null> {
  if (planBrain) return planBrain(rt, { system, user, model });
  const key = rt.settings.ANTHROPIC_API_KEY;
  if (!key) return null;
  const client = anthropicClient(rt.settings, 'studio-plan', { apiKey: key, maxRetries: 2, timeout: 10 * 60_000 });
  const msg = await client.messages.stream({ model, max_tokens: 16_000, system, messages: [{ role: 'user', content: user }] }).finalMessage();
  if (msg.stop_reason === 'refusal') return null;
  return msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
}

async function workersAiPlan(rt: Runtime, input: PlanInput, brain = ''): Promise<string | null> {
  if (!rt.env.AI) return null;
  const { system: base, user } = planPrompt(input, 40_000);
  const system = brain ? `${base}\n\n${brain}` : base;
  const r = await runWorkersAi<{ response?: unknown }>(rt.env.AI as never, rt.settings, 'studio-plan', LLAMA_MODEL, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 4096, temperature: 0.2 });
  const out = r?.response;
  return typeof out === 'string' ? out : out ? JSON.stringify(out) : null;
}

/** The plan for a video: Claude, else Workers AI, else the rules; always validated. */
export async function makePlan(rt: Runtime, input: PlanInput): Promise<{ plan: EditPlan; brain: 'claude' | 'workers-ai' | 'rules'; issues: string[]; note?: string }> {
  const flags = studioFlags(rt);
  const { system: base, user } = planPrompt(input);
  // The brain (copy legends, persuasion, G&L notes) shapes the title, description, chapter names and short-clip titles.
  const said = input.transcript.segments.map((x) => x.text).join(' ').slice(0, 600);
  const brain = await brainContext(rt, `YouTube title, description, chapter titles and short clip hooks for a video: ${input.title} ${said}`, { scope: 'copy', legends: 3, hits: 4, maxChars: 2500 }).catch(() => '');
  const system = brain ? `${base}\n\n${brain}` : base;
  const tries: { brain: 'claude' | 'workers-ai'; run: () => Promise<string | null> }[] = [
    { brain: 'claude', run: () => claudePlan(rt, system, user, flags.model) },
    { brain: 'workers-ai', run: () => workersAiPlan(rt, input, brain) },
  ];
  const notes: string[] = [];
  for (const t of tries) {
    try {
      const raw = parseJsonReply<Record<string, unknown>>(await t.run());
      if (!raw) continue;
      const v = validatePlan(raw, input);
      return { plan: v.plan, brain: t.brain, issues: v.issues, note: notes.join('; ') || undefined };
    } catch (e) {
      notes.push(`${t.brain === 'claude' ? 'Claude' : 'Workers AI'} did not answer (${plain(e).slice(0, 120)})`);
    }
  }
  return { plan: rulesPlan(input), brain: 'rules', issues: [], note: notes.join('; ') || undefined };
}

async function stepPlanning(rt: Runtime, v: VideoRow): Promise<Advance> {
  if (!rt.env.STUDIO || !v.transcript_key) throw new Error('The transcript is missing.');
  const tr = parseJson<Transcript>(await (await rt.env.STUDIO.get(v.transcript_key))?.text(), { words: [], segments: [] });
  const a = v.analysis_key ? parseJson<Analysis | null>(await (await rt.env.STUDIO.get(v.analysis_key))?.text(), null) : null;
  const probe = parseJson<Probe | null>(v.probe_json, null);
  const duration = probe?.duration || v.duration_s || 0;
  if (!(duration > 0)) throw new Error('The recording has no length.');
  const input: PlanInput = { title: v.title ?? '', duration, transcript: tr, silences: a?.silences ?? [], markers: cleanMarkers(parseJson(v.markers_json, []), duration), layout: v.layout, notes: v.notes };
  const { plan, brain, issues, note } = await makePlan(rt, input);
  await moveTo(rt.env, v, 'rendering', { plan_json: JSON.stringify({ ...plan, issues }), plan_brain: brain, stage_detail: 'Rendering' });
  const who = brain === 'claude' ? 'Claude' : brain === 'workers-ai' ? 'Workers AI' : 'the rules (silences, filler words, retakes)';
  await addEvent(rt.env, v.id, 'planning', `${plan.summary}. Planned by ${who}; the edit runs ${fmtDuration(plan.keptS)} of ${fmtDuration(duration)}`);
  if (note) await addEvent(rt.env, v.id, 'planning', note);
  return later(0, 'rendering');
}

// ───────────── rendering ─────────────

interface RenderResult { outputs: { file: string; size: number; probe: Probe | null }[]; timings: { name: string; ms: number; fps: number | null; speed: number | null }[] }
interface RenderState { started: number; restarts: number; shorts: { n: number; in: number; out: number; title: string; width: number; height: number }[]; keptS: number }

async function startRender(rt: Runtime, v: VideoRow, restarts: number) {
  const flags = studioFlags(rt);
  const plan = parseJson<EditPlan | null>(v.plan_json, null);
  const probe = parseJson<Probe | null>(v.probe_json, null);
  if (!plan || !probe) throw new Error('The plan or the recording details are missing.');
  const tr = v.transcript_key ? parseJson<Transcript>(await (await rt.env.STUDIO!.get(v.transcript_key))?.text(), { words: [], segments: [] }) : { words: [], segments: [] };
  const job = buildRenderJob(plan, probe, { captions: flags.captions, shorts: flags.shorts, preset: flags.preset, layout: v.layout, words: tr.words, title: plan.title });
  const uploads = await Promise.all(job.uploads.map(async (u) => ({ ...u, url: await blobUrl(rt, v.id, u.kind, LINK_TTL) })));
  const body = { id: v.id, kind: 'render', rawSize: v.raw_size, rawUrl: await blobUrl(rt, v.id, 'raw', LINK_TTL), progressUrl: await blobUrl(rt, v.id, 'progress', LINK_TTL), steps: job.steps, files: job.files, uploads };
  const r = await editorJson<{ error?: string }>(rt.env, v.id, '/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status >= 300) throw new Error(`The editor refused the render: ${r.body?.error ?? r.status}`);
  const st: RenderState = { started: Date.now(), restarts, shorts: job.shorts.map(({ n, in: a, out, title, width, height }) => ({ n, in: a, out, title, width, height })), keptS: job.keptS };
  await setState(rt.env, `render:${v.id}`, st);
  if (!restarts) await addEvent(rt.env, v.id, 'rendering', `Rendering at ${probe.width}x${probe.height}, ${Math.round(job.fps)} fps${flags.captions && job.files['captions.ass'] ? ', with captions' : ''}${job.shorts.length ? `, plus ${job.shorts.length} short${job.shorts.length === 1 ? '' : 's'}` : ''}`);
}

async function stepRendering(rt: Runtime, v: VideoRow): Promise<Advance> {
  if (!rt.env.STUDIO) throw new Error('Studio storage is not connected here.');
  const st = await getState<RenderState>(rt.env, `render:${v.id}`, true);
  if (!st) { await startRender(rt, v, 0); return later(POLL_MS); }
  const j = await editorJson<EditorJob<RenderResult>>(rt.env, v.id, `/jobs/${v.id}`);
  if (j.status === 404 || !j.body || (j.body.kind !== 'render' && j.body.state !== 'running')) {
    if (st.restarts >= 2) throw new Error('The editor stopped three times during the render.');
    await addEvent(rt.env, v.id, 'rendering', 'The editor restarted; starting the render again');
    await startRender(rt, v, st.restarts + 1);
    return later(POLL_MS);
  }
  if (j.body.state === 'running') {
    if (j.body.kind === 'render') await patchVideo(rt.env, v.id, { progress: j.body.progress || 0, stage_detail: j.body.detail || 'Rendering' });
    return later(POLL_MS);
  }
  if (j.body.state === 'failed') { await delState(rt.env, `render:${v.id}`); throw new Error(`The render failed: ${j.body.error ?? 'unknown error'}`); }
  const res = j.body.result!;
  const edited = res.outputs.find((o) => o.file === 'edited.mp4');
  const probe = parseJson<Probe | null>(v.probe_json, null);
  if (!edited) throw new Error('The render made no edited file.');
  const head = await rt.env.STUDIO.head(`edited/${v.id}.mp4`);
  if (!head) throw new Error('The edited file did not reach Studio storage.');
  const w = edited.probe?.width ?? probe?.width ?? null, h = edited.probe?.height ?? probe?.height ?? null;
  // Never smaller than the source (odd sizes lose one pixel to the encoder's even-size rule).
  if (probe && w && h && (probe.width - w > 1 || probe.height - h > 1)) throw new Error(`The edit came out at ${w}x${h}, below the source ${probe.width}x${probe.height}.`);
  const shorts = st.shorts.filter((s) => res.outputs.some((o) => o.file === `short-${s.n}.mp4`)).map((s) => ({ ...s, key: `shorts/${v.id}-${s.n}.mp4`, size: res.outputs.find((o) => o.file === `short-${s.n}.mp4`)!.size }));
  const render = res.timings.find((t) => t.name === 'render');
  await moveTo(rt.env, v, 'delivering', { edited_key: `edited/${v.id}.mp4`, edited_size: head.size, edited_width: w, edited_height: h, shorts_json: JSON.stringify(shorts), stage_detail: 'Delivering' });
  await delState(rt.env, `render:${v.id}`);
  await addEvent(rt.env, v.id, 'rendering', `Rendered the edit at ${w}x${h} (${resolutionLabel(w ?? 0, h ?? 0)}), ${gb(head.size)}${render?.speed ? `, ${render.speed}x real time` : ''}${shorts.length ? `, and ${shorts.length} short${shorts.length === 1 ? '' : 's'}` : ''}`);
  // Smooth playback anywhere: a copy goes to Cloudflare Stream when a Stream token is set (never blocks delivery).
  const fresh = await getVideo(rt.env, v.id);
  if (fresh) await import('./routes').then((m) => m.sendEditToStream(rt, fresh, true)).then((r) => r?.ok ? addEvent(rt.env, v.id, 'rendering', 'Sent to Cloudflare Stream for playback') : r ? addEvent(rt.env, v.id, 'rendering', `Stream copy skipped: ${r.error}`) : null).catch(() => null);
  return later(0, 'delivering');
}

// ───────────── delivering ─────────────

function driveDescription(plan: EditPlan | null) {
  if (!plan) return undefined;
  const ch = plan.chapters.map((c) => `${fmtStamp(toEdited(plan, c.t))} ${c.title}`).join('\n');
  return [plan.description, ch].filter(Boolean).join('\n\n').slice(0, 4000);
}
const toEdited = (plan: EditPlan, t: number) => { let acc = 0; for (const r of plan.keep) { if (t <= r.out) return acc + Math.max(0, t - r.in); acc += r.out - r.in; } return acc; };
const fmtStamp = (s: number) => { const t = Math.round(s); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };

async function stepDelivering(rt: Runtime, v: VideoRow): Promise<Advance> {
  const ds = await driveStatus(rt, { fetcher });
  const plan = parseJson<EditPlan | null>(v.plan_json, null);
  const finish = async (message: string) => {
    await moveTo(rt.env, v, 'done', { progress: 1, stage_detail: null, error: null });
    await addEvent(rt.env, v.id, 'done', message);
    await editorFetch(rt.env, v.id, `/work/${v.id}`, { method: 'DELETE' }).catch(() => null);
    return DONE('done');
  };
  if (!ds.connected || !ds.scopeOk) return finish(ds.connected ? 'Edit ready in Studio. Connect Google Drive again (full Drive access) to have it copied to the folder' : 'Edit ready in Studio. Google Drive is not connected, so it was not copied to the folder');
  if (!rt.env.STUDIO || !v.edited_key) throw new Error('The edit is missing from Studio storage.');
  const title = plan?.title || v.title || 'Recording';
  if (!v.drive_edited_id) {
    const size = v.edited_size ?? (await rt.env.STUDIO.head(v.edited_key))?.size ?? 0;
    const r = await driveUploadStep(rt, {
      stateKey: `dup:${v.id}:edited`, bucket: rt.env.STUDIO, key: v.edited_key, size, folder: ds.folderId, studioId: v.id, kind: 'edited', mime: 'video/mp4',
      name: driveName(day(v.created_at), title, `edited, ${resolutionLabel(v.edited_width ?? 0, v.edited_height ?? 0)}`, 'mp4'), description: driveDescription(plan),
    }, { fetcher });
    if (!r.done) { await patchVideo(rt.env, v.id, { progress: r.offset / Math.max(1, r.size), stage_detail: `Uploading the edit to Drive, ${gb(r.offset)} of ${gb(r.size)}` }); return later(0); }
    await patchVideo(rt.env, v.id, { drive_edited_id: r.id ?? null, drive_edited_link: r.link ?? null });
    v.drive_edited_id = r.id ?? 'done';
    await addEvent(rt.env, v.id, 'delivering', 'Uploaded the edit to Drive');
  }
  const shorts = parseJson<{ n: number; key: string; size: number; title: string; drive_id?: string; drive_link?: string }[]>(v.shorts_json, []);
  for (const s of shorts) {
    if (s.drive_id) continue;
    const r = await driveUploadStep(rt, {
      stateKey: `dup:${v.id}:short-${s.n}`, bucket: rt.env.STUDIO, key: s.key, size: s.size, folder: ds.folderId, studioId: v.id, kind: `short-${s.n}`, mime: 'video/mp4',
      name: driveName(day(v.created_at), title, `short ${s.n}`, 'mp4'), description: s.title,
    }, { fetcher });
    if (!r.done) { await patchVideo(rt.env, v.id, { stage_detail: `Uploading short ${s.n} to Drive` }); return later(0); }
    s.drive_id = r.id; s.drive_link = r.link;
    await patchVideo(rt.env, v.id, { shorts_json: JSON.stringify(shorts) });
  }
  if (shorts.length) await addEvent(rt.env, v.id, 'delivering', `Uploaded ${shorts.length} short${shorts.length === 1 ? '' : 's'} to Drive`);
  return finish('Done: the edit is in the Drive folder');
}

// ───────────── starting work ─────────────

/** Starts (or nudges) the pipeline for a video: a Workflow instance when the binding exists, else a short run now. */
export async function kick(rt: Runtime, id: string) {
  const flow = rt.env.STUDIO_FLOW;
  if (flow) {
    try {
      const inst = await flow.create({ id: `${id}-${Date.now().toString(36)}`, params: { id } });
      await patchVideo(rt.env, id, { flow_id: inst.id, next_at: null, lease_until: null });
      return;
    } catch (e) {
      console.error('studio: workflow start failed, running inline', plain(e));
    }
  }
  rt.waitUntil(runFor(rt, id, 20_000));
}

async function flowRunning(rt: Runtime, flowId: string | null) {
  if (!flowId || !rt.env.STUDIO_FLOW) return false;
  try {
    const s = await (await rt.env.STUDIO_FLOW.get(flowId)).status();
    return ['queued', 'running', 'waiting', 'waitingForPause', 'paused'].includes(String(s.status));
  } catch { return false; }
}

// ───────────── the Drive scan ─────────────

export interface ScanResult { ok: boolean; found: number; imported: number; skipped?: number; error?: string; reason?: string }

/** Lists the folder and adds every new video as a Studio item (source 'drive'); the pipeline copies and edits it. */
export async function scanDrive(rt: Runtime, now = Date.now()): Promise<ScanResult> {
  const flags = studioFlags(rt);
  const nextAt = iso(now + flags.scanHours * 3600_000);
  await setState(rt.env, 'scan_last', iso(now));
  await setState(rt.env, 'scan_next', nextAt);
  if (!rt.env.STUDIO) return { ok: false, found: 0, imported: 0, reason: 'Studio storage is not connected here.' };
  if (!googleReady(rt)) return { ok: false, found: 0, imported: 0, reason: 'Google Drive is not connected.' };
  const ds = await driveStatus(rt, { fetcher, fresh: true });
  if (!ds.scopeOk) { await setState(rt.env, 'scan_error', 'Connect Google Drive again with full Drive access.'); return { ok: false, found: 0, imported: 0, reason: 'Connect Google Drive again with full Drive access.' }; }
  try {
    const token = await googleAccess(rt, fetcher ?? fetch);
    const files = await listFolderVideos(token, ds.folderId, fetcher);
    const { results } = await rt.env.DB.prepare('SELECT drive_raw_id, drive_edited_id, shorts_json FROM studio_videos WHERE drive_raw_id IS NOT NULL OR drive_edited_id IS NOT NULL').all<{ drive_raw_id: string | null; drive_edited_id: string | null; shorts_json: string | null }>();
    const known = new Set<string>();
    for (const r of results) {
      if (r.drive_raw_id) known.add(r.drive_raw_id);
      if (r.drive_edited_id) known.add(r.drive_edited_id);
      for (const s of parseJson<{ drive_id?: string }[]>(r.shorts_json, [])) if (s.drive_id) known.add(s.drive_id);
    }
    const fresh = pickNewFiles(files, known);
    let imported = 0;
    for (const f of fresh) {
      const id = crypto.randomUUID();
      const extn = (/\.(\w{2,4})$/.exec(f.name)?.[1] ?? (f.mimeType?.split('/')[1] || 'mp4')).toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
      const title = f.name.replace(/\.[^.]+$/, '').slice(0, 120);
      const status: Status = flags.autoEdit ? 'in_drive' : 'skipped';
      const at = iso(now);
      const r = await rt.env.DB.prepare(
        `INSERT OR IGNORE INTO studio_videos (id, title, source, created_at, updated_at, mime, raw_key, raw_size, drive_raw_id, drive_raw_link, status, progress, stage_detail, markers_json)
         VALUES (?, ?, 'drive', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '[]')`,
      ).bind(id, title, at, at, f.mimeType ?? 'video/mp4', `raw/${id}.${extn}`, Number(f.size), f.id, f.webViewLink ?? null, status, flags.autoEdit ? 'Copying from Drive' : 'Automatic editing is off. Press Edit to start.').run();
      if (!Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0)) continue;
      imported++;
      await addEvent(rt.env, id, status, `Found in the Drive folder: ${f.name} (${gb(Number(f.size))})`, now);
      if (flags.autoEdit) await kick(rt, id);
    }
    await setState(rt.env, 'scan_error', null);
    return { ok: true, found: files.length, imported };
  } catch (e) {
    await setState(rt.env, 'scan_error', plain(e));
    return { ok: false, found: 0, imported: 0, error: plain(e) };
  }
}

/** Is a scan due (studio_state scan_next)? */
export async function scanDue(rt: Pick<Runtime, 'env'>, now = Date.now()) {
  const next = await getState(rt.env, 'scan_next');
  return !next || Date.parse(next) <= now;
}

/** The 5-minute cron: the Drive scan when due, then any video that isn't moving. */
export async function studioTick(rt: Runtime, now = Date.now()) {
  const out = { scanned: false, scan: null as ScanResult | null, advanced: 0 };
  if (!rt.env.STUDIO) return out;
  if (await scanDue(rt, now)) { out.scanned = true; out.scan = await scanDrive(rt, now); }
  const { results } = await rt.env.DB.prepare(
    `SELECT id, flow_id FROM studio_videos WHERE deleted_at IS NULL AND status IN ('uploaded','in_drive','queued','transcribing','planning','rendering','delivering')
       AND (next_at IS NULL OR next_at <= ?) AND (lease_until IS NULL OR lease_until < ?) ORDER BY updated_at LIMIT 6`,
  ).bind(now, now).all<{ id: string; flow_id: string | null }>();
  const started = Date.now();
  for (const r of results) {
    if (Date.now() - started > 90_000) break;
    if (await flowRunning(rt, r.flow_id)) continue;
    await runFor(rt, r.id, 30_000);
    out.advanced++;
  }
  return out;
}

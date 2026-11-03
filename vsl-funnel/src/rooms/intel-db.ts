import type { Runtime } from '../app';
import type { Env } from '../env';
import { newId } from '../lib/ids';
import { flag } from '../settings';
import type { RoomRow } from './rooms';
import {
  type Debrief, type DebriefInput, type Line, type ReplayPush, type RoomEdition, type TimedEvent,
  allowedNumbers, boundaries, buildRoomEdition, chaptersFrom, captionEpoch, containerOf, headerEnd, labelSpeakers, markWatched, mergeAi, mp4Init,
  pickClips, planChunk, replayAwardsFor, replayPushes, ruleDebrief, speakerChanges, stamp, webmTimecodeScale, whisperSegments,
} from './intel';

/**
 * Rooms intel (area D), the database half: what the room logs as it happens, the resumable Whisper transcription
 * of the R2 recording (one chunk per step, driven by the cron and by Funnel HQ), the timeline every view is drawn
 * from, the debrief (Claude when the key is set, rules otherwise; every number from the data), replay watching
 * with points and attribution, the simulive edition and highlight clips.
 */

type Rt = Pick<Runtime, 'env' | 'settings' | 'origin'>;
type S = Record<string, string | undefined>;
const MIN = 60_000;

// ───────────── settings (area D block in settings.ts) ─────────────

export function intelConfig(rt: Pick<Runtime, 'settings'>) {
  const s = rt.settings as unknown as S;
  const mb = Number(String(s.INTEL_CHUNK_MB ?? '').trim() || 8);
  const pts = /^(\d+)\s*x\s*(\d+)$/i.exec(String(s.INTEL_REPLAY_POINTS ?? '').trim() || '5x6');
  return {
    transcribe: flag(s.INTEL_TRANSCRIBE, true),
    chunkBytes: Math.round((Number.isFinite(mb) && mb >= 1 && mb <= 20 ? mb : 8) * 1024 * 1024),
    autoDebrief: flag(s.INTEL_AUTO_DEBRIEF, true),
    postCommand: flag(s.INTEL_POST_COMMAND, false),
    replayPoints: String(s.INTEL_REPLAY_POINTS ?? '').trim().toLowerCase() === 'off' ? { points: 0, cap: 0 } : { points: pts ? Number(pts[1]) : 5, cap: pts ? Number(pts[2]) : 6 },
  };
}

// ───────────── what the room logs as it happens (called from the Durable Object) ─────────────

export interface IntelEvent { at: number; kind: string; who?: string | null; name?: string | null; text?: string | null; data?: unknown }
/**
 * Per-room bound on the timeline (reliability): past INTEL_EVENT_CAP rows a room only logs its structural events
 * (chapters, polls, the offer, the recording switch), so a very long or very chatty room can't grow without end.
 */
export const INTEL_EVENT_CAP = 25_000;
const ALWAYS_LOG = new Set(['chapter', 'poll', 'offer', 'recording']);
const loggedPerRoom = new Map<string, number>();
export const resetIntelCounts = () => loggedPerRoom.clear();

export async function logEvents(env: Pick<Env, 'DB'>, roomId: string, events: IntelEvent[]) {
  if (!events.length) return;
  const db = env.DB;
  let n = loggedPerRoom.get(roomId);
  if (n === undefined) {
    if (loggedPerRoom.size > 200) loggedPerRoom.clear();
    n = (await db.prepare('SELECT COUNT(*) AS n FROM room_intel_events WHERE room_id = ?').bind(roomId).first<{ n: number }>())?.n ?? 0;
  }
  if (n >= INTEL_EVENT_CAP) events = events.filter((e) => ALWAYS_LOG.has(e.kind));
  loggedPerRoom.set(roomId, n + events.length);
  if (!events.length) return;
  await db.batch(events.map((e) => db.prepare('INSERT INTO room_intel_events (room_id, at, kind, who, name, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(roomId, e.at, e.kind, e.who ?? null, e.name?.slice(0, 80) ?? null, e.text?.slice(0, 600) ?? null, e.data === undefined ? null : JSON.stringify(e.data).slice(0, 2000))));
}

interface RoomLikeState { id: string; status: string; members: Record<string, { id: string; name: string; role: string; connected: number; stage: boolean }>; eng?: { agenda: { title: string }[] } }
/**
 * After a room message was applied: the chat, questions, chapter marks, polls, reactions and the recording switch
 * go into the timeline. intel_speaker (from the host's browser, which hears every voice) records who is speaking.
 */
export async function onRoomMessage(env: Pick<Env, 'DB'>, st: RoomLikeState, actorId: string, msg: Record<string, unknown>, now: number) {
  const me = st.members[actorId];
  if (!me) return;
  const text = (v: unknown, n = 400) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const ev: IntelEvent[] = [];
  switch (msg.t) {
    case 'chat': ev.push({ at: now, kind: 'chat', who: me.id, name: me.name, text: text(msg.text), data: { role: me.role } }); break;
    case 'ask': ev.push({ at: now, kind: 'question', who: me.id, name: me.name, text: text(msg.text, 300) }); break;
    case 'chapter': { const n = Number(msg.n); const title = st.eng?.agenda[n]?.title; if (title) ev.push({ at: now, kind: 'chapter', who: me.id, text: title, data: { n } }); break; }
    case 'poll_new': ev.push({ at: now, kind: 'poll', who: me.id, text: text(msg.question, 200) }); break;
    case 'react': ev.push({ at: now, kind: 'react', who: me.id, text: text(msg.kind, 20) }); break;
    case 'recording': ev.push({ at: now, kind: 'recording', who: me.id, text: msg.on === true ? 'on' : 'off' }); break;
    case 'offer': ev.push({ at: now, kind: 'offer', who: me.id, text: msg.open === false ? 'close' : 'open' }); break;
    default: return;
  }
  await logEvents(env, st.id, ev).catch((e) => console.error('intel log', String(e).slice(0, 200)));
}
/** intel_* messages (handled before the state machine): the active speaker, from the host's browser only. */
export async function onIntelMessage(env: Pick<Env, 'DB'>, st: RoomLikeState, actorId: string, msg: Record<string, unknown>, now: number) {
  const me = st.members[actorId];
  if (!me || me.role !== 'host' || st.status !== 'live') return { ok: false as const, error: 'forbidden' };
  if (msg.t !== 'intel_speaker') return { ok: false as const, error: 'unknown_message' };
  const target = typeof msg.id === 'string' ? st.members[msg.id] : null;
  if (!target || target.connected === 0) return { ok: false as const, error: 'not_found' };
  await logEvents(env, st.id, [{ at: now, kind: 'speaker', who: target.id, name: target.name }]);
  return { ok: true as const };
}

// ───────────── recordings ─────────────

export interface RecRow { id: string; room_id: string; r2_key: string; mime: string; status: string; bytes: number; started_at: number; ended_at: number | null }
/** The room's main recording: the longest ready one. */
export async function mainRecording(rt: Pick<Runtime, 'env'>, roomId: string) {
  return rt.env.DB.prepare("SELECT * FROM room_recordings WHERE room_id = ? AND status = 'ready' ORDER BY COALESCE(ended_at, started_at) - started_at DESC LIMIT 1").bind(roomId).first<RecRow>();
}
export const recDuration = (r: Pick<RecRow, 'started_at' | 'ended_at'>) => Math.max(0, (r.ended_at ?? r.started_at) - r.started_at);
export const recUrl = (rt: Pick<Runtime, 'origin'>, recId: string) => `${rt.origin}/rooms/replay/${recId}`;

// ───────────── transcription (Workers AI Whisper, chunked, resumable) ─────────────

export interface JobRow {
  rec_id: string; room_id: string; status: string; container: string | null; header_end: number | null; timescale: number | null; next_offset: number; size: number | null;
  chunks: number; gaps: number; tries: number; error: string | null; created_at: number; updated_at: number; done_at: number | null;
}
export async function queueTranscription(rt: Pick<Runtime, 'env'>, rec: Pick<RecRow, 'id' | 'room_id'>, now = Date.now()) {
  await rt.env.DB.prepare("INSERT OR IGNORE INTO room_transcribe_jobs (rec_id, room_id, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)").bind(rec.id, rec.room_id, now, now).run();
  return rt.env.DB.prepare('SELECT * FROM room_transcribe_jobs WHERE rec_id = ?').bind(rec.id).first<JobRow>();
}
/** Starts a job over (Funnel HQ → Debrief → Transcribe again): its old lines go when the new ones arrive chunk by chunk. */
export async function restartTranscription(rt: Pick<Runtime, 'env'>, recId: string, now = Date.now()) {
  await rt.env.DB.prepare("UPDATE room_transcribe_jobs SET status = 'queued', next_offset = 0, chunks = 0, gaps = 0, tries = 0, error = NULL, done_at = NULL, updated_at = ? WHERE rec_id = ?").bind(now, recId).run();
}

const b64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
/** Whisper on one chunk: the turbo model (segments with times), else the older one (words with times). */
export async function runWhisper(ai: Ai, audio: Uint8Array): Promise<unknown> {
  try {
    return await ai.run('@cf/openai/whisper-large-v3-turbo' as never, { audio: b64(audio) } as never);
  } catch (e) {
    if (audio.length > 6 * 1024 * 1024) throw e;
    return ai.run('@cf/openai/whisper' as never, { audio: [...audio] } as never);
  }
}
type Whisper = (audio: Uint8Array) => Promise<unknown>;

async function readRange(bucket: R2Bucket, key: string, offset: number, length: number) {
  const obj = await bucket.get(key, { range: { offset, length } });
  if (!obj || !('arrayBuffer' in obj)) return null;
  return new Uint8Array(await (obj as R2ObjectBody).arrayBuffer());
}

/**
 * One step of a job: reads one window of the recording at the job's offset (always a cluster or fragment start),
 * cuts the chunk, prepends the init segment, sends it to Whisper, stores the timed and speaker-labelled lines,
 * and moves the offset on. A chunk that fails three times is skipped and counted as a gap (never filled in).
 * Safe to call again at any point: a chunk's rows are replaced, never doubled.
 */
export async function transcribeStep(rt: Pick<Runtime, 'env' | 'settings'>, recId: string, o: { whisper?: Whisper; now?: number } = {}): Promise<JobRow | null> {
  const db = rt.env.DB;
  const now = o.now ?? Date.now();
  const job = await db.prepare('SELECT * FROM room_transcribe_jobs WHERE rec_id = ?').bind(recId).first<JobRow>();
  if (!job || ['done', 'no_ai', 'unsupported', 'failed'].includes(job.status)) return job;
  const rec = await db.prepare('SELECT * FROM room_recordings WHERE id = ?').bind(recId).first<RecRow>();
  const bucket = rt.env.RECORDINGS;
  const set = async (patch: Partial<JobRow>) => {
    const keys = Object.keys(patch);
    await db.prepare(`UPDATE room_transcribe_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE rec_id = ?`).bind(...keys.map((k) => (patch as Record<string, unknown>)[k] ?? null), now, recId).run();
    return db.prepare('SELECT * FROM room_transcribe_jobs WHERE rec_id = ?').bind(recId).first<JobRow>();
  };
  if (!rec || rec.status !== 'ready' || !bucket) return set({ status: 'failed', error: !bucket ? 'No RECORDINGS bucket bound.' : 'The recording is not ready.' });
  const whisper: Whisper | null = o.whisper ?? (rt.env.AI ? (a) => runWhisper(rt.env.AI!, a) : null);
  if (!whisper) return set({ status: 'no_ai', error: 'Workers AI (the AI binding) is not available on this deployment.' });
  const cfg = intelConfig(rt);

  // First step: the file's size, container and init segment.
  let j = job;
  if (j.status === 'queued' || j.header_end == null || !j.container) {
    const head = await bucket.head(rec.r2_key);
    if (!head) return set({ status: 'failed', error: 'The recording file is missing from R2.' });
    const first = await readRange(bucket, rec.r2_key, 0, Math.min(head.size, 2 * 1024 * 1024));
    if (!first) return set({ status: 'failed', error: 'Could not read the recording.' });
    const container = containerOf(rec.mime, first);
    const he = container ? headerEnd(container, first) : null;
    if (!container || he == null) return set({ status: 'unsupported', error: 'The recording format has no clusters or fragments to cut at.', size: head.size });
    const timescale = container === 'webm' ? webmTimecodeScale(first.subarray(0, he)) : mp4Init(first.subarray(0, he))?.timescale ?? null;
    if (container === 'mp4' && !timescale) return set({ status: 'unsupported', error: 'The MP4 recording has no track timescale.', size: head.size });
    j = (await set({ status: 'running', container, header_end: he, timescale, size: head.size, next_offset: Math.max(j.next_offset, he), error: null }))!;
  }
  const size = j.size!;
  if (j.next_offset >= size) return set({ status: 'done', done_at: now });
  const header = await readRange(bucket, rec.r2_key, 0, j.header_end!);
  const winLen = Math.min(size - j.next_offset, cfg.chunkBytes + 4 * 1024 * 1024);
  const win = await readRange(bucket, rec.r2_key, j.next_offset, winLen);
  if (!header || !win) return set({ tries: j.tries + 1, error: 'Could not read the recording.' });
  const container = j.container as 'webm' | 'mp4';
  const track = container === 'mp4' ? mp4Init(header) : null;
  const bounds = boundaries(container, win, j.next_offset, { scale: container === 'webm' ? j.timescale ?? 1_000_000 : undefined, track });
  const plan = planChunk(bounds, j.next_offset, win.length, size, cfg.chunkBytes);
  if (!plan) {
    // No boundary where expected: skip to the next one (a gap, counted), or past this window.
    const next = bounds.find((b) => b.offset > j.next_offset);
    const at = next ? next.offset : j.next_offset + win.length;
    return set(at >= size ? { status: 'done', done_at: now, gaps: j.gaps + 1 } : { next_offset: at, gaps: j.gaps + 1 });
  }
  const body = new Uint8Array(header.length + (plan.end - plan.start));
  body.set(header, 0);
  body.set(win.subarray(0, plan.end - plan.start), header.length);
  let reply: unknown;
  try {
    reply = await whisper(body);
  } catch (e) {
    const err = String(e instanceof Error ? e.message : e).slice(0, 300);
    // Workers AI itself is unreachable (local dev, no account): stop here, keep the place, nothing skipped.
    if (/run remotely|not authenticated|no such binding|binding .* not/i.test(err)) return set({ status: 'no_ai', error: `Workers AI is not reachable: ${err}` });
    if (j.tries + 1 >= 3) return set(plan.last ? { status: 'done', done_at: now, gaps: j.gaps + 1, tries: 0, error: err } : { next_offset: plan.end, gaps: j.gaps + 1, tries: 0, error: err });
    return set({ tries: j.tries + 1, error: err });
  }
  const changes = speakerChanges(
    (await db.prepare("SELECT at, name FROM room_intel_events WHERE room_id = ? AND kind = 'speaker' ORDER BY at").bind(rec.room_id).all<{ at: number; name: string | null }>()).results,
    rec.started_at,
  );
  const segs = labelSpeakers(whisperSegments(reply, plan.startMs, plan.endMs), changes);
  await db.batch([
    db.prepare('DELETE FROM room_transcript WHERE rec_id = ? AND chunk = ?').bind(rec.id, plan.start),
    ...segs.map((s) => db.prepare('INSERT OR REPLACE INTO room_transcript (rec_id, room_id, chunk, start_ms, end_ms, speaker, text) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(rec.id, rec.room_id, plan.start, s.start_ms, s.end_ms, s.speaker ?? null, s.text.slice(0, 2000))),
  ]);
  return set(plan.last ? { status: 'done', done_at: now, chunks: j.chunks + 1, next_offset: size, tries: 0, error: null } : { next_offset: plan.end, chunks: j.chunks + 1, tries: 0, error: null });
}

/** Runs steps for a while (the cron gives each run a budget; Funnel HQ calls it while the Debrief tab is open). */
export async function transcribeFor(rt: Pick<Runtime, 'env' | 'settings'>, recId: string, budgetMs: number, o: { whisper?: Whisper; maxSteps?: number } = {}) {
  const t0 = Date.now();
  let job: JobRow | null = null;
  for (let i = 0; i < (o.maxSteps ?? 50); i++) {
    job = await transcribeStep(rt, recId, { whisper: o.whisper });
    if (!job || !['queued', 'running'].includes(job.status) || Date.now() - t0 > budgetMs) break;
  }
  return job;
}

// ───────────── the timeline every view is drawn from ─────────────

export interface Timeline {
  room: Pick<RoomRow, 'id' | 'title' | 'mode' | 'ref_type' | 'ref_id' | 'status' | 'went_live_at' | 'ended_at' | 'peak'>;
  origin: 'recording' | 'live' | 'none';
  originAt: number;
  durationMs: number;
  rec: { id: string; url: string; vtt: string; mime: string; startedAt: number; durationMs: number } | null;
  job: Pick<JobRow, 'status' | 'chunks' | 'gaps' | 'error' | 'next_offset' | 'size'> | null;
  lines: Line[];
  transcriptSource: 'whisper' | 'captions' | 'none';
  curve: { ms: number; n: number }[];
  events: TimedEvent[];
  marks: { ms: number; title: string }[];
  pushes: ReplayPush[];
  messages: { ms: number; text: string; name: string | null; kind: string }[];
  people: number;
  reactionsKnown: boolean;
}

/** Reactions from area C's table when it exists (any of the usual time columns), else the room's own log. */
async function reactionTimes(rt: Pick<Runtime, 'env'>, roomId: string, wentLiveAt: number | null): Promise<number[] | null> {
  try {
    const { results } = await rt.env.DB.prepare('SELECT * FROM room_reactions WHERE room_id = ? LIMIT 20000').bind(roomId).all<Record<string, unknown>>();
    return results.map((r) => Number(r.at ?? r.created_at ?? r.ts ?? (r.t_ms != null ? captionEpoch(Number(r.t_ms), wentLiveAt) : NaN))).filter((x) => Number.isFinite(x));
  } catch { return null; }
}

export async function timeline(rt: Rt, room: RoomRow): Promise<Timeline> {
  const db = rt.env.DB;
  const rec = await mainRecording(rt, room.id);
  const originAt = rec?.started_at ?? room.went_live_at ?? room.starts_at ?? room.created_at;
  const end = rec ? rec.ended_at ?? rec.started_at : room.ended_at ?? (room.status === 'live' ? Date.now() : room.went_live_at ?? originAt);
  const durationMs = Math.max(0, end - originAt);
  const at = (t: number) => t - originAt;
  const [tr, cap, mins, evs, pushRows, pevs, att, job] = await db.batch([
    db.prepare('SELECT start_ms, end_ms, speaker, text FROM room_transcript WHERE rec_id = ? ORDER BY start_ms LIMIT 20000').bind(rec?.id ?? ''),
    db.prepare('SELECT t_ms, text FROM room_captions WHERE room_id = ? ORDER BY t_ms LIMIT 20000').bind(room.id),
    db.prepare('SELECT minute, n FROM room_minutes WHERE room_id = ? ORDER BY minute LIMIT 1000').bind(room.id),
    db.prepare('SELECT at, kind, who, name, text FROM room_intel_events WHERE room_id = ? ORDER BY at LIMIT 50000').bind(room.id),
    db.prepare('SELECT id, kind, ref, targets, created_at, closed_at FROM room_pushes WHERE room_id = ? ORDER BY id').bind(room.id),
    db.prepare("SELECT e.event, e.at, p.kind FROM room_push_events e LEFT JOIN room_pushes p ON p.room_id = e.room_id AND p.id = e.push_id WHERE e.room_id = ? AND e.event IN ('opened', 'submitted', 'paid') ORDER BY e.at").bind(room.id),
    db.prepare("SELECT COUNT(*) AS n FROM room_attendance WHERE room_id = ? AND role IN ('attendee', 'guest')").bind(room.id),
    db.prepare('SELECT * FROM room_transcribe_jobs WHERE rec_id = ?').bind(rec?.id ?? ''),
  ]) as unknown as [{ results: { start_ms: number; end_ms: number; speaker: string | null; text: string }[] }, { results: { t_ms: number; text: string }[] }, { results: { minute: number; n: number }[] }, { results: { at: number; kind: string; who: string | null; name: string | null; text: string | null }[] }, { results: { id: number; kind: string; ref: string | null; targets: string | null; created_at: number; closed_at: number | null }[] }, { results: { event: string; at: number; kind: string | null }[] }, { results: { n: number }[] }, { results: JobRow[] }];
  let lines: Line[] = tr.results.map((r) => ({ start_ms: r.start_ms, end_ms: r.end_ms, speaker: r.speaker, text: r.text }));
  let transcriptSource: Timeline['transcriptSource'] = lines.length ? 'whisper' : 'none';
  if (!lines.length && cap.results.length) {
    const ch = cap.results.map((c) => ({ ms: at(captionEpoch(c.t_ms, room.went_live_at)), text: String(c.text ?? '').trim() })).filter((c) => c.text);
    lines = ch.map((c, i) => ({ start_ms: c.ms, end_ms: ch[i + 1] ? Math.max(c.ms, ch[i + 1].ms) : c.ms + 3000, text: c.text, speaker: null }));
    transcriptSource = 'captions';
  }
  const liveAt = room.went_live_at;
  const curve = liveAt ? mins.results.map((m) => ({ ms: at(liveAt + m.minute * MIN), n: m.n })) : [];
  const events: TimedEvent[] = [];
  const messages: Timeline['messages'] = [];
  const marks: Timeline['marks'] = [];
  for (const e of evs.results) {
    if (e.kind === 'chat' || e.kind === 'question') { events.push({ ms: at(e.at), kind: e.kind, text: e.text, name: e.name }); messages.push({ ms: at(e.at), text: e.text ?? '', name: e.name, kind: e.kind }); }
    if (e.kind === 'chapter' && e.text) marks.push({ ms: at(e.at), title: e.text });
  }
  const cReacts = await reactionTimes(rt, room.id, room.went_live_at);
  const reacts = cReacts ?? evs.results.filter((e) => e.kind === 'react').map((e) => e.at);
  for (const t of reacts) events.push({ ms: at(t), kind: 'react' });
  for (const p of pevs.results) events.push({ ms: at(p.at), kind: p.event === 'submitted' ? 'application' : p.event === 'paid' ? 'purchase' : 'opened', ref: p.kind });
  for (const p of pushRows.results) events.push({ ms: at(p.created_at), kind: 'push', ref: p.kind });
  events.sort((a, b) => a.ms - b.ms);
  const j = job.results[0] ?? null;
  return {
    room: { id: room.id, title: room.title, mode: room.mode, ref_type: room.ref_type, ref_id: room.ref_id, status: room.status, went_live_at: room.went_live_at, ended_at: room.ended_at, peak: room.peak },
    origin: rec ? 'recording' : room.went_live_at ? 'live' : 'none',
    originAt, durationMs,
    rec: rec ? { id: rec.id, url: recUrl(rt, rec.id), vtt: `${recUrl(rt, rec.id)}/captions.vtt`, mime: rec.mime, startedAt: rec.started_at, durationMs: recDuration(rec) } : null,
    job: j ? { status: j.status, chunks: j.chunks, gaps: j.gaps, error: j.error, next_offset: j.next_offset, size: j.size } : null,
    lines, transcriptSource, curve, events, marks,
    pushes: replayPushes(pushRows.results, originAt, durationMs || Number.MAX_SAFE_INTEGER),
    messages, people: att.results[0]?.n ?? 0, reactionsKnown: true,
  };
}

/** The heatmap: one row per minute on the timeline's clock (every count is a count of real rows). */
export function heatmap(t: Timeline) {
  const minutes = Math.max(1, Math.ceil(t.durationMs / MIN));
  const rows = Array.from({ length: minutes }, (_, m) => ({ m, retention: null as number | null, chat: 0, questions: 0, reactions: 0, pushes: 0, opened: 0, applications: 0, purchases: 0 }));
  const row = (ms: number) => rows[Math.min(minutes - 1, Math.max(0, Math.floor(ms / MIN)))];
  for (const p of t.curve) if (p.ms >= 0 && p.ms <= t.durationMs + MIN) row(p.ms).retention = p.n;
  for (const e of t.events) {
    if (e.ms < 0 || e.ms > t.durationMs + MIN) continue;
    const r = row(e.ms);
    if (e.kind === 'chat') r.chat++; else if (e.kind === 'question') r.questions++; else if (e.kind === 'react') r.reactions++;
    else if (e.kind === 'push') r.pushes++; else if (e.kind === 'opened') r.opened++; else if (e.kind === 'application') r.applications++; else if (e.kind === 'purchase') r.purchases++;
  }
  return rows;
}

// ───────────── the debrief ─────────────

export function debriefInput(t: Timeline): DebriefInput {
  return {
    title: t.room.title, durationMs: t.durationMs, people: t.people, peak: t.room.peak,
    liveMinutes: t.room.went_live_at ? Math.max(0, Math.round(((t.room.ended_at ?? t.room.went_live_at) - t.room.went_live_at) / MIN)) : 0,
    lines: t.lines, transcriptSource: t.transcriptSource, curve: t.curve, events: t.events, marks: t.marks,
    pushes: t.pushes.map((p) => ({ ms: p.atMs, kind: p.kind })), messages: t.messages.map((m) => ({ ms: m.ms, text: m.text })), reactionsKnown: t.reactionsKnown,
  };
}

const DEBRIEF_SYSTEM = `You write the debrief of a live webinar for its host (Josh Li, G&L M&A Advisory) and his team. They will run the session again and want it to sell better.
You get FACTS (computed from the room's data: retention leaks, buying and applying spikes, objections, best moments, stats) and the TRANSCRIPT with timestamps.
Rules:
- Use only numbers that appear in FACTS or in the transcript. Never estimate, round differently or invent a figure; refer to a moment by its timestamp as given.
- Plain, direct sentences. No hype, no emojis, no exclamation marks, no em dashes.
- Script improvements are concrete: what to cut, move, add or say differently, and where (timestamp).
- Chapter titles are short (2 to 7 words) and describe what was taught.
Reply with one JSON object only: {"summary": string (3 to 5 sentences), "chapters": [{"ms": number (a transcript start time), "title": string}], "improvements": [string, ... up to 8]}`;

export async function buildDebrief(rt: Runtime, room: RoomRow, o: { post?: boolean; now?: number } = {}) {
  const now = o.now ?? Date.now();
  const t = await timeline(rt, room);
  const input = debriefInput(t);
  // qa-sells: which objection types came before buying and which didn't (room_objections; empty before migration 0074).
  input.qa = await import('./qa-db').then((m) => m.objectionReport(rt, { roomId: room.id })).then((r) => r.types.map((o) => ({ type: o.type, label: r.labels[o.type], people: o.people, bought: o.bought, notBought: o.notBought, reopened: o.reopened, boughtAfterReopen: o.boughtAfterReopen }))).catch(() => []);
  const base = ruleDebrief(input);
  let debrief: Debrief = base;
  let note: string | null = null;
  const { askClaude, claudeReady, parseJsonReply, REASONING_MODEL, NO_KEY_NOTE } = await import('../ops/claude');
  if (claudeReady(rt) && (t.lines.length || t.events.length)) {
    const facts = { stats: base.stats, leaks: base.leaks, spikes: base.spikes, objections: base.objections, moments: base.moments, chapters: base.chapters, objectionOutcomes: base.objectionOutcomes ?? [] };
    let transcript = t.lines.map((l) => `[${l.start_ms}ms ${stamp(l.start_ms)}]${l.speaker ? ` ${l.speaker}:` : ''} ${l.text}`).join('\n');
    if (transcript.length > 90_000) transcript = `${transcript.slice(0, 60_000)}\n…\n${transcript.slice(-30_000)}`;
    try {
      const reply = await askClaude(rt, { feature: 'room-debrief', model: ((rt.settings as unknown as S).INTEL_MODEL ?? '').trim() || REASONING_MODEL, system: DEBRIEF_SYSTEM, user: `TITLE: ${room.title}\n\nFACTS:\n${JSON.stringify(facts)}\n\nTRANSCRIPT:\n${transcript || '(no transcript yet)'}`, maxTokens: 2000 });
      const parsed = parseJsonReply<{ summary?: string; chapters?: unknown[]; improvements?: string[] }>(reply);
      debrief = mergeAi(base, parsed, allowedNumbers(facts, t.lines.map((l) => l.text), t.messages.map((m) => m.text), t.lines.map((l) => [l.start_ms, stamp(l.start_ms)])));
      if (!parsed) note = 'Claude did not return a usable debrief, so this one is built from the numbers alone.';
    } catch (e) {
      note = `Claude was unavailable (${String(e instanceof Error ? e.message : e).slice(0, 120)}), so this debrief is built from the numbers alone.`;
    }
  } else if (!claudeReady(rt)) note = `Built from the numbers alone. ${NO_KEY_NOTE}`;
  const db = rt.env.DB;
  await db.prepare(`INSERT INTO room_debriefs (room_id, source, data, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET source = excluded.source, data = excluded.data, note = excluded.note, updated_at = excluded.updated_at`).bind(room.id, debrief.source, JSON.stringify(debrief), note, now, now).run();
  let docId: string | null = null;
  if (o.post ?? intelConfig(rt).postCommand) docId = await postToCommand(rt, room, debrief).catch(() => null);
  return { debrief, note, docId, timeline: t };
}

export async function getDebrief(rt: Pick<Runtime, 'env'>, roomId: string) {
  const r = await rt.env.DB.prepare('SELECT * FROM room_debriefs WHERE room_id = ?').bind(roomId).first<{ source: string; data: string; doc_id: string | null; note: string | null; updated_at: number }>();
  if (!r) return null;
  try { return { debrief: JSON.parse(r.data) as Debrief, docId: r.doc_id, note: r.note, at: r.updated_at }; } catch { return null; }
}

/** The debrief as markdown (the Command document). */
export function debriefMarkdown(title: string, d: Debrief) {
  const L: string[] = [`# Debrief: ${title}`, '', d.summary, ''];
  if (d.leaks.length) L.push('## Where people left', ...d.leaks.map((x) => `- ${x.text}`), '');
  if (d.spikes.length) L.push('## What came right before applying and buying', ...d.spikes.map((x) => `- ${x.text}`), '');
  if (d.objections.length) L.push('## Objections raised', ...d.objections.map((x) => `- ${x.topic}: ${x.count} ${x.count === 1 ? 'message' : 'messages'}${x.quotes[0] ? ` ("${x.quotes[0].text}")` : ''}`), '');
  if (d.moments.length) L.push('## Best moments', ...d.moments.map((x) => `- ${x.text}`), '');
  if (d.chapters.length) L.push('## Chapters', ...d.chapters.map((c) => `- ${stamp(c.ms)} ${c.title}`), '');
  if (d.improvements.length) L.push('## Script changes for the next run', ...d.improvements.map((x) => `- ${x}`), '');
  if (d.notes.length) L.push('## Notes', ...d.notes.map((x) => `- ${x}`), '');
  L.push(`_Source: ${d.source === 'claude' ? 'Claude, with every number checked against the room data' : 'the room data (rules)'}._`);
  return L.join('\n');
}
export async function postToCommand(rt: Runtime, room: RoomRow, d: Debrief) {
  const { saveDocument } = await import('../ops/documents');
  const id = await saveDocument(rt, { title: `Debrief: ${room.title}`, body: debriefMarkdown(room.title, d), kind: 'room_debrief' });
  await rt.env.DB.prepare('UPDATE room_debriefs SET doc_id = ? WHERE room_id = ?').bind(id, room.id).run();
  return id;
}

// ───────────── highlight clips ─────────────

export async function suggestClips(rt: Pick<Runtime, 'env'>, room: RoomRow, t: Timeline, d: Debrief, now = Date.now()) {
  if (!t.rec) return { ok: false as const, error: 'This room has no ready recording to cut clips from.' };
  const cands = [
    ...d.spikes.map((s) => ({ ms: Math.max(0, s.ms - 60_000), reason: s.text })),
    ...d.moments.map((m) => ({ ms: m.ms, reason: m.text })),
    ...d.chapters.slice(1).map((c) => ({ ms: c.ms + 30_000, reason: `Chapter: ${c.title}` })),
  ];
  const clips = pickClips(cands, t.lines, t.rec.durationMs, { max: 6 });
  const db = rt.env.DB;
  await db.batch([
    db.prepare("DELETE FROM room_clips WHERE room_id = ? AND status = 'draft'").bind(room.id),
    ...clips.map((c) => db.prepare('INSERT INTO room_clips (id, room_id, rec_id, start_ms, end_ms, title, caption, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(newId('clip').toLowerCase(), room.id, t.rec!.id, c.start_ms, c.end_ms, c.title, c.caption, c.reason, 'draft', now, now)),
  ]);
  return { ok: true as const, clips: await listClips(rt, room.id) };
}
export async function listClips(rt: Pick<Runtime, 'env'>, roomId?: string) {
  const q = roomId
    ? rt.env.DB.prepare('SELECT c.*, r.title AS room_title FROM room_clips c JOIN rooms r ON r.id = c.room_id WHERE c.room_id = ? ORDER BY c.start_ms').bind(roomId)
    : rt.env.DB.prepare('SELECT c.*, r.title AS room_title FROM room_clips c JOIN rooms r ON r.id = c.room_id ORDER BY c.created_at DESC, c.start_ms LIMIT 200');
  return (await q.all<{ id: string; room_id: string; rec_id: string; start_ms: number; end_ms: number; title: string; caption: string; reason: string | null; status: string; room_title: string }>()).results;
}
export async function saveClip(rt: Pick<Runtime, 'env'>, id: string, b: Record<string, unknown>, now = Date.now()) {
  const db = rt.env.DB;
  const c = await db.prepare('SELECT c.*, k.started_at, k.ended_at FROM room_clips c JOIN room_recordings k ON k.id = c.rec_id WHERE c.id = ?').bind(id).first<{ start_ms: number; end_ms: number; started_at: number; ended_at: number | null; title: string; caption: string; status: string }>();
  if (!c) return { ok: false as const, error: 'Clip not found' };
  const dur = recDuration(c);
  const start = b.start_ms === undefined ? c.start_ms : Math.round(Number(b.start_ms));
  const end = b.end_ms === undefined ? c.end_ms : Math.round(Number(b.end_ms));
  if (!(Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= dur && end - start >= 3000 && end - start <= 180_000)) return { ok: false as const, error: 'A clip runs 3 seconds to 3 minutes inside the recording.' };
  const title = typeof b.title === 'string' ? b.title.replace(/[<>]/g, '').trim().slice(0, 90) || c.title : c.title;
  const caption = typeof b.caption === 'string' ? b.caption.replace(/[<>]/g, '').trim().slice(0, 600) : c.caption;
  const status = b.status === 'approved' || b.status === 'posted' || b.status === 'draft' ? b.status : c.status;
  await db.prepare('UPDATE room_clips SET start_ms = ?, end_ms = ?, title = ?, caption = ?, status = ?, updated_at = ? WHERE id = ?').bind(start, end, title, caption, status, now, id).run();
  return { ok: true as const };
}

// ───────────── simulive: publish a recorded session as the automated webinar's edition ─────────────

export async function roomEditionFor(rt: Rt, room: RoomRow, t?: Timeline): Promise<{ ok: true; edition: RoomEdition } | { ok: false; error: string }> {
  const tl = t ?? await timeline(rt, room);
  if (!tl.rec) return { ok: false, error: 'This room has no ready recording yet.' };
  const d = (await getDebrief(rt, room.id))?.debrief;
  const chapters = d?.chapters?.length ? d.chapters : chaptersFrom(tl.marks, tl.lines, tl.rec.durationMs);
  return { ok: true, edition: buildRoomEdition({ roomId: room.id, recId: tl.rec.id, src: `/rooms/replay/${tl.rec.id}`, title: room.title, recordedAt: room.went_live_at ?? tl.rec.startedAt, durationMs: tl.rec.durationMs, chapters, pushes: tl.pushes }) };
}
/** Sets WEBINAR_EDITION = room and stores the edition (the automated webinar's sessions play it from the next showing). */
export async function publishEdition(rt: Rt, room: RoomRow) {
  const r = await roomEditionFor(rt, room);
  if (!r.ok) return r;
  const { saveSettings } = await import('../settings');
  await saveSettings(rt.env, { WEBINAR_EDITION: 'room', WEBINAR_ROOM_EDITION: JSON.stringify(r.edition) });
  return r;
}

// ───────────── replay watching: minutes, points, attribution ─────────────

export interface Viewer { id: string; leadId: string | null; regId: string | null }
const funnelOf = (room: Pick<RoomRow, 'ref_type'>) => (room.ref_type === 'live' ? 'live' as const : room.ref_type === 'challenge' ? 'challenge' as const : null);

/**
 * A ping from the replay page while the video plays (every ~15 s): marks the minute watched, adds the seconds,
 * records the replay for the funnel (live: live_webinar_regs.replay_at; challenge: challenge_progress), the
 * replay_watched stage, and a point award for every ten distinct minutes (capped; Settings → INTEL_REPLAY_POINTS).
 */
export async function replayPing(rt: Rt, room: RoomRow, who: Viewer, body: { pos?: unknown; secs?: unknown }, durationMs: number, now = Date.now()) {
  const db = rt.env.DB;
  const pos = Math.max(0, Math.min(durationMs / 1000, Number(body.pos) || 0));
  const secs = Math.max(0, Math.min(30, Math.round(Number(body.secs) || 0)));
  const total = Math.max(1, Math.ceil(durationMs / MIN));
  const cur = await db.prepare('SELECT minutes, first_at FROM room_replay_views WHERE room_id = ? AND who = ?').bind(room.id, who.id).first<{ minutes: string; first_at: number }>();
  const minutes = secs > 0 ? markWatched(cur?.minutes ?? '', Math.floor(pos / 60), total) : cur?.minutes ?? '';
  await db.prepare(`INSERT INTO room_replay_views (room_id, who, lead_id, reg_id, first_at, last_at, seconds, max_pos, minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, who) DO UPDATE SET last_at = excluded.last_at, seconds = room_replay_views.seconds + excluded.seconds, max_pos = MAX(room_replay_views.max_pos, excluded.max_pos), minutes = excluded.minutes`)
    .bind(room.id, who.id, who.leadId, who.regId, now, now, secs, Math.round(pos), minutes).run();
  const watched = [...minutes].filter((c) => c === '1').length;
  const funnel = funnelOf(room);
  if (!cur && who.regId && who.leadId && funnel && secs > 0) {
    if (room.ref_type === 'live') await db.prepare('UPDATE live_webinar_regs SET replay_at = COALESCE(replay_at, ?) WHERE id = ?').bind(now, who.regId).run();
    if (room.ref_type === 'challenge') {
      const day = Number(/:(\d)$/.exec(room.ref_id ?? '')?.[1]);
      if (day) await db.prepare('INSERT INTO challenge_progress (reg_id, day, replay_at) VALUES (?, ?, ?) ON CONFLICT(reg_id, day) DO UPDATE SET replay_at = COALESCE(challenge_progress.replay_at, excluded.replay_at)').bind(who.regId, day, now).run().catch(() => null);
    }
  }
  if (who.regId && who.leadId && funnel && watched > 0) {
    const { recordStage } = await import('../attribution/stages');
    const cohort = room.ref_type === 'challenge' ? (/^challenge:([^:]+):/.exec(room.ref_id ?? '')?.[1] ?? room.ref_id) : room.ref_id;
    await recordStage(rt, { funnel, stage: 'replay_watched', leadId: who.leadId, regId: who.regId, ts: now, value: watched, detail: room.id, key: room.ref_type === 'challenge' ? room.id : null, cohortRef: cohort, source: 'room' }).catch(() => null);
    await db.prepare("UPDATE attr_stages SET value = MAX(COALESCE(value, 0), ?) WHERE id = ?").bind(watched, `${funnel}:${who.regId}:replay_watched${room.ref_type === 'challenge' ? `:${room.id}` : ''}`).run().catch(() => null);
  }
  // Points: one row per ten distinct minutes (room_points' own de-duplication keeps a re-sent ping from counting twice).
  const cfg = intelConfig(rt).replayPoints;
  let points = 0;
  if (cfg.points > 0 && who.leadId) {
    const due = replayAwardsFor(minutes, 10, cfg.cap);
    for (let k = 1; k <= due; k++) {
      const r = await db.prepare('INSERT OR IGNORE INTO room_points (room_id, who, action, key, points, lead_id, reg_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(room.id, who.id, 'replay_10', String(k), cfg.points, who.leadId, who.regId, now).run();
      if ((r.meta.changes ?? 0) > 0) points += cfg.points;
    }
  }
  const total_pts = await db.prepare("SELECT COALESCE(SUM(points), 0) AS n FROM room_points WHERE room_id = ? AND who = ? AND action = 'replay_10'").bind(room.id, who.id).first<{ n: number }>();
  return { ok: true as const, watched, earned: points, replayPoints: total_pts?.n ?? 0 };
}

// ───────────── the cron ─────────────

/**
 * Every 5 minutes: queue a transcription for each ready recording of an ended room, run the open jobs for about
 * 20 seconds, then write the debrief of any room whose transcript just finished (or that ended an hour ago).
 */
export async function processIntel(rt: Runtime, o: { budgetMs?: number; now?: number } = {}) {
  const cfg = intelConfig(rt);
  const db = rt.env.DB;
  const now = o.now ?? Date.now();
  let queued = 0, steps = 0, debriefs = 0;
  if (cfg.transcribe && rt.env.RECORDINGS) {
    const { results } = await db.prepare(`SELECT k.id, k.room_id FROM room_recordings k JOIN rooms r ON r.id = k.room_id
      WHERE k.status = 'ready' AND r.status = 'ended' AND NOT EXISTS (SELECT 1 FROM room_transcribe_jobs j WHERE j.rec_id = k.id) AND k.ended_at > ? LIMIT 5`).bind(now - 30 * 86_400_000).all<{ id: string; room_id: string }>();
    for (const r of results) { await queueTranscription(rt, r, now); queued++; }
    const open = await db.prepare("SELECT rec_id FROM room_transcribe_jobs WHERE status IN ('queued', 'running') ORDER BY updated_at LIMIT 2").all<{ rec_id: string }>();
    const t0 = Date.now();
    for (const j of open.results) {
      const left = (o.budgetMs ?? 20_000) - (Date.now() - t0);
      if (left <= 0) break;
      const job = await transcribeFor(rt, j.rec_id, left, { maxSteps: 20 });
      steps += job?.chunks ?? 0;
    }
  }
  if (cfg.autoDebrief) {
    const { results } = await db.prepare(`SELECT r.* FROM rooms r WHERE r.status = 'ended' AND r.mode = 'webinar' AND r.ended_at > ? AND r.ended_at < ?
      AND NOT EXISTS (SELECT 1 FROM room_debriefs d WHERE d.room_id = r.id)
      AND (NOT EXISTS (SELECT 1 FROM room_recordings k WHERE k.room_id = r.id AND k.status = 'ready')
           OR EXISTS (SELECT 1 FROM room_recordings k JOIN room_transcribe_jobs j ON j.rec_id = k.id WHERE k.room_id = r.id AND j.status NOT IN ('queued', 'running'))
           OR r.ended_at < ?) LIMIT 2`).bind(now - 7 * 86_400_000, now - 10 * MIN, now - 6 * 3_600_000).all<RoomRow>();
    for (const room of results) { await buildDebrief(rt, room, { now }).catch((e) => console.error('intel debrief', String(e).slice(0, 200))); debriefs++; }
  }
  return { queued, steps, debriefs };
}

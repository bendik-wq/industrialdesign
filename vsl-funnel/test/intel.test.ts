import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy, auditFields } from '../src/content/copy-rules';
import {
  INTEL_COPY, allowedNumbers, buildRoomEdition, cardsAt, chaptersFrom, clipCues, clipTitle, containerOf, firedAt, guardNumbers, headerEnd, labelSpeakers, linesBetween, markWatched,
  mergeAi, mp4Fragments, mp4Init, numbersIn, objections, parseRoomEdition, pickClips, planChunk, replayAwardsFor, replayPushes, retentionLeaks, ruleDebrief, showingLabel, showingPosition,
  spikes, speakerChanges, stamp, toVtt, webmClusters, webmTimecodeScale, whisperSegments, type DebriefInput, type Line, type TimedEvent,
} from '../src/rooms/intel';
import {
  buildDebrief, getDebrief, heatmap, onIntelMessage, onRoomMessage, processIntel, publishEdition, queueTranscription, replayPing, saveClip, suggestClips, timeline, transcribeStep,
} from '../src/rooms/intel-db';
import { simuliveConfig } from '../src/rooms/intel-simulive';
import { edition, editionName } from '../src/webinar/editions';
import { createRoom, ensureRoomFor, getRoom } from '../src/rooms/rooms';
import { saveEvent } from '../src/live/events';
import { setClaudeTransport } from '../src/ops/claude';
import { SETTINGS as SETTING_DEFS } from '../src/settings';

// ───────────── a real SQLite database shaped like D1, with every migration applied ─────────────

interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc?: string): string & Uint8Array };
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

/** An R2 bucket over bytes in memory (head, ranged get), enough for the transcription job. */
function memBucket(files: Record<string, Uint8Array>) {
  const reads: { key: string; offset: number; length: number }[] = [];
  return {
    reads,
    head: async (key: string) => (files[key] ? { size: files[key].length } : null),
    get: async (key: string, o?: { range?: { offset: number; length: number } }) => {
      const f = files[key]; if (!f) return null;
      const off = o?.range?.offset ?? 0, len = o?.range?.length ?? f.length;
      reads.push({ key, offset: off, length: len });
      const slice = f.slice(off, Math.min(f.length, off + len));
      return { arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
    },
  };
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-03T02:00:00Z');
let db: DatabaseSync;
let rt: Runtime;
const ALL = () => Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ''])) as Record<string, string>;
const makeRt = (s: Record<string, string> = {}, env: Record<string, unknown> = {}) =>
  ({ env: { DB: d1(db), SESSION_SECRET: 'test-session-secret', ...env }, settings: { ...ALL(), SALES_TIMEZONE: 'America/New_York', ...s }, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a.map((v) => (v === undefined ? null : v)) as (string | number | null)[]));
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
});
afterEach(() => { vi.useRealTimers(); setClaudeTransport(null); });

const WEBM = new Uint8Array(fs.readFileSync(`${node.cwd()}/test/fixtures/intel-rec.webm`));
const MP4 = new Uint8Array(fs.readFileSync(`${node.cwd()}/test/fixtures/intel-rec.mp4`));

/** A synthetic Chrome-style WebM: unknown-size segment and clusters, each cluster `size` bytes with its own timecode. */
function synthWebm(clusters: { ms: number; size: number }[]) {
  const head = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x82, 0x81, 0x77, // EBML header (doc type stub)
    0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // Segment, unknown size
    0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]; // Info { TimecodeScale = 1,000,000 }
  const parts: number[][] = [head];
  let seed = 7;
  for (const c of clusters) {
    const hdr = [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x84, (c.ms >>> 24) & 255, (c.ms >>> 16) & 255, (c.ms >>> 8) & 255, c.ms & 255];
    const body = new Array(Math.max(0, c.size - hdr.length));
    for (let i = 0; i < body.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; body[i] = (seed >> 16) & 0x7f; } // never 0x1f43b675 by chance
    parts.push(hdr, body);
  }
  return new Uint8Array(parts.flat());
}

// ───────────── containers and chunks ─────────────

describe('cutting a recording into chunks Whisper can read on their own', () => {
  it('finds the init segment and every cluster of a real WebM, with the cluster times from the file', () => {
    expect(containerOf('video/webm', WEBM)).toBe('webm');
    const he = headerEnd('webm', WEBM)!;
    expect(he).toBeGreaterThan(0);
    expect(webmTimecodeScale(WEBM.subarray(0, he))).toBe(1_000_000);
    const cl = webmClusters(WEBM);
    expect(cl[0].offset).toBe(he);
    expect(cl.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < cl.length; i++) { expect(cl[i].offset).toBeGreaterThan(cl[i - 1].offset); expect(cl[i].ms).toBeGreaterThan(cl[i - 1].ms); }
    expect(cl[cl.length - 1].ms).toBeLessThan(12_500);
  });
  it('finds the audio track and every fragment of a real fragmented MP4 (Safari), timed from tfdt', () => {
    expect(containerOf('video/mp4', MP4)).toBe('mp4');
    const he = headerEnd('mp4', MP4)!;
    const tr = mp4Init(MP4.subarray(0, he))!;
    expect(tr.timescale).toBe(44_100); // the audio track's own clock
    const fr = mp4Fragments(MP4.subarray(he), he, tr);
    expect(fr[0]).toEqual({ offset: he, ms: 0 });
    expect(fr.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < fr.length; i++) expect(fr[i].ms).toBeGreaterThan(fr[i - 1].ms);
  });
  it('plans chunks on boundaries: under the target, a large cluster runs to the next one, the last runs to the end', () => {
    const b = [{ offset: 100, ms: 0 }, { offset: 400, ms: 2000 }, { offset: 700, ms: 4000 }, { offset: 1500, ms: 6000 }];
    expect(planChunk(b, 100, 2000, 5000, 650)).toEqual({ start: 100, end: 700, startMs: 0, endMs: 4000, last: false });
    expect(planChunk(b, 700, 1500, 5000, 300)).toEqual({ start: 700, end: 1500, startMs: 4000, endMs: 6000, last: false });
    expect(planChunk(b.slice(3), 1500, 3500, 5000, 8000)).toEqual({ start: 1500, end: 5000, startMs: 6000, endMs: null, last: true });
    expect(planChunk(b, 101, 2000, 5000, 650)).toBeNull(); // not on a boundary
  });
  it('reads Whisper’s segments (turbo) or words (older model) onto the recording’s clock, and names the speaker', () => {
    expect(whisperSegments({ segments: [{ start: 0.5, end: 2, text: ' Buy the competitor. ' }, { start: 2.1, end: 3, text: '[music]' }] }, 60_000, 90_000)).toEqual([{ start_ms: 60_500, end_ms: 62_000, text: 'Buy the competitor.' }]);
    const w = whisperSegments({ words: [{ word: 'Seller', start: 0, end: 0.4 }, { word: 'finance.', start: 0.4, end: 0.9 }, { word: 'Next', start: 1, end: 1.2 }] }, 1000, null);
    expect(w).toEqual([{ start_ms: 1000, end_ms: 1900, text: 'Seller finance.' }, { start_ms: 2000, end_ms: 2200, text: 'Next' }]);
    expect(whisperSegments({ text: 'Only text' }, 5000, 9000)).toEqual([{ start_ms: 5000, end_ms: 9000, text: 'Only text' }]);
    const changes = speakerChanges([{ at: T0 + 500, name: 'Josh' }, { at: T0 + 800, name: 'Josh' }, { at: T0 + 30_000, name: 'Dana' }], T0);
    expect(changes).toEqual([{ ms: 500, name: 'Josh' }, { ms: 30_000, name: 'Dana' }]);
    expect(labelSpeakers([{ start_ms: 0, end_ms: 1, text: 'a' }, { start_ms: 10_000, end_ms: 1, text: 'b' }, { start_ms: 29_600, end_ms: 1, text: 'c' }], changes).map((s) => s.speaker)).toEqual(['Josh', 'Josh', 'Dana']);
  });

  async function recordedRoom(bytes: Uint8Array, mime = 'video/webm') {
    const room = await createRoom(rt, { mode: 'webinar', title: 'Buy your first competitor', refType: 'none', startsAt: T0 - HOUR });
    x("UPDATE rooms SET status = 'ended', went_live_at = ?, ended_at = ? WHERE id = ?", T0 - HOUR, T0 - 20 * MIN, room.id);
    x("INSERT INTO room_recordings (id, room_id, r2_key, upload_id, mime, status, parts, bytes, started_at, ended_at) VALUES ('recaaaaaaaaaa', ?, 'rooms/x/rec.webm', 'u', ?, 'ready', 1, ?, ?, ?)", room.id, mime, bytes.length, T0 - HOUR, T0 - HOUR + 12_000);
    return (await getRoom(rt, room.id))!;
  }

  it('transcribes chunk by chunk, resumes after a failure without doubling lines, and labels the speaker', async () => {
    const file = synthWebm(Array.from({ length: 6 }, (_, i) => ({ ms: i * 2000, size: 400 * 1024 })));
    const bucket = memBucket({ 'rooms/x/rec.webm': file });
    rt = makeRt({ INTEL_CHUNK_MB: '1' }, { RECORDINGS: bucket, AI: {} });
    const room = await recordedRoom(file);
    x("INSERT INTO room_intel_events (room_id, at, kind, who, name) VALUES (?, ?, 'speaker', 'hadmin', 'Josh'), (?, ?, 'speaker', 'rdana', 'Dana L.')", room.id, T0 - HOUR + 100, room.id, T0 - HOUR + 3900);
    await queueTranscription(rt, { id: 'recaaaaaaaaaa', room_id: room.id });
    const seen: { head: boolean; size: number }[] = [];
    let fail = 0;
    const whisper = async (audio: Uint8Array) => {
      seen.push({ head: audio[0] === 0x1a && audio[1] === 0x45 && audio[2] === 0xdf && audio[3] === 0xa3, size: audio.length });
      if (fail > 0) { fail--; throw new Error('AI busy'); }
      const at = webmClusters(audio)[0].ms; // the chunk's first cluster, right after the prepended header
      return { segments: [{ start: 0, end: 1.5, text: `Said at ${at}` }] };
    };
    let job = await transcribeStep(rt, 'recaaaaaaaaaa', { whisper });
    expect(job).toMatchObject({ status: 'running', container: 'webm', chunks: 1 });
    expect(seen[0].head).toBe(true);
    // A failure keeps the offset (retry), then the next step resumes from it.
    fail = 1;
    const before = job!.next_offset;
    job = await transcribeStep(rt, 'recaaaaaaaaaa', { whisper });
    expect(job).toMatchObject({ next_offset: before, tries: 1, error: 'AI busy' });
    for (let i = 0; i < 10 && job!.status === 'running'; i++) job = await transcribeStep(rt, 'recaaaaaaaaaa', { whisper });
    expect(job).toMatchObject({ status: 'done', gaps: 0, tries: 0 });
    expect(seen.every((s) => s.head && s.size <= 1024 * 1024 + 50_000)).toBe(true);
    const lines = q<{ start_ms: number; text: string; speaker: string }>('SELECT start_ms, text, speaker FROM room_transcript WHERE rec_id = ? ORDER BY start_ms', 'recaaaaaaaaaa');
    expect(lines.map((l) => l.start_ms)).toEqual(lines.map((l) => Number(l.text.replace('Said at ', ''))));
    expect(new Set(lines.map((l) => l.start_ms)).size).toBe(lines.length);
    expect(lines[0].speaker).toBe('Josh');
    expect(lines[lines.length - 1].speaker).toBe('Dana L.');
    // Running a chunk again (a crash after Whisper answered) replaces its rows instead of doubling them.
    const n = lines.length;
    x("UPDATE room_transcribe_jobs SET status = 'running', next_offset = (SELECT MIN(chunk) FROM room_transcript WHERE rec_id = 'recaaaaaaaaaa') WHERE rec_id = 'recaaaaaaaaaa'");
    await transcribeStep(rt, 'recaaaaaaaaaa', { whisper });
    expect(q('SELECT 1 FROM room_transcript WHERE rec_id = ?', 'recaaaaaaaaaa').length).toBe(n);
  });

  it('skips a chunk Whisper can’t read after three tries (a counted gap, never invented text)', async () => {
    const bucket = memBucket({ 'rooms/x/rec.webm': WEBM });
    rt = makeRt({ INTEL_CHUNK_MB: '1' }, { RECORDINGS: bucket, AI: {} });
    const room = await recordedRoom(WEBM);
    await queueTranscription(rt, { id: 'recaaaaaaaaaa', room_id: room.id });
    const broken = async () => { throw new Error('unreadable'); };
    let job = null;
    for (let i = 0; i < 5; i++) job = await transcribeStep(rt, 'recaaaaaaaaaa', { whisper: broken });
    expect(job).toMatchObject({ status: 'done', gaps: 1 });
    expect(q('SELECT 1 FROM room_transcript').length).toBe(0);
    // Without Workers AI the job says so instead of pretending.
    x("UPDATE room_transcribe_jobs SET status = 'queued' WHERE rec_id = 'recaaaaaaaaaa'");
    rt = makeRt({}, { RECORDINGS: bucket });
    expect(await transcribeStep(rt, 'recaaaaaaaaaa')).toMatchObject({ status: 'no_ai' });
    // Bound but unreachable (local dev): it stops in place instead of skipping every chunk.
    x("UPDATE room_transcribe_jobs SET status = 'queued', next_offset = 0, gaps = 0 WHERE rec_id = 'recaaaaaaaaaa'");
    rt = makeRt({}, { RECORDINGS: bucket, AI: {} });
    const job2 = await transcribeStep(rt, 'recaaaaaaaaaa', { whisper: async () => { throw new Error('Binding AI needs to be run remotely'); } });
    expect(job2).toMatchObject({ status: 'no_ai', gaps: 0 });
  });

  it('the cron queues ended rooms’ recordings, works the queue, then writes the debrief', async () => {
    const bucket = memBucket({ 'rooms/x/rec.webm': WEBM });
    const ai = { run: vi.fn(async () => ({ segments: [{ start: 0, end: 1, text: 'The 1.5x test comes first.' }] })) };
    rt = makeRt({ INTEL_CHUNK_MB: '1' }, { RECORDINGS: bucket, AI: ai });
    const room = await recordedRoom(WEBM);
    const r = await processIntel(rt, { budgetMs: 5000 });
    expect(r.queued).toBe(1);
    expect(q<{ status: string }>('SELECT status FROM room_transcribe_jobs')[0].status).toBe('done');
    expect(ai.run).toHaveBeenCalled();
    expect(r.debriefs).toBe(1);
    expect((await getDebrief(rt, room.id))!.debrief.stats.lines).toBeGreaterThan(0);
  });
});

// ───────────── alignment: retention, spikes, objections ─────────────

const LINES: Line[] = [
  { start_ms: 0, end_ms: 50_000, text: 'Welcome. Today you learn how to buy a competitor with the seller financing part of the price.' },
  { start_ms: 60_000, end_ms: 170_000, text: 'Here is the history of the SBA program and every rule in it.' },
  { start_ms: 180_000, end_ms: 230_000, text: 'The 1.5x test tells you if the deal pays for itself.' },
  { start_ms: 240_000, end_ms: 300_000, text: 'Apply now and the team reviews your buy box.' },
];
describe('aligning the room’s signals with the transcript', () => {
  it('says where people left and what was being said then, with numbers from the curve', () => {
    const curve = [{ ms: 0, n: 61 }, { ms: MIN, n: 60 }, { ms: 2 * MIN, n: 55 }, { ms: 3 * MIN, n: 50 }, { ms: 4 * MIN, n: 50 }, { ms: 5 * MIN, n: 49 }];
    const leaks = retentionLeaks(curve, LINES, [{ ms: 0, title: 'Opening' }]);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ fromMs: 0, toMs: 3 * MIN, fromN: 61, toN: 50, lost: 11, lostPct: 18 });
    expect(leaks[0].text).toBe('You lost 18% (11 of 61) between 0:00 and 3:00 while explaining: "Welcome. Today you learn how to buy a competitor with the seller financing part of the price. Here is the history of the SBA program and every rule in it. The…"');
    expect(linesBetween(LINES, 2 * MIN, 2 * MIN + 1).map((l) => l.start_ms)).toEqual([60_000]);
    // Small rooms and small dips are not "leaks".
    expect(retentionLeaks([{ ms: 0, n: 2 }, { ms: MIN, n: 1 }], LINES)).toEqual([]);
    expect(retentionLeaks([{ ms: 0, n: 100 }, { ms: MIN, n: 95 }], LINES)).toEqual([]);
  });
  it('finds the applying and buying spikes and the teaching point right before them', () => {
    const ev: TimedEvent[] = [...[240_500, 250_000, 255_000].map((ms) => ({ ms, kind: 'application' as const })), { ms: 290_000, kind: 'purchase' as const }];
    const s = spikes([...ev], LINES, [{ ms: 0, title: 'Opening' }, { ms: 180_000, title: 'The test' }], [{ ms: 238_000, kind: 'application' }, { ms: 242_000, kind: 'deposit' }]);
    // Each spike is credited to its own card: applications to the application push, purchases to the offer.
    expect(s.map((x) => [x.kind, x.ms, x.count, x.push])).toEqual([['application', 240_000, 3, 'application'], ['purchase', 240_000, 1, 'deposit']]);
    expect(s[0].said).toContain('The 1.5x test tells you');
    expect(s[0].chapter).toBe('The test');
  });
  it('groups objections from real messages and quotes them', () => {
    const o = objections([{ ms: 1, text: 'What does the deposit cost?' }, { ms: 2, text: 'Will a bank lend without a personal guarantee' }, { ms: 3, text: 'is this too expensive for a small business' }, { ms: 4, text: 'great session' }]);
    expect(o[0]).toMatchObject({ topic: 'Price and the deposit', count: 2 });
    expect(o.find((x) => x.topic.startsWith('Financing'))!.quotes[0].text).toContain('personal guarantee');
    expect(o.some((x) => x.quotes.some((qq) => qq.text === 'great session'))).toBe(false);
  });
  it('chapters come from the host’s agenda marks, else from the transcript', () => {
    expect(chaptersFrom([{ ms: 0, title: 'Opening' }, { ms: 5, title: 'Opening' }, { ms: 90_000, title: 'Funding' }], LINES, 300_000)).toEqual([{ ms: 0, title: 'Opening' }, { ms: 90_000, title: 'Funding' }]);
    expect(chaptersFrom([], LINES, 300_000)[0].title).toBe('Welcome. Today you learn how to buy a');
  });
});

// ───────────── the debrief ─────────────

function input(): DebriefInput {
  return {
    title: 'Buy your first competitor', durationMs: 300_000, people: 64, peak: 61, liveMinutes: 92, lines: LINES, transcriptSource: 'whisper',
    curve: [{ ms: 0, n: 61 }, { ms: MIN, n: 60 }, { ms: 2 * MIN, n: 55 }, { ms: 3 * MIN, n: 50 }, { ms: 4 * MIN, n: 50 }],
    events: [
      { ms: 30_000, kind: 'chat', text: 'Hi from Perth' }, { ms: 31_000, kind: 'chat', text: 'What does the deposit cost?' }, { ms: 32_000, kind: 'react' }, { ms: 33_000, kind: 'question', text: 'Will a bank lend without a personal guarantee' },
      { ms: 238_000, kind: 'push', ref: 'application' }, { ms: 240_500, kind: 'application' }, { ms: 250_000, kind: 'application' }, { ms: 290_000, kind: 'purchase' },
    ],
    marks: [{ ms: 0, title: 'Opening' }, { ms: 180_000, title: 'The 1.5x test' }],
    pushes: [{ ms: 238_000, kind: 'application' }],
    messages: [{ ms: 31_000, text: 'What does the deposit cost?' }, { ms: 33_000, text: 'Will a bank lend without a personal guarantee' }, { ms: 30_000, text: 'Hi from Perth' }],
    reactionsKnown: true,
  };
}
/** Every string in the debrief, for the number audit. */
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

describe('the debrief without an AI key: every number comes from the data', () => {
  it('builds the summary, leaks, spikes, objections, moments, chapters and script changes from the numbers only', () => {
    const inp = input();
    const d = ruleDebrief(inp);
    expect(d.source).toBe('rules');
    expect(d.stats).toMatchObject({ people: 64, peak: 61, liveMinutes: 92, chat: 2, questions: 1, reactions: 1, applications: 2, purchases: 1 });
    expect(d.summary).toBe('64 people joined "Buy your first competitor", 61 at the peak, over 92 minutes live. 2 applications and 1 purchase came from the room. The chat had 2 messages and the Q&A 1 question, with 1 reaction.');
    expect(d.leaks[0].lostPct).toBe(18);
    expect(d.spikes[0]).toMatchObject({ kind: 'application', count: 2 });
    expect(d.improvements.length).toBeGreaterThan(0);
    // The audit: each number in any string is a number in the input, a count of input rows, or a time of an input row.
    const allowed = allowedNumbers(inp);
    const derived = new Set<string>();
    const times = [...inp.events.map((e) => e.ms), ...inp.curve.map((c) => c.ms), ...inp.lines.map((l) => l.start_ms), ...inp.marks.map((m) => m.ms)];
    for (const t of times) { derived.add(stamp(t)); derived.add(stamp(Math.floor(t / MIN) * MIN)); }
    for (let n = 0; n <= inp.events.length; n++) derived.add(String(n)); // counts of rows
    for (const c of inp.curve) for (const c2 of inp.curve) if (c.n > c2.n) { derived.add(String(c.n - c2.n)); derived.add(String(Math.round(((c.n - c2.n) / c.n) * 100))); }
    for (const s of strings(d)) for (const n of numbersIn(s)) expect(allowed.has(n) || derived.has(n), `"${n}" in "${s}"`).toBe(true);
    // Area C's reactions table missing: the line is left out, never shown as zero.
    expect(ruleDebrief({ ...inp, reactionsKnown: false }).summary).not.toContain('reaction');
  });
  it('says what is missing instead of filling it in', () => {
    const d = ruleDebrief({ ...input(), lines: [], transcriptSource: 'none', curve: [], events: [], messages: [] });
    expect(d.notes.join(' ')).toContain('No transcript yet');
    expect(d.notes.join(' ')).toContain('No retention minutes');
    expect(d.leaks).toEqual([]);
    expect(d.improvements[0]).toContain('Nobody applied or bought');
  });
  it('keeps Claude’s prose to the data: a sentence with an invented number is dropped and noted', () => {
    const base = ruleDebrief(input());
    const allowed = allowedNumbers(base, LINES.map((l) => l.text));
    expect(guardNumbers('You lost 18% at 0:00. Conversion rose 42% overall.', allowed)).toEqual({ text: 'You lost 18% at 0:00.', dropped: 1 });
    const m = mergeAi(base, { summary: '64 people came and 61 stayed at the peak. About 300 owners will buy next time.', improvements: ['Move the 1.5x test before 3:00.', 'Expect 25 sales.'], chapters: [{ ms: 0, title: 'Why owners stall' }, { ms: 180_000, title: 'The 1.5x test' }] }, allowed);
    expect(m.source).toBe('claude');
    expect(m.summary).toBe('64 people came and 61 stayed at the peak.');
    expect(m.improvements[0]).toBe('Move the 1.5x test before 3:00.');
    expect(m.improvements).not.toContain('Expect 25 sales.');
    expect(m.chapters.map((c) => c.title)).toEqual(['Why owners stall', 'The 1.5x test']);
    expect(m.notes.join(' ')).toContain('2 AI-written sentences were left out');
  });
});

// ───────────── the room's log, the timeline and the debrief from the database ─────────────

describe('the room’s timeline in the database', () => {
  async function seededRoom() {
    const room = await createRoom(rt, { mode: 'webinar', title: 'Live: buy a competitor', refType: 'none', startsAt: T0 - HOUR });
    x("UPDATE rooms SET status = 'ended', went_live_at = ?, ended_at = ?, peak = 3 WHERE id = ?", T0 - HOUR, T0 - HOUR + 6 * MIN, room.id);
    x("INSERT INTO room_recordings (id, room_id, r2_key, upload_id, mime, status, parts, bytes, started_at, ended_at) VALUES ('recbbbbbbbbbb', ?, 'k', 'u', 'video/webm', 'ready', 1, 10, ?, ?)", room.id, T0 - HOUR + 30_000, T0 - HOUR + 6 * MIN);
    const st = { id: room.id, status: 'live', members: { hadmin: { id: 'hadmin', name: 'Josh', role: 'host', connected: 1, stage: true }, rann: { id: 'rann', name: 'Ann B.', role: 'attendee', connected: 1, stage: false } }, eng: { agenda: [{ title: 'Opening' }, { title: 'The 1.5x test' }] } };
    const at = (m: number) => T0 - HOUR + m;
    await onRoomMessage(rt.env, st, 'hadmin', { t: 'chapter', n: 0 }, at(31_000));
    await onRoomMessage(rt.env, st, 'rann', { t: 'chat', text: '  Is the deposit refundable? ' }, at(90_000));
    await onRoomMessage(rt.env, st, 'rann', { t: 'ask', text: 'Can a bank lend against the target?' }, at(100_000));
    await onRoomMessage(rt.env, st, 'rann', { t: 'react', kind: 'clap' }, at(110_000));
    await onRoomMessage(rt.env, st, 'hadmin', { t: 'chapter', n: 1 }, at(3 * MIN + 30_000));
    await onRoomMessage(rt.env, st, 'rann', { t: 'pin', mid: 1 }, at(1)); // not logged
    expect((await onIntelMessage(rt.env, st, 'rann', { t: 'intel_speaker', id: 'rann' }, at(1))).ok).toBe(false); // only the host reports speakers
    expect((await onIntelMessage(rt.env, st, 'hadmin', { t: 'intel_speaker', id: 'hadmin' }, at(31_000))).ok).toBe(true);
    x("INSERT INTO room_minutes (room_id, minute, n) VALUES (?, 0, 3), (?, 1, 3), (?, 2, 3), (?, 3, 2), (?, 4, 1)", room.id, room.id, room.id, room.id, room.id);
    x("INSERT INTO room_pushes (room_id, id, kind, ref, targets, target_count, created_at, closed_at) VALUES (?, 1, 'application', NULL, NULL, 2, ?, NULL), (?, 2, 'resource', 'calculator', NULL, 2, ?, ?), (?, 3, 'deposit', NULL, NULL, 2, ?, NULL), (?, 4, 'sprint', NULL, '[\"rann\"]', 1, ?, NULL)",
      room.id, at(4 * MIN), room.id, at(2 * MIN), at(3 * MIN), room.id, at(5 * MIN), room.id, at(5 * MIN));
    x("INSERT INTO room_push_events (room_id, push_id, who, event, lead_id, at) VALUES (?, 1, 'rann', 'submitted', 'l1', ?), (?, 3, 'rann', 'paid', 'l1', ?)", room.id, at(4 * MIN + 20_000), room.id, at(5 * MIN + 30_000));
    x("INSERT INTO room_attendance (room_id, who, name, role, first_at, last_at) VALUES (?, 'rann', 'Ann B.', 'attendee', ?, ?), (?, 'rbob', 'Bob', 'attendee', ?, ?)", room.id, at(0), at(0), room.id, at(0), at(0));
    x("INSERT INTO room_captions (room_id, t_ms, text, lang) VALUES (?, 40000, 'Welcome to the session', 'en'), (?, ?, 'Now the test', 'en')", room.id, room.id, at(3 * MIN + 40_000));
    return (await getRoom(rt, room.id))!;
  }
  it('puts every signal on the recording’s clock and uses the live captions until Whisper is done', async () => {
    const room = await seededRoom();
    const t = await timeline(rt, room);
    expect(t.origin).toBe('recording');
    expect(t.durationMs).toBe(6 * MIN - 30_000);
    expect(t.transcriptSource).toBe('captions');
    // Captions in ms since Go live and as epoch ms both land on the recording's clock.
    expect(t.lines.map((l) => [l.start_ms, l.text])).toEqual([[10_000, 'Welcome to the session'], [3 * MIN + 10_000, 'Now the test']]);
    expect(t.marks).toEqual([{ ms: 1000, title: 'Opening' }, { ms: 3 * MIN, title: 'The 1.5x test' }]);
    expect(t.curve[0]).toEqual({ ms: -30_000, n: 3 });
    expect(t.messages.map((m) => m.text)).toEqual(['Is the deposit refundable?', 'Can a bank lend against the target?']);
    expect(t.pushes.map((p) => p.kind)).toEqual(['resource', 'application', 'deposit']); // the targeted Sprint push is not replayed
    const h = heatmap(t);
    expect(h).toHaveLength(6);
    expect(h[1]).toMatchObject({ chat: 1, questions: 1, reactions: 1 });
    expect(h[3]).toMatchObject({ applications: 1, pushes: 1 });
    expect(h[5]).toMatchObject({ purchases: 1 });
  });
  it('writes and stores the debrief without a key, and posts it to Command as a document', async () => {
    const room = await seededRoom();
    const r = await buildDebrief(rt, room, { post: true });
    expect(r.debrief.source).toBe('rules');
    expect(r.note).toContain('Built from the numbers alone');
    expect(r.debrief.objections.map((o) => o.topic)).toContain('Price and the deposit');
    const doc = q<{ title: string; body: string; kind: string }>('SELECT title, body, kind FROM ops_documents')[0];
    expect(doc).toMatchObject({ title: 'Debrief: Live: buy a competitor', kind: 'room_debrief' });
    expect(doc.body).toContain('## Objections raised');
    expect((await getDebrief(rt, room.id))!.docId).toBeTruthy();
  });
  it('with Claude: the prose is merged, invented numbers are dropped', async () => {
    const room = await seededRoom();
    const asks: string[] = [];
    setClaudeTransport(async (_rt, a) => { asks.push(a.model); return JSON.stringify({ summary: '2 people joined. Sales will triple to 99.', improvements: ['Open the application at 3:00.'], chapters: [{ ms: 0, title: 'Hello' }, { ms: 180_000, title: 'The test' }] }); });
    const r = await buildDebrief(makeRt({ INTEL_MODEL: '' }), room);
    expect(asks[0]).toBe('claude-sonnet-5-5'); // the reasoning default from ops/claude.ts
    expect(r.debrief.source).toBe('claude');
    expect(r.debrief.summary).toBe('2 people joined.');
    expect(r.debrief.notes.join(' ')).toContain('left out');
  });
  it('suggests 3 to 6 clips inside the recording and keeps edits inside it', async () => {
    const room = await seededRoom();
    x("INSERT INTO room_transcript (rec_id, room_id, chunk, start_ms, end_ms, text) VALUES " + Array.from({ length: 30 }, (_, i) => `('recbbbbbbbbbb', '${room.id}', 0, ${i * 10_000}, ${i * 10_000 + 9000}, 'Line ${i} about seller finance')`).join(', '));
    const t = await timeline(rt, room);
    const d = (await buildDebrief(rt, room)).debrief;
    const r = await suggestClips(rt, room, t, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clips.length).toBeGreaterThanOrEqual(1);
    for (const c of r.clips) { expect(c.start_ms).toBeGreaterThanOrEqual(0); expect(c.end_ms).toBeLessThanOrEqual(t.rec!.durationMs); }
    expect((await saveClip(rt, r.clips[0].id, { end_ms: t.rec!.durationMs + 5000 })).ok).toBe(false);
    expect((await saveClip(rt, r.clips[0].id, { title: 'The 1.5x test', status: 'approved' })).ok).toBe(true);
  });
});

// ───────────── the replay ─────────────

describe('the replay: cards at the moments they were shared', () => {
  const rows = [
    { id: 1, kind: 'application', ref: null, created_at: T0 + 10 * MIN, closed_at: null },
    { id: 2, kind: 'resource', ref: 'calculator', created_at: T0 + 5 * MIN, closed_at: T0 + 8 * MIN },
    { id: 3, kind: 'deposit', ref: null, created_at: T0 + 40 * MIN, closed_at: null },
    { id: 4, kind: 'application', ref: null, created_at: T0 + 30 * MIN, closed_at: null },
    { id: 5, kind: 'sprint', ref: null, created_at: T0 + 20 * MIN, closed_at: null, targets: '["rann"]' },
    { id: 6, kind: 'resource', ref: 'scripts', created_at: T0 + 99 * MIN, closed_at: null },
  ];
  const list = replayPushes(rows, T0 + MIN, 60 * MIN);
  it('maps pushes onto the recording’s clock (targeted and after-the-end ones are not replayed)', () => {
    expect(list.map((p) => [p.id, p.atMs, p.untilMs])).toEqual([[2, 4 * MIN, 7 * MIN], [1, 9 * MIN, null], [4, 29 * MIN, null], [3, 39 * MIN, null]]);
  });
  it('shows each card from its moment until it was taken down; the latest one per kind', () => {
    expect(cardsAt(list, 3 * MIN, { offerOpen: true })).toEqual([]);
    expect(cardsAt(list, 5 * MIN, { offerOpen: true }).map((p) => p.id)).toEqual([2]);
    expect(cardsAt(list, 7 * MIN, { offerOpen: true }).map((p) => p.id)).toEqual([]);
    expect(cardsAt(list, 30 * MIN, { offerOpen: true }).map((p) => p.id)).toEqual([4]);
  });
  it('the deposit card only while the session’s offer is really open', () => {
    expect(cardsAt(list, 45 * MIN, { offerOpen: true }).map((p) => p.kind)).toEqual(['application', 'deposit']);
    expect(cardsAt(list, 45 * MIN, { offerOpen: false }).map((p) => p.kind)).toEqual(['application']);
  });
  it('captions and replay points', () => {
    expect(toVtt([{ start_ms: 1500, end_ms: 4200, text: 'Seller finance --> rollover', speaker: 'Josh' }])).toBe('WEBVTT\n\n1\n00:00:01.500 --> 00:00:04.200\n<v Josh>Seller finance -> rollover\n');
    expect(markWatched('', 3, 10)).toBe('0001');
    expect(markWatched('0001', 0, 10)).toBe('1001');
    expect(replayAwardsFor('1'.repeat(25))).toBe(2);
    expect(replayAwardsFor('1'.repeat(200))).toBe(6);
  });
  it('a replay ping records the minute, the funnel’s replay, the stage and capped points', async () => {
    const ev = await saveEvent(rt, { title: 'Live', starts_at: T0 - 20 * MIN, tz: 'UTC', duration_min: 60, platform: 'room' }) as { id: string };
    expect(ev.id).toBeTruthy();
    const room = await ensureRoomFor(rt, 'live', ev.id, { title: 'Live', startsAt: T0 - 20 * MIN, durationMin: 60 });
    x(`INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, first_name, email, status) VALUES ('l1', 'Rl1', ?, ?, 'v1', 'Dana', 'd@example.com', 'partial')`, T0 - DAY, T0 - DAY);
    x(`INSERT INTO live_webinar_regs (id, token, event_id, lead_id, revenue_band, created_at) VALUES ('r1', 'tokr1aaaaaaaaaaaaaaaa', ?, 'l1', '3m-10m', ?)`, ev.id, T0 - DAY);
    const who = { id: 'rr1', leadId: 'l1', regId: 'r1' };
    let last = null;
    for (let m = 0; m < 21; m++) last = await replayPing(rt, room, who, { pos: m * 60 + 5, secs: 15 }, 60 * MIN);
    expect(last).toMatchObject({ watched: 21, replayPoints: 10 });
    await replayPing(rt, room, who, { pos: 65, secs: 15 }, 60 * MIN); // a re-watched minute earns nothing more
    expect(q<{ n: number }>("SELECT SUM(points) AS n FROM room_points WHERE who = 'rr1' AND action = 'replay_10'")[0].n).toBe(10);
    expect(q<{ replay_at: number }>("SELECT replay_at FROM live_webinar_regs WHERE id = 'r1'")[0].replay_at).toBe(T0);
    expect(q<{ stage: string; value: number }>("SELECT stage, value FROM attr_stages WHERE reg_id = 'r1' AND stage = 'replay_watched'")[0]).toMatchObject({ stage: 'replay_watched', value: 21 });
    // Points off: watching still counts, no points.
    const r2 = await replayPing(makeRt({ INTEL_REPLAY_POINTS: 'off' }), room, { id: 'rr2', leadId: 'l1', regId: 'r1' }, { pos: 5, secs: 15 }, 60 * MIN);
    expect(r2).toMatchObject({ watched: 1, replayPoints: 0 });
  });
});

// ───────────── simulive ─────────────

describe('simulive: a recorded live session as the automated webinar', () => {
  const ed = buildRoomEdition({
    roomId: 'rmabcdefgh12', recId: 'recaaaaaaaaaa', src: '/rooms/replay/recaaaaaaaaaa', title: 'Buy your first competitor', recordedAt: T0 - 7 * DAY, durationMs: 92 * MIN + 30_000,
    chapters: [{ ms: 0, title: 'Opening' }, { ms: 30_000, title: 'Same minute' }, { ms: 41 * MIN, title: 'The offer' }],
    pushes: [{ id: 1, kind: 'application', ref: null, atMs: 41 * MIN + 5000, untilMs: null }, { id: 2, kind: 'deposit', ref: null, atMs: 50 * MIN, untilMs: null }, { id: 3, kind: 'sprint', ref: null, atMs: 60 * MIN, untilMs: null }],
  });
  it('builds the edition: length, the offer minute from the first live offer, chapters, cards (never the live deposit)', () => {
    expect(ed).toMatchObject({ durationMin: 93, pitchAtMin: 41 });
    expect(ed.chapters).toEqual([{ at: 0, title: 'Opening' }, { at: 41, title: 'The offer' }]);
    expect(ed.pushes).toEqual([{ atSec: 2465, kind: 'application', ref: null }, { atSec: 3600, kind: 'sprint', ref: null }]);
    expect(parseRoomEdition(JSON.stringify(ed))).toEqual(ed);
    expect(parseRoomEdition('nope')).toBeNull();
  });
  it('becomes the webinar’s edition through the settings, and falls back when it is missing', () => {
    const s = { WEBINAR_EDITION: 'room', WEBINAR_ROOM_EDITION: JSON.stringify(ed) };
    expect(editionName(s)).toBe('room');
    expect(edition(s)).toMatchObject({ name: 'room', durationMin: 93, pitchAtMin: 41, videoSrc: '/rooms/replay/recaaaaaaaaaa', polls: [] });
    expect(editionName({ WEBINAR_EDITION: 'room' })).toBe('recorded');
    expect(edition({ WEBINAR_EDITION: 'room' }).name).toBe('recorded');
  });
  it('everyone in a showing is at the same second, and the cards fire at their seconds', () => {
    const starts = T0 - 41 * MIN - 10_000;
    const a = showingPosition(starts, T0, 93 * 60), b = showingPosition(starts, T0, 93 * 60);
    expect(a).toBe(b);
    expect(a).toBe(2470);
    expect(showingPosition(starts, starts - 5000, 93 * 60)).toBe(0);
    expect(showingPosition(starts, starts + DAY, 93 * 60)).toBe(93 * 60);
    expect(firedAt(ed, a).map((p) => p.kind)).toEqual(['application']);
    expect(firedAt(ed, 2464)).toEqual([]);
  });
  it('is labelled honestly: a recorded session, with the date it was recorded, never "live"', async () => {
    rt = makeRt({ WEBINAR_EDITION: 'room', WEBINAR_ROOM_EDITION: JSON.stringify(ed) });
    const c = (await simuliveConfig(rt, { starts_at: T0 }, false))!;
    expect(c.label).toBe('Recorded session');
    expect(c.note).toBe('A recording of the live session from October 26, 2026. The chat is live: it holds only owners in this showing, and Josh’s team when they join.');
    expect(c.pushes).toEqual([{ at: 2465, kind: 'application' }, { at: 3600, kind: 'sprint' }]);
    expect((await simuliveConfig(rt, { starts_at: T0 }, true))!.label).toBe('Replay showing');
    expect(showingLabel(false)).not.toMatch(/\blive\b/i);
    expect(await simuliveConfig(makeRt(), { starts_at: T0 }, false)).toBeNull();
  });
  it('publishing from a room sets the edition (a room with no recording is refused)', async () => {
    const room = await createRoom(rt, { mode: 'webinar', title: 'Live: buy a competitor', refType: 'none', startsAt: T0 - HOUR });
    expect((await publishEdition(rt, room)).ok).toBe(false);
    x("INSERT INTO room_recordings (id, room_id, r2_key, upload_id, mime, status, parts, bytes, started_at, ended_at) VALUES ('recccccccccc', ?, 'k', 'u', 'video/webm', 'ready', 1, 10, ?, ?)", room.id, T0 - HOUR, T0 - HOUR + 70 * MIN);
    const r = await publishEdition(rt, room);
    expect(r.ok).toBe(true);
    const saved = Object.fromEntries(q<{ key: string; value: string }>('SELECT key, value FROM settings').map((s) => [s.key, s.value]));
    expect(saved.WEBINAR_EDITION).toBe('room');
    expect(parseRoomEdition(saved.WEBINAR_ROOM_EDITION)).toMatchObject({ durationMin: 70, src: '/rooms/replay/recccccccccc' });
  });
});

// ───────────── clips ─────────────

describe('highlight clips', () => {
  const lines: Line[] = Array.from({ length: 40 }, (_, i) => ({ start_ms: i * 8000, end_ms: i * 8000 + 7000, text: `Sentence ${i} on the stack: commercial debt, seller finance and rollover.` }));
  it('start and end on sentence boundaries, 15 to 90 seconds, inside the recording, never overlapping, at most 6', () => {
    const cands = [100_000, 104_000, 20_000, 300_000, 200_000, 250_000, 150_000, 60_000, 5000].map((ms, i) => ({ ms, reason: `moment ${i}` }));
    const clips = pickClips(cands, lines, 320_000);
    expect(clips.length).toBeGreaterThanOrEqual(3);
    expect(clips.length).toBeLessThanOrEqual(6);
    for (const c of clips) {
      expect(lines.some((l) => l.start_ms === c.start_ms)).toBe(true);
      expect(lines.some((l) => l.end_ms === c.end_ms) || c.end_ms === 320_000).toBe(true);
      expect(c.end_ms - c.start_ms).toBeGreaterThanOrEqual(15_000);
      expect(c.end_ms - c.start_ms).toBeLessThanOrEqual(90_000);
      expect(c.start_ms).toBeGreaterThanOrEqual(0);
      expect(c.end_ms).toBeLessThanOrEqual(320_000);
      expect(c.caption).toContain('Sentence');
    }
    for (let i = 1; i < clips.length; i++) expect(clips[i].start_ms).toBeGreaterThanOrEqual(clips[i - 1].end_ms);
    const cues = clipCues(lines, clips[0]);
    expect(cues[0].from).toBe(0);
    expect(cues.every((c) => c.to <= clips[0].end_ms - clips[0].start_ms)).toBe(true);
  });
  it('titles read as a phrase, not a cut-off sentence', () => {
    expect(clipTitle('Josh bought both of his clinics this way, and in both deals the sellers financed one hundred percent of the price.')).toBe('Josh bought both of his clinics this way');
    expect(clipTitle('The order matters.')).toBe('The order matters');
    expect(clipTitle('Most first time buyers do it the other way around and spend months on a bank')).toBe('Most first time buyers do it the other way');
  });
  it('near the start and the end of the recording the clip stays inside it', () => {
    const c = pickClips([{ ms: 1000, reason: 'a' }, { ms: 318_000, reason: 'b' }], lines, 320_000);
    expect(c[0].start_ms).toBe(0);
    expect(c[c.length - 1].end_ms).toBeLessThanOrEqual(320_000);
  });
});

// ───────────── copy ─────────────

describe('copy', () => {
  it('every attendee-facing string passes the copy rules', () => {
    const sample = Object.fromEntries(Object.entries(INTEL_COPY).map(([k, v]) => [k, typeof v === 'function' ? (v as (a: unknown) => string)(k === 'replayPoints' ? 5 : 'November 3, 2026') : v]));
    expect(auditFields(sample)).toEqual([]);
    for (const s of Object.values(sample)) expect(String(s)).not.toMatch(/—|!/);
    expect(auditCopy(INTEL_COPY.roomNotice)).toEqual([]);
  });
  it('the number guard reads clock times, decimals and separators', () => {
    expect(numbersIn('At 1:02:03 we had 1,250 people and a 1.5x test, 18%.')).toEqual(['1:02:03', '1250', '1.5', '18']);
  });
});

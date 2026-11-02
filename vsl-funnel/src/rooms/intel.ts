/**
 * Rooms intel (area D), the pure half: no I/O, so the tests drive it directly. intel-db.ts does the reading and
 * writing. What lives here:
 *  - cutting a recording (WebM from Chrome and Firefox, fragmented MP4 from Safari) into chunks Whisper can read on
 *    their own: each chunk starts on a cluster / fragment boundary and gets the file's init segment prepended, and
 *    its start time comes from the container itself (never guessed from byte counts);
 *  - turning Whisper's reply into timed segments and labelling each with the active speaker the room logged;
 *  - aligning the retention curve, the chat, the pushes and the purchases with the transcript;
 *  - the rule-based debrief (every number in it comes from the data) and the guard that keeps any AI-written text
 *    to the numbers in the data;
 *  - the replay's push timing, the simulive edition and its honest labels, and highlight clip boundaries.
 */

// ───────────── copy (every string attendees see; checked by auditCopy in test/intel.test.ts) ─────────────

export const INTEL_COPY = {
  replayEyebrow: 'Replay',
  replayRecorded: (date: string) => `Recorded live on ${date}.`,
  replayNote: 'This is the recording of the live session. The cards appear at the moments they were shared live.',
  chapters: 'Chapters',
  transcript: 'Transcript',
  transcriptSearch: 'Search the transcript',
  transcriptNone: 'The transcript appears here once it is ready.',
  transcriptAuto: 'Transcribed automatically from the recording. Names show who was speaking.',
  noMatches: 'No lines match that search.',
  captionsLabel: 'Captions',
  replayPoints: (n: number) => (n === 1 ? '1 point for watching the replay' : `${n} points for watching the replay`),
  offerClosed: 'The offer from this session has closed.',
  offerCloses: 'The offer from this session closes in',
  applyCard: 'Apply for the engagement',
  applyBody: 'Josh shared the application at this point in the session. The team reads every one.',
  applyButton: 'Open the application',
  sprintCard: 'The First Deal Sprint',
  sprintBody: 'Josh shared the Sprint at this point in the session.',
  sprintButton: 'See the Sprint',
  resourceCard: 'Shared at this point in the session',
  resourceButton: 'Open it',
  depositCard: 'Secure your place in the engagement',
  depositBody: 'The deposit offer from this session is still open, until the time shown.',
  depositButton: 'Secure my place',
  jumpTo: (t: string) => `Jump to ${t}`,
  noRecording: 'The recording of this session is not ready yet. Your room link shows it once it is.',
  back: 'Back',
  previewCard: 'Preview: attendees open this card from here.',
  genericError: 'Something went wrong. Try again.',
  // the live room's notice while recording (privacy: nobody is transcribed without seeing this)
  roomNotice: 'This session is recorded and transcribed for the replay.',
  // simulive / evergreen showings of a recorded live session
  showingLabel: 'Recorded session',
  replayShowingLabel: 'Replay showing',
  showingNote: (date: string) => `A recording of the live session from ${date}. The chat is live: it holds only owners in this showing, and Josh’s team when they join.`,
  showingCardNote: 'Shared at this point in the recorded session.',
};

// ───────────── time helpers ─────────────

export const MIN_MS = 60_000;
export const stamp = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
/** Live captions (area C) store t_ms either as epoch ms or as ms since Go live; both map onto the recording. */
export const captionEpoch = (tMs: number, wentLiveAt: number | null) => (tMs > 1e12 ? tMs : (wentLiveAt ?? 0) + tMs);
export const recMs = (at: number, recStartedAt: number) => at - recStartedAt;

// ───────────── containers: WebM (EBML) ─────────────

const CLUSTER = [0x1f, 0x43, 0xb6, 0x75];

/** An EBML variable-length integer at `i`: its length in bytes and value (unknown sizes report value -1). */
export function vint(b: Uint8Array, i: number): { len: number; value: number } | null {
  if (i >= b.length) return null;
  const first = b[i];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || i + len > b.length) return null;
  let value = first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let k = 1; k < len; k++) { value = value * 256 + b[i + k]; if (b[i + k] !== 0xff) allOnes = false; }
  return { len, value: allOnes ? -1 : value };
}
const uint = (b: Uint8Array, i: number, n: number) => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + b[i + k]; return v; };

/** The Info element's TimecodeScale (ns per tick; 1,000,000 when absent, as Chrome writes it). */
export function webmTimecodeScale(head: Uint8Array) {
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x2a && head[i + 1] === 0xd7 && head[i + 2] === 0xb1) {
      const sz = vint(head, i + 3);
      if (sz && sz.value > 0 && sz.value <= 8 && i + 3 + sz.len + sz.value <= head.length) return uint(head, i + 3 + sz.len, sz.value) || 1_000_000;
    }
  }
  return 1_000_000;
}

/**
 * Cluster starts in a window of the file: the Cluster ID, a size (often "unknown" in live recordings), then the
 * cluster's Timecode element. Requiring the Timecode right after the header rules out the ID's bytes appearing
 * by chance inside a frame. Returns file offsets and the cluster time in ms.
 */
export function webmClusters(b: Uint8Array, base = 0, scale = 1_000_000) {
  const out: { offset: number; ms: number }[] = [];
  for (let i = 0; i + 8 < b.length; i++) {
    if (b[i] !== CLUSTER[0] || b[i + 1] !== CLUSTER[1] || b[i + 2] !== CLUSTER[2] || b[i + 3] !== CLUSTER[3]) continue;
    const sz = vint(b, i + 4);
    if (!sz) continue;
    const j = i + 4 + sz.len;
    if (b[j] !== 0xe7) continue;
    const tsz = vint(b, j + 1);
    if (!tsz || tsz.value < 1 || tsz.value > 8 || j + 1 + tsz.len + tsz.value > b.length) continue;
    out.push({ offset: base + i, ms: Math.round((uint(b, j + 1 + tsz.len, tsz.value) * scale) / 1_000_000) });
  }
  return out;
}

// ───────────── containers: fragmented MP4 ─────────────

const fourcc = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
/** Boxes laid end to end from `start` (stops at the window's end or a box that runs past it unless `partial`). */
export function mp4Boxes(b: Uint8Array, start = 0, end = b.length, partial = false) {
  const out: { type: string; offset: number; size: number; header: number }[] = [];
  let i = start;
  while (i + 8 <= end) {
    let size = uint(b, i, 4);
    let header = 8;
    if (size === 1 && i + 16 <= end) { size = uint(b, i + 8, 8); header = 16; }
    else if (size === 0) size = end - i;
    if (size < header) break;
    if (i + size > end && !partial) break;
    out.push({ type: fourcc(b, i + 4), offset: i, size, header });
    i += size;
  }
  return out;
}
const child = (b: Uint8Array, box: { offset: number; size: number; header: number }, type: string) =>
  mp4Boxes(b, box.offset + box.header, Math.min(b.length, box.offset + box.size)).find((x) => x.type === type) ?? null;
const children = (b: Uint8Array, box: { offset: number; size: number; header: number }, type: string) =>
  mp4Boxes(b, box.offset + box.header, Math.min(b.length, box.offset + box.size)).filter((x) => x.type === type);

/** From the init segment (ftyp + moov): the audio track's id and timescale (else the first track's). */
export function mp4Init(head: Uint8Array) {
  const moov = mp4Boxes(head).find((x) => x.type === 'moov');
  if (!moov) return null;
  let pick: { id: number; timescale: number } | null = null;
  for (const trak of children(head, moov, 'trak')) {
    const tkhd = child(head, trak, 'tkhd');
    const mdia = child(head, trak, 'mdia');
    if (!tkhd || !mdia) continue;
    const v = head[tkhd.offset + tkhd.header];
    const id = uint(head, tkhd.offset + tkhd.header + (v === 1 ? 20 : 12), 4);
    const mdhd = child(head, mdia, 'mdhd');
    const hdlr = child(head, mdia, 'hdlr');
    if (!mdhd) continue;
    const mv = head[mdhd.offset + mdhd.header];
    const timescale = uint(head, mdhd.offset + mdhd.header + (mv === 1 ? 20 : 12), 4);
    const audio = hdlr ? fourcc(head, hdlr.offset + hdlr.header + 8) === 'soun' : false;
    if (!pick || audio) pick = { id, timescale };
    if (audio) break;
  }
  return pick;
}

/** Fragment (moof) starts in a window, with the start time of the chosen track from its tfdt. */
export function mp4Fragments(b: Uint8Array, base: number, track: { id: number; timescale: number }) {
  const out: { offset: number; ms: number }[] = [];
  for (const box of mp4Boxes(b, 0, b.length, true)) {
    if (box.type !== 'moof') continue;
    let ms: number | null = null;
    for (const traf of children(b, box, 'traf')) {
      const tfhd = child(b, traf, 'tfhd');
      const tfdt = child(b, traf, 'tfdt');
      if (!tfdt) continue;
      const id = tfhd ? uint(b, tfhd.offset + tfhd.header + 4, 4) : track.id;
      const v = b[tfdt.offset + tfdt.header];
      const t = v === 1 ? uint(b, tfdt.offset + tfdt.header + 4, 8) : uint(b, tfdt.offset + tfdt.header + 4, 4);
      const tms = Math.round((t / Math.max(1, track.timescale)) * 1000);
      if (id === track.id) { ms = tms; break; }
      ms ??= tms;
    }
    out.push({ offset: base + box.offset, ms: ms ?? 0 });
  }
  return out;
}

// ───────────── chunk planning ─────────────

export type Container = 'webm' | 'mp4';
export const containerOf = (mime: string, head: Uint8Array): Container | null => {
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  if (fourcc(head, 4) === 'ftyp') return 'mp4';
  return /webm/i.test(mime) ? 'webm' : /mp4/i.test(mime) ? 'mp4' : null;
};

/** Where the init segment ends: the first cluster (WebM) or the first moof (MP4). */
export function headerEnd(container: Container, head: Uint8Array) {
  if (container === 'webm') { const c = webmClusters(head)[0]; return c ? c.offset : null; }
  const f = mp4Boxes(head, 0, head.length, true).find((x) => x.type === 'moof');
  return f ? f.offset : null;
}

export interface Boundary { offset: number; ms: number }
/** The boundaries (cluster or fragment starts) inside a window of the file that starts at `base`. */
export function boundaries(container: Container, win: Uint8Array, base: number, o: { scale?: number; track?: { id: number; timescale: number } | null }) {
  return container === 'webm' ? webmClusters(win, base, o.scale ?? 1_000_000) : o.track ? mp4Fragments(win, base, o.track) : [];
}

export interface ChunkPlan { start: number; end: number; startMs: number; endMs: number | null; last: boolean }
/**
 * The next chunk from a window read at `base` (always a boundary). It ends on the last boundary at or under
 * `target` bytes; a single cluster larger than that runs to the next boundary in the window; the final chunk
 * runs to the end of the file. Null when the window holds no usable boundary (the caller skips ahead).
 */
export function planChunk(bounds: Boundary[], base: number, winLen: number, size: number, target: number): ChunkPlan | null {
  const first = bounds.find((x) => x.offset === base);
  if (!first) return null;
  const after = bounds.filter((x) => x.offset > base);
  const eof = base + winLen >= size;
  if (eof && (base + target >= size || !after.length)) return { start: base, end: size, startMs: first.ms, endMs: null, last: true };
  const within = after.filter((x) => x.offset - base <= target);
  const cut = within.length ? within[within.length - 1] : after[0];
  if (!cut) return null;
  return { start: base, end: cut.offset, startMs: first.ms, endMs: cut.ms, last: false };
}

// ───────────── Whisper output ─────────────

export interface Segment { start_ms: number; end_ms: number; text: string; speaker?: string | null }
const cleanText = (s: string) => s.replace(/\([^)]{1,30}\)|\[[^\]]{1,30}\]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Whisper's reply as timed segments, offset by the chunk's start. The turbo model returns segments; the older
 * one returns words (grouped here into sentences of up to ~12 s); a reply with text only becomes one segment
 * spanning the chunk.
 */
export function whisperSegments(r: unknown, startMs: number, endMs: number | null): Segment[] {
  const x = (r ?? {}) as { text?: string; segments?: { start?: number; end?: number; text?: string }[]; words?: { word?: string; start?: number; end?: number }[] };
  const out: Segment[] = [];
  if (Array.isArray(x.segments) && x.segments.length) {
    for (const s of x.segments) {
      const text = cleanText(String(s.text ?? ''));
      if (!text || typeof s.start !== 'number') continue;
      const a = startMs + Math.round(s.start * 1000);
      out.push({ start_ms: a, end_ms: Math.max(a, startMs + Math.round((typeof s.end === 'number' ? s.end : s.start) * 1000)), text });
    }
    return out;
  }
  if (Array.isArray(x.words) && x.words.length) {
    let cur: { a: number; b: number; w: string[] } | null = null;
    for (const w of x.words) {
      if (typeof w.start !== 'number' || !w.word) continue;
      const a = startMs + Math.round(w.start * 1000), b = startMs + Math.round((w.end ?? w.start) * 1000);
      if (!cur) cur = { a, b, w: [] };
      cur.w.push(String(w.word).trim()); cur.b = b;
      if (/[.?!]$/.test(String(w.word).trim()) || cur.b - cur.a > 12_000) { const t = cleanText(cur.w.join(' ')); if (t) out.push({ start_ms: cur.a, end_ms: cur.b, text: t }); cur = null; }
    }
    if (cur) { const t = cleanText(cur.w.join(' ')); if (t) out.push({ start_ms: cur.a, end_ms: cur.b, text: t }); }
    return out;
  }
  const text = cleanText(String(x.text ?? ''));
  return text ? [{ start_ms: startMs, end_ms: endMs ?? startMs, text }] : [];
}

export interface SpeakerChange { ms: number; name: string }
/** Each segment gets the speaker the room had in focus when the segment started (half a second of slack). */
export function labelSpeakers(segs: Segment[], changes: SpeakerChange[]): Segment[] {
  const sorted = [...changes].sort((a, b) => a.ms - b.ms);
  return segs.map((s) => {
    let who: string | null = null;
    for (const c of sorted) { if (c.ms <= s.start_ms + 500) who = c.name; else break; }
    return { ...s, speaker: who };
  });
}

/** Speaker changes from the room's log, de-duplicated (the same person reported twice in a row is one change). */
export function speakerChanges(events: { at: number; name: string | null }[], recStartedAt: number): SpeakerChange[] {
  const out: SpeakerChange[] = [];
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (!e.name) continue;
    if (out.length && out[out.length - 1].name === e.name) continue;
    out.push({ ms: recMs(e.at, recStartedAt), name: e.name });
  }
  return out;
}

/** WebVTT captions from transcript lines (the replay's captions track). */
export function toVtt(lines: Segment[]) {
  const t = (ms: number) => { const s = Math.max(0, ms); const h = Math.floor(s / 3_600_000), m = Math.floor((s % 3_600_000) / 60_000), x = Math.floor((s % 60_000) / 1000), r = s % 1000; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}.${String(r).padStart(3, '0')}`; };
  const body = lines.filter((l) => l.text).map((l, i) => `${i + 1}\n${t(l.start_ms)} --> ${t(Math.max(l.end_ms, l.start_ms + 1000))}\n${l.speaker ? `<v ${l.speaker.replace(/[<>]/g, '')}>` : ''}${l.text.replace(/-->/g, '->')}`).join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

// ───────────── the timeline: everything on the recording's clock ─────────────

export interface Line extends Segment {}
export interface CurvePoint { ms: number; n: number }
export interface TimedEvent { ms: number; kind: 'application' | 'purchase' | 'chat' | 'question' | 'react' | 'push' | 'opened'; text?: string | null; name?: string | null; ref?: string | null }

/** The lines being said between two moments (overlapping the window). */
export const linesBetween = (lines: Line[], a: number, b: number) => lines.filter((l) => l.end_ms >= a && l.start_ms <= b);
const quote = (lines: Line[], max = 160) => {
  const t = lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t;
};

export interface Leak { fromMs: number; toMs: number; fromN: number; toN: number; lost: number; lostPct: number; said: string; chapter: string | null; text: string }
/**
 * Where people left: the steepest falls in the retention curve over a few minutes, each with what was being said
 * then ("You lost 18% (11 of 61) between 22:00 and 25:00 while explaining ..."). Windows don't overlap, and a fall
 * only counts from a minute with at least `minPeople` there.
 */
export function retentionLeaks(curve: CurvePoint[], lines: Line[], chapters: Chapter[] = [], o: { windowMs?: number; minPct?: number; minPeople?: number; top?: number } = {}): Leak[] {
  const W = o.windowMs ?? 3 * MIN_MS, minPct = o.minPct ?? 8, minPeople = o.minPeople ?? 3, top = o.top ?? 3;
  const pts = [...curve].sort((a, b) => a.ms - b.ms);
  const cands: Omit<Leak, 'said' | 'chapter' | 'text'>[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].n < minPeople) continue;
    let best: (typeof cands)[number] | null = null;
    for (let j = i + 1; j < pts.length && pts[j].ms - pts[i].ms <= W; j++) {
      const lost = pts[i].n - pts[j].n;
      if (lost <= 0) continue;
      const pct = Math.round((lost / pts[i].n) * 100);
      if (!best || lost > best.lost) best = { fromMs: pts[i].ms, toMs: pts[j].ms, fromN: pts[i].n, toN: pts[j].n, lost, lostPct: pct };
    }
    if (best && best.lostPct >= minPct) cands.push(best);
  }
  cands.sort((a, b) => b.lostPct - a.lostPct || b.lost - a.lost || a.fromMs - b.fromMs);
  const picked: typeof cands = [];
  for (const c of cands) {
    if (picked.length >= top) break;
    if (picked.some((p) => c.fromMs < p.toMs && p.fromMs < c.toMs)) continue;
    picked.push(c);
  }
  return picked.sort((a, b) => a.fromMs - b.fromMs).map((c) => {
    const said = quote(linesBetween(lines, c.fromMs, c.toMs));
    const chapter = chapterAt(chapters, c.fromMs)?.title ?? null;
    const what = said ? `while explaining: "${said}"` : chapter ? `during "${chapter}"` : '(no transcript for that stretch)';
    return { ...c, said, chapter, text: `You lost ${c.lostPct}% (${c.lost} of ${c.fromN}) between ${stamp(c.fromMs)} and ${stamp(c.toMs)} ${what}` };
  });
}

export interface Chapter { ms: number; title: string }
export const chapterAt = (chapters: Chapter[], ms: number) => [...chapters].sort((a, b) => a.ms - b.ms).filter((c) => c.ms <= ms).pop() ?? null;

/** Chapters: the host's agenda marks when there are any, else ten-minute stretches named by their first line. */
export function chaptersFrom(marks: { ms: number; title: string }[], lines: Line[], durationMs: number): Chapter[] {
  const m = marks.filter((x) => x.ms >= 0 && x.ms <= durationMs).sort((a, b) => a.ms - b.ms);
  const dedup = m.filter((x, i) => i === 0 || x.title !== m[i - 1].title);
  if (dedup.length) return dedup.map((x) => ({ ms: x.ms, title: x.title }));
  const out: Chapter[] = [];
  for (let a = 0; a < durationMs; a += 10 * MIN_MS) {
    const first = lines.find((l) => l.start_ms >= a && l.start_ms < a + 10 * MIN_MS);
    if (!first) continue;
    const words = first.text.split(/\s+/).slice(0, 8).join(' ').replace(/[,.;:]+$/, '');
    out.push({ ms: first.start_ms, title: words });
  }
  return out;
}

export interface Spike { kind: 'application' | 'purchase'; ms: number; count: number; chapter: string | null; push: string | null; said: string; text: string }
/**
 * The minutes with the most applications or purchases (at least two in a minute, or the single best minute when
 * there were fewer), each with the teaching point said in the five minutes before and the push that went out.
 */
export function spikes(events: TimedEvent[], lines: Line[], chapters: Chapter[], pushes: { ms: number; kind: string }[] = [], o: { top?: number } = {}): Spike[] {
  const out: Spike[] = [];
  for (const kind of ['application', 'purchase'] as const) {
    const evs = events.filter((e) => e.kind === kind && e.ms >= 0);
    if (!evs.length) continue;
    const per = new Map<number, number>();
    for (const e of evs) { const m = Math.floor(e.ms / MIN_MS); per.set(m, (per.get(m) ?? 0) + 1); }
    let mins = [...per.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    if (!mins.length) mins = [...per.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 1);
    for (const [m, n] of mins.slice(0, o.top ?? 3)) {
      const ms = m * MIN_MS;
      const before = linesBetween(lines, ms - 5 * MIN_MS, ms).slice(-3);
      // The push that led to it: the matching card (the application for applications, the offer for purchases) shared up to ten minutes before.
      const near = pushes.filter((p) => p.ms <= ms + MIN_MS && p.ms >= ms - 10 * MIN_MS).sort((a, b) => b.ms - a.ms);
      const want = kind === 'application' ? ['application'] : ['deposit', 'sprint', 'vip'];
      const push = near.find((p) => want.includes(p.kind)) ?? near[0] ?? null;
      const chapter = chapterAt(chapters, ms)?.title ?? null;
      const said = quote(before);
      const label = kind === 'application' ? (n === 1 ? 'application' : 'applications') : n === 1 ? 'purchase' : 'purchases';
      out.push({ kind, ms, count: n, chapter, push: push?.kind ?? null, said, text: `${n} ${label} at ${stamp(ms)}${push ? ` after the ${push.kind} push` : ''}${said ? `, right after: "${said}"` : chapter ? `, in "${chapter}"` : ''}` });
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

export interface Objection { topic: string; count: number; quotes: { ms: number; text: string }[] }
const OBJECTIONS: [string, RegExp][] = [
  ['Price and the deposit', /\b(price|cost|costs|expensive|afford|fee|fees|deposit|too much|how much|worth it)\b/i],
  ['Financing, banks and personal guarantees', /\b(bank|banks|loan|lender|lenders|financ\w*|debt|credit|interest rate|personal guarantee|pg|collateral|sba)\b/i],
  ['Time and timing', /\b(time|busy|bandwidth|not now|next year|later|too soon|hours a week)\b/i],
  ['Whether it fits their industry, size or country', /\b(my industry|industry|australia|aus|uk|canada|nz|country|works? for|small business|under \$?1m|too small)\b/i],
  ['Trust, risk and proof', /\b(risk|risky|scam|trust|proof|refund\w*|legit|track record|case stud\w*|(?<!personal )guarantee)\b/i],
  ['Sellers saying no', /\b(sellers?|owners?)\b[^.?!]{0,40}\b(won'?t|wouldn'?t|refuse|say no|agree|why would)\b/i],
  ['Partner or board sign-off', /\b(wife|husband|partner|spouse|board|co-?founder|business partner)\b/i],
];
/** Objections raised in the chat and the Q&A, by topic, with the real messages as quotes. */
export function objections(msgs: { ms: number; text: string }[], o: { quotes?: number } = {}): Objection[] {
  const out: Objection[] = [];
  for (const [topic, re] of OBJECTIONS) {
    const hits = msgs.filter((m) => re.test(m.text));
    if (hits.length) out.push({ topic, count: hits.length, quotes: hits.slice(0, o.quotes ?? 3).map((h) => ({ ms: h.ms, text: h.text.slice(0, 200) })) });
  }
  return out.sort((a, b) => b.count - a.count);
}

export interface Moment { ms: number; score: number; chat: number; reactions: number; applications: number; purchases: number; said: string; text: string }
/** The best moments: the minutes with the most real activity (chat, questions, reactions, opens, applications, purchases). */
export function bestMoments(events: TimedEvent[], lines: Line[], o: { top?: number; gapMs?: number } = {}): Moment[] {
  const per = new Map<number, Moment>();
  const W: Record<TimedEvent['kind'], number> = { chat: 1, question: 2, react: 1, opened: 1, push: 0, application: 3, purchase: 5 };
  for (const e of events) {
    if (e.ms < 0) continue;
    const m = Math.floor(e.ms / MIN_MS);
    const cur = per.get(m) ?? { ms: m * MIN_MS, score: 0, chat: 0, reactions: 0, applications: 0, purchases: 0, said: '', text: '' };
    cur.score += W[e.kind];
    if (e.kind === 'chat' || e.kind === 'question') cur.chat++;
    if (e.kind === 'react') cur.reactions++;
    if (e.kind === 'application') cur.applications++;
    if (e.kind === 'purchase') cur.purchases++;
    per.set(m, cur);
  }
  const gap = o.gapMs ?? 3 * MIN_MS;
  const picked: Moment[] = [];
  for (const c of [...per.values()].filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.ms - b.ms)) {
    if (picked.length >= (o.top ?? 5)) break;
    if (picked.some((p) => Math.abs(p.ms - c.ms) < gap)) continue;
    const said = quote(linesBetween(lines, c.ms - 30_000, c.ms + MIN_MS));
    const bits = [c.chat ? `${c.chat} chat ${c.chat === 1 ? 'message' : 'messages'}` : '', c.reactions ? `${c.reactions} ${c.reactions === 1 ? 'reaction' : 'reactions'}` : '', c.applications ? `${c.applications} ${c.applications === 1 ? 'application' : 'applications'}` : '', c.purchases ? `${c.purchases} ${c.purchases === 1 ? 'purchase' : 'purchases'}` : ''].filter(Boolean);
    picked.push({ ...c, said, text: `${stamp(c.ms)}: ${bits.join(', ') || 'activity'}${said ? `. Said: "${said}"` : ''}` });
  }
  return picked.sort((a, b) => a.ms - b.ms);
}

// ───────────── the debrief ─────────────

export interface DebriefInput {
  title: string;
  durationMs: number;
  people: number;
  peak: number;
  liveMinutes: number;
  lines: Line[];
  transcriptSource: 'whisper' | 'captions' | 'none';
  curve: CurvePoint[];
  events: TimedEvent[];
  marks: { ms: number; title: string }[];
  pushes: { ms: number; kind: string }[];
  messages: { ms: number; text: string }[];
  /** Reactions table present (area C); false = the reactions line is left out, never shown as zero. */
  reactionsKnown: boolean;
  /** qa-sells (room_objections, migration 0074): per objection type, the people who raised it and how many bought after. */
  qa?: QaOutcome[];
}
export interface QaOutcome { type: string; label: string; people: number; bought: number; notBought: number; reopened: number; boughtAfterReopen: number }
export interface Debrief {
  version: 1;
  source: 'rules' | 'claude';
  stats: { people: number; peak: number; liveMinutes: number; chat: number; questions: number; reactions: number | null; applications: number; purchases: number; durationMs: number; lines: number; transcript: DebriefInput['transcriptSource'] };
  summary: string;
  chapters: Chapter[];
  moments: Moment[];
  objections: Objection[];
  spikes: Spike[];
  leaks: Leak[];
  improvements: string[];
  notes: string[];
  /** qa-sells: objection to purchase for this room (only when the room's questions were tagged). */
  objectionOutcomes?: QaOutcome[];
}

export function ruleDebrief(x: DebriefInput): Debrief {
  const count = (k: TimedEvent['kind']) => x.events.filter((e) => e.kind === k).length;
  const stats: Debrief['stats'] = {
    people: x.people, peak: x.peak, liveMinutes: x.liveMinutes, chat: count('chat'), questions: count('question'), reactions: x.reactionsKnown ? count('react') : null,
    applications: count('application'), purchases: count('purchase'), durationMs: x.durationMs, lines: x.lines.length, transcript: x.transcriptSource,
  };
  const chapters = chaptersFrom(x.marks, x.lines, x.durationMs);
  const leaks = retentionLeaks(x.curve, x.lines, chapters);
  const sp = spikes(x.events, x.lines, chapters, x.pushes);
  const obj = objections(x.messages);
  const moments = bestMoments(x.events, x.lines);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const summary = [
    `${plural(stats.people, 'person', 'people')} joined "${x.title}", ${stats.peak} at the peak, over ${plural(stats.liveMinutes, 'minute', 'minutes')} live.`,
    `${plural(stats.applications, 'application', 'applications')} and ${plural(stats.purchases, 'purchase', 'purchases')} came from the room.`,
    `The chat had ${plural(stats.chat, 'message', 'messages')} and the Q&A ${plural(stats.questions, 'question', 'questions')}${stats.reactions !== null ? `, with ${plural(stats.reactions, 'reaction', 'reactions')}` : ''}.`,
  ].join(' ');
  const improvements: string[] = [];
  for (const l of leaks) improvements.push(`Tighten ${stamp(l.fromMs)} to ${stamp(l.toMs)}: ${l.lostPct}% of the room left there${l.said ? ` while you said "${l.said}"` : ''}. Cut it, shorten it, or move it after the offer.`);
  for (const s of sp) {
    // An application spike and a purchase spike in the same minute share one change.
    if (sp.some((o) => o !== s && o.ms === s.ms && o.kind === 'application') && s.kind === 'purchase') continue;
    const both = sp.find((o) => o !== s && o.ms === s.ms);
    improvements.push(`${s.text}${both ? ` (and ${both.count} ${both.count === 1 ? 'purchase' : 'purchases'} in the same minute)` : ''}. Make that point earlier and open the ${s.kind === 'application' ? 'application' : 'offer'} right after it next time.`);
  }
  if (obj[0]) improvements.push(`The most raised objection was ${obj[0].topic.toLowerCase()} (${plural(obj[0].count, 'message', 'messages')}). Answer it inside the pitch, before people have to ask.`);
  if (!sp.length && stats.applications + stats.purchases === 0) improvements.push('Nobody applied or bought in the room. Push the application or open the offer earlier, and ask for the decision more than once.');
  const notes: string[] = [];
  if (x.transcriptSource === 'none') notes.push('No transcript yet: the leaks and spikes show times only. Transcribe the recording for the lines.');
  if (x.transcriptSource === 'captions') notes.push('Lines come from the live captions; the Whisper transcript replaces them when it finishes.');
  if (!x.curve.length) notes.push('No retention minutes were recorded (the curve starts when the host presses Go live).');
  // qa-sells: the objection that most often came without a purchase after it (real counts from the room's questions).
  const qa = (x.qa ?? []).filter((o) => o.people > 0);
  const stuck = [...qa].sort((a, b) => b.notBought - a.notBought || b.people - a.people)[0];
  if (stuck && stuck.notBought > 0) improvements.push(`${plural(stuck.people, 'person', 'people')} raised ${stuck.label.toLowerCase()}; ${stuck.bought} bought afterwards and ${stuck.notBought} didn't. Answer it inside the pitch and reopen the offer right after the answer.`);
  return { version: 1, source: 'rules', stats, summary, chapters, moments, objections: obj, spikes: sp, leaks, improvements, notes, ...(qa.length ? { objectionOutcomes: qa } : {}) };
}

// ───────────── numbers: the guard that keeps AI text to the data ─────────────

/** Every number written in a text: plain, with separators, decimals, percent, or a clock time (kept whole). */
export const numbersIn = (s: string) => (s.match(/\d+(?::\d{2}){1,2}|\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,(?=\d{3}\b)/g, ''));
/** The allowed numbers: every number in the facts and in the words people said or typed. */
export function allowedNumbers(...sources: unknown[]) {
  const set = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) { set.add(String(v)); set.add(String(Math.round(v))); return; }
    if (typeof v === 'string') { for (const n of numbersIn(v)) set.add(n); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  sources.forEach(walk);
  return set;
}
/** Drops each sentence of `text` that states a number not in `allowed` (a model's invented figure never reaches the owner). */
export function guardNumbers(text: string, allowed: Set<string>) {
  const parts = text.split(/(?<=[.!?])\s+/);
  const kept = parts.filter((p) => numbersIn(p).every((n) => allowed.has(n)));
  return { text: kept.join(' ').trim(), dropped: parts.length - kept.length };
}

/** Merges an AI-written layer onto the rule debrief: prose only, every number checked; the computed parts stay as they are. */
export function mergeAi(base: Debrief, ai: { summary?: unknown; chapters?: unknown; improvements?: unknown; moments?: unknown } | null, allowed: Set<string>): Debrief {
  if (!ai) return base;
  const out: Debrief = { ...base, source: 'claude', notes: [...base.notes] };
  let dropped = 0;
  if (typeof ai.summary === 'string') { const g = guardNumbers(ai.summary.slice(0, 1500), allowed); dropped += g.dropped; if (g.text) out.summary = g.text; }
  if (Array.isArray(ai.chapters)) {
    const ch = ai.chapters.map((c) => c as { ms?: unknown; at?: unknown; title?: unknown })
      .map((c) => ({ ms: Number(c.ms ?? c.at), title: typeof c.title === 'string' ? c.title.slice(0, 80) : '' }))
      .filter((c) => Number.isFinite(c.ms) && c.ms >= 0 && c.ms <= base.stats.durationMs && c.title && numbersIn(c.title).every((n) => allowed.has(n)));
    if (ch.length >= 2) out.chapters = ch.sort((a, b) => a.ms - b.ms);
  }
  if (Array.isArray(ai.improvements)) {
    const imp = ai.improvements.filter((s): s is string => typeof s === 'string').map((s) => { const g = guardNumbers(s.slice(0, 500), allowed); dropped += g.dropped; return g.text; }).filter(Boolean);
    if (imp.length) out.improvements = [...imp.slice(0, 8), ...base.improvements.filter((b) => !imp.includes(b))].slice(0, 12);
  }
  if (dropped) out.notes.push(`${dropped} AI-written ${dropped === 1 ? 'sentence was' : 'sentences were'} left out because ${dropped === 1 ? 'it' : 'they'} stated a number that isn't in the data.`);
  return out;
}

// ───────────── the replay: pushes at the moments they were shared ─────────────

export interface ReplayPush { id: number; kind: string; ref: string | null; atMs: number; untilMs: number | null }
/** Live pushes on the recording's clock: from when the host shared them until they were taken down (or the end). */
export function replayPushes(pushes: { id: number; kind: string; ref: string | null; created_at: number; closed_at: number | null; targets?: string | null }[], recStartedAt: number, durationMs: number): ReplayPush[] {
  return pushes
    .filter((p) => !p.targets) // a push sent to chosen people only is not replayed to everyone
    .map((p) => ({ id: p.id, kind: p.kind, ref: p.ref, atMs: Math.max(0, p.created_at - recStartedAt), untilMs: p.closed_at ? Math.max(0, p.closed_at - recStartedAt) : null }))
    .filter((p) => p.atMs <= durationMs && (p.untilMs === null || p.untilMs > p.atMs))
    .sort((a, b) => a.atMs - b.atMs);
}
/**
 * The cards showing at a position: shared at or before it and not yet taken down, the latest one per kind (and
 * resource). The deposit card only while the session's offer is really open (it closes with the offer).
 */
export function cardsAt(list: ReplayPush[], posMs: number, o: { offerOpen: boolean }) {
  const live = list.filter((p) => p.atMs <= posMs && (p.untilMs === null || posMs < p.untilMs) && (p.kind !== 'deposit' || o.offerOpen));
  const byKey = new Map<string, ReplayPush>();
  for (const p of live) byKey.set(`${p.kind}:${p.ref ?? ''}`, p);
  return [...byKey.values()].sort((a, b) => a.atMs - b.atMs);
}

/** Replay points: one award per ten distinct minutes watched, capped. */
export const replayAwardsFor = (minutes: string, every = 10, cap = 6) => Math.min(cap, Math.floor([...minutes].filter((c) => c === '1').length / every));
/** Marks minute `m` watched in a per-minute string ("0101…"). */
export function markWatched(cur: string, m: number, total: number) {
  const len = Math.max(cur.length, Math.min(total, m + 1));
  const arr = cur.padEnd(len, '0').split('');
  if (m >= 0 && m < len) arr[m] = '1';
  return arr.join('').slice(0, Math.max(total, 1));
}

// ───────────── simulive: a recorded live session as an automated webinar edition ─────────────

export interface RoomEdition {
  roomId: string;
  recId: string;
  src: string;
  title: string;
  recordedAt: number;
  durationMin: number;
  pitchAtMin: number;
  chapters: { at: number; title: string }[];
  pushes: { atSec: number; kind: string; ref: string | null }[];
}
/** The edition stored in WEBINAR_ROOM_EDITION (Funnel HQ → Rooms → Debrief → Use for showings). */
export function buildRoomEdition(o: { roomId: string; recId: string; src: string; title: string; recordedAt: number; durationMs: number; chapters: Chapter[]; pushes: ReplayPush[] }): RoomEdition {
  const durationMin = Math.max(1, Math.ceil(o.durationMs / MIN_MS));
  const offer = o.pushes.find((p) => p.kind === 'sprint' || p.kind === 'deposit' || p.kind === 'application');
  return {
    roomId: o.roomId, recId: o.recId, src: o.src, title: o.title.slice(0, 140), recordedAt: o.recordedAt, durationMin,
    // The showing's offer (the Sprint) unlocks where Josh first made an offer live; else three quarters through.
    pitchAtMin: offer ? Math.min(durationMin, Math.floor(offer.atMs / MIN_MS)) : Math.floor(durationMin * 0.75),
    chapters: o.chapters.map((c) => ({ at: Math.floor(c.ms / MIN_MS), title: c.title.slice(0, 80) })).filter((c, i, a) => i === 0 || c.at !== a[i - 1].at),
    // The deposit belongs to the live event's own offer window: it is not replayed in showings.
    pushes: o.pushes.filter((p) => p.kind !== 'deposit' && p.kind !== 'vip').map((p) => ({ atSec: Math.floor(p.atMs / 1000), kind: p.kind, ref: p.ref })),
  };
}
export function parseRoomEdition(raw: string | null | undefined): RoomEdition | null {
  if (!raw || !raw.trim().startsWith('{')) return null;
  try {
    const e = JSON.parse(raw) as RoomEdition;
    return e && typeof e.src === 'string' && e.src && e.durationMin > 0 && Array.isArray(e.chapters) && Array.isArray(e.pushes) ? e : null;
  } catch { return null; }
}
/** Where a showing is: the same second for everyone in it (nobody seeks), from the showing's start. */
export const showingPosition = (startsAt: number, now: number, durationSec: number) => Math.max(0, Math.min(durationSec, (now - startsAt) / 1000));
/** The pushes that have fired by a position in a showing. */
export const firedAt = (e: Pick<RoomEdition, 'pushes'>, posSec: number) => e.pushes.filter((p) => p.atSec <= posSec);
/** The honest label for a showing (never "live": the recording is a recording). */
export const showingLabel = (replay: boolean) => (replay ? INTEL_COPY.replayShowingLabel : INTEL_COPY.showingLabel);

// ───────────── highlight clips ─────────────

export interface Clip { start_ms: number; end_ms: number; title: string; caption: string; reason: string }
/**
 * 3 to 6 clips around the strongest moments: each starts at the beginning of a sentence ~20 s before the moment
 * and ends at the end of a sentence ~25 s after it, 15 to 90 seconds long, inside the recording, never overlapping.
 */
export function pickClips(cands: { ms: number; reason: string }[], lines: Line[], durationMs: number, o: { min?: number; max?: number } = {}): Clip[] {
  const max = o.max ?? 6;
  const sorted = [...lines].sort((a, b) => a.start_ms - b.start_ms);
  const out: Clip[] = [];
  for (const c of cands) {
    if (out.length >= max) break;
    if (c.ms < 0 || c.ms > durationMs) continue;
    const want0 = c.ms - 20_000, want1 = c.ms + 25_000;
    const startLine = [...sorted].reverse().find((l) => l.start_ms <= Math.max(0, want0)) ?? sorted.find((l) => l.start_ms >= want0) ?? null;
    let start = startLine ? startLine.start_ms : Math.max(0, want0);
    const endLine = sorted.find((l) => l.end_ms >= want1 && l.start_ms >= start) ?? null;
    let end = endLine ? endLine.end_ms : Math.min(durationMs, want1);
    if (end - start > 90_000) {
      const capped = [...sorted].reverse().find((l) => l.end_ms <= start + 90_000 && l.end_ms > start + 15_000);
      end = capped ? capped.end_ms : start + 90_000;
    }
    start = Math.max(0, start); end = Math.min(durationMs, end);
    if (end - start < 15_000) end = Math.min(durationMs, start + 15_000);
    if (end - start < 15_000) start = Math.max(0, end - 15_000);
    if (end - start < 5_000) continue;
    if (out.some((x) => start < x.end_ms && x.start_ms < end)) continue;
    const said = linesBetween(sorted, start, end).filter((l) => l.start_ms >= start - 1 && l.end_ms <= end + 1);
    const caption = said.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
    // The title: the longest sentence that reads whole (up to 11 words), else the longest one, shortened.
    const whole = said.filter((l) => l.text.split(/\s+/).length <= 11 && l.text.split(/\s+/).length >= 4);
    const best = (whole.length ? whole : said).reduce<Line | null>((a, l) => (!a || l.text.length > a.text.length ? l : a), null);
    const title = clipTitle(best?.text ?? c.reason);
    out.push({ start_ms: Math.round(start), end_ms: Math.round(end), title: title.slice(0, 90) || 'Highlight', caption: caption.slice(0, 600), reason: c.reason.slice(0, 200) });
  }
  return out.sort((a, b) => a.start_ms - b.start_ms);
}
const TRAIL = new Set(['and', 'or', 'but', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'that', 'this', 'if', 'you', 'your', 'at', 'by', 'from', 'it']);
/** A clip title from a sentence: the whole sentence when short, else its first words up to a natural stop. */
export function clipTitle(text: string) {
  const t = text.replace(/\s+/g, ' ').trim().replace(/[.?!]+$/, '');
  const words = t.split(' ');
  if (words.length <= 11) return t;
  const comma = words.slice(0, 11).findIndex((w, i) => i >= 4 && /,$/.test(w));
  let cut = comma >= 0 ? words.slice(0, comma + 1) : words.slice(0, 9);
  while (cut.length > 3 && TRAIL.has(cut[cut.length - 1].toLowerCase().replace(/[,;:]$/, ''))) cut = cut.slice(0, -1);
  return cut.join(' ').replace(/[,;:]+$/, '');
}
/** Caption cues for one clip, on the clip's own clock (burned into the export). */
export const clipCues = (lines: Line[], clip: Pick<Clip, 'start_ms' | 'end_ms'>) =>
  linesBetween(lines, clip.start_ms, clip.end_ms).map((l) => ({ from: Math.max(0, l.start_ms - clip.start_ms), to: Math.min(clip.end_ms, l.end_ms) - clip.start_ms, text: l.text }));

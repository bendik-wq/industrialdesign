/**
 * G&L Studio: the edit plan. Pure functions only (no I/O), unit-tested in test/studio-plan.test.ts.
 *
 * A plan says which parts of the source to keep. The brain (Claude, else Workers AI) proposes it from the transcript,
 * silences and the recorder's markers; this file never trusts that proposal: every number is clamped inside the
 * source, ranges are sorted and merged, tiny pieces dropped, retakes are always removed, and a plan that keeps too
 * little is thrown away for the rules plan (silences, filler words and retakes only).
 */

export type MarkerKind = 'chapter' | 'retake' | 'highlight';
export interface Marker { t: number; kind: MarkerKind; label?: string }
export interface Word { w: string; s: number; e: number }
export interface Segment { s: number; e: number; text: string }
export interface Transcript { words: Word[]; segments: Segment[]; language?: string | null }
export interface Silence { start: number; end: number }
export interface Range { in: number; out: number }
export interface Removal extends Range { reason: RemovalReason }
export type RemovalReason = 'silence' | 'filler' | 'false start' | 'retake' | 'repeat' | 'off topic' | 'other';
export interface Chapter { t: number; title: string }
export interface Clip extends Range { title: string }
export type CaptionStyle = 'clean' | 'none';

export interface EditPlan {
  title: string;
  description: string;
  keep: Range[];
  removed: Removal[];
  chapters: Chapter[];
  captions: { style: CaptionStyle };
  clips: Clip[];
  /** Source duration the plan was made for, and the edited length it produces. */
  duration: number;
  keptS: number;
  summary: string;
}

export interface PlanInput {
  title: string;
  duration: number;
  transcript: Transcript;
  silences: Silence[];
  markers: Marker[];
  layout?: string | null;
  notes?: string | null;
}

export const MIN_SEGMENT_S = 0.3;
export const SILENCE_MIN_S = 0.6;
/** Silence kept at each side of a cut, so words are not clipped. */
export const SILENCE_PAD_S = 0.15;
export const MIN_KEEP_RATIO = 0.5;
export const RETAKE_LOOKBACK_S = 60;
export const CLIP_MIN_S = 30;
export const CLIP_MAX_S = 60;
export const MAX_CLIPS = 3;

const FILLER_RE = /^(u+m+|u+h+m*|e+r+m+|e+r+|a+h+|h+m+|m+h*m+)$/i;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

// ───────────── ranges ─────────────

/** Sorted, clamped inside [0, duration], overlaps merged, empty ones dropped. */
export function normalise(ranges: Range[], duration: number): Range[] {
  const out: Range[] = [];
  const sorted = ranges
    .map((r) => ({ in: clamp(r.in, 0, duration), out: clamp(r.out, 0, duration) }))
    .filter((r) => Number.isFinite(r.in) && Number.isFinite(r.out) && r.out > r.in)
    .sort((a, b) => a.in - b.in);
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.in <= last.out + 1e-6) last.out = Math.max(last.out, r.out);
    else out.push({ ...r });
  }
  return out.map((r) => ({ in: r3(r.in), out: r3(r.out) }));
}

/** `keep` minus `remove`. */
export function subtract(keep: Range[], remove: Range[]): Range[] {
  let cur = keep.map((r) => ({ ...r }));
  for (const x of remove) {
    const next: Range[] = [];
    for (const r of cur) {
      if (x.out <= r.in || x.in >= r.out) { next.push(r); continue; }
      if (x.in > r.in) next.push({ in: r.in, out: x.in });
      if (x.out < r.out) next.push({ in: x.out, out: r.out });
    }
    cur = next;
  }
  return cur;
}

export const total = (ranges: Range[]) => ranges.reduce((s, r) => s + (r.out - r.in), 0);

/** Keep ranges after removals, with pieces shorter than MIN_SEGMENT_S dropped. */
export function keepFrom(duration: number, removals: Range[]): Range[] {
  return normalise(subtract([{ in: 0, out: duration }], normalise(removals, duration)), duration).filter((r) => r.out - r.in >= MIN_SEGMENT_S);
}

/** Where a source time lands in the edited video, or null when it was cut. */
export function toOutput(t: number, keep: Range[]): number | null {
  let acc = 0;
  for (const r of keep) {
    if (t < r.in) return null;
    if (t <= r.out) return acc + (t - r.in);
    acc += r.out - r.in;
  }
  return null;
}
/** Like toOutput, but a cut time moves to the start of the next kept piece (for chapters). */
export function toOutputNearest(t: number, keep: Range[]): number {
  let acc = 0;
  for (const r of keep) {
    if (t <= r.out) return acc + Math.max(0, t - r.in);
    acc += r.out - r.in;
  }
  return acc;
}

// ───────────── what is always cut ─────────────

export function silenceCuts(silences: Silence[], minS = SILENCE_MIN_S, pad = SILENCE_PAD_S): Removal[] {
  return silences
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start >= minS)
    .map((s) => ({ in: r3(s.start + pad), out: r3(s.end - pad), reason: 'silence' as const }))
    .filter((r) => r.out - r.in >= MIN_SEGMENT_S - 0.1);
}

export const isFiller = (w: string) => FILLER_RE.test(w.replace(/[^\p{L}]/gu, ''));
export function fillerCuts(words: Word[]): Removal[] {
  return words.filter((w) => isFiller(w.w) && w.e > w.s).map((w) => ({ in: r3(w.s), out: r3(w.e), reason: 'filler' as const }));
}

/** Where the sentence that was going on at `t` began (a word after . ? ! or after a pause of 0.6 s or more). */
export function sentenceStart(words: Word[], t: number, lookback = RETAKE_LOOKBACK_S): number {
  const before = words.filter((w) => w.s < t);
  if (!before.length) return Math.max(0, t - Math.min(lookback, 10));
  for (let i = before.length - 1; i >= 0; i--) {
    const w = before[i];
    const prev = before[i - 1];
    if (t - w.s > lookback) return Math.max(0, t - lookback);
    if (!prev || /[.?!]["')\]]?$/.test(prev.w.trim()) || w.s - prev.e >= SILENCE_MIN_S) return w.s;
  }
  return before[0].s;
}

/** Each retake marker removes everything from the start of the sentence it interrupted up to the marker. */
export function retakeCuts(markers: Marker[], words: Word[], duration: number): Removal[] {
  return markers
    .filter((m) => m.kind === 'retake' && Number.isFinite(m.t) && m.t > 0 && m.t <= duration + 1)
    .map((m) => ({ in: r3(sentenceStart(words, m.t)), out: r3(Math.min(duration, m.t)), reason: 'retake' as const }))
    .filter((r) => r.out > r.in);
}

// ───────────── summary sentence ─────────────

export function fmtDuration(s: number) {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  if (h) return `${h} h ${m} m`;
  if (m) return `${m} m ${x} s`;
  return `${x} s`;
}

export function summarise(removed: Removal[]): string {
  const silence = total(normalise(removed.filter((r) => r.reason === 'silence'), Infinity));
  const n = (k: RemovalReason) => removed.filter((r) => r.reason === k).length;
  const parts: string[] = [];
  if (silence >= 1) parts.push(`${fmtDuration(silence)} of silence`);
  const fill = n('filler');
  if (fill) parts.push(`${fill} filler word${fill === 1 ? '' : 's'}`);
  const fs = n('false start');
  if (fs) parts.push(`${fs} false start${fs === 1 ? '' : 's'}`);
  const rt = n('retake');
  if (rt) parts.push(`${rt} retake${rt === 1 ? '' : 's'}`);
  const other = n('repeat') + n('off topic') + n('other');
  if (other) parts.push(`${other} other cut${other === 1 ? '' : 's'}`);
  if (!parts.length) return 'Nothing needed cutting';
  const last = parts.pop()!;
  return `Cut ${parts.length ? `${parts.join(', ')} and ${last}` : last}`;
}

// ───────────── rules plan and the brain's plan ─────────────

const cleanLine = (s: unknown, max: number) => String(s ?? '').replace(/\s*[—–]\s*/g, ', ').replace(/!/g, '.').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);

function forced(input: PlanInput): { silence: Removal[]; filler: Removal[]; retake: Removal[] } {
  return {
    silence: silenceCuts(input.silences),
    filler: fillerCuts(input.transcript.words),
    retake: retakeCuts(input.markers, input.transcript.words, input.duration),
  };
}

function markerChapters(input: PlanInput): Chapter[] {
  const ch = input.markers.filter((m) => m.kind === 'chapter' && m.t >= 0 && m.t < input.duration).map((m, i) => ({ t: m.t, title: cleanLine(m.label || `Part ${i + 2}`, 60) }));
  return ch.length && ch[0].t > 1 ? [{ t: 0, title: 'Intro' }, ...ch] : ch;
}

/** Clips: highlight markers first (centred on the marker), then the brain's picks; each 30 to 60 s, all inside kept content. */
export function fitClips(input: PlanInput, keep: Range[], proposed: Clip[]): Clip[] {
  const out: Clip[] = [];
  const keptS = total(keep);
  if (keptS < CLIP_MIN_S / 2) return [];
  const fit = (a: number, b: number, title: string) => {
    const D = input.duration;
    const len = Math.min(D, clamp(b - a, CLIP_MIN_S, CLIP_MAX_S));
    let s = clamp(a, 0, D);
    // Start on kept content.
    const first = keep.find((r) => r.out > s);
    if (first && s < first.in) s = first.in;
    let e = Math.min(D, s + len);
    if (e - s < Math.min(CLIP_MIN_S, D)) { s = Math.max(0, e - Math.min(CLIP_MIN_S, D)); e = Math.min(D, s + Math.min(CLIP_MIN_S, D)); }
    const c = { in: r3(s), out: r3(e), title: cleanLine(title, 80) || 'Clip' };
    if (c.out - c.in < Math.min(CLIP_MIN_S, D) - 0.01) return;
    if (out.some((o) => c.in < o.out && c.out > o.in)) return;
    out.push(c);
  };
  for (const m of input.markers.filter((x) => x.kind === 'highlight')) {
    if (out.length >= MAX_CLIPS) break;
    fit(m.t - 15, m.t + 30, m.label || 'Highlight');
  }
  for (const c of proposed) {
    if (out.length >= MAX_CLIPS) break;
    const a = num(c.in), b = num(c.out);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    fit(a, b, c.title);
  }
  return out;
}

function firstSentence(t: Transcript) {
  const text = t.segments.map((s) => s.text).join(' ').trim();
  const m = /^(.{12,140}?[.?!])(\s|$)/.exec(text);
  return m ? m[1] : text.slice(0, 120);
}

/** The plan with no brain: silences, filler words and retakes cut, chapters from the markers. */
export function rulesPlan(input: PlanInput): EditPlan {
  const f = forced(input);
  const removed = [...f.silence, ...f.filler, ...f.retake];
  const keep = keepFrom(input.duration, removed);
  return finish(input, {
    title: cleanLine(input.title, 90) || 'Untitled recording',
    description: cleanLine(firstSentence(input.transcript), 200),
    keep,
    removed,
    chapters: markerChapters(input),
    captions: { style: 'clean' },
    clips: fitClips(input, keep, []),
  });
}

function finish(input: PlanInput, p: Omit<EditPlan, 'duration' | 'keptS' | 'summary'>): EditPlan {
  const keptS = r3(total(p.keep));
  return { ...p, duration: r3(input.duration), keptS, summary: summarise(p.removed) };
}

const REASONS: RemovalReason[] = ['silence', 'filler', 'false start', 'retake', 'repeat', 'off topic', 'other'];
const asReason = (v: unknown): RemovalReason => {
  const s = String(v ?? '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  return (REASONS.find((r) => s === r || s.startsWith(r)) ?? (/false/.test(s) ? 'false start' : /fill/.test(s) ? 'filler' : /silen|pause/.test(s) ? 'silence' : /retake/.test(s) ? 'retake' : 'other'));
};
const asRanges = (v: unknown): Range[] => (Array.isArray(v) ? v : [])
  .map((x) => (x && typeof x === 'object' ? { in: num((x as Record<string, unknown>).in ?? (x as Record<string, unknown>).start), out: num((x as Record<string, unknown>).out ?? (x as Record<string, unknown>).end) } : { in: NaN, out: NaN }))
  .filter((r) => Number.isFinite(r.in) && Number.isFinite(r.out));

export interface Validated { plan: EditPlan; issues: string[]; usedRules: boolean }

/**
 * The brain's reply, made safe. Keep ranges are clamped, sorted, merged and stripped of pieces under 0.3 s; the
 * always-cut parts (silences, filler words, retakes) are taken out of them; the brain's own removals are applied.
 * If what is left keeps under half of the recording (not counting retakes and silences) the rules plan is used,
 * with the brain's title, description, chapters and clips when those are usable.
 */
export function validatePlan(raw: unknown, input: PlanInput): Validated {
  const issues: string[] = [];
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const D = input.duration;
  const f = forced(input);
  const forcedAll = [...f.silence, ...f.filler, ...f.retake];

  const proposedKeep = asRanges(r.keep);
  const outside = proposedKeep.filter((x) => x.in < -0.01 || x.out > D + 0.01).length;
  if (outside) issues.push(`${outside} keep range${outside === 1 ? '' : 's'} outside the recording were clamped`);
  const brainRemoved: Removal[] = (Array.isArray(r.removed) ? r.removed : Array.isArray(r.remove) ? r.remove : [])
    .map((x) => (x && typeof x === 'object' ? x as Record<string, unknown> : {}))
    .map((x) => ({ in: num(x.in ?? x.start), out: num(x.out ?? x.end), reason: asReason(x.reason) }))
    .filter((x) => Number.isFinite(x.in) && Number.isFinite(x.out) && x.out > x.in)
    .map((x) => ({ in: r3(clamp(x.in, 0, D)), out: r3(clamp(x.out, 0, D)), reason: x.reason }))
    .filter((x) => x.out > x.in);

  let base = proposedKeep.length ? normalise(proposedKeep, D) : [{ in: 0, out: D }];
  if (!proposedKeep.length) issues.push('no keep ranges: started from the whole recording');
  // Pieces the brain dropped without saying why count as "other" removals.
  const implicit = subtract([{ in: 0, out: D }], base).filter((x) => x.out - x.in >= MIN_SEGMENT_S)
    .filter((x) => !brainRemoved.some((b) => b.in <= x.in + 0.05 && b.out >= x.out - 0.05))
    .map((x) => ({ in: r3(x.in), out: r3(x.out), reason: 'other' as const }));
  base = subtract(base, [...forcedAll, ...brainRemoved]);
  const keep = normalise(base, D).filter((x) => x.out - x.in >= MIN_SEGMENT_S);
  const removedAll = [...forcedAll, ...brainRemoved.filter((b) => b.reason !== 'silence' || b.out - b.in >= SILENCE_MIN_S - 2 * SILENCE_PAD_S), ...implicit];

  // Floor: at least half of what is left after retakes and real silences.
  const excused = total(normalise([...f.retake, ...f.silence], D));
  const floor = MIN_KEEP_RATIO * Math.max(0, D - excused);
  const keptS = total(keep);
  const meta = {
    title: cleanLine(r.title, 90),
    description: String(r.description ?? '').split(/\r?\n/).map((l) => cleanLine(l, 200)).filter(Boolean).slice(0, 2).join('\n'),
    chapters: (Array.isArray(r.chapters) ? r.chapters : [])
      .map((c) => (c && typeof c === 'object' ? c as Record<string, unknown> : {}))
      .map((c) => ({ t: r3(clamp(num(c.t ?? c.at ?? c.start), 0, D)), title: cleanLine(c.title, 60) }))
      .filter((c) => Number.isFinite(c.t) && c.title)
      .sort((a, b) => a.t - b.t)
      .filter((c, i, a) => i === 0 || c.t - a[i - 1].t >= 10)
      .slice(0, 20),
    captions: { style: (String((r.captions as Record<string, unknown> | undefined)?.style ?? r.caption_style ?? 'clean') === 'none' ? 'none' : 'clean') as CaptionStyle },
    clips: (Array.isArray(r.clips) ? r.clips : []).map((c) => (c && typeof c === 'object' ? c as Record<string, unknown> : {})).map((c) => ({ in: num(c.in ?? c.start), out: num(c.out ?? c.end), title: String(c.title ?? '') })),
  };
  const fallback = rulesPlan(input);
  const chapters = meta.chapters.length ? meta.chapters : fallback.chapters;
  if (!keep.length || keptS + 1e-6 < floor) {
    issues.push(keep.length ? `the plan kept ${fmtDuration(keptS)} of ${fmtDuration(D)}, under half: used the rules plan` : 'the plan kept nothing: used the rules plan');
    return {
      usedRules: true,
      issues,
      plan: finish(input, { ...fallback, title: meta.title || fallback.title, description: meta.description || fallback.description, chapters, captions: meta.captions, clips: fitClips(input, fallback.keep, meta.clips) }),
    };
  }
  return {
    usedRules: false,
    issues,
    plan: finish(input, {
      title: meta.title || fallback.title,
      description: meta.description || fallback.description,
      keep,
      removed: removedAll.sort((a, b) => a.in - b.in),
      chapters,
      captions: meta.captions,
      clips: fitClips(input, keep, meta.clips),
    }),
  };
}

// ───────────── the brain's prompt ─────────────

export const PLAN_SYSTEM = `You edit screen recordings with a face cam for Josh Li (G&L M&A Advisory) into production-ready videos.
You get the transcript with word times in seconds, the silences, the recorder's markers and the duration.
Reply with ONE JSON object and nothing else:
{"title": string (under 70 characters, plain, no emojis, no exclamation marks),
 "description": string (exactly 2 short lines separated by \\n, plain, no hype, no promises of results),
 "keep": [{"in": seconds, "out": seconds}] (sorted, not overlapping, inside the duration),
 "removed": [{"in": seconds, "out": seconds, "reason": "silence" | "filler" | "false start" | "retake" | "repeat" | "off topic"}],
 "chapters": [{"t": seconds in the source, "title": string under 40 characters}] (first at 0, at least 30 s apart),
 "captions": {"style": "clean" | "none"},
 "clips": [{"in": seconds, "out": seconds, "title": string}] (up to 3, each 30 to 60 s, self-contained, strongest first; highlight markers first)}
Rules: cut silences longer than 0.6 s (leave 0.15 s either side), filler words (um, uh, er), false starts (a phrase begun and then restarted:
cut the abandoned attempt, keep the clean one), and for every retake marker everything from the start of the interrupted sentence up to the marker.
Never cut inside a word. Keep everything else, in order. Keep at least half of the recording unless retakes explain more.
If the owner left notes, follow them.`;

export function planPrompt(input: PlanInput, maxChars = 120_000): { system: string; user: string } {
  const lines: string[] = [];
  // Word-level times, grouped by segment, so the brain can cut between words.
  for (const seg of input.transcript.segments) {
    const ws = input.transcript.words.filter((w) => w.s >= seg.s - 0.01 && w.s < seg.e + 0.01);
    const body = ws.length ? ws.map((w) => `${w.w.trim()}@${w.s.toFixed(2)}`).join(' ') : seg.text;
    lines.push(`[${seg.s.toFixed(2)}-${seg.e.toFixed(2)}] ${body}`);
  }
  let transcript = lines.join('\n');
  if (transcript.length > maxChars) transcript = input.transcript.segments.map((s) => `[${s.s.toFixed(1)}-${s.e.toFixed(1)}] ${s.text}`).join('\n').slice(0, maxChars);
  const user = [
    `Recording title: ${input.title || 'untitled'}`,
    `Duration: ${input.duration.toFixed(2)} s`,
    `Layout: ${input.layout || 'unknown'}`,
    `Markers: ${JSON.stringify(input.markers.map((m) => ({ t: r3(m.t), kind: m.kind, label: m.label || undefined })))}`,
    `Silences (start-end s): ${input.silences.filter((s) => s.end - s.start >= SILENCE_MIN_S).map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`).join(', ') || 'none'}`,
    input.notes ? `Owner's notes for this edit: ${cleanLine(input.notes, 1500)}` : '',
    'Transcript (word@start):',
    transcript || '(no speech found)',
  ].filter(Boolean).join('\n');
  return { system: PLAN_SYSTEM, user };
}

// ───────────── markers and transcripts from the outside world ─────────────

export function cleanMarkers(v: unknown, duration = Infinity): Marker[] {
  return (Array.isArray(v) ? v : [])
    .map((m) => (m && typeof m === 'object' ? m as Record<string, unknown> : {}))
    .map((m) => ({ t: num(m.t), kind: String(m.kind ?? '') as MarkerKind, label: m.label ? cleanLine(m.label, 80) : undefined }))
    .filter((m) => Number.isFinite(m.t) && m.t >= 0 && m.t <= duration && (m.kind === 'chapter' || m.kind === 'retake' || m.kind === 'highlight'))
    .sort((a, b) => a.t - b.t)
    .slice(0, 500)
    .map((m) => (m.label ? m : { t: m.t, kind: m.kind }));
}

/** Whisper's reply for one chunk (turbo: segments with words), offset by the chunk start. */
export function whisperChunk(r: unknown, offset: number): Transcript {
  const x = (r ?? {}) as { text?: string; segments?: { start?: number; end?: number; text?: string; words?: { word?: string; start?: number; end?: number }[] }[]; words?: { word?: string; start?: number; end?: number }[] };
  const words: Word[] = [];
  const segments: Segment[] = [];
  const clean = (s: string) => s.replace(/\([^)]{1,30}\)|\[[^\]]{1,30}\]/g, '').replace(/\s+/g, ' ').trim();
  const pushWord = (w: { word?: string; start?: number; end?: number }) => {
    const text = clean(String(w.word ?? ''));
    if (!text || typeof w.start !== 'number') return;
    words.push({ w: text, s: r3(offset + w.start), e: r3(offset + (typeof w.end === 'number' ? Math.max(w.end, w.start) : w.start)) });
  };
  if (Array.isArray(x.segments) && x.segments.length) {
    for (const s of x.segments) {
      const text = clean(String(s.text ?? ''));
      if (!text || typeof s.start !== 'number') continue;
      segments.push({ s: r3(offset + s.start), e: r3(offset + (typeof s.end === 'number' ? s.end : s.start)), text });
      for (const w of s.words ?? []) pushWord(w);
    }
  } else if (Array.isArray(x.words)) {
    for (const w of x.words) pushWord(w);
    if (words.length) segments.push({ s: words[0].s, e: words[words.length - 1].e, text: words.map((w) => w.w).join(' ') });
  } else if (x.text && clean(x.text)) {
    segments.push({ s: r3(offset), e: r3(offset), text: clean(x.text) });
  }
  return { words, segments };
}

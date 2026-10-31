// Webinar and challenge materials: scripts written in one Markdown format (docs/materials-format.md),
// stored in public/materials/<id>.md and served only to admins. Funnel HQ → Materials parses them into
// a reading view, a presenter deck, a presenter window and a run sheet.

/** Every material Funnel HQ lists, in order. Ids that have no file yet are skipped, so a script appears once its file lands. */
export const MATERIAL_IDS = [
  'live-webinar',
  'challenge-day-1',
  'challenge-day-2',
  'challenge-day-3',
  'challenge-day-4',
  'challenge-day-5',
  'auto-webinar-ai',
  'auto-webinar-recorded',
] as const;

export const WPM = 140;
export const isMaterialId = (id: string) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(id);

export interface MaterialMeta {
  title: string;
  funnel: string;
  day: number | null;
  duration_min: number | null;
  offer: string;
  [key: string]: string | number | null;
}

export type Block =
  | { type: 'para'; text: string; words: number; at: string }
  | { type: 'slide'; slide: number; title: string; sub: string; at: string }
  | { type: 'onscreen'; text: string }
  | { type: 'host'; action: string; at: string }
  | { type: 'note'; text: string }
  | { type: 'mark'; at: string }
  | { type: 'heading'; text: string }
  | { type: 'cue'; text: string };

export interface Chapter { index: number; title: string; at: string; planned: boolean; words: number; minutes: number; blocks: Block[] }
export interface Slide { index: number; chapter: number; chapterTitle: string; title: string; sub: string; onscreen: string[]; notes: string[]; at: string; sec: number; implicit?: boolean }
export interface Cue { at: string; sec: number; action: string; slide: number; chapter: number }
export interface Material { meta: MaterialMeta; preface: string; chapters: Chapter[]; slides: Slide[]; cues: Cue[]; words: number; minutes: number; end: string }

/** mm:ss (minutes may run past 59) or h:mm:ss → seconds. */
export function toSec(t: string): number | null {
  const p = t.trim().split(':').map((x) => Number(x));
  if (p.length < 2 || p.length > 3 || p.some((x) => !Number.isFinite(x) || x < 0)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}
export const mmss = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
export const countWords = (s: string) => s.split(/\s+/).filter((w) => /[A-Za-z0-9$]/.test(w)).length;

function frontmatter(md: string): { meta: MaterialMeta; body: string } {
  const meta: MaterialMeta = { title: '', funnel: '', day: null, duration_min: null, offer: 'none' };
  const m = md.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta, body: md };
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1], val = kv[2].trim().replace(/^["']|["']$/g, '');
    if (key === 'day' || key === 'duration_min') meta[key] = val === '' || !Number.isFinite(Number(val)) ? null : Number(val);
    else meta[key] = val;
  }
  return { meta, body: md.slice(m[0].length) };
}

/** Parse one material. Lines starting with "[" are cues (never spoken); plain paragraphs are spoken. */
export function parseMaterial(md: string): Material {
  const { meta, body } = frontmatter(md);
  const chapters: Chapter[] = [];
  const slides: Slide[] = [];
  const cues: Cue[] = [];
  const preface: string[] = [];
  let clock = 0;
  let para: string[] = [];
  let ch: Chapter | null = null;

  const curSlide = (): Slide => {
    // Spoken words before a chapter's first [SLIDE] stay on the previous slide; at the very start, the chapter title stands in.
    const last = slides[slides.length - 1];
    if (last) return last;
    const s: Slide = { index: 0, chapter: ch?.index ?? 0, chapterTitle: ch?.title ?? '', title: ch?.title ?? meta.title, sub: '', onscreen: [], notes: [], at: mmss(clock), sec: clock, implicit: true };
    slides.push(s);
    return s;
  };
  const flush = () => {
    if (!para.length) return;
    const text = para.join(' ').replace(/\s+/g, ' ').trim();
    para = [];
    if (!text) return;
    if (!ch) { preface.push(text); return; }
    const w = countWords(text);
    ch.blocks.push({ type: 'para', text, words: w, at: mmss(clock) });
    curSlide().notes.push(text);
    ch.words += w;
    clock += (w / WPM) * 60;
  };

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const head = line.match(/^##\s+(?:\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*)?(.+)$/);
    if (head && !line.startsWith('###')) {
      flush();
      const t = head[1] ? toSec(head[1]) : null;
      if (t != null) clock = t;
      ch = { index: chapters.length, title: head[2].trim(), at: mmss(clock), planned: t != null, words: 0, minutes: 0, blocks: [] };
      chapters.push(ch);
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      if (ch) ch.blocks.push({ type: 'heading', text: line.replace(/^#+\s*/, '') });
      else if (!/^#\s/.test(line)) preface.push(line.replace(/^#+\s*/, ''));
      continue;
    }
    if (line === '---' || line === '***') { flush(); continue; }
    if (line.startsWith('[')) {
      flush();
      if (!ch) { preface.push(line); continue; }
      const mark = line.match(/^\[(\d{1,3}:\d{2}(?::\d{2})?)\]$/);
      if (mark) { const t = toSec(mark[1]); if (t != null) clock = t; ch.blocks.push({ type: 'mark', at: mmss(clock) }); continue; }
      const cue = line.match(/^\[([A-Z][A-Z -]*?)(?:,[^:\]]*)?:\s*([\s\S]*)\]$/);
      const kind = cue?.[1].trim();
      const val = (cue?.[2] ?? '').trim();
      if (kind === 'SLIDE') {
        const [title, ...rest] = val.split(' | ');
        const s: Slide = { index: slides.length, chapter: ch.index, chapterTitle: ch.title, title: title.trim(), sub: rest.join(' | ').trim(), onscreen: [], notes: [], at: mmss(clock), sec: clock };
        // A chapter that opened with words and no slide yet keeps them on the slide before; the implicit opener is replaced if nothing was said on it.
        const last = slides[slides.length - 1];
        if (last?.implicit && !last.notes.length && slides.length === 1) { s.index = 0; slides[0] = s; } else slides.push(s);
        ch.blocks.push({ type: 'slide', slide: s.index, title: s.title, sub: s.sub, at: s.at });
      } else if (kind === 'ON SCREEN') {
        curSlide().onscreen.push(val);
        ch.blocks.push({ type: 'onscreen', text: val });
      } else if (kind === 'HOST') {
        const at = mmss(clock);
        cues.push({ at, sec: clock, action: val, slide: curSlide().index, chapter: ch.index });
        ch.blocks.push({ type: 'host', action: val, at });
      } else if (kind === 'NOTE') {
        ch.blocks.push({ type: 'note', text: val });
      } else {
        ch.blocks.push({ type: 'cue', text: line.slice(1, -1) });
      }
      continue;
    }
    para.push(line);
  }
  flush();

  for (const c of chapters) c.minutes = Math.round((c.words / WPM) * 10) / 10;
  const words = chapters.reduce((a, c) => a + c.words, 0);
  return { meta, preface: preface.join('\n'), chapters, slides, cues, words, minutes: Math.round((words / WPM) * 10) / 10, end: mmss(clock) };
}

/** The list row Funnel HQ shows for one material. */
export function summarize(id: string, m: Material) {
  return {
    id,
    title: m.meta.title || id,
    funnel: m.meta.funnel,
    day: m.meta.day,
    duration_min: m.meta.duration_min,
    offer: m.meta.offer,
    words: m.words,
    minutes: m.minutes,
    end: m.end,
    chapters: m.chapters.length,
    slides: m.slides.length,
    cues: m.cues.length,
  };
}

import type {Word} from './types';

export type WordGroup = {
  words: Word[];
  start: number;
  /** time the group leaves the screen (next group's start, or a short hold after the last word) */
  hide: number;
};

const MAX_WORDS = 4;
const MIN_WORDS = 2;
const PAUSE_BREAK = 0.32; // a pause this long starts a new group
const HOLD = 0.45; // how long a group lingers after its last word if nothing follows
const MAX_CHARS = 20;

/** Splits word timings into 2 to 4 word caption groups using pauses, punctuation and length. */
export const groupWords = (words: Word[]): WordGroup[] => {
  const sorted = [...words].filter((w) => w.text.trim()).sort((a, b) => a.start - b.start);
  const groups: Word[][] = [];
  let cur: Word[] = [];
  const chars = (ws: Word[]) => ws.reduce((n, w) => n + w.text.length + 1, 0);

  sorted.forEach((w, i) => {
    const prev = sorted[i - 1];
    if (cur.length > 0) {
      const pause = prev ? w.start - prev.end : 0;
      const punct = prev ? /[.!?,;:]$/.test(prev.text) : false;
      const full = cur.length >= MAX_WORDS || chars(cur) + w.text.length > MAX_CHARS;
      const softBreak = cur.length >= MIN_WORDS && (pause > PAUSE_BREAK || punct);
      if (full || softBreak || pause > 0.9) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  });
  if (cur.length) groups.push(cur);

  // merge a trailing single word into the previous group when it fits
  for (let i = groups.length - 1; i > 0; i--) {
    const g = groups[i];
    const p = groups[i - 1];
    if (g.length === 1 && p.length < MAX_WORDS && g[0].start - p[p.length - 1].end < PAUSE_BREAK && chars(p) + g[0].text.length <= MAX_CHARS + 4) {
      groups[i - 1] = [...p, ...g];
      groups.splice(i, 1);
    }
  }

  return groups.map((ws, i) => {
    const next = groups[i + 1];
    const last = ws[ws.length - 1].end;
    const hide = next && next[0].start - last < 0.9 ? next[0].start : last + HOLD;
    return {words: ws, start: ws[0].start, hide};
  });
};

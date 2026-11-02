import type { Settings } from '../settings';
import { CHAPTER_RECAP, BUILDER_STEPS, BUYIN_AT, TAKEAWAYS, type Takeaway } from './experience';
import { DEFAULT_CHAPTERS, DEFAULT_POLLS, type Chapter, type Poll } from './content';
import { AI_TIMELINE } from './edition-ai';
import { parseRoomEdition } from '../rooms/intel';

/**
 * Which recording the room plays, and the timeline that goes with it.
 *
 *  - recorded: Josh's own recording of script v3 (66 minutes, the Sprint unlocks at 38:00). The default.
 *  - ai: the AI edition, narrated by an AI voice presenting Josh's method (disclosed at the start and on
 *    every slide), pitching the First Deal Sprint from the first minute. Its timeline is generated from the
 *    rendered audio by the build (edition-ai.ts), so every cue lands on the words it belongs to.
 *
 * Settings still win: WEBINAR_DURATION_MIN, WEBINAR_PITCH_AT, WEBINAR_BONUS_AT, WEBINAR_CHAPTERS and
 * WEBINAR_VIDEO_SRC override the edition when they are set.
 */

export type EditionName = 'recorded' | 'ai' | 'room';

export interface EditionTimeline {
  durationMin: number;
  pitchAtMin: number;
  bonusAtMin: number;
  /** Second of the buy-in card. */
  buyinAt: number;
  /** Second the calculator appears. */
  calcAt: number;
  chapters: Chapter[];
  /** Chapter recap lines keyed by the chapter's start minute (as a string). */
  recaps: Record<string, string>;
  /** Minute each poll appears, by poll id. */
  polls: Record<string, number>;
  /** Second each deal-builder step unlocks, by step id. */
  steps: Record<string, number>;
  takeaways: Takeaway[];
  /** 'voiced' once rendered with the real voice; 'dry' while the audio is a silent placeholder. */
  mode: string;
  seconds: number;
}

export interface Edition {
  name: EditionName;
  durationMin: number;
  pitchAtMin: number;
  bonusAtMin: number;
  buyinAt: number;
  calcAt: number | null;
  chapters: Chapter[];
  recap: (chapterAt: number) => string;
  polls: Poll[];
  steps: typeof BUILDER_STEPS;
  takeaways: Takeaway[];
  /** The recording the room plays when WEBINAR_VIDEO_SRC is blank (null = the existing fallback). */
  videoSrc: string | null;
  ready: boolean;
}

export const AI_VIDEO_SRC = '/assets/media/webinar/ai/index.m3u8';

export const editionName = (s: Partial<Settings>): EditionName => {
  const v = String(s.WEBINAR_EDITION ?? '').trim().toLowerCase();
  // room: a recorded live session from our own room (rooms intel, area D); only while its edition is stored.
  if (v === 'room') return parseRoomEdition(s.WEBINAR_ROOM_EDITION) ? 'room' : 'recorded';
  return v === 'ai' ? 'ai' : 'recorded';
};

const recorded = (): Edition => ({
  name: 'recorded',
  durationMin: 66, pitchAtMin: 38, bonusAtMin: 63, buyinAt: BUYIN_AT, calcAt: null,
  chapters: DEFAULT_CHAPTERS,
  recap: (at) => CHAPTER_RECAP[at] ?? '',
  polls: DEFAULT_POLLS,
  steps: BUILDER_STEPS,
  takeaways: TAKEAWAYS,
  videoSrc: null,
  ready: true,
});

function fromTimeline(t: EditionTimeline): Edition {
  return {
    name: 'ai',
    durationMin: t.durationMin, pitchAtMin: t.pitchAtMin, bonusAtMin: t.bonusAtMin, buyinAt: t.buyinAt, calcAt: t.calcAt,
    chapters: t.chapters,
    recap: (at) => t.recaps[String(at)] ?? '',
    polls: DEFAULT_POLLS.filter((p) => t.polls[p.id] != null).map((p) => ({ ...p, at: t.polls[p.id] })),
    steps: BUILDER_STEPS.map((s) => ({ ...s, at: t.steps[s.id] ?? s.at })),
    takeaways: t.takeaways,
    videoSrc: AI_VIDEO_SRC,
    ready: t.mode === 'voiced',
  };
}

// Built on first use: this module sits in an import cycle with webinar.ts and experience.ts.
let cache: { recorded: Edition; ai: Edition } | null = null;
const built = () => (cache ??= { recorded: recorded(), ai: fromTimeline(AI_TIMELINE) });

/**
 * The room edition (simulive): a recorded live session plays in sync for everyone in a showing. Its chapters and
 * the minute of its first offer come from the live session; it has no timed polls, calculator or key points (the
 * live session's own polls were answered by other people at another time, so they are not replayed as new).
 */
let roomCache: { raw: string; e: Edition } | null = null;
function roomEdition(raw: string): Edition | null {
  if (roomCache?.raw === raw) return roomCache.e;
  const r = parseRoomEdition(raw);
  if (!r) return null;
  const e: Edition = {
    name: 'room', durationMin: r.durationMin, pitchAtMin: r.pitchAtMin, bonusAtMin: r.durationMin, buyinAt: r.pitchAtMin * 60, calcAt: null,
    chapters: r.chapters.length ? r.chapters : [{ at: 0, title: r.title }],
    recap: () => '', polls: [], steps: [], takeaways: [], videoSrc: r.src, ready: true,
  };
  roomCache = { raw, e };
  return e;
}

export const edition = (s: Partial<Settings>): Edition => {
  const name = editionName(s);
  return name === 'room' ? roomEdition(String(s.WEBINAR_ROOM_EDITION ?? '')) ?? built().recorded : built()[name];
};

/** Every key point either edition can show (notes saved under one edition still resolve). */
export const allTakeaways = (): Takeaway[] => [...TAKEAWAYS, ...AI_TIMELINE.takeaways.filter((t) => !TAKEAWAYS.some((x) => x.id === t.id))];

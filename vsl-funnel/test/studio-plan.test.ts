import { describe, expect, it } from 'vitest';
import { auditCopy } from '../src/content/copy-rules';
import {
  type PlanInput, type Word, MIN_SEGMENT_S, cleanMarkers, fillerCuts, fitClips, keepFrom, normalise, planPrompt, retakeCuts, rulesPlan,
  sentenceStart, silenceCuts, subtract, summarise, toOutput, total, validatePlan, whisperChunk,
} from '../src/studio/plan';

// G&L Studio: the edit plan is proposed by a brain and never trusted. These pin the clamping, the always-cut parts
// (silences, filler words, retakes), the 50% floor, the clips and the summary sentence shown on the timeline.

/** "word" at 1 s intervals, sentences of 5 words, with a filler at 12 s. */
function words(n = 40): Word[] {
  return Array.from({ length: n }, (_, i) => ({ w: i === 12 ? 'um' : i % 5 === 4 ? 'end.' : 'word', s: i + 0.1, e: i + 0.8 }));
}
const input = (o: Partial<PlanInput> = {}): PlanInput => ({
  title: 'Seller finance in plain words', duration: 60,
  transcript: { words: words(), segments: [{ s: 0.1, e: 39.8, text: 'Seller finance is a loan from the owner. It is paid from the business.' }] },
  silences: [{ start: 40, end: 50 }, { start: 52, end: 52.4 }], markers: [], ...o,
});

describe('ranges', () => {
  it('normalise sorts, clamps inside the recording, merges overlaps and drops empty ranges', () => {
    expect(normalise([{ in: 50, out: 70 }, { in: -5, out: 3 }, { in: 2, out: 4 }, { in: 10, out: 10 }, { in: NaN, out: 3 }], 60))
      .toEqual([{ in: 0, out: 4 }, { in: 50, out: 60 }]);
  });
  it('subtract and keepFrom', () => {
    expect(subtract([{ in: 0, out: 10 }], [{ in: 2, out: 3 }, { in: 9, out: 12 }])).toEqual([{ in: 0, out: 2 }, { in: 3, out: 9 }]);
    // Pieces under 0.3 s left between cuts are dropped.
    expect(keepFrom(10, [{ in: 2, out: 3 }, { in: 3.2, out: 5 }])).toEqual([{ in: 0, out: 2 }, { in: 5, out: 10 }]);
  });
  it('toOutput maps source time onto the edited timeline (null when cut)', () => {
    const keep = [{ in: 0, out: 10 }, { in: 20, out: 30 }];
    expect(toOutput(5, keep)).toBe(5);
    expect(toOutput(15, keep)).toBeNull();
    expect(toOutput(25, keep)).toBe(15);
  });
});

describe('what is always cut', () => {
  it('silences of 0.6 s or more, leaving 0.15 s either side', () => {
    expect(silenceCuts([{ start: 40, end: 50 }, { start: 52, end: 52.4 }])).toEqual([{ in: 40.15, out: 49.85, reason: 'silence' }]);
  });
  it('filler words', () => {
    expect(fillerCuts([{ w: 'Um,', s: 1, e: 1.3 }, { w: 'uhh', s: 2, e: 2.2 }, { w: 'umbrella', s: 3, e: 3.5 }, { w: 'Hmm.', s: 4, e: 4.4 }]).map((r) => r.in)).toEqual([1, 2, 4]);
  });
  it('a retake removes everything from the start of the interrupted sentence up to the marker', () => {
    const w = words();
    // Sentence boundaries after "end." at 4, 9, 14, ... the marker at 17.5 interrupts the sentence that began at 15.1.
    expect(sentenceStart(w, 17.5)).toBe(15.1);
    expect(retakeCuts([{ t: 17.5, kind: 'retake' }, { t: 30, kind: 'chapter' }], w, 60)).toEqual([{ in: 15.1, out: 17.5, reason: 'retake' }]);
    // A pause of 0.6 s also starts a sentence.
    const paused: Word[] = [{ w: 'one', s: 0, e: 0.5 }, { w: 'two', s: 2, e: 2.5 }, { w: 'three', s: 2.6, e: 3 }];
    expect(sentenceStart(paused, 3.2)).toBe(2);
  });
});

describe('the rules plan', () => {
  it('cuts silences, fillers and retakes, and says so in one sentence', () => {
    const p = rulesPlan(input({ markers: [{ t: 17.5, kind: 'retake' }, { t: 30, kind: 'chapter', label: 'The numbers' }] }));
    expect(p.removed.map((r) => r.reason).sort()).toEqual(['filler', 'retake', 'silence']);
    expect(p.summary).toBe('Cut 10 s of silence, 1 filler word and 1 retake');
    expect(p.keep.every((r) => r.out - r.in >= MIN_SEGMENT_S)).toBe(true);
    expect(p.keptS).toBeCloseTo(60 - 9.7 - 0.7 - 2.4, 1);
    expect(p.chapters).toEqual([{ t: 0, title: 'Intro' }, { t: 30, title: 'The numbers' }]);
    expect(p.title).toBe('Seller finance in plain words');
  });
  it('summary wording', () => {
    expect(summarise([])).toBe('Nothing needed cutting');
    expect(summarise([{ in: 0, out: 252, reason: 'silence' }, { in: 300, out: 301, reason: 'retake' }, { in: 310, out: 311, reason: 'retake' }, { in: 320, out: 321, reason: 'retake' }]))
      .toBe('Cut 4 m 12 s of silence and 3 retakes');
  });
});

describe('validatePlan (the brain is never trusted)', () => {
  it('clamps, sorts and merges keep ranges, drops pieces under 0.3 s, and still removes silences, fillers and retakes', () => {
    const v = validatePlan({ title: 'A title', keep: [{ in: 30, out: 75 }, { in: -4, out: 31 }, { in: 55, out: 55.1 }], removed: [] }, input({ markers: [{ t: 17.5, kind: 'retake' }] }));
    expect(v.usedRules).toBe(false);
    expect(v.issues.join(' ')).toMatch(/outside the recording were clamped/);
    for (let i = 0; i < v.plan.keep.length; i++) {
      const r = v.plan.keep[i];
      expect(r.in).toBeGreaterThanOrEqual(0);
      expect(r.out).toBeLessThanOrEqual(60);
      expect(r.out - r.in).toBeGreaterThanOrEqual(MIN_SEGMENT_S);
      if (i) expect(r.in).toBeGreaterThan(v.plan.keep[i - 1].out); // monotonic, no overlaps
    }
    // The retake (15.1-17.5), the filler (12.1-12.8) and the silence (40.15-49.85) are gone even though the brain kept them.
    for (const t of [16, 12.5, 45]) expect(toOutput(t, v.plan.keep)).toBeNull();
    expect(v.plan.keptS).toBeCloseTo(total(v.plan.keep), 3);
  });
  it("applies the brain's own removals (false starts) and names them", () => {
    const v = validatePlan({ keep: [{ in: 0, out: 60 }], removed: [{ in: 20.1, out: 22.8, reason: 'False_start' }] }, input());
    expect(toOutput(21, v.plan.keep)).toBeNull();
    expect(v.plan.summary).toMatch(/1 false start/);
  });
  it("a plan that keeps under half is replaced by the rules plan, keeping the brain's title and chapters", () => {
    const v = validatePlan({ title: 'Kept title', keep: [{ in: 0, out: 10 }], chapters: [{ t: 0, title: 'Start' }, { t: 35, title: 'Later' }] }, input());
    expect(v.usedRules).toBe(true);
    expect(v.issues.join(' ')).toMatch(/under half/);
    expect(v.plan.title).toBe('Kept title');
    expect(v.plan.chapters.map((c) => c.title)).toEqual(['Start', 'Later']);
    expect(v.plan.keptS).toBeGreaterThan(40);
  });
  it('retakes and silences excuse a short edit (the floor is half of what is left after them)', () => {
    // 60 s, 9.7 s of silence and a retake marker at 39.5 that cuts back to the sentence start at 35.1.
    const v = validatePlan({ keep: [{ in: 0, out: 30 }] }, input({ markers: [{ t: 39.5, kind: 'retake' }] }));
    expect(v.usedRules).toBe(false);
  });
  it('junk, empty or hostile replies never throw', () => {
    for (const raw of [null, 'x', 42, [], { keep: 'all' }, { keep: [{ in: 'a', out: {} }] }, { keep: [{ in: 1e9, out: -1e9 }] }]) {
      const v = validatePlan(raw, input());
      expect(v.plan.keep.length).toBeGreaterThan(0);
      expect(v.plan.keptS).toBeLessThanOrEqual(60);
    }
  });
  it('cleans the title and description (no exclamation marks, no em dashes, two lines at most)', () => {
    const v = validatePlan({ keep: [{ in: 0, out: 60 }], title: 'Buy a business — now!', description: 'One!\nTwo\nThree' }, input());
    expect(v.plan.title).toBe('Buy a business, now.');
    expect(v.plan.description.split('\n')).toHaveLength(2);
    expect(v.plan.title).not.toMatch(/[!—]/);
  });
});

describe('clips', () => {
  it('highlight markers first, each 30 to 60 s, inside the recording and not overlapping', () => {
    const inp = input({ duration: 600, markers: [{ t: 590, kind: 'highlight', label: 'Close' }, { t: 100, kind: 'highlight' }] });
    const keep = [{ in: 0, out: 600 }];
    const clips = fitClips(inp, keep, [{ in: 95, out: 140, title: 'dup' }, { in: 300, out: 500, title: 'Long one' }, { in: 10, out: 12, title: 'Short' }]);
    expect(clips.length).toBe(3);
    expect(clips[0]).toMatchObject({ in: 570, out: 600, title: 'Close' });
    for (const c of clips) { expect(c.out - c.in).toBeGreaterThanOrEqual(30); expect(c.out - c.in).toBeLessThanOrEqual(60); expect(c.out).toBeLessThanOrEqual(600); }
    expect(clips.some((c) => c.title === 'dup')).toBe(false); // overlaps the highlight at 100
    expect(clips[2]).toMatchObject({ in: 300, out: 360 });
  });
});

describe('inputs from outside', () => {
  it('markers are filtered, sorted and capped', () => {
    expect(cleanMarkers([{ t: 5, kind: 'retake' }, { t: 1, kind: 'chapter', label: 'Intro!' }, { t: -1, kind: 'retake' }, { t: 2, kind: 'boom' }, 'x', { t: 99, kind: 'highlight' }], 60))
      .toEqual([{ t: 1, kind: 'chapter', label: 'Intro.' }, { t: 5, kind: 'retake' }]);
  });
  it('Whisper turbo replies become words and segments offset by the chunk start', () => {
    const t = whisperChunk({ segments: [{ start: 0.5, end: 2, text: ' Hello there (laughs)', words: [{ word: ' Hello', start: 0.5, end: 0.9 }, { word: ' there', start: 1, end: 1.4 }] }] }, 30);
    expect(t.segments).toEqual([{ s: 30.5, e: 32, text: 'Hello there' }]);
    expect(t.words).toEqual([{ w: 'Hello', s: 30.5, e: 30.9 }, { w: 'there', s: 31, e: 31.4 }]);
    expect(whisperChunk({ text: 'just text' }, 60).segments[0].text).toBe('just text');
    expect(whisperChunk(null, 0)).toEqual({ words: [], segments: [] });
  });
  it('the prompt carries word times, markers, silences and the owner notes', () => {
    const p = planPrompt(input({ markers: [{ t: 17.5, kind: 'retake' }], notes: 'Cut the intro' }));
    expect(p.system).toMatch(/ONE JSON object/);
    expect(p.user).toMatch(/word@0\.10/);
    expect(p.user).toMatch(/"kind":"retake"/);
    expect(p.user).toMatch(/40\.00-50\.00/);
    expect(p.user).toMatch(/Owner's notes for this edit: Cut the intro/);
  });
  it('timeline sentences pass the copy rules', () => {
    for (const s of ['Cut 4 m 12 s of silence and 3 retakes', 'Nothing needed cutting']) expect(auditCopy(s)).toEqual([]);
  });
});

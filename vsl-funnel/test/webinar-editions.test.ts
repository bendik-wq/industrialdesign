import { describe, expect, it } from 'vitest';
import { auditCopy } from '../src/content/copy-rules';
import { AI_TIMELINE } from '../src/webinar/edition-ai';
import { AI_VIDEO_SRC, allTakeaways, edition, editionName, fromTimeline } from '../src/webinar/editions';
import { webinarSettings } from '../src/webinar/webinar';

const rt = (s: Record<string, string>) => ({ settings: s }) as unknown as Parameters<typeof webinarSettings>[0];

describe('editions', () => {
  it('defaults to the recorded masterclass and its v3 timeline', () => {
    expect(editionName({})).toBe('recorded');
    const w = webinarSettings(rt({}));
    expect(w.durationMin).toBe(66);
    expect(w.pitchAtMin).toBe(38);
    expect(edition({}).videoSrc).toBeNull();
  });

  it('switches the room to the AI edition, its timeline and its recording', () => {
    const e = edition({ WEBINAR_EDITION: 'ai' });
    expect(e.name).toBe('ai');
    const w = webinarSettings(rt({ WEBINAR_EDITION: 'ai' }));
    expect(w.durationMin).toBe(AI_TIMELINE.durationMin);
    expect(w.pitchAtMin).toBe(AI_TIMELINE.pitchAtMin);
    expect(w.videoSrc).toBe(AI_VIDEO_SRC);
    expect(w.placeholderVideo).toBe(false);
    // Settings still win over the edition.
    expect(webinarSettings(rt({ WEBINAR_EDITION: 'ai', WEBINAR_PITCH_AT: '20', WEBINAR_VIDEO_SRC: 'https://x/v.mp4' }))).toMatchObject({ pitchAtMin: 20, videoSrc: 'https://x/v.mp4' });
  });

  it('has a usable AI timeline: every cue inside the runtime, in order, with a recap per chapter', () => {
    const t = AI_TIMELINE;
    expect(t.pitchAtMin).toBeGreaterThan(0);
    expect(t.pitchAtMin).toBeLessThan(t.bonusAtMin);
    expect(t.bonusAtMin).toBeLessThan(t.durationMin);
    expect(t.buyinAt).toBeLessThan(t.pitchAtMin * 60);
    expect(t.calcAt).toBeLessThan(t.pitchAtMin * 60);
    // Every poll is one the room knows, the first one and the pitch poll are always there.
    for (const id of Object.keys(t.polls)) expect(['target_type', 'timeline', 'blocker', 'own_cash', 'soft_close']).toContain(id);
    expect(t.polls).toHaveProperty('target_type');
    expect(t.polls).toHaveProperty('soft_close');
    for (const m of Object.values(t.polls)) expect(m).toBeLessThan(t.durationMin);
    expect(t.polls.soft_close).toBeGreaterThan(t.pitchAtMin);
    const ats = t.chapters.map((c) => c.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    for (const c of t.chapters) expect(t.recaps[String(c.at)], c.title).toBeTruthy();
    const steps = Object.values(t.steps);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(Math.abs(t.steps.plan - t.pitchAtMin * 60)).toBeLessThanOrEqual(1);
  });

  it('a timeline that sells the call (cta apply) asks the pitch poll about the call and keeps only CTA cues after the pitch', () => {
    const e = fromTimeline({ ...AI_TIMELINE, polls: { ...AI_TIMELINE.polls, timeline: 30 }, cta: 'apply', ctaAt: [600, AI_TIMELINE.pitchAtMin * 60 + 90, AI_TIMELINE.pitchAtMin * 60 + 30] });
    expect(e.cta).toBe('apply');
    expect(e.ctaAt).toEqual([AI_TIMELINE.pitchAtMin * 60 + 30, AI_TIMELINE.pitchAtMin * 60 + 90].filter((s) => s >= AI_TIMELINE.pitchAtMin * 60));
    const soft = e.polls.find((p) => p.id === 'soft_close')!;
    expect(soft.question).toMatch(/strategy call/);
    expect(soft.options.map((o) => o.value)).toEqual(['yes', 'more', 'not_yet']);
    expect(e.polls.map((p) => p.id)).toContain('timeline');
    for (const line of [soft.question, ...soft.options.map((o) => o.label)]) expect(auditCopy(line), line).toEqual([]);
    // Without it (the Sprint recordings), nothing changes.
    expect(fromTimeline({ ...AI_TIMELINE, cta: undefined }).cta).toBe('sprint');
    expect(edition({}).cta).toBe('sprint');
  });

  it('spaces the AI key points one at a time and keeps every line within the copy rules', () => {
    const tk = AI_TIMELINE.takeaways;
    expect(tk.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < tk.length; i++) expect(tk[i].at - tk[i - 1].at, tk[i].id).toBeGreaterThanOrEqual(75);
    for (const line of [...tk.map((t) => t.text), ...Object.values(AI_TIMELINE.recaps)]) expect(auditCopy(line), line).toEqual([]);
    expect(new Set(allTakeaways().map((t) => t.id)).size).toBe(allTakeaways().length);
  });
});

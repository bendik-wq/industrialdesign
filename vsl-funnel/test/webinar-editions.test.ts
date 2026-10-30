import { describe, expect, it } from 'vitest';
import { auditCopy } from '../src/content/copy-rules';
import { AI_TIMELINE } from '../src/webinar/edition-ai';
import { AI_VIDEO_SRC, allTakeaways, edition, editionName } from '../src/webinar/editions';
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
    expect(Object.keys(t.polls).sort()).toEqual(['blocker', 'own_cash', 'soft_close', 'target_type']);
    for (const m of Object.values(t.polls)) expect(m).toBeLessThan(t.durationMin);
    expect(t.polls.soft_close).toBeGreaterThan(t.pitchAtMin);
    const ats = t.chapters.map((c) => c.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    for (const c of t.chapters) expect(t.recaps[String(c.at)], c.title).toBeTruthy();
    const steps = Object.values(t.steps);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(Math.abs(t.steps.plan - t.pitchAtMin * 60)).toBeLessThanOrEqual(1);
  });

  it('spaces the AI key points one at a time and keeps every line within the copy rules', () => {
    const tk = AI_TIMELINE.takeaways;
    expect(tk.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < tk.length; i++) expect(tk[i].at - tk[i - 1].at, tk[i].id).toBeGreaterThanOrEqual(75);
    for (const line of [...tk.map((t) => t.text), ...Object.values(AI_TIMELINE.recaps)]) expect(auditCopy(line), line).toEqual([]);
    expect(new Set(allTakeaways().map((t) => t.id)).size).toBe(allTakeaways().length);
  });
});

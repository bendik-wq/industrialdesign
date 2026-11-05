import { afterEach, describe, expect, it } from 'vitest';
import { rtFor, seededDb } from './brain-fixture';
import { makePlan, setStudioBrain } from '../src/studio/pipeline';
import { brainContext } from '../src/brain/prompt';

// The brain is the copy context for videos too: the Studio editor's plan (title, description, chapters, short-clip titles).
const input = {
  title: 'Buying a competitor', duration: 60, layout: 'stage', markers: [], silences: [],
  transcript: { words: [], segments: [{ s: 0, e: 5, text: 'Here is how a hook earns the next sentence when you buy a competitor.' }] },
} as never;

describe('brain as video copy context', () => {
  afterEach(() => setStudioBrain(null));
  it('the edit planner gets the brain section (no notes field asked for)', { timeout: 60_000 }, async () => {
    const rt = rtFor(seededDb());
    let seen = '';
    setStudioBrain(async (_rt, p) => { seen = p.system; return JSON.stringify({ title: 'T', description: 'a\nb', removed: [], chapters: [], captions: { style: 'clean' }, clips: [] }); });
    const r = await makePlan(rt, input);
    expect(r.brain).toBe('claude');
    expect(seen).toContain('BRAIN');
    expect(seen).toContain('there is no notes field here');
    expect(seen).not.toContain('In the notes field');
  });
  it('with no brain loaded the planner prompt is unchanged', async () => {
    const rt = rtFor(seededDb());
    await (rt.env.DB as D1Database).prepare('DELETE FROM brain_chunks').run();
    await (rt.env.DB as D1Database).prepare('DELETE FROM brain_pages').run();
    expect(await brainContext(rt, 'anything')).toBe('');
  });
});

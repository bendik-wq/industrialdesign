import { describe, expect, it } from 'vitest';
import { buildMiroBoard, miroLayout, sprintDocHtml, sprintPage } from '../src/content/sprint-export';
import type { Sprint } from '../src/content/ideas';

const topic = (id: string, stage: 'TOFU' | 'MOFU' | 'BOFU', next: string) => ({
  id, topic: `Topic ${id} <script>`, evidence: 'Applicants said so & more', demand_phrase: 'buy a business', demand: 'direct' as const, awareness: 'problem_aware' as const, belief: 'possible' as const, stage,
  angle: 'agreeable' as const, format: 'Whiteboard', length_min: 12, titles: [`Title A ${id}`, `Title B ${id}`], thumbnails: [{ text: '“$0 DOWN”', visual: 'board', emotion: 'calm' }, { text: 'FIRST', visual: 'face', emotion: 'knowing' }],
  hook: 'Hook line', outline: { intro_callouts: 'For owners', logic_ladder: ['One', 'Two', 'Three'], callbacks: 'Back to it', proof: 'Illustrative' }, cta: { type: 'soft' as const, line: 'Watch next' }, next_video: next,
});
const sprint: Sprint = {
  summary: 'The read', binge_path: ['t2', 't1'], topics: [topic('t1', 'MOFU', 'vsl'), topic('t2', 'TOFU', 't1')],
  new_angles: [{ topic: 'Australia', why: 'asked', cluster: 'geography' }], checks: { controversial_share: '0 of 2', beliefs_covered: ['possible'], gaps: ['No trust video'] },
};

describe('sprint brief', () => {
  const html = sprintDocHtml(sprint, Date.UTC(2026, 9, 15), { miroUrl: 'https://miro.com/app/board/x/' });
  it('orders videos by the binge path and links them', () => {
    expect(html.indexOf('VIDEO 01  ·  TOFU')).toBeLessThan(html.indexOf('VIDEO 02  ·  MOFU'));
    expect(html).toContain('<b>Next:</b> Video 02');
    expect(html).toContain('open in Miro');
  });
  it('escapes model text and strips doubled quotes on thumbnails', () => {
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('>$0 DOWN<');
  });
  it('uses fixed column widths so Google Docs keeps the layout', () => {
    expect(html).toContain('<col width="7%"><col width="93%">');
  });
  it('page has no inline script and offers Docs, PDF and Miro', () => {
    const page = sprintPage(sprint, Date.now(), { id: 'y1', miroReady: true });
    expect(page).not.toMatch(/<script>(?!<\/script>)/);
    expect(page).toContain('src="/assets/brief.js"');
    expect(page).toContain('data-miro');
    expect(sprintPage(sprint, Date.now(), { id: 'y1' })).toContain('Connect Miro');
  });
});

describe('miro board', () => {
  it('lays out a column per video with arrows in binge order', () => {
    const { items, arrows } = miroLayout(sprint, Date.now());
    expect(arrows).toHaveLength(1);
    expect(items.filter((i) => i.type === 'sticky_note')).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('<script>');
  });
  it('creates the board in bulk and joins the headers', async () => {
    const calls: { url: string; body: unknown }[] = [];
    let n = 0;
    const fake = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url.endsWith('/boards')) return new Response(JSON.stringify({ id: 'B1', viewLink: 'https://miro.com/app/board/B1=/' }));
      if (url.endsWith('/items/bulk')) return new Response(JSON.stringify({ data: (body as unknown[]).map(() => ({ id: String(++n) })) }));
      return new Response('{}');
    }) as unknown as typeof fetch;
    const url = await buildMiroBoard('tok', sprint, Date.now(), 'Sprint', fake);
    expect(url).toBe('https://miro.com/app/board/B1=/');
    expect(calls.filter((c) => c.url.endsWith('/connectors'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith('/items/bulk')).every((c) => (c.body as unknown[]).length <= 20)).toBe(true);
  });
  it('surfaces Miro errors', async () => {
    const fail = (async () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })) as unknown as typeof fetch;
    await expect(buildMiroBoard('bad', sprint, Date.now(), 'S', fail)).rejects.toThrow('Miro 401: Unauthorized');
  });
});

import { describe, expect, it } from 'vitest';
import { generateSprint, sprintMarkdown } from '../src/content/ideas';

// A tiny D1 stand-in: every query returns the rows for the first table key it mentions.
function fakeDb(tables: Record<string, unknown[]>) {
  const stmt = (sql: string) => ({
    bind: () => stmt(sql),
    all: async () => ({ results: Object.entries(tables).find(([t]) => sql.includes(t))?.[1] ?? [] }),
    first: async () => null,
    run: async () => ({ meta: { changes: 1 } }),
  });
  return { prepare: (sql: string) => stmt(sql) };
}

describe('YouTube idea generator (rules engine)', () => {
  const leads = Array.from({ length: 12 }, (_, i) => ({
    answers: '{}', revenue_band: i < 8 ? '<100k' : '5m-20m', industry: i % 2 ? 'Roofing' : 'Healthcare clinics', objection: null, lost_reason: null, status: 'booked', booked_at: 1,
    booking_answers: JSON.stringify([{ q: 'Select the statements that apply to you', a: 'I have never bought a business before\nI need help getting deals funded\nI don\'t know how to structure deals' }]),
  }));
  const rt = { settings: {}, env: { DB: fakeDb({ 'FROM leads WHERE email': leads, 'SUM(revenue_band': [{ leads: 12, applied: 10, booked: 6, won: 0, small: 8 }] }) } } as never;

  it('plans 5–10 topics in binge order from what applicants say', async () => {
    const { sprint, source } = await generateSprint(rt);
    expect(source).toBe('rules');
    expect(sprint.topics.length).toBeGreaterThanOrEqual(5);
    expect(sprint.topics.length).toBeLessThanOrEqual(10);
    expect(sprint.binge_path).toEqual(sprint.topics.map((t) => t.id));
    for (const t of sprint.topics) {
      expect(t.titles).toHaveLength(2);
      expect(t.thumbnails).toHaveLength(2);
      expect(t.hook.length).toBeGreaterThan(20);
    }
    expect(sprint.topics.filter((t) => t.angle === 'controversial').length).toBeLessThanOrEqual(2);
    expect(sprint.topics.some((t) => /big enough/i.test(t.topic))).toBe(true);
    expect(sprint.topics.some((t) => /clinic|roofing|trades/i.test(t.topic + t.titles.join(' ')))).toBe(true);
    const all = JSON.stringify(sprint);
    expect(all).not.toMatch(/free (strategy )?call/i);
    const funded = sprint.topics.find((t) => /fund/i.test(t.topic));
    if (funded) expect(JSON.stringify(funded)).toMatch(/rollover/i);
  });

  it('exports to Markdown for docs', async () => {
    const { sprint } = await generateSprint(rt);
    const md = sprintMarkdown(sprint, Date.now());
    expect(md).toContain('# YouTube sprint');
    expect(md).toContain('Binge path');
    expect(md).toContain('New angles to explore');
  });
});

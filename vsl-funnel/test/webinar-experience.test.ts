import { describe, expect, it } from 'vitest';
import { auditCopy, auditEmail, auditFields } from '../src/content/copy-rules';
import {
  AVERAGE_MIN, BLOCKER_GAP, BUILDER_STEPS, BUYIN_AT, CHAPTER_RECAP, EXPERIENCE_COPY, GAP_NEXT, NOTES_COPY, REACTION_MIN, SCORE_RULES, TAKEAWAYS, WALL_MIN,
  chapterAt, cleanBuyIn, dealMath, illustrativeTarget, publicAverage, publicReactionCounts, publicWall, readinessScore, wallLabel,
} from '../src/webinar/experience';
import { DEFAULT_CHAPTERS, DEFAULT_POLLS } from '../src/webinar/content';
import { SEQUENCES } from '../src/integrations/sequences';
import { TEMPLATES, type TemplateCtx, renderEmail } from '../src/integrations/templates';
import { REVENUE_LABEL } from '../src/sales/qualify';
import type { Lead } from '../src/funnel/leads';
import type { Runtime } from '../src/app';

describe('readiness score', () => {
  it('adds up to exactly 100 at most, and 0 with nothing answered', () => {
    expect(SCORE_RULES.reduce((a, f) => a + f.max, 0)).toBe(100);
    expect(readinessScore({}).score).toBe(0);
    const best = readinessScore({ band: '25m-50m', target: 'competitor', timeline: '0_3', blocker: 'time', own_cash: 'none', dscr: 2.1 });
    expect(best.score).toBe(100);
    for (const f of best.factors) expect(f.points).toBe(f.max);
  });

  it('scores each factor from its own answer', () => {
    const only = (inp: Parameters<typeof readinessScore>[0], id: string) => readinessScore(inp).factors.find((f) => f.id === id)!.points;
    expect(only({ band: '<1m' }, 'size')).toBe(0);
    expect(only({ band: '1m-3m' }, 'size')).toBe(15);
    expect(only({ band: '3m-10m' }, 'size')).toBe(20);
    expect(only({ band: '10m+' }, 'size')).toBe(25);
    expect(only({ target: 'competitor' }, 'target')).toBe(20);
    expect(only({ target: 'not_sure' }, 'target')).toBe(6);
    expect(only({ target: 'none_yet' }, 'target')).toBe(6);
    expect(only({ timeline: '0_3' }, 'timeline')).toBe(20);
    expect(only({ timeline: 'learning' }, 'timeline')).toBe(4);
    expect(only({ dscr: 1.6 }, 'numbers')).toBe(20);
    expect(only({ dscr: 1.3 }, 'numbers')).toBe(12);
    expect(only({ dscr: 0.9 }, 'numbers')).toBe(6);
    expect(only({ dscr: null }, 'numbers')).toBe(0);
    expect(only({ own_cash: 'none' }, 'capital')).toBe(10);
    expect(only({ own_cash: 'happy' }, 'capital')).toBe(10);
    expect(only({ blocker: 'financing' }, 'blocker')).toBe(5);
    // Unknown values never add points, and the total stays in bounds.
    expect(readinessScore({ band: 'nonsense', target: 'x', timeline: 'y', dscr: -3 }).score).toBe(0);
    expect(readinessScore({ dscr: Number.POSITIVE_INFINITY }).score).toBeLessThanOrEqual(100);
  });

  it('names one gap: failing numbers first, then the blocker they named, then the biggest shortfall', () => {
    expect(readinessScore({ blocker: 'finding', dscr: 1.2 }).gap).toBe('financing structure');
    expect(readinessScore({ blocker: 'time', dscr: 1.9 }).gap).toBe(BLOCKER_GAP.time);
    expect(readinessScore({ band: '10m+', target: 'competitor', timeline: '0_3', own_cash: 'some', dscr: 2 }).gap).toBe('naming what stops you');
    expect(readinessScore({}).gap).toBe('business size');
    for (const g of [...Object.values(BLOCKER_GAP), ...SCORE_RULES.map((r) => r.gap)]) expect(GAP_NEXT[g], g).toBeTruthy();
  });

  it('only reports the real average once enough people have a score', () => {
    expect(publicAverage(AVERAGE_MIN - 1, 61.2)).toBeNull();
    expect(publicAverage(AVERAGE_MIN, 61.2)).toEqual({ n: AVERAGE_MIN, avg: 61 });
    expect(publicAverage(500, null)).toBeNull();
  });
});

describe('deal builder', () => {
  it('uses the room calculator assumptions (70/20/10, 9% over 10 years, 6% over 5 years)', () => {
    const d = dealMath(500_000, 1_500_000);
    expect(d.debt).toBe(1_050_000);
    expect(d.note).toBe(300_000);
    expect(d.roll).toBe(150_000);
    expect(d.service).toBeGreaterThan(230_000);
    expect(d.service).toBeLessThan(240_000);
    expect(d.dscr).toBeGreaterThan(2);
  });
  it('sizes an illustrative target from the revenue band', () => {
    expect(illustrativeTarget('3m-10m')).toEqual({ profit: 500_000, price: 1_500_000 });
    expect(illustrativeTarget('1m-3m').profit).toBeLessThan(illustrativeTarget('3m-10m').profit);
    expect(illustrativeTarget('25m-50m').profit).toBeGreaterThan(illustrativeTarget('3m-10m').profit);
    expect(illustrativeTarget(null)).toEqual({ profit: 500_000, price: 1_500_000 });
  });
  it('has one step per chapter up to the pitch, in order, ending at 45:00', () => {
    const ats = BUILDER_STEPS.map((s) => s.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    expect(ats).toEqual(DEFAULT_CHAPTERS.filter((c) => c.at <= 45).map((c) => c.at * 60));
  });
});

describe('takeaways', () => {
  it('are 12 to 20 key points, in time order, inside the hour, with unique ids', () => {
    expect(TAKEAWAYS.length).toBeGreaterThanOrEqual(12);
    expect(TAKEAWAYS.length).toBeLessThanOrEqual(20);
    const ats = TAKEAWAYS.map((t) => t.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    for (let i = 1; i < ats.length; i++) expect(ats[i] - ats[i - 1], TAKEAWAYS[i].id).toBeGreaterThanOrEqual(75); // one card at a time
    expect(ats[ats.length - 1]).toBeLessThan(3600);
    expect(new Set(TAKEAWAYS.map((t) => t.id)).size).toBe(TAKEAWAYS.length);
  });
  it('label every example number illustrative and name all three sources when funding is described', () => {
    for (const t of TAKEAWAYS) {
      if (/\$\d/.test(t.text)) expect(t.text, t.id).toMatch(/illustrative/i);
      if (/commercial debt|seller finance|seller note/i.test(t.text) && !/lever/.test(t.text)) expect(t.text, t.id).toMatch(/seller rollover/i);
    }
  });
  it('do not land on a poll minute', () => {
    for (const t of TAKEAWAYS) for (const p of DEFAULT_POLLS) expect(Math.abs(t.at - p.at * 60), `${t.id} vs ${p.id}`).toBeGreaterThan(20);
  });
  it('have a recap line for every default chapter', () => {
    for (const c of DEFAULT_CHAPTERS) expect(CHAPTER_RECAP[c.at], c.title).toBeTruthy();
    expect(chapterAt(DEFAULT_CHAPTERS, 0)).toBe(0);
    expect(chapterAt(DEFAULT_CHAPTERS, 28 * 60 + 12)).toBe(28);
    expect(chapterAt(DEFAULT_CHAPTERS, 59 * 60)).toBe(52);
  });
});

describe('reactions', () => {
  it('never pass on a count under the minimum', () => {
    const rows = [
      { chapter_at: 14, kind: 'new', n: REACTION_MIN - 1 },
      { chapter_at: 14, kind: 'do', n: REACTION_MIN },
      { chapter_at: 21, kind: 'new', n: 47 },
      { chapter_at: 21, kind: 'bogus', n: 99 },
      { chapter_at: 28, kind: 'explain', n: 3 },
    ];
    expect(publicReactionCounts(rows)).toEqual({ 14: { do: REACTION_MIN }, 21: { new: 47 } });
    expect(REACTION_MIN).toBeGreaterThanOrEqual(10);
    expect(publicReactionCounts([])).toEqual({});
  });
});

describe('buy-in', () => {
  it('strips links, email addresses and phone numbers, and caps the length', () => {
    expect(cleanBuyIn('More profit, call me on +1 (415) 555-0134 or mail joe@acme.com')).toBe('More profit, call me on or mail');
    expect(cleanBuyIn('See https://spam.example/x and www.spam.com and acme.com.au now')).toBe('See and and now');
    expect(cleanBuyIn('  A business   that runs\nwithout me  ')).toBe('A business that runs without me');
    expect(cleanBuyIn('x'.repeat(400)).length).toBe(280);
    expect(cleanBuyIn('<b>hi</b>')).toBe('bhi/b');
    expect(cleanBuyIn(42)).toBe('');
    expect(cleanBuyIn('Going from $3M to $10M in revenue')).toBe('Going from $3M to $10M in revenue');
  });
  it('shows real shared answers only once enough people have shared, with an initial and band only', () => {
    const row = (i: number, lead = `l${i}`) => ({ lead_id: lead, text: `Answer ${i}`, first_name: 'mia', band: '3m-10m' });
    expect(publicWall([1, 2, 3, 4].map((i) => row(i)), REVENUE_LABEL)).toEqual([]);
    // The same person twice counts once (latest answer).
    expect(publicWall([row(1), row(2, 'l1'), row(3), row(4), row(5)], REVENUE_LABEL)).toEqual([]);
    const wall = publicWall([1, 2, 3, 4, 5].map((i) => row(i)), REVENUE_LABEL, 'l2');
    expect(wall.map((w) => w.text)).toEqual(['Answer 1', 'Answer 3', 'Answer 4', 'Answer 5']);
    expect(wall[0].who).toBe('M., $3M–$10M');
    expect(WALL_MIN).toBeGreaterThanOrEqual(5);
    expect(wallLabel(null, null, REVENUE_LABEL)).toBe('');
    expect(wallLabel('  Ölaf ', 'nonsense', REVENUE_LABEL)).toBe('Ö.');
  });
  it('asks before the pitch, in minutes 38 to 40', () => {
    expect(BUYIN_AT).toBeGreaterThanOrEqual(38 * 60);
    expect(BUYIN_AT).toBeLessThan(40 * 60);
  });
});

describe('copy', () => {
  it('every string passes the copy rules', () => {
    expect(auditFields({ EXPERIENCE_COPY, NOTES_COPY, CHAPTER_RECAP, GAP_NEXT, BLOCKER_GAP, steps: BUILDER_STEPS.map((s) => [s.title, s.soon]), rules: SCORE_RULES.map((r) => [r.label, r.raise, r.gap]) })).toEqual([]);
    for (const t of TAKEAWAYS) expect(auditCopy(t.text), t.id).toEqual([]);
  });
  it('never calls the call free, promises results or fakes liveness or numbers', () => {
    const all = JSON.stringify({ EXPERIENCE_COPY, NOTES_COPY, CHAPTER_RECAP, GAP_NEXT, TAKEAWAYS, SCORE_RULES });
    expect(all).not.toMatch(/\bfree\b|guarantee[sd]? (you|your|results?|returns?|approval)|\blive\b|people are watching|spots? left|owners like you score/i);
    // Every count template is a real number filled in from the server.
    for (const t of Object.values(EXPERIENCE_COPY.reactCount)) expect(t).toMatch(/\{n\}/);
  });
});

describe('notes email', () => {
  const at = Date.now() - 3_600_000;
  const lead = (x: Partial<Lead> = {}) => ({ id: 'l', first_name: 'Dana', status: 'partial', webinar_at: at, webinar_attended_at: at + 60_000, app_completed_at: null, booked_at: null, booking_cancelled_at: null, webinar_watch_pct: 0.9, ...x }) as Lead;
  const seq = SEQUENCES.webinar;
  const step = seq.steps.find((s) => s.template === 'w_notes')!;
  it('is the last webinar step, fits the cycle, and only goes to people who saved a note in this showing', async () => {
    expect(seq.steps[seq.steps.length - 1].template).toBe('w_notes');
    expect(seq.steps.length).toBeLessThanOrEqual(seq.cycle!);
    expect(step.offsetMs).toBe(90 * 60_000);
    // A fake D1: notes saved at these times.
    const rtWith = (saved: number[]) => ({
      env: { DB: { prepare: () => ({ bind: (_lead: string, since: number) => ({ first: async () => (saved.some((t) => t >= since) ? { x: 1 } : null) }) }) } },
    }) as unknown as Runtime;
    expect(await step.skipIfAsync!(rtWith([]), lead())).toBe(true);
    expect(await step.skipIfAsync!(rtWith([at + 20 * 60_000]), lead())).toBe(false);
    expect(await step.skipIfAsync!(rtWith([at - 5 * 86_400_000]), lead())).toBe(true);
    expect(await step.skipIfAsync!(rtWith([at + 20 * 60_000]), lead({ webinar_at: null }))).toBe(true);
  });
  it('lists every saved note, quotes their own words, and passes the email copy rules', () => {
    const ctx = {
      lead: lead(), name: 'Dana', siteName: 'G&L', link: (p: string) => p, bookingUrl: null, whatsappUrl: null, callTime: null,
      webinar: { title: 'The Masterclass', when: 'Tue', room: 'r', replay: 'p', ics: null, google: null, replayHours: 48, durationMin: 60, notes: TAKEAWAYS.map((t) => t.text), notesUrl: 'https://live.test/notes/x', buyin: 'A business that runs without me', apply: '/w/x' },
    } as TemplateCtx;
    const e = TEMPLATES.w_notes(ctx);
    expect(auditEmail(e)).toEqual([]);
    const { text } = renderEmail(e, { openPixel: null, unsubscribeUrl: 'u', signature: 'Josh', address: 'a' });
    for (const t of TAKEAWAYS) expect(text).toContain(t.text.slice(0, 30));
    expect(text).toContain('A business that runs without me');
    expect(text).toMatch(/seller rollover/);
    expect(text).not.toMatch(/undefined|null|NaN/);
    const bare = TEMPLATES.w_notes({ ...ctx, webinar: null });
    expect(auditEmail(bare)).toEqual([]);
  });
});

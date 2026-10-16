import { describe, expect, it } from 'vitest';
import { auditEmail } from '../src/content/copy-rules';
import { prewebinarTimes } from '../src/integrations/email';
import { SEQUENCES } from '../src/integrations/sequences';
import { TEMPLATES } from '../src/integrations/templates';
import { PREWEBINAR_ORDER, PREWEBINAR_TEMPLATES, prewebinarPlan } from '../src/webinar/prewebinar';

const DAY = 86_400_000;
const ctx: any = {
  lead: { id: 'l', email: 'a@b.c' }, name: 'Sam', siteName: 'G&L', link: (p: string) => p, bookingUrl: '/book', whatsappUrl: null, callTime: null,
  webinar: { title: 'The No-Money-Down Acquisition Masterclass', when: 'Tuesday 21 October, 7:00 pm AEDT', room: '/room/x', replay: '/replay/x', ics: '/ics/x', google: '/g', replayHours: 48, durationMin: 60 },
};

describe('pre-webinar run', () => {
  it('has 210 emails, one per slot over 14 days, all registered and in order', () => {
    expect(PREWEBINAR_ORDER).toHaveLength(210);
    expect(new Set(PREWEBINAR_ORDER.map(([t]) => t)).size).toBe(210);
    for (const [t] of PREWEBINAR_ORDER) { expect(PREWEBINAR_TEMPLATES[t], t).toBeTypeOf('function'); expect(TEMPLATES[t], t).toBeTypeOf('function'); }
    expect(SEQUENCES.prewebinar.steps).toHaveLength(210);
  });

  it('every email passes the copy rules, links only to the session or a guide, and has a unique subject', () => {
    const subjects = new Set<string>();
    for (const [t] of PREWEBINAR_ORDER) {
      const c = PREWEBINAR_TEMPLATES[t](ctx);
      expect(auditEmail(c), t).toEqual([]);
      expect(subjects.has(c.subject), `${t} duplicate subject`).toBe(false);
      subjects.add(c.subject);
      expect(JSON.stringify(c), t).not.toMatch(/\bfree\b[^.]{0,30}\b(call|session|masterclass|webinar)\b|\/book|\/apply|guarantee[sd]? (you|your|results?)/i);
      if (c.cta) expect(c.cta.href, t).toMatch(/^\/(room\/x|g|guides\/[a-z0-9-]+)$/);
    }
  });

  it('sends 15 a day across 7am–9pm their time, stopping 3½ hours before the session', () => {
    const now = Date.UTC(2026, 9, 1, 0, 0); // 10am in Sydney
    const at = now + 14 * DAY + 9 * 3_600_000;
    const ts = prewebinarTimes(now, at, 'Australia/Sydney', 15);
    expect(ts.length).toBeGreaterThan(195);
    expect(ts.length).toBeLessThanOrEqual(225);
    expect(Math.max(...ts)).toBeLessThanOrEqual(at - 3.5 * 3_600_000);
    expect(Math.min(...ts)).toBeGreaterThanOrEqual(now + 45 * 60_000);
    for (const t of ts) { const h = Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hourCycle: 'h23' }).format(t)); expect(h).toBeGreaterThanOrEqual(7); expect(h).toBeLessThanOrEqual(21); }
    const perDay = new Map<string, number>();
    for (const t of ts) { const d = new Date(t).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney' }); perDay.set(d, (perDay.get(d) ?? 0) + 1); }
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(15);
    expect(prewebinarTimes(now, now + 2 * 3_600_000, 'UTC', 15)).toEqual([]);
    expect(prewebinarTimes(now, at, 'UTC', 0)).toEqual([]);
  });

  it('a short run keeps the most important emails in story order and ends on show-up-ready', () => {
    const plan = prewebinarPlan(20);
    expect(plan).toHaveLength(20);
    const idx = plan.map((t) => PREWEBINAR_ORDER.findIndex(([x]) => x === t));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(plan.at(-1)).toMatch(/^wp_e_/);
    expect(plan.filter((t) => t.startsWith('wp_e_')).length).toBeGreaterThanOrEqual(5);
    expect(prewebinarPlan(500)).toHaveLength(210);
    const sent = new Set(plan.slice(0, 5));
    expect(prewebinarPlan(500, sent).some((t) => sent.has(t))).toBe(false);
  });
});

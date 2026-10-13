import { describe, expect, it } from 'vitest';
import { parseSchedule, scheduleTimes, phase, ics, type Session, type Registration } from '../src/webinar/webinar';
import { SEQUENCES } from '../src/integrations/sequences';
import { TEMPLATES, type TemplateCtx, renderEmail } from '../src/integrations/templates';
import type { Lead } from '../src/funnel/leads';
import type { Runtime } from '../src/app';

const rt = { settings: { WEBINAR_DURATION_MIN: '60', WEBINAR_REPLAY_HOURS: '48', SALES_TIMEZONE: 'Australia/Sydney' }, origin: 'https://apply.test' } as unknown as Runtime;
const fmtSyd = (t: number) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);

describe('webinar schedule', () => {
  it('parses weekly slots', () => {
    expect(parseSchedule('Tue 19:00, Thu 12:00')).toEqual([{ dow: 2, h: 19, m: 0 }, { dow: 4, h: 12, m: 0 }]);
    expect(parseSchedule('wednesday 7pm; Sat 9:30am, nonsense')).toEqual([{ dow: 3, h: 19, m: 0 }, { dow: 6, h: 9, m: 30 }]);
  });

  it('creates two weeks of sessions at local wall-clock times (DST-safe)', () => {
    const now = Date.parse('2026-10-12T21:00:00Z'); // Tue 08:00 Sydney
    const t = scheduleTimes('Tue 19:00, Thu 12:00', 'Australia/Sydney', now, 14);
    expect(t.length).toBe(5); // 13, 15, 20, 22, 27 Oct
    expect(t.map(fmtSyd)).toEqual(['Tue 19:00', 'Thu 12:00', 'Tue 19:00', 'Thu 12:00', 'Tue 19:00']);
    expect(t.every((x) => x > now)).toBe(true);
  });

  it('knows when a session is waiting, running, in replay or expired', () => {
    const s = { id: 's', starts_at: 1_000_000_000_000, status: 'scheduled', mode: 'evergreen' } as Session;
    expect(phase(rt, s, s.starts_at - 1)).toBe('waiting');
    expect(phase(rt, s, s.starts_at + 10 * 60_000)).toBe('running');
    expect(phase(rt, s, s.starts_at + 2 * 3_600_000)).toBe('replay');
    expect(phase(rt, s, s.starts_at + 60 * 3_600_000)).toBe('expired');
    expect(phase(rt, { ...s, status: 'cancelled' }, s.starts_at)).toBe('cancelled');
  });

  it('builds a valid calendar file', () => {
    const out = ics(rt, { id: 's', starts_at: Date.parse('2026-10-13T08:00:00Z'), title: 'Masterclass; part 1', mode: 'evergreen' } as Session, { id: 'r1', token: 'abcdefghijklmnop1234' } as Registration);
    expect(out).toContain('DTSTART:20261013T080000Z');
    expect(out).toContain('DTEND:20261013T090000Z');
    expect(out).toContain('SUMMARY:Masterclass\\; part 1');
    expect(out).toContain('/room/abcdefghijklmnop1234');
  });
});

describe('webinar emails', () => {
  const at = Date.now() + 2 * 86_400_000;
  const lead = (x: Partial<Lead> = {}) => ({ id: 'l', first_name: 'Dana', status: 'partial', webinar_at: at, webinar_attended_at: null, app_completed_at: null, booked_at: null, booking_cancelled_at: null, webinar_watch_pct: null, ...x }) as Lead;
  const seq = SEQUENCES.webinar;
  const step = (t: string) => seq.steps.find((s) => s.template === t)!;

  it('every step has a template that renders, and blocks fit the cycle', () => {
    expect(seq.steps.length).toBeLessThanOrEqual(seq.cycle!);
    const ctx = { lead: lead(), name: 'Dana', siteName: 'G&L', link: (p: string) => p, bookingUrl: null, whatsappUrl: null, callTime: null, webinar: { title: 'The Masterclass', when: 'Tue 13 Oct, 7:00pm AEDT', room: 'https://live.test/room/x', replay: 'https://live.test/replay/x', ics: 'https://live.test/ics/x', google: 'https://calendar.google.com/x', replayHours: 48, durationMin: 60 } } as TemplateCtx;
    for (const s of seq.steps) {
      const { text } = renderEmail(TEMPLATES[s.template](ctx), { openPixel: null, unsubscribeUrl: 'u', signature: 'Josh', address: 'a' });
      expect(text, s.template).not.toMatch(/undefined|null|NaN/);
      expect(text.toLowerCase(), s.template).not.toMatch(/free (strategy )?call/);
    }
    // Renders without a session too (dashboard preview).
    expect(TEMPLATES.w_confirm({ ...ctx, webinar: null }).subject).toContain('you’re in');
  });

  it('sends attendees and no-shows different follow-up', () => {
    const came = lead({ webinar_attended_at: at + 5 * 60_000 });
    const missed = lead();
    expect(step('w_live').skipIf!(came)).toBe(true);
    expect(step('w_live').skipIf!(missed)).toBe(false);
    expect(step('w_thanks').skipIf!(came)).toBe(false);
    expect(step('w_thanks').skipIf!(missed)).toBe(true);
    expect(step('w_missed').skipIf!(came)).toBe(true);
    expect(step('w_missed').skipIf!(missed)).toBe(false);
    // An earlier session's attendance doesn't count for this one.
    expect(step('w_missed').skipIf!(lead({ webinar_attended_at: at - 7 * 86_400_000 }))).toBe(false);
    // Once they apply, the pitch emails stop.
    expect(step('w_offer').skipIf!(lead({ app_completed_at: Date.now() }))).toBe(true);
  });
});

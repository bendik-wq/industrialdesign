import { describe, expect, it } from 'vitest';
import { precallTimes, zonedTime } from '../src/integrations/email';
import { PRECALL_TEMPLATES, SEQUENCES } from '../src/integrations/sequences';
import { TEMPLATES, renderEmail } from '../src/integrations/templates';
import { initiationData, INBOUND_DATA } from '../src/integrations/elevenlabs-inbound';
import { factsFrom } from '../src/integrations/elevenlabs';
import type { Lead } from '../src/funnel/leads';

const hourIn = (t: number, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);

describe('pre-call barrage', () => {
  it('converts wall-clock time in a zone, across DST', () => {
    expect(new Date(zonedTime(2026, 10, 13, 9.5, 'Australia/Sydney')).toISOString()).toBe('2026-10-12T22:30:00.000Z'); // AEDT +11
    expect(new Date(zonedTime(2026, 7, 13, 9.5, 'Australia/Sydney')).toISOString()).toBe('2026-07-12T23:30:00.000Z'); // AEST +10
    expect(new Date(zonedTime(2026, 10, 13, 7.5, 'America/New_York')).toISOString()).toBe('2026-10-13T11:30:00.000Z');
  });

  it('sends 6 a day at local slots until 3h before the call', () => {
    const now = Date.parse('2026-10-12T21:00:00Z'); // Tue 08:00 Sydney
    const call = Date.parse('2026-10-15T23:00:00Z'); // Fri 10:00 Sydney
    const t = precallTimes(now, call, 'Australia/Sydney', 6);
    expect(t.length).toBeGreaterThan(12);
    expect(t.every((x) => x >= now + 90 * 60_000 && x <= call - 3 * 3_600_000)).toBe(true);
    expect([...new Set(t.map((x) => hourIn(x, 'Australia/Sydney')))].sort()).toEqual(['07:30', '09:30', '12:00', '14:30', '17:00', '19:30']);
    // Booked 08:00 Tuesday → first send 90 min later: 09:30, 12:00, 14:30, 17:00, 19:30 → 5 on day one
    expect(t.filter((x) => x < Date.parse('2026-10-13T13:00:00Z'))).toHaveLength(5);
    // nothing within 45 min of the 48h / 24h reminders
    expect(t.some((x) => Math.abs(x - (call - 24 * 3_600_000)) < 45 * 60_000)).toBe(false);
  });

  it('caps at the number of emails written, honours fewer per day and 0 = off', () => {
    const now = Date.parse('2026-10-12T21:00:00Z');
    expect(precallTimes(now, null, 'Australia/Sydney', 6).length).toBeLessThanOrEqual(PRECALL_TEMPLATES.length);
    const three = precallTimes(now, now + 10 * 86_400_000, 'Australia/Sydney', 3);
    expect([...new Set(three.map((x) => hourIn(x, 'Australia/Sydney')))].sort()).toEqual(['07:30', '14:30', '19:30']);
    expect(precallTimes(now, null, 'Australia/Sydney', 0)).toEqual([]);
  });

  it('has 24 distinct emails that all render, and stops once the call is near or done', () => {
    expect(new Set(PRECALL_TEMPLATES).size).toBe(24);
    const lead = { id: 'l', first_name: 'Dana', status: 'booked', booked_at: 1, booking_cancelled_at: null, call_at: Date.now() + 86_400_000 } as unknown as Lead;
    const ctx = { lead, name: 'Dana', siteName: 'G&L', link: (p: string) => `https://x${p}`, bookingUrl: 'https://cal', whatsappUrl: 'https://wa.me/1', callTime: 'Friday 10:00am' };
    const subjects = PRECALL_TEMPLATES.map((k) => {
      const c = TEMPLATES[k](ctx);
      expect(renderEmail(c, { openPixel: null, unsubscribeUrl: 'https://x/u', signature: 'Josh', address: 'WY' }).html).toContain('Dana');
      expect(c.body.join(' ')).not.toMatch(/\bfree\b.*call|call.*\bfree\b/i);
      return c.subject;
    });
    expect(new Set(subjects).size).toBe(24);
    const stop = SEQUENCES.precall.stopIf;
    expect(stop(lead)).toBe(false);
    expect(stop({ ...lead, call_at: Date.now() + 60 * 60_000 })).toBe(true);
    expect(stop({ ...lead, status: 'showed' })).toBe(true);
    expect(stop({ ...lead, booking_cancelled_at: 5 })).toBe(true);
  });
});

describe('callback agent', () => {
  it('refuses caller look-ups without the shared secret', async () => {
    const rt = { env: { DB: { prepare: () => ({ first: async () => ({ value: 'secret-x' }), bind: () => ({ run: async () => ({}) }) }) } }, settings: {}, reps: [] } as never;
    expect(await initiationData(rt, undefined, { caller_id: '+1' })).toBeNull();
    expect(await initiationData(rt, 'wrong', { caller_id: '+1' })).toBeNull();
  });
  it('reads callback-specific answers', () => {
    expect(factsFrom({ analysis: { data_collection_results: { wants_human_callback: { value: true }, callback_time: { value: 'after 3pm' }, caller_email: { value: 'a@b.co' } } } }, INBOUND_DATA))
      .toEqual({ wants_human_callback: true, callback_time: 'after 3pm', caller_email: 'a@b.co' });
  });
});

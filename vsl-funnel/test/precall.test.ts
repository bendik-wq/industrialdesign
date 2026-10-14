import { describe, expect, it } from 'vitest';
import { precallTimes, zonedTime } from '../src/integrations/email';
import { PRECALL_ARC, PRECALL_TEMPLATES, SEQUENCES, precallPlan } from '../src/integrations/sequences';
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

  const H = 3_600_000;
  const inWaking = (t: number) => { const h = Number(hourIn(t, 'Australia/Sydney').slice(0, 2)); return h >= 7 && h <= 21; };
  const gaps = (t: number[]) => t.slice(1).map((x, i) => x - t[i]);

  it('a call 2+ days out gets 20, spread over waking hours, clear of the reminders and 2h+ before the call', () => {
    const now = Date.parse('2026-10-12T22:00:00Z'); // Tue 09:00 Sydney
    const call = now + 54 * H;
    const t = precallTimes(now, call, 'Australia/Sydney', 12, 20, 10);
    expect(t).toHaveLength(20);
    expect(t.every((x) => x >= now + 45 * 60_000 && x <= call - 2.25 * H)).toBe(true);
    expect(t.every(inWaking)).toBe(true);
    expect(Math.min(...gaps(t))).toBeGreaterThanOrEqual(45 * 60_000);
    for (const r of [48, 24, 3]) expect(t.some((x) => Math.abs(x - (call - r * H)) < 45 * 60_000)).toBe(false);
  });

  it('a call booked for tomorrow morning still gets 10, at least 30 minutes apart, none at night', () => {
    const now = Date.parse('2026-10-13T03:00:00Z'); // Tue 14:00 Sydney
    const t = precallTimes(now, now + 20 * H, 'Australia/Sydney', 12, 20, 10);
    expect(t).toHaveLength(10);
    expect(t.every(inWaking)).toBe(true);
    expect(Math.min(...gaps(t))).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('honours the daily cap, max and 0 = off; never more than fits', () => {
    const now = Date.parse('2026-10-12T22:00:00Z');
    const capped = precallTimes(now, now + 54 * H, 'Australia/Sydney', 4, 20, 10);
    const perDay = new Map<string, number>();
    for (const x of capped) { const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(x); perDay.set(d, (perDay.get(d) ?? 0) + 1); }
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(4);
    expect(precallTimes(now, now + 10 * 86_400_000, 'Australia/Sydney', 12, 15, 10)).toHaveLength(15);
    expect(precallTimes(now, null, 'Australia/Sydney', 0)).toEqual([]);
    expect(precallTimes(now, now + 2 * H, 'Australia/Sydney', 12)).toEqual([]);
  });

  it('keeps the story in order and the most important emails when time is short', () => {
    const lead = { id: 'l', first_name: 'Dana', answers: null } as unknown as Lead;
    const full = precallPlan(lead);
    const short = precallPlan(lead, 10);
    expect(short).toHaveLength(10);
    for (const must of ['pc_josh', 'pc_seller', 'pc_walkthrough', 'pc_guarantee', 'pc_agenda', 'pc_questions', 'pp_homework', 'pc_before_call']) expect(short).toContain(must);
    expect(short[short.length - 1]).toBe('pc_before_call');
    const stages = short.map((x) => PRECALL_ARC[x].stage);
    expect([...stages].sort((a, b) => a - b)).toEqual(stages);
    expect(full.length).toBeGreaterThanOrEqual(20);
    expect(new Set(full).size).toBe(full.length);
    for (const t of full) expect(PRECALL_ARC[t]).toBeDefined();
  });

  it('has 24 distinct emails that all render, and stops once the call is near or done', () => {
    expect(new Set(PRECALL_TEMPLATES).size).toBe(30);
    const lead = { id: 'l', first_name: 'Dana', status: 'booked', booked_at: 1, booking_cancelled_at: null, call_at: Date.now() + 86_400_000 } as unknown as Lead;
    const ctx = { lead, name: 'Dana', siteName: 'G&L', link: (p: string) => `https://x${p}`, bookingUrl: 'https://cal', whatsappUrl: 'https://wa.me/1', callTime: 'Friday 10:00am' };
    const subjects = PRECALL_TEMPLATES.map((k) => {
      const c = TEMPLATES[k](ctx);
      expect(renderEmail(c, { openPixel: null, unsubscribeUrl: 'https://x/u', signature: 'Josh', address: 'WY' }).html).toContain('Dana');
      expect(c.body.join(' ')).not.toMatch(/\bfree\b.*call|call.*\bfree\b/i);
      return c.subject;
    });
    expect(new Set(subjects).size).toBe(30);
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

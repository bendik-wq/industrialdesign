import { describe, expect, it } from 'vitest';
import { cleanSequences, inTextingHours, nextTextingTime, renderSms, smsBlock, smsSegments, verifyTwilio } from '../src/integrations/sms';
import { DEFAULT_SMS_SEQUENCES } from '../src/integrations/sms-defaults';
import { callingZones } from '../src/integrations/elevenlabs';
import type { Lead } from '../src/funnel/leads';
import type { Runtime } from '../src/app';

const rt = { origin: 'https://apply.test', settings: { SALES_TIMEZONE: 'Australia/Sydney', BOOKING_URL_A: 'https://calendly.com/x', BOOKING_URL_B: '' }, reps: [] } as unknown as Runtime;
const lead = (x: Partial<Lead> = {}) => ({
  id: 'l1', first_name: 'Dana', phone: '+61412345678', call_consent_at: 1, sms_opt_out_at: null, booking_source: 'funnel', status: 'booked', booked_at: 1, booking_cancelled_at: null,
  call_at: Date.parse('2026-10-15T23:00:00Z'), timezone: 'Australia/Sydney', booking_join_url: 'https://zoom.us/j/1', booking_reschedule_url: 'https://calendly.com/reschedulings/abc', tier: 'A', tier_override: null, closer_id: null, ...x,
}) as Lead;

describe('SMS follow-up', () => {
  it('only texts people who agreed, never after STOP, never imported contacts, only countries we serve', () => {
    expect(smsBlock(lead())).toBeNull();
    expect(smsBlock(lead({ call_consent_at: null }))).toBe('no consent to text');
    expect(smsBlock(lead({ sms_opt_out_at: 5 }))).toBe('replied STOP');
    expect(smsBlock(lead({ booking_source: 'calendly-direct' }))).toBe('imported contact');
    expect(smsBlock(lead({ phone: '+882123456789' }))).toBe('number outside the countries we text');
  });

  it('texts only 8am–8pm in every zone of the number’s country', () => {
    const au = callingZones('+61412345678')!;
    expect(inTextingHours(Date.parse('2026-10-13T00:00:00Z'), au)).toBe(true);   // 11am Sydney / 8am Perth
    expect(inTextingHours(Date.parse('2026-10-12T22:00:00Z'), au)).toBe(false);  // 9am Sydney / 6am Perth
    expect(inTextingHours(Date.parse('2026-10-13T09:30:00Z'), au)).toBe(false);  // 8:30pm Sydney
    const next = nextTextingTime(Date.parse('2026-10-13T10:00:00Z'), au)!;
    expect(inTextingHours(next, au)).toBe(true);
  });

  it('short, clear texts with one tracked link and the opt-out line on the first one', () => {
    const booked = DEFAULT_SMS_SEQUENCES.find((x) => x.id === 'booked')!;
    const { body, target } = renderSms(rt, lead(), booked.steps[0], 'smabc123', true);
    expect(body).toContain('Hi Dana');
    expect(body).toContain('https://apply.test/s/smabc123');
    expect(body).toMatch(/Reply STOP to opt out\.$/);
    expect(target).toBe('https://zoom.us/j/1');
    expect(renderSms(rt, lead(), booked.steps[2], 'x1x1x1', false).target).toBe('https://calendly.com/reschedulings/abc');
    // Names that aren't names never go into a text.
    expect(renderSms(rt, lead({ first_name: 'Pay at evil.com' }), booked.steps[4], 'x2x2x2', false).body).toMatch(/there\./);
    // Every default text: no unknown tags, at most 3 segments, no "free call".
    for (const seq of DEFAULT_SMS_SEQUENCES) for (const st of seq.steps) {
      const { body } = renderSms(rt, lead({ webinar_at: Date.now() + 86_400_000, webinar_token: 'abcdefghijklmnop1234' }), st, 'sm0123456789abcdef', true);
      expect(body, `${seq.id}:${st.n}`).not.toMatch(/\{\w+\}/);
      expect(smsSegments(body), `${seq.id}:${st.n}`).toBeLessThanOrEqual(3);
      expect(body.toLowerCase()).not.toMatch(/free (strategy )?call/);
      expect(st.n).toBeLessThan(seq.next);
    }
  });

  it('accepts only valid sequences from the dashboard', () => {
    const clean = cleanSequences([
      { id: 'booked', enabled: true, steps: [{ n: 1, body: 'Hi {first_name}', anchor: 'call', offsetMin: -60, link: 'join', skip: ['confirmed', 'nonsense'] }, { n: 1, body: 'dupe' }, { n: 2, body: '' }] },
      { id: 'hack', steps: [] },
      { id: 'booked', steps: [] },
    ]);
    expect(clean).toHaveLength(1);
    expect(clean[0].steps).toEqual([{ n: 1, body: 'Hi {first_name}', anchor: 'call', offsetMin: -60, link: 'join', skip: ['confirmed'] }]);
    expect(clean[0].next).toBe(2);
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('’'.repeat(71))).toBe(2);
  });

  it('checks Twilio’s signature on replies', async () => {
    const token = 'test-token';
    const url = 'https://apply.test/hooks/twilio/sms';
    const params = { Body: 'STOP', From: '+61412345678', MessageSid: 'SM1' };
    const data = url + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join('');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)))));
    expect(await verifyTwilio(token, url, params, sig)).toBe(true);
    expect(await verifyTwilio(token, url, { ...params, Body: 'hi' }, sig)).toBe(false);
    expect(await verifyTwilio('', url, params, sig)).toBe(false);
  });
});

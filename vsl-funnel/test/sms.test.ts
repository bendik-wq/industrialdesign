import { describe, expect, it } from 'vitest';
import { SMS_SEQUENCES, SMS_TEMPLATES, buildSms, inTextingHours, nextTextingTime, smsBlock, verifyTwilio } from '../src/integrations/sms';
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
    const step = SMS_SEQUENCES.sms_booked.steps[0];
    const { body, target } = buildSms(rt, lead(), 'sms_confirm', step, 'smabc123', true);
    expect(body).toContain('Hi Dana');
    expect(body).toContain('https://apply.test/s/smabc123');
    expect(body).toMatch(/Reply STOP to opt out\.$/);
    expect(target).toBe('https://zoom.us/j/1');
    expect(buildSms(rt, lead(), 'sms_24h', SMS_SEQUENCES.sms_booked.steps[1], 'x1x1x1', false).target).toBe('https://calendly.com/reschedulings/abc');
    // Names that aren't names never go into a text.
    expect(buildSms(rt, lead({ first_name: 'Pay at evil.com' }), 'sms_1h', SMS_SEQUENCES.sms_booked.steps[2], 'x2x2x2', false).body).toMatch(/^there,/);
    for (const [k, t] of Object.entries(SMS_TEMPLATES)) {
      const text = t({ name: 'Alexandra', time: 'Thursday 16 October, 10:00 am AEDT', link: 'https://apply.grosfjeld-li.com/s/sm0123456789abcdef' });
      expect(text.length, k).toBeLessThanOrEqual(306); // ≤ 2 SMS segments
      expect(text.toLowerCase(), k).not.toMatch(/free (strategy )?call/);
    }
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

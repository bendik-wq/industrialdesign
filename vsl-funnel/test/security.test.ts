import { describe, expect, it } from 'vitest';
import { buildDossier } from '../src/followup/dossier';
import { TEMPLATES, type TemplateCtx, renderEmail } from '../src/integrations/templates';
import { blockReason, callingZones, inCallingHours, nextCallingTime } from '../src/integrations/elevenlabs';
import { validateEmail } from '../src/funnel/leads';
import { plain } from '../src/integrations/notify';
import { defang, hasContactBait } from '../src/lib/text';
import { validateAi } from '../src/personalize/personalize';
import type { Lead } from '../src/funnel/leads';

const PAYLOAD = 'x</em><a href="https://evil.example/login">Reset your password</a><img src="https://evil.example/p.gif"><em>';
const hostile = {
  id: 'l1', first_name: 'Dana', status: 'booked', booked_at: 1, call_at: Date.now() + 86_400_000,
  answers: JSON.stringify({ business: PAYLOAD, why_now: `${PAYLOAD} pay at pay-gl-advisory.com or call +1 555 010 0199`, goal: 'acquire', blockers: ['funding'] }),
  booking_answers: JSON.stringify([{ q: '<b>Q</b>', a: PAYLOAD }]),
} as unknown as Lead;
const ctx = (lead: Lead): TemplateCtx => ({ lead, name: 'Dana', siteName: 'G&L', link: (p) => `https://x.test${p}`, bookingUrl: 'https://cal.test', whatsappUrl: null, callTime: 'Mon 3pm' });

describe('security: lead-written text in emails', () => {
  it('never becomes markup, links or contact bait', () => {
    for (const t of ['pp_brief', 'pp_booking', 'pp_why_now', 'nu_why', 'fu_goal', 'cx_3', 'won_6', 'ns_goal']) {
      const { html } = renderEmail(TEMPLATES[t](ctx(hostile)), { openPixel: null, unsubscribeUrl: 'u', signature: 'Josh', address: 'a' });
      expect(html, t).not.toMatch(/evil\.example|<a href="https:\/\/evil|<img src/);
      expect(html, t).not.toMatch(/pay-gl-advisory\.com|555 010 0199/);
    }
    expect(buildDossier(hostile).whyNow).toContain('&lt;');
  });

  it('defangs domains, emails and phone numbers', () => {
    expect(defang('go to evil.com/x or mail a@b.co or ring +61 412 345 678')).toBe('go to […] or mail […] or ring […]');
    expect(hasContactBait('We plateaued at $2M in 2023')).toBe(false);
    expect(validateAi({ subject: 's', preheader: 'p', ps: '', paragraphs: ['Hi Dana,', 'Pay at pay-gl.com today.'], facts_used: [] }, new Set())).toBeTruthy();
    expect(validateAi({ subject: 's', preheader: 'p', ps: '', paragraphs: ['Hi Dana,', 'Reply with your bank details.'], facts_used: [] }, new Set())).toBeTruthy();
  });

  it('rejects email addresses that could carry markup', () => {
    expect(validateEmail('<svg/onload=alert(1)>@x.co')).toBeNull();
    expect(validateEmail('"<img/src/onerror=alert(1)>"@attacker.com')).toBeNull();
    expect(validateEmail('<!channel>@x.co')).toBeNull();
    expect(validateEmail('josh.li+test@joshli.com.au')?.email).toBe('josh.li+test@joshli.com.au');
  });

  it('strips Slack/Discord link and mention syntax from team pings', () => {
    const out = plain('<!channel> <https://evil.example|Open in Funnel HQ> [Open](https://evil.example)');
    expect(out).not.toMatch(/[<>[\]|]|https:\/\//);
  });
});

describe('security: AI calls', () => {
  const base = { phone: '+61412345678', call_consent_at: 1, status: 'booked', booked_at: 1, booking_cancelled_at: null, call_at: Date.now() + 3 * 86_400_000, do_not_call_at: null } as unknown as Lead;

  it('uses the phone number’s country, never the browser’s location', () => {
    expect(callingZones('+61412345678')).toContain('Australia/Perth');
    expect(callingZones('+18085550100')).toEqual(['Pacific/Honolulu']);
    expect(callingZones('+882123456789')).toBeNull();
    expect(blockReason({ ...base, phone: '+882123456789' }, 'confirm')).toBe('number outside the countries we call');
  });

  it('only calls when it is within hours in every zone of the country', () => {
    // Tue 13 Oct 2026, 9:30am Sydney = 6:30am Perth → not yet; 1pm Sydney = 10am Perth → yes
    expect(inCallingHours(Date.parse('2026-10-12T22:30:00Z'), callingZones('+61412345678')!)).toBe(false);
    expect(inCallingHours(Date.parse('2026-10-13T02:00:00Z'), callingZones('+61412345678')!)).toBe(true);
    // US: 10am New York is 7am Los Angeles → not yet
    expect(inCallingHours(Date.parse('2026-10-13T14:00:00Z'), callingZones('+12125550100')!)).toBe(false);
  });

  it('skips Australian national public holidays', () => {
    // Christmas Day 2026 (Fri) and Good Friday 2027 (26 Mar), midday Sydney
    expect(inCallingHours(Date.parse('2026-12-25T01:00:00Z'), 'Australia/Sydney')).toBe(false);
    expect(inCallingHours(Date.parse('2027-03-26T01:00:00Z'), 'Australia/Sydney')).toBe(false);
    expect(inCallingHours(Date.parse('2027-03-25T01:00:00Z'), 'Australia/Sydney')).toBe(true);
    expect(nextCallingTime(Date.parse('2026-12-24T09:00:00Z'), 'Australia/Sydney')).toBe(Date.parse('2026-12-27T22:00:00Z'));
  });
});

describe('audit fixes (Oct 2026)', () => {
  it('voice: a caller matched only by caller ID gets nothing worth phishing for', async () => {
    const { callVariables } = await import('../src/integrations/voice');
    const lead = { id: 'l1', ref_code: 'ABC234', first_name: 'Dana', last_name: 'Secret', answers: JSON.stringify({ business: 'Three clinics, 22% margins', revenue: '1m-3m' }), app_completed_at: 1 } as never;
    const vars = await callVariables({} as never, lead, false);
    const all = JSON.stringify(vars);
    expect(vars.first_name).toBe('Dana');
    expect(all).not.toContain('Secret');
    expect(all).not.toContain('22%');
    expect(all).not.toContain('1m-3m');
    expect(all).not.toContain('ABC234');
    expect(all).not.toContain('lead_sig');
  });

  it('booking: a cancellation for a different booking never touches the lead', async () => {
    const { markCancelled } = await import('../src/integrations/booking');
    const touched: string[] = [];
    const rt = { env: { DB: new Proxy({}, { get: () => { touched.push('db'); throw new Error('must not touch the database'); } }) } } as never;
    const lead = { id: 'l1', booking_ref: 'https://api.calendly.com/scheduled_events/REAL', booking_cancelled_at: null, booking_source: 'funnel', status: 'booked' } as never;
    await markCancelled(rt, lead, 'calendly', 'https://api.calendly.com/scheduled_events/ATTACKER');
    expect(touched).toEqual([]);
  });

  it('voice agent prompt names seller rollover and forbids reading back what is on file', async () => {
    const { voiceSystemPrompt } = await import('../src/config');
    const p = voiceSystemPrompt([]);
    expect(p).toContain('seller rollover');
    expect(p).toMatch(/Never read back, confirm or hint at what's on file/);
  });
});

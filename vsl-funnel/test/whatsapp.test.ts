import { describe, expect, it } from 'vitest';
import { cleanSequences, smsBlock, waOk, waTemplateParams, waTemplateText } from '../src/integrations/sms';
import { DEFAULT_SMS_SEQUENCES } from '../src/integrations/sms-defaults';
import type { Lead } from '../src/funnel/leads';

const lead = (x: Partial<Lead> = {}) => ({ id: 'l1', first_name: 'Dana', phone: '+61412345678', call_consent_at: null, sms_consent_at: null, wa_consent_at: null, whatsapp_connected_at: null, sms_opt_out_at: null, booking_source: 'funnel', ...x }) as Lead;

describe('WhatsApp follow-up', () => {
  it('needs WhatsApp consent or a chat they started; STOP covers both channels', () => {
    expect(smsBlock(lead())).toBe('no consent to text');
    expect(smsBlock(lead({ wa_consent_at: 1 }))).toBeNull();
    expect(waOk(lead({ whatsapp_connected_at: 1 }))).toBe(true);
    expect(waOk(lead({ call_consent_at: 1 }))).toBe(false); // older consent wording didn't name WhatsApp
    expect(smsBlock(lead({ wa_consent_at: 1, sms_opt_out_at: 2 }))).toBe('replied STOP');
  });

  it('turns a text into a Meta template with numbered variables, never at the start or end', () => {
    const st = { body: '{first_name}, your call with {closer} is at {call_time}.', link: 'join' as const };
    const t = waTemplateText(st);
    expect(t).toBe('Hi {{1}}, your call with {{2}} is at {{3}}. {{4}}\n\n- G&L');
    expect(waTemplateParams(st, { first_name: 'Dana', closer: 'Josh', call_time: 'Thu 10am', link: 'https://x/s/1' })).toEqual(['Dana', 'Josh', 'Thu 10am', 'https://x/s/1']);
    for (const seq of DEFAULT_SMS_SEQUENCES) for (const s of seq.steps) {
      const tpl = waTemplateText(s);
      expect(tpl).not.toMatch(/^\{\{|\}\}[.!?]?$/);
      expect(tpl).not.toMatch(/\{\w+\}(?!\})/);
    }
  });

  it('keeps the channel and a valid template name from the dashboard', () => {
    const [seq] = cleanSequences([{ id: 'booked', channel: 'whatsapp', steps: [{ n: 1, body: 'Hi', wa: 'gl_booked_1' }, { n: 2, body: 'Yo', wa: 'Bad Name!' }] }]);
    expect(seq.channel).toBe('whatsapp');
    expect(seq.steps[0].wa).toBe('gl_booked_1');
    expect(seq.steps[1].wa).toBeUndefined();
    expect(cleanSequences([{ id: 'booked', channel: 'pigeon', steps: [] }])[0].channel).toBe('sms');
  });
});

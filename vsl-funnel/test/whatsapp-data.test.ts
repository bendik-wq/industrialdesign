import { describe, expect, it } from 'vitest';
import { cleanSequences, smsBlock, waOk, waTemplateParams, waTemplateText } from '../src/integrations/sms';
import { DEFAULT_SMS_SEQUENCES } from '../src/integrations/sms-defaults';
import { videoEmbed } from '../src/data/data';
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

describe('Data page', () => {
  it('embeds YouTube / Vimeo / Loom and escapes anything else', () => {
    expect(videoEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(videoEmbed('https://vimeo.com/123456789')).toContain('player.vimeo.com/video/123456789');
    expect(videoEmbed('https://www.loom.com/share/0123456789abcdef0123456789abcdef')).toContain('loom.com/embed/');
    expect(videoEmbed('https://cdn.x/v.mp4"><script>')).not.toContain('<script>');
    expect(videoEmbed('')).toBe('');
  });
});

describe('Data page headline test', async () => {
  const { DATA_HEADLINES, pickHeadline } = await import('../src/data/data');
  it('is stable per visitor, spreads visitors across headlines, and can be forced for preview', () => {
    expect(pickHeadline('v_abc').id).toBe(pickHeadline('v_abc').id);
    const seen = new Set(Array.from({ length: 200 }, (_, i) => pickHeadline(`v_${i}`).id));
    expect(seen.size).toBe(DATA_HEADLINES.length);
    expect(pickHeadline('v_abc', 'debt').id).toBe('debt');
    expect(pickHeadline('v_abc', '<script>').id).toBe(pickHeadline('v_abc').id);
    for (const h of DATA_HEADLINES) expect(h.h1 + h.lede).not.toMatch(/free|guarantee/i);
  });
});

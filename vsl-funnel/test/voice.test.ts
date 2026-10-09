import { describe, expect, it } from 'vitest';
import { STRUCTURED_SCHEMA, answersFromCall, buildAssistant, verifyVapi } from '../src/integrations/voice';
import { APPLICATION, FAQS, voiceSystemPrompt } from '../src/config';
import type { Runtime } from '../src/app';
import type { Settings } from '../src/settings';

const settings = (over: Partial<Settings> = {}) => ({ VOICE_MODEL: '', VOICE_VOICE: '', VOICE_WEBHOOK_SECRET: 's3cret-value', ...over }) as Settings;
const rt = (over: Partial<Settings> = {}) => ({ settings: settings(over), origin: 'https://apply.example.com' }) as unknown as Runtime;

describe('voice agent', () => {
  it('only accepts webhooks carrying the exact shared secret', () => {
    expect(verifyVapi(settings(), 's3cret-value')).toBe(true);
    expect(verifyVapi(settings(), 's3cret-valuX')).toBe(false);
    expect(verifyVapi(settings(), undefined)).toBe(false);
    expect(verifyVapi(settings({ VOICE_WEBHOOK_SECRET: '' }), '')).toBe(false);
  });

  it('builds an inbound assistant that discloses AI + recording and posts back to our webhook', () => {
    const a = buildAssistant(rt({ VOICE_MODEL: 'anthropic:claude-x', VOICE_VOICE: '11labs:abc' }));
    expect(a.firstMessage).toMatch(/I’m an AI/);
    expect(a.firstMessage).toMatch(/recorded/);
    expect(a.model).toMatchObject({ provider: 'anthropic', model: 'claude-x' });
    expect(a.voice).toEqual({ provider: '11labs', voiceId: 'abc' });
    expect(a.server).toEqual({ url: 'https://apply.example.com/hooks/voice', headers: { 'x-vapi-secret': 's3cret-value' } });
    expect(a.model.tools.map((t) => t.function.name)).toEqual(['send_booking_link', 'do_not_contact']);
  });

  it('falls back to sensible model and voice defaults', () => {
    const a = buildAssistant(rt());
    expect(a.model).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
    expect(a.voice).toEqual({ provider: 'vapi', voiceId: 'Elliot' });
  });

  it('positions the offer as done-with-you and bans advice and outbound', () => {
    const p = voiceSystemPrompt(FAQS);
    expect(p).toMatch(/DONE WITH YOU, not done for you/);
    expect(p).toMatch(/No financial, legal, tax or lending advice/);
    expect(p).toMatch(/do_not_contact/);
  });

  it('structured-data enums match the application options exactly', () => {
    for (const id of ['role', 'revenue', 'profit', 'timeline'] as const) {
      const q = APPLICATION.find((x) => x.id === id)!;
      expect('options' in q && q.options.map((o) => o.value)).toEqual(STRUCTURED_SCHEMA.properties[id].enum);
    }
  });

  it('maps call answers onto the application without overwriting what the lead already answered', () => {
    const out = answersFromCall({ revenue: '3_10m', profit: 'not-an-option', timeline: '0_6', business: 'Commercial HVAC, 25 staff', role: 'owner' }, { role: 'co_owner' });
    expect(out).toEqual({ revenue: '3_10m', timeline: '0_6', business: 'Commercial HVAC, 25 staff' });
  });
});

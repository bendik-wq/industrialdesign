import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { blockReason, buildAgent, dial, factsFrom, inCallingHours, nextCallingTime, provisionAgent, verifyElevenSignature } from '../src/integrations/elevenlabs';
import { hmacHex } from '../src/lib/crypto';
import type { Lead } from '../src/funnel/leads';
import type { Settings } from '../src/settings';

const S = (o: Partial<Settings> = {}) => ({ ELEVENLABS_API_KEY: 'sk_test', ELEVENLABS_AGENT_ID: '', ELEVENLABS_PHONE_NUMBER_ID: 'ph_1', ELEVENLABS_VOICE_ID: '', ELEVENLABS_LLM: '', SALES_TIMEZONE: 'Australia/Sydney', ...o }) as Settings;
const rt = (o: Partial<Settings> = {}) => ({ settings: S(o), reps: [{ id: 'josh', name: 'Josh Li', role: 'closer', active: 1 }], origin: 'https://x' }) as unknown as Runtime;
const lead = (o: Partial<Lead> = {}) => ({
  id: 'l1', ref_code: 'ABC123', first_name: 'Dana', email: 'dana@co.com', phone: '+61412345678', status: 'booked', booked_at: 1, booking_cancelled_at: null,
  call_at: Date.now() + 2 * 86_400_000, tier: 'A', tier_override: null, closer_id: 'josh', call_consent_at: 1, do_not_call_at: null, answers: '{"business":"HVAC"}', timezone: 'Australia/Sydney', country: 'AU', ...o,
}) as unknown as Lead;

describe('AI outbound calls', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('only calls inside local calling hours (Mon–Fri 9–8, Sat 9–5, never Sunday)', () => {
    const syd = (iso: string) => Date.parse(iso); // AEDT = UTC+11 in October
    expect(inCallingHours(syd('2026-10-12T23:00:00Z'), 'Australia/Sydney')).toBe(true);   // Tue 10:00
    expect(inCallingHours(syd('2026-10-13T09:30:00Z'), 'Australia/Sydney')).toBe(false);  // Tue 20:30
    expect(inCallingHours(syd('2026-10-17T05:00:00Z'), 'Australia/Sydney')).toBe(true);   // Sat 16:00
    expect(inCallingHours(syd('2026-10-17T07:00:00Z'), 'Australia/Sydney')).toBe(false);  // Sat 18:00
    expect(inCallingHours(syd('2026-10-17T23:00:00Z'), 'Australia/Sydney')).toBe(false);  // Sun 10:00
    // Saturday 6pm → next slot is Monday 9am
    expect(new Date(nextCallingTime(syd('2026-10-17T07:00:00Z'), 'Australia/Sydney')!).toISOString()).toBe('2026-10-18T22:00:00.000Z');
  });

  it('never calls without consent, after an opt-out, or when no longer relevant', () => {
    expect(blockReason(lead(), 'confirm')).toBeNull();
    expect(blockReason(lead({ call_consent_at: null }), 'confirm')).toBe('no call consent');
    expect(blockReason(lead({ do_not_call_at: 5 }), 'confirm')).toBe('asked not to be called');
    expect(blockReason(lead({ booking_cancelled_at: 5 }), 'confirm')).toBe('no longer booked');
    expect(blockReason(lead({ call_at: Date.now() + 10 * 60_000 }), 'confirm')).toBe('call is too soon');
    expect(blockReason(lead(), 'speed_to_lead')).toBe('already booked');
    expect(blockReason(lead({ status: 'applied', booked_at: null, tier: 'C' }), 'speed_to_lead')).toBe('not qualified');
    expect(blockReason(lead({ status: 'applied', booked_at: null }), 'speed_to_lead')).toBeNull();
  });

  it('verifies ElevenLabs webhook signatures', async () => {
    const t = Math.floor(Date.now() / 1000);
    const body = '{"type":"post_call_transcription"}';
    const sig = `t=${t},v0=${await hmacHex('whsec', `${t}.${body}`)}`;
    expect(await verifyElevenSignature('whsec', body, sig)).toBe(true);
    expect(await verifyElevenSignature('whsec', body + ' ', sig)).toBe(false);
    expect(await verifyElevenSignature('other', body, sig)).toBe(false);
    expect(await verifyElevenSignature('whsec', body, `t=${t - 3600},v0=${await hmacHex('whsec', `${t - 3600}.${body}`)}`)).toBe(false);
  });

  it('reads the data collected on the call', () => {
    expect(factsFrom({ analysis: { data_collection_results: { appointment_confirmed: { value: true }, do_not_call: { value: 'false' }, questions: { value: 'Is it remote?' }, junk: { value: 1 } } } }))
      .toEqual({ appointment_confirmed: true, do_not_call: false, questions: 'Is it remote?' });
  });

  it('builds an agent that discloses AI + recording and ends calls', () => {
    const a = buildAgent(S({ ELEVENLABS_VOICE_ID: 'v1', ELEVENLABS_LLM: 'gpt-4o' }));
    expect(a.conversation_config.agent.first_message).toMatch(/I’m an AI and this call is recorded/);
    expect(a.conversation_config.agent.prompt.prompt).toMatch(/Never call the strategy call free/);
    expect(a.conversation_config.agent.prompt.llm).toBe('gpt-4o');
    expect(a.conversation_config.tts).toEqual({ voice_id: 'v1' });
    expect(Object.keys(a.platform_settings.data_collection)).toContain('do_not_call');
  });

  it('creates the agent, falling back to a lean config if the API rejects optional fields', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      bodies.push({ url, body: JSON.parse(String(init.body)), key: (init.headers as Record<string, string>)['xi-api-key'] });
      return bodies.length === 1 ? new Response('{"detail":[]}', { status: 422 }) : new Response('{"agent_id":"agent_123"}');
    }));
    expect(await provisionAgent(rt())).toEqual({ id: 'agent_123', created: true });
    expect(bodies[0].url).toBe('https://api.elevenlabs.io/v1/convai/agents/create');
    expect(bodies[0].key).toBe('sk_test');
    expect(bodies[1].body.conversation_config.agent.prompt.built_in_tools).toBeUndefined();
  });

  it('dials with the lead’s details as dynamic variables', async () => {
    let sent: any;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { sent = { url, body: JSON.parse(String(init.body)) }; return new Response('{"success":true,"message":"ok","conversation_id":"conv_1","callSid":"CA1"}'); }));
    const r = await dial(rt({ ELEVENLABS_AGENT_ID: 'agent_1' }), lead(), 'confirm', 'twilio');
    expect(r).toEqual({ conversationId: 'conv_1', callSid: 'CA1' });
    expect(sent.url).toMatch(/\/v1\/convai\/twilio\/outbound-call$/);
    expect(sent.body).toMatchObject({ agent_id: 'agent_1', agent_phone_number_id: 'ph_1', to_number: '+61412345678' });
    const v = sent.body.conversation_initiation_client_data.dynamic_variables;
    expect(v).toMatchObject({ first_name: 'Dana', call_kind: 'confirm', closer_name: 'Josh Li', business: 'HVAC', lead_ref: 'ABC123' });
    expect(v.opening).toMatch(/strategy call you just booked for/);
  });
});

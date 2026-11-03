import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIOS, VOICE_DEMO_CSP, isDemoConversation, voiceDemoPage } from '../src/admin/voice-demo';
import { auditCopy } from '../src/content/copy-rules';
import type { Settings } from '../src/settings';

describe('Talk to an agent (demo)', () => {
  const s = { AI_CALL_CALLBACK_NUMBER: '+1 737 537 1215' } as unknown as Settings;
  // A stand-in database: the webinar builder looks up recent emails, room notes and the call config.
  const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) };
  const rt = { settings: { ...s, WEBINAR_PASS: 'off', SALES_TIMEZONE: 'Australia/Sydney' }, env: { DB: { prepare: () => stmt } }, origin: 'https://apply.test' } as never;
  it('every scenario is tagged as a demo, so the post-call webhook skips it', async () => {
    for (const sc of DEMO_SCENARIOS) expect((await sc.vars(s, rt)).demo).toBe('yes');
    expect(isDemoConversation({ conversation_initiation_client_data: { dynamic_variables: { demo: 'yes' } } })).toBe(true);
    expect(isDemoConversation({ conversation_initiation_client_data: { dynamic_variables: { first_name: 'Dana' } } })).toBe(false);
    expect(isDemoConversation(undefined)).toBe(false);
  });
  it('the page allows only our scripts, the microphone path and ElevenLabs', () => {
    expect(VOICE_DEMO_CSP).toMatch(/script-src 'self' blob:/);
    expect(VOICE_DEMO_CSP).toMatch(/connect-src 'self' wss:\/\/api\.elevenlabs\.io/);
    expect(VOICE_DEMO_CSP).toMatch(/frame-ancestors 'none'/);
    expect(voiceDemoPage()).toMatch(/Nobody is called/);
  });
  it('webinar scenarios get the real webinar call details (script, offer facts with all three funding parts)', async () => {
    const pre = await DEMO_SCENARIOS.find((x) => x.id === 'webinar_pre')!.vars(s, rt);
    expect(pre).toMatchObject({ first_name: 'Dana', event_title: 'Buy your first competitor', flow_label: 'Day-before reminder' });
    expect(pre.script).toMatch(/tomorrow/);
    const post = await DEMO_SCENARIOS.find((x) => x.id === 'webinar_nobuy')!.vars(s, rt);
    expect(post.offer_facts).toMatch(/seller rollover/);
    expect(post.close_time).not.toBe('not set');
  });
  it('copy passes the house rules', () => {
    for (const sc of DEMO_SCENARIOS) for (const t of [sc.label, sc.blurb, sc.you]) expect(auditCopy(t)).toEqual([]);
  });
});

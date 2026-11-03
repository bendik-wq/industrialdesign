import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIOS, VOICE_DEMO_CSP, isDemoConversation, voiceDemoPage } from '../src/admin/voice-demo';
import { auditCopy } from '../src/content/copy-rules';
import type { Settings } from '../src/settings';

describe('Talk to an agent (demo)', () => {
  const s = { AI_CALL_CALLBACK_NUMBER: '+1 737 537 1215' } as unknown as Settings;
  it('every scenario is tagged as a demo, so the post-call webhook skips it', () => {
    for (const sc of DEMO_SCENARIOS) expect(sc.vars(s).demo).toBe('yes');
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
  it('copy passes the house rules', () => {
    for (const sc of DEMO_SCENARIOS) for (const t of [sc.label, sc.blurb, sc.you]) expect(auditCopy(t)).toEqual([]);
  });
});

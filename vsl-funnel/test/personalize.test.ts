import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiPersonalize, personalizeEmail, pickFacts, rulesPersonalize, secondPerson, validateAi } from '../src/personalize/personalize';
import type { Fact, Profile } from '../src/personalize/profile';
import type { Settings } from '../src/settings';

const f = (key: string, text: string, weight: number, topics: string[] = [], you?: string): Fact => ({ key, text, weight, topics, you });
const profile: Profile = {
  name: 'Dana',
  tier: 'A',
  data: {},
  facts: [
    f('a_why_now', 'In their own words, why now: “We want to buy two competitors in Sydney this year”.', 10, ['competition'], 'You told me why now: “We want to buy two competitors in Sydney this year.”'),
    f('v_vsl-main_stop', 'Watched 43% of the main video and stopped at 5:31, right around how the deal gets funded.', 8, ['funding'], 'You got about 40% of the way through the video, right up to how the deal gets funded.'),
    f('faq', 'Opened these questions in the FAQ: “Do I really put no money down?”.', 9, ['funding'], 'You were wondering: “Do I really put no money down?”'),
    f('copied', 'Copied this text from the page: “Seller finance…”.', 7, ['funding']),
    f('a_business', 'Their business: Commercial HVAC, 25 staff.', 7),
  ],
};
const content = { subject: 'why your own cash is the expensive way', preheader: 'x', body: ['Dana,', 'Most owners assume…', 'We do it differently.'], cta: { label: 'Watch →', href: '__LINK_0__' }, ps: '<a href="__LINK_1__">WhatsApp</a>' };
const S = (o: Partial<Settings> = {}) => ({ EMAIL_PERSONALIZE: '', ANTHROPIC_API_KEY: '', EMAIL_AI_MODEL: '', ...o }) as Settings;

describe('email personalisation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('only says facts to the lead that read naturally', () => {
    expect(secondPerson(profile.facts[1])).toMatch(/^You got about 40% of the way through the video/);
    expect(secondPerson(profile.facts[3])).toBeNull(); // copied text: never quoted back at them
    expect(secondPerson(profile.facts[4])).toBeNull();
  });

  it('prefers facts matching the email’s topic and never repeats used ones', () => {
    expect(pickFacts(profile.facts, 'pc_own_cash', new Set(), 2).map((x) => x.key)).toEqual(['faq', 'v_vsl-main_stop']);
    expect(pickFacts(profile.facts, 'pc_own_cash', new Set(['faq']), 1).map((x) => x.key)).toEqual(['v_vsl-main_stop']);
  });

  it('rules mode adds a personal line after the greeting and records the fact', () => {
    const r = rulesPersonalize(content, 'pc_own_cash', profile, new Set(['faq']));
    expect(r.content.body[0]).toBe('Dana,');
    expect(r.content.body[1]).toMatch(/^You got about 40% of the way through the video.*So this one is about the money side\.$/);
    expect(r.factsUsed).toEqual(['v_vsl-main_stop']);
    expect(r.content.cta).toEqual(content.cta);
  });

  it('rejects model output that breaks the rules', () => {
    const ok = { subject: 'the part you missed', preheader: 'p', paragraphs: ['Dana,', 'You stopped right before the funding part.'], ps: '', facts_used: ['faq'] };
    const keys = new Set(['faq']);
    expect(validateAi(ok, keys)).toBeNull();
    expect(validateAi({ ...ok, paragraphs: ['Dana,', 'Book your free strategy call.'] }, keys)).toBe('calls the call free');
    expect(validateAi({ ...ok, paragraphs: ['Dana,', 'see https://x.com'] }, keys)).toBe('contains links or html');
    expect(validateAi({ ...ok, facts_used: ['made_up'] }, keys)).toBe('unknown fact key');
    expect(validateAi({ ...ok, paragraphs: ['Dana,', 'This is huge!'] }, keys)).toBe('exclamation');
  });

  it('ai mode sends facts (never links) to Claude and keeps the CTA and linked P.S.', async () => {
    let sent: any;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init.body)), headers: init.headers };
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'text', text: JSON.stringify({ subject: 'the funding part you skipped', preheader: 'two minutes', paragraphs: ['Dana,', 'You asked whether you really put no money down.', 'Here’s how.'], ps: '', facts_used: ['faq'] }) }],
      }), { headers: { 'content-type': 'application/json' } });
    }));
    const r = await aiPersonalize(S({ ANTHROPIC_API_KEY: 'sk-ant-test' }), content, 'pc_own_cash', profile, new Set(), { purpose: 'pre-call', callTime: null });
    expect(sent.url).toMatch(/\/v1\/messages/);
    expect(sent.body.model).toBe('claude-opus-5-5');
    expect(sent.body.fallbacks).toBe('default');
    expect(sent.body.output_config.format.type).toBe('json_schema');
    expect(JSON.stringify(sent.body.messages)).not.toContain('__LINK_');
    expect(r.mode).toBe('ai');
    expect(r.content.subject).toBe('the funding part you skipped');
    expect(r.content.cta).toEqual(content.cta);
    expect(r.content.ps).toBe(content.ps);
    expect(r.factsUsed).toEqual(['faq']);
  });

  it('falls back to the rules line if the model fails, and does nothing when off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"type":"error","error":{"type":"overloaded_error","message":"x"}}', { status: 529 })));
    const r = await personalizeEmail(S({ ANTHROPIC_API_KEY: 'sk-ant-test' }), content, 'pc_own_cash', profile, new Set(), { purpose: 'x', callTime: null });
    expect(r.mode).toBe('fallback');
    expect(r.content.body[1]).toMatch(/^You /);
    const off = await personalizeEmail(S({ EMAIL_PERSONALIZE: 'off' }), content, 'pc_own_cash', profile, new Set(), { purpose: 'x', callTime: null });
    expect(off.content).toBe(content);
  });
});

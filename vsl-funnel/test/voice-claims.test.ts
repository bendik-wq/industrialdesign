import { describe, expect, it } from 'vitest';
import { FAQS, inboundCallbackPrompt, outboundSystemPrompt, voiceFaqs, voiceSystemPrompt } from '../src/config';

describe('voice agents: aims, never promises', () => {
  const prompts = { outbound: outboundSystemPrompt(FAQS), inbound: inboundCallbackPrompt(FAQS), voice: voiceSystemPrompt(FAQS) };
  for (const [name, p] of Object.entries(prompts)) {
    it(`${name}: no promise wording, funding named in full, rules present`, () => {
      expect(p).not.toMatch(/doubles or triples their business, structured with no money down/);
      expect(p).not.toMatch(/the deal is over-financed|and over-financed/i);
      expect(p).toMatch(/seller rollover/);
      expect(p).toMatch(/Never promise results/);
      expect(p).toMatch(/Never promise a specific callback day or time/);
      expect(p).not.toMatch(/(about )?as big as their business or bigger|as big as yours, or bigger/);
    });
  }
  it('the voice FAQ softens "no money down" and keeps the rest of the site FAQ', () => {
    const v = voiceFaqs(FAQS);
    expect(v).toHaveLength(FAQS.length);
    const nmd = v.find((f) => /no money down/i.test(f.q))!;
    expect(nmd.a).toMatch(/aims for/); expect(nmd.a).not.toMatch(/over-financed/);
    expect(FAQS.find((f) => /no money down/i.test(f.q))!.a).toMatch(/over-financed/); // site copy unchanged
  });
});

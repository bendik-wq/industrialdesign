import { describe, expect, it } from 'vitest';
import { relevantTo } from '../src/radar/engine';

// Real titles from the first live run (2026-11-05): Instagram's reel search returns viral posts unrelated to the query.
const kw = ['business acquisition', 'buy a business no money down', 'seller financing', 'roll up strategy'];
describe('radar relevance', () => {
  it('keeps business content and drops unrelated viral posts', () => {
    for (const t of ['How Private Equity Killed Fast Food', 'I bought a laundromat! How much $$$ did we make', '8 Entrepreneurs Compete For $100,000', 'Why start a business when you can buy one?', 'The Roll-up strategy. Private equity professionals'])
      expect(relevantTo(t, kw), t).toBe(true);
    for (const t of ['Do these as much as you can if you want a better life', 'what other hacks do you use? #cleaning', 'Tiny Changes, Different Coffee', ''])
      expect(relevantTo(t, kw), t).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { isShortUrl } from '../src/funnel/pages';
import { HEADLINE_EXPERIMENT } from '../src/config';
import { INDUSTRIES } from '../src/landers/catalog';
import { DATA_HEADLINES } from '../src/data/data';

describe('short URLs for split-test pages', () => {
  it('gives every main headline, industry and lander its own URL', () => {
    for (const v of HEADLINE_EXPERIMENT.variants) expect(isShortUrl('main', v.slug)).toBe(true);
    for (const i of INDUSTRIES) {
      expect(isShortUrl('main', i.id)).toBe(true);
      expect(isShortUrl('main', i.id, 'competitor')).toBe(true);
    }
    for (const h of DATA_HEADLINES) expect(isShortUrl('data', h.id)).toBe(true);
  });
  it('rejects unknown paths and wrong hosts', () => {
    expect(isShortUrl('main', 'wp-login')).toBe(false);
    expect(isShortUrl('main', 'dental', 'nope')).toBe(false);
    expect(isShortUrl('main', 'recap')).toBe(false);
    expect(isShortUrl('data', 'dental')).toBe(false);
    expect(isShortUrl('webinar', 'dental')).toBe(false);
  });
  it('never collides with a real route or with each other', () => {
    const reserved = ['apply', 'book', 'breakout', 'resources', 'privacy', 'data', 'webinar', 'health', 'm', 'admin', 'api', 'hooks', 'ph', 'media', 'assets', 'go', 'w', 'r', 'o', 'u', 's', 'l'];
    const slugs = [...HEADLINE_EXPERIMENT.variants.map((v) => v.slug), ...INDUSTRIES.map((i) => i.id)];
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(reserved).not.toContain(s);
  });
});

import { describe, expect, it } from 'vitest';
import { classifyChannel, touchFromUrl } from '../src/lib/attribution';

const touch = (qs: string, ref: string | null = null) => touchFromUrl(new URL(`https://apply.example.com/${qs}`), ref, 'apply.example.com');

describe('touchFromUrl', () => {
  it('classifies paid Facebook traffic from UTMs', () => {
    const t = touch('?utm_source=facebook&utm_medium=paid&utm_campaign=c1&utm_content=ad1&fbclid=abc&ad_id=99');
    expect(t).toMatchObject({ channel: 'Paid Social', source: 'facebook', campaign: 'c1', content: 'ad1', clickType: 'fbclid', clickId: 'abc', adId: '99' });
  });
  it('does not treat a bare fbclid as paid (Meta adds it to organic clicks too)', () => {
    expect(touch('?fbclid=abc').channel).toBe('Organic Social');
  });
  it('treats gclid as paid search', () => {
    expect(touch('?gclid=xyz').channel).toBe('Paid Search');
  });
  it('detects organic search and referrals from the referrer', () => {
    expect(touch('', 'https://www.google.com/').channel).toBe('Organic Search');
    expect(touch('', 'https://blog.someone.com/post').channel).toBe('Referral');
    expect(touch('', 'https://l.instagram.com/').channel).toBe('Organic Social');
  });
  it('ignores self-referrals', () => {
    expect(touch('', 'https://apply.example.com/apply').channel).toBe('Direct');
  });
  it('does not mistake look-alike hosts for social networks', () => {
    expect(classifyChannel('accept.com', 'referral', 'accept.com', false)).toBe('Referral');
  });
  it('classifies email and video', () => {
    expect(touch('?utm_source=newsletter&utm_medium=email').channel).toBe('Email');
    expect(touch('?utm_source=youtube&utm_medium=cpc').channel).toBe('Paid Video');
  });
});

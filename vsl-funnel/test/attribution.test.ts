import { describe, expect, it } from 'vitest';
import { classifyChannel, platformOf, touchFromUrl } from '../src/lib/attribution';

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

describe('in-app browsers and platform names', () => {
  const IG = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0.0';
  it('an Instagram bio tap with no referrer is Instagram, not Direct', () => {
    const t = touchFromUrl(new URL('https://apply.example.com/'), null, 'apply.example.com', IG);
    expect(t).toMatchObject({ channel: 'Organic Social', source: 'instagram' });
  });
  it('UTMs still win over the in-app guess', () => {
    const t = touchFromUrl(new URL('https://apply.example.com/?utm_source=newsletter&utm_medium=email'), null, 'apply.example.com', IG);
    expect(t.channel).toBe('Email');
  });
  it('names platforms in plain words', () => {
    expect(platformOf('instagram', null, 'manychat')).toBe('Instagram DM');
    expect(platformOf('instagram', null, 'social')).toBe('Instagram');
    expect(platformOf('m.facebook.com', 'm.facebook.com')).toBe('Facebook');
    expect(platformOf('chatgpt.com')).toBe('ChatGPT');
    expect(platformOf(null, 'gemini.google.com')).toBe('Gemini');
    expect(platformOf(null, 'www.google.com')).toBe('Google');
    expect(platformOf(null, 'mail.google.com')).toBe('Email');
    expect(platformOf('x')).toBe('X');
    expect(platformOf(null, 'accept.com')).toBe('accept.com');
    expect(platformOf(null, null)).toBe('Direct');
  });
});

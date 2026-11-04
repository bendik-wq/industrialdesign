import { describe, expect, it } from 'vitest';
import { count, isoTime, normalise, outputRows, scoreItem, seconds, transcriptText } from '../src/radar/normalise';
import { INSTAGRAM_ROWS, META_AD_ROWS, NOW, TIKTOK_ROWS, TRANSCRIPT_OUTPUT, YOUTUBE_ROWS } from './radar-fixtures';

// Radar: each platform's scraper output normalised into one item shape, transcripts, and the outlier score.

describe('normalisers', () => {
  it('YouTube: ids, counts in any style, duration, subscribers, nocookie embed, captions from subtitles; bad rows dropped', () => {
    const items = normalise('youtube', YOUTUBE_ROWS, NOW);
    expect(items).toHaveLength(2);
    const [a, b] = items;
    expect(a).toMatchObject({
      id: 'youtube:aBcDeFgHiJ1', url: 'https://www.youtube.com/watch?v=aBcDeFgHiJ1', author: 'Deal Desk', views: 1_240_000, likes: 41_000, comments: 2_300,
      followers: 85_000, duration_s: 872, embed_url: 'https://www.youtube-nocookie.com/embed/aBcDeFgHiJ1?rel=0&modestbranding=1', thumbnail_url: 'https://i.ytimg.com/vi/aBcDeFgHiJ1/maxresdefault.jpg',
    });
    expect(a.captions).toContain('I bought this company without a dollar of my own.');
    expect(a.captions).not.toMatch(/-->/);
    expect(b).toMatchObject({ views: 48_000, likes: 1_200, duration_s: 485, thumbnail_url: 'https://i.ytimg.com/vi/ZyXwVuTsRq2/hqdefault.jpg', captions: null });
  });
  it('TikTok: author meta, play/digg/share counts, cover, embed', () => {
    const [t, ...rest] = normalise('tiktok', TIKTOK_ROWS, NOW);
    expect(rest).toHaveLength(0);
    expect(t).toMatchObject({
      id: 'tiktok:7301234567890123456', author: 'ownerplays', followers: 12_000, views: 910_000, likes: 52_000, shares: 8_100, comments: 1_400, duration_s: 47,
      embed_url: 'https://www.tiktok.com/embed/v2/7301234567890123456', thumbnail_url: 'https://p16-sign.tiktokcdn.com/obj/cover1.jpeg', url: 'https://www.tiktok.com/@ownerplays/video/7301234567890123456',
    });
    expect(t.title).toMatch(/^Buying a business/);
  });
  it('Instagram: play count, owner, no media re-hosting (only the post URL and thumbnail kept)', () => {
    const [r] = normalise('instagram', INSTAGRAM_ROWS, NOW);
    expect(r).toMatchObject({ id: 'instagram:3200000000000000001', author: 'rollupguy', views: 640_000, likes: 22_000, duration_s: 58.2, url: 'https://www.instagram.com/reel/C1a2B3c4D5e/', media_url: null });
  });
  it('Meta ads: both actor styles, days active, variants, the creative\'s own media URL, CTA and link', () => {
    const [a, b] = normalise('meta_ads', META_AD_ROWS, NOW);
    expect(a).toMatchObject({
      id: 'meta_ads:1234567890123456', author: 'Acquire Academy', ad_active: 1, ad_active_days: 140, ad_variants: 9, media_kind: 'video',
      media_url: 'https://video.xx.fbcdn.net/v/t42/hd.mp4', thumbnail_url: 'https://scontent.xx.fbcdn.net/v/t39/preview.jpg', ad_cta: 'Learn more',
      ad_link: 'https://example.com/webinar', ad_platforms: 'facebook, instagram', followers: 48_000, title: 'Buy a business without your savings',
    });
    expect(a.caption).toMatch(/^Most owners/);
    // Stopped ads count days until they stopped.
    expect(b).toMatchObject({ id: 'meta_ads:9876543210987654', author: 'Small Biz Buyers', ad_active: 0, ad_active_days: 20, ad_variants: 1, media_kind: 'image', media_url: 'https://scontent.xx.fbcdn.net/v/t39/img.jpg' });
  });
  it('finds rows in any wrapper and never throws on junk', () => {
    expect(outputRows({ items: [{ a: 1 }] })).toHaveLength(1);
    expect(outputRows({ data: { results: [{ a: 1 }, { b: 2 }] } })).toHaveLength(2);
    for (const junk of [null, 'x', 3, [null, 1, 'a'], { items: 'no' }]) for (const p of ['youtube', 'tiktok', 'instagram', 'meta_ads'] as const) expect(() => normalise(p, junk)).not.toThrow();
  });
  it('refuses non-https media and thumbnails', () => {
    const [x] = normalise('meta_ads', [{ ad_archive_id: '1234567', snapshot: { images: [{ original_image_url: 'javascript:alert(1)' }] } }], NOW);
    expect(x.media_url).toBeNull();
  });
  it('helpers', () => {
    expect(count('1.2M')).toBe(1_200_000);
    expect(count('12,345 views')).toBe(12_345);
    expect(count(-1)).toBeNull();
    expect(seconds('1:02:03')).toBe(3723);
    expect(seconds('PT1H')).toBe(3600);
    expect(isoTime(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(isoTime('nonsense')).toBeNull();
  });
});

describe('transcripts', () => {
  it('turns segments into text with [m:ss] marks; plain text passes through', () => {
    expect(transcriptText(TRANSCRIPT_OUTPUT)).toBe('[0:00] I bought this company without a dollar of my own.\n[1:12] Here is the structure.');
    expect(transcriptText([{ text: 'just words' }])).toBe('just words');
    expect(transcriptText({ transcript: 'one block' })).toBe('one block');
    expect(transcriptText([])).toBeNull();
  });
});

describe('scoring', () => {
  const base = { platform: 'youtube' as const, likes: 0, comments: 0, shares: 0, author: 'a', ad_active_days: null, ad_variants: null };
  it('ranks a video far above its follower count higher than one below it', () => {
    const hot = scoreItem({ ...base, views: 1_000_000, followers: 50_000, likes: 50_000, published_at: new Date(NOW - 10 * 86400_000).toISOString() }, { now: NOW });
    const cold = scoreItem({ ...base, views: 5_000, followers: 50_000, likes: 100, published_at: new Date(NOW - 300 * 86400_000).toISOString() }, { now: NOW });
    expect(hot.ratio).toBe(20);
    expect(hot.ratio_basis).toBe('followers');
    expect(hot.velocity).toBe(100_000);
    expect(hot.engagement).toBe(0.05);
    expect(hot.score).toBeGreaterThan(cold.score);
    expect(hot.score).toBeLessThanOrEqual(100);
  });
  it('falls back to the author\'s typical views, then the platform\'s', () => {
    expect(scoreItem({ ...base, views: 300, followers: null, published_at: null }, { authorViews: [100, 100], now: NOW })).toMatchObject({ ratio: 3, ratio_basis: 'author' });
    expect(scoreItem({ ...base, views: 300, followers: null, published_at: null }, { platformViews: [50, 100, 150], now: NOW })).toMatchObject({ ratio: 3, ratio_basis: 'platform' });
    expect(scoreItem({ ...base, views: 300, followers: null, published_at: null }, { now: NOW })).toMatchObject({ ratio: null, ratio_basis: null });
  });
  it('ads: longevity and variants stand in for spend', () => {
    const long = scoreItem({ ...base, platform: 'meta_ads', views: null, followers: null, published_at: null, ad_active_days: 140, ad_variants: 9 });
    const short = scoreItem({ ...base, platform: 'meta_ads', views: null, followers: null, published_at: null, ad_active_days: 5, ad_variants: 1 });
    expect(long.score).toBeGreaterThan(short.score);
    expect(long).toMatchObject({ days_active: 140, variants: 9 });
    expect(scoreItem({ ...base, platform: 'meta_ads', views: null, followers: null, published_at: null, ad_active_days: 365, ad_variants: 100 }).score).toBe(100);
  });
});

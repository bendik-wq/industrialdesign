import { describe, expect, it } from 'vitest';
import { normaliseAnswer, scoreApplication, tierFromScore } from '../src/funnel/scoring';
import { APPLICATION } from '../src/config';

const strong = {
  business: 'Commercial HVAC services across Sydney, 25 staff',
  role: 'owner',
  revenue: '3_10m',
  profit: '250k_1m',
  goal: 'acquire',
  timeline: '0_6',
  blockers: ['deal_flow'],
  readiness: 'yes',
  why_now: 'x'.repeat(200),
};

describe('scoreApplication', () => {
  it('scores a $3-10M owner ready to acquire as A', () => {
    const r = scoreApplication(strong, 'AU');
    expect(r.score).toBe(100); // 103 raw points, clamped to 100
    expect(r.tier).toBe('A');
    expect(r.caps).toEqual([]);
  });

  it('sends businesses under $1M revenue to C, whatever else they answer', () => {
    const r = scoreApplication({ ...strong, revenue: 'lt1m' }, 'AU');
    expect(r.tier).toBe('C');
    expect(r.caps).toContain('Under $1M revenue');
  });

  it('sends non-owners without a business to C', () => {
    expect(scoreApplication({ ...strong, role: 'no_business' }, 'AU').tier).toBe('C');
  });

  it('caps a high scorer who is not ready to invest at B', () => {
    const r = scoreApplication({ ...strong, readiness: 'not_now' }, 'AU');
    expect(r.tier).toBe('B');
    expect(r.caps).toContain('Not ready to invest');
  });

  it('caps non-owner executives and unprofitable businesses at B', () => {
    expect(scoreApplication({ ...strong, role: 'exec', revenue: 'gt10m', profit: 'gt1m' }, 'AU').tier).toBe('B');
    expect(scoreApplication({ ...strong, profit: 'loss' }, 'AU').tier).toBe('B');
  });

  it('caps out-of-market leads at B unless their phone is in market', () => {
    expect(scoreApplication(strong, { country: 'BR', phone: '+5511999999999' }).tier).toBe('B');
    // Travelling Australian owner: foreign IP, Australian mobile
    expect(scoreApplication(strong, { country: 'BR', phone: '+61412345678' }).tier).toBe('A');
  });

  it('sends excluded industries and blocklisted contacts to C', () => {
    expect(scoreApplication({ ...strong, business: 'Medical cannabis dispensary chain' }, 'AU').tier).toBe('C');
    expect(scoreApplication({ ...strong, business: 'Cannabistro restaurants' }, 'AU').tier).toBe('A'); // whole words only
    const blocklist = ['tyre@kicker.com', '@competitor.com', '+61400111222'];
    expect(scoreApplication(strong, { country: 'AU', email: 'TYRE@kicker.com', blocklist }).tier).toBe('C');
    expect(scoreApplication(strong, { country: 'AU', email: 'ceo@competitor.com', blocklist }).tier).toBe('C');
    expect(scoreApplication(strong, { country: 'AU', phone: '+61 400 111 222', blocklist }).tier).toBe('C');
    expect(scoreApplication(strong, { country: 'AU', email: 'owner@hvac.com.au', blocklist }).tier).toBe('A');
  });

  it('treats a personal email as a weak signal only for $1-3M businesses', () => {
    expect(scoreApplication({ ...strong, revenue: '1_3m' }, { country: 'AU', email: 'sam@gmail.com' }).tier).toBe('B');
    expect(scoreApplication(strong, { country: 'AU', email: 'sam@gmail.com' }).tier).toBe('A');
    expect(scoreApplication({ ...strong, revenue: '1_3m', profit: 'gt1m' }, { country: 'AU', email: 'sam@hvac.com' }).tier).toBe('A');
  });

  it('ignores unknown answers', () => {
    expect(scoreApplication({ role: 'hacker', revenue: 'gt10m' }, 'AU').score).toBe(25);
  });

  it('maps thresholds', () => {
    expect(tierFromScore(70)).toBe('A');
    expect(tierFromScore(69)).toBe('B');
    expect(tierFromScore(40)).toBe('B');
    expect(tierFromScore(39)).toBe('C');
  });
});

describe('normaliseAnswer', () => {
  const q = (id: string) => APPLICATION.find((x) => x.id === id)!;
  it('validates single choice', () => {
    expect(normaliseAnswer(q('revenue'), 'gt10m')).toBe('gt10m');
    expect(normaliseAnswer(q('revenue'), 'lots')).toBeNull();
  });
  it('dedupes and filters multi choice', () => {
    expect(normaliseAnswer(q('blockers'), ['time', 'time', 'nope'])).toEqual(['time']);
    expect(normaliseAnswer(q('blockers'), [])).toBeNull();
  });
  it('enforces text min length', () => {
    expect(normaliseAnswer(q('why_now'), 'short')).toBeNull();
    expect(normaliseAnswer(q('why_now'), '  long enough answer  ')).toBe('long enough answer');
  });
});

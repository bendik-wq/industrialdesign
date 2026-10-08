import { describe, expect, it } from 'vitest';
import { normaliseAnswer, scoreApplication, tierFromScore } from '../src/funnel/scoring';
import { APPLICATION } from '../src/config';

const strong = {
  situation: 'owner_one',
  income: 'gt300',
  capital: 'gt100',
  timeline: '0_3',
  blockers: ['deal_flow'],
  readiness: 'yes',
  why_now: 'x'.repeat(200),
};

describe('scoreApplication', () => {
  it('scores a strong applicant as A', () => {
    const r = scoreApplication(strong, 'AU');
    expect(r.score).toBe(100); // 104 raw points, clamped to 100
    expect(r.tier).toBe('A');
    expect(r.caps).toEqual([]);
  });

  it('caps a high scorer who is not ready to invest at B', () => {
    const r = scoreApplication({ ...strong, readiness: 'not_now' }, 'AU');
    expect(r.scoreTier).toBe('A');
    expect(r.tier).toBe('B');
    expect(r.caps).toContain('Not ready to invest');
  });

  it('routes students to C regardless of score', () => {
    expect(scoreApplication({ ...strong, situation: 'student' }, 'AU').tier).toBe('C');
  });

  it('routes no capital + low income to C', () => {
    const r = scoreApplication({ ...strong, capital: 'lt5', income: 'lt75' }, 'AU');
    expect(r.tier).toBe('C');
  });

  it('flags out-of-market countries without penalising the score', () => {
    const r = scoreApplication(strong, 'BR');
    expect(r.flags).toContain('out_of_market');
    expect(r.tier).toBe('A');
  });

  it('ignores unknown answers', () => {
    expect(scoreApplication({ situation: 'hacker', income: 'gt300' }, 'AU').score).toBe(20);
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
    expect(normaliseAnswer(q('income'), 'gt300')).toBe('gt300');
    expect(normaliseAnswer(q('income'), 'lots')).toBeNull();
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

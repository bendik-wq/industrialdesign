import { describe, expect, it } from 'vitest';
import { ALL_LANDERS, ANGLES, INDUSTRIES, getLander, inferIndustry } from '../src/landers/catalog';
import { chooseAngle, MIN_VISITORS, type ArmStats } from '../src/landers/bandit';

describe('industry landers', () => {
  it('has 100 distinct landers with clean copy', () => {
    expect(ALL_LANDERS).toHaveLength(100);
    expect(new Set(ALL_LANDERS.map((l) => l.id)).size).toBe(100);
    expect(new Set(ALL_LANDERS.map((l) => l.headline)).size).toBe(100);
    for (const l of ALL_LANDERS) {
      const all = [l.preHeadline, l.headline, l.subheadline].join(' ');
      expect(all).not.toMatch(/\bfree\b|!|undefined|\d+%/i);
      expect(l.headline).toMatch(/no money down|no-money-down/);
      expect(l.subheadline).toMatch(/7-day money-back guarantee/);
    }
  });

  it('works out the industry from Meta campaign / ad set / ad names', () => {
    expect(inferIndustry('Dental – Lookalike 2%')?.id).toBe('dental');
    expect(inferIndustry(null, 'AU | HVAC owners | broad')?.id).toBe('hvac');
    expect(inferIndustry('physio-retarget')?.id).toBe('allied-health');
    expect(inferIndustry('competitor angle v2')).toBeNull(); // "pet" must not match inside "competitor"
    expect(inferIndustry('roofing')?.id).toBe('roofing-solar');
    expect(inferIndustry('it-services')?.id).toBe('it-services');
    expect(inferIndustry('')).toBeNull();
    expect(getLander('dental.loi')?.headline).toMatch(/your dental practice/);
    expect(inferIndustry('Vets | AU')?.id).toBe('veterinary');
  });

  it('explores every headline first, then shifts traffic to the winner', () => {
    const dental = INDUSTRIES.find((i) => i.id === 'dental')!;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(chooseAngle(dental, new Map()).angle);
    expect(seen.size).toBe(ANGLES.length);

    const stats = new Map<string, ArmStats>(ANGLES.map((a) => [`dental.${a.id}`, { visitors: 400, leads: a.id === 'competitor' ? 40 : 8, qualified: 0, booked: 0 }]));
    const picks: Record<string, number> = {};
    for (let i = 0; i < 500; i++) { const a = chooseAngle(dental, stats).angle; picks[a] = (picks[a] ?? 0) + 1; }
    expect(picks.competitor).toBeGreaterThan(450);
    expect(MIN_VISITORS).toBeGreaterThan(0);
  });
});

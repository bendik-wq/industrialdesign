import { describe, expect, it } from 'vitest';
import { guessFunnel } from '../src/admin/ads';
import { minutesWatched } from '../src/admin/webinar';
import { markMinute } from '../src/webinar/webinar';

describe('ad spend', () => {
  it('guesses which funnel a campaign feeds from its name', () => {
    expect(guessFunnel('AU | Masterclass | Cold')).toBe('webinar');
    expect(guessFunnel('Webinar retargeting')).toBe('webinar');
    expect(guessFunnel('VSL – lookalike 1%')).toBe('vsl');
    expect(guessFunnel(null)).toBe('vsl');
  });
});

describe('webinar minutes', () => {
  it('marks each minute once and ignores minutes outside the session', () => {
    const a = markMinute(null, 2, 5);
    expect(a).toBe('00100');
    expect(markMinute(a, 2, 5)).toBeNull();
    expect(markMinute(a, 4, 5)).toBe('00101');
    expect(markMinute(a, 5, 5)).toBeNull();
    expect(markMinute(a, -1, 5)).toBeNull();
  });
  it('reads recorded minutes, or falls back to joined → furthest point for older rows', () => {
    expect(minutesWatched('0110', 0, 0, 4)).toEqual([false, true, true, false]);
    expect(minutesWatched(null, 1, 2, 4)).toEqual([false, true, true, false]);
    expect(minutesWatched(null, 0, 99, 3)).toEqual([true, true, true]);
  });
});

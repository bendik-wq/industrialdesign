import { describe, expect, it } from 'vitest';
import { parseUA } from '../src/lib/ua';
import { normalisePhone, validateEmail } from '../src/funnel/leads';
import { pickWeighted } from '../src/funnel/routing';
import { mergeBuckets, parseHeartbeat } from '../src/tracking/vsl';
import { zTest } from '../src/admin/stats';
import type { Closer } from '../src/config';

describe('parseUA', () => {
  it('parses iOS Safari as mobile', () => {
    const u = parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1');
    expect(u).toMatchObject({ browser: 'Safari', os: 'iOS', osVersion: '17.4', device: 'mobile', isBot: false });
  });
  it('recognises the Facebook in-app browser', () => {
    expect(parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0]').browser).toBe('Facebook In-App');
  });
  it('flags crawlers, link previews and scripts as bots', () => {
    expect(parseUA('facebookexternalhit/1.1').isBot).toBe(true);
    expect(parseUA('curl/8.4.0').isBot).toBe(true);
    expect(parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0 Safari/537.36').isBot).toBe(true);
    expect(parseUA('').isBot).toBe(true);
  });
});

describe('contact validation', () => {
  it('normalises local numbers with the visitor country', () => {
    expect(normalisePhone('0412 345 678', 'AU')).toBe('+61412345678');
    expect(normalisePhone('(415) 555-1234', 'US')).toBe('+14155551234');
    expect(normalisePhone('+44 7700 900123', 'AU')).toBe('+447700900123');
    expect(normalisePhone('0044 7700 900123', null)).toBe('+447700900123');
    expect(normalisePhone('123', 'AU')).toBeNull();
  });
  it('rejects bad and disposable emails', () => {
    expect(validateEmail('Sam@Example.com')).toEqual({ email: 'sam@example.com', disposable: false });
    expect(validateEmail('nope')).toBeNull();
    expect(validateEmail('x@mailinator.com')?.disposable).toBe(true);
  });
});

describe('pickWeighted', () => {
  const closers: Closer[] = [
    { id: 'a', name: 'A', tiers: ['A'], weight: 2, bookingSetting: 'BOOKING_URL_A' },
    { id: 'b', name: 'B', tiers: ['A'], weight: 1, bookingSetting: 'BOOKING_URL_A' },
  ];
  it('distributes by weight, interleaved', () => {
    let state = {};
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = pickWeighted(closers, state);
      picks.push(r.closer.id);
      state = r.state;
    }
    expect(picks.filter((p) => p === 'a')).toHaveLength(4);
    expect(picks.join('')).toBe('abaaba');
  });
});

describe('VSL heartbeats', () => {
  it('OR-merges watched buckets', () => {
    const a = '1'.repeat(10) + '0'.repeat(90);
    const b = '0'.repeat(50) + '1'.repeat(10) + '0'.repeat(40);
    const m = mergeBuckets(a, b);
    expect(m.slice(0, 10)).toBe('1'.repeat(10));
    expect(m.slice(50, 60)).toBe('1'.repeat(10));
    expect(m.split('1').length - 1).toBe(20);
  });
  it('rejects unknown videos and clamps values', () => {
    expect(parseHeartbeat({ view: 'abcdefgh1', video: 'evil', pos: 1, dur: 2 })).toBeNull();
    const hb = parseHeartbeat({ view: 'abcdefgh1', video: 'vsl-main', pos: -5, dur: 100, watched: 999, buckets: 'x' })!;
    expect(hb.pos).toBe(0);
    expect(hb.watched).toBe(30);
    expect(hb.buckets).toBe('0'.repeat(100));
  });
});

describe('zTest', () => {
  it('finds a real difference significant and noise not', () => {
    expect(zTest(50, 1000, 80, 1000).p).toBeLessThan(0.05);
    expect(zTest(50, 1000, 52, 1000).p).toBeGreaterThan(0.5);
    expect(zTest(0, 0, 1, 1).p).toBe(1);
  });
});

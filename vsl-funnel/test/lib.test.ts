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

import { whatsappLink } from '../src/integrations/whatsapp';
import type { Settings } from '../src/settings';

describe('whatsappLink', () => {
  const s = { JOSH_WHATSAPP: '+61 4 3537 5590' } as Settings;
  const lead = (tier: 'A' | 'B' | 'C' | null, tier_override: 'A' | 'B' | 'C' | null = null) => ({ first_name: 'Sam', ref_code: 'AB12CD', tier, tier_override });
  it('is offered to A and B tier leads only', () => {
    expect(whatsappLink(s, lead('A'), 'question')).toMatch(/^https:\/\/wa\.me\/61435375590\?text=/);
    expect(whatsappLink(s, lead('B'), 'booked')).toContain('ref%20AB12CD');
    expect(whatsappLink(s, lead('C'), 'resources')).toBeNull();
    expect(whatsappLink(s, lead(null), 'question')).toBeNull();
    expect(whatsappLink(s, null, 'question')).toBeNull();
  });
  it('follows a manual tier override', () => {
    expect(whatsappLink(s, lead('C', 'B'), 'question')).not.toBeNull();
    expect(whatsappLink(s, lead('A', 'C'), 'question')).toBeNull();
  });
});

import { hashedMatchKeys, normalise } from '../src/tracking/match';
import { conversionValue, metaEventName, metaUserData } from '../src/tracking/forward';
import { sha256 } from '../src/lib/crypto';

describe('Meta match keys', () => {
  it('normalises exactly as Meta specifies before hashing', () => {
    expect(normalise.em('  Josh@Example.COM ')).toBe('josh@example.com');
    expect(normalise.ph('+61 435 375 590')).toBe('61435375590');
    expect(normalise.fn('Mary-Jane')).toBe('maryjane');
    expect(normalise.ct('New South Wales')).toBe('newsouthwales');
    expect(normalise.st('California', 'CA', 'US')).toBe('ca');
    expect(normalise.st('New South Wales', 'NSW', 'AU')).toBe('newsouthwales');
    expect(normalise.zp('94107-1234', 'US')).toBe('94107');
    expect(normalise.zp('SW1A 1AA', 'GB')).toBe('sw1a1aa');
    expect(normalise.country('AU')).toBe('au');
  });

  it('sends the same external_id as the browser Pixel, plus the lead id', async () => {
    const who = { visitorId: 'v_abc', sessionId: 's1', leadId: 'l_1', ip: '203.0.113.9', userAgent: 'UA', fbp: 'fb.1.1.2', fbc: 'fb.1.1.xyz', geo: { country: 'AU', region: 'New South Wales', regionCode: 'NSW', city: 'Sydney', postalCode: '2000' } };
    const lead = { id: 'l_1', email: 'A@b.com', phone: '+61435375590', first_name: 'Josh', last_name: 'Li', country: 'AU', city: 'Sydney' };
    const ud = await metaUserData(who, lead);
    expect(ud.external_id).toEqual([await sha256('v_abc'), await sha256('l_1')]);
    expect(ud.em).toEqual([await sha256('a@b.com')]);
    expect(ud.ph).toEqual([await sha256('61435375590')]);
    expect(ud.zp).toEqual([await sha256('2000')]);
    expect(ud).toMatchObject({ client_ip_address: '203.0.113.9', client_user_agent: 'UA', fbp: 'fb.1.1.2', fbc: 'fb.1.1.xyz' });
    const pixel = await hashedMatchKeys({ email: 'A@b.com' }, null, ['v_abc']);
    expect(pixel.external_id).toEqual([await sha256('v_abc')]);
    expect(pixel.em).toBe(await sha256('a@b.com'));
  });

  it('sends pipeline outcomes back to Meta with real value', () => {
    expect(metaEventName('lead_status_changed', { to: 'won' })).toBe('Purchase');
    expect(metaEventName('lead_status_changed', { to: 'showed' })).toBe('CallShowed');
    expect(metaEventName('lead_status_changed', { to: 'lost' })).toBeUndefined();
    expect(metaEventName('lead_captured', {})).toBe('Lead');
    expect(conversionValue('lead_status_changed', { to: 'won', revenue: 15000 }, null)).toBe(15000);
  });
});

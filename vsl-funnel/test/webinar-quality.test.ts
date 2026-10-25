import { describe, expect, it } from 'vitest';
import { WEBINAR_HEADLINES, HEADLINE_MIN_VIEWS, chooseWebinarHeadline, type HeadlineStat } from '../src/webinar/headlines';
import { auditCopy } from '../src/content/copy-rules';
import { BAND_EVENT, bandValue, revenueMetaName } from '../src/tracking/revenue-events';
import { metaEventName, conversionValue } from '../src/tracking/forward';
import { APP_REVENUE_BAND } from '../src/sales/qualify';
import { underMillion } from '../src/webinar/webinar';

const plain = (s: string) => s.replace(/<[^>]+>/g, '');

describe('webinar headlines', () => {
  it('pass the copy blacklist, name all three funding sources when funding is described, and label multiples', () => {
    for (const h of WEBINAR_HEADLINES) {
      expect(auditCopy(`${plain(h.h1)} ${h.lede}`), h.id).toEqual([]);
      if (/debt|seller finance|funded|fund the|pay for the business/i.test(h.lede)) expect(h.lede, h.id).toMatch(/seller rollover/);
      expect(`${h.h1} ${h.lede}`, h.id).not.toMatch(/\bfree\b|guarantee/i);
      if (/\d+–\d+×/.test(h.h1)) expect(h.lede, h.id).toMatch(/illustrative/i);
    }
    expect(new Set(WEBINAR_HEADLINES.map((h) => h.id)).size).toBe(WEBINAR_HEADLINES.length);
  });

  it('explores every headline first, then favours the one that brings $1M+ sign-ups', () => {
    const stats = new Map<string, HeadlineStat>(WEBINAR_HEADLINES.map((h) => [h.id, { views: HEADLINE_MIN_VIEWS + 200, regs: 40, qualified: 2 }]));
    stats.get('cash')!.qualified = 30;
    let wins = 0;
    for (let i = 0; i < 300; i++) if (chooseWebinarHeadline(stats, 'auto') === 'cash') wins++;
    expect(wins).toBeGreaterThan(250);
    stats.get('pe')!.views = 3;
    expect(chooseWebinarHeadline(stats, 'auto')).toBe('pe');
    expect(chooseWebinarHeadline(stats, 'group')).toBe('group');
  });
});

describe('revenue events for Meta audiences', () => {
  it('has one event per application revenue band', () => {
    for (const band of Object.values(APP_REVENUE_BAND)) expect(BAND_EVENT[band], band).toBeTruthy();
  });
  it('maps to separate Meta events, with $1M+ overall and per funnel', () => {
    expect(metaEventName('revenue_band', { band: '3m-10m' })).toBe('Revenue3to10M');
    expect(metaEventName('revenue_band', { band: '<1m' })).toBe('RevenueUnder1M');
    expect(metaEventName('qualified_any_1m_plus', { band: '1m-3m' })).toBe('Qualified1MPlus');
    expect(metaEventName('qualified_1m_plus', { funnel: 'webinar' })).toBe('WebinarQualified1MPlus');
    expect(metaEventName('qualified_1m_plus', { funnel: 'application' })).toBe('ApplicationQualified1MPlus');
    expect(revenueMetaName('qualified_10m_plus', {})).toBe('Qualified10MPlus');
  });
  it('values bigger owners higher and under $1M at nothing', () => {
    expect(bandValue('<1m')).toBe(0);
    expect(bandValue('25m-50m')).toBeGreaterThan(bandValue('3m-10m'));
    expect(bandValue('3m-10m')).toBeGreaterThan(bandValue('1m-3m'));
    expect(conversionValue('revenue_band', { band: '<1m' }, null)).toBeUndefined();
  });
  it('treats only a stated under-$1M as unqualified', () => {
    expect(underMillion('<1m')).toBe(true);
    expect(underMillion('1m-3m')).toBe(false);
    expect(underMillion(null)).toBe(false);
  });
});

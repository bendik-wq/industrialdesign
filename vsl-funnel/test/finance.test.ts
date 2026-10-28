// @ts-expect-error vite raw import of a browser script
import modelSrc from '../public/assets/finance-model.js?raw';
import { describe, expect, it } from 'vitest';
import { cleanModel } from '../src/admin/finance';

// The model ships as a browser script; load it the same way the dashboard does.
const mod: { exports: any } = { exports: {} };
new Function('module', modelSrc as string)(mod);
const M = mod.exports;

describe('financial model', () => {
  it('walks the VSL funnel step by step', () => {
    const m = M.normalise({ shared: { fee: 20000, refund: 0, commission: 0, fulfil: 0, fixed: 0 }, vsl: { spend: 10000, cpc: 5, optin: 0.1, appDone: 0.5, qualified: 0.5, book: 0.5, show: 0.5, close: 0.5 } });
    const p = M.funnel('vsl', m.vsl, m.shared);
    expect(p.visitors).toBe(2000);
    expect(p.leads).toBe(200);
    expect(p.apps).toBe(100);
    expect(p.booked).toBe(25);
    expect(p.deals).toBeCloseTo(6.25);
    expect(p.net).toBeCloseTo(125000);
    expect(p.profit).toBeCloseTo(115000);
    expect(p.unit.perBooked).toBe(400);
    expect(p.unit.cac).toBe(1600);
    // Break-even per visitor: one client is worth 20k, and 6.25 clients come from 2000 visitors.
    expect(p.unit.maxCpc).toBeCloseTo(62.5);
  });

  it('counts webinar applications from watchers and from the emails to non-watchers', () => {
    const m = M.normalise({ webinar: { spend: 3000, cpc: 3, reg: 0.5, attend: 0.4, applyAtt: 0.1, applyNo: 0.05 } });
    const p = M.funnel('webinar', m.webinar, m.shared);
    expect(p.leads).toBe(500);
    expect(p.apps).toBeCloseTo(200 * 0.1 + 300 * 0.05);
  });

  it('finds the spend for a profit target and the cash needed before payback', () => {
    const m = M.normalise({ shared: { fixed: 10000, target: 20000, months: 6, growth: 0 } });
    const t = M.combine(m).total;
    const perDollar = t.profit / t.spend;
    expect(t.spendForTarget).toBeCloseTo(30000 / perDollar);
    const pr = M.projection(m);
    expect(pr.rows).toHaveLength(6);
    expect(pr.cashNeeded).toBeGreaterThanOrEqual(0);
  });

  it('clamps bad input instead of breaking', () => {
    const m = M.normalise({ vsl: { close: 7, cpc: -3, spend: 'abc' }, shared: { months: 999, currency: 'nope' } });
    expect(m.vsl.close).toBe(1);
    expect(m.vsl.cpc).toBe(0);
    expect(m.vsl.spend).toBe(M.DEFAULTS.vsl.spend);
    expect(m.shared.months).toBe(36);
    expect(m.shared.currency).toBe('USD');
    expect(M.funnel('vsl', m.vsl, m.shared).unit.cac).toBeNull();
  });

  it('walks the paid ladder: ticket, First Deal Sprint, engagement with the Sprint fee credited', () => {
    const m = M.normalise({
      shared: { fee: 40000, refund: 0, commission: 0.1, fulfil: 0, fixed: 0 },
      webinar: { ladder: true, spend: 10000, cpc: 5, reg: 0.5, ticketBuy: 0.5, attend: 0.5, applyAtt: 0, applyNo: 0, ticket: 100, sprintPrice: 3000, sprintRate: 0.1, sprintToEng: 0.5, engFee: 50000, sprintCost: 0 },
    });
    const p = M.funnel('webinar', m.webinar, m.shared);
    expect(p.visitors).toBe(2000);
    expect(p.leads).toBe(1000);
    expect(p.tickets).toBe(500);
    expect(p.sprints).toBeCloseTo(25);
    expect(p.engagements).toBeCloseTo(12.5);
    expect(p.deals).toBeCloseTo(12.5);
    // 500 × $100 + 25 × $3,000 + 12.5 × ($50,000 − $3,000 credit)
    expect(p.net).toBeCloseTo(50000 + 75000 + 587500);
    expect(p.commission).toBeCloseTo(58750); // closer commission on the engagement only
    expect(p.unit.revPerRegistrant).toBeCloseTo(712.5);
    expect(p.unit.revPerTicket).toBeCloseTo(1425);
    expect(p.unit.maxCpc).toBeCloseTo((p.profit + p.spend) / p.visitors);
  });

  it('new scenarios start with the ladder on; scenarios saved before it keep their free-webinar numbers', () => {
    expect(M.normalise({}).webinar.ladder).toBe(true);
    const old = M.normalise({ webinar: { spend: 3000, cpc: 3, reg: 0.5, attend: 0.4, close: 0.2 } });
    expect(old.webinar.ladder).toBe(false);
    expect(old.webinar.sprintPrice).toBe(M.DEFAULTS.webinar.sprintPrice); // defaults filled, unused until switched on
    const p = M.funnel('webinar', old.webinar, old.shared);
    expect(p.tickets).toBe(0);
    expect(p.sprints).toBe(0);
    expect(M.normalise({ webinar: { ladder: true, sprintRate: 4 } }).webinar.sprintRate).toBe(1);
  });

  it('stores only numbers, switches and a currency code', () => {
    expect(cleanModel({ vsl: { spend: 5, on: true, evil: '<script>', 'bad key': 1 }, shared: { currency: 'AUD' }, other: { x: 1 } }))
      .toEqual({ shared: { currency: 'AUD' }, vsl: { spend: 5, on: true }, webinar: {} });
  });
});

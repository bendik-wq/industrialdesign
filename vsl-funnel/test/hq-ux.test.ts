// @ts-expect-error vite raw import of a browser script
import uxSrc from '../public/assets/admin-ux.js?raw';
import { describe, expect, it } from 'vitest';
import { auditCopy } from '../src/content/copy-rules';

// The shared Funnel HQ helpers ship as a browser script; load it the way the finance model test does.
const mod: { exports: any } = { exports: {} };
new Function('module', uxSrc as string)(mod);
const U = mod.exports;
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const fs = node.getBuiltinModule('node:fs') as { readFileSync(p: string, enc: string): string };
const read = (p: string) => fs.readFileSync(`${node.cwd()}/${p}`, 'utf8');

describe('Funnel HQ number formatting', () => {
  it('formats counts with thousands separators and a dash for nothing', () => {
    expect(U.num(1234567, 0, 'en-US')).toBe('1,234,567');
    expect(U.num(1234.56, 1, 'en-US')).toBe('1,234.6');
    expect(U.num(2.5, 0, 'en-US')).toBe('3');
    expect(U.num(null)).toBe('–');
    expect(U.num(NaN)).toBe('–');
    expect(U.num('')).toBe('–');
    expect(U.num(0, 0, 'en-US')).toBe('0');
  });

  it('shows small rates with one decimal so they never all read 0%', () => {
    expect(U.pct(0.25)).toBe('25%');
    expect(U.pct(0.043)).toBe('4.3%');
    expect(U.pct(0)).toBe('0%');
    expect(U.pct(1)).toBe('100%');
    expect(U.pct(0.12345, 2)).toBe('12.35%');
    expect(U.pct(undefined)).toBe('–');
    expect(U.pct(Infinity)).toBe('–');
  });

  it('formats money in the given currency and falls back for an unknown code', () => {
    expect(U.money(25000, 'USD', 0, 'en-US')).toBe('$25,000');
    expect(U.money(25000, 'aud', 0, 'en-US')).toBe('A$25,000');
    expect(U.money(12.5, 'USD', 2, 'en-US')).toBe('$12.50');
    expect(U.money(null, 'USD')).toBe('–');
    expect(U.money(1500, 'NOTACODE', 0, 'en-US')).toBe('NOTACODE 1,500');
  });

  it('writes multiples with a times sign, seconds as minutes and seconds, and compact counts', () => {
    expect(U.ratio(2.345)).toBe('2.35×');
    expect(U.ratio(null)).toBe('–');
    expect(U.secs(45)).toBe('45s');
    expect(U.secs(185)).toBe('3m 05s');
    expect(U.secs(null)).toBe('0s');
    expect(U.compact(950)).toBe('950');
    expect(U.compact(12400)).toBe('12.4k');
    expect(U.compact(3000)).toBe('3k');
    expect(U.compact(3100000)).toBe('3.1M');
  });
});

describe('Funnel HQ error messages', () => {
  it('keeps the server’s own words and the status', () => {
    expect(U.errorMessage(500, { error: 'D1_ERROR: no such column' }, 'traffic?from=1')).toBe('D1_ERROR: no such column [500 (traffic)]');
    expect(U.errorMessage(502, '<html><body><h1>Bad gateway</h1></body></html>', 'vsl')).toBe('Bad gateway [502 (vsl)]');
    expect(U.errorMessage(503, '', 'sales')).toBe('The server answered 503 (sales)');
  });

  it('tells a network failure from a bug', () => {
    expect(U.isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(U.isNetworkError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true);
    expect(U.isNetworkError(new TypeError('Load failed'))).toBe(true);
    expect(U.isNetworkError(new TypeError("Cannot read properties of undefined (reading 'rows')"))).toBe(false);
  });
});

describe('Jump to ranking', () => {
  const items = [
    { id: 'tab:emails', label: 'Emails', group: 'Follow-up', keywords: 'emails sequences deliverability' },
    { id: 'tab:editor', label: 'Email editor', group: 'Follow-up', keywords: 'editor' },
    { id: 'tab:sales', label: 'Calls & deals', group: 'Sell', keywords: 'sales outcomes' },
    { id: 'tab:leads', label: 'Leads', group: 'Sell', keywords: 'leads applicants' },
  ];
  const ids = (q: string) => U.rank(items, q).map((x: { id: string }) => x.id);

  it('puts exact and prefix matches first, then words, then keywords', () => {
    expect(ids('emails')[0]).toBe('tab:emails');
    expect(ids('edit')[0]).toBe('tab:editor');
    expect(ids('deals')).toEqual(['tab:sales']);
    expect(ids('sales')).toEqual(['tab:sales']); // the tab's id still finds it
    expect(ids('emed')).toEqual(['tab:editor']); // letters in order
    expect(ids('zzz')).toEqual([]);
    expect(ids('')).toHaveLength(4); // nothing typed: everything, in nav order
  });
});

describe('Funnel HQ tab coverage', () => {
  const admin = read('public/assets/admin.js');
  const html = read('public/admin/index.html');
  const tabs = [...admin.slice(admin.indexOf('var TABS = {'), admin.indexOf('};', admin.indexOf('var TABS = {'))).matchAll(/^\s{4}(\w+): \{ group:/gm)].map((m) => m[1]);

  it('every tab has a nav entry, and every nav entry is a tab (so Jump to lists them all)', () => {
    expect(tabs.length).toBeGreaterThan(40);
    const nav = [...html.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
    expect([...nav].sort()).toEqual([...tabs].sort());
  });

  it('every data tab says what fills it when empty (layout-only tabs excepted)', () => {
    const layoutOnly = ['map', 'screens', 'materials', 'editor', 'integrations'];
    for (const t of tabs) if (!layoutOnly.includes(t)) expect(U.TAB_HELP[t], t).toBeTruthy();
    for (const k of Object.keys(U.TAB_HELP)) expect(tabs, k).toContain(k);
    for (const [, go] of Object.values(U.TAB_HELP) as string[][]) if (go) expect(tabs, go).toContain(go);
  });

  it('the empty-state and error copy passes the copy rules', () => {
    for (const [text, , label] of Object.values(U.TAB_HELP) as string[][]) {
      expect(auditCopy(text), text).toEqual([]);
      if (label) expect(auditCopy(label), label).toEqual([]);
    }
  });

  it('loads before admin.js, which uses it for every number and state', () => {
    expect(html.indexOf('/assets/admin-ux.js')).toBeGreaterThan(-1);
    expect(html.indexOf('/assets/admin-ux.js')).toBeLessThan(html.indexOf('/assets/admin.js'));
    expect(admin).toContain('F.errorState(');
    expect(admin).toContain('F.skeleton(');
    expect(admin).toContain('F.palette(');
  });
});

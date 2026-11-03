// @ts-expect-error vite raw import of a browser script
import navSrc from '../public/assets/admin-nav.js?raw';
import { describe, expect, it } from 'vitest';
import { auditCopy } from '../src/content/copy-rules';

// admin-nav.js exports its map under CommonJS without touching the DOM, the way admin-ux.js does.
const mod: { exports: any } = { exports: {} };
new Function('module', navSrc as string)(mod);
const N = mod.exports;
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const fs = node.getBuiltinModule('node:fs') as { readFileSync(p: string, enc: string): string };
const read = (p: string) => fs.readFileSync(`${node.cwd()}/${p}`, 'utf8');
const unent = (s: string) => s.replace(/&amp;/g, '&');

describe('Funnel HQ navigation', () => {
  const admin = read('public/assets/admin.js');
  const html = read('public/admin/index.html');
  const tabs = [...admin.slice(admin.indexOf('var TABS = {'), admin.indexOf('};', admin.indexOf('var TABS = {'))).matchAll(/^\s{4}(\w+): \{ group:/gm)].map((m) => m[1]);

  it('places every tab in exactly one of six sections, and nothing else', () => {
    expect(Object.keys(N.NAV).sort()).toEqual([...tabs].sort());
    expect(N.SECTIONS.map((s: { id: string }) => s.id)).toEqual(['home', 'sales', 'live', 'marketing', 'pages', 'settings']);
    for (const t of tabs) expect(N.SECTIONS.map((s: { id: string }) => s.id), t).toContain(N.NAV[t][0]);
  });

  it('the sidebar shows each tab once, in its section, under the same name', () => {
    const groups = [...html.matchAll(/<div class="nav-group[^"]*" data-section="(\w+)">([\s\S]*?)\n {10}<\/div>\n/g)];
    expect(groups.map((g) => g[1])).toEqual(N.SECTIONS.map((s: { id: string }) => s.id));
    const seen: string[] = [];
    for (const [, sec, body] of groups) {
      for (const m of body.matchAll(/data-tab="(\w+)"[^>]*>.*?<span class="nl">([^<]+)<\/span>/g)) {
        seen.push(m[1]);
        expect(N.NAV[m[1]][0], m[1]).toBe(sec);
        expect(unent(m[2]), m[1]).toBe(N.NAV[m[1]][1]);
        // Tabs under "More" in the sidebar are the ones marked as more in the map.
        const inMore = body.indexOf('data-sec-more-body') > -1 && body.indexOf(`data-tab="${m[1]}"`) > body.indexOf('data-sec-more-body');
        expect(!!N.NAV[m[1]][4], m[1]).toBe(inMore);
      }
    }
    expect(seen.sort()).toEqual([...tabs].sort());
  });

  it('every name, description and action label passes the copy rules', () => {
    for (const [t, v] of Object.entries(N.NAV) as [string, any[]][]) {
      expect(auditCopy(v[1]), t).toEqual([]);
      expect(auditCopy(v[2]), t).toEqual([]);
      expect(v[2].length, t).toBeLessThan(90); // one line
      if (v[3]) expect(auditCopy(v[3].label), t).toEqual([]);
    }
  });

  it('Home is the default tab and loads its board before admin.js', () => {
    expect(admin).toContain("go(h || 'home'");
    expect(html.indexOf('/assets/admin-nav.js')).toBeLessThan(html.indexOf('/assets/admin.js'));
    expect(html.indexOf('/assets/admin-home.js')).toBeLessThan(html.indexOf('/assets/admin.js'));
  });
});

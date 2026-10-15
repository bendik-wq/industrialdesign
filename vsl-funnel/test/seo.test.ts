import { describe, expect, it } from 'vitest';
import { GUIDES } from '../src/seo/guides';
import { renderMarkdown, stripMarkdown } from '../src/seo/markdown';
import { INDUSTRIES } from '../src/landers/catalog';
import { AI_SEARCH, classifyChannel } from '../src/lib/attribution';

const words = (s: string) => stripMarkdown(s).split(' ').filter((w) => /\w/.test(w)).length;

describe('guides', () => {
  it('has unique slugs and every link points at a real page', () => {
    const slugs = new Set(GUIDES.map((g) => g.slug));
    expect(slugs.size).toBe(GUIDES.length);
    expect(GUIDES.length).toBeGreaterThanOrEqual(37);
    for (const g of GUIDES) {
      const host = g.host ?? 'main';
      const sameHost = new Set(GUIDES.filter((x) => (x.host ?? 'main') === host).map((x) => x.slug));
      for (const m of g.body.matchAll(/\]\((\/[^)\s]*)\)/g)) {
        const path = m[1].split('#')[0];
        if (path.startsWith('/guides/')) expect(sameHost.has(path.slice(8)), `${g.slug} → ${path}`).toBe(true);
        else if (host === 'main') expect(['/', ...INDUSTRIES.map((i) => `/${i.id}`)], `${g.slug} → ${path}`).toContain(path);
        else expect(path, `${g.slug} → ${path}`).toBe('/');
      }
      for (const r of g.related) expect(sameHost.has(r), `${g.slug} related ${r}`).toBe(true);
      if (g.industry) expect(INDUSTRIES.some((i) => i.id === g.industry)).toBe(true);
    }
  });
  it('meets the length rules search engines and AI answers reward', () => {
    for (const g of GUIDES) {
      expect(g.title.length, g.slug).toBeLessThanOrEqual(65);
      expect(g.description.length, g.slug).toBeGreaterThanOrEqual(110);
      expect(g.description.length, g.slug).toBeLessThanOrEqual(165);
      expect(words(g.answer), g.slug).toBeGreaterThanOrEqual(35);
      expect(words(g.answer), g.slug).toBeLessThanOrEqual(75);
      expect(words(g.body), g.slug).toBeGreaterThanOrEqual(600);
      expect(g.faqs.length, g.slug).toBeGreaterThanOrEqual(4);
    }
  });
  it('names seller rollover in every acquisition guide and never calls the call free', () => {
    for (const g of GUIDES) {
      const all = `${g.body} ${g.answer} ${g.faqs.map((f) => f.a).join(' ')}`;
      if ((g.host ?? 'main') === 'main') expect(all.toLowerCase(), g.slug).toContain('seller rollover');
      expect(all, g.slug).not.toMatch(/free (strategy |acquisition )?call|call is free|free consultation/i);
      expect(all, g.slug).toMatch(/not financial|general information/i);
    }
  });
  it('renders markdown safely', () => {
    const { html, headings } = renderMarkdown('## How it works\n\nText with **bold** and [a link](/guides/x) and [bad](javascript:alert(1)).\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n- two\n\n<script>x</script>');
    expect(headings[0]).toEqual({ id: 'how-it-works', text: 'How it works' });
    expect(html).toContain('<a href="/guides/x">a link</a>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<table>');
    for (const g of GUIDES) expect(renderMarkdown(g.body).html).not.toMatch(/\*\*|\]\(/);
  });
});

describe('AI search traffic', () => {
  it('classifies AI assistants as AI Search, not Organic or Referral', () => {
    for (const host of ['chatgpt.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'copilot.microsoft.com', 'grok.com']) {
      expect(classifyChannel(host, 'referral', host, false), host).toBe('AI Search');
    }
    expect(classifyChannel('chatgpt.com', null, null, false)).toBe('AI Search');
    expect(classifyChannel('google', 'organic', 'google.com', false)).toBe('Organic Search');
    expect(AI_SEARCH.test('accept.com')).toBe(false);
  });
});

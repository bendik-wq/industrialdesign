/** Guide pages, the guides hub, /about, and the crawler files (robots.txt, sitemap.xml, llms.txt). */
import type { Context } from 'hono';
import type { AppEnv } from '../app';
import { BRAND } from '../config';
import { INDUSTRIES } from '../landers/catalog';
import { render } from '../funnel/pages';
import type { Guide } from './types';
import { renderMarkdown } from './markdown';
import {
  articleLd, breadcrumbs, faqPage, findGuide, guideMarkdown, guidesFor, hostKind, llmsTxt, orgId, personId, robotsTxt, sameAs, sitemapXml,
} from './seo';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const NOT_ADVICE = 'General information only, not financial, legal or tax advice. Every deal is structured on its own numbers; get advice on your situation.';

function crumbsHtml(items: { name: string; path: string }[]) {
  return `<nav class="crumbs" aria-label="Breadcrumb">${items.map((it, i) => (i < items.length - 1 ? `<a href="${esc(it.path)}">${esc(it.name)}</a><span aria-hidden="true">/</span>` : `<span aria-current="page">${esc(it.name)}</span>`)).join('')}</nav>`;
}

function cardsHtml(list: Guide[]) {
  return `<div class="cards">${list.map((g) => `<a class="card-link" href="/guides/${esc(g.slug)}"><strong>${esc(g.h1)}</strong><span>${esc(g.description)}</span></a>`).join('')}</div>`;
}

/** The call to action at the end of a guide: the industry page, the main page, or the data page. */
function ctaFor(g: Guide) {
  if ((g.host ?? 'main') === 'data') {
    return { href: '/', label: 'Claim my data valuation', title: 'Find out what your data is worth', text: 'It takes about a minute. Our partner looks at what you have and puts a number on it; you decide from there.' };
  }
  const ind = g.industry ? INDUSTRIES.find((i) => i.id === g.industry) : null;
  return {
    href: ind ? `/${ind.id}` : '/',
    label: 'See if you qualify',
    title: ind ? `Planning to buy ${ind.target}?` : 'Want to do this on your next acquisition?',
    text: `Watch the short video, then apply for an acquisition strategy call with ${BRAND.founder}’s team. If you’re a fit, you’ll leave with the target, the structure and the financing mapped out.`,
  };
}

const navFor = (c: Context<AppEnv>) => (hostKind(c) === 'data'
  ? { cta: '/', label: 'Claim my valuation', short: 'Claim' }
  : { cta: '/#apply', label: 'See if you qualify', short: 'Apply' });

export async function guidePage(c: Context<AppEnv>) {
  const kind = hostKind(c);
  const g = findGuide(kind, c.req.param('slug') ?? '');
  if (!g) return c.notFound();
  const { html, headings } = renderMarkdown(g.body);
  const cta = ctaFor(g);
  const related = g.related.map((s) => findGuide(kind, s)).filter((x): x is Guide => Boolean(x)).slice(0, 5);
  const trail = [{ name: 'Home', path: '/' }, { name: 'Guides', path: '/guides' }, { name: g.h1, path: `/guides/${g.slug}` }];
  const main = `<div class="wrap">${crumbsHtml(trail)}
<div class="g-layout"><article class="g-article" itemscope itemtype="https://schema.org/Article">
<header class="g-head"><h1 itemprop="headline">${esc(g.h1)}</h1>
<div class="g-meta"><span class="avatar" aria-hidden="true">JL</span><span>By <a href="${kind === 'main' ? '/about' : esc(`${mainOrigin(c)}/about`)}" rel="author">${esc(BRAND.founder)}</a> · Updated <time datetime="${esc(g.updated)}" itemprop="dateModified">${esc(fmtDate(g.updated))}</time></span></div></header>
<section class="guide-answer" aria-label="Short answer"><span class="label">Short answer</span><p itemprop="abstract">${esc(g.answer)}</p></section>
<ul class="keypoints">${g.keyPoints.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>
<div class="prose" itemprop="articleBody">${html}</div>
<section class="g-faq" aria-labelledby="faq"><h2 id="faq">Frequently asked questions</h2>${g.faqs.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</section>
<section class="g-cta"><h2>${esc(cta.title)}</h2><p>${esc(cta.text)}</p><a class="btn" href="${esc(cta.href)}" data-track="cta_click" data-track-id="guide_cta">${esc(cta.label)} →</a></section>
<p class="g-note">${esc(NOT_ADVICE)}</p>
</article>
<aside class="g-aside" aria-label="On this page">${headings.length ? `<h2>On this page</h2><ol>${headings.map((h) => `<li><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join('')}<li><a href="#faq">FAQ</a></li></ol>` : ''}<a class="btn btn-sm" href="${esc(cta.href)}" data-track="cta_click" data-track-id="guide_aside">${esc(cta.label)}</a></aside></div>
${related.length ? `<section class="g-related"><h2>Related guides</h2>${cardsHtml(related)}</section>` : ''}</div>`;
  const nav = navFor(c);
  return render(c, '/article.html', {
    title: g.title,
    slots: { nav_cta: esc(nav.label), nav_short: esc(nav.short) },
    hrefs: { cta: nav.cta },
    show: { main_host: kind === 'main' },
    blocks: { main },
    seo: {
      title: `${g.title} | ${c.get('settings').SITE_NAME || BRAND.name}`,
      description: g.description,
      path: `/guides/${g.slug}`,
      index: true,
      type: 'article',
      image: `/assets/og/${g.slug}.png`,
      markdown: `/guides/${g.slug}.md`,
      published: g.published,
      updated: g.updated,
      jsonLd: [articleLd(c, g), faqPage(g.faqs), breadcrumbs(c, trail)],
    },
  });
}

/** /guides/<slug>.md: the same guide as Markdown, for AI agents and anyone who wants plain text. */
export function guideMarkdownPage(c: Context<AppEnv>) {
  const g = findGuide(hostKind(c), (c.req.param('file') ?? '').replace(/\.md$/, ''));
  if (!g) return c.notFound();
  return c.body(guideMarkdown(c, g), 200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-robots-tag': 'noindex, follow' });
}

export async function guidesHub(c: Context<AppEnv>) {
  const kind = hostKind(c);
  const guides = guidesFor(kind);
  if (!guides.length) return c.notFound();
  const sections = [...new Set(guides.map((g) => g.section))];
  const data = kind === 'data';
  const h1 = data ? 'Guides: selling your business’s data' : 'Guides: buying a business with no money down';
  const intro = data
    ? 'What AI companies buy, what operational data is worth, and how owners of trading and closed businesses get paid for it.'
    : `Plain-English guides from ${BRAND.founder} on structuring acquisitions with commercial debt, seller finance and seller rollover, finding off-market deals and getting to a signed LOI.`;
  const main = `<div class="wrap">${crumbsHtml([{ name: 'Home', path: '/' }, { name: 'Guides', path: '/guides' }])}
<header class="hub-head"><h1>${esc(h1)}</h1><p>${esc(intro)}</p></header>
${sections.map((s) => `<section class="hub-section"><h2>${esc(s)}</h2>${cardsHtml(guides.filter((g) => g.section === s))}</section>`).join('')}</div>`;
  const nav = navFor(c);
  const name = c.get('settings').SITE_NAME || BRAND.name;
  return render(c, '/article.html', {
    title: 'Guides',
    slots: { nav_cta: esc(nav.label), nav_short: esc(nav.short) },
    hrefs: { cta: nav.cta },
    show: { main_host: kind === 'main' },
    blocks: { main },
    seo: {
      title: data ? `Selling Business Data to AI Companies: Guides | ${name}` : `How to Buy a Business With No Money Down: Guides | ${name}`,
      description: intro.slice(0, 160),
      path: '/guides',
      index: true,
      jsonLd: [
        { '@type': 'CollectionPage', name: h1, description: intro, hasPart: guides.map((g) => ({ '@type': 'Article', headline: g.h1, url: `${new URL(c.req.url).origin}/guides/${g.slug}` })) },
        breadcrumbs(c, [{ name: 'Home', path: '/' }, { name: 'Guides', path: '/guides' }]),
      ],
    },
  });
}

const mainOrigin = (c: Context<AppEnv>) => {
  try { if (c.get('settings').PUBLIC_URL) return new URL(c.get('settings').PUBLIC_URL).origin; } catch { /* fall through */ }
  return new URL(c.req.url).origin;
};

export async function aboutPage(c: Context<AppEnv>) {
  const name = c.get('settings').SITE_NAME || BRAND.name;
  const profiles = sameAs(c);
  const label = (u: string) => (/instagram/.test(u) ? 'Instagram' : /youtube/.test(u) ? 'YouTube' : /linkedin/.test(u) ? 'LinkedIn' : /x\.com|twitter/.test(u) ? 'X' : new URL(u).hostname);
  const structures = guidesFor('main').filter((g) => g.section === 'Deal structures');
  const main = `<div class="wrap">${crumbsHtml([{ name: 'Home', path: '/' }, { name: `About ${BRAND.founder}`, path: '/about' }])}
<div class="about-grid"><article>
<header class="g-head"><h1>${esc(BRAND.founder)}</h1><p class="lede">Founder of ${esc(name)} and JC Health Group. He helps owners of established businesses buy a competitor, or a business whose owner wants to retire, with no money down.</p></header>
<div class="prose">
<h2 id="how-he-bought">How Josh bought his own clinics</h2>
<p>Josh bought two of his own clinics with <strong>100% vendor finance</strong> (seller finance): no bank and no equity partner. The sellers were paid over time out of each business’s own cash flow. It works when an owner cares more about the right successor, their staff and a steady income than about a lump sum on day one, and it’s the reason he believes most owners can grow by acquisition long before they think they can afford to.</p>
<h2 id="what-the-firm-does">What ${esc(name)} does</h2>
<p>The firm works with owners of businesses doing around $1M+ in revenue. Together they find the target, often a competitor or a retiring owner’s business, structure the deal and line up the financing. The aim is a <strong>signed letter of intent within 90 days</strong> on an acquisition that can double or triple the business, structured at a debt service coverage ratio of around 1.5x and over-financed so working capital and closing costs are covered. It’s done with the owner, not for them, and comes with a 7-day money-back guarantee.</p>
<h2 id="structures">The structures behind it</h2>
<p>Deals are funded with a mix of commercial (senior) debt, seller finance and seller rollover:</p>
<ul>
<li><strong>60/40:</strong> 60% commercial debt and 40% seller rollover, with no personal guarantee. The lender takes security over 100% of the business’s assets instead.</li>
<li><strong>70/20/10:</strong> 70% commercial debt, 20% seller finance and 10% seller rollover. Most retiring owners like this one.</li>
<li><strong>100% vendor finance:</strong> the seller funds the whole price and is paid over time from the business’s cash flow.</li>
</ul>
${structures.length ? `<p>Read more: ${structures.map((g) => `<a href="/guides/${esc(g.slug)}">${esc(g.h1)}</a>`).join(' · ')}.</p>` : ''}
</div>
<section class="g-cta"><h2>Talk to Josh’s team</h2><p>Watch the short video, then see if your business qualifies for an acquisition strategy call.</p><a class="btn" href="/#apply" data-track="cta_click" data-track-id="about_cta">See if you qualify →</a></section>
</article>
<aside class="about-card"><dl>
<div><dt>Role</dt><dd>Founder, ${esc(name)}<br>Founder, JC Health Group</dd></div>
<div><dt>Known for</dt><dd>No-money-down acquisitions using seller finance, seller rollover and commercial debt</dd></div>
${profiles.length ? `<div><dt>Profiles</dt><dd>${profiles.map((u) => `<a href="${esc(u)}" rel="me noopener" target="_blank">${esc(label(u))}</a>`).join(' · ')}</dd></div>` : ''}
</dl></aside></div></div>`;
  return render(c, '/article.html', {
    title: `About ${BRAND.founder}`,
    slots: { nav_cta: 'See if you qualify' },
    hrefs: { cta: '/#apply' },
    show: { main_host: true },
    blocks: { main },
    seo: {
      title: `${BRAND.founder}: Founder of ${name} | No-Money-Down Acquisitions`,
      description: `${BRAND.founder} founded ${name} and JC Health Group, and bought two of his own clinics with 100% vendor finance. He helps $1M+ owners buy businesses with no money down.`,
      path: '/about',
      index: true,
      type: 'profile',
      jsonLd: [
        { '@type': 'ProfilePage', mainEntity: { '@id': personId(c) }, about: { '@id': orgId(c) } },
        breadcrumbs(c, [{ name: 'Home', path: '/' }, { name: `About ${BRAND.founder}`, path: '/about' }]),
      ],
    },
  });
}

const text = (body: string, type = 'text/plain') => (c: Context<AppEnv>) => c.body(body, 200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'public, max-age=3600' });
export const robotsRoute = (c: Context<AppEnv>) => text(robotsTxt(c))(c);
export const sitemapRoute = (c: Context<AppEnv>) => text(sitemapXml(c), 'application/xml')(c);
export const llmsRoute = (c: Context<AppEnv>) => text(llmsTxt(c, false))(c);
export const llmsFullRoute = (c: Context<AppEnv>) => text(llmsTxt(c, true))(c);

/**
 * Search + AI-search visibility: which pages may be indexed, the <head> tags (canonical, Open Graph,
 * X cards, JSON-LD), robots.txt with the AI crawlers named, sitemap.xml and llms.txt.
 *
 * Indexable: the main page, the 20 industry pages, the guides, /about, /privacy, and the data and
 * webinar sign-up pages. Never: the application, booking, breakout, resources, webinar rooms,
 * admin, APIs, tracked links, previews.
 */
import type { Context } from 'hono';
import type { AppEnv } from '../app';
import { BRAND } from '../config';
import { INDUSTRIES } from '../landers/catalog';
import { isDataHost } from '../data/data';
import { isWebinarHost } from '../webinar/pages';
import { flag } from '../settings';
import type { Guide } from './types';
import { GUIDES } from './guides';
import { stripMarkdown } from './markdown';

export type HostKind = 'main' | 'data' | 'webinar';

export const hostKind = (c: Context<AppEnv>): HostKind => (isDataHost(c) ? 'data' : isWebinarHost(c) ? 'webinar' : 'main');

/** The canonical origin for this host: the configured address, else the request's own. */
export function hostOrigin(c: Context<AppEnv>, kind: HostKind = hostKind(c)) {
  const s = c.get('settings');
  const configured = kind === 'data' ? s.DATA_URL : kind === 'webinar' ? s.WEBINAR_URL : s.PUBLIC_URL;
  try { if (configured) return new URL(configured).origin; } catch { /* fall through */ }
  return new URL(c.req.url).origin;
}

export const indexingOn = (c: Context<AppEnv>) => flag(c.get('settings').SEO_INDEXING, true);

export const guidesFor = (kind: HostKind): Guide[] => (kind === 'webinar' ? [] : GUIDES.filter((g) => (g.host ?? 'main') === kind));
export const findGuide = (kind: HostKind, slug: string) => guidesFor(kind).find((g) => g.slug === slug) ?? null;

/** Public profiles that identify Josh / the firm (schema.org sameAs). */
export function sameAs(c: Context<AppEnv>): string[] {
  const raw = c.get('settings').SEO_SAME_AS || 'https://www.instagram.com/officialjoshli/, https://www.youtube.com/channel/UCaJNq5_e7ognPLRqS6n-gCA';
  return raw.split(/[,\s]+/).map((u) => u.trim()).filter((u) => /^https:\/\/[^\s"<>]+$/.test(u)).slice(0, 12);
}

export interface SeoMeta {
  /** Full <title> (no suffix added). */
  title: string;
  description: string;
  /** Canonical path on this host ('/', '/dental', '/guides/x'). */
  path: string;
  /** Canonical origin when it isn't this host (e.g. /data on the main domain → the data site). */
  origin?: string;
  index: boolean;
  type?: 'website' | 'article' | 'profile';
  /** Absolute or root-relative 1200×630 image for link previews. */
  image?: string;
  jsonLd?: Record<string, unknown>[];
  /** Root-relative URL of a Markdown copy of the page (for AI agents). */
  markdown?: string;
  published?: string;
  updated?: string;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** JSON for a <script> block: no "</script>" breakouts. */
const ldJson = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

export const DEFAULT_OG = '/assets/og/default.png';

/** Head tags for an indexable (or deliberately noindex) page. */
export function seoHead(c: Context<AppEnv>, m: SeoMeta): string {
  const s = c.get('settings');
  const origin = m.origin ?? hostOrigin(c);
  const url = `${origin}${m.path}`;
  const image = m.image ? (m.image.startsWith('http') ? m.image : `${origin}${m.image}`) : `${origin}${DEFAULT_OG}`;
  const index = m.index && indexingOn(c);
  const tags = [
    `<link rel="canonical" href="${attr(url)}">`,
    `<meta name="robots" content="${index ? 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1' : 'noindex, nofollow'}">`,
    `<meta property="og:type" content="${m.type ?? 'website'}">`,
    `<meta property="og:site_name" content="${attr(s.SITE_NAME || BRAND.name)}">`,
    `<meta property="og:title" content="${attr(m.title)}">`,
    `<meta property="og:description" content="${attr(m.description)}">`,
    `<meta property="og:url" content="${attr(url)}">`,
    `<meta property="og:image" content="${attr(image)}">`,
    '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${attr(m.title)}">`,
    `<meta name="twitter:description" content="${attr(m.description)}">`,
    `<meta name="twitter:image" content="${attr(image)}">`,
  ];
  const handle = (s.X_HANDLE || '').trim().replace(/^@?/, '@');
  if (/^@\w{1,15}$/.test(handle)) tags.push(`<meta name="twitter:site" content="${attr(handle)}"><meta name="twitter:creator" content="${attr(handle)}">`);
  if (m.published) tags.push(`<meta property="article:published_time" content="${attr(m.published)}">`);
  if (m.updated) tags.push(`<meta property="article:modified_time" content="${attr(m.updated)}">`);
  if (m.markdown) tags.push(`<link rel="alternate" type="text/markdown" href="${attr(origin + m.markdown)}" title="Markdown">`);
  tags.push(`<link rel="alternate" type="text/plain" href="${attr(origin)}/llms.txt" title="llms.txt">`);
  if (s.GOOGLE_SITE_VERIFICATION && /^[\w-]{10,100}$/.test(s.GOOGLE_SITE_VERIFICATION.trim())) tags.push(`<meta name="google-site-verification" content="${attr(s.GOOGLE_SITE_VERIFICATION.trim())}">`);
  if (s.BING_SITE_VERIFICATION && /^[\w-]{10,100}$/.test(s.BING_SITE_VERIFICATION.trim())) tags.push(`<meta name="msvalidate.01" content="${attr(s.BING_SITE_VERIFICATION.trim())}">`);
  const graph = [...baseGraph(c), ...(m.jsonLd ?? [])];
  tags.push(`<script type="application/ld+json">${ldJson({ '@context': 'https://schema.org', '@graph': graph })}</script>`);
  return tags.join('\n');
}

// ───────────────────────────── Structured data ─────────────────────────────

export function orgId(c: Context<AppEnv>) { return `${hostOrigin(c, 'main')}/#organization`; }
export function personId(c: Context<AppEnv>) { return `${hostOrigin(c, 'main')}/about#josh-li`; }

/** Organisation, founder and website: on every page so every page carries the entity. */
function baseGraph(c: Context<AppEnv>): Record<string, unknown>[] {
  const main = hostOrigin(c, 'main');
  const origin = hostOrigin(c);
  const name = c.get('settings').SITE_NAME || BRAND.name;
  return [
    {
      '@type': ['Organization', 'ProfessionalService'],
      '@id': orgId(c),
      name,
      url: `${main}/`,
      logo: `${main}/assets/og/logo.png`,
      description: 'G&L M&A Advisory helps owners of established businesses buy competitors and retiring owners’ businesses with no money down, using commercial debt, seller finance and seller rollover.',
      founder: { '@id': personId(c) },
      knowsAbout: ['Business acquisitions', 'Seller finance', 'Vendor finance', 'Seller rollover', 'Leveraged buyouts', 'Debt service coverage ratio', 'Letters of intent', 'Due diligence', 'Mergers and acquisitions'],
      sameAs: sameAs(c),
    },
    {
      '@type': 'Person',
      '@id': personId(c),
      name: BRAND.founder,
      url: `${main}/about`,
      jobTitle: 'Founder',
      worksFor: { '@id': orgId(c) },
      description: 'Founder of G&L M&A Advisory and JC Health Group. Bought two of his own clinics with 100% seller (vendor) finance.',
      knowsAbout: ['Seller finance', 'Vendor finance', 'Seller rollover', 'Business acquisitions', 'Healthcare clinic acquisitions'],
      sameAs: sameAs(c),
    },
    { '@type': 'WebSite', '@id': `${origin}/#website`, url: `${origin}/`, name, publisher: { '@id': orgId(c) }, inLanguage: 'en' },
  ];
}

export function breadcrumbs(c: Context<AppEnv>, items: { name: string; path: string }[]) {
  const origin = hostOrigin(c);
  return { '@type': 'BreadcrumbList', itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: `${origin}${it.path}` })) };
}

export function faqPage(faqs: { q: string; a: string }[]) {
  const text = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  return { '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: text(f.q), acceptedAnswer: { '@type': 'Answer', text: text(f.a) } })) };
}

export function articleLd(c: Context<AppEnv>, g: Guide) {
  const origin = hostOrigin(c);
  const url = `${origin}/guides/${g.slug}`;
  return {
    '@type': 'Article',
    '@id': `${url}#article`,
    headline: g.h1,
    description: g.description,
    abstract: g.answer,
    url,
    mainEntityOfPage: url,
    image: `${origin}/assets/og/${g.slug}.png`,
    datePublished: g.published,
    dateModified: g.updated,
    author: { '@id': personId(c) },
    publisher: { '@id': orgId(c) },
    articleSection: g.section,
    wordCount: stripMarkdown(g.body).split(' ').length,
    inLanguage: 'en',
    isAccessibleForFree: true,
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['.guide-answer', 'h1'] },
  };
}

// ───────────────────────────── robots.txt / sitemap / llms.txt ─────────────────────────────

/** Search engines and AI crawlers welcomed by name (listing them makes the intent unambiguous). */
export const AI_CRAWLERS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', // OpenAI: training, ChatGPT search, live browsing
  'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'anthropic-ai', // Anthropic
  'PerplexityBot', 'Perplexity-User', // Perplexity
  'Google-Extended', 'GoogleOther', // Gemini / AI Overviews grounding
  'Applebot', 'Applebot-Extended', // Siri / Apple Intelligence
  'Bingbot', 'msnbot', // Bing → ChatGPT search, Copilot
  'meta-externalagent', 'Meta-ExternalFetcher', // Meta AI
  'xAI-Bot', 'GrokBot', // xAI / Grok
  'DuckAssistBot', 'YouBot', 'MistralAI-User', 'cohere-ai', 'Amazonbot', 'CCBot',
];

const PRIVATE_PATHS = ['/admin', '/api/', '/hooks/', '/apply', '/book', '/breakout', '/resources', '/w/', '/u/', '/r/', '/o/', '/s/', '/l/', '/go/', '/ph/', '/registered/', '/room/', '/replay/', '/ics/', '/webinar/registered/', '/webinar/room/', '/webinar/replay/', '/*?*hq_preview='];

export function robotsTxt(c: Context<AppEnv>) {
  const origin = hostOrigin(c);
  if (!indexingOn(c)) return 'User-agent: *\nDisallow: /\n';
  const disallow = PRIVATE_PATHS.map((p) => `Disallow: ${p}`).join('\n');
  const groups = ['*', ...AI_CRAWLERS].map((ua) => `User-agent: ${ua}\nAllow: /\n${disallow}`).join('\n\n');
  return `# ${c.get('settings').SITE_NAME || BRAND.name}\n# Search engines and AI assistants are welcome to read, index and cite the public pages and guides.\n# Summary for AI: ${origin}/llms.txt\n\n${groups}\n\nSitemap: ${origin}/sitemap.xml\n`;
}

interface SitemapEntry { path: string; lastmod: string; priority: number }

export function sitemapEntries(c: Context<AppEnv>, kind: HostKind = hostKind(c)): SitemapEntry[] {
  const guides = guidesFor(kind);
  const latest = guides.reduce((m, g) => (g.updated > m ? g.updated : m), '2026-10-14');
  if (kind === 'webinar') return [{ path: '/', lastmod: latest, priority: 0.8 }];
  const out: SitemapEntry[] = [{ path: '/', lastmod: latest, priority: 1 }];
  if (kind === 'main') {
    out.push({ path: '/about', lastmod: latest, priority: 0.7 });
    for (const i of INDUSTRIES) out.push({ path: `/${i.id}`, lastmod: latest, priority: 0.8 });
  }
  if (guides.length) out.push({ path: '/guides', lastmod: latest, priority: 0.9 });
  for (const g of guides) out.push({ path: `/guides/${g.slug}`, lastmod: g.updated, priority: g.section === 'Industries' ? 0.7 : 0.8 });
  if (kind === 'main') out.push({ path: '/privacy', lastmod: latest, priority: 0.2 });
  return out;
}

export function sitemapXml(c: Context<AppEnv>) {
  const origin = hostOrigin(c);
  const urls = sitemapEntries(c).map((e) => `  <url><loc>${attr(origin + e.path)}</loc><lastmod>${e.lastmod}</lastmod><priority>${e.priority.toFixed(1)}</priority></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

const OFFER = [
  'G&L M&A Advisory, founded by Josh Li, helps owners of established businesses (typically $1M+ revenue) buy a competitor, or a business whose owner wants to retire, with no money down.',
  'The promise: a signed letter of intent (LOI) within 90 days on an acquisition that can double or triple the business. Deals are over-financed (the financing covers the price plus working capital and closing costs), structured at a debt service coverage ratio (DSCR) of around 1.5x, done with the owner (not for them), with a 7-day money-back guarantee.',
  'Deals are funded with a mix of commercial (senior) debt, seller finance (vendor finance) and seller rollover (the seller keeps a minority stake). Structures the firm uses: 60/40 (60% commercial debt, 40% seller rollover, no personal guarantee, the lender secured over 100% of the business’s assets); 70/20/10 (70% commercial debt, 20% seller finance, 10% seller rollover); and 100% vendor finance (the seller funds the whole price, paid over time from the business’s cash flow).',
  'Josh Li is also the founder of JC Health Group and bought two of his own clinics with 100% vendor finance.',
];

export function llmsTxt(c: Context<AppEnv>, full = false) {
  const kind = hostKind(c);
  const origin = hostOrigin(c);
  const main = hostOrigin(c, 'main');
  const name = c.get('settings').SITE_NAME || BRAND.name;
  const guides = guidesFor(kind);
  const lines: string[] = [];
  if (kind === 'data') {
    lines.push(`# ${name}: get paid for your business’s operational data`, '',
      '> G&L M&A Advisory refers established business owners to an AI data buyer with around $1 billion committed to buying anonymised operational data (workflows, job and service history, scheduling, maintenance logs; not customer personal data). Deals typically land between $200,000 and $2 million. No equity, no loan, no change of control. Closed or sold businesses can qualify if the owner still holds the records. G&L may receive a referral fee from the partner, which does not reduce what the owner is paid.', '',
      `- [Claim a data valuation](${origin}/): the page with the video and the one-minute claim form.`,
      `- [Business acquisitions (main site)](${main}/llms.txt): G&L’s no-money-down acquisition advisory.`, '');
  } else {
    lines.push(`# ${name}`, '', `> ${OFFER[0]} ${OFFER[1]}`, '', OFFER[2], '', OFFER[3], '',
      '## Key pages', '',
      `- [Main page: see if you qualify](${main}/): the video and the application for an acquisition strategy call.`,
      `- [About Josh Li](${main}/about): background and the deals behind the method.`,
      `- [All guides](${main}/guides): plain-English guides to buying a business with no money down.`, '',
      '## Industry pages', '',
      ...INDUSTRIES.map((i) => `- [${i.label}](${main}/${i.id}): no-money-down acquisitions for ${i.owners}.`), '');
  }
  const bySection = new Map<string, Guide[]>();
  for (const g of guides) bySection.set(g.section, [...(bySection.get(g.section) ?? []), g]);
  for (const [section, list] of bySection) {
    lines.push(`## ${section}`, '');
    for (const g of list) {
      if (full) lines.push(...guideMarkdown(c, g).split('\n'), '', '---', '');
      else lines.push(`- [${g.h1}](${origin}/guides/${g.slug}): ${g.answer}`);
    }
    lines.push('');
  }
  if (!full && guides.length) lines.push('## Optional', '', `- [Every guide in full (Markdown)](${origin}/llms-full.txt)`, '');
  return lines.join('\n');
}

/** A guide as clean Markdown (served at /guides/<slug>.md and in llms-full.txt). */
export function guideMarkdown(c: Context<AppEnv>, g: Guide) {
  const origin = hostOrigin(c);
  const abs = (md: string) => md.replace(/\]\((\/[^)]*)\)/g, (_m, p: string) => `](${origin}${p})`);
  return [
    `# ${g.h1}`, '',
    `Source: ${origin}/guides/${g.slug} · By ${BRAND.founder}, ${c.get('settings').SITE_NAME || BRAND.name} · Updated ${g.updated}`, '',
    `**Short answer:** ${g.answer}`, '',
    '**Key points:**', ...g.keyPoints.map((k) => `- ${k}`), '',
    abs(g.body.trim()), '',
    '## FAQ', '', ...g.faqs.flatMap((f) => [`### ${f.q}`, '', f.a, '']),
  ].join('\n');
}

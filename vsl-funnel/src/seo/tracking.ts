/**
 * Search & AI search tracking: which crawlers read which pages (crawler_hits), which visitors
 * and leads arrive from AI assistants and search engines, how the guides perform, and IndexNow
 * (instant indexing on Bing, which feeds ChatGPT search and Copilot, plus Yandex and others).
 */
import type { Context } from 'hono';
import type { AppEnv } from '../app';
import type { Env } from '../env';
import { GUIDES } from './guides';
import { platformOf } from '../lib/attribution';
import { type HostKind, hostKind, hostOrigin, indexingOn, sitemapEntries } from './seo';

/** Crawler name → who runs it and what it's for. Order matters: first match wins. */
export const CRAWLERS: { bot: string; re: RegExp; vendor: string; purpose: 'AI search' | 'AI answer (live)' | 'AI training' | 'Search engine' }[] = [
  { bot: 'OAI-SearchBot', re: /OAI-SearchBot/i, vendor: 'OpenAI (ChatGPT)', purpose: 'AI search' },
  { bot: 'ChatGPT-User', re: /ChatGPT-User/i, vendor: 'OpenAI (ChatGPT)', purpose: 'AI answer (live)' },
  { bot: 'GPTBot', re: /GPTBot/i, vendor: 'OpenAI (ChatGPT)', purpose: 'AI training' },
  { bot: 'Claude-SearchBot', re: /Claude-SearchBot/i, vendor: 'Anthropic (Claude)', purpose: 'AI search' },
  { bot: 'Claude-User', re: /Claude-User/i, vendor: 'Anthropic (Claude)', purpose: 'AI answer (live)' },
  { bot: 'ClaudeBot', re: /ClaudeBot|anthropic-ai/i, vendor: 'Anthropic (Claude)', purpose: 'AI training' },
  { bot: 'Perplexity-User', re: /Perplexity-User/i, vendor: 'Perplexity', purpose: 'AI answer (live)' },
  { bot: 'PerplexityBot', re: /PerplexityBot/i, vendor: 'Perplexity', purpose: 'AI search' },
  { bot: 'Grok / xAI', re: /grok|xai-?bot|x\.ai/i, vendor: 'xAI (Grok)', purpose: 'AI search' },
  { bot: 'Google-Extended / GoogleOther', re: /GoogleOther|Google-Extended|Google-CloudVertexBot/i, vendor: 'Google (Gemini)', purpose: 'AI training' },
  { bot: 'Googlebot', re: /Googlebot|Google-InspectionTool/i, vendor: 'Google', purpose: 'Search engine' },
  { bot: 'Bingbot', re: /bingbot|msnbot|BingPreview/i, vendor: 'Microsoft (Bing, Copilot, ChatGPT search)', purpose: 'Search engine' },
  { bot: 'Applebot', re: /Applebot/i, vendor: 'Apple (Siri, Apple Intelligence)', purpose: 'Search engine' },
  { bot: 'Meta AI', re: /meta-externalagent|meta-externalfetcher/i, vendor: 'Meta (Meta AI)', purpose: 'AI search' },
  { bot: 'DuckAssistBot', re: /DuckAssistBot/i, vendor: 'DuckDuckGo', purpose: 'AI answer (live)' },
  { bot: 'DuckDuckBot', re: /DuckDuckBot/i, vendor: 'DuckDuckGo', purpose: 'Search engine' },
  { bot: 'MistralAI-User', re: /MistralAI-User/i, vendor: 'Mistral (Le Chat)', purpose: 'AI answer (live)' },
  { bot: 'YouBot', re: /YouBot/i, vendor: 'You.com', purpose: 'AI search' },
  { bot: 'Amazonbot', re: /Amazonbot/i, vendor: 'Amazon (Alexa)', purpose: 'AI search' },
  { bot: 'CCBot', re: /CCBot/i, vendor: 'Common Crawl (used by many AI models)', purpose: 'AI training' },
  { bot: 'cohere-ai', re: /cohere-ai|cohere-training/i, vendor: 'Cohere', purpose: 'AI training' },
  { bot: 'Bytespider', re: /Bytespider/i, vendor: 'ByteDance', purpose: 'AI training' },
  { bot: 'YandexBot', re: /YandexBot/i, vendor: 'Yandex', purpose: 'Search engine' },
];

export const crawlerOf = (ua: string | null | undefined) => (ua ? CRAWLERS.find((c) => c.re.test(ua)) ?? null : null);

/** Records a crawler fetch (one row per day × bot × page, counted). Never blocks the response. */
export function logCrawler(c: Context<AppEnv>) {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return;
  const hit = crawlerOf(c.req.header('user-agent'));
  if (!hit) return;
  const path = new URL(c.req.url).pathname.slice(0, 200);
  if (/^\/(admin|api|hooks|ph|media)(\/|$)/.test(path)) return;
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const p = c.env.DB.prepare(
    `INSERT INTO crawler_hits (day, bot, host, path, hits, last_at) VALUES (?,?,?,?,1,?)
     ON CONFLICT(day, bot, host, path) DO UPDATE SET hits = hits + 1, last_at = excluded.last_at`,
  ).bind(day, hit.bot, hostKind(c), path, now).run().catch(() => null);
  try { c.executionCtx.waitUntil(p); } catch { /* tests: no execution context */ }
}

const AI = "'AI Search'";

/** Rolls source rows up to named platforms (Instagram, Google, ChatGPT…), biggest first. */
function byPlatform<T extends { source: string | null; ref?: string | null; medium?: string | null; sessions: number }>(rows: T[]) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = platformOf(r.source, r.ref ?? null, r.medium ?? null);
    m.set(k, (m.get(k) ?? 0) + r.sessions);
  }
  return [...m].map(([source, sessions]) => ({ source, sessions })).sort((a, b) => b.sessions - a.sessions);
}

export async function searchReport(c: Context<AppEnv>, from: number, to: number) {
  const env = c.env;
  const dayFrom = new Date(from).toISOString().slice(0, 10);
  const dayTo = new Date(to).toISOString().slice(0, 10);
  const q = <T>(sql: string, ...b: (string | number)[]) => env.DB.prepare(sql).bind(...b).all<T>().then((r) => r.results ?? []).catch(() => [] as T[]);

  const [bots, botDays, botPages, visits, refs, landings, leads, guideViews, guideCtas, articleFunnel, guideSources] = await Promise.all([
    q<{ bot: string; hits: number; pages: number; last_at: number }>(
      'SELECT bot, SUM(hits) AS hits, COUNT(DISTINCT host || path) AS pages, MAX(last_at) AS last_at FROM crawler_hits WHERE day BETWEEN ? AND ? GROUP BY bot ORDER BY hits DESC', dayFrom, dayTo),
    q<{ day: string; ai: number; search: number }>(
      `SELECT day, SUM(CASE WHEN bot IN (${CRAWLERS.filter((x) => x.purpose !== 'Search engine').map((x) => `'${x.bot}'`).join(',')}) THEN hits ELSE 0 END) AS ai,
              SUM(CASE WHEN bot IN (${CRAWLERS.filter((x) => x.purpose === 'Search engine').map((x) => `'${x.bot}'`).join(',')}) THEN hits ELSE 0 END) AS search
       FROM crawler_hits WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`, dayFrom, dayTo),
    q<{ host: string; path: string; hits: number; ai_hits: number; bots: string }>(
      `SELECT host, path, SUM(hits) AS hits,
              SUM(CASE WHEN bot IN (${CRAWLERS.filter((x) => x.purpose !== 'Search engine').map((x) => `'${x.bot}'`).join(',')}) THEN hits ELSE 0 END) AS ai_hits,
              GROUP_CONCAT(DISTINCT bot) AS bots
       FROM crawler_hits WHERE day BETWEEN ? AND ? GROUP BY host, path ORDER BY ai_hits DESC, hits DESC LIMIT 40`, dayFrom, dayTo),
    q<{ channel: string; sessions: number; visitors: number }>(
      `SELECT channel, COUNT(*) AS sessions, COUNT(DISTINCT visitor_id) AS visitors FROM sessions
       WHERE started_at BETWEEN ? AND ? AND is_bot = 0 AND channel IN (${AI}, 'Organic Search') GROUP BY channel`, from, to),
    q<{ channel: string; source: string; ref: string | null; medium: string | null; sessions: number }>(
      `SELECT channel, utm_source AS source, referrer_host AS ref, utm_medium AS medium, COUNT(*) AS sessions FROM sessions
       WHERE started_at BETWEEN ? AND ? AND is_bot = 0 AND channel IN (${AI}, 'Organic Search') GROUP BY 1, 2, 3, 4 ORDER BY sessions DESC LIMIT 100`, from, to),
    q<{ landing_path: string; ai: number; organic: number }>(
      `SELECT landing_path, SUM(CASE WHEN channel = ${AI} THEN 1 ELSE 0 END) AS ai, SUM(CASE WHEN channel = 'Organic Search' THEN 1 ELSE 0 END) AS organic FROM sessions
       WHERE started_at BETWEEN ? AND ? AND is_bot = 0 AND channel IN (${AI}, 'Organic Search') GROUP BY landing_path ORDER BY ai + organic DESC LIMIT 20`, from, to),
    q<{ channel: string; leads: number; applied: number; booked: number }>(
      `SELECT ft_channel AS channel, COUNT(*) AS leads, SUM(CASE WHEN app_completed_at IS NOT NULL THEN 1 ELSE 0 END) AS applied,
              SUM(CASE WHEN booked_at IS NOT NULL THEN 1 ELSE 0 END) AS booked
       FROM leads WHERE created_at BETWEEN ? AND ? AND ft_channel IN (${AI}, 'Organic Search') GROUP BY ft_channel`, from, to),
    q<{ path: string; views: number; visitors: number }>(
      `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM events
       WHERE name = 'page_view' AND is_bot = 0 AND ts BETWEEN ? AND ? AND (path LIKE '/guides%' OR path = '/about') GROUP BY path`, from, to),
    q<{ path: string; clicks: number }>(
      `SELECT path, COUNT(*) AS clicks FROM events
       WHERE name = 'cta_click' AND is_bot = 0 AND ts BETWEEN ? AND ? AND (path LIKE '/guides%' OR path = '/about') GROUP BY path`, from, to),
    // Per-article funnel: people who ENTERED the site on this page, and how far they got.
    q<{ path: string; landed: number; ai: number; organic: number; leads: number; applied: number; booked: number; won: number }>(
      `SELECT s.landing_path AS path,
              COUNT(DISTINCT s.visitor_id) AS landed,
              COUNT(DISTINCT CASE WHEN s.channel = ${AI} THEN s.visitor_id END) AS ai,
              COUNT(DISTINCT CASE WHEN s.channel = 'Organic Search' THEN s.visitor_id END) AS organic,
              COUNT(DISTINCT l.id) AS leads,
              COUNT(DISTINCT CASE WHEN l.app_completed_at IS NOT NULL THEN l.id END) AS applied,
              COUNT(DISTINCT CASE WHEN l.booked_at IS NOT NULL AND l.booking_cancelled_at IS NULL THEN l.id END) AS booked,
              COUNT(DISTINCT CASE WHEN l.status = 'won' THEN l.id END) AS won
       FROM sessions s LEFT JOIN leads l ON l.visitor_id = s.visitor_id
       WHERE s.started_at BETWEEN ? AND ? AND s.is_bot = 0 AND (s.landing_path LIKE '/guides/%' OR s.landing_path = '/about')
       GROUP BY s.landing_path`, from, to),
    // Where the people who entered on each article came from (named platform, worked out below).
    q<{ path: string; source: string | null; ref: string | null; medium: string | null; sessions: number }>(
      `SELECT landing_path AS path, utm_source AS source, referrer_host AS ref, utm_medium AS medium, COUNT(*) AS sessions FROM sessions
       WHERE started_at BETWEEN ? AND ? AND is_bot = 0 AND (landing_path LIKE '/guides%' OR landing_path = '/about') GROUP BY 1, 2, 3, 4`, from, to),
  ]);

  const meta = new Map(CRAWLERS.map((x) => [x.bot, x]));
  const views = new Map(guideViews.map((g) => [g.path, g]));
  const ctas = new Map(guideCtas.map((g) => [g.path, g.clicks]));
  const landed = new Map(articleFunnel.map((a) => [a.path, a]));
  const sourcesOf = (path: string) => byPlatform(guideSources.filter((r) => r.path === path)).slice(0, 4);
  const s = c.get('settings');
  const main = hostOrigin(c, 'main');
  return {
    bots: bots.map((b) => ({ ...b, vendor: meta.get(b.bot)?.vendor ?? '', purpose: meta.get(b.bot)?.purpose ?? '' })),
    botDays,
    botPages,
    visits,
    refs: [...new Map(refs.map((r) => [`${r.channel}|${platformOf(r.source, r.ref, r.medium)}`, { channel: r.channel, source: platformOf(r.source, r.ref, r.medium), sessions: 0 }])).values()]
      .map((x) => ({ ...x, sessions: refs.filter((r) => r.channel === x.channel && platformOf(r.source, r.ref, r.medium) === x.source).reduce((a, r) => a + r.sessions, 0) }))
      .sort((a, b) => b.sessions - a.sessions).slice(0, 25),
    landings,
    leads,
    guides: GUIDES.map((g) => {
      const path = `/guides/${g.slug}`;
      const v = views.get(path);
      const a = landed.get(path);
      return {
        slug: g.slug, h1: g.h1, section: g.section, host: g.host ?? 'main', url: `${main}${path}`,
        views: v?.views ?? 0, visitors: v?.visitors ?? 0, ctas: ctas.get(path) ?? 0,
        // "landed" = entered the site on this article; the funnel is for those people.
        landed: a?.landed ?? 0, fromSearch: a?.organic ?? 0, fromAi: a?.ai ?? 0,
        leads: a?.leads ?? 0, applied: a?.applied ?? 0, booked: a?.booked ?? 0, won: a?.won ?? 0,
        sources: sourcesOf(path),
      };
    }),
    setup: {
      indexing: indexingOn(c),
      google: Boolean(s.GOOGLE_SITE_VERIFICATION),
      bing: Boolean(s.BING_SITE_VERIFICATION),
      sameAs: Boolean(s.SEO_SAME_AS),
      xHandle: Boolean(s.X_HANDLE),
      sitemap: `${main}/sitemap.xml`,
      llms: `${main}/llms.txt`,
      robots: `${main}/robots.txt`,
      pages: sitemapEntries(c).length,
      guides: GUIDES.length,
      indexnowLast: await env.DB.prepare("SELECT value FROM kv_state WHERE key = 'indexnow:last'").first<{ value: string }>().then((r) => (r ? JSON.parse(r.value) : null)).catch(() => null),
    },
  };
}

/** One article in depth: where its visitors come from, what they searched, and how far they get. */
export async function articleReport(c: Context<AppEnv>, slug: string, from: number, to: number) {
  const g = GUIDES.find((x) => x.slug === slug);
  if (!g) return null;
  const host = (g.host ?? 'main') as HostKind;
  const path = `/guides/${slug}`;
  const env = c.env;
  const q = <T>(sql: string, ...b: (string | number)[]) => env.DB.prepare(sql).bind(...b).all<T>().then((r) => r.results ?? []).catch(() => [] as T[]);
  // Sessions that ENTERED on this article (landing_path), plus whether that visitor became a lead.
  const base = `FROM sessions s LEFT JOIN leads l ON l.visitor_id = s.visitor_id WHERE s.landing_path = ? AND s.started_at BETWEEN ? AND ? AND s.is_bot = 0`;
  const [funnel, channels, referrers, terms, countries, devices, views, series] = await Promise.all([
    q<{ landed: number; engaged: number; leads: number; applied: number; booked: number; won: number }>(
      `SELECT COUNT(DISTINCT s.visitor_id) AS landed,
              COUNT(DISTINCT CASE WHEN s.pageviews > 1 THEN s.visitor_id END) AS engaged,
              COUNT(DISTINCT l.id) AS leads,
              COUNT(DISTINCT CASE WHEN l.app_completed_at IS NOT NULL THEN l.id END) AS applied,
              COUNT(DISTINCT CASE WHEN l.booked_at IS NOT NULL AND l.booking_cancelled_at IS NULL THEN l.id END) AS booked,
              COUNT(DISTINCT CASE WHEN l.status = 'won' THEN l.id END) AS won ${base}`, path, from, to),
    q<{ channel: string; sessions: number }>(`SELECT s.channel AS channel, COUNT(*) AS sessions ${base} GROUP BY s.channel ORDER BY sessions DESC`, path, from, to),
    q<{ source: string | null; ref: string | null; medium: string | null; sessions: number }>(`SELECT s.utm_source AS source, s.referrer_host AS ref, s.utm_medium AS medium, COUNT(*) AS sessions ${base} GROUP BY 1, 2, 3 ORDER BY sessions DESC LIMIT 200`, path, from, to),
    // Search term if the ad/link carried one (utm_term); Google/Bing hide the query, so most are blank.
    q<{ term: string; sessions: number }>(`SELECT s.utm_term AS term, COUNT(*) AS sessions ${base} AND s.utm_term IS NOT NULL AND s.utm_term != '' GROUP BY term ORDER BY sessions DESC LIMIT 20`, path, from, to),
    q<{ country: string; sessions: number }>(`SELECT COALESCE(s.country, '??') AS country, COUNT(*) AS sessions ${base} GROUP BY country ORDER BY sessions DESC LIMIT 12`, path, from, to),
    q<{ device: string; sessions: number }>(`SELECT COALESCE(s.device, 'unknown') AS device, COUNT(*) AS sessions ${base} GROUP BY device ORDER BY sessions DESC`, path, from, to),
    q<{ views: number; readers: number }>(`SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS readers FROM events WHERE name = 'page_view' AND is_bot = 0 AND path = ? AND ts BETWEEN ? AND ?`, path, from, to),
    q<{ day: string; landed: number }>(`SELECT date(s.started_at / 1000, 'unixepoch') AS day, COUNT(DISTINCT s.visitor_id) AS landed ${base} GROUP BY day ORDER BY day`, path, from, to),
  ]);
  return {
    slug, h1: g.h1, section: g.section, host,
    url: `${hostOrigin(c, host)}${path}`,
    md: `${hostOrigin(c, host)}/guides/${slug}.md`,
    funnel: funnel[0] ?? { landed: 0, engaged: 0, leads: 0, applied: 0, booked: 0, won: 0 },
    views: views[0] ?? { views: 0, readers: 0 },
    channels, referrers: byPlatform(referrers).slice(0, 20),
    sites: referrers.filter((r) => r.ref).map((r) => ({ source: r.ref!, sessions: r.sessions })).slice(0, 20),
    terms, countries, devices, series,
  };
}

// ───────────────────────────── IndexNow ─────────────────────────────

/** A stable IndexNow key, created on first use and served at /<key>.txt. */
export async function indexNowKey(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM kv_state WHERE key = 'indexnow:key'").first<{ value: string }>();
  if (row?.value) return row.value;
  const key = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare("INSERT OR IGNORE INTO kv_state (key, value) VALUES ('indexnow:key', ?)").bind(key).run();
  const again = await env.DB.prepare("SELECT value FROM kv_state WHERE key = 'indexnow:key'").first<{ value: string }>();
  return again?.value ?? key;
}

/** GET /<key>.txt: proves to IndexNow that we own the host. */
export async function indexNowKeyFile(c: Context<AppEnv>) {
  const key = await indexNowKey(c.env);
  return c.req.param('file') === `${key}.txt` ? c.text(key) : c.notFound();
}

/** Tells Bing (→ ChatGPT search, Copilot), Yandex, Seznam and Naver about every public page right now. */
export async function submitIndexNow(c: Context<AppEnv>) {
  if (!indexingOn(c)) return { ok: false, error: 'Search indexing is switched off (Integrations → Search).' };
  const key = await indexNowKey(c.env);
  const hosts: HostKind[] = ['main'];
  const results: { host: string; urls: number; status: number }[] = [];
  for (const kind of hosts) {
    const origin = hostOrigin(c, kind);
    const host = new URL(origin).host;
    const urls = sitemapEntries(c, kind).map((e) => `${origin}${e.path}`);
    const body = JSON.stringify({ host, key, keyLocation: `${origin}/${key}.txt`, urlList: urls });
    // Bing first (it shares submissions with every IndexNow engine); the shared endpoint as a fallback.
    let res: Response | null = null;
    for (const endpoint of ['https://www.bing.com/indexnow', 'https://api.indexnow.org/indexnow']) {
      res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body }).catch(() => null);
      if (res && res.status >= 200 && res.status < 300) break;
    }
    results.push({ host, urls: urls.length, status: res?.status ?? 0 });
  }
  const ok = results.every((r) => r.status >= 200 && r.status < 300);
  await c.env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('indexnow:last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify({ at: Date.now(), results })).run();
  return { ok, results };
}

/**
 * Search & AI search tracking: which crawlers read which pages (crawler_hits), which visitors
 * and leads arrive from AI assistants and search engines, how the guides perform, and IndexNow
 * (instant indexing on Bing, which feeds ChatGPT search and Copilot, plus Yandex and others).
 */
import type { Context } from 'hono';
import type { AppEnv } from '../app';
import type { Env } from '../env';
import { GUIDES } from './guides';
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

export async function searchReport(c: Context<AppEnv>, from: number, to: number) {
  const env = c.env;
  const dayFrom = new Date(from).toISOString().slice(0, 10);
  const dayTo = new Date(to).toISOString().slice(0, 10);
  const q = <T>(sql: string, ...b: (string | number)[]) => env.DB.prepare(sql).bind(...b).all<T>().then((r) => r.results ?? []).catch(() => [] as T[]);

  const [bots, botDays, botPages, visits, refs, landings, leads, guideViews, guideCtas] = await Promise.all([
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
    q<{ channel: string; source: string; sessions: number }>(
      `SELECT channel, COALESCE(referrer_host, utm_source, '(unknown)') AS source, COUNT(*) AS sessions FROM sessions
       WHERE started_at BETWEEN ? AND ? AND is_bot = 0 AND channel IN (${AI}, 'Organic Search') GROUP BY 1, 2 ORDER BY sessions DESC LIMIT 25`, from, to),
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
  ]);

  const meta = new Map(CRAWLERS.map((x) => [x.bot, x]));
  const views = new Map(guideViews.map((g) => [g.path, g]));
  const ctas = new Map(guideCtas.map((g) => [g.path, g.clicks]));
  const s = c.get('settings');
  const main = hostOrigin(c, 'main');
  const dataOrigin = hostOrigin(c, 'data');
  return {
    bots: bots.map((b) => ({ ...b, vendor: meta.get(b.bot)?.vendor ?? '', purpose: meta.get(b.bot)?.purpose ?? '' })),
    botDays,
    botPages,
    visits,
    refs,
    landings,
    leads,
    guides: GUIDES.map((g) => {
      const path = `/guides/${g.slug}`;
      const v = views.get(path);
      return { slug: g.slug, h1: g.h1, section: g.section, host: g.host ?? 'main', url: `${(g.host ?? 'main') === 'data' ? dataOrigin : main}${path}`, views: v?.views ?? 0, visitors: v?.visitors ?? 0, ctas: ctas.get(path) ?? 0 };
    }),
    setup: {
      indexing: indexingOn(c),
      google: Boolean(s.GOOGLE_SITE_VERIFICATION),
      bing: Boolean(s.BING_SITE_VERIFICATION),
      sameAs: Boolean(s.SEO_SAME_AS),
      xHandle: Boolean(s.X_HANDLE),
      sitemap: `${main}/sitemap.xml`,
      dataSitemap: `${dataOrigin}/sitemap.xml`,
      llms: `${main}/llms.txt`,
      robots: `${main}/robots.txt`,
      pages: sitemapEntries(c).length,
      guides: GUIDES.length,
      indexnowLast: await env.DB.prepare("SELECT value FROM kv_state WHERE key = 'indexnow:last'").first<{ value: string }>().then((r) => (r ? JSON.parse(r.value) : null)).catch(() => null),
    },
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
  const hosts: HostKind[] = ['main', 'data'];
  const results: { host: string; urls: number; status: number }[] = [];
  for (const kind of hosts) {
    const origin = hostOrigin(c, kind);
    const host = new URL(origin).host;
    if (kind === 'data' && host === new URL(hostOrigin(c, 'main')).host) continue;
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

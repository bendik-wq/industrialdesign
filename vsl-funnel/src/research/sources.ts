import type { Runtime } from '../app';
import type { Competitor, ResearchConfig } from './config';

/**
 * Source clients for the Research department. Official, public APIs only, read at low frequency:
 *  - Reddit's Data API (OAuth app-only when a client id/secret is set, else the public .json listings with a
 *    descriptive User-Agent; the cron reads a few listings per run, far under Reddit's published limits).
 *  - Meta's Ad Library API (graph.facebook.com/<ver>/ads_archive) with a token that has Ad Library access.
 *  - YouTube Data API v3 search + videos (the existing YouTube key).
 * Each returns plain records; storing and deduping is in store.ts.
 */

export interface ResearchItemInput {
  id: string; source: 'reddit' | 'youtube' | 'voc'; kind: string; external_id: string; url: string | null;
  title: string | null; body: string | null; community: string | null; query: string | null;
  score: number; comments: number; published_at: number | null; lead_id?: string | null; revenue_band?: string | null;
}
export interface ResearchAdInput {
  id: string; page_id: string | null; page_name: string | null; tracked_as: string; body: string | null; title: string | null;
  description: string | null; caption: string | null; link_url: string | null; platforms: string[]; languages: string[];
  start_at: number | null; stop_at: number | null;
}

export const clip = (s: unknown, max: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null;
};

// ───────────── Reddit ─────────────

export const redditUserAgent = (cfg: ResearchConfig) => `web:gl-funnel-research:1.0 (by /u/${cfg.reddit.username || 'gl_funnel_research'})`;

/** App-only OAuth token (client credentials), cached in kv_state until shortly before it expires. */
async function redditToken(rt: Runtime, cfg: ResearchConfig): Promise<string | null> {
  if (!cfg.reddit.clientId || !cfg.reddit.clientSecret) return null;
  const row = await rt.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'research:reddit_token'").first<{ value: string }>().catch(() => null);
  if (row) { try { const v = JSON.parse(row.value) as { t: string; exp: number }; if (v.exp > Date.now() + 60_000) return v.t; } catch { /* refresh */ } }
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${cfg.reddit.clientId}:${cfg.reddit.clientSecret}`)}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': redditUserAgent(cfg) },
    body: 'grant_type=client_credentials',
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`Reddit sign-in failed (${body.error ?? res.status}). Check the Reddit app client ID and secret.`);
  await rt.env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('research:reddit_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify({ t: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 })).run().catch(() => null);
  return body.access_token;
}

async function redditGet<T>(rt: Runtime, cfg: ResearchConfig, path: string): Promise<T> {
  const token = await redditToken(rt, cfg);
  const url = token ? `https://oauth.reddit.com${path}` : `https://www.reddit.com${path.replace(/\?|$/, (m) => `.json${m}`)}`;
  const headers: Record<string, string> = { 'user-agent': redditUserAgent(cfg), accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (res.status === 429) throw new Error('Reddit rate limit reached; the next run continues.');
  if (!res.ok) throw new Error(`Reddit ${res.status} for ${path.split('?')[0]}`);
  return (await res.json()) as T;
}

interface RedditThing { kind: string; data: Record<string, any> }
interface RedditListing { data?: { children?: RedditThing[] } }

const redditPost = (d: Record<string, any>, query: string): ResearchItemInput | null => {
  if (!d?.id || d.over_18 || d.stickied) return null;
  const body = /^\[(removed|deleted)\]$/.test(String(d.selftext ?? '')) ? '' : d.selftext;
  return {
    id: `reddit:${d.name ?? `t3_${d.id}`}`, source: 'reddit', kind: 'post', external_id: String(d.name ?? `t3_${d.id}`),
    url: d.permalink ? `https://www.reddit.com${d.permalink}` : null, title: clip(d.title, 300), body: clip(body, 1200),
    community: d.subreddit ? `r/${d.subreddit}` : null, query, score: Number(d.score) || 0, comments: Number(d.num_comments) || 0,
    published_at: d.created_utc ? Math.round(Number(d.created_utc) * 1000) : null,
  };
};
const redditComment = (d: Record<string, any>, query: string, title: string | null): ResearchItemInput | null => {
  const text = String(d?.body ?? '');
  if (!d?.id || !text || /^\[(removed|deleted)\]$/.test(text) || text.length < 40 || d.stickied || d.distinguished === 'moderator') return null;
  return {
    id: `reddit:t1_${d.id}`, source: 'reddit', kind: 'comment', external_id: `t1_${d.id}`,
    url: d.permalink ? `https://www.reddit.com${d.permalink}` : null, title: title ? clip(`Re: ${title}`, 300) : null, body: clip(text, 1200),
    community: d.subreddit ? `r/${d.subreddit}` : null, query, score: Number(d.score) || 0, comments: 0,
    published_at: d.created_utc ? Math.round(Number(d.created_utc) * 1000) : null,
  };
};

/** Top posts of the week in one subreddit, plus the top comments of the most discussed ones. */
export async function redditSubreddit(rt: Runtime, cfg: ResearchConfig, sub: string, o: { commentsFor?: number } = {}) {
  const q = `r/${sub} top week`;
  const listing = await redditGet<RedditListing>(rt, cfg, `/r/${encodeURIComponent(sub)}/top?t=week&limit=25&raw_json=1`);
  const posts = (listing.data?.children ?? []).filter((c) => c.kind === 't3').map((c) => redditPost(c.data, q)).filter((x): x is ResearchItemInput => Boolean(x));
  const items: ResearchItemInput[] = [...posts];
  const discussed = [...posts].sort((a, b) => b.comments - a.comments).slice(0, o.commentsFor ?? 1).filter((p) => p.comments >= 5);
  for (const p of discussed) items.push(...(await redditComments(rt, cfg, p.external_id.replace(/^t3_/, ''), q, p.title)));
  return items;
}

export async function redditComments(rt: Runtime, cfg: ResearchConfig, postId: string, query: string, title: string | null) {
  const r = await redditGet<RedditListing[]>(rt, cfg, `/comments/${encodeURIComponent(postId)}?limit=30&depth=1&sort=top&raw_json=1`);
  const comments = Array.isArray(r) ? r[1]?.data?.children ?? [] : [];
  return comments.filter((c) => c.kind === 't1').map((c) => redditComment(c.data, query, title)).filter((x): x is ResearchItemInput => Boolean(x)).slice(0, 15);
}

/** Site-wide keyword search, newest relevant posts of the past month. */
export async function redditSearch(rt: Runtime, cfg: ResearchConfig, q: string) {
  const listing = await redditGet<RedditListing>(rt, cfg, `/search?q=${encodeURIComponent(q)}&sort=relevance&t=month&limit=25&type=link&raw_json=1`);
  return (listing.data?.children ?? []).filter((c) => c.kind === 't3').map((c) => redditPost(c.data, `search: ${q}`)).filter((x): x is ResearchItemInput => Boolean(x));
}

// ───────────── Meta Ad Library ─────────────

export const AD_LIBRARY_VERSION = 'v21.0';
const AD_FIELDS = 'id,page_id,page_name,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_descriptions,ad_creative_link_captions,ad_delivery_start_time,ad_delivery_stop_time,ad_snapshot_url,publisher_platforms,languages';

interface ArchiveAd {
  id: string; page_id?: string; page_name?: string; ad_creative_bodies?: string[]; ad_creative_link_titles?: string[]; ad_creative_link_descriptions?: string[];
  ad_creative_link_captions?: string[]; ad_delivery_start_time?: string; ad_delivery_stop_time?: string; ad_snapshot_url?: string; publisher_platforms?: string[]; languages?: string[];
}
const time = (s?: string) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

/** The snapshot URL Meta returns carries the access token; keep only the public Ad Library link for the ad. */
export const publicAdLink = (id: string) => `https://www.facebook.com/ads/library/?id=${encodeURIComponent(id)}`;

function toAd(a: ArchiveAd, trackedAs: string): ResearchAdInput {
  return {
    id: String(a.id), page_id: a.page_id ?? null, page_name: clip(a.page_name, 200), tracked_as: trackedAs,
    body: clip(a.ad_creative_bodies?.[0], 2000), title: clip(a.ad_creative_link_titles?.[0], 300), description: clip(a.ad_creative_link_descriptions?.[0], 500),
    caption: clip(a.ad_creative_link_captions?.[0], 200), link_url: publicAdLink(String(a.id)),
    platforms: (a.publisher_platforms ?? []).slice(0, 8), languages: (a.languages ?? []).slice(0, 8),
    start_at: time(a.ad_delivery_start_time), stop_at: time(a.ad_delivery_stop_time),
  };
}

async function adArchive(cfg: ResearchConfig, params: Record<string, string>, pages = 2) {
  if (!cfg.adToken) throw new Error('Add a Meta Ad Library token under Integrations → Research.');
  const q = new URLSearchParams({
    ad_type: 'ALL', ad_active_status: 'ALL', ad_reached_countries: JSON.stringify(cfg.adCountries.length ? cfg.adCountries : ['GB']),
    fields: AD_FIELDS, limit: '100', ...params, access_token: cfg.adToken,
  });
  let url: string | undefined = `https://graph.facebook.com/${AD_LIBRARY_VERSION}/ads_archive?${q}`;
  const out: ArchiveAd[] = [];
  for (let i = 0; url && i < pages; i++) {
    const res: Response = await fetch(url);
    const body = (await res.json().catch(() => ({}))) as { data?: ArchiveAd[]; paging?: { next?: string }; error?: { message?: string; code?: number } };
    if (!res.ok || body.error) {
      const msg = body.error?.message ?? `HTTP ${res.status}`;
      throw new Error(/permission|access|identity|OAuth|token/i.test(msg) ? `Meta Ad Library refused the token (${msg}). The token needs Ad Library API access: confirm your identity at facebook.com/ID, then create the token from an app with Ad Library access.` : `Meta Ad Library: ${msg}`);
    }
    out.push(...(body.data ?? []));
    url = body.paging?.next;
  }
  return out;
}

/** One competitor's ads: by page ID when known (exact), otherwise by name, keeping only ads from pages with that name. */
export async function adsForCompetitor(cfg: ResearchConfig, c: Competitor) {
  if (c.pageId) return (await adArchive(cfg, { search_page_ids: JSON.stringify([c.pageId]) })).map((a) => toAd(a, c.name));
  const want = c.name.toLowerCase();
  const ads = await adArchive(cfg, { search_terms: c.name, search_type: 'KEYWORD_EXACT_PHRASE' }, 1);
  return ads.map((a) => toAd(a, (a.page_name ?? '').toLowerCase().includes(want) ? c.name : `search: ${c.name}`));
}

export async function adsForKeyword(cfg: ResearchConfig, q: string) {
  return (await adArchive(cfg, { search_terms: q }, 1)).map((a) => toAd(a, `search: ${q}`));
}

export const daysRunning = (a: { start_at: number | null; stop_at: number | null }, now = Date.now()) =>
  a.start_at ? Math.max(0, Math.floor(((a.stop_at ?? now) - a.start_at) / 86400_000)) : null;

// ───────────── YouTube ─────────────

/** YouTube search snippets arrive HTML-escaped (&#39;, &amp;). */
const unescape = (s?: string) => (s ?? '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Most viewed videos of the last 30 days for a search, with view counts (search costs 100 quota units, videos 1). */
export async function youtubeSearch(cfg: ResearchConfig, q: string, now = Date.now()) {
  if (!cfg.ytKey) throw new Error('Add the YouTube Data API key under Integrations → Content.');
  const after = new Date(now - 30 * 86400_000).toISOString();
  const sp = new URLSearchParams({ part: 'snippet', type: 'video', order: 'viewCount', maxResults: '15', q, publishedAfter: after, relevanceLanguage: 'en', key: cfg.ytKey });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${sp}`);
  const body = (await res.json().catch(() => ({}))) as { items?: { id?: { videoId?: string }; snippet?: { title?: string; description?: string; channelTitle?: string; publishedAt?: string } }[]; error?: { message?: string } };
  if (!res.ok || body.error) throw new Error(`YouTube: ${body.error?.message ?? res.status}`);
  const found = (body.items ?? []).filter((i) => i.id?.videoId);
  if (!found.length) return [];
  const ids = found.map((i) => i.id!.videoId!).join(',');
  const vres = await fetch(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: 'statistics', id: ids, key: cfg.ytKey })}`);
  const vbody = (await vres.json().catch(() => ({}))) as { items?: { id: string; statistics?: { viewCount?: string; commentCount?: string } }[] };
  const stats = new Map((vbody.items ?? []).map((v) => [v.id, v.statistics ?? {}]));
  return found.map((i): ResearchItemInput => {
    const id = i.id!.videoId!;
    const st = stats.get(id) ?? {};
    return {
      id: `youtube:${id}`, source: 'youtube', kind: 'video', external_id: id, url: `https://www.youtube.com/watch?v=${id}`,
      title: clip(unescape(i.snippet?.title), 300), body: clip(unescape(i.snippet?.description), 600), community: clip(i.snippet?.channelTitle, 120), query: `youtube: ${q}`,
      score: Number(st.viewCount) || 0, comments: Number(st.commentCount) || 0, published_at: time(i.snippet?.publishedAt),
    };
  });
}

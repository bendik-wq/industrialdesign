import type { Env } from '../env';

/**
 * Tracked links: a short /l/<code> URL per video + placement. The redirect adds
 * utm_source/medium/campaign, utm_content=<code> and utm_term=<placement>, so the
 * normal attribution pipeline ties every visit, lead, booking and sale to it.
 */
export interface TrackedLink {
  code: string;
  label: string;
  kind: 'youtube' | 'custom';
  video_id: string | null;
  video_title: string | null;
  thumbnail: string | null;
  placement: string | null;
  dest_path: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  clicks: number;
  last_click_at: number | null;
  archived: number;
  created_at: number;
}

export const PLACEMENTS = ['description', 'pinned_comment', 'end_screen', 'card', 'community_post', 'shorts', 'channel_about', 'other'] as const;

const YT_ID = /^[\w-]{11}$/;

/** Video id from any YouTube URL shape (watch, youtu.be, shorts, live, embed) or a bare id. */
export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (YT_ID.test(s)) return s;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') return YT_ID.test(u.pathname.slice(1, 12)) ? u.pathname.slice(1, 12) : null;
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  const v = u.searchParams.get('v');
  if (v && YT_ID.test(v)) return v;
  const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/);
  return m ? m[1] : null;
}

export const slug = (s: string, max = 60) =>
  s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, max).replace(/-$/, '') || 'link';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newLinkCode(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Title + thumbnail via YouTube's public oEmbed endpoint (no API key). */
export async function youtubeMeta(id: string): Promise<{ title: string | null; thumbnail: string }> {
  const thumbnail = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
    if (!res.ok) return { title: null, thumbnail };
    const j = (await res.json()) as { title?: string };
    return { title: j.title?.slice(0, 200) ?? null, thumbnail };
  } catch {
    return { title: null, thumbnail };
  }
}

/** Where /l/<code> sends people, with the UTMs attached. */
export function linkTarget(origin: string, link: TrackedLink, incoming: URLSearchParams) {
  const url = new URL(link.dest_path || '/', origin);
  url.searchParams.set('utm_source', link.utm_source);
  url.searchParams.set('utm_medium', link.utm_medium);
  url.searchParams.set('utm_campaign', link.utm_campaign);
  url.searchParams.set('utm_content', link.code);
  if (link.placement) url.searchParams.set('utm_term', link.placement);
  // Pass through anything else on the short link (e.g. ?v=b to preview a variant).
  for (const [k, v] of incoming) if (!k.startsWith('utm_')) url.searchParams.set(k, v);
  return url.toString();
}

export const getLink = (env: Env, code: string) => env.DB.prepare('SELECT * FROM tracked_links WHERE code = ?').bind(code.toLowerCase()).first<TrackedLink>();

export interface LinkFunnel {
  code: string;
  clicks_total: number;
  visitors: number;
  sessions: number;
  vsl_viewers: number;
  leads: number;
  applications: number;
  qualified: number;
  booked: number;
  showed: number;
  won: number;
  revenue: number;
}

/**
 * Full funnel per link for a date range. `model` picks which touch gets credit
 * for a lead: 'first' (the link that first brought them) or 'last' (the link
 * they came through when they applied).
 */
export async function linkFunnels(env: Env, from: number, to: number, model: 'first' | 'last'): Promise<Map<string, LinkFunnel>> {
  const leadCol = model === 'first' ? 'l.ft_content' : 'l.utm_content';
  const [traffic, vsl, leads] = await Promise.all([
    env.DB.prepare(
      `SELECT s.utm_content AS code, COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions
         FROM sessions s JOIN tracked_links t ON t.code = s.utm_content
        WHERE s.started_at BETWEEN ? AND ? AND s.is_bot = 0 GROUP BY 1`,
    ).bind(from, to).all<{ code: string; visitors: number; sessions: number }>(),
    env.DB.prepare(
      `SELECT s.utm_content AS code, COUNT(DISTINCT v.visitor_id) AS viewers
         FROM vsl_views v JOIN sessions s ON s.id = v.session_id JOIN tracked_links t ON t.code = s.utm_content
        WHERE s.started_at BETWEEN ? AND ? AND s.is_bot = 0 GROUP BY 1`,
    ).bind(from, to).all<{ code: string; viewers: number }>(),
    env.DB.prepare(
      `SELECT ${leadCol} AS code, COUNT(*) AS leads,
              SUM(l.app_completed_at IS NOT NULL) AS applications,
              SUM(COALESCE(l.tier_override, l.tier) IN ('A', 'B')) AS qualified,
              SUM(l.booked_at IS NOT NULL) AS booked,
              SUM(l.status IN ('showed', 'won', 'lost')) AS showed,
              SUM(l.status = 'won') AS won,
              COALESCE(SUM(CASE WHEN l.status = 'won' THEN l.revenue ELSE 0 END), 0) AS revenue
         FROM leads l JOIN tracked_links t ON t.code = ${leadCol}
        WHERE l.created_at BETWEEN ? AND ? GROUP BY 1`,
    ).bind(from, to).all<Omit<LinkFunnel, 'clicks_total' | 'visitors' | 'sessions' | 'vsl_viewers'>>(),
  ]);
  const out = new Map<string, LinkFunnel>();
  const row = (code: string) => {
    let r = out.get(code);
    if (!r) out.set(code, (r = { code, clicks_total: 0, visitors: 0, sessions: 0, vsl_viewers: 0, leads: 0, applications: 0, qualified: 0, booked: 0, showed: 0, won: 0, revenue: 0 }));
    return r;
  };
  for (const t of traffic.results) Object.assign(row(t.code), { visitors: t.visitors, sessions: t.sessions });
  for (const v of vsl.results) row(v.code).vsl_viewers = v.viewers;
  for (const l of leads.results) Object.assign(row(l.code), l);
  return out;
}

import type { Runtime } from '../app';

export type Funnel = 'vsl' | 'webinar' | 'other';

/** First guess at the funnel a campaign feeds, from its name. Changeable per campaign in Funnel HQ. */
export const guessFunnel = (name: string | null): Funnel => (/webinar|masterclass|master class|workshop|training|live\b/i.test(name ?? '') ? 'webinar' : 'vsl');

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const div = (a: number, b: number) => (b > 0 ? a / b : null);
const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

interface CampaignRow {
  platform: string; campaign_id: string; name: string; funnel: Funnel; manual: boolean;
  spend: number; impressions: number; clicks: number; link_clicks: number;
  visitors: number; leads: number; registrants: number; applied: number; booked: number; won: number; revenue: number;
}

/**
 * Spend per campaign joined to what its traffic did. Visitors and leads are matched on utm_campaign
 * (tag Meta ads with utm_campaign={{campaign.name}} or {{campaign.id}}).
 */
export async function adsReport(rt: Runtime, from: number, to: number) {
  const db = rt.env.DB;
  const [spend, funnels, visits, leads] = await Promise.all([
    db.prepare(`SELECT platform, campaign_id, MAX(campaign_name) AS name, SUM(spend) AS spend, SUM(impressions) AS impressions, SUM(clicks) AS clicks,
                       SUM(link_clicks) AS link_clicks, MAX(source = 'manual') AS manual, MAX(currency) AS currency
                  FROM ad_spend WHERE day BETWEEN ? AND ? GROUP BY 1, 2 ORDER BY 4 DESC`).bind(ymd(from), ymd(to))
      .all<{ platform: string; campaign_id: string; name: string | null; spend: number; impressions: number; clicks: number; link_clicks: number; manual: number; currency: string | null }>(),
    db.prepare('SELECT platform, campaign_id, funnel FROM ad_campaigns').all<{ platform: string; campaign_id: string; funnel: Funnel }>(),
    db.prepare(`SELECT lower(utm_campaign) AS c, COUNT(DISTINCT visitor_id) AS visitors FROM sessions
                 WHERE utm_campaign IS NOT NULL AND is_bot = 0 AND started_at BETWEEN ? AND ? GROUP BY 1`).bind(from, to).all<{ c: string; visitors: number }>(),
    db.prepare(`SELECT lower(COALESCE(utm_campaign, ft_campaign)) AS c, COUNT(*) AS leads, SUM(webinar_registered_at IS NOT NULL) AS registrants,
                       SUM(app_completed_at IS NOT NULL) AS applied, SUM(booked_at IS NOT NULL AND booking_cancelled_at IS NULL) AS booked,
                       SUM(status = 'won') AS won, COALESCE(SUM(CASE WHEN status = 'won' THEN revenue END), 0) AS revenue
                  FROM leads WHERE COALESCE(utm_campaign, ft_campaign) IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY 1`).bind(from, to)
      .all<{ c: string; leads: number; registrants: number; applied: number; booked: number; won: number; revenue: number }>(),
  ]);
  const fmap = new Map(funnels.results.map((f) => [`${f.platform}|${f.campaign_id}`, f.funnel]));
  const vmap = new Map(visits.results.map((v) => [v.c, v.visitors]));
  const lmap = new Map(leads.results.map((l) => [l.c, l]));
  const pick = <T,>(m: Map<string, T>, ...keys: string[]) => { for (const k of keys) if (k && m.has(k)) return m.get(k); return undefined; };

  const campaigns: CampaignRow[] = spend.results.map((r) => {
    const keys = [norm(r.name), norm(r.campaign_id)];
    const l = pick(lmap, ...keys);
    return {
      platform: r.platform, campaign_id: r.campaign_id, name: r.name || r.campaign_id, manual: Boolean(r.manual),
      funnel: fmap.get(`${r.platform}|${r.campaign_id}`) ?? guessFunnel(r.name),
      spend: r.spend ?? 0, impressions: r.impressions ?? 0, clicks: r.clicks ?? 0, link_clicks: r.link_clicks ?? 0,
      visitors: pick(vmap, ...keys) ?? 0,
      leads: l?.leads ?? 0, registrants: l?.registrants ?? 0, applied: l?.applied ?? 0, booked: l?.booked ?? 0, won: l?.won ?? 0, revenue: l?.revenue ?? 0,
    };
  });
  const byFunnel = (['vsl', 'webinar', 'other'] as Funnel[]).map((f) => {
    const list = campaigns.filter((c) => c.funnel === f);
    const t = list.reduce((a, c) => ({ spend: a.spend + c.spend, link_clicks: a.link_clicks + c.link_clicks, visitors: a.visitors + c.visitors, leads: a.leads + c.leads, registrants: a.registrants + c.registrants, applied: a.applied + c.applied, booked: a.booked + c.booked, won: a.won + c.won, revenue: a.revenue + c.revenue }),
      { spend: 0, link_clicks: 0, visitors: 0, leads: 0, registrants: 0, applied: 0, booked: 0, won: 0, revenue: 0 });
    // Cost per landing-page visitor: our own count of visitors if the ads are tagged, else Meta's link clicks.
    return { funnel: f, campaigns: list.length, ...t, cpc: div(t.spend, t.visitors || t.link_clicks), costPerBooked: div(t.spend, t.booked), cac: div(t.spend, t.won), roas: div(t.revenue, t.spend) };
  });
  const currency = spend.results.find((r) => r.currency)?.currency ?? null;
  const synced = await db.prepare("SELECT value FROM settings WHERE key = '_meta_ads_synced_at'").first<{ value: string }>().catch(() => null);
  return { campaigns, byFunnel, currency, syncedAt: synced ? Number(synced.value) : null };
}

export async function setCampaignFunnel(rt: Runtime, platform: string, campaignId: string, funnel: string) {
  if (!['vsl', 'webinar', 'other'].includes(funnel)) throw new Error('funnel must be vsl, webinar or other');
  await rt.env.DB.prepare('INSERT INTO ad_campaigns (platform, campaign_id, funnel) VALUES (?, ?, ?) ON CONFLICT(platform, campaign_id) DO UPDATE SET funnel = excluded.funnel')
    .bind(platform.slice(0, 20), campaignId.slice(0, 120), funnel).run();
}

/** Spend typed in by hand (Google, YouTube, a sponsor…): one row per campaign per month. */
export async function addManualSpend(rt: Runtime, b: { platform?: unknown; campaign?: unknown; month?: unknown; spend?: unknown; clicks?: unknown; funnel?: unknown }) {
  const platform = ['google', 'youtube', 'meta', 'linkedin', 'tiktok', 'other'].includes(String(b.platform)) ? String(b.platform) : 'other';
  const name = String(b.campaign ?? '').trim().slice(0, 120);
  const month = String(b.month ?? '');
  const spend = Number(b.spend);
  if (!name) throw new Error('Name the campaign (use the same name as its utm_campaign tag).');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Pick a month');
  if (!Number.isFinite(spend) || spend < 0) throw new Error('Enter the amount spent');
  const id = `manual:${norm(name).replace(/[^a-z0-9]+/g, '-')}`;
  // Spread the month evenly over its days, so any date range picks up the right share.
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const clicks = Math.max(0, Math.round(Number(b.clicks) || 0));
  const now = Date.now();
  const stmts = Array.from({ length: days }, (_, i) => rt.env.DB.prepare(
    `INSERT INTO ad_spend (platform, campaign_id, day, campaign_name, spend, link_clicks, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)
     ON CONFLICT(platform, campaign_id, day) DO UPDATE SET campaign_name = excluded.campaign_name, spend = excluded.spend, link_clicks = excluded.link_clicks, updated_at = excluded.updated_at`,
  ).bind(platform, id, `${month}-${String(i + 1).padStart(2, '0')}`, name, spend / days, Math.floor(clicks / days) + (i < clicks % days ? 1 : 0), now));
  await rt.env.DB.batch(stmts);
  if (b.funnel) await setCampaignFunnel(rt, platform, id, String(b.funnel));
  return { platform, campaign_id: id };
}

export async function deleteManualSpend(rt: Runtime, platform: string, campaignId: string) {
  await rt.env.DB.batch([
    rt.env.DB.prepare("DELETE FROM ad_spend WHERE platform = ? AND campaign_id = ? AND source = 'manual'").bind(platform, campaignId),
    rt.env.DB.prepare('DELETE FROM ad_campaigns WHERE platform = ? AND campaign_id = ?').bind(platform, campaignId),
  ]);
}

import type { Runtime } from '../app';
import { saveSettings } from '../settings';

/** Meta Marketing API: daily spend per campaign, pulled into ad_spend so every cost-per number uses real spend. */
const GRAPH = 'https://graph.facebook.com/v21.0';

export const metaAdsToken = (rt: Runtime) => rt.settings.META_ADS_TOKEN || rt.settings.META_ACCESS_TOKEN || '';
export const metaAdsConfigured = (rt: Runtime) => Boolean(metaAdsToken(rt) && rt.settings.META_AD_ACCOUNT_ID);
const actId = (raw: string) => `act_${raw.replace(/^act_/, '').replace(/\D/g, '')}`;

async function graph<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok || body.error) {
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    throw new Error(/permission|ads_read|ads_management/i.test(msg) ? `Meta says the token can’t read ad spend (${msg}). Make a token with the ads_read permission (Business Settings → System users) and paste it under Integrations → Ads.` : `Meta: ${msg}`);
  }
  return body;
}

/** Ad accounts the token can see, so the person picks one instead of hunting for the id. */
export async function listAdAccounts(rt: Runtime) {
  const token = metaAdsToken(rt);
  if (!token) throw new Error('Add a Meta token with the ads_read permission under Integrations → Ads first.');
  const r = await graph<{ data?: { id: string; account_id: string; name: string; currency: string; account_status: number }[] }>(
    `${GRAPH}/me/adaccounts?fields=id,account_id,name,currency,account_status&limit=100&access_token=${encodeURIComponent(token)}`,
  );
  return (r.data ?? []).map((a) => ({ id: a.account_id, name: a.name, currency: a.currency, active: a.account_status === 1 }));
}

export async function chooseAdAccount(rt: Runtime, id: string) {
  const clean = String(id).replace(/^act_/, '').replace(/\D/g, '');
  if (!clean) throw new Error('Pick an ad account');
  await saveSettings(rt.env, { META_AD_ACCOUNT_ID: clean });
  return clean;
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Pull the last `days` days (Meta revises recent numbers, so recent days are re-fetched every time). */
export async function syncMetaSpend(rt: Runtime, days = 7) {
  if (!metaAdsConfigured(rt)) return null;
  const token = metaAdsToken(rt);
  const range = JSON.stringify({ since: ymd(Date.now() - (days - 1) * 86400_000), until: ymd(Date.now()) });
  let url: string | undefined = `${GRAPH}/${actId(rt.settings.META_AD_ACCOUNT_ID)}/insights?level=campaign&time_increment=1&limit=500`
    + `&fields=campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,account_currency&time_range=${encodeURIComponent(range)}&access_token=${encodeURIComponent(token)}`;
  type Row = { campaign_id: string; campaign_name: string; spend?: string; impressions?: string; clicks?: string; inline_link_clicks?: string; account_currency?: string; date_start: string };
  const rows: Row[] = [];
  for (let page = 0; url && page < 20; page++) {
    const r: { data?: Row[]; paging?: { next?: string } } = await graph(url);
    rows.push(...(r.data ?? []));
    url = r.paging?.next;
  }
  const now = Date.now();
  const stmts = rows.map((r) => rt.env.DB.prepare(
    `INSERT INTO ad_spend (platform, campaign_id, day, campaign_name, spend, impressions, clicks, link_clicks, currency, source, updated_at)
     VALUES ('meta', ?, ?, ?, ?, ?, ?, ?, ?, 'sync', ?)
     ON CONFLICT(platform, campaign_id, day) DO UPDATE SET campaign_name = excluded.campaign_name, spend = excluded.spend, impressions = excluded.impressions,
       clicks = excluded.clicks, link_clicks = excluded.link_clicks, currency = excluded.currency, updated_at = excluded.updated_at`,
  ).bind(r.campaign_id, r.date_start, r.campaign_name, Number(r.spend) || 0, Number(r.impressions) || 0, Number(r.clicks) || 0, Number(r.inline_link_clicks) || 0, r.account_currency ?? null, now));
  for (let i = 0; i < stmts.length; i += 50) await rt.env.DB.batch(stmts.slice(i, i + 50));
  await rt.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('_meta_ads_synced_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(String(now), now).run().catch(() => null);
  return { rows: rows.length, spend: rows.reduce((a, r) => a + (Number(r.spend) || 0), 0) };
}

/** From the 5-minute cron: at most once an hour. */
export async function maybeSyncMetaSpend(rt: Runtime) {
  if (!metaAdsConfigured(rt)) return null;
  const last = await rt.env.DB.prepare("SELECT value FROM settings WHERE key = '_meta_ads_synced_at'").first<{ value: string }>().catch(() => null);
  if (last && Date.now() - Number(last.value) < 3600_000) return null;
  return syncMetaSpend(rt, 7);
}

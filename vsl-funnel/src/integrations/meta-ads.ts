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

// ───────────── Ad level: insights per ad per day, and the ads / ad sets / campaigns behind them ─────────────

/** Write access (ads_management) for approved autopilot changes. Never falls back to the read token. */
export const metaWriteToken = (rt: Runtime) => (rt.settings as Partial<Record<string, string>>).META_ADS_WRITE_TOKEN?.trim() || '';
export const metaWriteConfigured = (rt: Runtime) => Boolean(metaWriteToken(rt) && rt.settings.META_AD_ACCOUNT_ID);
export const adAccountPath = (rt: Runtime) => actId(rt.settings.META_AD_ACCOUNT_ID);

async function graphAll<T>(first: string, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = first;
  for (let page = 0; url && page < maxPages; page++) {
    const r: { data?: T[]; paging?: { next?: string } } = await graph(url);
    out.push(...(r.data ?? []));
    url = r.paging?.next;
  }
  return out;
}

export interface AdInsightRow {
  ad_id: string; ad_name?: string; adset_id?: string; adset_name?: string; campaign_id?: string; campaign_name?: string;
  spend?: string; impressions?: string; reach?: string; frequency?: string; clicks?: string; inline_link_clicks?: string;
  inline_link_click_ctr?: string; cost_per_inline_link_click?: string; account_currency?: string; date_start: string;
}
export interface EntityRow { id: string; name?: string; status?: string; effective_status?: string; campaign_id?: string; adset_id?: string; daily_budget?: string; creative?: { id?: string }; created_time?: string }

const num = (v: unknown) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const ms = (v: string | undefined) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

/**
 * Hourly: daily insights per ad for the last `days` days (spend, impressions, reach, frequency, link clicks,
 * link CTR, cost per link click) and the current state of every ad, ad set and campaign (status, daily budget,
 * creative). Our own results per ad (leads, tickets, bookings, deposits, deals) are joined at read time from
 * utm_content (tag ads with utm_content={{ad.id}}), see src/marketing/autopilot.ts.
 */
export async function syncAdLevel(rt: Runtime, days = 7) {
  if (!metaAdsConfigured(rt)) return null;
  const token = encodeURIComponent(metaAdsToken(rt));
  const act = adAccountPath(rt);
  const range = JSON.stringify({ since: ymd(Date.now() - (days - 1) * 86400_000), until: ymd(Date.now()) });
  const fields = 'ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,reach,frequency,clicks,inline_link_clicks,inline_link_click_ctr,cost_per_inline_link_click,account_currency';
  const rows = await graphAll<AdInsightRow>(`${GRAPH}/${act}/insights?level=ad&time_increment=1&limit=500&fields=${fields}&time_range=${encodeURIComponent(range)}&access_token=${token}`);
  const [ads, adsets, campaigns] = await Promise.all([
    graphAll<EntityRow>(`${GRAPH}/${act}/ads?fields=id,name,status,effective_status,adset_id,campaign_id,creative{id},created_time&limit=500&access_token=${token}`),
    graphAll<EntityRow>(`${GRAPH}/${act}/adsets?fields=id,name,status,effective_status,campaign_id,daily_budget,created_time&limit=500&access_token=${token}`),
    graphAll<EntityRow>(`${GRAPH}/${act}/campaigns?fields=id,name,status,effective_status,daily_budget,created_time&limit=500&access_token=${token}`),
  ]);
  return storeAdLevel(rt, rows, { ads, adsets, campaigns });
}

/** Writes what syncAdLevel fetched. */
export async function storeAdLevel(rt: Runtime, rows: AdInsightRow[], ents: { ads: EntityRow[]; adsets: EntityRow[]; campaigns: EntityRow[] }) {
  const now = Date.now();
  const db = rt.env.DB;
  const ins = rows.map((r) => db.prepare(
    `INSERT INTO ad_insights (ad_id, day, adset_id, campaign_id, ad_name, spend, impressions, reach, frequency, clicks, link_clicks, ctr, cpc, currency, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ad_id, day) DO UPDATE SET adset_id = excluded.adset_id, campaign_id = excluded.campaign_id, ad_name = excluded.ad_name, spend = excluded.spend,
       impressions = excluded.impressions, reach = excluded.reach, frequency = excluded.frequency, clicks = excluded.clicks, link_clicks = excluded.link_clicks,
       ctr = excluded.ctr, cpc = excluded.cpc, currency = excluded.currency, updated_at = excluded.updated_at`,
  ).bind(r.ad_id, r.date_start, r.adset_id ?? null, r.campaign_id ?? null, r.ad_name ?? null, num(r.spend) ?? 0, num(r.impressions) ?? 0, num(r.reach) ?? 0,
    num(r.frequency), num(r.clicks) ?? 0, num(r.inline_link_clicks) ?? 0, num(r.inline_link_click_ctr), num(r.cost_per_inline_link_click), r.account_currency ?? null, now));
  const ent = (level: string, e: EntityRow) => db.prepare(
    `INSERT INTO ad_entities (id, level, name, status, effective_status, campaign_id, adset_id, daily_budget, creative_id, created_time, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, effective_status = excluded.effective_status, campaign_id = excluded.campaign_id,
       adset_id = excluded.adset_id, daily_budget = excluded.daily_budget, creative_id = excluded.creative_id, created_time = COALESCE(excluded.created_time, ad_entities.created_time), updated_at = excluded.updated_at`,
  ).bind(e.id, level, e.name ?? null, e.status ?? null, e.effective_status ?? null, level === 'campaign' ? e.id : e.campaign_id ?? null, level === 'ad' ? e.adset_id ?? null : level === 'adset' ? e.id : null,
    num(e.daily_budget), e.creative?.id ?? null, ms(e.created_time), now);
  const stmts = [...ins, ...ents.ads.map((e) => ent('ad', e)), ...ents.adsets.map((e) => ent('adset', e)), ...ents.campaigns.map((e) => ent('campaign', e))];
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  await db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('_meta_ads_level_synced_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(String(now), now).run().catch(() => null);
  return { rows: rows.length, ads: ents.ads.length, adsets: ents.adsets.length, campaigns: ents.campaigns.length, spend: rows.reduce((a, r) => a + (num(r.spend) ?? 0), 0) };
}

/** POST to the Marketing API with the write token (form-encoded, as Meta documents). */
async function graphWrite<T>(rt: Runtime, path: string, params: Record<string, string | number | object>): Promise<T> {
  const token = metaWriteToken(rt);
  if (!token) throw new Error('No Meta write token (ads_management). Add it under Keys & settings → Ads.');
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  form.set('access_token', token);
  const res = await fetch(`${GRAPH}/${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok || body.error) {
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    throw new Error(/permission|ads_management/i.test(msg) ? `Meta refused the change (${msg}). The write token needs the ads_management permission on this ad account.` : `Meta: ${msg}`);
  }
  return body;
}

export const pauseMetaAd = (rt: Runtime, adId: string) => graphWrite<{ success?: boolean }>(rt, adId, { status: 'PAUSED' });
/** Daily budget in the account's smallest currency unit (cents). */
export const setMetaDailyBudget = (rt: Runtime, id: string, minor: number) => graphWrite<{ success?: boolean }>(rt, id, { daily_budget: Math.round(minor) });
/** Copies an ad (paused) inside the same ad set, or into another ad set. */
export const duplicateMetaAd = (rt: Runtime, adId: string, adsetId?: string) =>
  graphWrite<{ copied_ad_id?: string; ad_object_ids?: { copied_id?: string }[] }>(rt, `${adId}/copies`, { status_option: 'PAUSED', ...(adsetId ? { adset_id: adsetId } : {}) });

/** The image an existing creative uses, so a new ad can reuse it (null = text-only placeholder). */
export async function creativeImageHash(rt: Runtime, creativeId: string) {
  const token = metaWriteToken(rt) || metaAdsToken(rt);
  const r = await graph<{ image_hash?: string; object_story_spec?: { link_data?: { image_hash?: string } } }>(`${GRAPH}/${encodeURIComponent(creativeId)}?fields=image_hash,object_story_spec&access_token=${encodeURIComponent(token)}`);
  return r.object_story_spec?.link_data?.image_hash ?? r.image_hash ?? null;
}

/** A link ad (creative + paused ad) in an ad set, tagged for our attribution. */
export async function createPausedMetaAd(rt: Runtime, o: { adsetId: string; name: string; primary: string; headline: string; description?: string; link: string; pageId: string; imageHash?: string | null; utmContent: string }) {
  const act = adAccountPath(rt);
  const creative = await graphWrite<{ id: string }>(rt, `${act}/adcreatives`, {
    name: `${o.name} creative`,
    object_story_spec: { page_id: o.pageId, link_data: { link: o.link, message: o.primary, name: o.headline, ...(o.description ? { description: o.description } : {}), ...(o.imageHash ? { image_hash: o.imageHash } : {}), call_to_action: { type: 'LEARN_MORE' } } },
    url_tags: `utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content=${encodeURIComponent(o.utmContent)}`,
  });
  const ad = await graphWrite<{ id: string }>(rt, `${act}/ads`, { name: o.name, adset_id: o.adsetId, creative: { creative_id: creative.id }, status: 'PAUSED' });
  return { adId: ad.id, creativeId: creative.id };
}

import type { Runtime } from '../app';
import type { Env } from '../env';
import { platformOf } from '../lib/attribution';
import { hmacHex } from '../lib/crypto';
import { newId } from '../lib/ids';
import { getSecret } from '../lib/secret';

/**
 * Attribution capture for the webinar funnels (automated webinar, live Zoom webinar, 5-day challenge).
 *
 * Every visit is already a session row with its UTMs, click ids and landing page (lib/identity.ts). What
 * this adds: which browsers belong to which person (the browser that registered or paid, the lead's own
 * browser, and the same browser on our other domain via a signed link token), a copy of that person's
 * whole touch path, and one conversion row per registration / purchase / signed engagement holding the
 * first and last touch at that moment. Reports read those rows, so a touch is never re-guessed later.
 */

export type Funnel = 'auto' | 'live' | 'challenge';
export const FUNNELS: Funnel[] = ['auto', 'live', 'challenge'];
export type ConvKind = 'registered' | 'ticket_paid' | 'sprint_paid' | 'deposit_paid' | 'vip_paid' | 'engagement_signed';
export const PAID_KINDS: ConvKind[] = ['ticket_paid', 'sprint_paid', 'deposit_paid', 'vip_paid', 'engagement_signed'];

export interface TouchRow {
  session_id: string; lead_id: string; visitor_id: string; ts: number; landing: string | null; channel: string | null; platform: string | null;
  source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null; link_code: string | null;
  ad_id: string | null; adset_id: string | null; campaign_id: string | null; click_type: string | null; click_id: string | null;
  referrer_host: string | null; device: string | null; country: string | null;
}
export const TOUCH_FIELDS = ['ts', 'channel', 'platform', 'source', 'medium', 'campaign', 'content', 'term', 'link_code', 'ad_id', 'adset_id', 'campaign_id', 'click_type', 'landing', 'referrer_host', 'device', 'country'] as const;

const SOCIAL = /(^|[^a-z])(facebook|fb|instagram|ig|meta|an|msg)([^a-z]|$)/i;

/** The Meta ad id of a visit: ad_id= on the URL, or utm_content={{ad.id}} (a long number) on Meta traffic. */
export function metaAdId(t: { ad_id?: string | null; content?: string | null; source?: string | null; click_type?: string | null }): string | null {
  if (t.ad_id && /^\d{6,25}$/.test(t.ad_id)) return t.ad_id;
  const c = (t.content ?? '').trim();
  if (/^\d{6,25}$/.test(c) && (!t.source || SOCIAL.test(t.source) || t.click_type === 'fbclid')) return c;
  return null;
}

// ───────────── people: browsers that belong to one person ─────────────

export async function linkPerson(env: Env, leadId: string, visitorId: string | null | undefined, via: 'registration' | 'checkout' | 'lead' | 'xdomain', now = Date.now()) {
  if (!leadId || !visitorId) return;
  await env.DB.prepare('INSERT OR IGNORE INTO attr_people (lead_id, visitor_id, via, created_at) VALUES (?, ?, ?, ?)').bind(leadId, visitorId, via, now).run();
}

/** Every browser we know is this person: linked here, linked on the lead, and the same browser on our other domain. */
export async function personVisitors(env: Env, leadId: string): Promise<string[]> {
  const db = env.DB;
  const base = await db.prepare(
    `SELECT visitor_id AS v FROM attr_people WHERE lead_id = ?1
     UNION SELECT id FROM visitors WHERE lead_id = ?1
     UNION SELECT visitor_id FROM leads WHERE id = ?1 AND visitor_id IS NOT NULL`,
  ).bind(leadId).all<{ v: string }>();
  const set = new Set(base.results.map((r) => r.v).filter(Boolean));
  if (!set.size) return [];
  const list = [...set].slice(0, 40);
  const marks = list.map(() => '?').join(',');
  const more = await db.prepare(
    `SELECT other_id AS v FROM attr_xdomain WHERE visitor_id IN (${marks}) UNION SELECT visitor_id FROM attr_xdomain WHERE other_id IN (${marks})`,
  ).bind(...list, ...list).all<{ v: string }>();
  for (const r of more.results) set.add(r.v);
  return [...set].slice(0, 60);
}

/** Ad set and campaign behind a Meta ad id, from the ad-level sync (ads autopilot) when we have it. */
async function adParents(env: Env, adId: string): Promise<{ adset_id: string | null; campaign_id: string | null }> {
  const e = await env.DB.prepare('SELECT adset_id, campaign_id FROM ad_entities WHERE id = ?').bind(adId).first<{ adset_id: string | null; campaign_id: string | null }>().catch(() => null);
  if (e?.campaign_id) return e;
  const i = await env.DB.prepare('SELECT adset_id, campaign_id FROM ad_insights WHERE ad_id = ? ORDER BY day DESC LIMIT 1').bind(adId).first<{ adset_id: string | null; campaign_id: string | null }>().catch(() => null);
  return { adset_id: i?.adset_id ?? e?.adset_id ?? null, campaign_id: i?.campaign_id ?? null };
}

/** Copies the person's visits into their touch path (sessions get cleaned up; the path must not). */
export async function syncTouches(env: Env, leadId: string, visitors: string[]) {
  if (!visitors.length) return 0;
  const db = env.DB;
  const marks = visitors.map(() => '?').join(',');
  const rows = await db.prepare(
    `SELECT s.id, s.visitor_id, s.started_at, s.landing_path, s.channel, s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term,
            s.click_type, s.click_id, s.ad_id, s.adset_id, s.referrer_host, s.device, s.country,
            (SELECT t.code FROM tracked_links t WHERE t.code = s.utm_content) AS link_code
       FROM sessions s
      WHERE s.visitor_id IN (${marks}) AND s.is_bot = 0
        AND NOT EXISTS (SELECT 1 FROM attr_touches a WHERE a.session_id = s.id)
      ORDER BY s.started_at LIMIT 300`,
  ).bind(...visitors).all<{
    id: string; visitor_id: string; started_at: number; landing_path: string | null; channel: string | null; utm_source: string | null; utm_medium: string | null;
    utm_campaign: string | null; utm_content: string | null; utm_term: string | null; click_type: string | null; click_id: string | null; ad_id: string | null;
    adset_id: string | null; referrer_host: string | null; device: string | null; country: string | null; link_code: string | null;
  }>();
  if (!rows.results.length) return 0;
  const stmts: D1PreparedStatement[] = [];
  for (const s of rows.results) {
    const ad = metaAdId({ ad_id: s.ad_id, content: s.utm_content, source: s.utm_source, click_type: s.click_type });
    const parents = ad ? await adParents(env, ad) : { adset_id: null, campaign_id: null };
    stmts.push(db.prepare(
      `INSERT OR IGNORE INTO attr_touches (session_id, lead_id, visitor_id, ts, landing, channel, platform, source, medium, campaign, content, term, link_code,
         ad_id, adset_id, campaign_id, click_type, click_id, referrer_host, device, country) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      s.id, leadId, s.visitor_id, s.started_at, s.landing_path, s.channel, platformOf(s.utm_source, s.referrer_host, s.utm_medium), s.utm_source, s.utm_medium,
      s.utm_campaign, s.utm_content, s.utm_term, s.link_code, ad, s.adset_id ?? parents.adset_id, parents.campaign_id, s.click_type, s.click_id?.slice(0, 300) ?? null,
      s.referrer_host, s.device, s.country,
    ));
  }
  await db.batch(stmts);
  return stmts.length;
}

export async function touchPath(env: Env, leadId: string, upTo = Number.MAX_SAFE_INTEGER) {
  const r = await env.DB.prepare('SELECT * FROM attr_touches WHERE lead_id = ? AND ts <= ? ORDER BY ts, session_id').bind(leadId, upTo).all<TouchRow>();
  return r.results;
}

/** First touch = the earliest visit. Last touch = the latest visit that came from somewhere (falls back to the latest visit). */
export function pickTouches(path: TouchRow[]) {
  if (!path.length) return { first: null, last: null };
  const sourced = path.filter((t) => t.channel && t.channel !== 'Direct');
  return { first: path[0], last: sourced.length ? sourced[sourced.length - 1] : path[path.length - 1] };
}

// ───────────── checkout metadata (Whop) ─────────────

const pack = (t: Partial<TouchRow> | null) => (t ? [t.source, t.medium, t.campaign, t.content, t.ad_id, t.link_code].map((x) => String(x ?? '').replace(/\|/g, '/').slice(0, 60)).join('|') : '');
export function unpack(s: unknown): Partial<TouchRow> | null {
  if (typeof s !== 'string' || !s.includes('|')) return null;
  const [source, medium, campaign, content, ad_id, link_code] = s.split('|').map((x) => x.trim() || null);
  if (!source && !campaign && !ad_id && !link_code) return null;
  return { source, medium, campaign, content, ad_id, link_code, platform: platformOf(source, null, medium), channel: null };
}

/**
 * Attribution added to every Whop checkout and payment's metadata (strings only), so the payment carries where
 * the buyer came from even if our own rows were missing: the browser id plus first and last touch.
 */
export async function checkoutAttribution(env: Env, leadId: string | null | undefined): Promise<Record<string, string>> {
  if (!leadId) return {};
  try {
    const c = await env.DB.prepare(
      `SELECT visitor_id, ft_source AS source, ft_medium AS medium, ft_campaign AS campaign, ft_content AS content, ft_ad_id AS ad_id, ft_link_code AS link_code,
              lt_source, lt_medium, lt_campaign, lt_content, lt_ad_id, lt_link_code
         FROM attr_conversions WHERE lead_id = ? ORDER BY occurred_at DESC LIMIT 1`,
    ).bind(leadId).first<Record<string, string | null>>();
    if (c) {
      const out: Record<string, string> = {};
      if (c.visitor_id) out.attr_vid = c.visitor_id;
      if (c.source || c.campaign || c.ad_id) out.attr_ft = pack(c as Partial<TouchRow>);
      const lt = { source: c.lt_source, medium: c.lt_medium, campaign: c.lt_campaign, content: c.lt_content, ad_id: c.lt_ad_id, link_code: c.lt_link_code };
      if (lt.source || lt.campaign || lt.ad_id) out.attr_lt = pack(lt);
      return out;
    }
    const path = await touchPath(env, leadId);
    const { first, last } = pickTouches(path);
    const out: Record<string, string> = {};
    if (last?.visitor_id) out.attr_vid = last.visitor_id;
    if (first?.source || first?.campaign) out.attr_ft = pack(first);
    if (last?.source || last?.campaign) out.attr_lt = pack(last);
    return out;
  } catch {
    return {};
  }
}

// ───────────── conversions ─────────────

export interface CaptureInput {
  kind: ConvKind; funnel: Funnel; refId: string; regId?: string | null; leadId: string; at: number;
  amount?: number; refunded?: number; currency?: string | null; edition?: string | null; cohortRef?: string | null;
  visitorId?: string | null; fbc?: string | null; fbp?: string | null; via?: 'live' | 'sync' | 'metadata';
  /** Checkout metadata (attr_vid, attr_ft, attr_lt): used when our own path has no touches. */
  metadata?: Record<string, unknown> | null;
}

const touchCols = (p: 'ft' | 'lt') => TOUCH_FIELDS.map((f) => `${p}_${f}`);
const touchVals = (t: Partial<TouchRow> | null) => TOUCH_FIELDS.map((f) => (t ? (t[f] ?? null) : null));

/** Records one conversion with its first and last touch (idempotent per kind + ref; money fields refresh). */
export async function captureConversion(rt: Pick<Runtime, 'env'>, i: CaptureInput) {
  const env = rt.env;
  const db = env.DB;
  const now = Date.now();
  if (i.visitorId) await linkPerson(env, i.leadId, i.visitorId, i.kind === 'registered' ? 'registration' : 'checkout', now);
  const visitors = await personVisitors(env, i.leadId);
  if (i.metadata && typeof i.metadata.attr_vid === 'string' && /^v[0-9a-z]{12,24}$/.test(i.metadata.attr_vid)) {
    await linkPerson(env, i.leadId, i.metadata.attr_vid, 'checkout', now);
    if (!visitors.includes(i.metadata.attr_vid)) visitors.push(i.metadata.attr_vid);
  }
  await syncTouches(env, i.leadId, visitors);
  const path = await touchPath(env, i.leadId, i.at + 5_000);
  let { first, last } = pickTouches(path);
  let via = i.via ?? 'live';
  if (!first && i.metadata) {
    const ft = unpack(i.metadata.attr_ft), lt = unpack(i.metadata.attr_lt);
    if (ft || lt) { first = (ft ?? lt) as TouchRow; last = (lt ?? ft) as TouchRow; via = 'metadata'; }
  }
  const lead = await db.prepare('SELECT fbc, fbp, visitor_id FROM leads WHERE id = ?').bind(i.leadId).first<{ fbc: string | null; fbp: string | null; visitor_id: string | null }>();
  const clickOf = (type: string) => [...path].reverse().find((t) => t.click_type === type)?.click_id ?? null;
  const existing = await db.prepare('SELECT id, touches, lt_source, via FROM attr_conversions WHERE kind = ? AND ref_id = ?').bind(i.kind, i.refId).first<{ id: string; touches: number; lt_source: string | null; via: string }>();
  const visitorId = i.visitorId ?? last?.visitor_id ?? lead?.visitor_id ?? null;
  if (existing) {
    // Money can change (refunds); the touches only fill in when the first capture had none.
    await db.prepare('UPDATE attr_conversions SET amount = ?, refunded = ?, currency = COALESCE(?, currency), reg_id = COALESCE(reg_id, ?), updated_at = ? WHERE id = ?')
      .bind(i.amount ?? 0, i.refunded ?? 0, i.currency ?? null, i.regId ?? null, now, existing.id).run();
    if ((existing.touches === 0 && !existing.lt_source) && (path.length || via === 'metadata')) {
      const sets = [...touchCols('ft'), ...touchCols('lt')].map((c) => `${c} = ?`).join(', ');
      await db.prepare(`UPDATE attr_conversions SET ${sets}, touches = ?, via = ?, updated_at = ? WHERE id = ?`).bind(...touchVals(first), ...touchVals(last), path.length, via, now, existing.id).run();
    }
    return existing.id;
  }
  const id = newId('ac');
  const cols = ['id', 'kind', 'funnel', 'ref_id', 'reg_id', 'lead_id', 'occurred_at', 'amount', 'refunded', 'currency', 'edition', 'cohort_ref', 'visitor_id', 'touches', 'fbc', 'fbp',
    ...touchCols('ft'), ...touchCols('lt'), 'gclid', 'fbclid', 'via', 'created_at', 'updated_at'];
  const vals = [id, i.kind, i.funnel, i.refId, i.regId ?? null, i.leadId, i.at, i.amount ?? 0, i.refunded ?? 0, i.currency ? i.currency.toUpperCase() : null, i.edition ?? null, i.cohortRef ?? null,
    visitorId, path.length, i.fbc ?? lead?.fbc ?? null, i.fbp ?? lead?.fbp ?? null, ...touchVals(first), ...touchVals(last), clickOf('gclid'), clickOf('fbclid'), via, now, now];
  await db.prepare(`INSERT OR IGNORE INTO attr_conversions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...vals).run();
  return id;
}

/** Capture that never breaks the purchase or registration it rides on. */
export function captureSafely(rt: Pick<Runtime, 'env' | 'waitUntil'>, i: CaptureInput) {
  const p = captureConversion(rt, i).catch((e) => { console.error('attribution capture', String(e).slice(0, 200)); return null; });
  return p;
}

// ───────────── cross-domain (apply. ↔ live.) ─────────────

export const XD_PARAM = '_gx';

export async function xdToken(env: Env, visitorId: string) {
  const sig = (await hmacHex(await getSecret(env), `xd:${visitorId}`)).slice(0, 20);
  return `${visitorId}.${sig}`;
}

export async function xdVerify(env: Env, token: string | null | undefined): Promise<string | null> {
  const m = /^(v[0-9a-z]{12,24})\.([0-9a-f]{20})$/.exec(token ?? '');
  if (!m) return null;
  const want = (await hmacHex(await getSecret(env), `xd:${m[1]}`)).slice(0, 20);
  return want === m[2] ? m[1] : null;
}

/** Our other domains (main site and webinar host), so links between them carry the browser token. */
export function siblingHosts(settings: Partial<Record<string, string>>, selfHost: string): string[] {
  const hosts = new Set<string>();
  for (const u of [settings.PUBLIC_URL, settings.WEBINAR_URL]) {
    if (!u) continue;
    try { hosts.add(new URL(u).host); } catch { /* ignore */ }
  }
  hosts.delete(selfHost);
  return [...hosts];
}

/** Joins this browser to the same browser on the domain the link came from (and to its person, if known). */
export async function linkCrossDomain(env: Env, visitorId: string, token: string | null, o: { fromHost?: string | null; toHost?: string | null; now?: number } = {}) {
  const other = await xdVerify(env, token);
  if (!other || other === visitorId) return false;
  const now = o.now ?? Date.now();
  await env.DB.prepare('INSERT OR IGNORE INTO attr_xdomain (visitor_id, other_id, from_host, to_host, created_at) VALUES (?, ?, ?, ?, ?)').bind(visitorId, other, o.fromHost ?? null, o.toHost ?? null, now).run();
  // Either side already a person: the other browser joins them.
  const known = await env.DB.prepare(
    'SELECT lead_id FROM visitors WHERE id IN (?1, ?2) AND lead_id IS NOT NULL UNION SELECT lead_id FROM attr_people WHERE visitor_id IN (?1, ?2)',
  ).bind(visitorId, other).all<{ lead_id: string }>();
  for (const k of known.results) { await linkPerson(env, k.lead_id, visitorId, 'xdomain', now); await linkPerson(env, k.lead_id, other, 'xdomain', now); }
  return true;
}

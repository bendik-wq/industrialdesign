import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { HEADLINE_EXPERIMENT } from '../config';
import { flag } from '../settings';
import { type Touch, isCampaignTouch, touchFromUrl } from './attribution';
import { hmacHex, unitHash } from './crypto';
import { type Geo, geoFromRequest, isDatacenter } from './geo';
import { newId } from './ids';
import { getSecret } from './secret';
import { type ParsedUA, parseUA } from './ua';

export const COOKIE = {
  visitor: '_fv', // 400 days, HttpOnly
  session: '_fs', // 30 min sliding, HttpOnly
  variant: '_fx', // forced A/B variant (preview links)
  consent: '_fc', // 1 = granted, 0 = declined (EU only)
  fbp: '_fbp', // Meta browser id (server-set, first-party)
  fbc: '_fbc', // Meta click id
} as const;

const SESSION_TTL_S = 30 * 60;
const VISITOR_TTL_S = 400 * 24 * 60 * 60;

export interface VisitorCtx {
  visitorId: string;
  sessionId: string;
  leadId: string | null;
  isNewVisitor: boolean;
  isNewSession: boolean;
  isBot: boolean;
  botReason: string | null;
  variant: string;
  ua: ParsedUA;
  userAgent: string;
  geo: Geo;
  ip: string | null;
  touch: Touch | null;
  fbp: string | null;
  fbc: string | null;
  /** Ad-platform forwarding allowed (consent granted or not required). */
  marketingConsent: boolean;
  consentRequired: boolean;
}

/** Deterministic weighted A/B assignment from the visitor id. */
export async function assignVariant(visitorId: string): Promise<string> {
  const r = await unitHash(`${HEADLINE_EXPERIMENT.id}:${visitorId}`);
  const total = HEADLINE_EXPERIMENT.variants.reduce((s, v) => s + v.weight, 0);
  let acc = 0;
  for (const v of HEADLINE_EXPERIMENT.variants) {
    acc += v.weight / total;
    if (r < acc) return v.id;
  }
  return HEADLINE_EXPERIMENT.variants[0].id;
}

function cookieOpts(c: Context, maxAge: number, httpOnly = true) {
  const secure = new URL(c.req.url).protocol === 'https:';
  return { path: '/', maxAge, httpOnly, secure, sameSite: 'Lax' as const };
}

/**
 * Resolves (and persists) who is making this request. Called for every page
 * view and every beacon, so it is the single place visitor + session rows are
 * written. Page views carry attribution; beacons only keep the session alive.
 */
export async function resolveVisitor(c: Context<AppEnv>, kind: 'page' | 'beacon'): Promise<VisitorCtx> {
  const env = c.env;
  const settings = c.get('settings');
  const req = c.req.raw;
  const url = new URL(req.url);
  const now = Date.now();

  const userAgent = req.headers.get('user-agent') ?? '';
  const ua = parseUA(userAgent);
  const geo = geoFromRequest(req);
  const ip = req.headers.get('cf-connecting-ip');

  let botReason = ua.botReason ?? null;
  if (!botReason && kind === 'page' && !req.headers.get('accept-language')) botReason = 'no-accept-language';
  if (!botReason && isDatacenter(geo) && /HeadlessChrome|Electron/.test(userAgent)) botReason = 'datacenter-headless';
  const isBot = Boolean(botReason);

  let visitorId = getCookie(c, COOKIE.visitor);
  const isNewVisitor = !visitorId || !/^v[0-9a-z]{12,24}$/.test(visitorId);
  if (isNewVisitor) visitorId = newId('v');

  const touch = kind === 'page' ? touchFromUrl(url, req.headers.get('referer'), url.hostname) : null;
  let sessionId = getCookie(c, COOKIE.session);
  // A fresh ad click always starts a new session so last-touch attribution is exact.
  const isNewSession = isNewVisitor || !sessionId || !/^s[0-9a-z]{12,24}$/.test(sessionId) || Boolean(touch && isCampaignTouch(touch));
  if (isNewSession) sessionId = newId('s');

  // Variant: forced via ?v= preview link (sticky in a cookie), else hashed.
  const forced = url.searchParams.get('v') ?? getCookie(c, COOKIE.variant);
  const validForced = forced && HEADLINE_EXPERIMENT.variants.some((v) => v.id === forced) ? forced : null;
  if (url.searchParams.get('v') && validForced) setCookie(c, COOKIE.variant, validForced, cookieOpts(c, VISITOR_TTL_S, false));
  const variant = validForced ?? (await assignVariant(visitorId!));

  // Meta browser/click ids. Server-set first-party cookies outlive Safari's 7-day cap on JS cookies.
  let fbp = getCookie(c, COOKIE.fbp) ?? null;
  let fbc = getCookie(c, COOKIE.fbc) ?? null;
  if (!fbp && !isBot) {
    fbp = `fb.1.${now}.${Math.floor(Math.random() * 1e10)}`;
    setCookie(c, COOKIE.fbp, fbp, cookieOpts(c, VISITOR_TTL_S, false));
  }
  if (touch?.clickType === 'fbclid' && touch.clickId && !fbc?.endsWith(touch.clickId)) {
    fbc = `fb.1.${now}.${touch.clickId}`;
    setCookie(c, COOKIE.fbc, fbc, cookieOpts(c, 90 * 24 * 60 * 60, false));
  }

  const consentRequired = geo.isEU && flag(settings.CONSENT_REQUIRED_EU, true);
  const consentCookie = getCookie(c, COOKIE.consent);
  const marketingConsent = !consentRequired || consentCookie === '1';

  setCookie(c, COOKIE.visitor, visitorId!, cookieOpts(c, VISITOR_TTL_S));
  setCookie(c, COOKIE.session, sessionId!, cookieOpts(c, SESSION_TTL_S));

  const storedIp = ip ? (flag(settings.IP_ANONYMIZE) ? null : ip) : null;
  const ipHash = ip ? (await hmacHex(await getSecret(env), ip)).slice(0, 24) : null;
  const isPage = kind === 'page' ? 1 : 0;

  const visitorStmt = env.DB.prepare(
    `INSERT INTO visitors (id, created_at, last_seen_at, ft_channel, ft_source, ft_medium, ft_campaign, ft_content, ft_term,
       ft_referrer, ft_landing, ft_click_id, ft_click_type, country, city, device, browser, os, is_bot, session_count, pageview_count)
     VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 1, ?19)
     ON CONFLICT(id) DO UPDATE SET
       last_seen_at = ?2,
       session_count = session_count + ?20,
       pageview_count = pageview_count + ?19,
       country = COALESCE(?13, country), city = COALESCE(?14, city),
       device = ?15, browser = ?16, os = ?17
     RETURNING lead_id`,
  ).bind(
    visitorId, now, touch?.channel ?? 'Direct', touch?.source ?? null, touch?.medium ?? null, touch?.campaign ?? null,
    touch?.content ?? null, touch?.term ?? null, touch?.referrer ?? null, kind === 'page' ? url.pathname : null,
    touch?.clickId ?? null, touch?.clickType ?? null, geo.country, geo.city, ua.device, ua.browser, ua.os, isBot ? 1 : 0,
    isPage, isNewSession && !isNewVisitor ? 1 : 0,
  );

  const sessionStmt = isNewSession
    ? env.DB.prepare(
        `INSERT INTO sessions (id, visitor_id, started_at, last_seen_at, landing_path, landing_query, referrer, referrer_host, channel,
           utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id, click_id, click_type, ad_id, adset_id, placement,
           country, region, city, postal_code, timezone, latitude, longitude, continent, is_eu, asn, as_org, colo, http_protocol,
           tls_version, ip, ip_hash, user_agent, device, browser, browser_version, os, os_version, accept_language, is_bot, bot_reason,
           variant, pageviews, region_code)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(
        sessionId, visitorId, now, now, url.pathname, url.search.slice(0, 1000) || null, touch?.referrer ?? null,
        touch?.referrerHost ?? null, touch?.channel ?? 'Direct', touch?.source ?? null, touch?.medium ?? null,
        touch?.campaign ?? null, touch?.content ?? null, touch?.term ?? null, touch?.utmId ?? null, touch?.clickId ?? null,
        touch?.clickType ?? null, touch?.adId ?? null, touch?.adsetId ?? null, touch?.placement ?? null, geo.country,
        geo.region, geo.city, geo.postalCode, geo.timezone, geo.latitude, geo.longitude, geo.continent, geo.isEU ? 1 : 0,
        geo.asn, geo.asOrg, geo.colo, geo.httpProtocol, geo.tlsVersion, storedIp, ipHash, userAgent.slice(0, 500),
        ua.device, ua.browser, ua.browserVersion, ua.os, ua.osVersion,
        req.headers.get('accept-language')?.slice(0, 100) ?? null, isBot ? 1 : 0, botReason, variant, isPage, geo.regionCode,
      )
    : env.DB.prepare('UPDATE sessions SET last_seen_at = ?, pageviews = pageviews + ? WHERE id = ?').bind(now, isPage, sessionId);

  const [visitorRes] = await env.DB.batch<{ lead_id: string | null }>([visitorStmt, sessionStmt]);

  return {
    visitorId: visitorId!,
    sessionId: sessionId!,
    leadId: visitorRes.results[0]?.lead_id ?? null,
    isNewVisitor,
    isNewSession,
    isBot,
    botReason,
    variant,
    ua,
    userAgent,
    geo,
    ip,
    touch,
    fbp,
    fbc,
    marketingConsent,
    consentRequired,
  };
}

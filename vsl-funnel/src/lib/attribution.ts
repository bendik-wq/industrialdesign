export interface Touch {
  channel: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  utmId: string | null;
  clickId: string | null;
  clickType: string | null;
  adId: string | null;
  adsetId: string | null;
  placement: string | null;
  referrer: string | null;
  referrerHost: string | null;
}

/** Ad-platform click identifiers, in priority order. */
const CLICK_IDS = ['fbclid', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'msclkid', 'li_fat_id', 'twclid', 'ScCid', 'epik', 'rdt_cid'] as const;

const CLICK_SOURCE: Record<string, string> = {
  fbclid: 'facebook', gclid: 'google', gbraid: 'google', wbraid: 'google', ttclid: 'tiktok', msclkid: 'bing',
  li_fat_id: 'linkedin', twclid: 'x', ScCid: 'snapchat', epik: 'pinterest', rdt_cid: 'reddit',
};

// Token matches bounded by non-letters, so "accept.com" doesn't read as t.co.
const token = (words: string) => new RegExp(`(^|[^a-z])(${words})([^a-z]|$)`, 'i');
const SOCIAL = token('facebook|fb|instagram|ig|meta|twitter|x\\.com|t\\.co|linkedin|lnkd|tiktok|pinterest|reddit|snapchat|threads|quora');
const VIDEO = token('youtube|youtu\\.be|vimeo');
const SEARCH = token('google|bing|yahoo|duckduckgo|ecosia|baidu|yandex|brave|search');
const MESSAGING = token('whatsapp|wa\\.me|telegram|messenger|sms');
const EMAIL = token('mail|outlook|gmail|proton');

const clean = (v: string | null, max = 200) => (v ? v.trim().slice(0, max) || null : null);

export function hostOf(url: string | null | undefined) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Builds the touch for a landing request: UTMs, click ids and a channel
 * classification modelled on GA4's default channel grouping.
 */
export function touchFromUrl(url: URL, referrer: string | null, selfHost: string): Touch {
  const q = url.searchParams;
  const refHost = hostOf(referrer);
  const externalRef = refHost && refHost !== selfHost.replace(/^www\./, '') ? refHost : null;

  let clickType: string | null = null;
  let clickId: string | null = null;
  for (const k of CLICK_IDS) {
    if (q.get(k)) {
      clickType = k;
      clickId = clean(q.get(k), 500);
      break;
    }
  }

  let source = clean(q.get('utm_source'))?.toLowerCase() ?? null;
  let medium = clean(q.get('utm_medium'))?.toLowerCase() ?? null;
  if (!source && clickType) source = CLICK_SOURCE[clickType];
  // Meta appends fbclid to organic link clicks too, so it alone doesn't mean paid.
  const paidClick = Boolean(clickType && clickType !== 'fbclid');
  if (!medium && clickType) medium = paidClick ? 'paid' : 'social';
  if (!source && externalRef) source = externalRef;
  if (!medium && externalRef) medium = 'referral';

  return {
    channel: classifyChannel(source, medium, externalRef, paidClick),
    source,
    medium,
    campaign: clean(q.get('utm_campaign')),
    content: clean(q.get('utm_content')),
    term: clean(q.get('utm_term')),
    utmId: clean(q.get('utm_id')),
    clickId,
    clickType,
    // Common Meta / TikTok URL-parameter conventions ({{ad.id}} etc.)
    adId: clean(q.get('ad_id') ?? q.get('adid') ?? q.get('hsa_ad')),
    adsetId: clean(q.get('adset_id') ?? q.get('adgroup_id') ?? q.get('hsa_grp')),
    placement: clean(q.get('placement') ?? q.get('site_source_name')),
    referrer: externalRef ? clean(referrer, 1000) : null,
    referrerHost: externalRef,
  };
}

export function classifyChannel(source: string | null, medium: string | null, refHost: string | null, paidClick: boolean): string {
  const s = source ?? '';
  const m = medium ?? '';
  const r = refHost ?? '';
  const paid = paidClick || /^(cpc|ppc|paid|paidsocial|paid_social|paid-social|cpm|cpv|display|retargeting|ads?)$/.test(m);

  if (m === 'email' || /email|newsletter|klaviyo|resend|mailchimp/.test(s) || EMAIL.test(r)) return 'Email';
  if (m === 'sms' || MESSAGING.test(s) || MESSAGING.test(r)) return 'Messaging';
  if (m === 'affiliate' || m === 'partner') return 'Affiliate';
  if (VIDEO.test(s) || VIDEO.test(r)) return paid ? 'Paid Video' : 'Organic Video';
  if (SOCIAL.test(s) || SOCIAL.test(r)) return paid ? 'Paid Social' : 'Organic Social';
  if (SEARCH.test(s) || SEARCH.test(r)) return paid ? 'Paid Search' : 'Organic Search';
  if (paid) return 'Paid Other';
  if (m === 'referral' || refHost) return 'Referral';
  if (s) return 'Other Campaign';
  return 'Direct';
}

/** A touch "counts" as a new campaign arrival (forces a new session, updates last-touch). */
export const isCampaignTouch = (t: Touch) => Boolean(t.clickId || t.source || t.campaign);

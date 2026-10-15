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
/** AI assistants and answer engines (ChatGPT also tags its links utm_source=chatgpt.com). */
export const AI_SEARCH = token('chatgpt|chat\\.openai|openai|perplexity|claude|anthropic|gemini|bard|copilot|grok|x\\.ai|meta\\.ai|you\\.com|phind|deepseek|mistral|poe\\.com|kagi|duckassist');
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
export function touchFromUrl(url: URL, referrer: string | null, selfHost: string, userAgent = ''): Touch {
  const q = url.searchParams;
  const refHost = hostOf(referrer);
  const externalRef = refHost && refHost !== selfHost.replace(/^www\./, '') ? refHost : null;
  // Instagram, Facebook, TikTok… open links in their own browser, which often sends no referrer.
  // Without this, a tap on an Instagram bio link would read as "Direct".
  const inApp = inAppSource(userAgent);

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
  if (!source && inApp) [source, medium] = [inApp, medium ?? 'social'];

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
  if (!paid && (AI_SEARCH.test(s) || AI_SEARCH.test(r))) return 'AI Search';
  if (VIDEO.test(s) || VIDEO.test(r)) return paid ? 'Paid Video' : 'Organic Video';
  if (SOCIAL.test(s) || SOCIAL.test(r)) return paid ? 'Paid Social' : 'Organic Social';
  if (SEARCH.test(s) || SEARCH.test(r)) return paid ? 'Paid Search' : 'Organic Search';
  if (paid) return 'Paid Other';
  if (m === 'referral' || refHost) return 'Referral';
  if (s) return 'Other Campaign';
  return 'Direct';
}

/** The app whose built-in browser opened the link, from its user agent. */
export function inAppSource(ua: string | null | undefined): string | null {
  const s = ua ?? '';
  if (/Instagram/.test(s)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB|FBIOS/.test(s)) return 'facebook';
  if (/Barcelona/.test(s)) return 'threads';
  if (/musical_ly|BytedanceWebview|TikTok/i.test(s)) return 'tiktok';
  if (/LinkedInApp/.test(s)) return 'linkedin';
  if (/Snapchat/.test(s)) return 'snapchat';
  if (/Twitter for|TwitterAndroid/.test(s)) return 'x';
  if (/Pinterest/.test(s)) return 'pinterest';
  return null;
}

/** Named platforms, checked against the source and the referring site. Order matters: first match wins. */
const PLATFORMS: [RegExp, string][] = [
  [token('manychat'), 'ManyChat'],
  [token('chatgpt|chat\\.openai|openai'), 'ChatGPT'],
  [token('claude|anthropic'), 'Claude'],
  [token('perplexity'), 'Perplexity'],
  [token('gemini|bard'), 'Gemini'],
  [token('copilot'), 'Copilot'],
  [token('grok|x\\.ai'), 'Grok'],
  [token('meta\\.ai'), 'Meta AI'],
  [token('deepseek'), 'DeepSeek'],
  [token('you\\.com|phind|kagi|poe\\.com|mistral'), 'Other AI'],
  [token('instagram|ig'), 'Instagram'],
  [token('threads'), 'Threads'],
  [token('facebook|fb|messenger'), 'Facebook'],
  [token('youtube|youtu\\.be'), 'YouTube'],
  [token('tiktok'), 'TikTok'],
  [token('linkedin|lnkd'), 'LinkedIn'],
  [token('x|x\\.com|t\\.co|twitter'), 'X'],
  [token('reddit'), 'Reddit'],
  [token('pinterest'), 'Pinterest'],
  [token('snapchat'), 'Snapchat'],
  [token('whatsapp|wa\\.me'), 'WhatsApp'],
  [token('telegram'), 'Telegram'],
  [token('email|newsletter|gmail|outlook|mail|resend|klaviyo|mailchimp'), 'Email'],
  [token('google'), 'Google'],
  [token('bing'), 'Bing'],
  [token('duckduckgo'), 'DuckDuckGo'],
  [token('yahoo'), 'Yahoo'],
  [token('brave'), 'Brave Search'],
  [token('ecosia'), 'Ecosia'],
  [/workers\.dev$/, 'Old workers.dev link'],
];

/**
 * Plain-English "where they came from": Instagram, Google, ChatGPT, YouTube… Falls back to the
 * referring site, then to "Direct" (typed in, a bookmark, or an app that hides where the link was).
 */
export function platformOf(source: string | null | undefined, refHost?: string | null, medium?: string | null): string {
  const s = (source ?? '').toLowerCase();
  const r = (refHost ?? '').toLowerCase();
  const m = (medium ?? '').toLowerCase();
  for (const [re, name] of PLATFORMS) {
    if (re.test(s) || re.test(r)) {
      if (name === 'Instagram' && /dm|manychat/.test(m)) return 'Instagram DM';
      if (name === 'ManyChat') return 'Instagram DM';
      return name;
    }
  }
  return s || r || 'Direct';
}

/** A touch "counts" as a new campaign arrival (forces a new session, updates last-touch). */
export const isCampaignTouch = (t: Touch) => Boolean(t.clickId || t.source || t.campaign);

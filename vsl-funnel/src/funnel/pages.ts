import type { Context } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import {
  APPLICATION, BRAND, BREAKOUT, DISCLAIMER, FAQS, FOUNDER_SOCIALS, HEADLINE_EXPERIMENT, LANDING, LEGAL_CONSENT, RESOURCES, TIER_ROUTES, PALETTES, type VideoDef, VIDEOS, VOICE_AGENT,
} from '../config';
import { whatsappLink } from '../integrations/whatsapp';
import { webCallsEnabled } from '../integrations/voice';
import { formatCallTime } from '../integrations/email';
import { flag } from '../settings';
import { identityFromVisitor, track } from '../tracking/track';
import { hashedMatchKeys } from '../tracking/match';
import { type Lead, effectiveTier, getLead, parseAnswers } from './leads';
import { bookingUrlFor } from './routing';

type Html = string;

interface View {
  /** innerHTML for [data-slot="key"] (trusted copy from config). */
  slots?: Record<string, Html | null | undefined>;
  /** <li> items for [data-list="key"]. */
  lists?: Record<string, Html[]>;
  /** [data-if="key"] elements are removed when false. */
  show?: Record<string, boolean>;
  /** href for [data-href="key"]. */
  hrefs?: Record<string, string | null>;
  /** Raw HTML for [data-html="key"] (pre-built blocks like the FAQ list). */
  blocks?: Record<string, Html>;
  /** Exposed to the page's JS as window.FUNNEL. */
  config?: Record<string, unknown>;
  title?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** JSON safe to embed inside a <script> tag. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/[<\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

function videoConfig(c: Context<AppEnv>, def: VideoDef) {
  const s = c.get('settings');
  const connected = s[def.srcSetting] || (def.fallbackSetting ? s[def.fallbackSetting] : '');
  const src = connected || def.defaultSrc || '';
  return {
    id: def.id,
    src,
    srcWebm: connected ? '' : def.defaultSrcWebm ?? '',
    poster: (def.posterSetting && s[def.posterSetting]) || def.defaultPoster || '',
    ctaRevealAt: def.ctaRevealAt,
    gateContent: def.gateContent && Boolean(src),
    autoplayMuted: def.autoplayMuted,
    soundPrompt: LANDING.soundPrompt,
    soundAction: LANDING.soundAction,
  };
}

function faqBlock(): Html {
  return FAQS.map((f, i) => `<details class="faq" data-faq="${i}"><summary>${f.q}</summary><div class="faq-a"><p>${f.a}</p></div></details>`).join('');
}

async function trackingHead(c: Context<AppEnv>, pageEventId: string): Promise<Html> {
  const s = c.get('settings');
  const v = c.get('visitor');
  const parts: string[] = [];
  if (s.META_PIXEL_ID && v.marketingConsent) {
    // Pixel shares event ids with the Conversions API so Meta deduplicates, and gets the same
    // pre-hashed advanced-matching keys (incl. external_id) so both sides describe the same person.
    const lead = v.leadId ? await getLead(c.env, v.leadId) : null;
    const keys = await hashedMatchKeys(
      lead ? { email: lead.email, phone: lead.phone, firstName: lead.first_name, lastName: lead.last_name, country: lead.country, city: lead.city } : null,
      v.geo,
      [v.visitorId],
    );
    const matching = { ...keys, external_id: Array.isArray(keys.external_id) ? keys.external_id[0] : keys.external_id };
    parts.push(`<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',${scriptJson(s.META_PIXEL_ID)},${scriptJson(matching)});fbq('track','PageView',{},{eventID:${scriptJson(pageEventId)}});</script>`);
  }
  if (s.POSTHOG_KEY && flag(s.POSTHOG_SESSION_REPLAY) && v.marketingConsent) {
    // Session replay + heatmaps only; events are sent server-side. Loaded through our own /ph proxy.
    parts.push(`<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init(${scriptJson(s.POSTHOG_KEY)},{api_host:location.origin+'/ph',ui_host:${scriptJson((s.POSTHOG_HOST || 'https://us.i.posthog.com').replace('.i.posthog', '.posthog'))},autocapture:false,capture_pageview:false,capture_pageleave:false,disable_session_recording:false,bootstrap:{distinctID:${scriptJson(v.visitorId)}},person_profiles:'identified_only'});</script>`);
  }
  if (s.CLARITY_ID && v.marketingConsent && /^[a-z0-9]{4,20}$/i.test(s.CLARITY_ID)) {
    parts.push(`<script>(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script",${scriptJson(s.CLARITY_ID)});clarity("identify",${scriptJson(v.visitorId)});</script>`);
  }
  if (s.TURNSTILE_SITE_KEY && ['/', '/apply'].includes(new URL(c.req.url).pathname)) {
    parts.push('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>');
  }
  return parts.join('\n');
}

/**
 * Renders a page template from /public: logs the page view server-side (so it
 * counts even with JS or trackers blocked), then streams the HTML through
 * HTMLRewriter to fill copy slots and inject the per-visitor config.
 */
async function render(c: Context<AppEnv>, assetPath: string, view: View) {
  const v = c.get('visitor');
  const rt = runtimeFrom(c);
  const url = new URL(c.req.url);
  const isPrefetch = /prefetch|prerender/i.test(c.req.header('sec-purpose') ?? c.req.header('purpose') ?? '');

  const pageEventId = isPrefetch
    ? ''
    : await track(rt, identityFromVisitor(v, url.toString()), {
        name: 'page_view',
        source: 'server',
        path: url.pathname,
        props: { title: view.title ?? null, query: url.search.slice(0, 300) || null, new_visitor: v.isNewVisitor, new_session: v.isNewSession },
      });

  const asset = await c.env.ASSETS.fetch(new Request(new URL(assetPath, url.origin)));
  if (!asset.ok) return c.notFound();

  const s = c.get('settings');
  const config = {
    page: url.pathname,
    visitorId: v.visitorId,
    sessionId: v.sessionId,
    variant: v.variant,
    pageEventId,
    consentRequired: v.consentRequired,
    consentGiven: v.marketingConsent,
    pixel: Boolean(s.META_PIXEL_ID && v.marketingConsent),
    siteName: s.SITE_NAME || BRAND.name,
    ...view.config,
  };

  const slots: Record<string, Html | null | undefined> = { site_name: esc(config.siteName), year: String(new Date().getFullYear()), disclaimer: DISCLAIMER, consent: LEGAL_CONSENT, ...view.slots };
  const head = await trackingHead(c, pageEventId);
  const asked = url.searchParams.get('palette') ?? '';
  const palette = PALETTES.includes(asked) ? asked : PALETTES.includes(s.SITE_PALETTE) ? s.SITE_PALETTE : PALETTES[0];

  const rewriter = new HTMLRewriter()
    .on('html', { element: (el) => void el.setAttribute('data-palette', palette) })
    .on('title', { element: (el) => { if (view.title) el.setInnerContent(`${view.title} — ${config.siteName}`); } })
    .on('head', { element: (el) => void el.append(`<script id="funnel-config">window.FUNNEL=${scriptJson(config)}</script>\n${head}`, { html: true }) })
    .on('[data-slot]', { element: (el) => { const k = el.getAttribute('data-slot')!; const val = slots[k]; if (val != null) el.setInnerContent(val, { html: true }); } })
    .on('[data-list]', {
      element: (el) => {
        const items = view.lists?.[el.getAttribute('data-list')!];
        if (items) el.setInnerContent(items.map((i) => `<li>${i}</li>`).join(''), { html: true });
      },
    })
    .on('[data-html]', { element: (el) => { const b = view.blocks?.[el.getAttribute('data-html')!]; if (b != null) el.setInnerContent(b, { html: true }); } })
    .on('[data-if]', {
      element: (el) => {
        const key = el.getAttribute('data-if')!;
        const negate = key.startsWith('!');
        const val = view.show?.[negate ? key.slice(1) : key] ?? false;
        if (negate ? val : !val) el.remove();
        else el.removeAttribute('data-if');
      },
    })
    .on('[data-href]', {
      element: (el) => {
        const href = view.hrefs?.[el.getAttribute('data-href')!];
        if (href) el.setAttribute('href', href);
      },
    });

  const headers = new Headers(asset.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'private, no-store');
  headers.delete('etag');
  for (const cookie of c.res.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return rewriter.transform(new Response(asset.body, { status: 200, headers }));
}

async function currentLead(c: Context<AppEnv>): Promise<Lead | null> {
  const v = c.get('visitor');
  return v.leadId ? getLead(c.env, v.leadId) : null;
}

// ───────────────────────────── Pages ─────────────────────────────

/** Everything the embedded application needs (used on the landing page and /apply). */
function applicationConfig(c: Context<AppEnv>, lead: Lead | null) {
  const s = c.get('settings');
  return {
    questions: APPLICATION,
    turnstileSiteKey: s.TURNSTILE_SITE_KEY || null,
    country: c.get('visitor').geo.country,
    resume: lead && !lead.app_completed_at
      ? { step: lead.step_reached, answers: parseAnswers(lead), contact: { first_name: lead.first_name, last_name: lead.last_name, email: lead.email, phone: lead.phone } }
      : null,
  };
}

/** Copy for the application block, shared by the landing page and /apply. */
const applySection = {
  slots: { apply_eyebrow: LANDING.applyEyebrow, apply_title: LANDING.applyTitle, apply_subtitle: LANDING.applySubtitle, guarantee: LANDING.guarantee, faq_title: LANDING.faqTitle },
  lists: { apply_points: LANDING.applyPoints },
};

export async function landingPage(c: Context<AppEnv>) {
  const v = c.get('visitor');
  const lead = await currentLead(c);
  const variant = HEADLINE_EXPERIMENT.variants.find((x) => x.id === v.variant) ?? HEADLINE_EXPERIMENT.variants[0];
  const by = LANDING.byline;
  return render(c, '/index.html', {
    title: 'No-money-down acquisitions',
    slots: {
      ...applySection.slots,
      pre_headline: variant.preHeadline,
      headline: variant.headline,
      subheadline: variant.subheadline,
      byline_name: esc(by.name),
      byline_role: esc(by.role),
      byline_initials: esc(by.initials),
      cta_label: LANDING.ctaLabel,
    },
    lists: {
      ...applySection.lists,
      proof_points: LANDING.proof,
      testimonials: LANDING.testimonials.map((t) => `<blockquote>“${t.quote}”</blockquote><cite><strong>${t.name}</strong> · ${t.detail}</cite>`),
    },
    blocks: { faqs: faqBlock() },
    show: { testimonials: LANDING.testimonials.length > 0 },
    config: { video: videoConfig(c, VIDEOS.main), experiment: HEADLINE_EXPERIMENT.id, ...applicationConfig(c, lead) },
  });
}

export async function applyPage(c: Context<AppEnv>) {
  const lead = await currentLead(c);
  // Finished applicants coming back (e.g. from an email) go straight to their next step.
  if (lead?.app_completed_at && !c.req.query('again')) {
    const tier = effectiveTier(lead);
    if (tier) return c.redirect(lead.booked_at && !lead.booking_cancelled_at ? '/breakout' : TIER_ROUTES[tier], 302);
  }
  return render(c, '/apply.html', { title: 'See if you qualify', ...applySection, config: applicationConfig(c, lead) });
}

/** The "talk to the AI assistant" block on /book and /breakout (inbound only). */
function voiceView(c: Context<AppEnv>, lead: Lead | null) {
  const s = c.get('settings');
  const web = Boolean(lead && !lead.do_not_call_at && webCallsEnabled(s));
  const phone = s.VOICE_PHONE_NUMBER.trim();
  const on = Boolean(lead && !lead.do_not_call_at && (web || phone));
  return {
    slots: { voice_disclosure: esc(VOICE_AGENT.webDisclosure), voice_phone: esc(phone) },
    show: { voice: on, voice_web: web, voice_phone: Boolean(phone) },
    hrefs: { voice_tel: phone ? `tel:${phone.replace(/[^\d+]/g, '')}` : null },
  };
}

export async function bookPage(c: Context<AppEnv>) {
  const lead = await currentLead(c);
  if (!lead?.app_completed_at) return c.redirect('/apply', 302);
  const rt = runtimeFrom(c);
  const tier = effectiveTier(lead);
  const bookingUrl = bookingUrlFor(rt, lead.closer_id, tier);
  if (!bookingUrl || tier === 'C') return c.redirect(tier === 'C' ? '/resources' : '/breakout', 302);
  if (lead.booked_at && !lead.booking_cancelled_at && !c.req.query('reschedule')) return c.redirect('/breakout', 302);

  const voice = voiceView(c, lead);
  return render(c, '/book.html', {
    title: 'Book your call',
    show: voice.show,
    hrefs: voice.hrefs,
    slots: {
      ...voice.slots,
      first_name: esc(lead.first_name ?? ''),
      ref_code: lead.ref_code,
      eyebrow: tier === 'A' ? `Congratulations${lead.first_name ? `, ${esc(lead.first_name)}` : ''} — you qualify` : 'Book your call',
      headline: 'Pick a time for your call',
    },
    config: {
      booking: {
        url: bookingUrl,
        provider: /calendly\.com/.test(bookingUrl) ? 'calendly' : 'iframe',
        prefill: { name: [lead.first_name, lead.last_name].filter(Boolean).join(' '), email: lead.email, leadId: lead.id, ref: lead.ref_code },
      },
    },
  });
}

export async function breakoutPage(c: Context<AppEnv>) {
  const lead = await currentLead(c);
  const rt = runtimeFrom(c);
  const booked = Boolean(lead?.booked_at && !lead.booking_cancelled_at);
  const tier = lead ? effectiveTier(lead) : null;
  const copy = booked ? BREAKOUT.booked : BREAKOUT.applied;
  const bookingUrl = lead && tier !== 'C' ? bookingUrlFor(rt, lead.closer_id, tier) : null;
  const wa = whatsappLink(c.get('settings'), lead, booked ? 'booked' : 'question');

  let callTime: string | null = null;
  if (booked && lead?.call_at) callTime = formatCallTime(lead.call_at, c.get('visitor').geo.timezone);

  const voice = voiceView(c, lead);
  return render(c, '/breakout.html', {
    title: booked ? 'You’re booked' : 'Part 2',
    slots: {
      ...voice.slots,
      eyebrow: copy.eyebrow,
      headline: copy.headline,
      subheadline: copy.subheadline,
      call_time: callTime ? esc(callTime) : null,
      prepare_title: BREAKOUT.prepareTitle,
      whatsapp_title: BREAKOUT.whatsappTitle,
      whatsapp_body: BREAKOUT.whatsappBody,
      book_title: BREAKOUT.bookTitle,
      book_body: BREAKOUT.bookBody,
      ref_code: lead?.ref_code ?? '',
    },
    lists: { prepare: BREAKOUT.prepare },
    blocks: { faqs: faqBlock() },
    show: { ...voice.show, booked, call_time: Boolean(callTime), whatsapp: Boolean(wa), book: !booked && Boolean(bookingUrl), apply: !lead },
    hrefs: { ...voice.hrefs, whatsapp: `/go/wa?src=${booked ? 'breakout-booked' : 'breakout'}`, book: '/book' },
    config: { video: videoConfig(c, booked ? VIDEOS.precall : VIDEOS.breakout), booked },
  });
}

export async function resourcesPage(c: Context<AppEnv>) {
  const lead = await currentLead(c);
  const wa = whatsappLink(c.get('settings'), lead, 'resources');
  return render(c, '/resources.html', {
    title: 'Your free toolkit',
    slots: { eyebrow: RESOURCES.eyebrow, headline: RESOURCES.headline, subheadline: RESOURCES.subheadline, ps: RESOURCES.ps, good_fit_title: RESOURCES.goodFitTitle, first_name: esc(lead?.first_name ?? '') },
    lists: { good_fit: RESOURCES.goodFit },
    blocks: {
      items: RESOURCES.items.map((i, n) => `<li class="kit-item"><span class="kit-n">${n + 1}</span><div><h3>${i.title}</h3><p>${i.body}</p></div></li>`).join(''),
      socials: FOUNDER_SOCIALS.map((x) => `<a class="social" href="${esc(x.url)}" target="_blank" rel="noopener"><strong>${esc(x.followers)}</strong><span>${x.platform} followers</span></a>`).join(''),
    },
    show: { whatsapp: Boolean(wa), lead: Boolean(lead), socials: FOUNDER_SOCIALS.length > 0 },
    hrefs: { whatsapp: '/go/wa?src=resources-page' },
  });
}

export const staticPage = (assetPath: string, title: string) => (c: Context<AppEnv>) => render(c, assetPath, { title });

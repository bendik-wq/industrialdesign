import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { render } from '../funnel/pages';
import { getLead, linkVisitor } from '../funnel/leads';
import { guaranteeHtml } from '../sales/deposit';
import { playbackFor } from '../live/stream';
import { buyerFeePercent } from '../webinar/one-click';
import { CHALLENGE_NAME, CHECKOUT, DAY_PAGE, DAYS, HUB, LANDING, OFFER, dayContent } from './content';
import { type LoadedCohort, type Registration, challengeConfig, getReg, loadCohort, money, nextCohort } from './cohorts';
import { confirmOnReturn, hostedCheckout, nextStep, payFormConfig, payUrl, skipVip, vipOffer, welcomeUrl } from './payments';
import { offerView } from './offer';
import { type ParticipantView, homeworkFor, joinDay, myPoll, participantView, pollResults, replayDay } from './room';
import { DAYS_IN_CHALLENGE, type DayRow, countdownText, dayEnds, eventKey, formatDate, formatWhen } from './schedule';

/**
 * The First Deal Challenge pages. One calm system (challenge.css, the same tokens as the masterclass room):
 * white and #f5f5f7 surfaces, near-black type, navy for labels and links, gold only for a purchase, one serif
 * headline per screen, hairlines instead of borders. Each screen has one job and one dominant action.
 *  /challenge                 the promise, the five days, the real next cohort and its countdown, one form
 *  /challenge/pay/:t          the $100 ticket on Whop's embedded card form (card saved)
 *  /challenge/vip/:t          the one-click $300 VIP bump, shown once
 *  /challenge/welcome/:t      dates, calendar for all five days, the hub
 *  /challenge/hub/:t          the participant's home: today's session, progress, every day
 *  /challenge/day/:t/:n       the companion page next to Zoom: join, worksheet, poll, chat, VIP hot seat, offer
 */

export const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ICON = {
  arrow: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.5 3.2 3L15 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ext: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 4h5v5m0-5-7 7M8 5H5v10h10v-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5.5v9l7-4.5z" fill="currentColor"/></svg>',
};
const cd = (target: number, now: number, cls = '') => `<span class="chx-cd ${cls}" data-countdown="${target}" data-now="${now}">${esc(countdownText(target - now))}</span>`;

async function page(c: Context<AppEnv>, o: { title: string; main: string; bar?: string; navright?: string; config?: Record<string, unknown>; legal?: string; seo?: boolean; ticketPay?: unknown }) {
  return render(c, '/challenge.html', {
    title: o.title,
    blocks: { main: o.main, bar: o.bar ?? '', navright: o.navright ?? '', legal: esc(o.legal ?? LANDING.disclaimer) },
    config: { challenge: o.config ?? {}, ...(o.ticketPay ? { ticketPay: o.ticketPay } : {}) },
    seo: o.seo ? { title: `${CHALLENGE_NAME} | Five live days with Josh Li`, description: LANDING.lede, path: '/challenge', index: true } : undefined,
  });
}

const notFound = (c: Context<AppEnv>) => c.text('This link isn’t valid. Check the email we sent you, or start at the challenge page.', 404);

// ───────────── landing ─────────────

export function timelineHtml(days: Pick<DayRow, 'day' | 'starts_at'>[] | null, tz: string | null) {
  return `<ol class="chx-tl">${DAYS.map((d) => {
    const row = days?.find((x) => x.day === d.n);
    return `<li class="chx-tl-i"><span class="chx-tl-dot" aria-hidden="true">${d.n}</span><p class="chx-tl-when">Day ${d.n}${row && tz ? ` · <span data-local-date="${row.starts_at}">${esc(formatDate(row.starts_at, tz))}</span>` : ''}</p><h3 class="chx-tl-h">${esc(d.title)}</h3><p class="chx-tl-p">${esc(d.line)}</p></li>`;
  }).join('')}</ol>`;
}

export function landingHtml(o: { next: LoadedCohort | null; now: number; ticketLabel: string; vipLabel: string; vipOn: boolean; turnstile: string | null; free: boolean }) {
  const n = o.next;
  const d1 = n?.days.find((d) => d.day === 1) ?? null;
  const when = d1 && n ? formatWhen(d1.starts_at, n.cohort.timezone) : null;
  const cta = o.free ? LANDING.cta : `${LANDING.cta}, ${o.ticketLabel}`;
  const nextLine = d1 && n
    ? `<p class="chx-next"><span class="chx-next-l">${esc(LANDING.nextHeading)}</span> <span data-local-when="${d1.starts_at}">${esc(when!)}</span>${d1.starts_at > o.now ? ` <span class="chx-next-cd">· starts in ${cd(d1.starts_at, o.now)}</span>` : ' <span class="chx-next-cd">· Day 1 is under way, and its replay waits for you</span>'}</p>`
    : `<p class="chx-next">${esc(LANDING.noCohort)}</p>`;
  const bands = [['lt1m', 'Under $1M'], ['1_3m', '$1M to $3M'], ['3_10m', '$3M to $10M'], ['10_25m', '$10M to $25M'], ['25_50m', '$25M to $50M'], ['50_100m', '$50M to $100M'], ['gt100m', 'Over $100M']];
  const form = n ? `<form class="chx-form" data-ch-register novalidate>
      <input type="hidden" name="cohort_id" value="${esc(n.cohort.id)}">
      <div class="chx-fields">
        <label class="chx-f"><span>First name</span><input name="first_name" autocomplete="given-name" required maxlength="60"></label>
        <label class="chx-f"><span>Email</span><input name="email" type="email" autocomplete="email" required maxlength="120"></label>
        <label class="chx-f chx-f-wide"><span>Your business’s annual revenue</span><select name="revenue" required data-ch-band><option value="">Choose one</option>${bands.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
        <p class="chx-under" data-ch-under hidden>${esc(LANDING.under1m)}</p>
        <label class="chx-f chx-f-wide"><span>Mobile (optional)</span><input name="phone" type="tel" autocomplete="tel" maxlength="30"></label>
        <label class="chx-check chx-f-wide"><input type="checkbox" name="sms_consent"> <span>${esc(LANDING.smsConsent)}</span></label>
      </div>
      ${o.turnstile ? `<div class="cf-turnstile" data-sitekey="${esc(o.turnstile)}" data-size="flexible"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ''}
      <button class="chx-buy" type="submit">${esc(cta)} ${ICON.arrow}</button>
      <p class="chx-err" role="alert" data-ch-err hidden></p>
      <p class="chx-fine">${esc(o.free ? LANDING.privacy : `${LANDING.formNote} ${LANDING.privacy}`)} <a href="/privacy">Privacy policy</a>.</p>
    </form>` : `<p class="chx-lede">${esc(LANDING.noCohort)}</p>`;

  return `<section class="chx-hero"><div class="chx-wrap chx-narrow">
      <p class="chx-eyebrow">${esc(CHALLENGE_NAME)} · ${esc(LANDING.eyebrow)}</p>
      <h1 class="chx-h1">${esc(LANDING.h1)}</h1>
      <p class="chx-lede">${esc(LANDING.lede)}</p>
      ${n ? `<a class="chx-buy chx-buy-auto" href="#join">${esc(cta)} ${ICON.arrow}</a>` : ''}
      ${nextLine}
    </div></section>
    <section class="chx-band chx-fill"><div class="chx-wrap">
      <h2 class="chx-h2">${esc(LANDING.timelineHeading)}</h2>
      <p class="chx-sub">${esc(LANDING.timelineNote)}</p>
      ${timelineHtml(n?.days ?? null, n?.cohort.timezone ?? null)}
    </div></section>
    <section class="chx-band"><div class="chx-wrap chx-two">
      <div><h2 class="chx-h3">${esc(o.free ? 'No ticket price for this cohort' : `${o.ticketLabel} to join`)}</h2><p class="chx-p">${esc(o.free ? 'Register and your place is confirmed.' : LANDING.priceLine)}</p></div>
      ${o.vipOn ? `<div><h2 class="chx-h3">VIP, ${esc(o.vipLabel)} more</h2><p class="chx-p">${esc(LANDING.vipLine)}</p></div>` : ''}
      <div><h2 class="chx-h3">${esc(LANDING.forHeading)}</h2><p class="chx-p">${esc(LANDING.forLine)}</p></div>
      <div><h2 class="chx-h3">${esc(LANDING.hostHeading)}</h2><p class="chx-p">${esc(LANDING.host)}</p></div>
    </div></section>
    <section class="chx-band chx-fill" id="join"><div class="chx-wrap chx-narrow">
      <h2 class="chx-h2">${esc(LANDING.formHeading)}</h2>
      ${n ? `<p class="chx-sub">${esc(n.cohort.name)} · Day 1 <span data-local-when="${d1!.starts_at}">${esc(when!)}</span></p>` : ''}
      ${form}
    </div></section>
    <section class="chx-band"><div class="chx-wrap chx-narrow">
      ${LANDING.faq.map((f) => `<details class="chx-faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}
    </div></section>`;
}

export async function landingPage(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const cfg = challengeConfig(rt.settings);
  const now = Date.now();
  const next = await nextCohort(rt, now);
  return page(c, {
    title: CHALLENGE_NAME,
    seo: true,
    main: landingHtml({ next, now, ticketLabel: cfg.ticketLabel, vipLabel: cfg.vipLabel, vipOn: cfg.vipOn, turnstile: rt.settings.TURNSTILE_SITE_KEY || null, free: cfg.free }),
    config: { register: '/api/challenge/register', now },
  });
}

// ───────────── shared loaders ─────────────

async function loadReg(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const reg = await getReg(rt, c.req.param('token') ?? '');
  // The emailed link is the key: a registration that created its lead may link this browser to it.
  if (reg && !c.get('visitor').leadId && !c.get('visitor').isBot) await linkVisitor(c.env, c.get('visitor').visitorId, reg.lead_id).catch(() => null);
  return { rt, reg };
}

const summaryLine = (L: LoadedCohort) => {
  const d1 = L.days.find((d) => d.day === 1);
  const d5 = L.days.find((d) => d.day === 5);
  return d1 && d5 ? `${formatDate(d1.starts_at, L.cohort.timezone)} to ${formatDate(d5.starts_at, L.cohort.timezone)}, ${formatWhen(d1.starts_at, L.cohort.timezone, { weekday: false }).replace(/^.*?(\d{1,2}:\d{2}\s?[ap]m.*)$/i, '$1')} each day` : '';
};

// ───────────── checkout ─────────────

export function payHtml(o: { copy: ReturnType<typeof import('./payments').payCopy>; note: string | null; hostedUrl: string; summary: string; price: string; kind: 'ticket' | 'vip' }) {
  const t = o.copy;
  return `<section class="chx-pay"><div class="chx-wrap chx-slim">
    <ol class="chx-steps" aria-label="Checkout steps"><li class="${o.kind === 'ticket' ? 'on' : 'done'}">Ticket</li><li class="${o.kind === 'vip' ? 'on' : ''}">VIP</li><li>Welcome</li></ol>
    <div data-ticket-pay>
      <p class="chx-eyebrow">${esc(t.eyebrow)}</p>
      <h1 class="chx-h1 chx-h1-s">${esc(t.heading)}</h1>
      <p class="chx-lede">${esc(t.lede)}</p>
      <div class="chx-order"><span>${esc(o.summary)}</span><strong>${esc(o.price)}</strong></div>
      ${o.note ? `<p class="chx-err" role="alert">${esc(o.note)}</p>` : ''}
      <div class="chx-card-form" data-whop-payment><p class="chx-fine">${esc(t.loading)}</p></div>
      <div data-whop-branding></div>
      <p class="chx-fine" data-save-note>${esc(t.saveNote)}</p>
      <button type="button" class="chx-buy" data-ticket-pay-btn disabled>${esc(t.button)}</button>
      <p class="chx-err" role="alert" data-ticket-pay-err hidden></p>
      <p class="chx-fine">${esc(t.hosted)} <a href="${esc(o.hostedUrl)}">${esc(t.hostedLink)}</a></p>
    </div>
  </div></section>`;
}

/** GET /challenge/pay/:token (?kind=vip). ?return=1 after 3D Secure or Whop's page; ?hosted=1 for Whop's hosted checkout. */
export async function payPage(c: Context<AppEnv>) {
  const { rt, reg } = await loadReg(c);
  if (!reg) return notFound(c);
  const kind = c.req.query('kind') === 'vip' ? 'vip' : 'ticket';
  const cfg = challengeConfig(rt.settings);
  if (kind === 'ticket' && reg.status !== 'pending') return c.redirect(nextStep(rt, reg), 302);
  if (kind === 'vip' && (reg.vip || reg.status !== 'paid')) return c.redirect(nextStep(rt, reg), 302);
  let note: string | null = null;
  if (c.req.query('return') === '1') {
    const r = await confirmOnReturn(rt, reg, kind);
    if (r === 'paid' || r === 'pending') return c.redirect(kind === 'ticket' ? `${rt.origin}/challenge/vip/${reg.token}` : welcomeUrl(rt, reg.token), 302);
    note = CHECKOUT.declined;
  }
  if (c.req.query('one_click') === 'declined') note = CHECKOUT.vipDeclined;
  const L = await loadCohort(rt, reg.cohort_id);
  if (!L) return notFound(c);
  if (cfg.provider !== 'whop') {
    return page(c, { title: CHECKOUT.ticketHeading, main: `<section class="chx-pay"><div class="chx-wrap chx-slim"><p class="chx-eyebrow">${esc(CHALLENGE_NAME)}</p><h1 class="chx-h1 chx-h1-s">${esc(CHECKOUT.ticketHeading)}</h1><p class="chx-lede">${esc(CHECKOUT.unavailable)}</p></div></section>` });
  }
  if (c.req.query('hosted') === '1') {
    try { return c.redirect(await hostedCheckout(rt, reg, kind), 302); } catch { note = CHECKOUT.failed; }
  }
  const form = await payFormConfig(rt, reg, kind).catch(() => null);
  if (!form) return page(c, { title: CHECKOUT.ticketHeading, main: `<section class="chx-pay"><div class="chx-wrap chx-slim"><p class="chx-lede">${esc(CHECKOUT.failed)}</p></div></section>` });
  const price = kind === 'ticket' ? cfg.ticketLabel : cfg.vipLabel;
  return page(c, {
    title: form.copy.heading,
    main: payHtml({ copy: form.copy, note, hostedUrl: form.hostedUrl, summary: kind === 'ticket' ? `${CHALLENGE_NAME} · ${summaryLine(L)}` : 'VIP upgrade · hot seats, recordings, worksheet feedback', price, kind }),
    config: { token: reg.token },
    ticketPay: form,
  });
}

export function vipHtml(o: { label: string; total: string | null; fee: number; card: string | null; oneClick: boolean; token: string; skipUrl: string; formUrl: string }) {
  return `<section class="chx-pay"><div class="chx-wrap chx-slim">
    <ol class="chx-steps" aria-label="Checkout steps"><li class="done">Ticket</li><li class="on">VIP</li><li>Welcome</li></ol>
    <p class="chx-ok">${ICON.check} Your ticket is confirmed.</p>
    <p class="chx-eyebrow">${esc(CHECKOUT.vipEyebrow)}</p>
    <h1 class="chx-h1 chx-h1-s">${esc(CHECKOUT.vipHeading)}</h1>
    <p class="chx-lede">${esc(CHECKOUT.vipLede)}</p>
    <ul class="chx-perks">${CHECKOUT.vipPerks.map((p) => `<li>${ICON.check}<div><strong>${esc(p.title)}</strong><span>${esc(p.body)}</span></div></li>`).join('')}</ul>
    <div class="chx-order"><span>VIP upgrade${o.fee ? ` <em>plus Whop’s ${o.fee}% service fee</em>` : ''}</span><strong>${esc(o.total ?? o.label)}</strong></div>
    ${o.oneClick
      ? `<button type="button" class="chx-buy" data-ch-vip>${esc(CHECKOUT.vipButton(o.total ?? o.label))}</button><p class="chx-fine">${esc(CHECKOUT.vipCharged(o.card))}</p>`
      : `<a class="chx-buy" href="${esc(o.formUrl)}">${esc(CHECKOUT.vipButton(o.label))}</a>`}
    <p class="chx-err" role="alert" data-ch-vip-err hidden></p>
    <form method="post" action="${esc(o.skipUrl)}" class="chx-skip"><button type="submit" class="chx-link">${esc(CHECKOUT.vipSkip)}</button></form>
  </div></section>`;
}

export async function vipPage(c: Context<AppEnv>) {
  const { rt, reg } = await loadReg(c);
  if (!reg) return notFound(c);
  const cfg = challengeConfig(rt.settings);
  if (reg.status !== 'paid' || reg.vip || !cfg.vipOn) return c.redirect(nextStep(rt, reg), 302);
  await rt.env.DB.prepare('UPDATE challenge_registrations SET vip_seen_at = COALESCE(vip_seen_at, ?) WHERE id = ?').bind(Date.now(), reg.id).run();
  const offer = await vipOffer(rt, reg);
  const fee = offer.oneClick ? buyerFeePercent(rt.settings) : 0;
  const total = fee ? money(cfg.vipMinor + Math.round(cfg.vipMinor * fee / 100), cfg.currency) : null;
  return page(c, {
    title: CHECKOUT.vipHeading,
    main: vipHtml({ label: cfg.vipLabel, total, fee, card: offer.card, oneClick: offer.oneClick, token: reg.token, skipUrl: `/challenge/vip/${reg.token}/skip`, formUrl: payUrl(rt, reg.token, 'vip') }),
    config: { token: reg.token, vip: '/api/challenge/vip' },
  });
}

export async function vipSkip(c: Context<AppEnv>) {
  const { rt, reg } = await loadReg(c);
  if (!reg) return notFound(c);
  return c.redirect(await skipVip(rt, reg), 303);
}

// ───────────── welcome ─────────────

const gcal = (rt: Runtime, reg: Registration, d: DayRow) => {
  const fmt = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', `${CHALLENGE_NAME}: Day ${d.day}, ${dayContent(d.day)!.title}`);
  u.searchParams.set('dates', `${fmt(d.starts_at)}/${fmt(dayEnds(d))}`);
  u.searchParams.set('details', `Your day page (Zoom link, worksheet, chat): ${rt.origin}/challenge/day/${reg.token}/${d.day}`);
  return u.toString();
};

/** One calendar file with all five days, each linking to its day page. */
export function challengeIcs(rt: Runtime, reg: Pick<Registration, 'id' | 'token'>, days: DayRow[]) {
  const fmt = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escText = (s: string) => s.replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
  const events = days.flatMap((d) => {
    const url = `${rt.origin}/challenge/day/${reg.token}/${d.day}`;
    return ['BEGIN:VEVENT', `UID:${reg.id}-d${d.day}@challenge`, `DTSTAMP:${fmt(Date.now())}`, `DTSTART:${fmt(d.starts_at)}`, `DTEND:${fmt(dayEnds(d))}`,
      `SUMMARY:${escText(`${CHALLENGE_NAME}: Day ${d.day}, ${dayContent(d.day)!.title}`)}`, `DESCRIPTION:${escText(`Your day page with the Zoom link, worksheet and chat: ${url}`)}`, `URL:${url}`, `LOCATION:${escText(url)}`,
      'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Starting in 15 minutes', 'END:VALARM', 'END:VEVENT'];
  });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Funnel//Challenge//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...events, 'END:VCALENDAR'].join('\r\n');
}

export async function icsFile(c: Context<AppEnv>) {
  const { rt, reg } = await loadReg(c);
  if (!reg || reg.status !== 'paid') return c.text('Not found', 404);
  const L = await loadCohort(rt, reg.cohort_id);
  if (!L) return c.text('Not found', 404);
  return new Response(challengeIcs(rt, reg, L.days), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="first-deal-challenge.ics"', 'cache-control': 'no-store' } });
}

export async function welcomePage(c: Context<AppEnv>) {
  const { rt, reg } = await loadReg(c);
  if (!reg) return notFound(c);
  if (reg.status === 'pending') {
    // Back from a payment that may still be settling.
    const r = await confirmOnReturn(rt, reg, 'ticket');
    if (r !== 'paid') return c.redirect(payUrl(rt, reg.token), 302);
  }
  if (c.req.query('vip') === '1' && !reg.vip) await confirmOnReturn(rt, reg, 'vip');
  const fresh = (await getReg(rt, reg.token))!;
  const L = await loadCohort(rt, reg.cohort_id);
  if (!L) return notFound(c);
  const tz = L.cohort.timezone;
  const main = `<section class="chx-pay"><div class="chx-wrap chx-slim">
    <ol class="chx-steps" aria-label="Checkout steps"><li class="done">Ticket</li><li class="done">VIP</li><li class="on">Welcome</li></ol>
    <p class="chx-eyebrow">${esc(CHECKOUT.welcomeEyebrow)}</p>
    <h1 class="chx-h1 chx-h1-s">${esc(CHECKOUT.welcomeHeading)}</h1>
    <p class="chx-lede">${esc(CHECKOUT.welcomeLede)}</p>
    ${fresh.vip ? `<p class="chx-ok">${ICON.check} ${esc(CHECKOUT.welcomeVip)}</p>` : ''}
    <h2 class="chx-h3">${esc(CHECKOUT.calendarHeading)}</h2>
    <ol class="chx-dates">${L.days.map((d) => `<li><span class="chx-dates-n">Day ${d.day}</span><span class="chx-dates-t"><strong>${esc(dayContent(d.day)!.title)}</strong><span data-local-when="${d.starts_at}">${esc(formatWhen(d.starts_at, tz))}</span></span><a class="chx-link" href="${esc(gcal(rt, fresh, d))}" target="_blank" rel="noopener">Google</a></li>`).join('')}</ol>
    <p class="chx-fine"><a href="/challenge/ics/${esc(fresh.token)}">${esc(CHECKOUT.calendarApple)}</a></p>
    <a class="chx-go" href="/challenge/hub/${esc(fresh.token)}">${esc(CHECKOUT.hubButton)} ${ICON.arrow}</a>
    <p class="chx-fine">${esc(CHECKOUT.emailNote)}</p>
  </div></section>`;
  return page(c, { title: CHECKOUT.welcomeHeading, main });
}

// ───────────── hub ─────────────

function sessionCard(v: ParticipantView, reg: Registration, d: ParticipantView['days'][number], o: { compact?: boolean } = {}) {
  const join = d.join_url ? `/challenge/join/${reg.token}/${d.day}` : null;
  // On the day page the page header carries the day and title, so the card doesn't repeat them.
  const title = o.compact ? '' : `<p class="chx-eyebrow">Day ${d.day} of ${DAYS_IN_CHALLENGE}</p><h2 class="chx-h2 chx-sc-h">${esc(d.content.title)}</h2>`;
  const when = `<p class="chx-sc-when" data-local-when="${d.starts_at}">${esc(formatWhen(d.starts_at, v.cohort.timezone))}</p>`;
  const joinBtn = join ? `<a class="chx-go" href="${esc(join)}" target="_blank" rel="noopener">${esc(HUB.join)} ${ICON.ext}</a><p class="chx-fine">${esc(HUB.joinNote)}</p>` : `<p class="chx-fine">${esc(HUB.noLink)}</p>`;
  let state = '';
  if (d.phase === 'live') state = `<p class="chx-live"><span class="chx-dot" aria-hidden="true"></span>${esc(HUB.todayLive)}</p>${title}${joinBtn}`;
  else if (d.phase === 'soon' || d.phase === 'upcoming') state = `${title}${when}<p class="chx-sc-cd">${esc(HUB.todayStarts)} ${cd(d.starts_at, v.now, 'chx-cd-l')}</p>${d.phase === 'soon' ? joinBtn : ''}`;
  else {
    const replay = d.replay === 'open' ? `<a class="chx-go" href="/challenge/replay/${esc(reg.token)}/${d.day}" target="_blank" rel="noopener">${ICON.play} ${esc(DAY_PAGE.replayButton)}</a>` : `<p class="chx-fine">${esc(d.replay === 'closed' ? HUB.replayClosed : HUB.todayReplaySoon)}</p>`;
    state = `<p class="chx-sc-tag">${esc(HUB.todayEnded)}</p>${title}${replay}`;
  }
  return `<div class="chx-sc${d.phase === 'live' ? ' is-live' : ''}${o.compact ? ' is-compact' : ''}" data-ch-session data-day="${d.day}" data-starts="${d.starts_at}" data-ends="${dayEnds(d)}">${state}</div>`;
}

export function progressHtml(v: Pick<ParticipantView, 'days' | 'progress'>) {
  const items = v.days.map((d) => {
    const p = d.progress;
    const state = p.live ? HUB.attended : p.replay ? HUB.watched : d.phase === 'ended' ? HUB.notYet : HUB.upcoming;
    return `<li class="chx-pg-i${p.live || p.replay ? ' att' : ''}${p.homework ? ' hw' : ''}"><span class="chx-pg-ring" aria-hidden="true">${p.homework ? ICON.check : d.day}</span><span class="chx-pg-l">Day ${d.day}</span><span class="chx-pg-s">${esc(state)}${p.homework ? ` · ${esc(HUB.homework)}` : ''}</span></li>`;
  }).join('');
  return `<div class="chx-pg"><div class="chx-pg-head"><h2 class="chx-h3">${esc(HUB.progressHeading)}</h2><p class="chx-pg-sum">${v.progress.attended} of 5 sessions · ${v.progress.homework} of 5 worksheets</p></div><ol class="chx-pg-list">${items}</ol></div>`;
}

export function offerBlockHtml(o: { view: Awaited<ReturnType<typeof offerView>>; closeAt: number | null; now: number; soft: boolean; guarantee: string; open: boolean; token: string; day: number }) {
  const v = o.view;
  if (v.paid) return `<section class="chx-offer is-paid" data-ch-offer><p class="chx-ok">${ICON.check} ${esc(OFFER.paid)}</p></section>`;
  return `<section class="chx-offer" data-ch-offer${o.open ? '' : ' hidden'} aria-labelledby="chx-offer-h">
    <p class="chx-eyebrow chx-gold-t">${esc(o.soft ? OFFER.eyebrowSoft : OFFER.eyebrow)}</p>
    <h2 class="chx-h2" id="chx-offer-h">${esc(OFFER.heading)}</h2>
    <p class="chx-p">${esc(OFFER.lede)}</p>
    <ul class="chx-perks">${OFFER.stack.map((s) => `<li>${ICON.check}<div><span>${esc(s)}</span></div></li>`).join('')}</ul>
    <div class="chx-order"><span>${esc(OFFER.deposit(v.deposit))}</span><strong>${esc(v.deposit)}</strong></div>
    <p class="chx-fine">${esc(OFFER.depositLine)}${v.credit ? ` ${esc(OFFER.ticketCredit(v.credit))}` : ''}</p>
    ${o.closeAt ? `<p class="chx-offer-cd">${esc(OFFER.closes)} ${cd(o.closeAt, o.now, 'chx-cd-l')}</p>` : ''}
    <button type="button" class="chx-buy" data-ch-deposit data-day="${o.day}">${esc(OFFER.button(v.deposit))}</button>
    <p class="chx-err" role="alert" data-ch-deposit-err hidden></p>
    <div class="chx-guarantee"><p class="chx-h3">${esc(v.guarantee.headline)}</p>${o.guarantee || (v.guarantee.body ? `<p class="chx-p">${esc(v.guarantee.body)}</p>` : '')}<p class="chx-fine"><a href="${esc(v.guarantee.url)}" target="_blank" rel="noopener">${esc(OFFER.guaranteeLink)}</a></p></div>
    <p class="chx-fine">${esc(OFFER.reason)}</p>
  </section>`;
}

export function barHtml(o: { closeAt: number | null; now: number; open: boolean; deposit: string }) {
  return `<div class="chx-bar" data-ch-bar${o.open ? '' : ' hidden'}><div class="chx-wrap chx-bar-in"><p class="chx-bar-t"><strong>${esc(OFFER.bar)}</strong>${o.closeAt ? ` <span>closes in ${cd(o.closeAt, o.now)}</span>` : ''}</p><button type="button" class="chx-buy chx-buy-s" data-ch-bar-go>${esc(OFFER.barButton)} · ${esc(o.deposit)}</button></div></div>`;
}

export async function hubPage(c: Context<AppEnv>) {
  const { rt, reg } = await loadReg(c);
  if (!reg) return notFound(c);
  if (reg.status !== 'paid') return c.redirect(nextStep(rt, reg), 302);
  const v = await participantView(rt, reg);
  if (!v) return notFound(c);
  const lead = await getLead(rt.env, reg.lead_id);
  const ov = await offerView(rt, reg);
  const focus = v.focus ?? v.days[0];
  const rows = v.days.map((d) => {
    const p = d.progress;
    const chips = [p.live ? HUB.attended : p.replay ? HUB.watched : null, p.homework ? HUB.homework : null].filter(Boolean).map((x) => `<span class="chx-chip">${esc(x!)}</span>`).join('');
    return `<li><a class="chx-day-row" href="/challenge/day/${esc(reg.token)}/${d.day}"><span class="chx-day-n">Day ${d.day}</span><span class="chx-day-t"><strong>${esc(d.content.title)}</strong><span data-local-when="${d.starts_at}">${esc(formatWhen(d.starts_at, v.cohort.timezone))}</span></span><span class="chx-day-c">${d.phase === 'live' ? `<span class="chx-chip chx-chip-live">${esc(HUB.todayLive)}</span>` : chips}</span>${ICON.arrow}</a></li>`;
  }).join('');
  const replays = v.vip ? HUB.replayKept : v.closeAt ? `${HUB.replayUntil} ${formatWhen(v.closeAt, v.cohort.timezone)}.` : '';
  const offer = v.offer.open || ov.paid ? offerBlockHtml({ view: ov, closeAt: v.closeAt, now: v.now, soft: v.offer.day === 4, guarantee: guaranteeHtml(rt), open: true, token: reg.token, day: v.offer.day ?? 5 }) : '';
  const main = `<section class="chx-hub"><div class="chx-wrap">
    <div class="chx-hub-head"><p class="chx-eyebrow">${esc(HUB.eyebrow)}${v.vip ? ` <span class="chx-vip">${esc(HUB.vipBadge)}</span>` : ''}</p><h1 class="chx-h1 chx-h1-s">${esc(lead?.first_name ? `${lead.first_name}, your five days` : CHALLENGE_NAME)}</h1><p class="chx-sub">${esc(v.cohort.name)} · ${esc(summaryLine({ cohort: v.cohort, days: v.days, closeAt: v.closeAt } as LoadedCohort))}</p></div>
    ${sessionCard(v, reg, focus)}
    ${offer}
    ${progressHtml(v)}
    <h2 class="chx-h3 chx-mt">All five days</h2>
    <ol class="chx-days">${rows}</ol>
    <p class="chx-fine">${esc(replays)}</p>
    ${!v.vip && challengeConfig(rt.settings).vipOn && v.days.some((d) => d.phase !== 'ended') ? `<p class="chx-quiet">${esc(DAY_PAGE.vipUpsell)} <a href="${esc(payUrl(rt, reg.token, 'vip'))}">${esc(DAY_PAGE.vipUpsellButton)}</a></p>` : ''}
  </div></section>`;
  return page(c, {
    title: HUB.eyebrow,
    main,
    bar: v.offer.open && !ov.paid ? barHtml({ closeAt: v.closeAt, now: v.now, open: true, deposit: ov.deposit }) : '',
    navright: v.vip ? `<span class="chx-vip">${esc(HUB.vipBadge)}</span>` : '',
    config: { token: reg.token, now: v.now, deposit: '/api/challenge/deposit' },
  });
}

/** /challenge/today/:token (texts): the day page of the session that matters now. */
export async function todayRedirect(c: Context<AppEnv>) {
  const { rt, reg } = await loadReg(c);
  if (!reg) return notFound(c);
  if (reg.status !== 'paid') return c.redirect(nextStep(rt, reg), 302);
  const v = await participantView(rt, reg);
  return c.redirect(`/challenge/day/${reg.token}/${v?.focus?.day ?? 1}`, 302);
}

export async function joinRedirect(c: Context<AppEnv>) {
  const { rt, reg } = await loadReg(c);
  const n = Number(c.req.param('n'));
  if (!reg) return notFound(c);
  const url = await joinDay(rt, reg, n);
  return url ? c.redirect(url, 302) : c.redirect(`/challenge/day/${reg.token}/${n}`, 302);
}

export async function replayRedirect(c: Context<AppEnv>) {
  const { rt, reg } = await loadReg(c);
  const n = Number(c.req.param('n'));
  if (!reg) return notFound(c);
  const r = await replayDay(rt, reg, n);
  return r.url ? c.redirect(r.url, 302) : c.redirect(`/challenge/day/${reg.token}/${n}`, 302);
}

// ───────────── day page ─────────────

function worksheetHtml(day: number, saved: Awaited<ReturnType<typeof homeworkFor>>, locked: boolean) {
  const c = dayContent(day)!;
  const val = (k: string) => esc(saved?.answers[k] ?? '');
  return `<section class="chx-ws" aria-labelledby="chx-ws-h">
    <h2 class="chx-h3" id="chx-ws-h">${esc(c.worksheet.heading)}</h2>
    <p class="chx-p">${esc(c.worksheet.intro)}</p>
    ${locked ? `<p class="chx-fine">${esc(DAY_PAGE.locked)}</p>` : `<form data-ch-ws data-day="${day}">
      ${c.worksheet.fields.map((f) => `<label class="chx-f"><span>${esc(f.label)}</span>${f.hint ? `<em>${esc(f.hint)}</em>` : ''}${f.kind === 'long' ? `<textarea name="${f.key}" rows="3" maxlength="2000">${val(f.key)}</textarea>` : `<input name="${f.key}" ${f.kind === 'money' || f.kind === 'number' ? 'inputmode="decimal"' : ''} maxlength="200" value="${val(f.key)}">`}</label>`).join('')}
      <button type="submit" class="chx-go">${esc(DAY_PAGE.worksheetSave)}</button>
      <p class="chx-fine" role="status" data-ch-ws-msg>${saved ? esc(DAY_PAGE.worksheetSaved) : ''}</p>
    </form>`}
  </section>`;
}

function pollHtml(day: number, mine: string | null, results: Awaited<ReturnType<typeof pollResults>>) {
  const p = dayContent(day)!.poll;
  const res = mine && results ? results.options.map((o) => { const pct = results.total ? Math.round((o.n / results.total) * 100) : 0; return `<li class="${o.value === mine ? 'me' : ''}"><span>${esc(o.label)}</span><span class="chx-poll-bar"><i style="width:${pct}%"></i></span><span class="chx-poll-n">${o.n}</span></li>`; }).join('') : '';
  return `<section class="chx-poll" data-ch-poll data-day="${day}">
    <h2 class="chx-h3">${esc(p.question)}</h2>
    <div class="chx-poll-opts"${mine ? ' hidden' : ''}>${p.options.map((o) => `<button type="button" class="chx-pill" data-value="${esc(o.value)}">${esc(o.label)}</button>`).join('')}</div>
    <ul class="chx-poll-res"${mine ? '' : ' hidden'}>${res}</ul>
    <p class="chx-fine" data-ch-poll-note${mine ? '' : ' hidden'}>${esc(DAY_PAGE.pollThanks)}${results ? ` ${results.total} answer${results.total === 1 ? '' : 's'} so far.` : ''}</p>
  </section>`;
}

function calcHtml() {
  return `<section class="chx-calc" data-ch-calc>
    <h2 class="chx-h3">${esc(DAY_PAGE.calcHeading)}</h2>
    <div class="chx-calc-g">
      <label class="chx-f"><span>${esc(DAY_PAGE.calcEbitda)}</span><input inputmode="decimal" data-calc="ebitda" value="600000"></label>
      <label class="chx-f"><span>${esc(DAY_PAGE.calcService)}</span><input inputmode="decimal" data-calc="service" value="360000"></label>
      <div class="chx-calc-r"><span>${esc(DAY_PAGE.calcResult)}</span><strong data-calc-out>1.67x</strong><em data-calc-verdict>${esc(DAY_PAGE.calcPass)}</em></div>
    </div>
    <p class="chx-fine">${esc(DAY_PAGE.calcNote)}</p>
  </section>`;
}

function vipAreaHtml(d: DayRow, vip: boolean, review: Awaited<ReturnType<typeof homeworkFor>>, token: string, vipOn: boolean, vipUrl: string) {
  if (!vip) return vipOn && Date.now() < dayEnds(d) ? `<p class="chx-quiet">${esc(DAY_PAGE.vipUpsell)} <a href="${esc(vipUrl)}">${esc(DAY_PAGE.vipUpsellButton)}</a></p>` : '';
  return `<section class="chx-vipbox" aria-labelledby="chx-vip-h">
    <p class="chx-eyebrow"><span class="chx-vip">VIP</span></p>
    <h2 class="chx-h3" id="chx-vip-h">${esc(DAY_PAGE.hotHeading)}</h2>
    <p class="chx-p">${esc(DAY_PAGE.hotLine)}</p>
    ${d.hot_seat_url ? `<a class="chx-go" href="${esc(d.hot_seat_url)}" target="_blank" rel="noopener">${esc(DAY_PAGE.hotJoin)} ${ICON.ext}</a>` : `<p class="chx-fine">${esc(DAY_PAGE.hotSame)}</p>`}
    <form data-ch-hot data-day="${d.day}" class="chx-hot"><label class="chx-f"><span>${esc(DAY_PAGE.hotAsk)}</span><textarea name="q" rows="2" maxlength="1000" placeholder="${esc(DAY_PAGE.hotPlaceholder)}"></textarea></label><button type="submit" class="chx-go chx-go-s">Send</button><p class="chx-fine" role="status" data-ch-hot-msg></p></form>
    ${review ? `<div class="chx-review"><h3 class="chx-h4">${esc(DAY_PAGE.reviewHeading)}</h3>${review.review ? `<p class="chx-p">${esc(review.review)}</p>${review.reviewedBy ? `<p class="chx-fine">${esc(review.reviewedBy)}</p>` : ''}` : `<p class="chx-fine">${esc(DAY_PAGE.reviewWaiting)}</p>`}</div>` : ''}
    <input type="hidden" value="${esc(token)}">
  </section>`;
}

function chatHtml(open: boolean, ended = false) {
  return `<aside class="chx-chat" data-ch-chat aria-label="${esc(DAY_PAGE.chatHeading)}">
    <div class="chx-chat-head"><h2 class="chx-h3">${esc(DAY_PAGE.chatHeading)}</h2><p class="chx-fine" data-ch-presence></p></div>
    <p class="chx-fine">${esc(DAY_PAGE.chatNote)}</p>
    <div class="chx-pin" data-ch-pin hidden></div>
    <ol class="chx-msgs" data-ch-msgs aria-live="polite"><li class="chx-empty">${esc(open ? DAY_PAGE.chatEmpty : ended ? DAY_PAGE.chatEnded : DAY_PAGE.chatClosed)}</li></ol>
    <form class="chx-send" data-ch-send${open ? '' : ' hidden'}><input name="text" maxlength="400" placeholder="${esc(DAY_PAGE.chatPlaceholder)}" aria-label="${esc(DAY_PAGE.chatPlaceholder)}" autocomplete="off"><button type="submit">${esc(DAY_PAGE.chatSend)}</button></form>
    <p class="chx-err" data-ch-chat-err hidden></p>
  </aside>`;
}

export async function dayPage(c: Context<AppEnv>) {
  const { rt, reg } = await loadReg(c);
  const n = Number(c.req.param('n'));
  if (!reg || !Number.isInteger(n) || n < 1 || n > DAYS_IN_CHALLENGE) return notFound(c);
  if (reg.status !== 'paid') return c.redirect(nextStep(rt, reg), 302);
  const v = await participantView(rt, reg);
  const d = v?.days.find((x) => x.day === n);
  if (!v || !d) return notFound(c);
  const cfg = challengeConfig(rt.settings);
  const [saved, mine, results, ov] = await Promise.all([homeworkFor(rt, reg.id, n), myPoll(rt, reg.id, n), pollResults(rt, reg.cohort_id, n), offerView(rt, reg)]);
  const key = eventKey(reg.cohort_id, n);
  // The live engine's Zoom card (live-player.js) mounts over our own session card until the session ends; without
  // the script our card stays (its Join button goes through /challenge/join, which counts attendance).
  const playback = await playbackFor(rt, key, d.join_url, { startsAt: d.starts_at, durationMin: d.duration_min }).catch(() => null);
  const offerDay = n >= 4;
  const locked = Date.now() < d.starts_at - 30 * 60_000;
  const offer = offerDay || v.offer.open ? offerBlockHtml({ view: ov, closeAt: v.closeAt, now: v.now, soft: v.offer.day === 4 || (!v.offer.open && n === 4), guarantee: guaranteeHtml(rt), open: v.offer.open || ov.paid, token: reg.token, day: n }) : '';
  const notify = offerDay && !v.offer.open && !v.offer.expired && !ov.paid ? `<p class="chx-notify" data-ch-notify-wrap><button type="button" class="chx-link" data-ch-notify>${esc(DAY_PAGE.notifyButton)}</button></p>` : '';
  const main = `<section class="chx-dayp"><div class="chx-wrap">
    <p class="chx-back"><a href="/challenge/hub/${esc(reg.token)}">← ${esc(DAY_PAGE.back)}</a></p>
    <div class="chx-day-grid">
      <div class="chx-day-main">
        <p class="chx-eyebrow">Day ${n} of ${DAYS_IN_CHALLENGE}${v.vip ? ' · VIP' : ''}</p>
        <h1 class="chx-h1 chx-h1-s">${esc(d.content.title)}</h1>
        <div class="chx-player" data-ch-player${d.phase === 'ended' ? '' : ' data-mount="1"'}>${sessionCard(v, reg, d, { compact: true })}</div>
        ${notify}
        ${offer}
        <p class="chx-p chx-day-line">${esc(d.content.line)}</p>
        <ul class="chx-points">${d.content.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
        ${worksheetHtml(n, saved, locked)}
        ${n === 4 ? calcHtml() : ''}
        ${locked ? '' : pollHtml(n, mine, results)}
        ${vipAreaHtml(d, v.vip, v.vip ? saved : null, reg.token, cfg.vipOn, payUrl(rt, reg.token, 'vip'))}
      </div>
      ${chatHtml(Date.now() >= d.starts_at - 30 * 60_000 && Date.now() <= dayEnds(d) + 30 * 60_000, Date.now() > dayEnds(d) + 30 * 60_000)}
    </div>
  </div></section>`;
  return page(c, {
    title: `Day ${n}: ${d.content.title}`,
    main,
    bar: !ov.paid ? barHtml({ closeAt: v.closeAt, now: v.now, open: v.offer.open, deposit: ov.deposit }) : '',
    navright: v.vip ? `<span class="chx-vip">${esc(HUB.vipBadge)}</span>` : '',
    config: {
      token: reg.token, day: n, key, now: v.now, offerDay, offerOpen: v.offer.open,
      feed: '/api/challenge/feed', chat: '/api/challenge/chat', worksheet: '/api/challenge/worksheet', poll: '/api/challenge/poll', hot: '/api/challenge/hot', deposit: '/api/challenge/deposit',
      offerUrl: `/api/live/${encodeURIComponent(key)}/offer`,
      playback, joined: '/api/challenge/joined',
      playerNote: HUB.joinNote,
      copy: { notifyOn: DAY_PAGE.notifyOn, notifyTitle: DAY_PAGE.notifyTitle, calcPass: DAY_PAGE.calcPass, calcFail: DAY_PAGE.calcFail, chatEmpty: DAY_PAGE.chatEmpty, pollThanks: DAY_PAGE.pollThanks, team: 'Team', closed: OFFER.closed },
    },
  });
}

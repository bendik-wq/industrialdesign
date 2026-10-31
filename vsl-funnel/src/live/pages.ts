import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { render } from '../funnel/pages';
import { getLead } from '../funnel/leads';
import { formatCallTime } from '../integrations/email';
import { WORKSHEET } from '../webinar/content';
import { type LiveEvent, type LiveReg, ROOM_COPY, getEvent, getLiveReg, liveBase, liveSettings, liveStage, nextEvent, offerWindow, roomState, startLiveTicket, streamKey, ticketGate } from './events';
import { depositConfig, depositCopy, depositQuote, depositStatus, guaranteeHtml, onboardingUrl } from '../sales/deposit';
import { guarantee } from '../sales/guarantee';
import { playbackFor } from './stream';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

/** Every string on the landing page (checked by auditCopy in the tests). */
export const LANDING_COPY = {
  eyebrow: 'Live with Josh Li, with Q&A',
  h1: 'Buy your first competitor with the bank’s money and the seller’s',
  lede: 'A live session for owners of businesses doing $1M+ a year: how commercial debt, seller finance and seller rollover fund the purchase of a competitor, where to find the owner with no successor, and the 1.5x test lenders use. Then Josh answers your questions live.',
  points: [
    ['Where the deals are', 'Off-market owners with no successor, and how to reach them before a broker does.'],
    ['How the price gets funded', 'Commercial debt, seller finance and seller rollover, and the order: the shape with the seller first, then the lender.'],
    ['The test every deal must pass', 'The 1.5x debt service coverage test, worked through on a real-sized example.'],
    ['Why a group is worth more', 'A group of businesses trades at a higher multiple than one business on its own (illustrative: 3 to 5 times profit for one, 8 to 12 times for a group).'],
  ] as [string, string][],
  host: 'Your host: Josh Li',
  hostBody: 'Founder of JC Health Group, his own healthcare holding company. Josh bought his clinics in two acquisitions, and in both the sellers financed 100% of the price.',
  forWhom: 'For owners of businesses doing $1M+ a year.',
  formHeading: 'Save your seat',
  button: 'Save my seat',
  ticketButton: (label: string) => `Get my ticket, ${label}`,
  ticketLine: (label: string) => `Ticket: ${label}, paid securely through Whop. It comes off the engagement deposit if you take it.`,
  privacy: 'We email you your room link, reminders before the session and the replay. Unsubscribe any time.',
  sms: 'Text me the room link and a reminder before the session. Msg & data rates may apply. Reply STOP to opt out.',
  startsIn: 'Starts in',
  none: 'The next live session isn’t scheduled yet.',
  noneBody: 'In the meantime, the recorded masterclass covers the same method.',
  noneLink: 'Watch the masterclass',
  started: 'Live now. Register and go straight to the room.',
};

const REVENUE = [['lt1m', 'Under $1M'], ['1_3m', '$1M – $3M'], ['3_10m', '$3M – $10M'], ['10_25m', '$10M – $25M'], ['25_50m', '$25M – $50M'], ['50_100m', '$50M – $100M'], ['gt100m', '$100M+']];

const when = (t: number, tz: string | null) => formatCallTime(t, tz);

export async function liveLanding(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const v = c.get('visitor');
  const ev = await nextEvent(rt);
  const s = liveSettings(rt);
  const L = LANDING_COPY;
  const tz = v.geo.timezone ?? ev?.tz ?? null;
  const ticket = s.ticket && (await import('../webinar/pass')).paymentProvider(rt.settings) === 'whop' ? s.ticket : null;
  const btn = ticket ? L.ticketButton(ticket.label) : L.button;
  const main = !ev
    ? `<section class="lv-hero"><div class="wrap narrow"><p class="lv-eyebrow">${esc(L.eyebrow)}</p><h1 class="lv-h1">${esc(L.h1)}</h1><p class="lv-lede">${esc(L.none)} ${esc(L.noneBody)}</p><p><a class="lv-link" href="${esc((rt.settings.WEBINAR_URL || `${rt.origin}/webinar`).replace(/\/+$/, ''))}">${esc(L.noneLink)}</a></p></div></section>`
    : `<section class="lv-hero"><div class="wrap narrow">
        <p class="lv-eyebrow">${esc(L.eyebrow)}</p>
        <h1 class="lv-h1">${esc(L.h1)}</h1>
        <p class="lv-when"><span data-local-time="${ev.starts_at}">${esc(when(ev.starts_at, tz))}</span></p>
        <div class="lv-count" data-countdown="${ev.starts_at}" aria-live="off"><span class="lv-count-l">${esc(Date.now() >= ev.starts_at ? L.started : L.startsIn)}</span> <span class="lv-count-v" data-countdown-v></span></div>
        <a class="buy-btn lv-cta" href="#register" data-track="cta_click" data-track-id="live_hero_cta">${esc(btn)} ${ARROW}</a>
        ${ticket ? `<p class="lv-fine">${esc(L.ticketLine(ticket.label))}</p>` : ''}
        <p class="lv-lede">${esc(L.lede)}</p>
      </div></section>
      <section class="lv-learn"><div class="wrap narrow"><ul class="lv-points">${L.points.map(([h, b]) => `<li><strong>${esc(h)}.</strong> ${esc(b)}</li>`).join('')}</ul>
        <div class="lv-host"><p class="lv-host-h">${esc(L.host)}</p><p>${esc(L.hostBody)}</p></div></div></section>
      <section class="lv-reg" id="register"><div class="wrap narrow">
        <h2 class="lv-h2">${esc(L.formHeading)}</h2>
        <p class="lv-sub">${esc(ev.title)} · <span data-local-time="${ev.starts_at}">${esc(when(ev.starts_at, tz))}</span></p>
        <form class="lv-form" data-live-register novalidate autocomplete="on">
          <input type="hidden" name="event_id" value="${esc(ev.id)}">
          <div class="lv-row">
            <label class="lv-field"><span>First name</span><input name="first_name" autocomplete="given-name" required></label>
            <label class="lv-field"><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
          </div>
          <fieldset class="lv-field"><legend>Your business’s annual revenue</legend><div class="lv-opts">${REVENUE.map(([k, l]) => `<label class="lv-opt"><input type="radio" name="revenue" value="${k}"><span>${esc(l)}</span></label>`).join('')}</div></fieldset>
          <label class="lv-field"><span>Mobile <span class="lv-muted">(optional, for a text reminder)</span></span><input name="phone" type="tel" autocomplete="tel" inputmode="tel"></label>
          <label class="lv-check"><input type="checkbox" name="sms_consent"><span>${esc(L.sms)}</span></label>
          <div data-turnstile></div>
          <button class="buy-btn" type="submit" data-track="cta_click" data-track-id="live_register">${esc(btn)} ${ARROW}</button>
          <p class="lv-err" role="alert" data-err hidden></p>
          <p class="lv-fine">${esc(L.privacy)} <a href="/privacy">Privacy policy</a>.</p>
        </form>
        <p class="lv-forwhom">${esc(L.forWhom)}</p>
      </div></section>`;
  return render(c, '/live.html', {
    title: ev ? ev.title : 'Live with Josh',
    blocks: { main, navmeta: '' },
    config: { webinar: {}, turnstileSiteKey: rt.settings.TURNSTILE_SITE_KEY || null, live: { page: 'landing', register: '/api/live/register', startsAt: ev?.starts_at ?? null, copy: { startsIn: L.startsIn, started: L.started } } },
    seo: { title: `${L.h1} | Live with Josh Li`, description: L.lede, path: '/live', index: Boolean(ev) },
  });
}

// ───────────── room ─────────────

async function loadReg(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const reg = await getLiveReg(rt, c.req.param('token') ?? '');
  const ev = reg ? await getEvent(rt, reg.event_id) : null;
  return { rt, reg, ev };
}
const notFound = (c: Context<AppEnv>) => render(c, '/live.html', { title: 'Link not found', blocks: { main: `<section class="lv-hero"><div class="wrap narrow"><h1 class="lv-h2">We couldn’t find that link</h1><p class="lv-lede">Open the link from your confirmation email, or register again.</p><p><a class="lv-link" href="/live">Register for the next live session</a></p></div></section>`, navmeta: '' } });

const icon = { bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>' };

/** The deposit offer block (hidden until the host opens it), or the worksheet path for under-$1M viewers. */
export async function offerBlock(rt: Runtime, reg: LiveReg) {
  const q = await depositQuote(rt, reg.lead_id);
  const copy = depositCopy(q.cfg, { left: q.cap.left });
  const { isMillionPlus } = await import('../sales/qualify');
  if (!isMillionPlus(reg.revenue_band)) {
    return `<section class="lv-offer lv-offer-wk" data-offer hidden aria-live="polite"><p class="lv-eyebrow">${esc(copy.eyebrow)}</p><h2 class="lv-offer-h">${esc(copy.underMillionHeading)}</h2><p class="lv-offer-p">${esc(copy.underMillionBody)}</p><a class="lv-btn-2" href="${esc(`${liveBase(rt)}/live/worksheet/${reg.token}`)}">${esc(copy.underMillionButton)}</a></section>`;
  }
  const price = q.credit ? `<p class="lv-offer-fine">Today: ${esc(q.todayLabel)} (${esc(q.cfg.label)} less your ${esc(q.creditLabel ?? '')} ticket). The full ${esc(q.cfg.label)} is credited.</p>` : '';
  return `<section class="lv-offer" data-offer hidden aria-live="polite">
    <p class="lv-eyebrow">${esc(copy.eyebrow)}</p>
    <h2 class="lv-offer-h">${esc(copy.heading)}</h2>
    <p class="lv-price">${esc(copy.price)}</p>
    <p class="lv-offer-note">${esc(copy.priceNote)}</p>
    <ul class="lv-secures">${copy.secures.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <p class="lv-offer-fine">${esc(copy.fees)}</p>
    ${price}
    ${q.paid ? `<a class="buy-btn lv-buy" href="${esc(`${liveBase(rt)}/live/welcome/${reg.token}`)}">Your place is secured: what happens next ${ARROW}</a>` : `<button type="button" class="buy-btn lv-buy" data-buy>${esc(copy.button)} ${ARROW}</button>`}
    ${copy.capLine ? `<p class="lv-cap">${esc(copy.capLine)}</p>` : ''}
    <p class="lv-closes" data-closes><span>${esc(copy.closes)}</span> <span class="buy-timer" data-offer-timer></span></p>
    <p class="lv-err" role="alert" data-buy-err hidden></p>
    ${guaranteeHtml(rt)}
  </section>
  <div class="lv-bar" data-buybar hidden><div class="wrap lv-bar-in"><p class="lv-bar-t"><strong>${esc(copy.buyBar)}</strong> <span class="buy-timer" data-offer-timer></span></p>${q.paid ? '' : `<button type="button" class="buy-btn lv-bar-btn" data-buy>${esc(copy.buyBarButton)}</button>`}</div></div>
  <div class="lv-dialog" data-oneclick hidden role="dialog" aria-modal="true" aria-labelledby="lv-oc-h"><div class="lv-dialog-in">
    <h3 id="lv-oc-h" class="lv-offer-h">${esc(copy.oneClickHeading)}</h3>
    <p class="lv-offer-p">${esc(copy.oneClickCharged(q.oneClick?.card ?? null))}</p>
    <button type="button" class="buy-btn" data-oc-confirm>${esc(copy.oneClickConfirm(q.todayLabel))}</button>
    <button type="button" class="lv-btn-2" data-oc-other>${esc(copy.otherCard)}</button>
    <button type="button" class="lv-x" data-oc-close aria-label="Close">×</button>
  </div></div>`;
}

export async function liveRoom(c: Context<AppEnv>) {
  const { rt, reg, ev } = await loadReg(c);
  if (!reg || !ev) return notFound(c);
  const now = Date.now();
  const st = await roomState(rt, ev, reg, now);
  const lead = await getLead(rt.env, reg.lead_id);
  const tz = c.get('visitor').geo.timezone ?? lead?.timezone ?? ev.tz;
  const C = ROOM_COPY;
  const gate = await ticketGate(rt, reg);
  // Signed in to this browser: the room link is a bearer token, like the masterclass room.
  if (!c.get('visitor').leadId && reg.new_lead) await (await import('../funnel/leads')).linkVisitor(rt.env, c.get('visitor').visitorId, reg.lead_id).catch(() => null);
  const head = `<header class="lv-rhead"><h1 class="lv-rtitle">${esc(ev.title)}</h1><p class="lv-rwhen"><span data-local-time="${ev.starts_at}">${esc(when(ev.starts_at, tz))}</span></p></header>`;
  if (gate) {
    return render(c, '/live.html', { title: C.ticketHeading, blocks: { navmeta: '', main: `<section class="lv-room"><div class="wrap lv-rwrap">${head}<div class="lv-card"><h2 class="lv-offer-h">${esc(C.ticketHeading)}</h2><p class="lv-offer-p">${esc(C.ticketBody)}</p><a class="buy-btn" href="${esc(`${liveBase(rt)}/live/ticket/${reg.token}`)}">${esc(C.ticketButton)} ${ARROW}</a></div></div></section>` } });
  }
  if (st.stage === 'closed' || st.stage === 'cancelled') {
    const [h, b] = st.stage === 'closed' ? [C.closedHeading, C.closedBody] : [C.cancelledHeading, C.cancelledBody];
    return render(c, '/live.html', { title: h, blocks: { navmeta: '', main: `<section class="lv-room"><div class="wrap lv-rwrap">${head}<div class="lv-card"><h2 class="lv-offer-h">${esc(h)}</h2><p class="lv-offer-p">${esc(b)}</p></div></div></section>` } });
  }
  const playback = await playbackFor(rt, streamKey(ev.id), ev.join_url, { startsAt: ev.starts_at, durationMin: Math.max(1, Math.round((st.endsAt - ev.starts_at) / 60_000)) });
  const offer = await offerBlock(rt, reg);
  const q = await depositQuote(rt, reg.lead_id);
  const main = `<section class="lv-room"><div class="wrap lv-rwrap">
    ${head}
    <div class="lv-timerbar" data-timerbar hidden><span>${esc(depositCopy(depositConfig(rt)).closes)}</span> <span class="buy-timer" data-offer-timer></span></div>
    <div class="lv-pin" data-pin hidden></div>
    <div class="lv-grid">
      <div class="lv-mainc">
        <section class="lv-stage" data-player aria-live="polite">
          <div class="lv-join" data-join-card>
            <p class="lv-live-dot" data-live-dot hidden><span class="lv-dot"></span> Live</p>
            <h2 class="lv-join-h" data-join-h>${esc(C.joinHeading)}</h2>
            <p class="lv-join-p" data-join-p>${esc(C.joinSoon)}</p>
            <div class="lv-count" data-countdown="${ev.starts_at}"><span class="lv-count-l">${esc(C.startsIn)}</span> <span class="lv-count-v" data-countdown-v></span></div>
            <a class="lv-zoom" data-zoom href="#" target="_blank" rel="noopener" hidden>${esc(C.joinButton)} ${ARROW}</a>
          </div>
        </section>
        <div class="lv-keep"><p>${esc(C.keepOpen)}</p><button type="button" class="lv-btn-2 lv-notify" data-notify hidden>${icon.bell} ${esc(C.notifyButton)}</button><p class="lv-muted lv-small" data-notify-note hidden></p></div>
        ${offer}
        <section class="lv-poll" data-poll hidden><p class="lv-eyebrow">${esc(C.pollHeading)}</p><h3 class="lv-poll-q" data-poll-q></h3><div class="lv-poll-opts" data-poll-opts></div></section>
      </div>
      <aside class="lv-side">
        <section class="lv-chat" data-chat>
          <div class="lv-chat-h"><h2>${esc(C.chatHeading)}</h2><p class="lv-presence" data-presence></p></div>
          <p class="lv-muted lv-small">${esc(C.chatNote)}</p>
          <ol class="lv-msgs" data-msgs><li class="lv-muted lv-small" data-empty>${esc(C.chatEmpty)}</li></ol>
          <form class="lv-chat-f" data-chat-form><input name="text" maxlength="400" placeholder="${esc(C.chatPlaceholder)}" aria-label="${esc(C.chatPlaceholder)}" autocomplete="off"><button class="lv-send" type="submit">${esc(C.chatSend)}</button></form>
          <label class="lv-check lv-small"><input type="checkbox" data-anon> <span>${esc(C.anonToggle)}</span></label>
          <p class="lv-err lv-small" data-chat-err hidden></p>
        </section>
      </aside>
    </div>
  </div></section>`;
  return render(c, '/live.html', {
    title: ev.title,
    blocks: { main, navmeta: '' },
    config: {
      live: {
        page: 'room', token: reg.token, title: ev.title, state: st, key: streamKey(ev.id), serverNow: now, playback: { ...playback, joinUrl: st.joinUrl },
        feed: '/api/live/feed', chat: '/api/live/chat', vote: '/api/live/vote', join: '/api/live/join', buy: '/api/live/deposit',
        oneClick: q.oneClick && !q.paid ? q.oneClick : null, paid: q.paid, copy: { ...C, offerTitle: `${C.offerNotice} · ${ev.title}`, notifyBody: `${depositCopy(depositConfig(rt)).price}. Go back to the tab you came from.` },
      },
    },
  });
}

/** GET /live/ticket/:token: straight to the ticket payment page (or the room when nothing is owed). */
export async function liveTicketPage(c: Context<AppEnv>) {
  const { rt, reg } = await loadReg(c);
  if (!reg) return notFound(c);
  const r = await startLiveTicket(rt, reg);
  return c.redirect(r.url ?? `${liveBase(rt)}/live/room/${reg.token}`, 302);
}

// ───────────── welcome ─────────────

export const WELCOME_COPY = {
  eyebrow: 'Your place is secured',
  heading: (name: string) => `Welcome${name ? `, ${name}` : ''}. Your place in the engagement is held.`,
  pending: 'Confirming your payment with Whop. This page refreshes on its own.',
  none: 'We don’t see a deposit on this registration yet.',
  noneBack: 'Back to the room',
  step1: 'Book your onboarding call',
  step1Body: 'About 30 minutes with Josh’s team to set up your kickoff: your goals, your numbers and the documents to gather.',
  step1None: 'Josh’s team emails you within one business day to set the time.',
  step1Button: 'Book my onboarding call',
  nextHeading: 'What happens next',
  next: [
    'The onboarding call sets your kickoff date and the list of documents, including the last two years of financials.',
    'You receive the engagement agreement for e-signature, with your deposit already taken off the fee. The balance is due when you sign it.',
    'Kickoff within 7 days of signing, then the weekly working sessions with Josh’s team.',
  ],
  agreementHeading: 'Your engagement agreement',
  agreementDraft: 'It is drafted with your deposit credited, and it arrives by email for your e-signature after the onboarding call.',
  agreementSent: 'It is ready for your signature.',
  agreementButton: 'Review and sign the agreement',
  receipt: (paid: string, credited: string) => `Deposit paid: ${paid}. Credited against the engagement fee: ${credited}.`,
};

export async function liveWelcome(c: Context<AppEnv>) {
  const { rt, reg, ev } = await loadReg(c);
  if (!reg || !ev) return notFound(c);
  const W = WELCOME_COPY;
  const status = await depositStatus(rt, reg.lead_id, ev.id);
  const lead = await getLead(rt.env, reg.lead_id);
  const room = `${liveBase(rt)}/live/room/${reg.token}`;
  if (status !== 'paid') {
    const body = status === 'pending' ? `<p class="lv-lede" data-refresh="5">${esc(W.pending)}</p>` : `<p class="lv-lede">${esc(W.none)}</p><p><a class="lv-link" href="${esc(room)}">${esc(W.noneBack)}</a></p>`;
    return render(c, '/live.html', { title: W.eyebrow, blocks: { navmeta: '', main: `<section class="lv-hero"><div class="wrap narrow">${body}</div></section>` }, config: { live: { page: 'welcome', refresh: status === 'pending' } } });
  }
  const pass = await rt.env.DB.prepare("SELECT amount, ticket_credit, currency FROM webinar_passes WHERE lead_id = ? AND kind = 'deposit' AND status = 'paid' ORDER BY paid_at DESC LIMIT 1").bind(reg.lead_id).first<{ amount: number; ticket_credit: number; currency: string }>();
  const { formatMoney, fromMinor } = await import('../webinar/pass');
  const m = (x: number) => formatMoney(fromMinor(x, pass!.currency), pass!.currency.toUpperCase());
  const k = await rt.env.DB.prepare("SELECT token, status FROM contracts WHERE lead_id = ? AND status IN ('draft', 'sent', 'viewed') AND COALESCE(is_test, 0) = 0 ORDER BY created_at DESC LIMIT 1").bind(reg.lead_id).first<{ token: string; status: string }>();
  const ob = onboardingUrl(rt);
  const { safeFirstName } = await import('../lib/text');
  const main = `<section class="lv-welcome"><div class="wrap narrow">
    <p class="lv-eyebrow">${esc(W.eyebrow)}</p>
    <h1 class="lv-h1 lv-h1-s">${esc(W.heading(safeFirstName(lead?.first_name) ?? ''))}</h1>
    ${pass ? `<p class="lv-fine">${esc(W.receipt(m(pass.amount), m(pass.amount + pass.ticket_credit)))}</p>` : ''}
    <div class="lv-card lv-step1"><p class="lv-step-n">1</p><h2 class="lv-offer-h">${esc(W.step1)}</h2><p class="lv-offer-p">${esc(W.step1Body)}</p>
      ${ob ? `<a class="buy-btn" href="${esc(ob)}" target="_blank" rel="noopener" data-track="cta_click" data-track-id="deposit_onboarding_book">${esc(W.step1Button)} ${ARROW}</a>` : `<p class="lv-offer-p"><strong>${esc(W.step1None)}</strong></p>`}</div>
    <h2 class="lv-h2">${esc(W.nextHeading)}</h2>
    <ol class="lv-next">${W.next.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    ${guaranteeHtml(rt)}
    <h2 class="lv-h2">${esc(W.agreementHeading)}</h2>
    <p class="lv-offer-p">${esc(k && k.status !== 'draft' ? W.agreementSent : W.agreementDraft)}</p>
    ${k && k.status !== 'draft' ? `<p><a class="lv-btn-2" href="${esc(`${rt.origin}/sign/${k.token}`)}">${esc(W.agreementButton)}</a></p>` : ''}
  </div></section>`;
  return render(c, '/live.html', { title: W.eyebrow, blocks: { navmeta: '', main }, config: { live: { page: 'welcome' } } });
}

/** GET /live/worksheet/:token: the deal structure worksheet (the under-$1M path). */
export async function liveWorksheet(c: Context<AppEnv>) {
  const { reg } = await loadReg(c);
  if (!reg) return notFound(c);
  const body = `<header class="ws-head"><span class="eyebrow">Worksheet</span><h1 class="h2">${esc(WORKSHEET.title)}</h1><p class="lede">${esc(WORKSHEET.intro)}</p></header>` +
    WORKSHEET.sections.map((s, i) => `<section class="ws-sec"><h2 class="h3">${/^\d/.test(s.heading) ? '' : `${i + 1}. `}${esc(s.heading)}</h2>${s.paras.map((p) => `<p>${esc(p)}</p>`).join('')}${s.rows?.length ? `<table class="ws-rows"><tbody>${s.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>` : ''}</section>`).join('') +
    `<p class="muted ws-disc">${esc(WORKSHEET.disclaimer)}</p>`;
  return render(c, '/webinar-worksheet.html', { title: WORKSHEET.title, blocks: { worksheet: body } });
}

// ───────────── /guarantee ─────────────

export async function guaranteePage(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const g = guarantee(rt);
  const main = `<section class="lv-welcome"><div class="wrap narrow">
    <p class="lv-eyebrow">The guarantee</p>
    <h1 class="lv-h1 lv-h1-s">${esc(g.headline)}</h1>
    <p class="lv-lede">${esc(g.body)}</p>
    <h2 class="lv-h2">The conditions</h2>
    <p class="lv-offer-p">The guarantee applies to the 90-day advisory engagement when you meet every one of these:</p>
    <ol class="lv-next">${g.conditions.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    <h2 class="lv-h2">What it means</h2>
    ${g.definitions.map((x) => `<p class="lv-offer-p">${esc(x)}</p>`).join('')}
    <p class="lv-offer-p">The 90 days run from the date both parties sign the engagement agreement. To claim, email the team within 14 days after the 90 days end. The team confirms the conditions from the session and outreach records. Your engagement agreement holds the binding wording.</p>
  </div></section>`;
  return render(c, '/live.html', { title: 'The guarantee', blocks: { navmeta: '', main }, seo: { title: `${g.headline} | G&L M&A Advisory`, description: g.body, path: '/guarantee', index: false } });
}

export type { LiveEvent };
export { liveStage, offerWindow };

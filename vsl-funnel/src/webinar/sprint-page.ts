import type { Context } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { render } from '../funnel/pages';
import { identityFromLead, track } from '../tracking/track';
import { type Registration, type Session, getRegistration, getSession, roomUrl, webinarSettings } from './webinar';
import { activePass, confirmOnReturn, holderCardHtml } from './pass';
import {
  type SprintRoom, mmss, offerDeadline, pitchSec, reachedPitch, sprintCopy, sprintFaq, sprintQualified, sprintRoomConfig, sprintSettings, sprintWindow, teamEmail, unlockSprint,
} from './sprint';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
type RegLike = Registration & { offer_unlocked_at?: number | null };

/**
 * Funnel HQ → Page previews: a made-up viewer for whom the Sprint unlocked five minutes ago (pitch passed,
 * replay open for two days). Nothing is read or saved: "preview" never matches a registration.
 */
function previewOffer(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const w = webinarSettings(rt);
  const now = Date.now();
  const session: Session = { id: 'ws_preview', starts_at: now - (w.pitchAtMin + 5) * 60_000, title: null, mode: 'evergreen', join_url: null, video_src: null, status: 'scheduled', auto: 2 };
  const reg: RegLike = {
    id: 'wr_preview', token: 'preview', session_id: session.id, lead_id: 'l_preview', seq: 0, new_lead: 0, created_at: now - 3_600_000,
    joined_at: session.starts_at, last_seen_at: now, watch_seconds: 0, max_position: w.pitchAtMin * 60, cta_at: null, replay_at: null, replay_seconds: 0, replay_until: null,
    offer_unlocked_at: now - 5 * 60_000,
  };
  return { rt, reg, session };
}

const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v6c0 4.4-3 7.9-7 9-4-1.1-7-4.6-7-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>';
const LOCK_OPEN = '<svg class="sprint-lock-i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.8"/></svg>';
const timer = (to: number, kind: 'bonus' | 'deadline', cls = 'buy-timer') => `<b class="${cls}" role="timer" aria-live="off" data-sprint-to="${to}" data-sprint-kind="${kind}"></b>`;
const fill = (t: string, o: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (_, k) => String(o[k] ?? ''));

/** The buy block (the same one the room shows at the unlock), server-rendered. `full` = with the bonus and the promise. */
export function offerBuyHtml(S: SprintRoom, now = Date.now(), o: { full: boolean } = { full: true }) {
  const C = S.copy;
  const bonusOpen = Boolean(S.bonus && S.bonusEndsAt && S.bonusEndsAt > now);
  const micro = S.oneClick ? (S.oneClick.card ? fill(C.microOneClick, { card: S.oneClick.card }) : C.microOneClickNoCard) : C.micro;
  const bonus = !S.bonus ? '' : bonusOpen
    ? `<div class="buy-bonus" data-sprint-bonus><div class="buy-bonus-t"><p class="buy-label">${esc(C.bonusEyebrow)}</p><p><strong>${esc(S.bonus.title)}</strong>${S.bonus.body ? `: ${esc(S.bonus.body)}` : ''}</p></div><div class="buy-bonus-c"><span>${esc(C.bonusEndsIn)}</span>${timer(S.bonusEndsAt!, 'bonus', 'buy-timer big')}</div></div>`
    : `<div class="buy-bonus gone" data-sprint-bonus><p class="buy-bonus-gone">${esc(C.bonusGone)}</p></div>`;
  const button = S.full ? `<p class="buy-soldout">${esc(S.soldOut ?? '')}</p>`
    : `<button type="button" class="buy-btn buy-btn-xl" data-sprint-buy="full" data-where="${o.full ? 'offer' : 'offer_end'}"><span data-label>${esc(C.button)}</span><span class="buy-btn-price">${esc(S.price)}</span>${ARROW}</button>`;
  return `<section class="buy-hero offer-hero" aria-label="${esc(S.name)}">
    ${o.full ? `<p class="buy-badge">${LOCK_OPEN}${esc(C.unlockedEyebrow)} · ${esc(C.fromMasterclass)}</p><h1 class="buy-h">${esc(C.heading)}</h1><p class="buy-promise">${esc(C.promise)}</p>` : `<h2 class="buy-h small">${esc(C.heading)}</h2>`}
    ${bonus}
    <div class="buy-box" data-sprint-buybox>
      <div class="buy-price">${S.credit ? `<s class="buy-anchor">${esc(S.listPrice)}</s>` : ''}<span class="buy-today"><b>${esc(S.price)}</b> ${esc(C.today)}</span>${S.credit ? `<span class="buy-credit">${esc(fill(C.creditApplied, { credit: S.credit }))}</span>` : ''}</div>
      <p class="buy-steps"><span class="on">${esc(C.stepNow)}</span><span aria-hidden="true">→</span><span>${esc(C.stepNext)}</span></p>
      ${button}
      ${S.plan && !S.full ? `<button type="button" class="buy-plan" data-sprint-buy="plan" data-where="offer">${esc(S.plan.line)}</button>` : ''}
      <p class="buy-micro">${esc(micro)}</p>
      <p class="buy-guarantee">${SHIELD}<span>${o.full ? `<strong>${esc(C.guaranteeBadge)}.</strong> ${esc(S.guarantee)}` : esc(C.guaranteeShort)}</span></p>
      ${S.whop && o.full ? `<div class="buy-pay"><ul aria-label="${esc(C.payments)}">${C.paymentBadges.map((b) => `<li>${esc(b)}</li>`).join('')}</ul><p>${esc(C.payments)}</p></div>` : ''}
      ${S.started && o.full ? `<p class="buy-proof">${esc(fill(C.started, { n: S.started }))}</p>` : ''}
      ${S.capLabel ? `<p class="buy-proof">${esc(S.capLabel)}</p>` : ''}
    </div>
    <p class="buy-foot"><span>${esc(C.deadlineShort)} ${timer(S.deadline, 'deadline')}</span></p>
  </section>`;
}

/** /offer/:token: the Sprint's own page, open from the unlock until the offer deadline. One column, one button. */
export async function offerPage(c: Context<AppEnv>) {
  const isPreview = c.req.param('token') === 'preview' && c.get('visitor')?.botReason === 'admin-preview';
  const base = isPreview ? previewOffer(c) : await (async () => {
    const rt = runtimeFrom(c);
    const reg = (await getRegistration(rt, c.req.param('token') ?? '')) as RegLike | null;
    const session = reg ? await getSession(rt, reg.session_id) : null;
    return { rt, reg, session };
  })();
  const { rt, session } = base;
  let reg = base.reg;
  const page = (title: string, html: string, config: Record<string, unknown> = {}) => render(c, '/webinar-offer.html', { title, blocks: { offer: html }, config: { webinar: config } });
  const msg = (h: string, body: string, btn?: { href: string; label: string }) => `<div class="offer-msg"><h1 class="h2">${h}</h1><p class="lede">${body}</p>${btn ? `<p><a class="btn" href="${esc(btn.href)}">${esc(btn.label)}</a></p>` : ''}</div>`;
  if (!reg || !session) return page('Link not found', msg('We couldn’t find that link', 'Open the masterclass from the link in your confirmation email.'));
  const { cfg } = sprintSettings(rt);
  const t = sprintCopy(cfg, { opensAt: mmss(pitchSec(rt)) });
  const room = roomUrl(rt, reg.token);
  const email = teamEmail(rt);
  const emailLink = email ? ` <a href="mailto:${esc(email)}">${esc(t.closedEmail)}</a>` : '';

  if (!isPreview) {
    if (c.req.query('pass') === 'success') await confirmOnReturn(rt, reg);
    const holder = await activePass(rt, reg.lead_id);
    if (holder) return page(`Your ${cfg.offerName}`, holderCardHtml(rt, cfg, holder, reg.token), { ty: reg.token });
    if (cfg.mode === 'off') return page(cfg.offerName, msg(`The ${esc(cfg.offerName)} isn’t open right now`, `It opens again with the next masterclass.${emailLink}`));
    if (!(await sprintQualified(rt, reg))) return page(cfg.offerName, msg(`The ${esc(cfg.offerName)} is for owners doing $1M or more a year`, `Start with the worksheet and the replay. <a href="${esc(room)}">${esc(t.backToRoom)}</a>`));
    // Reached the pitch on the server's evidence but the room never reported it (closed the tab at the pitch): open it now.
    if (reg.offer_unlocked_at == null && reachedPitch(rt, session, reg) && Date.now() < offerDeadline(rt, session, reg)) {
      const r = await unlockSprint(rt, reg, session, {});
      if (r.ok) reg = { ...reg, offer_unlocked_at: r.unlockedAt };
    }
  }
  const now = Date.now();
  const w = sprintWindow(rt, session, reg, now);
  if (!w.unlocked) return page(cfg.offerName, `<div class="offer-msg"><p class="eyebrow">${esc(t.lockedEyebrow)}</p><h1 class="h2">${esc(t.lockedHeading)}</h1><p class="lede">${esc(t.notYet)}</p><p><a class="btn" href="${esc(room)}">${esc(t.backToRoom)}</a></p></div>`);
  if (w.closed) return page(cfg.offerName, msg(esc(cfg.offerName), `${esc(t.closed)}${emailLink}`));

  const S = await sprintRoomConfig(rt, reg, session, true, { preview: isPreview });
  if (!S) return page(cfg.offerName, msg(`The ${esc(cfg.offerName)} isn’t open right now`, emailLink.trim()));
  if (!isPreview) await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_offer_page_view', source: 'server', path: '/offer', props: { session_id: session.id, offer: cfg.offerName } });
  const faq = sprintFaq(cfg);
  const html = `${isPreview ? `<p class="offer-preview">${esc(t.preview)} Shown as a $1M+ ticket holder five minutes after it opened.</p>` : ''}
    ${offerBuyHtml(S, now)}
    <section class="offer-sec"><h2>${esc(t.timeline)}</h2><ol class="offer-days">${cfg.perks.filter((p) => p.day || !/guarantee/i.test(p.title)).map((p) => `<li><span class="d">${esc(p.day || 'Plus')}</span><div><strong>${esc(p.title)}</strong>${p.body ? esc(p.body) : ''}</div></li>`).join('')}</ol></section>
    <section class="offer-sec"><div class="offer-guarantee">${SHIELD}<div><p><strong>${esc(t.guaranteeHeading)}.</strong> ${esc(cfg.guarantee)}</p><p class="fine">${esc(t.guaranteeNote)} ${esc(t.creditNote)}</p></div></div></section>
    <section class="offer-sec sprint-faq"><h2>Questions owners ask</h2>${faq.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</section>
    <div class="offer-final">${offerBuyHtml(S, now, { full: false })}</div>
    <p class="offer-back"><a href="${esc(room)}">${esc(t.backToRoom)}</a></p>`;
  return page(cfg.offerName, html, { sprintPage: { ...S, token: reg.token }, ty: reg.token });
}

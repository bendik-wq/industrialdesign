import type { Context } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { render } from '../funnel/pages';
import { identityFromLead, track } from '../tracking/track';
import { type Registration, type Session, getRegistration, getSession, roomUrl, webinarSettings } from './webinar';
import { type Perk, activePass, confirmOnReturn, holderCardHtml, passCapacity, passCopy } from './pass';
import {
  mmss, offerDeadline, pitchSec, reachedPitch, sprintCopy, sprintFaq, sprintPrice, sprintQualified, sprintSettings, sprintState, sprintWindow, ticketCredit, unlockSprint,
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

const perkItems = (perks: Perk[]) => `<ol class="sprint-days">${perks.map((p) => `<li${p.day ? '' : ' class="nod"'}>${p.day ? `<span class="sprint-day">${esc(p.day)}</span>` : '<span class="sprint-day plus">+</span>'}<div><strong>${esc(p.title)}</strong>${p.body ? `<span>${esc(p.body)}</span>` : ''}</div></li>`).join('')}</ol>`;

/** /offer/:token: the full sales page for the Sprint, open from the unlock until the offer deadline. */
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
  if (!reg || !session) return page('Link not found', '<h1 class="h2">We couldn’t find that link</h1><p class="lede">Open the masterclass from the link in your confirmation email.</p>');
  const { cfg, plan, bonus } = sprintSettings(rt);
  const t = sprintCopy(cfg, { opensAt: mmss(pitchSec(rt)) });
  const room = roomUrl(rt, reg.token);
  const apply = `${rt.origin}/w/${reg.token}`;

  if (!isPreview) {
    if (c.req.query('pass') === 'success') await confirmOnReturn(rt, reg);
    const holder = await activePass(rt, reg.lead_id);
    if (holder) return page(`Your ${cfg.offerName}`, holderCardHtml(rt, cfg, holder, reg.token), { ty: reg.token });
    if (cfg.mode === 'off') return page(cfg.offerName, `<h1 class="h2">The ${esc(cfg.offerName)} isn’t open right now</h1><p class="lede"><a href="${esc(apply)}">Apply for a strategy call</a> instead.</p>`);
    if (!(await sprintQualified(rt, reg))) return page(cfg.offerName, `<h1 class="h2">The ${esc(cfg.offerName)} is for owners doing $1M or more a year</h1><p class="lede">Start with the worksheet and the replay. <a href="${esc(room)}">${esc(t.backToRoom)}</a></p>`);
    // Reached the pitch on the server's evidence but the room never reported it (closed the tab at the pitch): open it now.
    if (reg.offer_unlocked_at == null && reachedPitch(rt, session, reg) && Date.now() < offerDeadline(rt, session, reg)) {
      const r = await unlockSprint(rt, reg, session, {});
      if (r.ok) reg = { ...reg, offer_unlocked_at: r.unlockedAt };
    }
  }
  const now = Date.now();
  const w = sprintWindow(rt, session, reg, now);
  if (!w.unlocked) return page(cfg.offerName, `<p class="eyebrow">${esc(t.lockedEyebrow)}</p><h1 class="h2">${esc(t.lockedHeading)}</h1><p class="lede">${esc(t.notYet)}</p><p><a class="btn" href="${esc(room)}">${esc(t.backToRoom)}</a></p>`);
  if (w.closed) return page(cfg.offerName, `<h1 class="h2">${esc(cfg.offerName)}</h1><p class="lede">${esc(t.closed)}</p><p><a class="btn" href="${esc(apply)}">${esc(t.closedButton)}</a></p>`);

  if (!isPreview) await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_offer_page_view', source: 'server', path: '/offer', props: { session_id: session.id, offer: cfg.offerName } });
  const credit = isPreview ? 0 : await ticketCredit(rt, reg.lead_id, cfg.currency);
  const price = sprintPrice(cfg, plan, credit);
  const cap = isPreview ? { full: false, label: null } : await passCapacity(rt, cfg, now);
  const pc = passCopy(cfg);
  const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  const buyBox = () => `<div class="sprint-buy" data-sprint-buybox>
      <p class="sprint-price">${esc(price.line)}</p>
      ${price.plan ? `<p class="sprint-plan">${esc(price.plan.line)}</p>` : ''}
      <p class="sprint-fine">${esc(t.creditNote)}</p>
      ${bonus ? (w.bonusOpen
        ? `<div class="sprint-bonus" data-sprint-bonus><p class="pass-eyebrow">${esc(t.bonusEyebrow)}</p><p class="sprint-bonus-t"><strong>${esc(bonus.title)}</strong>${bonus.body ? `: ${esc(bonus.body)}` : ''}</p><p class="sprint-bonus-c">${esc(t.bonusEnds)} <b data-sprint-to="${w.bonusEndsAt}" data-sprint-kind="bonus"></b></p></div>`
        : `<div class="sprint-bonus" data-sprint-bonus><p class="sprint-bonus-gone">${esc(t.bonusGone)}</p></div>`) : ''}
      ${cap.label ? `<p class="pass-cap">${esc(cap.label)}</p>` : ''}
      <div class="pass-room-btns">${cap.full ? `<p class="pass-note">${esc(pc.soldOut)}</p>` : `<button type="button" class="btn btn-lg pass-btn" data-sprint-buy="full"><span>${esc(t.button)} <span class="nw">· ${esc(price.todayLabel)}</span></span> ${arrow}</button>${price.plan ? `<button type="button" class="btn btn-lg secondary" data-sprint-buy="plan">${esc(t.planButton)} ${esc(price.plan.button)}</button>` : ''}`}
        <a class="btn btn-lg secondary" href="${esc(apply)}">${esc(t.bookCall)}</a></div>
      <p class="sprint-deadline">${esc(t.deadline)}: <b data-sprint-to="${w.deadline}" data-sprint-kind="deadline"></b></p>
      <p class="pass-fine">${esc(pc.secure)} ${esc(pc.noResults)}</p>
    </div>`;
  const faq = sprintFaq(cfg);
  const html = `${isPreview ? `<p class="pass-note">${esc(t.preview)} Shown as a viewer five minutes after it opened.</p>` : ''}
    <header class="sprint-head"><p class="eyebrow"><span class="sprint-badge">${esc(t.unlockedEyebrow)}</span> From your masterclass</p><h1 class="h1">${esc(t.heading)}</h1><p class="lede">${esc(t.lede)}</p></header>
    ${buyBox()}
    <section class="sprint-sec"><h2>${esc(t.timeline)}</h2>${perkItems(cfg.perks)}</section>
    <section class="sprint-sec sprint-guarantee"><p class="pass-eyebrow">${esc(t.guaranteeHeading)}</p><p>${esc(cfg.guarantee)}</p><p class="sprint-fine">${esc(t.guaranteeNote)}</p></section>
    <section class="sprint-sec sprint-faq"><h2>Questions owners ask</h2>${faq.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</section>
    ${buyBox()}
    <p class="sprint-more"><a href="${esc(room)}">${esc(t.backToRoom)}</a></p>`;
  return page(cfg.offerName, html, { sprintPage: { token: reg.token, preview: isPreview, copy: t, ...sprintState(rt, session, reg, now) }, ty: reg.token });
}

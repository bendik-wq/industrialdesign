import type { Context } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { render } from '../funnel/pages';
import { sameOriginWrite } from '../admin/auth';
import { getLead, linkVisitor } from '../funnel/leads';
import { formatCallTime } from '../integrations/email';
import { pickWebinarHeadline } from './headlines';
import { roomExtras, worksheetOpen } from './room';
import { liveRoomConfig } from './live';
import { BLUEPRINT_ROOM_COPY, blueprintUrl } from './blueprint';
import { ROOM_COPY, THANK_YOU, WORKSHEET } from './content';
import { FAQ_VIDEOS } from '../content/faq-videos';
import { FAQ_READY } from '../content/faq-videos-ready';
import { identityFromVisitor, track } from '../tracking/track';
import {
  type Registration, type Session, getRegistration, getSession, googleCalendarUrl, ics, jitSettings, nextJitStart, openSessions, phase, replayEndsAt, replayUrl, roomUrl, webinarBase, webinarSettings,
} from './webinar';
import { activePass, confirmOnReturn, dealMaths, dealReviewPack, formatMoney, markPackViewed, passConfig, passCopy, passGate, registeredPassBlock, roomPassConfig } from './pass';
import { bookingUrlFor } from '../funnel/routing';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The webinar lives on its own host (live.yourdomain.com) or, without one, under /webinar on the main domain. */
export function isWebinarHost(c: Context<AppEnv>) {
  const host = new URL(c.req.url).host;
  const configured = c.get('settings').WEBINAR_URL;
  if (configured) { try { return new URL(configured).host === host; } catch { /* fall through */ } }
  return host.startsWith('live.');
}

const when = (t: number, tz: string | null) => formatCallTime(t, tz);

/** "Starts in 12 minutes" (kept fresh by the page's script). */
const inMinutes = (t: number) => { const m = Math.max(1, Math.round((t - Date.now()) / 60_000)); return `Starts in ${m} minute${m === 1 ? '' : 's'}`; };

/** Registration options, in the visitor's own time zone; a just-in-time showing first when there is one. */
function sessionOptions(sessions: Session[], tz: string | null, jit: number | null = null) {
  const first = jit ? `<label class="opt opt-jit"><input type="radio" name="session_id" value="jit:${jit}" checked><span><strong data-starts-in="${jit}">${inMinutes(jit)}</strong> · next showing, ${esc(formatCallTime(jit, tz).replace(/^[A-Za-z]+,?\s*/, ''))}</span></label>` : '';
  return first + sessions.map((s, i) => {
    const soon = s.starts_at - Date.now() < 3_600_000;
    return `<label class="opt"><input type="radio" name="session_id" value="${esc(s.id)}"${i === 0 && !jit ? ' checked' : ''}><span>${esc(when(s.starts_at, tz))}${s.mode !== 'evergreen' ? ' · live' : ''}${soon ? ' · starting soon' : ''}</span></label>`;
  }).join('');
}

export async function webinarLanding(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const v = c.get('visitor');
  const w = webinarSettings(rt);
  const sessions = await openSessions(rt, 4);
  const jt = jitSettings(rt);
  const jit = nextJitStart(Date.now(), jt.every, v.geo.timezone ?? rt.settings.SALES_TIMEZONE ?? null, jt);
  const { headline: hl, preview } = await pickWebinarHeadline(rt, v.visitorId, c.req.query('h'));
  // Logged for the headline test (previews from Funnel HQ don't count).
  if (!preview && v.visitorId) await track(rt, identityFromVisitor(v, null, v.leadId ?? null), { name: 'webinar_headline_view', source: 'server', path: '/webinar', props: { h: hl.id }, localOnly: true });
  return render(c, '/webinar.html', {
    title: w.title,
    slots: { webinar_title: esc(w.title), duration: String(w.durationMin), hl_h1: hl.h1, hl_lede: esc(hl.lede) },
    blocks: { sessions: sessions.length || jit ? sessionOptions(sessions, v.geo.timezone, jit) : '<p class="muted">No sessions are scheduled right now. Check back soon.</p>' },
    show: { has_sessions: sessions.length > 0 || Boolean(jit) },
    config: { webinar: { register: '/api/webinar/register', base: webinarBase(rt), headline: hl.id } },
    seo: {
      title: `${w.title} | Masterclass with Josh Li`,
      description: 'A one-hour masterclass with Josh Li on buying a competitor without your own cash: commercial debt, seller finance and seller rollover, and the path to a signed LOI.',
      path: '/',
      origin: (() => { try { return rt.settings.WEBINAR_URL ? new URL(rt.settings.WEBINAR_URL).origin : undefined; } catch { return undefined; } })(),
      index: isWebinarHost(c),
    },
  });
}

/**
 * Funnel HQ → Page previews: a made-up sign-up so the thank-you page, the room and the replay can be seen
 * without registering. Admin only (hq_preview=1). ?hq_at=<minute> puts the showing at that minute
 * (negative = before it starts; "replay" = the replay). Nothing is saved: every write in the room looks the
 * token up first, and "preview" never matches a real registration.
 */
function previewLoad(c: Context<AppEnv>, rt: ReturnType<typeof runtimeFrom>) {
  const w = webinarSettings(rt);
  const now = Date.now();
  const at = c.req.query('hq_at') ?? '3';
  const startsAt = at === 'replay' ? now - (w.durationMin + 10) * 60_000 : now - (Number(at) || 0) * 60_000;
  const session: Session = { id: 'ws_preview', starts_at: startsAt, title: null, mode: 'evergreen', join_url: null, video_src: null, status: 'scheduled', auto: 2 };
  const reg: Registration = {
    id: 'wr_preview', token: 'preview', session_id: session.id, lead_id: 'l_preview', seq: 0, new_lead: 0, created_at: now - 3_600_000,
    joined_at: null, last_seen_at: null, watch_seconds: 0, max_position: 0, cta_at: null, replay_at: null, replay_seconds: 0, replay_until: null,
  };
  return { rt, reg, session };
}

async function load(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  if (c.req.param('token') === 'preview' && c.get('visitor')?.botReason === 'admin-preview') return previewLoad(c, rt);
  const reg = await getRegistration(rt, c.req.param('token') ?? '');
  const session = reg ? await getSession(rt, reg.session_id) : null;
  return { rt, reg, session };
}

const notFound = (c: Context<AppEnv>) => render(c, '/webinar-expired.html', { title: 'Link not found', slots: { expired_title: 'We couldn’t find that link', expired_body: 'Register below and we’ll email you a fresh one.' }, show: { rebook: false } });

export async function registeredPage(c: Context<AppEnv>) {
  const { rt, reg, session } = await load(c);
  if (!reg || !session) return notFound(c);
  const w = webinarSettings(rt);
  const lead = await getLead(c.env, reg.lead_id);
  const tz = c.get('visitor').geo.timezone ?? lead?.timezone ?? null;
  // Starting within 20 minutes (a just-in-time showing): send them straight to the room instead of the calendar.
  const soon = session.starts_at - Date.now() < 20 * 60_000;
  const clip = FAQ_VIDEOS.find((f) => f.id === 'faq-5-seller-buyout' && FAQ_READY.includes(f.id)) ?? FAQ_VIDEOS.find((f) => FAQ_READY.includes(f.id));
  const committed = await rt.env.DB.prepare("SELECT value FROM webinar_interactions WHERE reg_id = ? AND kind = 'commit'").bind(reg.id).first<{ value: string }>();
  // Deal Room Pass: the offer (upsell), the payment step (required), or the holder's perks.
  const pass = await registeredPassBlock(rt, reg, { pass: c.req.query('pass') ?? null });
  return render(c, '/webinar-registered.html', {
    title: pass.gate ? 'Confirm your seat' : 'You’re registered',
    slots: {
      webinar_title: esc(session.title || w.title), when: esc(when(session.starts_at, tz)),
      ty_eyebrow: esc(pass.gate ? passCopy(passConfig(rt.settings)).seatEyebrow : 'You’re registered'),
      ty_heading: esc(pass.gate ? `Almost there${lead?.first_name ? `, ${lead.first_name}` : ''}. Your seat is confirmed once it is paid.` : soon ? `You’re in${lead?.first_name ? `, ${lead.first_name}` : ''}. It starts in a few minutes.` : THANK_YOU.heading),
      ty_question: esc(THANK_YOU.question),
      preframe_q: clip ? esc(clip.q) : '',
    },
    blocks: {
      ty_paras: (soon ? THANK_YOU.paras.filter((p) => !/calendar/i.test(p)) : THANK_YOU.paras).map((p) => `<p>${esc(p)}</p>`).join(''),
      ty_options: THANK_YOU.options.map((o) => `<button type="button" class="btn-opt${committed?.value === o.value ? ' picked' : ''}" data-ty="${esc(o.value)}">${esc(o.label)}</button>`).join(''),
      preframe_video: clip ? `<video controls playsinline preload="none" poster="/assets/media/faq/${clip.id}.jpg" data-hls="/assets/media/faq/${clip.id}/index.m3u8"></video>` : '',
      pass_card: pass.html,
    },
    show: { soon: soon && !pass.gate, ask_phone: !lead?.phone, has_preframe: Boolean(clip), pass_gate: pass.gate, has_pass: Boolean(pass.html) },
    hrefs: { room: roomUrl(rt, reg.token), ics: `${webinarBase(rt)}/ics/${reg.token}`, google: googleCalendarUrl(rt, session, reg) },
    config: { webinar: { startsAt: session.starts_at, ty: reg.token, passConfirming: pass.confirming } },
  });
}

async function nextSessionsBlock(c: Context<AppEnv>, exclude?: string) {
  const rt = runtimeFrom(c);
  const sessions = (await openSessions(rt, 4)).filter((s) => s.id !== exclude && s.starts_at > Date.now());
  const jt = jitSettings(rt);
  const tz = c.get('visitor').geo.timezone ?? rt.settings.SALES_TIMEZONE ?? null;
  const jit = nextJitStart(Date.now(), jt.every, tz, jt);
  return sessions.length || jit ? sessionOptions(sessions, c.get('visitor').geo.timezone, jit) : '';
}

export async function roomPage(c: Context<AppEnv>, replay = false) {
  const { rt, reg, session } = await load(c);
  if (!reg || !session) return notFound(c);
  const w = webinarSettings(rt);
  // Deal Room Pass required and not paid yet: the payment step instead of the room.
  if (c.req.query('pass') === 'success') await confirmOnReturn(rt, reg); // back from Stripe: don't wait for the webhook
  if (await passGate(rt, reg)) return c.redirect(`${webinarBase(rt)}/registered/${reg.token}?pass=required`, 302);
  const p = phase(rt, session, Date.now(), reg.replay_until);
  if (!replay && (p === 'replay')) return c.redirect(replayUrl(rt, reg.token), 302);
  if (replay && (p === 'waiting' || p === 'running')) return c.redirect(roomUrl(rt, reg.token), 302);
  if (p === 'expired' || p === 'cancelled') {
    const opts = await nextSessionsBlock(c, session.id);
    return render(c, '/webinar-expired.html', {
      title: p === 'cancelled' ? 'Session moved' : 'Replay ended',
      slots: {
        expired_title: p === 'cancelled' ? 'This session was moved' : 'The replay has come down',
        expired_body: opts ? 'Pick another time and we’ll send you a new link.' : 'There are no sessions scheduled right now. Check back soon.',
      },
      blocks: { sessions: opts },
      show: { rebook: Boolean(opts) },
      config: { webinar: { token: reg.token, move: '/api/webinar/move' } },
    });
  }
  const lead = await getLead(c.env, reg.lead_id);
  const extras = await roomExtras(rt, reg);
  const pass = await roomPassConfig(rt, reg, extras.qualified);
  // "Book a strategy call instead": the closer's calendar inline in the room, name and email filled in.
  const bookingUrl = pass && !pass.active && lead ? bookingUrlFor(rt, lead.closer_id, lead.tier_override ?? lead.tier ?? null) : null;
  const booking = bookingUrl && lead ? { url: bookingUrl, provider: /calendly\.com/.test(bookingUrl) ? 'calendly' : 'iframe', prefill: { name: [lead.first_name, lead.last_name].filter(Boolean).join(' '), email: lead.email, leadId: lead.id, ref: lead.ref_code } } : null;
  return render(c, '/webinar-room.html', {
    title: session.title || w.title,
    slots: {
      webinar_title: esc(session.title || w.title),
      first_name_comma: lead?.first_name ? `, ${esc(lead.first_name)}` : '',
      when: esc(when(session.starts_at, c.get('visitor').geo.timezone ?? lead?.timezone ?? null)),
      room_label: replay ? 'Replay' : session.mode === 'evergreen' ? 'Masterclass' : 'Live session',
      pass_badge: pass?.active && pass.badge ? esc(pass.badge) : null,
    },
    show: { replay, live: session.mode === 'live' && !replay, pass_active: Boolean(pass?.active) },
    config: {
      webinar: {
        token: reg.token,
        replay,
        mode: session.mode,
        phase: p,
        startsAt: session.starts_at,
        serverNow: Date.now(),
        durationSec: w.durationMin * 60,
        pitchAtSec: w.pitchAtMin * 60,
        // Recording (in sync, or as the replay), or the live stream in our own room.
        video: replay ? (session.mode === 'evergreen' ? session.video_src : null) || w.videoSrc : session.mode === 'evergreen' ? session.video_src || w.videoSrc : session.mode === 'stream' ? session.video_src || w.streamHls || null : null,
        // The live join link is only handed out from 10 minutes before the start.
        joinUrl: session.mode === 'live' && !replay && Date.now() > session.starts_at - 10 * 60_000 ? session.join_url : null,
        applyUrl: `${rt.origin}/w/${reg.token}`,
        worksheetUrl: `${webinarBase(rt)}/worksheet/${reg.token}`,
        blueprintUrl: blueprintUrl(rt, reg.token),
        blueprintCopy: BLUEPRINT_ROOM_COPY,
        ...extras,
        copy: ROOM_COPY,
        replayUntil: replayEndsAt(rt, session, reg.replay_until),
        live: await liveRoomConfig(rt, reg, replay),
        pass,
        booking,
      },
    },
  });
}

/** The attendee-only Deal Structure Worksheet (printable). Opens once the masterclass reaches the worksheet minute. */
export async function worksheetPage(c: Context<AppEnv>) {
  const { rt, reg, session } = await load(c);
  if (!reg || !session) return notFound(c);
  const unlocked = worksheetOpen(rt, session, reg) || Boolean(await rt.env.DB.prepare("SELECT 1 FROM webinar_interactions WHERE reg_id = ? AND kind = 'bonus'").bind(reg.id).first());
  const body = unlocked
    ? `<header class="ws-head"><span class="eyebrow">Attendee worksheet</span><h1 class="h2">${esc(WORKSHEET.title)}</h1><p class="lede">${esc(WORKSHEET.intro)}</p></header>` +
      WORKSHEET.sections.map((s, i) => `<section class="ws-sec"><h2 class="h3">${/^\d/.test(s.heading) ? '' : `${i + 1}. `}${esc(s.heading)}</h2>${s.paras.map((p) => `<p>${esc(p)}</p>`).join('')}${s.rows?.length ? `<table class="ws-rows"><tbody>${s.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>` : ''}</section>`).join('') +
      `<p class="muted ws-disc">${esc(WORKSHEET.disclaimer)}</p><p class="no-print"><a class="btn" href="${esc(`${rt.origin}/w/${reg.token}`)}">Bring it to a strategy call: apply →</a></p>`
    : `<h1 class="h2">Your worksheet unlocks near the end of the masterclass</h1><p class="lede">Stay with the session and it appears in the room. <a href="${esc(roomUrl(rt, reg.token))}">Back to the masterclass</a></p>`;
  return render(c, '/webinar-worksheet.html', { title: WORKSHEET.title, blocks: { worksheet: body } });
}

/** Deal pack (offer buyers): their answers and their own numbers, worked through. */
/** The deal pack's form posts here; the numbers are logged like a calculator run, then back to the pack (a refresh can't resubmit). */
export async function packSubmit(c: Context<AppEnv>) {
  if (!sameOriginWrite(c)) return c.text('Forbidden', 403);
  const { rt, reg, session } = await load(c);
  if (!reg || !session) return notFound(c);
  if (!(await activePass(rt, reg.lead_id))) return c.redirect(c.req.path, 303);
  const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const profit = Number(form.profit), price = Number(form.price);
  if (profit > 0 && price > 0 && profit < 1e10 && price < 1e11) {
    const { logCalc } = await import('./room');
    await logCalc(rt, reg, { profit, price });
  }
  return c.redirect(c.req.path, 303);
}

type PackData = Awaited<ReturnType<typeof dealReviewPack>>;

/** Funnel HQ → Page previews: a made-up buyer with illustrative numbers. Nothing is read or saved. */
function samplePack(): PackData {
  return {
    name: 'Dana', band: '$3M–$10M', target: 'A competitor', numbers: { profit: 500_000, price: 1_500_000 },
    answers: [{ label: 'When you want it closed', value: '3 to 6 months' }, { label: 'Biggest blocker', value: 'Financing' }],
    maths: dealMaths(500_000, 1_500_000),
  };
}

export async function packPage(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  if (c.req.param('token') === 'preview' && c.get('visitor').botReason === 'admin-preview') {
    return packView(c, { pack: samplePack(), product: passConfig(rt.settings).offerName, preview: true, blueprint: '#', apply: '#', back: '#' });
  }
  const { reg, session } = await load(c);
  if (!reg || !session) return notFound(c);
  const back = `${webinarBase(rt)}/registered/${reg.token}`;
  const holder = await activePass(rt, reg.lead_id);
  if (!holder) {
    const cfg = passConfig(rt.settings);
    return render(c, '/webinar-worksheet.html', { title: 'Deal pack', blocks: { worksheet: `<h1 class="h2">Your deal pack comes with the ${esc(cfg.offerName)}</h1><p class="lede">${cfg.mode !== 'off' ? `<a href="${esc(back)}">See what it includes</a>.` : 'It isn’t available right now.'}</p>` } });
  }
  await markPackViewed(rt, reg.lead_id);
  const pack = await dealReviewPack(rt, reg);
  return packView(c, { pack, product: holder.product || passConfig(rt.settings).offerName, preview: false, blueprint: blueprintUrl(rt, reg.token), apply: `${rt.origin}/w/${reg.token}`, back });
}

function packView(c: Context<AppEnv>, o: { pack: PackData; product: string; preview: boolean; blueprint: string; apply: string; back: string }) {
  const { pack } = o;
  const m = (n: number) => formatMoney(Math.round(n), 'USD');
  const rows = (r: [string, string][]) => `<table class="ws-rows"><tbody>${r.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
  const x = pack.maths;
  const about: [string, string][] = [
    ...(pack.band ? [['Your revenue', pack.band] as [string, string]] : []),
    ...(pack.target ? [['The business you would most like to own', pack.target] as [string, string]] : []),
    ...pack.answers.map((a) => [a.label, a.value] as [string, string]),
  ];
  const n = (i: number) => String(about.length ? i + 1 : i);
  const off = o.preview ? ' disabled title="Preview: can’t submit"' : '';
  const form = `<form class="pack-form no-print" method="post"><label>Yearly profit of the target<input class="input" type="number" name="profit" min="1" step="1000" inputmode="numeric" value="${pack.numbers?.profit ?? ''}" required></label><label>Asking price<input class="input" type="number" name="price" min="1" step="1000" inputmode="numeric" value="${pack.numbers?.price ?? ''}" required></label><button class="btn btn-sm" type="submit"${off}>${pack.numbers ? 'Update my pack' : 'Build my pack'}</button></form>`;
  const body = `${o.preview ? '<p class="muted no-print">Preview with a made-up buyer and illustrative numbers. Real buyers see their own answers and numbers.</p>' : ''}<header class="ws-head"><span class="eyebrow"><span class="pass-badge">${esc(o.product)}</span></span><h1 class="h2">Deal pack${pack.name ? ` for ${esc(pack.name)}` : ''}</h1>
    <p class="lede">The structure from the masterclass, applied to the deal you have in mind. Change the numbers any time and the pack is rebuilt.</p></header>
    ${about.length ? `<section class="ws-sec"><h2 class="h3">1. Where you are starting from</h2>${rows(about)}</section>` : ''}
    <section class="ws-sec"><h2 class="h3">${n(1)}. The deal</h2>${form}
    ${x ? rows([['Yearly profit', m(x.profit)], ['Asking price', m(x.price)], ['Price ÷ profit', `${x.multiple.toFixed(1)}×`]]) : '<p>Enter the yearly profit and asking price of a business you would like to own: the numbers you ran in the room, or a target you have in mind.</p>'}</section>
    ${x ? `<section class="ws-sec"><h2 class="h3">${n(2)}. The funding stack (70 / 20 / 10)</h2>${rows([
      ['Commercial debt (70%)', `${m(x.base.debt)} · 9% over 10 years`], ['Seller finance (20%)', `${m(x.base.note)} · 6% over 5 years`], ['Seller rollover (10%)', `${m(x.base.rollover)} · the seller keeps this stake`],
      ['Yearly debt payments', m(x.base.service)], ['Debt service coverage', `${x.base.dscr.toFixed(2)}x`],
    ])}<p class="calc-verdict ${x.clears ? 'ok' : 'no'}"><b>${x.base.dscr.toFixed(2)}x</b> ${x.clears ? 'clears the 1.5x test at this price.' : 'falls short of the 1.5x test at this price.'}</p></section>
    <section class="ws-sec"><h2 class="h3">${n(3)}. What would change it</h2>${rows([
      ['Highest price that clears 1.5x on this stack', m(x.maxPrice)],
      ['Most bank debt this profit carries at 1.5x', `${m(x.maxDebt)} (9% over 10 years, before seller finance)`],
      ['Seller note over 7 years instead of 5', `${x.longerNote.dscr.toFixed(2)}x coverage · ${m(x.longerNote.service)} a year`],
      ['More rollover (60 / 20 / 20)', `${x.moreRollover.dscr.toFixed(2)}x coverage · ${m(x.moreRollover.service)} a year`],
    ])}<p>These are the levers a strategy call works through with you: the price, the length of the seller note, and how much the seller rolls over.</p></section>` : ''}
    <p class="muted ws-disc">Illustrative only. The rates and splits are assumptions for the example, not an offer of finance. Education, not legal, tax or financial advice.</p>
    <p class="no-print pack-actions"><a class="btn" href="${esc(o.blueprint)}">Open my full Acquisition Blueprint →</a> <a class="btn secondary" href="${esc(o.apply)}">Apply for a strategy call</a> <a class="btn secondary" href="${esc(o.back)}">Back to my confirmation</a></p>`;
  return render(c, '/webinar-worksheet.html', { title: 'Deal pack', blocks: { worksheet: body } });
}


export async function icsFile(c: Context<AppEnv>) {
  const { rt, reg, session } = await load(c);
  if (!reg || !session) return c.text('Not found', 404);
  return new Response(ics(rt, session, reg), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="webinar.ics"', 'cache-control': 'no-store' } });
}

/**
 * From the room's "See if you qualify" button to the application on the main domain. The token only
 * links this browser to the lead when the registration created the lead (an existing lead's token could
 * have been obtained by someone typing that person's email on the registration form).
 */
export async function applyHandoff(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const v = c.get('visitor');
  const reg: Registration | null = await getRegistration(rt, c.req.param('token') ?? '');
  if (reg && reg.new_lead && !v.leadId && !v.isBot) await linkVisitor(c.env, v.visitorId, reg.lead_id);
  return c.redirect('/apply?utm_source=webinar&utm_medium=webinar&utm_campaign=masterclass', 302);
}

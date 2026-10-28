import type { Context } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { render } from '../funnel/pages';
import { getLead, linkVisitor } from '../funnel/leads';
import { formatCallTime } from '../integrations/email';
import { pickWebinarHeadline } from './headlines';
import { roomExtras, worksheetOpen } from './room';
import { ROOM_COPY, THANK_YOU, WORKSHEET } from './content';
import { FAQ_VIDEOS } from '../content/faq-videos';
import { FAQ_READY } from '../content/faq-videos-ready';
import { identityFromVisitor, track } from '../tracking/track';
import {
  type Registration, type Session, getRegistration, getSession, googleCalendarUrl, ics, jitSettings, nextJitStart, openSessions, phase, replayUrl, roomUrl, webinarBase, webinarSettings,
} from './webinar';

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

async function load(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
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
  return render(c, '/webinar-registered.html', {
    title: 'You’re registered',
    slots: {
      webinar_title: esc(session.title || w.title), when: esc(when(session.starts_at, tz)),
      ty_heading: esc(soon ? `You’re in${lead?.first_name ? `, ${lead.first_name}` : ''}. It starts in a few minutes.` : THANK_YOU.heading),
      ty_question: esc(THANK_YOU.question),
      preframe_q: clip ? esc(clip.q) : '',
    },
    blocks: {
      ty_paras: (soon ? THANK_YOU.paras.filter((p) => !/calendar/i.test(p)) : THANK_YOU.paras).map((p) => `<p>${esc(p)}</p>`).join(''),
      ty_options: THANK_YOU.options.map((o) => `<button type="button" class="btn-opt${committed?.value === o.value ? ' picked' : ''}" data-ty="${esc(o.value)}">${esc(o.label)}</button>`).join(''),
      preframe_video: clip ? `<video controls playsinline preload="none" poster="/assets/media/faq/${clip.id}.jpg" data-hls="/assets/media/faq/${clip.id}/index.m3u8"></video>` : '',
    },
    show: { soon, ask_phone: !lead?.phone, has_preframe: Boolean(clip) },
    hrefs: { room: roomUrl(rt, reg.token), ics: `${webinarBase(rt)}/ics/${reg.token}`, google: googleCalendarUrl(rt, session, reg) },
    config: { webinar: { startsAt: session.starts_at, ty: reg.token } },
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
  const p = phase(rt, session);
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
  return render(c, '/webinar-room.html', {
    title: session.title || w.title,
    slots: {
      webinar_title: esc(session.title || w.title),
      first_name_comma: lead?.first_name ? `, ${esc(lead.first_name)}` : '',
      when: esc(when(session.starts_at, c.get('visitor').geo.timezone ?? lead?.timezone ?? null)),
      room_label: replay ? 'Replay' : session.mode === 'evergreen' ? 'Masterclass' : 'Live session',
    },
    show: { replay, live: session.mode === 'live' && !replay },
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
        ...(await roomExtras(rt, reg)),
        copy: ROOM_COPY,
        replayUntil: session.starts_at + w.durationMin * 60_000 + w.replayHours * 3_600_000,
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

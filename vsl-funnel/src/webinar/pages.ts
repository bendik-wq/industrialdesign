import type { Context } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { render } from '../funnel/pages';
import { getLead, linkVisitor } from '../funnel/leads';
import { formatCallTime } from '../integrations/email';
import { pickWebinarHeadline } from './headlines';
import { identityFromVisitor, track } from '../tracking/track';
import {
  type Registration, type Session, getRegistration, getSession, googleCalendarUrl, ics, openSessions, phase, replayUrl, roomUrl, webinarBase, webinarSettings,
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

/** Registration options, in the visitor's own time zone. */
function sessionOptions(sessions: Session[], tz: string | null) {
  return sessions.map((s, i) => {
    const soon = s.starts_at - Date.now() < 3_600_000;
    return `<label class="opt"><input type="radio" name="session_id" value="${esc(s.id)}"${i === 0 ? ' checked' : ''}><span>${esc(when(s.starts_at, tz))}${s.mode !== 'evergreen' ? ' · live' : ''}${soon ? ' · starting soon' : ''}</span></label>`;
  }).join('');
}

export async function webinarLanding(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const v = c.get('visitor');
  const w = webinarSettings(rt);
  const sessions = await openSessions(rt, 4);
  const { headline: hl, preview } = await pickWebinarHeadline(rt, v.visitorId, c.req.query('h'));
  // Logged for the headline test (previews from Funnel HQ don't count).
  if (!preview && v.visitorId) await track(rt, identityFromVisitor(v, null, v.leadId ?? null), { name: 'webinar_headline_view', source: 'server', path: '/webinar', props: { h: hl.id }, localOnly: true });
  return render(c, '/webinar.html', {
    title: w.title,
    slots: { webinar_title: esc(w.title), duration: String(w.durationMin), hl_h1: hl.h1, hl_lede: esc(hl.lede) },
    blocks: { sessions: sessions.length ? sessionOptions(sessions, v.geo.timezone) : '<p class="muted">No sessions are scheduled right now. Check back soon.</p>' },
    show: { has_sessions: sessions.length > 0 },
    config: { webinar: { register: '/api/webinar/register', base: webinarBase(rt), headline: hl.id } },
    seo: {
      title: `${w.title} | Masterclass with Josh Li`,
      description: 'A live masterclass with Josh Li on buying a business with no money down: commercial debt, seller finance and seller rollover, and getting to a signed LOI.',
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
  return render(c, '/webinar-registered.html', {
    title: 'You’re registered',
    slots: { webinar_title: esc(session.title || w.title), when: esc(when(session.starts_at, tz)), first_name_comma: lead?.first_name ? `, ${esc(lead.first_name)}` : '' },
    hrefs: { room: roomUrl(rt, reg.token), ics: `${webinarBase(rt)}/ics/${reg.token}`, google: googleCalendarUrl(rt, session, reg) },
    config: { webinar: { startsAt: session.starts_at } },
  });
}

async function nextSessionsBlock(c: Context<AppEnv>, exclude?: string) {
  const rt = runtimeFrom(c);
  const sessions = (await openSessions(rt, 4)).filter((s) => s.id !== exclude && s.starts_at > Date.now());
  return sessions.length ? sessionOptions(sessions, c.get('visitor').geo.timezone) : '';
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
        replayUntil: session.starts_at + w.durationMin * 60_000 + w.replayHours * 3_600_000,
      },
    },
  });
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

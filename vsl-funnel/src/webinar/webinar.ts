import type { Runtime } from '../app';
import { VIDEOS } from '../config';
import { newId } from '../lib/ids';
import type { VisitorCtx } from '../lib/identity';
import { zonedTime, cancelSequence, enqueuePrewebinar, enqueueSequence } from '../integrations/email';
import { type Lead, cleanName, getLead, getLeadByEmail, linkVisitor, normalisePhone, updateLead, validateEmail } from '../funnel/leads';
import { startSms } from '../integrations/sms';
import { ApplicationError, attributionFor, verifyTurnstile } from '../funnel/application';
import { identityFromLead, identityFromVisitor, track } from '../tracking/track';
import { newRefCode } from '../lib/ids';

/**
 * Webinar: weekly scheduled sessions (plus one-offs added in Funnel HQ), each either
 *  - "evergreen": our own room plays the recording in sync with the clock (everyone is at the same point), or
 *  - "live": a real live session on Zoom / YouTube / StreamYard; the room counts people down and sends them to join_url.
 * Registrants become leads (attributed like any other), get reminders + follow-up anchored to their session,
 * and their attendance (joined, minutes watched, offer clicked, replay) is tracked.
 */

export const WEBINAR_CYCLE = 12; // email steps per registration block (see SEQUENCES.webinar)

export interface Session {
  id: string;
  starts_at: number;
  title: string | null;
  /** evergreen: recording played in sync · stream: live in our own room (Cloudflare Stream HLS) · live: external link (Zoom…) */
  mode: 'evergreen' | 'stream' | 'live';
  join_url: string | null;
  video_src: string | null;
  status: 'scheduled' | 'cancelled';
  auto: number;
}

export interface Registration {
  id: string;
  token: string;
  session_id: string;
  lead_id: string;
  seq: number;
  new_lead: number;
  created_at: number;
  joined_at: number | null;
  last_seen_at: number | null;
  watch_seconds: number;
  max_position: number;
  cta_at: number | null;
  replay_at: number | null;
  replay_seconds: number;
}

export function webinarSettings(rt: Runtime) {
  const s = rt.settings;
  const num = (v: string, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    title: s.WEBINAR_TITLE || 'The No-Money-Down Acquisition Masterclass',
    schedule: s.WEBINAR_SCHEDULE || 'Tue 19:00, Thu 12:00',
    tz: s.SALES_TIMEZONE || 'Australia/Sydney',
    durationMin: num(s.WEBINAR_DURATION_MIN, 60),
    pitchAtMin: num(s.WEBINAR_PITCH_AT, 45),
    replayHours: num(s.WEBINAR_REPLAY_HOURS, 48),
    videoSrc: s.WEBINAR_VIDEO_SRC || s.VSL_MAIN_SRC || VIDEOS.main.defaultSrc || '',
    placeholderVideo: !s.WEBINAR_VIDEO_SRC,
    streamHls: s.WEBINAR_STREAM_HLS || '',
  };
}

/** Public base URL of the webinar pages (live.yourdomain.com, or /webinar on the main domain). */
export function webinarBase(rt: Runtime) {
  return (rt.settings.WEBINAR_URL || '').replace(/\/+$/, '') || `${rt.origin}/webinar`;
}
export const roomUrl = (rt: Runtime, token: string) => `${webinarBase(rt)}/room/${token}`;
export const replayUrl = (rt: Runtime, token: string) => `${webinarBase(rt)}/replay/${token}`;

// ───────────── schedule ─────────────

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "Tue 19:00, Thu 12:00" → [{dow:2,h:19,m:0}, …]. Bad parts are ignored. */
export function parseSchedule(spec: string) {
  return spec.split(/[,;\n]+/).flatMap((part) => {
    const m = /^\s*([a-z]{3})[a-z]*\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(part);
    if (!m) return [];
    const dow = DAYS.indexOf(m[1].toLowerCase());
    let h = Number(m[2]);
    const min = Number(m[3] ?? 0);
    if (m[4]) h = (h % 12) + (m[4].toLowerCase() === 'pm' ? 12 : 0);
    return dow >= 0 && h < 24 && min < 60 ? [{ dow, h, m: min }] : [];
  });
}

/** Session start times in the next `days` days for a weekly schedule in a time zone. */
export function scheduleTimes(spec: string, tz: string, now: number, days = 14) {
  const slots = parseSchedule(spec);
  const out: number[] = [];
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(now);
  const g = (k: string) => parts.find((p) => p.type === k)!.value;
  const y = Number(g('year')), mo = Number(g('month')), d = Number(g('day'));
  const todayDow = DAYS.indexOf(g('weekday').toLowerCase().slice(0, 3));
  for (let i = 0; i <= days; i++) {
    const date = new Date(Date.UTC(y, mo - 1, d + i));
    const dow = (todayDow + i) % 7;
    for (const s of slots) if (s.dow === dow) {
      const t = zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), s.h + s.m / 60, tz);
      if (t > now) out.push(t);
    }
  }
  return out.sort((a, b) => a - b);
}

/** Cron (hourly): make sure the weekly sessions for the next two weeks exist. */
export async function ensureSessions(rt: Runtime, force = false) {
  const db = rt.env.DB;
  if (!force) {
    const last = await db.prepare("SELECT value FROM kv_state WHERE key = 'webinar:ensure'").first<{ value: string }>();
    if (last && Date.now() - Number(last.value) < 3_600_000) return 0;
  }
  await db.prepare("INSERT INTO kv_state (key, value) VALUES ('webinar:ensure', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(Date.now())).run();
  const w = webinarSettings(rt);
  const times = scheduleTimes(w.schedule, w.tz, Date.now(), 14);
  if (!times.length) return 0;
  const now = Date.now();
  const res = await db.batch(times.map((t) => db.prepare(
    "INSERT OR IGNORE INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES (?, ?, 'evergreen', 'scheduled', 1, ?)",
  ).bind(newId('ws'), t, now)));
  return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** Sessions people can still register for (including one that started in the last 10 minutes). */
export async function openSessions(rt: Runtime, limit = 4) {
  const { results } = await rt.env.DB.prepare(
    "SELECT * FROM webinar_sessions WHERE status = 'scheduled' AND starts_at > ? ORDER BY starts_at LIMIT ?",
  ).bind(Date.now() - 10 * 60_000, limit).all<Session>();
  return results;
}

export const getSession = (rt: Runtime, id: string) => rt.env.DB.prepare('SELECT * FROM webinar_sessions WHERE id = ?').bind(id).first<Session>();
export const getRegistration = (rt: Runtime, token: string) =>
  /^[a-z0-9]{16,40}$/.test(token) ? rt.env.DB.prepare('SELECT * FROM webinar_registrations WHERE token = ?').bind(token).first<Registration>() : Promise.resolve(null);

/** Where a session is right now. */
export function phase(rt: Runtime, session: Session, now = Date.now()) {
  const w = webinarSettings(rt);
  const end = session.starts_at + w.durationMin * 60_000;
  if (session.status === 'cancelled') return 'cancelled' as const;
  if (now < session.starts_at) return 'waiting' as const;
  if (now < end) return 'running' as const;
  if (now < end + w.replayHours * 3_600_000) return 'replay' as const;
  return 'expired' as const;
}

// ───────────── registration ─────────────

const token = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);

/**
 * Registers someone for a session. An email that already has a lead is attached to that lead without
 * changing any of its details (anyone can type anyone's address); only a registration that created the
 * lead may link this browser to it.
 */
export async function register(rt: Runtime, v: VisitorCtx, body: Record<string, unknown>) {
  const firstName = cleanName(body.first_name);
  const emailCheck = validateEmail(body.email);
  if (!firstName) throw new ApplicationError('Please enter your first name', 'first_name');
  if (!emailCheck) throw new ApplicationError('Please enter a valid email address', 'email');
  if (emailCheck.disposable) throw new ApplicationError('Please use your real email address — the link to the session goes there', 'email');
  if (!(await verifyTurnstile(rt, body.turnstile, v.ip))) throw new ApplicationError('Security check failed — please refresh and try again', undefined, 403);

  // Abuse limit: a handful of sign-ups per IP per hour (each one sends email).
  const ipKey = `wreg:${v.ip ?? 'unknown'}`;
  const row = await rt.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(ipKey).first<{ value: string }>();
  const rate = (() => { try { const r = JSON.parse(row?.value ?? '{}') as { n?: number; t?: number }; return r.t && Date.now() - r.t < 3_600_000 ? { n: r.n ?? 0, t: r.t } : { n: 0, t: Date.now() }; } catch { return { n: 0, t: Date.now() }; } })();
  if (rate.n >= 8) throw new ApplicationError('Too many sign-ups from this connection. Please try again in an hour.', undefined, 429);

  // Optional mobile for text reminders (only with the unticked "text me" box ticked).
  const wantsTexts = body.sms_consent === true || body.sms_consent === 'true' || body.sms_consent === 'on';
  const phone = typeof body.phone === 'string' && body.phone.trim() ? normalisePhone(body.phone, v.geo.country) : null;
  if (typeof body.phone === 'string' && body.phone.trim() && !phone) throw new ApplicationError('Please enter a valid mobile number, including area code — or leave it blank', 'phone');
  const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
  const session = sessionId ? await getSession(rt, sessionId) : (await openSessions(rt, 1))[0] ?? null;
  if (!session || session.status !== 'scheduled' || session.starts_at < Date.now() - 10 * 60_000) throw new ApplicationError('That session is no longer available — please pick another time', 'session_id', 409);

  const now = Date.now();
  let lead = await getLeadByEmail(rt.env, emailCheck.email);
  let newLead = false;
  if (!lead) {
    const { last, first } = await attributionFor(rt, v);
    const id = newId('l');
    await rt.env.DB.prepare(
      `INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, session_id, first_name, email, phone, sms_consent_at, wa_consent_at, whatsapp_opt_in, step_reached, status,
         channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term, click_id, click_type, ft_channel, ft_source, ft_campaign, ft_content,
         landing_path, variant, country, city, device, fbp, fbc, timezone)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,'partial',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, newRefCode(), now, now, v.visitorId, v.sessionId, firstName, emailCheck.email, phone, phone && wantsTexts ? now : null, phone && wantsTexts ? now : null,
      last?.channel ?? 'Direct', last?.utm_source ?? null, last?.utm_medium ?? null, last?.utm_campaign ?? null, last?.utm_content ?? null, last?.utm_term ?? null,
      last?.click_id ?? null, last?.click_type ?? null, first?.ft_channel ?? null, first?.ft_source ?? null, first?.ft_campaign ?? null, first?.ft_content ?? null,
      last?.landing_path ?? '/webinar', v.variant, v.geo.country, v.geo.city, v.ua.device, v.fbp, v.fbc, v.geo.timezone,
    ).run();
    lead = (await getLead(rt.env, id))!;
    newLead = true;
    await linkVisitor(rt.env, v.visitorId, lead.id);
  }

  // Same person, same session: hand back the same link (no duplicate emails), but only to the browser
  // already linked to that lead. Anyone else typing that email must not get the link: it's a bearer token
  // to the registration, and for a lead the sign-up created it would link their browser to the lead.
  const existing = await rt.env.DB.prepare('SELECT * FROM webinar_registrations WHERE lead_id = ? AND session_id = ?').bind(lead.id, session.id).first<Registration>();
  if (existing) {
    if (v.leadId === lead.id) return { registration: existing, session, lead, created: false };
    throw new ApplicationError('You’re already registered for this session. Your link is in the confirmation email we sent you (check spam too).', 'email', 409);
  }

  await rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(ipKey, JSON.stringify({ n: rate.n + 1, t: rate.t })).run();
  const prior = await rt.env.DB.prepare('SELECT COUNT(*) AS n FROM webinar_registrations WHERE lead_id = ?').bind(lead.id).first<{ n: number }>();
  const reg: Registration = {
    id: newId('wr'), token: token(), session_id: session.id, lead_id: lead.id, seq: prior?.n ?? 0, new_lead: newLead ? 1 : 0, created_at: now,
    joined_at: null, last_seen_at: null, watch_seconds: 0, max_position: 0, cta_at: null, replay_at: null, replay_seconds: 0,
  };
  await rt.env.DB.prepare('INSERT INTO webinar_registrations (id, token, session_id, lead_id, seq, new_lead, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(reg.id, reg.token, reg.session_id, reg.lead_id, reg.seq, reg.new_lead, now).run();
  await scheduleEmails(rt, lead, session, reg);
  await startSms(rt, (await getLead(rt.env, lead.id))!, 'webinar');

  const who = newLead ? identityFromVisitor(v, null, lead.id) : await identityFromLead(rt.env, lead.id);
  await track(rt, who, { name: 'webinar_registered', source: 'server', path: '/webinar', props: { session_id: session.id, starts_at: session.starts_at, mode: session.mode }, eventId: typeof body.event_id === 'string' ? body.event_id : undefined });
  return { registration: reg, session, lead: (await getLead(rt.env, lead.id))!, created: true };
}

/** Points the lead's webinar fields at this session and (re)schedules its block of emails. */
async function scheduleEmails(rt: Runtime, lead: Lead, session: Session, reg: Registration) {
  await updateLead(rt.env, lead.id, { webinar_at: session.starts_at, webinar_registered_at: Date.now(), webinar_token: reg.token });
  await cancelSequence(rt, lead.id, 'webinar'); // an earlier session's reminders
  const fresh = (await getLead(rt.env, lead.id))!;
  await enqueueSequence(rt, fresh, 'webinar', { stepBase: reg.seq * WEBINAR_CYCLE });
  await enqueuePrewebinar(rt, fresh, reg.seq);
}

/** Moves someone to another session (from the "pick another time" link). */
export async function moveRegistration(rt: Runtime, reg: Registration, sessionId: string) {
  const session = await getSession(rt, sessionId);
  if (!session || session.status !== 'scheduled' || session.starts_at < Date.now()) throw new ApplicationError('That session is no longer available', 'session_id', 409);
  const lead = await getLead(rt.env, reg.lead_id);
  if (!lead) throw new ApplicationError('Registration not found', undefined, 404);
  const prior = await rt.env.DB.prepare('SELECT COUNT(*) AS n FROM webinar_registrations WHERE lead_id = ?').bind(lead.id).first<{ n: number }>();
  const next: Registration = { ...reg, id: newId('wr'), token: token(), session_id: session.id, seq: prior?.n ?? 0, created_at: Date.now(), joined_at: null, last_seen_at: null, watch_seconds: 0, max_position: 0, cta_at: null, replay_at: null, replay_seconds: 0 };
  await rt.env.DB.prepare('INSERT OR IGNORE INTO webinar_registrations (id, token, session_id, lead_id, seq, new_lead, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(next.id, next.token, next.session_id, next.lead_id, next.seq, reg.new_lead, next.created_at).run();
  const saved = await rt.env.DB.prepare('SELECT * FROM webinar_registrations WHERE lead_id = ? AND session_id = ?').bind(lead.id, session.id).first<Registration>();
  if (saved && saved.id === next.id) { await scheduleEmails(rt, lead, session, next); await startSms(rt, (await getLead(rt.env, lead.id))!, 'webinar'); }
  await track(rt, await identityFromLead(rt.env, lead.id), { name: 'webinar_rebooked', source: 'server', props: { session_id: session.id } });
  return { registration: saved ?? next, session };
}

/** Cancelling a session moves everyone on it to the next one (they get a fresh confirmation). */
export async function cancelSession(rt: Runtime, sessionId: string) {
  await rt.env.DB.prepare("UPDATE webinar_sessions SET status = 'cancelled' WHERE id = ?").bind(sessionId).run();
  const next = (await openSessions(rt, 5)).find((s) => s.id !== sessionId && s.starts_at > Date.now() + 30 * 60_000);
  const { results } = await rt.env.DB.prepare('SELECT * FROM webinar_registrations WHERE session_id = ?').bind(sessionId).all<Registration>();
  let moved = 0;
  if (next) for (const r of results) { await moveRegistration(rt, r, next.id).catch(() => null); moved++; }
  return { moved, next: next?.id ?? null };
}

// ───────────── attendance ─────────────

/** Heartbeat from the room / replay player (every ~15 s). Positions are seconds into the recording. */
export async function heartbeat(rt: Runtime, reg: Registration, session: Session, body: { pos?: unknown; replay?: unknown }) {
  const w = webinarSettings(rt);
  const now = Date.now();
  const p = phase(rt, session, now);
  const replay = body.replay === true;
  if (replay ? !['running', 'replay'].includes(p) : p !== 'running') return { ok: false, phase: p };
  const pos = Math.max(0, Math.min(w.durationMin * 60, Math.round(Number(body.pos) || 0)));
  // Credit at most the time since the last beat (no inflating watch time by spamming beats).
  const since = reg.last_seen_at ? Math.min(20, Math.max(0, Math.round((now - reg.last_seen_at) / 1000))) : 15;
  if (replay) {
    await rt.env.DB.prepare('UPDATE webinar_registrations SET replay_at = COALESCE(replay_at, ?), replay_seconds = replay_seconds + ?, max_position = MAX(max_position, ?), last_seen_at = ? WHERE id = ?')
      .bind(now, since, pos, now, reg.id).run();
  } else {
    await rt.env.DB.prepare('UPDATE webinar_registrations SET joined_at = COALESCE(joined_at, ?), watch_seconds = watch_seconds + ?, max_position = MAX(max_position, ?), last_seen_at = ? WHERE id = ?')
      .bind(now, since, pos, now, reg.id).run();
  }
  const fresh = (await rt.env.DB.prepare('SELECT * FROM webinar_registrations WHERE id = ?').bind(reg.id).first<Registration>())!;
  const pct = Math.min(1, fresh.max_position / (w.durationMin * 60));
  const lead = await getLead(rt.env, reg.lead_id);
  if (lead) {
    await updateLead(rt.env, lead.id, {
      ...(replay ? { webinar_replay_at: lead.webinar_replay_at ?? now } : { webinar_attended_at: now }),
      webinar_watch_pct: Math.max(lead.webinar_watch_pct ?? 0, Math.round(pct * 100) / 100),
    });
    if (!replay && !reg.joined_at) await track(rt, await identityFromLead(rt.env, lead.id), { name: 'webinar_joined', source: 'server', props: { session_id: session.id, mode: session.mode } });
    if (replay && !reg.replay_at) await track(rt, await identityFromLead(rt.env, lead.id), { name: 'webinar_replay', source: 'server', props: { session_id: session.id } });
  }
  return { ok: true, phase: p, pct };
}

/** "Join the live session" click (live mode: we can only see the click, not the minutes). */
export async function markJoinedLive(rt: Runtime, reg: Registration, session: Session) {
  const now = Date.now();
  await rt.env.DB.prepare('UPDATE webinar_registrations SET joined_at = COALESCE(joined_at, ?), last_seen_at = ? WHERE id = ?').bind(now, now, reg.id).run();
  await updateLead(rt.env, reg.lead_id, { webinar_attended_at: now });
  if (!reg.joined_at) await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_joined', source: 'server', props: { session_id: session.id, mode: 'live' } });
}

export async function markCta(rt: Runtime, reg: Registration) {
  const now = Date.now();
  await rt.env.DB.prepare('UPDATE webinar_registrations SET cta_at = COALESCE(cta_at, ?) WHERE id = ?').bind(now, reg.id).run();
  await updateLead(rt.env, reg.lead_id, { webinar_cta_at: now });
  if (!reg.cta_at) await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_cta_click', source: 'server', props: { session_id: reg.session_id } });
}

/** iCalendar file for "add to calendar". */
export function ics(rt: Runtime, session: Session, reg: Registration) {
  const w = webinarSettings(rt);
  const fmt = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escText = (s: string) => s.replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
  const url = roomUrl(rt, reg.token);
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Funnel//Webinar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${reg.id}@webinar`, `DTSTAMP:${fmt(Date.now())}`, `DTSTART:${fmt(session.starts_at)}`, `DTEND:${fmt(session.starts_at + w.durationMin * 60_000)}`,
    `SUMMARY:${escText(session.title || w.title)}`, `DESCRIPTION:${escText(`Your link: ${url}`)}`, `URL:${url}`, `LOCATION:${escText(url)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Starting in 15 minutes', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

export function googleCalendarUrl(rt: Runtime, session: Session, reg: Registration) {
  const w = webinarSettings(rt);
  const fmt = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', session.title || w.title);
  u.searchParams.set('dates', `${fmt(session.starts_at)}/${fmt(session.starts_at + w.durationMin * 60_000)}`);
  u.searchParams.set('details', `Your link: ${roomUrl(rt, reg.token)}`);
  return u.toString();
}

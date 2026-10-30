import type { Runtime } from '../app';
import { edition } from './editions';
import { VIDEOS } from '../config';
import { newId } from '../lib/ids';
import type { VisitorCtx } from '../lib/identity';
import { zonedTime, cancelSequence, enqueuePrewebinar, enqueueSequence } from '../integrations/email';
import { type Lead, cleanName, getLead, getLeadByEmail, linkVisitor, normalisePhone, updateLead, validateEmail } from '../funnel/leads';
import { startSms, stopSms } from '../integrations/sms';
import { ApplicationError, attributionFor, verifyTurnstile } from '../funnel/application';
import { identityFromLead, identityFromVisitor, track } from '../tracking/track';
import { newRefCode } from '../lib/ids';
import { APP_REVENUE_BAND, isMillionPlus } from '../sales/qualify';
import { trackRevenueEvents } from '../tracking/revenue-events';
import { WEBINAR_HEADLINES } from './headlines';

/** Under $1M (and said so): still welcome to watch, but no daily emails, texts or calls. */
export const underMillion = (band: string | null | undefined) => Boolean(band) && !isMillionPlus(band ?? null);

/**
 * Webinar: weekly scheduled sessions (plus one-offs added in Funnel HQ), each either
 *  - "evergreen": our own room plays the recording in sync with the clock (everyone is at the same point), or
 *  - "live": a real live session on Zoom / YouTube / StreamYard; the room counts people down and sends them to join_url.
 * Registrants become leads (attributed like any other), get reminders + follow-up anchored to their session,
 * and their attendance (joined, minutes watched, offer clicked, replay) is tracked.
 */

export const WEBINAR_CYCLE = 30; // email steps per registration block (see SEQUENCES.webinar); was 20 before the Sprint closing emails, and 30n never meets an older 20n block

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
  /** Per-registration replay end (Deal Room Pass holders); null = the global replay hours. */
  replay_until?: number | null;
  /** Registered while the Deal Room Pass was required. */
  pass_required?: number | null;
}

export function webinarSettings(rt: Runtime) {
  const s = rt.settings;
  const num = (v: string, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    title: s.WEBINAR_TITLE || 'The Acquisition Masterclass',
    schedule: s.WEBINAR_SCHEDULE || 'Tue 19:00, Thu 12:00',
    tz: s.SALES_TIMEZONE || 'Australia/Sydney',
    durationMin: num(s.WEBINAR_DURATION_MIN, edition(s).durationMin),
    pitchAtMin: num(s.WEBINAR_PITCH_AT, edition(s).pitchAtMin),
    replayHours: num(s.WEBINAR_REPLAY_HOURS, 48),
    videoSrc: s.WEBINAR_VIDEO_SRC || edition(s).videoSrc || s.VSL_MAIN_SRC || VIDEOS.main.defaultSrc || '',
    placeholderVideo: !s.WEBINAR_VIDEO_SRC && !edition(s).videoSrc,
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

// ───────────── just-in-time showings ─────────────

/** How often a just-in-time showing starts (minutes; 0 = off) and the viewer's local hours it runs in. */
export function jitSettings(rt: Runtime) {
  const every = Number((rt.settings.WEBINAR_JIT_EVERY ?? '').trim() || 15);
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec((rt.settings.WEBINAR_JIT_HOURS ?? '').trim() || '7-22');
  return { every: Number.isFinite(every) && every >= 5 && every <= 120 ? Math.round(every) : every === 0 ? 0 : 15, from: m ? Number(m[1]) : 7, to: m ? Number(m[2]) : 22 };
}

/** Local hour (0–23) of a moment in a time zone. */
function localHour(t: number, tz: string) {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(t)); } catch { return new Date(t).getUTCHours(); }
}

/**
 * The next just-in-time showing: the next slot on the `every`-minute grid at least 4 minutes away
 * (so they can open the room), inside the viewer's waking hours. Null when off or outside hours.
 */
export function nextJitStart(now: number, every: number, tz: string | null, hours: { from: number; to: number }) {
  if (!every) return null;
  const step = every * 60_000;
  const t = Math.ceil((now + 4 * 60_000) / step) * step;
  const h = localHour(t, tz || 'UTC');
  return h >= hours.from && h < hours.to ? t : null;
}

/** A just-in-time choice from the form ("jit:<ms>") becomes a real session (or reuses one at that minute). */
export async function jitSession(rt: Runtime, raw: string) {
  const t = Number(raw.slice(4));
  const { every } = jitSettings(rt);
  if (!every || !Number.isFinite(t) || t % (every * 60_000) !== 0) return null;
  const now = Date.now();
  if (t < now - 5 * 60_000 || t > now + (every + 10) * 60_000) return null;
  await rt.env.DB.prepare("INSERT OR IGNORE INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES (?, ?, 'evergreen', 'scheduled', 2, ?)").bind(newId('ws'), t, now).run();
  return rt.env.DB.prepare('SELECT * FROM webinar_sessions WHERE starts_at = ?').bind(t).first<Session>();
}

/** Sessions people can still register for (including one that started in the last 10 minutes). */
export async function openSessions(rt: Runtime, limit = 4) {
  const { results } = await rt.env.DB.prepare(
    "SELECT * FROM webinar_sessions WHERE status = 'scheduled' AND auto != 2 AND starts_at > ? ORDER BY starts_at LIMIT ?",
  ).bind(Date.now() - 10 * 60_000, limit).all<Session>();
  return results;
}

export const getSession = (rt: Runtime, id: string) => rt.env.DB.prepare('SELECT * FROM webinar_sessions WHERE id = ?').bind(id).first<Session>();
export const getRegistration = (rt: Runtime, token: string) =>
  /^[a-z0-9]{16,40}$/.test(token) ? rt.env.DB.prepare('SELECT * FROM webinar_registrations WHERE token = ?').bind(token).first<Registration>() : Promise.resolve(null);

/** When the replay comes down: the global replay hours, or later for a registration with its own window (Deal Room Pass). */
export function replayEndsAt(rt: Runtime, session: Session, replayUntil?: number | null) {
  const w = webinarSettings(rt);
  const normal = session.starts_at + w.durationMin * 60_000 + w.replayHours * 3_600_000;
  return replayUntil && replayUntil > normal ? replayUntil : normal;
}

/** Where a session is right now (pass the registration's replay_until for its own replay window). */
export function phase(rt: Runtime, session: Session, now = Date.now(), replayUntil?: number | null) {
  const w = webinarSettings(rt);
  const end = session.starts_at + w.durationMin * 60_000;
  if (session.status === 'cancelled') return 'cancelled' as const;
  if (now < session.starts_at) return 'waiting' as const;
  if (now < end) return 'running' as const;
  if (now < replayEndsAt(rt, session, replayUntil)) return 'replay' as const;
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
  const band = APP_REVENUE_BAND[String(body.revenue ?? '')] ?? null;
  if (!band) throw new ApplicationError('Please pick your business’s annual revenue', 'revenue');
  const headline = WEBINAR_HEADLINES.some((h) => h.id === body.headline) ? String(body.headline) : null;
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
  const session = sessionId.startsWith('jit:') ? await jitSession(rt, sessionId) : sessionId ? await getSession(rt, sessionId) : (await openSessions(rt, 1))[0] ?? null;
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
  // Paid ticket (required mode with a seat price): marked before anything is scheduled, so the emails and texts wait for payment.
  const passRequired = (await import('./pass')).seatRequired(rt) ? 1 : 0;
  const reg: Registration = {
    id: newId('wr'), token: token(), session_id: session.id, lead_id: lead.id, seq: prior?.n ?? 0, new_lead: newLead ? 1 : 0, created_at: now,
    joined_at: null, last_seen_at: null, watch_seconds: 0, max_position: 0, cta_at: null, replay_at: null, replay_seconds: 0, pass_required: passRequired,
  };
  await rt.env.DB.prepare('INSERT INTO webinar_registrations (id, token, session_id, lead_id, seq, new_lead, created_at, revenue_band, headline, pass_required) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(reg.id, reg.token, reg.session_id, reg.lead_id, reg.seq, reg.new_lead, now, band, headline, passRequired).run();
  // Their own answer here wins over nothing; an application answer already on file is kept.
  const bandIsNew = !lead.revenue_band;
  if (bandIsNew) await updateLead(rt.env, lead.id, { revenue_band: band });
  lead = (await getLead(rt.env, lead.id))!;
  const ticketed = await scheduleEmails(rt, lead, session, reg);
  if (ticketed && !underMillion(lead.revenue_band)) await startSms(rt, lead, 'webinar');

  const who = newLead ? identityFromVisitor(v, null, lead.id) : await identityFromLead(rt.env, lead.id);
  await track(rt, who, { name: 'webinar_registered', source: 'server', path: '/webinar', props: { session_id: session.id, starts_at: session.starts_at, mode: session.mode, band, headline }, eventId: typeof body.event_id === 'string' ? body.event_id : undefined });
  // Revenue events once per person (an application may already have sent them); "$1M+ webinar" on their first registration.
  if (bandIsNew) await trackRevenueEvents(rt, who, band, 'webinar', '/webinar');
  // Big fish: tell the team straight away so someone can reach out before the session.
  if (['10m-25m', '25m-50m', '50m-100m', '100m+'].includes(band)) {
    const { notifySlack } = await import('../integrations/notify');
    rt.waitUntil(notifySlack(rt, lead, '💎 $10M+ owner registered for the masterclass', [`Session: ${new Date(session.starts_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`], 'hot_lead'));
  }
  else if (reg.seq === 0 && isMillionPlus(lead.revenue_band)) await track(rt, who, { name: 'qualified_1m_plus', source: 'server', path: '/webinar', props: { band: lead.revenue_band, funnel: 'webinar' } });
  return { registration: reg, session, lead: (await getLead(rt.env, lead.id))!, created: true };
}

export const TICKET_CYCLE = 10; // "finish your ticket" steps per registration block (see SEQUENCES.ticket)

/**
 * Points the lead's webinar fields at this session and (re)schedules its block of emails. While a required
 * ticket is unpaid, only the short "finish your ticket" run goes out (no confirmation, reminders, pre-webinar
 * emails or texts); those start when the ticket is paid. Returns true when the normal run was scheduled.
 */
export async function scheduleEmails(rt: Runtime, lead: Lead, session: Session, reg: Registration) {
  await updateLead(rt.env, lead.id, { webinar_at: session.starts_at, webinar_registered_at: Date.now(), webinar_token: reg.token });
  await cancelSequence(rt, lead.id, 'webinar'); // an earlier session's reminders
  const fresh = (await getLead(rt.env, lead.id))!;
  const { passGate } = await import('./pass');
  if (await passGate(rt, reg)) {
    await cancelSequence(rt, lead.id, 'prewebinar');
    await stopSms(rt, lead.id, ['webinar']);
    await enqueueSequence(rt, fresh, 'ticket', { stepBase: reg.seq * TICKET_CYCLE });
    return false;
  }
  await cancelSequence(rt, lead.id, 'ticket');
  await enqueueSequence(rt, fresh, 'webinar', { stepBase: reg.seq * WEBINAR_CYCLE });
  if (!underMillion(fresh.revenue_band)) await enqueuePrewebinar(rt, fresh, reg.seq);
  return true;
}

/**
 * The ticket is paid: stop the "finish your ticket" emails and start the confirmation, reminders, pre-webinar
 * emails and texts for the lead's current registration, timed from now.
 */
export async function startTicketedMessages(rt: Runtime, leadId: string) {
  const lead = await getLead(rt.env, leadId);
  await cancelSequence(rt, leadId, 'ticket');
  const reg = lead?.webinar_token ? await getRegistration(rt, lead.webinar_token) : null;
  const session = reg ? await getSession(rt, reg.session_id) : null;
  if (!lead || !reg || !session) return false;
  await enqueueSequence(rt, lead, 'webinar', { stepBase: reg.seq * WEBINAR_CYCLE });
  if (!underMillion(lead.revenue_band)) {
    await enqueuePrewebinar(rt, lead, reg.seq);
    await startSms(rt, lead, 'webinar');
  }
  return true;
}

/** A refunded ticket: nothing more about the session goes out. */
export async function stopTicketedMessages(rt: Runtime, leadId: string) {
  for (const s of ['ticket', 'webinar', 'prewebinar'] as const) await cancelSequence(rt, leadId, s);
  await stopSms(rt, leadId, ['webinar']);
}

/** Moves someone to another session (from the "pick another time" link). */
export async function moveRegistration(rt: Runtime, reg: Registration, sessionId: string) {
  const session = sessionId.startsWith('jit:') ? await jitSession(rt, sessionId) : await getSession(rt, sessionId);
  if (!session || session.status !== 'scheduled' || session.starts_at < Date.now() - 5 * 60_000) throw new ApplicationError('That session is no longer available', 'session_id', 409);
  const lead = await getLead(rt.env, reg.lead_id);
  if (!lead) throw new ApplicationError('Registration not found', undefined, 404);
  const prior = await rt.env.DB.prepare('SELECT COUNT(*) AS n FROM webinar_registrations WHERE lead_id = ?').bind(lead.id).first<{ n: number }>();
  // A move keeps the ticket requirement (a paid ticket is the person's, so it carries over).
  const next: Registration = { ...reg, id: newId('wr'), token: token(), session_id: session.id, seq: prior?.n ?? 0, created_at: Date.now(), joined_at: null, last_seen_at: null, watch_seconds: 0, max_position: 0, cta_at: null, replay_at: null, replay_seconds: 0, pass_required: reg.pass_required ? 1 : 0 };
  await rt.env.DB.prepare('INSERT OR IGNORE INTO webinar_registrations (id, token, session_id, lead_id, seq, new_lead, created_at, pass_required) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(next.id, next.token, next.session_id, next.lead_id, next.seq, reg.new_lead, next.created_at, next.pass_required).run();
  const saved = await rt.env.DB.prepare('SELECT * FROM webinar_registrations WHERE lead_id = ? AND session_id = ?').bind(lead.id, session.id).first<Registration>();
  if (saved && saved.id === next.id && (await scheduleEmails(rt, lead, session, next))) await startSms(rt, (await getLead(rt.env, lead.id))!, 'webinar');
  if (saved && saved.id === next.id) await (await import('./pass')).syncPassReplay(rt, lead.id);
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
/** '0'/'1' per minute; returns the new string, or null when that minute was already marked. */
export function markMinute(cur: string | null, minute: number, durationMin: number) {
  const len = Math.max(1, Math.min(600, Math.round(durationMin)));
  if (minute < 0 || minute >= len) return null;
  const arr = (cur ?? '').padEnd(len, '0').slice(0, len).split('');
  if (arr[minute] === '1') return null;
  arr[minute] = '1';
  return arr.join('');
}

export async function heartbeat(rt: Runtime, reg: Registration, session: Session, body: { pos?: unknown; replay?: unknown }) {
  const w = webinarSettings(rt);
  const now = Date.now();
  const p = phase(rt, session, now, reg.replay_until);
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
  // Which minute of the masterclass is on their screen now (drives the minute-by-minute watch curve).
  const col = replay ? 'replay_minutes' : 'live_minutes';
  const marked = markMinute((fresh as Registration & Record<string, string | null>)[col] ?? null, Math.floor(pos / 60), w.durationMin);
  if (marked) await rt.env.DB.prepare(`UPDATE webinar_registrations SET ${col} = ? WHERE id = ?`).bind(marked, reg.id).run();
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

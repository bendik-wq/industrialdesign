import type { Runtime } from '../app';
import type { VisitorCtx } from '../lib/identity';
import { newId, newRefCode } from '../lib/ids';
import { type Lead, cleanName, getLead, getLeadByEmail, linkVisitor, normalisePhone, updateLead, validateEmail } from '../funnel/leads';
import { ApplicationError, attributionFor, verifyTurnstile } from '../funnel/application';
import { formatCallTime, zonedTime } from '../integrations/email';
import { APP_REVENUE_BAND, REVENUE_LABEL, isMillionPlus } from '../sales/qualify';
import { identityFromLead, identityFromVisitor, track } from '../tracking/track';
import { trackRevenueEvents } from '../tracking/revenue-events';
import { type PassRow, formatMoney, fromMinor, paymentProvider, toMinor } from '../webinar/pass';
import { playbackFor, upsertLiveEvent } from './stream';
import { PRESENCE_MS, chatLabel, chatRate, countPresence, escapeHtml, presenceLine, sanitiseChat, viewerName } from '../webinar/live';

/**
 * The live webinar funnel: scheduled live events with Josh (on Zoom, with our own companion room), managed in
 * Funnel HQ → Live webinars. Separate from the auto webinar (its own tables; the auto webinar is untouched).
 *
 *  - Landing /live: the next real event and a real countdown, registration (free, or a paid ticket when
 *    LIVE_TICKET_PRICE is set, paid on our Whop page with the card saved for a one-click deposit).
 *  - Reminders: confirmation, 24 hours, 1 hour, 10 minutes, "we're live", the replay and the replay's last
 *    hours (email; text where they ticked the box). Every link goes to the room, which then opens Zoom.
 *  - Room /live/room/:token: Join on Zoom (new tab), real presence and chat, the host's polls and pinned
 *    message, and the deposit offer the host opens live. The offer closes LIVE_OFFER_HOURS (default 48)
 *    after the event ends, or earlier when the host closes it; the replay closes with it. Every timer is
 *    read from the server's clock and the server refuses a deposit outside the window.
 */

export const LIVE_SEQUENCE = 'live';
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export interface LiveEvent {
  id: string; title: string; starts_at: number; tz: string; duration_min: number; join_url: string | null; replay_url: string | null;
  status: 'scheduled' | 'cancelled'; ended_at: number | null; offer_opened_at: number | null; offer_closed_at: number | null; offer_hours: number | null;
  timer_on: number; pinned: string | null; pinned_at: number | null; created_at: number; updated_at: number;
}
export interface LiveReg {
  id: string; token: string; event_id: string; lead_id: string; seq: number; new_lead: number; revenue_band: string | null; ticket_required: number; sms_ok: number;
  joined_at: number | null; zoom_clicked_at: number | null; last_seen_at: number | null; offer_seen_at: number | null; offer_clicked_at: number | null; replay_at: number | null; created_at: number;
}

// ───────────── settings ─────────────

export function liveSettings(rt: Pick<Runtime, 'settings'>) {
  const s = rt.settings as Partial<Record<string, string>>;
  const price = Number(String(s.LIVE_TICKET_PRICE ?? '').replace(/[^\d.]/g, ''));
  const hours = Number(String(s.LIVE_OFFER_HOURS ?? '').trim());
  const currency = /^[A-Za-z]{3}$/.test(String(s.ENGAGEMENT_DEPOSIT_CURRENCY ?? '').trim()) ? String(s.ENGAGEMENT_DEPOSIT_CURRENCY).trim().toUpperCase() : 'USD';
  const ticket = String(s.LIVE_TICKET_PRICE ?? '').trim() && Number.isFinite(price) && price > 0 ? { price, amount: toMinor(price, currency), label: formatMoney(price, currency) } : null;
  return {
    ticket, currency,
    offerHours: Number.isFinite(hours) && hours > 0 && hours <= 24 * 14 ? Math.round(hours) : 48,
    defaultTitle: 'Buy your first competitor with the bank’s money and the seller’s',
    tz: s.SALES_TIMEZONE || 'Australia/Sydney',
  };
}

/** The live pages' public origin: the webinar host when one is set, else the main domain. */
export function liveBase(rt: Pick<Runtime, 'settings' | 'origin'>) {
  try { const w = (rt.settings as Partial<Record<string, string>>).WEBINAR_URL; if (w) return new URL(w).origin; } catch { /* main domain */ }
  return rt.origin;
}
export const liveRoomUrl = (rt: Pick<Runtime, 'settings' | 'origin'>, token: string) => `${liveBase(rt)}/live/room/${token}`;
export const liveWelcomeUrl = (rt: Pick<Runtime, 'settings' | 'origin'>, token: string) => `${liveBase(rt)}/live/welcome/${token}`;
export const hostConsoleUrl = (rt: Pick<Runtime, 'origin'>, eventId: string) => `${rt.origin}/admin/live/webinar:${eventId}`;
export const streamKey = (eventId: string) => `webinar:${eventId}`;

// ───────────── timing (pure) ─────────────

export const eventEnd = (ev: Pick<LiveEvent, 'starts_at' | 'duration_min' | 'ended_at'>) => ev.ended_at ?? ev.starts_at + ev.duration_min * MIN;

/**
 * The offer window: open from the host's click until the host closes it or until the deadline (the event's
 * end plus the offer hours fixed when it opened). The replay closes at the same moment (never before the end).
 */
export function offerWindow(ev: Pick<LiveEvent, 'starts_at' | 'duration_min' | 'ended_at' | 'offer_opened_at' | 'offer_closed_at' | 'offer_hours' | 'status'>, now: number, defaultHours = 48) {
  const end = eventEnd(ev);
  const deadline = end + (ev.offer_hours ?? defaultHours) * HOUR;
  const closesAt = ev.offer_closed_at ? Math.min(ev.offer_closed_at, deadline) : deadline;
  const opened = Boolean(ev.offer_opened_at) && ev.status === 'scheduled';
  const open = opened && now < closesAt && !ev.offer_closed_at;
  return { opened, open, closesAt, deadline, end, closed: opened && !open, replayClosesAt: Math.max(end, closesAt) };
}

export type LiveStage = 'waiting' | 'live' | 'replay' | 'closed' | 'cancelled';
export function liveStage(ev: Parameters<typeof offerWindow>[0], now: number, defaultHours = 48): LiveStage {
  if (ev.status === 'cancelled') return 'cancelled';
  if (now < ev.starts_at) return 'waiting';
  const w = offerWindow(ev, now, defaultHours);
  if (now < w.end) return 'live';
  return now < w.replayClosesAt ? 'replay' : 'closed';
}

/** The Zoom link is handed out from 15 minutes before the start until the end. */
export const joinOpen = (ev: Pick<LiveEvent, 'starts_at' | 'duration_min' | 'ended_at' | 'status'>, now: number) => ev.status === 'scheduled' && now >= ev.starts_at - 15 * MIN && now < eventEnd(ev);

// ───────────── events (Funnel HQ) ─────────────

export const getEvent = (rt: Runtime, id: string) => rt.env.DB.prepare('SELECT * FROM live_webinars WHERE id = ?').bind(id).first<LiveEvent>();
export const getLiveReg = (rt: Runtime, token: string) =>
  /^[a-z0-9]{16,40}$/.test(token) ? rt.env.DB.prepare('SELECT * FROM live_webinar_regs WHERE token = ?').bind(token).first<LiveReg>() : Promise.resolve(null);

/** The next event people can register for (until 30 minutes after it starts). */
export async function nextEvent(rt: Runtime, now = Date.now()) {
  return rt.env.DB.prepare("SELECT * FROM live_webinars WHERE status = 'scheduled' AND starts_at > ? ORDER BY starts_at LIMIT 1").bind(now - 30 * MIN).first<LiveEvent>();
}

const https = (v: unknown) => (typeof v === 'string' && /^https:\/\/[^\s"'<>]{3,}$/.test(v.trim()) ? v.trim().slice(0, 500) : null);
const plain = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const validTz = (tz: unknown) => { try { if (typeof tz !== 'string' || !tz) return null; new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; } };

/** "2026-11-12T19:00" in a time zone → epoch ms (or an epoch number as is). */
export function parseLocal(v: unknown, tz: string) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  return zonedTime(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]) + Number(m[5]) / 60, tz);
}

export async function saveEvent(rt: Runtime, body: Record<string, unknown>, id?: string) {
  const prev = id ? await getEvent(rt, id) : null;
  if (id && !prev) return { ok: false as const, error: 'Event not found' };
  const tz = validTz(body.tz) ?? prev?.tz ?? liveSettings(rt).tz;
  const startsAt = body.starts_at != null ? parseLocal(body.starts_at, tz) : prev?.starts_at ?? null;
  if (!startsAt || (!prev && startsAt < Date.now() - HOUR) || startsAt > Date.now() + 365 * DAY) return { ok: false as const, error: 'Pick a date and time in the future' };
  const title = plain(body.title, 140) || prev?.title || liveSettings(rt).defaultTitle;
  const dur = Math.round(Number(body.duration_min ?? prev?.duration_min ?? 120));
  const duration = Number.isFinite(dur) && dur >= 30 && dur <= 300 ? dur : 120;
  const joinUrl = body.join_url !== undefined ? https(body.join_url) : prev?.join_url ?? null;
  if (body.join_url && !joinUrl) return { ok: false as const, error: 'The Zoom link must start with https://' };
  const replayUrl = body.replay_url !== undefined ? https(body.replay_url) : prev?.replay_url ?? null;
  if (body.replay_url && !replayUrl) return { ok: false as const, error: 'The replay link must start with https://' };
  const status = body.status === 'cancelled' ? 'cancelled' : body.status === 'scheduled' ? 'scheduled' : prev?.status ?? 'scheduled';
  const now = Date.now();
  // The live engine (stream.ts, key webinar:<id>) keeps the schedule and the Zoom link for the host console.
  const sync = (eid: string) => upsertLiveEvent(rt, streamKey(eid), { title, startsAt, durationMin: duration, ...(body.join_url !== undefined || !prev ? { joinUrl } : {}) }).catch((e) => console.error('live engine sync', e));
  if (prev) {
    await rt.env.DB.prepare('UPDATE live_webinars SET title = ?, starts_at = ?, tz = ?, duration_min = ?, join_url = ?, replay_url = ?, status = ?, updated_at = ? WHERE id = ?')
      .bind(title, startsAt, tz, duration, joinUrl, replayUrl, status, now, prev.id).run();
    await sync(prev.id);
    return { ok: true as const, id: prev.id };
  }
  const nid = newId('le');
  await rt.env.DB.prepare('INSERT INTO live_webinars (id, title, starts_at, tz, duration_min, join_url, replay_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(nid, title, startsAt, tz, duration, joinUrl, replayUrl, status, now, now).run();
  await sync(nid);
  return { ok: true as const, id: nid };
}

/** The host's buttons: open / close the offer, show / hide the timer, pin / unpin a message, end the event. */
export async function hostAction(rt: Runtime, id: string, body: Record<string, unknown>, now = Date.now()) {
  const ev = await getEvent(rt, id);
  if (!ev) return { ok: false as const, error: 'Event not found' };
  const db = rt.env.DB;
  const hours = liveSettings(rt).offerHours;
  const set = (sql: string, ...args: unknown[]) => db.prepare(`UPDATE live_webinars SET ${sql}, updated_at = ? WHERE id = ?`).bind(...args, now, id).run();
  switch (body.action) {
    case 'open_offer':
      if (ev.status !== 'scheduled') return { ok: false as const, error: 'This event is cancelled' };
      if (now < ev.starts_at - 15 * MIN) return { ok: false as const, error: 'The offer opens during the event' };
      if (offerWindow(ev, now, hours).open) return { ok: true as const, already: true };
      if (ev.offer_opened_at && ev.offer_closed_at) return { ok: false as const, error: 'The offer was closed for this event. A closed offer stays closed, so the deadline stays real.' };
      if (now >= eventEnd(ev) + (ev.offer_hours ?? hours) * HOUR) return { ok: false as const, error: 'The offer window for this event has passed' };
      await set('offer_opened_at = COALESCE(offer_opened_at, ?), offer_hours = COALESCE(offer_hours, ?), offer_closed_at = NULL', now, hours);
      return { ok: true as const };
    case 'close_offer':
      if (!ev.offer_opened_at) return { ok: false as const, error: 'The offer isn’t open' };
      await set('offer_closed_at = COALESCE(offer_closed_at, ?)', now);
      return { ok: true as const };
    case 'timer_on': await set('timer_on = 1'); return { ok: true as const };
    case 'timer_off': await set('timer_on = 0'); return { ok: true as const };
    case 'pin': {
      const text = plain(body.text, 280);
      if (!text) return { ok: false as const, error: 'Write the message to pin' };
      await set('pinned = ?, pinned_at = ?', text, now);
      return { ok: true as const };
    }
    case 'unpin': await set('pinned = NULL, pinned_at = NULL'); return { ok: true as const };
    case 'end':
      if (now < ev.starts_at) return { ok: false as const, error: 'The event hasn’t started' };
      await set('ended_at = COALESCE(ended_at, ?)', Math.min(now, eventEnd(ev)));
      return { ok: true as const };
    default: return { ok: false as const, error: 'Unknown action' };
  }
}

// ───────────── polls ─────────────

export async function pushPoll(rt: Runtime, eventId: string, body: Record<string, unknown>) {
  if (!(await getEvent(rt, eventId))) return { ok: false as const, error: 'Event not found' };
  const question = plain(body.question, 200);
  const options = (Array.isArray(body.options) ? body.options : String(body.options ?? '').split('\n')).map((o) => plain(o, 80)).filter(Boolean).slice(0, 5);
  if (!question || options.length < 2) return { ok: false as const, error: 'Write the question and at least two answers' };
  const now = Date.now();
  await rt.env.DB.prepare('UPDATE live_webinar_polls SET closed_at = ? WHERE event_id = ? AND closed_at IS NULL').bind(now, eventId).run();
  const id = newId('lp');
  await rt.env.DB.prepare('INSERT INTO live_webinar_polls (id, event_id, question, options, opened_at) VALUES (?, ?, ?, ?, ?)').bind(id, eventId, question, JSON.stringify(options), now).run();
  return { ok: true as const, id };
}
export async function closePoll(rt: Runtime, eventId: string) {
  await rt.env.DB.prepare('UPDATE live_webinar_polls SET closed_at = ? WHERE event_id = ? AND closed_at IS NULL').bind(Date.now(), eventId).run();
  return { ok: true as const };
}
async function pollResults(rt: Runtime, pollId: string, n: number) {
  const { results } = await rt.env.DB.prepare('SELECT choice, COUNT(*) AS n FROM live_webinar_poll_votes WHERE poll_id = ? GROUP BY choice').bind(pollId).all<{ choice: number; n: number }>();
  const counts = Array.from({ length: n }, (_, i) => results.find((r) => r.choice === i)?.n ?? 0);
  return { counts, total: counts.reduce((a, b) => a + b, 0) };
}
export async function vote(rt: Runtime, reg: LiveReg, body: Record<string, unknown>) {
  const poll = await rt.env.DB.prepare('SELECT * FROM live_webinar_polls WHERE id = ? AND event_id = ? AND closed_at IS NULL').bind(String(body.poll ?? ''), reg.event_id).first<{ id: string; options: string }>();
  if (!poll) return { ok: false as const, error: 'This poll has closed.' };
  const n = (JSON.parse(poll.options) as string[]).length;
  const choice = Math.round(Number(body.choice));
  if (!Number.isInteger(choice) || choice < 0 || choice >= n) return { ok: false as const, error: 'Pick an answer' };
  await rt.env.DB.prepare('INSERT INTO live_webinar_poll_votes (poll_id, reg_id, choice, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(poll_id, reg_id) DO NOTHING').bind(poll.id, reg.id, choice, Date.now()).run();
  return { ok: true as const, results: await pollResults(rt, poll.id, n) };
}

// ───────────── registration ─────────────

const token = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);

/** Registers someone for a live event (an existing lead keeps its details: anyone can type anyone's email). */
export async function registerLive(rt: Runtime, v: VisitorCtx, body: Record<string, unknown>) {
  const firstName = cleanName(body.first_name);
  const emailCheck = validateEmail(body.email);
  if (!firstName) throw new ApplicationError('Please enter your first name', 'first_name');
  if (!emailCheck) throw new ApplicationError('Please enter a valid email address', 'email');
  if (emailCheck.disposable) throw new ApplicationError('Please use your real email address. Your room link goes there.', 'email');
  const band = APP_REVENUE_BAND[String(body.revenue ?? '')] ?? null;
  if (!band) throw new ApplicationError('Please pick your business’s annual revenue', 'revenue');
  if (!(await verifyTurnstile(rt, body.turnstile, v.ip))) throw new ApplicationError('Security check failed. Please refresh and try again.', undefined, 403);
  const wantsTexts = body.sms_consent === true || body.sms_consent === 'true' || body.sms_consent === 'on';
  const phone = typeof body.phone === 'string' && body.phone.trim() ? normalisePhone(body.phone, v.geo.country) : null;
  if (typeof body.phone === 'string' && body.phone.trim() && !phone) throw new ApplicationError('Please enter a valid mobile number, including area code, or leave it blank', 'phone');
  const ev = typeof body.event_id === 'string' && body.event_id ? await getEvent(rt, body.event_id) : await nextEvent(rt);
  const now = Date.now();
  if (!ev || ev.status !== 'scheduled' || now > ev.starts_at + 30 * MIN) throw new ApplicationError('Registration for that session has closed', 'event_id', 409);

  // Abuse limit: a handful of sign-ups per IP per hour (each one sends email).
  const ipKey = `lreg:${v.ip ?? 'unknown'}`;
  const row = await rt.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(ipKey).first<{ value: string }>();
  const rate = (() => { try { const r = JSON.parse(row?.value ?? '{}') as { n?: number; t?: number }; return r.t && now - r.t < HOUR ? { n: r.n ?? 0, t: r.t } : { n: 0, t: now }; } catch { return { n: 0, t: now }; } })();
  if (rate.n >= 8) throw new ApplicationError('Too many sign-ups from this connection. Please try again in an hour.', undefined, 429);

  let lead = await getLeadByEmail(rt.env, emailCheck.email);
  let newLead = false;
  if (!lead) {
    const { last, first } = await attributionFor(rt, v);
    const id = newId('l');
    await rt.env.DB.prepare(
      `INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, session_id, first_name, email, phone, sms_consent_at, wa_consent_at, whatsapp_opt_in, step_reached, status,
         channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term, click_id, click_type, ft_channel, ft_source, ft_campaign, ft_content,
         landing_path, variant, country, city, device, fbp, fbc, timezone, revenue_band)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,'partial',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, newRefCode(), now, now, v.visitorId, v.sessionId, firstName, emailCheck.email, phone, phone && wantsTexts ? now : null, phone && wantsTexts ? now : null,
      last?.channel ?? 'Direct', last?.utm_source ?? null, last?.utm_medium ?? null, last?.utm_campaign ?? null, last?.utm_content ?? null, last?.utm_term ?? null,
      last?.click_id ?? null, last?.click_type ?? null, first?.ft_channel ?? null, first?.ft_source ?? null, first?.ft_campaign ?? null, first?.ft_content ?? null,
      last?.landing_path ?? '/live', v.variant, v.geo.country, v.geo.city, v.ua.device, v.fbp, v.fbc, v.geo.timezone, band,
    ).run();
    lead = (await getLead(rt.env, id))!;
    newLead = true;
    await linkVisitor(rt.env, v.visitorId, lead.id);
  }
  const existing = await rt.env.DB.prepare('SELECT * FROM live_webinar_regs WHERE event_id = ? AND lead_id = ?').bind(ev.id, lead.id).first<LiveReg>();
  if (existing) {
    if (v.leadId === lead.id) return { reg: existing, event: ev, lead, created: false };
    throw new ApplicationError('You’re already registered for this session. Your room link is in the confirmation email (check spam too).', 'email', 409);
  }
  await rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(ipKey, JSON.stringify({ n: rate.n + 1, t: rate.t })).run();
  const prior = await rt.env.DB.prepare('SELECT COUNT(*) AS n FROM live_webinar_regs WHERE lead_id = ?').bind(lead.id).first<{ n: number }>();
  const s = liveSettings(rt);
  const ticketRequired = s.ticket && paymentProvider(rt.settings) === 'whop' ? 1 : 0;
  // Texts only to a number given with the box ticked (here, or on an earlier form).
  const smsOk = phone && wantsTexts ? 1 : lead.sms_consent_at && lead.phone ? 1 : 0;
  const reg: LiveReg = {
    id: newId('lr'), token: token(), event_id: ev.id, lead_id: lead.id, seq: prior?.n ?? 0, new_lead: newLead ? 1 : 0, revenue_band: band, ticket_required: ticketRequired, sms_ok: smsOk,
    joined_at: null, zoom_clicked_at: null, last_seen_at: null, offer_seen_at: null, offer_clicked_at: null, replay_at: null, created_at: now,
  };
  await rt.env.DB.prepare('INSERT INTO live_webinar_regs (id, token, event_id, lead_id, seq, new_lead, revenue_band, ticket_required, sms_ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(reg.id, reg.token, reg.event_id, reg.lead_id, reg.seq, reg.new_lead, band, ticketRequired, smsOk, now).run();
  const bandIsNew = !lead.revenue_band;
  if (bandIsNew) await updateLead(rt.env, lead.id, { revenue_band: band });
  if (phone && wantsTexts && !lead.phone && !newLead) await updateLead(rt.env, lead.id, { phone, sms_consent_at: now });
  const who = newLead ? identityFromVisitor(v, null, lead.id) : await identityFromLead(rt.env, lead.id);
  await track(rt, who, { name: 'live_registered', source: 'server', path: '/live', props: { event_id: ev.id, starts_at: ev.starts_at, band, ticket: Boolean(ticketRequired) }, eventId: typeof body.event_id_track === 'string' ? body.event_id_track : undefined });
  if (bandIsNew) await trackRevenueEvents(rt, who, band, 'webinar', '/live');
  // The confirmation goes out now (the cron is the backup).
  rt.waitUntil(sendDueMessages(rt, ev, reg, (await getLead(rt.env, lead.id))!, now).then(() => undefined));
  if (['10m-25m', '25m-50m', '50m-100m', '100m+'].includes(band)) {
    const { notifySlack } = await import('../integrations/notify');
    rt.waitUntil(notifySlack(rt, lead, '💎 $10M+ owner registered for the live webinar', [`${ev.title} · ${formatCallTime(ev.starts_at, ev.tz)}`], 'hot_lead').catch(() => undefined));
  }
  return { reg, event: ev, lead: (await getLead(rt.env, lead.id))!, created: true };
}

// ───────────── the live ticket (LIVE_TICKET_PRICE) ─────────────

export const paidLiveTicket = (rt: Runtime, reg: Pick<LiveReg, 'lead_id' | 'event_id'>) =>
  rt.env.DB.prepare("SELECT id FROM webinar_passes WHERE lead_id = ? AND kind = 'live_ticket' AND status = 'paid' AND ref_id = ? LIMIT 1").bind(reg.lead_id, reg.event_id).first<{ id: string }>();
/** The room and the reminders wait for the ticket: registered while a ticket was required, and nothing paid. */
export async function ticketGate(rt: Runtime, reg: LiveReg) {
  if (!reg.ticket_required) return false;
  return !(await paidLiveTicket(rt, reg));
}
export async function startLiveTicket(rt: Runtime, reg: LiveReg) {
  const s = liveSettings(rt);
  if (!s.ticket || paymentProvider(rt.settings) !== 'whop') return { error: 'Tickets aren’t on sale right now.' };
  if (!(await ticketGate(rt, reg))) return { url: liveRoomUrl(rt, reg.token) };
  const { pendingRow, payPageUrl } = await import('../sales/pay-page');
  const id = await pendingRow(rt, { kind: 'live_ticket', regId: reg.id, leadId: reg.lead_id, product: 'Live webinar ticket', amount: s.ticket.amount, currency: s.currency, source: 'live', refId: reg.event_id, returnUrl: `${liveRoomUrl(rt, reg.token)}?ticket=paid` });
  return { url: await payPageUrl(rt, id) };
}
export async function liveTicketPaidEffects(rt: Runtime, pass: PassRow) {
  const value = fromMinor(pass.amount, pass.currency);
  await track(rt, await identityFromLead(rt.env, pass.lead_id), { name: 'live_ticket_purchased', source: 'webhook', path: '/live', props: { pass_id: pass.id, product: 'Live webinar ticket', value, currency: pass.currency.toUpperCase() } }).catch(() => null);
  const reg = await rt.env.DB.prepare('SELECT * FROM live_webinar_regs WHERE id = ?').bind(pass.reg_id).first<LiveReg>();
  const ev = reg ? await getEvent(rt, reg.event_id) : null;
  const lead = await getLead(rt.env, pass.lead_id);
  if (reg && ev && lead) rt.waitUntil(sendDueMessages(rt, ev, reg, lead).then(() => undefined));
  if (lead) {
    const { notifySlack } = await import('../integrations/notify');
    rt.waitUntil(notifySlack(rt, lead, '🎟️ Live webinar ticket paid', [`${formatMoney(value, pass.currency.toUpperCase())}${ev ? ` · ${ev.title}` : ''}`], 'qualified_lead').catch(() => undefined));
  }
}

// ───────────── reminders (email + text) ─────────────

export type LiveMessage = 'confirm' | 'ticket' | 'r24h' | 'r1h' | 'r10m' | 'live' | 'replay' | 'replay_last';
export const LIVE_STEP: Record<LiveMessage, number> = { confirm: 0, r24h: 1, r1h: 2, r10m: 3, live: 4, replay: 5, replay_last: 6, ticket: 7 };
const TEXTED: LiveMessage[] = ['confirm', 'r1h', 'r10m', 'live'];
const STEP_BLOCK = 10;

/** Which messages are due for one registration right now (pure, for the tests). */
export function dueLiveMessages(ev: Parameters<typeof offerWindow>[0] & Pick<LiveEvent, 'starts_at'>, reg: Pick<LiveReg, 'created_at' | 'joined_at' | 'seq'>, o: { now: number; ticketUnpaid: boolean; deposit: boolean; offerHours?: number }) {
  const { now } = o;
  if (ev.status !== 'scheduled') return [];
  const start = ev.starts_at;
  const w = offerWindow(ev, now, o.offerHours ?? 48);
  const out: LiveMessage[] = [];
  const at = (from: number, to: number) => now >= from && now < to;
  const before = (t: number) => reg.created_at < t; // only reminders whose moment came after they registered
  if (o.ticketUnpaid) {
    if (at(reg.created_at + 30 * MIN, start)) out.push('ticket');
    return out.map((k) => k);
  }
  if (now < w.end) out.push('confirm');
  if (at(start - 24 * HOUR, start - 3 * HOUR) && before(start - 24 * HOUR)) out.push('r24h');
  if (at(start - HOUR, start - 15 * MIN) && before(start - HOUR)) out.push('r1h');
  if (at(start - 10 * MIN, start + 5 * MIN) && before(start - 10 * MIN)) out.push('r10m');
  if (at(start, start + 20 * MIN) && !reg.joined_at) out.push('live');
  if (!o.deposit && at(w.end + 30 * MIN, w.replayClosesAt - HOUR)) out.push('replay');
  if (!o.deposit && w.opened && at(w.replayClosesAt - 6 * HOUR, w.replayClosesAt - 30 * MIN)) out.push('replay_last');
  return out;
}
export const liveStep = (reg: Pick<LiveReg, 'seq'>, k: LiveMessage) => reg.seq * STEP_BLOCK + LIVE_STEP[k];

export interface LiveMailCtx { name: string; title: string; when: string; room: string; ticket: string | null; ticketLabel: string | null; attended: boolean; offerOpened: boolean; closes: string | null; replay: boolean; deposit: string }

/** Every live email (plain text). Pure, so the tests audit each one. Every link is the room link. */
export function liveEmail(kind: LiveMessage, x: LiveMailCtx) {
  const hi = `Hi ${x.name},`;
  const room = { label: 'Open my room', href: x.room };
  const how = 'Open your room link first. It has the Join on Zoom button, the chat, the polls and everything from the session, so keep that tab open while you watch on Zoom.';
  switch (kind) {
    case 'confirm':
      return { subject: `You’re in: ${x.title}`, preheader: `${x.when}. Your room link is inside.`, heading: 'You’re registered', paras: [hi, `You’re registered for ${x.title}, live with Josh on ${x.when}.`, how, 'Josh teaches how owners buy a competitor with commercial debt, seller finance and seller rollover, then answers questions live. Bring yours.'], button: room };
    case 'ticket':
      return { subject: `Finish your ticket for ${x.title}`, preheader: 'Your seat is held until the session starts.', heading: 'Your ticket isn’t paid yet', paras: [hi, `You registered for ${x.title} on ${x.when}, and your ticket${x.ticketLabel ? ` (${x.ticketLabel})` : ''} isn’t paid yet.`, 'Your room link and the reminders start as soon as it is.'], button: { label: 'Finish my ticket', href: x.ticket ?? x.room } };
    case 'r24h':
      return { subject: `Tomorrow: ${x.title}`, preheader: `${x.when}, live with Josh.`, heading: 'Tomorrow, live with Josh', paras: [hi, `${x.title} is tomorrow: ${x.when}.`, how, 'Write down the one question you want answered about buying your first competitor. Josh takes questions live.'], button: room };
    case 'r1h':
      return { subject: `In one hour: ${x.title}`, preheader: 'Open your room a few minutes early.', heading: 'One hour to go', paras: [hi, `We start in one hour, at ${x.when}.`, how], button: room };
    case 'r10m':
      return { subject: 'Starting in 10 minutes', preheader: 'Open your room, then join on Zoom.', heading: 'Starting in 10 minutes', paras: [hi, 'Josh goes live in 10 minutes.', how], button: room };
    case 'live':
      return { subject: 'We’re live now', preheader: 'Open your room and join on Zoom.', heading: 'Josh is live now', paras: [hi, `${x.title} has started.`, how], button: room };
    case 'replay':
      return {
        subject: x.attended ? 'Thank you for coming tonight' : `The replay of ${x.title}`,
        preheader: x.closes ? `The replay comes down ${x.closes}.` : 'Your room has the replay.',
        heading: x.attended ? 'Thank you for coming' : 'You can still watch it',
        paras: [hi, x.attended ? `Thank you for joining ${x.title}.` : `You missed ${x.title} live. ${x.replay ? 'The replay is in your room.' : 'Your room has everything from the session.'}`,
          ...(x.offerOpened ? [`The ${x.deposit} engagement deposit Josh opened in the session is still available in your room. It closes ${x.closes}, and the replay comes down at the same time.`] : x.closes ? [`The replay comes down ${x.closes}.`] : [])],
        button: room,
      };
    case 'replay_last':
      return { subject: `The offer from ${x.title} closes ${x.closes}`, preheader: 'The replay comes down at the same time.', heading: 'The last hours', paras: [hi, `The ${x.deposit} engagement deposit from the session closes ${x.closes}. The replay comes down at the same time.`, 'The deposit holds your place in this intake and is credited in full against the engagement fee. The guarantee and its conditions are in your room.'], button: room };
  }
}

/** The text version (sender name first; the first text to anyone says how to opt out). */
export function liveText(kind: LiveMessage, x: { title: string; when: string; site: string }) {
  switch (kind) {
    case 'confirm': return `${x.site}: you're registered for ${x.title}, ${x.when}. Open your room first, then join on Zoom:`;
    case 'r1h': return `${x.site}: ${x.title} starts in 1 hour. Open your room first, then join on Zoom:`;
    case 'r10m': return `${x.site}: Josh goes live in 10 minutes. Open your room, then join on Zoom:`;
    case 'live': return `${x.site}: Josh is live now. Your room:`;
    default: return null;
  }
}

async function mailCtx(rt: Runtime, ev: LiveEvent, reg: LiveReg, lead: Lead, now: number): Promise<LiveMailCtx> {
  const tz = lead.timezone || ev.tz;
  const w = offerWindow(ev, now, liveSettings(rt).offerHours);
  const s = liveSettings(rt);
  const { safeFirstName } = await import('../lib/text');
  const { depositConfig } = await import('../sales/deposit');
  return {
    name: safeFirstName(lead.first_name) ?? 'there', title: ev.title, when: formatCallTime(ev.starts_at, tz), room: liveRoomUrl(rt, reg.token),
    ticket: `${liveBase(rt)}/live/ticket/${reg.token}`, ticketLabel: s.ticket?.label ?? null, attended: Boolean(reg.joined_at), offerOpened: w.opened,
    closes: formatCallTime(w.replayClosesAt, tz), replay: Boolean(ev.replay_url), deposit: depositConfig(rt).label,
  };
}

async function sendText(rt: Runtime, lead: Lead, reg: LiveReg, k: LiveMessage, ev: LiveEvent, now: number) {
  const { smsBlock, smsConfigured, inTextingHours, sendSmsNow } = await import('../integrations/sms');
  const { callingZones } = await import('../integrations/elevenlabs');
  const tz = lead.timezone || ev.tz;
  const body0 = liveText(k, { title: ev.title, when: formatCallTime(ev.starts_at, tz), site: rt.settings.SITE_NAME || 'G&L' });
  if (!body0 || !reg.sms_ok || smsBlock(lead) || !lead.sms_consent_at) return false;
  if (rt.settings.SMS_ENABLED?.trim().toLowerCase() === 'false') return false;
  const zones = callingZones(lead.phone);
  if (!zones || !inTextingHours(now, zones)) return false;
  const db = rt.env.DB;
  const today = await db.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE lead_id = ? AND direction = 'out' AND status IN ('sent', 'simulated') AND sent_at > ?").bind(lead.id, now - DAY).first<{ n: number }>();
  if ((today?.n ?? 0) >= 3) return false;
  const before = await db.prepare("SELECT 1 FROM sms_messages WHERE lead_id = ? AND direction = 'out' AND status IN ('sent', 'simulated') LIMIT 1").bind(lead.id).first();
  const id = newId('sm');
  const claim = await db.prepare(
    `INSERT INTO sms_messages (id, lead_id, direction, sequence, step, template, to_phone, send_at, status, attempts, link_target, created_at) VALUES (?, ?, 'out', ?, ?, ?, ?, ?, 'sending', 1, ?, ?)
     ON CONFLICT(lead_id, sequence, step) WHERE direction = 'out' DO NOTHING`,
  ).bind(id, lead.id, LIVE_SEQUENCE, liveStep(reg, k), `live:${k}`, lead.phone, now, liveRoomUrl(rt, reg.token), now).run();
  if (!claim.meta.changes) return false;
  const body = `${body0} ${rt.origin}/s/${id}${before ? '' : ' Reply STOP to opt out.'}`;
  try {
    const providerId = smsConfigured(rt) ? await sendSmsNow(rt, lead.phone!, body) : null;
    await db.prepare("UPDATE sms_messages SET status = ?, sent_at = ?, provider_id = ?, body = ?, channel = 'sms' WHERE id = ?").bind(providerId ? 'sent' : 'simulated', Date.now(), providerId, body, id).run();
    return true;
  } catch (e) {
    await db.prepare("UPDATE sms_messages SET status = 'failed', error = ?, body = ? WHERE id = ?").bind(String(e instanceof Error ? e.message : e).slice(0, 300), body, id).run();
    return false;
  }
}

/** Sends what is due for one registration (each message once). */
export async function sendDueMessages(rt: Runtime, ev: LiveEvent, reg: LiveReg, lead: Lead, now = Date.now()) {
  const { paidDeposit } = await import('../sales/deposit');
  const due = dueLiveMessages(ev, reg, { now, ticketUnpaid: await ticketGate(rt, reg), deposit: Boolean(await paidDeposit(rt, reg.lead_id)), offerHours: liveSettings(rt).offerHours });
  if (!due.length) return 0;
  const done = await rt.env.DB.prepare("SELECT step FROM emails WHERE lead_id = ? AND sequence = ? AND step >= ? AND step < ? AND status IN ('sent', 'simulated', 'sending', 'skipped', 'cancelled')")
    .bind(lead.id, LIVE_SEQUENCE, reg.seq * STEP_BLOCK, (reg.seq + 1) * STEP_BLOCK).all<{ step: number }>();
  const todo = due.filter((k) => !done.results.some((r) => r.step === liveStep(reg, k)));
  if (!todo.length) return 0;
  const { sendOnce } = await import('./mail');
  const ctx = await mailCtx(rt, ev, reg, lead, now);
  let sent = 0;
  for (const k of todo) {
    const marketing = k === 'replay' || k === 'replay_last';
    if (marketing && lead.unsubscribed_at) continue;
    if (lead.email && (await sendOnce(rt, lead, LIVE_SEQUENCE, liveStep(reg, k), `live_${k}`, liveEmail(k, ctx), { unsubscribe: marketing }))) sent++;
    if (TEXTED.includes(k)) await sendText(rt, lead, reg, k, ev, now).catch((e) => console.error('live text', e));
  }
  return sent;
}

/** Cron (every 5 minutes): reminders and replay emails for events from 3 days ago to 2 days ahead. */
export async function processLiveMessages(rt: Runtime, now = Date.now()) {
  const { results: events } = await rt.env.DB.prepare("SELECT * FROM live_webinars WHERE status = 'scheduled' AND starts_at BETWEEN ? AND ?").bind(now - 4 * DAY, now + 2 * DAY).all<LiveEvent>();
  let sent = 0;
  for (const ev of events) {
    const { results: regs } = await rt.env.DB.prepare('SELECT * FROM live_webinar_regs WHERE event_id = ? LIMIT 2000').bind(ev.id).all<LiveReg>();
    for (const reg of regs) {
      const lead = await getLead(rt.env, reg.lead_id);
      if (!lead) continue;
      sent += await sendDueMessages(rt, ev, reg, lead, now).catch((e) => { console.error('live messages', e); return 0; });
    }
  }
  return { sent };
}

// ───────────── the room ─────────────

async function ping(rt: Runtime, eventId: string, who: string, kind: 'viewer' | 'replay' | 'host', now: number) {
  const db = rt.env.DB;
  await db.prepare('INSERT INTO webinar_presence (session_id, who, kind, first_at, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, who) DO UPDATE SET seen_at = excluded.seen_at, kind = excluded.kind').bind(eventId, who, kind, now, now).run();
  if (kind !== 'viewer') return;
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM webinar_presence WHERE session_id = ? AND kind = 'viewer' AND seen_at > ?").bind(eventId, now - PRESENCE_MS.viewer).first<{ n: number }>())?.n ?? 1;
  await db.prepare(`INSERT INTO webinar_live_peaks (session_id, peak_viewers, peak_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET peak_at = CASE WHEN excluded.peak_viewers > peak_viewers THEN excluded.peak_at ELSE peak_at END,
      peak_viewers = MAX(peak_viewers, excluded.peak_viewers), updated_at = excluded.updated_at`).bind(eventId, n, now, now).run();
}
export const hostPing = (rt: Runtime, eventId: string, hostId: string) => ping(rt, eventId, `host:${hostId.replace(/[^a-z0-9]/gi, '').slice(0, 32)}`, 'host', Date.now());

type ChatRow = { id: number; author: string; name: string; body: string | null; pinned_at: number | null; deleted_at: number | null; created_at: number };
const outMsg = (m: ChatRow) => (m.deleted_at ? { id: m.id, deleted: true } : { id: m.id, ...chatLabel(m), html: escapeHtml(m.body ?? ''), t: m.created_at });

/** Every string in the room (checked by auditCopy in the tests). */
export const ROOM_COPY = {
  joinHeading: 'Josh is live on Zoom',
  joinBody: 'Zoom opens in a new tab. Come back to this tab when Josh says so: the offer, the polls and the chat are here.',
  joinButton: 'Join on Zoom',
  joinSoon: 'The Join on Zoom button appears here 15 minutes before the start.',
  noLink: 'The Zoom link appears here shortly before the start.',
  startsIn: 'Starts in',
  keepOpen: 'Keep this tab open. When Josh opens the offer, it appears here, and this tab’s title changes.',
  notifyButton: 'Notify me when the offer opens',
  notifyOn: 'You get a notification on this device when the offer opens.',
  notifyBlocked: 'Notifications are blocked for this site in your browser settings. The tab title changes instead.',
  replayHeading: 'The replay',
  replayButton: 'Watch the replay',
  replayNone: 'The session has ended. The replay link appears here when the recording is ready.',
  replayCloses: 'The replay comes down in',
  closedHeading: 'This session has closed',
  closedBody: 'The replay and the offer from this session are no longer available.',
  cancelledHeading: 'This session was cancelled',
  cancelledBody: 'Josh’s team emails you the new date.',
  chatHeading: 'Chat',
  chatNote: 'Real owners in this session. Names show as first name and last initial.',
  chatEmpty: 'No messages yet. Say hello.',
  chatPlaceholder: 'Write a message or a question for Josh',
  chatSend: 'Send',
  chatClosed: 'The chat for this session has closed.',
  anonToggle: 'Hide my name',
  pollHeading: 'Poll from Josh',
  pollThanks: 'Thanks. Here is how the room answered.',
  offerNotice: 'Offer open',
  ticketHeading: 'Your ticket isn’t paid yet',
  ticketBody: 'Your seat in the room is confirmed once your ticket is paid.',
  ticketButton: 'Finish my ticket',
  registered: 'You’re registered. Your room link is in your inbox too.',
  addCalendar: 'Add to calendar',
};

export async function roomState(rt: Runtime, ev: LiveEvent, reg: LiveReg, now = Date.now()) {
  const s = liveSettings(rt);
  const w = offerWindow(ev, now, s.offerHours);
  const stage = liveStage(ev, now, s.offerHours);
  // The Zoom link comes from the live engine (pasted in the host console or Funnel HQ, or created through the Zoom API),
  // handed out only inside its join window; never once the event is cancelled or closed.
  const pb = ev.status === 'scheduled' && stage !== 'closed'
    ? await playbackFor(rt, streamKey(ev.id), ev.join_url, { startsAt: ev.starts_at, durationMin: Math.max(1, Math.round((w.end - ev.starts_at) / MIN)) }).catch(() => null)
    : null;
  return {
    stage, now, startsAt: ev.starts_at, endsAt: w.end,
    joinUrl: pb?.joinUrl ?? null, hasLink: pb?.mode === 'link',
    replayUrl: stage === 'replay' ? ev.replay_url : null, replayClosesAt: w.replayClosesAt,
    offer: { opened: w.opened, open: w.open && stage !== 'closed', closesAt: w.closesAt },
    timer: ev.timer_on && w.open ? { closesAt: w.closesAt } : null,
    pinned: ev.pinned ? escapeHtml(ev.pinned) : null,
    qualified: isMillionPlus(reg.revenue_band),
  };
}

/** The room's poll (every ~4 s): state, presence, chat after the cursor, the host's poll. */
export async function liveFeed(rt: Runtime, reg: LiveReg, body: Record<string, unknown>) {
  const ev = await getEvent(rt, reg.event_id);
  if (!ev) return { ok: false };
  const db = rt.env.DB;
  const now = Date.now();
  const st = await roomState(rt, ev, reg, now);
  if (body.presence === true && (st.stage === 'live' || st.stage === 'waiting' || st.stage === 'replay')) {
    await ping(rt, ev.id, reg.id, st.stage === 'replay' ? 'replay' : 'viewer', now);
    if (st.stage === 'live' && !reg.joined_at) await db.prepare('UPDATE live_webinar_regs SET joined_at = COALESCE(joined_at, ?) WHERE id = ?').bind(now, reg.id).run();
    if (st.stage === 'replay' && !reg.replay_at) await db.prepare('UPDATE live_webinar_regs SET replay_at = COALESCE(replay_at, ?) WHERE id = ?').bind(now, reg.id).run();
    await db.prepare('UPDATE live_webinar_regs SET last_seen_at = ? WHERE id = ?').bind(now, reg.id).run();
  }
  if (st.offer.open && !reg.offer_seen_at) await db.prepare('UPDATE live_webinar_regs SET offer_seen_at = COALESCE(offer_seen_at, ?) WHERE id = ?').bind(now, reg.id).run();
  const after = Math.max(0, Math.floor(Number(body.after) || 0));
  const since = Math.max(0, Math.floor(Number(body.since) || 0));
  const cols = 'id, author, name, CASE WHEN deleted_at IS NULL THEN body END AS body, pinned_at, deleted_at, created_at';
  const res = await db.batch([
    db.prepare('SELECT who, kind, seen_at FROM webinar_presence WHERE session_id = ? AND seen_at > ?').bind(ev.id, now - PRESENCE_MS.host),
    after === 0
      ? db.prepare(`SELECT ${cols} FROM webinar_chat WHERE session_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 150`).bind(ev.id)
      : db.prepare(`SELECT ${cols} FROM webinar_chat WHERE session_id = ? AND (id > ? OR updated_at > ?) ORDER BY id LIMIT 200`).bind(ev.id, after, since - 2000),
    db.prepare('SELECT * FROM live_webinar_polls WHERE event_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1').bind(ev.id),
  ]);
  const presence = countPresence(res[0].results as { who: string; kind: string; seen_at: number }[], now, reg.id);
  let msgs = res[1].results as ChatRow[];
  if (after === 0) msgs = msgs.reverse();
  const p = (res[2].results as { id: string; question: string; options: string }[])[0];
  let poll = null;
  if (p) {
    const options = JSON.parse(p.options) as string[];
    const mine = await db.prepare('SELECT choice FROM live_webinar_poll_votes WHERE poll_id = ? AND reg_id = ?').bind(p.id, reg.id).first<{ choice: number }>();
    poll = { id: p.id, question: escapeHtml(p.question), options: options.map(escapeHtml), voted: mine ? mine.choice : null, results: mine ? await pollResults(rt, p.id, options.length) : null };
  }
  const chatStageFor = st.stage === 'live' ? 'running' : st.stage === 'waiting' ? 'waiting' : st.stage === 'replay' ? 'replay' : 'closed';
  return {
    ok: true, ...st,
    presence: { line: presenceLine(chatStageFor as never, st.stage === 'replay' ? presence.replay : presence.viewers), host: st.stage !== 'closed' && presence.host > 0 ? 'Josh’s team is in the room.' : null },
    chat: { canPost: st.stage === 'waiting' || st.stage === 'live' || (st.stage === 'replay' && now < st.endsAt + 30 * MIN), messages: msgs.map(outMsg), cursor: msgs.reduce((a, m) => Math.max(a, m.id), after) },
    poll,
  };
}

export async function postLiveChat(rt: Runtime, reg: LiveReg, body: Record<string, unknown>) {
  const ev = await getEvent(rt, reg.event_id);
  if (!ev) return { ok: false as const, error: ROOM_COPY.chatClosed };
  const now = Date.now();
  const stage = liveStage(ev, now, liveSettings(rt).offerHours);
  if (!(stage === 'waiting' || stage === 'live' || (stage === 'replay' && now < eventEnd(ev) + 30 * MIN))) return { ok: false as const, error: ROOM_COPY.chatClosed };
  if (await ticketGate(rt, reg)) return { ok: false as const, error: ROOM_COPY.ticketBody };
  const clean = sanitiseChat(body.text);
  if (!clean.ok) return { ok: false as const, error: clean.error };
  const db = rt.env.DB;
  const r = await db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM webinar_chat WHERE reg_id = ? AND session_id = ?').bind(reg.id, ev.id).first<{ n: number; last: number | null }>();
  const rate = chatRate(r?.n ?? 0, r?.last ?? null, now);
  if (!rate.ok) return { ok: false as const, error: rate.error };
  const lead = await getLead(rt.env, reg.lead_id);
  const name = viewerName(lead?.first_name, lead?.last_name, body.anon === true);
  const ins = await db.prepare("INSERT INTO webinar_chat (session_id, reg_id, lead_id, author, name, body, created_at, updated_at) VALUES (?, ?, ?, 'viewer', ?, ?, ?, ?)").bind(ev.id, reg.id, reg.lead_id, name, clean.text, now, now).run();
  return { ok: true as const, message: outMsg({ id: Number((ins.meta as { last_row_id?: number }).last_row_id ?? 0), author: 'viewer', name, body: clean.text, pinned_at: null, deleted_at: null, created_at: now }) };
}

export async function teamLiveChat(rt: Runtime, eventId: string, body: Record<string, unknown>) {
  if (!(await getEvent(rt, eventId))) return { ok: false as const, error: 'Event not found' };
  const text = plain(body.text, 400);
  if (!text) return { ok: false as const, error: 'Write a message first' };
  const { pickHostName } = await import('../webinar/live');
  const now = Date.now();
  await rt.env.DB.prepare("INSERT INTO webinar_chat (session_id, author, name, body, created_at, updated_at) VALUES (?, 'team', ?, ?, ?, ?)").bind(eventId, pickHostName(rt.settings, body.name), text, now, now).run();
  return { ok: true as const };
}

/** Join on Zoom: only inside the join window, only with a paid ticket when one is required. */
export async function joinZoom(rt: Runtime, reg: LiveReg) {
  const ev = await getEvent(rt, reg.event_id);
  const now = Date.now();
  const url = ev ? (await roomState(rt, ev, reg, now)).joinUrl : null;
  if (!ev || !url || (await ticketGate(rt, reg))) return { ok: false as const };
  await rt.env.DB.prepare('UPDATE live_webinar_regs SET zoom_clicked_at = COALESCE(zoom_clicked_at, ?), joined_at = COALESCE(joined_at, ?) WHERE id = ?').bind(now, now >= ev.starts_at ? now : null, reg.id).run();
  if (!reg.zoom_clicked_at) await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'live_joined', source: 'server', props: { event_id: ev.id }, localOnly: true }).catch(() => null);
  return { ok: true as const, url };
}

/** The deposit button in the room: only while the host's offer is open, $1M+ only. */
export async function roomDeposit(rt: Runtime, reg: LiveReg, body: Record<string, unknown>) {
  const ev = await getEvent(rt, reg.event_id);
  if (!ev) return { error: 'Session not found' };
  const now = Date.now();
  const w = offerWindow(ev, now, liveSettings(rt).offerHours);
  const { depositCopy, depositConfig, startDeposit } = await import('../sales/deposit');
  if (!w.open) return { error: depositCopy(depositConfig(rt)).closed };
  if (!isMillionPlus(reg.revenue_band)) return { error: depositCopy(depositConfig(rt)).underMillionBody };
  await rt.env.DB.prepare('UPDATE live_webinar_regs SET offer_clicked_at = COALESCE(offer_clicked_at, ?) WHERE id = ?').bind(now, reg.id).run();
  return startDeposit(rt, { leadId: reg.lead_id, source: 'live', refId: ev.id, regToken: reg.token, oneClick: body.one_click === true, returnUrl: liveWelcomeUrl(rt, reg.token) });
}

// ───────────── Funnel HQ ─────────────

/** Every event with its real counts. */
export async function listEvents(rt: Runtime) {
  const { results } = await rt.env.DB.prepare(
    `SELECT e.*,
       (SELECT COUNT(*) FROM live_webinar_regs r WHERE r.event_id = e.id) AS registered,
       (SELECT COUNT(*) FROM live_webinar_regs r WHERE r.event_id = e.id AND r.joined_at IS NOT NULL) AS attended,
       (SELECT peak_viewers FROM webinar_live_peaks k WHERE k.session_id = e.id) AS peak,
       (SELECT COUNT(*) FROM webinar_passes p WHERE p.kind = 'deposit' AND p.source = 'live' AND p.ref_id = e.id AND p.status = 'paid') AS deposits,
       (SELECT COALESCE(SUM(p.amount - p.refunded_amount), 0) FROM webinar_passes p WHERE p.source = 'live' AND p.ref_id = e.id AND p.status IN ('paid', 'refunded') AND p.kind IN ('deposit', 'live_ticket')) AS revenue
     FROM live_webinars e ORDER BY e.starts_at DESC LIMIT 100`,
  ).all<LiveEvent & Record<string, number>>();
  const s = liveSettings(rt);
  const now = Date.now();
  return results.map((e) => ({ ...e, stage: liveStage(e, now, s.offerHours), offer: offerWindow(e, now, s.offerHours), when: formatCallTime(e.starts_at, e.tz), consoleUrl: hostConsoleUrl(rt, e.id), streamKey: streamKey(e.id), showRate: e.registered ? e.attended / e.registered : null }));
}

/** One event: the report, registrants (with attendance and purchases) and deposit buyers. */
export async function eventReport(rt: Runtime, id: string) {
  const ev = await getEvent(rt, id);
  if (!ev) return null;
  const db = rt.env.DB;
  const now = Date.now();
  const s = liveSettings(rt);
  const [regs, passes, peak, presence, polls] = await db.batch([
    db.prepare(`SELECT r.*, l.first_name, l.last_name, l.email, l.phone FROM live_webinar_regs r JOIN leads l ON l.id = r.lead_id WHERE r.event_id = ? ORDER BY r.created_at DESC LIMIT 2000`).bind(id),
    db.prepare(`SELECT id, lead_id, kind, status, amount, currency, ticket_credit, refunded_amount, one_click, paid_at, created_at FROM webinar_passes WHERE source = 'live' AND ref_id = ? ORDER BY created_at DESC`).bind(id),
    db.prepare('SELECT peak_viewers, peak_at FROM webinar_live_peaks WHERE session_id = ?').bind(id),
    db.prepare("SELECT COUNT(*) AS n FROM webinar_presence WHERE session_id = ? AND kind = 'viewer' AND seen_at > ?").bind(id, now - PRESENCE_MS.viewer),
    db.prepare('SELECT * FROM live_webinar_polls WHERE event_id = ? ORDER BY opened_at DESC LIMIT 10').bind(id),
  ]);
  const rs = regs.results as (LiveReg & { first_name: string | null; last_name: string | null; email: string | null; phone: string | null })[];
  const ps = passes.results as { id: string; lead_id: string; kind: string; status: string; amount: number; currency: string; ticket_credit: number; refunded_amount: number; one_click: number; paid_at: number | null }[];
  const paidDeposits = ps.filter((p) => p.kind === 'deposit' && p.status === 'paid');
  const cur = (ps[0]?.currency ?? s.currency).toUpperCase();
  const revenue = ps.filter((p) => p.status === 'paid' || p.status === 'refunded').reduce((a, p) => a + p.amount - p.refunded_amount, 0);
  const w = offerWindow(ev, now, s.offerHours);
  const attended = rs.filter((r) => r.joined_at).length;
  const name = (r: { first_name: string | null; last_name: string | null; email: string | null }) => [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || 'Someone';
  const pollRows = [];
  for (const p of polls.results as { id: string; question: string; options: string; opened_at: number; closed_at: number | null }[]) {
    const options = JSON.parse(p.options) as string[];
    pollRows.push({ id: p.id, question: p.question, options, open: !p.closed_at, ...(await pollResults(rt, p.id, options.length)) });
  }
  return {
    event: { ...ev, when: formatCallTime(ev.starts_at, ev.tz), stage: liveStage(ev, now, s.offerHours), consoleUrl: hostConsoleUrl(rt, ev.id), streamKey: streamKey(ev.id), landing: `${liveBase(rt)}/live` },
    offer: { ...w, openedAt: ev.offer_opened_at, closedAt: ev.offer_closed_at, hours: ev.offer_hours ?? s.offerHours, timerOn: Boolean(ev.timer_on), pinned: ev.pinned },
    report: {
      registered: rs.length, ticketsPaid: ps.filter((p) => p.kind === 'live_ticket' && p.status === 'paid').length, attended, showRate: rs.length ? attended / rs.length : null,
      peak: (peak.results[0] as { peak_viewers?: number } | undefined)?.peak_viewers ?? 0, inRoomNow: (presence.results[0] as { n?: number } | undefined)?.n ?? 0,
      offerSeen: rs.filter((r) => r.offer_seen_at).length, offerClicked: rs.filter((r) => r.offer_clicked_at).length,
      deposits: paidDeposits.length, revenue: formatMoney(fromMinor(revenue, cur), cur), revenueMinor: revenue, currency: cur,
      depositRate: attended ? paidDeposits.length / attended : null,
    },
    registrants: rs.map((r) => {
      const bought = ps.find((p) => p.lead_id === r.lead_id && p.kind === 'deposit' && p.status === 'paid');
      return { id: r.id, lead_id: r.lead_id, name: name(r), email: r.email, band: REVENUE_LABEL[r.revenue_band ?? ''] ?? r.revenue_band, qualified: isMillionPlus(r.revenue_band), registered: r.created_at, joined: r.joined_at, zoom: r.zoom_clicked_at, offerSeen: r.offer_seen_at, offerClicked: r.offer_clicked_at, replay: r.replay_at, deposit: bought ? bought.paid_at : null, ticket: r.ticket_required ? ps.some((p) => p.lead_id === r.lead_id && p.kind === 'live_ticket' && p.status === 'paid') : null, texts: Boolean(r.sms_ok) };
    }),
    buyers: paidDeposits.map((p) => { const r = rs.find((x) => x.lead_id === p.lead_id); return { lead_id: p.lead_id, name: r ? name(r) : p.lead_id, band: r ? REVENUE_LABEL[r.revenue_band ?? ''] ?? r.revenue_band : null, paid: formatMoney(fromMinor(p.amount, p.currency), p.currency.toUpperCase()), credit: formatMoney(fromMinor(p.amount + p.ticket_credit, p.currency), p.currency.toUpperCase()), oneClick: Boolean(p.one_click), at: p.paid_at }; }),
    polls: pollRows,
  };
}

/** The ladder for the live funnel in a date range: registered → ticket → attended → saw the offer → deposit → signed engagement. */
export async function liveLadder(rt: Runtime, range: { from: number; to: number }) {
  const db = rt.env.DB;
  const r = await db.prepare(
    `SELECT COUNT(*) AS registered, SUM(r.joined_at IS NOT NULL) AS attended, SUM(r.offer_seen_at IS NOT NULL) AS offer_seen, SUM(r.offer_clicked_at IS NOT NULL) AS offer_clicked, COUNT(DISTINCT r.lead_id) AS people
       FROM live_webinar_regs r JOIN live_webinars e ON e.id = r.event_id WHERE e.starts_at BETWEEN ? AND ?`,
  ).bind(range.from, range.to).first<Record<string, number | null>>();
  const p = await db.prepare(
    `SELECT SUM(p.kind = 'live_ticket' AND p.status = 'paid') AS tickets, SUM(p.kind = 'deposit' AND p.status = 'paid') AS deposits,
            COALESCE(SUM(CASE WHEN p.status IN ('paid', 'refunded') THEN p.amount - p.refunded_amount ELSE 0 END), 0) AS revenue, MAX(p.currency) AS currency,
            COUNT(DISTINCT CASE WHEN p.kind = 'deposit' AND p.status = 'paid' AND EXISTS (SELECT 1 FROM contracts k WHERE k.lead_id = p.lead_id AND k.status = 'signed' AND COALESCE(k.is_test, 0) = 0) THEN p.lead_id END) AS signed
       FROM webinar_passes p JOIN live_webinars e ON e.id = p.ref_id WHERE p.source = 'live' AND e.starts_at BETWEEN ? AND ?`,
  ).bind(range.from, range.to).first<Record<string, number | string | null>>();
  const cur = String(p?.currency ?? liveSettings(rt).currency).toUpperCase();
  const reg = Number(r?.registered ?? 0);
  return {
    steps: [
      { key: 'registered', label: 'Registered', n: reg },
      { key: 'tickets', label: 'Paid ticket', n: Number(p?.tickets ?? 0), hidden: !liveSettings(rt).ticket && !Number(p?.tickets ?? 0) },
      { key: 'attended', label: 'Came live', n: Number(r?.attended ?? 0) },
      { key: 'offer_seen', label: 'Saw the offer', n: Number(r?.offer_seen ?? 0) },
      { key: 'offer_clicked', label: 'Pressed the deposit button', n: Number(r?.offer_clicked ?? 0) },
      { key: 'deposits', label: 'Paid the deposit', n: Number(p?.deposits ?? 0) },
      { key: 'signed', label: 'Signed the engagement', n: Number(p?.signed ?? 0) },
    ].filter((x) => !x.hidden),
    revenue: formatMoney(fromMinor(Number(p?.revenue ?? 0), cur), cur),
    perRegistrant: reg ? formatMoney(fromMinor(Number(p?.revenue ?? 0) / reg, cur), cur) : null,
  };
}

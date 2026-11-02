import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { hmacHex, safeEqual } from '../lib/crypto';
import { getSecret } from '../lib/secret';
import { newId, newRefCode } from '../lib/ids';
import { type RoomRow, getRoom, inviteUrl, isRoomId, makeInvite } from './rooms';

/**
 * General admission and co-host links per room (Funnel HQ → Rooms → Links).
 *
 *  - One shareable link per room: /rooms/:id/join/<signed slug>. Anyone can open it. Webinars ask for a first
 *    name, an email (unless "require email" is off), the revenue band (optional) and the existing, unticked SMS
 *    and call consent boxes. An event's room registers them for that event through the live funnel's own
 *    registerLive (lead, registration, attribution with the link's UTMs, confirmation emails, consent), then
 *    sends them to their personal room link. Other rooms create the lead and a personal invite for it.
 *    Meetings take a name (and an optional email) and join as a guest.
 *  - Safety: a joiner is always an attendee (webinar) or a guest (meeting), whatever they type. An email that
 *    already belongs to a lead this browser isn't linked to never logs anyone in as that person: the personal
 *    link goes to that inbox instead. Joins are limited per IP. Rotating the link stops the old one at once.
 *  - The co-host link: a signed invite with a chosen validity (the event day, 7 days, or until rotated);
 *    rotating stops every earlier co-host link for the room.
 */

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const JOINS_PER_IP_HOUR = 20;

export interface Admission { on: boolean; requireEmail: boolean; v: number; cohostV: number }
export function admissionOf(room: Pick<RoomRow, 'engage' | 'mode'>): Admission {
  let o: { ga?: Partial<Admission> } = {};
  try { o = JSON.parse(room.engage ?? '{}') ?? {}; } catch { o = {}; }
  const g = o.ga ?? {};
  return { on: typeof g.on === 'boolean' ? g.on : room.mode === 'webinar', requireEmail: g.requireEmail !== false, v: Number(g.v) || 0, cohostV: Number(g.cohostV) || 0 };
}
/** Saves the room's admission settings (merged into rooms.engage, next to the agenda). */
export async function saveAdmission(rt: Pick<Runtime, 'env'>, room: RoomRow, patch: Partial<Admission>) {
  let o: Record<string, unknown> = {};
  try { o = JSON.parse(room.engage ?? '{}') ?? {}; } catch { o = {}; }
  const ga = { ...admissionOf(room), ...patch };
  o.ga = ga;
  await rt.env.DB.prepare('UPDATE rooms SET engage = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(o), Date.now(), room.id).run();
  return ga;
}

const sig = async (rt: Pick<Runtime, 'env'>, roomId: string, v: number) => (await hmacHex(await getSecret(rt.env), `ga|${roomId}|${v}`)).slice(0, 16);
export async function joinUrl(rt: Pick<Runtime, 'env' | 'origin'>, room: Pick<RoomRow, 'id' | 'engage' | 'mode'>) {
  return `${rt.origin}/rooms/${room.id}/join/${await sig(rt, room.id, admissionOf(room).v)}`;
}
/** The link is this room's current one (a rotated link fails), and general admission is on. */
export async function checkJoin(rt: Pick<Runtime, 'env'>, room: Pick<RoomRow, 'id' | 'engage' | 'mode' | 'status'>, slug: unknown) {
  const a = admissionOf(room);
  if (!a.on || room.status === 'cancelled' || typeof slug !== 'string' || !/^[0-9a-f]{16}$/.test(slug)) return null;
  return safeEqual(await sig(rt, room.id, a.v), slug) ? a : null;
}
/** Tracked variants of the join link (UTMs on the link become the lead's attribution through the visitor's session). */
export function trackedJoin(url: string, utm: Record<string, unknown>) {
  const u = new URL(url);
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const v = typeof utm[k] === 'string' ? (utm[k] as string).replace(/[^\w.\- ]/g, '').trim().slice(0, 80) : '';
    if (v) u.searchParams.set(k, v);
  }
  return u.toString();
}

/** Co-host link with its validity: the event day (until 12 hours after the session ends), 7 days, or until rotated. */
export type CohostValidity = 'day' | '7d' | 'rotated';
export function cohostTtl(room: Pick<RoomRow, 'starts_at' | 'duration_min'>, validity: CohostValidity, now = Date.now()) {
  if (validity === '7d') return 7 * DAY;
  if (validity === 'rotated') return 365 * DAY;
  const end = room.starts_at ? room.starts_at + (room.duration_min || 60) * MIN + 12 * HOUR : now + DAY;
  return Math.max(HOUR, end - now);
}
export async function cohostUrl(rt: Pick<Runtime, 'env' | 'origin'>, room: RoomRow, validity: CohostValidity, now = Date.now()) {
  return inviteUrl(rt, room.id, await makeInvite(rt, room.id, 'cohost', null, cohostTtl(room, validity, now), now, { v: admissionOf(room).cohostV }));
}

// ───────────── joining ─────────────

async function overLimit(rt: Pick<Runtime, 'env'>, ip: string | null, now: number) {
  const key = `rjoin:${ip ?? 'unknown'}`;
  const row = await rt.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(key).first<{ value: string }>();
  let r = { n: 0, t: now };
  try { const p = JSON.parse(row?.value ?? '{}') as { n?: number; t?: number }; if (p.t && now - p.t < HOUR) r = { n: p.n ?? 0, t: p.t }; } catch { /* fresh */ }
  if (r.n >= JOINS_PER_IP_HOUR) return true;
  await rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify({ n: r.n + 1, t: r.t })).run();
  return false;
}

export const JOIN_COPY = {
  webinarHeading: 'Join the live session',
  webinarBody: 'Your name and email, and you are in. The summary of the session comes to that email.',
  meetingHeading: 'Join the meeting',
  meetingBody: 'Your name, and you are in. It runs in your browser, with no app to install.',
  firstName: 'First name',
  name: 'Your name',
  email: 'Email',
  emailOptional: 'Email (optional)',
  revenue: 'Your business’s annual revenue (optional)',
  revenueNone: 'Prefer not to say',
  phone: 'Mobile (optional)',
  button: 'Join now',
  privacy: 'We email you your room link, the replay and the summary of the session. Unsubscribe any time.',
  checkEmail: 'Check your email',
  checkEmailBody: 'That email address is already registered, so your personal room link went to it. Open the link in that email to join.',
  missingName: 'Please enter your name.',
  missingEmail: 'Please enter a valid email address.',
  tooMany: 'Too many joins from this connection. Please try again in an hour.',
  closed: 'This join link isn’t active',
  closedBody: 'Ask the host for the current link, or open the room from the personal link in your email.',
};

export type JoinResult = { redirect: string } | { checkEmail: true } | { error: string; field?: string; status: 400 | 403 | 409 | 429 };

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * One join from the general admission sheet. The role is fixed by the room (attendee or guest), never by the
 * form. Returns where to send the browser.
 */
export async function joinRoom(rt: Runtime, room: RoomRow, v: import('../lib/identity').VisitorCtx, body: Record<string, unknown>, a: Admission, now = Date.now()): Promise<JoinResult> {
  const name = clean(body.first_name ?? body.name, 60);
  if (!name) return { error: JOIN_COPY.missingName, field: 'first_name', status: 400 };
  const { validateEmail } = await import('../funnel/leads');
  const rawEmail = clean(body.email, 200);
  const email = rawEmail ? validateEmail(rawEmail) : null;
  if (rawEmail && (!email || email.disposable)) return { error: JOIN_COPY.missingEmail, field: 'email', status: 400 };
  if (room.mode === 'webinar' && a.requireEmail && !email) return { error: JOIN_COPY.missingEmail, field: 'email', status: 400 };
  if (await overLimit(rt, v.ip, now)) return { error: JOIN_COPY.tooMany, status: 429 };

  // An event's room: the live funnel's own registration (lead, registration, attribution, emails, consent).
  if (room.mode === 'webinar' && room.ref_type === 'live' && room.ref_id && email) {
    const { registerLive, liveRoomUrl } = await import('../live/events');
    try {
      const r = await registerLive(rt, v, { ...body, first_name: name, email: email.email, event_id: room.ref_id }, { admission: true });
      // A lead this browser doesn't own: the personal link is in their inbox (the confirmation email), never here.
      if (!r.reg.new_lead && v.leadId !== r.lead.id) return { checkEmail: true };
      return { redirect: liveRoomUrl(rt, r.reg.token) };
    } catch (e) {
      const err = e as { message?: string; field?: string; status?: number };
      if (err.status === 409 && err.field === 'email') return { checkEmail: true };
      return { error: err.message ?? JOIN_COPY.missingEmail, field: err.field, status: (err.status as 400 | 403 | 409) ?? 400 };
    }
  }

  // Other rooms: the lead (new, or this browser's own) gets a personal invite; nameless joins get a signed name-only pass.
  if (email) {
    const { getLeadByEmail, getLead, linkVisitor } = await import('../funnel/leads');
    let lead = await getLeadByEmail(rt.env, email.email);
    if (lead && v.leadId !== lead.id) {
      await emailPersonalLink(rt, room, lead);
      return { checkEmail: true };
    }
    if (!lead) {
      const { attributionFor } = await import('../funnel/application');
      const { APP_REVENUE_BAND } = await import('../sales/qualify');
      const { last, first } = await attributionFor(rt, v);
      const id = newId('l');
      const band = APP_REVENUE_BAND[String(body.revenue ?? '')] ?? null;
      await rt.env.DB.prepare(
        `INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, session_id, first_name, email, step_reached, status, channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
           click_id, click_type, ft_channel, ft_source, ft_campaign, ft_content, landing_path, variant, country, city, device, fbp, fbc, timezone, revenue_band)
         VALUES (?,?,?,?,?,?,?,?,0,'partial',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(id, newRefCode(), now, now, v.visitorId, v.sessionId, name.split(' ')[0], email.email,
        last?.channel ?? 'Direct', last?.utm_source ?? null, last?.utm_medium ?? null, last?.utm_campaign ?? null, last?.utm_content ?? null, last?.utm_term ?? null,
        last?.click_id ?? null, last?.click_type ?? null, first?.ft_channel ?? null, first?.ft_source ?? null, first?.ft_campaign ?? null, first?.ft_content ?? null,
        `/rooms/${room.id}/join`, v.variant, v.geo.country, v.geo.city, v.ua.device, v.fbp, v.fbc, v.geo.timezone, band).run();
      await linkVisitor(rt.env, v.visitorId, id);
      lead = (await getLead(rt.env, id))!;
      const { identityFromVisitor, track } = await import('../tracking/track');
      await track(rt, identityFromVisitor(v, null, id), { name: 'lead_captured', source: 'server', path: `/rooms/${room.id}/join`, props: { room_id: room.id, via: 'room_join' } }).catch(() => null);
    }
    const phone = typeof body.phone === 'string' && body.phone.trim() ? (await import('../funnel/leads')).normalisePhone(body.phone, v.geo.country) : null;
    await (await import('../integrations/call-consent')).recordCallConsent(rt, lead.id, phone, body, now).catch(() => null);
    return { redirect: inviteUrl(rt, room.id, await makeInvite(rt, room.id, 'guest', lead.id, 12 * HOUR, now)) };
  }
  // Name only (meetings, or webinars with "require email" off): a pass for this name, never staff.
  return { redirect: inviteUrl(rt, room.id, await makeInvite(rt, room.id, 'guest', null, 12 * HOUR, now, { n: name })) };
}

/** The personal room link, to the inbox that owns the address (once per room and lead). */
async function emailPersonalLink(rt: Runtime, room: RoomRow, lead: { id: string; email: string | null; first_name: string | null }) {
  if (!lead.email) return;
  const { sendOnce } = await import('../live/mail');
  const { safeFirstName } = await import('../lib/text');
  const url = inviteUrl(rt, room.id, await makeInvite(rt, room.id, 'guest', lead.id));
  const step = 200_000 + (Math.floor(room.created_at / 1000) % 1_000_000_000);
  await sendOnce(rt, lead, 'room', step, 'room_join_link', {
    subject: `Your link for ${room.title}`,
    preheader: 'Your personal room link is inside.',
    heading: room.title,
    paras: [`Hi ${safeFirstName(lead.first_name) ?? 'there'},`, 'Someone asked to join this session with your email address, so here is your personal link. If it wasn’t you, ignore this email.', 'This link is personal to you. Please don’t forward it.'],
    button: { label: 'Open my room', href: url },
  }).catch(() => null);
}

// ───────────── the pages ─────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const REVENUE = [['lt1m', 'Under $1M'], ['1_3m', '$1M – $3M'], ['3_10m', '$3M – $10M'], ['10_25m', '$10M – $25M'], ['25_50m', '$25M – $50M'], ['50_100m', '$50M – $100M'], ['gt100m', '$100M+']];
const page = (c: Context<AppEnv>, title: string, inner: string, status: 200 | 400 | 403 | 404 | 409 | 429 = 200) => {
  c.header('cache-control', 'no-store');
  c.header('content-security-policy', "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="stylesheet" href="/assets/room.css"></head><body class="rm-body"><main class="rm-entry rm-join">${inner}</main></body></html>`, status);
};

export async function joinSheet(_rt: Runtime, room: RoomRow, a: Admission, o: { error?: string; values?: Record<string, unknown>; action: string }) {
  const J = JOIN_COPY;
  const val = (k: string) => esc(typeof o.values?.[k] === 'string' ? (o.values[k] as string).slice(0, 200) : '');
  const webinar = room.mode === 'webinar';
  const { LANDING_COPY } = await import('../live/pages');
  const { WEBINAR_CALL_CONSENT } = await import('../integrations/call-consent');
  return `<p class="rm-eyebrow">${esc(room.title)}</p><h1 class="rm-h1">${esc(webinar ? J.webinarHeading : J.meetingHeading)}</h1><p class="rm-lede">${esc(webinar ? J.webinarBody : J.meetingBody)}</p>
<form method="post" action="${esc(o.action)}" class="rm-fields" novalidate>
  <label class="rm-field"><span>${esc(webinar ? J.firstName : J.name)}</span><input name="first_name" autocomplete="${webinar ? 'given-name' : 'name'}" maxlength="60" required value="${val('first_name')}"></label>
  <label class="rm-field"><span>${esc(webinar && a.requireEmail ? J.email : J.emailOptional)}</span><input name="email" type="email" autocomplete="email" maxlength="200"${webinar && a.requireEmail ? ' required' : ''} value="${val('email')}"></label>
  ${webinar ? `<label class="rm-field"><span>${esc(J.revenue)}</span><select name="revenue"><option value="">${esc(J.revenueNone)}</option>${REVENUE.map(([k, l]) => `<option value="${k}"${o.values?.revenue === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
  <label class="rm-field"><span>${esc(J.phone)}</span><input name="phone" type="tel" autocomplete="tel" inputmode="tel" maxlength="30" value="${val('phone')}"></label>
  <label class="rm-check"><input type="checkbox" name="sms_consent"> <span>${esc(LANDING_COPY.sms)}</span></label>
  <label class="rm-check"><input type="checkbox" name="call_consent"> <span>${esc(WEBINAR_CALL_CONSENT.text)}</span></label>` : ''}
  ${o.error ? `<p class="rm-err" role="alert">${esc(o.error)}</p>` : ''}
  <div class="rm-actions"><button type="submit" class="rm-primary">${esc(J.button)}</button></div>
  ${webinar ? `<p class="rm-fine">${esc(J.privacy)} <a class="rm-link" href="/privacy">Privacy policy</a>.</p>` : ''}
</form>`;
}

/** GET and POST /rooms/:id/join/:slug */
export async function joinPage(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const id = c.req.param('id') ?? '';
  const room = isRoomId(id) ? await getRoom(rt, id) : null;
  const a = room ? await checkJoin(rt, room, c.req.param('slug')) : null;
  // The panic button: a moved room's join link opens the join sheet of the room it moved to (src/rooms/panic.ts).
  if (room?.moved_to && a) { const to = await (await import('./panic')).movedJoinUrl(rt, room, c.req.url); if (to) return c.redirect(to, c.req.method === 'POST' ? 307 : 302); }
  if (!room || !a || room.status === 'ended') return page(c, JOIN_COPY.closed, `<h1 class="rm-h1">${esc(JOIN_COPY.closed)}</h1><p class="rm-lede">${esc(JOIN_COPY.closedBody)}</p>`, 404);
  const action = `/rooms/${room.id}/join/${c.req.param('slug')}`;
  if (c.req.method !== 'POST') return page(c, room.title, await joinSheet(rt, room, a, { action }));
  const o = c.req.header('origin');
  if (o && o !== new URL(c.req.url).origin) return c.text('Forbidden', 403);
  const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const body = Object.fromEntries(Object.entries(form).filter(([, v]) => typeof v === 'string')) as Record<string, unknown>;
  const r = await joinRoom(rt, room, c.get('visitor'), body, a);
  if ('redirect' in r) return c.redirect(r.redirect, 303);
  if ('checkEmail' in r) return page(c, JOIN_COPY.checkEmail, `<h1 class="rm-h1">${esc(JOIN_COPY.checkEmail)}</h1><p class="rm-lede">${esc(JOIN_COPY.checkEmailBody)}</p>`);
  return page(c, room.title, await joinSheet(rt, room, a, { action, error: r.error, values: body }), r.status);
}

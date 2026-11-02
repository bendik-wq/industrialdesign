import { type Context, Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { isAdmin, requireAdmin } from '../admin/auth';
import { getLead } from '../funnel/leads';
import { viewerName, pickHostName } from '../webinar/live';
import { newId } from '../lib/ids';
import { ROOM_COPY, ROOM_GATE, meetingInvite } from './copy';
import { SfuError, mintIceServers, realtimeSetup } from './sfu';
import { SFU_OPS } from './proxy';
import type { Identity } from './state';
import {
  type RoomRow, createRoom, getRoom, inviteUrl, isRoomId, listRooms, makeInvite, makeTicket, memberId, readInvite, readTicket, roomOffer, roomReport, ticketIdentity,
} from './rooms';

/**
 * Rooms on the web:
 *  - GET /rooms/:id?i=<invite>    co-host (signed link) or meeting guest (signed link for one lead)
 *  - GET /rooms/:id?c=<token>     challenge participant (their challenge token; the room must be one of their cohort's days)
 *  - GET /admin/rooms/:id         the host (admin session)
 *  - /live/room/:token renders the room for live events that run in our room (live/pages.ts → roomPageFor).
 *  - /api/rooms/:id/{ws,ice,sfu/:op,rec/...}: every call carries the room ticket minted into the page.
 *  - GET /rooms/replay/:recId     the recording (R2), with Range support.
 *  - /admin/api/rooms/*           Funnel HQ → Live webinars → Rooms.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export function roomMeta(rt: Pick<Runtime, 'origin'>, room: RoomRow) {
  const day = room.ref_type === 'challenge' ? Number(/:(\d)$/.exec(room.ref_id ?? '')?.[1]) : 0;
  return { id: room.id, mode: room.mode, title: room.title, startsAt: room.starts_at, offerAvailable: room.ref_type === 'live' || day === 4 || day === 5, origin: rt.origin };
}

const gatePage = (c: Context<AppEnv>, h: string, b: string, status: 200 | 403 | 404 = 403) =>
  c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(h)}</title><link rel="stylesheet" href="/assets/room.css"></head><body class="rm-body"><main class="rm-gate"><h1>${esc(h)}</h1><p>${esc(b)}</p></main></body></html>`, status);

/** The offer block attendees see when the host opens it (the live funnel's deposit, with the guarantee). */
async function offerPanel(rt: Runtime, o: { leadId: string; band: string | null; buy: string; token: string; day?: number; welcome?: string }) {
  const { depositQuote, depositCopy, guaranteeHtml } = await import('../sales/deposit');
  const { isMillionPlus } = await import('../sales/qualify');
  const q = await depositQuote(rt, o.leadId);
  const copy = depositCopy(q.cfg, { left: q.cap.left });
  if (!isMillionPlus(o.band)) return { html: `<section class="rm-offer" data-offer hidden><p class="rm-eyebrow">${esc(copy.eyebrow)}</p><h2 class="rm-offer-h">${esc(copy.underMillionHeading)}</h2><p>${esc(copy.underMillionBody)}</p></section>`, oneClick: null };
  const credit = q.credit ? `<p class="rm-fine">Today: ${esc(q.todayLabel)} (${esc(q.cfg.label)} less your ${esc(q.creditLabel ?? '')} ticket). The full ${esc(q.cfg.label)} is credited.</p>` : '';
  const html = `<section class="rm-offer" data-offer hidden aria-live="polite">
    <p class="rm-eyebrow">${esc(copy.eyebrow)}</p>
    <h2 class="rm-offer-h">${esc(copy.heading)}</h2>
    <p class="rm-price">${esc(copy.price)}</p>
    <p class="rm-note">${esc(copy.priceNote)}</p>
    <ul class="rm-secures">${copy.secures.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <p class="rm-fine">${esc(copy.fees)}</p>
    ${credit}
    ${q.paid ? `<p class="rm-ok">Your place is secured.${o.welcome ? ` <a href="${esc(o.welcome)}">What happens next</a>` : ''}</p>` : `<button type="button" class="rm-buy" data-buy>${esc(copy.button)}</button>`}
    ${copy.capLine ? `<p class="rm-fine">${esc(copy.capLine)}</p>` : ''}
    <p class="rm-closes"><span>${esc(copy.closes)}</span> <span data-offer-timer></span></p>
    <p class="rm-err" role="alert" data-buy-err hidden></p>
    <div class="rm-dialog" data-oneclick hidden role="dialog" aria-modal="true" aria-labelledby="rm-oc-h"><div class="rm-dialog-in">
      <h3 id="rm-oc-h">${esc(copy.oneClickHeading)}</h3>
      <p>${esc(copy.oneClickCharged(q.oneClick?.card ?? null))}</p>
      <button type="button" class="rm-buy" data-oc-confirm>${esc(copy.oneClickConfirm(q.todayLabel))}</button>
      <button type="button" class="rm-btn" data-oc-other>${esc(copy.otherCard)}</button>
      <button type="button" class="rm-x" data-oc-close aria-label="Close">×</button>
    </div></div>
    ${guaranteeHtml(rt)}
  </section>`;
  return { html, oneClick: q.oneClick && !q.paid ? q.oneClick : null };
}

export interface PageExtras { offer?: { leadId: string; band: string | null; buy: string; token: string; day?: number; welcome?: string } | null; back?: string | null }

/** The room page: config as JSON (not executed), drawn by room.js. */
export async function renderRoomPage(c: Context<AppEnv>, room: RoomRow, who: Identity, extras: PageExtras = {}) {
  const rt = runtimeFrom(c);
  if (room.status === 'cancelled') return gatePage(c, ROOM_GATE.ended, ROOM_COPY.endedBody, 200);
  const ticket = await makeTicket(rt, room.id, who);
  const offer = extras.offer ? await offerPanel(rt, extras.offer) : null;
  const setup = realtimeSetup(rt.settings as never);
  const cfg = {
    room: { id: room.id, mode: room.mode, title: room.title, startsAt: room.starts_at, kind: room.ref_type },
    me: { id: who.id, name: who.name, role: who.role, nameEditable: who.role === 'host' || who.role === 'cohost' },
    ticket, api: `/api/rooms/${room.id}`, ready: setup.ready, serverNow: Date.now(),
    offer: offer ? { buy: extras.offer!.buy, token: extras.offer!.token, day: extras.offer!.day ?? null, oneClick: offer.oneClick } : null,
    r2: Boolean(c.env.RECORDINGS), back: extras.back ?? null,
    copy: ROOM_COPY,
  };
  const json = JSON.stringify(cfg, (_k, v) => (typeof v === 'function' ? undefined : v)).replace(/</g, '\\u003c');
  const host = new URL(c.req.url).host;
  c.header('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss://${host} ws://${host}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
  c.header('cache-control', 'no-store');
  c.header('permissions-policy', 'camera=(self), microphone=(self), display-capture=(self), autoplay=(self)');
  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#ffffff">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<title>${esc(room.title)}</title>
<link rel="stylesheet" href="/assets/room.css">
<script defer src="/assets/room.js"></script>
</head>
<body class="rm-body">
<script type="application/json" id="room-config">${json}</script>
<div class="rm-app" data-room aria-live="polite"><noscript><p class="rm-gate">${esc(ROOM_COPY.noWebrtc)}</p></noscript></div>
${offer ? `<template id="room-offer">${offer.html}</template>` : ''}
</body>
</html>`);
}

/** Live events that run in our room: the attendee's existing /live/room/:token link opens it (called from live/pages.ts). */
export async function liveRoomPage(c: Context<AppEnv>, eventId: string, reg: { id: string; token: string; lead_id: string; revenue_band: string | null }, stage = 'live') {
  const rt = runtimeFrom(c);
  const { getEvent, liveWelcomeUrl } = await import('../live/events');
  const ev = await getEvent(rt, eventId);
  if (!ev) return null;
  const { ensureRoomFor } = await import('./rooms');
  const room = await ensureRoomFor(rt, 'live', ev.id, { title: ev.title, startsAt: ev.starts_at, durationMin: ev.duration_min });
  // After the session (or once the host ended it) the existing room page shows the replay; an overrunning live session stays here.
  if (room.status === 'ended' || (stage === 'replay' && room.status !== 'live')) return null;
  const lead = await getLead(rt.env, reg.lead_id);
  return renderRoomPage(c, room, { id: memberId('reg', reg.id), name: viewerName(lead?.first_name, lead?.last_name, false), role: 'attendee', leadId: reg.lead_id, regId: reg.id }, {
    offer: { leadId: reg.lead_id, band: reg.revenue_band, buy: '/api/live/deposit', token: reg.token, welcome: liveWelcomeUrl(rt, reg.token) },
  });
}

async function challengeIdentity(rt: Runtime, room: RoomRow, token: string) {
  if (room.ref_type !== 'challenge' || !room.ref_id) return null;
  const { getReg } = await import('../challenge/cohorts');
  const { parseEventKey } = await import('../challenge/schedule');
  const reg = await getReg(rt, token);
  const k = parseEventKey(room.ref_id);
  if (!reg || !k || reg.cohort_id !== k.cohortId || reg.status !== 'paid') return null;
  const lead = await getLead(rt.env, reg.lead_id);
  return {
    who: { id: memberId('reg', reg.id), name: viewerName(lead?.first_name, lead?.last_name, false), role: 'attendee' as const, leadId: reg.lead_id, regId: reg.id },
    offer: k.day >= 4 ? { leadId: reg.lead_id, band: reg.revenue_band, buy: '/api/challenge/deposit', token: reg.token, day: k.day } : null,
    back: `/challenge/day/${reg.token}/${k.day}`,
  };
}

/** GET /rooms/:id */
export async function publicRoomPage(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const room = await getRoom(rt, c.req.param('id') ?? '');
  if (!room) return gatePage(c, ROOM_GATE.notFound, ROOM_GATE.noAccessBody, 404);
  const i = c.req.query('i');
  if (i) {
    const inv = await readInvite(rt, i, room.id);
    if (!inv) return gatePage(c, ROOM_GATE.noAccess, ROOM_GATE.noAccessBody);
    if (inv.role === 'guest' && inv.lead) {
      const lead = await getLead(rt.env, inv.lead);
      const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(' ').slice(0, 60) || 'Guest';
      return renderRoomPage(c, room, { id: memberId('lead', inv.lead), name, role: room.mode === 'meeting' ? 'guest' : 'attendee', leadId: inv.lead, regId: null });
    }
    // Co-host (or an unnamed guest): a fresh id per browser visit; they type their name on the check screen.
    return renderRoomPage(c, room, { id: memberId('guest', newId('')), name: inv.role === 'cohost' ? 'Co-host' : 'Guest', role: inv.role, leadId: null, regId: null });
  }
  const ct = c.req.query('c');
  if (ct) {
    const x = await challengeIdentity(rt, room, ct);
    if (!x) return gatePage(c, ROOM_GATE.noAccess, ROOM_GATE.noAccessBody);
    return renderRoomPage(c, room, x.who, { offer: x.offer, back: x.back });
  }
  if (await isAdmin(c)) return c.redirect(`/admin/rooms/${room.id}`, 302);
  return gatePage(c, ROOM_GATE.noAccess, ROOM_GATE.noAccessBody);
}

/** GET /admin/rooms/:id (admin session): the host. */
export async function hostRoomPage(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const room = await getRoom(rt, c.req.param('id') ?? '');
  if (!room) return gatePage(c, ROOM_GATE.notFound, ROOM_GATE.noAccessBody, 404);
  return renderRoomPage(c, room, { id: memberId('host', 'admin'), name: pickHostName(rt.settings, null), role: 'host', leadId: null, regId: null }, { back: '/admin#liveevents' });
}

// ───────────── /api/rooms ─────────────

export const roomsApi = new Hono<AppEnv>();
const sameOrigin = (c: Context<AppEnv>) => {
  const o = c.req.header('origin');
  return !o || o === new URL(c.req.url).origin;
};
async function authed(c: Context<AppEnv>, token: unknown) {
  const rt = runtimeFrom(c);
  const id = c.req.param('id') ?? '';
  if (!isRoomId(id)) return null;
  const t = await readTicket(rt, token, id);
  if (!t) return null;
  const room = await getRoom(rt, id);
  return room ? { rt, room, t } : null;
}
function stub(c: Context<AppEnv>, roomId: string) {
  const ns = c.env.ROOMS;
  if (!ns) throw new SfuError('Rooms aren’t set up on this deployment (the ROOMS Durable Object binding).', 503);
  return ns.get(ns.idFromName(roomId));
}
const headersFor = (rt: Runtime, room: RoomRow, who: Identity) => ({ 'x-room-who': JSON.stringify(who), 'x-room-meta': JSON.stringify(roomMeta(rt, room)) });
const cleanName = (v: unknown) => (typeof v === 'string' ? v.replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) : '');

roomsApi.get('/:id/ws', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('Expected a WebSocket', 426);
  if (!sameOrigin(c)) return c.text('Forbidden', 403);
  const a = await authed(c, c.req.query('t'));
  if (!a) return c.text('Forbidden', 403);
  const who = ticketIdentity(a.t);
  // Hosts, co-hosts and nameless guests may set the name they show as on the check screen.
  const name = cleanName(c.req.query('name'));
  if (name && (who.role === 'host' || who.role === 'cohost' || (!who.leadId && who.role === 'guest'))) who.name = name;
  try {
    return await stub(c, a.room.id).fetch(new Request('https://room/ws', { headers: { upgrade: 'websocket', ...headersFor(a.rt, a.room, who) } }));
  } catch (e) { return c.text(e instanceof Error ? e.message : 'Unavailable', 503); }
});

roomsApi.post('/:id/ice', async (c) => {
  if (!sameOrigin(c)) return c.json({ ok: false }, 403);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const a = await authed(c, b.t);
  if (!a) return c.json({ ok: false, error: 'forbidden' }, 403);
  try {
    const r = await mintIceServers(a.rt.settings as never, 4 * 3600);
    c.header('cache-control', 'no-store');
    return c.json({ ok: true, ...r });
  } catch (e) { return c.json({ ok: false, error: e instanceof Error ? e.message : 'TURN unavailable' }, 502); }
});

roomsApi.post('/:id/sfu/:op', async (c) => {
  if (!sameOrigin(c)) return c.json({ ok: false }, 403);
  const op = c.req.param('op');
  if (!(SFU_OPS as string[]).includes(op)) return c.json({ ok: false, error: 'unknown' }, 404);
  const raw = await c.req.text();
  if (raw.length > 400_000) return c.json({ ok: false, error: 'too large' }, 413);
  let b: Record<string, unknown> = {};
  try { b = JSON.parse(raw) as Record<string, unknown>; } catch { return c.json({ ok: false, error: 'bad json' }, 400); }
  const a = await authed(c, b.t);
  if (!a) return c.json({ ok: false, error: 'forbidden' }, 403);
  delete b.t;
  try {
    return await stub(c, a.room.id).fetch(new Request(`https://room/sfu/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headersFor(a.rt, a.room, ticketIdentity(a.t)) }, body: JSON.stringify(b) }));
  } catch (e) { return c.json({ ok: false, error: e instanceof Error ? e.message : 'Unavailable' }, 503); }
});

// ── recordings (host and co-hosts): R2 multipart upload in parts of 5 MB or more ──

const staffTicket = (t: { role: string }) => t.role === 'host' || t.role === 'cohost';

roomsApi.post('/:id/rec/start', async (c) => {
  if (!sameOrigin(c)) return c.json({ ok: false }, 403);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const a = await authed(c, b.t);
  if (!a || !staffTicket(a.t)) return c.json({ ok: false, error: 'forbidden' }, 403);
  const bucket = c.env.RECORDINGS;
  if (!bucket) return c.json({ ok: true, local: true });
  const mime = typeof b.mime === 'string' && /^video\/(webm|mp4)(;[\w=,.\s-]*)?$/.test(b.mime) ? b.mime : 'video/webm';
  const id = newId('rec').toLowerCase();
  const key = `rooms/${a.room.id}/${id}.${mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
  const up = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: mime.split(';')[0] } });
  await a.rt.env.DB.prepare('INSERT INTO room_recordings (id, room_id, r2_key, upload_id, mime, started_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, a.room.id, key, up.uploadId, mime, Date.now()).run();
  return c.json({ ok: true, id, partSize: 5 * 1024 * 1024 });
});

async function recRow(c: Context<AppEnv>, roomId: string) {
  return c.env.DB.prepare('SELECT * FROM room_recordings WHERE id = ? AND room_id = ?').bind(c.req.param('rid') ?? '', roomId)
    .first<{ id: string; room_id: string; r2_key: string; upload_id: string; mime: string; status: string; parts: number; bytes: number }>();
}

roomsApi.put('/:id/rec/:rid/part/:n{[0-9]{1,5}}', async (c) => {
  if (!sameOrigin(c)) return c.json({ ok: false }, 403);
  const a = await authed(c, c.req.query('t'));
  if (!a || !staffTicket(a.t) || !c.env.RECORDINGS) return c.json({ ok: false, error: 'forbidden' }, 403);
  const rec = await recRow(c, a.room.id);
  if (!rec || rec.status !== 'recording') return c.json({ ok: false, error: 'not found' }, 404);
  const n = Number(c.req.param('n'));
  if (!(n >= 1 && n <= 10_000)) return c.json({ ok: false, error: 'bad part' }, 400);
  const body = await c.req.arrayBuffer();
  if (!body.byteLength || body.byteLength > 95 * 1024 * 1024) return c.json({ ok: false, error: 'bad size' }, 413);
  const part = await c.env.RECORDINGS.resumeMultipartUpload(rec.r2_key, rec.upload_id).uploadPart(n, body);
  await c.env.DB.prepare('UPDATE room_recordings SET parts = MAX(parts, ?), bytes = bytes + ? WHERE id = ?').bind(n, body.byteLength, rec.id).run();
  return c.json({ ok: true, part: { partNumber: part.partNumber, etag: part.etag } });
});

roomsApi.post('/:id/rec/:rid/complete', async (c) => {
  if (!sameOrigin(c)) return c.json({ ok: false }, 403);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const a = await authed(c, b.t);
  if (!a || !staffTicket(a.t) || !c.env.RECORDINGS) return c.json({ ok: false, error: 'forbidden' }, 403);
  const rec = await recRow(c, a.room.id);
  if (!rec) return c.json({ ok: false, error: 'not found' }, 404);
  const parts = (Array.isArray(b.parts) ? b.parts : []).filter((p): p is { partNumber: number; etag: string } => Boolean(p && typeof p.partNumber === 'number' && typeof p.etag === 'string'));
  if (!parts.length) return c.json({ ok: false, error: 'no parts' }, 400);
  try {
    await c.env.RECORDINGS.resumeMultipartUpload(rec.r2_key, rec.upload_id).complete(parts.sort((x, y) => x.partNumber - y.partNumber));
  } catch (e) {
    await c.env.DB.prepare("UPDATE room_recordings SET status = 'failed', ended_at = ? WHERE id = ?").bind(Date.now(), rec.id).run();
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'upload failed' }, 502);
  }
  const now = Date.now();
  const url = `${a.rt.origin}/rooms/replay/${rec.id}`;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE room_recordings SET status = 'ready', ended_at = ? WHERE id = ?").bind(now, rec.id),
    c.env.DB.prepare('UPDATE rooms SET replay_url = ?, updated_at = ? WHERE id = ?').bind(url, now, a.room.id),
  ]);
  // The recording becomes the event's replay (only when nobody pasted one already).
  if (a.room.ref_type === 'live' && a.room.ref_id) await c.env.DB.prepare('UPDATE live_webinars SET replay_url = COALESCE(replay_url, ?), updated_at = ? WHERE id = ?').bind(url, now, a.room.ref_id).run();
  if (a.room.ref_type === 'challenge' && a.room.ref_id) {
    const m = /^challenge:([^:]+):(\d)$/.exec(a.room.ref_id);
    if (m) await c.env.DB.prepare('UPDATE challenge_days SET replay_url = COALESCE(replay_url, ?), updated_at = ? WHERE cohort_id = ? AND day = ?').bind(url, now, m[1], Number(m[2])).run();
  }
  return c.json({ ok: true, url });
});

/** GET /rooms/replay/:rid: the recording, streamed from R2 with Range support (Safari needs 206 responses). */
export async function replayRoute(c: Context<AppEnv>) {
  const rid = c.req.param('rid') ?? '';
  if (!/^rec[a-z0-9]{8,40}$/.test(rid) || !c.env.RECORDINGS) return c.notFound();
  const rec = await c.env.DB.prepare("SELECT r2_key, mime FROM room_recordings WHERE id = ? AND status = 'ready'").bind(rid).first<{ r2_key: string; mime: string }>();
  if (!rec) return c.notFound();
  const range = c.req.header('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  const obj = m && (m[1] || m[2])
    ? await c.env.RECORDINGS.get(rec.r2_key, { range: m[1] ? { offset: Number(m[1]), ...(m[2] ? { length: Number(m[2]) - Number(m[1]) + 1 } : {}) } : { suffix: Number(m[2]) } })
    : await c.env.RECORDINGS.get(rec.r2_key);
  if (!obj || !('body' in obj)) return c.notFound();
  const headers = new Headers({ 'content-type': rec.mime.split(';')[0], 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600', 'x-robots-tag': 'noindex' });
  if (m && obj.range && 'offset' in obj.range) {
    const off = obj.range.offset ?? 0;
    const len = obj.range.length ?? obj.size - off;
    headers.set('content-range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    headers.set('content-length', String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

// ───────────── Funnel HQ: /admin/api/rooms ─────────────

export const roomsAdmin = new Hono<AppEnv>();
roomsAdmin.use('*', requireAdmin);

roomsAdmin.get('/', async (c) => {
  const rt = runtimeFrom(c);
  const setup = realtimeSetup(rt.settings as never);
  const todo = [...setup.todo];
  if (!c.env.ROOMS) todo.push('The ROOMS Durable Object binding is missing from this deployment. Deploy with the current wrangler.jsonc.');
  if (!c.env.RECORDINGS) todo.push('Optional: create the R2 bucket gl-room-recordings and bind it as RECORDINGS (wrangler.jsonc) so host recordings upload and become the replay. Until then they download to the host’s computer.');
  return c.json({ rooms: await listRooms(rt), setup: { ...setup, durableObject: Boolean(c.env.ROOMS), r2: Boolean(c.env.RECORDINGS) }, todo });
});

roomsAdmin.post('/', async (c) => {
  const rt = runtimeFrom(c);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const leadId = typeof b.lead_id === 'string' && b.lead_id ? b.lead_id : null;
  const lead = leadId ? await getLead(rt.env, leadId) : null;
  if (leadId && !lead) return c.json({ ok: false, error: 'Lead not found' }, 404);
  const kinds: Record<string, string> = { onboarding: 'Onboarding call', kickoff: 'Kickoff', weekly: 'Weekly working session', other: 'Meeting' };
  const kind = typeof b.kind === 'string' && kinds[b.kind] ? b.kind : 'other';
  const who = lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') : '';
  const title = (typeof b.title === 'string' && b.title.trim() ? b.title.trim() : `${kinds[kind]}${who ? ` with ${who}` : ''}`).replace(/[<>]/g, '').slice(0, 140);
  const startsAt = b.starts_at == null || b.starts_at === '' ? null : Number(b.starts_at);
  if (startsAt !== null && (!Number.isFinite(startsAt) || startsAt < Date.now() - 86_400_000)) return c.json({ ok: false, error: 'Pick a start time in the future' }, 400);
  const mode = b.mode === 'webinar' ? 'webinar' : 'meeting';
  const room = await createRoom(rt, { mode, title, refType: lead ? 'lead' : 'none', leadId, startsAt, durationMin: Math.min(240, Math.max(15, Number(b.duration_min) || 60)), createdBy: 'admin' });
  let emailed = false;
  let guestUrl: string | null = null;
  if (lead) {
    guestUrl = inviteUrl(rt, room.id, await makeInvite(rt, room.id, 'guest', lead.id));
    if (b.email !== false) emailed = await emailInvite(rt, room, lead, guestUrl);
  }
  return c.json({ ok: true, room, hostUrl: `${rt.origin}/admin/rooms/${room.id}`, guestUrl, emailed });
});

async function emailInvite(rt: Runtime, room: RoomRow, lead: NonNullable<Awaited<ReturnType<typeof getLead>>>, url: string) {
  if (!lead.email) return false;
  const { sendOnce } = await import('../live/mail');
  const { formatCallTime } = await import('../integrations/email');
  const { safeFirstName } = await import('../lib/text');
  const when = room.starts_at ? formatCallTime(room.starts_at, lead.timezone || rt.settings.SALES_TIMEZONE || 'Australia/Sydney') : null;
  const mail = meetingInvite({ name: safeFirstName(lead.first_name) ?? 'there', title: room.title, when, url, host: 'Josh’s team' });
  // A fresh step per room, so each invite sends once.
  const step = 100_000 + (Math.floor(room.created_at / 1000) % 1_000_000_000);
  // 'Emailed' only when it really went out (without Resend connected the send is recorded as simulated).
  const { emailConfigured } = await import('../integrations/email');
  return (await sendOnce(rt, lead, 'room', step, 'room_invite', mail)) && emailConfigured(rt);
}

roomsAdmin.get('/:id', async (c) => {
  const r = await roomReport(runtimeFrom(c), c.req.param('id'));
  return r ? c.json(r) : c.json({ error: 'Room not found' }, 404);
});

/** Links for a room: the co-host link (anyone holding it joins backstage) and, for meetings with a lead, the guest link. */
roomsAdmin.post('/:id/links', async (c) => {
  const rt = runtimeFrom(c);
  const room = await getRoom(rt, c.req.param('id'));
  if (!room) return c.json({ error: 'Room not found' }, 404);
  const cohost = inviteUrl(rt, room.id, await makeInvite(rt, room.id, 'cohost', null, 2 * 86_400_000));
  const guest = room.lead_id ? inviteUrl(rt, room.id, await makeInvite(rt, room.id, 'guest', room.lead_id)) : null;
  return c.json({ ok: true, cohost, guest, host: `${rt.origin}/admin/rooms/${room.id}` });
});

roomsAdmin.post('/:id/email', async (c) => {
  const rt = runtimeFrom(c);
  const room = await getRoom(rt, c.req.param('id'));
  if (!room?.lead_id) return c.json({ ok: false, error: 'This room has no guest' }, 400);
  const lead = await getLead(rt.env, room.lead_id);
  if (!lead) return c.json({ ok: false, error: 'Lead not found' }, 404);
  const url = inviteUrl(rt, room.id, await makeInvite(rt, room.id, 'guest', lead.id));
  return c.json({ ok: await emailInvite(rt, { ...room, created_at: Date.now() }, lead, url) });
});

roomsAdmin.post('/:id/cancel', async (c) => {
  const rt = runtimeFrom(c);
  await rt.env.DB.prepare("UPDATE rooms SET status = 'cancelled', updated_at = ? WHERE id = ? AND ref_type IN ('lead', 'none')").bind(Date.now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

/** The room's live state (count, stage) for Funnel HQ, read from the Durable Object. */
roomsAdmin.get('/:id/live', async (c) => {
  const rt = runtimeFrom(c);
  const room = await getRoom(rt, c.req.param('id'));
  if (!room || !c.env.ROOMS) return c.json({ count: null });
  const res = await stub(c, room.id).fetch(new Request('https://room/info', { headers: headersFor(rt, room, { id: 'hq', name: 'HQ', role: 'host' }) }));
  return c.json(await res.json());
});

export { roomOffer };

/** Which room (if any) a host-console key runs in: live events and challenge days set to platform 'room'. */
export async function roomForKey(rt: Runtime, key: string, create = false) {
  const { ensureRoomFor, roomForRef } = await import('./rooms');
  const live = /^webinar:(.+)$/.exec(key);
  if (live) {
    const ev = await rt.env.DB.prepare('SELECT id, title, starts_at, duration_min, platform FROM live_webinars WHERE id = ?').bind(live[1]).first<{ id: string; title: string; starts_at: number; duration_min: number; platform: string }>();
    if (!ev || ev.platform !== 'room') return null;
    return create ? ensureRoomFor(rt, 'live', ev.id, { title: ev.title, startsAt: ev.starts_at, durationMin: ev.duration_min }) : roomForRef(rt, 'live', ev.id);
  }
  const ch = /^challenge:([^:]+):(\d)$/.exec(key);
  if (ch) {
    const d = await rt.env.DB.prepare('SELECT d.starts_at, d.duration_min, d.platform, c.name FROM challenge_days d JOIN challenge_cohorts c ON c.id = d.cohort_id WHERE d.cohort_id = ? AND d.day = ?').bind(ch[1], Number(ch[2])).first<{ starts_at: number; duration_min: number; platform: string; name: string }>();
    if (!d || d.platform !== 'room') return null;
    return create ? ensureRoomFor(rt, 'challenge', key, { title: `The First Deal Challenge, Day ${ch[2]} (${d.name})`.slice(0, 200), startsAt: d.starts_at, durationMin: d.duration_min }) : roomForRef(rt, 'challenge', key);
  }
  return null;
}

/** GET /admin/live/:key/room: the host console's "Open host room" (creates the room on first use). */
export async function hostRoomForKey(c: Context<AppEnv>) {
  const room = await roomForKey(runtimeFrom(c), c.req.param('key') ?? '', true);
  return room ? c.redirect(`/admin/rooms/${room.id}`, 302) : c.text('This event runs on Zoom. Switch it to our room in Funnel HQ first.', 404);
}

/** /challenge/join/:token/:n for a day that runs in our room: straight into the room (attendance comes from the room itself). */
export async function challengeJoinRoom(rt: Runtime, reg: { token: string; cohort_id: string; status: string }, day: number) {
  if (reg.status !== 'paid') return null;
  const room = await roomForKey(rt, `challenge:${reg.cohort_id}:${day}`, true);
  return room ? `/rooms/${room.id}?c=${encodeURIComponent(reg.token)}` : null;
}

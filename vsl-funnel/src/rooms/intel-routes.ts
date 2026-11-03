import { type Context, Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { getLead } from '../funnel/leads';
import { viewerName } from '../webinar/live';
import type { Identity } from './state';
import { ROOM_GATE } from './copy';
import { ENGAGE_COPY, assetById } from './engage';
import { type RoomRow, getRoom, isRoomId, makeTicket, memberId, readTicket, roomForRef, roomOffer, ticketIdentity } from './rooms';
import { INTEL_COPY, cardsAt, chaptersFrom, parseRoomEdition, stamp, toVtt } from './intel';
import {
  buildDebrief, getDebrief, heatmap, intelConfig, listClips, mainRecording, postToCommand, publishEdition, queueTranscription, recDuration, replayPing, restartTranscription, roomEditionFor,
  saveClip, suggestClips, timeline, transcribeFor,
} from './intel-db';

/**
 * Rooms intel on the web (area D):
 *  - /admin/api/intel/*                Funnel HQ → Rooms → Debrief (timeline, heatmap, transcript, debrief, clips, simulive edition) and Content → Clips
 *  - GET /rooms/replay/:rid/captions.vtt  the transcript as captions for the replay player
 *  - the replay page: /live/room/:token after a live event (live/pages.ts), /rooms/:id?c=<token> after a challenge day,
 *    /admin/rooms/:id/replay for the team
 *  - /api/intel/:id/replay/*            the replay page's pings (minutes, points, attribution), its cards and the offer's state
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const gate = (c: Context<AppEnv>, h: string, b: string, status: 200 | 403 | 404 = 404) =>
  c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(h)}</title><link rel="stylesheet" href="/assets/glass.css"><link rel="stylesheet" href="/assets/room.css"></head><body class="rm-body"><main class="rm-gate"><h1>${esc(h)}</h1><p>${esc(b)}</p></main></body></html>`, status);

// ───────────── the replay page ─────────────

export interface ReplayExtras { offer?: { leadId: string; band: string | null; buy: string; token: string; day?: number; welcome?: string } | null; back?: string | null; preview?: boolean }

function dateLabel(t: number, tz: string) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(t); } catch { return new Date(t).toDateString(); }
}

/** The replay of a room: the recording with chapters, the searchable transcript, captions, the cards at their live moments, the offer while it is open. */
export async function renderReplayPage(c: Context<AppEnv>, room: RoomRow, who: Identity, extras: ReplayExtras = {}) {
  const rt = runtimeFrom(c);
  const t = await timeline(rt, room);
  if (!t.rec) return null;
  const d = (await getDebrief(rt, room.id))?.debrief;
  const chapters = d?.chapters?.length ? d.chapters : chaptersFrom(t.marks, t.lines, t.rec.durationMs);
  const offer = await roomOffer(rt, room).catch(() => ({ available: false, open: false, closesAt: null, label: null }));
  let offerHtml = '';
  let oneClick: unknown = null;
  if (extras.offer && offer.open) {
    const { offerPanel } = await import('./routes');
    const p = await offerPanel(rt, extras.offer);
    offerHtml = p.html; oneClick = p.oneClick;
  }
  const ticket = await makeTicket(rt, room.id, who);
  const tz = (c.get('visitor') as { geo?: { timezone?: string | null } } | undefined)?.geo?.timezone || rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
  const cfg = {
    room: { id: room.id, title: room.title, kind: room.ref_type },
    api: `/api/intel/${room.id}/replay`, roomApi: `/api/rooms/${room.id}`, ticket, preview: Boolean(extras.preview),
    rec: { url: t.rec.url, vtt: t.lines.length ? t.rec.vtt : null, mime: t.rec.mime.split(';')[0], durationMs: t.rec.durationMs },
    recordedOn: dateLabel(room.went_live_at ?? t.rec.startedAt, tz),
    chapters: chapters.map((x) => ({ ms: x.ms, title: x.title, at: stamp(x.ms) })),
    lines: t.lines.map((l) => ({ s: l.start_ms, e: l.end_ms, w: l.speaker ?? null, x: l.text })),
    transcriptSource: t.transcriptSource,
    pushes: t.pushes.map((p) => ({ id: p.id, kind: p.kind, ref: p.ref, at: p.atMs, until: p.untilMs, title: p.kind === 'resource' ? assetById(p.ref)?.title ?? null : null })),
    offer: { open: offer.open, closesAt: offer.closesAt, buy: extras.offer?.buy ?? null, token: extras.offer?.token ?? null, day: extras.offer?.day ?? null, oneClick },
    points: intelConfig(rt).replayPoints,
    lead: Boolean(who.leadId),
    back: extras.back ?? null,
    serverNow: Date.now(),
    copy: Object.fromEntries(Object.entries(INTEL_COPY).map(([k, v]) => [k, typeof v === 'function' ? (v as (a: unknown) => string)('{a}') : v])),
    engageCopy: { sprintEyebrow: ENGAGE_COPY.sprintEyebrow },
  };
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  c.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  c.header('cache-control', 'no-store');
  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#ffffff">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<title>${esc(`${INTEL_COPY.replayEyebrow}: ${room.title}`)}</title>
<link rel="stylesheet" href="/assets/glass.css"><link rel="stylesheet" href="/assets/room.css">
<link rel="stylesheet" href="/assets/intel.css">
<script defer src="/assets/intel-replay.js"></script>
</head>
<body class="rm-body ix-body">
<script type="application/json" id="replay-config">${json}</script>
<main class="ix-replay" data-replay>
  <header class="ix-head">
    <p class="rm-eyebrow">${esc(INTEL_COPY.replayEyebrow)}</p>
    <h1 class="ix-h1">${esc(room.title)}</h1>
    <p class="ix-sub">${esc(INTEL_COPY.replayRecorded(cfg.recordedOn))} ${esc(INTEL_COPY.replayNote)}</p>
  </header>
  <noscript><p><a href="${esc(t.rec.url)}">${esc(INTEL_COPY.replayEyebrow)}</a></p></noscript>
</main>
${offerHtml ? `<template id="room-offer">${offerHtml}</template>` : ''}
</body>
</html>`);
}

/** /live/room/:token after a live event that ran in our room (called from live/pages.ts): the replay, when the room has a recording. */
export async function liveReplayPage(c: Context<AppEnv>, eventId: string, reg: { id: string; token: string; lead_id: string; revenue_band: string | null }) {
  const rt = runtimeFrom(c);
  const room = await roomForRef(rt, 'live', eventId);
  if (!room || room.status === 'live' || !(await mainRecording(rt, room.id))) return null;
  const lead = await getLead(rt.env, reg.lead_id);
  const { liveWelcomeUrl } = await import('../live/events');
  return renderReplayPage(c, room, { id: memberId('reg', reg.id), name: viewerName(lead?.first_name, lead?.last_name, false), role: 'attendee', leadId: reg.lead_id, regId: reg.id }, {
    offer: { leadId: reg.lead_id, band: reg.revenue_band, buy: '/api/live/deposit', token: reg.token, welcome: liveWelcomeUrl(rt, reg.token) },
  });
}

/** /rooms/:id?c=<token> once a challenge day has ended (called from routes.ts). */
export async function challengeReplayPage(c: Context<AppEnv>, room: RoomRow, x: { who: Identity; offer: ReplayExtras['offer']; back: string | null }) {
  return renderReplayPage(c, room, x.who, { offer: x.offer, back: x.back });
}

/** GET /admin/rooms/:id/replay: the team's view of the replay page (preview: no points, no attribution). */
export async function adminReplayPage(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const room = await getRoom(rt, c.req.param('id') ?? '');
  if (!room) return gate(c, ROOM_GATE.notFound, ROOM_GATE.noAccessBody);
  const page = await renderReplayPage(c, room, { id: memberId('host', 'preview'), name: 'Team preview', role: 'host', leadId: null, regId: null }, { preview: true, back: '/admin#rooms' });
  return page ?? gate(c, ROOM_GATE.ended, INTEL_COPY.noRecording, 404);
}

/** GET /rooms/replay/:rid/captions.vtt */
export async function captionsRoute(c: Context<AppEnv>) {
  const rid = c.req.param('rid') ?? '';
  if (!/^rec[a-z0-9]{8,40}$/.test(rid)) return c.notFound();
  const rows = await c.env.DB.prepare('SELECT start_ms, end_ms, speaker, text FROM room_transcript WHERE rec_id = ? ORDER BY start_ms LIMIT 20000').bind(rid).all<{ start_ms: number; end_ms: number; speaker: string | null; text: string }>();
  return new Response(toVtt(rows.results), { headers: { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'private, max-age=300', 'x-robots-tag': 'noindex' } });
}

// ───────────── /api/intel: the replay page's calls ─────────────

export const intelApi = new Hono<AppEnv>();
const sameOrigin = (c: Context<AppEnv>) => { const o = c.req.header('origin'); return !o || o === new URL(c.req.url).origin; };
async function authed(c: Context<AppEnv>, token: unknown) {
  const rt = runtimeFrom(c);
  const id = c.req.param('id') ?? '';
  if (!isRoomId(id)) return null;
  const t = await readTicket(rt, token, id);
  const room = t ? await getRoom(rt, id) : null;
  return t && room ? { rt, room, t } : null;
}

intelApi.post('/:id/replay/ping', async (c) => {
  if (!sameOrigin(c)) return c.json({ ok: false }, 403);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const a = await authed(c, b.t);
  if (!a) return c.json({ ok: false, error: 'forbidden' }, 403);
  if (a.t.role === 'host' || a.t.role === 'cohost') return c.json({ ok: true, preview: true });
  const rec = await mainRecording(a.rt, a.room.id);
  if (!rec) return c.json({ ok: false, error: 'no recording' }, 404);
  const w = ticketIdentity(a.t);
  return c.json(await replayPing(a.rt, a.room, { id: w.id, leadId: w.leadId ?? null, regId: w.regId ?? null }, b, recDuration(rec)));
});

/** The offer's real state (polled each minute): the replay's deposit card closes with it. */
intelApi.post('/:id/replay/state', async (c) => {
  if (!sameOrigin(c)) return c.json({ ok: false }, 403);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const a = await authed(c, b.t);
  if (!a) return c.json({ ok: false, error: 'forbidden' }, 403);
  const o = await roomOffer(a.rt, a.room).catch(() => null);
  c.header('cache-control', 'no-store');
  return c.json({ ok: true, offer: o ? { open: o.open, closesAt: o.closesAt } : { open: false, closesAt: null }, now: Date.now() });
});

/** A card's action in the replay: a resource shared live is theirs (granted like in the room), the application link. */
intelApi.post('/:id/replay/card', async (c) => {
  if (!sameOrigin(c)) return c.json({ ok: false }, 403);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const a = await authed(c, b.t);
  if (!a) return c.json({ ok: false, error: 'forbidden' }, 403);
  const pid = Number(b.pid);
  const t = await timeline(a.rt, a.room);
  const rec = t.rec;
  const p = t.pushes.find((x) => x.id === pid);
  if (!p || !rec || !cardsAt(t.pushes, Number(b.pos) || p.atMs, { offerOpen: true }).some((x) => x.id === pid)) return c.json({ ok: false, error: 'not_found' }, 404);
  const w = ticketIdentity(a.t);
  const { logEvents } = await import('./intel-db');
  await logEvents(a.rt.env, a.room.id, [{ at: Date.now(), kind: 'replay_card', who: w.id, name: w.name, text: p.kind, data: { pid } }]).catch(() => null);
  if (p.kind === 'resource' && p.ref && w.role === 'attendee') {
    const { grantUnlocks, assetUrl } = await import('./engage-db');
    await grantUnlocks(a.rt, a.room, { id: w.id, name: w.name, leadId: w.leadId, regId: w.regId }, [p.ref], 'push').catch(() => null);
    return c.json({ ok: true, url: await assetUrl(a.rt, a.room.id, w.id, p.ref) });
  }
  if (p.kind === 'application') return c.json({ ok: true, url: `${a.rt.origin}/apply` });
  return c.json({ ok: true });
});

// ───────────── Funnel HQ: /admin/api/intel ─────────────

export const intelAdmin = new Hono<AppEnv>();
intelAdmin.use('*', requireAdmin);

async function roomOr404(c: Context<AppEnv>) { return getRoom(runtimeFrom(c), c.req.param('id') ?? ''); }

/** Everything the Debrief panel draws: the job, the heatmap, the transcript, the debrief, the clips, the edition. */
intelAdmin.get('/rooms/:id', async (c) => {
  const rt = runtimeFrom(c);
  const room = await roomOr404(c);
  if (!room) return c.json({ ok: false, error: 'Room not found' }, 404);
  const t = await timeline(rt, room);
  const deb = await getDebrief(rt, room.id);
  const ed = parseRoomEdition((rt.settings as unknown as Record<string, string>).WEBINAR_ROOM_EDITION);
  const { claudeReady } = await import('../ops/claude');
  return c.json({
    ok: true,
    room: t.room, origin: t.origin, durationMs: t.durationMs, rec: t.rec, job: t.job, transcriptSource: t.transcriptSource,
    replayUrl: t.rec ? `${rt.origin}/admin/rooms/${room.id}/replay` : null,
    heat: heatmap(t),
    lines: t.lines,
    chapters: deb?.debrief.chapters ?? chaptersFrom(t.marks, t.lines, t.durationMs),
    pushes: t.pushes,
    debrief: deb?.debrief ?? null, debriefNote: deb?.note ?? null, docId: deb?.docId ?? null, debriefAt: deb?.at ?? null,
    clips: await listClips(rt, room.id),
    edition: { active: (rt.settings.WEBINAR_EDITION ?? '').trim().toLowerCase() === 'room' && ed?.roomId === room.id, current: ed ? { roomId: ed.roomId, title: ed.title, durationMin: ed.durationMin } : null },
    ai: { claude: claudeReady(rt), whisper: Boolean(rt.env.AI), r2: Boolean(rt.env.RECORDINGS) },
  });
});

/** Transcribe (or keep transcribing) the room's recording for up to ~20 s; Funnel HQ calls again while it runs. */
intelAdmin.post('/rooms/:id/transcribe', async (c) => {
  const rt = runtimeFrom(c);
  const room = await roomOr404(c);
  if (!room) return c.json({ ok: false, error: 'Room not found' }, 404);
  const rec = await mainRecording(rt, room.id);
  if (!rec) return c.json({ ok: false, error: 'This room has no ready recording.' }, 400);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  await queueTranscription(rt, rec);
  if (b.restart === true) await restartTranscription(rt, rec.id);
  const job = await transcribeFor(rt, rec.id, 20_000, { maxSteps: 12 });
  return c.json({ ok: true, job });
});

intelAdmin.post('/rooms/:id/debrief', async (c) => {
  const rt = runtimeFrom(c);
  const room = await roomOr404(c);
  if (!room) return c.json({ ok: false, error: 'Room not found' }, 404);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const r = await buildDebrief(rt, room, { post: b.post === true });
  return c.json({ ok: true, debrief: r.debrief, note: r.note, docId: r.docId });
});

intelAdmin.post('/rooms/:id/post', async (c) => {
  const rt = runtimeFrom(c);
  const room = await roomOr404(c);
  const deb = room ? await getDebrief(rt, room.id) : null;
  if (!room || !deb) return c.json({ ok: false, error: 'Write the debrief first.' }, 400);
  return c.json({ ok: true, docId: await postToCommand(rt, room, deb.debrief) });
});

intelAdmin.post('/rooms/:id/clips', async (c) => {
  const rt = runtimeFrom(c);
  const room = await roomOr404(c);
  if (!room) return c.json({ ok: false, error: 'Room not found' }, 404);
  const t = await timeline(rt, room);
  const deb = (await getDebrief(rt, room.id))?.debrief ?? (await buildDebrief(rt, room)).debrief;
  const r = await suggestClips(rt, room, t, deb);
  return c.json(r, r.ok ? 200 : 400);
});
intelAdmin.get('/clips', async (c) => {
  const rt = runtimeFrom(c);
  const clips = await listClips(rt);
  // Each clip's caption cues (the export burns them in) from its room's transcript.
  const recs = [...new Set(clips.map((x) => x.rec_id))];
  const cues: Record<string, { from: number; to: number; text: string }[]> = {};
  for (const rid of recs) {
    const rows = (await rt.env.DB.prepare('SELECT start_ms, end_ms, text FROM room_transcript WHERE rec_id = ? ORDER BY start_ms LIMIT 20000').bind(rid).all<{ start_ms: number; end_ms: number; text: string }>()).results;
    for (const cl of clips.filter((x) => x.rec_id === rid)) cues[cl.id] = rows.filter((l) => l.end_ms >= cl.start_ms && l.start_ms <= cl.end_ms).map((l) => ({ from: Math.max(0, l.start_ms - cl.start_ms), to: Math.min(cl.end_ms, l.end_ms) - cl.start_ms, text: l.text }));
  }
  return c.json({ ok: true, clips: clips.map((x) => ({ ...x, src: `/rooms/replay/${x.rec_id}`, cues: cues[x.id] ?? [], at: stamp(x.start_ms), length: Math.round((x.end_ms - x.start_ms) / 1000) })) });
});
intelAdmin.post('/clips/:cid', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const r = await saveClip(runtimeFrom(c), c.req.param('cid'), b);
  return c.json(r, r.ok ? 200 : 400);
});

/** Simulive: what the edition would be, and publishing it as the automated webinar's recording. */
intelAdmin.get('/rooms/:id/edition', async (c) => {
  const rt = runtimeFrom(c);
  const room = await roomOr404(c);
  if (!room) return c.json({ ok: false, error: 'Room not found' }, 404);
  return c.json(await roomEditionFor(rt, room));
});
intelAdmin.post('/rooms/:id/edition', async (c) => {
  const rt = runtimeFrom(c);
  const room = await roomOr404(c);
  if (!room) return c.json({ ok: false, error: 'Room not found' }, 404);
  const r = await publishEdition(rt, room);
  return c.json(r, r.ok ? 200 : 400);
});
intelAdmin.post('/edition/off', async (c) => {
  const rt = runtimeFrom(c);
  const { saveSettings } = await import('../settings');
  await saveSettings(rt.env, { WEBINAR_EDITION: 'recorded' });
  return c.json({ ok: true });
});

export type { Runtime };

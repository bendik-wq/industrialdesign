import { type Context, Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { getRoom, isRoomId, readTicket, ticketIdentity } from './rooms';
import { roomMeta } from './routes';
import type { Identity } from './state';

/**
 * The audience experience over HTTP (area C), next to roomsApi under /api/rooms:
 *  - POST /:id/captions?t=<ticket>&start=<ms>  one piece of the host's microphone (16 kHz WAV) → a caption line
 *  - POST /:id/audience/me                    the attendee's personal offer lines, consent and preview
 *  - POST /:id/audience/consent               ticking or unticking the announcement box
 *  - POST /:id/audience/catchup               caption lines since a moment (the "while you were away" card)
 * Every call carries the room ticket minted into the page.
 */

export const audienceApi = new Hono<AppEnv>();
const sameOrigin = (c: Context<AppEnv>) => { const o = c.req.header('origin'); return !o || o === new URL(c.req.url).origin; };
async function authed(c: Context<AppEnv>, token: unknown) {
  const rt = runtimeFrom(c);
  const id = c.req.param('id') ?? '';
  if (!isRoomId(id)) return null;
  const t = await readTicket(rt, token, id);
  if (!t) return null;
  const room = await getRoom(rt, id);
  return room ? { rt, room, t, who: ticketIdentity(t) } : null;
}
type A = NonNullable<Awaited<ReturnType<typeof authed>>>;
function toRoom(c: Context<AppEnv>, a: A, path: string, init: { method?: string; body?: string } = {}, who: Identity = a.who) {
  const ns = c.env.ROOMS;
  if (!ns) return null;
  return ns.get(ns.idFromName(a.room.id)).fetch(new Request(`https://room${path}`, {
    method: init.method ?? 'GET', body: init.body,
    headers: { 'content-type': 'application/json', 'x-room-who': JSON.stringify(who), 'x-room-meta': JSON.stringify(roomMeta(a.rt, a.room)) },
  }));
}
const staff = (a: A) => a.t.role === 'host' || a.t.role === 'cohost';

audienceApi.post('/:id/captions', async (c) => {
  if (!sameOrigin(c)) return c.json({ ok: false }, 403);
  const a = await authed(c, c.req.query('t'));
  if (!a || !staff(a) || a.room.mode !== 'webinar') return c.json({ ok: false, error: 'forbidden' }, 403);
  const { cfgOf } = await import('./audience-db');
  if (!cfgOf(a.rt).captions) return c.json({ ok: false, error: 'cap_off' }, 403);
  const ai = c.env.AI;
  if (!ai) return c.json({ ok: false, error: 'no_ai' }, 503);
  const { MAX_PIECE_BYTES, saveCaption, transcribePiece, validPiece } = await import('./captions');
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_PIECE_BYTES) return c.json({ ok: false, error: 'too large' }, 413);
  const audio = await c.req.arrayBuffer();
  if (!validPiece(audio)) return c.json({ ok: false, error: 'bad audio' }, 400);
  const ready = await toRoom(c, a, '/audience/cap-ready')?.then((r) => r.json() as Promise<{ ok: boolean; live: boolean; wentLiveAt: number | null }>).catch(() => null);
  if (!ready?.ok) return c.json({ ok: false, error: 'forbidden' }, 403);
  const start = Number(c.req.query('start'));
  const prompt = (c.req.query('prev') ?? '').slice(0, 200);
  let line: { text: string; lang: string };
  try { line = await transcribePiece(ai as never, audio, { prompt }); } catch (e) { console.error('caption', String(e).slice(0, 200)); return c.json({ ok: false, error: 'stt' }, 502); }
  if (!line.text) return c.json({ ok: true, text: '' });
  // The transcript runs from Go live; captions before it (backstage checks) are shown, not kept.
  const base = ready.wentLiveAt ?? a.room.went_live_at;
  const tMs = ready.live && base ? Math.max(0, (Number.isFinite(start) && start > 0 ? start : Date.now()) - base) : -1;
  if (tMs >= 0) await saveCaption(a.rt, a.room.id, tMs, line.text, line.lang).catch((e) => console.error('caption save', e));
  await toRoom(c, a, '/audience/caption', { method: 'POST', body: JSON.stringify({ text: line.text, t_ms: Math.max(0, tMs), lang: line.lang, by: a.who.id, name: a.who.name }) })?.catch(() => null);
  return c.json({ ok: true, text: line.text, lang: line.lang, kept: tMs >= 0 });
});

audienceApi.post('/:id/audience/me', async (c) => {
  if (!sameOrigin(c)) return c.json({ ok: false }, 403);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const a = await authed(c, b.t);
  if (!a || a.room.mode !== 'webinar') return c.json({ ok: false, error: 'forbidden' }, 403);
  c.header('cache-control', 'no-store');
  if (staff(a)) return c.json({ ok: true, lines: [], consent: null, preview: null, lead: false });
  const { personalFor } = await import('./audience-db');
  return c.json({ ok: true, ...(await personalFor(a.rt, a.room, a.who)) });
});

audienceApi.post('/:id/audience/consent', async (c) => {
  if (!sameOrigin(c)) return c.json({ ok: false }, 403);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const a = await authed(c, b.t);
  if (!a || a.room.mode !== 'webinar' || staff(a) || !a.who.leadId) return c.json({ ok: false, error: 'forbidden' }, 403);
  const { saveConsent } = await import('./audience-db');
  const r = await saveConsent(a.rt, a.room.id, a.who, { on: b.on === true, showCity: b.showCity !== false });
  return c.json({ ok: true, on: Boolean(r && !r.withdrawn_at), showCity: r ? r.show_city === 1 : true });
});

audienceApi.post('/:id/audience/catchup', async (c) => {
  if (!sameOrigin(c)) return c.json({ ok: false }, 403);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const a = await authed(c, b.t);
  if (!a || a.room.mode !== 'webinar') return c.json({ ok: false, error: 'forbidden' }, 403);
  const base = a.room.went_live_at;
  const since = Number(b.since);
  if (!base || !Number.isFinite(since)) return c.json({ ok: true, lines: [] });
  const { captionsSince } = await import('./captions');
  const lines = await captionsSince(a.rt, a.room.id, Math.max(0, since - base), 60).catch(() => []);
  return c.json({ ok: true, lines: lines.map((l) => ({ text: l.text, at: base + l.t_ms })) });
});

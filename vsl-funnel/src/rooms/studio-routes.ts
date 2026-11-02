import { type Context, Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { newId } from '../lib/ids';
import { MATERIAL_IDS, isMaterialId, parseMaterial } from '../admin/materials';
import type { Identity } from './state';
import { type RoomRow, type Ticket, getRoom } from './rooms';
import { DEFAULT_PACK, cleanPack, packIssues } from './studio-pack';
import { packConfig } from './studio-pack-terms';
import { type RosSection, DEFAULT_STUDIO, STUDIO_COPY, type StudioSettings, cleanStudioSettings, parseStudioSettings, runOfShow, scriptFor } from './studio';

/**
 * Builder B (studio) on the web. Mounted by routes.ts (mountStudio) on the room API and Funnel HQ's rooms API:
 *
 *  /api/rooms/:id/studio/…  (room ticket)
 *    decks, deck, deck/:deck/:n (PUT a page), deck/:deck/done, deck/:deck/notes   staff: slides for this room
 *    slide/:deck/:n                     a page: staff any page; others only pages the stage has shown (asked of the room)
 *    script                             staff: the run of show from the room's script (public/materials, admin-only files)
 *    asset/:kind                        the room's logo or intro music (public branding, no ticket)
 *  /admin/api/rooms/…  (admin session)
 *    :id/studio (GET, POST)             the room's studio settings, decks and the templates
 *    :id/studio/deck/:deck/delete
 *    studio/assets (POST, raw body)     upload a logo or intro music file
 *    studio/templates (GET, POST), studio/templates/:tid/apply, studio/templates/:tid/delete
 */

type Authed = { rt: Runtime; room: RoomRow; t: Ticket };
export interface StudioHelpers {
  authed: (c: Context<AppEnv>, token: unknown) => Promise<Authed | null>;
  stub: (c: Context<AppEnv>, roomId: string) => DurableObjectStub;
  headersFor: (rt: Runtime, room: RoomRow, who: Identity) => Record<string, string>;
  sameOrigin: (c: Context<AppEnv>) => boolean;
}

const staff = (t: { role: string }) => t.role === 'host' || t.role === 'cohost';
const DECK = /^dk[a-z0-9]{6,40}$/;
const SLIDE_TYPES = ['image/webp', 'image/png', 'image/jpeg'];
const ASSET_TYPES: Record<'logo' | 'music', string[]> = { logo: ['image/png', 'image/svg+xml', 'image/webp', 'image/jpeg'], music: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/x-m4a'] };
const MAX = { slide: 8 * 1024 * 1024, logo: 2 * 1024 * 1024, music: 15 * 1024 * 1024 };
export const slideKey = (roomId: string, deckId: string, n: number) => `slides/${roomId}/${deckId}/${n}`;

export interface DeckRow { id: string; room_id: string; title: string; pages: number; mime: string; notes: string | null; status: string; created_at: number; updated_at: number }
const deckView = (d: DeckRow) => ({ id: d.id, title: d.title, pages: d.pages, status: d.status, notes: parseNotes(d.notes), created_at: d.created_at });
const parseNotes = (j: string | null) => { try { const a = JSON.parse(j ?? '[]'); return Array.isArray(a) ? a.map((x) => String(x ?? '').slice(0, 4000)) : []; } catch { return []; } };
const cleanNotes = (v: unknown, pages: number) => (Array.isArray(v) ? v.slice(0, pages).map((x) => (typeof x === 'string' ? x.replace(/\u0000/g, '').slice(0, 4000) : '')) : []);

export const listDecks = (rt: Pick<Runtime, 'env'>, roomId: string) =>
  rt.env.DB.prepare('SELECT * FROM studio_decks WHERE room_id = ? ORDER BY created_at DESC LIMIT 50').bind(roomId).all<DeckRow>().then((r) => r.results);
export const getDeck = (rt: Pick<Runtime, 'env'>, roomId: string, deckId: string) =>
  DECK.test(deckId) ? rt.env.DB.prepare('SELECT * FROM studio_decks WHERE id = ? AND room_id = ?').bind(deckId, roomId).first<DeckRow>() : Promise.resolve(null);
export async function createDeck(rt: Pick<Runtime, 'env'>, roomId: string, title: unknown, pages: unknown, now = Date.now()) {
  const n = Math.round(Number(pages));
  if (!(n >= 1 && n <= 300)) return null;
  const id = newId('dk').toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = typeof title === 'string' ? title.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 120) : '';
  await rt.env.DB.prepare('INSERT INTO studio_decks (id, room_id, title, pages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, roomId, t || 'Slides', n, now, now).run();
  return id;
}

/** The room's studio settings (rooms.studio). */
export const roomStudio = (room: Pick<RoomRow, 'studio'>): StudioSettings => parseStudioSettings(room.studio);
export async function saveRoomStudio(rt: Pick<Runtime, 'env'>, room: RoomRow, raw: unknown, now = Date.now()) {
  const s = cleanStudioSettings(raw, roomStudio(room));
  await rt.env.DB.prepare('UPDATE rooms SET studio = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(s), now, room.id).run();
  return s;
}

// ── templates ──
export interface TemplateRow { id: string; name: string; settings: string; created_at: number; updated_at: number }
export const listTemplates = (rt: Pick<Runtime, 'env'>) => rt.env.DB.prepare('SELECT * FROM studio_templates ORDER BY updated_at DESC LIMIT 100').all<TemplateRow>().then((r) => r.results.map((t) => ({ id: t.id, name: t.name, settings: parseStudioSettings(t.settings), updated_at: t.updated_at })));
export async function saveTemplate(rt: Pick<Runtime, 'env'>, o: { id?: string | null; name: unknown; settings: unknown }, now = Date.now()) {
  const name = typeof o.name === 'string' ? o.name.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 80) : '';
  if (!name) return null;
  const s = JSON.stringify(cleanStudioSettings(o.settings, DEFAULT_STUDIO));
  if (o.id) {
    const r = await rt.env.DB.prepare('UPDATE studio_templates SET name = ?, settings = ?, updated_at = ? WHERE id = ?').bind(name, s, now, o.id).run();
    if (r.meta.changes) return o.id;
  }
  const id = newId('st').toLowerCase();
  await rt.env.DB.prepare('INSERT INTO studio_templates (id, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, name, s, now, now).run();
  return id;
}
/** A template onto a room: its settings replace the room's (the room's decks stay). */
export async function applyTemplate(rt: Pick<Runtime, 'env'>, templateId: string, room: RoomRow, now = Date.now()) {
  const t = await rt.env.DB.prepare('SELECT * FROM studio_templates WHERE id = ?').bind(templateId).first<TemplateRow>();
  if (!t) return null;
  const s = parseStudioSettings(t.settings);
  await rt.env.DB.prepare('UPDATE rooms SET studio = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(s), now, room.id).run();
  return s;
}

/** The run of show for a room: the script's sections, with each poll cue's preset filled in where the room knows it. */
export async function roomRunOfShow(c: Context<AppEnv>, room: RoomRow): Promise<{ script: string; title: string; sections: RosSection[] } | null> {
  const id = scriptFor(room, roomStudio(room).script);
  if (!isMaterialId(id)) return null;
  const res = await c.env.ASSETS.fetch(new Request(new URL(`/materials/${id}.md`, c.req.url)));
  if (!res.ok) return null;
  const m = parseMaterial(await res.text());
  const sections = runOfShow(m);
  const { presetPoll } = await import('../live/events');
  for (const s of sections) for (const q of s.cues) if (q.cue === 'poll' && q.preset) { const p = presetPoll(q.preset); if (p) { q.question = p.question; q.options = p.options; } }
  return { script: id, title: m.meta.title || id, sections };
}

/** Streams an R2 object with Range support (Safari needs 206 for audio). */
async function serveR2(c: Context<AppEnv>, key: string, cache: string, fallbackType: string) {
  const bucket = c.env.RECORDINGS!;
  const range = c.req.header('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  const obj = m && (m[1] || m[2])
    ? await bucket.get(key, { range: m[1] ? { offset: Number(m[1]), ...(m[2] ? { length: Number(m[2]) - Number(m[1]) + 1 } : {}) } : { suffix: Number(m[2]) } })
    : await bucket.get(key);
  if (!obj || !('body' in obj)) return c.notFound();
  const headers = new Headers({ 'content-type': obj.httpMetadata?.contentType || fallbackType, 'accept-ranges': 'bytes', 'cache-control': cache, 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' });
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

export function mountStudio(api: Hono<AppEnv>, admin: Hono<AppEnv>, h: StudioHelpers) {
  const body = (c: Context<AppEnv>) => c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const forbid = (c: Context<AppEnv>) => c.json({ ok: false, error: 'forbidden' }, 403);
  const staffOf = async (c: Context<AppEnv>, token: unknown) => {
    if (!h.sameOrigin(c)) return null;
    const a = await h.authed(c, token);
    return a && staff(a.t) && a.room.mode === 'webinar' ? a : null;
  };

  api.post('/:id/studio/decks', async (c) => {
    const a = await staffOf(c, (await body(c)).t);
    if (!a) return forbid(c);
    c.header('cache-control', 'no-store');
    return c.json({ ok: true, storage: Boolean(c.env.RECORDINGS), decks: (await listDecks(a.rt, a.room.id)).map(deckView) });
  });
  api.post('/:id/studio/deck', async (c) => {
    const b = await body(c);
    const a = await staffOf(c, b.t);
    if (!a) return forbid(c);
    if (!c.env.RECORDINGS) return c.json({ ok: false, error: STUDIO_COPY.noStorage }, 503);
    const id = await createDeck(a.rt, a.room.id, b.title, b.pages);
    return id ? c.json({ ok: true, id }) : c.json({ ok: false, error: STUDIO_COPY.errors.bad_value }, 400);
  });
  api.put('/:id/studio/deck/:deck/:n{[0-9]{1,3}}', async (c) => {
    const a = await staffOf(c, c.req.query('t'));
    if (!a || !c.env.RECORDINGS) return forbid(c);
    const deck = await getDeck(a.rt, a.room.id, c.req.param('deck'));
    const n = Number(c.req.param('n'));
    if (!deck || !(n >= 0 && n < deck.pages)) return c.json({ ok: false, error: 'not found' }, 404);
    const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!SLIDE_TYPES.includes(type)) return c.json({ ok: false, error: 'Slides upload as WebP, PNG or JPEG.' }, 415);
    const buf = await c.req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX.slide) return c.json({ ok: false, error: 'bad size' }, 413);
    await c.env.RECORDINGS.put(slideKey(a.room.id, deck.id, n), buf, { httpMetadata: { contentType: type } });
    return c.json({ ok: true, n });
  });
  api.post('/:id/studio/deck/:deck/done', async (c) => {
    const b = await body(c);
    const a = await staffOf(c, b.t);
    if (!a) return forbid(c);
    const deck = await getDeck(a.rt, a.room.id, c.req.param('deck'));
    if (!deck) return c.json({ ok: false, error: 'not found' }, 404);
    await a.rt.env.DB.prepare("UPDATE studio_decks SET status = 'ready', notes = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(cleanNotes(b.notes, deck.pages)), Date.now(), deck.id).run();
    return c.json({ ok: true, deck: deckView({ ...deck, status: 'ready', notes: JSON.stringify(cleanNotes(b.notes, deck.pages)) }) });
  });
  api.post('/:id/studio/deck/:deck/notes', async (c) => {
    const b = await body(c);
    const a = await staffOf(c, b.t);
    if (!a) return forbid(c);
    const deck = await getDeck(a.rt, a.room.id, c.req.param('deck'));
    if (!deck) return c.json({ ok: false, error: 'not found' }, 404);
    await a.rt.env.DB.prepare('UPDATE studio_decks SET notes = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(cleanNotes(b.notes, deck.pages)), Date.now(), deck.id).run();
    return c.json({ ok: true });
  });
  /** One slide. Staff: any page of this room's decks. Everyone else: the room says whether the stage has shown it. */
  api.get('/:id/studio/slide/:deck/:n{[0-9]{1,3}}', async (c) => {
    if (!h.sameOrigin(c)) return c.text('Forbidden', 403);
    const a = await h.authed(c, c.req.query('t'));
    if (!a || !c.env.RECORDINGS) return c.text('Forbidden', 403);
    const deck = await getDeck(a.rt, a.room.id, c.req.param('deck'));
    const n = Number(c.req.param('n'));
    if (!deck || !(n >= 0 && n < deck.pages)) return c.notFound();
    if (!staff(a.t)) {
      if (!c.env.ROOMS) return c.text('Forbidden', 403);
      const who: Identity = { id: a.t.p, name: a.t.n, role: a.t.role, leadId: a.t.lead, regId: a.t.reg };
      const ok = await h.stub(c, a.room.id).fetch(new Request('https://room/studio/slide', { method: 'POST', headers: { 'content-type': 'application/json', ...h.headersFor(a.rt, a.room, who) }, body: JSON.stringify({ deck: deck.id, page: n }) }))
        .then((r) => r.json() as Promise<{ ok?: boolean }>).then((r) => r.ok === true).catch(() => false);
      if (!ok) return c.text('Not shown yet', 403);
    }
    return serveR2(c, slideKey(a.room.id, deck.id, n), 'private, max-age=3600', 'image/webp');
  });
  api.post('/:id/studio/script', async (c) => {
    const a = await staffOf(c, (await body(c)).t);
    if (!a) return forbid(c);
    c.header('cache-control', 'no-store');
    const ros = await roomRunOfShow(c, a.room);
    return c.json(ros ? { ok: true, ...ros } : { ok: false, error: STUDIO_COPY.rosNoScript });
  });
  /**
   * Offer pack: the two paths with this attendee's real prices (their ticket credit), whether each is theirs
   * already, and whether they qualify. Deadlines come from the room (the offer's close) and the Sprint push's hold.
   */
  api.post('/:id/studio/paths', async (c) => {
    if (!h.sameOrigin(c)) return forbid(c);
    const a = await h.authed(c, (await body(c)).t);
    if (!a || a.room.mode !== 'webinar') return forbid(c);
    c.header('cache-control', 'no-store');
    return c.json({ ok: true, ...(await pathsFor(a.rt, a.room, { id: a.t.p, leadId: a.t.lead ?? null })) });
  });
  /** The room's logo or intro music: branding, public like the page around it. */
  api.get('/:id/studio/asset/:kind{logo|music}', async (c) => {
    const room = await getRoom(runtimeFrom(c), c.req.param('id'));
    if (!room || !c.env.RECORDINGS) return c.notFound();
    const kind = c.req.param('kind') as 'logo' | 'music';
    const id = roomStudio(room)[kind];
    if (!id) return c.notFound();
    const row = await c.env.DB.prepare('SELECT r2_key, mime FROM studio_assets WHERE id = ? AND kind = ?').bind(id, kind).first<{ r2_key: string; mime: string }>();
    if (!row) return c.notFound();
    return serveR2(c, row.r2_key, 'public, max-age=300', row.mime);
  });

  // ── Funnel HQ ──
  admin.get('/studio/templates', async (c) => c.json({ ok: true, templates: await listTemplates(runtimeFrom(c)) }));
  admin.post('/studio/templates', async (c) => {
    const rt = runtimeFrom(c);
    const b = await body(c);
    let settings: unknown = b.settings;
    if (typeof b.room === 'string') { const room = await getRoom(rt, b.room); if (!room) return c.json({ ok: false, error: 'Room not found' }, 404); settings = roomStudio(room); }
    const id = await saveTemplate(rt, { id: typeof b.id === 'string' ? b.id : null, name: b.name, settings });
    return id ? c.json({ ok: true, id, templates: await listTemplates(rt) }) : c.json({ ok: false, error: 'Name the template' }, 400);
  });
  admin.post('/studio/templates/:tid/apply', async (c) => {
    const rt = runtimeFrom(c);
    const b = await body(c);
    const room = await getRoom(rt, String(b.room ?? ''));
    if (!room) return c.json({ ok: false, error: 'Room not found' }, 404);
    const s = await applyTemplate(rt, c.req.param('tid'), room);
    return s ? c.json({ ok: true, settings: s }) : c.json({ ok: false, error: 'Template not found' }, 404);
  });
  admin.post('/studio/templates/:tid/delete', async (c) => {
    await c.env.DB.prepare('DELETE FROM studio_templates WHERE id = ?').bind(c.req.param('tid')).run();
    return c.json({ ok: true, templates: await listTemplates(runtimeFrom(c)) });
  });
  admin.post('/studio/assets', async (c) => {
    const kind = c.req.query('kind') === 'music' ? 'music' : c.req.query('kind') === 'logo' ? 'logo' : null;
    if (!kind) return c.json({ ok: false, error: 'Pick logo or music' }, 400);
    if (!c.env.RECORDINGS) return c.json({ ok: false, error: STUDIO_COPY.noStorage }, 503);
    const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ASSET_TYPES[kind].includes(type)) return c.json({ ok: false, error: kind === 'logo' ? 'Logos upload as PNG, SVG, WebP or JPEG.' : 'Music uploads as MP3, M4A, AAC, OGG, WebM or WAV.' }, 415);
    const buf = await c.req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX[kind]) return c.json({ ok: false, error: kind === 'logo' ? 'Logos up to 2 MB.' : 'Music up to 15 MB.' }, 413);
    const id = newId('sa').toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = `studio/assets/${id}`;
    await c.env.RECORDINGS.put(key, buf, { httpMetadata: { contentType: type } });
    const name = (c.req.query('name') ?? '').replace(/[<>\u0000-\u001f]/g, '').slice(0, 120) || null;
    await c.env.DB.prepare('INSERT INTO studio_assets (id, kind, name, mime, bytes, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, kind, name, type, buf.byteLength, key, Date.now()).run();
    return c.json({ ok: true, id, kind, name });
  });
  admin.get('/:id/studio', async (c) => {
    const rt = runtimeFrom(c);
    const room = await getRoom(rt, c.req.param('id'));
    if (!room) return c.json({ ok: false, error: 'Room not found' }, 404);
    const s = roomStudio(room);
    const ids = [s.logo, s.music].filter(Boolean) as string[];
    const assets = ids.length ? (await rt.env.DB.prepare(`SELECT id, kind, name, bytes FROM studio_assets WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ id: string; kind: string; name: string | null; bytes: number }>()).results : [];
    return c.json({
      ok: true, room: { id: room.id, title: room.title, mode: room.mode, ref_type: room.ref_type }, settings: s, assets,
      decks: (await listDecks(rt, room.id)).map(deckView), templates: await listTemplates(rt),
      scripts: MATERIAL_IDS, script: scriptFor(room, s.script), storage: Boolean(c.env.RECORDINGS), enabled: true,
      // Offer pack: the real prices the stack and comparison can show, and copy-rule issues in the owner's lines.
      pack: packConfig(rt, room, s.pack ?? DEFAULT_PACK).prices, packIssues: packIssues(s.pack ?? DEFAULT_PACK),
    });
  });
  admin.post('/:id/studio', async (c) => {
    const rt = runtimeFrom(c);
    const room = await getRoom(rt, c.req.param('id'));
    if (!room) return c.json({ ok: false, error: 'Room not found' }, 404);
    if (room.mode !== 'webinar') return c.json({ ok: false, error: 'The studio is for webinars.' }, 400);
    const b = await body(c);
    // Offer pack: stack lines with a typed money figure are left out; the owner sees why, and any copy-rule issues.
    const dropped: string[] = [];
    if (b.pack !== undefined) cleanPack(b.pack, DEFAULT_PACK, dropped);
    const settings = await saveRoomStudio(rt, room, b);
    return c.json({ ok: true, settings, packIssues: [...dropped, ...packIssues(settings.pack)] });
  });
  admin.post('/:id/studio/deck/:deck/delete', async (c) => {
    const rt = runtimeFrom(c);
    const deck = await getDeck(rt, c.req.param('id'), c.req.param('deck'));
    if (!deck) return c.json({ ok: false, error: 'not found' }, 404);
    if (c.env.RECORDINGS) for (let n = 0; n < deck.pages; n += 100) await c.env.RECORDINGS.delete(Array.from({ length: Math.min(100, deck.pages - n) }, (_, i) => slideKey(deck.room_id, deck.id, n + i))).catch(() => null);
    await rt.env.DB.prepare('DELETE FROM studio_decks WHERE id = ?').bind(deck.id).run();
    return c.json({ ok: true });
  });
}

/** The two paths for one attendee: real prices after their own credits, from the deposit quote and the room's Sprint card. */
export async function pathsFor(rt: Runtime, room: RoomRow, who: { id: string; leadId: string | null }) {
  const { packPrices } = await import('./studio-pack-terms');
  const prices = packPrices(rt, room.ref_type);
  if (!who.leadId) return { lead: false, prices, deposit: null, sprint: null };
  const { getLead } = await import('../funnel/leads');
  const { isMillionPlus } = await import('../sales/qualify');
  const { depositQuote } = await import('../sales/deposit');
  const { sprintCard } = await import('./engage-db');
  const lead = await getLead(rt.env, who.leadId);
  const qualified = Boolean(lead && isMillionPlus(lead.revenue_band));
  const q = await depositQuote(rt, who.leadId).catch(() => null);
  const sp = prices.sprint ? await sprintCard(rt, who.leadId, { roomId: room.id, who: who.id }).catch(() => null) : null;
  return {
    lead: true, prices, qualified,
    deposit: q ? { label: q.cfg.label, today: q.todayLabel, credit: q.creditLabel, paid: q.paid, guarantee: q.cfg.guarantee.headline, url: q.cfg.guarantee.url, full: q.cap.full } : null,
    sprint: sp ? { name: sp.name, label: sp.priceLabel, today: sp.todayLabel, line: sp.line, paid: sp.paid, available: sp.available, qualified: sp.qualified, deadline: sp.deadline ? { at: sp.deadline.at, label: sp.deadline.label } : null } : null,
  };
}

/** What room.js and room-studio.js need in the page config. */
export function studioPageConfig(room: RoomRow, who: Identity, enabled: boolean, rt?: Pick<Runtime, 'settings' | 'origin'>) {
  if (room.mode !== 'webinar') return null;
  const s = roomStudio(room);
  const isStaff = who.role === 'host' || who.role === 'cohost';
  return {
    on: enabled && s.on,
    copy: STUDIO_COPY,
    brand: {
      colors: s.colors,
      logo: s.logo ? `/api/rooms/${room.id}/studio/asset/logo` : null,
      music: s.music ? `/api/rooms/${room.id}/studio/asset/music` : null,
      introTitle: s.introTitle, introNote: s.introNote, brbText: s.brbText, outroTitle: s.outroTitle, outroNote: s.outroNote,
      offerHeading: s.offerHeading, offerPoints: s.offerPoints,
    },
    // pdf.js (pinned, with integrity) renders an uploaded PDF in the host's browser; only staff pages allow the CDN.
    pdfjs: isStaff ? PDFJS : null,
    // Offer pack (round 4): the pitch scenes' words and the real prices and terms they show (studio-pack-terms.ts).
    pack: rt ? packConfig(rt, room, s.pack ?? DEFAULT_PACK) : null,
  };
}
export const PDFJS = {
  src: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  integrity: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e',
  worker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  workerIntegrity: 'sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2',
};

import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { signedFileUrl } from './signed-files';

/**
 * Cloudflare Stream for room recordings and the VSL (Cloudflare round, builder D).
 * OFF until the owner pastes STREAM_ACCOUNT_TOKEN (Integrations → Video); STREAM_ACCOUNT_ID defaults to the account
 * this app runs in. Without the token every replay plays the recording file from R2 exactly as before.
 *
 *  (a) Funnel HQ → Rooms → a room → Recordings: "Send to Stream" copies a finished R2 recording into Stream through
 *      the copy-from-URL API, using a signed link to the file that lasts six hours. The video's uid and playback
 *      links are kept in stream_videos; the cron and Funnel HQ refresh its state until Stream has it ready.
 *  (b) /rooms/replay/<id> opened as a page (the "Watch the replay" links in the live room, the challenge and the
 *      host room) plays the Stream player (adaptive quality, good on phones) once the copy is ready. Video tags,
 *      the clip exporter and range requests still get the file itself.
 *  (c) A video setting such as VSL_MAIN_SRC may hold a Stream video ID or Stream link: it becomes the HLS manifest,
 *      which the existing player already plays. Any other value is used unchanged.
 * The token is sent only to api.cloudflare.com and never logged or shown.
 */
export const DEFAULT_STREAM_ACCOUNT = '50e9fc42a7947d3f932cd1ed0bf95c03';
export const STREAM_API = 'https://api.cloudflare.com/client/v4';
export const STREAM_SOURCE_TTL_MS = 6 * 3_600_000;

type S = Pick<Runtime['settings'], 'STREAM_ACCOUNT_TOKEN' | 'STREAM_ACCOUNT_ID' | 'STREAM_CUSTOMER_CODE'>;
export function streamConfig(s: Partial<S>) {
  const token = (s.STREAM_ACCOUNT_TOKEN ?? '').trim();
  const accountId = (s.STREAM_ACCOUNT_ID ?? '').trim() || DEFAULT_STREAM_ACCOUNT;
  return { on: Boolean(token), token, accountId: /^[0-9a-f]{32}$/.test(accountId) ? accountId : DEFAULT_STREAM_ACCOUNT };
}

// ───────────── (c) Stream ids and links → an HLS manifest ─────────────

const UID = /^[0-9a-f]{32}$/;
const STREAM_HOST = /^(customer-[a-z0-9]{6,40}\.cloudflarestream\.com|videodelivery\.net|watch\.cloudflarestream\.com|iframe\.videodelivery\.net|iframe\.cloudflarestream\.com)$/;
export const isStreamHost = (host: string) => STREAM_HOST.test(host.toLowerCase());

/** The playback base for a uid: the customer subdomain when its code is known, else videodelivery.net. */
export function streamBase(uid: string, customerCode?: string) {
  const code = (customerCode ?? '').trim().toLowerCase().replace(/^customer-/, '').replace(/\.cloudflarestream\.com$/, '');
  return /^[a-z0-9]{6,40}$/.test(code) ? `https://customer-${code}.cloudflarestream.com/${uid}` : `https://videodelivery.net/${uid}`;
}

/**
 * A video setting's value as something the player can play: a bare Stream uid, or a Stream watch / iframe /
 * thumbnail link, becomes `<base>/<uid>/manifest/video.m3u8`. Everything else (an MP4, an HLS manifest, a path)
 * comes back unchanged.
 */
export function streamVideoSrc(src: string, customerCode?: string): string {
  const v = (src ?? '').trim();
  if (!v) return src;
  if (UID.test(v)) return `${streamBase(v, customerCode)}/manifest/video.m3u8`;
  let u: URL;
  try { u = new URL(v); } catch { return src; }
  if (u.protocol !== 'https:' || !isStreamHost(u.hostname)) return src;
  const parts = u.pathname.split('/').filter(Boolean);
  const uid = parts.find((p) => UID.test(p));
  if (!uid || /\/manifest\//.test(u.pathname)) return src; // already a manifest (or not a video link): as it is
  const host = u.hostname.toLowerCase();
  const base = host.startsWith('customer-') ? `https://${host}/${uid}` : streamBase(uid, customerCode);
  return `${base}/manifest/video.m3u8`;
}

// ───────────── the Stream API ─────────────

export interface StreamVideo { uid: string; readyToStream?: boolean; status?: { state?: string; errorReasonText?: string; errorReasonCode?: string }; preview?: string; thumbnail?: string; playback?: { hls?: string; dash?: string }; duration?: number }
type Fetcher = typeof fetch;

async function api<T>(cfg: ReturnType<typeof streamConfig>, path: string, init: RequestInit, fetcher: Fetcher): Promise<T> {
  const res = await fetcher(`${STREAM_API}/accounts/${cfg.accountId}/stream${path}`, { ...init, headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const j = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message?: string; code?: number }[] } | null;
  if (!res.ok || !j || j.success === false || !j.result) {
    const msg = j?.errors?.map((e) => e.message).filter(Boolean).join('; ') || `Stream answered ${res.status}`;
    throw new Error(res.status === 401 || res.status === 403 ? `Stream refused the token (${res.status}). Check STREAM_ACCOUNT_TOKEN has Stream: Edit.` : msg.slice(0, 300));
  }
  return j.result;
}

export interface StreamRow { rec_id: string; uid: string | null; state: string; ready: number; hls: string | null; preview: string | null; thumbnail: string | null; duration: number | null; error: string | null; created_at: number; updated_at: number }

const okUrl = (u: unknown) => {
  if (typeof u !== 'string') return null;
  try { const x = new URL(u); return x.protocol === 'https:' && isStreamHost(x.hostname) ? u.slice(0, 400) : null; } catch { return null; }
};

async function saveVideo(rt: Pick<Runtime, 'env'>, recId: string, v: StreamVideo, now: number) {
  const state = v.readyToStream ? 'ready' : v.status?.state === 'error' ? 'error' : v.status?.state === 'inprogress' ? 'inprogress' : 'queued';
  await rt.env.DB.prepare(
    `INSERT INTO stream_videos (rec_id, uid, state, ready, hls, preview, thumbnail, duration, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(rec_id) DO UPDATE SET uid = excluded.uid, state = excluded.state, ready = excluded.ready, hls = excluded.hls, preview = excluded.preview,
       thumbnail = excluded.thumbnail, duration = excluded.duration, error = excluded.error, updated_at = excluded.updated_at`,
  ).bind(recId, UID.test(v.uid) ? v.uid : null, state, v.readyToStream ? 1 : 0, okUrl(v.playback?.hls), okUrl(v.preview), okUrl(v.thumbnail),
    typeof v.duration === 'number' && v.duration > 0 ? v.duration : null, state === 'error' ? (v.status?.errorReasonText || v.status?.errorReasonCode || 'Stream could not process the file').slice(0, 300) : null, now, now).run();
  return getStreamRow(rt, recId);
}

export async function getStreamRow(rt: Pick<Runtime, 'env'>, recId: string) {
  return rt.env.DB.prepare('SELECT * FROM stream_videos WHERE rec_id = ?').bind(recId).first<StreamRow>();
}

/** (a) Copies a finished recording into Stream. Sending one already in Stream (not failed) returns that copy. */
export async function sendToStream(rt: Runtime, recId: string, o: { fetcher?: Fetcher; now?: number } = {}) {
  const cfg = streamConfig(rt.settings);
  if (!cfg.on) return { ok: false as const, error: 'Stream isn’t connected. Paste a Stream API token under Integrations → Video.' };
  if (!rt.env.RECORDINGS) return { ok: false as const, error: 'No recording storage (R2 bucket RECORDINGS) is bound.' };
  const rec = await rt.env.DB.prepare('SELECT r.id, r.r2_key, r.status, r.started_at, m.title FROM room_recordings r LEFT JOIN rooms m ON m.id = r.room_id WHERE r.id = ?')
    .bind(recId).first<{ id: string; r2_key: string; status: string; started_at: number; title: string | null }>();
  if (!rec) return { ok: false as const, error: 'Recording not found.' };
  if (rec.status !== 'ready') return { ok: false as const, error: 'The recording isn’t finished yet.' };
  const prev = await getStreamRow(rt, recId);
  if (prev && prev.uid && prev.state !== 'error') return { ok: true as const, video: prev, already: true };
  const now = o.now ?? Date.now();
  const url = await signedFileUrl(rt, rec.r2_key, STREAM_SOURCE_TTL_MS, { now });
  const name = `${rec.title ?? 'Room recording'} (${new Date(rec.started_at).toISOString().slice(0, 10)})`.slice(0, 200);
  try {
    const v = await api<StreamVideo>(cfg, '/copy', { method: 'POST', body: JSON.stringify({ url, meta: { name, rec_id: recId } }) }, o.fetcher ?? fetch);
    if (!v || !UID.test(String(v.uid))) throw new Error('Stream returned no video id.');
    return { ok: true as const, video: await saveVideo(rt, recId, v, now), already: false };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Stream copy failed';
    await rt.env.DB.prepare(
      `INSERT INTO stream_videos (rec_id, uid, state, ready, error, created_at, updated_at) VALUES (?, NULL, 'error', 0, ?, ?, ?)
       ON CONFLICT(rec_id) DO UPDATE SET state = 'error', ready = 0, error = excluded.error, updated_at = excluded.updated_at`,
    ).bind(recId, error.slice(0, 300), now, now).run();
    return { ok: false as const, error };
  }
}

/** Copies any file at a (signed, short-lived) URL into Stream under a key of our own (e.g. "studio:<video id>"). Re-sending a key that is not failed returns the copy. */
export async function copyUrlToStream(rt: Runtime, key: string, url: string, name: string, o: { fetcher?: Fetcher; now?: number; force?: boolean } = {}) {
  const cfg = streamConfig(rt.settings);
  if (!cfg.on) return { ok: false as const, error: 'Stream isn’t connected. Paste a Stream API token under Integrations → Video.' };
  const prev = await getStreamRow(rt, key);
  if (!o.force && prev && prev.uid && prev.state !== 'error') return { ok: true as const, video: prev, already: true };
  const now = o.now ?? Date.now();
  try {
    const v = await api<StreamVideo>(cfg, '/copy', { method: 'POST', body: JSON.stringify({ url, meta: { name: name.slice(0, 200), rec_id: key } }) }, o.fetcher ?? fetch);
    if (!v || !UID.test(String(v.uid))) throw new Error('Stream returned no video id.');
    return { ok: true as const, video: await saveVideo(rt, key, v, now), already: false };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Stream copy failed';
    await rt.env.DB.prepare(
      `INSERT INTO stream_videos (rec_id, uid, state, ready, error, created_at, updated_at) VALUES (?, NULL, 'error', 0, ?, ?, ?)
       ON CONFLICT(rec_id) DO UPDATE SET state = 'error', ready = 0, error = excluded.error, updated_at = excluded.updated_at`,
    ).bind(key, error.slice(0, 300), now, now).run();
    return { ok: false as const, error };
  }
}

/** Asks Stream for a copy's current state and stores it. */
export async function refreshStream(rt: Runtime, recId: string, o: { fetcher?: Fetcher; now?: number } = {}) {
  const cfg = streamConfig(rt.settings);
  const row = await getStreamRow(rt, recId);
  if (!cfg.on || !row?.uid || row.ready) return row;
  const v = await api<StreamVideo>(cfg, `/${row.uid}`, { method: 'GET' }, o.fetcher ?? fetch);
  return saveVideo(rt, recId, { ...v, uid: row.uid }, o.now ?? Date.now());
}

/** Cron: refreshes copies Stream is still processing (up to 10 per tick, each at most once a minute). */
export async function syncStreamCopies(rt: Runtime, o: { fetcher?: Fetcher; now?: number } = {}) {
  if (!streamConfig(rt.settings).on) return { skipped: 'off' as const };
  const now = o.now ?? Date.now();
  const { results } = await rt.env.DB.prepare("SELECT rec_id FROM stream_videos WHERE ready = 0 AND state IN ('queued', 'inprogress') AND uid IS NOT NULL AND updated_at < ? AND created_at > ? ORDER BY updated_at LIMIT 10")
    .bind(now - 60_000, now - 2 * 86_400_000).all<{ rec_id: string }>();
  let ready = 0;
  for (const r of results) {
    const row = await refreshStream(rt, r.rec_id, o).catch(() => null);
    if (row?.ready) ready++;
  }
  return { checked: results.length, ready };
}

/** Stream copies for a room's recordings, for Funnel HQ → Rooms. */
export async function streamForRoom(rt: Runtime, roomId: string) {
  const { results } = await rt.env.DB.prepare('SELECT s.* FROM stream_videos s JOIN room_recordings r ON r.id = s.rec_id WHERE r.room_id = ?').bind(roomId).all<StreamRow>();
  return { on: streamConfig(rt.settings).on, items: Object.fromEntries(results.map((r) => [r.rec_id, publicRow(r)])) };
}
export const publicRow = (r: StreamRow | null) => (r ? { uid: r.uid, state: r.state, ready: Boolean(r.ready), error: r.error, preview: r.preview, updatedAt: r.updated_at } : null);

// ───────────── (b) the replay page ─────────────

/** The Stream player address for a ready copy (only on a Stream host). */
export function iframeSrc(row: Pick<StreamRow, 'uid' | 'preview'>, customerCode?: string) {
  if (!row.uid || !UID.test(row.uid)) return null;
  if (row.preview) {
    try {
      const u = new URL(row.preview);
      if (u.hostname.startsWith('customer-') && isStreamHost(u.hostname)) return `https://${u.hostname}/${row.uid}/iframe`;
    } catch { /* fall through */ }
  }
  const base = streamBase(row.uid, customerCode);
  return base.startsWith('https://customer-') ? `${base}/iframe` : `https://iframe.videodelivery.net/${row.uid}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const STREAM_COPY = { replayTitle: 'The replay', fileLink: 'Open the recording file instead' };

/** True when the request is someone opening the replay link as a page (not a video tag, a fetch or a range read). */
export function wantsReplayPage(c: Context<AppEnv>) {
  if (c.req.header('range') || c.req.query('raw') === '1') return false;
  const dest = c.req.header('sec-fetch-dest');
  if (dest) return dest === 'document';
  return /text\/html/i.test(c.req.header('accept') ?? '');
}

/** (b) The Stream player page for /rooms/replay/:rid, or null to serve the file as before. */
export async function streamReplayPage(c: Context<AppEnv>, recId: string): Promise<Response | null> {
  const rt = runtimeFrom(c);
  if (!streamConfig(rt.settings).on || !wantsReplayPage(c)) return null;
  const row = await getStreamRow(rt, recId).catch(() => null);
  if (!row || !row.ready) return null;
  const src = iframeSrc(row, rt.settings.STREAM_CUSTOMER_CODE);
  if (!src) return null;
  const frameOrigin = new URL(src).origin;
  const title = await rt.env.DB.prepare('SELECT m.title FROM room_recordings r JOIN rooms m ON m.id = r.room_id WHERE r.id = ?').bind(recId).first<{ title: string }>().catch(() => null);
  const name = title?.title ?? STREAM_COPY.replayTitle;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(name)}</title>
<style>html,body{margin:0;background:#000;color:#f5f5f7;font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:17px;font-weight:600;margin:4px 0 12px}.f{position:relative;padding-top:56.25%}.f iframe{position:absolute;inset:0;width:100%;height:100%;border:0}p{font-size:13px;color:#a1a1a6}a{color:#a1a1a6}</style></head>
<body><main><h1>${esc(name)}</h1><div class="f"><iframe src="${esc(src)}?preload=auto" loading="eager" allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="${esc(name)}"></iframe></div>
<p><a href="?raw=1">${esc(STREAM_COPY.fileLink)}</a></p></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex',
      // Stream's player is allowed only on this page, and only from the host that serves this video.
      'content-security-policy': `default-src 'none'; frame-src ${frameOrigin}; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
    },
  });
}

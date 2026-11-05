import { type Context, Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { BLOB_KINDS, ID_RE, engineStatus, outputKey, verifyBlob } from './editor';
import { driveStatus } from './drive';
import { copyUrlToStream, iframeSrc, refreshStream, streamConfig, type StreamRow } from '../infra/cf-stream';
import { blobUrl } from './editor';
import { brainName, kick, scanDrive, studioFlags } from './pipeline';
import { type EditPlan, cleanMarkers, fmtDuration } from './plan';
import { type EventRow, type VideoRow, addEvent, delState, getState, getVideo, isActive, iso, moveTo, parseJson, patchVideo, retryTarget, setState } from './store';

/**
 * G&L Studio HTTP API (the contract in the Studio brief). Mounted under /admin/api/studio, so requireAdmin runs first:
 * guests can read (GET) and every write is refused for them by the guest gate.
 *
 *   POST   /uploads                      {title, layout, mime, width, height, script_id?} → {id, partSize}
 *   PUT    /uploads/:id/parts/:n         raw body (every part but the last exactly partSize) → {n, etag}
 *   POST   /uploads/:id/complete         {duration_s, markers} → {ok}; raw to Drive, then the edit
 *   POST   /uploads/:id/abort
 *   GET    /videos                       list + last 12 events each, scan, drive, brain, engine
 *   GET    /videos/:id                   full row, all events, plan
 *   GET    /videos/:id/raw|edited|thumb  R2 stream with Range;  /videos/:id/shorts/:n too
 *   POST   /videos/:id/retry | /reedit {notes?};  DELETE /videos/:id (soft)
 *   POST   /scan                         check the Drive folder now
 * And outside admin: /studio/blob/:id/:kind (the editor container's signed links, src/studio/editor.ts).
 */

export const PART_SIZE = 10 * 1024 * 1024;
export const MAX_BYTES = 20 * 1024 ** 3;
export const MAX_PARTS = Math.ceil(MAX_BYTES / PART_SIZE); // 2048
export const LAYOUTS = ['orbit', 'split', 'spotlight', 'stage', 'vertical', 'cinema'] as const;
const MIME_RE = /^video\/(webm|mp4|quicktime|x-matroska)(;[\w=,.\s"-]*)?$/i;

export const STUDIO_COPY = {
  noStorage: 'Studio storage is not connected here, so recordings cannot be saved.',
  notFound: 'That recording was not found.',
  notRecording: 'This recording is already finished.',
  badPart: 'That part number is outside the recording.',
  partSize: `Every part except the last must be exactly ${PART_SIZE} bytes.`,
  tooBig: 'Recordings can be up to 20 GB.',
  missingParts: 'Some parts of the recording never arrived. Record again, or keep the local copy.',
  noRetry: 'This recording cannot be retried.',
  noTranscript: 'This video has not been transcribed yet, so it cannot be edited again.',
};

// ───────────── part checks (pure) ─────────────

/** One part as it arrives: number in range, size within the part size, the total within 20 GB. */
export function checkPart(n: number, size: number, partSize = PART_SIZE): string | null {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) return STUDIO_COPY.badPart;
  if (!(size > 0) || size > partSize) return STUDIO_COPY.partSize;
  if ((n - 1) * partSize + size > MAX_BYTES) return STUDIO_COPY.tooBig;
  return null;
}
/** All parts at completion: 1..N with none missing, every part but the last exactly partSize. Returns the total. */
export function checkParts(parts: Record<string, { e: string; s: number }>, partSize = PART_SIZE): { ok: true; total: number; count: number } | { ok: false; error: string } {
  const ns = Object.keys(parts).map((k) => Number(k.replace(/^p/, ''))).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  if (!ns.length) return { ok: false, error: STUDIO_COPY.missingParts };
  const count = ns[ns.length - 1];
  if (ns.length !== count) return { ok: false, error: STUDIO_COPY.missingParts };
  let total = 0;
  for (const n of ns) {
    const s = parts[`p${n}`].s;
    if (n < count && s !== partSize) return { ok: false, error: STUDIO_COPY.partSize };
    total += s;
  }
  if (total > MAX_BYTES) return { ok: false, error: STUDIO_COPY.tooBig };
  return { ok: true, total, count };
}

// ───────────── shaping rows for the browser ─────────────

const LIST_OMIT = new Set(['plan_json', 'parts_json', 'probe_json', 'upload_id', 'lease_until', 'next_at', 'flow_id', 'analysis_key']);
export function publicRow(v: VideoRow, full = false, stream: { ready: boolean; state: string; iframe: string | null; error: string | null } | null = null) {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) if (full ? !['parts_json', 'lease_until', 'upload_id'].includes(k) : !LIST_OMIT.has(k)) out[k] = val;
  const plan = parseJson<EditPlan | null>(v.plan_json, null);
  out.markers = parseJson(v.markers_json, []);
  out.shorts = parseJson<{ n: number }[]>(v.shorts_json, []).map((s) => ({ ...s, url: `/admin/api/studio/videos/${v.id}/shorts/${s.n}` }));
  out.plan_summary = plan?.summary ?? null;
  out.plan_title = plan?.title ?? null;
  out.edited_duration_s = plan?.keptS ?? null;
  out.raw_url = v.raw_key && v.status !== 'recording' ? `/admin/api/studio/videos/${v.id}/raw` : null;
  out.edited_url = v.edited_key ? `/admin/api/studio/videos/${v.id}/edited` : null;
  out.thumb_url = v.thumb_key ? `/admin/api/studio/videos/${v.id}/thumb` : null;
  out.active = isActive(v.status);
  if (stream) out.stream = stream;
  if (full) { out.plan = plan; out.probe = parseJson(v.probe_json, null); }
  return out;
}

// ───────────── R2 streaming with Range ─────────────

export async function streamObject(c: Context<AppEnv>, bucket: R2Bucket, key: string, contentType: string, download?: string) {
  const range = c.req.header('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  let r2range: R2Range | undefined;
  if (m && (m[1] || m[2])) r2range = m[1] ? { offset: Number(m[1]), ...(m[2] ? { length: Number(m[2]) - Number(m[1]) + 1 } : {}) } : { suffix: Number(m[2]) };
  const obj = await bucket.get(key, r2range ? { range: r2range } : undefined);
  if (!obj || !('body' in obj)) return c.json({ ok: false, error: STUDIO_COPY.notFound }, 404);
  const headers = new Headers({ 'content-type': contentType, 'accept-ranges': 'bytes', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' });
  if (download) headers.set('content-disposition', `attachment; filename="${download.replace(/[^\w .()-]/g, '')}"`);
  if (r2range && obj.range && 'offset' in obj.range) {
    const off = obj.range.offset ?? 0;
    const len = obj.range.length ?? obj.size - off;
    headers.set('content-range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    headers.set('content-length', String(len));
    return new Response((obj as R2ObjectBody).body, { status: 206, headers });
  }
  if (r2range && obj.range && 'suffix' in obj.range) {
    const len = Math.min(obj.size, (obj.range as { suffix: number }).suffix);
    headers.set('content-range', `bytes ${obj.size - len}-${obj.size - 1}/${obj.size}`);
    headers.set('content-length', String(len));
    return new Response((obj as R2ObjectBody).body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response((obj as R2ObjectBody).body, { status: 200, headers });
}

// ───────────── the admin API ─────────────

export const studioAdmin = new Hono<AppEnv>();
const bad = (c: Context<AppEnv>, error: string, status = 400) => c.json({ ok: false, error }, status as 400);
const cleanTitle = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

studioAdmin.post('/uploads', async (c) => {
  const bucket = c.env.STUDIO;
  if (!bucket) return bad(c, STUDIO_COPY.noStorage, 503);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const mime = typeof b.mime === 'string' && MIME_RE.test(b.mime) ? b.mime : 'video/webm';
  const layout = (LAYOUTS as readonly string[]).includes(String(b.layout)) ? String(b.layout) : null;
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 20000 ? Math.round(Number(v)) : null);
  const id = crypto.randomUUID();
  const ext = /mp4/i.test(mime) ? 'mp4' : /quicktime/i.test(mime) ? 'mov' : /matroska/i.test(mime) ? 'mkv' : 'webm';
  const key = `raw/${id}.${ext}`;
  const up = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: mime.split(';')[0] } });
  const now = iso();
  const title = cleanTitle(b.title) || `Recording ${now.slice(0, 16).replace('T', ' ')}`;
  const scriptId = typeof b.script_id === 'string' && /^[\w-]{1,80}$/.test(b.script_id) ? b.script_id : null;
  await c.env.DB.prepare(
    `INSERT INTO studio_videos (id, title, source, layout, created_at, updated_at, width, height, mime, raw_key, upload_id, parts_json, markers_json, script_id, status, progress, stage_detail)
     VALUES (?, ?, 'studio', ?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]', ?, 'recording', 0, 'Recording')`,
  ).bind(id, title, layout, now, now, num(b.width), num(b.height), mime, key, up.uploadId, scriptId).run();
  await addEvent(c.env, id, 'recording', 'Recording started');
  return c.json({ ok: true, id, partSize: PART_SIZE });
});

async function recording(c: Context<AppEnv>) {
  const id = c.req.param('id') ?? '';
  if (!ID_RE.test(id)) return null;
  return getVideo(c.env, id);
}

studioAdmin.put('/uploads/:id/parts/:n{[0-9]{1,5}}', async (c) => {
  const bucket = c.env.STUDIO;
  if (!bucket) return bad(c, STUDIO_COPY.noStorage, 503);
  const v = await recording(c);
  if (!v) return bad(c, STUDIO_COPY.notFound, 404);
  if (v.status !== 'recording' || !v.upload_id || !v.raw_key) return bad(c, STUDIO_COPY.notRecording, 409);
  const n = Number(c.req.param('n'));
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > PART_SIZE) return bad(c, STUDIO_COPY.partSize, 413);
  const body = await c.req.arrayBuffer();
  const problem = checkPart(n, body.byteLength);
  if (problem) return bad(c, problem, problem === STUDIO_COPY.badPart ? 400 : 413);
  const part = await bucket.resumeMultipartUpload(v.raw_key, v.upload_id).uploadPart(n, body);
  // One statement per part (json_set is atomic), so parts arriving in parallel never overwrite each other.
  await c.env.DB.prepare("UPDATE studio_videos SET parts_json = json_set(COALESCE(parts_json, '{}'), ?, json(?)), updated_at = ? WHERE id = ?")
    .bind(`$.p${n}`, JSON.stringify({ e: part.etag, s: body.byteLength }), iso(), v.id).run();
  return c.json({ ok: true, n, etag: part.etag });
});

studioAdmin.post('/uploads/:id/complete', async (c) => {
  const bucket = c.env.STUDIO;
  if (!bucket) return bad(c, STUDIO_COPY.noStorage, 503);
  const v = await recording(c);
  if (!v) return bad(c, STUDIO_COPY.notFound, 404);
  if (v.status !== 'recording' || !v.upload_id || !v.raw_key) return bad(c, STUDIO_COPY.notRecording, 409);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const parts = parseJson<Record<string, { e: string; s: number }>>(v.parts_json, {});
  const chk = checkParts(parts);
  if (!chk.ok) return bad(c, chk.error, 400);
  try {
    await bucket.resumeMultipartUpload(v.raw_key, v.upload_id).complete(Array.from({ length: chk.count }, (_, i) => ({ partNumber: i + 1, etag: parts[`p${i + 1}`].e })));
  } catch (e) {
    return bad(c, `The recording could not be put together: ${e instanceof Error ? e.message : 'storage error'}`, 502);
  }
  const duration = Number(b.duration_s);
  const dur = Number.isFinite(duration) && duration > 0 && duration < 48 * 3600 ? Math.round(duration * 1000) / 1000 : null;
  const markers = cleanMarkers(b.markers, dur ?? Infinity);
  const rt = runtimeFrom(c);
  await moveTo(c.env, v, 'uploaded', { raw_size: chk.total, upload_id: null, parts_json: null, duration_s: dur, markers_json: JSON.stringify(markers), stage_detail: 'Saved' });
  const mk = markers.length ? `, ${markers.length} marker${markers.length === 1 ? '' : 's'}` : '';
  await addEvent(c.env, v.id, 'uploaded', `Recording saved: ${chk.total >= 1e9 ? `${(chk.total / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(chk.total / 1e6))} MB`}${dur ? `, ${fmtDuration(dur)}` : ''}${mk}`);
  await kick(rt, v.id);
  return c.json({ ok: true });
});

studioAdmin.post('/uploads/:id/abort', async (c) => {
  const v = await recording(c);
  if (!v) return bad(c, STUDIO_COPY.notFound, 404);
  if (v.status !== 'recording') return bad(c, STUDIO_COPY.notRecording, 409);
  if (c.env.STUDIO && v.upload_id && v.raw_key) await c.env.STUDIO.resumeMultipartUpload(v.raw_key, v.upload_id).abort().catch(() => {});
  await patchVideo(c.env, v.id, { deleted_at: iso(), upload_id: null, parts_json: null, stage_detail: 'Discarded' });
  await addEvent(c.env, v.id, 'recording', 'Recording discarded');
  return c.json({ ok: true });
});

/** Stream copies of edits (keyed "studio:<id>"), for the players. */
async function streamRows(c: Context<AppEnv>, ids: string[]) {
  const m = new Map<string, { ready: boolean; state: string; iframe: string | null; error: string | null }>();
  if (!ids.length) return m;
  const { results } = await c.env.DB.prepare(`SELECT * FROM stream_videos WHERE rec_id IN (${ids.map(() => '?').join(',')})`).bind(...ids.map((i) => `studio:${i}`)).all<StreamRow>();
  const code = runtimeFrom(c).settings.STREAM_CUSTOMER_CODE || undefined;
  for (const r of results) m.set(r.rec_id.slice(7), { ready: Boolean(r.ready), state: r.state, iframe: r.ready ? iframeSrc(r, code) : null, error: r.error });
  return m;
}
/** Sends a finished edit to Cloudflare Stream for smooth playback anywhere (no-op without a Stream token). */
export async function sendEditToStream(rt: import('../app').Runtime, v: VideoRow, force = false) {
  if (!v.edited_key || !streamConfig(rt.settings).on) return null;
  const url = await blobUrl(rt, v.id, 'edited', 6 * 3_600_000);
  return copyUrlToStream(rt, `studio:${v.id}`, url, `${v.title || 'Studio edit'} (edited)`, { force });
}

studioAdmin.get('/videos', async (c) => {
  const rt = runtimeFrom(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM studio_videos WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100').all<VideoRow>();
  const ids = results.map((r) => r.id);
  const events = new Map<string, EventRow[]>();
  if (ids.length) {
    const { results: ev } = await c.env.DB.prepare(
      `SELECT * FROM (SELECT e.*, ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY id DESC) AS rn FROM studio_events e WHERE video_id IN (${ids.map(() => '?').join(',')})) WHERE rn <= 12 ORDER BY id`,
    ).bind(...ids).all<EventRow & { rn?: number }>();
    for (const e of ev) { delete e.rn; const l = events.get(e.video_id) ?? []; l.push(e); events.set(e.video_id, l); }
  }
  const [last, next, scanError, drive] = await Promise.all([getState(c.env, 'scan_last'), getState(c.env, 'scan_next'), getState(c.env, 'scan_error'), driveStatus(rt)]);
  const flags = studioFlags(rt);
  const streams = await streamRows(c, ids).catch(() => new Map());
  return c.json({
    ok: true,
    stream: { on: streamConfig(rt.settings).on },
    videos: results.map((v) => ({ ...publicRow(v, false, streams.get(v.id) ?? null), events: events.get(v.id) ?? [] })),
    scan: { last, next, error: scanError, everyHours: flags.scanHours },
    drive: { connected: drive.connected, folderId: drive.folderId, folderLink: drive.folderLink, scopeOk: drive.scopeOk, connectUrl: '/admin/api/google/connect?to=studio', configured: Boolean(rt.settings.GOOGLE_CLIENT_ID && rt.settings.GOOGLE_CLIENT_SECRET), redirectUri: `${(rt.settings.PUBLIC_URL || rt.origin).replace(/\/+$/, '')}/oauth/google/callback` },
    brain: brainName(rt),
    engine: engineStatus(rt),
    settings: { autoEdit: flags.autoEdit, captions: flags.captions, shorts: flags.shorts, preset: flags.preset },
  });
});

studioAdmin.get('/videos/:id', async (c) => {
  const v = await recording(c);
  if (!v) return bad(c, STUDIO_COPY.notFound, 404);
  const { results } = await c.env.DB.prepare('SELECT * FROM studio_events WHERE video_id = ? ORDER BY id').bind(v.id).all<EventRow>();
  const rt = runtimeFrom(c);
  // Copies Stream is still processing are refreshed when the sheet is opened.
  await refreshStream(rt, `studio:${v.id}`).catch(() => null);
  const streams = await streamRows(c, [v.id]).catch(() => new Map());
  return c.json({ ok: true, video: publicRow(v, true, streams.get(v.id) ?? null), events: results });
});

// Send (or re-send) an edit to Cloudflare Stream.
studioAdmin.post('/videos/:id/stream', async (c) => {
  const v = await recording(c);
  if (!v || !v.edited_key) return bad(c, STUDIO_COPY.notFound, 404);
  const r = await sendEditToStream(runtimeFrom(c), v, true);
  if (!r) return c.json({ ok: false, error: 'Stream isn’t connected. Add a Stream API token under Integrations → Video.' }, 400);
  return c.json(r.ok ? { ok: true, state: r.video?.state } : { ok: false, error: r.error }, r.ok ? 200 : 502);
});

studioAdmin.get('/videos/:id/raw', async (c) => {
  const v = await recording(c);
  if (!v || !v.raw_key || !c.env.STUDIO || v.status === 'recording') return bad(c, STUDIO_COPY.notFound, 404);
  return streamObject(c, c.env.STUDIO, v.raw_key, v.mime?.split(';')[0] || 'video/webm');
});
studioAdmin.get('/videos/:id/edited', async (c) => {
  const v = await recording(c);
  if (!v || !v.edited_key || !c.env.STUDIO) return bad(c, STUDIO_COPY.notFound, 404);
  return streamObject(c, c.env.STUDIO, v.edited_key, 'video/mp4', c.req.query('download') ? `${(v.title || 'edit').slice(0, 80)} (edited).mp4` : undefined);
});
// The player's copy: the 1080p preview when the master is larger, else the master itself.
studioAdmin.get('/videos/:id/preview', async (c) => {
  const v = await recording(c);
  if (!v || !v.edited_key || !c.env.STUDIO) return bad(c, STUDIO_COPY.notFound, 404);
  const key = `previews/${v.id}.mp4`;
  return streamObject(c, c.env.STUDIO, (await c.env.STUDIO.head(key)) ? key : v.edited_key, 'video/mp4');
});

studioAdmin.get('/videos/:id/thumb', async (c) => {
  const v = await recording(c);
  if (!v || !v.thumb_key || !c.env.STUDIO) return bad(c, STUDIO_COPY.notFound, 404);
  return streamObject(c, c.env.STUDIO, v.thumb_key, 'image/jpeg');
});
studioAdmin.get('/videos/:id/shorts/:n{[1-3]}', async (c) => {
  const v = await recording(c);
  const s = v ? parseJson<{ n: number; key: string }[]>(v.shorts_json, []).find((x) => x.n === Number(c.req.param('n'))) : null;
  if (!v || !s || !c.env.STUDIO) return bad(c, STUDIO_COPY.notFound, 404);
  return streamObject(c, c.env.STUDIO, s.key, 'video/mp4');
});

studioAdmin.post('/videos/:id/retry', async (c) => {
  const v = await recording(c);
  if (!v) return bad(c, STUDIO_COPY.notFound, 404);
  const to = retryTarget(v);
  if (!to) return bad(c, STUDIO_COPY.noRetry, 409);
  await setState(c.env, `go:${v.id}`, '1');
  await delState(c.env, `tries:${v.id}`);
  if (to === 'rendering') await delState(c.env, `render:${v.id}`);
  await moveTo(c.env, v, to, { error: null, failed_stage: null, attempts: (v.attempts ?? 0) + 1, stage_detail: 'Starting again', next_at: null, lease_until: null });
  await addEvent(c.env, v.id, to, v.status === 'skipped' ? 'Editing started by hand' : `Trying again from ${to.replace('_', ' ')}`);
  await kick(runtimeFrom(c), v.id);
  return c.json({ ok: true, status: to });
});

studioAdmin.post('/videos/:id/reedit', async (c) => {
  const v = await recording(c);
  if (!v) return bad(c, STUDIO_COPY.notFound, 404);
  if (!v.transcript_key) return bad(c, STUDIO_COPY.noTranscript, 409);
  if (isActive(v.status) && v.status !== 'planning') return bad(c, 'This video is still being worked on. Wait until it is done, then edit it again.', 409);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const notes = String(b.notes ?? '').replace(/\s+/g, ' ').trim().slice(0, 1500) || null;
  await delState(c.env, `tries:${v.id}`, `render:${v.id}`, `dup:${v.id}:edited`, `dup:${v.id}:short-1`, `dup:${v.id}:short-2`, `dup:${v.id}:short-3`);
  // A new edit is a new Drive file; the old one stays in the folder until the owner removes it.
  await patchVideo(c.env, v.id, { status: 'planning', progress: 0, notes, error: null, failed_stage: null, plan_json: null, drive_edited_id: null, drive_edited_link: null, shorts_json: null, attempts: (v.attempts ?? 0) + 1, stage_detail: 'Planning the edit again', next_at: null, lease_until: null });
  await addEvent(c.env, v.id, 'planning', notes ? `Editing again with your notes: ${notes.slice(0, 200)}` : 'Editing again');
  await kick(runtimeFrom(c), v.id);
  return c.json({ ok: true, status: 'planning' });
});

studioAdmin.delete('/videos/:id', async (c) => {
  const v = await recording(c);
  if (!v) return bad(c, STUDIO_COPY.notFound, 404);
  if (v.status === 'recording' && c.env.STUDIO && v.upload_id && v.raw_key) await c.env.STUDIO.resumeMultipartUpload(v.raw_key, v.upload_id).abort().catch(() => {});
  await patchVideo(c.env, v.id, { deleted_at: iso(), stage_detail: 'Removed from Studio' });
  await addEvent(c.env, v.id, v.status, 'Removed from Studio (Drive files are kept)');
  return c.json({ ok: true });
});

studioAdmin.post('/scan', async (c) => {
  const rt = runtimeFrom(c);
  const r = await scanDrive(rt);
  const [last, next] = await Promise.all([getState(c.env, 'scan_last'), getState(c.env, 'scan_next')]);
  return c.json({ ...r, scan: { last, next } }, r.ok ? 200 : r.reason ? 409 : 502);
});

// ───────────── the editor's signed links (public, outside admin) ─────────────

export function mountStudioBlob(app: Hono<AppEnv>) {
  const handler = async (c: Context<AppEnv>) => {
    const id = c.req.param('id') ?? '', kind = c.req.param('kind') ?? '';
    if (!BLOB_KINDS.test(kind) || !(await verifyBlob(c.env, id, kind, c.req.query('e'), c.req.query('s')))) return c.json({ error: 'not found' }, 404);
    const bucket = c.env.STUDIO;
    const v = await getVideo(c.env, id);
    if (!bucket || !v) return c.json({ error: 'not found' }, 404);
    const m = c.req.method;
    if (kind === 'raw') {
      if (m !== 'GET' && m !== 'HEAD') return c.json({ error: 'method' }, 405);
      if (!v.raw_key || v.status === 'recording') return c.json({ error: 'not found' }, 404);
      return streamObject(c, bucket, v.raw_key, 'application/octet-stream');
    }
    if (kind === 'progress') {
      if (m !== 'POST') return c.json({ error: 'method' }, 405);
      const b = await c.req.json<{ progress?: number; detail?: string; kind?: string }>().catch(() => ({} as { progress?: number; detail?: string; kind?: string }));
      const p = Math.max(0, Math.min(1, Number(b.progress) || 0));
      if (v.status === 'rendering' && b.kind === 'render') await patchVideo(c.env, id, { progress: p, stage_detail: String(b.detail ?? 'Rendering').slice(0, 120) });
      else if (v.status === 'transcribing' && b.kind === 'analyze') await patchVideo(c.env, id, { progress: p * 0.5, stage_detail: String(b.detail ?? 'Reading the recording').slice(0, 120) });
      return c.json({ ok: true });
    }
    // Outputs: thumb, edited, short-1..3.
    const key = outputKey(id, kind);
    if (!key) return c.json({ error: 'not found' }, 404);
    const op = c.req.query('op');
    const ct = kind === 'thumb' ? 'image/jpeg' : 'video/mp4';
    // Reading a finished output (Cloudflare Stream copies the edit from this signed link).
    if (!op && (m === 'GET' || m === 'HEAD') && (kind === 'edited' || kind === 'preview')) {
      if (!(await bucket.head(key))) return c.json({ error: 'not found' }, 404);
      return streamObject(c, bucket, key, ct);
    }
    if (op === 'put' && m === 'PUT') {
      const declared = Number(c.req.header('content-length'));
      if (Number.isFinite(declared) && declared > 95 * 1024 * 1024) return c.json({ error: 'too large' }, 413);
      const body = await c.req.arrayBuffer();
      if (body.byteLength > 95 * 1024 * 1024) return c.json({ error: 'too large' }, 413);
      await bucket.put(key, body, { httpMetadata: { contentType: ct } });
      return c.json({ ok: true, size: body.byteLength });
    }
    if (op === 'start' && m === 'POST') {
      const up = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: ct } });
      return c.json({ ok: true, uploadId: up.uploadId });
    }
    const uploadId = c.req.query('uploadId') ?? '';
    if (!uploadId) return c.json({ error: 'no upload' }, 400);
    if (op === 'part' && m === 'PUT') {
      const n = Number(c.req.query('n'));
      if (!Number.isInteger(n) || n < 1 || n > 10_000) return c.json({ error: 'bad part' }, 400);
      const body = await c.req.arrayBuffer();
      if (!body.byteLength || body.byteLength > 95 * 1024 * 1024) return c.json({ error: 'bad size' }, 413);
      const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(n, body);
      return c.json({ ok: true, etag: part.etag });
    }
    if (op === 'complete' && m === 'POST') {
      const b = await c.req.json<{ parts?: { partNumber: number; etag: string }[] }>().catch(() => ({} as { parts?: { partNumber: number; etag: string }[] }));
      const parts = (b.parts ?? []).filter((p) => Number.isInteger(p?.partNumber) && typeof p?.etag === 'string').sort((a, b2) => a.partNumber - b2.partNumber);
      if (!parts.length) return c.json({ error: 'no parts' }, 400);
      const obj = await bucket.resumeMultipartUpload(key, uploadId).complete(parts);
      return c.json({ ok: true, size: obj.size });
    }
    return c.json({ error: 'bad op' }, 400);
  };
  app.on(['GET', 'HEAD', 'PUT', 'POST'], '/studio/blob/:id/:kind', handler);
}

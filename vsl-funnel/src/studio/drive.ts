import type { Runtime } from '../app';
import { googleAccess, googleReady } from '../content/video-pack';
import { sha256 } from '../lib/crypto';
import { getState, setState, delState } from './store';

/**
 * G&L Studio and Google Drive: the folder (setting STUDIO_DRIVE_FOLDER_ID, default the YOUFUCK folder), the scope
 * check, big uploads and imports in resumable chunks, and the folder scan's de-duplication.
 *
 *  - Uploads use Drive's resumable protocol. Each chunk is read from R2 as a range and streamed (never buffered whole),
 *    chunks are multiples of 256 KiB, and the session URL and offset are kept in studio_state after every chunk, so a
 *    failure, a timeout or a restart carries on from the last byte Drive confirmed.
 *  - Imports (a video the owner put in the folder by hand) are copied into R2 with ranged downloads into a multipart
 *    upload, one part per chunk, resumable the same way.
 *  - Every file we create carries appProperties glStudio=1, so the scan never imports our own raw, edit or shorts.
 */

export const YOUFUCK_FOLDER = '1b7U_deRnqGYy-suFJJDcmNANmnG8Xf4p';
export const DRIVE_SCOPE_FULL = 'https://www.googleapis.com/auth/drive';
export const CHUNK = 64 * 1024 * 1024; // 64 MiB: a multiple of 256 KiB, within the Worker's memory when streamed
export const QUANTUM = 256 * 1024;
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

type Fetch = typeof fetch;
export const folderId = (rt: Pick<Runtime, 'settings'>) => ((rt.settings as Record<string, string>).STUDIO_DRIVE_FOLDER_ID || '').trim() || YOUFUCK_FOLDER;
export const folderLink = (id: string) => `https://drive.google.com/drive/folders/${id}`;

export class DriveError extends Error {
  constructor(message: string, readonly status = 0, readonly retryable = true) { super(message); }
}
async function driveJson<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } | string };
  if (!r.ok) {
    const msg = typeof j.error === 'string' ? j.error : j.error?.message ?? `HTTP ${r.status}`;
    throw new DriveError(`Google Drive: ${msg}`, r.status, r.status >= 500 || r.status === 429);
  }
  return j;
}

// ───────────── scope ─────────────

/** True when the granted scopes include full Drive (drive.file alone can't list files added by hand). */
export function scopeIncludesDrive(scope: string | null | undefined) {
  return String(scope ?? '').split(/\s+/).includes(DRIVE_SCOPE_FULL);
}

export interface DriveStatus { connected: boolean; scopeOk: boolean; folderId: string; folderLink: string; error?: string }

/** Google connected? With the right scope? Cached 10 minutes per connection. */
export async function driveStatus(rt: Pick<Runtime, 'env' | 'settings'>, o: { fetcher?: Fetch; fresh?: boolean; now?: number } = {}): Promise<DriveStatus> {
  const fid = folderId(rt);
  const base = { folderId: fid, folderLink: folderLink(fid) };
  if (!googleReady(rt as Runtime)) return { connected: false, scopeOk: false, ...base };
  const now = o.now ?? Date.now();
  const print = (await sha256(`studio-scope|${rt.settings.GOOGLE_REFRESH_TOKEN}`)).slice(0, 16);
  const cached = await getState<{ print: string; ok: boolean; at: number }>(rt.env, 'drive_scope', true);
  if (!o.fresh && cached && cached.print === print && now - cached.at < 10 * 60_000) return { connected: true, scopeOk: cached.ok, ...base };
  const f = o.fetcher ?? fetch;
  try {
    const token = await googleAccess(rt as Runtime, f);
    const r = await f(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    const j = (await r.json().catch(() => ({}))) as { scope?: string };
    const ok = r.ok && scopeIncludesDrive(j.scope);
    await setState(rt.env, 'drive_scope', { print, ok, at: now });
    return { connected: true, scopeOk: ok, ...base };
  } catch (e) {
    return { connected: true, scopeOk: false, ...base, error: e instanceof Error ? e.message : 'Google did not answer' };
  }
}

// ───────────── listing and the scan's de-duplication ─────────────

export interface DriveFile { id: string; name: string; mimeType?: string; size?: string; createdTime?: string; modifiedTime?: string; webViewLink?: string; appProperties?: Record<string, string> }

export async function listFolderVideos(token: string, folder: string, f: Fetch = fetch): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({
      q: `'${folder.replace(/'/g, '')}' in parents and trashed = false and mimeType contains 'video/'`,
      fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, appProperties)',
      pageSize: '200', orderBy: 'createdTime desc', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const j = await driveJson<{ files?: DriveFile[]; nextPageToken?: string }>(await f(`${API}/files?${q}`, { headers: { authorization: `Bearer ${token}` } }));
    out.push(...(j.files ?? []));
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return out;
}

const OURS_NAME = /\((edited|raw|short)\b/i;
/** Files in the folder worth importing: videos we don't know (by Drive id), not made by Studio, with a size. */
export function pickNewFiles(files: DriveFile[], known: Set<string>): DriveFile[] {
  const seen = new Set<string>();
  return files.filter((x) => {
    if (!x.id || known.has(x.id) || seen.has(x.id)) return false;
    seen.add(x.id);
    if (x.appProperties?.glStudio) return false;
    if (OURS_NAME.test(x.name ?? '')) return false;
    if (!/^video\//.test(x.mimeType ?? '') && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(x.name ?? '')) return false;
    return Number(x.size) > 0;
  });
}

// ───────────── resumable upload: R2 → Drive ─────────────

export interface UploadSpec { stateKey: string; bucket: R2Bucket; key: string; size: number; name: string; mime: string; folder: string; studioId: string; kind: string; description?: string }
interface UpState { uri: string; offset: number; size: number; at: number }
export interface UploadResult { done: boolean; offset: number; size: number; id?: string; link?: string }

/** The next byte Drive wants, from a 308's Range header ("bytes=0-1234" means 1235). */
export function nextOffset(range: string | null): number {
  const m = /bytes=\d+-(\d+)/.exec(range ?? '');
  return m ? Number(m[1]) + 1 : 0;
}

/** A body of exactly `len` bytes streamed from an R2 range read (buffers only in tests, where FixedLengthStream is missing). */
async function sizedBody(body: ReadableStream | null | undefined, len: number, fallback: () => Promise<ArrayBuffer>): Promise<BodyInit> {
  const FLS = (globalThis as unknown as { FixedLengthStream?: new (n: number) => { readable: ReadableStream; writable: WritableStream } }).FixedLengthStream;
  if (FLS && body) {
    const { readable, writable } = new FLS(len);
    body.pipeTo(writable).catch((e) => console.error('studio: stream pipe failed', e instanceof Error ? e.message : e));
    return readable;
  }
  return fallback();
}

async function startSession(token: string, s: UploadSpec, f: Fetch): Promise<string> {
  const meta = { name: s.name, parents: [s.folder], mimeType: s.mime, description: s.description, appProperties: { glStudio: '1', glStudioId: s.studioId, glStudioKind: s.kind } };
  const r = await f(`${UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': s.mime, 'x-upload-content-length': String(s.size) },
    body: JSON.stringify(meta),
  });
  if (!r.ok) await driveJson(r);
  const uri = r.headers.get('location');
  if (!uri) throw new DriveError('Google Drive did not start the upload');
  return uri;
}

/** Asks Drive how much of the upload it has. */
async function sessionStatus(uri: string, size: number, f: Fetch): Promise<{ offset: number; done?: { id: string; link?: string } } | 'gone'> {
  const r = await f(uri, { method: 'PUT', headers: { 'content-range': `bytes */${size}` } });
  if (r.status === 308) return { offset: nextOffset(r.headers.get('range')) };
  if (r.status === 200 || r.status === 201) { const j = (await r.json().catch(() => ({}))) as { id?: string; webViewLink?: string }; return { offset: size, done: { id: j.id ?? '', link: j.webViewLink } }; }
  if (r.status === 404 || r.status === 410) return 'gone';
  throw new DriveError(`Google Drive: upload status ${r.status}`, r.status, true);
}

/**
 * Uploads (or carries on uploading) one R2 object to the folder, for up to `budgetMs`. Returns where it got to.
 * Call again until done; every chunk Drive confirms is remembered.
 */
export async function driveUploadStep(rt: Pick<Runtime, 'env' | 'settings'>, s: UploadSpec, o: { budgetMs?: number; chunk?: number; fetcher?: Fetch; now?: () => number } = {}): Promise<UploadResult> {
  const f = o.fetcher ?? fetch;
  const clock = o.now ?? Date.now;
  const started = clock();
  const chunk = Math.max(QUANTUM, Math.floor((o.chunk ?? CHUNK) / QUANTUM) * QUANTUM);
  const token = await googleAccess(rt as Runtime, f);
  let st = await getState<UpState>(rt.env, s.stateKey, true);
  if (st && st.size !== s.size) st = null;
  if (st) {
    // Re-sync with Drive before sending (the last chunk may have landed without us hearing back).
    const now = await sessionStatus(st.uri, s.size, f).catch((e) => { throw e; });
    if (now === 'gone') st = null;
    else if (now.done) { await delState(rt.env, s.stateKey); return { done: true, offset: s.size, size: s.size, id: now.done.id, link: now.done.link }; }
    else st.offset = now.offset;
  }
  if (!st) {
    st = { uri: await startSession(token, s, f), offset: 0, size: s.size, at: clock() };
    await setState(rt.env, s.stateKey, st);
  }
  while (st.offset < s.size) {
    if (clock() - started > (o.budgetMs ?? 25_000)) return { done: false, offset: st.offset, size: s.size };
    const len = Math.min(chunk, s.size - st.offset);
    const obj = await s.bucket.get(s.key, { range: { offset: st.offset, length: len } });
    if (!obj || !('body' in obj)) throw new DriveError('The recording is missing from Studio storage.', 0, false);
    const body = await sizedBody((obj as R2ObjectBody).body, len, () => (obj as R2ObjectBody).arrayBuffer());
    let r: Response;
    try {
      r = await f(st.uri, { method: 'PUT', headers: { 'content-range': `bytes ${st.offset}-${st.offset + len - 1}/${s.size}`, 'content-type': s.mime }, body });
    } catch (e) {
      throw new DriveError(`Google Drive: upload interrupted (${e instanceof Error ? e.message : 'network'}); it will carry on from ${st.offset} bytes`, 0, true);
    }
    if (r.status === 308) {
      st.offset = nextOffset(r.headers.get('range'));
      st.at = clock();
      await setState(rt.env, s.stateKey, st);
      continue;
    }
    if (r.status === 200 || r.status === 201) {
      const j = (await r.json().catch(() => ({}))) as { id?: string; webViewLink?: string };
      await delState(rt.env, s.stateKey);
      return { done: true, offset: s.size, size: s.size, id: j.id, link: j.webViewLink ?? (j.id ? `https://drive.google.com/file/d/${j.id}/view` : undefined) };
    }
    if (r.status === 404 || r.status === 410) {
      await delState(rt.env, s.stateKey);
      throw new DriveError('Google Drive: the upload session ended; starting it again', r.status, true);
    }
    // 5xx / 429 / anything else: ask where Drive got to, keep that, and let the caller back off.
    const now = await sessionStatus(st.uri, s.size, f).catch(() => null);
    if (now && now !== 'gone' && !now.done) { st.offset = now.offset; await setState(rt.env, s.stateKey, st); }
    throw new DriveError(`Google Drive: upload chunk answered ${r.status}`, r.status, r.status >= 500 || r.status === 429);
  }
  // Every byte sent but no final answer: ask.
  const end = await sessionStatus(st.uri, s.size, f);
  if (end !== 'gone' && end.done) { await delState(rt.env, s.stateKey); return { done: true, offset: s.size, size: s.size, id: end.done.id, link: end.done.link }; }
  throw new DriveError('Google Drive: the upload did not finish; trying again', 0, true);
}

// ───────────── import: Drive → R2 ─────────────

export interface ImportSpec { bucket: R2Bucket; key: string; size: number; fileId: string; mime: string; uploadId: string | null; parts: Record<string, { e: string; s: number }>; partSize: number }
export interface ImportResult { done: boolean; uploadId: string; parts: Record<string, { e: string; s: number }>; copied: number }

/** Copies a Drive file into R2 in parts of `partSize`, carrying on from the parts already done, for up to `budgetMs`. */
export async function driveImportStep(rt: Pick<Runtime, 'env' | 'settings'>, s: ImportSpec, o: { budgetMs?: number; fetcher?: Fetch; now?: () => number } = {}): Promise<ImportResult> {
  const f = o.fetcher ?? fetch;
  const clock = o.now ?? Date.now;
  const started = clock();
  const token = await googleAccess(rt as Runtime, f);
  const up = s.uploadId ? s.bucket.resumeMultipartUpload(s.key, s.uploadId) : await s.bucket.createMultipartUpload(s.key, { httpMetadata: { contentType: s.mime } });
  const parts = { ...s.parts };
  const count = Math.max(1, Math.ceil(s.size / s.partSize));
  const copied = () => Object.values(parts).reduce((a, p) => a + p.s, 0);
  for (let n = 1; n <= count; n++) {
    if (parts[`p${n}`]) continue;
    if (clock() - started > (o.budgetMs ?? 25_000)) return { done: false, uploadId: up.uploadId, parts, copied: copied() };
    const a = (n - 1) * s.partSize;
    const len = Math.min(s.partSize, s.size - a);
    const r = await f(`${API}/files/${encodeURIComponent(s.fileId)}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}`, range: `bytes=${a}-${a + len - 1}` } });
    if (r.status !== 206 && !(r.status === 200 && a === 0 && len === s.size)) {
      if (!r.ok) await driveJson(r);
      throw new DriveError(`Google Drive: download answered ${r.status} without the range`, r.status, true);
    }
    const body = await sizedBody(r.body, len, () => r.arrayBuffer());
    const part = await up.uploadPart(n, body as ReadableStream);
    parts[`p${n}`] = { e: part.etag, s: len };
  }
  await up.complete(Array.from({ length: count }, (_, i) => ({ partNumber: i + 1, etag: parts[`p${i + 1}`].e })));
  return { done: true, uploadId: up.uploadId, parts, copied: s.size };
}

/** Drive file name: "<date> <title> (raw).<ext>" / "(edited, 4K).mp4" / "(short 2).mp4". */
export function driveName(date: string, title: string, tag: string, ext: string) {
  const t = (title || 'Recording').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${date} ${t} (${tag}).${ext}`;
}

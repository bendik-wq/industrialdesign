import { beforeEach, describe, expect, it } from 'vitest';
import type { Runtime } from '../src/app';
import { CHUNK, QUANTUM, YOUFUCK_FOLDER, driveImportStep, driveName, driveStatus, driveUploadStep, folderId, nextOffset, pickNewFiles, scopeIncludesDrive } from '../src/studio/drive';
import { GOOGLE_SCOPE, googleAuthUrl } from '../src/content/video-pack';
import { type SqlDb, d1, fakeGoogle, fakeR2, freshDb } from './studio-fakes';

// G&L Studio and Google Drive: the scope check, the folder scan's de-duplication, and big files moved in resumable
// chunks that survive a failed chunk and a restart.

let sdb: SqlDb;
const settings = (o: Record<string, string> = {}) => ({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'refresh-1', STUDIO_DRIVE_FOLDER_ID: '', ...o }) as unknown as Runtime['settings'];
const rtWith = (o: Record<string, string> = {}) => ({ env: { DB: d1(sdb) } as unknown as Runtime['env'], settings: settings(o) });
beforeEach(() => { sdb = freshDb(); });

describe('scope', () => {
  it('the OAuth request asks for full Drive (one scope)', () => {
    expect(GOOGLE_SCOPE).toBe('https://www.googleapis.com/auth/drive');
    expect(new URL(googleAuthUrl('c', 'https://a.test', 's')).searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive');
  });
  it('scopeIncludesDrive: drive.file alone is not enough', () => {
    expect(scopeIncludesDrive('https://www.googleapis.com/auth/drive.file')).toBe(false);
    expect(scopeIncludesDrive('openid https://www.googleapis.com/auth/drive')).toBe(true);
    expect(scopeIncludesDrive(undefined)).toBe(false);
  });
  it('driveStatus: not connected, wrong scope (asks to reconnect), right scope; cached per connection', async () => {
    expect(await driveStatus({ env: rtWith().env, settings: settings({ GOOGLE_REFRESH_TOKEN: '' }) })).toMatchObject({ connected: false, scopeOk: false, folderId: YOUFUCK_FOLDER });
    const old = fakeGoogle({ scope: 'https://www.googleapis.com/auth/drive.file' });
    expect(await driveStatus(rtWith(), { fetcher: old.fetch })).toMatchObject({ connected: true, scopeOk: false });
    // Cached for 10 minutes for the same connection...
    const good = fakeGoogle();
    expect((await driveStatus(rtWith(), { fetcher: good.fetch })).scopeOk).toBe(false);
    expect(good.calls).toEqual([]);
    // ...but a new connection (new refresh token) is checked at once.
    expect((await driveStatus(rtWith({ GOOGLE_REFRESH_TOKEN: 'refresh-2' }), { fetcher: good.fetch })).scopeOk).toBe(true);
  });
  it('the folder defaults to YOUFUCK and can be changed', () => {
    expect(folderId({ settings: settings() })).toBe('1b7U_deRnqGYy-suFJJDcmNANmnG8Xf4p');
    expect(folderId({ settings: settings({ STUDIO_DRIVE_FOLDER_ID: ' abc ' }) })).toBe('abc');
  });
});

describe('scan de-duplication', () => {
  it('new videos only: unknown Drive ids, not ours (app property or name), with a size, each once', () => {
    const files = [
      { id: 'a', name: 'Talk.mp4', mimeType: 'video/mp4', size: '100' },
      { id: 'a', name: 'Talk.mp4', mimeType: 'video/mp4', size: '100' },
      { id: 'b', name: '2026-11-04 Talk (raw).webm', mimeType: 'video/webm', size: '100' },
      { id: 'c', name: '2026-11-04 Talk (edited, 4K).mp4', mimeType: 'video/mp4', size: '100' },
      { id: 'd', name: 'Mine.mp4', mimeType: 'video/mp4', size: '100', appProperties: { glStudio: '1' } },
      { id: 'e', name: 'Known.mp4', mimeType: 'video/mp4', size: '100' },
      { id: 'f', name: 'Empty.mp4', mimeType: 'video/mp4', size: '0' },
      { id: 'g', name: 'notes.pdf', mimeType: 'application/pdf', size: '100' },
      { id: 'h', name: 'phone.MOV', mimeType: 'application/octet-stream', size: '100' },
    ];
    expect(pickNewFiles(files, new Set(['e'])).map((f) => f.id)).toEqual(['a', 'h']);
  });
  it('Drive names', () => {
    expect(driveName('2026-11-04', 'Seller finance: part 1/2', 'edited, 4K', 'mp4')).toBe('2026-11-04 Seller finance part 1 2 (edited, 4K).mp4');
    expect(driveName('2026-11-04', '', 'raw', 'webm')).toBe('2026-11-04 Recording (raw).webm');
  });
});

describe('resumable upload R2 → Drive', () => {
  it('chunks are multiples of 256 KiB; Range header parsing', () => {
    expect(CHUNK % QUANTUM).toBe(0);
    expect(CHUNK).toBeGreaterThanOrEqual(32 * 1024 * 1024);
    expect(nextOffset('bytes=0-262143')).toBe(262144);
    expect(nextOffset(null)).toBe(0);
  });
  it('uploads in chunks, survives a failed chunk, resumes from what Drive confirmed, and lands byte for byte', async () => {
    const r2 = fakeR2();
    const size = QUANTUM * 5 + 1234;
    const src = Uint8Array.from({ length: size }, (_, i) => (i * 7) % 251);
    await r2.put('raw/x.webm', src);
    const g = fakeGoogle();
    const rt = rtWith();
    const spec = { stateKey: 'dup:x:raw', bucket: r2 as unknown as R2Bucket, key: 'raw/x.webm', size, name: 'n (raw).webm', mime: 'video/webm', folder: 'F', studioId: 'x', kind: 'raw' };
    // A budget that allows about two chunks per call.
    let t = 0;
    const clock = () => (t += 10);
    const first = await driveUploadStep(rt, spec, { chunk: QUANTUM, fetcher: g.fetch, budgetMs: 45, now: clock });
    expect(first.done).toBe(false);
    expect(first.offset).toBe(QUANTUM * 2);
    expect(JSON.parse((sdb.prepare("SELECT value FROM studio_state WHERE key = 'dup:x:raw'").get() as { value: string }).value)).toMatchObject({ offset: QUANTUM * 2 });
    // Drive fails the next chunk: the error is retryable and the offset kept.
    g.failNext(1);
    await expect(driveUploadStep(rt, spec, { chunk: QUANTUM, fetcher: g.fetch, budgetMs: 1e9 })).rejects.toThrow(/answered 503/);
    // The next call asks Drive where it got to and carries on to the end.
    const done = await driveUploadStep(rt, spec, { chunk: QUANTUM, fetcher: g.fetch, budgetMs: 1e9 });
    expect(done).toMatchObject({ done: true, offset: size });
    expect(g.created).toHaveLength(1);
    expect(Buffer.from(g.created[0].bytes).equals(Buffer.from(src))).toBe(true);
    expect(g.created[0].meta).toMatchObject({ name: 'n (raw).webm', parents: ['F'], appProperties: { glStudio: '1', glStudioId: 'x', glStudioKind: 'raw' } });
    expect(g.calls.filter((c) => c.startsWith('POST https://www.googleapis.com/upload')).length).toBe(1); // one session for the whole file
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM studio_state WHERE key = 'dup:x:raw'").get()).toEqual({ n: 0 });
  });
});

describe('import Drive → R2', () => {
  it('copies in parts, resumable across calls, and completes the multipart upload', async () => {
    const size = 2 * 1000 + 77;
    const src = Uint8Array.from({ length: size }, (_, i) => (i * 13) % 255);
    const g = fakeGoogle({ media: { F1: src } });
    const r2 = fakeR2();
    const rt = rtWith();
    let t = 0;
    const spec = { bucket: r2 as unknown as R2Bucket, key: 'raw/y.mp4', size, fileId: 'F1', mime: 'video/mp4', uploadId: null as string | null, parts: {} as Record<string, { e: string; s: number }>, partSize: 1000 };
    const a = await driveImportStep(rt, spec, { fetcher: g.fetch, budgetMs: 25, now: () => (t += 10) });
    expect(a.done).toBe(false);
    expect(Object.keys(a.parts)).toEqual(['p1', 'p2']);
    const b = await driveImportStep(rt, { ...spec, uploadId: a.uploadId, parts: a.parts }, { fetcher: g.fetch, budgetMs: 1e9 });
    expect(b.done).toBe(true);
    expect(Buffer.from(r2.objs.get('raw/y.mp4')!.b).equals(Buffer.from(src))).toBe(true);
  });
});

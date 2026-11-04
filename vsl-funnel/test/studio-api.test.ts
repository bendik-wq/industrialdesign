import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { type SqlDb, d1, fakeAi, fakeEditor, fakeGoogle, fakeR2 } from './studio-fakes';
import { freshDb } from './studio-fakes';

// G&L Studio end to end on an in-memory D1: the upload API (multipart, part sizes, guests refused), the list view,
// the status machine, and the pipeline from a finished recording to "done" with the editor, Whisper and the planner
// faked (the real editor container is tested separately in Docker), with and without Google Drive.

const ORIGIN = 'https://apply.test';
let sdb: SqlDb;
let r2: ReturnType<typeof fakeR2>;
let editor: ReturnType<typeof fakeEditor> | null;
let ai: ReturnType<typeof fakeAi> | null;
const pend: Promise<unknown>[] = [];
const exCtx = { waitUntil: (p: Promise<unknown>) => { pend.push(p.catch(() => null)); }, passThroughOnException: () => {} };
const settle = async () => { while (pend.length) await Promise.all(pend.splice(0)); };
const envFor = (o: { storage?: boolean } = {}) => ({
  DB: d1(sdb), SESSION_SECRET: 'studio-test-secret-'.padEnd(40, 'x'), ADMIN_PASSWORD: 'devpass-owner',
  ASSETS: { fetch: async () => new Response('<!doctype html><html><body>HQ</body></html>', { headers: { 'content-type': 'text/html' } }) },
  ...(o.storage === false ? {} : { STUDIO: r2 }),
  ...(editor ? { STUDIO_EDITOR: editor.ns } : {}),
  ...(ai ? { AI: ai } : {}),
});
type App = { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> };
let app: App;
let storage = true;
const call = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', '198.51.100.9');
  return app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), envFor({ storage }), exCtx);
};
const same = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
const json = { ...same, 'content-type': 'application/json' };
let owner = '';
async function login() {
  const res = await call('/admin/login', { method: 'POST', headers: { ...same, 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=devpass-owner' });
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('_fa=')) ?? '';
}
const api = (path: string, init: RequestInit & { cookie?: string } = {}) => call(`/admin/api/studio${path}`, { ...init, headers: { ...(init.method && init.method !== 'GET' ? json : same), cookie: init.cookie ?? owner, ...(init.headers as Record<string, string> | undefined) } });
const PART = 10 * 1024 * 1024;

beforeAll(async () => {
  vi.stubGlobal('HTMLRewriter', class { on() { return this; } transform(r: Response) { return r; } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"offline"}', { status: 503 })));
  app = (await import('../src/index')).default as unknown as App;
}, 60_000);
beforeEach(async () => {
  sdb = freshDb();
  r2 = fakeR2();
  editor = null; ai = null; storage = true;
  pend.length = 0;
  (await import('../src/settings')).resetSettingsCache();
  (await import('../src/lib/hq-cache')).memoryClear();
  (await import('../src/studio/pipeline')).setStudioFetch(undefined);
  (await import('../src/studio/pipeline')).setStudioBrain(null);
  owner = await login();
  expect(owner).not.toBe('');
});
afterEach(async () => { await settle(); });

async function record(o: { parts?: number[]; markers?: unknown[] } = {}) {
  const res = await api('/uploads', { method: 'POST', body: JSON.stringify({ title: 'Seller finance, explained', layout: 'orbit', mime: 'video/webm;codecs=vp9,opus', width: 3840, height: 2160 }) });
  expect(res.status).toBe(200);
  const { id, partSize } = (await res.json()) as { id: string; partSize: number };
  expect(partSize).toBe(PART);
  const sizes = o.parts ?? [PART, 1234];
  for (let i = 0; i < sizes.length; i++) {
    const r = await api(`/uploads/${id}/parts/${i + 1}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(sizes[i]) });
    expect(r.status, `part ${i + 1}`).toBe(200);
  }
  return id;
}
const row = (id: string) => sdb.prepare('SELECT * FROM studio_videos WHERE id = ?').get(id) as Record<string, unknown>;
const events = (id: string) => (sdb.prepare('SELECT message FROM studio_events WHERE video_id = ? ORDER BY id').all(id) as { message: string }[]).map((e) => e.message);
async function rtFor(): Promise<Runtime> {
  const env = envFor() as unknown as Runtime['env'];
  const settings = await (await import('../src/settings')).loadSettings(env);
  return { env, settings, reps: [], origin: ORIGIN, waitUntil: (p) => { pend.push(p.catch(() => null)); } };
}
/** Drives a video through the pipeline (the Workflow / cron would), ignoring the waits. */
async function drive(id: string, max = 60) {
  const { advance } = await import('../src/studio/pipeline');
  await settle();
  for (let i = 0; i < max; i++) {
    const rt = await rtFor();
    const r = await advance(rt, id);
    await settle();
    if (r.done) return r;
  }
  throw new Error(`did not finish: ${row(id).status} ${row(id).stage_detail}`);
}
async function setSettings(kv: Record<string, string>) {
  for (const [k, v] of Object.entries(kv)) sdb.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v, Date.now());
  (await import('../src/settings')).resetSettingsCache();
}

describe('part sizes (pure)', () => {
  it('checkPart and checkParts', async () => {
    const { checkPart, checkParts, MAX_PARTS, STUDIO_COPY } = await import('../src/studio/routes');
    expect(MAX_PARTS).toBe(2048);
    expect(checkPart(1, PART)).toBeNull();
    expect(checkPart(0, 10)).toBe(STUDIO_COPY.badPart);
    expect(checkPart(2049, 10)).toBe(STUDIO_COPY.badPart);
    expect(checkPart(3, PART + 1)).toBe(STUDIO_COPY.partSize);
    expect(checkPart(3, 0)).toBe(STUDIO_COPY.partSize);
    expect(checkParts({ p1: { e: 'a', s: PART }, p2: { e: 'b', s: 5 } })).toEqual({ ok: true, total: PART + 5, count: 2 });
    expect(checkParts({ p1: { e: 'a', s: PART }, p3: { e: 'b', s: 5 } })).toEqual({ ok: false, error: STUDIO_COPY.missingParts });
    expect(checkParts({ p1: { e: 'a', s: 5 }, p2: { e: 'b', s: 5 } })).toEqual({ ok: false, error: STUDIO_COPY.partSize });
    expect(checkParts({})).toEqual({ ok: false, error: STUDIO_COPY.missingParts });
    for (const s of Object.values(STUDIO_COPY)) expect(auditCopy(s), s).toEqual([]);
  });
});

describe('status machine (pure)', () => {
  it('moves forward only, fails from anywhere active, retries from the failed stage within what the data allows', async () => {
    const { canMove, retryTarget, STATUSES } = await import('../src/studio/store');
    expect(STATUSES).toEqual(['recording', 'uploaded', 'in_drive', 'queued', 'transcribing', 'planning', 'rendering', 'delivering', 'done', 'failed', 'skipped']);
    expect(canMove('recording', 'uploaded')).toBe(true);
    expect(canMove('uploaded', 'done')).toBe(false);
    expect(canMove('done', 'rendering')).toBe(false);
    expect(canMove('done', 'planning')).toBe(true); // re-edit
    for (const s of ['uploaded', 'in_drive', 'queued', 'transcribing', 'planning', 'rendering', 'delivering']) expect(canMove(s, 'failed')).toBe(true);
    const base = { status: 'failed', source: 'studio', raw_key: 'raw/x', upload_id: null, transcript_key: 't', plan_json: '{}', edited_key: 'e' } as const;
    expect(retryTarget({ ...base, failed_stage: 'rendering' })).toBe('rendering');
    expect(retryTarget({ ...base, failed_stage: 'delivering', edited_key: null })).toBe('rendering');
    expect(retryTarget({ ...base, failed_stage: 'rendering', plan_json: null })).toBe('planning');
    expect(retryTarget({ ...base, failed_stage: 'planning', transcript_key: null })).toBe('queued');
    expect(retryTarget({ ...base, failed_stage: 'recording' })).toBeNull();
    expect(retryTarget({ ...base, status: 'done', failed_stage: null })).toBeNull();
    expect(retryTarget({ ...base, status: 'skipped', failed_stage: null })).toBe('in_drive');
  });
});

describe('upload API', () => {
  it('starts a multipart upload, takes parts during the recording, completes, and queues the edit', async () => {
    const id = await record({ markers: [] });
    expect(row(id)).toMatchObject({ status: 'recording', source: 'studio', layout: 'orbit', raw_key: `raw/${id}.webm`, width: 3840, height: 2160 });
    const res = await api(`/uploads/${id}/complete`, { method: 'POST', body: JSON.stringify({ duration_s: 61.5, markers: [{ t: 10, kind: 'retake' }, { t: 30, kind: 'chapter', label: 'Part two' }, { t: 99, kind: 'bad' }] }) });
    expect(res.status).toBe(200);
    await settle();
    const v = row(id);
    expect(v.raw_size).toBe(PART + 1234);
    expect(JSON.parse(String(v.markers_json))).toEqual([{ t: 10, kind: 'retake' }, { t: 30, kind: 'chapter', label: 'Part two' }]);
    expect(r2.objs.get(`raw/${id}.webm`)!.b.length).toBe(PART + 1234);
    // No Drive, no editor here: it is queued and waits, saying why.
    expect(v.status).toBe('queued');
    expect(String(v.stage_detail)).toMatch(/Not available here/);
    expect(events(id)).toEqual(expect.arrayContaining(['Recording started', 'Recording saved: 10 MB, 1 m 2 s, 2 markers', 'Google Drive is not connected, so the raw stays in Studio storage', 'Queued for editing']));
  });
  it('refuses parts of the wrong size, out of range, or after completion; a gap fails completion', async () => {
    const r = await api('/uploads', { method: 'POST', body: JSON.stringify({ title: 't', mime: 'video/webm' }) });
    const { id } = (await r.json()) as { id: string };
    expect((await api(`/uploads/${id}/parts/0`, { method: 'PUT', body: new Uint8Array(10) })).status).toBe(400);
    expect((await api(`/uploads/${id}/parts/1`, { method: 'PUT', body: new Uint8Array(PART + 1) })).status).toBe(413);
    expect((await api(`/uploads/${id}/parts/1`, { method: 'PUT', body: new Uint8Array(PART) })).status).toBe(200);
    expect((await api(`/uploads/${id}/parts/3`, { method: 'PUT', body: new Uint8Array(20) })).status).toBe(200);
    const bad = await api(`/uploads/${id}/complete`, { method: 'POST', body: '{}' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/never arrived/);
    // A short part in the middle is refused at completion too.
    expect((await api(`/uploads/${id}/parts/2`, { method: 'PUT', body: new Uint8Array(30) })).status).toBe(200);
    expect(((await (await api(`/uploads/${id}/complete`, { method: 'POST', body: '{}' })).json()) as { error: string }).error).toMatch(/exactly/);
    expect((await api(`/uploads/${id}/parts/2`, { method: 'PUT', body: new Uint8Array(PART) })).status).toBe(200);
    expect((await api(`/uploads/${id}/complete`, { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await api(`/uploads/${id}/parts/4`, { method: 'PUT', body: new Uint8Array(10) })).status).toBe(409);
  });
  it('abort discards; no storage binding answers 503 with a plain sentence', async () => {
    const id = await record({ parts: [PART] });
    expect((await api(`/uploads/${id}/abort`, { method: 'POST', body: '{}' })).status).toBe(200);
    expect(row(id).deleted_at).not.toBeNull();
    expect(r2.uploads.size).toBe(0);
    storage = false;
    const r = await api('/uploads', { method: 'POST', body: JSON.stringify({ title: 't' }) });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toBe('Studio storage is not connected here, so recordings cannot be saved.');
  });
  it('signed out and cross-site writes are refused; guests can read but not write', async () => {
    expect((await api('/videos', { cookie: '' })).status).toBe(401);
    expect((await call('/admin/api/studio/uploads', { method: 'POST', headers: { cookie: owner, origin: 'https://evil.test', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    const inv = await call('/admin/api/guest-access', { method: 'POST', headers: { ...json, cookie: owner }, body: JSON.stringify({ label: 'Viewer', days: 1 }) });
    const { url } = (await inv.json()) as { url: string };
    const open = await call(new URL(url).pathname, { headers: { 'sec-fetch-site': 'cross-site' } });
    const guest = (open.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('_fg=')) ?? '';
    expect(guest).not.toBe('');
    expect((await api('/videos', { cookie: guest })).status).toBe(200);
    for (const [path, method] of [['/uploads', 'POST'], ['/uploads/x/parts/1', 'PUT'], ['/scan', 'POST'], ['/videos/x/retry', 'POST'], ['/videos/x/reedit', 'POST'], ['/videos/x', 'DELETE']] as const) {
      expect((await api(path, { method, cookie: guest, body: '{}' })).status, `${method} ${path}`).toBe(403);
    }
  });
});

describe('list view', () => {
  it('rows without the big JSON, the last 12 events each, scan, Drive, brain and engine', async () => {
    const id = await record();
    for (let i = 0; i < 15; i++) sdb.prepare("INSERT INTO studio_events (video_id, at, stage, message) VALUES (?, '2026-11-04T00:00:00Z', 'x', ?)").run(id, `e${i}`);
    const d = (await (await api('/videos')).json()) as Record<string, any>;
    expect(d.videos).toHaveLength(1);
    const v = d.videos[0];
    expect(v.events).toHaveLength(12);
    expect(v.events[11].message).toBe('e14');
    expect(v).not.toHaveProperty('plan_json');
    expect(v).not.toHaveProperty('parts_json');
    expect(v).toMatchObject({ id, status: 'recording', title: 'Seller finance, explained', raw_url: null, markers: [], shorts: [] });
    expect(d.drive).toEqual({ connected: false, folderId: '1b7U_deRnqGYy-suFJJDcmNANmnG8Xf4p', folderLink: 'https://drive.google.com/drive/folders/1b7U_deRnqGYy-suFJJDcmNANmnG8Xf4p', scopeOk: false, connectUrl: '/admin/api/google/connect?to=studio' });
    expect(d.brain).toBe('workers-ai');
    expect(d.engine.ready).toBe(false);
    expect(d.engine.detail).toMatch(/^Not available here: /);
    expect(auditCopy(d.engine.detail)).toEqual([]);
    expect(d.scan).toMatchObject({ last: null, next: null, everyHours: 6 });
    const full = (await (await api(`/videos/${id}`)).json()) as Record<string, any>;
    expect(full.events.length).toBe(16);
    expect(full.video).toHaveProperty('plan');
  });
});

describe('the pipeline', () => {
  it('a 4K recording: transcribed, planned by Workers AI, rendered at 3840x2160, done (Drive not connected)', async () => {
    editor = fakeEditor(r2);
    ai = fakeAi();
    const id = await record();
    await api(`/uploads/${id}/complete`, { method: 'POST', body: JSON.stringify({ duration_s: 60, markers: [{ t: 30, kind: 'highlight', label: 'Key point' }] }) });
    const r = await drive(id);
    expect(r.status).toBe('done');
    const v = row(id);
    expect(v).toMatchObject({ status: 'done', progress: 1, plan_brain: 'workers-ai', edited_key: `edited/${id}.mp4`, edited_width: 3840, edited_height: 2160, width: 3840, height: 2160, duration_s: 60, thumb_key: `thumbs/${id}.jpg` });
    const plan = JSON.parse(String(v.plan_json));
    expect(plan.title).toBe('The deal');
    // Silence 40-50 and the filler "Um" are cut even though the planner kept everything.
    expect(plan.removed.map((x: { reason: string }) => x.reason).sort()).toEqual(['filler', 'filler', 'silence']); // one "Um" per 30 s chunk
    expect(plan.clips[0]).toMatchObject({ title: 'Key point' });
    expect(JSON.parse(String(v.shorts_json))[0]).toMatchObject({ n: 1, key: `shorts/${id}-1.mp4`, width: 1080, height: 1920 });
    expect(r2.objs.has(`transcripts/${id}.json`)).toBe(true);
    // What the container was asked: analyse, then a render whose links are signed and point at this Worker.
    const jobs = editor.seen.filter((s) => s.path === '/jobs').map((s) => s.body!);
    expect(jobs.map((j) => j.kind)).toEqual(['analyze', 'render']);
    expect(String(jobs[1].rawUrl)).toMatch(new RegExp(`^${ORIGIN}/studio/blob/${id}/raw\\?e=\\d+&s=[0-9a-f]{40}$`));
    expect((jobs[1].uploads as { kind: string }[]).map((u) => u.kind)).toEqual(['edited', 'short-1']);
    const msgs = events(id);
    expect(msgs).toEqual(expect.arrayContaining([
      'Read the recording: 3840x2160, 30 fps, 1 m 0 s, 10 s of silence',
      'Transcribed 14 words',
      'Rendering at 3840x2160, 30 fps, with captions, plus 1 short',
      'Edit ready in Studio. Google Drive is not connected, so it was not copied to the folder',
    ]));
    expect(msgs.find((m) => m.startsWith('Cut '))).toMatch(/^Cut 10 s of silence and 2 filler words\. Planned by Workers AI; the edit runs /);
    for (const m of msgs) expect(auditCopy(m), m).toEqual([]);
    // The editor's disk is freed when done.
    expect(editor.seen.some((s) => s.method === 'DELETE' && s.path === `/work/${id}`)).toBe(true);
  });

  it('with Drive: raw goes up first, the edit and the short after, named with the resolution', async () => {
    editor = fakeEditor(r2);
    ai = fakeAi();
    const g = fakeGoogle();
    (await import('../src/studio/pipeline')).setStudioFetch(g.fetch);
    (await import('../src/studio/pipeline')).setStudioBrain(async () => JSON.stringify({ title: 'Claude title', description: 'a\nb', keep: [{ in: 0, out: 60 }], removed: [{ in: 20, out: 21, reason: 'false start' }], clips: [{ in: 5, out: 45, title: 'Clip' }] }));
    await setSettings({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'tok' });
    const id = await record();
    await api(`/uploads/${id}/complete`, { method: 'POST', body: JSON.stringify({ duration_s: 60, markers: [] }) });
    await drive(id);
    const v = row(id);
    const day = String(v.created_at).slice(0, 10);
    expect(g.created.map((f) => f.name)).toEqual([`${day} Seller finance, explained (raw).webm`, `${day} Claude title (edited, 4K).mp4`, `${day} Claude title (short 1).mp4`]);
    expect(v).toMatchObject({ status: 'done', plan_brain: 'claude', drive_raw_id: g.created[0].id, drive_edited_id: g.created[1].id });
    expect(String(v.drive_edited_link)).toContain(g.created[1].id);
    expect(events(id)).toEqual(expect.arrayContaining(['Uploaded the raw recording to Drive', 'Uploaded the edit to Drive', 'Uploaded 1 short to Drive', 'Done: the edit is in the Drive folder']));
  });

  it('a failing render retries with backoff, then fails with a plain error; Retry starts again from rendering', async () => {
    editor = fakeEditor(r2, { failRender: 'ffmpeg exited 1: out of disk' });
    ai = fakeAi({ failPlan: true }); // and the planner is down: the rules plan is used
    const id = await record();
    await api(`/uploads/${id}/complete`, { method: 'POST', body: JSON.stringify({ duration_s: 60 }) });
    const r = await drive(id, 80);
    expect(r.status).toBe('failed');
    const v = row(id);
    expect(v).toMatchObject({ status: 'failed', failed_stage: 'rendering', plan_brain: 'rules' });
    expect(String(v.error)).toBe('The render failed: ffmpeg exited 1: out of disk');
    expect(events(id).filter((m) => m.startsWith('Hit a problem'))).toHaveLength(1);
    // Fixed: retry from rendering.
    editor = fakeEditor(r2);
    const res = await api(`/videos/${id}/retry`, { method: 'POST', body: '{}' });
    expect(await res.json()).toEqual({ ok: true, status: 'rendering' });
    expect((await drive(id)).status).toBe('done');
    expect(row(id).attempts).toBe(1);
  });

  it('re-edit with notes plans again from the transcript (the notes reach the planner)', async () => {
    editor = fakeEditor(r2);
    ai = fakeAi();
    const id = await record();
    await api(`/uploads/${id}/complete`, { method: 'POST', body: JSON.stringify({ duration_s: 60 }) });
    await drive(id);
    let seen = '';
    (await import('../src/studio/pipeline')).setStudioBrain(async (_rt, ask) => { seen = ask.user; return JSON.stringify({ title: 'Second cut', keep: [{ in: 0, out: 60 }] }); });
    expect((await api(`/videos/${id}/reedit`, { method: 'POST', body: JSON.stringify({ notes: 'Start at the numbers' }) })).status).toBe(200);
    await drive(id);
    expect(seen).toContain("Owner's notes for this edit: Start at the numbers");
    expect(JSON.parse(String(row(id).plan_json)).title).toBe('Second cut');
    expect(row(id).status).toBe('done');
  });
});

describe('the Drive folder scan', () => {
  it('imports new videos once, skips our own files, copies them in and edits them; due every STUDIO_SCAN_HOURS', async () => {
    editor = fakeEditor(r2);
    ai = fakeAi();
    const media = new Uint8Array(3000).fill(7);
    const g = fakeGoogle({ media: { HAND1: media }, files: [
      { id: 'HAND1', name: 'Board meeting.mp4', mimeType: 'video/mp4', size: '3000', webViewLink: 'https://drive.test/HAND1' },
      { id: 'OURS', name: 'x (edited, 4K).mp4', mimeType: 'video/mp4', size: '10', appProperties: { glStudio: '1' } },
    ] });
    const p = await import('../src/studio/pipeline');
    p.setStudioFetch(g.fetch);
    await setSettings({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'tok', STUDIO_SCAN_HOURS: '6' });
    const rt = await rtFor();
    const t0 = Date.parse('2026-11-04T10:00:00Z');
    expect(await p.scanDue(rt, t0)).toBe(true);
    const first = await p.studioTick(rt, t0);
    expect(first.scan).toMatchObject({ ok: true, found: 2, imported: 1 });
    expect(await p.scanDue(rt, t0 + 5 * 3600_000)).toBe(false);
    expect(await p.scanDue(rt, t0 + 6 * 3600_000)).toBe(true);
    // A manual scan finds nothing new.
    const again = (await (await api('/scan', { method: 'POST', body: '{}' })).json()) as { imported: number; scan: { next: string } };
    expect(again.imported).toBe(0);
    const v = sdb.prepare("SELECT * FROM studio_videos WHERE source = 'drive'").get() as Record<string, unknown>;
    expect(v).toMatchObject({ drive_raw_id: 'HAND1', title: 'Board meeting', raw_size: 3000 });
    await drive(String(v.id));
    const done = row(String(v.id));
    expect(done.status).toBe('done');
    expect(r2.objs.get(`raw/${v.id}.mp4`)!.b.length).toBe(3000);
    expect(g.created.map((f) => f.name)).toEqual([expect.stringMatching(/^\d{4}-\d\d-\d\d The deal \(edited, 4K\)\.mp4$/), expect.stringMatching(/ The deal \(short 1\)\.mp4$/)]);
    expect(events(String(v.id))[0]).toBe('Found in the Drive folder: Board meeting.mp4 (1 MB)');
  });
  it('with automatic editing off, found videos wait as skipped until Edit is pressed', async () => {
    const g = fakeGoogle({ files: [{ id: 'H2', name: 'Call.mov', mimeType: 'video/quicktime', size: '50' }] });
    const p = await import('../src/studio/pipeline');
    p.setStudioFetch(g.fetch);
    await setSettings({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'tok', STUDIO_AUTO_EDIT: 'off' });
    expect((await p.scanDrive(await rtFor())).imported).toBe(1);
    const v = sdb.prepare("SELECT * FROM studio_videos WHERE drive_raw_id = 'H2'").get() as Record<string, unknown>;
    expect(v).toMatchObject({ status: 'skipped', stage_detail: 'Automatic editing is off. Press Edit to start.' });
    expect(await (await api(`/videos/${v.id}/retry`, { method: 'POST', body: '{}' })).json()).toEqual({ ok: true, status: 'in_drive' });
  });
  it('a drive.file connection asks to reconnect instead of scanning', async () => {
    const g = fakeGoogle({ scope: 'https://www.googleapis.com/auth/drive.file' });
    const p = await import('../src/studio/pipeline');
    p.setStudioFetch(g.fetch);
    await setSettings({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'tok' });
    const r = await p.scanDrive(await rtFor());
    expect(r).toMatchObject({ ok: false, reason: 'Connect Google Drive again with full Drive access.' });
  });
});

describe('the editor\'s signed links', () => {
  it('raw with Range for a valid link; anything tampered or expired is a 404; outputs go into R2', async () => {
    const id = await record({ parts: [PART, 100] });
    await api(`/uploads/${id}/complete`, { method: 'POST', body: '{}' });
    await settle();
    const { blobUrl } = await import('../src/studio/editor');
    const rt = { env: envFor() as unknown as Runtime['env'], origin: ORIGIN };
    const raw = await blobUrl(rt, id, 'raw', 60_000);
    const res = await call(raw.slice(ORIGIN.length), { headers: { range: 'bytes=10-19' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 10-19/${PART + 100}`);
    expect((await res.arrayBuffer()).byteLength).toBe(10);
    expect((await call(raw.slice(ORIGIN.length).replace(/s=[0-9a-f]+/, `s=${'0'.repeat(40)}`))).status).toBe(404);
    expect((await call((await blobUrl(rt, id, 'raw', -1000)).slice(ORIGIN.length))).status).toBe(404);
    expect((await call((await blobUrl(rt, id, 'raw', 60_000)).slice(ORIGIN.length).replace('/raw?', '/edited?'))).status).toBe(404);
    // Multipart output upload.
    const ed = (await blobUrl(rt, id, 'edited', 60_000)).slice(ORIGIN.length);
    const st = (await (await call(`${ed}&op=start`, { method: 'POST', body: '{}' })).json()) as { uploadId: string };
    const p1 = (await (await call(`${ed}&op=part&n=1&uploadId=${st.uploadId}`, { method: 'PUT', body: new Uint8Array(500) })).json()) as { etag: string };
    expect((await call(`${ed}&op=complete&uploadId=${st.uploadId}`, { method: 'POST', body: JSON.stringify({ parts: [{ partNumber: 1, etag: p1.etag }] }) })).status).toBe(200);
    expect(r2.objs.get(`edited/${id}.mp4`)!.b.length).toBe(500);
  });
});

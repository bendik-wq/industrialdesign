// Shared fakes for the G&L Studio tests (test/studio-*.test.ts): a real SQLite D1 with every migration, an R2 bucket
// with ranges and multipart uploads, Google Drive (OAuth, tokeninfo, list, resumable uploads, ranged downloads),
// the editor container and Workers AI. Nothing leaves the process.

interface SqlStmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
export interface SqlDb { prepare(sql: string): SqlStmt; exec(sql: string): void }
const nodeP = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = nodeP.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => SqlDb };
const nfs = nodeP.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };

export function d1(db: SqlDb) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const st = {
      sql,
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => { const r = db.prepare(sql).run(...norm()); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select|\breturning\b/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
export function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${nodeP.cwd()}/migrations`;
  for (const f of nfs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(nfs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

const enc = (s: string) => new TextEncoder().encode(s);
async function bytes(b: unknown): Promise<Uint8Array> {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (typeof b === 'string') return enc(b);
  return new Uint8Array(await new Response(b as BodyInit).arrayBuffer());
}
const concat = (list: Uint8Array[]) => { const out = new Uint8Array(list.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of list) { out.set(x, o); o += x.length; } return out; };

export function fakeR2() {
  const objs = new Map<string, { b: Uint8Array; type?: string }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  let seq = 0;
  const mp = (key: string, uploadId: string) => ({
    key, uploadId,
    uploadPart: async (n: number, b: unknown) => { const u = uploads.get(uploadId); if (!u) throw new Error('no such upload'); u.parts.set(n, await bytes(b)); return { partNumber: n, etag: `etag-${n}` }; },
    complete: async (parts: { partNumber: number; etag: string }[]) => {
      const u = uploads.get(uploadId); if (!u) throw new Error('no such upload');
      const all = concat(parts.map((p) => { const x = u.parts.get(p.partNumber); if (!x || p.etag !== `etag-${p.partNumber}`) throw new Error('bad part'); return x; }));
      objs.set(key, { b: all }); uploads.delete(uploadId); return { key, size: all.length };
    },
    abort: async () => { uploads.delete(uploadId); },
  });
  return {
    objs, uploads,
    head: async (k: string) => (objs.has(k) ? { key: k, size: objs.get(k)!.b.length } : null),
    get: async (k: string, o?: { range?: { offset?: number; length?: number; suffix?: number } }) => {
      const e = objs.get(k); if (!e) return null;
      let off = 0, len = e.b.length;
      if (o?.range) {
        if (typeof o.range.suffix === 'number') { len = Math.min(e.b.length, o.range.suffix); off = e.b.length - len; }
        else { off = o.range.offset ?? 0; len = o.range.length ?? e.b.length - off; }
      }
      const slice = e.b.slice(off, off + len);
      return { key: k, size: e.b.length, range: o?.range ? (typeof o.range.suffix === 'number' ? { suffix: o.range.suffix } : { offset: off, length: len }) : undefined, body: new Response(slice).body, arrayBuffer: async () => slice.buffer, text: async () => new TextDecoder().decode(slice), httpMetadata: { contentType: e.type } };
    },
    put: async (k: string, v: unknown, o?: { httpMetadata?: { contentType?: string } }) => { const b = await bytes(v); objs.set(k, { b, type: o?.httpMetadata?.contentType }); return { key: k, size: b.length }; },
    delete: async (k: string) => { objs.delete(k); },
    createMultipartUpload: async (k: string) => { const id = `up-${++seq}`; uploads.set(id, { key: k, parts: new Map() }); return mp(k, id); },
    resumeMultipartUpload: (k: string, id: string) => mp(k, id),
  };
}
export type FakeR2 = ReturnType<typeof fakeR2>;

/** Google: OAuth refresh, tokeninfo, files.list, resumable uploads (with an optional failure), ranged downloads. */
export function fakeGoogle(o: { scope?: string; files?: Record<string, unknown>[]; media?: Record<string, Uint8Array> } = {}) {
  const sessions = new Map<string, { meta: Record<string, unknown>; size: number; got: Uint8Array[]; received: number; done?: { id: string } }>();
  const created: { id: string; name: string; size: number; bytes: Uint8Array; meta: Record<string, unknown> }[] = [];
  const calls: string[] = [];
  let failNextChunk = 0;
  let seq = 0;
  const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init.method ?? 'GET').toUpperCase();
    const h = new Headers(init.headers);
    calls.push(`${method} ${url.split('?')[0]}`);
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return json({ scope: o.scope ?? 'https://www.googleapis.com/auth/drive' });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'AT' });
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) return json({ files: o.files ?? [] });
    const media = /drive\/v3\/files\/([^?]+)\?alt=media/.exec(url);
    if (media) {
      const b = o.media?.[decodeURIComponent(media[1])]; if (!b) return json({ error: { message: 'not found' } }, 404);
      const m = /bytes=(\d+)-(\d+)/.exec(h.get('range') ?? '');
      if (!m) return new Response(b, { status: 200 });
      const a = Number(m[1]), z = Math.min(b.length - 1, Number(m[2]));
      return new Response(b.slice(a, z + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${z}/${b.length}` } });
    }
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) {
      const uri = `https://upload.test/session/${++seq}`;
      sessions.set(uri, { meta: JSON.parse(String(init.body)), size: Number(h.get('x-upload-content-length')), got: [], received: 0 });
      return new Response(null, { status: 200, headers: { location: uri } });
    }
    const s = sessions.get(url);
    if (s && method === 'PUT') {
      const cr = h.get('content-range') ?? '';
      const st = /bytes \*\/(\d+)/.exec(cr);
      const status = () => (s.done ? json({ id: s.done.id, webViewLink: `https://drive.test/${s.done.id}` }, 200) : new Response(null, { status: 308, headers: s.received ? { range: `bytes=0-${s.received - 1}` } : {} }));
      if (st) return status();
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(cr)!;
      const body = await bytes(init.body);
      if (failNextChunk > 0) { failNextChunk--; return json({ error: { message: 'backend error' } }, 503); }
      if (Number(m[1]) !== s.received) return new Response(null, { status: 308, headers: { range: `bytes=0-${s.received - 1}` } });
      s.got.push(body); s.received += body.length;
      if (s.received >= s.size) {
        const id = `drv-${seq}-${created.length + 1}`; s.done = { id };
        created.push({ id, name: String(s.meta.name), size: s.size, bytes: concat(s.got), meta: s.meta });
        return status();
      }
      return status();
    }
    return json({ error: { message: `unexpected ${method} ${url}` } }, 500);
  }) as typeof fetch;
  return { fetch: f, created, calls, sessions, failNext: (n = 1) => { failNextChunk = n; } };
}

/** The editor container: analyse and render finish on the first poll; the render "uploads" its outputs into R2. */
export function fakeEditor(r2: FakeR2, o: { probe?: Record<string, unknown>; chunks?: number; failRender?: string; loseJobs?: boolean } = {}) {
  const jobs = new Map<string, { kind: string; body: Record<string, unknown>; polls: number }>();
  const seen: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const probe = { duration: 60, width: 3840, height: 2160, fps: 30, rFps: 30, hasAudio: true, vcodec: 'h264', ...o.probe };
  const handle = async (_name: string, req: Request) => {
    const u = new URL(req.url);
    const body = req.method === 'POST' ? (await req.json()) as Record<string, unknown> : undefined;
    seen.push({ path: u.pathname, method: req.method, body });
    const j = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (req.method === 'POST' && u.pathname === '/jobs') { jobs.set(String(body!.id), { kind: String(body!.kind), body: body!, polls: 0 }); return j({ ok: true }, 202); }
    const m = /^\/jobs\/(.+)$/.exec(u.pathname);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job || o.loseJobs) return j({ error: 'no job' }, 404);
      job.polls++;
      if (job.polls < 2) return j({ kind: job.kind, state: 'running', progress: 0.4, detail: 'Working' });
      if (job.kind === 'analyze') {
        const n = o.chunks ?? 2;
        return j({ kind: 'analyze', state: 'done', progress: 1, detail: 'Done', result: { probe, silences: [{ start: 40, end: 50 }], chunks: Array.from({ length: n }, (_, i) => ({ n: i, file: `000${i}.mp3`, start: i * 30, end: (i + 1) * 30 })), thumb: true } });
      }
      if (o.failRender) return j({ kind: 'render', state: 'failed', progress: 0.2, detail: 'x', error: o.failRender });
      const uploads = job.body.uploads as { file: string; kind: string }[];
      for (const up of uploads) await r2.put(up.kind === 'edited' ? `edited/${m[1]}.mp4` : `shorts/${m[1]}-${up.kind.split('-')[1]}.mp4`, new Uint8Array(up.kind === 'edited' ? 3000 : 700));
      return j({ kind: 'render', state: 'done', progress: 1, detail: 'Rendered', result: { outputs: uploads.map((up) => ({ file: up.file, size: up.kind === 'edited' ? 3000 : 700, probe: up.kind === 'edited' ? { ...probe, duration: 41 } : { ...probe, width: 1080, height: 1920 } })), timings: [{ name: 'render', ms: 1000, fps: 30, speed: 0.5 }] } });
    }
    if (/^\/files\/[^/]+\/audio\//.test(u.pathname)) return new Response(new Uint8Array(4000), { status: 200 });
    if (req.method === 'DELETE') return j({ ok: true });
    return j({ error: 'not found' }, 404);
  };
  const ns = { idFromName: (n: string) => n, get: (id: string) => ({ fetch: (req: Request) => handle(id, req) }) };
  return { ns, jobs, seen };
}

/** Workers AI: Whisper turbo (segments with words) and the Llama planner. */
export function fakeAi(o: { plan?: unknown; failPlan?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    run: async (model: string, input: Record<string, unknown>) => {
      calls.push(model);
      if (model.includes('whisper')) return { text: 'Hello there. Um this is the deal.', segments: [{ start: 1, end: 6, text: 'Hello there. Um this is the deal.', words: [{ word: 'Hello', start: 1, end: 1.4 }, { word: 'there.', start: 1.5, end: 2 }, { word: 'Um', start: 2.5, end: 2.9 }, { word: 'this', start: 3, end: 3.3 }, { word: 'is', start: 3.4, end: 3.6 }, { word: 'the', start: 3.7, end: 3.9 }, { word: 'deal.', start: 4, end: 4.6 }] }] };
      if (o.failPlan) throw new Error('AI busy');
      void input;
      return { response: JSON.stringify(o.plan ?? { title: 'The deal', description: 'Line one\nLine two', keep: [{ in: 0, out: 60 }], removed: [], chapters: [{ t: 0, title: 'Start' }], clips: [{ in: 5, out: 40, title: 'Clip one' }] }) };
    },
  };
}

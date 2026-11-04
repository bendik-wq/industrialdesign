// G&L Studio editor server (runs in the Cloudflare Container StudioEditor; see src/studio/container.ts).
//
// It is a dumb, careful executor. The Worker decides everything (the edit plan and the exact ffmpeg arguments are
// built by pure, unit-tested functions in src/studio/ffmpeg.ts); this server only:
//   - downloads the raw recording from a short-lived signed link (Range requests, resumes after a cut), to local disk;
//   - analyses it: ffprobe, silencedetect, 16 kHz mono audio chunks for Whisper, a thumbnail;
//   - renders: runs the ffmpeg steps it is given (two-pass loudnorm: the measure step's numbers fill {loudnorm}),
//     reports progress, and uploads each output back through signed links (R2 multipart on the Worker side).
//
// Endpoints (all JSON):
//   GET  /health                 ffmpeg version, encoders, CPUs, free disk
//   POST /jobs                   { id, kind: 'analyze' | 'render', ... }  starts a job (one per video at a time)
//   GET  /jobs/:id               { state: 'running' | 'done' | 'failed', kind, progress, detail, result?, error? }
//   GET  /files/:id/:name        a file from the video's work folder (audio chunks, thumb)
//   DELETE /work/:id             frees the video's disk
//
// No dependencies beyond node and ffmpeg. Nothing secret is stored: links carry their own short-lived signatures.

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8080);
const WORK = process.env.WORK_DIR || '/work';
const PART = 48 * 1024 * 1024; // upload part size (the Worker accepts up to 95 MiB per request)
const ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/;

/** @type {Map<string, {kind: string, state: string, progress: number, detail: string, result?: unknown, error?: string, started: number, updated: number}>} */
const jobs = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirFor = (id) => join(WORK, id);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ───────────── processes ─────────────

/**
 * Runs a command. onLine gets every stdout/stderr line (ffmpeg writes -progress to stdout and logs to stderr).
 * Resolves with the tail of stderr; rejects with a short message on a non-zero exit.
 */
function run(cmd, args, { onLine, keep = 400 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    let all = '';
    const feed = (buf) => {
      const text = buf.toString();
      all = (all + text).slice(-200_000);
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > keep) tail.shift();
        onLine?.(line);
      }
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ tail, all });
      else reject(new Error(`${cmd} exited ${code}: ${tail.slice(-6).join(' | ').slice(0, 900)}`));
    });
  });
}

async function ffprobe(file) {
  const { all } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const j = JSON.parse(all.slice(all.indexOf('{')));
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const rate = (s) => { const [n, d] = String(s || '0/1').split('/').map(Number); return d ? n / d : 0; };
  let duration = Number(j.format?.duration) || Number(v?.duration) || 0;
  if (!duration) duration = await decodeDuration(file); // MediaRecorder WebM files carry no duration
  return {
    duration,
    width: v ? Number(v.width) : 0,
    height: v ? Number(v.height) : 0,
    fps: v ? rate(v.avg_frame_rate) || rate(v.r_frame_rate) : 0,
    rFps: v ? rate(v.r_frame_rate) : 0,
    vcodec: v?.codec_name || null,
    acodec: a?.codec_name || null,
    hasAudio: Boolean(a),
    sampleRate: a ? Number(a.sample_rate) : 0,
    size: Number(j.format?.size) || 0,
    format: j.format?.format_name || null,
  };
}

async function decodeDuration(file) {
  let last = 0;
  await run('ffmpeg', ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', file, '-map', '0', '-c', 'copy', '-f', 'null', '-'], {
    onLine: (l) => { const m = /^out_time_us=(\d+)/.exec(l); if (m) last = Math.max(last, Number(m[1]) / 1e6); },
  });
  return last;
}

async function ffmpegInfo() {
  const v = await run('ffmpeg', ['-hide_banner', '-version']).then((r) => r.tail[0] || '').catch(() => '');
  const enc = await run('ffmpeg', ['-hide_banner', '-encoders']).then((r) => r.all).catch(() => '');
  let free = null;
  try { const s = await statfs(WORK); free = s.bavail * s.bsize; } catch { /* unknown */ }
  return { version: v, libx264: /libx264/.test(enc), libx265: /libx265/.test(enc), cpus: cpus().length, freeBytes: free };
}

// ───────────── HTTP to the Worker ─────────────

async function withRetry(what, fn, tries = 6) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); } catch (e) {
      err = e;
      log(`${what} failed (try ${i + 1}/${tries}): ${e?.message || e}`);
      await sleep(Math.min(30_000, 1000 * 2 ** i));
    }
  }
  throw new Error(`${what}: ${err?.message || err}`);
}

/** Downloads `url` to `file`, resuming from what is already on disk. `size` is the expected total. */
async function download(url, file, size, onProgress) {
  // A partial file is only resumed when it belongs to the same source (same expected size); otherwise start over.
  const sidecar = `${file}.expect`;
  const expect = existsSync(sidecar) ? readFileSync(sidecar, 'utf8') : null;
  if (existsSync(file) && expect !== String(size)) rmSync(file);
  writeFileSync(sidecar, String(size));
  let have = existsSync(file) ? statSync(file).size : 0;
  if (size && have === size) return;
  if (size && have > size) { rmSync(file); have = 0; }
  await withRetry('download', async () => {
    have = existsSync(file) ? statSync(file).size : 0;
    if (size && have >= size) return;
    const res = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {} });
    if (!(res.status === 200 || res.status === 206)) throw new Error(`HTTP ${res.status}`);
    if (have && res.status === 200) { rmSync(file); have = 0; } // the server ignored the range: start over
    const out = createWriteStream(file, { flags: have ? 'a' : 'w' });
    let got = have;
    let lastTick = 0;
    try {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        got += chunk.length;
        if (Date.now() - lastTick > 1000) { lastTick = Date.now(); onProgress?.(got); }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    const now = statSync(file).size;
    if (size && now < size) throw new Error(`cut off at ${now} of ${size} bytes`);
    onProgress?.(now);
  }, 10);
}

/** Uploads one local file through the Worker's signed upload link (single PUT when small, else multipart). */
async function upload(url, file, contentType) {
  const size = statSync(file).size;
  const op = (o, extra = '') => `${url}${url.includes('?') ? '&' : '?'}op=${o}${extra}`;
  if (size <= PART) {
    const body = readPart(file, 0, size);
    await withRetry(`upload ${file}`, async () => {
      const r = await fetch(op('put'), { method: 'PUT', headers: { 'content-type': contentType || 'application/octet-stream' }, body });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    });
    return { size };
  }
  const start = await withRetry('upload start', async () => {
    const r = await fetch(op('start'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contentType }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  const uploadId = encodeURIComponent(start.uploadId);
  const parts = [];
  for (let n = 1, off = 0; off < size; n++, off += PART) {
    const len = Math.min(PART, size - off);
    const body = readPart(file, off, len);
    const etag = await withRetry(`upload part ${n}`, async () => {
      const r = await fetch(op('part', `&n=${n}&uploadId=${uploadId}`), { method: 'PUT', body });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return (await r.json()).etag;
    });
    parts.push({ partNumber: n, etag });
  }
  await withRetry('upload complete', async () => {
    const r = await fetch(op('complete', `&uploadId=${uploadId}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parts, size }) });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  });
  return { size };
}

function readPart(file, offset, length) {
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(file, 'r');
  try {
    let got = 0;
    while (got < length) { const n = readSync(fd, buf, got, length - got, offset + got); if (!n) break; got += n; }
    return buf.subarray(0, got);
  } finally { closeSync(fd); }
}

/** Progress back to the Worker (best effort; the Worker also polls GET /jobs/:id). */
function makeReporter(job, url) {
  let last = 0;
  return (progress, detail, force = false) => {
    job.progress = Math.max(0, Math.min(1, progress));
    if (detail) job.detail = detail;
    job.updated = Date.now();
    if (!url || (!force && Date.now() - last < 5000)) return;
    last = Date.now();
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ progress: job.progress, detail: job.detail, kind: job.kind }) }).catch(() => {});
  };
}

// ───────────── jobs ─────────────

const parseSilences = (lines) => {
  const out = [];
  let start = null;
  for (const l of lines) {
    const s = /silence_start: (-?[\d.]+)/.exec(l);
    if (s) { start = Math.max(0, Number(s[1])); continue; }
    const e = /silence_end: ([\d.]+)/.exec(l);
    if (e && start !== null) { out.push({ start, end: Number(e[1]) }); start = null; }
  }
  return { out, open: start };
};

async function analyze(id, job, input) {
  const dir = dirFor(id);
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const raw = join(dir, 'raw');
  const report = makeReporter(job, input.progressUrl);
  report(0, 'Fetching the recording', true);
  await download(input.rawUrl, raw, Number(input.rawSize) || 0, (got) => report(0.6 * (input.rawSize ? got / input.rawSize : 0), 'Fetching the recording'));
  report(0.6, 'Reading the recording', true);
  const probe = await ffprobe(raw);
  const chunkS = Math.max(10, Math.min(60, Number(input.chunkSeconds) || 30));
  const db = Number.isFinite(Number(input.silenceDb)) ? Number(input.silenceDb) : -35;
  const minS = Math.max(0.2, Number(input.silenceMin) || 0.6);
  let silences = [];
  let chunks = [];
  if (probe.hasAudio) {
    for (const f of readdirSync(join(dir, 'audio'))) rmSync(join(dir, 'audio', f));
    const lines = [];
    const list = join(dir, 'audio', 'list.csv');
    await run('ffmpeg', [
      '-hide_banner', '-nostats', '-y', '-progress', 'pipe:1', '-i', raw, '-vn',
      '-filter_complex', `[0:a]asplit=2[s][w];[s]silencedetect=n=${db}dB:d=${minS}[so];[w]aresample=16000,aformat=channel_layouts=mono[wo]`,
      '-map', '[so]', '-f', 'null', '-',
      '-map', '[wo]', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'segment', '-segment_time', String(chunkS), '-reset_timestamps', '1',
      '-segment_list', list, '-segment_list_type', 'csv', join(dir, 'audio', '%04d.mp3'),
    ], {
      onLine: (l) => {
        lines.push(l);
        const m = /^out_time_us=(\d+)/.exec(l);
        if (m && probe.duration) report(0.6 + 0.35 * Math.min(1, Number(m[1]) / 1e6 / probe.duration), 'Listening for silences');
      },
      keep: 50,
    });
    const s = parseSilences(lines);
    silences = s.out;
    if (s.open !== null) silences.push({ start: s.open, end: probe.duration });
    const csv = existsSync(list) ? readFileSync(list, 'utf8') : '';
    chunks = csv.split(/\r?\n/).filter(Boolean).map((row, i) => {
      const [file, a, b] = row.split(',');
      return { n: i, file, start: Number(a), end: Number(b) };
    });
  }
  report(0.95, 'Taking a thumbnail', true);
  const at = probe.duration ? Math.min(probe.duration * 0.1, Math.max(0, probe.duration - 0.5)) : 0;
  await run('ffmpeg', ['-hide_banner', '-nostats', '-y', '-ss', String(at), '-i', raw, '-frames:v', '1', '-vf', 'scale=-2:720', '-q:v', '3', join(dir, 'thumb.jpg')]).catch((e) => log('thumb failed', e.message));
  if (input.thumbUrl && existsSync(join(dir, 'thumb.jpg'))) await upload(input.thumbUrl, join(dir, 'thumb.jpg'), 'image/jpeg').catch((e) => log('thumb upload failed', e.message));
  return { probe, silences, chunks, thumb: existsSync(join(dir, 'thumb.jpg')) };
}

/** Turns loudnorm's measure JSON (pass 1) into the pass 2 options (with a leading colon, or '' for a silent track). */
export function loudnormOptions(text) {
  const i = text.lastIndexOf('{');
  const j = text.lastIndexOf('}');
  if (i < 0 || j < i) throw new Error('loudnorm measure printed no numbers');
  const m = JSON.parse(text.slice(i, j + 1));
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  // A silent track measures -inf; fall back to plain one-pass settings then.
  if (!Number.isFinite(Number(m.input_i))) return '';
  return `:measured_I=${n(m.input_i, -24)}:measured_TP=${n(m.input_tp, -2)}:measured_LRA=${n(m.input_lra, 7)}:measured_thresh=${n(m.input_thresh, -34)}:offset=${n(m.target_offset, 0)}:linear=true`;
}

async function render(id, job, input) {
  const dir = dirFor(id);
  mkdirSync(dir, { recursive: true });
  const raw = join(dir, 'raw');
  const report = makeReporter(job, input.progressUrl);
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const uploads = Array.isArray(input.uploads) ? input.uploads : [];
  const totalW = 0.05 + steps.reduce((s, x) => s + (Number(x.weight) || 1), 0) + 0.05 * uploads.length;
  let done = 0;
  report(0, 'Fetching the recording', true);
  await download(input.rawUrl, raw, Number(input.rawSize) || 0, (got) => report((0.05 * (input.rawSize ? got / input.rawSize : 0)) / totalW, 'Fetching the recording'));
  done += 0.05;
  const files = Object.entries(input.files || {});
  for (const [name] of files) if (!NAME_RE.test(name)) throw new Error(`bad file name ${name}`);
  const vars = { raw, dir, loudnorm: '' };
  const fill = (a) => String(a).replace(/\{(raw|dir|loudnorm)\}/g, (_, k) => vars[k]);
  // Files (filter graphs, captions) can use the placeholders too; written again before each step so the
  // measured loudness reaches the render's graph.
  const writeFiles = () => { for (const [name, text] of files) writeFileSync(join(dir, name), fill(text)); };
  const timings = [];
  for (const step of steps) {
    const w = Number(step.weight) || 1;
    const dur = Number(step.durationS) || 0;
    const label = String(step.label || step.name || 'Rendering');
    const args = (step.args || []).map(fill).filter((a) => a !== '');
    writeFiles();
    const t0 = Date.now();
    report(done / totalW, label, true);
    let frames = 0;
    const res = await run('ffmpeg', ['-hide_banner', '-nostats', '-y', '-progress', 'pipe:1', ...args], {
      onLine: (l) => {
        const m = /^out_time_us=(\d+)/.exec(l);
        if (m && dur) report((done + w * Math.min(1, Number(m[1]) / 1e6 / dur)) / totalW, label);
        const f = /^frame=(\d+)/.exec(l);
        if (f) frames = Number(f[1]);
      },
    });
    if (step.measureLoudnorm) vars.loudnorm = loudnormOptions(res.all);
    const ms = Date.now() - t0;
    timings.push({ name: step.name, ms, frames, fps: frames && ms ? Math.round((frames / (ms / 1000)) * 10) / 10 : null, speed: dur && ms ? Math.round((dur / (ms / 1000)) * 100) / 100 : null });
    done += w;
  }
  const outputs = [];
  for (const u of uploads) {
    if (!NAME_RE.test(u.file)) throw new Error(`bad output name ${u.file}`);
    const file = join(dir, u.file);
    if (!existsSync(file)) { if (u.optional) continue; throw new Error(`the render made no ${u.file}`); }
    report(done / totalW, u.label || 'Saving the edit', true);
    const probe = /\.(mp4|mov|mkv|webm)$/.test(u.file) ? await ffprobe(file).catch(() => null) : null;
    if (u.url) await upload(u.url, file, u.contentType);
    outputs.push({ file: u.file, size: statSync(file).size, probe });
    done += 0.05;
  }
  report(1, 'Rendered', true);
  return { outputs, timings };
}

function startJob(id, body) {
  const cur = jobs.get(id);
  if (cur && cur.state === 'running') {
    if (cur.kind === body.kind) return cur;
    throw Object.assign(new Error(`a ${cur.kind} job is running for this video`), { status: 409 });
  }
  const job = { kind: body.kind, state: 'running', progress: 0, detail: 'Starting', started: Date.now(), updated: Date.now() };
  jobs.set(id, job);
  const fn = body.kind === 'analyze' ? analyze : body.kind === 'render' ? render : null;
  if (!fn) { jobs.delete(id); throw Object.assign(new Error('unknown job kind'), { status: 400 }); }
  log(`job ${id} ${body.kind} started`);
  fn(id, job, body).then(
    (result) => { job.state = 'done'; job.result = result; job.progress = 1; job.updated = Date.now(); log(`job ${id} ${body.kind} done in ${Math.round((Date.now() - job.started) / 1000)} s`); },
    (e) => { job.state = 'failed'; job.error = String(e?.message || e).slice(0, 1200); job.updated = Date.now(); log(`job ${id} ${body.kind} failed: ${job.error}`); },
  );
  return job;
}

// ───────────── HTTP server ─────────────

const send = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
};
const readJson = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 64 * 1024 * 1024) reject(new Error('body too large')); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ping' || url.pathname === '/')) return send(res, 200, { ok: true, ...(await ffmpegInfo()), jobs: jobs.size });
    if (req.method === 'POST' && url.pathname === '/jobs') {
      const body = await readJson(req);
      if (!ID_RE.test(String(body.id || ''))) return send(res, 400, { error: 'bad id' });
      const job = startJob(body.id, body);
      return send(res, 202, { ok: true, state: job.state, kind: job.kind });
    }
    if (req.method === 'GET' && p[0] === 'jobs' && p[1] && ID_RE.test(p[1])) {
      const job = jobs.get(p[1]);
      if (!job) return send(res, 404, { error: 'no job' });
      return send(res, 200, job);
    }
    if (req.method === 'GET' && p[0] === 'files' && ID_RE.test(p[1] || '') && p.length >= 3) {
      const rel = p.slice(2);
      if (!rel.every((x) => NAME_RE.test(x) && x !== '..' && x !== '.')) return send(res, 400, { error: 'bad name' });
      const file = join(dirFor(p[1]), ...rel);
      if (!existsSync(file)) return send(res, 404, { error: 'no file' });
      res.writeHead(200, { 'content-type': file.endsWith('.mp3') ? 'audio/mpeg' : file.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream', 'content-length': statSync(file).size });
      return createReadStream(file).pipe(res);
    }
    if (req.method === 'DELETE' && p[0] === 'work' && ID_RE.test(p[1] || '')) {
      const job = jobs.get(p[1]);
      if (job?.state === 'running') return send(res, 409, { error: 'a job is running' });
      rmSync(dirFor(p[1]), { recursive: true, force: true });
      jobs.delete(p[1]);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, e?.status || 500, { error: String(e?.message || e).slice(0, 500) });
  }
});

if (process.env.STUDIO_EDITOR_NO_LISTEN !== '1') {
  mkdirSync(WORK, { recursive: true });
  server.listen(PORT, () => log(`studio editor listening on ${PORT}`));
}

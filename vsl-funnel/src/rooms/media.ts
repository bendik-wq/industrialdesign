import type { Context } from 'hono';
import type { AppEnv, Runtime } from '../app';
import { runtimeFrom } from '../app';
import { type Member, type RoomState, isStaff } from './state';
import { getRoom, isRoomId, readTicket } from './rooms';

/**
 * Rooms, call quality and reliability (area A "media"). The browser side is public/assets/room-media.js (pre-join
 * check, reconnects, device changes, quality, effects) with its pure decisions in room-media-logic.js.
 * Here, on the server:
 *  - reconnect hold: a socket that drops without a goodbye (network change, tunnel, Wi-Fi to 4G) keeps the person's
 *    place for HOLD_MS (stage, hand, spotlight and their media session), so a blip doesn't send a guest back to the
 *    audience or make everyone re-pull their video;
 *  - quality reports: each browser reports its own connection (round trip, loss, jitter, bitrates, tier, device,
 *    path, reconnects); staff get the changes live; the alarm writes the per-person summary to room_media (0056),
 *    shown in Funnel HQ → Rooms;
 *  - the pre-join network test: ping, download and upload against this Worker, with the room ticket.
 */

export const HOLD_MS = 30_000;
/** Close codes that mean the person left on purpose (or was removed): no hold. */
const GOODBYE_CODES = [1000, 1001, 1005, 4003];

type Held = RoomState & { mediaHold?: Record<string, number> };

/** A socket closed. True when the room keeps the person's place for a short while instead of letting them leave. */
export function holdOnClose(st: RoomState, id: string, code: number | undefined, now: number) {
  const m = st.members[id];
  if (!m || m.connected !== 1 || st.status === 'ended' || st.banned.includes(id)) return false;
  if (code !== undefined && GOODBYE_CODES.includes(code)) return false;
  const h = ((st as Held).mediaHold ??= {});
  h[id] = now + HOLD_MS;
  m.lastAt = now;
  return true;
}
/** Whether this person's place is held now (and forgets expired holds). */
export function isHeld(st: RoomState, id: string, now: number) {
  const h = (st as Held).mediaHold;
  if (!h || !(id in h)) return false;
  if (h[id] > now) return true;
  delete h[id];
  return false;
}
/**
 * The person is back within the hold: their held connection is handed to the new socket (join() then counts it
 * once). Returns the media session they still own, or null when there was no hold.
 */
export function resume(st: RoomState, id: string, now: number): { sessionId: string | null } | null {
  if (!isHeld(st, id, now)) return null;
  delete (st as Held).mediaHold![id];
  const m = st.members[id];
  if (!m) return null;
  m.connected = Math.max(0, m.connected - 1);
  return { sessionId: m.sessionId };
}
export const heldIds = (st: RoomState, now: number) => Object.keys((st as Held).mediaHold ?? {}).filter((id) => isHeld(st, id, now));

// ───────────── quality reports ─────────────

export type Level = 'good' | 'fair' | 'poor' | 'bad';
const LEVELS: Level[] = ['good', 'fair', 'poor', 'bad'];
export interface Report {
  level: Level; score: number; rtt: number | null; loss: number | null; jitter: number | null; inKbps: number | null; outKbps: number | null;
  tier: number; why: string | null; rc: number; path: 'sfu' | 'moq' | 'none'; relay: boolean; proto: string | null;
  os: string; browser: string; mobile: boolean; fx: string | null; noise: string | null; pub: boolean;
}
export interface MediaRec {
  who: string; name: string; role: string; leadId: string | null;
  firstAt: number; lastAt: number; samples: number; counts: Record<Level, number>; worst: Level;
  sums: { rtt: number; rttN: number; loss: number; lossN: number; jitter: number; jitterN: number; inK: number; inN: number; outK: number; outN: number };
  audioOnly: number; last: Report; dirty: boolean;
}

const num = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);
const word = (v: unknown, max = 20) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, max) : '');

/** A browser's report, checked and bounded (it's self-reported: only used for diagnostics, never for permissions). */
export function cleanReport(raw: unknown): Report | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!LEVELS.includes(r.level as Level)) return null;
  const path = r.path === 'moq' || r.path === 'sfu' ? r.path : 'none';
  return {
    level: r.level as Level, score: Math.round(num(r.score, 0, 100) ?? 0),
    rtt: num(r.rtt, 0, 60_000), loss: num(r.loss, 0, 1), jitter: num(r.jitter, 0, 60_000), inKbps: num(r.inKbps, 0, 1_000_000), outKbps: num(r.outKbps, 0, 1_000_000),
    tier: Math.round(num(r.tier, 0, 3) ?? 0), why: word(r.why) || null, rc: Math.round(num(r.rc, 0, 10_000) ?? 0), path, relay: r.relay === true, proto: word(r.proto, 8) || null,
    os: word(r.os) || 'other', browser: word(r.browser) || 'other', mobile: r.mobile === true, fx: word(r.fx) || null, noise: word(r.noise) || null, pub: r.pub === true,
  };
}

/** Folds one report into the person's summary. `changed` = what staff should hear about now. */
export function mergeReport(prev: MediaRec | null, rep: Report, m: Pick<Member, 'id' | 'name' | 'role' | 'leadId'>, now: number): { rec: MediaRec; changed: boolean } {
  const rec: MediaRec = prev ? { ...prev, counts: { ...prev.counts }, sums: { ...prev.sums } } : {
    who: m.id, name: m.name, role: m.role, leadId: m.leadId ?? null, firstAt: now, lastAt: now, samples: 0,
    counts: { good: 0, fair: 0, poor: 0, bad: 0 }, worst: 'good',
    sums: { rtt: 0, rttN: 0, loss: 0, lossN: 0, jitter: 0, jitterN: 0, inK: 0, inN: 0, outK: 0, outN: 0 }, audioOnly: 0, last: rep, dirty: true,
  };
  rec.name = m.name; rec.role = m.role;
  rec.lastAt = now; rec.samples++; rec.counts[rep.level]++;
  if (LEVELS.indexOf(rep.level) > LEVELS.indexOf(rec.worst)) rec.worst = rep.level;
  const add = (k: 'rtt' | 'loss' | 'jitter' | 'inK' | 'outK', v: number | null) => { if (v != null) { rec.sums[k] += v; rec.sums[`${k}N` as 'rttN'] += 1; } };
  add('rtt', rep.rtt); add('loss', rep.loss); add('jitter', rep.jitter); add('inK', rep.inKbps); add('outK', rep.outKbps);
  if (rep.tier >= 3) rec.audioOnly++;
  const before = prev?.last;
  const changed = !before || before.level !== rep.level || before.tier !== rep.tier || before.rc !== rep.rc || before.path !== rep.path || before.fx !== rep.fx;
  rec.last = rep; rec.dirty = true;
  return { rec, changed };
}
const avg = (s: number, n: number, digits = 0) => (n ? Math.round((s / n) * 10 ** digits) / 10 ** digits : null);
/** What staff see for one person, live. */
export const staffView = (rec: MediaRec) => ({
  id: rec.who, name: rec.name, level: rec.last.level, score: rec.last.score, rtt: rec.last.rtt, loss: rec.last.loss, jitter: rec.last.jitter, tier: rec.last.tier, why: rec.last.why,
  rc: rec.last.rc, path: rec.last.path, relay: rec.last.relay, os: rec.last.os, browser: rec.last.browser, mobile: rec.last.mobile, at: rec.lastAt,
});

/** Writes the dirty summaries to D1 (from the room's alarm). Returns how many rows it wrote. */
export async function flushReports(db: D1Database, roomId: string, recs: MediaRec[]) {
  const dirty = recs.filter((r) => r.dirty);
  if (!dirty.length) return 0;
  const sql = `INSERT INTO room_media (room_id, who, name, role, lead_id, os, browser, mobile, path, relay, proto, first_at, last_at, samples, reconnects, worst,
      n_good, n_fair, n_poor, n_bad, rtt_avg, loss_avg, jitter_avg, kbps_in_avg, kbps_out_avg, audio_only_samples, fx, noise, last_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, who) DO UPDATE SET name = excluded.name, role = excluded.role, os = excluded.os, browser = excluded.browser, mobile = excluded.mobile,
      path = excluded.path, relay = excluded.relay, proto = excluded.proto, last_at = excluded.last_at, samples = excluded.samples, reconnects = MAX(room_media.reconnects, excluded.reconnects),
      worst = excluded.worst, n_good = excluded.n_good, n_fair = excluded.n_fair, n_poor = excluded.n_poor, n_bad = excluded.n_bad, rtt_avg = excluded.rtt_avg,
      loss_avg = excluded.loss_avg, jitter_avg = excluded.jitter_avg, kbps_in_avg = excluded.kbps_in_avg, kbps_out_avg = excluded.kbps_out_avg,
      audio_only_samples = excluded.audio_only_samples, fx = COALESCE(excluded.fx, room_media.fx), noise = COALESCE(excluded.noise, room_media.noise), last_json = excluded.last_json`;
  const stmts = dirty.map((r) => db.prepare(sql).bind(
    roomId, r.who, r.name, r.role, r.leadId, r.last.os, r.last.browser, r.last.mobile ? 1 : 0, r.last.path, r.last.relay ? 1 : 0, r.last.proto,
    r.firstAt, r.lastAt, r.samples, r.last.rc, r.worst, r.counts.good, r.counts.fair, r.counts.poor, r.counts.bad,
    avg(r.sums.rtt, r.sums.rttN), avg(r.sums.loss, r.sums.lossN, 4), avg(r.sums.jitter, r.sums.jitterN), avg(r.sums.inK, r.sums.inN), avg(r.sums.outK, r.sums.outN),
    r.audioOnly, r.last.fx, r.last.noise, JSON.stringify(r.last),
  ));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  for (const r of dirty) r.dirty = false;
  return dirty.length;
}

/**
 * The room's quality reports, kept in the Durable Object's storage (one key per person, so a big audience
 * doesn't make the room's main state heavy). Used by do.ts.
 */
export class MediaReports {
  constructor(private storage: DurableObjectStorage) {}
  private key = (id: string) => `mq:${id}`;
  async ingest(st: RoomState, memberId: string, raw: unknown, now: number) {
    const m = st.members[memberId];
    const rep = cleanReport(raw);
    if (!m || !rep) return null;
    const prev = (await this.storage.get<MediaRec>(this.key(memberId))) ?? null;
    // At most one report every 2 seconds per person counts.
    if (prev && now - prev.lastAt < 2000) return null;
    const { rec, changed } = mergeReport(prev, rep, m, now);
    await this.storage.put(this.key(memberId), rec);
    return { rec, changed };
  }
  async all(): Promise<MediaRec[]> {
    const map = await this.storage.list<MediaRec>({ prefix: 'mq:', limit: 3000 });
    return [...map.values()];
  }
  /** Staff snapshot: everyone connected now with a report. */
  async snapshot(st: RoomState) {
    return (await this.all()).filter((r) => st.members[r.who]?.connected).map(staffView);
  }
  async flush(db: D1Database, roomId: string) {
    const recs = await this.all();
    const n = await flushReports(db, roomId, recs).catch((e) => { console.error('room media flush', String(e).slice(0, 200)); return 0; });
    if (!n) return 0;
    // Mark what was written as clean, unless a newer report arrived meanwhile (it stays dirty for the next flush).
    const now = await this.storage.get<MediaRec>(recs.map((r) => this.key(r.who)));
    const clean: Record<string, MediaRec> = {};
    for (const r of recs) { const cur = now.get(this.key(r.who)); if (cur && cur.dirty && cur.lastAt === r.lastAt) clean[this.key(r.who)] = { ...cur, dirty: false }; }
    if (Object.keys(clean).length) await this.storage.put(clean);
    return n;
  }
}
/** Who gets live quality updates: staff (host and co-hosts). */
export const wantsQuality = (m: Member | undefined) => Boolean(m && isStaff(m));

// ───────────── Funnel HQ → Rooms → a room: call quality ─────────────

export interface MediaRow {
  who: string; name: string; role: string; os: string | null; browser: string | null; mobile: number; path: string | null; relay: number; proto: string | null;
  first_at: number; last_at: number; samples: number; reconnects: number; worst: string; n_good: number; n_fair: number; n_poor: number; n_bad: number;
  rtt_avg: number | null; loss_avg: number | null; jitter_avg: number | null; kbps_in_avg: number | null; kbps_out_avg: number | null; audio_only_samples: number; fx: string | null; noise: string | null;
}
/** The share of each person's samples at each level, the room's medians, and who had trouble. */
export function summarize(rows: MediaRow[]) {
  const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const people = rows.length;
  const trouble = rows.filter((r) => r.samples > 0 && (r.n_poor + r.n_bad) / r.samples >= 0.25);
  return {
    people,
    medianRtt: med(rows.map((r) => r.rtt_avg).filter((x): x is number => x != null)),
    medianLoss: med(rows.map((r) => r.loss_avg).filter((x): x is number => x != null)),
    reconnects: rows.reduce((a, r) => a + (r.reconnects || 0), 0),
    relayed: rows.filter((r) => r.relay).length,
    trouble: trouble.length,
    byPath: rows.reduce<Record<string, number>>((a, r) => { const k = r.path || 'none'; a[k] = (a[k] ?? 0) + 1; return a; }, {}),
  };
}
export async function mediaReport(rt: Runtime, roomId: string) {
  const { results } = await rt.env.DB.prepare('SELECT * FROM room_media WHERE room_id = ? ORDER BY (n_poor + n_bad) * 1.0 / MAX(samples, 1) DESC, name LIMIT 3000').bind(roomId).all<MediaRow>();
  return { rows: results, summary: summarize(results) };
}
/** GET /admin/api/rooms/:id/media (Funnel HQ, behind the admin session). */
export async function mediaReportRoute(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const id = c.req.param('id') ?? '';
  if (!(await getRoom(rt, id))) return c.json({ error: 'Room not found' }, 404);
  try { return c.json(await mediaReport(rt, id)); } catch { return c.json({ rows: [], summary: summarize([]), note: 'Apply migration 0056 to record call quality.' }); }
}

// ───────────── the pre-join network test ─────────────

export const NET_MAX_BYTES = 3 * 1024 * 1024;
/** GET|POST /api/rooms/:id/net/:kind?t=ticket: ping (round trip), down (n random bytes), up (counts the body). */
export async function netTest(c: Context<AppEnv>) {
  const id = c.req.param('id') ?? '';
  const kind = c.req.param('kind');
  const o = c.req.header('origin');
  if (o && o !== new URL(c.req.url).origin) return c.json({ ok: false }, 403);
  if (!isRoomId(id) || !(await readTicket(runtimeFrom(c), c.req.query('t'), id))) return c.json({ ok: false, error: 'forbidden' }, 403);
  const headers = { 'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff' };
  if (kind === 'ping') return c.json({ ok: true, at: Date.now() }, 200, headers);
  if (kind === 'down' && c.req.method === 'GET') {
    const n = Math.min(NET_MAX_BYTES, Math.max(1024, Math.round(Number(c.req.query('n')) || 256 * 1024)));
    // Fresh random bytes per chunk: incompressible, so the test measures the line, not a compressor.
    let left = n;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (left <= 0) { ctrl.close(); return; }
        const chunk = new Uint8Array(Math.min(65536, left));
        crypto.getRandomValues(chunk);
        left -= chunk.length;
        ctrl.enqueue(chunk);
      },
    });
    return new Response(body, { headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(n), 'content-encoding': 'identity' } });
  }
  if (kind === 'up' && c.req.method === 'POST') {
    const reader = c.req.raw.body?.getReader();
    let bytes = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > NET_MAX_BYTES) { await reader.cancel(); return c.json({ ok: false, error: 'too large' }, 413, headers); }
      }
    }
    return c.json({ ok: true, bytes }, 200, headers);
  }
  return c.json({ ok: false, error: 'unknown' }, 404);
}

// ───────────── settings and the page config ─────────────

type S = Partial<Record<string, string>>;
const onOff = (v: string | undefined, dflt: boolean) => { const x = v?.trim().toLowerCase(); return x ? !['off', 'false', '0', 'no'].includes(x) : dflt; };
/** Pinned third-party builds, loaded only when someone turns the feature on (and the owner allows it). */
export const MEDIA_CDN = {
  origin: 'https://cdn.jsdelivr.net',
  // MediaPipe Tasks Vision (Apache-2.0): selfie segmentation for blur and backgrounds.
  vision: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs',
  visionWasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm',
  // RNNoise (BSD-3) in an AudioWorklet, from @sapphi-red/web-noise-suppressor (MIT).
  rnnoiseWorklet: 'https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/dist/rnnoise/workletProcessor.js',
  rnnoiseWasm: 'https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/dist/rnnoise.wasm',
  rnnoiseSimd: 'https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/dist/rnnoise_simd.wasm',
};
/**
 * The selfie segmentation model (Apache-2.0, 250 KB) is served from our own assets
 * (sha256 191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b).
 */
export const SEGMENT_MODEL = '/assets/vendor/mediapipe/selfie_segmenter.tflite';
export function mediaConfig(s: S) {
  const fx = onOff(s.ROOM_FX, true);
  const rnnoise = onOff(s.ROOM_NOISE_WASM, true);
  return {
    fx, rnnoise, holdMs: HOLD_MS,
    cdn: fx || rnnoise ? { ...MEDIA_CDN, model: SEGMENT_MODEL } : null,
    copy: MEDIA_COPY,
  };
}
/** What the room page's content security policy adds for these features (nothing when both are off). */
export function mediaCsp(s: S) {
  const c = mediaConfig(s);
  return c.cdn ? { script: ` ${MEDIA_CDN.origin} 'wasm-unsafe-eval'`, connect: ` ${MEDIA_CDN.origin}` } : { script: '', connect: '' };
}

// ───────────── copy (checked by auditCopy in test/media.test.ts) ─────────────

const fill = (n: number | string) => String(n);
export const MEDIA_COPY = {
  // pre-join check
  checkHeading: 'Check your camera, mic and connection',
  checkBody: 'Nobody sees or hears you until you join. This browser remembers your choices for next time.',
  rowCamera: 'Camera',
  rowMic: 'Microphone',
  rowSpeaker: 'Speaker',
  rowNetwork: 'Connection',
  checking: 'Checking',
  camOk: 'Working',
  camNone: 'Not in use',
  micOk: 'We can hear you',
  micQuiet: 'Say something to test it',
  micNone: 'No microphone',
  spkAsk: 'Play the test sound',
  spkHeard: 'Did you hear a chime?',
  spkYes: 'Yes',
  spkNo: 'No',
  spkOk: 'Working',
  spkHelp: 'Turn the volume up or pick another speaker, then play it again. On an iPhone, check the silent switch.',
  netTesting: 'Testing your connection',
  netRtt: 'ms delay',
  netDown: 'Mbps down',
  netUp: 'Mbps up',
  netRetest: 'Test again',
  netLevel: { good: 'Ready for video', fair: 'Good enough for the call', poor: 'Weak connection', blocked: 'Calls are blocked on this network' },
  netGood: 'Your connection is ready for video.',
  netSlowRtt: 'Your connection has a long delay. Pause downloads and streaming on this network, or move closer to the Wi-Fi router.',
  netSlowDown: 'Your download speed is low. The room lowers video quality to keep the sound clear.',
  netSlowUp: 'Your upload speed is low for sending video. Others see you in lower quality. A cable or a stronger Wi-Fi signal helps.',
  netTcpOnly: 'This network blocks the fast route for calls, so the call runs over a secure web connection with a little more delay.',
  netTlsOnly: 'This network only allows secure web traffic, so the call runs over port 443 with a little more delay.',
  netBlocked: 'This network blocks video calls. Switch to another network, such as your phone’s hotspot, or ask your IT team to allow turn.cloudflare.com on port 443.',
  netFailed: 'The connection test did not finish. You can still join.',
  // effects and audio on the check screen and in Call settings
  background: 'Background',
  fxOff: 'None',
  fxBlur: 'Blur',
  fxBrand: 'G&L backdrop',
  fxLoading: 'Loading the background effect',
  fxUnsupported: 'This browser can’t run background effects. Your camera works as normal.',
  fxSlow: 'Background effects are off: this device needs its power for the call.',
  fxFailed: 'The background effect did not load. Your camera works as normal.',
  noise: 'Noise reduction',
  noiseStd: 'Standard',
  noiseStrong: 'Strong',
  noiseOff: 'Off, for music',
  noiseFailed: 'Strong noise reduction did not start. Standard is on.',
  echoTip: 'Hear an echo? Use headphones or lower your speaker volume.',
  ptt: 'Push to talk with the space bar',
  pttOn: 'Push to talk is on. Hold the space bar to talk.',
  pttTalking: 'Talking',
  // problems on the check screen: a title, a line, then steps for this system
  problem: {
    busy: { title: 'Your camera is in use by another app', body: 'Only one app at a time can use the camera on this device. You can join with your mic in the meantime.' },
    system: { title: 'Your computer is blocking the camera or mic', body: 'The system privacy settings keep this browser away from the camera or mic.' },
    denied: { title: 'Your browser blocked the camera or mic', body: 'Allow them for this site, then reload the page. You can also join without them.' },
    notfound: { title: 'No camera or microphone found', body: 'You can still join, watch, chat and ask questions.' },
    still: { title: 'Your camera is sending a still picture', body: 'A closed privacy shutter, a camera switched off in the system settings, or another app holding the camera all look like this.' },
    black: { title: 'Your camera picture is black', body: 'Something covers the lens, or the camera is switched off.' },
    insecure: { title: 'This page needs a secure connection', body: 'Open the room link that starts with https.' },
    unknown: { title: 'The camera or mic did not start', body: 'Press Try again. If it fails again, run the camera check and send us the code it shows.' },
  },
  steps: {
    busy: {
      windows: ['Close Teams, Zoom, Skype, the Camera app and other video apps. Look in the system tray near the clock too.', 'On Surface and Snapdragon laptops the camera can stay locked after sleep. Restart the browser if closing apps did not help.', 'Press Try again.'],
      mac: ['Quit FaceTime, Zoom, Teams, Photo Booth and other video apps with Command-Q.', 'Press Try again.'],
      ios: ['End any FaceTime, WhatsApp or other video call on this iPhone.', 'Come back to this page and press Try again.'],
      android: ['Close WhatsApp, the Camera app and other apps that use the camera.', 'Come back to this page and press Try again.'],
      other: ['Close other apps and browser tabs that use the camera.', 'Press Try again.'],
    },
    system: {
      windows: ['Open Start, Settings, Privacy & security, Camera.', 'Turn on Camera access, Let apps access your camera, and Let desktop apps access your camera.', 'Do the same under Microphone.', 'Reload this page.'],
      mac: ['Open the Apple menu, System Settings, Privacy & Security, Camera.', 'Turn on your browser in the list.', 'Do the same under Microphone.', 'Quit and reopen the browser, then come back to this page.'],
      other: ['Open your system’s privacy settings and allow this browser to use the camera and microphone.', 'Reload this page.'],
    },
    denied: {
      windows: ['Select the icon at the left of the address bar.', 'Set Camera and Microphone to Allow.', 'Reload this page.'],
      mac: ['Select the icon at the left of the address bar. In Safari: Safari menu, Settings for This Website.', 'Set Camera and Microphone to Allow.', 'Reload this page.'],
      ios: ['Open the Settings app, then Apps, Safari, Camera, and choose Allow. Do the same for Microphone.', 'In Chrome on iPhone: Settings, Apps, Chrome, and turn on Camera and Microphone.', 'Come back here and reload the page.'],
      android: ['Tap the icon at the left of the address bar, then Permissions.', 'Allow Camera and Microphone.', 'Greyed out? Open Android Settings, Apps, Chrome, Permissions, and allow both.'],
      other: ['Select the icon at the left of the address bar and allow the camera and microphone.', 'Reload this page.'],
    },
    still: {
      windows: ['Look for a privacy shutter on the camera, or a camera key on the keyboard (F8 or F10 on many laptops).', 'Open Settings, Privacy & security, Camera, and turn on Let desktop apps access your camera.', 'Close other video apps, then press Try again.'],
      mac: ['Check that nothing covers the camera.', 'Open System Settings, Privacy & Security, Camera, and turn on your browser.', 'Press Try again.'],
      ios: ['Check that nothing covers the camera.', 'Pick the other camera in the list, then switch back.'],
      android: ['Check that nothing covers the camera.', 'Pick the other camera in the list, then switch back.'],
      other: ['Look for a privacy shutter or a camera switch.', 'Pick another camera in the list, or press Try again.'],
    },
    black: {
      other: ['Open the privacy shutter or uncover the lens.', 'Pick another camera in the list, or press Try again.'],
    },
    notfound: {
      other: ['Plug in a camera or a headset, then press Try again.', 'Or join without them: you can watch, chat and ask questions.'],
    },
    insecure: { other: ['Open the link from your email again.'] },
    unknown: { other: ['Press Try again.', 'Reload the page.'] },
  },
  // in the room: the connection banner
  offline: 'You are offline. The room reconnects as soon as your internet is back.',
  reconnecting: 'Reconnecting to the room.',
  retrying: (n: number) => `Connection lost. Trying again in ${fill(n)} s.`,
  mediaReconnecting: 'Your network changed. Reconnecting audio and video.',
  gaveUp: 'The room could not reconnect.',
  tryNow: 'Try now',
  reload: 'Reload',
  reconnected: 'Reconnected.',
  // quality
  quality: { good: 'Good connection', fair: 'Fair connection', poor: 'Weak connection', bad: 'Very weak connection' },
  why: { latency: 'long delay', loss: 'lost data', jitter: 'uneven delivery', upload: 'slow upload', download: 'slow download' },
  audioOnly: 'Your connection is weak, so video is paused to keep the sound clear. It comes back on its own.',
  videoBack: 'Your connection recovered. Video is back.',
  uploadWeak: 'Your upload is weak. Others see you in lower quality until it recovers.',
  // devices in the room
  micLost: 'Your microphone was disconnected. Plug it back in or pick another one in Call settings.',
  camLost: 'Your camera was disconnected. Plug it back in or pick another one in Call settings.',
  switchedMic: (name: string) => `Microphone: ${name}`,
  switchedCam: (name: string) => `Camera: ${name}`,
  mutedSpeaking: 'You are muted. Press the mic button to talk.',
  // Call settings and the host's view
  settings: 'Call settings',
  close: 'Close',
  yourConnection: 'Your connection',
  delay: 'Delay',
  lost: 'Lost data',
  jitter: 'Jitter',
  down: 'Down',
  up: 'Up',
  relay: 'Through a relay',
  direct: 'Direct',
  pathSfu: 'Video room',
  pathMoq: 'Broadcast',
  reconnects: 'Reconnects',
  hostQuality: 'Connection quality',
  noReports: 'Quality appears here once people are connected.',
  reconnectingTile: 'Reconnecting',
};

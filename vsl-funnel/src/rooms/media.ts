import type { Context } from 'hono';
import type { AppEnv, Runtime } from '../app';
import { runtimeFrom } from '../app';
import { type Member, type RoomState, isStaff } from './state';
import { getRoom, isRoomId, readTicket } from './rooms';
import type { ProxyResult, SfuOp } from './proxy';
import type { AePoint } from '../infra/analytics-engine';
import { SfuError, sfuCall } from './sfu';

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
  /** Host diagnostics: whether this person receives the host's video and audio (attendees). */
  rx?: Rx | null;
  /** Host diagnostics: the publisher self-check (the host's own camera), with how many times it republished. */
  pw?: Pw | null;
}
export type RxState = 'ok' | 'no' | 'na';
export interface Rx { v: RxState; vr: string | null; a: RxState; ar: string | null; kbps: number | null; h: number | null; fps: number | null; rt: number }
export interface Pw { st: 'idle' | 'ok' | 'stalled'; why: string | null; rp: number }
/** Running totals for the Funnel HQ report: how long this person could not see or hear the host. */
export interface RxAcc { noV: number; noA: number; epV: number; epA: number; vr: string | null; ar: string | null; rp: number; seen: boolean }
export interface MediaRec {
  who: string; name: string; role: string; leadId: string | null;
  firstAt: number; lastAt: number; samples: number; counts: Record<Level, number>; worst: Level;
  sums: { rtt: number; rttN: number; loss: number; lossN: number; jitter: number; jitterN: number; inK: number; inN: number; outK: number; outN: number };
  audioOnly: number; last: Report; dirty: boolean;
  /** Host diagnostics (0075): set once this person has reported what they receive from the host. */
  rxAcc?: RxAcc;
}

const num = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);
const word = (v: unknown, max = 20) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, max) : '');
const RX_STATES: RxState[] = ['ok', 'no', 'na'];
const RX_REASONS = ['not_found', 'retrying', 'pending', 'stalled', 'audio_only', 'no_connection', 'moq_wait', 'autoplay'];
const PW_REASONS = ['no_bytes', 'no_receipts', 'viewers'];
const rxState = (v: unknown): RxState => (RX_STATES.includes(v as RxState) ? (v as RxState) : 'na');
const rxReason = (v: unknown) => (typeof v === 'string' && RX_REASONS.includes(v) ? v : null);
/** What an attendee says they receive from the host (bounded; diagnostics only). */
export function cleanRx(raw: unknown): Rx | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const v = rxState(r.v), a = rxState(r.a);
  const n = (x: unknown, max: number) => { const y = num(x, 0, max); return y == null ? null : Math.round(y); };
  return { v, vr: v === 'no' ? rxReason(r.vr) ?? 'stalled' : null, a, ar: a === 'no' ? rxReason(r.ar) ?? 'stalled' : null, kbps: n(r.kbps, 100_000), h: n(r.h, 4320), fps: n(r.fps, 240), rt: n(r.rt, 10_000) ?? 0 };
}
/** The host's camera self-check (bounded). */
export function cleanPw(raw: unknown): Pw | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const st = r.st === 'ok' || r.st === 'stalled' ? r.st : 'idle';
  return { st, why: typeof r.why === 'string' && PW_REASONS.includes(r.why) ? r.why : null, rp: Math.round(num(r.rp, 0, 1000) ?? 0) };
}

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
    rx: cleanRx(r.rx), pw: cleanPw(r.pw),
  };
}

/** A gap longer than this between two reports is not counted (they were away, or the room was quiet). */
export const RX_MAX_GAP_MS = 90_000;
/**
 * Adds the time since the previous report to the "could not see / hear the host" totals (the previous report's
 * state held until this one), counts each new episode, and keeps the republish count from the self-check.
 */
export function accumulateRx(acc: RxAcc | undefined, before: Report | undefined, rep: Report, gapMs: number): RxAcc | undefined {
  if (!rep.rx && !rep.pw && !acc) return acc;
  const a: RxAcc = acc ? { ...acc } : { noV: 0, noA: 0, epV: 0, epA: 0, vr: null, ar: null, rp: 0, seen: false };
  const gap = Math.max(0, Math.min(RX_MAX_GAP_MS, gapMs));
  const b = before?.rx;
  if (b && b.v === 'no') a.noV += gap;
  if (b && b.a === 'no') a.noA += gap;
  if (rep.rx) {
    a.seen = a.seen || rep.rx.v !== 'na' || rep.rx.a !== 'na';
    if (rep.rx.v === 'no') { if (!b || b.v !== 'no') a.epV++; a.vr = rep.rx.vr; }
    if (rep.rx.a === 'no') { if (!b || b.a !== 'no') a.epA++; a.ar = rep.rx.ar; }
  }
  if (rep.pw) { a.rp = Math.max(a.rp, rep.pw.rp); if (rep.pw.rp) a.seen = true; }
  return a;
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
  rec.rxAcc = accumulateRx(prev?.rxAcc, before, rep, prev ? now - prev.lastAt : 0);
  const rxKey = (r: Report | undefined) => (r ? `${r.rx?.v}${r.rx?.vr}${r.rx?.a}${r.rx?.ar}${r.pw?.st}${r.pw?.rp}` : '');
  const changed = !before || before.level !== rep.level || before.tier !== rep.tier || before.rc !== rep.rc || before.path !== rep.path || before.fx !== rep.fx || rxKey(before) !== rxKey(rep);
  rec.last = rep; rec.dirty = true;
  return { rec, changed };
}
const avg = (s: number, n: number, digits = 0) => (n ? Math.round((s / n) * 10 ** digits) / 10 ** digits : null);
/** What staff see for one person, live. */
export const staffView = (rec: MediaRec) => ({
  id: rec.who, name: rec.name, role: rec.role, level: rec.last.level, score: rec.last.score, rtt: rec.last.rtt, loss: rec.last.loss, jitter: rec.last.jitter, tier: rec.last.tier, why: rec.last.why,
  rc: rec.last.rc, path: rec.last.path, relay: rec.last.relay, os: rec.last.os, browser: rec.last.browser, mobile: rec.last.mobile, at: rec.lastAt,
  rx: rec.last.rx ? { v: rec.last.rx.v, vr: rec.last.rx.vr, a: rec.last.rx.a, ar: rec.last.rx.ar } : null,
  pw: rec.last.pw ?? null,
});

/**
 * One quality report as an Analytics Engine point (src/infra/analytics-engine.ts has the layout): name room_quality,
 * device os/browser, variant the level, value the score, duration the round trip, then loss, jitter, kbps in/out, tier.
 */
export function roomQualityPoint(roomId: string, rec: MediaRec): AePoint {
  const r = rec.last;
  return {
    name: 'room_quality', path: `/rooms/${roomId}`, source: 'room', device: `${r.mobile ? 'mobile' : 'desktop'} ${r.os}/${r.browser}`.slice(0, 80),
    variant: r.level, roomId, visitorId: rec.who, channel: rec.role, value: r.score, durationMs: r.rtt,
    extra: [r.loss, r.jitter, r.inKbps, r.outKbps, r.tier],
  };
}

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
  await flushRx(db, roomId, dirty);
  for (const r of dirty) r.dirty = false;
  return dirty.length;
}

/**
 * Host diagnostics (0075 room_media_rx): how long each person could not see or hear the host, and the host's
 * self-check republishes. Its own table and its own try, so a missing migration never stops the quality rows.
 */
export async function flushRx(db: D1Database, roomId: string, recs: MediaRec[]) {
  const rows = recs.filter((r) => r.rxAcc?.seen);
  if (!rows.length) return 0;
  const sql = `INSERT INTO room_media_rx (room_id, who, name, role, lead_id, no_video_ms, no_audio_ms, video_episodes, audio_episodes, video_reason, audio_reason, republishes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, who) DO UPDATE SET name = excluded.name, role = excluded.role, no_video_ms = MAX(room_media_rx.no_video_ms, excluded.no_video_ms),
      no_audio_ms = MAX(room_media_rx.no_audio_ms, excluded.no_audio_ms), video_episodes = MAX(room_media_rx.video_episodes, excluded.video_episodes),
      audio_episodes = MAX(room_media_rx.audio_episodes, excluded.audio_episodes), video_reason = COALESCE(excluded.video_reason, room_media_rx.video_reason),
      audio_reason = COALESCE(excluded.audio_reason, room_media_rx.audio_reason), republishes = MAX(room_media_rx.republishes, excluded.republishes), updated_at = excluded.updated_at`;
  try {
    const stmts = rows.map((r) => { const a = r.rxAcc!; return db.prepare(sql).bind(roomId, r.who, r.name, r.role, r.leadId, Math.round(a.noV), Math.round(a.noA), a.epV, a.epA, a.vr, a.ar, a.rp, r.lastAt); });
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    return rows.length;
  } catch (e) { console.error('room media rx flush', String(e).slice(0, 200)); return 0; }
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
  const rx = await rt.env.DB.prepare('SELECT * FROM room_media_rx WHERE room_id = ? ORDER BY no_video_ms + no_audio_ms DESC, name LIMIT 3000').bind(roomId).all<RxRow>()
    .then((r) => r.results).catch(() => null);
  return { rows: results, summary: summarize(results), rx: rx ? { rows: rx, summary: summarizeRx(rx) } : { rows: [], summary: summarizeRx([]), note: 'Apply migration 0075 to record who could not see or hear the host.' } };
}

export interface RxRow {
  who: string; name: string; role: string; no_video_ms: number; no_audio_ms: number; video_episodes: number; audio_episodes: number;
  video_reason: string | null; audio_reason: string | null; republishes: number; updated_at: number;
}
/** Per session: how many attendees could not see or hear the host, for how long, and the host's republishes. */
export function summarizeRx(rows: RxRow[]) {
  const att = rows.filter((r) => r.role !== 'host' && r.role !== 'cohost');
  const sV = att.filter((r) => r.no_video_ms > 0), sA = att.filter((r) => r.no_audio_ms > 0);
  const top = (xs: RxRow[], k: 'video_reason' | 'audio_reason') => {
    const c: Record<string, number> = {};
    for (const r of xs) { const v = r[k]; if (v) c[v] = (c[v] ?? 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, n }));
  };
  return {
    attendees: att.length,
    cantSee: sV.length, cantSeeMs: sV.reduce((a, r) => a + r.no_video_ms, 0), longestNoVideoMs: sV.reduce((a, r) => Math.max(a, r.no_video_ms), 0),
    cantHear: sA.length, cantHearMs: sA.reduce((a, r) => a + r.no_audio_ms, 0), longestNoAudioMs: sA.reduce((a, r) => Math.max(a, r.no_audio_ms), 0),
    videoReasons: top(sV, 'video_reason'), audioReasons: top(sA, 'audio_reason'),
    republishes: rows.filter((r) => r.role === 'host' || r.role === 'cohost').reduce((a, r) => a + (r.republishes || 0), 0),
  };
}
/** GET /admin/api/rooms/:id/media (Funnel HQ, behind the admin session). */
export async function mediaReportRoute(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const id = c.req.param('id') ?? '';
  if (!(await getRoom(rt, id))) return c.json({ error: 'Room not found' }, 404);
  try { return c.json(await mediaReport(rt, id)); } catch { return c.json({ rows: [], summary: summarize([]), rx: { rows: [], summary: summarizeRx([]) }, note: 'Apply migration 0056 to record call quality.' }); }
}

// ───────────── "How attendees see me": the host's receive-only preview ─────────────

/**
 * The host (or anyone publishing) opens a second, receive-only media session that pulls their own published
 * tracks back from the SFU, so they see exactly what attendees get. The browser closes it after 60 s; the room
 * forgets it after PREVIEW_MS. It never replaces the person's main session (claimSession is not called), and it
 * can only pull the caller's own tracks. room.js sends these as the usual /sfu/:op calls with `preview: true`.
 */
export const PREVIEW_MS = 75_000;
type Previewed = RoomState & { mediaPreview?: Record<string, { sessionId: string; until: number }> };
const pErr = (status: number, error: string): ProxyResult => ({ status, body: { ok: false, error }, changed: false });
const pSdp = (v: unknown, type: 'offer' | 'answer') => {
  if (!v || typeof v !== 'object') return null;
  const d = v as { type?: unknown; sdp?: unknown };
  return d.type === type && typeof d.sdp === 'string' && d.sdp.length < 200_000 ? { type, sdp: d.sdp } : null;
};
const pRid = (v: unknown) => {
  const rid = v && typeof v === 'object' ? (v as { preferredRid?: unknown }).preferredRid : null;
  return typeof rid === 'string' && ['f', 'h', 'q'].includes(rid) ? { preferredRid: rid, priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' } : undefined;
};
export async function previewProxy(st: RoomState, memberId: string, op: SfuOp, body: Record<string, unknown>, s: Partial<Record<string, string>>, now: number, f: typeof fetch = fetch): Promise<ProxyResult> {
  const me = st.members[memberId];
  if (!me || me.connected === 0) return pErr(403, 'Join the room first.');
  if (!isStaff(me) && !me.tracks.length) return pErr(403, 'Only the host can preview their own video.');
  const map = ((st as Previewed).mediaPreview ??= {});
  for (const k of Object.keys(map)) if (map[k].until < now) delete map[k];
  try {
    if (op === 'session') {
      const r = await sfuCall(s, 'POST', 'sessions/new', undefined, f);
      const sessionId = String(r.sessionId ?? '');
      if (!/^[A-Za-z0-9]{8,128}$/.test(sessionId)) return pErr(502, 'The media server didn’t answer.');
      map[memberId] = { sessionId, until: now + PREVIEW_MS };
      return { status: 200, body: { ok: true, sessionId, until: now + PREVIEW_MS }, changed: false };
    }
    const p = map[memberId];
    if (!p || p.sessionId !== body.sessionId) return pErr(403, 'That preview has ended.');
    const path = `sessions/${p.sessionId}`;
    const own = (t: Record<string, unknown>) => Boolean(me.sessionId && t.sessionId === me.sessionId && me.tracks.some((x) => x.trackName === t.trackName));
    if (op === 'tracks') {
      const tracks = Array.isArray(body.tracks) ? (body.tracks as Record<string, unknown>[]).slice(0, 4) : [];
      if (!tracks.length || !tracks.every((t) => t.location === 'remote' && own(t))) return pErr(403, 'Only your own tracks can be previewed.');
      const r = await sfuCall(s, 'POST', `${path}/tracks/new`, {
        tracks: tracks.map((t) => ({ location: 'remote', sessionId: t.sessionId, trackName: t.trackName, ...(pRid(t.simulcast) ? { simulcast: pRid(t.simulcast) } : {}) })),
      }, f);
      return { status: 200, body: { ok: true, ...r }, changed: false };
    }
    if (op === 'renegotiate') {
      const answer = pSdp(body.sessionDescription, 'answer');
      if (!answer) return pErr(400, 'Missing answer');
      const r = await sfuCall(s, 'PUT', `${path}/renegotiate`, { sessionDescription: answer }, f);
      return { status: 200, body: { ok: true, ...r }, changed: false };
    }
    if (op === 'update') {
      const tracks = (Array.isArray(body.tracks) ? (body.tracks as Record<string, unknown>[]) : []).slice(0, 4);
      if (!tracks.length || !tracks.every((t) => typeof t.mid === 'string' && pRid(t.simulcast) && own(t))) return pErr(403, 'Only your own tracks can be previewed.');
      const r = await sfuCall(s, 'PUT', `${path}/tracks/update`, { tracks: tracks.map((t) => ({ location: 'remote', sessionId: t.sessionId, trackName: t.trackName, mid: t.mid, simulcast: pRid(t.simulcast) })) }, f);
      return { status: 200, body: { ok: true, ...r }, changed: false };
    }
    // close: the preview ends (the browser also just closes its connection).
    const mids = (Array.isArray(body.tracks) ? (body.tracks as { mid?: unknown }[]) : []).map((t) => t.mid).filter((m): m is string => typeof m === 'string').slice(0, 8);
    delete map[memberId];
    if (mids.length) await sfuCall(s, 'PUT', `${path}/tracks/close`, { tracks: mids.map((mid) => ({ mid })), force: true }, f).catch(() => null);
    return { status: 200, body: { ok: true }, changed: false };
  } catch (e) {
    if (e instanceof SfuError) return pErr(e.status, e.message);
    return pErr(502, 'The media server didn’t answer. Try again.');
  }
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
  // host diagnostics: who can see and hear the host, the preview, the camera self-check
  hd: {
    cantSee: 'Can’t see you',
    cantHear: 'Can’t hear you',
    cantBoth: 'Can’t see or hear you',
    reason: {
      not_found: 'your video has not reached the video server for them',
      retrying: 'still connecting to your video',
      pending: 'waiting for your video',
      stalled: 'your video or sound stopped arriving',
      audio_only: 'their connection is too weak for video',
      no_connection: 'their media connection is down',
      moq_wait: 'the broadcast has not started playing for them',
      autoplay: 'their browser keeps the sound off until they tap',
    },
    // {n} people of {t} attendees with reports; {w} is one of see / hear / seeHear
    banner: '{n} of {t} attendees can’t {w} you.',
    see: 'see',
    hear: 'hear',
    seeHear: 'see or hear',
    cause: {
      camera: { why: 'Your camera stopped sending.', fix: 'Turn your camera off and on, or pick it again in Call settings.' },
      mic: { why: 'Your microphone stopped sending.', fix: 'Turn your mic off and on, or pick it again in Call settings.' },
      upload: { why: 'Your video is not reaching the video server, or your upload is weak.', fix: 'Press Republish. If it happens again, pause other uploads or move to a cable or a stronger Wi-Fi signal.' },
      autoplay: { why: 'Their browsers keep the sound off until they tap the page.', fix: 'Ask them in chat to tap Turn on sound.' },
      network: { why: 'Their own connections are weak.', fix: 'Nothing to change on your side. The room lowers their video to keep the sound clear.' },
      unknown: { why: 'The cause is not clear yet.', fix: 'Open How attendees see me to check what they receive.' },
      unsent: { why: 'Your camera or mic is on, but it is not being sent to the video server.', fix: 'Press Republish. If it stays like this, reload the page.' },
    },
    unsentTitle: 'Attendees can’t see or hear you yet.',
    republish: 'Republish',
    republishing: 'Sending your video again.',
    dismiss: 'Hide',
    preview: 'How attendees see me',
    previewBody: 'Your own video, pulled back from the video server the same way attendees get it. Closes after 60 seconds.',
    previewWaiting: 'Waiting for your video from the server',
    previewNoCam: 'Turn your camera on first.',
    previewFailed: 'Your video did not come back from the server. Press Republish, then try again.',
    previewClosesIn: 'Closes in {n} s',
    previewLayer: 'Quality layer',
    layerF: 'High',
    layerH: 'Medium',
    layerQ: 'Low',
    resolution: 'Resolution',
    bitrate: 'Bitrate',
    fps: 'Frames per second',
    selfRepublished: 'Your video stopped reaching the video server, so the room sent it again.',
    selfStill: 'Your video is still not reaching the video server. Check your connection, or turn your camera off and on.',
  },
};

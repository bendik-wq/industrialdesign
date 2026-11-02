import { describe, expect, it } from 'vitest';
import { auditCopy } from '../src/content/copy-rules';
import { join, leave, newRoomState } from '../src/rooms/state';
import { HOLD_MS, MEDIA_COPY, cleanReport, heldIds, holdOnClose, isHeld, mediaConfig, mediaCsp, mergeReport, resume, summarize, type MediaRow } from '../src/rooms/media';
import { SETTINGS } from '../src/settings';

const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const fs = node.getBuiltinModule('node:fs') as { readFileSync(p: string, enc: string): string };
const path = { join: (...a: string[]) => a.join('/') };
const cwd = () => node.cwd();

/* The browser's pure decisions (public/assets/room-media-logic.js), loaded the way a page would (one IIFE). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const src = fs.readFileSync(path.join(cwd(), 'public/assets/room-media-logic.js'), 'utf8');
const mod: { exports: Any } = { exports: {} };
new Function('module', src)(mod);
const L = mod.exports;

describe('simulcast layer per tile', () => {
  const base = { simulcast: true, kind: 'video', dpr: 1, tier: 0, visible: true, hidden: false };
  it('picks the smallest layer that fills the tile', () => {
    expect(L.pickLayer({ ...base, tileH: 120 })).toBe('q');
    expect(L.pickLayer({ ...base, tileH: 280 })).toBe('h');
    expect(L.pickLayer({ ...base, tileH: 600 })).toBe('f');
  });
  it('counts screen density (capped at 2x)', () => {
    expect(L.pickLayer({ ...base, tileH: 200, dpr: 2 })).toBe('h');
    expect(L.pickLayer({ ...base, tileH: 300, dpr: 3 })).toBe('f');
  });
  it('caps by bandwidth tier and drops cameras at audio only', () => {
    expect(L.pickLayer({ ...base, tileH: 700, tier: 1 })).toBe('h');
    expect(L.pickLayer({ ...base, tileH: 700, tier: 2 })).toBe('q');
    expect(L.pickLayer({ ...base, tileH: 700, tier: 3 })).toBe('off');
  });
  it('takes the lowest layer for hidden tiles and background tabs', () => {
    expect(L.pickLayer({ ...base, tileH: 700, visible: false })).toBe('q');
    expect(L.pickLayer({ ...base, tileH: 700, hidden: true })).toBe('q');
  });
  it('never drops a shared screen, and leaves non-simulcast video alone', () => {
    expect(L.pickLayer({ ...base, kind: 'screen', tileH: 700, tier: 3 })).toBeNull();
    expect(L.pickLayer({ ...base, simulcast: false, tileH: 700 })).toBeNull();
  });
});

describe('quality from getStats', () => {
  const report = (o: { bytesIn: number; recv: number; lost: number; bytesOut?: number; rtt?: number; out?: number; jitter?: number; relay?: boolean }) => [
    { id: 'cp', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: (o.rtt ?? 40) / 1000, availableOutgoingBitrate: (o.out ?? 2500) * 1000, localCandidateId: 'lc' },
    { id: 'lc', type: 'local-candidate', candidateType: o.relay ? 'relay' : 'srflx', protocol: 'udp', relayProtocol: o.relay ? 'tls' : undefined },
    { id: 'ia', type: 'inbound-rtp', kind: 'audio', bytesReceived: o.bytesIn / 4, packetsReceived: o.recv / 2, packetsLost: o.lost / 2, jitter: (o.jitter ?? 10) / 1000 },
    { id: 'iv', type: 'inbound-rtp', kind: 'video', bytesReceived: (o.bytesIn * 3) / 4, packetsReceived: o.recv / 2, packetsLost: o.lost / 2, framesPerSecond: 24 },
    { id: 'ov', type: 'outbound-rtp', kind: 'video', bytesSent: o.bytesOut ?? 0 },
  ];
  it('derives bitrates and loss from the change since the last sample', () => {
    const a = L.summarizeStats(report({ bytesIn: 0, recv: 0, lost: 0 }), null, 1000);
    const b = L.summarizeStats(report({ bytesIn: 250_000, recv: 980, lost: 20, bytesOut: 125_000, relay: true }), a, 3000);
    expect(b.inKbps).toBe(1000);
    expect(b.outKbps).toBe(500);
    expect(b.loss).toBeCloseTo(0.02, 3);
    expect(b.rtt).toBe(40);
    expect(b.relay).toBe(true);
    expect(b.proto).toBe('tls');
    expect(b.fpsIn).toBe(24);
  });
  it('scores what people hear: loss first, then delay, then jitter and bandwidth', () => {
    expect(L.scoreQuality({ rtt: 40, loss: 0, jitter: 8 }).level).toBe('good');
    const lossy = L.scoreQuality({ rtt: 40, loss: 0.08, jitter: 8 });
    expect(lossy.level).toBe('fair');
    expect(lossy.why).toBe('loss');
    expect(L.scoreQuality({ rtt: 600, loss: 0.02, jitter: 40 }).level).toBe('poor');
    expect(L.scoreQuality({ rtt: 900, loss: 0.15, jitter: 80 }).level).toBe('bad');
    const up = L.scoreQuality({ rtt: 40, loss: 0, availOut: 180, publishing: true });
    expect(up.why).toBe('upload');
    expect(L.scoreQuality({ rtt: 40, loss: 0, availOut: 180, publishing: false }).score).toBe(100);
  });
});

describe('bandwidth tiers', () => {
  it('goes down after two bad samples in a row and straight to audio only when it is bad', () => {
    const g = L.createGovernor();
    expect(g.feed('bad', 0).tier).toBe(0);
    const r = g.feed('bad', 2000);
    expect(r.tier).toBe(3);
    expect(r.notice).toBe('audioOnly');
  });
  it('ignores a single bad sample', () => {
    const g = L.createGovernor();
    g.feed('poor', 0); g.feed('good', 2000); g.feed('poor', 4000);
    expect(g.tier).toBe(0);
  });
  it('comes back one step at a time after five good samples, announcing video', () => {
    const g = L.createGovernor();
    g.feed('bad', 0); g.feed('bad', 1);
    let t = 10;
    const steps: number[] = [];
    let back = null;
    for (let i = 0; i < 15; i++) { const r = g.feed('good', (t += 2000)); if (r.changed) steps.push(r.tier); if (r.notice) back = r.notice; }
    expect(steps).toEqual([2, 1, 0]);
    expect(back).toBe('videoBack');
  });
  it('waits twice as long after a step up that fell straight back (flapping)', () => {
    const g = L.createGovernor();
    g.feed('poor', 0); g.feed('poor', 1); // tier 2
    let t = 100;
    for (let i = 0; i < 5; i++) g.feed('good', (t += 2000)); // up to 1
    expect(g.tier).toBe(1);
    g.feed('poor', (t += 2000)); const r = g.feed('poor', (t += 2000)); // back down within 30 s
    expect(r.tier).toBe(2);
    expect(r.need).toBe(10);
    for (let i = 0; i < 9; i++) g.feed('good', (t += 2000));
    expect(g.tier).toBe(2);
    g.feed('good', (t += 2000));
    expect(g.tier).toBe(1);
  });
});

describe('retries and the reconnect banner', () => {
  it('backs off exponentially, capped, with jitter', () => {
    expect(L.backoff(0, {}, 0.5)).toBe(600);
    expect(L.backoff(3, {}, 0.5)).toBe(Math.round(600 * 1.8 ** 3));
    expect(L.backoff(20, {}, 0.5)).toBe(15000);
    expect(L.backoff(0, {}, 0)).toBe(480);
    expect(L.backoff(0, {}, 1)).toBe(720);
  });
  it('gives up after the bounded number of attempts and starts over after a reset', () => {
    const r = L.createRetry({ maxAttempts: 3 });
    expect([r.next(0.5).attempt, r.next(0.5).attempt, r.next(0.5).attempt]).toEqual([1, 2, 3]);
    expect(r.next(0.5).giveUp).toBe(true);
    r.reset();
    expect(r.next(0.5).giveUp).toBe(false);
  });
  it('says what is really happening', () => {
    expect(L.connectionPhase({ online: false, ws: 'closed' }).key).toBe('offline');
    expect(L.connectionPhase({ online: true, ws: 'closed', retryIn: 4200 })).toEqual({ key: 'retrying', secs: 5 });
    expect(L.connectionPhase({ online: true, ws: 'connecting', retryIn: 300 }).key).toBe('reconnecting');
    expect(L.connectionPhase({ online: true, ws: 'open', pc: 'disconnected', media: true }).key).toBe('mediaReconnecting');
    expect(L.connectionPhase({ online: true, ws: 'open', pc: 'disconnected', media: false }).key).toBeNull();
    expect(L.connectionPhase({ online: true, ws: 'open', pc: 'connected', media: true }).key).toBeNull();
    expect(L.connectionPhase({ online: true, ws: 'closed', gaveUp: true }).key).toBe('gaveUp');
  });
});

describe('devices', () => {
  const dev = (kind: string, deviceId: string, label: string) => ({ kind, deviceId, label });
  const list = [
    dev('audioinput', 'default', 'Default - Headset'), dev('audioinput', 'communications', 'Communications - Headset'), dev('audioinput', 'hs', 'Headset'), dev('audioinput', 'int', 'Internal microphone'),
    dev('videoinput', 'obs', 'OBS Virtual Camera'), dev('videoinput', 'int-cam', 'Integrated Camera'),
  ];
  it('uses the chosen device, then the same name, then the default, then the first real one', () => {
    expect(L.pickDevice(list, 'audioinput', { preferredId: 'int' })).toBe('int');
    expect(L.pickDevice(list, 'audioinput', { preferredId: 'gone', preferredLabel: 'Headset' })).toBe('hs');
    expect(L.pickDevice(list, 'audioinput', { preferredId: 'gone' })).toBe('default');
    expect(L.pickDevice(list, 'videoinput', {})).toBe('int-cam');
    expect(L.pickDevice([dev('videoinput', 'obs', 'OBS Virtual Camera')], 'videoinput', {})).toBe('obs');
    expect(L.pickDevice([], 'videoinput', {})).toBeNull();
  });
  it('switches away from a device that was unplugged', () => {
    const now = list.filter((d) => d.deviceId !== 'hs');
    expect(L.deviceChange(now, 'audioinput', { activeId: 'hs', activeLabel: 'Headset', ended: true, preferredId: 'hs' })).toEqual({ action: 'switch', to: 'default', reason: 'lost' });
  });
  it('switches back when the chosen device returns', () => {
    expect(L.deviceChange(list, 'audioinput', { activeId: 'int', activeLabel: 'Internal microphone', ended: false, preferredId: 'hs' })).toEqual({ action: 'switch', to: 'hs', reason: 'back' });
  });
  it('keeps a device that is still there and reports when nothing is left', () => {
    expect(L.deviceChange(list, 'videoinput', { activeId: 'int-cam', ended: false, preferredId: 'int-cam' }).action).toBe('keep');
    expect(L.deviceChange([], 'videoinput', { activeId: 'int-cam', ended: true }).action).toBe('none');
  });
});

describe('placeholder frames', () => {
  const W = 64, H = 36;
  const frame = (fn: (i: number) => number) => { const a = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { const v = fn(i); a[i * 4] = a[i * 4 + 1] = a[i * 4 + 2] = v; a[i * 4 + 3] = 255; } return a; };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const run = (make: (k: number) => Uint8ClampedArray) => {
    let prev: Float32Array | null = null;
    const out = [];
    for (let k = 0; k < 6; k++) { const s: Any = L.frameStats(make(k), W, H, prev); prev = s.luma; out.push({ mean: s.mean, std: s.std, diff: s.diff }); }
    return L.classifyFrames(out);
  };
  it('passes a real camera (texture plus sensor noise)', () => {
    expect(run(() => frame((i) => 60 + (i % W) + rnd() * 12))).toBe('ok');
  });
  it('flags black (closed shutter) and flat (one colour) frames', () => {
    expect(run(() => frame(() => 3))).toBe('black');
    expect(run(() => frame(() => 128))).toBe('flat');
  });
  it('flags the same picture every time (the Windows privacy padlock image)', () => {
    const still = frame((i) => ((i % W) > 24 && (i % W) < 40 && Math.floor(i / W) > 10 && Math.floor(i / W) < 26 ? 200 : 40));
    expect(run(() => still)).toBe('frozen');
  });
  it('needs frames before it judges', () => {
    expect(L.classifyFrames([])).toBe('noframes');
    expect(L.classifyFrames([{ mean: 3, std: 1, diff: null }])).toBe('ok');
  });
});

describe('getUserMedia failures, platform and steps', () => {
  it('names the cause', () => {
    expect(L.classifyError({ name: 'NotReadableError', message: 'Device in use' })).toBe('busy');
    expect(L.classifyError({ name: 'NotReadableError', message: 'Could not start video source' })).toBe('busy');
    expect(L.classifyError({ name: 'AbortError', message: 'Starting videoinput failed' })).toBe('busy');
    expect(L.classifyError({ name: 'NotAllowedError', message: 'Permission denied by system' })).toBe('system');
    expect(L.classifyError({ name: 'NotAllowedError', message: 'Permission denied' })).toBe('denied');
    expect(L.classifyError({ name: 'NotAllowedError', message: 'The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.' })).toBe('denied');
    expect(L.classifyError({ name: 'NotFoundError', message: 'Requested device not found' })).toBe('notfound');
    expect(L.classifyError({ name: 'OverconstrainedError' })).toBe('constraints');
    expect(L.classifyError(null)).toBe('unknown');
  });
  it('detects the system and browser (iPad reports itself as a Mac)', () => {
    expect(L.detectPlatform({ ua: 'Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0' })).toEqual({ os: 'windows', browser: 'edge', mobile: false });
    expect(L.detectPlatform({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', maxTouchPoints: 0 }).os).toBe('mac');
    expect(L.detectPlatform({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', maxTouchPoints: 5 }).os).toBe('ios');
    expect(L.detectPlatform({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1' })).toEqual({ os: 'ios', browser: 'chrome', mobile: true });
    expect(L.detectPlatform({ ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36' })).toEqual({ os: 'android', browser: 'chrome', mobile: true });
  });
  it('has steps for every problem on every system (falling back to the general ones)', () => {
    for (const problem of Object.keys(MEDIA_COPY.problem)) {
      for (const os of ['windows', 'mac', 'ios', 'android', 'other']) expect(L.stepsFor(MEDIA_COPY.steps, problem, os).length, `${problem}/${os}`).toBeGreaterThan(0);
    }
    expect(L.stepsFor(MEDIA_COPY.steps, 'system', 'windows')[0]).toMatch(/Privacy & security, Camera/);
    expect(L.stepsFor(MEDIA_COPY.steps, 'busy', 'windows').join(' ')).toMatch(/Snapdragon/);
  });
});

describe('active speaker', () => {
  it('switches only after a voice holds the lead, and keeps the last speaker in a silence', () => {
    const sp = L.createSpeaker({ hold: 900, dwell: 2500 });
    let t = 0;
    expect(sp.feed({ a: 0.3, b: 0.01 }, t)).toBeNull();
    t += 1000; expect(sp.feed({ a: 0.3, b: 0.01 }, t)).toBe('a');
    // A cough from b doesn't steal the stage.
    t += 500; expect(sp.feed({ a: 0.25, b: 0.6 }, t)).toBe('a');
    t += 500; expect(sp.feed({ a: 0.25, b: 0.01 }, t)).toBe('a');
    // Silence: a stays.
    for (let i = 0; i < 5; i++) { t += 500; expect(sp.feed({ a: 0, b: 0 }, t)).toBe('a'); }
    // b talks for real.
    for (let i = 0; i < 4; i++) { t += 500; sp.feed({ a: 0.01, b: 0.4 }, t); }
    expect(sp.current).toBe('b');
  });
  it('respects the minimum dwell between switches', () => {
    const sp = L.createSpeaker({ hold: 0, dwell: 3000 });
    sp.feed({ a: 0.5 }, 0); sp.feed({ a: 0.5 }, 1);
    expect(sp.current).toBe('a');
    sp.feed({ a: 0, b: 0.8 }, 500); sp.feed({ a: 0, b: 0.8 }, 1000);
    expect(sp.current).toBe('a');
    sp.feed({ a: 0, b: 0.8 }, 3100);
    expect(sp.current).toBe('b');
  });
});

describe('pre-join network verdict', () => {
  it('reads a good line as ready', () => {
    expect(L.netVerdict({ rtt: 30, down: 40, up: 10, udp: true, tcp: true, tls: true, turn: true, publisher: true })).toEqual({ level: 'good', keys: ['netGood'] });
  });
  it('explains a corporate network that only allows 443', () => {
    const v = L.netVerdict({ rtt: 30, down: 40, up: 10, udp: false, tcp: false, tls: true, turn: true, publisher: true });
    expect(v.level).toBe('fair');
    expect(v.keys).toContain('netTlsOnly');
  });
  it('says when calls are blocked, and when the upload is too slow for video', () => {
    expect(L.netVerdict({ udp: false, tcp: false, tls: false, turn: true }).level).toBe('blocked');
    const slow = L.netVerdict({ rtt: 80, down: 10, up: 0.4, turn: false, publisher: true });
    expect(slow.level).toBe('poor');
    expect(slow.keys).toContain('netSlowUp');
    expect(L.netVerdict({ rtt: 80, down: 10, up: 0.4, turn: false, publisher: false }).level).toBe('good');
  });
  it('has copy for every key it can return', () => {
    for (const k of ['netGood', 'netSlowRtt', 'netSlowDown', 'netSlowUp', 'netTcpOnly', 'netTlsOnly', 'netBlocked']) expect(typeof (MEDIA_COPY as Any)[k]).toBe('string');
  });
});

describe('Opus settings', () => {
  const sdp = ['v=0', 'o=- 1 2 IN IP4 0.0.0.0', 's=-', 't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 0', 'a=mid:0', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', 'a=rtpmap:0 PCMU/8000',
    'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:1', 'a=rtpmap:96 VP8/90000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 109', 'a=mid:2', 'a=rtpmap:109 opus/48000/2', ''].join('\r\n');
  it('sets DTX on voice and stereo at 128 kbps on shared sound, FEC on both', () => {
    const out = L.tuneOpus(sdp, { dtx: ['0'], stereo: ['2'] });
    expect(out).toContain('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1');
    expect(out).toContain('a=fmtp:109 useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000;usedtx=0');
    expect(out).toContain('m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1');
    expect(out.split('\r\n').length).toBe(sdp.split('\r\n').length + 1);
  });
  it('leaves an SDP without audio unchanged', () => {
    const v = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:1', ''].join('\r\n');
    expect(L.tuneOpus(v, { dtx: ['1'] })).toBe(v);
  });
});

describe('the reconnect hold (server)', () => {
  const who = { id: 'reg:1', name: 'Ada', role: 'attendee' as const };
  const room = () => {
    const st = newRoomState({ id: 'r1', mode: 'webinar', title: 'T', startsAt: null });
    st.status = 'live';
    join(st, who, 0);
    const m = st.members[who.id];
    m.stage = true; m.sessionId = 'abcdefgh12'; m.tracks = [{ trackName: 'reg1-audio', kind: 'audio' }]; m.hand = 1;
    return st;
  };
  it('keeps the place of someone whose connection dropped (no goodbye)', () => {
    const st = room();
    expect(holdOnClose(st, who.id, 1006, 1000)).toBe(true);
    expect(st.members[who.id].connected).toBe(1);
    expect(st.members[who.id].stage).toBe(true);
    expect(isHeld(st, who.id, 1000 + HOLD_MS - 1)).toBe(true);
    expect(heldIds(st, 2000)).toEqual([who.id]);
  });
  it('hands the held place to the new socket: stage, tracks and media session survive', () => {
    const st = room();
    holdOnClose(st, who.id, 1006, 1000);
    expect(resume(st, who.id, 5000)).toEqual({ sessionId: 'abcdefgh12' });
    join(st, who, 5000);
    const m = st.members[who.id];
    expect(m.connected).toBe(1);
    expect(m.stage).toBe(true);
    expect(m.tracks.length).toBe(1);
    expect(heldIds(st, 5000)).toEqual([]);
  });
  it('lets people leave on purpose, and lets an expired hold become a departure', () => {
    const st = room();
    for (const code of [1000, 1001, 1005, 4003]) expect(holdOnClose(st, who.id, code, 1000)).toBe(false);
    holdOnClose(st, who.id, 1006, 1000);
    expect(isHeld(st, who.id, 1000 + HOLD_MS + 1)).toBe(false);
    expect(resume(st, who.id, 1000 + HOLD_MS + 1)).toBeNull();
    leave(st, who.id, 1000 + HOLD_MS + 1);
    expect(st.members[who.id].stage).toBe(false);
    expect(st.members[who.id].sessionId).toBeNull();
  });
  it('does not hold for a second socket, a banned person or an ended room', () => {
    const st = room();
    join(st, who, 10);
    expect(holdOnClose(st, who.id, 1006, 1000)).toBe(false);
    const st2 = room(); st2.banned.push(who.id);
    expect(holdOnClose(st2, who.id, 1006, 1000)).toBe(false);
    const st3 = room(); st3.status = 'ended';
    expect(holdOnClose(st3, who.id, 1006, 1000)).toBe(false);
  });
});

describe('quality reports (server)', () => {
  const m = { id: 'reg:1', name: 'Ada', role: 'attendee' as const, leadId: 'L1' };
  const rep = (o: Record<string, unknown> = {}) => cleanReport({ level: 'good', score: 92, rtt: 40, loss: 0.01, jitter: 9, inKbps: 900, outKbps: 0, tier: 0, rc: 0, path: 'sfu', os: 'windows', browser: 'edge', ...o })!;
  it('bounds and cleans what a browser sends', () => {
    expect(cleanReport({ level: 'excellent' })).toBeNull();
    expect(cleanReport('x')).toBeNull();
    const r = cleanReport({ level: 'poor', score: 400, rtt: -5, loss: 3, tier: 9, path: 'evil', os: '<script>', browser: 'chrome' })!;
    expect(r.score).toBe(100);
    expect(r.rtt).toBe(0);
    expect(r.loss).toBe(1);
    expect(r.tier).toBe(3);
    expect(r.path).toBe('none');
    expect(r.os).toBe('script');
  });
  it('folds reports into a summary and tells staff only about changes', () => {
    const a = mergeReport(null, rep(), m, 1000);
    expect(a.changed).toBe(true);
    const b = mergeReport(a.rec, rep({ rtt: 60 }), m, 3000);
    expect(b.changed).toBe(false);
    const c = mergeReport(b.rec, rep({ level: 'poor', tier: 2, rc: 1 }), m, 5000);
    expect(c.changed).toBe(true);
    expect(c.rec.samples).toBe(3);
    expect(c.rec.worst).toBe('poor');
    expect(c.rec.counts).toEqual({ good: 2, fair: 0, poor: 1, bad: 0 });
    expect(c.rec.sums.rtt / c.rec.sums.rttN).toBeCloseTo(46.67, 1);
  });
  it('summarises a room for Funnel HQ', () => {
    const row = (o: Partial<MediaRow>): MediaRow => ({ who: 'x', name: 'x', role: 'attendee', os: 'mac', browser: 'safari', mobile: 0, path: 'sfu', relay: 0, proto: null, first_at: 0, last_at: 0, samples: 10, reconnects: 0, worst: 'good', n_good: 10, n_fair: 0, n_poor: 0, n_bad: 0, rtt_avg: 50, loss_avg: 0, jitter_avg: 5, kbps_in_avg: 800, kbps_out_avg: 0, audio_only_samples: 0, fx: null, noise: null, ...o });
    const s = summarize([row({}), row({ rtt_avg: 120, n_good: 5, n_poor: 5, reconnects: 2, relay: 1 }), row({ path: 'moq', rtt_avg: 80 })]);
    expect(s).toMatchObject({ people: 3, medianRtt: 80, reconnects: 2, relayed: 1, trouble: 1, byPath: { sfu: 2, moq: 1 } });
  });
});

describe('settings, page config and copy', () => {
  it('turns the CDN features on by default and off with the settings', () => {
    expect(mediaConfig({}).fx).toBe(true);
    expect(mediaConfig({}).cdn?.vision).toMatch(/@mediapipe\/tasks-vision@\d+\.\d+\.\d+\//);
    expect(mediaCsp({}).script).toContain('https://cdn.jsdelivr.net');
    const off = { ROOM_FX: 'off', ROOM_NOISE_WASM: 'off' };
    expect(mediaConfig(off).cdn).toBeNull();
    expect(mediaCsp(off)).toEqual({ script: '', connect: '' });
  });
  it('pins every third-party build to an exact version', () => {
    const cdn = mediaConfig({}).cdn!;
    for (const k of ['vision', 'visionWasm', 'rnnoiseWorklet', 'rnnoiseWasm', 'rnnoiseSimd'] as const) expect(cdn[k]).toMatch(/@\d+\.\d+\.\d+\//);
  });
  it('defines its settings in the Live group', () => {
    const keys = (SETTINGS as readonly { key: string; group: string }[]).filter((s) => s.key === 'ROOM_FX' || s.key === 'ROOM_NOISE_WASM');
    expect(keys.map((k) => k.group)).toEqual(['Live', 'Live']);
  });
  it('passes the copy rules', () => {
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (typeof v === 'function') strings.push(String((v as (a: string) => string)('3')));
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(MEDIA_COPY);
    expect(strings.length).toBeGreaterThan(80);
    for (const s of strings) {
      expect(auditCopy(s), s).toEqual([]);
      expect(s, s).not.toMatch(/[—!]/);
    }
  });
});

describe('browser files', () => {
  it('the room page loads the media files before room.js, and room.js exposes RoomCore', () => {
    const routes = fs.readFileSync(path.join(cwd(), 'src/rooms/routes.ts'), 'utf8');
    const i = routes.indexOf('/assets/room-media-logic.js'), j = routes.indexOf('/assets/room-media.js'), k = routes.indexOf('<script defer src="/assets/room.js">');
    expect(i).toBeGreaterThan(0);
    expect(i < j && j < k).toBe(true);
    const room = fs.readFileSync(path.join(cwd(), 'public/assets/room.js'), 'utf8');
    expect(room).toContain('window.RoomCore = {');
    for (const hook of ['deviceCheck', 'keepMediaOnDrop', 'resumeMedia', 'sendInit', 'tuneRemote', 'tuneLocal', 'pickRid', 'ownsStats', 'personBadge']) expect(room).toContain(`MH('${hook}'`);
  });
});

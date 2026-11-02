/* Rooms, call quality and reliability (area A "media"): the pure decisions, with no DOM and no WebRTC objects,
   so test/media.test.ts can run every one of them. room-media.js feeds them what the browser reports.
   - pickLayer: which simulcast layer a tile needs (its size on screen, the bandwidth tier, page visibility);
   - summarizeStats + scoreQuality: one quality sample from getStats (round trip, loss, jitter, bitrates);
   - createGovernor: bandwidth tiers with hysteresis (lower layers, then audio only, then back on its own);
   - createRetry / connectionPhase: bounded backoff and the reconnect banner's real state;
   - pickDevice / deviceChange: which camera or mic to use when one disappears or comes back;
   - frameStats / classifyFrames: flat, black or frozen placeholder frames (privacy shutters, the Windows padlock);
   - classifyError / detectPlatform: why getUserMedia failed, and on which system, for the right steps;
   - createSpeaker: active speaker with smoothing, a hold and a minimum dwell;
   - netVerdict: the pre-join network test's verdict; tuneOpus: Opus DTX, FEC and stereo in an SDP. */
(function (root) {
  'use strict';

  // ───────────── simulcast layer per tile ─────────────
  /** Layer heights the publisher sends (room.js: f full 720p, h half, q quarter). */
  var LAYERS = [['q', 180], ['h', 360], ['f', 720]];
  /**
   * The layer one remote video needs. o: { simulcast, kind ('video'|'screen'), tileH (CSS px), dpr, tier (0..3),
   * visible (tile on screen), hidden (page in the background) }. Returns 'f' | 'h' | 'q', 'off' (do not pull
   * this video now) or null (not simulcast: the one layer there is).
   */
  function pickLayer(o) {
    var tier = o.tier || 0;
    if (o.kind === 'screen') return null; // shared screens carry the content: one detailed layer, never dropped
    if (tier >= 3) return 'off';
    if (!o.simulcast) return null;
    if (o.hidden || o.visible === false) return 'q';
    var need = Math.max(0, Number(o.tileH) || 0) * Math.min(2, Math.max(1, Number(o.dpr) || 1));
    var rid = 'q';
    for (var i = 0; i < LAYERS.length; i++) { rid = LAYERS[i][0]; if (LAYERS[i][1] >= need * 0.8) break; }
    var cap = tier >= 2 ? 'q' : tier === 1 ? 'h' : 'f';
    return rank(rid) > rank(cap) ? cap : rid;
  }
  function rank(rid) { return rid === 'f' ? 2 : rid === 'h' ? 1 : 0; }

  // ───────────── stats → one quality sample ─────────────
  /**
   * Reduces a getStats() report (as a plain array of stats objects) against the previous summary.
   * Returns { at, rtt (ms), loss (0..1, worst direction), jitter (ms), inKbps, outKbps, availOut, availIn (kbps),
   * fpsIn, relay (bool), proto ('udp'|'tcp'|'tls'), raw: counters for the next call }.
   */
  function summarizeStats(list, prev, now) {
    var out = { at: now, rtt: null, loss: 0, jitter: null, inKbps: null, outKbps: null, availOut: null, availIn: null, fpsIn: null, relay: false, proto: null, raw: { bytesIn: 0, bytesOut: 0, recv: 0, lost: 0 } };
    var byId = {};
    list.forEach(function (s) { byId[s.id] = s; });
    var jit = [], fps = [], remoteLoss = [];
    list.forEach(function (s) {
      if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state !== 'failed') {
        if (typeof s.currentRoundTripTime === 'number') out.rtt = Math.round(s.currentRoundTripTime * 1000);
        if (typeof s.availableOutgoingBitrate === 'number') out.availOut = Math.round(s.availableOutgoingBitrate / 1000);
        if (typeof s.availableIncomingBitrate === 'number') out.availIn = Math.round(s.availableIncomingBitrate / 1000);
        var lc = byId[s.localCandidateId];
        if (lc) { out.relay = lc.candidateType === 'relay'; out.proto = lc.relayProtocol || lc.protocol || null; }
      }
      if (s.type === 'inbound-rtp') {
        out.raw.bytesIn += s.bytesReceived || 0; out.raw.recv += s.packetsReceived || 0; out.raw.lost += Math.max(0, s.packetsLost || 0);
        if (s.kind === 'audio' && typeof s.jitter === 'number') jit.push(s.jitter * 1000);
        if (s.kind === 'video' && typeof s.framesPerSecond === 'number') fps.push(s.framesPerSecond);
      }
      if (s.type === 'outbound-rtp') out.raw.bytesOut += s.bytesSent || 0;
      if (s.type === 'remote-inbound-rtp') {
        if (typeof s.fractionLost === 'number') remoteLoss.push(s.fractionLost);
        if (out.rtt == null && typeof s.roundTripTime === 'number') out.rtt = Math.round(s.roundTripTime * 1000);
        if (typeof s.jitter === 'number') jit.push(s.jitter * 1000);
      }
    });
    if (jit.length) out.jitter = Math.round(Math.max.apply(null, jit));
    if (fps.length) out.fpsIn = Math.round(Math.min.apply(null, fps));
    var inLoss = 0;
    if (prev && prev.raw && prev.at && now > prev.at) {
      var dt = (now - prev.at) / 1000;
      var dIn = out.raw.bytesIn - prev.raw.bytesIn, dOut = out.raw.bytesOut - prev.raw.bytesOut;
      if (dIn >= 0) out.inKbps = Math.round(dIn * 8 / dt / 1000);
      if (dOut >= 0) out.outKbps = Math.round(dOut * 8 / dt / 1000);
      var dr = out.raw.recv - prev.raw.recv, dl = out.raw.lost - prev.raw.lost;
      if (dr + dl > 0 && dl >= 0) inLoss = dl / (dr + dl);
    }
    out.loss = Math.round(Math.max(inLoss, remoteLoss.length ? Math.max.apply(null, remoteLoss) : 0) * 1000) / 1000;
    return out;
  }

  /**
   * A 0..100 score from one sample, its level and the main reason. o: { rtt, loss, jitter, availOut, availIn,
   * publishing }. Penalties follow what people hear first: loss, then delay, then jitter, then bandwidth.
   */
  function scoreQuality(o) {
    var p = { loss: 0, latency: 0, jitter: 0, upload: 0, download: 0 };
    if (o.loss != null) p.loss = Math.min(60, o.loss * 100 * 4);
    if (o.rtt != null) p.latency = Math.min(40, Math.max(0, (o.rtt - 150) / 6));
    if (o.jitter != null) p.jitter = Math.min(25, Math.max(0, (o.jitter - 30) / 2));
    if (o.publishing && o.availOut != null) p.upload = o.availOut < 250 ? 35 : o.availOut < 600 ? 15 : 0;
    if (o.availIn != null) p.download = o.availIn < 250 ? 35 : o.availIn < 600 ? 15 : 0;
    var total = 0, why = null, worst = 0;
    Object.keys(p).forEach(function (k) { total += p[k]; if (p[k] > worst) { worst = p[k]; why = k; } });
    var score = Math.max(0, Math.round(100 - total));
    return { score: score, level: score >= 80 ? 'good' : score >= 60 ? 'fair' : score >= 40 ? 'poor' : 'bad', why: worst >= 5 ? why : null };
  }

  // ───────────── bandwidth tiers with hysteresis ─────────────
  var TIER_FOR = { good: 0, fair: 1, poor: 2, bad: 3 };
  /**
   * Tier 0 = every layer, 1 = no full layer, 2 = lowest layers, 3 = audio only (shared screens stay).
   * Down after `downAfter` samples in a row that want a lower tier (straight to that tier); up one step after
   * `upAfter` good samples in a row. A step up that falls back within `flapMs` doubles the wait next time.
   */
  function createGovernor(o) {
    o = o || {};
    var downAfter = o.downAfter || 2, upAfter = o.upAfter || 5, flapMs = o.flapMs || 30000, maxWait = o.maxWait || 40;
    var st = { tier: 0, down: 0, up: 0, need: upAfter, upAt: 0, stableSince: 0 };
    function feed(level, now) {
      var target = TIER_FOR[level] != null ? TIER_FOR[level] : st.tier;
      var before = st.tier;
      if (target > st.tier) {
        st.up = 0; st.down++;
        if (st.down >= downAfter) {
          if (st.upAt && now - st.upAt < flapMs) st.need = Math.min(maxWait, st.need * 2);
          st.tier = target; st.down = 0; st.stableSince = now;
        }
      } else if (target < st.tier) {
        st.down = 0; st.up++;
        if (st.up >= st.need) { st.tier--; st.up = 0; st.upAt = now; }
      } else { st.down = 0; st.up = 0; }
      if (st.need > upAfter && st.stableSince && now - st.stableSince > 120000 && st.tier === 0) st.need = upAfter;
      var notice = null;
      if (st.tier === 3 && before < 3) notice = 'audioOnly';
      else if (before === 3 && st.tier < 3) notice = 'videoBack';
      return { tier: st.tier, changed: st.tier !== before, notice: notice, need: st.need };
    }
    return { feed: feed, get tier() { return st.tier; }, force: function (t) { st.tier = t; st.down = 0; st.up = 0; } };
  }

  // ───────────── retries and the reconnect banner ─────────────
  /** Exponential backoff with jitter: base·factor^attempt, capped, ±20 % so a room full of people doesn't retry in step. */
  function backoff(attempt, o, rnd) {
    o = o || {};
    var base = o.base || 600, factor = o.factor || 1.8, max = o.max || 15000;
    var r = typeof rnd === 'number' ? rnd : Math.random();
    var d = Math.min(max, base * Math.pow(factor, Math.max(0, attempt)));
    return Math.round(d * (0.8 + 0.4 * r));
  }
  /** A bounded retry: next() gives the wait and the attempt number, or giveUp once maxAttempts are spent. */
  function createRetry(o) {
    o = o || {};
    var max = o.maxAttempts || 8, n = 0;
    return {
      next: function (rnd) { if (n >= max) return { giveUp: true, attempt: n }; var d = backoff(n, o, rnd); n++; return { giveUp: false, attempt: n, delay: d }; },
      reset: function () { n = 0; },
      get attempts() { return n; },
    };
  }
  /**
   * What the banner says, from the real state. o: { online, ws ('open'|'connecting'|'closed'), pc ('new'|
   * 'connecting'|'connected'|'disconnected'|'failed'|'closed'|null), media (expects media), retryIn (ms or null),
   * attempt, gaveUp }. Returns { key, secs } with key one of null (all fine), 'offline', 'reconnecting',
   * 'retrying', 'mediaReconnecting', 'gaveUp'.
   */
  function connectionPhase(o) {
    if (o.online === false) return { key: 'offline', secs: null };
    if (o.gaveUp) return { key: 'gaveUp', secs: null };
    if (o.ws && o.ws !== 'open') return o.retryIn != null && o.retryIn > 1500 ? { key: 'retrying', secs: Math.ceil(o.retryIn / 1000) } : { key: 'reconnecting', secs: null };
    if (o.media && (o.pc === 'disconnected' || o.pc === 'failed')) return { key: 'mediaReconnecting', secs: null };
    return { key: null, secs: null };
  }

  // ───────────── devices ─────────────
  var VIRTUAL = /\b(virtual|obs|ndi|snap camera|manycam|xsplit|splitcam|droidcam virtual|vb-audio|voicemeeter|blackhole|soundflower|loopback)\b/i;
  /**
   * The device to use for one kind ('videoinput'|'audioinput'|'audiooutput'). o: { preferredId, preferredLabel,
   * avoidId }. The person's own choice when it's there (by id, then by name: ids change after a browser reset),
   * else the system default, else the first real device, else a virtual one. null when there's none.
   */
  function pickDevice(devices, kind, o) {
    o = o || {};
    var list = (devices || []).filter(function (d) { return d.kind === kind && d.deviceId && d.deviceId !== o.avoidId; });
    if (!list.length) return null;
    var byId = function (id) { return list.filter(function (d) { return d.deviceId === id; })[0]; };
    if (o.preferredId && byId(o.preferredId)) return o.preferredId;
    if (o.preferredLabel) { var l = list.filter(function (d) { return d.label && d.label === o.preferredLabel; })[0]; if (l) return l.deviceId; }
    if (byId('default')) return 'default';
    var real = list.filter(function (d) { return d.deviceId !== 'communications' && !VIRTUAL.test(d.label || ''); });
    return (real[0] || list[0]).deviceId;
  }
  /**
   * After a devicechange (or a track ending): keep, switch away from a device that disappeared, or switch back
   * to the person's chosen device when it returns. o: { activeId, activeLabel, ended, preferredId, preferredLabel }.
   */
  function deviceChange(devices, kind, o) {
    var list = (devices || []).filter(function (d) { return d.kind === kind && d.deviceId; });
    var has = function (id, label) { return list.some(function (d) { return (id && d.deviceId === id) || (label && d.label === label); }); };
    var activeThere = o.activeId ? has(o.activeId, null) : has(null, o.activeLabel);
    if (o.preferredId && o.activeId !== o.preferredId && has(o.preferredId, null) && !o.ended) return { action: 'switch', to: o.preferredId, reason: 'back' };
    if (!o.ended && activeThere) return { action: 'keep', to: o.activeId || null, reason: null };
    var to = pickDevice(devices, kind, { preferredId: o.preferredId, preferredLabel: o.preferredLabel, avoidId: o.ended && !activeThere ? o.activeId : null });
    if (!to) return { action: 'none', to: null, reason: 'lost' };
    return { action: 'switch', to: to, reason: 'lost' };
  }

  // ───────────── placeholder frames ─────────────
  /**
   * Luma statistics of one small RGBA frame (a 64x36 draw of the video), against the previous frame's luma.
   * Returns { mean, std, diff (mean absolute change, null on the first frame), luma (for the next call) }.
   */
  function frameStats(rgba, w, h, prevLuma) {
    var n = w * h, luma = new Float32Array(n), sum = 0, sq = 0, d = 0;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var y = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
      luma[i] = y; sum += y; sq += y * y;
      if (prevLuma) d += Math.abs(y - prevLuma[i]);
    }
    var mean = sum / n;
    return { mean: mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)), diff: prevLuma ? d / n : null, luma: luma };
  }
  /**
   * What the camera is really sending, from a few seconds of frameStats samples: 'ok', 'noframes', 'black'
   * (closed shutter, covered lens), 'flat' (one colour: a stand-in image) or 'frozen' (the same picture every
   * time, such as the Windows camera privacy padlock image). A real sensor always has some noise between frames.
   */
  function classifyFrames(samples, o) {
    o = o || {};
    var minSamples = o.minSamples || 4;
    if (!samples || !samples.length) return 'noframes';
    if (samples.length < minSamples) return 'ok';
    var all = function (f) { return samples.every(f); };
    if (all(function (s) { return s.mean < 12 && s.std < 6; })) return 'black';
    if (all(function (s) { return s.std < 4; })) return 'flat';
    var diffs = samples.filter(function (s) { return s.diff != null; });
    if (diffs.length >= minSamples - 1 && diffs.every(function (s) { return s.diff < (o.still || 0.12); })) return 'frozen';
    return 'ok';
  }

  // ───────────── getUserMedia failures and the platform ─────────────
  /** 'busy' | 'system' | 'denied' | 'notfound' | 'constraints' | 'insecure' | 'unknown' */
  function classifyError(e) {
    var name = e && e.name, msg = String((e && e.message) || '');
    if (!name) return 'unknown';
    if (name === 'NotReadableError' || name === 'TrackStartError' || (name === 'AbortError' && /start|device|source/i.test(msg))) return 'busy';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return /system|platform/i.test(msg) && !/user agent or the platform/i.test(msg) ? 'system' : 'denied';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'notfound';
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return 'constraints';
    if (name === 'SecurityError' || name === 'TypeError') return 'insecure';
    return 'unknown';
  }
  /** o: { ua, platform (UA-CH), maxTouchPoints } → { os, browser, mobile } */
  function detectPlatform(o) {
    var ua = String(o.ua || ''), plat = String(o.platform || '');
    var os = 'other';
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (o.maxTouchPoints || 0) > 1)) os = 'ios';
    else if (/Android/.test(ua)) os = 'android';
    else if (/Windows/.test(ua) || /Windows/i.test(plat)) os = 'windows';
    else if (/CrOS/.test(ua)) os = 'chromeos';
    else if (/Macintosh|Mac OS X/.test(ua) || /macOS/i.test(plat)) os = 'mac';
    else if (/Linux/.test(ua)) os = 'linux';
    var browser = /Edg\//.test(ua) ? 'edge' : /SamsungBrowser/.test(ua) ? 'samsung' : /Firefox|FxiOS/.test(ua) ? 'firefox' : /CriOS|Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
    return { os: os, browser: browser, mobile: os === 'ios' || os === 'android' };
  }
  /** The steps for one problem on one system, from the copy table { problem: { os: [steps], other: [...] } }. */
  function stepsFor(table, problem, os) {
    var t = table && table[problem];
    if (!t) return [];
    return t[os] || t.other || [];
  }

  // ───────────── active speaker ─────────────
  /**
   * Smoothed active speaker. feed({ id: level 0..1 }, now) → the speaker's id (or the last one in a silence).
   * A new voice takes over after holding the lead for `hold` ms, by `margin` over the current one (or once the
   * current one is quiet), and never sooner than `dwell` ms after the last switch.
   */
  function createSpeaker(o) {
    o = o || {};
    var d = function (k, v) { return o[k] != null ? o[k] : v; };
    var threshold = d('threshold', 0.03), hold = d('hold', 900), dwell = d('dwell', 2500), margin = d('margin', 1.4), alpha = d('alpha', 0.45);
    var ema = {}, cur = null, cand = null, candSince = 0, switchedAt = -Infinity;
    function feed(levels, now) {
      Object.keys(ema).forEach(function (k) { if (!(k in levels)) ema[k] *= (1 - alpha); });
      Object.keys(levels).forEach(function (k) { ema[k] = (ema[k] || 0) * (1 - alpha) + levels[k] * alpha; });
      var best = null, bl = threshold;
      Object.keys(ema).forEach(function (k) { if (ema[k] > bl) { bl = ema[k]; best = k; } });
      if (!best || best === cur) { cand = null; return cur; }
      if (best !== cand) { cand = best; candSince = now; }
      var curLevel = cur ? (ema[cur] || 0) : 0;
      var beats = !cur || curLevel < threshold || ema[best] > curLevel * margin;
      if (beats && now - candSince >= hold && now - switchedAt >= dwell) { cur = best; switchedAt = now; cand = null; }
      return cur;
    }
    return { feed: feed, get current() { return cur; }, forget: function (id) { delete ema[id]; if (cur === id) cur = null; } };
  }

  // ───────────── pre-join network verdict ─────────────
  /**
   * o: { rtt (ms), down, up (Mbps), udp, tcp, tls (TURN reachable that way; null = not tested), turn (TURN set
   * up), publisher }. → { level: 'good'|'fair'|'poor'|'blocked', keys: [...copy keys] }.
   */
  function netVerdict(o) {
    var keys = [];
    var anyTurn = o.udp || o.tcp || o.tls;
    if (o.turn && o.udp === false && o.tcp === false && o.tls === false) return { level: 'blocked', keys: ['netBlocked'] };
    if (o.turn && o.udp === false && anyTurn) keys.push(o.tls && !o.tcp ? 'netTlsOnly' : 'netTcpOnly');
    var needDown = 1.5, needUp = o.publisher ? 1.2 : 0.1;
    var level = 'good';
    if (o.rtt != null && o.rtt > 400) { level = 'poor'; keys.push('netSlowRtt'); } else if (o.rtt != null && o.rtt > 200) { level = 'fair'; keys.push('netSlowRtt'); }
    if (o.down != null && o.down < needDown / 2) { level = 'poor'; keys.push('netSlowDown'); } else if (o.down != null && o.down < needDown) { if (level === 'good') level = 'fair'; keys.push('netSlowDown'); }
    if (o.publisher && o.up != null && o.up < needUp / 2) { level = 'poor'; keys.push('netSlowUp'); } else if (o.publisher && o.up != null && o.up < needUp) { if (level === 'good') level = 'fair'; keys.push('netSlowUp'); }
    if (keys.indexOf('netTcpOnly') >= 0 || keys.indexOf('netTlsOnly') >= 0) { if (level === 'good') level = 'fair'; }
    if (!keys.length) keys.push('netGood');
    return { level: level, keys: keys };
  }

  // ───────────── Opus settings in an SDP ─────────────
  /**
   * Sets Opus parameters per m=audio section: in-band FEC everywhere; DTX for voice (`dtx` mids); stereo at
   * 128 kbps for shared-screen sound (`stereo` mids, where music matters, without DTX). Returns the new SDP.
   */
  function tuneOpus(sdp, o) {
    o = o || {};
    var dtx = o.dtx || [], stereo = o.stereo || [];
    var nl = sdp.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    var parts = sdp.split(nl + 'm=');
    for (var i = 1; i < parts.length; i++) {
      var sec = 'm=' + parts[i];
      if (!/^m=audio /.test(sec)) continue;
      var mid = (sec.match(/a=mid:(\S+)/) || [])[1];
      var pt = (sec.match(/a=rtpmap:(\d+) opus\/48000/i) || [])[1];
      if (!pt) continue;
      var want = { useinbandfec: '1' };
      if (stereo.indexOf(mid) >= 0) { want.stereo = '1'; want['sprop-stereo'] = '1'; want.maxaveragebitrate = '128000'; want.usedtx = '0'; }
      else if (dtx.indexOf(mid) >= 0) want.usedtx = '1';
      var re = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)');
      var m = sec.match(re);
      var params = {};
      if (m) m[1].split(';').forEach(function (kv) { var p = kv.split('='); if (p[0].trim()) params[p[0].trim()] = (p[1] || '').trim(); });
      Object.keys(want).forEach(function (k) { params[k] = want[k]; });
      var line = 'a=fmtp:' + pt + ' ' + Object.keys(params).map(function (k) { return k + '=' + params[k]; }).join(';');
      if (m) sec = sec.replace(re, line);
      else sec = sec.replace(new RegExp('(a=rtpmap:' + pt + ' [^\\r\\n]*)'), '$1' + nl + line);
      parts[i] = sec.slice(2);
    }
    return parts.join(nl + 'm=');
  }

  var api = {
    pickLayer: pickLayer, summarizeStats: summarizeStats, scoreQuality: scoreQuality, createGovernor: createGovernor,
    backoff: backoff, createRetry: createRetry, connectionPhase: connectionPhase,
    pickDevice: pickDevice, deviceChange: deviceChange, frameStats: frameStats, classifyFrames: classifyFrames,
    classifyError: classifyError, detectPlatform: detectPlatform, stepsFor: stepsFor,
    createSpeaker: createSpeaker, netVerdict: netVerdict, tuneOpus: tuneOpus,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoomMediaLogic = api;
})(this);

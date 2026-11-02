/* Rooms, call quality and reliability (area A "media"). Loaded before room.js, which calls the hooks on
   window.RoomMedia and exposes window.RoomCore (its state, calls and an event emitter). Decisions live in
   room-media-logic.js (tested); this file does the browser work:
   - the pre-join check: camera, mic and speaker with a live preview, level meter and test chime; a real network
     test (round trip, download and upload against our Worker; TURN over UDP, TCP and TLS 443); clear steps per
     failure for Windows, macOS, iOS and Android (camera in use, blocked by the system, still or black frames);
     choices remembered in this browser;
   - in the call: reconnects without losing the room (the server holds our place), media rebuilt after a network
     change, bounded retries with a banner that says what is happening, devices that disappear or come back,
     the screen kept awake on phones, tabs in the background;
   - quality: layers per tile size and bandwidth tier, audio only when the connection is too weak (and back on
     its own), a quality indicator for everyone and per person for staff, smoothed active speaker, Opus DTX, FEC
     and stereo for shared sound, content hints, screen share at full resolution and low frame rate;
   - effects: background blur and the G&L backdrop (room-media-fx.js, loaded on demand), noise reduction with an
     optional RNNoise worklet, push to talk for staff. */
(function () {
  'use strict';
  var L = window.RoomMediaLogic;
  var cfgEl = document.getElementById('room-config');
  if (!L || !cfgEl) return;
  var CFG0; try { CFG0 = JSON.parse(cfgEl.textContent); } catch (e) { return; }
  var MCFG = CFG0.media; if (!MCFG || !MCFG.copy) return;
  var MC = MCFG.copy;
  var PLAT = L.detectPlatform({ ua: navigator.userAgent, platform: navigator.userAgentData && navigator.userAgentData.platform, maxTouchPoints: navigator.maxTouchPoints });
  var R = null; // window.RoomCore once room.js has run
  var S = null;

  // ───────────── remembered choices (this browser only) ─────────────
  var PREF_KEY = 'rm.media.v1';
  var P = (function () { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { return {}; } })();
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(P)); } catch (e) { /* private mode */ } }
  if (!P.noise) P.noise = 'std';
  if (!P.fx || !MCFG.fx) P.fx = P.fx && MCFG.fx ? P.fx : 'off';
  if (P.noise === 'strong' && !MCFG.rnnoise) P.noise = 'std';

  var M = {
    tier: 0, gov: L.createGovernor(), speaker: L.createSpeaker(), prev: null, sample: null, q: null, rc: 0,
    lastSent: 0, lastSentKey: '', held: {}, people: {}, rawCam: null, rawMic: null, fx: null, ns: null,
    wsRtt: null, pingAt: 0, lastMsgAt: Date.now(), netChangedAt: 0, rebuilds: [], gaveUp: false, wake: null,
    resumeTimer: 0, notices: {}, upWarnAt: 0, mutedWarnAt: 0, net: null,
  };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var tpl = function (s, a) { return String(s || '').replace('{a}', a); };
  function h(tag, attrs, html) { var e = document.createElement(tag); if (attrs) Object.keys(attrs).forEach(function (k) { if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }); if (html != null) e.innerHTML = html; return e; }
  function stopTrack(t) { try { if (t) t.stop(); } catch (e) { /* stopped */ } }
  function toast(t) { if (R) R.toast(t); }

  // ───────────── constraints ─────────────
  function audioConstraints(id) {
    var c = { echoCancellation: true, noiseSuppression: P.noise !== 'off', autoGainControl: P.noise !== 'off', channelCount: { ideal: 1 } };
    var dev = id !== undefined ? id : P.mic;
    if (dev) c.deviceId = { exact: dev };
    return c;
  }
  function videoConstraints(id) {
    var c = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    var dev = id !== undefined ? id : P.cam;
    if (dev) c.deviceId = { exact: dev };
    else if (PLAT.mobile) c.facingMode = 'user';
    return c;
  }
  /** Opens a camera with fallbacks: the chosen one at HD, any camera, the camera's own default, then 640x480. */
  function openCam(id) {
    var md = navigator.mediaDevices;
    return md.getUserMedia({ video: videoConstraints(id) }).catch(function (e) {
      if (e && e.name === 'OverconstrainedError') return md.getUserMedia({ video: videoConstraints(null) });
      if (L.classifyError(e) !== 'busy') throw e;
      // Some cameras (Qualcomm on Windows on ARM among them) refuse HD or 30 fps but start at their own default.
      var dev = id || P.cam ? { deviceId: { exact: id || P.cam } } : {};
      return md.getUserMedia({ video: Object.keys(dev).length ? dev : true })
        .catch(function () { return md.getUserMedia({ video: Object.assign({ width: { ideal: 640 }, height: { ideal: 480 } }, dev) }); })
        .catch(function () { throw e; });
    }).then(function (s) { var t = s.getVideoTracks()[0]; if (t && 'contentHint' in t) t.contentHint = 'motion'; return t; });
  }
  function openMic(id) {
    return navigator.mediaDevices.getUserMedia({ audio: audioConstraints(id) }).catch(function (e) {
      if (e && e.name === 'OverconstrainedError') return navigator.mediaDevices.getUserMedia({ audio: audioConstraints(null) });
      throw e;
    }).then(function (s) { var t = s.getAudioTracks()[0]; if (t && 'contentHint' in t) t.contentHint = 'speech'; return t; });
  }
  function deviceIdOf(t) { try { return (t && t.getSettings && t.getSettings().deviceId) || null; } catch (e) { return null; } }

  // ───────────── effects: background (room-media-fx.js) and noise reduction ─────────────
  var fxLib = null;
  function loadFx() {
    if (window.RoomFx) return Promise.resolve(window.RoomFx);
    if (fxLib) return fxLib;
    fxLib = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = '/assets/room-media-fx.js'; s.async = true;
      s.onload = function () { window.RoomFx ? res(window.RoomFx) : rej(new Error('fx')); };
      s.onerror = function () { fxLib = null; rej(new Error('fx')); };
      document.head.appendChild(s);
    });
    return fxLib;
  }
  function fxSupported() { return Boolean(MCFG.fx && MCFG.cdn && window.WebGL2RenderingContext && HTMLCanvasElement.prototype.captureStream); }
  /**
   * The camera track people see: the raw camera, or the effect's output. The effect's track stops its pipeline
   * and the raw camera with it. Resolves to the track to use (the raw one when the effect can't run).
   */
  function withFx(raw, mode, note, onSlow) {
    M.rawCam = raw;
    if (!mode || mode === 'off' || !fxSupported()) { if (mode && mode !== 'off' && note) note(MC.fxUnsupported); return Promise.resolve(raw); }
    if (note) note(MC.fxLoading);
    return loadFx().then(function (FX) {
      return FX.create(raw, { mode: mode, cdn: MCFG.cdn, onSlow: onSlow || function () { fxOff(MC.fxSlow); } });
    }).then(function (fx) {
      M.fx = fx;
      var out = fx.track, stop = out.stop.bind(out);
      out.stop = function () { stop(); fx.stop(); stopTrack(raw); if (M.fx === fx) M.fx = null; };
      if (note) note(null);
      return out;
    }).catch(function (e) { console.warn('fx', e); if (note) note(MC.fxFailed); return raw; });
  }
  /** Turns the effect off in the call (too slow, or the person chose None): the raw camera goes back on air. */
  function fxOff(msg) {
    var fx = M.fx; if (!fx || !R) return;
    var raw = M.rawCam; M.fx = null;
    if (raw && raw.readyState === 'live' && S.local.cam && S.local.cam !== raw) {
      var out = S.local.cam; out.stop = MediaStreamTrack.prototype.stop.bind(out);
      replaceLocal('cam', raw).then(function () { stopTrack(out); fx.stop(); });
    } else fx.stop();
    if (msg) { P.fx = 'off'; savePrefs(); toast(msg); }
  }
  function setFx(mode) {
    P.fx = mode; savePrefs();
    if (!R || !S.local.cam) return Promise.resolve();
    if (M.fx) { if (mode === 'off') { fxOff(null); return Promise.resolve(); } M.fx.setMode(mode); return Promise.resolve(); }
    if (mode === 'off') return Promise.resolve();
    var raw = M.rawCam && M.rawCam.readyState === 'live' ? M.rawCam : S.local.cam;
    return withFx(raw, mode, function (t) { if (t) toast(t); }).then(function (t) { if (t !== raw) return replaceLocal('cam', t, true); });
  }

  var RN = { sab: null };
  function simd() { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; } }
  /** Strong noise reduction: RNNoise in an AudioWorklet between the raw mic and what we send. */
  function withRnnoise(raw) {
    var C = MCFG.cdn;
    if (!C || !window.AudioWorkletNode) return Promise.reject(new Error('unsupported'));
    var ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    return Promise.all([
      ctx.audioWorklet.addModule(C.rnnoiseWorklet),
      RN.sab || (RN.sab = fetch(simd() ? C.rnnoiseSimd : C.rnnoiseWasm, { mode: 'cors' }).then(function (r) { if (!r.ok) throw new Error('wasm'); return r.arrayBuffer(); })),
    ]).then(function (r) {
      var node = new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/rnnoise', { processorOptions: { maxChannels: 1, wasmBinary: r[1].slice(0) } });
      var src = ctx.createMediaStreamSource(new MediaStream([raw]));
      var dest = ctx.createMediaStreamDestination();
      src.connect(node); node.connect(dest);
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      var out = dest.stream.getAudioTracks()[0];
      var stop = out.stop.bind(out);
      out.stop = function () { stop(); stopTrack(raw); try { node.port.postMessage('destroy'); } catch (e) { /* gone */ } ctx.close().catch(function () {}); if (M.ns === out) M.ns = null; };
      M.ns = out;
      return out;
    }).catch(function (e) { ctx.close().catch(function () {}); throw e; });
  }
  function setNoise(mode) {
    P.noise = mode; savePrefs();
    if (!R || !S.local.mic) return;
    var raw = M.rawMic && M.rawMic.readyState === 'live' ? M.rawMic : S.local.mic;
    var c = { echoCancellation: true, noiseSuppression: mode !== 'off', autoGainControl: mode !== 'off' };
    try { raw.applyConstraints(c).catch(function () {}); } catch (e) { /* older browser */ }
    if (mode === 'strong' && !M.ns) {
      withRnnoise(raw).then(function (out) { return replaceLocal('mic', out, true); }).catch(function () { P.noise = 'std'; savePrefs(); toast(MC.noiseFailed); });
    } else if (mode !== 'strong' && M.ns && S.local.mic === M.ns) {
      var out = M.ns; out.stop = MediaStreamTrack.prototype.stop.bind(out);
      M.ns = null;
      replaceLocal('mic', raw).then(function () { stopTrack(out); });
    }
  }

  /**
   * Puts a new local track on air without renegotiating (replaceTrack), keeps mute and camera state, and stops
   * the old one. keepRaw: the old track is the raw source of the new one (an effect), so it keeps running.
   */
  function replaceLocal(kind, track, keepRaw) {
    var key = kind === 'mic' ? 'audio' : 'video';
    var old = S.local[kind];
    track.enabled = kind === 'mic' ? S.micOn : S.camOn;
    S.local[kind] = track;
    if (kind === 'mic' && !M.ns) M.rawMic = track;
    if (kind === 'cam' && !M.fx) M.rawCam = track;
    watchEnded(kind, kind === 'mic' ? M.rawMic : M.rawCam);
    var p = S.pubs[key];
    var go = p && p.tr && p.tr.sender ? p.tr.sender.replaceTrack(track) : Promise.resolve(R.syncMedia());
    return Promise.resolve(go).then(function () {
      if (old && old !== track && !keepRaw) stopTrack(old);
      if (kind === 'mic') meterFor(M.rawMic);
      R.renderStage(); R.renderBar();
    }).catch(function (e) { console.warn('replaceTrack', e); });
  }

  // ───────────── devices that disappear or come back ─────────────
  function watchEnded(kind, t) {
    if (!t || t.__rmWatched) return;
    t.__rmWatched = true;
    t.addEventListener('ended', function () { if (R && (kind === 'mic' ? M.rawMic : M.rawCam) === t) onDevices(kind, true); });
  }
  var devTimer = 0;
  function onDevices(only, ended) {
    clearTimeout(devTimer);
    devTimer = setTimeout(function () {
      if (!R || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      navigator.mediaDevices.enumerateDevices().then(function (list) {
        [['mic', 'audioinput'], ['cam', 'videoinput']].forEach(function (k) {
          if (only && only !== k[0]) return;
          var raw = k[0] === 'mic' ? M.rawMic : M.rawCam;
          if (!raw || !S.local[k[0]]) return;
          var d = L.deviceChange(list, k[1], { activeId: deviceIdOf(raw), activeLabel: raw.label, ended: raw.readyState === 'ended', preferredId: P[k[0]], preferredLabel: P[k[0] + 'Label'] });
          if (d.action === 'none') { toast(k[0] === 'mic' ? MC.micLost : MC.camLost); if (k[0] === 'mic') R.setMic(false); return; }
          if (d.action !== 'switch') return;
          switchDevice(k[0], d.to, true);
        });
        if (!only && S.devices.speaker && list.every(function (d) { return d.deviceId !== S.devices.speaker; })) { S.devices.speaker = null; setSpeaker(''); }
      }).catch(function () {});
    }, ended ? 100 : 700);
  }
  /** Opens another camera or mic and puts it on air (with the effect or noise reduction the person uses). */
  function switchDevice(kind, id, announce) {
    var open = kind === 'mic' ? openMic(id) : openCam(id);
    return open.then(function (raw) {
      var prevRaw = kind === 'mic' ? M.rawMic : M.rawCam;
      var wrap = kind === 'cam' ? (M.fx ? (function () { var f = M.fx; M.fx = null; var o = S.local.cam; if (o) o.stop = MediaStreamTrack.prototype.stop.bind(o); f.stop(); stopTrack(o); return withFx(raw, P.fx); })() : withFx(raw, P.fx))
        : (P.noise === 'strong' && MCFG.rnnoise ? (function () { if (M.ns) { var o = M.ns; o.stop = MediaStreamTrack.prototype.stop.bind(o); M.ns = null; stopTrack(o); } M.rawMic = raw; return withRnnoise(raw).catch(function () { return raw; }); })() : Promise.resolve(raw));
      return wrap.then(function (t) {
        if (kind === 'mic') M.rawMic = raw; else M.rawCam = raw;
        return replaceLocal(kind, t).then(function () {
          if (prevRaw && prevRaw !== raw) stopTrack(prevRaw);
          if (announce && raw.label) toast(tpl(kind === 'mic' ? MC.switchedMic : MC.switchedCam, raw.label));
          S.devices[kind] = id;
        });
      });
    }).catch(function (e) { console.warn('switch device', e); toast(kind === 'mic' ? MC.micLost : MC.camLost); });
  }
  function setSpeaker(id) {
    S.devices.speaker = id || null;
    Object.keys(S.audioEls).forEach(function (k) { var a = S.audioEls[k]; if (a.setSinkId) a.setSinkId(id || '').catch(function () {}); });
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', function () { onDevices(null, false); });

  // ───────────── mic level: the check screen, and "you are muted" in the call ─────────────
  var AX = { ctx: null, an: null, src: null, buf: null };
  function audioCtx() { if (!AX.ctx) { try { AX.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } } if (AX.ctx.state === 'suspended') AX.ctx.resume().catch(function () {}); return AX.ctx; }
  /** Analyses a clone of the raw mic: still measurable while the sent track is muted. */
  function meterFor(raw) {
    var ctx = audioCtx(); if (!ctx || !raw) return;
    try { if (AX.src) AX.src.disconnect(); if (AX.clone) AX.clone.stop(); } catch (e) { /* gone */ }
    AX.clone = raw.clone(); AX.clone.enabled = true;
    AX.an = ctx.createAnalyser(); AX.an.fftSize = 512; AX.buf = new Uint8Array(AX.an.fftSize);
    AX.src = ctx.createMediaStreamSource(new MediaStream([AX.clone])); AX.src.connect(AX.an);
  }
  function micLevel() {
    if (!AX.an) return 0;
    AX.an.getByteTimeDomainData(AX.buf);
    var m = 0; for (var i = 0; i < AX.buf.length; i++) m = Math.max(m, Math.abs(AX.buf[i] - 128));
    return m / 128;
  }
  var loud = 0;
  setInterval(function () {
    if (!R || !S.joined || !S.local.mic || S.micOn || P.ptt) { loud = 0; return; }
    loud = micLevel() > 0.18 ? loud + 1 : Math.max(0, loud - 1);
    if (loud >= 6 && Date.now() - M.mutedWarnAt > 45000) { M.mutedWarnAt = Date.now(); loud = 0; toast(MC.mutedSpeaking); }
  }, 250);

  // ───────────── push to talk (host and co-hosts) ─────────────
  var talking = false;
  function typing(e) { var t = e.target; return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName)); }
  document.addEventListener('keydown', function (e) {
    if (!R || !P.ptt || !R.isStaff || e.code !== 'Space' || e.repeat || typing(e) || !S.local.mic) return;
    e.preventDefault(); talking = true; R.setMic(true); document.body.classList.add('rmq-talking');
  });
  document.addEventListener('keyup', function (e) {
    if (!R || !talking || e.code !== 'Space') return;
    e.preventDefault(); talking = false; R.setMic(false); document.body.classList.remove('rmq-talking');
  });
  window.addEventListener('blur', function () { if (talking && R) { talking = false; R.setMic(false); document.body.classList.remove('rmq-talking'); } });

  // ───────────── the pre-join check ─────────────
  function deviceCheck(done, o) {
    boot();
    var C = R.C, CFG = R.CFG, ME = R.ME;
    var app = document.querySelector('[data-room]');
    var hasSink = 'setSinkId' in HTMLMediaElement.prototype;
    var fxChips = fxSupported() ? '<div class="rmq-fxbar" role="radiogroup" aria-label="' + esc(MC.background) + '">' + [['off', MC.fxOff], ['blur', MC.fxBlur], ['brand', MC.fxBrand]].map(function (x) { return '<button type="button" role="radio" class="rmq-chipbtn" data-fx="' + x[0] + '" aria-checked="' + (P.fx === x[0]) + '">' + esc(x[1]) + '</button>'; }).join('') + '</div>' : '';
    app.innerHTML = '<div class="rm-entry rm-check rmq-check">' +
      '<p class="rm-eyebrow">' + esc(CFG.room.title) + '</p><h1 class="rm-h1">' + esc(MC.checkHeading) + '</h1><p class="rm-lede">' + esc(MC.checkBody) + '</p>' +
      '<div class="rm-preview rmq-preview"><video playsinline autoplay muted data-preview aria-label="' + esc(MC.rowCamera) + '"></video><div class="rmq-placeholder" data-ph hidden></div><div class="rm-meter" aria-hidden="true"><span data-meter></span></div></div>' +
      fxChips + '<p class="rmq-fxnote" data-fxnote role="status" hidden></p>' +
      '<section class="rmq-problem" data-problem role="alert" hidden></section>' +
      '<ul class="rmq-checks" aria-label="' + esc(MC.checkHeading) + '">' +
        row('cam', MC.rowCamera) + row('mic', MC.rowMic) + row('spk', MC.rowSpeaker) + row('net', MC.rowNetwork) + '</ul>' +
      '<div class="rm-fields">' +
        (ME.nameEditable ? '<label class="rm-field"><span>' + esc(C.yourName) + '</span><input data-name maxlength="60" autocomplete="name" value="' + esc(S.name) + '"></label>' : '') +
        '<label class="rm-field"><span>' + esc(C.camera) + '</span><select data-cam></select></label>' +
        '<label class="rm-field"><span>' + esc(C.mic) + '</span><select data-mic></select></label>' +
        (hasSink ? '<label class="rm-field"><span>' + esc(C.speaker) + '</span><select data-spk></select></label>' : '') +
        '<label class="rm-field"><span>' + esc(MC.noise) + '</span><select data-noise>' + noiseOptions() + '</select></label>' +
      '</div>' +
      '<div class="rm-actions"><button type="button" class="rm-primary" data-join>' + esc(o.button || C.join) + '</button><button type="button" class="rm-link" data-join-none>' + esc(C.joinNoCamera) + '</button></div>' +
      (CFG.ready ? '' : '<p class="rm-warn">' + esc(C.notConnected) + '</p>') + '</div>';
    function row(k, label) { return '<li class="rmq-row" data-row="' + k + '"><span class="rmq-dot" aria-hidden="true"></span><span class="rmq-rl">' + esc(label) + '</span><span class="rmq-rs" data-rs="' + k + '">' + esc(MC.checking) + '</span><div class="rmq-rx" data-rx="' + k + '"></div></li>'; }
    var video = $('[data-preview]'), meter = $('[data-meter]'), problemEl = $('[data-problem]'), fxNote = $('[data-fxnote]');
    var cur = { cam: null, mic: null, rawCam: null }, alive = true, raf = 0, frameTimer = 0, heard = false;
    function setRow(k, state, text, extra) {
      var r = $('[data-row="' + k + '"]'); if (!r) return;
      r.setAttribute('data-state', state);
      $('[data-rs="' + k + '"]').textContent = text;
      if (extra != null) $('[data-rx="' + k + '"]').innerHTML = extra;
    }
    function note(t) { fxNote.hidden = !t; fxNote.textContent = t || ''; }
    /** The effect is off again (chosen, or too slow here): the preview shows the plain camera. */
    function previewRaw(msg) {
      var f = M.fx; M.fx = null;
      var o = cur.cam;
      if (o && o !== cur.rawCam) { o.stop = MediaStreamTrack.prototype.stop.bind(o); stopTrack(o); }
      if (f) f.stop();
      cur.cam = cur.rawCam;
      if (cur.rawCam) { video.srcObject = new MediaStream([cur.rawCam]); video.play().catch(function () {}); }
      if (msg) { P.fx = 'off'; savePrefs(); note(msg); $$('[data-fx]').forEach(function (x) { x.setAttribute('aria-checked', String(x.getAttribute('data-fx') === 'off')); }); }
    }
    var slowHere = function () { if (alive) previewRaw(MC.fxSlow); else fxOff(MC.fxSlow); };
    function problem(kind, err) {
      if (!kind) { problemEl.hidden = true; problemEl.innerHTML = ''; return; }
      var pr = MC.problem[kind] || MC.problem.unknown;
      var steps = L.stepsFor(MC.steps, kind, PLAT.os === 'chromeos' || PLAT.os === 'linux' ? 'other' : PLAT.os);
      problemEl.innerHTML = '<h2 class="rmq-ph">' + esc(pr.title) + '</h2><p>' + esc(pr.body) + '</p>' +
        (steps.length ? '<ol class="rmq-steps">' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : '') +
        '<div class="rm-actions"><button type="button" class="rm-btn" data-retry>' + esc(C.tryAgain) + '</button>' +
        (C.cameraCheck ? '<a class="rm-link" href="/camera-test" target="_blank" rel="noopener">' + esc(C.cameraCheck) + '</a>' : '') + '</div>' +
        (err ? '<small class="rm-errcode">' + esc((err.name || 'Error') + (err.message ? ': ' + err.message : '')) + '</small>' : '');
      problemEl.hidden = false;
      $('[data-retry]', problemEl).onclick = function () { problem(null); open(); };
    }
    function stopAll() {
      clearInterval(frameTimer); if (raf) cancelAnimationFrame(raf);
      if (cur.cam) stopTrack(cur.cam); if (cur.rawCam && cur.rawCam !== cur.cam) stopTrack(cur.rawCam); if (cur.mic) stopTrack(cur.mic);
      cur = { cam: null, mic: null, rawCam: null };
    }
    function fill(list) {
      [['cam', 'videoinput'], ['mic', 'audioinput'], ['spk', 'audiooutput']].forEach(function (p) {
        var sel = $('[data-' + p[0] + ']'); if (!sel) return;
        var items = list.filter(function (d) { return d.kind === p[1] && d.deviceId; });
        sel.innerHTML = items.map(function (d, i) { return '<option value="' + esc(d.deviceId) + '">' + esc(d.label || (p[0] === 'cam' ? C.camera : p[0] === 'mic' ? C.mic : C.speaker) + ' ' + (i + 1)) + '</option>'; }).join('');
        var active = p[0] === 'cam' ? deviceIdOf(cur.rawCam) : p[0] === 'mic' ? deviceIdOf(cur.mic) : P.spk;
        var want = L.pickDevice(list, p[1], { preferredId: active || P[p[0]], preferredLabel: P[p[0] + 'Label'] });
        if (want) sel.value = want;
        sel.disabled = !items.length;
      });
    }
    function startMeter() {
      if (raf) cancelAnimationFrame(raf);
      if (!cur.mic) { setRow('mic', 'off', MC.micNone); return; }
      meterFor(cur.mic);
      setRow('mic', 'wait', MC.micQuiet);
      (function tick() {
        if (!alive) return;
        var lv = micLevel();
        meter.style.transform = 'scaleX(' + Math.min(1, lv * 2.2) + ')';
        if (!heard && lv > 0.08) { heard = true; setRow('mic', 'ok', MC.micOk); }
        raf = requestAnimationFrame(tick);
      })();
    }
    /** Watches the preview for a few seconds: flat, black or frozen frames mean a privacy shutter or a stand-in image. */
    function watchFrames() {
      clearInterval(frameTimer);
      var cv = document.createElement('canvas'); cv.width = 64; cv.height = 36;
      var g = cv.getContext('2d', { willReadFrequently: true });
      var samples = [], prev = null, started = Date.now();
      frameTimer = setInterval(function () {
        if (!alive || !cur.rawCam) { clearInterval(frameTimer); return; }
        if (video.readyState < 2 || !video.videoWidth) {
          if (Date.now() - started > 8000) { clearInterval(frameTimer); M.camVerdict = 'noframes:' + video.readyState; setRow('cam', 'bad', MC.problem.still.title); problem('still'); }
          return;
        }
        try { g.drawImage(video, 0, 0, 64, 36); } catch (e) { return; }
        var st = L.frameStats(g.getImageData(0, 0, 64, 36).data, 64, 36, prev);
        prev = st.luma; samples.push({ mean: st.mean, std: st.std, diff: st.diff });
        if (samples.length >= 8) {
          clearInterval(frameTimer);
          var verdict = L.classifyFrames(samples);
          M.frameSamples = samples;
          M.camVerdict = verdict;
          if (verdict === 'ok') { setRow('cam', 'ok', MC.camOk); return; }
          var kind = verdict === 'black' ? 'black' : 'still';
          setRow('cam', 'bad', MC.problem[kind].title); problem(kind);
        }
      }, 500);
    }
    function open() {
      stopAll(); problem(null); heard = false;
      setRow('cam', 'wait', MC.checking); setRow('mic', 'wait', MC.checking);
      var camSel = $('[data-cam]'), micSel = $('[data-mic]');
      var camId = camSel && camSel.value || P.cam, micId = micSel && micSel.value || P.mic;
      var errs = {};
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { problem(window.isSecureContext ? 'notfound' : 'insecure'); setRow('cam', 'off', MC.camNone); setRow('mic', 'off', MC.micNone); return; }
      // One prompt for both where we can (the permission sheet on phones), then each device on its own.
      var both = navigator.mediaDevices.getUserMedia({ video: videoConstraints(camId || null), audio: audioConstraints(micId || null) }).then(function (s) {
        return { cam: s.getVideoTracks()[0] || null, mic: s.getAudioTracks()[0] || null };
      }).catch(function (e) {
        errs.first = e;
        return Promise.all([
          openCam(camId || null).catch(function (x) { errs.cam = x; return null; }),
          openMic(micId || null).catch(function (x) { errs.mic = x; return null; }),
        ]).then(function (r) { return { cam: r[0], mic: r[1] }; });
      });
      both.then(function (r) {
        if (!alive) { stopTrack(r.cam); stopTrack(r.mic); return; }
        if (r.cam && 'contentHint' in r.cam) r.cam.contentHint = 'motion';
        if (r.mic && 'contentHint' in r.mic) r.mic.contentHint = 'speech';
        cur.mic = r.mic; cur.rawCam = r.cam;
        startMeter();
        if (!r.cam) {
          var ce = errs.cam || errs.first, kind = L.classifyError(ce);
          setRow('cam', 'bad', ce ? (MC.problem[kind] || MC.problem.unknown).title : MC.camNone);
          if (ce && !(kind === 'notfound' && r.mic)) problem(kind === 'constraints' ? 'unknown' : kind, ce);
          if (!r.mic && errs.mic && !ce) problem(L.classifyError(errs.mic), errs.mic);
          video.srcObject = null; $('[data-ph]').hidden = false;
          return navigator.mediaDevices.enumerateDevices().then(fill);
        }
        $('[data-ph]').hidden = true;
        return withFx(r.cam, P.fx, note, slowHere).then(function (t) {
          if (!alive) { stopTrack(t); return; }
          cur.cam = t;
          video.srcObject = new MediaStream([t]); video.play().catch(function () {});
          setRow('cam', 'wait', MC.checking);
          watchFrames();
          if (!r.mic && errs.mic) problem(L.classifyError(errs.mic), errs.mic);
          return navigator.mediaDevices.enumerateDevices().then(fill);
        });
      }).catch(function (e) { problem(L.classifyError(e), e); });
    }
    // Speaker: a two-note chime through the chosen output, then "did you hear it?".
    function spkUi() {
      setRow('spk', P.spkOk ? 'ok' : 'wait', P.spkOk ? MC.spkOk : MC.spkAsk, '<button type="button" class="rm-btn rmq-sm" data-chime>' + esc(MC.spkAsk) + '</button>');
      $('[data-chime]').onclick = function () {
        chime($('[data-spk]') && $('[data-spk]').value);
        setRow('spk', 'wait', MC.spkHeard, '<button type="button" class="rm-btn rmq-sm" data-heard="1">' + esc(MC.spkYes) + '</button> <button type="button" class="rm-btn rmq-sm" data-heard="0">' + esc(MC.spkNo) + '</button> <button type="button" class="rm-link rmq-sm" data-chime2>' + esc(MC.spkAsk) + '</button>');
        $('[data-chime2]').onclick = function () { chime($('[data-spk]') && $('[data-spk]').value); };
        $$('[data-heard]').forEach(function (b) {
          b.onclick = function () {
            if (b.getAttribute('data-heard') === '1') { P.spkOk = true; savePrefs(); setRow('spk', 'ok', MC.spkOk, ''); }
            else { setRow('spk', 'bad', MC.spkAsk, '<p class="rmq-help">' + esc(MC.spkHelp) + '</p><button type="button" class="rm-btn rmq-sm" data-chime>' + esc(MC.spkAsk) + '</button>'); $('[data-chime]').onclick = function () { spkUi(); $('[data-chime]').click(); }; }
          };
        });
      };
    }
    spkUi();
    // Network: our Worker (round trip, down, up) and TURN reachability, in the background.
    function net() {
      setRow('net', 'wait', MC.netTesting, '');
      networkTest().then(function (n) {
        if (!alive) return;
        M.net = n;
        var v = L.netVerdict({ rtt: n.rtt, down: n.down, up: n.up, udp: n.udp, tcp: n.tcp, tls: n.tls, turn: n.turn, publisher: true });
        var bits = [];
        if (n.rtt != null) bits.push(n.rtt + ' ' + MC.netRtt);
        if (n.down != null) bits.push(n.down.toFixed(1) + ' ' + MC.netDown);
        if (n.up != null) bits.push(n.up.toFixed(1) + ' ' + MC.netUp);
        setRow('net', v.level === 'good' ? 'ok' : v.level === 'fair' ? 'fair' : 'bad', MC.netLevel[v.level],
          '<p class="rmq-help">' + esc(bits.join(' · ')) + '</p>' + v.keys.filter(function (k) { return k !== 'netGood'; }).map(function (k) { return '<p class="rmq-help">' + esc(MC[k]) + '</p>'; }).join('') +
          '<button type="button" class="rm-link rmq-sm" data-retest>' + esc(MC.netRetest) + '</button>');
        $('[data-retest]').onclick = net;
      }).catch(function () { if (alive) { setRow('net', 'fair', MC.netFailed, '<button type="button" class="rm-link rmq-sm" data-retest>' + esc(MC.netRetest) + '</button>'); $('[data-retest]').onclick = net; } });
    }
    net();
    // Choices
    $$('[data-fx]').forEach(function (b) {
      b.onclick = function () {
        var mode = b.getAttribute('data-fx'); P.fx = mode; savePrefs();
        $$('[data-fx]').forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); });
        if (!cur.rawCam) return;
        if (M.fx) { if (mode === 'off') previewRaw(null); else M.fx.setMode(mode); return; }
        if (mode === 'off') return;
        note(null);
        withFx(cur.rawCam, mode, note, slowHere).then(function (t) { if (!alive) { if (t !== cur.rawCam) stopTrack(t); return; } cur.cam = t; video.srcObject = new MediaStream([t]); video.play().catch(function () {}); });
      };
    });
    var cs = $('[data-cam]'), ms = $('[data-mic]'), ss = $('[data-spk]'), ns = $('[data-noise]');
    if (cs) cs.onchange = function () { P.cam = cs.value; P.camLabel = cs.options[cs.selectedIndex] && cs.options[cs.selectedIndex].text; savePrefs(); open(); };
    if (ms) ms.onchange = function () { P.mic = ms.value; P.micLabel = ms.options[ms.selectedIndex] && ms.options[ms.selectedIndex].text; savePrefs(); open(); };
    if (ss) ss.onchange = function () { P.spk = ss.value; P.spkOk = false; savePrefs(); spkUi(); };
    if (ns) ns.onchange = function () { P.noise = ns.value; savePrefs(); if (cur.mic) try { cur.mic.applyConstraints({ noiseSuppression: P.noise !== 'off', autoGainControl: P.noise !== 'off', echoCancellation: true }).catch(function () {}); } catch (e) { /* older browser */ } };
    function go(withCam) {
      alive = false;
      R.unlockAudio();
      clearInterval(frameTimer); if (raf) cancelAnimationFrame(raf);
      var nm = $('[data-name]'); if (nm && nm.value.trim()) S.name = nm.value.trim().slice(0, 60);
      if (cur.rawCam) { P.cam = deviceIdOf(cur.rawCam) || P.cam; P.camLabel = cur.rawCam.label || P.camLabel; }
      if (cur.mic) { P.mic = deviceIdOf(cur.mic) || P.mic; P.micLabel = cur.mic.label || P.micLabel; }
      if (ss && ss.value) P.spk = ss.value;
      savePrefs();
      S.devices.cam = P.cam || null; S.devices.mic = P.mic || null; S.devices.speaker = P.spk || null;
      if (!withCam) { if (cur.cam) stopTrack(cur.cam); if (cur.rawCam && cur.rawCam !== cur.cam) stopTrack(cur.rawCam); cur.cam = null; cur.rawCam = null; M.fx = null; }
      S.local.mic = cur.mic; S.local.cam = cur.cam;
      M.rawMic = cur.mic; M.rawCam = cur.rawCam;
      watchEnded('mic', M.rawMic); watchEnded('cam', M.rawCam);
      S.micOn = Boolean(S.local.mic); S.camOn = Boolean(S.local.cam);
      if (P.ptt && R.isStaff && S.local.mic) { S.micOn = false; S.local.mic.enabled = false; }
      if (S.local.mic && P.noise === 'strong' && MCFG.rnnoise) {
        // Strong noise reduction starts in the room (the AudioContext needs this click); Standard is on until then.
        var raw = S.local.mic;
        withRnnoise(raw).then(function (out) { return replaceLocal('mic', out, true); }).catch(function () { P.noise = 'std'; savePrefs(); toast(MC.noiseFailed); });
      }
      done();
    }
    $('[data-join]').onclick = function () { go(true); };
    $('[data-join-none]').onclick = function () { go(false); };
    open();
    return true;
  }
  function noiseOptions() {
    var o = [['std', MC.noiseStd]];
    if (MCFG.rnnoise && window.AudioWorkletNode) o.push(['strong', MC.noiseStrong]);
    o.push(['off', MC.noiseOff]);
    return o.map(function (x) { return '<option value="' + x[0] + '"' + (P.noise === x[0] ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join('');
  }
  function chime(sink) {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)(), dest = ctx.createMediaStreamDestination(), g = ctx.createGain();
      g.connect(dest); g.gain.setValueAtTime(0.0001, ctx.currentTime);
      [[660, 0], [880, 0.22]].forEach(function (n) {
        var osc = ctx.createOscillator(); osc.frequency.value = n[0]; osc.connect(g);
        osc.start(ctx.currentTime + n[1]); osc.stop(ctx.currentTime + n[1] + 0.35);
      });
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      var a = new Audio(); a.srcObject = dest.stream;
      if (sink && a.setSinkId) a.setSinkId(sink).catch(function () {});
      a.play().catch(function () {});
      setTimeout(function () { ctx.close().catch(function () {}); }, 900);
    } catch (e) { /* no audio */ }
  }

  // ───────────── the network test ─────────────
  function netUrl(kind, q) { return R.CFG.api + '/net/' + kind + '?t=' + encodeURIComponent(R.CFG.ticket) + (q || ''); }
  function timed(p) { var t0 = performance.now(); return p.then(function (x) { return { ms: performance.now() - t0, x: x }; }); }
  function networkTest() {
    var out = { rtt: null, down: null, up: null, udp: null, tcp: null, tls: null, turn: false };
    var pings = [];
    var ping = function () { return timed(fetch(netUrl('ping', '&r=' + Math.random()), { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('ping'); return r.json(); })); };
    var seq = ping();
    for (var i = 0; i < 4; i++) seq = seq.then(function (r) { pings.push(r.ms); return ping(); });
    var worker = seq.then(function (r) {
      pings.push(r.ms); pings.shift(); // the first one warms the connection up
      pings.sort(function (a, b) { return a - b; });
      out.rtt = Math.round(pings[Math.floor(pings.length / 2)]);
      return down(256 * 1024);
    }).then(function (r) {
      out.down = r.mbps;
      return r.ms < 600 ? down(Math.min(3 * 1024 * 1024, Math.round(256 * 1024 * 2000 / Math.max(50, r.ms)))) : r;
    }).then(function (r) { out.down = Math.max(out.down, r.mbps); return up(256 * 1024); })
      .then(function (r) { out.up = r.mbps; return r.ms < 600 ? up(Math.min(2 * 1024 * 1024, Math.round(256 * 1024 * 1500 / Math.max(50, r.ms)))) : r; })
      .then(function (r) { out.up = Math.max(out.up, r.mbps); });
    function down(n) {
      return timed(fetch(netUrl('down', '&n=' + n + '&r=' + Math.random()), { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('down'); return r.arrayBuffer(); }))
        .then(function (r) { return { ms: r.ms, mbps: Math.round(r.x.byteLength * 8 / (r.ms / 1000) / 1e5) / 10 }; });
    }
    function up(n) {
      var body = new Uint8Array(n);
      for (var o = 0; o < n; o += 65536) crypto.getRandomValues(body.subarray(o, Math.min(n, o + 65536)));
      return timed(fetch(netUrl('up'), { method: 'POST', body: body, cache: 'no-store', credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('up'); return r.json(); }))
        .then(function (r) { return { ms: r.ms, mbps: Math.round(n * 8 / (r.ms / 1000) / 1e5) / 10 }; });
    }
    var turn = R.post('/ice').then(function (r) {
      var servers = (r && r.ok && r.iceServers) || [];
      var cred = servers.filter(function (s) { return s.username; })[0];
      if (!cred) return stunCheck(servers).then(function (ok) { out.udp = ok ? true : null; });
      out.turn = true;
      var urls = [].concat(cred.urls);
      var pick = function (f) { return urls.filter(f)[0]; };
      var udpU = pick(function (u) { return /^turn:/.test(u) && !/transport=tcp/.test(u); });
      var tcpU = pick(function (u) { return /^turn:/.test(u) && /transport=tcp/.test(u); });
      var tlsU = pick(function (u) { return /^turns:/.test(u) && /:443/.test(u); }) || pick(function (u) { return /^turns:/.test(u); });
      var t = function (u) { return u ? relayCheck({ urls: [u], username: cred.username, credential: cred.credential }) : Promise.resolve(null); };
      return Promise.all([t(udpU), t(tcpU), t(tlsU)]).then(function (x) { out.udp = x[0]; out.tcp = x[1]; out.tls = x[2]; });
    }).catch(function () { /* TURN check skipped */ });
    return Promise.all([worker.catch(function () {}), turn]).then(function () { if (out.rtt == null && out.udp == null && out.tls == null) throw new Error('net'); return out; });
  }
  /** Can this network reach TURN this way? A relay candidate means an allocation succeeded. */
  function relayCheck(server) {
    return new Promise(function (res) {
      var pc, done = false;
      var end = function (ok) { if (done) return; done = true; clearTimeout(timer); try { pc.close(); } catch (e) { /* closed */ } res(ok); };
      var timer = setTimeout(function () { end(false); }, 6000);
      try {
        pc = new RTCPeerConnection({ iceServers: [server], iceTransportPolicy: 'relay' });
        pc.createDataChannel('probe');
        pc.onicecandidate = function (e) { if (e.candidate && / typ relay /.test(e.candidate.candidate)) end(true); else if (!e.candidate) end(false); };
        pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () { end(false); });
      } catch (e) { end(false); }
    });
  }
  function stunCheck(servers) {
    return new Promise(function (res) {
      var pc, done = false;
      var end = function (ok) { if (done) return; done = true; clearTimeout(timer); try { pc.close(); } catch (e) { /* closed */ } res(ok); };
      var timer = setTimeout(function () { end(false); }, 4000);
      try {
        pc = new RTCPeerConnection({ iceServers: servers.length ? servers : [{ urls: ['stun:stun.cloudflare.com:3478'] }] });
        pc.createDataChannel('probe');
        pc.onicecandidate = function (e) { if (e.candidate && / typ srflx /.test(e.candidate.candidate)) end(true); else if (!e.candidate) end(false); };
        pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () { end(false); });
      } catch (e) { end(false); }
    }); // a STUN answer says UDP works; without TURN it says nothing about TCP or TLS
  }

  // ───────────── in the call: reconnects ─────────────
  var bannerTimer = 0;
  function renderBanner() {
    var b = $('[data-banner]'); if (!b || !R) return;
    var ws = S.ws ? (S.ws.readyState === 1 ? 'open' : S.ws.readyState === 0 ? 'connecting' : 'closed') : 'closed';
    var expects = Boolean(S.pc) || Object.keys(S.pubs || {}).length > 0;
    var ph = L.connectionPhase({ online: navigator.onLine, ws: S.joined ? ws : 'open', pc: S.pc ? S.pc.connectionState : null, media: expects, retryIn: M.retryAt ? M.retryAt - Date.now() : null, gaveUp: M.gaveUp });
    if (S.ended || S.removed) ph = { key: null };
    if (!ph.key) { if (b.getAttribute('data-rmq')) { b.hidden = true; b.removeAttribute('data-rmq'); b.innerHTML = ''; } return; }
    var text = ph.key === 'retrying' ? tpl(MC.retrying, ph.secs) : MC[ph.key];
    var btn = ph.key === 'gaveUp' ? '<button type="button" class="rm-btn rmq-sm" data-rmq-reload>' + esc(MC.reload) + '</button>' : (ph.key === 'retrying' || ph.key === 'offline') ? '<button type="button" class="rm-btn rmq-sm" data-rmq-now>' + esc(MC.tryNow) + '</button>' : '';
    var html = '<span class="rmq-spin" aria-hidden="true"></span><span>' + esc(text) + '</span>' + btn;
    if (b.getAttribute('data-rmq') !== html || !b.querySelector('.rmq-spin')) {
      b.innerHTML = html; b.setAttribute('data-rmq', html); b.hidden = false; b.setAttribute('role', 'status');
      var n = $('[data-rmq-now]', b); if (n) n.onclick = function () { M.retryAt = 0; R.reconnectNow(); if (S.pc && S.pc.connectionState !== 'connected') mediaRebuild('manual'); };
      var r = $('[data-rmq-reload]', b); if (r) r.onclick = function () { location.reload(); };
    }
  }
  function startBannerLoop() { if (!bannerTimer) bannerTimer = setInterval(renderBanner, 1000); }
  /** Rebuilds the media connection (new SFU session, republish, re-pull), bounded: 6 in two minutes, then the banner offers a reload. */
  function mediaRebuild(why) {
    if (!R || S.ended || S.removed || !S.joined) return;
    var now = Date.now();
    M.rebuilds = M.rebuilds.filter(function (t) { return now - t < 120000; });
    if (M.rebuilds.length >= 6 && why !== 'manual') { M.gaveUp = true; renderBanner(); return; }
    M.rebuilds.push(now); M.rc++; M.gaveUp = false;
    R.rebuildMedia();
    sendReport(true);
  }
  function watchPc(pc) {
    var t = 0;
    pc.addEventListener('connectionstatechange', function () {
      renderBanner();
      if (S.pc !== pc) return;
      var st = pc.connectionState;
      if (st === 'connected') { clearTimeout(t); if (M.wasDown) { M.wasDown = false; toast(MC.reconnected); } return; }
      if (st === 'disconnected') {
        M.wasDown = true;
        clearTimeout(t);
        // A network change (Wi-Fi to 4G, a new IP) won't come back on the old ICE path: replace the session fast,
        // inside the SFU's 30-second reuse window. A short blip on the same network recovers on its own.
        var fast = Date.now() - M.netChangedAt < 15000;
        t = setTimeout(function () { if (S.pc === pc && pc.connectionState !== 'connected' && navigator.onLine) mediaRebuild('disconnected'); }, fast ? 1500 : 4000);
      }
      if (st === 'failed') M.wasDown = true; // room.js replaces failed connections itself
    });
  }
  function netChanged() {
    M.netChangedAt = Date.now();
    if (!R || !S.joined) return;
    // Is the room's socket still alive on this network? A ping answered within 3 s says yes.
    if (S.ws && S.ws.readyState === 1) {
      var at = Date.now(); M.pingAt = at; R.send({ t: 'ping' });
      setTimeout(function () { if (M.pingAt === at && S.ws && S.ws.readyState === 1) { try { S.ws.close(4001, 'network changed'); } catch (e) { /* closed */ } } }, 3000);
    } else R.reconnectNow();
    setTimeout(function () { if (S.pc && S.pc.connectionState !== 'connected' && S.pc.connectionState !== 'new' && S.pc.connectionState !== 'connecting') mediaRebuild('network'); }, 2500);
  }
  window.addEventListener('online', function () { renderBanner(); netChanged(); });
  window.addEventListener('offline', function () { renderBanner(); });
  if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', netChanged);

  // ───────────── tabs in the background, phones going to sleep ─────────────
  function wakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || M.wake || !S || !S.joined || S.ended) return;
    navigator.wakeLock.request('screen').then(function (w) { M.wake = w; w.addEventListener('release', function () { M.wake = null; }); }).catch(function () {});
  }
  document.addEventListener('visibilitychange', function () {
    if (!R || !S.joined || S.ended) return;
    if (document.visibilityState === 'visible') {
      wakeLock();
      R.reconnectNow();
      // iOS stops the camera and mic in the background: bring them back.
      if (S.local.cam && M.rawCam && M.rawCam.readyState === 'ended') switchDevice('cam', P.cam || null, false);
      if (S.local.mic && M.rawMic && M.rawMic.readyState === 'ended') switchDevice('mic', P.mic || null, false);
      if (S.pc && (S.pc.connectionState === 'failed' || S.pc.connectionState === 'disconnected')) mediaRebuild('visible');
      Object.keys(S.audioEls).forEach(function (k) { S.audioEls[k].play().catch(function () {}); });
    }
    R.syncPulls(); // background tabs take the lowest layer
  });

  // ───────────── stats: speaker, quality, tiers, reports ─────────────
  var tick = 0;
  setInterval(function () {
    if (!R || !S.joined || S.ended) return;
    tick++;
    var pc = S.pc;
    if (!pc || pc.connectionState !== 'connected') { if (tick % 20 === 3) noPcQuality(); return; }
    pc.getStats().then(function (rep) {
      var list = [], byTrack = {};
      rep.forEach(function (s) { list.push(s); });
      Object.keys(S.pulls).forEach(function (k) { var p = S.pulls[k]; if (p.track && p.kind === 'audio') byTrack[p.track.id] = p.owner; });
      var levels = {};
      list.forEach(function (s) { if (s.type === 'inbound-rtp' && s.kind === 'audio' && typeof s.audioLevel === 'number' && byTrack[s.trackIdentifier]) levels[byTrack[s.trackIdentifier]] = s.audioLevel; });
      var who = M.speaker.feed(levels, Date.now());
      if (who && who !== S.speaking) { S.speaking = who; S.speakAt = Date.now(); R.renderStage(); R.syncPulls(); }
      if (tick % 2) return;
      var sm = L.summarizeStats(list, M.prev, Date.now());
      M.prev = sm;
      var publishing = Boolean(S.pubs && (S.pubs.video || S.pubs.audio));
      var q = L.scoreQuality({ rtt: sm.rtt, loss: sm.loss, jitter: sm.jitter, availOut: sm.availOut, availIn: sm.availIn, publishing: publishing });
      M.sample = sm; M.q = q;
      // Tiers follow what this person receives: a weak upload lowers what others get from them, not what they get.
      // availableIncomingBitrate only grows while video flows, so it can't drive tiers (it would spiral down to
      // audio only and stay there): tiers follow real loss, delay and jitter.
      var qDown = L.scoreQuality({ rtt: sm.rtt, loss: sm.loss, jitter: sm.jitter });
      var g = M.gov.feed(qDown.level, Date.now());
      if (g.changed) { M.tier = g.tier; R.syncPulls(); }
      if (g.notice) toast(MC[g.notice]);
      if (publishing && S.pubs.video && sm.availOut != null && sm.availOut < 300 && Date.now() - M.upWarnAt > 120000) { M.upWarnAt = Date.now(); toast(MC.uploadWeak); }
      renderChip(); sendReport(false);
    }).catch(function () {});
  }, 1000);
  /** MoQ viewers and people waiting for media: the room socket's own round trip is the measurement we have. */
  function noPcQuality() {
    if (!S.ws || S.ws.readyState !== 1) return;
    M.pingAt = Date.now(); R.send({ t: 'ping' });
  }
  function onPong() {
    if (!M.pingAt) return;
    M.wsRtt = Date.now() - M.pingAt; M.pingAt = 0;
    if (!S.pc || S.pc.connectionState !== 'connected') {
      M.q = L.scoreQuality({ rtt: M.wsRtt }); M.sample = { rtt: M.wsRtt, loss: null, jitter: null, inKbps: null, outKbps: null, relay: false, proto: null };
      renderChip(); sendReport(false);
    }
  }
  function path() { var v = S.view; if (v && v.me && v.me.media === 'moq' && !(v.me.canPublish)) return 'moq'; return S.pc ? 'sfu' : 'none'; }
  function sendReport(force) {
    if (!M.q || !S.ws || S.ws.readyState !== 1) return;
    var sm = M.sample || {};
    var key = M.q.level + M.tier + M.rc + path();
    var staffOrStage = R.isStaff || (S.view && S.view.me && S.view.me.canPublish);
    var every = staffOrStage ? 15000 : 30000;
    var now = Date.now();
    if (!force && key === M.lastSentKey && now - M.lastSent < every) return;
    if (!force && key !== M.lastSentKey && now - M.lastSent < 3000) return;
    M.lastSent = now; M.lastSentKey = key;
    R.send({ t: 'mq', q: {
      level: M.q.level, score: M.q.score, why: M.q.why, rtt: sm.rtt, loss: sm.loss, jitter: sm.jitter, inKbps: sm.inKbps, outKbps: sm.outKbps,
      tier: M.tier, rc: M.rc, path: path(), relay: Boolean(sm.relay), proto: sm.proto || null,
      os: PLAT.os, browser: PLAT.browser, mobile: PLAT.mobile, fx: S.local.cam ? (M.fx ? P.fx : 'off') : null, noise: S.local.mic ? (M.ns ? 'strong' : P.noise) : null, pub: Boolean(S.pubs && S.pubs.audio),
    } });
  }

  // ───────────── the quality indicator, Call settings, staff badges ─────────────
  function bars(level) {
    var n = { good: 3, fair: 2, poor: 1, bad: 1 }[level] || 0;
    return '<svg viewBox="0 0 18 14" class="rmq-bars rmq-' + (level || 'none') + '" aria-hidden="true">' + [0, 1, 2].map(function (i) { return '<rect x="' + (i * 6 + 1) + '" y="' + (10 - i * 4) + '" width="4" height="' + (4 + i * 4) + '" rx="1" class="' + (i < n ? 'on' : '') + '"></rect>'; }).join('') + '</svg>';
  }
  function renderChip() {
    var c = $('[data-rmq-chip]'); if (!c) return;
    var lv = M.q ? M.q.level : null;
    var label = lv ? MC.quality[lv] + (M.q.why && lv !== 'good' ? ': ' + MC.why[M.q.why] : '') : MC.checking;
    var html = bars(lv) + '<span class="rmq-sr">' + esc(label) + '</span>';
    if (c.getAttribute('data-h') !== html) { c.innerHTML = html; c.setAttribute('data-h', html); c.setAttribute('aria-label', MC.settings + ': ' + label); c.title = label; }
    var sh = $('[data-rmq-sheet] [data-rmq-conn]'); if (sh) sh.innerHTML = connHtml();
  }
  function connHtml() {
    var sm = M.sample || {}, q = M.q;
    var cell = function (k, v) { return '<div><dt>' + esc(k) + '</dt><dd>' + esc(v == null ? '–' : v) + '</dd></div>'; };
    return '<p class="rmq-conn-h">' + bars(q && q.level) + ' <strong>' + esc(q ? MC.quality[q.level] : MC.checking) + '</strong>' + (q && q.why && q.level !== 'good' ? ' · ' + esc(MC.why[q.why]) : '') + '</p>' +
      '<dl class="rmq-dl">' + cell(MC.delay, sm.rtt != null ? sm.rtt + ' ms' : null) + cell(MC.lost, sm.loss != null ? (sm.loss * 100).toFixed(1) + ' %' : null) + cell(MC.jitter, sm.jitter != null ? sm.jitter + ' ms' : null) +
      cell(MC.down, sm.inKbps != null ? sm.inKbps + ' kbps' : null) + cell(MC.up, sm.outKbps != null ? sm.outKbps + ' kbps' : null) +
      cell(MC.reconnects, M.rc) + '</dl>' + (path() === 'none' ? '' : '<p class="rmq-help">' + esc(path() === 'moq' ? MC.pathMoq : MC.pathSfu) + (sm.relay ? ' · ' + esc(MC.relay) + (sm.proto ? ' (' + esc(sm.proto.toUpperCase()) + ')' : '') : '') + '</p>');
  }
  function onShell() {
    var top = $('.rm-top-r'); if (!top || $('[data-rmq-chip]')) return;
    var b = h('button', { type: 'button', class: 'rmq-chip', 'data-rmq-chip': '' });
    b.onclick = openSheet;
    top.insertBefore(b, top.firstChild);
    renderChip(); startBannerLoop(); wakeLock();
    if (R.isStaff && S.ws && S.ws.readyState === 1) R.send({ t: 'mq_all' });
  }
  function openSheet() {
    if ($('[data-rmq-sheet]')) return;
    var pub = S.view && S.view.me && S.view.me.canPublish;
    var hasSink = 'setSinkId' in HTMLMediaElement.prototype;
    var d = h('div', { class: 'rm-sheet rmq-sheet', 'data-rmq-sheet': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': MC.settings });
    d.innerHTML = '<div class="rm-sheet-in"><button type="button" class="rm-x" data-x aria-label="' + esc(MC.close) + '">×</button><h2>' + esc(MC.settings) + '</h2>' +
      '<section><h3 class="rm-h3">' + esc(MC.yourConnection) + '</h3><div data-rmq-conn>' + connHtml() + '</div></section>' +
      (pub ? '<section class="rm-fields">' +
        '<label class="rm-field"><span>' + esc(R.C.camera) + '</span><select data-s="cam"></select></label>' +
        '<label class="rm-field"><span>' + esc(R.C.mic) + '</span><select data-s="mic"></select></label>' +
        (hasSink ? '<label class="rm-field"><span>' + esc(R.C.speaker) + '</span><select data-s="spk"></select></label>' : '') +
        '<label class="rm-field"><span>' + esc(MC.noise) + '</span><select data-s="noise">' + noiseOptions() + '</select></label>' +
        (fxSupported() && S.local.cam ? '<div class="rm-field"><span>' + esc(MC.background) + '</span><div class="rmq-fxbar" role="radiogroup" aria-label="' + esc(MC.background) + '">' + [['off', MC.fxOff], ['blur', MC.fxBlur], ['brand', MC.fxBrand]].map(function (x) { return '<button type="button" role="radio" class="rmq-chipbtn" data-sfx="' + x[0] + '" aria-checked="' + ((M.fx ? P.fx : 'off') === x[0]) + '">' + esc(x[1]) + '</button>'; }).join('') + '</div></div>' : '') +
        (R.isStaff ? '<label class="rmq-toggle"><input type="checkbox" data-s="ptt"' + (P.ptt ? ' checked' : '') + '> ' + esc(MC.ptt) + '</label>' : '') +
        '<p class="rmq-help">' + esc(MC.echoTip) + '</p></section>' : (hasSink ? '<section class="rm-fields"><label class="rm-field"><span>' + esc(R.C.speaker) + '</span><select data-s="spk"></select></label></section>' : '')) +
      '</div>';
    document.body.appendChild(d);
    var close = function () { d.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    $('[data-x]', d).onclick = close; d.onclick = function (e) { if (e.target === d) close(); };
    $('[data-x]', d).focus();
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) navigator.mediaDevices.enumerateDevices().then(function (list) {
      [['cam', 'videoinput', M.rawCam], ['mic', 'audioinput', M.rawMic], ['spk', 'audiooutput', null]].forEach(function (k) {
        var sel = $('[data-s="' + k[0] + '"]', d); if (!sel) return;
        var items = list.filter(function (x) { return x.kind === k[1] && x.deviceId; });
        sel.innerHTML = items.map(function (x, i) { return '<option value="' + esc(x.deviceId) + '">' + esc(x.label || k[0] + ' ' + (i + 1)) + '</option>'; }).join('');
        var active = k[2] ? deviceIdOf(k[2]) : S.devices.speaker;
        if (active) sel.value = active;
        sel.onchange = function () {
          var label = sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].text;
          if (k[0] === 'spk') { P.spk = sel.value; savePrefs(); setSpeaker(sel.value); chime(sel.value); return; }
          P[k[0]] = sel.value; P[k[0] + 'Label'] = label; savePrefs();
          if (S.local[k[0]]) switchDevice(k[0], sel.value, false);
        };
      });
    }).catch(function () {});
    var ns = $('[data-s="noise"]', d); if (ns) ns.onchange = function () { setNoise(ns.value); };
    var pt = $('[data-s="ptt"]', d); if (pt) pt.onchange = function () { P.ptt = pt.checked; savePrefs(); if (P.ptt) { R.setMic(false); toast(MC.pttOn); } };
    $$('[data-sfx]', d).forEach(function (b) { b.onclick = function () { $$('[data-sfx]', d).forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); }); setFx(b.getAttribute('data-sfx')); }; });
  }
  function personBadge(id) {
    if (!R || !R.isStaff) return '';
    var p = M.people[id]; if (!p) return '';
    var info = MC.quality[p.level] + (p.rtt != null ? ' · ' + p.rtt + ' ms' : '') + (p.loss ? ' · ' + (p.loss * 100).toFixed(1) + ' %' : '') + ' · ' + p.browser + ' / ' + p.os + (p.path === 'moq' ? ' · ' + MC.pathMoq : '') + (p.relay ? ' · ' + MC.relay : '') + (p.rc ? ' · ' + MC.reconnects + ' ' + p.rc : '');
    return ' <span class="rmq-pdot rmq-' + esc(p.level) + '" title="' + esc(info) + '" role="img" aria-label="' + esc(info) + '"></span>';
  }
  function decorateTiles() {
    if (!R) return;
    Object.keys(S.tiles).forEach(function (tid) {
      var el = S.tiles[tid], id = tid.split(':')[0];
      el.classList.toggle('rmq-held', Boolean(M.held[id]));
      var tag = $('.rmq-tiletag', el);
      if (M.held[id] && !/:screen$/.test(tid)) { if (!tag) { tag = h('span', { class: 'rmq-tiletag' }); el.appendChild(tag); } tag.textContent = MC.reconnectingTile; } else if (tag) tag.remove();
      var q = id === R.ME.id ? (M.q && M.q.level) : (R.isStaff && M.people[id] ? M.people[id].level : null);
      var dot = $('.rmq-tq', el);
      if (q && q !== 'good' && !/:screen$/.test(tid)) { if (!dot) { dot = h('span', { class: 'rmq-tq' }); el.appendChild(dot); } dot.innerHTML = bars(q); dot.title = MC.quality[q]; } else if (dot) dot.remove();
    });
  }
  var panelTimer = 0;
  function peopleChanged() { decorateTiles(); clearTimeout(panelTimer); panelTimer = setTimeout(function () { if (S.tab === 'people') R.renderPanel(); }, 400); }

  // ───────────── wiring into room.js ─────────────
  var booted = false;
  function boot() {
    if (booted || !window.RoomCore) return;
    booted = true; R = window.RoomCore; S = R.S;
    if (P.spk) S.devices.speaker = P.spk;
    if (P.cam) S.devices.cam = P.cam;
    if (P.mic) S.devices.mic = P.mic;
    R.on('*', function () { M.lastMsgAt = Date.now(); });
    R.on('pong', onPong);
    R.on('pc', watchPc);
    R.on('shell', onShell);
    R.on('stage', decorateTiles);
    R.on('ws_open', function () { M.retryAt = 0; M.wsOpen = true; renderBanner(); if (R.isStaff) R.send({ t: 'mq_all' }); });
    R.on('ws_close', function (e) { M.retryAt = Date.now() + (e.wait || 0); if (M.wsOpen) { M.wsOpen = false; M.rc++; } renderBanner(); });
    R.on('resumed', function (m) {
      clearTimeout(M.resumeTimer); M.resumeTimer = 0;
      if (!S.pc) { if (!S.building) R.buildMedia(); return; }
      var ok = m.held && m.sessionId && m.sessionId === S.sessionId && S.pc.connectionState === 'connected';
      if (ok) R.syncMedia(); else mediaRebuild('resume');
    });
    R.on('mhold', function (m) { M.held = {}; (m.ids || []).forEach(function (id) { M.held[id] = true; }); decorateTiles(); });
    R.on('mq_all', function (m) { M.people = {}; (m.people || []).forEach(function (p) { M.people[p.id] = p; }); peopleChanged(); });
    R.on('mq', function (m) { if (m.p) { M.people[m.p.id] = m.p; peopleChanged(); } });
    R.on('published', function (kinds) {
      kinds.forEach(function (k) {
        var p = S.pubs[k]; if (!p || !p.tr || !p.tr.sender || !p.tr.sender.getParameters) return;
        // A track swapped while this publish was in flight (an effect, strong noise reduction): send the current one.
        var want = k === 'audio' ? S.local.mic : k === 'video' ? S.local.cam : null;
        if (want && p.tr.sender.track !== want) p.tr.sender.replaceTrack(want).catch(function () {});
        try {
          var prm = p.tr.sender.getParameters();
          if (k === 'screen') prm.degradationPreference = 'maintain-resolution';
          else if (k === 'video') prm.degradationPreference = 'balanced';
          else return;
          p.tr.sender.setParameters(prm).catch(function () {});
        } catch (e) { /* not supported */ }
      });
    });
    R.on('local', function (k) {
      if (k === 'mic') { if (!M.ns) M.rawMic = S.local.mic; watchEnded('mic', M.rawMic); meterFor(M.rawMic); }
      if (k === 'cam' && !M.fx) { M.rawCam = S.local.cam; watchEnded('cam', M.rawCam); }
    });
    R.on('leave', function () {
      clearInterval(bannerTimer); bannerTimer = 0;
      if (M.wake) { M.wake.release().catch(function () {}); M.wake = null; }
      if (M.fx) { try { M.fx.stop(); } catch (e) { /* stopped */ } M.fx = null; }
      sendReport(true);
    });
  }
  document.addEventListener('DOMContentLoaded', boot);

  /** The hooks room.js calls (each is optional there). */
  window.RoomMedia = {
    deviceCheck: function (done, o) { boot(); return R ? deviceCheck(done, o) : false; },
    keepMediaOnDrop: function () { boot(); return true; },
    resumeMedia: function () {
      boot();
      // The room answers with 'resumed' right after the state; if it never does, rebuild.
      clearTimeout(M.resumeTimer);
      M.resumeTimer = setTimeout(function () { M.resumeTimer = 0; mediaRebuild('resume'); }, 4000);
      return true;
    },
    ownsStats: function () { return true; },
    sendInit: function (kind, track, init) {
      if (kind === 'audio') { if ('contentHint' in track && !track.contentHint) track.contentHint = 'speech'; init.sendEncodings = [{ priority: 'high', networkPriority: 'high' }]; }
      if (kind === 'screenaudio') { if ('contentHint' in track) track.contentHint = 'music'; init.sendEncodings = [{ priority: 'high', networkPriority: 'high', maxBitrate: 128000 }]; }
      if (kind === 'video') { if ('contentHint' in track && !track.contentHint) track.contentHint = 'motion'; (init.sendEncodings || []).forEach(function (e) { e.priority = 'low'; e.networkPriority = 'low'; }); }
      if (kind === 'screen') { if ('contentHint' in track) track.contentHint = 'detail'; init.sendEncodings = [{ maxBitrate: 2500000, maxFramerate: 15, priority: 'medium', networkPriority: 'medium' }]; }
      return init;
    },
    tuneRemote: function (desc, tracks) {
      if (!desc || !desc.sdp) return desc;
      var dtx = tracks.filter(function (t) { return t.kind === 'audio'; }).map(function (t) { return t.mid; });
      var stereo = tracks.filter(function (t) { return t.kind === 'screenaudio'; }).map(function (t) { return t.mid; });
      return { type: desc.type, sdp: L.tuneOpus(desc.sdp, { dtx: dtx, stereo: stereo }) };
    },
    tuneLocal: function (desc, rtracks, batch) {
      var stereo = (rtracks || []).filter(function (t) { return (batch || []).some(function (b) { return b.trackName === t.trackName && b.kind === 'screenaudio'; }); }).map(function (t) { return t.mid; });
      return { type: desc.type, sdp: L.tuneOpus(desc.sdp, { stereo: stereo }) };
    },
    pickRid: function (m, t, lay) {
      if (!R || (t.kind !== 'video' && t.kind !== 'screen')) return undefined;
      var tile = S.tiles[m.id + (t.kind === 'screen' ? ':screen' : ':cam')];
      var rect = tile ? tile.getBoundingClientRect() : null;
      var focus = lay && lay.focus === m.id + ':cam';
      var tileH = rect && rect.height ? rect.height : (focus ? window.innerHeight * 0.55 : 160);
      var visible = rect ? rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth : true;
      var r = L.pickLayer({ simulcast: t.simulcast, kind: t.kind, tileH: tileH, dpr: window.devicePixelRatio || 1, tier: M.tier, visible: visible, hidden: document.hidden });
      return r === null ? (t.simulcast ? 'h' : null) : r;
    },
    personBadge: personBadge,
    audioConstraints: function () { return audioConstraints(); },
    displayConstraints: function () {
      return { video: { width: { ideal: 1920, max: 2560 }, height: { ideal: 1080, max: 1440 }, frameRate: { ideal: 10, max: 15 } }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, systemAudio: 'include', surfaceSwitching: 'include', selfBrowserSurface: 'exclude' };
    },
    wrapCam: function (raw) { M.rawCam = raw; if ('contentHint' in raw) raw.contentHint = 'motion'; return P.fx && P.fx !== 'off' ? withFx(raw, P.fx, function (t) { if (t && t !== MC.fxLoading) toast(t); }) : raw; },
    // For the screenshots and support: the current state, read-only.
    debug: function () { return { tier: M.tier, q: M.q, sample: M.sample, rc: M.rc, net: M.net, prefs: P, platform: PLAT, people: M.people, held: M.held, fx: Boolean(M.fx), camVerdict: M.camVerdict, frames: M.frameSamples }; },
  };
})();

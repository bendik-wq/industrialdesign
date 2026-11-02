/* Our video room (src/rooms): Cloudflare Realtime SFU for media (one RTCPeerConnection per person: publish local
   tracks, pull remote ones, all through the Worker's SFU proxy, which holds the secret), TURN credentials minted per
   person, and a WebSocket to the room's Durable Object for everything else (stage, chat, Q&A, polls, hands, offer,
   timer). Webinar audience members never get a camera or mic prompt. Every count shown comes from the server.
   Big webinars (src/rooms/moq.ts): the host's browser also publishes the composited stage to Cloudflare's MoQ
   relay, and viewers the room routes to MoQ play that instead of pulling from the SFU (WebCodecs, vendored
   client in /assets/vendor/moq). Any viewer whose browser or network can't play it falls back to the SFU. */
(function () {
  'use strict';
  var cfgEl = document.getElementById('room-config');
  var app = document.querySelector('[data-room]');
  if (!cfgEl || !app) return;
  var CFG = JSON.parse(cfgEl.textContent);
  var C = CFG.copy;
  var ME = CFG.me;
  var MODE = CFG.room.mode;
  var skew = (CFG.serverNow || Date.now()) - Date.now();
  var now = function () { return Date.now() + skew; };
  var isStaff = ME.role === 'host' || ME.role === 'cohost';
  var publisherAtStart = MODE === 'meeting' || isStaff;

  // ───────────── helpers ─────────────
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function h(tag, attrs, html) { var e = document.createElement(tag); if (attrs) Object.keys(attrs).forEach(function (k) { if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }); if (html != null) e.innerHTML = html; return e; }
  function post(path, body) {
    body = body || {}; body.t = CFG.ticket;
    return fetch(CFG.api + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }
  function clock(ms) {
    ms = Math.max(0, ms); var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d > 0 ? d + 'd ' + hh + 'h ' + p(m) + 'm' : hh > 0 ? hh + ':' + p(m) + ':' + p(ss) : m + ':' + p(ss);
  }
  function localWhen(t) { try { return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(t)); } catch (e) { return new Date(t).toString(); } }
  /**
   * The payment page opens in its own tab so the stage keeps playing here. The tab is opened during the click
   * (popup blockers allow that) and pointed at the payment page once the server answers; with no tab (blocked),
   * this page goes there instead. (window.open with "noopener" always returns null, so it can't be tested.)
   */
  function payTab() {
    var w = null;
    try { w = window.open('about:blank', '_blank'); if (w) w.opener = null; } catch (e) { w = null; }
    return {
      go: function (url) { if (w && !w.closed) w.location.href = url; else location.href = url; },
      close: function () { try { if (w && !w.closed) w.close(); } catch (e) { /* gone */ } },
    };
  }
  var toastTimer;
  function toast(text) {
    var t = $('.rm-toast') || document.body.appendChild(h('div', { class: 'rm-toast', role: 'status' }));
    t.textContent = text; t.classList.add('is-on');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('is-on'); }, 3500);
  }
  var I = {
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3"/><path d="M19 11a7 7 0 0 1-1.1 3.8M5 11a7 7 0 0 0 11.2 5.6M12 18v3"/></svg>',
    cam: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/></svg>',
    camOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M16 16H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1M10 6h4a2 2 0 0 1 2 2v3l5-3v10"/></svg>',
    screen: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    hand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.9-2.6L3.3 14.6a1.5 1.5 0 0 1 2.4-1.8L8 15"/></svg>',
    leave: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l-5-5 5-5M5 12h11"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    dot: '<span class="rm-dot" aria-hidden="true"></span>',
  };

  // ───────────── state ─────────────
  var S = {
    view: null, chat: [], ws: null, wsTries: 0, wsClosedByUs: false, joined: false, ended: false, removed: false,
    tab: 'chat', unread: 0, name: ME.name,
    devices: { cam: null, mic: null, speaker: null },
    local: { mic: null, cam: null, screen: null, screenAudio: null },
    micOn: true, camOn: true,
    pc: null, sessionId: null, ice: null, relayOnly: false, connectedOnce: false, building: null,
    pubs: {}, pulls: {}, // pulls: trackName -> { mid, track, owner, kind, rid, sessionId }
    audioEls: {}, tiles: {}, speaking: null, speakAt: 0, levels: {},
    offerShown: false, rec: null,
  };
  var negotiation = Promise.resolve();
  function serial(fn) { var p = negotiation.then(fn, fn); negotiation = p.catch(function () { /* next */ }); return p; }
  // Area A "media" (room-media.js): MH calls an optional hook, emit tells listeners (see window.RoomCore at the end).
  function MH(name) { var M = window.RoomMedia; if (!M || typeof M[name] !== 'function') return undefined; try { return M[name].apply(M, Array.prototype.slice.call(arguments, 1)); } catch (e) { console.warn('media hook', name, e); return undefined; } }
  var LISTEN = {};
  function emit(t, m) { (LISTEN[t] || []).concat(LISTEN['*'] || []).forEach(function (fn) { try { fn(m, t); } catch (e) { console.warn('room listener', t, e); } }); }

  // ───────────── entry: device check or enter ─────────────
  function start() {
    if (!window.RTCPeerConnection || !window.WebSocket) { app.innerHTML = '<div class="rm-gate"><p>' + esc(C.noWebrtc) + '</p></div>'; return; }
    if (publisherAtStart) deviceCheck(function () { connect(); });
    else enterScreen();
  }

  function enterScreen() {
    app.innerHTML = '<div class="rm-entry"><p class="rm-eyebrow">' + esc(CFG.room.mode === 'webinar' ? C.lobbyEyebrow : C.enterHeading) + '</p><h1 class="rm-h1">' + esc(CFG.room.title) + '</h1>' +
      (CFG.room.startsAt ? '<p class="rm-when">' + esc(localWhen(CFG.room.startsAt)) + '</p>' : '') +
      '<p class="rm-lede">' + esc(C.enterBody) + '</p><button type="button" class="rm-primary" data-enter>' + esc(C.enter) + '</button>' +
      (CFG.ready ? '' : '<p class="rm-warn">' + esc(C.notConnected) + '</p>') + '</div>';
    $('[data-enter]').onclick = function () { unlockAudio(); connect(); };
  }

  var previewStream = null;
  function stopPreview() { if (previewStream) previewStream.getTracks().forEach(function (t) { t.stop(); }); previewStream = null; }
  function deviceCheck(done, o) {
    o = o || {};
    if (MH('deviceCheck', done, o) === true) return; // media: the full pre-join check
    app.innerHTML = '<div class="rm-entry rm-check"><p class="rm-eyebrow">' + esc(CFG.room.title) + '</p><h1 class="rm-h1">' + esc(C.checkHeading) + '</h1><p class="rm-lede">' + esc(C.checkBody) + '</p>' +
      '<div class="rm-preview"><video playsinline autoplay muted data-preview></video><div class="rm-meter" aria-hidden="true"><span data-meter></span></div></div>' +
      '<div class="rm-fields">' +
      (ME.nameEditable ? '<label class="rm-field"><span>' + esc(C.yourName) + '</span><input data-name maxlength="60" autocomplete="name" value="' + esc(S.name) + '"></label>' : '') +
      '<label class="rm-field"><span>' + esc(C.camera) + '</span><select data-cam></select></label>' +
      '<label class="rm-field"><span>' + esc(C.mic) + '</span><select data-mic></select></label>' +
      ('setSinkId' in HTMLMediaElement.prototype ? '<label class="rm-field"><span>' + esc(C.speaker) + '</span><select data-spk></select></label>' : '') +
      '<button type="button" class="rm-btn" data-test>' + esc(C.testSpeaker) + '</button></div>' +
      '<p class="rm-err" data-check-err hidden></p>' +
      '<div class="rm-actions"><button type="button" class="rm-primary" data-join>' + esc(o.button || C.join) + '</button><button type="button" class="rm-link" data-join-none>' + esc(C.joinNoCamera) + '</button></div>' +
      (CFG.ready ? '' : '<p class="rm-warn">' + esc(C.notConnected) + '</p>') + '</div>';
    var video = $('[data-preview]'), meter = $('[data-meter]'), err = $('[data-check-err]');
    var meterCtx = null, raf = 0;
    function showErr(t) { err.textContent = t; err.hidden = false; }
    function meterFor(stream) {
      try {
        if (raf) cancelAnimationFrame(raf);
        var tr = stream.getAudioTracks()[0]; if (!tr) return;
        meterCtx = meterCtx || new (window.AudioContext || window.webkitAudioContext)();
        var an = meterCtx.createAnalyser(); an.fftSize = 512; meterCtx.createMediaStreamSource(new MediaStream([tr])).connect(an);
        var buf = new Uint8Array(an.fftSize);
        (function tick() { an.getByteTimeDomainData(buf); var m = 0; for (var i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i] - 128)); meter.style.transform = 'scaleX(' + Math.min(1, m / 60) + ')'; raf = requestAnimationFrame(tick); })();
      } catch (e) { /* no meter */ }
    }
    function fill(list) {
      [['cam', 'videoinput'], ['mic', 'audioinput'], ['spk', 'audiooutput']].forEach(function (p) {
        var sel = $('[data-' + p[0] + ']'); if (!sel) return;
        var items = list.filter(function (d) { return d.kind === p[1]; });
        sel.innerHTML = items.map(function (d, i) { return '<option value="' + esc(d.deviceId) + '">' + esc(d.label || (p[0] + ' ' + (i + 1))) + '</option>'; }).join('');
        var key = p[0] === 'spk' ? 'speaker' : p[0];
        if (S.devices[key]) sel.value = S.devices[key];
      });
    }
    function open() {
      stopPreview();
      var camSel = $('[data-cam]'), micSel = $('[data-mic]');
      var cons = { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
      if (camSel && camSel.value) cons.video.deviceId = { exact: camSel.value };
      if (micSel && micSel.value) cons.audio.deviceId = { exact: micSel.value };
      var busy = false, lastErr = null;
      return navigator.mediaDevices.getUserMedia(cons).catch(function (e) {
        // A camera that was picked before may be gone: try the default camera before giving up on video.
        if (e && e.name === 'OverconstrainedError' && cons.video.deviceId) { delete cons.video.deviceId; delete cons.audio.deviceId; return navigator.mediaDevices.getUserMedia(cons); }
        throw e;
      }).catch(function (e) {
        // Some cameras (Qualcomm on Windows among them) can't start at the HD size or frame rate we ask for:
        // try the camera's own default, then a small size, before calling it busy.
        if (!camBusy(e)) throw e;
        var dev = cons.video.deviceId ? { deviceId: cons.video.deviceId } : {};
        return navigator.mediaDevices.getUserMedia({ video: Object.keys(dev).length ? dev : true, audio: cons.audio })
          .catch(function () { return navigator.mediaDevices.getUserMedia({ video: Object.assign({ width: { ideal: 640 }, height: { ideal: 480 } }, dev), audio: cons.audio }); })
          .catch(function (e2) { lastErr = e2 || e; throw e2 || e; });
      }).catch(function (e) {
        if (e && e.name === 'NotFoundError') return navigator.mediaDevices.getUserMedia({ audio: true }).catch(function () { return null; });
        // Camera held by another app (Zoom, Teams, FaceTime) or failed to start: keep the mic, say why.
        if (e && camBusy(e)) { busy = true; lastErr = e; return navigator.mediaDevices.getUserMedia({ audio: cons.audio }).catch(function () { return null; }); }
        throw e;
      }).then(function (stream) {
        previewStream = stream;
        if (busy) { showErr(C.cameraBusy); addRetry(); errCode(lastErr); if (!stream) return; video.srcObject = stream; meterFor(stream); return navigator.mediaDevices.enumerateDevices().then(fill); }
        if (!stream) { showErr(C.noDevices); return; }
        err.hidden = true;
        video.srcObject = stream; meterFor(stream);
        return navigator.mediaDevices.enumerateDevices().then(fill);
      }).catch(function (e) { showErr(mediaError(e)); addRetry(); errCode(e); });
    }
    function errCode(e) { if (!e) return; var d = h('small', { class: 'rm-errcode' }, esc((e.name || 'Error') + (e.message ? ': ' + e.message : ''))); err.appendChild(document.createElement('br')); err.appendChild(d); }
    function addRetry() { var b = h('button', { type: 'button', class: 'rm-btn' }, esc(C.tryAgain)); b.onclick = open; err.appendChild(document.createTextNode(' ')); err.appendChild(b); if (C.cameraCheck) { var a = h('a', { href: '/camera-test', target: '_blank', rel: 'noopener', class: 'rm-link' }, esc(C.cameraCheck)); err.appendChild(document.createTextNode(' ')); err.appendChild(a); } }
    ['cam', 'mic'].forEach(function (k) { var s = $('[data-' + k + ']'); if (s) s.onchange = open; });
    $('[data-test]').onclick = function () {
      try {
        var ctx = new (window.AudioContext || window.webkitAudioContext)(), osc = ctx.createOscillator(), g = ctx.createGain();
        osc.frequency.value = 660; g.gain.value = 0.08; osc.connect(g);
        var dest = ctx.createMediaStreamDestination(); g.connect(dest);
        var a = new Audio(); a.srcObject = dest.stream; var spk = $('[data-spk]');
        if (spk && spk.value && a.setSinkId) a.setSinkId(spk.value).catch(function () {});
        a.play().catch(function () {}); osc.start(); setTimeout(function () { osc.stop(); ctx.close(); }, 700);
      } catch (e) { /* no test */ }
    };
    function go(withMedia) {
      unlockAudio();
      var nm = $('[data-name]'); if (nm && nm.value.trim()) S.name = nm.value.trim().slice(0, 60);
      ['cam', 'mic'].forEach(function (k) { var s = $('[data-' + k + ']'); if (s && s.value) S.devices[k] = s.value; });
      var spk = $('[data-spk]'); if (spk && spk.value) S.devices.speaker = spk.value;
      if (raf) cancelAnimationFrame(raf);
      if (meterCtx) meterCtx.close().catch(function () {});
      if (withMedia && previewStream) {
        S.local.mic = previewStream.getAudioTracks()[0] || null;
        S.local.cam = previewStream.getVideoTracks()[0] || null;
        previewStream = null;
      } else { stopPreview(); S.local.mic = null; S.local.cam = null; }
      S.micOn = Boolean(S.local.mic); S.camOn = Boolean(S.local.cam);
      done();
    }
    $('[data-join]').onclick = function () { go(true); };
    $('[data-join-none]').onclick = function () { go(false); };
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) open(); else showErr(C.noDevices);
  }

  function camBusy(e) { return ['NotReadableError', 'TrackStartError', 'AbortError'].indexOf(e && e.name) >= 0; }
  // Chrome and Edge say "Permission denied by system" when Windows or macOS privacy settings block the browser.
  function sysBlocked(e) { return Boolean(e && e.name === 'NotAllowedError' && /system/i.test(String(e.message || ''))); }
  function mediaError(e) { return camBusy(e) ? C.cameraBusy : sysBlocked(e) ? C.systemBlocked : C.permissionBlocked; }

  var audioUnlocked = false;
  function unlockAudio() { audioUnlocked = true; Object.keys(S.audioEls).forEach(function (k) { S.audioEls[k].play().catch(function () {}); }); if (MQ.view) MQ.view.muted.set(false); }

  // ───────────── the room's WebSocket ─────────────
  function connect() {
    if (!S.joined) { S.joined = true; shell(); }
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + CFG.api + '/ws?t=' + encodeURIComponent(CFG.ticket) + (ME.nameEditable ? '&name=' + encodeURIComponent(S.name) : '');
    var ws = new WebSocket(url);
    S.ws = ws;
    var first = true;
    ws.onopen = function () { S.wsTries = 0; banner(null); emit('ws_open', ws); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      emitCore(m); // add-on scripts (room-lifecycle.js)
      hook('msg', m); // extensions (window.RoomCore.on)
      if (m.t === 'state') {
        if (m.chat) S.chat = m.chat;
        skew = m.now - Date.now();
        var prev = S.view; S.view = m;
        render(prev);
        if (first) { first = false; syncMoq(); if (!(S.pc && MH('resumeMedia'))) buildMedia(); loadEngage(); }
        else syncMedia();
      } else if (m.t === 'chat') { S.chat.push(m.m); if (S.chat.length > 200) S.chat.shift(); if (S.tab !== 'chat' && m.m.by !== ME.id) S.unread++; renderChat(); renderTabs(); }
      else if (m.t === 'error') { toast((C.errors && C.errors[m.error]) || (EC.errors && EC.errors[m.error]) || m.error); }
      else if (m.t === 'award') {
        toast(tpl(EC.award, m.label, m.points));
        if (m.unlocked && m.unlocked.length) { setTimeout(function () { toast(tpl(EC.unlocked, m.unlocked.join(', '))); }, 1800); loadEngage(); }
      }
      else if (m.t === 'unlocked') { toast(m.text); E.data = E.data || null; E.loading = null; loadEngage(); }
      else if (m.t === 'quiz_result') { E.quizRes[m.qid] = m; var dk = $('[data-cards]'); if (dk) dk.setAttribute('data-key', ''); renderCards(); }
      else if (m.t === 'invited') invited(m.by);
      else if (m.t === 'unstaged') { toast(C.backToAudience); stopLocal(); rebuildMedia(); }
      else if (m.t === 'muted') { setMic(false); toast(C.mutedByHost); }
      else if (m.t === 'removed' || m.t === 'refused') { S.removed = true; endScreen(m.reason === 'ended' ? C.ended : C.removed); }
      else if (m.t === 'ended') { S.ended = true; if (S.rec) stopRecording(); endScreen(C.ended, C.endedBody); }
      else if (m.t === 'notice') { if (!m.staffOnly || isStaff) toast(m.text); }
      coreEmit(m.t, m); // studio (builder B): add-on modules hear every room message after the room handled it
    };
    ws.onclose = function (e) {
      if (S.ws !== ws) return;
      if (S.removed || S.ended || e.code === 4003 || S.wsClosedByUs) return;
      banner(C.reconnecting);
      var wait = Math.min(10000, 800 * Math.pow(1.7, S.wsTries++));
      clearTimeout(S.wsTimer);
      S.wsTimer = setTimeout(function () { S.wsTimer = null; connect(); }, wait);
      emit('ws_close', { code: e.code, wait: wait, attempt: S.wsTries });
      // The room holds our place (and media session) for a short while after a drop: room-media.js keeps the
      // connection and checks on the next state. Without it, rebuild from scratch.
      if (!MH('keepMediaOnDrop')) teardownMedia();
    };
  }
  function send(msg) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg)); }

  // ───────────── media (Cloudflare Realtime SFU through our proxy) ─────────────
  function canPublishNow() { return S.view && S.view.me.canPublish; }
  /** The room routes this viewer to MoQ (and they don't publish): no SFU session unless MoQ fails. */
  function onMoqPath() { return Boolean(CFG.moq && S.view && S.view.me.media === 'moq' && !canPublishNow()); }
  function canSee() { var v = S.view; return v && (MODE === 'meeting' || v.room.status === 'live' || isStaff || v.me.stage); }

  function getIce() {
    if (S.ice && S.ice.at > Date.now() - 3 * 3600 * 1000) return Promise.resolve(S.ice.servers);
    return post('/ice').then(function (r) { var servers = r && r.ok ? r.iceServers : [{ urls: ['stun:stun.cloudflare.com:3478'] }]; S.ice = { at: Date.now(), servers: servers }; return servers; });
  }

  function buildMedia() {
    if (!CFG.ready || S.building || S.ended || S.removed) return S.building;
    if (onMoqPath() && !S.pc) return null; // the stage arrives over MoQ
    S.building = getIce().then(function (iceServers) {
      var pc = new RTCPeerConnection({ iceServers: iceServers, bundlePolicy: 'max-bundle', iceTransportPolicy: S.relayOnly ? 'relay' : 'all' });
      S.pc = pc; S.pubs = {}; S.pulls = {};
      emit('pc', pc);
      pc.ontrack = function () { /* tracks are picked up by mid after each negotiation */ };
      var failTimer = null;
      pc.onconnectionstatechange = function () {
        if (S.pc !== pc) return;
        var st = pc.connectionState;
        if (st === 'connected') { S.connectedOnce = true; banner(null); clearTimeout(failTimer); }
        if (st === 'disconnected') { clearTimeout(failTimer); failTimer = setTimeout(function () { if (S.pc === pc && pc.connectionState !== 'connected') { banner(C.mediaFailed); rebuildMedia(); } }, 6000); }
        if (st === 'failed') {
          if (!S.connectedOnce && !S.relayOnly) { S.relayOnly = true; rebuildMedia(); return; } // try TURN over TLS 443 only
          if (!S.connectedOnce) { banner(C.blocked); return; }
          banner(C.mediaFailed); rebuildMedia();
        }
      };
      return post('/sfu/session').then(function (r) {
        if (!r.ok) throw new Error(r.error || 'session');
        S.sessionId = r.sessionId;
        // A negotiation needs at least one m-line before we can pull, so publish first (or pull straight away).
        return publishAll();
      }).then(function () { return syncPulls(); }).then(function () {
        setTimeout(function () { if (S.pc === pc && !S.connectedOnce && pc.connectionState !== 'connected' && (Object.keys(S.pubs).length || Object.keys(S.pulls).length)) { if (!S.relayOnly) { S.relayOnly = true; rebuildMedia(); } else banner(C.blocked); } }, 15000);
      });
    }).catch(function (e) { console.warn('media', e); toast(e && e.message ? e.message : C.mediaFailed); }).then(function () { S.building = null; });
    return S.building;
  }
  function teardownMedia() {
    if (S.pc) { try { S.pc.close(); } catch (e) { /* closed */ } }
    S.pc = null; S.sessionId = null; S.pubs = {}; S.pulls = {}; S.negotiated = false;
    Object.keys(S.audioEls).forEach(function (k) { S.audioEls[k].srcObject = null; S.audioEls[k].remove(); });
    S.audioEls = {};
  }
  function rebuildMedia() { teardownMedia(); negotiation = Promise.resolve(); setTimeout(buildMedia, 300); }

  var prefix = ME.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) + '-';
  /** The SFU accepts a session's first negotiation at once; every later one needs the connection up. */
  function ready(pc) {
    if (!S.negotiated || pc.connectionState === 'connected') return Promise.resolve();
    return new Promise(function (res, rej) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; rej(new Error(S.relayOnly ? C.blocked : C.mediaFailed)); } }, 20000);
      var check = function () { if (!done && pc.connectionState === 'connected') { done = true; clearTimeout(t); res(); } else if (!done && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) { done = true; clearTimeout(t); rej(new Error(C.mediaFailed)); } };
      pc.addEventListener('connectionstatechange', check);
      check();
    });
  }
  function publishAll() {
    if (!canPublishNow()) return Promise.resolve();
    var list = [];
    if (S.local.mic && !S.pubs.audio) list.push(['audio', S.local.mic]);
    if (S.local.cam && !S.pubs.video) list.push(['video', S.local.cam]);
    if (S.local.screen && !S.pubs.screen) list.push(['screen', S.local.screen]);
    if (S.local.screenAudio && !S.pubs.screenaudio) list.push(['screenaudio', S.local.screenAudio]);
    if (!list.length) return Promise.resolve();
    return publishMany(list).then(function () {
      var a = !S.micOn || !S.local.mic, v = !S.camOn || !S.local.cam;
      if (!S.view || S.view.me.audioOff !== a || S.view.me.videoOff !== v) send({ t: 'media', audioOff: a, videoOff: v });
    });
  }
  function publish(kind, track) { return publishMany([[kind, track]]); }
  /** One negotiation for every local track in the list (one offer, one tracks/new call). */
  function publishMany(list) {
    if (!list.length) return Promise.resolve();
    return serial(function () {
      var pc = S.pc; if (!pc || !S.sessionId) return;
      list = list.filter(function (x) { return !S.pubs[x[0]]; });
      if (!list.length) return;
      return ready(pc).then(function () {
        var trs = list.map(function (x) {
          var kind = x[0], track = x[1], init = { direction: 'sendonly' };
          if (kind === 'video') init.sendEncodings = [{ rid: 'f', maxBitrate: 1500000 }, { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 500000 }, { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150000 }];
          if (kind === 'screen' && track.contentHint !== undefined) track.contentHint = 'detail';
          init = MH('sendInit', kind, track, init) || init;
          return pc.addTransceiver(track, init);
        });
        return pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); }).then(function () {
          return post('/sfu/tracks', { sessionId: S.sessionId, sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp }, tracks: list.map(function (x, i) { return { location: 'local', mid: trs[i].mid, trackName: prefix + x[0], media: x[0], simulcast: x[0] === 'video' }; }) });
        }).then(function (r) {
          if (!r.ok || !r.sessionDescription) { trs.forEach(function (tr) { try { tr.stop(); } catch (e) { /* stopped */ } }); throw new Error(r.error || 'publish'); }
          list.forEach(function (x, i) { S.pubs[x[0]] = { tr: trs[i], mid: trs[i].mid, trackName: prefix + x[0] }; });
          S.negotiated = true;
          var answer = MH('tuneRemote', r.sessionDescription, list.map(function (x, i) { return { kind: x[0], mid: trs[i].mid }; })) || r.sessionDescription;
          return pc.setRemoteDescription(answer).then(function () { emit('published', list.map(function (x) { return x[0]; })); });
        });
      }).catch(function (e) { toast(e.message || C.mediaFailed); });
    });
  }
  function unpublish(kind) {
    return serial(function () {
      var pc = S.pc, p = S.pubs[kind]; if (!pc || !p) return;
      delete S.pubs[kind];
      try { p.tr.sender.replaceTrack(null); p.tr.stop(); } catch (e) { /* stopped */ }
      return ready(pc).then(function () { return pc.createOffer(); }).then(function (offer) { return pc.setLocalDescription(offer); }).then(function () {
        return post('/sfu/close', { sessionId: S.sessionId, tracks: [{ mid: p.mid }], sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp } });
      }).then(function (r) { if (r.sessionDescription) return pc.setRemoteDescription(r.sessionDescription); }).catch(function () { /* the next rebuild cleans up */ });
    });
  }

  /** Which remote tracks this person should receive now, and at which simulcast layer. */
  function wanted() {
    var out = {};
    if (!S.view || !canSee()) return out;
    if (MQ.view && MQ.view.playing && !canPublishNow()) return out; // MoQ carries the stage now
    var lay = layoutFor(S.view);
    S.view.stage.forEach(function (m) {
      if (m.id === ME.id || !m.sessionId) return;
      (m.tracks || []).forEach(function (t) {
        var rid = null;
        if (t.kind === 'video') rid = lay.focus === m.id + ':cam' ? (window.innerWidth > 900 && bw.level === 0 ? 'f' : bw.level >= 2 ? 'q' : 'h') : lay.count > 2 ? 'q' : (bw.level >= 1 ? 'q' : 'h');
        var hr = MH('pickRid', m, t, lay); if (hr !== undefined) rid = hr; // media: by tile size, bandwidth tier and visibility
        if (rid === 'off') return; // audio only for now
        out[t.trackName] = { sessionId: m.sessionId, trackName: t.trackName, kind: t.kind, owner: m.id, rid: t.simulcast ? rid : null };
      });
    });
    return out;
  }
  function syncMedia() {
    syncMoq();
    if (!S.pc || !S.sessionId) { if (!S.building && S.joined && S.view && !S.ended) buildMedia(); return; }
    // Publishing permission can change (accepted an invite, sent back to the audience).
    if (canPublishNow()) publishAll().then(syncPulls); else syncPulls();
  }
  function syncPulls() {
    return serial(function () {
      var pc = S.pc; if (!pc || !S.sessionId) return;
      var want = wanted(), add = [], drop = [], relayer = [], pullFailed = false;
      Object.keys(want).forEach(function (k) {
        if (S.pulls[k] && S.pulls[k].sessionId !== want[k].sessionId) { drop.push(k); add.push(want[k]); return; } // they reconnected with a new media session
        if (!S.pulls[k]) add.push(want[k]); else if (want[k].rid && S.pulls[k].rid !== want[k].rid) relayer.push(want[k]);
      });
      Object.keys(S.pulls).forEach(function (k) { if (!want[k]) drop.push(k); });
      if (!add.length && !drop.length && !relayer.length) { renderStage(); return; }
      var p = ready(pc);
      if (drop.length) {
        var mids = drop.map(function (k) { return S.pulls[k].mid; }).filter(Boolean);
        drop.forEach(function (k) { detach(k); delete S.pulls[k]; });
        if (mids.length) p = p.then(function () { return post('/sfu/close', { sessionId: S.sessionId, tracks: mids.map(function (m) { return { mid: m }; }) }); });
      }
      if (relayer.length) p = p.then(function () {
        return post('/sfu/update', { sessionId: S.sessionId, tracks: relayer.map(function (w) { return { location: 'remote', sessionId: w.sessionId, trackName: w.trackName, mid: S.pulls[w.trackName].mid, simulcast: { preferredRid: w.rid } }; }) })
          .then(function (r) { if (r.ok) relayer.forEach(function (w) { S.pulls[w.trackName].rid = w.rid; }); });
      });
      for (var i = 0; i < add.length; i += 8) (function (batch) {
        p = p.then(function () {
          return post('/sfu/tracks', { sessionId: S.sessionId, tracks: batch.map(function (w) { return { location: 'remote', sessionId: w.sessionId, trackName: w.trackName, simulcast: w.rid ? { preferredRid: w.rid } : undefined }; }) }).then(function (r) {
            if (!r.ok) return;
            S.negotiated = true;
            var neg = Promise.resolve();
            if (r.requiresImmediateRenegotiation && r.sessionDescription) {
              neg = pc.setRemoteDescription(r.sessionDescription).then(function () { return pc.createAnswer(); }).then(function (a) { return pc.setLocalDescription(MH('tuneLocal', a, r.tracks || [], batch) || a); })
                .then(function () { return post('/sfu/renegotiate', { sessionId: S.sessionId, sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp } }); });
            }
            return neg.then(function () {
              (r.tracks || []).forEach(function (t) {
                // The publisher's track isn't live at the SFU yet (they just went live or rebuilt their session):
                // ask again shortly instead of waiting for the next room change, which may never come.
                if (t.errorCode) { pullFailed = true; emit('pull_err', { trackName: t.trackName, code: t.errorCode }); return; }
                var w = batch.filter(function (x) { return x.trackName === t.trackName; })[0]; if (!w) return;
                var tr = pc.getTransceivers().filter(function (x) { return x.mid === t.mid; })[0];
                S.pulls[w.trackName] = { mid: t.mid, track: tr ? tr.receiver.track : null, owner: w.owner, kind: w.kind, rid: w.rid, sessionId: w.sessionId };
              });
            });
          });
        });
      })(add.slice(i, i + 8));
      return p.then(function () { retryPulls(pullFailed); renderStage(); }).catch(function (e) { console.warn('pull', e); retryPulls(true); });
    });
  }
  // Retry pulls that the SFU couldn't find yet: 1, 2, 4, 8 s, then every 10 s while they're still wanted.
  function retryPulls(failed) {
    if (!failed) { S.pullRetryN = 0; return; }
    if (S.pullRetryT) return;
    var n = S.pullRetryN || 0, wait = Math.min(1000 * Math.pow(2, n), 10000);
    S.pullRetryN = n + 1;
    S.pullRetryT = setTimeout(function () { S.pullRetryT = null; if (!S.ended && !S.removed) syncPulls(); }, wait);
  }
  function detach(trackName) {
    var a = S.audioEls[trackName]; if (a) { a.srcObject = null; a.remove(); delete S.audioEls[trackName]; }
  }
  function stopLocal() {
    ['mic', 'cam', 'screen', 'screenAudio'].forEach(function (k) { if (S.local[k]) { S.local[k].stop(); S.local[k] = null; } });
  }

  // ───────────── local controls ─────────────
  function setMic(on) {
    S.micOn = on && Boolean(S.local.mic);
    if (S.local.mic) S.local.mic.enabled = S.micOn;
    send({ t: 'media', audioOff: !S.micOn });
    renderBar();
    emit('mic', S.micOn);
  }
  function toggleMic() {
    if (!S.local.mic) {
      navigator.mediaDevices.getUserMedia({ audio: MH('audioConstraints') || (S.devices.mic ? { deviceId: { exact: S.devices.mic } } : true) }).then(function (s) { S.local.mic = s.getAudioTracks()[0]; S.micOn = true; emit('local', 'mic'); publish('audio', S.local.mic).then(function () { setMic(true); }); }).catch(function () { toast(C.permissionBlocked); });
      return;
    }
    setMic(!S.micOn);
  }
  function toggleCam() {
    if (!S.local.cam) {
      var dv = S.devices.cam ? { deviceId: { exact: S.devices.cam } } : {};
      navigator.mediaDevices.getUserMedia({ video: Object.assign({ width: { ideal: 1280 }, height: { ideal: 720 } }, dv) })
        .catch(function (e) { if (!camBusy(e)) throw e; return navigator.mediaDevices.getUserMedia({ video: Object.keys(dv).length ? dv : true }); })
        .then(function (s) { S.local.cam = s.getVideoTracks()[0]; S.camOn = true; return Promise.resolve(MH('wrapCam', S.local.cam)).then(function (t) { if (t) S.local.cam = t; emit('local', 'cam'); return publish('video', S.local.cam); }); }).then(function () { send({ t: 'media', videoOff: false }); renderBar(); renderStage(); }).catch(function (e) { toast(mediaError(e)); });
      return;
    }
    S.camOn = !S.camOn; S.local.cam.enabled = S.camOn;
    send({ t: 'media', videoOff: !S.camOn }); renderBar(); renderStage();
    emit('cam', S.camOn);
  }
  function toggleShare() {
    if (S.local.screen) { stopShare(); return; }
    if (!navigator.mediaDevices.getDisplayMedia) { toast(C.noWebrtc); return; }
    navigator.mediaDevices.getDisplayMedia(MH('displayConstraints') || { video: { frameRate: { ideal: 15 } }, audio: true }).then(function (s) {
      S.local.screen = s.getVideoTracks()[0]; S.local.screenAudio = s.getAudioTracks()[0] || null;
      S.local.screen.onended = stopShare;
      var p = publish('screen', S.local.screen);
      if (S.local.screenAudio) p = p.then(function () { return publish('screenaudio', S.local.screenAudio); });
      return p;
    }).then(function () { renderBar(); renderStage(); }).catch(function () { /* cancelled */ });
  }
  function stopShare() {
    ['screen', 'screenAudio'].forEach(function (k) { if (S.local[k]) { S.local[k].onended = null; S.local[k].stop(); S.local[k] = null; } });
    unpublish('screen').then(function () { return unpublish('screenaudio'); }).then(function () { renderBar(); renderStage(); });
  }
  function leaveRoom() {
    S.wsClosedByUs = true;
    emit('leave');
    if (S.rec) stopRecording();
    stopMoqPublish(); stopMoqView();
    stopLocal(); teardownMedia();
    if (S.ws) S.ws.close();
    location.href = CFG.back || '/';
  }
  function invited(by) {
    var d = h('div', { class: 'rm-sheet', role: 'dialog', 'aria-modal': 'true' }, '<div class="rm-sheet-in"><h2>' + esc(C.invitedHeading) + '</h2><p>' + esc(C.invitedBody) + '</p><div class="rm-actions"><button class="rm-primary" data-yes>' + esc(C.accept) + '</button><button class="rm-link" data-no>' + esc(C.decline) + '</button></div></div>');
    document.body.appendChild(d);
    $('[data-no]', d).onclick = function () { send({ t: 'decline' }); d.remove(); };
    $('[data-yes]', d).onclick = function () {
      d.remove();
      // A quick check of camera and mic (this is the first time they are asked), then onto the stage.
      deviceCheck(function () { shell(); render(null); send({ t: 'accept' }); }, { button: C.accept });
    };
  }

  // ───────────── layout ─────────────
  function layoutFor(v) {
    var stage = (v.stage || []).filter(function (m) { return !m.green; }); // studio (builder B): the green room stays backstage
    var tiles = [];
    stage.forEach(function (m) {
      var hasScreen = (m.tracks || []).some(function (t) { return t.kind === 'screen'; });
      if (hasScreen) tiles.push({ id: m.id + ':screen', m: m, screen: true });
      tiles.push({ id: m.id + ':cam', m: m, screen: false });
    });
    var mode = v.room.layout;
    var screenTile = tiles.filter(function (t) { return t.screen; })[0];
    if (mode === 'auto') mode = MODE === 'meeting' ? (screenTile ? 'screen' : 'grid') : screenTile ? 'screen' : tiles.length === 2 ? 'side' : tiles.length > 4 ? 'grid' : 'speaker';
    if (mode === 'screen' && !screenTile) mode = 'speaker';
    var focus = null;
    if (mode === 'screen') focus = screenTile.id;
    else if (mode === 'speaker') {
      var pick = v.room.spotlight || (S.speaking && stage.some(function (m) { return m.id === S.speaking; }) ? S.speaking : null) || (stage.filter(function (m) { return m.role === 'host'; })[0] || stage[0] || {}).id;
      focus = pick ? pick + ':cam' : null;
    }
    if (v.room.spotlight && mode !== 'screen') { focus = v.room.spotlight + ':cam'; if (mode === 'grid' || mode === 'side') mode = 'speaker'; }
    return { mode: mode, tiles: tiles, focus: focus, count: tiles.length };
  }

  // ───────────── rendering ─────────────
  function shell() {
    var tabs = [['chat', C.chat], ['qa', C.qa], ['poll', C.poll]];
    if (engOn() && !isStaff) tabs.push(['plan', EC.planTab]);
    if (isStaff) tabs.push(['people', C.people]);
    if (isStaff && engOn()) tabs.push(['push', EC.pushTab]);
    if (isStaff) tabs.push(['host', C.hostTab]);
    XTABS.forEach(function (t) { if (!t.show || t.show()) tabs.splice(t.at != null ? Math.min(t.at, tabs.length) : tabs.length, 0, [t.id, t.label]); });
    app.innerHTML = '<div class="rm-shell">' +
      '<header class="rm-top"><div class="rm-top-l"><span class="rm-live" data-live hidden>' + I.dot + esc(C.live) + '</span><h1 class="rm-title">' + esc(CFG.room.title) + '</h1></div>' +
      '<div class="rm-top-r"><span class="rm-timer" data-timer hidden></span><span class="rm-rec" data-rec hidden>' + I.dot + esc(C.recording) + '</span><span class="rm-count" data-count></span>' +
      (engOn() && !isStaff ? '<button type="button" class="rm-traybtn" data-tray hidden>' + esc(EC.tray) + ' <span data-tray-n>0</span></button>' +
        '<button type="button" class="rm-ring" data-ring hidden><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="rm-ring-bg" cx="18" cy="18" r="15.5"></circle><circle class="rm-ring-fg" data-ring-fg cx="18" cy="18" r="15.5" pathLength="100" stroke-dasharray="0 100"></circle></svg><span class="rm-ring-n" data-ring-n>0</span></button>' : '') +
      '</div></header>' +
      '<div class="rm-banner" data-banner hidden></div>' +
      '<main class="rm-main"><section class="rm-stagewrap"><div class="rm-stage" data-stage></div><div class="rm-agenda" data-agenda hidden></div><div class="rm-pinned" data-pinned hidden></div></section>' +
      '<aside class="rm-side"><nav class="rm-tabs" role="tablist" data-tabs>' + tabs.map(function (t) { return '<button type="button" role="tab" data-tab="' + t[0] + '">' + esc(t[1]) + '<span class="rm-badge" data-badge="' + t[0] + '" hidden></span></button>'; }).join('') + '</nav>' +
      '<div class="rm-panel" data-panel></div></aside></main>' +
      '<div class="rm-cards" data-cards hidden></div>' +
      '<div class="rm-offerbar" data-offerbar hidden></div>' +
      '<footer class="rm-bar" data-bar></footer></div>';
    $$('[data-tab]').forEach(function (b) { b.onclick = function () { S.tab = b.getAttribute('data-tab'); if (S.tab === 'chat') S.unread = 0; renderTabs(); renderPanel(); if (S.tab === 'push') refreshStats(true); }; });
    var rg = $('[data-ring]'); if (rg) rg.onclick = openMomentum;
    var tr = $('[data-tray]'); if (tr) tr.onclick = openTray;
    renderTabs();
    coreEmit('shell'); // studio (builder B): add-on tabs and docks
  }
  function banner(text) { var b = $('[data-banner]'); if (!b) return; b.hidden = !text; b.textContent = text || ''; }

  function render(prev) {
    if (!$('[data-stage]')) return;
    var v = S.view, r = v.room;
    $('[data-live]').hidden = !(r.status === 'live' && MODE === 'webinar');
    $('[data-count]').textContent = watching(r.count);
    $('[data-rec]').hidden = !r.recording;
    renderStage(); renderBar(); renderPanel(); renderTabs(); renderOffer(prev); renderPinned(); renderEngage();
    hook('state', prev);
    if (r.status === 'ended' && !S.ended) { S.ended = true; endScreen(C.ended, C.endedBody); }
    coreEmit('render', prev); // studio (builder B)
  }
  function watching(n) { return n === 1 ? '1 person here' : n + ' people here'; }

  function renderPinned() {
    var el = $('[data-pinned]'); if (!el) return;
    var p = S.view.room.chat.pinned;
    el.hidden = !p;
    if (p) el.innerHTML = '<span class="rm-eyebrow">' + esc(C.pinned) + '</span> <strong>' + esc(p.name) + '</strong> ' + esc(p.text);
  }

  function tileEl(id) {
    var t = S.tiles[id];
    if (t) return t;
    var el = h('div', { class: 'rm-tile', 'data-tile': id });
    var v = h('video', { playsinline: '', autoplay: '', muted: '' }); v.muted = true;
    el.appendChild(v);
    el.appendChild(h('div', { class: 'rm-avatar', 'aria-hidden': 'true' }));
    el.appendChild(h('div', { class: 'rm-label' }));
    S.tiles[id] = el;
    return el;
  }
  function setVideo(el, track) {
    var v = el.querySelector('video');
    var cur = v.srcObject && v.srcObject.getVideoTracks()[0];
    if (track && cur !== track) { v.srcObject = new MediaStream([track]); v.play().catch(function () {}); }
    if (!track && v.srcObject) v.srcObject = null;
  }
  function ensureAudio(trackName, track) {
    if (!track) return;
    var a = S.audioEls[trackName];
    if (!a) {
      a = h('audio', { autoplay: '' }); a.style.display = 'none'; document.body.appendChild(a); S.audioEls[trackName] = a;
      if (S.devices.speaker && a.setSinkId) a.setSinkId(S.devices.speaker).catch(function () {});
    }
    if (!a.srcObject || a.srcObject.getAudioTracks()[0] !== track) { a.srcObject = new MediaStream([track]); a.play().catch(function () { showTapForSound(); }); }
    if (COMP) COMP.addAudio(track);
  }
  function showTapForSound() {
    if ($('[data-tapsound]')) return;
    var b = h('button', { type: 'button', class: 'rm-tapsound', 'data-tapsound': '' }, esc(C.tapForSound));
    b.onclick = function () { unlockAudio(); b.remove(); };
    document.body.appendChild(b);
  }

  function renderStage() {
    var stageEl = $('[data-stage]'); if (!stageEl || !S.view) return;
    var v = S.view, r = v.room;
    // Lobby (webinar audience before Go live) and backstage notice for staff.
    if (MODE === 'webinar' && r.status === 'lobby' && !canSee()) {
      stageEl.className = 'rm-stage rm-stage--lobby';
      if (!stageEl.querySelector('[data-lobby]')) {
        stageEl.innerHTML = '<div class="rm-lobby" data-lobby><p class="rm-eyebrow">' + esc(C.lobbyEyebrow) + '</p><h2 class="rm-lobby-h">' + esc(CFG.room.title) + '</h2>' +
          (r.startsAt ? '<p class="rm-when">' + esc(localWhen(r.startsAt)) + '</p><p class="rm-count-l"><span>' + esc(C.lobbyStartsIn) + '</span> <strong data-lobby-cd></strong></p>' : '') +
          '<p class="rm-lede">' + esc(C.lobbyBody) + '</p></div>';
        S.tiles = {};
      }
      return;
    }
    if (stageEl.querySelector('[data-lobby]')) stageEl.innerHTML = '';
    // MoQ viewers: one canvas with the composited stage (the host's layout). While switching, the SFU tiles stay until it plays.
    if (MQ.view && !canPublishNow() && (MQ.view.playing || !S.pc)) {
      stageEl.className = 'rm-stage rm-stage--moq';
      Object.keys(S.tiles).forEach(function (id) { var el = S.tiles[id], vid = el.querySelector('video'); if (vid) vid.srcObject = null; el.remove(); });
      S.tiles = {};
      $$('.rm-empty', stageEl).forEach(function (e) { e.remove(); });
      if (MQ.view.el.parentNode !== stageEl) stageEl.appendChild(MQ.view.el);
      MQ.view.el.classList.toggle('is-waiting', !MQ.view.playing);
      return;
    }
    var moqEl = stageEl.querySelector('.rm-moq'); if (moqEl) moqEl.remove();
    if (onMoqPath() && !S.pc) { stageEl.className = 'rm-stage'; stageEl.innerHTML = '<p class="rm-empty">' + esc(C.moq.connecting) + '</p>'; S.tiles = {}; return; }
    var lay = layoutFor(v);
    stageEl.className = 'rm-stage rm-stage--' + lay.mode + ' n' + Math.min(lay.count, 12);
    if (!lay.tiles.length) { stageEl.innerHTML = '<p class="rm-empty">' + esc(C.emptyStage) + '</p>'; S.tiles = {}; return; }
    var empty = stageEl.querySelector('.rm-empty'); if (empty) empty.remove();
    var keep = {};
    lay.tiles.forEach(function (t) {
      keep[t.id] = true;
      var el = tileEl(t.id), m = t.m, mine = m.id === ME.id;
      el.classList.toggle('is-focus', lay.focus === t.id);
      el.classList.toggle('is-screen', t.screen);
      el.classList.toggle('is-speaking', !t.screen && S.speaking === m.id);
      var track = null;
      if (mine) track = t.screen ? S.local.screen : (S.camOn ? S.local.cam : null);
      else {
        (m.tracks || []).forEach(function (tr) {
          var p = S.pulls[tr.trackName]; if (!p || !p.track) return;
          if (t.screen && tr.kind === 'screen') track = p.track;
          if (!t.screen && tr.kind === 'video' && !m.videoOff) track = p.track;
          if (!t.screen && tr.kind === 'audio') ensureAudio(tr.trackName, p.track);
          if (t.screen && tr.kind === 'screenaudio') ensureAudio(tr.trackName, p.track);
        });
      }
      setVideo(el, track);
      el.querySelector('video').classList.toggle('is-mirror', mine && !t.screen);
      el.classList.toggle('no-video', !track);
      el.querySelector('.rm-avatar').textContent = (m.name || '?').trim().charAt(0).toUpperCase();
      el.querySelector('.rm-label').innerHTML = (m.audioOff && !t.screen ? '<span class="rm-mute" title="' + esc(C.muted) + '">' + I.micOff + '</span>' : '') + esc(t.screen ? m.name + ' · ' + C.screen : mine ? m.name + ' (' + C.you + ')' : m.name);
      if (el.parentNode !== stageEl) stageEl.appendChild(el);
    });
    // Focus first, so the CSS can make it the big one.
    var f = lay.focus && S.tiles[lay.focus]; if (f && stageEl.firstChild !== f) stageEl.insertBefore(f, stageEl.firstChild);
    Object.keys(S.tiles).forEach(function (id) { if (!keep[id]) { var el = S.tiles[id]; var vid = el.querySelector('video'); if (vid) vid.srcObject = null; el.remove(); delete S.tiles[id]; } });
    emit('stage', lay);
  }

  function btn(attr, label, icon, on, cls) { return '<button type="button" class="rm-cbtn' + (on === false ? ' is-off' : '') + (cls ? ' ' + cls : '') + '" ' + attr + ' aria-pressed="' + (on === true) + '"><span class="rm-ic">' + (icon || '') + '</span><span class="rm-cl">' + esc(label) + '</span></button>'; }
  function renderBar() {
    var bar = $('[data-bar]'); if (!bar || !S.view) return;
    var me = S.view.me, html = '';
    if (me.canPublish) {
      html += btn('data-mic', S.micOn ? C.micOn : C.micOff, S.micOn ? I.mic : I.micOff, S.micOn);
      html += btn('data-cam', S.camOn && S.local.cam ? C.camOn : C.camOff, S.camOn && S.local.cam ? I.cam : I.camOff, Boolean(S.camOn && S.local.cam));
      if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) html += btn('data-share', S.local.screen ? C.stopShare : C.share, I.screen, Boolean(S.local.screen));
      if (MODE === 'webinar' && !isStaff) html += btn('data-unstage-me', C.leaveStage, I.leave, null);
    } else if (MODE === 'webinar' && !isStaff) {
      html += btn('data-hand', me.hand ? C.lowerHand : C.raiseHand, I.hand, Boolean(me.hand));
    }
    if (isStaff && MODE === 'webinar' && S.view.room.status === 'lobby') html += '<button type="button" class="rm-golive" data-golive>' + esc(C.goLive) + '</button>';
    html += btn('data-leave', C.leave, I.leave, null, 'rm-cbtn--leave');
    bar.innerHTML = html;
    var on = function (sel, fn) { var e = $(sel, bar); if (e) e.onclick = fn; };
    on('[data-mic]', toggleMic); on('[data-cam]', toggleCam); on('[data-share]', toggleShare); on('[data-leave]', leaveRoom);
    on('[data-hand]', function () { send({ t: 'hand', up: !S.view.me.hand }); if (!S.view.me.hand) toast(C.handUp); });
    on('[data-unstage-me]', function () { send({ t: 'unstage' }); });
    on('[data-golive]', function () { send({ t: 'golive' }); });
  }

  function renderTabs() {
    $$('[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === S.tab)); });
    var badge = function (k, n) { var e = $('[data-badge="' + k + '"]'); if (e) { e.hidden = !n; e.textContent = n > 99 ? '99+' : String(n); } };
    badge('chat', S.unread);
    if (S.view) {
      badge('qa', S.view.qa.filter(function (q) { return !q.answered; }).length);
      badge('poll', S.view.poll && S.view.poll.open && S.view.poll.mine == null && !isStaff ? 1 : 0);
      badge('people', (S.view.people || []).filter(function (p) { return p.hand; }).length);
    }
  }

  /** Panels redraw on every room update: what someone is typing (and where the cursor is) survives the redraw. */
  function renderPanel() {
    var p = $('[data-panel]'); if (!p || !S.view) return;
    if (S.tab === 'chat') return renderChat(false);
    if (S.tab === 'plan') return renderPlan(false);
    for (var xi = 0; xi < XTABS.length; xi++) if (XTABS[xi].id === S.tab) return XTABS[xi].render(p);
    var key = function (e) { return (e.closest('form') ? (e.closest('form').getAttribute('data-ask') !== null ? 'ask' : e.closest('form').getAttribute('data-pnew') !== null ? 'pnew' : 'f') : 'x') + ':' + (e.name || e.getAttribute('data-h') || ''); };
    var saved = {}, focus = null, caret = null;
    $$('input:not([type="checkbox"]), textarea', p).forEach(function (e) { if (e.value) saved[key(e)] = e.value; });
    var a = document.activeElement;
    if (a && p.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) { focus = key(a); try { caret = [a.selectionStart, a.selectionEnd]; } catch (e) { caret = null; } }
    if (S.tab === 'qa') renderQa();
    else if (S.tab === 'poll') renderPoll();
    else if (S.tab === 'people') renderPeople();
    else if (S.tab === 'push') renderPush();
    else if (S.tab === 'host') renderHost();
    hook('panel', S.tab); // add-ons draw into the built-in panels (engage2: the hot list and the bonus in the Push tab)
    $$('input:not([type="checkbox"]), textarea', p).forEach(function (e) {
      var k = key(e);
      if (saved[k] != null) e.value = saved[k];
      if (focus === k) { e.focus(); if (caret) { try { e.setSelectionRange(caret[0], caret[1]); } catch (x) { /* not text */ } } }
    });
  }

  function renderChat(full) {
    var p = $('[data-panel]'); if (!p || S.tab !== 'chat' || !S.view) return;
    var r = S.view.room;
    if (full || !$('[data-msgs]', p)) {
      p.innerHTML = '<ol class="rm-msgs" data-msgs></ol>' +
        '<p class="rm-note" data-chat-note hidden></p>' +
        '<form class="rm-form" data-chat-form><input name="text" maxlength="400" autocomplete="off" placeholder="' + esc(C.chatPlaceholder) + '" aria-label="' + esc(C.chatPlaceholder) + '"><button type="submit" class="rm-send">' + esc(C.send) + '</button></form>';
      $('[data-chat-form]', p).onsubmit = function (e) { e.preventDefault(); var i = this.text; var t = i.value.trim(); if (!t) return; send(Object.assign({ t: 'chat', text: t }, CORE.chatExtra ? CORE.chatExtra() : {})); i.value = ''; };
    }
    var note = $('[data-chat-note]', p);
    var locked = r.chat.locked && !isStaff;
    note.hidden = !(locked || r.chat.slowSec);
    note.textContent = locked ? C.chatLocked : r.chat.slowSec ? 'Slow mode: one message every ' + r.chat.slowSec + ' seconds.' : '';
    var form = $('[data-chat-form]', p); form.querySelector('input').disabled = locked; form.querySelector('button').disabled = locked;
    var list = $('[data-msgs]', p);
    var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.innerHTML = S.chat.map(function (m) {
      var staff = m.role === 'host' || m.role === 'cohost';
      return '<li class="rm-msg' + (staff ? ' is-team' : '') + (m.by === ME.id ? ' is-mine' : '') + '" data-mid="' + m.id + '"><span class="rm-msg-n">' + esc(m.name) + (staff ? ' <span class="rm-team">' + esc(C.team) + '</span>' : '') + '</span> <span class="rm-msg-t">' + esc(m.text) + '</span>' +
        (isStaff ? ' <button type="button" class="rm-mini" data-pin="' + m.id + '">' + esc(r.chat.pinned && r.chat.pinned.id === m.id ? C.unpin : C.pin) + '</button>' : '') + '</li>';
    }).join('');
    $$('[data-pin]', list).forEach(function (b) { b.onclick = function () { var id = Number(b.getAttribute('data-pin')); send({ t: 'pin', mid: r.chat.pinned && r.chat.pinned.id === id ? null : id }); }; });
    hook('chat', list);
    if (atBottom || full) list.scrollTop = list.scrollHeight;
  }

  function renderQa() {
    var p = $('[data-panel]'), v = S.view;
    p.innerHTML = '<form class="rm-form" data-ask><input name="text" maxlength="300" autocomplete="off" placeholder="' + esc(C.askPlaceholder) + '" aria-label="' + esc(C.askPlaceholder) + '"><button type="submit" class="rm-send">' + esc(C.ask) + '</button></form>' +
      (v.qa.length ? '<ol class="rm-qa">' + v.qa.map(function (q) {
        return '<li class="rm-q' + (q.answered ? ' is-answered' : '') + '"><button type="button" class="rm-vote" data-up="' + q.id + '" aria-pressed="' + q.voted + '"' + (q.mine ? ' disabled' : '') + ' aria-label="' + esc(C.upvote) + '">' + I.up + '<span>' + q.votes + '</span></button>' +
          '<div class="rm-q-b"><p>' + esc(q.text) + '</p><p class="rm-q-m">' + esc(q.name) + (q.answered ? ' · ' + esc(C.answered) : '') + '</p>' +
          (isStaff ? '<button type="button" class="rm-mini" data-ans="' + q.id + '" data-on="' + (!q.answered) + '">' + esc(q.answered ? C.reopen : C.markAnswered) + '</button>' : '') + '</div></li>';
      }).join('') + '</ol>' : '<p class="rm-note">' + esc(C.noQuestions) + '</p>');
    $('[data-ask]', p).onsubmit = function (e) { e.preventDefault(); var t = this.text.value.trim(); if (t) send({ t: 'ask', text: t }); this.text.value = ''; };
    $$('[data-up]', p).forEach(function (b) { b.onclick = function () { send({ t: 'upvote', qid: Number(b.getAttribute('data-up')) }); }; });
    $$('[data-ans]', p).forEach(function (b) { b.onclick = function () { send({ t: 'answer', qid: Number(b.getAttribute('data-ans')), on: b.getAttribute('data-on') === 'true' }); }; });
  }

  function renderPoll() {
    var p = $('[data-panel]'), poll = S.view.poll;
    var html = '';
    if (poll) {
      var total = poll.total || 0;
      html += '<section class="rm-poll"><h3>' + esc(poll.question) + '</h3>' + poll.options.map(function (o, i) {
        var n = poll.counts ? poll.counts[i] : null, pc = n != null && total ? Math.round(n / total * 100) : 0;
        if (poll.counts) return '<div class="rm-res' + (poll.mine === i ? ' is-mine' : '') + '"><div class="rm-res-l"><span>' + esc(o) + '</span><span>' + pc + '%</span></div><div class="rm-res-t"><span style="width:' + pc + '%"></span></div></div>';
        return '<button type="button" class="rm-opt" data-vote="' + i + '">' + esc(o) + '</button>';
      }).join('') + '<p class="rm-note">' + esc(total === 1 ? '1 vote' : total + ' votes') + (poll.open ? '' : ' · ' + esc(C.pollClosed)) + '</p>' +
        (isStaff && poll.open ? '<button type="button" class="rm-btn" data-pclose="' + poll.id + '">' + esc(C.pollClose) + '</button>' : '') + '</section>';
    } else html += '<p class="rm-note">' + esc(C.noPoll) + '</p>';
    if (isStaff) html += '<form class="rm-pollform" data-pnew><h3>' + esc(C.newPoll) + '</h3><label class="rm-field"><span>' + esc(C.pollQuestion) + '</span><input name="q" maxlength="200"></label><label class="rm-field"><span>' + esc(C.pollOptions) + '</span><textarea name="o" rows="4"></textarea></label><button type="submit" class="rm-btn">' + esc(C.pollStart) + '</button></form>';
    p.innerHTML = html;
    $$('[data-vote]', p).forEach(function (b) { b.onclick = function () { send({ t: 'vote', pid: poll.id, choice: Number(b.getAttribute('data-vote')) }); }; });
    var pc = $('[data-pclose]', p); if (pc) pc.onclick = function () { send({ t: 'poll_close', pid: poll.id }); };
    var f = $('[data-pnew]', p); if (f) f.onsubmit = function (e) { e.preventDefault(); send({ t: 'poll_new', question: f.q.value, options: f.o.value.split('\n') }); f.reset(); };
  }

  function renderPeople() {
    var p = $('[data-panel]'), list = S.view.people || [];
    var hands = list.filter(function (x) { return x.hand; });
    var row = function (x) {
      var staffRow = x.role === 'host' || x.role === 'cohost', mine = x.id === ME.id, acts = '';
      // Webinars: tick people to push to them only; their real points beside the name.
      var pick = engOn() && !staffRow ? '<input type="checkbox" class="rm-pick" data-sel="' + esc(x.id) + '"' + (E.sel[x.id] ? ' checked' : '') + ' aria-label="' + esc(x.name) + '"> ' : '';
      var ptsTag = engOn() && !staffRow && x.pts ? ' <span class="rm-role">' + esc(ptsLabel(x.pts)) + '</span>' : '';
      if (!mine) {
        if (MODE === 'webinar' && !staffRow && !x.stage) acts += '<button class="rm-mini" data-act="invite" data-id="' + esc(x.id) + '">' + esc(x.invited ? C.invitedState : C.invite) + '</button>';
        if (MODE === 'webinar' && !staffRow && x.stage) acts += '<button class="rm-mini" data-act="unstage" data-id="' + esc(x.id) + '">' + esc(C.unstage) + '</button>';
        if (x.stage && !x.audioOff) acts += '<button class="rm-mini" data-act="mute" data-id="' + esc(x.id) + '">' + esc(C.mute) + '</button>';
        if (x.stage) acts += '<button class="rm-mini" data-act="spotlight" data-id="' + esc(x.id) + '">' + esc(S.view.room.spotlight === x.id ? C.unspotlight : C.spotlight) + '</button>';
        if (x.role !== 'host') acts += '<button class="rm-mini rm-danger" data-act="kick" data-id="' + esc(x.id) + '">' + esc(C.remove) + '</button>';
      }
      return '<li class="rm-person"><span class="rm-pn">' + pick + (x.hand ? '<span class="rm-hand">' + I.hand + '</span>' : '') + esc(x.name) + (mine ? ' (' + esc(C.you) + ')' : '') + (MH('personBadge', x.id) || '') + ' <span class="rm-role">' + esc(x.role === 'attendee' ? (x.stage ? C.onStage : '') : x.role === 'guest' ? '' : x.role) + '</span>' + ptsTag + '</span><span class="rm-pa">' + acts + '</span></li>';
    };
    p.innerHTML = (MODE === 'webinar' ? '<h3 class="rm-h3">' + esc(C.hands) + '</h3>' + (hands.length ? '<ul class="rm-people">' + hands.map(row).join('') + '</ul>' : '<p class="rm-note">' + esc(C.noHands) + '</p>') : '') +
      '<h3 class="rm-h3">' + esc(C.people) + ' · ' + list.length + '</h3><ul class="rm-people">' + list.filter(function (x) { return !x.hand; }).map(row).join('') + '</ul>';
    $$('[data-sel]', p).forEach(function (c) { c.onchange = function () { E.sel[c.getAttribute('data-sel')] = c.checked; if (!selected().length) E.to = 'all'; }; });
    $$('[data-act]', p).forEach(function (b) {
      b.onclick = function () {
        var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
        if (act === 'kick' && !confirm(C.removeConfirm)) return;
        if (act === 'spotlight') { send({ t: 'spotlight', id: S.view.room.spotlight === id ? null : id }); return; }
        send({ t: act, id: id });
      };
    });
  }

  function renderHost() {
    var p = $('[data-panel]'), r = S.view.room, o = r.offer || {};
    var layouts = ['auto', 'speaker', 'side', 'screen', 'grid'];
    p.innerHTML = '<div class="rm-host">' +
      (MODE === 'webinar' ? '<div class="rm-row">' + (r.status === 'lobby' ? '<p class="rm-note">' + esc(C.backstage) + '</p><button class="rm-golive" data-h="golive">' + esc(C.goLive) + '</button>' : '') +
        (ME.role === 'host' && r.status !== 'ended' ? '<button class="rm-btn rm-danger" data-h="end">' + esc(C.end) + '</button>' : '') + '</div>' : (ME.role === 'host' ? '<div class="rm-row"><button class="rm-btn rm-danger" data-h="end">' + esc(C.end) + '</button></div>' : '')) +
      '<label class="rm-field"><span>' + esc(C.layout) + '</span><select data-h="layout">' + layouts.map(function (l) { return '<option value="' + l + '"' + (r.layout === l ? ' selected' : '') + '>' + esc(C.layouts[l]) + '</option>'; }).join('') + '</select></label>' +
      '<div class="rm-row"><button class="rm-btn" data-h="lock">' + esc(r.chat.locked ? C.unlockChat : C.lockChat) + '</button>' +
      '<label class="rm-field rm-inline"><span>' + esc(C.slowMode) + '</span><select data-h="slow">' + [0, 5, 10, 30, 60].map(function (s) { return '<option value="' + s + '"' + (r.chat.slowSec === s ? ' selected' : '') + '>' + (s ? s + ' s' : esc(C.slowOff)) + '</option>'; }).join('') + '</select></label></div>' +
      (o.available ? '<div class="rm-row"><button class="' + (o.open ? 'rm-btn' : 'rm-buy') + '" data-h="offer">' + esc(o.open ? C.closeOffer : C.openOffer) + '</button>' + (o.open ? '<span class="rm-note">' + esc(C.offerOpen) + (o.closesAt ? ' · ' + esc(C.offerClosesIn) + ' <span data-offer-timer></span>' : '') + '</span>' : '') + '</div>' : '') +
      '<div class="rm-row"><label class="rm-field rm-inline"><span>' + esc(C.timer) + '</span><select data-h="tmin">' + [1, 2, 3, 5, 10, 15, 20, 30].map(function (m) { return '<option value="' + m + '">' + m + ' min</option>'; }).join('') + '</select></label><input class="rm-input" data-h="tlabel" maxlength="60" placeholder="' + esc(C.timerLabel) + '"><button class="rm-btn" data-h="tstart">' + esc(C.startTimer) + '</button>' + (r.timer ? '<button class="rm-btn" data-h="tclear">' + esc(C.clearTimer) + '</button>' : '') + '</div>' +
      (MODE === 'webinar' && r.broadcast && CFG.moq ? '<div class="rm-row rm-bcast"><p class="rm-note"><strong>' + esc(C.moq.hostHeading) + '</strong> ' + esc(broadcastLine(r)) + '</p></div>' : '') +
      '<div class="rm-row"><button class="rm-btn" data-h="rec">' + esc(S.rec ? C.stopRecord : C.record) + '</button>' + (CFG.r2 ? '' : '<p class="rm-note">' + esc(C.recordLocal) + '</p>') + '</div>' +
      (ME.role === 'host' ? '<div class="rm-row"><button class="rm-btn" data-h="cohost">' + esc(C.coHostLink) + '</button></div>' : '') +
      '</div>';
    var on = function (k, ev, fn) { var e = $('[data-h="' + k + '"]', p); if (e) e[ev] = fn; };
    on('golive', 'onclick', function () { send({ t: 'golive' }); });
    on('end', 'onclick', function () { if (confirm(C.endConfirm)) send({ t: 'end' }); });
    on('layout', 'onchange', function () { send({ t: 'layout', layout: this.value }); });
    on('lock', 'onclick', function () { send({ t: 'chat_lock', on: !r.chat.locked }); });
    on('slow', 'onchange', function () { send({ t: 'slow', sec: Number(this.value) }); });
    on('offer', 'onclick', function () { send({ t: 'offer', open: !o.open }); });
    on('tstart', 'onclick', function () { send({ t: 'timer', sec: Number($('[data-h="tmin"]', p).value) * 60, label: $('[data-h="tlabel"]', p).value }); });
    on('tclear', 'onclick', function () { send({ t: 'timer', sec: null }); });
    on('rec', 'onclick', function () { if (S.rec) stopRecording(); else startRecording(); });
    on('cohost', 'onclick', function () {
      fetch('/admin/api/rooms/' + CFG.room.id + '/links', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' }).then(function (x) { return x.json(); }).then(function (d) {
        if (!d.cohost) return;
        (navigator.clipboard ? navigator.clipboard.writeText(d.cohost) : Promise.reject()).then(function () { toast(C.copied); }, function () { prompt(C.coHostLink, d.cohost); });
      });
    });
  }

  // ───────────── the offer (attendees) ─────────────
  function renderOffer(prev) {
    var o = S.view.room.offer || {};
    var bar = $('[data-offerbar]'); if (!bar) return;
    var tpl = document.getElementById('room-offer');
    if (!tpl || isStaff) { bar.hidden = true; return; }
    bar.hidden = !o.open;
    if (o.open && !bar.innerHTML) {
      bar.innerHTML = '<span class="rm-offerbar-t"><strong>' + esc(o.label ? o.label + ' deposit' : C.offerOpen) + '</strong>' + (o.closesAt ? ' · ' + esc(C.offerClosesIn) + ' <span data-offer-timer></span>' : '') + '</span><button type="button" class="rm-buy" data-offer-open>' + esc(C.secure) + '</button>';
      $('[data-offer-open]', bar).onclick = openOffer;
    }
    if (!o.open) bar.innerHTML = '';
    var wasOpen = prev && prev.room && prev.room.offer && prev.room.offer.open;
    if (o.open && !wasOpen && !S.offerShown) { S.offerShown = true; openOffer(); }
    if (!o.open) { var sh = $('[data-offer-sheet]'); if (sh) sh.remove(); }
  }
  var buying = false;
  function openOffer() {
    if ($('[data-offer-sheet]')) return;
    var tpl = document.getElementById('room-offer'); if (!tpl) return;
    var d = h('div', { class: 'rm-sheet rm-sheet--offer', 'data-offer-sheet': '', role: 'dialog', 'aria-modal': 'true' });
    d.appendChild(h('div', { class: 'rm-sheet-in' }));
    d.firstChild.appendChild(tpl.content.cloneNode(true));
    var close = h('button', { type: 'button', class: 'rm-x', 'aria-label': 'Close' }, '×'); close.onclick = function () { d.remove(); };
    d.firstChild.insertBefore(close, d.firstChild.firstChild);
    document.body.appendChild(d);
    var sec = $('[data-offer]', d); if (sec) sec.hidden = false;
    var dlg = $('[data-oneclick]', d), err = $('[data-buy-err]', d);
    function buy(oneClick) {
      if (buying) return; buying = true;
      $$('[data-buy], [data-oc-confirm]', d).forEach(function (b) { b.disabled = true; });
      var body = { token: CFG.offer.token, one_click: Boolean(oneClick) };
      if (CFG.offer.day) body.day = CFG.offer.day;
      if (S.payPush) body.push_id = S.payPush;
      var tab = payTab();
      fetch(CFG.offer.buy, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) }).then(function (r) { return r.json(); }).catch(function () { return {}; }).then(function (r) {
        var next = r && (r.url || r.next);
        if (next) tab.go(next); else tab.close();
        buying = false;
        $$('[data-buy], [data-oc-confirm]', d).forEach(function (b) { b.disabled = false; });
        if (dlg) dlg.hidden = true;
        if (!next && err) { err.textContent = (r && r.error) || C.genericError; err.hidden = false; }
      });
    }
    $$('[data-buy]', d).forEach(function (b) { b.onclick = function () { if (CFG.offer.oneClick && dlg) dlg.hidden = false; else buy(false); }; });
    if (dlg) {
      $('[data-oc-confirm]', dlg).onclick = function () { buy(true); };
      $('[data-oc-other]', dlg).onclick = function () { buy(false); };
      $('[data-oc-close]', dlg).onclick = function () { dlg.hidden = true; };
    }
  }

  // ───────────── timers (server clock) ─────────────
  setInterval(function () {
    if (!S.view) return;
    var r = S.view.room, t = now();
    var tm = $('[data-timer]');
    if (tm) { tm.hidden = !r.timer; if (r.timer) tm.textContent = (r.timer.label ? r.timer.label + ' ' : '') + clock(r.timer.endsAt - t); }
    var cd = $('[data-lobby-cd]'); if (cd && r.startsAt) cd.textContent = r.startsAt > t ? clock(r.startsAt - t) : C.lobbyLate;
    $$('[data-offer-timer]').forEach(function (e) { e.textContent = r.offer && r.offer.closesAt ? clock(r.offer.closesAt - t) : ''; });
  }, 1000);

  // Keep-alive and clock sync, and active speaker / bandwidth from the connection's stats.
  setInterval(function () { send({ t: 'ping' }); }, 25000);
  var bw = { level: 0 };
  setInterval(function () {
    if (MH('ownsStats')) return; // media: speaker, quality and bandwidth tiers from room-media.js
    var pc = S.pc; if (!pc || pc.connectionState !== 'connected') return;
    pc.getStats().then(function (stats) {
      var best = null, bestLevel = 0.02, inBitrate = null;
      var byTrack = {};
      Object.keys(S.pulls).forEach(function (k) { var p = S.pulls[k]; if (p.track && p.kind === 'audio') byTrack[p.track.id] = p.owner; });
      stats.forEach(function (s) {
        if (s.type === 'inbound-rtp' && s.kind === 'audio' && typeof s.audioLevel === 'number' && byTrack[s.trackIdentifier] && s.audioLevel > bestLevel) { bestLevel = s.audioLevel; best = byTrack[s.trackIdentifier]; }
        if (s.type === 'candidate-pair' && s.nominated && typeof s.availableIncomingBitrate === 'number') inBitrate = s.availableIncomingBitrate;
      });
      if (best && best !== S.speaking) { S.speaking = best; S.speakAt = Date.now(); renderStage(); syncPulls(); }
      else if (!best && S.speaking && Date.now() - S.speakAt > 4000) { /* keep the last speaker in focus */ }
      if (inBitrate != null) {
        var lvl = inBitrate < 300000 ? 2 : inBitrate < 800000 ? 1 : 0;
        if (lvl !== bw.level) { bw.level = lvl; syncPulls(); }
      }
    }).catch(function () {});
  }, 1500);
  window.addEventListener('resize', function () { clearTimeout(window.__rmrs); window.__rmrs = setTimeout(syncPulls, 400); });

  // ───────────── recording (host): the composited stage plus mixed audio, uploaded in parts ─────────────
  function startRecording() {
    if (!window.MediaRecorder) { toast(C.noWebrtc); return; }
    var comp = acquireCompositor();
    var stream = new MediaStream([comp.videoTrack, comp.audioTrack]);
    var mime = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].filter(function (m) { return MediaRecorder.isTypeSupported(m); })[0] || '';
    var rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2500000 } : {});
    var R = { rec: rec, chunks: [], buffered: [], size: 0, parts: [], part: 0, id: null, partSize: 5 * 1024 * 1024, local: !CFG.r2, uploading: Promise.resolve(), failed: false, mime: rec.mimeType || mime || 'video/webm' };
    S.rec = R;
    function upload(blob) {
      R.part++; var n = R.part;
      R.uploading = R.uploading.then(function () {
        if (R.failed) return;
        return fetch(CFG.api + '/rec/' + R.id + '/part/' + n + '?t=' + encodeURIComponent(CFG.ticket), { method: 'PUT', body: blob, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
          if (!j.ok) throw new Error(j.error || 'part');
          R.parts.push(j.part);
        }).catch(function () { R.failed = true; });
      });
    }
    rec.ondataavailable = function (e) {
      if (!e.data || !e.data.size) return;
      R.chunks.push(e.data); // kept for the local download fallback
      if (R.local || !R.id) return;
      R.buffered.push(e.data); R.size += e.data.size;
      if (R.size >= R.partSize) { upload(new Blob(R.buffered, { type: R.mime })); R.buffered = []; R.size = 0; }
    };
    rec.onstop = function () {
      releaseCompositor();
      var finish = function () {
        var file = new Blob(R.chunks, { type: R.mime });
        var a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = (CFG.room.title || 'recording').replace(/[^\w -]/g, '').slice(0, 60) + (R.mime.indexOf('mp4') >= 0 ? '.mp4' : '.webm'); a.click();
      };
      if (R.local || !R.id) { toast(C.recordLocal); finish(); return; }
      if (R.buffered.length) upload(new Blob(R.buffered, { type: R.mime }));
      R.uploading.then(function () {
        if (R.failed || !R.parts.length) throw new Error('upload');
        return post('/rec/' + R.id + '/complete', { parts: R.parts });
      }).then(function (j) { if (!j || !j.ok) throw new Error('complete'); toast(C.recordSaved); }).catch(function () { toast(C.recordFailed); finish(); });
    };
    var begin = function () { rec.start(2000); send({ t: 'recording', on: true }); renderPanel(); };
    if (R.local) begin();
    else post('/rec/start', { mime: R.mime }).then(function (j) { if (j && j.ok && j.id) { R.id = j.id; R.partSize = j.partSize || R.partSize; } else R.local = true; begin(); }).catch(function () { R.local = true; begin(); });
  }
  function stopRecording() {
    var R = S.rec; if (!R) return;
    S.rec = null;
    try { R.rec.stop(); } catch (e) { /* stopped */ }
    send({ t: 'recording', on: false });
    renderPanel();
  }
  window.addEventListener('beforeunload', function (e) { if (S.rec) { e.preventDefault(); e.returnValue = ''; } });


  // ───────────── the composited stage (recording and the MoQ broadcast share one) ─────────────
  /** A 1280x720 canvas drawn from the stage's tiles (focus big, others inset, a name on each) plus every voice mixed. */
  var COMP = null;
  function acquireCompositor() {
    if (COMP) { COMP.users++; return COMP; }
    var canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    var g = canvas.getContext('2d');
    var actx = new (window.AudioContext || window.webkitAudioContext)();
    var dest = actx.createMediaStreamDestination();
    var mixed = {};
    function addAudio(track) { if (!track || mixed[track.id] || track.readyState === 'ended') return; try { actx.createMediaStreamSource(new MediaStream([track])).connect(dest); mixed[track.id] = true; } catch (e) { /* skip */ } }
    function syncAudio() {
      if (actx.state === 'suspended') actx.resume().catch(function () {});
      if (S.local.mic) addAudio(S.local.mic);
      if (S.local.screenAudio) addAudio(S.local.screenAudio);
      Object.keys(S.pulls).forEach(function (k) { var p = S.pulls[k]; if (p.track && (p.kind === 'audio' || p.kind === 'screenaudio')) addAudio(p.track); });
    }
    function nameFor(tileId) {
      var id = String(tileId || '').split(':')[0], screen = /:screen$/.test(tileId || '');
      var m = S.view && (S.view.stage || []).filter(function (x) { return x.id === id; })[0];
      return m ? (screen ? m.name + ' · ' + C.screen : m.name) : '';
    }
    var n = 0;
    function draw() {
      if (++n % 25 === 1) syncAudio();
      if (window.RoomStudio && window.RoomStudio.composite && window.RoomStudio.composite(g, 1280, 720)) return; // studio (builder B): the scene
      g.fillStyle = '#0b0b0c'; g.fillRect(0, 0, 1280, 720);
      var stage = $('[data-stage]'); if (!stage) return;
      var tiles = $$('.rm-tile', stage).filter(function (t) { var v = t.querySelector('video'); return v && v.srcObject && v.videoWidth; });
      if (!tiles.length) return;
      var focus = tiles.filter(function (t) { return t.classList.contains('is-focus'); })[0];
      var rects = [];
      if (focus && tiles.length > 1) {
        rects.push([focus, 0, 0, 1280, 720]);
        var others = tiles.filter(function (t) { return t !== focus; }).slice(0, 4);
        others.forEach(function (t, i) { rects.push([t, 1280 - 16 - 256, 16 + i * (144 + 12), 256, 144]); });
      } else {
        var k = tiles.length, cols = Math.ceil(Math.sqrt(k)), rows = Math.ceil(k / cols), w = 1280 / cols, hh = 720 / rows;
        tiles.forEach(function (t, i) { rects.push([t, (i % cols) * w, Math.floor(i / cols) * hh, w, hh]); });
      }
      rects.forEach(function (r) {
        var v = r[0].querySelector('video'), vw = v.videoWidth, vh = v.videoHeight, sc = Math.min(r[3] / vw, r[4] / vh), dw = vw * sc, dh = vh * sc;
        try { g.drawImage(v, r[1] + (r[3] - dw) / 2, r[2] + (r[4] - dh) / 2, dw, dh); } catch (e) { /* not ready */ }
        var label = nameFor(r[0].getAttribute('data-tile'));
        if (label) {
          var fs = r[3] > 600 ? 22 : 14; g.font = '600 ' + fs + 'px -apple-system, system-ui, sans-serif';
          var tw = g.measureText(label).width, x = r[1] + 12, y = r[2] + r[4] - 12;
          g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(x - 8, y - fs - 6, tw + 16, fs + 14);
          g.fillStyle = '#fff'; g.fillText(label, x, y);
        }
      });
    }
    var drawTimer = setInterval(draw, 1000 / 25);
    syncAudio();
    COMP = {
      users: 1, canvas: canvas, videoTrack: canvas.captureStream(25).getVideoTracks()[0], audioTrack: dest.stream.getAudioTracks()[0], addAudio: addAudio,
      stop: function () { clearInterval(drawTimer); try { COMP.videoTrack.stop(); } catch (e) { /* stopped */ } actx.close().catch(function () {}); },
    };
    return COMP;
  }
  function releaseCompositor() { if (!COMP) return; if (--COMP.users <= 0) { COMP.stop(); COMP = null; } }

  // ───────────── MoQ: the host publishes the stage, viewers play it ─────────────
  var MQ = { pub: null, pubStarting: false, pubRetry: 0, view: null, viewStarting: false };
  function moqLib(which) { return import('/assets/vendor/moq/' + which + '.js'); }
  function syncMoq() {
    if (!CFG.moq || !S.view || S.ended || S.removed) return;
    var me = S.view.me;
    if (me.publishMoq && !MQ.pub && !MQ.pubStarting && Date.now() > MQ.pubRetry) startMoqPublish();
    if (!me.publishMoq && (MQ.pub || MQ.pubStarting)) stopMoqPublish();
    var watch = me.media === 'moq' && !canPublishNow();
    if (watch && !MQ.view && !MQ.viewStarting) startMoqView();
    if (!watch && (MQ.view || MQ.viewStarting)) { stopMoqView(); send({ t: 'moq_view', state: 'sfu' }); renderStage(); }
  }
  function rate(kbps) { return kbps >= 1000 ? (kbps / 1000).toFixed(1) + ' Mbps' : kbps + ' kbps'; }
  function broadcastLine(r) {
    var b = r.broadcast, parts = [];
    if (b.mode === 'sfu') return C.moq.off;
    if (r.status !== 'live') return C.moq.backstage;
    if (!b.live) parts.push(MQ.pubStarting ? C.moq.starting : C.moq.down + (b.error ? ' (' + b.error + ')' : ''));
    else parts.push(C.moq.live + (b.kbps != null ? ' ' + rate(b.kbps) : '') + (b.fps != null ? ', ' + b.fps + ' fps.' : '.'));
    if (b.mode === 'auto' && !b.engaged) parts.push(C.moq.autoAt + ' ' + b.minAudience + ' ' + C.moq.viewers + '.');
    parts.push(b.moq + ' ' + C.moq.onMoq + ', ' + b.sfu + ' ' + C.moq.onSfu + '.');
    return parts.join(' ');
  }

  function startMoqPublish() {
    MQ.pubStarting = true;
    var comp = null;
    Promise.all([post('/moq'), moqLib('publish')]).then(function (r) {
      var acc = r[0], P = r[1].Publish;
      if (!acc || !acc.ok) throw new Error((acc && acc.error) || 'moq');
      if (!MQ.pubStarting) return; // stopped meanwhile
      comp = acquireCompositor();
      var conn = new P.Net.Connection({ url: new URL(acc.url), websocket: { enabled: false } });
      var bc = new P.Broadcast({ origin: conn.origin, enabled: true, announce: true, name: P.Net.Path.from(acc.name) });
      var vcap = new P.Video.Capture({ source: comp.videoTrack });
      // Two renditions (each viewer's player picks by its bandwidth); each encodes only while someone watches it.
      var hd = new P.Video.Encoder('video/hd', { broadcast: bc, capture: vcap, enabled: true, config: { maxBitrate: 2500000, frameRate: 25, keyframeInterval: 2000 } });
      var sd = new P.Video.Encoder('video/sd', { broadcast: bc, capture: vcap, enabled: true, config: { maxScale: 0.5, maxBitrate: 700000, frameRate: 25, keyframeInterval: 2000 } });
      var acap = new P.Audio.Capture({ source: { track: comp.audioTrack, kind: 'voice' }, enabled: true });
      var aenc = new P.Audio.Encoder('audio', { broadcast: bc, capture: acap, enabled: true });
      var last = { t: Date.now(), bytes: 0, frames: 0 };
      var pub = MQ.pub = { conn: conn, bc: bc, parts: [hd, sd, aenc, vcap, acap], timer: 0 };
      MQ.pubStarting = false;
      var report = function () {
        if (MQ.pub !== pub) return;
        var st = conn.status.peek(), err = conn.error.peek();
        var bytes = hd.out.stats.peek().bytes + sd.out.stats.peek().bytes + aenc.out.stats.peek().bytes;
        var frames = Math.max(hd.out.stats.peek().frames, sd.out.stats.peek().frames);
        var dt = Math.max(1, Date.now() - last.t) / 1000;
        var kbps = Math.round((bytes - last.bytes) * 8 / dt / 1000), fps = Math.round((frames - last.frames) / dt);
        last = { t: Date.now(), bytes: bytes, frames: frames };
        var msg = err ? String(err.message || err).slice(0, 150) : null;
        window.__roomMoq = { role: 'publish', status: st, kbps: kbps, fps: fps, bytes: bytes, frames: frames, error: msg };
        send({ t: 'moq_pub', on: st === 'connected', kbps: kbps, fps: fps, error: msg || (st === 'connected' ? null : C.moq.relayUnreachable) });
      };
      pub.timer = setInterval(report, 5000);
      setTimeout(report, 1500);
    }).catch(function (e) {
      MQ.pubStarting = false;
      if (comp) releaseCompositor();
      MQ.pubRetry = Date.now() + 30000;
      window.__roomMoq = { role: 'publish', status: 'error', error: String(e && e.message || e) };
      send({ t: 'moq_pub', on: false, error: String(e && e.message || e).slice(0, 150) });
      console.warn('moq publish', e);
    });
  }
  function stopMoqPublish() {
    MQ.pubStarting = false;
    var p = MQ.pub; if (!p) return;
    MQ.pub = null;
    clearInterval(p.timer);
    p.parts.forEach(function (x) { try { x.close(); } catch (e) { /* closed */ } });
    try { p.bc.close(); } catch (e) { /* closed */ }
    try { p.conn.close(); } catch (e) { /* closed */ }
    releaseCompositor();
    send({ t: 'moq_pub', on: false });
  }

  /** Can this browser play MoQ at all? (WebTransport, WebCodecs, Opus and one video codec.) '' = yes, else why not. */
  function moqCapable(W) {
    if (!window.WebTransport || !window.VideoDecoder || !window.AudioDecoder || !window.isSecureContext) return Promise.resolve('no_webtransport');
    return W.isSupported().then(function (s) {
      if (!s || s.webtransport === 'none') return 'no_webtransport';
      if (!s.audio || !s.audio.decoding || s.audio.decoding.opus !== 'full') return 'no_opus';
      var v = s.video && s.video.decoding;
      var any = v && ['h264', 'vp8', 'vp9', 'av1'].some(function (k) { return v[k] && (v[k].hardware || v[k].software); });
      return any ? '' : 'no_video_decoder';
    }).catch(function () { return 'no_support_check'; });
  }
  function moqFail(state, reason) {
    stopMoqView();
    window.__roomMoq = { role: 'watch', status: state, reason: reason, frames: 0 };
    send({ t: 'moq_view', state: state, reason: reason });
    renderStage();
  }
  function startMoqView() {
    MQ.viewStarting = true;
    if (!window.WebTransport) { MQ.viewStarting = false; moqFail('unsupported', 'no_webtransport'); return; }
    var W;
    moqLib('watch').then(function (lib) { W = lib; return moqCapable(W); }).then(function (why) {
      if (why) { MQ.viewStarting = false; moqFail('unsupported', why); return null; }
      return post('/moq');
    }).then(function (acc) {
      if (!acc || !MQ.viewStarting) return;
      MQ.viewStarting = false;
      if (!acc.ok) { send({ t: 'moq_view', state: 'sfu' }); return; } // the room isn't routing us to MoQ (any more)
      var el = h('div', { class: 'rm-moq' });
      var canvas = h('canvas', { 'aria-label': CFG.room.title }); el.appendChild(canvas); el.appendChild(h('p', { class: 'rm-moq-wait' }, esc(C.moq.connecting)));
      var Sig = W.Watch.Signals;
      // Sound needs a tap unless this page already had one (the Enter button counts).
      var muted = new Sig.Signal(!(navigator.userActivation ? navigator.userActivation.hasBeenActive : audioUnlocked));
      var conn = new W.Watch.Net.Connection({ url: new URL(acc.url), websocket: { enabled: false } });
      var player = new W.Watch.Player({ origin: conn.origin, probe: conn.probe, name: W.Watch.Net.Path.from(acc.name), canvas: canvas, enabled: true, muted: muted, visible: 'always', announced: false, catalogFormat: 'hang', delay: 'auto' });
      var v = MQ.view = { el: el, conn: conn, player: player, muted: muted, playing: false, frames: 0, lastFrameAt: Date.now(), startedAt: Date.now(), connected: false, timer: 0 };
      if (muted.peek()) showTapForSound();
      v.timer = setInterval(function () {
        if (MQ.view !== v) return;
        var st = player.video.out.stats.peek(), n = st ? st.frameCount : 0, t = Date.now(), err = conn.error.peek();
        if (conn.status.peek() === 'connected') v.connected = true;
        if (n > v.frames) { v.frames = n; v.lastFrameAt = t; }
        if (document.hidden) { v.lastFrameAt = t; v.startedAt = Math.max(v.startedAt, t - 6000); return; } // a background tab is not a stall
        window.__roomMoq = { role: 'watch', status: conn.status.peek(), frames: n, playing: v.playing, error: err ? String(err.message || err) : null };
        if (!v.playing && n > 0) {
          v.playing = true; send({ t: 'moq_view', state: 'playing' });
          if (S.pc && !canPublishNow()) teardownMedia(); // the SFU copy isn't needed any more
          renderStage();
        }
        // No picture: a blocked network (never connected in 12 s), or a broadcast that stopped arriving for 10 s.
        if (!v.playing && t - v.startedAt > 12000) moqFail('failed', v.connected ? 'stalled' : (err ? 'relay_error' : 'network'));
        else if (v.playing && t - v.lastFrameAt > 10000) moqFail('failed', 'stalled');
      }, 1000);
      renderStage();
    }).catch(function (e) { MQ.viewStarting = false; console.warn('moq watch', e); moqFail('failed', 'client_error'); });
  }
  function stopMoqView() {
    MQ.viewStarting = false;
    var v = MQ.view; if (!v) return;
    MQ.view = null;
    clearInterval(v.timer);
    try { v.player.close(); } catch (e) { /* closed */ }
    try { v.conn.close(); } catch (e) { /* closed */ }
    v.el.remove();
  }

  // ───────────── engagement (webinars): Deal momentum, pushes, knowledge checks, the agenda, the Deal Plan ─────────────
  // Every point, unlock and count comes from the room (server); the browser only draws them and reports what
  // the person did with a card (shown, opened, started, dismissed).
  var ENG = CFG.engage || null, EC = (ENG && ENG.copy) || {};
  var E = { data: null, loading: null, dismissed: {}, shown: {}, sel: {}, stats: null, statsAt: 0, quizRes: {}, planTimer: 0, planSeq: 0, preset: '', resource: '', to: 'all', open: null };
  try { E.dismissed = JSON.parse(sessionStorage.getItem('rm-dis-' + CFG.room.id) || '{}') || {}; } catch (e) { E.dismissed = {}; }
  function saveDismissed() { try { sessionStorage.setItem('rm-dis-' + CFG.room.id, JSON.stringify(E.dismissed)); } catch (e) { /* private mode */ } }
  function tpl(s, a, b) { return String(s == null ? '' : s).replace(/\{a\}/g, a == null ? '' : a).replace(/\{b\}/g, b == null ? '' : b); }
  function ptsLabel(n) { return n === 1 ? '1 point' : n + ' points'; }
  function engOn() { return Boolean(ENG && MODE === 'webinar'); }
  function ev() { return (S.view && S.view.eng) || null; }
  function loadEngage() {
    if (!engOn() || isStaff) return Promise.resolve();
    if (E.loading) return E.loading;
    E.loading = post('/engage').then(function (d) { E.loading = null; if (d && d.ok) { E.data = d; renderEngage(); if (S.tab === 'plan') renderPlan(true); } }).catch(function () { E.loading = null; });
    return E.loading;
  }
  function pushEv(id, what) { send({ t: 'push_ev', pid: id, ev: what }); }
  function moneyNum(v) {
    var s = String(v || '').toLowerCase().replace(/[$,\s]/g, ''), m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(s);
    if (!m) return null; var n = Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1); return n > 0 ? n : null;
  }
  function nextAsset(p) {
    var list = (E.data && E.data.assets || []).filter(function (a) { return typeof a.at === 'number' && a.at > p; }).sort(function (a, b) { return a.at - b.at; });
    return list[0] || null;
  }

  /** The ring, the agenda bar and the card dock (called on every room update). */
  function renderEngage() {
    if (!engOn() || !S.view) return;
    var e = ev(); if (!e) return;
    // Agenda: the host's chapter markers.
    var ag = $('[data-agenda]');
    if (ag) {
      var items = e.agenda.items || [], ch = e.agenda.chapter;
      ag.hidden = !(ch >= 0 && items.length);
      if (!ag.hidden) {
        var now = items[ch], nxt = items[ch + 1];
        ag.innerHTML = '<div class="rm-agenda-bar" aria-hidden="true">' + items.map(function (_, i) { return '<span class="' + (i < ch ? 'is-done' : i === ch ? 'is-now' : '') + '"></span>'; }).join('') + '</div>' +
          '<p class="rm-agenda-t"><span class="rm-agenda-l">' + esc(EC.agendaNow) + '</span> ' + esc(now.title) +
          (nxt ? ' <span class="rm-agenda-sep">·</span> <span class="rm-agenda-l">' + esc(EC.agendaNext) + '</span> ' + esc(nxt.title) + '<span class="rm-agenda-tease">' + esc(nxt.teaser ? ' ' + nxt.teaser : '') + '</span>' : ' <span class="rm-agenda-sep">·</span> <span class="rm-agenda-l">' + esc(EC.agendaDone) + '</span>') + '</p>';
      }
    }
    if (isStaff) return;
    // The ring: points toward the next unlock.
    var ring = $('[data-ring]');
    if (ring) {
      ring.hidden = false;
      var p = e.pts || 0, n = nextAsset(p), prev = 0;
      (E.data && E.data.assets || []).forEach(function (a) { if (typeof a.at === 'number' && a.at <= p && a.at > prev) prev = a.at; });
      var pct = n ? Math.max(4, Math.min(100, Math.round((p - prev) / Math.max(1, n.at - prev) * 100))) : 100;
      $('[data-ring-fg]', ring).setAttribute('stroke-dasharray', pct + ' 100');
      $('[data-ring-n]', ring).textContent = String(p);
      ring.setAttribute('aria-label', EC.momentum + ': ' + ptsLabel(p));
    }
    renderCards();
  }

  /** One card at a time above the controls: an open knowledge check first, then the newest push not dismissed. */
  function renderCards() {
    var dock = $('[data-cards]'); if (!dock) return;
    var e = ev(); if (!e) { dock.hidden = true; return; }
    var q = e.quiz, res = q && (E.quizRes[q.id] || (q.mine != null ? { qid: q.id, choice: q.mine, correct: q.mine === q.right, right: q.right, explain: q.explain } : null));
    var pend = (e.pushes || []).filter(function (x) { return !E.dismissed[x.id]; });
    var html = '', key = '';
    var buyNow = pend.filter(function (x) { return x.kind === 'sprint' || x.kind === 'deposit' || x.kind === 'vip'; });
    if (buyNow.length) {
      key = 'p' + buyNow[buyNow.length - 1].id;
      html = pushCard(buyNow[buyNow.length - 1]);
    } else if (q && !E.dismissed['q' + q.id] && (q.open || res)) {
      key = 'q' + q.id + (res ? 'r' : '');
      html = '<p class="rm-eyebrow">' + esc(EC.quizEyebrow) + '</p><h3 class="rm-card-h">' + esc(q.question) + '</h3>';
      if (res) {
        html += '<p class="rm-quiz-res ' + (res.correct ? 'is-right' : 'is-wrong') + '">' + esc(res.correct ? EC.quizRight : EC.quizWrong) + ' ' + esc(tpl(EC.quizAnswer, q.options[res.right])) + '</p>' + (res.explain ? '<p class="rm-card-b">' + esc(res.explain) + '</p>' : '') +
          '<div class="rm-card-a"><button type="button" class="rm-btn" data-card-x>' + esc(EC.close) + '</button></div>';
      } else if (!q.open) {
        html += '<p class="rm-card-b">' + esc(EC.quizClosed) + '</p><div class="rm-card-a"><button type="button" class="rm-btn" data-card-x>' + esc(EC.close) + '</button></div>';
      } else {
        html += '<div class="rm-quiz-opts">' + q.options.map(function (o, i) { return '<button type="button" class="rm-opt" data-quiz="' + i + '">' + esc(o) + '</button>'; }).join('') + '</div>';
      }
    } else if (pend.length) {
      var x = pend[pend.length - 1];
      key = 'p' + x.id;
      html = pushCard(x);
    }
    dock.hidden = !html;
    if (dock.getAttribute('data-key') === key && html) { updateTray(); return; }
    dock.setAttribute('data-key', key);
    dock.innerHTML = html ? '<div class="rm-card" role="region" aria-live="polite"><button type="button" class="rm-card-close" data-card-x aria-label="' + esc(EC.dismiss) + '">×</button>' + html + '</div>' : '';
    if (key && key.charAt(0) === 'p') { var pid = Number(key.slice(1)); if (!E.shown[pid]) { E.shown[pid] = 1; pushEv(pid, 'shown'); } }
    $$('[data-quiz]', dock).forEach(function (b) { b.onclick = function () { $$('[data-quiz]', dock).forEach(function (z) { z.disabled = true; }); send({ t: 'quiz_answer', qid: q.id, choice: Number(b.getAttribute('data-quiz')) }); }; });
    $$('[data-card-x]', dock).forEach(function (b) {
      b.onclick = function () {
        if (key.charAt(0) === 'p') { var id = Number(key.slice(1)); E.dismissed[id] = 1; pushEv(id, 'dismissed'); } else E.dismissed['q' + q.id] = 1;
        saveDismissed(); dock.setAttribute('data-key', ''); renderCards();
      };
    });
    var go = $('[data-card-go]', dock); if (go) go.onclick = function () { var id = Number(key.slice(1)); var px = (e.pushes || []).filter(function (z) { return z.id === id; })[0]; if (px) actPush(px); };
    updateTray();
  }
  function assetOf(id) { return (E.data && E.data.assets || []).filter(function (a) { return a.id === id; })[0] || (ENG.assets || []).filter(function (a) { return a.id === id; })[0] || null; }
  function pushCard(x) {
    var d = E.data || {}, o = (S.view.room.offer || {});
    var card = function (eyebrow, h, b, btn) { return '<p class="rm-eyebrow">' + esc(eyebrow) + '</p><h3 class="rm-card-h">' + esc(h) + '</h3>' + (b ? '<p class="rm-card-b">' + esc(b) + '</p>' : '') + '<div class="rm-card-a"><button type="button" class="' + (x.kind === 'sprint' || x.kind === 'deposit' ? 'rm-buy' : 'rm-primary') + '" data-card-go>' + esc(btn) + '</button></div>'; };
    if (x.kind === 'application') return card(EC.appEyebrow, d.app && d.app.submitted ? EC.appDoneHeading : EC.appHeading, d.app && d.app.submitted ? EC.appDoneBody : EC.appBody, d.app && d.app.submitted ? EC.appDoneNext : EC.appButton);
    if (x.kind === 'sprint') { var sp = d.sprint || {}; return card(EC.sprintEyebrow, sp.heading || 'First Deal Sprint', sp.promise || '', (sp.button || 'Start') + (sp.todayLabel ? ' · ' + sp.todayLabel : '')); }
    if (x.kind === 'deposit') return card(EC.sprintEyebrow, (o.label ? o.label + ' deposit' : C.offerOpen), '', EC.depositButton);
    if (x.kind === 'vip') return card(EC.vipEyebrow, EC.vipHeading, EC.vipBody, EC.vipButton);
    var a = assetOf(x.ref) || { title: '', body: '' };
    return card(EC.resourceEyebrow, a.title, a.body || '', EC.resourceButton);
  }
  /** The card's one action. */
  function actPush(x) {
    pushEv(x.id, 'opened');
    if (x.kind === 'application') return openApp(x);
    if (x.kind === 'sprint') return openSprint(x);
    if (x.kind === 'deposit') { pushEv(x.id, 'started'); S.payPush = x.id; return openOffer(); } // payment links: the card's push id rides with the checkout
    if (x.kind === 'vip') { var v = E.data && E.data.vip; if (v && v.url) { pushEv(x.id, 'started'); window.open(v.url, '_blank', 'noopener'); } else toast(C.genericError); return; }
    // A resource: granted by the room when it reached you; the signed link comes with your data.
    loadEngage().then(function () {
      var a = assetOf(x.ref);
      if (a && a.url) window.open(a.url, '_blank', 'noopener'); else setTimeout(function () { loadEngage().then(function () { var b = assetOf(x.ref); if (b && b.url) window.open(b.url, '_blank', 'noopener'); }); }, 800);
    });
  }
  function updateTray() {
    var t = $('[data-tray]'); if (!t) return;
    var e = ev(), all = e ? (e.pushes || []) : [], open = all.filter(function (x) { return E.dismissed[x.id]; });
    var buy = all.some(function (x) { return x.kind === 'sprint' || x.kind === 'deposit' || x.kind === 'vip'; });
    t.hidden = !open.length && !buy;
    t.classList.toggle('is-buy', buy);
    t.firstChild.nodeValue = (buy ? (EC.checkout || 'Checkout') : EC.tray) + ' ';
    $('[data-tray-n]', t).textContent = String(buy ? all.length : open.length);
  }
  function openTray() {
    var e = ev(); if (!e) return;
    var list = (e.pushes || []).slice().sort(function (a, b) { var r = function (x) { return x.kind === 'sprint' || x.kind === 'deposit' || x.kind === 'vip' ? 0 : 1; }; return r(a) - r(b); });
    var d = sheet('tray');
    d.body.innerHTML = '<h2>' + esc(list.some(function (x) { return x.kind !== 'resource' && x.kind !== 'application'; }) ? (EC.checkout || 'Checkout') : EC.tray) + '</h2><ul class="rm-traylist">' + list.map(function (x) {
      var a = x.kind === 'resource' ? assetOf(x.ref) : null;
      var title = x.kind === 'application' ? EC.appHeading : x.kind === 'sprint' ? ((E.data && E.data.sprint && E.data.sprint.heading) || 'First Deal Sprint') : x.kind === 'deposit' ? EC.depositButton : x.kind === 'vip' ? EC.vipHeading : (a ? a.title : '');
      var pay = x.kind === 'sprint' || x.kind === 'deposit' || x.kind === 'vip';
      return '<li><span>' + esc(title) + '</span><button type="button" class="' + (pay ? 'rm-buy' : 'rm-btn') + '" data-tray-go="' + x.id + '">' + esc(pay ? (EC.checkout || 'Checkout') : EC.open) + '</button></li>';
    }).join('') + '</ul>';
    $$('[data-tray-go]', d.el).forEach(function (b) { b.onclick = function () { var id = Number(b.getAttribute('data-tray-go')); d.close(); var x = list.filter(function (z) { return z.id === id; })[0]; if (x) actPush(x); }; });
  }
  /** A docked sheet: beside the stage on desktop, a bottom sheet on a phone. The stage keeps playing. */
  function sheet(name) {
    var old = $('[data-esheet]'); if (old) old.remove();
    var el = h('div', { class: 'rm-sheet rm-sheet--dock', 'data-esheet': name, role: 'dialog', 'aria-modal': 'false' });
    var inner = h('div', { class: 'rm-sheet-in' });
    var x = h('button', { type: 'button', class: 'rm-x', 'aria-label': EC.close || 'Close' }, '×');
    var body = h('div', { class: 'rm-sheet-body' });
    inner.appendChild(x); inner.appendChild(body); el.appendChild(inner); document.body.appendChild(el);
    var close = function () { el.remove(); };
    x.onclick = close;
    el.onclick = function (ev2) { if (ev2.target === el) close(); };
    return { el: el, inner: body, body: body, close: close };
  }

  // ── the application, step by step ──
  function openApp(push) {
    loadEngage().then(function () {
      var app = E.data && E.data.app;
      if (!app) { toast(EC.appNeedsLead); return; }
      var d = sheet('app'), qs = app.questions || [], ans = {}, i = 0, started = false;
      Object.keys(app.answers || {}).forEach(function (k) { ans[k] = app.answers[k]; });
      var body = h('div', { class: 'rm-app' }); d.inner.appendChild(body);
      function done() {
        var o = S.view.room.offer || {}, sprintOpen = (ev().pushes || []).some(function (x) { return x.kind === 'sprint'; });
        body.innerHTML = '<p class="rm-eyebrow">' + esc(EC.appEyebrow) + '</p><h2>' + esc(EC.appDoneHeading) + '</h2><p>' + esc(EC.appDoneBody) + '</p>' +
          '<h3 class="rm-h3">' + esc(EC.appDoneNext) + '</h3>' + (o.open ? '<p>' + esc(EC.appDoneOffer) + '</p><button type="button" class="rm-buy" data-app-offer>' + esc(EC.depositButton) + '</button>' : '') +
          (sprintOpen ? '<p>' + esc(EC.appDoneSprint) + '</p>' : '');
        var b = $('[data-app-offer]', body); if (b) b.onclick = function () { d.close(); openOffer(); };
      }
      if (app.submitted) return done();
      function val(q) { return ans[q.id]; }
      function draw(err) {
        var q = qs[i], v = val(q);
        var input = '';
        if (q.type === 'single') input = '<div class="rm-choices" role="radiogroup">' + q.options.map(function (o) { return '<button type="button" class="rm-opt' + (v === o.value ? ' is-on' : '') + '" role="radio" aria-checked="' + (v === o.value) + '" data-v="' + esc(o.value) + '">' + esc(o.label) + '</button>'; }).join('') + '</div>';
        else if (q.type === 'multi') input = '<div class="rm-choices">' + q.options.map(function (o) { var on = Array.isArray(v) && v.indexOf(o.value) >= 0; return '<button type="button" class="rm-opt' + (on ? ' is-on' : '') + '" aria-pressed="' + on + '" data-m="' + esc(o.value) + '">' + esc(o.label) + '</button>'; }).join('') + '</div>';
        else input = '<textarea class="rm-input rm-app-text" rows="4" maxlength="2000" placeholder="' + esc(q.placeholder || '') + '" aria-label="' + esc(q.title) + '">' + esc(v || '') + '</textarea>';
        body.innerHTML = '<p class="rm-eyebrow">' + esc(tpl(EC.appStep, i + 1, qs.length)) + '</p>' + (i === 0 ? '<p class="rm-fine">' + esc(EC.appAbout) + ' ' + esc(app.name || '') + (app.email ? ' · ' + esc(app.email) : '') + '</p>' : '') +
          '<h2 class="rm-app-q">' + esc(q.title) + '</h2>' + (q.help ? '<p class="rm-fine">' + esc(q.help) + '</p>' : '') + input +
          '<p class="rm-err" role="alert"' + (err ? '' : ' hidden') + '>' + esc(err || '') + '</p>' +
          '<div class="rm-app-nav">' + (i > 0 ? '<button type="button" class="rm-link" data-back>' + esc(EC.appBack) + '</button>' : '<span></span>') +
          '<button type="button" class="rm-primary" data-next>' + esc(i === qs.length - 1 ? EC.appSubmit : EC.appContinue) + '</button></div>' +
          '<div class="rm-app-prog" aria-hidden="true"><span style="width:' + Math.round((i + 1) / qs.length * 100) + '%"></span></div>';
        $$('[data-v]', body).forEach(function (b) { b.onclick = function () { ans[q.id] = b.getAttribute('data-v'); draw(); setTimeout(next, 180); }; });
        $$('[data-m]', body).forEach(function (b) { b.onclick = function () { var cur = Array.isArray(ans[q.id]) ? ans[q.id].slice() : [], k = b.getAttribute('data-m'), j = cur.indexOf(k); if (j >= 0) cur.splice(j, 1); else cur.push(k); ans[q.id] = cur; draw(); }; });
        var ta = $('textarea', body); if (ta) { ta.oninput = function () { ans[q.id] = ta.value; }; ta.focus(); }
        var bk = $('[data-back]', body); if (bk) bk.onclick = function () { i--; draw(); };
        $('[data-next]', body).onclick = next;
      }
      function ok(q) { var v = val(q); if (q.type === 'text') return typeof v === 'string' && v.trim().length >= (q.minLength || 1); if (q.type === 'multi') return Array.isArray(v) && v.length > 0; return v != null && v !== ''; }
      function next() {
        var q = qs[i];
        if (!ok(q)) { draw(EC.appMissing); return; }
        if (!started) { started = true; pushEv(push.id, 'started'); }
        if (i < qs.length - 1) { i++; draw(); return; }
        var btn = $('[data-next]', body); btn.disabled = true;
        post('/app', { answers: ans }).then(function (r) {
          if (r && r.ok) { app.submitted = true; done(); renderCards(); return; }
          btn.disabled = false;
          var at = r && r.field ? qs.map(function (z) { return z.id; }).indexOf(r.field) : -1;
          if (at >= 0) { i = at; draw(r.error); } else draw((r && r.error) || C.genericError);
        });
      }
      draw();
    });
  }

  // ── the First Deal Sprint card ──
  var sprintBusy = false;
  function openSprint(push) {
    loadEngage().then(function () {
      var sp = E.data && E.data.sprint;
      var d = sheet('sprint');
      if (!sp) { d.body.innerHTML = '<p>' + esc(EC.sprintUnavailable) + '</p>'; return; }
      var body = h('div', { class: 'rm-offer' }); d.inner.appendChild(body);
      if (sp.paid) { body.innerHTML = '<h2 class="rm-offer-h">' + esc(EC.paidHeading) + '</h2><p>' + esc(EC.sprintPaidBody) + '</p>'; return; }
      if (!sp.hasLead) { body.innerHTML = '<p class="rm-eyebrow">' + esc(EC.sprintEyebrow) + '</p><h2 class="rm-offer-h">' + esc(sp.heading) + '</h2><p>' + esc(EC.noLeadEmail) + '</p>'; return; }
      if (!sp.qualified && sp.bands && sp.bands.length) {
        // No revenue on file: ask it in one tap, then the checkout (or the application) follows.
        body.innerHTML = '<p class="rm-eyebrow">' + esc(EC.sprintEyebrow) + '</p><h2 class="rm-offer-h">' + esc(EC.bandHeading) + '</h2><p class="rm-fine">' + esc(EC.bandFine) + '</p>' +
          '<div class="rm-choices" role="radiogroup" aria-label="' + esc(EC.bandHeading) + '">' + sp.bands.map(function (b) { return '<button type="button" class="rm-opt" role="radio" aria-checked="false" data-band="' + esc(b.value) + '">' + esc(b.label) + '</button>'; }).join('') + '</div>' +
          '<p class="rm-err" role="alert" data-band-err hidden></p>';
        $$('[data-band]', body).forEach(function (b) {
          b.onclick = function () {
            $$('[data-band]', body).forEach(function (z) { z.disabled = true; });
            post('/band', { band: b.getAttribute('data-band') }).then(function (r) {
              if (r && r.ok) { d.close(); return openSprint(push); }
              $$('[data-band]', body).forEach(function (z) { z.disabled = false; });
              var er = $('[data-band-err]', body); er.textContent = (r && r.error) || EC.bandSaveError; er.hidden = false;
            });
          };
        });
        return;
      }
      if (!sp.qualified) {
        var appPush = (ev().pushes || []).filter(function (x) { return x.kind === 'application'; })[0];
        body.innerHTML = '<p class="rm-eyebrow">' + esc(EC.sprintEyebrow) + '</p><h2 class="rm-offer-h">' + esc(sp.heading) + '</h2><p>' + esc(EC.sprintUnderMillion) + '</p>' +
          (appPush ? '<p>' + esc(EC.underMillionNext) + '</p><button type="button" class="rm-primary" data-sp-app>' + esc(EC.appButton) + '</button>' : '');
        var ab = $('[data-sp-app]', body); if (ab) ab.onclick = function () { d.close(); actPush(appPush); };
        return;
      }
      if (!sp.available) { body.innerHTML = '<p class="rm-eyebrow">' + esc(EC.sprintEyebrow) + '</p><h2 class="rm-offer-h">' + esc(sp.heading) + '</h2><p>' + esc(EC.sprintUnavailable) + '</p>'; return; }
      body.innerHTML = '<p class="rm-eyebrow">' + esc(EC.sprintEyebrow) + '</p><h2 class="rm-offer-h">' + esc(sp.heading) + '</h2><p class="rm-lede">' + esc(sp.promise) + '</p><p>' + esc(sp.lede) + '</p>' +
        (sp.perks && sp.perks.length ? '<ul class="rm-secures">' + sp.perks.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
        '<p class="rm-price">' + esc(sp.line) + '</p>' +
        '<button type="button" class="rm-buy" data-sp-buy>' + esc(sp.button + ' · ' + sp.todayLabel) + '</button>' +
        '<p class="rm-err" role="alert" data-sp-err hidden></p>' +
        '<p class="rm-fine">' + esc(sp.guarantee) + '</p><p class="rm-fine">' + esc(sp.creditNote) + '</p>' +
        '<div class="rm-dialog" data-sp-oc hidden role="dialog" aria-modal="true"><div class="rm-dialog-in"><h3>' + esc(EC.oneClickHeading) + '</h3><p>' + esc(sp.oneClick && sp.oneClick.card ? tpl(EC.oneClickCharged, sp.oneClick.card) : EC.oneClickChargedNoCard) + '</p>' +
        '<button type="button" class="rm-buy" data-sp-confirm>' + esc(tpl(EC.oneClickConfirm, sp.todayLabel)) + '</button><button type="button" class="rm-btn" data-sp-other>' + esc(EC.otherCard) + '</button><button type="button" class="rm-x" data-sp-close aria-label="' + esc(EC.close) + '">×</button></div></div>';
      var err = $('[data-sp-err]', body), dlg = $('[data-sp-oc]', body);
      function buy(oneClick) {
        if (sprintBusy) return; sprintBusy = true;
        $$('[data-sp-buy], [data-sp-confirm]', body).forEach(function (b) { b.disabled = true; });
        var tab = payTab();
        post('/sprint', { one_click: Boolean(oneClick) }).then(function (r) {
          sprintBusy = false; dlg.hidden = true;
          $$('[data-sp-buy], [data-sp-confirm]', body).forEach(function (b) { b.disabled = false; });
          if (!(r && r.next && !r.paid)) tab.close();
          if (r && r.paid) { body.innerHTML = '<h2 class="rm-offer-h">' + esc(EC.paidHeading) + '</h2><p>' + esc(EC.sprintPaidBody) + '</p>'; E.data.sprint.paid = true; return; }
          if (r && r.next) { tab.go(r.next); return; }
          err.textContent = (r && r.error) || C.genericError; err.hidden = false;
        });
      }
      $('[data-sp-buy]', body).onclick = function () { if (sp.oneClick) dlg.hidden = false; else buy(false); };
      $('[data-sp-confirm]', body).onclick = function () { buy(true); };
      $('[data-sp-other]', body).onclick = function () { buy(false); };
      $('[data-sp-close]', body).onclick = function () { dlg.hidden = true; };
    });
  }

  // ── your momentum: points, unlocks, how to earn, the leaderboard ──
  function openMomentum() {
    loadEngage().then(function () {
      var e = ev() || { pts: 0, board: {} }, dd = E.data || { assets: [], rules: [] };
      var d = sheet('momentum'), p = e.pts || 0, n = nextAsset(p);
      var b = e.board || {};
      d.body.innerHTML = '<p class="rm-eyebrow">' + esc(EC.momentum) + '</p><h2>' + esc(ptsLabel(p)) + '</h2>' +
        '<p class="rm-fine">' + esc(n ? tpl(EC.nextAt, n.title, n.at) : EC.allUnlocked) + '</p>' +
        '<h3 class="rm-h3">' + esc(EC.unlocksHeading) + '</h3><ul class="rm-unlocks">' + (dd.assets || []).map(function (a) {
          return '<li class="' + (a.url ? 'is-on' : '') + '"><div><strong>' + esc(a.title) + '</strong><span class="rm-fine">' + esc(a.body) + '</span></div>' +
            (a.url ? '<a class="rm-btn" href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(EC.open) + '</a>' : '<span class="rm-lock">' + esc(a.at === 'end' ? EC.lockedEnd : typeof a.at === 'number' ? tpl(EC.locked, a.at) : '') + '</span>') + '</li>';
        }).join('') + '</ul>' +
        '<h3 class="rm-h3">' + esc(EC.earnHeading) + '</h3><ul class="rm-rules">' + (dd.rules || []).map(function (r) { return '<li><span>' + esc(r.label) + '</span><span>+' + r.points + (r.cap > 1 ? ' · ' + esc(tpl(EC.upTo, r.cap)) : '') + '</span></li>'; }).join('') + '</ul>' +
        '<p class="rm-fine">' + esc(EC.earnNote) + '</p>' +
        '<h3 class="rm-h3">' + esc(EC.boardHeading) + '</h3>' + (b.on
          ? '<label class="rm-check"><input type="checkbox" data-board-opt' + (b.optedIn ? ' checked' : '') + '> ' + esc(EC.boardOptIn) + '</label>' +
            ((b.top || []).length ? '<ol class="rm-board">' + b.top.map(function (x) { return '<li><span>' + esc(x.name) + '</span><span>' + x.points + '</span></li>'; }).join('') + '</ol>' : '<p class="rm-fine">' + esc(EC.boardEmpty) + '</p>')
          : '<p class="rm-fine">' + esc(EC.boardOff) + '</p>');
      var opt = $('[data-board-opt]', d.el); if (opt) opt.onchange = function () { send({ t: 'board_opt', on: opt.checked }); };
    });
  }

  // ── the Deal Plan (a tab for attendees) ──
  var PLAN = [
    ['planBuyBox', [['industry', 'planIndustry', 'planIndustryHint'], ['size', 'planSize', 'planSizeHint'], ['geography', 'planGeography', 'planGeographyHint']]],
    ['planOutreach', [['owners_per_week', 'planOwners', 'planOwnersHint', 'numeric']]],
    ['planCoverage', [['cash_flow', 'planCashFlow', 'planCashFlowHint', 'decimal'], ['debt_service', 'planDebt', 'planDebtHint', 'decimal']]],
    ['planActions', [['action_1', 'planAction', 0], ['action_2', 'planAction', 1], ['action_3', 'planAction', 2]]],
  ];
  function planData() { var o = {}; $$('[data-plan]').forEach(function (i) { o[i.getAttribute('data-plan')] = i.value; }); return o; }
  function coverageLine(o) {
    var cf = moneyNum(o.cash_flow), ds = moneyNum(o.debt_service);
    if (cf == null || ds == null) return '';
    var r = Math.round(cf / ds * 100) / 100, max = '$' + Math.round(cf / 1.5).toLocaleString('en-US');
    return r >= 1.5 ? tpl(EC.planPasses, r.toFixed(2)) : tpl(EC.planFails, r.toFixed(2), max);
  }
  function renderPlan(force) {
    var p = $('[data-panel]'); if (!p || S.tab !== 'plan') return;
    if (!force && $('[data-planform]', p)) return;
    if (!ENG.lead) { p.innerHTML = '<p class="rm-note">' + esc(EC.planNeedsLead) + '</p>'; return; }
    var data = (E.data && E.data.plan && E.data.plan.data) || {}, steps = (E.data && E.data.plan && E.data.plan.steps) || [];
    var cur = $('[data-planform]', p) ? planData() : null;
    if (cur) data = cur;
    p.innerHTML = '<form class="rm-plan" data-planform autocomplete="off"><h3 class="rm-h3">' + esc(EC.planHeading) + '</h3><p class="rm-fine">' + esc(EC.planIntro) + '</p>' +
      PLAN.map(function (sec) {
        return '<fieldset><legend>' + esc(EC[sec[0]]) + '</legend>' + sec[1].map(function (f) {
          var label = typeof f[2] === 'number' ? tpl(EC.planAction, f[2] + 1) : EC[f[1]], hint = typeof f[2] === 'number' ? (EC.planActionHints || [])[f[2]] : EC[f[2]];
          return '<label class="rm-field"><span>' + esc(label) + '</span><input name="' + f[0] + '" data-plan="' + f[0] + '" maxlength="200" placeholder="' + esc(hint || '') + '"' + (f[3] ? ' inputmode="' + f[3] + '"' : '') + ' value="' + esc(data[f[0]] || '') + '"></label>';
        }).join('') + (sec[0] === 'planCoverage' ? '<p class="rm-cov" data-cov aria-live="polite"></p>' : '') + '</fieldset>';
      }).join('') + '<p class="rm-fine" data-plan-state>' + esc(tpl(EC.planSteps, steps.length)) + '</p></form>';
    var cov = $('[data-cov]', p); cov.textContent = coverageLine(data);
    $$('[data-plan]', p).forEach(function (i) {
      i.oninput = function () {
        cov.textContent = coverageLine(planData());
        var st = $('[data-plan-state]', p); st.textContent = EC.planSaving;
        clearTimeout(E.planTimer); E.planTimer = setTimeout(savePlan, 900);
      };
    });
    $('[data-planform]', p).onsubmit = function (e2) { e2.preventDefault(); savePlan(); };
  }
  function savePlan() {
    var seq = ++E.planSeq, data = planData();
    post('/plan', { data: data }).then(function (r) {
      if (seq !== E.planSeq) return;
      var st = $('[data-plan-state]'); if (!st) return;
      if (!r || !r.ok) { st.textContent = (r && r.error) || C.genericError; return; }
      st.textContent = EC.planSaved + ' · ' + tpl(EC.planSteps, (r.steps || []).length);
      if (E.data) E.data.plan = { data: data, steps: r.steps || [] };
    });
  }

  // ── the host: Push, knowledge checks, the agenda, the leaderboard ──
  function kindTitle(x) {
    if (x.kind === 'resource') { var a = assetOf(x.ref); return a ? a.title : EC.pushResource; }
    return { application: EC.pushApplication, sprint: EC.pushSprint, deposit: EC.pushDeposit, vip: EC.pushVip }[x.kind] || x.kind;
  }
  function selected() { return Object.keys(E.sel).filter(function (k) { return E.sel[k]; }); }
  /** The room's automatic pushes (staff): when each goes, what happened, Skip and Push now. */
  function autoSection(e) {
    var list = e.auto || [], r = S.view.room, live = r.status === 'live' && S.view.room.wentLiveAt;
    if (!list.length) return '<section><h3 class="rm-h3">' + esc(EC.autoHeading) + '</h3><p class="rm-fine">' + esc(EC.autoNone) + '</p></section>';
    return '<section><h3 class="rm-h3">' + esc(EC.autoHeading) + '</h3><p class="rm-fine">' + esc(EC.autoNote) + '</p><ul class="rm-auto">' + list.map(function (x) {
      var st, btns = '';
      if (x.done) st = x.done.how === 'auto' ? EC.autoSent : x.done.how === 'host' ? EC.autoSentByHost : x.done.how === 'skipped' ? EC.autoSkipped : EC.autoUnavailable;
      else if (!live) st = EC.autoBeforeLive;
      else {
        var left = S.view.room.wentLiveAt + x.at * 60000 - now();
        st = left > 0 ? tpl(EC.autoIn, clock(left)) : (x.kind === 'deposit' ? EC.autoWaitsOffer : EC.autoDue);
      }
      if (!x.done) btns = '<button type="button" class="rm-mini" data-auto-skip="' + esc(x.id) + '">' + esc(EC.autoSkip) + '</button>' + (live ? '<button type="button" class="rm-mini" data-auto-now="' + esc(x.id) + '">' + esc(EC.autoNow) + '</button>' : '');
      return '<li><span><strong>' + esc(kindTitle(x)) + '</strong> <span class="rm-fine">' + esc(tpl(EC.autoMin, x.at)) + ' · ' + esc(st) + '</span></span><span class="rm-row">' + btns + '</span></li>';
    }).join('') + '</ul></section>';
  }
  function refreshStats(force) {
    if (!isStaff || !engOn()) return;
    if (!force && Date.now() - E.statsAt < 3500) return;
    E.statsAt = Date.now();
    post('/engage/stats').then(function (d) { if (d && d.ok) { E.stats = d; if (S.tab === 'push') renderPanel(); } });
  }
  setInterval(function () { if (S.tab === 'push') refreshStats(); }, 4000);
  function renderPush() {
    var p = $('[data-panel]'), e = ev(); if (!p || !e) return;
    var av = e.avail || {}, o = S.view.room.offer || {}, sel = selected(), stats = E.stats || { pushes: [], applications: [] };
    var F = EC.funnel || {};
    var q = e.quiz, ag = e.agenda || { items: [], chapter: -1 }, presets = ENG.presets || [];
    var btn = function (k, label, ok) { return '<button type="button" class="rm-btn" data-push="' + k + '"' + (ok ? '' : ' disabled') + '>' + esc(label) + '</button>'; };
    p.innerHTML = '<div class="rm-host rm-push">' +
      '<section><h3 class="rm-h3">' + esc(EC.pushHeading) + '</h3>' +
      '<div class="rm-row rm-seg" role="radiogroup" aria-label="' + esc(EC.pushTo) + '"><span class="rm-note">' + esc(EC.pushTo) + '</span>' +
      '<button type="button" class="rm-mini" role="radio" aria-checked="' + (E.to === 'all') + '" data-to="all">' + esc(EC.pushEveryone) + '</button>' +
      '<button type="button" class="rm-mini" role="radio" aria-checked="' + (E.to === 'sel') + '" data-to="sel"' + (sel.length ? '' : ' disabled') + '>' + esc(tpl(EC.selectedCount, sel.length)) + '</button></div>' +
      (sel.length ? '' : '<p class="rm-fine">' + esc(EC.selectHint) + '</p>') +
      '<div class="rm-row">' + btn('application', EC.pushApplication, av.application) + btn('sprint', EC.pushSprint, av.sprint) + btn('deposit', EC.pushDeposit, av.deposit && o.open) + (av.vip ? btn('vip', EC.pushVip, true) : '') + '</div>' +
      (av.deposit && !o.open ? '<p class="rm-fine">' + esc(EC.pushNeedsOffer) + '</p>' : '') +
      '<div class="rm-row"><select class="rm-input rm-inline-sel" data-res aria-label="' + esc(EC.pushResource) + '">' + (ENG.assets || []).map(function (a) { return '<option value="' + esc(a.id) + '"' + (E.resource === a.id ? ' selected' : '') + '>' + esc(a.title) + '</option>'; }).join('') + '</select>' + btn('resource', EC.pushSend, (av.resources || []).length) + '</div></section>' +
      autoSection(e) +
      '<section><h3 class="rm-h3">' + esc(EC.pushLive) + '</h3>' + (stats.pushes.length ? '<table class="rm-funnel"><thead><tr><th></th><th>' + esc(F.shown) + '</th><th>' + esc(F.opened) + '</th><th>' + esc(F.started) + '</th><th>' + esc(F.submitted) + '</th><th>' + esc(F.paid) + '</th><th></th></tr></thead><tbody>' +
        stats.pushes.map(function (x) { return '<tr class="' + (x.open ? '' : 'is-closed') + '"><td>' + esc(kindTitle(x)) + '<span class="rm-fine"> · ' + (x.targets || 0) + '</span></td><td>' + x.counts.shown + '</td><td>' + x.counts.opened + '</td><td>' + x.counts.started + '</td><td>' + x.counts.submitted + '</td><td>' + x.counts.paid + '</td><td>' + (x.open ? '<button type="button" class="rm-mini" data-pclose-push="' + x.id + '">' + esc(EC.pushClose) + '</button>' : '') + '</td></tr>'; }).join('') + '</tbody></table>' : '<p class="rm-note">' + esc(EC.pushNone) + '</p>') +
      (stats.applications.length ? '<ul class="rm-apps">' + stats.applications.map(function (a) { return '<li><span>' + esc(a.name) + '</span><span class="rm-tier rm-tier-' + esc(a.tier || 'x') + '">' + esc(a.tier || '–') + (a.score != null ? ' · ' + a.score : '') + '</span></li>'; }).join('') + '</ul><p class="rm-fine">' + esc(EC.tierNote) + '</p>' : '') + '</section>' +
      '<section><h3 class="rm-h3">' + esc(EC.quizHeading) + '</h3>' +
      (q ? '<div class="rm-quizhost"><p><strong>' + esc(q.question) + '</strong></p>' + q.options.map(function (op, i) { var n = q.counts ? q.counts[i] : 0; return '<div class="rm-res' + (i === q.right ? ' is-mine' : '') + '"><div class="rm-res-l"><span>' + esc(op) + '</span><span>' + n + '</span></div></div>'; }).join('') +
        '<p class="rm-fine">' + esc(tpl(EC.quizRightPct, q.counts ? q.counts[q.right] || 0 : 0, q.total)) + '</p>' + (q.open ? '<button type="button" class="rm-btn" data-qclose="' + q.id + '">' + esc(EC.quizClose) + '</button>' : '') + '</div>' : '') +
      '<div class="rm-row"><select class="rm-input rm-inline-sel" data-preset aria-label="' + esc(EC.quizPreset) + '"><option value="">' + esc(EC.quizPreset) + '</option>' + presets.map(function (x) { return '<option value="' + esc(x.id) + '"' + (E.preset === x.id ? ' selected' : '') + '>' + esc(x.question.slice(0, 70)) + '</option>'; }).join('') + '</select><button type="button" class="rm-btn" data-qpreset>' + esc(EC.quizStart) + '</button></div>' +
      '<details class="rm-own"><summary>' + esc(EC.quizOwn) + '</summary><form class="rm-pollform" data-qform><label class="rm-field"><span>' + esc(EC.quizQuestion) + '</span><input name="qq" maxlength="240"></label><label class="rm-field"><span>' + esc(EC.quizOptions) + '</span><textarea name="qo" rows="3"></textarea></label>' +
        '<label class="rm-field"><span>' + esc(EC.quizCorrect) + '</span><input name="qc" inputmode="numeric" maxlength="1"></label><label class="rm-field"><span>' + esc(EC.quizExplain) + '</span><textarea name="qe" rows="2" maxlength="400"></textarea></label><button type="submit" class="rm-btn">' + esc(EC.quizStart) + '</button></form></details></section>' +
      '<section><h3 class="rm-h3">' + esc(EC.agendaHeading) + '</h3><ol class="rm-aglist">' + ag.items.map(function (it, i) { return '<li class="' + (i === ag.chapter ? 'is-now' : i < ag.chapter ? 'is-done' : '') + '">' + esc(it.title) + '</li>'; }).join('') + '</ol>' +
        '<div class="rm-row">' + (ag.chapter > 0 ? '<button type="button" class="rm-btn" data-ch="' + (ag.chapter - 1) + '">' + esc(EC.agendaBack) + '</button>' : '') + (ag.chapter < ag.items.length - 1 ? '<button type="button" class="rm-primary rm-small" data-ch="' + (ag.chapter + 1) + '">' + esc(ag.chapter < 0 ? EC.agendaStart : EC.agendaNextBtn) + '</button>' : '') + '</div></section>' +
      '<section><h3 class="rm-h3">' + esc(EC.boardHeading) + '</h3><button type="button" class="rm-btn" data-board>' + esc(e.board.on ? EC.boardToggleOff : EC.boardToggleOn) + '</button>' +
        ((e.board.top || []).length ? '<ol class="rm-board">' + e.board.top.map(function (x) { return '<li><span>' + esc(x.name) + '</span><span>' + x.points + '</span></li>'; }).join('') + '</ol>' : '<p class="rm-fine">' + esc(EC.boardEmpty) + '</p>') + '</section>' +
      '</div>';
    $$('[data-to]', p).forEach(function (b) { b.onclick = function () { E.to = b.getAttribute('data-to'); renderPanel(); }; });
    $$('[data-auto-skip]', p).forEach(function (b) { b.onclick = function () { send({ t: 'autopush_skip', id: b.getAttribute('data-auto-skip') }); }; });
    $$('[data-auto-now]', p).forEach(function (b) { b.onclick = function () { send({ t: 'autopush_now', id: b.getAttribute('data-auto-now') }); setTimeout(function () { refreshStats(true); }, 600); }; });
    $$('[data-push]', p).forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-push'), m = { t: 'push', kind: k };
        if (k === 'resource') m.ref = $('[data-res]', p).value;
        if (E.to === 'sel' && sel.length) m.to = sel;
        send(m); setTimeout(function () { refreshStats(true); }, 600);
      };
    });
    var rs = $('[data-res]', p); if (rs) rs.onchange = function () { E.resource = rs.value; };
    var ps = $('[data-preset]', p); if (ps) ps.onchange = function () { E.preset = ps.value; };
    $$('[data-pclose-push]', p).forEach(function (b) { b.onclick = function () { send({ t: 'push_close', pid: Number(b.getAttribute('data-pclose-push')) }); setTimeout(function () { refreshStats(true); }, 600); }; });
    var qc = $('[data-qclose]', p); if (qc) qc.onclick = function () { send({ t: 'quiz_close', qid: Number(qc.getAttribute('data-qclose')) }); };
    $('[data-qpreset]', p).onclick = function () { var x = presets.filter(function (z) { return z.id === E.preset; })[0]; if (x) send({ t: 'quiz_new', question: x.question, options: x.options, correct: x.correct, explain: x.explain }); };
    $('[data-qform]', p).onsubmit = function (e2) { e2.preventDefault(); var f = this; send({ t: 'quiz_new', question: f.qq.value, options: f.qo.value.split('\n'), correct: Number(f.qc.value) - 1, explain: f.qe.value }); f.reset(); };
    $$('[data-ch]', p).forEach(function (b) { b.onclick = function () { send({ t: 'chapter', n: Number(b.getAttribute('data-ch')) }); }; });
    $('[data-board]', p).onclick = function () { send({ t: 'board', on: !e.board.on }); };
    if (!E.stats) refreshStats(true);
  }

  function endScreen(title, body) {
    S.wsClosedByUs = true;
    emit('leave');
    stopMoqPublish(); stopMoqView();
    stopLocal(); teardownMedia();
    var sh = $('[data-offer-sheet]');
    var keepOffer = S.view && S.view.room.offer && S.view.room.offer.open && document.getElementById('room-offer');
    var es = $('[data-esheet]'); if (es && es.getAttribute('data-esheet') !== 'sprint') es.remove();
    if (engOn() && !isStaff && ENG.lead && S.ended) body = (body ? body + ' ' : '') + EC.endNote;
    app.innerHTML = '<div class="rm-entry"><h1 class="rm-h1">' + esc(title) + '</h1>' + (body ? '<p class="rm-lede">' + esc(body) + '</p>' : '') + (keepOffer ? '<button type="button" class="rm-buy" data-offer-open>' + esc(C.secure) + '</button>' : '') + (CFG.back ? '<p><a class="rm-link" href="' + esc(CFG.back) + '">' + esc(C.back) + '</a></p>' : '') + '</div>';
    var b = $('[data-offer-open]'); if (b) b.onclick = openOffer;
    if (sh && !keepOffer) sh.remove();
  }

  // ───────────── add-on modules (builder B "studio" first; others add theirs the same way) ─────────────
  // One listener registry for every add-on: LISTEN/emit are declared at the top (area A media uses them early).
  var coreHandlers = LISTEN;
  function coreEmit(type, data) { emit(type, data); }
  var rawHandlers = [];
  // Whole-message listeners (builder E lifecycle uses core.on(fn) with one argument).
  function emitCore(m) { rawHandlers.forEach(function (fn) { try { fn(m); } catch (e) { console.warn('room add-on', e); } }); }
  // Area C (audience) hooks: their own names (c:msg, c:state, c:chat) so they never collide with the studio's message-type events.
  var XTABS = [];
  function hook(type, data) { (coreHandlers['c:' + type] || []).forEach(function (fn) { try { fn(data); } catch (e) { console.warn('room add-on', e); } }); }
  var CORE = window.RoomCore = {
    S: S, CFG: CFG, cfg: CFG, unlockAudio: function () { unlockAudio(); }, ME: ME, isStaff: isStaff, send: send, post: post, now: function () { return now(); }, toast: toast, esc: esc, h: h, $: $, $$: $$, clock: clock,
    on: function (type, fn) { if (typeof type === 'function') { rawHandlers.push(type); return; } (coreHandlers[type] = coreHandlers[type] || []).push(fn); },
    renderStage: renderStage, renderTabs: renderTabs, renderPanel: renderPanel, setMic: setMic, toggleMic: toggleMic,
    E: E, tpl: tpl, sheet: sheet,
    addTab: function (t) { XTABS.push(t); },
    showTab: function (id) { S.tab = id; renderTabs(); renderPanel(); },
    renderChat: function () { renderChat(true); },
    openOffer: function () { openOffer(); }, actPush: function (x) { actPush(x); }, loadEngage: function () { return loadEngage(); },
    reopenPush: function (id) { delete E.dismissed[id]; saveDismissed(); var dk = $('[data-cards]'); if (dk) dk.setAttribute('data-key', ''); renderCards(); }, // qa-sells: the team reopened the offer

    chatExtra: null,
    // area A (media)
    C: C, MODE: MODE, banner: banner, emit: emit, renderBar: renderBar, syncPulls: syncPulls, syncMedia: syncMedia,
    buildMedia: buildMedia, rebuildMedia: rebuildMedia, teardownMedia: teardownMedia, layoutFor: layoutFor,
    canPublishNow: canPublishNow, mediaError: mediaError,
    reconnectNow: function () { if (S.ws && S.ws.readyState <= 1) return; clearTimeout(S.wsTimer); S.wsTimer = null; if (!S.removed && !S.ended && !S.wsClosedByUs) connect(); },
    compositor: function () { return COMP; }, moqPlaying: function () { return Boolean(MQ.view && MQ.view.playing && !canPublishNow()); },
  };

  start();
})();

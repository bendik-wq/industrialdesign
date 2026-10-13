/* Webinar pages: registration, countdowns, the room (recording in sync / live stream / external live link),
 * attendance heartbeats, the offer button and replays. Server-checked: the room only plays when the
 * session is on, and the replay expires on the server too. */
(function () {
  'use strict';
  var cfg = (window.FUNNEL || {}).webinar || {};
  var F = window.funnel || { track: function () {} };
  var HLS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js';
  // Server clock (the browser's may be off by minutes).
  var skew = cfg.serverNow ? cfg.serverNow - Date.now() : 0;
  function now() { return Date.now() + skew; }
  function post(path, body) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .catch(function () { return {}; });
  }
  function fmt(ms) {
    if (ms <= 0) return 'Starting now';
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm ' + (d ? '' : (sec < 10 ? '0' : '') + sec + 's');
  }
  function countdown(el, to, done) {
    if (!el || !to) return;
    var t = setInterval(function () {
      var left = to - now();
      el.textContent = fmt(left);
      if (left <= 0) { clearInterval(t); if (done) done(); }
    }, 500);
    el.textContent = fmt(to - now());
  }
  function error(form, msg) {
    var box = form.querySelector('.form-error');
    if (!box) { box = document.createElement('p'); box.className = 'form-error'; box.setAttribute('role', 'alert'); form.prepend(box); }
    box.textContent = msg;
  }

  // ── Registration ──
  var reg = document.querySelector('[data-webinar-register]');
  if (reg) reg.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = reg.querySelector('button[type=submit]');
    var picked = reg.querySelector('input[name=session_id]:checked');
    var body = { first_name: reg.first_name.value.trim(), email: reg.email.value.trim(), session_id: picked ? picked.value : '', event_id: 'wr' + Date.now().toString(36) };
    var ts = document.querySelector('[name="cf-turnstile-response"]');
    if (ts) body.turnstile = ts.value;
    if (!body.first_name) return error(reg, 'Please enter your first name');
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(body.email)) return error(reg, 'Please enter a valid email address');
    btn.disabled = true;
    post('/api/webinar/register', body).then(function (r) {
      btn.disabled = false;
      if (r && r.next) { F.track('webinar_register_click', {}); location.href = r.next; }
      else error(reg, (r && r.error) || 'Something went wrong — please try again.');
    });
  });

  // ── Pick another time (expired / cancelled link) ──
  var move = document.querySelector('[data-webinar-move]');
  if (move) move.addEventListener('submit', function (e) {
    e.preventDefault();
    var picked = move.querySelector('input[name=session_id]:checked');
    if (!picked) return error(move, 'Pick a time');
    post(cfg.move || '/api/webinar/move', { token: cfg.token, session_id: picked.value }).then(function (r) {
      if (r && r.next) location.href = r.next; else error(move, (r && r.error) || 'Something went wrong — please try again.');
    });
  });

  // ── Registered page ──
  if (!cfg.token && cfg.startsAt) countdown(document.querySelector('[data-countdown]'), cfg.startsAt);

  // ── Room ──
  var room = document.querySelector('[data-room]');
  if (!room || !cfg.token) return;
  var $ = function (s) { return room.querySelector(s) || document.querySelector(s); };
  var waitEl = $('[data-wait]'), videoBox = $('[data-video]'), liveEl = $('[data-live]'), endedEl = $('[data-ended]'), ctaEl = $('[data-cta]');
  var started = false, video = null, beat = null;
  var until = document.querySelector('[data-replay-until]');
  if (until && cfg.replayUntil) until.textContent = new Date(cfg.replayUntil).toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  function show(el, on) { if (el) el.hidden = !on; }
  function elapsed() { return Math.max(0, (now() - cfg.startsAt) / 1000); }

  function maybeCta(pos) {
    if (ctaEl && ctaEl.hidden && pos >= cfg.pitchAtSec) {
      show(ctaEl, true);
      F.track('webinar_offer_shown', { at: Math.round(pos) });
    }
  }
  var apply = document.querySelector('[data-apply]');
  if (apply) apply.addEventListener('click', function (e) {
    e.preventDefault();
    post('/api/webinar/cta', { token: cfg.token }).then(function () { location.href = cfg.applyUrl; });
  });

  function heartbeat() {
    var pos = cfg.mode === 'stream' && !cfg.replay ? elapsed() : (video ? video.currentTime : elapsed());
    maybeCta(pos);
    if (video && video.paused) return;
    post('/api/webinar/hb', { token: cfg.token, pos: Math.round(pos), replay: Boolean(cfg.replay) }).then(function (r) {
      if (r && r.phase && r.phase !== 'running' && !cfg.replay) end();
    });
  }
  function end() {
    if (beat) clearInterval(beat);
    if (video) { video.pause(); }
    show(videoBox, false); show(liveEl, false); show(endedEl, true); show(ctaEl, true);
  }

  function attach(src, cb) {
    var isHls = /\.m3u8(\?|$)/.test(src);
    if (!isHls || video.canPlayType('application/vnd.apple.mpegurl')) { video.src = src; return cb(); }
    var s = document.createElement('script');
    s.src = HLS_SRC;
    s.onload = function () {
      if (window.Hls && window.Hls.isSupported()) {
        var hls = new window.Hls({ liveSyncDurationCount: 3 });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.ERROR, function (_, d) {
          // Live input not streaming yet: try again shortly.
          if (d && d.fatal && cfg.mode === 'stream' && !cfg.replay) { hls.destroy(); setTimeout(function () { attach(src, cb); }, 10000); waiting(true); }
        });
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () { waiting(false); });
      } else video.src = src;
      cb();
    };
    document.head.appendChild(s);
  }
  var note = null;
  function waiting(on) {
    if (!note) { note = document.createElement('p'); note.className = 'muted'; note.textContent = 'Waiting for the host to start the stream…'; videoBox.appendChild(note); }
    note.hidden = !on;
  }

  function soundButton() {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'btn room-sound'; b.textContent = '🔊 Click for sound';
    b.addEventListener('click', function () { video.muted = false; video.play().catch(function () {}); b.remove(); F.track('webinar_unmute', {}); });
    videoBox.appendChild(b);
  }

  function startVideo() {
    show(waitEl, false); show(videoBox, true);
    video = document.createElement('video');
    video.setAttribute('playsinline', ''); video.preload = 'auto';
    var synced = cfg.mode === 'evergreen' && !cfg.replay;
    if (cfg.replay) video.controls = true;
    video.muted = !cfg.replay; video.autoplay = true;
    videoBox.prepend(video);
    attach(cfg.video, function () {
      if (synced) {
        var jump = function () { var t = elapsed(); if (t >= cfg.durationSec) return end(); video.currentTime = t; };
        video.addEventListener('loadedmetadata', jump, { once: true });
        // Everyone watches the same moment: no skipping ahead or back.
        video.addEventListener('seeking', function () { if (Math.abs(video.currentTime - elapsed()) > 4) video.currentTime = elapsed(); });
        video.addEventListener('play', function () { if (Math.abs(video.currentTime - elapsed()) > 4) video.currentTime = elapsed(); });
        video.addEventListener('ended', end);
      }
      video.play().catch(function () {});
      if (!cfg.replay) soundButton();
      var fs = document.createElement('button');
      fs.type = 'button'; fs.className = 'btn btn-sm ghost room-fs'; fs.textContent = 'Full screen';
      fs.addEventListener('click', function () { (video.requestFullscreen || video.webkitEnterFullscreen || function () {}).call(video); });
      videoBox.appendChild(fs);
    });
    beat = setInterval(heartbeat, 15000);
    setTimeout(heartbeat, 3000);
  }

  function startLive() {
    show(waitEl, false); show(liveEl, true);
    var join = liveEl.querySelector('[data-join]');
    join.addEventListener('click', function (e) {
      e.preventDefault();
      post('/api/webinar/join', { token: cfg.token }).then(function (r) { if (r && r.url) location.href = r.url; });
    });
    maybeCta(elapsed());
    beat = setInterval(function () { maybeCta(elapsed()); }, 15000);
  }

  function start() {
    if (started) return;
    started = true;
    if (cfg.mode === 'live' && !cfg.replay) return startLive();
    if (!cfg.video) { show(waitEl, false); show(endedEl, true); endedEl.querySelector('p').textContent = 'The video for this session isn’t available yet. We’ll email you the replay.'; return; }
    startVideo();
  }

  if (cfg.replay) { start(); return; }
  if (cfg.mode === 'evergreen' && elapsed() >= cfg.durationSec) return end();
  // Live links open 10 minutes early so people can get in before the start.
  var opensAt = cfg.mode === 'live' ? cfg.startsAt - 10 * 60000 : cfg.startsAt;
  if (now() >= opensAt) start();
  else countdown(waitEl && waitEl.querySelector('[data-countdown]'), cfg.startsAt, start);
  if (cfg.mode === 'live' && now() < opensAt) setTimeout(function () { location.reload(); }, Math.min(opensAt - now() + 500, 2147483000));
})();

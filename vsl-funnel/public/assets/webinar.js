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

  document.querySelectorAll('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print(); }); });

  // ── "Starts in N minutes" on the next just-in-time showing; a fresh one once it has gone ──
  var jitEls = document.querySelectorAll('[data-starts-in]');
  if (jitEls.length) setInterval(function () {
    jitEls.forEach(function (el) {
      var mins = Math.round((Number(el.getAttribute('data-starts-in')) - Date.now()) / 60000);
      if (mins < -4) location.reload();
      else el.textContent = mins <= 0 ? 'Starting now' : 'Starts in ' + mins + ' minute' + (mins === 1 ? '' : 's');
    });
  }, 20000);

  // ── Registration ──
  var reg = document.querySelector('[data-webinar-register]');
  if (reg) reg.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = reg.querySelector('button[type=submit]');
    var picked = reg.querySelector('input[name=session_id]:checked');
    var body = { first_name: reg.first_name.value.trim(), email: reg.email.value.trim(), phone: reg.phone ? reg.phone.value.trim() : '', sms_consent: Boolean(reg.sms_consent && reg.sms_consent.checked), session_id: picked ? picked.value : '', event_id: 'wr' + Date.now().toString(36), pixel_eid: F.uid ? F.uid() : '' };
    var rev = reg.querySelector('input[name=revenue]:checked');
    body.revenue = rev ? rev.value : '';
    body.headline = (window.FUNNEL && window.FUNNEL.webinar && window.FUNNEL.webinar.headline) || '';
    var ts = document.querySelector('[name="cf-turnstile-response"]');
    if (ts) body.turnstile = ts.value;
    if (!body.first_name) return error(reg, 'Please enter your first name');
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(body.email)) return error(reg, 'Please enter a valid email address');
    if (!body.revenue) return error(reg, 'Please pick your business’s annual revenue');
    btn.disabled = true;
    post('/api/webinar/register', body).then(function (r) {
      btn.disabled = false;
      // Pixel copies of the server's CompleteRegistration and Lead, with the same event ids (Meta keeps one of each).
      if (r && r.next) { F.track('webinar_register_click', {}); if (F.pixel) F.pixel('CompleteRegistration', body.event_id); if (F.pixel) F.pixel('Lead', body.pixel_eid); location.href = F.xdUrl ? F.xdUrl(r.next) : r.next; }
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

  // ── Thank-you page: the one question, a mobile for texts, the "watch this first" clip ──
  if (cfg.ty) {
    document.querySelectorAll('[data-ty]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-ty]').forEach(function (x) { x.classList.toggle('picked', x === b); });
        post('/api/webinar/commit', { token: cfg.ty, target: b.getAttribute('data-ty') }).then(function () { var t = document.querySelector('[data-ty-thanks]'); if (t) t.hidden = false; });
      });
    });
    var pf = document.querySelector('[data-ty-phone]');
    if (pf) pf.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = pf.querySelector('button');
      btn.disabled = true;
      post('/api/webinar/phone', { token: cfg.ty, phone: pf.phone.value.trim() }).then(function (r) {
        btn.disabled = false;
        if (r && r.ok) pf.outerHTML = '<p class="small"><strong>Done.</strong> We’ll text you before it starts.</p>';
        else error(pf, (r && r.error) || 'Please check the number');
      });
    });
    document.querySelectorAll('video[data-hls]').forEach(function (v) {
      var src = v.getAttribute('data-hls'), loaded = false;
      var load = function () {
        if (loaded) return; loaded = true;
        if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = src; v.play().catch(function () {}); return; }
        var s = document.createElement('script'); s.src = HLS_SRC;
        s.onload = function () { if (window.Hls && window.Hls.isSupported()) { var h = new window.Hls(); h.loadSource(src); h.attachMedia(v); v.play().catch(function () {}); } };
        document.head.appendChild(s);
      };
      v.addEventListener('play', load); v.addEventListener('click', load);
    });
  }

  // ── Paid offer / paid seat: one click to Stripe Checkout (email filled in there), on the thank-you page and in the room ──
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-pass-buy]');
    if (b) {
      e.preventDefault();
      if (b.disabled) return;
      var label = b.textContent;
      b.disabled = true; b.textContent = 'Opening secure checkout…';
      F.track('cta_click', { id: 'webinar_checkout_' + (b.getAttribute('data-pass-buy') || 'offer') });
      post('/api/webinar/checkout', { token: cfg.token || cfg.ty, kind: b.getAttribute('data-pass-buy') || 'offer', from: cfg.token ? 'room' : 'ty' }).then(function (r) {
        if (r && r.url) { location.href = r.url; return; }
        if (r && r.next) { location.href = r.next; return; }
        b.disabled = false; b.textContent = label;
        var p = b.parentNode.querySelector('.pass-err') || document.createElement('p');
        p.className = 'pass-note pass-err'; p.setAttribute('role', 'alert'); p.textContent = (r && r.error) || 'Payment couldn’t be started just now. Please try again in a minute.';
        // Checkout couldn't open (for example Whop refused it): the way to book a call instead.
        if (r && r.book) { var a = document.createElement('a'); a.href = r.book; a.textContent = 'Book a call'; p.appendChild(document.createTextNode(' ')); p.appendChild(a); }
        b.parentNode.insertBefore(p, b.nextSibling);
      });
      return;
    }
    var rv = e.target.closest && e.target.closest('[data-pass-review]');
    if (rv) post('/api/webinar/pass/review', { token: cfg.token || cfg.ty });
  });
  // The First Deal Sprint page: a kickoff booked in the inline calendar marks the kickoff as booked.
  var kick = document.querySelector('[data-kickoff-cal]');
  var kickToken = kick && kick.closest('[data-kickoff]') && kick.closest('[data-kickoff]').getAttribute('data-kickoff');
  if (kick && kickToken) {
    window.addEventListener('message', function (e) {
      var d = e.data || {};
      try { if (!/(^|\.)calendly\.com$/.test(new URL(e.origin).hostname)) return; } catch (err) { return; }
      if (d.event !== 'calendly.event_scheduled') return;
      F.track('cta_click', { id: 'deal_sprint_kickoff_booked' });
      post('/api/webinar/sprint/kickoff', { token: kickToken });
    });
  }
  // Back from Stripe before the payment has confirmed: look again shortly (the server asks Stripe each time).
  if (cfg.passConfirming) {
    var tries = 0;
    try { tries = Number(sessionStorage.getItem('pass_wait') || 0); sessionStorage.setItem('pass_wait', String(tries + 1)); } catch (err) { /* private mode */ }
    if (tries < 6) setTimeout(function () { location.reload(); }, 4000);
  }

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
  // Shared with webinar-room.js (polls, agenda, calculator): where the masterclass is now, and seeking in the replay.
  window.WEBINAR_POS = function () { return cfg.mode === 'stream' && !cfg.replay ? elapsed() : (video ? video.currentTime : (started ? elapsed() : 0)); };
  window.WEBINAR_SEEK = function (sec) { if (cfg.replay && video) { video.currentTime = sec; video.play().catch(function () {}); } };
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
    b.type = 'button'; b.className = 'btn room-sound'; b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>Turn the sound on';
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

  // Live on Zoom: the "Join on Zoom" card (live-player.js) with the start time, a real countdown and the link once it opens.
  function startLink() {
    show(waitEl, false); show(liveEl, true);
    window.LivePlayer.mount(liveEl, {
      key: cfg.livePlayback.key, playback: cfg.livePlayback.playback, serverNow: cfg.serverNow,
      onJoin: function () {
        F.track('cta_click', { id: 'webinar_join_zoom' });
        try { fetch('/api/webinar/join', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: cfg.token }) }); } catch (e) { /* attendance only */ }
      },
    });
    maybeCta(elapsed());
    beat = setInterval(function () { maybeCta(elapsed()); }, 15000);
  }

  function start() {
    if (started) return;
    started = true;
    if (cfg.livePlayback && !cfg.replay && window.LivePlayer) return startLink();
    if (cfg.mode === 'live' && !cfg.replay) return startLive();
    if (!cfg.video) { show(waitEl, false); show(endedEl, true); endedEl.querySelector('p').textContent = 'The video for this session isn’t available yet. We’ll email you the replay.'; return; }
    startVideo();
  }

  if (cfg.replay) { start(); return; }
  if (cfg.livePlayback && window.LivePlayer) { start(); return; }
  if (cfg.mode === 'evergreen' && elapsed() >= cfg.durationSec) return end();
  // Live links open 10 minutes early so people can get in before the start.
  var opensAt = cfg.mode === 'live' ? cfg.startsAt - 10 * 60000 : cfg.startsAt;
  if (now() >= opensAt) start();
  else countdown(waitEl && waitEl.querySelector('[data-countdown]'), cfg.startsAt, start);
  if (cfg.mode === 'live' && now() < opensAt) setTimeout(function () { location.reload(); }, Math.min(opensAt - now() + 500, 2147483000));
})();

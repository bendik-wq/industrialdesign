/* VSL player.
 * - Muted autoplay with a "click to listen" overlay that restarts from 0 with sound
 * - No scrubbing; progress bar runs fast early so the video feels short
 * - Resume where you left off (same view id, so retention stays honest)
 * - CTA + gated content revealed at the pitch timestamp, remembered per visitor
 * - Heartbeats with a 100-bucket watched bitmap → server builds the retention curve */
(function () {
  'use strict';
  var F = window.funnel;
  var cfg = (window.FUNNEL || {}).video;
  var root = document.querySelector('[data-vsl]');
  if (!root || !cfg) return;

  var HLS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js';
  var BEAT_MS = 10000;
  var KEY = 'vsl_' + cfg.id;
  var body = document.body;

  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }

  function reveal(fromVideo) {
    if (body.classList.contains('revealed')) return;
    body.classList.add('revealed');
    store(KEY + '_rev', 1);
    if (fromVideo) state.revealed = true;
    var primary = document.querySelector('.cta-zone .btn');
    var sticky = document.querySelector('[data-sticky-cta]');
    if (primary && sticky && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        sticky.classList.toggle('on', !entries[0].isIntersecting && entries[0].boundingClientRect.top < 0);
      }).observe(primary);
    }
  }

  var gateNote = document.querySelector('[data-gate-note]');
  if (gateNote && !cfg.gateContent) gateNote.classList.add('hidden');

  // No video connected yet: show a placeholder and unlock everything.
  if (!cfg.src) {
    root.innerHTML = '<div class="vsl-placeholder"><div><strong>Your VSL goes here</strong>Connect a video in the dashboard → Integrations → Video.</div></div>';
    reveal(false);
    return;
  }
  if (store(KEY + '_rev') || cfg.ctaRevealAt <= 0) reveal(false);

  var saved = store(KEY + '_state') || {};
  var state = {
    view: saved.view || F.uid(),
    buckets: (saved.buckets && saved.buckets.length === 100) ? saved.buckets.split('') : new Array(101).join('0').split(''),
    watched: 0,
    lastT: 0,
    unmuted: false,
    revealed: body.classList.contains('revealed'),
    cta: false,
    ended: false
  };

  var video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.preload = 'metadata';
  video.disablePictureInPicture = true;
  video.setAttribute('controlslist', 'nodownload noplaybackrate');
  if (cfg.poster) video.poster = cfg.poster;
  root.appendChild(video);

  var bar = el('div', 'vsl-bar', '<i></i>');
  var stateTag = el('div', 'vsl-state', 'Paused — click to resume');
  var clickLayer = el('div', 'vsl-click');
  root.appendChild(clickLayer);
  root.appendChild(bar);
  root.appendChild(stateTag);
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Video');
  root.tabIndex = 0;

  function el(tag, cls, html) { var e = document.createElement(tag); e.className = cls; if (html) e.innerHTML = html; return e; }

  function loadSource() {
    var isHls = /\.m3u8(\?|$)/.test(cfg.src);
    if (!isHls || video.canPlayType('application/vnd.apple.mpegurl')) { video.src = cfg.src; return Promise.resolve(); }
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = HLS_SRC;
      s.onload = function () {
        if (window.Hls && window.Hls.isSupported()) {
          var hls = new window.Hls({ capLevelToPlayerSize: true, startLevel: -1 });
          hls.loadSource(cfg.src);
          hls.attachMedia(video);
        } else {
          video.src = cfg.src;
        }
        resolve();
      };
      s.onerror = function () { video.src = cfg.src; resolve(); };
      document.head.appendChild(s);
    });
  }

  // Fast-start progress: 25% of the runtime shows as ~44% of the bar.
  function displayProgress(p) { return 1 - Math.pow(1 - p, 2); }

  function onTime() {
    var d = video.duration;
    if (!d || !isFinite(d)) return;
    var t = video.currentTime;
    if (!video.paused && !video.muted) {
      var delta = t - state.lastT;
      if (delta > 0 && delta < 2) state.watched += delta;
      state.buckets[Math.min(99, Math.floor((t / d) * 100))] = '1';
    }
    state.lastT = t;
    bar.firstChild.style.width = (displayProgress(t / d) * 100).toFixed(2) + '%';
    if (!state.revealed && t >= cfg.ctaRevealAt) { state.revealed = true; reveal(true); beat(false); }
    if (Math.floor(t) % 5 === 0) store(KEY + '_state', { view: state.view, pos: t, buckets: state.buckets.join('') });
  }

  // Only count playback with sound (or after the viewer chose to unmute) toward the watched bitmap,
  // so silent autoplay doesn't inflate retention.
  function beat(useBeacon) {
    var d = video.duration;
    if (!d || !isFinite(d) || (!state.unmuted && !state.cta && !state.revealed)) return;
    var payload = {
      view: state.view,
      video: cfg.id,
      pos: video.currentTime,
      dur: d,
      buckets: state.buckets.join(''),
      watched: Math.min(30, state.watched),
      unmuted: state.unmuted,
      revealed: state.revealed,
      cta: state.cta,
      ended: state.ended,
      path: location.pathname
    };
    state.watched = 0;
    F.send('/api/v', payload, useBeacon);
  }

  var timer = null;
  function startBeats() { if (!timer) timer = setInterval(function () { if (!video.paused) beat(false); }, BEAT_MS); }

  function playWithSound(fromStart) {
    if (fromStart) video.currentTime = 0;
    video.muted = false;
    state.unmuted = true;
    var overlay = root.querySelector('.vsl-sound, .vsl-play, .vsl-resume');
    if (overlay) overlay.remove();
    var p = video.play();
    if (p && p.catch) p.catch(function () { showPlayButton(); });
    startBeats();
    beat(false);
  }

  function showSoundOverlay() {
    var b = el('button', 'vsl-sound', '<div class="vsl-sound-box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M23 9l-6 6M17 9l6 6"/></svg><strong></strong><span></span></div>');
    b.querySelector('strong').textContent = cfg.soundPrompt || 'Your video has started';
    b.querySelector('span').textContent = cfg.soundAction || 'Click to listen';
    b.type = 'button';
    b.setAttribute('aria-label', 'Play the video with sound');
    b.addEventListener('click', function () { playWithSound(true); });
    root.appendChild(b);
  }

  function showPlayButton() {
    if (root.querySelector('.vsl-play')) return;
    var b = el('button', 'vsl-play', '<span class="vsl-play-btn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg></span>');
    b.type = 'button';
    b.setAttribute('aria-label', 'Play video');
    b.addEventListener('click', function () { playWithSound(false); });
    root.appendChild(b);
  }

  function showResume(pos) {
    var mins = Math.floor(pos / 60), secs = Math.floor(pos % 60);
    var box = el('div', 'vsl-resume', '<div><p>You’ve already started watching this video.</p><div class="row"><button type="button" class="btn" data-a="resume">Continue (' + mins + ':' + (secs < 10 ? '0' : '') + secs + ')</button><button type="button" class="ghost" data-a="restart">Start over</button></div></div>');
    box.addEventListener('click', function (e) {
      var a = e.target.closest('[data-a]');
      if (!a) return;
      if (a.getAttribute('data-a') === 'resume') { video.currentTime = pos; playWithSound(false); } else { playWithSound(true); }
    });
    root.appendChild(box);
  }

  clickLayer.addEventListener('click', togglePlay);
  root.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); } });
  function togglePlay() {
    if (video.muted) { playWithSound(true); return; }
    if (video.paused) { video.play(); } else { video.pause(); }
  }

  // Never trap a visitor behind a video that won't load: unlock the page and offer a retry.
  video.addEventListener('error', function () {
    reveal(false);
    if (root.querySelector('.vsl-placeholder')) return;
    var box = el('div', 'vsl-placeholder', '<div><strong>The video didn’t load</strong>Check your connection, then <button type="button" class="ghost" style="margin-top:10px">Try again</button></div>');
    box.querySelector('button').onclick = function () { location.reload(); };
    root.appendChild(box);
  });
  video.addEventListener('timeupdate', onTime);
  video.addEventListener('pause', function () { root.classList.add('paused'); beat(false); });
  video.addEventListener('play', function () { root.classList.remove('paused'); });
  video.addEventListener('ended', function () { state.ended = true; reveal(true); beat(false); store(KEY + '_state', { view: F.uid(), pos: 0, buckets: '' }); });
  addEventListener('pagehide', function () { beat(true); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') beat(true); });

  // Mark CTA clicks on the view so we can see who clicked from which moment of the video.
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-track="cta_click"]')) { state.cta = true; beat(true); }
  }, true);

  loadSource().then(function () {
    var resumeAt = saved.pos || 0;
    video.addEventListener('loadedmetadata', function onMeta() {
      video.removeEventListener('loadedmetadata', onMeta);
      if (resumeAt > 20 && resumeAt < video.duration - 15) { showResume(resumeAt); return; }
      if (!cfg.autoplayMuted) { showPlayButton(); return; }
      video.muted = true;
      var p = video.play();
      if (p && p.then) p.then(showSoundOverlay).catch(showPlayButton); else showSoundOverlay();
    });
  });
})();

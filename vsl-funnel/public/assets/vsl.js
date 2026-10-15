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

  // Locked CTA: the button under the video unlocks at the reveal point (60% of the main VSL).
  var lockBtn = cfg.lockCta && cfg.ctaRevealAt > 0 ? document.querySelector('.cta-zone .btn-mega') : null;
  var lockSub = lockBtn && lockBtn.querySelector('.btn-mega-sub');
  var lockSubText = lockSub ? lockSub.textContent : '';
  var lockNote = null;
  // Everything else that leads to the application: the nav button, the sticky bar, and the form itself.
  var lockLinks = lockBtn ? [].slice.call(document.querySelectorAll('a[href="#apply"], a[href="/#apply"]')).filter(function (a) { return a !== lockBtn; }) : [];
  // Someone who already started the application (resume) is never locked out of it.
  var lockForm = lockBtn && !(window.FUNNEL || {}).resume ? document.querySelector('#apply .form-card') : null;
  var lockPanel = null;
  function mmss(s) { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60); }
  function lockProgress(t) {
    if (!lockBtn || !lockBtn.classList.contains('locked')) return;
    lockBtn.style.setProperty('--unlock', Math.min(1, t / cfg.ctaRevealAt).toFixed(3));
    if (lockSub) lockSub.textContent = t > 1 ? 'Unlocks in ' + mmss(cfg.ctaRevealAt - t) + ' · keep watching' : 'Unlocks as you watch the video';
    if (lockNote) lockNote.textContent = lockMessage(t);
    if (lockPanel) {
      lockPanel.querySelector('.app-lock-bar i').style.width = (Math.min(1, t / cfg.ctaRevealAt) * 100).toFixed(1) + '%';
      lockPanel.querySelector('.app-lock-left').textContent = t > 1 ? mmss(cfg.ctaRevealAt - t) + ' to go' : 'Press play on the video to start';
    }
  }
  function lockMessage(t) {
    return 'Watch to ' + mmss(cfg.ctaRevealAt) + ' to unlock your application: that’s where Josh walks through the deal. ' + (t > 1 ? mmss(cfg.ctaRevealAt - t) + ' to go.' : 'Press play above.');
  }
  function lock() {
    if (!lockBtn) return;
    lockBtn.classList.add('locked');
    lockBtn.setAttribute('aria-disabled', 'true');
    lockBtn.insertAdjacentHTML('afterbegin', '<span class="lock-fill" aria-hidden="true"></span><svg class="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>');
    // Capture phase: stop the jump to the form and the cta_click, explain instead.
    function onLockedClick(e) {
      if (!lockBtn.classList.contains('locked')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      var t = (typeof video !== 'undefined' && video && video.currentTime) || 0;
      F.track('cta_locked_click', { at: Math.round(t), unlock_at: cfg.ctaRevealAt, from: (e.currentTarget.getAttribute('data-track-id') || 'link') });
      if (!lockNote) { lockNote = el('p', 'lock-note'); lockBtn.parentNode.insertBefore(lockNote, lockBtn.nextSibling); }
      lockNote.textContent = lockMessage(t);
      lockBtn.classList.remove('nudge'); void lockBtn.offsetWidth; lockBtn.classList.add('nudge');
      root.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    lockBtn.addEventListener('click', onLockedClick, true);
    lockLinks.forEach(function (a) {
      a.classList.add('locked-link');
      a.setAttribute('aria-disabled', 'true');
      a.setAttribute('title', 'Unlocks at ' + mmss(cfg.ctaRevealAt) + ' of the video');
      a.addEventListener('click', onLockedClick, true);
    });
    if (lockForm) {
      lockForm.classList.add('locked');
      [].forEach.call(lockForm.children, function (c) { c.setAttribute('inert', ''); c.setAttribute('aria-hidden', 'true'); });
      lockPanel = el('div', 'app-lock', '<div class="app-lock-box"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>' +
        '<strong>The application unlocks at ' + mmss(cfg.ctaRevealAt) + ' of the video</strong><p>That’s where Josh walks through how the deal is funded. Watch to there and the questions open up here.</p>' +
        '<div class="app-lock-bar" aria-hidden="true"><i></i></div><span class="app-lock-left"></span><button type="button" class="btn btn-sm">Watch the video</button></div>');
      lockPanel.querySelector('button').addEventListener('click', function () {
        F.track('cta_locked_click', { at: Math.round((typeof video !== 'undefined' && video && video.currentTime) || 0), unlock_at: cfg.ctaRevealAt, from: 'form' });
        root.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      lockForm.appendChild(lockPanel);
    }
    lockProgress(0);
  }
  function unlock() {
    if (!lockBtn || !lockBtn.classList.contains('locked')) return;
    lockBtn.classList.remove('locked');
    lockBtn.classList.add('unlocked');
    lockBtn.removeAttribute('aria-disabled');
    if (lockSub) lockSub.textContent = lockSubText;
    if (lockNote) { lockNote.remove(); lockNote = null; }
    lockLinks.forEach(function (a) { a.classList.remove('locked-link'); a.removeAttribute('aria-disabled'); a.removeAttribute('title'); });
    if (lockForm && lockPanel) {
      lockPanel.remove(); lockPanel = null;
      lockForm.classList.remove('locked');
      [].forEach.call(lockForm.children, function (c) { c.removeAttribute('inert'); c.removeAttribute('aria-hidden'); });
    }
  }

  function reveal(fromVideo) {
    unlock();
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
    // Poster frame until a video is connected (dashboard → Integrations → Video).
    root.innerHTML = '<div class="vsl-placeholder"><div class="vsl-poster"><span class="vsl-play-btn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg></span><strong>' +
      (cfg.posterTitle || 'The acquisition playbook') + '</strong><span class="vsl-soon">Video coming soon</span></div></div>';
    reveal(false);
    return;
  }
  if (store(KEY + '_rev') || cfg.ctaRevealAt <= 0) reveal(false);
  else lock();

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
    // Browsers without H.264 (some Linux/Firefox builds) get the WebM copy.
    if (cfg.srcWebm && /\.mp4(\?|$)/.test(cfg.src) && !video.canPlayType('video/mp4; codecs="avc1.42E01E"') && video.canPlayType('video/webm; codecs="vp9, opus"')) {
      video.src = cfg.srcWebm;
      return Promise.resolve();
    }
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
          // A browser that can't play the stream must never be stuck behind the locked button.
          hls.on(window.Hls.Events.ERROR, function (_e, d) { if (d && d.fatal) reveal(false); });
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
    if (!state.revealed) lockProgress(t);
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
  // Behaviour signals for personalised follow-up: what they rewatched, skipped and paused on.
  var seekFrom = 0, signals = 0;
  function signal(name, props) { if (signals++ < 40) F.track(name, Object.assign({ video: cfg.id }, props)); }
  video.addEventListener('seeking', function () {
    var to = video.currentTime, from = seekFrom;
    if (to < from - 3) signal('vsl_rewatch', { from: Math.round(from), to: Math.round(to) });
    else if (to > from + 3) signal('vsl_skip', { from: Math.round(from), to: Math.round(to) });
  });
  video.addEventListener('timeupdate', function () { if (!video.seeking) seekFrom = video.currentTime; });
  var lastVol = -1;
  video.addEventListener('volumechange', function () { var v = Math.round(video.volume * 10) / 10; if (!video.muted && v !== lastVol && lastVol >= 0) signal('vsl_volume', { level: v, at: Math.round(video.currentTime) }); lastVol = v; });
  document.addEventListener('fullscreenchange', function () { if (document.fullscreenElement) signal('vsl_fullscreen', { at: Math.round(video.currentTime) }); });
  video.addEventListener('ratechange', function () { if (video.playbackRate !== 1) signal('vsl_speed', { rate: video.playbackRate }); });
  video.addEventListener('pause', function () { if (!state.ended && video.currentTime > 2 && !video.seeking) signal('vsl_pause', { at: Math.round(video.currentTime) }); });
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

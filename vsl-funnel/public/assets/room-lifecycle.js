/* The waiting room (builder E "lifecycle", src/rooms/lifecycle.ts). Runs on top of room.js through window.RoomCore:
   in a webinar's lobby it adds the pre-show loop (slides, or a video from this site), a sound check, "say where
   you're from" (real attendees in this room only, from the server) and the early points (the server checks the
   clock). Staff get the questions people sent before the session, with "Add to Q&A". Every number comes from
   the server; nothing here invents presence or counts. */
(function () {
  'use strict';
  var core = window.RoomCore;
  if (!core || !core.cfg || !core.cfg.lc || core.cfg.room.mode !== 'webinar') return;
  var L = core.cfg.lc, C = L.copy, staff = core.isStaff;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // room.js shows server errors through its copy's error map: add this add-on's one.
  core.cfg.copy.errors = core.cfg.copy.errors || {};
  core.cfg.copy.errors.lc_place = C.placeError;
  core.cfg.copy.errors.lc_wait = C.placeWait;
  var st = { status: null, from: [], fromN: 0, asked: false, earlySent: 0, slide: 0, timer: 0, added: {} };

  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function inWindow() { var t = core.now(); return L.startsAt && t >= L.startsAt - L.waitingMs && t < L.startsAt; }

  core.on(function (m) {
    if (m.t === 'state') onState(m);
    else if (m.t === 'lc_from') { st.from = m.list || []; st.fromN = m.n || 0; renderFrom(); }
  });

  function onState(v) {
    st.status = v.room.status;
    if (staff) { preqButton(); return; }
    if (st.status !== 'lobby') { stopLoop(); var p = $('[data-lc-wait]'); if (p) p.remove(); return; }
    ensurePanel();
    if (!st.asked) { st.asked = true; core.send({ t: 'lc_from_get' }); }
    // Early points: the server decides (its clock, the room still in the lobby, before the start); once a minute at most.
    if (inWindow() && Date.now() - st.earlySent > 60000) { st.earlySent = Date.now(); core.send({ t: 'lc_early' }); }
  }

  // ───────────── the attendee's waiting room ─────────────
  function ensurePanel() {
    var lobby = $('[data-lobby]');
    if (!lobby || $('[data-lc-wait]', lobby)) { renderNote(); return; }
    var slides = L.slides || [];
    var loop = L.video
      ? '<div class="lcw-video"><video src="' + esc(L.video) + '" muted autoplay loop playsinline controls preload="metadata" aria-label="' + esc(C.preshowHeading) + '"></video></div>'
      : (slides.length ? '<div class="lcw-slides" data-lc-slides aria-roledescription="carousel" aria-label="' + esc(C.preshowHeading) + '">' + slides.map(function (s, i) {
        return '<div class="lcw-slide' + (i === 0 ? ' is-on' : '') + '" data-lc-slide="' + i + '" role="group" aria-roledescription="slide" aria-label="' + (i + 1) + ' / ' + slides.length + '"' + (i === 0 ? '' : ' hidden') + '><p class="lcw-sh">' + esc(s.title) + '</p><p class="lcw-sb">' + esc(s.body) + '</p></div>';
      }).join('') + (slides.length > 1 ? '<div class="lcw-dots"><button type="button" class="lcw-next" data-lc-next>' + esc(C.preshowNext) + '</button></div>' : '') + '</div>' : '');
    var wrap = document.createElement('div');
    wrap.className = 'lcw';
    wrap.setAttribute('data-lc-wait', '');
    wrap.innerHTML =
      '<p class="lcw-note" data-lc-note></p>' +
      (loop ? '<section class="lcw-card"><p class="lcw-h">' + esc(C.preshowHeading) + '</p>' + loop + '</section>' : '') +
      '<section class="lcw-card"><p class="lcw-h">' + esc(C.soundHeading) + '</p><p class="lcw-p">' + esc(C.soundBody) + '</p>' +
        '<button type="button" class="lcw-btn" data-lc-tone>' + esc(C.soundButton) + '</button>' +
        '<div class="lcw-ask" data-lc-ask hidden><span>' + esc(C.soundAsk) + '</span> <button type="button" class="lcw-btn lcw-sm" data-lc-yes>' + esc(C.soundYes) + '</button> <button type="button" class="lcw-btn lcw-sm" data-lc-no>' + esc(C.soundNo) + '</button></div>' +
        '<p class="lcw-p" data-lc-sound-msg role="status" hidden></p></section>' +
      '<section class="lcw-card"><p class="lcw-h">' + esc(C.fromHeading) + '</p>' +
        '<form class="lcw-from" data-lc-from><label class="lcw-sr" for="lcw-place">' + esc(C.fromHeading) + '</label><input id="lcw-place" name="place" maxlength="40" autocomplete="address-level2" placeholder="' + esc(C.fromPlaceholder) + '"><button type="submit" class="lcw-btn">' + esc(C.fromButton) + '</button></form>' +
        '<p class="lcw-p lcw-muted" data-lc-from-n aria-live="polite"></p><ul class="lcw-list" data-lc-from-list></ul></section>';
    lobby.appendChild(wrap);
    renderNote(); renderFrom(); startLoop();
    $('[data-lc-tone]', wrap).onclick = tone;
    $('[data-lc-yes]', wrap).onclick = function () { soundMsg(C.soundOk); };
    $('[data-lc-no]', wrap).onclick = function () { soundMsg(C.soundTips); };
    var nx = $('[data-lc-next]', wrap); if (nx) nx.onclick = function () { show(st.slide + 1); };
    $('[data-lc-from]', wrap).onsubmit = function (e) {
      e.preventDefault();
      var i = this.place, v = (i.value || '').trim();
      if (v.length < 2) { i.focus(); return; }
      core.send({ t: 'lc_from', place: v }); i.value = ''; i.blur();
    };
  }
  function renderNote() {
    var n = $('[data-lc-note]'); if (!n) return;
    var t = core.now();
    n.textContent = L.startsAt && t < L.startsAt - L.waitingMs ? C.notYet : (inWindow() && C.earlyNote ? C.earlyNote : '');
    n.hidden = !n.textContent;
  }
  function renderFrom() {
    var list = $('[data-lc-from-list]'), n = $('[data-lc-from-n]');
    if (!list) return;
    list.innerHTML = st.from.slice().reverse().map(function (f) { return '<li><strong>' + esc(f.name) + '</strong> ' + esc(f.place) + '</li>'; }).join('');
    n.textContent = !st.fromN ? C.fromEmpty : st.fromN === 1 ? C.fromCount : C.fromCountMany.replace('{n}', st.fromN);
  }
  function show(i) {
    var all = document.querySelectorAll('[data-lc-slide]'); if (!all.length) return;
    st.slide = (i + all.length) % all.length;
    Array.prototype.forEach.call(all, function (el, k) { var on = k === st.slide; el.hidden = !on; el.classList.toggle('is-on', on); });
  }
  function startLoop() { if (reduce || L.video || st.timer) return; st.timer = setInterval(function () { if (!document.hidden) show(st.slide + 1); }, 8000); }
  function stopLoop() { if (st.timer) clearInterval(st.timer); st.timer = 0; }

  var actx = null;
  function tone() {
    try {
      core.unlockAudio();
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = 523.25;
      g.gain.setValueAtTime(0.0001, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.25, actx.currentTime + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 1.1);
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 1.15);
    } catch (e) { /* no audio context */ }
    var a = $('[data-lc-ask]'); if (a) a.hidden = false;
  }
  function soundMsg(t) { var m = $('[data-lc-sound-msg]'); if (m) { m.hidden = false; m.textContent = t; } var a = $('[data-lc-ask]'); if (a) a.hidden = true; }
  setInterval(renderNote, 15000);

  // ───────────── staff: questions sent before the session ─────────────
  function preqButton() {
    if (!L.preq || !L.preq.length || $('[data-lc-preq-btn]')) return;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'lcw-preqbtn'; b.setAttribute('data-lc-preq-btn', '');
    b.textContent = C.preqOpen.replace('{n}', L.preq.length);
    b.onclick = openPreq;
    document.body.appendChild(b);
  }
  function openPreq() {
    var d = document.createElement('div');
    d.className = 'lcw-dialog'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'lcw-preq-h');
    d.innerHTML = '<div class="lcw-dialog-in"><h2 id="lcw-preq-h" class="lcw-h">' + esc(C.preqHeading) + '</h2><ol class="lcw-preq">' +
      (L.preq.length ? L.preq.map(function (q, i) { return '<li><p><strong>' + esc(q.name) + '</strong> ' + esc(q.text) + '</p><button type="button" class="lcw-btn lcw-sm" data-lc-add="' + i + '"' + (st.added[q.id] ? ' disabled' : '') + '>' + esc(st.added[q.id] ? C.preqAdded : C.preqAdd) + '</button></li>'; }).join('') : '<li>' + esc(C.preqNone) + '</li>') +
      '</ol><button type="button" class="lcw-btn" data-lc-close>' + esc(C.close) + '</button></div>';
    document.body.appendChild(d);
    var close = function () { d.remove(); document.removeEventListener('keydown', key); var b = $('[data-lc-preq-btn]'); if (b) b.focus(); };
    var key = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    $('[data-lc-close]', d).onclick = close;
    d.addEventListener('click', function (e) { if (e.target === d) close(); });
    Array.prototype.forEach.call(d.querySelectorAll('[data-lc-add]'), function (btn) {
      btn.onclick = function () {
        var q = L.preq[Number(btn.getAttribute('data-lc-add'))];
        core.send({ t: 'lc_preq', key: q.id, name: q.name, text: q.text });
        st.added[q.id] = true; btn.disabled = true; btn.textContent = C.preqAdded; core.toast(C.preqAdded);
      };
    });
    var first = d.querySelector('button'); if (first) first.focus();
  }
})();

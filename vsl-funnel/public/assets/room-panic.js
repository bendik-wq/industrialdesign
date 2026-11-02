/* The panic button in the live room (src/rooms/panic.ts). Staff who may use it get a Rescue tab: move everyone to a
 * fresh room, or show everyone the event's Zoom link; each asks for a confirm first. Everyone: when the room moves,
 * a calm note and the browser goes to the new room with its own fresh pass (the host to the new host room); when
 * the Zoom card is up, a card with the link while chat and the offer stay here. Uses window.RoomCore (room.js). */
(function () {
  'use strict';
  var R = window.RoomCore;
  if (!R || !R.CFG || !R.CFG.panic) return;
  var P = R.CFG.panic, T = P.copy || {};
  var UI = { confirm: null, busy: false, msg: '', cohost: Boolean(P.cohost) };
  var ZOOM = null, MOVED = false;

  function esc(s) { return R.esc(s == null ? '' : String(s)); }
  function errText(e, wait) { var t = (T.errors && T.errors[e]) || T.errors.failed; return t.replace('{a}', String(wait || 0)); }

  var css = document.createElement('style');
  css.textContent = [
    '.pn-veil{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:16px;background:#fff}',
    '.pn-veil-in{max-width:420px;text-align:center;display:grid;gap:16px}',
    '.pn-veil-in p{margin:0;font-size:17px;line-height:1.45;color:#1d1d1f}',
    '.pn-spin{width:28px;height:28px;margin:0 auto;border-radius:50%;border:2px solid rgba(15,44,92,.15);border-top-color:#0f2c5c;animation:pn-spin .9s linear infinite}',
    '@media (prefers-reduced-motion:reduce){.pn-spin{animation:none}}',
    '@keyframes pn-spin{to{transform:rotate(360deg)}}',
    '.pn-zoom{margin:0 0 8px;padding:16px;background:#f5f5f7;border-radius:12px;display:grid;gap:8px}',
    '.pn-zoom h2{margin:0;font:500 19px/1.25 var(--serif,Georgia,serif)}',
    '.pn-zoom p{margin:0;font-size:14px;line-height:1.45}',
    '.pn-zoom a,.pn-veil a{justify-self:start;text-decoration:none}',
    '.pn-sec{padding:16px 0;border-top:1px solid rgba(0,0,0,.08);display:grid;gap:8px}',
    '.pn-sec h3{margin:0;font-size:15px}',
    '.pn-sec p{margin:0;font-size:13.5px;line-height:1.45;color:#3a3a3c}',
    '.pn-ask{padding:12px;border-radius:10px;background:#f5f5f7;display:grid;gap:8px}',
    '.pn-row{display:flex;gap:8px;flex-wrap:wrap}',
    '.pn-msg{font-size:13px;color:#0f2c5c;min-height:1em}',
    '.pn-co{display:flex;gap:8px;align-items:center;font-size:13px}',
  ].join('\n');
  document.head.appendChild(css);

  // ───────────── everyone: moved, the Zoom card ─────────────
  function veil(text, url, auto) {
    var v = document.querySelector('.pn-veil');
    if (!v) { v = R.h('div', { class: 'pn-veil', role: 'status', 'aria-live': 'assertive' }); document.body.appendChild(v); }
    v.innerHTML = '<div class="pn-veil-in">' + (auto ? '<div class="pn-spin" aria-hidden="true"></div>' : '') + '<p>' + esc(text) + '</p>' +
      '<p><a class="rm-primary" href="' + esc(url) + '" data-pn-go>' + esc(T.openNew) + '</a></p></div>';
  }
  function moved(m) {
    if (MOVED || !m || typeof m.url !== 'string') return;
    MOVED = true;
    var S = R.S;
    S.wsClosedByUs = true;
    try { if (S.ws) S.ws.close(1000, 'moved'); } catch (e) { /* closed */ }
    // The host's recording runs in this page: leaving would cut it, so the host goes when ready.
    if (m.host && S.rec) { veil(T.movedHostRec, m.url, false); return; }
    try { R.teardownMedia(); } catch (e) { /* nothing to tear down */ }
    veil(m.text || T.movedNotice, m.url, true);
    setTimeout(function () { location.replace(m.url); }, 1400);
  }
  function zoomCard() {
    var side = document.querySelector('.rm-side');
    var el = document.querySelector('[data-pn-zoom]');
    if (!ZOOM) { if (el) el.remove(); return; }
    if (!side) return;
    if (!el) { el = R.h('aside', { class: 'pn-zoom', 'data-pn-zoom': '', 'aria-label': T.zoomCardHeading }); side.insertBefore(el, side.firstChild); }
    el.innerHTML = '<h2>' + esc(T.zoomCardHeading) + '</h2><p>' + esc(T.zoomCardBody) + '</p><a class="rm-primary" href="' + esc(ZOOM) + '" target="_blank" rel="noopener">' + esc(T.zoomJoin) + '</a>';
  }
  R.on('panic_moved', moved);
  R.on('panic_zoom', function (m) {
    var was = ZOOM;
    ZOOM = m && typeof m.url === 'string' ? m.url : null;
    zoomCard();
    if (ZOOM && !was && !P.can) R.toast(T.zoomCardHeading); // seen even with the offer sheet open over the side column
    if (P.can) redraw();
  });
  // The side column is redrawn with the room: put the card back when it goes.
  R.on('state', function () { if (ZOOM && !document.querySelector('[data-pn-zoom]')) zoomCard(); });
  // Arrived from a moved room: say so on the entry screen too (the room asks for one tap to start sound).
  if (P.movedFrom && /[?&]mv=/.test(location.search)) {
    var noteEntry = function () { var e = document.querySelector('.rm-entry .rm-lede'); if (e && !document.querySelector('[data-pn-note]')) e.insertAdjacentHTML('beforebegin', '<p class="rm-note" data-pn-note>' + esc(T.movedFrom) + '</p>'); };
    noteEntry(); setTimeout(noteEntry, 0);
  }
  var told = false;
  R.on('ws_open', function () { if (P.movedFrom && !told) { told = true; setTimeout(function () { R.toast(T.movedFrom); }, 600); } });

  // ───────────── staff: the Rescue tab ─────────────
  if (!P.can) return;
  function redraw() { if (R.S.tab === 'rescue') { var p = document.querySelector('[data-panel]'); if (p) render(p); } }
  function act(target, extra) {
    if (UI.busy) return;
    UI.busy = true; UI.msg = T.working; redraw();
    var body = { target: target, confirm: true };
    for (var k in extra || {}) body[k] = extra[k];
    R.post('/panic', body).then(function (r) {
      UI.busy = false; UI.confirm = null;
      if (!r || !r.ok) { UI.msg = errText(r && r.error, r && r.wait); redraw(); return; }
      if (target === 'cohost') { UI.cohost = Boolean(r.cohost); UI.msg = ''; }
      else if (target === 'zoom') UI.msg = T.zoomShown;
      else if (target === 'zoom_off') UI.msg = '';
      // target room: the room tells this page where to go (panic_moved); the answer is the fallback.
      else if (target === 'room' && r.url) setTimeout(function () { if (!MOVED) moved({ url: r.url, host: P.host, text: T.movedHost }); }, 2500);
      redraw();
    }).catch(function () { UI.busy = false; UI.msg = errText('failed'); redraw(); });
  }
  function ask(kind) {
    var q = kind === 'room' ? T.confirmMove : T.confirmZoom;
    return '<div class="pn-ask" role="alertdialog" aria-label="' + esc(q) + '"><p>' + esc(q) + '</p><div class="pn-row">' +
      '<button type="button" class="rm-primary" data-pn-yes="' + kind + '"' + (UI.busy ? ' disabled' : '') + '>' + esc(kind === 'room' ? T.confirm : T.confirmZoomYes) + '</button>' +
      '<button type="button" class="rm-btn" data-pn-no>' + esc(T.cancel) + '</button></div></div>';
  }
  function render(p) {
    var html = '<h2 class="rm-h3">' + esc(T.heading) + '</h2><p class="rm-fine">' + esc(T.intro) + '</p>' +
      '<section class="pn-sec"><h3>' + esc(T.moveTitle) + '</h3><p>' + esc(T.moveBody) + '</p>' +
      (UI.confirm === 'room' ? ask('room') : '<div class="pn-row"><button type="button" class="rm-btn" data-pn-ask="room">' + esc(T.moveButton) + '</button></div>') + '</section>' +
      '<section class="pn-sec"><h3>' + esc(T.zoomTitle) + '</h3>' +
      (P.zoom ? '<p>' + esc(T.zoomBody) + '</p>' + (UI.confirm === 'zoom' ? ask('zoom') : '<div class="pn-row">' + (ZOOM ? '<button type="button" class="rm-btn" data-pn-off>' + esc(T.zoomOff) + '</button>' : '<button type="button" class="rm-btn" data-pn-ask="zoom">' + esc(T.zoomButton) + '</button>') + '</div>') : '<p>' + esc(T.noZoom) + '</p>') +
      '</section>' +
      (P.host ? '<section class="pn-sec"><label class="pn-co"><input type="checkbox" data-pn-co' + (UI.cohost ? ' checked' : '') + '> ' + esc(T.cohostLabel) + '</label></section>' : '') +
      '<p class="pn-msg" role="status" aria-live="polite">' + esc(UI.msg) + '</p>';
    p.innerHTML = html;
    var on = function (sel, fn) { var e = p.querySelector(sel); if (e) e.onclick = fn; };
    on('[data-pn-ask="room"]', function () { UI.confirm = 'room'; UI.msg = ''; render(p); var y = p.querySelector('[data-pn-yes]'); if (y) y.focus(); });
    on('[data-pn-ask="zoom"]', function () { UI.confirm = 'zoom'; UI.msg = ''; render(p); var y = p.querySelector('[data-pn-yes]'); if (y) y.focus(); });
    on('[data-pn-no]', function () { UI.confirm = null; render(p); });
    on('[data-pn-yes]', function () { act(UI.confirm); });
    on('[data-pn-off]', function () { act('zoom_off'); });
    var co = p.querySelector('[data-pn-co]');
    if (co) co.onchange = function () { act('cohost', { allow: co.checked }); };
  }
  R.addTab({ id: 'rescue', label: T.tab, render: render });
})();

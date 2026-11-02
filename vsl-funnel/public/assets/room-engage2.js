/* Engage2 in the live room (src/rooms/engage2*.ts). Attendees: the live-only bonus pinned under the stage (its
 * withdrawal and the offer's close time come from the server; no deadline, no timer), the tab-in-view beacons,
 * and a note each time the offer opens. Staff: the hot list and the bonus settings at the top and bottom of the
 * Push tab, with one-click pushes to one person and a chat mention only for people who opted in to showing their
 * first name. Uses window.RoomCore (room.js) and its c:msg / c:state / c:panel hooks. */
(function () {
  'use strict';
  var R = null, T = null, STAFF = false;
  var HOT = { rows: [], bought: 0, at: 0, askedAt: 0 }, BONUS = null, DRAFT = {};

  function esc(s) { return R.esc(s == null ? '' : String(s)); }
  function view() { return R.S.view; }
  function wsOpen() { return R.S.ws && R.S.ws.readyState === 1; }

  // ───────────── the live-only bonus (everyone) ─────────────
  function bonusEl() {
    // Top of the side column: under the stage on a phone, beside it on a desktop, clear of the stage's own controls.
    var side = document.querySelector('.rm-side'); if (!side) return null;
    var el = side.querySelector('[data-e2-bonus]');
    if (!el) { el = R.h('aside', { class: 'e2-bonus', 'data-e2-bonus': '', 'aria-label': T.bonus.eyebrow }); side.insertBefore(el, side.firstChild); }
    return el;
  }
  function drawBonus() {
    if (!view()) return;
    var el = bonusEl(); if (!el) return;
    var b = BONUS;
    if (!b || STAFF) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle('is-ended', !b.live);
    el.innerHTML = '<p class="e2-eyebrow">' + esc(T.bonus.eyebrow) + '</p>' +
      (b.live ? '<p class="e2-text">' + esc(b.text) + '</p>' + (b.asset ? '<p class="e2-asset">' + esc(T.bonus.includes + ' ' + b.asset) + '</p>' : '') : '') +
      '<p class="e2-line">' + esc(b.mine ? T.bonus.mine : b.line) + '</p>' +
      (b.live && b.closesAt ? '<p class="e2-time" role="timer" aria-live="off"><span>' + esc(T.bonus.closesIn) + '</span> <strong data-e2-left></strong></p>' : '');
    tickBonus();
  }
  function tickBonus() {
    var el = document.querySelector('[data-e2-left]'); if (!el || !BONUS || !BONUS.closesAt) return;
    var left = BONUS.closesAt - R.now();
    el.textContent = R.clock(Math.max(0, left));
  }

  // ───────────── beacons (attendees): the tab in view, the offer opened ─────────────
  function beacon() { if (!STAFF && wsOpen()) R.send({ t: 'e2_focus', v: document.visibilityState === 'visible' }); }
  function watchOffer() {
    var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
    var mo = new MutationObserver(function (list) {
      list.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (!n || n.nodeType !== 1 || (seen && seen.has(n))) return;
          var kind = n.hasAttribute('data-offer-sheet') ? 'deposit' : n.getAttribute('data-esheet') === 'sprint' ? 'sprint' : null;
          if (!kind) return;
          if (seen) seen.add(n);
          if (wsOpen()) R.send({ t: 'e2_open', kind: kind });
        });
      });
    });
    mo.observe(document.body, { childList: true });
  }

  // ───────────── the hot list and the bonus settings (staff, in the Push tab) ─────────────
  function avail() { var e = view() && view().eng; return (e && e.avail) || {}; }
  function askHot(force) {
    if (!STAFF || !wsOpen()) return;
    if (!force && Date.now() - HOT.askedAt < 15000) return;
    HOT.askedAt = Date.now();
    R.send({ t: 'e2_hot_get' });
  }
  function hotSection() {
    var av = avail();
    var rows = HOT.rows || [];
    var list = rows.length ? '<ol class="e2-hot">' + rows.map(function (r) {
      var chips = (r.buying || []).map(function (k) { return '<span class="e2-chip">' + esc(T.buying[k] || k) + '</span>'; }).join('');
      var acts = '';
      if (av.sprint) acts += '<button type="button" class="rm-mini" data-e2-push="sprint" data-id="' + esc(r.id) + '"' + (r.online ? '' : ' disabled') + '>' + esc(T.pushSprint) + '</button>';
      if (av.application && !r.applied) acts += '<button type="button" class="rm-mini" data-e2-push="application" data-id="' + esc(r.id) + '"' + (r.online ? '' : ' disabled') + '>' + esc(T.pushApp) + '</button>';
      if (r.mention) acts += '<button type="button" class="rm-mini" data-e2-mention="' + esc(r.mention) + '">' + esc(T.mention) + '</button>';
      return '<li><div class="e2-hot-h"><b>' + esc(r.name) + '</b><span class="e2-score" aria-label="' + esc(R.tpl(T.score, r.score)) + '">' + r.score + '</span></div>' +
        (chips ? '<div class="e2-chips">' + chips + '</div>' : '') +
        ((r.why || []).length ? '<p class="e2-why">' + esc(r.why.join(' · ')) + '</p>' : '') +
        (r.online ? '' : '<p class="e2-why">' + esc(T.offline) + '</p>') +
        (acts ? '<div class="e2-acts">' + acts + '</div>' : '') + '</li>';
    }).join('') + '</ol>' : '<p class="rm-note">' + esc(T.hotEmpty) + '</p>';
    return '<section class="e2-sec" data-e2-hot><h3 class="rm-h3">' + esc(T.hotHeading) + '</h3><p class="rm-fine">' + esc(T.hotIntro) + '</p>' + list +
      (HOT.bought ? '<p class="rm-fine">' + esc(R.tpl(T.hotBought, HOT.bought)) + '</p>' : '') +
      (rows.length ? '<p class="rm-fine">' + esc(T.mentionNote) + '</p>' : '') + '</section>';
  }
  function until(b) { return DRAFT.until || (b && b.until) || 'offer'; }
  function bonusSection() {
    var b = BONUS, lobby = view() && view().room.status === 'lobby';
    var assets = (R.CFG.engage && R.CFG.engage.assets) || [];
    var body = '';
    if (b && !b.live) body = '<p class="e2-text">' + esc(b.text) + '</p><p class="rm-fine">' + esc(T.bonusWithdrawn) + '</p>';
    else if (b && !lobby) body = '<p class="e2-text">' + esc(b.text) + '</p><p class="rm-fine">' + esc(b.line) + '</p><p class="rm-fine">' + esc(T.bonusLocked) + '</p><button type="button" class="rm-btn" data-e2-withdraw>' + esc(T.bonusWithdraw) + '</button>';
    else {
      body = '<form class="rm-pollform" data-e2-bonusform>' +
        '<label class="rm-field"><span>' + esc(T.bonusText) + '</span><textarea name="e2text" rows="2" maxlength="280">' + esc(b ? b.text : '') + '</textarea></label>' +
        '<label class="rm-field"><span>' + esc(T.bonusAsset) + '</span><select class="rm-input" name="e2asset"><option value="">' + esc(T.bonusNone) + '</option>' +
          assets.map(function (a) { return '<option value="' + esc(a.id) + '"' + ((DRAFT.asset != null ? DRAFT.asset : b && b.assetId) === a.id ? ' selected' : '') + '>' + esc(a.title) + '</option>'; }).join('') + '</select></label>' +
        '<label class="rm-field"><span>' + esc(T.bonusUntil) + '</span><select class="rm-input" name="e2until"><option value="offer"' + (until(b) === 'offer' ? ' selected' : '') + '>' + esc(T.bonusUntilOffer) + '</option><option value="end"' + (until(b) === 'end' ? ' selected' : '') + '>' + esc(T.bonusUntilEnd) + '</option></select></label>' +
        '<div class="rm-row"><button type="submit" class="rm-btn">' + esc(T.bonusSave) + '</button>' + (b ? '<button type="button" class="rm-btn" data-e2-withdraw>' + esc(T.bonusWithdraw) + '</button>' : '') + '</div></form>';
    }
    return '<section class="e2-sec" data-e2-bonussec><h3 class="rm-h3">' + esc(T.bonusHeading) + '</h3><p class="rm-fine">' + esc(T.bonusIntro) + '</p>' + body +
      (b && b.grants ? '<p class="rm-fine">' + esc(R.tpl(T.bonusGrants, b.grants)) + '</p>' : '') + '</section>';
  }
  function drawPanel(p) {
    var root = p && p.querySelector('.rm-push'); if (!root) return;
    var top = R.h('div', { class: 'e2-wrap' }); top.innerHTML = hotSection();
    root.insertBefore(top.firstChild, root.firstChild);
    var bot = R.h('div', { class: 'e2-wrap' }); bot.innerHTML = bonusSection();
    root.appendChild(bot.firstChild);
    R.$$('[data-e2-push]', root).forEach(function (b) {
      b.onclick = function () { R.send({ t: 'e2_push', kind: b.getAttribute('data-e2-push'), id: b.getAttribute('data-id') }); b.disabled = true; R.toast(R.tpl(T.pushed, (b.closest('li').querySelector('b') || {}).textContent || '')); };
    });
    R.$$('[data-e2-mention]', root).forEach(function (b) {
      b.onclick = function () {
        var first = b.getAttribute('data-e2-mention');
        R.showTab('chat');
        setTimeout(function () { var i = document.querySelector('[data-chat-form] input[name="text"]'); if (i) { i.value = first + ', ' + i.value.replace(/^\s+/, ''); i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (e) { /* older browsers */ } } }, 0);
      };
    });
    var f = root.querySelector('[data-e2-bonusform]');
    if (f) {
      f.e2asset.onchange = function () { DRAFT.asset = f.e2asset.value; };
      f.e2until.onchange = function () { DRAFT.until = f.e2until.value; };
      f.onsubmit = function (e) { e.preventDefault(); R.send({ t: 'e2_bonus_set', text: f.e2text.value, asset: f.e2asset.value || null, until: f.e2until.value }); DRAFT = {}; };
    }
    R.$$('[data-e2-withdraw]', root).forEach(function (b) { b.onclick = function () { R.send({ t: 'e2_bonus_withdraw' }); }; });
  }
  function typing() { var a = document.activeElement; return Boolean(a && a.closest && a.closest('[data-e2-bonusform]')); }
  function redrawPush() { if (R.S.tab === 'push' && typeof R.renderPanel === 'function') R.renderPanel(); }

  function boot() {
    R = window.RoomCore;
    if (!R || !R.S) { setTimeout(boot, 200); return; }
    var cfg = R.CFG.engage2; if (!cfg) return;
    T = cfg.copy; STAFF = Boolean(R.isStaff);
    R.on('c:msg', function (m) {
      if (m.t === 'e2_hot') { HOT.rows = m.rows || []; HOT.bought = m.bought || 0; HOT.at = m.at || 0; if (!typing()) redrawPush(); return; }
      if (m.t === 'e2_bonus') { BONUS = m.bonus || null; drawBonus(); if (STAFF && !typing()) redrawPush(); return; }
      if (m.t === 'error' && typeof m.for === 'string' && m.for.indexOf('e2_') === 0) { var text = (T.errors && T.errors[m.error]) || null; if (text) setTimeout(function () { R.toast(text); }, 0); }
    });
    R.on('c:state', function () { drawBonus(); });
    R.on('c:panel', function (tab) { if (tab === 'push' && STAFF) { drawPanel(document.querySelector('[data-panel]')); askHot(false); } });
    if (!STAFF) {
      document.addEventListener('visibilitychange', beacon);
      setInterval(beacon, 60000);
      R.on('ws_open', function () { setTimeout(beacon, 500); });
      watchOffer();
      setTimeout(beacon, 1500);
    } else {
      setInterval(function () { if (R.S.tab === 'push') askHot(false); }, 30000);
    }
    setInterval(tickBonus, 1000);
    // A late load (the first messages came before this script): ask the room for our part.
    if (view() && wsOpen()) R.send({ t: 'e2_hello' });
    if (view()) drawBonus();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

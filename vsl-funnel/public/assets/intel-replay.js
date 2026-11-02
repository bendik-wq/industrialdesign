/* The replay of a room (area D): the recording with its chapters, a searchable transcript that follows the video,
   captions, the cards Josh shared live appearing at the same moments, the deposit offer only while it is really open
   (the server says so; it closes with the offer), and points for watching. Nothing here is invented: every card is
   a real push from the live session, every number comes from the server. */
(function () {
  'use strict';
  var el = document.getElementById('replay-config');
  var root = document.querySelector('[data-replay]');
  if (!el || !root) return;
  var CFG = JSON.parse(el.textContent);
  var C = CFG.copy || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); };
  var tpl = function (s, a) { return String(s).replace('{a}', a); };
  var stamp = function (ms) { var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  var skew = (CFG.serverNow || Date.now()) - Date.now();
  var now = function () { return Date.now() + skew; };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var post = function (path, body) {
    body = body || {}; body.t = CFG.ticket;
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) }).then(function (r) { return r.json(); }).catch(function () { return {}; });
  };
  function toast(text) {
    var t = $('.rm-toast') || document.body.appendChild(Object.assign(document.createElement('div'), { className: 'rm-toast' }));
    t.setAttribute('role', 'status'); t.textContent = text; t.classList.add('is-on');
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('is-on'); }, 3500);
  }

  // ───────────── layout ─────────────
  var lines = CFG.lines || [], chapters = CFG.chapters || [];
  var grid = document.createElement('div');
  grid.className = 'ix-grid';
  grid.innerHTML =
    '<div class="ix-main">' +
      '<div class="ix-player"><video data-v controls playsinline preload="metadata" aria-label="' + esc(CFG.room.title) + '">' +
        '<source src="' + esc(CFG.rec.url) + '" type="' + esc(CFG.rec.mime) + '">' +
        (CFG.rec.vtt ? '<track kind="captions" srclang="en" label="' + esc(C.captionsLabel) + '" src="' + esc(CFG.rec.vtt) + '">' : '') +
      '</video></div>' +
      '<div class="ix-bar">' + (CFG.rec.vtt ? '<button type="button" class="rm-btn" data-cc aria-pressed="false">' + esc(C.captionsLabel) + '</button>' : '') + '<span class="ix-pts" data-pts hidden></span></div>' +
      '<div class="ix-cards" data-cards aria-live="polite"></div>' +
      '<section class="ix-chapwrap" data-chapwrap></section>' +
    '</div>' +
    '<aside class="ix-side">' +
      '<div class="ix-tabs" role="tablist">' +
        '<button type="button" role="tab" id="ix-tab-tr" aria-controls="ix-pane-tr" aria-selected="true" data-tab="tr">' + esc(C.transcript) + '</button>' +
        (chapters.length ? '<button type="button" role="tab" id="ix-tab-ch" aria-controls="ix-pane-ch" aria-selected="false" data-tab="ch" tabindex="-1">' + esc(C.chapters) + '</button>' : '') +
      '</div>' +
      '<div role="tabpanel" id="ix-pane-tr" aria-labelledby="ix-tab-tr" data-pane="tr">' +
        (lines.length ? '<input type="search" class="ix-search" data-q placeholder="' + esc(C.transcriptSearch) + '" aria-label="' + esc(C.transcriptSearch) + '">' +
          '<p class="ix-note">' + esc(C.transcriptAuto) + '</p><ol class="ix-lines" data-lines></ol>' : '<p class="ix-empty">' + esc(C.transcriptNone) + '</p>') +
      '</div>' +
      (chapters.length ? '<div role="tabpanel" id="ix-pane-ch" aria-labelledby="ix-tab-ch" data-pane="ch" hidden><ol class="ix-chaps" data-chaps></ol></div>' : '') +
    '</aside>';
  root.appendChild(grid);
  if (CFG.back) root.insertAdjacentHTML('beforeend', '<a class="rm-link ix-back" href="' + esc(CFG.back) + '">' + esc(C.back) + '</a>');
  var v = $('[data-v]');

  // On a wide screen the chapters also sit under the video; on a phone they are a tab beside the transcript.
  var wide = window.matchMedia ? window.matchMedia('(min-width: 1000px)') : { matches: true };
  function chapList() {
    return chapters.map(function (c, i) { return '<li data-ci="' + i + '"><button type="button" data-seek="' + c.ms + '" aria-label="' + esc(tpl(C.jumpTo, c.at) + ': ' + c.title) + '"><time>' + esc(c.at) + '</time><span>' + esc(c.title) + '</span></button></li>'; }).join('');
  }
  function drawChapters() {
    var wrap = $('[data-chapwrap]');
    wrap.innerHTML = chapters.length && wide.matches ? '<h2 class="rm-h3" style="margin:20px 0 4px">' + esc(C.chapters) + '</h2><ol class="ix-chaps">' + chapList() + '</ol>' : '';
    var p = $('[data-chaps]'); if (p) p.innerHTML = chapList();
  }
  drawChapters();
  if (wide.addEventListener) wide.addEventListener('change', drawChapters);

  // Tabs (arrow keys move between them).
  var tabs = $$('[role=tab]');
  function select(name, focus) {
    tabs.forEach(function (b) { var on = b.getAttribute('data-tab') === name; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
    $$('[data-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== name; });
  }
  tabs.forEach(function (b, i) {
    b.onclick = function () { select(b.getAttribute('data-tab')); };
    b.onkeydown = function (e) { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { var n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; select(n.getAttribute('data-tab'), true); } };
  });

  // ───────────── seeking (chapters, transcript lines, #t=seconds from Funnel HQ) ─────────────
  function seek(ms) { try { v.currentTime = Math.max(0, ms / 1000); } catch (e) { /* not loaded yet */ } if (v.paused) v.play().catch(function () {}); }
  document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-seek]'); if (b) seek(Number(b.getAttribute('data-seek'))); });
  var hashT = /[#&]t=(\d+(?:\.\d+)?)/.exec(location.hash);
  if (hashT) v.addEventListener('loadedmetadata', function () { v.currentTime = Number(hashT[1]); }, { once: true });

  // ───────────── captions ─────────────
  var cc = $('[data-cc]');
  if (cc) cc.onclick = function () {
    var tr = v.textTracks && v.textTracks[0]; if (!tr) return;
    var on = tr.mode !== 'showing'; tr.mode = on ? 'showing' : 'hidden'; cc.setAttribute('aria-pressed', String(on));
  };

  // ───────────── the transcript: follows the video, searchable ─────────────
  var list = $('[data-lines]'), q = $('[data-q]'), current = -1, userScrolledAt = 0, jumped = true;
  function drawLines() {
    if (!list) return;
    var term = (q && q.value || '').trim().toLowerCase();
    var mark = function (s) {
      if (!term) return esc(s);
      var i = s.toLowerCase().indexOf(term); if (i < 0) return esc(s);
      return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + term.length)) + '</mark>' + esc(s.slice(i + term.length));
    };
    var shown = 0, prevW = null;
    list.innerHTML = lines.map(function (l, i) {
      if (term && l.x.toLowerCase().indexOf(term) < 0) return '';
      shown++;
      var who = l.w && (l.w !== prevW || term) ? '<b>' + esc(l.w) + '</b>' : ''; prevW = l.w;
      return '<li><button type="button" class="ix-line" data-li="' + i + '" data-seek="' + l.s + '"' + (i === current ? ' aria-current="true"' : '') + '><time>' + esc(stamp(l.s)) + '</time> ' + who + mark(l.x) + '</button></li>';
    }).join('') || '';
    if (!shown) list.innerHTML = '<li class="ix-empty">' + esc(C.noMatches) + '</li>';
  }
  if (q) q.addEventListener('input', function () { drawLines(); });
  // Only the viewer's own scrolling pauses the follow (our scrollTo fires 'scroll' too, so listen to the inputs).
  if (list) ['wheel', 'touchmove', 'keydown'].forEach(function (ev) { list.addEventListener(ev, function () { userScrolledAt = Date.now(); }, { passive: true }); });
  drawLines();
  function follow(ms) {
    var i = -1;
    for (var k = 0; k < lines.length; k++) { if (lines[k].s <= ms) i = k; else break; }
    if (i !== current) {
      var old = list && list.querySelector('[data-li="' + current + '"]'); if (old) old.removeAttribute('aria-current');
      current = i;
      var cur = list && list.querySelector('[data-li="' + i + '"]');
      if (cur) {
        cur.setAttribute('aria-current', 'true');
        // Keep the line in view unless the viewer is scrolling the list themselves.
        if (Date.now() - userScrolledAt > 4000 && !(q && q.value)) {
          // .ix-lines is positioned, so offsetTop is measured from the list itself. A jump scrolls at once; playing glides.
          var top = cur.parentNode.offsetTop - list.clientHeight / 3;
          list.scrollTo({ top: top, behavior: reduced || jumped ? 'auto' : 'smooth' });
          jumped = false;
        }
      }
    }
    var ci = -1; chapters.forEach(function (c, j) { if (c.ms <= ms) ci = j; });
    $$('[data-ci]').forEach(function (li) { li.setAttribute('aria-current', String(Number(li.getAttribute('data-ci')) === ci)); });
  }

  // ───────────── the cards Josh shared, at their moments ─────────────
  var offer = CFG.offer || { open: false };
  var pushes = CFG.pushes || [];
  function cardsAt(ms) {
    var by = {};
    pushes.forEach(function (p) {
      if (p.at > ms || (p.until != null && ms >= p.until)) return;
      if (p.kind === 'deposit' && !(offer.open && offer.buy)) return;
      if (p.kind === 'vip') return;
      by[p.kind + ':' + (p.ref || '')] = p;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return a.at - b.at; });
  }
  function cardHtml(p) {
    var box = function (eyebrow, h, b, btn, gold) { return '<article class="ix-card" data-card="' + p.id + '"><p class="rm-eyebrow">' + esc(eyebrow) + '</p><h3>' + esc(h) + '</h3>' + (b ? '<p>' + b + '</p>' : '') + '<button type="button" class="' + (gold ? 'rm-buy' : 'rm-primary') + '" data-go="' + p.id + '">' + esc(btn) + '</button></article>'; };
    if (p.kind === 'application') return box(stamp(p.at), C.applyCard, esc(C.applyBody), C.applyButton, false);
    if (p.kind === 'sprint') return box(stamp(p.at), C.sprintCard, esc(C.sprintBody), C.sprintButton, true);
    if (p.kind === 'deposit') return box(stamp(p.at), C.depositCard, esc(C.depositBody) + (offer.closesAt ? '<br>' + esc(C.offerCloses) + ' <span class="ix-timer" data-otimer></span>' : ''), C.depositButton, true);
    return box(C.resourceCard, p.title || C.resourceCard, '', C.resourceButton, false);
  }
  var shownKey = '';
  function drawCards(ms) {
    if (CFG.preview && !pushes.length) return;
    var list2 = cardsAt(ms);
    var key = list2.map(function (p) { return p.id; }).join(',') + '|' + offer.open;
    if (key === shownKey) return;
    shownKey = key;
    var box = $('[data-cards]');
    box.innerHTML = list2.map(cardHtml).join('') + (!offer.open && pushes.some(function (p) { return p.kind === 'deposit' && p.at <= ms; }) && offer.buy ? '<p class="ix-note">' + esc(C.offerClosed) + '</p>' : '');
    tick();
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-go]'); if (!b) return;
    var p = pushes.filter(function (x) { return String(x.id) === b.getAttribute('data-go'); })[0]; if (!p) return;
    if (CFG.preview) { toast(C.previewCard); return; }
    if (p.kind === 'deposit') return openOffer();
    var tab = null; try { tab = window.open('about:blank', '_blank'); if (tab) tab.opener = null; } catch (x) { tab = null; }
    var go = function (url) { if (!url) { if (tab) tab.close(); return; } if (tab && !tab.closed) tab.location.href = url; else location.href = url; };
    b.disabled = true;
    var done = function () { b.disabled = false; };
    if (p.kind === 'sprint') post(CFG.roomApi + '/sprint', {}).then(function (r) { done(); go(r.next || r.url); if (!(r.next || r.url) && r.error) toast(r.error); });
    else post(CFG.api + '/card', { pid: p.id, pos: Math.round(v.currentTime * 1000) }).then(function (r) { done(); go(r.url); if (!r.url && r.error) toast(r.error); });
  });

  // The deposit offer: the live event's own offer panel (same checkout as the room), only while it is open.
  var buying = false;
  function openOffer() {
    if ($('[data-offer-sheet]') || !offer.open) return;
    var t = document.getElementById('room-offer'); if (!t) return;
    var d = document.createElement('div'); d.className = 'rm-sheet rm-sheet--offer'; d.setAttribute('data-offer-sheet', ''); d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true');
    var inner = document.createElement('div'); inner.className = 'rm-sheet-in'; d.appendChild(inner);
    inner.appendChild(t.content.cloneNode(true));
    var x = document.createElement('button'); x.type = 'button'; x.className = 'rm-x'; x.setAttribute('aria-label', 'Close'); x.textContent = '×'; x.onclick = function () { d.remove(); };
    inner.insertBefore(x, inner.firstChild);
    document.body.appendChild(d);
    var sec = $('[data-offer]', d); if (sec) sec.hidden = false;
    var dlg = $('[data-oneclick]', d), err = $('[data-buy-err]', d);
    function buy(oneClick) {
      if (buying) return; buying = true;
      var tab = null; try { tab = window.open('about:blank', '_blank'); if (tab) tab.opener = null; } catch (e) { tab = null; }
      var body = { token: offer.token, one_click: Boolean(oneClick) }; if (offer.day) body.day = offer.day;
      fetch(offer.buy, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) }).then(function (r) { return r.json(); }).catch(function () { return {}; }).then(function (r) {
        buying = false;
        var next = r && (r.url || r.next);
        if (next) { if (tab && !tab.closed) tab.location.href = next; else location.href = next; } else { if (tab) tab.close(); if (err) { err.textContent = (r && r.error) || C.genericError; err.hidden = false; } }
        if (dlg) dlg.hidden = true;
      });
    }
    $$('[data-buy]', d).forEach(function (b) { b.onclick = function () { if (offer.oneClick && dlg) dlg.hidden = false; else buy(false); }; });
    if (dlg) { $('[data-oc-confirm]', dlg).onclick = function () { buy(true); }; $('[data-oc-other]', dlg).onclick = function () { buy(false); }; $('[data-oc-close]', dlg).onclick = function () { dlg.hidden = true; }; }
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape') d.remove(); });
    d.onclick = function (e) { if (e.target === d) d.remove(); };
  }
  function clock(ms) { var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + 'h ' : '') + String(m).padStart(2, '0') + 'm ' + String(x).padStart(2, '0') + 's'; }
  function tick() {
    $$('[data-otimer], [data-offer-timer]').forEach(function (e) { e.textContent = offer.closesAt ? clock(offer.closesAt - now()) : ''; });
    if (offer.open && offer.closesAt && offer.closesAt <= now()) { offer.open = false; var sh = $('[data-offer-sheet]'); if (sh) sh.remove(); drawCards(v.currentTime * 1000); }
  }
  setInterval(tick, 1000);
  // The server is the truth about the offer (the host can close it early): checked every minute.
  if (offer.buy) setInterval(function () {
    post(CFG.api + '/state', {}).then(function (r) {
      if (!r || !r.ok) return;
      if (r.now) skew = r.now - Date.now();
      var was = offer.open; offer.open = r.offer.open; offer.closesAt = r.offer.closesAt;
      if (was !== offer.open) { shownKey = ''; drawCards(v.currentTime * 1000); if (!offer.open) { var sh = $('[data-offer-sheet]'); if (sh) sh.remove(); } }
    });
  }, 60000);

  // ───────────── watching: minutes, points, attribution ─────────────
  var lastT = null, acc = 0;
  v.addEventListener('timeupdate', function () {
    var ms = v.currentTime * 1000;
    follow(ms); drawCards(ms);
    if (!v.paused && !v.seeking) {
      var t = Date.now(); if (lastT !== null && t - lastT < 2000) acc += (t - lastT) / 1000; lastT = t;
    } else lastT = null;
  });
  v.addEventListener('pause', function () { lastT = null; ping(); });
  v.addEventListener('seeking', function () { jumped = true; userScrolledAt = 0; });
  function ping() {
    if (CFG.preview || acc < 1) return;
    var secs = Math.round(acc); acc = 0;
    post(CFG.api + '/ping', { pos: Math.round(v.currentTime), secs: secs }).then(function (r) {
      if (!r || !r.ok) return;
      var pts = $('[data-pts]');
      if (r.replayPoints && CFG.lead) { pts.hidden = false; pts.textContent = tpl(C.replayPoints, r.replayPoints); }
      if (r.earned) toast(tpl(C.replayPoints, r.earned));
    });
  }
  setInterval(ping, 15000);
  window.addEventListener('pagehide', ping);
  drawCards(0);
})();

/* The live room's conversion pieces in the masterclass room (src/webinar/room-convert.ts):
   - the application as an in-room sheet, step by step, prefilled from the registration; its card appears at the
     edition's pitch minute (the recording's position, the same minute the First Deal Sprint unlocks);
   - the Sprint's payment sheet (window.WEBINAR_PAY, opened by webinar-sprint.js when one click isn't available):
     Whop's embedded checkout with the email and name filled in, who is paying, and the real offer deadline
     (the replay close) counted down by pay-timer.js;
   - a quiet progress line in Chapters: chapters reached and key points saved.
   Every time, deadline and count here comes from the server. Nothing pretends to be live. */
(function () {
  'use strict';
  var W = (window.FUNNEL && window.FUNNEL.webinar) || {};
  if (!W.token || !document.querySelector('[data-room]')) return;
  var A = W.application || null, S = W.sprint || null, C = W.convertCopy || {};
  var F = window.funnel || { track: function () {} };
  var R = window.ROOM || {};
  var preview = W.token === 'preview';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); };
  var fill = function (t, o) { return String(t || '').replace(/\{(\w+)\}/g, function (_, k) { return o[k] == null ? '' : o[k]; }); };
  var pos = function () { return window.WEBINAR_POS ? window.WEBINAR_POS() : 0; };
  function post(path, body) {
    body = body || {}; body.token = W.token; body.replay = Boolean(W.replay); if (body.pos == null) body.pos = Math.round(pos());
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
  }
  var arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  // ───────────── The sheet: a bottom sheet on phones, a dialog on wider screens ─────────────
  var open = null, back = null;
  function sheet(label, cls) {
    close();
    back = document.activeElement;
    var el = document.createElement('div');
    el.className = 'cv-sheet' + (cls ? ' ' + cls : '') + (reduced ? '' : ' cv-anim');
    el.innerHTML = '<div class="cv-sheet-in" role="dialog" aria-modal="true" aria-label="' + esc(label) + '" tabindex="-1"><button type="button" class="cv-x" data-cv-close aria-label="' + esc(C.close || 'Close') + '">×</button><div class="cv-body"></div></div>';
    document.body.appendChild(el);
    document.documentElement.classList.add('modal-open');
    el.addEventListener('click', function (e) { if (e.target === el || e.target.closest('[data-cv-close]')) close(); });
    open = el;
    el.querySelector('.cv-sheet-in').focus();
    return el.querySelector('.cv-body');
  }
  function close() {
    if (!open) return;
    open.remove(); open = null;
    document.documentElement.classList.remove('modal-open');
    if (back && back.focus) try { back.focus(); } catch (e) { /* gone */ }
  }
  document.addEventListener('keydown', function (e) {
    if (!open) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Tab') {
      var f = open.querySelectorAll('button:not([disabled]), a[href], textarea, input, iframe');
      if (!f.length) return;
      var a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    }
  });

  // ───────────── The application ─────────────
  var appState = { shown: false, opened: false, started: false };
  function appEvent(stage) {
    if (!A || preview || appState[stage]) return;
    appState[stage] = true;
    post('/api/webinar/app/event', { stage: stage });
    F.track('cta_click', { id: 'webinar_application_' + stage });
  }
  function appCardHtml() {
    if (A.submitted && A.book) return '<p class="now-eyebrow">' + esc(C.appEyebrow) + '</p><p class="cv-h">' + esc(C.appDoneHeading) + '</p><p class="small">' + esc(C.appDoneBook) + '</p><a class="cv-btn" href="' + esc(A.book) + '" target="_blank" rel="noopener" data-cv-book>' + esc(C.appBookButton) + ' ' + arrow + '</a>';
    if (A.submitted) return '<p class="now-eyebrow">' + esc(C.appEyebrow) + '</p><p class="cv-h">' + esc(C.appDoneHeading) + '</p><p class="small">' + esc(C.appDoneBody) + '</p>';
    return '<p class="now-eyebrow">' + esc(C.appEyebrow) + '</p><p class="cv-h">' + esc(C.appHeading) + '</p><p class="small">' + esc(C.appBody) + ' ' + esc(C.appPrefilled) + '</p>' +
      '<button type="button" class="cv-btn" data-cv-app="card">' + esc(C.appButton) + ' ' + arrow + '</button>';
  }
  var card = null, line = null, placed = false, sprintSlot = Boolean(S), sprintWait = 0;
  /** Where the application sits: one quiet line under the Sprint when the Sprint holds the slot, else a card in it. */
  function placeApp() {
    if (!A) return;
    var sprintBox = sprintSlot && document.getElementById('sprint-offer');
    if (sprintBox && sprintBox.parentNode) {
      if (!line) { line = document.createElement('p'); line.className = 'cv-appline'; line.setAttribute('data-cv-appline', ''); }
      line.innerHTML = A.submitted ? '<span>' + esc(C.appDoneHeading) + '.</span>' : '<span>' + esc(C.appSecondary) + '</span> <button type="button" class="linkish" data-cv-app="line">' + esc(C.appButton) + '</button>';
      keepLine();
    } else if (!card) {
      card = document.createElement('div');
      card.className = 'now-card cv-appcard';
      card.innerHTML = appCardHtml();
      if (R.now) R.now(card, { keep: 'deal' }); else { var cta = document.querySelector('[data-cta]'); if (cta && cta.parentNode) cta.parentNode.insertBefore(card, cta); }
    } else card.innerHTML = appCardHtml();
    placed = true;
    appEvent('shown');
  }
  function keepLine() {
    var box = document.getElementById('sprint-offer');
    if (line && box && box.parentNode && line.previousSibling !== box) box.parentNode.insertBefore(line, box.nextSibling);
  }
  function maybeApp(p) {
    if (!A || p < A.atSec) return;
    if (placed) { keepLine(); return; }
    // The Sprint unlocks at the same minute: give it a few seconds to take the slot; if it doesn't, the card does.
    if (sprintSlot && !document.getElementById('sprint-offer')) { if (++sprintWait < 8) return; sprintSlot = false; }
    placeApp();
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-cv-book]')) F.track('cta_click', { id: 'webinar_book_from_room' });
    var b = e.target.closest && e.target.closest('[data-cv-app]');
    if (b) { e.preventDefault(); openApp(b.getAttribute('data-cv-app')); return; }
    // One click on the ticket's card is first; "Pay another way" under it opens the same payment sheet.
    var alt = S && S.paySheet && e.target.closest && e.target.closest('#sprint-offer .bh-alt');
    if (alt) { e.preventDefault(); payOpen(null, 'pay_another_way'); return; }
    // No Sprint: the room's own "Apply" button opens the sheet instead of a new tab (webinar-room.js still logs the click).
    var o = A && !A.submitted && e.target.closest && e.target.closest('[data-offer="call"]');
    if (o) { e.preventDefault(); openApp('offer'); }
  });

  function openApp(where) {
    if (!A) return;
    var qs = A.questions || [], ans = {}, i = 0;
    Object.keys(A.answers || {}).forEach(function (k) { ans[k] = A.answers[k]; });
    var body = sheet(C.appHeading, 'cv-app');
    appEvent('opened');
    F.track('cta_click', { id: 'webinar_application_open', label: where });
    function done() {
      // Qualified (A or B tier): one-tap booking straight from the room. Otherwise the team replies by email.
      var book = A.book || (preview ? '#' : null);
      // The room's own Apply button now books too.
      if (A.book) document.querySelectorAll('a[data-offer="call"]').forEach(function (a) { a.href = A.book; var m = a.querySelector('.btn-mega-main'); if (m && m.firstChild && m.firstChild.nodeType === 3) m.firstChild.nodeValue = C.appBookButton + ' '; });
      body.innerHTML = '<p class="cv-eyebrow">' + esc(C.appEyebrow) + '</p><h2 class="cv-title">' + esc(C.appDoneHeading) + '</h2>' +
        (book ? '<p>' + esc(C.appDoneBook) + '</p><a class="cv-btn" href="' + esc(book) + '" target="_blank" rel="noopener" data-cv-book>' + esc(C.appBookButton) + ' ' + arrow + '</a>' : '<p>' + esc(C.appDoneBody) + '</p>') +
        (sprintSlot && document.getElementById('sprint-offer') ? '<p class="cv-fine">' + esc(C.appDoneSprint) + '</p>' : '') +
        (preview ? '<p class="cv-preview">' + esc(C.appPreview) + '</p>' : '');
      placeApp();
    }
    if (A.submitted) { done(); return; }
    function ok(q) { var v = ans[q.id]; if (q.type === 'text') return typeof v === 'string' && v.trim().length >= (q.minLength || 1); if (q.type === 'multi') return Array.isArray(v) && v.length > 0; return v != null && v !== ''; }
    function draw(err) {
      var q = qs[i], v = ans[q.id], input;
      if (q.type === 'single') input = '<div class="cv-choices" role="radiogroup" aria-label="' + esc(q.title) + '">' + q.options.map(function (o) { return '<button type="button" class="cv-opt' + (v === o.value ? ' is-on' : '') + '" role="radio" aria-checked="' + (v === o.value) + '" data-v="' + esc(o.value) + '">' + esc(o.label) + '</button>'; }).join('') + '</div>';
      else if (q.type === 'multi') input = '<div class="cv-choices">' + q.options.map(function (o) { var on = Array.isArray(v) && v.indexOf(o.value) >= 0; return '<button type="button" class="cv-opt' + (on ? ' is-on' : '') + '" aria-pressed="' + on + '" data-m="' + esc(o.value) + '">' + esc(o.label) + '</button>'; }).join('') + '</div>';
      else input = '<textarea class="cv-text" rows="4" maxlength="2000" placeholder="' + esc(q.placeholder || '') + '" aria-label="' + esc(q.title) + '">' + esc(v || '') + '</textarea>';
      body.innerHTML = '<p class="cv-eyebrow">' + esc(fill(C.appStep, { i: i + 1, n: qs.length })) + '</p>' +
        (i === 0 && (A.name || A.email) ? '<p class="cv-fine">' + esc(C.appAbout) + ' ' + esc([A.name, A.email].filter(Boolean).join(' · ')) + '</p>' : '') +
        '<h2 class="cv-title">' + esc(q.title) + '</h2>' + (q.help ? '<p class="cv-fine">' + esc(q.help) + '</p>' : '') + input +
        '<p class="cv-err" role="alert"' + (err ? '' : ' hidden') + '>' + esc(err || '') + '</p>' +
        '<div class="cv-nav">' + (i > 0 ? '<button type="button" class="linkish" data-back>' + esc(C.appBack) + '</button>' : '<span></span>') +
        '<button type="button" class="cv-btn" data-next>' + esc(i === qs.length - 1 ? C.appSubmit : C.appContinue) + '</button></div>' +
        '<div class="cv-prog-mini" aria-hidden="true"><span style="width:' + Math.round((i + 1) / qs.length * 100) + '%"></span></div>' +
        (preview ? '<p class="cv-preview">' + esc(C.appPreview) + '</p>' : '');
      body.querySelectorAll('[data-v]').forEach(function (b) { b.onclick = function () { ans[q.id] = b.getAttribute('data-v'); draw(); setTimeout(next, reduced ? 0 : 180); }; });
      body.querySelectorAll('[data-m]').forEach(function (b) { b.onclick = function () { var cur = Array.isArray(ans[q.id]) ? ans[q.id].slice() : [], k = b.getAttribute('data-m'), j = cur.indexOf(k); if (j >= 0) cur.splice(j, 1); else cur.push(k); ans[q.id] = cur; draw(); }; });
      var ta = body.querySelector('textarea'); if (ta) { ta.oninput = function () { ans[q.id] = ta.value; }; ta.focus(); }
      var bk = body.querySelector('[data-back]'); if (bk) bk.onclick = function () { i--; draw(); };
      body.querySelector('[data-next]').onclick = next;
    }
    function next() {
      var q = qs[i];
      if (!ok(q)) { draw(C.appMissing); return; }
      appEvent('started');
      if (i < qs.length - 1) { i++; draw(); return; }
      if (preview) { A.submitted = true; done(); return; }
      var btn = body.querySelector('[data-next]'); btn.disabled = true;
      post('/api/webinar/app', { answers: ans }).then(function (r) {
        if (r && r.ok) { A.submitted = true; A.book = r.book || null; F.track('cta_click', { id: 'webinar_application_submitted' }); done(); return; }
        btn.disabled = false;
        var at = r && r.field ? qs.map(function (z) { return z.id; }).indexOf(r.field) : -1;
        if (at >= 0) { i = at; draw(r.error); } else draw((r && r.error) || C.appFailed);
      });
    }
    draw();
  }

  // ───────────── The Sprint's payment sheet ─────────────
  function timerMarkup(at) {
    return '<p class="pay-timer" data-pay-deadline="' + Number(at) + '" data-pay-now="' + Date.now() + '"><span>' + esc(C.payTimerLabel) + '</span> <strong data-pay-left></strong></p>';
  }
  function startTimer(body) {
    var t = body.querySelector('[data-pay-deadline]');
    if (t && window.payTimer) window.payTimer(t, function () {
      // The deadline passed while the sheet was open: the server refuses the payment now, so say so.
      body.innerHTML = '<h2 class="cv-title">' + esc(C.payHeading) + '</h2><p role="status">' + esc(C.payClosed) + '</p>';
    });
  }
  var busy = false;
  function payOpen(btn, where) {
    if (busy || !S) return;
    F.track('cta_click', { id: 'webinar_sprint_pay_sheet', label: where || 'hero' });
    var body = sheet(C.payHeading, 'cv-pay');
    if (preview) {
      body.innerHTML = '<p class="cv-eyebrow">' + esc(S.name || '') + ' · ' + esc(S.price || '') + '</p><h2 class="cv-title">' + esc(C.payHeading) + '</h2>' + timerMarkup(S.deadline) +
        '<p class="cv-fine" data-paying-as>' + esc(C.payPreviewAs) + '</p><div class="cv-whop cv-whop-preview"><p>' + esc(C.payPreview) + '</p></div>';
      startTimer(body);
      return;
    }
    post('/api/webinar/cta', {}); post('/api/webinar/offer', { choice: 'sprint' });
    busy = true;
    body.innerHTML = '<h2 class="cv-title">' + esc(C.payHeading) + '</h2><p class="cv-fine" role="status">' + esc(C.payLoading) + '</p>';
    post('/api/webinar/sprint/pay', {}).then(function (r) {
      busy = false;
      if (r && (r.next || r.fallback)) { location.href = r.next || r.fallback; return; }
      if (!r || !r.sheet) {
        body.innerHTML = '<h2 class="cv-title">' + esc(C.payHeading) + '</h2><p class="cv-err" role="alert">' + esc((r && r.error) || (S.copy && S.copy.checkoutFailed) || '') + '</p>' +
          '<button type="button" class="cv-btn" data-cv-retry>' + esc(C.payTryAgain) + '</button>';
        body.querySelector('[data-cv-retry]').onclick = function () { payOpen(btn, 'retry'); };
        return;
      }
      var s = r.sheet, attrs = { id: 'whop-embedded-checkout', 'data-whop-checkout-plan-id': s.planId || '', 'data-whop-checkout-session': s.sessionId, 'data-whop-checkout-theme': 'light' };
      Object.keys(s.prefill || {}).forEach(function (k) { if (/^data-whop-checkout-prefill-(email|name)$/.test(k)) attrs[k] = s.prefill[k]; });
      body.innerHTML = '<p class="cv-eyebrow">' + esc(S.name || '') + ' · ' + esc(S.price || '') + '</p><h2 class="cv-title">' + esc(C.payHeading) + '</h2>' + (s.timer || '') +
        (s.payingAs ? '<p class="cv-fine" data-paying-as>' + esc(s.payingAs) + '</p>' : '') +
        (s.planId ? '<div class="cv-whop"><div ' + Object.keys(attrs).map(function (k) { return k + '="' + esc(attrs[k]) + '"'; }).join(' ') + '></div></div>' : '') +
        '<p class="cv-fine">' + esc(C.payWhopNote) + '</p>' +
        '<p class="cv-links"><a href="' + esc(s.hostedUrl) + '" target="_blank" rel="noopener" data-cv-hosted>' + esc(C.payNewTab) + '</a><a href="' + esc(s.payPage) + '" data-cv-cardform>' + esc(C.payCardFields) + '</a></p>';
      startTimer(body);
      if (s.planId) {
        // Whop's documented loader mounts the checkout on the div above (a fresh script each time the sheet opens).
        var sc = document.createElement('script'); sc.src = 'https://js.whop.com/static/checkout/loader.js'; sc.async = true; body.appendChild(sc);
      }
      body.querySelector('[data-cv-hosted]').addEventListener('click', function () { F.track('cta_click', { id: 'webinar_sprint_whop_hosted' }); });
    });
  }
  window.WEBINAR_PAY = { open: payOpen, close: close };

  // ───────────── Progress: chapters reached and key points saved (already tracked; nothing new to earn) ─────────────
  var chapters = W.chapters || [], maxP = Number(W.maxPos) || 0, notesN = null, progEl = null, lastSig = '';
  (function () {
    var X = W.experience, ids = {};
    if (!X) return;
    (X.takeaways || []).forEach(function (t) { ids[t.id] = true; });
    notesN = (X.notes || []).filter(function (id) { return ids[id]; }).length;
  })();
  document.addEventListener('webinar:notes', function (e) { notesN = e.detail ? e.detail.count : notesN; drawProgress(); });
  function drawProgress() {
    if (!chapters.length) return;
    var pane = R.pane ? R.pane('chapters') : null;
    if (!pane) return;
    var reached = chapters.filter(function (c) { return maxP >= c.at * 60; }).length;
    var sig = reached + '|' + notesN;
    if (sig === lastSig && progEl) return;
    lastSig = sig;
    if (!progEl) { progEl = document.createElement('div'); progEl.className = 'cv-prog'; progEl.setAttribute('data-cv-progress', ''); pane.insertBefore(progEl, pane.firstChild); }
    var parts = [fill(C.progressChapters, { n: reached, total: chapters.length })];
    if (notesN != null && notesN > 0) parts.push(notesN === 1 ? C.progressNote : fill(C.progressNotes, { n: notesN }));
    progEl.innerHTML = '<p class="cv-prog-h">' + esc(C.progressHeading) + '</p><div class="cv-prog-bar" role="progressbar" aria-label="' + esc(C.progressHeading) + '" aria-valuemin="0" aria-valuemax="' + chapters.length + '" aria-valuenow="' + reached + '"><i style="width:' + Math.round(reached / chapters.length * 100) + '%"></i></div>' +
      '<p class="cv-prog-l">' + esc(parts.join(' · ')) + '</p>';
  }

  function tick() {
    var p = pos();
    if (p > maxP) maxP = p;
    drawProgress();
    maybeApp(p);
  }
  setInterval(tick, 1000);
  setTimeout(tick, 600);
})();

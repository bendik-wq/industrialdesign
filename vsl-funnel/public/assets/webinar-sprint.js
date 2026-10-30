/* The First Deal Sprint: locked in the room from the start ("opens at 38:00"), unlocked at the pitch minute
   of the recording (the live showing and the replay alike), then the full offer with its real deadlines.
   Every time and count here comes from the server, which also refuses checkout before the pitch and after
   the deadline. Also drives the offer page (/offer/:token): countdowns and the one-click checkout. */
(function () {
  'use strict';
  var W = (window.FUNNEL && window.FUNNEL.webinar) || {};
  var S = W.sprint || W.sprintPage;
  if (!S) return;
  var F = window.funnel || { track: function () {} };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); };
  var skew = (S.serverNow || W.serverNow) ? (S.serverNow || W.serverNow) - Date.now() : 0;
  var now = function () { return Date.now() + skew; };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var token = W.token || S.token;
  var C = S.copy || {};
  function post(path, body) {
    body = body || {}; body.token = token; body.replay = Boolean(W.replay);
    if (body.pos == null) body.pos = Math.round(pos());
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
  }
  function pos() { return window.WEBINAR_POS ? window.WEBINAR_POS() : 0; }
  function clock(ms) {
    if (ms <= 0) return '0m 00s';
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm ' + (d ? '' : (sec < 10 ? '0' : '') + sec + 's');
  }
  function mmss(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }
  var lockSvg = function (open) {
    return '<svg class="sprint-lock-i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path class="sprint-shackle" d="' + (open ? 'M8 11V7a4 4 0 0 1 7.6-1.8' : 'M8 11V7a4 4 0 0 1 8 0v4') + '"/></svg>';
  };

  // ── Countdowns (real deadlines from the server) ──
  function tickCountdowns() {
    document.querySelectorAll('[data-sprint-to]').forEach(function (el) {
      var to = Number(el.getAttribute('data-sprint-to')), left = to - now();
      el.textContent = clock(left);
      if (left <= 0 && !el.hasAttribute('data-done')) {
        el.setAttribute('data-done', '');
        var what = el.getAttribute('data-sprint-kind');
        if (what === 'bonus') { var box = el.closest('[data-sprint-bonus]'); if (box) box.innerHTML = '<p class="sprint-bonus-gone">' + esc(C.bonusGone) + '</p>'; }
        if (what === 'deadline') { if (S.preview) return; if (W.sprintPage) location.reload(); else if (state) { state.closed = true; render(); } }
      }
    });
  }
  setInterval(tickCountdowns, 1000);

  // ── One click to checkout (one payment or the plan) ──
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-sprint-buy]');
    if (!b) return;
    e.preventDefault();
    if (b.disabled) return;
    var plan = b.getAttribute('data-sprint-buy') === 'plan';
    var holder = b.closest('[data-sprint-buybox]') || b.parentNode;
    var err = holder.querySelector('.sprint-err');
    if (S.preview) { if (!err) { err = document.createElement('p'); err.className = 'pass-note sprint-err'; holder.appendChild(err); } err.textContent = C.preview || 'Preview'; return; }
    if (S.oneClick && !plan) { oneClick(b, holder); return; }
    var label = b.innerHTML;
    b.disabled = true; b.textContent = S.startUrl ? 'Opening…' : 'Opening secure checkout…';
    F.track('cta_click', { id: 'webinar_sprint_checkout', label: plan ? 'plan' : 'full' });
    var asked = W.sprint ? Promise.all([post('/api/webinar/cta', {}), post('/api/webinar/offer', { choice: 'sprint' })]) : Promise.resolve();
    // Form first, then checkout, then the kickoff booking: the short form page opens checkout itself.
    if (S.startUrl) {
      var go = function () { location.href = S.startUrl + (plan ? '?plan=1' : ''); };
      asked.then(go, go);
      setTimeout(go, 1500); // never wait long on the tracking calls
      return;
    }
    post('/api/webinar/sprint/checkout', { plan: plan, from: W.sprintPage ? 'offer' : 'room' }).then(function (r) {
      if (r && r.url) { location.href = r.url; return; }
      if (r && r.next) { location.href = r.next; return; }
      b.disabled = false; b.innerHTML = label;
      if (!err) { err = document.createElement('p'); err.className = 'pass-note pass-err sprint-err'; err.setAttribute('role', 'alert'); holder.appendChild(err); }
      err.textContent = (r && r.error) || 'Payment couldn’t be started just now. Please try again in a minute.';
      if (r && r.book) { var a = document.createElement('a'); a.href = r.book; a.textContent = 'Book a call'; err.appendChild(document.createTextNode(' ')); err.appendChild(a); }
    });
  });

  // ── One click (bought the ticket through Whop): confirm what is charged and to which card, then pay ──
  function note(holder, text, book) {
    var err = holder.querySelector('.sprint-err');
    if (!err) { err = document.createElement('p'); err.className = 'pass-note pass-err sprint-err'; err.setAttribute('role', 'alert'); holder.appendChild(err); }
    err.textContent = text;
    if (book) { var a = document.createElement('a'); a.href = book; a.textContent = 'Book a call'; err.appendChild(document.createTextNode(' ')); err.appendChild(a); }
  }
  function oneClick(b, holder) {
    var label = b.innerHTML;
    b.disabled = true; b.textContent = 'Opening…';
    F.track('cta_click', { id: 'webinar_sprint_one_click' });
    if (W.sprint) { post('/api/webinar/cta', {}); post('/api/webinar/offer', { choice: 'sprint' }); }
    post('/api/webinar/sprint/one-click/quote', {}).then(function (q) {
      b.disabled = false; b.innerHTML = label;
      if (q && q.next) { location.href = q.next; return; }
      if (q && q.fallback) { location.href = q.fallback; return; }
      if (!q || !q.lines) { note(holder, (q && q.error) || (S.oneClick.copy && S.oneClick.copy.unavailable) || '', q && q.book); return; }
      var box = holder.querySelector('.sprint-oc');
      if (!box) { box = document.createElement('div'); box.className = 'card sprint-oc'; box.style.marginTop = '12px'; holder.insertBefore(box, b.parentNode.nextSibling); }
      var row = function (l, a, strong) { return '<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0' + (strong ? ';border-top:1px solid #e4e7ec;font-weight:700' : '') + '"><span>' + esc(l) + '</span><span class="nw">' + esc(a) + '</span></div>'; };
      box.innerHTML = '<p class="pass-eyebrow">' + esc(q.copy.confirmHeading) + '</p>' +
        q.lines.map(function (x) { return row(x.label, x.amount); }).join('') + row('Total', q.total, true) +
        '<p class="sprint-fine">' + esc(q.copy.charged) + '</p>' +
        '<div class="pass-room-btns"><button type="button" class="btn btn-lg pass-btn" data-oc-pay>' + esc(q.copy.confirmButton) + '</button>' +
        '<a class="btn btn-lg secondary" href="' + esc(S.startUrl) + '" data-oc-other>' + esc(q.copy.otherCard) + '</a></div>';
      var pay = box.querySelector('[data-oc-pay]');
      pay.addEventListener('click', function () {
        if (pay.disabled) return;
        pay.disabled = true; pay.textContent = q.copy.paying;
        F.track('cta_click', { id: 'webinar_sprint_one_click_confirm' });
        post('/api/webinar/sprint/one-click', { confirm: true }).then(function (r) {
          if (r && r.next) { location.href = r.next; return; }
          if (r && r.fallback) { location.href = r.fallback; return; }
          pay.disabled = false; pay.textContent = q.copy.confirmButton;
          note(holder, (r && r.error) || (S.oneClick.copy && S.oneClick.copy.unavailable) || '', r && r.book);
        });
      });
      box.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
    });
  }

  // ── The offer page needs nothing more ──
  if (!W.sprint || !document.querySelector('[data-room]')) { tickCountdowns(); return; }

  // ── The room ──
  var cta = document.querySelector('[data-cta]');
  var box = document.createElement('section');
  box.className = 'sprint-box';
  box.setAttribute('aria-live', 'polite');
  box.setAttribute('aria-label', S.name);
  if (cta && cta.parentNode) { cta.parentNode.insertBefore(box, cta); if (!W.booked) cta.classList.add('sprint-off'); }
  else { var anchor = document.querySelector('[data-pass]') || document.querySelector('[data-room]'); anchor.parentNode.insertBefore(box, anchor.nextSibling); }

  var state = { unlocked: Boolean(S.unlocked), unlockedAt: S.unlockedAt, deadline: S.deadline, bonusEndsAt: S.bonusEndsAt, closed: Boolean(S.closed) };
  var drawn = null, asking = false, retryAt = 0;
  var buyin = window.WEBINAR_BUYIN || (W.experience && W.experience.buyin && W.experience.buyin.text) || null;
  document.addEventListener('webinar:buyin', function (e) { buyin = e.detail && e.detail.text; if (drawn === 'open') { drawn = null; render(); } });

  function lockedHtml() {
    return '<div class="card sprint-card sprint-locked">' +
      '<div class="sprint-lock">' + lockSvg(false) + '</div>' +
      '<div><p class="pass-eyebrow">' + esc(C.lockedEyebrow) + '</p><h2 class="sprint-h">' + esc(C.lockedHeading) + '</h2>' +
      '<p class="sprint-tease">' + esc(C.lockedTease) + '</p><p class="sprint-in" data-sprint-in></p></div></div>';
  }
  function perksHtml() {
    return '<ol class="sprint-days">' + (S.perks || []).map(function (p) {
      return '<li' + (p.day ? '' : ' class="nod"') + '>' + (p.day ? '<span class="sprint-day">' + esc(p.day) + '</span>' : '<span class="sprint-day plus">+</span>') +
        '<div><strong>' + esc(p.title) + '</strong>' + (p.body ? '<span>' + esc(p.body) + '</span>' : '') + '</div></li>';
    }).join('') + '</ol>';
  }
  function bonusHtml() {
    if (!S.bonus) return '';
    if (state.bonusEndsAt && state.bonusEndsAt > now()) {
      return '<div class="sprint-bonus" data-sprint-bonus><p class="pass-eyebrow">' + esc(C.bonusEyebrow) + '</p><p class="sprint-bonus-t"><strong>' + esc(S.bonus.title) + '</strong>' + (S.bonus.body ? ': ' + esc(S.bonus.body) : '') + '</p>' +
        '<p class="sprint-bonus-c">' + esc(C.bonusEnds) + ' <b data-sprint-to="' + state.bonusEndsAt + '" data-sprint-kind="bonus">' + clock(state.bonusEndsAt - now()) + '</b></p></div>';
    }
    return '<div class="sprint-bonus" data-sprint-bonus><p class="sprint-bonus-gone">' + esc(C.bonusGone) + '</p></div>';
  }
  function openHtml() {
    var arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    return (buyin ? '<p class="sprint-buyin"><span>' + esc(C.buyinLead) + '</span> “' + esc(buyin) + '”</p>' : '') +
      '<div class="card sprint-card sprint-open">' +
      '<p class="pass-eyebrow"><span class="sprint-badge">' + lockSvg(true) + esc(C.unlockedEyebrow) + '</span></p>' +
      '<h2 class="sprint-h">' + esc(C.heading) + '</h2><p class="sprint-lede">' + esc(C.lede) + '</p>' +
      '<p class="pass-sub">' + esc(C.timeline) + '</p>' + perksHtml() +
      '<div class="sprint-guarantee"><p class="pass-eyebrow">' + esc(C.guaranteeHeading) + '</p><p>' + esc(S.guarantee) + '</p><p class="sprint-fine">' + esc(C.guaranteeNote) + '</p></div>' +
      '<div class="sprint-buy" data-sprint-buybox>' +
      '<p class="sprint-price">' + esc(S.priceLine) + '</p>' +
      (S.plan ? '<p class="sprint-plan">' + esc(S.plan.line) + '</p>' : '') +
      '<p class="sprint-fine">' + esc(C.creditNote) + '</p>' +
      bonusHtml() +
      (S.capLabel ? '<p class="pass-cap">' + esc(S.capLabel) + '</p>' : '') +
      '<div class="pass-room-btns">' +
      (S.full ? '<p class="pass-note">' + esc(S.soldOut) + '</p>' :
        '<button type="button" class="btn btn-lg pass-btn" data-sprint-buy="full"><span>' + esc(C.button) + ' <span class="nw">· ' + esc(S.price) + '</span></span> ' + arrow + '</button>' +
        (S.plan ? '<button type="button" class="btn btn-lg secondary" data-sprint-buy="plan">' + esc(C.planButton) + ' ' + esc(S.plan.button) + '</button>' : '')) +
      '<button type="button" class="btn btn-lg secondary" data-sprint-call>' + esc(C.bookCall) + '</button></div>' +
      '<p class="sprint-deadline">' + esc(C.deadline) + ': <b data-sprint-to="' + state.deadline + '" data-sprint-kind="deadline">' + clock(state.deadline - now()) + '</b></p>' +
      '<p class="sprint-more"><a href="' + esc(S.offerUrl) + '" target="_blank" rel="noopener" data-sprint-page>' + esc(C.offerPage) + ' →</a></p>' +
      '<p class="pass-fine">' + esc(S.fine) + '</p>' +
      (S.preview ? '<p class="pass-note">' + esc(C.preview) + '</p>' : '') +
      '</div></div>';
  }
  function closedHtml() {
    return '<div class="card sprint-card sprint-closed"><p class="sprint-lede">' + esc(C.closed) + '</p><a class="btn" href="' + esc(S.applyUrl) + '" target="_blank" rel="noopener">' + esc(C.closedButton) + '</a></div>';
  }

  function render(animate) {
    var want = state.closed ? 'closed' : state.unlocked ? 'open' : 'locked';
    if (want === drawn) return;
    var was = drawn;
    drawn = want;
    if (want === 'open' && was === 'locked' && animate && !reduced) {
      // The unlock moment: the lock opens, then the offer slides in.
      box.classList.add('sprint-unlocking');
      var lock = box.querySelector('.sprint-lock');
      if (lock) lock.innerHTML = lockSvg(true);
      setTimeout(function () { box.innerHTML = openHtml(); box.classList.remove('sprint-unlocking'); box.classList.add('sprint-revealed'); wire(); }, 900);
      return;
    }
    box.innerHTML = want === 'closed' ? closedHtml() : want === 'open' ? openHtml() : lockedHtml();
    if (want === 'open') wire();
  }
  function wire() {
    var call = box.querySelector('[data-sprint-call]');
    if (call) call.addEventListener('click', function () {
      post('/api/webinar/cta', {}); post('/api/webinar/offer', { choice: 'call' });
      if (window.WEBINAR_BOOK) window.WEBINAR_BOOK(); else window.open(S.applyUrl, '_blank', 'noopener');
    });
    var page = box.querySelector('[data-sprint-page]');
    if (page) page.addEventListener('click', function () { F.track('cta_click', { id: 'webinar_sprint_page' }); });
  }

  function unlock(p) {
    if (asking || now() < retryAt) return;
    if (S.preview) { // Funnel HQ preview: nothing is saved, the window is shown as a viewer would see it.
      state.unlocked = true; state.unlockedAt = now(); state.bonusEndsAt = Math.min(now() + 86400000, state.deadline);
      render(true); return;
    }
    asking = true;
    post('/api/webinar/sprint/unlock', { pos: Math.round(p) }).then(function (r) {
      asking = false;
      if (r && r.ok) {
        state = { unlocked: true, unlockedAt: r.unlockedAt, deadline: r.deadline, bonusEndsAt: r.bonusEndsAt, closed: Boolean(r.closed) };
        F.track('webinar_offer_shown', { at: Math.round(p), offer: 'sprint' });
        render(true);
      } else if (r && r.reason === 'closed') { state.closed = true; render(); }
      else retryAt = now() + 5000;
    });
  }

  function tick() {
    var p = pos();
    if (!state.unlocked && !state.closed) {
      if (p >= S.opensAtSec) unlock(p);
      var el = box.querySelector('[data-sprint-in]');
      if (el) el.textContent = p > 0 ? 'Opens in ' + mmss(S.opensAtSec - p) + ' of the masterclass.' : '';
    }
    render();
  }
  render();
  setInterval(tick, 1000);
  setTimeout(tick, 400);
})();

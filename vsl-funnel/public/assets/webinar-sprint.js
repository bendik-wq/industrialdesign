/* The First Deal Sprint: locked in the room from the start ("opens at 10:42"), unlocked at the pitch minute
   of the recording (the live showing and the replay alike), then the offer takes over the slot under the
   video, a buy bar stays pinned to the bottom of the screen, and one exit nudge per visit restates the
   real bonus clock. Every time and count here comes from the server, which also refuses checkout before
   the pitch and after the deadline: no invented scarcity. Also drives the offer page (/offer/:token). */
(function () {
  'use strict';
  var W = (window.FUNNEL && window.FUNNEL.webinar) || {};
  var S = W.sprint || W.sprintPage;
  if (!S) return;
  var inRoom = Boolean(W.sprint && document.querySelector('[data-room]'));
  var F = window.funnel || { track: function () {} };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); };
  var fill = function (t, o) { return String(t || '').replace(/\{(\w+)\}/g, function (_, k) { return o[k] == null ? '' : o[k]; }); };
  var skew = (S.serverNow || W.serverNow) ? (S.serverNow || W.serverNow) - Date.now() : 0;
  var now = function () { return Date.now() + skew; };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var token = W.token || S.token;
  var C = S.copy || {};
  var store = { get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  function post(path, body) {
    body = body || {}; body.token = token; body.replay = Boolean(W.replay);
    if (body.pos == null) body.pos = Math.round(pos());
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
  }
  function pos() { return window.WEBINAR_POS ? window.WEBINAR_POS() : 0; }
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  /** "23:59:12", or "1d 22:10:05" past a day. */
  function hms(ms) {
    if (ms <= 0) return '00:00:00';
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (d ? d + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(x);
  }
  /** For screen readers, to the minute: "23 hours 59 minutes". */
  function spoken(ms) {
    var m = Math.max(0, Math.floor(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), mm = m % 60;
    return [d ? d + (d === 1 ? ' day' : ' days') : '', h ? h + (h === 1 ? ' hour' : ' hours') : '', mm + (mm === 1 ? ' minute' : ' minutes')].filter(Boolean).join(' ');
  }
  function mmss(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), s = sec % 60; return m + ':' + pad(s); }
  var arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  var shield = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v6c0 4.4-3 7.9-7 9-4-1.1-7-4.6-7-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>';
  var lockSvg = function (open) {
    return '<svg class="sprint-lock-i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="' + (open ? 'M8 11V7a4 4 0 0 1 7.6-1.8' : 'M8 11V7a4 4 0 0 1 8 0v4') + '"/></svg>';
  };
  function timer(to, kind, cls) {
    return '<b class="' + (cls || 'buy-timer') + '" role="timer" aria-live="off" data-sprint-to="' + to + '" data-sprint-kind="' + kind + '" aria-label="' + esc(spoken(to - now())) + '">' + hms(to - now()) + '</b>';
  }

  var state = { unlocked: Boolean(S.unlocked), unlockedAt: S.unlockedAt, deadline: S.deadline, bonusEndsAt: S.bonusEndsAt, closed: Boolean(S.closed) };
  var bonusOpen = function () { return Boolean(S.bonus && state.bonusEndsAt && state.bonusEndsAt > now()); };
  var isOpen = function () { return state.unlocked && !state.closed && !S.full; };
  var bar = null, barAway = true, barSig = '', drawn = null;

  // ── Countdowns (real deadlines from the server), one tick a second; screen readers get the minute ──
  var lastMinute = {};
  function tickCountdowns() {
    document.querySelectorAll('[data-sprint-to]').forEach(function (el, i) {
      var to = Number(el.getAttribute('data-sprint-to')), left = to - now();
      el.textContent = hms(left);
      var minute = Math.floor(left / 60000);
      if (lastMinute[i] !== minute) { lastMinute[i] = minute; el.setAttribute('aria-label', spoken(left)); }
      if (left <= 0 && !el.hasAttribute('data-done')) {
        el.setAttribute('data-done', '');
        var what = el.getAttribute('data-sprint-kind');
        if (what === 'bonus') { var box = el.closest('[data-sprint-bonus]'); if (box) box.innerHTML = '<p class="buy-bonus-gone">' + esc(C.bonusGone) + '</p>'; paintBar(); }
        if (what === 'deadline') { if (S.preview) return; if (W.sprintPage) location.reload(); else { state.closed = true; drawn = null; render(); } }
      }
    });
  }
  setInterval(tickCountdowns, 1000);

  // ── The buy button: one click on the ticket's card (Whop), else the short form, then checkout ──
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-sprint-buy]');
    if (!b) return;
    e.preventDefault();
    if (b.disabled) return;
    var plan = b.getAttribute('data-sprint-buy') === 'plan';
    var where = b.getAttribute('data-where') || 'hero';
    closeModal();
    if (S.oneClick && !plan) { oneClick(b, where); return; }
    if (S.preview) { notice(C.preview); return; }
    var label = b.innerHTML;
    b.disabled = true; b.querySelector('[data-label]') ? b.querySelector('[data-label]').textContent = 'Opening…' : (b.textContent = 'Opening…');
    F.track('cta_click', { id: 'webinar_sprint_checkout', label: (plan ? 'plan' : 'full') + ':' + where });
    var asked = W.sprint ? Promise.all([post('/api/webinar/cta', {}), post('/api/webinar/offer', { choice: 'sprint' })]) : Promise.resolve();
    if (S.startUrl) {
      // Form first, then checkout, then the kickoff booking: the short form page opens checkout itself.
      var gone = false, go = function () { if (gone) return; gone = true; location.href = S.startUrl + (plan ? '?plan=1' : ''); };
      asked.then(go, go);
      setTimeout(go, 1500); // never wait long on the tracking calls
      setTimeout(function () { b.disabled = false; b.innerHTML = label; }, 8000); // back from the browser cache
      return;
    }
    post('/api/webinar/sprint/checkout', { plan: plan, from: W.sprintPage ? 'offer' : 'room' }).then(function (r) {
      if (r && (r.url || r.next)) { location.href = r.url || r.next; return; }
      b.disabled = false; b.innerHTML = label;
      failed((r && r.error) || C.checkoutFailed);
    });
  });

  // ── A small dialog (confirm step, errors, the exit nudge): Esc and the backdrop close it, focus comes back ──
  var modal = null, returnFocus = null;
  function openModal(html, label, cls) {
    closeModal();
    returnFocus = document.activeElement;
    modal = document.createElement('div');
    modal.className = 'buy-modal' + (cls ? ' ' + cls : '');
    modal.innerHTML = '<div class="buy-modal-in" role="dialog" aria-modal="true" aria-label="' + esc(label) + '" tabindex="-1"><button type="button" class="buy-modal-x" data-modal-close aria-label="' + esc(C.close || 'Close') + '">×</button>' + html + '</div>';
    document.body.appendChild(modal);
    document.documentElement.classList.add('modal-open');
    modal.addEventListener('click', function (e) { if (e.target === modal || e.target.closest('[data-modal-close]')) closeModal(); });
    var first = modal.querySelector('.buy-btn') || modal.querySelector('a[href], button:not(.buy-modal-x)');
    (first || modal.querySelector('.buy-modal-in')).focus();
    return modal;
  }
  function closeModal() {
    if (!modal) return;
    modal.remove(); modal = null;
    document.documentElement.classList.remove('modal-open');
    if (returnFocus && returnFocus.focus) try { returnFocus.focus(); } catch (e) { /* gone */ }
  }
  document.addEventListener('keydown', function (e) {
    if (!modal) return;
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'Tab') { // keep focus inside the dialog
      var f = modal.querySelectorAll('button, a[href]');
      if (!f.length) return;
      var a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    }
  });
  function mailto() {
    return S.teamEmail ? 'mailto:' + S.teamEmail + '?subject=' + encodeURIComponent((S.name || 'First Deal Sprint') + ' payment') : null;
  }
  /** Checkout or the charge didn't go through: try again, or email the team. Never a call. */
  function failed(text) {
    var m = mailto();
    openModal('<p class="buy-modal-h">' + esc(text) + '</p><div class="buy-modal-acts"><button type="button" class="buy-btn" data-sprint-buy="full" data-where="retry"><span data-label>' + esc(C.tryAgain) + '</span></button>' +
      (m ? '<a class="buy-link" href="' + esc(m) + '">' + esc(C.emailTeam) + '</a>' : '') + '</div>', C.tryAgain);
  }
  function notice(text) { openModal('<p class="buy-modal-h">' + esc(text) + '</p>', text); }

  // ── One click (bought the ticket through Whop): confirm what is charged and to which card, then pay ──
  function oneClick(b, where) {
    var label = b.innerHTML;
    F.track('cta_click', { id: 'webinar_sprint_one_click', label: where });
    if (S.preview) { confirmBox(S.oneClick.previewQuote); return; }
    b.disabled = true;
    if (W.sprint) { post('/api/webinar/cta', {}); post('/api/webinar/offer', { choice: 'sprint' }); }
    post('/api/webinar/sprint/one-click/quote', {}).then(function (q) {
      b.disabled = false; b.innerHTML = label;
      if (q && q.next) { location.href = q.next; return; }
      if (q && q.fallback) { location.href = q.fallback; return; }
      if (!q || !q.lines) { failed((q && q.error) || (S.oneClick.copy && S.oneClick.copy.unavailable) || C.checkoutFailed); return; }
      confirmBox(q);
    });
  }
  function confirmBox(q) {
    if (!q) return;
    var row = function (l, a, strong) { return '<div class="buy-row' + (strong ? ' total' : '') + '"><span>' + esc(l) + '</span><span class="nw">' + esc(a) + '</span></div>'; };
    var box = openModal('<p class="buy-steps-mini">' + esc(C.stepNow) + ' · ' + esc(C.stepNext) + '</p><p class="buy-modal-h">' + esc(q.copy.confirmHeading) + '</p>' +
      q.lines.map(function (x) { return row(x.label, x.amount); }).join('') + row('Total', q.total, true) +
      '<p class="buy-fine">' + esc(q.copy.charged) + '</p>' +
      '<button type="button" class="buy-btn buy-btn-xl" data-oc-pay><span data-label>' + esc(q.copy.confirmButton) + '</span> ' + arrow + '</button>' +
      '<p class="buy-guarantee">' + shield + '<span>' + esc(C.guaranteeShort) + '</span></p>' +
      '<p class="buy-modal-alt"><a href="' + esc(S.startUrl) + '" data-oc-other>' + esc(q.copy.otherCard) + '</a></p>' +
      (S.preview ? '<p class="buy-preview">' + esc(C.preview) + '</p>' : ''), q.copy.confirmHeading, 'buy-confirm');
    var pay = box.querySelector('[data-oc-pay]');
    pay.addEventListener('click', function () {
      if (pay.disabled || S.preview) return;
      pay.disabled = true; pay.querySelector('[data-label]').textContent = q.copy.paying;
      F.track('cta_click', { id: 'webinar_sprint_one_click_confirm' });
      post('/api/webinar/sprint/one-click', { confirm: true }).then(function (r) {
        if (r && r.next) { location.href = r.next; return; }
        if (r && r.fallback) { location.href = r.fallback; return; }
        failed((r && r.error) || (S.oneClick.copy && S.oneClick.copy.unavailable) || C.checkoutFailed);
      });
    });
  }

  // ── Pieces shared by the room's offer block and the bar ──
  function buttonHtml(where, xl) {
    if (S.full) return '<p class="buy-soldout">' + esc(S.soldOut) + '</p>';
    var label = where === 'bar' ? C.buttonShort : C.button;
    return '<button type="button" class="buy-btn' + (xl ? ' buy-btn-xl' : '') + '" data-sprint-buy="full" data-where="' + where + '"><span data-label>' + esc(label) + '</span><span class="buy-btn-price">' + esc(S.price) + '</span>' + arrow + '</button>';
  }
  function microHtml() {
    if (S.oneClick) return S.oneClick.card ? fill(C.microOneClick, { card: S.oneClick.card }) : C.microOneClickNoCard;
    return C.micro;
  }
  function priceHtml() {
    return '<div class="buy-price">' + (S.credit ? '<s class="buy-anchor">' + esc(S.listPrice) + '</s>' : '') + '<span class="buy-today"><b>' + esc(S.price) + '</b> ' + esc(C.today) + '</span>' +
      (S.credit ? '<span class="buy-credit">' + esc(fill(C.creditApplied, { credit: S.credit })) + '</span>' : '') + '</div>';
  }
  function daysHtml() {
    var days = (S.perks || []).filter(function (p) { return p.day; });
    return '<div class="buy-days"><p class="buy-label">' + esc(C.timeline) + '</p><ol class="buy-chips">' + days.map(function (p) {
      return '<li><span>' + esc(p.day) + '</span>' + esc(p.title) + '</li>';
    }).join('') + '</ol><details class="buy-more"><summary><span class="when-closed">' + esc(C.daysShow) + '</span><span class="when-open">' + esc(C.daysHide) + '</span></summary>' +
      '<ol class="buy-daylist">' + (S.perks || []).map(function (p) { return '<li><span class="buy-day">' + esc(p.day || '+') + '</span><div><strong>' + esc(p.title) + '</strong>' + (p.body ? '<span>' + esc(p.body) + '</span>' : '') + '</div></li>'; }).join('') + '</ol>' +
      '<p class="buy-fine">' + esc(C.creditNote) + ' ' + esc(S.fine) + '</p></details></div>';
  }
  function bonusHtml() {
    if (!S.bonus) return '';
    if (!bonusOpen()) return '<div class="buy-bonus gone" data-sprint-bonus><p class="buy-bonus-gone">' + esc(C.bonusGone) + '</p></div>';
    return '<div class="buy-bonus" data-sprint-bonus><div class="buy-bonus-t"><p class="buy-label">' + esc(C.bonusEyebrow) + '</p><p><strong>' + esc(S.bonus.title) + '</strong>' + (S.bonus.body ? ': ' + esc(S.bonus.body) : '') + '</p></div>' +
      '<div class="buy-bonus-c"><span>' + esc(C.bonusEndsIn) + '</span>' + timer(state.bonusEndsAt, 'bonus', 'buy-timer big') + '</div></div>';
  }

  // ── The room ──
  if (!inRoom) { offerPageExtras(); tickCountdowns(); return; }
  var R = window.ROOM || {};
  var cta = document.querySelector('[data-cta]');
  if (cta && !W.booked) cta.classList.add('sprint-off');
  var line = document.querySelector('[data-offer-line]');
  var box = document.createElement('section');
  box.className = 'buy-hero';
  box.setAttribute('aria-label', S.name);
  box.id = 'sprint-offer';
  var asking = false, retryAt = 0;
  var buyin = window.WEBINAR_BUYIN || (W.experience && W.experience.buyin && W.experience.buyin.text) || null;
  document.addEventListener('webinar:buyin', function (e) { buyin = e.detail && e.detail.text; if (drawn === 'open') { drawn = null; render(); } });

  function lockedLine(p) {
    if (!line) return;
    var left = S.opensAtSec - p;
    line.innerHTML = lockSvg(false) + '<span><strong>' + esc(C.lockedLine) + '</strong>' + (p > 0 && left > 0 ? ' <span class="muted">· ' + esc(fill(C.lockedIn || 'in {time}', { time: mmss(left) })) + '</span>' : '') + '</span>';
    line.hidden = false;
  }
  function openHtml() {
    return '<div class="buy-top"><p class="buy-badge">' + lockSvg(true) + esc(C.unlockedEyebrow) + ' · ' + esc(C.fromMasterclass) + '</p>' +
      '<h2 class="buy-h">' + esc(C.heading) + '</h2><p class="buy-promise">' + esc(C.promise) + '</p></div>' +
      bonusHtml() +
      '<div class="buy-box" data-sprint-buybox>' +
      (buyin ? '<p class="buy-said"><span>' + esc(C.youSaid) + ':</span> “' + esc(buyin) + '”</p>' : '') +
      priceHtml() +
      '<p class="buy-steps"><span class="on">' + esc(C.stepNow) + '</span><span aria-hidden="true">→</span><span>' + esc(C.stepNext) + '</span></p>' +
      buttonHtml('hero', true) +
      (S.plan && !S.full ? '<button type="button" class="buy-plan" data-sprint-buy="plan" data-where="hero">' + esc(S.plan.line) + '</button>' : '') +
      '<p class="buy-micro">' + esc(microHtml()) + '</p>' +
      '<p class="buy-guarantee">' + shield + '<span><strong>' + esc(C.guaranteeBadge) + '.</strong> ' + esc(S.guarantee) + '</span></p>' +
      (S.whop ? '<div class="buy-pay"><ul aria-label="' + esc(C.payments) + '">' + (C.paymentBadges || []).map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul><p>' + esc(C.payments) + '</p></div>' : '') +
      (S.started ? '<p class="buy-proof">' + esc(fill(C.started, { n: S.started })) + '</p>' : '') +
      (S.capLabel ? '<p class="buy-proof">' + esc(S.capLabel) + '</p>' : '') +
      '</div>' +
      daysHtml() +
      '<p class="buy-foot"><span>' + esc(C.deadlineShort) + ' ' + timer(state.deadline, 'deadline', 'buy-timer') + '</span><a href="' + esc(S.offerUrl) + '" target="_blank" rel="noopener" data-sprint-page>' + esc(C.offerPage) + ' →</a></p>' +
      (S.preview ? '<p class="buy-preview">' + esc(C.preview) + '</p>' : '');
  }
  function closedHtml() {
    var m = mailto();
    return '<div class="buy-closed"><p class="buy-h small">' + esc(C.heading) + '</p><p>' + esc(C.closed) + (m ? ' <a href="' + esc(m) + '">' + esc(C.closedEmail) + '</a>' : '') + '</p></div>';
  }

  function render(animate) {
    var want = state.closed ? 'closed' : state.unlocked ? 'open' : 'locked';
    if (want === drawn) return;
    var was = drawn;
    drawn = want;
    if (want === 'locked') { lockedLine(pos()); return; }
    if (line) line.hidden = true;
    box.innerHTML = want === 'closed' ? closedHtml() : openHtml();
    box.classList.toggle('closed', want === 'closed');
    if (R.offer) R.offer(box); else if (cta && cta.parentNode) cta.parentNode.insertBefore(box, cta);
    if (want === 'open' && was === 'locked' && animate && !reduced) { box.classList.add('buy-revealed'); setTimeout(function () { box.classList.remove('buy-revealed'); }, 1400); }
    var page = box.querySelector('[data-sprint-page]');
    if (page) page.addEventListener('click', function () { F.track('cta_click', { id: 'webinar_sprint_page' }); });
    paintBar();
    tickCountdowns();
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
      else lockedLine(p);
    }
    render();
  }
  render();
  setInterval(tick, 1000);
  setTimeout(tick, 400);
  setupBar(); setupExit();

  // ── The buy bar: pinned to the bottom for the rest of the visit, the live clock in it ──

  function setupBar() {
    bar = document.createElement('div');
    bar.className = 'buybar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', S.name);
    bar.hidden = true;
    document.body.appendChild(bar);
    bar.addEventListener('click', function (e) {
      if (e.target.closest('[data-bar-tools]') && R.openSheet) R.openSheet();
    });
    if (!inRoom) {
      // Offer page: the bar appears once the main button has scrolled away.
      var main = document.querySelector('.buy-box .buy-btn');
      if (main && 'IntersectionObserver' in window) { barAway = false; } else barAway = true;
      if (main && 'IntersectionObserver' in window) new IntersectionObserver(function (es) { barAway = !es[0].isIntersecting; paintBar(); }).observe(main);
    }
    paintBar();
  }

  function paintBar() {
    if (!bar) return;
    var show = isOpen() && (inRoom || barAway);
    var b = bonusOpen();
    var sig = show + '|' + b;
    if (sig === barSig) return;
    barSig = sig;
    document.documentElement.classList.toggle('has-buybar', show);
    if (!show) { bar.hidden = true; return; }
    var to = b ? state.bonusEndsAt : state.deadline;
    bar.innerHTML = '<div class="buybar-in">' +
      (inRoom && R.openSheet ? '<button type="button" class="buybar-tools" data-bar-tools aria-label="' + esc(C.tools) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>' : '') +
      '<div class="buybar-info"><p class="buybar-name"><strong>' + esc(S.name) + '</strong><span class="buybar-price">' + (S.credit ? '<s>' + esc(S.listPrice) + '</s> ' : '') + esc(S.price) + '</span></p>' +
      '<p class="buybar-clock"><span>' + esc(b ? C.bonusEndsIn : C.closesIn) + '</span> ' + timer(to, b ? 'bonus' : 'deadline', 'buy-timer') + '</p></div>' +
      '<div class="buybar-act">' + buttonHtml('bar', false) + '<p class="buybar-g">' + shield + esc(C.guaranteeBadge) + '</p></div></div>';
    bar.hidden = false;
    tickCountdowns();
  }

  // ── Exit nudge: once per visit, after the offer opened (mouse to the top on desktop, or back from another tab) ──
  function setupExit() {
    var key = 'sprint_exit_' + token, shown = store.get(key) === '1', hiddenAt = 0;
    function show(why) {
      if (shown || modal || !isOpen()) return;
      shown = true; store.set(key, '1');
      var b = bonusOpen();
      F.track('cta_click', { id: 'webinar_sprint_exit_nudge', label: why });
      openModal('<p class="buy-label">' + esc(C.exitHeading) + '</p>' +
        '<p class="buy-modal-h">' + esc(b ? C.exitBonus : C.exitClose) + '</p>' +
        '<p class="buy-modal-clock">' + timer(b ? state.bonusEndsAt : state.deadline, b ? 'bonus' : 'deadline', 'buy-timer huge') + '</p>' +
        (b && S.bonus ? '<p class="buy-modal-bonus"><strong>' + esc(S.bonus.title) + '</strong>' + (S.bonus.body ? ': ' + esc(S.bonus.body) : '') + '</p>' : '') +
        priceHtml() + buttonHtml('exit', true) +
        '<p class="buy-guarantee">' + shield + '<span>' + esc(C.guaranteeShort) + '</span></p>' +
        '<p class="buy-modal-alt"><button type="button" class="linkish" data-modal-close>' + esc(inRoom ? C.exitStay : C.exitNotNow) + '</button></p>', C.exitHeading, 'buy-exit');
      tickCountdowns();
    }
    var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    if (fine) document.addEventListener('mouseout', function (e) { if (!e.relatedTarget && e.clientY <= 0) show('mouse'); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 8000) show('tab');
      hiddenAt = 0;
    });
  }

  function offerPageExtras() {
    // The offer page renders its own block on the server; the bar and the exit nudge come from here.
    setupBar(); setupExit();
  }
})();

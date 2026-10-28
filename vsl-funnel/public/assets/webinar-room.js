/* Masterclass room: agenda, timed polls (with real answers from other viewers), the deal calculator,
   the question box (AI assistant, clearly labelled), the attendee worksheet and the offer at the pitch.
   Nothing here pretends to be live: no fake chat, no fake viewer counts. */
(function () {
  'use strict';
  var cfg = (window.FUNNEL && window.FUNNEL.webinar) || {};
  if (!cfg.token || !document.querySelector('[data-room]')) return;
  var copy = cfg.copy || {};
  var F = window.funnel || { track: function () {} };
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); };
  var post = function (path, body) {
    body = body || {}; body.token = cfg.token; body.replay = Boolean(cfg.replay); body.pos = Math.round(pos());
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) }).then(function (r) { return r.json(); }).catch(function () { return {}; });
  };
  var pos = function () { return window.WEBINAR_POS ? window.WEBINAR_POS() : 0; };
  var money = function (v) { return '$' + Math.round(v).toLocaleString('en-US'); };
  var answered = {}; (cfg.answered || []).forEach(function (k) { answered[k] = true; });
  var moments = $('[data-moments]'), agenda = $('[data-agenda]'), ask = $('[data-ask]'), cta = $('[data-cta]');

  // ── Agenda: where we are now (in the replay, chapters are clickable) ──
  var chapters = cfg.chapters || [];
  if (agenda && chapters.length) {
    agenda.innerHTML = '<p class="room-agenda-h">In this masterclass</p><ol>' + chapters.map(function (c, i) {
      return '<li data-ch="' + i + '">' + (cfg.replay ? '<button type="button" data-seek="' + c.at * 60 + '">' : '<span>') + '<b>' + c.at + 'm</b> ' + esc(c.title) + (cfg.replay ? '</button>' : '</span>') + '</li>';
    }).join('') + '</ol>';
    agenda.addEventListener('click', function (e) {
      var b = e.target.closest('[data-seek]');
      if (b && window.WEBINAR_SEEK) window.WEBINAR_SEEK(Number(b.getAttribute('data-seek')));
    });
  }
  function updateAgenda(p) {
    if (!agenda) return;
    var cur = -1;
    chapters.forEach(function (c, i) { if (p >= c.at * 60) cur = i; });
    agenda.querySelectorAll('[data-ch]').forEach(function (li) {
      var i = Number(li.getAttribute('data-ch'));
      var cls = i === cur ? 'now' : i < cur ? 'done' : '';
      if (cls === 'now' && li.className !== 'now') { var ol = li.parentNode; ol.scrollLeft = Math.max(0, li.offsetLeft - ol.offsetLeft - 40); }
      li.className = cls;
    });
  }

  // ── Polls ──
  var shownPolls = {};
  function pollCard(p) {
    var el = document.createElement('div');
    el.className = 'card room-moment room-poll';
    el.innerHTML = '<p class="room-moment-h">Quick question</p><p class="room-q">' + esc(p.question) + '</p><div class="room-opts">' +
      p.options.map(function (o) { return '<button type="button" class="btn-opt" data-v="' + esc(o.value) + '">' + esc(o.label) + '</button>'; }).join('') + '</div>';
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-v]');
      if (!b) return;
      el.querySelectorAll('[data-v]').forEach(function (x) { x.disabled = true; x.classList.toggle('picked', x === b); });
      answered[p.id] = true;
      // The watch experience (webinar-experience.js) listens: deal builder and readiness score.
      document.dispatchEvent(new CustomEvent('webinar:poll', { detail: { poll: p.id, value: b.getAttribute('data-v') } }));
      post('/api/webinar/poll', { poll: p.id, value: b.getAttribute('data-v') }).then(function (r) {
        if (r && r.results) {
          el.querySelector('.room-opts').innerHTML = r.results.map(function (x) {
            return '<div class="poll-res' + (x.value === b.getAttribute('data-v') ? ' mine' : '') + '"><span>' + esc(x.label) + '</span><i style="width:' + Math.round(x.share * 100) + '%"></i><b>' + Math.round(x.share * 100) + '%</b></div>';
          }).join('') + '<p class="muted small">How ' + r.total + ' owners who watched answered.</p>';
        } else {
          var t = document.createElement('p'); t.className = 'muted small'; t.textContent = 'Thanks, noted.'; el.appendChild(t);
        }
        setTimeout(function () { el.classList.add('fade'); setTimeout(function () { el.remove(); }, 600); }, 20000);
      });
    });
    return el;
  }
  function maybePolls(p) {
    (cfg.polls || []).forEach(function (q) {
      if (answered[q.id] || shownPolls[q.id]) return;
      // Live: shown from its minute for 6 minutes. Replay: from its minute onwards.
      if (p >= q.at * 60 && (cfg.replay || p < q.at * 60 + 360)) { shownPolls[q.id] = true; moments.prepend(pollCard(q)); F.track('cta_click', { id: 'webinar_poll_shown', label: q.id }); }
    });
  }

  // ── Deal calculator (illustrative) ──
  // Assumptions shown on the card: bank loan 9% over 10 years, seller note 6% over 5 years, 70/20/10 split.
  function payment(principal, rate, years) { return principal * rate / (1 - Math.pow(1 + rate, -years)); }
  var calcAt = (function () { for (var i = 0; i < chapters.length; i++) if (/stack|fund|structur/i.test(chapters[i].title)) return chapters[i].at * 60; return 25 * 60; })();
  var calcShown = false;
  function calcCard() {
    var c = copy.calculator || {};
    var el = document.createElement('div');
    el.className = 'card room-moment room-calc';
    el.innerHTML = '<p class="room-moment-h">' + esc(c.heading || 'Run your own numbers') + '</p><p class="small">' + esc(c.body || '') + '</p>' +
      '<div class="calc-in"><label>Yearly profit<input type="number" inputmode="numeric" min="0" step="10000" data-profit placeholder="500000"></label><label>Asking price<input type="number" inputmode="numeric" min="0" step="50000" data-price placeholder="1500000"></label></div>' +
      '<div class="calc-out" data-out></div><p class="muted small">' + esc(c.note || 'Illustrative only.') + ' Assumes 9% over 10 years on the bank loan and 6% over 5 years on the seller note.</p>';
    var t = null;
    el.addEventListener('input', function () {
      var profit = Number(el.querySelector('[data-profit]').value), price = Number(el.querySelector('[data-price]').value), out = el.querySelector('[data-out]');
      if (!(profit > 0 && price > 0)) { out.innerHTML = ''; return; }      var debt = price * 0.7, note = price * 0.2, roll = price * 0.1;
      var service = payment(debt, 0.09, 10) + payment(note, 0.06, 5), dscr = profit / service, ok = dscr >= 1.5;
      out.innerHTML = '<table><tbody><tr><th>Commercial debt (70%)</th><td>' + money(debt) + '</td></tr><tr><th>Seller finance (20%)</th><td>' + money(note) + '</td></tr><tr><th>Seller rollover (10%)</th><td>' + money(roll) + '</td></tr>' +
        '<tr><th>Yearly debt payments</th><td>' + money(service) + '</td></tr><tr><th>Price ÷ profit</th><td>' + (price / profit).toFixed(1) + '×</td></tr></tbody></table>' +
        '<p class="calc-verdict ' + (ok ? 'ok' : 'no') + '"><b>' + dscr.toFixed(2) + 'x</b> ' + (ok ? 'clears the 1.5x test at this price.' : 'falls short of 1.5x at this price. A lower price, a longer seller note or more rollover would change that, and that is what the strategy call works through.') + '</p>';
      document.dispatchEvent(new CustomEvent('webinar:calc', { detail: { profit: profit, price: price, dscr: dscr } }));
      clearTimeout(t);
      t = setTimeout(function () { post('/api/webinar/calc', { profit: profit, price: price }); }, 2500);
    });
    return el;
  }
  function maybeCalc(p) { if (!calcShown && p >= calcAt) { calcShown = true; moments.appendChild(calcCard()); } }

  // ── Worksheet (attendee bonus) ──
  var bonusShown = false;
  function bonusCard() {
    var b = copy.bonus || {};
    var el = document.createElement('div');
    el.className = 'card room-moment room-bonus';
    el.innerHTML = '<p class="room-moment-h">' + esc(b.heading || 'Your worksheet') + '</p><p class="small">' + esc(b.body || '') + '</p><button type="button" class="btn btn-sm" data-bonus>' + esc(b.button || 'Unlock my worksheet') + '</button>';
    el.querySelector('[data-bonus]').addEventListener('click', openWorksheet);
    return el;
  }
  function openWorksheet() {
    post('/api/webinar/bonus', {}).then(function (r) {
      if (r && r.ok && r.url) window.open(r.url, '_blank', 'noopener');
      else alert('Your worksheet unlocks near the end of the masterclass.');
    });
  }
  function maybeBonus(p) { if (!bonusShown && p >= (cfg.bonusAtSec || 3120)) { bonusShown = true; moments.prepend(bonusCard()); } }

  // ── Your Acquisition Blueprint (everyone, at the pitch) ──
  var bpShown = false;
  function blueprintCard() {
    var b = cfg.blueprintCopy || {};
    var el = document.createElement('div');
    el.className = 'card room-moment room-blueprint';
    el.innerHTML = '<p class="room-moment-h">Prepared for you</p><p class="room-q">' + esc(b.heading || 'Your Acquisition Blueprint is ready') + '</p><p class="small">' + esc(b.body || '') + '</p>' +
      '<a class="btn btn-sm" href="' + esc(cfg.blueprintUrl) + '" target="_blank" rel="noopener" data-bp>' + esc(b.button || 'Open my blueprint') + '</a>';
    el.querySelector('[data-bp]').addEventListener('click', function () { post('/api/webinar/blueprint', { open: true }); F.track('cta_click', { id: 'webinar_blueprint_open' }); });
    return el;
  }
  function maybeBlueprint(p) {
    if (bpShown || !cfg.blueprintUrl || p < (cfg.pitchAtSec || 2700)) return;
    bpShown = true; moments.prepend(blueprintCard());
    post('/api/webinar/blueprint', {}); // builds it in the background so it opens straight away
  }

  // ── The offer at the pitch ──
  var offerBuilt = false;
  function buildOffer() {
    if (offerBuilt || !cta) return;
    offerBuilt = true;
    var arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    if (cfg.booked) { cta.innerHTML = '<p class="lede"><strong>Your strategy call is booked.</strong> Bring the worksheet and one target business.</p>'; return; }
    if (!cfg.qualified) {
      var u = copy.offerUnder || {};
      cta.innerHTML = '<p class="lede"><strong>' + esc(u.heading || '') + '</strong> ' + esc(u.body || '') + '</p><button type="button" class="btn btn-lg" data-under>' + esc(u.button || 'Get the worksheet') + '</button>';
      cta.querySelector('[data-under]').addEventListener('click', function () { post('/api/webinar/offer', { choice: 'under' }); openWorksheet(); });
      return;
    }
    // The First Deal Sprint has its own panel (locked, then unlocked at the pitch): webinar-sprint.js.
    if (cfg.sprint) return;
    var q = copy.offerQualified || {};
    var po = cfg.pass && cfg.pass.offer;
    if (po) {
      // Two one-click paths: the paid offer straight to Stripe, or the strategy call calendar inline (video keeps playing).
      cta.innerHTML = '<div class="card pass-room"><p class="pass-eyebrow">' + esc(po.name) + ' · ' + esc(po.price) + '</p><h2 class="pass-h">' + esc(po.heading) + '</h2><p class="pass-lede">' + esc(po.body) + '</p>' +
        '<div class="pass-room-btns">' +
        (po.full ? '<p class="pass-note">' + esc(po.soldOut) + '</p>' : '<button type="button" class="btn btn-lg pass-btn" data-pass-buy="offer"><span>' + esc(po.button) + ' <span class="nw">· ' + esc(po.price) + '</span></span> ' + arrow + '</button>') +
        '<button type="button" class="btn btn-lg secondary" data-book-call>' + esc(po.bookCall) + '</button></div>' +
        (po.capLabel ? '<p class="pass-cap">' + esc(po.capLabel) + '</p>' : '') +
        '<details class="pass-more"><summary>' + esc(po.includes) + '</summary><ul class="pass-perks">' + (po.perks || []).map(function (p) { return '<li><strong>' + esc(p.title) + '</strong>' + (p.body ? '<span>' + esc(p.body) + '</span>' : '') + '</li>'; }).join('') + '</ul></details>' +
        '<p class="pass-fine">' + esc(po.guarantee) + '. ' + esc(po.fine) + '</p></div>';
      cta.addEventListener('click', function (e) {
        if (e.target.closest('[data-pass-buy]')) { post('/api/webinar/cta', {}); post('/api/webinar/offer', { choice: 'assessment' }); }
        if (e.target.closest('[data-book-call]')) { post('/api/webinar/cta', {}); post('/api/webinar/offer', { choice: 'call' }); openBooking(); }
      });
      return;
    }
    cta.innerHTML ='<p class="lede"><strong>' + esc(q.heading || 'Want us to map out your first acquisition?') + '</strong> ' + esc(q.body || '') + '</p>' +
      '<a class="btn btn-mega" href="' + esc(cfg.applyUrl) + '" target="_blank" rel="noopener" data-offer="call"><span class="btn-mega-main">' + esc(cfg.applied ? 'Book my strategy call' : (q.button || 'Apply for a strategy call')) + ' ' + arrow + '</span><span class="btn-mega-sub">' + esc(q.sub || '') + '</span></a>' +
      (cfg.selfServe ? '<p class="room-self"><button type="button" class="linkish" data-offer="self_serve">' + esc(q.secondary || 'Start now without a call') + '</button></p>' : '') +
      '<p class="muted small">Opens in a new tab, so the masterclass keeps playing.</p>';
    cta.addEventListener('click', function (e) {
      var b = e.target.closest('[data-offer]');
      if (!b) return;
      var choice = b.getAttribute('data-offer');
      post('/api/webinar/cta', {});
      post('/api/webinar/offer', { choice: choice });
      F.track('cta_click', { id: 'webinar_offer_' + choice });
      if (choice === 'self_serve') {
        e.preventDefault();
        b.disabled = true; b.textContent = 'Preparing your agreement…';
        post('/api/webinar/start', {}).then(function (r) {
          if (r && r.ok && r.url) location.href = r.url;
          else { b.disabled = false; b.textContent = (r && r.error) || 'Something went wrong. Apply for a call instead.'; }
        });
      }
    });
  }

  // ── "Book a strategy call instead": the calendar in a window over the room, name and email filled in ──
  var modal = document.querySelector('[data-book-modal]'), calLoaded = false;
  function openBooking() {
    var b = cfg.booking;
    if (!b || !b.url || !modal) { window.open(cfg.applyUrl, '_blank', 'noopener'); return; }
    if (!calLoaded) {
      calLoaded = true;
      var url = new URL(b.url), p = b.prefill || {};
      if (p.name) url.searchParams.set('name', p.name);
      if (p.email) url.searchParams.set('email', p.email);
      if (b.provider === 'calendly') {
        url.searchParams.set('embed_domain', location.host);
        url.searchParams.set('embed_type', 'Inline');
        if (!(window.FUNNEL || {}).consentRequired) url.searchParams.set('hide_gdpr_banner', '1');
        if (p.leadId) url.searchParams.set('salesforce_uuid', p.leadId); // the signed Calendly webhook matches the booking to the lead
        url.searchParams.set('utm_source', 'webinar');
        url.searchParams.set('utm_content', p.ref || '');
      } else if (p.leadId) url.searchParams.set('metadata[lead_id]', p.leadId);
      var f = document.createElement('iframe');
      f.src = url.toString(); f.title = 'Book a strategy call'; f.loading = 'eager';
      modal.querySelector('[data-book-cal]').appendChild(f);
      window.addEventListener('message', function (e) {
        var d = e.data || {};
        try { if (!/(^|\.)calendly\.com$/.test(new URL(e.origin).hostname)) return; } catch (err) { return; }
        if (d.event === 'calendly.event_scheduled') F.track('cta_click', { id: 'webinar_call_booked_inline' });
      });
    }
    modal.hidden = false;
    document.documentElement.classList.add('modal-open');
    F.track('cta_click', { id: 'webinar_book_call_inline' });
  }
  window.WEBINAR_BOOK = openBooking; // the Sprint panel's "Book a strategy call instead"
  if (modal) {
    var closeModal = function () { modal.hidden = true; document.documentElement.classList.remove('modal-open'); };
    modal.querySelector('[data-book-close]').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
  }

  // ── Paid offer holders: their card (deal pack, session booking) from the start ──
  var passBox = document.querySelector('[data-pass]');
  if (passBox && cfg.pass && cfg.pass.active && cfg.pass.holderHtml) passBox.innerHTML = cfg.pass.holderHtml;

  // ── Question box ──
  if (ask) {
    var a = copy.askBox || {};
    ask.innerHTML = '<p class="room-moment-h">' + esc(a.heading || 'Ask a question') + '</p><form data-askf><textarea rows="2" maxlength="600" placeholder="' + esc(a.placeholder || 'Type your question') + '" required></textarea><button class="btn btn-sm" type="submit">Ask</button></form><p class="muted small">' + esc((cfg.pass && cfg.pass.note) || a.note || '') + '</p><div class="room-qa" data-qa></div>';
    ask.querySelector('[data-askf]').addEventListener('submit', function (e) {
      e.preventDefault();
      var ta = e.target.querySelector('textarea'), q = ta.value.trim(), btn = e.target.querySelector('button');
      if (q.length < 3) return;
      var item = document.createElement('div'); item.className = 'qa';
      item.innerHTML = '<p class="qa-q">' + esc(q) + '</p><p class="qa-a muted">Thinking…</p>';
      ask.querySelector('[data-qa]').prepend(item);
      ta.value = ''; btn.disabled = true;
      post('/api/webinar/ask', { question: q }).then(function (r) {
        btn.disabled = false;
        var el = item.querySelector('.qa-a');
        if (r && r.answer) { el.classList.remove('muted'); el.innerHTML = '<span class="qa-tag">AI assistant' + (r.priority ? ' · priority' : '') + '</span> ' + esc(r.answer); }
        else el.textContent = (r && (r.note || r.error)) || 'Thanks. Josh’s team reads every question and will reply by email.';
      });
    });
  }

  // ── Tick ──
  function tick() {
    var p = pos();
    updateAgenda(p);
    if (!moments) return;
    maybePolls(p); maybeCalc(p); maybeBonus(p); maybeBlueprint(p);
    if (cta && !cta.hidden) buildOffer();
  }
  setInterval(tick, 2000);
  setTimeout(tick, 1500);
})();

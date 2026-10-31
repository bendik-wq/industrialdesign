/* Masterclass room: the layout (video, one "now" slot under it, one tabbed side panel or bottom sheet),
   the chapters, timed polls (with real answers from other viewers), the deal calculator, the question box
   (AI assistant, clearly labelled), the attendee worksheet and the fallback offer when the Sprint is off.
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
  var agenda = $('[data-agenda]'), ask = $('[data-ask]'), cta = $('[data-cta]');
  var chapters = cfg.chapters || [];
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ───────────── Layout: tabs (desktop side panel, mobile bottom sheet), the now slot, the catch-up line ─────────────
  var side = $('[data-side]'), tabsEl = $('[data-tabs]'), dock = $('[data-dock]'), scrim = $('[data-scrim]');
  var nowEl = $('[data-now]'), idleEl = $('[data-now-idle]'), dealMoved = $('[data-deal-moved]'), catchEl = $('[data-catch]');
  var mobile = window.matchMedia ? window.matchMedia('(max-width: 1023px)') : { matches: false, addEventListener: function () {} };
  var LABELS = { deal: 'Your deal', ask: 'Ask', chat: 'Chat', chapters: 'Chapters', notes: 'Notes' };
  var ICONS = {
    deal: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
    ask: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    chat: '<path d="M4 5h16v11H8l-4 4z"/>',
    chapters: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    notes: '<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"/>',
  };
  var order = ['deal', 'ask', 'chat', 'chapters', 'notes'];
  var tabs = {}, active = null, sheetOpen = false;
  function wanted(name) {
    if (name === 'deal') return Boolean(cfg.experience) || dealMoved.children.length > 0;
    if (name === 'notes') return Boolean(cfg.experience);
    if (name === 'chat') return Boolean(cfg.live && cfg.live.chat);
    if (name === 'chapters') return chapters.length > 0;
    return true;
  }
  function paneEl(name) { return side.querySelector('[data-pane="' + name + '"]'); }
  function drawTabs() {
    var names = order.filter(wanted);
    var btn = function (n, where) {
      return '<button type="button" role="tab" class="rm-tab" id="rm-' + where + '-' + n + '" data-tab="' + n + '" aria-controls="rm-pane-' + n + '" aria-selected="' + (n === active) + '"' + (where === 'dock' ? '' : ' tabindex="' + (n === active ? 0 : -1) + '"') + '>' +
        '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[n] + '</svg><span>' + LABELS[n] + '</span><i class="rm-dot" aria-hidden="true"></i></button>';
    };
    tabsEl.innerHTML = names.map(function (n) { return btn(n, 'tab'); }).join('');
    dock.innerHTML = '<div class="rm-dock-in">' + names.map(function (n) { return btn(n, 'dock'); }).join('') + '</div>';
    dock.querySelectorAll('[role=tab]').forEach(function (b) { b.removeAttribute('role'); b.removeAttribute('aria-selected'); b.removeAttribute('aria-controls'); });
    order.forEach(function (n) { var p = paneEl(n); if (p) { p.id = 'rm-pane-' + n; p.setAttribute('aria-labelledby', 'rm-tab-' + n); } });
    tabs = {}; names.forEach(function (n) { tabs[n] = true; });
  }
  function select(name, focus) {
    if (!tabs[name]) return;
    active = name;
    order.forEach(function (n) { var p = paneEl(n); if (p) p.hidden = n !== name; });
    tabsEl.querySelectorAll('[data-tab]').forEach(function (b) {
      var on = b.getAttribute('data-tab') === name;
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
      if (on) b.classList.remove('has-new');
      if (on && focus) b.focus();
    });
    dock.querySelectorAll('[data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === name) b.classList.remove('has-new'); });
    try { localStorage.setItem('rm_tab', name); } catch (e) { /* private mode */ }
  }
  function openSheet(name) {
    if (name) select(name);
    if (!mobile.matches) { if (name) side.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' }); return; }
    sheetOpen = true;
    side.classList.add('open'); scrim.hidden = false;
    document.documentElement.classList.add('sheet-open');
    var t = tabsEl.querySelector('[aria-selected="true"]'); if (t) t.focus();
  }
  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    side.classList.remove('open'); scrim.hidden = true;
    document.documentElement.classList.remove('sheet-open');
  }
  /** A dot on a tab that isn't in view (a moved poll, a reply). */
  function ping(name) {
    if (name === active && (!mobile.matches || sheetOpen)) return;
    document.querySelectorAll('[data-tab="' + name + '"]').forEach(function (b) { b.classList.add('has-new'); });
  }
  tabsEl.addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (b) select(b.getAttribute('data-tab')); });
  tabsEl.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    var names = Object.keys(tabs).sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    var i = names.indexOf(active) + (e.key === 'ArrowRight' ? 1 : -1);
    select(names[(i + names.length) % names.length], true);
    e.preventDefault();
  });
  dock.addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (b) openSheet(b.getAttribute('data-tab')); });
  side.querySelector('[data-sheet-close]').addEventListener('click', closeSheet);
  scrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheetOpen) closeSheet(); });
  if (mobile.addEventListener) mobile.addEventListener('change', function () { if (!mobile.matches) closeSheet(); });
  drawTabs();
  var saved = null; try { saved = localStorage.getItem('rm_tab'); } catch (e) { /* private mode */ }
  select(tabs[saved] ? saved : (tabs.deal ? 'deal' : 'ask'));
  document.documentElement.classList.add('rm-on');

  // The now slot: one moment at a time. A new one replaces the last; the last moves to its tab when it has one.
  var current = null, offerMode = false;
  function moveTo(el, name) {
    if (name === 'deal') { dealMoved.prepend(el); if (!tabs.deal) { drawTabs(); select(active || 'deal'); } }
    else { var p = paneEl(name); if (!p) { el.remove(); return; } p.prepend(el); }
    el.classList.add('moved');
    ping(name);
  }
  function retire(el) {
    var keep = el.__now && el.__now.keep;
    if (keep) moveTo(el, keep); else el.remove();
  }
  function nowShow(el, o) {
    o = o || {};
    el.__now = o;
    if (offerMode) { if (o.after === 'drop' || !o.keep) return false; moveTo(el, o.keep); return true; }
    if (current && current !== el && current.parentNode === nowEl) retire(current);
    current = el;
    el.classList.add('now-item');
    if (!reduced) el.classList.add('now-in');
    nowEl.appendChild(el);
    return true;
  }
  function nowOffer(el) {
    offerMode = true;
    if (current && current.parentNode === nowEl && current !== el) retire(current);
    current = null;
    nowEl.classList.add('is-offer');
    if (el.parentNode !== nowEl) nowEl.appendChild(el);
  }
  /** The late-join / tab-away recap as a single line, expandable, dismissible. */
  function catchLine(lead, linkLabel, lines) {
    if (!catchEl) return;
    catchEl.innerHTML = '<p class="rm-catch-l"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>' + esc(lead) + '</span>' +
      (lines.length ? '<button type="button" class="linkish" data-catch-more aria-expanded="false">' + esc(linkLabel) + '</button>' : '') +
      '<button type="button" class="rm-x" data-catch-x aria-label="Dismiss">×</button></p>' +
      '<ul class="rm-catch-list" hidden>' + lines.map(function (l) { return '<li><b>' + esc(l.t) + '</b>' + (l.line ? ' <span>' + esc(l.line) + '</span>' : '') + '</li>'; }).join('') + '</ul>';
    catchEl.hidden = false;
    var more = catchEl.querySelector('[data-catch-more]'), list = catchEl.querySelector('.rm-catch-list');
    if (more) more.onclick = function () { var on = list.hidden; list.hidden = !on; more.setAttribute('aria-expanded', String(on)); };
    catchEl.querySelector('[data-catch-x]').onclick = function () { catchEl.hidden = true; catchEl.innerHTML = ''; };
  }
  idleEl.innerHTML = '<p class="now-ch"><span class="now-live" aria-hidden="true"></span><span class="now-ch-l">Now</span> <span data-idle-ch></span></p><div class="now-react" data-idle-react></div>';
  // The Acquisition Blueprint (part of the ticket) stays one quiet link in Notes, not a card in the room.
  var notesPane = paneEl('notes');
  if (notesPane && cfg.blueprintUrl) notesPane.insertAdjacentHTML('beforeend', '<p class="rm-bp"><a href="' + esc(cfg.blueprintUrl) + '" target="_blank" rel="noopener">' + esc((cfg.blueprintCopy && cfg.blueprintCopy.button) || 'Open my blueprint') + ' →</a></p>');
  window.ROOM = { now: nowShow, offer: nowOffer, pane: paneEl, openSheet: openSheet, closeSheet: closeSheet, select: select, ping: ping, catchLine: catchLine, idle: idleEl, isMobile: function () { return mobile.matches; } };

  // ── Chapters (in the replay they are clickable) ──
  if (agenda && chapters.length) {
    var stamp = function (c) { return c.at % 1 ? Math.floor(c.at) + ':' + ('0' + Math.round((c.at % 1) * 60)).slice(-2) : c.at + ':00'; };
    agenda.innerHTML = '<ol>' + chapters.map(function (c, i) {
      return '<li data-ch="' + i + '">' + (cfg.replay ? '<button type="button" data-seek="' + c.at * 60 + '">' : '<span>') + '<b>' + stamp(c) + '</b> ' + esc(c.title) + (cfg.replay ? '</button>' : '</span>') + '</li>';
    }).join('') + '</ol>';
    agenda.addEventListener('click', function (e) {
      var b = e.target.closest('[data-seek]');
      if (b && window.WEBINAR_SEEK) window.WEBINAR_SEEK(Number(b.getAttribute('data-seek')));
    });
  }
  var lastCh = -2;
  function updateAgenda(p) {
    var cur = -1;
    chapters.forEach(function (c, i) { if (p >= c.at * 60) cur = i; });
    if (cur === lastCh) return;
    lastCh = cur;
    var label = idleEl.querySelector('[data-idle-ch]');
    if (label) label.textContent = cur >= 0 ? chapters[cur].title : (p > 0 ? '' : 'Starting soon');
    if (!agenda) return;
    agenda.querySelectorAll('[data-ch]').forEach(function (li) {
      var i = Number(li.getAttribute('data-ch'));
      li.className = i === cur ? 'now' : i < cur ? 'done' : '';
      if (i === cur) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
  }

  // ── Polls ──
  var shownPolls = {};
  function pollCard(p) {
    var el = document.createElement('div');
    el.className = 'now-card room-poll';
    el.innerHTML = '<p class="now-eyebrow">Quick question</p><p class="now-q">' + esc(p.question) + '</p><div class="room-opts">' +
      p.options.map(function (o) { return '<button type="button" class="btn-opt" data-v="' + esc(o.value) + '">' + esc(o.label) + '</button>'; }).join('') + '</div>';
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-v]');
      if (!b) return;
      el.querySelectorAll('[data-v]').forEach(function (x) { x.disabled = true; x.classList.toggle('picked', x === b); });
      answered[p.id] = true;
      el.__now = {}; // answered: nothing to keep once it is replaced
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
        setTimeout(function () { el.classList.add('fade'); setTimeout(function () { el.remove(); }, reduced ? 0 : 500); }, 12000);
      });
    });
    return el;
  }
  function maybePolls(p) {
    (cfg.polls || []).forEach(function (q) {
      if (answered[q.id] || shownPolls[q.id]) return;
      // Live: shown from its minute for 6 minutes. Replay: from its minute onwards.
      if (p >= q.at * 60 && (cfg.replay || p < q.at * 60 + 360)) { shownPolls[q.id] = true; nowShow(pollCard(q), { keep: 'deal' }); F.track('cta_click', { id: 'webinar_poll_shown', label: q.id }); }
    });
  }

  // ── Deal calculator (illustrative) ──
  // Assumptions shown on the card: bank loan 9% over 10 years, seller note 6% over 5 years, 70/20/10 split.
  function payment(principal, rate, years) { return principal * rate / (1 - Math.pow(1 + rate, -years)); }
  var calcAt = cfg.calcAt || (function () { for (var i = 0; i < chapters.length; i++) if (/stack|fund|structur/i.test(chapters[i].title)) return chapters[i].at * 60; return 25 * 60; })();
  var calcShown = false;
  function calcCard() {
    var c = copy.calculator || {};
    var el = document.createElement('div');
    el.className = 'now-card room-calc';
    el.innerHTML = '<p class="now-eyebrow">' + esc(c.heading || 'Run your own numbers') + '</p><p class="small">' + esc(c.body || '') + '</p>' +
      '<div class="calc-in"><label>Yearly profit<input type="number" inputmode="numeric" min="0" step="10000" data-profit placeholder="500000"></label><label>Asking price<input type="number" inputmode="numeric" min="0" step="50000" data-price placeholder="1500000"></label></div>' +
      '<div class="calc-out" data-out></div><p class="muted small">' + esc(c.note || 'Illustrative only.') + ' Assumes 9% over 10 years on the bank loan and 6% over 5 years on the seller note.</p>';
    var t = null;
    el.addEventListener('input', function () {
      var profit = Number(el.querySelector('[data-profit]').value), price = Number(el.querySelector('[data-price]').value), out = el.querySelector('[data-out]');
      if (!(profit > 0 && price > 0)) { out.innerHTML = ''; return; }
      var debt = price * 0.7, note = price * 0.2, roll = price * 0.1;
      var service = payment(debt, 0.09, 10) + payment(note, 0.06, 5), dscr = profit / service, ok = dscr >= 1.5;
      out.innerHTML = '<table><tbody><tr><th>Commercial debt (70%)</th><td>' + money(debt) + '</td></tr><tr><th>Seller finance (20%)</th><td>' + money(note) + '</td></tr><tr><th>Seller rollover (10%)</th><td>' + money(roll) + '</td></tr>' +
        '<tr><th>Yearly debt payments</th><td>' + money(service) + '</td></tr><tr><th>Price ÷ profit</th><td>' + (price / profit).toFixed(1) + '×</td></tr></tbody></table>' +
        '<p class="calc-verdict ' + (ok ? 'ok' : 'no') + '"><b>' + dscr.toFixed(2) + 'x</b> ' + (ok ? 'clears the 1.5x test at this price.' : 'falls short of 1.5x at this price. A lower price, a longer seller note or more rollover changes that.') + '</p>';
      document.dispatchEvent(new CustomEvent('webinar:calc', { detail: { profit: profit, price: price, dscr: dscr } }));
      clearTimeout(t);
      t = setTimeout(function () { post('/api/webinar/calc', { profit: profit, price: price }); }, 2500);
    });
    return el;
  }
  function maybeCalc(p) { if (!calcShown && p >= calcAt) { calcShown = true; nowShow(calcCard(), { keep: 'deal' }); } }

  // ── Worksheet (attendee bonus) ──
  var bonusShown = false;
  function bonusCard() {
    var b = copy.bonus || {};
    var el = document.createElement('div');
    el.className = 'now-card room-bonus';
    el.innerHTML = '<p class="now-eyebrow">' + esc(b.heading || 'Your worksheet') + '</p><p class="small">' + esc(b.body || '') + '</p><button type="button" class="btn btn-sm" data-bonus>' + esc(b.button || 'Unlock my worksheet') + '</button>';
    el.querySelector('[data-bonus]').addEventListener('click', openWorksheet);
    return el;
  }
  function openWorksheet() {
    post('/api/webinar/bonus', {}).then(function (r) {
      if (r && r.ok && r.url) window.open(r.url, '_blank', 'noopener');
      else alert('Your worksheet unlocks near the end of the masterclass.');
    });
  }
  function maybeBonus(p) { if (!bonusShown && p >= (cfg.bonusAtSec || 3120)) { bonusShown = true; nowShow(bonusCard(), { keep: 'deal' }); } }

  // ── The offer at the pitch, when the First Deal Sprint isn't on (webinar-sprint.js draws the Sprint) ──
  var offerBuilt = false;
  function buildOffer() {
    if (offerBuilt || !cta) return;
    offerBuilt = true;
    var arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    if (cfg.sprint) return;
    if (cfg.booked) { cta.innerHTML = '<p class="lede"><strong>Your strategy call is booked.</strong> Bring the worksheet and one target business.</p>'; return; }
    if (!cfg.qualified) {
      var u = copy.offerUnder || {};
      cta.innerHTML = '<p class="lede"><strong>' + esc(u.heading || '') + '</strong> ' + esc(u.body || '') + '</p><button type="button" class="btn btn-lg" data-under>' + esc(u.button || 'Get the worksheet') + '</button>';
      cta.querySelector('[data-under]').addEventListener('click', function () { post('/api/webinar/offer', { choice: 'under' }); openWorksheet(); });
      return;
    }
    var q = copy.offerQualified || {};
    var po = cfg.pass && cfg.pass.offer;
    if (po) {
      // The paid offer straight to checkout.
      cta.innerHTML = '<div class="card pass-room"><p class="pass-eyebrow">' + esc(po.name) + ' · ' + esc(po.price) + '</p><h2 class="pass-h">' + esc(po.heading) + '</h2><p class="pass-lede">' + esc(po.body) + '</p>' +
        '<div class="pass-room-btns">' +
        (po.full ? '<p class="pass-note">' + esc(po.soldOut) + '</p>' : '<button type="button" class="btn btn-lg pass-btn" data-pass-buy="offer"><span>' + esc(po.button) + ' <span class="nw">· ' + esc(po.price) + '</span></span> ' + arrow + '</button>') +
        '</div>' +
        (po.capLabel ? '<p class="pass-cap">' + esc(po.capLabel) + '</p>' : '') +
        '<details class="pass-more"><summary>' + esc(po.includes) + '</summary><ul class="pass-perks">' + (po.perks || []).map(function (p) { return '<li><strong>' + esc(p.title) + '</strong>' + (p.body ? '<span>' + esc(p.body) + '</span>' : '') + '</li>'; }).join('') + '</ul></details>' +
        '<p class="pass-fine">' + esc(po.guarantee) + '. ' + esc(po.fine) + '</p></div>';
      cta.addEventListener('click', function (e) {
        if (e.target.closest('[data-pass-buy]')) { post('/api/webinar/cta', {}); post('/api/webinar/offer', { choice: 'assessment' }); }
      });
      return;
    }
    cta.innerHTML = '<p class="lede"><strong>' + esc(q.heading || 'Want us to map out your first acquisition?') + '</strong> ' + esc(q.body || '') + '</p>' +
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

  // ── Paid offer holders: their card (deal pack, session booking) from the start ──
  var passBox = document.querySelector('[data-pass]');
  if (passBox && cfg.pass && cfg.pass.active && cfg.pass.holderHtml) passBox.innerHTML = cfg.pass.holderHtml;

  // ── Question box ──
  if (ask) {
    var a = copy.askBox || {};
    ask.innerHTML = '<p class="rm-pane-h">' + esc(a.heading || 'Ask a question') + '</p><form data-askf><label class="wx-sr" for="rm-ask-t">' + esc(a.heading || 'Ask a question') + '</label><textarea id="rm-ask-t" rows="3" maxlength="600" placeholder="' + esc(a.placeholder || 'Type your question') + '" required></textarea><button class="btn btn-sm" type="submit">Ask</button></form><p class="muted small">' + esc((cfg.pass && cfg.pass.note) || a.note || '') + '</p><div class="room-qa" data-qa></div>';
    ask.querySelector('[data-askf]').addEventListener('submit', function (e) {
      e.preventDefault();
      var ta = e.target.querySelector('textarea'), q = ta.value.trim(), btn = e.target.querySelector('button');
      if (q.length < 3) return;
      var item = document.createElement('div'); item.className = 'qa';
      item.innerHTML = '<p class="qa-q">' + esc(q) + '</p><p class="qa-a muted" aria-live="polite">Thinking…</p>';
      ask.querySelector('[data-qa]').prepend(item);
      ta.value = ''; btn.disabled = true;
      post('/api/webinar/ask', { question: q }).then(function (r) {
        btn.disabled = false;
        var el = item.querySelector('.qa-a');
        if (r && r.answer) { el.classList.remove('muted'); el.innerHTML = '<span class="qa-tag">AI assistant' + (r.priority ? ' · priority' : '') + '</span> ' + esc(r.answer); }
        else el.textContent = (r && (r.note || r.error)) || 'Thanks. Josh’s team reads every question and will reply by email.';
        ping('ask');
      });
    });
  }

  // ── Tick ──
  function tick() {
    var p = pos();
    updateAgenda(p);
    maybePolls(p); maybeCalc(p); maybeBonus(p);
    if (cta && !cta.hidden) buildOffer();
  }
  setInterval(tick, 2000);
  setTimeout(tick, 1200);
})();

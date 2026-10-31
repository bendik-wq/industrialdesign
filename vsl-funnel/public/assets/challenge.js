/* The First Deal Challenge in the browser: local times, real countdowns (from the server's clock), the
   registration form, the one-click VIP bump, and the day page next to Zoom (live card, chat and presence,
   worksheet, poll, hot seat, the host-opened offer with its sticky bar, alert and tab title). */
(function () {
  'use strict';
  var CFG = (window.FUNNEL || {}).challenge || {};
  var F = window.funnel || { track: function () {} };
  var skew = CFG.now ? CFG.now - Date.now() : 0;
  function now() { return Date.now() + skew; }
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return { ok: false, error: 'Connection problem. Try again.' }; });
  }
  function withToken(o) { o = o || {}; o.token = CFG.token; if (CFG.day) o.day = CFG.day; return o; }

  // ───── local times ─────
  function fmt(ms, o) { try { return new Date(ms).toLocaleString([], o); } catch (e) { return ''; } }
  $$('[data-local-when]').forEach(function (el) { var t = Number(el.getAttribute('data-local-when')); var s = fmt(t, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); if (s) el.textContent = s; });
  $$('[data-local-date]').forEach(function (el) { var t = Number(el.getAttribute('data-local-date')); var s = fmt(t, { weekday: 'short', day: 'numeric', month: 'short' }); if (s) el.textContent = s; });

  // ───── countdowns ─────
  function left(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    if (d) return d + 'd ' + h + 'h ' + m + 'm';
    if (h) return h + 'h ' + m + 'm ' + (x < 10 ? '0' : '') + x + 's';
    return m + 'm ' + (x < 10 ? '0' : '') + x + 's';
  }
  var reloadAt = null;
  function tick() {
    $$('[data-countdown]').forEach(function (el) {
      var t = Number(el.getAttribute('data-countdown'));
      el.textContent = left(t - now());
      // A session card whose start just passed redraws itself from the server (live now / join).
      if (t <= now() && el.closest('[data-ch-session]') && !reloadAt) reloadAt = Date.now() + 1500 + Math.random() * 2000;
    });
    if (reloadAt && Date.now() > reloadAt) { reloadAt = Infinity; location.reload(); }
  }
  tick(); setInterval(tick, 1000);

  // ───── registration ─────
  var form = $('[data-ch-register]');
  if (form) {
    var band = $('[data-ch-band]', form), under = $('[data-ch-under]', form), err = $('[data-ch-err]', form), btn = $('button[type=submit]', form);
    if (band) band.addEventListener('change', function () { under.hidden = band.value !== 'lt1m'; });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.hidden = true;
      var data = {}; new FormData(form).forEach(function (v, k) { data[k] = v; });
      data.sms_consent = Boolean(form.sms_consent && form.sms_consent.checked);
      var ts = $('[name="cf-turnstile-response"]', form); if (ts) data.turnstile = ts.value;
      var label = btn.innerHTML; btn.disabled = true; btn.textContent = 'One moment…';
      F.track('cta_click', { id: 'challenge_register' });
      post(CFG.register || '/api/challenge/register', data).then(function (r) {
        if (r && r.next) { location.href = r.next; return; }
        btn.disabled = false; btn.innerHTML = label;
        err.hidden = false; err.textContent = (r && r.error) || 'Something went wrong. Try again.';
        if (r && r.field && form[r.field]) form[r.field].focus();
      });
    });
  }

  // ───── VIP one click ─────
  var vip = $('[data-ch-vip]');
  if (vip) vip.addEventListener('click', function () {
    var label = vip.textContent; vip.disabled = true; vip.textContent = 'Taking your payment…';
    F.track('cta_click', { id: 'challenge_vip_one_click' });
    post(CFG.vip || '/api/challenge/vip', { token: CFG.token }).then(function (r) {
      if (r && r.next) { location.href = r.next; return; }
      vip.disabled = false; vip.textContent = label;
      var e = $('[data-ch-vip-err]'); e.hidden = false; e.textContent = (r && r.error) || 'The upgrade wasn’t charged. Try again.';
    });
  });

  // ───── deposit (offer block and sticky bar) ─────
  function deposit(b) {
    var errEl = $('[data-ch-deposit-err]');
    var label = b.textContent; b.disabled = true; b.textContent = 'One moment…';
    F.track('cta_click', { id: 'challenge_deposit', day: CFG.day || null });
    post(CFG.deposit || '/api/challenge/deposit', withToken({})).then(function (r) {
      if (r && r.next) { location.href = r.next; return; }
      b.disabled = false; b.textContent = label;
      if (errEl) { errEl.hidden = false; errEl.textContent = (r && r.error) || 'The deposit checkout didn’t open. Try again.'; }
    });
  }
  $$('[data-ch-deposit]').forEach(function (b) { b.addEventListener('click', function () { deposit(b); }); });
  var barGo = $('[data-ch-bar-go]');
  if (barGo) barGo.addEventListener('click', function () {
    var block = $('[data-ch-offer]');
    if (block && !block.hidden) { block.scrollIntoView({ behavior: 'smooth', block: 'start' }); var b = $('[data-ch-deposit]', block); if (b) setTimeout(function () { b.focus(); }, 400); }
    else deposit(barGo);
  });
  function syncBar() { var bar = $('[data-ch-bar]'); document.body.classList.toggle('has-bar', Boolean(bar && !bar.hidden)); }
  syncBar();

  // ───── day page ─────
  if (!CFG.day) return;

  // The live engine's Zoom card, mounted over our own session card while the session is still to come or on.
  var host = $('[data-ch-player][data-mount]');
  if (host && window.LivePlayer && CFG.playback && CFG.playback.mode === 'link') {
    try {
      window.LivePlayer.mount(host, {
        key: CFG.key, playback: CFG.playback, serverNow: CFG.now, note: CFG.playerNote,
        onJoin: function () { post(CFG.joined, withToken({})); F.track('cta_click', { id: 'challenge_join_zoom', day: CFG.day }); },
      });
    } catch (e) { /* our own card stays */ }
  }

  // Offer: polled from the challenge-offer state; opening it shows the block, the bar, an alert and the tab title.
  var C = CFG.copy || {};
  var baseTitle = document.title, offerShown = Boolean(CFG.offerOpen);
  function showOffer(s) {
    var block = $('[data-ch-offer]'), bar = $('[data-ch-bar]');
    if (s.open && !offerShown) {
      offerShown = true;
      if (block) block.hidden = false;
      if (bar) bar.hidden = false;
      var nw = $('[data-ch-notify-wrap]'); if (nw) nw.hidden = true;
      syncBar();
      document.title = '(1) ' + (C.notifyTitle || 'The offer is open') + ' · ' + baseTitle;
      try { if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification(C.notifyTitle || 'The offer is open', { body: baseTitle, tag: 'challenge-offer' }); } catch (e) { /* not supported */ }
      F.track('cta_click', { id: 'challenge_offer_shown', day: CFG.day });
    }
    if (s.closed) {
      $$('[data-ch-deposit], [data-ch-bar-go]').forEach(function (b) { b.disabled = true; b.textContent = C.closed || 'This offer has closed.'; });
      if (bar) bar.hidden = true; syncBar();
    }
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && document.title !== baseTitle && offerShown) setTimeout(function () { document.title = baseTitle; }, 4000); });
  var notifyBtn = $('[data-ch-notify]');
  if (notifyBtn) notifyBtn.addEventListener('click', function () {
    var done = function () { notifyBtn.replaceWith(document.createTextNode(C.notifyOn || '')); };
    if (window.Notification && Notification.permission === 'default') Notification.requestPermission().then(done, done); else done();
  });
  function pollOffer() {
    if (!CFG.offerUrl) return;
    fetch(CFG.offerUrl, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) { if (s) showOffer(s); }).catch(function () {});
  }

  // Chat and presence.
  var chat = $('[data-ch-chat]'), list = chat && $('[data-ch-msgs]', chat), cursor = 0, seen = {};
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function addMsg(m) {
    if (!list) return;
    var ex = list.querySelector('[data-id="' + m.id + '"]');
    if (m.deleted) { if (ex) ex.remove(); return; }
    if (ex || seen[m.id]) return;
    seen[m.id] = 1;
    var empty = list.querySelector('.chx-empty'); if (empty) empty.remove();
    var li = document.createElement('li'); li.setAttribute('data-id', m.id); if (m.team) li.className = 'team';
    li.innerHTML = (m.team ? '<span class="tag">' + esc(m.badge || C.team || 'Team') + '</span>' : '') + '<b>' + esc(m.name) + '</b>' + m.html; // html is escaped by the server
    var stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.appendChild(li);
    if (stick) list.scrollTop = list.scrollHeight;
  }
  function feed() {
    if (document.hidden) return;
    post(CFG.feed, withToken({ after: cursor, presence: true })).then(function (r) {
      if (!r || !r.ok) return;
      skew = r.now - Date.now();
      if (r.chat) {
        r.chat.messages.forEach(addMsg);
        cursor = r.chat.cursor || cursor;
        var pin = $('[data-ch-pin]'); if (pin) { pin.hidden = !r.chat.pinned; if (r.chat.pinned) pin.innerHTML = '<b>' + esc(r.chat.pinned.name) + '</b> ' + r.chat.pinned.html; }
        var sendF = $('[data-ch-send]'); if (sendF) sendF.hidden = !r.chat.canPost;
      }
      var pr = $('[data-ch-presence]'); if (pr) pr.textContent = r.presence && r.presence.line ? r.presence.line : '';
      if (r.offer) showOffer(r.offer);
    });
  }
  var send = $('[data-ch-send]');
  if (send) send.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = send.text, text = input.value.trim(); if (!text) return;
    var errEl = $('[data-ch-chat-err]'); errEl.hidden = true;
    input.disabled = true;
    post(CFG.chat, withToken({ text: text })).then(function (r) {
      input.disabled = false;
      if (r && r.ok) { input.value = ''; addMsg(r.message); input.focus(); }
      else { errEl.hidden = false; errEl.textContent = (r && r.error) || 'Not sent. Try again.'; }
    });
  });
  feed(); setInterval(feed, 5000);
  if (CFG.offerDay) setInterval(pollOffer, 10000);

  // Worksheet.
  var ws = $('[data-ch-ws]');
  if (ws) ws.addEventListener('submit', function (e) {
    e.preventDefault();
    var answers = {}; $$('input[name], textarea[name]', ws).forEach(function (f) { answers[f.name] = f.value; });
    var b = $('button[type=submit]', ws), msg = $('[data-ch-ws-msg]', ws); b.disabled = true;
    post(CFG.worksheet, withToken({ answers: answers })).then(function (r) { b.disabled = false; msg.textContent = (r && (r.message || r.error)) || ''; if (r && r.ok) F.track('cta_click', { id: 'challenge_worksheet', day: CFG.day }); });
  });

  // Poll: one answer, then the cohort's real counts.
  var poll = $('[data-ch-poll]');
  if (poll) $$('[data-value]', poll).forEach(function (b) {
    b.addEventListener('click', function () {
      post(CFG.poll, withToken({ value: b.getAttribute('data-value') })).then(function (r) {
        if (!r || !r.ok || !r.results) return;
        var res = $('.chx-poll-res', poll), total = r.results.total || 0;
        res.innerHTML = r.results.options.map(function (o) { var p = total ? Math.round(o.n / total * 100) : 0; return '<li class="' + (o.value === r.mine ? 'me' : '') + '"><span>' + esc(o.label) + '</span><span class="chx-poll-bar"><i style="width:' + p + '%"></i></span><span class="chx-poll-n">' + o.n + '</span></li>'; }).join('');
        res.hidden = false; $('.chx-poll-opts', poll).hidden = true;
        var note = $('[data-ch-poll-note]', poll); note.hidden = false; note.textContent = (C.pollThanks || '') + ' ' + total + ' answer' + (total === 1 ? '' : 's') + ' so far.';
      });
    });
  });

  // VIP hot seat question.
  var hot = $('[data-ch-hot]');
  if (hot) hot.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = hot.q.value.trim(); if (!q) return;
    post(CFG.hot, withToken({ question: q })).then(function (r) { $('[data-ch-hot-msg]', hot).textContent = (r && (r.message || r.error)) || ''; if (r && r.ok) hot.q.value = ''; });
  });

  // Day 4: the coverage calculator (illustrative).
  var calc = $('[data-ch-calc]');
  if (calc) {
    var num = function (v) { return Number(String(v).replace(/[^0-9.]/g, '')) || 0; };
    var run = function () {
      var e = num($('[data-calc="ebitda"]', calc).value), s = num($('[data-calc="service"]', calc).value);
      var x = s > 0 ? e / s : 0, out = $('[data-calc-out]', calc), verdict = $('[data-calc-verdict]', calc), box = $('.chx-calc-r', calc);
      out.textContent = s > 0 ? x.toFixed(2) + 'x' : '–';
      var pass = x >= 1.5; verdict.textContent = s > 0 ? (pass ? C.calcPass : C.calcFail) : ''; box.classList.toggle('fail', s > 0 && !pass);
    };
    $$('input', calc).forEach(function (i) { i.addEventListener('input', run); }); run();
  }
})();

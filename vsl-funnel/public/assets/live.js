/* The live webinar funnel's pages: the landing (registration and a real countdown), the companion room next to
   Zoom (Join on Zoom, presence, chat, polls, and the deposit offer the host opens live) and the welcome page.
   Every timer counts to a time the server sent, corrected for the server's clock. */
(function () {
  'use strict';
  var CFG = (window.FUNNEL || {}).live;
  if (!CFG) return;
  var F = window.funnel || { track: function () {} };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var skew = CFG.serverNow ? CFG.serverNow - Date.now() : (CFG.state && CFG.state.now ? CFG.state.now - Date.now() : 0);
  var now = function () { return Date.now() + skew; };
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
  }
  function left(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d ? d + 'd ' : '') + (d || h ? p(h) + ':' : '') + p(m) + ':' + p(x);
  }
  // Times in the viewer's own zone.
  $$('[data-local-time]').forEach(function (el) {
    try { el.textContent = new Date(Number(el.getAttribute('data-local-time'))).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch (e) { /* keep the server's text */ }
  });
  function countdowns() {
    $$('[data-countdown]').forEach(function (el) {
      var t = Number(el.getAttribute('data-countdown')), v = $('[data-countdown-v]', el);
      if (!v) return;
      if (now() >= t) { el.hidden = CFG.page === 'room'; if (CFG.copy && CFG.copy.started) { var l = $('.lv-count-l', el); if (l) l.textContent = CFG.copy.started; } v.textContent = ''; return; }
      v.textContent = left(t - now());
    });
  }
  countdowns();
  setInterval(countdowns, 1000);

  if (CFG.page === 'landing') landing();
  if (CFG.page === 'room') room();
  if (CFG.page === 'welcome' && CFG.refresh) setTimeout(function () { location.reload(); }, 5000);

  // ───────────── landing ─────────────
  function landing() {
    var form = $('[data-live-register]');
    if (!form) return;
    var err = $('[data-err]', form);
    var slot = $('[data-turnstile]', form);
    var tsToken = null;
    var cfg = window.FUNNEL || {};
    if (slot && cfg.turnstileSiteKey) {
      var tries = 0;
      (function wait() { if (window.turnstile) window.turnstile.render(slot, { sitekey: cfg.turnstileSiteKey, size: 'flexible', appearance: 'interaction-only', callback: function (t) { tsToken = t; } }); else if (tries++ < 40) setTimeout(wait, 250); })();
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('button[type=submit]', form);
      var fd = new FormData(form);
      var body = {};
      fd.forEach(function (v, k) { body[k] = v; });
      body.sms_consent = !!form.querySelector('[name=sms_consent]').checked;
      body.turnstile = tsToken;
      err.hidden = true;
      btn.disabled = true;
      post(CFG.register, body).then(function (r) {
        if (r && r.next) { F.track('live_register_submit', {}); location.href = r.next; return; }
        btn.disabled = false;
        err.textContent = (r && r.error) || 'Something went wrong. Please try again.';
        err.hidden = false;
        var f = r && r.field && form.querySelector('[name="' + r.field + '"]');
        if (f && f.focus) f.focus();
      });
    });
  }

  // ───────────── room ─────────────
  function room() {
    var C = CFG.copy || {};
    var S = CFG.state || {};
    var token = CFG.token;
    var baseTitle = document.title;
    var player = null;
    var cursor = 0, since = 0;
    var offerShown = false, notified = false;
    var offer = $('[data-offer]'), bar = $('[data-buybar]'), timerbar = $('[data-timerbar]'), pin = $('[data-pin]');
    var msgs = $('[data-msgs]'), presence = $('[data-presence]');
    var buying = false;

    // Join on Zoom: the live engine's player when it is on the page, else our own card. Clicks are recorded.
    function joined() { post(CFG.join, { token: token }); F.track('live_join_zoom', {}); }
    function stage(st) {
      var el = $('[data-player]');
      if (st.stage === 'replay') {
        if (player) { player.destroy(); player = null; }
        el.innerHTML = '';
        var card = document.createElement('div'); card.className = 'lv-join';
        var h = document.createElement('h2'); h.className = 'lv-join-h'; h.textContent = C.replayHeading; card.appendChild(h);
        var p = document.createElement('p'); p.className = 'lv-join-p';
        if (st.replayUrl) {
          p.textContent = C.replayCloses + ' '; var t = document.createElement('span'); t.className = 'buy-timer'; t.setAttribute('data-replay-timer', ''); p.appendChild(t); card.appendChild(p);
          var a = document.createElement('a'); a.className = 'lv-zoom'; a.href = st.replayUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = C.replayButton; card.appendChild(a);
        } else { p.textContent = C.replayNone; card.appendChild(p); }
        el.appendChild(card);
        return;
      }
      if (window.LivePlayer && !player) {
        player = window.LivePlayer.mount(el, {
          key: CFG.key, playback: CFG.playback, serverNow: now(), poll: false, title: CFG.title, note: C.joinBody,
          onJoin: joined, onNeedLink: function () { tick(); },
        });
      }
      if (player) {
        if (st.joinUrl !== (CFG.playback || {}).joinUrl) { CFG.playback = CFG.playback || {}; CFG.playback.joinUrl = st.joinUrl; player.update({ joinUrl: st.joinUrl, mode: st.hasLink ? 'link' : 'none' }); }
        return;
      }
      // Our own card (no live player script).
      var zoom = $('[data-zoom]'), p2 = $('[data-join-p]'), dot = $('[data-live-dot]');
      if (st.joinUrl) { zoom.href = st.joinUrl; zoom.hidden = false; p2.textContent = C.joinBody; }
      else { zoom.hidden = true; p2.textContent = now() >= st.startsAt - 15 * 60000 ? C.noLink : C.joinSoon; }
      if (dot) dot.hidden = !(st.stage === 'live');
      if (!zoom.__bound) { zoom.__bound = true; zoom.addEventListener('click', joined); }
    }

    // Browser notification and the tab title when the host opens the offer (people are on Zoom in another tab).
    var nb = $('[data-notify]'), nn = $('[data-notify-note]');
    if (nb && 'Notification' in window && S.qualified !== false) {
      if (Notification.permission === 'granted') { nn.textContent = C.notifyOn; nn.hidden = false; }
      else if (Notification.permission === 'denied') { nn.textContent = C.notifyBlocked; nn.hidden = false; }
      else nb.hidden = false;
      nb.addEventListener('click', function () {
        Notification.requestPermission().then(function (p) { nb.hidden = true; nn.textContent = p === 'granted' ? C.notifyOn : C.notifyBlocked; nn.hidden = false; F.track('live_notify_' + p, {}); });
      });
    }
    function announce() {
      document.title = C.offerTitle || baseTitle;
      if (notified || document.visibilityState === 'visible') return;
      notified = true;
      try { if ('Notification' in window && Notification.permission === 'granted') { var n = new Notification(C.offerNotice + ': ' + CFG.title, { body: C.notifyBody, tag: 'live-offer-' + token }); n.onclick = function () { window.focus(); n.close(); if (offer) offer.scrollIntoView({ behavior: 'smooth', block: 'start' }); }; } } catch (e) { /* the title still changes */ }
    }
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && offerShown) document.title = C.offerTitle || baseTitle; });

    function setOffer(o, st) {
      var open = !!(o && o.open);
      if (offer) offer.hidden = !open;
      if (bar) { bar.hidden = !open || !offerShown; document.body.classList.toggle('lv-has-bar', open && !bar.hidden); }
      if (open && !offerShown) {
        offerShown = true;
        announce();
        if (offer) { offer.classList.add('lv-in'); if (document.visibilityState === 'visible') setTimeout(function () { offer.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 250); }
        F.track('live_offer_seen', {});
      }
      if (!open && offerShown) { offerShown = false; document.title = baseTitle; if (bar) bar.hidden = true; document.body.classList.remove('lv-has-bar'); }
      S.offer = o; S.timer = st.timer;
      if (timerbar) timerbar.hidden = !(st.timer && open);
    }
    // The slim buy bar appears once the offer block has scrolled out of view.
    if (offer && bar && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        var out = !es[0].isIntersecting && es[0].boundingClientRect.top < 0;
        var open = S.offer && S.offer.open;
        bar.hidden = !(open && out);
        document.body.classList.toggle('lv-has-bar', !bar.hidden);
      }).observe(offer);
    }
    function timers() {
      var o = S.offer;
      $$('[data-offer-timer]').forEach(function (t) { t.textContent = o && o.open ? left(o.closesAt - now()) : ''; });
      $$('[data-replay-timer]').forEach(function (t) { t.textContent = left(S.replayClosesAt - now()); });
      if (o && o.open && now() >= o.closesAt) { o.open = false; setOffer(o, S); }
    }
    setInterval(timers, 1000);

    // Buying: one click on the saved card (with a confirm step), else our Whop payment page.
    var dlg = $('[data-oneclick]');
    function buy(oneClick) {
      if (buying) return;
      buying = true;
      var err = $('[data-buy-err]');
      $$('[data-buy], [data-oc-confirm]').forEach(function (b) { b.disabled = true; });
      F.track('live_deposit_click', { one_click: !!oneClick });
      post(CFG.buy, { token: token, one_click: !!oneClick }).then(function (r) {
        if (r && r.url) { location.href = r.url; return; }
        buying = false;
        $$('[data-buy], [data-oc-confirm]').forEach(function (b) { b.disabled = false; });
        if (dlg) dlg.hidden = true;
        if (err) { err.textContent = (r && r.error) || 'Something went wrong. Please try again.'; err.hidden = false; }
      });
    }
    $$('[data-buy]').forEach(function (b) { b.addEventListener('click', function () { if (CFG.oneClick && dlg) { dlg.hidden = false; $('[data-oc-confirm]', dlg).focus(); } else buy(false); }); });
    if (dlg) {
      $('[data-oc-confirm]', dlg).addEventListener('click', function () { buy(true); });
      $('[data-oc-other]', dlg).addEventListener('click', function () { buy(false); });
      $('[data-oc-close]', dlg).addEventListener('click', function () { dlg.hidden = true; });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') dlg.hidden = true; });
    }

    // Chat
    function addMsg(m) {
      if (m.deleted) { var gone = msgs.querySelector('[data-id="' + m.id + '"]'); if (gone) gone.remove(); return; }
      if (msgs.querySelector('[data-id="' + m.id + '"]')) return;
      var empty = $('[data-empty]', msgs); if (empty) empty.remove();
      var li = document.createElement('li'); li.className = 'lv-msg' + (m.team ? ' lv-msg-team' : ''); li.setAttribute('data-id', m.id);
      var n = document.createElement('span'); n.className = 'lv-msg-n'; n.textContent = m.name; li.appendChild(n);
      if (m.badge) { var b = document.createElement('span'); b.className = 'lv-badge'; b.textContent = m.badge; li.appendChild(b); }
      var t = document.createElement('span'); t.className = 'lv-msg-t'; t.innerHTML = ' ' + m.html; li.appendChild(t); // server-escaped
      var stick = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
      msgs.appendChild(li);
      if (stick) msgs.scrollTop = msgs.scrollHeight;
    }
    var chatForm = $('[data-chat-form]'), chatErr = $('[data-chat-err]');
    if (chatForm) chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = chatForm.querySelector('input');
      var text = input.value.trim();
      if (!text) return;
      chatErr.hidden = true;
      post(CFG.chat, { token: token, text: text, anon: !!($('[data-anon]') || {}).checked }).then(function (r) {
        if (r && r.ok) { input.value = ''; addMsg(r.message); cursor = Math.max(cursor, r.message.id); }
        else { chatErr.textContent = (r && r.error) || ''; chatErr.hidden = false; }
      });
    });

    // Polls the host pushes
    var pollEl = $('[data-poll]'), pollId = null;
    function drawPoll(p) {
      if (!p) { pollEl.hidden = true; pollId = null; return; }
      pollEl.hidden = false;
      var opts = $('[data-poll-opts]', pollEl);
      if (p.buyin) {
        // The buy-in moment: one sentence in their own words, with three starting points.
        if (pollId === p.id) return;
        pollId = p.id;
        $('[data-poll-q]', pollEl).innerHTML = p.question; // server-escaped
        opts.innerHTML = '';
        if (p.saved) { var done = document.createElement('p'); done.className = 'lv-offer-p'; done.textContent = p.saved; opts.appendChild(done); return; }
        var chips = document.createElement('div'); chips.className = 'lv-chips';
        var ta = document.createElement('textarea'); ta.className = 'lv-ta'; ta.maxLength = 300; ta.placeholder = p.placeholder; ta.rows = 2;
        p.prompts.forEach(function (x) { var c = document.createElement('button'); c.type = 'button'; c.className = 'lv-chip'; c.innerHTML = x; c.addEventListener('click', function () { ta.value = c.textContent + ': '; ta.focus(); }); chips.appendChild(c); });
        var save = document.createElement('button'); save.type = 'button'; save.className = 'lv-btn-2'; save.textContent = p.button;
        save.addEventListener('click', function () { post(CFG.vote, { token: token, poll: p.id, text: ta.value }).then(function (r) { if (r && r.ok) { p.saved = r.saved; pollId = null; drawPoll(p); } }); });
        opts.appendChild(chips); opts.appendChild(ta); opts.appendChild(save);
        return;
      }
      if (pollId === p.id && p.voted == null) return;
      pollId = p.id;
      $('[data-poll-q]', pollEl).innerHTML = p.question; // server-escaped
      opts.innerHTML = '';
      p.options.forEach(function (o, i) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'lv-poll-o' + (p.voted === i ? ' on' : '');
        var lab = document.createElement('span'); lab.innerHTML = o; b.appendChild(lab);
        if (p.results) {
          var pc = p.results.total ? Math.round(p.results.counts[i] / p.results.total * 100) : 0;
          var r = document.createElement('span'); r.className = 'lv-poll-r'; r.textContent = pc + '%'; b.appendChild(r);
          b.style.setProperty('--w', pc + '%'); b.classList.add('lv-poll-done'); b.disabled = true;
        } else b.addEventListener('click', function () { post(CFG.vote, { token: token, poll: p.id, choice: i }).then(function (r) { if (r && r.ok) { p.voted = i; p.results = r.results; pollId = null; drawPoll(p); } }); });
        opts.appendChild(b);
      });
    }

    var reloadedForStage = false;
    function apply(r) {
      if (!r || !r.ok) return;
      skew = r.now - Date.now();
      S.replayClosesAt = r.replayClosesAt;
      if ((r.stage === 'closed' || r.stage === 'cancelled') && !reloadedForStage) { reloadedForStage = true; location.reload(); return; }
      stage(r);
      setOffer(r.offer, r);
      if (pin) { pin.hidden = !r.pinned; pin.innerHTML = r.pinned || ''; }
      if (presence) presence.textContent = [r.presence && r.presence.line, r.presence && r.presence.host].filter(Boolean).join(' ');
      if (r.chat) { (r.chat.messages || []).forEach(addMsg); cursor = Math.max(cursor, r.chat.cursor || 0); since = r.now; if (chatForm) chatForm.hidden = !r.chat.canPost; }
      drawPoll(r.poll);
      timers();
    }
    function tick() { return post(CFG.feed, { token: token, after: cursor, since: since, presence: true }).then(apply); }
    stage(S);
    setOffer(S.offer, S);
    timers();
    tick();
    // Every 4 s while visible; background tabs are throttled by the browser, so a visible tab catches up at once.
    setInterval(function () { if (document.visibilityState === 'visible' || Math.random() < 0.5) tick(); }, 4000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') tick(); });
  }
})();

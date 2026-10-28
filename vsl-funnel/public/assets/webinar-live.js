/* Masterclass room: the real live layer on top of the recording.
   - Presence: only real people whose room pinged in the last 45 s; only shown when two or more others are here.
   - Showing chat: real viewers of this showing (and team messages, labelled). Read-only in the replay, with the
     original showing's time on it.
   - Announcements typed by the team (or scheduled by them), "Get a call from Josh's team" for $1M+ owners,
     and the team's private replies to this viewer's questions.
   Nothing here is simulated: no seeded messages, no invented counts, no typing indicators. */
(function () {
  'use strict';
  var cfg = (window.FUNNEL && window.FUNNEL.webinar) || {};
  var L = cfg.live;
  if (!cfg.token || !L || !document.querySelector('[data-room]')) return;
  var C = L.copy || {};
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); };
  var pos = function () { return window.WEBINAR_POS ? Math.round(window.WEBINAR_POS()) : 0; };
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  function post(path, body) {
    body = body || {}; body.token = cfg.token; body.replay = Boolean(cfg.replay); body.pos = pos();
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
  }
  var clock = function (t) { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase(); };

  var banner = $('[data-live-banner]'), presenceEl = $('[data-live-presence]'), chatEl = $('[data-live-chat]'), raiseEl = $('[data-live-raise]'), ask = $('[data-ask]');

  // ── Chat panel ──
  var list = null, pinBox = null, form = null, countEl = null, msgs = {}, total = 0, unread = 0, open = false;
  var mobile = window.matchMedia ? window.matchMedia('(max-width: 720px)') : { matches: false };
  if (L.chat && chatEl) {
    var heading = cfg.replay ? String(C.replayHeading || 'Chat from the {time} showing').replace('{time}', clock(cfg.startsAt)) : C.chatHeading;
    chatEl.innerHTML =
      '<button type="button" class="live-chat-head" data-live-toggle aria-expanded="false"><span class="live-chat-title">' + esc(heading) + '</span> <span class="live-count" data-live-count></span><span class="live-caret" aria-hidden="true"></span></button>' +
      '<div class="live-chat-body" data-live-body>' +
      '<p class="live-note">' + esc(cfg.replay ? C.replayNote : C.chatNote) + '</p>' +
      '<div class="live-pin" data-live-pin hidden></div>' +
      '<ol class="live-list" data-live-list aria-live="polite"><li class="live-empty">' + esc(cfg.replay ? C.replayEmpty : C.chatEmpty) + '</li></ol>' +
      (cfg.replay ? '' :
        '<form class="live-form" data-live-form hidden><div class="live-row"><input type="text" maxlength="400" autocomplete="off" placeholder="' + esc(C.chatPlaceholder) + '" aria-label="' + esc(C.chatPlaceholder) + '"><button class="btn btn-sm" type="submit">' + esc(C.chatSend) + '</button></div>' +
        '<label class="live-anon"><input type="checkbox" data-live-anon> ' + esc(C.anonToggle) + '</label><p class="live-err" data-live-err role="alert" hidden></p></form><p class="live-closed muted small" data-live-closed hidden>' + esc(C.chatClosed) + '</p>') +
      '</div>';
    chatEl.hidden = false;
    list = chatEl.querySelector('[data-live-list]'); pinBox = chatEl.querySelector('[data-live-pin]'); form = chatEl.querySelector('[data-live-form]'); countEl = chatEl.querySelector('[data-live-count]');
    var toggle = chatEl.querySelector('[data-live-toggle]');
    var setOpen = function (on) { open = on; chatEl.classList.toggle('open', on); toggle.setAttribute('aria-expanded', String(on)); if (on) { unread = 0; paintCount(); list.scrollTop = list.scrollHeight; } };
    toggle.addEventListener('click', function () { setOpen(!open); });
    setOpen(!mobile.matches);
    if (form) {
      var anon = form.querySelector('[data-live-anon]'), input = form.querySelector('input[type=text]'), err = form.querySelector('[data-live-err]'), btn = form.querySelector('button');
      anon.checked = store.get('wl_anon') === '1';
      anon.addEventListener('change', function () { store.set('wl_anon', anon.checked ? '1' : '0'); });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var text = input.value.trim();
        if (!text) return;
        btn.disabled = true; err.hidden = true;
        post(L.post, { text: text, anon: anon.checked }).then(function (r) {
          btn.disabled = false;
          if (r && r.ok && r.message) { input.value = ''; addMsg(r.message, true); }
          else { err.textContent = (r && r.error) || 'That didn’t send. Try again.'; err.hidden = false; }
        });
      });
    }
  }
  function paintCount() { if (countEl) countEl.textContent = total ? '· ' + total + (unread && !open ? ' new' : '') : ''; if (countEl) countEl.classList.toggle('has-new', Boolean(unread && !open)); }
  function msgHtml(m) {
    return '<span class="live-who' + (m.team ? ' team' : '') + '">' + esc(m.name) + (m.badge ? ' <span class="live-badge">' + esc(m.badge) + '</span>' : '') + '</span>' +
      '<span class="live-time">' + esc(clock(m.t)) + '</span><span class="live-text">' + m.html + '</span>';
  }
  function addMsg(m, mine) {
    if (!list) return;
    var el = msgs[m.id];
    if (m.deleted) { if (el) { el.remove(); delete msgs[m.id]; total--; } paintCount(); return; }
    if (el) return; // already shown (a pin change only)
    var near = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    var empty = list.querySelector('.live-empty'); if (empty) empty.remove();
    el = document.createElement('li');
    el.className = 'live-msg' + (m.team ? ' live-msg-team' : '') + (mine ? ' mine' : '');
    el.innerHTML = msgHtml(m);
    list.appendChild(el); msgs[m.id] = el; total++;
    if (!open && !mine) unread++;
    if (near || mine) list.scrollTop = list.scrollHeight;
    paintCount();
  }
  function paintPin(p) {
    if (!pinBox) return;
    if (!p) { pinBox.hidden = true; pinBox.innerHTML = ''; return; }
    pinBox.innerHTML = '<p class="live-pin-h">' + esc(C.pinned) + '</p>' + msgHtml(p);
    pinBox.hidden = false;
  }

  // ── Announcement banner ──
  var dismissed = store.get('wl_dismiss') || '';
  function paintBanner(a) {
    if (!banner) return;
    if (!a || a.id === dismissed) { banner.hidden = true; banner.removeAttribute('data-id'); return; }
    if (banner.getAttribute('data-id') === a.id) return;
    banner.setAttribute('data-id', a.id);
    banner.innerHTML = '<p class="live-banner-text">' + (a.by ? '<b>' + a.by + ':</b> ' : '') + a.html + '</p>' +
      (a.link ? '<a class="btn btn-sm" href="' + esc(a.link) + '" target="_blank" rel="noopener" data-live-go>' + (a.label || 'Open') + '</a>' : '') +
      '<button type="button" class="live-x" aria-label="Hide this announcement">×</button>';
    banner.hidden = false;
    banner.querySelector('.live-x').addEventListener('click', function () { dismissed = a.id; store.set('wl_dismiss', a.id); paintBanner(null); });
    var go = banner.querySelector('[data-live-go]');
    if (go && window.funnel) go.addEventListener('click', function () { window.funnel.track('cta_click', { id: 'webinar_announcement', label: a.id }); });
  }

  // ── Team replies to this viewer's questions (in the ask box) ──
  var replied = {}, repliesBox = null;
  function paintReplies(rs) {
    if (!ask || !rs || !rs.length) return;
    if (!repliesBox) { repliesBox = document.createElement('div'); repliesBox.className = 'live-replies'; ask.appendChild(repliesBox); }
    rs.forEach(function (r) {
      if (replied[r.id]) return;
      replied[r.id] = true;
      var el = document.createElement('div'); el.className = 'qa live-reply';
      el.innerHTML = '<p class="qa-q">' + r.q + '</p><p class="qa-a"><span class="qa-tag live-tag">' + esc(r.by) + '</span> ' + r.a + '</p>';
      repliesBox.prepend(el);
    });
  }

  // ── Get a call from Josh's team ($1M+) ──
  if (raiseEl && L.raise) {
    raiseEl.innerHTML = '<p class="room-moment-h">' + esc(C.raiseHeading) + '</p>' + (L.raised ? '<p class="small live-done">' + esc(C.raiseDone) + '</p>' :
      '<p class="small">' + esc(C.raiseBody) + '</p><button type="button" class="btn btn-sm" data-live-raise-btn>' + esc(C.raiseButton) + '</button>');
    raiseEl.hidden = false;
    var rb = raiseEl.querySelector('[data-live-raise-btn]');
    if (rb) rb.addEventListener('click', function () {
      rb.disabled = true;
      post(L.raiseUrl, {}).then(function (r) {
        if (r && r.ok) { rb.outerHTML = '<p class="small live-done">' + esc(r.message || C.raiseDone) + '</p>'; raiseEl.querySelector('.small').remove(); if (window.funnel) window.funnel.track('cta_click', { id: 'webinar_call_request' }); }
        else { rb.disabled = false; rb.insertAdjacentHTML('afterend', '<p class="live-err">' + esc((r && r.error) || 'That didn’t go through. Try again.') + '</p>'); }
      });
    });
  }

  // ── Feed ──
  var after = 0, since = 0, n = 0, timer = null;
  function poll() {
    // Presence every ~16 s at the 4 s pace, every poll at the 15 s pace (the server window is 45 s).
    var withPresence = slow() || n % 4 === 0; n++;
    post(L.feed, { after: after, since: since, presence: withPresence }).then(function (r) {
      if (!r || !r.ok) return;
      since = r.now;
      if (presenceEl) {
        var bits = [r.presence && r.presence.line, r.presence && r.presence.host].filter(Boolean);
        presenceEl.innerHTML = bits.map(esc).join(' ');
        presenceEl.hidden = !bits.length;
        presenceEl.classList.toggle('with-host', Boolean(r.presence && r.presence.host));
      }
      paintBanner(r.announcement);
      paintReplies(r.replies);
      if (r.chat) {
        (r.chat.messages || []).forEach(function (m) { addMsg(m, false); });
        after = Math.max(after, r.chat.cursor || 0);
        paintPin(r.chat.pinned);
        if (form) { form.hidden = !r.chat.canPost; var cl = chatEl.querySelector('[data-live-closed]'); if (cl) cl.hidden = r.chat.canPost || r.stage === 'waiting'; }
      }
    });
  }
  // Every 4 s while watching; 15 s in the replay (the chat is read-only there) and when the tab is hidden.
  function slow() { return Boolean(document.hidden || cfg.replay); }
  function schedule() {
    clearTimeout(timer);
    var every = slow() ? 15000 : 4000;
    timer = setTimeout(function () { poll(); schedule(); }, every);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { n = 0; poll(); } schedule(); });
  poll(); schedule();
})();

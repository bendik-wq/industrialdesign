/* Live player: a live event (live webinar session, challenge day) on Zoom.
 * window.LivePlayer.mount(el, cfg) draws a calm "Join on Zoom" card: the start time and a real countdown, the
 * "Open Zoom" button (new tab) once the link opens, and a note that the page stays useful.
 * cfg = { key, playback: { mode, isLive, joinUrl, startsAt, endsAt, provider }, serverNow?, statusUrl?, poll?, onJoin?(url),
 *         note?, title? }
 * Liveness is the schedule only (the server's own rule): "live" = from 10 minutes before the start to the scheduled end.
 * Polls GET /api/live/:key/status (public: isLive, startsAt, endsAt, hasLink; never the link) every 10 seconds. */
(function () {
  'use strict';
  var OPENS_MIN = 10;
  var CSS = '' +
    '.lp{background:#f5f5f7;border-radius:18px;padding:32px 24px;text-align:center;color:#1d1d1f;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.lp .lp-eyebrow{margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:.02em;color:#0f2c5c;display:inline-flex;align-items:center;gap:8px}' +
    '.lp .lp-dot{width:8px;height:8px;border-radius:50%;background:#1f8a3b;box-shadow:0 0 0 4px rgba(31,138,59,.15)}' +
    '.lp .lp-title{margin:0 0 8px;font-family:Newsreader,Georgia,serif;font-weight:500;font-size:clamp(26px,5vw,36px);line-height:1.15;letter-spacing:-.01em}' +
    '.lp .lp-when{margin:0 0 20px;font-size:15px;color:#515154}' +
    '.lp .lp-count{margin:0 0 24px;font-size:clamp(28px,6vw,40px);font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}' +
    '.lp .lp-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:52px;min-width:220px;padding:0 28px;border-radius:999px;border:0;background:#1d1d1f;color:#fff;font:600 17px/1 system-ui,-apple-system,sans-serif;text-decoration:none;cursor:pointer;transition:transform .2s ease,background .2s ease}' +
    '.lp .lp-btn:hover{background:#000}.lp .lp-btn:active{transform:scale(.98)}.lp .lp-btn:focus-visible{outline:2px solid #0f2c5c;outline-offset:3px}' +
    '.lp .lp-btn[aria-disabled=true]{background:#d2d2d7;color:#515154;cursor:default;transform:none}' +
    '.lp .lp-note{margin:20px auto 0;max-width:420px;font-size:14px;color:#6e6e73;line-height:1.45}' +
    '.lp .lp-sub{margin:10px 0 0;font-size:13px;color:#6e6e73}' +
    '@media (min-width:700px){.lp{padding:48px 40px}}' +
    '@media (prefers-reduced-motion:reduce){.lp .lp-btn{transition:none}}';

  function injectCss() {
    if (document.getElementById('lp-css')) return;
    var s = document.createElement('style'); s.id = 'lp-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmtWhen(ms) {
    try { return new Date(ms).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); }
    catch (e) { return new Date(ms).toString(); }
  }
  function fmtTime(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function fmtLeft(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    if (d) return d + 'd ' + h + 'h ' + m + 'm';
    if (h) return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function mount(root, cfg) {
    if (!root) return null;
    cfg = cfg || {};
    injectCss();
    var pb = {};
    var src = cfg.playback || {};
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) pb[k] = src[k];
    var hasLink = pb.mode === 'link';
    var skew = cfg.serverNow ? cfg.serverNow - Date.now() : 0;
    var now = function () { return Date.now() + skew; };
    var reloaded = false, timer = null, poller = null, last = '';

    var card = el('div', 'lp'); card.setAttribute('role', 'region'); card.setAttribute('aria-label', 'Live session');
    var eyebrow = el('p', 'lp-eyebrow'), title = el('h2', 'lp-title'), when = el('p', 'lp-when'), count = el('p', 'lp-count');
    count.setAttribute('aria-live', 'off');
    var btn = el('a', 'lp-btn'); btn.target = '_blank'; btn.rel = 'noopener';
    var sub = el('p', 'lp-sub');
    var note = el('p', 'lp-note', cfg.note || 'Keep this page open: the offer, chat and your worksheet stay here.');
    card.appendChild(eyebrow); card.appendChild(title); card.appendChild(when); card.appendChild(count); card.appendChild(btn); card.appendChild(sub); card.appendChild(note);
    root.innerHTML = ''; root.appendChild(card);

    btn.addEventListener('click', function (e) {
      if (btn.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
      if (typeof cfg.onJoin === 'function') { try { cfg.onJoin(pb.joinUrl); } catch (err) { /* tracking only */ } }
    });

    // The server hands the link out only from 10 minutes before the start: reload once to pick it up.
    function needLink() {
      if (reloaded) return;
      reloaded = true;
      if (typeof cfg.onNeedLink === 'function') return cfg.onNeedLink();
      setTimeout(function () { location.reload(); }, 1500 + Math.random() * 3000);
    }

    function render() {
      var t = now(), start = pb.startsAt || null, end = pb.endsAt || null;
      var opens = start ? start - OPENS_MIN * 60000 : null;
      var label = pb.provider === 'other' ? 'Join the live session' : 'Open Zoom';
      var state = !start ? 'unscheduled' : t < opens ? 'before' : t < end ? 'live' : 'after';
      var eb, ti, wh = '', ct = '', bt = label, on = false, sb = '', dot = false;
      if (state === 'before') {
        eb = pb.provider === 'other' ? 'Live session' : 'On Zoom';
        ti = 'We start at ' + fmtTime(start);
        wh = fmtWhen(start);
        ct = fmtLeft(start - t);
        bt = 'Opens at ' + fmtTime(opens);
      } else if (state === 'live') {
        dot = t >= start;
        eb = t >= start ? (pb.provider === 'other' ? 'Live now' : 'Live now on Zoom') : 'Doors open';
        ti = t >= start ? 'The session is on' : 'We start at ' + fmtTime(start);
        wh = t >= start ? 'Started at ' + fmtTime(start) : fmtWhen(start);
        ct = t < start ? fmtLeft(start - t) : '';
        on = Boolean(pb.joinUrl);
        if (!pb.joinUrl) { bt = hasLink ? 'Getting your link' : 'The link appears here'; if (hasLink) needLink(); }
      } else if (state === 'after') {
        eb = 'Live session';
        ti = 'The scheduled time has ended';
        wh = 'Scheduled ' + fmtTime(start) + ' to ' + fmtTime(end);
        on = Boolean(pb.joinUrl);
        if (on) sb = 'If the host is still on, the link still works.';
        else bt = 'Session ended';
      } else {
        eb = pb.provider === 'other' ? 'Live session' : 'On Zoom';
        ti = cfg.title || 'Join the live session';
        on = Boolean(pb.joinUrl);
        if (!on) bt = 'The link appears here';
      }
      if (!hasLink && state !== 'after') { sb = 'The join link appears here before the start.'; on = false; if (state !== 'before') bt = 'The link appears here'; }
      var sig = [eb, ti, wh, ct, bt, on, sb, dot].join('|');
      if (sig === last) return state;
      last = sig;
      eyebrow.textContent = ''; if (dot) eyebrow.appendChild(el('span', 'lp-dot')); eyebrow.appendChild(document.createTextNode(eb));
      title.textContent = ti;
      when.textContent = wh; when.hidden = !wh;
      count.textContent = ct; count.hidden = !ct;
      btn.textContent = bt;
      if (on) { btn.href = pb.joinUrl; btn.removeAttribute('aria-disabled'); btn.removeAttribute('tabindex'); }
      else { btn.removeAttribute('href'); btn.setAttribute('aria-disabled', 'true'); btn.setAttribute('role', 'link'); }
      sub.textContent = sb; sub.hidden = !sb;
      return state;
    }

    function poll() {
      if (!cfg.key || cfg.poll === false) return;
      var url = cfg.statusUrl || '/api/live/' + encodeURIComponent(cfg.key) + '/status';
      fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
        if (!s) return;
        pb.isLive = Boolean(s.isLive);
        if (s.startsAt !== undefined) pb.startsAt = s.startsAt;
        if (s.endsAt !== undefined) pb.endsAt = s.endsAt;
        if (s.hasLink && !hasLink) { hasLink = true; if (!pb.joinUrl && pb.startsAt && now() >= pb.startsAt - OPENS_MIN * 60000) needLink(); }
        if (!s.hasLink) { hasLink = false; pb.joinUrl = null; }
        render();
      }).catch(function () { /* try again next time */ });
    }

    render();
    timer = setInterval(function () { if (render() === 'after' && !pb.joinUrl && poller) { clearInterval(poller); poller = null; } }, 1000);
    if (cfg.key && cfg.poll !== false) poller = setInterval(poll, 10000);
    return {
      update: function (next) { for (var k2 in next) if (Object.prototype.hasOwnProperty.call(next, k2)) pb[k2] = next[k2]; hasLink = pb.mode === 'link'; last = ''; render(); },
      destroy: function () { clearInterval(timer); if (poller) clearInterval(poller); root.innerHTML = ''; },
    };
  }

  window.LivePlayer = { mount: mount };
})();

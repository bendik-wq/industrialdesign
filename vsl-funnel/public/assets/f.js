/* Funnel tracker: tiny, dependency-free, first-party.
 * The server already logged the page view; this adds what only the browser
 * knows (screen, scroll, engagement, clicks) and exposes window.funnel. */
(function () {
  'use strict';
  var cfg = window.FUNNEL || {};
  var queue = [];
  var flushTimer = null;
  var path = location.pathname;

  function uid() {
    var a = new Uint8Array(10);
    crypto.getRandomValues(a);
    return 'c' + Date.now().toString(36) + Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join('');
  }

  function send(url, payload, preferBeacon) {
    var body = JSON.stringify(payload);
    if (preferBeacon && navigator.sendBeacon) {
      // text/plain avoids a CORS preflight; the server parses the raw body.
      if (navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return Promise.resolve();
    }
    return fetch(url, { method: 'POST', body: body, headers: { 'content-type': 'text/plain' }, keepalive: true, credentials: 'same-origin' }).catch(function () {});
  }

  function flush(useBeacon) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!queue.length) return;
    var events = queue.splice(0, 25);
    send('/api/e', { path: path, url: location.href, events: events }, useBeacon);
    if (queue.length) flush(useBeacon);
  }

  /** Track an interaction. Returns the event id (shared with the Meta Pixel for dedup). */
  function track(name, props, eventId) {
    var eid = eventId || uid();
    queue.push({ n: name, p: props || {}, eid: eid });
    if (!flushTimer) flushTimer = setTimeout(flush, 800);
    return eid;
  }

  /** Mirror a server/client conversion to the browser pixel with the same event id. */
  function pixel(eventName, eventId, data, custom) {
    if (!cfg.pixel || typeof window.fbq !== 'function') return;
    window.fbq(custom ? 'trackCustom' : 'track', eventName, data || {}, eventId ? { eventID: eventId } : undefined);
  }

  window.funnel = { cfg: cfg, track: track, flush: flush, pixel: pixel, uid: uid, send: send };

  // Browser context, once per session.
  try {
    var metaKey = 'f_meta_' + cfg.sessionId;
    if (cfg.sessionId && !sessionStorage.getItem(metaKey)) {
      var conn = navigator.connection && navigator.connection.effectiveType;
      send('/api/e', {
        path: path,
        meta: {
          lang: navigator.language,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          screen: screen.width + 'x' + screen.height,
          viewport: innerWidth + 'x' + innerHeight,
          dpr: window.devicePixelRatio || 1,
          conn: conn || null
        }
      });
      sessionStorage.setItem(metaKey, '1');
    }
  } catch (e) { /* storage blocked: fine */ }

  // Scroll depth milestones.
  var depths = [25, 50, 75, 100];
  var sent = {};
  function onScroll() {
    var doc = document.documentElement;
    var max = doc.scrollHeight - innerHeight;
    var pct = max <= 0 ? 100 : Math.round((scrollY / max) * 100);
    for (var i = 0; i < depths.length; i++) {
      if (pct >= depths[i] && !sent[depths[i]]) { sent[depths[i]] = 1; track('scroll_depth', { pct: depths[i] }); }
    }
  }
  addEventListener('scroll', onScroll, { passive: true });

  // Engaged time: only while the tab is visible and the user was active recently.
  var engaged = 0;
  var last = Date.now();
  var lastActive = Date.now();
  ['mousemove', 'keydown', 'scroll', 'touchstart', 'click'].forEach(function (ev) {
    addEventListener(ev, function () { lastActive = Date.now(); }, { passive: true });
  });
  setInterval(function () {
    var now = Date.now();
    var playing = document.querySelector('video') && !document.querySelector('video').paused;
    if (document.visibilityState === 'visible' && (now - lastActive < 30000 || playing)) engaged += now - last;
    last = now;
  }, 1000);
  function reportEngaged() {
    if (engaged > 1000) { track('engaged_time', { ms: engaged }); engaged = 0; }
    flush(true);
  }
  addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') reportEngaged(); });
  addEventListener('pagehide', reportEngaged);

  // Declarative click tracking: <a data-track="cta_click" data-track-id="...">
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-track], a[href]');
    if (!el) return;
    if (el.hasAttribute('data-track')) {
      track(el.getAttribute('data-track'), { id: el.getAttribute('data-track-id') || '', label: (el.textContent || '').trim().slice(0, 80) });
      flush(true);
    } else if (el.host && el.host !== location.host) {
      track('outbound_click', { href: el.href.slice(0, 200) });
      flush(true);
    }
  });

  // Rage clicks (3+ clicks within 700ms on the same element) reveal broken-looking UI.
  var clicks = [];
  document.addEventListener('click', function (e) {
    var now = Date.now();
    clicks = clicks.filter(function (c) { return now - c.t < 700 && c.el === e.target; });
    clicks.push({ t: now, el: e.target });
    if (clicks.length === 3) {
      var t = e.target;
      track('rage_click', { selector: (t.tagName || '').toLowerCase() + (t.className && typeof t.className === 'string' ? '.' + t.className.split(' ')[0] : '') });
    }
  });

  // FAQ opens.
  document.addEventListener('toggle', function (e) {
    var d = e.target;
    if (d.matches && d.matches('details.faq') && d.open) {
      var s = d.querySelector('summary');
      track('faq_open', { q: s ? s.textContent.trim().slice(0, 120) : '' });
    }
  }, true);

  // Exit intent (desktop): cursor leaves through the top of the window.
  var exitSent = false;
  document.addEventListener('mouseout', function (e) {
    if (!exitSent && !e.relatedTarget && e.clientY <= 0) { exitSent = true; track('exit_intent', {}); }
  });

  // EU consent banner.
  if (cfg.consentRequired && !cfg.consentGiven && document.cookie.indexOf('_fc=') === -1) {
    var box = document.createElement('div');
    box.className = 'consent';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Cookie consent');
    box.innerHTML = '<p>We use cookies to measure our ads and improve this site. Is that OK?</p><div class="row"><button type="button" data-c="0">No thanks</button><button type="button" class="yes" data-c="1">Accept</button></div>';
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var granted = b.getAttribute('data-c') === '1';
      send('/api/consent', { granted: granted }).then(function () { if (granted) location.reload(); });
      track('consent_update', { granted: granted });
      box.remove();
    });
    document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(box); });
    if (document.readyState !== 'loading') document.body.appendChild(box);
  }
})();

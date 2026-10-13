/* Funnel tracker: tiny, dependency-free, first-party.
 * The server already logged the page view; this adds what only the browser
 * knows (screen, scroll, engagement, clicks) and exposes window.funnel. */
(function () {
  'use strict';
  var cfg = window.FUNNEL || {};
  var queue = [];
  var flushTimer = null;
  var path = (window.FUNNEL && window.FUNNEL.page) || location.pathname;

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

  // Which sections they actually read: visible time per section (≥40% on screen, tab in front).
  var dwell = {}, visible = {}, lastTick = Date.now();
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { var id = en.target.getAttribute('data-section') || en.target.id || ''; if (id) visible[id] = en.intersectionRatio >= 0.4; });
    }, { threshold: [0, 0.4, 0.8] });
    document.querySelectorAll('[data-section], section[id]').forEach(function (el) { io.observe(el); });
    setInterval(function () {
      var now = Date.now(), dt = now - lastTick; lastTick = now;
      if (document.visibilityState !== 'visible' || dt > 5000) return;
      Object.keys(visible).forEach(function (id) { if (visible[id]) dwell[id] = (dwell[id] || 0) + dt; });
    }, 1000);
    var reportDwell = function () {
      var out = {}, any = false;
      Object.keys(dwell).forEach(function (id) { if (dwell[id] >= 2000) { out[id] = Math.round(dwell[id] / 1000); any = true; } });
      if (any) { track('section_dwell', out); dwell = {}; }
    };
    addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') reportDwell(); });
    addEventListener('pagehide', reportDwell);
  }


  // ── Deep behaviour tracking (never records what people type) ─────────────
  var t0 = Date.now(), firstDone = false, deepSent = 0, LIMIT = 150;
  function cap(name, props) { if (deepSent++ < LIMIT) track(name, props); }
  function sectionOf(el) { var s = el && el.closest && el.closest('[data-section], section[id]'); return s ? (s.getAttribute('data-section') || s.id) : null; }
  function describe(el) {
    if (!el || !el.tagName) return '';
    var d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    var c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    if (c) d += '.' + c;
    var tid = el.getAttribute && (el.getAttribute('data-track-id') || el.getAttribute('data-q') || el.getAttribute('data-v'));
    if (tid) d += '[' + tid + ']';
    return d.slice(0, 80);
  }
  function first(type) { if (!firstDone) { firstDone = true; cap('first_interaction', { type: type, ms: Date.now() - t0 }); } }
  ['scroll', 'keydown', 'pointerdown'].forEach(function (ev) { addEventListener(ev, function () { first(ev); }, { passive: true, once: true }); });

  // Every click: what, where on the page, which section, and whether it did anything.
  var INTERACTIVE = 'a,button,input,select,textarea,label,summary,video,[role=button],[data-v],.opt,[onclick]';
  document.addEventListener('click', function (e) {
    var t = e.target, hit = t.closest && t.closest(INTERACTIVE);
    var doc = document.documentElement;
    var isField = hit && /^(INPUT|TEXTAREA|SELECT)$/.test(hit.tagName);
    var text = !isField && hit ? (hit.innerText || hit.value || '').trim().replace(/\s+/g, ' ').slice(0, 60) : '';
    cap('click', {
      el: describe(hit || t), text: text, section: sectionOf(t),
      x: Math.round((e.pageX / Math.max(1, doc.scrollWidth)) * 100), y: Math.round((e.pageY / Math.max(1, doc.scrollHeight)) * 100),
      dead: hit ? 0 : 1,
    });
  }, true);

  // Hovering a call-to-action for a while without clicking it = hesitation.
  document.addEventListener('pointerover', function (e) {
    var cta = e.target.closest && e.target.closest('[data-track="cta_click"], .btn');
    if (!cta || cta._hov) return;
    cta._hov = Date.now();
    var leave = function () {
      cta.removeEventListener('pointerleave', leave);
      var ms = Date.now() - cta._hov; cta._hov = 0;
      if (ms >= 800 && !cta._clicked) cap('cta_hover', { id: cta.getAttribute('data-track-id') || describe(cta), ms: ms });
    };
    cta.addEventListener('pointerleave', leave);
    cta.addEventListener('click', function () { cta._clicked = 1; }, { once: true });
  });

  // Form fields: time spent, corrections, pastes, left empty. Values are never read.
  var fieldState = {};
  document.addEventListener('focusin', function (e) {
    var f = e.target;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName) || f.type === 'hidden' || f.type === 'password') return;
    var key = f.name || f.id || describe(f);
    fieldState[key] = { at: Date.now(), start: (f.value || '').length, corrections: 0, pasted: 0 };
  });
  document.addEventListener('keydown', function (e) {
    var f = e.target, st = fieldState[f.name || f.id || describe(f)];
    if (st && (e.key === 'Backspace' || e.key === 'Delete')) st.corrections++;
  });
  document.addEventListener('paste', function (e) {
    var f = e.target, st = fieldState[f.name || f.id || describe(f)];
    if (st) st.pasted = 1;
  });
  document.addEventListener('focusout', function (e) {
    var f = e.target, key = f.name || f.id || describe(f), st = fieldState[key];
    if (!st) return;
    delete fieldState[key];
    var ms = Date.now() - st.at;
    if (ms < 300) return;
    var len = f.type === 'checkbox' ? (f.checked ? 1 : 0) : (f.value || '').length;
    cap('field_interaction', { field: key.slice(0, 40), ms: ms, chars: len, changed: len !== st.start ? 1 : 0, corrections: st.corrections, pasted: st.pasted, empty: len ? 0 : 1 });
  });

  // Leaving the tab and coming back (comparing, checking something, distracted).
  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt) { var away = Math.round((Date.now() - hiddenAt) / 1000); hiddenAt = 0; if (away >= 5) cap('tab_return', { away_s: away }); }
  });

  // Highlighting text (people often select what they're thinking about).
  var lastSel = '';
  // Never inside form fields: selecting or copying there would capture what the person typed.
  function inField() {
    var a = document.activeElement;
    if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return true;
    var n = window.getSelection && window.getSelection().anchorNode;
    var el = n && (n.nodeType === 1 ? n : n.parentElement);
    return Boolean(el && el.closest && el.closest('form, input, textarea, [contenteditable], [data-no-track]'));
  }
  // Phone numbers with spaces/dashes, emails and long digit runs are dropped too.
  function piiLike(t) { return /@|\d{6,}|\+?\d[\d\s().-]{6,}\d/.test(t); }
  document.addEventListener('mouseup', function () {
    if (inField()) return;
    var t = String(window.getSelection ? window.getSelection() : '').trim();
    if (t.length >= 15 && t !== lastSel && !piiLike(t)) { lastSel = t; cap('text_select', { text: t.slice(0, 120), section: sectionOf(window.getSelection().anchorNode && window.getSelection().anchorNode.parentElement) }); }
  });

  // Coming back to a section after scrolling away from it.
  if ('IntersectionObserver' in window) {
    var seenSec = {}, leftSec = {}, revisited = {}, lastSec = null;
    var io2 = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var id = en.target.getAttribute('data-section') || en.target.id;
        if (!id) return;
        if (en.isIntersecting) {
          lastSec = id;
          if (leftSec[id] && !revisited[id]) { revisited[id] = 1; cap('section_revisit', { section: id }); }
          seenSec[id] = 1;
        } else if (seenSec[id]) leftSec[id] = 1;
      });
    }, { threshold: 0.5 });
    document.querySelectorAll('[data-section], section[id]').forEach(function (el) { io2.observe(el); });
    // Where they were when they left.
    var exited = false;
    addEventListener('pagehide', function () {
      if (exited) return; exited = true;
      var doc = document.documentElement, max = doc.scrollHeight - innerHeight;
      track('page_exit', { section: lastSec, scroll: max > 0 ? Math.round((scrollY / max) * 100) : 100, s: Math.round((Date.now() - t0) / 1000), interacted: firstDone ? 1 : 0 });
      flush(true);
    });
  }

  // Copied text (a strong intent signal, e.g. copying the guarantee or a FAQ answer).
  document.addEventListener('copy', function () {
    if (inField()) return;
    var t = String(window.getSelection ? window.getSelection() : '').trim();
    if (t && !piiLike(t)) track('text_copy', { text: t.slice(0, 120) });
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

  // Consent banner (EU, UK, EEA, CH), plus a "Cookie settings" link so a choice can be changed later.
  if (cfg.consentRequired) {
    var showBanner = function () {
      if (document.querySelector('.consent')) return;
      var box = document.createElement('div');
      box.className = 'consent';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', 'Cookie consent');
      box.innerHTML = '<p>We use cookies to measure our ads and improve this site. Is that OK? <a href="/privacy">Privacy policy</a></p><div class="row"><button type="button" data-c="0">No thanks</button><button type="button" class="yes" data-c="1">Accept</button></div>';
      box.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        var granted = b.getAttribute('data-c') === '1';
        var changed = granted !== Boolean(cfg.consentGiven);
        track('consent_update', { granted: granted });
        send('/api/consent', { granted: granted }).then(function () { if (changed) location.reload(); });
        box.remove();
      });
      document.body.appendChild(box);
    };
    var settingsLink = function () {
      var a = document.createElement('button');
      a.type = 'button';
      a.className = 'consent-settings';
      a.textContent = 'Cookie settings';
      a.addEventListener('click', showBanner);
      document.body.appendChild(a);
    };
    var start = function () { if (!cfg.consentGiven && document.cookie.indexOf('_fc=') === -1) showBanner(); settingsLink(); };
    if (document.readyState !== 'loading') start(); else document.addEventListener('DOMContentLoaded', start);
  }
})();

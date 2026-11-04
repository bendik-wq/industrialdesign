/* Funnel HQ shared UX (overnight round 3, hq-ux): one set of number formatters, the loading / empty / error
   states every tab uses, and the "Jump to" command palette (Ctrl+K / Cmd+K). Loaded before admin.js.
   The formatters are plain functions with no DOM, so test/hq-ux.test.ts imports this file directly. */
(function (root) {
  'use strict';

  // ───────────── formatters ─────────────
  var DASH = '–';
  var fmtCache = {};
  function nf(locale, o) {
    var k = (locale || '') + JSON.stringify(o);
    if (!fmtCache[k]) fmtCache[k] = new Intl.NumberFormat(locale, o);
    return fmtCache[k];
  }
  function bad(v) { return v == null || v === '' || !isFinite(Number(v)); }

  /** 1234.5 → "1,235"; num(1234.5, 1) → "1,234.5". Nothing → "–". */
  function num(v, dp, locale) {
    if (bad(v)) return DASH;
    dp = dp || 0;
    return nf(locale, { maximumFractionDigits: dp, minimumFractionDigits: dp }).format(dp ? Number(v) : Math.round(Number(v)));
  }

  /** A ratio as a percentage: 0.25 → "25%". Below 10% (and above 0) one decimal, so small rates don't all read "0%". */
  function pct(v, dp) {
    if (bad(v)) return DASH;
    v = Number(v);
    return (v * 100).toFixed(dp == null ? (v < 0.1 && v > 0 ? 1 : 0) : dp) + '%';
  }

  /** Money in a given currency; an unknown currency code falls back to "XYZ 1,234". */
  function money(v, cur, dp, locale) {
    if (bad(v)) return DASH;
    dp = dp || 0;
    cur = String(cur || 'USD').toUpperCase();
    try { return nf(locale, { style: 'currency', currency: cur, maximumFractionDigits: dp, minimumFractionDigits: dp }).format(Number(v)); }
    catch (e) { return cur + ' ' + num(v, dp, locale); }
  }

  /** Return on spend and other multiples: 2.345 → "2.35×". */
  function ratio(v, dp) {
    if (bad(v)) return DASH;
    return Number(v).toFixed(dp == null ? 2 : dp) + '×';
  }

  /** Seconds as "45s" or "3m 05s". */
  function secs(v) {
    v = Math.round(Number(v) || 0);
    if (v < 60) return v + 's';
    var s = v % 60;
    return Math.floor(v / 60) + 'm ' + (s < 10 ? '0' : '') + s + 's';
  }

  /** Short counts for tight spaces: 950 → "950", 12_400 → "12.4k", 3_100_000 → "3.1M". */
  function compact(v) {
    if (bad(v)) return DASH;
    v = Number(v);
    var a = Math.abs(v);
    if (a < 1000) return String(Math.round(v));
    if (a < 1e6) return (Math.round(v / 100) / 10).toString().replace(/\.0$/, '') + 'k';
    return (Math.round(v / 1e5) / 10).toString().replace(/\.0$/, '') + 'M';
  }

  /** The message to show for a failed request: the server's own words when it sent JSON, otherwise the status. */
  function errorMessage(status, body, path) {
    var msg = '';
    if (body && typeof body === 'object') msg = body.error || body.message || '';
    else if (typeof body === 'string') {
      var t = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      msg = t.slice(0, 200);
    }
    var where = path ? ' (' + String(path).split('?')[0] + ')' : '';
    if (!msg) msg = status ? 'The server answered ' + status + where : 'No answer from the server' + where;
    else if (status) msg += ' [' + status + where + ']';
    return msg;
  }

  /** Is this a network failure (offline, DNS, connection reset) rather than a bug? */
  function isNetworkError(e) {
    var m = String((e && e.message) || e || '');
    return /Failed to fetch|NetworkError|Load failed|Network request failed|network connection was lost/i.test(m);
  }

  /** Rank palette items against a query. Higher is better; 0 means no match. */
  function score(item, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return 1;
    var label = String(item.label || '').toLowerCase(), kw = String(item.keywords || '').toLowerCase(), grp = String(item.group || '').toLowerCase();
    if (label === q) return 100;
    if (label.indexOf(q) === 0) return 80;
    var words = label.split(/[^a-z0-9]+/);
    for (var i = 0; i < words.length; i++) if (words[i] && words[i].indexOf(q) === 0) return 60;
    if (label.indexOf(q) > -1) return 40;
    if ((' ' + kw + ' ').indexOf(' ' + q) > -1) return 30;
    if (kw.indexOf(q) > -1 || grp.indexOf(q) === 0) return 20;
    // Letters in order ("emed" → "Email editor").
    var j = 0;
    for (var k = 0; k < label.length && j < q.length; k++) if (label[k] === q[j]) j++;
    return j === q.length && q.length >= 4 ? 5 : 0; // short queries only match real words, not scattered letters
  }
  function rank(items, q) {
    return items.map(function (it, i) { return { it: it, s: score(it, q), i: i }; })
      .filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s || a.i - b.i; })
      .map(function (x) { return x.it; });
  }

  // ───────────── what fills each tab, and where to set it up ─────────────
  // Shown under a tab's first empty state, so an empty panel says what will appear and where to start.
  var TAB_HELP = {
    home: ['What needs you, today’s numbers and what is coming up, from every part of Funnel HQ.', 'integrations', 'Open Integrations'],
    command: ['Approvals, activity and routines appear as the departments work. Chat needs the Anthropic API key.', 'integrations', 'Open Integrations'],
    overview: ['Visits, leads and calls from the funnel pages.', 'screens', 'Preview the funnel pages'],
    live: ['People on the site right now and what they did.', 'screens', 'Preview the funnel pages'],
    leads: ['Everyone who starts the application.', 'application', 'See the application'],
    dminbox: ['Instagram DMs, comments and Story replies once Meta is connected.', 'integrations', 'Connect Meta'],
    sales: ['Calls booked through the calendar and the outcomes you log.', 'integrations', 'Connect the calendar'],
    salesops: ['Quiet leads, no-shows and unpaid checkouts.', 'leads', 'Open Leads'],
    clients: ['Anyone who paid for the Sprint, paid the deposit or signed the agreement.', 'contracts', 'Open Agreements'],
    insights: ['Leads who booked a call, split by tier.', 'sales', 'Open Calls & deals'],
    finance: ['Live rates come from the funnel and ad costs from the Meta spend sync.', 'integrations', 'Connect Meta'],
    contracts: ['Agreements you draft here.', '', ''],
    pages: ['Visits to the main page and the industry landers.', 'links', 'Make tracked links'],
    vsl: ['Video plays on the landing, breakout and pre-call pages.', 'screens', 'Preview the pages'],
    application: ['Visitors who open the application.', 'screens', 'Preview the application'],
    behaviour: ['Clicks, scrolls and form timing from the funnel pages.', 'screens', 'Preview the pages'],
    search: ['Visits from search engines and AI answers, and crawler hits on the public pages.', 'pages', 'Open Landing pages'],
    content: ['Josh’s YouTube and Instagram videos.', 'integrations', 'Open Integrations'],
    studio: ['Recordings, their edits and the scripts live on the Studio page.', null, null],
    radar: ['Top videos and Meta ads live in Studio under Radar.', null, null],
    ytideas: ['Topics planned from applicant answers and video results.', 'content', 'Open Content'],
    traffic: ['Visits with UTM tags and click ids.', 'links', 'Make tracked links'],
    autopilot: ['Meta ad results, read every hour once Meta is connected.', 'integrations', 'Connect Meta'],
    audiences: ['Bookings, registrations and purchases sent to Meta.', 'integrations', 'Connect Meta'],
    links: ['Tracked links you make here.', '', ''],
    webinar: ['Masterclass registrations, sessions and watch time.', 'integrations', 'Open Integrations'],
    liveevents: ['Live webinars you schedule here.', '', ''],
    rooms: ['Rooms for live events, challenge days and meetings.', 'integrations', 'Open Integrations'],
    dealsprint: ['First Deal Sprint buyers.', 'liveevents', 'Open Live webinars'],
    challenge: ['Challenge cohorts you create here. Selling the ticket needs Whop.', 'integrations', 'Connect Whop'],
    wattrib: ['Registrations and purchases from the webinars and the challenge.', 'webinar', 'Open Webinar'],
    research: ['Reddit, the Meta Ad Library and YouTube, collected once a day.', 'integrations', 'Open Integrations'],
    support: ['Support email and questions from the rooms.', 'integrations', 'Connect support email'],
    emails: ['Emails the sequences send.', 'integrations', 'Connect email'],
    reactivation: ['Past leads already in the database.', 'leads', 'Open Leads'],
    winback: ['Cold leads that match a campaign’s rules.', 'leads', 'Open Leads'],
    sms: ['Texts and WhatsApp messages once Twilio is connected.', 'integrations', 'Connect Twilio'],
    voice: ['AI calls once ElevenLabs or Vapi is connected.', 'integrations', 'Connect AI calls'],
    team: ['Reps you add here.', 'integrations', 'Open Integrations'],
    tracking: ['Conversions sent to Meta and GA4 from the server.', 'integrations', 'Connect Meta and GA4'],
    errors: ['Errors from pages, webhooks, cron jobs and rooms.', '', ''],
    guests: ['Guest links you make, who used them and when.', '', ''],
  };

  // ───────────── states (HTML) ─────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /** Placeholder shapes while a tab loads, in the layout most tabs use (a row of tiles, then cards). */
  function skeleton(title) {
    var tile = '<div class="hq-skel-tile"><i></i><b></b></div>';
    return '<div class="hq-skel" aria-hidden="true"><div class="grid g-4 tiles">' + tile + tile + tile + tile + '</div>' +
      '<div class="hq-skel-card"><i></i><b></b><b></b><b></b></div><div class="hq-skel-card"><i></i><b></b><b></b></div></div>' +
      '<p class="sr-only" role="status">Loading ' + esc(title || 'this view') + '…</p>';
  }

  /** The one error panel: what went wrong in the server's words, and a Retry button. */
  function errorState(message, o) {
    o = o || {};
    var net = isNetworkError(message);
    var head = net ? 'Couldn’t reach Funnel HQ.' : 'Couldn’t load ' + (o.what || 'this view') + '.';
    var detail = net ? 'Check the connection, then try again.' : String(message && message.message || message || 'Unknown error');
    return '<div class="hq-error" role="alert"><strong>' + esc(head) + '</strong><p class="mono">' + esc(detail) + '</p>' +
      '<div class="row"><button type="button" class="btn-sm" data-hq-retry>Retry</button>' +
      (o.tab !== 'errors' ? '<a class="btn-sm ghost" href="#errors" data-go="errors">Open the error log</a>' : '') + '</div></div>';
  }

  /** Under the first empty state in a tab with nothing to say how to fill it: what appears here and where to set it up. */
  function decorateEmpty(view, tab) {
    var h = TAB_HELP[tab];
    if (!h || !view) return;
    var el = view.querySelector('.empty:not([data-hq-help])');
    if (!el || el.querySelector('a, button') || el.querySelector('.empty-setup')) return;
    el.setAttribute('data-hq-help', '1');
    var d = document.createElement('div');
    d.className = 'empty-setup';
    d.innerHTML = esc(h[0]) + (h[1] ? ' <a href="#' + esc(h[1]) + '" data-go="' + esc(h[1]) + '">' + esc(h[2]) + ' →</a>' : '');
    el.appendChild(d);
  }

  function toast(msg) {
    if (typeof document === 'undefined') return;
    var t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3200);
  }

  // ───────────── Jump to (Ctrl/Cmd + K) ─────────────
  var RECENT_KEY = 'hq_recent_jumps';
  function recent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { return []; } }
  function remember(id) { try { var r = recent().filter(function (x) { return x !== id; }); r.unshift(id); localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 5))); } catch (e) { /* ignore */ } }
  var isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

  // Leads opened from the palette, newest first (name and a short line, so Recent can show them without a request).
  var RECENT_LEADS = 'hq_recent_leads';
  function recentLeads() { try { return JSON.parse(localStorage.getItem(RECENT_LEADS) || '[]'); } catch (e) { return []; } }
  function rememberLead(it) { try { var r = recentLeads().filter(function (x) { return x.id !== it.leadId; }); r.unshift({ id: it.leadId, label: it.label, desc: it.desc }); localStorage.setItem(RECENT_LEADS, JSON.stringify(r.slice(0, 4))); } catch (e) { /* ignore */ } }
  function leadItem(id, label, desc) {
    return { id: 'lead:' + id, leadId: id, label: label, desc: desc, group: 'Leads', icon: 'people', run: function () { if (root.HQApp) root.HQApp.openLead(id); else location.hash = '#lead=' + encodeURIComponent(id); } };
  }
  /** Tabs read their plain-words name, description and icon from admin-nav.js when it is loaded. */
  function withNav(it) {
    var N = root.HQNav;
    if (!N || !it || String(it.id).indexOf('tab:') !== 0) return it;
    var t = it.id.slice(4), m = N.meta(t);
    if (!m) return it;
    return Object.assign({}, it, { label: m.label, desc: m.desc, icon: N.iconOf ? N.iconOf(t) : '', keywords: (it.keywords || '') + ' ' + it.label + ' ' + m.desc });
  }
  var lastPalette = null;

  /** opts: { items: () => [{id, label, group, hint, keywords, run}], query: q => [extra items for a typed query] } */
  function palette(opts) {
    var box = null, input, list, shown = [], active = 0, returnFocus = null, mode = '';
    var leadCache = {}, leadT = null;
    function findLeads(q) {
      if (q.length < 2 || leadCache[q] || typeof fetch === 'undefined') return;
      leadCache[q] = 'loading';
      var words = q.toLowerCase().split(/\s+/).filter(Boolean);
      fetch('/admin/api/leads?' + new URLSearchParams({ q: words[0], page: '0', sort: 'updated' }), { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : { rows: [] }; })
        .then(function (d) {
          leadCache[q] = (d.rows || []).filter(function (l) {
            var hay = [l.first_name, l.last_name, l.email, l.phone, l.ref_code].join(' ').toLowerCase();
            return words.every(function (w) { return hay.indexOf(w) > -1; });
          }).slice(0, 6).map(function (l) {
            var name = [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || l.id;
            return leadItem(l.id, name, [l.email, String(l.status || '').replace(/_/g, ' '), l.tier ? 'Tier ' + l.tier : ''].filter(Boolean).join(' · '));
          });
          if (box && input.value.trim() === q) draw();
        })
        .catch(function () { leadCache[q] = []; });
    }

    function close() {
      if (!box) return;
      box.remove(); box = null;
      document.body.classList.remove('hq-k-open');
      if (returnFocus && returnFocus.focus) returnFocus.focus();
    }
    function run(it) {
      if (!it) return;
      if (it.leadId) rememberLead(it); else remember(it.id);
      returnFocus = null;
      close();
      it.run();
    }
    function draw() {
      var q = input.value, qt = q.trim();
      var all = opts.items().map(withNav).map(function (x) {
        if (x.id === 'act:findlead') return Object.assign({}, x, { icon: 'search', run: function () { open('lead'); } });
        if (!x.icon && x.group === 'Actions') { var k = String(x.id); return Object.assign({}, x, { icon: /range/.test(k) ? 'calendar' : /approv/.test(k) ? 'sparkle' : /theme/.test(k) ? 'eye' : /funnel/.test(k) ? 'window' : /reload/.test(k) ? 'refresh' : 'back' }); }
        return x;
      });
      if (qt) {
        var hits = rank(all, q);
        var leads = Array.isArray(leadCache[qt]) ? leadCache[qt] : [];
        var strong = hits.filter(function (x) { return score(x, q) >= 60; });
        // Pages and actions that clearly match come first, then matching leads, then everything else that matches.
        var allLeads = opts.query ? opts.query(qt).map(function (x) { return Object.assign({ icon: 'search' }, x, { group: 'Leads' }); }) : [];
        shown = (mode === 'lead' ? [] : strong.slice(0, 6)).concat(leads, allLeads, mode === 'lead' ? [] : hits.filter(function (x) { return strong.indexOf(x) === -1; }).slice(0, 8));
        clearTimeout(leadT);
        if (!leadCache[qt]) leadT = setTimeout(function () { findLeads(qt); }, 160);
      } else {
        var rec = recent(), byId = {};
        all.forEach(function (x) { byId[x.id] = x; });
        var r = recentLeads().map(function (l) { return Object.assign(leadItem(l.id, l.label, l.desc), { group: 'Recent' }); })
          .concat(rec.map(function (id) { return byId[id]; }).filter(Boolean).map(function (x) { return Object.assign({}, x, { group: 'Recent' }); })).slice(0, 6);
        shown = mode === 'lead' ? r.filter(function (x) { return x.leadId; }) : r.concat(all.filter(function (x) { return rec.indexOf(x.id) === -1; }));
      }
      active = Math.min(active, Math.max(0, shown.length - 1));
      var lastGroup = null;
      var loading = qt && leadCache[qt] === 'loading';
      list.innerHTML = shown.length ? shown.map(function (it, i) {
        var g = it.group !== lastGroup ? '<li class="hq-k-g" role="presentation">' + esc(it.group) + '</li>' : '';
        lastGroup = it.group;
        return g + '<li role="option" id="hq-k-' + i + '" data-i="' + i + '" aria-selected="' + (i === active) + '">' +
          (it.icon ? '<svg class="hq-k-ic" aria-hidden="true"><use href="#i-' + esc(it.icon) + '"/></svg>' : '<span class="hq-k-ic hq-k-dot" aria-hidden="true"></span>') +
          '<span class="hq-k-t"><span>' + esc(it.label) + '</span>' + (it.desc ? '<em>' + esc(it.desc) + '</em>' : '') + '</span>' + (it.hint ? '<small>' + esc(it.hint) + '</small>' : '') + '</li>';
      }).join('') : '<li class="hq-k-none" role="presentation">' + (mode === 'lead' && !qt ? 'Type a name, email, phone number or ref.' : loading ? 'Looking for leads…' : 'Nothing matches “' + esc(q) + '”.') + '</li>';
      input.setAttribute('aria-activedescendant', shown.length ? 'hq-k-' + active : '');
      var a = list.querySelector('[aria-selected="true"]');
      if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
    }
    function move(d) { if (!shown.length) return; active = (active + d + shown.length) % shown.length; draw(); }
    function open(m) {
      mode = m === 'lead' ? 'lead' : '';
      if (box) { input.placeholder = mode === 'lead' ? 'Find a lead by name, email or phone…' : 'Search pages, leads and actions…'; input.focus(); input.select(); draw(); return; }
      returnFocus = document.activeElement;
      active = 0;
      box = document.createElement('div');
      box.className = 'hq-k';
      box.innerHTML = '<div class="hq-k-bg" data-k-close></div><div class="hq-k-dlg" role="dialog" aria-modal="true" aria-label="Search">' +
        '<div class="hq-k-in"><input type="text" role="combobox" aria-expanded="true" aria-controls="hq-k-list" aria-autocomplete="list" placeholder="Search pages, leads and actions…" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>' +
        '<ul id="hq-k-list" role="listbox" aria-label="Tabs and actions"></ul>' +
        '<p class="hq-k-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>' + (isMac ? '⌘' : 'Ctrl') + '</kbd><kbd>K</kbd> toggle</span></p></div>';
      document.body.appendChild(box);
      document.body.classList.add('hq-k-open');
      input = box.querySelector('input'); list = box.querySelector('ul');
      if (mode === 'lead') input.placeholder = 'Find a lead by name, email or phone…';
      input.addEventListener('input', function () { active = 0; draw(); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Home' && !input.value) { e.preventDefault(); active = 0; draw(); }
        else if (e.key === 'End' && !input.value) { e.preventDefault(); active = shown.length - 1; draw(); }
        else if (e.key === 'Enter') { e.preventDefault(); run(shown[active]); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1); } // focus stays in the box
      });
      list.addEventListener('mousemove', function (e) { var li = e.target.closest && e.target.closest('[data-i]'); if (li && +li.getAttribute('data-i') !== active) { active = +li.getAttribute('data-i'); draw(); } });
      list.addEventListener('click', function (e) { var li = e.target.closest && e.target.closest('[data-i]'); if (li) run(shown[+li.getAttribute('data-i')]); });
      box.querySelector('[data-k-close]').addEventListener('click', close);
      draw();
      input.focus();
    }
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (box) close(); else open(); }
    });
    document.querySelectorAll('[data-jump]').forEach(function (b) {
      b.addEventListener('click', function () { open(); });
      var k = b.querySelector('kbd'); if (k) k.textContent = isMac ? '⌘K' : 'Ctrl K';
    });
    lastPalette = { open: open, close: close };
    return lastPalette;
  }
  /** Open the palette from anywhere (Home's Find a lead uses mode 'lead'). */
  function openPalette(m) { if (lastPalette) lastPalette.open(m); }

  // A request that fails with nobody waiting for it (a button's fetch on a network blip) says so, instead of failing silently.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('unhandledrejection', function (e) {
      if (!isNetworkError(e.reason)) return;
      e.preventDefault();
      toast('Couldn’t reach Funnel HQ. Check the connection and try again.');
    });
  }

  // The glass toolbar (presentation only): once the large page title scrolls under it, the toolbar shows the title small.
  function toolbarTitle() {
    var big = document.querySelector('[data-title]'), small = document.querySelector('[data-bar-title]'), head = document.querySelector('.page-head');
    if (!big || !small || !head) return;
    var sync = function () { small.textContent = big.textContent; };
    sync();
    if (typeof MutationObserver !== 'undefined') new MutationObserver(sync).observe(big, { childList: true, characterData: true, subtree: true });
    if (typeof IntersectionObserver === 'undefined') return;
    new IntersectionObserver(function (es) {
      var e = es[es.length - 1];
      document.body.classList.toggle('hq-scrolled', !e.isIntersecting && e.boundingClientRect.top < 0);
    }, { rootMargin: '-72px 0px 0px 0px' }).observe(head.querySelector('h1') || head);
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', toolbarTitle); else toolbarTitle();
  }

  var api = {
    num: num, pct: pct, money: money, ratio: ratio, secs: secs, compact: compact,
    errorMessage: errorMessage, isNetworkError: isNetworkError, score: score, rank: rank,
    TAB_HELP: TAB_HELP, skeleton: skeleton, errorState: errorState, decorateEmpty: decorateEmpty, palette: palette, toast: toast, openPalette: openPalette,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.HQUX = api; root.HQFmt = api; }
})(this);

/* Funnel HQ navigation and page chrome (presentation only; loaded after admin-ux.js, before admin.js).
   - NAV: every tab's section, plain-words name, one-line description and primary action. The sidebar markup in
     public/admin/index.html uses the same names; test/hq-nav.test.ts keeps the two in step.
   - Sidebar: "More" per section (open/closed remembered), hover descriptions.
   - Phone: a glass tab bar with the sections; a section opens as a sheet listing its pages.
   - Every page: section, big title, one sentence, the page's primary action as one navy button, the rest under "…".
   - Tables: comfortable / compact density, sticky header on long tables, a simpler Leads row.
   - Segmented controls get a sliding selection.
   admin.js calls HQNav.onTab(tab, T) when a tab opens and HQNav.afterRender(tab, view) after it renders. */
(function (root) {
  'use strict';

  var SECTIONS = [
    { id: 'home', label: 'Home', short: 'Home', icon: 'house', first: 'home' },
    { id: 'sales', label: 'Leads & sales', short: 'Sales', icon: 'people', first: 'leads' },
    { id: 'live', label: 'Live & webinars', short: 'Live', icon: 'video', first: 'liveevents' },
    { id: 'marketing', label: 'Marketing & ads', short: 'Marketing', icon: 'megaphone', first: 'traffic' },
    { id: 'pages', label: 'Funnel & pages', short: 'Pages', icon: 'window', first: 'map' },
    { id: 'settings', label: 'Settings & system', short: 'Settings', icon: 'gear', first: 'integrations' },
  ];

  // tab: [section, name, what it is for, primary action?]
  // primary: { label, click: 'selector' } presses a button on the page; { label, focus: 'selector' } scrolls to that
  // form and puts the cursor in its first field; text: /regex/ finds the button by its words instead of a selector.
  var NAV = {
    home: ['home', 'Home', 'What needs you today, the key numbers and what is coming up.'],
    command: ['home', 'Assistant', 'Ask about your numbers and approve what the AI team proposes.', { label: 'New chat', click: '[data-cmd-new]' }],
    overview: ['home', 'Funnel numbers', 'Every step from ad click to closed deal, with daily trends.'],
    live: ['home', 'On the site now', 'Who is on the site right now and what they did.'],

    leads: ['sales', 'Leads', 'Everyone who applied, scored and ready for follow-up.'],
    sales: ['sales', 'Calls & deals', 'Booked calls, outcomes to log and cash by rep.'],
    dminbox: ['sales', 'Instagram DMs', 'Instagram conversations, hottest first, with replies to send.'],
    salesops: ['sales', 'Follow-ups', 'Nudge quiet leads, no-shows and unpaid checkouts in one batch.'],
    clients: ['sales', 'Clients', 'Health, onboarding and check-ins for everyone who bought.'],
    contracts: ['sales', 'Agreements', 'Draft, sign and track advisory agreements.', { label: 'New agreement', click: '[data-k-new]' }],
    support: ['sales', 'Support inbox', 'Questions from email and the rooms, with drafted answers to approve.', { label: 'Check for questions', click: '[data-sp-process]' }, 1],
    insights: ['sales', 'Best leads', 'Who your best leads are, split by tier.', null, 1],
    dealsprint: ['sales', 'Sprint board', 'First Deal Sprint buyers, day by day, and their deliverables.', null, 1],
    finance: ['sales', 'Profit model', 'What each funnel earns per ad dollar and what a profit target takes.', null, 1],

    liveevents: ['live', 'Live webinars', 'Schedule live sessions, run the offer and see who came.', { label: 'Schedule a webinar', focus: '[data-create]' }],
    challenge: ['live', 'Challenge', 'The 5-day First Deal Challenge: cohorts, attendance and deposits.', { label: 'New cohort', focus: 'button', text: /^Create cohort/i }],
    rooms: ['live', 'Video rooms', 'Our own rooms for webinars, challenge days and client meetings.', { label: 'New room', focus: '[data-rmb-create]' }],
    webinar: ['live', 'Masterclass', 'The automated masterclass: sessions, sign-ups and watch time.', { label: 'Add a session', focus: 'button', text: /^Add session$/i }],
    materials: ['live', 'Scripts & slides', 'Scripts, slide decks and run sheets for every session.', { label: 'Present slides', click: 'button, a', text: /^Present slides$/i }],
    wattrib: ['live', 'Webinar sources', 'Which ads and links brought each webinar buyer.', null, 1],

    traffic: ['marketing', 'Traffic & ads', 'Which sources and ads bring qualified leads, not only clicks.', { label: 'Add ad spend', focus: 'summary, button', text: /^Add spend by hand/i }],
    autopilot: ['marketing', 'Ads autopilot', 'Every ad judged on real results, with changes for you to approve.', { label: 'Read Meta now', click: '[data-ap-sync]' }],
    emails: ['marketing', 'Emails', 'Email sequences, delivery and opens.'],
    links: ['marketing', 'Tracked links', 'Links for your bio, DMs and videos, followed to closed deals.', { label: 'New link', focus: '[data-create]' }],
    content: ['marketing', 'Videos', 'Josh’s YouTube and Instagram: what works and what to make next.', { label: 'Suggest next videos', click: '[data-ctsuggest]' }],
    editor: ['marketing', 'Email editor', 'Read and change the wording of every email the funnel sends.', null, 1],
    sms: ['marketing', 'Texts & WhatsApp', 'Text and WhatsApp sequences: wording, timing and links.', { label: 'Send a test text', click: '[data-smstest]' }, 1],
    voice: ['marketing', 'AI phone calls', 'AI confirmation calls and inbound calls, with transcripts.', null, 1],
    winback: ['marketing', 'Win-back', 'Invite cold leads to the masterclass, a live webinar or the challenge.', { label: 'New campaign', click: '[data-wbk-new]' }, 1],
    reactivation: ['marketing', 'Reactivation', 'Bring back past leads who are already in the database.', null, 1],
    audiences: ['marketing', 'Meta audiences', 'Audiences and conversions sent to Meta for targeting.', null, 1],
    search: ['marketing', 'Search & AI', 'Who finds you through Google and AI assistants.', null, 1],
    ytideas: ['marketing', 'Video ideas', 'Video topics planned from what applicants say.', { label: 'Plan topics', click: '[data-ygen]' }, 1],
    research: ['marketing', 'Market research', 'What owners say online and what competitors run.', { label: 'Collect now', click: 'button', text: /^Collect now$/i }, 1],

    map: ['pages', 'Funnel map', 'Every funnel, stage by stage, with live numbers.'],
    screens: ['pages', 'Page previews', 'See every page of the funnel the way a visitor does.'],
    pages: ['pages', 'Landing pages', 'Landing pages and headline tests, traced to cash.'],
    vsl: ['pages', 'Sales video', 'Who watches the sales video, where they drop and who reaches the pitch.'],
    application: ['pages', 'Application', 'Where applicants drop off, what they answer and how they score.'],
    behaviour: ['pages', 'Visitor behaviour', 'Clicks, scrolls and where the form slows people down.', null, 1],

    integrations: ['settings', 'Integrations', 'Connect email, calendar, payments, ads and analytics.', { label: 'Save changes', click: 'button', text: /^Save changes$/i }],
    team: ['settings', 'Team & routing', 'Who takes calls, which leads they get and where alerts go.'],
    tracking: ['settings', 'Conversion tracking', 'Conversions sent to Meta and GA4, and the daily data checks.', { label: 'Run checks', click: '[data-dq-run]' }],
    errors: ['settings', 'Errors & jobs', 'Errors from pages and webhooks, and how scheduled jobs ran.'],
  };

  function meta(tab) {
    var m = NAV[tab];
    if (!m) return null;
    return { tab: tab, section: m[0], label: m[1], desc: m[2], primary: m[3] || null, more: !!m[4] };
  }
  function section(id) { for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].id === id) return SECTIONS[i]; return null; }
  function tabsIn(sec) { return Object.keys(NAV).filter(function (t) { return NAV[t][0] === sec; }); }

  var api = { SECTIONS: SECTIONS, NAV: NAV, meta: meta, section: section, tabsIn: tabsIn };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  if (typeof document === 'undefined') return;

  // ───────────── helpers ─────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } return v; }
  function icon(name, cls) { return '<svg class="' + (cls || 'ni') + '" aria-hidden="true"><use href="#i-' + esc(name) + '"/></svg>'; }
  function navBtn(tab) { return document.querySelector('[data-nav] button[data-tab="' + tab + '"]'); }
  function goTab(tab) { var b = navBtn(tab); if (b) b.click(); else if (root.HQApp) root.HQApp.go(tab); }
  function iconOf(tab) { var u = document.querySelector('[data-nav] button[data-tab="' + tab + '"] use'); return u ? (u.getAttribute('href') || '').replace('#i-', '') : 'doc'; }
  var phone = function () { return root.matchMedia && root.matchMedia('(max-width: 860px)').matches; };
  var reduced = function () { return root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches; };

  // ───────────── sidebar: More per section, hover descriptions ─────────────
  var moreState = store('hq_nav_more') || {};
  function setMore(sec, open, save) {
    var btn = document.querySelector('[data-sec-more="' + sec + '"]'), body = document.querySelector('[data-sec-more-body="' + sec + '"]');
    if (!btn || !body) return;
    btn.setAttribute('aria-expanded', String(open));
    body.classList.toggle('open', open);
    body.inert = !open;
    if (save) { moreState[sec] = open; store('hq_nav_more', moreState); }
  }
  document.querySelectorAll('[data-sec-more]').forEach(function (btn) {
    var sec = btn.getAttribute('data-sec-more');
    var body = document.querySelector('[data-sec-more-body="' + sec + '"]');
    var c = btn.querySelector('[data-more-count]'); if (c && body) c.textContent = String(body.querySelectorAll('button[data-tab]').length);
    setMore(sec, !!moreState[sec], false);
    btn.addEventListener('click', function () { setMore(sec, btn.getAttribute('aria-expanded') !== 'true', true); });
  });

  // Sidebar links to pages outside the tabs (Sandbox): a plain navigation.
  document.querySelectorAll('[data-nav] button[data-href]').forEach(function (b) {
    b.addEventListener('click', function () { var h = b.getAttribute('data-href'); if (/^\/admin\/[a-z-]+$/.test(h)) root.location.href = h; });
  });

  // A quiet description card beside the sidebar on hover (computers only); screen readers get it as the description.
  var tip = null, tipT = null;
  document.querySelectorAll('[data-nav] button[data-tab]').forEach(function (b) {
    var m = meta(b.getAttribute('data-tab'));
    if (!m) return;
    b.setAttribute('aria-description', m.desc);
    b.addEventListener('mouseenter', function () {
      if (phone() || !(root.matchMedia && root.matchMedia('(hover: hover)').matches)) return;
      clearTimeout(tipT);
      tipT = setTimeout(function () {
        if (!tip) { tip = document.createElement('div'); tip.className = 'nav-tip'; tip.setAttribute('aria-hidden', 'true'); document.body.appendChild(tip); }
        tip.innerHTML = '<b>' + esc(m.label) + '</b><span>' + esc(m.desc) + '</span>';
        var r = b.getBoundingClientRect(), side = document.querySelector('.side').getBoundingClientRect();
        tip.style.left = (side.right + 10) + 'px';
        tip.style.top = Math.max(8, Math.min(innerHeight - tip.offsetHeight - 8, r.top + r.height / 2 - tip.offsetHeight / 2)) + 'px';
        tip.classList.add('show');
      }, 450);
    });
    b.addEventListener('mouseleave', function () { clearTimeout(tipT); if (tip) tip.classList.remove('show'); });
    b.addEventListener('click', function () { clearTimeout(tipT); if (tip) tip.classList.remove('show'); });
  });

  // ───────────── phone: tab bar and section sheets ─────────────
  var tabbar = document.querySelector('[data-tabbar]');
  var BAR = ['home', 'sales', 'live', 'marketing'];
  if (tabbar) {
    tabbar.innerHTML = BAR.map(function (id) { var s = section(id); return '<button type="button" data-bar="' + id + '">' + icon(s.icon, 'tb-i') + '<span>' + esc(s.short) + '</span></button>'; }).join('') +
      '<button type="button" data-bar="more" data-tabbar-more>' + icon('more', 'tb-i') + '<span>More</span></button>';
    tabbar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-bar]'); if (!b) return;
      var id = b.getAttribute('data-bar');
      if (id === 'home') { closeSheet(); goTab('home'); return; }
      openSheet(id === 'more' ? ['pages', 'settings'] : [id], id);
    });
  }
  var sheet = null, sheetReturn = null;
  function closeSheet() {
    if (!sheet) return;
    var s = sheet; sheet = null;
    document.body.classList.remove('hq-sheet-open');
    s.classList.add('closing');
    setTimeout(function () { s.remove(); }, reduced() ? 0 : 240);
    if (sheetReturn && sheetReturn.focus) sheetReturn.focus();
  }
  function openSheet(secs, barId) {
    closeSheet();
    sheetReturn = document.activeElement;
    var cur = root.HQApp ? root.HQApp.tab() : '';
    var title = secs.length === 1 ? section(secs[0]).label : 'More';
    var html = secs.map(function (sid) {
      var s = section(sid), tabs = tabsIn(sid);
      var main = tabs.filter(function (t) { return !NAV[t][4]; }), extra = tabs.filter(function (t) { return NAV[t][4]; });
      var row = function (t) { var m = meta(t); return '<button type="button" class="sh-row" data-sheet-go="' + t + '"' + (t === cur ? ' aria-current="page"' : '') + '>' + icon(iconOf(t), 'sh-i') + '<span><b>' + esc(m.label) + '</b><small>' + esc(m.desc) + '</small></span>' + icon('chev', 'sh-c') + '</button>'; };
      return (secs.length > 1 ? '<p class="sh-h">' + esc(s.label) + '</p>' : '') + '<div class="sh-list">' + main.map(row).join('') + '</div>' +
        (extra.length ? '<p class="sh-h">More in ' + esc(s.short) + '</p><div class="sh-list">' + extra.map(row).join('') + '</div>' : '');
    }).join('');
    if (barId === 'more') {
      var theme = document.querySelector('[data-theme-toggle]');
      html += '<p class="sh-h">This device</p><div class="sh-list">' +
        '<button type="button" class="sh-row" data-sheet-act="theme">' + icon('eye', 'sh-i') + '<span><b>' + esc(theme ? theme.textContent : 'Theme') + '</b><small>Auto follows your phone’s light or dark setting.</small></span></button>' +
        '<a class="sh-row" href="/" target="_blank" rel="noopener">' + icon('window', 'sh-i') + '<span><b>Open the funnel</b><small>The public site, in a new tab.</small></span></a>' +
        '<button type="button" class="sh-row" data-sheet-act="logout">' + icon('back', 'sh-i') + '<span><b>Log out</b><small>Ends this session on this device.</small></span></button></div>';
    }
    sheet = document.createElement('div');
    sheet.className = 'hq-sheet';
    sheet.innerHTML = '<div class="hq-sheet-bg" data-sheet-close></div><div class="hq-sheet-card" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<div class="hq-sheet-head"><span class="hq-grab" aria-hidden="true"></span><h2>' + esc(title) + '</h2><button type="button" class="hq-sheet-x" data-sheet-close aria-label="Close">Done</button></div>' +
      '<div class="hq-sheet-body">' + html + '</div></div>';
    document.body.appendChild(sheet);
    document.body.classList.add('hq-sheet-open');
    sheet.addEventListener('click', function (e) {
      if (e.target.closest('[data-sheet-close]')) { closeSheet(); return; }
      var g = e.target.closest('[data-sheet-go]');
      if (g) { var t = g.getAttribute('data-sheet-go'); sheetReturn = null; closeSheet(); goTab(t); return; }
      var a = e.target.closest('[data-sheet-act]');
      if (a) {
        var k = a.getAttribute('data-sheet-act');
        if (k === 'theme') { var tb = document.querySelector('[data-theme-toggle]'); if (tb) { tb.click(); a.querySelector('b').textContent = tb.textContent; } }
        if (k === 'logout') { var f = document.querySelector('form[action="/admin/logout"]'); if (f) f.submit(); }
      }
    });
    // Drag the sheet down to close it.
    var card = sheet.querySelector('.hq-sheet-card'), head = sheet.querySelector('.hq-sheet-head'), y0 = null, dy = 0;
    head.addEventListener('pointerdown', function (e) { y0 = e.clientY; dy = 0; card.style.transition = 'none'; head.setPointerCapture(e.pointerId); });
    head.addEventListener('pointermove', function (e) { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); card.style.transform = 'translateY(' + dy + 'px)'; });
    var end = function () { if (y0 == null) return; y0 = null; card.style.transition = ''; card.style.transform = ''; if (dy > 90) closeSheet(); };
    head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
    var first = sheet.querySelector('[aria-current="page"]') || sheet.querySelector('.sh-row');
    if (first) first.focus({ preventScroll: true });
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && sheet) { e.preventDefault(); closeSheet(); } if (e.key === 'Escape') closeMenu(); });

  // ───────────── page header: title, one sentence, primary action, "…" ─────────────
  var actionsEl = document.querySelector('[data-page-actions]');
  var current = { tab: '', primary: null };
  var menu = null;
  function closeMenu() { if (menu) { menu.remove(); menu = null; var b = document.querySelector('[data-page-menu]'); if (b) b.setAttribute('aria-expanded', 'false'); } }

  function findTarget(p, view) {
    if (!p || !view) return null;
    var els = Array.prototype.slice.call(view.querySelectorAll(p.click || p.focus));
    return els.filter(function (el) { return (!p.text || p.text.test(el.textContent.trim())) && el.offsetParent !== null; })[0] || null;
  }
  function runPrimary(p, view) {
    var el = findTarget(p, view || document.querySelector('[data-view]'));
    if (!el) return false;
    if (p.click) { el.click(); return true; }
    // Focus: bring the form into view and put the cursor in its first empty field; a closed section opens first.
    if (el.tagName === 'SUMMARY') { var d = el.parentElement; if (d && !d.open) d.open = true; }
    var box = el.closest('form, .card, details') || el.parentElement;
    if (el.matches('input, textarea, select')) box = el;
    var field = el.matches('input, textarea, select') ? el : box.querySelector('input:not([type=hidden]):not([disabled]), textarea, select');
    box.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
    var card = el.closest('.card') || box;
    card.classList.remove('hq-flash'); void card.offsetWidth; card.classList.add('hq-flash');
    if (field) setTimeout(function () { field.focus({ preventScroll: true }); }, reduced() ? 0 : 320);
    return true;
  }
  /** Home's quick actions: open a tab, then run its primary action once it has rendered. */
  var pendingPrimary = null;
  function runAction(tab, primary) {
    var m = meta(tab), p = primary || (m && m.primary);
    if (!p) { goTab(tab); return; }
    if (root.HQApp && root.HQApp.tab() === tab && runPrimary(p)) return;
    pendingPrimary = { tab: tab, p: p };
    goTab(tab);
  }

  function buildActions(tab, T) {
    if (!actionsEl) return;
    closeMenu();
    var m = meta(tab);
    current = { tab: tab, primary: m && m.primary };
    actionsEl.innerHTML = (m && m.primary ? '<button type="button" class="btn-primary" data-page-primary hidden>' + esc(m.primary.label) + '</button>' : '') +
      '<button type="button" class="btn-round" data-page-menu aria-haspopup="menu" aria-expanded="false" aria-label="More actions for this page">' + icon('more', 'ni') + '</button>';
    var p = actionsEl.querySelector('[data-page-primary]');
    if (p) p.onclick = function () { runPrimary(current.primary); };
    actionsEl.querySelector('[data-page-menu]').onclick = function (e) { if (menu) { closeMenu(); return; } openMenu(e.currentTarget, T); };
  }
  function openMenu(btn, T) {
    var dense = document.body.classList.contains('hq-compact');
    var more = document.querySelector('[data-more]');
    var items = [];
    if (more && !more.hidden) items.push(['how', 'How this page works']);
    items.push(['reload', 'Reload this page'], ['density', dense ? 'Roomier tables' : 'Compact tables'], ['copy', 'Copy link to this page'], ['search', 'Search pages, leads and actions']);
    menu = document.createElement('div');
    menu.className = 'hq-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = items.map(function (it) { return '<button type="button" role="menuitem" data-menu="' + it[0] + '">' + esc(it[1]) + '</button>'; }).join('');
    document.body.appendChild(menu);
    var r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 8 + scrollY) + 'px';
    menu.style.right = Math.max(8, innerWidth - r.right) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    menu.querySelector('button').focus();
    menu.addEventListener('keydown', function (e) {
      var bs = Array.prototype.slice.call(menu.querySelectorAll('button')), i = bs.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
      if (e.key === 'Escape' || e.key === 'Tab') { closeMenu(); btn.focus(); }
    });
    menu.addEventListener('click', function (e) {
      var b = e.target.closest('[data-menu]'); if (!b) return;
      var k = b.getAttribute('data-menu');
      closeMenu();
      if (k === 'how' && more) { more.open = true; more.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' }); }
      if (k === 'reload' && root.HQApp) root.HQApp.reload();
      if (k === 'density') setDensity(!dense);
      if (k === 'copy') { try { navigator.clipboard.writeText(location.href); toast('Link copied'); } catch (x) { /* ignore */ } }
      if (k === 'search') { var j = document.querySelector('[data-jump]'); if (j) j.click(); }
    });
  }
  document.addEventListener('click', function (e) { if (menu && !e.target.closest('.hq-menu') && !e.target.closest('[data-page-menu]')) closeMenu(); });
  function toast(msg) { if (root.HQUX && root.HQUX.toast) root.HQUX.toast(msg); }

  // ───────────── tables ─────────────
  function setDensity(compact) {
    document.body.classList.toggle('hq-compact', compact);
    store('hq_density', compact ? 'compact' : 'comfortable');
  }
  if (store('hq_density') === 'compact') document.body.classList.add('hq-compact');

  var leadView = store('hq_lead_view') || 'simple';
  function decorateTables(tab, view) {
    view.querySelectorAll('.table-wrap table').forEach(function (t) {
      var ths = t.querySelectorAll('thead th');
      ths.forEach(function (th) { if (!th.hasAttribute('data-col')) th.setAttribute('data-col', th.textContent.trim()); });
    });
    if (tab !== 'leads') return;
    var tools = view.querySelector('.leads-tools'), wrap = view.querySelector('.table-wrap');
    if (wrap) wrap.classList.toggle('lead-simple', leadView === 'simple');
    if (tools && !tools.querySelector('[data-lead-view]')) {
      var seg = document.createElement('div');
      seg.className = 'seg';
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Columns');
      seg.setAttribute('data-lead-view', '');
      seg.innerHTML = '<button type="button" data-lv="simple" aria-pressed="' + (leadView === 'simple') + '">Simple</button><button type="button" data-lv="all" aria-pressed="' + (leadView !== 'simple') + '">All columns</button>';
      var spacer = tools.querySelector('.spacer');
      tools.insertBefore(seg, spacer || null);
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('[data-lv]'); if (!b) return;
        leadView = b.getAttribute('data-lv'); store('hq_lead_view', leadView);
        seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        var w = view.querySelector('.table-wrap'); if (w) w.classList.toggle('lead-simple', leadView === 'simple');
      });
    }
  }

  // Empty states: a calm icon, the message and (from HQUX.TAB_HELP) where to start.
  var EMPTY = {
    leads: 'No leads in this period. They appear here when someone applies.',
    sales: 'No calls yet. They appear here when someone books.',
    clients: 'No clients yet. They appear here after a purchase or a signed agreement.',
  };
  function decorateEmpty(tab, view) {
    view.querySelectorAll('.empty:not([data-hq-empty])').forEach(function (el, i) {
      el.setAttribute('data-hq-empty', '1');
      if (!el.querySelector('.empty-i')) el.insertAdjacentHTML('afterbegin', icon(iconOf(tab), 'empty-i'));
      var first = el.querySelector('div:not(.empty-hint):not(.empty-setup)');
      if (i === 0 && EMPTY[tab] && first && /^No (data|leads match)/i.test(first.textContent.trim()) && !/Try clearing/i.test(el.textContent)) first.textContent = EMPTY[tab];
    });
  }

  // ───────────── segmented controls: a sliding selection ─────────────
  function syncSeg(seg) {
    var on = seg.querySelector(':scope > button[aria-pressed="true"]');
    if (!on || !on.offsetWidth) { seg.classList.remove('seg-has'); return; }
    seg.style.setProperty('--seg-x', on.offsetLeft + 'px');
    seg.style.setProperty('--seg-w', on.offsetWidth + 'px');
    seg.style.setProperty('--seg-y', on.offsetTop + 'px');
    seg.style.setProperty('--seg-h', on.offsetHeight + 'px');
    if (!seg.classList.contains('seg-slide')) { seg.classList.add('seg-slide'); requestAnimationFrame(function () { seg.classList.add('seg-ready'); }); }
    seg.classList.add('seg-has');
  }
  function syncAllSegs() { document.querySelectorAll('.seg').forEach(syncSeg); }
  var segRaf = 0;
  function queueSegs() { if (segRaf) return; segRaf = requestAnimationFrame(function () { segRaf = 0; syncAllSegs(); }); }
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) {
        var t = ms[i].target;
        if (ms[i].type === 'attributes' ? t.parentElement && t.parentElement.classList.contains('seg') : (t.querySelector && t.querySelector('.seg'))) { queueSegs(); return; }
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed'] });
  }
  addEventListener('resize', queueSegs);
  document.addEventListener('DOMContentLoaded', queueSegs);

  // ───────────── hooks from admin.js ─────────────
  function onTab(tab, T) {
    if (pendingPrimary && pendingPrimary.tab !== tab) pendingPrimary = null;
    closeSheet();
    var m = meta(tab), s = m && section(m.section);
    document.body.setAttribute('data-hq-tab', tab);
    document.body.setAttribute('data-hq-section', m ? m.section : '');
    if (m) {
      var eb = document.querySelector('[data-eyebrow]'), ti = document.querySelector('[data-title]'), su = document.querySelector('[data-subtitle]');
      if (eb) eb.textContent = s ? s.label : '';
      if (ti) ti.textContent = m.label;
      if (su) su.textContent = m.desc;
      var nc = document.querySelector('[data-nav-current]'); if (nc) nc.textContent = m.label;
      // The longer explanation stays one tap away under "How this page works".
      var more = document.querySelector('[data-more]'), mt = document.querySelector('[data-more-text]');
      if (more && mt && T && !T.more && T.sub && T.sub !== m.desc) { mt.textContent = T.sub; more.hidden = false; }
      if (m.more) setMore(m.section, true, false);
      document.title = m.label + ' · Funnel HQ';
    }
    if (tabbar) tabbar.querySelectorAll('[data-bar]').forEach(function (b) {
      var id = b.getAttribute('data-bar');
      var on = m ? (id === m.section || (id === 'more' && (m.section === 'pages' || m.section === 'settings'))) : false;
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    buildActions(tab, T);
  }
  function afterRender(tab, view) {
    if (!view) return;
    var p = actionsEl && actionsEl.querySelector('[data-page-primary]');
    if (p) {
      p.hidden = !findTarget(current.primary, view);
      // Some boards fill in a moment after they render; look again before giving up on the action.
      if (p.hidden) [500, 1500].forEach(function (ms) { setTimeout(function () { if (current.tab === tab && p.isConnected) p.hidden = !findTarget(current.primary, view); }, ms); });
    }
    decorateTables(tab, view);
    decorateEmpty(tab, view);
    queueSegs();
    if (pendingPrimary && pendingPrimary.tab === tab) { var pp = pendingPrimary.p; pendingPrimary = null; setTimeout(function () { runPrimary(pp, view); }, 60); }
  }

  api.onTab = onTab;
  api.afterRender = afterRender;
  api.runAction = runAction;
  api.openSheet = openSheet;
  api.closeSheet = closeSheet;
  api.iconOf = iconOf;
  api.icon = icon;
  root.HQNav = api;
})(this);

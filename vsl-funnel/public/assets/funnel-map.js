/* Funnel map: every part of the funnel as a draggable box on a canvas, wired
 * together with arrows, with live numbers on each step. Click a box for how it
 * works and a link to its tab. Positions are saved for everyone. */
(function () {
  'use strict';

  // kind: traffic | page | decision | auto (runs by itself) | people | data
  var NODES = [
    // Traffic
    { id: 'meta', kind: 'traffic', x: 40, y: 40, title: 'Meta ads', sub: 'Facebook + Instagram', tab: 'pages',
      how: 'Each ad links to /for/<industry> or the smart /m link. Campaign, ad set, ad and placement ride along in the URL, so every lead is traced back to the exact ad.' },
    { id: 'youtube', kind: 'traffic', x: 40, y: 200, title: 'YouTube & tracked links', sub: 'One link per video & placement', tab: 'links',
      how: 'Short tracked links (/l/<code>) in descriptions, pinned comments and end screens. Each click is counted and followed to booked calls and revenue.' },
    { id: 'organic', kind: 'traffic', x: 40, y: 360, title: 'Direct, social & search', sub: 'Everyone else', tab: 'traffic',
      how: 'Anyone who types the address or comes from a post. UTMs are captured when present; otherwise the referrer decides the channel.' },
    { id: 'caldirect', kind: 'traffic', x: 40, y: 560, title: 'Calendly link (direct)', sub: 'Bypasses the funnel', tab: 'insights',
      how: 'People who book straight from Josh’s Calendly link never see the video or the application. They are imported hourly and tiered from their booking-form answers. About half of past direct bookers were C-tier, so share the funnel link instead.' },

    // Entry
    { id: 'smart', kind: 'decision', x: 330, y: 40, title: 'Smart route  /m', sub: 'Industry from the ad name', tab: 'pages',
      how: 'Reads the industry from ?ind= or from the campaign / ad set / ad name (e.g. “Dental – LAL 2%”). Match → that industry’s landers. No match → the main page.' },
    { id: 'landers', kind: 'page', x: 330, y: 190, title: 'Industry landers', sub: '20 industries × 5 headlines', tab: 'pages', stat: 'landers',
      how: '100 versions of the page, each speaking to one industry. For each industry, every headline gets its first 60 visitors, then traffic shifts automatically to the one that brings the most (qualified) applications.' },
    { id: 'main', kind: 'page', x: 330, y: 360, title: 'Main page A/B', sub: 'Headline A vs B', tab: 'pages', stat: 'main',
      how: 'Visitors to / are split 50/50 between two headlines (sticky per person). Judged on applications per visitor with a significance test.' },

    // Page
    { id: 'vsl', kind: 'page', x: 620, y: 260, title: 'VSL', sub: 'Video + floating player', tab: 'vsl', stat: 'vsl',
      how: 'Autoplays muted with a “click for sound” overlay. Every second watched is recorded (rewatches, skips, pauses, drop-off). The application unlocks below.' },
    { id: 'apply', kind: 'page', x: 900, y: 260, title: 'Application', sub: '10 questions, one at a time', tab: 'application', stat: 'apply',
      how: 'Step 1 captures name, email, phone (+ optional call consent) so an abandoned application can still be followed up. Each answer is saved as they go.' },
    { id: 'score', kind: 'decision', x: 1180, y: 260, title: 'Score & tier', sub: 'A · B · C', tab: 'application', stat: 'tiers',
      how: 'Answers are scored (revenue, profit, role, timeline, readiness, why now). Hard rules cap the tier (e.g. under $1M revenue). Then routed to a closer by round-robin.' },

    // Branches
    { id: 'tierA', kind: 'page', x: 1460, y: 70, title: 'A-tier → calendar', sub: '$1M+, ready', tab: 'sales', stat: 'a',
      how: 'Straight to the closer’s Calendly. Team gets a 🔥 ping. Booking is confirmed instantly through the Calendly API (exact time, meeting link, host).' },
    { id: 'tierB', kind: 'page', x: 1460, y: 270, title: 'B-tier → part 2 video', sub: 'Promising', tab: 'vsl', stat: 'b',
      how: 'The breakout video handles objections, then offers the calendar. B-tier emails push to book.' },
    { id: 'tierC', kind: 'page', x: 1460, y: 470, title: 'C-tier → free resources', sub: 'Not ready yet', tab: 'emails', stat: 'c',
      how: 'No call. Gets the toolkit and an education sequence until they grow into a fit.' },

    // Booking
    { id: 'booked', kind: 'page', x: 1760, y: 170, title: 'Call booked', sub: 'Calendly + webhook', tab: 'sales', stat: 'booked',
      how: 'Signed Calendly webhook + hourly sync: bookings, reschedules, cancellations, no-shows. Host becomes the closer. All follow-up starts here.' },
    { id: 'call', kind: 'people', x: 2060, y: 170, title: 'Strategy call', sub: '30 min, by video', tab: 'sales', stat: 'showed',
      how: 'Closer gets pinged 15 minutes before with the lead’s details and how much of the video they watched. Outcome is logged in Sales → Call log.' },
    { id: 'won', kind: 'people', x: 2340, y: 60, title: 'Won', sub: 'Deal + payments', tab: 'sales', stat: 'won',
      how: 'Deal value, payments ledger (cash collected, instalments, refunds), contract date and the 90-day LOI countdown. 🎉 ping to the wins channel; Purchase sent to Meta.' },
    { id: 'lost', kind: 'people', x: 2340, y: 200, title: 'Lost', sub: 'With the reason', tab: 'sales',
      how: 'Lost reason and main objection are logged and show up in Insights.' },
    { id: 'noshow', kind: 'people', x: 2340, y: 340, title: 'No-show', sub: 'Rebooking flow', tab: 'sales', stat: 'noshow',
      how: 'Rebooking emails go out automatically; team is pinged. Calendly no-show marks sync in too.' },

    // Automations around the booking
    { id: 'aicall', kind: 'auto', x: 1760, y: 380, title: 'AI confirmation call', sub: 'ElevenLabs · consent only', tab: 'voice',
      how: '~2 minutes after booking (if they ticked the call-consent box): Sam confirms the time, preps them, emails a new link if they need to move it. Calling hours only, max 2 attempts.' },
    { id: 'precall', kind: 'auto', x: 1760, y: 520, title: 'Pre-call emails', sub: 'Up to 6 a day', tab: 'emails', stat: 'emails',
      how: '24 emails, one pain point each, at local-time slots until 3 hours before the call, plus reminders at 48h / 24h / 3h / 1h / 10m with the meeting link.' },
    { id: 'reppings', kind: 'auto', x: 2060, y: 380, title: 'Team pings', sub: 'Slack / Discord', tab: 'team',
      how: 'Hot leads, bookings, cancellations, “call in 15 min”, no-shows, wins and a daily digest, with @mentions of the rep.' },
    { id: 'postcall', kind: 'auto', x: 2340, y: 480, title: 'Post-call follow-up', sub: 'Held, no decision yet', tab: 'emails',
      how: 'Showed but undecided → follow-up emails until they decide.' },

    // Recovery
    { id: 'abandon', kind: 'auto', x: 900, y: 480, title: 'Abandoned application', sub: '5 recovery emails', tab: 'emails',
      how: 'Gave contact details but didn’t finish → recovery emails from 15 minutes to 4 days, stopped the moment they submit.' },
    { id: 'speed', kind: 'auto', x: 1180, y: 480, title: 'Speed-to-lead AI call', sub: 'Qualified, not booked', tab: 'voice',
      how: '~5 minutes after an A/B application with no booking (consent only): a short call that offers to email the booking link.' },
    { id: 'tierseq', kind: 'auto', x: 1460, y: 640, title: 'Get-booked emails', sub: 'A / B sequences', tab: 'emails',
      how: 'Qualified but not booked → a sequence for their tier until they book.' },

    // Engine room (runs under everything)
    { id: 'tracking', kind: 'data', x: 330, y: 760, title: 'Tracking', sub: 'Every visit, click, field, second', tab: 'behaviour',
      how: 'First-party: page views, scroll, sections read, every click, form friction (never values), video seconds, tab switches, highlights, exit point. Conversions go server-side to Meta (CAPI), GA4 and PostHog.' },
    { id: 'profile', kind: 'data', x: 620, y: 760, title: 'Behaviour profile', sub: 'Facts per lead', tab: 'leads',
      how: 'Everything a lead did, turned into facts: where they stopped the video, FAQ questions, their own words, hesitation, return visits, which industry page. Visible on each lead.' },
    { id: 'triggers', kind: 'auto', x: 900, y: 760, title: 'Behaviour-triggered emails', sub: '10 rules', tab: 'emails', stat: 'triggers',
      how: 'Picked a day but didn’t book, watched most of the video, re-read the guarantee, looked into funding… Each fires once per person, max 8 emails a day in total.' },
    { id: 'personal', kind: 'data', x: 1180, y: 760, title: 'Personalised by Claude', sub: 'Every email rewritten', tab: 'emails',
      how: 'Each email is rewritten around one or two facts the earlier emails didn’t use. Links never go to the model; checked for no “free” call, no promises.' },
    { id: 'callback', kind: 'auto', x: 1760, y: 660, title: 'Callback agent', sub: '+1 229 404 6271', tab: 'voice',
      how: 'Anyone who rings the number back gets Sam, who already knows who they are from caller ID, and can confirm, rebook or log a callback request.' },
    { id: 'hq', kind: 'data', x: 2060, y: 660, title: 'Funnel HQ', sub: 'You are here', tab: 'overview',
      how: 'Every number on this map, live. Sales, Insights, Landing pages & tests, On-page behaviour, Leads.' },
  ];

  var EDGES = [
    ['meta', 'smart'], ['meta', 'landers'], ['youtube', 'main'], ['organic', 'main'],
    ['smart', 'landers', 'match'], ['smart', 'main', 'no match'],
    ['landers', 'vsl'], ['main', 'vsl'],
    ['vsl', 'apply', 'r:play_apply'], ['apply', 'score', 'r:applied'],
    ['score', 'tierA', 'A'], ['score', 'tierB', 'B'], ['score', 'tierC', 'C'],
    ['tierA', 'booked', 'r:booked'], ['tierB', 'booked'],
    ['booked', 'call', 'r:show'], ['call', 'won', 'r:close'], ['call', 'lost'], ['booked', 'noshow'],
    ['caldirect', 'booked', 'skips the funnel', 'dash'],
    ['booked', 'aicall', '', 'auto'], ['booked', 'precall', '', 'auto'], ['booked', 'reppings', '', 'auto'], ['call', 'postcall', '', 'auto'],
    ['noshow', 'booked', 'rebook', 'auto'],
    ['apply', 'abandon', 'didn’t finish', 'auto'], ['abandon', 'apply', '', 'auto'],
    ['score', 'speed', '', 'auto'], ['speed', 'booked', '', 'auto'],
    ['tierA', 'tierseq', '', 'auto'], ['tierB', 'tierseq', '', 'auto'], ['tierseq', 'booked', '', 'auto'],
    ['tracking', 'profile', '', 'data'], ['profile', 'triggers', '', 'data'], ['triggers', 'personal', '', 'data'], ['profile', 'personal', '', 'data'],
    ['vsl', 'tracking', '', 'data'], ['aicall', 'callback', '', 'auto'],
  ];

  var W = 220, H = 92;
  var KIND = { traffic: 'Traffic', page: 'Page / step', decision: 'Decision', auto: 'Runs automatically', people: 'People / outcome', data: 'Data & AI' };

  function render(root, ctx) {
    var esc = ctx.esc, n = ctx.n, pct = ctx.pct, money = ctx.money;
    var stats = ctx.stats;
    var saved = ctx.layout || {};
    var pos = {};
    NODES.forEach(function (d) { pos[d.id] = saved[d.id] ? { x: saved[d.id].x, y: saved[d.id].y } : { x: d.x, y: d.y }; });
    var zoom = 0.85, selected = null;

    root.innerHTML =
      '<div class="fm-bar"><div class="fm-legend">' + Object.keys(KIND).map(function (k) { return '<span class="fm-key fm-' + k + '"><i></i>' + esc(KIND[k]) + '</span>'; }).join('') +
      '<span class="fm-key"><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" class="fm-e-auto"/></svg>automation</span></div>' +
      '<div class="row"><button class="btn-sm ghost" data-z="-">−</button><button class="btn-sm ghost" data-z="+">+</button><button class="btn-sm ghost" data-fit>Fit</button><button class="btn-sm ghost" data-reset>Reset layout</button></div></div>' +
      '<div class="fm-wrap"><div class="fm-scroll"><div class="fm-canvas"><svg class="fm-edges"></svg></div></div><aside class="fm-panel" hidden></aside></div>' +
      '<p class="muted" style="margin-top:8px">Drag boxes to rearrange (saved for everyone) · drag the background to pan · click a box for how it works. Numbers are for the selected date range.</p>';

    var scroll = root.querySelector('.fm-scroll'), canvas = root.querySelector('.fm-canvas'), svg = root.querySelector('.fm-edges'), panel = root.querySelector('.fm-panel');

    function statFor(d) {
      var s = stats, k = s.kpis || {}, f = {};
      (s.funnel || []).forEach(function (x) { f[x.key] = x.n; });
      switch (d.stat) {
        case 'landers': return s.landerVisitors ? n(s.landerVisitors) + ' visitors' : 'no traffic yet';
        case 'main': return n(s.mainVisitors) + ' visitors';
        case 'vsl': return n(f.play) + ' played · ' + n(f.pitch) + ' saw the pitch';
        case 'apply': return n(f.lead) + ' started · ' + n(f.applied) + ' submitted';
        case 'tiers': return n(k.tier_a) + ' A · ' + n(k.tier_b) + ' B · ' + n(k.tier_c) + ' C';
        case 'a': return n(k.tier_a) + ' qualified';
        case 'b': return n(k.tier_b) + ' qualified';
        case 'c': return n(k.tier_c) + ' to nurture';
        case 'booked': return n(k.booked) + ' booked · ' + n(k.cancelled) + ' cancelled';
        case 'showed': return n(k.showed) + ' held';
        case 'noshow': return n(k.no_show) + ' no-shows';
        case 'won': return n(k.won) + ' won · ' + money(k.revenue);
        case 'emails': return n(k.emails_sent) + ' emails sent';
        case 'triggers': return n(s.triggerSent) + ' sent';
        default: return '';
      }
    }
    function edgeLabel(e) {
      var lab = e[2] || '';
      if (lab.indexOf('r:') !== 0) return lab;
      var f = {}; (stats.funnel || []).forEach(function (x) { f[x.key] = x.n; });
      var k = stats.kpis || {};
      var r = { play_apply: f.play ? f.lead / f.play : null, applied: f.lead ? f.applied / f.lead : null, booked: (k.tier_a + k.tier_b) ? k.booked / (k.tier_a + k.tier_b) : null, show: k.show_rate, close: k.showed ? k.won / k.showed : null }[lab.slice(2)];
      return r == null || !isFinite(r) || r > 1 ? '' : pct(r);
    }

    NODES.forEach(function (d) {
      var el = document.createElement('div');
      el.className = 'fm-node fm-' + d.kind;
      el.setAttribute('data-id', d.id);
      el.tabIndex = 0;
      el.innerHTML = '<div class="fm-kind">' + esc(KIND[d.kind]) + '</div><div class="fm-title">' + esc(d.title) + '</div><div class="fm-sub">' + esc(d.sub) + '</div>' + (d.stat ? '<div class="fm-stat">' + esc(statFor(d)) + '</div>' : '');
      canvas.appendChild(el);
    });

    function place() {
      var maxX = 0, maxY = 0;
      NODES.forEach(function (d) {
        var el = canvas.querySelector('[data-id="' + d.id + '"]'), p = pos[d.id];
        el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
        maxX = Math.max(maxX, p.x + W); maxY = Math.max(maxY, p.y + H);
      });
      var cw = maxX + 200, ch = maxY + 160;
      canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
      canvas.style.zoom = zoom;
      svg.setAttribute('width', cw); svg.setAttribute('height', ch);
      drawEdges();
    }
    function anchor(id, toward) {
      var p = pos[id], c = { x: p.x + W / 2, y: p.y + H / 2 }, t = pos[toward], tc = { x: t.x + W / 2, y: t.y + H / 2 };
      var dx = tc.x - c.x, dy = tc.y - c.y;
      if (Math.abs(dx) * H > Math.abs(dy) * W) return { x: dx > 0 ? p.x + W : p.x, y: c.y, side: dx > 0 ? 'r' : 'l' };
      return { x: c.x, y: dy > 0 ? p.y + H : p.y, side: dy > 0 ? 'b' : 't' };
    }
    function drawEdges() {
      var out = '<defs><marker id="fm-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="fm-arrowhead"/></marker></defs>';
      EDGES.forEach(function (e) {
        var a = anchor(e[0], e[1]), b = anchor(e[1], e[0]);
        var k = 60, c1 = { x: a.x, y: a.y }, c2 = { x: b.x, y: b.y };
        if (a.side === 'r') c1.x += k; else if (a.side === 'l') c1.x -= k; else if (a.side === 'b') c1.y += k; else c1.y -= k;
        if (b.side === 'r') c2.x += k; else if (b.side === 'l') c2.x -= k; else if (b.side === 'b') c2.y += k; else c2.y -= k;
        var cls = 'fm-e' + (e[3] ? ' fm-e-' + e[3] : '') + (selected && (e[0] === selected || e[1] === selected) ? ' fm-e-hi' : '');
        out += '<path class="' + cls + '" d="M' + a.x + ',' + a.y + ' C' + c1.x + ',' + c1.y + ' ' + c2.x + ',' + c2.y + ' ' + b.x + ',' + b.y + '" marker-end="url(#fm-arr)"/>';
        var lab = edgeLabel(e);
        if (lab) {
          var mx = (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, my = (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8;
          out += '<g class="fm-elab"><rect x="' + (mx - lab.length * 3.6 - 6) + '" y="' + (my - 10) + '" width="' + (lab.length * 7.2 + 12) + '" height="20" rx="10"/><text x="' + mx + '" y="' + (my + 4) + '" text-anchor="middle">' + esc(lab) + '</text></g>';
        }
      });
      svg.innerHTML = out;
    }
    function open(id) {
      selected = id;
      var d = NODES.filter(function (x) { return x.id === id; })[0];
      canvas.querySelectorAll('.fm-node').forEach(function (el) { el.classList.toggle('fm-sel', el.getAttribute('data-id') === id); });
      var ins = EDGES.filter(function (e) { return e[1] === id; }).map(function (e) { return e[0]; });
      var outs = EDGES.filter(function (e) { return e[0] === id; }).map(function (e) { return e[1]; });
      var name = function (x) { return '<button class="fm-link" data-jump="' + x + '">' + esc(NODES.filter(function (y) { return y.id === x; })[0].title) + '</button>'; };
      panel.hidden = false;
      panel.innerHTML = '<button class="close" type="button" aria-label="Close">✕</button><div class="fm-kind">' + esc(KIND[d.kind]) + '</div><h2>' + esc(d.title) + '</h2><p class="sub">' + esc(d.sub) + '</p>' +
        (d.stat ? '<p class="fm-stat big">' + esc(statFor(d)) + '</p>' : '') + '<p>' + esc(d.how) + '</p>' +
        (ins.length ? '<p class="muted">Comes from: ' + ins.map(name).join(' ') + '</p>' : '') + (outs.length ? '<p class="muted">Leads to: ' + outs.map(name).join(' ') + '</p>' : '') +
        (d.tab ? '<button class="btn-sm" data-tab-go="' + d.tab + '">Open in Funnel HQ →</button>' : '');
      panel.querySelector('.close').onclick = function () { panel.hidden = true; selected = null; canvas.querySelectorAll('.fm-sel').forEach(function (el) { el.classList.remove('fm-sel'); }); drawEdges(); };
      panel.querySelectorAll('[data-jump]').forEach(function (b) { b.onclick = function () { open(b.getAttribute('data-jump')); centre(b.getAttribute('data-jump')); }; });
      var go = panel.querySelector('[data-tab-go]'); if (go) go.onclick = function () { ctx.go(go.getAttribute('data-tab-go')); };
      drawEdges();
    }
    function centre(id) { var p = pos[id]; scroll.scrollTo({ left: (p.x + W / 2) * zoom - scroll.clientWidth / 2, top: (p.y + H / 2) * zoom - scroll.clientHeight / 2, behavior: 'smooth' }); }

    // Drag boxes; pan the background.
    var drag = null, saveT;
    canvas.addEventListener('pointerdown', function (e) {
      var node = e.target.closest('.fm-node');
      if (node) {
        var id = node.getAttribute('data-id');
        drag = { id: id, sx: e.clientX, sy: e.clientY, ox: pos[id].x, oy: pos[id].y, moved: false };
        node.setPointerCapture(e.pointerId); node.classList.add('fm-drag');
      } else {
        drag = { pan: true, sx: e.clientX, sy: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop };
        canvas.setPointerCapture(e.pointerId);
      }
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (drag.pan) { scroll.scrollLeft = drag.sl - (e.clientX - drag.sx); scroll.scrollTop = drag.st - (e.clientY - drag.sy); return; }
      var dx = (e.clientX - drag.sx) / zoom, dy = (e.clientY - drag.sy) / zoom;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      pos[drag.id] = { x: Math.max(0, Math.round((drag.ox + dx) / 10) * 10), y: Math.max(0, Math.round((drag.oy + dy) / 10) * 10) };
      var el = canvas.querySelector('[data-id="' + drag.id + '"]');
      el.style.transform = 'translate(' + pos[drag.id].x + 'px,' + pos[drag.id].y + 'px)';
      drawEdges();
    });
    function end() {
      if (!drag) return;
      if (!drag.pan) {
        var el = canvas.querySelector('[data-id="' + drag.id + '"]'); el.classList.remove('fm-drag');
        if (drag.moved) { place(); clearTimeout(saveT); saveT = setTimeout(function () { ctx.save(pos); }, 400); }
        else open(drag.id);
      }
      drag = null;
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var nd = e.target.closest('.fm-node'); if (nd) open(nd.getAttribute('data-id')); } });

    root.querySelectorAll('[data-z]').forEach(function (b) { b.onclick = function () { zoom = Math.max(0.4, Math.min(1.4, zoom + (b.getAttribute('data-z') === '+' ? 0.1 : -0.1))); place(); }; });
    root.querySelector('[data-fit]').onclick = function () { var cw = parseFloat(canvas.style.width) || 2600; zoom = Math.max(0.4, Math.min(1.2, (scroll.clientWidth - 20) / cw)); place(); };
    root.querySelector('[data-reset]').onclick = function () { NODES.forEach(function (d) { pos[d.id] = { x: d.x, y: d.y }; }); place(); ctx.save(null); };

    place();
    if (scroll.clientWidth < 900) root.querySelector('[data-fit]').click();
  }

  window.FunnelMap = { render: render, NODES: NODES, EDGES: EDGES };
})();

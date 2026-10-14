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
      how: 'Closer gets pinged 15 minutes before with the lead’s details and how much of the video they watched. Outcome is logged in Calls & deals → Call log.' },
    { id: 'won', kind: 'people', x: 2340, y: 60, title: 'Won', sub: 'Deal + payments', tab: 'sales', stat: 'won',
      how: 'Deal value, payments ledger (cash collected, instalments, refunds), contract date and the 90-day LOI countdown. 🎉 ping to the wins channel; Purchase sent to Meta.' },
    { id: 'lost', kind: 'people', x: 2340, y: 200, title: 'Lost', sub: 'With the reason', tab: 'sales',
      how: 'Lost reason and main objection are logged and show up in Calls & deals → Why deals are lost.' },
    { id: 'noshow', kind: 'people', x: 2340, y: 340, title: 'No-show', sub: '7 rebook emails + AI call', tab: 'sales', stat: 'noshow',
      how: 'Seven rebooking emails over 14 days, written from their application (their goal, their blocker, the numbers we were going to run), plus an AI call to offer a new time. Team is pinged. Calendly no-show marks sync in too.' },
    { id: 'rebookcall', kind: 'auto', x: 2620, y: 340, title: 'AI rebook call', sub: 'No-shows · consent only', tab: 'voice',
      how: '~20 minutes after a no-show is logged (calling hours, consent only): Sam says no stress, asks if they’d like a new time and emails the link. Turn off with AI_CALL_REBOOK = false.' },
    { id: 'cancel', kind: 'people', x: 1760, y: 10, title: 'Cancelled', sub: 'Calendly cancellation', tab: 'sales',
      how: 'When someone cancels, the reminders and pre-call emails stop and the rebooking run starts.' },
    { id: 'cxseq', kind: 'auto', x: 2060, y: 10, title: 'Rebook emails', sub: '4 emails, 6 days', tab: 'emails',
      how: 'Picks up where they were (“how to build a group in HVAC”), handles their stated blocker, quotes their why-now back, then asks once more. Stops the moment they rebook.' },
    { id: 'onboard', kind: 'auto', x: 2620, y: 60, title: 'Onboarding emails', sub: '6 emails, 30 days', tab: 'emails',
      how: 'Welcome and the 90-day plan, homework (P&L, debts, target names), building the target list in their industry, week-one check-in, getting lender-ready, the LOI push. Stops on refund.' },
    { id: 'lostseq', kind: 'auto', x: 2620, y: 200, title: 'Re-engagement', sub: '6 emails over 6 months', tab: 'emails',
      how: 'Long-tail follow-up angled on why they said no (price, timing, funding fit…), with industry notes and their own numbers. Stops if they book again.' },

    // Automations around the booking
    { id: 'aicall', kind: 'auto', x: 1760, y: 380, title: 'AI confirmation call', sub: 'ElevenLabs · consent only', tab: 'voice',
      how: '~2 minutes after booking (if they ticked the call-consent box): Sam confirms the time, preps them, emails a new link if they need to move it. Calling hours only, max 2 attempts.' },
    { id: 'precall', kind: 'auto', x: 1760, y: 520, title: 'Pre-call emails', sub: 'Written from their application', tab: 'emails', stat: 'emails',
      how: 'Up to 6 a day until 3 hours before the call. First: emails written from their own answers (“I read your application”, their #1 blocker, what a deal looks like at their size, their industry, their Calendly answers, their why-now, bring your partner, 3 things to have ready). Then 24 one-pain-point emails woven in. Plus reminders at 48h / 24h / 3h / 1h / 10m with the meeting link.' },
    { id: 'reppings', kind: 'auto', x: 2060, y: 380, title: 'Team pings', sub: 'Slack / Discord', tab: 'team',
      how: 'Hot leads, bookings, cancellations, “call in 15 min”, no-shows, wins and a daily digest, with @mentions of the rep.' },
    { id: 'postcall', kind: 'auto', x: 2340, y: 480, title: 'Post-call follow-up', sub: '9 emails, 21 days', tab: 'emails',
      how: 'Showed but undecided → answers the objection logged on the call (price, timing, partner, funding doubts…), a one-page recap of their plan, the cost of waiting, who else is buying in their industry, their own why-now, then closes the loop.' },
    { id: 'nurture', kind: 'auto', x: 1760, y: 800, title: '6-month nurture', sub: '9 emails, never booked', tab: 'emails',
      how: 'Applied but never booked → from day 25 to month 6: their industry, their blocker, their numbers, why sellers carry notes, the 1.5 rule, their own words back, a one-word check-in. Stops the moment they book.' },
    { id: 'dossier', kind: 'data', x: 1460, y: 800, title: 'Application reader', sub: 'Answers + booking answers', tab: 'leads',
      how: 'Turns each lead’s application and Calendly answers into talking points: industry, size, profit, goal, timeline, blockers, why-now (their words), partner, objection and lost reason, plus an illustrative first-deal size. Every follow-up email is written from it at send time.' },

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
    { id: 'wland', kind: 'page', x: 40, y: 980, title: 'Webinar sign-up', sub: 'live.grosfjeld-li.com', tab: 'webinar',
      how: 'Registration page for the masterclass: pick a session (weekly schedule plus one-offs), first name and email. Registrants become leads with full ad attribution, and Meta gets CompleteRegistration.' },
    { id: 'wroom', kind: 'page', x: 330, y: 980, title: 'Webinar room', sub: 'Recording in sync · live stream · Zoom', tab: 'webinar',
      how: 'Each person’s own link. Countdown, then either the recording played in sync (everyone at the same moment), a live stream in our own room (Cloudflare Stream: go live from OBS, StreamYard or Zoom), or a button to a Zoom/YouTube link. Minutes watched are tracked; the “See if you qualify” offer appears at the pitch; replay for 48 hours.' },
    { id: 'wmail', kind: 'auto', x: 620, y: 1100, title: 'Webinar emails', sub: 'Reminders, then came / missed', tab: 'emails',
      how: 'Confirmation with calendar links, reminders 24h / 3h / 15m before, “we’ve started”, then a different follow-up for people who came (next step: apply) and who missed it (the replay), and a few emails pointing to the application. Stops once they apply or book.' },
    { id: 'hq', kind: 'data', x: 2060, y: 660, title: 'Funnel HQ', sub: 'You are here', tab: 'overview',
      how: 'Every number on this map, live. Calls & deals, Best leads, Landing pages & tests, On-page behaviour, Leads.' },
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
    ['noshow', 'booked', 'rebook', 'auto'], ['noshow', 'rebookcall', '', 'auto'],
    ['booked', 'cancel', 'cancelled'], ['cancel', 'cxseq', '', 'auto'], ['won', 'onboard', '', 'auto'], ['lost', 'lostseq', '', 'auto'],
    ['tierseq', 'nurture', 'still not booked', 'auto'], ['tierC', 'nurture', '', 'auto'],
    ['apply', 'dossier', 'answers', 'data'], ['dossier', 'precall', '', 'data'], ['dossier', 'postcall', '', 'data'], ['dossier', 'nurture', '', 'data'],
    ['apply', 'abandon', 'didn’t finish', 'auto'], ['abandon', 'apply', '', 'auto'],
    ['score', 'speed', '', 'auto'], ['speed', 'booked', '', 'auto'],
    ['tierA', 'tierseq', '', 'auto'], ['tierB', 'tierseq', '', 'auto'], ['tierseq', 'booked', '', 'auto'],
    ['meta', 'wland', 'webinar ads', 'dash'], ['wland', 'wroom', 'their link'], ['wland', 'wmail', '', 'auto'], ['wmail', 'wroom', '', 'auto'], ['wroom', 'apply', 'offer'],
    ['tracking', 'profile', '', 'data'], ['profile', 'triggers', '', 'data'], ['triggers', 'personal', '', 'data'], ['profile', 'personal', '', 'data'],
    ['vsl', 'tracking', '', 'data'], ['aicall', 'callback', '', 'auto'],
  ];

  var W = 220, H = 92;
  var KIND = { traffic: 'Traffic', page: 'Page / step', decision: 'Decision', auto: 'Runs automatically', people: 'People / outcome', data: 'Data & AI' };

  /**
   * ctx: { esc, n, pct, money, go, stats, layout, save(pos|null),
   *        custom: { nodes, edges, edits }, saveCustom(custom), tabs: [{id, title}] }
   * Built-in boxes describe how the system actually works: their text can be
   * edited and annotated, but they can't be deleted. Your own boxes and arrows
   * can be added, edited and removed freely.
   */
  function render(root, ctx) {
    var esc = ctx.esc, n = ctx.n, pct = ctx.pct, money = ctx.money;
    var stats = ctx.stats;
    var saved = ctx.layout || {};
    var custom = ctx.custom && typeof ctx.custom === 'object' ? ctx.custom : {};
    custom.nodes = Array.isArray(custom.nodes) ? custom.nodes : [];
    custom.edges = Array.isArray(custom.edges) ? custom.edges : [];
    custom.edits = custom.edits && typeof custom.edits === 'object' ? custom.edits : {};
    var tabs = ctx.tabs || [];
    var pos = {};
    var zoom = 0.85, selected = null;

    function nodes() {
      return NODES.map(function (d) {
        var e = custom.edits[d.id] || {};
        return { id: d.id, kind: d.kind, x: d.x, y: d.y, title: e.title || d.title, sub: e.sub != null ? e.sub : d.sub, tab: d.tab, stat: d.stat, how: d.how, note: e.note || '', builtin: true, edited: Boolean(e.title || e.sub != null || e.note) };
      }).concat(custom.nodes.map(function (d) { return { id: d.id, kind: KIND[d.kind] ? d.kind : 'page', x: 0, y: 0, title: d.title || 'New step', sub: d.sub || '', tab: d.tab || null, note: d.note || '', builtin: false }; }));
    }
    function edges() {
      return EDGES.map(function (e) { return { from: e[0], to: e[1], label: e[2] || '', style: e[3] || '', custom: false }; })
        .concat(custom.edges.map(function (e, i) { return { from: e[0], to: e[1], label: e[2] || '', style: 'custom', custom: true, idx: i }; }));
    }
    function byId(id) { return nodes().filter(function (x) { return x.id === id; })[0]; }
    function ensurePos() {
      nodes().forEach(function (d) {
        if (pos[d.id]) return;
        var s = saved[d.id];
        pos[d.id] = s ? { x: s.x, y: s.y } : { x: d.x, y: d.y };
      });
    }

    root.innerHTML =
      '<div class="fm-bar"><div class="fm-legend">' + Object.keys(KIND).map(function (k) { return '<span class="fm-key fm-' + k + '"><i></i>' + esc(KIND[k]) + '</span>'; }).join('') +
      '<span class="fm-key"><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" class="fm-e-auto"/></svg>automation</span>' +
      '<span class="fm-key"><svg width="28" height="8"><line x1="0" y1="4" x2="28" y2="4" class="fm-e-custom"/></svg>your arrows</span></div>' +
      '<div class="row"><button class="btn-sm" data-add>+ Add step</button><button class="btn-sm ghost" data-z="-">−</button><button class="btn-sm ghost" data-z="+">+</button><button class="btn-sm ghost" data-fit>Fit</button><button class="btn-sm ghost" data-reset>Reset layout</button></div></div>' +
      '<div class="fm-wrap"><div class="fm-scroll"><div class="fm-canvas"><svg class="fm-edges"></svg></div></div><aside class="fm-panel" hidden></aside></div>' +
      '<p class="muted" style="margin-top:8px">Drag boxes to rearrange · drag the ● on a box’s edge onto another box to connect them · click a box for how it works, to edit it or add notes · <b>+ Add step</b> for your own. Everything is saved for everyone. Numbers are for the selected date range.</p>';

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
      var lab = e.label || '';
      if (lab.indexOf('r:') !== 0) return lab;
      var f = {}; (stats.funnel || []).forEach(function (x) { f[x.key] = x.n; });
      var k = stats.kpis || {};
      var r = { play_apply: f.play ? f.lead / f.play : null, applied: f.lead ? f.applied / f.lead : null, booked: (k.tier_a + k.tier_b) ? k.booked / (k.tier_a + k.tier_b) : null, show: k.show_rate, close: k.showed ? k.won / k.showed : null }[lab.slice(2)];
      return r == null || !isFinite(r) || r > 1 ? '' : pct(r);
    }

    // ── persistence ──
    var saveT, customT;
    function saveLayout() { clearTimeout(saveT); saveT = setTimeout(function () { ctx.save(pos); }, 400); }
    function saveCustom() { clearTimeout(customT); customT = setTimeout(function () { if (ctx.saveCustom) ctx.saveCustom(custom); }, 300); }

    // ── boxes ──
    function build() {
      ensurePos();
      canvas.querySelectorAll('.fm-node').forEach(function (el) { el.remove(); });
      nodes().forEach(function (d) {
        var el = document.createElement('div');
        el.className = 'fm-node fm-' + d.kind + (d.builtin ? '' : ' fm-custom') + (d.id === selected ? ' fm-sel' : '');
        el.setAttribute('data-id', d.id);
        el.tabIndex = 0;
        el.innerHTML = '<div class="fm-kind">' + esc(KIND[d.kind]) + (d.builtin ? '' : ' · yours') + (d.note ? ' <span class="fm-noted" title="Has notes">✎</span>' : '') + '</div><div class="fm-title">' + esc(d.title) + '</div><div class="fm-sub">' + esc(d.sub) + '</div>' +
          (d.stat ? '<div class="fm-stat">' + esc(statFor(d)) + '</div>' : '') + '<span class="fm-port" title="Drag onto another box to connect"></span>';
        canvas.appendChild(el);
      });
      place();
    }
    function place() {
      var maxX = 0, maxY = 0;
      nodes().forEach(function (d) {
        var el = canvas.querySelector('[data-id="' + d.id + '"]'), p = pos[d.id];
        if (!el || !p) return;
        el.style.transform = 'translate(' + p.x + 'px,' + p.y + 'px)';
        maxX = Math.max(maxX, p.x + W); maxY = Math.max(maxY, p.y + H);
      });
      var cw = maxX + 200, ch = maxY + 160;
      canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
      canvas.style.zoom = zoom;
      svg.setAttribute('width', cw); svg.setAttribute('height', ch);
      drawEdges();
    }

    // ── arrows ──
    function anchor(id, toward) {
      // toward: another box's id, or a point (while dragging a new arrow).
      var p = pos[id], c = { x: p.x + W / 2, y: p.y + H / 2 };
      var tc = typeof toward === 'string' ? { x: pos[toward].x + W / 2, y: pos[toward].y + H / 2 } : toward;
      var dx = tc.x - c.x, dy = tc.y - c.y;
      if (Math.abs(dx) * H > Math.abs(dy) * W) return { x: dx > 0 ? p.x + W : p.x, y: c.y, side: dx > 0 ? 'r' : 'l' };
      return { x: c.x, y: dy > 0 ? p.y + H : p.y, side: dy > 0 ? 'b' : 't' };
    }
    function curve(a, b, bSide) {
      var k = 60, c1 = { x: a.x, y: a.y }, c2 = { x: b.x, y: b.y };
      if (a.side === 'r') c1.x += k; else if (a.side === 'l') c1.x -= k; else if (a.side === 'b') c1.y += k; else c1.y -= k;
      if (bSide === 'r') c2.x += k; else if (bSide === 'l') c2.x -= k; else if (bSide === 'b') c2.y += k; else if (bSide === 't') c2.y -= k;
      return { d: 'M' + a.x + ',' + a.y + ' C' + c1.x + ',' + c1.y + ' ' + c2.x + ',' + c2.y + ' ' + b.x + ',' + b.y, c1: c1, c2: c2 };
    }
    var temp = null;
    function drawEdges() {
      var out = '<defs><marker id="fm-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="fm-arrowhead"/></marker></defs>';
      edges().forEach(function (e) {
        if (!pos[e.from] || !pos[e.to]) return;
        var a = anchor(e.from, e.to), b = anchor(e.to, e.from), cv = curve(a, b, b.side);
        var cls = 'fm-e' + (e.style ? ' fm-e-' + e.style : '') + (selected && (e.from === selected || e.to === selected) ? ' fm-e-hi' : '');
        out += '<path class="' + cls + '" d="' + cv.d + '" marker-end="url(#fm-arr)"/>';
        var lab = edgeLabel(e);
        if (lab) {
          var mx = (a.x + 3 * cv.c1.x + 3 * cv.c2.x + b.x) / 8, my = (a.y + 3 * cv.c1.y + 3 * cv.c2.y + b.y) / 8;
          out += '<g class="fm-elab"><rect x="' + (mx - lab.length * 3.6 - 6) + '" y="' + (my - 10) + '" width="' + (lab.length * 7.2 + 12) + '" height="20" rx="10"/><text x="' + mx + '" y="' + (my + 4) + '" text-anchor="middle">' + esc(lab) + '</text></g>';
        }
      });
      if (temp) {
        var a = anchor(temp.from, temp.to), cv = curve(a, temp.to, null);
        out += '<path class="fm-e fm-e-custom fm-e-hi" d="' + cv.d + '" marker-end="url(#fm-arr)"/>';
      }
      svg.innerHTML = out;
    }

    // ── side panel ──
    function connectOptions(id) {
      return nodes().filter(function (x) { return x.id !== id; }).sort(function (a, b) { return a.title.localeCompare(b.title); })
        .map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.title) + '</option>'; }).join('');
    }
    function open(id, editing) {
      var d = byId(id);
      if (!d) { close(); return; }
      selected = id;
      canvas.querySelectorAll('.fm-node').forEach(function (el) { el.classList.toggle('fm-sel', el.getAttribute('data-id') === id); });
      panel.hidden = false;
      if (editing) {
        panel.innerHTML = '<button class="close" type="button" aria-label="Close">✕</button><div class="fm-kind">' + (d.builtin ? 'Edit step' : 'Your step') + '</div>' +
          '<label class="fm-f">Title<input class="input" data-e="title" maxlength="60" value="' + esc(d.title) + '"></label>' +
          '<label class="fm-f">Subtitle<input class="input" data-e="sub" maxlength="90" value="' + esc(d.sub) + '"></label>' +
          (d.builtin ? '' :
            '<label class="fm-f">Type<select class="input" data-e="kind">' + Object.keys(KIND).map(function (k) { return '<option value="' + k + '"' + (k === d.kind ? ' selected' : '') + '>' + esc(KIND[k]) + '</option>'; }).join('') + '</select></label>' +
            '<label class="fm-f">Opens tab<select class="input" data-e="tab"><option value="">—</option>' + tabs.map(function (t) { return '<option value="' + esc(t.id) + '"' + (t.id === d.tab ? ' selected' : '') + '>' + esc(t.title) + '</option>'; }).join('') + '</select></label>') +
          '<label class="fm-f">' + (d.builtin ? 'Your notes' : 'How it works / notes') + '<textarea class="input" data-e="note" rows="6" maxlength="2000">' + esc(d.note) + '</textarea></label>' +
          '<div class="row"><button class="btn-sm" data-save>Save</button><button class="btn-sm ghost" data-cancel>Cancel</button>' +
          (d.builtin && d.edited ? '<button class="btn-sm ghost" data-revert>Reset to default</button>' : '') + '</div>';
        var val = function (k) { var el = panel.querySelector('[data-e="' + k + '"]'); return el ? el.value.trim() : ''; };
        panel.querySelector('[data-save]').onclick = function () {
          if (d.builtin) {
            var def = NODES.filter(function (x) { return x.id === id; })[0];
            var e = {};
            if (val('title') && val('title') !== def.title) e.title = val('title');
            if (val('sub') !== def.sub) e.sub = val('sub');
            if (val('note')) e.note = val('note');
            if (Object.keys(e).length) custom.edits[id] = e; else delete custom.edits[id];
          } else {
            var c = custom.nodes.filter(function (x) { return x.id === id; })[0];
            c.title = val('title') || 'New step'; c.sub = val('sub'); c.kind = val('kind'); c.tab = val('tab') || null; c.note = val('note');
          }
          saveCustom(); build(); open(id);
        };
        panel.querySelector('[data-cancel]').onclick = function () { open(id); };
        var rv = panel.querySelector('[data-revert]'); if (rv) rv.onclick = function () { delete custom.edits[id]; saveCustom(); build(); open(id); };
        panel.querySelector('.close').onclick = close;
        var first = panel.querySelector('[data-e="title"]'); if (first) { first.focus(); first.select(); }
        drawEdges();
        return;
      }
      var all = edges();
      var ins = all.filter(function (e) { return e.to === id; }), outs = all.filter(function (e) { return e.from === id; });
      var chip = function (e, other) {
        var o = byId(other);
        if (!o) return '';
        return '<span class="fm-chip"><button class="fm-link" data-jump="' + esc(other) + '">' + esc(o.title) + '</button>' + (e.custom ? '<button class="fm-x" data-unlink="' + e.idx + '" title="Remove this arrow">✕</button>' : '') + '</span>';
      };
      panel.innerHTML = '<button class="close" type="button" aria-label="Close">✕</button><div class="fm-kind">' + esc(KIND[d.kind]) + (d.builtin ? '' : ' · your step') + '</div><h2>' + esc(d.title) + '</h2><p class="sub">' + esc(d.sub) + '</p>' +
        (d.stat ? '<p class="fm-stat big">' + esc(statFor(d)) + '</p>' : '') + (d.how ? '<p>' + esc(d.how) + '</p>' : '') +
        (d.note ? '<div class="fm-note"><div class="fm-kind">' + (d.builtin ? 'Your notes' : 'Notes') + '</div>' + esc(d.note).replace(/\n/g, '<br>') + '</div>' : '') +
        (ins.length ? '<p class="muted">Comes from: ' + ins.map(function (e) { return chip(e, e.from); }).join(' ') + '</p>' : '') +
        (outs.length ? '<p class="muted">Leads to: ' + outs.map(function (e) { return chip(e, e.to); }).join(' ') + '</p>' : '') +
        '<div class="fm-connect"><select class="input" data-to><option value="">Connect to…</option>' + connectOptions(id) + '</select><input class="input" data-label maxlength="30" placeholder="Arrow label (optional)"><button class="btn-sm ghost" data-link>Add arrow</button></div>' +
        '<div class="row" style="margin-top:12px"><button class="btn-sm ghost" data-edit>' + (d.builtin ? 'Edit / add notes' : 'Edit') + '</button>' +
        (d.builtin ? '' : '<button class="btn-sm ghost danger" data-del>Delete step</button>') +
        (d.tab ? '<button class="btn-sm" data-tab-go="' + esc(d.tab) + '">Open in Funnel HQ →</button>' : '') + '</div>';
      panel.querySelector('.close').onclick = close;
      panel.querySelectorAll('[data-jump]').forEach(function (b) { b.onclick = function () { open(b.getAttribute('data-jump')); centre(b.getAttribute('data-jump')); }; });
      panel.querySelectorAll('[data-unlink]').forEach(function (b) { b.onclick = function () { custom.edges.splice(Number(b.getAttribute('data-unlink')), 1); saveCustom(); open(id); }; });
      panel.querySelector('[data-link]').onclick = function () {
        var to = panel.querySelector('[data-to]').value;
        if (to) { link(id, to, panel.querySelector('[data-label]').value.trim()); open(id); }
      };
      panel.querySelector('[data-edit]').onclick = function () { open(id, true); };
      var del = panel.querySelector('[data-del]');
      if (del) del.onclick = function () {
        if (!confirm('Delete “' + d.title + '” and its arrows?')) return;
        custom.nodes = custom.nodes.filter(function (x) { return x.id !== id; });
        custom.edges = custom.edges.filter(function (e) { return e[0] !== id && e[1] !== id; });
        delete pos[id]; saveCustom(); saveLayout(); close(); build();
      };
      var go = panel.querySelector('[data-tab-go]'); if (go) go.onclick = function () { ctx.go(go.getAttribute('data-tab-go')); };
      drawEdges();
    }
    function close() { panel.hidden = true; selected = null; canvas.querySelectorAll('.fm-sel').forEach(function (el) { el.classList.remove('fm-sel'); }); drawEdges(); }
    function centre(id) { var p = pos[id]; if (p) scroll.scrollTo({ left: (p.x + W / 2) * zoom - scroll.clientWidth / 2, top: (p.y + H / 2) * zoom - scroll.clientHeight / 2, behavior: 'smooth' }); }
    function link(from, to, label) {
      if (from === to) return false;
      if (edges().some(function (e) { return e.from === from && e.to === to; })) return false;
      if (custom.edges.length >= 400) return false;
      custom.edges.push([from, to, (label || '').slice(0, 30)]);
      saveCustom(); drawEdges();
      return true;
    }

    // ── interactions: drag boxes, drag ports to connect, pan the background ──
    var drag = null;
    canvas.addEventListener('pointerdown', function (e) {
      var port = e.target.closest('.fm-port'), node = e.target.closest('.fm-node');
      if (port && node) {
        var from = node.getAttribute('data-id'), a = anchor(from, { x: pos[from].x + W + 100, y: pos[from].y + H / 2 });
        drag = { link: from, sx: e.clientX, sy: e.clientY, ax: a.x, ay: a.y };
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
      } else if (node) {
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
      if (drag.link) {
        temp = { from: drag.link, to: { x: drag.ax + (e.clientX - drag.sx) / zoom, y: drag.ay + (e.clientY - drag.sy) / zoom } };
        canvas.querySelectorAll('.fm-target').forEach(function (el) { el.classList.remove('fm-target'); });
        var over = document.elementFromPoint(e.clientX, e.clientY), t = over && over.closest('.fm-node');
        if (t && t.getAttribute('data-id') !== drag.link) t.classList.add('fm-target');
        drawEdges();
        return;
      }
      var dx = (e.clientX - drag.sx) / zoom, dy = (e.clientY - drag.sy) / zoom;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      pos[drag.id] = { x: Math.max(0, Math.round((drag.ox + dx) / 10) * 10), y: Math.max(0, Math.round((drag.oy + dy) / 10) * 10) };
      var el = canvas.querySelector('[data-id="' + drag.id + '"]');
      el.style.transform = 'translate(' + pos[drag.id].x + 'px,' + pos[drag.id].y + 'px)';
      drawEdges();
    });
    function end(e) {
      if (!drag) return;
      if (drag.link) {
        canvas.querySelectorAll('.fm-target').forEach(function (el) { el.classList.remove('fm-target'); });
        var over = e && document.elementFromPoint(e.clientX, e.clientY), t = over && over.closest('.fm-node');
        temp = null;
        if (t && t.getAttribute('data-id') !== drag.link) { link(drag.link, t.getAttribute('data-id'), ''); open(drag.link); } else drawEdges();
      } else if (!drag.pan) {
        var el = canvas.querySelector('[data-id="' + drag.id + '"]'); el.classList.remove('fm-drag');
        if (drag.moved) { place(); saveLayout(); }
        else open(drag.id);
      }
      drag = null;
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', function () { temp = null; end(null); });
    canvas.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var nd = e.target.closest('.fm-node'); if (nd) open(nd.getAttribute('data-id')); } });

    root.querySelector('[data-add]').onclick = function () {
      if (custom.nodes.length >= 200) { alert('That’s the limit of 200 of your own steps.'); return; }
      var id = 'u_' + Math.random().toString(36).slice(2, 10);
      var x = Math.max(0, Math.round(((scroll.scrollLeft + scroll.clientWidth / 2) / zoom - W / 2) / 10) * 10);
      var y = Math.max(0, Math.round(((scroll.scrollTop + scroll.clientHeight / 2) / zoom - H / 2) / 10) * 10);
      // Don't drop it exactly on top of another box.
      while (Object.keys(pos).some(function (k) { return Math.abs(pos[k].x - x) < W && Math.abs(pos[k].y - y) < H; }) && y < 4800) y += 20;
      custom.nodes.push({ id: id, kind: 'page', title: 'New step', sub: '', note: '', tab: null });
      pos[id] = { x: x, y: y };
      saveCustom(); saveLayout(); build(); open(id, true);
    };
    root.querySelectorAll('[data-z]').forEach(function (b) { b.onclick = function () { zoom = Math.max(0.4, Math.min(1.4, zoom + (b.getAttribute('data-z') === '+' ? 0.1 : -0.1))); place(); }; });
    root.querySelector('[data-fit]').onclick = function () { var cw = parseFloat(canvas.style.width) || 2600; zoom = Math.max(0.4, Math.min(1.2, (scroll.clientWidth - 20) / cw)); place(); };
    root.querySelector('[data-reset]').onclick = function () {
      if (!confirm('Put the built-in boxes back where they started? Your own steps stay where they are.')) return;
      NODES.forEach(function (d) { pos[d.id] = { x: d.x, y: d.y }; });
      place(); saveLayout();
    };

    build();
    if (scroll.clientWidth < 900) root.querySelector('[data-fit]').click();
  }

  window.FunnelMap = { render: render, NODES: NODES, EDGES: EDGES };
})();

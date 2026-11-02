/* Offer pack (round 4, src/rooms/studio-pack.ts + studio-pack-terms.ts): the room's offer surfaces.
   - Two paths: when the room's offer is the two paths (Funnel HQ → Rooms → Studio) or the host pushed both at once,
     the deposit card and the First Deal Sprint card become one card with the two side by side: real prices after
     this attendee's own credits (fetched from /studio/paths), real deadlines (the offer's close from the room, the
     Sprint's price hold when the owner switched one on), one action per path. Each button runs the room's own push
     action (room.js actPush), so checkout, tracking and the push funnel stay exactly as they are.
   - Generosity rationale: one plain line on every offer surface (the offer sheet, this card) saying why the terms
     are what they are, built on the server from the real terms in code.
   room.js calls RoomOffer.card(push) from pushCard and RoomOffer.bind(dock, actPush) after drawing the card. */
(function () {
  'use strict';
  var R = window.RoomCore;
  if (!R || !R.CFG.studio || !R.CFG.studio.pack) return;
  var CFG = R.CFG, PK = CFG.studio.pack, PC = PK.copy || {}, S = R.S, esc = R.esc, $ = R.$, $$ = R.$$;
  if (R.isStaff) { window.RoomOffer = { card: function () { return null; }, bind: function () {} }; }

  function fmt(x, a) { return String(x == null ? '' : x).replace(/\{a\}/g, a == null ? '' : a); }

  // ───────────── generosity rationale on the offer sheet (the server-rendered <template id="room-offer">) ─────────────
  function whyHtml(cls) { return PK.why ? '<p class="ro-why ' + (cls || '') + '">' + esc(PK.why.short) + '</p>' + (cls ? '' : '<p class="ro-why-r">' + esc(PK.why.reason) + '</p>') : ''; }
  (function offerSheet() {
    var tpl = document.getElementById('room-offer');
    var sec = tpl && tpl.content && tpl.content.querySelector('[data-offer]');
    if (!sec || sec.querySelector('.ro-why')) return;
    var box = document.createElement('div'); box.className = 'ro-whybox'; box.innerHTML = whyHtml();
    var at = sec.querySelector('.rm-secures');
    if (at && at.nextSibling) sec.insertBefore(box, at.nextSibling); else sec.appendChild(box);
  })();

  if (R.isStaff) return;

  // ───────────── the two paths ─────────────
  function view() { return (S.view && S.view.eng) || null; }
  function offerCard() { var s = S.view && S.view.studio; return (s && s.pack && s.pack.offerCard) || PK.offerCard || 'deposit'; }
  function openPushes() { var e = view(); return e ? (e.pushes || []).filter(function (x) { return !(R.E && R.E.dismissed && R.E.dismissed[x.id]); }) : []; }
  /** The deposit and Sprint pushes to show together, or null. Together when the room's offer is the two paths, or the host pushed both at once. */
  function pair(x) {
    if (!x || (x.kind !== 'deposit' && x.kind !== 'sprint')) return null;
    var other = openPushes().filter(function (y) { return y.kind === (x.kind === 'deposit' ? 'sprint' : 'deposit'); }).pop();
    if (!other) return null;
    if (offerCard() !== 'paths' && Math.abs((other.at || 0) - (x.at || 0)) > 10000) return null;
    return x.kind === 'deposit' ? { dep: x, spr: other } : { dep: other, spr: x };
  }

  var data = null, loadedAt = 0, loading = null;
  function load(force) {
    if (loading) return loading;
    if (data && !force && Date.now() - loadedAt < 30000) return Promise.resolve(data);
    loading = R.post('/studio/paths', {}).then(function (d) { loading = null; if (d && d.ok) { data = d; loadedAt = Date.now(); } return data; }).catch(function () { loading = null; return data; });
    return loading;
  }

  function pathA(p) {
    var d = data && data.deposit, pr = PK.prices || {};
    var price = d ? d.today : pr.deposit;
    var credit = d && d.credit ? fmt(PC.ticketOff, d.credit) : (PK.stack && PK.stack.reveal && PK.stack.reveal.credit) || '';
    var action = d && d.paid ? '<p class="ro-ok">' + esc(PC.pathPaid) + '</p>' : data && data.lead && data.qualified === false ? '<p class="ro-fine">' + esc(PC.pathUnderMillion) + '</p>' : '<button type="button" class="rm-buy" data-path-go="' + p.dep.id + '">' + esc(PC.pathAButton) + '</button>';
    return '<section class="ro-path" aria-labelledby="ro-pa">' +
      '<p class="ro-eb">' + esc(PC.pathA) + '</p><h4 id="ro-pa" class="ro-name">' + esc(PC.pathAName) + '</h4>' +
      '<p class="ro-price">' + esc(fmt(PC.pathADeposit, price)) + '</p>' +
      '<p class="ro-fine">' + esc(credit) + '</p>' +
      '<p class="ro-body">' + esc(PC.pathABody) + '</p>' +
      (d && d.guarantee ? '<p class="ro-fine ro-g"><a href="' + esc(d.url) + '" target="_blank" rel="noopener">' + esc(d.guarantee) + '</a></p>' : '') +
      '<p class="ro-dl" data-ro-dl="deposit" hidden></p>' + action + '</section>';
  }
  function pathB(p) {
    var sp = data && data.sprint, pr = (PK.prices && PK.prices.sprint) || {};
    var price = sp ? sp.today : pr.label, name = (sp && sp.name) || pr.name || '';
    var action = sp && sp.paid ? '<p class="ro-ok">' + esc(PC.pathPaid) + '</p>'
      : sp && sp.qualified === false ? '<p class="ro-fine">' + esc(PC.pathUnderMillion) + '</p>'
      : sp && sp.available === false ? '<p class="ro-fine">' + esc(PC.pathUnavailable) + '</p>'
      : '<button type="button" class="rm-buy" data-path-go="' + p.spr.id + '">' + esc(PC.pathBButton) + '</button>';
    return '<section class="ro-path" aria-labelledby="ro-pb">' +
      '<p class="ro-eb">' + esc(PC.pathB) + '</p><h4 id="ro-pb" class="ro-name">' + esc(name) + '</h4>' +
      '<p class="ro-price">' + esc(price || '') + '</p>' +
      '<p class="ro-fine">' + esc(sp && sp.line && sp.line !== price + ' today' ? sp.line : PC.pathBCredit) + '</p>' +
      '<p class="ro-body">' + esc(PC.pathBBody) + '</p>' +
      '<p class="ro-dl" data-ro-dl="sprint" hidden></p>' + action + '</section>';
  }
  function inner(p) { return '<div class="ro-grid">' + pathA(p) + pathB(p) + '</div>' + whyHtml('ro-why--card'); }
  function card(x) {
    var p = pair(x); if (!p) return null;
    return '<p class="rm-eyebrow">' + esc(PC.pathsEyebrow) + '</p><h3 class="rm-card-h">' + esc(PC.pathsHeading) + '</h3><div class="ro-paths" data-ro-paths="' + p.dep.id + ':' + p.spr.id + '" aria-live="polite">' + inner(p) + '</div>';
  }
  var act = null;
  function wire(root) {
    $$('[data-path-go]', root).forEach(function (b) {
      b.onclick = function () {
        var id = Number(b.getAttribute('data-path-go'));
        var x = openPushes().filter(function (y) { return y.id === id; })[0] || ((view() && view().pushes) || []).filter(function (y) { return y.id === id; })[0];
        if (x && act) act(x);
      };
    });
  }
  function bind(dock, actPush) {
    act = actPush;
    if (!dock.__roClose) {
      // Closing the two-paths card puts both cards in the tray (room.js records the dismissal of the one it keyed).
      dock.__roClose = true;
      dock.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest && ev.target.closest('[data-card-x]'), bx = $('[data-ro-paths]', dock);
        if (!b || !bx || !R.E || !R.E.dismissed) return;
        bx.getAttribute('data-ro-paths').split(':').forEach(function (id) { R.E.dismissed[Number(id)] = 1; });
      }, true);
    }
    var box = $('[data-ro-paths]', dock); if (!box) return;
    wire(box);
    tick();
    load(false).then(function () {
      var ids = box.getAttribute('data-ro-paths').split(':').map(Number);
      var all = openPushes(), dep = all.filter(function (y) { return y.id === ids[0]; })[0], spr = all.filter(function (y) { return y.id === ids[1]; })[0];
      if (!dep || !spr || !document.body.contains(box)) return;
      box.innerHTML = inner({ dep: dep, spr: spr }); wire(box); tick();
    });
  }
  /** The real deadlines: the offer's close (the room holds it) and the Sprint's price hold (when there is one). */
  function tick() {
    var now = R.now(), o = (S.view && S.view.room && S.view.room.offer) || {}, sp = data && data.sprint;
    $$('[data-ro-dl]').forEach(function (el) {
      var at = el.getAttribute('data-ro-dl') === 'deposit' ? (o.open && o.closesAt) : (sp && sp.deadline && sp.deadline.at);
      var label = el.getAttribute('data-ro-dl') === 'deposit' ? PC.closesIn : ((sp && sp.deadline && sp.deadline.label) || PC.closesIn);
      if (!at || at <= now) { el.hidden = true; return; }
      el.hidden = false; el.textContent = label + ' ' + R.clock(at - now);
    });
  }
  setInterval(tick, 1000);
  // A purchase elsewhere (the offer sheet, the Sprint page) refreshes the paths next time they show.
  R.on('state', function () { if (!$('[data-ro-paths]')) return; tick(); });
  R.on('pushed', function () { load(true); });

  window.RoomOffer = { card: card, bind: bind };
})();

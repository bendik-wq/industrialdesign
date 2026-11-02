/* Payment links in the live room (src/sales/paylinks.ts): a real countdown on the Sprint and deposit cards and
 * sheets, and who is paying, so nobody retypes it. Every deadline comes from the server: the Sprint push's price
 * hold (only when the owner switched it on for the room) and the event's or cohort's offer close. No deadline,
 * no timer. Uses window.RoomCore (room.js) and its server clock. */
(function () {
  'use strict';
  var core = null, lastPushes = '';

  function pushes() { var v = core.S.view; return (v && v.eng && v.eng.pushes) || []; }
  function sprint() { return core.E && core.E.data && core.E.data.sprint; }
  function offer() { var v = core.S.view; return (v && v.room && v.room.offer) || {}; }

  /** The real deadline for a card kind, or null. */
  function deadlineFor(kind) {
    if (kind === 'sprint') { var sp = sprint(); return sp && sp.deadline ? { at: sp.deadline.at, label: sp.deadline.label, closed: sp.deadline.closed } : null; }
    if (kind === 'deposit') { var o = offer(); return o.open && o.closesAt ? { at: o.closesAt, label: (core.C && core.C.offerClosesIn) || '', closed: '' } : null; }
    return null;
  }

  function ensureTimer(host, d, after) {
    var el = host.querySelector('[data-pay-timer]');
    if (!d) { if (el) el.remove(); return; }
    if (!el) {
      el = core.h('p', { class: 'rm-closes rm-paytime', 'data-pay-timer': '', role: 'timer', 'aria-live': 'off' });
      el.appendChild(core.h('span', {}, d.label)); el.appendChild(document.createTextNode(' ')); el.appendChild(core.h('strong', { 'data-pay-left': '' }));
      if (after && after.parentNode) after.parentNode.insertBefore(el, after.nextSibling); else host.appendChild(el);
    }
    var left = d.at - core.now();
    el.querySelector('[data-pay-left]').textContent = core.clock(left);
    return left;
  }

  function tick() {
    if (!core || !core.S.view || core.isStaff) return;
    // A new Sprint push may carry a price hold: refresh the person's data once.
    var sig = pushes().map(function (x) { return x.id; }).join(',');
    if (sig !== lastPushes) { var fresh = pushes().some(function (x) { return x.kind === 'sprint' && lastPushes.split(',').indexOf(String(x.id)) < 0; }); lastPushes = sig; if (fresh) core.loadEngage(); }

    // The pushed card in the dock.
    var dock = document.querySelector('[data-cards]');
    var key = dock && dock.getAttribute('data-key');
    if (dock && key && key.charAt(0) === 'p') {
      var id = Number(key.slice(1)), x = pushes().filter(function (p) { return p.id === id; })[0], card = dock.querySelector('.rm-card');
      if (x && card && (x.kind === 'sprint' || x.kind === 'deposit')) {
        var left = ensureTimer(card, deadlineFor(x.kind), card.querySelector('.rm-card-h'));
        var go = card.querySelector('[data-card-go]');
        if (go && x.kind === 'sprint' && left != null && left <= 0) go.disabled = true;
      }
    }

    // The Sprint sheet: timer under the price, the "paying as" line, and no buying after a price hold ends.
    var sh = document.querySelector('[data-esheet="sprint"] .rm-offer');
    if (sh && sh.querySelector('[data-sp-buy]')) {
      var d = deadlineFor('sprint');
      var l2 = ensureTimer(sh, d, sh.querySelector('.rm-price'));
      var sp = sprint();
      if (sp && sp.payingAs && !sh.querySelector('[data-paying-as]')) {
        var p = core.h('p', { class: 'rm-fine', 'data-paying-as': '' }, sp.payingAs);
        var btn = sh.querySelector('[data-sp-buy]'); btn.parentNode.insertBefore(p, btn.nextSibling);
      }
      if (d && l2 != null && l2 <= 0) {
        sh.querySelectorAll('[data-sp-buy], [data-sp-confirm]').forEach(function (b) { b.disabled = true; });
        var err = sh.querySelector('[data-sp-err]'); if (err && d.closed) { err.textContent = d.closed; err.hidden = false; }
      }
    }

    // The deposit sheet: who is paying.
    var os = document.querySelector('[data-offer-sheet] [data-offer]');
    var pay = core.E && core.E.data && core.E.data.pay;
    if (os && pay && pay.payingAs && !os.querySelector('[data-paying-as]')) {
      var b2 = os.querySelector('[data-buy]');
      if (b2) b2.parentNode.insertBefore(core.h('p', { class: 'rm-fine', 'data-paying-as': '' }, pay.payingAs), b2.nextSibling);
    }
  }

  function boot() {
    core = window.RoomCore;
    if (!core) { setTimeout(boot, 200); return; }
    if (core.isStaff) return;
    setInterval(tick, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

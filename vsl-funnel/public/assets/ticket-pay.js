/* The Masterclass ticket on our own page: Whop's payment elements (PCI-isolated fields from cdn.whop.com)
   collect the card with Whop's save-for-later consent and hand back a single-use confirmation token. The
   server creates the payment from it (card saved, so the First Deal Sprint is one click later); any step the
   buyer still owes (3D Secure) runs here with the payment's client secret. */
(function () {
  'use strict';
  // The Masterclass ticket (FUNNEL.webinar.ticketPay) or a First Deal Challenge ticket / VIP (FUNNEL.ticketPay).
  var T = ((window.FUNNEL || {}).webinar || {}).ticketPay || (window.FUNNEL || {}).ticketPay;
  var box = document.querySelector('[data-ticket-pay]');
  if (!T || !box) return;
  var F = window.funnel || { track: function () {} };
  var C = T.copy || {};
  var btn = box.querySelector('[data-ticket-pay-btn]');
  var err = box.querySelector('[data-ticket-pay-err]');
  function fail(text) {
    err.hidden = false; err.textContent = text || C.failed || '';
    var a = document.createElement('a'); a.href = T.hostedUrl; a.textContent = C.hostedLink || 'Pay on Whop';
    err.appendChild(document.createTextNode(' ')); err.appendChild(a);
    btn.disabled = false; btn.textContent = C.button;
  }
  function post(body) {
    return fetch(T.payUrl || '/api/webinar/ticket/pay', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
  }

  var s = document.createElement('script');
  s.src = T.src; s.setAttribute('data-whop-elements', '');
  s.onerror = function () { box.querySelector('[data-whop-payment]').textContent = ''; fail(C.failed); };
  s.onload = start;
  document.head.appendChild(s);

  function start() {
    var whop, payments;
    try {
      whop = window.WhopElements();
      payments = whop.payments.create({
        accountId: T.accountId, currency: T.currency, amount: T.amount,
        setupFutureUsage: T.saveCard === false ? undefined : 'off_session', // Whop shows its save consent and keeps the card for a later one-click charge
        returnUrl: T.returnUrl,
      });
      var slot = box.querySelector('[data-whop-payment]');
      slot.textContent = '';
      payments.create('payment', {
        onChange: function (e) { btn.disabled = !(e && e.complete); },
        defaultValues: T.name ? { billingDetails: { name: T.name } } : undefined,
      }).mount('[data-whop-payment]');
      payments.create('branding').mount('[data-whop-branding]');
    } catch (e) { fail(C.failed); return; }

    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      btn.disabled = true; btn.textContent = C.paying; err.hidden = true;
      F.track('cta_click', { id: T.trackId || 'webinar_ticket_pay' });
      payments.createConfirmationToken({ billingDetails: T.email ? { email: T.email } : {} }).then(function (res) {
        return post({ token: T.token, kind: T.kind, confirmation_token: res.confirmationToken });
      }, function (e) {
        // A closed Apple Pay / Google Pay sheet is a cancel, not an error.
        btn.disabled = false; btn.textContent = C.button;
        if (!e || e.code !== 'payment_request_cancelled') fail(e && e.message);
        return null;
      }).then(function (r) {
        if (!r) return;
        if (r.next) { location.href = r.next; return; }
        if (r.client_secret) {
          return whop.payments.handleNextAction({ clientSecret: r.client_secret, returnUrl: T.returnUrl }).then(function (n) {
            if (n.redirected) return;
            if (n.status === 'succeeded' || n.status === 'processing') { location.href = r.settle; return; }
            fail((n.lastPaymentError && n.lastPaymentError.message) || C.declined);
          }, function () { location.href = r.settle; });
        }
        if (r.payment) { location.href = r.settle; return; }
        fail(r.error);
      });
    });
  }
})();

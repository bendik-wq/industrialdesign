/* The optional add-on on the deposit welcome page (src/sales/deposit-addon.ts): one press charges the card just used
   for the deposit (the button states what, how much and which card), or "No thanks" hides it for good. */
(function () {
  'use strict';
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .catch(function () { return null; });
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    var buy = t.closest && t.closest('[data-dep-addon-buy]');
    var no = t.closest && t.closest('[data-dep-addon-no]');
    if (!buy && !no) return;
    e.preventDefault();
    var card = (buy || no).closest('[data-dep-addon]');
    var msg = card && card.querySelector('[data-dep-addon-msg]');
    if (no) {
      no.disabled = true;
      post('/api/deposit/addon/decline', { t: no.getAttribute('data-dep-addon-no') }).then(function () { if (card) card.remove(); });
      return;
    }
    if (buy.disabled) return;
    var label = buy.textContent;
    buy.disabled = true; buy.textContent = buy.getAttribute('data-paying') || 'Taking your payment…';
    post('/api/deposit/addon', { t: buy.getAttribute('data-dep-addon-buy') }).then(function (r) {
      if (r && r.ok && r.next) { location.href = r.next; return; }
      buy.disabled = false; buy.textContent = label;
      if (msg) { msg.hidden = false; msg.setAttribute('role', 'alert'); msg.textContent = (r && r.error) || 'The add-on can’t be bought right now. Your deposit and your place are unaffected.'; }
    });
  });
})();

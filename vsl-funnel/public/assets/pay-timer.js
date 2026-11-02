/* The pay page's countdown (src/sales/paylinks.ts timerHtml): counts down to the deadline the server rendered,
 * corrected by the server's clock at render time. At zero the page reloads, and the server shows the offer as
 * closed (it refuses the payment too). */
(function () {
  'use strict';
  var el = document.querySelector('[data-pay-deadline]');
  if (!el) return;
  var at = Number(el.getAttribute('data-pay-deadline')), skew = Number(el.getAttribute('data-pay-now')) - Date.now();
  var out = el.querySelector('[data-pay-left]');
  function p(n) { return (n < 10 ? '0' : '') + n; }
  function clock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return d ? d + 'd ' + h + 'h ' + p(m) + 'm' : h ? h + ':' + p(m) + ':' + p(x) : m + ':' + p(x);
  }
  var t = setInterval(function () {
    var left = at - (Date.now() + skew);
    if (out) out.textContent = clock(left);
    if (left <= 0) { clearInterval(t); setTimeout(function () { location.reload(); }, 1500); }
  }, 1000);
})();

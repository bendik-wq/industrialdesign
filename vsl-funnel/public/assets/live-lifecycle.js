/* Builder E "lifecycle": the confirmation / pre-show page on a registrant's room link (calendar, one-tap text
   reminders, the pre-session question and worksheet, the referral link), and the browser's time zone on the
   registration form. Every save goes to /api/live/lc/* with the person's own token. */
(function () {
  'use strict';
  var F = window.FUNNEL || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { tz = ''; }
  // Registration form: the zone their reminders are timed in.
  var tzIn = $('[data-lc-tz]'); if (tzIn) tzIn.value = tz;

  var L = F.lc;
  if (!L) return;
  var C = L.copy || {};
  var skew = F.live && F.live.serverNow ? F.live.serverNow - Date.now() : 0;
  function post(path, body) {
    body = body || {}; body.token = L.token;
    return fetch(L.api + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }); }).catch(function () { return {}; });
  }
  if (tz) post('/tz', { tz: tz });

  // The waiting room opens on the server's clock: then the button replaces the countdown.
  var enter = $('[data-lc-enter]'), count = $('[data-lc-opens]');
  function opens() { if (Date.now() + skew >= L.opensAt) { if (enter) enter.hidden = false; if (count) count.hidden = true; return true; } return false; }
  if (!opens()) { var iv = setInterval(function () { if (opens()) clearInterval(iv); }, 1000); }

  // Calendar: the server records the click on its way to the provider.
  Array.prototype.forEach.call(document.querySelectorAll('[data-lc-cal]'), function (a) {
    a.addEventListener('click', function () { var d = $('[data-lc-cal-done]'); if (d) setTimeout(function () { d.hidden = false; }, 400); if (window.funnel && window.funnel.track) window.funnel.track('live_calendar_add', { kind: a.getAttribute('data-lc-cal') }); });
  });

  // Remind me by text: one tap, the consent wording sits under the button.
  var smsBtn = $('[data-lc-sms]');
  if (smsBtn) smsBtn.onclick = function () {
    var phone = $('[data-lc-phone]'), err = $('[data-lc-sms-err]');
    smsBtn.disabled = true; err.hidden = true;
    post('/sms', { phone: phone ? phone.value : '' }).then(function (r) {
      smsBtn.disabled = false;
      if (r && r.ok) { $('[data-lc-sms-form]').hidden = true; $('[data-lc-sms-on]').hidden = false; return; }
      err.textContent = r && r.error === 'stopped' ? C.smsStopped : (r && r.error) || C.failed; err.hidden = false;
    });
  };

  // Round 4 lifecycle2: a saved question or worksheet marks its lead-in part done (no email for it goes later).
  function lc2Done(path) {
    var steps = path === '/question' ? ['question'] : path === '/worksheet' ? ['prework', 'essentials'] : [];
    steps.forEach(function (k) {
      var li = $('[data-lc2-step="' + k + '"]'); if (!li) return;
      li.classList.add('is-done');
      var st = $('[data-lc2-state]', li); if (st) { st.setAttribute('data-lc2-state', 'done'); st.textContent = st.getAttribute('data-lc2-done') || st.textContent; }
    });
  }
  function wire(form, path, collect) {
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var ok = $('[data-lc-ok]', form), err = $('[data-lc-err]', form), btn = $('button[type=submit]', form);
      err.hidden = true; ok.hidden = true; btn.disabled = true;
      post(path, collect(form)).then(function (r) {
        btn.disabled = false;
        if (r && r.ok) { ok.hidden = false; lc2Done(path); } else { err.textContent = (r && r.error) || C.failed; err.hidden = false; }
      });
    });
  }
  wire($('[data-lc-question]'), '/question', function (f) { return { text: f.text.value }; });
  wire($('[data-lc-worksheet]'), '/worksheet', function (f) { var b = {}; Array.prototype.forEach.call(f.querySelectorAll('input'), function (i) { b[i.name] = i.value; }); return b; });

  // The referral link: copy, or the phone's share sheet.
  var link = $('[data-lc-reflink]'), copyBtn = $('[data-lc-copy]'), share = $('[data-lc-share]');
  if (copyBtn && link) copyBtn.onclick = function () {
    var done = function () { copyBtn.textContent = C.copied; setTimeout(function () { copyBtn.textContent = C.copy; }, 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link.value).then(done, function () { link.select(); document.execCommand('copy'); done(); });
    else { link.select(); document.execCommand('copy'); done(); }
  };
  if (share && navigator.share && L.refUrl) {
    share.hidden = false;
    share.onclick = function () { navigator.share({ text: L.shareText, url: L.refUrl }).catch(function () { /* closed */ }); };
  }
})();

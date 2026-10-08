/* Multi-step application. One question per screen; every step is saved
 * server-side the moment it's answered, so nothing is lost if they leave. */
(function () {
  'use strict';
  var F = window.funnel;
  var cfg = window.FUNNEL || {};
  var questions = cfg.questions || [];
  var form = document.querySelector('[data-app]');
  var progress = document.querySelector('[data-progress]');
  var stepLabel = document.querySelector('[data-step-label]');
  var timeLeft = document.querySelector('[data-time-left]');
  if (!form || !questions.length) return;

  var resume = cfg.resume || null;
  var answers = (resume && resume.answers) || {};
  var contact = (resume && resume.contact) || {};
  var index = resume ? Math.min(resume.step || 0, questions.length - 1) : 0;
  var busy = false;
  var turnstileToken = null;

  var PLACEHOLDER_PHONE = { AU: '0412 345 678', NZ: '021 123 4567', US: '(555) 123-4567', CA: '(555) 123-4567', GB: '07700 900123' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function api(path, data) {
    return fetch('/api/apply/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); })
      .catch(function () { return { error: 'Connection problem — please check your internet and try again.', _status: 0 }; });
  }

  function setProgress() {
    var pct = Math.round((index / questions.length) * 100);
    progress.style.width = Math.max(4, pct) + '%';
    stepLabel.textContent = 'Step ' + (index + 1) + ' of ' + questions.length;
    var secs = (questions.length - index) * 12;
    timeLeft.textContent = secs >= 60 ? 'About ' + Math.round(secs / 60) + ' min left' : 'About ' + secs + ' seconds left';
  }

  function showError(msg, field) {
    var box = form.querySelector('.form-error');
    if (!box) { box = document.createElement('p'); box.className = 'form-error'; box.setAttribute('role', 'alert'); form.prepend(box); }
    box.textContent = msg;
    if (field) {
      var f = form.querySelector('[name="' + field + '"]');
      if (f) { f.closest('.field') && f.closest('.field').classList.add('invalid'); f.focus(); }
    }
    F.track('form_error', { step: index + 1, field: field || '' });
  }

  function navHtml(label, showBack) {
    return '<div class="app-nav">' + (showBack ? '<button type="button" class="back" data-back>← Back</button>' : '<span></span>') +
      '<button type="submit" class="btn">' + esc(label) + ' <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>';
  }

  function render() {
    setProgress();
    var q = questions[index];
    var isLast = index === questions.length - 1;
    var html = '<div class="app-step" data-q="' + esc(q.id) + '"><h2 tabindex="-1">' + esc(q.title) + '</h2>' + (q.help ? '<p class="help">' + esc(q.help) + '</p>' : '');

    if (q.type === 'contact') {
      html += '<div class="row2"><div class="field"><label for="first_name">First name</label><input id="first_name" name="first_name" autocomplete="given-name" required value="' + esc(contact.first_name) + '"></div>' +
        '<div class="field"><label for="last_name">Last name</label><input id="last_name" name="last_name" autocomplete="family-name" value="' + esc(contact.last_name) + '"></div></div>' +
        '<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" inputmode="email" autocomplete="email" required value="' + esc(contact.email) + '"></div>' +
        '<div class="field"><label for="phone">Mobile (WhatsApp)</label><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="' + esc(PLACEHOLDER_PHONE[cfg.country] || '+61 412 345 678') + '" value="' + esc(contact.phone) + '"></div>' +
        '<label class="check"><input type="checkbox" name="whatsapp_opt_in"' + (contact.whatsapp_opt_in ? ' checked' : '') + '> Send me the free acquisition resources and call reminders on WhatsApp</label>' +
        navHtml('Continue', false);
    } else if (q.type === 'single' || q.type === 'multi') {
      var multi = q.type === 'multi';
      var current = answers[q.id];
      html += '<div class="opts" role="' + (multi ? 'group' : 'radiogroup') + '">';
      q.options.forEach(function (o, i) {
        var on = multi ? (current || []).indexOf(o.value) !== -1 : current === o.value;
        html += '<button type="button" class="opt" data-v="' + esc(o.value) + '" ' + (multi ? 'aria-pressed' : 'role="radio" aria-checked') + '="' + on + '"><span class="key">' + String.fromCharCode(65 + i) + '</span><span>' + esc(o.label) + '</span></button>';
      });
      html += '</div>' + (multi ? navHtml('Continue', true) : '<div class="app-nav"><button type="button" class="back" data-back>← Back</button><span></span></div>');
    } else if (q.type === 'text') {
      html += '<div class="field"><textarea name="' + esc(q.id) + '" placeholder="' + esc(q.placeholder || '') + '" maxlength="2000">' + esc(answers[q.id] || '') + '</textarea></div>' +
        navHtml(isLast ? 'Submit my application' : 'Continue', true);
    }
    html += '</div>';
    form.innerHTML = html;
    var focusEl = form.querySelector('input, textarea') || form.querySelector('h2');
    if (focusEl && index > 0) focusEl.focus({ preventScroll: true });
    // Keep the form in view (it sits mid-page on the landing page).
    var card = form.closest('.form-card') || form;
    var top = card.getBoundingClientRect().top;
    if (index > 0 && (top < 0 || top > innerHeight * 0.6)) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    F.track('app_view_step', { step: index + 1, question: q.id });
    if (q.type === 'contact') mountTurnstile();
  }

  function mountTurnstile() {
    if (!cfg.turnstileSiteKey) return;
    var slot = document.querySelector('[data-turnstile]');
    (function wait() {
      if (!window.turnstile) return setTimeout(wait, 200);
      if (slot.dataset.mounted) return;
      slot.dataset.mounted = '1';
      window.turnstile.render(slot, { sitekey: cfg.turnstileSiteKey, size: 'flexible', appearance: 'interaction-only', callback: function (t) { turnstileToken = t; } });
    })();
  }

  function next() {
    index = Math.min(index + 1, questions.length - 1);
    render();
  }

  function saveContact() {
    var data = {
      first_name: form.first_name.value,
      last_name: form.last_name.value,
      email: form.email.value,
      phone: form.phone.value,
      whatsapp_opt_in: form.whatsapp_opt_in.checked,
      turnstile: turnstileToken,
      event_id: F.uid()
    };
    contact = data;
    return api('contact', data).then(function (r) {
      if (r.error) return showError(r.error, r.field);
      if (r.leadEventId) F.pixel('Lead', r.leadEventId);
      next();
    });
  }

  function saveAnswer(q, value) {
    answers[q.id] = value;
    return api('answer', { question: q.id, value: value }).then(function (r) {
      if (r._status === 409) { index = 0; render(); return showError(r.error); }
      if (r.error) return showError(r.error, r.field);
      if (index === questions.length - 1) return submit();
      next();
    });
  }

  function submit() {
    form.innerHTML = '<div class="analyzing" role="status"><div class="spinner"></div><h2 class="h3">Reviewing your answers…</h2><p class="help">This only takes a moment.</p></div>';
    progress.style.width = '100%';
    var minWait = new Promise(function (r) { setTimeout(r, 1600); });
    var eid = F.uid();
    return Promise.all([api('submit', { event_id: eid }), minWait]).then(function (res) {
      var r = res[0];
      if (r.error) { render(); return showError(r.error, r.field); }
      F.pixel('SubmitApplication', r.events && r.events.submitted);
      if (r.tier === 'A' || r.tier === 'B') F.pixel('QualifiedLead', r.events && r.events.qualified, { lead_tier: r.tier }, true);
      F.flush(true);
      location.href = r.next || '/breakout';
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var q = questions[index];
    form.querySelectorAll('.invalid').forEach(function (n) { n.classList.remove('invalid'); });
    var p;
    if (q.type === 'contact') {
      if (!form.first_name.value.trim()) return showError('Please enter your first name', 'first_name');
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(form.email.value.trim())) return showError('Please enter a valid email address', 'email');
      if (form.phone.value.replace(/\D/g, '').length < 8) return showError('Please enter a valid mobile number', 'phone');
      p = saveContact();
    } else if (q.type === 'multi') {
      if (!(answers[q.id] || []).length) return showError('Pick at least one option');
      p = saveAnswer(q, answers[q.id]);
    } else if (q.type === 'text') {
      var v = form[q.id].value.trim();
      if (v.length < (q.minLength || 1)) return showError('Please write a little more (at least ' + q.minLength + ' characters)', q.id);
      p = saveAnswer(q, v);
    }
    if (p) { busy = true; setBusy(true); p.then(function () { busy = false; setBusy(false); }); }
  });

  function setBusy(on) {
    var b = form.querySelector('button[type="submit"]');
    if (b) b.disabled = on;
  }

  form.addEventListener('click', function (e) {
    if (e.target.closest('[data-back]')) {
      F.track('app_back', { step: index + 1 });
      index = Math.max(0, index - 1);
      render();
      return;
    }
    var opt = e.target.closest('.opt');
    if (!opt || busy) return;
    var q = questions[index];
    var v = opt.getAttribute('data-v');
    if (q.type === 'multi') {
      var list = (answers[q.id] || []).slice();
      var i = list.indexOf(v);
      if (i === -1) list.push(v); else list.splice(i, 1);
      answers[q.id] = list;
      opt.setAttribute('aria-pressed', String(i === -1));
    } else {
      form.querySelectorAll('.opt').forEach(function (o) { o.setAttribute('aria-checked', String(o === opt)); });
      busy = true;
      setTimeout(function () { saveAnswer(q, v).then(function () { busy = false; }); }, 220);
    }
  });

  // Keyboard: A, B, C… picks an option.
  document.addEventListener('keydown', function (e) {
    if (e.target.matches && e.target.matches('input, textarea')) return;
    var k = e.key.toUpperCase();
    if (k.length !== 1 || k < 'A' || k > 'Z') return;
    var opts = form.querySelectorAll('.opt');
    var o = opts[k.charCodeAt(0) - 65];
    if (o) o.click();
  });

  render();
})();

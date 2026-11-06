/* The acquisition readiness quiz (/quiz) and its result page (/quiz/r/<token>).
 * /quiz: the intro, one question per screen (tap to answer, Back to change), then the email gate. Every answer is
 * saved as it is given (so drop-off per step is real); the gate sends the lot again with the name and email.
 * /quiz/r: "Save my seat" registers in one click for the showing picked (or the next live event).
 * Events are tracked on the server (quiz_start, quiz_answer, quiz_gate_view, quiz_lead, quiz_result, quiz_register);
 * the Pixel copies here share their event ids so Meta keeps one of each. */
(function () {
  'use strict';
  var cfg = window.FUNNEL || {};
  var F = window.funnel || { track: function () {}, pixel: function () {}, uid: function () { return ''; } };
  var uid = function (p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); };
  function post(path, body) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .catch(function () { return { ok: false }; });
  }
  function showError(box, msg) { if (!box) return; box.textContent = msg; box.hidden = false; }

  // ───────────── the quiz ─────────────
  var Q = cfg.quiz;
  if (Q) {
    var screens = Array.prototype.slice.call(document.querySelectorAll('[data-screen]'));
    var intro = screens[0];
    var qs = screens.filter(function (s) { return s.getAttribute('data-screen') === 'q'; });
    var gate = document.querySelector('[data-screen="gate"]');
    var countEl = document.querySelector('[data-qz-count]');
    var progress = document.querySelector('[data-qz-progress]');
    var fill = document.querySelector('[data-qz-fill]');
    var total = qs.length;
    var KEY = 'gl_quiz_v1';
    var state = { token: null, answers: {}, at: Date.now() };
    var cur = -1; // -1 intro, 0..total-1 a question, total the gate
    var preview = Boolean(cfg.preview);
    var starting = null;

    var save = function () { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode */ } };
    try {
      var saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (saved && saved.token && Date.now() - (saved.at || 0) < 86400000) state = saved;
    } catch (e) { /* none */ }

    var mark = function (screen, value) {
      screen.querySelectorAll('.qz-opt').forEach(function (b) { b.setAttribute('aria-checked', b.getAttribute('data-v') === value ? 'true' : 'false'); });
    };
    qs.forEach(function (s) { var v = state.answers[s.getAttribute('data-q')]; if (v) mark(s, v); });

    var show = function (i, back) {
      cur = i;
      var target = i < 0 ? intro : i >= total ? gate : qs[i];
      screens.forEach(function (s) { s.hidden = s !== target; s.classList.toggle('back', Boolean(back)); });
      if (progress) progress.hidden = i < 0;
      if (fill) fill.style.width = (i < 0 ? 0 : Math.min(1, (i + 1) / (total + 1)) * 100) + '%';
      if (countEl) countEl.textContent = i < 0 ? '' : i >= total ? 'Last step' : (i + 1) + ' of ' + total;
      var h = target.querySelector('h1, h2');
      if (i >= 0 && h) { try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); } }
      window.scrollTo(0, 0);
      if (i >= total) {
        if (fill) fill.style.width = '100%';
        if (!preview && state.token) post('/api/quiz/gate', { token: state.token });
        var first = gate.querySelector('input[name="first_name"]');
        if (first && window.matchMedia('(min-width: 720px)').matches) setTimeout(function () { first.focus(); }, 60);
      }
    };

    var ensureToken = function () {
      if (preview) return Promise.resolve('preview');
      if (state.token) return Promise.resolve(state.token);
      if (!starting) starting = post('/api/quiz/start', { event_id: uid('qs') }).then(function (r) {
        starting = null;
        if (r && r.token) { state.token = r.token; state.answers = {}; state.at = Date.now(); save(); }
        return state.token;
      });
      return starting;
    };

    var startBtn = document.querySelector('[data-qz-start]');
    if (startBtn) startBtn.addEventListener('click', function () {
      if (state.token && Object.keys(state.answers).length) {
        // Picking up where they left off: the first unanswered question.
        var next = 0;
        while (next < total && state.answers[qs[next].getAttribute('data-q')]) next++;
        show(next);
        return;
      }
      state = { token: null, answers: {}, at: Date.now() };
      qs.forEach(function (s) { mark(s, ''); });
      ensureToken();
      show(0);
    });

    var advancing = false;
    qs.forEach(function (s, i) {
      s.querySelectorAll('.qz-opt').forEach(function (b) {
        b.addEventListener('click', function () {
          if (advancing) return;
          var q = s.getAttribute('data-q'), v = b.getAttribute('data-v');
          mark(s, v);
          state.answers[q] = v; state.at = Date.now(); save();
          ensureToken().then(function (t) { if (t && !preview) post('/api/quiz/answer', { token: t, question: q, value: v }); });
          advancing = true;
          setTimeout(function () { advancing = false; show(i + 1); }, 220);
        });
      });
    });
    document.querySelectorAll('[data-qz-back]').forEach(function (b) { b.addEventListener('click', function () { show(cur - 1, true); }); });

    // Number keys pick an answer on a question screen (desktop).
    document.addEventListener('keydown', function (e) {
      if (cur < 0 || cur >= total || e.metaKey || e.ctrlKey || e.altKey) return;
      var k = Number(e.key);
      if (!k) return;
      var opt = qs[cur].querySelectorAll('.qz-opt')[k - 1];
      if (opt) { e.preventDefault(); opt.click(); }
    });

    // ── the gate ──
    var form = document.querySelector('[data-qz-gate]');
    var errBox = form && form.querySelector('[data-qz-error]');
    var tsKey = cfg.turnstileSiteKey, tsSlot = form && document.querySelector('[data-turnstile]'), tsToken = null, tsId = null;
    if (form && tsKey && tsSlot) {
      var tries = 0;
      (function wait() { if (window.turnstile) tsId = window.turnstile.render(tsSlot, { sitekey: tsKey, size: 'flexible', appearance: 'interaction-only', callback: function (t) { tsToken = t; }, 'expired-callback': function () { tsToken = null; } }); else if (tries++ < 40) setTimeout(wait, 250); })();
    }
    var tsReset = function () { if (tsId != null && window.turnstile) { tsToken = null; try { window.turnstile.reset(tsId); } catch (e) { /* next render */ } } };
    var invalid = function (name) {
      form.querySelectorAll('input').forEach(function (i) { i.removeAttribute('aria-invalid'); });
      var el = name && form.querySelector('[name="' + name + '"]');
      if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
    };
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (preview) return;
      var btn = form.querySelector('button[type=submit]');
      var body = {
        first_name: form.first_name.value.trim(), email: form.email.value.trim(), phone: form.phone.value.trim(),
        call_consent: form.call_consent.checked, sms_consent: form.sms_consent.checked, consent_page: '/quiz', answers: state.answers, event_id: uid('ql'),
      };
      if (!body.first_name) { invalid('first_name'); return showError(errBox, 'Please enter your first name'); }
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(body.email)) { invalid('email'); return showError(errBox, 'Please enter a valid email address'); }
      var ts = document.querySelector('[name="cf-turnstile-response"]');
      if (tsToken) body.turnstile = tsToken; else if (ts) body.turnstile = ts.value;
      btn.disabled = true;
      errBox.hidden = true;
      ensureToken().then(function (t) {
        body.token = t;
        return post('/api/quiz/lead', body);
      }).then(function (r) {
        if (r && r.next) {
          F.pixel('QuizLead', body.event_id, { archetype: r.archetype || '', score: r.score || 0 }, true);
          try { sessionStorage.removeItem(KEY); } catch (x) { /* none */ }
          location.href = r.next;
          return;
        }
        btn.disabled = false;
        tsReset();
        if (r && r.field === 'token') { try { sessionStorage.removeItem(KEY); } catch (x) { /* none */ } state = { token: null, answers: state.answers, at: Date.now() }; }
        if (r && r.field === 'answers') { var miss = 0; while (miss < total && state.answers[qs[miss].getAttribute('data-q')]) miss++; show(miss); return; }
        invalid(r && r.field);
        showError(errBox, (r && r.error) || 'Something went wrong. Please try again.');
      });
    });

    // Funnel HQ previews: ?hq_step=3 opens question 3, ?hq_step=gate the gate.
    if (preview && Q.step) {
      if (Q.step === 'gate') show(total);
      else if (Number(Q.step) >= 1) {
        var at = Math.min(total, Number(Q.step)) - 1;
        if (Q.step === '3') mark(qs[at], qs[at].querySelector('.qz-opt:nth-child(2)').getAttribute('data-v'));
        show(at);
      }
    }
  }

  // ───────────── the result: one click to a seat ─────────────
  var R = cfg.quizResult;
  var seat = R && document.querySelector('[data-qz-seat]');
  if (seat) seat.addEventListener('submit', function (e) {
    e.preventDefault();
    if (cfg.preview) return;
    var btn = seat.querySelector('button[type=submit]');
    var box = seat.querySelector('[data-qz-error]');
    var picked = seat.querySelector('input[name="session_id"]:checked');
    var ev = seat.querySelector('input[name="event_id"]');
    var body = { token: R.token, session_id: picked ? picked.value : '', event_id: ev ? ev.value : '', track_id: uid('wr'), pixel_eid: F.uid ? F.uid() : '' };
    btn.disabled = true;
    box.hidden = true;
    post('/api/quiz/register', body).then(function (r) {
      if (r && r.next) {
        var live = R.target === 'live';
        var data = live
          ? { content_name: 'Live webinar registration', content_category: 'live_webinar', content_ids: ['live_webinar'], content_type: 'product', funnel: 'live', source: 'quiz' }
          : { content_name: 'Masterclass registration', content_category: 'masterclass', content_ids: ['masterclass'], content_type: 'product', funnel: 'auto', edition: R.edition || '', session_slot: picked ? picked.getAttribute('data-slot') || '' : '', source: 'quiz' };
        F.pixel('CompleteRegistration', body.track_id, data);
        F.pixel('Lead', body.pixel_eid);
        location.href = F.xdUrl ? F.xdUrl(r.next) : r.next;
        return;
      }
      btn.disabled = false;
      showError(box, (r && r.error) || 'Something went wrong. Please try again.');
    });
  });
})();

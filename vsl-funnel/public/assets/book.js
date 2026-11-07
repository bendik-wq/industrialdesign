/* Booking on /book.
 * One-tap (FUNNEL.booking.oneTap): the next open times of the closer's calendar as buttons, in the lead's own time
 * zone. A tap opens a confirm sheet with their application details; "Confirm my call" books it server-side through
 * Calendly's Scheduling API (/api/book/confirm) and moves on to the booked page. If that can't work, the Calendly
 * calendar below takes over with their details filled in.
 * The embed: Calendly as a plain iframe (no third-party script); its postMessage events tell us the moment a call is
 * booked. The lead id rides along in Calendly's salesforce_uuid / Cal.com metadata so the signed webhook can match
 * the booking even if the email differs. */
(function () {
  'use strict';
  var F = window.funnel;
  var b = (window.FUNNEL || {}).booking;
  var slot = document.querySelector('[data-calendar]');
  if (!b || !slot) return;

  var p = b.prefill || {};
  var isCalendly = b.provider === 'calendly';
  var embedded = false;

  function loadEmbed(extra) {
    if (embedded) return;
    embedded = true;
    slot.hidden = false;
    var url = new URL(b.url);
    if (isCalendly) {
      url.searchParams.set('embed_domain', location.host);
      url.searchParams.set('embed_type', 'Inline');
      // Calendly's own cookie banner stays on for visitors who must consent (EU, UK, EEA, CH).
      if (!(window.FUNNEL || {}).consentRequired) url.searchParams.set('hide_gdpr_banner', '1');
      if (p.name) url.searchParams.set('name', p.name);
      if (p.email) url.searchParams.set('email', p.email);
      if (p.leadId) url.searchParams.set('salesforce_uuid', p.leadId);
      url.searchParams.set('utm_source', 'funnel');
      url.searchParams.set('utm_content', p.ref || '');
      // The booking form's answers from the application (a1, a2…) and the phone, when one-tap handed over.
      Object.keys(extra || {}).forEach(function (k) {
        if (/^(a\d{1,2}|location|utm_medium)$/.test(k) && typeof extra[k] === 'string' && extra[k]) url.searchParams.set(k, extra[k]);
      });
    } else {
      // Cal.com and most schedulers accept name/email prefill; Cal.com also takes metadata[...].
      if (p.name) url.searchParams.set('name', p.name);
      if (p.email) url.searchParams.set('email', p.email);
      if (p.leadId) url.searchParams.set('metadata[lead_id]', p.leadId);
    }
    var iframe = document.createElement('iframe');
    iframe.src = url.toString();
    iframe.title = 'Book your call';
    iframe.loading = 'eager';
    iframe.allow = 'payment';
    slot.innerHTML = '';
    slot.appendChild(iframe);
    F.track('booking_view', { provider: b.provider, mode: 'embed' });

    var done = false;
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || typeof d !== 'object') return;
      var host;
      try { host = new URL(e.origin).hostname; } catch (err) { return; }
      if (isCalendly && /(^|\.)calendly\.com$/.test(host)) {
        if (d.event === 'calendly.page_height' && d.payload && d.payload.height) iframe.style.height = Math.max(700, parseInt(d.payload.height, 10)) + 'px';
        if (d.event === 'calendly.date_and_time_selected') F.track('booking_date_selected', {});
        if (d.event === 'calendly.event_scheduled' && !done) {
          done = true;
          var uri = d.payload && d.payload.event && d.payload.event.uri;
          F.track('booking_scheduled_client', { event_uri: uri || '' });
          F.flush(true);
          fetch('/api/booking/client', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'calendly', event_uri: uri }) })
            .then(function (r) { return r.json(); })
            .catch(function () { return {}; })
            .then(function (r) { setTimeout(function () { location.href = (r && r.next) || '/breakout'; }, 1800); });
        }
      }
      // Cal.com embed messages
      if (!isCalendly && /(^|\.)cal\.com$/.test(host) && (d.type === 'bookingSuccessful' || (d.fullType && /bookingSuccessful/.test(d.fullType))) && !done) {
        done = true;
        fetch('/api/booking/client', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'cal' }) })
          .finally(function () { location.href = '/breakout'; });
      }
    });
  }

  var ot = b.oneTap;
  var box = document.querySelector('[data-onetap]');
  var sheet = document.querySelector('[data-ot-sheet]');
  if (!ot || !box || !sheet) { loadEmbed(); return; }

  // ───────────── one-tap ─────────────
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var meta = $('[data-ot-meta]', box);
  var note = $('[data-ot-note]', box);
  var daysEl = $('[data-ot-days]', box);
  var moreBtn = $('[data-ot-more]', box);
  var confirmBtn = $('[data-ot-confirm]', sheet);
  var errEl = $('[data-ot-err]', sheet);
  var form = $('[data-ot-form]', sheet);
  var view = $('[data-ot-view]', sheet);
  var details = { name: (ot.details || {}).name || '', email: (ot.details || {}).email || '', phone: (ot.details || {}).phone || '' };
  var edited = false;
  var data = null;
  var showWeek = false;
  var picked = null;
  var lastFocus = null;
  var busy = false;
  var browserTz = '';
  try { browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { browserTz = ''; }

  slot.hidden = true;
  box.hidden = false;
  F.track('booking_view', { provider: b.provider, mode: 'one_tap' });

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function say(msg) { note.textContent = msg || ''; note.hidden = !msg; }
  function post(path, body) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); });
  }

  function toEmbed(msg, prefill) {
    closeSheet();
    say(msg || '');
    daysEl.hidden = true;
    meta.hidden = true;
    $('.ot-foot', box).hidden = true;
    loadEmbed(Object.assign({ utm_medium: 'one_tap_fallback' }, prefill || {}));
  }

  function dayHead(d) {
    var parts = String(d.label).split(' ');
    return '<h3 class="ot-day-h">' + esc(parts[0]) + ' <span>' + esc(parts.slice(1).join(' ')) + '</span></h3>';
  }
  function render() {
    var list = showWeek ? data.week : data.days;
    meta.innerHTML = 'Times in <strong>' + esc(data.tzLabel) + '</strong>. Your call is with ' + esc(data.closer) + '.';
    daysEl.className = 'ot-days' + (showWeek ? ' ot-week' : '');
    daysEl.setAttribute('aria-busy', 'false');
    daysEl.innerHTML = list.map(function (d) {
      var ts = showWeek ? d.all : d.times;
      return '<div class="ot-day">' + dayHead(d) + '<ul class="ot-times">' + ts.map(function (t) {
        return '<li><button class="ot-time" type="button" aria-pressed="false" data-ot-slot="' + esc(t.id) + '" data-when="' + esc(d.label + ', ' + t.label) + '" aria-label="' + esc(d.label + ' at ' + t.label) + '">' + esc(t.label) + '</button></li>';
      }).join('') + '</ul></div>';
    }).join('');
    var hasMore = data.week && (data.week.length > data.days.length || data.week.some(function (d) { return d.all.length > d.times.length; }));
    moreBtn.hidden = !hasMore;
    moreBtn.textContent = showWeek ? 'Fewer times' : 'More times';
  }
  function show(d) {
    data = d;
    if (!data.days || !data.days.length) return toEmbed(d.message, d.prefill);
    render();
  }

  function load() {
    if (ot.sample) return show(ot.sample); // Funnel HQ preview: sample times, nothing is booked
    post('/api/book/times', { tz: browserTz }).then(function (r) {
      if (r && r.ok) show(r);
      else toEmbed(r && r.message, r && r.prefill);
    }).catch(function () { toEmbed(''); });
  }

  // The sheet
  function fillDetails() {
    ['name', 'email', 'phone'].forEach(function (k) {
      $('[data-ot-v="' + k + '"]', sheet).textContent = details[k] || '–';
      $('#ot-' + k, sheet).value = details[k] || '';
    });
  }
  function openSheet(btn) {
    picked = { slot: btn.getAttribute('data-ot-slot'), when: btn.getAttribute('data-when') };
    Array.prototype.forEach.call(daysEl.querySelectorAll('.ot-time'), function (x) { x.setAttribute('aria-pressed', x === btn ? 'true' : 'false'); });
    // "Thursday 13 November, 10:30 am Sydney time, with Josh" (the time and its zone kept on one line)
    $('[data-ot-when]', sheet).textContent = (picked.when + ' ' + data.tzLabel).replace(/ (am|pm|time)\b/g, ' $1') + ', with ' + data.closer;
    errEl.hidden = true;
    fillDetails();
    lastFocus = btn;
    sheet.hidden = false;
    document.documentElement.classList.add('ot-open');
    confirmBtn.disabled = Boolean(ot.sample);
    confirmBtn.focus();
    F.track('booking_date_selected', { mode: 'one_tap' });
  }
  function closeSheet() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    document.documentElement.classList.remove('ot-open');
    if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
  }
  function editMode(on) {
    form.hidden = !on;
    view.hidden = on;
    if (on) { edited = true; $('#ot-name', sheet).focus(); }
  }

  daysEl.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.ot-time');
    if (btn) openSheet(btn);
  });
  moreBtn.addEventListener('click', function () { showWeek = !showWeek; render(); });
  $('[data-ot-cal]', box).addEventListener('click', function () {
    F.track('cta_click', { id: 'one_tap_full_calendar' });
    $('[data-ot-cal]', box).hidden = true;
    loadEmbed({ utm_medium: 'one_tap_calendar' });
    slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('[data-ot-edit]', sheet).addEventListener('click', function () { editMode(true); });
  Array.prototype.forEach.call(sheet.querySelectorAll('[data-ot-close]'), function (el) { el.addEventListener('click', closeSheet); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !busy) closeSheet(); });

  confirmBtn.addEventListener('click', function () {
    if (busy || !picked || ot.sample) return;
    var body = { slot: picked.slot, tz: browserTz, reschedule: Boolean(ot.reschedule) };
    if (edited) {
      ['name', 'email', 'phone'].forEach(function (k) { details[k] = $('#ot-' + k, sheet).value.trim(); body[k] = details[k]; });
    }
    busy = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Booking your call…';
    errEl.hidden = true;
    post('/api/book/confirm', body).then(function (r) {
      busy = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm my call';
      if (r.ok || r.result === 'already_booked') {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Booked';
        location.href = r.next || '/breakout';
        return;
      }
      if (r.result === 'slot_taken') {
        closeSheet();
        say(r.message);
        showWeek = false;
        show(r);
        return;
      }
      if (r.fallback) return toEmbed(r.message, r.prefill);
      errEl.textContent = r.message || 'That didn’t go through. Try again in a moment.';
      errEl.hidden = false;
      if (r.field) { editMode(true); var f = $('#ot-' + r.field, sheet); if (f) f.focus(); }
    }).catch(function () {
      busy = false;
      toEmbed('We couldn’t reach the booking system. Pick a time in the calendar below. Your details are filled in.');
    });
  });

  load();
})();

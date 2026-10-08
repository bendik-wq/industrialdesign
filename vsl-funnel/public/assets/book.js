/* Booking calendar. Calendly is embedded as a plain iframe (no third-party
 * script) and its postMessage events tell us the moment a call is booked.
 * The lead id rides along in Calendly's salesforce_uuid / Cal.com metadata
 * so the signed webhook can match the booking even if the email differs. */
(function () {
  'use strict';
  var F = window.funnel;
  var b = (window.FUNNEL || {}).booking;
  var slot = document.querySelector('[data-calendar]');
  if (!b || !slot) return;

  var url = new URL(b.url);
  var p = b.prefill || {};
  var isCalendly = b.provider === 'calendly';
  if (isCalendly) {
    url.searchParams.set('embed_domain', location.host);
    url.searchParams.set('embed_type', 'Inline');
    url.searchParams.set('hide_gdpr_banner', '1');
    if (p.name) url.searchParams.set('name', p.name);
    if (p.email) url.searchParams.set('email', p.email);
    if (p.leadId) url.searchParams.set('salesforce_uuid', p.leadId);
    url.searchParams.set('utm_source', 'funnel');
    url.searchParams.set('utm_content', p.ref || '');
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
  F.track('booking_view', { provider: b.provider });

  var done = false;
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (isCalendly && /calendly\.com$/.test(new URL(e.origin).hostname)) {
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
    if (!isCalendly && (d.type === 'bookingSuccessful' || (d.fullType && /bookingSuccessful/.test(d.fullType))) && !done) {
      done = true;
      fetch('/api/booking/client', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'cal' }) })
        .finally(function () { location.href = '/breakout'; });
    }
  });
})();

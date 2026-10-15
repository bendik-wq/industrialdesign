/* Data-buyer page: sticky CTA, video play tracking, the claim form (then on to the partner's referral link). */
(function () {
  'use strict';
  var cfg = (window.FUNNEL || {}).data || {};
  var F = window.funnel || { track: function () {} };
  function track(n, p) { try { F.track(n, p || {}); } catch (e) { /* tracking never breaks the page */ } }

  // Sticky button on phones once the main one has scrolled away (hidden again near the form).
  var primary = document.querySelector('.cta-zone .btn'), sticky = document.querySelector('[data-sticky-cta]'), claim = document.getElementById('claim');
  if (primary && sticky && 'IntersectionObserver' in window) {
    var past = false, atForm = false;
    var set = function () { sticky.classList.toggle('on', past && !atForm); };
    new IntersectionObserver(function (e) { past = !e[0].isIntersecting && e[0].boundingClientRect.top < 0; set(); }).observe(primary);
    if (claim) new IntersectionObserver(function (e) { atForm = e[0].isIntersecting; set(); }).observe(claim);
  }

  // Video: a <video> reports play; an embed counts once the visitor interacts with it (focus moves into the iframe).
  var vid = document.querySelector('[data-data-video]');
  // HLS streams (our own VSL): Safari plays them natively; elsewhere attach hls.js, as the main VSL does.
  if (vid && /\.m3u8(\?|$)/.test(vid.getAttribute('src') || '') && !vid.canPlayType('application/vnd.apple.mpegurl')) {
    var hlsSrc = vid.getAttribute('src');
    vid.removeAttribute('src');
    var sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js';
    sc.onload = function () {
      if (window.Hls && window.Hls.isSupported()) { var h = new window.Hls({ capLevelToPlayerSize: true }); h.loadSource(hlsSrc); h.attachMedia(vid); }
      else vid.src = hlsSrc;
    };
    sc.onerror = function () { vid.src = hlsSrc; };
    document.head.appendChild(sc);
  }
  if (vid) vid.addEventListener('play', function once() { track('data_video_play', { kind: 'file' }); vid.removeEventListener('play', once); });
  var frame = document.querySelector('.data-video iframe');
  if (frame) {
    var sent = false;
    window.addEventListener('blur', function () { if (!sent && document.activeElement === frame) { sent = true; track('data_video_play', { kind: 'embed' }); } });
  }

  var form = document.querySelector('[data-data-claim]');
  if (!form) return;
  var started = false;
  form.addEventListener('focusin', function () { if (!started) { started = true; track('data_form_start', {}); } });
  function error(msg, field) {
    var box = form.querySelector('.form-error');
    if (!box) { box = document.createElement('p'); box.className = 'form-error'; box.setAttribute('role', 'alert'); form.prepend(box); }
    box.textContent = msg;
    if (field && form[field]) form[field].focus();
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = form.querySelector('button[type=submit]');
    var body = {
      first_name: form.first_name.value.trim(), email: form.email.value.trim(), company: form.company.value.trim(),
      website: form.website.value.trim(), phone: form.phone.value.trim(), revenue: form.revenue.value, business_status: form.business_status ? form.business_status.value : '', headline: cfg.headline || '',
    };
    var ts = document.querySelector('[name="cf-turnstile-response"]');
    if (ts) body.turnstile = ts.value;
    if (!body.first_name) return error('Please enter your first name', 'first_name');
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(body.email)) return error('Please enter a valid email address', 'email');
    if (!body.company) return error('Please enter your company name', 'company');
    btn.disabled = true;
    fetch(cfg.claim || '/api/data/claim', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }); }, function () { return {}; })
      .then(function (r) {
        btn.disabled = false;
        if (!r || !r.ok) return error((r && r.error) || 'Something went wrong — please try again.', r && r.field);
        if (r.next) { location.href = r.next; return; }
        form.hidden = true;
        document.querySelector('[data-done]').hidden = false;
      });
  });
})();

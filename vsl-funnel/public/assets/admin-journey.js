/* Funnel HQ: "where did this buyer come from" (overnight loop round 4, "journey").
   BuyerPath.lead(el, leadId, h)  → in the lead drawer: per purchase, the first ad / concept / hook, landing pages,
                                    events attended with minutes, room cards, questions by type, emails / texts /
                                    AI calls, checkout attempts and time to buy, then the step path and the full timeline.
   BuyerPath.common(el, ctx, funnel) → Webinar attribution: the most frequent paths to a deposit (or Sprint,
                                    engagement), how often each step appears, and what the buyers have in common.
   Every number is a real count from /admin/api/attribution/buyer/:lead and /admin/api/attribution/paths. */
(function (root) {
  'use strict';
  var CSS = '.bp-steps{display:flex;flex-wrap:wrap;gap:4px 2px;align-items:center;margin:6px 0}.bp-step{display:inline-block;font-size:12px;padding:2px 8px;border-radius:10px;background:var(--surface-2,#f5f5f7);color:var(--ink,#1d1d1f)}' +
    '.bp-step.buy{background:var(--series-1,#0f2c5c);color:#fff}.bp-arrow{color:var(--muted,#86868b);font-size:12px;padding:0 2px}' +
    '.bp-buy{border-top:1px solid var(--border,#e5e5e5);padding-top:12px;margin-top:12px}.bp-buy:first-of-type{border-top:0;margin-top:4px;padding-top:0}' +
    '.bp-h{font-size:14px;font-weight:600;margin:0 0 6px}.bp-kv{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;font-size:13px;margin:8px 0}.bp-kv dt{color:var(--muted,#86868b)}.bp-kv dd{margin:0;overflow-wrap:anywhere}' +
    '.bp-tl{list-style:none;padding:0;margin:8px 0 0;font-size:13px}.bp-tl li{display:grid;grid-template-columns:130px 1fr;gap:10px;padding:5px 0;border-top:1px solid var(--border,#e5e5e5)}.bp-tl .t{color:var(--muted,#86868b);font-variant-numeric:tabular-nums}.bp-tl .buy{font-weight:600}' +
    '.bp-seq{padding:10px 0;border-top:1px solid var(--border,#e5e5e5)}.bp-seq:first-child{border-top:0}.bp-seq .meta{font-size:12px;color:var(--muted,#86868b)}.bp-count{font-weight:600;font-variant-numeric:tabular-nums;margin-right:8px}' +
    '.bp-bars{display:grid;gap:5px}.bp-bar{display:grid;grid-template-columns:minmax(140px,260px) 1fr 90px;gap:10px;align-items:center;font-size:13px}.bp-track{height:14px;background:var(--surface-2,#f5f5f7);border-radius:3px;overflow:hidden}.bp-fill{height:100%;background:var(--series-1,#0f2c5c);min-width:2px}.bp-bar .num{text-align:right;font-variant-numeric:tabular-nums}' +
    '.bp-two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.bp-list{list-style:none;padding:0;margin:0;font-size:13px}.bp-list li{display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-top:1px solid var(--border,#e5e5e5)}.bp-list li span:first-child{overflow-wrap:anywhere}' +
    '@media (max-width:760px){.bp-two{grid-template-columns:1fr}.bp-kv{grid-template-columns:1fr}.bp-kv dt{margin-top:6px}.bp-tl li{grid-template-columns:1fr}.bp-bar{grid-template-columns:1fr 70px}.bp-bar .bp-track{grid-column:1/-1;order:2}}';
  function css() { if (!document.getElementById('bp-css')) { var s = document.createElement('style'); s.id = 'bp-css'; s.textContent = CSS; document.head.appendChild(s); } }
  var KIND_LABEL = { deposit_paid: 'Deposit', sprint_paid: 'First Deal Sprint', engagement_signed: 'Engagement signed' };
  var FUNNEL_LABEL = { auto: 'masterclass', live: 'live webinar', challenge: 'challenge' };

  function dur(h) {
    if (h == null) return '–';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' min';
    if (h < 48) return (Math.round(h * 10) / 10) + ' h';
    return (Math.round((h / 24) * 10) / 10) + ' days';
  }
  function steps(list, esc) {
    return '<div class="bp-steps">' + (list || []).map(function (s, i) {
      var buy = i === list.length - 1 && /^(Paid|Bought|Signed)/.test(s);
      return (i ? '<span class="bp-arrow" aria-hidden="true">→</span>' : '') + '<span class="bp-step' + (buy ? ' buy' : '') + '">' + esc(s) + '</span>';
    }).join('') + '</div>';
  }
  function money(v, cur) { if (v == null) return ''; try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(v); } catch (e) { return (cur || '') + ' ' + v; } }

  function buyHtml(b, h) {
    var esc = h.esc, f = b.first || {};
    var kv = function (k, v) { return v ? '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>' : ''; };
    var q = Object.keys(b.questions || {}).map(function (k) { return esc(k) + ' ' + b.questions[k]; }).join(', ');
    var src = [f.platform || f.channel, f.campaign].filter(Boolean).map(esc).join(' · ');
    return '<div class="bp-buy"><p class="bp-h">' + esc(KIND_LABEL[b.kind] || b.kind) + (b.funnel ? ' · ' + esc(FUNNEL_LABEL[b.funnel] || b.funnel) : '') + (b.amount ? ' · ' + esc(money(b.amount, b.currency)) : '') + ' <span class="muted">' + esc(h.when(b.at)) + '</span></p>' +
      '<dl class="bp-kv">' +
      kv('First touch', (src || 'Not tracked') + (f.ts ? ' <span class="muted">' + esc(h.when(f.ts)) + '</span>' : '')) +
      kv('First ad', f.adId ? esc(f.adName ? f.adName + ' (' + f.adId + ')' : f.adId) : '') +
      kv('Concept', f.concept ? esc(f.concept) : '') +
      kv('Hook', f.hook ? esc(f.hook) : '') +
      kv('Landing pages', (b.landers || []).length ? b.landers.map(esc).join('<br>') : '') +
      kv('Attended', (b.attended || []).length ? b.attended.map(function (a) { return esc(a.label); }).join('<br>') + (b.minutes ? '<br><span class="muted">' + esc(b.minutes) + ' min in all</span>' : '') : '') +
      kv('Room cards', b.pushes && b.pushes.seen ? esc(b.pushes.seen + ' seen, ' + b.pushes.opened + ' opened') : '') +
      kv('Questions asked', q) +
      kv('Emails', b.emails && b.emails.sent ? esc(b.emails.sent + ' sent, ' + b.emails.opened + ' opened, ' + b.emails.clicked + ' clicked') : '') +
      kv('Texts', b.sms && b.sms.sent ? esc(b.sms.sent + ' sent, ' + b.sms.clicked + ' clicked') : '') +
      kv('AI calls', b.calls && b.calls.made ? esc(b.calls.made + ' made, ' + b.calls.connected + ' connected') : '') +
      kv('Checkout attempts', b.checkouts && b.checkouts.attempts ? esc(b.checkouts.attempts + (b.checkouts.unpaid ? ' (' + b.checkouts.unpaid + ' left unpaid)' : '')) : '') +
      kv('Time to buy', esc(dur(b.hoursToBuy)) + ' <span class="muted">from the first touch</span>') +
      '</dl>' + steps(b.steps, esc) + '</div>';
  }

  function timelineHtml(events, h) {
    var esc = h.esc;
    return '<ul class="bp-tl">' + events.slice().reverse().map(function (e) {
      return '<li><span class="t">' + esc(h.when(e.ts)) + '</span><span' + (e.type === 'purchase' ? ' class="buy"' : '') + '>' + esc(e.label) + (e.detail && e.type !== 'purchase' ? ' <span class="muted">' + esc(e.detail) + '</span>' : '') + '</span></li>';
    }).join('') + '</ul>';
  }

  /** The lead drawer card. */
  function lead(el, leadId, h) {
    if (!el) return;
    css();
    fetch('/admin/api/attribution/buyer/' + encodeURIComponent(leadId), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      var esc = h.esc;
      if (!d || d.error) { el.innerHTML = '<h2>Where they came from</h2><p class="muted">' + esc((d && d.error) || 'Not available.') + '</p>'; return; }
      var ev = d.events || [];
      var soFar = []; ev.forEach(function (e) { if (e.token && soFar.indexOf(e.token) < 0) soFar.push(e.token); });
      el.innerHTML = '<h2>Where they came from</h2><p class="sub">' + (d.buyer ? 'Each purchase with what led to it, cut at the moment they paid.' : 'No deposit, Sprint or engagement yet. The path so far:') + '</p>' +
        (d.buyer ? d.buys.map(function (b) { return buyHtml(b, h); }).join('') : (soFar.length ? steps(soFar, esc) : '<p class="muted">Nothing tracked yet.</p>')) +
        (ev.length ? '<details style="margin-top:10px"><summary>Full timeline (' + ev.length + ' events)</summary>' + timelineHtml(ev, h) + '</details>' : '');
    }).catch(function () { el.innerHTML = '<h2>Where they came from</h2><p class="muted">Couldn’t load the buyer path.</p>'; });
  }

  var st = { kind: 'deposit_paid' };
  try { var k = localStorage.getItem('bp-kind'); if (k) st.kind = k; } catch (e) { /* private window */ }

  /** Funnel HQ → Webinar attribution → common paths to a purchase. */
  function common(el, ctx, funnel) {
    if (!el) return;
    css();
    var esc = ctx.esc, n = ctx.n, pct = ctx.pct;
    el.innerHTML = '<div class="card wa-card"><h2>Common paths to a purchase</h2><p class="muted">Loading…</p></div>';
    ctx.api('attribution/paths', { funnel: funnel, kind: st.kind }).then(function (d) {
      var kinds = [['deposit_paid', 'Deposit'], ['sprint_paid', 'Sprint'], ['engagement_signed', 'Engagement'], ['all', 'All purchases']];
      var seg = '<div class="seg" role="group" aria-label="Purchase">' + kinds.map(function (k) { return '<button type="button" data-bp-kind="' + k[0] + '" aria-pressed="' + (k[0] === st.kind) + '">' + esc(k[1]) + '</button>'; }).join('') + '</div>';
      var head = '<div class="card-head"><div><h2>Common paths to a purchase</h2><p class="wa-sub">Each buyer’s steps from the first touch to paying, first time each step happened. Identical paths are counted together. Real counts in the date range.</p></div></div><div class="wa-bar" style="margin-bottom:10px">' + seg + '</div>';
      if (!d || !d.buyers) { el.innerHTML = '<div class="card wa-card">' + head + ctx.emptyState('No buyers in this range yet', 'Each deposit, Sprint and signed engagement appears here with the path that led to it.') + '</div>'; bind(); return; }
      var tiles = '<div class="grid g-4 tiles">' + ctx.tile('Buyers', n(d.buyers), d.distinctPaths + ' distinct paths') + ctx.tile('Median time to buy', dur(d.medianHoursToBuy), 'from the first touch') +
        ctx.tile('Median minutes watched', d.medianMinutes == null ? '–' : n(d.medianMinutes), 'buyers who attended') + ctx.tile('Asked a question', n(d.askedAny), pct(d.askedAny / d.buyers) + ' of buyers') + '</div>';
      var seqs = '<h3 style="margin:16px 0 6px;font-size:14px">Most frequent paths</h3><div>' + d.sequences.map(function (s) {
        return '<div class="bp-seq"><div><span class="bp-count">' + n(s.count) + '</span><span class="meta">' + pct(s.share) + ' of buyers · median ' + esc(dur(s.medianHours)) + ' to buy · ' + s.leads.map(function (l, i) { return '<a href="/admin#lead=' + encodeURIComponent(l) + '">buyer ' + (i + 1) + '</a>'; }).join(', ') + '</span></div>' + steps(s.steps, esc) + '</div>';
      }).join('') + '</div>';
      var max = Math.max.apply(null, d.steps.map(function (s) { return s.count; }).concat([1]));
      var bars = '<h3 style="margin:16px 0 6px;font-size:14px">How often each step appears</h3><div class="bp-bars">' + d.steps.map(function (s) {
        return '<div class="bp-bar"><span>' + esc(s.label) + '</span><div class="bp-track"><div class="bp-fill" style="width:' + Math.round((s.count / max) * 100) + '%"></div></div><span class="num">' + n(s.count) + ' · ' + pct(s.share) + '</span></div>';
      }).join('') + '</div>';
      var list = function (title, rows, empty) { return '<div><h3 style="margin:16px 0 6px;font-size:14px">' + esc(title) + '</h3>' + (rows.length ? '<ul class="bp-list">' + rows.map(function (r) { return '<li><span>' + esc(r.label) + '</span><span>' + n(r.count) + '</span></li>'; }).join('') + '</ul>' : '<p class="muted small">' + esc(empty) + '</p>') + '</div>'; };
      var T = d.touched;
      var touched = '<p class="muted small" style="margin-top:14px">Before buying: ' + n(T.emailClicked) + ' clicked an email, ' + n(T.aiCallConnected) + ' spoke to the AI caller, ' + n(T.openedRoomCard) + ' opened a room card, ' + n(T.leftCheckoutFirst) + ' left a checkout unpaid first (of ' + n(d.buyers) + ').</p>';
      el.innerHTML = '<div class="card wa-card">' + head + tiles + seqs + bars +
        '<div class="bp-two">' + list('First touch', d.firstTouch, 'No first touch tracked.') + list('First ad', d.ads, 'No Meta ad id on these buyers’ first visits.') + list('Concept', d.concepts, 'No ad from the concept rounds.') + list('Hook', d.hooks, 'No ad from the concept rounds.') +
        list('Landing pages', d.landers, 'No landing pages tracked.') + list('Question types asked', d.questions, 'No questions asked before buying.') + '</div>' + touched + '</div>';
      bind();
    });
    function bind() {
      el.querySelectorAll('[data-bp-kind]').forEach(function (b) { b.onclick = function () { st.kind = b.getAttribute('data-bp-kind'); try { localStorage.setItem('bp-kind', st.kind); } catch (e) { /* ignore */ } common(el, ctx, funnel); }; });
    }
  }

  root.BuyerPath = { lead: lead, common: common, dur: dur };
})(window);

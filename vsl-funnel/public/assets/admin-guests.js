/* Funnel HQ → Settings & system → Guest access (owner), and the guest's own chrome (banner, Leave).
   - Owner: make a link for one person (who it is for, expiry, hide personal details), copy it once, see who used
     which link and when, revoke any link at once. APIs: /admin/api/guest-access* (src/admin/guest.ts).
   - Guest: a slim banner on every page, "Leave" instead of "Log out", no Guest access page, and a short note when
     something tries to change data (the server refuses every change; this only explains it).
   Loaded before admin.js; admin.js calls GuestAccess.render(ctx) for the tab. */
(function (root) {
  'use strict';
  var me = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function day(ms) { var d = new Date(ms); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function toast(msg, mine) { var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; if (mine) t.setAttribute('data-guest-toast', ''); document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2800); return t; }

  // ───────────── the guest's chrome ─────────────
  function guestChrome(w) {
    document.documentElement.classList.add('hq-guest');
    var bar = document.createElement('div');
    bar.className = 'guest-banner';
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<span><b>Guest view (read-only)</b> · shared by ' + esc(w.sharedBy) + (w.maskPii ? ' · personal details hidden' : '') + '</span>' +
      '<form method="post" action="/admin/guest/leave"><button type="submit">Leave</button></form>';
    document.body.insertBefore(bar, document.body.firstChild);
    // No Guest access page, no "Log out" (which ends the owner's sessions): "Leave" ends only this guest session.
    document.querySelectorAll('[data-nav] button[data-tab="guests"]').forEach(function (b) { b.remove(); });
    document.querySelectorAll('form[action="/admin/logout"]').forEach(function (f) {
      f.setAttribute('action', '/admin/guest/leave');
      var b = f.querySelector('button'); if (b) b.textContent = 'Leave guest view';
    });
    if (location.hash === '#guests' && root.HQApp) root.HQApp.go('home');
    // Explain refused changes (the server refuses them). Some screens toast "Saved" without reading the answer, so
    // for a moment after a refusal any other toast is replaced by this one: a guest is never told a change was made.
    var refusedAt = 0, shownAt = 0;
    var f0 = root.fetch;
    root.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var m = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      return f0.apply(this, arguments).then(function (res) {
        if (res.status === 403 && m !== 'GET' && !/\/ping(\?|$)/.test(url)) {
          refusedAt = Date.now();
          if (refusedAt - shownAt > 2500) { shownAt = refusedAt; toast('Guest view: changes are switched off.', true); }
        }
        return res;
      });
    };
    if (root.MutationObserver) {
      new MutationObserver(function (list) {
        if (Date.now() - refusedAt > 3000) return;
        list.forEach(function (r) { r.addedNodes.forEach(function (el) { if (el.classList && el.classList.contains('toast') && !el.hasAttribute('data-guest-toast')) el.remove(); }); });
      }).observe(document.body, { childList: true });
    }
  }

  function whoami() {
    return fetch('/admin/api/whoami', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  var ready = whoami().then(function (w) {
    me = w;
    if (w && w.guest) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { guestChrome(w); });
      else guestChrome(w);
    }
    return w;
  });

  // ───────────── the owner's page ─────────────
  var EXPIRY = [['1', '1 day'], ['7', '7 days'], ['30', '30 days'], ['custom', 'Custom']];

  function stateLabel(i) {
    if (i.state === 'revoked') return '<span class="pill">Revoked</span>';
    if (i.state === 'expired') return '<span class="pill">Expired</span>';
    return '<span class="pill st-booked">Active</span>';
  }

  function render(ctx) {
    var view = ctx.view;
    return ready.then(function (w) {
      if (w && w.guest) { view.innerHTML = '<div class="card">' + ctx.emptyState('Only the owner can open this.') + '</div>'; return; }
      return ctx.api('guest-access', {}, { noRange: true }).then(function (d) {
        var invites = (d && d.invites) || [];
        var active = invites.filter(function (i) { return i.state === 'active'; });
        var past = invites.filter(function (i) { return i.state !== 'active'; });
        view.innerHTML =
          '<div class="card ga-new"><h2>New guest link</h2><p class="sub">The person opens Funnel HQ through the link, without your password. They can look at every page but can’t change, send or export anything, and they never see your keys. You can switch the link off at any time.</p>' +
          '<form data-gu-form class="ga-form">' +
            '<label class="ga-f">Who it is for<input class="input" name="label" maxlength="80" required placeholder="Sam, our accountant" data-gu-label autocomplete="off"></label>' +
            '<label class="ga-f">Access<select class="input" name="role" disabled><option value="viewer">View only</option></select></label>' +
            '<label class="ga-f">Expires<select class="input" name="expiry" data-gu-exp>' + EXPIRY.map(function (e) { return '<option value="' + e[0] + '"' + (e[0] === '7' ? ' selected' : '') + '>' + e[1] + '</option>'; }).join('') + '</select></label>' +
            '<label class="ga-f" data-gu-custom hidden>Days (up to ' + (d.maxDays || 90) + ')<input class="input" name="days" type="number" min="1" max="' + (d.maxDays || 90) + '" step="1" value="14"></label>' +
            '<label class="check ga-check"><input type="checkbox" name="mask" checked> Hide personal details <span class="muted">(names shortened, emails and phones masked, notes and transcripts hidden)</span></label>' +
            '<div class="ga-actions"><button class="btn-sm" type="submit">Make link</button> <span class="muted" data-gu-msg></span></div>' +
          '</form><div data-gu-out></div></div>' +
          '<div class="card"><h2>Active links</h2><p class="sub">Revoking takes effect on the person’s next click.</p>' +
            ctx.table([
              { label: 'For', key: 'label' },
              { label: 'Access', html: function (i) { return 'View only' + (i.maskPii ? ' · details hidden' : ' · full details'); } },
              { label: 'Expires', html: function (i) { return esc(day(i.expiresAt)); } },
              { label: 'Last used', html: function (i) { return i.lastUsedAt ? esc(ctx.ago(i.lastUsedAt)) : '<span class="muted">not yet</span>'; } },
              { label: 'Visits', key: 'uses', num: true },
              { label: '', html: function (i) { return '<button type="button" class="btn-sm ghost" data-gu-log="' + esc(i.id) + '">Activity</button> <button type="button" class="btn-sm ghost ga-danger" data-gu-revoke="' + esc(i.id) + '" data-gu-name="' + esc(i.label) + '">Revoke</button>'; } },
            ], active, { empty: 'No active guest links.', emptyHint: 'Make one above to show someone around.', cards: 1 }) +
          '</div>' +
          (past.length ? '<div class="card"><h2>Expired and revoked</h2>' + ctx.table([
              { label: 'For', key: 'label' },
              { label: 'Status', html: stateLabel },
              { label: 'Ended', html: function (i) { return esc(day(i.revokedAt || i.expiresAt)); } },
              { label: 'Last used', html: function (i) { return i.lastUsedAt ? esc(day(i.lastUsedAt)) : '<span class="muted">never</span>'; } },
              { label: 'Visits', key: 'uses', num: true },
              { label: '', html: function (i) { return '<button type="button" class="btn-sm ghost" data-gu-log="' + esc(i.id) + '">Activity</button>'; } },
            ], past, { cards: 1 }) + '</div>' : '') +
          '<div data-gu-logbox></div>';

        var formEl = view.querySelector('[data-gu-form]');
        var exp = formEl.querySelector('[data-gu-exp]');
        var custom = formEl.querySelector('[data-gu-custom]');
        exp.addEventListener('change', function () { custom.hidden = exp.value !== 'custom'; });
        formEl.addEventListener('submit', function (e) {
          e.preventDefault();
          var msg = formEl.querySelector('[data-gu-msg]');
          var days = exp.value === 'custom' ? Number(formEl.days.value) : Number(exp.value);
          msg.textContent = 'Making the link…';
          ctx.send('POST', 'guest-access', { label: formEl.label.value, role: 'viewer', days: days, maskPii: formEl.mask.checked }).then(function (r) {
            if (!r || !r.ok) { msg.textContent = (r && r.error) || 'The link wasn’t made. Try again.'; return; }
            msg.textContent = '';
            showLink(view.querySelector('[data-gu-out]'), r, ctx);
            formEl.reset(); custom.hidden = true;
            refreshLists(ctx);
          }, function () { msg.textContent = 'The link wasn’t made. Check the connection and try again.'; });
        });
        wireRows(view, ctx);
      });
    });
  }

  /** The link, shown once. */
  function showLink(box, r, ctx) {
    box.innerHTML = '<div class="ga-link" role="status"><p><b>Link for ' + esc(r.invite.label) + '</b> · expires ' + esc(day(r.invite.expiresAt)) + '</p>' +
      '<div class="ga-url"><input class="input mono" readonly value="' + esc(r.url) + '" aria-label="Guest link"><button type="button" class="btn-sm" data-gu-copy>Copy link</button></div>' +
      '<p class="muted">This is the only time the link is shown. Send it to the person directly. Anyone who has it can open Funnel HQ as a guest until it expires or you revoke it.</p></div>';
    var input = box.querySelector('input');
    input.addEventListener('focus', function () { input.select(); });
    box.querySelector('[data-gu-copy]').addEventListener('click', function () {
      (navigator.clipboard ? navigator.clipboard.writeText(r.url) : Promise.reject()).then(function () { ctx.toast('Link copied'); }, function () { input.focus(); input.select(); });
    });
  }

  /** Re-draws the two lists without losing the link shown above. */
  function refreshLists(ctx) {
    var out = ctx.view.querySelector('[data-gu-out]');
    var keep = out ? out.innerHTML : '';
    var link = out && out.querySelector('input') ? out.querySelector('input').value : '';
    render(ctx).then(function () {
      var o2 = ctx.view.querySelector('[data-gu-out]');
      if (o2 && keep) {
        o2.innerHTML = keep;
        var b = o2.querySelector('[data-gu-copy]'), i = o2.querySelector('input');
        if (b) b.addEventListener('click', function () { (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { ctx.toast('Link copied'); }, function () { i.focus(); i.select(); }); });
      }
    });
  }

  function wireRows(view, ctx) {
    view.querySelectorAll('[data-gu-revoke]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Revoke the link for ' + b.getAttribute('data-gu-name') + '? They lose access on their next click.')) return;
        b.disabled = true;
        ctx.send('POST', 'guest-access/' + encodeURIComponent(b.getAttribute('data-gu-revoke')) + '/revoke', {}).then(function (r) {
          ctx.toast(r && r.ok ? 'Link revoked' : 'The link wasn’t revoked. Try again.');
          refreshLists(ctx);
        });
      });
    });
    view.querySelectorAll('[data-gu-log]').forEach(function (b) {
      b.addEventListener('click', function () {
        var box = view.querySelector('[data-gu-logbox]');
        box.innerHTML = '<div class="card"><p class="sub">Loading…</p></div>';
        ctx.api('guest-access/' + encodeURIComponent(b.getAttribute('data-gu-log')) + '/log', {}, { noRange: true }).then(function (d) {
          var rows = (d && d.log) || [];
          box.innerHTML = '<div class="card"><h2>Activity</h2><p class="sub">The last 200 requests through this link: what was opened and when. Nothing they typed is kept.</p>' +
            ctx.table([
              { label: 'When', html: function (r) { return esc(day(r.at)); } },
              { label: 'What', html: function (r) { return '<span class="mono">' + esc(r.method + ' ' + r.path) + '</span>'; } },
              { label: 'Result', html: function (r) { return r.status === 403 ? 'refused' : r.status >= 400 ? esc(String(r.status)) : 'ok'; } },
            ], rows, { empty: 'Not used yet.', feed: true }) + '</div>';
          box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    });
  }

  root.GuestAccess = { render: render, ready: ready, me: function () { return me; } };
})(window);

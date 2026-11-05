// G&L Studio → Radar → Sources and sweeps (#studio-radar-data), Radar v2 (src/radar/data-routes.ts).
// Where Radar looks and how much it reads: the platforms, the radars built from the keyword universe, the keyword
// universe itself (in the niche and adjacent, by theme), the curated subreddits and Substack publications, the
// full-sweep estimate before anything runs, live sweep progress, the spend meter and the automatic transcripts.
// studio-radar.js (the Radar view) owns the sub-tab and the empty mount; this module fills it, and mounts itself
// whenever #studio-radar-data appears. Guests see everything but no control that changes or spends anything.

const API = '/admin/api/radar/data';
const MOUNT = 'studio-radar-data';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (micros) => { const m = micros || 0; return '$' + (m / 1e6).toFixed(m >= 1e8 ? 0 : m > 0 && m < 10_000 ? 4 : 2); };
const num = (v) => (v == null ? '0' : Number(v).toLocaleString('en-US'));
const ago = (t) => { const s = (Date.now() - Date.parse(t)) / 1000; if (!isFinite(s)) return ''; if (s < 90) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; const d = Math.floor(s / 86400); return d === 1 ? 'yesterday' : d + ' days ago'; };
const guest = () => document.body?.dataset?.guest === '1';
const SWEEP_STATUS = { running: 'Searching', transcribing: 'Transcribing the best new videos', done: 'Finished' };
const KIND = { full: 'Full sweep', cron: 'Scheduled sweep', radar: 'One radar' };

let S = { el: null, state: null, est: null, busy: {}, poll: null, err: '', open: { themes: {} } };

async function api(path, init = {}) {
  const r = await fetch(API + path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) { const e = new Error(j.error || (r.status === 403 ? 'Only the owner can do that.' : `Something went wrong (${r.status}).`)); e.data = j; throw e; }
  return j;
}
const send = (path, method, body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

function toast(msg) {
  let t = document.querySelector('.rdd-toast');
  if (!t) { t = document.createElement('div'); t.className = 'rdd-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3400);
}

// ───────────── render ─────────────

const sw = (on, attrs, label) => `<button type="button" class="rdd-switch${on ? ' on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${esc(label)}" ${attrs}${guest() ? ' disabled' : ''}><i></i></button>`;

function meter(st) {
  const used = st.spend.spent_micros + st.spend.reserved_micros;
  const pct = st.spend.budget_micros ? Math.min(100, (used / st.spend.budget_micros) * 100) : 100;
  return `<div class="rdd-meter${pct >= 100 ? ' full' : ''}" aria-label="Spend this month">
    <div class="rdd-meter-top"><span>${usd(st.spend.spent_micros)}</span><em>of ${usd(st.spend.budget_micros)}</em></div>
    <div class="rdd-meter-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="rdd-meter-l">${st.spend.reserved_micros ? `${usd(st.spend.reserved_micros)} held for runs in progress` : 'Spent this month on Monid'}</div>
  </div>`;
}

function estimateView(e) {
  if (!e) return '';
  const groups = new Map();
  for (const l of e.lines) { const k = l.kind === 'radar' ? l.name : l.name; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  const rows = [...groups.entries()].map(([name, ls]) => `<li><span class="rdd-est-n">${esc(name)}</span><span class="rdd-est-p">${ls.map((l) => `${esc(l.platform ? platLabel(l.platform) : 'videos')} ${num(l.calls)}${l.pages > 1 ? ` × ${l.pages} pages` : ''}`).join(' · ')}</span><span class="rdd-est-c">${usd(ls.reduce((a, l) => a + l.est_micros, 0))}</span></li>`).join('');
  return `<div class="rdd-est" role="region" aria-label="Sweep estimate">
    <p class="rdd-est-h">This sweep makes up to <b>${num(e.runs)}</b> searches and costs up to <b>${usd(e.total_micros)}</b> at the listed prices. The month has <b>${usd(e.left_micros)}</b> left of ${usd(e.budget_micros)}.</p>
    <ul class="rdd-est-l">${rows}</ul>
    ${e.notes.length ? `<ul class="rdd-notes">${e.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <p class="rdd-fine">An extra page is only read when the page before it found something, so the real cost is usually lower. Each run is checked against the budget again before it starts.</p>
    <div class="rdd-actions">${e.fits ? `<button type="button" class="rdd-btn rdd-primary" data-go${S.busy.go ? ' disabled' : ''}>${S.busy.go ? 'Starting' : 'Run the sweep'}</button>` : '<span class="rdd-bad">Over the monthly budget. Raise it in Integrations or switch some radars off.</span>'}<button type="button" class="rdd-btn" data-cancel>Not now</button></div>
  </div>`;
}

function sweepView(s) {
  if (!s) return '<p class="rdd-empty">No sweep yet. Full sweep runs every radar, subreddit and publication that is switched on.</p>';
  const done = s.completed + s.failed + s.skipped;
  const pct = s.runs ? Math.round((done / s.runs) * 100) : 0;
  const live = s.status !== 'done';
  return `<div class="rdd-sweep${live ? ' live' : ''}">
    <div class="rdd-sweep-top"><span class="rdd-sweep-k">${esc(KIND[s.kind] || s.kind)} · ${esc(ago(s.started_at))}</span><span class="rdd-sweep-s">${live ? '<i></i>' : ''}${esc(SWEEP_STATUS[s.status] || s.status)}</span></div>
    <div class="rdd-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
    <dl class="rdd-stats">
      <div><dt>Searches</dt><dd>${num(done)} of ${num(s.runs)}${s.extra_pages ? ` <em>${num(s.extra_pages)} extra pages</em>` : ''}</dd></div>
      <div><dt>New items</dt><dd>${num(s.new_items)}</dd></div>
      <div><dt>Spent</dt><dd>${usd(s.cost_micros)} <em>of up to ${usd(s.est_micros)}</em></dd></div>
      <div><dt>Transcripts</dt><dd>${s.transcripts_queued || s.transcripts ? `${num(s.transcribed)} of ${num(s.transcripts || s.transcripts_queued)}` : s.status === 'done' ? 'none needed' : 'after the searches'}</dd></div>
    </dl>
    ${s.failed ? `<details class="rdd-errs"><summary>${num(s.failed)} did not finish</summary><ul>${(s.errors || []).map((x) => `<li><b>${esc(x.slot)}</b> ${esc(x.error)}${x.n > 1 ? ` (${x.n})` : ''}</li>`).join('')}</ul></details>` : ''}
  </div>`;
}

const PLAT_LABEL = {};
const platLabel = (p) => PLAT_LABEL[p] || p;

function platformsView(st) {
  return `<ul class="rdd-plats">${st.platforms.map((p) => `<li class="${p.on ? '' : 'off'}">
      <div><b>${esc(p.label)}</b><span>${num(p.items)} items${p.source ? '' : ' · no source'}${p.source && !p.confirmed ? ' · not confirmed' : ''}</span></div>
      ${p.switchable ? sw(p.on, `data-plat="${esc(p.platform)}"`, `${p.label} on or off`) : '<span class="rdd-tag">Off in Integrations</span>'}
    </li>`).join('')}</ul>`;
}

function radarsView(st) {
  const kwPlats = st.platforms.filter((p) => p.platform !== 'substack');
  return `<ul class="rdd-radars">${st.radars.map((r) => `<li class="${r.enabled ? '' : 'off'}">
      <div class="rdd-radar-h">
        <div><b>${esc(r.name)}</b><span>${r.niche === 'out' ? 'Adjacent' : 'In the niche'} · ${num(r.keywords.length)} keywords${r.since_days ? ` · last ${r.since_days} days` : ''}${r.last_run_at ? ` · ran ${esc(ago(r.last_run_at))}` : ''}</span></div>
        ${sw(r.enabled, `data-radar-on="${esc(r.id)}"`, `${r.name} on or off`)}
      </div>
      <div class="rdd-chips" role="group" aria-label="Platforms for ${esc(r.name)}">${kwPlats.map((p) => `<button type="button" class="rdd-chip${r.platforms.includes(p.platform) ? ' on' : ''}" aria-pressed="${r.platforms.includes(p.platform)}" data-radar-plat="${esc(r.id)}" data-p="${esc(p.platform)}"${guest() ? ' disabled' : ''}>${esc(p.label)}</button>`).join('')}</div>
      <div class="rdd-fields">
        ${r.platforms.includes('x') ? `<label>X likes at least<input type="number" min="0" step="50" inputmode="numeric" value="${r.min_faves ?? ''}" placeholder="${r.niche === 'out' ? 1000 : 200}" data-radar-field="min_faves" data-id="${esc(r.id)}"${guest() ? ' disabled' : ''}></label>` : ''}
        <label>Pages per search<input type="number" min="1" max="10" inputmode="numeric" value="${r.pages ?? ''}" placeholder="${st.config.pages}" data-radar-field="pages" data-id="${esc(r.id)}"${guest() ? ' disabled' : ''}></label>
        <label>Window in days<input type="number" min="1" max="3650" inputmode="numeric" value="${r.since_days ?? ''}" placeholder="any" data-radar-field="since_days" data-id="${esc(r.id)}"${guest() ? ' disabled' : ''}></label>
      </div>
    </li>`).join('')}</ul>`;
}

function themesView(st) {
  const g = guest();
  const blocks = st.themes.map((t) => {
    const on = t.keywords.filter((k) => k.enabled).length;
    const open = S.open.themes[t.id];
    return `<section class="rdd-theme">
      <button type="button" class="rdd-theme-h" data-theme-open="${esc(t.id)}" aria-expanded="${open ? 'true' : 'false'}"><b>${esc(t.name)}</b><span>${t.tier === 'in' ? 'In the niche' : 'Adjacent'} · ${on} of ${t.keywords.length} on</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg></button>
      ${open ? `<div class="rdd-theme-b">
        <ul class="rdd-kws">${t.keywords.map((k) => `<li class="${k.enabled ? '' : 'off'}"><button type="button" class="rdd-kw" data-kw-toggle="${esc(k.id)}" data-on="${k.enabled ? 1 : 0}" aria-pressed="${k.enabled}" title="${k.enabled ? 'Switch off' : 'Switch on'}"${g ? ' disabled' : ''}>${esc(k.keyword)}</button>${g ? '' : `<button type="button" class="rdd-x" data-kw-del="${esc(k.id)}" aria-label="Remove ${esc(k.keyword)}">×</button>`}</li>`).join('')}</ul>
        ${g ? '' : `<form class="rdd-add" data-kw-add="${esc(t.id)}" data-tier="${esc(t.tier)}"><label class="rdd-sr" for="kw-${esc(t.id)}">Add keywords to ${esc(t.name)}</label><input id="kw-${esc(t.id)}" name="keywords" placeholder="Add keywords, comma separated" autocomplete="off"><button type="submit" class="rdd-btn">Add</button></form>`}
      </div>` : ''}
    </section>`;
  }).join('');
  const add = g ? '' : `<form class="rdd-add rdd-new-theme" data-theme-new>
      <label class="rdd-sr" for="nt-name">New theme name</label><input id="nt-name" name="name" placeholder="New theme, like Home services" autocomplete="off" required>
      <label class="rdd-sr" for="nt-tier">Tier</label><select id="nt-tier" name="tier"><option value="adjacent">Adjacent</option><option value="in">In the niche</option></select>
      <label class="rdd-sr" for="nt-kws">Keywords</label><input id="nt-kws" name="keywords" placeholder="Its keywords, comma separated" autocomplete="off" required>
      <button type="submit" class="rdd-btn">Add theme</button></form>`;
  return blocks + add;
}

function subredditsView(st) {
  const g = guest();
  return `<ul class="rdd-list">${st.subreddits.map((s) => `<li class="${s.enabled ? '' : 'off'}">
      <div><a href="https://www.reddit.com/r/${encodeURIComponent(s.name)}/top/?t=month" target="_blank" rel="noopener">r/${esc(s.name)}</a><span>${s.niche === 'in' ? 'In the niche' : 'Adjacent'}${s.last_run_at ? ` · read ${esc(ago(s.last_run_at))}` : ''}${s.disabled_reason ? ` · ${esc(s.disabled_reason)}` : ''}</span></div>
      <span class="rdd-row-a">${sw(Boolean(s.enabled), `data-sub-on="${esc(s.name)}"`, `r/${s.name} on or off`)}${g ? '' : `<button type="button" class="rdd-x" data-sub-del="${esc(s.name)}" aria-label="Remove r/${esc(s.name)}">×</button>`}</span>
    </li>`).join('')}</ul>
    ${g ? '' : `<form class="rdd-add" data-sub-add><label class="rdd-sr" for="sub-new">Add a subreddit</label><input id="sub-new" name="name" placeholder="r/subreddit" autocomplete="off" required><select name="niche" aria-label="Tier"><option value="in">In the niche</option><option value="out">Adjacent</option></select><button type="submit" class="rdd-btn">Add</button></form>`}`;
}

function publicationsView(st) {
  const g = guest();
  return `<ul class="rdd-list">${st.publications.map((p) => `<li class="${p.enabled ? '' : 'off'}">
      <div><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a><span>${esc(p.id)} · ${p.niche === 'in' ? 'In the niche' : 'Adjacent'} · ${p.verified ? 'Checked' : 'Not yet checked'}${p.median_interactions != null ? ` · typical post ${num(Math.round(p.median_interactions))} interactions` : ''}${p.disabled_reason ? ` · switched off: ${esc(p.disabled_reason)}` : ''}</span></div>
      <span class="rdd-row-a">${sw(Boolean(p.enabled), `data-pub-on="${esc(p.id)}"`, `${p.name} on or off`)}${g ? '' : `<button type="button" class="rdd-x" data-pub-del="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">×</button>`}</span>
    </li>`).join('')}</ul>
    ${g ? '' : `<form class="rdd-add" data-pub-add><label class="rdd-sr" for="pub-new">Add a publication</label><input id="pub-new" name="url" placeholder="name.substack.com or its own domain" autocomplete="off" required><input name="name" placeholder="Name" aria-label="Name" autocomplete="off"><select name="niche" aria-label="Tier"><option value="out">Adjacent</option><option value="in">In the niche</option></select><button type="submit" class="rdd-btn">Add</button></form>`}`;
}

function render() {
  const el = S.el;
  if (!el) return;
  const st = S.state;
  if (!st) { el.innerHTML = `<p class="rdd-empty">${esc(S.err || 'Loading sources')}</p>`; return; }
  for (const p of st.platforms) PLAT_LABEL[p.platform] = p.label;
  const latest = st.sweeps[0];
  const live = latest && latest.status !== 'done';
  el.innerHTML = `<div class="rdd">
    <header class="rdd-head">
      <div><p class="rdd-eyebrow">Sources and sweeps</p><h2 class="rdd-h">Where Radar looks</h2>
        <p class="rdd-lede">${num(st.radars.filter((r) => r.enabled).length)} radars, ${num(st.themes.reduce((a, t) => a + t.keywords.filter((k) => k.enabled).length, 0))} keywords, ${num(st.subreddits.filter((s) => s.enabled).length)} subreddits and ${num(st.publications.filter((p) => p.enabled).length)} publications. ${st.config.pages} ${st.config.pages === 1 ? 'page' : 'pages'} per search${st.config.schedule_hours ? `, every ${st.config.schedule_hours} hours` : ', only when you run it'}.</p></div>
      <div class="rdd-head-r">${meter(st)}${guest() ? '' : `<button type="button" class="rdd-btn rdd-primary" data-estimate${!st.key || live || S.busy.est ? ' disabled' : ''}>${live ? 'Sweep running' : S.busy.est ? 'Adding it up' : 'Full sweep'}</button>`}</div>
    </header>
    ${!st.key ? `<p class="rdd-warn">${esc(st.copy.noKey)}</p>` : ''}
    ${S.est ? estimateView(S.est) : ''}
    <section class="rdd-sec" aria-labelledby="rdd-sw"><h3 id="rdd-sw">Latest sweep</h3>${sweepView(latest)}
      <p class="rdd-fine">Automatic transcripts: ${st.config.auto_transcribe ? `the best ${st.config.auto_transcribe} new videos by score after each sweep, taking turns across YouTube, TikTok and Instagram, within the budget` : 'off (RADAR_AUTO_TRANSCRIBE is 0)'}. Text posts keep their full text instead.</p>
      ${st.sweeps.length > 1 ? `<ul class="rdd-past">${st.sweeps.slice(1).map((s) => `<li><span>${esc(KIND[s.kind] || s.kind)} · ${esc(ago(s.started_at))}</span><span>${num(s.new_items)} new · ${usd(s.cost_micros)}</span></li>`).join('')}</ul>` : ''}
    </section>
    <section class="rdd-sec" aria-labelledby="rdd-pl"><h3 id="rdd-pl">Platforms</h3>${platformsView(st)}</section>
    <section class="rdd-sec" aria-labelledby="rdd-ra"><h3 id="rdd-ra">Radars</h3><p class="rdd-fine">Each radar searches every keyword of its theme on the platforms picked here. X asks only for posts above the like floor, so top performers come back first.</p>${radarsView(st)}</section>
    <section class="rdd-sec" aria-labelledby="rdd-kw"><h3 id="rdd-kw">Keyword universe</h3><p class="rdd-fine">Tap a keyword to switch it off or on. A new theme gets its own radar.</p>${themesView(st)}</section>
    <div class="rdd-two">
      <section class="rdd-sec" aria-labelledby="rdd-sr"><h3 id="rdd-sr">Subreddits</h3><p class="rdd-fine">The month's top posts of each, every sweep.</p>${subredditsView(st)}</section>
      <section class="rdd-sec" aria-labelledby="rdd-pb"><h3 id="rdd-pb">Substack publications</h3><p class="rdd-fine">Substack has no search, so Radar reads these and ranks each post against its own publication. One that fails to load is switched off with the reason.</p>${publicationsView(st)}</section>
    </div>
  </div>`;
}

// ───────────── data and actions ─────────────

async function load() {
  try { S.state = await api('/state'); S.err = ''; } catch (e) { S.err = e.message; }
  render();
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(S.poll);
  const latest = S.state?.sweeps?.[0];
  if (!latest || latest.status === 'done' || !S.el?.isConnected) return;
  S.poll = setTimeout(async () => {
    if (!S.el?.isConnected || S.el.closest('[hidden]')) { schedulePoll(); return; }
    try {
      // The owner's page moves the queue on (the cron does the same every 5 minutes); a guest only reads.
      const r = guest() ? await api('/sweeps?limit=5') : await send('/step', 'POST');
      S.state.sweeps = r.sweeps.length >= S.state.sweeps.length ? r.sweeps : [...r.sweeps, ...S.state.sweeps.slice(r.sweeps.length)];
      if (S.state.sweeps[0]?.status === 'done') { await load(); return; }
      render();
    } catch { /* the next check tries again */ }
    schedulePoll();
  }, 4000);
}

async function act(key, fn, ok) {
  if (S.busy[key]) return;
  S.busy[key] = true; render();
  try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast(e.message); } finally { S.busy[key] = false; render(); }
}

function onClick(e) {
  const t = e.target.closest('button');
  if (!t || !S.el.contains(t) || t.disabled) return;
  const d = t.dataset;
  if ('estimate' in d) {
    S.busy.est = true; render();
    api('/estimate').then((x) => { S.est = x; }).catch((x) => toast(x.message)).finally(() => { S.busy.est = false; render(); S.el.querySelector('.rdd-est')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  } else if ('cancel' in d) { S.est = null; render(); }
  else if ('go' in d) act('go', async () => { const r = await send('/sweep', 'POST', {}); S.est = null; toast(r.message || 'The sweep has started.'); });
  else if (d.plat) act('plat' + d.plat, () => send('/platforms', 'POST', { platform: d.plat, on: t.getAttribute('aria-checked') !== 'true' }));
  else if (d.radarOn) act('ro' + d.radarOn, () => send(`/radars/${encodeURIComponent(d.radarOn)}`, 'PATCH', { enabled: t.getAttribute('aria-checked') !== 'true' }));
  else if (d.radarPlat) {
    const r = S.state.radars.find((x) => x.id === d.radarPlat);
    const ps = r.platforms.includes(d.p) ? r.platforms.filter((x) => x !== d.p) : [...r.platforms, d.p];
    act('rp' + d.radarPlat, () => send(`/radars/${encodeURIComponent(d.radarPlat)}`, 'PATCH', { platforms: ps }));
  } else if (d.themeOpen) { S.open.themes[d.themeOpen] = !S.open.themes[d.themeOpen]; render(); }
  else if (d.kwToggle) act('kw' + d.kwToggle, () => send(`/keywords/${encodeURIComponent(d.kwToggle)}`, 'PUT', { enabled: d.on !== '1' }));
  else if (d.kwDel) act('kwd' + d.kwDel, () => send(`/keywords/${encodeURIComponent(d.kwDel)}`, 'DELETE'), 'Keyword removed.');
  else if (d.subOn) act('so' + d.subOn, () => send(`/subreddits/${encodeURIComponent(d.subOn)}`, 'PUT', { enabled: t.getAttribute('aria-checked') !== 'true' }));
  else if (d.subDel) act('sd' + d.subDel, () => send(`/subreddits/${encodeURIComponent(d.subDel)}`, 'DELETE'), 'Subreddit removed.');
  else if (d.pubOn) act('po' + d.pubOn, () => send(`/publications/${encodeURIComponent(d.pubOn)}`, 'PUT', { enabled: t.getAttribute('aria-checked') !== 'true' }));
  else if (d.pubDel) act('pd' + d.pubDel, () => send(`/publications/${encodeURIComponent(d.pubDel)}`, 'DELETE'), 'Publication removed.');
}

function onSubmit(e) {
  const f = e.target;
  if (!(f instanceof HTMLFormElement) || !S.el.contains(f)) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f));
  if (f.dataset.kwAdd) act('kwa', () => send('/keywords', 'POST', { theme: f.dataset.kwAdd, tier: f.dataset.tier, keywords: String(v.keywords || '') }), 'Added.');
  else if ('themeNew' in f.dataset) {
    const id = String(v.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    act('nt', async () => { await send('/keywords', 'POST', { theme: id, theme_name: v.name, tier: v.tier, keywords: String(v.keywords || '') }); S.open.themes[id] = true; }, 'Theme added, with its own radar.');
  } else if ('subAdd' in f.dataset) act('sa', () => send('/subreddits', 'POST', { name: v.name, niche: v.niche }), 'Subreddit added.');
  else if ('pubAdd' in f.dataset) act('pa', () => send('/publications', 'POST', { url: v.url, name: v.name, niche: v.niche }), 'Publication added. It is checked on the next sweep.');
}

function onChange(e) {
  const i = e.target;
  if (!(i instanceof HTMLInputElement) || !i.dataset.radarField || !S.el.contains(i)) return;
  act('rf' + i.dataset.id, () => send(`/radars/${encodeURIComponent(i.dataset.id)}`, 'PATCH', { [i.dataset.radarField]: i.value === '' ? null : Number(i.value) }), 'Saved.');
}

/** Fill a mount (called by studio-radar.js, or found by the observer below). Safe to call twice. */
export function mount(el) {
  if (!el || el.dataset.rddMounted === '1') return;
  el.dataset.rddMounted = '1';
  S.el = el;
  el.addEventListener('click', onClick);
  el.addEventListener('submit', onSubmit);
  el.addEventListener('change', onChange);
  if (!document.querySelector('link[data-rdd]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/assets/studio-radar-data.css'; l.dataset.rdd = '1';
    document.head.appendChild(l);
  }
  render();
  load();
}

function find() { const el = document.getElementById(MOUNT); if (el) mount(el); }
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', find); else find();
  // The Radar view renders its sub-tabs after load: mount as soon as the section appears (or is re-rendered).
  new MutationObserver(() => { const el = document.getElementById(MOUNT); if (el && el.dataset.rddMounted !== '1') { S.el = null; mount(el); } }).observe(document.documentElement, { childList: true, subtree: true });
}

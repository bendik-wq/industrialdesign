// G&L Studio → Radar (#studio-radar): the top performing videos and Meta ads, in and outside the niche, pulled
// through Monid (src/radar), scored for outlier-ness, transcribed and analysed for G&L, with "Make it a script".
// Four tabs: Videos, Meta ads, What's hot (the weekly digest) and Sources (the source map, the exact input before
// the first paid run, and recent runs). Guests see everything but no button that changes or spends anything.

const API = '/admin/api/radar';
const root = document.getElementById('studio-radar');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const PLAT = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', meta_ads: 'Meta ads' };
const HOOK_LABEL = { question: 'Question', contrarian: 'Contrarian', result: 'Result first', story: 'Story', curiosity: 'Curiosity gap', pattern_interrupt: 'Pattern interrupt', list: 'List', authority: 'Authority', problem: 'Problem', other: 'Other' };
const LAYOUT_LABEL = { orbit: 'Orbit', split: 'Split', spotlight: 'Spotlight', stage: 'Stage', vertical: 'Vertical', cinema: 'Cinema' };
const BRAIN = { claude: 'Claude', 'workers-ai': 'Workers AI' };
const GLYPH = {
  youtube: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="4.5" width="16" height="11" rx="3.2"/><path d="m8.4 7.6 4.2 2.4-4.2 2.4z" class="f"/></svg>',
  tiktok: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11.5 3v9.2a2.9 2.9 0 1 1-2.9-2.9"/><path d="M11.5 3c.4 2 1.8 3.4 4 3.6"/></svg>',
  instagram: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="4"/><circle cx="10" cy="10" r="3.2"/><circle cx="14.2" cy="5.8" r=".7" class="f"/></svg>',
  meta_ads: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 12.5c0-4 2-7 3.8-7 2.6 0 4.6 9 7.2 9 1.4 0 2-1.4 2-3 0-3-1.6-6-3.4-6-2.4 0-4.2 7-6.8 7C4 12.5 3 12.5 3 12.5z"/></svg>',
};
const n = (v) => { if (v == null || !isFinite(v)) return '·'; const a = Math.abs(v); if (a >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'; if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; if (a >= 1e4) return Math.round(v / 1e3) + 'K'; if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'; return String(Math.round(v)); };
const usd = (micros) => '$' + ((micros || 0) / 1e6).toFixed((micros || 0) >= 1e8 ? 0 : 2);
const pct = (x) => (x == null ? '·' : (x * 100).toFixed(x >= 0.1 ? 0 : 1) + '%');
const ago = (t) => { const s = (Date.now() - Date.parse(t)) / 1000; if (!isFinite(s)) return ''; if (s < 3600) return 'just now'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; const d = Math.floor(s / 86400); if (d < 45) return d === 1 ? 'yesterday' : d + ' days ago'; const m = Math.round(d / 30.4); return m < 12 ? m + ' months ago' : Math.round(d / 365) + ' years ago'; };
const dur = (s) => (!s ? '' : s < 60 ? Math.round(s) + ' s' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0'));
const priceText = (p) => { if (!p) return 'Price not listed'; const amt = /micro/i.test(p.currency || '') ? p.amount / 1e6 : p.amount; const per = p.type === 'PER_RESULT' ? 'per result' : 'per run'; const fee = p.flatFee ? ` + $${(/micro/i.test(p.currency || '') ? p.flatFee / 1e6 : p.flatFee).toFixed(2)} a run` : ''; return `$${amt < 0.01 ? amt.toFixed(4) : amt.toFixed(amt < 1 ? 3 : 2)} ${per}${fee}`; };

let S = { tab: 'videos', state: null, items: [], guest: false, filters: { niche: 'all', platform: 'all', sort: 'score', radar: '' }, adSort: 'longevity', open: null, busy: {}, sources: null, preview: {}, runs: null, digest: null, edit: null, poll: null, loaded: false };
try { const t = localStorage.getItem('radar:tab'); if (t) S.tab = t; } catch { /* private mode */ }

async function api(path, init = {}) {
  const r = await fetch(API + path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || (r.status === 403 ? 'Only the owner can do that.' : `Something went wrong (${r.status}).`));
  return j;
}
function toast(msg) {
  let t = document.querySelector('.rd-toast');
  if (!t) { t = document.createElement('div'); t.className = 'rd-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3200);
}

// ───────────── data ─────────────
async function loadState() { S.state = await api('/state'); }
async function loadItems() {
  const ads = S.tab === 'ads';
  const q = new URLSearchParams({ platform: ads ? 'meta_ads' : S.filters.platform === 'all' ? 'videos' : S.filters.platform, sort: ads ? S.adSort : S.filters.sort });
  if (S.filters.niche !== 'all') q.set('niche', S.filters.niche);
  if (S.filters.radar) q.set('radar', S.filters.radar);
  S.items = (await api('/items?' + q)).items || [];
}
async function refresh() {
  try {
    await loadState();
    if (S.tab === 'videos' || S.tab === 'ads') await loadItems();
    if (S.tab === 'hot') S.digest = await api('/digest');
    if (S.tab === 'sources') { S.sources = await api('/sources'); S.runs = (await api('/runs')).runs; }
  } catch (e) { toast(e.message); }
  S.loaded = true;
  render();
  schedulePoll();
}
function schedulePoll() {
  clearTimeout(S.poll);
  if (!S.state || !S.state.active_runs) return;
  S.poll = setTimeout(async () => {
    if (document.hidden || root.hidden) return schedulePoll();
    if (!S.guest && S.state.key) { try { await api('/step', { method: 'POST' }); } catch { /* the cron carries on */ } }
    const before = S.state.active_runs;
    await loadState().catch(() => null);
    if (S.state.active_runs !== before && (S.tab === 'videos' || S.tab === 'ads')) await loadItems().catch(() => null);
    if (S.tab === 'sources') S.runs = (await api('/runs').catch(() => ({ runs: S.runs }))).runs;
    if (!S.open) render();
    schedulePoll();
  }, 15000);
}

// ───────────── pieces ─────────────
function meter() {
  const sp = S.state?.spend; if (!sp) return '';
  const used = sp.spent_micros + sp.reserved_micros;
  const frac = sp.budget_micros ? Math.min(1, used / sp.budget_micros) : 1;
  const full = used >= sp.budget_micros;
  return `<div class="rd-meter${full ? ' full' : ''}" title="Billed by Monid this month, plus the estimate of runs still going"><div class="rd-meter-top"><span>${usd(used)} <em>of ${usd(sp.budget_micros)}</em></span><span class="rd-meter-l">${full ? 'Budget reached' : 'this month'}</span></div><div class="rd-meter-bar"><i style="width:${(frac * 100).toFixed(1)}%"></i></div></div>`;
}
function tabs() {
  const t = [['videos', 'Videos'], ['ads', 'Meta ads'], ['hot', 'What’s hot'], ['sources', 'Sources']];
  return `<nav class="rd-tabs" role="tablist" aria-label="Radar">${t.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}</button>`).join('')}</nav>`;
}
function head() {
  const st = S.state;
  const runs = st?.active_runs ? `<span class="rd-live"><i></i>${st.active_runs} run${st.active_runs === 1 ? '' : 's'} going</span>` : '';
  return `<header class="rd-head"><div><p class="rd-eyebrow">Radar</p><h1 class="rd-h1">What’s working, and how we’d use it</h1></div><div class="rd-head-r">${runs}${meter()}</div></header>${tabs()}`;
}
function noKeyLine() {
  if (!S.state || S.state.key) return '';
  return `<p class="rd-line">${esc(S.state.copy.noKey)} <a href="/admin#integrations">Open Integrations</a></p>`;
}
const seg = (name, val, opts) => `<div class="rd-seg" role="group" aria-label="${esc(name)}">${opts.map(([v, l, dis]) => `<button type="button" data-f="${name}" data-v="${v}" aria-pressed="${val === v}"${dis ? ' disabled title="Off"' : ''}>${l}</button>`).join('')}</div>`;

function rail() {
  const st = S.state || { watchlists: [] };
  const ads = S.tab === 'ads';
  const lists = st.watchlists.filter((w) => (ads ? w.platforms.includes('meta_ads') : w.platforms.some((p) => p !== 'meta_ads')));
  const radarRows = lists.map((w) => `<li class="rd-radar${S.filters.radar === w.id ? ' on' : ''}">
      <button type="button" class="rd-radar-main" data-radar="${esc(w.id)}" aria-pressed="${S.filters.radar === w.id}"><span class="rd-radar-name">${esc(w.name)}</span>
      <span class="rd-radar-sub"><span class="rd-chip ${w.niche === 'in' ? 'in' : 'out'}">${w.niche === 'in' ? 'Our niche' : 'Outside'}</span>${w.platforms.map((p) => `<span class="rd-g" title="${PLAT[p]}">${GLYPH[p]}</span>`).join('')}<span>${w.keywords.length} keywords</span></span>
      <span class="rd-radar-sub">${w.enabled ? (w.last_run_at ? 'Ran ' + esc(ago(w.last_run_at)) : 'Not run yet') : 'Paused'}</span></button>
      ${S.guest ? '' : `<span class="rd-radar-act"><button type="button" class="rd-btn rd-btn-sm" data-run="${esc(w.id)}"${!st.key || S.busy['run' + w.id] ? ' disabled' : ''}>${S.busy['run' + w.id] ? 'Starting' : 'Run'}</button><button type="button" class="rd-icon" data-edit="${esc(w.id)}" aria-label="Edit ${esc(w.name)}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 13.5-.5 3 3-.5 8.6-8.6-2.5-2.5z"/></svg></button></span>`}</li>`).join('');
  const filters = ads
    ? `<p class="rd-lbl">Sort</p>${seg('adsort', S.adSort, [['longevity', 'Days active'], ['variants', 'Variants'], ['score', 'Score']])}`
    : `<p class="rd-lbl">Niche</p>${seg('niche', S.filters.niche, [['all', 'All'], ['in', 'Ours'], ['out', 'Outside']])}
       <p class="rd-lbl">Platform</p>${seg('platform', S.filters.platform, [['all', 'All'], ['youtube', 'YouTube'], ['tiktok', 'TikTok'], ...(st.config?.instagram ? [['instagram', 'Instagram']] : [])])}
       <p class="rd-lbl">Sort</p><label class="rd-select"><span class="sr">Sort by</span><select data-sort>${[['score', 'Outlier score'], ['views', 'Views'], ['engagement', 'Engagement'], ['velocity', 'Views per day'], ['recent', 'Newest']].map(([v, l]) => `<option value="${v}"${S.filters.sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const open = !matchMedia('(max-width: 720px)').matches || S.railOpen;
  const active = [S.filters.niche !== 'all' ? (S.filters.niche === 'in' ? 'our niche' : 'outside') : '', S.filters.platform !== 'all' ? PLAT[S.filters.platform] : '', S.filters.radar ? 'one radar' : ''].filter(Boolean).join(', ');
  return `<aside class="rd-rail" aria-label="Radars and filters"><details class="rd-raild" data-rail${open ? ' open' : ''}><summary>Radars and filters${active ? `<span>${esc(active)}</span>` : ''}</summary>
    <div class="rd-rail-h"><h2>Radars</h2>${S.guest ? '' : '<button type="button" class="rd-link" data-new>New radar</button>'}</div>
    <ul class="rd-radars">${S.filters.radar ? '<li><button type="button" class="rd-link rd-all" data-radar="">Show every radar</button></li>' : ''}${radarRows || '<li class="rd-muted">No radar here yet.</li>'}</ul>
    <div class="rd-filters">${filters}</div>
    ${ads ? `<p class="rd-fine">${esc(S.state?.copy?.adSpend || '')}</p>` : ''}
  </details></aside>`;
}

function badge(it) {
  const p = it.score_parts || {};
  if (it.platform === 'meta_ads') return `<span class="rd-badge">${n(it.ad_active_days)} days</span>`;
  if (p.ratio != null && p.ratio >= 2) return `<span class="rd-badge hot" title="${p.ratio_basis === 'followers' ? 'Views against followers' : p.ratio_basis === 'author' ? 'Views against this creator’s typical views' : 'Views against the typical views Radar has found here'}">${p.ratio >= 10 ? Math.round(p.ratio) : p.ratio.toFixed(1)}x</span>`;
  return `<span class="rd-badge">${Math.round(it.score)}</span>`;
}
function card(it) {
  const ad = it.platform === 'meta_ads';
  const thumb = it.thumbnail_url || (ad && it.media_kind === 'image' ? it.media_url : '');
  const stats = ad
    ? `<span>${n(it.ad_variants)} variant${it.ad_variants === 1 ? '' : 's'}</span>${it.ad_cta ? `<span>${esc(it.ad_cta)}</span>` : ''}${it.ad_active === 0 ? '<span>Stopped</span>' : '<span>Running</span>'}`
    : `<span>${n(it.views)} views</span><span>${pct(it.score_parts?.engagement)} eng.</span>${it.score_parts?.velocity ? `<span>${n(it.score_parts.velocity)}/day</span>` : ''}`;
  return `<li><button type="button" class="rd-card${ad ? ' ad' : ''}" data-open="${esc(it.id)}">
    <span class="rd-thumb">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="rd-thumb-empty"></span>'}
      <span class="rd-plat" title="${PLAT[it.platform]}">${GLYPH[it.platform]}</span>${badge(it)}${it.duration_s && !ad ? `<span class="rd-dur">${dur(it.duration_s)}</span>` : ''}</span>
    <span class="rd-card-b"><span class="rd-card-t">${esc(it.title || it.caption || 'Untitled')}</span>
      <span class="rd-card-a">${esc(it.author || '')}${it.published_at && !ad ? ' · ' + esc(ago(it.published_at)) : ''}</span>
      <span class="rd-stats">${stats}</span>
      ${it.hook ? `<span class="rd-card-hook"><b>For G&amp;L</b> ${esc(it.hook)}</span>` : ''}</span>
  </button></li>`;
}
function grid() {
  if (!S.items.length) {
    const st = S.state;
    const msg = !st?.key ? 'Nothing here yet. Once the Monid key is in, run a radar to fill this.'
      : !st.slots.some((s) => s.selected?.confirmed) ? 'Nothing here yet. Pick and confirm a source in Sources, then run a radar.'
      : 'Nothing matches these filters yet. Run a radar, or widen the filters.';
    return `<div class="rd-empty"><p>${msg}</p></div>`;
  }
  return `<ul class="rd-grid${S.tab === 'ads' ? ' ads' : ''}">${S.items.map(card).join('')}</ul>`;
}

// ───────────── the detail sheet ─────────────
function player(it) {
  if (it.platform === 'youtube' && it.embed_url) return `<div class="rd-player wide"><iframe src="${esc(it.embed_url)}" title="${esc(it.title || 'YouTube video')}" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
  if (it.platform === 'tiktok' && it.embed_url) return `<div class="rd-player tall"><iframe src="${esc(it.embed_url)}" title="${esc(it.title || 'TikTok video')}" allow="encrypted-media; fullscreen" allowfullscreen loading="lazy"></iframe></div>`;
  if (it.platform === 'meta_ads' && it.media_url) {
    return it.media_kind === 'video'
      ? `<div class="rd-player ad"><video src="${esc(it.media_url)}" controls playsinline preload="metadata"${it.thumbnail_url ? ` poster="${esc(it.thumbnail_url)}"` : ''}></video></div>`
      : `<div class="rd-player ad"><img src="${esc(it.media_url)}" alt="The ad creative" referrerpolicy="no-referrer"></div>`;
  }
  return `<div class="rd-player wide still">${it.thumbnail_url ? `<img src="${esc(it.thumbnail_url)}" alt="" referrerpolicy="no-referrer">` : ''}</div>`;
}
function metrics(it) {
  const p = it.score_parts || {};
  const cells = it.platform === 'meta_ads'
    ? [['Days active', n(it.ad_active_days)], ['Variants', n(it.ad_variants)], ['Status', it.ad_active === 0 ? 'Stopped' : 'Running'], ['Page likes', n(it.followers)], ['Button', it.ad_cta || '·']]
    : [['Views', n(it.views)], ['Outlier', p.ratio != null ? `${p.ratio >= 10 ? Math.round(p.ratio) : p.ratio.toFixed(1)}x` : '·'], ['Engagement', pct(p.engagement)], ['Per day', n(p.velocity)], ['Likes', n(it.likes)], ['Comments', n(it.comments)], ['Followers', n(it.followers)]];
  return `<dl class="rd-metrics${it.platform === 'meta_ads' ? ' ad' : ''}">${cells.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}<div><dt>Score</dt><dd>${Math.round(it.score)}</dd></div></dl>`;
}
function transcriptBlock(it) {
  if (it.platform === 'meta_ads') return it.caption ? `<section class="rd-sec"><h3>Ad copy</h3><p class="rd-copy">${esc(it.caption)}</p>${it.ad_link ? `<p class="rd-fine">Links to <a href="${esc(it.ad_link)}" target="_blank" rel="noopener noreferrer">${esc(it.ad_link.replace(/^https:\/\//, '').slice(0, 60))}</a></p>` : ''}</section>` : '';
  const src = { monid: 'Transcript from Monid', captions: 'From the platform captions', pending: 'Fetching the transcript', missing: 'No transcript yet' }[it.transcript_source] || 'No transcript yet';
  const canGet = !S.guest && S.state?.key && (it.platform === 'youtube' || it.platform === 'tiktok') && it.transcript_source !== 'pending' && it.transcript_source !== 'monid';
  const body = it.transcript
    ? `<div class="rd-transcript">${esc(it.transcript).split('\n').map((l) => `<p>${l.replace(/^\[(\d+:\d\d)\]/, '<time>$1</time>')}</p>`).join('')}</div>`
    : `<p class="rd-muted">${it.caption ? 'Caption: ' + esc(it.caption.slice(0, 600)) : 'Nothing to read yet.'}</p>`;
  return `<section class="rd-sec"><div class="rd-sec-h"><h3>Transcript</h3><span class="rd-fine">${src}</span>${canGet ? `<button type="button" class="rd-btn rd-btn-sm" data-transcript${S.busy.tr ? ' disabled' : ''}>${it.transcript ? 'Fetch the full transcript' : 'Get transcript'}</button>` : ''}</div>${body}</section>`;
}
function analysisBlock(it) {
  const a = it.analysis;
  const brain = S.state?.brain;
  const busy = S.busy.an;
  if (!a) {
    return `<div class="rd-an-empty"><p>${busy ? 'Reading it now. This takes about a minute.' : 'Not analysed yet.'}</p>${S.guest ? '' : brain ? `<button type="button" class="rd-btn rd-btn-primary" data-analyse${busy ? ' disabled' : ''}>${busy ? 'Analysing' : 'Analyse'}</button><p class="rd-fine">With ${BRAIN[brain]}</p>` : '<p class="rd-fine">Add the Anthropic key in Integrations to analyse.</p>'}</div>`;
  }
  const g = a.for_gl || {};
  const flags = it.analysis_flags || [];
  const gl = `<section class="rd-gl"><p class="rd-eyebrow">For G&amp;L</p>
    <blockquote class="rd-gl-hook">${esc(g.hook)}</blockquote>
    <p class="rd-gl-apply">${esc(g.apply || g.how_we_run)}</p>
    ${g.angles?.length ? `<h4>Three angles</h4><ol class="rd-angles">${g.angles.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
    ${g.layouts?.length ? `<h4>Studio layout per beat</h4><ul class="rd-lays">${g.layouts.map((l) => `<li><span>${esc(l.beat)}</span><b>${LAYOUT_LABEL[l.layout] || esc(l.layout)}</b></li>`).join('')}</ul>` : ''}
    ${flags.length ? `<p class="rd-flag">Copy check: ${flags.length} line${flags.length === 1 ? '' : 's'} to review (${esc(flags.slice(0, 2).map((f) => f.rule).join('; '))})</p>` : ''}
    ${S.guest ? '' : `<div class="rd-gl-act">${it.script_id ? '<button type="button" class="rd-btn rd-btn-quiet" data-goscript>Open the script</button>' : ''}<button type="button" class="rd-btn rd-btn-primary" data-script${S.busy.sc ? ' disabled' : ''}>${S.busy.sc ? 'Writing the script' : it.script_id ? 'Write another script' : 'Make it a script'}</button></div>`}
  </section>`;
  const hook = `<section class="rd-sec"><div class="rd-sec-h"><h3>The hook</h3><span class="rd-chip">${esc(HOOK_LABEL[a.hook?.type] || 'Hook')}</span></div><blockquote class="rd-quote">${esc(a.hook?.text)}</blockquote><p>${esc(a.hook?.why)}</p></section>`;
  const ad = a.kind === 'ad'
    ? `<section class="rd-sec"><dl class="rd-dl">${[['Offer', a.offer], ['Angle', a.angle], ['Format', a.format], ['CTA', a.cta], ['Landing page promise', a.landing_promise], ['Why it keeps running', a.pattern]].filter(([, v]) => v).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl><p class="rd-fine">${esc(S.state?.copy?.adSpend || '')}</p></section>`
    : `${a.beats?.length ? `<section class="rd-sec"><h3>Structure</h3><ol class="rd-beats">${a.beats.map((b) => `<li><time>${esc(b.t)}</time><div><b>${esc(b.label)}</b><span>${esc(b.what)}</span></div></li>`).join('')}</ol></section>` : ''}
       ${a.drop_offs?.length ? `<section class="rd-sec"><div class="rd-sec-h"><h3>Likely drop-off points</h3><span class="rd-chip est">Estimate</span></div><ul class="rd-drops">${a.drop_offs.map((d) => `<li><time>${esc(d.t)}</time><span>${esc(d.why)}</span></li>`).join('')}</ul><p class="rd-fine">${esc(S.state?.copy?.retention || '')}</p></section>` : ''}
       <section class="rd-sec"><dl class="rd-dl">${[['What made it perform', a.pattern], ['Format', a.format], ['CTA', a.cta]].filter(([, v]) => v).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>`;
  return `${gl}${hook}${ad}<p class="rd-fine rd-an-foot">Analysed ${esc(ago(it.analyzed_at))} with ${BRAIN[it.analysis_brain] || 'the analyst'}.${S.guest || !brain ? '' : ` <button type="button" class="rd-link" data-analyse${busy ? ' disabled' : ''}>${busy ? 'Analysing again' : 'Analyse again'}</button>`}</p>`;
}
function sheet() {
  const it = S.open;
  if (!it) return '';
  return `<div class="rd-scrim" data-close></div><div class="rd-sheet" role="dialog" aria-modal="true" aria-labelledby="rd-sheet-t">
    <header class="rd-sheet-h"><div class="rd-sheet-tl"><span class="rd-g">${GLYPH[it.platform]}</span><div><h2 id="rd-sheet-t">${esc(it.title || it.caption?.slice(0, 120) || 'Untitled')}</h2><p class="rd-fine">${esc(it.author || '')}${it.published_at ? ' · ' + esc(new Date(it.published_at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })) : ''}${it.url ? ` · <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">Open on ${PLAT[it.platform]}</a>` : ''}</p></div></div>
      <button type="button" class="rd-icon" data-close aria-label="Close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header>
    <div class="rd-sheet-b"><div class="rd-sheet-l">${player(it)}${metrics(it)}${transcriptBlock(it)}</div><div class="rd-sheet-r">${analysisBlock(it)}</div></div>
  </div>`;
}

// ───────────── tabs: what's hot, sources, the radar editor ─────────────
function hot() {
  const d = S.digest;
  if (!d) return '<div class="rd-empty"><p>Reading the week</p></div>';
  if (!d.items) return `<div class="rd-empty"><p>Nothing found in the last ${d.days} days yet. Run a radar, then analyse the top items to see the patterns here.</p></div>`;
  const ex = (e) => `<button type="button" class="rd-ex" data-open="${esc(e.id)}"><span class="rd-g">${GLYPH[e.platform] || ''}</span>${esc((e.title || e.author || 'Untitled').slice(0, 70))}</button>`;
  const block = (title, sub, rows, lbl) => `<section class="rd-hot-sec"><h2>${title}</h2><p class="rd-fine">${sub}</p>${rows.length ? `<ul class="rd-pats">${rows.map((r) => `<li><div class="rd-pat-h"><b>${esc(lbl ? lbl(r.label) : r.label)}</b><span>${r.count} item${r.count === 1 ? '' : 's'} · average score ${r.avg_score}</span></div><div class="rd-exs">${r.examples.map(ex).join('')}</div></li>`).join('')}</ul>` : '<p class="rd-muted">Analyse a few of the top items to see this.</p>'}</section>`;
  return `<div class="rd-hot">
    <p class="rd-line">The last ${d.days} days: ${d.items} item${d.items === 1 ? '' : 's'} found, ${d.analysed} analysed.</p>
    <section class="rd-hot-sec"><h2>Top of the week</h2><ul class="rd-grid rd-grid-top">${d.top.map(card).join('')}</ul></section>
    ${block('Recurring hooks', 'The hook types behind the best performers.', d.hooks, (l) => HOOK_LABEL[l] || l)}
    ${block('Formats', 'How the winners are made.', d.formats, (l) => l.charAt(0).toUpperCase() + l.slice(1))}
    ${block('Topics', 'Words and phrases that recur in the top titles.', d.topics, null)}
  </div>`;
}
function sources() {
  const st = S.state; const src = S.sources;
  if (!st || !src) return '<div class="rd-empty"><p>Loading the sources</p></div>';
  const slotCard = (s) => {
    const info = st.slots.find((x) => x.slot === s.slot) || {};
    const sel = s.tools.find((t) => t.selected);
    const pv = S.preview[s.slot];
    const state = info.off ? '<span class="rd-chip">Off</span>' : !sel ? '<span class="rd-chip">Not picked</span>' : sel.confirmed ? '<span class="rd-chip ok">Confirmed</span>' : '<span class="rd-chip warn">Confirm the input</span>';
    if (info.off) return `<li class="rd-src off"><div class="rd-src-h"><span class="rd-g">${GLYPH[s.platform]}</span><h3>${esc(s.label)}</h3>${state}</div><p class="rd-fine">${esc(st.copy.instagramOff)}</p></li>`;
    const tools = s.tools.map((t) => `<li><label class="rd-tool"><input type="radio" name="tool-${esc(s.slot)}" data-pick="${esc(s.slot)}" data-provider="${esc(t.provider)}" data-endpoint="${esc(t.endpoint)}"${t.selected ? ' checked' : ''}${S.guest ? ' disabled' : ''}>
      <span><b>${esc(t.provider)} ${esc(t.endpoint)}</b>${t.recommended ? ' <span class="rd-chip in">Known actor</span>' : ''}<span class="rd-fine">${esc(priceText(t.price))}${t.description ? ' · ' + esc(t.description.slice(0, 140)) : ''}</span></span></label></li>`).join('');
    const preview = pv ? `<div class="rd-preview"><p class="rd-lbl">The exact input for ${esc(pv.query.keywords?.length ? pv.query.keywords.length + ' keywords' : 'one video')}${pv.inputs.length > 1 ? `, ${pv.inputs.length} runs` : ''}</p><pre>${esc(JSON.stringify(pv.inputs.length === 1 ? pv.inputs[0] : pv.inputs, null, 2))}</pre>
        <ul class="rd-notes">${pv.notes.map((x) => `<li>${esc(x)}</li>`).join('')}${pv.missing.length ? `<li class="warn">Required and not filled: ${esc(pv.missing.join(', '))}. Add them in the input template.</li>` : ''}</ul>
        <p class="rd-fine">Estimated cost: ${pv.est_micros ? usd(pv.est_micros) : 'not listed by Monid'} per radar run.</p>
        ${S.guest ? '' : `<div class="rd-row"><button type="button" class="rd-btn rd-btn-primary" data-confirm="${esc(s.slot)}"${pv.missing.length || sel?.confirmed ? ' disabled' : ''}>${sel?.confirmed ? 'Confirmed' : 'Confirm this input'}</button></div>`}</div>` : '';
    const custom = S.guest ? '' : `<details class="rd-custom"><summary>Use another tool or change the input</summary>
        <div class="rd-two"><label class="rd-field"><span>Provider</span><input data-cprov="${esc(s.slot)}" value="${esc(sel?.provider || 'apify')}"></label><label class="rd-field"><span>Endpoint</span><input data-cend="${esc(s.slot)}" value="${esc(sel?.endpoint || '')}" placeholder="/owner/actor"></label></div>
        <label class="rd-field"><span>Input template (JSON, merged over the mapped input; {{keywords}}, {{keyword}}, {{max}}, {{country}}, {{url}} fill in)</span><textarea rows="4" data-ctpl="${esc(s.slot)}">${esc(sel?.template ? JSON.stringify(sel.template, null, 2) : '')}</textarea></label>
        <button type="button" class="rd-btn rd-btn-quiet rd-btn-sm" data-custom="${esc(s.slot)}">Use this</button></details>`;
    return `<li class="rd-src"><div class="rd-src-h"><span class="rd-g">${GLYPH[s.platform]}</span><h3>${esc(s.label)}</h3>${state}
        <span class="rd-src-act">${S.guest ? '' : `<button type="button" class="rd-btn rd-btn-quiet rd-btn-sm" data-find="${esc(s.slot)}"${!st.key || S.busy['find' + s.slot] ? ' disabled' : ''}>${S.busy['find' + s.slot] ? 'Asking Monid' : s.tools.length ? 'Find again' : 'Find sources'}</button>`}${sel ? `<button type="button" class="rd-btn rd-btn-quiet rd-btn-sm" data-preview="${esc(s.slot)}">${pv ? 'Hide input' : 'Show input'}</button>` : ''}</span></div>
      ${s.tools.length ? `<ul class="rd-tools">${tools}</ul>` : `<p class="rd-fine">${st.key ? 'Press Find sources to see what Monid offers for this.' : 'Add the Monid key first.'}</p>`}${preview}${custom}</li>`;
  };
  const runs = (S.runs || []).map((r) => `<tr><td>${esc(new Date(r.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</td><td>${esc(r.slot)}</td><td><span class="rd-st ${esc(r.status)}">${esc(r.status)}</span>${r.error ? `<span class="rd-fine"> ${esc(r.error.slice(0, 120))}</span>` : ''}</td><td>${r.items_saved ?? '·'}</td><td>${r.status === 'completed' || r.status === 'failed' ? usd(r.cost_micros) + (r.cost_estimated ? ' est.' : '') : usd(r.est_micros) + ' est.'}</td></tr>`).join('');
  return `<div class="rd-sources">
    ${noKeyLine()}
    <p class="rd-line">One tool per slot. Monid lists what it has; known actors are pre-selected. Nothing paid runs until you have seen the exact input and confirmed it.</p>
    <ul class="rd-srcs">${src.slots.map(slotCard).join('')}</ul>
    <section class="rd-hot-sec"><h2>Recent runs</h2>${runs ? `<div class="rd-tablewrap"><table class="rd-table"><thead><tr><th>When</th><th>Source</th><th>Status</th><th>Items</th><th>Cost</th></tr></thead><tbody>${runs}</tbody></table></div>` : '<p class="rd-muted">No runs yet.</p>'}
    <p class="rd-fine">Settings: ${S.state.config.max_items} results per search, ${S.state.config.schedule_hours ? 'every ' + S.state.config.schedule_hours + ' hours' : 'manual runs only'}, budget ${usd(S.state.spend.budget_micros)} a month. Change them in <a href="/admin#integrations">Integrations</a> under Radar.</p></section>
  </div>`;
}
function editor() {
  const w = S.edit;
  if (!w) return '';
  const ig = S.state?.config?.instagram;
  return `<div class="rd-scrim" data-close-edit></div><form class="rd-sheet rd-edit" role="dialog" aria-modal="true" aria-labelledby="rd-edit-t" data-edit-form>
    <header class="rd-sheet-h"><h2 id="rd-edit-t">${w.id ? 'Edit radar' : 'New radar'}</h2><button type="button" class="rd-icon" data-close-edit aria-label="Close"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button></header>
    <div class="rd-edit-b">
      <label class="rd-field"><span>Name</span><input name="name" maxlength="80" required value="${esc(w.name || '')}"></label>
      <label class="rd-field"><span>Keywords, one per line</span><textarea name="keywords" rows="6">${esc((w.keywords || []).join('\n'))}</textarea></label>
      <fieldset class="rd-field"><legend>Platforms</legend><div class="rd-checks">${['youtube', 'tiktok', 'instagram', 'meta_ads'].map((p) => `<label><input type="checkbox" name="platforms" value="${p}"${(w.platforms || []).includes(p) ? ' checked' : ''}${p === 'instagram' && !ig ? ' disabled' : ''}> ${PLAT[p]}${p === 'instagram' && !ig ? ' (off)' : ''}</label>`).join('')}</div></fieldset>
      <fieldset class="rd-field"><legend>Niche</legend><div class="rd-checks"><label><input type="radio" name="niche" value="in"${w.niche !== 'out' ? ' checked' : ''}> Our niche</label><label><input type="radio" name="niche" value="out"${w.niche === 'out' ? ' checked' : ''}> Outside the niche</label></div></fieldset>
      <div class="rd-two"><label class="rd-field"><span>Country (two letters, blank for any)</span><input name="country" maxlength="2" value="${esc(w.country || '')}"></label><label class="rd-field"><span>Only the last N days</span><input name="since_days" inputmode="numeric" value="${esc(w.since_days || '')}"></label></div>
      <label class="rd-switch"><input type="checkbox" name="enabled"${w.enabled !== false ? ' checked' : ''}> Runs on the schedule</label>
    </div>
    <footer class="rd-edit-f">${w.id ? '<button type="button" class="rd-btn rd-btn-danger" data-del>Delete</button>' : '<span></span>'}<button type="submit" class="rd-btn rd-btn-primary">Save</button></footer>
  </form>`;
}

function render() {
  if (!root) return;
  const scrollY = window.scrollY;
  let body;
  if (!S.loaded) body = '<div class="rd-empty"><p>Loading Radar</p></div>';
  else if (S.tab === 'hot') body = hot();
  else if (S.tab === 'sources') body = sources();
  else body = `${noKeyLine()}<div class="rd-layout">${rail()}<div class="rd-main">${grid()}</div></div>`;
  root.innerHTML = `<div class="rd-wrap">${head()}${body}</div>${sheet()}${editor()}`;
  document.body.classList.toggle('rd-locked', Boolean(S.open || S.edit));
  window.scrollTo(0, scrollY);
}

// ───────────── actions ─────────────
async function openItem(id) {
  try { S.open = (await api('/items/' + encodeURIComponent(id))).item; render(); root.querySelector('.rd-sheet [data-close]')?.focus(); } catch (e) { toast(e.message); }
}
async function analyseOpen() {
  const it = S.open; if (!it || S.busy.an) return;
  S.busy.an = true; render();
  try { await api(`/items/${encodeURIComponent(it.id)}/analyse`, { method: 'POST' }); S.open = (await api('/items/' + encodeURIComponent(it.id))).item; toast('Analysed'); }
  catch (e) { toast(e.message); }
  finally { S.busy.an = false; render(); }
}
async function scriptOpen() {
  const it = S.open; if (!it || S.busy.sc) return;
  S.busy.sc = true; render();
  try {
    const r = await api(`/items/${encodeURIComponent(it.id)}/script`, { method: 'POST', body: '{}' });
    try { localStorage.setItem('studio:script', r.script.id); } catch { /* private mode */ }
    S.open = null; S.busy.sc = false; render();
    window.studio?.show?.('scripts');
    window.dispatchEvent(new CustomEvent('studio:open-script', { detail: { id: r.script.id } }));
    toast('The script is in Scripts, ready to record');
  } catch (e) { toast(e.message); S.busy.sc = false; render(); }
}
function goScript() {
  const id = S.open?.script_id; if (!id) return;
  try { localStorage.setItem('studio:script', id); } catch { /* private mode */ }
  S.open = null; render();
  window.studio?.show?.('scripts');
  window.dispatchEvent(new CustomEvent('studio:open-script', { detail: { id } }));
}

root?.addEventListener('click', async (e) => {
  const t = e.target;
  const tab = t.closest('[data-tab]');
  if (tab) { S.tab = tab.dataset.tab; try { localStorage.setItem('radar:tab', S.tab); } catch { /* private mode */ } S.loaded = false; render(); return refresh(); }
  if (t.closest('[data-close]')) { S.open = null; render(); return; }
  if (t.closest('[data-close-edit]')) { S.edit = null; render(); return; }
  const f = t.closest('[data-f]');
  if (f && !f.disabled) {
    if (f.dataset.f === 'adsort') S.adSort = f.dataset.v; else S.filters[f.dataset.f] = f.dataset.v;
    await loadItems().catch((err) => toast(err.message)); render(); return;
  }
  const rd = t.closest('[data-radar]');
  if (rd) { S.filters.radar = S.filters.radar === rd.dataset.radar ? '' : rd.dataset.radar; await loadItems().catch((err) => toast(err.message)); render(); return; }
  const op = t.closest('[data-open]');
  if (op) return openItem(op.dataset.open);
  if (t.closest('[data-analyse]')) return analyseOpen();
  if (t.closest('[data-script]')) return scriptOpen();
  if (t.closest('[data-goscript]')) return goScript();
  if (t.closest('[data-transcript]') && S.open) {
    S.busy.tr = true; render();
    try { await api(`/items/${encodeURIComponent(S.open.id)}/transcript`, { method: 'POST' }); S.open.transcript_source = 'pending'; toast('Fetching the transcript. It shows here when it lands.'); await loadState(); schedulePoll(); }
    catch (err) { toast(err.message); }
    finally { S.busy.tr = false; render(); }
    return;
  }
  const run = t.closest('[data-run]');
  if (run) {
    const id = run.dataset.run; S.busy['run' + id] = true; render();
    try { const r = await api(`/watchlists/${encodeURIComponent(id)}/run`, { method: 'POST' }); toast(`Started ${r.queued} run${r.queued === 1 ? '' : 's'}, about ${usd(r.est_micros)}.${r.notes?.length ? ' ' + r.notes[0] : ''}`); await loadState(); schedulePoll(); }
    catch (err) { toast(err.message); }
    finally { S.busy['run' + id] = false; render(); }
    return;
  }
  const ed = t.closest('[data-edit]');
  if (ed) { S.edit = { ...(S.state.watchlists.find((w) => w.id === ed.dataset.edit) || {}) }; render(); root.querySelector('[data-edit-form] input')?.focus(); return; }
  if (t.closest('[data-new]')) { S.edit = { platforms: S.tab === 'ads' ? ['meta_ads'] : ['youtube', 'tiktok'], niche: 'in', enabled: true, keywords: [] }; render(); root.querySelector('[data-edit-form] input')?.focus(); return; }
  if (t.closest('[data-del]') && S.edit?.id) {
    const b = t.closest('[data-del]');
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Delete for good'; return; }
    try { await api('/watchlists/' + encodeURIComponent(S.edit.id), { method: 'DELETE' }); S.edit = null; toast('Deleted'); await refresh(); } catch (err) { toast(err.message); }
    return;
  }
  const find = t.closest('[data-find]');
  if (find) {
    const slot = find.dataset.find; S.busy['find' + slot] = true; render();
    try { const r = await api('/sources/find', { method: 'POST', body: JSON.stringify({ slot }) }); toast(`Monid offered ${r.found} tool${r.found === 1 ? '' : 's'}${r.preselected ? '. A known actor is pre-selected' : ''}.`); S.sources = await api('/sources'); await loadState(); }
    catch (err) { toast(err.message); }
    finally { S.busy['find' + slot] = false; render(); }
    return;
  }
  const pv = t.closest('[data-preview]');
  if (pv) {
    const slot = pv.dataset.preview;
    if (S.preview[slot]) { delete S.preview[slot]; render(); return; }
    try { S.preview[slot] = await api('/sources/preview?slot=' + encodeURIComponent(slot)); render(); } catch (err) { toast(err.message); }
    return;
  }
  const cf = t.closest('[data-confirm]');
  if (cf) {
    const slot = cf.dataset.confirm;
    try { await api('/sources/confirm', { method: 'POST', body: JSON.stringify({ slot }) }); toast('Confirmed. Radars can run this source now.'); S.sources = await api('/sources'); await loadState(); S.preview[slot] = await api('/sources/preview?slot=' + encodeURIComponent(slot)); render(); }
    catch (err) { toast(err.message); }
    return;
  }
  const cu = t.closest('[data-custom]');
  if (cu) {
    const slot = cu.dataset.custom;
    const q = (a) => root.querySelector(`[${a}="${slot}"]`)?.value.trim() || '';
    try { await api('/sources/select', { method: 'POST', body: JSON.stringify({ slot, provider: q('data-cprov'), endpoint: q('data-cend'), template: q('data-ctpl') || null }) }); S.sources = await api('/sources'); S.preview[slot] = await api('/sources/preview?slot=' + encodeURIComponent(slot)); await loadState(); render(); toast('Picked. Check the input, then confirm.'); }
    catch (err) { toast(err.message); }
  }
});
root?.addEventListener('toggle', (e) => { if (e.target.matches?.('[data-rail]')) S.railOpen = e.target.open; }, true);
root?.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.matches('[data-sort]')) { S.filters.sort = t.value; await loadItems().catch((err) => toast(err.message)); render(); return; }
  if (t.matches('[data-pick]')) {
    const slot = t.dataset.pick;
    try { await api('/sources/select', { method: 'POST', body: JSON.stringify({ slot, provider: t.dataset.provider, endpoint: t.dataset.endpoint }) }); S.sources = await api('/sources'); S.preview[slot] = await api('/sources/preview?slot=' + encodeURIComponent(slot)); await loadState(); render(); }
    catch (err) { toast(err.message); }
  }
});
root?.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-edit-form]'); if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const body = { name: fd.get('name'), keywords: String(fd.get('keywords') || '').split('\n'), platforms: fd.getAll('platforms'), niche: fd.get('niche'), country: fd.get('country'), since_days: fd.get('since_days'), enabled: fd.get('enabled') === 'on' };
  try {
    await api(S.edit.id ? '/watchlists/' + encodeURIComponent(S.edit.id) : '/watchlists', { method: S.edit.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    S.edit = null; toast('Saved'); await refresh();
  } catch (err) { toast(err.message); }
});
// A thumbnail that no longer loads (platform CDN links expire) falls back to the quiet empty frame.
root?.addEventListener('error', (e) => { const img = e.target; if (img && img.tagName === 'IMG') img.closest('.rd-thumb, .rd-player')?.classList.add('broken'); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (S.open || S.edit) && !root.hidden) { S.open = null; S.edit = null; render(); } });

let started = false;
async function start() {
  if (started) return; started = true;
  const who = await (window.__studioWho = window.__studioWho || fetch('/admin/api/whoami', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  S.guest = Boolean(who && who.guest);
  render();
  await refresh();
}
// Load when the Radar view is first shown (or straight away when the page opens on it).
window.addEventListener('studio:view', (e) => { if (e.detail?.view === 'radar') start(); });
if (root) render();
if (root && (!root.hidden || location.hash === '#radar')) start();

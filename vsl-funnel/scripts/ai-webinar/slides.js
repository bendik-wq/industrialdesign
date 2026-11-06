// Renders the masterclass slides (1920x1080 PNG) from slides.json.
// One restrained system: solid warm white (#f7f6f3) or near-black (#111) for section breaks, one navy accent,
// Newsreader for headlines, Inter for small text, a 12-column grid with 128px margins, hairline rules,
// small-caps labels and big tabular numbers. No gradients, glows, translucent overlays or bordered boxes.
// Layouts: title, statement, section, stat, list, comparison, quote, table, offer, step, image-full, image-left.
// Every slide carries the AI-narration disclosure in its footer.
// An ES module (the package is "type": "module"); Playwright comes from the global install (NODE_PATH) or the repo.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Typographic quotes and apostrophes, and a non-breaking space before the last word (no one-word last lines).
const typo = (s) => esc(String(s ?? '').replace(/(^|[\s(])"/g, '$1\u201c').replace(/"/g, '\u201d').replace(/(^|[\s(])'/g, '$1\u2018').replace(/'/g, '\u2019'))
  .replace(/(\w)-(\w)/g, '$1\u2011$2')
  .replace(/^(.*\S+ \S+ \S+ \S+.*) (\S{1,12})$/, '$1\u00a0$2'); // only on lines of five words or more
const cells = (row) => String(row).split('|').map((x) => x.trim());

const css = `
@import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,200..800;1,6..72,200..800&family=Inter:opsz,wght@14..32,300..700&display=block');
:root{--bg:#f7f6f3;--ink:#121212;--ink2:#5c5b57;--ink3:#8b8984;--hair:#dcd9d2;--panel:#ebe9e4;--accent:#0f2c5c;--M:128px}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1920px;height:1080px;overflow:hidden}
body{background:var(--bg);color:var(--ink);font-family:Inter,Arial,sans-serif;-webkit-font-smoothing:antialiased;font-feature-settings:"kern","liga"}
.dark{--bg:#111111;--ink:#f4f3ef;--ink2:#b3b1ab;--ink3:#7d7b76;--hair:#2c2c2b;--panel:#1c1c1b;--accent:#f4f3ef}
.slide{position:relative;width:1920px;height:1080px;background:var(--bg);overflow:hidden}
.serif{font-family:Newsreader,Georgia,serif;font-optical-sizing:auto}
.num{font-variant-numeric:lining-nums tabular-nums}
.sc{font:500 20px/1 Inter;letter-spacing:.16em;text-transform:uppercase;color:var(--ink3)}
.bal{text-wrap:balance}
/* Chrome: chapter label, brand, top hairline, footer disclosure + slide number. */
.top{position:absolute;left:var(--M);right:var(--M);top:64px;display:flex;justify-content:space-between;align-items:baseline}
.top .brand{font:500 22px/1 Newsreader,Georgia,serif;letter-spacing:.01em;color:var(--ink)}
.toprule{position:absolute;left:var(--M);right:var(--M);top:108px;height:1px;background:var(--hair)}
.foot{position:absolute;left:var(--M);right:var(--M);bottom:52px;display:flex;justify-content:space-between;align-items:baseline;font:400 20px/1 Inter;color:var(--ink3)}
.foot .n{color:var(--ink2);margin-left:28px;font-variant-numeric:tabular-nums}
/* Content frame: the grid area between the top rule and the footer. */
.c{position:absolute;left:var(--M);right:var(--M);top:156px;bottom:132px;display:flex;flex-direction:column}
h1,.h{font-family:Newsreader,Georgia,serif;font-weight:400;letter-spacing:-.022em;color:var(--ink)}
.sub{font:400 36px/1.4 Inter;color:var(--ink2);letter-spacing:-.005em}
.take{margin-top:64px;max-width:1240px}
.take p{font:500 36px/1.4 Inter;color:var(--ink);letter-spacing:-.01em}
.take p+p{margin-top:14px}
.take::before{content:"";display:block;width:56px;height:2px;background:var(--accent);margin-bottom:28px}
.note{font:400 22px/1.4 Inter;color:var(--ink3)}
/* title */
.L-title .c{justify-content:flex-end;padding-bottom:24px}
.L-title .toprule{display:none}
.L-title h1{font-size:150px;line-height:.98;letter-spacing:-.03em;max-width:1500px;text-wrap:pretty}
.L-title .sub{margin-top:44px;max-width:1180px;font-size:38px}
.L-title .kick{margin-bottom:56px}
.L-title.has-img .c{right:calc(1920px - 1000px)}
.L-title.has-img h1{font-size:120px}
.L-title.has-img .top{right:calc(1920px - 1000px + 96px)}
.L-title.has-img .toprule,.L-title.has-img .foot{right:calc(1920px - 1000px + 96px)}
.L-title.has-img .c{right:calc(1920px - 1000px + 72px)}
/* statement */
.L-statement .c{justify-content:center}
.L-statement h1{font-size:120px;line-height:1.04;max-width:1560px}
.L-statement .sub{margin-top:44px;max-width:1240px}
/* section break (dark) */
.L-section .c{justify-content:space-between}
.L-section .big{font:300 340px/.8 Newsreader,Georgia,serif;letter-spacing:-.04em;color:#3b3b39;margin-top:8px}
.L-section h1{font-size:120px;line-height:1.02;max-width:1500px}
.L-section .sc{margin-bottom:36px;color:var(--ink2)}
.L-section .sub{margin-top:40px;max-width:1240px;color:var(--ink2)}
/* headline used by data layouts */
.hd{font-size:92px;line-height:1.04;max-width:1500px}
.hdsub{margin-top:20px;font:400 32px/1.4 Inter;color:var(--ink2);max-width:1200px}
.foot-note{margin-top:auto;padding-top:28px}
/* stat */
.L-stat .prim{display:flex;align-items:flex-end;gap:64px;margin-top:72px}
.L-stat .prim.solo{flex-direction:column;align-items:flex-start;gap:40px;margin:auto 0}
.L-stat .bignum{font:300 300px/.82 Newsreader,Georgia,serif;letter-spacing:-.045em;color:var(--accent);white-space:nowrap}
.L-stat .bignum.solo{font-size:340px}
.L-stat .prim.solo .biglab{max-width:1100px;font-size:56px}
.L-stat .biglab{font:400 48px/1.18 Newsreader,Georgia,serif;letter-spacing:-.012em;max-width:640px;padding-bottom:10px}
.L-stat .row{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:48px;margin-top:auto}
.L-stat .row > div{border-top:1px solid var(--hair);padding-top:28px}
.L-stat .row .v{font:400 104px/.9 Newsreader,Georgia,serif;letter-spacing:-.03em}
.L-stat .row .l{margin-top:18px;font:400 26px/1.35 Inter;color:var(--ink2);max-width:420px}
/* list (max 3) */
.L-list ol{list-style:none;margin:auto 0 0;border-bottom:1px solid var(--hair)}
.L-list li{display:grid;grid-template-columns:120px minmax(0,1fr) minmax(0,1fr);column-gap:48px;align-items:baseline;border-top:1px solid var(--hair);padding:38px 0 40px}
.L-list li.one{grid-template-columns:120px minmax(0,1fr)}
.L-list .i{font:500 22px/1 Inter;letter-spacing:.08em;color:var(--ink3);font-variant-numeric:tabular-nums}
.L-list .t{font:400 54px/1.1 Newsreader,Georgia,serif;letter-spacing:-.018em}
.L-list .d{font:400 30px/1.4 Inter;color:var(--ink2)}
.L-list .foot-note,.L-comparison .foot-note,.L-stat .foot-note{margin-top:28px;padding-top:0}
/* comparison */
.L-comparison .cols{display:grid;grid-template-columns:1fr 1fr;margin:auto 0 0;border-top:1px solid var(--hair)}
.L-comparison .col{padding:44px 64px 8px 0}
.L-comparison .col+.col{border-left:1px solid var(--hair);padding-left:64px}
.L-comparison .v{font:300 150px/.9 Newsreader,Georgia,serif;letter-spacing:-.04em;margin-top:36px;white-space:nowrap}
.L-comparison .col+.col .v{color:var(--accent)}
.L-comparison .b{margin-top:32px;font:400 32px/1.4 Inter;color:var(--ink2);max-width:640px}
.L-comparison .v.txt{font:400 72px/1.05 Newsreader,Georgia,serif;letter-spacing:-.02em;white-space:normal}
/* quote */
.L-quote .c{justify-content:center}
.L-quote blockquote{font:italic 400 116px/1.06 Newsreader,Georgia,serif;letter-spacing:-.02em;max-width:1500px;text-indent:-.4em}
.L-quote .by{margin-top:64px;display:flex;align-items:center;gap:24px}
.L-quote .by::before{content:"";width:56px;height:1px;background:var(--ink3)}
/* table */
.L-table table{width:100%;border-collapse:collapse;margin:auto 0 0}
.L-table th{font:500 20px/1 Inter;letter-spacing:.16em;text-transform:uppercase;color:var(--ink3);text-align:right;padding:0 0 22px;border-bottom:1.5px solid var(--ink)}
.L-table th:first-child,.L-table td:first-child{text-align:left}
.L-table td{text-align:right;padding:30px 0 28px;border-bottom:1px solid var(--hair);font:400 64px/1 Newsreader,Georgia,serif;letter-spacing:-.02em;font-variant-numeric:lining-nums tabular-nums}
.L-table td:first-child{font:400 32px/1.2 Inter;letter-spacing:-.005em;color:var(--ink2)}
.L-table tr.res td{border-bottom:0;border-top:1.5px solid var(--ink);color:var(--accent);font-weight:500}
.L-table tr.res td:first-child{color:var(--ink);font-weight:500}
.L-table .foot-note{margin-top:32px;padding-top:0}
/* offer: a receipt beside the name */
.L-offer .c{flex-direction:row;gap:0}
.L-offer .lt{width:760px;display:flex;flex-direction:column;justify-content:center;padding-right:64px}
.L-offer .lt h1{font-size:104px;line-height:1.02}
.L-offer .lt .sub{margin-top:36px;font-size:34px}
.L-offer .rt{flex:1;display:flex;flex-direction:column;justify-content:center;border-left:1px solid var(--hair);padding-left:96px}
.L-offer .ln{display:flex;justify-content:space-between;align-items:baseline;padding:30px 0;border-bottom:1px solid var(--hair)}
.L-offer .ln .l{font:400 32px/1.2 Inter;color:var(--ink2)}
.L-offer .ln .v{font:400 64px/1 Newsreader,Georgia,serif;letter-spacing:-.02em}
.L-offer .tot{display:flex;justify-content:space-between;align-items:flex-end;padding-top:40px;border-top:1.5px solid var(--ink);margin-top:-1px}
.L-offer .tot .l{font:500 32px/1.2 Inter;padding-bottom:20px}
.L-offer .tot .v{font:300 220px/.82 Newsreader,Georgia,serif;letter-spacing:-.045em;color:var(--accent)}
.L-offer .rt .note{margin-top:40px}
/* step (Day 1 to Day 7) */
.L-step .c{justify-content:space-between}
.L-step .mid{display:flex;align-items:flex-end;gap:72px}
.L-step .dn{font:300 480px/.74 Newsreader,Georgia,serif;letter-spacing:-.05em;color:var(--accent)}
.L-step .tx{padding-bottom:6px;max-width:1000px}
.L-step .tx .sc{margin-bottom:28px}
.L-step .tx h1{font-size:96px;line-height:1.04}
.L-step .tx .sub{margin-top:28px;font-size:32px}
.L-step .track{display:grid;grid-template-columns:repeat(7,1fr);gap:16px}
.L-step .track div{border-top:1px solid var(--hair);padding-top:20px;font:500 20px/1.25 Inter;color:var(--ink3)}
.L-step .track b{font-weight:500}
.L-step .track span{display:block;font:400 20px/1 Inter;margin-bottom:10px;font-variant-numeric:tabular-nums}
.L-step .track .on{border-top:3px solid var(--accent);padding-top:18px;color:var(--ink)}
.L-step .track .past{border-top-color:var(--ink3)}
.L-step.has-img .c,.L-step.has-img .top,.L-step.has-img .toprule,.L-step.has-img .foot{right:calc(1920px - 1000px + 96px)}
.L-step.has-img .mid{flex-direction:column;align-items:flex-start;gap:40px}
.L-step.has-img .dn{font-size:300px}
.L-step.has-img .tx h1{font-size:80px}
.L-step.has-img .track{gap:12px}
.L-step.has-img .track b{display:none}
.L-step.has-img .track span{margin:0;font-size:22px}
/* images */
.img{position:absolute;background:var(--panel);overflow:hidden}
.img img{display:block;width:100%;height:100%;object-fit:cover}
.img.contain{padding:56px}
.img.contain img{object-fit:contain}
.ph{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:0 96px}
.ph .sc{color:var(--ink3);margin-bottom:28px}
.ph p{font:italic 400 44px/1.25 Newsreader,Georgia,serif;color:var(--ink2);max-width:760px;letter-spacing:-.01em}
.ph .note{margin-top:28px;font-size:20px}
.L-image-full .img{left:0;top:0;width:1920px;height:768px}
.L-image-full .ph{padding:0 var(--M)}
.L-image-full .cap{position:absolute;left:var(--M);right:var(--M);top:816px;display:grid;grid-template-columns:minmax(0,1fr) 560px;column-gap:96px;align-items:start}
.L-image-full .cap .sc{margin-bottom:18px}
.L-image-full .cap h1{font-size:50px;line-height:1.12;letter-spacing:-.015em}
.L-image-full .cap .cr{font:400 20px/1.45 Inter;color:var(--ink3);text-align:right;padding-top:38px}
.L-image-full .cap h1{max-height:116px}
.L-image-full .foot{bottom:40px}
.L-image-left .img{left:0;top:0;width:904px;height:1080px}
.L-image-left .top,.L-image-left .toprule,.L-image-left .c,.L-image-left .foot{left:1000px}
.has-img .top .brand{display:none}
.top .sc{white-space:nowrap}
.L-image-left .c{justify-content:center}
.L-image-left h1{font-size:88px;line-height:1.04}
.L-image-left .sub{margin-top:32px;font-size:32px}
.L-image-left .take{margin-top:48px}
.L-image-left .take p{font-size:30px}
.L-image-left .pic{position:absolute;left:1000px;right:var(--M);bottom:120px;padding-top:20px;border-top:1px solid var(--hair);font:400 20px/1.45 Inter;color:var(--ink3)}
.L-image-left .pic b{font-weight:500;color:var(--ink2)}
.L-title .img{left:1000px;top:0;width:920px;height:1080px}
.L-step .img{left:1000px;top:0;width:920px;height:1080px}
`;

const DAYS = ['Kickoff', 'Capacity', 'Buy box', 'Shortlist', 'Memo', 'Script', 'Deal Plan'];

function imageBlock(j, cls = '') {
  const im = j.image;
  if (!im) return '';
  const fit = im.fit === 'contain' ? ' contain' : '';
  if (im.src) {
    const data = fs.readFileSync(im.src).toString('base64');
    const mime = im.src.endsWith('.jpg') || im.src.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    const pos = im.position ? ` style="object-position:${esc(im.position)}"` : '';
    return `<div class="img${fit} ${cls}"><img src="data:${mime};base64,${data}" alt=""${pos}></div>`;
  }
  // Placeholder until the deck PDF is extracted: says exactly which original image goes here.
  return `<div class="img ${cls}"><div class="ph"><div class="sc">Original image · deck slide ${esc(im.deck_slide ?? '?')}</div><p>${typo(im.what || im.id)}</p><div class="note">${esc(im.id)} · pending deck_images.py</div></div></div>`;
}

const take = (lines) => (lines.length ? `<div class="take">${lines.map((o) => `<p>${typo(o)}</p>`).join('')}</div>` : '');

function body(j) {
  const L = j.layout;
  const d = (j.data || []).map(cells);
  const cap = j.caption ? `<p class="note foot-note">${typo(j.caption)}</p>` : '';
  const head = `<h1 class="hd bal" data-fit="170">${typo(j.title)}</h1>${j.sub ? `<p class="hdsub">${typo(j.sub)}</p>` : ''}`;
  switch (L) {
    case 'title':
      return `${imageBlock(j)}<div class="c"><div class="sc kick">${esc(j.kicker || 'A masterclass from G&L M&A Advisory')}</div><h1 class="bal" data-fit="460">${typo(j.title)}</h1>${j.sub ? `<p class="sub bal">${typo(j.sub)}</p>` : ''}</div>`;
    case 'section':
      return `<div class="c"><div class="big num">${esc(j.chapterNo)}</div><div><div class="sc">Chapter ${esc(j.chapterNo)} · ${esc(j.chapter)}</div><h1 class="bal" data-fit="380">${typo(j.title)}</h1>${j.sub ? `<p class="sub">${typo(j.sub)}</p>` : ''}${j.onscreen.length ? `<p class="sub">${j.onscreen.map(typo).join(' ')}</p>` : ''}</div></div>`;
    case 'stat': {
      const [p, ...rest] = d;
      return `<div class="c">${head}<div class="prim${rest.length ? '' : ' solo'}"><div class="bignum num${rest.length ? '' : ' solo'}">${esc(p[0])}</div><div class="biglab bal">${typo(p[1] || '')}</div></div>
        ${rest.length ? `<div class="row">${rest.map((r) => `<div><div class="v num">${esc(r[0])}</div><div class="l">${typo(r[1] || '')}</div></div>`).join('')}</div>` : ''}${rest.length ? '' : cap}</div>`;
    }
    case 'list':
      return `<div class="c">${head}<ol>${d.slice(0, 3).map((r, i) => `<li class="${r[1] ? '' : 'one'}"><span class="i">${String(i + 1).padStart(2, '0')}</span><span class="t">${typo(r[0])}</span>${r[1] ? `<span class="d">${typo(r[1])}</span>` : ''}</li>`).join('')}</ol>${cap}</div>`;
    case 'comparison':
      const txt = d.slice(0, 2).some((r) => r[1].length > 10) ? ' txt' : '';
      return `<div class="c">${head}<div class="cols">${d.slice(0, 2).map((r) => `<div class="col"><div class="sc">${esc(r[0])}</div><div class="v num${txt}">${typo(r[1])}</div><p class="b">${typo(r[2] || '')}</p></div>`).join('')}</div>${cap}</div>`;
    case 'quote': {
      const q = j.title.replace(/^["\u201c]|["\u201d]$/g, '');
      return `<div class="c"><blockquote class="bal" data-fit="520">\u201c${typo(q).replace(/\u00a0/g, ' ')}\u201d</blockquote><div class="by sc">${esc(j.caption || 'What owners ask')}</div></div>`;
    }
    case 'table': {
      const [hdr, ...rows] = d;
      return `<div class="c">${head}<table><thead><tr>${hdr.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r, i) => `<tr class="${i === rows.length - 1 ? 'res' : ''}">${r.map((x) => `<td>${typo(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>${cap}</div>`;
    }
    case 'offer': {
      const tot = d[d.length - 1];
      return `<div class="c"><div class="lt"><div class="sc" style="margin-bottom:36px">The offer</div><h1 class="bal">${typo(j.title)}</h1>${j.sub ? `<p class="sub">${typo(j.sub)}</p>` : ''}</div>
        <div class="rt">${d.slice(0, -1).map((r) => `<div class="ln"><span class="l">${typo(r[0])}</span><span class="v num">${esc(r[1])}</span></div>`).join('')}
        <div class="tot"><span class="l">${typo(tot[0])}</span><span class="v num">${esc(tot[1])}</span></div>${j.caption ? `<p class="note">${typo(j.caption)}</p>` : ''}</div></div>`;
    }
    case 'step': {
      const n = Number((j.title.match(/\d+/) || ['1'])[0]);
      const track = DAYS.map((t, i) => `<div class="${i + 1 === n ? 'on' : i + 1 < n ? 'past' : ''}"><span>Day ${i + 1}</span><b>${esc(t)}</b></div>`).join('');
      return `${imageBlock(j)}<div class="c"><div></div><div class="mid"><div class="dn num">${n}</div><div class="tx"><div class="sc">Day ${n} of 7 · The First Deal Sprint</div><h1 class="bal" data-fit="300">${typo(j.sub || j.title)}</h1>${j.caption ? `<p class="sub">${typo(j.caption)}</p>` : ''}</div></div><div class="track">${track}</div></div>`;
    }
    case 'image-full':
      return `${imageBlock(j)}<div class="cap"><div><div class="sc">${esc(j.chapter)}</div><h1 class="bal" data-fit="130">${typo(j.caption || j.onscreen[0] || j.title)}</h1></div><div class="cr">${typo(j.credit || '')}</div></div>`;
    case 'image-left':
      return `${imageBlock(j)}<div class="c"><h1 class="bal" data-fit="300">${typo(j.title)}</h1>${j.sub ? `<p class="sub">${typo(j.sub)}</p>` : ''}${take(j.onscreen)}</div>
        ${j.caption || j.credit ? `<div class="pic">${j.caption ? `<b>Pictured</b> · ${typo(j.caption)}<br>` : ''}${typo(j.credit || '')}</div>` : ''}`;
    default: // statement
      return `<div class="c"><h1 class="bal" data-fit="${j.sub || j.onscreen.length ? 360 : 600}">${typo(j.title)}</h1>${j.sub ? `<p class="sub bal" data-fit="${j.sub.length > 160 ? 300 : 200}">${typo(j.sub)}</p>` : ''}${take(j.onscreen)}</div>`;
  }
}

function page(j) {
  const L = j.layout || 'statement';
  const dark = L === 'section';
  const chrome = L === 'image-full' ? '' : `<div class="top"><span class="sc">${L === 'title' || L === 'section' ? '' : `${esc(j.chapterNo)} · ${esc(j.chapter)}`}</span><span class="brand">G&amp;L M&amp;A Advisory</span></div><div class="toprule"></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
    <div class="slide L-${L}${dark ? ' dark' : ''}${j.image ? ' has-img' : ''}">${chrome}${body({ ...j, layout: L })}
    <div class="foot"><span>The Acquisition Masterclass</span><span>Narrated by an AI voice · Method by Josh Li<span class="n">${String(j.n).padStart(2, '0')}</span></span></div></div></body></html>`;
}

(async () => {
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const warn = [];
  for (const j of jobs) {
    await p.setContent(page(j), { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    const ok = await p.evaluate(() => document.fonts.check('400 100px Newsreader'));
    if (!ok) throw new Error('Newsreader did not load (fonts.googleapis.com unreachable?)');
    // Shrink any headline that runs past its box, then report anything that still collides with the footer.
    const issue = await p.evaluate(() => {
      for (const el of document.querySelectorAll('[data-fit]')) {
        let fs = parseFloat(getComputedStyle(el).fontSize);
        while (el.scrollHeight > Number(el.dataset.fit) && fs > 28) { fs -= 2; el.style.fontSize = fs + 'px'; }
      }
      const foot = document.querySelector('.foot').getBoundingClientRect().top;
      const c = document.querySelector('.c, .cap');
      if (!c) return null;
      let bottom = 0;
      for (const el of c.querySelectorAll('*')) bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
      return bottom > foot - 24 ? `content bottom ${Math.round(bottom)} > footer ${Math.round(foot)}` : null;
    });
    if (issue) warn.push(`${path.basename(j.file)} (${j.layout}: ${j.title}): ${issue}`);
    await p.screenshot({ path: j.file });
  }
  await b.close();
  console.log(`rendered ${jobs.length} slides`);
  if (warn.length) console.log('layout warnings:\n  ' + warn.join('\n  '));
})();

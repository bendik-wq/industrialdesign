// The presented deck: the PDF for the room's slide upload, the on-screen text for the copy audit, and (with --shots)
// a step through every slide and build at 1920x1080 with screenshots, a contact sheet and a layout check.
//   python3 scripts/ai-webinar/present/build_deck.py          (first: writes present/out/deck.html)
//   node scripts/ai-webinar/present/export.mjs                (present/out/masterclass-deck.pdf + deck-text.json)
//   node scripts/ai-webinar/present/export.mjs --shots DIR    (also DIR/contact-*.png, DIR/builds/*.png, DIR/all/*.png)
// Then: npx vite-node scripts/ai-webinar/present/audit-deck.ts (auditCopy on every line the deck shows).
// Playwright comes from the global install (NODE_PATH) or the repo, as for slides.js.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const FILE = pathToFileURL(path.join(OUT, 'deck.html')).href;
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1]) : null;
// Fifteen builds worth a close look (slide title, build; -1 = the last build): the slides with deck originals first.
const KEY = [
  ['The Acquisition Masterclass', 0], ['Twice, the sellers financed the whole price', -1], ["Who's behind the method", -1], ['The owner with no successor', -1],
  ['You can reach them first', -1], ['Two acquisitions, both seller financed', -1], ['What a holding company is for', -1], ['Back to the question', -1],
  ['What the call can lead to', -1], ['The first week', -1], ['The first outreach', -1], ['A year from now', -1],
  ['The big domino', 1], ['Everything in one place', -1], ["I'm a buyer.", -1],
];

const b = await chromium.launch();
const errors = [];
// 1. Print view: every slide at its final build, one page each.
{
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('pageerror', (e) => errors.push('print: ' + e.message));
  await p.goto(FILE + '?view=print', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.__deckReady === true, null, { timeout: 60000 });
  const fontsOk = await p.evaluate(() => document.fonts.check('400 100px Newsreader') && document.fonts.check('400 20px Inter'));
  if (!fontsOk) errors.push('Newsreader or Inter did not load (fonts.googleapis.com unreachable?)');
  // On-screen text per slide, for audit-deck.ts: every text node of the final build, line by line.
  const text = await p.evaluate(() => [...document.querySelectorAll('.slide')].map((el) => ({
    n: Number(el.getAttribute('data-n')),
    lines: [...new Set(el.innerText.split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean))],
    svg: [...el.querySelectorAll('svg text')].map((t) => t.textContent.trim()).filter(Boolean),
  })));
  fs.writeFileSync(path.join(OUT, 'deck-text.json'), JSON.stringify(text, null, 1));
  await p.pdf({ path: path.join(OUT, 'masterclass-deck.pdf'), width: '1920px', height: '1080px', printBackground: true, preferCSSPageSize: true });
  console.log(`pdf: ${text.length} pages -> ${path.relative(process.cwd(), path.join(OUT, 'masterclass-deck.pdf'))}`);
  await p.close();
}

// 2. Audience view: step through every slide and build, check the layout, take the screenshots.
if (SHOTS) {
  fs.mkdirSync(path.join(SHOTS, 'all'), { recursive: true });
  fs.mkdirSync(path.join(SHOTS, 'builds'), { recursive: true });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('pageerror', (e) => errors.push('audience: ' + e.message));
  await p.goto(FILE + '?static=1#1', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.__deckReady === true, null, { timeout: 60000 });
  const info = await p.evaluate(() => window.__deck.slides.map((s, i) => ({ i, n: s.n, title: s.title, steps: window.__deck.steps(i) })));
  const warn = [];
  let builds = 0;
  for (const s of info) {
    for (let k = 0; k <= s.steps; k++) {
      builds++;
      await p.evaluate(([i, kk]) => window.__deck.go(i, kk), [s.i, k]);
      if (k === s.steps) {
        // Layout check at the final build: nothing past the slide, nothing on the footer, no headline overflowing.
        const issue = await p.evaluate(() => {
          const el = document.querySelector('.slide:last-child'); const r0 = el.getBoundingClientRect(); const sc = r0.width / 1920;
          const foot = el.querySelector('.foot').getBoundingClientRect().top;
          const out = [];
          for (const x of el.querySelectorAll('.c *, .pane *, .receipt *, .qrbox, .poll *')) {
            if (!x.getClientRects().length || getComputedStyle(x).opacity === '0') continue;
            const r = x.getBoundingClientRect();
            if (r.right > r0.right + 2 || r.left < r0.left - 2) out.push(`off the side: ${x.className || x.tagName} "${(x.textContent || '').slice(0, 40)}"`);
            if (r.bottom > foot - 8 && r.top < foot && !x.closest('.foot') && (x.textContent || '').trim()) out.push(`on the footer: "${(x.textContent || '').trim().slice(0, 40)}" bottom ${Math.round((r.bottom - r0.top) / sc)}`);
          }
          for (const h of el.querySelectorAll('h1, blockquote')) if (h.scrollWidth > h.clientWidth + 4) out.push(`headline wider than its box: "${h.textContent.slice(0, 40)}"`);
          return [...new Set(out)].slice(0, 3);
        });
        if (issue.length) warn.push(`${String(s.n).padStart(3, '0')} ${s.title}: ${issue.join('; ')}`);
        await p.screenshot({ path: path.join(SHOTS, 'all', `${String(s.n).padStart(3, '0')}.png`) });
      }
    }
  }
  console.log(`stepped ${info.length} slides, ${builds} build states`);
  // Key builds, with motion on, after the motion settles.
  const q = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  q.on('pageerror', (e) => errors.push('builds: ' + e.message));
  await q.goto(FILE + '#1', { waitUntil: 'networkidle' });
  await q.waitForFunction(() => window.__deckReady === true, null, { timeout: 60000 });
  let idx = 0;
  for (const [title, kk] of KEY) {
    const s = info.find((x) => x.title === title);
    if (!s) { warn.push(`key build not found: ${title}`); continue; }
    const k = kk < 0 ? s.steps : Math.min(kk, s.steps);
    // From the slide before at its last build, so every build of this one plays; the first slide starts at its own build 0.
    await q.evaluate(([i]) => (i > 0 ? window.__deck.go(i - 1, 99) : window.__deck.go(0, 0)), [s.i]);
    await q.waitForTimeout(200);
    for (let step = s.i > 0 ? 0 : 1; step <= k; step++) { await q.evaluate(() => window.__deck.next()); await q.waitForTimeout(step === k ? 1700 : 650); }
    idx++;
    await q.screenshot({ path: path.join(SHOTS, 'builds', `${String(idx).padStart(2, '0')}-${String(s.n).padStart(3, '0')}-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}-b${k}.png`) });
  }
  // Contact sheets: every final build, 5 across, 30 a sheet.
  const files = fs.readdirSync(path.join(SHOTS, 'all')).filter((f) => f.endsWith('.png')).sort();
  const c = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  for (let sheet = 0; sheet * 30 < files.length; sheet++) {
    const part = files.slice(sheet * 30, sheet * 30 + 30);
    const html = `<html><body style="margin:0;background:#1a1a19;padding:24px;display:grid;grid-template-columns:repeat(5,1fr);gap:14px;font:500 13px Inter,Arial;color:#b3b1ab">${part.map((f) => `<figure style="margin:0"><img src="${pathToFileURL(path.join(SHOTS, 'all', f)).href}" style="width:100%;display:block"><figcaption style="padding:6px 0">${f.replace('.png', '')}</figcaption></figure>`).join('')}</body></html>`;
    const sheetFile = path.join(SHOTS, `contact-${sheet + 1}.html`);
    fs.writeFileSync(sheetFile, html);
    await c.goto(pathToFileURL(sheetFile).href, { waitUntil: 'load' });
    await c.screenshot({ path: path.join(SHOTS, `contact-${sheet + 1}.png`), fullPage: true });
  }
  console.log(`screenshots in ${SHOTS}: ${files.length} slides, ${idx} key builds, ${Math.ceil(files.length / 30)} contact sheets`);
  if (warn.length) console.log('layout warnings:\n  ' + warn.join('\n  '));
}
await b.close();
if (errors.length) { console.log('page errors:\n  ' + errors.join('\n  ')); process.exit(1); }

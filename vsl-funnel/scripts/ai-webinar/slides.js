// Renders the masterclass slides (1920x1080 PNG) from slides.json with the site's look.
const { chromium } = require('playwright');
const fs = require('fs');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const css = `
@import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400..600;1,6..72,400..600&family=Inter:opsz,wght@14..32,400..700&display=swap');
*{box-sizing:border-box;margin:0}
body{width:1920px;height:1080px;background:radial-gradient(1200px 700px at 85% 0%,#1a3a72 0%,rgba(26,58,114,0) 60%),linear-gradient(160deg,#0f2c5c 0%,#0b2149 55%,#08183a 100%);color:#fff;font-family:Inter,Arial,sans-serif;display:flex;flex-direction:column;padding:110px 150px 90px;position:relative;overflow:hidden}
.brand{font:600 26px/1 Newsreader,Georgia,serif;letter-spacing:.2px;opacity:.92}
.chapter{position:absolute;top:116px;right:150px;font:500 22px/1 Inter;letter-spacing:.14em;text-transform:uppercase;color:#a9bbdb}
.main{flex:1;display:flex;flex-direction:column;justify-content:center;max-width:1500px}
h1{font:500 104px/1.04 Newsreader,Georgia,serif;letter-spacing:-1.5px}
h1.long{font-size:80px;line-height:1.08}
h1.xlong{font-size:62px;line-height:1.12}
.sub{margin-top:34px;font:400 40px/1.35 Inter;color:#cdd8ec;max-width:1400px}
.sub.small{font-size:30px}
.on{margin-top:54px;display:flex;flex-direction:column;gap:18px}
.on p{font:500 36px/1.35 Inter;color:#fff;padding:22px 30px;border-left:6px solid #fdd050;background:rgba(255,255,255,.07);border-radius:4px;max-width:1500px}
.foot{display:flex;justify-content:space-between;align-items:flex-end;font:400 22px/1.3 Inter;color:#8fa3c7}
.rule{position:absolute;left:150px;right:150px;bottom:140px;height:1px;background:rgba(255,255,255,.14)}
`;

(async () => {
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  for (const j of jobs) {
    const len = j.title.length;
    const cls = len > 70 ? 'xlong' : len > 38 ? 'long' : '';
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
      <div class="brand">G&amp;L M&amp;A Advisory</div><div class="chapter">${esc(j.chapter)}</div>
      <div class="main"><h1 class="${cls}">${esc(j.title)}</h1>${j.sub ? `<p class="sub${j.sub.length > 140 ? ' small' : ''}">${esc(j.sub)}</p>` : ''}
      ${j.onscreen.length ? `<div class="on">${j.onscreen.map((o) => `<p>${esc(o)}</p>`).join('')}</div>` : ''}</div>
      <div class="rule"></div><div class="foot"><span>${esc(j.footer)}</span><span>Josh Li · JC Health Group · G&amp;L M&amp;A Advisory</span></div></body></html>`;
    await p.setContent(html, { waitUntil: 'networkidle' });
    await p.screenshot({ path: j.file });
  }
  await b.close();
  console.log(`rendered ${jobs.length} slides`);
})();

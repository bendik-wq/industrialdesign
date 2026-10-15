// Generates the 1200×630 link-preview images (X, LinkedIn, iMessage, AI answer cards) for every guide.
// Run: node scripts/og-images.mjs   (needs Playwright + Chromium; reads the guides via a tiny TS strip)
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'public/assets/og');
const list = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const card = (eyebrow, title, foot) => `<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,500&family=Inter:wght@500;600&display=block"><style>
*{box-sizing:border-box;margin:0}body{width:1200px;height:630px;background:#0b1220;color:#f3f5f9;font-family:Inter,sans-serif;padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}
body:before{content:"";position:absolute;inset:0;background:radial-gradient(900px 500px at 85% 10%,rgba(46,92,170,.45),transparent 60%),radial-gradient(700px 400px at 0% 100%,rgba(15,44,92,.6),transparent 60%)}
.top,.t,.foot{position:relative}.top{display:flex;justify-content:space-between;align-items:center;font-size:24px;color:#b7bfcd;letter-spacing:.02em}.logo b{color:#fff;font-weight:600}
.eyebrow{font-size:22px;text-transform:uppercase;letter-spacing:.14em;color:#8fb0e6;margin-bottom:22px;font-weight:600}
.t h1{font-family:Newsreader,serif;font-weight:500;font-size:${title.length > 60 ? 62 : 72}px;line-height:1.06;letter-spacing:-.01em;max-width:1000px}
.foot{display:flex;align-items:center;gap:18px;font-size:24px;color:#b7bfcd}.av{width:56px;height:56px;border-radius:50%;background:#f3f5f9;color:#0b1220;display:grid;place-items:center;font-weight:600;font-size:20px}
</style></head><body><div class="top"><span class="logo"><b>G&amp;L</b> M&amp;A Advisory</span><span>grosfjeld-li.com</span></div>
<div class="t"><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1></div><div class="foot"><span class="av">JL</span><span>${esc(foot)}</span></div></body></html>`;

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pg = await b.newPage({ viewport: { width: 1200, height: 630 } });
const jobs = [
  ...list.map((g) => ({ file: `${g.slug}.png`, html: card(g.section, g.h1, g.host === 'data' ? 'Get paid for your business’s data' : 'By Josh Li · Founder, G&L M&A Advisory') })),
  { file: 'default.png', html: card('No-money-down acquisitions', 'Buy a business with no money down. Signed LOI in 90 days.', 'Josh Li · Founder, G&L M&A Advisory') },
  { file: 'data.png', html: card('Selling your data', 'Get paid up to $2M for data your business already creates.', 'Even if the business has closed') },
];
for (const j of jobs) {
  await pg.setContent(j.html, { waitUntil: 'networkidle' });
  await pg.screenshot({ path: path.join(out, j.file), type: 'png' });
}
// Square logo for structured data (Organization.logo).
await pg.setViewportSize({ width: 512, height: 512 });
await pg.setContent('<body style="margin:0;width:512px;height:512px;background:#0b1220;display:grid;place-items:center;font:600 150px Inter,sans-serif;color:#fff">G&amp;L</body>');
await pg.screenshot({ path: path.join(out, 'logo.png') });
await b.close();
console.log('wrote', jobs.length + 1, 'images');

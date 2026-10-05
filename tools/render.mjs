// Render PNG views of the assembly GLB with headless Chromium.
// usage: node tools/render.mjs  (serves repo root on :8765)
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)(process.env.PW ?? 'playwright');
import { createServer } from 'http';
import { readFile, mkdir } from 'fs/promises';
import { join, extname, resolve } from 'path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const types = { '.html': 'text/html', '.glb': 'model/gltf-binary', '.js': 'text/javascript' };
const srv = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
}).listen(8765);

const views = [
  ['hero', 'az=-35&el=18'],
  ['exploded_internals', 'az=-30&el=25&hide=front_cover,mounting_plate'],
  ['section', 'zoom=0.42&az=90&el=0&hide=mounting_plate&section=1'],
  ['underside', 'az=-25&el=-30'],
  ['rear', 'az=150&el=15'],
];
await mkdir(join(ROOT, 'renders'), { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', m => console.log('page:', m.text()));
for (const [name, qs] of views.filter(v => !process.argv[2] || v[0] === process.argv[2])) {
  await page.goto(`http://localhost:8765/tools/render.html?${qs}`);
  await page.waitForFunction(() => document.title === 'done', null, { timeout: 120000 });
  await page.locator('canvas').screenshot({ path: join(ROOT, 'renders', `${name}.png`) });
  console.log('rendered', name);
}
await browser.close(); srv.close();

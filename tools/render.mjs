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

const SETS = {
  aero1: { src: '../out/AERO-1_assembly.glb', dir: 'renders', views: [
  ['hero', 'az=-35&el=18'],
  ['exploded_internals', 'az=-30&el=25&hide=front_cover,mounting_plate'],
  ['section', 'zoom=0.42&az=90&el=0&hide=mounting_plate&section=1'],
  ['underside', 'az=-25&el=-30'],
  ['rear', 'az=150&el=15'],
  ] },
  sweep1: { src: '../out/sweep1/SWEEP-1_on_row.glb', dir: 'renders/sweep1', views: [
    ['hero', 'az=-145&el=28'],
    ['robot_close', 'zoom=1.1&az=-120&el=40&focus=SWEEP-1_robot'],
    ['side_on_row', 'zoom=0.8&az=-90&el=4'],
  ] },
  ovo1: { src: '../out/ovo1/OVO-1_assembly.glb', dir: 'renders/ovo1', views: [
    ['hero', 'zoom=0.9&az=58&el=14&metal=shell|nozzle|belly|plinth|tray|duct|grille'],
    ['profile', 'zoom=0.85&az=0&el=0&metal=shell|nozzle|belly|plinth|tray|duct|grille'],
    ['tail', 'zoom=0.9&az=128&el=10&metal=shell|nozzle|belly|plinth|tray|duct|grille'],
    ['underside', 'zoom=0.9&az=-30&el=-38&metal=shell|nozzle|belly|plinth|tray|duct|grille'],
    ['section', 'zoom=0.85&az=0&el=8&clip=0,-1,0,0&metal=shell|nozzle|belly|plinth|tray|duct|grille'],
    ['core', 'zoom=0.8&az=-35&el=30&hide=shell_upper,shell_lower,nozzle,light_ring,exhaust_grille,belly_plate,plinth,foot&metal=shell|nozzle|belly|plinth|tray|duct|grille'],
    ['exploded', 'src=../out/ovo1/OVO-1_exploded.glb&zoom=1.0&az=-35&el=12&metal=shell|nozzle|belly|plinth|tray|duct|grille'],
  ] },
};
const set = SETS[process.env.SET ?? 'aero1'];
const views = set.views;
await mkdir(join(ROOT, set.dir), { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('console', m => console.log('page:', m.text()));
for (const [name, qs] of views.filter(v => !process.argv[2] || v[0] === process.argv[2])) {
  const src = new URLSearchParams(qs).get('src') ?? set.src;
  await page.goto(`http://localhost:8765/tools/render.html?${qs}&src=${encodeURIComponent(src)}`);
  await page.waitForFunction(() => document.title === 'done', null, { timeout: 120000 });
  await page.locator('canvas').screenshot({ path: join(ROOT, set.dir, `${name}.png`) });
  console.log('rendered', name);
}
await browser.close(); srv.close();

#!/usr/bin/env node
/**
 * End-to-end smoke suite (Playwright). Run before and after every deploy.
 *
 *   node scripts/smoke/run.mjs --local [port]          # against `wrangler dev --local` (default port 8787)
 *   node scripts/smoke/run.mjs --prod https://apply.grosfjeld-li.com
 *
 * Options: --out <dir> (screenshots + report; default scripts/smoke/out), --only a,b (check names),
 *          --no-seed (local: skip the D1 seed), --headed, --list.
 *
 * --local starts nothing: it expects wrangler dev on the port, signs in to Funnel HQ with ADMIN_PASSWORD
 * (env, or the local .dev.vars), seeds local D1 (seed.mjs) and runs the full flows with fake media.
 * --prod is read-only: GET requests only (every other request is aborted in the browser, except the
 * Funnel HQ sign-in), no form submits, no purchases, no emails, never signs out (that would sign out the
 * team). Funnel HQ checks run only when SMOKE_ADMIN_PASSWORD is set in the environment.
 * Exit code: 0 all passed, 1 a check failed, 2 bad usage / could not start.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

// ───────────── arguments ─────────────
const argv = process.argv.slice(2);
const opt = { mode: null, base: null, out: join(HERE, 'out'), only: null, seed: true, headed: false, list: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const nextVal = () => (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : null);
  if (a === '--local') { opt.mode = 'local'; const p = nextVal(); opt.base = /^https?:/.test(p ?? '') ? p : `http://localhost:${p || process.env.SMOKE_PORT || 8787}`; }
  else if (a === '--prod') { opt.mode = 'prod'; opt.base = nextVal(); }
  else if (a === '--out') opt.out = resolve(nextVal() ?? opt.out);
  else if (a === '--only') opt.only = (nextVal() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--no-seed') opt.seed = false;
  else if (a === '--headed') opt.headed = true;
  else if (a === '--list') opt.list = true;
  else if (/^https?:\/\//.test(a) && opt.mode === 'prod' && !opt.base) opt.base = a;
  else { console.error(`Unknown argument: ${a}`); process.exit(2); }
}
if (!opt.list && (!opt.mode || !opt.base)) {
  console.error('Usage: node scripts/smoke/run.mjs --local [port] | --prod <origin>   (see scripts/smoke/README.md)');
  process.exit(2);
}
if (opt.base) opt.base = opt.base.replace(/\/+$/, '');
const LOCAL = opt.mode === 'local';
if (opt.mode === 'prod' && /localhost|127\.0\.0\.1/.test(opt.base)) console.warn('Note: --prod against a local origin (read-only checks only).');

function adminPassword() {
  if (!LOCAL) return process.env.SMOKE_ADMIN_PASSWORD || null; // prod: only from the environment, never from files
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (process.env.SMOKE_ADMIN_PASSWORD) return process.env.SMOKE_ADMIN_PASSWORD;
  const dv = join(ROOT, '.dev.vars');
  if (existsSync(dv)) { const m = /^ADMIN_PASSWORD\s*=\s*"?([^"\n]*)"?/m.exec(readFileSync(dv, 'utf8')); if (m) return m[1]; }
  return null;
}
const PASSWORD = opt.list ? null : adminPassword();

// ───────────── helpers ─────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN_DIR = join(opt.out, `${opt.mode ?? 'list'}-${stamp}`);
// Third-party trackers never load during a smoke run (no pixels or analytics from a test browser).
const TRACKERS = /facebook\.(net|com)|fbcdn|google-analytics|googletagmanager|doubleclick|posthog|clarity\.ms|tiktok|hotjar|cloudflareinsights|connect\.facebook/;
// Console noise that isn't an app error (media in a sandbox, blocked trackers, aborted writes in prod).
const CONSOLE_NOISE = /Failed to load resource|net::ERR_|ICE|WebTransport|cloudflareinsights|turnstile|favicon|Permissions policy|getUserMedia|NotAllowedError|NotFoundError|WebRTC|RTCPeerConnection|sfu|moq|Realtime/i;

class Fail extends Error {}
const assert = (cond, msg) => { if (!cond) throw new Fail(msg); };

let browser;
let adminState = null; // storage state after one Funnel HQ sign-in (reused, never signed out)

async function launch() {
  let pw;
  try { pw = require('playwright'); } catch {
    console.error('Playwright not found. It is preinstalled in the sandbox; elsewhere: npm i -g playwright && npx playwright install chromium');
    process.exit(2);
  }
  browser = await pw.chromium.launch({
    headless: !opt.headed,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
}

/**
 * A page wired for the smoke run: page errors, failed same-origin responses (5xx), console errors.
 * In prod mode every non-GET request is aborted in the browser (read-only), except the Funnel HQ sign-in.
 */
async function newPage(ctxState, tag, { mobile = false, admin = false } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    permissions: LOCAL ? ['camera', 'microphone'] : [],
    storageState: admin && adminState ? adminState : undefined,
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const log = { tag, pageErrors: [], serverErrors: [], consoleErrors: [], blocked: [], clientErrors: [], apiCalls: 0, pending: 0 };
  const isApi = (r) => r.url().startsWith(opt.base) && /\/(api|admin\/api)\//.test(r.url());
  page.on('request', (r) => { if (isApi(r)) log.pending++; });
  page.on('requestfinished', (r) => { if (isApi(r)) log.pending--; });
  page.on('requestfailed', (r) => { if (isApi(r)) log.pending--; });
  page.on('pageerror', (e) => log.pageErrors.push(String(e.message || e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error' && !CONSOLE_NOISE.test(m.text())) log.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('response', (r) => {
    const u = r.url();
    if (!u.startsWith(opt.base)) return;
    if (/\/(api|admin\/api)\//.test(u)) log.apiCalls++;
    if (r.status() >= 500) log.serverErrors.push(`${r.status()} ${r.request().method()} ${u.slice(opt.base.length)}`);
    else if (r.status() >= 400 && /\/(api|admin\/api)\//.test(u)) log.clientErrors.push(`${r.status()} ${r.request().method()} ${u.slice(opt.base.length)}`);
  });
  await context.route('**/*', (route) => {
    const req = route.request();
    const u = req.url();
    if (TRACKERS.test(new URL(u).host)) return route.abort();
    if (!LOCAL && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      const sameOrigin = u.startsWith(opt.base);
      if (!(sameOrigin && new URL(u).pathname === '/admin/login' && req.method() === 'POST')) { log.blocked.push(`${req.method()} ${sameOrigin ? u.slice(opt.base.length) : u}`); return route.abort(); }
    }
    return route.continue();
  });
  ctxState.pages.push({ page, context, log });
  return { page, context, log };
}

async function signIn() {
  if (adminState) return true;
  if (!PASSWORD) return false;
  const st = { pages: [] };
  const { page, context } = await newPage(st, 'login');
  try {
    await page.goto(`${opt.base}/admin/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[type=password]', PASSWORD);
    await Promise.all([page.waitForURL(/\/admin(\/?|#.*|\?.*)$/, { timeout: 20_000 }).catch(() => null), page.keyboard.press('Enter')]);
    const ok = await page.evaluate(async () => (await fetch('/admin/api/rooms', { credentials: 'same-origin' })).status === 200).catch(() => false);
    if (!ok) throw new Fail(`Funnel HQ sign-in failed (still at ${page.url().slice(opt.base.length)})`);
    adminState = await context.storageState();
    return true;
  } finally { await context.close(); }
}

/** GET a page; fails on a non-2xx document. */
async function open(page, path, { wait = 'load', settle = 800 } = {}) {
  const res = await page.goto(opt.base + path, { waitUntil: wait });
  assert(res, `no response for ${path}`);
  assert(res.status() < 400, `${path} returned ${res.status()}`);
  if (settle) await sleep(settle);
  return res;
}

/** Same-origin JSON from inside a signed-in page (admin APIs). */
async function api(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const r = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* not json */ }
    return { status: r.status, json: j };
  }, { method, path, body });
}

const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
async function waitFor(fn, ms, what) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(400); }
  throw new Fail(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`);
}

// ───────────── checks ─────────────
// Each check: name, modes it runs in, needs ('admin' = Funnel HQ sign-in), and run(ctx) → a short detail string.
const CHECKS = [
  {
    name: 'health', modes: ['local', 'prod'],
    async run(ctx) {
      const { page } = await newPage(ctx, 'health');
      const res = await page.goto(`${opt.base}/health`);
      assert(res && res.status() === 200, `/health returned ${res?.status()}`);
      const j = await res.json().catch(() => null);
      assert(j && j.ok === true, '/health did not return ok:true');
      assert(typeof j.build === 'string' && j.build.length >= 6, '/health has no build id');
      ctx.summary.build = j.build;
      return `build ${j.build}`;
    },
  },
  {
    name: 'home+vsl', modes: ['local', 'prod'],
    async run(ctx) {
      const { page } = await newPage(ctx, 'home');
      await open(page, '/');
      assert(await visible(page, 'h1, .hero h1, [data-headline]'), 'home has no visible headline');
      const videos = await page.locator('video').count();
      assert(videos > 0, 'home has no VSL video element');
      assert(await visible(page, '[data-app] input[name=first_name]'), 'home application form (step 1) not rendered');
      const m = await newPage(ctx, 'home-mobile', { mobile: true });
      await open(m.page, '/');
      const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 2, `home scrolls sideways on a 390px phone (${overflow}px)`);
      return `${videos} video, form step 1, no sideways scroll at 390px`;
    },
  },
  {
    name: 'apply', modes: ['local', 'prod'],
    async run(ctx) {
      const { page } = await newPage(ctx, 'apply');
      await open(page, '/apply');
      await page.waitForSelector('[data-app] input[name=first_name]');
      for (const f of ['last_name', 'email', 'phone']) assert(await visible(page, `[data-app] [name=${f}]`), `step 1 field ${f} missing`);
      const label = (await page.locator('[data-step-label]').innerText().catch(() => '')).trim();
      if (!LOCAL) return `step 1 renders (${label}); read-only, not submitted`;
      // Local: complete the whole application.
      const tag = Date.now().toString(36);
      await page.fill('[name=first_name]', 'Smoke');
      await page.fill('[name=last_name]', 'Tester');
      await page.fill('[name=email]', `smoke+${tag}@example.com`);
      await page.fill('[name=phone]', '+61 412 345 678');
      await page.click('[data-app] button[type=submit]');
      let steps = 1;
      for (let guard = 0; guard < 30; guard++) {
        await sleep(500);
        if (!page.url().includes('/apply')) break;
        const err = await page.evaluate(() => (document.querySelector('[data-app] .form-error') || {}).textContent || '');
        assert(!err, `application error at step ${steps}: ${err}`);
        const step = page.locator('[data-app] .app-step');
        if (!(await step.count())) continue; // "Reviewing your answers…"
        const q = await step.getAttribute('data-q');
        if (q === ctx._lastQ) continue;
        if (await page.locator('[data-app] textarea').count()) {
          await page.fill('[data-app] textarea', 'We run three clinics and want to buy a fourth from an owner who is retiring without a successor.');
          await page.click('[data-app] button[type=submit]');
        } else if (await page.locator('[data-app] .opt[aria-pressed]').count()) {
          await page.locator('[data-app] .opt').first().click();
          await page.click('[data-app] button[type=submit]');
        } else if (await page.locator('[data-app] .opt').count()) {
          const opts = page.locator('[data-app] .opt');
          await opts.nth(Math.min(1, (await opts.count()) - 1)).click();
        } else continue;
        ctx._lastQ = q;
        steps++;
      }
      await page.waitForURL((u) => !u.pathname.startsWith('/apply'), { timeout: 20_000 }).catch(() => null);
      const end = new URL(page.url()).pathname;
      assert(!end.startsWith('/apply'), `application did not finish (stuck at ${label} → step ${steps})`);
      await sleep(1500);
      // The page after the application (the breakout VSL for most answers) renders with its video.
      const vids = await page.locator('video, iframe').count();
      if (end.startsWith('/breakout')) assert(vids > 0, 'the breakout VSL has no video');
      return `completed ${steps} steps → ${end}${vids ? ' (VSL renders)' : ''}`;
    },
  },
  {
    name: 'masterclass', modes: ['local', 'prod'],
    async run(ctx) {
      const { page } = await newPage(ctx, 'masterclass');
      await open(page, '/webinar');
      assert(await visible(page, 'form input[name=first_name]'), 'masterclass registration form missing');
      const times = await page.locator('input[name=session_id]').count();
      assert(times > 0, 'masterclass has no session times to pick');
      if (!(await signIn())) return `registration page (${times} times); room preview skipped (no admin password)`;
      const p = await newPage(ctx, 'masterclass-room', { admin: true });
      await open(p.page, '/webinar/room/preview?hq_preview=1', { settle: 2500 });
      const title = await p.page.title();
      assert(!/not found|expired/i.test(title), `room preview shows "${title}"`);
      assert((await p.page.locator('video, [data-player], .player, iframe').count()) > 0, 'room preview has no player');
      return `registration page (${times} times) + room preview`;
    },
  },
  {
    name: 'live', modes: ['local', 'prod'],
    async run(ctx) {
      const { page } = await newPage(ctx, 'live');
      await open(page, '/live');
      assert(await visible(page, 'h1'), '/live has no headline');
      const form = await visible(page, 'form[data-live-register]');
      if (LOCAL) assert(form, 'live registration form missing (seeded session expected)');
      return form ? 'landing + registration form' : 'landing (no session scheduled)';
    },
  },
  {
    name: 'challenge', modes: ['local', 'prod'],
    async run(ctx) {
      const { page } = await newPage(ctx, 'challenge');
      await open(page, '/challenge');
      assert(await visible(page, 'h1'), '/challenge has no headline');
      const form = await visible(page, 'form[data-ch-register]');
      if (LOCAL) assert(form, 'challenge registration form missing (seeded cohort expected)');
      return form ? 'landing + registration form' : 'landing (no cohort open)';
    },
  },
  {
    name: 'camera-test', modes: ['local', 'prod'],
    async run(ctx) {
      const { page } = await newPage(ctx, 'camera-test');
      await open(page, '/camera-test');
      const btn = page.locator('button', { hasText: /start/i }).first();
      assert(await btn.isVisible().catch(() => false), 'camera check has no Start button');
      if (!LOCAL) return 'page loads (not started: it posts results)';
      await btn.click();
      await sleep(8000);
      return 'page loads; check started with a fake camera';
    },
  },
  {
    name: 'hq-tabs', modes: ['local', 'prod'], needs: 'admin',
    async run(ctx) {
      const { page, log } = await newPage(ctx, 'hq', { admin: true });
      await open(page, '/admin', { settle: 1500 });
      const src = await (await page.request.get(`${opt.base}/assets/admin.js`)).text();
      const block = src.slice(src.indexOf('var TABS = {'));
      const tabs = [...block.slice(0, block.indexOf('\n  };')).matchAll(/^ {4}([a-z0-9_]+): \{/gm)].map((m) => m[1]);
      assert(tabs.length > 5, `could not read TABS from admin.js (${tabs.length})`);
      const bad = [];
      const times = [];
      const readOnlyLimited = [];
      for (const t of tabs) {
        const before = { pe: log.pageErrors.length, se: log.serverErrors.length, bl: log.blocked.length };
        const t0 = Date.now();
        await page.evaluate((t) => { location.hash = '#' + t; }, t);
        // Settled: no same-origin API call in flight for a moment (max 12s; some tabs poll).
        await sleep(300);
        for (let quiet = 0, until = Date.now() + 12_000; quiet < 3 && Date.now() < until; await sleep(200)) quiet = log.pending > 0 ? 0 : quiet + 1;
        const { text, kids } = await page.evaluate(() => { const v = document.querySelector('[data-view]') || document.body; return { text: v.innerText.slice(0, 4000), kids: v.children.length }; });
        times.push(`${t} ${Date.now() - t0}ms`);
        const errs = [...log.pageErrors.slice(before.pe), ...log.serverErrors.slice(before.se)];
        if (!kids || !text.trim()) errs.push('the view rendered nothing');
        if (/Couldn.t load this view/i.test(text)) errs.push(`view error: ${(/Couldn.t load this view\.?\s*([^\n]*)/i.exec(text) || [])[1] || ''}`);
        // Prod is read-only: a tab whose only problem is that its own write (a preview, a ping) was blocked is a note, not a failure.
        const blockedHere = log.blocked.slice(before.bl);
        if (!LOCAL && blockedHere.length && errs.length && errs.every((e) => /Failed to fetch/i.test(e))) {
          readOnlyLimited.push(`${t} (needs ${blockedHere.join(', ')})`);
          continue;
        }
        if (errs.length) {
          bad.push(`${t}: ${errs.join(' | ').slice(0, 300)}`);
          await page.screenshot({ path: join(RUN_DIR, `hq-${t}.png`), fullPage: false }).catch(() => null);
        }
      }
      ctx.summary.tabTimes = times;
      log.pageErrors.length = 0; log.serverErrors.length = 0; // reported per tab below
      assert(!bad.length, `${bad.length}/${tabs.length} tabs failed:\n      ${bad.join('\n      ')}`);
      return `${tabs.length} tabs, no page errors, no 5xx${readOnlyLimited.length ? `; ${readOnlyLimited.length} only partly checked read-only: ${readOnlyLimited.join('; ')}` : ''}`;
    },
  },
  {
    name: 'webinar-room', modes: ['local'], needs: 'admin',
    async run(ctx) {
      const host = await newPage(ctx, 'host', { admin: true });
      await open(host.page, '/admin', { settle: 300 });
      const made = await api(host.page, 'POST', '/admin/api/rooms', { mode: 'webinar', title: `Smoke webinar ${stamp}` });
      const id = made.json?.room?.id;
      assert(made.status === 200 && id, `could not create a webinar room (${made.status} ${JSON.stringify(made.json).slice(0, 120)})`);
      const adm = await api(host.page, 'POST', `/admin/api/rooms/${id}/admission`, { on: true });
      let joinUrl = adm.json?.admission?.url;
      if (!joinUrl) joinUrl = (await api(host.page, 'POST', `/admin/api/rooms/${id}/links`, {})).json?.admission?.url;
      assert(joinUrl, 'no general admission link');
      // Host joins and goes live.
      await open(host.page, `/admin/rooms/${id}`, { settle: 1500 });
      await host.page.click('[data-join]');
      await host.page.waitForSelector('[data-stage]', { timeout: 20_000 });
      await host.page.click('[data-golive]', { timeout: 10_000 });
      await waitFor(() => host.page.locator('[data-live]').isVisible(), 10_000, 'the room to go live');
      // Attendee joins on a phone through the general admission link.
      const att = await newPage(ctx, 'attendee', { mobile: true });
      await att.page.goto(joinUrl.replace(/^https?:\/\/[^/]+/, opt.base));
      await att.page.fill('input[name=first_name]', 'Avery');
      if (await att.page.locator('input[name=email]').count()) await att.page.fill('input[name=email]', `smoke+att-${Date.now().toString(36)}@example.com`);
      await Promise.all([att.page.waitForNavigation({ timeout: 15_000 }).catch(() => null), att.page.click('form button[type=submit]')]);
      // A watcher gets "Enter the room"; someone invited on stage gets the camera check (join without camera).
      await att.page.waitForSelector('[data-enter], [data-join-none]', { timeout: 15_000 });
      await att.page.click('[data-enter], [data-join-none]');
      await att.page.waitForSelector('[data-stage]', { timeout: 20_000 });
      // The host sees the attendee, then pushes to everyone.
      await host.page.click('[data-tab=push]');
      await host.page.waitForSelector('[data-push]', { timeout: 10_000 });
      const enabled = await host.page.$$eval('[data-push]:not([disabled])', (bs) => bs.map((b) => b.getAttribute('data-push')));
      assert(enabled.length, 'no push button is enabled for the host');
      const kind = enabled.includes('application') ? 'application' : enabled[0];
      await host.page.click(`[data-push=${kind}]:not([disabled])`);
      await waitFor(() => att.page.locator('[data-cards] .rm-card').isVisible(), 12_000, `the ${kind} push to reach the attendee`);
      const cardText = (await att.page.locator('[data-cards] .rm-card .rm-card-h').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 60);
      // The automatic pushes list renders (staff).
      await host.page.click('[data-tab=push]');
      await waitFor(async () => (await host.page.locator('.rm-push ul.rm-auto li').count()) > 0 || /automatic/i.test(await host.page.locator('.rm-push').innerText()), 8000, 'the automatic pushes list');
      const autos = await host.page.locator('.rm-push ul.rm-auto li').count();
      await host.page.screenshot({ path: join(RUN_DIR, 'webinar-host.png') }).catch(() => null);
      await att.page.screenshot({ path: join(RUN_DIR, 'webinar-attendee.png') }).catch(() => null);
      return `room ${id}: host live, attendee via GA link, ${kind} push shown ("${cardText}"), ${autos} automatic pushes listed`;
    },
  },
  {
    name: 'meeting-room', modes: ['local'], needs: 'admin',
    async run(ctx) {
      const { SEED } = await import('./seed.mjs');
      const host = await newPage(ctx, 'meet-host', { admin: true });
      await open(host.page, '/admin', { settle: 300 });
      const made = await api(host.page, 'POST', '/admin/api/rooms', { mode: 'meeting', kind: 'other', lead_id: SEED.leadId, email: false, title: `Smoke meeting ${stamp}` });
      const id = made.json?.room?.id;
      assert(made.status === 200 && id && made.json.guestUrl, `could not create a meeting room (${made.status} ${JSON.stringify(made.json).slice(0, 160)})`);
      await open(host.page, `/admin/rooms/${id}`, { settle: 1000 });
      await host.page.click('[data-join]');
      await host.page.waitForSelector('[data-stage]', { timeout: 20_000 });
      const guest = await newPage(ctx, 'meet-guest', { mobile: true });
      await guest.page.goto(made.json.guestUrl.replace(/^https?:\/\/[^/]+/, opt.base));
      await guest.page.waitForSelector('[data-join]', { timeout: 15_000 });
      await guest.page.click('[data-join]');
      await guest.page.waitForSelector('[data-stage]', { timeout: 20_000 });
      const tiles = (p) => p.$$eval('[data-stage] .rm-tile', (ts) => ts.map((t) => t.getAttribute('data-tile')));
      await waitFor(async () => (await tiles(host.page)).length >= 2 && (await tiles(guest.page)).length >= 2, 15_000, 'both participants to see two tiles');
      const h = await tiles(host.page), g = await tiles(guest.page);
      await host.page.screenshot({ path: join(RUN_DIR, 'meeting-host.png') }).catch(() => null);
      return `room ${id}: host sees ${h.length} tiles, guest sees ${g.length} (signalling only, no real media)`;
    },
  },
];

// ───────────── runner ─────────────
async function main() {
  const selected = CHECKS.filter((c) => c.modes.includes(opt.mode ?? 'local') && (!opt.only || opt.only.includes(c.name)));
  if (opt.list) { for (const c of CHECKS) console.log(`${c.name.padEnd(14)} ${c.modes.join('+')}${c.needs ? ' (needs Funnel HQ sign-in)' : ''}`); return 0; }
  console.log(`Smoke ${opt.mode} → ${opt.base}${LOCAL ? '' : '  (read-only)'}`);
  // Reachability first: a clear message instead of N timeouts.
  try { const r = await fetch(`${opt.base}/health`); if (!r.ok) throw new Error(`HTTP ${r.status}`); }
  catch (e) { console.error(`Cannot reach ${opt.base}/health (${e.message}).${LOCAL ? ' Start it: npx wrangler dev --local --port <port>' : ''}`); return 2; }
  mkdirSync(RUN_DIR, { recursive: true });
  console.log(`Output: ${RUN_DIR}\n`);
  if (LOCAL && opt.seed) {
    const t0 = Date.now();
    try { (await import('./seed.mjs')).seedLocal({ cwd: ROOT }); console.log(`Seeded local D1 (${Date.now() - t0}ms)`); }
    catch (e) { console.error(`Seeding local D1 failed: ${String(e.message).slice(0, 300)}`); return 2; }
  }
  await launch();
  const summary = {};
  const results = [];
  for (const c of selected) {
    const ctx = { pages: [], summary };
    const t0 = Date.now();
    let status = 'PASS', detail = '';
    try {
      if (c.needs === 'admin' && !(await signIn())) { status = 'SKIP'; detail = LOCAL ? 'no ADMIN_PASSWORD (env or .dev.vars)' : 'SMOKE_ADMIN_PASSWORD not set'; }
      else {
        detail = (await c.run(ctx)) || '';
        const pe = ctx.pages.flatMap((p) => p.log.pageErrors.map((e) => `${p.log.tag}: ${e}`));
        const se = ctx.pages.flatMap((p) => p.log.serverErrors.map((e) => `${p.log.tag}: ${e}`));
        if (pe.length || se.length) throw new Fail([...pe.map((e) => `page error ${e}`), ...se.map((e) => `server error ${e}`)].join('\n      '));
      }
    } catch (e) {
      status = 'FAIL';
      detail = e instanceof Fail ? e.message : `${e.name}: ${String(e.message).split('\n')[0]}`;
      const pe = ctx.pages.flatMap((p) => p.log.pageErrors.map((x) => `${p.log.tag}: ${x}`));
      if (pe.length && !detail.includes('page error')) detail += `\n      page errors: ${pe.slice(0, 5).join(' | ')}`;
      for (const [i, p] of ctx.pages.entries()) await p.page.screenshot({ path: join(RUN_DIR, `${c.name}-${i}-${p.log.tag}.png`) }).catch(() => null);
    }
    const notes = ctx.pages.flatMap((p) => [...p.log.consoleErrors.map((x) => `console (${p.log.tag}): ${x}`), ...p.log.clientErrors.map((x) => `api ${x} (${p.log.tag})`), ...p.log.blocked.map((x) => `blocked write (${p.log.tag}): ${x}`)]);
    for (const p of ctx.pages) await p.context.close().catch(() => null);
    const ms = Date.now() - t0;
    results.push({ name: c.name, status, ms, detail, notes });
    console.log(`${status === 'PASS' ? '✓' : status === 'SKIP' ? '–' : '✗'} ${c.name.padEnd(14)} ${String(ms).padStart(6)}ms  ${detail}`);
  }
  await browser.close();

  // The table.
  const w = Math.max(...results.map((r) => r.name.length), 5);
  const line = `+${'-'.repeat(w + 2)}+------+---------+`;
  const out = [line, `| ${'check'.padEnd(w)} | res  |    time |`, line, ...results.map((r) => `| ${r.name.padEnd(w)} | ${r.status} | ${(r.ms / 1000).toFixed(1).padStart(6)}s |`), line];
  const failed = results.filter((r) => r.status === 'FAIL');
  const total = results.reduce((a, r) => a + r.ms, 0);
  out.push(`${results.length - failed.length - results.filter((r) => r.status === 'SKIP').length} passed, ${failed.length} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped in ${(total / 1000).toFixed(1)}s${summary.build ? ` · build ${summary.build}` : ''}`);
  for (const r of failed) out.push(`\nFAIL ${r.name}: ${r.detail}`);
  const noteLines = results.flatMap((r) => r.notes.slice(0, 8).map((n) => `  ${r.name}: ${n}`));
  if (noteLines.length) out.push('\nNotes (not failures):', ...noteLines);
  console.log('\n' + out.join('\n'));
  writeFileSync(join(RUN_DIR, 'report.json'), JSON.stringify({ mode: opt.mode, base: opt.base, at: new Date().toISOString(), build: summary.build ?? null, results, tabTimes: summary.tabTimes ?? [] }, null, 2));
  writeFileSync(join(RUN_DIR, 'report.txt'), out.join('\n') + '\n');
  if (failed.length) console.log(`\nScreenshots and report: ${RUN_DIR}`);
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code), async (e) => { console.error('Smoke runner crashed:', e); await browser?.close().catch(() => null); process.exit(2); });

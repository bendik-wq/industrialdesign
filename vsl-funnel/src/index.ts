import { Hono, type MiddlewareHandler } from 'hono';
import { type AppEnv, type Runtime, publicOrigin, runtimeFrom } from './app';
import { isAdmin, login, logout, requireAdmin, sameOriginWrite } from './admin/auth';
import type { Env } from './env';
import { indexNowKeyFile, logCrawler } from './seo/tracking';
import { aboutPage, guideMarkdownPage, guidePage, guidesHub, llmsFullRoute, llmsRoute, robotsRoute, sitemapRoute } from './seo/pages';
import { isShortUrl, shortPage, applyPage, bookPage, breakoutPage, landerPage, landingPage, resourcesPage, staticPage } from './funnel/pages';
import { processEmailQueue } from './integrations/email';
import { retryForwards } from './tracking/forward';
import { resolveVisitor } from './lib/identity';
import { admin } from './routes/admin';
import { api } from './routes/api';
import { hooks } from './routes/hooks';
import { links } from './routes/links';
import { loadSettings } from './settings';
import { loadReps } from './sales/reps';
import { pingUpcomingCalls } from './sales/outcomes';
import { maybeSendDigest } from './sales/digest';
import { processCallQueue } from './integrations/elevenlabs';
import { syncInbound } from './integrations/elevenlabs-inbound';
import { syncCalendly } from './integrations/calendly';
import { processTriggers } from './personalize/triggers';
import { purgeOld } from './lib/retention';
import { dataLanding, isDataHost } from './data/data';
import { maybeSyncContent } from './content/content';
import { applyHandoff, icsFile, isWebinarHost, registeredPage, roomPage, webinarLanding } from './webinar/pages';
import { ensureSessions } from './webinar/webinar';
import { processSmsQueue } from './integrations/sms';
import { alertUnconfirmedBookings } from './integrations/booking';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  const [settings, reps] = await Promise.all([loadSettings(c.env), loadReps(c.env)]);
  c.set('settings', settings);
  c.set('reps', reps);
  logCrawler(c); // which AI assistants / search engines read which pages (Funnel HQ → Search & AI)
  await next();
  // Pages that may be indexed set their own x-robots-tag (see render / seo.ts); everything else is noindex.
  if (!c.res.headers.has('x-robots-tag')) c.header('x-robots-tag', 'noindex, nofollow');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
  c.header('x-content-type-options', 'nosniff');
  if (new URL(c.req.url).protocol === 'https:') c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  if (c.req.path.startsWith('/admin') || c.req.path.startsWith('/u/')) {
    c.header('x-frame-options', 'DENY');
    // The dashboard loads only its own scripts; nothing a lead typed can run here even if it slipped past escaping.
    if (c.req.path === '/admin' || c.req.path.startsWith('/u/'))
      c.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  }
});

app.get('/health', (c) => c.json({ ok: true }));
// Video files with HTTP Range support (static assets answer every request with the
// whole file, and Safari/iOS won't play an MP4 without 206 partial responses).
app.on(['GET', 'HEAD'], '/media/:file{[\\w.-]+\\.(mp4|webm|jpg)}', async (c) => {
  const asset = await c.env.ASSETS.fetch(new Request(new URL(`/assets/media/${c.req.param('file')}`, c.req.url)));
  if (!asset.ok) return c.notFound();
  const type = asset.headers.get('content-type') ?? 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400' };
  const buf = await asset.arrayBuffer();
  const size = buf.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '');
  const head = c.req.method === 'HEAD';
  if (!m || (!m[1] && !m[2])) return new Response(head ? null : buf, { status: 200, headers: { ...headers, 'content-length': String(size) } });
  let start = m[1] ? Number(m[1]) : size - Number(m[2]);
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  start = Math.max(0, start);
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  return new Response(head ? null : buf.slice(start, end + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
});
// ── Search + AI search: robots.txt (AI crawlers named), sitemap, llms.txt (per host) ──
app.get('/robots.txt', robotsRoute);
app.get('/sitemap.xml', sitemapRoute);
app.get('/llms.txt', llmsRoute);
app.get('/llms-full.txt', llmsFullRoute);
app.get('/:file{[a-f0-9]{32}\\.txt}', indexNowKeyFile);

// ── Funnel pages (server-side page view + per-visitor rendering) ──
const withVisitor: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('visitor', await resolveVisitor(c, 'page'));
  await next();
  c.header('x-frame-options', 'SAMEORIGIN');
};
// ── Webinar (own host: live.yourdomain.com; or /webinar on the main domain) ──
app.use('*', async (c, next) => {
  // On the webinar host, funnel and admin pages belong on the main domain.
  if (isWebinarHost(c) && /^\/(apply|book|breakout|resources|for|m|admin|privacy|guides|about)(\/|$)/.test(c.req.path)) {
    const main = (c.get('settings').PUBLIC_URL || '').replace(/\/+$/, '');
    if (main) return c.redirect(`${main}${c.req.path}${new URL(c.req.url).search}`, 302);
  }
  await next();
});
// ── Data-buyer page (own host: data.yourdomain.com; or /data on the main domain) ──
app.use('*', async (c, next) => {
  if (isDataHost(c) && /^\/(apply|book|breakout|resources|for|m|admin|webinar|registered|room|replay|w|about)(\/|$)/.test(c.req.path)) {
    const main = (c.get('settings').PUBLIC_URL || '').replace(/\/+$/, '');
    if (main) return c.redirect(`${main}${c.req.path}${new URL(c.req.url).search}`, 302);
  }
  await next();
});
app.get('/', withVisitor, (c) => (isDataHost(c) ? dataLanding(c) : isWebinarHost(c) ? webinarLanding(c) : landingPage(c)));
app.get('/data', withVisitor, (c) => dataLanding(c));
app.get('/data/:headline', withVisitor, (c) => dataLanding(c, c.req.param('headline')));
app.get('/webinar', withVisitor, webinarLanding);
for (const prefix of ['', '/webinar']) {
  app.get(`${prefix}/registered/:token`, withVisitor, registeredPage);
  app.get(`${prefix}/room/:token`, withVisitor, (c) => roomPage(c, false));
  app.get(`${prefix}/replay/:token`, withVisitor, (c) => roomPage(c, true));
  app.get(`${prefix}/ics/:token`, icsFile);
}
app.get('/w/:token', withVisitor, applyHandoff);
app.get('/guides', withVisitor, guidesHub);
app.get('/guides/:file{[a-z0-9-]+\\.md}', guideMarkdownPage);
app.get('/guides/:slug{[a-z0-9-]+}', withVisitor, guidePage);
app.get('/about', withVisitor, (c) => (isDataHost(c) || isWebinarHost(c) ? c.notFound() : aboutPage(c)));
app.get('/for/:industry', withVisitor, landerPage);
app.get('/for/:industry/:angle', withVisitor, landerPage);
app.get('/m', withVisitor, landerPage);
app.get('/apply', withVisitor, applyPage);
app.get('/book', withVisitor, bookPage);
app.get('/breakout', withVisitor, breakoutPage);
app.get('/resources', withVisitor, resourcesPage);
app.get('/privacy', withVisitor, staticPage('/privacy.html', 'Privacy policy'));

// ── Public APIs, tracked links, webhooks ──
app.route('/api', api);
app.route('/hooks', hooks);
app.route('/', links);

// ── PostHog reverse proxy (first-party, so session replay survives ad blockers) ──
app.all('/ph/*', async (c) => {
  const host = (c.get('settings').POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/ph/, '');
  // Only what the PostHog browser SDK needs, only to PostHog: not a general-purpose relay.
  if (!['GET', 'POST'].includes(c.req.method) || !/^\/(static|e|i|s|decide|flags|batch|capture|engage|track)(\/|$)/.test(path)) return c.notFound();
  if (!/^https:\/\/[\w-]+(\.i)?\.posthog\.com$/.test(host)) return c.notFound();
  const upstream = path.startsWith('/static/') ? host.replace('.i.posthog.com', '-assets.i.posthog.com') : host;
  const headers = new Headers();
  for (const h of ['content-type', 'content-encoding', 'accept', 'accept-encoding', 'user-agent', 'origin']) { const v = c.req.header(h); if (v) headers.set(h, v); }
  headers.set('x-forwarded-for', c.req.header('cf-connecting-ip') ?? '');
  const res = await fetch(`${upstream}${path}${url.search}`, { method: c.req.method, headers, body: c.req.method === 'GET' ? undefined : c.req.raw.body });
  const out = new Response(res.body, res);
  out.headers.delete('set-cookie');
  return out;
});

// ── Dashboard ──
app.get('/admin/login', async (c) => {
  if (await isAdmin(c)) return c.redirect('/admin', 302);
  return c.env.ASSETS.fetch(new Request(new URL('/admin/login.html', c.req.url)));
});
app.post('/admin/login', async (c) => {
  if (!sameOriginWrite(c)) return c.text('Forbidden', 403);
  const body = await c.req.parseBody();
  const res = await login(c, body.password);
  if (res.ok) return c.redirect('/admin', 302);
  return c.redirect(`/admin/login?error=${encodeURIComponent(res.error ?? 'Login failed')}`, 302);
});
app.post('/admin/logout', async (c) => {
  if (!sameOriginWrite(c)) return c.text('Forbidden', 403);
  await logout(c);
  return c.redirect('/admin/login', 302);
});
app.route('/admin/api', admin);
app.get('/admin', requireAdmin, async (c) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL('/admin/index.html', c.req.url)));
  return new Response(res.body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
});

// ── Short URLs for every split-test page: /loi, /dental, /dental/competitor; data.yourdomain.com/recap ──
// Last, so every real route above wins; anything that isn't a known page still 404s.
const knownShort: MiddlewareHandler<AppEnv> = async (c, next) => {
  const where = isDataHost(c) ? 'data' : isWebinarHost(c) ? 'webinar' : 'main';
  if (!isShortUrl(where, c.req.param('industry') ?? '', c.req.param('angle'))) return c.notFound(); // before any tracking
  await next();
};
app.get('/:industry{[a-z][a-z0-9-]{1,30}}', knownShort, withVisitor, (c) => (isDataHost(c) ? dataLanding(c, c.req.param('industry')) : shortPage(c)));
app.get('/:industry{[a-z][a-z0-9-]{1,30}}/:angle{[a-z]{2,20}}', knownShort, withVisitor, shortPage);

app.notFound((c) => c.text('Not found', 404));
app.onError((err, c) => {
  console.error('unhandled', err);
  return c.text('Something went wrong', 500);
});

export default {
  fetch: app.fetch,

  /** Every 5 minutes: send due emails, retry tracking, ping reps before calls, post the daily sales digest, place AI calls. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const [settings, reps] = await Promise.all([loadSettings(env), loadReps(env)]);
    const rt: Runtime = {
      env,
      settings,
      reps,
      origin: publicOrigin(settings, 'https://example.com'),
      waitUntil: (p) => ctx.waitUntil(p.catch((e) => console.error('background task failed', e))),
    };
    if (!settings.PUBLIC_URL) console.warn('PUBLIC_URL is not set — email links will point at example.com');
    const quiet = <T,>(p: Promise<T>, label: string) => p.catch((e) => { console.error(`${label} failed`, e); return null; });
    const [result, retried, pinged, digest, calls, callbacks, calSync, triggers, purged] = await Promise.all([
      processEmailQueue(rt),
      retryForwards(rt),
      quiet(pingUpcomingCalls(rt), 'call pings'),
      quiet(maybeSendDigest(rt), 'daily digest'),
      quiet(processCallQueue(rt), 'AI calls'),
      quiet(syncInbound(rt), 'AI callbacks'),
      quiet(syncCalendly(rt), 'Calendly sync'),
      quiet(processTriggers(rt), 'behaviour triggers'),
      quiet(purgeOld(rt), 'retention purge'),
      quiet(alertUnconfirmedBookings(rt), 'unconfirmed bookings'),
      quiet(ensureSessions(rt), 'webinar sessions'),
      quiet(maybeSyncContent(rt), 'content sync'),
      quiet(processSmsQueue(rt), 'SMS'),
    ]);
    if (calls && (calls.dialed || calls.synced)) console.log('AI calls', calls);
    if (callbacks) console.log('AI callbacks processed', callbacks);
    if (calSync) console.log('Calendly sync', calSync);
    if (triggers?.queued) console.log('behaviour emails queued', triggers);
    if (pinged) console.log('call pings', pinged);
    if (digest) console.log('daily digest sent');
    if (purged && (purged.events || purged.sessions)) console.log('retention purge', purged);
    if (result.due) console.log('email queue', result);
    if (retried.due) console.log('tracking retries', retried);
  },
} satisfies ExportedHandler<Env>;

export { runtimeFrom };

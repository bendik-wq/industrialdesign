import { Hono, type MiddlewareHandler } from 'hono';
import { maybeSyncMetaSpend } from './integrations/meta-ads';
import { type AppEnv, type Runtime, publicOrigin, runtimeFrom } from './app';
import { isAdmin, login, logout, requireAdmin, sameOriginWrite } from './admin/auth';
import type { Env } from './env';
import { indexNowKeyFile, logCrawler } from './seo/tracking';
import { aboutPage, guideMarkdownPage, guidePage, guidesHub, llmsFullRoute, llmsRoute, robotsRoute, sitemapRoute } from './seo/pages';
import { isShortUrl, shortPage, applyPage, bookPage, breakoutPage, landerPage, landingPage, resourcesPage, staticPage } from './funnel/pages';
import { processEmailQueue } from './integrations/email';
import { retryForwards } from './tracking/forward';
import { COOKIE, resolveVisitor } from './lib/identity';
import { getCookie } from 'hono/cookie';
import { admin } from './routes/admin';
import { liveHostPage } from './live/admin';
import { liveStatusRoute } from './live/routes';
import { api } from './routes/api';
import { hooks } from './routes/hooks';
import { links } from './routes/links';
import { loadSettings, saveSettings } from './settings';
import { googleExchange } from './content/video-pack';
import { verifyToken } from './lib/crypto';
import { getSecret } from './lib/secret';
import { loadReps } from './sales/reps';
import { pingUpcomingCalls } from './sales/outcomes';
import { maybeSendDigest } from './sales/digest';
import { processCallQueue } from './integrations/elevenlabs';
import { syncInbound } from './integrations/elevenlabs-inbound';
import { syncCalendly } from './integrations/calendly';
import { processTriggers } from './personalize/triggers';
import { purgeOld } from './lib/retention';
import { markInternal, sweepBots } from './lib/traffic-quality';
import { sign } from './routes/sign';
import { processContractReminders } from './sales/contracts';
import { maybeSyncContent } from './content/content';
import { blueprintPage } from './webinar/blueprint';
import { applyHandoff, icsFile, isWebinarHost, packPage, packSubmit, registeredPage, roomPage, ticketPage, webinarLanding, worksheetPage } from './webinar/pages';
import { ensureSessions } from './webinar/webinar';
import { dealSprintPage, dealSprintSubmit } from './webinar/deal-sprint';
import { processDealSprintEmails } from './webinar/deal-sprint-emails';
import { notesPage } from './webinar/experience';
import { offerPage } from './webinar/sprint-page';
import { sprintStartPage, sprintStartSubmit } from './webinar/sprint-start';
import { chapters } from './webinar/room';
import { processSmsQueue } from './integrations/sms';
import { alertUnconfirmedBookings } from './integrations/booking';
import { guaranteePage, liveLanding, liveRoom, liveTicketPage, liveWelcome, liveWorksheet } from './live/pages';
import { processLiveMessages } from './live/events';
import { payPage } from './sales/pay-page';

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
  // Funnel pages run inline Pixel/PostHog/Clarity, so a script-src CSP isn't practical, but these two
  // directives cost nothing and block the worst primitives (<base> hijack, <object>/<embed> injection)
  // if a slot ever regresses. Only set when the page didn't already send its own CSP.
  if (!c.res.headers.has('content-security-policy')) c.header('content-security-policy', "object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
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
// Apple Pay domain verification for Whop's payment form (Apple Pay and Google Pay on our own pages).
app.get('/.well-known/apple-developer-merchantid-domain-association', (c) => c.env.ASSETS.fetch(new Request(new URL('/.well-known/apple-developer-merchantid-domain-association', c.req.url))));
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
// The data-partner page is retired: its old address (data.<domain>) sends everyone to the main page.
app.use('*', async (c, next) => {
  if (new URL(c.req.url).host.startsWith('data.')) {
    const main = (c.get('settings').PUBLIC_URL || '').replace(/\/+$/, '');
    if (main) return c.redirect(`${main}/`, 301);
    return c.notFound();
  }
  await next();
});
app.get('/', withVisitor, (c) => (isWebinarHost(c) ? webinarLanding(c) : landingPage(c)));
app.get('/data', (c) => c.redirect('/', 301));
app.get('/webinar', withVisitor, webinarLanding);
for (const prefix of ['', '/webinar']) {
  app.get(`${prefix}/registered/:token`, withVisitor, registeredPage);
  app.get(`${prefix}/ticket/:token`, withVisitor, ticketPage);
  app.get(`${prefix}/room/:token`, withVisitor, (c) => roomPage(c, false));
  app.get(`${prefix}/replay/:token`, withVisitor, (c) => roomPage(c, true));
  app.get(`${prefix}/ics/:token`, icsFile);
  app.get(`${prefix}/worksheet/:token`, withVisitor, worksheetPage);
  app.get(`${prefix}/notes/:token`, withVisitor, (c) => notesPage(c, chapters(runtimeFrom(c))));
  app.get(`${prefix}/blueprint/:token`, withVisitor, blueprintPage);
  app.get(`${prefix}/pack/:token`, withVisitor, packPage);
  app.post(`${prefix}/pack/:token`, withVisitor, packSubmit);
  app.get(`${prefix}/sprint/:token`, withVisitor, dealSprintPage);
  app.post(`${prefix}/sprint/:token`, withVisitor, dealSprintSubmit);
  app.get(`${prefix}/offer/:token`, withVisitor, offerPage); // the First Deal Sprint's sales page (after the unlock, until the replay closes)
  // Pay-first Sprint: a short form about the business (same gate as checkout), then straight to checkout.
  app.get(`${prefix}/sprint-start/:token`, withVisitor, sprintStartPage);
  app.post(`${prefix}/sprint-start/:token`, withVisitor, sprintStartSubmit);
}
app.get('/w/:token', withVisitor, applyHandoff);
// ── Live webinar funnel (on the webinar host and the main domain) and the engagement deposit ──
app.get('/live', withVisitor, liveLanding);
app.get('/live/room/:token', withVisitor, liveRoom);
app.get('/live/ticket/:token', withVisitor, liveTicketPage);
app.get('/live/welcome/:token', withVisitor, liveWelcome);
app.get('/live/worksheet/:token', withVisitor, liveWorksheet);
app.get('/guarantee', withVisitor, guaranteePage);
app.get('/pay/:ref', withVisitor, payPage);
app.get('/guides', withVisitor, guidesHub);
app.get('/guides/:file{[a-z0-9-]+\\.md}', guideMarkdownPage);
app.get('/guides/:slug{[a-z0-9-]+}', withVisitor, guidePage);
app.get('/about', withVisitor, (c) => (isWebinarHost(c) ? c.notFound() : aboutPage(c)));
app.get('/for/:industry', withVisitor, landerPage);
app.get('/for/:industry/:angle', withVisitor, landerPage);
app.get('/m', withVisitor, landerPage);
app.get('/apply', withVisitor, applyPage);
app.get('/book', withVisitor, bookPage);
app.get('/breakout', withVisitor, breakoutPage);
app.get('/resources', withVisitor, resourcesPage);
app.get('/privacy', withVisitor, staticPage('/privacy.html', 'Privacy policy'));

// ── Public APIs, tracked links, webhooks ──
app.route('/sign', sign);
app.get('/api/live/:key/status', liveStatusRoute); // before /api: no visitor logging on each poll
app.route('/api', api);
app.route('/hooks', hooks);
app.route('/', links);

// ── PostHog reverse proxy (first-party, so session replay survives ad blockers) ──
app.all('/ph/*', async (c) => {
  const host = (c.get('settings').POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/ph/, '');
  // Only what the PostHog browser SDK needs, only to PostHog: not a general-purpose relay.
  if (!['GET', 'POST'].includes(c.req.method) || !/^\/(static|array|e|i|s|decide|flags|batch|capture|engage|track)(\/|$)/.test(path)) return c.notFound();
  if (!/^https:\/\/[\w-]+(\.i)?\.posthog\.com$/.test(host)) return c.notFound();
  // The SDK's scripts and per-project config (/array/<key>/config.js) are served from the assets host.
  const upstream = /^\/(static|array)\//.test(path) ? host.replace('.i.posthog.com', '-assets.i.posthog.com') : host;
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
  if (res.ok) {
    // This browser's earlier visits were you, not prospects.
    await markInternal(c.env, getCookie(c, COOKIE.visitor)).catch(() => null);
    return c.redirect('/admin', 302);
  }
  return c.redirect(`/admin/login?error=${encodeURIComponent(res.error ?? 'Login failed')}`, 302);
});
app.post('/admin/logout', async (c) => {
  if (!sameOriginWrite(c)) return c.text('Forbidden', 403);
  await logout(c);
  return c.redirect('/admin/login', 302);
});
// Google Drive OAuth callback. Google's redirect is cross-site, so the admin cookie (SameSite=Strict)
// isn't sent: the signed, 15-minute state minted by /admin/api/google/connect is what authorises it.
app.get('/oauth/google/callback', async (c) => {
  const rt = runtimeFrom(c);
  const state = await verifyToken(await getSecret(c.env), c.req.query('state') ?? '');
  const ts = Number(state?.split('.')[1]);
  if (!state?.startsWith('google.') || !(Date.now() - ts < 15 * 60_000)) return c.text('This link has expired. Go back to Funnel HQ and press “Connect Google Drive” again.', 400);
  const code = c.req.query('code');
  if (!code) return c.redirect('/admin#ytideas', 302);
  try {
    const refresh = await googleExchange(rt.settings.GOOGLE_CLIENT_ID, rt.settings.GOOGLE_CLIENT_SECRET, rt.origin, code);
    await saveSettings(c.env, { GOOGLE_REFRESH_TOKEN: refresh });
    return c.redirect('/admin#ytideas', 302);
  } catch (e) {
    return c.text(`Google didn't connect: ${e instanceof Error ? e.message : 'unknown error'}. Check the client ID, secret and redirect URI, then try again.`, 400);
  }
});
app.route('/admin/api', admin);
app.get('/admin/live/:key', requireAdmin, liveHostPage); // host console for one live event (Zoom)
// Scripts and decks (public/materials/*.md) are admin-only: anyone else gets a plain 404, as if they didn't exist.
app.get('/materials/:file{[a-z0-9][a-z0-9-]{0,60}\\.md}', async (c) => {
  if (!(await isAdmin(c))) return c.notFound();
  const res = await c.env.ASSETS.fetch(new Request(new URL(`/materials/${c.req.param('file')}`, c.req.url)));
  if (!res.ok) return c.notFound();
  const headers: Record<string, string> = { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' };
  if (c.req.query('download')) headers['content-disposition'] = `attachment; filename="${c.req.param('file')}"`;
  return new Response(res.body, { headers });
});
app.get('/materials/*', (c) => c.notFound());
app.get('/materials', (c) => c.notFound());
// Presenter deck, presenter window, printable script and run sheet for one material (opened from Funnel HQ → Materials).
app.get('/admin/present', requireAdmin, async (c) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL('/admin/present.html', c.req.url)));
  return new Response(res.body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  });
});
app.get('/admin', requireAdmin, async (c) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL('/admin/index.html', c.req.url)));
  return new Response(res.body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
});

// ── Short URLs for every split-test page: /loi, /dental, /dental/competitor ──
// Last, so every real route above wins; anything that isn't a known page still 404s.
const knownShort: MiddlewareHandler<AppEnv> = async (c, next) => {
  const where = isWebinarHost(c) ? 'webinar' : 'main';
  if (!isShortUrl(where, c.req.param('industry') ?? '', c.req.param('angle'))) return c.notFound(); // before any tracking
  await next();
};
app.get('/:industry{[a-z][a-z0-9-]{1,30}}', knownShort, withVisitor, shortPage);
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
      quiet(sweepBots(rt), 'bot sweep'),
      quiet(processContractReminders(rt), 'contract reminders'),
      quiet(processDealSprintEmails(rt), 'deal sprint emails'),
      quiet(maybeSyncMetaSpend(rt), 'Meta ad spend'),
      quiet(processLiveMessages(rt), 'live webinar messages'),
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

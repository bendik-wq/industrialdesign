import { cameraTestPost } from './rooms/camera-test';
import { Hono, type MiddlewareHandler } from 'hono';
import { maybeSyncMetaSpend } from './integrations/meta-ads';
import { type AppEnv, type Runtime, publicOrigin, runtimeFrom } from './app';
import { canView, isAdmin, login, logout, requireAdmin, sameOriginWrite } from './admin/auth';
import { guestSession, logGuestView, mountGuestPublic } from './admin/guest';
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
import { challengeOfferRoute, mountChallengePages } from './challenge/routes';
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
import { planWebinarCalls } from './integrations/webinar-calls';
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
import { calRoute as lcCalRoute, referralRoute as lcReferralRoute } from './live/lifecycle-pages';
import { payPage } from './sales/pay-page';
import { quizPage, resultPage as quizResultPage } from './quiz/pages';
import { runOps } from './ops/cron';
import { maybeSyncAudiences } from './audiences/sync';
import { maybeRunResearch } from './research/brief';
import { maybeRunAutopilot } from './marketing/autopilot';
import './marketing/angles'; // registers marketing.test_angle / marketing.launch_angle_ads
import { processFollowupQueue } from './sales/followups';
import { processWinback } from './winback/campaigns';
import { processDm } from './dm/routes';
import { opsHooks } from './integrations/hooks-in';
import { mcpRoute } from './mcp/server';
import { processClientsSupport } from './ops/e-cron';
import { syncAttribution } from './attribution/stages';
import { audienceApi } from './rooms/audience-routes';
import { hostRoomForKey, hostRoomPage, paidPage, planPage, publicRoomPage, replayRoute, roomsApi, unlockRoute } from './rooms/routes';
import { processRoomSummaries } from './rooms/engage-db';
import { adminReplayPage, captionsRoute, intelApi } from './rooms/intel-routes'; // rooms intel (area D)
import { processIntel } from './rooms/intel-db';
import { joinPage } from './rooms/admission';
import { RoomDO as RoomDOBase } from './rooms/do';
import { buildId, versionAssets } from './infra/build';
import { normalisePath, purgeErrors, recordError } from './infra/errors';
import { runJobs } from './infra/cron';
import { indexTick } from './vectors/indexer';
import { planPdfRoute } from './infra/pdf'; // Cloudflare round, builder D
import { signedFileRoute } from './infra/signed-files';
import { mountStudioBlob } from './studio/routes'; // G&L Studio: the editor container's signed links
import { studioTick } from './studio/pipeline';
import { radarTick } from './radar/sweep'; // Studio → Radar: due radars, subreddits and publications as a sweep, Monid run polling, automatic transcripts
import { radarPipelineTick } from './radar/pipeline-flow'; // Radar v2: the analysis pipeline (formats, adaptations)
import { brainTick } from './brain/embed'; // Radar v2, builder B: the brain's leftover embeddings
import { maybeRunWatchdog } from './infra/watchdog';
import { syncStreamCopies } from './infra/cf-stream';
import { sendSignals } from './tracking/signals';
import { CSP_REPORT_PATH, cspReportRoute, reportingEndpoints, withReporting } from './infra/csp';
import { PUBLIC_RATE_LIMITS, purgeRateLimits, rateLimit } from './lib/ratelimit';
import { DLQ_NAME, consumeDeadLetters, consumeSendBatch, purgeSendJobs, queueOn } from './infra/queue';

/**
 * The room Durable Object, with its uncaught errors written to the error log (kind "room") before they surface as
 * before. Everything else is the room as written in rooms/do.ts.
 */
export class RoomDO extends RoomDOBase {
  private readonly logEnv: Env;
  private readonly logCtx: DurableObjectState;
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.logEnv = env; this.logCtx = ctx; }
  private logged(where: string, e: unknown): never {
    this.logCtx.waitUntil(recordError(this.logEnv, e, { kind: 'room', source: where }));
    throw e;
  }
  override async fetch(req: Request) { try { return await super.fetch(req); } catch (e) { return this.logged(`room fetch ${normalisePath(new URL(req.url).pathname)}`, e); } }
  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) { try { return await super.webSocketMessage(ws, data); } catch (e) { return this.logged('room message', e); } }
  override async webSocketClose(ws: WebSocket, code?: number) { try { return await super.webSocketClose(ws, code); } catch (e) { return this.logged('room close', e); } }
  override async alarm() { try { return await super.alarm(); } catch (e) { return this.logged('room alarm', e); } }
}

/** Requests whose error app.onError already logged (so the webhook check below doesn't log it twice). */
const loggedErrors = new WeakSet<Request>();
const errorKindFor = (path: string) => (path.startsWith('/hooks/') ? 'webhook' as const : 'request' as const);
/** The matched route pattern when there is one, else the path with its ids blanked. */
function errorSource(c: { req: { method: string; path: string; routePath?: string } }) {
  const rp = c.req.routePath;
  const route = rp && rp !== '*' && rp !== '/*' ? rp : normalisePath(c.req.path);
  return `${c.req.method} ${route}`;
}

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
  // Every page's CSP (main pages, rooms, admin, whichever module set it) reports violations to /csp-report → error log.
  // Only report directives are appended; no policy is loosened.
  const csp = c.res.headers.get('content-security-policy');
  if (csp && /^text\/html/i.test(c.res.headers.get('content-type') ?? '')) {
    const reporting = withReporting(csp);
    if (reporting !== csp) {
      c.header('content-security-policy', reporting);
      if (!c.res.headers.has('reporting-endpoints')) c.header('reporting-endpoints', reportingEndpoints(new URL(c.req.url).origin));
    }
  }
  // Versioned asset URLs: every page's /assets/*.js and *.css become ?v=<build id>, so a deploy can't serve stale files.
  if (/^text\/html/i.test(c.res.headers.get('content-type') ?? '')) c.res = versionAssets(c.res, buildId(c.env));
});

app.get('/health', (c) => c.json({ ok: true, build: buildId(c.env) }));
// Per-connection limits on public endpoints that write, send, charge or spend AI/TURN (src/lib/ratelimit.ts has the
// list and the audit). Registered before the routes they guard, so each runs first.
for (const l of PUBLIC_RATE_LIMITS) app.on(l.method, l.path, rateLimit(l));
// Browsers post CSP violations here (every CSP carries report-uri/report-to); they go to the error log as kind "csp".
app.post(CSP_REPORT_PATH, cspReportRoute);
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
mountChallengePages(app, withVisitor); // the First Deal Challenge (challenge/pages.ts)
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
app.get('/live/cal/:token/:kind', lcCalRoute); // builder E: calendar entries (Google, Outlook, Apple, .ics)
app.get('/live/i/:code', lcReferralRoute); // builder E: a registrant's referral link
app.get('/guarantee', withVisitor, guaranteePage);
// ── The acquisition readiness quiz (src/quiz): on the main domain and the webinar host alike ──
app.get('/quiz', withVisitor, quizPage);
app.get('/quiz/r/:token{[a-z0-9]{6,40}}', withVisitor, quizResultPage);
app.get('/rooms/replay/:rid', replayRoute); // room recordings (R2)
app.get('/rooms/replay/:rid/captions.vtt', captionsRoute); // the transcript as captions (area D)
app.get('/rooms/a/:id/:who/:ref', unlockRoute); // an unlocked file (signed, only for the person who earned it)
app.get('/rooms/plan/:id/:ref', planPage); // an attendee's Deal Plan (signed link from the summary email)
app.get('/rooms/plan/:id/:ref/pdf', planPdfRoute); // builder D: the Deal Plan as a PDF (Browser Rendering; setting PDF_RENDER)
app.get('/files/s/:k', signedFileRoute); // builder D: short-lived signed links to R2 files (PDFs, recordings for Stream)
mountStudioBlob(app); // G&L Studio: /studio/blob/:id/:kind, the editor container's signed links to Studio storage (src/studio/editor.ts)
app.get('/rooms/:id/done', paidPage); // where the payment page returns a buyer from the room
app.get('/rooms/:id/join/:slug', withVisitor, joinPage); // a room's general admission link (UTMs on it become the lead's attribution)
app.post('/rooms/:id/join/:slug', withVisitor, joinPage);
app.get('/unlocks/*', (c) => c.notFound()); // the unlock files are only served through /rooms/a/...
app.get('/rooms/:id', publicRoomPage); // our video rooms: co-hosts, meeting guests, challenge days
// Payment links (sales/paylinks.ts): a signed personal link from an email starts the checkout, then the pay page.
app.get('/pay/go/:ref', withVisitor, async (c) => (await import('./sales/paylinks')).payLinkRoute(c));
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
app.get('/api/live/:key/offer', challengeOfferRoute); // challenge-offer state, polled by the challenge day page
app.get('/api/live/:key/status', liveStatusRoute); // before /api: no visitor logging on each poll
app.get('/camera-test', (c) => c.env.ASSETS.fetch(new Request(new URL('/camera-test.html', c.req.url)))); // camera check page (noindex)
app.post('/api/camera-test', cameraTestPost); // camera check results (/camera-test), technical only
app.route('/api/intel', intelApi); // the replay page's pings, cards and offer state (area D)
app.route('/api/rooms', roomsApi);
app.route('/api/rooms', audienceApi); // area C: captions, the personal offer card, announcement consent // our video rooms: WebSocket, ICE, SFU proxy, recordings (before /api: no visitor logging per call)
app.route('/api', api);
// Webhook failures: a 5xx answer from any /hooks handler goes to the error log (thrown errors are logged by onError;
// 501 means "not configured here" and is not an error).
app.use('/hooks/*', async (c, next) => {
  await next();
  if (c.res.status >= 500 && c.res.status !== 501 && !loggedErrors.has(c.req.raw)) {
    const settings = c.get('settings');
    c.executionCtx.waitUntil(recordError(c.env, new Error(`HTTP ${c.res.status} from webhook handler`), { kind: 'webhook', source: errorSource(c), rt: settings ? runtimeFrom(c) : null }));
  }
});
app.route('/hooks', opsHooks); // support email (Resend inbound / forwarders) and Zapier actions (builder E)
app.route('/hooks', hooks);
// Remote MCP server for Claude (Streamable HTTP). Bearer token, or the secret connector URL /mcp/k/<token>.
app.on(['GET', 'POST', 'DELETE', 'OPTIONS'], '/mcp', mcpRoute);
app.on(['GET', 'POST', 'DELETE', 'OPTIONS'], '/mcp/k/:token{[A-Za-z0-9_-]{16,200}}', mcpRoute);
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
  // A short code, not the message: the login page shows only its own copy for it (no text injected through the URL).
  return c.redirect(`/admin/login?error=${res.code ?? 'failed'}`, 302);
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
    return c.redirect(state.split('.')[2] === 'studio' ? '/admin/studio' : '/admin#ytideas', 302);
  } catch (e) {
    return c.text(`Google didn't connect: ${e instanceof Error ? e.message : 'unknown error'}. Check the client ID, secret and redirect URI, then try again.`, 400);
  }
});
mountGuestPublic(app, sameOriginWrite); // guest links: /admin/invite/<token>, POST /admin/guest/leave (src/admin/guest.ts)
app.route('/admin/api', admin);
app.get('/admin/voice-demo', requireAdmin, async (c) => { // Funnel HQ → Talk to an agent (live, in the browser; nobody is called)
  const { voiceDemoPage, VOICE_DEMO_CSP } = await import('./admin/voice-demo');
  c.header('content-security-policy', VOICE_DEMO_CSP);
  c.header('permissions-policy', 'microphone=(self), camera=(), geolocation=()');
  c.header('cache-control', 'no-store');
  return c.html(voiceDemoPage());
});
app.get('/admin/sandbox', requireAdmin, async (c) => { // Funnel HQ → Sandbox (simulation: nothing is sent)
  const { sandboxPage, SANDBOX_CSP } = await import('./admin/sandbox');
  c.header('content-security-policy', SANDBOX_CSP);
  c.header('permissions-policy', 'microphone=(), camera=(), geolocation=()');
  c.header('cache-control', 'no-store');
  return c.html(sandboxPage());
});
app.get('/admin/studio', requireAdmin, async (c) => (await import('./admin/studio')).studioRoute(c)); // Funnel HQ → Studio (record, pipeline, scripts)
app.get('/admin/live/:key', requireAdmin, liveHostPage); // host console for one live event (Zoom)
app.get('/admin/rooms/:id/replay', requireAdmin, adminReplayPage); // the team's view of a room's replay (area D)
app.get('/admin/rooms/:id', requireAdmin, hostRoomPage); // the host in our own room
app.get('/admin/live/:key/room', requireAdmin, hostRoomForKey); // host console → Open host room
// Scripts and decks (public/materials/*.md) are admin-only: anyone else gets a plain 404, as if they didn't exist.
app.get('/materials/:file{[a-z0-9][a-z0-9-]{0,60}\\.md}', async (c) => {
  if (!(await canView(c))) return c.notFound();
  if (!(await isAdmin(c))) { const g = await guestSession(c); if (g) logGuestView(c, g, 200); } // guests read the scripts too (logged)
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
  loggedErrors.add(c.req.raw);
  const settings = c.get('settings');
  const write = recordError(c.env, err, { kind: errorKindFor(c.req.path), source: errorSource(c), rt: settings ? runtimeFrom(c) : null });
  try { c.executionCtx.waitUntil(write); } catch { /* no execution context (tests): the write runs on its own */ }
  return c.text('Something went wrong', 500);
});

export default {
  fetch: app.fetch,

  /** Every 5 minutes: send due emails, retry tracking, ping reps before calls, post the daily sales digest, place AI calls. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const [settings, reps] = await Promise.all([loadSettings(env), loadReps(env)]).catch(async (e) => {
      await recordError(env, e, { kind: 'cron', source: 'cron start (settings and reps)' });
      throw e;
    });
    const rt: Runtime = {
      env,
      settings,
      reps,
      origin: publicOrigin(settings, 'https://example.com'),
      waitUntil: (p) => ctx.waitUntil(p.catch((e) => console.error('background task failed', e))),
    };
    if (!settings.PUBLIC_URL) console.warn('PUBLIC_URL is not set — email links will point at example.com');
    // Every job runs on its own with a time budget (src/infra/cron.ts): one failing or slow job can't hold up the others,
    // and each run's duration and status is kept for Funnel HQ → Errors & cron. What each job does is unchanged.
    const outcomes = await runJobs(rt, [
      { name: 'email queue', run: () => processEmailQueue(rt) },
      { name: 'tracking retries', run: () => retryForwards(rt) },
      { name: 'call pings', run: () => pingUpcomingCalls(rt) },
      { name: 'daily digest', run: () => maybeSendDigest(rt) },
      { name: 'AI calls', run: () => processCallQueue(rt) },
      { name: 'AI callbacks', run: () => syncInbound(rt) },
      { name: 'Calendly sync', run: () => syncCalendly(rt) },
      { name: 'behaviour triggers', run: () => processTriggers(rt) },
      { name: 'retention purge', run: () => purgeOld(rt) },
      { name: 'unconfirmed bookings', run: () => alertUnconfirmedBookings(rt) },
      { name: 'webinar sessions', run: () => ensureSessions(rt) },
      { name: 'content sync', run: () => maybeSyncContent(rt) },
      { name: 'SMS', run: () => processSmsQueue(rt) },
      { name: 'bot sweep', run: () => sweepBots(rt) },
      { name: 'contract reminders', run: () => processContractReminders(rt) },
      { name: 'deal sprint emails', run: () => processDealSprintEmails(rt) },
      { name: 'Meta ad spend', run: () => maybeSyncMetaSpend(rt) },
      { name: 'live webinar messages', run: () => processLiveMessages(rt) },
      { name: 'Command (routines, alerts, brief)', run: () => runOps(rt) },
      { name: 'research', run: () => maybeRunResearch(rt) },
      { name: 'ads autopilot', run: () => maybeRunAutopilot(rt) },
      { name: 'sales follow-ups', run: () => processFollowupQueue(rt) },
      { name: 'Instagram DM inbox', run: () => processDm(rt) },
      { name: 'clients, support and webhooks', run: () => processClientsSupport(rt) },
      { name: 'win-back (approved campaigns only)', run: () => processWinback(rt) },
      { name: 'webinar attribution', run: () => syncAttribution(rt) },
      { name: 'webinar AI calls', run: () => planWebinarCalls(rt) },
      { name: 'room summary emails', run: () => processRoomSummaries(rt) },
      { name: 'room transcripts and debriefs', run: () => processIntel(rt) },
      { name: 'Meta audiences (approved only)', run: () => maybeSyncAudiences(rt) },
      { name: 'Meta deep-funnel signals', run: () => sendSignals(rt) },
      { name: 'error log retention', run: () => purgeErrors(rt) },
      { name: 'rate-limit counters', run: () => purgeRateLimits(env) },
      // Cloudflare round, builder C: AI search (Vectorize). Does nothing unless VECTOR_SEARCH is on and the bindings exist.
      { name: 'AI search index', run: () => indexTick(rt) },
      // Platform round A: old send-queue job rows (only while SEND_VIA_QUEUE is on).
      ...(queueOn(rt) ? [{ name: 'send queue upkeep', run: () => purgeSendJobs(env) }] : []),
      // Cloudflare round, builder D: the hourly funnel watchdog (setting WATCHDOG, off by default) and Stream copies in progress.
      { name: 'funnel watchdog', run: () => maybeRunWatchdog(rt), budgetMs: 170_000 },
      { name: 'Stream copies', run: () => syncStreamCopies(rt) },
      // G&L Studio: the Drive folder scan (every STUDIO_SCAN_HOURS, due check in studio_state) and any video not moving.
      { name: 'Studio (Drive scan and edits)', run: () => studioTick(rt), budgetMs: 170_000 },
      // Radar: radars due by RADAR_SCHEDULE_HOURS are queued, Monid runs are started and polled (nothing runs without MONID_API_KEY).
      { name: 'Radar (Monid runs)', run: () => radarTick(rt), budgetMs: 90_000 },
      // Radar v2: resume the inline analysis pipeline and start one after a finished sweep (RADAR_PIPELINE_HOURS).
      { name: 'Radar analysis pipeline', run: () => radarPipelineTick(rt), budgetMs: 170_000 },
      // The brain: once the owner started embedding (POST /admin/api/brain/embed), chunks still left are embedded here.
      { name: 'Brain embeddings', run: () => brainTick(rt), budgetMs: 60_000 },
    ]);
    type R<F extends (...a: never[]) => unknown> = Awaited<ReturnType<F>> | null;
    const [result, retried, pinged, digest, calls, callbacks, calSync, triggers, purged] = outcomes.map((o) => o.result) as [
      R<typeof processEmailQueue>, R<typeof retryForwards>, R<typeof pingUpcomingCalls>, R<typeof maybeSendDigest>, R<typeof processCallQueue>,
      R<typeof syncInbound>, R<typeof syncCalendly>, R<typeof processTriggers>, R<typeof purgeOld>,
    ];
    if (calls && (calls.dialed || calls.synced)) console.log('AI calls', calls);
    if (callbacks) console.log('AI callbacks processed', callbacks);
    if (calSync) console.log('Calendly sync', calSync);
    if (triggers?.queued) console.log('behaviour emails queued', triggers);
    if (pinged) console.log('call pings', pinged);
    if (digest) console.log('daily digest sent');
    if (purged && (purged.events || purged.sessions)) console.log('retention purge', purged);
    if (result?.due) console.log('email queue', result);
    if (retried?.due) console.log('tracking retries', retried);
  },

  /**
   * The send queue (platform round A, src/infra/queue.ts): `gl-send` runs each job with the cron's own send
   * functions; `gl-send-dlq` keeps what gave up for Funnel HQ → Errors & cron. Only fed while SEND_VIA_QUEUE is on.
   */
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) {
    const [settings, reps] = await Promise.all([loadSettings(env), loadReps(env)]).catch(async (e) => {
      await recordError(env, e, { kind: 'queue', source: 'send queue start (settings and reps)' });
      throw e;
    });
    const rt: Runtime = {
      env,
      settings,
      reps,
      origin: publicOrigin(settings, 'https://example.com'),
      waitUntil: (p) => ctx.waitUntil(p.catch((e) => console.error('background task failed', e))),
    };
    if (batch.queue === DLQ_NAME || batch.queue.endsWith('-dlq')) await consumeDeadLetters(rt, batch);
    else await consumeSendBatch(rt, batch);
  },
} satisfies ExportedHandler<Env>;

export { LiveReminderWorkflow } from './workflows';
export { StudioPipelineWorkflow } from './studio/workflow'; // G&L Studio: Workflow gl-studio-pipeline
export { RadarPipelineWorkflow } from './radar/pipeline-flow'; // Radar v2: Workflow gl-radar-pipeline (commented out in wrangler.jsonc until enabled)
export { StudioEditor } from './studio/container'; // G&L Studio: the editor container (Cloudflare Containers)

export { runtimeFrom };
/** Every registered route (method + path), for the security tests that check each admin write route rejects cross-site calls. */
export const routeTable = () => app.routes.map((r) => ({ method: r.method, path: r.path }));

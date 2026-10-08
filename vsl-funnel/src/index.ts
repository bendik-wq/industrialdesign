import { Hono, type MiddlewareHandler } from 'hono';
import { type AppEnv, type Runtime, publicOrigin, runtimeFrom } from './app';
import { isAdmin, login, logout, requireAdmin } from './admin/auth';
import type { Env } from './env';
import { applyPage, bookPage, breakoutPage, landingPage, resourcesPage, staticPage } from './funnel/pages';
import { processEmailQueue } from './integrations/email';
import { resolveVisitor } from './lib/identity';
import { admin } from './routes/admin';
import { api } from './routes/api';
import { hooks } from './routes/hooks';
import { links } from './routes/links';
import { loadSettings } from './settings';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  c.set('settings', await loadSettings(c.env));
  await next();
  c.header('x-robots-tag', 'noindex, nofollow');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
  c.header('x-content-type-options', 'nosniff');
});

app.get('/health', (c) => c.json({ ok: true }));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

// ── Funnel pages (server-side page view + per-visitor rendering) ──
const withVisitor: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('visitor', await resolveVisitor(c, 'page'));
  await next();
  c.header('x-frame-options', 'SAMEORIGIN');
};
app.get('/', withVisitor, landingPage);
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
  const upstream = path.startsWith('/static/') ? host.replace('.i.posthog.com', '-assets.i.posthog.com') : host;
  const headers = new Headers(c.req.raw.headers);
  headers.delete('cookie');
  headers.set('x-forwarded-for', c.req.header('cf-connecting-ip') ?? '');
  return fetch(`${upstream}${path}${url.search}`, { method: c.req.method, headers, body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body });
});

// ── Dashboard ──
app.get('/admin/login', async (c) => {
  if (await isAdmin(c)) return c.redirect('/admin', 302);
  return c.env.ASSETS.fetch(new Request(new URL('/admin/login.html', c.req.url)));
});
app.post('/admin/login', async (c) => {
  const body = await c.req.parseBody();
  const res = await login(c, body.password);
  if (res.ok) return c.redirect('/admin', 302);
  return c.redirect(`/admin/login?error=${encodeURIComponent(res.error ?? 'Login failed')}`, 302);
});
app.post('/admin/logout', (c) => {
  logout(c);
  return c.redirect('/admin/login', 302);
});
app.route('/admin/api', admin);
app.get('/admin', requireAdmin, async (c) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL('/admin/index.html', c.req.url)));
  return new Response(res.body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
});

app.notFound((c) => c.text('Not found', 404));
app.onError((err, c) => {
  console.error('unhandled', err);
  return c.text('Something went wrong', 500);
});

export default {
  fetch: app.fetch,

  /** Every 5 minutes: send due emails (sequences, abandoned-application recovery, call reminders). */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const settings = await loadSettings(env);
    const rt: Runtime = {
      env,
      settings,
      origin: publicOrigin(settings, 'https://example.com'),
      waitUntil: (p) => ctx.waitUntil(p.catch((e) => console.error('background task failed', e))),
    };
    if (!settings.PUBLIC_URL) console.warn('PUBLIC_URL is not set — email links will point at example.com');
    const result = await processEmailQueue(rt);
    if (result.due) console.log('email queue', result);
  },
} satisfies ExportedHandler<Env>;

export { runtimeFrom };

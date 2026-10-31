import { type Context, Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { cleanJoinUrl, createZoomFor, hostStartUrl, isLiveKey, liveEvent, playbackState, streamSetup, upsertLiveEvent, JOIN_OPENS_MIN, OVERRUN_MIN } from './stream';
import { ZOOM_STEPS, ZoomError, zoomCheck, zoomConfigured } from './zoom';

/**
 * Funnel HQ → live events on Zoom. API mounted at /admin/api/live-events (admin only, via routes/admin.ts);
 * the host console page is GET /admin/live/:key (index.ts, behind requireAdmin).
 */
export const liveEventsAdmin = new Hono<AppEnv>();
liveEventsAdmin.use('*', requireAdmin);

const errJson = (c: Context<AppEnv>, e: unknown) => {
  const status = e instanceof ZoomError && e.status >= 400 && e.status < 500 ? 400 : 502;
  return c.json({ ok: false, error: e instanceof Error ? e.message : 'Something went wrong' }, status);
};

/** The host console's view of an event (admin only: includes whether a host start link exists, never the link itself). */
export async function hostView(c: Context<AppEnv>, key: string) {
  const rt = runtimeFrom(c);
  const info = await liveEvent(rt, key);
  const row = info.row;
  return {
    key,
    title: info.title,
    kind: key.split(':')[0],
    schedule: info.schedule,
    scheduleFrom: info.session ? 'webinar' : row?.starts_at ? 'event' : null,
    session: info.session ? { id: info.session.id, mode: info.session.mode, status: info.session.status } : null,
    joinUrl: info.joinUrl,
    zoom: row?.zoom_id ? { id: row.zoom_id, kind: row.zoom_kind, password: row.zoom_password, hasStartUrl: Boolean(row.zoom_start_url) } : null,
    setup: { ...streamSetup(rt), steps: ZOOM_STEPS },
    playback: playbackState(info),
    opensMin: JOIN_OPENS_MIN,
    overrunMin: OVERRUN_MIN,
    serverNow: Date.now(),
  };
}

liveEventsAdmin.get('/zoom/check', async (c) => c.json(await zoomCheck(runtimeFrom(c))));

liveEventsAdmin.get('/:key', async (c) => {
  const key = c.req.param('key');
  if (!isLiveKey(key)) return c.json({ error: 'Unknown event' }, 404);
  return c.json(await hostView(c, key));
});

/** Paste or remove the join link; set the title and (for events without a webinar session) the schedule. */
liveEventsAdmin.put('/:key', async (c) => {
  const key = c.req.param('key');
  if (!isLiveKey(key)) return c.json({ error: 'Unknown event' }, 404);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const v: Parameters<typeof upsertLiveEvent>[2] = {};
  if ('join_url' in b) {
    const raw = typeof b.join_url === 'string' ? b.join_url.trim() : '';
    if (raw) {
      const url = cleanJoinUrl(raw);
      if (!url) return c.json({ error: 'Paste the full https link (for example https://us02web.zoom.us/j/…)' }, 400);
      v.joinUrl = url;
    } else v.joinUrl = null;
  }
  if (typeof b.title === 'string') v.title = b.title.replace(/[<>]/g, '').trim().slice(0, 200) || null;
  if ('starts_at' in b) {
    const t = Number(b.starts_at);
    if (b.starts_at !== null && (!Number.isFinite(t) || t < Date.now() - 86_400_000 || t > Date.now() + 400 * 86_400_000)) return c.json({ error: 'Pick a real start time' }, 400);
    v.startsAt = b.starts_at === null ? null : t;
  }
  if ('duration_min' in b) {
    const d = Math.round(Number(b.duration_min));
    if (!(d >= 15 && d <= 600)) return c.json({ error: 'Length: 15 to 600 minutes' }, 400);
    v.durationMin = d;
  }
  await upsertLiveEvent(runtimeFrom(c), key, v);
  return c.json({ ok: true, event: await hostView(c, key) });
});

/** Create the Zoom meeting (or Zoom Webinar, when the account has it) through the API. */
liveEventsAdmin.post('/:key/zoom', async (c) => {
  const key = c.req.param('key');
  if (!isLiveKey(key)) return c.json({ error: 'Unknown event' }, 404);
  const rt = runtimeFrom(c);
  if (!zoomConfigured(rt.settings)) return c.json({ ok: false, error: streamSetup(rt).reason }, 400);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const z = await createZoomFor(rt, key, {
      startsAt: Number(b.starts_at) || undefined,
      durationMin: Number(b.duration_min) || undefined,
      title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : undefined,
    });
    return c.json({ ok: true, kind: z.kind, event: await hostView(c, key) });
  } catch (e) {
    return errJson(c, e);
  }
});

/** Opens Zoom as the host: a fresh start link (Zoom expires them after two hours). Admin only. */
liveEventsAdmin.get('/:key/start', async (c) => {
  const key = c.req.param('key');
  if (!isLiveKey(key)) return c.text('Unknown event', 404);
  const url = await hostStartUrl(runtimeFrom(c), key);
  if (!url) return c.text('This event has no Zoom host link. Create the meeting from the host console, or start it from your Zoom app.', 404);
  return c.redirect(url, 302);
});

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** GET /admin/live/:key: the host console page. Data is embedded as JSON (not executed) and drawn by live-host.js. */
export async function liveHostPage(c: Context<AppEnv>) {
  const key = c.req.param('key') ?? '';
  if (!isLiveKey(key)) return c.text('Unknown live event. Keys look like webinar:<session id> or challenge:<cohort id>:<day>.', 404);
  const view = await hostView(c, key);
  const json = JSON.stringify(view).replace(/</g, '\\u003c');
  c.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  c.header('cache-control', 'no-store');
  return c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<title>Host console · ${esc(view.title)}</title>
<link rel="stylesheet" href="/assets/admin.css">
<link rel="stylesheet" href="/assets/live-host.css">
<script defer src="/assets/live-player.js"></script>
<script defer src="/assets/live-host.js"></script>
${key.startsWith('challenge:') ? '<script defer src="/assets/challenge-host.js"></script>' : ''}
</head>
<body class="lh-body">
<script type="application/json" id="live-host-data">${json}</script>
<header class="lh-top"><a href="/admin#webinar" class="lh-back">Funnel HQ</a><span class="lh-crumb">Live</span><span class="lh-key mono">${esc(key)}</span></header>
<main class="lh" data-live-host aria-live="polite"></main>
<!-- Live controls added by other parts of the app (offer, chat…) mount here: -->
<section class="lh lh-controls" id="live-controls" data-live-key="${esc(key)}" aria-label="Live controls"></section>
</body>
</html>`);
}

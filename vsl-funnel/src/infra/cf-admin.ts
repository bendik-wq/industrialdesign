import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { publicRow, refreshStream, sendToStream, streamForRoom } from './cf-stream';
import { runWatchdog, watchdogReport } from './watchdog';

/**
 * Funnel HQ APIs for the Cloudflare round, builder D (/admin/api/cf, behind requireAdmin via the admin router):
 *  GET  /watchdog            the funnel watchdog's last 24 runs (Errors & cron card)
 *  POST /watchdog/run        run the checks now (needs Browser Rendering; records a run either way)
 *  GET  /stream/room/:id     Stream copies of a room's recordings (Rooms → a room → Recordings)
 *  POST /stream/:rec         send a finished recording to Stream
 *  POST /stream/:rec/refresh ask Stream for the copy's state
 */
export const cfAdmin = new Hono<AppEnv>();

cfAdmin.get('/watchdog', async (c) => c.json(await watchdogReport(runtimeFrom(c))));

cfAdmin.post('/watchdog/run', async (c) => {
  const rt = runtimeFrom(c);
  const run = await runWatchdog(rt, { trigger: 'manual' });
  return c.json({ ok: true, run: { ok: run.ok, checked: run.checked, failed: run.failed, skipped: run.skipped } });
});

const REC = /^rec[a-z0-9]{8,40}$/;

cfAdmin.get('/stream/room/:id', async (c) => c.json(await streamForRoom(runtimeFrom(c), c.req.param('id'))));

cfAdmin.post('/stream/:rec', async (c) => {
  const rec = c.req.param('rec');
  if (!REC.test(rec)) return c.json({ ok: false, error: 'Recording not found.' }, 404);
  const r = await sendToStream(runtimeFrom(c), rec);
  return r.ok ? c.json({ ok: true, already: r.already, video: publicRow(r.video) }) : c.json({ ok: false, error: r.error }, 400);
});

cfAdmin.post('/stream/:rec/refresh', async (c) => {
  const rec = c.req.param('rec');
  if (!REC.test(rec)) return c.json({ ok: false, error: 'Recording not found.' }, 404);
  try {
    return c.json({ ok: true, video: publicRow(await refreshStream(runtimeFrom(c), rec)) });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'Stream check failed' }, 502);
  }
});

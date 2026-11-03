import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { saveSettings } from '../settings';
import { buildId } from './build';
import { cronReport } from './cron';
import { errorsReport, slackOn } from './errors';
import { queueReport, retryDead } from './queue';
import { flowReport } from '../live/reminder-flow';
import { runtimeFrom } from '../app';

/** Funnel HQ → Errors & cron: /admin/api/errors (behind requireAdmin via the admin router). */
export const errorsAdmin = new Hono<AppEnv>();

errorsAdmin.get('/', async (c) => {
  const days = Number(c.req.query('days') || 14);
  const rt = runtimeFrom(c);
  const [errors, cron, queue, flows] = await Promise.all([errorsReport(c.env, Date.now(), Number.isFinite(days) ? days : 14), cronReport(c.env), queueReport(rt), flowReport(rt)]);
  return c.json({
    ...errors,
    cron,
    queue,
    flows,
    build: buildId(c.env),
    slack: { on: slackOn(runtimeFrom(c)) },
  });
});

/** The Queue card's Retry button: a dead-lettered send job goes back on the queue (its row's once-only claim still applies). */
errorsAdmin.post('/queue/retry', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { key?: unknown };
  const key = typeof body.key === 'string' && /^(email|sms|call|track):[\w-]{1,80}$/.test(body.key) ? body.key : null;
  if (!key) return c.json({ ok: false, error: 'Unknown message.' }, 400);
  const r = await retryDead(runtimeFrom(c), key);
  return c.json(r, r.ok ? 200 : 409);
});

/** The "ping Slack on a new error" switch (setting ERRORS_SLACK, off by default). */
errorsAdmin.post('/slack', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { on?: unknown };
  await saveSettings(c.env, { ERRORS_SLACK: body.on === true ? 'on' : 'off' });
  return c.json({ ok: true, on: body.on === true });
});

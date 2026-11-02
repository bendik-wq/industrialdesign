import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { saveSettings } from '../settings';
import { buildId } from './build';
import { cronReport } from './cron';
import { errorsReport, slackOn } from './errors';
import { runtimeFrom } from '../app';

/** Funnel HQ → Errors & cron: /admin/api/errors (behind requireAdmin via the admin router). */
export const errorsAdmin = new Hono<AppEnv>();

errorsAdmin.get('/', async (c) => {
  const days = Number(c.req.query('days') || 14);
  const [errors, cron] = await Promise.all([errorsReport(c.env, Date.now(), Number.isFinite(days) ? days : 14), cronReport(c.env)]);
  return c.json({
    ...errors,
    cron,
    build: buildId(c.env),
    slack: { on: slackOn(runtimeFrom(c)) },
  });
});

/** The "ping Slack on a new error" switch (setting ERRORS_SLACK, off by default). */
errorsAdmin.post('/slack', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { on?: unknown };
  await saveSettings(c.env, { ERRORS_SLACK: body.on === true ? 'on' : 'off' });
  return c.json({ ok: true, on: body.on === true });
});

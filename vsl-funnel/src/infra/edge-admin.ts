import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { aeEventsReport } from './analytics-engine';
import { turnstileReport } from './turnstile';

/**
 * Funnel HQ → Errors & cron, Cloudflare platform cards (builder B), behind requireAdmin via the admin router:
 *   GET /admin/api/edge/bots    Bot protection: Turnstile mode and pass/fail per form, 7 days
 *   GET /admin/api/edge/events  Events (Analytics Engine): per day by name for 30 days next to D1, and top paths
 */
export const edgeAdmin = new Hono<AppEnv>();

edgeAdmin.get('/bots', async (c) => c.json(await turnstileReport(runtimeFrom(c))));

edgeAdmin.get('/events', async (c) => {
  const days = Math.min(90, Math.max(1, Number(c.req.query('days')) || 30));
  return c.json(await aeEventsReport(runtimeFrom(c), Date.now(), days));
});

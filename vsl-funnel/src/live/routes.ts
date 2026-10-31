import type { Context } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { liveStatus } from './stream';

/**
 * GET /api/live/:key/status, polled by live-player.js every ~10 s: on/off by the schedule and whether a link exists.
 * Public, so never the link. Registered ahead of the /api router so a poll doesn't log a visitor or session each time.
 */
export async function liveStatusRoute(c: Context<AppEnv>) {
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'forbidden' }, 403);
  const st = await liveStatus(runtimeFrom(c), c.req.param('key') ?? '');
  if (!st) return c.json({ error: 'not found' }, 404);
  c.header('cache-control', 'public, max-age=5');
  return c.json(st);
}

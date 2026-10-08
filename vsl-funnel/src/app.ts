import type { Context } from 'hono';
import type { Env } from './env';
import type { VisitorCtx } from './lib/identity';
import type { Settings } from './settings';

export type AppEnv = {
  Bindings: Env;
  Variables: { settings: Settings; visitor: VisitorCtx };
};

/** What background work needs, whether it runs in a request, a webhook or the cron. */
export interface Runtime {
  env: Env;
  settings: Settings;
  origin: string;
  waitUntil: (p: Promise<unknown>) => void;
}

export function runtimeFrom(c: Context<AppEnv>): Runtime {
  const settings = c.get('settings');
  return {
    env: c.env,
    settings,
    origin: publicOrigin(settings, new URL(c.req.url).origin),
    waitUntil: (p) => c.executionCtx.waitUntil(p.catch((e) => console.error('background task failed', e))),
  };
}

export const publicOrigin = (settings: Settings, fallback: string) => (settings.PUBLIC_URL || fallback).replace(/\/+$/, '');

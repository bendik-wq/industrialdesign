import type { Context } from 'hono';
import type { Env } from './env';
import type { VisitorCtx } from './lib/identity';
import type { Settings } from './settings';
import type { Rep } from './sales/reps';

export type AppEnv = {
  Bindings: Env;
  Variables: { settings: Settings; visitor: VisitorCtx; reps: Rep[] };
};

/** What background work needs, whether it runs in a request, a webhook or the cron. */
export interface Runtime {
  env: Env;
  settings: Settings;
  /** The sales team (from D1, cached). */
  reps: Rep[];
  origin: string;
  waitUntil: (p: Promise<unknown>) => void;
}

export function runtimeFrom(c: Context<AppEnv>): Runtime {
  const settings = c.get('settings');
  return {
    env: c.env,
    settings,
    reps: c.get('reps') ?? [],
    origin: publicOrigin(settings, new URL(c.req.url).origin),
    waitUntil: (p) => c.executionCtx.waitUntil(p.catch((e) => console.error('background task failed', e))),
  };
}

export const publicOrigin = (settings: Settings, fallback: string) => (settings.PUBLIC_URL || fallback).replace(/\/+$/, '');

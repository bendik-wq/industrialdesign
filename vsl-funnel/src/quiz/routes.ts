import type { Context, Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { ApplicationError } from '../funnel/application';
import { parseFilters } from '../admin/stats';
import { QUIZ_COPY } from './content';
import { quizGateView, quizTarget, registerFromQuiz, saveQuizAnswer, startQuiz, submitQuizLead } from './quiz';
import { quizReport } from './report';

/**
 * The quiz's routes, mounted on the existing routers so they inherit their guards:
 *  - mountQuizApi(api): /api/quiz/* (same-origin only, visitor resolved; per-IP limits in PUBLIC_RATE_LIMITS);
 *  - mountQuizAdmin(admin): GET /admin/api/quiz (admin session or a guest link, read only).
 * The pages (/quiz, /quiz/r/:token) are mounted in src/index.ts with the other funnel pages.
 */

const body = async (c: Context<AppEnv>) => {
  const t = await c.req.text().catch(() => '');
  if (!t || t.length > 32_000) return {} as Record<string, unknown>;
  try { const v = JSON.parse(t) as unknown; return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}; } catch { return {}; }
};
const fail = (c: Context<AppEnv>, err: unknown) => {
  if (err instanceof ApplicationError) return c.json({ ok: false, error: err.message, field: err.field ?? null }, err.status);
  console.error('quiz api', err);
  return c.json({ ok: false, error: QUIZ_COPY.errors.generic }, 500);
};
const route = (fn: (rt: ReturnType<typeof runtimeFrom>, v: AppEnv['Variables']['visitor'], b: Record<string, unknown>) => Promise<unknown>) => async (c: Context<AppEnv>) => {
  try { return c.json({ ok: true, ...((await fn(runtimeFrom(c), c.get('visitor'), await body(c))) as object) }); } catch (err) { return fail(c, err); }
};

export function mountQuizApi(api: Hono<AppEnv>) {
  api.post('/quiz/start', route((rt, v, b) => startQuiz(rt, v, b)));
  api.post('/quiz/answer', route((rt, v, b) => saveQuizAnswer(rt, v, b)));
  api.post('/quiz/gate', route((rt, v, b) => quizGateView(rt, v, b)));
  api.post('/quiz/lead', route((rt, v, b) => submitQuizLead(rt, v, b)));
  api.post('/quiz/register', route((rt, v, b) => registerFromQuiz(rt, v, b)));
}

export function mountQuizAdmin(admin: Hono<AppEnv>) {
  admin.get('/quiz', async (c) => {
    const f = parseFilters(c.req.query());
    return c.json({ ...(await quizReport(runtimeFrom(c), { from: f.from, to: f.to })), target: quizTarget(c.get('settings')) });
  });
}

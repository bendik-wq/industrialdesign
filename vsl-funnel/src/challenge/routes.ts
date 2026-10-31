import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { sameOriginWrite } from '../admin/auth';
import { ApplicationError } from '../funnel/application';
import { getReg } from './cohorts';
import { offerForKey, startChallengeDeposit } from './offer';
import { type OrderKind, PayError, nextStep, oneClickVip, payOrder } from './payments';
import { answerPoll, askHotSeat, dayFeed, joinDay, postDayChat, submitHomework } from './room';
import { dayPage, hubPage, icsFile, joinRedirect, landingPage, payPage, replayRedirect, todayRedirect, vipPage, vipSkip, welcomePage } from './pages';

/** Pages: mounted at the app root (works on the main domain and the webinar host). */
export function mountChallengePages(app: Hono<AppEnv>, withVisitor: MiddlewareHandler<AppEnv>) {
  app.get('/challenge', withVisitor, landingPage);
  app.get('/challenge/pay/:token', withVisitor, payPage);
  app.get('/challenge/vip/:token', withVisitor, vipPage);
  app.post('/challenge/vip/:token/skip', async (c, next) => (sameOriginWrite(c) ? next() : c.text('Forbidden', 403)), withVisitor, vipSkip);
  app.get('/challenge/welcome/:token', withVisitor, welcomePage);
  app.get('/challenge/hub/:token', withVisitor, hubPage);
  app.get('/challenge/day/:token/:n{[1-5]}', withVisitor, dayPage);
  app.get('/challenge/today/:token', withVisitor, todayRedirect);
  app.get('/challenge/join/:token/:n{[1-5]}', withVisitor, joinRedirect);
  app.get('/challenge/replay/:token/:n{[1-5]}', withVisitor, replayRedirect);
  app.get('/challenge/ics/:token', withVisitor, icsFile);
}

const MAX_BODY = 32_000;
async function body(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const t = await c.req.text();
  if (!t || t.length > MAX_BODY) return {};
  try { const j = JSON.parse(t); return j && typeof j === 'object' ? j as Record<string, unknown> : {}; } catch { return {}; }
}
async function withReg(c: Context<AppEnv>) {
  const b = await body(c);
  const reg = typeof b.token === 'string' ? await getReg(runtimeFrom(c), b.token) : null;
  return { rt: runtimeFrom(c), b, reg, day: Math.floor(Number(b.day)) };
}
const fail = (c: Context<AppEnv>, e: unknown) => {
  if (e instanceof ApplicationError) return c.json({ ok: false, error: e.message, field: e.field ?? null }, e.status);
  if (e instanceof PayError) return c.json({ ok: false, error: e.message }, e.status as 400);
  console.error('challenge api', e);
  return c.json({ ok: false, error: 'Something went wrong. Try again.' }, 500);
};

/** /api/challenge/* (mounted inside the /api router: same-origin checks and the visitor are already done). */
export const challengeApi = new Hono<AppEnv>();

challengeApi.post('/register', async (c) => {
  try {
    const rt = runtimeFrom(c);
    const { reg } = await (await import('./payments')).registerChallenge(rt, c.get('visitor'), await body(c));
    return c.json({ ok: true, next: nextStep(rt, reg) });
  } catch (e) { return fail(c, e); }
});

challengeApi.post('/pay', async (c) => {
  if (!sameOriginWrite(c)) return c.json({ ok: false, error: 'forbidden' }, 403);
  try {
    const { rt, b, reg } = await withReg(c);
    if (!reg) return c.json({ ok: false, error: 'Link not found' }, 404);
    const kind: OrderKind = b.kind === 'vip' ? 'vip' : 'ticket';
    return c.json(await payOrder(rt, reg, kind, b.confirmation_token));
  } catch (e) { return fail(c, e); }
});

challengeApi.post('/vip', async (c) => {
  if (!sameOriginWrite(c)) return c.json({ ok: false, error: 'forbidden' }, 403);
  try {
    const { rt, reg } = await withReg(c);
    if (!reg) return c.json({ ok: false, error: 'Link not found' }, 404);
    const r = await oneClickVip(rt, reg);
    return c.json(r.ok ? { ok: true, next: r.next } : { ok: false, next: r.fallback });
  } catch (e) { return fail(c, e); }
});

const action = (fn: (x: Awaited<ReturnType<typeof withReg>>) => Promise<unknown>) => async (c: Context<AppEnv>) => {
  try {
    const x = await withReg(c);
    if (!x.reg) return c.json({ ok: false, error: 'Link not found' }, 404);
    return c.json(await fn(x));
  } catch (e) { return fail(c, e); }
};

challengeApi.post('/feed', action(({ rt, reg, day, b }) => dayFeed(rt, reg!, day, b)));
challengeApi.post('/chat', action(({ rt, reg, day, b }) => postDayChat(rt, reg!, day, b)));
challengeApi.post('/worksheet', action(({ rt, reg, day, b }) => submitHomework(rt, reg!, day, b.answers)));
challengeApi.post('/poll', action(({ rt, reg, day, b }) => answerPoll(rt, reg!, day, b.value)));
challengeApi.post('/hot', action(({ rt, reg, day, b }) => askHotSeat(rt, reg!, day, b.question)));
challengeApi.post('/joined', action(async ({ rt, reg, day }) => ({ ok: Boolean(await joinDay(rt, reg!, day)) })));
challengeApi.post('/deposit', action(({ rt, reg, day, b }) => startChallengeDeposit(rt, reg!, { oneClick: b.one_click !== false, day: day >= 1 && day <= 5 ? day : 5 })));

/**
 * GET /api/live/:key/offer for challenge keys (challenge-offer, polled by the day page). Other keys fall
 * through to whatever else answers this path (builder B's live room).
 */
export async function challengeOfferRoute(c: Context<AppEnv>, next: () => Promise<void>) {
  const key = c.req.param('key') ?? '';
  if (!key.startsWith('challenge:')) return next();
  const r = await offerForKey(runtimeFrom(c), key);
  if (!r) return c.json({ error: 'not found' }, 404);
  c.header('cache-control', 'no-store');
  return c.json(r);
}


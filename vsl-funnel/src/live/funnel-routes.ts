import type { Context, Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { ApplicationError } from '../funnel/application';
import {
  closePoll, eventReport, getEvent, getLiveReg, hostAction, hostPing, joinZoom, liveFeed, liveLadder, liveRoomUrl, liveSettings, listEvents, postLiveChat, pushPoll,
  registerLive, roomDeposit, roomState, saveEvent, startLiveTicket, streamKey, teamLiveChat, ticketGate, vote,
} from './events';
import { playbackFor, streamSetup } from './stream';

/**
 * The live funnel's routes, mounted on the existing routers so they inherit their guards:
 *  - mountLiveApi(api): /api/live/* (same-origin only, visitor resolved) and /api/pay (our Whop payment page);
 *  - mountLiveAdmin(admin): /admin/api/live-events/* (admin session required).
 */

const body = async (c: Context<AppEnv>) => {
  const t = await c.req.text().catch(() => '');
  if (!t || t.length > 32_000) return {} as Record<string, unknown>;
  try { const v = JSON.parse(t) as unknown; return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}; } catch { return {}; }
};
const fail = (c: Context<AppEnv>, err: unknown) => {
  if (err instanceof ApplicationError) return c.json({ error: err.message, field: err.field ?? null }, err.status);
  console.error('live api', err);
  return c.json({ error: 'Something went wrong. Please try again.' }, 500);
};

export function mountLiveApi(api: Hono<AppEnv>) {
  api.post('/live/register', async (c) => {
    try {
      const rt = runtimeFrom(c);
      const { reg } = await registerLive(rt, c.get('visitor'), await body(c));
      if (await ticketGate(rt, reg)) {
        const t = await startLiveTicket(rt, reg);
        if (t.url) return c.json({ ok: true, next: t.url, checkout: true });
      }
      return c.json({ ok: true, next: `${liveRoomUrl(rt, reg.token)}?new=1` });
    } catch (err) { return fail(c, err); }
  });
  const withReg = (fn: (rt: ReturnType<typeof runtimeFrom>, reg: NonNullable<Awaited<ReturnType<typeof getLiveReg>>>, b: Record<string, unknown>) => Promise<unknown>) => async (c: Context<AppEnv>) => {
    try {
      const rt = runtimeFrom(c);
      const b = await body(c);
      const reg = typeof b.token === 'string' ? await getLiveReg(rt, b.token) : null;
      if (!reg) return c.json({ ok: false, error: 'Registration not found' }, 404);
      return c.json(await fn(rt, reg, b));
    } catch (err) { return fail(c, err); }
  };
  api.post('/live/feed', withReg(async (rt, reg, b) => ((await ticketGate(rt, reg)) ? { ok: false, gate: true } : liveFeed(rt, reg, b))));
  api.post('/live/chat', withReg((rt, reg, b) => postLiveChat(rt, reg, b)));
  api.post('/live/vote', withReg(async (rt, reg, b) => ((await ticketGate(rt, reg)) ? { ok: false } : vote(rt, reg, b))));
  api.post('/live/join', withReg((rt, reg) => joinZoom(rt, reg)));
  api.post('/live/deposit', withReg(async (rt, reg, b) => ((await ticketGate(rt, reg)) ? { error: 'Your ticket isn’t paid yet.' } : roomDeposit(rt, reg, b))));
  // For the LivePlayer (builder A): the playback for this viewer right now (the Zoom link only inside the join window).
  api.get('/live/status/:token', async (c) => {
    const rt = runtimeFrom(c);
    const reg = await getLiveReg(rt, c.req.param('token'));
    const ev = reg ? await getEvent(rt, reg.event_id) : null;
    if (!reg || !ev || (await ticketGate(rt, reg))) return c.json({ ok: false }, 404);
    const st = await roomState(rt, ev, reg);
    return c.json({ ok: true, stage: st.stage, ...(await playbackFor(rt, streamKey(ev.id), st.joinUrl)) });
  });
  api.post('/pay', async (c) => {
    const b = await body(c);
    const { payEmbedded } = await import('../sales/pay-page');
    return c.json(await payEmbedded(runtimeFrom(c), String(b.ref ?? ''), b.confirmation_token));
  });
}

export function mountLiveAdmin(admin: Hono<AppEnv>) {
  admin.get('/live-events', async (c) => {
    const rt = runtimeFrom(c);
    const q = c.req.query();
    const from = Number(q.from) || 0, to = Number(q.to) || Date.now() + 365 * 86_400_000;
    const { depositConfig, depositCapacity, onboardingUrl } = await import('../sales/deposit');
    const { guarantee, LEGAL_REVIEW_NOTE, guaranteeInAgreements } = await import('../sales/guarantee');
    const { paymentProvider } = await import('../webinar/pass');
    const s = liveSettings(rt);
    const cfg = depositConfig(rt);
    const todo: string[] = [];
    if (paymentProvider(rt.settings) !== 'whop') todo.push('Connect Whop (Integrations → Webinar → Whop API key, then Connect Whop): the deposit and live tickets are paid through Whop.');
    if (cfg.currency === 'USD' && cfg.amount > 2500) todo.push(`Whop caps checkout links at $2,500 until the account is approved for higher ones. The deposit is ${cfg.label}: apply in Whop → Settings → Payments (access higher checkout links). One click on a saved card and our own payment page may be capped too.`);
    if (!onboardingUrl(rt)) todo.push('Set the onboarding call booking link (ENGAGEMENT_ONBOARDING_URL) so deposit buyers book it from the welcome page.');
    return c.json({
      events: await listEvents(rt), ladder: await liveLadder(rt, { from, to }),
      settings: { ticket: s.ticket?.label ?? null, offerHours: s.offerHours, deposit: cfg, cap: await depositCapacity(rt, cfg), onboarding: onboardingUrl(rt), tz: s.tz, guaranteeInAgreements: guaranteeInAgreements(rt.settings) },
      guarantee: { ...guarantee(rt), legalReview: LEGAL_REVIEW_NOTE },
      stream: streamSetup(rt), todo,
    });
  });
  admin.post('/live-events', async (c) => { const r = await saveEvent(runtimeFrom(c), await body(c)); return c.json(r, r.ok ? 200 : 400); });
  admin.get('/live-events/:id', async (c) => { const r = await eventReport(runtimeFrom(c), c.req.param('id')); return r ? c.json(r) : c.json({ error: 'Event not found' }, 404); });
  admin.patch('/live-events/:id', async (c) => { const r = await saveEvent(runtimeFrom(c), await body(c), c.req.param('id')); return c.json(r, r.ok ? 200 : 400); });
  admin.post('/live-events/:id/host', async (c) => { const r = await hostAction(runtimeFrom(c), c.req.param('id'), await body(c)); return c.json(r, r.ok ? 200 : 400); });
  admin.post('/live-events/:id/poll', async (c) => { const r = await pushPoll(runtimeFrom(c), c.req.param('id'), await body(c)); return c.json(r, r.ok ? 200 : 400); });
  admin.post('/live-events/:id/poll/close', async (c) => c.json(await closePoll(runtimeFrom(c), c.req.param('id'))));
  admin.post('/live-events/:id/chat', async (c) => { const r = await teamLiveChat(runtimeFrom(c), c.req.param('id'), await body(c)); return c.json(r, r.ok ? 200 : 400); });
  admin.post('/live-events/:id/ping', async (c) => { const b = await body(c); await hostPing(runtimeFrom(c), c.req.param('id'), String(b.host ?? 'hq')); return c.json({ ok: true }); });
}

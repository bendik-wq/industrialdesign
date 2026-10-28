import { type Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { type AppEnv, runtimeFrom } from '../app';
import { ApplicationError, saveAnswer, saveContact, submitApplication } from '../funnel/application';
import { getLead } from '../funnel/leads';
import { confirmClientBooking, markBooked } from '../integrations/booking';
import { webCallConfig } from '../integrations/voice';
import { VOICE_AGENT } from '../config';
import { identityFromVisitor, track } from '../tracking/track';
import { COOKIE, resolveVisitor } from '../lib/identity';
import { type CollectPayload, collect } from '../tracking/collect';
import { parseHeartbeat, recordHeartbeat } from '../tracking/vsl';
import { transcribe } from '../lib/speech';
import { addPhone, answerPoll, askQuestion, logCalc, offerClick, selfServeAgreement, thankYouAnswer, unlockBonus } from '../webinar/room';
import { getRegistration, getSession, heartbeat, markCta, markJoinedLive, moveRegistration, phase, register, webinarBase } from '../webinar/webinar';

export const api = new Hono<AppEnv>();

const MAX_BODY = 32_000;

/** sendBeacon posts text/plain (no CORS preflight), so parse the raw text as JSON. */
async function readJson<T>(req: Request): Promise<T | null> {
  const text = await req.text();
  if (!text || text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Only accept beacons/API calls from our own pages. */
api.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'forbidden' }, 403);
  // State-changing calls must look like they came from our own page. A real browser always sends an
  // Origin or a Sec-Fetch-Site on a POST; a scripted client that sends neither is rejected, so it can't
  // POST around the Origin check. GET beacons (which some browsers send without either) stay open.
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin') return c.json({ error: 'forbidden' }, 403);
    if (!origin && !(site === 'same-origin')) return c.json({ error: 'forbidden' }, 403);
  }
  c.set('visitor', await resolveVisitor(c, 'beacon'));
  await next();
});

// Client interaction events + browser context.
api.post('/e', async (c) => {
  const body = await readJson<CollectPayload>(c.req.raw);
  if (!body) return c.body(null, 204);
  const ids = await collect(runtimeFrom(c), c.get('visitor'), body);
  return c.json({ ok: true, ids });
});

// VSL player heartbeats.
api.post('/v', async (c) => {
  const hb = parseHeartbeat(await readJson(c.req.raw));
  if (!hb) return c.body(null, 204);
  await recordHeartbeat(runtimeFrom(c), c.get('visitor'), hb);
  return c.body(null, 204);
});

// Cookie consent (EU).
api.post('/consent', async (c) => {
  const body = await readJson<{ granted?: boolean }>(c.req.raw);
  const granted = body?.granted === true;
  setCookie(c, COOKIE.consent, granted ? '1' : '0', { path: '/', maxAge: 180 * 86400, sameSite: 'Lax', secure: new URL(c.req.url).protocol === 'https:' });
  // Withdrawing consent removes the advertising cookies straight away.
  if (!granted) { deleteCookie(c, COOKIE.fbp, { path: '/' }); deleteCookie(c, COOKIE.fbc, { path: '/' }); }
  return c.json({ ok: true, granted });
});

function errorResponse(c: Context<AppEnv>, err: unknown) {
  if (err instanceof ApplicationError) return c.json({ error: err.message, field: err.field ?? null }, err.status);
  console.error('application error', err);
  return c.json({ error: 'Something went wrong — please try again.' }, 500);
}

// Application step 1 (contact) — creates the lead.
api.post('/apply/contact', async (c) => {
  try {
    const body = (await readJson<Record<string, unknown>>(c.req.raw)) ?? {};
    const { lead, eventId } = await saveContact(runtimeFrom(c), c.get('visitor'), body);
    return c.json({ ok: true, ref: lead.ref_code, leadEventId: eventId, firstName: lead.first_name });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Application steps 2..n — one answer at a time, so partial answers are never lost.
api.post('/apply/answer', async (c) => {
  try {
    const v = c.get('visitor');
    const lead = v.leadId ? await getLead(c.env, v.leadId) : null;
    if (!lead) throw new ApplicationError('Your session expired — please start again', 'contact', 409);
    const body = (await readJson<{ question?: string; value?: unknown }>(c.req.raw)) ?? {};
    const { step } = await saveAnswer(runtimeFrom(c), v, lead, body.question, body.value);
    return c.json({ ok: true, step });
  } catch (err) {
    return errorResponse(c, err);
  }
});

api.post('/apply/submit', async (c) => {
  try {
    const v = c.get('visitor');
    const lead = v.leadId ? await getLead(c.env, v.leadId) : null;
    if (!lead) throw new ApplicationError('Your session expired — please start again', 'contact', 409);
    const body = (await readJson<{ event_id?: string }>(c.req.raw)) ?? {};
    const result = await submitApplication(runtimeFrom(c), v, lead, body.event_id);
    return c.json({ ok: true, next: result.route, tier: result.tier, events: result.events });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// Talk instead of type: turn a short voice clip from the application into text with Cloudflare Workers AI
// (Whisper, on our own Cloudflare account). Only mid-application (a lead exists), rate-limited, never stored.
api.post('/apply/transcribe', async (c) => {
  const rt = runtimeFrom(c);
  const v = c.get('visitor');
  if (rt.settings.VOICE_INPUT.trim().toLowerCase() === 'off') return c.json({ error: 'off' }, 404);
  if (!c.env.AI) return c.json({ error: 'Voice isn’t available right now. Please type your answer.' }, 503);
  if (!v.leadId) return c.json({ error: 'Your session expired — please start again' }, 409);
  const type = (c.req.header('content-type') || '').split(';')[0].trim();
  if (!/^audio\/(webm|mp4|ogg|mpeg|wav|x-m4a|aac)$/.test(type)) return c.json({ error: 'Unsupported audio' }, 415);
  const audio = await c.req.arrayBuffer();
  if (audio.byteLength < 800) return c.json({ text: '' });
  if (audio.byteLength > 4_000_000) return c.json({ error: 'That was a long one — please keep it under 2 minutes.' }, 413);
  const k = `stt:${v.leadId}`;
  const row = await c.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(k).first<{ value: string }>();
  const r0 = (() => { try { const r = JSON.parse(row?.value ?? '{}') as { n?: number; t?: number }; return r.t && Date.now() - r.t < 3_600_000 ? { n: r.n ?? 0, t: r.t } : { n: 0, t: Date.now() }; } catch { return { n: 0, t: Date.now() }; } })();
  if (r0.n >= 40) return c.json({ error: 'Please type the rest of your answers.' }, 429);
  await c.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, JSON.stringify({ n: r0.n + 1, t: r0.t })).run();
  try {
    return c.json({ text: await transcribe(c.env.AI, audio) });
  } catch (err) {
    console.error('speech-to-text', String(err).slice(0, 300));
    return c.json({ error: 'Didn’t catch that' }, 502);
  }
});

// Calendly's embed reports a booking via postMessage; the browser relays it here.
// It's unverified, so the signed webhook (if connected) later confirms it with the call time.
api.post('/booking/client', async (c) => {
  const v = c.get('visitor');
  const lead = v.leadId ? await getLead(c.env, v.leadId) : null;
  if (!lead) return c.json({ ok: false }, 404);
  const body = (await readJson<{ provider?: string; event_uri?: string }>(c.req.raw)) ?? {};
  const ref = typeof body.event_uri === 'string' ? body.event_uri.slice(0, 300) : null;
  const rt = runtimeFrom(c);
  if (String(body.provider ?? 'calendly') === 'calendly') await confirmClientBooking(rt, lead, ref);
  else await markBooked(rt, lead, { callAt: null, provider: `${String(body.provider).slice(0, 20)}-client`, ref, verified: false });
  return c.json({ ok: true, next: '/breakout' });
});

// ── Webinar ──
api.post('/webinar/register', async (c) => {
  try {
    const body = (await readJson<Record<string, unknown>>(c.req.raw)) ?? {};
    const rt = runtimeFrom(c);
    const { registration } = await register(rt, c.get('visitor'), body);
    return c.json({ ok: true, next: `${webinarBase(rt)}/registered/${registration.token}` });
  } catch (err) {
    return errorResponse(c, err);
  }
});
async function webinarReg(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const body = (await readJson<Record<string, unknown>>(c.req.raw)) ?? {};
  const reg = typeof body.token === 'string' ? await getRegistration(rt, body.token) : null;
  const session = reg ? await getSession(rt, reg.session_id) : null;
  return { rt, body, reg, session };
}
api.post('/webinar/hb', async (c) => {
  const { rt, body, reg, session } = await webinarReg(c);
  if (!reg || !session) return c.json({ ok: false }, 404);
  return c.json(await heartbeat(rt, reg, session, body));
});
api.post('/webinar/join', async (c) => {
  const { rt, reg, session } = await webinarReg(c);
  const open = session && session.mode === 'live' && Date.now() >= session.starts_at - 10 * 60_000 && ['waiting', 'running'].includes(phase(rt, session));
  if (!reg || !session || !open) return c.json({ ok: false }, 404);
  await markJoinedLive(rt, reg, session);
  return c.json({ ok: true, url: session.join_url });
});
api.post('/webinar/cta', async (c) => {
  const { rt, reg } = await webinarReg(c);
  if (!reg) return c.json({ ok: false }, 404);
  await markCta(rt, reg);
  return c.json({ ok: true });
});
// ── Inside the masterclass room ──
const roomAction = (fn: (rt: ReturnType<typeof runtimeFrom>, reg: NonNullable<Awaited<ReturnType<typeof getRegistration>>>, body: Record<string, unknown>, session: NonNullable<Awaited<ReturnType<typeof getSession>>>) => Promise<unknown>) => async (c: Context<AppEnv>) => {
  try {
    const { rt, body, reg, session } = await webinarReg(c);
    if (!reg || !session) return c.json({ ok: false }, 404);
    return c.json(await fn(rt, reg, body, session));
  } catch (err) {
    return errorResponse(c, err);
  }
};
api.post('/webinar/poll', roomAction((rt, reg, body) => answerPoll(rt, reg, body)));
api.post('/webinar/ask', roomAction((rt, reg, body) => askQuestion(rt, reg, body)));
api.post('/webinar/calc', roomAction((rt, reg, body) => logCalc(rt, reg, body)));
api.post('/webinar/bonus', roomAction(async (rt, reg, body, session) => ({ ...(await unlockBonus(rt, reg, session, body)), url: `${webinarBase(rt)}/worksheet/${reg.token}` })));
api.post('/webinar/offer', roomAction((rt, reg, body) => offerClick(rt, reg, body)));
api.post('/webinar/start', roomAction((rt, reg) => selfServeAgreement(rt, reg)));
api.post('/webinar/commit', roomAction((rt, reg, body) => thankYouAnswer(rt, reg, body)));
api.post('/webinar/phone', async (c) => roomAction((rt, reg, body) => addPhone(rt, reg, body, c.get('visitor').geo.country))(c));
api.post('/webinar/move', async (c) => {
  try {
    const { rt, body, reg } = await webinarReg(c);
    if (!reg) return c.json({ ok: false, error: 'Link not found' }, 404);
    const { registration } = await moveRegistration(rt, reg, String(body.session_id ?? ''));
    return c.json({ ok: true, next: `${webinarBase(rt)}/registered/${registration.token}` });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// "Talk now" browser call: only for applicants, rate-limited, never for people who opted out.
api.post('/voice/start', async (c) => {
  const v = c.get('visitor');
  const lead = v.leadId ? await getLead(c.env, v.leadId) : null;
  if (!lead) return c.json({ error: 'Apply first, then you can talk to the assistant.' }, 403);
  if (lead.do_not_call_at) return c.json({ error: 'You asked us not to call you, so voice calls are switched off for you. Message us on WhatsApp or email instead.' }, 403);
  const rt = runtimeFrom(c);
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE lead_id = ? AND name = 'voice_web_start' AND ts > ?").bind(lead.id, Date.now() - 86_400_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= VOICE_AGENT.webCallsPerDay) return c.json({ error: 'You’ve reached today’s limit for assistant calls. Book a time with the team instead.' }, 429);
  const cfg = await webCallConfig(rt, lead);
  if (!cfg) return c.json({ error: 'Voice calls are not available right now.' }, 503);
  // The click on "Start the call" next to the AI + recording disclosure is the consent; keep a record of what they saw.
  await track(rt, identityFromVisitor(v, null, lead.id), { name: 'voice_web_start', source: 'server', props: { disclosure: VOICE_AGENT.disclosureVersion, text: VOICE_AGENT.webDisclosure } });
  return c.json({ ok: true, ...cfg });
});

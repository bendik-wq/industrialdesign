import { type Context, Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { type AppEnv, runtimeFrom } from '../app';
import { ApplicationError, saveAnswer, saveContact, submitApplication } from '../funnel/application';
import { getLead } from '../funnel/leads';
import { markBooked } from '../integrations/booking';
import { webCallConfig } from '../integrations/voice';
import { VOICE_AGENT } from '../config';
import { identityFromVisitor, track } from '../tracking/track';
import { COOKIE, resolveVisitor } from '../lib/identity';
import { type CollectPayload, collect } from '../tracking/collect';
import { parseHeartbeat, recordHeartbeat } from '../tracking/vsl';

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

// Calendly's embed reports a booking via postMessage; the browser relays it here.
// It's unverified, so the signed webhook (if connected) later confirms it with the call time.
api.post('/booking/client', async (c) => {
  const v = c.get('visitor');
  const lead = v.leadId ? await getLead(c.env, v.leadId) : null;
  if (!lead) return c.json({ ok: false }, 404);
  const body = (await readJson<{ provider?: string; event_uri?: string }>(c.req.raw)) ?? {};
  const ref = typeof body.event_uri === 'string' ? body.event_uri.slice(0, 300) : null;
  await markBooked(runtimeFrom(c), lead, { callAt: null, provider: `${String(body.provider ?? 'calendly').slice(0, 20)}-client`, ref, verified: false });
  return c.json({ ok: true, next: '/breakout' });
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

import { mountDmHooks } from '../dm/routes';
import { handleInboundSms, sendSmsNow, verifyTelnyx, verifyTwilio } from '../integrations/sms';
import { type Context, Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { handleCalendly, handleGenericBooking, verifyCalendly } from '../integrations/booking';
import { handleInbound, verifyMetaSignature } from '../integrations/whatsapp';
import { type VapiMessage, handleVapi, verifyVapi } from '../integrations/voice';
import { type Conversation, handleElevenWebhook, verifyElevenSignature } from '../integrations/elevenlabs';
import { finishInbound, initiationData } from '../integrations/elevenlabs-inbound';
import { hmacHex, safeEqual } from '../lib/crypto';
import { handleResendEvent, verifyResend } from '../integrations/bounces';
import { handleStripeEvent, verifyStripeSignature } from '../webinar/pass';
import { handleWhopEvent, verifyWhopSignature } from '../webinar/whop';
import { bodyId, onceOnly } from '../lib/webhook-events';

/**
 * Inbound webhooks from Resend (bounces), Calendly, Cal.com / CRMs, the WhatsApp Cloud API, Vapi and ElevenLabs (voice). All verified.
 * Resend, Calendly, ElevenLabs and WhatsApp events are recorded in webhook_events (src/lib/webhook-events.ts): a provider's retry of
 * an event already handled gets 200 without running it again; a run that failed runs again on the retry (the route answers 5xx);
 * a copy arriving while the first is still running gets 409 (the provider retries it later).
 */
export const hooks = new Hono<AppEnv>();
mountDmHooks(hooks); // Instagram DMs: GET/POST /hooks/instagram (src/dm/routes.ts)

hooks.post('/calendly', async (c) => {
  const rt = runtimeFrom(c);
  const raw = await c.req.text();
  if (!rt.settings.CALENDLY_SIGNING_KEY) return c.json({ error: 'Calendly signing key not configured' }, 501);
  if (!(await verifyCalendly(rt.settings.CALENDLY_SIGNING_KEY, raw, c.req.header('calendly-webhook-signature') ?? null))) return c.json({ error: 'bad signature' }, 401);
  let body: Parameters<typeof handleCalendly>[1];
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  // Calendly sends no event id: the invitee URI is unique per booking, and each event type happens once per invitee.
  const id = body?.payload?.uri ? `${body.event}:${body.payload.uri}` : await bodyId(raw);
  return once(c, await onceOnly(rt.env, 'calendly', id, () => handleCalendly(rt, body), { kind: body?.event }));
});

/** The answer for a webhook run through onceOnly: the handler's result, or 200 for a duplicate, or 409 while a copy is running. */
function once(c: Context<AppEnv>, r: { ran: true; result: unknown } | { ran: false; duplicate: boolean; inProgress: boolean }, ok?: (result: unknown) => Response) {
  if (r.ran) return ok ? ok(r.result) : c.json(r.result as Record<string, unknown>);
  return r.inProgress ? c.json({ error: 'already processing' }, 409) : c.json({ ok: true, duplicate: true });
}

// Twilio: replies and STOP to our texts (signed with the auth token; fails closed without one).
hooks.post('/twilio/sms', async (c) => {
  const rt = runtimeFrom(c);
  const token = rt.settings.TWILIO_AUTH_TOKEN;
  if (!token) return c.text('not configured', 501);
  const form = await c.req.parseBody();
  const params = Object.fromEntries(Object.entries(form).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  const url = `${rt.origin}${new URL(c.req.url).pathname}`;
  if (!(await verifyTwilio(token, url, params, c.req.header('x-twilio-signature') ?? null))) return c.text('bad signature', 401);
  const { reply } = await handleInboundSms(rt, params);
  const xml = reply ? `<Response><Message>${reply.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Message></Response>` : '<Response/>';
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>${xml}`, 200, { 'content-type': 'text/xml' });
});

// Telnyx: replies and STOP to our texts (Ed25519-signed; fails closed without the key). Telnyx doesn't take an inline
// reply, so a "C" confirmation answer is sent as a new text. STOP/START are also handled by Telnyx itself.
hooks.post('/telnyx/sms', async (c) => {
  const rt = runtimeFrom(c);
  if (!String(rt.settings.TELNYX_API_KEY ?? '').trim()) return c.text('not configured', 501);
  const raw = await c.req.text();
  if (!(await verifyTelnyx(rt, raw, c.req.header('telnyx-signature-ed25519') ?? null, c.req.header('telnyx-timestamp') ?? null))) return c.text('bad signature', 401);
  let body: { data?: { id?: string; event_type?: string; payload?: { id?: string; direction?: string; text?: string; from?: { phone_number?: string } } } };
  try { body = JSON.parse(raw); } catch { return c.json({ error: 'invalid json' }, 400); }
  const ev = body.data;
  if (!ev?.id || ev.event_type !== 'message.received' || !ev.payload?.from?.phone_number) return c.json({ ok: true, ignored: ev?.event_type ?? null });
  const p = ev.payload;
  return once(c, await onceOnly(rt.env, 'telnyx', ev.id, async () => {
    const r = await handleInboundSms(rt, { From: p.from!.phone_number!, Body: p.text ?? '', MessageSid: p.id ?? ev.id! });
    if (r.reply) await sendSmsNow(rt, p.from!.phone_number!, r.reply).catch((e) => console.error('telnyx reply', String(e).slice(0, 200)));
    return { ok: true, kind: r.kind };
  }, { kind: 'message.received' }));
});

// Resend: hard bounces and spam complaints block the address everywhere (Svix-signed; fails closed).
hooks.post('/resend', async (c) => {
  const rt = runtimeFrom(c);
  const secret = rt.settings.RESEND_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'RESEND_WEBHOOK_SECRET not configured' }, 501);
  const raw = await c.req.text();
  const svixId = c.req.header('svix-id');
  const ok = await verifyResend(secret, raw, { id: svixId, timestamp: c.req.header('svix-timestamp'), signature: c.req.header('svix-signature') });
  if (!ok || !svixId) return c.json({ error: 'bad signature' }, 401);
  let body: Parameters<typeof handleResendEvent>[1];
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  // svix-id is the same on every retry of one event.
  return once(c, await onceOnly(rt.env, 'resend', svixId, () => handleResendEvent(rt, body), { kind: body?.type }));
});

// Stripe: masterclass offer and seat payments, refunds (Stripe-Signature, 5-minute tolerance; fails closed).
hooks.post('/stripe', async (c) => {
  const rt = runtimeFrom(c);
  const secret = rt.settings.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'STRIPE_WEBHOOK_SECRET not configured' }, 501);
  const raw = await c.req.text();
  if (!(await verifyStripeSignature(secret, raw, c.req.header('stripe-signature')))) return c.json({ error: 'bad signature' }, 400);
  let body: Parameters<typeof handleStripeEvent>[1];
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  return c.json({ received: true, ...(await handleStripeEvent(rt, body)) });
});

// Whop: ticket and Sprint payments, refunds (Standard Webhooks signature, 5-minute tolerance; fails closed).
hooks.post('/whop', async (c) => {
  const rt = runtimeFrom(c);
  const secret = rt.settings.WHOP_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'WHOP_WEBHOOK_SECRET not configured' }, 501);
  const raw = await c.req.text();
  const h = { id: c.req.header('webhook-id'), timestamp: c.req.header('webhook-timestamp'), signature: c.req.header('webhook-signature') };
  if (!h.id || !h.timestamp || !h.signature) return c.json({ error: 'unsigned' }, 400);
  if (!(await verifyWhopSignature(secret, raw, h))) return c.json({ error: 'bad signature' }, 401);
  let body: Parameters<typeof handleWhopEvent>[1];
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  return c.json({ received: true, ...(await handleWhopEvent(rt, body)) });
});

hooks.post('/booking', async (c) => {
  const rt = runtimeFrom(c);
  const secret = rt.settings.BOOKING_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'BOOKING_WEBHOOK_SECRET not configured' }, 501);
  const raw = await c.req.text();
  const calSig = c.req.header('x-cal-signature-256');
  const ok = calSig ? safeEqual(await hmacHex(secret, raw), calSig) : safeEqual(c.req.query('secret') ?? '', secret);
  if (!ok) return c.json({ error: 'unauthorised' }, 401);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  return c.json(await handleGenericBooking(rt, body));
});

// Meta webhook verification handshake.
hooks.get('/whatsapp', (c) => {
  const s = c.get('settings');
  if (c.req.query('hub.mode') === 'subscribe' && s.WHATSAPP_VERIFY_TOKEN && safeEqual(c.req.query('hub.verify_token') ?? '', s.WHATSAPP_VERIFY_TOKEN)) {
    return c.text(c.req.query('hub.challenge') ?? '');
  }
  return c.text('forbidden', 403);
});

hooks.post('/whatsapp', async (c) => {
  const rt = runtimeFrom(c);
  const raw = await c.req.text();
  if (!rt.settings.WHATSAPP_APP_SECRET) return c.json({ error: 'WHATSAPP_APP_SECRET not configured' }, 501);
  if (!(await verifyMetaSignature(rt.settings.WHATSAPP_APP_SECRET, raw, c.req.header('x-hub-signature-256') ?? null))) return c.text('bad signature', 401);
  let body: Parameters<typeof handleInbound>[1];
  try {
    body = JSON.parse(raw);
  } catch {
    return c.text('bad json', 400);
  }
  // Meta sends no delivery id and its signature has no timestamp: a retry (or a replay) is the same bytes, so the body
  // hash dedupes it; single messages are also checked by their wamid in handleInbound.
  return once(c, await onceOnly(rt.env, 'whatsapp', await bodyId(raw), () => handleInbound(rt, body)), () => c.text('ok'));
});

// Vapi server messages: assistant-request (inbound phone), tool-calls, status-update, end-of-call-report.
hooks.post('/voice', async (c) => {
  const rt = runtimeFrom(c);
  if (!rt.settings.VOICE_WEBHOOK_SECRET) return c.json({ error: 'VOICE_WEBHOOK_SECRET not configured' }, 501);
  if (!verifyVapi(rt.settings, c.req.header('x-vapi-secret'))) return c.json({ error: 'unauthorised' }, 401);
  let body: { message?: VapiMessage };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  return c.json((await handleVapi(rt, body.message ?? {})) ?? {});
});

// ElevenLabs post-call webhook (post_call_transcription, call_initiation_failure). HMAC-signed.
hooks.post('/elevenlabs', async (c) => {
  const rt = runtimeFrom(c);
  const secret = rt.settings.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'ELEVENLABS_WEBHOOK_SECRET not configured' }, 501);
  const raw = await c.req.text();
  if (!(await verifyElevenSignature(secret, raw, c.req.header('elevenlabs-signature') ?? null))) return c.json({ error: 'unauthorised' }, 401);
  let body: { type?: string; data?: Record<string, unknown> };
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const inboundAgent = rt.settings.ELEVENLABS_INBOUND_AGENT_ID;
  const conv = typeof body.data?.conversation_id === 'string' ? body.data.conversation_id : null;
  // One post-call event per conversation and type; ElevenLabs retries the same one.
  const id = conv ? `${body.type ?? 'event'}:${conv}` : await bodyId(raw);
  return once(c, await onceOnly(rt.env, 'elevenlabs', id, async () => {
    if (inboundAgent && body.type === 'post_call_transcription' && body.data?.agent_id === inboundAgent) await finishInbound(rt, { ...(body.data as unknown as Conversation), status: 'done' });
    else await handleElevenWebhook(rt, body);
  }, { kind: body.type }), () => c.text('ok'));
});

// ElevenLabs asks who's calling as an inbound call rings (caller ID → lead), to personalise the callback agent.
hooks.post('/elevenlabs/init', async (c) => {
  const body = await c.req.json<{ caller_id?: string; agent_id?: string }>().catch(() => ({}));
  const data = await initiationData(runtimeFrom(c), c.req.header('x-funnel-secret'), body);
  return data ? c.json(data) : c.json({ error: 'unauthorised' }, 401);
});

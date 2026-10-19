import { handleInboundSms, verifyTwilio } from '../integrations/sms';
import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { handleCalendly, handleGenericBooking, verifyCalendly } from '../integrations/booking';
import { handleInbound, verifyMetaSignature } from '../integrations/whatsapp';
import { type VapiMessage, handleVapi, verifyVapi } from '../integrations/voice';
import { type Conversation, handleElevenWebhook, verifyElevenSignature } from '../integrations/elevenlabs';
import { finishInbound, initiationData } from '../integrations/elevenlabs-inbound';
import { hmacHex, safeEqual } from '../lib/crypto';
import { handleResendEvent, verifyResend } from '../integrations/bounces';

/** Inbound webhooks from Resend (bounces), Calendly, Cal.com / CRMs, the WhatsApp Cloud API, Vapi and ElevenLabs (voice). All verified. */
export const hooks = new Hono<AppEnv>();

hooks.post('/calendly', async (c) => {
  const rt = runtimeFrom(c);
  const raw = await c.req.text();
  if (!rt.settings.CALENDLY_SIGNING_KEY) return c.json({ error: 'Calendly signing key not configured' }, 501);
  if (!(await verifyCalendly(rt.settings.CALENDLY_SIGNING_KEY, raw, c.req.header('calendly-webhook-signature') ?? null))) return c.json({ error: 'bad signature' }, 401);
  return c.json(await handleCalendly(rt, JSON.parse(raw)));
});

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

// Resend: hard bounces and spam complaints block the address everywhere (Svix-signed; fails closed).
hooks.post('/resend', async (c) => {
  const rt = runtimeFrom(c);
  const secret = rt.settings.RESEND_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'RESEND_WEBHOOK_SECRET not configured' }, 501);
  const raw = await c.req.text();
  const ok = await verifyResend(secret, raw, { id: c.req.header('svix-id'), timestamp: c.req.header('svix-timestamp'), signature: c.req.header('svix-signature') });
  if (!ok) return c.json({ error: 'bad signature' }, 401);
  let body: Parameters<typeof handleResendEvent>[1];
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  return c.json(await handleResendEvent(rt, body));
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
  await handleInbound(rt, JSON.parse(raw));
  return c.text('ok');
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
  if (inboundAgent && body.type === 'post_call_transcription' && body.data?.agent_id === inboundAgent) await finishInbound(rt, { ...(body.data as unknown as Conversation), status: 'done' });
  else await handleElevenWebhook(rt, body);
  return c.text('ok');
});

// ElevenLabs asks who's calling as an inbound call rings (caller ID → lead), to personalise the callback agent.
hooks.post('/elevenlabs/init', async (c) => {
  const body = await c.req.json<{ caller_id?: string; agent_id?: string }>().catch(() => ({}));
  const data = await initiationData(runtimeFrom(c), c.req.header('x-funnel-secret'), body);
  return data ? c.json(data) : c.json({ error: 'unauthorised' }, 401);
});

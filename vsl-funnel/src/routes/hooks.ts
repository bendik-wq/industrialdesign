import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { handleCalendly, handleGenericBooking, verifyCalendly } from '../integrations/booking';
import { handleInbound, verifyMetaSignature } from '../integrations/whatsapp';
import { hmacHex, safeEqual } from '../lib/crypto';

/** Inbound webhooks from Calendly, Cal.com / CRMs and the WhatsApp Cloud API. All verified. */
export const hooks = new Hono<AppEnv>();

hooks.post('/calendly', async (c) => {
  const rt = runtimeFrom(c);
  const raw = await c.req.text();
  if (!rt.settings.CALENDLY_SIGNING_KEY) return c.json({ error: 'Calendly signing key not configured' }, 501);
  if (!(await verifyCalendly(rt.settings.CALENDLY_SIGNING_KEY, raw, c.req.header('calendly-webhook-signature') ?? null))) return c.json({ error: 'bad signature' }, 401);
  return c.json(await handleCalendly(rt, JSON.parse(raw)));
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
  if (c.req.query('hub.mode') === 'subscribe' && s.WHATSAPP_VERIFY_TOKEN && c.req.query('hub.verify_token') === s.WHATSAPP_VERIFY_TOKEN) {
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

import type { Runtime } from '../app';
import { safeEqual } from '../lib/crypto';
import { saveSettings } from '../settings';

/** Bounce and spam-complaint handling: Resend tells us, we stop emailing that address everywhere, for good. */

export const RESEND_EVENTS = ['email.bounced', 'email.complained'] as const;

const norm = (e: string) => e.trim().toLowerCase();

/** Resend signs webhooks the Svix way: base64 HMAC-SHA256 of `id.timestamp.body`, keyed by the decoded `whsec_` secret. */
export async function verifyResend(secret: string, raw: string, h: { id?: string | null; timestamp?: string | null; signature?: string | null }, now = Date.now()) {
  if (!h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (ch) => ch.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h.id}.${h.timestamp}.${raw}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return h.signature.split(' ').some((part) => {
    const [v, sig] = part.split(',');
    return v === 'v1' && !!sig && safeEqual(sig, expected);
  });
}

export async function isSuppressed(rt: Runtime, email: string) {
  const row = await rt.env.DB.prepare('SELECT reason FROM email_suppressions WHERE email = ?').bind(norm(email)).first<{ reason: string }>();
  return row?.reason ?? null;
}

/** Block an address: remember it, mark the lead unsubscribed, cancel everything queued for it. */
export async function suppressEmail(rt: Runtime, email: string, reason: 'bounced' | 'complained' | 'manual', detail?: string | null, providerId?: string | null) {
  const e = norm(email);
  if (!e.includes('@')) return { email: e, cancelled: 0 };
  const now = Date.now();
  const res = await rt.env.DB.batch([
    rt.env.DB.prepare('INSERT INTO email_suppressions (email, reason, detail, provider_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
      .bind(e, reason, detail?.slice(0, 500) ?? null, providerId ?? null, now),
    rt.env.DB.prepare('UPDATE leads SET unsubscribed_at = ? WHERE lower(email) = ? AND unsubscribed_at IS NULL').bind(now, e),
    rt.env.DB.prepare("UPDATE emails SET status = 'cancelled', error = ? WHERE lower(to_email) = ? AND status IN ('pending', 'sending')").bind(reason, e),
    ...(providerId ? [rt.env.DB.prepare('UPDATE emails SET error = ? WHERE provider_id = ?').bind(reason, providerId)] : []),
  ]);
  return { email: e, cancelled: res[2]?.meta?.changes ?? 0 };
}

interface ResendEvent {
  type?: string;
  data?: { email_id?: string; to?: string[] | string; bounce?: { type?: string; subType?: string; message?: string } };
}

export async function handleResendEvent(rt: Runtime, ev: ResendEvent) {
  const to = ev.data?.to;
  const list = (Array.isArray(to) ? to : to ? [to] : []).filter((x): x is string => typeof x === 'string');
  if (ev.type === 'email.bounced') {
    // Resend only reports permanent bounces here; a soft one marked Transient is left alone just in case.
    if (/transient/i.test(ev.data?.bounce?.type ?? '')) return { ignored: 'transient bounce' };
    const detail = [ev.data?.bounce?.type, ev.data?.bounce?.subType, ev.data?.bounce?.message].filter(Boolean).join(' · ');
    return { blocked: await Promise.all(list.map((e) => suppressEmail(rt, e, 'bounced', detail, ev.data?.email_id))) };
  }
  if (ev.type === 'email.complained') return { blocked: await Promise.all(list.map((e) => suppressEmail(rt, e, 'complained', 'marked as spam', ev.data?.email_id))) };
  return { ignored: ev.type ?? 'unknown' };
}

/** One click in Funnel HQ: create the Resend webhook for bounces + complaints and keep its signing secret. */
export async function connectResendWebhook(rt: Runtime) {
  if (!rt.settings.RESEND_API_KEY) throw new Error('Add the Resend API key first.');
  const endpoint = `${rt.origin}/hooks/resend`;
  const res = await fetch('https://api.resend.com/webhooks', {
    method: 'POST',
    headers: { authorization: `Bearer ${rt.settings.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, events: RESEND_EVENTS }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; signing_secret?: string; message?: string };
  if (!res.ok || !body.signing_secret) throw new Error(`Resend said ${res.status}: ${body.message ?? 'no signing secret returned'}. If your API key is "sending access" only, create the webhook in Resend → Webhooks (${endpoint}, events: email.bounced, email.complained) and paste its signing secret under Email.`);
  await saveSettings(rt.env, { RESEND_WEBHOOK_SECRET: body.signing_secret });
  return { endpoint, id: body.id };
}

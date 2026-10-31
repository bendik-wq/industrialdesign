import type { Runtime } from '../app';
import { safeEqual } from '../lib/crypto';
import { saveSettings } from '../settings';
import { getLead } from '../funnel/leads';
import {
  type PaidEffects, type PassConfig, type PassKind, type PassRow, PassError, formatMoney, fromMinor, markPassPaid, markPassRefunded, passPaidEffects, toMinor,
} from './pass';
import type { Registration } from './webinar';

/**
 * Whop as the payment provider (WHOP_API_KEY set). Every checkout is a Whop checkout configuration with an
 * inline one-time plan at the exact price (the ticket, or the Sprint after the ticket credit), our ids in its
 * metadata and a redirect back to our site. Payments carry that metadata, so the webhook finds the purchase.
 *
 *  - Requests are pinned to one Api-Version-Date, so the payment shape (total as a number, metadata,
 *    checkout_configuration_id) and the checkout_configuration_ids filter stay what this code reads.
 *  - Webhooks are Standard Webhooks: HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${raw body}`, keyed
 *    with the literal bytes of the `ws_…` secret, base64 in `webhook-signature: v1,<sig>`; 5-minute tolerance.
 *  - Whop caps checkout links at $2,500 until the account is approved for higher ones (Whop → Settings →
 *    Payments). The Sprint is above that, so a refused checkout shows the viewer Try again and Email the team, alerts the
 *    team on Slack with the cause, and shows a health note in Funnel HQ.
 */

export const WHOP_API = 'https://api.whop.com/api/v1';
export const WHOP_API_VERSION = '2026-08-14';
/** Every event the Whop webhook must send (Funnel HQ lists them; Connect Whop subscribes to them). */
export const WHOP_EVENTS = ['payment.succeeded', 'refund.created', 'refund.updated'] as const;
/** Whop's checkout-link cap for accounts not yet approved for higher ones (USD). */
export const WHOP_CHECKOUT_CAP = 2500;
/** What the viewer sees when Whop refuses a checkout (with Try again and Email the team next to it). */
export const CHECKOUT_UNAVAILABLE = 'Checkout didn’t open just now. Try again in a minute, or email the team and they send you a payment link.';
/** Found or created by external id, so every checkout reuses the same two (hidden) Whop products. */
export const WHOP_PRODUCT: Record<PassKind, string> = { seat: 'vsl-funnel-masterclass-ticket', offer: 'vsl-funnel-first-deal-sprint' };

export class WhopError extends Error {
  constructor(public status: number, message: string, public code: string | null = null) { super(message); }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * The payments API that charges a saved method (POST /payments, its status, payment quotes) is Whop's
 * newer native API: those calls are pinned to this version instead.
 */
export const WHOP_NATIVE_VERSION = '2026-10-29-8';

export async function whopApi<T>(rt: Runtime, method: 'GET' | 'POST', path: string, body?: unknown, o: { version?: string; idempotencyKey?: string } = {}): Promise<T> {
  const key = String(rt.settings.WHOP_API_KEY ?? '').trim();
  if (!key) throw new WhopError(0, 'Whop is not connected');
  const res = await fetch(`${WHOP_API}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`, 'api-version-date': o.version ?? WHOP_API_VERSION, accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(o.idempotencyKey ? { 'idempotency-key': o.idempotencyKey } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: string }; message?: string };
  if (!res.ok) throw new WhopError(res.status, `Whop ${res.status}: ${json.error?.message ?? json.message ?? 'request failed'}`, json.error?.code ?? null);
  return json;
}

/** Whop money: a number in major units (the pinned API), or { amount: "200.00", currency } (newer shapes). */
export function whopMoney(v: unknown): { major: number; currency: string | null } | null {
  if (typeof v === 'number' && Number.isFinite(v)) return { major: v, currency: null };
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return { major: Number(v), currency: null };
  const o = obj(v);
  const n = Number(o.amount);
  return o.amount != null && Number.isFinite(n) ? { major: n, currency: str(o.currency) } : null;
}

/** WHOP_COMPANY_ID, or the API key's own account (saved for next time). */
export async function whopCompanyId(rt: Runtime) {
  const set = String(rt.settings.WHOP_COMPANY_ID ?? '').trim();
  if (set) return set;
  const me = await whopApi<{ id?: string }>(rt, 'GET', 'accounts/me');
  if (!me.id) throw new WhopError(0, 'Whop returned no company id for this API key');
  await saveSettings(rt.env, { WHOP_COMPANY_ID: me.id });
  (rt.settings as Record<string, string>).WHOP_COMPANY_ID = me.id;
  return me.id;
}

// ───────────── Checkout ─────────────

export interface WhopCheckoutInput {
  passId: string; kind: PassKind; reg: Pick<Registration, 'id' | 'token' | 'lead_id'>;
  /** Smallest currency unit, as on the pass row. */
  amount: number; currency: string;
  title: string; description: string; redirectUrl: string;
  metadata?: Record<string, string>;
}

/** The request body for POST /checkout_configurations (exported for the tests). */
export function whopCheckoutBody(companyId: string, o: WhopCheckoutInput) {
  return {
    plan: {
      company_id: companyId,
      currency: o.currency.toLowerCase(),
      initial_price: fromMinor(o.amount, o.currency),
      plan_type: 'one_time',
      release_method: 'buy_now',
      visibility: 'hidden',
      title: o.title,
      description: o.description,
      product: { external_identifier: WHOP_PRODUCT[o.kind], title: o.title, visibility: 'hidden' },
    },
    metadata: { pass_id: o.passId, reg_id: o.reg.id, reg_token: o.reg.token, lead_id: o.reg.lead_id, kind: o.kind, ...o.metadata },
    redirect_url: o.redirectUrl,
  };
}


/**
 * Creates the Whop checkout for a pending pass row and stores its id and link on the row. If Whop refuses
 * (the $2,500 checkout-link cap, or anything else), the row is closed, the team is alerted and the viewer
 * gets CHECKOUT_UNAVAILABLE.
 */
export async function startWhopCheckout(rt: Runtime, o: WhopCheckoutInput): Promise<string> {
  try {
    const companyId = await whopCompanyId(rt);
    const r = await whopApi<{ id?: string; purchase_url?: string }>(rt, 'POST', 'checkout_configurations', whopCheckoutBody(companyId, o));
    if (!r.id || !r.purchase_url) throw new WhopError(0, 'Whop returned no checkout link');
    await rt.env.DB.prepare("UPDATE webinar_passes SET stripe_session_id = ?, checkout_url = ?, provider = 'whop', updated_at = ? WHERE id = ?").bind(r.id, r.purchase_url, Date.now(), o.passId).run();
    await noteCheckoutOk(rt, o.amount, o.currency);
    return r.purchase_url;
  } catch (e) {
    await rt.env.DB.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ?").bind(Date.now(), o.passId).run();
    console.error('whop checkout failed', String(e).slice(0, 300));
    await checkoutFailed(rt, { kind: o.kind, amount: o.amount, currency: o.currency, title: o.title, error: e, leadId: o.reg.lead_id }).catch((x) => console.error('whop failure alert', x));
    throw new PassError(CHECKOUT_UNAVAILABLE, 503);
  }
}

/** Whop's refusal most likely comes from the checkout-link cap: its message says so, or the price is over the cap. */
export function isCheckoutLimitError(message: string, status: number, major: number, currency: string) {
  if (/2,?500|checkout link|higher.{0,20}(link|limit|price)|exceed.{0,30}(limit|maximum|max)|maximum.{0,20}(price|amount)|price.{0,20}(limit|too high)/i.test(message)) return true;
  return status >= 400 && status < 500 && status !== 401 && currency.toUpperCase() === 'USD' && major > WHOP_CHECKOUT_CAP;
}

const kvSet = (rt: Runtime, key: string, value: string) =>
  rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
const kvGet = async (rt: Runtime, key: string) => (await rt.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null;
const kvJson = async <T>(rt: Runtime, key: string): Promise<T | null> => { try { const v = await kvGet(rt, key); return v ? (JSON.parse(v) as T) : null; } catch { return null; } };

export interface WhopCheckoutError { at: number; kind: PassKind; title: string; amount: string; status: number; message: string; limit: boolean }

async function noteCheckoutOk(rt: Runtime, amount: number, currency: string) {
  await rt.env.DB.prepare("DELETE FROM kv_state WHERE key = 'whop:checkout_error'").run();
  if (currency.toUpperCase() === 'USD' && fromMinor(amount, currency) > WHOP_CHECKOUT_CAP) await kvSet(rt, 'whop:above_cap_ok', String(Date.now()));
}

const ALERT_EVERY_MS = 3_600_000;

/** Remembers the refusal for Funnel HQ and tells the team (at most once an hour per cause). */
export async function checkoutFailed(rt: Runtime, o: { kind: PassKind; amount: number; currency: string; title: string; error: unknown; leadId: string }, now = Date.now()) {
  const message = (o.error instanceof Error ? o.error.message : String(o.error)).slice(0, 300);
  const status = o.error instanceof WhopError ? o.error.status : 0;
  const major = fromMinor(o.amount, o.currency);
  const label = formatMoney(major, o.currency.toUpperCase());
  const limit = isCheckoutLimitError(message, status, major, o.currency);
  const rec: WhopCheckoutError = { at: now, kind: o.kind, title: o.title, amount: label, status, message, limit };
  await kvSet(rt, 'whop:checkout_error', JSON.stringify(rec));
  const last = await kvJson<{ at: number; limit: boolean }>(rt, 'whop:checkout_alert');
  if (last && last.limit === limit && now - last.at < ALERT_EVERY_MS) return { alerted: false, limit };
  await kvSet(rt, 'whop:checkout_alert', JSON.stringify({ at: now, limit }));
  const lead = await getLead(rt.env, o.leadId);
  const { notify } = await import('../integrations/notify');
  rt.waitUntil(notify(rt, {
    kind: 'hot_lead',
    title: `Whop refused a ${o.title} checkout (${label})`,
    lead,
    lines: [
      limit
        ? `Cause: Whop caps checkout links at ${formatMoney(WHOP_CHECKOUT_CAP, 'USD')} until the account is approved for higher ones. Apply in Whop → Settings → Payments (access higher checkout links); Whop reviews it within 24 hours.`
        : `Whop said: ${message}`,
      `The buyer saw: ${CHECKOUT_UNAVAILABLE}. Reach out to them directly.`,
    ],
  }).catch((e) => console.error('whop alert failed', e)));
  return { alerted: true, limit };
}

// ───────────── Webhook ─────────────

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));

/**
 * Standard Webhooks, as Whop signs them: `webhook-signature` holds one or more space-separated `v1,<base64>`;
 * each is HMAC-SHA256 of `${webhook-id}.${webhook-timestamp}.${raw body}` keyed with the secret's literal UTF-8
 * bytes (the whole `ws_…` string, prefix included). The timestamp must be within the tolerance. Every
 * candidate is compared in constant time, with no early exit.
 */
export async function verifyWhopSignature(secret: string, payload: string, h: { id?: string | null; timestamp?: string | null; signature?: string | null }, now = Date.now(), toleranceSec = 300) {
  if (!secret || !h.id || !h.timestamp || !h.signature) return false;
  if (!/^\d{1,12}$/.test(h.timestamp.trim())) return false;
  if (Math.abs(now / 1000 - Number(h.timestamp)) > toleranceSec) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = b64(await crypto.subtle.sign('HMAC', key, enc.encode(`${h.id}.${h.timestamp.trim()}.${payload}`)));
  let ok = false;
  for (const part of h.signature.trim().split(/\s+/)) {
    const i = part.indexOf(',');
    if (i < 1) continue;
    if (part.slice(0, i) === 'v1' && safeEqual(part.slice(i + 1), expected)) ok = true;
  }
  return ok;
}

const passBy = (rt: Runtime, col: 'id' | 'stripe_session_id' | 'stripe_payment_intent', v: string) =>
  rt.env.DB.prepare(`SELECT * FROM webinar_passes WHERE ${col} = ?`).bind(v).first<PassRow>();

/** A paid Whop payment → the purchase it belongs to (our metadata, or our checkout configuration id). */
export async function whopPaymentPaid(rt: Runtime, pay: Obj, effects: PaidEffects = passPaidEffects) {
  const meta = obj(pay.metadata) as Record<string, string>;
  const chId = str(pay.checkout_configuration_id);
  let row = str(meta.pass_id) ? await passBy(rt, 'id', meta.pass_id) : null;
  if (!row && chId) row = await passBy(rt, 'stripe_session_id', chId);
  if (!row && !str(meta.reg_id)) return { ignored: 'not a masterclass checkout' };
  const status = str(pay.status);
  if (status && status !== 'paid') return { ignored: `payment ${status}` };
  const money = whopMoney(pay.total) ?? whopMoney(pay.subtotal);
  const currency = (str(pay.currency) ?? money?.currency ?? row?.currency ?? 'usd').toLowerCase();
  const payId = str(pay.id);
  const sessionId = row?.stripe_session_id ?? chId ?? (payId ? `whop_${payId}` : null);
  if (!sessionId) return { ignored: 'no checkout reference' };
  const r = await markPassPaid(rt, {
    sessionId, paymentIntent: payId, amount: money ? toMinor(money.major, currency) : null, currency,
    regId: str(meta.reg_id) ?? row?.reg_id ?? null, passId: row?.id ?? str(meta.pass_id), kind: str(meta.kind) ?? row?.kind ?? null, provider: 'whop',
  }, effects);
  // Keep the buyer's member and saved payment method: the ticket's card is what one-click charges for the Sprint.
  if (r.ok) await storePaymentMethod(rt, r.pass.id, pay).catch((e) => console.error('whop payment method', String(e).slice(0, 200)));
  return r.ok ? { paid: r.pass.id, duplicate: r.duplicate } : { ignored: r.reason };
}

export interface SavedMethod { memberId: string; paymentMethodId: string; brand: string | null; last4: string | null }

/** The member, saved method and card from a Whop payment, in either shape (pinned: nested objects; native: ids). */
export function paymentMethodOf(pay: Obj): Partial<SavedMethod> {
  const pm = obj(pay.payment_method), card = obj(pm.card), inst = obj(obj(pay.payment_instrument).card);
  return {
    memberId: str(pay.member_id) ?? str(obj(pay.member).id) ?? undefined,
    paymentMethodId: str(pay.payment_method_id) ?? str(pm.id) ?? undefined,
    brand: str(pay.card_brand) ?? str(card.brand) ?? str(inst.brand),
    last4: str(pay.card_last4) ?? str(card.last4) ?? str(inst.last4),
  };
}

/** Stores the payment's member and method on the purchase, asking Whop for the payment when the event left them out. */
export async function storePaymentMethod(rt: Runtime, passId: string, pay: Obj) {
  let m = paymentMethodOf(pay);
  const payId = str(pay.id);
  if ((!m.memberId || !m.paymentMethodId) && payId && rt.settings.WHOP_API_KEY) {
    const full = await whopApi<Obj>(rt, 'GET', `payments/${encodeURIComponent(payId)}`).catch(() => null);
    if (full) m = { ...paymentMethodOf(full), ...Object.fromEntries(Object.entries(m).filter(([, v]) => v)) };
  }
  if (!m.memberId || !m.paymentMethodId) return false;
  await rt.env.DB.prepare(
    'UPDATE webinar_passes SET whop_member_id = ?, whop_payment_method_id = ?, card_brand = COALESCE(?, card_brand), card_last4 = COALESCE(?, card_last4) WHERE id = ?',
  ).bind(m.memberId, m.paymentMethodId, m.brand ?? null, m.last4 ?? null, passId).run();
  return true;
}

/** A succeeded Whop refund → withdraw the purchase (full) or record what was returned (partial). */
export async function whopRefund(rt: Runtime, rf: Obj) {
  const status = str(rf.status);
  if (status && status !== 'succeeded') return { ignored: `refund ${status}` };
  const pay = obj(rf.payment);
  const payId = str(pay.id) ?? str(rf.payment_id);
  const meta = obj(pay.metadata) as Record<string, string>;
  const row = (payId ? await passBy(rt, 'stripe_payment_intent', payId) : null) ?? (str(meta.pass_id) ? await passBy(rt, 'id', meta.pass_id) : null);
  if (!row) return { ignored: 'not a masterclass payment' };
  let total = whopMoney(pay.refunded_amount);
  if (!total && payId && rt.settings.WHOP_API_KEY) {
    // The refund event carries this refund only: ask for the payment's running total (several partial refunds).
    total = await whopApi<Obj>(rt, 'GET', `payments/${encodeURIComponent(payId)}`).then((p) => whopMoney(p.refunded_amount)).catch(() => null);
  }
  const one = whopMoney(rf.amount);
  const refunded = Math.max(total ? toMinor(total.major, row.currency) : 0, one ? toMinor(one.major, row.currency) : 0, row.refunded_amount ?? 0);
  const fully = row.amount <= 0 || refunded >= row.amount;
  const r = await markPassRefunded(rt, { paymentIntent: payId, passId: row.id, amountRefunded: Math.min(refunded, row.amount), fully });
  return r.ok ? { refunded: true, ...r } : { ignored: r.reason };
}

/** Verified Whop webhook events. Anything without our metadata (the company sells other products) is ignored. */
export async function handleWhopEvent(rt: Runtime, ev: { type?: string; data?: unknown }, effects: PaidEffects = passPaidEffects) {
  const type = String(ev.type ?? '');
  const data = obj(ev.data);
  if (type === 'payment.succeeded') return whopPaymentPaid(rt, data, effects);
  if (type === 'refund.created' || type === 'refund.updated') return whopRefund(rt, data);
  return { ignored: type || 'unknown' };
}

/** Back from Whop with ?pass=success: look the payment up by our checkout configuration, in case the webhook hasn't arrived. */
export async function whopConfirm(rt: Runtime, row: PassRow, effects: PaidEffects = passPaidEffects): Promise<'paid' | 'pending' | 'unknown'> {
  if (!rt.settings.WHOP_API_KEY || !row.stripe_session_id) return 'unknown';
  // A one-click payment (back from 3D Secure, or still settling): its own status decides.
  if (row.stripe_session_id.startsWith('whop_pay_')) return (await import('./one-click')).settleOneClick(rt, row, effects);
  try {
    const q = new URLSearchParams({ company_id: await whopCompanyId(rt), first: '10' });
    q.append('checkout_configuration_ids', row.stripe_session_id);
    const list = await whopApi<{ data?: Obj[] }>(rt, 'GET', `payments?${q}`);
    // Only a payment that names this checkout (or this purchase) counts, whatever the filter returned.
    const pay = (list.data ?? []).find((p) => p.status === 'paid' && (p.checkout_configuration_id === row.stripe_session_id || obj(p.metadata).pass_id === row.id));
    if (!pay) return 'pending';
    const r = await whopPaymentPaid(rt, pay, effects);
    return 'paid' in r ? 'paid' : 'pending';
  } catch (e) {
    console.error('whop payment lookup failed', String(e).slice(0, 200));
    return 'unknown';
  }
}

// ───────────── Funnel HQ ─────────────

export const whopWebhookUrl = (rt: Runtime) => `${rt.origin}/hooks/whop`;

/** The manual webhook steps, for when the API key can't create webhooks. */
export const whopWebhookSteps = (url: string) => [
  'In Whop, open Dashboard → Developer and choose Create webhook.',
  `Endpoint URL: ${url}`,
  `Events: ${WHOP_EVENTS.join(', ')} (API version v1).`,
  'Copy the secret from the webhook’s Secret column, paste it into “Whop webhook secret” under Integrations → Webinar, and save.',
];

/**
 * One click in Funnel HQ: read the company behind the API key (fills WHOP_COMPANY_ID) and, when the key may
 * manage webhooks, create the webhook for /hooks/whop and keep its secret. Otherwise returns the steps.
 */
export async function connectWhop(rt: Runtime) {
  if (!String(rt.settings.WHOP_API_KEY ?? '').trim()) throw new Error('Add the Whop API key under Integrations → Webinar and save first.');
  const me = await whopApi<{ id?: string; title?: string }>(rt, 'GET', 'accounts/me');
  if (!me.id) throw new Error('Whop returned no company for this API key.');
  if (rt.settings.WHOP_COMPANY_ID !== me.id) await saveSettings(rt.env, { WHOP_COMPANY_ID: me.id });
  const url = whopWebhookUrl(rt);
  let existing: { id?: string; url?: string; enabled?: boolean } | undefined;
  try {
    const list = await whopApi<{ data?: { id?: string; url?: string; enabled?: boolean }[] }>(rt, 'GET', `webhooks?company_id=${encodeURIComponent(me.id)}`);
    existing = (list.data ?? []).find((w) => w.url === url);
  } catch { /* listing needs its own permission; creating may still work */ }
  let webhook: { created: boolean; id: string | null; enabled?: boolean; note?: string };
  if (existing && rt.settings.WHOP_WEBHOOK_SECRET) {
    webhook = { created: false, id: existing.id ?? null, enabled: existing.enabled, note: existing.enabled === false ? 'The webhook exists but Whop has disabled it. Enable it in Whop → Developer.' : 'The webhook is already set up.' };
  } else if (existing) {
    webhook = { created: false, id: existing.id ?? null, note: 'A webhook for this URL already exists in Whop, but Whop only shows its secret in the dashboard. Copy it from Whop → Developer (Secret column) into “Whop webhook secret”, or delete that webhook and press Connect Whop again.' };
  } else {
    try {
      const w = await whopApi<{ id?: string; webhook_secret?: string }>(rt, 'POST', 'webhooks', { url, events: [...WHOP_EVENTS], api_version_date: WHOP_API_VERSION, resource_id: me.id, enabled: true });
      if (!w.webhook_secret) throw new Error('Whop returned no webhook secret');
      await saveSettings(rt.env, { WHOP_WEBHOOK_SECRET: w.webhook_secret });
      webhook = { created: true, id: w.id ?? null };
    } catch (e) {
      webhook = { created: false, id: null, note: `Whop didn’t let this key create the webhook (${String(e instanceof Error ? e.message : e).slice(0, 160)}). Set it up by hand with the steps below.` };
    }
  }
  const ready = webhook.created || Boolean(existing && rt.settings.WHOP_WEBHOOK_SECRET);
  return { company: { id: me.id, title: me.title ?? null }, webhookUrl: url, events: [...WHOP_EVENTS], webhook, steps: ready ? [] : whopWebhookSteps(url) };
}

/** Health for Funnel HQ: company, webhook, the last refused checkout, and the $2,500 cap against the Sprint price. */
export async function whopHealth(rt: Runtime, cfg: Pick<PassConfig, 'price' | 'currency' | 'offerName' | 'priceLabel'>) {
  const lastError = await kvJson<WhopCheckoutError>(rt, 'whop:checkout_error');
  const aboveCapOk = Boolean(await kvGet(rt, 'whop:above_cap_ok'));
  const overCap = cfg.currency.toUpperCase() === 'USD' && cfg.price > WHOP_CHECKOUT_CAP;
  const url = whopWebhookUrl(rt);
  const cap = formatMoney(WHOP_CHECKOUT_CAP, 'USD');
  const notes: { level: 'warn' | 'info'; text: string }[] = [];
  if (lastError?.limit) notes.push({ level: 'warn', text: `Whop refused a ${lastError.title} checkout for ${lastError.amount} on ${new Date(lastError.at).toUTCString()}: Whop caps checkout links at ${cap} until the account is approved for higher ones. Apply in Whop → Settings → Payments (access higher checkout links). Until then buyers see “${CHECKOUT_UNAVAILABLE}” with Try again and Email the team, and the team gets a Slack alert.` });
  else if (lastError) notes.push({ level: 'warn', text: `Whop refused the last ${lastError.title} checkout (${new Date(lastError.at).toUTCString()}): ${lastError.message}` });
  const denied = await kvJson<{ at: number; message: string }>(rt, 'whop:charge_denied');
  if (denied) notes.push({ level: 'warn', text: `One-click Sprint payments are failing (${new Date(denied.at).toUTCString()}): the Whop API key can’t charge saved cards (${denied.message}). In Whop → Dashboard → Developer → API keys, give this key the payment:charge permission. Until then those buyers go through the form and checkout.` });
  if (!rt.settings.WHOP_WEBHOOK_SECRET) notes.push({ level: 'warn', text: `No Whop webhook secret yet. Press “Connect Whop” on Integrations, or set the webhook up by hand: ${url}, events ${WHOP_EVENTS.join(', ')}. Without it payments still confirm when buyers come back from Whop, but refunds and closed tabs are missed.` });
  return { companyId: rt.settings.WHOP_COMPANY_ID || null, webhookSecret: Boolean(rt.settings.WHOP_WEBHOOK_SECRET), webhookUrl: url, events: [...WHOP_EVENTS], lastError, overCap, aboveCapOk, notes };
}

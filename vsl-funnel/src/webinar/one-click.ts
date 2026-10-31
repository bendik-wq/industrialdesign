import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { getLead } from '../funnel/leads';
import { identityFromLead, track } from '../tracking/track';
import { type PaidEffects, type PassRow, PassError, formatMoney, fromMinor, markPassPaid, passCapacity, passCopy, passPaidEffects, toMinor } from './pass';
import { createSprintCheckout, sprintBuyGate, sprintPrice, sprintStartUrl, sprintWelcomeUrl, ticketCredit, WHOP_SPRINT_LIFE_MS } from './sprint';
import { WHOP_NATIVE_VERSION, WHOP_PRODUCT, WhopError, storePaymentMethod, whopApi, whopCompanyId, whopMoney } from './whop';
import type { Registration } from './webinar';

/**
 * One-click First Deal Sprint for viewers who bought their Masterclass ticket through Whop.
 *
 * The ticket's payment left a Whop member and a saved payment method (stored on the ticket's row by the
 * webhook). In the room and on the offer page the Sprint button then opens a small confirm step (what is
 * charged, to which card, with Whop's service fee) and charges that method with Whop's Create Payment, as
 * a customer-initiated payment (off_session false: the buyer is there to pass 3D Secure).
 *
 *  - Same gate as checkout (sprintBuyGate). One attempt in flight per registration: the row insert is
 *    guarded by a partial unique index, and Whop gets the row id as the Idempotency-Key, so a double click
 *    never charges twice.
 *  - succeeded → paid now (the payment.succeeded webhook arrives later as a duplicate); still settling → the
 *    Sprint page waits ("confirming"); 3D Secure → the buyer goes to Whop's page and returns to the Sprint
 *    page; declined, no permission or any error → the normal flow (form, then checkout) with a short note,
 *    and the team hears about a missing payment:charge permission once.
 *  - One-click buyers skip the form before paying: the same questions wait on the Sprint page as its intake.
 */

type RegLike = Registration & { offer_unlocked_at?: number | null };
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

export interface StoredMethod { member_id: string; payment_method_id: string; card_brand: string | null; card_last4: string | null }

/** The method saved from the lead's paid Whop ticket (the newest one), if any. */
export async function savedTicketMethod(rt: Runtime, leadId: string) {
  return (await rt.env.DB.prepare(
    `SELECT whop_member_id AS member_id, whop_payment_method_id AS payment_method_id, card_brand, card_last4 FROM webinar_passes
      WHERE lead_id = ? AND kind = 'seat' AND status = 'paid' AND provider = 'whop' AND whop_member_id IS NOT NULL AND whop_payment_method_id IS NOT NULL
      ORDER BY paid_at DESC LIMIT 1`,
  ).bind(leadId).first<StoredMethod>())
    // Or the card saved with a First Deal Challenge ticket (challenge/payments.ts).
    ?? (await import('../challenge/payments')).savedChallengeMethod(rt, leadId);
}

const BRANDS: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', american_express: 'American Express', discover: 'Discover', jcb: 'JCB', diners: 'Diners Club', unionpay: 'UnionPay' };
/** "Visa ending 4242", or null when the method isn't a card we can name. */
export function cardLabel(brand: string | null | undefined, last4: string | null | undefined) {
  if (!last4 || !/^\d{4}$/.test(last4)) return null;
  const b = brand ? BRANDS[brand.toLowerCase()] ?? brand.charAt(0).toUpperCase() + brand.slice(1).toLowerCase() : 'card';
  return `${b} ending ${last4}`;
}

/** Whop's buyer service fee, in percent (WHOP_BUYER_FEE_PERCENT; blank = 5, the account's setting; 0 = none). */
export function buyerFeePercent(s: Partial<Record<string, string>>) {
  const raw = String(s.WHOP_BUYER_FEE_PERCENT ?? '').trim();
  if (!raw) return 5;
  const n = Number(raw.replace('%', ''));
  return Number.isFinite(n) && n >= 0 && n <= 25 ? n : 5;
}

/** Every visible string of the one-click step (checked by auditCopy in the tests). */
export function oneClickCopy(o: { card: string | null; total?: string }) {
  return {
    confirmHeading: 'Confirm your payment',
    charged: o.card ? `Charged to the ${o.card} you used for your ticket.` : 'Charged to the payment method you used for your ticket.',
    confirmButton: `Confirm and pay ${o.total ?? ''}`.trim(),
    otherCard: 'Use a different card',
    paying: 'Taking your payment…',
    declined: 'Your card wasn’t charged. Answer a few questions and finish at secure checkout instead.',
    unavailable: 'One-click payment isn’t available right now. Answer a few questions and finish at secure checkout instead.',
  };
}

/** What the room and the offer page need to offer one click (null = the normal flow). */
export async function oneClickInfo(rt: Runtime, reg: Pick<Registration, 'lead_id'>) {
  const { passConfig } = await import('./pass');
  if (passConfig(rt.settings).provider !== 'whop') return null;
  const m = await savedTicketMethod(rt, reg.lead_id);
  if (!m) return null;
  const card = cardLabel(m.card_brand, m.card_last4);
  return { card, copy: oneClickCopy({ card }) };
}

const variantFor = (cfg: { offerName: string; currency: string }, amount: number, description: string) => ({
  currency: cfg.currency.toLowerCase(),
  billing_type: 'one_time',
  initial_price: fromMinor(amount, cfg.currency),
  title: cfg.offerName,
  description,
  visibility: 'hidden',
  product: { external_identifier: WHOP_PRODUCT.offer, title: cfg.offerName, visibility: 'hidden' },
});
const description = (cfg: { offerName: string }, creditLabel: string | null) =>
  `${cfg.offerName}: seven days with G&L M&A Advisory.${creditLabel ? ` Your ${creditLabel} masterclass ticket is credited.` : ''} The full fee is credited against the advisory engagement if you continue.`;

/**
 * The confirm step's numbers: the price after the ticket credit, tax when a Whop payment quote finds some,
 * Whop's service fee, and the total. Nothing is charged here.
 */
export async function oneClickQuote(rt: Runtime, reg: RegLike, o: { ip?: string | null; now?: number } = {}) {
  const g = await sprintBuyGate(rt, reg, o.now ?? Date.now(), 'one_click');
  if (g.paid) return { paid: true as const, next: sprintWelcomeUrl(rt, reg.token) };
  const { cfg } = g;
  const m = cfg.provider === 'whop' ? await savedTicketMethod(rt, reg.lead_id) : null;
  if (!m) return { paid: false as const, fallback: sprintStartUrl(rt, reg.token) };
  const credit = await ticketCredit(rt, reg.lead_id, cfg.currency);
  const price = sprintPrice(cfg, null, credit);
  const money = (minor: number) => formatMoney(fromMinor(minor, cfg.currency), cfg.currency);
  let tax = 0;
  if (o.ip) {
    // Best effort: a quote located by IP prices tax for display (it is a preview and can't be paid).
    try {
      const q = await whopApi<Obj>(rt, 'POST', 'payment_quotes', { account_id: await whopCompanyId(rt), variant: variantFor(cfg, price.today, description(cfg, price.creditLabel)), ip_address: o.ip }, { version: WHOP_NATIVE_VERSION });
      const t = whopMoney(q.tax_amount);
      if (t && t.major > 0 && q.tax_behavior !== 'inclusive') tax = toMinor(t.major, cfg.currency);
    } catch (e) { console.error('whop quote', String(e).slice(0, 200)); }
  }
  const pct = buyerFeePercent(rt.settings);
  const fee = Math.round((price.today + tax) * pct / 100);
  const total = price.today + tax + fee;
  const card = cardLabel(m.card_brand, m.card_last4);
  const lines = [
    { label: price.credit ? `${cfg.offerName} (${cfg.priceLabel} less your ${price.creditLabel} ticket)` : cfg.offerName, amount: money(price.today) },
    ...(tax ? [{ label: 'Tax', amount: money(tax) }] : []),
    ...(fee ? [{ label: `Whop service fee (${pct}%)`, amount: money(fee) }] : []),
  ];
  return { paid: false as const, card, lines, total: money(total), copy: oneClickCopy({ card, total: money(total) }) };
}

const MIN = 60_000;
const kvSet = (rt: Runtime, key: string, value: string) =>
  rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();

/** The key can't charge saved methods: remember it for Funnel HQ and tell the team (once a day). */
async function chargeDenied(rt: Runtime, message: string, leadId: string, now = Date.now()) {
  const prev = await rt.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'whop:charge_denied'").first<{ value: string }>();
  let last = 0;
  try { last = prev ? Number((JSON.parse(prev.value) as { alerted?: number }).alerted ?? 0) : 0; } catch { /* rewritten below */ }
  const alert = now - last > 24 * 60 * MIN;
  await kvSet(rt, 'whop:charge_denied', JSON.stringify({ at: now, message: message.slice(0, 300), alerted: alert ? now : last }));
  if (!alert) return false;
  const lead = await getLead(rt.env, leadId);
  const { notify } = await import('../integrations/notify');
  rt.waitUntil(notify(rt, {
    kind: 'hot_lead', title: 'One-click Sprint payment refused: the Whop API key can’t charge saved cards', lead,
    lines: [
      `Whop said: ${message.slice(0, 200)}`,
      'Fix: Whop → Dashboard → Developer → API keys → edit the key this funnel uses and add the payment:charge permission (create payments).',
      'The buyer was sent to the normal form and checkout, so the sale isn’t lost. Check they finish it.',
    ],
  }).catch((e) => console.error('one-click alert failed', e)));
  return true;
}

export type OneClickResult =
  | { ok: true; next: string; outcome: 'paid' | 'pending' | 'action' | 'in_flight' }
  | { ok: false; fallback: string; outcome: 'declined' | 'unavailable' | 'no_method' };

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['succeeded', 'requires_action', 'canceled']);

/** The payment's status (native API), polled briefly until it settles one way or the other. */
export async function pollStatus(rt: Runtime, payId: string, o: { tries?: number; sleep?: (ms: number) => Promise<unknown> } = {}) {
  const tries = o.tries ?? 4;
  let st: Obj = {};
  for (let i = 0; i < tries; i++) {
    if (i) await (o.sleep ?? sleepMs)(750);
    st = await whopApi<Obj>(rt, 'GET', `payments/${encodeURIComponent(payId)}/status`, undefined, { version: WHOP_NATIVE_VERSION }).catch(() => ({}));
    const s = str(st.status);
    if (s && (TERMINAL.has(s) || (s === 'requires_confirmation' && st.last_payment_error))) break;
  }
  return st;
}

const failed = (st: Obj) => st.status === 'canceled' || (st.status === 'requires_confirmation' && Boolean(st.last_payment_error));
const actionUrl = (st: Obj) => {
  const na = obj(st.next_action);
  return na.type === 'redirect' ? str(obj(na.data).url) : null;
};

export async function markWhopPaymentPaid(rt: Runtime, row: Pick<PassRow, 'id' | 'reg_id' | 'amount' | 'currency'> & { kind?: PassRow['kind']; whop_payment_method_id?: unknown }, payId: string, effects: PaidEffects) {
  const r = await markPassPaid(rt, { sessionId: `whop_${payId}`, paymentIntent: payId, amount: row.amount, currency: row.currency, regId: row.reg_id, passId: row.id, kind: row.kind ?? 'offer', provider: 'whop' }, effects);
  if ((row.kind ?? 'offer') === 'offer') await rt.env.DB.prepare("DELETE FROM kv_state WHERE key = 'whop:charge_denied'").run();
  // A ticket paid on our own page: keep the card Whop saved with it, for the one-click Sprint.
  if (!row.whop_payment_method_id) await storePaymentMethod(rt, row.id, { id: payId }).catch((e) => console.error('whop payment method', String(e).slice(0, 200)));
  return r;
}

/** POST /api/webinar/sprint/one-click: charge the ticket's saved method for the Sprint. */
export async function oneClickSprint(rt: Runtime, reg: RegLike, o: { now?: number; effects?: PaidEffects; sleep?: (ms: number) => Promise<unknown>; tries?: number } = {}): Promise<OneClickResult> {
  const now = o.now ?? Date.now();
  const effects = o.effects ?? passPaidEffects;
  const welcome = sprintWelcomeUrl(rt, reg.token);
  const start = sprintStartUrl(rt, reg.token);
  const g = await sprintBuyGate(rt, reg, now, 'one_click');
  if (g.paid) return { ok: true, next: welcome, outcome: 'paid' };
  const { cfg, bonus, w, r } = g;
  const who = await identityFromLead(rt.env, r.lead_id);
  const log = (outcome: string, props: Record<string, unknown> = {}) =>
    track(rt, who, { name: 'webinar_offer_one_click', source: 'server', path: '/webinar', props: { outcome, ...props }, localOnly: true }).catch(() => null);
  const m = cfg.provider === 'whop' ? await savedTicketMethod(rt, r.lead_id) : null;
  if (!m) return { ok: false, fallback: start, outcome: 'no_method' };

  const credit = await ticketCredit(rt, r.lead_id, cfg.currency);
  const price = sprintPrice(cfg, null, credit);
  if (price.today <= 0) {
    // The ticket credit covers it: nothing to charge.
    await createSprintCheckout(rt, r, { from: 'room' }, now);
    return { ok: true, next: welcome, outcome: 'paid' };
  }
  const cap = await passCapacity(rt, cfg, now);
  if (cap.full) throw new PassError(passCopy(cfg).soldOut, 409);

  const fast = bonus && w.bonusOpen ? 1 : 0;
  const id = newId('wp');
  const ins = await rt.env.DB.prepare(
    `INSERT OR IGNORE INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, expires_at, list_amount, ticket_credit, installments, fast_bonus, provider, one_click,
       whop_member_id, whop_payment_method_id, card_brand, card_last4, created_at, updated_at)
     VALUES (?, ?, ?, 'offer', ?, 'pending', ?, ?, ?, ?, ?, 1, ?, 'whop', 1, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, r.id, r.lead_id, cfg.offerName, price.today, cfg.currency.toLowerCase(), now + WHOP_SPRINT_LIFE_MS, cfg.amount, price.credit, fast, m.member_id, m.payment_method_id, m.card_brand, m.card_last4, now, now).run();
  // Another click is already being charged: never a second payment. The Sprint page shows how it went.
  if ((ins.meta.changes ?? 0) === 0) return { ok: true, next: welcome, outcome: 'in_flight' };
  const expire = () => rt.env.DB.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), id).run();
  await log('started', { pass_id: id, value: fromMinor(price.today, cfg.currency), fast_bonus: Boolean(fast) });

  let payId: string | null;
  try {
    const pay = await whopApi<Obj>(rt, 'POST', 'payments', {
      account_id: await whopCompanyId(rt),
      variant: variantFor(cfg, price.today, description(cfg, price.creditLabel)),
      member_id: m.member_id,
      payment_method_id: m.payment_method_id,
      off_session: false, // the buyer is here: a customer-initiated payment that can ask for 3D Secure
      return_url: `${welcome}&one_click=1`,
      metadata: { pass_id: id, reg_id: r.id, reg_token: r.token, lead_id: r.lead_id, kind: 'offer', fast_bonus: fast ? '1' : '0', one_click: '1' },
    }, { version: WHOP_NATIVE_VERSION, idempotencyKey: `sprint_one_click_${id}` });
    payId = str(pay.id);
    if (!payId) throw new WhopError(0, 'Whop returned no payment id');
  } catch (e) {
    await expire();
    const status = e instanceof WhopError ? e.status : 0;
    const message = e instanceof Error ? e.message : String(e);
    console.error('one-click payment failed', message.slice(0, 300));
    if (status === 401 || status === 403) await chargeDenied(rt, message, r.lead_id, now).catch((x) => console.error('charge alert', x));
    const declined = /declin|insufficient|do_not_honor|card_/i.test(`${message} ${e instanceof WhopError ? e.code ?? '' : ''}`) && status !== 401 && status !== 403;
    await log(declined ? 'declined' : 'unavailable', { pass_id: id, status });
    return { ok: false, fallback: `${start}?one_click=${declined ? 'declined' : 'unavailable'}`, outcome: declined ? 'declined' : 'unavailable' };
  }
  await rt.env.DB.prepare('UPDATE webinar_passes SET stripe_session_id = COALESCE(stripe_session_id, ?), stripe_payment_intent = ?, updated_at = ? WHERE id = ?').bind(`whop_${payId}`, payId, Date.now(), id).run();

  const st = await pollStatus(rt, payId, { sleep: o.sleep, tries: o.tries });
  const row = { id, reg_id: r.id, amount: price.today, currency: cfg.currency.toLowerCase(), kind: 'offer' as const, whop_payment_method_id: m.payment_method_id };
  if (st.status === 'succeeded') {
    await markWhopPaymentPaid(rt, row, payId, effects);
    await log('paid', { pass_id: id, value: fromMinor(price.today, cfg.currency) });
    return { ok: true, next: welcome, outcome: 'paid' };
  }
  if (st.status === 'requires_action') {
    // 3D Secure: Whop's page, then back to the Sprint page, which asks Whop how it went.
    const url = actionUrl(st) ?? str((await whopApi<Obj>(rt, 'GET', `payments/${encodeURIComponent(payId)}`, undefined, { version: WHOP_NATIVE_VERSION }).catch(() => ({} as Obj))).recovery_url);
    await log('action', { pass_id: id });
    if (url) return { ok: true, next: url, outcome: 'action' };
    return { ok: true, next: welcome, outcome: 'pending' };
  }
  if (failed(st)) {
    await expire();
    await log('declined', { pass_id: id, code: str(obj(st.last_payment_error).code) });
    return { ok: false, fallback: `${start}?one_click=declined`, outcome: 'declined' };
  }
  // Still settling: the Sprint page waits for it, and the webhook marks it paid.
  await log('pending', { pass_id: id });
  return { ok: true, next: welcome, outcome: 'pending' };
}

/** Back on the Sprint page (after 3D Secure, or while it settled): Whop's status decides. */
export async function settleOneClick(rt: Runtime, row: PassRow, effects: PaidEffects = passPaidEffects): Promise<'paid' | 'pending' | 'unknown'> {
  const payId = row.stripe_payment_intent ?? row.stripe_session_id?.replace(/^whop_/, '') ?? null;
  if (!payId) return 'unknown';
  if (row.status === 'paid') return 'paid';
  const st = await pollStatus(rt, payId, { tries: 1 });
  if (st.status === 'succeeded') {
    await markWhopPaymentPaid(rt, row, payId, effects);
    return 'paid';
  }
  if (failed(st)) {
    await rt.env.DB.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), row.id).run();
    return 'unknown';
  }
  return st.status ? 'pending' : 'unknown';
}

/** The one-click attempt that just failed for this registration (the Sprint page sends them to the form). */
export const recentFailedOneClick = (rt: Runtime, regId: string, now = Date.now()) =>
  rt.env.DB.prepare("SELECT id FROM webinar_passes WHERE reg_id = ? AND kind = 'offer' AND one_click = 1 AND status = 'expired' AND updated_at > ? LIMIT 1").bind(regId, now - 30 * MIN).first<{ id: string }>();

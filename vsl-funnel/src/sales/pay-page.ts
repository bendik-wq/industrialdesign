import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { render } from '../funnel/pages';
import { getLead } from '../funnel/leads';
import { hmacHex, safeEqual } from '../lib/crypto';
import { getSecret } from '../lib/secret';
import { newId } from '../lib/ids';
import { identityFromLead, track } from '../tracking/track';
import { type PassKind, type PassRow, formatMoney, fromMinor, passPaidEffects } from '../webinar/pass';
import { ELEMENTS_SRC, ticketPayHtml } from '../webinar/ticket-pay';
import { markWhopPaymentPaid, settleOneClick } from '../webinar/one-click';
import { CHECKOUT_UNAVAILABLE, WHOP_NATIVE_VERSION, WHOP_PRODUCT, WhopError, checkoutFailed, startWhopCheckout, whopApi, whopCompanyId, whopConfirm } from '../webinar/whop';

/**
 * Our own Whop payment page for a purchase row that is already waiting (the engagement deposit, the live
 * webinar ticket): Whop's payment elements on /pay/<id>.<sig> (the same fields and script as the Masterclass
 * ticket page, ticket-pay.js), with Whop's hosted checkout one link away.
 *
 *  - The link is signed (HMAC of the row id), so only the buyer who started the purchase has it.
 *  - The row says what is charged (amount, currency, product); nothing on the page can change it.
 *  - One payment per row (Idempotency-Key = row id). A declined card closes the row and opens a fresh one,
 *    so the buyer can try another card on a new link.
 *  - Paid (here, by the webhook, or back from 3D Secure / hosted checkout) → the row's return_url.
 */

export type PayRow = PassRow & { source?: string | null; ref_id?: string | null; return_url?: string | null; embedded?: number; one_click?: number };

const MIN = 60_000;
export const PAY_LIFE_MS = 24 * 60 * MIN;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const sig = async (rt: Runtime, id: string) => (await hmacHex(await getSecret(rt.env), `pay|${id}`)).slice(0, 24);
export async function payPageUrl(rt: Runtime, id: string) { return `${rt.origin}/pay/${id}.${await sig(rt, id)}`; }

async function rowFromRef(rt: Runtime, ref: string | undefined) {
  const m = /^(wp[0-9a-z]{10,40})\.([0-9a-f]{24})$/.exec(ref ?? '');
  if (!m || !safeEqual(await sig(rt, m[1]), m[2])) return null;
  return rt.env.DB.prepare('SELECT * FROM webinar_passes WHERE id = ?').bind(m[1]).first<PayRow>();
}

export const KIND_TITLE: Partial<Record<PassKind, string>> = { deposit: 'Engagement deposit', live_ticket: 'Live webinar ticket' };

/** Every visible string on the pay page, per product (checked by auditCopy in the tests). Same keys as the ticket page. */
export function payCopy(kind: PassKind, label: string, creditNote: string | null = null) {
  const deposit = kind === 'deposit';
  return {
    eyebrow: KIND_TITLE[kind] ?? 'Payment',
    heading: deposit ? 'Secure your place in the engagement' : 'Get your live webinar ticket',
    lede: deposit
      ? `One payment of ${label}${creditNote ? ` (${creditNote})` : ''}. The full deposit is credited against the engagement fee, and the balance is due when you sign the engagement agreement.`
      : `One payment of ${label}. Your seat is confirmed the moment it goes through, and your room link arrives by email.`,
    saveNote: deposit ? `Whop takes the payment and keeps your card on file securely. Today you pay ${label}.` : `Whop saves your card securely, so the engagement deposit is one click later if you choose it. Today you pay ${label} for your ticket.`,
    button: `Pay ${label}`,
    paying: 'Taking your payment…',
    declined: 'Your card wasn’t charged. Check the details or use another card.',
    failed: 'Payment couldn’t be taken just now. Try again, or pay on Whop’s checkout page.',
    hosted: 'Prefer Whop’s own checkout page?',
    hostedLink: 'Pay there instead',
    loading: 'Loading the secure payment form…',
  };
}

export interface PendingInput {
  kind: PassKind; regId: string; leadId: string; product: string; amount: number; currency: string;
  source?: string | null; refId?: string | null; returnUrl: string; ticketCredit?: number; listAmount?: number | null; embedded?: boolean; now?: number;
}

/** A waiting purchase row for the pay page (an unpaid, uncharged one for the same registration and product is reused). */
export async function pendingRow(rt: Runtime, o: PendingInput) {
  const db = rt.env.DB;
  const now = o.now ?? Date.now();
  const embedded = o.embedded === false ? 0 : 1;
  const prev = await db.prepare("SELECT * FROM webinar_passes WHERE reg_id = ? AND kind = ? AND status = 'pending' AND embedded = 1 ORDER BY created_at DESC LIMIT 1").bind(o.regId, o.kind).first<PayRow>();
  if (prev && embedded && !prev.stripe_payment_intent && prev.amount === o.amount && (prev.expires_at ?? 0) > now) {
    await db.prepare('UPDATE webinar_passes SET return_url = ?, updated_at = ? WHERE id = ?').bind(o.returnUrl, now, prev.id).run();
    return prev.id;
  }
  if (prev && embedded) await db.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, prev.id).run();
  const id = newId('wp');
  await db.prepare(
    `INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, expires_at, list_amount, ticket_credit, provider, embedded, source, ref_id, return_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'whop', ?, ?, ?, ?, ?, ?)`,
  ).bind(id, o.regId, o.leadId, o.kind, o.product, o.amount, o.currency.toLowerCase(), now + PAY_LIFE_MS, o.listAmount ?? null, o.ticketCredit ?? 0, embedded, o.source ?? null, o.refId ?? null, o.returnUrl, now, now).run();
  return id;
}

const variant = (row: PayRow) => ({
  currency: row.currency, billing_type: 'one_time', initial_price: fromMinor(row.amount, row.currency), title: row.product || KIND_TITLE[row.kind] || 'Payment',
  description: row.kind === 'deposit' ? 'Engagement deposit with G&L M&A Advisory, credited in full against the advisory engagement fee.' : `${row.product || 'Live webinar ticket'} with G&L M&A Advisory.`,
  visibility: 'hidden', product: { external_identifier: WHOP_PRODUCT[row.kind], title: row.product || KIND_TITLE[row.kind] || 'Payment', visibility: 'hidden' },
});

/** Opens Whop's hosted checkout for the row (the "Pay there instead" link). */
export async function hostedFor(rt: Runtime, row: PayRow) {
  await rt.env.DB.prepare('UPDATE webinar_passes SET embedded = 0, updated_at = ? WHERE id = ?').bind(Date.now(), row.id).run();
  const reg = { id: row.reg_id, token: row.ref_id ?? row.reg_id, lead_id: row.lead_id };
  return startWhopCheckout(rt, {
    passId: row.id, kind: row.kind, reg, amount: row.amount, currency: row.currency, title: row.product || KIND_TITLE[row.kind] || 'Payment', description: variant(row).description,
    redirectUrl: `${await payPageUrl(rt, row.id)}?return=1`, metadata: { source: row.source ?? '', ref_id: row.ref_id ?? '' },
  });
}

export type PayResult = { ok: true; next: string } | { ok: true; payment: string; client_secret: string | null; settle: string } | { ok: false; error: string; hosted: string; next?: string };

/** POST /api/pay: the payment from the elements' confirmation token. */
export async function payEmbedded(rt: Runtime, ref: string, confirmationToken: unknown): Promise<PayResult> {
  const row = await rowFromRef(rt, ref);
  if (!row) return { ok: false, error: 'This payment link isn’t valid. Go back and press the button again.', hosted: '' };
  const page = await payPageUrl(rt, row.id);
  const settle = `${page}?return=1`;
  const copy = payCopy(row.kind, formatMoney(fromMinor(row.amount, row.currency), row.currency.toUpperCase()));
  if (row.status === 'paid') return { ok: true, next: row.return_url || rt.origin };
  if (row.status !== 'pending') return { ok: false, error: copy.failed, hosted: `${page}?hosted=1` };
  if (row.stripe_payment_intent) {
    const s = await settleOneClick(rt, row, passPaidEffects);
    if (s === 'paid') return { ok: true, next: row.return_url || rt.origin };
    if (s === 'pending') return { ok: true, next: settle };
  }
  const ctok = str(confirmationToken);
  if (!ctok || !/^ctok_[A-Za-z0-9_]{4,120}$/.test(ctok)) return { ok: false, error: copy.failed, hosted: `${page}?hosted=1` };
  let pay: Record<string, unknown>;
  try {
    pay = await whopApi<Record<string, unknown>>(rt, 'POST', 'payments', {
      account_id: await whopCompanyId(rt), variant: variant(row), confirmation_token: ctok, setup_future_usage: 'off_session', return_url: settle,
      metadata: { pass_id: row.id, reg_id: row.reg_id, lead_id: row.lead_id, kind: row.kind, source: row.source ?? '', ref_id: row.ref_id ?? '', embedded: '1' },
    }, { version: WHOP_NATIVE_VERSION, idempotencyKey: `pay_${row.id}` });
    if (!str(pay.id)) throw new WhopError(0, 'Whop returned no payment id');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = e instanceof WhopError ? e.status : 0;
    const declined = status !== 401 && status !== 403 && /declin|insufficient|do_not_honor|card_|incorrect|expired/i.test(`${message} ${e instanceof WhopError ? e.code ?? '' : ''}`);
    console.error('pay page payment failed', message.slice(0, 300));
    if (!declined) await checkoutFailed(rt, { kind: row.kind, amount: row.amount, currency: row.currency, title: row.product || 'Payment', error: e, leadId: row.lead_id }).catch(() => null);
    // A fresh row (and link) for the next card: the idempotency key of this one is spent.
    await rt.env.DB.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), row.id).run();
    const fresh = await pendingRow(rt, { kind: row.kind, regId: row.reg_id, leadId: row.lead_id, product: row.product || '', amount: row.amount, currency: row.currency, source: row.source, refId: row.ref_id, returnUrl: row.return_url || rt.origin, ticketCredit: row.ticket_credit, listAmount: row.list_amount });
    return { ok: false, error: declined ? copy.declined : copy.failed, hosted: `${await payPageUrl(rt, fresh)}?hosted=1`, next: `${await payPageUrl(rt, fresh)}?e=${declined ? 'declined' : 'failed'}` };
  }
  const payId = str(pay.id)!;
  await rt.env.DB.prepare('UPDATE webinar_passes SET stripe_session_id = COALESCE(stripe_session_id, ?), stripe_payment_intent = ?, updated_at = ? WHERE id = ?').bind(`whop_${payId}`, payId, Date.now(), row.id).run();
  await track(rt, await identityFromLead(rt.env, row.lead_id), { name: 'webinar_checkout_started', source: 'server', props: { pass_id: row.id, kind: row.kind, from: 'pay_page', provider: 'whop', embedded: true }, localOnly: true }).catch(() => null);
  if (pay.status === 'paid') {
    await markWhopPaymentPaid(rt, row, payId, passPaidEffects);
    return { ok: true, next: row.return_url || rt.origin };
  }
  return { ok: true, payment: payId, client_secret: str(pay.client_secret), settle };
}

/** GET /pay/:ref */
export async function payPage(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const row = await rowFromRef(rt, c.req.param('ref'));
  if (!row) return c.text('This payment link isn’t valid. Go back and press the button again.', 404);
  const label = formatMoney(fromMinor(row.amount, row.currency), row.currency.toUpperCase());
  const credit = row.ticket_credit ? `${formatMoney(fromMinor(row.amount + row.ticket_credit, row.currency), row.currency.toUpperCase())} less your ${formatMoney(fromMinor(row.ticket_credit, row.currency), row.currency.toUpperCase())} ticket` : null;
  const copy = payCopy(row.kind, label, credit);
  const back = row.return_url || rt.origin;
  if (row.status === 'paid') return c.redirect(back, 302);
  let note: string | null = c.req.query('e') === 'declined' ? copy.declined : c.req.query('e') === 'failed' ? copy.failed : null;
  if (c.req.query('return') === '1') {
    const r = await whopConfirm(rt, row);
    if (r === 'paid' || r === 'pending') return c.redirect(back, 302);
    note = copy.failed;
  }
  if (c.req.query('hosted') === '1' && row.status === 'pending') {
    try { return c.redirect(await hostedFor(rt, row), 302); } catch { note = CHECKOUT_UNAVAILABLE; }
  }
  if (row.status !== 'pending') return c.redirect(back, 302);
  const lead = await getLead(rt.env, row.lead_id);
  const page = await payPageUrl(rt, row.id);
  const cfg = {
    token: row.id, src: ELEMENTS_SRC, accountId: await whopCompanyId(rt).catch(() => ''), amount: row.amount, currency: row.currency,
    email: lead?.email ?? null, name: [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || null,
    returnUrl: `${page}?return=1`, hostedUrl: `${page}?hosted=1`, copy, endpoint: '/api/pay', extra: { ref: c.req.param('ref') },
  };
  return render(c, '/webinar-pay.html', { title: copy.heading, blocks: { pay: ticketPayHtml({ copy, note, hostedUrl: cfg.hostedUrl }) }, config: { webinar: { ticketPay: cfg } } });
}

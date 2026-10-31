import type { Context } from 'hono';
import type { AppEnv, Runtime } from '../app';
import { render } from '../funnel/pages';
import { newId } from '../lib/ids';
import { getLead } from '../funnel/leads';
import { identityFromLead, track } from '../tracking/track';
import { type PaidEffects, type PassRow, PassError, confirmOnReturn, passConfig, passGate, passPaidEffects, ticketDescription } from './pass';
import { markWhopPaymentPaid, settleOneClick } from './one-click';
import { WHOP_NATIVE_VERSION, WHOP_PRODUCT, WhopError, checkoutFailed, whopApi, whopCompanyId } from './whop';
import { type Registration, webinarBase } from './webinar';

/**
 * The Masterclass ticket, paid on our own page with Whop's payment elements, with the card saved for later.
 *
 * Whop's hosted checkout doesn't keep the card on a one-time payment, so the one-click First Deal Sprint
 * would always fall back. Here the elements (Whop's PCI-isolated fields, loaded from cdn.whop.com) are
 * mounted with setupFutureUsage "off_session": they show the buyer Whop's save consent and hand us a
 * single-use confirmation token. Our server creates the $100 payment from that token (Create Payment,
 * with setup_future_usage off_session too) and Whop saves the method once the payment goes through:
 * payment.succeeded then carries the payment_method_id one click charges for the Sprint.
 *
 *  - The page says, right above the pay button, that Whop saves the card for a one-click Sprint later.
 *  - 3D Secure and other steps run in the browser (handleNextAction with the payment's client_secret);
 *    off-site steps come back to /ticket/:token?return=1, which asks Whop how it went.
 *  - One payment in flight per registration (partial unique index + Idempotency-Key per row).
 *  - The webhook marks it paid and stores the card; the return page does the same if it gets there first.
 *  - WHOP_TICKET_FORM=off, or ?hosted=1, keeps Whop's hosted checkout (no saved card, no one click).
 */

export const ELEMENTS_SRC = 'https://cdn.whop.com/elements/amber/elements.js';

/** The embedded ticket form runs when Whop takes payments and it isn't switched off. */
export const embeddedTicketOn = (s: Partial<Record<string, string>>) => passConfig(s).provider === 'whop' && !/^(off|no|false|0)$/i.test(String(s.WHOP_TICKET_FORM ?? '').trim());
export const ticketPayUrl = (rt: Runtime, token: string) => `${webinarBase(rt)}/ticket/${token}`;

/** Every visible string on the ticket payment page (checked by auditCopy in the tests). */
export function ticketPayCopy(label: string) {
  return {
    eyebrow: 'Masterclass ticket',
    heading: 'Get your Masterclass ticket',
    lede: `One payment of ${label}. Your ticket is confirmed the moment it goes through, and your personal link arrives by email.`,
    saveNote: `Whop saves your card securely, so you can add the First Deal Sprint in one click later. Today you pay ${label} for your ticket.`,
    button: `Pay ${label}`,
    paying: 'Taking your payment…',
    declined: 'Your card wasn’t charged. Check the details or use another card.',
    failed: 'Payment couldn’t be taken just now. Try again, or pay on Whop’s checkout page.',
    hosted: 'Prefer Whop’s own checkout page?',
    hostedLink: 'Pay there instead',
    loading: 'Loading the secure payment form…',
  };
}

/** What ticket-pay.js needs to mount the form (exposed as window.FUNNEL.webinar.ticketPay). */
export async function ticketPayConfig(rt: Runtime, reg: Pick<Registration, 'token' | 'lead_id'>) {
  const cfg = passConfig(rt.settings);
  const lead = await getLead(rt.env, reg.lead_id);
  return {
    token: reg.token,
    src: ELEMENTS_SRC,
    accountId: await whopCompanyId(rt),
    amount: cfg.seat?.amount ?? 0,
    currency: cfg.currency.toLowerCase(),
    email: lead?.email ?? null,
    name: [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || null,
    returnUrl: `${ticketPayUrl(rt, reg.token)}?return=1`,
    hostedUrl: `${ticketPayUrl(rt, reg.token)}?hosted=1`,
    copy: ticketPayCopy(cfg.seat?.label ?? ''),
  };
}

export type TicketPayResult =
  | { ok: true; next: string }
  | { ok: true; payment: string; client_secret: string | null; settle: string }
  | { ok: false; error: string; hosted: string };

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const MIN = 60_000;

/** POST /api/webinar/ticket/pay: the $100 from the elements' confirmation token, card saved for the Sprint. */
export async function payTicket(rt: Runtime, reg: Registration, o: { confirmationToken: unknown; effects?: PaidEffects; now?: number }): Promise<TicketPayResult> {
  const cfg = passConfig(rt.settings);
  const now = o.now ?? Date.now();
  const thanks = `${webinarBase(rt)}/registered/${reg.token}?pass=success`;
  const settleUrl = `${ticketPayUrl(rt, reg.token)}?return=1`;
  const hosted = `${ticketPayUrl(rt, reg.token)}?hosted=1`;
  const copy = ticketPayCopy(cfg.seat?.label ?? '');
  if (cfg.mode !== 'required' || !cfg.seat || cfg.provider !== 'whop') throw new PassError('This isn’t available right now.', 409);
  if (!(await passGate(rt, reg))) return { ok: true, next: thanks };
  const ctok = str(o.confirmationToken);
  if (!ctok || !/^ctok_[A-Za-z0-9_]{4,120}$/.test(ctok)) throw new PassError(copy.failed, 400);
  const db = rt.env.DB;

  const insert = (id: string) => db.prepare(
    `INSERT OR IGNORE INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, expires_at, provider, embedded, created_at, updated_at)
     VALUES (?, ?, ?, 'seat', 'Masterclass ticket', 'pending', ?, ?, ?, 'whop', 1, ?, ?)`,
  ).bind(id, reg.id, reg.lead_id, cfg.seat!.amount, cfg.currency.toLowerCase(), now + 60 * MIN, now, now).run();
  let id = newId('wp');
  if (((await insert(id)).meta.changes ?? 0) === 0) {
    // A payment is already in flight for this registration (a second press, or a 3D Secure dialog closed).
    const prev = await db.prepare("SELECT * FROM webinar_passes WHERE reg_id = ? AND embedded = 1 AND status = 'pending'").bind(reg.id).first<PassRow>();
    if (prev?.stripe_payment_intent) {
      const s = await settleOneClick(rt, prev, o.effects ?? passPaidEffects);
      if (s === 'paid') return { ok: true, next: thanks };
      const still = await db.prepare("SELECT status FROM webinar_passes WHERE id = ?").bind(prev.id).first<{ status: string }>();
      if (still?.status === 'pending' && s === 'pending' && now - prev.created_at < 2 * MIN) return { ok: true, next: settleUrl };
    }
    // Not taken: close it and start a fresh attempt with this token.
    if (prev) await db.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, prev.id).run();
    id = newId('wp');
    if (((await insert(id)).meta.changes ?? 0) === 0) return { ok: true, next: settleUrl };
  }
  const expire = () => db.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), id).run();

  let pay: Record<string, unknown>;
  try {
    pay = await whopApi<Record<string, unknown>>(rt, 'POST', 'payments', {
      account_id: await whopCompanyId(rt),
      variant: {
        currency: cfg.currency.toLowerCase(), billing_type: 'one_time', initial_price: cfg.seat.price, title: 'Masterclass ticket', description: ticketDescription(cfg), visibility: 'hidden',
        product: { external_identifier: WHOP_PRODUCT.seat, title: 'Masterclass ticket', visibility: 'hidden' },
      },
      confirmation_token: ctok,
      setup_future_usage: 'off_session', // the page told the buyer the card is saved for a one-click Sprint
      return_url: settleUrl,
      metadata: { pass_id: id, reg_id: reg.id, reg_token: reg.token, lead_id: reg.lead_id, kind: 'seat', embedded: '1' },
    }, { version: WHOP_NATIVE_VERSION, idempotencyKey: `ticket_${id}` });
    if (!str(pay.id)) throw new WhopError(0, 'Whop returned no payment id');
  } catch (e) {
    await expire();
    const message = e instanceof Error ? e.message : String(e);
    const status = e instanceof WhopError ? e.status : 0;
    const declined = status !== 401 && status !== 403 && /declin|insufficient|do_not_honor|card_|incorrect|expired/i.test(`${message} ${e instanceof WhopError ? e.code ?? '' : ''}`);
    console.error('ticket payment failed', message.slice(0, 300));
    if (!declined) await checkoutFailed(rt, { kind: 'seat', amount: cfg.seat.amount, currency: cfg.currency, title: 'Masterclass ticket', error: e, leadId: reg.lead_id }).catch((x) => console.error('ticket alert', x));
    return { ok: false, error: declined ? copy.declined : copy.failed, hosted };
  }
  const payId = str(pay.id)!;
  await db.prepare('UPDATE webinar_passes SET stripe_session_id = COALESCE(stripe_session_id, ?), stripe_payment_intent = ?, updated_at = ? WHERE id = ?').bind(`whop_${payId}`, payId, Date.now(), id).run();
  await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_checkout_started', source: 'server', props: { pass_id: id, kind: 'seat', from: 'ticket_form', provider: 'whop', embedded: true }, localOnly: true }).catch(() => null);
  if (pay.status === 'paid') {
    await markWhopPaymentPaid(rt, { id, reg_id: reg.id, amount: cfg.seat.amount, currency: cfg.currency.toLowerCase(), kind: 'seat' }, payId, o.effects ?? passPaidEffects);
    return { ok: true, next: thanks };
  }
  // A step left for the buyer (3D Secure, a redirect) or the charge still being decided: the browser
  // finishes it with the client secret, then comes back to the return page.
  return { ok: true, payment: payId, client_secret: str(pay.client_secret), settle: settleUrl };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page body (pure, for the tests). ticket-pay.js mounts the Whop fields into the empty boxes. */
export function ticketPayHtml(o: { copy: ReturnType<typeof ticketPayCopy>; note: string | null; hostedUrl: string }) {
  const t = o.copy;
  return `<div class="card pass-card seat" data-ticket-pay>
    <p class="pass-eyebrow">${esc(t.eyebrow)}</p>
    <h1 class="pass-h">${esc(t.heading)}</h1>
    <p class="pass-lede">${esc(t.lede)}</p>
    ${o.note ? `<p class="pass-note pass-err" role="alert">${esc(o.note)}</p>` : ''}
    <div data-whop-payment><p class="muted small">${esc(t.loading)}</p></div>
    <div data-whop-branding></div>
    <p class="pass-fine" data-save-note>${esc(t.saveNote)}</p>
    <button type="button" class="btn btn-lg pass-btn" data-ticket-pay-btn disabled>${esc(t.button)}</button>
    <p class="pass-note pass-err" role="alert" data-ticket-pay-err hidden></p>
    <p class="pass-fine">${esc(t.hosted)} <a href="${esc(o.hostedUrl)}">${esc(t.hostedLink)}</a></p>
  </div>`;
}

/**
 * GET /ticket/:token when the embedded form runs. ?return=1: back from a 3D Secure or bank step, so ask
 * Whop and go on to the confirmation (or show the form again with the reason).
 */
export async function ticketPayPage(c: Context<AppEnv>, rt: Runtime, reg: Registration) {
  const thanks = `${webinarBase(rt)}/registered/${reg.token}`;
  let note: string | null = null;
  const copy = ticketPayCopy(passConfig(rt.settings).seat?.label ?? '');
  if (c.req.query('return') === '1') {
    const r = await confirmOnReturn(rt, reg);
    if (r === 'paid' || r === 'pending') return c.redirect(`${thanks}?pass=success`, 302);
    note = c.req.query('status') === 'canceled' || c.req.query('status') === 'failed' ? copy.declined : copy.failed;
    if (!(await passGate(rt, reg))) return c.redirect(`${thanks}?pass=success`, 302);
  }
  const config = await ticketPayConfig(rt, reg);
  return render(c, '/webinar-pay.html', { title: copy.heading, blocks: { pay: ticketPayHtml({ copy, note, hostedUrl: config.hostedUrl }) }, config: { webinar: { ty: reg.token, ticketPay: config } } });
}

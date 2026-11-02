import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { getLead } from '../funnel/leads';
import { identityFromLead, track } from '../tracking/track';
import { type PaidEffects, type PassRow, formatMoney, fromMinor, passConfig, passPaidEffects, toMinor } from './pass';
import { buyerFeePercent, cardLabel, markWhopPaymentPaid, pollStatus, savedTicketMethod } from './one-click';
import { WHOP_NATIVE_VERSION, WHOP_PRODUCT, WhopError, whopApi, whopCompanyId } from './whop';
import type { Registration } from './webinar';

/**
 * The one-click ticket add-on (overnight loop round 2, "ticket economics"): an optional low-price product offered
 * once on the Masterclass ticket's thank-you page, charged with one click to the card saved with the ticket.
 *
 *  - Off unless TICKET_ADDON (its name) and TICKET_ADDON_PRICE (1 to 500) are set. TICKET_ADDON_DESCRIPTION says
 *    what it is; TICKET_ADDON_URL (optional) is where buyers open it once paid.
 *  - Nothing is pre-ticked: the buyer presses one button whose label states the product, the total (with Whop's
 *    service fee) and the card. No timer, no count.
 *  - A webinar_passes row with kind 'addon'. One attempt in flight per buyer (the insert is guarded in SQL) and
 *    Whop gets the row id as the Idempotency-Key, so a double click never charges twice. The webhook's
 *    payment.succeeded and refund.created go through the same code as the ticket (whop.ts), so refunds work the
 *    same way: a refund on Whop marks the row refunded and it leaves the revenue.
 *  - Paid: its own Purchase (Meta CAPI / GA4: ticket_addon_purchased, order id = the row id) and its own conversion
 *    in attribution (addon_paid), plus a Slack note so the team can deliver it.
 */

export interface AddonConfig { name: string; price: number; amount: number; currency: string; label: string; description: string | null; url: string | null }

/** The add-on, or null when it is off (blank name, "off", or no valid price). Same currency as the ticket. */
export function addonConfig(s: Partial<Record<string, string>>): AddonConfig | null {
  const name = String(s.TICKET_ADDON ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name || /^(off|no|false|0)$/i.test(name)) return null;
  const price = Number(String(s.TICKET_ADDON_PRICE ?? '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(price) || price < 1 || price > 500) return null;
  const currency = passConfig(s).currency;
  const description = String(s.TICKET_ADDON_DESCRIPTION ?? '').trim().slice(0, 400) || null;
  const url = /^https:\/\/[^\s<>"']+$/.test(String(s.TICKET_ADDON_URL ?? '').trim()) ? String(s.TICKET_ADDON_URL).trim() : null;
  return { name, price, amount: toMinor(price, currency), currency, label: formatMoney(price, currency), description, url };
}

/** Every visible string of the add-on card (checked by auditCopy in the tests). */
export function addonCopy(o: { name: string; total: string; card: string | null; fee: number; url?: string | null }) {
  return {
    eyebrow: 'Optional add-on',
    button: `Add ${o.name} for ${o.total}`,
    charged: `One payment of ${o.total}, charged to the ${o.card ?? 'card'} you used for your ticket${o.fee ? `, including Whop’s ${o.fee}% service fee` : ''}. Nothing else is charged.`,
    refund: 'Same terms as your ticket: reply within 7 days for a full refund.',
    paying: 'Taking your payment…',
    declined: 'Your card wasn’t charged. Your ticket is unaffected.',
    unavailable: 'The add-on can’t be bought right now. Your ticket is unaffected.',
    boughtHeading: `${o.name} is yours`,
    boughtBody: o.url ? 'Open it with the button below. Your receipt from Whop is in your inbox.' : 'Josh’s team emails it to you within one business day. Your receipt from Whop is in your inbox.',
    open: `Open ${o.name}`,
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The add-on's charge today: price plus Whop's buyer service fee (what the button states). */
export function addonTotal(cfg: AddonConfig, feePct: number) {
  const fee = Math.round((cfg.amount * feePct) / 100);
  return { fee, total: cfg.amount + fee, label: formatMoney(fromMinor(cfg.amount + fee, cfg.currency), cfg.currency) };
}

export const paidAddon = (rt: Runtime, leadId: string) =>
  rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE lead_id = ? AND kind = 'addon' AND status = 'paid' ORDER BY paid_at DESC LIMIT 1").bind(leadId).first<PassRow>();

const paidSeat = (rt: Runtime, leadId: string) =>
  rt.env.DB.prepare("SELECT id FROM webinar_passes WHERE lead_id = ? AND kind = 'seat' AND status = 'paid' LIMIT 1").bind(leadId).first<{ id: string }>();

/** What the thank-you page shows: nothing, the offer (paid ticket on Whop with its saved card), or the buyer's card. */
export async function addonOffer(rt: Runtime, reg: Pick<Registration, 'lead_id'>) {
  const cfg = addonConfig(rt.settings as Partial<Record<string, string>>);
  if (!cfg) return null;
  const bought = await paidAddon(rt, reg.lead_id);
  if (bought) return { bought: true as const, cfg };
  if (passConfig(rt.settings).provider !== 'whop' || !(await paidSeat(rt, reg.lead_id))) return null;
  const m = await savedTicketMethod(rt, reg.lead_id);
  if (!m) return null;
  const pct = buyerFeePercent(rt.settings);
  const t = addonTotal(cfg, pct);
  const card = cardLabel(m.card_brand, m.card_last4);
  return { bought: false as const, cfg, card, total: t.label, fee: pct };
}

/** The card on the ticket thank-you page ('' when the add-on is off or can't be offered). */
export async function addonCardHtml(rt: Runtime, reg: Pick<Registration, 'lead_id' | 'token'>) {
  const o = await addonOffer(rt, reg).catch((e) => { console.error('addon offer', String(e).slice(0, 200)); return null; });
  if (!o) return '';
  if (o.bought) {
    const k = addonCopy({ name: o.cfg.name, total: o.cfg.label, card: null, fee: 0, url: o.cfg.url });
    return `<div class="card pass-card active compact" data-addon-bought>
    <p class="pass-eyebrow"><span class="pass-badge">${esc(k.eyebrow)}</span></p>
    <h2 class="pass-h">${esc(k.boughtHeading)}</h2>
    <p class="pass-lede">${esc(k.boughtBody)}</p>
    ${o.cfg.url ? `<p class="pass-links"><a class="btn btn-sm" href="${esc(o.cfg.url)}" target="_blank" rel="noopener">${esc(k.open)}</a></p>` : ''}
  </div>`;
  }
  const k = addonCopy({ name: o.cfg.name, total: o.total, card: o.card, fee: o.fee, url: o.cfg.url });
  return `<div class="card pass-card compact" data-addon>
    <p class="pass-eyebrow">${esc(k.eyebrow)}</p>
    <h2 class="pass-h">${esc(o.cfg.name)}</h2>
    ${o.cfg.description ? `<p class="pass-lede">${esc(o.cfg.description)}</p>` : ''}
    <p class="pass-links"><button type="button" class="btn btn-sm" data-addon-buy="${esc(reg.token)}" data-paying="${esc(k.paying)}">${esc(k.button)}</button></p>
    <p class="pass-fine">${esc(k.charged)} ${esc(k.refund)}</p>
    <p class="pass-note" data-addon-msg role="status" hidden></p>
  </div>`;
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const MIN = 60_000;

export type AddonResult =
  | { ok: true; outcome: 'paid' | 'pending' | 'in_flight' | 'already'; next: string }
  | { ok: true; outcome: 'action'; next: string }
  | { ok: false; outcome: 'off' | 'no_method' | 'declined' | 'unavailable'; error: string };

/** POST /api/webinar/ticket/addon: one click on the ticket's saved card. */
export async function buyAddon(rt: Runtime, reg: Registration, o: { now?: number; effects?: PaidEffects; sleep?: (ms: number) => Promise<unknown>; tries?: number } = {}): Promise<AddonResult> {
  const now = o.now ?? Date.now();
  const back = `${(await import('./webinar')).webinarBase(rt)}/registered/${reg.token}`;
  const cfg = addonConfig(rt.settings as Partial<Record<string, string>>);
  const fallbackCopy = addonCopy({ name: cfg?.name ?? 'the add-on', total: cfg?.label ?? '', card: null, fee: 0 });
  if (!cfg) return { ok: false, outcome: 'off', error: fallbackCopy.unavailable };
  if (await paidAddon(rt, reg.lead_id)) return { ok: true, outcome: 'already', next: back };
  const offer = await addonOffer(rt, reg);
  if (!offer || offer.bought) return { ok: false, outcome: 'no_method', error: fallbackCopy.unavailable };
  const m = (await savedTicketMethod(rt, reg.lead_id))!;
  const who = await identityFromLead(rt.env, reg.lead_id);
  const log = (outcome: string, props: Record<string, unknown> = {}) =>
    track(rt, who, { name: 'ticket_addon_one_click', source: 'server', path: '/webinar', props: { outcome, ...props }, localOnly: true }).catch(() => null);

  const id = newId('wp');
  // One attempt in flight (or one purchase) per buyer: the guard is part of the insert, so two clicks can't both pass.
  const ins = await rt.env.DB.prepare(
    `INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, expires_at, list_amount, provider, one_click,
       whop_member_id, whop_payment_method_id, card_brand, card_last4, source, ref_id, created_at, updated_at)
     SELECT ?, ?, ?, 'addon', ?, 'pending', ?, ?, ?, ?, 'whop', 0, ?, ?, ?, ?, 'masterclass', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM webinar_passes WHERE lead_id = ? AND kind = 'addon' AND (status = 'paid' OR (status = 'pending' AND COALESCE(expires_at, 0) > ?)))`,
  ).bind(id, reg.id, reg.lead_id, cfg.name, cfg.amount, cfg.currency.toLowerCase(), now + 30 * MIN, cfg.amount, m.member_id, m.payment_method_id, m.card_brand, m.card_last4, reg.id, now, now, reg.lead_id, now).run();
  if ((ins.meta.changes ?? 0) === 0) return { ok: true, outcome: 'in_flight', next: back };
  const expire = () => rt.env.DB.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), id).run();
  await log('started', { pass_id: id, value: cfg.price });

  let payId: string | null;
  try {
    const pay = await whopApi<Obj>(rt, 'POST', 'payments', {
      account_id: await whopCompanyId(rt),
      variant: {
        currency: cfg.currency.toLowerCase(), billing_type: 'one_time', initial_price: cfg.price, title: cfg.name,
        description: cfg.description ?? `${cfg.name}, an add-on to your Masterclass ticket.`, visibility: 'hidden',
        product: { external_identifier: WHOP_PRODUCT.addon, title: cfg.name, visibility: 'hidden' },
      },
      member_id: m.member_id,
      payment_method_id: m.payment_method_id,
      off_session: false, // the buyer pressed the button: customer-initiated, 3D Secure can run
      return_url: `${back}?addon=1`,
      metadata: { pass_id: id, reg_id: reg.id, reg_token: reg.token, lead_id: reg.lead_id, kind: 'addon', one_click: '1' },
    }, { version: WHOP_NATIVE_VERSION, idempotencyKey: `ticket_addon_${id}` });
    payId = str(pay.id);
    if (!payId) throw new WhopError(0, 'Whop returned no payment id');
  } catch (e) {
    await expire();
    const status = e instanceof WhopError ? e.status : 0;
    const message = e instanceof Error ? e.message : String(e);
    console.error('addon one-click failed', message.slice(0, 300));
    const declined = /declin|insufficient|do_not_honor|card_/i.test(`${message} ${e instanceof WhopError ? e.code ?? '' : ''}`) && status !== 401 && status !== 403;
    await log(declined ? 'declined' : 'unavailable', { pass_id: id, status });
    return { ok: false, outcome: declined ? 'declined' : 'unavailable', error: declined ? fallbackCopy.declined : fallbackCopy.unavailable };
  }
  await rt.env.DB.prepare('UPDATE webinar_passes SET stripe_session_id = COALESCE(stripe_session_id, ?), stripe_payment_intent = ?, updated_at = ? WHERE id = ?').bind(`whop_${payId}`, payId, Date.now(), id).run();
  const st = await pollStatus(rt, payId, { sleep: o.sleep, tries: o.tries });
  const row = { id, reg_id: reg.id, amount: cfg.amount, currency: cfg.currency.toLowerCase(), kind: 'addon' as const, whop_payment_method_id: m.payment_method_id };
  if (st.status === 'succeeded') {
    await markWhopPaymentPaid(rt, row, payId, o.effects ?? passPaidEffects);
    await log('paid', { pass_id: id, value: cfg.price });
    return { ok: true, outcome: 'paid', next: `${back}?addon=1` };
  }
  if (st.status === 'requires_action') {
    const na = obj(st.next_action);
    const url = na.type === 'redirect' ? str(obj(na.data).url) : null;
    await log('action', { pass_id: id });
    if (url) return { ok: true, outcome: 'action', next: url };
    return { ok: true, outcome: 'pending', next: `${back}?addon=1` };
  }
  if (st.status === 'canceled' || (st.status === 'requires_confirmation' && st.last_payment_error)) {
    await expire();
    await log('declined', { pass_id: id, code: str(obj(st.last_payment_error).code) });
    return { ok: false, outcome: 'declined', error: fallbackCopy.declined };
  }
  await log('pending', { pass_id: id });
  return { ok: true, outcome: 'pending', next: `${back}?addon=1` };
}

/** Back on the thank-you page with ?addon=1 (after 3D Secure, or while it settled): Whop's status decides. */
export async function settleAddon(rt: Runtime, leadId: string, effects: PaidEffects = passPaidEffects) {
  const row = await rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE lead_id = ? AND kind = 'addon' AND status = 'pending' ORDER BY created_at DESC LIMIT 1").bind(leadId).first<PassRow>();
  const payId = row?.stripe_payment_intent ?? null;
  if (!row || !payId) return 'none';
  const st = await pollStatus(rt, payId, { tries: 1 });
  if (st.status === 'succeeded') { await markWhopPaymentPaid(rt, row, payId, effects); return 'paid'; }
  if (st.status === 'canceled' || (st.status === 'requires_confirmation' && st.last_payment_error)) {
    await rt.env.DB.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), row.id).run();
    return 'failed';
  }
  return 'pending';
}

/** What a paid add-on sets in motion: its own Purchase event and a note to the team to deliver it. */
export async function addonPaidEffects(rt: Runtime, pass: PassRow) {
  const value = fromMinor(pass.amount, pass.currency);
  await track(rt, await identityFromLead(rt.env, pass.lead_id), {
    name: 'ticket_addon_purchased', source: 'webhook', path: '/webinar',
    props: { pass_id: pass.id, product: pass.product || 'Ticket add-on', value, currency: pass.currency.toUpperCase() },
  }).catch((e) => console.error('addon track', e));
  const lead = await getLead(rt.env, pass.lead_id);
  if (!lead) return;
  const cfg = addonConfig(rt.settings as Partial<Record<string, string>>);
  const { notifySlack } = await import('../integrations/notify');
  rt.waitUntil(notifySlack(rt, lead, `${pass.product || 'Ticket add-on'} bought on the ticket page`, [
    `Paid: ${formatMoney(value, pass.currency.toUpperCase())}`,
    cfg?.url ? 'They open it from their thank-you page.' : 'No delivery link is set (TICKET_ADDON_URL): email it to them within one business day.',
  ], 'qualified_lead').catch((e) => console.error('addon slack failed', e)));
}

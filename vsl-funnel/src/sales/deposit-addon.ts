import type { Runtime } from '../app';
import { getLead } from '../funnel/leads';
import { signToken, verifyToken } from '../lib/crypto';
import { newId } from '../lib/ids';
import { getSecret } from '../lib/secret';
import { identityFromLead, track } from '../tracking/track';
import { type PaidEffects, type PassRow, formatMoney, fromMinor, passPaidEffects, toMinor } from '../webinar/pass';
import { buyerFeePercent, cardLabel, markWhopPaymentPaid, pollStatus } from '../webinar/one-click';
import { WHOP_NATIVE_VERSION, WHOP_PRODUCT, WhopError, whopApi, whopCompanyId } from '../webinar/whop';
import { depositConfig } from './deposit';

/**
 * The post-deposit one-click add-on (overnight loop round 4, research item 25): an optional product offered once on
 * the deposit's welcome page, charged with one click to the card the buyer just used for the deposit.
 *
 *  - Off unless DEPOSIT_ADDON (its name) and DEPOSIT_ADDON_PRICE (1 to 10,000, the deposit's currency) are set.
 *    DEPOSIT_ADDON_DESCRIPTION says what it is; DEPOSIT_ADDON_URL (optional) is where buyers open it once paid.
 *  - Offered once: shown until the buyer buys it or presses "No thanks" (deposit_addon_offers), never again after.
 *    Nothing is pre-ticked; the button states the product, the total (with Whop's service fee) and the card.
 *    No timer, no count, and the deposit is unaffected either way.
 *  - Charged only on the card saved with the paid deposit itself (the card just used); no card on the deposit, no offer.
 *  - Its own product: webinar_passes kind 'deposit_addon', Whop product vsl-funnel-deposit-addon, its own Purchase
 *    (deposit_addon_purchased, order id = its row) and its own attribution conversion (addon_paid). It earns no
 *    credit against the engagement fee. Refunds take the same path as the deposit: a refund in Whop arrives by the
 *    webhook and marks the row refunded (markPassRefunded), so it leaves the revenue.
 *  - One attempt in flight per buyer (guarded in the insert) and Whop gets the row id as the Idempotency-Key.
 */

export interface DepositAddonConfig { name: string; price: number; amount: number; currency: string; label: string; description: string | null; url: string | null; refund: string }

export const DEPOSIT_ADDON_REFUND = 'Ask the team within 14 days and it is refunded in full to the same card.';

/** The add-on, or null when it is off (blank name, "off", or no valid price). Same currency as the deposit. */
export function depositAddonConfig(s: Partial<Record<string, string>>, currency: string): DepositAddonConfig | null {
  const name = String(s.DEPOSIT_ADDON ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name || /^(off|no|false|0)$/i.test(name)) return null;
  const price = Number(String(s.DEPOSIT_ADDON_PRICE ?? '').replace(/[^\d.]/g, ''));
  if (!String(s.DEPOSIT_ADDON_PRICE ?? '').trim() || !Number.isFinite(price) || price < 1 || price > 10_000) return null;
  const description = String(s.DEPOSIT_ADDON_DESCRIPTION ?? '').trim().slice(0, 400) || null;
  const url = /^https:\/\/[^\s<>"']+$/.test(String(s.DEPOSIT_ADDON_URL ?? '').trim()) ? String(s.DEPOSIT_ADDON_URL).trim() : null;
  const refund = String(s.DEPOSIT_ADDON_REFUND ?? '').trim().slice(0, 300) || DEPOSIT_ADDON_REFUND;
  return { name, price, amount: toMinor(price, currency), currency, label: formatMoney(price, currency), description, url, refund };
}

const cfgOf = (rt: Runtime) => depositAddonConfig(rt.settings as Partial<Record<string, string>>, depositConfig(rt).currency);

/** Every visible string of the add-on card (checked by auditCopy in the tests). */
export function depositAddonCopy(o: { name: string; total: string; card: string | null; fee: number; url?: string | null; refund?: string }) {
  return {
    eyebrow: 'Optional add-on',
    button: `Add ${o.name} for ${o.total}`,
    decline: 'No thanks',
    charged: `One payment of ${o.total}, charged to the ${o.card ?? 'card'} you just used for your deposit${o.fee ? `, including Whop’s ${o.fee}% service fee` : ''}. Nothing else is charged, and your deposit and your place are the same either way.`,
    refund: o.refund ?? DEPOSIT_ADDON_REFUND,
    paying: 'Taking your payment…',
    declined: 'Your card wasn’t charged. Your deposit and your place are unaffected.',
    unavailable: 'The add-on can’t be bought right now. Your deposit and your place are unaffected.',
    boughtHeading: `${o.name} is yours`,
    boughtBody: o.url ? 'Open it with the button below. Your receipt from Whop is in your inbox.' : 'Josh’s team emails it to you within one business day. Your receipt from Whop is in your inbox.',
    open: `Open ${o.name}`,
  };
}

/** The add-on's charge today: price plus Whop's buyer service fee (what the button states). */
export function depositAddonTotal(cfg: DepositAddonConfig, feePct: number) {
  const fee = Math.round((cfg.amount * feePct) / 100);
  return { fee, total: cfg.amount + fee, label: formatMoney(fromMinor(cfg.amount + fee, cfg.currency), cfg.currency) };
}

type DepositRow = PassRow & { whop_member_id: string | null; whop_payment_method_id: string | null; card_brand: string | null; card_last4: string | null; provider: string | null };

/** The paid deposit and the card saved with it (the card just used), or null. */
async function depositWithCard(rt: Runtime, leadId: string) {
  const row = await rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE lead_id = ? AND kind = 'deposit' AND status = 'paid' ORDER BY paid_at DESC LIMIT 1").bind(leadId).first<DepositRow>();
  if (!row || row.provider !== 'whop' || !row.whop_member_id || !row.whop_payment_method_id) return null;
  return row;
}

export const paidDepositAddon = (rt: Runtime, leadId: string) =>
  rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE lead_id = ? AND kind = 'deposit_addon' AND status = 'paid' ORDER BY paid_at DESC LIMIT 1").bind(leadId).first<PassRow>();

const declined = async (rt: Runtime, leadId: string) =>
  Boolean(await rt.env.DB.prepare('SELECT 1 AS x FROM deposit_addon_offers WHERE lead_id = ? AND declined_at IS NOT NULL').bind(leadId).first());

/** What the welcome page shows: nothing, the offer, or the buyer's add-on. */
export async function depositAddonOffer(rt: Runtime, leadId: string) {
  const cfg = cfgOf(rt);
  if (!cfg) return null;
  if (await paidDepositAddon(rt, leadId)) return { bought: true as const, cfg };
  if (await declined(rt, leadId)) return null;
  const dep = await depositWithCard(rt, leadId);
  if (!dep) return null;
  const pct = buyerFeePercent(rt.settings as Partial<Record<string, string>>);
  return { bought: false as const, cfg, deposit: dep, card: cardLabel(dep.card_brand, dep.card_last4), total: depositAddonTotal(cfg, pct).label, fee: pct };
}

// ───────────── the signed token on the card (lead + where to come back to) ─────────────

export async function depositAddonToken(rt: Pick<Runtime, 'env'>, leadId: string, liveRegToken: string) {
  return signToken(await getSecret(rt.env), `da|${leadId}|${liveRegToken}`);
}
export async function readDepositAddonToken(rt: Pick<Runtime, 'env'>, token: unknown) {
  if (typeof token !== 'string' || token.length > 300) return null;
  const p = await verifyToken(await getSecret(rt.env), token);
  const m = p ? /^da\|([^|]{1,80})\|([A-Za-z0-9_-]{8,80})$/.exec(p) : null;
  return m ? { leadId: m[1], regToken: m[2] } : null;
}
const backUrl = async (rt: Runtime, regToken: string) => (await import('../live/events')).liveWelcomeUrl(rt, regToken);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The card on the deposit welcome page ('' when off, declined, or no card on the deposit). Records the first showing. */
export async function depositAddonCardHtml(rt: Runtime, leadId: string, liveRegToken: string, now = Date.now()) {
  const o = await depositAddonOffer(rt, leadId).catch((e) => { console.error('deposit add-on offer', String(e).slice(0, 200)); return null; });
  if (!o) return '';
  const script = '<script src="/assets/deposit-addon.js" defer></script>';
  if (o.bought) {
    const k = depositAddonCopy({ name: o.cfg.name, total: o.cfg.label, card: null, fee: 0, url: o.cfg.url });
    return `<div class="lv-card" data-dep-addon-bought>
    <p class="lv-eyebrow">${esc(k.eyebrow)}</p>
    <h2 class="lv-offer-h">${esc(k.boughtHeading)}</h2>
    <p class="lv-offer-p">${esc(k.boughtBody)}</p>
    ${o.cfg.url ? `<p><a class="lv-btn-2" href="${esc(o.cfg.url)}" target="_blank" rel="noopener">${esc(k.open)}</a></p>` : ''}
  </div>`;
  }
  await rt.env.DB.prepare('INSERT INTO deposit_addon_offers (lead_id, first_shown_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(lead_id) DO NOTHING').bind(leadId, now, now).run().catch(() => null);
  const k = depositAddonCopy({ name: o.cfg.name, total: o.total, card: o.card, fee: o.fee, url: o.cfg.url, refund: o.cfg.refund });
  const tok = await depositAddonToken(rt, leadId, liveRegToken);
  return `<div class="lv-card" data-dep-addon>
    <p class="lv-eyebrow">${esc(k.eyebrow)}</p>
    <h2 class="lv-offer-h">${esc(o.cfg.name)}</h2>
    ${o.cfg.description ? `<p class="lv-offer-p">${esc(o.cfg.description)}</p>` : ''}
    <p class="lv-offer-p"><button type="button" class="lv-btn-2" data-dep-addon-buy="${esc(tok)}" data-paying="${esc(k.paying)}">${esc(k.button)}</button>
      <button type="button" class="lv-link" style="background:none;border:0;padding:8px 12px;cursor:pointer;font:inherit" data-dep-addon-no="${esc(tok)}">${esc(k.decline)}</button></p>
    <p class="lv-fine">${esc(k.charged)} ${esc(k.refund)}</p>
    <p class="lv-fine" data-dep-addon-msg role="status" hidden></p>
  </div>${script}`;
}

// ───────────── one click ─────────────

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const MIN = 60_000;

export type DepositAddonResult =
  | { ok: true; outcome: 'paid' | 'pending' | 'in_flight' | 'already' | 'action'; next: string }
  | { ok: false; outcome: 'off' | 'no_method' | 'declined' | 'unavailable' | 'bad_link'; error: string };

/** POST /api/deposit/addon { t }: one click on the deposit's card. */
export async function buyDepositAddon(rt: Runtime, token: unknown, o: { now?: number; effects?: PaidEffects; sleep?: (ms: number) => Promise<unknown>; tries?: number } = {}): Promise<DepositAddonResult> {
  const now = o.now ?? Date.now();
  const cfg = cfgOf(rt);
  const fallback = depositAddonCopy({ name: cfg?.name ?? 'the add-on', total: cfg?.label ?? '', card: null, fee: 0 });
  const who0 = await readDepositAddonToken(rt, token);
  if (!who0) return { ok: false, outcome: 'bad_link', error: fallback.unavailable };
  const { leadId, regToken } = who0;
  const back = await backUrl(rt, regToken);
  if (!cfg) return { ok: false, outcome: 'off', error: fallback.unavailable };
  if (await paidDepositAddon(rt, leadId)) return { ok: true, outcome: 'already', next: back };
  const offer = await depositAddonOffer(rt, leadId);
  if (!offer || offer.bought) return { ok: false, outcome: 'no_method', error: fallback.unavailable };
  const dep = offer.deposit;
  const who = await identityFromLead(rt.env, leadId);
  const log = (outcome: string, props: Record<string, unknown> = {}) =>
    track(rt, who, { name: 'deposit_addon_one_click', source: 'server', props: { outcome, ...props }, localOnly: true }).catch(() => null);

  const id = newId('wp');
  const ins = await rt.env.DB.prepare(
    `INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, expires_at, list_amount, provider, one_click,
       whop_member_id, whop_payment_method_id, card_brand, card_last4, source, ref_id, return_url, created_at, updated_at)
     SELECT ?, ?, ?, 'deposit_addon', ?, 'pending', ?, ?, ?, ?, 'whop', 1, ?, ?, ?, ?, 'deposit', ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM webinar_passes WHERE lead_id = ? AND kind = 'deposit_addon' AND (status = 'paid' OR (status = 'pending' AND COALESCE(expires_at, 0) > ?)))`,
  ).bind(id, `deposit_addon:${leadId}`.slice(0, 120), leadId, cfg.name, cfg.amount, cfg.currency.toLowerCase(), now + 30 * MIN, cfg.amount,
    dep.whop_member_id, dep.whop_payment_method_id, dep.card_brand, dep.card_last4, dep.id, back, now, now, leadId, now).run();
  if ((ins.meta.changes ?? 0) === 0) return { ok: true, outcome: 'in_flight', next: back };
  const expire = () => rt.env.DB.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), id).run();
  await log('started', { pass_id: id, value: cfg.price });

  let payId: string | null;
  try {
    const pay = await whopApi<Obj>(rt, 'POST', 'payments', {
      account_id: await whopCompanyId(rt),
      variant: {
        currency: cfg.currency.toLowerCase(), billing_type: 'one_time', initial_price: cfg.price, title: cfg.name,
        description: cfg.description ?? `${cfg.name}, an add-on to your engagement deposit.`, visibility: 'hidden',
        product: { external_identifier: WHOP_PRODUCT.deposit_addon, title: cfg.name, visibility: 'hidden' },
      },
      member_id: dep.whop_member_id,
      payment_method_id: dep.whop_payment_method_id,
      off_session: false, // the buyer pressed the button: customer-initiated, 3D Secure can run
      return_url: `${back}?addon=1`,
      metadata: { pass_id: id, reg_id: `deposit_addon:${leadId}`, lead_id: leadId, kind: 'deposit_addon', source: 'deposit', ref_id: dep.id, one_click: '1' },
    }, { version: WHOP_NATIVE_VERSION, idempotencyKey: `deposit_addon_${id}` });
    payId = str(pay.id);
    if (!payId) throw new WhopError(0, 'Whop returned no payment id');
  } catch (e) {
    await expire();
    const status = e instanceof WhopError ? e.status : 0;
    const message = e instanceof Error ? e.message : String(e);
    console.error('deposit add-on one-click failed', message.slice(0, 300));
    const isDecline = /declin|insufficient|do_not_honor|card_/i.test(`${message} ${e instanceof WhopError ? e.code ?? '' : ''}`) && status !== 401 && status !== 403;
    await log(isDecline ? 'declined' : 'unavailable', { pass_id: id, status });
    return { ok: false, outcome: isDecline ? 'declined' : 'unavailable', error: isDecline ? fallback.declined : fallback.unavailable };
  }
  await rt.env.DB.prepare('UPDATE webinar_passes SET stripe_session_id = COALESCE(stripe_session_id, ?), stripe_payment_intent = ?, updated_at = ? WHERE id = ?').bind(`whop_${payId}`, payId, Date.now(), id).run();
  const st = await pollStatus(rt, payId, { sleep: o.sleep, tries: o.tries });
  const row = { id, reg_id: `deposit_addon:${leadId}`, amount: cfg.amount, currency: cfg.currency.toLowerCase(), kind: 'deposit_addon' as const, whop_payment_method_id: dep.whop_payment_method_id };
  if (st.status === 'succeeded') {
    await markWhopPaymentPaid(rt, row, payId, o.effects ?? passPaidEffects);
    await log('paid', { pass_id: id, value: cfg.price });
    return { ok: true, outcome: 'paid', next: `${back}?addon=1` };
  }
  if (st.status === 'requires_action') {
    const na = obj(st.next_action);
    const url = na.type === 'redirect' ? str(obj(na.data).url) : null;
    await log('action', { pass_id: id });
    return { ok: true, outcome: url ? 'action' : 'pending', next: url ?? `${back}?addon=1` };
  }
  if (st.status === 'canceled' || (st.status === 'requires_confirmation' && st.last_payment_error)) {
    await expire();
    await log('declined', { pass_id: id, code: str(obj(st.last_payment_error).code) });
    return { ok: false, outcome: 'declined', error: fallback.declined };
  }
  await log('pending', { pass_id: id });
  return { ok: true, outcome: 'pending', next: `${back}?addon=1` };
}

/** POST /api/deposit/addon/decline { t }: "No thanks" hides the offer for good. */
export async function declineDepositAddon(rt: Runtime, token: unknown, now = Date.now()) {
  const who = await readDepositAddonToken(rt, token);
  if (!who) return { ok: false as const };
  await rt.env.DB.prepare('INSERT INTO deposit_addon_offers (lead_id, first_shown_at, declined_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(lead_id) DO UPDATE SET declined_at = COALESCE(declined_at, excluded.declined_at), updated_at = excluded.updated_at')
    .bind(who.leadId, now, now, now).run();
  await track(rt, await identityFromLead(rt.env, who.leadId), { name: 'deposit_addon_one_click', source: 'server', props: { outcome: 'no_thanks' }, localOnly: true }).catch(() => null);
  return { ok: true as const };
}

/** Back on the welcome page with ?addon=1 (after 3D Secure, or while it settled): Whop's status decides. */
export async function settleDepositAddon(rt: Runtime, leadId: string, effects: PaidEffects = passPaidEffects) {
  const row = await rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE lead_id = ? AND kind = 'deposit_addon' AND status = 'pending' ORDER BY created_at DESC LIMIT 1").bind(leadId).first<PassRow>();
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
export async function depositAddonPaidEffects(rt: Runtime, pass: PassRow) {
  const value = fromMinor(pass.amount, pass.currency);
  await track(rt, await identityFromLead(rt.env, pass.lead_id), {
    name: 'deposit_addon_purchased', source: 'webhook',
    props: { pass_id: pass.id, product: pass.product || 'Deposit add-on', value, currency: pass.currency.toUpperCase() },
  }).catch((e) => console.error('deposit add-on track', e));
  const lead = await getLead(rt.env, pass.lead_id);
  if (!lead) return;
  const cfg = cfgOf(rt);
  const { notifySlack } = await import('../integrations/notify');
  rt.waitUntil(notifySlack(rt, lead, `${pass.product || 'Deposit add-on'} bought after the deposit`, [
    `Paid: ${formatMoney(value, pass.currency.toUpperCase())}`,
    cfg?.url ? 'They open it from their welcome page.' : 'No delivery link is set (DEPOSIT_ADDON_URL): deliver it within one business day.',
  ], 'hot_lead').catch((e) => console.error('deposit add-on slack failed', e)));
}

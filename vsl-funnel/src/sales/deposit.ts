import type { Runtime } from '../app';
import { getLead } from '../funnel/leads';
import { newId } from '../lib/ids';
import { REVENUE_LABEL } from './qualify';
import { identityFromLead, track } from '../tracking/track';
import { type PassRow, PassError, capacity, formatMoney, fromMinor, paymentProvider, toMinor, weekStart } from '../webinar/pass';
import { GUARANTEE_HEADLINE, type Guarantee, guarantee } from './guarantee';

/**
 * The engagement deposit: the live funnels' offer (the live webinar and the 5-day challenge pitch).
 *
 * A deposit (ENGAGEMENT_DEPOSIT, default 5000; ENGAGEMENT_DEPOSIT_CURRENCY, default USD) paid online locks the
 * buyer's place in this intake of the 90-day advisory engagement. It is credited in full against the engagement
 * fee (passCreditFor counts paid deposits next to the First Deal Sprint); the balance is due on signing the
 * engagement agreement after a short onboarding call (post-purchase onboarding, not a sales call).
 *
 *  - One click on the card saved with the buyer's Whop ticket (Masterclass, live webinar or challenge) when
 *    there is one; else our own Whop payment page (sales/pay-page.ts) with Whop's hosted checkout a link away.
 *  - A paid ticket from the live funnels (DEPOSIT_CREDIT_KINDS) comes off the deposit price; the deposit is
 *    still credited in full on the agreement.
 *  - ENGAGEMENT_INTAKE_CAP (optional) is a real weekly cap: paid deposits plus checkouts still open this week.
 *    Shown only when set, and enforced here.
 *  - Paid: Slack alert, the onboarding email with the booking link (ENGAGEMENT_ONBOARDING_URL), and the
 *    engagement agreement drafted from the lead's size with the deposit credited (contracts.ts).
 */

export interface DepositConfig { amount: number; currency: string; label: string; cap: number | null; guarantee: { headline: string; body: string; conditions: string[]; url: string } }

/** Ticket kinds credited against the deposit price (live webinar ticket; the challenge ticket, builder C's kind 'challenge'). */
export const DEPOSIT_CREDIT_KINDS = ['live_ticket', 'challenge'] as const;
export const DEPOSIT_SEQUENCE = 'deposit';
const MIN = 60_000;

export function depositConfig(rt: Runtime): DepositConfig {
  const s = rt.settings as Partial<Record<string, string>>;
  const raw = Number(String(s.ENGAGEMENT_DEPOSIT ?? '').replace(/[^\d.]/g, ''));
  const amount = Number.isFinite(raw) && raw >= 100 && raw <= 1_000_000 ? Math.round(raw) : 5000;
  const currency = /^[A-Za-z]{3}$/.test(String(s.ENGAGEMENT_DEPOSIT_CURRENCY ?? '').trim()) ? String(s.ENGAGEMENT_DEPOSIT_CURRENCY).trim().toUpperCase() : 'USD';
  const capRaw = Number(String(s.ENGAGEMENT_INTAKE_CAP ?? '').trim());
  const g: Guarantee = guarantee(rt);
  return {
    amount, currency, label: formatMoney(amount, currency),
    cap: String(s.ENGAGEMENT_INTAKE_CAP ?? '').trim() && Number.isInteger(capRaw) && capRaw > 0 ? capRaw : null,
    guarantee: { headline: g.headline, body: g.body, conditions: g.conditions, url: g.url },
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Every string of the deposit offer (the live room, the challenge pitch). Plain text; checked by auditCopy. */
export function depositCopy(cfg: Pick<DepositConfig, 'label' | 'cap'>, o: { left?: number | null } = {}) {
  return {
    eyebrow: 'Josh’s advisory engagement',
    heading: 'Buy your first competitor with Josh’s team beside you',
    price: `${cfg.label} deposit`,
    priceNote: 'Credited in full against the engagement fee.',
    secures: [
      'Your place in this intake of the 90-day advisory engagement, done with you.',
      'The 3C model applied to your business: capabilities, capital and closing.',
      'The buy box, the owner outreach, the 1.5x test and the deal structure with commercial debt, seller finance and seller rollover, worked through with Josh’s team.',
      'A short onboarding call first, then the engagement agreement with your deposit credited. The balance is due when you sign it.',
    ],
    fees: 'The engagement fee follows the size of your business: $40K for $1M to $3M revenue, $50K for $3M to $10M, $60K for $10M to $25M, $70K for $25M to $50M.',
    button: `Secure my place with the ${cfg.label} deposit`,
    buyBar: `${cfg.label} deposit, credited in full`,
    buyBarButton: 'Secure my place',
    closes: 'This offer closes in',
    closed: 'This offer has closed.',
    capLine: cfg.cap != null && o.left != null ? `${o.left} of ${cfg.cap} places left in this week’s intake.` : null,
    soldOut: 'This week’s intake is full. Reply to any email from Josh’s team to join the next one.',
    oneClickHeading: 'Confirm your deposit',
    oneClickCharged: (card: string | null) => (card ? `Charged to the ${card} you used for your ticket.` : 'Charged to the payment method you used for your ticket.'),
    oneClickConfirm: (total: string) => `Confirm and pay ${total}`,
    otherCard: 'Use a different card',
    paying: 'Taking your payment…',
    unavailable: 'Payments aren’t connected yet. Email the team and they send you a payment link.',
    underMillionHeading: 'Start with the worksheet',
    underMillionBody: 'The engagement is for owners doing $1M or more a year. Work through the deal structure worksheet for one business you would like to own, and come back when your numbers are there.',
    underMillionButton: 'Open the worksheet',
  };
}

/** The guarantee block with its conditions in full and the link to the full wording (/guarantee). */
/** Owner decision: the deposit is refundable until the engagement agreement is signed. */
export const DEPOSIT_REFUND_TERMS = 'If you decide not to sign the engagement, tell the team within 14 days of your onboarding call and the deposit is refunded in full. Once you sign, it becomes part of the fee and the guarantee covers it.';

export function guaranteeHtml(rt: Runtime): string {
  const g = guarantee(rt);
  return `<section class="gt" aria-label="The guarantee">
    <p class="gt-eyebrow">The guarantee</p>
    <h3 class="gt-h">${esc(g.headline)}</h3>
    <p class="gt-body">${esc(g.body)}</p>
    <p class="gt-c-l">It applies when you do your part:</p>
    <ul class="gt-c">${g.conditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    <p class="gt-def">${g.definitions.map(esc).join(' ')}</p>
    <p class="gt-def"><strong>${esc(g.moneyBack.headline)}:</strong> ${esc(g.moneyBack.body)}</p>
    <p class="gt-def"><strong>The deposit itself:</strong> ${esc(DEPOSIT_REFUND_TERMS)}</p>
    <p class="gt-link"><a href="${esc(g.url)}">Read the guarantee and its conditions</a></p>
  </section>`;
}

// ───────────── State ─────────────

export const paidDeposit = (rt: Runtime, leadId: string) =>
  rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE lead_id = ? AND kind = 'deposit' AND status = 'paid' ORDER BY paid_at DESC LIMIT 1").bind(leadId).first<PassRow & { source?: string | null; ref_id?: string | null }>();

/** This week's places: paid deposits plus checkouts still open (they hold a place until they expire). */
export async function depositCapacity(rt: Runtime, cfg = depositConfig(rt), now = Date.now()) {
  if (cfg.cap == null) return { cap: null, used: 0, left: null as number | null, full: false };
  const from = weekStart(now, rt.settings.SALES_TIMEZONE || 'Australia/Sydney');
  const r = await rt.env.DB.prepare(
    `SELECT COUNT(DISTINCT lead_id) AS n FROM webinar_passes WHERE kind = 'deposit' AND ((status = 'paid' AND paid_at >= ?) OR (status = 'pending' AND created_at >= ? AND COALESCE(expires_at, 0) > ?))`,
  ).bind(from, from, now).first<{ n: number }>();
  const c = capacity(cfg.cap, r?.n ?? 0);
  return { cap: cfg.cap, used: r?.n ?? 0, left: c.left, full: c.full };
}

/** The lead's paid live-funnel ticket(s) not yet credited to a deposit, in the deposit's currency (smallest unit). */
export async function depositTicketCredit(rt: Runtime, leadId: string, currency: string) {
  const used = await rt.env.DB.prepare("SELECT 1 FROM webinar_passes WHERE lead_id = ? AND kind = 'deposit' AND status = 'paid' AND ticket_credit > 0 LIMIT 1").bind(leadId).first();
  if (used) return 0;
  const r = await rt.env.DB.prepare(
    `SELECT COALESCE(SUM(amount - refunded_amount), 0) AS n FROM webinar_passes WHERE lead_id = ? AND status = 'paid' AND lower(currency) = ? AND kind IN (${DEPOSIT_CREDIT_KINDS.map(() => '?').join(',')})`,
  ).bind(leadId, currency.toLowerCase(), ...DEPOSIT_CREDIT_KINDS).first<{ n: number }>();
  return Math.max(0, r?.n ?? 0);
}

/** The card saved with any of the lead's paid Whop purchases (newest first), for one click. */
export async function savedCard(rt: Runtime, leadId: string) {
  return rt.env.DB.prepare(
    `SELECT whop_member_id AS member_id, whop_payment_method_id AS payment_method_id, card_brand, card_last4 FROM webinar_passes
      WHERE lead_id = ? AND status = 'paid' AND provider = 'whop' AND whop_member_id IS NOT NULL AND whop_payment_method_id IS NOT NULL
      ORDER BY paid_at DESC LIMIT 1`,
  ).bind(leadId).first<{ member_id: string; payment_method_id: string; card_brand: string | null; card_last4: string | null }>();
}

/** What the offer needs to show: the price today, one click (and to which card), the places left. */
export async function depositQuote(rt: Runtime, leadId: string) {
  const cfg = depositConfig(rt);
  const credit = await depositTicketCredit(rt, leadId, cfg.currency);
  const full = toMinor(cfg.amount, cfg.currency);
  const today = Math.max(0, full - credit);
  const card = paymentProvider(rt.settings) === 'whop' ? await savedCard(rt, leadId) : null;
  const { cardLabel } = await import('../webinar/one-click');
  const cap = await depositCapacity(rt, cfg);
  const money = (m: number) => formatMoney(fromMinor(m, cfg.currency), cfg.currency);
  return {
    cfg, full, credit, today, todayLabel: money(today), creditLabel: credit ? money(credit) : null,
    oneClick: card ? { card: cardLabel(card.card_brand, card.card_last4) } : null,
    cap, paid: Boolean(await paidDeposit(rt, leadId)), provider: paymentProvider(rt.settings),
  };
}

// ───────────── Start ─────────────

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

export interface StartDepositInput { leadId: string; source: 'live' | 'challenge'; refId: string; regToken?: string | null; oneClick?: boolean; returnUrl: string }

/**
 * Starts the deposit. Returns { paid: true, url } when it is already paid (or one click went through), { url } to
 * send the buyer to (our Whop payment page, or Whop's 3D Secure step), or { error } (nothing was charged).
 * The caller enforces its own offer window (the live room: host opened it, not closed, before the deadline).
 */
export async function startDeposit(rt: Runtime, o: StartDepositInput, x: { now?: number; sleep?: (ms: number) => Promise<unknown>; tries?: number } = {}): Promise<{ url?: string; paid?: boolean; error?: string }> {
  const now = x.now ?? Date.now();
  if (!/^https:\/\//.test(o.returnUrl)) return { error: 'Missing return address.' };
  const lead = await getLead(rt.env, o.leadId);
  if (!lead) return { error: 'We couldn’t find your registration. Open the link from your email and try again.' };
  const q = await depositQuote(rt, o.leadId);
  const copy = depositCopy(q.cfg, { left: q.cap.left });
  if (q.paid) return { paid: true, url: o.returnUrl };
  if (q.provider !== 'whop') return { error: copy.unavailable };
  if (q.cap.full) return { error: copy.soldOut };
  const regId = o.regToken ? `${o.source}:${o.regToken}`.slice(0, 120) : `${o.source}:${o.refId}:${o.leadId}`.slice(0, 120);
  const base = { kind: 'deposit' as const, regId, leadId: o.leadId, product: 'Engagement deposit', currency: q.cfg.currency, source: o.source, refId: o.refId, returnUrl: o.returnUrl, ticketCredit: q.credit, listAmount: q.full, now };
  const { payPageUrl, pendingRow } = await import('./pay-page');
  const who = await identityFromLead(rt.env, o.leadId);
  const log = (outcome: string, props: Record<string, unknown> = {}) => track(rt, who, { name: 'engagement_deposit_checkout', source: 'server', props: { outcome, source: o.source, ref_id: o.refId, ...props }, localOnly: true }).catch(() => null);

  if (q.today <= 0) {
    // Fully covered by ticket credit (only with a tiny deposit setting): record it as paid, nothing to charge.
    const id = await pendingRow(rt, { ...base, amount: 0, embedded: false });
    const { markPassPaid } = await import('../webinar/pass');
    await markPassPaid(rt, { sessionId: `credit_${id}`, paymentIntent: null, amount: 0, currency: q.cfg.currency, regId, passId: id, kind: 'deposit', provider: 'whop' });
    return { paid: true, url: o.returnUrl };
  }

  if (o.oneClick && q.oneClick) {
    const r = await oneClickDeposit(rt, { ...base, amount: q.today }, x).catch((e) => { console.error('deposit one click', String(e).slice(0, 200)); return null; });
    if (r?.paid) { await log('one_click_paid'); return { paid: true, url: o.returnUrl }; }
    if (r?.url) { await log('one_click_action'); return { url: r.url }; }
    await log('one_click_fallback', { reason: r?.reason ?? 'error' });
    // Declined or unavailable: on to the payment page, so the place isn't lost.
  }
  const id = await pendingRow(rt, { ...base, amount: q.today });
  await log('page', { pass_id: id, value: fromMinor(q.today, q.cfg.currency) });
  return { url: await payPageUrl(rt, id) };
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One click on the saved card (Whop Create Payment, customer-initiated so 3D Secure can run). */
async function oneClickDeposit(rt: Runtime, o: { kind: 'deposit'; regId: string; leadId: string; product: string; amount: number; currency: string; source: string; refId: string; returnUrl: string; ticketCredit: number; listAmount: number; now: number }, x: { sleep?: (ms: number) => Promise<unknown>; tries?: number }) {
  const card = await savedCard(rt, o.leadId);
  if (!card) return { reason: 'no_method' };
  const db = rt.env.DB;
  const id = newId('wp');
  const ins = await db.prepare(
    `INSERT OR IGNORE INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, expires_at, list_amount, ticket_credit, provider, one_click,
       whop_member_id, whop_payment_method_id, card_brand, card_last4, source, ref_id, return_url, created_at, updated_at)
     VALUES (?, ?, ?, 'deposit', ?, 'pending', ?, ?, ?, ?, ?, 'whop', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, o.regId, o.leadId, o.product, o.amount, o.currency.toLowerCase(), o.now + 30 * MIN, o.listAmount, o.ticketCredit, card.member_id, card.payment_method_id, card.card_brand, card.card_last4, o.source, o.refId, o.returnUrl, o.now, o.now).run();
  if ((ins.meta.changes ?? 0) === 0) return { reason: 'in_flight' }; // a second click: never a second charge
  const expire = () => db.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), id).run();
  const { WHOP_NATIVE_VERSION, WHOP_PRODUCT, whopApi, whopCompanyId } = await import('../webinar/whop');
  let payId: string | null = null;
  try {
    const pay = await whopApi<Obj>(rt, 'POST', 'payments', {
      account_id: await whopCompanyId(rt),
      variant: { currency: o.currency.toLowerCase(), billing_type: 'one_time', initial_price: fromMinor(o.amount, o.currency), title: o.product, description: 'Engagement deposit with G&L M&A Advisory, credited in full against the advisory engagement fee.', visibility: 'hidden', product: { external_identifier: WHOP_PRODUCT.deposit, title: o.product, visibility: 'hidden' } },
      member_id: card.member_id, payment_method_id: card.payment_method_id, off_session: false, return_url: o.returnUrl,
      metadata: { pass_id: id, reg_id: o.regId, lead_id: o.leadId, kind: 'deposit', source: o.source, ref_id: o.refId, one_click: '1' },
    }, { version: WHOP_NATIVE_VERSION, idempotencyKey: `deposit_one_click_${id}` });
    payId = str(pay.id);
    if (!payId) throw new Error('Whop returned no payment id');
  } catch (e) {
    await expire();
    console.error('deposit one-click failed', String(e).slice(0, 300));
    return { reason: 'declined_or_unavailable' };
  }
  await db.prepare('UPDATE webinar_passes SET stripe_session_id = COALESCE(stripe_session_id, ?), stripe_payment_intent = ?, updated_at = ? WHERE id = ?').bind(`whop_${payId}`, payId, Date.now(), id).run();
  let st: Obj = {};
  for (let i = 0; i < (x.tries ?? 4); i++) {
    if (i) await (x.sleep ?? sleepMs)(750);
    st = await whopApi<Obj>(rt, 'GET', `payments/${encodeURIComponent(payId)}/status`, undefined, { version: WHOP_NATIVE_VERSION }).catch(() => ({}));
    if (['succeeded', 'requires_action', 'canceled'].includes(String(st.status)) || (st.status === 'requires_confirmation' && st.last_payment_error)) break;
  }
  const row = { id, reg_id: o.regId, amount: o.amount, currency: o.currency.toLowerCase(), kind: 'deposit' as const, whop_payment_method_id: card.payment_method_id };
  if (st.status === 'succeeded') {
    const { markWhopPaymentPaid } = await import('../webinar/one-click');
    const { passPaidEffects } = await import('../webinar/pass');
    await markWhopPaymentPaid(rt, row, payId, passPaidEffects);
    return { paid: true };
  }
  if (st.status === 'requires_action') {
    const na = obj(st.next_action);
    const url = na.type === 'redirect' ? str(obj(na.data).url) : null;
    if (url) return { url };
    return { url: o.returnUrl }; // the welcome page waits for it (and the webhook marks it paid)
  }
  if (st.status === 'canceled' || (st.status === 'requires_confirmation' && st.last_payment_error)) { await expire(); return { reason: 'declined' }; }
  return { url: o.returnUrl }; // still settling: the welcome page waits for it
}

// ───────────── Paid / refunded ─────────────

/** The onboarding email (plain text; escaped when sent). Pure, for the tests. */
export function depositWelcomeEmail(x: { name: string; amount: string; onboardingUrl: string | null; welcomeUrl: string; guaranteeUrl: string; headline: string }) {
  return {
    subject: 'Your place in the engagement is secured',
    preheader: x.onboardingUrl ? 'Book your onboarding call first.' : 'Josh’s team emails you to set the onboarding call.',
    heading: 'Your place is secured',
    paras: [
      `Hi ${x.name},`,
      `Your ${x.amount} deposit is through, and your place in this intake of the engagement is held for you. The full deposit is credited against the engagement fee.`,
      x.onboardingUrl ? `First step: book your onboarding call. It is about 30 minutes, with Josh’s team, to set up your kickoff. Book it here: ${x.onboardingUrl}` : 'First step: the onboarding call, about 30 minutes, to set up your kickoff. Josh’s team emails you within one business day to set the time.',
      'After the call you receive the engagement agreement to sign, with your deposit already taken off the fee. The balance is due when you sign it.',
      `Your guarantee: ${x.headline}. The conditions are here: ${x.guaranteeUrl}`,
    ],
    button: x.onboardingUrl ? { label: 'Book my onboarding call', href: x.onboardingUrl } : { label: 'See what happens next', href: x.welcomeUrl },
  };
}

export const onboardingUrl = (rt: Runtime) => (/^https:\/\/[^\s<>"']+$/.test(String((rt.settings as Partial<Record<string, string>>).ENGAGEMENT_ONBOARDING_URL ?? '').trim()) ? String((rt.settings as Partial<Record<string, string>>).ENGAGEMENT_ONBOARDING_URL).trim() : null);

/** Drafts (or refreshes) the engagement agreement with the deposit credited. Returns the contract id. */
export async function draftEngagementForDeposit(rt: Runtime, leadId: string) {
  const { createContract, getContract, updateDraft } = await import('./contracts');
  const lead = await getLead(rt.env, leadId);
  if (!lead) return null;
  const open = await rt.env.DB.prepare("SELECT id, status FROM contracts WHERE lead_id = ? AND status IN ('draft', 'sent', 'viewed') AND COALESCE(is_test, 0) = 0 ORDER BY created_at DESC LIMIT 1").bind(leadId).first<{ id: string; status: string }>();
  if (open?.status === 'draft') { const c = await getContract(rt, open.id); if (c) await updateDraft(rt, c, {}); return open.id; }
  if (open) return open.id; // already sent: the team adjusts it by hand (Funnel HQ shows the deposit)
  const k = await createContract(rt, lead, {
    title: 'Advisory Engagement Agreement',
    payment_terms: 'The balance after the engagement deposit is due on signing.',
    term_text: '90 days from the date both parties sign',
  });
  return k?.id ?? null;
}

export async function depositPaidEffects(rt: Runtime, pass: PassRow) {
  const lead = await getLead(rt.env, pass.lead_id);
  const value = fromMinor(pass.amount, pass.currency);
  const paid = formatMoney(value, pass.currency.toUpperCase());
  const p = pass as PassRow & { source?: string | null; ref_id?: string | null; return_url?: string | null; one_click?: number };
  await rt.env.DB.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').bind(Date.now(), pass.lead_id).run();
  // Meta Purchase / GA4: value = what was actually paid now.
  await track(rt, await identityFromLead(rt.env, pass.lead_id), { name: 'engagement_deposit_purchased', source: 'webhook', props: { pass_id: pass.id, product: 'Engagement deposit', value, currency: pass.currency.toUpperCase(), source: p.source ?? null, ref_id: p.ref_id ?? null } }).catch((e) => console.error('deposit track', e));
  // A deposit from the challenge also marks that registration's deposit (stops the offer emails, counts in the cohort report).
  if (p.source === 'challenge' && p.ref_id) {
    const { recordChallengeDeposit } = await import('../challenge/offer');
    await recordChallengeDeposit(rt, { refId: p.ref_id, amount: pass.amount, currency: pass.currency }).catch((e) => console.error('challenge deposit record', e));
  }
  const contractId = await draftEngagementForDeposit(rt, pass.lead_id).catch((e) => { console.error('deposit agreement draft', e); return null; });
  if (lead) {
    const { notifySlack } = await import('../integrations/notify');
    const band = lead.revenue_band ? REVENUE_LABEL[lead.revenue_band] ?? lead.revenue_band : 'revenue not given';
    const money = (m: number) => formatMoney(fromMinor(m, pass.currency), pass.currency.toUpperCase());
    rt.waitUntil(notifySlack(rt, lead, '💳 Engagement deposit paid', [
      `Paid: ${paid}${pass.ticket_credit ? ` (after the ${money(pass.ticket_credit)} ticket credit; ${money(pass.amount + pass.ticket_credit)} credited)` : ''} · ${band}`,
      `From: ${p.source === 'challenge' ? 'the First Deal Challenge' : 'the live webinar'}${p.one_click ? ' · one click' : ''}`,
      contractId ? 'Engagement agreement drafted with the deposit credited: review and send it from Funnel HQ → Agreements after the onboarding call.' : 'Draft the engagement agreement in Funnel HQ → Agreements (the deposit credit applies automatically).',
      onboardingUrl(rt) ? 'They can book the onboarding call from the welcome page and the email.' : 'No onboarding booking link is set (ENGAGEMENT_ONBOARDING_URL): email them to set the call.',
    ], 'hot_lead').catch((e) => console.error('deposit slack failed', e)));
    if (lead.email) {
      const g = guarantee(rt);
      const { sendOnce } = await import('../live/mail');
      const { safeFirstName } = await import('../lib/text');
      const welcomeUrl = p.return_url && /^https:\/\//.test(p.return_url) ? p.return_url : g.url;
      rt.waitUntil(sendOnce(rt, lead, DEPOSIT_SEQUENCE, 0, 'deposit_welcome', depositWelcomeEmail({
        name: safeFirstName(lead.first_name) ?? 'there', amount: formatMoney(fromMinor(pass.amount + (pass.ticket_credit ?? 0), pass.currency), pass.currency.toUpperCase()),
        onboardingUrl: onboardingUrl(rt), welcomeUrl, guaranteeUrl: g.url, headline: g.headline || GUARANTEE_HEADLINE,
      })).then(() => undefined).catch((e) => console.error('deposit welcome email', e)));
    }
  }
}

/** A fully refunded deposit: its credit is gone (markPassRefunded zeroes it), so a draft agreement is refreshed. */
export async function depositRefunded(rt: Runtime, pass: PassRow) {
  await draftEngagementForDeposit(rt, pass.lead_id).catch(() => null);
  const lead = await getLead(rt.env, pass.lead_id);
  if (lead) {
    const { notifySlack } = await import('../integrations/notify');
    rt.waitUntil(notifySlack(rt, lead, 'Engagement deposit refunded', ['The deposit credit is removed from any draft agreement.'], 'hot_lead').catch(() => null));
  }
}

/** Back on the return page: the purchase for this source and reference (paid, or still settling). */
export async function depositStatus(rt: Runtime, leadId: string, refId?: string | null) {
  const row = await rt.env.DB.prepare(
    `SELECT * FROM webinar_passes WHERE lead_id = ? AND kind = 'deposit' ${refId ? 'AND ref_id = ?' : ''} AND status IN ('paid', 'pending') ORDER BY CASE status WHEN 'paid' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
  ).bind(...(refId ? [leadId, refId] : [leadId])).first<PassRow & { one_click?: number; embedded?: number }>();
  if (!row) return (await paidDeposit(rt, leadId)) ? 'paid' as const : 'none' as const;
  if (row.status === 'paid') return 'paid' as const;
  if (row.stripe_payment_intent || row.stripe_session_id) {
    const { whopConfirm } = await import('../webinar/whop');
    const r = await whopConfirm(rt, row).catch(() => 'unknown' as const);
    if (r === 'paid') return 'paid' as const;
    if (r === 'pending') return 'pending' as const;
  }
  return 'none' as const;
}

export { PassError };

import type { Runtime } from '../app';
import { newId, newRefCode } from '../lib/ids';
import type { VisitorCtx } from '../lib/identity';
import { ApplicationError, attributionFor, verifyTurnstile } from '../funnel/application';
import { cleanName, getLead, getLeadByEmail, linkVisitor, normalisePhone, updateLead, validateEmail } from '../funnel/leads';
import { APP_REVENUE_BAND } from '../sales/qualify';
import { identityFromLead, identityFromVisitor, track } from '../tracking/track';
import { trackRevenueEvents } from '../tracking/revenue-events';
import { fromMinor, toMinor } from '../webinar/pass';
import { WHOP_NATIVE_VERSION, WhopError, checkoutFailed, paymentMethodOf, whopApi, whopCompanyId, whopMoney } from '../webinar/whop';
import { CHECKOUT } from './content';
import { type Registration, challengeConfig, getCohort, getDays, getReg, getRegById, nextCohort } from './cohorts';
import { formatWhen, registrationOpen } from './schedule';

/**
 * Registration and money for the First Deal Challenge.
 *  - The $100 ticket is paid on our own page with Whop's payment elements (the same embedded form as the
 *    Masterclass ticket, ticket-pay.ts createElementsPayment), card saved with the buyer's consent.
 *  - The $300 VIP bump is then one click on that saved card (customer-initiated, 3D Secure possible), or the
 *    same card form when there is no saved card or the charge is declined.
 *  - One payment in flight and one paid per registration and kind (partial unique indexes), Whop gets the
 *    order id as the Idempotency-Key, and the webhook (payment.succeeded / refund.*) settles anything the
 *    browser didn't.
 */

export type OrderKind = 'ticket' | 'vip';
export interface Order {
  id: string; reg_id: string; lead_id: string; kind: OrderKind; status: 'pending' | 'paid' | 'expired' | 'refunded'; amount: number; currency: string;
  provider: string; method: string; checkout_id: string | null; whop_payment_id: string | null; whop_member_id: string | null; whop_payment_method_id: string | null;
  card_brand: string | null; card_last4: string | null; refunded_amount: number; created_at: number; updated_at: number; paid_at: number | null;
}

const MIN = 60_000;
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
export const CHALLENGE_PRODUCT: Record<OrderKind, string> = { ticket: 'vsl-funnel-challenge-ticket', vip: 'vsl-funnel-challenge-vip' };

export const base = (rt: Runtime) => `${rt.origin}/challenge`;
export const payUrl = (rt: Runtime, token: string, kind: OrderKind = 'ticket') => `${base(rt)}/pay/${token}${kind === 'vip' ? '?kind=vip' : ''}`;
export const vipUrl = (rt: Runtime, token: string) => `${base(rt)}/vip/${token}`;
export const welcomeUrl = (rt: Runtime, token: string) => `${base(rt)}/welcome/${token}`;
export const hubUrl = (rt: Runtime, token: string) => `${base(rt)}/hub/${token}`;
export const dayUrl = (rt: Runtime, token: string, n: number) => `${base(rt)}/day/${token}/${n}`;

const token = () => { const b = crypto.getRandomValues(new Uint8Array(18)); return Array.from(b, (x) => (x % 36).toString(36)).join(''); };

// ───────────── registration ─────────────

/**
 * The landing form: name, email, revenue band (and an optional mobile for reminder texts). An email that
 * already has a lead is attached to it without changing its details; only a sign-up that created the lead
 * may link this browser to it (the same rule as the masterclass).
 */
export async function registerChallenge(rt: Runtime, v: VisitorCtx, body: Record<string, unknown>, now = Date.now()) {
  const firstName = cleanName(body.first_name);
  const emailCheck = validateEmail(body.email);
  if (!firstName) throw new ApplicationError('Please enter your first name', 'first_name');
  if (!emailCheck) throw new ApplicationError('Please enter a valid email address', 'email');
  if (emailCheck.disposable) throw new ApplicationError('Please use your real email address. Your session links go there.', 'email');
  const band = APP_REVENUE_BAND[String(body.revenue ?? '')] ?? null;
  if (!band) throw new ApplicationError('Please pick your business’s annual revenue', 'revenue');
  if (!(await verifyTurnstile(rt, body.turnstile, v.ip))) throw new ApplicationError('Security check failed. Refresh and try again.', undefined, 403);
  const wantsTexts = body.sms_consent === true || body.sms_consent === 'true' || body.sms_consent === 'on';
  const phone = typeof body.phone === 'string' && body.phone.trim() ? normalisePhone(body.phone, v.geo.country) : null;
  if (typeof body.phone === 'string' && body.phone.trim() && !phone) throw new ApplicationError('Please enter a valid mobile number with its area code, or leave it blank', 'phone');

  const loaded = typeof body.cohort_id === 'string' && body.cohort_id
    ? await (async () => { const c = await getCohort(rt, body.cohort_id as string); return c ? { cohort: c, days: await getDays(rt, c.id) } : null; })()
    : await nextCohort(rt, now);
  if (!loaded || !registrationOpen(loaded.days, loaded.cohort.status, now)) throw new ApplicationError('Registration for that cohort has closed. Refresh to see the next one.', undefined, 409);
  const cohort = loaded.cohort;

  const ipKey = `chreg:${v.ip ?? 'unknown'}`;
  const row = await rt.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(ipKey).first<{ value: string }>();
  const rate = (() => { try { const r = JSON.parse(row?.value ?? '{}') as { n?: number; t?: number }; return r.t && now - r.t < 3_600_000 ? { n: r.n ?? 0, t: r.t } : { n: 0, t: now }; } catch { return { n: 0, t: now }; } })();
  if (rate.n >= 8) throw new ApplicationError('Too many sign-ups from this connection. Try again in an hour.', undefined, 429);

  let lead = await getLeadByEmail(rt.env, emailCheck.email);
  let newLead = false;
  if (!lead) {
    const { last, first } = await attributionFor(rt, v);
    const id = newId('l');
    await rt.env.DB.prepare(
      `INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, session_id, first_name, last_name, email, phone, sms_consent_at, wa_consent_at, whatsapp_opt_in, step_reached, status,
         channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term, click_id, click_type, ft_channel, ft_source, ft_campaign, ft_content,
         landing_path, variant, country, city, device, fbp, fbc, timezone)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,'partial',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, newRefCode(), now, now, v.visitorId, v.sessionId, firstName, cleanName(body.last_name), emailCheck.email, phone, phone && wantsTexts ? now : null, phone && wantsTexts ? now : null,
      last?.channel ?? 'Direct', last?.utm_source ?? null, last?.utm_medium ?? null, last?.utm_campaign ?? null, last?.utm_content ?? null, last?.utm_term ?? null,
      last?.click_id ?? null, last?.click_type ?? null, first?.ft_channel ?? null, first?.ft_source ?? null, first?.ft_campaign ?? null, first?.ft_content ?? null,
      last?.landing_path ?? '/challenge', v.variant, v.geo.country, v.geo.city, v.ua.device, v.fbp, v.fbc, v.geo.timezone,
    ).run();
    lead = (await getLead(rt.env, id))!;
    newLead = true;
    await linkVisitor(rt.env, v.visitorId, lead.id);
  }

  const existing = await rt.env.DB.prepare('SELECT * FROM challenge_registrations WHERE lead_id = ? AND cohort_id = ?').bind(lead.id, cohort.id).first<Registration>();
  if (existing) {
    if (v.leadId === lead.id || newLead) return { reg: existing, created: false };
    throw new ApplicationError('You’re already registered for this cohort. Your link is in the email we sent you (check spam too).', 'email', 409);
  }
  await rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(ipKey, JSON.stringify({ n: rate.n + 1, t: rate.t })).run();
  const prior = await rt.env.DB.prepare('SELECT COUNT(*) AS n FROM challenge_registrations WHERE lead_id = ?').bind(lead.id).first<{ n: number }>();
  const reg: Registration = {
    id: newId('cr'), token: token(), cohort_id: cohort.id, lead_id: lead.id, seq: prior?.n ?? 0, revenue_band: band, status: 'pending', vip: 0, vip_seen_at: null,
    created_at: now, paid_at: null, vip_at: null, refunded_at: null,
  };
  await rt.env.DB.prepare('INSERT INTO challenge_registrations (id, token, cohort_id, lead_id, seq, revenue_band, status, created_at) VALUES (?, ?, ?, ?, ?, ?, \'pending\', ?)')
    .bind(reg.id, reg.token, reg.cohort_id, reg.lead_id, reg.seq, band, now).run();
  const bandIsNew = !lead.revenue_band;
  if (bandIsNew) await updateLead(rt.env, lead.id, { revenue_band: band });
  if (phone && wantsTexts && !lead.phone) await updateLead(rt.env, lead.id, { phone, sms_consent_at: now });

  const who = newLead ? identityFromVisitor(v, null, lead.id) : await identityFromLead(rt.env, lead.id);
  await track(rt, who, { name: 'challenge_registered', source: 'server', path: '/challenge', props: { cohort_id: cohort.id, band }, eventId: typeof body.event_id === 'string' ? body.event_id : undefined });
  if (bandIsNew) await trackRevenueEvents(rt, who, band, 'challenge', '/challenge');
  await (await import('../attribution/hooks')).onRegistered(rt, v, { funnel: 'challenge', regId: reg.id, leadId: lead.id, at: now, cohortRef: cohort.id, pixelEid: body.pixel_eid }); // first/last touch + Lead (attribution)

  // A free cohort (CHALLENGE_PRICE 0): the ticket is confirmed straight away.
  if (challengeConfig(rt.settings).free) await markOrderPaid(rt, await freeOrder(rt, reg), null);
  return { reg: (await getRegById(rt, reg.id))!, created: true };
}

async function freeOrder(rt: Runtime, reg: Registration) {
  const id = newId('co');
  const now = Date.now();
  await rt.env.DB.prepare("INSERT INTO challenge_orders (id, reg_id, lead_id, kind, status, amount, currency, provider, method, created_at, updated_at) VALUES (?, ?, ?, 'ticket', 'pending', 0, ?, 'none', 'free', ?, ?)")
    .bind(id, reg.id, reg.lead_id, challengeConfig(rt.settings).currency.toLowerCase(), now, now).run();
  return (await getOrder(rt, id))!;
}

/** Where a registration goes next: pay the ticket, see the VIP bump once, then the welcome page. */
export function nextStep(rt: Runtime, reg: Registration) {
  if (reg.status === 'pending') return payUrl(rt, reg.token);
  if (reg.status === 'paid' && !reg.vip && !reg.vip_seen_at && challengeConfig(rt.settings).vipOn) return vipUrl(rt, reg.token);
  return reg.status === 'paid' ? welcomeUrl(rt, reg.token) : `${base(rt)}`;
}

// ───────────── orders ─────────────

export const getOrder = (rt: Runtime, id: string) => rt.env.DB.prepare('SELECT * FROM challenge_orders WHERE id = ?').bind(id).first<Order>();
export const paidOrder = (rt: Runtime, regId: string, kind: OrderKind) =>
  rt.env.DB.prepare("SELECT * FROM challenge_orders WHERE reg_id = ? AND kind = ? AND status = 'paid'").bind(regId, kind).first<Order>();

/** The card saved with the lead's newest paid challenge ticket (or VIP), for one-click charges. */
export async function savedChallengeMethod(rt: Runtime, leadId: string) {
  return rt.env.DB.prepare(
    `SELECT whop_member_id AS member_id, whop_payment_method_id AS payment_method_id, card_brand, card_last4 FROM challenge_orders
      WHERE lead_id = ? AND status = 'paid' AND provider = 'whop' AND whop_member_id IS NOT NULL AND whop_payment_method_id IS NOT NULL ORDER BY paid_at DESC LIMIT 1`,
  ).bind(leadId).first<{ member_id: string; payment_method_id: string; card_brand: string | null; card_last4: string | null }>().catch(() => null);
}

/** The challenge ticket's amount (smallest unit) a lead paid and still holds, for crediting against the deposit. */
export async function challengeTicketCredit(rt: Runtime, leadId: string) {
  const r = await rt.env.DB.prepare("SELECT amount - refunded_amount AS amount, currency FROM challenge_orders WHERE lead_id = ? AND kind = 'ticket' AND status = 'paid' ORDER BY paid_at DESC LIMIT 1")
    .bind(leadId).first<{ amount: number; currency: string }>();
  return r && r.amount > 0 ? r : null;
}

const priceOf = (rt: Runtime, kind: OrderKind) => { const c = challengeConfig(rt.settings); return kind === 'ticket' ? { minor: c.ticketMinor, major: c.ticket, label: c.ticketLabel, currency: c.currency } : { minor: c.vipMinor, major: c.vip, label: c.vipLabel, currency: c.currency }; };
const titleOf = (kind: OrderKind) => (kind === 'ticket' ? 'The First Deal Challenge: ticket' : 'The First Deal Challenge: VIP upgrade');
const descriptionOf = (kind: OrderKind) => (kind === 'ticket'
  ? 'Five live sessions with Josh Li on Zoom, with daily worksheets. Credited against the engagement deposit if you continue.'
  : 'VIP for the First Deal Challenge: a hot seat after every session, recordings kept, and written feedback on your worksheets.');

export class PayError extends Error { constructor(message: string, public status = 400) { super(message); } }

/** May this registration buy this kind right now? */
async function buyGate(rt: Runtime, reg: Registration, kind: OrderKind) {
  const cfg = challengeConfig(rt.settings);
  if (cfg.provider !== 'whop') throw new PayError(CHECKOUT.unavailable, 409);
  if (reg.status === 'refunded') throw new PayError('This registration was refunded. Register again from the challenge page.', 409);
  if (kind === 'ticket' && reg.status === 'paid') return 'done' as const;
  if (kind === 'vip') {
    if (!cfg.vipOn) throw new PayError('VIP isn’t offered for this cohort.', 409);
    if (reg.status !== 'paid') throw new PayError('Pay your ticket first.', 409);
    if (reg.vip) return 'done' as const;
  }
  const loaded = await getDays(rt, reg.cohort_id);
  const d5 = loaded.find((d) => d.day === 5);
  if (kind === 'ticket') {
    const c = await getCohort(rt, reg.cohort_id);
    if (!c || !registrationOpen(loaded, c.status, Date.now())) throw new PayError('Registration for this cohort has closed.', 409);
  } else if (!d5 || Date.now() > d5.starts_at + d5.duration_min * MIN) throw new PayError('VIP closed when the challenge ended.', 409);
  return 'open' as const;
}

/** What ticket-pay.js needs to mount the card form for the ticket or VIP (window.FUNNEL.ticketPay). */
export async function payFormConfig(rt: Runtime, reg: Registration, kind: OrderKind) {
  const p = priceOf(rt, kind);
  const lead = await getLead(rt.env, reg.lead_id);
  const cohort = await getCohort(rt, reg.cohort_id);
  const d1 = (await getDays(rt, reg.cohort_id)).find((d) => d.day === 1);
  const when = d1 && cohort ? formatWhen(d1.starts_at, cohort.timezone, { weekday: true, tzName: true }) : 'soon';
  const back = `${payUrl(rt, reg.token, kind)}${kind === 'vip' ? '&' : '?'}return=1`;
  return {
    token: reg.token,
    kind,
    payUrl: '/api/challenge/pay',
    trackId: kind === 'ticket' ? 'challenge_ticket_pay' : 'challenge_vip_pay',
    src: 'https://cdn.whop.com/elements/amber/elements.js',
    accountId: await whopCompanyId(rt),
    amount: p.minor,
    currency: p.currency.toLowerCase(),
    saveCard: kind === 'ticket',
    email: lead?.email ?? null,
    name: [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || null,
    returnUrl: back,
    hostedUrl: `${payUrl(rt, reg.token, kind)}${kind === 'vip' ? '&' : '?'}hosted=1`,
    copy: payCopy(kind, p.label, when),
  };
}

export function payCopy(kind: OrderKind, label: string, when: string) {
  return {
    eyebrow: kind === 'ticket' ? CHECKOUT.ticketEyebrow : CHECKOUT.vipEyebrow,
    heading: kind === 'ticket' ? CHECKOUT.ticketHeading : CHECKOUT.vipHeading,
    lede: kind === 'ticket' ? CHECKOUT.ticketLede(label, when) : CHECKOUT.vipLede,
    saveNote: kind === 'ticket' ? CHECKOUT.ticketSave(label) : CHECKOUT.vipFormSave(label),
    button: kind === 'ticket' ? CHECKOUT.ticketButton(label) : CHECKOUT.vipForm(label),
    paying: CHECKOUT.paying, declined: CHECKOUT.declined, failed: CHECKOUT.failed, hosted: CHECKOUT.hosted, hostedLink: CHECKOUT.hostedLink, loading: CHECKOUT.loading,
  };
}

export type PayResult =
  | { ok: true; next: string }
  | { ok: true; payment: string; client_secret: string | null; settle: string }
  | { ok: false; error: string; hosted: string };

/** POST /api/challenge/pay: the ticket (card saved) or VIP from the elements' confirmation token. */
export async function payOrder(rt: Runtime, reg: Registration, kind: OrderKind, confirmationToken: unknown, now = Date.now()): Promise<PayResult> {
  const p = priceOf(rt, kind);
  const done = kind === 'ticket' ? nextStep(rt, { ...reg, status: 'paid' }) : welcomeUrl(rt, reg.token);
  const settle = `${payUrl(rt, reg.token, kind)}${kind === 'vip' ? '&' : '?'}return=1`;
  const hosted = `${payUrl(rt, reg.token, kind)}${kind === 'vip' ? '&' : '?'}hosted=1`;
  if ((await buyGate(rt, reg, kind)) === 'done') return { ok: true, next: done };
  const ctok = str(confirmationToken);
  if (!ctok || !/^ctok_[A-Za-z0-9_]{4,120}$/.test(ctok)) throw new PayError(CHECKOUT.failed, 400);
  const db = rt.env.DB;
  const insert = (id: string) => db.prepare(
    "INSERT OR IGNORE INTO challenge_orders (id, reg_id, lead_id, kind, status, amount, currency, provider, method, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, 'whop', 'form', ?, ?)",
  ).bind(id, reg.id, reg.lead_id, kind, p.minor, p.currency.toLowerCase(), now, now).run();
  let id = newId('co');
  if (((await insert(id)).meta.changes ?? 0) === 0) {
    // One already in flight (a second press, or a 3D Secure dialog closed): settle it or start fresh.
    const prev = await db.prepare("SELECT * FROM challenge_orders WHERE reg_id = ? AND kind = ? AND status = 'pending'").bind(reg.id, kind).first<Order>();
    if (prev?.whop_payment_id) {
      const s = await settleOrder(rt, prev);
      if (s === 'paid') return { ok: true, next: done };
      if (s === 'pending' && now - prev.created_at < 2 * MIN) return { ok: true, next: settle };
    }
    if (prev) await db.prepare("UPDATE challenge_orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, prev.id).run();
    id = newId('co');
    if (((await insert(id)).meta.changes ?? 0) === 0) return { ok: true, next: settle };
  }
  let pay: Obj;
  try {
    const { createElementsPayment } = await import('../webinar/ticket-pay');
    pay = await createElementsPayment(rt, {
      title: titleOf(kind), description: descriptionOf(kind), externalId: CHALLENGE_PRODUCT[kind], price: p.major, currency: p.currency,
      confirmationToken: ctok, saveCard: kind === 'ticket', returnUrl: settle,
      metadata: { challenge_order_id: id, reg_id: reg.id, lead_id: reg.lead_id, kind: `challenge_${kind}` },
      idempotencyKey: `challenge_${id}`,
    });
  } catch (e) {
    await db.prepare("UPDATE challenge_orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), id).run();
    const { paymentDeclined } = await import('../webinar/ticket-pay');
    const declined = paymentDeclined(e);
    console.error('challenge payment failed', String(e instanceof Error ? e.message : e).slice(0, 300));
    if (!declined) await checkoutFailed(rt, { kind: 'seat', amount: p.minor, currency: p.currency, title: titleOf(kind), error: e, leadId: reg.lead_id }).catch(() => null);
    return { ok: false, error: declined ? CHECKOUT.declined : CHECKOUT.failed, hosted };
  }
  const payId = str(pay.id)!;
  await db.prepare('UPDATE challenge_orders SET whop_payment_id = ?, updated_at = ? WHERE id = ?').bind(payId, Date.now(), id).run();
  await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'challenge_checkout_started', source: 'server', props: { order_id: id, kind }, localOnly: true }).catch(() => null);
  if (pay.status === 'paid' || pay.status === 'succeeded') {
    await markOrderPaid(rt, (await getOrder(rt, id))!, payId, pay);
    return { ok: true, next: done };
  }
  return { ok: true, payment: payId, client_secret: str(pay.client_secret), settle };
}

/** Back from 3D Secure, or a payment still settling: Whop's status decides. */
export async function settleOrder(rt: Runtime, o: Order): Promise<'paid' | 'pending' | 'unknown'> {
  if (o.status === 'paid') return 'paid';
  if (!o.whop_payment_id && o.checkout_id) return confirmHosted(rt, o);
  if (!o.whop_payment_id) return 'unknown';
  const { pollStatus } = await import('../webinar/one-click');
  const st = await pollStatus(rt, o.whop_payment_id, { tries: 1 });
  if (st.status === 'succeeded') { await markOrderPaid(rt, o, o.whop_payment_id); return 'paid'; }
  if (st.status === 'canceled' || (st.status === 'requires_confirmation' && st.last_payment_error)) {
    await rt.env.DB.prepare("UPDATE challenge_orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), o.id).run();
    return 'unknown';
  }
  return st.status ? 'pending' : 'unknown';
}

/** The newest order of this kind for the registration, settled against Whop (the return page). */
export async function confirmOnReturn(rt: Runtime, reg: Registration, kind: OrderKind) {
  const o = await rt.env.DB.prepare('SELECT * FROM challenge_orders WHERE reg_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1').bind(reg.id, kind).first<Order>();
  return o ? settleOrder(rt, o) : 'unknown';
}

/**
 * Marks an order paid (once) and runs its effects: the ticket confirms the registration and starts the emails
 * and texts; VIP turns VIP on. The saved card is kept on the order for the VIP bump and the deposit.
 */
export async function markOrderPaid(rt: Runtime, o: Order, payId: string | null, pay?: Obj, now = Date.now()) {
  const res = await rt.env.DB.prepare("UPDATE challenge_orders SET status = 'paid', paid_at = ?, whop_payment_id = COALESCE(?, whop_payment_id), updated_at = ? WHERE id = ? AND status IN ('pending', 'expired')")
    .bind(now, payId, now, o.id).run();
  if ((res.meta.changes ?? 0) === 0) return { duplicate: true };
  if (payId && o.provider === 'whop') await storeMethod(rt, o.id, pay ?? { id: payId }).catch((e) => console.error('challenge card', String(e).slice(0, 200)));
  const reg = await getRegById(rt, o.reg_id);
  if (!reg) return { duplicate: false };
  await (await import('../attribution/hooks')).onOrderPaid(rt, { ...o, paid_at: now }); // conversion with first/last touch (attribution)
  const who = await identityFromLead(rt.env, reg.lead_id);
  const value = fromMinor(o.amount, o.currency);
  const { startChallengeMessages, vipWelcome } = await import('./emails');
  if (o.kind === 'ticket') {
    await rt.env.DB.prepare("UPDATE challenge_registrations SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending'").bind(now, reg.id).run();
    await startChallengeMessages(rt, reg.id);
    await track(rt, who, { name: 'challenge_ticket_paid', source: 'server', path: '/challenge', props: { order_id: o.id, cohort_id: reg.cohort_id, value, currency: o.currency.toUpperCase() } });
  } else {
    await rt.env.DB.prepare('UPDATE challenge_registrations SET vip = 1, vip_at = ? WHERE id = ?').bind(now, reg.id).run();
    await vipWelcome(rt, reg.id);
    await track(rt, who, { name: 'challenge_vip_paid', source: 'server', path: '/challenge', props: { order_id: o.id, cohort_id: reg.cohort_id, value, currency: o.currency.toUpperCase() } });
  }
  return { duplicate: false };
}

async function storeMethod(rt: Runtime, orderId: string, pay: Obj) {
  let m = paymentMethodOf(pay);
  const payId = str(pay.id);
  if ((!m.memberId || !m.paymentMethodId) && payId && rt.settings.WHOP_API_KEY) {
    const full = await whopApi<Obj>(rt, 'GET', `payments/${encodeURIComponent(payId)}`).catch(() => null);
    if (full) m = { ...paymentMethodOf(full), ...Object.fromEntries(Object.entries(m).filter(([, x]) => x)) };
  }
  if (!m.memberId || !m.paymentMethodId) return false;
  await rt.env.DB.prepare('UPDATE challenge_orders SET whop_member_id = ?, whop_payment_method_id = ?, card_brand = COALESCE(?, card_brand), card_last4 = COALESCE(?, card_last4) WHERE id = ?')
    .bind(m.memberId, m.paymentMethodId, m.brand ?? null, m.last4 ?? null, orderId).run();
  return true;
}

// ───────────── the one-click VIP bump ─────────────

export async function vipOffer(rt: Runtime, reg: Registration) {
  const m = await savedChallengeMethod(rt, reg.lead_id);
  const { cardLabel } = await import('../webinar/one-click');
  return { card: m ? cardLabel(m.card_brand, m.card_last4) : null, oneClick: Boolean(m) };
}

export type OneClickResult = { ok: true; next: string; outcome: 'paid' | 'pending' | 'action' | 'in_flight' } | { ok: false; fallback: string; outcome: 'declined' | 'unavailable' | 'no_method' };

/** POST /api/challenge/vip: charge the ticket's saved card for VIP (customer-initiated: 3D Secure allowed). */
export async function oneClickVip(rt: Runtime, reg: Registration, o: { now?: number; sleep?: (ms: number) => Promise<unknown>; tries?: number } = {}): Promise<OneClickResult> {
  const now = o.now ?? Date.now();
  const welcome = welcomeUrl(rt, reg.token);
  const form = payUrl(rt, reg.token, 'vip');
  if ((await buyGate(rt, reg, 'vip')) === 'done') return { ok: true, next: welcome, outcome: 'paid' };
  const m = await savedChallengeMethod(rt, reg.lead_id);
  if (!m) return { ok: false, fallback: form, outcome: 'no_method' };
  const p = priceOf(rt, 'vip');
  const id = newId('co');
  const ins = await rt.env.DB.prepare(
    `INSERT OR IGNORE INTO challenge_orders (id, reg_id, lead_id, kind, status, amount, currency, provider, method, whop_member_id, whop_payment_method_id, card_brand, card_last4, created_at, updated_at)
     VALUES (?, ?, ?, 'vip', 'pending', ?, ?, 'whop', 'one_click', ?, ?, ?, ?, ?, ?)`,
  ).bind(id, reg.id, reg.lead_id, p.minor, p.currency.toLowerCase(), m.member_id, m.payment_method_id, m.card_brand, m.card_last4, now, now).run();
  if ((ins.meta.changes ?? 0) === 0) return { ok: true, next: welcome, outcome: 'in_flight' };
  const expire = () => rt.env.DB.prepare("UPDATE challenge_orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), id).run();
  let payId: string | null;
  try {
    const pay = await whopApi<Obj>(rt, 'POST', 'payments', {
      account_id: await whopCompanyId(rt),
      variant: { currency: p.currency.toLowerCase(), billing_type: 'one_time', initial_price: p.major, title: titleOf('vip'), description: descriptionOf('vip'), visibility: 'hidden', product: { external_identifier: CHALLENGE_PRODUCT.vip, title: titleOf('vip'), visibility: 'hidden' } },
      member_id: m.member_id,
      payment_method_id: m.payment_method_id,
      off_session: false,
      return_url: `${welcome}?vip=1`,
      metadata: { challenge_order_id: id, reg_id: reg.id, lead_id: reg.lead_id, kind: 'challenge_vip', one_click: '1' },
    }, { version: WHOP_NATIVE_VERSION, idempotencyKey: `challenge_vip_${id}` });
    payId = str(pay.id);
    if (!payId) throw new WhopError(0, 'Whop returned no payment id');
  } catch (e) {
    await expire();
    const { paymentDeclined } = await import('../webinar/ticket-pay');
    const declined = paymentDeclined(e);
    console.error('challenge vip one-click failed', String(e instanceof Error ? e.message : e).slice(0, 300));
    return { ok: false, fallback: `${form}&one_click=${declined ? 'declined' : 'unavailable'}`, outcome: declined ? 'declined' : 'unavailable' };
  }
  await rt.env.DB.prepare('UPDATE challenge_orders SET whop_payment_id = ?, updated_at = ? WHERE id = ?').bind(payId, Date.now(), id).run();
  const { pollStatus } = await import('../webinar/one-click');
  const st = await pollStatus(rt, payId, { sleep: o.sleep, tries: o.tries });
  if (st.status === 'succeeded') {
    await markOrderPaid(rt, (await getOrder(rt, id))!, payId);
    return { ok: true, next: welcome, outcome: 'paid' };
  }
  if (st.status === 'requires_action') {
    const na = obj(st.next_action);
    const url = na.type === 'redirect' ? str(obj(na.data).url) : null;
    return url ? { ok: true, next: url, outcome: 'action' } : { ok: true, next: welcome, outcome: 'pending' };
  }
  if (st.status === 'canceled' || (st.status === 'requires_confirmation' && st.last_payment_error)) {
    await expire();
    return { ok: false, fallback: `${form}&one_click=declined`, outcome: 'declined' };
  }
  return { ok: true, next: welcome, outcome: 'pending' };
}

/** "No thanks": the bump is shown once. */
export async function skipVip(rt: Runtime, reg: Registration) {
  await rt.env.DB.prepare('UPDATE challenge_registrations SET vip_seen_at = COALESCE(vip_seen_at, ?) WHERE id = ?').bind(Date.now(), reg.id).run();
  return welcomeUrl(rt, reg.token);
}

// ───────────── hosted checkout (fallback: no card saved) ─────────────

export async function hostedCheckout(rt: Runtime, reg: Registration, kind: OrderKind, now = Date.now()) {
  if ((await buyGate(rt, reg, kind)) === 'done') return nextStep(rt, (await getRegById(rt, reg.id))!);
  const p = priceOf(rt, kind);
  await rt.env.DB.prepare("UPDATE challenge_orders SET status = 'expired', updated_at = ? WHERE reg_id = ? AND kind = ? AND status = 'pending'").bind(now, reg.id, kind).run();
  const id = newId('co');
  await rt.env.DB.prepare("INSERT INTO challenge_orders (id, reg_id, lead_id, kind, status, amount, currency, provider, method, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, 'whop', 'hosted', ?, ?)")
    .bind(id, reg.id, reg.lead_id, kind, p.minor, p.currency.toLowerCase(), now, now).run();
  try {
    const company = await whopCompanyId(rt);
    const r = await whopApi<{ id?: string; purchase_url?: string }>(rt, 'POST', 'checkout_configurations', {
      plan: { company_id: company, currency: p.currency.toLowerCase(), initial_price: p.major, plan_type: 'one_time', release_method: 'buy_now', visibility: 'hidden', title: titleOf(kind), description: descriptionOf(kind), product: { external_identifier: CHALLENGE_PRODUCT[kind], title: titleOf(kind), visibility: 'hidden' } },
      metadata: { challenge_order_id: id, reg_id: reg.id, lead_id: reg.lead_id, kind: `challenge_${kind}` },
      redirect_url: `${payUrl(rt, reg.token, kind)}${kind === 'vip' ? '&' : '?'}return=1`,
    });
    if (!r.id || !r.purchase_url) throw new WhopError(0, 'Whop returned no checkout link');
    await rt.env.DB.prepare('UPDATE challenge_orders SET checkout_id = ?, updated_at = ? WHERE id = ?').bind(r.id, Date.now(), id).run();
    return r.purchase_url;
  } catch (e) {
    await rt.env.DB.prepare("UPDATE challenge_orders SET status = 'expired', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
    await checkoutFailed(rt, { kind: 'seat', amount: p.minor, currency: p.currency, title: titleOf(kind), error: e, leadId: reg.lead_id }).catch(() => null);
    throw new PayError(CHECKOUT.failed, 503);
  }
}

async function confirmHosted(rt: Runtime, o: Order): Promise<'paid' | 'pending' | 'unknown'> {
  if (!rt.settings.WHOP_API_KEY || !o.checkout_id) return 'unknown';
  try {
    const q = new URLSearchParams({ company_id: await whopCompanyId(rt), first: '10' });
    q.append('checkout_configuration_ids', o.checkout_id);
    const list = await whopApi<{ data?: Obj[] }>(rt, 'GET', `payments?${q}`);
    const pay = (list.data ?? []).find((x) => x.status === 'paid' && (x.checkout_configuration_id === o.checkout_id || obj(x.metadata).challenge_order_id === o.id));
    if (!pay) return 'pending';
    await markOrderPaid(rt, o, str(pay.id), pay);
    return 'paid';
  } catch { return 'unknown'; }
}

// ───────────── webhook ─────────────

/** payment.succeeded carrying our challenge metadata (or our checkout id). */
export async function challengePaymentPaid(rt: Runtime, pay: Obj) {
  const meta = obj(pay.metadata);
  let o = str(meta.challenge_order_id) ? await getOrder(rt, String(meta.challenge_order_id)) : null;
  const chId = str(pay.checkout_configuration_id);
  if (!o && chId) o = await rt.env.DB.prepare('SELECT * FROM challenge_orders WHERE checkout_id = ?').bind(chId).first<Order>();
  if (!o) return { ignored: 'no challenge order' };
  const status = str(pay.status);
  if (status && status !== 'paid' && status !== 'succeeded') return { ignored: `payment ${status}` };
  const r = await markOrderPaid(rt, o, str(pay.id), pay);
  return { paid: o.id, duplicate: r.duplicate };
}

export const isChallengePayment = (pay: Obj) => Boolean(str(obj(pay.metadata).challenge_order_id));

/** A succeeded refund on a challenge payment: a full ticket refund ends the registration; a VIP refund ends VIP. */
export async function challengeRefund(rt: Runtime, rf: Obj) {
  const status = str(rf.status);
  const pay = obj(rf.payment);
  const payId = str(pay.id) ?? str(rf.payment_id);
  const meta = obj(pay.metadata);
  const o = (payId ? await rt.env.DB.prepare('SELECT * FROM challenge_orders WHERE whop_payment_id = ?').bind(payId).first<Order>() : null)
    ?? (str(meta.challenge_order_id) ? await getOrder(rt, String(meta.challenge_order_id)) : null);
  if (!o) return null;
  if (status && status !== 'succeeded') return { ignored: `refund ${status}` };
  const total = whopMoney(pay.refunded_amount);
  const one = whopMoney(rf.amount);
  const refunded = Math.min(o.amount, Math.max(total ? toMinor(total.major, o.currency) : 0, one ? toMinor(one.major, o.currency) : 0, o.refunded_amount));
  const fully = o.amount <= 0 || refunded >= o.amount;
  const now = Date.now();
  await rt.env.DB.prepare(`UPDATE challenge_orders SET refunded_amount = ?, status = ${fully ? "'refunded'" : 'status'}, updated_at = ? WHERE id = ?`).bind(refunded, now, o.id).run();
  if (fully) {
    const reg = await getRegById(rt, o.reg_id);
    if (reg && o.kind === 'ticket') {
      await rt.env.DB.prepare("UPDATE challenge_registrations SET status = 'refunded', refunded_at = ? WHERE id = ?").bind(now, reg.id).run();
      const { stopChallengeMessages } = await import('./emails');
      await stopChallengeMessages(rt, reg.lead_id);
    } else if (reg && o.kind === 'vip') {
      await rt.env.DB.prepare('UPDATE challenge_registrations SET vip = 0 WHERE id = ?').bind(reg.id).run();
    }
  }
  return { refunded: o.id, fully };
}

export { getReg };

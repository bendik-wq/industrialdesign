import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { getLead } from '../funnel/leads';
import { formatCallTime } from '../integrations/email';
import { isMillionPlus } from '../sales/qualify';
import { identityFromLead, track } from '../tracking/track';
import {
  type PassConfig, type PassRow, type PaidEffects, type Perk, PassError, activePass, checkoutForm, formatMoney, fromMinor, markPassPaid, parsePerks, passCapacity,
  passConfig, passCopy, passPaidEffects, stripeApi,
} from './pass';
import { type Registration, type Session, WEBINAR_CYCLE, getSession, phase, replayEndsAt, roomUrl, webinarBase, webinarSettings } from './webinar';

/**
 * The First Deal Sprint, sold Jason Fladlien style inside the masterclass:
 *
 *  - LOCKED from the start of the room ("opens at 38:00"), it UNLOCKS at the pitch minute of the recording
 *    (same position for the live showing and the replay). The unlock time is stored per registration
 *    (offer_unlocked_at), so reloading never resets anything.
 *  - Checkout only works for a registration that reached the pitch (server evidence: the saved position,
 *    or the live clock while they were in the room) and before the OFFER DEADLINE: when that
 *    registration's replay closes. Every deadline and count shown is the one the server enforces.
 *  - Price today = Sprint price minus the lead's paid masterclass tickets (never below zero). The credit
 *    toward the advisory engagement is everything paid for the Sprint, ticket included.
 *  - Optional PAYMENT PLAN (WEBINAR_PASS_PLAN "2x1550"): Stripe Checkout in subscription mode, monthly;
 *    invoice.paid counts the payments and stops the subscription after the last one.
 *  - FAST-ACTION BONUS (WEBINAR_FAST_BONUS): for 24 hours after the offer unlocked for that viewer, or until
 *    the offer deadline if that comes first. Buyers inside it get fast_bonus = 1 on their purchase.
 *  - Closing emails (webinar sequence, re-timed at unlock) for viewers who unlocked it and didn't buy.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
export const FAST_WINDOW_MS = 24 * HOUR;
export const DEFAULT_FAST_BONUS = 'Josh reviews your Deal Plan personally: before your Day 7 session, Josh reads your deal-structure memo and adds his notes';

type RegLike = Registration & { offer_unlocked_at?: number | null };

// ───────────── Settings ─────────────

export interface SprintPlan { count: number; each: number; eachAmount: number; totalAmount: number; label: string; eachLabel: string }

const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
const toMinor = (n: number, cur: string) => (ZERO_DECIMAL.has(cur.toLowerCase()) ? Math.round(n) : Math.round(n * 100));

/** "2x1550" → 2 monthly payments of 1,550. Blank, "off" or anything unreadable = no plan. */
export function sprintPlan(raw: string | null | undefined, currency: string): SprintPlan | null {
  const m = /^\s*(\d{1,2})\s*[x×*]\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*$/i.exec(String(raw ?? ''));
  if (!m) return null;
  const count = Number(m[1]), each = Number(m[2].replace(/,/g, ''));
  if (count < 2 || count > 12 || !(each >= 1)) return null;
  const eachLabel = formatMoney(each, currency);
  return { count, each, eachAmount: toMinor(each, currency), totalAmount: toMinor(each, currency) * count, label: `${count} payments of ${eachLabel}`, eachLabel };
}

/** "Title: detail". Blank = the default; "off" = no fast-action bonus. */
export function fastBonus(raw: string | null | undefined): Perk | null {
  const v = String(raw ?? '').trim();
  if (/^(off|none|no)$/i.test(v)) return null;
  return parsePerks(v || DEFAULT_FAST_BONUS, {})[0] ?? null;
}

export function sprintSettings(rt: Pick<Runtime, 'settings'>) {
  const cfg = passConfig(rt.settings);
  // The payment plan is a Stripe subscription. With Whop taking payments it is hidden: Whop shows its own
  // pay-later options at checkout instead.
  const plan = cfg.provider === 'stripe' ? sprintPlan(rt.settings.WEBINAR_PASS_PLAN, cfg.currency) : null;
  return { cfg, plan, bonus: fastBonus(rt.settings.WEBINAR_FAST_BONUS) };
}

/** "38:00" */
export const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

// ───────────── Copy (every string is checked by auditCopy in the tests) ─────────────

export function sprintCopy(cfg: Pick<PassConfig, 'offerName' | 'priceLabel' | 'guarantee'>, o: { opensAt: string } = { opensAt: '38:00' }) {
  const n = cfg.offerName;
  return {
    lockedEyebrow: 'Opens during the masterclass',
    lockedHeading: `The ${n} opens at ${o.opensAt}`,
    lockedTease: `Seven days with Josh’s team that turn this structure into a written plan for your first deal. Keep watching: it opens at that minute.`,
    unlockedEyebrow: 'Open now',
    heading: `The ${n}`,
    lede: 'Seven days with Josh’s team. You get your acquisition capacity, your buy box, a first shortlist and the deal structure in writing, then a 60-minute Deal Plan session to agree your next 90 days.',
    timeline: 'What you get, day by day',
    button: `Start my ${n}`,
    planButton: 'Pay in',
    bookCall: 'Book a strategy call instead',
    bonusEyebrow: 'Fast-action bonus',
    bonusEnds: 'Yours if you start in the next',
    bonusGone: 'The fast-action bonus window has closed. Everything else in the Sprint stays the same.',
    deadline: `The ${n} is part of this masterclass, so it closes when your replay does`,
    closed: `The ${n} offer from your masterclass has closed. You can still apply for a strategy call.`,
    closedButton: 'Apply for a strategy call',
    notYet: `The ${n} opens at ${o.opensAt} in the masterclass. Watch to that point and it opens here.`,
    backToRoom: 'Back to the masterclass',
    offerPage: `Read everything in the ${n}`,
    guaranteeHeading: 'The Deal Plan guarantee',
    guaranteeNote: 'The guarantee is about the refund. It is not a promise of a deal, a loan or a return.',
    creditNote: `Everything you pay for the ${n}, your masterclass ticket included, comes off the advisory engagement if you continue.`,
    buyinLead: 'You said',
    preview: 'Preview: the buttons don’t take payments here.',
  };
}

/** The offer page's questions, each one objection. */
export function sprintFaq(cfg: Pick<PassConfig, 'offerName' | 'priceLabel'>) {
  const n = cfg.offerName;
  return [
    { q: 'I’m not ready to buy a business yet.', a: `The ${n} is how you get ready. At the end of seven days you know what you can carry, what to buy and how a deal for it is funded. Whether you then make an offer, and when, stays your call.` },
    { q: 'What if I don’t find a target?', a: 'The Sprint gives you a buy box and a first shortlist to work from. It is not a promise that a particular owner will sell. If the shortlist holds nothing you want, the buy box and the outreach script still tell you what to look for and what to say, and the guarantee covers the Sprint itself.' },
    { q: `Is the ${cfg.priceLabel} wasted if I don’t continue?`, a: 'You keep everything: the capacity numbers, the buy box, the shortlist, the memo and the script. If you continue into the advisory engagement, the full fee comes off it. And if the Sprint wasn’t worth far more than you paid, tell us at your Deal Plan session and we refund it.' },
    { q: 'How much time does it take?', a: 'The kickoff call and your numbers on Day 1, short replies to Josh’s team during the week, and the 60-minute Deal Plan session on Day 7. Josh’s team does the research and the writing.' },
    { q: 'My business is under $1M in revenue.', a: `The ${n} is built for owners doing $1M or more a year, because a lender looks for a profitable business behind the buyer. Under that, start with the worksheet and the replay, and come back when your numbers are there.` },
    { q: 'What happens after I pay?', a: 'Your Sprint page opens straight away. You book the kickoff call there, and your deal pack is ready. Josh’s team books your Deal Plan session with you during the week.' },
  ];
}

// ───────────── The window: unlock, deadline, fast-action bonus ─────────────

export const pitchSec = (rt: Pick<Runtime, 'settings'>) => webinarSettings(rt as Runtime).pitchAtMin * 60;

/** The offer deadline: when this registration's replay closes. */
export const offerDeadline = (rt: Runtime, session: Session, reg: Pick<Registration, 'replay_until'>) => replayEndsAt(rt, session, reg.replay_until);

export function sprintWindow(rt: Runtime, session: Session, reg: RegLike, now = Date.now()) {
  const deadline = offerDeadline(rt, session, reg);
  const unlockedAt = reg.offer_unlocked_at ?? null;
  const bonusEndsAt = unlockedAt != null ? Math.min(unlockedAt + FAST_WINDOW_MS, deadline) : null;
  return {
    pitchSec: pitchSec(rt), deadline, unlockedAt, bonusEndsAt,
    unlocked: unlockedAt != null,
    closed: now >= deadline,
    bonusOpen: bonusEndsAt != null && now < bonusEndsAt,
  };
}

/**
 * Server evidence that this registration reached the pitch: the saved position (heartbeats from the
 * live showing or the replay), or, for an external live session, having joined once the clock passed it.
 * A synced showing also counts when they were seen in the room after the pitch minute while it ran.
 */
export function reachedPitch(rt: Runtime, session: Session, reg: Registration, now = Date.now()) {
  const sec = pitchSec(rt);
  if ((reg.max_position ?? 0) >= sec) return true;
  const at = session.starts_at + sec * 1000;
  if (session.mode === 'live') return Boolean(reg.joined_at) && now >= at;
  const end = session.starts_at + webinarSettings(rt).durationMin * MIN;
  return Boolean(reg.joined_at && reg.last_seen_at && reg.last_seen_at >= at && reg.last_seen_at <= end + MIN);
}

/** $1M+ (or not asked): the Sprint is for them. Under $1M get the worksheet path in the room. */
export async function sprintQualified(rt: Runtime, reg: Registration) {
  const row = await rt.env.DB.prepare('SELECT revenue_band FROM webinar_registrations WHERE id = ?').bind(reg.id).first<{ revenue_band: string | null }>().catch(() => null);
  const band = row?.revenue_band ?? (await getLead(rt.env, reg.lead_id))?.revenue_band ?? null;
  return band ? isMillionPlus(band) : true;
}

/** Stores the unlock (first time only), tracks it and times the closing emails from it. */
async function markUnlocked(rt: Runtime, reg: RegLike, session: Session, now: number, how: string) {
  const res = await rt.env.DB.prepare('UPDATE webinar_registrations SET offer_unlocked_at = ? WHERE id = ? AND offer_unlocked_at IS NULL').bind(now, reg.id).run();
  const fresh = (await rt.env.DB.prepare('SELECT * FROM webinar_registrations WHERE id = ?').bind(reg.id).first<RegLike>()) ?? { ...reg, offer_unlocked_at: now };
  if ((res.meta.changes ?? 0) > 0) {
    await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_offer_unlocked', source: 'server', path: '/webinar', props: { session_id: session.id, how, offer: passConfig(rt.settings).offerName } });
    await scheduleClosingEmails(rt, fresh, session).catch((e) => console.error('sprint closing emails', e));
  }
  return fresh;
}

/**
 * The room's call at the pitch minute. Live showing: the server clock must have passed the pitch.
 * Replay: the reported position (the same trust as a heartbeat) must be at or past it.
 */
export async function unlockSprint(rt: Runtime, reg: RegLike, session: Session, body: { pos?: unknown; replay?: unknown }, now = Date.now()) {
  const { cfg } = sprintSettings(rt);
  if (cfg.mode === 'off' || !(await sprintQualified(rt, reg))) return { ok: false as const, reason: 'off' };
  let r = reg;
  if (r.offer_unlocked_at == null) {
    const w = sprintWindow(rt, session, r, now);
    if (w.closed) return { ok: false as const, reason: 'closed', ...sprintState(rt, session, r, now) };
    const p = phase(rt, session, now, r.replay_until);
    const sec = w.pitchSec, dur = webinarSettings(rt).durationMin * 60;
    const claimed = Number(body.pos);
    let ok = reachedPitch(rt, session, r, now);
    if (!ok && body.replay === true && (p === 'replay' || p === 'running') && Number.isFinite(claimed) && claimed >= sec && claimed <= dur) {
      await rt.env.DB.prepare('UPDATE webinar_registrations SET max_position = MAX(max_position, ?) WHERE id = ?').bind(Math.round(claimed), r.id).run();
      ok = true;
    }
    if (!ok && body.replay !== true && p === 'running' && now >= session.starts_at + sec * 1000 - 20_000) ok = true; // 20 s for clock skew
    if (!ok) return { ok: false as const, reason: 'not yet', ...sprintState(rt, session, r, now) };
    r = await markUnlocked(rt, r, session, now, body.replay === true ? 'replay' : 'live');
  }
  return { ok: true as const, ...sprintState(rt, session, r, now) };
}

/** What the browser needs to draw the panel and its countdowns. */
export function sprintState(rt: Runtime, session: Session, reg: RegLike, now = Date.now()) {
  const w = sprintWindow(rt, session, reg, now);
  return { unlocked: w.unlocked, unlockedAt: w.unlockedAt, deadline: w.deadline, bonusEndsAt: w.bonusEndsAt, closed: w.closed, serverNow: now };
}

// ───────────── Price: ticket credit and the plan ─────────────

/** What the lead has paid for masterclass tickets (seat rows still paid, less partial refunds), in minor units. */
export async function ticketCredit(rt: Runtime, leadId: string, currency: string) {
  const row = await rt.env.DB.prepare("SELECT COALESCE(SUM(amount - refunded_amount), 0) AS n FROM webinar_passes WHERE lead_id = ? AND kind = 'seat' AND status = 'paid' AND currency = ?")
    .bind(leadId, currency.toLowerCase()).first<{ n: number }>();
  return Math.max(0, Number(row?.n ?? 0));
}

/** "$3,000 − $100 ticket credit = $2,900 today", and the plan's first payment after the same credit. */
export function sprintPrice(cfg: Pick<PassConfig, 'amount' | 'currency' | 'priceLabel'>, plan: SprintPlan | null, creditMinor: number) {
  const m = (minor: number) => formatMoney(fromMinor(minor, cfg.currency), cfg.currency);
  const credit = Math.max(0, Math.min(creditMinor, cfg.amount));
  const today = Math.max(0, cfg.amount - credit);
  const planCredit = plan ? Math.max(0, Math.min(creditMinor, plan.eachAmount)) : 0;
  const first = plan ? Math.max(0, plan.eachAmount - planCredit) : 0;
  return {
    list: cfg.amount, credit, today,
    todayLabel: m(today),
    creditLabel: credit ? m(credit) : null,
    line: credit ? `${cfg.priceLabel} − ${m(credit)} ticket credit = ${m(today)} today` : `${cfg.priceLabel} today`,
    plan: plan && first > 0 ? {
      count: plan.count, each: plan.eachAmount, first, credit: planCredit, total: plan.totalAmount, label: plan.label,
      line: planCredit ? `Or ${plan.label}, the first one ${m(first)} after your ticket credit` : `Or ${plan.label}, one a month`,
      button: `${plan.count} payments of ${plan.eachLabel}`,
    } : null,
  };
}

// ───────────── Checkout ─────────────

export const offerUrl = (rt: Runtime, token: string) => `${webinarBase(rt)}/offer/${token}`;
/** The short form before checkout (form, then pay, then book): every "Start my Sprint" button goes here. */
export const sprintStartUrl = (rt: Runtime, token: string) => `${webinarBase(rt)}/sprint-start/${token}`;
/** Where Whop sends a buyer after paying: their Sprint page, kickoff booking first. */
export const sprintWelcomeUrl = (rt: Runtime, token: string) => `${webinarBase(rt)}/sprint/${token}?welcome=1`;
/** An unpaid Whop checkout is reused for the same registration this long (Whop links don't expire). */
export const WHOP_SPRINT_LIFE_MS = 2 * HOUR;

/** One payment (Checkout payment mode), net of the ticket credit. Exported for the tests. */
export function sprintCheckoutForm(cfg: PassConfig, o: { passId: string; reg: Pick<Registration, 'id' | 'token' | 'lead_id'>; email: string | null; back: string; expiresAt: number; amount: number; creditLabel: string | null; fastBonus: boolean }) {
  const f = checkoutForm(cfg, { kind: 'offer', passId: o.passId, reg: o.reg, email: o.email, back: o.back, expiresAt: o.expiresAt });
  f['line_items[0][price_data][unit_amount]'] = String(o.amount);
  f['line_items[0][price_data][product_data][description]'] = sprintStripeDescription(cfg, o.creditLabel);
  f['metadata[fast_bonus]'] = o.fastBonus ? '1' : '0';
  return f;
}

function sprintStripeDescription(cfg: PassConfig, creditLabel: string | null) {
  return `${cfg.offerName}: seven days with G&L M&A Advisory.${creditLabel ? ` Your ${creditLabel} masterclass ticket is credited.` : ''} The full fee is credited against the advisory engagement if you continue.`;
}

/**
 * The payment plan: Checkout in subscription mode, a monthly price made inline, and the ticket credit as a
 * one-off coupon on the first invoice. invoice.paid stops it after the last payment (handleInvoicePaid).
 */
export function sprintPlanForm(cfg: PassConfig, plan: SprintPlan, o: { passId: string; reg: Pick<Registration, 'id' | 'token' | 'lead_id'>; email: string | null; back: string; expiresAt: number; coupon: string | null; creditLabel: string | null; fastBonus: boolean }) {
  const sep = o.back.includes('?') ? '&' : '?';
  const f: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': cfg.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(plan.eachAmount),
    'line_items[0][price_data][recurring][interval]': 'month',
    'line_items[0][price_data][recurring][interval_count]': '1',
    'line_items[0][price_data][product_data][name]': `${cfg.offerName} (${plan.label})`,
    'line_items[0][price_data][product_data][description]': `${sprintStripeDescription(cfg, o.creditLabel)} ${plan.count} monthly payments, then it stops.`,
    client_reference_id: o.reg.id,
    'metadata[kind]': 'offer',
    'metadata[pass_id]': o.passId,
    'metadata[reg_id]': o.reg.id,
    'metadata[reg_token]': o.reg.token,
    'metadata[lead_id]': o.reg.lead_id,
    'metadata[installments]': String(plan.count),
    'metadata[fast_bonus]': o.fastBonus ? '1' : '0',
    'subscription_data[metadata][kind]': 'offer',
    'subscription_data[metadata][pass_id]': o.passId,
    'subscription_data[metadata][lead_id]': o.reg.lead_id,
    'subscription_data[metadata][installments]': String(plan.count),
    success_url: `${o.back}${sep}pass=success&cs={CHECKOUT_SESSION_ID}`,
    cancel_url: `${o.back}${sep}pass=cancel`,
    expires_at: String(Math.floor(o.expiresAt / 1000)),
  };
  if (o.coupon) f['discounts[0][coupon]'] = o.coupon;
  if (o.email) f.customer_email = o.email;
  return f;
}

/**
 * One click from the room or the offer page. Refused before the pitch and after the deadline (the
 * server decides, not the page). Reuses an open checkout of the same kind for this registration.
 */
export async function createSprintCheckout(rt: Runtime, reg: RegLike, o: { plan?: boolean; from?: 'room' | 'offer' | 'start' } = {}, now = Date.now()) {
  const { cfg, plan: planCfg, bonus } = sprintSettings(rt);
  const t = sprintCopy(cfg, { opensAt: mmss(pitchSec(rt)) });
  if (cfg.mode === 'off') throw new PassError('This isn’t available right now.', 409);
  const session = await getSession(rt, reg.session_id);
  if (!session) throw new PassError('Link not found', 404);
  if (await activePass(rt, reg.lead_id)) return { paid: true as const };
  if (!(await sprintQualified(rt, reg))) throw new PassError(`The ${cfg.offerName} is for owners doing $1M or more a year. You can still apply for a strategy call.`, 403);
  let r = reg;
  if (r.offer_unlocked_at == null) {
    if (!reachedPitch(rt, session, r, now)) throw new PassError(t.notYet, 403);
    if (sprintWindow(rt, session, r, now).closed) throw new PassError(t.closed, 410);
    r = await markUnlocked(rt, r, session, now, 'checkout');
  }
  const w = sprintWindow(rt, session, r, now);
  if (w.closed) throw new PassError(t.closed, 410);
  const plan = o.plan ? planCfg : null;
  if (o.plan && !plan) throw new PassError('The payment plan isn’t available. You can pay in one payment.', 409);
  const installments = plan ? plan.count : 1;

  const open = await rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE reg_id = ? AND kind = 'offer' AND status = 'pending' AND checkout_url IS NOT NULL AND COALESCE(expires_at, 0) > ? AND installments = ? AND COALESCE(provider, 'stripe') = ? ORDER BY created_at DESC LIMIT 1")
    .bind(r.id, now + 60_000, installments, cfg.provider ?? 'stripe').first<PassRow>();
  if (open?.checkout_url) return { url: open.checkout_url };
  const cap = await passCapacity(rt, cfg, now);
  if (cap.full) throw new PassError(passCopy(cfg).soldOut, 409);

  const credit = await ticketCredit(rt, r.lead_id, cfg.currency);
  const price = sprintPrice(cfg, plan, credit);
  if (plan && !price.plan) throw new PassError('Your ticket credit covers the first payment, so pay in one payment instead.', 409);
  const amount = plan ? price.plan!.first : price.today;
  const creditApplied = plan ? price.plan!.credit : price.credit;
  const fast = bonus && w.bonusOpen ? 1 : 0;
  const id = newId('wp');
  const whop = cfg.provider === 'whop';
  const expiresAt = now + (whop ? WHOP_SPRINT_LIFE_MS : 31 * MIN); // Stripe's minimum is 30 minutes
  await rt.env.DB.prepare(
    `INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, expires_at, list_amount, ticket_credit, installments, fast_bonus, provider, created_at, updated_at)
     VALUES (?, ?, ?, 'offer', ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, r.id, r.lead_id, cfg.offerName, amount, cfg.currency.toLowerCase(), expiresAt, plan ? plan.totalAmount : cfg.amount, creditApplied, installments, fast, cfg.provider ?? 'stripe', now, now).run();
  const who = await identityFromLead(rt.env, r.lead_id);
  const started = () => track(rt, who, { name: 'webinar_checkout_started', source: 'server', props: { pass_id: id, kind: 'offer', from: o.from ?? 'room', plan: Boolean(plan), fast_bonus: Boolean(fast), value: fromMinor(amount, cfg.currency), provider: cfg.provider }, localOnly: true });

  // The ticket credit covers the whole price: nothing to charge, the Sprint starts now.
  if (amount <= 0) {
    const sid = `credit_${id}`;
    await rt.env.DB.prepare('UPDATE webinar_passes SET stripe_session_id = ? WHERE id = ?').bind(sid, id).run();
    await started();
    await markPassPaid(rt, { sessionId: sid, paymentIntent: null, amount: 0, currency: cfg.currency.toLowerCase(), regId: r.id, passId: id, kind: 'offer' });
    return { paid: true as const };
  }

  const creditLabel = creditApplied ? formatMoney(fromMinor(creditApplied, cfg.currency), cfg.currency) : null;
  if (whop) {
    // One payment at the exact price after the ticket credit; Whop returns the buyer to their Sprint page.
    const { startWhopCheckout } = await import('./whop');
    const url = await startWhopCheckout(rt, {
      passId: id, kind: 'offer', reg: r, amount, currency: cfg.currency, title: cfg.offerName, description: sprintStripeDescription(cfg, creditLabel),
      redirectUrl: sprintWelcomeUrl(rt, r.token), metadata: { fast_bonus: fast ? '1' : '0' },
    });
    await started();
    return { url };
  }
  const lead = await getLead(rt.env, r.lead_id);
  const back = o.from === 'offer' || o.from === 'start' ? offerUrl(rt, r.token) : roomUrl(rt, r.token);
  try {
    let form: Record<string, string>;
    if (plan) {
      const coupon = creditApplied
        ? (await stripeApi<{ id: string }>(rt, 'POST', 'coupons', { amount_off: String(creditApplied), currency: cfg.currency.toLowerCase(), duration: 'once', max_redemptions: '1', name: 'Masterclass ticket credit' }, `coupon_${id}`)).id
        : null;
      form = sprintPlanForm(cfg, plan, { passId: id, reg: r, email: lead?.email ?? null, back, expiresAt, coupon, creditLabel, fastBonus: Boolean(fast) });
    } else {
      form = sprintCheckoutForm(cfg, { passId: id, reg: r, email: lead?.email ?? null, back, expiresAt, amount, creditLabel, fastBonus: Boolean(fast) });
    }
    const s = await stripeApi<{ id: string; url?: string | null }>(rt, 'POST', 'checkout/sessions', form, id);
    await rt.env.DB.prepare('UPDATE webinar_passes SET stripe_session_id = ?, checkout_url = ?, updated_at = ? WHERE id = ?').bind(s.id, s.url ?? null, Date.now(), id).run();
    if (!s.url) throw new Error('Stripe returned no checkout link');
    await started();
    return { url: s.url };
  } catch (e) {
    await rt.env.DB.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
    console.error('stripe sprint checkout failed', e);
    throw new PassError('Payment couldn’t be started just now. Please try again in a minute.', 502);
  }
}

// ───────────── Payment plan: Stripe subscription events ─────────────

const str = (v: unknown) => (typeof v === 'string' && v ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null);

export async function attachSubscription(rt: Runtime, passId: string, subId: string) {
  await rt.env.DB.prepare('UPDATE webinar_passes SET stripe_subscription_id = COALESCE(stripe_subscription_id, ?), updated_at = ? WHERE id = ?').bind(subId, Date.now(), passId).run();
}

/** Ends a plan straight away (a refunded Sprint takes no more payments). Throws so the webhook is retried. */
export async function stopPlan(rt: Runtime, subId: string) {
  try {
    await stripeApi(rt, 'DELETE', `subscriptions/${encodeURIComponent(subId)}`);
  } catch (e) {
    if (/Stripe 404/.test(String(e))) return; // already gone
    throw e;
  }
}

/**
 * invoice.paid for a Sprint payment plan. Idempotent per invoice (webinar_pass_payments). The first invoice
 * is the checkout's own payment (marked paid here too, in case this event arrives first); each later one
 * adds to what was paid and to the credit. Once the last payment is in, the subscription is set to end
 * with the current period, so Stripe never charges again. Until Stripe confirms that, every invoice.paid
 * retries it.
 */
export async function handleInvoicePaid(rt: Runtime, inv: Record<string, unknown>, effects: PaidEffects = passPaidEffects) {
  const db = rt.env.DB;
  const parent = (inv.parent ?? {}) as { subscription_details?: { subscription?: unknown; metadata?: Record<string, string> } };
  const subId = str(inv.subscription) ?? str(parent.subscription_details?.subscription);
  const meta = ((inv.subscription_details as { metadata?: Record<string, string> } | undefined)?.metadata ?? parent.subscription_details?.metadata ?? {}) as Record<string, string>;
  if (!subId && !meta.pass_id) return { ignored: 'not a payment plan invoice' };
  let pass = subId ? await db.prepare('SELECT * FROM webinar_passes WHERE stripe_subscription_id = ?').bind(subId).first<PassRow>() : null;
  if (!pass && meta.pass_id) {
    pass = await db.prepare("SELECT * FROM webinar_passes WHERE id = ? AND kind = 'offer'").bind(meta.pass_id).first<PassRow>();
    if (pass && subId) await attachSubscription(rt, pass.id, subId);
  }
  if (!pass) return { ignored: 'unknown subscription' };
  if ((pass.installments ?? 1) < 2) return { ignored: 'not a payment plan' };
  const invId = str(inv.id);
  if (!invId) return { ignored: 'no invoice id' };
  const amount = Math.max(0, Number(inv.amount_paid ?? 0));
  const currency = String(inv.currency ?? pass.currency).toLowerCase();
  const payments = (inv.payments as { data?: { payment?: { payment_intent?: unknown } }[] } | undefined)?.data ?? [];
  const pi = str(inv.payment_intent) ?? str(payments[0]?.payment?.payment_intent);
  const first = inv.billing_reason === 'subscription_create';
  const now = Date.now();

  if (first && (pass.status === 'pending' || pass.status === 'expired') && pass.stripe_session_id) {
    await markPassPaid(rt, { sessionId: pass.stripe_session_id, paymentIntent: pi, amount, currency, regId: pass.reg_id, passId: pass.id, kind: 'offer' }, effects);
  }
  if (first && pi) await db.prepare('UPDATE webinar_passes SET stripe_payment_intent = COALESCE(stripe_payment_intent, ?) WHERE id = ?').bind(pi, pass.id).run();
  pass = (await db.prepare('SELECT * FROM webinar_passes WHERE id = ?').bind(pass.id).first<PassRow>())!;
  const installment = first ? 1 : (pass.installments_paid ?? 0) + 1;
  const ins = await db.prepare('INSERT OR IGNORE INTO webinar_pass_payments (id, pass_id, stripe_invoice_id, payment_intent, amount, currency, installment, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId('wpp'), pass.id, invId, pi, amount, currency, installment, now).run();
  const fresh = (ins.meta.changes ?? 0) > 0;
  if (fresh && !first && pass.status === 'paid') {
    await db.prepare('UPDATE webinar_passes SET installments_paid = installments_paid + 1, amount = amount + ?, credit_amount = credit_amount + ?, updated_at = ? WHERE id = ?').bind(amount, amount, now, pass.id).run();
    await track(rt, await identityFromLead(rt.env, pass.lead_id), { name: 'webinar_offer_installment_paid', source: 'webhook', props: { pass_id: pass.id, installment, value: fromMinor(amount, currency), currency: currency.toUpperCase() }, localOnly: true });
  } else if (fresh && first) {
    await db.prepare('UPDATE webinar_passes SET installments_paid = MAX(installments_paid, 1), updated_at = ? WHERE id = ?').bind(now, pass.id).run();
  }
  const after = (await db.prepare('SELECT * FROM webinar_passes WHERE id = ?').bind(pass.id).first<PassRow>())!;
  const done = (after.installments_paid ?? 0) >= (after.installments ?? 1);
  const sub = after.stripe_subscription_id ?? subId;
  if (done && sub && !after.plan_cancel_at && after.status === 'paid') {
    await stripeApi(rt, 'POST', `subscriptions/${encodeURIComponent(sub)}`, { cancel_at_period_end: 'true' }, `plan_end_${sub}`);
    await db.prepare('UPDATE webinar_passes SET plan_cancel_at = ?, updated_at = ? WHERE id = ?').bind(now, now, pass.id).run();
  }
  return { plan: pass.id, installment, duplicate: !fresh, planComplete: done };
}

// ───────────── The room ─────────────

/** The Sprint panel's config for the room (null when it isn't offered to this viewer). */
export async function sprintRoomConfig(rt: Runtime, reg: RegLike, session: Session, qualified: boolean, o: { preview?: boolean; applyUrl: string } = { applyUrl: '' }) {
  const { cfg, plan, bonus } = sprintSettings(rt);
  if ((cfg.mode === 'off' && !o.preview) || !qualified) return null;
  if (!o.preview && (await activePass(rt, reg.lead_id))) return null;
  const now = Date.now();
  const opensAt = mmss(pitchSec(rt));
  const t = sprintCopy(cfg, { opensAt });
  const credit = o.preview ? 0 : await ticketCredit(rt, reg.lead_id, cfg.currency);
  const price = sprintPrice(cfg, plan, credit);
  const cap = o.preview ? { full: false, label: null } : await passCapacity(rt, cfg, now);
  const pc = passCopy(cfg);
  return {
    preview: Boolean(o.preview),
    name: cfg.offerName,
    copy: t,
    opensAtSec: pitchSec(rt),
    price: price.todayLabel, listPrice: cfg.priceLabel, priceLine: price.line, credit: price.creditLabel,
    plan: price.plan ? { line: price.plan.line, button: price.plan.button } : null,
    perks: cfg.perks,
    guarantee: cfg.guarantee,
    bonus,
    full: cap.full, soldOut: cap.full ? pc.soldOut : null, capLabel: cap.label,
    fine: `${pc.secure} ${pc.noResults}`,
    offerUrl: offerUrl(rt, reg.token),
    startUrl: sprintStartUrl(rt, reg.token),
    applyUrl: o.applyUrl,
    tz: cfg.tz,
    ...sprintState(rt, session, reg, now),
  };
}

// ───────────── Closing emails (webinar sequence steps, re-timed at unlock) ─────────────

export const SPRINT_EMAILS = ['w_sprint_open', 'w_sprint_bonus', 'w_sprint_closing', 'w_sprint_closed'] as const;
export type SprintEmail = (typeof SPRINT_EMAILS)[number];

/** When each closing email goes, from this viewer's unlock and deadline. */
export function closingTimes(w: { unlockedAt: number; deadline: number; bonusEndsAt: number }) {
  return {
    w_sprint_open: w.unlockedAt + HOUR,
    w_sprint_bonus: w.bonusEndsAt - 3 * HOUR,
    w_sprint_closing: w.deadline - 4 * HOUR,
    w_sprint_closed: w.deadline + 30 * MIN,
  } satisfies Record<SprintEmail, number>;
}

/** Moves this registration's closing emails to the real times (or adds them for an older sign-up). */
export async function scheduleClosingEmails(rt: Runtime, reg: RegLike, session: Session) {
  const w = sprintWindow(rt, session, reg);
  if (w.unlockedAt == null || w.bonusEndsAt == null) return 0;
  const lead = await getLead(rt.env, reg.lead_id);
  if (!lead?.email || lead.unsubscribed_at) return 0;
  const { SEQUENCES } = await import('../integrations/sequences');
  const steps = SEQUENCES.webinar.steps;
  const times = closingTimes({ unlockedAt: w.unlockedAt, deadline: w.deadline, bonusEndsAt: w.bonusEndsAt });
  const now = Date.now();
  const stmts = SPRINT_EMAILS.flatMap((tpl) => {
    const j = steps.findIndex((s) => s.template === tpl);
    if (j < 0) return [];
    const at = Math.max(now + MIN, times[tpl]);
    return [rt.env.DB.prepare(
      `INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at)
       VALUES (?, ?, 'webinar', ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(lead_id, sequence, step) DO UPDATE SET send_at = excluded.send_at, status = 'pending', attempts = 0
         WHERE emails.status IN ('pending', 'skipped') AND emails.template = excluded.template`,
    ).bind(newId('m'), lead.id, reg.seq * WEBINAR_CYCLE + j, tpl, lead.email, at, now)];
  });
  if (stmts.length) await rt.env.DB.batch(stmts);
  return stmts.length;
}

/** Right before a closing email goes: only to someone who unlocked it, hasn't bought, and only at its moment. */
export async function skipClosingEmail(rt: Runtime, lead: { id: string; webinar_token?: string | null }, tpl: SprintEmail, now = Date.now()) {
  if (passConfig(rt.settings).mode === 'off' || !lead.webinar_token) return true;
  const reg = await rt.env.DB.prepare('SELECT * FROM webinar_registrations WHERE token = ?').bind(lead.webinar_token).first<RegLike>();
  const session = reg ? await getSession(rt, reg.session_id) : null;
  if (!reg || !session || reg.offer_unlocked_at == null) return true;
  if (await activePass(rt, lead.id)) return true;
  const w = sprintWindow(rt, session, reg, now);
  const unlocked = w.unlockedAt!, bonusEnds = w.bonusEndsAt!;
  switch (tpl) {
    case 'w_sprint_open': return now >= w.deadline - 30 * MIN;
    // Only when the bonus ends well before the offer does (otherwise "closes soon" says it).
    case 'w_sprint_bonus': return !fastBonus(rt.settings.WEBINAR_FAST_BONUS) || now >= bonusEnds || bonusEnds > w.deadline - 6 * HOUR || now < unlocked + 2 * HOUR;
    case 'w_sprint_closing': return now >= w.deadline || now < unlocked + 3 * HOUR;
    case 'w_sprint_closed': return now < w.deadline || now > w.deadline + 3 * 24 * HOUR;
  }
}

/** What the closing emails show (the person's own links, times in their time zone). */
export async function sprintEmailContext(rt: Runtime, reg: RegLike, session: Session, tz: string | null, link: (p: string) => string) {
  const { cfg, plan, bonus } = sprintSettings(rt);
  if (cfg.mode === 'off') return null;
  const w = sprintWindow(rt, session, reg);
  const credit = await ticketCredit(rt, reg.lead_id, cfg.currency).catch(() => 0);
  const price = sprintPrice(cfg, plan, credit);
  return {
    name: cfg.offerName,
    offer: link(offerUrl(rt, reg.token)),
    closes: formatCallTime(w.deadline, tz),
    bonusEnds: w.bonusEndsAt ? formatCallTime(w.bonusEndsAt, tz) : null,
    bonusTitle: bonus?.title ?? null,
    bonusBody: bonus?.body ?? null,
    price: cfg.priceLabel,
    priceLine: price.line,
    plan: price.plan?.label ?? null,
    guarantee: cfg.guarantee,
    apply: link(`/w/${reg.token}`),
  };
}

export type SprintRoom = NonNullable<Awaited<ReturnType<typeof sprintRoomConfig>>>;

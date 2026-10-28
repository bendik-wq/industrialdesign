import type { Runtime } from '../app';
import type { Settings } from '../settings';
import { newId } from '../lib/ids';
import { hmacHex, safeEqual } from '../lib/crypto';
import { zonedTime } from '../integrations/email';
import { getLead } from '../funnel/leads';
import { REVENUE_LABEL } from '../sales/qualify';
import { identityFromLead, track } from '../tracking/track';
import { type Registration, getRegistration, roomUrl, startTicketedMessages, stopTicketedMessages, webinarBase, webinarSettings } from './webinar';

/**
 * Paid products in the masterclass, sold through Stripe Checkout:
 *
 *  - the OFFER: a configurable front-end product (default "Acquisition Assessment", $3,000) that leads
 *    into the advisory engagement. Offered on the thank-you page and, one click, at the pitch in the room.
 *  - the SEAT: in WEBINAR_PASS=required mode only, an optional small seat price (WEBINAR_SEAT_PRICE).
 *    Blank = seats stay free. A paid seat (or the offer) opens the room.
 *
 * Automatic for offer buyers: the deal pack (their own numbers worked through), the longer replay, the fee
 * credited against the engagement, fuller AI answers in the room. Nothing is ever shown as sold out unless
 * WEBINAR_PASS_WEEKLY_CAP is set and genuinely reached; the count shown is the real one.
 */

export type PassMode = 'off' | 'upsell' | 'required';
export type PassKind = 'offer' | 'seat';

const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

export interface Perk { title: string; body: string }

export interface PassConfig {
  /** What the owner asked for in settings. */
  requested: PassMode;
  /** What actually runs (off when Stripe isn't connected). */
  mode: PassMode;
  /** Why the requested mode isn't running, for Funnel HQ. */
  reason: string | null;
  offerName: string;
  /** "assessment" for "Acquisition Assessment": used in "Start my assessment". */
  offerNoun: string;
  price: number;
  currency: string; // upper-case ISO
  amount: number; // smallest unit, as Stripe wants it
  priceLabel: string;
  /** Paid seat (required mode only); null = seats are free. */
  seat: { price: number; amount: number; label: string } | null;
  replayDays: number;
  sessionUrl: string | null;
  guarantee: string;
  weeklyCap: number | null;
  perks: Perk[];
  customPerks: boolean;
  priorityAnswers: boolean;
  webhookReady: boolean;
  tz: string;
}

const toMinor = (n: number, cur: string) => (ZERO_DECIMAL.has(cur.toLowerCase()) ? Math.round(n) : Math.round(n * 100));
/** Stripe's smallest unit back to a display amount. */
export const fromMinor = (amount: number, currency: string) => (ZERO_DECIMAL.has(currency.toLowerCase()) ? amount : amount / 100);

export function formatMoney(amount: number, currency: string) {
  const whole = Math.round(amount) === amount;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return String(v ?? '').trim() && Number.isFinite(n) && n >= 1 ? n : null; };

/** The built-in list. Only things that are delivered; no promised outcomes. */
export function defaultPerks(o: { priceLabel: string; replayDays: number; replayHours: number; guarantee: string; sessionUrl: string | null }): Perk[] {
  return [
    { title: 'A review of your business and acquisition capacity', body: 'How much debt your profit can carry at 1.5x coverage, and the size of target that supports.' },
    { title: 'A target profile', body: 'The kind of business to buy first: its size, how it fits what you already run, and what its owner needs to hear from you.' },
    { title: 'A deal-structure memo', body: 'In writing, how a deal for that target splits across commercial debt, seller finance and seller rollover.' },
    { title: 'A 60-minute assessment session with Josh’s team', body: o.sessionUrl ? 'We go through the review, the profile and the memo with you. Book it straight after paying.' : 'We go through the review, the profile and the memo with you. Josh’s team emails you to book it.' },
    { title: 'Your deal pack, ready straight away', body: 'Your own numbers worked through the 1.5x test, with the highest price that clears it and the levers that change it.' },
    { title: `The masterclass replay for ${o.replayDays} days`, body: `Everyone else has ${o.replayHours} hours.` },
    { title: `The full ${o.priceLabel} credited if you continue`, body: 'The whole fee comes off the advisory engagement if you go ahead with it.' },
    { title: o.guarantee.replace(/\.$/, ''), body: 'Ask within 7 days if it wasn’t worth it and the full fee comes back.' },
  ];
}

/** "Title: detail" per line. */
export function parsePerks(raw: string, vars: Record<string, string>): Perk[] {
  return raw.split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 12).map((l) => {
    const filled = l.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
    const i = filled.search(/:\s|\s[—–-]\s/);
    return i > 0 ? { title: filled.slice(0, i).trim(), body: filled.slice(i).replace(/^[:—–-]?\s*[—–-]?\s*/, '').trim() } : { title: filled, body: '' };
  });
}

export function passConfig(s: Partial<Settings>, replayHours = Number(s.WEBINAR_REPLAY_HOURS) > 0 ? Number(s.WEBINAR_REPLAY_HOURS) : 48): PassConfig {
  const raw = String(s.WEBINAR_PASS ?? '').trim().toLowerCase();
  const requested: PassMode = raw === 'upsell' || raw === 'required' ? raw : 'off';
  const currency = /^[a-z]{3}$/i.test(String(s.WEBINAR_PASS_CURRENCY ?? '').trim()) ? String(s.WEBINAR_PASS_CURRENCY).trim().toUpperCase() : 'USD';
  const price = num(s.WEBINAR_PASS_PRICE) ?? 3000;
  const seatPrice = num(s.WEBINAR_SEAT_PRICE);
  const daysN = Number(s.WEBINAR_PASS_REPLAY_DAYS);
  const replayDays = Number.isFinite(daysN) && daysN >= 1 && daysN <= 365 ? Math.round(daysN) : 30;
  const capRaw = String(s.WEBINAR_PASS_WEEKLY_CAP ?? '').trim();
  const capN = Number(capRaw);
  const sessionUrl = /^https:\/\/\S+$/i.test(String(s.WEBINAR_OFFER_SESSION_URL ?? '').trim()) ? String(s.WEBINAR_OFFER_SESSION_URL).trim() : null;
  const hasKey = Boolean(String(s.STRIPE_SECRET_KEY ?? '').trim());
  const mode: PassMode = requested !== 'off' && hasKey ? requested : 'off';
  const offerName = String(s.WEBINAR_OFFER_NAME ?? '').trim().slice(0, 60) || 'Acquisition Assessment';
  const priceLabel = formatMoney(price, currency);
  const guarantee = String(s.WEBINAR_PASS_REFUND ?? '').trim() || '7-day money-back guarantee';
  const custom = String(s.WEBINAR_OFFER_PERKS ?? '').trim();
  const perks = custom ? parsePerks(custom, { price: priceLabel, replay_days: String(replayDays) }) : defaultPerks({ priceLabel, replayDays, replayHours, guarantee, sessionUrl });
  return {
    requested, mode,
    reason: requested !== 'off' && !hasKey
      ? `Set to ${requested}, but the Stripe secret key is missing, so nothing is on sale${requested === 'required' ? ' and seats stay free' : ''} until it is added.`
      : null,
    offerName,
    offerNoun: (offerName.split(/\s+/).pop() || 'assessment').toLowerCase(),
    price, currency, amount: toMinor(price, currency), priceLabel,
    seat: requested === 'required' && seatPrice ? { price: seatPrice, amount: toMinor(seatPrice, currency), label: formatMoney(seatPrice, currency) } : null,
    replayDays, sessionUrl, guarantee,
    weeklyCap: capRaw && Number.isInteger(capN) && capN >= 1 ? capN : null,
    perks, customPerks: Boolean(custom),
    priorityAnswers: Boolean(String(s.ANTHROPIC_API_KEY ?? '').trim()),
    webhookReady: Boolean(String(s.STRIPE_WEBHOOK_SECRET ?? '').trim()),
    tz: String(s.SALES_TIMEZONE ?? '').trim() || 'Australia/Sydney',
  };
}

// ───────────── Copy (every string is checked by auditCopy in the tests) ─────────────

export function passCopy(cfg: Pick<PassConfig, 'offerName' | 'offerNoun' | 'priceLabel' | 'guarantee'>) {
  return {
    upsellEyebrow: 'For owners ready to look at a real deal',
    upsellHeading: `The ${cfg.offerName}`,
    upsellBody: 'The masterclass shows how the structure works. The assessment applies it to your business: what you can carry, what to buy, and how to fund it.',
    roomHeading: 'Two ways to take the next step',
    roomBody: `Start the ${cfg.offerName} now with one click, or book a strategy call with Josh’s team first. The calendar opens right here, so the masterclass keeps playing.`,
    button: `Start my ${cfg.offerNoun}`,
    bookCall: 'Book a strategy call instead',
    includes: `What the ${cfg.offerName} includes`,
    secure: 'Secure payment by Stripe. Your email is filled in for you.',
    noResults: 'It is an assessment and a plan, not a promise of a deal, a loan or a return.',
    activeEyebrow: 'Paid',
    activeHeading: `Your ${cfg.offerName} is under way`,
    activeBody: 'Your deal pack is ready now. Here is what happens next.',
    confirming: 'Stripe is still confirming your payment. This page refreshes by itself in a few seconds.',
    cancelled: 'No payment was taken. You can start it below whenever you are ready.',
    soldOut: `This week’s ${cfg.offerName} places have all been taken. New ones open on Monday.`,
    packLink: 'Open my deal pack',
    sessionLink: 'Book my assessment session',
    sessionEmail: 'Josh’s team emails you to book your 60-minute session.',
    roomBadge: cfg.offerName,
    holderNote: 'Questions you type here get a fuller answer and are flagged to Josh’s team.',
    // The paid ticket (required mode with a seat price). User-facing it is a "ticket"; in code and data it stays kind 'seat'.
    seatEyebrow: 'One step left',
    seatHeading: 'Get your Masterclass ticket',
    seatBody: 'The room is kept for owners who are serious about buying a business, so entry is a paid ticket. Pay once and your ticket is confirmed straight away. The room opens at your start time.',
    seatButton: 'Get my ticket',
    seatActive: 'Your Masterclass ticket is confirmed.',
  };
}

/**
 * Copy for the paid ticket, wherever it is sold: the landing page, the payment step, the "finish your ticket"
 * emails. Only real things are listed: the room, the replay window, the room's deal calculator, the attendee
 * worksheet and the Acquisition Blueprint (built at the pitch). The credit is applied by the First Deal Sprint
 * checkout from the lead's paid seat rows.
 */
export function ticketCopy(o: { label: string; replayHours: number; durationMin?: number }) {
  return {
    eyebrow: 'Masterclass ticket',
    priceLine: `${o.label} ticket. Credited in full if you start the First Deal Sprint.`,
    whyHeading: `Why the masterclass costs ${o.label}`,
    why: [
      'This hour is about buying a business with the bank’s money and the seller’s money, and keeping your own cash working in the business you already run.',
      `The room is kept for owners who will act on it. A ${o.label} ticket filters out the curious, so the questions in the room come from owners with a real business and a real target.`,
    ],
    includesHeading: 'Your ticket includes',
    includes: [
      { title: `The masterclass with Josh Li${o.durationMin ? `, about ${o.durationMin} minutes` : ''}`, body: 'Where the off-market deals are, how commercial debt, seller finance and seller rollover fund the price, and the 90-day path to a signed LOI.' },
      { title: `The replay for ${o.replayHours} hours`, body: 'Rewatch the part on structure with your own numbers in front of you.' },
      { title: 'The deal calculator', body: 'Put in a target’s profit and price and see whether the funding stack clears the 1.5x coverage test lenders use.' },
      { title: 'The Deal Structure Worksheet', body: 'A printable worksheet for structuring your first deal, unlocked in the room.' },
      { title: 'Your Acquisition Blueprint', body: 'A one-page plan built from your answers in the room: your target, your stack and your next 90 days.' },
    ],
    credit: `Your ${o.label} comes off the First Deal Sprint if you start it after the masterclass.`,
    guaranteeHeading: 'The ticket guarantee',
    guarantee: `Watch it. If you don’t think it was worth far more than ${o.label}, reply within 7 days for a full refund.`,
    formHeading: 'Get your ticket',
    button: `Get my ${o.label} ticket`,
    privacy: `Next is secure checkout by Stripe for the ${o.label} ticket. We’ll email you your link, reminders before the session and the replay, plus a few follow-up emails about acquisitions. Unsubscribe any time.`,
    confirmedEyebrow: 'Ticket confirmed',
    confirmedHeading: 'Your Masterclass ticket is confirmed',
    confirmedBody: 'Your personal link is on its way to your inbox. The room opens at the time above.',
  };
}

const ticketHours = (s: Partial<Settings>) => (Number(s.WEBINAR_REPLAY_HOURS) > 0 ? Number(s.WEBINAR_REPLAY_HOURS) : 48);
/** The ticket copy for the current settings, or null when there is no paid ticket (free mode). */
export function ticketFor(s: Partial<Settings>) {
  const cfg = passConfig(s);
  if (cfg.mode !== 'required' || !cfg.seat) return null;
  const dur = Number(s.WEBINAR_DURATION_MIN) > 0 ? Number(s.WEBINAR_DURATION_MIN) : 60;
  return { cfg, label: cfg.seat.label, copy: ticketCopy({ label: cfg.seat.label, replayHours: ticketHours(s), durationMin: dur }) };
}

// ───────────── Stripe signature ─────────────

/**
 * Stripe-Signature: `t=<unix>,v1=<hex hmac>[,v1=…][,v0=…]`. HMAC-SHA256 of `${t}.${payload}` with the
 * endpoint secret; any v1 may match (a rolled secret sends two); the timestamp must be within the tolerance.
 */
export async function verifyStripeSignature(secret: string, payload: string, header: string | null | undefined, now = Date.now(), toleranceSec = 300) {
  if (!secret || !header) return false;
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1' && v) v1.push(v);
  }
  if (!t || !/^\d{1,12}$/.test(t) || !v1.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  let ok = false;
  for (const s of v1) if (safeEqual(s.toLowerCase(), expected)) ok = true; // compare them all, no early exit
  return ok;
}

// ───────────── Weekly capacity (real, enforced) ─────────────

/** Monday 00:00 of the current week in a time zone. */
export function weekStart(now: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(now);
  const g = (k: string) => parts.find((p) => p.type === k)!.value;
  const back = (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')) + 6) % 7;
  return zonedTime(Number(g('year')), Number(g('month')), Number(g('day')) - back, 0, tz);
}

/** Cap maths. No cap → never full and no count shown. */
export function capacity(cap: number | null, used: number, offerName = 'Acquisition Assessment') {
  if (cap == null) return { capped: false as const, cap: null, used, left: null, full: false, label: null };
  const left = Math.max(0, cap - used);
  return { capped: true as const, cap, used, left, full: left === 0, label: left === 0 ? null : `${left} of ${cap} ${offerName} places left this week` };
}

/** Offers that count against this week: paid this week (refunds free the place), plus unpaid checkouts still open. */
export async function weekUsage(rt: Runtime, cfg: PassConfig, now = Date.now()) {
  const from = weekStart(now, cfg.tz);
  const row = await rt.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM webinar_passes
      WHERE kind = 'offer' AND ((status = 'paid' AND paid_at >= ?) OR (status = 'pending' AND created_at >= ? AND COALESCE(expires_at, 0) > ?))`,
  ).bind(from, from, now).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function passCapacity(rt: Runtime, cfg = passConfig(rt.settings), now = Date.now()) {
  return capacity(cfg.weeklyCap, cfg.weeklyCap == null ? 0 : await weekUsage(rt, cfg, now), cfg.offerName);
}

// ───────────── Rows ─────────────

export interface PassRow {
  id: string; reg_id: string; lead_id: string; kind: PassKind; product: string | null; status: 'pending' | 'paid' | 'refunded' | 'expired';
  amount: number; currency: string; stripe_session_id: string | null; stripe_payment_intent: string | null; checkout_url: string | null;
  expires_at: number | null; paid_at: number | null; refunded_at: number | null; refunded_amount: number; credit_amount: number;
  credit_used_contract: string | null; review_clicked_at: number | null; review_booked_at: number | null; pack_viewed_at: number | null;
  created_at: number; updated_at: number;
}

/** The lead's paid front-end offer, if any. */
export const activePass = (rt: Runtime, leadId: string) =>
  rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE lead_id = ? AND kind = 'offer' AND status = 'paid' ORDER BY paid_at DESC LIMIT 1").bind(leadId).first<PassRow>();
const anyPaid = (rt: Runtime, leadId: string) =>
  rt.env.DB.prepare("SELECT kind FROM webinar_passes WHERE lead_id = ? AND status = 'paid' LIMIT 1").bind(leadId).first<{ kind: PassKind }>();

/** The credit to show on an agreement (smallest currency unit), or null. */
export async function passCreditFor(rt: Runtime, leadId: string) {
  const p = await activePass(rt, leadId);
  return p && p.credit_amount > 0 ? { passId: p.id, product: p.product, amount: p.credit_amount, currency: p.currency, display: formatMoney(fromMinor(p.credit_amount, p.currency), p.currency.toUpperCase()) } : null;
}

/** Room gate: a paid seat is required (required mode + seat price), they registered under it, and nothing is paid. */
export async function passGate(rt: Runtime, reg: Pick<Registration, 'lead_id'> & { pass_required?: number | null }) {
  if (!reg.pass_required) return false;
  const cfg = passConfig(rt.settings);
  if (cfg.mode !== 'required' || !cfg.seat) return false;
  return !(await anyPaid(rt, reg.lead_id));
}

/**
 * The lead's current registration (lead.webinar_token) still waits for its paid ticket. The pre-webinar emails,
 * the webinar reminders and the reminder texts hold while this is true (also after a full refund).
 */
export async function ticketUnpaid(rt: Runtime, lead: { webinar_token?: string | null }) {
  if (!lead.webinar_token) return false;
  const reg = await getRegistration(rt, lead.webinar_token);
  return reg ? passGate(rt, reg) : false;
}

/** The lead's paid ticket (seat), if any. */
export const paidTicket = (rt: Runtime, leadId: string) =>
  rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE lead_id = ? AND kind = 'seat' AND status = 'paid' ORDER BY paid_at DESC LIMIT 1").bind(leadId).first<PassRow>();

/** Should a new registration be marked as needing a paid seat? */
export const seatRequired = (rt: Runtime) => { const cfg = passConfig(rt.settings); return cfg.mode === 'required' && Boolean(cfg.seat); };

/** Longer replay for offer buyers: each of their registrations keeps the replay N days after it ends. */
export async function applyPassReplay(rt: Runtime, leadId: string, on = true) {
  const w = webinarSettings(rt);
  const cfg = passConfig(rt.settings);
  if (!on) return rt.env.DB.prepare('UPDATE webinar_registrations SET replay_until = NULL WHERE lead_id = ?').bind(leadId).run();
  return rt.env.DB.prepare(
    'UPDATE webinar_registrations SET replay_until = (SELECT starts_at FROM webinar_sessions s WHERE s.id = webinar_registrations.session_id) + ? WHERE lead_id = ?',
  ).bind(w.durationMin * 60_000 + cfg.replayDays * 86_400_000, leadId).run();
}

/** After a new or moved registration: a lead who already bought keeps the long replay. */
export async function syncPassReplay(rt: Runtime, leadId: string) {
  if (await activePass(rt, leadId)) await applyPassReplay(rt, leadId, true);
}

// ───────────── Stripe API ─────────────

async function stripeApi<T>(rt: Runtime, method: 'GET' | 'POST', path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<T> {
  const key = rt.settings.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Stripe is not connected');
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${body.error?.message ?? 'request failed'}`);
  return body;
}

interface StripeCheckoutSession {
  id: string; url?: string | null; payment_status?: string; status?: string; payment_intent?: string | { id: string } | null;
  amount_total?: number | null; currency?: string | null; client_reference_id?: string | null; metadata?: Record<string, string> | null;
}

/** The form body for a Checkout Session (exported for the tests). */
export function checkoutForm(cfg: PassConfig, o: { kind: PassKind; passId: string; reg: Pick<Registration, 'id' | 'token' | 'lead_id'>; email: string | null; back: string; expiresAt: number; title?: string }) {
  const seat = o.kind === 'seat';
  const sep = o.back.includes('?') ? '&' : '?';
  const f: Record<string, string> = {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': cfg.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(seat ? cfg.seat?.amount ?? 0 : cfg.amount),
    'line_items[0][price_data][product_data][name]': seat ? `Masterclass ticket: ${o.title || 'The Acquisition Masterclass'}` : cfg.offerName,
    'line_items[0][price_data][product_data][description]': seat
      ? `Your ticket to the masterclass with Josh Li. Credited in full if you start the First Deal Sprint. Ticket guarantee: if you don’t think it was worth far more than ${cfg.seat?.label ?? 'the ticket'}, reply within 7 days for a full refund.`
      : `${cfg.offerName} with G&L M&A Advisory. The full fee is credited against the advisory engagement if you continue. ${cfg.guarantee}.`,
    client_reference_id: o.reg.id,
    'metadata[kind]': o.kind,
    'metadata[pass_id]': o.passId,
    'metadata[reg_id]': o.reg.id,
    'metadata[reg_token]': o.reg.token,
    'metadata[lead_id]': o.reg.lead_id,
    'payment_intent_data[metadata][pass_id]': o.passId,
    'payment_intent_data[metadata][lead_id]': o.reg.lead_id,
    'payment_intent_data[metadata][kind]': o.kind,
    success_url: `${o.back}${sep}pass=success&cs={CHECKOUT_SESSION_ID}`,
    cancel_url: `${o.back}${sep}pass=cancel`,
    expires_at: String(Math.floor(o.expiresAt / 1000)),
  };
  if (o.email) f.customer_email = o.email;
  return f;
}

export class PassError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** One click: starts (or reuses) a Stripe Checkout for this registration, email prefilled. */
export async function createCheckout(rt: Runtime, reg: Registration, o: { kind?: PassKind; from?: 'room' | 'ty' } = {}) {
  const kind: PassKind = o.kind === 'seat' ? 'seat' : 'offer';
  const cfg = passConfig(rt.settings);
  if (cfg.mode === 'off' || (kind === 'seat' && !cfg.seat)) throw new PassError('This isn’t available right now.', 409);
  if (kind === 'offer' ? await activePass(rt, reg.lead_id) : await anyPaid(rt, reg.lead_id)) return { paid: true as const };
  const now = Date.now();
  const open = await rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE reg_id = ? AND kind = ? AND status = 'pending' AND checkout_url IS NOT NULL AND COALESCE(expires_at, 0) > ? ORDER BY created_at DESC LIMIT 1")
    .bind(reg.id, kind, now + 60_000).first<PassRow>();
  if (open?.checkout_url) return { url: open.checkout_url };
  if (kind === 'offer') {
    const cap = await passCapacity(rt, cfg, now);
    if (cap.full) throw new PassError(passCopy(cfg).soldOut, 409);
  }
  const lead = await getLead(rt.env, reg.lead_id);
  const session = await rt.env.DB.prepare('SELECT title FROM webinar_sessions WHERE id = ?').bind(reg.session_id).first<{ title: string | null }>();
  const id = newId('wp');
  const expiresAt = now + 31 * 60_000; // Stripe's minimum is 30 minutes
  const amount = kind === 'seat' ? cfg.seat!.amount : cfg.amount;
  await rt.env.DB.prepare('INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, reg.id, reg.lead_id, kind, kind === 'seat' ? 'Masterclass ticket' : cfg.offerName, 'pending', amount, cfg.currency.toLowerCase(), expiresAt, now, now).run();
  const back = o.from === 'room' ? roomUrl(rt, reg.token) : `${webinarBase(rt)}/registered/${reg.token}`;
  try {
    const s = await stripeApi<StripeCheckoutSession>(rt, 'POST', 'checkout/sessions',
      checkoutForm(cfg, { kind, passId: id, reg, email: lead?.email ?? null, back, expiresAt, title: session?.title || webinarSettings(rt).title }), id);
    await rt.env.DB.prepare('UPDATE webinar_passes SET stripe_session_id = ?, checkout_url = ?, updated_at = ? WHERE id = ?').bind(s.id, s.url ?? null, Date.now(), id).run();
    if (!s.url) throw new Error('Stripe returned no checkout link');
    await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_checkout_started', source: 'server', props: { pass_id: id, kind, from: o.from ?? 'ty' }, localOnly: true });
    return { url: s.url };
  } catch (e) {
    await rt.env.DB.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
    console.error('stripe checkout failed', e);
    throw new PassError('Payment couldn’t be started just now. Please try again in a minute.', 502);
  }
}

// ───────────── Paid / refunded (shared by the webhook and the return check) ─────────────

export interface PaidInput { sessionId: string; paymentIntent: string | null; amount: number | null; currency: string | null; regId: string | null; passId?: string | null; kind?: string | null }
export type PaidEffects = (rt: Runtime, pass: PassRow) => Promise<void>;

/**
 * Marks the purchase for a Checkout Session paid. Idempotent on the session id: only the first call moves
 * the row to 'paid' and runs the effects (lead marker, replay, Slack, ad conversion); later calls are no-ops.
 */
export async function markPassPaid(rt: Runtime, p: PaidInput, effects: PaidEffects = passPaidEffects) {
  const db = rt.env.DB;
  const now = Date.now();
  let row = await db.prepare('SELECT * FROM webinar_passes WHERE stripe_session_id = ?').bind(p.sessionId).first<PassRow>();
  if (!row && p.passId) {
    // The session id wasn't saved yet (the webhook beat our own write): attach it by our pass id.
    await db.prepare('UPDATE webinar_passes SET stripe_session_id = ? WHERE id = ? AND stripe_session_id IS NULL').bind(p.sessionId, p.passId).run();
    row = await db.prepare('SELECT * FROM webinar_passes WHERE stripe_session_id = ?').bind(p.sessionId).first<PassRow>();
  }
  if (!row) {
    const reg = p.regId ? await db.prepare('SELECT id, lead_id FROM webinar_registrations WHERE id = ?').bind(p.regId).first<{ id: string; lead_id: string }>() : null;
    if (!reg) return { ok: false as const, reason: 'unknown registration' };
    await db.prepare('INSERT OR IGNORE INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, stripe_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(newId('wp'), reg.id, reg.lead_id, p.kind === 'seat' ? 'seat' : 'offer', 'pending', p.amount ?? 0, (p.currency ?? 'usd').toLowerCase(), p.sessionId, now, now).run();
  }
  const res = await db.prepare(
    `UPDATE webinar_passes SET status = 'paid', paid_at = ?, updated_at = ?, stripe_payment_intent = COALESCE(?, stripe_payment_intent),
            amount = COALESCE(?, amount), currency = COALESCE(?, currency),
            credit_amount = CASE WHEN kind = 'offer' THEN COALESCE(?, amount) ELSE 0 END
      WHERE stripe_session_id = ? AND status IN ('pending', 'expired')`,
  ).bind(now, now, p.paymentIntent, p.amount, p.currency ? p.currency.toLowerCase() : null, p.amount, p.sessionId).run();
  const pass = (await db.prepare('SELECT * FROM webinar_passes WHERE stripe_session_id = ?').bind(p.sessionId).first<PassRow>())!;
  if ((res.meta.changes ?? 0) === 0) return { ok: true as const, duplicate: true, pass };
  await effects(rt, pass);
  return { ok: true as const, duplicate: false, pass };
}

/** What a payment sets in motion. */
export async function passPaidEffects(rt: Runtime, pass: PassRow) {
  const value = fromMinor(pass.amount, pass.currency);
  const who = await identityFromLead(rt.env, pass.lead_id);
  const lead = await getLead(rt.env, pass.lead_id);
  const { notifySlack } = await import('../integrations/notify');
  const paid = formatMoney(value, pass.currency.toUpperCase());
  const band = lead?.revenue_band ? REVENUE_LABEL[lead.revenue_band] ?? lead.revenue_band : 'revenue not given';
  if (pass.kind === 'seat') {
    // Forwarded as a Purchase (Meta CAPI / GA4) with the ticket price as the value.
    await track(rt, who, { name: 'webinar_seat_purchased', source: 'webhook', path: '/webinar', props: { pass_id: pass.id, product: 'Masterclass ticket', value, currency: pass.currency.toUpperCase() } });
    // The ticket is paid: the finish-your-ticket emails stop and the confirmation, reminders, pre-webinar emails and texts start now.
    await startTicketedMessages(rt, pass.lead_id);
    if (lead) rt.waitUntil(notifySlack(rt, lead, '🎟️ Masterclass ticket paid', [`Ticket: ${paid} · ${band}`], 'qualified_lead').catch((e) => console.error('ticket slack failed', e)));
    return;
  }
  const cfg = passConfig(rt.settings);
  await rt.env.DB.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').bind(Date.now(), pass.lead_id).run(); // surfaces the lead as recently active
  await applyPassReplay(rt, pass.lead_id, true);
  await track(rt, who, { name: 'webinar_offer_purchased', source: 'webhook', path: '/webinar', props: { pass_id: pass.id, product: pass.product, value, currency: pass.currency.toUpperCase() } });
  if (lead) rt.waitUntil(notifySlack(rt, lead, `💳 ${pass.product || cfg.offerName} purchased`, [
    `Paid: ${paid} · ${band}`,
    cfg.sessionUrl ? 'They can book their 60-minute session from the confirmation page.' : 'Email them to book their 60-minute session (no booking link is set).',
  ], 'hot_lead').catch((e) => console.error('offer slack failed', e)));
}

/** A full refund withdraws the purchase: no credit, normal replay, and the room closes again if a paid seat was required. */
export async function markPassRefunded(rt: Runtime, o: { paymentIntent: string | null; passId: string | null; amountRefunded: number; fully: boolean }) {
  const db = rt.env.DB;
  const row = o.paymentIntent ? await db.prepare('SELECT * FROM webinar_passes WHERE stripe_payment_intent = ?').bind(o.paymentIntent).first<PassRow>() : null;
  const pass = row ?? (o.passId ? await db.prepare('SELECT * FROM webinar_passes WHERE id = ?').bind(o.passId).first<PassRow>() : null);
  if (!pass) return { ok: false as const, reason: 'unknown payment' };
  const now = Date.now();
  if (!o.fully) {
    await db.prepare('UPDATE webinar_passes SET refunded_amount = ?, updated_at = ? WHERE id = ?').bind(o.amountRefunded, now, pass.id).run();
    return { ok: true as const, partial: true };
  }
  const res = await db.prepare("UPDATE webinar_passes SET status = 'refunded', refunded_at = ?, refunded_amount = ?, credit_amount = 0, updated_at = ? WHERE id = ? AND status = 'paid'")
    .bind(now, o.amountRefunded, now, pass.id).run();
  if ((res.meta.changes ?? 0) === 0) return { ok: true as const, duplicate: true };
  if (pass.kind === 'offer' && !(await activePass(rt, pass.lead_id))) {
    await applyPassReplay(rt, pass.lead_id, false);
  }
  // A refunded ticket closes the room again (passGate finds nothing paid) and stops what the ticket started.
  if (pass.kind === 'seat' && !(await anyPaid(rt, pass.lead_id))) await stopTicketedMessages(rt, pass.lead_id);
  await track(rt, await identityFromLead(rt.env, pass.lead_id), { name: 'webinar_purchase_refunded', source: 'webhook', props: { pass_id: pass.id, kind: pass.kind }, localOnly: true });
  return { ok: true as const, duplicate: false };
}

const piId = (v: StripeCheckoutSession['payment_intent']) => (typeof v === 'string' ? v : v?.id ?? null);

function paidInput(s: StripeCheckoutSession): PaidInput {
  return { sessionId: s.id, paymentIntent: piId(s.payment_intent), amount: s.amount_total ?? null, currency: s.currency ?? null, regId: s.client_reference_id ?? s.metadata?.reg_id ?? null, passId: s.metadata?.pass_id ?? null, kind: s.metadata?.kind ?? null };
}

export const STRIPE_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired', 'charge.refunded'] as const;

/** Verified Stripe webhook events. Anything that isn't ours (no masterclass metadata) is ignored. */
export async function handleStripeEvent(rt: Runtime, ev: { id?: string; type?: string; data?: { object?: Record<string, unknown> } }, effects: PaidEffects = passPaidEffects) {
  const obj = (ev.data?.object ?? {}) as Record<string, unknown>;
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
    const s = obj as unknown as StripeCheckoutSession;
    if (!s.metadata?.pass_id && !s.metadata?.reg_id) return { ignored: 'not a masterclass checkout' };
    if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') return { ignored: `payment ${s.payment_status ?? 'unknown'}` };
    const r = await markPassPaid(rt, paidInput(s), effects);
    return r.ok ? { paid: r.pass.id, duplicate: r.duplicate } : { ignored: r.reason };
  }
  if (ev.type === 'checkout.session.expired') {
    const id = String(obj.id ?? '');
    await rt.env.DB.prepare("UPDATE webinar_passes SET status = 'expired', updated_at = ? WHERE stripe_session_id = ? AND status = 'pending'").bind(Date.now(), id).run();
    return { expired: id };
  }
  if (ev.type === 'charge.refunded') {
    const meta = (obj.metadata ?? {}) as Record<string, string>;
    const r = await markPassRefunded(rt, {
      paymentIntent: typeof obj.payment_intent === 'string' ? obj.payment_intent : null,
      passId: meta.pass_id ?? null,
      amountRefunded: Number(obj.amount_refunded ?? 0),
      fully: obj.refunded === true,
    });
    return r.ok ? { refunded: true, ...r } : { ignored: r.reason };
  }
  return { ignored: ev.type ?? 'unknown' };
}

/** Back from Stripe with ?pass=success: ask Stripe directly, in case the webhook hasn't arrived yet. */
export async function confirmOnReturn(rt: Runtime, reg: Registration) {
  const row = await rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE reg_id = ? AND stripe_session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").bind(reg.id).first<PassRow>();
  if (!row) return (await anyPaid(rt, reg.lead_id)) ? ('paid' as const) : ('unknown' as const);
  if (row.status === 'paid') return 'paid' as const;
  if (!rt.settings.STRIPE_SECRET_KEY || !row.stripe_session_id) return 'unknown' as const;
  try {
    const s = await stripeApi<StripeCheckoutSession>(rt, 'GET', `checkout/sessions/${encodeURIComponent(row.stripe_session_id)}`);
    if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') { await markPassPaid(rt, paidInput(s)); return 'paid' as const; }
    return 'pending' as const;
  } catch (e) {
    console.error('stripe session lookup failed', e);
    return 'unknown' as const;
  }
}

// ───────────── Page blocks ─────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const packUrl = (rt: Runtime, token: string) => `${webinarBase(rt)}/pack/${token}`;

function perkList(perks: Perk[]) {
  return `<ul class="pass-perks">${perks.map((p) => `<li><strong>${esc(p.title)}</strong>${p.body ? `<span>${esc(p.body)}</span>` : ''}</li>`).join('')}</ul>`;
}

/** The offer card on the thank-you page. */
export function offerCardHtml(cfg: PassConfig, cap: ReturnType<typeof capacity>, note: string | null = null) {
  const t = passCopy(cfg);
  return `<div class="card pass-card" data-pass-offer>
    <p class="pass-eyebrow">${esc(t.upsellEyebrow)}</p>
    <h2 class="pass-h">${esc(t.upsellHeading)}</h2>
    <p class="pass-lede">${esc(t.upsellBody)}</p>
    ${note ? `<p class="pass-note" role="status">${esc(note)}</p>` : ''}
    <p class="pass-sub">${esc(t.includes)}</p>
    ${perkList(cfg.perks)}
    <div class="pass-buy">
      <p class="pass-price"><b>${esc(cfg.priceLabel)}</b> <span>${esc(cfg.currency)} · one payment · ${esc(cfg.guarantee)}</span></p>
      ${cap.full ? `<p class="pass-note">${esc(t.soldOut)}</p>` : `<button type="button" class="btn btn-lg pass-btn" data-pass-buy="offer">${esc(t.button)} · ${esc(cfg.priceLabel)}</button>`}
      ${cap.label ? `<p class="pass-cap">${esc(cap.label)}</p>` : ''}
      <p class="pass-fine">${esc(t.secure)} ${esc(t.noResults)}</p>
    </div>
  </div>`;
}

/** The paid-ticket step (required mode with a seat price): the fallback when registration couldn't go straight to Stripe. */
export function seatCardHtml(cfg: PassConfig, note: string | null = null, replayHours = 48) {
  const t = passCopy(cfg);
  const k = ticketCopy({ label: cfg.seat!.label, replayHours });
  return `<div class="card pass-card seat" data-pass-offer>
    <h2 class="pass-h">${esc(t.seatHeading)}</h2>
    <p class="pass-lede">${esc(t.seatBody)}</p>
    ${note ? `<p class="pass-note" role="status">${esc(note)}</p>` : ''}
    <p class="pass-sub">${esc(k.includesHeading)}</p>
    ${perkList(k.includes)}
    <div class="pass-buy">
      <p class="pass-price"><b>${esc(cfg.seat!.label)}</b> <span>${esc(cfg.currency)} · one payment</span></p>
      <button type="button" class="btn btn-lg pass-btn" data-pass-buy="seat">${esc(t.seatButton)} · ${esc(cfg.seat!.label)}</button>
      <p class="pass-fine"><strong>${esc(k.guaranteeHeading)}.</strong> ${esc(k.guarantee)}</p>
      <p class="pass-fine">${esc(k.credit)} ${esc(t.secure)}</p>
    </div>
  </div>`;
}

/** Back from Stripe with the ticket paid. */
export function ticketConfirmedHtml(cfg: PassConfig, replayHours = 48) {
  const k = ticketCopy({ label: cfg.seat?.label ?? formatMoney(0, cfg.currency), replayHours });
  return `<div class="card pass-card active compact" data-ticket-confirmed>
    <p class="pass-eyebrow"><span class="pass-badge">${esc(k.eyebrow)}</span></p>
    <h2 class="pass-h">${esc(k.confirmedHeading)}</h2>
    <p class="pass-lede">${esc(k.confirmedBody)}</p>
    <p class="pass-fine">${esc(k.credit)} ${esc(k.guarantee)}</p>
  </div>`;
}

/** The buyer's card: what happens next, with the pack and the session booking. */
export function holderCardHtml(rt: Runtime, cfg: PassConfig, pass: Pick<PassRow, 'product'>, token: string, compact = false) {
  const t = passCopy({ ...cfg, offerName: pass.product || cfg.offerName });
  const links = [
    `<a class="btn btn-sm" href="${esc(`${webinarBase(rt)}/sprint/${token}`)}" target="_blank" rel="noopener" data-deal-sprint>Open my Sprint page</a>`, // First Deal Sprint page (deal-sprint.ts)
    `<a class="btn btn-sm secondary" href="${esc(packUrl(rt, token))}" target="_blank" rel="noopener">${esc(t.packLink)}</a>`,
    cfg.sessionUrl ? `<a class="btn btn-sm secondary" href="${esc(cfg.sessionUrl)}" target="_blank" rel="noopener" data-pass-review>${esc(t.sessionLink)}</a>` : '',
  ].join(' ');
  return `<div class="card pass-card active${compact ? ' compact' : ''}" data-pass-holder>
    <p class="pass-eyebrow"><span class="pass-badge">${esc(t.roomBadge)}</span></p>
    <h2 class="pass-h">${esc(t.activeHeading)}</h2>
    ${compact ? '' : `<p class="pass-lede">${esc(t.activeBody)}</p>${perkList(cfg.perks)}`}
    <p class="pass-links">${links}</p>
    ${cfg.sessionUrl ? '' : `<p class="pass-fine">${esc(t.sessionEmail)}</p>`}
  </div>`;
}

/** Everything the thank-you page needs: which card(s), and whether the rest of the page waits for a paid seat. */
export async function registeredPassBlock(rt: Runtime, reg: Registration, query: { pass?: string | null }) {
  const cfg = passConfig(rt.settings);
  let note: string | null = null;
  if (query.pass === 'success') {
    const r = await confirmOnReturn(rt, reg);
    if (r !== 'paid') note = passCopy(cfg).confirming;
  }
  if (query.pass === 'cancel') note = passCopy(cfg).cancelled;
  const replayHours = webinarSettings(rt).replayHours;
  // Ticket mode: a paid ticket gets its confirmation above whatever card follows.
  const ticket = cfg.mode === 'required' && cfg.seat && (await paidTicket(rt, reg.lead_id)) ? ticketConfirmedHtml(cfg, replayHours) : '';
  const holder = await activePass(rt, reg.lead_id);
  if (holder) return { html: ticket + holderCardHtml(rt, cfg, holder, reg.token), gate: false, active: true, confirming: false, ticket: Boolean(ticket) };
  if (cfg.mode === 'off') return { html: '', gate: false, active: false, confirming: false, ticket: false };
  const gate = await passGate(rt, reg);
  if (gate) return { html: seatCardHtml(cfg, note, replayHours), gate: true, active: false, confirming: note === passCopy(cfg).confirming, ticket: false };
  const cap = await passCapacity(rt, cfg);
  return { html: ticket + offerCardHtml(cfg, cap, note), gate: false, active: false, confirming: note === passCopy(cfg).confirming, ticket: Boolean(ticket) };
}

/** Room config: the buyer's card, or the one-click offer for $1M+ viewers at the pitch. */
export async function roomPassConfig(rt: Runtime, reg: Registration, qualified: boolean) {
  const cfg = passConfig(rt.settings);
  const holder = await activePass(rt, reg.lead_id);
  const t = passCopy(cfg);
  if (holder) return { active: true, holderHtml: holderCardHtml(rt, cfg, holder, reg.token, true), note: cfg.priorityAnswers ? t.holderNote : null, badge: holder.product || cfg.offerName };
  if (cfg.mode === 'off' || !qualified) return null;
  const cap = await passCapacity(rt, cfg);
  return {
    active: false,
    offer: {
      name: cfg.offerName, price: cfg.priceLabel, heading: t.roomHeading, body: t.roomBody, button: t.button, bookCall: t.bookCall,
      includes: t.includes, perks: cfg.perks, guarantee: cfg.guarantee, fine: `${t.secure} ${t.noResults}`,
      full: cap.full, soldOut: cap.full ? t.soldOut : null, capLabel: cap.label,
    },
  };
}

// ───────────── Deal pack ─────────────

const pay = (principal: number, rate: number, years: number) => (principal * rate) / (1 - (1 + rate) ** -years);

/**
 * The room calculator's maths, extended: the 70/20/10 stack, the yearly payments, the coverage ratio,
 * the highest price that clears 1.5x at this profit, the most debt the profit carries, and two alternatives.
 */
export function dealMaths(profit: number, price: number) {
  const stack = (debtShare: number, noteShare: number, noteYears: number) => {
    const debt = price * debtShare, note = price * noteShare, rollover = price * (1 - debtShare - noteShare);
    const service = pay(debt, 0.09, 10) + pay(note, 0.06, noteYears);
    return { debt, note, rollover, service, dscr: service ? profit / service : 0 };
  };
  const base = stack(0.7, 0.2, 5);
  const perDollar = base.service / price;
  return {
    profit, price, multiple: price / profit,
    base,
    clears: base.dscr >= 1.5,
    maxPrice: perDollar ? profit / (1.5 * perDollar) : 0,
    /** Bank debt alone (9% over 10 years) that this profit services at 1.5x. */
    maxDebt: (profit / 1.5) / (0.09 / (1 - 1.09 ** -10)),
    longerNote: stack(0.7, 0.2, 7),
    moreRollover: stack(0.6, 0.2, 5),
  };
}

const POLL_LABEL: Record<string, string> = { target_type: 'First acquisition', timeline: 'When you want it closed', blocker: 'Biggest blocker', own_cash: 'Own cash' };

/**
 * The pack's data. BLUEPRINT HOOK: when src/webinar/blueprint.ts is merged, render the personalised
 * blueprint for buyers from here (same inputs: their band, answers and numbers).
 */
export async function dealReviewPack(rt: Runtime, reg: Registration) {
  const lead = await getLead(rt.env, reg.lead_id);
  const inter = await rt.env.DB.prepare("SELECT kind, key, value, created_at FROM webinar_interactions WHERE lead_id = ? AND kind IN ('poll', 'calc', 'commit') ORDER BY created_at DESC")
    .bind(reg.lead_id).all<{ kind: string; key: string | null; value: string | null; created_at: number }>();
  const { DEFAULT_POLLS, THANK_YOU } = await import('./content');
  const answers = DEFAULT_POLLS.flatMap((p) => {
    const a = inter.results.find((i) => i.kind === 'poll' && i.key === p.id);
    const opt = a && p.options.find((o) => o.value === a.value);
    return opt ? [{ label: POLL_LABEL[p.id] ?? p.question, value: opt.label }] : [];
  });
  const commit = inter.results.find((i) => i.kind === 'commit');
  const calc = inter.results.find((i) => i.kind === 'calc');
  const nums = (() => { try { const v = JSON.parse(calc?.value ?? '{}') as { profit?: number; price?: number }; return v.profit && v.price ? { profit: v.profit, price: v.price } : null; } catch { return null; } })();
  return {
    name: lead?.first_name ?? null,
    band: lead?.revenue_band ? REVENUE_LABEL[lead.revenue_band] ?? lead.revenue_band : null,
    target: commit ? THANK_YOU.options.find((o) => o.value === commit.value)?.label ?? null : null,
    answers,
    numbers: nums,
    maths: nums ? dealMaths(nums.profit, nums.price) : null,
  };
}

export async function markPackViewed(rt: Runtime, leadId: string) {
  await rt.env.DB.prepare("UPDATE webinar_passes SET pack_viewed_at = COALESCE(pack_viewed_at, ?) WHERE lead_id = ? AND kind = 'offer' AND status = 'paid'").bind(Date.now(), leadId).run();
}

export async function markReviewClicked(rt: Runtime, token: string) {
  const reg = await getRegistration(rt, token);
  if (!reg) return { ok: false as const };
  await rt.env.DB.prepare("UPDATE webinar_passes SET review_clicked_at = COALESCE(review_clicked_at, ?) WHERE lead_id = ? AND kind = 'offer' AND status = 'paid'").bind(Date.now(), reg.lead_id).run();
  return { ok: true as const };
}

// ───────────── Funnel HQ ─────────────

export async function passReport(rt: Runtime, range: { from: number; to: number }) {
  const db = rt.env.DB;
  const cfg = passConfig(rt.settings);
  type Agg = { sold: number | null; refunds: number | null; revenue: number | null; credit: number | null; open_checkouts: number | null };
  const agg = (kind: PassKind) => db.prepare(
    `SELECT SUM(status IN ('paid', 'refunded')) AS sold, SUM(status = 'refunded') AS refunds,
            SUM(CASE WHEN status = 'paid' THEN amount - refunded_amount ELSE 0 END) AS revenue,
            SUM(CASE WHEN status = 'paid' THEN credit_amount ELSE 0 END) AS credit,
            SUM(status = 'pending' AND COALESCE(expires_at, 0) > ?) AS open_checkouts
       FROM webinar_passes WHERE kind = ? AND COALESCE(paid_at, created_at) BETWEEN ? AND ?`,
  ).bind(Date.now(), kind, range.from, range.to).first<Agg>();
  const [offer, seat, regs, holders, cap] = await Promise.all([
    agg('offer'), agg('seat'),
    // Unpaid: registered while a ticket was required and nothing is paid (or it was refunded) for that person.
    db.prepare(
      `SELECT COUNT(*) AS n, SUM(pass_required) AS required,
              SUM(pass_required = 1 AND NOT EXISTS (SELECT 1 FROM webinar_passes p WHERE p.lead_id = r.lead_id AND p.status = 'paid')) AS unpaid
         FROM webinar_registrations r WHERE created_at BETWEEN ? AND ?`,
    ).bind(range.from, range.to).first<{ n: number; required: number | null; unpaid: number | null }>(),
    db.prepare(
      `SELECT p.id, p.kind, p.product, p.status, p.amount, p.currency, p.paid_at, p.refunded_at, p.credit_amount, p.review_clicked_at, p.review_booked_at, p.pack_viewed_at,
              l.id AS lead_id, l.first_name, l.last_name, l.email, COALESCE(r.revenue_band, l.revenue_band) AS band
         FROM webinar_passes p JOIN leads l ON l.id = p.lead_id LEFT JOIN webinar_registrations r ON r.id = p.reg_id
        WHERE p.status IN ('paid', 'refunded') AND p.kind = 'offer' ORDER BY p.paid_at DESC LIMIT 200`,
    ).all<Record<string, unknown>>(),
    passCapacity(rt, cfg),
  ]);
  const cur = cfg.currency;
  const money = (minor: number | null | undefined) => formatMoney(fromMinor(minor ?? 0, cur), cur);
  const n = offer?.sold ?? 0;
  return {
    config: {
      requested: cfg.requested, mode: cfg.mode, reason: cfg.reason, offerName: cfg.offerName, price: cfg.price, currency: cur, priceLabel: cfg.priceLabel,
      seat: cfg.seat?.label ?? null, replayDays: cfg.replayDays, sessionUrl: cfg.sessionUrl, guarantee: cfg.guarantee, weeklyCap: cfg.weeklyCap,
      priorityAnswers: cfg.priorityAnswers, perks: cfg.perks.map((p) => p.title), customPerks: cfg.customPerks,
    },
    checklist: {
      secretKey: Boolean(rt.settings.STRIPE_SECRET_KEY),
      webhookSecret: cfg.webhookReady,
      webhookUrl: `${rt.origin}/hooks/stripe`,
      events: [...STRIPE_EVENTS],
      sessionUrl: Boolean(cfg.sessionUrl),
      testMode: /^(sk|rk)_test_/.test(rt.settings.STRIPE_SECRET_KEY || ''),
    },
    kpis: {
      sold: n,
      refunds: offer?.refunds ?? 0,
      revenue: fromMinor(offer?.revenue ?? 0, cur),
      revenueLabel: money(offer?.revenue),
      creditLabel: money(offer?.credit),
      openCheckouts: offer?.open_checkouts ?? 0,
      registrants: regs?.n ?? 0,
      conversion: regs?.n ? n / regs.n : null,
      seats: seat?.sold ?? 0,
      seatRevenueLabel: money(seat?.revenue),
      seatRefunds: seat?.refunds ?? 0,
      requiredRegistrants: regs?.required ?? 0,
      // The paid ticket (kind 'seat'), named as the owner sees it.
      ticketsSold: (seat?.sold ?? 0) - (seat?.refunds ?? 0),
      ticketRevenueLabel: money(seat?.revenue),
      ticketRefunds: seat?.refunds ?? 0,
      ticketOpenCheckouts: seat?.open_checkouts ?? 0,
      unpaidRegistrations: regs?.unpaid ?? 0,
    },
    capacity: cap,
    holders: holders.results.map((h) => ({
      id: h.id, lead_id: h.lead_id, status: h.status, product: h.product,
      name: [h.first_name, h.last_name].filter(Boolean).join(' ') || h.email || 'Someone', email: h.email,
      band: h.band ? REVENUE_LABEL[String(h.band)] ?? h.band : null,
      paid: formatMoney(fromMinor(Number(h.amount), String(h.currency)), String(h.currency).toUpperCase()),
      credit: Number(h.credit_amount) ? formatMoney(fromMinor(Number(h.credit_amount), String(h.currency)), String(h.currency).toUpperCase()) : null,
      paid_at: h.paid_at, refunded_at: h.refunded_at, review_clicked_at: h.review_clicked_at, review_booked_at: h.review_booked_at, pack_viewed_at: h.pack_viewed_at,
    })),
  };
}

export async function setReviewBooked(rt: Runtime, passId: string, booked: boolean) {
  await rt.env.DB.prepare('UPDATE webinar_passes SET review_booked_at = ?, updated_at = ? WHERE id = ?').bind(booked ? Date.now() : null, Date.now(), passId).run();
}

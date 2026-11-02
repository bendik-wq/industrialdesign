import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { type Lead, getLead, parseAnswers } from '../funnel/leads';
import { hmacHex, safeEqual } from '../lib/crypto';
import { getSecret } from '../lib/secret';
import type { PassKind, PassRow } from '../webinar/pass';

/**
 * Payment links via Whop, for every card and email that asks for money (the room's Sprint and deposit cards,
 * the challenge and live offer emails, the room summary).
 *
 *  - One click on the saved card stays first (sales/deposit.ts oneClickCharge). Without one, the buyer gets our
 *    signed pay page (sales/pay-page.ts): Whop's card fields, and Whop's own checkout one tap away. That checkout
 *    is a Whop checkout configuration with an inline one-time plan at the exact price and our attribution in its
 *    metadata (lead, product, source, room and push), cached on the purchase row until it expires, so a second
 *    tap reuses it and a closed tab costs nothing. The API key never leaves the server.
 *  - Prefill: everything we already know (email, first and last name, phone, country, business) fills our pay
 *    page and forms, and the email and name go into Whop's embedded checkout with its documented prefill
 *    attributes (data-whop-checkout-prefill-email / -name). Whop's hosted link takes no prefill.
 *  - Timer: only a real deadline the server enforces (the live event's or cohort's offer close, the replay close,
 *    or a push's price hold when the owner switched it on). No deadline, no timer.
 */

type Rt = Pick<Runtime, 'env' | 'settings' | 'origin'>;
type S = Partial<Record<string, string>>;
const MIN = 60_000;

// ───────────── prefill ─────────────

export interface Prefill {
  email: string | null; firstName: string | null; lastName: string | null; name: string | null;
  phone: string | null; country: string | null; company: string | null; revenue: string | null;
}

const clean = (v: unknown, max = 120) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || null : null);

/** Everything we know about a lead that a form or checkout asks for (pure). The business comes from the application. */
export function prefillFromLead(lead: Pick<Lead, 'email' | 'first_name' | 'last_name' | 'phone' | 'answers'> & Partial<Pick<Lead, 'revenue_band'>> & { country?: string | null; industry?: string | null } | null): Prefill | null {
  if (!lead) return null;
  let a: Record<string, unknown> = {};
  try { a = parseAnswers(lead as Lead) as Record<string, unknown>; } catch { a = {}; }
  const firstName = clean(lead.first_name, 60), lastName = clean(lead.last_name, 60);
  return {
    email: clean(lead.email, 160)?.toLowerCase() ?? null,
    firstName, lastName,
    name: [firstName, lastName].filter(Boolean).join(' ') || null,
    phone: clean(lead.phone, 30),
    country: clean(lead.country, 2)?.toUpperCase() ?? null,
    company: clean(a.company) ?? clean(a.business_name) ?? clean(a.business) ?? clean(lead.industry ?? null),
    revenue: typeof a.revenue === 'string' && /^[a-z0-9_]{2,12}$/.test(a.revenue) ? a.revenue : null,
  };
}

export async function prefillFor(rt: Pick<Runtime, 'env'>, leadId: string | null | undefined) {
  return leadId ? prefillFromLead(await getLead(rt.env, leadId)) : null;
}

/** Whop's embedded checkout prefill (documented attributes on the embed's div). Only what Whop supports. */
export function whopPrefillAttrs(p: Prefill | null): Record<string, string> {
  const o: Record<string, string> = {};
  if (p?.email) o['data-whop-checkout-prefill-email'] = p.email;
  if (p?.name) o['data-whop-checkout-prefill-name'] = p.name;
  return o;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Fills our own registration forms for a known person (their browser came from a signed email link). Inputs that
 * already carry a value are left alone; revenue fills a <select> option or a radio. Pure, for the tests.
 */
export function prefillInputs(html: string, p: Prefill | null) {
  if (!p) return html;
  const vals: Record<string, string | null> = { first_name: p.firstName, last_name: p.lastName, name: p.name, email: p.email, phone: p.phone, company: p.company, business: p.company };
  let out = html.replace(/<input\b([^>]*)>/g, (tag, attrs: string) => {
    const name = /\bname="([a-z_]+)"/.exec(attrs)?.[1];
    if (!name || /\btype="(hidden|checkbox|radio)"/.test(attrs) || /\bvalue=/.test(attrs)) {
      if (name === 'revenue' && p.revenue && /\btype="radio"/.test(attrs) && new RegExp(`\\bvalue="${p.revenue}"`).test(attrs) && !/\bchecked\b/.test(attrs)) return `<input${attrs} checked>`;
      return tag;
    }
    const v = vals[name];
    return v ? `<input${attrs} value="${attr(v)}">` : tag;
  });
  if (p.revenue) out = out.replace(/(<select\b[^>]*name="revenue"[^>]*>)([\s\S]*?)(<\/select>)/, (_m, a: string, opts: string, b: string) => a + opts.replace(new RegExp(`<option value="${p.revenue}">`), `<option value="${p.revenue}" selected>`) + b);
  return out;
}

/** The "Paying as" line on pay pages and in-room sheets (so nobody retypes what we know). */
export function payingAs(p: Prefill | null) {
  if (!p || (!p.name && !p.email)) return null;
  return `Paying as ${[p.name, p.email].filter(Boolean).join(', ')}${p.company ? ` for ${p.company}` : ''}`;
}

// ───────────── the real deadline ─────────────

export type DeadlineReason = 'offer' | 'replay' | 'hold';
export interface Deadline { at: number; reason: DeadlineReason }

/** The earliest real deadline among the ones that apply (offer close, replay close, price hold). None = null: no timer. */
export function pickDeadline(cands: (Deadline | null | undefined | false)[]): Deadline | null {
  const real = cands.filter((d): d is Deadline => Boolean(d && Number.isFinite(d.at) && d.at > 0));
  if (!real.length) return null;
  return real.reduce((a, b) => (b.at < a.at ? b : a));
}

/** Every visible string of the payment links (checked by auditCopy in the tests). */
export const PAY_COPY = {
  timer: { offer: 'This offer closes in', replay: 'Closes with your replay in', hold: 'This price holds for' } as Record<DeadlineReason, string>,
  closed: { offer: 'This offer has closed.', replay: 'This offer closed with your replay.', hold: 'The price from this card has closed. Ask the host if it opens again.' } as Record<DeadlineReason, string>,
  whopButton: 'Pay on Whop’s secure checkout',
  whopNote: 'Opens Whop’s checkout with your details filled in. Your card details go to Whop, never to us.',
  newTab: 'Open Whop’s checkout in a new tab',
  back: 'Back',
  holdSetting: 'Price hold after each push (minutes, blank for off)',
  linkInvalid: 'This payment link isn’t valid. Open the latest email from Josh’s team, or reply to it and the team sends a fresh one.',
  linkPaid: 'This is already paid. Your welcome email has the next step.',
};

export const deadlineLabel = (r: DeadlineReason) => PAY_COPY.timer[r];

/** A price hold in minutes from the room's own settings (Funnel HQ → Rooms). Off unless the owner set it. */
export function priceHoldMin(engageJson: string | null | undefined) {
  let o: { priceHold?: unknown } = {};
  try { o = JSON.parse(engageJson ?? '{}') ?? {}; } catch { o = {}; }
  const n = Number(o.priceHold);
  return Number.isInteger(n) && n >= 1 && n <= 240 ? n : 0;
}

/** What a push's hold_until should be at push time (only the cards that sell: the Sprint). */
export const holdUntilFor = (kind: string, createdAt: number, minutes: number) => (kind === 'sprint' && minutes > 0 ? createdAt + minutes * MIN : null);

/** The live event's or cohort's offer close for a deposit (null when the offer has no close yet). */
export async function offerDeadline(rt: Runtime, source: string | null | undefined, refId: string | null | undefined, now = Date.now()): Promise<Deadline | null> {
  if (!refId) return null;
  if (source === 'live') {
    const { getEvent, liveSettings, offerWindow } = await import('../live/events');
    const ev = await getEvent(rt, refId);
    if (!ev) return null;
    const w = offerWindow(ev, now, liveSettings(rt).offerHours);
    return w.opened && w.closesAt ? { at: w.closesAt, reason: 'offer' } : null;
  }
  if (source === 'challenge') {
    const reg = await rt.env.DB.prepare('SELECT cohort_id FROM challenge_registrations WHERE id = ?').bind(refId).first<{ cohort_id: string }>();
    if (!reg) return null;
    const { cohortOffer } = await import('../challenge/offer');
    const s = await cohortOffer(rt, reg.cohort_id, now);
    return s.closeAt ? { at: s.closeAt, reason: 'offer' } : null;
  }
  return null;
}

/** A purchase row's deadline, as stored when the checkout started. */
export const rowDeadline = (row: Pick<PassRow, 'id'> & { deadline_at?: number | null; deadline_reason?: string | null }): Deadline | null =>
  row.deadline_at ? { at: row.deadline_at, reason: (['offer', 'replay', 'hold'].includes(String(row.deadline_reason)) ? row.deadline_reason : 'offer') as DeadlineReason } : null;

/** The timer markup (pay page, server-rendered; pay-timer.js counts it down). Empty without a deadline. */
export function timerHtml(d: Deadline | null, now = Date.now()) {
  if (!d) return '';
  if (d.at <= now) return `<p class="pass-note pass-err" role="status">${attr(PAY_COPY.closed[d.reason])}</p>`;
  return `<p class="pay-timer" data-pay-deadline="${d.at}" data-pay-now="${now}"><span>${attr(deadlineLabel(d.reason))}</span> <strong data-pay-left>${attr(clock(d.at - now))}</strong></p>`;
}
export function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return d ? `${d}d ${h}h ${p(m)}m` : h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`;
}

// ───────────── the Whop checkout session (cached per purchase) ─────────────

export type PayRowLike = PassRow & { source?: string | null; ref_id?: string | null; return_url?: string | null; deadline_at?: number | null; deadline_reason?: string | null; push_id?: number | null; whop_plan_id?: string | null; checkout_expires_at?: number | null };

/** Our attribution on every checkout session: lead, product, source, room and push (Whop keeps it on the payment). */
export function sessionMetadata(row: PayRowLike) {
  const roomId = row.source === 'room' ? row.ref_id ?? '' : /^room:([^:]+):/.exec(row.reg_id ?? '')?.[1] ?? '';
  return {
    pass_id: row.id, lead_id: row.lead_id, kind: row.kind, product: (row.product || row.kind).slice(0, 60), source: row.source ?? '', ref_id: row.ref_id ?? '',
    room_id: roomId, push_id: row.push_id != null ? String(row.push_id) : '', pay_link: '1',
  };
}

/** How long a cached session is reused: until the purchase row or the deadline expires, whichever is first. */
export const sessionExpiry = (row: PayRowLike, now: number) => Math.min(row.expires_at ?? now + 24 * 60 * MIN, row.deadline_at ?? Infinity);

/**
 * The Whop checkout session for a waiting purchase: reused while cached, else created (inline plan, metadata,
 * redirect back to the pay page) and stored on the row. Refused after the row's real deadline.
 */
export async function whopSession(rt: Runtime, row: PayRowLike, o: { redirectUrl: string; description: string; title: string; now?: number }) {
  const now = o.now ?? Date.now();
  if (row.deadline_at && row.deadline_at <= now) throw new PayClosed(rowDeadline(row)!.reason);
  if (row.checkout_url && row.stripe_session_id?.startsWith('ch_') && (row.checkout_expires_at ?? 0) > now) {
    return { url: row.checkout_url, id: row.stripe_session_id, planId: row.whop_plan_id ?? null, cached: true };
  }
  const { whopCompanyId, whopApi, whopCheckoutBody, WhopError } = await import('../webinar/whop');
  const companyId = await whopCompanyId(rt);
  const body = whopCheckoutBody(companyId, {
    passId: row.id, kind: row.kind as PassKind, reg: { id: row.reg_id, token: row.ref_id ?? row.reg_id, lead_id: row.lead_id },
    amount: row.amount, currency: row.currency, title: o.title, description: o.description, redirectUrl: o.redirectUrl, metadata: sessionMetadata(row),
  });
  const r = await whopApi<{ id?: string; purchase_url?: string; plan?: { id?: string } }>(rt, 'POST', 'checkout_configurations', body);
  if (!r.id || !r.purchase_url) throw new WhopError(0, 'Whop returned no checkout link');
  const exp = sessionExpiry(row, now);
  await rt.env.DB.prepare("UPDATE webinar_passes SET stripe_session_id = ?, checkout_url = ?, whop_plan_id = ?, checkout_expires_at = ?, provider = 'whop', updated_at = ? WHERE id = ?")
    .bind(r.id, r.purchase_url, r.plan?.id ?? null, exp, now, row.id).run();
  return { url: r.purchase_url, id: r.id, planId: r.plan?.id ?? null, cached: false };
}

export class PayClosed extends Error { constructor(readonly reason: DeadlineReason) { super(PAY_COPY.closed[reason]); } }

/** Whop's embedded checkout for a cached session, prefilled (the documented loader and attributes). */
export const WHOP_LOADER_SRC = 'https://js.whop.com/static/checkout/loader.js';
/** The session's redirect_url (set on the checkout configuration) brings the buyer back to the pay page. */
export function whopEmbedHtml(s: { planId: string; id: string }, p: Prefill | null) {
  const attrs: Record<string, string> = { id: 'whop-embedded-checkout', 'data-whop-checkout-plan-id': s.planId, 'data-whop-checkout-session': s.id, 'data-whop-checkout-theme': 'light', ...whopPrefillAttrs(p) };
  return `<div ${Object.entries(attrs).map(([k, v]) => `${k}="${attr(v)}"`).join(' ')}></div><script src="${WHOP_LOADER_SRC}" defer></script>`;
}

// ───────────── tracking: checkout started, per card ─────────────

/** The funnel registration a purchase belongs to (live, challenge, or the room's attendee), for the stage rows. */
async function regFor(rt: Rt, row: { lead_id: string; reg_id: string; source?: string | null; ref_id?: string | null }) {
  const db = rt.env.DB;
  if (row.source === 'live' && row.ref_id) {
    const r = await db.prepare('SELECT id, event_id FROM live_webinar_regs WHERE event_id = ? AND lead_id = ? LIMIT 1').bind(row.ref_id, row.lead_id).first<{ id: string; event_id: string }>();
    return r ? { funnel: 'live' as const, regId: r.id, cohort: r.event_id } : null;
  }
  if (row.source === 'challenge' && row.ref_id) {
    const r = await db.prepare('SELECT id, cohort_id FROM challenge_registrations WHERE id = ?').bind(row.ref_id).first<{ id: string; cohort_id: string }>();
    return r ? { funnel: 'challenge' as const, regId: r.id, cohort: r.cohort_id } : null;
  }
  if (row.source === 'room' && row.ref_id) {
    const who = /^room:[^:]+:(.+)$/.exec(row.reg_id)?.[1];
    const room = await db.prepare('SELECT ref_type, ref_id FROM rooms WHERE id = ?').bind(row.ref_id).first<{ ref_type: string | null; ref_id: string | null }>();
    const att = who ? await db.prepare('SELECT reg_id FROM room_attendance WHERE room_id = ? AND who = ?').bind(row.ref_id, who).first<{ reg_id: string | null }>() : null;
    if (!room || !att?.reg_id || (room.ref_type !== 'live' && room.ref_type !== 'challenge')) return null;
    const cohort = room.ref_type === 'challenge' ? (/^challenge:([^:]+):/.exec(room.ref_id ?? '')?.[1] ?? room.ref_id) : room.ref_id;
    return { funnel: room.ref_type as 'live' | 'challenge', regId: att.reg_id, cohort };
  }
  return null;
}

/**
 * A checkout started from a card or a link: the attribution stage (once per registration, the card and push in
 * its detail), Meta's InitiateCheckout-mapped custom event through the existing de-duplication (attr_capi, the
 * same key and event id the stage sync uses), and a first-party event per card with the push id.
 */
export async function checkoutStarted(rt: Runtime, row: { id?: string | null; lead_id: string; reg_id: string; kind: string; source?: string | null; ref_id?: string | null; push_id?: number | null }, how: string, now = Date.now()) {
  try {
    const card = row.kind === 'offer' ? 'sprint' : row.kind;
    const reg = await regFor(rt, row);
    const { identityFromLead, track } = await import('../tracking/track');
    await track(rt, await identityFromLead(rt.env, row.lead_id), { name: 'paylink_checkout_started', source: 'server', props: { card, how, push_id: row.push_id ?? null, pass_id: row.id ?? null, source: row.source ?? null, ref_id: row.ref_id ?? null }, localOnly: true }).catch(() => null);
    if (!reg) return false;
    const { recordStage } = await import('../attribution/stages');
    await recordStage(rt, { funnel: reg.funnel, stage: 'checkout_started', leadId: row.lead_id, regId: reg.regId, ts: now, cohortRef: reg.cohort, detail: `${card}${row.push_id != null ? `:push ${row.push_id}` : ''}:${how}`.slice(0, 120), source: 'paylink' });
    const { sendStageEvent } = await import('../attribution/hooks');
    await sendStageEvent(rt, { kind: 'checkout_started', funnel: reg.funnel, regId: reg.regId, leadId: row.lead_id, eventId: `ics-${reg.regId}`.slice(0, 64) });
    return true;
  } catch (e) {
    console.error('paylink checkout started', String(e).slice(0, 200));
    return false;
  }
}

// ───────────── signed personal pay links (emails) ─────────────

export type LinkKind = 'deposit';
export interface PayLinkTarget { leadId: string; kind: LinkKind; source: 'live' | 'challenge'; ref: string }

const b64u = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
const linkSig = async (rt: Pick<Runtime, 'env'>, body: string) => (await hmacHex(await getSecret(rt.env), `paylink|${body}`)).slice(0, 24);

/** A personal, signed link that starts the payment for this person (prefilled, under the offer's real deadline). */
export async function payLinkUrl(rt: Pick<Runtime, 'env' | 'origin'>, t: PayLinkTarget) {
  const body = b64u(JSON.stringify([t.leadId, t.kind, t.source, t.ref]));
  return `${rt.origin}/pay/go/${body}.${await linkSig(rt, body)}`;
}
export async function readPayLink(rt: Pick<Runtime, 'env'>, ref: string): Promise<PayLinkTarget | null> {
  const m = /^([A-Za-z0-9_-]{8,400})\.([0-9a-f]{24})$/.exec(ref ?? '');
  if (!m || !safeEqual(await linkSig(rt, m[1]), m[2])) return null;
  try {
    const [leadId, kind, source, refId] = JSON.parse(unb64u(m[1])) as string[];
    if (kind !== 'deposit' || (source !== 'live' && source !== 'challenge') || !leadId || !refId) return null;
    return { leadId, kind, source, ref: refId };
  } catch { return null; }
}

/** The offer email's link for this lead, when the deposit offer is open for them (else null: the email keeps its room link). */
export async function depositLinkFor(rt: Runtime, o: { leadId: string; source: 'live' | 'challenge'; ref: string }) {
  if (!String((rt.settings as S).WHOP_API_KEY ?? '').trim()) return null;
  return payLinkUrl(rt, { leadId: o.leadId, kind: 'deposit', source: o.source, ref: o.ref });
}

/** GET /pay/go/:ref: starts (or reuses) this person's checkout and opens the pay page. Never one click from an email. */
export async function payLinkRoute(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const t = await readPayLink(rt, c.req.param('ref') ?? '');
  const page = (h: string, b: string, status: 200 | 404 | 410 = 200) => c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${attr(h)}</title><link rel="stylesheet" href="/assets/site.css"></head><body><main class="wrap narrow" style="padding:48px 16px"><h1>${attr(h)}</h1><p>${attr(b)}</p></main></body></html>`, status);
  if (!t) return page('Payment link', PAY_COPY.linkInvalid, 404);
  c.header('cache-control', 'no-store');
  let r: { url?: string; next?: string; paid?: boolean; error?: string } | null = null;
  if (t.source === 'live') {
    const reg = await rt.env.DB.prepare('SELECT * FROM live_webinar_regs WHERE event_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 1').bind(t.ref, t.leadId).first<Record<string, unknown>>();
    if (!reg) return page('Payment link', PAY_COPY.linkInvalid, 404);
    const { roomDeposit } = await import('../live/events');
    r = await roomDeposit(rt, reg as never, { one_click: false, via: 'link' });
  } else {
    const reg = await rt.env.DB.prepare('SELECT * FROM challenge_registrations WHERE id = ? AND lead_id = ?').bind(t.ref, t.leadId).first<Record<string, unknown>>();
    if (!reg) return page('Payment link', PAY_COPY.linkInvalid, 404);
    const { startChallengeDeposit } = await import('../challenge/offer');
    const x = await startChallengeDeposit(rt, reg as never, { oneClick: false, via: 'link' });
    r = x.ok ? { url: x.next, paid: 'paid' in x ? x.paid : false } : { error: x.error };
  }
  const next = r?.url ?? r?.next;
  if (next) return c.redirect(next, 302);
  return page('Payment', r?.error || PAY_COPY.linkInvalid, 410);
}

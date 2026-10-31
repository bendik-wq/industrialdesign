import type { Runtime } from '../app';
import { depositConfig, startDeposit } from '../sales/deposit';
import { identityFromLead, track } from '../tracking/track';
import { type Registration, challengeConfig, getCohort, getDays, money } from './cohorts';
import { challengeTicketCredit, dayUrl } from './payments';
import { eventKey, offerCloseAt, parseEventKey } from './schedule';

/**
 * challenge-offer: the engagement-deposit offer of a cohort, opened by the host live (Day 4 soft offer, Day 5
 * pitch) and closed for good at the cohort's real deadline (Day 5's end + CHALLENGE_OFFER_HOURS).
 *  - State per event key (challenge:<cohort>:<day>) in challenge_offer_state; the host console and Funnel HQ
 *    open or close it, and the day page polls GET /api/live/:key/offer.
 *  - The cohort's offer is open when any of its days has been opened and not closed by hand, and the deadline
 *    hasn't passed. The countdown on every page is to that deadline, and the server refuses after it.
 *  - Builder B's live room has an equivalent table for live events; the two are reconciled at merge.
 */

export interface OfferState { event_key: string; open_at: number | null; closed_at: number | null; updated_at: number }

/** Open or close the offer for one challenge day (host console / Funnel HQ). */
export async function setOffer(rt: Runtime, key: string, open: boolean, now = Date.now()) {
  const k = parseEventKey(key);
  if (!k || (k.day !== 4 && k.day !== 5)) return { ok: false as const, error: 'The offer opens on Day 4 or Day 5 only.' };
  const cohort = await getCohort(rt, k.cohortId);
  if (!cohort) return { ok: false as const, error: 'Cohort not found' };
  const closeAt = offerCloseAt(await getDays(rt, cohort.id), challengeConfig(rt.settings).offerHours);
  if (open && closeAt != null && now >= closeAt) return { ok: false as const, error: 'The cohort’s offer deadline has passed.' };
  await rt.env.DB.prepare(
    `INSERT INTO challenge_offer_state (event_key, open_at, closed_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(event_key) DO UPDATE SET open_at = COALESCE(challenge_offer_state.open_at, excluded.open_at), closed_at = excluded.closed_at, updated_at = excluded.updated_at`,
  ).bind(key, open ? now : null, open ? null : now, now).run();
  return { ok: true as const, state: await cohortOffer(rt, cohort.id, now) };
}

/** Where the cohort's offer stands now. */
export async function cohortOffer(rt: Runtime, cohortId: string, now = Date.now()) {
  const days = await getDays(rt, cohortId);
  const closeAt = offerCloseAt(days, challengeConfig(rt.settings).offerHours);
  const { results } = await rt.env.DB.prepare('SELECT * FROM challenge_offer_state WHERE event_key IN (?, ?)').bind(eventKey(cohortId, 4), eventKey(cohortId, 5)).all<OfferState>();
  return offerStatus(results, closeAt, now);
}

/** Pure: open = some day opened and not closed by hand, before the deadline. */
export function offerStatus(rows: OfferState[], closeAt: number | null, now: number) {
  const opened = rows.filter((r) => r.open_at);
  const live = opened.filter((r) => !r.closed_at);
  const expired = closeAt != null && now >= closeAt;
  const open = live.length > 0 && !expired;
  const openAt = opened.length ? Math.min(...opened.map((r) => r.open_at!)) : null;
  const day = live.map((r) => parseEventKey(r.event_key)?.day ?? 0).sort().pop() ?? null;
  return { open, openAt, closeAt, expired, everOpened: opened.length > 0, day, now };
}

/** GET /api/live/:key/offer (challenge keys): what the day page needs to show or hide the offer. */
export async function offerForKey(rt: Runtime, key: string) {
  const k = parseEventKey(key);
  if (!k) return null;
  const s = await cohortOffer(rt, k.cohortId);
  return { key, open: s.open, openAt: s.openAt, closesAt: s.closeAt, closed: s.expired, soft: s.day === 4, now: s.now };
}

/** The offer block's numbers and words (the deposit and guarantee come from builder B's deposit module). */
export async function offerView(rt: Runtime, reg: Registration) {
  const dep = depositConfig(rt);
  const credit = await challengeTicketCredit(rt, reg.lead_id);
  const paid = await rt.env.DB.prepare('SELECT paid_at FROM challenge_deposits WHERE reg_id = ? AND paid_at IS NOT NULL').bind(reg.id).first();
  return {
    deposit: dep.label,
    cap: dep.cap,
    guarantee: dep.guarantee,
    credit: credit ? money(credit.amount, credit.currency) : null,
    paid: Boolean(paid),
  };
}

/** POST /api/challenge/deposit: start the deposit (one click on the saved card where builder B can, else checkout). */
export async function startChallengeDeposit(rt: Runtime, reg: Registration, o: { oneClick?: boolean; day?: number } = {}, now = Date.now()) {
  if (reg.status !== 'paid') return { ok: false as const, error: 'Pay your challenge ticket first.' };
  const s = await cohortOffer(rt, reg.cohort_id, now);
  if (!s.open) return { ok: false as const, error: s.expired ? 'This offer has closed.' : 'The offer isn’t open yet.' };
  await rt.env.DB.prepare('INSERT INTO challenge_deposits (reg_id, cohort_id, lead_id, started_at) VALUES (?, ?, ?, ?) ON CONFLICT(reg_id) DO NOTHING').bind(reg.id, reg.cohort_id, reg.lead_id, now).run();
  const r = await startDeposit(rt, { leadId: reg.lead_id, source: 'challenge', refId: reg.id, regToken: reg.token, oneClick: o.oneClick !== false, returnUrl: `${dayUrl(rt, reg.token, o.day ?? 5)}?deposit=1` });
  await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'challenge_deposit_started', source: 'server', path: '/challenge', props: { cohort_id: reg.cohort_id, outcome: r.paid ? 'paid' : r.url ? 'checkout' : 'error' }, localOnly: true }).catch(() => null);
  if (r.paid) {
    await recordChallengeDeposit(rt, { refId: reg.id, amount: null, currency: null }, now);
    return { ok: true as const, paid: true, next: `${dayUrl(rt, reg.token, o.day ?? 5)}?deposit=1` };
  }
  if (r.url) return { ok: true as const, next: r.url };
  return { ok: false as const, error: r.error && r.error !== 'stub' ? r.error : 'The deposit checkout didn’t open. Try again, or email the team.' };
}

/**
 * A deposit paid for a challenge registration. Builder B's paid-deposit effect calls this for source
 * 'challenge' with refId = the registration id (to wire at merge); startChallengeDeposit calls it on a one-click success.
 */
export async function recordChallengeDeposit(rt: Runtime, o: { refId: string; amount: number | null; currency: string | null }, now = Date.now()) {
  const dep = depositConfig(rt);
  const amount = o.amount ?? Math.round(dep.amount * 100);
  const currency = (o.currency ?? dep.currency).toLowerCase();
  const reg = await rt.env.DB.prepare('SELECT id, cohort_id, lead_id FROM challenge_registrations WHERE id = ?').bind(o.refId).first<{ id: string; cohort_id: string; lead_id: string }>();
  if (!reg) return false;
  await rt.env.DB.prepare(
    `INSERT INTO challenge_deposits (reg_id, cohort_id, lead_id, started_at, paid_at, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(reg_id) DO UPDATE SET paid_at = COALESCE(challenge_deposits.paid_at, excluded.paid_at), amount = excluded.amount, currency = excluded.currency`,
  ).bind(reg.id, reg.cohort_id, reg.lead_id, now, now, amount, currency).run();
  // The offer emails skip themselves once a deposit is recorded (emails.ts).
  return true;
}

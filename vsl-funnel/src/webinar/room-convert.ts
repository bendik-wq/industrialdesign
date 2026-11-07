import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { getLead } from '../funnel/leads';
import { identityFromLead, track } from '../tracking/track';
import { PAY_COPY } from '../sales/paylinks';
import { type Registration, webinarSettings } from './webinar';

/**
 * The live room's conversion pieces inside the automated masterclass room (recorded, AI and simulive editions):
 *
 *  - The application as an in-room sheet: the same questions, validation, scoring, tier, routing and lead record
 *    as /apply and the live room (saveAnswer + submitApplication, through engage-db's roomQuestions / prefill /
 *    roomVisitor), prefilled from the registration. Its card appears at the edition's pitch minute (the same
 *    position the First Deal Sprint unlocks at; recorded 38:00, the AI edition's own timeline, simulive's first
 *    offer). ROOM_APP_FOLLOWUPS decides whether the application emails go, exactly as in the live room.
 *  - The Sprint's payment sheet: one click on the ticket's saved card stays first (one-click.ts); otherwise
 *    Whop's embedded checkout for a purchase row on the payment-links path (sales/paylinks.ts, sales/pay-page.ts),
 *    prefilled with email and name, under the registration's real offer deadline (the replay close), which the
 *    pay page and the session refuse after. Same gate as every other Sprint checkout (sprintBuyGate).
 *  - Tracking: application shown / opened / started / submitted and checkout started as attribution stage rows
 *    in the auto funnel, and Meta's custom events once per registration through the existing de-duplication.
 */

export type AppStage = 'shown' | 'opened' | 'started';
const APP_STAGES: AppStage[] = ['shown', 'opened', 'started'];

/** Every visible string the masterclass adds for these pieces (checked by auditCopy in the tests). */
export const CONVERT_COPY = {
  appEyebrow: 'Apply to work with Josh’s team',
  appHeading: 'Your application',
  appBody: 'A few questions about your business. Josh’s team reads every answer before anything else happens.',
  appPrefilled: 'What you told us when you registered is already filled in.',
  appButton: 'Start my application',
  appContinue: 'Continue',
  appBack: 'Back',
  appSubmit: 'Send my application',
  appStep: 'Step {i} of {n}',
  appAbout: 'Applying as',
  appDoneHeading: 'Your application is in',
  appDoneBody: 'Josh’s team reads it next and replies by email. Your answers stay with the team.',
  appDoneSprint: 'If you want your first deal mapped out in writing first, the First Deal Sprint is open to you in this room.',
  appDoneBook: 'Pick a time for your strategy call now, while the masterclass is fresh. It takes one tap.',
  appBookButton: 'Book my strategy call',
  appMissing: 'Answer this one to continue.',
  appFailed: 'Your application didn’t send just now. Try again in a moment.',
  appPreview: 'Preview: nothing is saved and no emails go.',
  appSecondary: 'Rather send your application first?',
  progressHeading: 'Your progress',
  progressChapters: '{n} of {total} chapters',
  progressNotes: '{n} key points saved',
  progressNote: '1 key point saved',
  payHeading: 'Start your First Deal Sprint',
  payLoading: 'Opening secure checkout…',
  payCardFields: 'Pay with the card form instead',
  payPreview: 'Preview: Whop’s checkout appears here with the viewer’s email and name filled in. Nothing is charged.',
  payPreviewAs: 'Paying as the viewer’s name and email',
  payTimerLabel: PAY_COPY.timer.replay,
  payClosed: PAY_COPY.closed.replay,
  payWhopNote: PAY_COPY.whopNote,
  payNewTab: PAY_COPY.newTab,
  payTryAgain: 'Try again',
  close: 'Close',
};

const pitchAtSec = (rt: Runtime) => webinarSettings(rt).pitchAtMin * 60;

async function logOnce(rt: Runtime, reg: Registration, key: string, o: { value?: string | null; at?: number | null; replay?: boolean } = {}) {
  // One row per stage per registration (no unique index for this kind: checked first; a rare double is harmless).
  const had = await rt.env.DB.prepare("SELECT 1 FROM webinar_interactions WHERE reg_id = ? AND kind = 'application' AND key = ?").bind(reg.id, key).first();
  if (had) return false;
  await rt.env.DB.prepare(
    `INSERT INTO webinar_interactions (id, reg_id, lead_id, session_id, kind, key, value, at_sec, replay, created_at) VALUES (?, ?, ?, ?, 'application', ?, ?, ?, ?, ?)`,
  ).bind(newId('wi'), reg.id, reg.lead_id, reg.session_id, key, o.value ?? null, o.at == null ? null : Math.max(0, Math.round(o.at)), o.replay ? 1 : 0, Date.now()).run();
  return true;
}

const stageRow = async (rt: Runtime, reg: Registration, stage: string, now: number, o: { key?: string; value?: number | null; detail?: string | null } = {}) => {
  const { recordStage } = await import('../attribution/stages');
  return recordStage(rt, { funnel: 'auto', stage, leadId: reg.lead_id, regId: reg.id, ts: now, cohortRef: reg.session_id, key: o.key ?? null, value: o.value ?? null, detail: o.detail ?? null, source: 'room' }).catch((e) => { console.error('masterclass stage', String(e).slice(0, 200)); return false; });
};

// ───────────── the application ─────────────

/** The application sheet's config for this viewer (null: no lead, already applied, or under $1M, whose path is the worksheet). */
export async function applicationConfig(rt: Runtime, reg: Registration, qualified: boolean, o: { preview?: boolean } = {}) {
  const { roomQuestions, prefill } = await import('../rooms/engage-db');
  const questions = await roomQuestions();
  const base = { atSec: pitchAtSec(rt), questions, copy: CONVERT_COPY };
  if (o.preview) return { ...base, preview: true, answers: { revenue: '3_10m', business: 'Commercial HVAC services, 25 staff' }, name: 'Sample viewer', email: null, submitted: false };
  if (!qualified) return null;
  const p = await prefill(rt, reg.lead_id).catch(() => null);
  if (!p || p.submitted) return null;
  return { ...base, preview: false, answers: p.answers, name: p.name || null, email: p.email ?? null, submitted: false };
}

/** Shown / opened / started, once each per registration: an interaction row and an attribution stage row. */
export async function applicationEvent(rt: Runtime, reg: Registration, body: { stage?: unknown; pos?: unknown; replay?: unknown }, now = Date.now()) {
  const stage = APP_STAGES.find((s) => s === body.stage);
  if (!stage) return { ok: false as const };
  // The card only appears from the pitch minute: an earlier report (claimed or saved position) isn't recorded.
  const at = pitchAtSec(rt) - 60, claimed = Number(body.pos);
  if (!((Number.isFinite(claimed) && claimed >= at) || (reg.max_position ?? 0) >= at)) return { ok: false as const };
  const fresh = await logOnce(rt, reg, stage, { at: Number.isFinite(Number(body.pos)) ? Number(body.pos) : null, replay: body.replay === true });
  if (fresh) {
    await stageRow(rt, reg, 'room_push', now, { key: `masterclass:application:${stage}`, detail: `application:${stage}` });
    await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_application', source: 'server', path: '/webinar', props: { stage }, localOnly: true }).catch(() => null);
  }
  return { ok: true as const };
}

export class AppSubmitError extends Error { constructor(message: string, readonly status: 400 | 403 | 404 | 502 = 400, readonly field?: string) { super(message); } }

/**
 * The application sent from the masterclass room. Same path as the live room's (engage-db submitRoomApplication):
 * each answer through saveAnswer, then submitApplication with ROOM_APP_FOLLOWUPS deciding the emails.
 */
export async function submitMasterclassApplication(rt: Runtime, reg: Registration, body: { answers?: unknown; pos?: unknown; replay?: unknown }, req: Request | null, now = Date.now()) {
  const { roomQuestions, roomVisitor, engageConfig } = await import('../rooms/engage-db');
  const { saveAnswer, submitApplication } = await import('../funnel/application');
  const answers = (body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {}) as Record<string, unknown>;
  if (!(await getLead(rt.env, reg.lead_id))) throw new AppSubmitError(CONVERT_COPY.appFailed, 404);
  const v = await roomVisitor(rt, reg.lead_id, req);
  for (const q of await roomQuestions()) {
    if (answers[q.id] === undefined) continue;
    const lead = await getLead(rt.env, reg.lead_id);
    try { await saveAnswer(rt, v, lead!, q.id, answers[q.id]); } catch (e) { throw new AppSubmitError(e instanceof Error ? e.message : CONVERT_COPY.appMissing, 400, q.id); }
  }
  const lead = (await getLead(rt.env, reg.lead_id))!;
  let result;
  try {
    result = await submitApplication(rt, v, lead, undefined, { followups: engageConfig(rt).followups, path: '/webinar' });
  } catch (e) {
    if ((e as { field?: string }).field) throw new AppSubmitError(e instanceof Error ? e.message : CONVERT_COPY.appMissing, 400, (e as { field?: string }).field);
    console.error('masterclass application', e);
    throw new AppSubmitError(CONVERT_COPY.appFailed, 502);
  }
  await logOnce(rt, reg, 'submitted', { value: JSON.stringify({ tier: result.tier, score: result.score }), at: Number.isFinite(Number(body.pos)) ? Number(body.pos) : null, replay: body.replay === true });
  await stageRow(rt, reg, 'room_push', now, { key: 'masterclass:application:submitted', detail: 'application:submitted' });
  await stageRow(rt, reg, 'room_application', now, { value: result.score, detail: result.tier });
  const { sendStageEvent } = await import('../attribution/hooks');
  await sendStageEvent(rt, { kind: 'room_application', funnel: 'auto', regId: reg.id, leadId: reg.lead_id }).catch(() => null);
  // A and B tiers book straight from the room (one-tap booking on /book, through the registration's handoff link).
  const book = result.tier === 'C' ? null : `${rt.origin}/w/${reg.token}?to=book`;
  return { ok: true as const, tier: result.tier, score: result.score, book };
}

// ───────────── the Sprint's payment sheet ─────────────

/** What the room's Sprint block needs for the sheet: who is paying (prefilled) and whether the sheet is used. */
export async function sprintPayExtras(rt: Runtime, reg: Registration, o: { preview?: boolean } = {}) {
  const { passConfig } = await import('./pass');
  if (passConfig(rt.settings).provider !== 'whop' && !o.preview) return { paySheet: false, payingAs: null };
  const { payingAs, prefillFor } = await import('../sales/paylinks');
  return { paySheet: true, payingAs: o.preview ? null : payingAs(await prefillFor(rt, reg.lead_id)) };
}

type RegLike = Registration & { offer_unlocked_at?: number | null };

/**
 * POST /api/webinar/sprint/pay: Whop's embedded checkout for this registration's Sprint, inside the room.
 * Returns { paid, next } (already bought, or the ticket credit covers it), { fallback } (no Whop: the form and
 * checkout), or the sheet: Whop's plan and session ids, prefill attributes, the hosted link, our card-form pay
 * page, the "paying as" line and the real deadline's timer markup (pay-timer.js counts it down).
 */
export async function sprintPaySheet(rt: Runtime, reg: RegLike, now = Date.now()) {
  const { sprintBuyGate, sprintPrice, ticketCredit, sprintStartUrl, sprintWelcomeUrl } = await import('./sprint');
  const { passCapacity, passCopy, fromMinor, PassError } = await import('./pass');
  const g = await sprintBuyGate(rt, reg, now, 'pay_sheet');
  if (g.paid) return { ok: true as const, paid: true, next: sprintWelcomeUrl(rt, reg.token) };
  const { cfg, bonus, w, r, session } = g;
  if (cfg.provider !== 'whop') return { ok: true as const, fallback: sprintStartUrl(rt, reg.token) };
  const credit = await ticketCredit(rt, r.lead_id, cfg.currency);
  const price = sprintPrice(cfg, null, credit);
  if (price.today <= 0) {
    // The ticket credit covers it: the usual path marks it paid without a charge.
    const { createSprintCheckout } = await import('./sprint');
    await createSprintCheckout(rt, r, { from: 'room' }, now);
    return { ok: true as const, paid: true, next: sprintWelcomeUrl(rt, reg.token) };
  }
  const cap = await passCapacity(rt, cfg, now);
  if (cap.full) throw new PassError(passCopy(cfg).soldOut, 409);
  const deadline = { at: w.deadline, reason: 'replay' as const };
  const { pendingRow, payPageUrl, sessionFor } = await import('../sales/pay-page');
  const id = await pendingRow(rt, {
    kind: 'offer', regId: r.id, leadId: r.lead_id, product: cfg.offerName, amount: price.today, currency: cfg.currency, source: 'auto', refId: session.id,
    returnUrl: sprintWelcomeUrl(rt, r.token), ticketCredit: price.credit, listAmount: cfg.amount, deadline, now,
  });
  // Bought inside the fast-action window: the bonus rides on the purchase row, as with every other Sprint checkout.
  if (bonus && w.bonusOpen) await rt.env.DB.prepare('UPDATE webinar_passes SET fast_bonus = 1 WHERE id = ?').bind(id).run();
  const row = await rt.env.DB.prepare('SELECT * FROM webinar_passes WHERE id = ?').bind(id).first<Parameters<typeof sessionFor>[1]>();
  const payPage = await payPageUrl(rt, id);
  const { payingAs, prefillFor, timerHtml, whopPrefillAttrs, PayClosed } = await import('../sales/paylinks');
  const pf = await prefillFor(rt, r.lead_id);
  let s: { url: string; id: string; planId: string | null; cached: boolean };
  try {
    s = await sessionFor(rt, row!, now);
  } catch (e) {
    if (e instanceof PayClosed) throw new PassError(e.message, 410);
    // Whop refused the session: the card form on our pay page still takes the payment (same row, same deadline).
    return { ok: true as const, fallback: payPage };
  }
  await checkoutStartedAuto(rt, r, { passId: id, how: 'pay_sheet', value: fromMinor(price.today, cfg.currency), cached: s.cached, provider: cfg.provider }, now);
  return {
    ok: true as const,
    sheet: {
      planId: s.planId, sessionId: s.id, hostedUrl: s.url, payPage, prefill: whopPrefillAttrs(pf), payingAs: payingAs(pf),
      timer: timerHtml(deadline, now), deadline: w.deadline, serverNow: now,
    },
  };
}

/** Checkout started from the masterclass room: the auto funnel's stage row (once) and Meta's event (once, same id as the payment links). */
export async function checkoutStartedAuto(rt: Runtime, reg: Registration, o: { passId: string; how: string; value: number; cached: boolean; provider: string | null }, now = Date.now()) {
  if (!o.cached) {
    await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_checkout_started', source: 'server', props: { pass_id: o.passId, kind: 'offer', from: 'room', how: o.how, value: o.value, provider: o.provider }, localOnly: true }).catch(() => null);
  }
  await stageRow(rt, reg, 'checkout_started', now, { detail: `sprint:${o.how}` });
  const { sendStageEvent } = await import('../attribution/hooks');
  await sendStageEvent(rt, { kind: 'checkout_started', funnel: 'auto', regId: reg.id, leadId: reg.lead_id, eventId: `ics-${reg.id}`.slice(0, 64) }).catch(() => null);
}

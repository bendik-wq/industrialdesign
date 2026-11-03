import type { Runtime } from '../app';
import type { Env } from '../env';
import { flag, loadSettings } from '../settings';
import { publicOrigin } from '../app';
import { recordError } from '../infra/errors';
import { type LiveEvent, type LiveMessage, type LiveReg, LIVE_STEP, dueLiveMessages, offerWindow } from './events';
import { type Cadence, type Quiet, duePost } from './lifecycle';

/**
 * The live reminder workflow (Cloudflare Workflows, platform round builder A). Off by default: setting
 * LIVE_REMINDERS_VIA_WORKFLOW, and it needs the LIVE_REMINDER_FLOW binding.
 *
 * On: each new live registration starts one LiveReminderWorkflow instance (instance id = registration id, so a
 * second start is a no-op). Each step re-reads the event, the registration and the lead, then calls the SAME
 * sendDueMessages the cron calls: the same 24h/3h/1h/10m/live/missed and replay rules, quiet hours, cadence,
 * texting hours and the 3-a-day cap, consent, unsubscribe, ticket and deposit gates, and the same once-only
 * claims (sendOnce, the sms_messages unique step), so the workflow and the cron can never both send a message.
 * Then it sleeps until the next moment something could become due (planNextWake, pure and unit-tested), never
 * longer than an hour near the event, so a reschedule, the host opening the offer, a join or a deposit is seen.
 * It stops when the event is cancelled, the registration or lead is gone, the setting is turned off, or the
 * replay and post-event window is over.
 *
 * The cron skips a registration only while its workflow's heartbeat (live_reminder_flows.next_wake_at) is
 * fresh: if a workflow stops or errors, the cron picks the registration up again within 15 minutes.
 * Off: nothing here runs and the cron sends every reminder, exactly as before.
 */

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** The cron's own resolution: the workflow never wakes more often than this. */
export const FLOW_TICK_MS = 5 * MIN;
/** Around the event (3 hours before to 30 minutes after the end) it wakes every 5 minutes, like the cron. */
export const NEAR_BEFORE_MS = 3 * HOUR;
export const NEAR_AFTER_MS = 30 * MIN;
/** The longest sleep: an hour from a day before the event, three hours before that. */
export const CAP_NEAR_MS = HOUR;
export const CAP_FAR_MS = 3 * HOUR;
/** A workflow that has used this many steps hands the registration back to the cron. */
export const FLOW_MAX_ITER = 400;
/** The cron takes a registration back when its workflow is this late for its next wake. */
export const FLOW_STALE_MS = 15 * MIN;

export const flowOn = (rt: Pick<Runtime, 'env' | 'settings'>) => flag((rt.settings as Partial<Record<string, string>>).LIVE_REMINDERS_VIA_WORKFLOW) && Boolean(rt.env.LIVE_REMINDER_FLOW);

// ───────────── the decisions (pure) ─────────────

export interface FlowState {
  ev: Pick<LiveEvent, 'starts_at' | 'duration_min' | 'ended_at' | 'offer_opened_at' | 'offer_closed_at' | 'offer_hours' | 'status'>;
  reg: Pick<LiveReg, 'created_at' | 'joined_at' | 'seq'>;
  offerHours: number;
  tz: string;
  quiet: Quiet | null;
  cadence?: Cadence;
  ticketUnpaid: boolean;
  /** A paid deposit: when (null = none). */
  boughtAt: number | null;
}

/** Everything sendDueMessages could send at `t` (the live messages, then the post-event emails as post:<kind>). */
export function dueKeys(s: FlowState, t: number): string[] {
  const live = dueLiveMessages(s.ev, s.reg, { now: t, ticketUnpaid: s.ticketUnpaid, deposit: s.boughtAt != null, offerHours: s.offerHours, tz: s.tz, quiet: s.quiet, cadence: s.cadence });
  const w = offerWindow(s.ev, t, s.offerHours);
  const post = s.ticketUnpaid ? [] : duePost({ now: t, end: w.end, attended: Boolean(s.reg.joined_at), boughtAt: s.boughtAt, offerOpened: w.opened, offerOpen: w.open, closesAt: w.closesAt, replayClosesAt: w.replayClosesAt });
  return [...live, ...post.map((k) => `post:${k}`)];
}

/** When nothing more can be due for this registration. */
export function flowHorizon(s: FlowState) {
  const w = offerWindow(s.ev, s.ev.starts_at, s.offerHours);
  return Math.max(w.replayClosesAt, s.boughtAt != null ? s.boughtAt + 9 * DAY : 0) + FLOW_TICK_MS;
}

export type FlowPlan = { done: true; reason: string } | { done: false; wakeAt: number };

/**
 * After a step has sent what was due at `now`: whether the workflow is finished, else when to wake next.
 * `retry` are messages due now that failed (they are retried on the cron's 5-minute rhythm, like the cron would).
 */
export function planNextWake(s: FlowState, now: number, retry: string[] = []): FlowPlan {
  if (s.ev.status !== 'scheduled') return { done: true, reason: 'event cancelled' };
  const horizon = flowHorizon(s);
  if (now >= horizon) return { done: true, reason: 'all messages done' };
  const start = s.ev.starts_at;
  const end = offerWindow(s.ev, now, s.offerHours).end;
  const nearFrom = start - NEAR_BEFORE_MS;
  if ((now >= nearFrom && now < end + NEAR_AFTER_MS) || retry.length) return { done: false, wakeAt: now + FLOW_TICK_MS };
  const handled = new Set(dueKeys(s, now));
  const cap = now < start - DAY - 2 * HOUR ? CAP_FAR_MS : CAP_NEAR_MS;
  const limit = Math.min(horizon, now + cap);
  for (let t = now + FLOW_TICK_MS; t < limit; t += FLOW_TICK_MS) {
    if (t >= nearFrom && t < end + NEAR_AFTER_MS) return { done: false, wakeAt: t };
    if (dueKeys(s, t).some((k) => !handled.has(k))) return { done: false, wakeAt: t };
  }
  return { done: false, wakeAt: limit };
}

const STEP_TO_KEY = new Map<number, LiveMessage>(Object.entries(LIVE_STEP).map(([k, v]) => [v, k as LiveMessage]));
/** Live messages due now whose email failed and may be retried (sendOnce retries a failed row up to three attempts). */
export function failedKeys(rows: { step: number; status: string; attempts: number }[], seq: number, due: string[]) {
  return rows
    .filter((r) => r.status === 'failed' && r.attempts < 3 && r.step >= seq * 10 && r.step < (seq + 1) * 10)
    .map((r) => STEP_TO_KEY.get(r.step - seq * 10))
    .filter((k): k is LiveMessage => Boolean(k) && due.includes(k!));
}

// ───────────── one step (re-reads everything, sends with the cron's own function) ─────────────

export interface TickResult { done: boolean; reason?: string; wakeAt?: number; sent: number }

async function runtimeFor(env: Env): Promise<{ rt: Runtime; settle: () => Promise<void> }> {
  const { loadReps } = await import('../sales/reps');
  const [settings, reps] = await Promise.all([loadSettings(env), loadReps(env)]);
  const pending: Promise<unknown>[] = [];
  const rt: Runtime = {
    env, settings, reps, origin: publicOrigin(settings, 'https://example.com'),
    waitUntil: (p) => { pending.push(p.catch((e) => console.error('background task failed', e))); },
  };
  return { rt, settle: async () => { while (pending.length) await Promise.allSettled(pending.splice(0)); } };
}

async function finish(env: Env, regId: string, status: 'done' | 'stopped' | 'failed', reason: string, now: number, sent = 0) {
  await env.DB.prepare('UPDATE live_reminder_flows SET status = ?, reason = ?, steps = steps + 1, sent = sent + ?, next_wake_at = NULL, updated_at = ? WHERE reg_id = ?').bind(status, reason.slice(0, 300), sent, now, regId).run();
}

/** One workflow step for one registration. Safe to repeat (every send is claimed once-only). */
export async function flowTick(env: Env, regId: string, iteration: number, now = Date.now()): Promise<TickResult> {
  const { rt, settle } = await runtimeFor(env);
  if (!flag((rt.settings as Partial<Record<string, string>>).LIVE_REMINDERS_VIA_WORKFLOW)) {
    await finish(env, regId, 'stopped', 'setting turned off: the cron sends the reminders', now);
    return { done: true, reason: 'setting off', sent: 0 };
  }
  const E = await import('./events');
  const reg = await env.DB.prepare('SELECT * FROM live_webinar_regs WHERE id = ?').bind(regId).first<LiveReg>();
  const ev = reg ? await E.getEvent(rt, reg.event_id) : null;
  const { getLead } = await import('../funnel/leads');
  const lead = reg ? await getLead(env, reg.lead_id) : null;
  if (!reg || !ev || !lead) {
    await finish(env, regId, 'done', !reg ? 'registration removed' : !ev ? 'event removed' : 'lead removed', now);
    return { done: true, reason: 'gone', sent: 0 };
  }
  if (ev.status !== 'scheduled') {
    await finish(env, regId, 'done', 'event cancelled', now);
    return { done: true, reason: 'event cancelled', sent: 0 };
  }
  const sent = await E.sendDueMessages(rt, ev, reg, lead, now);
  await settle();

  // The state the next wake is planned from (read after sending).
  const L = await import('./lifecycle-db');
  const { paidDeposit } = await import('../sales/deposit');
  const lc = await L.reminderCtx(rt, ev, reg, lead);
  const deposit = await paidDeposit(rt, reg.lead_id);
  const state: FlowState = {
    ev, reg, offerHours: E.liveSettings(rt).offerHours, tz: lc.tz, quiet: lc.quiet, cadence: lc.cadence,
    ticketUnpaid: await E.ticketGate(rt, reg), boughtAt: deposit ? deposit.paid_at ?? now : null,
  };
  const rows = await env.DB.prepare('SELECT step, status, attempts FROM emails WHERE lead_id = ? AND sequence = ? AND step >= ? AND step < ?')
    .bind(lead.id, lc.seq, reg.seq * 10, (reg.seq + 1) * 10).all<{ step: number; status: string; attempts: number }>();
  const plan = planNextWake(state, now, failedKeys(rows.results ?? [], reg.seq, dueKeys(state, now)));
  if (plan.done) {
    await finish(env, regId, 'done', plan.reason, now, sent);
    return { done: true, reason: plan.reason, sent };
  }
  if (iteration >= FLOW_MAX_ITER - 1) {
    await finish(env, regId, 'stopped', 'step budget used: the cron sends the rest', now, sent);
    return { done: true, reason: 'step budget', sent };
  }
  await env.DB.prepare("UPDATE live_reminder_flows SET status = 'running', reason = NULL, steps = steps + 1, sent = sent + ?, next_wake_at = ?, updated_at = ? WHERE reg_id = ?").bind(sent, plan.wakeAt, now, regId).run();
  return { done: false, wakeAt: plan.wakeAt, sent };
}

/** The minimum of a Workflows step this needs (the real WorkflowStep, or a fake in the tests). */
export interface StepLike {
  do<T>(name: string, config: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
}

const STEP_CONFIG = { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '10 minutes' };

/** LiveReminderWorkflow.run: tick, sleep until the planned moment, repeat. */
export async function runLiveReminderFlow(env: Env, regId: string, step: StepLike) {
  try {
    for (let i = 0; i < FLOW_MAX_ITER; i++) {
      const r = await step.do(`tick ${i}`, STEP_CONFIG, () => flowTick(env, regId, i));
      if (r.done) return { reason: r.reason ?? 'done', steps: i + 1 };
      await step.sleepUntil(`wait ${i}`, r.wakeAt!);
    }
    return { reason: 'step budget', steps: FLOW_MAX_ITER };
  } catch (e) {
    // The cron takes the registration back at once.
    await step.do('mark failed', STEP_CONFIG, async () => {
      await finish(env, regId, 'failed', `error: ${e instanceof Error ? e.message : String(e)}`, Date.now());
      await recordError(env, e, { kind: 'queue', source: 'live reminder workflow' });
      return true;
    }).catch(() => null);
    throw e;
  }
}

// ───────────── start, cron hand-off, Funnel HQ ─────────────

/** On registration (setting on): start the workflow for this registration. Returns whether it was started now. */
export async function startLiveReminderFlow(rt: Runtime, reg: Pick<LiveReg, 'id' | 'event_id'>, now = Date.now()) {
  const wf = rt.env.LIVE_REMINDER_FLOW;
  if (!wf || !flowOn(rt)) return false;
  const claim = await rt.env.DB.prepare("INSERT INTO live_reminder_flows (reg_id, event_id, status, started_at, updated_at) VALUES (?, ?, 'running', ?, ?) ON CONFLICT(reg_id) DO NOTHING")
    .bind(reg.id, reg.event_id, now, now).run();
  if (!claim.meta.changes) return false;
  try {
    await wf.create({ id: reg.id, params: { regId: reg.id } });
    return true;
  } catch (e) {
    if (/already exists|duplicate/i.test(e instanceof Error ? e.message : String(e))) return false;
    // Couldn't start: the cron keeps sending this registration's reminders, as before.
    await rt.env.DB.prepare('DELETE FROM live_reminder_flows WHERE reg_id = ?').bind(reg.id).run().catch(() => null);
    await recordError(rt.env, e, { kind: 'queue', source: 'live reminder workflow: start', rt });
    return false;
  }
}

/** The cron's skip list for one event: registrations whose workflow is running and on time. Empty when off. */
export async function flowSkipSet(rt: Pick<Runtime, 'env' | 'settings'>, eventId: string, now = Date.now()) {
  if (!flowOn(rt)) return new Set<string>();
  const { results } = await rt.env.DB.prepare("SELECT reg_id FROM live_reminder_flows WHERE event_id = ? AND status = 'running' AND COALESCE(next_wake_at, updated_at) > ?")
    .bind(eventId, now - FLOW_STALE_MS).all<{ reg_id: string }>().catch(() => ({ results: [] as { reg_id: string }[] }));
  return new Set(results.map((r) => r.reg_id));
}

/** Funnel HQ: how the workflows are doing (all, and per event when asked). */
export async function flowReport(rt: Pick<Runtime, 'env' | 'settings'>, eventId?: string, now = Date.now()) {
  const where = eventId ? 'WHERE event_id = ?' : '';
  const rows = await rt.env.DB.prepare(`SELECT status, COUNT(*) AS n, SUM(sent) AS sent, SUM(CASE WHEN status = 'running' AND COALESCE(next_wake_at, updated_at) <= ? THEN 1 ELSE 0 END) AS late FROM live_reminder_flows ${where} GROUP BY status`)
    .bind(now - FLOW_STALE_MS, ...(eventId ? [eventId] : [])).all<{ status: string; n: number; sent: number; late: number }>().catch(() => ({ results: [] as { status: string; n: number; sent: number; late: number }[] }));
  const by: Record<string, number> = {};
  let sent = 0, late = 0;
  for (const r of rows.results ?? []) { by[r.status] = Number(r.n); sent += Number(r.sent ?? 0); late += Number(r.late ?? 0); }
  return { on: flag((rt.settings as Partial<Record<string, string>>).LIVE_REMINDERS_VIA_WORKFLOW), bound: Boolean(rt.env.LIVE_REMINDER_FLOW), byStatus: by, sent, late };
}

/** Per registration of one event, for the live event view. */
export async function flowsFor(rt: Pick<Runtime, 'env'>, eventId: string) {
  type Row = { reg_id: string; status: string; reason: string | null; next_wake_at: number | null; steps: number; sent: number };
  const { results } = await rt.env.DB.prepare('SELECT reg_id, status, reason, next_wake_at, steps, sent FROM live_reminder_flows WHERE event_id = ?').bind(eventId)
    .all<Row>().catch(() => ({ results: [] as Row[] }));
  return new Map(results.map((r) => [r.reg_id, r]));
}

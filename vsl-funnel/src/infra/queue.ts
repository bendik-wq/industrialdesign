import type { Runtime } from '../app';
import type { Env } from '../env';
import { flag } from '../settings';
import type { TrackIdentity } from '../tracking/track';
import { describeError, recordError } from './errors';

/**
 * The send queue (Cloudflare Queues, platform round builder A). Off by default: setting SEND_VIA_QUEUE.
 *
 * Off (or without the SEND_QUEUE binding, as in the tests and a bare `wrangler dev`): everything runs exactly as
 * before, inline in the cron and in requests.
 *
 * On: the 5-minute cron hands due emails, texts and AI call dials to the `gl-send` queue instead of sending them
 * itself, and server-side tracking forwards (Meta CAPI, GA4, PostHog, the CRM webhook) go through it instead of
 * running inside the request. The consumer (queue() in src/index.ts → consumeSendBatch) calls the SAME send
 * functions the cron uses (sendEmailRow, sendSmsRow, dialQueuedCall, forwardEvent), so every rule (consent,
 * unsubscribe, quiet hours, caps, stop rules) is unchanged, and each one still claims its row atomically before
 * sending: a redelivered or retried message never sends twice.
 *
 *  - Retries: a provider error the row's own rules would retry (email and text: three attempts) is retried by the
 *    queue with the same backoff; an unexpected error (D1 down, a crash) is retried with backoff up to the
 *    queue's max_retries, then lands in the dead-letter queue `gl-send-dlq`.
 *  - The DLQ consumer records each dead message in `send_jobs` (state dlq) and in the error log (kind "queue"),
 *    and Funnel HQ → Errors & cron lists them with a Retry button.
 *  - Dedupe: `send_jobs` holds one row per job key (kind:id); the cron never queues a row that is already queued
 *    (unless that job went quiet for JOB_STALE_MS, so a lost message can't strand a row).
 */

export type SendKind = 'email' | 'sms' | 'call' | 'track';
export interface ForwardedEventJob { id: string; ts: number; name: string; props: Record<string, unknown>; path: string | null; source?: string }
export type SendJob =
  | { kind: 'email' | 'sms' | 'call'; id: string }
  | { kind: 'track'; id: string; who: TrackIdentity; ev: ForwardedEventJob; origin: string };

export const QUEUE_NAME = 'gl-send';
export const DLQ_NAME = 'gl-send-dlq';
/** Must match wrangler.jsonc queues.consumers[gl-send].max_retries. */
export const MAX_RETRIES = 5;
/** A job still "queued" after this long is treated as lost and may be queued again (rows stay claim-protected). */
export const JOB_STALE_MS = 6 * 3600_000;
/** Done and failed job rows are kept this long (the Queue card's counts), then purged. */
export const JOB_RETENTION_MS = 14 * 86_400_000;

export const jobKey = (j: Pick<SendJob, 'kind' | 'id'>) => `${j.kind}:${j.id}`;

/** SEND_VIA_QUEUE is on and the queue is bound. */
export const queueOn = (rt: Pick<Runtime, 'env' | 'settings'>) => flag((rt.settings as Partial<Record<string, string>>).SEND_VIA_QUEUE) && Boolean(rt.env.SEND_QUEUE);

/** SQL fragment for the cron's due-row selects: leave out rows whose job is already queued (binds: stale cutoff). */
export const NOT_QUEUED_SQL = (kind: SendKind) => ` AND id NOT IN (SELECT ref FROM send_jobs WHERE kind = '${kind}' AND state = 'queued' AND updated_at > ?)`;

/** Backoff for an unexpected consumer error, by the message's delivery attempt (1-based): 30 s, 2 min, 10 min, 30 min, 1 h. */
export function retryDelaySeconds(attempt: number) {
  const steps = [30, 120, 600, 1800, 3600];
  return steps[Math.max(0, Math.min(steps.length - 1, Math.floor(attempt) - 1))];
}
/** A provider error on an email or text: the same backoff the row itself got (10 minutes × attempts), within the queue's 12-hour limit. */
export const rowRetryDelaySeconds = (attempts: number) => Math.min(43_200, 600 * Math.max(1, attempts));

const isKind = (k: unknown): k is SendKind => k === 'email' || k === 'sms' || k === 'call' || k === 'track';
const ID = /^[\w-]{1,80}$/;
/** Message bodies are checked before use (a malformed message is dropped, never sent). */
export function validJob(j: unknown): j is SendJob {
  if (!j || typeof j !== 'object') return false;
  const o = j as Record<string, unknown>;
  if (!isKind(o.kind) || typeof o.id !== 'string' || !ID.test(o.id)) return false;
  if (o.kind !== 'track') return true;
  const ev = o.ev as Record<string, unknown> | undefined;
  return Boolean(o.who && typeof o.who === 'object' && ev && typeof ev.name === 'string' && typeof ev.ts === 'number' && ev.id === o.id && typeof o.origin === 'string');
}

export type EnqueueResult = 'queued' | 'already' | 'unavailable';

/**
 * Hands one job to the queue. 'queued': sent; 'already': this job is already queued (or, with once, was ever
 * queued), so the caller does nothing; 'unavailable': no queue (setting off, binding missing or the send failed),
 * so the caller sends inline exactly as before.
 */
export async function enqueue(rt: Pick<Runtime, 'env' | 'settings'>, job: SendJob, o: { once?: boolean; now?: number } = {}): Promise<EnqueueResult> {
  const q = rt.env.SEND_QUEUE;
  if (!q || !queueOn(rt)) return 'unavailable';
  const now = o.now ?? Date.now();
  const key = jobKey(job);
  const payload = JSON.stringify(job);
  try {
    const claim = await rt.env.DB.prepare(
      `INSERT INTO send_jobs (key, kind, ref, state, attempts, payload, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)
       ON CONFLICT(key) DO ${o.once ? 'NOTHING' : `UPDATE SET state = 'queued', payload = excluded.payload, last_error = NULL, done_at = NULL, updated_at = excluded.updated_at
         WHERE send_jobs.state != 'queued' OR send_jobs.updated_at <= ?`}`,
    ).bind(key, job.kind, job.id, payload, now, now, ...(o.once ? [] : [now - JOB_STALE_MS])).run();
    if (!claim.meta.changes) return 'already';
  } catch (e) {
    console.error('send queue: job claim failed', e);
    return 'unavailable';
  }
  try {
    await q.send(job, { contentType: 'json' });
    return 'queued';
  } catch (e) {
    // The queue refused it: release the claim so the caller sends inline, as before.
    console.error('send queue: send failed', e);
    await rt.env.DB.prepare("UPDATE send_jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE key = ?").bind(`enqueue failed: ${describeError(e).message}`.slice(0, 300), now, key).run().catch(() => null);
    await recordError(rt.env, e, { kind: 'queue', source: `send queue: enqueue ${job.kind}` });
    return 'unavailable';
  }
}

/** The cron's due rows → the queue. Returns the ids the queue did NOT take (send those inline). */
export async function enqueueRows(rt: Pick<Runtime, 'env' | 'settings'>, kind: 'email' | 'sms' | 'call', ids: string[]) {
  const left: string[] = [];
  for (const id of ids) if ((await enqueue(rt, { kind, id })) === 'unavailable') left.push(id);
  return left;
}

// ───────────── the consumer ─────────────

/** What one job's run decided. */
export type JobOutcome = { state: 'done' | 'later' } | { state: 'retry'; error: string; delaySeconds: number } | { state: 'failed'; error: string };

/** Runs one job with the existing send functions (imported lazily: no cycles, and nothing loads when the queue is off). */
export async function runJob(rt: Runtime, job: SendJob): Promise<JobOutcome> {
  const fromRow = (r: unknown): JobOutcome => {
    if (r === 'later') return { state: 'later' };
    if (r && typeof r === 'object' && 'error' in r) {
      const x = r as { error: string; final: boolean; attempts: number };
      return x.final ? { state: 'failed', error: x.error } : { state: 'retry', error: x.error, delaySeconds: rowRetryDelaySeconds(x.attempts) };
    }
    return { state: 'done' }; // sent, skipped by its rules, already taken (busy) or gone
  };
  switch (job.kind) {
    case 'email': return fromRow(await (await import('../integrations/email')).sendEmailById(rt, job.id));
    case 'sms': return fromRow(await (await import('../integrations/sms')).sendSmsById(rt, job.id));
    case 'call': {
      // A failed dial is already a new queued row (retryOrFail), so the queue never re-dials the same row.
      const r = await (await import('../integrations/elevenlabs')).dialCallById(rt, job.id);
      return r === 'later' ? { state: 'later' } : { state: 'done' };
    }
    case 'track': {
      // forwardEvent logs failed deliveries to forward_log, which the cron retries (same event id, so platforms dedupe).
      const { forwardEvent } = await import('../tracking/forward');
      await forwardEvent({ ...rt, origin: job.origin || rt.origin }, job.who, { ...job.ev, source: job.ev.source as never });
      return { state: 'done' };
    }
  }
}

interface QueueMessage<T> { readonly body: T; readonly attempts: number; ack(): void; retry(o?: { delaySeconds?: number }): void }
interface QueueBatch<T> { readonly queue: string; readonly messages: readonly QueueMessage<T>[] }

/** The `gl-send` consumer: one message at a time (the same lead's emails never run side by side). */
export async function consumeSendBatch(rt: Runtime, batch: QueueBatch<unknown>, now: () => number = Date.now) {
  const out = { done: 0, later: 0, retried: 0, failed: 0, dropped: 0 };
  for (const msg of batch.messages) {
    const job = msg.body;
    if (!validJob(job)) { out.dropped++; msg.ack(); continue; }
    const key = jobKey(job);
    const db = rt.env.DB;
    try {
      // Tracking forwards are sent once per event id, whatever the queue redelivers.
      if (job.kind === 'track') {
        const row = await db.prepare('SELECT state FROM send_jobs WHERE key = ?').bind(key).first<{ state: string }>();
        if (row?.state === 'done') { out.done++; msg.ack(); continue; }
      }
      const r = await runJob(rt, job);
      const t = now();
      if (r.state === 'retry') {
        await db.prepare("UPDATE send_jobs SET state = 'queued', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE key = ?").bind(r.error.slice(0, 300), t, key).run();
        out.retried++;
        msg.retry({ delaySeconds: r.delaySeconds });
        continue;
      }
      if (r.state === 'failed') {
        await db.prepare("UPDATE send_jobs SET state = 'failed', last_error = ?, payload = NULL, updated_at = ?, done_at = ? WHERE key = ?").bind(r.error.slice(0, 300), t, t, key).run();
        await recordError(rt.env, new Error(r.error), { kind: 'queue', source: `send queue: ${job.kind} failed after its retries`, rt });
        out.failed++;
        msg.ack();
        continue;
      }
      await db.prepare(
        `INSERT INTO send_jobs (key, kind, ref, state, attempts, created_at, updated_at, done_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET state = excluded.state, payload = NULL, updated_at = excluded.updated_at, done_at = excluded.done_at`,
      ).bind(key, job.kind, job.id, r.state, t, t, r.state === 'done' ? t : null).run();
      if (r.state === 'done') out.done++; else out.later++;
      msg.ack();
    } catch (e) {
      // Unexpected (D1, a crash): retry with backoff; after max_retries the platform moves it to the DLQ.
      const { message } = describeError(e);
      await db.prepare("UPDATE send_jobs SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE key = ?").bind(message.slice(0, 300), now(), key).run().catch(() => null);
      console.error(`send queue: ${key} attempt ${msg.attempts} failed`, message);
      out.retried++;
      msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
    }
  }
  return out;
}

/** The `gl-send-dlq` consumer: keep each dead message (for the Retry button) and log it as an error. */
export async function consumeDeadLetters(rt: Pick<Runtime, 'env'> & Partial<Runtime>, batch: QueueBatch<unknown>, now: () => number = Date.now) {
  let kept = 0;
  for (const msg of batch.messages) {
    const job = msg.body;
    if (!validJob(job)) { msg.ack(); continue; }
    const t = now();
    try {
      await rt.env.DB.prepare(
        `INSERT INTO send_jobs (key, kind, ref, state, attempts, last_error, payload, created_at, updated_at) VALUES (?, ?, ?, 'dlq', ?, 'gave up after its retries', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET state = 'dlq', payload = excluded.payload, updated_at = excluded.updated_at, done_at = NULL`,
      ).bind(jobKey(job), job.kind, job.id, MAX_RETRIES, JSON.stringify(job), t, t).run();
      await recordError(rt.env, new Error(`${job.kind} message gave up after ${MAX_RETRIES} retries and moved to ${DLQ_NAME}`), { kind: 'queue', source: `send queue: dead letter (${job.kind})`, rt: rt.settings ? (rt as Runtime) : null });
      kept++;
      msg.ack();
    } catch (e) {
      console.error('send queue: DLQ write failed', e);
      msg.retry({ delaySeconds: 60 });
    }
  }
  return { kept };
}

// ───────────── Funnel HQ → Errors & cron: the Queue card ─────────────

export interface DeadRow { key: string; kind: string; ref: string; attempts: number; last_error: string | null; updated_at: number }

export async function queueReport(rt: Pick<Runtime, 'env' | 'settings'>, now = Date.now()) {
  const db = rt.env.DB;
  const since = now - 7 * 86_400_000;
  const [counts, dead] = await Promise.all([
    db.prepare(
      `SELECT kind, SUM(state = 'done') AS sent, SUM(state = 'failed') AS failed, SUM(state = 'dlq') AS dlq, SUM(state = 'queued') AS queued,
              SUM(attempts > 0) AS retried FROM send_jobs WHERE updated_at > ? GROUP BY kind`,
    ).bind(since).all<{ kind: string; sent: number; failed: number; dlq: number; queued: number; retried: number }>(),
    db.prepare("SELECT key, kind, ref, attempts, last_error, updated_at FROM send_jobs WHERE state = 'dlq' ORDER BY updated_at DESC LIMIT 50").all<DeadRow>(),
  ]).catch(() => [{ results: [] }, { results: [] }] as [{ results: never[] }, { results: never[] }]);
  const rows = (counts.results ?? []).map((r) => ({ kind: r.kind, sent: Number(r.sent ?? 0), failed: Number(r.failed ?? 0), dlq: Number(r.dlq ?? 0), queued: Number(r.queued ?? 0), retried: Number(r.retried ?? 0) }));
  const sum = (k: 'sent' | 'failed' | 'dlq' | 'queued' | 'retried') => rows.reduce((a, r) => a + r[k], 0);
  return {
    on: flag((rt.settings as Partial<Record<string, string>>).SEND_VIA_QUEUE),
    bound: Boolean(rt.env.SEND_QUEUE),
    days: 7,
    totals: { sent: sum('sent'), failed: sum('failed'), retried: sum('retried'), dlq: sum('dlq'), queued: sum('queued') },
    byKind: rows,
    dead: dead.results ?? [],
  };
}

/** The Retry button on a dead-lettered job: back on the queue (its row is still claim-protected, so it can't double-send). */
export async function retryDead(rt: Pick<Runtime, 'env' | 'settings'>, key: string, now = Date.now()) {
  const q = rt.env.SEND_QUEUE;
  if (!q) return { ok: false as const, error: 'The send queue isn’t bound to this Worker.' };
  const row = await rt.env.DB.prepare("SELECT payload FROM send_jobs WHERE key = ? AND state = 'dlq'").bind(key).first<{ payload: string | null }>();
  if (!row?.payload) return { ok: false as const, error: 'That message isn’t in the dead-letter list any more.' };
  let job: unknown;
  try { job = JSON.parse(row.payload); } catch { job = null; }
  if (!validJob(job)) return { ok: false as const, error: 'That message can’t be read.' };
  const claim = await rt.env.DB.prepare("UPDATE send_jobs SET state = 'queued', last_error = NULL, updated_at = ? WHERE key = ? AND state = 'dlq'").bind(now, key).run();
  if (!claim.meta.changes) return { ok: false as const, error: 'Someone retried it already.' };
  try {
    await q.send(job, { contentType: 'json' });
  } catch (e) {
    await rt.env.DB.prepare("UPDATE send_jobs SET state = 'dlq', last_error = ?, updated_at = ? WHERE key = ?").bind(`retry failed: ${describeError(e).message}`.slice(0, 300), now, key).run();
    return { ok: false as const, error: 'The queue refused it. Try again in a minute.' };
  }
  return { ok: true as const };
}

/** Cron (only while the queue is on): drop old finished job rows. */
export async function purgeSendJobs(env: Pick<Env, 'DB'>, now = Date.now()) {
  const r = await env.DB.prepare("DELETE FROM send_jobs WHERE state IN ('done', 'failed', 'later') AND updated_at < ?").bind(now - JOB_RETENTION_MS).run();
  return { purged: r.meta.changes };
}

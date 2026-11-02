import type { Env } from '../env';
import { sha256 } from './crypto';

/**
 * Inbound webhook bookkeeping (table webhook_events, migration 0064): one row per provider event, so a
 * provider's retry of an event we already handled is answered 2xx without running it again, a delivery that
 * failed half-way runs again on the provider's retry, and two copies arriving at once can't both run.
 *
 * Status: processing (a request is running it) | done | failed (the provider's retry runs it again) |
 * queued (stored for background processing; the cron retries it until done, see retryQueued).
 */

export type WebhookProvider = 'resend' | 'resend-inbound' | 'calendly' | 'elevenlabs' | 'instagram' | 'whatsapp' | 'zapier';
type Db = Pick<Env, 'DB'>;

/** A run that started this long ago and never finished (the isolate died) may be claimed again. */
export const STALE_MS = 2 * 60_000;
/** Background (queued) events are retried at most this many times by the cron. */
export const MAX_ATTEMPTS = 6;
/** Done rows are kept this long (long enough for any provider's retry window: Meta retries for up to 36 hours). */
export const KEEP_MS = 14 * 86_400_000;

export const eventKey = (provider: WebhookProvider, eventId: string) => `${provider}:${eventId.slice(0, 200)}`;
/** An id for providers that don't send one (Meta, Zapier): the hash of the exact body. Retries resend the same bytes. */
export const bodyId = async (raw: string) => `sha256:${(await sha256(raw)).slice(0, 40)}`;

export type Claim =
  | { run: true; key: string; attempt: number }
  | { run: false; key: string; reason: 'duplicate' | 'in_progress' };

/**
 * Claims an event before handling it. `windowMs`: a finished event older than this is treated as new (for
 * body-hash ids, where the same content sent again much later is a new action, e.g. the same Zapier note next week).
 */
export async function claimEvent(env: Db, provider: WebhookProvider, eventId: string, o: { kind?: string | null; now?: number; windowMs?: number } = {}): Promise<Claim> {
  const now = o.now ?? Date.now();
  const key = eventKey(provider, eventId);
  const ins = await env.DB.prepare(
    "INSERT INTO webhook_events (id, provider, event_id, kind, status, attempts, received_at, updated_at) VALUES (?, ?, ?, ?, 'processing', 1, ?, ?) ON CONFLICT(id) DO NOTHING",
  ).bind(key, provider, eventId.slice(0, 200), o.kind?.slice(0, 60) ?? null, now, now).run();
  if (ins.meta?.changes) return { run: true, key, attempt: 1 };
  // Seen before: run it again only when the earlier run failed, died, or (with a window) finished long ago.
  const again = await env.DB.prepare(
    `UPDATE webhook_events SET status = 'processing', attempts = attempts + 1, error = NULL, updated_at = ?1, received_at = CASE WHEN status = 'done' THEN ?1 ELSE received_at END
     WHERE id = ?2 AND (status = 'failed' OR (status IN ('processing', 'queued') AND updated_at < ?3) OR (status = 'done' AND ?4 > 0 AND received_at < ?1 - ?4))`,
  ).bind(now, key, now - STALE_MS, o.windowMs ?? 0).run();
  if (again.meta?.changes) {
    const row = await env.DB.prepare('SELECT attempts FROM webhook_events WHERE id = ?').bind(key).first<{ attempts: number }>();
    return { run: true, key, attempt: row?.attempts ?? 2 };
  }
  const row = await env.DB.prepare('SELECT status FROM webhook_events WHERE id = ?').bind(key).first<{ status: string }>();
  return { run: false, key, reason: row?.status === 'done' ? 'duplicate' : 'in_progress' };
}

export async function finishEvent(env: Db, key: string, error?: unknown, now = Date.now()) {
  const msg = error === undefined ? null : String(error instanceof Error ? error.message : error).slice(0, 500);
  await env.DB.prepare(`UPDATE webhook_events SET status = ?, error = ?, payload = CASE WHEN ? = 'done' THEN NULL ELSE payload END, done_at = CASE WHEN ? = 'done' THEN ? ELSE done_at END, updated_at = ? WHERE id = ?`)
    .bind(msg === null ? 'done' : 'failed', msg, msg === null ? 'done' : 'failed', msg === null ? 'done' : 'failed', now, now, key).run();
}

/**
 * Claim, run, record. Returns the handler's result, or { duplicate } when it was already handled (answer 2xx),
 * or { inProgress } when another copy is running right now (answer 409 so the provider tries again later).
 * A handler that throws marks the event failed and rethrows (the route answers 5xx; the provider retries).
 */
export async function onceOnly<T>(env: Db, provider: WebhookProvider, eventId: string, fn: () => Promise<T>, o: { kind?: string | null; windowMs?: number } = {}):
  Promise<{ ran: true; result: T } | { ran: false; duplicate: boolean; inProgress: boolean }> {
  const c = await claimEvent(env, provider, eventId, o);
  if (!c.run) return { ran: false, duplicate: c.reason === 'duplicate', inProgress: c.reason === 'in_progress' };
  try {
    const result = await fn();
    await finishEvent(env, c.key);
    return { ran: true, result };
  } catch (e) {
    await finishEvent(env, c.key, e).catch(() => null);
    throw e;
  }
}

/**
 * Stores an event durably before acknowledging it; the work runs afterwards (waitUntil) and, when that fails
 * or the isolate dies, the cron's retryQueued picks it up. Returns false for a duplicate (already stored).
 */
export async function enqueueEvent(env: Db, provider: WebhookProvider, eventId: string, payload: string, now = Date.now()) {
  const key = eventKey(provider, eventId);
  const r = await env.DB.prepare(
    "INSERT INTO webhook_events (id, provider, event_id, status, attempts, payload, received_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  ).bind(key, provider, eventId.slice(0, 200), payload, now, now).run();
  return { key, fresh: Boolean(r.meta?.changes) };
}

/** Runs one queued event (marks the attempt first, so a crash mid-way counts). */
export async function runQueued(env: Db, key: string, fn: () => Promise<unknown>, now = Date.now()) {
  await env.DB.prepare("UPDATE webhook_events SET attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')").bind(now, key).run();
  try {
    await fn();
    await finishEvent(env, key);
    return true;
  } catch (e) {
    await env.DB.prepare("UPDATE webhook_events SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(String((e as Error)?.message ?? e).slice(0, 500), Date.now(), key).run().catch(() => null);
    return false;
  }
}

export type QueuedHandler = (payload: string) => Promise<unknown>;

/**
 * From the cron: background events that never finished (failed, or still queued after STALE_MS because the
 * isolate died) run again, up to MAX_ATTEMPTS each. Old finished rows are deleted (they only exist for dedupe).
 */
export async function retryQueued(env: Db, handlers: Partial<Record<WebhookProvider, QueuedHandler>>, now = Date.now(), limit = 25) {
  const providers = Object.keys(handlers);
  if (!providers.length) return { retried: 0, ok: 0, pruned: 0 };
  const rows = (await env.DB.prepare(
    `SELECT id, provider, payload FROM webhook_events WHERE status IN ('queued', 'failed') AND updated_at < ? AND payload IS NOT NULL AND attempts < ?
     AND provider IN (${providers.map(() => '?').join(',')}) ORDER BY updated_at LIMIT ?`,
  ).bind(now - STALE_MS, MAX_ATTEMPTS, ...providers, limit).all<{ id: string; provider: WebhookProvider; payload: string }>()).results;
  let ok = 0;
  for (const r of rows) if (await runQueued(env, r.id, () => handlers[r.provider]!(r.payload), now)) ok++;
  const pruned = await env.DB.prepare("DELETE FROM webhook_events WHERE id IN (SELECT id FROM webhook_events WHERE status = 'done' AND updated_at < ? LIMIT 2000)").bind(now - KEEP_MS).run();
  return { retried: rows.length, ok, pruned: pruned.meta?.changes ?? 0 };
}

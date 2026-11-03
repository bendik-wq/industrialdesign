import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import type { VisitorCtx } from '../src/lib/identity';
import { SETTINGS as SETTING_DEFS } from '../src/settings';
import { processEmailQueue } from '../src/integrations/email';
import { processSmsQueue } from '../src/integrations/sms';
import { processCallQueue } from '../src/integrations/elevenlabs';
import { track } from '../src/tracking/track';
import { auditCopy } from '../src/content/copy-rules';
import {
  JOB_STALE_MS, MAX_RETRIES, consumeDeadLetters, consumeSendBatch, enqueue, queueReport, retryDead, retryDelaySeconds, rowRetryDelaySeconds, validJob,
} from '../src/infra/queue';
import {
  CAP_FAR_MS, CAP_NEAR_MS, FLOW_STALE_MS, FLOW_TICK_MS, type FlowState, dueKeys, failedKeys, flowHorizon, flowReport, flowSkipSet, flowTick, planNextWake, runLiveReminderFlow,
  startLiveReminderFlow,
} from '../src/live/reminder-flow';
import { type LiveEvent, type LiveReg, processLiveMessages, registerLive, saveEvent } from '../src/live/events';
import { DEFAULT_CADENCE, parseQuiet } from '../src/live/lifecycle';

// ───────────── a real SQLite database shaped like D1, with every migration applied ─────────────
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };
let failWhen: ((sql: string) => boolean) | null = null;
function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const check = () => { if (failWhen?.(sql)) throw new Error('D1_ERROR: database is locked'); };
    const st = {
      sql,
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => { check(); return (db.prepare(sql).get(...norm()) as T | undefined) ?? null; },
      all: async <T>() => { check(); return { results: db.prepare(sql).all(...norm()) as T[] }; },
      run: async () => { check(); const r = db.prepare(sql).run(...norm()); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-03T15:00:00Z');
const ALL = () => Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ''])) as Record<string, string>;
const at = (t: number) => vi.setSystemTime(t);
let db: DatabaseSync;
const pending: Promise<unknown>[] = [];
const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as (string | number | null)[]));

/** A fake Queue binding: what was sent. */
const fakeQueue = () => { const sent: unknown[] = []; return { sent, send: vi.fn(async (b: unknown) => { sent.push(JSON.parse(JSON.stringify(b))); }) }; };
let queue: ReturnType<typeof fakeQueue>;
const makeRt = (s: Record<string, string> = {}, env: Record<string, unknown> = {}) =>
  ({ env: { DB: d1(db), SESSION_SECRET: 'test-session-secret', SEND_QUEUE: queue, ...env }, settings: { ...ALL(), RESEND_API_KEY: 're_testkey123', EMAIL_FROM: 'Josh <josh@example.com>', SITE_NAME: 'G&L', ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => null)); } }) as unknown as Runtime;

/** A fake message: what the consumer did with it. */
function msg(body: unknown, attempts = 1) {
  const m = { body, attempts, acked: 0, retried: [] as (number | undefined)[], ack() { m.acked++; }, retry(o?: { delaySeconds?: number }) { m.retried.push(o?.delaySeconds); } };
  return m;
}
const batch = (msgs: ReturnType<typeof msg>[], name = 'gl-send') => ({ queue: name, messages: msgs });

let calls: { url: string; body: string }[] = [];
let resendStatus = 200;
beforeAll(async () => { await import('../src/index'); }, 60_000);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(T0);
  db = freshDb();
  queue = fakeQueue();
  failWhen = null;
  calls = [];
  resendStatus = 200;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: string } = {}) => {
    calls.push({ url: String(url), body: String(init.body ?? '') });
    if (String(url).includes('api.resend.com')) return new Response(JSON.stringify(resendStatus === 200 ? { id: `re_${calls.length}` } : { message: 'server error' }), { status: resendStatus, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); pending.length = 0; failWhen = null; });

const resendCalls = () => calls.filter((c) => c.url.includes('api.resend.com')).length;
function seedEmail(id = 'm1', leadId = 'l1') {
  x("INSERT OR IGNORE INTO leads (id, ref_code, created_at, updated_at, first_name, email, status) VALUES (?, ?, ?, ?, 'Dana', ?, 'partial')", leadId, `R${leadId}`, T0 - DAY, T0 - DAY, `${leadId}@example.com`);
  x("INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at) VALUES (?, ?, 'abandoned', 0, 'abandon_1', ?, ?, 'pending', ?)", id, leadId, `${leadId}@example.com`, T0 - MIN, T0 - HOUR);
}
const emailRow = (id = 'm1') => q<{ status: string; attempts: number }>('SELECT status, attempts FROM emails WHERE id = ?', id)[0];
const job = (key: string) => q<{ state: string; attempts: number; last_error: string | null; payload: string | null }>('SELECT state, attempts, last_error, payload FROM send_jobs WHERE key = ?', key)[0];

// ───────────── off: nothing changes ─────────────

describe('send queue off (the default): everything sends inline, exactly as before', () => {
  it('the email cron sends inline even with the queue bound, and writes no job rows', async () => {
    seedEmail();
    const r = await processEmailQueue(makeRt());
    expect(r).toEqual({ due: 1, sent: 1 });
    expect(resendCalls()).toBe(1);
    expect(emailRow().status).toBe('sent');
    expect(queue.send).not.toHaveBeenCalled();
    expect(q('SELECT * FROM send_jobs')).toEqual([]);
  });
  it('on without the binding (tests, bare wrangler dev): still inline', async () => {
    seedEmail();
    const r = await processEmailQueue(makeRt({ SEND_VIA_QUEUE: 'on' }, { SEND_QUEUE: undefined }));
    expect(r).toEqual({ due: 1, sent: 1 });
    expect(resendCalls()).toBe(1);
    expect(await enqueue(makeRt({ SEND_VIA_QUEUE: 'on' }, { SEND_QUEUE: undefined }), { kind: 'email', id: 'm1' })).toBe('unavailable');
  });
  it('tracking forwards run inside the request when off', async () => {
    const rt = makeRt({ POSTHOG_KEY: 'phc_test' });
    await track(rt, { visitorId: 'v1', sessionId: null, leadId: null }, { name: 'page_view', source: 'server', path: '/' });
    await flush();
    expect(calls.some((c) => c.url.includes('posthog'))).toBe(true);
    expect(queue.send).not.toHaveBeenCalled();
  });
  it('the SMS and AI call crons do not touch the queue when off', async () => {
    const rt = makeRt({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_AGENT_ID: 'a', ELEVENLABS_PHONE_NUMBER_ID: 'p' });
    await processSmsQueue(rt);
    await processCallQueue(rt);
    expect(queue.send).not.toHaveBeenCalled();
  });
});

// ───────────── on: the cron enqueues, the consumer sends once ─────────────

describe('send queue on: cron → queue → consumer', () => {
  const on = (s: Record<string, string> = {}) => makeRt({ SEND_VIA_QUEUE: 'on', ...s });

  it('the cron hands due emails to the queue (sends nothing itself) and never queues the same row twice', async () => {
    seedEmail('m1'); seedEmail('m2', 'l2');
    const r = await processEmailQueue(on());
    expect(r).toEqual({ due: 2, sent: 0, queued: 2 });
    expect(resendCalls()).toBe(0);
    expect(queue.sent).toEqual([{ kind: 'email', id: 'm1' }, { kind: 'email', id: 'm2' }]);
    expect(emailRow('m1').status).toBe('pending'); // still pending while queued: a cancel or unsubscribe still applies
    at(T0 + 5 * MIN);
    expect(await processEmailQueue(on())).toEqual({ due: 0, sent: 0 });
    expect(queue.sent).toHaveLength(2);
    // A job that went quiet past JOB_STALE_MS is queued again (the row's claim still protects it).
    at(T0 + JOB_STALE_MS + MIN);
    await processEmailQueue(on());
    expect(queue.sent).toHaveLength(4);
  });

  it('the consumer sends with the same function, and a redelivered message never sends twice', async () => {
    seedEmail();
    await processEmailQueue(on());
    const m1 = msg(queue.sent[0]);
    expect(await consumeSendBatch(on(), batch([m1]))).toMatchObject({ done: 1 });
    expect(m1.acked).toBe(1);
    expect(resendCalls()).toBe(1);
    expect(emailRow().status).toBe('sent');
    expect(job('email:m1')).toMatchObject({ state: 'done', payload: null });
    // At-least-once delivery: the same message again, twice in one batch.
    const again = [msg(queue.sent[0], 2), msg(queue.sent[0], 1)];
    await consumeSendBatch(on(), batch(again));
    expect(resendCalls()).toBe(1);
    expect(again.every((m) => m.acked === 1 && !m.retried.length)).toBe(true);
  });

  it('the consumer re-checks the rules: an unsubscribe after queueing skips the email', async () => {
    seedEmail();
    await processEmailQueue(on());
    x("UPDATE leads SET unsubscribed_at = ? WHERE id = 'l1'", T0);
    await consumeSendBatch(on(), batch([msg(queue.sent[0])]));
    expect(resendCalls()).toBe(0);
    expect(q("SELECT status, error FROM emails WHERE id = 'm1'")).toEqual([{ status: 'skipped', error: 'unsubscribed' }]);
  });

  it('a row moved later after it was queued waits (state later) and the cron queues it again when due', async () => {
    seedEmail();
    await processEmailQueue(on());
    x("UPDATE emails SET send_at = ? WHERE id = 'm1'", T0 + HOUR);
    await consumeSendBatch(on(), batch([msg(queue.sent[0])]));
    expect(resendCalls()).toBe(0);
    expect(job('email:m1').state).toBe('later');
    at(T0 + HOUR + MIN);
    await processEmailQueue(on());
    expect(queue.sent).toHaveLength(2);
  });

  it('a provider error is retried by the queue with the row’s own backoff, then sent once', async () => {
    seedEmail();
    await processEmailQueue(on());
    resendStatus = 500;
    const m = msg(queue.sent[0]);
    expect(await consumeSendBatch(on(), batch([m]))).toMatchObject({ retried: 1 });
    expect(m.retried).toEqual([rowRetryDelaySeconds(1)]);
    expect(m.acked).toBe(0);
    expect(emailRow()).toEqual({ status: 'pending', attempts: 1 });
    expect(job('email:m1')).toMatchObject({ state: 'queued', attempts: 1 });
    // While the queue holds it, the cron leaves it alone.
    at(T0 + 11 * MIN);
    await processEmailQueue(on());
    expect(queue.sent).toHaveLength(1);
    resendStatus = 200;
    const m2 = msg(queue.sent[0], 2);
    await consumeSendBatch(on(), batch([m2]));
    expect(m2.acked).toBe(1);
    expect(resendCalls()).toBe(2); // one failed call, one sent
    expect(emailRow()).toEqual({ status: 'sent', attempts: 2 });
  });

  it('after the row’s last attempt the job is failed, logged as a queue error, and acked (no endless retries)', async () => {
    seedEmail();
    await processEmailQueue(on());
    resendStatus = 500;
    for (let i = 1; i <= 3; i++) {
      at(T0 + i * HOUR);
      const m = msg(queue.sent[0], i);
      await consumeSendBatch(on(), batch([m]));
      if (i < 3) expect(m.retried).toHaveLength(1); else expect(m.acked).toBe(1);
    }
    expect(emailRow().status).toBe('failed');
    expect(job('email:m1').state).toBe('failed');
    expect(q<{ kind: string; source: string }>('SELECT kind, source FROM app_errors')).toEqual([{ kind: 'queue', source: 'send queue: email failed after its retries' }]);
    expect(resendCalls()).toBe(3);
  });

  it('an unexpected error retries with backoff, then the DLQ keeps it; Retry puts it back and it sends once', async () => {
    seedEmail();
    await processEmailQueue(on());
    failWhen = (sql) => sql.includes('FROM emails WHERE id = ?');
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const m = msg(queue.sent[0], attempt);
      await consumeSendBatch(on(), batch([m]));
      expect(m.retried).toEqual([retryDelaySeconds(attempt)]);
    }
    expect(job('email:m1')).toMatchObject({ state: 'queued', attempts: MAX_RETRIES, last_error: 'D1_ERROR: database is locked' });
    // The platform moves it to gl-send-dlq; that consumer keeps it and logs it.
    const dead = msg(queue.sent[0]);
    expect(await consumeDeadLetters(on(), batch([dead], 'gl-send-dlq'))).toEqual({ kept: 1 });
    expect(dead.acked).toBe(1);
    expect(job('email:m1').state).toBe('dlq');
    expect(q<{ kind: string }>('SELECT kind FROM app_errors').map((r) => r.kind)).toEqual(['queue']);
    const report = await queueReport(on());
    expect(report.totals).toMatchObject({ dlq: 1 });
    expect(report.dead.map((d) => d.key)).toEqual(['email:m1']);
    expect(resendCalls()).toBe(0);
    // Retry (admin): back on the queue; a second click finds nothing to retry.
    failWhen = null;
    expect(await retryDead(on(), 'email:m1')).toEqual({ ok: true });
    expect(await retryDead(on(), 'email:m1')).toMatchObject({ ok: false });
    expect(queue.sent).toHaveLength(2);
    await consumeSendBatch(on(), batch([msg(queue.sent[1])]));
    await consumeSendBatch(on(), batch([msg(queue.sent[1])]));
    expect(resendCalls()).toBe(1);
    expect(emailRow().status).toBe('sent');
    expect((await queueReport(on())).totals).toMatchObject({ dlq: 0, sent: 1, retried: 1 });
  });

  it('when the queue refuses a send, the cron sends that row inline as before', async () => {
    seedEmail();
    queue.send.mockRejectedValueOnce(new Error('queue unavailable'));
    const r = await processEmailQueue(on());
    expect(r).toEqual({ due: 1, sent: 1 });
    expect(resendCalls()).toBe(1);
    expect(job('email:m1').state).toBe('failed');
  });

  it('tracking forwards: queued once per event id, forwarded once however often the message arrives', async () => {
    const rt = on({ POSTHOG_KEY: 'phc_test' });
    const id = await track(rt, { visitorId: 'v1', sessionId: null, leadId: null }, { name: 'page_view', source: 'server', path: '/', eventId: 'evt_abcdef12' });
    await flush();
    expect(calls.filter((c) => c.url.includes('posthog'))).toHaveLength(0);
    expect(queue.sent).toEqual([expect.objectContaining({ kind: 'track', id, origin: 'https://apply.test' })]);
    expect(validJob(queue.sent[0])).toBe(true);
    await consumeSendBatch(rt, batch([msg(queue.sent[0]), msg(queue.sent[0], 2)]));
    expect(calls.filter((c) => c.url.includes('posthog'))).toHaveLength(1);
    // The same client event id again (a page retry) is not queued a second time.
    await track(rt, { visitorId: 'v1', sessionId: null, leadId: null }, { name: 'page_view', source: 'server', path: '/', eventId: 'evt_abcdef12' });
    await flush();
    expect(queue.sent).toHaveLength(1);
  });

  it('texts and AI call dials go through the queue; the consumer applies the same consent rules', async () => {
    const rt = on({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_AGENT_ID: 'a', ELEVENLABS_PHONE_NUMBER_ID: 'p' });
    x("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, phone, status) VALUES ('l9', 'R9', ?, ?, 'Sam', 's@example.com', '+12125550100', 'applied')", T0, T0);
    x("INSERT INTO sms_messages (id, lead_id, direction, sequence, step, template, to_phone, send_at, status, attempts, created_at) VALUES ('sm1', 'l9', 'out', 'abandoned', 0, 't', '+12125550100', ?, 'pending', 0, ?)", T0 - MIN, T0);
    x("INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, attempts, created_at, updated_at) VALUES ('oc1', 'l9', 'speed_to_lead', 'queued', ?, 0, ?, ?)", T0 - MIN, T0, T0);
    expect(await processSmsQueue(rt)).toMatchObject({ queued: 1 });
    expect(await processCallQueue(rt)).toMatchObject({ dialed: 0 });
    expect(queue.sent).toEqual([{ kind: 'sms', id: 'sm1' }, { kind: 'call', id: 'oc1' }]);
    await consumeSendBatch(rt, batch(queue.sent.map((b) => msg(b))));
    // No call consent: skipped by blockReason, never dialled; the text follows its own sequence rules.
    expect(q("SELECT status, error FROM outbound_calls WHERE id = 'oc1'")).toEqual([{ status: 'skipped', error: 'no call consent' }]);
    expect(calls.filter((c) => c.url.includes('elevenlabs'))).toHaveLength(0);
    expect(q<{ status: string }>("SELECT status FROM sms_messages WHERE id = 'sm1'")[0].status).not.toBe('pending');
    expect(job('call:oc1').state).toBe('done');
  });

  it('malformed messages are dropped, never sent', async () => {
    const bad = [msg({ kind: 'email' }), msg({ kind: 'nope', id: 'x12345' }), msg('hi'), msg({ kind: 'email', id: 'a b' }), msg({ kind: 'track', id: 'e12345', who: {}, ev: { id: 'other', ts: 1, name: 'x' }, origin: 'o' })];
    expect(await consumeSendBatch(on(), batch(bad))).toMatchObject({ dropped: 5 });
    expect(bad.every((m) => m.acked === 1)).toBe(true);
  });

  it('backoff steps and the settings copy', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelaySeconds)).toEqual([30, 120, 600, 1800, 3600, 3600]);
    expect(rowRetryDelaySeconds(2)).toBe(1200);
    expect(rowRetryDelaySeconds(999)).toBe(43_200);
    for (const k of ['SEND_VIA_QUEUE', 'LIVE_REMINDERS_VIA_WORKFLOW']) {
      const d = SETTING_DEFS.find((s) => s.key === k) as { label: string; help?: string };
      expect(d).toBeTruthy();
      expect(auditCopy(`${d.label}. ${d.help}`)).toEqual([]);
    }
  });
});

// ───────────── the live reminder workflow: decisions (pure) ─────────────

const START = Date.parse('2026-11-10T20:00:00Z'); // 15:00 in New York
const state = (o: Partial<FlowState> = {}, ev: Partial<FlowState['ev']> = {}, reg: Partial<FlowState['reg']> = {}): FlowState => ({
  ev: { starts_at: START, duration_min: 120, ended_at: null, offer_opened_at: null, offer_closed_at: null, offer_hours: null, status: 'scheduled', ...ev },
  reg: { created_at: START - 3 * DAY, joined_at: null, seq: 0, ...reg },
  offerHours: 48, tz: 'America/New_York', quiet: null, cadence: DEFAULT_CADENCE, ticketUnpaid: false, boughtAt: null, ...o,
});

describe('live reminder workflow: when to wake (pure)', () => {
  it('far out it sleeps at most three hours, from a day before at most an hour, and lands on each reminder’s moment', () => {
    const s = state();
    expect(planNextWake(s, START - 3 * DAY)).toEqual({ done: false, wakeAt: START - 3 * DAY + CAP_FAR_MS });
    expect(planNextWake(s, START - DAY - 30 * MIN)).toEqual({ done: false, wakeAt: START - DAY }); // the 24-hour reminder
    expect(planNextWake(s, START - 20 * HOUR)).toEqual({ done: false, wakeAt: START - 20 * HOUR + CAP_NEAR_MS });
  });
  it('around the event it wakes every 5 minutes, like the cron', () => {
    const s = state();
    for (const t of [START - 3 * HOUR, START - 10 * MIN, START, START + 2 * HOUR + 25 * MIN]) expect(planNextWake(s, t)).toEqual({ done: false, wakeAt: t + FLOW_TICK_MS });
    expect(planNextWake(s, START - 4 * HOUR + 20 * MIN)).toEqual({ done: false, wakeAt: START - 3 * HOUR });
  });
  it('after the event it wakes for the replay and the post-event emails, then finishes at the horizon', () => {
    const s = state();
    const end = START + 2 * HOUR;
    expect(planNextWake(s, end + 30 * MIN)).toEqual({ done: false, wakeAt: end + 30 * MIN + CAP_NEAR_MS }); // replay sent now, nothing new within the hour
    expect(dueKeys(s, end + 18 * HOUR)).toContain('post:noshow_highlights');
    expect(planNextWake(s, end + 17 * HOUR + 30 * MIN)).toEqual({ done: false, wakeAt: end + 18 * HOUR });
    expect(planNextWake(s, flowHorizon(s))).toEqual({ done: true, reason: 'all messages done' });
    // A buyer keeps it going for the documents email (2 to 9 days after buying).
    const b = state({ boughtAt: end - 30 * MIN });
    expect(flowHorizon(b)).toBeGreaterThan(end + 8 * DAY);
    expect(dueKeys(b, end + 2 * DAY)).toContain('post:buyer_docs');
    expect(dueKeys(b, end + 2 * DAY)).not.toContain('replay');
  });
  it('quiet hours: the 24-hour reminder waits for the morning, and the workflow does not wake at its nominal moment', () => {
    const early = Date.parse('2026-11-10T11:00:00Z'); // 06:00 in New York
    const s = state({ quiet: parseQuiet('22-7') }, { starts_at: early }, { created_at: early - 3 * DAY });
    expect(dueKeys(s, early - DAY)).toEqual(['confirm']); // 06:00: quiet (the confirmation stays due until the end)
    expect(dueKeys(s, early - 23 * HOUR)).toEqual(['confirm', 'r24h']); // 07:00
    const first = planNextWake(s, early - DAY - 30 * MIN);
    expect(first).toEqual({ done: false, wakeAt: early - DAY + 30 * MIN });
    expect(planNextWake(s, early - DAY + 30 * MIN)).toEqual({ done: false, wakeAt: early - 23 * HOUR });
  });
  it('a cancelled event stops it; an unpaid ticket only plans the ticket nudge; a failed email is retried in 5 minutes', () => {
    expect(planNextWake(state({}, { status: 'cancelled' }), START - DAY)).toEqual({ done: true, reason: 'event cancelled' });
    const t = state({ ticketUnpaid: true }, {}, { created_at: START - 2 * DAY });
    expect(dueKeys(t, START - 2 * DAY + 31 * MIN)).toEqual(['ticket']);
    expect(dueKeys(t, START - DAY)).toEqual(['ticket']);
    expect(planNextWake(state(), START - DAY + HOUR, ['r24h'])).toEqual({ done: false, wakeAt: START - DAY + HOUR + FLOW_TICK_MS });
    expect(failedKeys([{ step: 1, status: 'failed', attempts: 1 }, { step: 2, status: 'failed', attempts: 3 }, { step: 11, status: 'failed', attempts: 1 }], 0, ['r24h', 'r1h'])).toEqual(['r24h']);
  });
  it('a join stops the "live" and "missing" reminders', () => {
    expect(dueKeys(state(), START + 6 * MIN)).toContain('missing');
    expect(dueKeys(state({}, {}, { joined_at: START + MIN }), START + 6 * MIN)).not.toContain('missing');
  });
});

// ───────────── the live reminder workflow against the database ─────────────

const visitor = (o: Partial<VisitorCtx> = {}): VisitorCtx => ({
  visitorId: 'v1', sessionId: 's1', leadId: null, isNewVisitor: true, isNewSession: true, isBot: false, botReason: null, variant: 'a',
  ua: { device: 'mobile', browser: 'x', os: 'y' } as never, userAgent: 'test', geo: { country: 'US', city: null, timezone: 'America/New_York' } as never, ip: '1.1.1.1', touch: null, fbp: null, fbc: null, marketingConsent: false, consentRequired: false, ...o,
});
const LIVE = { SALES_TIMEZONE: 'America/New_York', SITE_NAME: 'G&L', RESEND_API_KEY: '', EMAIL_FROM: '' };
/** A fake Workflow step: runs each step, and a sleep moves the clock. */
const fakeStep = (onSleep?: (t: number) => Promise<void> | void) => ({
  ticks: 0,
  async do<T>(_n: string, _c: Record<string, unknown>, fn: () => Promise<T>) { this.ticks++; return fn(); },
  async sleepUntil(_n: string, t: Date | number) { const v = Number(t); expect(v).toBeGreaterThan(Date.now()); at(v); await onSleep?.(v); },
});
async function liveSetup(flowOn: boolean, email: string) {
  const wf = { create: vi.fn(async () => ({ id: 'x' })) };
  const env = { LIVE_REMINDERS_VIA_WORKFLOW: flowOn ? 'on' : '', ...LIVE };
  const rt = makeRt({ ...LIVE, LIVE_REMINDERS_VIA_WORKFLOW: flowOn ? 'on' : '' }, { LIVE_REMINDER_FLOW: wf, ...env });
  let evId = (q<{ id: string }>('SELECT id FROM live_webinars')[0])?.id;
  if (!evId) {
    const r = await saveEvent(rt, { title: 'Buy your first competitor', starts_at: START, tz: 'America/New_York', duration_min: 120, join_url: 'https://zoom.us/j/123', platform: 'zoom' });
    if (!r.ok) throw new Error(r.error);
    evId = r.id;
  }
  const r = await registerLive(rt, visitor({ visitorId: `v_${email}`, ip: `1.1.1.${email.length}` }), { first_name: 'Dana', email, revenue: '3_10m', event_id: evId, phone: '+12125550100', sms_consent: true });
  await flush();
  return { rt, wf, reg: r.reg as LiveReg, evId };
}
const sentLive = (leadId: string) => q<{ template: string }>("SELECT template FROM emails WHERE lead_id = ? AND status IN ('sent', 'simulated') ORDER BY template", leadId).map((r) => r.template);
const textsLive = (leadId: string) => q<{ template: string }>("SELECT template FROM sms_messages WHERE lead_id = ? AND status IN ('sent', 'simulated') ORDER BY template", leadId).map((r) => r.template);

describe('live reminder workflow: one registration end to end', () => {
  it('registration starts one instance (id = registration id), idempotent; off starts none', async () => {
    at(START - 3 * DAY);
    const a = await liveSetup(true, 'dana@example.com');
    expect(a.wf.create).toHaveBeenCalledWith({ id: a.reg.id, params: { regId: a.reg.id } });
    expect(await startLiveReminderFlow(a.rt, a.reg)).toBe(false);
    expect(a.wf.create).toHaveBeenCalledTimes(1);
    const b = await liveSetup(false, 'sam@example.com');
    expect(b.wf.create).not.toHaveBeenCalled();
    expect(q('SELECT reg_id FROM live_reminder_flows')).toEqual([{ reg_id: a.reg.id }]);
  });

  it('sends exactly what the 5-minute cron sends, once each, and the cron skips it while it runs', async () => {
    at(START - 3 * DAY);
    // The cron's run for one person (workflow off) …
    const cron = await liveSetup(false, 'cron@example.com');
    // … and the workflow's for another, registered at the same moment.
    const flow = await liveSetup(true, 'flow@example.com');
    const flowRt = flow.rt;
    let cronTicks = 0;
    // The cron keeps running every 5 minutes alongside the workflow (it must skip the workflow's registration).
    let nextCron = START - 3 * DAY + 5 * MIN;
    const runCronUntil = async (t: number) => {
      for (; nextCron <= t; nextCron += 5 * MIN) { at(nextCron); await processLiveMessages(flowRt, nextCron); cronTicks++; }
      at(t);
    };
    const step = fakeStep(async (t) => { await runCronUntil(t); });
    const out = await runLiveReminderFlow(flowRt.env, flow.reg.id, step);
    expect(out.reason).toBe('all messages done');
    expect(step.ticks).toBeLessThan(400);
    expect(cronTicks).toBeGreaterThan(step.ticks * 3); // far fewer wake-ups than the cron
    const want = sentLive(cron.reg.lead_id);
    expect(want).toEqual(expect.arrayContaining(['live_confirm', 'live_r24h', 'live_r3h', 'live_r1h', 'live_r10m', 'live_live', 'live_missing', 'live_replay']));
    expect(sentLive(flow.reg.lead_id)).toEqual(want);
    expect(textsLive(flow.reg.lead_id)).toEqual(textsLive(cron.reg.lead_id));
    // Never twice.
    expect(q("SELECT COUNT(*) AS n FROM emails WHERE lead_id = ? GROUP BY sequence, step HAVING n > 1", flow.reg.lead_id)).toEqual([]);
    expect(q<{ status: string; steps: number }>('SELECT status, steps FROM live_reminder_flows WHERE reg_id = ?', flow.reg.id)[0]).toMatchObject({ status: 'done' });
    expect((await flowReport(flowRt)).byStatus).toEqual({ done: 1 });
  });

  it('re-checks state at every step: a cancelled event stops it, a removed registration stops it, the setting off hands back to the cron', async () => {
    at(START - 3 * DAY);
    const a = await liveSetup(true, 'dana@example.com');
    x("UPDATE live_webinars SET status = 'cancelled'");
    expect(await flowTick(a.rt.env, a.reg.id, 0)).toMatchObject({ done: true, reason: 'event cancelled' });
    x("UPDATE live_webinars SET status = 'scheduled'");
    x("UPDATE live_reminder_flows SET status = 'running'");
    (a.rt.env as unknown as Record<string, string>).LIVE_REMINDERS_VIA_WORKFLOW = 'off';
    at(Date.now() + 20_000); // past the settings cache
    expect(await flowTick(a.rt.env, a.reg.id, 1)).toMatchObject({ done: true, reason: 'setting off' });
    expect(q('SELECT status FROM live_reminder_flows')).toEqual([{ status: 'stopped' }]);
    (a.rt.env as unknown as Record<string, string>).LIVE_REMINDERS_VIA_WORKFLOW = 'on';
    x('DELETE FROM live_webinar_regs');
    expect(await flowTick(a.rt.env, a.reg.id, 2)).toMatchObject({ done: true, reason: 'gone' });
  });

  it('a joined registrant gets no "live" or "missing" reminder from the workflow', async () => {
    at(START - 3 * DAY);
    const a = await liveSetup(true, 'dana@example.com');
    const step = fakeStep((t) => { if (t >= START - 5 * MIN) x('UPDATE live_webinar_regs SET joined_at = ? WHERE id = ? AND joined_at IS NULL', START - 5 * MIN, a.reg.id); });
    await runLiveReminderFlow(a.rt.env, a.reg.id, step);
    const got = sentLive(a.reg.lead_id);
    expect(got).toContain('live_r10m');
    expect(got).not.toContain('live_live');
    expect(got).not.toContain('live_missing');
  });

  it('the cron takes a registration back when its workflow stops or goes quiet', async () => {
    at(START - 3 * DAY);
    const a = await liveSetup(true, 'dana@example.com');
    expect([...(await flowSkipSet(a.rt, a.reg.event_id))]).toEqual([a.reg.id]);
    x('UPDATE live_reminder_flows SET next_wake_at = ?', Date.now() - FLOW_STALE_MS - MIN);
    expect([...(await flowSkipSet(a.rt, a.reg.event_id))]).toEqual([]);
    x("UPDATE live_reminder_flows SET next_wake_at = ?, status = 'failed'", Date.now() + HOUR);
    expect([...(await flowSkipSet(a.rt, a.reg.event_id))]).toEqual([]);
    // Off: never skips, even with a running row.
    x("UPDATE live_reminder_flows SET status = 'running'");
    expect([...(await flowSkipSet(makeRt({ LIVE_REMINDERS_VIA_WORKFLOW: '' }, { LIVE_REMINDER_FLOW: a.wf }), a.reg.event_id))]).toEqual([]);
  });

  it('a step that keeps failing marks the flow failed so the cron takes over at once', async () => {
    at(START - 3 * DAY);
    const a = await liveSetup(true, 'dana@example.com');
    const step = { async do<T>(n: string, _c: Record<string, unknown>, fn: () => Promise<T>) { if (n.startsWith('tick')) throw new Error('boom'); return fn(); }, async sleepUntil() {} };
    await expect(runLiveReminderFlow(a.rt.env, a.reg.id, step)).rejects.toThrow('boom');
    expect(q('SELECT status FROM live_reminder_flows')).toEqual([{ status: 'failed' }]);
    expect([...(await flowSkipSet(a.rt, a.reg.event_id))]).toEqual([]);
  });
});

void (null as unknown as LiveEvent);

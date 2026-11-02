import type { Runtime } from '../app';
import type { Env } from '../env';
import { describeError, recordError } from './errors';

/**
 * Cron isolation. Every job of the 5-minute cron runs through runJobs:
 *  - each job starts on its own (a job that throws synchronously, rejects or hangs can't stop the others);
 *  - each has a time budget: past it the tick stops waiting for that job (marked "slow") while the job itself keeps
 *    running in the background (waitUntil), so what jobs do is unchanged;
 *  - failures go to the error log (kind "cron") and every job's last run, duration and status to `cron_runs`,
 *    shown in Funnel HQ → Errors & cron.
 */
export interface CronJob<T = unknown> {
  name: string;
  run: () => Promise<T> | T;
  /** Milliseconds before the tick stops waiting. Default CRON_BUDGET_MS. */
  budgetMs?: number;
}

export const CRON_BUDGET_MS = 120_000;

export type JobStatus = 'ok' | 'failed' | 'slow';
export interface JobOutcome { name: string; status: JobStatus; ms: number; error?: string; result: unknown }

const SLOW = Symbol('slow');

export async function runJobs(rt: Pick<Runtime, 'env' | 'waitUntil'> & Partial<Pick<Runtime, 'settings' | 'origin' | 'reps'>>, jobs: CronJob[], opts: { now?: () => number; budgetMs?: number } = {}): Promise<JobOutcome[]> {
  const clock = opts.now ?? Date.now;
  const tickStart = clock();
  const errRt = rt.settings ? (rt as Runtime) : null;
  // A slow job that finishes later updates its row only after this tick's rows are written.
  let markSaved: () => void = () => {};
  const tickSaved = new Promise<void>((res) => { markSaved = res; });
  const outcomes = await Promise.all(jobs.map(async (job): Promise<JobOutcome> => {
    const started = clock();
    const budget = job.budgetMs ?? opts.budgetMs ?? CRON_BUDGET_MS;
    // Promise.resolve().then(...) also catches a job that throws before returning its promise.
    const p = Promise.resolve().then(() => job.run());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<typeof SLOW>((res) => { timer = setTimeout(() => res(SLOW), budget); });
    try {
      const r = await Promise.race([p, late]);
      if (r === SLOW) {
        console.warn(`cron job "${job.name}" passed its ${budget} ms budget; it keeps running in the background`);
        // Let it finish, and record how it ended.
        rt.waitUntil(p.then(
          async () => { const ms = clock() - started; await tickSaved; await saveLate(rt.env, { name: job.name, status: 'ok', ms, result: null }, tickStart); },
          async (e) => {
            const ms = clock() - started;
            console.error(`${job.name} failed`, e);
            await recordError(rt.env, e, { kind: 'cron', source: job.name, rt: errRt });
            await tickSaved;
            await saveLate(rt.env, { name: job.name, status: 'failed', ms, error: describeError(e).message, result: null }, tickStart);
          },
        ));
        return { name: job.name, status: 'slow', ms: clock() - started, result: null };
      }
      return { name: job.name, status: 'ok', ms: clock() - started, result: r };
    } catch (e) {
      console.error(`${job.name} failed`, e);
      await recordError(rt.env, e, { kind: 'cron', source: job.name, rt: errRt });
      return { name: job.name, status: 'failed', ms: clock() - started, error: describeError(e).message, result: null };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }));
  await saveTick(rt.env, outcomes, tickStart, clock() - tickStart);
  markSaved();
  return outcomes;
}

const upsertSql = `INSERT INTO cron_runs (job, last_started, last_ms, last_status, last_error, last_ok_at, runs, fails, slow, total_ms, max_ms, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?3, ?3, ?9)
  ON CONFLICT(job) DO UPDATE SET last_started = ?2, last_ms = ?3, last_status = ?4, last_error = ?5,
    last_ok_at = COALESCE(?6, last_ok_at), runs = runs + 1, fails = fails + ?7, slow = slow + ?8,
    total_ms = total_ms + ?3, max_ms = MAX(max_ms, ?3), updated_at = ?9`;

function upsert(env: Pick<Env, 'DB'>, o: JobOutcome, started: number, now: number) {
  return env.DB.prepare(upsertSql).bind(o.name, started, Math.round(o.ms), o.status, o.error ?? null, o.status === 'ok' ? now : null, o.status === 'failed' ? 1 : 0, o.status === 'slow' ? 1 : 0, now);
}

/** A slow job that finished later: update its row (not counted as a second run). */
async function saveLate(env: Pick<Env, 'DB'>, o: JobOutcome, started: number) {
  try {
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE cron_runs SET last_ms = ?, last_status = CASE WHEN ? = 'failed' THEN 'failed' ELSE 'slow' END, last_error = ?,
         last_ok_at = CASE WHEN ? = 'ok' THEN ? ELSE last_ok_at END, fails = fails + ?, max_ms = MAX(max_ms, ?), updated_at = ?
       WHERE job = ? AND last_started = ?`,
    ).bind(Math.round(o.ms), o.status, o.error ?? 'finished after its time budget', o.status, now, o.status === 'failed' ? 1 : 0, Math.round(o.ms), now, o.name, started).run();
  } catch (e) {
    console.error('cron run log failed', e);
  }
}

async function saveTick(env: Pick<Env, 'DB'>, outcomes: JobOutcome[], started: number, ms: number) {
  try {
    const now = Date.now();
    const summary = { at: started, ms, jobs: outcomes.length, failed: outcomes.filter((o) => o.status === 'failed').map((o) => o.name), slow: outcomes.filter((o) => o.status === 'slow').map((o) => o.name) };
    await env.DB.batch([
      ...outcomes.map((o) => upsert(env, o, started, now)),
      env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('cron:last_tick', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(summary)),
    ]);
  } catch (e) {
    console.error('cron run log failed', e);
  }
}

export interface CronRow { job: string; last_started: number; last_ms: number | null; last_status: JobStatus; last_error: string | null; last_ok_at: number | null; runs: number; fails: number; slow: number; total_ms: number; max_ms: number; updated_at: number }

export async function cronReport(env: Pick<Env, 'DB'>) {
  const [rows, tick] = await Promise.all([
    env.DB.prepare("SELECT * FROM cron_runs ORDER BY CASE last_status WHEN 'failed' THEN 0 WHEN 'slow' THEN 1 ELSE 2 END, job COLLATE NOCASE").all<CronRow>(),
    env.DB.prepare("SELECT value FROM kv_state WHERE key = 'cron:last_tick'").first<{ value: string }>(),
  ]);
  let lastTick: { at: number; ms: number; jobs: number; failed: string[]; slow: string[] } | null = null;
  try { lastTick = tick ? JSON.parse(tick.value) : null; } catch { lastTick = null; }
  return {
    lastTick,
    budgetMs: CRON_BUDGET_MS,
    jobs: (rows.results ?? []).map((r) => ({ ...r, avg_ms: r.runs ? Math.round(Number(r.total_ms) / Number(r.runs)) : null })),
  };
}

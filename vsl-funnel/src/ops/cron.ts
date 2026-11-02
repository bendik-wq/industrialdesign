import type { Runtime } from '../app';
import './handlers';
import { maybeSendBrief } from './brief';
import { runMonitors } from './monitors';
import { runDueRoutines } from './routines';
import { maybeRunDataQuality } from '../dataq/run';
import { recordRelease } from './releases';

/**
 * Command's share of the 5-minute cron: due routines every run, the monitors once an hour (claimed per hour),
 * and the morning brief / weekend summary once a day at OPS_BRIEF_TIME in the owner's time zone. It also records
 * this build's deploy notes once (src/ops/releases.ts).
 */
export async function runOps(rt: Runtime, now = Date.now()) {
  const quiet = <T,>(p: Promise<T>, label: string) => p.catch((e) => { console.error(`ops ${label} failed`, e); return null; });
  const [routines, monitors, brief, dataq, release] = await Promise.all([
    quiet(runDueRoutines(rt, now), 'routines'),
    quiet(runMonitors(rt, now), 'monitors'),
    quiet(maybeSendBrief(rt, now), 'brief'),
    quiet(maybeRunDataQuality(rt, now), 'data quality'), // once a day: src/dataq (stored, then a brief item here)
    quiet(recordRelease(rt, undefined, now), 'release notes'), // once per deployed build (no-op without npm run deploy)
  ]);
  return { routines, alerts: monitors?.alerts ?? 0, brief: Boolean(brief), dataq: Boolean(dataq), release: Boolean(release) };
}

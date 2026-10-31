import type { Runtime } from '../app';
import './handlers';
import { maybeSendBrief } from './brief';
import { runMonitors } from './monitors';
import { runDueRoutines } from './routines';

/**
 * Command's share of the 5-minute cron: due routines every run, the monitors once an hour (claimed per hour),
 * and the morning brief / weekend summary once a day at OPS_BRIEF_TIME in the owner's time zone.
 */
export async function runOps(rt: Runtime, now = Date.now()) {
  const quiet = <T,>(p: Promise<T>, label: string) => p.catch((e) => { console.error(`ops ${label} failed`, e); return null; });
  const [routines, monitors, brief] = await Promise.all([
    quiet(runDueRoutines(rt, now), 'routines'),
    quiet(runMonitors(rt, now), 'monitors'),
    quiet(maybeSendBrief(rt, now), 'brief'),
  ]);
  return { routines, alerts: monitors?.alerts ?? 0, brief: Boolean(brief) };
}

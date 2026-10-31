import type { Runtime } from '../app';
import { localParts, validTimeZone, wallTime } from '../challenge/schedule';
import { newId } from '../lib/ids';
import { type ChatModel, runChat } from './chat';
import { composeBrief, buildBrief } from './brief';
import { ownerTz } from './range';
import { postOps } from './slack';

/**
 * Routines: saved recurring instructions ("every Monday 8:00: summarise last week and propose next week's tests"),
 * daily, on weekdays or weekly at a time in the owner's time zone. The 5-minute cron runs each one when it is due:
 * the instruction goes to the Chief of Staff as a new chat thread, and the answer is posted to Slack with a link.
 */
export type Cadence = 'daily' | 'weekdays' | 'weekly';
export interface Routine { id: string; name: string; instruction: string; cadence: Cadence; weekday: number | null; time: string; timezone: string; enabled: number; next_run_at: number | null; last_run_at: number | null; last_thread: string | null; created_at: number; updated_at: number }
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Pure: the first run strictly after `after`, at the routine's wall-clock time in its time zone (DST-safe). */
export function nextRunAt(r: Pick<Routine, 'cadence' | 'weekday' | 'time' | 'timezone'>, after: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(r.time);
  if (!m || !validTimeZone(r.timezone)) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  const [y, mo, d] = localParts(after, r.timezone).date.split('-').map(Number);
  for (let i = 0; i <= 8; i++) {
    const date = new Date(Date.UTC(y, mo - 1, d + i));
    const wd = date.getUTCDay();
    if (r.cadence === 'weekdays' && (wd === 0 || wd === 6)) continue;
    if (r.cadence === 'weekly' && wd !== (r.weekday ?? 1)) continue;
    const t = wallTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h, min, r.timezone);
    if (t > after) return t;
  }
  return null;
}

export function describeSchedule(r: Pick<Routine, 'cadence' | 'weekday' | 'time' | 'timezone'>) {
  const when = r.cadence === 'daily' ? 'Every day' : r.cadence === 'weekdays' ? 'Every weekday' : `Every ${WEEKDAYS[r.weekday ?? 1]}`;
  return `${when} at ${r.time} (${r.timezone})`;
}

export class RoutineError extends Error {}

/** Validate input into a routine (name, instruction, cadence, weekday, time; time zone defaults to the owner's). */
export function cleanRoutine(rt: Pick<Runtime, 'settings'>, b: Record<string, unknown>) {
  const name = String(b.name ?? '').trim().slice(0, 80);
  const instruction = String(b.instruction ?? '').trim().slice(0, 2000);
  const cadence = String(b.cadence ?? 'daily') as Cadence;
  const time = String(b.time ?? '').trim();
  const timezone = String(b.timezone ?? '').trim() || ownerTz(rt);
  if (!instruction) throw new RoutineError('Write the instruction the routine should run.');
  if (!['daily', 'weekdays', 'weekly'].includes(cadence)) throw new RoutineError('Pick daily, weekdays or weekly.');
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) throw new RoutineError('Give the time as HH:MM, for example 08:00.');
  if (!validTimeZone(timezone)) throw new RoutineError('That time zone is not recognised. Use a name like Australia/Sydney.');
  const weekday = cadence === 'weekly' ? Number(b.weekday) : null;
  if (cadence === 'weekly' && !(Number.isInteger(weekday) && weekday! >= 0 && weekday! <= 6)) throw new RoutineError('Pick the day of the week.');
  return { name: name || instruction.slice(0, 60), instruction, cadence, weekday, time: time.padStart(5, '0'), timezone, enabled: b.enabled === false || b.enabled === 0 ? 0 : 1 };
}

export async function createRoutine(rt: Runtime, b: Record<string, unknown>, now = Date.now()) {
  const r = cleanRoutine(rt, b);
  const id = newId('rt_');
  await rt.env.DB.prepare('INSERT INTO ops_routines (id, name, instruction, cadence, weekday, time, timezone, enabled, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, r.name, r.instruction, r.cadence, r.weekday, r.time, r.timezone, r.enabled, r.enabled ? nextRunAt(r, now) : null, now, now).run();
  return id;
}

export async function updateRoutine(rt: Runtime, id: string, b: Record<string, unknown>, now = Date.now()) {
  const cur = await rt.env.DB.prepare('SELECT * FROM ops_routines WHERE id = ?').bind(id).first<Routine>();
  if (!cur) throw new RoutineError('Routine not found.');
  const r = cleanRoutine(rt, { ...cur, ...b });
  await rt.env.DB.prepare('UPDATE ops_routines SET name = ?, instruction = ?, cadence = ?, weekday = ?, time = ?, timezone = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
    .bind(r.name, r.instruction, r.cadence, r.weekday, r.time, r.timezone, r.enabled, r.enabled ? nextRunAt(r, now) : null, now, id).run();
}

export async function listRoutines(rt: Runtime) {
  return (await rt.env.DB.prepare('SELECT * FROM ops_routines ORDER BY created_at DESC LIMIT 100').all<Routine>()).results;
}

/** Run one routine now: a chat thread with the answer, and a Slack message linking to it. */
export async function runRoutine(rt: Runtime, r: Routine, o: { model?: ChatModel | null; now?: number } = {}) {
  const now = o.now ?? Date.now();
  const res = await runChat(rt, { message: `Routine "${r.name}" (${describeSchedule(r)}): ${r.instruction}`, kind: 'routine', routineId: r.id, model: o.model, now });
  let text = res.text;
  // Without the API key the routine still delivers real numbers: the brief's data for the last week.
  if (o.model === null || (o.model === undefined && !rt.settings.ANTHROPIC_API_KEY)) {
    const b = composeBrief(await buildBrief(rt, 'daily', now));
    text = `${res.text}\n\nUntil then, here are the latest numbers.\n\n${b.markdown.split('\n').slice(1).join('\n')}`;
    await rt.env.DB.prepare("UPDATE ops_messages SET content = ? WHERE thread_id = ? AND role = 'assistant'").bind(text, res.threadId).run();
  }
  await rt.env.DB.prepare('UPDATE ops_routines SET last_run_at = ?, last_thread = ? WHERE id = ?').bind(now, res.threadId, r.id).run();
  const lines = text.split('\n').filter((l) => l.trim()).slice(0, 30);
  await postOps(rt, { title: `Routine: ${r.name}`, lines, path: `/admin#command/thread=${res.threadId}`, linkText: 'Open the full answer in Funnel HQ' });
  return res.threadId;
}

/** Called by the 5-minute cron: claims and runs every routine that is due, then schedules its next run. */
export async function runDueRoutines(rt: Runtime, now = Date.now(), o: { model?: ChatModel | null } = {}) {
  const { results } = await rt.env.DB.prepare('SELECT * FROM ops_routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 5').bind(now).all<Routine>();
  let ran = 0;
  for (const r of results) {
    const next = nextRunAt(r, now);
    // Claim by moving next_run_at on: a second cron that read the same row updates nothing and skips it.
    const claim = await rt.env.DB.prepare('UPDATE ops_routines SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at = ?').bind(next, now, r.id, r.next_run_at).run();
    if (!claim.meta.changes) continue;
    try { await runRoutine(rt, r, { model: o.model, now }); ran++; } catch (e) { console.error('routine failed', r.id, e); }
  }
  return ran;
}

import type { Runtime } from '../app';
import { proposeDueCheckins } from '../clients/checkins';
import { rebuildClients } from '../clients/health';
import { processWebhooks } from '../integrations/webhooks-out';
import { processSupport } from '../support/inbox';
import '../mcp/tools'; // registers the write tools' action handlers (lead.note, mcp.email) for approvals run from the cron

/** Local hour and date in a time zone. */
export function localClock(now: number, tz: string) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
  } catch {
    return { date: new Date(now).toISOString().slice(0, 10), hour: new Date(now).getUTCHours() };
  }
}

/** Once a day at CS_DAILY_HOUR (sales time zone): rebuild client health and propose the check-ins that are due. */
export async function maybeDailyClients(rt: Runtime, now = Date.now()) {
  const { date, hour } = localClock(now, rt.settings.SALES_TIMEZONE || 'UTC');
  const want = Math.max(0, Math.min(23, Number(rt.settings.CS_DAILY_HOUR) || 7));
  if (hour < want) return null;
  const db = rt.env.DB;
  const claim = await db.prepare("INSERT INTO kv_state (key, value) VALUES ('cs:daily', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE kv_state.value != excluded.value").bind(date).run();
  if (!(claim.meta?.changes ?? 0)) return null; // already ran today
  const rebuilt = await rebuildClients(rt, now);
  const checkins = await proposeDueCheckins(rt, now);
  return { ...rebuilt, ...checkins };
}

/** Every cron tick (5 minutes): webhooks out, the support inbox, and the daily Client Success run. */
export async function processClientsSupport(rt: Runtime) {
  const quiet = <T,>(p: Promise<T>, label: string) => p.catch((e) => { console.error(`${label} failed`, e); return null; });
  const [hooks, support, daily] = await Promise.all([
    quiet(processWebhooks(rt), 'webhooks'),
    quiet(processSupport(rt), 'support inbox'),
    quiet(maybeDailyClients(rt), 'client success'),
  ]);
  if (hooks && (hooks.found || hooks.delivered || hooks.failed)) console.log('webhooks', hooks);
  if (support && (support.added || support.drafted || support.escalated)) console.log('support', support);
  if (daily) console.log('client success', daily);
  return { hooks, support, daily };
}

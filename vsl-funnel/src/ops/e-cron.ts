import type { Runtime } from '../app';
import { proposeDueCheckins } from '../clients/checkins';
import { rebuildClients } from '../clients/health';
import { processWebhooks } from '../integrations/webhooks-out';
import { processSupport } from '../support/inbox';
import { retryQueued } from '../lib/webhook-events';
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

/** Inbound webhooks stored for background processing (Instagram) that failed or never finished run again here. */
export function retryInboundWebhooks(rt: Runtime, now = Date.now()) {
  return retryQueued(rt.env, {
    instagram: async (raw) => (await import('../dm/inbox')).ingestWebhook(rt, JSON.parse(raw)),
  }, now);
}

/** Every cron tick (5 minutes): webhooks out, inbound webhook retries, the support inbox, the daily Client Success run and the daily room storage sweep. */
export async function processClientsSupport(rt: Runtime) {
  const quiet = <T,>(p: Promise<T>, label: string) => p.catch((e) => { console.error(`${label} failed`, e); return null; });
  const [hooks, support, daily, inbound, roomsGc] = await Promise.all([
    quiet(processWebhooks(rt), 'webhooks'),
    quiet(processSupport(rt), 'support inbox'),
    quiet(maybeDailyClients(rt), 'client success'),
    quiet(retryInboundWebhooks(rt), 'inbound webhook retries'),
    quiet(import('../rooms/hygiene').then((h) => h.sweepRoomStorage(rt)), 'room storage clean-up'),
  ]);
  if (inbound && (inbound.retried || inbound.pruned)) console.log('inbound webhook retries', inbound);
  if (roomsGc?.checked) console.log('room storage clean-up', roomsGc);
  if (hooks && (hooks.found || hooks.delivered || hooks.failed)) console.log('webhooks', hooks);
  if (support && (support.added || support.drafted || support.escalated)) console.log('support', support);
  if (daily) console.log('client success', daily);
  return { hooks, support, daily, inbound };
}

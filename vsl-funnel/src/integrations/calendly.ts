import type { Runtime } from '../app';
import { newId, newRefCode } from '../lib/ids';
import { type Lead, getLead, getLeadByEmail, updateLead, validateEmail } from '../funnel/leads';
import { saveSettings } from '../settings';
import type { Settings } from '../settings';

/**
 * Calendly API (personal access token). Gives us what the embed can't:
 *  - the exact call time the moment someone books (the embed only sends a URI),
 *  - the meeting link, reschedule/cancel links, host and the invitee's answers,
 *  - a signed webhook we register ourselves (bookings, cancellations, no-shows),
 *  - an hourly sync that catches anything a webhook missed and imports calls
 *    booked straight from the Calendly link (data only — no emails go to them).
 */
const API = 'https://api.calendly.com';

export const calendlyConnected = (s: Settings) => Boolean(s.CALENDLY_API_TOKEN);

export class CalendlyError extends Error {
  constructor(public status: number, public body: string) {
    super(`Calendly ${status}: ${body.slice(0, 300)}`);
  }
}

async function cal<T>(s: Settings, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${s.CALENDLY_API_TOKEN}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new CalendlyError(res.status, text);
  return (text ? JSON.parse(text) : {}) as T;
}

interface Me { resource: { uri: string; name: string; email: string; current_organization: string; scheduling_url: string; timezone: string } }
export interface CalEvent {
  uri: string; name: string; status: 'active' | 'canceled'; start_time: string; end_time: string;
  location?: { type?: string; join_url?: string; location?: string } | null;
  event_memberships?: { user?: string; user_email?: string; user_name?: string }[];
  cancellation?: { canceled_by?: string; reason?: string } | null;
}
export interface CalInvitee {
  uri: string; email: string; name: string; first_name?: string | null; last_name?: string | null; status: 'active' | 'canceled';
  timezone?: string | null; rescheduled?: boolean; old_invitee?: string | null; new_invitee?: string | null;
  cancel_url?: string; reschedule_url?: string; text_reminder_number?: string | null;
  questions_and_answers?: { question: string; answer: string }[];
  tracking?: { utm_source?: string | null; utm_medium?: string | null; utm_campaign?: string | null; utm_content?: string | null; utm_term?: string | null; salesforce_uuid?: string | null } | null;
  no_show?: { uri: string } | null;
  created_at?: string;
}

/** Who the token belongs to; cached in kv_state. */
export async function account(rt: Runtime): Promise<Me['resource']> {
  const cached = await rt.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'calendly:me'").first<{ value: string }>();
  if (cached) { try { const v = JSON.parse(cached.value); if (v.token === rt.settings.CALENDLY_API_TOKEN.slice(-12)) return v.me; } catch { /* refetch */ } }
  const me = (await cal<Me>(rt.settings, '/users/me')).resource;
  await rt.env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('calendly:me', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify({ token: rt.settings.CALENDLY_API_TOKEN.slice(-12), me })).run();
  return me;
}

const HOOK_EVENTS = ['invitee.created', 'invitee.canceled', 'invitee_no_show.created', 'invitee_no_show.deleted'];

/**
 * Registers our webhook (user scope) with a signing key we generate, so every
 * payload is verified. Replaces an older subscription to our URL if there is
 * one; other subscriptions (e.g. Kit's) are left alone.
 */
export async function connectCalendly(rt: Runtime) {
  const s = rt.settings;
  const me = await account(rt);
  const url = `${rt.origin}/hooks/calendly`;
  const existing = await cal<{ collection: { uri: string; callback_url: string }[] }>(s, `/webhook_subscriptions?organization=${encodeURIComponent(me.current_organization)}&user=${encodeURIComponent(me.uri)}&scope=user&count=100`);
  for (const h of existing.collection.filter((x) => x.callback_url === url)) await cal(s, h.uri, { method: 'DELETE' });
  const key = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await cal(s, '/webhook_subscriptions', { method: 'POST', body: { url, events: HOOK_EVENTS, organization: me.current_organization, user: me.uri, scope: 'user', signing_key: key } });
  await saveSettings(rt.env, { CALENDLY_SIGNING_KEY: key });
  return { name: me.name, email: me.email, schedulingUrl: me.scheduling_url, webhook: url, events: HOOK_EVENTS };
}

export async function eventWithInvitees(s: Settings, eventUri: string) {
  const [ev, inv] = await Promise.all([
    cal<{ resource: CalEvent }>(s, eventUri),
    cal<{ collection: CalInvitee[] }>(s, `${eventUri}/invitees?count=100`),
  ]);
  return { event: ev.resource, invitees: inv.collection };
}

/** Lead fields from a Calendly event + invitee, including the closer when the host is a rep. */
export function bookingFields(rt: Runtime, ev: CalEvent, inv: CalInvitee) {
  const host = ev.event_memberships?.[0]?.user_email?.toLowerCase() ?? null;
  const rep = host ? rt.reps.find((r) => r.email?.toLowerCase() === host) : undefined;
  return {
    callAt: Date.parse(ev.start_time) || null,
    fields: {
      booking_join_url: ev.location?.join_url ?? null,
      booking_reschedule_url: inv.reschedule_url ?? null,
      booking_cancel_url: inv.cancel_url ?? null,
      booking_host_email: host,
      booking_answers: inv.questions_and_answers?.length ? JSON.stringify(inv.questions_and_answers.map((x) => ({ q: x.question, a: x.answer }))) : null,
      ...(rep ? { closer_id: rep.id } : {}),
    } as Partial<Record<keyof Lead, string | number | null>>,
  };
}

/** Finds the funnel lead for an invitee: our lead id rides in salesforce_uuid; else email. */
export async function leadForInvitee(rt: Runtime, inv: CalInvitee) {
  const id = inv.tracking?.salesforce_uuid;
  if (id) { const l = await getLead(rt.env, id); if (l) return l; }
  return inv.email ? getLeadByEmail(rt.env, inv.email.toLowerCase()) : null;
}

/**
 * Hourly: every Calendly event from 14 days ago to 60 days ahead.
 *  - funnel leads: fill in/refresh call time, links and answers; catch cancellations a webhook missed
 *  - people who booked straight from the Calendly link: imported as leads (source "Calendly (direct)")
 *    so the Sales tab shows every call. They get no emails, calls or sequences.
 */
export async function syncCalendly(rt: Runtime, opts: { force?: boolean; daysBack?: number } = {}) {
  const s = rt.settings;
  if (!calendlyConnected(s)) return null;
  const now = Date.now();
  if (!opts.force) {
    const last = await rt.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'calendly:last_sync'").first<{ value: string }>();
    if (last && now - Number(last.value) < 55 * 60_000) return null;
  }
  await rt.env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('calendly:last_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(now)).run();
  const me = await account(rt);
  const min = new Date(now - (opts.daysBack ?? 14) * 86_400_000).toISOString();
  const max = new Date(now + 60 * 86_400_000).toISOString();
  let next: string | null = `/scheduled_events?user=${encodeURIComponent(me.uri)}&min_start_time=${min}&max_start_time=${max}&count=100&sort=start_time:asc`;
  const stats = { events: 0, updated: 0, imported: 0, cancelled: 0 };
  const { markBooked, markCancelled } = await import('./booking');
  for (let page = 0; next && page < 5; page++) {
    const res: { collection: CalEvent[]; pagination: { next_page: string | null } } = await cal(s, next);
    for (const ev of res.collection) {
      stats.events++;
      const inv = (await cal<{ collection: CalInvitee[] }>(s, `${ev.uri}/invitees?count=20`)).collection;
      for (const i of inv) {
        let lead = await leadForInvitee(rt, i);
        const live = ev.status === 'active' && i.status === 'active';
        const { callAt, fields } = bookingFields(rt, ev, i);
        if (!lead) {
          if (!live) continue;
          lead = await importDirect(rt, i, ev);
          stats.imported++;
          continue;
        }
        if (live) {
          const changed = lead.booking_ref !== ev.uri || lead.call_at !== callAt || lead.booking_cancelled_at;
          if (changed && lead.booking_source !== 'calendly-direct' && (callAt ?? 0) > now) {
            await markBooked(rt, lead, { callAt, provider: 'calendly', ref: ev.uri, verified: true, rescheduled: Boolean(lead.booked_at && !lead.booking_cancelled_at) });
            stats.updated++;
          } else if (changed) {
            await updateLead(rt.env, lead.id, { booked_at: lead.booked_at ?? (i.created_at ? Date.parse(i.created_at) : now), call_at: callAt, booking_ref: ev.uri, booking_provider: 'calendly', booking_cancelled_at: null, status: ['applied', 'partial', 'nurture', 'new'].includes(lead.status) ? 'booked' : lead.status });
            stats.updated++;
          }
          await updateLead(rt.env, lead.id, fields);
        } else if (lead.booking_ref === ev.uri && !lead.booking_cancelled_at && !i.rescheduled) {
          await markCancelled(rt, lead, 'calendly');
          stats.cancelled++;
        }
      }
    }
    next = res.pagination?.next_page ?? null;
  }
  return stats;
}

/** A call booked straight from the Calendly link by someone who never went through the funnel. */
async function importDirect(rt: Runtime, i: CalInvitee, ev: CalEvent) {
  const email = validateEmail(i.email)?.email ?? i.email.toLowerCase();
  const now = Date.now();
  const id = newId('l');
  const [first, ...rest] = (i.first_name ?? i.name ?? '').trim().split(/\s+/);
  const { callAt, fields } = bookingFields(rt, ev, i);
  const t = i.tracking ?? {};
  const created = i.created_at ? Date.parse(i.created_at) : now;
  // Past calls land as 'booked' so they show under "needs an outcome" on the Sales tab.
  const status = 'booked';
  await rt.env.DB.prepare(
    `INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, phone, whatsapp_opt_in, step_reached, status,
       channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term, booked_at, call_at, booking_provider, booking_ref, booking_source, timezone, landing_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'Calendly (direct)', ?, ?, ?, ?, ?, ?, ?, 'calendly', ?, 'calendly-direct', ?, '/calendly')`,
  )
    .bind(id, newRefCode(), created, now, first || null, i.last_name ?? (rest.join(' ') || null), email, i.text_reminder_number ?? null, status,
      t.utm_source ?? null, t.utm_medium ?? null, t.utm_campaign ?? null, t.utm_content ?? null, t.utm_term ?? null, created, callAt, ev.uri, i.timezone ?? null)
    .run();
  await updateLead(rt.env, id, fields);
  return (await getLead(rt.env, id))!;
}

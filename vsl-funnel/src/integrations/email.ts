import { safeFirstName } from '../lib/text';
import type { Runtime } from '../app';
import { BRAND } from '../config';
import { hmacHex, safeEqual } from '../lib/crypto';
import { newId } from '../lib/ids';
import { getSecret } from '../lib/secret';
import { type Lead, getLead } from '../funnel/leads';
import { bookingUrlFor } from '../funnel/routing';
import { effectiveTier } from '../funnel/leads';
import { identityFromLead, track } from '../tracking/track';
import { SEQUENCES, type SequenceId, precallPlan } from './sequences';
import { TEMPLATES, type TemplateCtx, renderEmail } from './templates';
import { type Override, fromOverride, isEditable, loadOverrides } from './email-overrides';
import { FOLLOWUP_TEMPLATES } from '../followup/templates';
import { ANSWER_FACTS } from '../followup/dossier';
import { whatsappLink } from './whatsapp';
import { buildProfile } from '../personalize/profile';
import { RULES } from '../personalize/triggers';
import { getRegistration, getSession, googleCalendarUrl, replayUrl, roomUrl, webinarBase, webinarSettings } from '../webinar/webinar';
import { type Personalized, personalizeEmail } from '../personalize/personalize';

const MAX_ATTEMPTS = 3;

/** Schedules every step of a sequence. Re-enqueueing (e.g. a rescheduled call) refreshes pending steps. */
export async function enqueueSequence(rt: Runtime, lead: Pick<Lead, 'id' | 'email' | 'call_at' | 'unsubscribed_at'> & { webinar_at?: number | null }, sequenceId: SequenceId, opts: { stepBase?: number; startAt?: number } = {}) {
  if (!lead.email || lead.unsubscribed_at) return;
  const now = opts.startAt ?? Date.now();
  const seq = SEQUENCES[sequenceId];
  const base = opts.stepBase ?? 0;
  const stmts = seq.steps.flatMap((step, j) => {
    const i = base + j;
    const kind = 'anchor' in step ? step.anchor : 'start';
    const anchor = kind === 'call_at' ? lead.call_at : kind === 'webinar_at' ? lead.webinar_at ?? null : now;
    if (anchor == null) return [];
    const sendAt = anchor + step.offsetMs;
    // Reminders whose moment has already passed (e.g. a call booked for 30 minutes from now) are pointless.
    if (kind !== 'start' && sendAt < now - 5 * 60_000) return [];
    return [
      rt.env.DB.prepare(
        `INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(lead_id, sequence, step) DO UPDATE SET send_at = excluded.send_at, status = 'pending', to_email = excluded.to_email, attempts = 0
           WHERE emails.status IN ('pending', 'cancelled', 'skipped')`,
      ).bind(newId('m'), lead.id, sequenceId, i, step.template, lead.email, sendAt, now),
    ];
  });
  if (stmts.length) await rt.env.DB.batch(stmts);
}

/** Epoch ms for a wall-clock time in a time zone. */
export function zonedTime(y: number, m: number, d: number, hours: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, Math.floor(hours), Math.round((hours % 1) * 60));
  const offset = (t: number) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(t);
    const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(t / 60_000) * 60_000;
  };
  const first = guess - offset(guess);
  return guess - offset(first); // second pass handles DST edges
}

/**
 * Pre-call barrage: up to PRECALL_EMAILS_PER_DAY emails a day (default 6) at
 * local-time slots, from ~90 minutes after booking until 3 hours before the
 * call (or 4 days when the call time isn't known yet). Re-run whenever the
 * call time changes; it reschedules the unsent ones.
 */
export const PRECALL_WAKING = [7, 21] as const; // local hours the pre-call emails may land in

/**
 * When the pre-call emails go out: spread evenly over the waking hours (7am–9pm, their time) between
 * shortly after booking and 2¼ hours before the call, at least 45 minutes apart (30 when that's the only
 * way to reach `min` on a short notice booking) and clear of the 48h / 24h / 3h reminders. About one per waking hour, at least `min` (when there's room) and at most `max`, and never
 * more than `perDay` in one day. A call booked for tomorrow still gets ~10; a week out gets `max`, spread thin.
 */
export function precallTimes(now: number, callAt: number | null, tz: string, perDay: number, max = 20, min = 10): number[] {
  if (perDay <= 0 || max <= 0) return [];
  const start = now + 45 * 60_000;
  const end = callAt ? callAt - 2.25 * 3_600_000 : now + 4 * 86_400_000;
  if (end <= start) return [];
  const reminders = callAt ? [callAt - 48 * 3_600_000, callAt - 24 * 3_600_000, callAt - 3 * 3_600_000] : [];
  const BLACKOUT = 45 * 60_000;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
  } catch {
    return precallTimes(now, callAt, 'UTC', perDay, max, min);
  }
  const g = (k: string) => Number(parts.find((x) => x.type === k)!.value);
  // Every allowed 5-minute mark, grouped by local day.
  const days: number[][] = [];
  for (let day = 0; day < 16; day++) {
    const base = new Date(Date.UTC(g('year'), g('month') - 1, g('day') + day));
    const [y, m, d] = [base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()];
    const from = zonedTime(y, m, d, PRECALL_WAKING[0], tz);
    // On the day they book they're clearly awake: allow up to 90 minutes after booking, until 11pm at the latest.
    const to = Math.max(zonedTime(y, m, d, PRECALL_WAKING[1], tz), day === 0 ? Math.min(now + 90 * 60_000, zonedTime(y, m, d, 23, tz)) : 0);
    if (from > end) break;
    const marks: number[] = [];
    for (let t = from; t <= to; t += 5 * 60_000) if (t >= start && t <= end && !reminders.some((r) => Math.abs(r - t) < BLACKOUT)) marks.push(t);
    if (marks.length) days.push(marks);
  }
  const grid = days.flat();
  if (!grid.length) return [];
  const span = grid.length * 5 * 60_000;
  // 45 minutes apart normally; down to 30 only if that's what it takes to reach the minimum.
  const GAP = Math.floor(span / 45 / 60_000) >= Math.min(min, max) ? 45 * 60_000 : 30 * 60_000;
  const capacity = Math.floor(span / GAP);
  const wakingHours = (grid.length * 5) / 60;
  const cap = Math.min(max, capacity, days.length * Math.round(perDay));
  const n = Math.max(1, Math.min(cap, Math.max(Math.min(min, cap), Math.round(wakingHours))));
  // Even spread over the waking timeline, then enforce the gap and the per-day cap.
  const out: number[] = [];
  const perDayCount = new Map<number, number>();
  const dayOf = (t: number) => days.findIndex((dd) => dd.includes(t));
  for (let i = 0; i < n; i++) {
    let idx = Math.floor(((i + 0.5) * grid.length) / n);
    while (idx < grid.length && ((out.length && grid[idx] - out[out.length - 1] < GAP) || (perDayCount.get(dayOf(grid[idx])) ?? 0) >= perDay)) idx++;
    if (idx >= grid.length) break;
    out.push(grid[idx]);
    const dd = dayOf(grid[idx]);
    perDayCount.set(dd, (perDayCount.get(dd) ?? 0) + 1);
  }
  return out;
}

/** Settings: daily cap (0 = off), and the 10–20 target range. */
export function precallLimits(rt: Runtime) {
  const num = (v: string, d: number) => (v.trim() === '' || !Number.isFinite(Number(v)) ? d : Math.max(0, Math.floor(Number(v))));
  const s = rt.settings;
  const max = Math.min(40, num(s.PRECALL_EMAILS_MAX, 20));
  return { perDay: num(s.PRECALL_EMAILS_PER_DAY, 12), min: Math.min(max, num(s.PRECALL_EMAILS_MIN, 10)), max };
}

export async function enqueuePrecall(rt: Runtime, lead: Lead) {
  if (!lead.email || lead.unsubscribed_at) return 0;
  const { perDay, min, max } = precallLimits(rt);
  await cancelSequence(rt, lead.id, 'precall');
  if (perDay <= 0 || max <= 0) return 0;
  const tz = lead.timezone || (await leadTimezone(rt, lead)) || rt.settings.SALES_TIMEZONE || 'UTC';
  const now = Date.now();
  const times = precallTimes(now, lead.call_at, tz, perDay, Math.min(max, precallPlan(lead).length), min);
  if (!times.length) return 0;
  // As many emails as there are send times, most important first, in story order.
  const plan = precallPlan(lead, times.length);
  await rt.env.DB.batch(times.map((sendAt, i) =>
    rt.env.DB.prepare(
      `INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at)
       VALUES (?, ?, 'precall', ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(lead_id, sequence, step) DO UPDATE SET send_at = excluded.send_at, status = 'pending', to_email = excluded.to_email, attempts = 0
         WHERE emails.status IN ('pending', 'cancelled', 'skipped')`,
    ).bind(newId('m'), lead.id, i, plan[i], lead.email, sendAt, now),
  ));
  return times.length;
}

export async function cancelSequence(rt: Runtime, leadId: string, sequenceId: SequenceId) {
  await rt.env.DB.prepare("UPDATE emails SET status = 'cancelled' WHERE lead_id = ? AND sequence = ? AND status = 'pending'").bind(leadId, sequenceId).run();
}

async function linkSig(rt: Runtime, emailId: string, target: string) {
  return (await hmacHex(await getSecret(rt.env), `${emailId}|${target}`)).slice(0, 16);
}

export async function verifyLinkSig(rt: Runtime, emailId: string, target: string, sig: string) {
  return safeEqual(await linkSig(rt, emailId, target), sig);
}

export async function unsubscribeSig(rt: Runtime, leadId: string) {
  return (await hmacHex(await getSecret(rt.env), `unsub|${leadId}`)).slice(0, 20);
}

async function leadTimezone(rt: Runtime, lead: Lead) {
  if (!lead.visitor_id) return null;
  const row = await rt.env.DB.prepare('SELECT COALESCE(client_tz, timezone) AS tz FROM sessions WHERE visitor_id = ? ORDER BY last_seen_at DESC LIMIT 1').bind(lead.visitor_id).first<{ tz: string | null }>();
  return row?.tz ?? null;
}

export function formatCallTime(ms: number, timeZone: string | null) {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  try {
    return new Intl.DateTimeFormat('en-AU', { ...opts, timeZone: timeZone ?? 'UTC' }).format(ms);
  } catch {
    return new Intl.DateTimeFormat('en-AU', { ...opts, timeZone: 'UTC' }).format(ms);
  }
}

/** Builds a fully rendered, tracked email for a lead. */
export interface BuildOptions {
  /** Personalise to the lead's behaviour (sequence sends). */
  personalize?: { purpose: string };
  /** Email editor preview: render these (unsaved) edits, or null for the built-in wording. */
  override?: Pick<Override, 'subject' | 'preheader' | 'body' | 'cta_label' | 'cta_href' | 'ps'> | null;
}

/** Fact keys earlier emails to this lead already used. */
export async function usedFacts(rt: Runtime, leadId: string) {
  const { results } = await rt.env.DB.prepare("SELECT facts_used FROM emails WHERE lead_id = ? AND facts_used IS NOT NULL AND status IN ('sent', 'simulated', 'sending')").bind(leadId).all<{ facts_used: string }>();
  const used = new Set<string>();
  for (const r of results) { try { for (const k of JSON.parse(r.facts_used) as string[]) used.add(k); } catch { /* ignore */ } }
  return used;
}

export async function buildEmail(rt: Runtime, lead: Lead, emailId: string, template: string, utmCampaign: string, opts: BuildOptions = {}) {
  const tpl = TEMPLATES[template];
  if (!tpl) throw new Error(`unknown template ${template}`);
  const tz = lead.call_at ? await leadTimezone(rt, lead) : null;

  const tracked = new Map<string, string>();
  const link = (path: string) => {
    const target = /^https?:/.test(path) ? path : `${rt.origin}${path}`;
    const url = new URL(target);
    if (url.origin === rt.origin) {
      url.searchParams.set('utm_source', 'email');
      url.searchParams.set('utm_medium', 'email');
      url.searchParams.set('utm_campaign', utmCampaign);
      url.searchParams.set('utm_content', template);
    }
    const placeholder = `__LINK_${tracked.size}__`;
    tracked.set(placeholder, url.toString());
    return placeholder;
  };
  const wa = whatsappLink(rt.settings, lead, 'question');
  const webinar = template.startsWith('w_') ? await webinarContext(rt, lead, link) : null;
  const ctx: TemplateCtx = {
    lead,
    // Only something that looks like a name goes in greetings and subjects (no links, numbers or markup).
    name: safeFirstName(lead.first_name) ?? 'there',
    siteName: rt.settings.SITE_NAME || BRAND.name,
    link,
    bookingUrl: bookingUrlFor(rt, lead.closer_id, effectiveTier(lead)),
    whatsappUrl: wa ? link(`/go/wa?src=email-${template}&l=${lead.ref_code}`) : null,
    callTime: lead.call_at ? formatCallTime(lead.call_at, tz) : null,
    joinUrl: lead.booking_join_url && /^https:\/\//.test(lead.booking_join_url) ? lead.booking_join_url : null,
    rescheduleUrl: lead.booking_reschedule_url && /^https:\/\/calendly\.com\//.test(lead.booking_reschedule_url) ? lead.booking_reschedule_url : null,
    webinar,
  };
  // An edit made in Funnel HQ → Email editor replaces the built-in wording.
  const override = opts.override !== undefined ? opts.override : isEditable(template) ? (await loadOverrides(rt)).get(template) : undefined;
  let content = override ? fromOverride(override, ctx) : tpl(ctx);

  let personal: Personalized | null = null;
  if (opts.personalize) {
    const profile = await buildProfile(rt.env, lead);
    const used = await usedFacts(rt, lead.id);
    // Follow-up written from the application already says their answers back; personalise with what they did instead.
    if (template in FOLLOWUP_TEMPLATES) for (const k of ANSWER_FACTS) used.add(k);
    personal = await personalizeEmail(rt.settings, content, template, profile, used, {
      purpose: opts.personalize.purpose,
      callTime: lead.call_at ? formatCallTime(lead.call_at, tz) : null,
    });
    content = personal.content;
  }

  // Swap placeholders for signed, tracked redirect links.
  let serialized = JSON.stringify(content);
  for (const [placeholder, target] of tracked) {
    const sig = await linkSig(rt, emailId, target);
    const redirect = `${rt.origin}/r/${emailId}/${sig}?u=${encodeURIComponent(target)}`;
    serialized = serialized.split(placeholder).join(redirect);
  }
  const final = JSON.parse(serialized) as typeof content;

  const unsubscribeUrl = `${rt.origin}/u/${lead.id}/${await unsubscribeSig(rt, lead.id)}`;
  const { html, text } = renderEmail(final, {
    openPixel: `${rt.origin}/o/${emailId}.gif`,
    unsubscribeUrl,
    signature: rt.settings.EMAIL_SIGNATURE || 'Josh',
    address: rt.settings.BUSINESS_ADDRESS || rt.settings.SITE_NAME || BRAND.name,
  });
  return { subject: final.subject, html, text, unsubscribeUrl, personal };
}

/** The lead's webinar session, with their personal links, for webinar emails. */
async function webinarContext(rt: Runtime, lead: Lead, link: (path: string) => string) {
  if (!lead.webinar_token) return null;
  const reg = await getRegistration(rt, lead.webinar_token);
  const session = reg ? await getSession(rt, reg.session_id) : null;
  if (!reg || !session) return null;
  const w = webinarSettings(rt);
  const tz = await leadTimezone(rt, lead);
  return {
    title: session.title || w.title,
    when: formatCallTime(session.starts_at, tz),
    room: link(roomUrl(rt, reg.token)),
    replay: link(replayUrl(rt, reg.token)),
    ics: link(`${webinarBase(rt)}/ics/${reg.token}`),
    google: link(googleCalendarUrl(rt, session, reg)),
    replayHours: w.replayHours,
    durationMin: w.durationMin,
  };
}

/** Resend (https://resend.com/docs/api-reference/emails/send-email). Returns the provider message id. */
export async function sendViaResend(rt: Runtime, msg: { to: string; subject: string; html: string; text: string; unsubscribeUrl: string; tags?: Record<string, string> }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${rt.settings.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: rt.settings.EMAIL_FROM,
      to: [msg.to],
      reply_to: rt.settings.EMAIL_REPLY_TO || undefined,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      headers: { 'List-Unsubscribe': `<${msg.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      tags: Object.entries(msg.tags ?? {}).map(([name, value]) => ({ name, value: value.replace(/[^\w-]/g, '_') })),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`resend ${res.status}: ${body.message ?? 'unknown error'}`);
  return body.id ?? null;
}

export const emailConfigured = (rt: Runtime) => Boolean(rt.settings.RESEND_API_KEY && rt.settings.EMAIL_FROM);

interface QueueRow {
  id: string;
  lead_id: string;
  sequence: SequenceId;
  step: number;
  template: string;
  to_email: string;
  attempts: number;
}

/**
 * Sends everything that is due. Each row is claimed atomically (pending →
 * sending) so overlapping cron runs never double-send. Without an email
 * provider connected, messages are marked "simulated" so the whole flow can be
 * tested end to end from the dashboard.
 */
export async function processEmailQueue(rt: Runtime, limit = 50) {
  const now = Date.now();
  const { results } = await rt.env.DB.prepare(
    "SELECT id, lead_id, sequence, step, template, to_email, attempts FROM emails WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT ?",
  )
    .bind(now, limit)
    .all<QueueRow>();

  let sent = 0;
  const one = async (row: QueueRow) => {
    const claim = await rt.env.DB.prepare("UPDATE emails SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'").bind(row.id).run();
    if (!claim.meta.changes) return;

    const lead = await getLead(rt.env, row.lead_id);
    // Reactivation's stop rule needs when they were reactivated (kept in its own table).
    if (lead && row.sequence === 'reactivation') {
      const r = await rt.env.DB.prepare('SELECT reactivated_at, segment FROM lead_reactivation WHERE lead_id = ?').bind(lead.id).first<{ reactivated_at: number; segment: string | null }>();
      lead.reactivated_at = r?.reactivated_at ?? null;
      lead.reactivation_segment = r?.segment ?? null;
    }
    const seq = SEQUENCES[row.sequence];
    // Sequences that repeat per event (webinar: one block of steps per registration) map back with `cycle`.
    const step = seq?.steps[seq && 'cycle' in seq && seq.cycle ? row.step % seq.cycle : row.step];
    const skip = (reason: string) => rt.env.DB.prepare("UPDATE emails SET status = 'skipped', error = ? WHERE id = ?").bind(reason, row.id).run();

    if (!lead || !seq || !step) { await skip('missing lead or step'); return; }
    if (lead.unsubscribed_at) { await skip('unsubscribed'); return; }
    if ('stopIf' in seq && seq.stopIf?.(lead)) { await skip('sequence goal reached'); return; }
    if ('skipIf' in step && typeof step.skipIf === 'function' && step.skipIf(lead)) { await skip('step condition'); return; }

    try {
      const trigger = row.sequence === 'behaviour' ? RULES.find((r) => r.template === row.template) : undefined;
      const purpose = trigger ? `Triggered by what they just did: ${trigger.label}. Speak to exactly that.` : `${seq.description} (email ${row.step + 1})`;
      const email = await buildEmail(rt, lead, row.id, row.template, `seq-${row.sequence}`, { personalize: { purpose } });
      let providerId: string | null = null;
      let status = 'simulated';
      if (emailConfigured(rt)) {
        providerId = await sendViaResend(rt, { to: row.to_email, ...email, tags: { sequence: row.sequence, template: row.template } });
        status = 'sent';
      }
      await rt.env.DB.prepare('UPDATE emails SET status = ?, sent_at = ?, provider_id = ?, subject = ?, error = NULL, personalized = ?, facts_used = ?, personalize_error = ? WHERE id = ?')
        .bind(status, Date.now(), providerId, email.subject, email.personal?.mode ?? null, email.personal ? JSON.stringify(email.personal.factsUsed) : null, email.personal?.error ?? null, row.id)
        .run();
      await track(rt, await identityFromLead(rt.env, lead.id), {
        name: 'email_sent',
        source: 'cron',
        props: { email_id: row.id, sequence: row.sequence, template: row.template, simulated: status === 'simulated', personalized: email.personal?.mode ?? 'off' },
      });
      sent++;
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).slice(0, 500);
      const retry = row.attempts + 1 < MAX_ATTEMPTS;
      await rt.env.DB.prepare('UPDATE emails SET status = ?, error = ?, send_at = ? WHERE id = ?')
        .bind(retry ? 'pending' : 'failed', message, Date.now() + 10 * 60_000 * (row.attempts + 1), row.id)
        .run();
      console.error(`email ${row.id} failed`, message);
    }
  };
  // Personalisation calls the model, so send a few at a time. Same lead never twice in one batch (facts must not repeat).
  const queue = [...results];
  while (queue.length) {
    const batch: QueueRow[] = [];
    for (let i = 0; i < queue.length && batch.length < 6; ) {
      if (batch.some((b) => b.lead_id === queue[i].lead_id)) i++;
      else batch.push(...queue.splice(i, 1));
    }
    await Promise.all(batch.map(one));
  }
  return { due: results.length, sent };
}

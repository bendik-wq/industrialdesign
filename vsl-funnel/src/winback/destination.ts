import type { Runtime } from '../app';
import { challengeConfig, getDays, getCohort, nextCohort } from '../challenge/cohorts';
import { dayEnds, formatWhen, registrationOpen } from '../challenge/schedule';
import { getEvent, liveBase, liveSettings, nextEvent } from '../live/events';
import { passConfig } from '../webinar/pass';
import { jitSettings, openSessions, webinarBase, webinarSettings } from '../webinar/webinar';
import type { Destination } from './audience';

/**
 * Where a win-back campaign sends people, with its real date and price, read from our own tables at the moment
 * of sending. A dated destination that has passed ends the campaign; one the landing page isn't selling yet holds
 * the sends (the email names a date, and the page must show the same one).
 */
export interface Dest {
  kind: Destination;
  /** Sendable now. */
  ok: boolean;
  /** Not sendable right now, but may be later (held), or never again (closed). */
  held: string | null;
  closed: string | null;
  title: string;
  /** "the live session on Thursday 12 November" (mid-sentence). */
  short: string;
  when: string | null;
  startsAt: number | null;
  /** Registration closes at this moment (dated destinations). */
  closesAt: number | null;
  closesText: string | null;
  url: string;
  price: string | null;
  /** Challenge minutes per day / live length. */
  minutes: number | null;
  /** Live: hours the deposit offer stays open after the event. */
  offerHours: number | null;
  /** The deposit offer with the guarantees is what this destination sells. */
  guarantee: boolean;
  jitEvery: number | null;
}

const MIN = 60_000;
const tzOf = (rt: Runtime) => rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
const shortDate = (t: number, tz: string) => { try { return new Intl.DateTimeFormat(/^Australia|Pacific\/Auckland/.test(tz) ? 'en-AU' : 'en-US', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(t); } catch { return new Date(t).toDateString(); } };

export async function resolveDestination(rt: Runtime, kind: Destination, ref: string | null, now = Date.now()): Promise<Dest> {
  const tz = tzOf(rt);
  if (kind === 'live') {
    const ev = ref ? await getEvent(rt, ref) : null;
    const base: Dest = { kind, ok: false, held: null, closed: null, title: ev?.title ?? 'Live webinar', short: 'the live webinar', when: null, startsAt: null, closesAt: null, closesText: null, url: `${liveBase(rt)}/live`, price: liveSettings(rt).ticket?.label ?? null, minutes: ev?.duration_min ?? null, offerHours: liveSettings(rt).offerHours, guarantee: true, jitEvery: null };
    if (!ev) return { ...base, closed: 'Pick a live webinar for this campaign.' };
    const closesAt = ev.starts_at + 30 * MIN;
    const when = formatWhen(ev.starts_at, ev.tz || tz);
    const out: Dest = { ...base, title: ev.title, when, startsAt: ev.starts_at, closesAt, closesText: 'Registration closes 30 minutes after it starts.', short: `the live webinar on ${shortDate(ev.starts_at, ev.tz || tz)}` };
    if (ev.status !== 'scheduled') return { ...out, closed: 'That live webinar was cancelled.' };
    if (now >= closesAt) return { ...out, closed: 'That live webinar has started or passed.' };
    const next = await nextEvent(rt, now);
    if (next && next.id !== ev.id) return { ...out, held: `The /live page sells "${next.title}" first. Sends wait until it shows this webinar.` };
    return { ...out, ok: true };
  }
  if (kind === 'challenge') {
    const co = ref ? await getCohort(rt, ref) : null;
    const cfg = challengeConfig(rt.settings);
    const base: Dest = { kind, ok: false, held: null, closed: null, title: 'The First Deal Challenge', short: 'the First Deal Challenge', when: null, startsAt: null, closesAt: null, closesText: null, url: `${rt.origin}/challenge`, price: cfg.free ? null : cfg.ticketLabel, minutes: co?.duration_min ?? cfg.durationMin, offerHours: cfg.offerHours, guarantee: true, jitEvery: null };
    if (!co) return { ...base, closed: 'Pick a challenge cohort for this campaign.' };
    const days = await getDays(rt, co.id);
    const d1 = days.find((d) => d.day === 1);
    if (!d1) return { ...base, closed: 'That cohort has no days scheduled.' };
    const out: Dest = { ...base, title: `The First Deal Challenge (${co.name})`, when: formatWhen(d1.starts_at, co.timezone), startsAt: d1.starts_at, closesAt: dayEnds(d1), closesText: 'Registration closes when Day 1 ends.', short: `the First Deal Challenge starting ${shortDate(d1.starts_at, co.timezone)}`, minutes: d1.duration_min };
    if (co.status !== 'scheduled') return { ...out, closed: 'That cohort was cancelled.' };
    if (!registrationOpen(days, co.status, now)) return { ...out, closed: 'Registration for that cohort has closed.' };
    const next = await nextCohort(rt, now);
    if (next && next.cohort.id !== co.id) return { ...out, held: `The /challenge page sells "${next.cohort.name}" first. Sends wait until it shows this cohort.` };
    return { ...out, ok: true };
  }
  // The automated masterclass: the next scheduled showing, or just-in-time showings through the day.
  const w = webinarSettings(rt);
  const seat = passConfig(rt.settings).seat;
  const [next] = await openSessions(rt, 1).catch(() => []);
  const jit = jitSettings(rt).every || null;
  const base: Dest = { kind, ok: true, held: null, closed: null, title: w.title, short: 'the Masterclass', when: null, startsAt: null, closesAt: null, closesText: null, url: `${webinarBase(rt)}/`, price: seat?.label ?? null, minutes: w.durationMin, offerHours: null, guarantee: false, jitEvery: jit };
  if (next && next.starts_at > now) return { ...base, when: formatWhen(next.starts_at, tz), startsAt: next.starts_at };
  if (jit) return base;
  return { ...base, ok: false, held: 'No masterclass showing is scheduled and just-in-time showings are off.' };
}

/** The destination link with the win-back UTMs (utm_campaign = the campaign id, so attribution credits it). */
export function destinationLink(url: string, campaignId: string, step: number | 'test') {
  const u = new URL(url);
  u.searchParams.set('utm_source', 'email');
  u.searchParams.set('utm_medium', step === 'test' ? 'winback_test' : 'winback');
  u.searchParams.set('utm_campaign', campaignId);
  u.searchParams.set('utm_content', step === 'test' ? 'test' : `wb${step + 1}`);
  return u.toString();
}

/** Upcoming live webinars and challenge cohorts for the destination picker (the next one marked). */
export async function destinationOptions(rt: Runtime, now = Date.now()) {
  const db = rt.env.DB;
  const tz = tzOf(rt);
  const [events, cohorts, nextEv, nextCo] = await Promise.all([
    db.prepare("SELECT id, title, starts_at, tz FROM live_webinars WHERE status = 'scheduled' AND starts_at > ? ORDER BY starts_at LIMIT 20").bind(now - 30 * MIN).all<{ id: string; title: string; starts_at: number; tz: string }>().then((r) => r.results).catch(() => []),
    db.prepare(`SELECT c.id, c.name, c.timezone, d.starts_at, d.duration_min FROM challenge_cohorts c JOIN challenge_days d ON d.cohort_id = c.id AND d.day = 1
                 WHERE c.status = 'scheduled' AND d.starts_at + d.duration_min * 60000 > ? ORDER BY d.starts_at LIMIT 20`).bind(now).all<{ id: string; name: string; timezone: string; starts_at: number; duration_min: number }>().then((r) => r.results).catch(() => []),
    nextEvent(rt, now).catch(() => null),
    nextCohort(rt, now).catch(() => null),
  ]);
  const w = webinarSettings(rt);
  const [session] = await openSessions(rt, 1).catch(() => []);
  return {
    masterclass: { title: w.title, next: session ? formatWhen(session.starts_at, tz) : null, jitEvery: jitSettings(rt).every || null, price: passConfig(rt.settings).seat?.label ?? null, url: `${webinarBase(rt)}/` },
    events: events.map((e) => ({ id: e.id, title: e.title, when: formatWhen(e.starts_at, e.tz || tz), starts_at: e.starts_at, next: nextEv?.id === e.id })),
    cohorts: cohorts.map((c) => ({ id: c.id, name: c.name, when: formatWhen(c.starts_at, c.timezone), starts_at: c.starts_at, next: nextCo?.cohort.id === c.id })),
  };
}

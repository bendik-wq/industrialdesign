import type { Runtime } from '../app';
import type { VisitorCtx } from '../lib/identity';
import { type Lead, getLead, normalisePhone, updateLead } from '../funnel/leads';
import { hmacHex, unitHash } from '../lib/crypto';
import { getSecret } from '../lib/secret';
import { formatCallTime } from '../integrations/email';
import { identityFromLead, track } from '../tracking/track';
import { type LiveEvent, type LiveReg, eventEnd, getEvent, liveBase, liveRoomUrl, liveSettings, offerWindow } from './events';
import { type IcsEvent, buildIcs, googleUrl, outlookUrl, validTz } from './calendar';
import {
  AB_KINDS, DAY, HOUR, MIN, REFERRAL_CAP_DEFAULT, REFERRAL_REASONS, REMINDER_COPY, type FunnelRow, type PostKind, type ReminderKind, SUBJECT_B, VIA_LABEL, WAITING_ROOM_MIN,
  cameBackVia, cleanVia, duePost, parseCadence, parseQuiet, parseSlides, postEmail, refCode, referralVerdict, showUpFunnel, textAllowed, variantOf,
} from './lifecycle';

/**
 * Builder E "lifecycle": the I/O around the pure rules in lifecycle.ts. Own tables (migration 0060): lc_events,
 * lc_regs, lc_referrals, lc_touches. Called from events.ts (registration, reminders, the cron, event saves),
 * pages.ts (the pre-show page, tracked returns) and the routes in lifecycle-pages.ts.
 */

type S = Partial<Record<string, string>>;
export interface LcEvent { event_id: string; ics_seq: number; rv: number; starts_at: number | null; video_url: string | null; slides: string | null; cadence: string | null; subject_ab: number; notice_at: number | null; updated_at: number }
export interface LcReg {
  reg_id: string; event_id: string; lead_id: string; tz: string | null; cal_added_at: number | null; cal_kind: string | null; sms_optin_at: number | null; question: string | null; question_at: number | null;
  worksheet: string | null; worksheet_at: number | null; preshow_at: number | null; ref_code: string | null; ref_clicks: number; referred_by: string | null; ip_hash: string | null; visitor_id: string | null; created_at: number;
}

/** The emails sequence for an event's reminders: 'live' until the start moves, then 'live.v1', 'live.v2'... (reminders run again for the new time). */
export const liveSeq = (rv: number) => (rv > 0 ? `live.v${rv}` : 'live');
/** This module's own emails for one event (cancellation, the post-event paths). */
export const lcSeq = (eventId: string) => `lc:${eventId}`;
export const POST_STEP: Record<PostKind, number> = { buyer_docs: 2, nobuy_questions: 3, noshow_highlights: 4 };
const CANCEL_STEP = 100;

export function lcSettings(rt: Pick<Runtime, 'settings'>) {
  const s = rt.settings as S;
  const cap = Number(String(s.LC_REFERRAL_CAP ?? '').trim());
  const unlock = String(s.LC_REFERRAL_UNLOCK ?? '').trim().toLowerCase();
  return {
    quiet: parseQuiet(s.LC_QUIET_HOURS),
    referralCap: Number.isFinite(cap) && cap > 0 && cap <= 1000 ? Math.round(cap) : REFERRAL_CAP_DEFAULT,
    referralUnlock: /^(off|none)$/.test(unlock) ? null : unlock || 'scripts',
    referralsOn: !/^(off|false|0|no)$/i.test(String(s.LC_REFERRALS ?? '').trim()),
  };
}

// ───────────── rows ─────────────

const blankEvent = (eventId: string): LcEvent => ({ event_id: eventId, ics_seq: 0, rv: 0, starts_at: null, video_url: null, slides: null, cadence: null, subject_ab: 0, notice_at: null, updated_at: 0 });
const evCache = new Map<string, { at: number; row: LcEvent }>();
export async function lcEvent(rt: Pick<Runtime, 'env'>, eventId: string, fresh = false): Promise<LcEvent> {
  const c = evCache.get(eventId);
  if (!fresh && c && Date.now() - c.at < 20_000 && c.at <= Date.now()) return c.row;
  const row = (await rt.env.DB.prepare('SELECT * FROM lc_events WHERE event_id = ?').bind(eventId).first<LcEvent>()) ?? blankEvent(eventId);
  evCache.set(eventId, { at: Date.now(), row });
  return row;
}
export const lcReg = (rt: Pick<Runtime, 'env'>, regId: string) => rt.env.DB.prepare('SELECT * FROM lc_regs WHERE reg_id = ?').bind(regId).first<LcReg>();
const newCode = () => refCode(crypto.getRandomValues(new Uint8Array(8)));
/** The lifecycle row for a registration (made on first use for registrations from before migration 0060). */
export async function ensureLcReg(rt: Pick<Runtime, 'env'>, reg: Pick<LiveReg, 'id' | 'event_id' | 'lead_id' | 'created_at'>, extra: Partial<LcReg> = {}) {
  const cur = await lcReg(rt, reg.id);
  if (cur) return cur;
  for (let i = 0; i < 3; i++) {
    const r = await rt.env.DB.prepare('INSERT OR IGNORE INTO lc_regs (reg_id, event_id, lead_id, tz, ip_hash, visitor_id, ref_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(reg.id, reg.event_id, reg.lead_id, extra.tz ?? null, extra.ip_hash ?? null, extra.visitor_id ?? null, newCode(), reg.created_at).run().catch(() => ({ meta: { changes: 0 } }));
    if (r.meta.changes) break;
    if (await lcReg(rt, reg.id)) break;
  }
  return (await lcReg(rt, reg.id))!;
}
export async function ipHash(rt: Pick<Runtime, 'env'>, ip: string | null | undefined) {
  if (!ip) return null;
  return (await hmacHex(await getSecret(rt.env), `lcip|${ip}`)).slice(0, 24);
}

// ───────────── registration and referrals ─────────────

/** After registerLive: the lifecycle row (zone, connection hash, referral code) and the referral verdict. */
export async function onRegistered(rt: Runtime, v: VisitorCtx, reg: LiveReg, lead: Lead, body: Record<string, unknown>) {
  const ip = await ipHash(rt, v.ip);
  const row = await ensureLcReg(rt, reg, { tz: validTz(body.tz) ?? v.geo.timezone ?? null, ip_hash: ip, visitor_id: v.visitorId });
  const code = typeof body.ref === 'string' && /^[a-z2-9]{6,12}$/.test(body.ref) ? body.ref : null;
  if (!code || !lcSettings(rt).referralsOn) return row;
  const ref = await rt.env.DB.prepare('SELECT c.*, l.email FROM lc_regs c JOIN leads l ON l.id = c.lead_id WHERE c.ref_code = ?').bind(code).first<LcReg & { email: string | null }>();
  if (!ref || ref.reg_id === reg.id) return row;
  const counted = await rt.env.DB.prepare("SELECT COUNT(*) AS n FROM lc_referrals WHERE referrer_reg_id = ? AND status IN ('counted', 'attended')").bind(ref.reg_id).first<{ n: number }>();
  const verdict = referralVerdict(
    { lead_id: ref.lead_id, event_id: ref.event_id, ip_hash: ref.ip_hash, visitor_id: ref.visitor_id, email: ref.email },
    { lead_id: lead.id, event_id: reg.event_id, ip_hash: ip, visitor_id: v.visitorId, email: lead.email },
    counted?.n ?? 0, lcSettings(rt).referralCap,
  );
  await rt.env.DB.batch([
    rt.env.DB.prepare('INSERT OR IGNORE INTO lc_referrals (referred_reg_id, referrer_reg_id, event_id, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(reg.id, ref.reg_id, reg.event_id, verdict.status, verdict.status === 'rejected' ? verdict.reason : null, Date.now()),
    rt.env.DB.prepare('UPDATE lc_regs SET referred_by = ? WHERE reg_id = ?').bind(ref.reg_id, reg.id),
  ]);
  await track(rt, await identityFromLead(rt.env, lead.id), { name: 'live_referred', source: 'server', path: '/live', props: { event_id: reg.event_id, counted: verdict.status === 'counted', reason: verdict.status === 'rejected' ? verdict.reason : null }, localOnly: true }).catch(() => null);
  return row;
}

/** /live/i/:code → the landing with the code and referral UTMs (the existing attribution records the source). */
export async function referralTarget(rt: Runtime, code: string) {
  if (!/^[a-z2-9]{6,12}$/.test(code)) return null;
  const row = await rt.env.DB.prepare('SELECT reg_id, event_id FROM lc_regs WHERE ref_code = ?').bind(code).first<{ reg_id: string; event_id: string }>();
  if (!row) return null;
  await rt.env.DB.prepare('UPDATE lc_regs SET ref_clicks = ref_clicks + 1 WHERE ref_code = ?').bind(code).run();
  const u = new URL(`${liveBase(rt)}/live`);
  u.searchParams.set('ref', code);
  u.searchParams.set('utm_source', 'referral');
  u.searchParams.set('utm_medium', 'owner_referral');
  u.searchParams.set('utm_campaign', row.event_id);
  return u.toString();
}
export async function referralStats(rt: Pick<Runtime, 'env'>, regId: string) {
  const r = await rt.env.DB.prepare("SELECT SUM(status IN ('counted', 'attended')) AS registered, SUM(status = 'attended') AS attended FROM lc_referrals WHERE referrer_reg_id = ?").bind(regId).first<{ registered: number | null; attended: number | null }>();
  return { registered: Number(r?.registered ?? 0), attended: Number(r?.attended ?? 0) };
}

/** The cron: referred people who attended earn their referrer points and the unlock (rooms only: points live in the event's room). */
export async function rewardReferrals(rt: Runtime, now = Date.now()) {
  const db = rt.env.DB;
  const { results } = await db.prepare(
    `SELECT f.referred_reg_id, f.referrer_reg_id, f.event_id, rr.lead_id AS referrer_lead FROM lc_referrals f
       JOIN live_webinar_regs r ON r.id = f.referred_reg_id JOIN live_webinar_regs rr ON rr.id = f.referrer_reg_id
      WHERE f.status = 'counted' AND r.joined_at IS NOT NULL LIMIT 200`,
  ).all<{ referred_reg_id: string; referrer_reg_id: string; event_id: string; referrer_lead: string }>();
  let n = 0;
  for (const x of results) {
    const claim = await db.prepare("UPDATE lc_referrals SET status = 'attended', rewarded_at = ? WHERE referred_reg_id = ? AND status = 'counted'").bind(now, x.referred_reg_id).run();
    if (!claim.meta.changes) continue;
    n++;
    const room = await db.prepare("SELECT id, ref_type, ref_id, title FROM rooms WHERE ref_type = 'live' AND ref_id = ?").bind(x.event_id).first<{ id: string; ref_type: 'live'; ref_id: string; title: string }>();
    if (!room) continue;
    const { awardPoints, engageConfig, grantUnlocks } = await import('../rooms/engage-db');
    const { memberId } = await import('../rooms/rooms');
    const who = { id: memberId('reg', x.referrer_reg_id), leadId: x.referrer_lead, regId: x.referrer_reg_id };
    await awardPoints(rt, room, [{ who, action: 'referral', key: x.referred_reg_id }], engageConfig(rt).rules, now).catch((e) => console.error('referral points', e));
    const asset = lcSettings(rt).referralUnlock;
    if (asset) await grantUnlocks(rt, room, who, [asset], 'points', now).catch((e) => console.error('referral unlock', e));
  }
  return n;
}

// ───────────── calendar ─────────────

export function calEvent(rt: Pick<Runtime, 'settings' | 'origin'>, ev: LiveEvent, reg: Pick<LiveReg, 'id' | 'token'>, lc: Pick<LcEvent, 'ics_seq'>): IcsEvent {
  const room = `${liveRoomUrl(rt, reg.token)}?via=cal`;
  const host = (() => { try { return new URL(liveBase(rt)).host; } catch { return 'live'; } })();
  return {
    uid: `${reg.id}@${host}`, seq: lc.ics_seq, start: ev.starts_at, end: eventEnd(ev), tz: validTz(ev.tz) ?? 'UTC', title: ev.title,
    description: `Your personal room link: ${room}\nThe waiting room opens ${WAITING_ROOM_MIN} minutes before the start. Keep this link to yourself: it is your seat.`,
    url: room, cancelled: ev.status === 'cancelled', alarmMin: 15,
  };
}
export const calLinks = (rt: Pick<Runtime, 'settings' | 'origin'>, token: string) => {
  const b = `${liveBase(rt)}/live/cal/${token}`;
  return { google: `${b}/google`, outlook: `${b}/outlook`, apple: `${b}/apple`, ics: `${b}/ics` };
};
/** /live/cal/:token/:kind → the provider (recorded as "added to a calendar"), or the .ics file itself. */
export async function calendarFor(rt: Runtime, ev: LiveEvent, reg: LiveReg, kind: string) {
  const lc = await lcEvent(rt, ev.id, true);
  const e = calEvent(rt, ev, reg, lc);
  if (ev.status !== 'cancelled' && ['google', 'outlook', 'apple', 'ics'].includes(kind)) {
    const row = await ensureLcReg(rt, reg);
    await rt.env.DB.prepare('UPDATE lc_regs SET cal_added_at = COALESCE(cal_added_at, ?), cal_kind = COALESCE(cal_kind, ?) WHERE reg_id = ?').bind(Date.now(), kind, row.reg_id).run();
  }
  if (kind === 'google') return { redirect: googleUrl(e) };
  if (kind === 'outlook') return { redirect: outlookUrl(e) };
  if (kind === 'apple' || kind === 'ics') return { ics: buildIcs([e]), inline: kind === 'apple' };
  return null;
}

// ───────────── reminders: hooks from events.ts ─────────────

/** What events.ts needs per registration: the person's zone, the cadence, the sequence, the calendar links, the subject variant. */
export async function reminderCtx(rt: Runtime, ev: LiveEvent, reg: LiveReg, lead: Lead) {
  const lc = await lcEvent(rt, ev.id);
  const row = await lcReg(rt, reg.id);
  const tz = row?.tz || lead.timezone || ev.tz;
  const variant = lc.subject_ab ? variantOf(await unitHash(`lcsubj:${ev.id}:${reg.id}`)) : 'a';
  return { lc, tz, quiet: lcSettings(rt).quiet, cadence: parseCadence(lc.cadence), seq: liveSeq(lc.rv), rescheduled: lc.rv > 0, variant, calendar: ev.status === 'scheduled' ? calLinks(rt, reg.token) : null };
}
/** The B subject for a reminder under test, or null. */
export function subjectFor(k: string, variant: 'a' | 'b', x: { title: string; when: string }) {
  const f = variant === 'b' ? SUBJECT_B[k as ReminderKind] : undefined;
  return f && AB_KINDS.includes(k as ReminderKind) ? f(x) : null;
}
export { REMINDER_COPY };

/** Whether a text may go now (no AI call to this person within the gap). */
export async function textClear(rt: Pick<Runtime, 'env'>, leadId: string, at: number) {
  const { results } = await rt.env.DB.prepare('SELECT run_at, status, kind, wc_dialed_at FROM outbound_calls WHERE lead_id = ? AND run_at BETWEEN ? AND ?').bind(leadId, at - 2 * HOUR, at + 2 * HOUR)
    .all<{ run_at: number; status: string; kind: string; wc_dialed_at: number | null }>().catch(() => ({ results: [] as { run_at: number; status: string; kind: string; wc_dialed_at: number | null }[] }));
  return textAllowed(at, results);
}
/** For the AI call queue: the times of texts sent to this person around `at`. */
export async function textsNear(rt: Pick<Runtime, 'env'>, leadId: string, at: number) {
  const { results } = await rt.env.DB.prepare("SELECT sent_at FROM sms_messages WHERE lead_id = ? AND direction = 'out' AND status IN ('sent', 'simulated', 'sending') AND sent_at BETWEEN ? AND ?")
    .bind(leadId, at - HOUR, at + HOUR).all<{ sent_at: number }>().catch(() => ({ results: [] as { sent_at: number }[] }));
  return results.map((r) => r.sent_at).filter(Boolean);
}

// ───────────── after the event ─────────────

export async function sendPost(rt: Runtime, ev: LiveEvent, reg: LiveReg, lead: Lead, now = Date.now()) {
  const w = offerWindow(ev, now, liveSettings(rt).offerHours);
  if (now < w.end) return 0;
  const bought = await rt.env.DB.prepare("SELECT paid_at FROM webinar_passes WHERE lead_id = ? AND kind = 'deposit' AND status = 'paid' ORDER BY paid_at DESC LIMIT 1").bind(lead.id).first<{ paid_at: number | null }>();
  const due = duePost({ now, end: w.end, attended: Boolean(reg.joined_at), boughtAt: bought ? bought.paid_at ?? now : null, offerOpened: w.opened, offerOpen: w.open, closesAt: w.closesAt, replayClosesAt: w.replayClosesAt });
  if (!due.length) return 0;
  const { sendOnce } = await import('./mail');
  const { safeFirstName } = await import('../lib/text');
  const { depositConfig, onboardingUrl } = await import('../sales/deposit');
  const row = await lcReg(rt, reg.id);
  const tz = row?.tz || lead.timezone || ev.tz;
  let sent = 0;
  for (const k of due) {
    if (k !== 'buyer_docs' && lead.unsubscribed_at) continue;
    const x = {
      name: safeFirstName(lead.first_name) ?? 'there', title: ev.title, room: `${replayHref(rt, reg)}?via=e-${k}`, closes: w.open ? formatCallTime(w.closesAt, tz) : null,
      deposit: depositConfig(rt).label, onboarding: onboardingUrl(rt), highlights: await highlights(rt, ev), replayCloses: now < w.replayClosesAt ? formatCallTime(w.replayClosesAt, tz) : null,
      // Payment links: the deposit button opens their own prefilled checkout while the offer is open.
      pay: w.open ? await (await import('../sales/paylinks')).depositLinkFor(rt, { leadId: lead.id, source: 'live', ref: ev.id }).catch(() => null) : null,
    };
    if (await sendOnce(rt, lead, lcSeq(ev.id), reg.seq * 10 + POST_STEP[k], `lc_${k}`, postEmail(k, x), { unsubscribe: k !== 'buyer_docs' })) sent++;
  }
  return sent;
}
/** The replay: the personal room link (it shows the replay, and closes it with the offer, on the server's clock). */
export const replayHref = (rt: Pick<Runtime, 'settings' | 'origin'>, reg: Pick<LiveReg, 'token'>) => liveRoomUrl(rt, reg.token);
/** The agenda's points for the highlights email: the room's own agenda when the event ran in our room. */
async function highlights(rt: Runtime, ev: LiveEvent) {
  const { DEFAULT_AGENDA } = await import('../rooms/engage');
  let agenda = DEFAULT_AGENDA;
  if (ev.platform === 'room') {
    const room = await rt.env.DB.prepare("SELECT engage FROM rooms WHERE ref_type = 'live' AND ref_id = ?").bind(ev.id).first<{ engage: string | null }>();
    if (room) agenda = (await import('../rooms/engage-db')).roomEngageSettings(room).agenda;
  }
  return agenda.filter((a) => a.teaser).map((a) => a.teaser.replace(/\.$/, '')).slice(1, 6);
}

// ───────────── event saves: reschedule and cancel ─────────────

/** saveEvent calls this: a new start (or length, title, status) bumps the calendar SEQUENCE; a new start re-runs the reminders; a cancel emails everyone. */
export async function onEventSaved(rt: Runtime, prev: LiveEvent | null, next: LiveEvent) {
  const db = rt.env.DB;
  const now = Date.now();
  const cur = await lcEvent(rt, next.id, true);
  const exists = Boolean(await db.prepare('SELECT 1 FROM lc_events WHERE event_id = ?').bind(next.id).first());
  if (!exists) await db.prepare('INSERT OR IGNORE INTO lc_events (event_id, starts_at, updated_at) VALUES (?, ?, ?)').bind(next.id, next.starts_at, now).run();
  if (!prev) { evCache.delete(next.id); return { seq: 0, rv: 0, moved: false, cancelled: false }; }
  const moved = prev.starts_at !== next.starts_at && next.status === 'scheduled';
  const cancelled = prev.status !== 'cancelled' && next.status === 'cancelled';
  const changed = moved || cancelled || prev.duration_min !== next.duration_min || prev.title !== next.title || (prev.status === 'cancelled' && next.status === 'scheduled');
  if (!changed) return { seq: cur.ics_seq, rv: cur.rv, moved: false, cancelled: false };
  await db.prepare('UPDATE lc_events SET ics_seq = ics_seq + 1, rv = rv + ?, starts_at = ?, updated_at = ? WHERE event_id = ?').bind(moved ? 1 : 0, next.starts_at, now, next.id).run();
  evCache.delete(next.id);
  const lc = await lcEvent(rt, next.id, true);
  if (cancelled) rt.waitUntil(sendCancellations(rt, next, lc).then(() => undefined));
  // A new time: the confirmation goes again under the new reminder version, worded as the new time, with the updated calendar entry.
  if (moved) rt.waitUntil((async () => {
    const { sendDueMessages } = await import('./events');
    const { results } = await db.prepare('SELECT * FROM live_webinar_regs WHERE event_id = ? LIMIT 5000').bind(next.id).all<LiveReg>();
    for (const reg of results) { const lead = await getLead(rt.env, reg.lead_id); if (lead) await sendDueMessages(rt, next, reg, lead).catch((e) => console.error('reschedule notice', e)); }
  })().catch((e) => console.error('reschedule notices', e)));
  return { seq: lc.ics_seq, rv: lc.rv, moved, cancelled };
}
async function sendCancellations(rt: Runtime, ev: LiveEvent, lc: LcEvent) {
  const { results } = await rt.env.DB.prepare('SELECT * FROM live_webinar_regs WHERE event_id = ? LIMIT 5000').bind(ev.id).all<LiveReg>();
  const { sendOnce } = await import('./mail');
  const { safeFirstName } = await import('../lib/text');
  let n = 0;
  for (const reg of results) {
    const lead = await getLead(rt.env, reg.lead_id);
    if (!lead?.email) continue;
    const links = calLinks(rt, reg.token);
    const ok = await sendOnce(rt, lead, lcSeq(ev.id), reg.seq * 10 + CANCEL_STEP + lc.ics_seq, 'lc_cancelled', {
      subject: REMINDER_COPY.cancelledSubject(ev.title), preheader: 'Josh’s team emails you the new date.', heading: 'This session is cancelled',
      paras: [`Hi ${safeFirstName(lead.first_name) ?? 'there'},`, REMINDER_COPY.cancelled({ title: ev.title })], button: { label: 'Remove it from my calendar', href: links.ics },
    });
    if (ok) n++;
  }
  await rt.env.DB.prepare('UPDATE lc_events SET notice_at = ? WHERE event_id = ?').bind(Date.now(), ev.id).run();
  return n;
}

// ───────────── tracked returns ─────────────

/** A click from a reminder (?via=…) to the person's room: who came back from which reminder. */
export async function touch(rt: Pick<Runtime, 'env'>, reg: Pick<LiveReg, 'id' | 'event_id'>, raw: unknown, now = Date.now()) {
  const via = cleanVia(raw);
  if (!via) return false;
  const recent = await rt.env.DB.prepare('SELECT 1 FROM lc_touches WHERE reg_id = ? AND via = ? AND at > ?').bind(reg.id, via, now - 10 * MIN).first();
  if (recent) return false;
  await rt.env.DB.prepare('INSERT INTO lc_touches (reg_id, event_id, via, at) VALUES (?, ?, ?, ?)').bind(reg.id, reg.event_id, via, now).run();
  return true;
}

// ───────────── the confirmation page's saves ─────────────

const plain = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export async function saveTz(rt: Runtime, reg: LiveReg, tz: unknown) {
  const z = validTz(tz);
  if (!z) return { ok: false as const };
  await ensureLcReg(rt, reg);
  await rt.env.DB.prepare('UPDATE lc_regs SET tz = ?, preshow_at = COALESCE(preshow_at, ?) WHERE reg_id = ?').bind(z, Date.now(), reg.id).run();
  return { ok: true as const };
}

export async function saveQuestion(rt: Runtime, reg: LiveReg, text: unknown) {
  const ev = await getEvent(rt, reg.event_id);
  const q = plain(text, 400);
  if (!ev || ev.status !== 'scheduled' || Date.now() >= eventEnd(ev)) return { ok: false as const, error: 'Questions for this session have closed.' };
  if (q.length < 8) return { ok: false as const, error: 'Write your question in a sentence.' };
  if (/https?:\/\/|www\./i.test(q)) return { ok: false as const, error: 'Please leave links out of your question.' };
  await ensureLcReg(rt, reg);
  await rt.env.DB.prepare('UPDATE lc_regs SET question = ?, question_at = ? WHERE reg_id = ?').bind(q, Date.now(), reg.id).run();
  return { ok: true as const };
}

/** The pre-event worksheet: kept on the registration and seeded into the Deal Plan in the event's room (data only: the steps, and their points, count in the room). */
export async function saveWorksheet(rt: Runtime, reg: LiveReg, raw: unknown) {
  const { cleanPlan } = await import('../rooms/engage');
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const data = cleanPlan({ industry: r.industry, size: r.size, geography: r.geography, owners_per_week: r.owners_per_week, action_1: r.action_1 });
  if (!data.industry && !data.size && !data.geography && !data.owners_per_week && !data.action_1) return { ok: false as const, error: 'Fill in at least one answer.' };
  await ensureLcReg(rt, reg);
  const now = Date.now();
  await rt.env.DB.prepare('UPDATE lc_regs SET worksheet = ?, worksheet_at = ? WHERE reg_id = ?').bind(JSON.stringify(data), now, reg.id).run();
  await seedPlan(rt, reg, data, now);
  return { ok: true as const };
}
async function seedPlan(rt: Runtime, reg: LiveReg, data: object, now: number) {
  const ev = await getEvent(rt, reg.event_id);
  if (!ev || ev.platform !== 'room') return;
  const { ensureRoomFor, memberId } = await import('../rooms/rooms');
  const room = await ensureRoomFor(rt, 'live', ev.id, { title: ev.title, startsAt: ev.starts_at, durationMin: ev.duration_min });
  const who = memberId('reg', reg.id);
  const cur = await rt.env.DB.prepare('SELECT data FROM room_plans WHERE room_id = ? AND who = ?').bind(room.id, who).first<{ data: string }>();
  let merged: Record<string, string> = {};
  try { merged = JSON.parse(cur?.data ?? '{}') ?? {}; } catch { merged = {}; }
  for (const [k, v] of Object.entries(data as Record<string, string>)) if (v && !merged[k]) merged[k] = v; // never overwrite what they wrote in the room
  await rt.env.DB.prepare(
    `INSERT INTO room_plans (room_id, who, lead_id, reg_id, data, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)
     ON CONFLICT(room_id, who) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).bind(room.id, who, reg.lead_id, reg.id, JSON.stringify(merged), now, now).run();
}

/** "Remind me by text": one tap on the confirmation page, with the consent wording next to the button. */
export async function smsOptIn(rt: Runtime, reg: LiveReg, body: Record<string, unknown>, country: string | null) {
  const lead = await getLead(rt.env, reg.lead_id);
  if (!lead) return { ok: false as const, error: 'Registration not found' };
  if (lead.sms_opt_out_at) return { ok: false as const, error: 'stopped' };
  const typed = typeof body.phone === 'string' && body.phone.trim() ? normalisePhone(body.phone, country ?? lead.country) : null;
  if (typeof body.phone === 'string' && body.phone.trim() && !typed) return { ok: false as const, error: 'Please enter a valid mobile number, including area code.' };
  const phone = typed ?? lead.phone;
  if (!phone) return { ok: false as const, error: 'Please enter your mobile number.' };
  if (lead.phone && typed && typed !== lead.phone) return { ok: false as const, error: 'This registration has a different number on file. Reply to any of our emails to change it.' };
  const now = Date.now();
  await updateLead(rt.env, lead.id, { ...(lead.phone ? {} : { phone }), ...(lead.sms_consent_at ? {} : { sms_consent_at: now }) });
  await rt.env.DB.prepare('UPDATE live_webinar_regs SET sms_ok = 1 WHERE id = ?').bind(reg.id).run();
  await ensureLcReg(rt, reg);
  await rt.env.DB.prepare('UPDATE lc_regs SET sms_optin_at = COALESCE(sms_optin_at, ?) WHERE reg_id = ?').bind(now, reg.id).run();
  await track(rt, await identityFromLead(rt.env, lead.id), { name: 'live_sms_optin', source: 'server', path: '/live', props: { event_id: reg.event_id }, localOnly: true }).catch(() => null);
  return { ok: true as const };
}

// ───────────── for the AI co-host and the host ─────────────

/** Pre-session questions for an event (the host's Q&A list and the AI co-host's context). */
export async function preQuestions(rt: Pick<Runtime, 'env'>, eventId: string, limit = 200) {
  const { results } = await rt.env.DB.prepare(
    `SELECT c.reg_id, c.question, c.question_at, l.first_name FROM lc_regs c JOIN leads l ON l.id = c.lead_id WHERE c.event_id = ? AND c.question IS NOT NULL ORDER BY c.question_at LIMIT ?`,
  ).bind(eventId, limit).all<{ reg_id: string; question: string; question_at: number; first_name: string | null }>();
  const { safeFirstName } = await import('../lib/text');
  return results.map((r) => ({ id: r.reg_id, name: safeFirstName(r.first_name) ?? 'An owner', text: r.question, at: r.question_at }));
}
/** A plain-text block for the AI co-host's context: what registrants asked and what their worksheets say (first names only). */
export async function preShowContext(rt: Pick<Runtime, 'env'>, eventId: string) {
  const qs = await preQuestions(rt, eventId, 60);
  const { results } = await rt.env.DB.prepare('SELECT worksheet FROM lc_regs WHERE event_id = ? AND worksheet IS NOT NULL LIMIT 300').bind(eventId).all<{ worksheet: string }>();
  const inds = new Map<string, number>();
  for (const r of results) { try { const w = JSON.parse(r.worksheet) as { industry?: string }; const k = (w.industry ?? '').toLowerCase().trim(); if (k) inds.set(k, (inds.get(k) ?? 0) + 1); } catch { /* skip */ } }
  const top = [...inds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} (${n})`);
  if (!qs.length && !top.length) return '';
  return [
    'Before the session (real registrants; first names only):',
    ...qs.map((q) => `- ${q.name} asked: ${q.text}`),
    ...(top.length ? [`Industries from ${results.length} pre-session worksheets: ${top.join(', ')}.`] : []),
  ].join('\n');
}

// ───────────── Funnel HQ: the show-up funnel ─────────────

export async function lifecycleReport(rt: Runtime, eventId: string) {
  const ev = await getEvent(rt, eventId);
  if (!ev) return null;
  const db = rt.env.DB;
  const lc = await lcEvent(rt, eventId, true);
  const half = Math.max(1, Math.round(ev.duration_min / 2));
  const [regsR, emailsR, smsR, touchesR, passesR, roomR, presR, refR] = await db.batch([
    db.prepare(`SELECT r.id, r.lead_id, r.seq, r.joined_at, r.created_at, c.cal_added_at, c.cal_kind, c.sms_optin_at, c.question, c.worksheet_at, c.referred_by, c.ref_clicks, l.first_name, l.last_name, l.email
                  FROM live_webinar_regs r JOIN leads l ON l.id = r.lead_id LEFT JOIN lc_regs c ON c.reg_id = r.id WHERE r.event_id = ? LIMIT 5000`).bind(eventId),
    db.prepare(`SELECT e.lead_id, e.step, e.template, e.status, e.opened_at FROM emails e WHERE (e.sequence = 'live' OR e.sequence LIKE 'live.v%') AND e.lead_id IN (SELECT lead_id FROM live_webinar_regs WHERE event_id = ?)`).bind(eventId),
    db.prepare(`SELECT s.lead_id, s.step, s.template, s.status FROM sms_messages s WHERE s.direction = 'out' AND (s.sequence = 'live' OR s.sequence LIKE 'live.v%') AND s.lead_id IN (SELECT lead_id FROM live_webinar_regs WHERE event_id = ?)`).bind(eventId),
    db.prepare('SELECT reg_id, via, at FROM lc_touches WHERE event_id = ? ORDER BY at').bind(eventId),
    db.prepare("SELECT lead_id, paid_at FROM webinar_passes WHERE kind = 'deposit' AND status = 'paid' AND source = 'live' AND ref_id = ?").bind(eventId),
    db.prepare(`SELECT a.reg_id, a.minutes FROM room_attendance a JOIN rooms m ON m.id = a.room_id WHERE m.ref_type = 'live' AND m.ref_id = ? AND a.reg_id IS NOT NULL`).bind(eventId),
    db.prepare(`SELECT who, first_at, seen_at FROM webinar_presence WHERE session_id = ? AND kind = 'viewer'`).bind(eventId),
    db.prepare('SELECT f.*, l.first_name FROM lc_referrals f JOIN live_webinar_regs r ON r.id = f.referrer_reg_id JOIN leads l ON l.id = r.lead_id WHERE f.event_id = ?').bind(eventId),
  ]);
  type Reg = { id: string; lead_id: string; seq: number; joined_at: number | null; created_at: number; cal_added_at: number | null; cal_kind: string | null; sms_optin_at: number | null; question: string | null; worksheet_at: number | null; referred_by: string | null; ref_clicks: number | null; first_name: string | null; last_name: string | null; email: string | null };
  const regs = regsR.results as Reg[];
  const emails = emailsR.results as { lead_id: string; step: number; template: string; status: string; opened_at: number | null }[];
  const sms = smsR.results as { lead_id: string; step: number; template: string; status: string }[];
  const touches = touchesR.results as { reg_id: string; via: string; at: number }[];
  const buyers = new Set((passesR.results as { lead_id: string }[]).map((p) => p.lead_id));
  const roomMin = new Map((roomR.results as { reg_id: string; minutes: number }[]).map((r) => [r.reg_id, r.minutes]));
  const pres = new Map((presR.results as { who: string; first_at: number; seen_at: number }[]).map((p) => [p.who, p]));
  const { LIVE_STEP, liveEmail } = await import('./events');
  const REM = ['r24h', 'r3h', 'r1h', 'r10m', 'live', 'missing'] as const;
  const delivered = (s: string) => s === 'sent' || s === 'simulated';
  const rows: (FunnelRow & { via: string | null })[] = regs.map((r) => {
    const steps = new Set(REM.map((k) => r.seq * 10 + LIVE_STEP[k]));
    const reminded = emails.some((e) => e.lead_id === r.lead_id && steps.has(e.step) && delivered(e.status)) || sms.some((s) => s.lead_id === r.lead_id && steps.has(s.step) && delivered(s.status));
    const p = pres.get(r.id);
    const stayedMin = roomMin.get(r.id) ?? (p ? Math.max(0, (p.seen_at - Math.max(p.first_at, ev.starts_at)) / MIN) : 0);
    return { registered: true, cal: Boolean(r.cal_added_at), reminded, joined: Boolean(r.joined_at), stayed: Boolean(r.joined_at) && stayedMin >= half, bought: buyers.has(r.lead_id), via: cameBackVia(r.joined_at, touches.filter((t) => t.reg_id === r.id)) };
  });
  const viaCount = new Map<string, number>();
  for (const r of rows) if (r.via) viaCount.set(r.via, (viaCount.get(r.via) ?? 0) + 1);
  const calKinds = new Map<string, number>();
  for (const r of regs) if (r.cal_kind) calKinds.set(r.cal_kind, (calKinds.get(r.cal_kind) ?? 0) + 1);
  // Subject line test: per reminder and variant, sent, opened, clicked through, joined (z-test on joined, the experiments pattern).
  const { zTest } = await import('../admin/stats');
  const ab = AB_KINDS.map((k) => {
    const v = (variant: 'a' | 'b') => {
      const mine = regs.map((r) => ({ r, e: emails.find((e) => e.lead_id === r.lead_id && e.step === r.seq * 10 + LIVE_STEP[k] && delivered(e.status) && (variant === 'b' ? e.template.endsWith('~b') : !e.template.endsWith('~b'))) })).filter((x) => x.e);
      const clicked = mine.filter((x) => touches.some((t) => t.reg_id === x.r.id && t.via.replace(/~[ab]$/, '') === `e-${k}`)).length;
      return { sent: mine.length, opened: mine.filter((x) => x.e!.opened_at).length, clicked, joined: mine.filter((x) => x.r.joined_at).length };
    };
    const a = v('a'), b = v('b');
    const t = zTest(a.joined, a.sent, b.joined, b.sent);
    const subjA = liveEmail(k, { name: '', title: ev.title, when: formatCallTime(ev.starts_at, ev.tz), room: '', ticket: null, ticketLabel: null, attended: false, offerOpened: false, closes: null, replay: false, deposit: '' }).subject;
    return { kind: k, a: { ...a, subject: subjA }, b: { ...b, subject: SUBJECT_B[k]!({ title: ev.title, when: formatCallTime(ev.starts_at, ev.tz) }) }, p: a.sent && b.sent ? t.p : null };
  });
  const refs = refR.results as { referred_reg_id: string; referrer_reg_id: string; status: string; reason: string | null; first_name: string | null }[];
  const byReferrer = new Map<string, { name: string; registered: number; attended: number }>();
  for (const f of refs) {
    if (f.status === 'rejected') continue;
    const cur = byReferrer.get(f.referrer_reg_id) ?? { name: f.first_name ?? 'Someone', registered: 0, attended: 0 };
    cur.registered++; if (f.status === 'attended') cur.attended++;
    byReferrer.set(f.referrer_reg_id, cur);
  }
  const rejected = new Map<string, number>();
  for (const f of refs) if (f.status === 'rejected') rejected.set(f.reason ?? 'other', (rejected.get(f.reason ?? 'other') ?? 0) + 1);
  return {
    event: { id: ev.id, title: ev.title, when: formatCallTime(ev.starts_at, ev.tz), startsAt: ev.starts_at, tz: ev.tz, status: ev.status, platform: ev.platform ?? 'zoom', durationMin: ev.duration_min },
    funnel: showUpFunnel(rows),
    cameBack: [...viaCount.entries()].sort((a, b) => b[1] - a[1]).map(([via, n]) => ({ via, label: VIA_LABEL[via] ?? via, n })),
    calendar: [...calKinds.entries()].map(([kind, n]) => ({ kind, n })),
    channels: {
      emailsSent: emails.filter((e) => delivered(e.status)).length, textsSent: sms.filter((s) => delivered(s.status)).length,
      textsHeldForCall: sms.filter((s) => s.status === 'skipped').length, smsOptins: regs.filter((r) => r.sms_optin_at).length,
    },
    ab: { on: Boolean(lc.subject_ab), rows: ab },
    questions: regs.filter((r) => r.question).map((r) => ({ name: r.first_name ?? 'An owner', text: r.question! })),
    worksheets: regs.filter((r) => r.worksheet_at).length,
    referrals: {
      counted: refs.filter((f) => f.status !== 'rejected').length, attended: refs.filter((f) => f.status === 'attended').length, clicks: regs.reduce((a, r) => a + Number(r.ref_clicks ?? 0), 0),
      rejected: [...rejected.entries()].map(([reason, n]) => ({ reason, label: REFERRAL_REASONS[reason] ?? reason, n })),
      top: [...byReferrer.values()].sort((a, b) => b.attended - a.attended || b.registered - a.registered).slice(0, 10),
    },
    settings: { icsSeq: lc.ics_seq, reminderVersion: lc.rv, video: lc.video_url, slides: parseSlides(lc.slides), slidesCustom: Boolean(lc.slides), cadence: parseCadence(lc.cadence), subjectAb: Boolean(lc.subject_ab) },
  };
}

/** Funnel HQ edits: the pre-show video and slides, the cadence, the subject test. */
export async function saveLcEvent(rt: Runtime, eventId: string, body: Record<string, unknown>) {
  if (!(await getEvent(rt, eventId))) return { ok: false as const, error: 'Event not found' };
  const cur = await lcEvent(rt, eventId, true);
  let video = cur.video_url;
  if (body.video_url !== undefined) {
    const v = String(body.video_url ?? '').trim();
    if (v && !/^(https:\/\/[^\s"'<>]{3,500}|\/[A-Za-z0-9._~\-/]{1,300})$/.test(v)) return { ok: false as const, error: 'The video must be an https link or a path on this site' };
    video = v || null;
  }
  let slides = cur.slides;
  if (body.slides !== undefined) {
    const lines = String(body.slides ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12);
    slides = lines.length ? JSON.stringify(lines.map((l) => { const [t, ...r] = l.split('|'); return { title: t.trim().slice(0, 80), body: r.join('|').trim().slice(0, 280) }; })) : null;
  }
  const cadence = body.cadence !== undefined ? JSON.stringify(parseCadence(JSON.stringify(body.cadence))) : cur.cadence;
  const ab = body.subject_ab !== undefined ? (body.subject_ab === true ? 1 : 0) : cur.subject_ab;
  await rt.env.DB.prepare(`INSERT INTO lc_events (event_id, video_url, slides, cadence, subject_ab, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET video_url = excluded.video_url, slides = excluded.slides, cadence = excluded.cadence, subject_ab = excluded.subject_ab, updated_at = excluded.updated_at`)
    .bind(eventId, video, slides, cadence, ab, Date.now()).run();
  evCache.delete(eventId);
  return { ok: true as const };
}

/** The cron (every 5 minutes, from processLiveMessages): referral rewards. */
export async function lifecycleCron(rt: Runtime, now = Date.now()) {
  return { referralsRewarded: await rewardReferrals(rt, now).catch((e) => { console.error('referral rewards', e); return 0; }) };
}
void DAY;

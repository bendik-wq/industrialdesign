import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { getLead } from '../funnel/leads';
import { identityFromLead, track } from '../tracking/track';
import { CHAT_MAX, PRESENCE_MS, chatLabel, chatRate, countPresence, escapeHtml, pickHostName, presenceLine, sanitiseChat, viewerName } from '../webinar/live';
import { DAY_PAGE, dayContent } from './content';
import { type LoadedCohort, type Registration, loadCohort } from './cohorts';
import { cohortOffer } from './offer';
import { type DayRow, type ProgressRow, chatOpen, dayPhase, eventKey, focusDay, inLiveWindow, replayAccess, summarise } from './schedule';

/**
 * The participant's side: progress (live attendance, replays, worksheets), the day's worksheet and poll, the
 * cohort chat and true presence (the masterclass live layer's tables and rules, scoped to the event key
 * challenge:<cohort>:<day>), and the VIP hot seat queue. Every count shown is a real count.
 */

const MIN = 60_000;
/** The companion page counts as live attendance once it has been open for 5 minutes inside the live window. */
export const PRESENT_AFTER_MS = 5 * MIN;

export async function progressRows(rt: Runtime, regId: string) {
  return (await rt.env.DB.prepare('SELECT day, joined_at, present_at, replay_at, homework_at FROM challenge_progress WHERE reg_id = ?').bind(regId).all<ProgressRow>()).results;
}

const touch = (rt: Runtime, regId: string, day: number, col: 'joined_at' | 'present_at' | 'replay_at' | 'homework_at', now: number) =>
  rt.env.DB.prepare(`INSERT INTO challenge_progress (reg_id, day, ${col}) VALUES (?, ?, ?) ON CONFLICT(reg_id, day) DO UPDATE SET ${col} = COALESCE(challenge_progress.${col}, excluded.${col})`).bind(regId, day, now).run();

/** Everything the hub and the day pages show for this person right now. */
export async function participantView(rt: Runtime, reg: Registration, now = Date.now(), loaded?: LoadedCohort | null) {
  const L = loaded ?? (await loadCohort(rt, reg.cohort_id));
  if (!L) return null;
  const vip = Boolean(reg.vip);
  const progress = summarise(await progressRows(rt, reg.id));
  const offer = await cohortOffer(rt, reg.cohort_id, now);
  const days = L.days.map((d) => ({
    ...d,
    phase: dayPhase(d, now),
    replay: replayAccess({ vip, replayUrl: d.replay_url, closeAt: L.closeAt, now }),
    content: dayContent(d.day)!,
    progress: progress.days[d.day - 1],
  }));
  return { cohort: L.cohort, closeAt: L.closeAt, days, focus: focusDay(days, now), progress, offer, vip, now };
}
export type ParticipantView = NonNullable<Awaited<ReturnType<typeof participantView>>>;

export const dayOf = (L: { days: DayRow[] }, n: number) => L.days.find((d) => d.day === n) ?? null;

/** /challenge/join/:token/:n — counts live attendance inside the window, then goes to that day's Zoom. */
export async function joinDay(rt: Runtime, reg: Registration, n: number, now = Date.now()) {
  if (reg.status !== 'paid') return null;
  const L = await loadCohort(rt, reg.cohort_id);
  const d = L ? dayOf(L, n) : null;
  if (!d?.join_url) return null;
  if (inLiveWindow(d, now)) {
    await touch(rt, reg.id, n, 'joined_at', now);
    await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'challenge_join', source: 'server', path: '/challenge', props: { cohort_id: reg.cohort_id, day: n }, localOnly: true }).catch(() => null);
  }
  return d.join_url;
}

/** /challenge/replay/:token/:n — VIP always; others until the offer closes; only once the team posted it. */
export async function replayDay(rt: Runtime, reg: Registration, n: number, now = Date.now()) {
  if (reg.status !== 'paid') return { url: null, access: 'none' as const };
  const L = await loadCohort(rt, reg.cohort_id);
  const d = L ? dayOf(L, n) : null;
  if (!L || !d) return { url: null, access: 'none' as const };
  const access = replayAccess({ vip: Boolean(reg.vip), replayUrl: d.replay_url, closeAt: L.closeAt, now });
  if (access !== 'open') return { url: null, access };
  await touch(rt, reg.id, n, 'replay_at', now);
  return { url: d.replay_url, access };
}

// ───────────── worksheet ─────────────

export function cleanAnswers(day: number, raw: unknown) {
  const c = dayContent(day);
  if (!c || !raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const f of c.worksheet.fields) {
    const v = src[f.key];
    if (typeof v !== 'string') continue;
    const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, f.kind === 'long' ? 2000 : 200);
    if (t) out[f.key] = t;
  }
  return Object.keys(out).length ? out : null;
}

/** Saves the day's worksheet (editable: submitting again replaces it). Opens 30 minutes before the session. */
export async function submitHomework(rt: Runtime, reg: Registration, day: number, raw: unknown, now = Date.now()) {
  if (reg.status !== 'paid') return { ok: false as const, error: 'Pay your challenge ticket first.' };
  const L = await loadCohort(rt, reg.cohort_id);
  const d = L ? dayOf(L, day) : null;
  if (!d) return { ok: false as const, error: 'No such day.' };
  if (now < d.starts_at - 30 * MIN) return { ok: false as const, error: DAY_PAGE.locked };
  const answers = cleanAnswers(day, raw);
  if (!answers) return { ok: false as const, error: DAY_PAGE.worksheetEmpty };
  await rt.env.DB.prepare(
    `INSERT INTO challenge_homework (reg_id, cohort_id, day, answers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(reg_id, day) DO UPDATE SET answers = excluded.answers, updated_at = excluded.updated_at`,
  ).bind(reg.id, reg.cohort_id, day, JSON.stringify(answers), now, now).run();
  await touch(rt, reg.id, day, 'homework_at', now);
  await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'challenge_homework', source: 'server', path: '/challenge', props: { cohort_id: reg.cohort_id, day }, localOnly: true }).catch(() => null);
  return { ok: true as const, message: DAY_PAGE.worksheetSaved };
}

export async function homeworkFor(rt: Runtime, regId: string, day: number) {
  const r = await rt.env.DB.prepare('SELECT answers, review, reviewed_by, reviewed_at, updated_at FROM challenge_homework WHERE reg_id = ? AND day = ?').bind(regId, day).first<{ answers: string; review: string | null; reviewed_by: string | null; reviewed_at: number | null; updated_at: number }>();
  if (!r) return null;
  let answers: Record<string, string> = {};
  try { answers = JSON.parse(r.answers) as Record<string, string>; } catch { /* empty */ }
  return { answers, review: r.review, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, updatedAt: r.updated_at };
}

// ───────────── poll ─────────────

export async function pollResults(rt: Runtime, cohortId: string, day: number) {
  const c = dayContent(day);
  if (!c) return null;
  const { results } = await rt.env.DB.prepare('SELECT value, COUNT(*) AS n FROM challenge_polls WHERE cohort_id = ? AND day = ? AND poll = ? GROUP BY value').bind(cohortId, day, c.poll.id).all<{ value: string; n: number }>();
  const total = results.reduce((a, r) => a + r.n, 0);
  return { total, options: c.poll.options.map((o) => ({ ...o, n: results.find((r) => r.value === o.value)?.n ?? 0 })) };
}

export async function answerPoll(rt: Runtime, reg: Registration, day: number, value: unknown, now = Date.now()) {
  const c = dayContent(day);
  if (!c || reg.status !== 'paid') return { ok: false as const, error: 'Not available.' };
  if (typeof value !== 'string' || !c.poll.options.some((o) => o.value === value)) return { ok: false as const, error: 'Pick one of the answers.' };
  await rt.env.DB.prepare('INSERT INTO challenge_polls (reg_id, cohort_id, day, poll, value, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(reg_id, day, poll) DO UPDATE SET value = excluded.value')
    .bind(reg.id, reg.cohort_id, day, c.poll.id, value, now).run();
  return { ok: true as const, mine: value, results: await pollResults(rt, reg.cohort_id, day) };
}

export async function myPoll(rt: Runtime, regId: string, day: number) {
  return (await rt.env.DB.prepare('SELECT value FROM challenge_polls WHERE reg_id = ? AND day = ?').bind(regId, day).first<{ value: string }>())?.value ?? null;
}

// ───────────── chat and presence ─────────────

type ChatRow = { id: number; author: string; name: string; body: string | null; pinned_at: number | null; deleted_at: number | null; created_at: number };
const outMsg = (m: ChatRow) => (m.deleted_at ? { id: m.id, deleted: true } : { id: m.id, ...chatLabel(m), html: escapeHtml(m.body ?? ''), t: m.created_at, pinned: Boolean(m.pinned_at) });

/** The day page's poll (every ~5 s): presence ping, new chat, true presence and the offer state. */
export async function dayFeed(rt: Runtime, reg: Registration, day: number, body: Record<string, unknown>, now = Date.now()) {
  if (reg.status !== 'paid') return { ok: false as const };
  const L = await loadCohort(rt, reg.cohort_id);
  const d = L ? dayOf(L, day) : null;
  if (!L || !d) return { ok: false as const };
  const key = eventKey(reg.cohort_id, day);
  const db = rt.env.DB;
  const open = chatOpen(d, now);
  if (body.presence === true && open) {
    await db.prepare('INSERT INTO webinar_presence (session_id, who, kind, first_at, seen_at) VALUES (?, ?, \'viewer\', ?, ?) ON CONFLICT(session_id, who) DO UPDATE SET seen_at = excluded.seen_at')
      .bind(key, reg.id, now, now).run();
    if (inLiveWindow(d, now)) {
      const p = await db.prepare('SELECT first_at FROM webinar_presence WHERE session_id = ? AND who = ?').bind(key, reg.id).first<{ first_at: number }>();
      if (p && now - Math.max(p.first_at, d.starts_at - 15 * MIN) >= PRESENT_AFTER_MS) await touch(rt, reg.id, day, 'present_at', now);
    }
  }
  const after = Math.max(0, Math.floor(Number(body.after) || 0));
  const cols = 'id, author, name, CASE WHEN deleted_at IS NULL THEN body END AS body, pinned_at, deleted_at, created_at';
  const [pres, msgs, pin] = await db.batch([
    db.prepare('SELECT who, kind, seen_at FROM webinar_presence WHERE session_id = ? AND seen_at > ?').bind(key, now - PRESENCE_MS.host),
    after === 0
      ? db.prepare(`SELECT ${cols} FROM webinar_chat WHERE session_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 150`).bind(key)
      : db.prepare(`SELECT ${cols} FROM webinar_chat WHERE session_id = ? AND (id > ? OR updated_at > ?) ORDER BY id LIMIT 200`).bind(key, after, now - 15_000),
    db.prepare(`SELECT ${cols} FROM webinar_chat WHERE session_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at DESC LIMIT 1`).bind(key),
  ]);
  const presence = countPresence(pres.results as { who: string; kind: string; seen_at: number }[], now, reg.id);
  let list = msgs.results as ChatRow[];
  if (after === 0) list = list.reverse();
  const phase = dayPhase(d, now);
  const stage = phase === 'live' ? 'running' : phase === 'soon' ? 'waiting' : open ? 'after' : 'closed';
  const offer = await cohortOffer(rt, reg.cohort_id, now);
  return {
    ok: true as const,
    now,
    phase,
    chat: { canPost: open, messages: list.map(outMsg), pinned: (pin.results as ChatRow[])[0] ? outMsg((pin.results as ChatRow[])[0]) : null, cursor: list.reduce((a, m) => Math.max(a, m.id), after) },
    presence: { line: presenceLine(stage as 'running' | 'waiting' | 'after' | 'closed', presence.viewers), host: presence.host > 0 },
    offer: { open: offer.open, closesAt: offer.closeAt, closed: offer.expired, soft: offer.day === 4 },
  };
}

export async function postDayChat(rt: Runtime, reg: Registration, day: number, body: Record<string, unknown>, now = Date.now()) {
  if (reg.status !== 'paid') return { ok: false as const, error: 'Pay your challenge ticket first.' };
  const L = await loadCohort(rt, reg.cohort_id);
  const d = L ? dayOf(L, day) : null;
  if (!d || !chatOpen(d, now)) return { ok: false as const, error: DAY_PAGE.chatClosed };
  const clean = sanitiseChat(body.text);
  if (!clean.ok) return { ok: false as const, error: clean.error };
  const key = eventKey(reg.cohort_id, day);
  const db = rt.env.DB;
  const r = await db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM webinar_chat WHERE reg_id = ? AND session_id = ?').bind(reg.id, key).first<{ n: number; last: number | null }>();
  const rate = chatRate(r?.n ?? 0, r?.last ?? null, now);
  if (!rate.ok) return { ok: false as const, error: rate.error };
  const lead = await getLead(rt.env, reg.lead_id);
  const name = viewerName(lead?.first_name, lead?.last_name, body.anon === true);
  const ins = await db.prepare("INSERT INTO webinar_chat (session_id, reg_id, lead_id, author, name, body, created_at, updated_at) VALUES (?, ?, ?, 'viewer', ?, ?, ?, ?)")
    .bind(key, reg.id, reg.lead_id, name, clean.text, now, now).run();
  return { ok: true as const, message: outMsg({ id: Number((ins.meta as { last_row_id?: number }).last_row_id ?? 0), author: 'viewer', name, body: clean.text, pinned_at: null, deleted_at: null, created_at: now }) };
}

/** A team message into a day's chat (Funnel HQ, or builder A's host console). */
export async function teamDayChat(rt: Runtime, key: string, body: Record<string, unknown>, now = Date.now()) {
  const text = typeof body.text === 'string' ? body.text.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX) : '';
  if (!text) return { ok: false, error: 'Write a message first' };
  await rt.env.DB.prepare("INSERT INTO webinar_chat (session_id, author, name, body, created_at, updated_at) VALUES (?, 'team', ?, ?, ?, ?)").bind(key, pickHostName(rt.settings, body.name), text, now, now).run();
  return { ok: true };
}

// ───────────── VIP hot seat ─────────────

export async function askHotSeat(rt: Runtime, reg: Registration, day: number, raw: unknown, now = Date.now()) {
  if (reg.status !== 'paid' || !reg.vip) return { ok: false as const, error: 'The hot seat is for VIP members.' };
  const q = typeof raw === 'string' ? raw.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
  if (q.length < 5) return { ok: false as const, error: 'Write your question first.' };
  const n = await rt.env.DB.prepare('SELECT COUNT(*) AS n FROM challenge_hot_seats WHERE reg_id = ? AND day = ?').bind(reg.id, day).first<{ n: number }>();
  if ((n?.n ?? 0) >= 3) return { ok: false as const, error: 'Three questions per day. Bring the rest to the hot seat.' };
  await rt.env.DB.prepare('INSERT INTO challenge_hot_seats (id, reg_id, cohort_id, day, question, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(newId('ch'), reg.id, reg.cohort_id, day, q, now).run();
  return { ok: true as const, message: DAY_PAGE.hotSent };
}

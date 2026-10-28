import type { Runtime } from '../app';
import { flag } from '../settings';
import { newId } from '../lib/ids';
import { getLead } from '../funnel/leads';
import { notifySlack } from '../integrations/notify';
import { REVENUE_LABEL, isMillionPlus } from '../sales/qualify';
import { identityFromLead, track } from '../tracking/track';
import { polls } from './room';
import { type Registration, type Session, getSession, phase, webinarSettings } from './webinar';

/**
 * The real live layer on top of the recorded masterclass. Everything here is true:
 *  - presence counts only people whose room actually pinged in the last 45 s (team: 60 s), and is only
 *    shown when at least two other people are there; replay viewers are never mixed into a showing's count;
 *  - the chat holds only messages typed by real viewers of that showing, plus team messages labelled as such;
 *  - "Josh's team is in the room" only shows while someone has the host console open on that showing;
 *  - announcements are typed by the team (or scheduled by them for a minute of every showing).
 * Runs fully on autopilot: with nobody from the team present, the room says nothing about the team.
 */

// ───────────── copy (every string the viewer sees; checked by auditCopy in the tests) ─────────────

export const LIVE_COPY = {
  chatHeading: 'Showing chat',
  chatNote: 'Real owners in this showing. Names show as first name and last initial.',
  chatEmpty: 'No messages yet. Say hello to the other owners in this showing.',
  chatPlaceholder: 'Write a message',
  chatSend: 'Send',
  anonToggle: 'Hide my name',
  anonName: 'An owner',
  teamBadge: 'Team',
  pinned: 'Pinned by the team',
  chatClosed: 'The chat for this showing has closed.',
  replayHeading: 'Chat from the {time} showing',
  replayNote: 'Posted by owners during that showing. The chat is read-only in the replay.',
  replayEmpty: 'Nobody wrote in the chat during that showing.',
  rateWait: 'One message every 8 seconds. Try again in a moment.',
  rateCap: 'You have reached the message limit for this showing.',
  tooLong: 'Keep it under 400 characters.',
  hostPresent: 'Josh’s team is in the room.',
  raiseHeading: 'Get a call from Josh’s team',
  raiseBody: 'For owners doing $1M+ a year. One tap sends the team your details, and someone reaches out to you.',
  raiseButton: 'Get a call from Josh’s team',
  raiseDone: 'Thanks. Someone from Josh’s team will reach out.',
  teamAnswer: 'Answered by Josh’s team',
  chatTab: 'Chat',
};

// ───────────── pure helpers ─────────────

export const CHAT_MAX = 400;
export const CHAT_GAP_MS = 8_000;
export const CHAT_CAP = 30;
export const PRESENCE_MS = { viewer: 45_000, replay: 45_000, host: 60_000 } as const;
/** Minutes after a showing ends that its room stays open for chat (and a live Q&A announcement). */
export const AFTER_MIN = 30;

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const PROFANITY = /\b(f+u+c+k\w*|motherf\w*|s+h+i+t+\w*|bullshit\w*|c+u+n+t+s?|bitch\w*|asshole\w*|arsehole\w*|bastard\w*|dickhead\w*|wank\w*|twat\w*|slut\w*|whore\w*|cocksucker\w*|pussy|retard\w*|fag\w*|nigg\w*)\b/gi;
export const maskProfanity = (s: string) => s.replace(PROFANITY, (w) => w[0] + '*'.repeat(w.length - 1));

const TLDS = 'com|net|org|io|co|au|uk|us|nz|ca|ly|me|app|biz|info|xyz|gg|link|ai|to|tv|so|club|site|online|shop|store|pro|page|ws|cc|ru|cn|in';
const RE_URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const RE_EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}\b/gi;
const RE_DOMAIN = new RegExp(`\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b(?:\\/\\S*)?`, 'gi');
const RE_HANDLE = /(^|\s)@[a-z0-9_.]{2,}/gi;
const RE_PHONE = /(\$\s?)?\+?\d[\d\s().-]{5,}\d/g;

/**
 * A chat message as it will be stored: plain text, one line, at most 400 characters, with links, emails,
 * social handles and phone numbers replaced by "[removed]" and swear words masked. Escaping happens on the way out.
 */
export function sanitiseChat(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Write a message first' };
  // eslint-disable-next-line no-control-regex
  let t = raw.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, error: 'Write a message first' };
  if (t.length > CHAT_MAX) return { ok: false, error: LIVE_COPY.tooLong };
  t = t.replace(RE_URL, '[removed]').replace(RE_EMAIL, '[removed]').replace(RE_DOMAIN, '[removed]').replace(RE_HANDLE, '$1[removed]');
  // Phone numbers: 8+ digits. Amounts ("$1 500 000") are left alone.
  t = t.replace(RE_PHONE, (m, dollar: string | undefined) => (dollar || m.replace(/\D/g, '').length < 8 ? m : '[removed]'));
  t = t.replace(/(\[removed\][\s.,]*){2,}/g, '[removed] ');
  return { ok: true, text: maskProfanity(t).trim() };
}

/** 1 message per 8 s and 30 per registration per showing. */
export function chatRate(sent: number, lastAt: number | null, now: number): { ok: true } | { ok: false; error: string; retryInSec?: number } {
  if (sent >= CHAT_CAP) return { ok: false, error: LIVE_COPY.rateCap };
  if (lastAt && now - lastAt < CHAT_GAP_MS) return { ok: false, error: LIVE_COPY.rateWait, retryInSec: Math.ceil((CHAT_GAP_MS - (now - lastAt)) / 1000) };
  return { ok: true };
}

/** "Dana K." from the lead's name, or "An owner" when they hide it (or there is no name). */
export function viewerName(first: string | null | undefined, last: string | null | undefined, anon: boolean) {
  const f = (first ?? '').replace(/[^\p{L}\p{M}' -]/gu, '').trim().split(/\s+/)[0]?.slice(0, 20) ?? '';
  if (anon || !f) return LIVE_COPY.anonName;
  const l = (last ?? '').replace(/[^\p{L}]/gu, '').charAt(0).toUpperCase();
  return l ? `${f} ${l}.` : f;
}

/** How a message is labelled: team messages carry the team badge; a viewer's never does, whatever their name. */
export function chatLabel(m: { author: string; name: string }) {
  return m.author === 'team' ? { name: m.name, team: true, badge: LIVE_COPY.teamBadge } : { name: m.name, team: false, badge: null };
}

/** The names the team may post under (settings allowlist; the first is the default). */
export function hostNames(settings: Record<string, string | undefined>) {
  const list = (settings.WEBINAR_HOST_NAMES ?? '').split(',').map((s) => s.replace(/[<>"]/g, '').trim().slice(0, 30)).filter(Boolean).slice(0, 5);
  return list.length ? list : ['G&L team', 'Josh'];
}
export const pickHostName = (settings: Record<string, string | undefined>, name: unknown) => {
  const list = hostNames(settings);
  return list.find((n) => n === name) ?? list[0];
};

/** Who is really here: counts of other people seen within each kind's window. */
export function countPresence(rows: { who: string; kind: string; seen_at: number }[], now: number, self: string | null) {
  const out = { viewers: 0, replay: 0, host: 0 };
  for (const r of rows) {
    if (r.who === self) continue;
    const k = r.kind as keyof typeof PRESENCE_MS;
    if (!(k in PRESENCE_MS) || now - r.seen_at > PRESENCE_MS[k]) continue;
    if (k === 'viewer') out.viewers++; else if (k === 'replay') out.replay++; else out.host++;
  }
  return out;
}

export type Stage = 'waiting' | 'running' | 'after' | 'closed' | 'replay';

/** Where the chat stands for this page: a replay page is always read-only; a live page closes 30 minutes after the end. */
export function chatStage(p: ReturnType<typeof phase>, endsAt: number, now: number, replayPage: boolean): Stage {
  if (replayPage) return 'replay';
  if (p === 'waiting' || p === 'running') return p;
  if (p === 'replay' && now < endsAt + AFTER_MIN * 60_000) return 'after';
  return 'closed';
}

/** The presence line, only when it is true and worth saying: two or more other people. */
export function presenceLine(stage: Stage, others: number) {
  const s = others === 1 ? '' : 's';
  if (stage === 'replay') return others >= 2 ? `${others} other owner${s} are watching this replay right now.` : null;
  if (others < 2) return null;
  if (stage === 'running') return `You and ${others} other owners are watching this showing.`;
  if (stage === 'waiting') return `You and ${others} other owners are waiting for this showing to start.`;
  if (stage === 'after') return `You and ${others} other owners are still in the room.`;
  return null;
}

export interface Announcement { id: string; body: string; link_url: string | null; link_label: string | null; host_name?: string | null; expires_at?: number; ended_at?: number | null }
export const announcementLive = (a: { expires_at: number; ended_at: number | null }, now: number) => !a.ended_at && a.expires_at > now;

export interface AutoAnnouncement { id: string; at_min: number; minutes: number; body: string; link_url: string | null; link_label: string | null; replay: number; active: number }
/** Scheduled announcements showing at this minute of the masterclass (the most recent start wins). */
export function scheduledActive(list: AutoAnnouncement[], minute: number, replay: boolean) {
  return list.filter((a) => a.active && (!replay || a.replay) && minute >= a.at_min && minute < a.at_min + a.minutes).sort((a, b) => b.at_min - a.at_min)[0] ?? null;
}

const httpsUrl = (v: unknown) => (typeof v === 'string' && /^https:\/\/[^\s"'<>]{3,}$/.test(v.trim()) ? v.trim().slice(0, 500) : null);
const plain = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export const chatOn = (rt: Runtime) => flag(rt.settings.WEBINAR_CHAT, true);

// ───────────── room (viewer) ─────────────

async function bandOf(rt: Runtime, reg: Registration) {
  const row = await rt.env.DB.prepare('SELECT revenue_band FROM webinar_registrations WHERE id = ?').bind(reg.id).first<{ revenue_band: string | null }>();
  return row?.revenue_band ?? (await getLead(rt.env, reg.lead_id))?.revenue_band ?? null;
}

/** Static part of the live layer for the room's config (window.FUNNEL.webinar.live). */
export async function liveRoomConfig(rt: Runtime, reg: Registration, replay: boolean) {
  const band = await bandOf(rt, reg);
  const raised = await rt.env.DB.prepare('SELECT 1 FROM webinar_hand_raises WHERE session_id = ? AND reg_id = ?').bind(reg.session_id, reg.id).first();
  return { chat: chatOn(rt), replay, raise: isMillionPlus(band), raised: Boolean(raised), copy: LIVE_COPY, feed: '/api/webinar/live/feed', post: '/api/webinar/live/chat', raiseUrl: '/api/webinar/live/raise' };
}

type ChatRow = { id: number; author: string; name: string; body: string | null; at_sec: number | null; pinned_at: number | null; deleted_at: number | null; created_at: number };
const outMsg = (m: ChatRow) => (m.deleted_at ? { id: m.id, deleted: true } : { id: m.id, ...chatLabel(m), html: escapeHtml(m.body ?? ''), at: m.at_sec, t: m.created_at, pinned: Boolean(m.pinned_at) });
const posOf = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(6 * 3600, Math.round(Number(v)))) : null);

/** Records presence and keeps the showing's peak (live viewers only). */
async function ping(rt: Runtime, sessionId: string, who: string, kind: 'viewer' | 'replay' | 'host', now: number) {
  const db = rt.env.DB;
  await db.prepare('INSERT INTO webinar_presence (session_id, who, kind, first_at, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, who) DO UPDATE SET seen_at = excluded.seen_at, kind = excluded.kind')
    .bind(sessionId, who, kind, now, now).run();
  if (kind !== 'viewer') return;
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM webinar_presence WHERE session_id = ? AND kind = 'viewer' AND seen_at > ?").bind(sessionId, now - PRESENCE_MS.viewer).first<{ n: number }>())?.n ?? 1;
  await db.prepare(`INSERT INTO webinar_live_peaks (session_id, peak_viewers, peak_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET peak_at = CASE WHEN excluded.peak_viewers > peak_viewers THEN excluded.peak_at ELSE peak_at END,
      peak_viewers = MAX(peak_viewers, excluded.peak_viewers), updated_at = excluded.updated_at`).bind(sessionId, n, now, now).run();
}

/**
 * The room's poll (every ~4 s): new chat messages after the cursor (plus pins/deletes since the last poll),
 * the pinned message, true presence, the announcement on now, the team's replies to this viewer's questions.
 */
export async function liveFeed(rt: Runtime, reg: Registration, session: Session, body: Record<string, unknown>) {
  const db = rt.env.DB;
  const now = Date.now();
  const w = webinarSettings(rt);
  const replay = body.replay === true;
  const endsAt = session.starts_at + w.durationMin * 60_000;
  const stage = chatStage(phase(rt, session, now), endsAt, now, replay);
  const after = Math.max(0, Math.floor(Number(body.after) || 0));
  const since = Math.max(0, Math.floor(Number(body.since) || 0));
  if (body.presence === true && stage !== 'closed') await ping(rt, session.id, reg.id, replay ? 'replay' : 'viewer', now);

  const on = chatOn(rt);
  const cols = 'id, author, name, CASE WHEN deleted_at IS NULL THEN body END AS body, at_sec, pinned_at, deleted_at, created_at';
  const msgQ = !on ? null : after === 0
    ? db.prepare(`SELECT ${cols} FROM webinar_chat WHERE session_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 150`).bind(session.id)
    : db.prepare(`SELECT ${cols} FROM webinar_chat WHERE session_id = ? AND (id > ? OR updated_at > ?) ORDER BY id LIMIT 200`).bind(session.id, after, since - 2000);
  const qs = [
    db.prepare('SELECT who, kind, seen_at FROM webinar_presence WHERE session_id = ? AND seen_at > ?').bind(session.id, now - PRESENCE_MS.host),
    db.prepare(`SELECT ${cols} FROM webinar_chat WHERE session_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at DESC LIMIT 1`).bind(session.id),
    db.prepare('SELECT id, body, link_url, link_label, host_name, expires_at, ended_at FROM webinar_announcements WHERE session_id = ? AND ended_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1').bind(session.id, now),
    db.prepare('SELECT * FROM webinar_auto_announcements WHERE active = 1'),
    db.prepare("SELECT id, value, team_answer, team_answer_by, team_answered_at FROM webinar_interactions WHERE reg_id = ? AND kind = 'question' AND team_answer IS NOT NULL ORDER BY team_answered_at").bind(reg.id),
    ...(msgQ ? [msgQ] : []),
  ];
  const res = await db.batch(qs);
  const presence = countPresence(res[0].results as { who: string; kind: string; seen_at: number }[], now, reg.id);
  const pinned = (res[1].results as ChatRow[])[0];
  const live = !replay && stage !== 'closed' ? (res[2].results as Announcement[])[0] ?? null : null;
  const minute = replay ? Math.floor((posOf(body.pos) ?? 0) / 60) : Math.floor((now - session.starts_at) / 60_000);
  const sched = stage === 'closed' || stage === 'waiting' ? null : scheduledActive(res[3].results as AutoAnnouncement[], minute, replay);
  const ann = live ?? sched;
  let msgs = msgQ ? (res[5].results as ChatRow[]) : [];
  if (after === 0) msgs = msgs.reverse();
  const hostHere = !replay && stage !== 'closed' && presence.host > 0;
  return {
    ok: true,
    now,
    stage,
    presence: { line: presenceLine(stage, replay ? presence.replay : presence.viewers), host: hostHere ? LIVE_COPY.hostPresent : null },
    chat: on ? { canPost: stage === 'waiting' || stage === 'running' || stage === 'after', messages: msgs.map(outMsg), pinned: pinned ? outMsg(pinned) : null, cursor: msgs.reduce((a, m) => Math.max(a, m.id), after) } : null,
    announcement: ann ? { id: ann.id, html: escapeHtml(ann.body), link: ann.link_url, label: ann.link_label ? escapeHtml(ann.link_label) : null, by: 'host_name' in ann && ann.host_name ? escapeHtml(ann.host_name) : null } : null,
    replies: (res[4].results as { id: string; value: string; team_answer: string; team_answer_by: string | null }[]).map((r) => ({ id: r.id, q: escapeHtml(r.value ?? ''), a: escapeHtml(r.team_answer), by: LIVE_COPY.teamAnswer })),
  };
}

/** A viewer's chat message. */
export async function postChat(rt: Runtime, reg: Registration, session: Session, body: Record<string, unknown>) {
  if (!chatOn(rt)) return { ok: false as const, error: 'The chat is off.' };
  const now = Date.now();
  const w = webinarSettings(rt);
  const stage = chatStage(phase(rt, session, now), session.starts_at + w.durationMin * 60_000, now, body.replay === true);
  if (!['waiting', 'running', 'after'].includes(stage)) return { ok: false as const, error: LIVE_COPY.chatClosed };
  const clean = sanitiseChat(body.text);
  if (!clean.ok) return { ok: false as const, error: clean.error };
  const db = rt.env.DB;
  const r = await db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM webinar_chat WHERE reg_id = ? AND session_id = ?').bind(reg.id, session.id).first<{ n: number; last: number | null }>();
  const rate = chatRate(r?.n ?? 0, r?.last ?? null, now);
  if (!rate.ok) return { ok: false as const, error: rate.error, retryInSec: rate.retryInSec ?? null };
  const lead = await getLead(rt.env, reg.lead_id);
  const name = viewerName(lead?.first_name, lead?.last_name, body.anon === true);
  const at = posOf(body.pos);
  const ins = await db.prepare("INSERT INTO webinar_chat (session_id, reg_id, lead_id, author, name, body, at_sec, created_at, updated_at) VALUES (?, ?, ?, 'viewer', ?, ?, ?, ?, ?)")
    .bind(session.id, reg.id, reg.lead_id, name, clean.text, at, now, now).run();
  if ((r?.n ?? 0) === 0) await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_chat', source: 'server', props: { session_id: session.id }, localOnly: true });
  return { ok: true as const, message: outMsg({ id: Number(ins.meta.last_row_id), author: 'viewer', name, body: clean.text, at_sec: at, pinned_at: null, deleted_at: null, created_at: now }) };
}

/** "Get a call from Josh's team": $1M+ only, once per registration per showing. Pings Slack. */
export async function raiseHand(rt: Runtime, reg: Registration, session: Session, body: Record<string, unknown>) {
  const band = await bandOf(rt, reg);
  if (!isMillionPlus(band)) return { ok: false as const, error: 'This is for owners doing $1M+ a year. Use the question box and the team will reply by email.' };
  const now = Date.now();
  const db = rt.env.DB;
  const host = await db.prepare("SELECT 1 FROM webinar_presence WHERE session_id = ? AND kind = 'host' AND seen_at > ?").bind(session.id, now - PRESENCE_MS.host).first();
  const at = posOf(body.pos);
  const res = await db.prepare('INSERT INTO webinar_hand_raises (id, session_id, reg_id, lead_id, at_sec, replay, host_present, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .bind(newId('wh'), session.id, reg.id, reg.lead_id, at, body.replay === true ? 1 : 0, host ? 1 : 0, now).run();
  if ((res.meta.changes ?? 0) > 0) {
    const lead = await getLead(rt.env, reg.lead_id);
    if (lead) {
      const answers = await db.prepare("SELECT key, value FROM webinar_interactions WHERE reg_id = ? AND kind = 'poll'").bind(reg.id).all<{ key: string; value: string }>();
      const ps = polls(rt);
      const pollLines = answers.results.map((a) => { const p = ps.find((x) => x.id === a.key); return `${p?.question ?? a.key} → ${p?.options.find((o) => o.value === a.value)?.label ?? a.value}`; });
      rt.waitUntil(notifySlack(rt, lead, '🙋 Asked for a call from the masterclass', [
        `${[lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'No name'} · ${REVENUE_LABEL[band ?? ''] ?? band}`,
        `${body.replay === true ? 'Replay' : 'Showing'}, minute ${at == null ? '?' : Math.floor(at / 60)}${host ? ' · team console open' : ''}`,
        lead.phone ? 'Phone on file (open the lead in Funnel HQ)' : 'No phone on file: reply by email',
        ...pollLines,
      ], 'hot_lead'));
      await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_call_request', source: 'server', props: { session_id: session.id, replay: body.replay === true }, localOnly: true });
    }
  }
  return { ok: true as const, message: LIVE_COPY.raiseDone };
}

// ───────────── host console (Funnel HQ) ─────────────

/** Showings running now (or in their after-show window) and starting within 15 minutes, with true counts. */
export async function liveShowings(rt: Runtime) {
  const db = rt.env.DB;
  const w = webinarSettings(rt);
  const now = Date.now();
  const { results } = await db.prepare(
    `SELECT s.id, s.starts_at, s.title, s.mode, s.auto,
            (SELECT COUNT(*) FROM webinar_registrations r WHERE r.session_id = s.id) AS registrations,
            (SELECT COUNT(*) FROM webinar_presence p WHERE p.session_id = s.id AND p.kind = 'viewer' AND p.seen_at > ?) AS viewers,
            (SELECT COUNT(*) FROM webinar_presence p WHERE p.session_id = s.id AND p.kind = 'host' AND p.seen_at > ?) AS hosts,
            (SELECT COUNT(*) FROM webinar_chat c WHERE c.session_id = s.id AND c.deleted_at IS NULL) AS messages,
            (SELECT COUNT(*) FROM webinar_hand_raises h WHERE h.session_id = s.id AND h.handled_at IS NULL) AS raises,
            (SELECT peak_viewers FROM webinar_live_peaks k WHERE k.session_id = s.id) AS peak
       FROM webinar_sessions s
      WHERE s.status = 'scheduled' AND s.starts_at BETWEEN ? AND ?
      ORDER BY s.starts_at`,
  ).bind(now - PRESENCE_MS.viewer, now - PRESENCE_MS.host, now - (w.durationMin + AFTER_MIN) * 60_000, now + 15 * 60_000).all<Record<string, number | string | null>>();
  // Just-in-time slots nobody registered for are noise.
  const list = results.filter((s) => Number(s.registrations) > 0 || Number(s.viewers) > 0 || Number(s.auto) !== 2);
  return {
    now,
    hostNames: hostNames(rt.settings),
    chat: chatOn(rt),
    showings: list.map((s) => {
      const endsAt = Number(s.starts_at) + w.durationMin * 60_000;
      return { ...s, stage: chatStage(phase(rt, { ...(s as unknown as Session), status: 'scheduled' }, now), endsAt, now, false), minute: Math.floor((now - Number(s.starts_at)) / 60_000) };
    }),
    auto: (await db.prepare('SELECT * FROM webinar_auto_announcements ORDER BY at_min').all<AutoAnnouncement>()).results,
  };
}

/** One showing in the console: chat, questions, viewers, announcements and call requests. */
export async function liveShowing(rt: Runtime, sessionId: string) {
  const db = rt.env.DB;
  const session = await getSession(rt, sessionId);
  if (!session) return null;
  const now = Date.now();
  const w = webinarSettings(rt);
  const res = await db.batch([
    db.prepare('SELECT id, author, name, body, at_sec, pinned_at, deleted_at, created_at, reg_id FROM webinar_chat WHERE session_id = ? ORDER BY id DESC LIMIT 300').bind(sessionId),
    db.prepare(`SELECT i.id, i.reg_id, i.value, i.answer, i.team_answer, i.team_answer_by, i.team_answered_at, i.at_sec, i.handled, i.created_at, l.first_name, l.last_name, l.email
                  FROM webinar_interactions i LEFT JOIN leads l ON l.id = i.lead_id WHERE i.session_id = ? AND i.kind = 'question' ORDER BY i.created_at DESC LIMIT 200`).bind(sessionId),
    db.prepare(`SELECT r.id, r.lead_id, r.max_position, r.joined_at, r.replay_at, COALESCE(r.revenue_band, l.revenue_band) AS band, l.first_name, l.last_name, l.email, l.phone,
                       p.seen_at, p.kind AS pkind
                  FROM webinar_registrations r JOIN leads l ON l.id = r.lead_id LEFT JOIN webinar_presence p ON p.session_id = r.session_id AND p.who = r.id
                 WHERE r.session_id = ? ORDER BY p.seen_at DESC, r.created_at LIMIT 500`).bind(sessionId),
    db.prepare("SELECT reg_id, key, value FROM webinar_interactions WHERE session_id = ? AND kind = 'poll'").bind(sessionId),
    db.prepare('SELECT * FROM webinar_announcements WHERE session_id = ? ORDER BY created_at DESC LIMIT 20').bind(sessionId),
    db.prepare(`SELECT h.*, l.first_name, l.last_name, l.email, l.phone, COALESCE(r.revenue_band, l.revenue_band) AS band FROM webinar_hand_raises h
                  JOIN leads l ON l.id = h.lead_id LEFT JOIN webinar_registrations r ON r.id = h.reg_id WHERE h.session_id = ? ORDER BY h.created_at DESC`).bind(sessionId),
    db.prepare('SELECT who, kind, seen_at FROM webinar_presence WHERE session_id = ? AND seen_at > ?').bind(sessionId, now - PRESENCE_MS.host),
    db.prepare('SELECT peak_viewers FROM webinar_live_peaks WHERE session_id = ?').bind(sessionId),
  ]);
  const ps = polls(rt);
  const pollsBy = new Map<string, string[]>();
  for (const a of res[3].results as { reg_id: string; key: string; value: string }[]) {
    const p = ps.find((x) => x.id === a.key);
    const l = pollsBy.get(a.reg_id) ?? [];
    l.push(`${p?.question ?? a.key}: ${p?.options.find((o) => o.value === a.value)?.label ?? a.value}`);
    pollsBy.set(a.reg_id, l);
  }
  const who = (r: { first_name?: string | null; last_name?: string | null; email?: string | null }) => [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || 'Someone';
  const presence = countPresence(res[6].results as { who: string; kind: string; seen_at: number }[], now, null);
  const p = phase(rt, session, now);
  return {
    now,
    session: { id: session.id, starts_at: session.starts_at, title: session.title || w.title, mode: session.mode, stage: chatStage(p, session.starts_at + w.durationMin * 60_000, now, false), minute: Math.floor((now - session.starts_at) / 60_000), durationMin: w.durationMin },
    presence: { ...presence, peak: (res[7].results as { peak_viewers: number }[])[0]?.peak_viewers ?? 0 },
    hostNames: hostNames(rt.settings),
    chat: (res[0].results as (ChatRow & { reg_id: string | null })[]).reverse().map((m) => ({ id: m.id, author: m.author, name: m.name, body: m.body, at: m.at_sec, t: m.created_at, pinned: Boolean(m.pinned_at), deleted: Boolean(m.deleted_at) })),
    questions: (res[1].results as Record<string, unknown>[]).map((q) => ({ id: q.id, name: who(q), email: q.email, question: q.value, ai: q.answer, team: q.team_answer, teamBy: q.team_answer_by, at: q.at_sec, handled: Boolean(q.handled), t: q.created_at })),
    viewers: (res[2].results as Record<string, unknown>[]).map((v) => ({
      reg_id: v.id, lead_id: v.lead_id, name: who(v), band: v.band, bandLabel: REVENUE_LABEL[String(v.band)] ?? null, qualified: isMillionPlus((v.band as string) ?? null),
      minute: Math.floor(Number(v.max_position || 0) / 60), online: Boolean(v.seen_at && now - Number(v.seen_at) <= PRESENCE_MS.viewer), replay: v.pkind === 'replay',
      joined: Boolean(v.joined_at), polls: pollsBy.get(String(v.id)) ?? [],
    })),
    announcements: (res[4].results as (Announcement & { created_at: number; expires_at: number; ended_at: number | null })[]).map((a) => ({ ...a, live: announcementLive(a, now) })),
    raises: (res[5].results as Record<string, unknown>[]).map((h) => ({ id: h.id, name: who(h), email: h.email, phone: h.phone, band: REVENUE_LABEL[String(h.band)] ?? h.band, minute: h.at_sec == null ? null : Math.floor(Number(h.at_sec) / 60), replay: Boolean(h.replay), hostPresent: Boolean(h.host_present), handled: Boolean(h.handled_at), t: h.created_at, lead_id: h.lead_id })),
  };
}

export async function hostPing(rt: Runtime, sessionId: string, hostId: unknown) {
  const id = typeof hostId === 'string' && /^[a-z0-9]{6,32}$/i.test(hostId) ? hostId : null;
  if (!id || !(await getSession(rt, sessionId))) return { ok: false };
  await ping(rt, sessionId, `host:${id}`, 'host', Date.now());
  return { ok: true };
}

export async function hostLeave(rt: Runtime, sessionId: string, hostId: unknown) {
  if (typeof hostId !== 'string') return { ok: false };
  await rt.env.DB.prepare('DELETE FROM webinar_presence WHERE session_id = ? AND who = ?').bind(sessionId, `host:${hostId}`).run();
  return { ok: true };
}

export async function teamChat(rt: Runtime, sessionId: string, body: Record<string, unknown>) {
  if (!(await getSession(rt, sessionId))) return { ok: false, error: 'Showing not found' };
  const text = plain(body.text, CHAT_MAX);
  if (!text) return { ok: false, error: 'Write a message first' };
  const now = Date.now();
  const name = pickHostName(rt.settings, body.name);
  await rt.env.DB.prepare("INSERT INTO webinar_chat (session_id, author, name, body, created_at, updated_at) VALUES (?, 'team', ?, ?, ?, ?)").bind(sessionId, name, text, now, now).run();
  return { ok: true };
}

export async function pinMessage(rt: Runtime, sessionId: string, messageId: unknown) {
  const now = Date.now();
  const db = rt.env.DB;
  await db.prepare('UPDATE webinar_chat SET pinned_at = NULL, updated_at = ? WHERE session_id = ? AND pinned_at IS NOT NULL').bind(now, sessionId).run();
  const id = Number(messageId);
  if (Number.isInteger(id) && id > 0) await db.prepare('UPDATE webinar_chat SET pinned_at = ?, updated_at = ? WHERE id = ? AND session_id = ? AND deleted_at IS NULL').bind(now, now, id, sessionId).run();
  return { ok: true };
}

export async function deleteMessage(rt: Runtime, messageId: string) {
  const now = Date.now();
  await rt.env.DB.prepare('UPDATE webinar_chat SET deleted_at = ?, pinned_at = NULL, updated_at = ? WHERE id = ?').bind(now, now, Number(messageId)).run();
  return { ok: true };
}

/** A private reply to a room question: that viewer sees it in their ask box as "Answered by Josh's team". */
export async function replyQuestion(rt: Runtime, questionId: string, body: Record<string, unknown>) {
  const text = plain(body.text, 1200);
  if (!text) return { ok: false, error: 'Write a reply first' };
  const res = await rt.env.DB.prepare("UPDATE webinar_interactions SET team_answer = ?, team_answer_by = ?, team_answered_at = ?, handled = 1 WHERE id = ? AND kind = 'question'")
    .bind(text, pickHostName(rt.settings, body.name), Date.now(), questionId).run();
  return { ok: (res.meta.changes ?? 0) > 0 };
}

export async function announce(rt: Runtime, sessionId: string, body: Record<string, unknown>) {
  if (!(await getSession(rt, sessionId))) return { ok: false, error: 'Showing not found' };
  const text = plain(body.text, 280);
  if (!text) return { ok: false, error: 'Write the announcement first' };
  const link = body.link_url ? httpsUrl(body.link_url) : null;
  if (body.link_url && !link) return { ok: false, error: 'The button link must start with https://' };
  const minutes = Math.max(1, Math.min(180, Math.round(Number(body.minutes) || 20)));
  const now = Date.now();
  const db = rt.env.DB;
  await db.prepare('UPDATE webinar_announcements SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL AND expires_at > ?').bind(now, sessionId, now).run();
  await db.prepare('INSERT INTO webinar_announcements (id, session_id, body, link_url, link_label, host_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId('wa'), sessionId, text, link, link ? plain(body.link_label, 40) || 'Join here' : null, pickHostName(rt.settings, body.name), now, now + minutes * 60_000).run();
  return { ok: true };
}

export async function endAnnouncement(rt: Runtime, id: string) {
  await rt.env.DB.prepare('UPDATE webinar_announcements SET ended_at = ? WHERE id = ? AND ended_at IS NULL').bind(Date.now(), id).run();
  return { ok: true };
}

/** Scheduled announcement for every showing (autopilot). */
export async function saveAuto(rt: Runtime, body: Record<string, unknown>) {
  const w = webinarSettings(rt);
  const at = Math.round(Number(body.at_min));
  if (!Number.isFinite(at) || at < 0 || at > w.durationMin + AFTER_MIN) return { ok: false, error: `Pick a minute between 0 and ${w.durationMin + AFTER_MIN}` };
  const text = plain(body.text, 280);
  if (!text) return { ok: false, error: 'Write the announcement first' };
  const link = body.link_url ? httpsUrl(body.link_url) : null;
  if (body.link_url && !link) return { ok: false, error: 'The button link must start with https://' };
  const minutes = Math.max(1, Math.min(120, Math.round(Number(body.minutes) || 10)));
  await rt.env.DB.prepare('INSERT INTO webinar_auto_announcements (id, at_min, minutes, body, link_url, link_label, replay, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
    .bind(newId('wq'), at, minutes, text, link, link ? plain(body.link_label, 40) || 'Open' : null, body.replay === false ? 0 : 1, Date.now()).run();
  return { ok: true };
}
export async function setAutoActive(rt: Runtime, id: string, active: boolean) {
  await rt.env.DB.prepare('UPDATE webinar_auto_announcements SET active = ? WHERE id = ?').bind(active ? 1 : 0, id).run();
  return { ok: true };
}
export async function deleteAuto(rt: Runtime, id: string) {
  await rt.env.DB.prepare('DELETE FROM webinar_auto_announcements WHERE id = ?').bind(id).run();
  return { ok: true };
}
export async function handleRaise(rt: Runtime, id: string, handled: boolean) {
  await rt.env.DB.prepare('UPDATE webinar_hand_raises SET handled_at = ? WHERE id = ?').bind(handled ? Date.now() : null, id).run();
  return { ok: true };
}

// ───────────── Funnel HQ insights ─────────────

/** "Live layer" summary for the Webinar insights: chat, team replies, call requests, peak concurrent viewers. */
export async function liveSummary(rt: Runtime, range: { from: number; to: number }) {
  const db = rt.env.DB;
  try {
    const [totals, raises, perShowing] = await db.batch([
      db.prepare(`SELECT SUM(author = 'viewer') AS messages, COUNT(DISTINCT CASE WHEN author = 'viewer' THEN reg_id END) AS chatters, SUM(author = 'team') AS team_messages, SUM(deleted_at IS NOT NULL) AS deleted
                    FROM webinar_chat WHERE created_at BETWEEN ? AND ?`).bind(range.from, range.to),
      db.prepare(`SELECT (SELECT COUNT(*) FROM webinar_hand_raises WHERE created_at BETWEEN ?1 AND ?2) AS raises,
                         (SELECT COUNT(*) FROM webinar_interactions WHERE kind = 'question' AND team_answered_at BETWEEN ?1 AND ?2) AS private_replies,
                         (SELECT COUNT(*) FROM webinar_announcements WHERE created_at BETWEEN ?1 AND ?2) AS announcements`).bind(range.from, range.to),
      db.prepare(`SELECT s.id, s.starts_at, k.peak_viewers,
                         (SELECT COUNT(*) FROM webinar_chat c WHERE c.session_id = s.id AND c.author = 'viewer') AS messages,
                         (SELECT COUNT(*) FROM webinar_chat c WHERE c.session_id = s.id AND c.author = 'team') AS team_messages,
                         (SELECT COUNT(*) FROM webinar_hand_raises h WHERE h.session_id = s.id) AS raises,
                         (SELECT COUNT(*) FROM webinar_announcements a WHERE a.session_id = s.id) AS announcements
                    FROM webinar_sessions s JOIN webinar_live_peaks k ON k.session_id = s.id
                   WHERE s.starts_at BETWEEN ? AND ? ORDER BY s.starts_at DESC LIMIT 30`).bind(range.from, range.to),
    ]);
    const t = (totals.results[0] ?? {}) as Record<string, number | null>;
    const r = (raises.results[0] ?? {}) as Record<string, number | null>;
    return {
      messages: t.messages ?? 0, chatters: t.chatters ?? 0, teamMessages: t.team_messages ?? 0, deleted: t.deleted ?? 0,
      privateReplies: r.private_replies ?? 0, raises: r.raises ?? 0, announcements: r.announcements ?? 0,
      showings: perShowing.results,
    };
  } catch (e) {
    console.error('live summary', e);
    return null;
  }
}

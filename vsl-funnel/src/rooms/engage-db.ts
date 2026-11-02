import type { Runtime } from '../app';
import { getLead, parseAnswers } from '../funnel/leads';
import { hmacHex, safeEqual } from '../lib/crypto';
import { getSecret } from '../lib/secret';
import type { VisitorCtx } from '../lib/identity';
import type { RoomRow } from './rooms';
import type { EngageAvail, Push } from './state';
import {
  ASSETS, ENGAGE_COPY, PLAN_KEYS, type PlanData, type PointAction, type PointRules, ROOM_QUESTION_TITLES, type UnlockRule,
  assetById, cleanPlan, coverage, earnedAt, nextUnlock, parseAgenda, parseRules, parseUnlocks, planSteps, summaryEmail,
} from './engage';

/**
 * Engagement in the database (migration 0055). The room's Durable Object and the room's HTTP calls write here;
 * Funnel HQ and the host's Push panel read the live counts from here (every number is a row someone's action
 * wrote). Attendees of a live event or challenge day also get attribution stage rows and, once each, the Meta
 * custom events for applying and buying from the room (attr_capi de-duplicates them).
 */

type Rt = Pick<Runtime, 'env' | 'settings' | 'origin'>;
type S = Partial<Record<string, string>>;
export interface Who { id: string; name?: string; leadId?: string | null; regId?: string | null }
export type RoomLike = Pick<RoomRow, 'id' | 'ref_type' | 'ref_id' | 'title'> & Partial<Pick<RoomRow, 'mode' | 'status' | 'ended_at' | 'starts_at' | 'engage'>>;

export function engageConfig(rt: Pick<Runtime, 'settings'>) {
  const s = rt.settings as S;
  return { rules: parseRules(s.ENGAGE_POINTS), unlocks: parseUnlocks(s.ENGAGE_UNLOCKS), followups: /^(on|yes|true|1)$/i.test(String(s.ROOM_APP_FOLLOWUPS ?? '').trim()) };
}
/** The room's own engagement settings (Funnel HQ → Rooms): the agenda and whether the leaderboard starts on. */
export function roomEngageSettings(room: Pick<RoomRow, 'engage'> | null | undefined) {
  let o: { agenda?: string; board?: boolean } = {};
  try { o = JSON.parse(room?.engage ?? '{}') ?? {}; } catch { o = {}; }
  return { agenda: parseAgenda(o.agenda), agendaRaw: typeof o.agenda === 'string' ? o.agenda : '', board: o.board === true };
}

const funnelOf = (room: Pick<RoomRow, 'ref_type'>) => (room.ref_type === 'live' ? 'live' as const : room.ref_type === 'challenge' ? 'challenge' as const : null);
const cohortOf = (room: Pick<RoomRow, 'ref_type' | 'ref_id'>) => (room.ref_type === 'challenge' ? (/^challenge:([^:]+):/.exec(room.ref_id ?? '')?.[1] ?? room.ref_id) : room.ref_id);
const dayOf = (room: Pick<RoomRow, 'ref_type' | 'ref_id'>) => (room.ref_type === 'challenge' ? Number(/:(\d)$/.exec(room.ref_id ?? '')?.[1]) || 0 : 0);

/** What can be pushed in this room: the application (needs the lead), the Sprint (on sale, Whop), the deposit (the room's offer), VIP (challenge days). */
export function engageAvail(rt: Pick<Runtime, 'settings'>, room: Pick<RoomRow, 'ref_type' | 'ref_id' | 'mode'>): EngageAvail {
  if (room.mode === 'meeting') return { application: false, sprint: false, deposit: false, vip: false, resources: [] };
  const s = rt.settings as S;
  const funnel = funnelOf(room);
  const day = dayOf(room);
  const sprintOn = String(s.WEBINAR_PASS ?? '').trim().toLowerCase() !== 'off' && Boolean(String(s.WHOP_API_KEY ?? '').trim());
  return {
    application: Boolean(funnel),
    sprint: Boolean(funnel) && sprintOn,
    deposit: room.ref_type === 'live' || day === 4 || day === 5,
    vip: room.ref_type === 'challenge',
    resources: ASSETS.map((a) => a.id),
  };
}

// ───────────── stage rows (attribution) ─────────────

function stageStmt(rt: Rt, room: RoomLike, who: Who, stage: string, key: string | null, at: number, value: number | null, detail: string | null) {
  const funnel = funnelOf(room);
  if (!funnel || !who.regId || !who.leadId) return null;
  const id = `${funnel}:${who.regId}:${stage}${key ? `:${key}` : ''}`.slice(0, 200);
  return rt.env.DB.prepare(
    `INSERT OR IGNORE INTO attr_stages (id, funnel, stage, lead_id, reg_id, cohort_ref, edition, ts, value, detail, source) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'room')`,
  ).bind(id, funnel, stage, who.leadId, who.regId, cohortOf(room), at, value, detail);
}
async function stage(rt: Rt, room: RoomLike, who: Who, stageId: string, key: string | null, at: number, value: number | null = null, detail: string | null = null) {
  const st = stageStmt(rt, room, who, stageId, key, at, value, detail);
  if (st) await st.run().catch((e) => console.error('room stage', String(e).slice(0, 200)));
}

// ───────────── points and unlocks ─────────────

export interface AwardInput { who: Who; action: PointAction; key: string }
export interface AwardResult { who: string; action: PointAction; points: number }

/**
 * Records awards in one go. Each award is one row keyed (room, person, action, key), written only while that
 * person has fewer rows for the action than its cap: a repeat, a replay of the same message or a spammer
 * never gets more than the rule allows. Returns the awards that were actually written.
 */
export async function awardPoints(rt: Rt, room: RoomLike, list: AwardInput[], rules: PointRules, now = Date.now()): Promise<AwardResult[]> {
  const db = rt.env.DB;
  const out: AwardResult[] = [];
  const wanted = list.filter((a) => rules[a.action] && rules[a.action].points > 0);
  for (let i = 0; i < wanted.length; i += 40) {
    const chunk = wanted.slice(i, i + 40);
    const res = await db.batch(chunk.map((a) => db.prepare(
      `INSERT OR IGNORE INTO room_points (room_id, who, action, key, points, lead_id, reg_id, at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM room_points WHERE room_id = ? AND who = ? AND action = ?) < ?`,
    ).bind(room.id, a.who.id, a.action, a.key.slice(0, 60), rules[a.action].points, a.who.leadId ?? null, a.who.regId ?? null, now, room.id, a.who.id, a.action, rules[a.action].cap)));
    const follow = [];
    for (let k = 0; k < chunk.length; k++) {
      const changes = (res[k] as { meta?: { changes?: number } })?.meta?.changes ?? 0;
      if (!changes) continue;
      const a = chunk[k];
      const pts = rules[a.action].points;
      out.push({ who: a.who.id, action: a.action, points: pts });
      if (a.who.leadId) follow.push(db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').bind(now, a.who.leadId));
      const s1 = stageStmt(rt, room, a.who, 'room_points', `${room.id}:${a.action}:${a.key}`, now, pts, a.action);
      if (s1) follow.push(s1);
      if (a.action === 'stayed_end') { const s2 = stageStmt(rt, room, a.who, 'room_stayed_end', null, now, null, room.id); if (s2) follow.push(s2); }
    }
    if (follow.length) await db.batch(follow).catch((e) => console.error('room award follow-up', String(e).slice(0, 200)));
  }
  return out;
}

/** A person's points in this room (the database is the truth; the room keeps a copy for its views). */
export async function roomPoints(rt: Rt, roomId: string, who: string) {
  const r = await rt.env.DB.prepare('SELECT COALESCE(SUM(points), 0) AS n FROM room_points WHERE room_id = ? AND who = ?').bind(roomId, who).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Grants assets (once each). Returns the ones newly granted. */
export async function grantUnlocks(rt: Rt, room: RoomLike, who: Who, assets: string[], source: 'points' | 'end' | 'push', now = Date.now()) {
  const fresh: string[] = [];
  for (const a of assets) {
    if (!assetById(a)) continue;
    const r = await rt.env.DB.prepare('INSERT OR IGNORE INTO room_unlocks (room_id, who, asset, source, lead_id, at) VALUES (?, ?, ?, ?, ?, ?)').bind(room.id, who.id, a, source, who.leadId ?? null, now).run();
    if ((r.meta.changes ?? 0) > 0) { fresh.push(a); await stage(rt, room, who, 'room_unlock', `${room.id}:${a}`, now, null, `${a}:${source}`); }
  }
  return fresh;
}
/** The threshold unlocks these points have reached. */
export const thresholdUnlocks = (unlocks: UnlockRule[], points: number) => earnedAt(unlocks, points);
export const endUnlocks = (unlocks: UnlockRule[]) => unlocks.filter((u) => u.at === 'end').map((u) => u.asset);

// ───────────── signed links: an unlocked asset, a Deal Plan ─────────────

const sig = async (rt: Pick<Runtime, 'env'>, what: string) => (await hmacHex(await getSecret(rt.env), what)).slice(0, 24);
export async function assetUrl(rt: Rt, roomId: string, who: string, asset: string) {
  return `${rt.origin}/rooms/a/${roomId}/${encodeURIComponent(who)}/${asset}.${await sig(rt, `ra|${roomId}|${who}|${asset}`)}`;
}
export async function checkAssetLink(rt: Rt, roomId: string, who: string, ref: string) {
  const m = /^([a-z]{2,20})\.([0-9a-f]{24})$/.exec(ref);
  if (!m || !safeEqual(await sig(rt, `ra|${roomId}|${who}|${m[1]}`), m[2])) return null;
  const row = await rt.env.DB.prepare('SELECT asset FROM room_unlocks WHERE room_id = ? AND who = ? AND asset = ?').bind(roomId, who, m[1]).first<{ asset: string }>();
  if (!row) return null;
  await rt.env.DB.prepare('UPDATE room_unlocks SET opened_at = COALESCE(opened_at, ?) WHERE room_id = ? AND who = ? AND asset = ?').bind(Date.now(), roomId, who, m[1]).run();
  return assetById(m[1]);
}
export async function planUrl(rt: Rt, roomId: string, who: string) {
  return `${rt.origin}/rooms/plan/${roomId}/${encodeURIComponent(who)}.${await sig(rt, `rp|${roomId}|${who}`)}`;
}
export async function checkPlanLink(rt: Rt, roomId: string, ref: string) {
  const m = /^([A-Za-z0-9_-]{2,60})\.([0-9a-f]{24})$/.exec(ref);
  if (!m || !safeEqual(await sig(rt, `rp|${roomId}|${m[1]}`), m[2])) return null;
  return m[1];
}

// ───────────── pushes ─────────────

export async function savePush(rt: Rt, roomId: string, p: Push, targetCount: number) {
  const db = rt.env.DB;
  await db.batch([
    db.prepare("UPDATE room_pushes SET closed_at = COALESCE(closed_at, ?) WHERE room_id = ? AND kind = ? AND COALESCE(ref, '') = ? AND closed_at IS NULL").bind(p.at, roomId, p.kind, p.ref ?? ''),
    db.prepare('INSERT OR IGNORE INTO room_pushes (room_id, id, kind, ref, targets, target_count, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(roomId, p.id, p.kind, p.ref, p.to ? JSON.stringify(p.to) : null, targetCount, p.by, p.at),
  ]);
}
export async function closePushes(rt: Rt, roomId: string, ids: number[] | 'all_but_deposit', now = Date.now()) {
  if (ids === 'all_but_deposit') { await rt.env.DB.prepare("UPDATE room_pushes SET closed_at = COALESCE(closed_at, ?) WHERE room_id = ? AND kind != 'deposit'").bind(now, roomId).run(); return; }
  for (const id of ids) await rt.env.DB.prepare('UPDATE room_pushes SET closed_at = COALESCE(closed_at, ?) WHERE room_id = ? AND id = ?').bind(now, roomId, id).run();
}
/** The latest push of this kind meant for this person (open only, unless anyOpen is false). */
export async function pushFor(rt: Rt, roomId: string, who: string, kind: Push['kind'], o: { open?: boolean } = {}) {
  return rt.env.DB.prepare(
    `SELECT * FROM room_pushes WHERE room_id = ? AND kind = ? ${o.open === false ? '' : 'AND closed_at IS NULL'}
       AND (targets IS NULL OR EXISTS (SELECT 1 FROM json_each(room_pushes.targets) WHERE json_each.value = ?)) ORDER BY id DESC LIMIT 1`,
  ).bind(roomId, kind, who).first<{ id: number; kind: string; ref: string | null; created_at: number; closed_at: number | null }>();
}
export type PushEventKind = 'shown' | 'opened' | 'started' | 'submitted' | 'paid' | 'dismissed';
export async function recordPushEvent(rt: Rt, room: RoomLike, pushId: number, who: Who, ev: PushEventKind, kind: string, now = Date.now()) {
  const r = await rt.env.DB.prepare('INSERT OR IGNORE INTO room_push_events (room_id, push_id, who, event, lead_id, at) VALUES (?, ?, ?, ?, ?, ?)').bind(room.id, pushId, who.id, ev, who.leadId ?? null, now).run();
  if ((r.meta.changes ?? 0) > 0) await stage(rt, room, who, 'room_push', `${room.id}:${pushId}:${ev}`, now, pushId, `${kind}:${ev}`);
  return (r.meta.changes ?? 0) > 0;
}

// ───────────── knowledge checks ─────────────

export async function recordQuiz(rt: Rt, room: RoomLike, who: Who, quizId: number, choice: number, correct: boolean, question: string, now = Date.now()) {
  await rt.env.DB.prepare('INSERT OR IGNORE INTO room_quiz_answers (room_id, quiz_id, who, question, choice, correct, lead_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(room.id, quizId, who.id, question.slice(0, 240), choice, correct ? 1 : 0, who.leadId ?? null, now).run();
  await stage(rt, room, who, 'room_quiz', `${room.id}:${quizId}`, now, correct ? 1 : 0, question.slice(0, 120));
}

// ───────────── the Deal Plan ─────────────

export async function getPlan(rt: Rt, roomId: string, who: string) {
  const row = await rt.env.DB.prepare('SELECT * FROM room_plans WHERE room_id = ? AND who = ?').bind(roomId, who).first<{ data: string; steps: string; updated_at: number; lead_id: string | null }>();
  if (!row) return null;
  let data: PlanData;
  try { data = cleanPlan(JSON.parse(row.data)); } catch { data = cleanPlan({}); }
  let steps: string[] = [];
  try { steps = JSON.parse(row.steps); } catch { steps = []; }
  return { data, steps, updatedAt: row.updated_at, leadId: row.lead_id };
}
/** Saves the worksheet; returns the steps now complete and the ones newly completed (each counts once). */
export async function savePlan(rt: Rt, room: RoomLike, who: Who, raw: unknown, now = Date.now()) {
  const data = cleanPlan(raw);
  const prev = await getPlan(rt, room.id, who.id);
  const steps = planSteps(data);
  const newly = steps.filter((x) => !(prev?.steps ?? []).includes(x));
  const all = [...new Set([...(prev?.steps ?? []), ...steps])];
  await rt.env.DB.prepare(
    `INSERT INTO room_plans (room_id, who, lead_id, reg_id, data, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(room_id, who) DO UPDATE SET data = excluded.data, steps = excluded.steps, updated_at = excluded.updated_at, lead_id = COALESCE(room_plans.lead_id, excluded.lead_id)`,
  ).bind(room.id, who.id, who.leadId ?? null, who.regId ?? null, JSON.stringify(data), JSON.stringify(all), now, now).run();
  for (const s of newly) await stage(rt, room, who, 'room_plan_step', `${room.id}:${s}`, now, null, s);
  return { data, steps: all, newly };
}

// ───────────── the application inside the room ─────────────

/** The questions (same ids, options and scoring as /apply; the contact step is the registration itself). */
export async function roomQuestions() {
  const { APPLICATION } = await import('../config');
  return APPLICATION.filter((q) => q.type !== 'contact').map((q) => {
    const o = ROOM_QUESTION_TITLES[q.id];
    const base = { id: q.id, type: q.type, title: o?.title ?? q.title, help: o?.help ?? q.help ?? null };
    if (q.type === 'text') return { ...base, placeholder: q.placeholder ?? '', minLength: q.minLength };
    return { ...base, options: q.options.filter((x) => !x.hidden).map((x) => ({ value: x.value, label: x.label })) };
  });
}
/** Their answers so far, with the revenue and the business filled in from the registration when not answered yet. */
export async function prefill(rt: Rt, leadId: string) {
  const lead = await getLead(rt.env, leadId);
  if (!lead) return null;
  const { APP_REVENUE_BAND } = await import('../sales/qualify');
  const answers = parseAnswers(lead) as Record<string, unknown>;
  const fromBand = Object.entries(APP_REVENUE_BAND).find(([k, v]) => v === lead.revenue_band && k !== 'gt10m')?.[0];
  if (answers.revenue === undefined && fromBand) answers.revenue = fromBand;
  if (answers.business === undefined && lead.industry) answers.business = lead.industry;
  return { lead, answers, name: [lead.first_name, lead.last_name].filter(Boolean).join(' '), email: lead.email, submitted: Boolean(lead.app_completed_at) };
}

/** A visitor context for the scoring code, from the lead's own tracking identity and this request. */
export async function roomVisitor(rt: Rt, leadId: string, req: Request | null): Promise<VisitorCtx> {
  const { identityFromLead } = await import('../tracking/track');
  const { parseUA } = await import('../lib/ua');
  const { geoFromRequest } = await import('../lib/geo');
  const who = await identityFromLead(rt.env, leadId);
  const lead = await getLead(rt.env, leadId);
  const ua = req?.headers.get('user-agent') ?? who.userAgent ?? '';
  const geo = req ? geoFromRequest(req) : ({ country: null, region: null, regionCode: null, city: null, postalCode: null, timezone: null, latitude: null, longitude: null, continent: null, isEU: false, asn: null } as unknown as VisitorCtx['geo']);
  return {
    visitorId: who.visitorId ?? `room-${leadId}`, sessionId: who.sessionId ?? `room-${leadId}`, leadId, isNewVisitor: false, isNewSession: false, isBot: false, botReason: null,
    variant: who.variant ?? lead?.variant ?? 'a', ua: parseUA(ua), userAgent: ua, geo: { ...geo, country: lead?.country ?? geo.country }, ip: req?.headers.get('cf-connecting-ip') ?? who.ip ?? null,
    touch: null, fbp: who.fbp ?? null, fbc: who.fbc ?? null, marketingConsent: who.marketingConsent ?? false, consentRequired: false,
  } as VisitorCtx;
}

export class RoomError extends Error { constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 502 = 400, readonly field?: string) { super(message); } }

/**
 * The application sent from the room: every answer through saveAnswer (the same validation), then
 * submitApplication (the same scoring, tier, routing, lead record, Slack alert and, unless ROOM_APP_FOLLOWUPS
 * is off, the same emails). Only for someone the host pushed the application to.
 */
export async function submitRoomApplication(rt: Runtime, room: RoomLike, who: Who, body: { answers?: unknown }, req: Request | null, now = Date.now()) {
  if (!who.leadId) throw new RoomError(ENGAGE_COPY.appNeedsLead, 403);
  const push = await pushFor(rt, room.id, who.id, 'application', { open: false });
  if (!push) throw new RoomError(ENGAGE_COPY.errors.not_targeted, 403);
  const { saveAnswer, submitApplication } = await import('../funnel/application');
  const answers = (body.answers && typeof body.answers === 'object' ? body.answers : {}) as Record<string, unknown>;
  const v = await roomVisitor(rt, who.leadId, req);
  const qs = await roomQuestions();
  for (const q of qs) {
    if (answers[q.id] === undefined) continue;
    const lead = await getLead(rt.env, who.leadId);
    if (!lead) throw new RoomError(ENGAGE_COPY.appNeedsLead, 404);
    try { await saveAnswer(rt, v, lead, q.id, answers[q.id]); } catch (e) { throw new RoomError(e instanceof Error ? e.message : ENGAGE_COPY.appMissing, 400, q.id); }
  }
  const lead = await getLead(rt.env, who.leadId);
  if (!lead) throw new RoomError(ENGAGE_COPY.appNeedsLead, 404);
  let result;
  try {
    result = await submitApplication(rt, v, lead, undefined, { followups: engageConfig(rt).followups, path: '/rooms' });
  } catch (e) {
    // The application's own errors (a missing answer) go back to the attendee; anything else is logged.
    if ((e as { field?: string }).field) throw new RoomError(e instanceof Error ? e.message : ENGAGE_COPY.appMissing, 400, (e as { field?: string }).field);
    console.error('room application', e);
    throw new RoomError(ENGAGE_COPY.appMissing, 502);
  }
  await recordPushEvent(rt, room, push.id, who, 'submitted', 'application', now);
  await stage(rt, room, who, 'room_application', null, now, result.score, result.tier);
  await (await import('./audience-db')).announceApplication(rt, room.id, who.leadId, now).catch(() => null); // area C (consent only)
  if (funnelOf(room) && who.regId) {
    const { sendStageEvent } = await import('../attribution/hooks');
    await sendStageEvent(rt, { kind: 'room_application', funnel: funnelOf(room)!, regId: who.regId, leadId: who.leadId }).catch(() => null);
  }
  return { tier: result.tier, score: result.score, pushId: push.id };
}

// ───────────── the First Deal Sprint from the room ─────────────

export async function sprintCard(rt: Runtime, leadId: string | null | undefined) {
  const { passConfig, activePass, formatMoney, fromMinor, paymentProvider } = await import('../webinar/pass');
  const { sprintCopy, sprintPrice, ticketCredit, mmss, pitchSec } = await import('../webinar/sprint');
  const { isMillionPlus } = await import('../sales/qualify');
  const cfg = passConfig(rt.settings);
  const t = sprintCopy(cfg, { opensAt: mmss(pitchSec(rt)) });
  const lead = leadId ? await getLead(rt.env, leadId) : null;
  const credit = lead ? await ticketCredit(rt, lead.id, cfg.currency) : 0;
  const price = sprintPrice(cfg, null, credit);
  const { savedCard } = await import('../sales/deposit');
  const { cardLabel } = await import('../webinar/one-click');
  const card = lead && paymentProvider(rt.settings) === 'whop' ? await savedCard(rt, lead.id) : null;
  return {
    name: cfg.offerName, heading: t.heading, promise: t.promise, lede: t.lede, button: t.button, guarantee: t.guaranteeShort, creditNote: t.creditNote,
    priceLabel: cfg.priceLabel, todayLabel: price.todayLabel, line: price.line, list: fromMinor(cfg.amount, cfg.currency), currency: cfg.currency, formatted: formatMoney(fromMinor(price.today, cfg.currency), cfg.currency),
    perks: cfg.perks.map((p) => p.title).slice(0, 6),
    available: cfg.mode !== 'off' && paymentProvider(rt.settings) === 'whop',
    qualified: Boolean(lead && isMillionPlus(lead.revenue_band)),
    paid: Boolean(lead && (await activePass(rt, lead.id))),
    oneClick: card ? { card: cardLabel(card.card_brand, card.card_last4) } : null,
  };
}

/**
 * Starts the Sprint for someone the host pushed the Sprint card to (an open push): one click on the card saved
 * with their ticket, else our Whop payment page. Price: the Sprint price (WEBINAR_PASS_PRICE) less their paid
 * masterclass tickets, exactly as in the masterclass. Returns { paid, url } or { url } or { error }.
 */
export async function startRoomSprint(rt: Runtime, room: RoomLike, who: Who, o: { oneClick?: boolean; returnUrl: string }, x: { now?: number; sleep?: (ms: number) => Promise<unknown>; tries?: number } = {}): Promise<{ url?: string; paid?: boolean; error?: string }> {
  const now = x.now ?? Date.now();
  if (!who.leadId) return { error: ENGAGE_COPY.appNeedsLead };
  const push = await pushFor(rt, room.id, who.id, 'sprint');
  if (!push) return { error: ENGAGE_COPY.errors.not_targeted };
  const { passConfig, passCapacity, passCopy, fromMinor, paymentProvider, activePass } = await import('../webinar/pass');
  const { sprintPrice, ticketCredit } = await import('../webinar/sprint');
  const { isMillionPlus } = await import('../sales/qualify');
  const lead = await getLead(rt.env, who.leadId);
  if (!lead) return { error: ENGAGE_COPY.appNeedsLead };
  const cfg = passConfig(rt.settings);
  if (await activePass(rt, lead.id)) return { paid: true, url: o.returnUrl };
  if (cfg.mode === 'off' || paymentProvider(rt.settings) !== 'whop') return { error: ENGAGE_COPY.sprintUnavailable };
  if (!isMillionPlus(lead.revenue_band)) return { error: ENGAGE_COPY.sprintUnderMillion };
  const cap = await passCapacity(rt, cfg, now);
  if (cap.full) return { error: passCopy(cfg).soldOut };
  const credit = await ticketCredit(rt, lead.id, cfg.currency);
  const price = sprintPrice(cfg, null, credit);
  await recordPushEvent(rt, room, push.id, who, 'started', 'sprint', now);
  const regId = `room:${room.id}:${who.id}`.slice(0, 120);
  const base = { kind: 'offer' as const, regId, leadId: lead.id, product: cfg.offerName, currency: cfg.currency, source: 'room', refId: room.id, returnUrl: o.returnUrl, ticketCredit: price.credit, listAmount: cfg.amount, now };
  const { payPageUrl, pendingRow } = await import('../sales/pay-page');
  const { identityFromLead, track } = await import('../tracking/track');
  const log = (outcome: string, props: Record<string, unknown> = {}) => identityFromLead(rt.env, lead.id).then((i) => track(rt as Runtime, i, { name: 'webinar_checkout_started', source: 'server', props: { kind: 'offer', from: 'room', room_id: room.id, outcome, ...props }, localOnly: true })).catch(() => null);
  if (price.today <= 0) {
    const id = await pendingRow(rt, { ...base, amount: 0, embedded: false });
    const { markPassPaid } = await import('../webinar/pass');
    await markPassPaid(rt, { sessionId: `credit_${id}`, paymentIntent: null, amount: 0, currency: cfg.currency, regId, passId: id, kind: 'offer', provider: 'whop' });
    return { paid: true, url: o.returnUrl };
  }
  if (o.oneClick) {
    const { oneClickCharge } = await import('../sales/deposit');
    const r = await oneClickCharge(rt, { ...base, amount: price.today, description: `${cfg.offerName} with G&L M&A Advisory: seven days with Josh’s team.` }, x).catch((e) => { console.error('room sprint one click', String(e).slice(0, 200)); return null; });
    if (r && 'paid' in r && r.paid) { await log('one_click_paid'); return { paid: true, url: o.returnUrl }; }
    if (r && 'url' in r && r.url) { await log('one_click_action'); return { url: r.url }; }
    await log('one_click_fallback');
  }
  const id = await pendingRow(rt, { ...base, amount: price.today });
  await log('page', { pass_id: id, value: fromMinor(price.today, cfg.currency) });
  return { url: await payPageUrl(rt, id) };
}

/**
 * A paid Sprint or deposit (called from passPaidEffects): when the buyer started it from a card pushed in one of
 * our rooms, the push gets its paid event, the room's Sprint gets its delivery row, and Meta gets the room
 * purchase custom event once per registration.
 */
export async function onRoomPurchase(rt: Runtime, pass: { id: string; kind: string; lead_id: string; paid_at?: number | null; source?: string | null; ref_id?: string | null; reg_id?: string | null }) {
  if (pass.kind !== 'offer' && pass.kind !== 'deposit') return;
  const db = rt.env.DB;
  const now = pass.paid_at ?? Date.now();
  const kind = pass.kind === 'offer' ? 'sprint' : 'deposit';
  // Area C: a buyer who ticked the announcement box in a live room is announced there (first name and city, once).
  await (await import('./audience-db')).announcePurchase(rt, pass, now).catch((e) => console.error('room proof', String(e).slice(0, 200)));
  // The push this purchase came from: the room's Sprint names its room; a deposit is matched to the buyer's latest push in the last two days.
  const ev = await db.prepare(
    `SELECT e.room_id, e.push_id, e.who FROM room_push_events e JOIN room_pushes p ON p.room_id = e.room_id AND p.id = e.push_id
      WHERE e.lead_id = ? AND p.kind = ? AND e.event IN ('opened', 'started') AND e.at > ? ${pass.source === 'room' && pass.ref_id ? 'AND e.room_id = ?' : ''}
      ORDER BY e.at DESC LIMIT 1`,
  ).bind(...[pass.lead_id, kind, now - 2 * 86_400_000, ...(pass.source === 'room' && pass.ref_id ? [pass.ref_id] : [])]).first<{ room_id: string; push_id: number; who: string }>();
  if (pass.kind === 'offer' && pass.source === 'room') {
    const { ensureDealSprint } = await import('../webinar/deal-sprint');
    await ensureDealSprint(rt, { id: pass.id, lead_id: pass.lead_id }).catch((e) => console.error('room sprint delivery row', e));
  }
  if (!ev) return;
  const room = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(ev.room_id).first<RoomRow>();
  if (!room) return;
  const att = await db.prepare('SELECT reg_id FROM room_attendance WHERE room_id = ? AND who = ?').bind(ev.room_id, ev.who).first<{ reg_id: string | null }>();
  const who: Who = { id: ev.who, leadId: pass.lead_id, regId: att?.reg_id ?? null };
  await recordPushEvent(rt, room, ev.push_id, who, 'paid', kind, now);
  if (funnelOf(room) && who.regId) {
    const { sendStageEvent } = await import('../attribution/hooks');
    await sendStageEvent(rt, { kind: 'room_purchase', funnel: funnelOf(room)!, regId: who.regId, leadId: pass.lead_id }).catch(() => null);
  }
}

// ───────────── what the attendee's browser loads ─────────────

export async function attendeeEngage(rt: Runtime, room: RoomLike, who: Who) {
  const cfg = engageConfig(rt);
  const db = rt.env.DB;
  const [pts, unl, plan] = await Promise.all([
    roomPoints(rt, room.id, who.id),
    db.prepare('SELECT asset FROM room_unlocks WHERE room_id = ? AND who = ?').bind(room.id, who.id).all<{ asset: string }>(),
    getPlan(rt, room.id, who.id),
  ]);
  const have = new Set(unl.results.map((r) => r.asset));
  const assets = [];
  for (const a of ASSETS) {
    const rule = cfg.unlocks.find((u) => u.asset === a.id);
    if (!rule && !have.has(a.id)) continue;
    assets.push({ id: a.id, title: a.title, body: a.body, at: rule?.at ?? null, url: have.has(a.id) ? await assetUrl(rt, room.id, who.id, a.id) : null });
  }
  const pre = who.leadId ? await prefill(rt, who.leadId) : null;
  const avail = engageAvail(rt, { ref_type: room.ref_type, ref_id: room.ref_id, mode: room.mode ?? 'webinar' });
  let vip: { url: string; label: string } | null = null;
  if (avail.vip && who.regId) {
    const reg = await db.prepare('SELECT token FROM challenge_registrations WHERE id = ?').bind(who.regId).first<{ token: string }>();
    const { vipUrl } = await import('../challenge/payments');
    if (reg) vip = { url: vipUrl(rt, reg.token), label: String((rt.settings as S).CHALLENGE_VIP_PRICE ?? '').trim() ? `$${String((rt.settings as S).CHALLENGE_VIP_PRICE).trim()}` : '' };
  }
  return {
    points: pts,
    rules: (Object.keys(cfg.rules) as PointAction[]).map((k) => ({ action: k, label: cfg.rules[k].label, points: cfg.rules[k].points, cap: cfg.rules[k].cap })).filter((r) => r.points > 0),
    next: nextUnlock(cfg.unlocks, pts),
    assets,
    plan: plan ? { data: plan.data, steps: plan.steps } : null,
    app: pre ? { name: pre.name, email: pre.email, answers: pre.answers, submitted: pre.submitted, questions: await roomQuestions() } : null,
    sprint: avail.sprint ? await sprintCard(rt, who.leadId) : null,
    vip,
  };
}

// ───────────── the host's live counts and Funnel HQ ─────────────

const EVENTS: PushEventKind[] = ['shown', 'opened', 'started', 'submitted', 'paid', 'dismissed'];

export async function pushStats(rt: Rt, roomId: string) {
  const db = rt.env.DB;
  const [pushes, counts, apps] = await Promise.all([
    db.prepare('SELECT * FROM room_pushes WHERE room_id = ? ORDER BY id DESC LIMIT 40').bind(roomId).all<{ id: number; kind: string; ref: string | null; target_count: number; created_at: number; closed_at: number | null }>(),
    db.prepare('SELECT push_id, event, COUNT(*) AS n FROM room_push_events WHERE room_id = ? GROUP BY push_id, event').bind(roomId).all<{ push_id: number; event: string; n: number }>(),
    db.prepare(`SELECT e.who, e.at, e.lead_id, l.tier, l.score, COALESCE(a.name, l.first_name) AS name FROM room_push_events e
                  LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN room_attendance a ON a.room_id = e.room_id AND a.who = e.who
                 WHERE e.room_id = ? AND e.event = 'submitted' ORDER BY e.at DESC LIMIT 100`).bind(roomId).all<{ who: string; at: number; lead_id: string | null; tier: string | null; score: number | null; name: string | null }>(),
  ]);
  return {
    pushes: pushes.results.map((p) => {
      const c: Record<string, number> = {};
      for (const e of EVENTS) c[e] = counts.results.find((x) => x.push_id === p.id && x.event === e)?.n ?? 0;
      return { id: p.id, kind: p.kind, ref: p.ref, title: p.kind === 'resource' ? assetById(p.ref)?.title ?? p.ref : null, targets: p.target_count, at: p.created_at, open: !p.closed_at, counts: c };
    }),
    applications: apps.results.map((a) => ({ name: a.name ?? 'Someone', tier: a.tier, score: a.score, at: a.at })),
  };
}

/** Funnel HQ → Rooms → Engagement: the push funnel, points distribution, retention curve, people and the room's rules. */
export async function engageReport(rt: Runtime, room: RoomLike, topQuestions: { text: string; votes: number; name: string; answered: boolean }[] = []) {
  const db = rt.env.DB;
  const cfg = engageConfig(rt);
  const [people, minutes, quiz, plans, unlocks] = await Promise.all([
    db.prepare(`SELECT a.who, a.name, a.lead_id, a.minutes, a.first_at, a.last_at, l.email, l.tier, l.app_completed_at,
                       (SELECT COALESCE(SUM(points), 0) FROM room_points p WHERE p.room_id = a.room_id AND p.who = a.who) AS points
                  FROM room_attendance a LEFT JOIN leads l ON l.id = a.lead_id WHERE a.room_id = ? AND a.role IN ('attendee', 'guest') ORDER BY points DESC, a.first_at LIMIT 2000`).bind(room.id)
      .all<{ who: string; name: string; lead_id: string | null; minutes: number; first_at: number; last_at: number; email: string | null; tier: string | null; app_completed_at: number | null; points: number }>(),
    db.prepare('SELECT minute, n FROM room_minutes WHERE room_id = ? ORDER BY minute LIMIT 600').bind(room.id).all<{ minute: number; n: number }>(),
    db.prepare('SELECT quiz_id, question, COUNT(*) AS n, SUM(correct) AS right FROM room_quiz_answers WHERE room_id = ? GROUP BY quiz_id ORDER BY quiz_id').bind(room.id).all<{ quiz_id: number; question: string; n: number; right: number }>(),
    db.prepare('SELECT who, steps FROM room_plans WHERE room_id = ?').bind(room.id).all<{ who: string; steps: string }>(),
    db.prepare('SELECT who, COUNT(*) AS n FROM room_unlocks WHERE room_id = ? GROUP BY who').bind(room.id).all<{ who: string; n: number }>(),
  ]);
  const stepsOf = (who: string) => { try { return (JSON.parse(plans.results.find((p) => p.who === who)?.steps ?? '[]') as string[]).length; } catch { return 0; } };
  const buckets = [0, 25, 50, 100, 150, 200].map((from, i, arr) => ({ from, to: arr[i + 1] ?? null, n: people.results.filter((p) => p.points >= from && (arr[i + 1] == null || p.points < arr[i + 1])).length }));
  const stats = await pushStats(rt, room.id);
  return {
    rules: cfg.rules, unlocks: cfg.unlocks.map((u) => ({ ...u, title: assetById(u.asset)?.title ?? u.asset })), settings: roomEngageSettings(room as Pick<RoomRow, 'engage'>),
    pushes: stats.pushes, applications: stats.applications,
    points: { buckets, total: people.results.reduce((s, p) => s + p.points, 0) },
    retention: minutes.results,
    quiz: quiz.results.map((q) => ({ id: q.quiz_id, question: q.question, answers: q.n, right: q.right })),
    questions: topQuestions,
    people: people.results.map((p) => ({ who: p.who, name: p.name, email: p.email, minutes: p.minutes, points: p.points, tier: p.tier, applied: Boolean(p.app_completed_at), planSteps: stepsOf(p.who), unlocks: unlocks.results.find((u) => u.who === p.who)?.n ?? 0 })),
  };
}

/** One person's timeline in a room (Funnel HQ): joins, awards, pushes, knowledge checks, unlocks, the Deal Plan. */
export async function personTimeline(rt: Runtime, roomId: string, who: string) {
  const db = rt.env.DB;
  const [att, pts, evs, quiz, unl, plan] = await Promise.all([
    db.prepare('SELECT * FROM room_attendance WHERE room_id = ? AND who = ?').bind(roomId, who).first<{ name: string; first_at: number; last_at: number; minutes: number; lead_id: string | null }>(),
    db.prepare('SELECT action, key, points, at FROM room_points WHERE room_id = ? AND who = ? ORDER BY at').bind(roomId, who).all<{ action: PointAction; key: string; points: number; at: number }>(),
    db.prepare('SELECT e.push_id, e.event, e.at, p.kind, p.ref FROM room_push_events e LEFT JOIN room_pushes p ON p.room_id = e.room_id AND p.id = e.push_id WHERE e.room_id = ? AND e.who = ? ORDER BY e.at').bind(roomId, who).all<{ push_id: number; event: string; at: number; kind: string; ref: string | null }>(),
    db.prepare('SELECT question, correct, at FROM room_quiz_answers WHERE room_id = ? AND who = ? ORDER BY at').bind(roomId, who).all<{ question: string; correct: number; at: number }>(),
    db.prepare('SELECT asset, source, at, opened_at FROM room_unlocks WHERE room_id = ? AND who = ? ORDER BY at').bind(roomId, who).all<{ asset: string; source: string; at: number; opened_at: number | null }>(),
    getPlan(rt, roomId, who),
  ]);
  const rules = engageConfig(rt).rules;
  const items: { at: number; text: string }[] = [];
  if (att) items.push({ at: att.first_at, text: 'Joined the room' });
  for (const p of pts.results) items.push({ at: p.at, text: `${rules[p.action]?.label ?? p.action}: +${p.points}` });
  for (const e of evs.results) items.push({ at: e.at, text: `${e.kind === 'resource' ? assetById(e.ref)?.title ?? 'Resource' : e.kind} card: ${e.event}` });
  for (const q of quiz.results) items.push({ at: q.at, text: `Knowledge check ${q.correct ? 'right' : 'wrong'}: ${q.question}` });
  for (const u of unl.results) items.push({ at: u.at, text: `Unlocked ${assetById(u.asset)?.title ?? u.asset} (${u.source})${u.opened_at ? ', opened' : ''}` });
  if (att) items.push({ at: att.last_at, text: `Last seen (${att.minutes} minutes in all)` });
  items.sort((a, b) => a.at - b.at);
  return { name: att?.name ?? who, leadId: att?.lead_id ?? null, items, plan: plan ? { ...plan.data, steps: plan.steps, coverage: coverage(plan.data) } : null };
}

/** The lead's engagement across rooms, for the lead drawer and the webinar AI calls. */
export async function leadEngagement(rt: Pick<Runtime, 'env'>, leadId: string) {
  const db = rt.env.DB;
  const [pts, plan, applied] = await Promise.all([
    db.prepare('SELECT COALESCE(SUM(points), 0) AS n, COUNT(DISTINCT room_id) AS rooms FROM room_points WHERE lead_id = ?').bind(leadId).first<{ n: number; rooms: number }>(),
    db.prepare('SELECT data, steps, room_id, updated_at FROM room_plans WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 1').bind(leadId).first<{ data: string; steps: string; room_id: string; updated_at: number }>(),
    db.prepare("SELECT 1 AS x FROM room_push_events WHERE lead_id = ? AND event = 'submitted' LIMIT 1").bind(leadId).first(),
  ]);
  let data: PlanData | null = null;
  try { data = plan ? cleanPlan(JSON.parse(plan.data)) : null; } catch { data = null; }
  return { points: pts?.n ?? 0, rooms: pts?.rooms ?? 0, applied: Boolean(applied), plan: data, planRoom: plan?.room_id ?? null };
}
/** One line for the AI call's facts (empty when the person did nothing in a room). */
export async function callNote(rt: Pick<Runtime, 'env'>, leadId: string) {
  const e = await leadEngagement(rt, leadId).catch(() => null);
  if (!e || (!e.points && !e.plan)) return '';
  const parts = [`- In the live room they earned ${e.points} Deal momentum points${e.applied ? ' and sent the application' : ''}.`];
  if (e.plan) {
    const box = [e.plan.industry, e.plan.size, e.plan.geography].filter(Boolean).join(', ');
    if (box) parts.push(`- Their Deal Plan buy box: ${box}. Refer to it if it helps; never read out their numbers unless they bring them up.`);
  }
  return parts.join('\n');
}

// ───────────── the summary email after the session ─────────────

/**
 * Once per room, after it ends: each attendee with an email address (not unsubscribed, not suppressed) gets
 * their points, unlocks, Deal Plan, application status and, if they didn't buy, the offer with its real close
 * time. Each send is claimed in `emails` (lead, room sequence), so a re-run never sends twice.
 */
export async function sendRoomSummaries(rt: Runtime, roomId: string, now = Date.now()) {
  const db = rt.env.DB;
  const room = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first<RoomRow>();
  if (!room || room.mode !== 'webinar') return { sent: 0, skipped: 0 };
  const cfg = engageConfig(rt);
  const { sendOnce } = await import('../live/mail');
  const { isSuppressed } = await import('../integrations/bounces');
  const { safeFirstName } = await import('../lib/text');
  const { roomOffer } = await import('./rooms');
  const { activePass } = await import('../webinar/pass');
  const { paidDeposit, depositConfig } = await import('../sales/deposit');
  const { formatCallTime } = await import('../integrations/email');
  const offer = await roomOffer(rt, room, now).catch(() => null);
  const people = await db.prepare("SELECT who, lead_id, reg_id FROM room_attendance WHERE room_id = ? AND lead_id IS NOT NULL AND role IN ('attendee', 'guest')").bind(roomId).all<{ who: string; lead_id: string; reg_id: string | null }>();
  let sent = 0, skipped = 0;
  for (const p of people.results) {
    const lead = await getLead(rt.env, p.lead_id);
    if (!lead?.email || lead.unsubscribed_at || (await isSuppressed(rt, lead.email))) { skipped++; continue; }
    const [pts, unl, plan] = await Promise.all([roomPoints(rt, roomId, p.who), db.prepare('SELECT asset FROM room_unlocks WHERE room_id = ? AND who = ?').bind(roomId, p.who).all<{ asset: string }>(), getPlan(rt, roomId, p.who)]);
    const unlocks = [];
    for (const u of unl.results) { const a = assetById(u.asset); if (a) unlocks.push({ title: a.title, url: await assetUrl(rt, roomId, p.who, a.id) }); }
    const bought = Boolean((await activePass(rt, lead.id)) || (await paidDeposit(rt, lead.id)));
    let url: string | null = null;
    if (room.ref_type === 'live' && p.reg_id) { const r = await db.prepare('SELECT token FROM live_webinar_regs WHERE id = ?').bind(p.reg_id).first<{ token: string }>(); if (r) url = `${rt.origin}/live/room/${r.token}`; }
    if (room.ref_type === 'challenge' && p.reg_id) { const r = await db.prepare('SELECT token FROM challenge_registrations WHERE id = ?').bind(p.reg_id).first<{ token: string }>(); if (r) url = `${rt.origin}/challenge/day/${r.token}/${dayOf(room)}`; }
    const applied = Boolean(await db.prepare("SELECT 1 AS x FROM room_push_events WHERE room_id = ? AND who = ? AND event = 'submitted'").bind(roomId, p.who).first());
    const hasPlan = plan && PLAN_KEYS.some((k) => plan.data[k]);
    const mail = summaryEmail({
      name: safeFirstName(lead.first_name) ?? 'there', title: room.title, points: pts, unlocks,
      plan: hasPlan ? plan!.data : null, planUrl: hasPlan ? await planUrl(rt, roomId, p.who) : null,
      bought, applied,
      offer: offer?.open && offer.closesAt && url ? { label: `${depositConfig(rt).label} engagement deposit`, closesAt: formatCallTime(offer.closesAt, lead.timezone ?? ((rt.settings as S).SALES_TIMEZONE || 'Australia/Sydney')), url } : null,
    });
    const ok = await sendOnce(rt, lead, `room_summary:${roomId}`.slice(0, 60), 0, 'room_summary', mail, { unsubscribe: true }).catch(() => false);
    if (ok) sent++; else skipped++;
  }
  void cfg;
  return { sent, skipped };
}

/** Cron: summaries for webinar rooms that ended between 10 minutes and 3 days ago and haven't had them yet. */
export async function processRoomSummaries(rt: Runtime, now = Date.now()) {
  const { results } = await rt.env.DB.prepare("SELECT id FROM rooms WHERE mode = 'webinar' AND status = 'ended' AND summary_at IS NULL AND ended_at < ? AND ended_at > ? LIMIT 5")
    .bind(now - 10 * 60_000, now - 3 * 86_400_000).all<{ id: string }>();
  let sent = 0;
  for (const r of results) {
    const claim = await rt.env.DB.prepare('UPDATE rooms SET summary_at = ? WHERE id = ? AND summary_at IS NULL').bind(now, r.id).run();
    if (!(claim.meta.changes ?? 0)) continue;
    sent += (await sendRoomSummaries(rt, r.id, now)).sent;
  }
  return { rooms: results.length, sent };
}

/** The retention curve: attendees connected at this minute since Go live. */
export async function recordMinute(rt: Pick<Runtime, 'env'>, roomId: string, minute: number, n: number) {
  if (minute < 0 || minute > 600) return;
  await rt.env.DB.prepare('INSERT INTO room_minutes (room_id, minute, n) VALUES (?, ?, ?) ON CONFLICT(room_id, minute) DO UPDATE SET n = MAX(room_minutes.n, excluded.n)').bind(roomId, minute, n).run();
}

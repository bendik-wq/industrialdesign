import type { Runtime } from '../app';
import { proposeAction, registerActionHandler } from '../ops/actions';
import { assetById } from './engage';
import {
  type Bonus, type BonusUntil, type BuyKind, type ScoredPerson, type Signals, type Weights, E2_COPY, HOT_MIN, bonusDue, boughtWhileLive, buyingOf,
  emptySignals, leadLine, parseWeights, rankOf, scoreOf, whyOf,
} from './engage2';
import type { RoomRow } from './rooms';

/**
 * Engagement round 2 in the database (migration 0069). The room's Durable Object (engage2-do.ts) reads the
 * signals here once a minute while live, adds what only it sees (reactions, the tab beacons, offer opens, price
 * questions), scores everyone and writes the scores per room member and on the lead. The live-only bonus lives
 * here too, so its withdrawal and the grants survive the room's object sleeping. Every number is a row someone's
 * action wrote.
 */

type Rt = Pick<Runtime, 'env' | 'settings'>;
type S = Partial<Record<string, string>>;

export function engage2Config(rt: Pick<Runtime, 'settings'>) {
  const s = rt.settings as S;
  const min = Number(String(s.ROOM_HOT_MIN ?? '').trim());
  const n = Number(String(s.ROOM_HOT_FOLLOWUP_N ?? '').trim());
  return {
    weights: parseWeights(s.ROOM_SCORE_WEIGHTS),
    hotMin: Number.isFinite(min) && min > 0 && min <= 100 ? min : HOT_MIN,
    // After the session: a Command proposal (approval required; approving adds notes for the team, nothing is sent).
    followup: !/^(off|no|false|0)$/i.test(String(s.ROOM_HOT_FOLLOWUP ?? '').trim()),
    followupN: Number.isInteger(n) && n > 0 && n <= 50 ? n : 12,
  };
}

/** What only the room's object sees, per member. */
export interface LiveBits {
  reactions: Record<string, number>;
  focus: Record<string, { f: number; a: number }>;
  opens: Record<string, number>;
  price: Record<string, 1>;
}
export const emptyBits = (): LiveBits => ({ reactions: {}, focus: {}, opens: {}, price: {} });

export interface RoomPerson extends ScoredPerson { signals: Signals }

/** Everyone in the audience with their signals and score (database rows plus the object's own counts). */
export async function roomScores(rt: Rt, roomId: string, bits: LiveBits, o: { weights?: Weights; online?: Set<string>; consent?: Set<string>; names?: Record<string, string> } = {}): Promise<RoomPerson[]> {
  const db = rt.env.DB;
  const w = o.weights ?? engage2Config(rt).weights;
  const [att, pts, evs, cks, buyers] = await Promise.all([
    db.prepare("SELECT who, lead_id, name, minutes FROM room_attendance WHERE room_id = ? AND role IN ('attendee', 'guest') LIMIT 3000").bind(roomId).all<{ who: string; lead_id: string | null; name: string | null; minutes: number }>(),
    db.prepare('SELECT who, action, COUNT(*) AS n FROM room_points WHERE room_id = ? GROUP BY who, action').bind(roomId).all<{ who: string; action: string; n: number }>(),
    db.prepare("SELECT who, event, COUNT(DISTINCT push_id) AS n FROM room_push_events WHERE room_id = ? AND event IN ('opened', 'submitted', 'paid') GROUP BY who, event").bind(roomId).all<{ who: string; event: string; n: number }>(),
    db.prepare('SELECT who, kind FROM room_checkouts WHERE room_id = ?').bind(roomId).all<{ who: string; kind: string }>(),
    db.prepare(`SELECT DISTINCT a.who FROM room_attendance a JOIN webinar_passes p ON p.lead_id = a.lead_id
                 WHERE a.room_id = ? AND a.lead_id IS NOT NULL AND p.status = 'paid' AND p.kind IN ('offer', 'deposit')`).bind(roomId).all<{ who: string }>(),
  ]);
  const sig = new Map<string, Signals>();
  const get = (who: string) => { let s = sig.get(who); if (!s) { s = emptySignals(); sig.set(who, s); } return s; };
  for (const a of att.results) get(a.who).minutes = a.minutes ?? 0;
  for (const p of pts.results) {
    const s = get(p.who);
    if (p.action === 'on_time') s.onTime = p.n > 0;
    else if (p.action === 'poll') s.polls = p.n;
    else if (p.action === 'quiz') s.quizzes = p.n;
    else if (p.action === 'question') s.questions = p.n;
    else if (p.action === 'plan_step') s.planSteps = Math.min(4, p.n);
    else if (p.action === 'application') s.applied = true;
  }
  for (const e of evs.results) {
    const s = get(e.who);
    if (e.event === 'opened') s.opened = e.n;
    if (e.event === 'submitted') s.applied = true;
    if (e.event === 'paid') s.bought = true;
  }
  for (const c of cks.results) { const s = get(c.who); if ((c.kind === 'deposit' || c.kind === 'sprint') && !s.checkout.includes(c.kind)) s.checkout.push(c.kind); }
  for (const b of buyers.results) get(b.who).bought = true;
  for (const [who, n] of Object.entries(bits.reactions)) if (sig.has(who)) get(who).reactions = n;
  for (const [who, f] of Object.entries(bits.focus)) if (sig.has(who)) { get(who).focusMs = f.f; get(who).awayMs = f.a; }
  for (const [who, n] of Object.entries(bits.opens)) if (sig.has(who)) get(who).offerOpens = n;
  for (const who of Object.keys(bits.price)) if (sig.has(who)) get(who).price = true;

  const byWho = new Map(att.results.map((a) => [a.who, a]));
  return [...sig.entries()].filter(([who]) => byWho.has(who)).map(([who, s]) => {
    const a = byWho.get(who)!;
    const name = o.names?.[who] || a.name || '';
    return {
      who, name, leadId: a.lead_id, score: scoreOf(s, w).score, buying: buyingOf(s), why: whyOf(s), bought: s.bought,
      online: o.online ? o.online.has(who) : false, applied: s.applied, consent: o.consent ? o.consent.has(who) : false, signals: s,
    };
  });
}

/** Writes the scores that changed (per room member, and the latest and best on each lead). */
export async function saveScores(rt: Rt, roomId: string, people: RoomPerson[], now = Date.now()) {
  if (!people.length) return 0;
  const db = rt.env.DB;
  const stmts = [];
  for (const p of people) {
    const why = JSON.stringify(p.why), buying = JSON.stringify(p.buying);
    stmts.push(db.prepare(
      `INSERT INTO room_engage_scores (room_id, who, lead_id, name, score, signals, why, buying, bought, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id, who) DO UPDATE SET lead_id = excluded.lead_id, name = excluded.name, score = excluded.score, signals = excluded.signals,
         why = excluded.why, buying = excluded.buying, bought = excluded.bought, updated_at = excluded.updated_at`,
    ).bind(roomId, p.who, p.leadId, p.name.slice(0, 80), p.score, JSON.stringify(p.signals), why, buying, p.bought ? 1 : 0, now));
    if (p.leadId) stmts.push(db.prepare(
      `INSERT INTO lead_engage_scores (lead_id, room_id, score, best_score, why, buying, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lead_id) DO UPDATE SET room_id = excluded.room_id, score = excluded.score, best_score = MAX(lead_engage_scores.best_score, excluded.score),
         why = excluded.why, buying = excluded.buying, updated_at = excluded.updated_at`,
    ).bind(p.leadId, roomId, p.score, p.score, why, buying, now));
  }
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  return people.length;
}

/** The lead's latest room score (the lead drawer and the webinar AI calls). */
export async function leadScore(rt: Pick<Runtime, 'env'>, leadId: string) {
  const r = await rt.env.DB.prepare('SELECT room_id, score, best_score, why, buying, updated_at FROM lead_engage_scores WHERE lead_id = ?').bind(leadId).first<{ room_id: string; score: number; best_score: number; why: string; buying: string; updated_at: number }>();
  if (!r) return null;
  const arr = (v: string) => { try { const x = JSON.parse(v); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };
  return { roomId: r.room_id, score: r.score, best: r.best_score, why: arr(r.why), buying: arr(r.buying) as BuyKind[], at: r.updated_at };
}

// ───────────── the live-only bonus ─────────────

interface BonusRow { room_id: string; text: string; asset: string | null; until: string; on_at: number; withdrawn_at: number | null; withdrawn_reason: string | null }
const toBonus = (r: BonusRow): Bonus => ({ text: r.text, asset: r.asset, until: r.until === 'end' ? 'end' : 'offer', onAt: r.on_at, withdrawnAt: r.withdrawn_at, withdrawnReason: r.withdrawn_reason });

export async function getBonus(rt: Pick<Runtime, 'env'>, roomId: string) {
  const r = await rt.env.DB.prepare('SELECT * FROM room_live_bonus WHERE room_id = ?').bind(roomId).first<BonusRow>();
  return r ? toBonus(r) : null;
}
/** Sets the bonus. Refused once withdrawn (it stays off for the room) and, once the room is live, for an announced bonus. */
export async function setBonus(rt: Pick<Runtime, 'env'>, roomId: string, b: { text: string; asset: string | null; until: BonusUntil }, o: { by: string; live: boolean }, now = Date.now()): Promise<{ ok: true; bonus: Bonus } | { ok: false; error: string }> {
  const cur = await getBonus(rt, roomId);
  if (cur?.withdrawnAt != null) return { ok: false, error: 'bonus_withdrawn' };
  if (cur && o.live) return { ok: false, error: 'bonus_live' };
  await rt.env.DB.prepare(
    `INSERT INTO room_live_bonus (room_id, text, asset, until, on_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(room_id) DO UPDATE SET text = excluded.text, asset = excluded.asset, until = excluded.until, updated_by = excluded.updated_by, updated_at = excluded.updated_at
     WHERE room_live_bonus.withdrawn_at IS NULL`,
  ).bind(roomId, b.text, b.asset, b.until, now, o.by, now).run();
  return { ok: true, bonus: (await getBonus(rt, roomId))! };
}
/** Withdraws it once (the first reason and time stay). Returns whether this call withdrew it. */
export async function withdrawBonus(rt: Pick<Runtime, 'env'>, roomId: string, reason: 'offer_closed' | 'ended' | 'host', at: number) {
  const r = await rt.env.DB.prepare('UPDATE room_live_bonus SET withdrawn_at = ?, withdrawn_reason = ?, updated_at = ? WHERE room_id = ? AND withdrawn_at IS NULL').bind(at, reason, Date.now(), roomId).run();
  return (r.meta.changes ?? 0) > 0;
}
/**
 * Brings the stored bonus up to date from the room's real state (for a purchase that arrives while nobody is in
 * the room). The withdrawal time is the real moment: the offer's close time, or the session's end.
 */
export async function settleBonus(rt: Runtime, room: RoomRow, now = Date.now()) {
  const b = await getBonus(rt, room.id);
  if (!b || b.withdrawnAt != null) return b;
  const { roomOffer } = await import('./rooms');
  const offer = await roomOffer(rt, room, now).catch(() => ({ available: false, open: false, closesAt: null, label: null }));
  const due = bonusDue(b, { status: room.status, endedAt: room.ended_at }, offer, now);
  if (!due.withdraw || !due.reason) return b;
  const at = due.reason === 'ended' ? room.ended_at ?? now : offer.closesAt ?? now;
  await withdrawBonus(rt, room.id, due.reason, Math.min(at, now));
  return getBonus(rt, room.id);
}

/**
 * A paid Sprint or deposit (from onRoomPurchase): when the buyer was in a room whose live-only bonus was live at
 * the moment they paid, the bonus is recorded on the purchase (room_bonus_grants, once) and its file, if any,
 * is unlocked for them in that room.
 */
export async function grantLiveBonus(rt: Runtime, pass: { id: string; kind: string; lead_id: string; paid_at?: number | null; source?: string | null; ref_id?: string | null }, now = Date.now()) {
  if (pass.kind !== 'offer' && pass.kind !== 'deposit') return [];
  const db = rt.env.DB;
  const paidAt = pass.paid_at ?? now;
  const rooms = pass.source === 'room' && pass.ref_id
    ? [pass.ref_id]
    : (await db.prepare(`SELECT DISTINCT b.room_id FROM room_live_bonus b JOIN room_attendance a ON a.room_id = b.room_id
                          WHERE a.lead_id = ? AND b.on_at <= ? ORDER BY b.on_at DESC LIMIT 3`).bind(pass.lead_id, paidAt).all<{ room_id: string }>()).results.map((r) => r.room_id);
  const granted: string[] = [];
  for (const roomId of rooms) {
    const room = await db.prepare('SELECT * FROM rooms WHERE id = ?').bind(roomId).first<RoomRow>();
    if (!room) continue;
    const att = await db.prepare('SELECT who, reg_id FROM room_attendance WHERE room_id = ? AND lead_id = ? ORDER BY last_at DESC LIMIT 1').bind(roomId, pass.lead_id).first<{ who: string; reg_id: string | null }>();
    if (!att) continue;
    const b = await settleBonus(rt, room, now);
    if (!b || !boughtWhileLive(b, paidAt)) continue;
    const ins = await db.prepare('INSERT OR IGNORE INTO room_bonus_grants (room_id, pass_id, lead_id, kind, text, asset, paid_at, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(roomId, pass.id, pass.lead_id, pass.kind, b.text, b.asset, paidAt, now).run();
    if (!(ins.meta.changes ?? 0)) continue;
    granted.push(roomId);
    if (b.asset && assetById(b.asset)) {
      const { grantUnlocks } = await import('./engage-db');
      await grantUnlocks(rt, room, { id: att.who, leadId: pass.lead_id, regId: att.reg_id }, [b.asset], 'bonus' as 'push', now).catch(() => []);
    }
  }
  return granted;
}
export async function bonusGrants(rt: Pick<Runtime, 'env'>, roomId: string) {
  const r = await rt.env.DB.prepare('SELECT lead_id FROM room_bonus_grants WHERE room_id = ?').bind(roomId).all<{ lead_id: string }>();
  return r.results.map((x) => x.lead_id);
}

// ───────────── after the session: the follow-up proposal (approval required, nothing is sent) ─────────────

export const HOT_FOLLOWUP_KIND = 'sales.room_hot_followup';
interface HotLead { lead_id: string; name: string; score: number; why: string[]; buying: string[] }

/**
 * Once per room (called by the summary cron after the room ended): the N hottest attendees who didn't buy, as
 * one Command proposal. Approving adds a note to each lead for the team's personal follow-up; nothing is sent to
 * anyone, by this or by approving it. ROOM_HOT_FOLLOWUP=off turns the proposal off.
 */
export async function proposeHotFollowup(rt: Runtime, roomId: string, now = Date.now()) {
  const cfg = engage2Config(rt);
  if (!cfg.followup) return null;
  const db = rt.env.DB;
  const room = await db.prepare('SELECT id, title, mode FROM rooms WHERE id = ?').bind(roomId).first<{ id: string; title: string; mode: string }>();
  if (!room || room.mode !== 'webinar') return null;
  const dup = await db.prepare('SELECT 1 AS x FROM ops_actions WHERE kind = ? AND source = ? LIMIT 1').bind(HOT_FOLLOWUP_KIND, `room:${roomId}`).first();
  if (dup) return null;
  const rows = await db.prepare(`SELECT s.lead_id, s.name, s.score, s.why, s.buying, l.first_name, l.last_name FROM room_engage_scores s JOIN leads l ON l.id = s.lead_id
                                  WHERE s.room_id = ? AND s.bought = 0 AND s.lead_id IS NOT NULL
                                    AND NOT EXISTS (SELECT 1 FROM webinar_passes p WHERE p.lead_id = s.lead_id AND p.status = 'paid' AND p.kind IN ('offer', 'deposit'))
                                  LIMIT 3000`).bind(roomId)
    .all<{ lead_id: string; name: string | null; score: number; why: string; buying: string; first_name: string | null; last_name: string | null }>();
  const parse = (v: string) => { try { const x = JSON.parse(v); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };
  const seen = new Set<string>();
  const leads: HotLead[] = rows.results.map((r) => ({ lead_id: r.lead_id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.name || r.lead_id, score: r.score, why: parse(r.why), buying: parse(r.buying) }))
    .filter((l) => l.score >= cfg.hotMin || l.buying.length)
    .sort((a, b) => rankOf({ score: b.score, buying: b.buying as BuyKind[] }) - rankOf({ score: a.score, buying: a.buying as BuyKind[] }))
    .filter((l) => (seen.has(l.lead_id) ? false : (seen.add(l.lead_id), true)))
    .slice(0, cfg.followupN);
  if (!leads.length) return null;
  const detail = [
    `The ${leads.length} attendee${leads.length === 1 ? '' : 's'} of "${room.title}" with the highest engagement score and buying signals who haven't bought.`,
    'Approving adds a note to each lead for a personal follow-up by the team. Nothing is sent to anyone by this proposal or by approving it.',
    '',
    ...leads.map((l, i) => `${i + 1}. ${l.name}: ${l.score} of 100${l.buying.length ? `; ${l.buying.map((k) => E2_COPY.buying[k as BuyKind] ?? k).join(', ')}` : ''}${l.why.length ? `; ${l.why.join('; ')}` : ''}`),
    '',
    'Source: the room\'s engagement scores (room_engage_scores), from points, pushes, checkouts and the room\'s own counts.',
  ].join('\n');
  const id = await proposeAction(rt, {
    dept: 'sales', kind: HOT_FOLLOWUP_KIND, risk: 'low', source: `room:${roomId}`,
    summary: `Follow up with the ${leads.length} hottest attendee${leads.length === 1 ? '' : 's'} who didn't buy: ${room.title}`.slice(0, 280),
    detail, payload: { room_id: roomId, title: room.title, leads },
  }, now);
  return { actionId: id, leads };
}

registerActionHandler(HOT_FOLLOWUP_KIND, async (rt, raw) => {
  const p = (raw ?? {}) as { room_id?: unknown; title?: unknown; leads?: unknown };
  const list = (Array.isArray(p.leads) ? p.leads : []).slice(0, 50) as Partial<HotLead>[];
  let noted = 0, skipped = 0;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  for (const l of list) {
    const id = String(l.lead_id ?? '');
    const lead = await rt.env.DB.prepare('SELECT id, notes FROM leads WHERE id = ?').bind(id).first<{ id: string; notes: string | null }>();
    if (!lead) { skipped++; continue; }
    const paid = await rt.env.DB.prepare("SELECT 1 AS x FROM webinar_passes WHERE lead_id = ? AND status = 'paid' AND kind IN ('offer', 'deposit') LIMIT 1").bind(id).first();
    if (paid) { skipped++; continue; }
    const why = Array.isArray(l.why) ? l.why.map(String).slice(0, 4) : [];
    const line = `[${stamp} UTC, Hot list] Follow up personally after "${String(p.title ?? 'the live room').slice(0, 120)}". ${leadLine(Number(l.score) || 0, why)}`.replace(/[<>]/g, '');
    await rt.env.DB.prepare('UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?').bind([lead.notes, line].filter(Boolean).join('\n'), Date.now(), id).run();
    noted++;
  }
  return { ok: true, summary: `Notes added to ${noted} lead${noted === 1 ? '' : 's'} for personal follow-up${skipped ? `; ${skipped} skipped (bought since, or not found)` : ''}. Nothing was sent.` };
}, { label: 'Hot list follow-up notes after a live room' });

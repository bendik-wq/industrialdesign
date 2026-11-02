import type { Runtime } from '../app';
import { getLead, parseAnswers } from '../funnel/leads';
import type { RoomRow } from './rooms';
import { getPlan } from './engage-db';
import { type CheckoutRow, type Consent, type ProofKind, type RxCounts, audienceConfig, personalLines, proofPreview, proofText } from './audience';

/**
 * The audience experience in the database (migration 0058): the per-room switches, the consent behind every
 * purchase announcement, the announcements themselves (once per buyer and kind), checkouts started in the room
 * and their one nudge, the reaction pulse, and what the personal offer card echoes back.
 */

type Rt = Pick<Runtime, 'env' | 'settings' | 'origin'>;
type S = Partial<Record<string, string>>;
export const cfgOf = (rt: Pick<Runtime, 'settings'>) => audienceConfig(rt.settings as S);

// ───────────── the room's switches ─────────────

export async function proofOn(rt: Rt, roomId: string) {
  const r = await rt.env.DB.prepare('SELECT proof_on FROM room_audience WHERE room_id = ?').bind(roomId).first<{ proof_on: number | null }>().catch(() => null);
  return r && r.proof_on != null ? r.proof_on === 1 : cfgOf(rt).proofDefault;
}
export async function setProofOn(rt: Rt, roomId: string, on: boolean, now = Date.now()) {
  await rt.env.DB.prepare('INSERT INTO room_audience (room_id, proof_on, updated_at) VALUES (?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET proof_on = excluded.proof_on, updated_at = excluded.updated_at').bind(roomId, on ? 1 : 0, now).run();
}

// ───────────── consent ─────────────

export interface Who { id: string; name?: string; leadId?: string | null; regId?: string | null }
async function nameAndCity(rt: Rt, who: Who) {
  const lead = who.leadId ? await getLead(rt.env, who.leadId) : null;
  return { first: (lead?.first_name || who.name || '').trim() || null, city: ((lead as unknown as { city?: string | null })?.city ?? null) || null };
}
export async function getConsent(rt: Rt, roomId: string, whoId: string) {
  return rt.env.DB.prepare('SELECT * FROM room_proof_consent WHERE room_id = ? AND who = ?').bind(roomId, whoId).first<Consent & { lead_id: string | null }>();
}
/** Ticking (or unticking) the box on a payment or application card. Only the attendee themselves, only with a lead. */
export async function saveConsent(rt: Rt, roomId: string, who: Who, o: { on: boolean; showCity: boolean }, now = Date.now()) {
  if (!who.leadId) return null;
  const nc = await nameAndCity(rt, who);
  if (o.on) {
    await rt.env.DB.prepare(
      `INSERT INTO room_proof_consent (room_id, who, lead_id, first_name, city, show_city, consent_at, withdrawn_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(room_id, who) DO UPDATE SET first_name = excluded.first_name, city = excluded.city, show_city = excluded.show_city, consent_at = excluded.consent_at, withdrawn_at = NULL, lead_id = excluded.lead_id`,
    ).bind(roomId, who.id, who.leadId, nc.first, nc.city, o.showCity ? 1 : 0, now).run();
  } else {
    await rt.env.DB.prepare('UPDATE room_proof_consent SET withdrawn_at = ? WHERE room_id = ? AND who = ?').bind(now, roomId, who.id).run();
  }
  return getConsent(rt, roomId, who.id);
}

// ───────────── announcements ─────────────

/**
 * A real event (a paid pass, a sent application) becomes an announcement only when: the buyer ticked the box
 * in this room (and didn't untick it), the host has announcements on for the room, the room is live, and this
 * buyer hasn't been announced for this kind already. Returns the room and the sentence, or null.
 */
export async function proofFor(rt: Rt, x: { leadId: string; kind: ProofKind; roomId?: string | null; ref?: string | null }, now = Date.now()) {
  const db = rt.env.DB;
  const c = await db.prepare(
    `SELECT c.*, r.status AS room_status FROM room_proof_consent c JOIN rooms r ON r.id = c.room_id
      WHERE c.lead_id = ? AND c.withdrawn_at IS NULL AND c.consent_at > ? ${x.roomId ? 'AND c.room_id = ?' : ''} ORDER BY c.consent_at DESC LIMIT 1`,
  ).bind(...[x.leadId, now - 2 * 86_400_000, ...(x.roomId ? [x.roomId] : [])]).first<Consent & { room_id: string; room_status: string }>();
  if (!c || c.room_status !== 'live') return null;
  if (!(await proofOn(rt, c.room_id))) return null;
  const text = proofText(x.kind, c);
  if (!text) return null;
  const ins = await db.prepare('INSERT INTO room_proof_events (room_id, lead_id, kind, text, ref, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(c.room_id, x.leadId, x.kind, text, x.ref ?? null, now).run();
  if (!(ins.meta?.changes ?? 0)) return null;
  return { roomId: c.room_id, text };
}

/** Tells the room's Durable Object to announce (it rate-limits). */
export async function tellRoomProof(rt: Runtime, roomId: string, text: string) {
  const ns = rt.env.ROOMS;
  if (!ns) return false;
  const { getRoom } = await import('./rooms');
  const { roomMeta } = await import('./routes');
  const room = await getRoom(rt, roomId);
  if (!room) return false;
  const res = await ns.get(ns.idFromName(roomId)).fetch(new Request('https://room/audience/proof', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-room-who': JSON.stringify({ id: 'server', name: 'Server', role: 'host' }), 'x-room-meta': JSON.stringify(roomMeta(rt, room)) },
    body: JSON.stringify({ text }),
  })).catch(() => null);
  return Boolean(res?.ok);
}

/** From passPaidEffects (via onRoomPurchase): a paid Sprint or deposit. */
export async function announcePurchase(rt: Runtime, pass: { id: string; kind: string; lead_id: string; source?: string | null; ref_id?: string | null }, now = Date.now()) {
  const kind: ProofKind | null = pass.kind === 'offer' ? 'sprint' : pass.kind === 'deposit' ? 'deposit' : null;
  if (!kind) return null;
  const p = await proofFor(rt, { leadId: pass.lead_id, kind, roomId: pass.source === 'room' ? pass.ref_id ?? null : null, ref: pass.id }, now);
  if (p) await tellRoomProof(rt, p.roomId, p.text);
  return p;
}
/** From the room's application (submitRoomApplication). */
export async function announceApplication(rt: Runtime, roomId: string, leadId: string, now = Date.now()) {
  const p = await proofFor(rt, { leadId, kind: 'application', roomId }, now);
  if (p) await tellRoomProof(rt, p.roomId, p.text);
  return p;
}

// ───────────── checkouts and the one nudge ─────────────

export async function checkoutStarted(rt: Rt, roomId: string, who: Who, kind: 'deposit' | 'sprint', now = Date.now()) {
  // The first start counts: clicking again doesn't push the nudge back, and a nudged checkout stays nudged.
  await rt.env.DB.prepare('INSERT INTO room_checkouts (room_id, who, kind, lead_id, started_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(roomId, who.id, kind, who.leadId ?? null, now).run();
}
export async function openCheckouts(rt: Rt, roomId: string) {
  const r = await rt.env.DB.prepare('SELECT who, kind, lead_id, started_at, nudged_at FROM room_checkouts WHERE room_id = ? AND nudged_at IS NULL').bind(roomId).all<CheckoutRow>();
  return r.results;
}
/** Whether this checkout really was paid (a paid pass of that kind for the lead since it started). */
export async function checkoutPaid(rt: Rt, row: CheckoutRow) {
  if (!row.lead_id) return false;
  const kind = row.kind === 'sprint' ? 'offer' : 'deposit';
  const r = await rt.env.DB.prepare("SELECT 1 AS x FROM webinar_passes WHERE lead_id = ? AND kind = ? AND status = 'paid' AND COALESCE(paid_at, updated_at) >= ? LIMIT 1").bind(row.lead_id, kind, row.started_at - 60_000).first().catch(() => null);
  return Boolean(r);
}
export async function markNudged(rt: Rt, roomId: string, row: CheckoutRow, now = Date.now()) {
  const r = await rt.env.DB.prepare('UPDATE room_checkouts SET nudged_at = ? WHERE room_id = ? AND who = ? AND kind = ? AND nudged_at IS NULL').bind(now, roomId, row.who, row.kind).run();
  return (r.meta?.changes ?? 0) > 0;
}

// ───────────── the reaction pulse ─────────────

export async function savePulse(rt: Rt, roomId: string, rows: { minute: number; n: number; k: RxCounts }[]) {
  for (const r of rows) {
    await rt.env.DB.prepare('INSERT INTO room_reaction_pulse (room_id, minute, n, kinds) VALUES (?, ?, ?, ?) ON CONFLICT(room_id, minute) DO UPDATE SET n = excluded.n, kinds = excluded.kinds').bind(roomId, r.minute, r.n, JSON.stringify(r.k)).run().catch(() => null);
  }
}

// ───────────── what the personal offer card echoes ─────────────

/** The attendee's own answers for the offer card, their consent, and the preview of what an announcement would say. */
export async function personalFor(rt: Rt, room: Pick<RoomRow, 'id'>, who: Who) {
  const plan = await getPlan(rt, room.id, who.id).catch(() => null);
  let app: { business: string | null; revenueLabel: string | null; whyNow: string | null; submitted: boolean } | null = null;
  const lead = who.leadId ? await getLead(rt.env, who.leadId) : null;
  if (lead) {
    const a = parseAnswers(lead) as Record<string, unknown>;
    let revenueLabel: string | null = null;
    if (typeof a.revenue === 'string') {
      const { roomQuestions } = await import('./engage-db');
      const q = (await roomQuestions()).find((x) => x.id === 'revenue') as { options?: { value: string; label: string }[] } | undefined;
      revenueLabel = q?.options?.find((o) => o.value === a.revenue)?.label ?? null;
    }
    app = {
      business: typeof a.business === 'string' ? a.business.slice(0, 120) : lead.industry ?? null,
      revenueLabel,
      whyNow: typeof a.why_now === 'string' && a.why_now.trim() ? a.why_now.trim().slice(0, 600) : null,
      submitted: Boolean(lead.app_completed_at),
    };
  }
  const consent = await getConsent(rt, room.id, who.id).catch(() => null);
  const nc = { first: lead?.first_name || who.name || null, city: (lead as unknown as { city?: string | null } | null)?.city ?? null };
  return {
    lines: personalLines({ plan: plan?.data ?? null, app }),
    consent: consent ? { on: !consent.withdrawn_at, showCity: consent.show_city === 1 } : { on: false, showCity: true },
    preview: { withCity: proofPreview(nc.first, nc.city, true), withoutCity: proofPreview(nc.first, null, false), hasCity: Boolean(nc.city) },
    lead: Boolean(who.leadId),
  };
}

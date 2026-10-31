import type { Context } from 'hono';
import type { AppEnv, Runtime } from '../app';
import type { VisitorCtx } from '../lib/identity';
import { flag } from '../settings';
import { identityFromLead, identityFromVisitor, track } from '../tracking/track';
import { type Funnel, XD_PARAM, captureConversion, linkCrossDomain, siblingHosts, xdToken } from './capture';
import { currentEdition, latestReg, recordStage } from './stages';

/**
 * The few calls the funnels make into attribution. Each is additive and never throws into the registration,
 * payment or page it rides on.
 */

const quiet = async <T>(label: string, p: () => Promise<T>) => { try { return await p(); } catch (e) { console.error(`attribution ${label}`, String(e).slice(0, 200)); return null; } };

// ───────────── Meta stage events (Conversions API) ─────────────

/** Extra Meta events this module sends: Lead per registration, a custom event for attended and for offer seen. */
export const STAGE_EVENTS = { lead: 'attr_lead', attended: 'attr_attended', offer_seen: 'attr_offer_seen' } as const;
export const stageEventsOn = (rt: Pick<Runtime, 'settings'>) => flag((rt.settings as Partial<Record<string, string>>).META_STAGE_EVENTS, true);

/**
 * Sends one stage event once per registration (attr_capi guards it). The event goes through track(), so it is
 * stored first-party and forwarded with the existing consent check, Meta settings and retry log; event_id is
 * deterministic (or the browser's own id) so the Pixel's copy de-duplicates.
 */
export async function sendStageEvent(rt: Runtime, o: { kind: keyof typeof STAGE_EVENTS; funnel: Funnel; regId: string; leadId: string; eventId?: string | null; visitor?: VisitorCtx | null; value?: number | null }) {
  if (!stageEventsOn(rt)) return false;
  const name = STAGE_EVENTS[o.kind];
  const key = `${name}:${o.regId}`;
  const eventId = o.eventId && /^[\w-]{8,60}$/.test(o.eventId) ? o.eventId : `${o.kind}-${o.regId}`.slice(0, 64);
  const ins = await rt.env.DB.prepare('INSERT OR IGNORE INTO attr_capi (key, name, lead_id, event_id, sent_at) VALUES (?, ?, ?, ?, ?)').bind(key, name, o.leadId, eventId, Date.now()).run();
  if ((ins.meta.changes ?? 0) === 0) return false;
  const who = o.visitor ? identityFromVisitor(o.visitor, null, o.leadId) : await identityFromLead(rt.env, o.leadId);
  await track(rt, who, { name, source: 'server', path: o.funnel === 'auto' ? '/webinar' : `/${o.funnel}`, props: { funnel: o.funnel, reg_id: o.regId, ...(o.value != null ? { value: o.value } : {}) }, eventId });
  return true;
}

// ───────────── registrations and purchases ─────────────

/** Called by the three registration functions once the registration row exists. */
export function onRegistered(rt: Runtime, v: VisitorCtx | null, o: { funnel: Funnel; regId: string; leadId: string; at: number; cohortRef: string; pixelEid?: unknown }) {
  return quiet('registration', async () => {
    const edition = o.funnel === 'auto' ? currentEdition(rt) : null;
    await captureConversion(rt, { kind: 'registered', funnel: o.funnel, refId: o.regId, regId: o.regId, leadId: o.leadId, at: o.at, cohortRef: o.cohortRef, edition, visitorId: v?.visitorId, fbc: v?.fbc, fbp: v?.fbp });
    await recordStage(rt, { funnel: o.funnel, stage: 'registered', leadId: o.leadId, regId: o.regId, ts: o.at, cohortRef: o.cohortRef, edition });
    await sendStageEvent(rt, { kind: 'lead', funnel: o.funnel, regId: o.regId, leadId: o.leadId, eventId: typeof o.pixelEid === 'string' ? o.pixelEid : null, visitor: v });
  });
}

interface PassLike { id: string; kind: string; reg_id: string; lead_id: string; amount: number; refunded_amount?: number | null; currency: string; paid_at?: number | null; source?: string | null; ref_id?: string | null }

/** A paid masterclass pass (ticket, Sprint), live ticket or engagement deposit → conversion + stage. */
export function onPassPaid(rt: Runtime, pass: PassLike, metadata?: Record<string, unknown> | null) {
  return quiet('pass paid', async () => {
    const at = pass.paid_at ?? Date.now();
    let funnel: Funnel = 'auto', regId: string | null = pass.reg_id, cohort: string | null = null;
    const kind = pass.kind === 'seat' || pass.kind === 'live_ticket' ? 'ticket_paid' : pass.kind === 'deposit' ? 'deposit_paid' : pass.kind === 'offer' ? 'sprint_paid' : null;
    if (!kind) return;
    const db = rt.env.DB;
    if (pass.kind === 'live_ticket' || (pass.kind === 'deposit' && pass.source === 'live')) {
      funnel = 'live';
      const r = await db.prepare('SELECT id, event_id FROM live_webinar_regs WHERE (id = ?1 OR (event_id = ?2 AND lead_id = ?3)) LIMIT 1').bind(pass.reg_id, pass.ref_id ?? '', pass.lead_id).first<{ id: string; event_id: string }>();
      regId = r?.id ?? null; cohort = r?.event_id ?? pass.ref_id ?? null;
    } else if (pass.kind === 'deposit' && pass.source === 'challenge') {
      funnel = 'challenge';
      const r = await db.prepare('SELECT id, cohort_id FROM challenge_registrations WHERE id = ?').bind(pass.ref_id ?? '').first<{ id: string; cohort_id: string }>();
      regId = r?.id ?? null; cohort = r?.cohort_id ?? null;
    } else if (pass.kind === 'deposit') {
      const r = await latestReg(rt, pass.lead_id, at);
      if (r) { funnel = r.funnel; regId = r.id; cohort = r.cohort; }
    } else {
      const r = await db.prepare('SELECT session_id FROM webinar_registrations WHERE id = ?').bind(pass.reg_id).first<{ session_id: string }>();
      cohort = r?.session_id ?? null;
    }
    await captureConversion(rt, { kind, funnel, refId: pass.id, regId, leadId: pass.lead_id, at, amount: pass.amount, refunded: pass.refunded_amount ?? 0, currency: pass.currency, cohortRef: cohort, metadata });
    if (regId) await recordStage(rt, { funnel, stage: kind, leadId: pass.lead_id, regId, ts: at, value: pass.amount, detail: pass.currency, cohortRef: cohort });
  });
}

/** A paid challenge order (ticket or VIP). */
export function onOrderPaid(rt: Runtime, o: { id: string; kind: string; reg_id: string; lead_id: string; amount: number; refunded_amount?: number | null; currency: string; paid_at?: number | null }, metadata?: Record<string, unknown> | null) {
  return quiet('order paid', async () => {
    const at = o.paid_at ?? Date.now();
    const kind = o.kind === 'vip' ? 'vip_paid' : 'ticket_paid';
    const r = await rt.env.DB.prepare('SELECT cohort_id FROM challenge_registrations WHERE id = ?').bind(o.reg_id).first<{ cohort_id: string }>();
    await captureConversion(rt, { kind, funnel: 'challenge', refId: o.id, regId: o.reg_id, leadId: o.lead_id, at, amount: o.amount, refunded: o.refunded_amount ?? 0, currency: o.currency, cohortRef: r?.cohort_id ?? null, metadata });
    await recordStage(rt, { funnel: 'challenge', stage: kind, leadId: o.lead_id, regId: o.reg_id, ts: at, value: o.amount, detail: o.currency, cohortRef: r?.cohort_id ?? null });
  });
}

/**
 * Whop's payment.succeeded webhook: the payment's metadata carries the buyer's browser id and touches
 * (checkoutAttribution). Re-captures the conversion with it, which fills in a payment we had no path for.
 */
export function onWhopPayment(rt: Runtime, pay: Record<string, unknown>) {
  return quiet('whop payment', async () => {
    const meta = (pay.metadata && typeof pay.metadata === 'object' ? pay.metadata : {}) as Record<string, unknown>;
    if (!meta.attr_vid && !meta.attr_lt && !meta.attr_ft) return;
    if (typeof meta.challenge_order_id === 'string') {
      const o = await rt.env.DB.prepare('SELECT * FROM challenge_orders WHERE id = ?').bind(meta.challenge_order_id).first<Parameters<typeof onOrderPaid>[1] & { status: string }>();
      if (o && o.paid_at) await onOrderPaid(rt, o, meta);
      return;
    }
    if (typeof meta.pass_id === 'string') {
      const p = await rt.env.DB.prepare('SELECT * FROM webinar_passes WHERE id = ?').bind(meta.pass_id).first<PassLike>();
      if (p && p.paid_at) await onPassPaid(rt, p, meta);
    }
  });
}

// ───────────── room signals (server side, from the rooms' own polls) ─────────────

/** First time a person is in the room / sees the offer: stage row + the Meta custom event (once). */
export function onRoomSignal(rt: Runtime, o: { kind: 'attended' | 'offer_seen'; funnel: Funnel; regId: string; leadId: string; at?: number; cohortRef?: string | null; detail?: string | null }) {
  return quiet('room signal', async () => {
    await recordStage(rt, { funnel: o.funnel, stage: o.kind, leadId: o.leadId, regId: o.regId, ts: o.at ?? Date.now(), cohortRef: o.cohortRef ?? null, detail: o.detail ?? null });
    // attr_capi keeps the Meta event to one per registration, whichever poll got here first.
    await sendStageEvent(rt, { kind: o.kind, funnel: o.funnel, regId: o.regId, leadId: o.leadId });
  });
}

// ───────────── pages: visits, cross-domain joins ─────────────

/** Which funnel's registration page this request is (for the "visit" stage), or null. */
export function funnelPage(path: string, webinarHost: boolean): Funnel | null {
  if (path === '/challenge') return 'challenge';
  if (path === '/live') return 'live';
  if (path === '/webinar' || (webinarHost && path === '/')) return 'auto';
  return null;
}

/** Runs on every rendered funnel page: records the funnel visit and joins the browser across our domains. */
export async function onFunnelPage(c: Context<AppEnv>, rt: Runtime, v: VisitorCtx, url: URL, webinarHost: boolean) {
  if (v.isBot) return;
  await quiet('page', async () => {
    const token = url.searchParams.get(XD_PARAM);
    if (token) {
      let fromHost: string | null = null;
      try { fromHost = new URL(c.req.header('referer') ?? '').host || null; } catch { /* none */ }
      await linkCrossDomain(rt.env, v.visitorId, token, { fromHost, toHost: url.host });
    }
    const f = funnelPage(url.pathname, webinarHost);
    if (f) {
      const now = Date.now();
      await rt.env.DB.prepare('INSERT OR IGNORE INTO attr_visits (funnel, visitor_id, day, ts, session_id) VALUES (?, ?, ?, ?, ?)')
        .bind(f, v.visitorId, new Date(now).toISOString().slice(0, 10), now, v.sessionId).run();
    }
  });
}

/** What the page's tracker needs to carry this browser to our other domain: the signed token and the hosts. */
export async function xdConfig(rt: Runtime, v: VisitorCtx, selfHost: string) {
  if (v.isBot) return null;
  const hosts = siblingHosts(rt.settings, selfHost);
  if (!hosts.length) return null;
  return { param: XD_PARAM, token: await xdToken(rt.env, v.visitorId), hosts };
}

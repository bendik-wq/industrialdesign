import type { Runtime } from '../app';
import { sha256 } from '../lib/crypto';
import { flag } from '../settings';
import { fromMinor } from '../webinar/pass';
import { identityFromLead, track } from './track';

/**
 * Deep-funnel conversion signals for Meta (Conversions API), for the live rooms, the automated webinar and the
 * challenge. Optimising ads on registrations finds people who register; optimising on what buyers do in the room
 * finds people who buy. Each signal is a custom event sent once per person per session:
 *
 *   watched_30m            watched 30+ minutes of one session (live room or Zoom minutes, auto-webinar minutes, a challenge day)
 *   stayed_for_pitch       present when the host opened the offer (live, challenge) or when the Sprint unlocked (auto webinar)
 *   offer_opened           opened an offer card (auto-webinar offer, live deposit button, a Sprint / deposit / VIP card in a room)
 *   checkout_started       started checkout for the deposit, the Sprint or the VIP upgrade (not tickets)
 *   application_submitted  sent the application inside a room
 *   contract_signed        signed the engagement: an offline conversion (action_source system_generated) whose value is
 *                          the contract fee, a real number, so it is always sent
 *
 * Everything goes through track(): the event is stored first-party, and forwarded with the existing consent check
 * (EU visitors without consent never reach Meta), test-event code, retry log and a deterministic event_id, so a
 * retry or a second cron run can't double count. meta_signals keeps the once-per-person-per-session rule.
 *
 * Values: the five room signals carry a value only when META_SIGNAL_VALUES is on (default off). The value is an
 * estimate of what the signal is worth (sent with predicted_value: true): the average paid revenue that followed
 * this signal in our own data once there is enough (50+ people, 3+ buyers), else the saved financial model's
 * webinar numbers, else nothing. It is labelled an estimate wherever it is shown.
 */

export type SignalId = 'watched_30m' | 'stayed_for_pitch' | 'offer_opened' | 'checkout_started' | 'application_submitted' | 'contract_signed';
type Funnel = 'auto' | 'live' | 'challenge';

export interface SignalDef { id: SignalId; event: string; meta: string; label: string; description: string }

/** The server event name (signal_*) and the Meta custom event name never change once conversions point at them. */
export const SIGNALS: SignalDef[] = [
  { id: 'watched_30m', event: 'signal_watched_30m', meta: 'Watched30Min', label: 'Watched 30+ minutes', description: 'Watched at least 30 minutes of one session (live room, Zoom, automated webinar or a challenge day).' },
  { id: 'stayed_for_pitch', event: 'signal_stayed_for_pitch', meta: 'StayedForPitch', label: 'Stayed for the pitch', description: 'Was in the session when the offer opened (live and challenge) or when the Sprint unlocked (automated webinar).' },
  { id: 'offer_opened', event: 'signal_offer_opened', meta: 'OfferCardOpened', label: 'Opened an offer card', description: 'Opened the Sprint, deposit or VIP offer in the session.' },
  { id: 'checkout_started', event: 'signal_checkout_started', meta: 'OfferCheckoutStarted', label: 'Started offer checkout', description: 'Started checkout for the engagement deposit, the First Deal Sprint or the VIP upgrade.' },
  { id: 'application_submitted', event: 'signal_application_submitted', meta: 'RoomApplicationSubmitted', label: 'Applied in the room', description: 'Sent the application inside a live room.' },
  { id: 'contract_signed', event: 'signal_contract_signed', meta: 'EngagementSigned', label: 'Signed the engagement', description: 'Signed the advisory engagement after a webinar, live webinar or challenge. Offline conversion; value is the contract fee.' },
];
export const SIGNAL_BY_EVENT = new Map(SIGNALS.map((s) => [s.event, s]));
export const SIGNAL_EVENT_NAMES = new Set(SIGNALS.map((s) => s.event));
/** Meta custom event for each signal event (merged into META_EVENTS). */
export const SIGNAL_META_EVENTS: Record<string, string> = Object.fromEntries(SIGNALS.map((s) => [s.event, s.meta]));

const DAY = 86_400_000;
/** Meta accepts events up to 7 days old; signals older than this are left alone. */
const WINDOW = 6 * DAY;
const WATCH_MINUTES = 30;

type S = Partial<Record<string, string>>;
const st = (rt: Pick<Runtime, 'settings'>) => rt.settings as S;
export const signalsOn = (rt: Pick<Runtime, 'settings'>) => flag(st(rt).META_SIGNALS, true);
export const signalValuesOn = (rt: Pick<Runtime, 'settings'>) => flag(st(rt).META_SIGNAL_VALUES, false);

// ───────────── what each signal is worth (estimate) ─────────────

/** The webinar part of the financial model (public/assets/finance-model.js DEFAULTS), used until our own data is enough. */
export const MODEL_WEBINAR = { applyAtt: 0.1, qualified: 0.35, book: 0.7, show: 0.75, close: 0.2, ladder: true, sprintPrice: 3000, sprintRate: 0.08, sprintToEng: 0.3, engFee: 50000 };
export const MODEL_SHARED = { fee: 22500, currency: 'USD' };
const MIN_PEOPLE = 50, MIN_BUYERS = 3;
/** How long after a signal a purchase still counts toward that signal's value. */
const OUTCOME_DAYS = 60;

export interface SignalValue { signal: SignalId; value: number | null; currency: string; basis: string; n: number; buyers: number }

const rate = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(1, n) : d; };
const amount = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

/** Model values per signal, from the saved model (or its defaults). Pure. Signals the model has no rate for get null. */
export function modelValues(data: unknown): { values: Partial<Record<SignalId, number>>; currency: string } {
  const d = (data && typeof data === 'object' ? data : {}) as { shared?: Record<string, unknown>; webinar?: Record<string, unknown> };
  const w = d.webinar ?? {}, s = d.shared ?? {};
  const m = {
    applyAtt: rate(w.applyAtt, MODEL_WEBINAR.applyAtt), qualified: rate(w.qualified, MODEL_WEBINAR.qualified), book: rate(w.book, MODEL_WEBINAR.book),
    show: rate(w.show, MODEL_WEBINAR.show), close: rate(w.close, MODEL_WEBINAR.close), sprintRate: rate(w.sprintRate, MODEL_WEBINAR.sprintRate),
    sprintToEng: rate(w.sprintToEng, MODEL_WEBINAR.sprintToEng), sprintPrice: amount(w.sprintPrice, MODEL_WEBINAR.sprintPrice), engFee: amount(w.engFee, MODEL_WEBINAR.engFee),
    // Scenarios saved before the ladder existed keep their free-webinar numbers (the model's own rule).
    ladder: w.ladder == null ? (Object.keys(w).length ? false : MODEL_WEBINAR.ladder) : Boolean(w.ladder),
    fee: amount(s.fee, MODEL_SHARED.fee),
  };
  const currency = typeof s.currency === 'string' && /^[A-Z]{3}$/.test(s.currency) ? s.currency : MODEL_SHARED.currency;
  const callPath = m.qualified * m.book * m.show * m.close * m.fee; // what one application is worth through a call
  // Revenue per attendee: the Sprint sold to watchers plus the engagement some Sprint buyers sign (Sprint fee credited),
  // or, without the ladder, applications from attendees through a call.
  const attendee = m.ladder ? m.sprintRate * (m.sprintPrice + m.sprintToEng * Math.max(0, m.engFee - m.sprintPrice)) : m.applyAtt * callPath;
  return { values: { watched_30m: Math.round(attendee), stayed_for_pitch: Math.round(attendee), application_submitted: Math.round(callPath) }, currency };
}

/**
 * Value per signal: our own outcomes when there are enough (average paid revenue, net of refunds, that followed the
 * signal within 60 days, over people whose signal is at least 30 days old), else the financial model, else none.
 */
export async function signalValues(rt: Pick<Runtime, 'env'>, now = Date.now()): Promise<SignalValue[]> {
  const db = rt.env.DB;
  const saved = await db.prepare('SELECT data FROM fin_models ORDER BY updated_at DESC LIMIT 1').first<{ data: string }>().catch(() => null);
  let parsed: unknown = null, modelBasis = 'financial model defaults';
  try { if (saved) { parsed = JSON.parse(saved.data); modelBasis = 'your saved financial model'; } } catch { /* defaults */ }
  const model = modelValues(parsed);
  const from = now - 365 * DAY, to = now - 30 * DAY;
  const people = await db.prepare('SELECT signal, COUNT(*) AS n FROM meta_signals WHERE sent_at BETWEEN ? AND ? GROUP BY signal').bind(from, to)
    .all<{ signal: string; n: number }>().then((r) => r.results).catch(() => [] as { signal: string; n: number }[]);
  const paid = await db.prepare(
    `SELECT s.signal, lower(COALESCE(c.currency, 'usd')) AS currency, COUNT(DISTINCT s.key) AS buyers, SUM(c.amount - c.refunded) AS net
       FROM meta_signals s JOIN attr_conversions c ON c.lead_id = s.lead_id AND c.kind IN ('sprint_paid', 'deposit_paid', 'vip_paid', 'engagement_signed')
        AND c.occurred_at BETWEEN s.sent_at - ? AND s.sent_at + ?
      WHERE s.sent_at BETWEEN ? AND ? GROUP BY s.signal, 2`,
  ).bind(DAY, OUTCOME_DAYS * DAY, from, to).all<{ signal: string; currency: string; buyers: number; net: number }>().then((r) => r.results).catch(() => [] as { signal: string; currency: string; buyers: number; net: number }[]);
  return SIGNALS.filter((s) => s.id !== 'contract_signed').map((s) => {
    const n = Number(people.find((p) => p.signal === s.id)?.n ?? 0);
    const rows = paid.filter((p) => p.signal === s.id);
    const buyers = rows.reduce((a, r) => a + Number(r.buyers || 0), 0);
    if (n >= MIN_PEOPLE && buyers >= MIN_BUYERS) {
      const major = rows.reduce((a, r) => a + fromMinor(Number(r.net || 0), r.currency), 0);
      const top = [...rows].sort((a, b) => Number(b.net) - Number(a.net))[0];
      return { signal: s.id, value: Math.max(0, Math.round(major / n)), currency: (top?.currency ?? model.currency).toUpperCase(), basis: `our own outcomes (${n} people, ${buyers} bought within ${OUTCOME_DAYS} days)`, n, buyers };
    }
    const v = model.values[s.id];
    if (v != null && v > 0) return { signal: s.id, value: v, currency: model.currency, basis: `${modelBasis} (webinar), until 50 people with 3 buyers`, n, buyers };
    return { signal: s.id, value: null, currency: model.currency, basis: `no value yet: the financial model has no rate for this step, and our own data needs 50 people with 3 buyers (now ${n} and ${buyers})`, n, buyers };
  });
}

// ───────────── who reached each signal (from the funnels' own rows) ─────────────

export interface Candidate { signal: SignalId; funnel: Funnel; session: string; leadId: string; regId: string | null; product?: string | null; day?: number | null; value?: number | null; currency?: string | null }

export const signalKey = (c: Pick<Candidate, 'signal' | 'funnel' | 'session' | 'leadId'>) => `${c.signal}:${c.funnel}:${c.session}:${c.leadId}`.slice(0, 300);
/** Deterministic Conversions API event id (≤ 64 chars) for one signal key. */
export const signalEventId = async (key: string) => `sg_${(await sha256(key)).slice(0, 40)}`;

/** NOT EXISTS on meta_signals for the key built from SQL expressions. */
const notSent = (signal: SignalId, funnel: string, session: string, lead: string) =>
  `NOT EXISTS (SELECT 1 FROM meta_signals m WHERE m.key = substr('${signal}:' || ${funnel} || ':' || ${session} || ':' || ${lead}, 1, 300))`;

const PRODUCT_OF_STAGE: Record<string, string> = { auto: 'sprint', live: 'deposit', challenge: 'deposit' };

/** Minutes watched in an auto-webinar registration: a minute counts when it was watched live or on the replay. Pure. */
export function watchedMinutes(live: string | null, replay: string | null) {
  const a = live ?? '', b = replay ?? '';
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] === '1' || b[i] === '1') n++;
  return n;
}

async function rows<T>(rt: Pick<Runtime, 'env'>, sql: string, ...binds: unknown[]): Promise<T[]> {
  return rt.env.DB.prepare(sql).bind(...binds).all<T>().then((r) => r.results).catch((e) => { console.error('signals query', String(e).slice(0, 200)); return [] as T[]; });
}

/** Everyone who reached a signal in the last 6 days and has not been sent it for that session. */
export async function signalCandidates(rt: Pick<Runtime, 'env'>, now = Date.now(), limit = 100): Promise<Candidate[]> {
  const since = now - WINDOW;
  const out: Candidate[] = [];
  type R = { funnel: Funnel; session: string; lead_id: string; reg_id: string | null; detail?: string | null; day?: number | null };

  // 1. Watched 30+ minutes. Live: minutes from the room or Zoom per event. Challenge: per day. Auto: the per-minute strings.
  for (const r of await rows<R>(rt,
    `SELECT 'live' AS funnel, w.event_ref AS session, w.lead_id, w.reg_id FROM attr_watch w JOIN live_webinars e ON e.id = w.event_ref
      WHERE w.funnel = 'live' AND e.starts_at > ? AND ${notSent('watched_30m', "'live'", 'w.event_ref', 'w.lead_id')}
      GROUP BY w.event_ref, w.reg_id HAVING COUNT(*) >= ? LIMIT ?`, since, WATCH_MINUTES, limit)) out.push({ signal: 'watched_30m', funnel: 'live', session: r.session, leadId: r.lead_id, regId: r.reg_id });
  for (const r of await rows<R>(rt,
    `SELECT 'challenge' AS funnel, w.event_ref AS session, w.lead_id, w.reg_id, d.day FROM attr_watch w JOIN challenge_days d ON 'challenge:' || d.cohort_id || ':' || d.day = w.event_ref
      WHERE w.funnel = 'challenge' AND d.starts_at > ? AND ${notSent('watched_30m', "'challenge'", 'w.event_ref', 'w.lead_id')}
      GROUP BY w.event_ref, w.reg_id HAVING COUNT(*) >= ? LIMIT ?`, since, WATCH_MINUTES, limit)) out.push({ signal: 'watched_30m', funnel: 'challenge', session: r.session, leadId: r.lead_id, regId: r.reg_id, day: r.day ?? null });
  for (const r of await rows<R & { live_minutes: string | null; replay_minutes: string | null }>(rt,
    `SELECT 'auto' AS funnel, r.session_id AS session, r.lead_id, r.id AS reg_id, r.live_minutes, r.replay_minutes FROM webinar_registrations r
      WHERE COALESCE(r.last_seen_at, r.joined_at, r.replay_at, 0) > ? AND (r.joined_at IS NOT NULL OR r.replay_at IS NOT NULL)
        AND ${notSent('watched_30m', "'auto'", 'r.session_id', 'r.lead_id')} LIMIT ?`, since, limit * 5)) {
    if (watchedMinutes(r.live_minutes, r.replay_minutes) >= WATCH_MINUTES) out.push({ signal: 'watched_30m', funnel: 'auto', session: r.session, leadId: r.lead_id, regId: r.reg_id });
  }

  // 2.–5. From the stage rows (src/attribution): offer seen (= present when it opened), offer clicked, checkout started, applied in the room.
  const stageSignal = async (signal: SignalId, where: string) => {
    for (const r of await rows<R>(rt,
      `SELECT a.funnel, COALESCE(a.cohort_ref, a.reg_id) AS session, a.lead_id, a.reg_id, a.detail FROM attr_stages a
        WHERE ${where} AND a.funnel IN ('auto', 'live', 'challenge') AND a.ts > ? AND ${notSent(signal, 'a.funnel', 'COALESCE(a.cohort_ref, a.reg_id)', 'a.lead_id')}
        ORDER BY a.ts LIMIT ?`, since, limit)) {
      const fromPush = /^(sprint|deposit|vip):/.exec(r.detail ?? '')?.[1];
      const product = signal === 'offer_opened' || signal === 'checkout_started' ? fromPush ?? PRODUCT_OF_STAGE[r.funnel] : null;
      const day = r.funnel === 'challenge' ? Number(/day (\d)/.exec(r.detail ?? '')?.[1]) || null : null;
      out.push({ signal, funnel: r.funnel, session: r.session, leadId: r.lead_id, regId: r.reg_id, product, day });
    }
  };
  await stageSignal('stayed_for_pitch', "a.stage = 'offer_seen'");
  await stageSignal('offer_opened', "(a.stage = 'offer_clicked' OR (a.stage = 'room_push' AND a.detail IN ('sprint:opened', 'deposit:opened', 'vip:opened')))");
  await stageSignal('checkout_started', "(a.stage = 'checkout_started' OR (a.stage = 'room_push' AND a.detail IN ('sprint:started', 'deposit:started', 'vip:started')))");
  await stageSignal('application_submitted', "a.stage = 'room_application'");
  // VIP checkouts (challenge orders) have no stage row of their own.
  for (const r of await rows<R>(rt,
    `SELECT 'challenge' AS funnel, g.cohort_id AS session, o.lead_id, o.reg_id FROM challenge_orders o JOIN challenge_registrations g ON g.id = o.reg_id
      WHERE o.kind = 'vip' AND o.created_at > ? AND ${notSent('checkout_started', "'challenge'", 'g.cohort_id', 'o.lead_id')} GROUP BY o.reg_id LIMIT ?`, since, limit)) {
    out.push({ signal: 'checkout_started', funnel: 'challenge', session: r.session, leadId: r.lead_id, regId: r.reg_id, product: 'vip' });
  }

  // 6. Signed engagements, credited to the webinar funnel the person last registered in before signing (as attribution does).
  for (const k of await rows<{ id: string; lead_id: string; signed_at: number; fee: number; currency: string | null }>(rt,
    `SELECT k.id, k.lead_id, k.signed_at, k.fee, k.currency FROM contracts k
      WHERE k.status = 'signed' AND COALESCE(k.is_test, 0) = 0 AND k.voided_at IS NULL AND k.signed_at > ?
        AND NOT EXISTS (SELECT 1 FROM meta_signals m WHERE m.signal = 'contract_signed' AND m.lead_id = k.lead_id) LIMIT ?`, since, limit)) {
    const reg = await rt.env.DB.prepare(
      `SELECT * FROM (SELECT 'auto' AS funnel, id, session_id AS cohort, created_at AS at FROM webinar_registrations WHERE lead_id = ?1 AND created_at <= ?2
         UNION ALL SELECT 'live', id, event_id, created_at FROM live_webinar_regs WHERE lead_id = ?1 AND created_at <= ?2
         UNION ALL SELECT 'challenge', id, cohort_id, created_at FROM challenge_registrations WHERE lead_id = ?1 AND created_at <= ?2) ORDER BY at DESC LIMIT 1`,
    ).bind(k.lead_id, k.signed_at).first<{ funnel: Funnel; id: string; cohort: string }>().catch(() => null);
    if (!reg) continue; // not from a webinar funnel
    // The contract is the session for this signal: one event per signed contract. reg_id holds the contract id.
    out.push({ signal: 'contract_signed', funnel: reg.funnel, session: reg.cohort, leadId: k.lead_id, regId: k.id, value: Number(k.fee) > 0 ? Number(k.fee) : null, currency: (k.currency || 'AUD').toUpperCase() });
  }
  // One per key even when two sources produced it in this run (e.g. an offer click and a room card open).
  const seen = new Set<string>();
  return out.filter((c) => { const k = signalKey(c); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ───────────── sending ─────────────

/**
 * Cron (every 5 minutes): sends each new signal once. Needs the Pixel and the Conversions API token; off with
 * META_SIGNALS=off. People whose consent doesn't cover ad tracking are recorded (status no_consent) and the event
 * stays first-party: forwardEvent never sends it to Meta.
 */
export async function sendSignals(rt: Runtime, o: { now?: number; limit?: number } = {}) {
  const s = st(rt);
  const out = { sent: 0, noConsent: 0, skipped: false };
  if (!signalsOn(rt) || !s.META_PIXEL_ID || !s.META_ACCESS_TOKEN) return { ...out, skipped: true };
  const now = o.now ?? Date.now();
  const cands = await signalCandidates(rt, now, o.limit ?? 100);
  if (!cands.length) return out;
  const values = signalValuesOn(rt) ? await signalValues(rt, now).catch(() => [] as SignalValue[]) : [];
  const defs = new Map(SIGNALS.map((d) => [d.id, d]));
  for (const c of cands.slice(0, o.limit ?? 100)) {
    const def = defs.get(c.signal)!;
    const key = signalKey(c);
    const eventId = await signalEventId(key);
    const who = await identityFromLead(rt.env, c.leadId);
    const consent = who.marketingConsent !== false;
    // Contract value is real; the room signals' values are estimates and only sent when switched on.
    const est = c.signal === 'contract_signed' ? null : values.find((v) => v.signal === c.signal && v.value != null && v.value > 0) ?? null;
    const value = c.signal === 'contract_signed' ? c.value ?? null : est?.value ?? null;
    const currency = c.signal === 'contract_signed' ? c.currency ?? null : est?.currency ?? null;
    const ins = await rt.env.DB.prepare(
      `INSERT OR IGNORE INTO meta_signals (key, signal, funnel, session_ref, lead_id, reg_id, event_id, product, value, currency, estimate, basis, status, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(key, c.signal, c.funnel, c.session, c.leadId, c.regId, eventId, c.product ?? null, value, currency, est ? 1 : 0, est?.basis ?? (c.signal === 'contract_signed' && value ? 'contract fee' : null), consent ? 'sent' : 'no_consent', now).run();
    if (!ins.meta.changes) continue;
    const props: Record<string, unknown> = { signal: c.signal, funnel: c.funnel, session_ref: c.session, ...(c.signal === 'contract_signed' ? { contract_id: c.regId } : { reg_id: c.regId }) };
    if (c.product) props.product = c.product;
    if (c.day) props.day = c.day;
    if (value != null && value > 0 && currency) Object.assign(props, { value, currency, ...(est ? { estimate: true } : {}) });
    await track(rt, who, {
      name: def.event,
      // A signed contract happens outside the website: Meta gets it as an offline (system generated) conversion.
      source: c.signal === 'contract_signed' ? 'cron' : 'server',
      path: c.funnel === 'auto' ? '/webinar' : `/${c.funnel}`,
      props,
      eventId,
    });
    if (consent) out.sent++; else out.noConsent++;
  }
  return out;
}

/** Funnel HQ: signals sent per signal in the last 30 days, with the values in use. */
export async function signalsReport(rt: Pick<Runtime, 'env' | 'settings'>, now = Date.now()) {
  const counts = await rows<{ signal: string; funnel: string; status: string; n: number }>(rt,
    'SELECT signal, funnel, status, COUNT(*) AS n FROM meta_signals WHERE sent_at > ? GROUP BY 1, 2, 3', now - 30 * DAY);
  const values = await signalValues(rt, now).catch(() => [] as SignalValue[]);
  return {
    on: signalsOn(rt), valuesOn: signalValuesOn(rt),
    signals: SIGNALS.map((d) => ({
      id: d.id, label: d.label, meta: d.meta, description: d.description,
      sent: counts.filter((c) => c.signal === d.id && c.status === 'sent').reduce((a, c) => a + Number(c.n), 0),
      noConsent: counts.filter((c) => c.signal === d.id && c.status === 'no_consent').reduce((a, c) => a + Number(c.n), 0),
      byFunnel: Object.fromEntries(['auto', 'live', 'challenge'].map((f) => [f, counts.filter((c) => c.signal === d.id && c.funnel === f).reduce((a, c) => a + Number(c.n), 0)])),
      value: d.id === 'contract_signed' ? { value: null, currency: null, basis: 'the signed contract fee (real, always sent)', estimate: false } : (() => { const v = values.find((x) => x.signal === d.id); return v ? { value: v.value, currency: v.currency, basis: v.basis, estimate: true } : null; })(),
    })),
  };
}


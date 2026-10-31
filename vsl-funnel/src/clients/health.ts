import type { Runtime } from '../app';
import { DEAL_SPRINT_DELIVERABLES, sprintDay } from '../webinar/deal-sprint';

/**
 * Client Success: who our clients are, how healthy each one is and why.
 *
 * A client is a lead with a paid First Deal Sprint (webinar_passes kind 'offer'), a paid engagement deposit
 * (kind 'deposit', or a paid challenge deposit) or a signed engagement agreement (contracts, not a test).
 * The health score starts at 100 and every deduction comes from a row in our own tables, with the reason
 * and the Funnel HQ view it came from. Nothing is estimated: a signal we don't track is simply left out.
 */

export type ClientType = 'sprint' | 'deposit' | 'engagement';
export type Band = 'healthy' | 'watch' | 'at_risk' | 'churned';
export interface Reason { label: string; delta: number; source: string }
export interface Health { score: number; band: Band; reasons: Reason[]; flags: string[] }

const DAY = 86_400_000;
const days = (ms: number) => Math.floor(ms / DAY);
const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const FLAG_LABELS: Record<string, string> = {
  refunded: 'Refunded',
  churn_risk: 'Churn risk',
  payment_overdue: 'Payment overdue',
  deliverable_late: 'Deliverable late',
  intake_missing: 'Intake missing',
  stalled: 'Stalled after deposit',
  guarantee_conditions: 'Guarantee conditions at risk',
  sessions_missed: 'Missed sessions',
  slow_replies: 'Slow replies',
  awaiting_reply: 'Waiting on their reply',
  gone_quiet: 'Gone quiet',
  open_escalation: 'Open support escalation',
  refund_risk: 'Asked about a refund',
};

export interface ClientSignals {
  type: ClientType;
  sinceAt: number;
  refundedAt: number | null;
  sprint: null | {
    paidAt: number;
    intakeAt: number | null;
    financialsUrl: string | null;
    kickoffBookedAt: number | null;
    kickoffHeldAt: number | null;
    planHeldAt: number | null;
    proposalSentAt: number | null;
    deliverables: { key: string; status: string; readyAt: number | null }[];
  };
  deposit: null | { paidAt: number };
  engagement: null | { signedAt: number; paidAt: number | null };
  agreementSentAt: number | null;
  nextPaymentAt: number | null;
  loiSignedAt: number | null;
  /** Hand-ticked checklist items: key → done at. */
  checklist: Record<string, number>;
  touchpoints: { kind: string; at: number }[];
  /** Their messages to us (support inbox, matched to the lead). */
  inboundAts: number[];
  /** Personal messages from the team (sent check-ins and support replies; not marketing sequences). */
  outboundAts: number[];
  openEscalations: { reason: string | null }[];
}

/** Median hours between a team message and the client's next reply; null when there is no pair yet. */
export function replyLatencyHours(outbound: number[], inbound: number[]): number | null {
  const outs = [...outbound].sort((a, b) => a - b);
  const ins = [...inbound].sort((a, b) => a - b);
  const gaps: number[] = [];
  let lastIn = -Infinity;
  for (const i of ins) {
    // the earliest team message after their previous message: how long they took to answer it
    const o = outs.find((x) => x > lastIn && x < i);
    if (o != null) gaps.push((i - o) / 3_600_000);
    lastIn = i;
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const m = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2;
}

export function lastContactAt(s: ClientSignals): number | null {
  const two = [
    ...s.inboundAts,
    ...s.touchpoints.filter((t) => t.kind === 'session_attended' || t.kind === 'call').map((t) => t.at),
    s.sprint?.kickoffHeldAt ?? 0, s.sprint?.planHeldAt ?? 0,
  ].filter((x) => x > 0);
  return two.length ? Math.max(...two) : null;
}

/** The health score, its band, every reason (with where the number comes from) and the flags. Pure. */
export function scoreClient(s: ClientSignals, now = Date.now()): Health {
  const reasons: Reason[] = [];
  const flags = new Set<string>();
  const add = (label: string, delta: number, source: string, flag?: string) => { reasons.push({ label, delta, source }); if (flag) flags.add(flag); };

  if (s.refundedAt && s.type !== 'engagement') {
    return { score: 0, band: 'churned', reasons: [{ label: `Refunded on ${fmtDate(s.refundedAt)}`, delta: -100, source: 'dealsprint' }], flags: ['refunded'] };
  }

  // ── First Deal Sprint delivery (only while the Sprint is the furthest step) ──
  if (s.sprint && s.type === 'sprint') {
    const day = sprintDay(s.sprint.paidAt, now);
    if (!s.sprint.intakeAt && day >= 2) add(`Sprint intake not received (day ${Math.min(day, 7)} of 7)`, -15, 'dealsprint', 'intake_missing');
    if (!s.sprint.kickoffHeldAt && day >= 3) add('Kickoff call not marked held by day 3', -10, 'dealsprint');
    if (!s.sprint.planHeldAt && day >= 8) add('Deal Plan session not marked held after day 7', -10, 'dealsprint');
    const due = DEAL_SPRINT_DELIVERABLES.filter((d) => day > d.day);
    const late = due.filter((d) => s.sprint!.deliverables.find((x) => x.key === d.key)?.status !== 'ready');
    if (late.length) add(`${late.length} deliverable${late.length > 1 ? 's' : ''} past their day: ${late.map((d) => d.title).join(', ')}`, -Math.min(24, 8 * late.length), 'dealsprint', 'deliverable_late');
    else if (due.length) add(`All ${due.length} deliverables due so far are ready`, 5, 'dealsprint');
  }

  // ── Deposit paid, engagement not signed yet ──
  if (s.deposit && s.type === 'deposit') {
    const d = days(now - s.deposit.paidAt);
    if (!s.checklist.onboarding_held && d >= 5) add(`Onboarding call not marked held ${d} days after the deposit`, -10, 'clients');
    if (d >= 14) add(`Deposit paid ${d} days ago, engagement not signed yet`, -15, 'contracts', 'stalled');
  }

  // ── Engagement: payment and the guarantee's first-week conditions ──
  if (s.engagement) {
    const d = days(now - s.engagement.signedAt);
    if (!s.engagement.paidAt && d >= 7) add(`Agreement signed ${d} days ago, payment not recorded`, -20, 'contracts', 'payment_overdue');
    if (d >= 7 && !s.checklist.kickoff_held) add('Guarantee condition: kickoff not marked held within 7 days of signing', -10, 'clients', 'guarantee_conditions');
    if (d >= 7 && !s.checklist.financials) add('Guarantee condition: two years of financials not marked received within 7 days', -10, 'clients', 'guarantee_conditions');
  }
  if (s.nextPaymentAt && s.nextPaymentAt < now - DAY) add(`Payment due ${fmtDate(s.nextPaymentAt)} not recorded`, -15, 'sales', 'payment_overdue');

  // ── Weekly working sessions (logged by the team) ──
  const missed = s.touchpoints.filter((t) => t.kind === 'session_missed');
  const missed30 = missed.filter((t) => t.at > now - 30 * DAY).length;
  if (missed30) add(`Missed ${missed30} weekly session${missed30 > 1 ? 's' : ''} in the last 30 days`, -Math.min(24, 8 * missed30), 'clients', 'sessions_missed');
  if (missed.length > 2) add(`Missed ${missed.length} weekly sessions in total (the guarantee allows two)`, -10, 'clients', 'guarantee_conditions');
  if (s.touchpoints.some((t) => t.kind === 'session_attended' && t.at > now - 14 * DAY)) add('Attended a weekly session in the last 14 days', 5, 'clients');

  // ── How fast they answer the team ──
  const lat = replyLatencyHours(s.outboundAts, s.inboundAts);
  if (lat != null && lat > 48) add(`Median reply time ${Math.round(lat / 24 * 10) / 10} days (the guarantee asks for 2 business days)`, -12, 'support', 'slow_replies');
  const lastOut = s.outboundAts.length ? Math.max(...s.outboundAts) : null;
  const lastIn = s.inboundAts.length ? Math.max(...s.inboundAts) : null;
  if (lastOut && (!lastIn || lastIn < lastOut) && now - lastOut > 4 * DAY) add(`No reply to the team's message of ${fmtDate(lastOut)} (${days(now - lastOut)} days)`, -10, 'support', 'awaiting_reply');

  // ── Last two-way contact ──
  const contact = lastContactAt(s);
  const quiet = days(now - (contact ?? s.sinceAt));
  if (quiet > 30) add(`No two-way contact for ${quiet} days`, -25, 'clients', 'gone_quiet');
  else if (quiet > 14) add(`No two-way contact for ${quiet} days`, -15, 'clients', 'gone_quiet');
  else if (quiet > 7) add(`No two-way contact for ${quiet} days`, -5, 'clients');

  // ── Support escalations ──
  if (s.openEscalations.length) {
    add(`${s.openEscalations.length} support question${s.openEscalations.length > 1 ? 's' : ''} waiting on a person`, -10, 'support', 'open_escalation');
    if (s.openEscalations.some((e) => /refund|cancel|chargeback/i.test(e.reason ?? ''))) flags.add('refund_risk');
  }
  if (s.loiSignedAt) add(`Letter of intent signed ${fmtDate(s.loiSignedAt)}`, 10, 'sales');

  const score = Math.max(0, Math.min(100, 100 + reasons.reduce((t, r) => t + r.delta, 0)));
  const band: Band = score >= 75 ? 'healthy' : score >= 50 ? 'watch' : 'at_risk';
  if (band === 'at_risk' || flags.has('refund_risk')) flags.add('churn_risk');
  return { score, band, reasons, flags: [...flags] };
}

// ───────────── onboarding checklists ─────────────

export interface ChecklistItem { key: string; label: string; derive?: (s: ClientSignals) => number | null }
export const CHECKLISTS: Record<ClientType, ChecklistItem[]> = {
  sprint: [
    { key: 'intake', label: 'Intake form received', derive: (s) => s.sprint?.intakeAt ?? null },
    { key: 'kickoff_booked', label: 'Kickoff call booked', derive: (s) => s.sprint?.kickoffBookedAt ?? null },
    { key: 'kickoff_held', label: 'Kickoff call held', derive: (s) => s.sprint?.kickoffHeldAt ?? null },
    { key: 'financials', label: 'Financial statements link received', derive: (s) => (s.sprint?.financialsUrl ? s.sprint.intakeAt : null) },
    { key: 'deliverables', label: 'All six deliverables ready', derive: (s) => { const r = s.sprint?.deliverables.filter((d) => d.status === 'ready') ?? []; return r.length >= DEAL_SPRINT_DELIVERABLES.length ? Math.max(...r.map((d) => d.readyAt ?? 0)) || 1 : null; } },
    { key: 'plan_held', label: 'Deal Plan session held', derive: (s) => s.sprint?.planHeldAt ?? null },
    { key: 'proposal_sent', label: 'Engagement proposal sent', derive: (s) => s.sprint?.proposalSentAt ?? s.agreementSentAt },
  ],
  deposit: [
    { key: 'onboarding_booked', label: 'Onboarding call booked' },
    { key: 'onboarding_held', label: 'Onboarding call held' },
    { key: 'agreement_sent', label: 'Engagement agreement sent', derive: (s) => s.agreementSentAt },
    { key: 'agreement_signed', label: 'Engagement agreement signed', derive: (s) => s.engagement?.signedAt ?? null },
    { key: 'balance_paid', label: 'Balance paid', derive: (s) => s.engagement?.paidAt ?? null },
  ],
  engagement: [
    { key: 'agreement_signed', label: 'Engagement agreement signed', derive: (s) => s.engagement?.signedAt ?? null },
    { key: 'payment_received', label: 'Payment received', derive: (s) => s.engagement?.paidAt ?? null },
    { key: 'kickoff_held', label: 'Kickoff held (within 7 days)' },
    { key: 'financials', label: 'Last two years of financials received (within 7 days)' },
    { key: 'buy_box', label: 'Buy box agreed in writing' },
    { key: 'scripts', label: 'Outreach scripts delivered' },
    { key: 'sessions_set', label: 'Weekly session time agreed' },
    { key: 'first_loi', label: 'First letter of intent signed', derive: (s) => s.loiSignedAt },
  ],
};

export function checklistFor(s: ClientSignals) {
  return CHECKLISTS[s.type].map((i) => {
    const derived = i.derive?.(s) ?? null;
    const manual = s.checklist[i.key] ?? null;
    return { key: i.key, label: i.label, done_at: derived ?? manual, auto: Boolean(i.derive), manual: !i.derive };
  });
}

// ───────────── check-in cadence ─────────────

/** Days between check-ins: tighter during the 7-day Sprint and when health slips. */
export function cadenceDays(type: ClientType, band: Band) {
  if (band === 'churned') return null;
  if (band === 'at_risk') return 3;
  if (type === 'sprint') return 3;
  if (band === 'watch') return 7;
  return type === 'deposit' ? 7 : 14;
}

export function nextCheckinAt(type: ClientType, band: Band, sinceAt: number, lastCheckinAt: number | null) {
  const c = cadenceDays(type, band);
  if (c == null) return null;
  // The first check-in lands one day after they became a client.
  return lastCheckinAt ? lastCheckinAt + c * DAY : sinceAt + DAY;
}

// ───────────── gathering signals from D1 ─────────────

type Row = Record<string, unknown>;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

/** Every client, with the type they reached and since when. */
export async function listClientIds(rt: Runtime): Promise<{ lead_id: string; type: ClientType; since_at: number }[]> {
  const db = rt.env.DB;
  const safe = <T>(p: Promise<{ results: T[] }>) => p.catch(() => ({ results: [] as T[] }));
  const [sprints, deposits, chDeposits, signed] = await Promise.all([
    safe(db.prepare("SELECT lead_id, MIN(COALESCE(paid_at, created_at)) AS at FROM webinar_passes WHERE kind = 'offer' AND status IN ('paid', 'refunded') GROUP BY lead_id").all<{ lead_id: string; at: number }>()),
    safe(db.prepare("SELECT lead_id, MIN(COALESCE(paid_at, created_at)) AS at FROM webinar_passes WHERE kind = 'deposit' AND status IN ('paid', 'refunded') GROUP BY lead_id").all<{ lead_id: string; at: number }>()),
    safe(db.prepare('SELECT lead_id, MIN(paid_at) AS at FROM challenge_deposits WHERE paid_at IS NOT NULL GROUP BY lead_id').all<{ lead_id: string; at: number }>()),
    safe(db.prepare("SELECT lead_id, MIN(signed_at) AS at FROM contracts WHERE status = 'signed' AND COALESCE(is_test, 0) = 0 AND signed_at IS NOT NULL GROUP BY lead_id").all<{ lead_id: string; at: number }>()),
  ]);
  const out = new Map<string, { lead_id: string; type: ClientType; since_at: number }>();
  const rank: Record<ClientType, number> = { sprint: 1, deposit: 2, engagement: 3 };
  const put = (rows: { lead_id: string; at: number }[], type: ClientType) => {
    for (const r of rows) {
      const cur = out.get(r.lead_id);
      if (!cur || rank[type] > rank[cur.type]) out.set(r.lead_id, { lead_id: r.lead_id, type, since_at: Number(r.at) });
    }
  };
  put(sprints.results, 'sprint');
  put([...deposits.results, ...chDeposits.results], 'deposit');
  put(signed.results, 'engagement');
  return [...out.values()];
}

export async function gatherSignals(rt: Runtime, leadId: string, type: ClientType, sinceAt: number, checklist: Record<string, number> = {}): Promise<ClientSignals> {
  const db = rt.env.DB;
  const all = <T = Row>(sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).all<T>().then((r) => r.results).catch(() => [] as T[]);
  const first = <T = Row>(sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).first<T>().catch(() => null);
  const [lead, passes, contracts, touch, inbound, supportOut, checkins, esc] = await Promise.all([
    first<Row>('SELECT next_payment_at, loi_signed_at, refunded_at, email FROM leads WHERE id = ?', leadId),
    all<Row>("SELECT id, kind, status, paid_at, refunded_at FROM webinar_passes WHERE lead_id = ? AND kind IN ('offer', 'deposit') AND status IN ('paid', 'refunded') ORDER BY paid_at", leadId),
    all<Row>("SELECT status, sent_at, signed_at, paid_at FROM contracts WHERE lead_id = ? AND COALESCE(is_test, 0) = 0 AND status != 'void' ORDER BY created_at", leadId),
    all<{ kind: string; at: number }>('SELECT kind, at FROM cs_touchpoints WHERE lead_id = ? ORDER BY at', leadId),
    all<{ at: number }>("SELECT m.created_at AS at FROM support_messages m JOIN support_threads t ON t.id = m.thread_id WHERE t.lead_id = ? AND m.direction = 'in'", leadId),
    all<{ at: number }>("SELECT m.created_at AS at FROM support_messages m JOIN support_threads t ON t.id = m.thread_id WHERE t.lead_id = ? AND m.direction = 'out'", leadId),
    all<{ at: number }>("SELECT sent_at AS at FROM cs_checkins WHERE lead_id = ? AND status = 'sent' AND sent_at IS NOT NULL", leadId),
    all<{ reason: string | null }>("SELECT escalate_reason AS reason FROM support_threads WHERE lead_id = ? AND escalated = 1 AND status = 'escalated'", leadId),
  ]);
  const sprintPass = passes.find((p) => p.kind === 'offer');
  let sprint: ClientSignals['sprint'] = null;
  if (sprintPass) {
    const pid = String(sprintPass.id);
    const [ds, dels, intake] = await Promise.all([
      first<Row>('SELECT * FROM deal_sprints WHERE pass_id = ?', pid),
      all<Row>('SELECT key, status, ready_at FROM deal_sprint_deliverables WHERE pass_id = ?', pid),
      first<Row>('SELECT submitted_at, financials_url FROM deal_sprint_intake WHERE pass_id = ?', pid),
    ]);
    sprint = {
      paidAt: Number(sprintPass.paid_at ?? sinceAt),
      intakeAt: num(intake?.submitted_at),
      financialsUrl: (intake?.financials_url as string | null) ?? null,
      kickoffBookedAt: num(ds?.kickoff_booked_at),
      kickoffHeldAt: num(ds?.kickoff_held_at),
      planHeldAt: num(ds?.plan_held_at),
      proposalSentAt: num(ds?.proposal_sent_at),
      deliverables: dels.map((d) => ({ key: String(d.key), status: String(d.status), readyAt: num(d.ready_at) })),
    };
  }
  const dep = passes.find((p) => p.kind === 'deposit' && p.status === 'paid');
  const signed = contracts.find((k) => k.status === 'signed');
  const sent = contracts.find((k) => k.sent_at);
  // Refunded = every purchase refunded and nothing signed.
  const refundedAt = passes.length && passes.every((p) => p.status === 'refunded') && !signed ? Math.max(...passes.map((p) => Number(p.refunded_at ?? 0))) || Number(lead?.refunded_at ?? 0) || Date.now() : null;
  return {
    type, sinceAt, refundedAt,
    sprint,
    deposit: dep ? { paidAt: Number(dep.paid_at) } : type === 'deposit' ? { paidAt: sinceAt } : null,
    engagement: signed ? { signedAt: Number(signed.signed_at), paidAt: num(signed.paid_at) } : null,
    agreementSentAt: num(sent?.sent_at),
    nextPaymentAt: num(lead?.next_payment_at),
    loiSignedAt: num(lead?.loi_signed_at),
    checklist,
    touchpoints: touch,
    inboundAts: inbound.map((r) => Number(r.at)),
    outboundAts: [...supportOut, ...checkins].map((r) => Number(r.at)),
    openEscalations: esc,
  };
}

const parseObj = (s: unknown): Record<string, number> => { try { const v = JSON.parse(String(s ?? '{}')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

/** Rebuild every client's row: type, health, reasons, flags, contact dates and next check-in. */
export async function rebuildClients(rt: Runtime, now = Date.now()) {
  const db = rt.env.DB;
  const ids = await listClientIds(rt);
  const { results: existing } = await db.prepare('SELECT lead_id, checklist FROM cs_clients').all<{ lead_id: string; checklist: string }>();
  const today = new Date(now).toISOString().slice(0, 10);
  let n = 0;
  for (const c of ids) {
    const checklist = parseObj(existing.find((e) => e.lead_id === c.lead_id)?.checklist);
    const s = await gatherSignals(rt, c.lead_id, c.type, c.since_at, checklist);
    const h = scoreClient(s, now);
    const lastCheckin = await db.prepare("SELECT MAX(COALESCE(sent_at, created_at)) AS at FROM cs_checkins WHERE lead_id = ? AND status IN ('sent', 'skipped', 'proposed')").bind(c.lead_id).first<{ at: number | null }>();
    const next = nextCheckinAt(c.type, h.band, c.since_at, lastCheckin?.at ?? null);
    const lastOut = s.outboundAts.length ? Math.max(...s.outboundAts) : null;
    await db.batch([
      db.prepare(
        `INSERT INTO cs_clients (lead_id, client_type, since_at, health, band, reasons, flags, last_contact_at, last_outbound_at, next_checkin_at, scored_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(lead_id) DO UPDATE SET client_type = excluded.client_type, since_at = excluded.since_at, health = excluded.health, band = excluded.band,
           reasons = excluded.reasons, flags = excluded.flags, last_contact_at = excluded.last_contact_at, last_outbound_at = excluded.last_outbound_at,
           next_checkin_at = excluded.next_checkin_at, scored_at = excluded.scored_at, updated_at = excluded.updated_at`,
      ).bind(c.lead_id, c.type, c.since_at, h.score, h.band, JSON.stringify(h.reasons), JSON.stringify(h.flags), lastContactAt(s), lastOut, next, now, now, now),
      db.prepare('INSERT INTO cs_health_history (lead_id, day, health, band) VALUES (?, ?, ?, ?) ON CONFLICT(lead_id, day) DO UPDATE SET health = excluded.health, band = excluded.band')
        .bind(c.lead_id, today, h.score, h.band),
    ]);
    n++;
  }
  return { clients: n };
}

export async function rescoreClient(rt: Runtime, leadId: string, now = Date.now()) {
  const c = (await listClientIds(rt)).find((x) => x.lead_id === leadId);
  if (!c) return null;
  const row = await rt.env.DB.prepare('SELECT checklist FROM cs_clients WHERE lead_id = ?').bind(leadId).first<{ checklist: string }>();
  const s = await gatherSignals(rt, leadId, c.type, c.since_at, parseObj(row?.checklist));
  return { client: c, signals: s, health: scoreClient(s, now), checklist: checklistFor(s) };
}

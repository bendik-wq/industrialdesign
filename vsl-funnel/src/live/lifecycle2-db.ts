import type { Runtime } from '../app';
import { type Lead, getLead } from '../funnel/leads';
import { formatCallTime, unsubscribeSig } from '../integrations/email';
import { type LiveEvent, type LiveReg, eventEnd, getEvent, liveRoomUrl, liveSettings, offerWindow } from './events';
import {
  DAY, HOUR, LC2_LABEL, LC2_OFF, LC2_PAGE, LC2_STEP, LC2_STEPS, LC2_VIA, type Lc2Step, type Lc2Toggles, type PlanItem, type WatchBucket,
  dueMissed, gate, impact, leadinEmail, leadinPlan, missedEmail, watchBucket, watchedPct,
} from './lifecycle2';

/**
 * Round 4 "lifecycle2": the I/O around lifecycle2.ts. Own table lc2_events (migration 0078: the per-event
 * switches, all off by default); the emails are rows in `emails` (sequence lc2:<event id>), claimed once by
 * mail.ts sendOnce. Called from lifecycle-db.ts (the cron, the no-show highlights hand-over), lifecycle-pages.ts
 * (the confirmation page's lead-in block, the Funnel HQ routes).
 */

export const lc2Seq = (eventId: string) => `lc2:${eventId}`;
const stepOf = (reg: Pick<LiveReg, 'seq'>, k: Lc2Step) => reg.seq * 10 + LC2_STEP[k];
const ANCHOR: Partial<Record<Lc2Step, string>> = { welcome: '#lc-lead', question: '#lc-q-h', prework: '#lc-w-h', essentials: '#lc-lead' };

// ───────────── the switches ─────────────

const cache = new Map<string, { at: number; t: Lc2Toggles }>();
export async function lc2Toggles(rt: Pick<Runtime, 'env'>, eventId: string, fresh = false): Promise<Lc2Toggles> {
  const c = cache.get(eventId);
  if (!fresh && c && Date.now() - c.at < 20_000 && c.at <= Date.now()) return c.t;
  const row = await rt.env.DB.prepare('SELECT leadin, adaptive, missed FROM lc2_events WHERE event_id = ?').bind(eventId).first<{ leadin: number; adaptive: number; missed: number }>().catch(() => null);
  const t = row ? { leadin: Boolean(row.leadin), adaptive: Boolean(row.adaptive), missed: Boolean(row.missed) } : { ...LC2_OFF };
  cache.set(eventId, { at: Date.now(), t });
  return t;
}
export async function saveLc2(rt: Runtime, eventId: string, body: Record<string, unknown>) {
  if (!(await getEvent(rt, eventId))) return { ok: false as const, error: 'Event not found' };
  const cur = await lc2Toggles(rt, eventId, true);
  const pick = (k: keyof Lc2Toggles) => (typeof body[k] === 'boolean' ? (body[k] as boolean) : cur[k]);
  const t = { leadin: pick('leadin'), adaptive: pick('adaptive'), missed: pick('missed') };
  await rt.env.DB.prepare(`INSERT INTO lc2_events (event_id, leadin, adaptive, missed, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET leadin = excluded.leadin, adaptive = excluded.adaptive, missed = excluded.missed, updated_at = excluded.updated_at`)
    .bind(eventId, t.leadin ? 1 : 0, t.adaptive ? 1 : 0, t.missed ? 1 : 0, Date.now()).run();
  cache.delete(eventId);
  return { ok: true as const, toggles: t };
}

/** The existing pre-session daily cap (Settings → PREWEBINAR_EMAILS_PER_DAY, default 15; 0 = none of these go). */
export function dailyCap(rt: Pick<Runtime, 'settings'>) {
  const v = String((rt.settings as Partial<Record<string, string>>).PREWEBINAR_EMAILS_PER_DAY ?? '').trim();
  return v === '' || !Number.isFinite(Number(v)) ? 15 : Math.max(0, Math.min(24, Math.floor(Number(v))));
}

// ───────────── per person ─────────────

async function personTz(rt: Runtime, ev: LiveEvent, reg: LiveReg, lead: Lead) {
  const row = await rt.env.DB.prepare('SELECT tz FROM lc_regs WHERE reg_id = ?').bind(reg.id).first<{ tz: string | null }>().catch(() => null);
  return row?.tz || lead.timezone || ev.tz;
}
async function sentRows(rt: Runtime, ev: Pick<LiveEvent, 'id'>, reg: Pick<LiveReg, 'seq' | 'lead_id'>) {
  const { results } = await rt.env.DB.prepare('SELECT step, template, status, sent_at FROM emails WHERE lead_id = ? AND sequence = ? AND step >= ? AND step < ?')
    .bind(reg.lead_id, lc2Seq(ev.id), reg.seq * 10, reg.seq * 10 + 10).all<{ step: number; template: string; status: string; sent_at: number | null }>();
  return results;
}
async function gateData(rt: Runtime, leadId: string, now: number) {
  const db = rt.env.DB;
  const [last, lc2, day, calls] = await Promise.all([
    db.prepare("SELECT MAX(sent_at) AS t FROM emails WHERE lead_id = ? AND status IN ('sent', 'simulated', 'sending') AND sent_at IS NOT NULL").bind(leadId).first<{ t: number | null }>(),
    db.prepare("SELECT MAX(sent_at) AS t FROM emails WHERE lead_id = ? AND sequence LIKE 'lc2:%' AND status IN ('sent', 'simulated', 'sending')").bind(leadId).first<{ t: number | null }>(),
    db.prepare("SELECT COUNT(*) AS n FROM emails WHERE lead_id = ? AND status IN ('sent', 'simulated', 'sending') AND sent_at > ?").bind(leadId, now - DAY).first<{ n: number }>(),
    db.prepare("SELECT run_at, wc_dialed_at FROM outbound_calls WHERE lead_id = ? AND kind != 'test' AND status IN ('queued', 'dialing', 'done', 'no_answer') AND run_at BETWEEN ? AND ?")
      .bind(leadId, now - 3 * HOUR, now + 3 * HOUR).all<{ run_at: number; wc_dialed_at: number | null }>().catch(() => ({ results: [] as { run_at: number; wc_dialed_at: number | null }[] })),
  ]);
  return { lastEmailAt: last?.t ?? null, lastLc2At: lc2?.t ?? null, sent24h: Number(day?.n ?? 0), callsAt: calls.results.map((c) => c.wc_dialed_at ?? c.run_at) };
}
async function unsubLink(rt: Runtime, leadId: string) { return `${rt.origin}/u/${leadId}/${await unsubscribeSig(rt, leadId)}`; }
async function skip(rt: Runtime, lead: Lead, ev: LiveEvent, reg: LiveReg, k: Lc2Step, why: string) {
  const { skipOnce } = await import('./mail');
  await skipOnce(rt, lead, lc2Seq(ev.id), stepOf(reg, k), `lc2_${k}`, why);
}

/** The person's plan with the real dates and what already happened (the page and Funnel HQ use it). */
export async function planFor(rt: Runtime, ev: LiveEvent, reg: LiveReg, lead: Lead, t?: Lc2Toggles) {
  const toggles = t ?? (await lc2Toggles(rt, ev.id));
  const tz = await personTz(rt, ev, reg, lead);
  const plan = leadinPlan(ev.starts_at, reg.created_at, toggles, tz);
  return { ...plan, tz };
}

/** Sends at most one lead-in, essentials or missed-live email for one registration (each step once, ever). */
export async function sendLc2(rt: Runtime, ev: LiveEvent, reg: LiveReg, lead: Lead, now = Date.now()) {
  if (ev.status !== 'scheduled' || !lead.email) return 0;
  const t = await lc2Toggles(rt, ev.id);
  if (!t.leadin && !t.adaptive && !t.missed) return 0;
  const rows = await sentRows(rt, ev, reg);
  const has = (k: Lc2Step) => rows.find((r) => r.step === stepOf(reg, k));
  const tz = await personTz(rt, ev, reg, lead);
  const { sendOnce } = await import('./mail');
  const { safeFirstName } = await import('../lib/text');
  const { depositConfig } = await import('../sales/deposit');
  const base = { name: safeFirstName(lead.first_name) ?? 'there', title: ev.title, when: formatCallTime(ev.starts_at, tz), deposit: depositConfig(rt).label };
  const check = async () => gate({ now, tz, unsubscribed: Boolean(lead.unsubscribed_at), cap: dailyCap(rt), ...(await gateData(rt, lead.id, now)) });

  // Before the session: the lead-in parts or the essentials email.
  if (now < ev.starts_at && (t.leadin || t.adaptive)) {
    const { ticketGate } = await import('./events');
    if (await ticketGate(rt, reg)) return 0; // an unpaid ticket gets the ticket nudge, nothing else
    const plan = leadinPlan(ev.starts_at, reg.created_at, t, tz);
    const L = await import('./lifecycle-db');
    const lcRow = await L.lcReg(rt, reg.id);
    for (const it of plan.items) {
      if (has(it.step) || now < it.at) continue;
      if (now >= it.until) { await skip(rt, lead, ev, reg, it.step, 'Its window passed before it could go'); continue; }
      if (it.step === 'question' && lcRow?.question) { await skip(rt, lead, ev, reg, it.step, 'Already sent their question'); continue; }
      if (it.step === 'prework' && lcRow?.worksheet_at) { await skip(rt, lead, ev, reg, it.step, 'Already filled in the worksheet'); continue; }
      const g = await check();
      if (!g.ok) { if (g.final) await skip(rt, lead, ev, reg, it.step, g.why); return 0; }
      const lc = await L.lcEvent(rt, ev.id);
      const room = `${liveRoomUrl(rt, reg.token)}?via=${LC2_VIA[it.step]}${ANCHOR[it.step] ?? ''}`;
      const step = it.step as 'welcome' | 'question' | 'prework' | 'essentials';
      const mail = leadinEmail(step, { ...base, room, video: Boolean(lc.video_url), unsubscribe: await unsubLink(rt, lead.id), calendar: step === 'essentials' ? L.calLinks(rt, reg.token) : null });
      return (await sendOnce(rt, lead, lc2Seq(ev.id), stepOf(reg, it.step), `lc2_${it.step}`, mail, { unsubscribe: true })) ? 1 : 0;
    }
    return 0;
  }

  // After the session: the missed-live path, only while the offer is really open.
  if (!t.missed) return 0;
  const w = offerWindow(ev, now, liveSettings(rt).offerHours);
  if (now < w.end || !w.open) return 0;
  const { paidDeposit } = await import('../sales/deposit');
  const bought = Boolean(await paidDeposit(rt, reg.lead_id));
  const watch = await replayWatch(rt, ev, reg);
  const r1 = has('missed1');
  const sent1 = r1 && (r1.status === 'sent' || r1.status === 'simulated' || r1.status === 'sending') ? ((/_(none|started|most)$/.exec(r1.template)?.[1] ?? 'none') as WatchBucket) : null;
  if (r1 && !sent1) return 0; // skipped for good
  const due = dueMissed({ now, end: w.end, joined: Boolean(reg.joined_at), bought, offerOpen: w.open, closesAt: w.closesAt, bucket: watchBucket(watch), sent1, sent2: Boolean(has('missed2')) });
  if (!due) return 0;
  if (!(await replayReady(rt, ev))) return 0;
  const g = await check();
  if (!g.ok) { if (g.final) await skip(rt, lead, ev, reg, due.step, g.why); return 0; }
  const room = `${liveRoomUrl(rt, reg.token)}?via=${LC2_VIA[due.step]}`;
  const mail = missedEmail(due.step, due.bucket, { ...base, room, closes: formatCallTime(w.closesAt, tz), unsubscribe: await unsubLink(rt, lead.id) });
  return (await sendOnce(rt, lead, lc2Seq(ev.id), stepOf(reg, due.step), `lc2_${due.step}_${due.bucket}`, mail, { unsubscribe: true })) ? 1 : 0;
}

/** What they watched of the replay: our room's minute map when the event ran in our room, else only whether they opened it. */
export async function replayWatch(rt: Runtime, ev: Pick<LiveEvent, 'id' | 'platform'>, reg: Pick<LiveReg, 'id' | 'replay_at'>) {
  let pct: number | null = null;
  if (ev.platform === 'room') {
    const v = await rt.env.DB.prepare("SELECT v.minutes FROM room_replay_views v JOIN rooms m ON m.id = v.room_id WHERE m.ref_type = 'live' AND m.ref_id = ? AND v.reg_id = ? ORDER BY v.last_at DESC LIMIT 1")
      .bind(ev.id, reg.id).first<{ minutes: string }>().catch(() => null);
    pct = watchedPct(v?.minutes);
  }
  return { started: Boolean(reg.replay_at) || (pct ?? 0) > 0, pct };
}
/** A replay exists to send people to: the event's replay link, or a recording in our room. */
async function replayReady(rt: Runtime, ev: LiveEvent) {
  if (ev.replay_url) return true;
  if (ev.platform !== 'room') return false;
  const room = await rt.env.DB.prepare("SELECT id FROM rooms WHERE ref_type = 'live' AND ref_id = ?").bind(ev.id).first<{ id: string }>().catch(() => null);
  if (!room) return false;
  const { mainRecording } = await import('../rooms/intel-db');
  return Boolean(await mainRecording(rt, room.id).catch(() => null));
}

/** The cron (from lifecycleCron, every 5 minutes): only events with a switch on, before the start or inside the offer window. */
export async function lc2Cron(rt: Runtime, now = Date.now()) {
  const { results: events } = await rt.env.DB.prepare(
    `SELECT w.* FROM live_webinars w JOIN lc2_events t ON t.event_id = w.id
      WHERE w.status = 'scheduled' AND (t.leadin = 1 OR t.adaptive = 1 OR t.missed = 1) AND w.starts_at BETWEEN ? AND ?`,
  ).bind(now - 16 * DAY, now + 5 * DAY).all<LiveEvent>().catch(() => ({ results: [] as LiveEvent[] }));
  let sent = 0;
  for (const ev of events) {
    const t = await lc2Toggles(rt, ev.id);
    const before = now < ev.starts_at && (t.leadin || t.adaptive);
    const after = t.missed && now >= eventEnd(ev) && offerWindow(ev, now, liveSettings(rt).offerHours).open;
    if (!before && !after) continue;
    const { results: regs } = await rt.env.DB.prepare('SELECT * FROM live_webinar_regs WHERE event_id = ? LIMIT 2000').bind(ev.id).all<LiveReg>();
    for (const reg of regs) {
      const lead = await getLead(rt.env, reg.lead_id);
      if (!lead) continue;
      sent += await sendLc2(rt, ev, reg, lead, now).catch((e) => { console.error('lifecycle2', e); return 0; });
    }
  }
  return sent;
}

// ───────────── the confirmation page ─────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function dayLabel(t: number, tz: string) {
  try { return new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(t); } catch { return new Date(t).toUTCString().slice(0, 11); }
}
/** The lead-in block on the confirmation page (empty when the switches are off or nothing is planned for this person). */
export async function leadinBlock(rt: Runtime, ev: LiveEvent, reg: LiveReg, lcRow: { question: string | null; worksheet_at: number | null } | null, tz: string, o: { video?: boolean } = {}) {
  const t = await lc2Toggles(rt, ev.id);
  if (!t.leadin && !t.adaptive) return '';
  const plan = leadinPlan(ev.starts_at, reg.created_at, t, tz);
  if (!plan.items.length) return '';
  const rows = await sentRows(rt, ev, reg);
  const C = LC2_PAGE;
  const href: Record<string, string> = { welcome: '#lc-v-h', question: '#lc-q-h', prework: '#lc-w-h', essentials: '#lc-w-h' };
  const items = plan.items.map((it: PlanItem, i) => {
    const k = it.step as 'welcome' | 'question' | 'prework' | 'essentials';
    const row = rows.find((r) => r.step === stepOf(reg, it.step));
    const done = (k === 'question' && lcRow?.question) || ((k === 'prework' || k === 'essentials') && lcRow?.worksheet_at);
    const sent = row && (row.status === 'sent' || row.status === 'simulated');
    const state = done ? C.done : sent ? C.sent : C.inbox(dayLabel(it.at, tz));
    const target = k === 'welcome' && !o.video ? '#lc-cal-h' : href[k];
    return `<li class="lc2-item${done ? ' is-done' : ''}" data-lc2-step="${k}"><span class="lc2-n" aria-hidden="true">${plan.items.length > 1 ? i + 1 : '1'}</span><div class="lc2-body">
      <p class="lc2-t">${plan.items.length > 1 ? `<span class="lc-sr">${esc(C.part(i + 1))}: </span>` : ''}${esc(C.titles[k])}</p>
      <p class="lc2-p">${esc(C.blurbs[k === 'welcome' && !o.video ? 'welcomeNoVideo' : k])}</p>
      <p class="lc2-meta"><span class="lc2-state" data-lc2-state="${done ? 'done' : sent ? 'sent' : 'planned'}" data-lc2-done="${esc(C.done)}">${esc(state)}</span> <a class="lv-link" href="${target}">${esc(C.open)}</a></p></div></li>`;
  }).join('');
  const body = plan.mode === 'compressed' ? C.bodyCompressed : plan.mode === 'partial' ? C.bodyPartial : C.bodyFull;
  return `<section class="lc-block lc2" id="lc-lead" aria-labelledby="lc2-h"><h2 class="lc-h" id="lc2-h">${esc(C.heading)}</h2><p class="lc-p">${esc(body)}</p><ol class="lc2-list">${items}</ol></section>`;
}

// ───────────── Funnel HQ ─────────────

/** Per event: the switches, who is on which plan, and what each step did (real numbers from emails, clicks, joins, replays, deposits). */
export async function lc2Report(rt: Runtime, eventId: string) {
  const ev = await getEvent(rt, eventId);
  if (!ev) return null;
  const db = rt.env.DB;
  const t = await lc2Toggles(rt, eventId, true);
  const [regsR, emailsR, touchesR, depR] = await db.batch([
    db.prepare('SELECT r.id, r.lead_id, r.seq, r.created_at, r.joined_at, r.replay_at, c.tz, l.timezone FROM live_webinar_regs r JOIN leads l ON l.id = r.lead_id LEFT JOIN lc_regs c ON c.reg_id = r.id WHERE r.event_id = ? LIMIT 5000').bind(eventId),
    db.prepare('SELECT lead_id, step, template, status, sent_at, opened_at, error FROM emails WHERE sequence = ?').bind(lc2Seq(eventId)),
    db.prepare("SELECT reg_id, via, at FROM lc_touches WHERE event_id = ? AND via IN ('e-lw', 'e-lq', 'e-lp', 'e-le', 'e-m1', 'e-m2')").bind(eventId),
    db.prepare("SELECT lead_id, paid_at FROM webinar_passes WHERE kind = 'deposit' AND status = 'paid' AND lead_id IN (SELECT lead_id FROM live_webinar_regs WHERE event_id = ?)").bind(eventId),
  ]);
  type Reg = { id: string; lead_id: string; seq: number; created_at: number; joined_at: number | null; replay_at: number | null; tz: string | null; timezone: string | null };
  const regs = regsR.results as Reg[];
  const emails = emailsR.results as { lead_id: string; step: number; template: string; status: string; sent_at: number | null; opened_at: number | null; error: string | null }[];
  const touches = touchesR.results as { reg_id: string; via: string; at: number }[];
  const deps = depR.results as { lead_id: string; paid_at: number | null }[];
  const regByLead = new Map(regs.map((r) => [r.lead_id, r]));
  const steps = LC2_STEPS.map((k) => {
    const mine = emails.filter((e) => { const r = regByLead.get(e.lead_id); return r && e.step === r.seq * 10 + LC2_STEP[k]; });
    return impact({
      step: k,
      rows: mine.map((e) => {
        const r = regByLead.get(e.lead_id)!;
        const sentAt = e.sent_at ?? 0;
        return {
          status: e.status, opened_at: e.opened_at, sent_at: e.sent_at, why: e.status === 'skipped' ? e.error : null,
          clicked: touches.some((x) => x.reg_id === r.id && x.via === LC2_VIA[k]),
          joined: Boolean(r.joined_at), replayAfter: Boolean(r.replay_at && r.replay_at >= sentAt),
          boughtAfter: deps.some((d) => d.lead_id === r.lead_id && (d.paid_at ?? 0) >= sentAt),
        };
      }),
    });
  });
  // The comparison: registrants who got at least one pre-session email from here against those who didn't (not a controlled test).
  const delivered = (e: { status: string }) => e.status === 'sent' || e.status === 'simulated';
  const preSteps = new Set(['welcome', 'question', 'prework', 'essentials'].map((k) => LC2_STEP[k as Lc2Step]));
  const gotPre = new Set(emails.filter((e) => delivered(e) && preSteps.has(e.step % 10)).map((e) => e.lead_id));
  const group = (inside: boolean) => { const g = regs.filter((r) => gotPre.has(r.lead_id) === inside); const j = g.filter((r) => r.joined_at).length; return { n: g.length, joined: j, rate: g.length ? j / g.length : null }; };
  const modes: Record<string, number> = {};
  for (const r of regs) { const m = leadinPlan(ev.starts_at, r.created_at, t, r.tz || r.timezone || ev.tz).mode; modes[m] = (modes[m] ?? 0) + 1; }
  return {
    event: { id: ev.id, title: ev.title, startsAt: ev.starts_at, tz: ev.tz },
    toggles: t, dailyCap: dailyCap(rt), offerHours: ev.offer_hours ?? liveSettings(rt).offerHours,
    plans: modes, steps, compare: { got: group(true), didNot: group(false) },
    labels: LC2_LABEL,
  };
}

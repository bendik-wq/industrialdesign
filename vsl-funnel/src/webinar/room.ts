import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { getLead } from '../funnel/leads';
import { notifySlack } from '../integrations/notify';
import { isMillionPlus } from '../sales/qualify';
import { identityFromLead, track } from '../tracking/track';
import { answerQuestion } from './assistant';
import { experienceConfig } from './experience';
import { type Chapter, type Poll } from './content';
import { edition } from './editions';
import { type Registration, type Session, phase, webinarSettings } from './webinar';

/** Everything people do inside the masterclass room, beyond watching: polls, questions, calculator, worksheet, offer. */

const TEN_PLUS = new Set(['10m+', '10m-25m', '25m-50m', '50m-100m', '100m+']);

/** "0 Intro; 6 Where the deals are; …" from settings, else the defaults. */
export function chapters(rt: Runtime): Chapter[] {
  const raw = (rt.settings.WEBINAR_CHAPTERS ?? '').trim();
  if (!raw) return edition(rt.settings).chapters;
  const out = raw.split(/[;\n]+/).map((p) => /^\s*(\d{1,3})\s+(.{2,60})$/.exec(p)).filter(Boolean).map((m) => ({ at: Number(m![1]), title: m![2].trim() }));
  return out.length ? out.sort((a, b) => a.at - b.at) : edition(rt.settings).chapters;
}
export const polls = (rt: Runtime): Poll[] => edition(rt.settings).polls;
export const bonusAtMin = (rt: Runtime) => { const n = Number(rt.settings.WEBINAR_BONUS_AT); const w = webinarSettings(rt); return Number.isFinite(n) && n > 0 ? Math.min(n, w.durationMin) : Math.min(edition(rt.settings).bonusAtMin, w.durationMin); };
export const selfServeOn = (rt: Runtime) => /^(on|true|yes|1)$/i.test((rt.settings.WEBINAR_SELF_SERVE ?? '').trim());

async function log(rt: Runtime, reg: Registration, kind: string, o: { key?: string | null; value?: string | null; answer?: string | null; at?: number | null; replay?: boolean }) {
  const res = await rt.env.DB.prepare(
    `INSERT INTO webinar_interactions (id, reg_id, lead_id, session_id, kind, key, value, answer, at_sec, replay, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(newId('wi'), reg.id, reg.lead_id, reg.session_id, kind, o.key ?? null, o.value ?? null, o.answer ?? null, o.at == null ? null : Math.max(0, Math.round(o.at)), o.replay ? 1 : 0, Date.now()).run();
  return (res.meta.changes ?? 0) > 0;
}

const pos = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(6 * 3600, Number(v))) : null);

/** A poll answer (one per poll per registration). The pitch poll's "yes" is a hot-lead signal. */
export async function answerPoll(rt: Runtime, reg: Registration, body: { poll?: unknown; value?: unknown; pos?: unknown; replay?: unknown }) {
  const poll = polls(rt).find((p) => p.id === body.poll);
  const opt = poll?.options.find((o) => o.value === body.value);
  if (!poll || !opt) return { ok: false as const, error: 'Unknown answer' };
  const fresh = await log(rt, reg, 'poll', { key: poll.id, value: opt.value, at: pos(body.pos), replay: body.replay === true });
  // Real answers from everyone so far (shown once there are enough to mean something).
  const dist = await rt.env.DB.prepare("SELECT value, COUNT(*) AS n FROM webinar_interactions WHERE kind = 'poll' AND key = ? GROUP BY 1").bind(poll.id).all<{ value: string; n: number }>();
  const total = dist.results.reduce((a, r) => a + r.n, 0);
  const results = total >= 20 ? poll.options.map((o) => ({ value: o.value, label: o.label, share: (dist.results.find((r) => r.value === o.value)?.n ?? 0) / total })) : null;
  if (fresh) {
    await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_poll', source: 'server', props: { poll: poll.id, answer: opt.value }, localOnly: true });
    const lead = await getLead(rt.env, reg.lead_id);
    if (lead && isMillionPlus(lead.revenue_band) && /^yes/.test(opt.value) && poll.id === polls(rt)[polls(rt).length - 1]?.id) {
      rt.waitUntil(notifySlack(rt, lead, '🔥 Said yes to a call in the masterclass', [`Poll: ${poll.question} → ${opt.label}`], 'hot_lead'));
    }
  }
  return { ok: true as const, results, total };
}

/** A typed question: logged for the team, answered straight away by the assistant when there's an API key. */
export async function askQuestion(rt: Runtime, reg: Registration, body: { question?: unknown; pos?: unknown; replay?: unknown }) {
  const q = typeof body.question === 'string' ? body.question.replace(/\s+/g, ' ').trim().slice(0, 600) : '';
  if (q.length < 3) return { ok: false as const, error: 'Type your question first' };
  const asked = await rt.env.DB.prepare("SELECT COUNT(*) AS n FROM webinar_interactions WHERE reg_id = ? AND kind = 'question'").bind(reg.id).first<{ n: number }>();
  if ((asked?.n ?? 0) >= 8) return { ok: true as const, answer: null, note: 'Thanks. You’ve asked a lot today, so the team will pick up the rest by email.' };
  // Deal Room Pass holders: a fuller answer from the bigger model, and the question is flagged (key 'pass') in Funnel HQ.
  const priority = Boolean(await (await import('./pass')).activePass(rt, reg.lead_id));
  const answer = await answerQuestion(rt, q, { priority }).catch((e) => { console.error('webinar assistant failed', e); return null; });
  await log(rt, reg, 'question', { key: priority ? 'pass' : null, value: q, answer, at: pos(body.pos), replay: body.replay === true });
  await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'webinar_question', source: 'server', props: { answered: Boolean(answer), pass: priority }, localOnly: true });
  return { ok: true as const, answer, priority, note: answer ? null : 'Thanks. Josh’s team reads every question and will reply by email.' };
}

/** The in-room deal calculator: inputs rounded, kept for the sales team (what size deal they're thinking about). */
export async function logCalc(rt: Runtime, reg: Registration, body: { profit?: unknown; price?: unknown; pos?: unknown; replay?: unknown }) {
  const round = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n < 1e10 ? Math.round(n / 1000) * 1000 : null; };
  const profit = round(body.profit), price = round(body.price);
  if (!profit || !price) return { ok: false as const };
  await log(rt, reg, 'calc', { value: JSON.stringify({ profit, price }), at: pos(body.pos), replay: body.replay === true });
  return { ok: true as const };
}

/** Worksheet: available once the masterclass reaches the bonus minute (or in the replay). */
export function worksheetOpen(rt: Runtime, session: Session, reg: Registration, now = Date.now()) {
  const p = phase(rt, session, now, reg.replay_until);
  if (p === 'replay' || p === 'expired') return Boolean(reg.joined_at || reg.replay_at);
  return p === 'running' && now >= session.starts_at + bonusAtMin(rt) * 60_000;
}

export async function unlockBonus(rt: Runtime, reg: Registration, session: Session, body: { pos?: unknown; replay?: unknown }) {
  const w = webinarSettings(rt);
  const lead = await getLead(rt.env, reg.lead_id);
  // Owners under $1M get it at the pitch (their offer is the worksheet); everyone else near the end.
  const early = Boolean(lead?.revenue_band && !isMillionPlus(lead.revenue_band)) && (Date.now() >= session.starts_at + w.pitchAtMin * 60_000 || Number(body.pos) >= w.pitchAtMin * 60);
  if (!early && !worksheetOpen(rt, session, reg) && !(body.replay === true && Number(body.pos) >= bonusAtMin(rt) * 60)) return { ok: false as const };
  await log(rt, reg, 'bonus', { key: 'worksheet', at: pos(body.pos), replay: body.replay === true });
  return { ok: true as const };
}

/** Which offer button they pressed at the pitch (call / self-serve / under-$1M path). $10M+ pressing anything pings the team. */
export async function offerClick(rt: Runtime, reg: Registration, body: { choice?: unknown; pos?: unknown; replay?: unknown }) {
  const choice = ['call', 'self_serve', 'under', 'assessment', 'sprint'].includes(String(body.choice)) ? String(body.choice) : 'call';
  const fresh = await log(rt, reg, 'offer', { key: choice, at: pos(body.pos), replay: body.replay === true });
  if (fresh && choice !== 'under') {
    const lead = await getLead(rt.env, reg.lead_id);
    if (lead && TEN_PLUS.has(lead.revenue_band ?? '')) rt.waitUntil(notifySlack(rt, lead, '💰 $10M+ owner clicked the offer in the masterclass', [`Choice: ${choice === 'self_serve' ? 'start now (self-serve agreement)' : choice === 'assessment' || choice === 'sprint' ? 'start the First Deal Sprint (Stripe checkout)' : 'book a call'}`], 'hot_lead'));
  }
  return { ok: true as const };
}

/** The room's config: chapters, polls, bonus minute and which offer this person sees. */
export async function roomExtras(rt: Runtime, reg: Registration) {
  const lead = await getLead(rt.env, reg.lead_id);
  const band = (await rt.env.DB.prepare('SELECT revenue_band FROM webinar_registrations WHERE id = ?').bind(reg.id).first<{ revenue_band: string | null }>())?.revenue_band ?? lead?.revenue_band ?? null;
  const answered = await rt.env.DB.prepare("SELECT key FROM webinar_interactions WHERE reg_id = ? AND kind = 'poll'").bind(reg.id).all<{ key: string }>();
  const qualified = band ? isMillionPlus(band) : true; // not asked (older sign-ups): treat as qualified
  return {
    chapters: chapters(rt),
    polls: polls(rt).map((p) => ({ id: p.id, at: p.at, question: p.question, options: p.options })),
    answered: answered.results.map((r) => r.key),
    bonusAtSec: bonusAtMin(rt) * 60,
    calcAt: edition(rt.settings).calcAt,
    qualified,
    selfServe: qualified && selfServeOn(rt),
    applied: Boolean(lead?.app_completed_at),
    booked: Boolean(lead?.booked_at && !lead?.booking_cancelled_at),
    // The watch experience: deal builder, readiness score, key points, reactions, buy-in (experience.ts).
    experience: await experienceConfig(rt, reg, chapters(rt)).catch((e) => { console.error('watch experience config', e); return null; }),
  };
}

// ───────────── Self-serve start (no call) ─────────────

/**
 * "Start now without a call": an advisory agreement quoted from their revenue band (or their application),
 * signed for the company in the configured signer's name, then e-signed by them on the usual signing page,
 * which takes card payment after signing when a payment link is set. Off unless WEBINAR_SELF_SERVE=on.
 * One open agreement per lead: pressing it again returns the same signing link.
 */
export async function selfServeAgreement(rt: Runtime, reg: Registration) {
  const { autoQuote, company, createContract, signAndSend, signUrl, FEE_BY_REVENUE } = await import('../sales/contracts');
  const { APP_REVENUE_BAND } = await import('../sales/qualify');
  if (!selfServeOn(rt)) return { ok: false as const, error: 'Starting without a call isn’t open right now. Apply for a strategy call instead.' };
  const lead = await getLead(rt.env, reg.lead_id);
  if (!lead?.email) return { ok: false as const, error: 'We need your email first.' };
  if (!isMillionPlus(lead.revenue_band)) return { ok: false as const, error: 'The programme is for owners doing $1M+ a year.' };
  const open = await rt.env.DB.prepare("SELECT token FROM contracts WHERE lead_id = ? AND status IN ('sent', 'viewed') AND COALESCE(is_test, 0) = 0 ORDER BY created_at DESC LIMIT 1").bind(lead.id).first<{ token: string }>();
  if (open) return { ok: true as const, url: signUrl(rt, open.token) };
  const answer = Object.entries(APP_REVENUE_BAND).find(([, b]) => b === lead.revenue_band)?.[0];
  const q = autoQuote(rt, lead);
  const fee = Math.max(q.fee, (answer && FEE_BY_REVENUE[answer]) || 0);
  const draft = await createContract(rt, lead, { ...q, fee, client_company: null });
  if (!draft) return { ok: false as const, error: 'Couldn’t prepare the agreement. Apply for a call instead.' };
  const signer = company(rt).signer.split(',')[0].trim() || 'Josh Li';
  const sent = await signAndSend(rt, draft, { name: signer, kind: 'typed' }, null);
  await log(rt, reg, 'agreement', { key: 'self_serve', value: JSON.stringify({ contract: sent.id, fee }) });
  rt.waitUntil(notifySlack(rt, lead, '🧾 Started the programme from the masterclass (self-serve agreement sent)', [`Fee quoted: ${fee}`], 'hot_lead'));
  return { ok: true as const, url: signUrl(rt, sent.token) };
}

/** Thank-you page: a mobile for "it's starting" texts (with the consent the form shows). $1M+ only get the text sequence. */
export async function addPhone(rt: Runtime, reg: Registration, body: { phone?: unknown }, country: string | null) {
  const { normalisePhone, updateLead } = await import('../funnel/leads');
  const { startSms } = await import('../integrations/sms');
  const phone = typeof body.phone === 'string' ? normalisePhone(body.phone, country) : null;
  if (!phone) return { ok: false as const, error: 'Please enter a valid mobile number, including area code' };
  const lead = await getLead(rt.env, reg.lead_id);
  if (!lead) return { ok: false as const };
  const now = Date.now();
  await updateLead(rt.env, lead.id, { phone: lead.phone ?? phone, sms_consent_at: now, wa_consent_at: now });
  const fresh = (await getLead(rt.env, lead.id))!;
  if (!fresh.revenue_band || isMillionPlus(fresh.revenue_band)) await startSms(rt, fresh, 'webinar');
  return { ok: true as const };
}

/** Thank-you page: their answer to "which business would you most like to own?" and, optionally, a mobile for reminders. */
export async function thankYouAnswer(rt: Runtime, reg: Registration, body: { target?: unknown }) {
  const { THANK_YOU } = await import('./content');
  const opt = THANK_YOU.options.find((o) => o.value === body.target);
  if (!opt) return { ok: false as const };
  await rt.env.DB.prepare("DELETE FROM webinar_interactions WHERE reg_id = ? AND kind = 'commit'").bind(reg.id).run();
  await log(rt, reg, 'commit', { key: 'target', value: opt.value });
  return { ok: true as const };
}

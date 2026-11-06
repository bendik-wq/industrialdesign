import type { Runtime } from '../app';
import type { Settings } from '../settings';
import type { VisitorCtx } from '../lib/identity';
import { newId, newRefCode } from '../lib/ids';
import { type Lead, cleanName, getLead, getLeadByEmail, linkVisitor, normalisePhone, updateLead, validateEmail } from '../funnel/leads';
import { ApplicationError, attributionFor, verifyTurnstile } from '../funnel/application';
import { identityFromLead, identityFromVisitor, track } from '../tracking/track';
import { trackRevenueEvents } from '../tracking/revenue-events';
import { ARCHETYPES, GAPS, type GapId, QUESTIONS, QUESTION_IDS, QUIZ_COPY, type QuestionId, type ArchetypeId } from './content';
import { type Answers, cleanAnswers, missingAnswers, scoreQuiz, validAnswer } from './scoring';

/**
 * The quiz's server side: a row per quiz started (quiz_responses), each answer saved as it is given (drop-off per
 * step), the email gate that creates or matches the lead with the two unticked consent boxes captured exactly as the
 * live funnel does (captureConsent, with proof), the result, and the one-click seat for the masterclass or the next
 * live event (QUIZ_TARGET). Every step is a first-party event through track(), so Meta CAPI, GA4 and PostHog get
 * them like the other funnels' events.
 */

export interface QuizRow {
  id: string; token: string; visitor_id: string | null; session_id: string | null; lead_id: string | null; first_name: string | null;
  answers: string; step_reached: number; score: number | null; archetype: ArchetypeId | null; gaps: string | null; revenue_band: string | null;
  target: string | null; reg_id: string | null; started_at: number; completed_at: number | null; gate_viewed_at: number | null; lead_at: number | null;
  result_viewed_at: number | null; registered_at: number | null; channel: string | null; utm_source: string | null; utm_campaign: string | null;
  utm_content: string | null; device: string | null; is_bot: number; updated_at: number;
}

export type QuizTarget = 'webinar' | 'live';
/** QUIZ_TARGET: webinar (the automated masterclass, default) or live (the next live event). */
export const quizTarget = (s: Partial<Pick<Settings, 'QUIZ_TARGET'>>): QuizTarget => ((s.QUIZ_TARGET ?? '').trim().toLowerCase() === 'live' ? 'live' : 'webinar');

/** Industry labels written to leads.industry (only when the lead has none). */
const INDUSTRY_LABEL = Object.fromEntries(QUESTIONS.find((q) => q.id === 'industry')!.options.map((o) => [o.value, o.label]));

const quizToken = () => Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);
const TOKEN_RE = /^[a-z0-9]{16,40}$/;
const PATH = '/quiz';
/** A quiz is answered in one sitting: after this long its row no longer takes answers (start again). */
export const QUIZ_TTL_MS = 7 * 86_400_000;
/** New leads per connection per hour from the gate (each one can send an email). */
export const LEADS_PER_IP_HOUR = 8;
/** Result emails per lead per hour, so the gate can't be used to flood someone's inbox. */
export const RESULT_EMAILS_PER_HOUR = 3;

export const parseAnswersJson = (row: Pick<QuizRow, 'answers'>): Answers => { try { return cleanAnswers(JSON.parse(row.answers || '{}')); } catch { return {}; } };
export const parseGaps = (row: Pick<QuizRow, 'gaps'>): GapId[] => { try { const g = JSON.parse(row.gaps || '[]') as unknown; return Array.isArray(g) ? g.filter((x): x is GapId => typeof x === 'string' && x in GAPS) : []; } catch { return []; } };

export async function getQuiz(rt: Pick<Runtime, 'env'>, token: string) {
  if (!TOKEN_RE.test(token)) return null;
  return rt.env.DB.prepare('SELECT * FROM quiz_responses WHERE token = ?').bind(token).first<QuizRow>();
}

const who = (v: VisitorCtx, leadId?: string | null) => identityFromVisitor(v, null, leadId ?? v.leadId);

/** POST /api/quiz/start: a new row, attributed like the other funnels (last non-direct touch). */
export async function startQuiz(rt: Runtime, v: VisitorCtx, body: Record<string, unknown> = {}) {
  const now = Date.now();
  const { last } = await attributionFor(rt, v);
  const row = { id: newId('qz'), token: quizToken() };
  await rt.env.DB.prepare(
    `INSERT INTO quiz_responses (id, token, visitor_id, session_id, lead_id, started_at, channel, utm_source, utm_campaign, utm_content, device, is_bot, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(row.id, row.token, v.visitorId, v.sessionId, v.leadId, now, last?.channel ?? 'Direct', last?.utm_source ?? null, last?.utm_campaign ?? null, last?.utm_content ?? null,
    v.ua?.device ?? null, v.isBot ? 1 : 0, now).run();
  await track(rt, who(v), { name: 'quiz_start', source: 'server', path: PATH, props: { quiz_id: row.id }, eventId: typeof body.event_id === 'string' ? body.event_id : undefined });
  return { token: row.token };
}

async function openRow(rt: Runtime, token: unknown) {
  const row = typeof token === 'string' ? await getQuiz(rt, token) : null;
  if (!row || Date.now() - row.started_at > QUIZ_TTL_MS) throw new ApplicationError(QUIZ_COPY.errors.expired, 'token', 404);
  return row;
}

/** POST /api/quiz/answer: one answer, saved as it is given (so drop-off per step is real). */
export async function saveQuizAnswer(rt: Runtime, v: VisitorCtx, body: Record<string, unknown>) {
  const row = await openRow(rt, body.token);
  const q = String(body.question ?? '') as QuestionId;
  const value = validAnswer(q, body.value);
  const idx = QUESTION_IDS.indexOf(q);
  if (idx < 0 || !value) throw new ApplicationError('Pick one of the answers', 'value');
  const answers = { ...parseAnswersJson(row), [q]: value };
  const step = Math.max(row.step_reached, idx + 1);
  const complete = missingAnswers(answers).length === 0;
  const now = Date.now();
  await rt.env.DB.prepare('UPDATE quiz_responses SET answers = ?, step_reached = ?, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(answers), step, complete ? now : null, now, row.id).run();
  await track(rt, who(v, row.lead_id), { name: 'quiz_answer', source: 'server', path: PATH, props: { quiz_id: row.id, step: idx + 1, question: q, value } });
  return { step, complete };
}

/** POST /api/quiz/gate: the email gate was shown (once per quiz). */
export async function quizGateView(rt: Runtime, v: VisitorCtx, body: Record<string, unknown>) {
  const row = await openRow(rt, body.token);
  const res = await rt.env.DB.prepare('UPDATE quiz_responses SET gate_viewed_at = ?, updated_at = ? WHERE id = ? AND gate_viewed_at IS NULL').bind(Date.now(), Date.now(), row.id).run();
  if ((res.meta.changes ?? 0) > 0) await track(rt, who(v, row.lead_id), { name: 'quiz_gate_view', source: 'server', path: PATH, props: { quiz_id: row.id, step: row.step_reached } });
  return { ok: true };
}

async function ipLimited(rt: Runtime, v: VisitorCtx) {
  const { overLimit } = await import('../lib/ratelimit');
  return overLimit(rt.env, `quiz-newlead:${v.ip ?? 'unknown'}`, LEADS_PER_IP_HOUR);
}

/**
 * POST /api/quiz/lead: the email gate. Creates the lead (or matches it by email without changing its details:
 * anyone can type anyone's address), records the two optional consent boxes with proof, scores the answers, tags
 * the lead with its archetype and gaps, and sends the result email. Only a lead the gate created is linked to this browser.
 */
export async function submitQuizLead(rt: Runtime, v: VisitorCtx, body: Record<string, unknown>) {
  const row = await openRow(rt, body.token);
  const answers = { ...parseAnswersJson(row), ...cleanAnswers(body.answers) };
  if (missingAnswers(answers).length) throw new ApplicationError(QUIZ_COPY.errors.answers, 'answers');
  const firstName = cleanName(body.first_name);
  const emailCheck = validateEmail(body.email);
  if (!firstName) throw new ApplicationError(QUIZ_COPY.errors.first_name, 'first_name');
  if (!emailCheck) throw new ApplicationError(QUIZ_COPY.errors.email, 'email');
  if (emailCheck.disposable) throw new ApplicationError(QUIZ_COPY.errors.disposable, 'email');
  const phoneTyped = typeof body.phone === 'string' && body.phone.trim() !== '';
  const phone = phoneTyped ? normalisePhone(body.phone, v.geo.country) : null;
  if (phoneTyped && !phone) throw new ApplicationError(QUIZ_COPY.errors.phone, 'phone');
  if (!(await verifyTurnstile(rt, body.turnstile, v, 'quiz'))) throw new ApplicationError((await import('../infra/turnstile')).TURNSTILE_COPY.failed, 'turnstile', 403);
  if (!row.lead_at && (await ipLimited(rt, v))) throw new ApplicationError(QUIZ_COPY.errors.rate, undefined, 429);

  const result = scoreQuiz(answers);
  const now = Date.now();
  let lead = await getLeadByEmail(rt.env, emailCheck.email);
  let newLead = false;
  if (!lead) {
    const { last, first } = await attributionFor(rt, v);
    const id = newId('l');
    await rt.env.DB.prepare(
      `INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, session_id, first_name, email, phone, whatsapp_opt_in, step_reached, status,
         channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term, click_id, click_type, ft_channel, ft_source, ft_campaign, ft_content,
         landing_path, variant, country, city, device, fbp, fbc, timezone, revenue_band, industry)
       VALUES (?,?,?,?,?,?,?,?,?,0,0,'partial',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, newRefCode(), now, now, v.visitorId, v.sessionId, firstName, emailCheck.email, phone,
      last?.channel ?? 'Direct', last?.utm_source ?? null, last?.utm_medium ?? null, last?.utm_campaign ?? null, last?.utm_content ?? null, last?.utm_term ?? null,
      last?.click_id ?? null, last?.click_type ?? null, first?.ft_channel ?? null, first?.ft_source ?? null, first?.ft_campaign ?? null, first?.ft_content ?? null,
      last?.landing_path ?? PATH, v.variant, v.geo.country, v.geo.city, v.ua?.device ?? null, v.fbp, v.fbc, v.geo.timezone, result.band, INDUSTRY_LABEL[answers.industry ?? ''] ?? null,
    ).run();
    lead = (await getLead(rt.env, id))!;
    newLead = true;
    await linkVisitor(rt.env, v.visitorId, lead.id);
  }
  // Their own answers fill empty fields only: an application answer already on file wins.
  const bandIsNew = !newLead && !lead.revenue_band;
  const fill: Partial<Record<keyof Lead, string | null>> = {};
  if (bandIsNew) fill.revenue_band = result.band;
  if (!lead.industry && answers.industry) fill.industry = INDUSTRY_LABEL[answers.industry] ?? null;
  if (Object.keys(fill).length) await updateLead(rt.env, lead.id, fill);

  // The two optional boxes (calls, texts), recorded with proof for this number, as on every other form.
  const { captureConsent } = await import('../integrations/consent-gate');
  await captureConsent(rt, lead.id, body, { phone, source: 'quiz', page: PATH, ip: v.ip, userAgent: v.userAgent }, now);

  await rt.env.DB.prepare(
    `UPDATE quiz_responses SET lead_id = ?, first_name = ?, answers = ?, step_reached = ?, score = ?, archetype = ?, gaps = ?, revenue_band = ?,
       completed_at = COALESCE(completed_at, ?), lead_at = COALESCE(lead_at, ?), updated_at = ? WHERE id = ?`,
  ).bind(lead.id, firstName, JSON.stringify(answers), QUESTIONS.length, result.score, result.archetype, JSON.stringify(result.gaps), result.band, now, now, now, row.id).run();
  await tagLead(rt, lead.id, result.archetype, result.gaps, now);

  const id = newLead ? identityFromVisitor(v, null, lead.id) : await identityFromLead(rt.env, lead.id);
  await track(rt, id, {
    name: 'quiz_lead', source: 'server', path: PATH,
    props: { quiz_id: row.id, archetype: result.archetype, score: result.score, band: result.band, gaps: result.gaps.join(','), new_lead: newLead },
    eventId: typeof body.event_id === 'string' ? body.event_id : undefined,
  });
  if (newLead || bandIsNew) await trackRevenueEvents(rt, id, result.band, 'webinar', PATH);
  rt.waitUntil(sendResultEmail(rt, (await getLead(rt.env, lead.id))!, row.token, result.archetype, result.score).then(() => undefined));
  return { token: row.token, next: `${PATH}/r/${row.token}`, archetype: result.archetype, score: result.score };
}

/** Segment tags: quiz:<archetype> and quiz:gap:<gap>, replacing the lead's earlier quiz tags. */
export async function tagLead(rt: Pick<Runtime, 'env'>, leadId: string, archetype: ArchetypeId, gaps: GapId[], now = Date.now()) {
  const db = rt.env.DB;
  await db.batch([
    db.prepare("DELETE FROM lead_tags WHERE lead_id = ? AND source = 'quiz'").bind(leadId),
    ...[`quiz:${archetype}`, ...gaps.map((g) => `quiz:gap:${g}`)].map((tag) => db.prepare("INSERT OR IGNORE INTO lead_tags (lead_id, tag, source, created_at) VALUES (?, ?, 'quiz', ?)").bind(leadId, tag, now)),
  ]);
}

/** The lead's quiz archetype (the latest), for email segmentation and Funnel HQ. */
export async function quizSegment(rt: Pick<Runtime, 'env'>, leadId: string) {
  const r = await rt.env.DB.prepare("SELECT tag FROM lead_tags WHERE lead_id = ? AND source = 'quiz' AND tag NOT LIKE 'quiz:gap:%' LIMIT 1").bind(leadId).first<{ tag: string }>();
  return r ? (r.tag.slice(5) as ArchetypeId) : null;
}

/** The result by email: the link back to the result page (once per quiz, at most a few an hour per lead). */
export async function sendResultEmail(rt: Runtime, lead: Lead, token: string, archetype: ArchetypeId, score: number) {
  if (!lead.email || lead.unsubscribed_at) return false;
  const recent = await rt.env.DB.prepare("SELECT COUNT(*) AS n FROM emails WHERE lead_id = ? AND template = 'quiz_result' AND created_at > ?").bind(lead.id, Date.now() - 3_600_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= RESULT_EMAILS_PER_HOUR) return false;
  const { sendOnce } = await import('../live/mail');
  const { safeFirstName } = await import('../lib/text');
  const a = ARCHETYPES[archetype];
  const step = 400_000_000 + (Math.floor(Date.now() / 1000) % 1_000_000_000);
  return sendOnce(rt, lead, 'quiz', step, 'quiz_result', resultEmail(safeFirstName(lead.first_name) ?? 'there', a.name, a.line, score, `${rt.origin}${PATH}/r/${token}`), { unsubscribe: true });
}

/** The result email's words (checked by auditEmail in the tests). */
export function resultEmail(name: string, archetypeName: string, line: string, score: number, href: string) {
  return {
    subject: `Your acquisition readiness: ${archetypeName}`,
    preheader: `A readiness score of ${score} out of 100, and the two gaps to close first.`,
    heading: archetypeName,
    paras: [`Hi ${name},`, `Your readiness score is ${score} out of 100. ${line}`, 'Your result page has the two gaps to close first and the 1.5x test on numbers like yours. If you didn’t take the quiz, ignore this email.'],
    button: { label: 'See my result', href },
  };
}

/** GET /quiz/r/:token: the first view is the quiz_result event. */
export async function markResultViewed(rt: Runtime, v: VisitorCtx, row: QuizRow) {
  const res = await rt.env.DB.prepare('UPDATE quiz_responses SET result_viewed_at = ?, updated_at = ? WHERE id = ? AND result_viewed_at IS NULL').bind(Date.now(), Date.now(), row.id).run();
  if ((res.meta.changes ?? 0) > 0) await track(rt, who(v, row.lead_id), { name: 'quiz_result', source: 'server', path: PATH, props: { quiz_id: row.id, archetype: row.archetype, score: row.score } });
}

/** The answers the masterclass room reads: "which business would you most like to own?" from what they want next. */
const COMMIT: Record<string, string> = { competitor: 'competitor', group: 'competitor', supply: 'supplier', unsure: 'none_yet' };

/**
 * POST /api/quiz/register: "Save my seat". One click: the name and email come from the gate. QUIZ_TARGET picks the
 * automated masterclass (register, the chosen showing) or the next live event (registerLive). The quiz answers go
 * with it: the revenue band on the registration (the room's "Your deal" panel reads it) and, for the masterclass,
 * the thank-you page's "which business would you most like to own?" answer.
 */
export async function registerFromQuiz(rt: Runtime, v: VisitorCtx, body: Record<string, unknown>): Promise<{ next: string; target: QuizTarget; created: boolean }> {
  const row = await openRow(rt, body.token);
  if (!row.lead_id) throw new ApplicationError(QUIZ_COPY.errors.expired, 'token', 409);
  const lead = await getLead(rt.env, row.lead_id);
  if (!lead?.email) throw new ApplicationError(QUIZ_COPY.errors.expired, 'token', 409);
  const answers = parseAnswersJson(row);
  const target = quizTarget(rt.settings);
  const base = { first_name: lead.first_name || row.first_name, email: lead.email, revenue: answers.revenue ?? '', pixel_eid: body.pixel_eid };
  const now = Date.now();
  let next: string;
  let regId: string;
  let created: boolean;
  if (target === 'live') {
    const { registerLive, liveRoomUrl, ticketGate, startLiveTicket } = await import('../live/events');
    const r = await registerLive(rt, v, { ...base, event_id: typeof body.event_id === 'string' ? body.event_id : '', event_id_track: body.track_id }, { verified: true });
    regId = r.reg.id;
    created = r.created;
    next = `${liveRoomUrl(rt, r.reg.token)}?new=1`;
    if (await ticketGate(rt, r.reg)) { const t = await startLiveTicket(rt, r.reg); if (t.url) next = t.url; }
  } else {
    const { register, registrationNext } = await import('../webinar/webinar');
    const r = await register(rt, v, { ...base, session_id: typeof body.session_id === 'string' ? body.session_id : '', event_id: body.track_id }, { verified: true });
    regId = r.registration.id;
    created = r.created;
    const commit = COMMIT[answers.goal ?? ''];
    if (commit && created) await (await import('../webinar/room')).thankYouAnswer(rt, r.registration, { target: commit });
    next = await registrationNext(rt, r.registration, r.created);
  }
  await rt.env.DB.prepare('UPDATE quiz_responses SET registered_at = COALESCE(registered_at, ?), target = ?, reg_id = ?, updated_at = ? WHERE id = ?').bind(now, target, regId, now, row.id).run();
  if (!row.registered_at) await track(rt, who(v, lead.id), { name: 'quiz_register', source: 'server', path: PATH, props: { quiz_id: row.id, target, archetype: row.archetype, score: row.score } });
  return { next, target, created };
}

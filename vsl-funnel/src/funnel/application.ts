import type { Runtime } from '../app';
import { APPLICATION, type Route, type Tier } from '../config';
import { newId, newRefCode } from '../lib/ids';
import type { VisitorCtx } from '../lib/identity';
import { cancelSequence, enqueueSequence } from '../integrations/email';
import { notifySlack } from '../integrations/notify';
import { identityFromVisitor, track } from '../tracking/track';
import { type Lead, cleanName, getLead, getLeadByEmail, linkVisitor, normalisePhone, parseAnswers, updateLead, validateEmail } from './leads';
import { routeLead } from './routing';
import { normaliseAnswer, parseBlocklist, scoreApplication } from './scoring';

export class ApplicationError extends Error {
  constructor(message: string, readonly field?: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message);
  }
}

const SEQUENCE_FOR_TIER = { A: 'tier_a', B: 'tier_b', C: 'tier_c' } as const;

/** Cloudflare Turnstile (invisible) — only enforced when a secret key is connected. */
export async function verifyTurnstile(rt: Runtime, token: unknown, ip: string | null) {
  if (!rt.settings.TURNSTILE_SECRET_KEY) return true;
  if (typeof token !== 'string' || !token) return false;
  const form = new FormData();
  form.append('secret', rt.settings.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean };
  return Boolean(data.success);
}

interface AttributionRow {
  channel: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  click_id: string | null;
  click_type: string | null;
  landing_path: string | null;
}

/** Last non-direct touch (GA-style), falling back to the current session. */
async function attributionFor(rt: Runtime, v: VisitorCtx) {
  const db = rt.env.DB;
  const cols = 'channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term, click_id, click_type, landing_path';
  const [lastNonDirect, current, visitor] = await Promise.all([
    db.prepare(`SELECT ${cols} FROM sessions WHERE visitor_id = ? AND channel != 'Direct' ORDER BY started_at DESC LIMIT 1`).bind(v.visitorId).first<AttributionRow>(),
    db.prepare(`SELECT ${cols} FROM sessions WHERE id = ?`).bind(v.sessionId).first<AttributionRow>(),
    db.prepare('SELECT ft_channel, ft_source, ft_campaign, ft_content FROM visitors WHERE id = ?').bind(v.visitorId).first<{ ft_channel: string | null; ft_source: string | null; ft_campaign: string | null; ft_content: string | null }>(),
  ]);
  return { last: lastNonDirect ?? current, first: visitor };
}

/**
 * Step 1: contact details. Creates (or re-opens) the lead immediately so an
 * abandoned application can still be followed up, and starts the
 * abandoned-application sequence (cancelled automatically on submit).
 */
export async function saveContact(rt: Runtime, v: VisitorCtx, body: Record<string, unknown>) {
  const firstName = cleanName(body.first_name);
  const lastName = cleanName(body.last_name);
  const emailCheck = validateEmail(body.email);
  const phone = normalisePhone(body.phone, v.geo.country);
  if (!firstName) throw new ApplicationError('Please enter your first name', 'first_name');
  if (!emailCheck) throw new ApplicationError('Please enter a valid email address', 'email');
  if (emailCheck.disposable) throw new ApplicationError('Please use your real email address — we’ll send your results there', 'email');
  if (!phone) throw new ApplicationError('Please enter a valid mobile number, including area code', 'phone');
  if (!(await verifyTurnstile(rt, body.turnstile, v.ip))) throw new ApplicationError('Security check failed — please refresh and try again', undefined, 403);

  const now = Date.now();
  const existing = (await getLeadByEmail(rt.env, emailCheck.email)) ?? (v.leadId ? await getLead(rt.env, v.leadId) : null);
  let lead: Lead;
  let isNew = false;

  if (existing && (!existing.email || existing.email === emailCheck.email)) {
    await updateLead(rt.env, existing.id, {
      first_name: firstName,
      last_name: lastName ?? existing.last_name,
      email: emailCheck.email,
      phone,
      app_started_at: existing.app_started_at ?? now,
      step_reached: Math.max(existing.step_reached, 1),
      unsubscribed_at: null,
    });
    lead = (await getLead(rt.env, existing.id))!;
  } else {
    const { last, first } = await attributionFor(rt, v);
    const id = newId('l');
    isNew = true;
    await rt.env.DB.prepare(
      `INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, session_id, first_name, last_name, email, phone, whatsapp_opt_in,
         step_reached, app_started_at, status, channel, utm_source, utm_medium, utm_campaign, utm_content, utm_term, click_id, click_type,
         ft_channel, ft_source, ft_campaign, ft_content, landing_path, variant, country, city, device, fbp, fbc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?, 'partial', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        id, newRefCode(), now, now, v.visitorId, v.sessionId, firstName, lastName, emailCheck.email, phone, 0, now,
        last?.channel ?? 'Direct', last?.utm_source ?? null, last?.utm_medium ?? null, last?.utm_campaign ?? null,
        last?.utm_content ?? null, last?.utm_term ?? null, last?.click_id ?? null, last?.click_type ?? null,
        first?.ft_channel ?? null, first?.ft_source ?? null, first?.ft_campaign ?? null, first?.ft_content ?? null,
        last?.landing_path ?? null, v.variant, v.geo.country, v.geo.city, v.ua.device, v.fbp, v.fbc,
      )
      .run();
    lead = (await getLead(rt.env, id))!;
  }

  await linkVisitor(rt.env, v.visitorId, lead.id);
  const who = identityFromVisitor(v, null, lead.id);
  const eventId = isNew ? await track(rt, who, { name: 'lead_captured', source: 'server', path: '/apply', eventId: body.event_id as string | undefined }) : null;
  await track(rt, who, { name: 'app_step_saved', source: 'server', path: '/apply', props: { step: 1, question: 'contact' } });
  if (!lead.app_completed_at) await enqueueSequence(rt, lead, 'abandoned');

  return { lead, eventId, isNew };
}

/** Steps 2..n: one answer per call, validated against the question config. */
export async function saveAnswer(rt: Runtime, v: VisitorCtx, lead: Lead, questionId: unknown, value: unknown) {
  const index = APPLICATION.findIndex((q) => q.id === questionId);
  const q = APPLICATION[index];
  if (!q || q.type === 'contact') throw new ApplicationError('Unknown question');
  const answer = normaliseAnswer(q, value);
  if (answer === null) throw new ApplicationError(q.type === 'text' ? `Please write at least ${q.minLength} characters` : 'Please choose an option', q.id);

  const answers = { ...parseAnswers(lead), [q.id]: answer };
  const step = index + 1;
  await updateLead(rt.env, lead.id, { answers: JSON.stringify(answers), step_reached: Math.max(lead.step_reached, step) });
  await track(rt, identityFromVisitor(v, null, lead.id), { name: 'app_step_saved', source: 'server', path: '/apply', props: { step, question: q.id } });
  return { step, answers };
}

export interface SubmitResult {
  tier: Tier;
  route: Route;
  score: number;
  events: { submitted: string; qualified: string };
}

/**
 * Final submit: score → tier → route/closer, then kick off the right follow-up
 * (sequence, Slack alert for hot leads).
 */
export async function submitApplication(rt: Runtime, v: VisitorCtx, lead: Lead, clientEventId?: string): Promise<SubmitResult> {
  const answers = parseAnswers(lead);
  const missing = APPLICATION.find((q) => q.type !== 'contact' && answers[q.id] === undefined);
  if (missing) throw new ApplicationError('Please answer every question', missing.id);

  const result = scoreApplication(answers, { country: lead.country ?? v.geo.country, email: lead.email, phone: lead.phone, blocklist: parseBlocklist(rt.settings.BLOCKLIST) });
  const decision = await routeLead(rt, result.tier);
  const now = Date.now();
  const firstSubmit = !lead.app_completed_at;
  const keepStatus = ['booked', 'showed', 'won', 'lost'].includes(lead.status);

  await updateLead(rt.env, lead.id, {
    score: result.score,
    tier: result.tier,
    score_breakdown: JSON.stringify({ breakdown: result.breakdown, flags: result.flags, caps: result.caps, scoreTier: result.scoreTier }),
    route: decision.route,
    closer_id: decision.closer?.id ?? null,
    app_completed_at: lead.app_completed_at ?? now,
    step_reached: APPLICATION.length,
    status: keepStatus ? lead.status : result.tier === 'C' ? 'nurture' : 'applied',
  });
  const fresh = (await getLead(rt.env, lead.id))!;

  const who = identityFromVisitor(v, null, lead.id);
  const submitted = await track(rt, who, { name: 'app_submitted', source: 'server', path: '/apply', eventId: clientEventId, props: { score: result.score, tier: result.tier } });
  const qualified = await track(rt, who, { name: 'lead_qualified', source: 'server', path: '/apply', props: { tier: result.tier, score: result.score, flags: result.flags, caps: result.caps } });
  await track(rt, who, { name: 'lead_routed', source: 'server', path: '/apply', props: { route: decision.route, closer: decision.closer?.id ?? null } });

  await cancelSequence(rt, lead.id, 'abandoned');
  if (firstSubmit && !fresh.booked_at) await enqueueSequence(rt, fresh, SEQUENCE_FOR_TIER[result.tier]);
  if (firstSubmit && result.tier !== 'C') {
    const rep = decision.closer ? ` → ${decision.closer.name}` : '';
    rt.waitUntil(notifySlack(rt, fresh, result.tier === 'A' ? `🔥 Hot lead (A-tier)${rep}` : `✅ Qualified lead (B-tier)${rep}`, result.caps.length ? [`Caps: ${result.caps.join(', ')}`] : [], result.tier === 'A' ? 'hot_lead' : 'qualified_lead'));
  }

  return { tier: result.tier, route: decision.route, score: result.score, events: { submitted, qualified } };
}

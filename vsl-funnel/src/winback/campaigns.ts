import type { Runtime } from '../app';
import { BRAND } from '../config';
import { auditEmail } from '../content/copy-rules';
import { type Lead, getLead } from '../funnel/leads';
import { emailConfigured, sendViaResend, signEmailLink, unsubscribeSig, usedFacts, zonedTime } from '../integrations/email';
import { type EmailContent, renderEmail } from '../integrations/templates';
import { newId } from '../lib/ids';
import { getAction, isAuto, logAction, proposeAction, registerActionHandler, rejectAction } from '../ops/actions';
import { personalizeEmail, personalizeMode } from '../personalize/personalize';
import { buildProfile } from '../personalize/profile';
import { guarantee } from '../sales/guarantee';
import { type Destination, DESTINATIONS, type Rules, type Segment, SEGMENTS, buildAudience, cleanRules, exclusion, lastActive, leadRow } from './audience';
import { copyCtx, planFor, winbackEmail, MAX_STEPS, MIN_STEPS, TEMPLATE_NAMES } from './copy';
import { type Dest, destinationLink, resolveDestination } from './destination';

/**
 * Win-back campaigns: Draft → Preview → Send test → Start (a proposal in Command, kind sales.winback_start,
 * risk high; only the owner's approval starts it) → Pause / Resume → Stop.
 *
 * Nothing is sent unless the campaign is running AND its start was approved by the owner (you or Slack, never an
 * automatic approval). The 5-minute cron (processWinback) sends inside the campaign's window in SALES_TIMEZONE, at
 * most daily_cap emails a day, and stops a person's sequence the moment they register, buy, book, apply or reply.
 */

export const START_KIND = 'sales.winback_start';
export type Status = 'draft' | 'proposed' | 'running' | 'paused' | 'stopped' | 'done';
const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
const MAX_PER_TICK = 25;

export interface Campaign {
  id: string; name: string; status: Status; rules: string; destination: Destination; dest_ref: string | null; steps: number; gap_days: number; daily_cap: number;
  window_from: number; window_to: number; test_to: string | null; test_sent_at: number | null; action_id: string | null; proposed_at: number | null;
  approved_at: number | null; approved_by: string | null; started_at: number | null; paused_at: number | null; stopped_at: number | null;
  ended_reason: string | null; held_reason: string | null; created_at: number; updated_at: number;
}
export interface Enrollment {
  campaign_id: string; lead_id: string; segment: Segment; last_active_at: number | null; status: 'active' | 'stopped' | 'done'; stop_reason: string | null;
  next_step: number; next_at: number | null; first_sent_at: number | null; last_sent_at: number | null; enrolled_at: number; stopped_at: number | null;
}

export class WinbackError extends Error { constructor(message: string, public status = 400) { super(message); } }

const tzOf = (rt: Runtime) => rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
const int = (v: unknown, d: number, lo: number, hi: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const plainText = (h: string) => h.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
export const rulesOf = (c: Pick<Campaign, 'rules'>): Rules => { try { return cleanRules(JSON.parse(c.rules)); } catch { return cleanRules({}); } };

// ───────────── time ─────────────

function localParts(t: number, tz: string) {
  const fmt = (zone: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(t);
  let p: Intl.DateTimeFormatPart[];
  try { p = fmt(tz); } catch { p = fmt('UTC'); }
  const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour') };
}
export const inWindow = (t: number, tz: string, from: number, to: number) => { const h = localParts(t, tz).h; return h >= from && h < to; };
export function startOfDay(t: number, tz: string) { const p = localParts(t, tz); try { return zonedTime(p.y, p.m, p.d, 0, tz); } catch { return zonedTime(p.y, p.m, p.d, 0, 'UTC'); } }

// ───────────── campaigns ─────────────

export const getCampaign = (rt: Runtime, id: string) => rt.env.DB.prepare('SELECT * FROM winback_campaigns WHERE id = ?').bind(id).first<Campaign>();

/** Fields a draft may change. */
function cleanFields(body: Record<string, unknown>, cur?: Campaign) {
  const name = typeof body.name === 'string' ? body.name.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) : cur?.name ?? '';
  const destination = DESTINATIONS.includes(body.destination as Destination) ? (body.destination as Destination) : cur?.destination ?? 'masterclass';
  const ref = body.dest_ref !== undefined ? (typeof body.dest_ref === 'string' && /^[\w-]{1,64}$/.test(body.dest_ref) ? body.dest_ref : null) : cur?.dest_ref ?? null;
  const from = int(body.window_from, cur?.window_from ?? 9, 0, 23);
  const to = int(body.window_to, cur?.window_to ?? 17, 1, 24);
  if (to <= from) throw new WinbackError('The sending window must end after it starts.');
  return {
    name: name || 'Win-back campaign',
    rules: JSON.stringify(cleanRules(body.rules !== undefined ? body.rules : cur ? rulesOf(cur) : {})),
    destination,
    dest_ref: destination === 'masterclass' ? null : ref,
    steps: int(body.steps, cur?.steps ?? 5, MIN_STEPS, MAX_STEPS),
    gap_days: int(body.gap_days, cur?.gap_days ?? 3, 1, 14),
    daily_cap: int(body.daily_cap, cur?.daily_cap ?? 40, 1, 500),
    window_from: from, window_to: to,
  };
}

export async function createCampaign(rt: Runtime, body: Record<string, unknown>, now = Date.now()) {
  const f = cleanFields(body);
  const id = newId('wb');
  await rt.env.DB.prepare(`INSERT INTO winback_campaigns (id, name, status, rules, destination, dest_ref, steps, gap_days, daily_cap, window_from, window_to, created_at, updated_at)
    VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, f.name, f.rules, f.destination, f.dest_ref, f.steps, f.gap_days, f.daily_cap, f.window_from, f.window_to, now, now).run();
  return (await getCampaign(rt, id))!;
}

export async function updateCampaign(rt: Runtime, id: string, body: Record<string, unknown>, now = Date.now()) {
  const cur = await syncStatus(rt, await getCampaign(rt, id));
  if (!cur) throw new WinbackError('Campaign not found.', 404);
  if (cur.status !== 'draft') throw new WinbackError('Only a draft can be edited. Stop this campaign and copy it to change it.', 409);
  const f = cleanFields(body, cur);
  // A changed campaign needs a fresh test before it can start.
  const changed = f.rules !== cur.rules || f.destination !== cur.destination || f.dest_ref !== cur.dest_ref || f.steps !== cur.steps;
  await rt.env.DB.prepare(`UPDATE winback_campaigns SET name = ?, rules = ?, destination = ?, dest_ref = ?, steps = ?, gap_days = ?, daily_cap = ?, window_from = ?, window_to = ?,
    test_sent_at = CASE WHEN ? THEN NULL ELSE test_sent_at END, updated_at = ? WHERE id = ?`)
    .bind(f.name, f.rules, f.destination, f.dest_ref, f.steps, f.gap_days, f.daily_cap, f.window_from, f.window_to, changed ? 1 : 0, now, id).run();
  return (await getCampaign(rt, id))!;
}

export async function deleteCampaign(rt: Runtime, id: string) {
  const r = await rt.env.DB.prepare("DELETE FROM winback_campaigns WHERE id = ? AND status = 'draft'").bind(id).run();
  if (!r.meta.changes) throw new WinbackError('Only a draft can be deleted.', 409);
}

/** A proposal the owner rejected (or that failed) puts the campaign back to draft. */
async function syncStatus(rt: Runtime, c: Campaign | null) {
  if (!c || c.status !== 'proposed' || !c.action_id) return c;
  const a = await getAction(rt, c.action_id);
  if (a && (a.status === 'rejected' || a.status === 'failed')) {
    await rt.env.DB.prepare("UPDATE winback_campaigns SET status = 'draft', action_id = NULL, proposed_at = NULL, updated_at = ? WHERE id = ? AND status = 'proposed'").bind(Date.now(), c.id).run();
    return { ...c, status: 'draft' as Status, action_id: null, proposed_at: null };
  }
  return c;
}

export async function audienceFor(rt: Runtime, c: Pick<Campaign, 'id' | 'rules' | 'destination' | 'dest_ref'>, now = Date.now()) {
  return buildAudience(rt, { rules: rulesOf(c), destination: c.destination, destRef: c.dest_ref, self: c.id, now });
}

// ───────────── rendering ─────────────

type Mode = 'send' | 'preview' | 'test';
const SAMPLE: Partial<Lead> = { id: 'sample', first_name: 'Sam', email: 'sample@example.com', answers: '{"goal":"acquire","timeline":"6_12","blockers":["funding"],"revenue":"3_10m"}', status: 'lost', revenue_band: null, industry: null, booking_answers: null, objection: null, lost_reason: null };

/**
 * One email of the sequence for one lead. `link` is the final href for the button (a signed /r/ redirect when sending).
 * Personalisation: the existing per-lead rewrite (Claude only when ANTHROPIC_API_KEY is set; rules otherwise), never
 * on the email carrying the guarantees, and dropped if the result fails the copy rules or loses the real date.
 */
export async function renderStep(rt: Runtime, c: Campaign, lead: Lead, o: { stepIdx: number; segment: Segment; lastActiveAt: number; dest: Dest; link: string; mode: Mode; now?: number }) {
  const now = o.now ?? Date.now();
  const plan = planFor(c.steps);
  const template = plan[Math.max(0, Math.min(plan.length - 1, o.stepIdx))];
  const g = o.dest.guarantee ? guarantee(rt) : null;
  const ctx = copyCtx(lead, { segment: o.segment, lastActiveAt: o.lastActiveAt, now, tz: tzOf(rt), dest: o.dest, link: o.link, guarantee: g });
  const base = winbackEmail(template, ctx);
  let content: EmailContent = base;
  let personal: { mode: string; error?: string } = { mode: 'off' };
  const carriesGuarantee = template === 3 && Boolean(g);
  // The emails are already written from their answers; the optional rewrite is Claude's, only with the Anthropic key,
  // only when sending (preview and test show the written version).
  if (!carriesGuarantee && lead.id !== 'sample' && o.mode === 'send' && personalizeMode(rt.settings) === 'ai') {
    try {
      const profile = await buildProfile(rt.env, lead, now);
      const used = await usedFacts(rt, lead.id);
      const purpose = `A win-back email (${TEMPLATE_NAMES[template]}) to someone who went quiet ${ctx.since} ago, inviting them to ${o.dest.short}${o.dest.when ? ` on ${o.dest.when}` : ''}. Keep the real date, never invent a deadline, name seller rollover wherever funding comes up, never call a call free.`;
      const p = await personalizeEmail(rt.settings, base, `winback_${template}`, profile, used, { purpose, callTime: null });
      const next: EmailContent = { ...p.content, ...(base.cta ? { cta: base.cta } : {}) };
      const keepsDate = !o.dest.when || next.body.some((b) => plainText(b).includes(o.dest.when!));
      // Only Claude's own rewrite replaces the written email (its rules fallback would repeat their answers).
      if (p.mode !== 'ai') personal = { mode: 'fallback', error: p.error ?? 'no rewrite' };
      else if (!auditEmail(next).length && keepsDate) { content = next; personal = { mode: 'ai' }; }
      else personal = { mode: 'fallback', error: keepsDate ? 'rewrite failed the copy rules' : 'rewrite dropped the date' };
    } catch (e) { personal = { mode: 'fallback', error: String(e instanceof Error ? e.message : e).slice(0, 200) }; }
  }
  return { template, content, issues: auditEmail(content), personal };
}

function finish(rt: Runtime, content: EmailContent, emailId: string | null, unsubscribeUrl: string) {
  return renderEmail(content, {
    openPixel: emailId ? `${rt.origin}/o/${emailId}.gif` : null, unsubscribeUrl,
    signature: rt.settings.EMAIL_SIGNATURE || 'Josh', address: rt.settings.BUSINESS_ADDRESS || rt.settings.SITE_NAME || BRAND.name,
  });
}

/** A lead to preview with: the one asked for (if in the audience), else the first in the audience, else a labelled sample. */
async function sampleLead(rt: Runtime, c: Campaign, leadId?: string | null) {
  const aud = await audienceFor(rt, c);
  const row = (leadId ? aud.rows.find((r) => r.id === leadId) : null) ?? aud.rows[0] ?? null;
  const lead = row ? await getLead(rt.env, row.id) : null;
  if (row && lead) return { lead, segment: row.segment, lastActiveAt: row.last_active_at, sample: false };
  return { lead: { ...SAMPLE } as Lead, segment: (rulesOf(c).segments[0] ?? 'lost') as Segment, lastActiveAt: Date.now() - 150 * DAY, sample: true };
}

/** Every email of the sequence, rendered for one lead. */
export async function previewCampaign(rt: Runtime, c: Campaign, leadId?: string | null, now = Date.now()) {
  const dest = await resolveDestination(rt, c.destination, c.dest_ref, now);
  const s = await sampleLead(rt, c, leadId);
  const unsub = `${rt.origin}/u/${s.lead.id}/preview`;
  const plan = planFor(c.steps);
  const emails = [];
  let at = now;
  for (let i = 0; i < plan.length; i++) {
    const r = await renderStep(rt, c, s.lead, { stepIdx: i, segment: s.segment, lastActiveAt: s.lastActiveAt, dest, link: destinationLink(dest.url, c.id, i), mode: 'preview', now });
    const { html } = finish(rt, r.content, null, unsub);
    emails.push({ step: i + 1, template: TEMPLATE_NAMES[r.template], day: Math.round((at - now) / DAY), subject: r.content.subject, preheader: r.content.preheader, html, issues: r.issues, personalized: r.personal.mode });
    at += c.gap_days * DAY;
  }
  return { lead: { id: s.lead.id, name: [s.lead.first_name, s.lead.last_name].filter(Boolean).join(' ') || s.lead.email, sample: s.sample, segment: s.segment }, destination: dest, emails, aiAtSend: personalizeMode(rt.settings) === 'ai' };
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;
/** The owner's own address for tests: the reply-to, the contracts notify address, else the From address. */
export function ownerAddress(rt: Runtime) {
  const s = rt.settings as Partial<Record<string, string>>;
  for (const v of [s.EMAIL_REPLY_TO, s.CONTRACT_NOTIFY_EMAIL, s.EMAIL_FROM]) {
    const m = String(v ?? '').match(/<([^>]+)>/)?.[1] ?? String(v ?? '').trim();
    if (EMAIL_RE.test(m)) return m;
  }
  return null;
}

/** Sends the whole sequence to the owner's address (subjects marked Test). Never to a lead, never tracked. */
export async function sendTest(rt: Runtime, id: string, to: string | null, leadId?: string | null, now = Date.now()) {
  const c = await getCampaign(rt, id);
  if (!c) throw new WinbackError('Campaign not found.', 404);
  const addr = (to || ownerAddress(rt) || '').trim();
  if (!EMAIL_RE.test(addr)) throw new WinbackError('Enter your own email address for the test.');
  const simulated = !emailConfigured(rt);
  const dest = await resolveDestination(rt, c.destination, c.dest_ref, now);
  const s = await sampleLead(rt, c, leadId);
  const plan = planFor(c.steps);
  for (let i = 0; i < plan.length; i++) {
    const r = await renderStep(rt, c, s.lead, { stepIdx: i, segment: s.segment, lastActiveAt: s.lastActiveAt, dest, link: destinationLink(dest.url, c.id, 'test'), mode: 'test', now });
    const { html, text } = finish(rt, r.content, null, `${rt.origin}/admin`);
    if (!simulated) await sendViaResend(rt, { to: addr, subject: `Test ${i + 1}/${plan.length}: ${r.content.subject}`, html, text, tags: { sequence: 'winback_test', template: `wb${i + 1}` } });
  }
  await rt.env.DB.prepare('UPDATE winback_campaigns SET test_to = ?, test_sent_at = ?, updated_at = ? WHERE id = ?').bind(addr, now, now, id).run();
  return { to: addr, emails: plan.length, simulated };
}

// ───────────── start (through Command approvals), pause, resume, stop ─────────────

const DEST_LABEL: Record<Destination, string> = { masterclass: 'the automated Masterclass', live: 'a live webinar on Zoom', challenge: 'a First Deal Challenge cohort' };

/** Queues the start for the owner's approval. Never starts anything by itself. */
export async function proposeStart(rt: Runtime, id: string, now = Date.now()) {
  const c = await syncStatus(rt, await getCampaign(rt, id));
  if (!c) throw new WinbackError('Campaign not found.', 404);
  if (c.status !== 'draft') throw new WinbackError(c.status === 'proposed' ? 'This campaign is already waiting for your approval in Command.' : 'Only a draft can be started.', 409);
  if (!c.test_sent_at) throw new WinbackError('Send yourself a test first.', 409);
  const dest = await resolveDestination(rt, c.destination, c.dest_ref, now);
  if (dest.closed) throw new WinbackError(dest.closed, 409);
  const aud = await audienceFor(rt, c, now);
  if (!aud.count) throw new WinbackError('Nobody matches these rules right now.', 409);
  const r = rulesOf(c);
  const plan = planFor(c.steps);
  const detail = [
    `${aud.count} ${aud.count === 1 ? 'person' : 'people'} (${Object.entries(aud.segmentCounts).map(([k, v]) => `${SEGMENTS[k as Segment].label}: ${v}`).join(', ')}), quiet ${r.minDays}+ days.`,
    `Destination: ${DEST_LABEL[c.destination]}: ${dest.title}${dest.when ? `, ${dest.when}` : ''}.${dest.held ? ` Sends wait for now: ${dest.held}` : ''}`,
    `${plan.length} emails each, ${c.gap_days} days apart, at most ${c.daily_cap} emails a day, ${c.window_from}:00 to ${c.window_to}:00 ${tzOf(rt)}.`,
    `Each person's emails stop the moment they register, buy, book, apply or reply.`,
    `First names: ${aud.rows.slice(0, 12).map((x) => x.name).join(', ')}${aud.count > 12 ? ', and more in Funnel HQ → Win-back' : ''}.`,
    aud.excluded.length ? `Left out: ${aud.excluded.slice(0, 6).map((e) => `${e.reason} (${e.n})`).join(', ')}.` : '',
    `Test sent to ${c.test_to} on ${new Date(c.test_sent_at).toISOString().slice(0, 10)}.`,
    'Source: Funnel HQ → Win-back (leads, registrations, payments and emails in our database).',
  ].filter(Boolean).join('\n\n');
  const input = { dept: 'sales' as const, kind: START_KIND, summary: `Start win-back "${c.name}": ${aud.count} ${aud.count === 1 ? 'person' : 'people'} to ${DEST_LABEL[c.destination]}`, detail, risk: 'high' as const, payload: { campaign_id: c.id, people: aud.count }, source: 'winback' };
  // A win-back start always waits for the owner, even when sales actions are set to auto.
  const actionId = isAuto(rt, START_KIND)
    ? await logAction(rt, { ...input, actor: 'ai', status: 'proposed' }, now)
    : await proposeAction(rt, input, now);
  await rt.env.DB.prepare("UPDATE winback_campaigns SET status = 'proposed', action_id = ?, proposed_at = ?, updated_at = ? WHERE id = ?").bind(actionId, now, now, id).run();
  return { actionId, people: aud.count };
}

/** Carried out only by an approval of the proposal (the action layer). Enrols the audience as it is now. */
export async function startApproved(rt: Runtime, campaignId: string, now = Date.now()) {
  const c = await getCampaign(rt, campaignId);
  if (!c) return { ok: false, summary: 'Campaign not found.' };
  if (c.status !== 'proposed' || !c.action_id) return { ok: false, summary: `This campaign is ${c.status}, not waiting for approval.` };
  const a = await getAction(rt, c.action_id);
  if (!a || a.kind !== START_KIND) return { ok: false, summary: 'The approval does not match this campaign.' };
  if (a.decided_by !== 'you' && a.decided_by !== 'slack') {
    await rt.env.DB.prepare("UPDATE winback_campaigns SET status = 'draft', action_id = NULL, updated_at = ? WHERE id = ?").bind(now, c.id).run();
    return { ok: false, summary: 'A win-back campaign starts only when you approve it. Propose it again and approve it yourself.' };
  }
  const aud = await audienceFor(rt, c, now);
  if (!aud.count) {
    await rt.env.DB.prepare("UPDATE winback_campaigns SET status = 'draft', action_id = NULL, updated_at = ? WHERE id = ?").bind(now, c.id).run();
    return { ok: false, summary: 'Nobody matches the rules any more, so nothing started.' };
  }
  const stmts = aud.rows.map((r) => rt.env.DB.prepare('INSERT OR IGNORE INTO winback_enrollments (campaign_id, lead_id, segment, last_active_at, status, next_step, next_at, enrolled_at) VALUES (?, ?, ?, ?, \'active\', 0, ?, ?)')
    .bind(c.id, r.id, r.segment, r.last_active_at, now, now));
  for (let i = 0; i < stmts.length; i += 50) await rt.env.DB.batch(stmts.slice(i, i + 50));
  await rt.env.DB.prepare("UPDATE winback_campaigns SET status = 'running', approved_at = ?, approved_by = ?, started_at = ?, paused_at = NULL, updated_at = ? WHERE id = ?").bind(now, a.decided_by, now, now, c.id).run();
  return { ok: true, summary: `Win-back "${c.name}" started: ${aud.count} ${aud.count === 1 ? 'person' : 'people'}, at most ${c.daily_cap} emails a day, ${c.window_from}:00 to ${c.window_to}:00 ${tzOf(rt)}.` };
}

registerActionHandler(START_KIND, async (rt, raw) => {
  const p = (raw ?? {}) as Record<string, unknown>;
  const id = typeof p.campaign_id === 'string' ? p.campaign_id : '';
  if (!id) return { ok: false, summary: 'No campaign in the proposal.' };
  return startApproved(rt, id);
}, { label: 'Start a win-back campaign' });

export async function setPaused(rt: Runtime, id: string, paused: boolean, now = Date.now()) {
  const c = await getCampaign(rt, id);
  if (!c) throw new WinbackError('Campaign not found.', 404);
  if (paused) {
    const r = await rt.env.DB.prepare("UPDATE winback_campaigns SET status = 'paused', paused_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").bind(now, now, id).run();
    if (!r.meta.changes) throw new WinbackError('Only a running campaign can be paused.', 409);
  } else {
    // Resuming needs the original approval (a campaign never runs without one).
    const r = await rt.env.DB.prepare("UPDATE winback_campaigns SET status = 'running', paused_at = NULL, updated_at = ? WHERE id = ? AND status = 'paused' AND approved_at IS NOT NULL AND approved_by IN ('you', 'slack')").bind(now, id).run();
    if (!r.meta.changes) throw new WinbackError('Only a paused, approved campaign can be resumed.', 409);
  }
  return (await getCampaign(rt, id))!;
}

export async function stopCampaign(rt: Runtime, id: string, now = Date.now()) {
  const c = await getCampaign(rt, id);
  if (!c) throw new WinbackError('Campaign not found.', 404);
  if (!['running', 'paused', 'proposed'].includes(c.status)) throw new WinbackError('This campaign is not running.', 409);
  if (c.status === 'proposed' && c.action_id) await rejectAction(rt, c.action_id, 'you', 'Stopped in Funnel HQ → Win-back', now);
  await rt.env.DB.prepare("UPDATE winback_campaigns SET status = 'stopped', stopped_at = ?, ended_reason = 'Stopped by you', updated_at = ? WHERE id = ?").bind(now, now, id).run();
  await rt.env.DB.prepare("UPDATE winback_enrollments SET status = 'stopped', stop_reason = 'campaign stopped', stopped_at = ? WHERE campaign_id = ? AND status = 'active'").bind(now, id).run();
  return (await getCampaign(rt, id))!;
}

// ───────────── the cron ─────────────

/** Why a person's sequence stops now: they registered, bought, booked, applied or replied since they were enrolled. */
const CONVERSION_SQL = `
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM webinar_passes p WHERE p.lead_id = :l AND p.status = 'paid' AND p.paid_at > :t)
    OR EXISTS (SELECT 1 FROM challenge_orders o WHERE o.lead_id = :l AND o.status = 'paid' AND o.paid_at > :t) THEN 'bought'
  WHEN EXISTS (SELECT 1 FROM webinar_registrations w WHERE w.lead_id = :l AND w.created_at > :t)
    OR EXISTS (SELECT 1 FROM live_webinar_regs g WHERE g.lead_id = :l AND g.created_at > :t)
    OR EXISTS (SELECT 1 FROM challenge_registrations c WHERE c.lead_id = :l AND c.created_at > :t) THEN 'registered'
  WHEN EXISTS (SELECT 1 FROM leads x WHERE x.id = :l AND x.booked_at > :t) THEN 'booked'
  WHEN EXISTS (SELECT 1 FROM leads x WHERE x.id = :l AND x.app_completed_at > :t) THEN 'applied'
  WHEN EXISTS (SELECT 1 FROM support_threads s WHERE s.lead_id = :l AND s.last_inbound_at > :t)
    OR EXISTS (SELECT 1 FROM sms_messages m WHERE m.lead_id = :l AND m.direction = 'in' AND m.created_at > :t)
    OR EXISTS (SELECT 1 FROM whatsapp_messages a WHERE a.lead_id = :l AND a.direction = 'in' AND a.ts > :t) THEN 'replied'
  ELSE NULL END AS reason`;
export async function conversionReason(rt: Runtime, leadId: string, since: number) {
  const sql = CONVERSION_SQL.replace(/:l/g, '?1').replace(/:t/g, '?2');
  const r = await rt.env.DB.prepare(sql).bind(leadId, since).first<{ reason: string | null }>();
  return r?.reason ?? null;
}

async function stopEnrollment(rt: Runtime, e: Pick<Enrollment, 'campaign_id' | 'lead_id'>, reason: string, now: number, status: 'stopped' | 'done' = 'stopped') {
  await rt.env.DB.prepare("UPDATE winback_enrollments SET status = ?, stop_reason = ?, stopped_at = ?, next_at = NULL WHERE campaign_id = ? AND lead_id = ? AND status = 'active'").bind(status, reason, now, e.campaign_id, e.lead_id).run();
}

/** Stops everyone in the campaign who converted since they were enrolled. */
export async function sweepConversions(rt: Runtime, campaignId: string, now = Date.now()) {
  const { results } = await rt.env.DB.prepare("SELECT campaign_id, lead_id, enrolled_at FROM winback_enrollments WHERE campaign_id = ? AND status = 'active'").bind(campaignId).all<Enrollment>();
  let stopped = 0;
  for (const e of results) {
    const why = await conversionReason(rt, e.lead_id, e.enrolled_at);
    if (why) { await stopEnrollment(rt, e, why, now); stopped++; }
  }
  return stopped;
}

/** Whether the campaign may send at all: running and approved by the owner. */
export const mayRun = (c: Pick<Campaign, 'status' | 'approved_at' | 'approved_by'>) => c.status === 'running' && Boolean(c.approved_at) && (c.approved_by === 'you' || c.approved_by === 'slack');

async function sentToday(rt: Runtime, campaignId: string, now: number) {
  const r = await rt.env.DB.prepare("SELECT COUNT(*) AS n FROM winback_sends WHERE campaign_id = ? AND status IN ('sent', 'simulated') AND sent_at >= ?").bind(campaignId, startOfDay(now, tzOf(rt))).first<{ n: number }>();
  return r?.n ?? 0;
}

/** When the next email goes (and which one), keeping every email before the destination closes. */
export function nextTiming(o: { stepIdx: number; planLength: number; gapDays: number; closesAt: number | null; now: number }): { step: number; at: number } | null {
  const next = o.stepIdx + 1;
  if (next >= o.planLength) return null;
  const at = o.now + o.gapDays * DAY;
  if (!o.closesAt || at < o.closesAt - 2 * HOUR) return { step: next, at };
  const lastChance = o.closesAt - 26 * HOUR;
  // Not enough room for the rest: skip to the last-note email a day before registration closes, if there's room.
  if (lastChance > o.now + 12 * HOUR) return { step: o.planLength - 1, at: lastChance };
  if (next === o.planLength - 1 && o.closesAt - 2 * HOUR > o.now + 6 * HOUR) return { step: next, at: Math.max(o.now + 6 * HOUR, lastChance) };
  return null;
}

async function sendOne(rt: Runtime, c: Campaign, e: Enrollment, dest: Dest, now: number): Promise<'sent' | 'simulated' | 'stopped' | 'failed' | 'skipped'> {
  const lead = await getLead(rt.env, e.lead_id);
  if (!lead || !lead.email) { await stopEnrollment(rt, e, 'lead deleted or no email', now); return 'stopped'; }
  const row = await leadRow(rt, e.lead_id, c.destination, c.dest_ref, c.id);
  const conv = await conversionReason(rt, e.lead_id, e.enrolled_at);
  if (conv) { await stopEnrollment(rt, e, conv, now); return 'stopped'; }
  const why = row ? exclusion(row, { recentDays: 0 }, now) : 'lead deleted';
  if (why) { await stopEnrollment(rt, e, why === 'Already registered for this destination' ? 'registered' : why, now); return 'stopped'; }
  const plan = planFor(c.steps);
  if (e.next_step >= plan.length) { await stopEnrollment(rt, e, 'sequence finished', now, 'done'); return 'stopped'; }
  // Claim this step (overlapping cron runs never send it twice).
  const timing = nextTiming({ stepIdx: e.next_step, planLength: plan.length, gapDays: c.gap_days, closesAt: dest.closesAt, now });
  const claim = await rt.env.DB.prepare(`UPDATE winback_enrollments SET next_step = ?, next_at = ?, last_sent_at = ?, first_sent_at = COALESCE(first_sent_at, ?), status = ?, stop_reason = ?, stopped_at = ?
    WHERE campaign_id = ? AND lead_id = ? AND next_step = ? AND status = 'active'`)
    .bind(timing ? timing.step : plan.length, timing?.at ?? null, now, now, timing ? 'active' : 'done', timing ? null : 'sequence finished', timing ? null : now, c.id, e.lead_id, e.next_step).run();
  if (!claim.meta.changes) return 'skipped';
  const emailId = newId('m');
  const target = destinationLink(dest.url, c.id, e.next_step);
  const href = `${rt.origin}/r/${emailId}/${await signEmailLink(rt, emailId, target)}?u=${encodeURIComponent(target)}`;
  try {
    const r = await renderStep(rt, c, lead, { stepIdx: e.next_step, segment: e.segment, lastActiveAt: e.last_active_at ?? lastActive(row ?? {}), dest, link: href, mode: 'send', now });
    if (r.issues.length) throw new Error(`copy rules: ${r.issues[0].rule}`);
    const unsubscribeUrl = `${rt.origin}/u/${lead.id}/${await unsubscribeSig(rt, lead.id)}`;
    const { html, text } = finish(rt, r.content, emailId, unsubscribeUrl);
    const template = `wb_${c.id}_${e.next_step + 1}`;
    await rt.env.DB.prepare("INSERT INTO emails (id, lead_id, sequence, step, template, to_email, subject, send_at, status, personalized, personalize_error, created_at) VALUES (?, ?, 'winback', ?, ?, ?, ?, ?, 'sending', ?, ?, ?)")
      .bind(emailId, lead.id, Math.floor(now / 1000) % 2_000_000_000, template, lead.email, r.content.subject, now, r.personal.mode, r.personal.error ?? null, now).run();
    let status: 'sent' | 'simulated' = 'simulated', providerId: string | null = null;
    if (emailConfigured(rt)) { providerId = await sendViaResend(rt, { to: lead.email, subject: r.content.subject, html, text, unsubscribeUrl, tags: { sequence: 'winback', template: `wb${e.next_step + 1}` } }); status = 'sent'; }
    await rt.env.DB.prepare('UPDATE emails SET status = ?, sent_at = ?, provider_id = ? WHERE id = ?').bind(status, Date.now(), providerId, emailId).run();
    await rt.env.DB.prepare('INSERT INTO winback_sends (id, campaign_id, lead_id, step, subject, status, sent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(emailId, c.id, lead.id, e.next_step, r.content.subject, status, Date.now(), now).run();
    return status;
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 300);
    await rt.env.DB.prepare("UPDATE emails SET status = 'failed', error = ? WHERE id = ?").bind(msg, emailId).run();
    await rt.env.DB.prepare("INSERT INTO winback_sends (id, campaign_id, lead_id, step, status, error, created_at) VALUES (?, ?, ?, ?, 'failed', ?, ?)").bind(emailId, c.id, lead.id, e.next_step, msg, now).run();
    // Put the step back once, 30 minutes later.
    await rt.env.DB.prepare("UPDATE winback_enrollments SET next_step = ?, next_at = ?, status = 'active', stop_reason = NULL, stopped_at = NULL WHERE campaign_id = ? AND lead_id = ?").bind(e.next_step, now + 30 * MIN, c.id, e.lead_id).run();
    return 'failed';
  }
}

/**
 * The 5-minute cron. Sends nothing for a campaign that isn't running with the owner's approval; with no running
 * campaign it reads one table and returns.
 */
export async function processWinback(rt: Runtime, now = Date.now()) {
  const db = rt.env.DB;
  const { results: running } = await db.prepare("SELECT * FROM winback_campaigns WHERE status = 'running'").all<Campaign>();
  const out = { campaigns: running.length, sent: 0, simulated: 0, stopped: 0, failed: 0 };
  for (const c of running) {
    if (!mayRun(c)) continue;
    const dest = await resolveDestination(rt, c.destination, c.dest_ref, now);
    if (dest.closed) {
      await db.prepare("UPDATE winback_campaigns SET status = 'done', ended_reason = ?, updated_at = ? WHERE id = ?").bind(dest.closed, now, c.id).run();
      await db.prepare("UPDATE winback_enrollments SET status = 'done', stop_reason = 'destination closed', stopped_at = ?, next_at = NULL WHERE campaign_id = ? AND status = 'active'").bind(now, c.id).run();
      continue;
    }
    out.stopped += await sweepConversions(rt, c.id, now);
    if ((dest.held ?? null) !== (c.held_reason ?? null)) await db.prepare('UPDATE winback_campaigns SET held_reason = ?, updated_at = ? WHERE id = ?').bind(dest.held, now, c.id).run();
    if (dest.held || !inWindow(now, tzOf(rt), c.window_from, c.window_to)) continue;
    const room = Math.min(MAX_PER_TICK, c.daily_cap - (await sentToday(rt, c.id, now)));
    if (room > 0) {
      // Follow-ups before first emails, oldest due first.
      const { results: due } = await db.prepare("SELECT * FROM winback_enrollments WHERE campaign_id = ? AND status = 'active' AND next_at <= ? ORDER BY next_step DESC, next_at LIMIT ?").bind(c.id, now, room).all<Enrollment>();
      for (const e of due) {
        const r = await sendOne(rt, c, e, dest, now);
        if (r === 'sent') out.sent++; else if (r === 'simulated') out.simulated++; else if (r === 'stopped') out.stopped++; else if (r === 'failed') out.failed++;
      }
    }
    const left = await db.prepare("SELECT COUNT(*) AS n FROM winback_enrollments WHERE campaign_id = ? AND status = 'active'").bind(c.id).first<{ n: number }>();
    if (!left?.n) await db.prepare("UPDATE winback_campaigns SET status = 'done', ended_reason = 'Everyone finished or stopped', updated_at = ? WHERE id = ? AND status = 'running'").bind(now, c.id).run();
  }
  return out;
}

// ───────────── report ─────────────

/** Sent, opened, clicked, registered, attended, bought and revenue, all from our own tables. */
export async function campaignReport(rt: Runtime, c: Campaign) {
  const db = rt.env.DB;
  const sends = await db.prepare(`SELECT COUNT(*) AS sent, SUM(s.status = 'simulated') AS simulated, COUNT(DISTINCT s.lead_id) AS people,
      SUM(m.opened_at IS NOT NULL) AS opened, SUM(m.clicked_at IS NOT NULL) AS clicked, COUNT(DISTINCT CASE WHEN m.clicked_at IS NOT NULL THEN s.lead_id END) AS clickers
    FROM winback_sends s LEFT JOIN emails m ON m.id = s.id WHERE s.campaign_id = ? AND s.status IN ('sent', 'simulated')`).bind(c.id).first<Record<string, number | null>>();
  const failed = await db.prepare("SELECT COUNT(*) AS n FROM winback_sends WHERE campaign_id = ? AND status = 'failed'").bind(c.id).first<{ n: number }>();
  const enr = await db.prepare('SELECT status, stop_reason, COUNT(*) AS n FROM winback_enrollments WHERE campaign_id = ? GROUP BY status, stop_reason').bind(c.id).all<{ status: string; stop_reason: string | null; n: number }>();
  // Registrations for this campaign's destination after the person's first win-back email.
  const regSql = c.destination === 'live'
    ? `SELECT g.lead_id, g.created_at, g.joined_at AS attended FROM live_webinar_regs g JOIN winback_enrollments e ON e.lead_id = g.lead_id AND e.campaign_id = ?1 WHERE g.created_at > e.first_sent_at ${c.dest_ref ? 'AND g.event_id = ?2' : ''}`
    : c.destination === 'challenge'
      ? `SELECT r.lead_id, r.created_at, (SELECT MIN(COALESCE(p.joined_at, p.present_at)) FROM challenge_progress p WHERE p.reg_id = r.id) AS attended FROM challenge_registrations r JOIN winback_enrollments e ON e.lead_id = r.lead_id AND e.campaign_id = ?1 WHERE r.created_at > e.first_sent_at ${c.dest_ref ? 'AND r.cohort_id = ?2' : ''}`
      : 'SELECT w.lead_id, w.created_at, w.joined_at AS attended FROM webinar_registrations w JOIN winback_enrollments e ON e.lead_id = w.lead_id AND e.campaign_id = ?1 WHERE w.created_at > e.first_sent_at';
  const regStmt = db.prepare(regSql);
  const regs = (await (c.dest_ref && c.destination !== 'masterclass' ? regStmt.bind(c.id, c.dest_ref) : regStmt.bind(c.id)).all<{ lead_id: string; created_at: number; attended: number | null }>()).results;
  const viaLink = await db.prepare(`SELECT COUNT(DISTINCT s.lead_id) AS n FROM winback_sends s JOIN emails m ON m.id = s.id WHERE s.campaign_id = ? AND m.clicked_at IS NOT NULL`).bind(c.id).first<{ n: number }>();
  const buys = (await db.prepare(`SELECT p.lead_id, p.amount - COALESCE(p.refunded_amount, 0) AS net, UPPER(p.currency) AS currency FROM webinar_passes p JOIN winback_enrollments e ON e.lead_id = p.lead_id AND e.campaign_id = ?1
       WHERE p.status IN ('paid', 'refunded') AND p.paid_at > e.first_sent_at
     UNION ALL
     SELECT o.lead_id, o.amount - COALESCE(o.refunded_amount, 0), UPPER(o.currency) FROM challenge_orders o JOIN winback_enrollments e ON e.lead_id = o.lead_id AND e.campaign_id = ?1
       WHERE o.status IN ('paid', 'refunded') AND o.paid_at > e.first_sent_at`).bind(c.id).all<{ lead_id: string; net: number; currency: string }>()).results;
  const revenue: Record<string, number> = {};
  for (const b of buys) revenue[b.currency || 'USD'] = (revenue[b.currency || 'USD'] ?? 0) + Math.max(0, b.net) / 100;
  const regLeads = new Set(regs.map((r) => r.lead_id));
  const enrolled = enr.results.reduce((a, r) => a + r.n, 0);
  return {
    enrolled,
    active: enr.results.filter((r) => r.status === 'active').reduce((a, r) => a + r.n, 0),
    stopReasons: enr.results.filter((r) => r.status !== 'active').map((r) => ({ status: r.status, reason: r.stop_reason, n: r.n })),
    sent: sends?.sent ?? 0, simulated: sends?.simulated ?? 0, people: sends?.people ?? 0, failed: failed?.n ?? 0,
    opened: sends?.opened ?? 0, clicked: sends?.clicked ?? 0, clickers: viaLink?.n ?? 0,
    registered: regLeads.size,
    attended: new Set(regs.filter((r) => r.attended).map((r) => r.lead_id)).size,
    bought: new Set(buys.map((b) => b.lead_id)).size,
    revenue,
    hasData: (sends?.sent ?? 0) > 0,
  };
}

export async function listCampaigns(rt: Runtime) {
  const { results } = await rt.env.DB.prepare('SELECT * FROM winback_campaigns ORDER BY created_at DESC LIMIT 100').all<Campaign>();
  const out = [];
  for (const raw of results) {
    const c = (await syncStatus(rt, raw))!;
    const action = c.action_id ? await getAction(rt, c.action_id) : null;
    out.push({ ...c, rules: rulesOf(c), action: action ? { id: action.id, status: action.status, decided_by: action.decided_by, result: action.result } : null, report: await campaignReport(rt, c) });
  }
  return out;
}

import type { Runtime } from '../app';
import { type Lead, getLead } from '../funnel/leads';
import { emailConfigured, sendViaResend, unsubscribeSig } from '../integrations/email';
import { company, contractEmail, signUrl } from '../sales/contracts';
import { escHtml } from '../followup/dossier';
import { safeFirstName } from '../lib/text';
import { newId } from '../lib/ids';
import { type PassRow, formatMoney, fromMinor, passConfig } from './pass';
import { DEAL_SPRINT_DELIVERABLES, type DealSprintRow, type Deliverable, dealSprintConfig, dealSprintUrl } from './deal-sprint';

/**
 * Emails to First Deal Sprint buyers, sent from Josh's address in the agreement style:
 *
 *   welcome    straight after payment: the Sprint page, book the kickoff, fill in the intake
 *   intake     24 hours in, if the intake form is still empty
 *   ready      when the team marks a deliverable ready on the Sprint board
 *   prep       Day 5: prepare for the Deal Plan session (and book it, if it isn't)
 *   proposal   after the Deal Plan session, only once the team marks "proposal sent": Day +1, +3, +7.
 *              Stops when the outcome moves on (signed, not continuing, refunded).
 *
 * The 5-minute cron runs processDealSprintEmails. Each email is a row in `emails` (sequence 'deal_sprint',
 * one step number per email), claimed before sending, so overlapping runs and repeated clicks never send twice.
 */

const DAY = 86_400_000;
export const SEQUENCE = 'deal_sprint';
export const STEP = { welcome: 0, intake: 1, prep: 2, proposal: [3, 4, 5], ready: 100 } as const;
const PROPOSAL_DAYS = [1, 3, 7];

export type SprintEmailKind = 'welcome' | 'intake' | 'prep' | 'proposal1' | 'proposal2' | 'proposal3' | 'ready';

export interface SprintEmailCtx {
  name: string; product: string; portal: string;
  kickoffUrl: string | null; planUrl: string | null; planBooked: boolean;
  credit: string | null; signLink: string | null;
  deliverable?: { title: string; notes: string | null; link: string | null };
}

export interface SprintEmail { subject: string; preheader: string; heading: string; paras: string[]; button: { label: string; href: string } }

/** The wording (plain text; escaped when rendered). Pure, so the tests can audit every line. */
export function dealSprintEmail(kind: SprintEmailKind, x: SprintEmailCtx): SprintEmail {
  const hi = `Hi ${x.name},`;
  const credit = x.credit ? `The ${x.credit} you paid for the Sprint is credited against the engagement fee.` : 'The full Sprint fee is credited against the engagement fee.';
  switch (kind) {
    case 'welcome':
      return {
        subject: `Your ${x.product} starts today`,
        preheader: 'Book the kickoff call and fill in the intake form.',
        heading: `Your ${x.product} starts today`,
        paras: [
          hi,
          `Your payment is through and the seven days start today. Everything for the Sprint lives on one page: the day-by-day plan, each deliverable the day it is ready, and your deal pack.`,
          x.kickoffUrl ? 'Two things get it moving. Book your kickoff call, then fill in the intake form with your revenue, EBITDA and the kind of business you would buy first.' : 'Josh’s team emails you within one business day to set your kickoff call. Before then, fill in the intake form with your revenue, EBITDA and the kind of business you would buy first.',
          'The intake takes about ten minutes. The capacity review and the buy box are built from it.',
          ...(x.kickoffUrl ? [`Book the kickoff call here: ${x.kickoffUrl}`] : []),
        ],
        button: { label: 'Open my Sprint page', href: x.portal },
      };
    case 'intake':
      return {
        subject: 'Your intake form for the Sprint',
        preheader: 'About ten minutes, and the capacity review starts from it.',
        heading: 'Your intake form is still empty',
        paras: [
          hi,
          'The capacity review and the buy box are built from your intake form, and the team doesn’t have it yet.',
          'It takes about ten minutes: revenue, EBITDA, industry, locations, what you would buy first and a link to your financial statements.',
        ],
        button: { label: 'Fill in my intake', href: `${x.portal}#intake` },
      };
    case 'ready': {
      const d = x.deliverable!;
      return {
        subject: `Ready: ${d.title}`,
        preheader: 'It is on your Sprint page now.',
        heading: `${d.title} is ready`,
        paras: [
          hi,
          `${d.title} is ready on your Sprint page.`,
          ...(d.notes ? [d.notes] : []),
          ...(d.link ? [`Open it directly: ${d.link}`] : []),
          'Read it before your Deal Plan session on Day 7, and reply to this email with any questions.',
        ],
        button: { label: 'Open my Sprint page', href: x.portal },
      };
    }
    case 'prep':
      return {
        subject: 'Prepare for your Deal Plan session',
        preheader: x.planBooked ? 'Three things to bring.' : 'It is the last step of the Sprint, and it isn’t booked yet.',
        heading: 'Prepare for your Deal Plan session',
        paras: [
          hi,
          ...(x.planBooked ? [] : [x.planUrl ? `Your Deal Plan session is the last step of the Sprint, and it isn’t booked yet. Book it here: ${x.planUrl}` : 'Your Deal Plan session is the last step of the Sprint. Josh’s team emails you to set the time.']),
          'In the 60 minutes we go through your capacity review, buy box, shortlist and structure memo, and agree the plan for your first deal.',
          'Bring three things: your latest financial statements, the names of any businesses you already have in mind, and the cash you would put into a first deal, even if the answer is none.',
          'If at the end of the session you don’t think the Sprint was worth far more than you paid, tell us and the full fee is refunded.',
        ],
        button: x.planBooked || !x.planUrl ? { label: 'Open my Sprint page', href: x.portal } : { label: 'Book my Deal Plan session', href: x.planUrl },
      };
    case 'proposal1':
      return {
        subject: 'The proposal from your Deal Plan session',
        preheader: 'The same deal, with Josh’s team in the room.',
        heading: 'Your proposal',
        paras: [
          hi,
          'Thank you for the Deal Plan session. The proposal we discussed is ready for you.',
          'The advisory engagement continues the same deal with Josh’s team in the room: owner outreach, negotiation, lender introductions and the letter of intent.',
          credit,
          'Reply with any question about the scope or the fee and I will answer it directly.',
        ],
        button: x.signLink ? { label: 'Review the agreement', href: x.signLink } : { label: 'Open my Sprint page', href: x.portal },
      };
    case 'proposal2':
      return {
        subject: 'Who runs the outreach',
        preheader: 'The plan names the target. The engagement works it.',
        heading: 'Who runs the outreach',
        paras: [
          hi,
          'Your Deal Plan names the target size, the structure and the first owners to call. The open question is who makes those calls and runs the negotiation.',
          'On the engagement, Josh’s team does it with you, from the first owner call through lender introductions to a signed letter of intent. The funding is worked through the way the memo sets out: commercial debt, seller finance and seller rollover.',
          'The engagement is advice and execution support. It is not a promise of a deal, a loan or a return.',
        ],
        button: x.signLink ? { label: 'Review the agreement', href: x.signLink } : { label: 'Open my Sprint page', href: x.portal },
      };
    default:
      return {
        subject: 'Closing the loop on your proposal',
        preheader: 'One reply either way.',
        heading: 'Closing the loop',
        paras: [
          hi,
          'A last note on the proposal from your Deal Plan session.',
          `If you want to go ahead, the agreement is one page and the Sprint credit is already applied. ${credit}`,
          'If the engagement is not for you right now, reply “not now” and we stop following up. Your Sprint deliverables stay on your page either way.',
        ],
        button: x.signLink ? { label: 'Review the agreement', href: x.signLink } : { label: 'Open my Sprint page', href: x.portal },
      };
  }
}

/** Plain text with a bare https link becomes a clickable link; everything else is escaped. */
const toHtml = (p: string) => escHtml(p).replace(/(https:\/\/[^\s<]+)/g, (u) => `<a href="${u}">${u}</a>`).replace(/\n/g, '<br>');

async function ctxFor(rt: Runtime, pass: PassRow, lead: Lead, token: string | null): Promise<SprintEmailCtx> {
  const cfg = dealSprintConfig(rt.settings);
  const sprint = await rt.env.DB.prepare('SELECT plan_booked_at, plan_held_at FROM deal_sprints WHERE pass_id = ?').bind(pass.id).first<{ plan_booked_at: number | null; plan_held_at: number | null }>();
  const open = await rt.env.DB.prepare("SELECT token FROM contracts WHERE lead_id = ? AND status IN ('sent', 'viewed') AND COALESCE(is_test, 0) = 0 ORDER BY created_at DESC LIMIT 1").bind(lead.id).first<{ token: string }>();
  return {
    name: safeFirstName(lead.first_name) ?? 'there',
    product: pass.product || passConfig(rt.settings).offerName,
    portal: token ? dealSprintUrl(rt, token) : `${rt.origin}`,
    kickoffUrl: cfg.kickoffUrl, planUrl: cfg.planUrl, planBooked: Boolean(sprint?.plan_booked_at || sprint?.plan_held_at),
    credit: pass.credit_amount > 0 ? formatMoney(fromMinor(pass.credit_amount, pass.currency), pass.currency.toUpperCase()) : null,
    signLink: open ? signUrl(rt, open.token) : null,
  };
}

/** Claim the step, send, record. Returns true when this call sent (or simulated) it. */
async function deliver(rt: Runtime, lead: Lead, step: number, template: string, mail: SprintEmail, o: { unsubscribe?: boolean } = {}) {
  if (!lead.email) return false;
  const db = rt.env.DB;
  const now = Date.now();
  // A failed send is retried on a later run, up to three attempts in all.
  const claim = await db.prepare(
    `INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', 1, ?)
     ON CONFLICT(lead_id, sequence, step) DO UPDATE SET status = 'sending', attempts = emails.attempts + 1, send_at = excluded.send_at
       WHERE emails.status = 'failed' AND emails.attempts < 3`,
  ).bind(newId('m'), lead.id, SEQUENCE, step, template, lead.email, now, now).run();
  if (!claim.meta.changes) return false;
  const co = company(rt);
  const m = contractEmail({ preheader: mail.preheader, heading: mail.heading, paras: mail.paras.map(toHtml), button: mail.button, sender: co.signer, company: co.name, address: co.address });
  const where = 'WHERE lead_id = ? AND sequence = ? AND step = ?';
  try {
    let status = 'simulated';
    let providerId: string | null = null;
    if (emailConfigured(rt)) {
      const unsubscribeUrl = o.unsubscribe ? `${rt.origin}/u/${lead.id}/${await unsubscribeSig(rt, lead.id)}` : undefined;
      providerId = await sendViaResend(rt, { to: lead.email, subject: mail.subject, html: m.html, text: m.text, from: co.from, unsubscribeUrl, tags: { sequence: SEQUENCE, template } });
      status = 'sent';
    }
    await db.prepare(`UPDATE emails SET status = ?, sent_at = ?, provider_id = ?, subject = ?, error = NULL ${where}`).bind(status, Date.now(), providerId, mail.subject, lead.id, SEQUENCE, step).run();
    return true;
  } catch (e) {
    await db.prepare(`UPDATE emails SET status = 'failed', error = ? ${where}`).bind(String(e instanceof Error ? e.message : e).slice(0, 500), lead.id, SEQUENCE, step).run();
    console.error('deal sprint email failed', template, e);
    return false;
  }
}

const tokenFor = async (rt: Runtime, pass: PassRow) =>
  (await rt.env.DB.prepare('SELECT token FROM webinar_registrations WHERE id = ?').bind(pass.reg_id).first<{ token: string }>())?.token ?? null;

/** From the Sprint board: one email when a deliverable is marked ready. */
export async function sendDeliverableReady(rt: Runtime, pass: PassRow, d: Deliverable, o: { link: string | null; notes: string | null }) {
  const lead = await getLead(rt.env, pass.lead_id);
  if (!lead?.email) return false;
  const ctx = await ctxFor(rt, pass, lead, await tokenFor(rt, pass));
  const i = DEAL_SPRINT_DELIVERABLES.findIndex((x) => x.key === d.key);
  return deliver(rt, lead, STEP.ready + Math.max(0, i), `deal_sprint_ready_${d.key}`, dealSprintEmail('ready', { ...ctx, deliverable: { title: d.title, notes: o.notes, link: o.link } }));
}

/** Which scheduled emails are due for one Sprint right now (pure, for the tests). */
export function dueSprintEmails(o: { paidAt: number; hasIntake: boolean; sprint: Pick<DealSprintRow, 'plan_held_at' | 'outcome' | 'proposal_sent_at'> | null; now: number }) {
  const age = o.now - o.paidAt;
  const due: { kind: SprintEmailKind; step: number }[] = [];
  // Only recent purchases get the welcome, so buyers from before this shipped aren't welcomed late.
  if (age < 3 * DAY) due.push({ kind: 'welcome', step: STEP.welcome });
  if (!o.hasIntake && age >= DAY && age < 7 * DAY) due.push({ kind: 'intake', step: STEP.intake });
  if (age >= 4 * DAY && age < 10 * DAY && !o.sprint?.plan_held_at) due.push({ kind: 'prep', step: STEP.prep });
  const sent = o.sprint?.outcome === 'proposal_sent' ? o.sprint.proposal_sent_at : null;
  if (sent) PROPOSAL_DAYS.forEach((d, i) => {
    const at = sent + d * DAY;
    // A step that's more than three days late is skipped rather than sent out of order.
    if (o.now >= at && o.now < at + 3 * DAY) due.push({ kind: `proposal${i + 1}` as SprintEmailKind, step: STEP.proposal[i] });
  });
  return due;
}

/** Cron (every 5 minutes). */
export async function processDealSprintEmails(rt: Runtime, now = Date.now()) {
  const { results } = await rt.env.DB.prepare(
    `SELECT p.*, s.plan_held_at AS s_plan_held_at, s.outcome AS s_outcome, s.proposal_sent_at AS s_proposal_sent_at,
            EXISTS (SELECT 1 FROM deal_sprint_intake i WHERE i.pass_id = p.id) AS has_intake
       FROM webinar_passes p LEFT JOIN deal_sprints s ON s.pass_id = p.id
      WHERE p.kind = 'offer' AND p.status = 'paid' AND p.paid_at > ? LIMIT 300`,
  ).bind(now - 90 * DAY).all<PassRow & { s_plan_held_at: number | null; s_outcome: DealSprintRow['outcome']; s_proposal_sent_at: number | null; has_intake: number }>();
  let sent = 0;
  for (const p of results) {
    const due = dueSprintEmails({ paidAt: p.paid_at ?? p.created_at, hasIntake: Boolean(p.has_intake), sprint: { plan_held_at: p.s_plan_held_at, outcome: p.s_outcome, proposal_sent_at: p.s_proposal_sent_at }, now });
    if (!due.length) continue;
    const done = await rt.env.DB.prepare(`SELECT step FROM emails WHERE lead_id = ? AND sequence = ? AND status IN ('sent', 'simulated', 'sending', 'skipped', 'cancelled')`).bind(p.lead_id, SEQUENCE).all<{ step: number }>();
    const todo = due.filter((d) => !done.results.some((r) => r.step === d.step));
    if (!todo.length) continue;
    const lead = await getLead(rt.env, p.lead_id);
    if (!lead?.email) continue;
    const ctx = await ctxFor(rt, p, lead, await tokenFor(rt, p));
    for (const d of todo) {
      const marketing = d.kind.startsWith('proposal');
      if (marketing && lead.unsubscribed_at) continue;
      if (await deliver(rt, lead, d.step, `deal_sprint_${d.kind}`, dealSprintEmail(d.kind, ctx), { unsubscribe: marketing })) sent++;
    }
  }
  return { sent };
}

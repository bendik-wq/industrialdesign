import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import type { Settings } from '../settings';
import { render } from '../funnel/pages';
import { sameOriginWrite } from '../admin/auth';
import { type Lead, getLead } from '../funnel/leads';
import { REVENUE_LABEL } from '../sales/qualify';
import { identityFromLead, track } from '../tracking/track';
import { getRegistration, webinarBase } from './webinar';
import { blueprintUrl } from './blueprint';
import { type PassRow, activePass, formatMoney, fromMinor, packUrl, passConfig } from './pass';

/**
 * Delivering the First Deal Sprint (the $3,000, 7-day product sold in the masterclass) and moving buyers to
 * the advisory engagement. A paid Sprint is a webinar_passes row (kind 'offer', status 'paid'); everything
 * here hangs off its id:
 *
 *  - the buyer's Sprint page /sprint/<registration token>: a Day 1 to Day 7 tracker, the intake form,
 *    the kickoff and Deal Plan session booking links, the deal pack and blueprint, the guarantee;
 *  - Funnel HQ → Sprint board: the team fills in each deliverable (marking one ready emails the buyer),
 *    the calls, the outcome and the engagement agreement (deal-sprint-emails.ts, admin/deal-sprint.ts).
 *
 * Named deal_sprint / dealSprint throughout: "sprint" alone is the unrelated YouTube content sprint.
 */

const DAY = 86_400_000;
export const SPRINT_DAYS = 7;

export function dealSprintConfig(s: Partial<Settings>) {
  const https = (v: unknown) => (/^https:\/\/\S+$/i.test(String(v ?? '').trim()) ? String(v).trim() : null);
  return {
    kickoffUrl: https(s.DEAL_SPRINT_KICKOFF_URL),
    /** The Day 7 Deal Plan session: its own link, else the offer session link. */
    planUrl: https(s.DEAL_SPRINT_PLAN_URL) ?? https(s.WEBINAR_OFFER_SESSION_URL),
  };
}

export interface Deliverable { key: string; day: number; title: string; body: string; bonus?: boolean }

/** What the team delivers, in the order of the stack sold in the room. Keep in sync with the offer's perks. */
export const DEAL_SPRINT_DELIVERABLES: Deliverable[] = [
  { key: 'capacity', day: 2, title: 'Acquisition capacity', body: 'The debt your profit carries at 1.5x coverage, and the size of target that supports.' },
  { key: 'buy_box', day: 3, title: 'Your buy box', body: 'What to buy first: the industry, size and location, and how it fits what you already run.' },
  { key: 'shortlist', day: 4, title: 'A first shortlist', body: 'Owner-run businesses that match your buy box.' },
  { key: 'structure_memo', day: 5, title: 'Deal-structure memo', body: 'In writing, how a deal for that target splits across commercial debt, seller finance and seller rollover.' },
  { key: 'outreach_script', day: 6, title: 'Owner outreach script', body: 'What to say on the first call with an owner, and what they need to hear from you.' },
  { key: 'josh_review', day: 7, title: 'Josh reviews your Deal Plan personally', body: 'Josh reads your Deal Plan himself and adds his notes before the session.', bonus: true },
];
export const deliverableByKey = (key: string) => DEAL_SPRINT_DELIVERABLES.find((d) => d.key === key) ?? null;

export const DELIVERABLE_STATUSES = ['waiting', 'in_progress', 'ready'] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];
export const OUTCOMES = ['proposal_sent', 'signed', 'not_continuing', 'refunded'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Every visible string on the Sprint page (checked by auditCopy in the tests). */
export const DEAL_SPRINT_COPY = {
  eyebrow: 'Your seven days',
  lede: 'Seven days from your numbers to a plan for a first acquisition. Each piece appears here the day it is ready, and you get an email when it lands.',
  nextKickoff: 'First step: book your kickoff call.',
  nextKickoffEmail: 'First step: Josh’s team emails you within one business day to set your kickoff call.',
  nextIntake: 'Next: fill in the intake form below. The capacity review and the buy box are built from it.',
  nextPlan: 'Book your 60-minute Deal Plan session for Day 7.',
  nextWaiting: 'Your deliverables are being prepared. Each one appears below the day it is ready.',
  kickoffTitle: 'Kickoff call and intake',
  kickoffBody: 'We confirm your numbers, what you would buy first and what a good first deal looks like for you.',
  planTitle: 'Your 60-minute Deal Plan session',
  planBody: 'We go through the capacity review, the buy box, the shortlist and the structure memo, and agree the plan for your first deal.',
  planEmail: 'Josh’s team emails you to book it.',
  bookKickoff: 'Book my kickoff call',
  bookPlan: 'Book my Deal Plan session',
  intakeTitle: 'Intake form',
  intakeLede: 'About ten minutes. The more exact the numbers, the sharper the capacity review and the shortlist.',
  intakeSaved: 'Thank you. Your intake is saved and the team has it.',
  intakeMissing: 'Add at least your revenue and your industry, then save.',
  intakeButton: 'Save my intake',
  intakeUpdate: 'Update my intake',
  linksTitle: 'Already yours',
  packLink: 'Open my deal pack',
  blueprintLink: 'Open my Acquisition Blueprint',
  bonusTitle: 'Your fast-action bonus',
  guaranteeTitle: 'The guarantee',
  guarantee: 'If at the end of your Deal Plan session you don’t think the Sprint was worth far more than you paid, tell us and the full fee is refunded.',
  afterTitle: 'After Day 7',
  after: 'If you want to keep going, the advisory engagement continues the same deal with Josh’s team in the room: owner outreach, negotiation, lender introductions and the letter of intent.',
  credit: 'The full Sprint fee is credited against the engagement fee.',
  noResults: 'The Sprint is a plan and advice. It is not a promise of a deal, a loan or a return.',
  notFound: 'Your Sprint page opens once the First Deal Sprint is paid.',
  welcomePaid: 'Payment received. Your Sprint has started.',
  kickoffTopTitle: 'Book your kickoff call',
  kickoffTopLede: 'Pick a time that suits you. On the call Josh’s team confirms your numbers and what you would buy first.',
  kickoffNewTab: 'Open the calendar in a new tab',
  confirming: 'Your payment is still being confirmed. This page refreshes by itself in a few seconds.',
  preview: 'Preview with a made-up buyer. Real buyers see their own progress, intake and links.',
};

export const INTAKE_FIELDS: { key: string; label: string; kind: 'text' | 'textarea' | 'url' | 'select'; placeholder?: string; options?: string[]; required?: boolean }[] = [
  { key: 'revenue', label: 'Yearly revenue', kind: 'text', placeholder: 'e.g. $4.2M', required: true },
  { key: 'ebitda', label: 'Yearly EBITDA (profit before interest, tax and depreciation)', kind: 'text', placeholder: 'e.g. $650k' },
  { key: 'industry', label: 'Industry', kind: 'text', placeholder: 'e.g. commercial HVAC', required: true },
  { key: 'locations', label: 'Locations', kind: 'text', placeholder: 'e.g. 3 sites in Texas' },
  { key: 'buy_what', label: 'What you would buy first', kind: 'textarea', placeholder: 'A competitor, a supplier, a business in the next town over…' },
  { key: 'cash', label: 'Cash you would put into a first deal', kind: 'text', placeholder: 'e.g. $150k, or none' },
  { key: 'timeline', label: 'When you want a first deal closed', kind: 'select', options: ['Within 6 months', '6 to 12 months', '12 months or more', 'Not sure yet'] },
  { key: 'financials_url', label: 'Link to your last two years of financial statements', kind: 'url', placeholder: 'https:// (a shared Google Drive or Dropbox folder)' },
  { key: 'notes', label: 'Anything else we should know', kind: 'textarea' },
];

// ───────────── Rows ─────────────

export interface DealSprintRow {
  pass_id: string; lead_id: string; kickoff_booked_at: number | null; kickoff_held_at: number | null; plan_booked_at: number | null; plan_held_at: number | null;
  outcome: Outcome | null; outcome_at: number | null; proposal_sent_at: number | null; engagement_fee: number | null; contract_id: string | null; notes: string | null;
  created_at: number; updated_at: number;
}
export interface DeliverableRow { pass_id: string; key: string; status: DeliverableStatus; link: string | null; notes: string | null; ready_at: number | null; emailed_at: number | null; updated_at: number }
export type IntakeRow = Record<(typeof INTAKE_FIELDS)[number]['key'], string | null> & { pass_id: string; lead_id: string; submitted_at: number; updated_at: number };

/** Part 2 adds a fast_bonus column to webinar_passes; read it without depending on it. */
export const hasFastBonus = (p: object) => Number((p as Record<string, unknown>).fast_bonus) > 0;
/** Day 1 is the day they paid; never below 1. */
export const sprintDay = (paidAt: number, now = Date.now()) => Math.max(1, Math.floor((now - paidAt) / DAY) + 1);
export const dealSprintUrl = (rt: Runtime, token: string) => `${webinarBase(rt)}/sprint/${token}`;

export async function ensureDealSprint(rt: Runtime, pass: Pick<PassRow, 'id' | 'lead_id'>) {
  const now = Date.now();
  await rt.env.DB.prepare('INSERT OR IGNORE INTO deal_sprints (pass_id, lead_id, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(pass.id, pass.lead_id, now, now).run();
  return (await rt.env.DB.prepare('SELECT * FROM deal_sprints WHERE pass_id = ?').bind(pass.id).first<DealSprintRow>())!;
}

export async function sprintParts(rt: Runtime, passId: string) {
  const db = rt.env.DB;
  const [sprint, dels, intake] = await Promise.all([
    db.prepare('SELECT * FROM deal_sprints WHERE pass_id = ?').bind(passId).first<DealSprintRow>(),
    db.prepare('SELECT * FROM deal_sprint_deliverables WHERE pass_id = ?').bind(passId).all<DeliverableRow>(),
    db.prepare('SELECT * FROM deal_sprint_intake WHERE pass_id = ?').bind(passId).first<IntakeRow>(),
  ]);
  return { sprint, deliverables: new Map(dels.results.map((d) => [d.key, d])), intake };
}

// ───────────── The buyer's page ─────────────

export interface PortalView {
  name: string | null; product: string; day: number; fastBonus: boolean; preview: boolean; note: string | null;
  /** Just back from checkout (?welcome=1). */
  welcome?: boolean;
  /** The registration token (the inline calendar reports a booked kickoff with it). */
  token?: string;
  /** The kickoff calendar to embed at the top (a Calendly link, name and email filled in), or null for a button. */
  kickoffEmbed?: string | null;
  kickoff: { booked: boolean; held: boolean; url: string | null };
  plan: { booked: boolean; held: boolean; url: string | null };
  deliverables: (Deliverable & { status: DeliverableStatus; link: string | null; notes: string | null })[];
  intake: Partial<IntakeRow> | null;
  links: { pack: string; blueprint: string };
  credit: string | null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STATUS_LABEL: Record<string, string> = { waiting: 'Waiting', in_progress: 'In progress', ready: 'Ready', booked: 'Booked', done: 'Done', received: 'Received' };
const pill = (s: string) => `<span class="ds-pill ds-s-${esc(s)}">${esc(STATUS_LABEL[s] ?? s)}</span>`;
const paras = (s: string) => esc(s).replace(/\r?\n/g, '<br>');

// The Sprint page in the buyer pages' calm system: one card for the one action, then quiet hairline sections.
const STYLE = `<style>
.ds{--i:#1d1d1f;--i2:#6e6e73;--i3:#86868b;--h:rgba(0,0,0,.1);--f:#f5f5f7;--n:#0f2c5c;--ok:#1d7a4f;--ui:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Inter,Arial,sans-serif;font-family:var(--ui);color:var(--i);-webkit-font-smoothing:antialiased}
.worksheet:has(.ds) .ws-actions{display:none}
.ds p{margin:0}.ds a{color:var(--n);text-decoration:none}.ds a:hover{text-decoration:underline}
.ds .ds-top{margin:8px 0 24px;font:500 14px/1.4 var(--ui);color:var(--i3);text-align:center}
.ds-head{margin:8px 0 32px}.ds-head h1{font:500 clamp(30px,4vw,44px)/1.1 var(--serif);letter-spacing:-.02em;margin:0 0 8px}.ds-head .lede{font:400 17px/1.5 var(--ui);color:var(--i2);max-width:none}
.ds-card{background:var(--f);border-radius:28px;padding:48px 40px 40px;text-align:center;margin:0 0 48px}
.ds-ok{display:inline-flex;align-items:center;gap:6px;font:600 14px/1.2 var(--ui);color:var(--ok);margin:0 0 16px!important}.ds-ok svg{width:16px;height:16px}
.ds-card h1,.ds-card h2{font:500 clamp(30px,4vw,44px)/1.08 var(--serif);letter-spacing:-.02em;margin:0 0 12px;color:var(--i)}
.ds-card .ds-lede{font:400 17px/1.5 var(--ui);color:var(--i2);max-width:440px;margin:0 auto 32px}
.ds-go{display:inline-flex;align-items:center;justify-content:center;min-height:56px;padding:0 32px;border-radius:999px;background:var(--n);color:#fff!important;font:600 17px/1.2 var(--ui);text-decoration:none!important;width:100%;max-width:420px;box-sizing:border-box}
.ds-go:hover{background:#163a76}
.ds-cal{position:relative;width:100%;height:700px;border-radius:16px;overflow:hidden;background:#fff;text-align:left}.ds-cal iframe{width:100%;height:100%;border:0}
.ds-card .ds-alt{margin-top:16px!important;font:400 14px/1.4 var(--ui);color:var(--i3)}
.ds-next{margin:0 0 40px;padding:20px 0;border-top:1px solid var(--h);border-bottom:1px solid var(--h);font:400 15px/1.5 var(--ui);color:var(--i2)}
.ds-next p{margin:0 0 12px}.ds-next p:last-child{margin:0}
.ds-sec{padding:32px 0;border-top:1px solid var(--h)}.ds-sec h2{font:600 19px/1.3 var(--ui);letter-spacing:-.01em;margin:0 0 12px;color:var(--i)}.ds-sec>p{font:400 15px/1.55 var(--ui);color:var(--i2)}
.ds-days{list-style:none;padding:0;margin:0}.ds-day{display:grid;grid-template-columns:64px 1fr;gap:16px;padding:16px 0;border-top:1px solid var(--h)}.ds-day:first-child{border-top:0}
.ds-dn{font:500 13px/1.6 var(--ui);color:var(--i3)}.ds-day.today .ds-dn{color:var(--n);font-weight:600}
.ds-item{margin:0 0 12px}.ds-item:last-child{margin-bottom:0}.ds-item h3{font:600 15px/1.4 var(--ui);margin:0 0 2px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.ds-item p{font:400 14px/1.5 var(--ui);color:var(--i2);margin:0 0 6px}
.ds-ready{margin-top:6px;overflow-wrap:anywhere;font:400 14px/1.5 var(--ui)}
.ds-pill{display:inline-block;font:500 12px/1 var(--ui);padding:4px 8px;border-radius:999px;background:var(--f);color:var(--i2)}
.ds-s-ready,.ds-s-done,.ds-s-received{color:var(--ok);background:#eaf6ef}.ds-s-in_progress,.ds-s-booked{color:#7a5200;background:#fff6e0}
.ds-form{display:grid;gap:16px;margin-top:16px}.ds-form label{display:grid;gap:6px;font:500 14px/1.35 var(--ui);color:var(--i)}
.ds-form .input{width:100%;box-sizing:border-box;font:400 16px/1.3 var(--ui);background:var(--f);border:1px solid transparent;border-radius:10px;padding:12px 14px;min-height:48px}.ds-form textarea.input{min-height:88px}
.ds-form .input:focus{outline:none;background:#fff;border-color:var(--n);box-shadow:0 0 0 3px rgba(15,44,92,.15)}
.ds-form .btn,.ds-links .btn{border-radius:999px;box-shadow:none;background:var(--n);border-color:var(--n);color:#fff;justify-self:start}.ds-form .btn::after,.ds-links .btn::after{display:none}
.ds-links{display:flex;flex-wrap:wrap;gap:16px}.ds-links .btn{background:none;color:var(--n);border:0;padding:0;font:500 15px/1.4 var(--ui)}
.ds-day .btn{border-radius:999px;box-shadow:none}.ds-day .btn::after{display:none}
.ds-note{background:#eaf6ef;color:#14532d;border-radius:12px;padding:12px 16px;font:400 14px/1.5 var(--ui);margin:0 0 24px!important}.ds-note.warn{background:#fff6e0;color:#6b4a00}
.ds-rest{border-top:1px solid var(--h)}.ds-rest>summary{cursor:pointer;list-style:none;padding:20px 0;text-align:center;font:500 15px/1.4 var(--ui);color:var(--n)}.ds-rest>summary::-webkit-details-marker{display:none}.ds-rest[open]>summary{padding-bottom:0}
.ds-disc{margin:32px 0 0!important;font:400 12px/1.5 var(--ui);color:var(--i3)}
@media (max-width:560px){.ds-day{grid-template-columns:1fr;gap:4px}.ds-card{padding:36px 20px 28px;border-radius:22px}}
</style>`;
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/** The page body (pure, for the tests and the preview). */
export function portalHtml(v: PortalView) {
  const t = DEAL_SPRINT_COPY;
  const today = Math.min(v.day, SPRINT_DAYS);
  const kickoffStatus = v.kickoff.held ? 'done' : v.kickoff.booked ? 'booked' : 'waiting';
  const planStatus = v.plan.held ? 'done' : v.plan.booked ? 'booked' : 'waiting';
  const btn = (href: string, label: string, cls = '') => `<a class="btn btn-sm${cls}" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  // Until the kickoff is booked, the page opens on booking it: the calendar inline (Calendly), else a big button.
  const kickoffOpen = !v.kickoff.booked && !v.kickoff.held;
  const kickoffTop = kickoffOpen && v.kickoff.url
    ? `<section class="ds-card" id="kickoff" data-kickoff="${esc(v.token ?? '')}">${v.welcome ? `<p class="ds-ok" role="status">${CHECK}${esc(t.welcomePaid)}</p>` : ''}
      <h1>${esc(t.kickoffTopTitle)}</h1><p class="ds-lede">${esc(t.kickoffTopLede)}</p>
      ${v.kickoffEmbed
        ? `<div class="ds-cal" data-kickoff-cal><iframe src="${esc(v.kickoffEmbed)}" title="${esc(t.kickoffTopTitle)}" loading="eager"></iframe></div><p class="ds-alt"><a href="${esc(v.kickoff.url)}" target="_blank" rel="noopener">${esc(t.kickoffNewTab)}</a></p>`
        : `<a class="ds-go" href="${esc(v.kickoff.url)}" target="_blank" rel="noopener" data-kickoff-link>${esc(t.bookKickoff)}</a>`}</section>`
    : v.welcome ? `<p class="ds-note" role="status">${esc(t.welcomePaid)}</p>` : '';
  const next =kickoffOpen && !v.kickoff.url
    ? `<p>${esc(t.nextKickoffEmail)}</p>`
    : kickoffOpen && !v.intake ? `<p>${esc(t.nextIntake)}</p><a class="btn btn-sm" href="#intake">${esc(t.intakeTitle)}</a>`
    : kickoffOpen ? `<p>${esc(t.nextWaiting)}</p>`
    : !v.intake ? `<p>${esc(t.nextIntake)}</p><a class="btn btn-sm" href="#intake">${esc(t.intakeTitle)}</a>`
      : !v.plan.booked && !v.plan.held && v.day >= 4 ? `<p>${esc(t.nextPlan)}</p>${v.plan.url ? btn(v.plan.url, t.bookPlan) : `<p>${esc(t.planEmail)}</p>`}`
        : `<p>${esc(t.nextWaiting)}</p>`;
  const item = (title: string, body: string, status: string, extra = '') =>
    `<div class="ds-item"><h3>${esc(title)} ${pill(status)}</h3><p>${esc(body)}</p>${extra}</div>`;
  const delivered = (d: PortalView['deliverables'][number]) =>
    d.status === 'ready' && (d.link || d.notes)
      ? `<div class="ds-ready">${d.notes ? `<p>${paras(d.notes)}</p>` : ''}${d.link ? `<a href="${esc(d.link)}" target="_blank" rel="noopener">Open the document</a>` : ''}</div>`
      : '';
  const days = Array.from({ length: SPRINT_DAYS }, (_, i) => i + 1).map((day) => {
    const items: string[] = [];
    if (day === 1) {
      items.push(item(t.kickoffTitle, t.kickoffBody, kickoffStatus, '' /* booked from the card at the top */));
      items.push(item(t.intakeTitle, t.intakeLede, v.intake ? 'received' : 'waiting', v.intake ? '' : '<a href="#intake">Fill it in below</a>'));
    }
    for (const d of v.deliverables.filter((x) => x.day === day && (!x.bonus || v.fastBonus))) items.push(item(d.title, d.body, d.status, delivered(d)));
    if (day === SPRINT_DAYS) items.push(item(t.planTitle, t.planBody, planStatus, !v.plan.booked && !v.plan.held ? (v.plan.url ? btn(v.plan.url, t.bookPlan, ' secondary') : `<p>${esc(t.planEmail)}</p>`) : ''));
    return items.length ? `<li class="ds-day${day === today ? ' today' : ''}"><span class="ds-dn">Day ${day}</span><div>${items.join('')}</div></li>` : '';
  }).join('');
  const val = (k: string) => esc(String((v.intake as Record<string, unknown> | null)?.[k] ?? ''));
  const off = v.preview ? ' disabled title="Preview: can’t submit"' : '';
  const fields = INTAKE_FIELDS.map((f) => {
    const attrs = `name="${f.key}"${f.required ? ' required' : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}`;
    const input = f.kind === 'textarea' ? `<textarea class="input" ${attrs} maxlength="2000">${val(f.key)}</textarea>`
      : f.kind === 'select' ? `<select class="input" name="${f.key}"><option value="">Choose one</option>${(f.options ?? []).map((o) => `<option${val(f.key) === esc(o) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
        : `<input class="input" type="${f.kind === 'url' ? 'url' : 'text'}" ${attrs} maxlength="${f.kind === 'url' ? 500 : 200}" value="${val(f.key)}">`;
    return `<label>${esc(f.label)}${input}</label>`;
  }).join('');
  // Not filled in yet (a one-click buyer skipped the form before paying): the questions sit right under the
  // kickoff booking. Once saved, the form moves below the seven days for updates.
  const intake = `<section class="ds-sec" id="intake"><h2>${esc(t.intakeTitle)}</h2><p>${esc(t.intakeLede)}</p>
    <form class="ds-form" method="post">${fields}<button class="btn" type="submit"${off}>${esc(v.intake ? t.intakeUpdate : t.intakeButton)}</button></form></section>`;
  const dayLine = v.day > SPRINT_DAYS ? 'All seven days are done.' : `Day ${v.day} of ${SPRINT_DAYS}.`;
  const sec = (title: string, body: string, id = '') => `<section class="ds-sec"${id ? ` id="${id}"` : ''}><h2>${esc(title)}</h2>${body}</section>`;
  // While the kickoff waits to be booked, that is the one card on the page; the rest sits quietly below it.
  return `${STYLE}<div class="ds">${v.preview ? `<p class="ds-top">${esc(t.preview)}</p>` : ''}
  ${kickoffTop
    ? `<p class="ds-top">${v.name ? `${esc(v.name)} · ` : ''}${esc(v.product)} · ${dayLine}</p>`
    : `<header class="ds-head"><h1>${v.name ? `${esc(v.name)}, your` : 'Your'} ${esc(v.product)}</h1><p class="lede">${dayLine} ${esc(t.lede)}</p></header>`}
  ${v.note ? `<p class="ds-note${v.note === t.intakeMissing ? ' warn' : ''}" role="status">${esc(v.note)}</p>` : ''}
  ${kickoffTop}
  ${v.intake ? '' : intake}
  ${kickoffTop ? '<details class="ds-rest"><summary>Your seven days, your links and the guarantee</summary>' : `<div class="ds-next">${next}</div>`}
  ${sec(t.eyebrow, `<ol class="ds-days">${days}</ol>`)}
  ${v.intake ? intake : ''}
  ${sec(t.linksTitle, `<p class="ds-links">${btn(v.links.pack, t.packLink, ' secondary')} ${btn(v.links.blueprint, t.blueprintLink, ' secondary')}</p>`)}
  ${v.fastBonus ? sec(t.bonusTitle, `<p>${esc(DEAL_SPRINT_DELIVERABLES.find((d) => d.bonus)!.title)}. ${esc(DEAL_SPRINT_DELIVERABLES.find((d) => d.bonus)!.body)}</p>`) : ''}
  ${sec(t.guaranteeTitle, `<p>${esc(t.guarantee)}</p>`)}
  ${sec(t.afterTitle, `<p>${esc(t.after)} ${esc(v.credit ? `${t.credit.replace('The full Sprint fee', `The full ${v.credit}`)}` : t.credit)}</p>`)}
  ${kickoffTop ? '</details>' : ''}
  <p class="ds-disc">${esc(t.noResults)} Education and advice, not legal, tax or financial advice.</p></div>`;
}

/** The made-up buyer for Funnel HQ → Page previews. Nothing is read or saved. */
export function samplePortal(rt: Runtime): PortalView {
  const cfg = dealSprintConfig(rt.settings);
  const status: Record<string, DeliverableStatus> = { capacity: 'ready', buy_box: 'ready', shortlist: 'in_progress' };
  return {
    name: 'Dana', product: passConfig(rt.settings).offerName, day: 4, fastBonus: true, preview: true, note: null,
    kickoff: { booked: true, held: true, url: cfg.kickoffUrl }, plan: { booked: false, held: false, url: cfg.planUrl },
    deliverables: DEAL_SPRINT_DELIVERABLES.map((d) => ({ ...d, status: status[d.key] ?? 'waiting', link: status[d.key] === 'ready' ? '#' : null, notes: d.key === 'capacity' ? 'Illustrative: at $500k of EBITDA, the profit carries about $2.1M of bank debt at 1.5x.' : null })),
    intake: { revenue: '$4.2M', ebitda: '$500k', industry: 'Commercial HVAC', locations: '2 sites', buy_what: 'A competitor in the next county', cash: '$100k', timeline: 'Within 6 months', financials_url: '', notes: '' },
    links: { pack: '#', blueprint: '#' }, credit: null,
  };
}

async function loadPortal(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const reg = await getRegistration(rt, c.req.param('token') ?? '');
  const pass = reg ? await activePass(rt, reg.lead_id) : null;
  return { rt, reg, pass };
}

/** A Calendly link as an inline embed with the buyer's name and email filled in; null for any other calendar. */
export function kickoffEmbedUrl(url: string | null, o: { name?: string | null; email?: string | null; host: string }) {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !/(^|\.)calendly\.com$/i.test(u.hostname)) return null;
  if (o.name) u.searchParams.set('name', o.name);
  if (o.email) u.searchParams.set('email', o.email);
  u.searchParams.set('embed_domain', o.host);
  u.searchParams.set('embed_type', 'Inline');
  u.searchParams.set('utm_source', 'sprint');
  return u.toString();
}

const worksheet = (c: Context<AppEnv>, body: string) => render(c, '/webinar-worksheet.html', { title: 'First Deal Sprint', blocks: { worksheet: body } });

export async function dealSprintPage(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  if (c.req.param('token') === 'preview' && c.get('visitor')?.botReason === 'admin-preview') {
    // ?welcome=1: just back from checkout, the kickoff still to book (the one card on the page).
    const s = samplePortal(rt);
    const fresh = c.req.query('welcome') === '1';
    return worksheet(c, portalHtml(fresh ? { ...s, welcome: true, day: 1, kickoff: { booked: false, held: false, url: s.kickoff.url ?? '#' }, deliverables: s.deliverables.map((d) => ({ ...d, status: 'waiting' as DeliverableStatus, link: null, notes: null })) } : s));
  }
  const loaded = await loadPortal(c);
  const { reg } = loaded;
  let { pass } = loaded;
  const welcome = c.req.query('welcome') === '1';
  if (reg && !pass && (welcome || c.req.query('pass') === 'success')) {
    // Back from checkout before the webhook: ask the payment provider directly.
    const { confirmOnReturn } = await import('./pass');
    if ((await confirmOnReturn(rt, reg)) === 'paid') pass = await activePass(rt, reg.lead_id);
    // A one-click payment that failed (3D Secure not passed, card declined): the normal form and checkout.
    if (!pass && !(await rt.env.DB.prepare("SELECT 1 FROM webinar_passes WHERE reg_id = ? AND kind = 'offer' AND status = 'pending'").bind(reg.id).first())
      && (await (await import('./one-click')).recentFailedOneClick(rt, reg.id))) {
      return c.redirect(`${webinarBase(rt)}/sprint-start/${reg.token}?one_click=declined`, 302);
    }
    if (!pass && (await rt.env.DB.prepare("SELECT 1 FROM webinar_passes WHERE reg_id = ? AND kind = 'offer' AND status = 'pending'").bind(reg.id).first())) {
      return render(c, '/webinar-worksheet.html', { title: 'First Deal Sprint', blocks: { worksheet: `<h1 class="h2">${esc(DEAL_SPRINT_COPY.kickoffTopTitle)}</h1><p class="lede" role="status">${esc(DEAL_SPRINT_COPY.confirming)}</p>` }, config: { webinar: { passConfirming: true } } });
    }
  }
  if (!reg || !pass) return worksheet(c, `<h1 class="h2">${esc(DEAL_SPRINT_COPY.notFound)}</h1>${reg ? `<p class="lede"><a href="${esc(`${webinarBase(rt)}/registered/${reg.token}`)}">Back to my confirmation</a></p>` : ''}`);
  // Answers from the form before checkout fill the intake (when the payment arrived some other way first).
  if (!(await rt.env.DB.prepare('SELECT 1 FROM deal_sprint_intake WHERE pass_id = ?').bind(pass.id).first())) {
    await (await import('./sprint-start')).copyApplicationToIntake(rt, pass).catch((e) => console.error('sprint intake copy failed', e));
  }
  const view = await portalView(rt, pass, reg.token);
  const lead = await getLead(rt.env, pass.lead_id);
  view.welcome = welcome;
  view.kickoffEmbed = kickoffEmbedUrl(view.kickoff.url, { name: [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || null, email: lead?.email ?? null, host: new URL(c.req.url).host });
  const q = c.req.query('intake');
  view.note = q === 'saved' ? DEAL_SPRINT_COPY.intakeSaved : q === 'missing' ? DEAL_SPRINT_COPY.intakeMissing : null;
  return worksheet(c, portalHtml(view));
}

export async function portalView(rt: Runtime, pass: PassRow, token: string): Promise<PortalView> {
  const cfg = dealSprintConfig(rt.settings);
  const [lead, parts] = await Promise.all([getLead(rt.env, pass.lead_id), sprintParts(rt, pass.id)]);
  const s = parts.sprint;
  return {
    token,
    name: lead?.first_name ?? null,
    product: pass.product || passConfig(rt.settings).offerName,
    day: sprintDay(pass.paid_at ?? pass.created_at),
    fastBonus: hasFastBonus(pass),
    preview: false, note: null,
    kickoff: { booked: Boolean(s?.kickoff_booked_at), held: Boolean(s?.kickoff_held_at), url: cfg.kickoffUrl },
    plan: { booked: Boolean(s?.plan_booked_at), held: Boolean(s?.plan_held_at), url: cfg.planUrl },
    deliverables: DEAL_SPRINT_DELIVERABLES.map((d) => {
      const r = parts.deliverables.get(d.key);
      const status = (r?.status ?? 'waiting') as DeliverableStatus;
      return { ...d, status, link: status === 'ready' ? r?.link ?? null : null, notes: status === 'ready' ? r?.notes ?? null : null };
    }),
    intake: parts.intake,
    links: { pack: packUrl(rt, token), blueprint: blueprintUrl(rt, token) },
    credit: pass.credit_amount > 0 ? `${formatMoney(fromMinor(pass.credit_amount, pass.currency), pass.currency.toUpperCase())} Sprint fee` : null,
  };
}

/** Clean what the intake form sent: short text only, the statements link only when it is https. */
export function cleanIntake(body: Record<string, unknown>) {
  const out: Record<string, string | null> = {};
  for (const f of INTAKE_FIELDS) {
    const raw = typeof body[f.key] === 'string' ? (body[f.key] as string).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim() : '';
    const max = f.kind === 'textarea' ? 2000 : f.kind === 'url' ? 500 : 200;
    let v: string | null = raw.slice(0, max) || null;
    if (f.kind === 'url' && v && !/^https:\/\/[^\s<>"']+$/i.test(v)) v = null;
    if (f.kind === 'select' && v && !f.options!.includes(v)) v = null;
    out[f.key] = v;
  }
  return { data: out, complete: INTAKE_FIELDS.every((f) => !f.required || out[f.key]) };
}

export async function saveIntake(rt: Runtime, pass: Pick<PassRow, 'id' | 'lead_id'>, data: Record<string, string | null>) {
  const now = Date.now();
  const keys = INTAKE_FIELDS.map((f) => f.key);
  const existed = await rt.env.DB.prepare('SELECT 1 FROM deal_sprint_intake WHERE pass_id = ?').bind(pass.id).first();
  await rt.env.DB.prepare(
    `INSERT INTO deal_sprint_intake (pass_id, lead_id, ${keys.join(', ')}, submitted_at, updated_at) VALUES (?, ?, ${keys.map(() => '?').join(', ')}, ?, ?)
     ON CONFLICT(pass_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`,
  ).bind(pass.id, pass.lead_id, ...keys.map((k) => data[k] ?? null), now, now).run();
  await ensureDealSprint(rt, pass);
  if (!existed) {
    await track(rt, await identityFromLead(rt.env, pass.lead_id), { name: 'deal_sprint_intake', source: 'server', props: { pass_id: pass.id }, localOnly: true }).catch(() => null);
    const lead = await getLead(rt.env, pass.lead_id);
    const { notifySlack } = await import('../integrations/notify');
    if (lead) rt.waitUntil(notifySlack(rt, lead, 'Sprint intake received', [`Revenue ${data.revenue ?? '–'} · EBITDA ${data.ebitda ?? '–'} · ${data.industry ?? '–'}`], 'hot_lead').catch((e) => console.error('intake slack failed', e)));
  }
  return { created: !existed };
}

/** The intake form posts here (same-origin only), then back to the page so a refresh can't resubmit. */
export async function dealSprintSubmit(c: Context<AppEnv>) {
  if (!sameOriginWrite(c)) return c.text('Forbidden', 403);
  const { rt, reg, pass } = await loadPortal(c);
  if (!reg || !pass) return c.redirect(c.req.path, 303);
  const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const { data, complete } = cleanIntake(form as Record<string, unknown>);
  if (!complete) return c.redirect(`${c.req.path}?intake=missing#intake`, 303);
  await saveIntake(rt, pass, data);
  return c.redirect(`${c.req.path}?intake=saved`, 303);
}

// ───────────── The team's side (Funnel HQ → Sprint board) ─────────────

const httpsLink = (v: unknown) => (typeof v === 'string' && /^https:\/\/[^\s<>"']+$/i.test(v.trim()) ? v.trim().slice(0, 500) : null);
const clipText = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) || null : null);

export async function passById(rt: Runtime, passId: string) {
  return rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE id = ? AND kind = 'offer' AND status IN ('paid', 'refunded')").bind(passId).first<PassRow>();
}

/** Calls, outcome, fee and notes. A ticked box keeps its first time; an unticked one clears it. */
export async function updateDealSprint(rt: Runtime, passId: string, body: Record<string, unknown>) {
  const pass = await passById(rt, passId);
  if (!pass) return { ok: false as const, error: 'Sprint not found.' };
  const s = await ensureDealSprint(rt, pass);
  const now = Date.now();
  const flag = (field: 'kickoff_booked_at' | 'kickoff_held_at' | 'plan_booked_at' | 'plan_held_at', key: string) =>
    key in body ? (body[key] ? s[field] ?? now : null) : s[field];
  const next = {
    kickoff_booked_at: flag('kickoff_booked_at', 'kickoff_booked'),
    kickoff_held_at: flag('kickoff_held_at', 'kickoff_held'),
    plan_booked_at: flag('plan_booked_at', 'plan_booked'),
    plan_held_at: flag('plan_held_at', 'plan_held'),
    outcome: s.outcome, outcome_at: s.outcome_at, proposal_sent_at: s.proposal_sent_at, engagement_fee: s.engagement_fee, notes: s.notes,
  };
  // Held implies booked.
  if (next.kickoff_held_at && !next.kickoff_booked_at) next.kickoff_booked_at = next.kickoff_held_at;
  if (next.plan_held_at && !next.plan_booked_at) next.plan_booked_at = next.plan_held_at;
  if ('outcome' in body) {
    const o = OUTCOMES.includes(body.outcome as Outcome) ? (body.outcome as Outcome) : null;
    if (o !== s.outcome) { next.outcome = o; next.outcome_at = o ? now : null; }
    if (o === 'proposal_sent' && !s.proposal_sent_at) next.proposal_sent_at = now;
  }
  if ('engagement_fee' in body) {
    const f = Math.round(Number(body.engagement_fee));
    next.engagement_fee = body.engagement_fee === '' || body.engagement_fee == null ? null : Number.isFinite(f) && f >= 0 && f <= 100_000_000 ? f : s.engagement_fee;
  }
  if ('notes' in body) next.notes = clipText(body.notes, 4000);
  await rt.env.DB.prepare(
    `UPDATE deal_sprints SET kickoff_booked_at = ?, kickoff_held_at = ?, plan_booked_at = ?, plan_held_at = ?, outcome = ?, outcome_at = ?, proposal_sent_at = ?, engagement_fee = ?, notes = ?, updated_at = ? WHERE pass_id = ?`,
  ).bind(next.kickoff_booked_at, next.kickoff_held_at, next.plan_booked_at, next.plan_held_at, next.outcome, next.outcome_at, next.proposal_sent_at, next.engagement_fee, next.notes, now, passId).run();
  if (next.outcome === 'proposal_sent' && s.outcome !== 'proposal_sent') {
    await track(rt, await identityFromLead(rt.env, pass.lead_id), { name: 'deal_sprint_proposal_sent', source: 'admin', props: { pass_id: passId, fee: next.engagement_fee }, localOnly: true }).catch(() => null);
  }
  return { ok: true as const };
}

/** One deliverable's status, link and notes. Moving it to ready emails the buyer once. */
export async function updateDeliverable(rt: Runtime, passId: string, key: string, body: Record<string, unknown>) {
  const d = deliverableByKey(key);
  if (!d) return { ok: false as const, error: 'Unknown deliverable.' };
  const pass = await passById(rt, passId);
  if (!pass) return { ok: false as const, error: 'Sprint not found.' };
  await ensureDealSprint(rt, pass);
  const db = rt.env.DB;
  const cur = await db.prepare('SELECT * FROM deal_sprint_deliverables WHERE pass_id = ? AND key = ?').bind(passId, key).first<DeliverableRow>();
  const status: DeliverableStatus = DELIVERABLE_STATUSES.includes(body.status as DeliverableStatus) ? (body.status as DeliverableStatus) : cur?.status ?? 'waiting';
  if ('link' in body && body.link && !httpsLink(body.link)) return { ok: false as const, error: 'The link must start with https://' };
  const link = 'link' in body ? httpsLink(body.link) : cur?.link ?? null;
  const notes = 'notes' in body ? clipText(body.notes, 4000) : cur?.notes ?? null;
  const now = Date.now();
  const readyAt = status === 'ready' ? cur?.ready_at ?? now : null;
  await db.prepare(
    `INSERT INTO deal_sprint_deliverables (pass_id, key, status, link, notes, ready_at, emailed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(pass_id, key) DO UPDATE SET status = excluded.status, link = excluded.link, notes = excluded.notes, ready_at = excluded.ready_at, updated_at = excluded.updated_at`,
  ).bind(passId, key, status, link, notes, readyAt, now).run();
  let emailed = false;
  if (status === 'ready' && !cur?.emailed_at && pass.status === 'paid') {
    const { sendDeliverableReady } = await import('./deal-sprint-emails');
    emailed = await sendDeliverableReady(rt, pass, d, { link, notes });
    if (emailed) await db.prepare('UPDATE deal_sprint_deliverables SET emailed_at = ? WHERE pass_id = ? AND key = ?').bind(now, passId, key).run();
  }
  return { ok: true as const, emailed };
}

/** "Draft engagement agreement": the open agreement for this buyer, or a new draft quoted from their size with the Sprint credit. */
export async function draftEngagement(rt: Runtime, passId: string) {
  const pass = await passById(rt, passId);
  if (!pass) return { ok: false as const, error: 'Sprint not found.' };
  const lead = await getLead(rt.env, pass.lead_id);
  if (!lead) return { ok: false as const, error: 'Lead not found.' };
  const s = await ensureDealSprint(rt, pass);
  const existing = await rt.env.DB.prepare(
    "SELECT id FROM contracts WHERE lead_id = ? AND status IN ('draft', 'sent', 'viewed', 'signed') AND COALESCE(is_test, 0) = 0 AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
  ).bind(lead.id, pass.paid_at ?? pass.created_at).first<{ id: string }>();
  let id = existing?.id ?? null;
  if (!id) {
    const k = await createEngagementDraft(rt, lead, s.engagement_fee);
    if (!k) return { ok: false as const, error: 'Couldn’t create the agreement.' };
    id = k.id;
  }
  const k = await rt.env.DB.prepare('SELECT id, fee FROM contracts WHERE id = ?').bind(id).first<{ id: string; fee: number }>();
  await rt.env.DB.prepare('UPDATE deal_sprints SET contract_id = ?, engagement_fee = COALESCE(engagement_fee, ?), updated_at = ? WHERE pass_id = ?').bind(id, k?.fee ?? null, Date.now(), passId).run();
  return { ok: true as const, contractId: id, created: !existing };
}

export async function createEngagementDraft(rt: Runtime, lead: Lead, fee: number | null) {
  const { autoQuote, createContract, FEE_BY_REVENUE } = await import('../sales/contracts');
  const { APP_REVENUE_BAND } = await import('../sales/qualify');
  const q = autoQuote(rt, lead);
  // Sprint buyers often came from the masterclass without an application: their registration's revenue band sets the floor.
  const answer = Object.entries(APP_REVENUE_BAND).find(([, b]) => b === lead.revenue_band)?.[0];
  const quoted = Math.max(q.fee, (answer && FEE_BY_REVENUE[answer]) || 0);
  return createContract(rt, lead, { ...q, fee: fee && fee > 0 ? fee : quoted, client_company: null });
}

/** An engagement agreement was signed: the buyer's Sprint shows it, and the proposal follow-ups stop. */
export async function dealSprintSigned(rt: Runtime, c: { id: string; lead_id: string; fee: number; is_test?: number | null }) {
  if (c.is_test || !c.lead_id) return;
  const pass = await rt.env.DB.prepare("SELECT * FROM webinar_passes WHERE lead_id = ? AND kind = 'offer' AND status IN ('paid', 'refunded') ORDER BY paid_at DESC LIMIT 1").bind(c.lead_id).first<PassRow>();
  if (!pass) return;
  await ensureDealSprint(rt, pass);
  const now = Date.now();
  await rt.env.DB.prepare("UPDATE deal_sprints SET outcome = 'signed', outcome_at = ?, contract_id = ?, engagement_fee = ?, updated_at = ? WHERE pass_id = ?").bind(now, c.id, c.fee, now, pass.id).run();
}

/** Every Sprint buyer with their progress, newest first. */
export async function dealSprintBoard(rt: Runtime, now = Date.now()) {
  const db = rt.env.DB;
  const { results } = await db.prepare(
    `SELECT p.*, l.first_name, l.last_name, l.email, COALESCE(r.revenue_band, l.revenue_band) AS band, r.token AS reg_token
       FROM webinar_passes p JOIN leads l ON l.id = p.lead_id LEFT JOIN webinar_registrations r ON r.id = p.reg_id
      WHERE p.kind = 'offer' AND p.status IN ('paid', 'refunded') ORDER BY p.paid_at DESC LIMIT 200`,
  ).all<PassRow & Record<string, unknown>>();
  const ids = results.map((r) => r.id);
  const inList = ids.map(() => '?').join(',') || "''";
  const [sprints, dels, intakes, contracts] = await Promise.all([
    db.prepare(`SELECT * FROM deal_sprints WHERE pass_id IN (${inList})`).bind(...ids).all<DealSprintRow>(),
    db.prepare(`SELECT * FROM deal_sprint_deliverables WHERE pass_id IN (${inList})`).bind(...ids).all<DeliverableRow>(),
    db.prepare(`SELECT * FROM deal_sprint_intake WHERE pass_id IN (${inList})`).bind(...ids).all<IntakeRow>(),
    db.prepare(`SELECT id, lead_id, status, fee, currency, credit_amount, paid_at, signed_at, created_at FROM contracts WHERE COALESCE(is_test, 0) = 0 AND status != 'void' AND lead_id IN (SELECT lead_id FROM webinar_passes WHERE id IN (${inList}))`).bind(...ids).all<Record<string, unknown>>(),
  ]);
  const cfg = dealSprintConfig(rt.settings);
  return {
    config: { kickoffUrl: cfg.kickoffUrl, planUrl: cfg.planUrl, days: SPRINT_DAYS, deliverables: DEAL_SPRINT_DELIVERABLES, outcomes: OUTCOMES },
    sprints: results.map((p) => {
      const s = sprints.results.find((x) => x.pass_id === p.id) ?? null;
      const k = s?.contract_id ? contracts.results.find((x) => x.id === s.contract_id) : contracts.results.filter((x) => x.lead_id === p.lead_id && Number(x.created_at) >= Number(p.paid_at ?? 0)).sort((a, b) => Number(b.created_at) - Number(a.created_at))[0];
      const bonus = hasFastBonus(p);
      return {
        id: p.id, lead_id: p.lead_id, status: p.status, product: p.product,
        name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || 'Someone', email: p.email,
        band: p.band ? REVENUE_LABEL[String(p.band)] ?? p.band : null,
        paid: formatMoney(fromMinor(p.amount, p.currency), p.currency.toUpperCase()), paid_at: p.paid_at,
        credit: p.credit_amount ? formatMoney(fromMinor(p.credit_amount, p.currency), p.currency.toUpperCase()) : null,
        plan: payPlanOf(p),
        day: sprintDay(p.paid_at ?? p.created_at, now), fast_bonus: bonus,
        portal: p.reg_token ? dealSprintUrl(rt, String(p.reg_token)) : null,
        intake: intakes.results.find((x) => x.pass_id === p.id) ?? null,
        kickoff_booked_at: s?.kickoff_booked_at ?? null, kickoff_held_at: s?.kickoff_held_at ?? null,
        plan_booked_at: s?.plan_booked_at ?? null, plan_held_at: s?.plan_held_at ?? null,
        outcome: p.status === 'refunded' ? 'refunded' : s?.outcome ?? null, outcome_at: s?.outcome_at ?? null, proposal_sent_at: s?.proposal_sent_at ?? null,
        engagement_fee: s?.engagement_fee ?? (k ? Number(k.fee) : null), notes: s?.notes ?? null,
        contract: k ? { id: k.id, status: k.status, fee: k.fee, currency: k.currency, credit: k.credit_amount, paid_at: k.paid_at, signed_at: k.signed_at } : null,
        deliverables: DEAL_SPRINT_DELIVERABLES.filter((d) => !d.bonus || bonus).map((d) => {
          const r = dels.results.find((x) => x.pass_id === p.id && x.key === d.key);
          return { key: d.key, title: d.title, day: d.day, status: r?.status ?? 'waiting', link: r?.link ?? null, notes: r?.notes ?? null, ready_at: r?.ready_at ?? null, emailed_at: r?.emailed_at ?? null };
        }),
      };
    }),
  };
}

/** Part 2's payment plan, if it stores one on the pass: 'plan' or 'full' (null when no such column exists). */
export function payPlanOf(p: object): 'plan' | 'full' | null {
  const r = p as Record<string, unknown>;
  const col = ['payment_plan', 'pay_plan', 'plan', 'installments', 'plan_installments'].find((k) => k in r);
  if (!col) return null;
  const v = r[col];
  return v == null || v === 0 || v === '' || /^(0|1|full|pif|pay_in_full|one|single)$/i.test(String(v)) ? 'full' : 'plan';
}

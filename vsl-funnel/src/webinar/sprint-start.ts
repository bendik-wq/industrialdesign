import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { render } from '../funnel/pages';
import { sameOriginWrite } from '../admin/auth';
import { REVENUE_LABEL } from '../sales/qualify';
import { identityFromLead, track } from '../tracking/track';
import { type Registration, type Session, getRegistration, getSession, roomUrl } from './webinar';
import { type PassRow, PassError, activePass } from './pass';
import {
  createSprintCheckout, mmss, offerDeadline, offerUrl, pitchSec, reachedPitch, sprintCopy, sprintPrice, sprintQualified, sprintSettings, sprintWelcomeUrl, sprintWindow, ticketCredit,
  unlockSprint,
} from './sprint';
import { INTAKE_FIELDS, dealSprintUrl, ensureDealSprint } from './deal-sprint';

/**
 * The pay-first First Deal Sprint (the owner's order: form, then pay, then book).
 *
 * Every "Start my First Deal Sprint" button (the room panel, the offer page) opens /sprint-start/:token: a
 * short form about the business, gated exactly like checkout (the offer unlocked for this registration and
 * its deadline not passed). Submitting it (same-origin only) saves the answers and goes straight to checkout
 * (Whop, or Stripe). After paying, Whop returns the buyer to /sprint/:token?welcome=1, which opens on the
 * kickoff booking. The answers are copied into the Sprint's intake when it is paid, so nothing is typed twice.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
type RegLike = Registration & { offer_unlocked_at?: number | null };

/** The bands a Sprint buyer can be in ($1M and up), as the funnel labels them. */
export const REVENUE_OPTIONS = ['1m-3m', '3m-10m', '10m-25m', '25m-50m', '50m-100m', '100m+'].map((k) => REVENUE_LABEL[k]);
const ANY_BAND = new Set(Object.values(REVENUE_LABEL));
const TIMELINES = INTAKE_FIELDS.find((f) => f.key === 'timeline')!.options!;

export interface AppField { key: 'revenue' | 'ebitda' | 'industry' | 'locations' | 'buy_what' | 'timeline' | 'financials_url'; label: string; kind: 'text' | 'textarea' | 'url' | 'select'; placeholder?: string; options?: string[]; required?: boolean }

/** The form, in the intake's own words (the same keys, so the answers drop straight into deal_sprint_intake). */
export const APPLICATION_FIELDS: AppField[] = [
  { key: 'revenue', label: 'Yearly revenue', kind: 'select', options: REVENUE_OPTIONS, required: true },
  { key: 'ebitda', label: 'Yearly EBITDA (profit before interest, tax and depreciation)', kind: 'text', placeholder: 'e.g. $650k', required: true },
  { key: 'industry', label: 'Industry', kind: 'text', placeholder: 'e.g. commercial HVAC', required: true },
  { key: 'locations', label: 'Locations', kind: 'text', placeholder: 'e.g. 3 sites in Texas' },
  { key: 'buy_what', label: 'What you would buy first', kind: 'textarea', placeholder: 'A competitor, a supplier, a business in the next town over…' },
  { key: 'timeline', label: 'When you want a first deal closed', kind: 'select', options: TIMELINES },
  { key: 'financials_url', label: 'Link to your last two years of financial statements (optional)', kind: 'url', placeholder: 'https:// (a shared Google Drive or Dropbox folder)' },
];

/** Every visible string on the form page (checked by auditCopy in the tests). */
export function sprintStartCopy(o: { offerName: string; price: string; whop: boolean }) {
  return {
    eyebrow: 'Step 1 of 3',
    steps: ['Your business', 'Secure checkout', 'Book your kickoff call'],
    heading: `Start your ${o.offerName}`,
    lede: 'Seven questions about your business. Josh’s team reads your answers before the kickoff call, so the call starts on your numbers. Secure checkout opens straight after.',
    button: `Continue to secure checkout · ${o.price}`,
    missing: 'Add your revenue, your EBITDA and your industry, then continue.',
    privacy: 'Your answers go to Josh’s team only, and they fill in your Sprint intake for you.',
    secure: o.whop ? 'Secure checkout by Whop.' : 'Secure payment by Stripe.',
    payLater: 'At checkout Whop also offers pay-later options such as Klarna and Affirm, where they are available to you.',
    bookCall: 'Book a call instead',
    backToOffer: `Read everything in the ${o.offerName}`,
  };
}

/** Clean what the form sent: short text only, a known band and timeline, the statements link only when it is https. */
export function cleanApplication(body: Record<string, unknown>) {
  const out: Record<string, string | null> = {};
  for (const f of APPLICATION_FIELDS) {
    const raw = typeof body[f.key] === 'string' ? (body[f.key] as string).replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim() : '';
    const max = f.kind === 'textarea' ? 2000 : f.kind === 'url' ? 500 : 200;
    let v: string | null = raw.slice(0, max) || null;
    if (f.kind === 'url' && v && !/^https:\/\/[^\s<>"']+$/i.test(v)) v = null;
    if (f.key === 'revenue' && v && !ANY_BAND.has(v)) v = null;
    if (f.key === 'timeline' && v && !TIMELINES.includes(v)) v = null;
    out[f.key] = v;
  }
  return { data: out, complete: APPLICATION_FIELDS.every((f) => !f.required || out[f.key]) };
}

const KEYS = APPLICATION_FIELDS.map((f) => f.key);

export async function saveApplication(rt: Runtime, reg: Pick<Registration, 'id' | 'lead_id'>, data: Record<string, string | null>) {
  const now = Date.now();
  await rt.env.DB.prepare(
    `INSERT INTO deal_sprint_applications (reg_id, lead_id, ${KEYS.join(', ')}, created_at, updated_at) VALUES (?, ?, ${KEYS.map(() => '?').join(', ')}, ?, ?)
     ON CONFLICT(reg_id) DO UPDATE SET ${KEYS.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`,
  ).bind(reg.id, reg.lead_id, ...KEYS.map((k) => data[k] ?? null), now, now).run();
  await track(rt, await identityFromLead(rt.env, reg.lead_id), { name: 'deal_sprint_application', source: 'server', props: { reg_id: reg.id }, localOnly: true }).catch(() => null);
}

type AppRow = Record<AppField['key'], string | null> & { reg_id: string; lead_id: string; pass_id: string | null; updated_at: number };

/**
 * The paid Sprint gets the pre-payment answers as its intake (never over an intake the buyer already saved).
 * The registration's own answers first, else the lead's latest. Returns whether an intake was written.
 */
export async function copyApplicationToIntake(rt: Runtime, pass: Pick<PassRow, 'id' | 'lead_id' | 'reg_id'>) {
  const db = rt.env.DB;
  const app = (await db.prepare('SELECT * FROM deal_sprint_applications WHERE reg_id = ?').bind(pass.reg_id).first<AppRow>())
    ?? (await db.prepare('SELECT * FROM deal_sprint_applications WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 1').bind(pass.lead_id).first<AppRow>());
  if (!app) return false;
  const now = Date.now();
  const res = await db.prepare(
    `INSERT OR IGNORE INTO deal_sprint_intake (pass_id, lead_id, ${KEYS.join(', ')}, submitted_at, updated_at) VALUES (?, ?, ${KEYS.map(() => '?').join(', ')}, ?, ?)`,
  ).bind(pass.id, pass.lead_id, ...KEYS.map((k) => app[k] ?? null), app.updated_at ?? now, now).run();
  await db.prepare('UPDATE deal_sprint_applications SET pass_id = COALESCE(pass_id, ?) WHERE reg_id = ?').bind(pass.id, app.reg_id).run();
  await ensureDealSprint(rt, pass);
  return (res.meta.changes ?? 0) > 0;
}

// ───────────── The page ─────────────

const STYLE = `<style>
.ss-steps{display:flex;flex-wrap:wrap;gap:6px 14px;list-style:none;padding:0;margin:0 0 14px;font-size:13px;color:#6b7280}
.ss-steps li.on{color:var(--accent,#0f2c5c);font-weight:600}.ss-form{display:grid;gap:12px;margin-top:14px}
.ss-form label{display:grid;gap:4px;font-size:14px;color:#374151}.ss-form textarea{min-height:76px}
.ss-note{background:#fdf3e2;color:#78350f;border-radius:8px;padding:10px 12px}.ss-fine{font-size:13px;color:#6b7280;margin:6px 0 0}
</style>`;

export type Gate = { ok: true; rt: Runtime; reg: RegLike; session: Session } | { ok: false; rt: Runtime; title: string; html: string; redirect?: string };

/** The same gate as checkout: unlocked for this registration (or reached the pitch), before the offer deadline. */
export async function sprintStartGate(rt: Runtime, token: string, now = Date.now()): Promise<Gate> {
  let reg = (await getRegistration(rt, token)) as RegLike | null;
  const session = reg ? await getSession(rt, reg.session_id) : null;
  if (!reg || !session) return { ok: false, rt, title: 'Link not found', html: '<h1 class="h2">We couldn’t find that link</h1><p class="lede">Open the masterclass from the link in your confirmation email.</p>' };
  const { cfg } = sprintSettings(rt);
  const t = sprintCopy(cfg, { opensAt: mmss(pitchSec(rt)) });
  const room = roomUrl(rt, reg.token);
  const apply = `${rt.origin}/w/${reg.token}`;
  if (await activePass(rt, reg.lead_id)) return { ok: false, rt, title: cfg.offerName, html: '', redirect: dealSprintUrl(rt, reg.token) };
  if (cfg.mode === 'off') return { ok: false, rt, title: cfg.offerName, html: `<h1 class="h2">The ${esc(cfg.offerName)} isn’t open right now</h1><p class="lede"><a href="${esc(apply)}">Apply for a strategy call</a> instead.</p>` };
  if (!(await sprintQualified(rt, reg))) return { ok: false, rt, title: cfg.offerName, html: `<h1 class="h2">The ${esc(cfg.offerName)} is for owners doing $1M or more a year</h1><p class="lede">Start with the worksheet and the replay. <a href="${esc(room)}">${esc(t.backToRoom)}</a></p>` };
  if (reg.offer_unlocked_at == null && reachedPitch(rt, session, reg, now) && now < offerDeadline(rt, session, reg)) {
    const r = await unlockSprint(rt, reg, session, {}, now);
    if (r.ok) reg = { ...reg, offer_unlocked_at: r.unlockedAt };
  }
  const w = sprintWindow(rt, session, reg, now);
  if (!w.unlocked) return { ok: false, rt, title: cfg.offerName, html: `<p class="eyebrow">${esc(t.lockedEyebrow)}</p><h1 class="h2">${esc(t.lockedHeading)}</h1><p class="lede">${esc(t.notYet)}</p><p><a class="btn" href="${esc(room)}">${esc(t.backToRoom)}</a></p>` };
  if (w.closed) return { ok: false, rt, title: cfg.offerName, html: `<h1 class="h2">${esc(cfg.offerName)}</h1><p class="lede">${esc(t.closed)}</p><p><a class="btn" href="${esc(apply)}">${esc(t.closedButton)}</a></p>` };
  return { ok: true, rt, reg, session };
}

const page = (c: Context<AppEnv>, title: string, html: string) => render(c, '/webinar-offer.html', { title, blocks: { offer: html }, config: { webinar: {} } });

/** The form (pure, for the tests). */
export function startFormHtml(o: { offerName: string; price: string; whop: boolean; plan: boolean; values: Partial<Record<AppField['key'], string | null>>; note: { text: string; book?: string | null } | null; offerUrl: string; apply: string }) {
  const t = sprintStartCopy(o);
  const val = (k: AppField['key']) => esc(String(o.values[k] ?? ''));
  const fields = APPLICATION_FIELDS.map((f) => {
    const attrs = `name="${f.key}"${f.required ? ' required' : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}`;
    let input: string;
    if (f.kind === 'select') {
      const cur = String(o.values[f.key] ?? '');
      const opts = [...(cur && !f.options!.includes(cur) ? [cur] : []), ...f.options!];
      input = `<select class="input" ${attrs}><option value="">Choose one</option>${opts.map((x) => `<option${x === cur ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
    } else if (f.kind === 'textarea') input = `<textarea class="input" ${attrs} maxlength="2000">${val(f.key)}</textarea>`;
    else input = `<input class="input" type="${f.kind === 'url' ? 'url' : 'text'}" ${attrs} maxlength="${f.kind === 'url' ? 500 : 200}" value="${val(f.key)}">`;
    return `<label>${esc(f.label)}${input}</label>`;
  }).join('');
  return `${STYLE}
    <ol class="ss-steps">${t.steps.map((s, i) => `<li${i === 0 ? ' class="on"' : ''}>${i + 1}. ${esc(s)}</li>`).join('')}</ol>
    <header class="sprint-head"><p class="eyebrow">${esc(t.eyebrow)}</p><h1 class="h2">${esc(t.heading)}</h1><p class="lede">${esc(t.lede)}</p></header>
    ${o.note ? `<p class="ss-note" role="alert">${esc(o.note.text)}${o.note.book ? ` <a href="${esc(o.note.book)}">${esc(t.bookCall)}</a>` : ''}</p>` : ''}
    <form class="ss-form" method="post" data-sprint-start>${o.plan ? '<input type="hidden" name="plan" value="1">' : ''}${fields}
      <button class="btn btn-lg pass-btn" type="submit">${esc(t.button)}</button>
      <p class="ss-fine">${esc(t.privacy)} ${esc(t.secure)}${o.whop ? ` ${esc(t.payLater)}` : ''}</p>
    </form>
    <p class="sprint-more"><a href="${esc(o.offerUrl)}">${esc(t.backToOffer)}</a> · <a href="${esc(o.apply)}">${esc(t.bookCall)}</a></p>`;
}

async function formPage(c: Context<AppEnv>, g: Extract<Gate, { ok: true }>, o: { plan: boolean; values?: Partial<Record<AppField['key'], string | null>>; note: { text: string; book?: string | null } | null }) {
  const { rt, reg } = g;
  const { cfg, plan } = sprintSettings(rt);
  const credit = await ticketCredit(rt, reg.lead_id, cfg.currency);
  const price = sprintPrice(cfg, plan, credit);
  const usePlan = o.plan && Boolean(price.plan);
  let values = o.values;
  if (!values) {
    // Prefill: what they answered before, else their revenue band from the registration (or the lead).
    const prev = await rt.env.DB.prepare('SELECT * FROM deal_sprint_applications WHERE reg_id = ?').bind(reg.id).first<AppRow>();
    const band = (await rt.env.DB.prepare('SELECT COALESCE(r.revenue_band, l.revenue_band) AS band FROM webinar_registrations r JOIN leads l ON l.id = r.lead_id WHERE r.id = ?').bind(reg.id).first<{ band: string | null }>())?.band;
    values = prev ?? { revenue: band ? REVENUE_LABEL[band] ?? null : null };
  }
  const html = startFormHtml({
    offerName: cfg.offerName, price: usePlan ? price.plan!.button : price.todayLabel, whop: cfg.provider === 'whop', plan: usePlan, values, note: o.note,
    offerUrl: offerUrl(rt, reg.token), apply: `${rt.origin}/w/${reg.token}`,
  });
  return page(c, `Start your ${cfg.offerName}`, html);
}

/** GET /sprint-start/:token */
export async function sprintStartPage(c: Context<AppEnv>) {
  const g = await sprintStartGate(runtimeFrom(c), c.req.param('token') ?? '');
  if (!g.ok) return g.redirect ? c.redirect(g.redirect, 302) : page(c, g.title, g.html);
  const missing = c.req.query('missing') === '1';
  const { cfg } = sprintSettings(g.rt);
  // Sent here from a one-click payment that didn't go through.
  const oc = c.req.query('one_click');
  const { oneClickCopy } = await import('./one-click');
  const ocNote = oc === 'declined' ? oneClickCopy({ card: null }).declined : oc === 'unavailable' ? oneClickCopy({ card: null }).unavailable : null;
  const note = missing ? sprintStartCopy({ offerName: cfg.offerName, price: '', whop: false }).missing : ocNote;
  return formPage(c, g, { plan: c.req.query('plan') === '1', note: note ? { text: note } : null });
}

/** POST /sprint-start/:token: save the answers, then straight to checkout. */
export async function sprintStartSubmit(c: Context<AppEnv>) {
  if (!sameOriginWrite(c)) return c.text('Forbidden', 403);
  const g = await sprintStartGate(runtimeFrom(c), c.req.param('token') ?? '');
  if (!g.ok) return g.redirect ? c.redirect(g.redirect, 303) : page(c, g.title, g.html);
  const form = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  const plan = form.plan === '1';
  const { data, complete } = cleanApplication(form);
  if (!complete) return c.redirect(`${c.req.path}?missing=1${plan ? '&plan=1' : ''}`, 303);
  await saveApplication(g.rt, g.reg, data);
  try {
    const r = await createSprintCheckout(g.rt, g.reg, { plan, from: 'start' });
    return c.redirect('url' in r && r.url ? r.url : sprintWelcomeUrl(g.rt, g.reg.token), 303);
  } catch (e) {
    if (!(e instanceof PassError)) throw e;
    return formPage(c, g, { plan, values: data, note: { text: e.message, book: e.book } });
  }
}

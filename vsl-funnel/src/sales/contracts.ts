import type { Runtime } from '../app';
import { BRAND, ECONOMICS } from '../config';
import { buildDossier, escHtml } from '../followup/dossier';
import { type Lead, getLead, updateLead } from '../funnel/leads';
import { emailConfigured, sendViaResend, unsubscribeSig } from '../integrations/email';
import { notify } from '../integrations/notify';
import { renderEmail } from '../integrations/templates';
import { newId } from '../lib/ids';

/**
 * Engagement letters: auto-quoted from what the lead told us, sent from Josh's address for e-signature,
 * signed on /sign/<token> with a full audit trail (who, when, from where, and a hash of the exact
 * document they saw). The letter text is a starting point: have a lawyer review it before first use.
 */

export interface Contract {
  id: string; token: string; lead_id: string; status: 'draft' | 'sent' | 'viewed' | 'signed' | 'void'; title: string;
  client_name: string | null; client_email: string | null; client_company: string | null;
  fee: number; currency: string; payment_terms: string | null; success_fee: string | null; scope: string | null; term_text: string | null;
  quote_basis: string | null; body_html: string | null; doc_hash: string | null;
  created_at: number; sent_at: number | null; viewed_at: number | null; signed_at: number | null; voided_at: number | null;
  reminders: number; last_reminder_at: number | null;
  signer_name: string | null; signer_title: string | null; signature: string | null; signature_kind: string | null;
  signer_ip: string | null; signer_ua: string | null; signer_country: string | null;
}

const DAY = 86_400_000;
/** Signing links stop working after this long; send a fresh one if it lapses. */
export const CONTRACT_TTL_DAYS = 30;

// ───────────── Auto-quote ─────────────

/** Retainer by the size of the business. Most land at $20k–$50k; larger groups scale up. Edit freely per letter. */
const FEE_BY_REVENUE: Record<string, number> = {
  lt1m: 20_000, '1_3m': 20_000, '3_10m': 25_000, gt10m: 35_000, '10_25m': 35_000, '25_50m': 50_000, '50_100m': 75_000, gt100m: 100_000,
};
const FEE_BY_PROFIT: Record<string, number> = { p3_10m: 50_000, pgt10m: 75_000 };

export function autoQuote(lead: Lead) {
  const d = buildDossier(lead);
  const byRev = d.revenue ? FEE_BY_REVENUE[d.revenue] : undefined;
  const byProfit = d.profit ? FEE_BY_PROFIT[d.profit] : undefined;
  const fee = Math.max(byRev ?? 20_000, byProfit ?? 0);
  const basis = [
    d.revenueLabel ? `revenue ${d.revenueLabel}` : 'revenue unknown',
    d.profitLabel ? `EBITDA ${d.profitLabel}` : null,
  ].filter(Boolean).join(', ');
  return {
    fee,
    currency: ECONOMICS.currency,
    basis: `Suggested from ${basis}. Typical engagements are $20k–$50k; larger groups scale up.`,
    payment_terms: 'Payable in full within 7 days of signing.',
    success_fee: '',
    scope: DEFAULT_SCOPE,
    term_text: 'This engagement runs for 6 months from the date it is signed, and can be extended in writing.',
    client_name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null,
    client_email: lead.email,
    // Their application describes the business, not its legal name, so this starts blank.
    client_company: null,
  };
}

export const DEFAULT_SCOPE = [
  'Acquisition strategy: the kind of business to buy, size, location and fit with your existing business.',
  'Target identification and outreach support, including off-market owners.',
  'Financial review and modelling of shortlisted targets, including debt service coverage.',
  'Deal structuring: commercial debt, seller finance and seller rollover, and introductions to lenders.',
  'Negotiation support through the letter of intent, and coordination of due diligence with your lawyers and accountants.',
].join('\n');

// ───────────── The letter ─────────────

const money = (n: number, cur: string) => `${cur === 'AUD' ? 'A$' : cur === 'USD' ? 'US$' : `${cur} `}${Math.round(n).toLocaleString('en-AU')}`;
const paras = (s: string | null | undefined) => (s ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escHtml(p)}</p>`).join('');
const bullets = (s: string | null | undefined) => {
  const items = (s ?? '').split('\n').map((x) => x.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
  return items.length ? `<ul>${items.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul>` : '';
};

/** The engagement letter as HTML. Everything that came from a person is escaped. */
export function letterHtml(rt: Runtime, k: Pick<Contract, 'title' | 'client_name' | 'client_email' | 'client_company' | 'fee' | 'currency' | 'payment_terms' | 'success_fee' | 'scope' | 'term_text'>, date = Date.now()) {
  const s = rt.settings;
  const company = s.CONTRACT_COMPANY || s.SITE_NAME || BRAND.name;
  const signer = s.CONTRACT_SIGNER || 'Josh Li, Director';
  const law = s.CONTRACT_LAW || 'New South Wales, Australia';
  const client = k.client_company ? `${k.client_name ?? ''}${k.client_name ? ', on behalf of ' : ''}${k.client_company}` : (k.client_name ?? k.client_email ?? 'the Client');
  const dated = new Date(date).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: s.SALES_TIMEZONE || 'Australia/Sydney' });
  const n = (() => { let i = 0; return () => ++i; })();
  return [
    `<h1>${escHtml(k.title)}</h1>`,
    `<p class="meta">Dated ${escHtml(dated)}</p>`,
    `<p><strong>Between</strong> ${escHtml(company)}${s.CONTRACT_ABN ? ` (ABN ${escHtml(s.CONTRACT_ABN)})` : ''} (“we”, “us”)<br><strong>and</strong> ${escHtml(client)}${k.client_email ? ` (${escHtml(k.client_email)})` : ''} (“you”).</p>`,
    `<h2>${n()}. What we’ll do</h2><p>We will act as your acquisition adviser and provide the following services:</p>${bullets(k.scope)}`,
    `<p>We are not your lawyers, accountants or financial planners, and nothing we provide is legal, tax or financial product advice. You will obtain your own independent legal, tax and accounting advice before entering into any transaction.</p>`,
    `<h2>${n()}. Fees</h2><p>Our advisory fee is <strong>${escHtml(money(k.fee, k.currency))}</strong>${k.currency === 'AUD' ? ' plus GST where applicable' : ''}.</p>`,
    k.payment_terms ? `<p>${escHtml(k.payment_terms)}</p>` : '',
    k.success_fee ? `<p><strong>Success fee:</strong> ${escHtml(k.success_fee)}</p>` : '',
    `<p>Third-party costs (for example lender, legal, valuation or due-diligence fees) are not included and are paid by you directly, with your approval.</p>`,
    `<h2>${n()}. Term</h2>${paras(k.term_text)}`,
    `<p>Either of us can end this engagement by written notice. Fees for work already performed remain payable, and any fee already paid is not refundable unless we agree otherwise in writing.</p>`,
    `<h2>${n()}. No guarantee</h2><p>Acquisitions depend on sellers, lenders and market conditions outside our control. We will work diligently, but we do not guarantee that you will complete an acquisition, obtain finance, or achieve any particular price, structure, return or timeline. Any figures we share are estimates for discussion.</p>`,
    `<h2>${n()}. Your decisions</h2><p>You decide whether to proceed with any target, offer or finance, and you are responsible for the information you give us being accurate and complete.</p>`,
    `<h2>${n()}. Confidentiality</h2><p>Each of us will keep the other’s confidential information confidential and use it only for this engagement, except where disclosure is required by law or made to professional advisers bound by confidentiality.</p>`,
    `<h2>${n()}. Liability</h2><p>To the extent permitted by law, our total liability under this engagement is limited to the fees you have paid us, and neither of us is liable for indirect or consequential loss. Nothing in this letter excludes rights you have under the Australian Consumer Law that cannot be excluded.</p>`,
    s.CONTRACT_EXTRA_TERMS ? `<h2>${n()}. Further terms</h2>${paras(s.CONTRACT_EXTRA_TERMS)}` : '',
    `<h2>${n()}. General</h2><p>This letter is the whole agreement between us about this engagement. It is governed by the laws of ${escHtml(law)}. You agree that it can be signed electronically, and that an electronic signature has the same effect as a handwritten one.</p>`,
    `<div class="parties"><div><p class="lbl">For ${escHtml(company)}</p><p class="sig typed">${escHtml(signer.split(',')[0])}</p><p>${escHtml(signer)}</p></div><div data-client-sig><p class="lbl">You</p><p class="sig pending">Awaiting signature</p><p>${escHtml(k.client_name ?? '')}</p></div></div>`,
  ].join('');
}

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const token = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const signUrl = (rt: Runtime, t: string) => `${rt.origin}/sign/${t}`;

// ───────────── Admin actions ─────────────

export type ContractInput = Partial<Pick<Contract, 'title' | 'client_name' | 'client_email' | 'client_company' | 'fee' | 'currency' | 'payment_terms' | 'success_fee' | 'scope' | 'term_text'>>;

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);

export function cleanInput(body: ContractInput, lead: Lead) {
  const q = autoQuote(lead);
  const fee = Math.round(Number(body.fee));
  const email = clip(body.client_email, 200) ?? lead.email;
  return {
    title: clip(body.title, 120) ?? 'Engagement letter: acquisition advisory',
    client_name: clip(body.client_name, 120) ?? q.client_name,
    client_email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    client_company: clip(body.client_company, 160),
    fee: Number.isFinite(fee) && fee > 0 && fee <= 100_000_000 ? fee : q.fee,
    currency: ['AUD', 'USD', 'NZD', 'GBP', 'EUR', 'CAD', 'SGD'].includes(String(body.currency)) ? String(body.currency) : q.currency,
    payment_terms: clip(body.payment_terms, 1000) ?? q.payment_terms,
    success_fee: clip(body.success_fee, 1000),
    scope: clip(body.scope, 4000) ?? DEFAULT_SCOPE,
    term_text: clip(body.term_text, 2000) ?? q.term_text,
  };
}

export async function createContract(rt: Runtime, lead: Lead, body: ContractInput) {
  const k = cleanInput(body, lead);
  const id = newId('k');
  await rt.env.DB.prepare(
    `INSERT INTO contracts (id, token, lead_id, status, title, client_name, client_email, client_company, fee, currency, payment_terms, success_fee, scope, term_text, quote_basis, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, token(), lead.id, k.title, k.client_name, k.client_email, k.client_company, k.fee, k.currency, k.payment_terms, k.success_fee, k.scope, k.term_text, autoQuote(lead).basis, Date.now()).run();
  return getContract(rt, id);
}

export async function updateDraft(rt: Runtime, c: Contract, lead: Lead, body: ContractInput) {
  if (c.status !== 'draft') throw new Error('Only drafts can be edited. Void it and make a new one.');
  const k = cleanInput({ ...c, ...body }, lead);
  await rt.env.DB.prepare(
    'UPDATE contracts SET title = ?, client_name = ?, client_email = ?, client_company = ?, fee = ?, currency = ?, payment_terms = ?, success_fee = ?, scope = ?, term_text = ? WHERE id = ?',
  ).bind(k.title, k.client_name, k.client_email, k.client_company, k.fee, k.currency, k.payment_terms, k.success_fee, k.scope, k.term_text, c.id).run();
  return getContract(rt, c.id);
}

export const getContract = (rt: Runtime, id: string) => rt.env.DB.prepare('SELECT * FROM contracts WHERE id = ?').bind(id).first<Contract>();
export const contractByToken = (rt: Runtime, t: string) => (/^[0-9a-f]{40}$/.test(t) ? rt.env.DB.prepare('SELECT * FROM contracts WHERE token = ?').bind(t).first<Contract>() : Promise.resolve(null));

/** Plain email from Josh with the signing link. */
async function sendContractEmail(rt: Runtime, c: Contract, lead: Lead, kind: 'send' | 'reminder' | 'signed') {
  const first = (c.client_name ?? lead.first_name ?? '').split(' ')[0] || 'there';
  const link = signUrl(rt, c.token);
  const fee = money(c.fee, c.currency);
  const content =
    kind === 'signed'
      ? { subject: `Signed: ${c.title}`, preheader: 'Your copy is attached as a link.', body: [`Hi ${escHtml(first)},`, 'Thanks for signing. Here’s your copy of the engagement letter, with the signatures and the signing record at the bottom. Keep this email for your records.', 'I’ll be in touch within one business day about next steps.'], cta: { label: 'View your signed copy →', href: `${link}/copy` } }
      : kind === 'reminder'
        ? { subject: `Re: ${c.title}`, preheader: 'Ready when you are.', body: [`Hi ${escHtml(first)},`, 'Just bringing this back to the top of your inbox. The engagement letter we discussed is ready to sign whenever you are. It takes about two minutes.', 'If anything in it needs changing, reply and tell me what, and I’ll send a revised version.'], cta: { label: 'Review and sign →', href: link } }
        : { subject: c.title, preheader: `Engagement letter, ${fee}. Takes two minutes to sign.`, body: [`Hi ${escHtml(first)},`, 'As discussed, here’s the engagement letter so we can get started.', `It sets out what we’ll do, the fee (${escHtml(fee)}), the term, and the usual terms. You can read it and sign online in about two minutes, from your phone or computer.`, 'If you’d like anything changed, reply to this email and I’ll send a revised version. I’d also encourage you to have your own adviser look over it.'], cta: { label: 'Review and sign →', href: link } };
  const unsubscribeUrl = `${rt.origin}/u/${lead.id}/${await unsubscribeSig(rt, lead.id)}`;
  const { html, text } = renderEmail(content, { openPixel: null, unsubscribeUrl, signature: rt.settings.EMAIL_SIGNATURE || 'Josh', address: rt.settings.BUSINESS_ADDRESS || rt.settings.SITE_NAME || BRAND.name });
  const to = c.client_email ?? lead.email;
  if (!to) throw new Error('No email address for this person.');
  return sendViaResend(rt, { to, subject: content.subject, html, text, unsubscribeUrl, tags: { kind: `contract_${kind}` } });
}

export async function sendContract(rt: Runtime, c: Contract) {
  if (c.status !== 'draft') throw new Error('This letter has already been sent.');
  if (!emailConfigured(rt)) throw new Error('Email isn’t connected yet (Integrations → Email).');
  const lead = await getLead(rt.env, c.lead_id);
  if (!lead) throw new Error('Lead not found.');
  const body = letterHtml(rt, c);
  const hash = await sha256(body);
  const now = Date.now();
  await rt.env.DB.prepare("UPDATE contracts SET status = 'sent', body_html = ?, doc_hash = ?, sent_at = ? WHERE id = ? AND status = 'draft'").bind(body, hash, now, c.id).run();
  const sent = { ...c, status: 'sent' as const, body_html: body, doc_hash: hash, sent_at: now };
  try {
    await sendContractEmail(rt, sent, lead, 'send');
  } catch (e) {
    await rt.env.DB.prepare("UPDATE contracts SET status = 'draft', body_html = NULL, doc_hash = NULL, sent_at = NULL WHERE id = ?").bind(c.id).run();
    throw e;
  }
  return sent;
}

export async function voidContract(rt: Runtime, c: Contract) {
  if (c.status === 'signed') throw new Error('A signed letter can’t be voided here.');
  await rt.env.DB.prepare("UPDATE contracts SET status = 'void', voided_at = ? WHERE id = ?").bind(Date.now(), c.id).run();
}

// ───────────── Signing ─────────────

export const isExpired = (c: Contract) => Boolean(c.sent_at && Date.now() - c.sent_at > CONTRACT_TTL_DAYS * DAY);

export async function markViewed(rt: Runtime, c: Contract) {
  if (c.status === 'sent') await rt.env.DB.prepare("UPDATE contracts SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'sent'").bind(Date.now(), c.id).run();
}

export interface SignInput { name?: unknown; title?: unknown; signature?: unknown; kind?: unknown; consent?: unknown; hash?: unknown }

export async function signContract(rt: Runtime, c: Contract, input: SignInput, meta: { ip: string | null; ua: string | null; country: string | null }) {
  if (c.status === 'signed') return { ok: false as const, error: 'This letter has already been signed.' };
  if (c.status === 'void' || c.status === 'draft' || !c.body_html) return { ok: false as const, error: 'This letter is no longer available. Ask us for a new link.' };
  if (isExpired(c)) return { ok: false as const, error: 'This signing link has expired. Reply to the email and we’ll send a fresh one.' };
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
  if (name.length < 2) return { ok: false as const, error: 'Type your full name.' };
  if (input.consent !== true) return { ok: false as const, error: 'Tick the box to agree to sign electronically.' };
  // They must be signing the exact document they were shown.
  if (input.hash !== c.doc_hash) return { ok: false as const, error: 'This letter changed while you had it open. Reload the page and review it again.' };
  const kind = input.kind === 'drawn' ? 'drawn' : 'typed';
  let signature = name;
  if (kind === 'drawn') {
    const sig = typeof input.signature === 'string' ? input.signature : '';
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length > 300_000) return { ok: false as const, error: 'Draw your signature, or switch to typing it.' };
    signature = sig;
  }
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) || null : null;
  const now = Date.now();
  const res = await rt.env.DB.prepare(
    `UPDATE contracts SET status = 'signed', signed_at = ?, signer_name = ?, signer_title = ?, signature = ?, signature_kind = ?, signer_ip = ?, signer_ua = ?, signer_country = ?
      WHERE id = ? AND status IN ('sent', 'viewed') AND doc_hash = ?`,
  ).bind(now, name, title, signature, kind, meta.ip, meta.ua?.slice(0, 300) ?? null, meta.country, c.id, c.doc_hash).run();
  if (!res.meta.changes) return { ok: false as const, error: 'This letter has already been signed.' };
  const signed = { ...c, status: 'signed' as const, signed_at: now, signer_name: name, signer_title: title, signature, signature_kind: kind };
  rt.waitUntil(afterSigned(rt, signed));
  return { ok: true as const };
}

async function afterSigned(rt: Runtime, c: Contract) {
  const lead = await getLead(rt.env, c.lead_id);
  if (!lead) return;
  await updateLead(rt.env, lead.id, { contract_signed_at: c.signed_at, revenue: lead.revenue || c.fee });
  await sendContractEmail(rt, c, lead, 'signed').catch((e) => console.error('signed copy email failed', e));
  const internal = rt.settings.CONTRACT_NOTIFY_EMAIL || rt.settings.EMAIL_REPLY_TO;
  if (internal && emailConfigured(rt)) {
    const { html, text } = renderEmail(
      { subject: `Signed: ${c.client_name ?? lead.email} (${money(c.fee, c.currency)})`, preheader: 'Engagement letter signed.', body: [`${escHtml(c.signer_name ?? '')} signed “${escHtml(c.title)}” for ${escHtml(money(c.fee, c.currency))}.`], cta: { label: 'Open the signed copy →', href: `${signUrl(rt, c.token)}/copy` } },
      { openPixel: null, unsubscribeUrl: rt.origin, signature: 'Funnel HQ', address: rt.settings.SITE_NAME || BRAND.name },
    );
    await sendViaResend(rt, { to: internal, subject: `Signed: ${c.client_name ?? lead.email} (${money(c.fee, c.currency)})`, html, text, unsubscribeUrl: rt.origin, tags: { kind: 'contract_signed_internal' } }).catch(() => null);
  }
  await notify(rt, { kind: 'won', title: `Engagement letter signed: ${money(c.fee, c.currency)}`, lead, lines: [c.title] }).catch(() => null);
}

/** Cron: a gentle reminder two and five days after sending, if it's still unsigned. */
export async function processContractReminders(rt: Runtime) {
  if (!emailConfigured(rt)) return null;
  const now = Date.now();
  const { results } = await rt.env.DB.prepare(
    `SELECT * FROM contracts WHERE status IN ('sent', 'viewed') AND reminders < 2 AND sent_at > ?
       AND ((reminders = 0 AND sent_at < ?) OR (reminders = 1 AND sent_at < ?)) LIMIT 20`,
  ).bind(now - CONTRACT_TTL_DAYS * DAY, now - 2 * DAY, now - 5 * DAY).all<Contract>();
  let sent = 0;
  for (const c of results) {
    const lead = await getLead(rt.env, c.lead_id);
    if (!lead || lead.unsubscribed_at) continue;
    await rt.env.DB.prepare('UPDATE contracts SET reminders = reminders + 1, last_reminder_at = ? WHERE id = ?').bind(now, c.id).run();
    await sendContractEmail(rt, c, lead, 'reminder').then(() => sent++, (e) => console.error('contract reminder failed', e));
  }
  return { sent };
}

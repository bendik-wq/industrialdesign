import type { Runtime } from '../app';
import { buildDossier, escHtml } from '../followup/dossier';
import { type Lead, getLead, updateLead } from '../funnel/leads';
import { emailConfigured, sendViaResend } from '../integrations/email';
import { notify } from '../integrations/notify';
import { newId } from '../lib/ids';

/**
 * Advisory agreements: a one-page contract, auto-quoted from what the lead told us, signed by us first
 * (countersignature from Funnel HQ), then emailed from Josh's address for the client's e-signature on
 * /sign/<token>. Every signature is recorded with time, IP and a SHA-256 fingerprint of the exact terms.
 * The wording is a plain-English starting point: have your attorney review it before first use.
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
  pay_link: string | null; pay_email_sent_at: number | null; paid_at: number | null;
  is_test: number; our_signer: string | null; our_signature: string | null; our_signature_kind: string | null; our_signed_at: number | null; our_signer_ip: string | null;
  /** First Deal Sprint fee credited against this fee (whole units, same currency); 0 = none. */
  credit_amount?: number | null; credit_label?: string | null; credit_pass_id?: string | null;
}

const DAY = 86_400_000;
/** Signing links stop working after this long; send a fresh one if it lapses. */
export const CONTRACT_TTL_DAYS = 30;
const PNG = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

// ───────────── Who we are ─────────────

export function company(rt: Runtime) {
  const s = rt.settings;
  return {
    name: s.CONTRACT_COMPANY || 'G&L M&A Advisory LLC',
    entity: s.CONTRACT_ENTITY || 'a Wyoming limited liability company',
    // The postal address often starts with the brand name; the agreement already names the company.
    address: (s.CONTRACT_ADDRESS || s.BUSINESS_ADDRESS || '').replace(/^\s*G&L[^,]*,\s*/i, ''),
    signer: s.CONTRACT_SIGNER || 'Josh Li, Co-Founder',
    law: s.CONTRACT_LAW || 'Wyoming',
    venue: s.CONTRACT_VENUE || 'Sheridan County, Wyoming',
    currency: (s.CONTRACT_CURRENCY || 'USD').toUpperCase(),
    from: s.CONTRACT_FROM || s.EMAIL_FROM,
  };
}

/** Where to send the money, if set (Integrations → Contracts). */
export function paymentDetails(rt: Runtime) {
  const s = rt.settings;
  const rows: [string, string][] = [
    ['Bank', s.CONTRACT_PAY_BANK], ['Account name', s.CONTRACT_PAY_ACCOUNT_NAME || company(rt).name], ['Routing number', s.CONTRACT_PAY_ROUTING],
    ['Account number', s.CONTRACT_PAY_ACCOUNT], ['SWIFT / BIC', s.CONTRACT_PAY_SWIFT],
  ].filter(([, v]) => v && v.trim()) as [string, string][];
  const hasBank = Boolean(s.CONTRACT_PAY_ACCOUNT?.trim());
  const link = /^https:\/\//.test(s.CONTRACT_PAY_LINK?.trim() ?? '') ? s.CONTRACT_PAY_LINK.trim() : null;
  return hasBank || link ? { rows: hasBank ? rows : [], link } : null;
}

const httpsUrl = (v: unknown) => (typeof v === 'string' && /^https:\/\/[^\s<>"']+$/.test(v.trim()) ? v.trim().slice(0, 500) : null);
/** This agreement's payment link (e.g. a Stripe link for this client), else the default one from settings. */
export const payLinkFor = (rt: Runtime, c: { pay_link?: string | null }) => httpsUrl(c.pay_link) ?? paymentDetails(rt)?.link ?? null;

/** The "How to pay" box, with the standard wire-fraud warning. */
export function paymentHtml(rt: Runtime, reference?: string) {
  const p = paymentDetails(rt);
  if (!p) return '';
  return `<div class="pay"><p class="lbl">How to pay</p>${p.rows.length ? `<dl>${p.rows.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`).join('')}${reference ? `<dt>Reference</dt><dd>${escHtml(reference)}</dd>` : ''}</dl>` : ''}${p.link ? `<p>Or pay by card: <a href="${escHtml(p.link)}" rel="noopener" target="_blank">${escHtml(p.link.replace(/^https:\/\//, ''))}</a></p>` : ''}<p class="warn">We will never change these details by email. If you get a message saying our bank details have changed, call us before you pay.</p></div>`;
}

// ───────────── Auto-quote ─────────────

/** Fee by the size of the business. Most land at $40k–$70k; larger groups scale up. Edit freely per agreement. */
export const FEE_BY_REVENUE: Record<string, number> = {
  lt1m: 40_000, '1_3m': 40_000, '3_10m': 50_000, gt10m: 60_000, '10_25m': 60_000, '25_50m': 70_000, '50_100m': 75_000, gt100m: 100_000,
};
/** The floor when nothing is known (and for under $1M, still editable per agreement). */
export const BASE_FEE = 40_000;
const FEE_BY_PROFIT: Record<string, number> = { p3_10m: 50_000, pgt10m: 75_000 };

export const DEFAULT_SCOPE = [
  'Acquisition strategy (what to buy, what size and how it fits your business)',
  'Finding targets, including off-market owners',
  'Reviewing and modelling shortlisted targets',
  'Structuring the deal (commercial debt, seller finance and seller rollover) and introducing lenders',
  'Support through the letter of intent and due diligence',
].join('\n');

export function autoQuote(rt: Runtime, lead: Lead | null) {
  const d = lead ? buildDossier(lead) : null;
  const byRev = d?.revenue ? FEE_BY_REVENUE[d.revenue] : undefined;
  const byProfit = d?.profit ? FEE_BY_PROFIT[d.profit] : undefined;
  const fee = Math.max(byRev ?? BASE_FEE, byProfit ?? 0);
  const basis = d ? [d.revenueLabel ? `revenue ${d.revenueLabel}` : 'revenue unknown', d.profitLabel ? `EBITDA ${d.profitLabel}` : null].filter(Boolean).join(', ') : 'no application on file';
  return {
    fee,
    currency: company(rt).currency,
    basis: `Suggested from ${basis}. Typical engagements are $40k–$70k; larger groups scale up.`,
    payment_terms: 'Due in full on signing.',
    success_fee: '',
    scope: DEFAULT_SCOPE,
    term_text: '6 months from the date both parties sign',
    title: 'Advisory Agreement',
    client_name: lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null : null,
    client_email: lead?.email ?? null,
    // Their application describes the business, not its legal name, so this starts blank.
    client_company: null,
  };
}

// ───────────── The agreement ─────────────

const SYMBOL: Record<string, string> = { USD: '$', AUD: 'A$', NZD: 'NZ$', CAD: 'C$', SGD: 'S$', GBP: '£', EUR: '€' };
export const money = (n: number, cur: string) => `${SYMBOL[cur] ?? `${cur} `}${Math.round(n).toLocaleString('en-US')}${cur === 'USD' ? ' USD' : ''}`;
const list = (s: string | null | undefined) => (s ?? '').split('\n').map((x) => x.replace(/^[-•*]\s*/, '').replace(/[.;]\s*$/, '').trim()).filter(Boolean);
const clause = (n: number, title: string, body: string) => `<p class="cl"><strong>${n}. ${escHtml(title)}.</strong> ${body}</p>`;

export type Terms = Pick<Contract, 'title' | 'client_name' | 'client_email' | 'client_company' | 'fee' | 'currency' | 'payment_terms' | 'success_fee' | 'scope' | 'term_text'> & Partial<Pick<Contract, 'credit_amount' | 'credit_label'>>;

/** The Sprint credit on an agreement, and what is left to pay. */
export function feeDue(k: Pick<Contract, 'fee' | 'currency'> & Partial<Pick<Contract, 'credit_amount' | 'credit_label'>>) {
  const credit = Math.max(0, Math.min(Math.round(Number(k.credit_amount) || 0), k.fee));
  return { credit, label: credit ? (k.credit_label || 'First Deal Sprint credit') : null, net: k.fee - credit, creditText: credit ? `−${money(credit, k.currency)}` : null };
}

/**
 * The terms as HTML (everything a person typed is escaped). Signature blocks are drawn separately
 * (signatureBlocks), so the fingerprint covers exactly the words both sides agree to.
 */
export function termsHtml(rt: Runtime, k: Terms, date = Date.now()) {
  const co = company(rt);
  const client = [k.client_name, k.client_company ? `${k.client_name ? 'for ' : ''}${k.client_company}` : null].filter(Boolean).join(', ') || k.client_email || 'the Client';
  const dated = new Date(date).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Denver' });
  const scope = list(k.scope);
  const term = (k.term_text || '6 months from the date both parties sign').replace(/^(this agreement )?runs for\s*/i, '').replace(/\.$/, '');
  const due = feeDue(k);
  let n = 0;
  const out = [
    `<h1>${escHtml(k.title || 'Advisory Agreement')}</h1>`,
    `<p class="meta">${escHtml(dated)}</p>`,
    `<p class="parties-line">Between <strong>${escHtml(co.name)}</strong>, ${escHtml(co.entity)}${co.address ? `, ${escHtml(co.address)}` : ''} (“<strong>G&amp;L</strong>”, “we”), and <strong>${escHtml(client)}</strong>${k.client_email ? ` (${escHtml(k.client_email)})` : ''} (“<strong>you</strong>”).</p>`,
    clause(++n, 'What we do', `We advise you on buying a business: ${scope.length ? scope.map((x) => escHtml(/^[A-Z][a-z]/.test(x) ? x[0].toLowerCase() + x.slice(1) : x)).join('; ') : 'acquisition strategy, finding targets, deal structuring and negotiation support'}.`),
    clause(++n, 'Fee', `Our fee is <strong>${escHtml(money(k.fee, k.currency))}</strong>, ${escHtml((k.payment_terms || 'Due in full on signing.').replace(/^./, (ch) => ch.toLowerCase()).replace(/\.?$/, '.'))}${due.credit ? ` ${escHtml(due.label!)}: <strong>${escHtml(due.creditText!)}</strong>. Net amount due: <strong>${escHtml(money(due.net, k.currency))}</strong>.` : ''}${k.success_fee ? ` <strong>Success fee:</strong> ${escHtml(k.success_fee.replace(/\.?$/, '.'))}` : ''} The fee pays for our time and expertise, is earned when paid and is <strong>non-refundable</strong>, whether or not you complete a deal. Third-party costs (lenders, attorneys, valuers, due diligence) are yours. If you have a billing concern, raise it with us first rather than disputing or charging back a payment.`),
    clause(++n, 'What we are not', 'We are business advisers. We are not your attorney, accountant, lender, investment adviser or broker-dealer. We don’t hold your money, sell securities, or give legal, tax or investment advice. Get your own professional advice before you sign any deal.'),
    clause(++n, 'No guarantee', 'Deals depend on sellers, lenders and markets we don’t control. We don’t promise that you will buy a business, obtain financing, or achieve any price, return or timeline. Any figures we share are estimates for discussion.'),
    clause(++n, 'Your decisions', 'You decide whether to make an offer, borrow or close, and you’re responsible for those decisions and for giving us accurate information.'),
    clause(++n, 'Confidentiality and our materials', 'Each of us keeps the other’s confidential information private, except where the law requires otherwise or when shared with professional advisers who keep it confidential. Our models, templates and methods remain ours and are for your own use only.'),
  ];
  if (k.success_fee) out.push(clause(++n, 'Introductions', 'If, within 12 months after this agreement ends, you buy a business we introduced to you, the success fee still applies.'));
  out.push(
    clause(++n, 'Liability', 'Our total liability under this agreement is limited to the fees you paid us in the 12 months before the claim. Neither of us is liable for indirect or consequential losses or lost profits. You will cover us against third-party claims arising from your transactions or your breach of this agreement, except to the extent caused by our gross negligence or willful misconduct.'),
    clause(++n, 'Term and ending', `This agreement runs for ${escHtml(term)}. Either of us may end it with 7 days’ written notice (email is fine). Fees paid or already due stay payable, and sections 2 to ${n + 2} survive.`),
    clause(++n, 'Disputes', `${escHtml(co.law)} law governs this agreement. We’ll first try in good faith for 30 days to resolve any dispute. After that, the state and federal courts in ${escHtml(co.venue)} have exclusive jurisdiction, the winning party recovers reasonable attorneys’ fees, and <strong>both parties waive a jury trial</strong>.`),
    clause(++n, 'General', 'This is the whole agreement on this subject. Changes must be in writing (email is fine). We are independent contractors. Neither of us may assign this agreement without the other’s consent, except that we may assign it to an affiliate or successor. Electronic signatures are valid and binding under the federal E-SIGN Act and the Wyoming Uniform Electronic Transactions Act.'),
  );
  const extra = rt.settings.CONTRACT_EXTRA_TERMS?.trim();
  if (extra) out.push(clause(++n, 'Additional terms', extra.split(/\n\s*\n/).map((p) => escHtml(p.trim())).join(' ')));
  // Payment instructions are part of what both sides sign, so they can't be swapped later.
  out.push(paymentHtml(rt, k.client_company || k.client_name || undefined));
  return out.join('');
}

/** Both signature blocks: ours (signed before sending) and theirs (once signed). */
export function signatureBlocks(rt: Runtime, k: Partial<Contract>, opts: { field?: boolean } = {}) {
  const co = company(rt);
  const mark = (sig: string | null | undefined, kind: string | null | undefined, name: string | null | undefined) =>
    sig && kind === 'drawn' && PNG.test(sig)
      ? `<img class="sig-img" alt="Signature" src="${sig}">`
      : sig ? `<p class="sig">${escHtml(name ?? sig)}</p>` : '<p class="sig pending">Awaiting signature</p>';
  const date = (t: number | null | undefined) => (t ? `<p class="sig-date">Signed ${escHtml(new Date(t).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Denver' }))}</p>` : '');
  const ours = k.our_signer ?? co.signer;
  return `<div class="parties">
    <div><p class="lbl">${escHtml(co.name)}</p>${mark(k.our_signature, k.our_signature_kind, ours.split(',')[0])}<p class="who">${escHtml(ours)}</p>${date(k.our_signed_at)}</div>
    <div><p class="lbl">You</p>${opts.field && !k.signature ? '<button type="button" class="sig-field" data-sig-field><span class="flag">Sign here</span><span class="ph">Click to sign</span></button>' : mark(k.signature, k.signature_kind, k.signer_name)}<p class="who" data-sig-who>${escHtml([k.signer_name ?? k.client_name, k.signer_title ?? (k.signer_name ? null : k.client_company)].filter(Boolean).join(', '))}</p>${opts.field && !k.signed_at ? '<p class="sig-date" data-sig-date></p>' : date(k.signed_at)}</div>
  </div>`;
}

/** The whole document (terms + both signature blocks) for previews, the signing page and the signed copy. */
export const documentHtml = (rt: Runtime, k: Contract | (Terms & Partial<Contract>), opts: { field?: boolean } = {}) => (k.body_html ?? termsHtml(rt, k)) + signatureBlocks(rt, k, opts);

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const token = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');
export const signUrl = (rt: Runtime, t: string) => `${rt.origin}/sign/${t}`;

// ───────────── Drafts ─────────────

export type ContractInput = Partial<Terms> & { pay_link?: string | null };
const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function cleanInput(rt: Runtime, body: ContractInput, lead: Lead | null) {
  const q = autoQuote(rt, lead);
  const fee = Math.round(Number(body.fee));
  const email = clip(body.client_email, 200) ?? q.client_email;
  return {
    title: clip(body.title, 120) ?? q.title,
    client_name: clip(body.client_name, 120) ?? q.client_name,
    client_email: email && EMAIL.test(email) ? email : null,
    client_company: clip(body.client_company, 160),
    fee: Number.isFinite(fee) && fee > 0 && fee <= 100_000_000 ? fee : q.fee,
    currency: Object.keys(SYMBOL).includes(String(body.currency)) ? String(body.currency) : q.currency,
    payment_terms: clip(body.payment_terms, 600) ?? q.payment_terms,
    success_fee: clip(body.success_fee, 600),
    scope: clip(body.scope, 2000) ?? DEFAULT_SCOPE,
    term_text: clip(body.term_text, 300) ?? q.term_text,
    pay_link: httpsUrl(body.pay_link),
  };
}

export const getContract = (rt: Runtime, id: string) => rt.env.DB.prepare('SELECT * FROM contracts WHERE id = ?').bind(id).first<Contract>();
export const contractByToken = (rt: Runtime, t: string) => (/^[0-9a-f]{40}$/.test(t) ? rt.env.DB.prepare('SELECT * FROM contracts WHERE token = ?').bind(t).first<Contract>() : Promise.resolve(null));

/**
 * The lead's paid First Deal Sprint fee, to credit against the engagement (whole units). Only when it was paid
 * in the agreement's currency, and not already used on a signed agreement.
 */
export async function sprintCredit(rt: Runtime, leadId: string | null | undefined, currency: string) {
  if (!leadId) return null;
  const { passCreditFor, fromMinor } = await import('../webinar/pass');
  const c = await passCreditFor(rt, leadId).catch(() => null);
  if (!c || c.currency.toUpperCase() !== currency.toUpperCase()) return null;
  const used = await rt.env.DB.prepare("SELECT credit_used_contract AS k FROM webinar_passes WHERE id = ?").bind(c.passId).first<{ k: string | null }>().catch(() => null);
  if (used?.k) {
    const signed = await rt.env.DB.prepare("SELECT 1 FROM contracts WHERE id = ? AND status = 'signed' AND COALESCE(is_test, 0) = 0").bind(used.k).first().catch(() => null);
    if (signed) return null;
  }
  return { passId: c.passId, amount: Math.round(fromMinor(c.amount, c.currency)), label: `${c.product || 'First Deal Sprint'} credit` };
}

export async function createContract(rt: Runtime, lead: Lead | null, body: ContractInput, opts: { test?: boolean } = {}) {
  const k = cleanInput(rt, body, lead);
  const id = newId('k');
  const credit = await sprintCredit(rt, lead?.id, k.currency);
  const basis = autoQuote(rt, lead).basis + (credit ? ` ${credit.label} of ${money(credit.amount, k.currency)} applied.` : '');
  await rt.env.DB.prepare(
    `INSERT INTO contracts (id, token, lead_id, status, title, client_name, client_email, client_company, fee, currency, payment_terms, success_fee, scope, term_text, quote_basis, created_at, is_test, pay_link, credit_amount, credit_label, credit_pass_id)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, token(), lead?.id ?? '', k.title, k.client_name, k.client_email, k.client_company, k.fee, k.currency, k.payment_terms, k.success_fee, k.scope, k.term_text, basis, Date.now(), opts.test ? 1 : 0, k.pay_link,
    credit?.amount ?? 0, credit?.label ?? null, credit?.passId ?? null).run();
  return getContract(rt, id);
}

export async function updateDraft(rt: Runtime, c: Contract, body: ContractInput) {
  if (c.status !== 'draft') throw new Error('Only drafts can be edited. Void it and make a new one.');
  const lead = c.lead_id ? await getLead(rt.env, c.lead_id) : null;
  const k = cleanInput(rt, { ...c, ...body }, lead);
  const credit = await sprintCredit(rt, c.lead_id, k.currency);
  await rt.env.DB.prepare(
    'UPDATE contracts SET title = ?, client_name = ?, client_email = ?, client_company = ?, fee = ?, currency = ?, payment_terms = ?, success_fee = ?, scope = ?, term_text = ?, pay_link = ?, credit_amount = ?, credit_label = ?, credit_pass_id = ? WHERE id = ?',
  ).bind(k.title, k.client_name, k.client_email, k.client_company, k.fee, k.currency, k.payment_terms, k.success_fee, k.scope, k.term_text, k.pay_link, credit?.amount ?? 0, credit?.label ?? null, credit?.passId ?? null, c.id).run();
  return getContract(rt, c.id);
}

// ───────────── Email (from Josh) ─────────────

/** A clean, branded transactional email that renders in Gmail, Outlook and Apple Mail (tables, inline styles). */
export function contractEmail(o: { preheader: string; heading: string; paras: string[]; rows?: [string, string][]; button?: { label: string; href: string }; sender: string; company: string; address: string; test?: boolean }) {
  const e = escHtml;
  const [senderName, ...role] = o.sender.split(',');
  const rows = (o.rows ?? []).filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:10px 0;color:#6b7280;font-size:14px;border-top:1px solid #f0eee8">${e(k)}</td><td style="padding:10px 0;color:#111827;font-size:14px;font-weight:600;text-align:right;border-top:1px solid #f0eee8">${e(v)}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${e(o.heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f2ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ec"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
${o.test ? '<tr><td style="padding:0 0 12px;text-align:center"><span style="background:#fef3c7;color:#92400e;border-radius:999px;padding:4px 12px;font-size:12px">Test send: not a real agreement</span></td></tr>' : ''}
<tr><td style="padding:0 4px 14px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#0f2c5c;font-weight:700">${e(o.company)}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e5e2d9;border-radius:14px;padding:34px 32px 30px">
<h1 style="margin:0 0 18px;font-size:23px;line-height:1.3;color:#0f2c5c;font-weight:700">${e(o.heading)}</h1>
${o.paras.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#374151">${p}</p>`).join('')}
${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0 24px;border-bottom:1px solid #f0eee8">${rows}</table>` : ''}
${o.button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 16px"><tr><td style="background:#0f2c5c;border-radius:9px"><a href="${e(o.button.href)}" style="display:inline-block;padding:15px 30px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">${e(o.button.label)} &rarr;</a></td></tr></table>
<p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5">Button not working? Copy this link: <span style="color:#6b7280;word-break:break-all">${e(o.button.href)}</span></p>` : ''}
<p style="margin:26px 0 0;font-size:15px;line-height:1.5;color:#111827;font-weight:600">${e(senderName.trim())}<br><span style="color:#6b7280;font-size:13px;font-weight:400">${e([role.join(',').trim(), o.company].filter(Boolean).join(', '))}</span></p>
</td></tr>
<tr><td style="padding:16px 8px;font-size:12px;color:#9ca3af;text-align:center;line-height:1.6">${e(o.company)}${o.address ? `<br>${e(o.address)}` : ''}</td></tr>
</table></td></tr></table></body></html>`;
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, '’').replace(/&quot;/g, '"');
  const text = [o.heading, '', ...o.paras.map(strip), '', ...(o.rows ?? []).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), '', o.button ? `${o.button.label}: ${o.button.href}` : '', '', o.sender, o.company].join('\n');
  return { html, text };
}

async function sendContractEmail(rt: Runtime, c: Contract, kind: 'send' | 'reminder' | 'signed') {
  const co = company(rt);
  const first = (c.client_name ?? '').split(' ')[0] || 'there';
  const link = signUrl(rt, c.token);
  const due = feeDue(c);
  const fee = money(due.net, c.currency);
  const rows: [string, string][] = [['Agreement', c.title], ['Fee', money(c.fee, c.currency)], ...(due.credit ? [[due.label!, due.creditText!], ['Net amount due', fee]] as [string, string][] : []), ['Term', (c.term_text ?? '').replace(/\.$/, '')]];
  const base = { sender: c.our_signer ?? co.signer, company: co.name, address: co.address, test: Boolean(c.is_test) };
  const pre = c.is_test ? '[TEST] ' : '';
  const m =
    kind === 'signed'
      ? (() => {
          const pay = payLinkFor(rt, c);
          const bank = paymentDetails(rt)?.rows.length;
          return { subject: `${pre}Signed: ${c.title}`, ...contractEmail({ ...base, preheader: pay ? `Signed. Next: the ${fee} fee.` : 'Your signed copy, for your records.', heading: 'You’re all signed', paras: [`Hi ${escHtml(first)},`, `Thank you. The agreement is now signed by both of us. Your copy, with both signatures and the signing record, is here: <a href="${escHtml(link)}/copy">view your signed copy</a>. Keep this email for your records.`, ...(pay ? [`The fee of ${escHtml(fee)} is due now. You can pay securely with the button below.`] : bank ? [`The fee of ${escHtml(fee)} is due now. The bank details are on your signed copy. Please use “${escHtml(c.client_company || c.client_name || 'your name')}” as the reference.`] : [`I’ll send you the payment details for the ${escHtml(fee)} fee shortly.`]), 'I’ll be in touch within one business day with next steps.'], rows, button: pay ? { label: `Pay ${fee}`, href: pay } : { label: 'View your signed copy', href: `${link}/copy` } }) };
        })()
      : kind === 'reminder'
        ? { subject: `${pre}Reminder: ${c.title}`, ...contractEmail({ ...base, preheader: 'Ready when you are. Takes two minutes.', heading: 'Your agreement is ready to sign', paras: [`Hi ${escHtml(first)},`, 'Just bringing this back to the top of your inbox. The agreement is one page and takes about two minutes to sign from your phone or computer.', 'If anything needs changing, reply to this email and I’ll send a revised version.'], rows, button: { label: 'Review and sign', href: link } }) }
        : { subject: `${pre}${c.title}: ready to sign`, ...contractEmail({ ...base, preheader: `${fee}. One page, about two minutes to sign.`, heading: 'Your agreement is ready to sign', paras: [`Hi ${escHtml(first)},`, 'As discussed, here’s our agreement so we can get started. It’s one page, in plain English, and I’ve already signed it.', 'Have a read and sign online when you’re ready. If you’d like anything changed, just reply to this email.'], rows, button: { label: 'Review and sign', href: link } }) };
  if (!c.client_email) throw new Error('No email address on this agreement.');
  return sendViaResend(rt, { to: c.client_email, subject: m.subject, html: m.html, text: m.text, from: co.from, tags: { kind: `contract_${kind}` } });
}

/** We sign (countersign) and send in one step, so our signature is fixed before the client ever sees it. */
export async function signAndSend(rt: Runtime, c: Contract, ours: { name?: unknown; signature?: unknown; kind?: unknown }, ip: string | null) {
  if (c.status !== 'draft') throw new Error('This agreement has already been sent.');
  if (!emailConfigured(rt)) throw new Error('Email isn’t connected yet (Integrations → Email).');
  if (!c.client_email) throw new Error('Add the client’s email address first.');
  const name = typeof ours.name === 'string' && ours.name.trim().length >= 2 ? ours.name.trim().replace(/\s+/g, ' ').slice(0, 120) : null;
  if (!name) throw new Error('Type your name to sign.');
  const kind = ours.kind === 'drawn' ? 'drawn' : 'typed';
  const sig = kind === 'drawn' ? (typeof ours.signature === 'string' && PNG.test(ours.signature) && ours.signature.length < 300_000 ? ours.signature : null) : name;
  if (!sig) throw new Error('Draw your signature, or switch to typing it.');
  const co = company(rt);
  const role = co.signer.split(',').slice(1).join(',').trim();
  const signer = name.includes(',') || !role ? name : `${name}, ${role}`;
  const body = termsHtml(rt, c);
  const hash = await sha256(body);
  const now = Date.now();
  await rt.env.DB.prepare(
    `UPDATE contracts SET status = 'sent', body_html = ?, doc_hash = ?, sent_at = ?, our_signer = ?, our_signature = ?, our_signature_kind = ?, our_signed_at = ?, our_signer_ip = ?
      WHERE id = ? AND status = 'draft'`,
  ).bind(body, hash, now, signer, sig, kind, now, ip, c.id).run();
  const sent: Contract = { ...c, status: 'sent', body_html: body, doc_hash: hash, sent_at: now, our_signer: signer, our_signature: sig, our_signature_kind: kind, our_signed_at: now, our_signer_ip: ip };
  try {
    await sendContractEmail(rt, sent, 'send');
  } catch (e) {
    await rt.env.DB.prepare("UPDATE contracts SET status = 'draft', body_html = NULL, doc_hash = NULL, sent_at = NULL, our_signature = NULL, our_signature_kind = NULL, our_signed_at = NULL WHERE id = ?").bind(c.id).run();
    throw e;
  }
  return sent;
}

/** A full, signable copy sent to any address (yours), marked TEST everywhere and kept out of the numbers. */
export async function sendTest(rt: Runtime, c: Contract, to: string, ours: { name?: unknown; signature?: unknown; kind?: unknown }, ip: string | null) {
  if (!EMAIL.test(to)) throw new Error('Enter a valid email address for the test.');
  const lead = c.lead_id ? await getLead(rt.env, c.lead_id) : null;
  const copy = await createContract(rt, lead, { ...c, client_email: to }, { test: true });
  if (!copy) throw new Error('Could not create the test.');
  return signAndSend(rt, copy, ours, ip);
}

/** From the dashboard: email the client how to pay, with their signed copy. */
export async function sendPaymentEmail(rt: Runtime, c: Contract, opts: { link?: unknown; note?: unknown }) {
  if (c.status !== 'signed') throw new Error('Send the payment email once the agreement is signed.');
  if (!emailConfigured(rt)) throw new Error('Email isn’t connected yet (Integrations → Email).');
  if (!c.client_email) throw new Error('No email address on this agreement.');
  const given = typeof opts.link === 'string' && opts.link.trim() ? httpsUrl(opts.link) : undefined;
  if (given === null) throw new Error('The payment link must start with https://');
  const link = given ?? payLinkFor(rt, c);
  const bank = paymentDetails(rt)?.rows ?? [];
  if (!link && !bank.length) throw new Error('Add a payment link, or your bank details under Integrations → Contracts.');
  const co = company(rt);
  const due = feeDue(c);
  const fee = money(due.net, c.currency);
  const first = (c.client_name ?? '').split(' ')[0] || 'there';
  const note = typeof opts.note === 'string' && opts.note.trim() ? escHtml(opts.note.trim().slice(0, 800)) : null;
  const copy = `${signUrl(rt, c.token)}/copy`;
  const m = contractEmail({
    sender: c.our_signer ?? co.signer, company: co.name, address: co.address, test: Boolean(c.is_test),
    preheader: `${fee} for ${c.title}.`, heading: `Payment: ${fee}`,
    paras: [
      `Hi ${escHtml(first)},`,
      `Thanks again for signing. Here’s how to pay the ${escHtml(fee)} fee for our ${escHtml(c.title.toLowerCase())}.`,
      ...(note ? [note] : []),
      ...(bank.length ? [`<strong>Bank transfer</strong><br>${bank.map(([k, v]) => `${escHtml(k)}: <strong>${escHtml(v)}</strong>`).join('<br>')}<br>Reference: <strong>${escHtml(c.client_company || c.client_name || c.client_email)}</strong>`] : []),
      `Your signed agreement: <a href="${escHtml(copy)}">view or download</a>.`,
      ...(bank.length ? ['<span style="color:#8a5a00;font-size:13px">We will never change our bank details by email. If you get a message saying they have changed, call us before you pay.</span>'] : []),
    ],
    rows: [['Agreement', c.title], ...(due.credit ? [['Fee', money(c.fee, c.currency)], [due.label!, due.creditText!]] as [string, string][] : []), ['Amount due', fee]],
    button: link ? { label: `Pay ${fee}`, href: link } : undefined,
  });
  await sendViaResend(rt, { to: c.client_email, subject: `${c.is_test ? '[TEST] ' : ''}Payment for your ${c.title}`, html: m.html, text: m.text, from: co.from, tags: { kind: 'contract_payment' } });
  await rt.env.DB.prepare('UPDATE contracts SET pay_email_sent_at = ?, pay_link = COALESCE(?, pay_link) WHERE id = ?').bind(Date.now(), given ?? null, c.id).run();
}

/** Mark the fee as received (or undo it). Updates the lead's cash collected. */
export async function markPaid(rt: Runtime, c: Contract, paid: boolean) {
  if (c.status !== 'signed') throw new Error('Only a signed agreement can be marked paid.');
  await rt.env.DB.prepare('UPDATE contracts SET paid_at = ? WHERE id = ?').bind(paid ? Date.now() : null, c.id).run();
  if (paid && !c.is_test && c.lead_id) {
    const lead = await getLead(rt.env, c.lead_id);
    const net = feeDue(c).net;
    if (lead && (lead.cash_collected ?? 0) < net) await updateLead(rt.env, lead.id, { cash_collected: net });
  }
}

export async function voidContract(rt: Runtime, c: Contract) {
  if (c.status === 'signed') throw new Error('A signed agreement can’t be voided here.');
  await rt.env.DB.prepare("UPDATE contracts SET status = 'void', voided_at = ? WHERE id = ?").bind(Date.now(), c.id).run();
}

// ───────────── Client signing ─────────────

export const isExpired = (c: Contract) => Boolean(c.sent_at && Date.now() - c.sent_at > CONTRACT_TTL_DAYS * DAY);

export async function markViewed(rt: Runtime, c: Contract) {
  if (c.status === 'sent') await rt.env.DB.prepare("UPDATE contracts SET status = 'viewed', viewed_at = ? WHERE id = ? AND status = 'sent'").bind(Date.now(), c.id).run();
}

export interface SignInput { name?: unknown; title?: unknown; signature?: unknown; kind?: unknown; consent?: unknown; hash?: unknown }

export async function signContract(rt: Runtime, c: Contract, input: SignInput, meta: { ip: string | null; ua: string | null; country: string | null }) {
  if (c.status === 'signed') return { ok: false as const, error: 'This agreement has already been signed.' };
  if (c.status === 'void' || c.status === 'draft' || !c.body_html) return { ok: false as const, error: 'This agreement is no longer available. Ask us for a new link.' };
  if (isExpired(c)) return { ok: false as const, error: 'This signing link has expired. Reply to the email and we’ll send a fresh one.' };
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
  if (name.length < 2) return { ok: false as const, error: 'Type your full name.' };
  if (input.consent !== true) return { ok: false as const, error: 'Tick the box to agree to sign electronically.' };
  // They must be signing the exact terms they were shown.
  if (input.hash !== c.doc_hash) return { ok: false as const, error: 'This agreement changed while you had it open. Reload the page and review it again.' };
  const kind = input.kind === 'drawn' ? 'drawn' : 'typed';
  let signature = name;
  if (kind === 'drawn') {
    const sig = typeof input.signature === 'string' ? input.signature : '';
    if (!PNG.test(sig) || sig.length > 300_000) return { ok: false as const, error: 'Draw your signature, or switch to typing it.' };
    signature = sig;
  }
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) || null : null;
  const now = Date.now();
  const res = await rt.env.DB.prepare(
    `UPDATE contracts SET status = 'signed', signed_at = ?, signer_name = ?, signer_title = ?, signature = ?, signature_kind = ?, signer_ip = ?, signer_ua = ?, signer_country = ?
      WHERE id = ? AND status IN ('sent', 'viewed') AND doc_hash = ?`,
  ).bind(now, name, title, signature, kind, meta.ip, meta.ua?.slice(0, 300) ?? null, meta.country, c.id, c.doc_hash).run();
  if (!res.meta.changes) return { ok: false as const, error: 'This agreement has already been signed.' };
  rt.waitUntil(afterSigned(rt, { ...c, status: 'signed', signed_at: now, signer_name: name, signer_title: title, signature, signature_kind: kind }));
  return { ok: true as const };
}

async function afterSigned(rt: Runtime, c: Contract) {
  await sendContractEmail(rt, c, 'signed').catch((e) => console.error('signed copy email failed', e));
  const co = company(rt);
  const label = `${c.is_test ? '[TEST] ' : ''}Signed: ${c.client_name ?? c.client_email} (${money(c.fee, c.currency)})`;
  const internal = rt.settings.CONTRACT_NOTIFY_EMAIL || rt.settings.EMAIL_REPLY_TO;
  if (internal && emailConfigured(rt)) {
    const m = contractEmail({ preheader: 'Agreement signed.', heading: 'Agreement signed', paras: [`${escHtml(c.signer_name ?? '')} signed “${escHtml(c.title)}” for ${escHtml(money(c.fee, c.currency))}.`], button: { label: 'Open the signed copy', href: `${signUrl(rt, c.token)}/copy` }, sender: 'Funnel HQ', company: co.name, address: co.address, test: Boolean(c.is_test) });
    await sendViaResend(rt, { to: internal, subject: label, html: m.html, text: m.text, from: co.from, tags: { kind: 'contract_signed_internal' } }).catch(() => null);
  }
  if (c.is_test) return;
  const lead = c.lead_id ? await getLead(rt.env, c.lead_id) : null;
  if (lead) await updateLead(rt.env, lead.id, { contract_signed_at: c.signed_at, revenue: lead.revenue || c.fee });
  // The Sprint credit is now spent, and the Sprint board shows the engagement as signed.
  if (c.credit_pass_id && feeDue(c).credit) await rt.env.DB.prepare('UPDATE webinar_passes SET credit_used_contract = ?, updated_at = ? WHERE id = ?').bind(c.id, Date.now(), c.credit_pass_id).run().catch(() => null);
  if (c.lead_id) await (await import('../webinar/deal-sprint')).dealSprintSigned(rt, c).catch((e) => console.error('deal sprint signed', e));
  await notify(rt, { kind: 'won', title: `Agreement signed: ${money(c.fee, c.currency)}`, lead, lines: [c.client_name ?? c.client_email ?? '', c.title] }).catch(() => null);
}

/** Cron: a gentle reminder two and five days after sending, if it's still unsigned. */
export async function processContractReminders(rt: Runtime) {
  if (!emailConfigured(rt)) return null;
  const now = Date.now();
  const { results } = await rt.env.DB.prepare(
    `SELECT * FROM contracts WHERE status IN ('sent', 'viewed') AND is_test = 0 AND reminders < 2 AND sent_at > ?
       AND ((reminders = 0 AND sent_at < ?) OR (reminders = 1 AND sent_at < ?)) LIMIT 20`,
  ).bind(now - CONTRACT_TTL_DAYS * DAY, now - 2 * DAY, now - 5 * DAY).all<Contract>();
  let sent = 0;
  for (const c of results) {
    await rt.env.DB.prepare('UPDATE contracts SET reminders = reminders + 1, last_reminder_at = ? WHERE id = ?').bind(now, c.id).run();
    await sendContractEmail(rt, c, 'reminder').then(() => sent++, (e) => console.error('contract reminder failed', e));
  }
  return { sent };
}

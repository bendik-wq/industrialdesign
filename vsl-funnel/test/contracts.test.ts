import { describe, expect, it } from 'vitest';
import { autoQuote, cleanInput, contractEmail, documentHtml, feeDue, payLinkFor, signContract, termsHtml, type Contract } from '../src/sales/contracts';

const lead = (answers: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 'l1', email: 'sam@hvac.com', first_name: 'Sam', last_name: 'Lee', answers: JSON.stringify(answers), ...extra }) as never;
const rt = { settings: { SITE_NAME: 'G&L M&A Advisory', BUSINESS_ADDRESS: 'Sheridan, WY 82801, USA' }, origin: 'https://apply.example.com', env: {} } as never;

describe('auto-quote', () => {
  it('follows the $40k to $70k ladder by revenue, with EBITDA overrides', () => {
    expect(autoQuote(rt, lead({ revenue: 'lt1m' })).fee).toBe(40_000);
    expect(autoQuote(rt, lead({ revenue: '1_3m' })).fee).toBe(40_000);
    expect(autoQuote(rt, lead({ revenue: '3_10m' })).fee).toBe(50_000);
    expect(autoQuote(rt, lead({ revenue: '10_25m' })).fee).toBe(60_000);
    expect(autoQuote(rt, lead({ revenue: '25_50m' })).fee).toBe(70_000);
    expect(autoQuote(rt, lead({ revenue: '50_100m' })).fee).toBe(75_000);
    expect(autoQuote(rt, lead({ revenue: 'gt100m' })).fee).toBe(100_000);
    expect(autoQuote(rt, lead({ revenue: '10_25m', profit: 'pgt10m' })).fee).toBe(75_000);
    expect(autoQuote(rt, lead({ revenue: '1_3m', profit: 'p3_10m' })).fee).toBe(50_000);
    expect(autoQuote(rt, lead({})).fee).toBe(40_000);
    expect(autoQuote(rt, lead({})).basis).toContain('Typical engagements are $40k–$70k');
  });
  it('keeps old $10M+ answers working', () => {
    expect(autoQuote(rt, lead({ revenue: 'gt10m', profit: 'gt1m' })).fee).toBe(60_000);
  });
});

describe('engagement letter', () => {
  it('escapes everything a person typed', () => {
    const k = cleanInput(rt, { client_name: '<script>alert(1)</script>', client_company: 'A&B <b>Co</b>', scope: 'one\n<img src=x onerror=alert(1)>', fee: 30000 }, lead({}));
    const html = termsHtml(rt, k);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('$30,000 USD');
    expect(termsHtml(rt, cleanInput(rt, {}, lead({})))).toContain('seller rollover');
  });
  it('falls back to the quote for a bad fee and rejects a bad email', () => {
    const k = cleanInput(rt, { fee: -5, client_email: 'not-an-email' }, lead({ revenue: '25_50m' }));
    expect(k.fee).toBe(70_000);
    expect(k.client_email).toBeNull();
  });
});

const noGuarantee = { settings: { SITE_NAME: 'G&L M&A Advisory', BUSINESS_ADDRESS: 'Sheridan, WY 82801, USA', ENGAGEMENT_GUARANTEE: 'off' }, origin: 'https://apply.example.com', env: {} } as never;

describe('the one-page agreement', () => {
  const k = cleanInput(rt, {}, lead({ revenue: '3_10m' }));
  const html = termsHtml(rt, k);
  it('is a Wyoming LLC agreement with the protections that matter', () => {
    expect(html).toContain('G&amp;L M&amp;A Advisory LLC');
    expect(html).toContain('a Wyoming limited liability company');
    expect(html).toContain('Wyoming law governs');
    expect(html).toContain('Sheridan County, Wyoming');
    expect(html).toContain('non-refundable');
    expect(html).toContain('waive a jury trial');
    expect(html).toContain('broker-dealer');
    expect(html).toContain('E-SIGN Act');
    expect(html).not.toContain('Introductions'); // only with a success fee
    expect(termsHtml(rt, { ...k, success_fee: '2% of the purchase price, due at closing' })).toContain('Introductions');
  });
  it('shows the First Deal Sprint credit and the net amount due, only when there is one', () => {
    expect(html).not.toContain('credit');
    const credited = termsHtml(rt, { ...k, fee: 50_000, credit_amount: 3_000, credit_label: 'First Deal Sprint credit' });
    expect(credited).toContain('First Deal Sprint credit: <strong>−$3,000 USD</strong>');
    expect(credited).toContain('Net amount due: <strong>$47,000 USD</strong>');
    expect(feeDue({ fee: 2_000, currency: 'USD', credit_amount: 3_000 }).net).toBe(0); // never below zero
  });
  it('stays short (one printed page without the guarantee, under 800 words with it)', () => {
    const off = termsHtml(noGuarantee, k);
    expect(off.replace(/<[^>]+>/g, '').split(/\s+/).length).toBeLessThan(650);
    expect(html.replace(/<[^>]+>/g, '').split(/\s+/).length).toBeLessThan(800);
  });
  it('carries the LOI guarantee with every condition, and the fee is refundable only through it', () => {
    expect(html).toContain('Guarantee: Signed LOI in 90 days, or we keep working free');
    expect(html).toContain('keeps working with you at no extra cost until you do');
    for (const c of ['within 7 days of signing', 'missing no more than two', '25 owner contacts a week', 'within 2 business days', 'the 1.5x test']) expect(html).toContain(c);
    expect(html).toContain('doesn’t promise financing, a closed acquisition, or any return');
    expect(html).toContain('non-refundable</strong> (except as the guarantee in this agreement provides)');
    const off = termsHtml(noGuarantee, k);
    expect(off).not.toContain('Signed LOI in 90 days');
    expect(off).toContain('No guarantee');
  });
  it('shows Josh as co-founder, awaiting both signatures until signed', () => {
    const doc = documentHtml(rt, k);
    expect(doc).toContain('Josh Li, Co-Founder');
    expect(doc.match(/Awaiting signature/g)?.length).toBe(2);
  });
  it('builds a branded email with the sign button', () => {
    const m = contractEmail({ preheader: 'p', heading: 'Your agreement is ready to sign', paras: ['Hi Sam,'], rows: [['Fee', '$25,000 USD']], button: { label: 'Review and sign', href: 'https://x/sign/abc' }, sender: 'Josh Li, Co-Founder', company: 'G&L M&A Advisory LLC', address: 'Sheridan, WY', test: true });
    expect(m.html).toContain('Review and sign');
    expect(m.html).toContain('Test send');
    expect(m.text).toContain('https://x/sign/abc');
  });
});

describe('signing', () => {
  const base = { id: 'k1', token: 'a'.repeat(40), status: 'sent', body_html: '<p>x</p>', doc_hash: 'h1', sent_at: Date.now() } as Contract;
  const meta = { ip: '1.2.3.4', ua: 'test', country: 'AU' };
  it('needs a name, consent and the exact document', async () => {
    expect((await signContract(rt, base, { name: 'S', consent: true, hash: 'h1' }, meta)).ok).toBe(false);
    expect((await signContract(rt, base, { name: 'Sam Lee', consent: false, hash: 'h1' }, meta)).ok).toBe(false);
    expect((await signContract(rt, base, { name: 'Sam Lee', consent: true, hash: 'changed' }, meta)).ok).toBe(false);
    expect((await signContract(rt, base, { name: 'Sam Lee', consent: true, hash: 'h1', kind: 'drawn', signature: 'javascript:alert(1)' }, meta)).ok).toBe(false);
  });
  it('refuses drafts, void and expired letters', async () => {
    expect((await signContract(rt, { ...base, status: 'draft' }, { name: 'Sam Lee', consent: true, hash: 'h1' }, meta)).ok).toBe(false);
    expect((await signContract(rt, { ...base, status: 'void' }, { name: 'Sam Lee', consent: true, hash: 'h1' }, meta)).ok).toBe(false);
    expect((await signContract(rt, { ...base, sent_at: Date.now() - 40 * 86_400_000 }, { name: 'Sam Lee', consent: true, hash: 'h1' }, meta)).ok).toBe(false);
  });
});

describe('payment details', () => {
  const k = cleanInput(rt, {}, lead({}));
  it('are left off until a bank account or pay link is set', () => {
    expect(termsHtml(rt, k)).not.toContain('How to pay');
  });
  it('go into the signed terms with a wire-fraud warning', () => {
    const rt2 = { settings: { CONTRACT_PAY_BANK: 'Mercury', CONTRACT_PAY_ROUTING: '091311229', CONTRACT_PAY_ACCOUNT: '9800<b>12', CONTRACT_PAY_LINK: 'javascript:alert(1)' } } as never;
    const html = termsHtml(rt2, k);
    expect(html).toContain('How to pay');
    expect(html).toContain('091311229');
    expect(html).toContain('9800&lt;b&gt;12');
    expect(html).toContain('never change these details by email');
    expect(html).not.toContain('javascript:');
  });
  it('shows a Sign here field on the signing page', () => {
    expect(documentHtml(rt, k, { field: true })).toContain('data-sig-field');
  });
});

describe('payment link', () => {
  it('uses this agreement’s link, else the default, and only https', () => {
    const rt3 = { settings: { CONTRACT_PAY_LINK: 'https://buy.stripe.com/default' } } as never;
    expect(payLinkFor(rt3, { pay_link: 'https://buy.stripe.com/client' })).toBe('https://buy.stripe.com/client');
    expect(payLinkFor(rt3, { pay_link: null })).toBe('https://buy.stripe.com/default');
    expect(payLinkFor(rt, { pay_link: 'javascript:alert(1)' })).toBeNull();
    expect(cleanInput(rt, { pay_link: 'http://insecure.example' }, lead({})).pay_link).toBeNull();
  });
});

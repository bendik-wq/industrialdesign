import { describe, expect, it } from 'vitest';
import { autoQuote, cleanInput, letterHtml, signContract, type Contract } from '../src/sales/contracts';

const lead = (answers: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 'l1', email: 'sam@hvac.com', first_name: 'Sam', last_name: 'Lee', answers: JSON.stringify(answers), ...extra }) as never;
const rt = { settings: { SITE_NAME: 'G&L M&A Advisory', SALES_TIMEZONE: 'Australia/Sydney' }, origin: 'https://apply.example.com', env: {} } as never;

describe('auto-quote', () => {
  it('starts at $20k and scales with revenue and EBITDA', () => {
    expect(autoQuote(lead({ revenue: '1_3m' })).fee).toBe(20_000);
    expect(autoQuote(lead({ revenue: '3_10m' })).fee).toBe(25_000);
    expect(autoQuote(lead({ revenue: '25_50m' })).fee).toBe(50_000);
    expect(autoQuote(lead({ revenue: '10_25m', profit: 'pgt10m' })).fee).toBe(75_000);
    expect(autoQuote(lead({})).fee).toBe(20_000);
  });
  it('keeps old $10M+ answers working', () => {
    expect(autoQuote(lead({ revenue: 'gt10m', profit: 'gt1m' })).fee).toBe(35_000);
  });
});

describe('engagement letter', () => {
  it('escapes everything a person typed', () => {
    const k = cleanInput({ client_name: '<script>alert(1)</script>', client_company: 'A&B <b>Co</b>', scope: 'one\n<img src=x onerror=alert(1)>', fee: 30000 }, lead({}));
    const html = letterHtml(rt, k);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A$30,000');
    expect(letterHtml(rt, cleanInput({}, lead({})))).toContain('seller rollover');
  });
  it('falls back to the quote for a bad fee and rejects a bad email', () => {
    const k = cleanInput({ fee: -5, client_email: 'not-an-email' }, lead({ revenue: '25_50m' }));
    expect(k.fee).toBe(50_000);
    expect(k.client_email).toBeNull();
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

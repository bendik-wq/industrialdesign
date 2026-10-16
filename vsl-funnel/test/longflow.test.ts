import { describe, expect, it } from 'vitest';
import { auditEmail } from '../src/content/copy-rules';
import { zonedTime } from '../src/integrations/email';
import { SEQUENCES } from '../src/integrations/sequences';
import { TEMPLATES } from '../src/integrations/templates';
import { LIB_SLOT, LIB_TOPICS, interestsFrom, longPlan, longTimes, pickLibrary } from '../src/longflow/engine';
import { LIBRARY, LONG_FLOWS, LONG_TEMPLATES } from '../src/longflow';
import { GUIDE_SLUGS, type LongEmail, renderLong } from '../src/longflow/kit';
import { PAGE_RULES } from '../src/longflow/page-rules';

const DAY = 86_400_000;
const ctx: any = { lead: { id: 'l' }, name: 'Sam', siteName: 'G&L', link: (p: string) => p, bookingUrl: '/book', whatsappUrl: null, callTime: null, webinarUrl: 'https://live.x/webinar' };

describe('six-month flows: schedule', () => {
  const start = Date.UTC(2026, 9, 1, 0, 0);
  const ts = longTimes(start, 'Australia/Sydney', 1000, 182, zonedTime);
  const local = (t: number) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hourCycle: 'h23' }).format(t);
  it('lands exactly the total, in order, 8am–8pm their time, within six months', () => {
    expect(ts).toHaveLength(1000);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    for (const t of ts) { const h = Number(local(t)); expect(h).toBeGreaterThanOrEqual(8); expect(h).toBeLessThanOrEqual(20); }
    expect(Math.max(...ts) - start).toBeLessThan(183 * DAY);
  });
  it('is front-loaded: ~10 a day in month 1, ~6 in months 2–3, ~3–4 after', () => {
    const inRange = (a: number, b: number) => ts.filter((t) => t >= start + a * DAY && t < start + b * DAY).length;
    expect(inRange(0, 30) / 30).toBeGreaterThan(9);
    expect(inRange(30, 90) / 60).toBeGreaterThan(5);
    expect(inRange(90, 182) / 92).toBeLessThan(4.5);
  });
  it('gives the flow’s own emails about half of month 1 and never strands them', () => {
    const flow = Array.from({ length: 200 }, (_, i) => `lf_x_${i}`);
    const plan = longPlan(ts, start, flow);
    expect(plan.filter((t) => t !== LIB_SLOT)).toEqual(flow);
    const month1 = plan.slice(0, ts.filter((t) => t < start + 30 * DAY).length);
    const share = month1.filter((t) => t !== LIB_SLOT).length / month1.length;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
  });
});

describe('six-month flows: library picks follow behaviour', () => {
  const lib = Object.fromEntries(LIB_TOPICS.map((t) => [t, Array.from({ length: 5 }, (_, i) => ({ id: `lib_${t}_${i}`, subject: '', preheader: '', body: [], ...(t === 'industries' ? { industries: [i % 2 ? 'dental' : 'hvac'] } : {}) }))])) as any;
  it('a seller-finance reader gets seller-finance emails far more often, in order', () => {
    const interests = interestsFrom(['/guides/seller-finance-explained', '/guides/100-percent-vendor-finance'], []);
    const sent = new Set<string>();
    for (let i = 0; i < 20; i++) sent.add(pickLibrary(lib, sent, interests)!);
    const sf = [...sent].filter((x) => x.startsWith('lib_seller_finance_'));
    expect(sf.length).toBe(5);
    expect(sf).toEqual(['lib_seller_finance_0', 'lib_seller_finance_1', 'lib_seller_finance_2', 'lib_seller_finance_3', 'lib_seller_finance_4']);
  });
  it('industry emails only go to owners in that industry', () => {
    const none = new Set<string>(); const sentNone = new Set<string>();
    for (let i = 0; i < 80; i++) { const p = pickLibrary(lib, sentNone, interestsFrom([], [])); if (p) sentNone.add(p); }
    expect([...sentNone].some((x) => x.startsWith('lib_industries_'))).toBe(false);
    for (let i = 0; i < 80; i++) { const p = pickLibrary(lib, none, interestsFrom(['/for/dental/ceiling'], [])); if (p) none.add(p); }
    expect([...none].filter((x) => x.startsWith('lib_industries_'))).toEqual(['lib_industries_1', 'lib_industries_3']);
  });
  it('returns null when everything has been sent', () => {
    const all = new Set(Object.values(lib).flat().map((e: any) => e.id));
    expect(pickLibrary(lib, all, interestsFrom([], ['dental', 'hvac']))).toBeNull();
  });
});

describe('six-month flows: content', () => {
  const library = Object.values(LIBRARY).flat();
  const flows = Object.entries(LONG_FLOWS);
  it('has a ~800-email library and ~200 written emails per flow', () => {
    expect(library.length).toBeGreaterThanOrEqual(780);
    for (const [id, f] of flows) expect(f.emails.length, id).toBeGreaterThanOrEqual(id === 'reactivation' ? 95 : 190);
    for (const [id] of flows) expect(SEQUENCES[id as keyof typeof SEQUENCES], id).toBeTruthy();
  });
  it('every email is registered, passes the copy rules, and uses a real guide', () => {
    const ids = new Set<string>();
    for (const [id, fn] of Object.entries(LONG_TEMPLATES)) {
      expect(ids.has(id)).toBe(false); ids.add(id);
      expect(TEMPLATES[id], id).toBe(fn);
      const c = fn({ ...ctx, ask: 'book' });
      expect(auditEmail(c), id).toEqual([]);
      if (c.cta) expect(c.cta.href, id).toMatch(/^(\/book|\/apply|https:\/\/live\.x\/webinar|\/guides\/[a-z0-9-]+)$/);
      if (c.cta?.href.startsWith('/guides/')) expect(GUIDE_SLUGS as readonly string[], id).toContain(c.cta.href.slice(8));
      expect(JSON.stringify(c), id).not.toMatch(/\bfree\b[^.]{0,30}\b(call|session|masterclass|webinar)\b|\{(?!name\})[a-z_]+\}/i);
    }
  });
  it('the ask follows the flow', () => {
    const e: LongEmail = { id: 'lib_x', subject: 's', preheader: 'p', body: ['{name},', 'x'], cta: 'next' };
    expect(renderLong(e, { ...ctx, ask: 'apply' }).cta?.href).toBe('/apply');
    expect(renderLong(e, { ...ctx, ask: 'book' }).cta?.href).toBe('/book');
    expect(renderLong(e, { ...ctx, ask: 'webinar' }).cta?.href).toBe('https://live.x/webinar');
    expect(renderLong(e, { ...ctx, ask: 'book' }).body[0]).toBe('Sam,');
  });
  it('every page rule has its email', () => {
    for (const r of PAGE_RULES) expect(LONG_TEMPLATES[r.template], r.template).toBeTypeOf('function');
  });
});

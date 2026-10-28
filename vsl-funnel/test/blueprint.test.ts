import { describe, expect, it } from 'vitest';
import {
  type BlueprintInputs, blueprintCopyIssues, blueprintHtml, buildBlueprint, chooseLever, inputsHash, maxPriceAt, money, payment, stack, validateProse,
} from '../src/webinar/blueprint';
import { SEQUENCES } from '../src/integrations/sequences';
import { TEMPLATES, type TemplateCtx } from '../src/integrations/templates';
import { auditEmail } from '../src/content/copy-rules';
import type { Lead } from '../src/funnel/leads';

const o = { origin: 'https://apply.test', webinarBase: 'https://live.test', token: 'tok123' };
const base: BlueprintInputs = { firstName: null, band: null, industry: null, commit: null, polls: {}, calc: null, app: null, applied: false, booked: false };
const full: BlueprintInputs = {
  firstName: 'Sam', band: '3m-10m', industry: 'hvac', commit: 'competitor',
  polls: { target_type: 'competitor', timeline: '0_3', blocker: 'financing', own_cash: 'none', soft_close: 'yes' },
  calc: { profit: 600_000, price: 1_800_000 },
  app: { business: 'Coastal Air <b>HVAC</b>', revenue: '3_10m', profit: '250k_1m', timeline: '0_6', blockers: ['funding'], whyNow: 'My biggest competitor is retiring!' },
  applied: true, booked: false,
};
const under: BlueprintInputs = { ...base, firstName: 'Lee', band: '100k-1m', polls: { blocker: 'confidence', timeline: 'learning' } };
const failing: BlueprintInputs = { ...base, firstName: 'Ana', band: '1m-3m', calc: { profit: 300_000, price: 1_800_000 }, polls: { blocker: 'structuring', own_cash: 'happy', target_type: 'supplier' } };

describe('deal maths (same as the room calculator)', () => {
  it('computes level loan payments', () => {
    expect(payment(1_050_000, 0.09, 10)).toBeCloseTo(163_610, -1);
    expect(payment(300_000, 0.06, 5)).toBeCloseTo(71_219, -1);
    expect(payment(0, 0.09, 10)).toBe(0);
  });
  it('splits 70/20/10 and runs the 1.5x test', () => {
    const s = stack(500_000, 1_500_000);
    expect(s.debt).toBe(1_050_000); expect(s.note).toBe(300_000); expect(s.roll).toBe(150_000);
    expect(s.service).toBeCloseTo(234_829, -1);
    expect(s.dscr).toBeCloseTo(2.13, 2);
    expect(s.passes).toBe(true);
    expect(stack(300_000, 1_500_000).passes).toBe(false);
  });
  it('max price clears exactly 1.5x', () => {
    expect(stack(400_000, maxPriceAt(400_000)).dscr).toBeCloseTo(1.5, 6);
  });
});

describe('lever choice', () => {
  it('none when the deal passes', () => expect(chooseLever(500_000, 1_500_000)).toBeNull());
  it('more seller rollover first, then a longer seller note', () => {
    expect(stack(100_000, 460_000).passes).toBe(false);
    expect(chooseLever(100_000, 460_000)!.id).toBe('rollover');
    const l = chooseLever(100_000, 480_000)!;
    expect(l.id).toBe('note_term');
    expect(l.after!.dscr).toBeGreaterThanOrEqual(1.5);
  });
  it('then both moves, then the price', () => {
    expect(chooseLever(100_000, 520_000)!.id).toBe('both');
    const p = chooseLever(300_000, 1_800_000)!;
    expect(p.id).toBe('price');
    expect(p.maxPrice).toBeLessThan(1_800_000);
  });
});

describe('rules blueprint', () => {
  it('works with no data at all', () => {
    const bp = buildBlueprint(base, o);
    expect(bp.qualified).toBe(true);
    expect(bp.profile).toEqual([]);
    expect(bp.target.key).toBe('not_sure');
    expect(bp.numbers.fromCalc).toBe(false);
    expect(bp.numbers.deal.passes).toBe(true);
    expect(bp.next.kind).toBe('apply');
    expect(bp.next.href).toBe('https://apply.test/w/tok123');
    expect(bp.prose.where).toContain('illustrative $2M');
  });
  it('uses everything they told us', () => {
    const bp = buildBlueprint(full, o);
    expect(bp.bandLabel).toBe('$3M–$10M');
    expect(bp.numbers.fromCalc).toBe(true);
    expect(bp.numbers.deal.price).toBe(1_800_000);
    expect(bp.numbers.ownProfit).toBe(550_000);
    expect(bp.numbers.ownProfitAssumed).toBe(false);
    expect(bp.numbers.targetProfit).toEqual([500_000, 1_300_000]);
    expect(bp.prose.where).toContain('financing');
    expect(bp.prose.deal).toContain('HVAC company you keep bidding against');
    expect(bp.quote).toContain('retiring');
    expect(bp.next.kind).toBe('book');
    expect(bp.profile.map((p) => p.label)).toContain('Deal you ran in the calculator');
    expect(bp.numbers.gap.gap).toBeCloseTo((550_000 + 600_000) * 6);
  });
  it('under $1M gets the keep-building step with the worksheet', () => {
    const bp = buildBlueprint(under, o);
    expect(bp.qualified).toBe(false);
    expect(bp.next.kind).toBe('keep_building');
    expect(bp.next.href).toBe('https://live.test/worksheet/tok123');
    expect(bp.prose.next).toMatch(/\$1M or more/);
  });
  it('failing DSCR names the lever', () => {
    const bp = buildBlueprint(failing, o);
    expect(bp.numbers.deal.passes).toBe(false);
    expect(bp.numbers.lever?.id).toBe('price');
    expect(bp.prose.verdict).toContain('falls short');
    expect(bp.prose.lever).toMatch(/negotiate toward/);
    expect(bp.prose.stack).toContain('happy to put cash in');
  });
  it('booked leads bring it to the call', () => {
    expect(buildBlueprint({ ...full, booked: true }, o).next.kind).toBe('booked');
  });
  it('hash changes when the inputs change', () => {
    expect(inputsHash(full, 'rules')).toBe(inputsHash({ ...full }, 'rules'));
    expect(inputsHash(full, 'rules')).not.toBe(inputsHash({ ...full, calc: { profit: 1, price: 2 } }, 'rules'));
    expect(inputsHash(full, 'rules')).not.toBe(inputsHash(full, 'ai'));
  });
});

describe('copy rules', () => {
  const cases: [string, BlueprintInputs][] = [['no data', base], ['full data', full], ['under $1M', under], ['failing DSCR', failing],
    ...(['finding', 'time', 'integration'] as const).map((b) => [`blocker ${b}`, { ...base, band: '10m-25m', polls: { blocker: b, target_type: 'adjacent', timeline: '6_12' } }] as [string, BlueprintInputs]),
    ['customer, rollover lever', { ...base, band: '1m-3m', calc: { profit: 100_000, price: 460_000 }, polls: { target_type: 'customer', own_cash: 'some' } }],
    ['note lever', { ...base, calc: { profit: 100_000, price: 480_000 } }],
    ['both lever', { ...base, calc: { profit: 100_000, price: 520_000 }, commit: 'supplier' }]];
  for (const [name, i] of cases) {
    it(`generated copy passes for ${name}`, () => {
      const bp = buildBlueprint(i, o);
      expect(blueprintCopyIssues(bp)).toEqual([]);
      // Every section with numbers says illustrative; funding always names all three.
      for (const k of ['deal', 'stack', 'gap'] as const) expect(bp.prose[k]).toMatch(/illustrative/i);
      expect(bp.prose.stack).toMatch(/commercial debt/i);
      expect(bp.prose.stack).toMatch(/seller finance/i);
      expect(bp.prose.stack).toMatch(/seller rollover/i);
      expect(JSON.stringify(bp.prose)).not.toMatch(/free/i);
    });
  }

  it('the page escapes their words and labels the numbers', () => {
    const html = blueprintHtml(buildBlueprint(full, o), { preparedAt: Date.parse('2026-10-28T10:00:00Z'), tz: 'Australia/Sydney' });
    expect(html).toContain('Prepared for <strong>Sam</strong> · 28 October 2026');
    expect(html).toContain('Coastal Air &lt;b&gt;HVAC&lt;/b&gt;');
    expect(html).not.toContain('<b>HVAC</b>');
    expect((html.match(/bp-tag">Illustrative/g) ?? []).length).toBe(3);
    expect(html).toContain('not an offer of finance');
    expect(html).toContain(money(1_800_000));
  });

  it('the email passes the copy rules and links to the blueprint', () => {
    const ctx = { name: 'Sam', link: (p: string) => `https://apply.test${p}`, webinar: { title: 't', when: 'w', room: 'r', replay: 'rp', ics: null, google: null, replayHours: 48, durationMin: 60, blueprint: 'https://live.test/blueprint/tok', apply: 'https://apply.test/w/tok' } } as unknown as TemplateCtx;
    const c = TEMPLATES.w_blueprint(ctx);
    expect(c.cta?.href).toBe('https://live.test/blueprint/tok');
    expect(auditEmail({ subject: c.subject, preheader: c.preheader, body: c.body, ps: c.ps })).toEqual([]);
  });
});

describe('webinar sequence', () => {
  const seq = SEQUENCES.webinar;
  const step = (t: string) => seq.steps.find((s) => s.template === t)!;
  it('appends w_blueprint at the end and stays inside the cycle', () => {
    expect(seq.steps[seq.steps.length - 1].template).toBe('w_blueprint');
    expect(seq.steps.length).toBeLessThanOrEqual(seq.cycle!);
    expect(TEMPLATES.w_blueprint).toBeTypeOf('function');
  });
  it('goes to people who watched past the pitch and have not applied', () => {
    const at = Date.parse('2026-10-28T08:00:00Z');
    const watched = { status: 'webinar', webinar_at: at, webinar_attended_at: at + 60_000, webinar_watch_pct: 0.9 } as unknown as Lead;
    expect(step('w_blueprint').skipIf!(watched)).toBe(false);
    expect(step('w_blueprint').skipIf!({ ...watched, webinar_watch_pct: 0.4 })).toBe(true);
    expect(step('w_blueprint').skipIf!({ ...watched, app_completed_at: at + 1 })).toBe(true);
    expect(step('w_blueprint').skipIf!({ ...watched, webinar_attended_at: null })).toBe(true);
  });
});

describe('AI prose validator', () => {
  const rules = buildBlueprint(full, o).prose;
  it('accepts the rules text itself', () => expect(validateProse(rules, rules)).toBeNull());
  it('rejects new numbers', () => expect(validateProse({ ...rules, gap: `${rules.gap} Owners like you see 40% returns.` }, rules)).toMatch(/new number|guarantee|pattern/));
  it('rejects dropping "illustrative"', () => expect(validateProse({ ...rules, deal: rules.deal.replace(/illustrative/gi, 'rough') }, rules)).toMatch(/illustrative/));
  it('rejects funding without seller rollover', () => expect(validateProse({ ...rules, stack: 'Commercial debt and seller finance cover the price, an illustrative structure.' }, rules)).toMatch(/rollover/));
  it('rejects exclamation marks, a free call, links and wrong shape', () => {
    expect(validateProse({ ...rules, next: 'Apply now for your free strategy call with my team today.' }, rules)).toBeTruthy();
    expect(validateProse({ ...rules, where: `${rules.where} Big moment!` }, rules)).toBeTruthy();
    expect(validateProse({ ...rules, intro: `${rules.intro} See https://x.test` }, rules)).toBeTruthy();
    expect(validateProse({ ...rules, weeks: [rules.weeks[0]] }, rules)).toBe('weeks');
    expect(validateProse(null, rules)).toBe('bad shape');
  });
  it('rejects hedges and invented proof', () => {
    expect(validateProse({ ...rules, where: `${rules.where} This might work for you.` }, rules)).toMatch(/hedge/);
    expect(validateProse({ ...rules, lever: `${rules.lever} We helped clients do this.` }, rules)).toMatch(/invented/);
  });
});

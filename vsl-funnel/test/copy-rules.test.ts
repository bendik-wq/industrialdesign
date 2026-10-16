import { describe, expect, it } from 'vitest';
import { auditCopy, auditEmail, copyBrief } from '../src/content/copy-rules';

const rules = (t: string, kind?: 'video' | 'email' | 'ideas') => auditCopy(t, { kind }).map((i) => i.rule);

describe('copy blacklist auditor', () => {
  it('flags the parallel repetition stack', () => {
    for (const t of ['More leads. More calls. More revenue.', 'Same service. Same skill. Same market.', 'No inspections. No appraisals. No banks.', 'People with money. People with a specific problem. People who are ready to invest.', "It's another year of slow growth. It's a competitor buying the business you wanted. It's staying the bottleneck in your own company."]) {
      expect(rules(t), t).toContain('parallel repetition stack');
    }
  });
  it('flags the false contrast stack', () => {
    expect(rules("It's not the price. It's not the bank. It's the structure.")).toContain('false contrast stack');
  });
  it('flags the triple short stack', () => {
    expect(rules("This works. It's proven. Here's why.")).toContain('triple short sentence stack');
  });
  it('flags rhetorical openers, "Imagine", fillers and hedges', () => {
    expect(rules('So, how does it work?')).toContain('rhetorical section opener');
    expect(rules('But what does that actually mean?')).toContain('rhetorical section opener');
    expect(rules('Imagine waking up to a calendar full of booked calls.')).toContain('"Imagine" opener');
    expect(rules("Here's the thing, most owners wait.")).toContain('filler: "here\'s the thing"');
    expect(rules("Let's dive in.")).toContain('filler: "let\'s dive in"');
    expect(rules('This could potentially double the business.')).toContain('hedge: "could potentially"');
    expect(rules('Lenders usually ask for three years of returns.')).toContain('hedge: "usually"');
  });
  it('enforces the house rules', () => {
    expect(rules('Book your free strategy call today.')).toContain('house rule: the call is never "free"');
    expect(rules('We guarantee you funding.')).toContain('house rule: no guarantees');
  });
  it('flags emoji, exclamation points and dense email paragraphs', () => {
    expect(rules('Big news 🚀')).toContain('emoji');
    expect(rules('Done.', 'email')).toEqual([]);
    expect(rules('Done!', 'email')).toContain('exclamation points');
    expect(rules('One. Two words here. Three words here now. Four is here too.', 'email').some((r) => r.startsWith('dense paragraph'))).toBe(true);
  });
  it('passes escalation chains and ordinary prose', () => {
    const ok = [
      'The bank lends against the target’s cash flow.\nThe seller carries a note for part of the price.\nAnd the owner rolls a slice into the new company, so they get paid twice.',
      'Most owners save for years to buy their first competitor. The ones building groups let the target’s profit pay for it.',
      'The deal has to clear 1.5x debt service coverage. That one number decides whether a lender says yes.',
      'A 7-day money-back guarantee applies to the program.',
    ];
    for (const t of ok) expect(auditCopy(t, { kind: 'email' }), t).toEqual([]);
  });
  it('audits an email without reading the greeting into the body', () => {
    expect(auditEmail({ subject: 'your application', preheader: 'It saved.', body: ['Hey Sam,', 'You started the application and stopped at the funding question.', 'That part takes two minutes.'], ps: '' })).toEqual([]);
    expect(auditEmail({ subject: 's', preheader: 'p', body: ['Hey Sam,', 'More leads. More calls. More revenue.'] }).map((i) => i.rule)).toContain('parallel repetition stack');
  });
  it('builds a brief with the blacklist, the house rules and the 3C mechanism', () => {
    const b = copyBrief('video');
    expect(b).toContain('Parallel Repetition Stack');
    expect(b).toContain('never call the strategy call "free"'.replace('never', 'Never'));
    expect(b).toContain('3C Acquisition Model');
    expect(b).toContain('seller rollover');
    expect(copyBrief('ideas')).not.toContain('THE SULTANIC STRUCTURES');
  });
});

import { toRtf } from '../src/content/doc-model';
describe('RTF export', () => {
  it('never prints a symbol Google Docs can’t read as "?"', () => {
    const rtf = toRtf([{ kind: 'p', runs: [{ text: '“No money down” ≠ “house down” → about ≈ 1.5x' }], size: 12, color: '#000000' } as never]);
    expect(rtf).toContain('is not');
    expect(rtf).not.toMatch(/\\'94 \? /);
  });
});

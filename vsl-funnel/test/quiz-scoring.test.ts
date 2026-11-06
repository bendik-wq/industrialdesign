import { describe, expect, it } from 'vitest';
import { auditCopy, auditEmail } from '../src/content/copy-rules';
import { ARCHETYPES, ARCHETYPE_ORDER, GAPS, QUESTIONS, QUIZ_COPY, RESULT_COPY } from '../src/quiz/content';
import { type Answers, BLOCKER_GAP, MARGIN_MID, REVENUE_MID, WEIGHTS, archetypeFor, cleanAnswers, missingAnswers, money, readinessScore, scoreQuiz, teaser, topGaps } from '../src/quiz/scoring';
import { quizScreens, resultHtml, teaserLines } from '../src/quiz/pages';
import { resultEmail, quizTarget } from '../src/quiz/quiz';
import { APP_REVENUE_BAND } from '../src/sales/qualify';
import { dealMath } from '../src/webinar/experience';
import { CONSENT_COPY } from '../src/integrations/consent-gate';

const BEST: Answers = { revenue: '10_25m', industry: 'healthcare', goal: 'competitor', margin: 'gt30', debt: 'use', funding: 'structure', deals: '2', timeline: '90d', blocker: 'finding', team: 'yes' };
const WORST: Answers = { revenue: 'lt1m', industry: 'other', goal: 'unsure', margin: 'lt10', debt: 'never', funding: 'unsure', deals: '0', timeline: 'exploring', blocker: 'time', team: 'no' };
const MID: Answers = { revenue: '3_10m', industry: 'trades', goal: 'competitor', margin: '10_20', debt: 'open', funding: 'bank', deals: '0', timeline: '6_12', blocker: 'funding', team: 'partly' };

describe('quiz: the questions', () => {
  it('has ten questions, one per screen, with the brief’s topics and the webinar form’s own revenue values', () => {
    expect(QUESTIONS.map((q) => q.id)).toEqual(['revenue', 'industry', 'goal', 'margin', 'debt', 'funding', 'deals', 'timeline', 'blocker', 'team']);
    expect(QUESTIONS.find((q) => q.id === 'revenue')!.options.map((o) => o.value).every((v) => v in APP_REVENUE_BAND)).toBe(true);
    expect(QUESTIONS.find((q) => q.id === 'deals')!.options.map((o) => o.value)).toEqual(['0', '1', '2']);
    expect(QUESTIONS.find((q) => q.id === 'timeline')!.options.map((o) => o.value)).toEqual(['90d', '6_12', 'exploring']);
    expect(QUESTIONS.find((q) => q.id === 'team')!.options.map((o) => o.value)).toEqual(['yes', 'partly', 'no']);
    for (const q of QUESTIONS) expect(q.options.length, q.id).toBeLessThanOrEqual(7);
  });

  it('keeps only known answers', () => {
    expect(cleanAnswers({ revenue: '3_10m', team: 'maybe', extra: 'x', goal: 1 })).toEqual({ revenue: '3_10m' });
    expect(cleanAnswers(null)).toEqual({});
    expect(missingAnswers(BEST)).toEqual([]);
    expect(missingAnswers({ revenue: 'lt1m' })).toHaveLength(9);
  });
});

describe('quiz: scoring', () => {
  it('the weights add to exactly 100, every point table stays within its max, and each answer maps to a gap', () => {
    expect(Object.values(WEIGHTS).reduce((t, w) => t + w.max, 0)).toBe(100);
    for (const [id, w] of Object.entries(WEIGHTS)) {
      const q = QUESTIONS.find((x) => x.id === id)!;
      expect(Object.keys(w.points).sort(), id).toEqual(q.options.map((o) => o.value).sort());
      expect(Math.max(...Object.values(w.points)), id).toBe(w.max);
      expect(w.gap in GAPS, id).toBe(true);
    }
    for (const g of Object.values(BLOCKER_GAP)) expect(g in GAPS).toBe(true);
  });

  it('scores the best answers 100, the weakest low, and is deterministic', () => {
    expect(readinessScore(BEST).score).toBe(100);
    expect(readinessScore(WORST).score).toBe(4 + 3 + 3 + 2 + 0 + 3 + 2 + 2);
    expect(readinessScore(MID).score).toBe(16 + 8 + 8 + 3 + 8 + 8 + 7 + 9);
    expect(scoreQuiz(MID)).toEqual(scoreQuiz({ ...MID }));
    expect(readinessScore({}).score).toBe(0);
  });

  it('gives each archetype by its rule, in order', () => {
    expect(archetypeFor(WORST, 19)).toBe('foundation');
    expect(archetypeFor({ ...BEST, goal: 'exit' }, 95)).toBe('exit_builder');
    expect(archetypeFor(BEST, 100)).toBe('consolidator');
    expect(archetypeFor({ ...MID, deals: '1' }, 70)).toBe('consolidator');
    expect(archetypeFor({ ...MID, team: 'no' }, 60)).toBe('stuck_scaler');
    expect(archetypeFor(MID, 49)).toBe('stuck_scaler');
    expect(archetypeFor(MID, 67)).toBe('first_deal');
    expect(scoreQuiz(MID).archetype).toBe('first_deal');
    expect(ARCHETYPE_ORDER.sort()).toEqual(Object.keys(ARCHETYPES).sort());
  });

  it('picks two gaps: the named blocker first, the largest shortfall next, ties in a fixed order', () => {
    // MID names funding, and the biggest shortfall after it is deals done (plan, 75% of its points missed).
    expect(topGaps(MID)).toEqual(['funding', 'plan']);
    // A perfect score still names two gaps: the blocker's, then the fixed order.
    expect(topGaps(BEST)).toEqual(['deal_flow', 'structure']);
    expect(topGaps({ ...BEST, blocker: 'credibility' })).toEqual(['credibility', 'structure']);
    const w = topGaps(WORST);
    expect(w).toHaveLength(2);
    expect(w[0]).toBe('owner'); // "time" names the owner gap, and the team answer is short too
    expect(new Set(topGaps(MID)).size).toBe(2);
  });

  it('maps the revenue band to the lead band', () => {
    expect(scoreQuiz(MID).band).toBe('3m-10m');
    expect(scoreQuiz(WORST).band).toBe('<1m');
  });
});

describe('quiz: the illustrative 1.5x teaser', () => {
  it('uses the room calculator’s own maths on their revenue and margin band', () => {
    const t = teaser(MID)!;
    expect(t.revenue).toBe(REVENUE_MID['3_10m']);
    expect(t.margin).toBe(MARGIN_MID['10_20']);
    expect(t.profit).toBe(900_000);
    expect(t.price).toBe(2_700_000);
    const m = dealMath(900_000, 2_700_000);
    expect(t.service).toBe(Math.round(m.service));
    expect(t.dscr).toBeCloseTo(m.dscr, 2);
    expect(t.clears).toBe(true);
    // At the highest price it reports, the same profit covers the debt exactly 1.5 times.
    expect(dealMath(t.profit, t.maxPrice).dscr).toBeCloseTo(1.5, 2);
    expect(teaser({ ...MID, margin: 'unsure' })!.assumedMargin).toBe(true);
    expect(teaser({})).toBeNull();
  });

  it('formats money plainly', () => {
    expect(money(2_000_000)).toBe('$2M');
    expect(money(2_700_000)).toBe('$2.7M');
    expect(money(140_750)).toBe('$141,000');
  });
});

describe('quiz: every user-facing string passes the copy rules', () => {
  const strings: { where: string; text: string }[] = [];
  for (const q of QUESTIONS) {
    strings.push({ where: `${q.id}.title`, text: q.title });
    if (q.sub) strings.push({ where: `${q.id}.sub`, text: q.sub });
    for (const o of q.options) strings.push({ where: `${q.id}.${o.value}`, text: o.label });
  }
  for (const a of Object.values(ARCHETYPES)) strings.push({ where: `${a.id}.name`, text: a.name }, { where: `${a.id}.line`, text: a.line }, { where: `${a.id}.means`, text: a.means.join('\n') });
  for (const g of Object.values(GAPS)) strings.push({ where: `${g.id}.title`, text: g.title }, { where: `${g.id}.fix`, text: g.fix });
  const walk = (o: unknown, path: string) => {
    if (typeof o === 'string') strings.push({ where: path, text: o });
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
  };
  walk(QUIZ_COPY, 'QUIZ_COPY');
  walk(RESULT_COPY, 'RESULT_COPY');
  for (const a of [MID, BEST, WORST, { ...MID, margin: 'unsure' }]) teaserLines(teaser(a)!).forEach((t, i) => strings.push({ where: `teaser.${a.revenue}.${i}`, text: t }));

  it('auditCopy passes on every string', () => {
    const bad = strings.flatMap((s) => auditCopy(s.text).map((i) => `${s.where}: ${i.rule}: ${i.excerpt}`));
    expect(bad).toEqual([]);
  });

  it('no emojis, exclamation marks, em dashes, timers, "free" calls or promised results', () => {
    for (const s of strings) {
      expect(s.text, s.where).not.toMatch(/[—!]/);
      expect(s.text, s.where).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(s.text, s.where).not.toMatch(/\bfree\b/i);
      expect(s.text, s.where).not.toMatch(/\b(only \d+ (seats|spots)|spots left|seats left|hurry|expires in|countdown|guarantee)/i);
    }
  });

  it('labels illustrative numbers and names seller rollover wherever funding is described', () => {
    for (const s of strings) if (/seller finance|commercial debt/i.test(s.text)) expect(s.text, s.where).toMatch(/seller rollover/i);
    expect(RESULT_COPY.teaserLabel).toBe('Illustrative');
    expect(RESULT_COPY.teaserNote).toMatch(/^Illustrative/);
    expect(ARCHETYPES.exit_builder.means.join(' ')).toMatch(/Illustrative ranges/);
  });

  it('uses only the true facts about Josh and the booking form', () => {
    expect(QUIZ_COPY.hostLine).toBe('Founder of JC Health Group. Josh bought his clinics in two acquisitions, and in both the sellers financed 100% of the price.');
    expect(QUIZ_COPY.proof).toMatch(/90 owners/);
    expect(QUIZ_COPY.proof).toMatch(/24 had never bought a company/);
  });

  it('the result email passes the email rules', () => {
    const m = resultEmail('Dana', ARCHETYPES.first_deal.name, ARCHETYPES.first_deal.line, 67, 'https://x.test/quiz/r/abc');
    expect(auditEmail({ subject: m.subject, preheader: m.preheader, body: m.paras })).toEqual([]);
  });

  it('renders the quiz with the consent wording the server stores, unticked, and the result with one gold action', () => {
    const html = quizScreens({ turnstile: true });
    const e = (x: string) => x.replace(/&/g, '&amp;');
    expect(html).toContain(e(CONSENT_COPY.call));
    expect(html).toContain(e(CONSENT_COPY.sms));
    expect(html).toMatch(/name="call_consent">/);
    expect(html).toMatch(/name="sms_consent">/);
    expect(html).not.toMatch(/\schecked[\s>=]/); // the two consent boxes start unticked
    expect(html.match(/data-screen="q"/g)).toHaveLength(10);
    expect(html).toContain('data-turnstile');
    const r = resultHtml({ firstName: 'Dana', score: 67, archetype: 'first_deal', gaps: ['funding', 'plan'], answers: MID, title: 'The Acquisition Masterclass', action: { target: 'webinar', under1m: false, options: [{ value: 'ws1', label: 'Tuesday 7pm', slot: 'tue_19' }] } });
    expect(r.match(/class="qz-gold"/g)).toHaveLength(1);
    expect(r).toContain('Save my seat');
    expect(r).toContain('Illustrative');
    expect(r).toContain('The <span class="qz-nw">First-Deal</span> Operator');
    expect(r).toContain(GAPS.funding.fix);
    expect(r).not.toMatch(/<script/);
    // Lead-typed text is escaped.
    expect(resultHtml({ firstName: '<img src=x>', score: 1, archetype: 'foundation', gaps: ['scale', 'plan'], answers: WORST, title: 't', action: { target: 'live', under1m: true, options: [] } })).not.toContain('<img src=x>');
  });

  it('QUIZ_TARGET defaults to the automated masterclass', () => {
    expect(quizTarget({})).toBe('webinar');
    expect(quizTarget({ QUIZ_TARGET: 'webinar' })).toBe('webinar');
    expect(quizTarget({ QUIZ_TARGET: ' Live ' })).toBe('live');
    expect(quizTarget({ QUIZ_TARGET: 'nonsense' })).toBe('webinar');
  });
});

import { describe, expect, it } from 'vitest';
import { buildDossier } from '../src/followup/dossier';
import { FOLLOWUP_GROUPS, prepTemplates } from '../src/followup/templates';
import { PRECALL_TEMPLATES, SEQUENCES, precallPlan } from '../src/integrations/sequences';
import { TEMPLATES, type TemplateCtx, renderEmail } from '../src/integrations/templates';
import type { Lead } from '../src/funnel/leads';

const full = {
  id: 'l1', first_name: 'Dana', status: 'booked', booked_at: 1, call_at: Date.now() + 3 * 86_400_000,
  answers: JSON.stringify({
    business: 'Commercial HVAC services, 25 staff', role: 'co_owner', revenue: '3_10m', profit: '250k_1m', goal: 'group',
    timeline: '0_6', blockers: ['funding', 'time'], readiness: 'partner',
    why_now: 'We have plateaued at $4M for three years and I want to build something my kids could run one day.',
  }),
  booking_answers: JSON.stringify([{ q: 'What would you like to cover', a: 'How to buy the HVAC firm across town' }]),
  objection: 'Funding doubts', lost_reason: 'Timing', industry: null, revenue_band: null,
} as unknown as Lead;
const empty = { id: 'l2', first_name: null, status: 'applied', answers: '{}', booking_answers: null, objection: null, lost_reason: null, industry: null, revenue_band: null } as unknown as Lead;

const ctx = (lead: Lead): TemplateCtx => ({
  lead, name: lead.first_name || 'there', siteName: 'G&L', link: (p) => `https://x.test${p}`,
  bookingUrl: 'https://calendly.com/x', whatsappUrl: null, callTime: 'Thu 15 Oct, 10:00am', joinUrl: null, rescheduleUrl: null,
});

describe('application-specific follow-up', () => {
  it('reads the application and booking answers', () => {
    const d = buildDossier(full);
    expect(d.industry?.id).toBe('hvac');
    expect(d.blockers).toEqual(['funding', 'time']);
    expect(d.deal?.targetProfit).toBe('$250k–$800k');
    expect(d.booking[0].a).toContain('HVAC firm');
    expect(d.whyNow).toContain('plateaued');
  });

  it('picks prep emails that fit the lead, and weaves them through the barrage first', () => {
    const prep = prepTemplates(buildDossier(full));
    expect(prep).toEqual(expect.arrayContaining(['pp_brief', 'pp_blocker1', 'pp_blocker2', 'pp_booking', 'pp_numbers', 'pp_goal', 'pp_industry', 'pp_why_now', 'pp_partner', 'pp_timeline', 'pp_homework']));
    expect(prepTemplates(buildDossier(empty))).toEqual(['pp_homework']);
    const plan = precallPlan(full);
    expect(plan.slice(0, 4)).toEqual(['pp_brief', 'pp_blocker1', 'pp_booking', 'pp_numbers']);
    expect(plan).toContain(PRECALL_TEMPLATES[0]);
    expect(plan).not.toContain('pc_partner'); // their own partner email replaces the general one
    expect(precallPlan(full, 12).filter((t) => t.startsWith('pp_')).length).toBeGreaterThanOrEqual(5);
    expect(new Set(plan).size).toBe(plan.length);
    expect(plan.length).toBeLessThanOrEqual(SEQUENCES.precall.steps.length);
  });

  it('every new email renders for a full and an empty application, without leaking blanks', () => {
    const all = Object.values(FOLLOWUP_GROUPS).flat();
    expect(all.length).toBeGreaterThanOrEqual(45);
    for (const t of all) {
      for (const lead of [full, empty]) {
        if (lead === empty && t.startsWith('pp_') && !prepTemplates(buildDossier(empty)).includes(t)) continue; // never scheduled
        const c = TEMPLATES[t](ctx(lead));
        const { html, text } = renderEmail(c, { openPixel: null, unsubscribeUrl: 'u', signature: 'Josh', address: 'a' });
        expect(text, t).not.toMatch(/undefined|null|NaN|\[object/);
        expect(html.toLowerCase(), t).not.toMatch(/free (strategy )?call|free consult/);
        expect(c.subject.length, t).toBeLessThan(80);
      }
    }
  });

  it('answers the objection logged on the call', () => {
    expect(TEMPLATES.fu_objection(ctx(full)).subject).toBe('will a lender really fund it?');
    expect(TEMPLATES.lo_3(ctx(full)).body.join(' ')).toContain('timing wasn’t right');
  });

  it('every sequence step has a template', () => {
    for (const s of Object.values(SEQUENCES)) for (const st of s.steps) expect(TEMPLATES[st.template], `${s.id}:${st.template}`).toBeTypeOf('function');
  });
});

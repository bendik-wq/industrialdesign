import { describe, expect, it } from 'vitest';
import { RULES, type Signals } from '../src/personalize/triggers';
import { BEHAVIOUR_TEMPLATES } from '../src/integrations/sequences';
import { TEMPLATES } from '../src/integrations/templates';
import type { Lead } from '../src/funnel/leads';

const now = Date.parse('2026-10-12T12:00:00Z');
const lead = (o: Partial<Lead> = {}) => ({ status: 'applied', tier: 'A', tier_override: null, app_started_at: now - 7200_000, app_completed_at: now - 3600_000, booked_at: null, booking_cancelled_at: null, step_reached: 10, call_at: null, updated_at: now, ...o }) as unknown as Lead;
const sig = (o: Partial<Signals> = {}): Signals => ({ lead: lead(), sessions: 1, sessionsAfterApply: 0, mainVslPct: 0, breakoutPct: 0, precallViews: 0, pickedDate: false, bookViews24h: 0, emailClicks24h: 0, guaranteeSeconds: 0, guaranteeRevisit: false, fundingInterest: false, lastActivity: now, ...o });
const fires = (s: Signals) => RULES.filter((r) => r.when(s, now)).map((r) => r.template);

describe('behaviour-triggered emails', () => {
  it('every rule has a template and a step, in the same order', () => {
    expect(RULES.map((r) => r.template)).toEqual(BEHAVIOUR_TEMPLATES.map((t) => t.template));
    for (const r of RULES) expect(TEMPLATES[r.template]).toBeTypeOf('function');
  });
  it('picked a day but didn’t book → finish-booking email', () => {
    expect(fires(sig({ pickedDate: true }))).toContain('t_finish_booking');
    expect(fires(sig({ pickedDate: true, lead: lead({ booked_at: now - 1000 }) }))).not.toContain('t_finish_booking');
  });
  it('watched most of the video without finishing the application', () => {
    expect(fires(sig({ mainVslPct: 0.6, lead: lead({ app_completed_at: null, step_reached: 1 }) }))).toContain('t_vsl_no_apply');
    expect(fires(sig({ mainVslPct: 0.6 }))).not.toContain('t_vsl_no_apply');
  });
  it('stalled on the application only after 30 quiet minutes', () => {
    const l = lead({ app_completed_at: null, step_reached: 4 });
    expect(fires(sig({ lead: l, lastActivity: now - 5 * 60_000 }))).not.toContain('t_stalled');
    expect(fires(sig({ lead: l, lastActivity: now - 40 * 60_000 }))).toContain('t_stalled');
  });
  it('funding interest, guarantee reading and return visits', () => {
    expect(fires(sig({ fundingInterest: true }))).toContain('t_funding');
    expect(fires(sig({ guaranteeSeconds: 12 }))).toContain('t_guarantee');
    expect(fires(sig({ sessionsAfterApply: 1 }))).toContain('t_came_back');
    expect(fires(sig({ sessions: 3 }))).toContain('t_still_thinking');
  });
  it('booked people only get the prep nudge, and only when they haven’t watched it', () => {
    const b = lead({ status: 'booked', booked_at: now - 13 * 3600_000, call_at: now + 30 * 3600_000 });
    expect(fires(sig({ lead: b, fundingInterest: true, pickedDate: true }))).toEqual(['t_watch_prep']);
    expect(fires(sig({ lead: b, precallViews: 1 }))).toEqual([]);
  });
});

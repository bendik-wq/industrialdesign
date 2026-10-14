import type { Lead } from '../funnel/leads';
import { buildDossier } from '../followup/dossier';
import { FOLLOWUP_GROUPS, prepTemplates } from '../followup/templates';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface SequenceStep {
  template: string;
  /** Delay from when the sequence starts, or offset from the call time when anchor = 'call_at'. */
  offsetMs: number;
  anchor?: 'start' | 'call_at' | 'webinar_at';
  /** Re-checked with fresh lead data right before sending. */
  skipIf?: (lead: Lead) => boolean;
}

export interface Sequence {
  id: string;
  description: string;
  steps: SequenceStep[];
  /** Stops the whole sequence (remaining steps are skipped) once true. */
  stopIf?: (lead: Lead) => boolean;
  /** Steps repeat in blocks of this size (one block per event, e.g. per webinar registration). */
  cycle?: number;
}

const isBooked = (l: Lead) => Boolean(l.booked_at) && !l.booking_cancelled_at;

/** Behaviour-triggered emails, in step order (the step index is part of the dedupe key, so only append). */
export const BEHAVIOUR_TEMPLATES: { template: string; skipIf: (l: Lead) => boolean }[] = [
  { template: 't_vsl_no_apply', skipIf: (l) => Boolean(l.app_completed_at) },
  { template: 't_stalled', skipIf: (l) => Boolean(l.app_completed_at) },
  { template: 't_finish_booking', skipIf: isBooked },
  { template: 't_came_back', skipIf: isBooked },
  { template: 't_still_thinking', skipIf: isBooked },
  { template: 't_guarantee', skipIf: isBooked },
  { template: 't_funding', skipIf: isBooked },
  { template: 't_book_nudge', skipIf: isBooked },
  { template: 't_breakout_done', skipIf: isBooked },
  { template: 't_watch_prep', skipIf: (l) => !isBooked(l) || l.status !== 'booked' },
];

/** Reactivation run: [template, day, slot]. 22 emails: 5 a day for 4 days, then day 5 and day 7. */
export const REACTIVATION_SLOTS = [0, 2.5, 5, 8, 11];
export const REACTIVATION_PLAN: [string, number, number][] = [
  ['re_1', 0, 0], ['re_2', 0, 1], ['re_702010', 0, 2], ['re_rollover', 0, 3], ['re_assets', 0, 4],
  ['re_6040', 1, 0], ['re_no_pg', 1, 1], ['re_100vf', 1, 2], ['re_others', 1, 3], ['re_which', 1, 4],
  ['re_3', 2, 0], ['re_dscr_test', 2, 1], ['re_competitors', 2, 2], ['re_90days', 2, 3], ['re_5', 2, 4],
  ['re_4', 3, 0], ['re_time', 3, 1], ['re_myths', 3, 2], ['re_cost_wait', 3, 3], ['re_one_call', 3, 4],
  ['re_reply', 5, 2], ['re_6', 7, 2],
];

/** Pre-call emails (one idea each). Append only: new emails go at the end. */
export const PRECALL_TEMPLATES = [
  'pc_ceiling', 'pc_own_cash', 'pc_bank', 'pc_no_time', 'pc_partner', 'pc_seller',
  'pc_josh', 'pc_brokers', 'pc_dscr', 'pc_consolidate', 'pc_guarantee', 'pc_agenda',
  'pc_multiple', 'pc_in_not_on', 'pc_cash_trap', 'pc_fell_over', 'pc_done_with', 'pc_questions',
  'pc_lemon', 'pc_hiring', 'pc_two_paths', 'pc_next_year', 'pc_if_you_could', 'pc_cost',
  'pc_walkthrough', 'pc_90_days', 'pc_target', 'pc_myths', 'pc_not_for', 'pc_before_call',
  'pc_6040', 'pc_702010', 'pc_100vf', 'pc_which_structure', 'pc_no_pg', 'pc_rollover', 'pc_others', 'pc_assets',
  'pc_dscr_maths', 'pc_seller_questions', 'pc_first_week', 'pc_red_flags',
];

/**
 * The pre-call story, in stages: 1 your plan (from their application) → 2 how it works (mechanism and
 * proof) → 3 the opportunity → 4 the doubts → 5 show up ready. Priority 1 = always sent, 2 = sent when
 * there's room, 3 = only on longer runs. A call booked for tomorrow still gets the whole arc, just shorter.
 */
export const PRECALL_ARC: Record<string, { stage: 1 | 2 | 3 | 4 | 5; priority: 1 | 2 | 3 }> = {
  pp_brief: { stage: 1, priority: 1 }, pp_blocker1: { stage: 1, priority: 1 }, pp_booking: { stage: 1, priority: 1 }, pp_numbers: { stage: 1, priority: 1 },
  pc_josh: { stage: 2, priority: 1 }, pc_seller: { stage: 2, priority: 1 }, pc_walkthrough: { stage: 2, priority: 1 },
  pc_own_cash: { stage: 2, priority: 2 }, pc_bank: { stage: 2, priority: 2 }, pc_dscr: { stage: 2, priority: 2 }, pc_done_with: { stage: 2, priority: 3 },
  pp_goal: { stage: 3, priority: 2 }, pp_industry: { stage: 3, priority: 2 }, pp_why_now: { stage: 3, priority: 2 }, pp_timeline: { stage: 3, priority: 2 },
  pc_target: { stage: 3, priority: 2 }, pc_90_days: { stage: 3, priority: 2 }, pc_ceiling: { stage: 3, priority: 2 },
  pc_brokers: { stage: 3, priority: 3 }, pc_consolidate: { stage: 3, priority: 3 }, pc_multiple: { stage: 3, priority: 3 }, pc_cash_trap: { stage: 3, priority: 3 }, pc_hiring: { stage: 3, priority: 3 },
  pc_guarantee: { stage: 4, priority: 1 }, pc_myths: { stage: 4, priority: 2 }, pc_no_time: { stage: 4, priority: 2 }, pp_blocker2: { stage: 4, priority: 2 },
  pc_not_for: { stage: 4, priority: 3 }, pc_fell_over: { stage: 4, priority: 3 }, pc_lemon: { stage: 4, priority: 3 }, pc_in_not_on: { stage: 4, priority: 3 },
  pc_two_paths: { stage: 4, priority: 3 }, pc_next_year: { stage: 4, priority: 3 }, pc_if_you_could: { stage: 4, priority: 3 }, pc_cost: { stage: 4, priority: 3 },
  pc_agenda: { stage: 5, priority: 1 }, pc_questions: { stage: 5, priority: 1 }, pp_homework: { stage: 5, priority: 1 }, pp_partner: { stage: 5, priority: 2 },
  pc_partner: { stage: 5, priority: 3 }, pc_before_call: { stage: 5, priority: 1 },
  // Deal structures and sales assets.
  pc_assets: { stage: 1, priority: 1 }, pc_702010: { stage: 2, priority: 1 }, pc_100vf: { stage: 2, priority: 1 }, pc_6040: { stage: 2, priority: 1 },
  pc_which_structure: { stage: 2, priority: 2 }, pc_rollover: { stage: 2, priority: 2 }, pc_others: { stage: 2, priority: 2 }, pc_dscr_maths: { stage: 2, priority: 2 },
  pc_no_pg: { stage: 4, priority: 1 }, pc_red_flags: { stage: 4, priority: 3 }, pc_first_week: { stage: 4, priority: 2 }, pc_seller_questions: { stage: 3, priority: 3 },
};
export const PRECALL_STAGES = ['', 'Your plan', 'How it works', 'The opportunity', 'The doubts', 'Show up ready'] as const;
const arcOf = (t: string) => PRECALL_ARC[t] ?? { stage: 4, priority: 3 };

/**
 * The pre-call run for one lead, in send order: the application-specific emails (their business, blockers,
 * numbers, industry, booking answers) plus the general ones, following the arc. With a limit, the most
 * important are kept (priority, then arc order) and still sent in arc order; the checklist is always last.
 */
export function precallPlan(lead: Lead, limit = Infinity): string[] {
  const prep = prepTemplates(buildDossier(lead));
  // The general "bring your partner" email is redundant when their own partner email is in.
  const general = PRECALL_TEMPLATES.filter((t) => !(t === 'pc_partner' && prep.includes('pp_partner')));
  const all = [...prep, ...general].map((t, i) => ({ t, i, ...arcOf(t) }));
  const keep = [...all].sort((a, b) => a.priority - b.priority || a.stage - b.stage || a.i - b.i).slice(0, Math.max(0, limit));
  return keep.sort((a, b) => a.stage - b.stage || (a.t === 'pc_before_call' ? 1 : b.t === 'pc_before_call' ? -1 : 0) || a.i - b.i).map((x) => x.t);
}


const booked = (l: Lead) => Boolean(l.booked_at) && !l.booking_cancelled_at;
/** In the room for the session they're booked into (not an earlier one). */
const cameToWebinar = (l: Lead) => Boolean(l.webinar_attended_at && l.webinar_at && l.webinar_attended_at >= l.webinar_at - 30 * MIN);
/** Already applied or booked: the webinar follow-up has done its job. */
const pitched = (l: Lead) => Boolean(l.app_completed_at) || (Boolean(l.booked_at) && !l.booking_cancelled_at);
/** Imported straight from Calendly: never in the funnel, never on its emails. */
const direct = (l: Lead) => l.booking_source === 'calendly-direct';
const completed = (l: Lead) => Boolean(l.app_completed_at);

export const SEQUENCES = {
  abandoned: {
    id: 'abandoned',
    description: 'Started the application but did not finish',
    stopIf: completed,
    steps: [
      { template: 'abandon_1', offsetMs: 15 * MIN },
      { template: 'abandon_2', offsetMs: 3 * HOUR },
      { template: 'abandon_3', offsetMs: 1 * DAY },
      { template: 'abandon_4', offsetMs: 2 * DAY },
      { template: 'abandon_5', offsetMs: 4 * DAY },
    ],
  },
  tier_a: {
    id: 'tier_a',
    description: 'Qualified (A) — get the call booked',
    stopIf: booked,
    steps: [
      { template: 'a_approved', offsetMs: 2 * MIN },
      { template: 'a_reminder', offsetMs: 1 * HOUR },
      { template: 'a_slots', offsetMs: 4 * HOUR },
      { template: 'a_morning', offsetMs: 20 * HOUR },
      { template: 'a_last_call', offsetMs: 2 * DAY },
      { template: 'a_case', offsetMs: 3 * DAY },
      { template: 'a_objection', offsetMs: 5 * DAY },
      { template: 'a_final', offsetMs: 7 * DAY },
    ],
  },
  tier_b: {
    id: 'tier_b',
    description: 'Mid-fit (B) — breakout VSL, objections, then book',
    stopIf: booked,
    steps: [
      { template: 'b_part2', offsetMs: 2 * MIN },
      { template: 'b_two_paths', offsetMs: 3 * HOUR },
      { template: 'b_objections', offsetMs: 1 * DAY },
      { template: 'b_dscr', offsetMs: 2 * DAY },
      { template: 'b_guarantee', offsetMs: 3 * DAY },
      { template: 'b_book', offsetMs: 5 * DAY },
      { template: 'b_last', offsetMs: 7 * DAY },
      { template: 'b_final', offsetMs: 10 * DAY },
    ],
  },
  tier_c: {
    id: 'tier_c',
    description: 'Not ready yet (C) — resources and education by email',
    stopIf: (l) => Boolean(l.booked_at),
    steps: [
      { template: 'c_resources', offsetMs: 1 * MIN },
      { template: 'c_third_way', offsetMs: 2 * DAY },
      { template: 'c_seller_finance', offsetMs: 5 * DAY },
      { template: 'c_dscr', offsetMs: 9 * DAY },
      { template: 'c_ready', offsetMs: 14 * DAY },
      { template: 'c_reapply', offsetMs: 21 * DAY },
    ],
  },
  booked: {
    id: 'booked',
    description: 'Call booked — confirmation and show-up reminders',
    stopIf: (l) => direct(l) || !booked(l) || ['showed', 'won', 'lost', 'no_show'].includes(l.status),
    steps: [
      { template: 'booked_confirm', offsetMs: 0 },
      { template: 'call_48h', offsetMs: -48 * HOUR, anchor: 'call_at' },
      { template: 'call_24h', offsetMs: -24 * HOUR, anchor: 'call_at' },
      { template: 'call_3h', offsetMs: -3 * HOUR, anchor: 'call_at' },
      { template: 'call_1h', offsetMs: -1 * HOUR, anchor: 'call_at' },
      { template: 'call_10m', offsetMs: -10 * MIN, anchor: 'call_at' },
    ],
  },
  behaviour: {
    id: 'behaviour',
    description: 'One-off emails triggered by what the person did on the page (see personalize/triggers.ts)',
    stopIf: (l) => ['won', 'lost', 'disqualified'].includes(l.status) || l.booking_source === 'calendly-direct',
    // Sent when a trigger fires; offsetMs unused. Each step is re-checked right before sending.
    steps: BEHAVIOUR_TEMPLATES.map((t) => ({ template: t.template, offsetMs: 0, skipIf: t.skipIf })),
  },
  precall: {
    id: 'precall',
    description: 'Booked — pre-call barrage, up to 6 a day until the call: emails written from their application and booking answers, woven through one-pain-point emails',
    stopIf: (l) => direct(l) || !booked(l) || l.status !== 'booked' || Boolean(l.call_at && Date.now() > l.call_at - 2 * HOUR),
    // Sent at local-time slots by enqueuePrecall() in the order precallPlan() gives (the row holds the template); offsetMs is unused.
    steps: [...FOLLOWUP_GROUPS.prep, ...PRECALL_TEMPLATES].map((template) => ({ template, offsetMs: 0 })),
  },
  reactivation: {
    id: 'reactivation',
    description: 'Reactivation — people already in the database (past calls with no outcome, no-shows, unfinished applications…), launched by hand from Funnel HQ',
    // Done once they book or apply again, buy, or are ruled out.
    stopIf: (l) => ['won', 'disqualified'].includes(l.status) || Boolean(l.reactivated_at && (((l.booked_at ?? 0) > l.reactivated_at && !l.booking_cancelled_at) || (l.app_completed_at ?? 0) > l.reactivated_at)),
    // 5 a day for 4 days (8:00, 10:30, 13:00, 16:00, 19:00 from an 8am start), then day 5 and a last one on day 7.
    steps: REACTIVATION_PLAN.map(([template, day, slot]) => ({ template, offsetMs: day * DAY + REACTIVATION_SLOTS[slot] * HOUR })),
  },
  webinar: {
    id: 'webinar',
    description: 'Registered for the webinar — confirmation, reminders, then follow-up based on whether they came',
    cycle: 12,
    stopIf: (l) => ['won', 'lost', 'disqualified'].includes(l.status),
    steps: [
      { template: 'w_confirm', offsetMs: 0 },
      { template: 'w_24h', offsetMs: -24 * HOUR, anchor: 'webinar_at' },
      { template: 'w_3h', offsetMs: -3 * HOUR, anchor: 'webinar_at' },
      { template: 'w_15m', offsetMs: -15 * MIN, anchor: 'webinar_at' },
      { template: 'w_live', offsetMs: 3 * MIN, anchor: 'webinar_at', skipIf: (l) => cameToWebinar(l) },
      { template: 'w_thanks', offsetMs: 80 * MIN, anchor: 'webinar_at', skipIf: (l) => !cameToWebinar(l) || pitched(l) },
      { template: 'w_missed', offsetMs: 80 * MIN, anchor: 'webinar_at', skipIf: (l) => cameToWebinar(l) },
      { template: 'w_replay_last', offsetMs: 40 * HOUR, anchor: 'webinar_at', skipIf: (l) => pitched(l) || (l.webinar_watch_pct ?? 0) >= 0.8 },
      { template: 'w_offer', offsetMs: 3 * DAY, anchor: 'webinar_at', skipIf: pitched },
      { template: 'w_story', offsetMs: 5 * DAY, anchor: 'webinar_at', skipIf: pitched },
      { template: 'w_last', offsetMs: 8 * DAY, anchor: 'webinar_at', skipIf: pitched },
    ],
  },
  no_show: {
    id: 'no_show',
    description: 'Missed the call — get them rebooked (their goal, blocker and numbers from the application)',
    stopIf: (l) => l.status !== 'no_show',
    steps: [
      { template: 'noshow_1', offsetMs: 15 * MIN },
      { template: 'noshow_2', offsetMs: 1 * DAY },
      { template: 'noshow_3', offsetMs: 3 * DAY },
      // Appended (step index is the dedupe key).
      { template: 'ns_goal', offsetMs: 5 * DAY },
      { template: 'ns_blocker', offsetMs: 7 * DAY },
      { template: 'ns_numbers', offsetMs: 10 * DAY },
      { template: 'ns_final', offsetMs: 14 * DAY },
    ],
  },
  post_call: {
    id: 'post_call',
    description: 'Showed up, no decision yet — follow up',
    stopIf: (l) => l.status !== 'showed',
    steps: [
      { template: 'post_1', offsetMs: 2 * HOUR },
      { template: 'post_2', offsetMs: 2 * DAY },
      { template: 'post_3', offsetMs: 5 * DAY },
      // Appended (step index is the dedupe key). fu_objection answers the objection logged on the call.
      { template: 'fu_objection', offsetMs: 1 * DAY },
      { template: 'fu_recap', offsetMs: 3 * DAY },
      { template: 'fu_numbers', offsetMs: 7 * DAY },
      { template: 'fu_industry', offsetMs: 9 * DAY },
      { template: 'fu_goal', offsetMs: 12 * DAY },
      { template: 'fu_final', offsetMs: 21 * DAY },
    ],
  },
  cancelled: {
    id: 'cancelled',
    description: 'Cancelled their call — get them rebooked',
    stopIf: (l) => direct(l) || booked(l) || ['won', 'lost', 'disqualified'].includes(l.status),
    steps: [
      { template: 'cx_1', offsetMs: 30 * MIN },
      { template: 'cx_2', offsetMs: 1 * DAY },
      { template: 'cx_3', offsetMs: 3 * DAY },
      { template: 'cx_4', offsetMs: 6 * DAY },
    ],
  },
  lost: {
    id: 'lost',
    description: 'Lost — long-term re-engagement, angled on why they said no',
    stopIf: (l) => l.status !== 'lost' || booked(l),
    steps: [
      { template: 'lo_1', offsetMs: 3 * DAY },
      { template: 'lo_2', offsetMs: 21 * DAY },
      { template: 'lo_3', offsetMs: 45 * DAY },
      { template: 'lo_4', offsetMs: 75 * DAY },
      { template: 'lo_5', offsetMs: 120 * DAY },
      { template: 'lo_6', offsetMs: 180 * DAY },
    ],
  },
  won: {
    id: 'won',
    description: 'Closed — onboarding for the first 30 days',
    stopIf: (l) => l.status !== 'won' || Boolean(l.refunded_at),
    steps: [
      { template: 'won_1', offsetMs: 10 * MIN },
      { template: 'won_2', offsetMs: 1 * DAY },
      { template: 'won_3', offsetMs: 3 * DAY },
      { template: 'won_4', offsetMs: 7 * DAY },
      { template: 'won_5', offsetMs: 14 * DAY },
      { template: 'won_6', offsetMs: 30 * DAY },
    ],
  },
  nurture: {
    id: 'nurture',
    description: 'Applied, never booked — six months of long-tail follow-up from their application',
    stopIf: (l) => booked(l) || !['applied', 'partial', 'nurture'].includes(l.status),
    steps: [
      { template: 'nu_industry', offsetMs: 25 * DAY },
      { template: 'nu_blocker', offsetMs: 35 * DAY },
      { template: 'nu_numbers', offsetMs: 50 * DAY },
      { template: 'nu_seller', offsetMs: 65 * DAY },
      { template: 'nu_goal', offsetMs: 80 * DAY },
      { template: 'nu_why', offsetMs: 100 * DAY },
      { template: 'nu_dscr', offsetMs: 120 * DAY },
      { template: 'nu_checkin', offsetMs: 150 * DAY },
      { template: 'nu_last', offsetMs: 180 * DAY },
    ],
  },
} satisfies Record<string, Sequence>;

export type SequenceId = keyof typeof SEQUENCES;

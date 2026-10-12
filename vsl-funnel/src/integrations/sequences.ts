import type { Lead } from '../funnel/leads';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface SequenceStep {
  template: string;
  /** Delay from when the sequence starts, or offset from the call time when anchor = 'call_at'. */
  offsetMs: number;
  anchor?: 'start' | 'call_at';
  /** Re-checked with fresh lead data right before sending. */
  skipIf?: (lead: Lead) => boolean;
}

export interface Sequence {
  id: string;
  description: string;
  steps: SequenceStep[];
  /** Stops the whole sequence (remaining steps are skipped) once true. */
  stopIf?: (lead: Lead) => boolean;
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

/** Pre-call barrage, in send order. The first day hits the biggest pains and the call prep. */
export const PRECALL_TEMPLATES = [
  'pc_ceiling', 'pc_own_cash', 'pc_bank', 'pc_no_time', 'pc_partner', 'pc_seller',
  'pc_josh', 'pc_brokers', 'pc_dscr', 'pc_consolidate', 'pc_guarantee', 'pc_agenda',
  'pc_multiple', 'pc_in_not_on', 'pc_cash_trap', 'pc_fell_over', 'pc_done_with', 'pc_questions',
  'pc_lemon', 'pc_hiring', 'pc_two_paths', 'pc_next_year', 'pc_if_you_could', 'pc_cost',
];

/** Local send times (hours) for the barrage; fewer per day picks evenly from these. */
export const PRECALL_SLOTS = [7.5, 9.5, 12, 14.5, 17, 19.5];

const booked = (l: Lead) => Boolean(l.booked_at) && !l.booking_cancelled_at;
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
    stopIf: (l) => !booked(l) || ['showed', 'won', 'lost', 'no_show'].includes(l.status),
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
    description: 'Booked — pre-call barrage, up to 6 a day until the call (one pain point each)',
    stopIf: (l) => !booked(l) || l.status !== 'booked' || Boolean(l.call_at && Date.now() > l.call_at - 2 * HOUR),
    // Sent at local-time slots by enqueuePrecall(); offsetMs is unused for this sequence.
    steps: PRECALL_TEMPLATES.map((template) => ({ template, offsetMs: 0 })),
  },
  no_show: {
    id: 'no_show',
    description: 'Missed the call — get them rebooked',
    stopIf: (l) => l.status !== 'no_show',
    steps: [
      { template: 'noshow_1', offsetMs: 15 * MIN },
      { template: 'noshow_2', offsetMs: 1 * DAY },
      { template: 'noshow_3', offsetMs: 3 * DAY },
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
    ],
  },
} satisfies Record<string, Sequence>;

export type SequenceId = keyof typeof SEQUENCES;

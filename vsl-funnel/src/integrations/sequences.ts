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

const booked = (l: Lead) => Boolean(l.booked_at) && !l.booking_cancelled_at;
const completed = (l: Lead) => Boolean(l.app_completed_at);

export const SEQUENCES = {
  abandoned: {
    id: 'abandoned',
    description: 'Started the application but did not finish',
    stopIf: completed,
    steps: [
      { template: 'abandon_1', offsetMs: 45 * MIN },
      { template: 'abandon_2', offsetMs: 1 * DAY },
      { template: 'abandon_3', offsetMs: 3 * DAY },
    ],
  },
  tier_a: {
    id: 'tier_a',
    description: 'Qualified (A) — get the call booked',
    stopIf: booked,
    steps: [
      { template: 'a_approved', offsetMs: 2 * MIN },
      { template: 'a_reminder', offsetMs: 3 * HOUR },
      { template: 'a_last_call', offsetMs: 1 * DAY },
      { template: 'a_final', offsetMs: 3 * DAY },
    ],
  },
  tier_b: {
    id: 'tier_b',
    description: 'Mid-fit (B) — breakout VSL, FAQs, then book',
    stopIf: booked,
    steps: [
      { template: 'b_part2', offsetMs: 2 * MIN },
      { template: 'b_two_paths', offsetMs: 1 * DAY },
      { template: 'b_objections', offsetMs: 3 * DAY },
      { template: 'b_book', offsetMs: 5 * DAY },
    ],
  },
  tier_c: {
    id: 'tier_c',
    description: 'Not ready yet (C) — resources by email (no WhatsApp)',
    steps: [
      { template: 'c_resources', offsetMs: 1 * MIN },
      { template: 'c_third_way', offsetMs: 5 * DAY },
    ],
  },
  booked: {
    id: 'booked',
    description: 'Call booked — confirmation and show-up reminders',
    stopIf: (l) => !booked(l),
    steps: [
      { template: 'booked_confirm', offsetMs: 0 },
      { template: 'call_24h', offsetMs: -24 * HOUR, anchor: 'call_at' },
      { template: 'call_1h', offsetMs: -1 * HOUR, anchor: 'call_at' },
    ],
  },
} satisfies Record<string, Sequence>;

export type SequenceId = keyof typeof SEQUENCES;

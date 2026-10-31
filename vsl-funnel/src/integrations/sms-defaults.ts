/**
 * Default SMS sequences (editable in Funnel HQ → SMS). One sequence per trigger. Each step has a stable
 * numeric `n` (never reused) because (lead, sequence, n) is the dedupe key for sent texts.
 *
 * Merge tags: {first_name} {call_time} {closer} {link} {webinar_time} {site_name}
 * Timing: `anchor` + `offsetMin` (minutes; negative = before). Anchors: trigger (when it happened),
 * call (the booked call\'s start), webinar (their webinar session\'s start).
 */

export const SMS_TRIGGERS = {
  booked: 'Call booked',
  no_show: 'Missed the call (no-show)',
  abandoned: 'Started the application, didn\'t finish',
  qualified: 'Qualified (A/B), not booked yet',
  cancelled: 'Cancelled their call',
  showed: 'Call held, no decision yet',
  lost: 'Marked lost',
  won: 'Closed (won)',
  webinar: 'Registered for the webinar',
  challenge: 'Paid for the First Deal Challenge',
} as const;
export type SmsTrigger = keyof typeof SMS_TRIGGERS;

/** day1..day5: the start of that day of the lead's First Deal Challenge cohort (challenge trigger only). */
export const SMS_ANCHORS = ['trigger', 'call', 'webinar', 'day1', 'day2', 'day3', 'day4', 'day5'] as const;
export const SMS_LINKS = ['none', 'join', 'reschedule', 'book', 'apply', 'breakout', 'webinar_room', 'webinar_replay', 'challenge_today'] as const;
export const SMS_SKIPS = ['applied', 'booked', 'confirmed', 'attended', 'missed', 'clicked'] as const;
/** sms = text only; whatsapp = WhatsApp when we can reach them there, otherwise the same message by SMS. */
export const SMS_CHANNELS = ['sms', 'whatsapp'] as const;

export interface SmsStepDef {
  n: number;
  body: string;
  anchor: (typeof SMS_ANCHORS)[number];
  offsetMin: number;
  link: (typeof SMS_LINKS)[number];
  /** Skip this text if any of these is true for the lead when it\'s due. */
  skip: (typeof SMS_SKIPS)[number][];
  /** Approved WhatsApp template name for this text (needed outside the 24-hour reply window). */
  wa?: string;
}
export interface SmsSequenceDef {
  id: SmsTrigger;
  enabled: boolean;
  channel?: (typeof SMS_CHANNELS)[number];
  steps: SmsStepDef[];
  next: number; // next step number to hand out
}

const H = 60, D = 24 * 60;
const s = (n: number, anchor: SmsStepDef['anchor'], offsetMin: number, link: SmsStepDef['link'], body: string, skip: SmsStepDef['skip'] = []): SmsStepDef => ({ n, anchor, offsetMin, link, body, skip });

export const DEFAULT_SMS_SEQUENCES: SmsSequenceDef[] = [
  {
    id: 'booked', enabled: true, next: 7,
    steps: [
      s(1, 'trigger', 0, 'join', 'Hi {first_name}, it\'s Josh\'s team at G&L. You\'re booked for your strategy call on {call_time} with {closer}. Save this link to join: {link}\nReply C to confirm.'),
      s(2, 'trigger', 90, 'breakout', '{first_name}, before the call it\'s worth watching this short video. It makes the 30 minutes twice as useful: {link}', ['confirmed']),
      s(3, 'call', -24 * H, 'reschedule', 'Hi {first_name}, quick reminder: your strategy call is tomorrow, {call_time}. Reply C to confirm, or if the time no longer works, pick a new one here: {link}'),
      s(4, 'call', -3 * H, 'join', '{first_name}, your call with {closer} is in 3 hours. Have last year\'s profit roughly in mind and, if there\'s a business partner, bring them. Link: {link}'),
      s(5, 'call', -60, 'join', 'Starting in an hour, {first_name}. Here\'s your link: {link}'),
      s(6, 'call', -10, 'join', '{first_name}, we\'re on in 10 minutes: {link}'),
    ],
  },
  {
    id: 'no_show', enabled: true, next: 6,
    steps: [
      s(1, 'trigger', 5, 'book', 'Hi {first_name}, it\'s Josh\'s team. We missed you on the call just now. No stress, things come up. Grab a new time here: {link}'),
      s(2, 'trigger', 2 * H, 'book', '{first_name}, still want to map out your first acquisition? A new time takes 10 seconds: {link}', ['booked']),
      s(3, 'trigger', 1 * D, 'book', 'Morning {first_name}. Your spot\'s still open if you want it. Pick a time that actually suits: {link}', ['booked']),
      s(4, 'trigger', 3 * D, 'book', '{first_name}, is buying a business still on the cards this year? Reply yes or no, either is fine.', ['booked']),
      s(5, 'trigger', 7 * D, 'book', 'Last nudge from me, {first_name}. If the timing\'s better now, here\'s the link: {link}', ['booked']),
    ],
  },
  {
    id: 'abandoned', enabled: true, next: 4,
    steps: [
      s(1, 'trigger', 15, 'apply', 'Hi {first_name}, it\'s Josh\'s team at G&L. Your application saved where you left off. It\'s about 2 minutes to finish: {link}', ['applied']),
      s(2, 'trigger', 1 * D, 'apply', '{first_name}, was there a question on the application you weren\'t sure about? Reply here and we\'ll help. Or finish it: {link}', ['applied']),
      s(3, 'trigger', 3 * D, 'apply', 'Last reminder, {first_name}: your answers are still saved. If acquisitions are on your radar, finish here: {link}', ['applied']),
    ],
  },
  {
    id: 'qualified', enabled: true, next: 5,
    steps: [
      s(1, 'trigger', 30, 'book', 'Hi {first_name}, it\'s Josh\'s team. Good news: your application qualifies for a strategy call. Pick a time that suits: {link}', ['booked']),
      s(2, 'trigger', 1 * D, 'book', '{first_name}, there are a few call times left this week. Want one? {link}', ['booked']),
      s(3, 'trigger', 3 * D, 'book', '{first_name}, most owners book once they see a deal can be over-financed. 30 minutes to see if yours can: {link}', ['booked']),
      s(4, 'trigger', 6 * D, 'book', 'Should we hold your approval, {first_name}? Reply yes and we\'ll send times, or book here: {link}', ['booked']),
    ],
  },
  {
    id: 'cancelled', enabled: true, next: 4,
    steps: [
      s(1, 'trigger', 15, 'book', 'No problem at all, {first_name}. When you\'re ready, pick a new time here and we\'ll pick up right where we were: {link}', ['booked']),
      s(2, 'trigger', 1 * D, 'book', '{first_name}, want to find another time this week? {link}', ['booked']),
      s(3, 'trigger', 4 * D, 'book', 'Still keen to map out your first deal, {first_name}? Here\'s the link when you are: {link}', ['booked']),
    ],
  },
  {
    id: 'showed', enabled: true, next: 5,
    steps: [
      s(1, 'trigger', 3 * H, 'none', 'Thanks for your time today, {first_name}. Any questions after the call? Just reply here, it comes straight to the team.'),
      s(2, 'trigger', 2 * D, 'none', '{first_name}, what\'s the one thing that would make this an easy yes? Reply and I\'ll answer it straight.'),
      s(3, 'trigger', 5 * D, 'none', '{first_name}, happy to do a short call with your partner too if that helps the decision. Reply with a time.'),
      s(4, 'trigger', 10 * D, 'none', 'Closing the loop, {first_name}. If you\'d like to go ahead, reply "in" and we\'ll send next steps.'),
    ],
  },
  {
    id: 'lost', enabled: false, next: 3,
    steps: [
      s(1, 'trigger', 30 * D, 'book', 'Hi {first_name}, Josh\'s team here. Has anything changed with acquisitions on your side? If the timing\'s better, grab a time: {link}', ['booked']),
      s(2, 'trigger', 90 * D, 'book', '{first_name}, if a competitor or a business you like comes up for sale, reply here and we\'ll tell you honestly if the deal works.', ['booked']),
    ],
  },
  {
    id: 'won', enabled: true, next: 3,
    steps: [
      s(1, 'trigger', 5, 'none', 'Welcome aboard, {first_name}. Really glad to have you. Your onboarding details are in your inbox. Save this number: it\'s the quickest way to reach the team.'),
      s(2, 'trigger', 2 * D, 'none', '{first_name}, how\'s the first homework going (P&L, debts, target names)? Reply with anything that\'s stuck.'),
    ],
  },
  {
    id: 'webinar', enabled: true, next: 8,
    steps: [
      s(1, 'trigger', 0, 'webinar_room', 'You\'re in, {first_name}. The masterclass is on {webinar_time}. Your link: {link}'),
      s(2, 'webinar', -24 * H, 'webinar_room', 'Tomorrow, {first_name}: the masterclass on buying a competitor with the bank\'s money and the seller\'s, not yours. {webinar_time}. Link: {link}'),
      s(3, 'webinar', -60, 'webinar_room', 'Starting in an hour, {first_name}. Grab a coffee and join here: {link}'),
      s(4, 'webinar', -5, 'webinar_room', 'We\'re starting in 5 minutes, {first_name}: {link}'),
      s(5, 'webinar', 5, 'webinar_room', '{first_name}, we\'ve just started and your seat\'s still there: {link}', ['attended']),
      s(6, 'webinar', 80, 'webinar_replay', 'You missed it, {first_name}. The replay is up for 48 hours: {link}', ['attended', 'applied']),
      s(7, 'webinar', 80, 'apply', 'Thanks for coming, {first_name}. If it made sense for your business, the next step is a 2-minute application: {link}', ['missed', 'applied', 'booked']),
    ],
  },
  {
    // The First Deal Challenge: an hour before and at the start of each day; the link opens their day page (Join on Zoom is there).
    id: 'challenge', enabled: true, next: 11,
    steps: [1, 2, 3, 4, 5].flatMap((d, i) => [
      s(i * 2 + 1, `day${d}` as SmsStepDef['anchor'], -60, 'challenge_today', `{first_name}, Day ${d} of the First Deal Challenge starts in an hour. Your page with the Zoom link: {link}`),
      s(i * 2 + 2, `day${d}` as SmsStepDef['anchor'], 0, 'challenge_today', `We're live on Day ${d}, {first_name}. Join from your page: {link}`),
    ]),
  },
];

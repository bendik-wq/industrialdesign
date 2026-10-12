import { describe, expect, it } from 'vitest';
import type { Runtime } from '../src/app';
import { bookingFields, type CalEvent, type CalInvitee } from '../src/integrations/calendly';

const rt = { reps: [{ id: 'josh', email: 'Josh@JoshLi.au' }, { id: 'sam', email: null }], settings: {} } as unknown as Runtime;
const ev: CalEvent = {
  uri: 'https://api.calendly.com/scheduled_events/abc', name: 'M&A Private Advisory', status: 'active',
  start_time: '2026-10-20T23:00:00.000000Z', end_time: '2026-10-20T23:30:00.000000Z',
  location: { type: 'google_conference', join_url: 'https://meet.google.com/abc-defg-hij' },
  event_memberships: [{ user_email: 'josh@joshli.au', user_name: 'Josh Li' }],
};
const inv: CalInvitee = {
  uri: 'https://api.calendly.com/scheduled_events/abc/invitees/x', email: 'dana@acme.com', name: 'Dana Smith', status: 'active',
  cancel_url: 'https://calendly.com/cancellations/x', reschedule_url: 'https://calendly.com/reschedulings/x',
  questions_and_answers: [{ question: 'What would you like to cover?', answer: 'Buying two competitors' }],
};

describe('Calendly', () => {
  it('maps the event to the lead: exact time, meeting link, self-serve links, answers, and the host as closer', () => {
    const { callAt, fields } = bookingFields(rt, ev, inv);
    expect(new Date(callAt!).toISOString()).toBe('2026-10-20T23:00:00.000Z');
    expect(fields).toMatchObject({
      booking_join_url: 'https://meet.google.com/abc-defg-hij',
      booking_reschedule_url: 'https://calendly.com/reschedulings/x',
      booking_cancel_url: 'https://calendly.com/cancellations/x',
      booking_host_email: 'josh@joshli.au',
      closer_id: 'josh',
    });
    expect(JSON.parse(String(fields.booking_answers))).toEqual([{ q: 'What would you like to cover?', a: 'Buying two competitors' }]);
  });

  it('leaves the closer alone when the host isn’t on the team', () => {
    const { fields } = bookingFields(rt, { ...ev, event_memberships: [{ user_email: 'someone@else.com' }] }, inv);
    expect('closer_id' in fields).toBe(false);
  });
});

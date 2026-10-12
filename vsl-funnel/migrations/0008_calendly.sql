-- Calendly details pulled via the API: meeting link, self-serve links, host, and the invitee's answers.
ALTER TABLE leads ADD COLUMN booking_join_url TEXT;
ALTER TABLE leads ADD COLUMN booking_reschedule_url TEXT;
ALTER TABLE leads ADD COLUMN booking_cancel_url TEXT;
ALTER TABLE leads ADD COLUMN booking_host_email TEXT;
ALTER TABLE leads ADD COLUMN booking_answers TEXT;   -- JSON [{q, a}]
ALTER TABLE leads ADD COLUMN booking_source TEXT;    -- funnel | calendly-direct (booked straight from the Calendly link)
CREATE INDEX idx_leads_booking_ref ON leads(booking_ref);

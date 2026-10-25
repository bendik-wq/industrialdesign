-- Webinar sign-ups now ask for revenue (to qualify the room) and record which headline they saw.
ALTER TABLE webinar_registrations ADD COLUMN revenue_band TEXT;
ALTER TABLE webinar_registrations ADD COLUMN headline TEXT;

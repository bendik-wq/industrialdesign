-- How each booking was made, so Funnel HQ can compare one-tap booking with the Calendly embed. One row per booking
-- (keyed by the Calendly event URI, or the provider's booking id); the lead's current one is the row for leads.booking_ref.
-- (Its own table: leads is at D1's 100-column limit.)
--   one_tap  the open times on /book (POST /api/book/confirm, booked through Calendly's Scheduling API)
--   embed    the Calendly calendar: the embed on /book, or a Calendly link, as before
--   phone    booked by phone with Sam (the ElevenLabs booking tools)
CREATE TABLE IF NOT EXISTS booking_methods (
  ref         TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL,
  method      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_booking_methods_lead ON booking_methods(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_booking_methods_method ON booking_methods(method, created_at);

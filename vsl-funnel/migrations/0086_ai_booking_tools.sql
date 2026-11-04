-- Calendar actions Sam (the ElevenLabs phone agents) takes during a call through the booking tools
-- (src/integrations/calendly-tools.ts): availability look-ups, bookings, reschedules and the fallbacks.
-- Additive only. Shown on the lead in Funnel HQ (AI calls section).
CREATE TABLE IF NOT EXISTS ai_booking_actions (
  id               TEXT PRIMARY KEY,
  lead_id          TEXT NOT NULL,
  conversation_id  TEXT,                    -- the ElevenLabs conversation the tool call came from
  action           TEXT NOT NULL,           -- availability | book | reschedule | cancel_old
  result           TEXT NOT NULL,           -- offered | none_open | booked | rescheduled | slot_taken | cancelled | cancel_failed | error | fallback_link | not_available | rate_limited | invalid
  slot_at          INTEGER,                 -- the start the person picked (book / reschedule)
  event_uri        TEXT,                    -- the Calendly event booked (or cancelled, for cancel_old)
  detail           TEXT,                    -- JSON: times offered, the old event, the error
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_booking_actions_lead ON ai_booking_actions(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_booking_actions_conv ON ai_booking_actions(conversation_id);

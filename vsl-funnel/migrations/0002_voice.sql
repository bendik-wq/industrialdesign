-- Inbound AI voice calls (Vapi). One row per call, written by /hooks/voice.
CREATE TABLE voice_calls (
  id              TEXT PRIMARY KEY,      -- Vapi call id
  lead_id         TEXT,
  kind            TEXT NOT NULL,         -- phone | web
  from_number     TEXT,
  status          TEXT NOT NULL,         -- ringing | in-progress | ended
  started_at      INTEGER,
  ended_at        INTEGER,
  duration_s      REAL,
  ended_reason    TEXT,
  cost            REAL,
  summary         TEXT,
  transcript      TEXT,
  recording_url   TEXT,
  structured      TEXT,                  -- JSON extracted by the assistant's analysis plan
  success         TEXT,
  disclosure      TEXT,                  -- disclosure version read at the start of the call
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_voice_lead ON voice_calls(lead_id);
CREATE INDEX idx_voice_created ON voice_calls(created_at);

-- Set when someone asks (on a call or anywhere else) never to be phoned again.
ALTER TABLE leads ADD COLUMN do_not_call_at INTEGER;

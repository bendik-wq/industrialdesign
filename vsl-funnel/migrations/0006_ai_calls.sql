-- Outbound AI calls (ElevenLabs): appointment confirmations and speed-to-lead,
-- only to applicants who ticked the call consent box.
ALTER TABLE leads ADD COLUMN call_consent_at INTEGER;
ALTER TABLE leads ADD COLUMN call_consent_text TEXT;   -- consent wording version they agreed to
ALTER TABLE leads ADD COLUMN timezone TEXT;            -- IANA zone from the visitor's connection, for calling hours

CREATE TABLE outbound_calls (
  id              TEXT PRIMARY KEY,
  lead_id         TEXT NOT NULL,
  kind            TEXT NOT NULL,              -- confirm | speed_to_lead | test
  status          TEXT NOT NULL,              -- queued | dialing | done | no_answer | failed | skipped | cancelled
  run_at          INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  conversation_id TEXT,
  call_sid        TEXT,
  outcome         TEXT,                       -- JSON: what the call established
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_outbound_due ON outbound_calls(status, run_at);
CREATE INDEX idx_outbound_lead ON outbound_calls(lead_id);
CREATE UNIQUE INDEX idx_outbound_conv ON outbound_calls(conversation_id);

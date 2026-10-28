-- "Your Acquisition Blueprint": the personalised one-page plan shown at the pitch (src/webinar/blueprint.ts).
-- One row per registration, rebuilt when the inputs behind it change (inputs_hash).
CREATE TABLE webinar_blueprints (
  reg_id      TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,             -- version : mode (ai|rules) : hash of the inputs
  data        TEXT NOT NULL,             -- the blueprint (JSON)
  source      TEXT NOT NULL,             -- rules | ai (prose polished by Claude)
  error       TEXT,                      -- why the AI polish was dropped, if it was
  opened_at   INTEGER,                   -- first opened from the room
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_wb_lead ON webinar_blueprints(lead_id);
CREATE INDEX idx_wb_created ON webinar_blueprints(created_at);

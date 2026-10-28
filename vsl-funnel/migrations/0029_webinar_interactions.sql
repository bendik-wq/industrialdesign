-- What people do inside the masterclass room: poll answers, questions (with the assistant's answer),
-- calculator runs, worksheet unlocks and offer clicks. One row per action.
CREATE TABLE webinar_interactions (
  id         TEXT PRIMARY KEY,
  reg_id     TEXT NOT NULL,
  lead_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- poll | question | calc | bonus | offer | agreement
  key        TEXT,                      -- poll id, offer choice…
  value      TEXT,                      -- answer / question text / calculator inputs (JSON)
  answer     TEXT,                      -- assistant's reply to a question
  at_sec     INTEGER,                   -- position in the masterclass
  replay     INTEGER NOT NULL DEFAULT 0,
  handled    INTEGER NOT NULL DEFAULT 0, -- team has dealt with it (questions)
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_wi_reg ON webinar_interactions(reg_id);
CREATE INDEX idx_wi_kind ON webinar_interactions(kind, created_at);
CREATE UNIQUE INDEX idx_wi_poll ON webinar_interactions(reg_id, kind, key) WHERE kind IN ('poll', 'bonus');

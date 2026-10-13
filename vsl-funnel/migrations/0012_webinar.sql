-- Webinar: scheduled sessions (recurring + one-off), registrations with attendance, lead-level summary.
CREATE TABLE webinar_sessions (
  id          TEXT PRIMARY KEY,
  starts_at   INTEGER NOT NULL,
  title       TEXT,
  mode        TEXT NOT NULL DEFAULT 'evergreen',  -- evergreen (our room plays the recording in sync) | live (join_url, e.g. Zoom)
  join_url    TEXT,
  video_src   TEXT,
  status      TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | cancelled
  auto        INTEGER NOT NULL DEFAULT 0,        -- created from the weekly schedule
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_webinar_sessions_start ON webinar_sessions(starts_at);

CREATE TABLE webinar_registrations (
  id             TEXT PRIMARY KEY,
  token          TEXT NOT NULL UNIQUE,            -- personal room link
  session_id     TEXT NOT NULL,
  lead_id        TEXT NOT NULL,
  seq            INTEGER NOT NULL DEFAULT 0,      -- nth registration for this lead (email step offset)
  new_lead       INTEGER NOT NULL DEFAULT 0,      -- registration created the lead (only then may the token link a browser)
  created_at     INTEGER NOT NULL,
  joined_at      INTEGER,
  last_seen_at   INTEGER,
  watch_seconds  INTEGER NOT NULL DEFAULT 0,
  max_position   INTEGER NOT NULL DEFAULT 0,
  cta_at         INTEGER,
  replay_at      INTEGER,
  replay_seconds INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_webinar_reg_session ON webinar_registrations(session_id);
CREATE INDEX idx_webinar_reg_lead ON webinar_registrations(lead_id);

ALTER TABLE leads ADD COLUMN webinar_at INTEGER;            -- start of the session they're booked into (email anchor)
ALTER TABLE leads ADD COLUMN webinar_registered_at INTEGER;
ALTER TABLE leads ADD COLUMN webinar_attended_at INTEGER;   -- last time they were in a session room
ALTER TABLE leads ADD COLUMN webinar_watch_pct REAL;
ALTER TABLE leads ADD COLUMN webinar_cta_at INTEGER;
ALTER TABLE leads ADD COLUMN webinar_replay_at INTEGER;
ALTER TABLE leads ADD COLUMN webinar_token TEXT;
